'use strict';

const { mergeConfig, validateConfigSchema } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const EventEmitter = require('events');

const SCHEDULING_STRATEGIES = {
  ROUND_ROBIN: 'round-robin',
  LEAST_LOADED: 'least-loaded',
  RESOURCE_MATCH: 'resource-match',
  LATENCY_AWARE: 'latency-aware',
};

const TASK_STATES = {
  PENDING: 'pending',
  DISPATCHED: 'dispatched',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
};

const RESOURCE_TYPES = {
  CPU: 'cpu',
  GPU: 'gpu',
  MEMORY: 'memory',
  DISK: 'disk',
  NETWORK: 'network',
};

const DEFAULT_OPTIONS = {
  maxWorkers: 20,
  maxPendingTasks: 500,
  maxCompletedTasks: 200,
  taskTimeoutMs: 300000,
  schedulingStrategy: SCHEDULING_STRATEGIES.LEAST_LOADED,
  resourceCheckIntervalMs: 10000,
  retryAttempts: 2,
  retryDelayMs: 1000,
};

/** @constant {Object} OPTIONS_SCHEMA - 配置选项Schema定义 */
const OPTIONS_SCHEMA = {
  maxWorkers: { type: 'number', min: 1, max: 1000 },
  maxPendingTasks: { type: 'number', min: 1, max: 10000 },
  maxCompletedTasks: { type: 'number', min: 1, max: 10000 },
  taskTimeoutMs: { type: 'number', min: 1000, max: 3600000 },
  schedulingStrategy: { type: 'string', enum: Object.values(SCHEDULING_STRATEGIES) },
  resourceCheckIntervalMs: { type: 'number', min: 1000, max: 300000 },
  retryAttempts: { type: 'number', min: 0, max: 10 },
  retryDelayMs: { type: 'number', min: 0, max: 60000 },
};

class DistributedTaskScheduler extends EventEmitter {
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    const validation = validateConfigSchema(this._options, OPTIONS_SCHEMA, 'DistributedTaskScheduler');
    if (!validation.valid) {
      debug('DistributedTaskScheduler', 'config-validation', validation.errors.join('; '));
    }
    if (validation.warnings.length > 0) {
      debug('DistributedTaskScheduler', 'config-warnings', validation.warnings.join('; '));
    }
    this._options = validation.config;
    this._workers = new BoundedMap(this._options.maxWorkers);
    this._pendingTasks = new BoundedArray(this._options.maxPendingTasks);
    this._runningTasks = new BoundedMap(this._options.maxWorkers);
    this._completedTasks = new BoundedArray(this._options.maxCompletedTasks);
    this._roundRobinIndex = 0;
    this._transport = null;
    this._resourceCheckTimer = null;
    this._stats = {
      tasksSubmitted: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksRetried: 0,
      tasksTimedOut: 0,
      avgExecutionTimeMs: 0,
      byStrategy: {},
      byWorker: {},
    };
  }

  /**
   * 挂载传输层实例，监听任务结果、资源报告和对等节点事件。
   * @param {Object} transport - 传输层实例，需实现 on/send/removeListener 方法
   * @returns {boolean} 挂载是否成功
   */
  attachTransport(transport) {
    this._transport = transport;
    if (transport) {
      this._onTaskResult = (event) => {
        this._handleTaskResult(event);
      };
      this._onResourceReport = (event) => {
        this._handleResourceReport(event);
      };
      this._onPeerConnected = (event) => {
        this._requestResourceReport(event.agentId);
      };
      this._onPeerDisconnected = (event) => {
        this._handleWorkerLost(event.agentId);
      };
      transport.on('message:task-result', this._onTaskResult);
      transport.on('message:resource-report', this._onResourceReport);
      transport.on('peer-connected', this._onPeerConnected);
      transport.on('peer-disconnected', this._onPeerDisconnected);
    }
    return true;
  }

  /**
   * 注册工作节点。
   * @param {string} agentId - 工作节点ID
   * @param {Object} [capabilities] - 节点能力描述
   * @param {number} [capabilities.maxConcurrentTasks] - 最大并发任务数
   * @returns {{success: boolean}} 注册结果
   */
  registerWorker(agentId, capabilities) {
    const worker = {
      agentId,
      capabilities: capabilities ?? {},
      resources: {
        cpu: { total: 0, used: 0, available: 0 },
        gpu: { total: 0, used: 0, available: 0 },
        memory: { total: 0, used: 0, available: 0 },
        disk: { total: 0, used: 0, available: 0 },
        network: { latencyMs: 0, bandwidth: 0 },
      },
      registeredAt: Date.now(),
      lastResourceReport: null,
      activeTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      state: 'available',
    };
    this._workers.set(agentId, worker);
    this.emit('worker-registered', { agentId, capabilities });
    return { success: true };
  }

  /**
   * 注销工作节点，并将该节点上运行中的任务重新入队或标记失败。
   * @param {string} agentId - 工作节点ID
   * @returns {{success: boolean, error?: string}} 注销结果
   */
  deregisterWorker(agentId) {
    const worker = this._workers.get(agentId);
    if (!worker) return { success: false, error: 'Worker not found' };
    this._workers.delete(agentId);
    this._handleWorkerLost(agentId);
    this.emit('worker-deregistered', { agentId });
    return { success: true };
  }

  /**
   * 提交任务到调度器。任务将根据调度策略分配给可用工作节点。
   * @param {Object} task - 任务对象
   * @param {string} task.type - 任务类型（必填）
   * @param {Object} [task.payload] - 任务负载数据
   * @param {Object} [task.requirements] - 资源需求（如 gpu、cpu、memory）
   * @param {number} [task.priority] - 优先级，数值越高越优先
   * @param {number} [task.timeoutMs] - 任务超时时间（毫秒）
   * @param {number} [task.retryAttempts] - 失败重试次数
   * @returns {{success: boolean, taskId?: string, error?: string}} 提交结果
   */
  submitTask(task) {
    if (!task || !task.type) {
      return { success: false, error: 'Task must have a type' };
    }
    const taskId = 'task-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const scheduledTask = {
      id: taskId,
      type: task.type,
      payload: task.payload ?? {},
      requirements: task.requirements ?? {},
      priority: task.priority ?? 0,
      timeoutMs: task.timeoutMs ?? this._options.taskTimeoutMs,
      retryAttempts: task.retryAttempts ?? this._options.retryAttempts,
      retriesLeft: task.retryAttempts ?? this._options.retryAttempts,
      state: TASK_STATES.PENDING,
      assignedWorker: null,
      result: null,
      error: null,
      submittedAt: Date.now(),
      dispatchedAt: null,
      completedAt: null,
    };
    this._pendingTasks.push(scheduledTask);
    this._stats.tasksSubmitted++;
    this._stats.byStrategy[this._options.schedulingStrategy] = (this._stats.byStrategy[this._options.schedulingStrategy] ?? 0) + 1;
    this._scheduleNext();
    this.emit('task-submitted', { taskId, type: task.type });
    return { success: true, taskId };
  }

  _scheduleNext() {
    if (this._pendingTasks.length === 0) return;
    const availableWorkers = this._getAvailableWorkers();
    if (availableWorkers.length === 0) return;
    const task = this._pendingTasks.get(0);
    if (!task) return;
    const worker = this._selectWorker(task, availableWorkers);
    if (!worker) return;
    this._pendingTasks = this._rebuildPendingWithout(0);
    this._dispatchTask(task, worker);
  }

  _rebuildPendingWithout(skipIndex) {
    const oldPending = this._pendingTasks;
    const newPending = new BoundedArray(this._options.maxPendingTasks);
    for (let i = 0; i < oldPending.length; i++) {
      if (i !== skipIndex) {
        newPending.push(oldPending.get(i));
      }
    }
    try { oldPending.shutdown(); } catch (_e) { debug('DistributedTaskScheduler', '_rebuildPendingWithout', _e && _e.message ? _e.message : String(_e)); }
    return newPending;
  }

  _prependPending(task) {
    const oldPending = this._pendingTasks;
    const newPending = new BoundedArray(this._options.maxPendingTasks);
    newPending.push(task);
    for (let i = 0; i < oldPending.length; i++) {
      newPending.push(oldPending.get(i));
    }
    try { oldPending.shutdown(); } catch (_e) { debug('DistributedTaskScheduler', '_prependPending', _e && _e.message ? _e.message : String(_e)); }
    return newPending;
  }

  _getAvailableWorkers() {
    const available = [];
    for (const [, worker] of this._workers) {
      if (worker.state === 'available' && worker.activeTasks < (worker.capabilities.maxConcurrentTasks ?? 5)) {
        available.push(worker);
      }
    }
    return available;
  }

  _selectWorker(task, workers) {
    const strategy = this._options.schedulingStrategy;
    switch (strategy) {
      case SCHEDULING_STRATEGIES.ROUND_ROBIN:
        return this._selectRoundRobin(workers);
      case SCHEDULING_STRATEGIES.LEAST_LOADED:
        return this._selectLeastLoaded(workers);
      case SCHEDULING_STRATEGIES.RESOURCE_MATCH:
        return this._selectResourceMatch(task, workers);
      case SCHEDULING_STRATEGIES.LATENCY_AWARE:
        return this._selectLatencyAware(workers);
      default:
        return workers[0] ?? null;
    }
  }

  _selectRoundRobin(workers) {
    if (workers.length === 0) return null;
    const worker = workers[this._roundRobinIndex % workers.length];
    this._roundRobinIndex++;
    return worker;
  }

  _selectLeastLoaded(workers) {
    return workers.reduce((best, w) => {
      if (!best) return w;
      return w.activeTasks < best.activeTasks ? w : best;
    }, null);
  }

  _selectResourceMatch(task, workers) {
    const reqs = task.requirements;
    if (!reqs || Object.keys(reqs).length === 0) return this._selectLeastLoaded(workers);
    const scored = workers.map(w => {
      let score = 0;
      if (reqs.gpu && w.resources.gpu.available >= reqs.gpu) score += 10;
      if (reqs.cpu && w.resources.cpu.available >= reqs.cpu) score += 5;
      if (reqs.memory && w.resources.memory.available >= reqs.memory) score += 3;
      score -= w.activeTasks;
      return { worker: w, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.worker ?? null;
  }

  _selectLatencyAware(workers) {
    return workers.reduce((best, w) => {
      if (!best) return w;
      return w.resources.network.latencyMs < best.resources.network.latencyMs ? w : best;
    }, null);
  }

  _dispatchTask(task, worker) {
    task.state = TASK_STATES.DISPATCHED;
    task.assignedWorker = worker.agentId;
    task.dispatchedAt = Date.now();
    worker.activeTasks++;
    this._runningTasks.set(task.id, task);
    this._stats.byWorker[worker.agentId] = (this._stats.byWorker[worker.agentId] ?? 0) + 1;
    if (this._transport) {
      this._transport.send(worker.agentId, 'task-assign', {
        taskId: task.id,
        type: task.type,
        payload: task.payload,
        timeoutMs: task.timeoutMs,
      });
    }
    this._setTaskTimeout(task);
    this.emit('task-dispatched', { taskId: task.id, workerId: worker.agentId });
  }

  _setTaskTimeout(task) {
    task._timeoutTimer = setTimeout(() => {
      if (this._shutDown) return;
      if (this._runningTasks.has(task.id)) {
        this._handleTaskTimeout(task);
      }
    }, task.timeoutMs);
  }

  _handleTaskResult(event) {
    const { from, message } = event;
    const payload = message.payload ?? {};
    const taskId = payload.taskId;
    const task = this._runningTasks.get(taskId);
    if (!task) return;
    if (task._timeoutTimer) clearTimeout(task._timeoutTimer);
    const worker = this._workers.get(from);
    if (worker) worker.activeTasks = Math.max(0, worker.activeTasks - 1);
    if (payload.success) {
      task.state = TASK_STATES.COMPLETED;
      task.result = payload.result;
      task.completedAt = Date.now();
      this._stats.tasksCompleted++;
      if (worker) worker.completedTasks++;
      const execTime = task.completedAt - (task.dispatchedAt ?? task.submittedAt);
      this._updateAvgExecutionTime(execTime);
      this.emit('task-completed', { taskId, workerId: from, executionTimeMs: execTime });
    } else {
      task.error = payload.error ?? 'Unknown error';
      if (task.retriesLeft > 0) {
        task.retriesLeft--;
        task.state = TASK_STATES.PENDING;
        task.assignedWorker = null;
        task.dispatchedAt = null;
        this._stats.tasksRetried++;
        this._pendingTasks = this._prependPending(task);
        this.emit('task-retrying', { taskId, retriesLeft: task.retriesLeft });
      } else {
        task.state = TASK_STATES.FAILED;
        task.completedAt = Date.now();
        this._stats.tasksFailed++;
        if (worker) worker.failedTasks++;
        this.emit('task-failed', { taskId, workerId: from, error: task.error });
      }
    }
    this._runningTasks.delete(taskId);
    this._completedTasks.push(task);
    this._scheduleNext();
  }

  _handleTaskTimeout(task) {
    task.state = TASK_STATES.TIMEOUT;
    task.completedAt = Date.now();
    task.error = 'Task timed out';
    this._stats.tasksTimedOut++;
    const worker = this._workers.get(task.assignedWorker);
    if (worker) worker.activeTasks = Math.max(0, worker.activeTasks - 1);
    this._runningTasks.delete(task.id);
    this._completedTasks.push(task);
    this.emit('task-timeout', { taskId: task.id, workerId: task.assignedWorker });
    this._scheduleNext();
  }

  _handleWorkerLost(agentId) {
    for (const [taskId, task] of this._runningTasks) {
      if (task.assignedWorker === agentId) {
        if (task._timeoutTimer) clearTimeout(task._timeoutTimer);
        if (task.retriesLeft > 0) {
          task.retriesLeft--;
          task.state = TASK_STATES.PENDING;
          task.assignedWorker = null;
          task.dispatchedAt = null;
          this._pendingTasks = this._prependPending(task);
        } else {
          task.state = TASK_STATES.FAILED;
          task.completedAt = Date.now();
          task.error = 'Worker lost';
          this._stats.tasksFailed++;
          this._completedTasks.push(task);
        }
        this._runningTasks.delete(taskId);
      }
    }
    this._scheduleNext();
  }

  _handleResourceReport(event) {
    const { from, message } = event;
    const worker = this._workers.get(from);
    if (!worker) return;
    const resources = message.payload ?? {};
    if (resources.cpu) worker.resources.cpu = Object.assign(worker.resources.cpu, resources.cpu);
    if (resources.gpu) worker.resources.gpu = Object.assign(worker.resources.gpu, resources.gpu);
    if (resources.memory) worker.resources.memory = Object.assign(worker.resources.memory, resources.memory);
    if (resources.disk) worker.resources.disk = Object.assign(worker.resources.disk, resources.disk);
    if (resources.network) worker.resources.network = Object.assign(worker.resources.network, resources.network);
    worker.lastResourceReport = Date.now();
  }

  _requestResourceReport(agentId) {
    if (this._transport) {
      this._transport.send(agentId, 'resource-report', { requestReply: true });
    }
  }

  _updateAvgExecutionTime(execTimeMs) {
    const completed = this._stats.tasksCompleted;
    this._stats.avgExecutionTimeMs = completed === 1
      ? execTimeMs
      : Math.round((this._stats.avgExecutionTimeMs * (completed - 1) + execTimeMs) / completed);
  }

  /**
   * 获取指定工作节点的详细信息。
   * @param {string} agentId - 工作节点ID
   * @returns {Object|null} 节点信息对象，包含 agentId、capabilities、resources、activeTasks 等；不存在返回 null
   */
  getWorkerInfo(agentId) {
    const worker = this._workers.get(agentId);
    if (!worker) return null;
    return {
      agentId: worker.agentId,
      capabilities: Object.assign({}, worker.capabilities),
      resources: JSON.parse(JSON.stringify(worker.resources)),
      activeTasks: worker.activeTasks,
      completedTasks: worker.completedTasks,
      failedTasks: worker.failedTasks,
      state: worker.state,
    };
  }

  /**
   * 获取指定任务的信息。
   * @param {string} taskId - 任务ID
   * @returns {Object|null} 任务信息对象，包含 id、type、state、result 等；不存在返回 null
   */
  getTaskInfo(taskId) {
    const running = this._runningTasks.get(taskId);
    if (running) return { ...running, payload: { ...running.payload }, requirements: { ...running.requirements } };
    for (const task of this._completedTasks) {
      if (task.id === taskId) return { ...task, payload: { ...task.payload }, requirements: { ...task.requirements } };
    }
    return null;
  }

  /**
   * 获取调度器运行统计信息。
   * @returns {{tasksSubmitted: number, tasksCompleted: number, tasksFailed: number, tasksRetried: number, tasksTimedOut: number, avgExecutionTimeMs: number, pendingTasks: number, runningTasks: number, activeWorkers: number, byStrategy: Object, byWorker: Object}} 统计信息对象
   */
  getStats() {
    return {
      tasksSubmitted: this._stats.tasksSubmitted,
      tasksCompleted: this._stats.tasksCompleted,
      tasksFailed: this._stats.tasksFailed,
      tasksRetried: this._stats.tasksRetried,
      tasksTimedOut: this._stats.tasksTimedOut,
      avgExecutionTimeMs: this._stats.avgExecutionTimeMs,
      pendingTasks: this._pendingTasks.length,
      runningTasks: this._runningTasks.size,
      activeWorkers: this._workers.size,
      byStrategy: Object.assign({}, this._stats.byStrategy),
      byWorker: Object.assign({}, this._stats.byWorker),
    };
  }

  _onShutdown() {
    if (this._transport) {
      this._transport.removeListener('message:task-result', this._onTaskResult);
      this._transport.removeListener('message:resource-report', this._onResourceReport);
      this._transport.removeListener('peer-connected', this._onPeerConnected);
      this._transport.removeListener('peer-disconnected', this._onPeerDisconnected);
      this._transport = null;
    }
    if (this._resourceCheckTimer) {
      clearInterval(this._resourceCheckTimer);
      this._resourceCheckTimer = null;
    }
    for (const [, task] of this._runningTasks) {
      if (task._timeoutTimer) clearTimeout(task._timeoutTimer);
    }
    this._workers.shutdown();
    this._pendingTasks.shutdown();
    this._runningTasks.shutdown();
    this._completedTasks.shutdown();
    this.removeAllListeners();
  }
}

module.exports = withShutdown(DistributedTaskScheduler);
module.exports.SCHEDULING_STRATEGIES = SCHEDULING_STRATEGIES;
module.exports.TASK_STATES = TASK_STATES;
module.exports.RESOURCE_TYPES = RESOURCE_TYPES;
