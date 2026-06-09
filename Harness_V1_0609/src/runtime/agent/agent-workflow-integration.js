'use strict';

const { EventEmitter } = require('events');
const { AgentError } = require('../../errors');
const { validateAgentId, validateProjectRoot, DEFAULT_PIPELINE_TIMEOUT_MS } = require('../../utils/constants');
const { shortId } = require('../../utils/unique-id');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { errorMessage, emitError, safeDateGetTime } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

const TRIGGER_TYPES = {
  MANUAL: 'manual',
  EVENT: 'event',
  SCHEDULE: 'schedule',
  DEPENDENCY: 'dependency',
  WEBHOOK: 'webhook',
};

const TASK_STATES = {
  PENDING: 'pending',
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  RETRYING: 'retrying',
};

const FEEDBACK_TYPES = {
  SUCCESS: 'success',
  PARTIAL: 'partial',
  FAILURE: 'failure',
  TIMEOUT: 'timeout',
};

const MAX_SUBSCRIPTIONS_PER_AGENT = 100;
const MAX_SCHEDULES = 500;
const MAX_ADAPTERS = 200;

const FEEDBACK_TYPES_SET = new Set(Object.values(FEEDBACK_TYPES));

/**
 * @module runtime/agent/agent-workflow-integration
 * @classdesc Agent工作流集成（AgentWorkflowIntegration）。阶段绑定、任务分发、结果收集，
 * 支持多种触发类型（手动/事件/定时/依赖/Webhook）、优先级队列处理和反馈驱动重试。
 *
 * AgentWorkflowIntegration — Bridges agents with the workflow execution system
 * Registers agent adapters for task handling, event subscription, and scheduled execution.
 * Manages task lifecycle (submit→queue→execute→feedback) with multiple trigger types
 * (manual, event, schedule, dependency, webhook), priority-based queue processing, and feedback-driven retry.
 * @extends EventEmitter
 * @emits task-submitted | task-started | task-completed | task-failed | adapter-registered | feedback-submitted
 */
class AgentWorkflowIntegration extends EventEmitter {
  /**
   * 创建Agent工作流集成实例，初始化适配器注册表、任务队列和事件订阅管理
   * @param {string} projectRoot - 项目根目录路径
   * @param {Object} [options={}] - 可选配置项
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'AgentWorkflowIntegration', AgentError);
    this.root = projectRoot;
    this.options = options ?? {};
    this._adapters = new Map();
    this._tasks = new Map();
    this._maxTasks = 5000;
    this._eventSubscriptions = new Map();
    this._schedules = new Map();
    this._feedbackHistory = [];
    this._maxFeedbackHistory = 2000;
    this._taskQueue = [];
    this._maxQueueSize = 1000;
    this._activeTaskTimers = new Set();
  }

  /**
   * 为指定Agent注册适配器，用于任务处理、事件响应和定时调度
   * @param {string} agentId - Agent唯一标识符
   * @param {Object} adapter - 适配器对象，包含任务处理、事件响应和定时调度的回调
   * @param {Function} [adapter.onTask] - 任务处理回调
   * @param {Function} [adapter.onEvent] - 事件响应回调
   * @param {Function} [adapter.onSchedule] - 定时调度回调
   * @param {Array} [adapter.capabilities=[]] - Agent能力列表
   * @param {number} [adapter.priority=0] - 默认优先级
   * @param {Object} [adapter.metadata={}] - 附加元数据
   * @returns {Object} 标准化后的适配器对象
   * @throws {AgentError} agentId无效时抛出INVALID_AGENT_ID，adapter无效时抛出INVALID_ADAPTER
   * @emits adapter-registered
   */
  registerAdapter(agentId, adapter) {
    this.guardShutdown();
    const idValidation = validateAgentId(agentId);
    if (!idValidation.valid) {
      throw new AgentError('INVALID_AGENT_ID', idValidation.reason);
    }
    if (!adapter || typeof adapter !== 'object') {
      throw new AgentError('INVALID_ADAPTER', 'adapter must be an object');
    }

    const normalizedAdapter = {
      agentId,
      onTask: adapter.onTask ?? null,
      onEvent: adapter.onEvent ?? null,
      onSchedule: adapter.onSchedule ?? null,
      capabilities: adapter.capabilities ?? [],
      priority: adapter.priority ?? 0,
      metadata: adapter.metadata ?? {},
      registeredAt: new Date().toISOString(),
    };

    this._adapters.set(agentId, normalizedAdapter);
    if (this._adapters.size > MAX_ADAPTERS) {
      const oldestKey = this._adapters.keys().next().value;
      if (oldestKey) this._adapters.delete(oldestKey);
    }
    this.emit('adapter-registered', { agentId, capabilities: normalizedAdapter.capabilities });
    return normalizedAdapter;
  }

  /**
   * 注销指定Agent的适配器及其事件订阅
   * @param {string} agentId - Agent唯一标识符
   * @returns {boolean} 适配器是否存在并被移除
   * @emits adapter-unregistered
   */
  unregisterAdapter(agentId) {
    const existed = this._adapters.has(agentId);
    this._adapters.delete(agentId);

    const subs = this._eventSubscriptions.get(agentId);
    if (subs) {
      this._eventSubscriptions.delete(agentId);
    }

    if (existed) {
      this.emit('adapter-unregistered', { agentId });
    }
    return existed;
  }

  /**
   * 获取指定Agent的适配器对象
   * @param {string} agentId - Agent唯一标识符
   * @returns {Object|null} 适配器对象，不存在时返回null
   */
  getAdapter(_agentId) {
    return this._adapters.get(_agentId) ?? null;
  }

  /**
   * 提交任务到工作流系统，根据触发类型决定立即执行或入队等待
   * @param {Object} task - 任务描述对象
   * @param {string} task.agentId - 目标Agent标识符
   * @param {string} [task.type='default'] - 任务类型
   * @param {Object} [task.payload={}] - 任务负载数据
   * @param {number} [task.priority] - 任务优先级，数值越大优先级越高
   * @param {string} [task.trigger='manual'] - 触发类型（manual/event/schedule/dependency/webhook）
   * @param {number} [task.maxRetries=3] - 最大重试次数
   * @param {number} [task.timeout] - 超时时间（毫秒）
   * @param {string} [task.id] - 自定义任务ID
   * @param {Object} [task.metadata={}] - 附加元数据
   * @returns {Object} 创建的任务记录对象
   * @throws {AgentError} 任务无效时抛出INVALID_TASK，适配器不存在时抛出ADAPTER_NOT_FOUND
   * @emits task-submitted
   */
  submitTask(task) {
    this.guardShutdown();
    this._validateTask(task);

    const adapter = this._adapters.get(task.agentId);
    if (!adapter) throw new AgentError('ADAPTER_NOT_FOUND', `No adapter registered for agent ${task.agentId}`);

    const taskId = task.id ?? ('task-' + shortId('', 20));
    const taskRecord = this._createTaskRecord(taskId, task, adapter);

    this._tasks.set(taskId, taskRecord);
    this._evictOldTasks();

    if (taskRecord.trigger === TRIGGER_TYPES.EVENT) {
      this._queueTask(taskRecord);
    } else {
      this._executeTask(taskRecord);
    }

    this.emit('task-submitted', { taskId, agentId: task.agentId, type: task.type });
    return taskRecord;
  }

  _validateTask(task) {
    if (!task || !task.agentId) throw new AgentError('INVALID_TASK', 'Task must include agentId');
    if (task.priority !== undefined && (typeof task.priority !== 'number' || !Number.isFinite(task.priority))) {
      throw new AgentError('INVALID_TASK', 'Task priority must be a finite number');
    }
    if (task.timeout !== undefined && (typeof task.timeout !== 'number' || task.timeout <= 0 || !Number.isFinite(task.timeout))) {
      throw new AgentError('INVALID_TASK', 'Task timeout must be a positive number');
    }
  }

  _createTaskRecord(taskId, task, adapter) {
    return {
      id: taskId,
      agentId: task.agentId,
      type: task.type ?? 'default',
      payload: task.payload ?? {},
      priority: task.priority ?? (adapter.priority ?? 0),
      state: TASK_STATES.PENDING,
      trigger: task.trigger ?? TRIGGER_TYPES.MANUAL,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      retryCount: 0,
      maxRetries: task.maxRetries ?? 3,
      timeout: task.timeout ?? DEFAULT_PIPELINE_TIMEOUT_MS,
      metadata: task.metadata ?? {},
    };
  }

  _evictOldTasks() {
    if (this._tasks.size <= this._maxTasks) return;
    // First pass: try to evict terminal-state tasks
    const terminalIds = [];
    for (const [taskId, task] of this._tasks) {
      if (task.state === TASK_STATES.COMPLETED || task.state === TASK_STATES.FAILED || task.state === TASK_STATES.CANCELLED) {
        terminalIds.push(taskId);
        if (this._tasks.size - terminalIds.length <= this._maxTasks) break;
      }
    }
    for (const taskId of terminalIds) {
      this._tasks.delete(taskId);
      if (this._tasks.size <= this._maxTasks) return;
    }
    // Force eviction: remove oldest entries even if non-terminal (prevents unbounded growth)
    const excess = this._tasks.size - this._maxTasks;
    const forceEvictIds = [];
    for (const taskId of this._tasks.keys()) {
      if (forceEvictIds.length >= excess) break;
      forceEvictIds.push(taskId);
    }
    for (const taskId of forceEvictIds) {
      this._tasks.delete(taskId);
    }
  }

  /**
   * 取消指定任务，支持取消运行中、待处理或已入队的任务
   * @param {string} taskId - 任务唯一标识符
   * @returns {Object} 被取消的任务记录对象
   * @throws {AgentError} 任务不存在时抛出TASK_NOT_FOUND
   * @emits task-cancelled
   */
  cancelTask(taskId) {
    this.guardShutdown();
    const task = this._tasks.get(taskId);
    if (!task) throw new AgentError('TASK_NOT_FOUND', `Task ${taskId} not found`);

    if (task.state === TASK_STATES.RUNNING) {
      task.state = TASK_STATES.CANCELLED;
      task.completedAt = new Date().toISOString();
      this.emit('task-cancelled', { taskId, agentId: task.agentId });
    } else if (task.state === TASK_STATES.PENDING || task.state === TASK_STATES.QUEUED) {
      task.state = TASK_STATES.CANCELLED;
      task.completedAt = new Date().toISOString();
      const queueIndex = this._taskQueue.findIndex(t => t.id === taskId);
      if (queueIndex !== -1) {
        this._taskQueue.splice(queueIndex, 1);
      }
      this.emit('task-cancelled', { taskId, agentId: task.agentId });
    }

    return task;
  }

  /**
   * 获取指定任务的记录对象
   * @param {string} taskId - 任务唯一标识符
   * @returns {Object|null} 任务记录对象，不存在时返回null
   */
  getTask(_taskId) {
    return this._tasks.get(_taskId) ?? null;
  }

  /**
   * 列出所有任务，支持按agentId、state、type、trigger筛选，按创建时间倒序排列
   * @param {Object} [filter] - 筛选条件
   * @param {string} [filter.agentId] - 按Agent标识符筛选
   * @param {string} [filter.state] - 按任务状态筛选
   * @param {string} [filter.type] - 按任务类型筛选
   * @param {string} [filter.trigger] - 按触发类型筛选
   * @returns {Array<Object>} 筛选后的任务记录数组
   */
  listTasks(filter) {
    let tasks = Array.from(this._tasks.values());
    if (filter) {
      if (filter.agentId) tasks = tasks.filter(t => t.agentId === filter.agentId);
      if (filter.state) tasks = tasks.filter(t => t.state === filter.state);
      if (filter.type) tasks = tasks.filter(t => t.type === filter.type);
      if (filter.trigger) tasks = tasks.filter(t => t.trigger === filter.trigger);
    }
    return tasks.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
  }

  /**
   * 为指定Agent订阅特定类型的事件
   * @param {string} agentId - Agent唯一标识符
   * @param {string} eventType - 事件类型
   * @param {Function} [handler=null] - 事件处理回调函数
   * @returns {Object} 事件订阅记录对象
   * @emits event-subscribed
   */
  subscribeEvent(agentId, eventType, handler) {
    this.guardShutdown();
    if (!this._eventSubscriptions.has(agentId)) {
      this._eventSubscriptions.set(agentId, []);
    }

    const subs = this._eventSubscriptions.get(agentId);
    if (subs.length >= MAX_SUBSCRIPTIONS_PER_AGENT) {
      subs.shift();
    }

    const subscription = {
      eventType,
      handler: handler ?? null,
      createdAt: new Date().toISOString(),
    };

    subs.push(subscription);
    this.emit('event-subscribed', { agentId, eventType });
    return subscription;
  }

  /**
   * 向所有订阅了该事件类型的Agent分发事件
   * @param {string} eventType - 事件类型
   * @param {Object} [data={}] - 事件数据
   * @returns {void}
   * @emits event-emitted
   */
  emitEvent(eventType, data) {
    this.guardShutdown();

    const event = {
      type: eventType,
      data: data ?? {},
      timestamp: new Date().toISOString(),
    };

    for (const [agentId, subscriptions] of this._eventSubscriptions) {
      const hasMatching = subscriptions.some(function(s) { return s.eventType === eventType; });
      if (hasMatching) {
        const adapter = this._adapters.get(agentId);
        if (adapter && adapter.onEvent) {
          try {
            adapter.onEvent(event);
          } catch (err) {
            emitError(this, 'event-handler-error', err, { agentId, eventType });
          }
        }
      }
    }

    this.emit('event-emitted', event);
  }

  /**
   * 为指定Agent添加定时调度配置
   * @param {string} agentId - Agent唯一标识符
   * @param {Object} scheduleConfig - 调度配置对象
   * @param {string} [scheduleConfig.id] - 自定义调度ID
   * @param {string} [scheduleConfig.cron=null] - Cron表达式
   * @param {number} [scheduleConfig.intervalMs=null] - 间隔时间（毫秒）
   * @param {string} [scheduleConfig.taskType='scheduled'] - 调度触发的任务类型
   * @param {Object} [scheduleConfig.payload={}] - 调度任务负载
   * @param {boolean} [scheduleConfig.enabled=true] - 是否启用调度
   * @returns {Object} 创建的调度记录对象
   * @emits schedule-added
   */
  addSchedule(agentId, scheduleConfig) {
    this.guardShutdown();

    const scheduleId = scheduleConfig.id ?? 'sched-' + Date.now();
    const schedule = {
      id: scheduleId,
      agentId,
      cron: scheduleConfig.cron ?? null,
      intervalMs: scheduleConfig.intervalMs ?? null,
      taskType: scheduleConfig.taskType ?? 'scheduled',
      payload: scheduleConfig.payload ?? {},
      enabled: scheduleConfig.enabled !== false,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date().toISOString(),
    };

    this._schedules.set(scheduleId, schedule);
    if (this._schedules.size > MAX_SCHEDULES) {
      let earliestId = null;
      let earliestTime = Infinity;
      for (const [id, s] of this._schedules) {
        const rawNextRun = s.nextRunAt ? safeDateGetTime(s.nextRunAt) : Infinity;
        const nextRun = Number.isFinite(rawNextRun) ? rawNextRun : Infinity;
        if (nextRun < earliestTime) {
          earliestTime = nextRun;
          earliestId = id;
        }
      }
      if (earliestId) this._schedules.delete(earliestId);
    }
    this.emit('schedule-added', { scheduleId, agentId });
    return schedule;
  }

  /**
   * 移除指定ID的定时调度
   * @param {string} scheduleId - 调度唯一标识符
   * @returns {boolean} 调度是否存在并被移除
   */
  removeSchedule(scheduleId) {
    const existed = this._schedules.has(scheduleId);
    this._schedules.delete(scheduleId);
    return existed;
  }

  /**
   * 提交任务反馈，根据反馈类型自动更新任务状态并触发重试或完成逻辑
   * @param {string} taskId - 任务唯一标识符
   * @param {Object} feedback - 反馈对象
   * @param {string} [feedback.type='success'] - 反馈类型（success/partial/failure/timeout）
   * @param {*} [feedback.result=null] - 任务执行结果
   * @param {string} [feedback.message=''] - 反馈消息
   * @param {Object} [feedback.metrics={}] - 性能指标数据
   * @returns {Object} 创建的反馈记录对象
   * @throws {AgentError} 任务不存在时抛出TASK_NOT_FOUND
   * @emits feedback-submitted
   */
  submitFeedback(taskId, feedback) {
    this.guardShutdown();
    const task = this._tasks.get(taskId);
    if (!task) throw new AgentError('TASK_NOT_FOUND', `Task ${taskId} not found`);

    const feedbackRecord = {
      taskId,
      agentId: task.agentId,
      type: feedback.type && FEEDBACK_TYPES_SET.has(feedback.type) ? feedback.type : FEEDBACK_TYPES.SUCCESS,
      result: feedback.result ?? null,
      message: feedback.message || '',
      metrics: feedback.metrics ?? {},
      timestamp: new Date().toISOString(),
    };

    this._feedbackHistory.push(feedbackRecord);
    if (this._feedbackHistory.length > this._maxFeedbackHistory) {
      this._feedbackHistory = this._feedbackHistory.slice(-this._maxFeedbackHistory);
    }

    task.result = feedback.result;
    if (feedback.type === FEEDBACK_TYPES.SUCCESS) {
      task.state = TASK_STATES.COMPLETED;
      task.completedAt = new Date().toISOString();
    } else if (feedback.type === FEEDBACK_TYPES.FAILURE) {
      if (task.retryCount < task.maxRetries) {
        task.state = TASK_STATES.RETRYING;
        task.retryCount++;
        this._executeTask(task);
      } else {
        task.state = TASK_STATES.FAILED;
        task.completedAt = new Date().toISOString();
        task.error = feedback.message;
      }
    } else if (feedback.type === FEEDBACK_TYPES.TIMEOUT) {
      task.state = TASK_STATES.FAILED;
      task.completedAt = new Date().toISOString();
      task.error = 'Task timed out';
    }

    this.emit('feedback-submitted', feedbackRecord);
    return feedbackRecord;
  }

  /**
   * 获取反馈历史记录，支持按agentId、taskId、type筛选
   * @param {Object} [filter] - 筛选条件
   * @param {string} [filter.agentId] - 按Agent标识符筛选
   * @param {string} [filter.taskId] - 按任务标识符筛选
   * @param {string} [filter.type] - 按反馈类型筛选
   * @returns {Array<Object>} 筛选后的反馈记录数组
   */
  getFeedbackHistory(filter) {
    let history = this._feedbackHistory;
    if (filter) {
      if (filter.agentId) history = history.filter(f => f.agentId === filter.agentId);
      if (filter.taskId) history = history.filter(f => f.taskId === filter.taskId);
      if (filter.type) history = history.filter(f => f.type === filter.type);
    }
    return history;
  }

  _queueTask(task) {
    if (this._taskQueue.length >= this._maxQueueSize) {
      task.state = TASK_STATES.FAILED;
      task.error = 'Task queue is full';
      task.completedAt = new Date().toISOString();
      return;
    }

    task.state = TASK_STATES.QUEUED;
    this._taskQueue.push(task);
    this._taskQueue.sort((a, b) => b.priority - a.priority);

    this._processQueue();
  }

  _processQueue() {
    while (this._taskQueue.length > 0) {
      const task = this._taskQueue.shift();
      if (task.state === TASK_STATES.QUEUED) {
        this._executeTask(task);
      }
    }
  }

  _executeTask(task) {
    const adapter = this._adapters.get(task.agentId);
    if (!adapter) {
      task.state = TASK_STATES.FAILED;
      task.error = `Adapter not found for agent ${task.agentId}`;
      task.completedAt = new Date().toISOString();
      this.emit('task-failed', { taskId: task.id, agentId: task.agentId, error: task.error });
      return;
    }

    task.state = TASK_STATES.RUNNING;
    task.startedAt = new Date().toISOString();
    this.emit('task-started', { taskId: task.id, agentId: task.agentId });

    if (adapter.onTask) {
      try {
        const rawResult = adapter.onTask({
          id: task.id,
          type: task.type,
          payload: task.payload,
          metadata: task.metadata,
        });

        const isPromise = rawResult && typeof rawResult.then === 'function';
        if (isPromise) {
          let settled = false;
          const timeoutId = setTimeout(function() {
            if (settled || this._shutDown) return;
            settled = true;
            try {
              this.submitFeedback(task.id, {
                type: FEEDBACK_TYPES.TIMEOUT,
                message: 'Task timed out after ' + (task.timeout ?? 0) + 'ms',
              });
            } catch (err) {
              debug('AgentWorkflowIntegration', 'timeoutSubmitFeedback', err && err.message ? err.message : String(err));
            }
          }.bind(this), task.timeout);
          if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
          this._activeTaskTimers.add(timeoutId);

          rawResult.then(function(result) {
            clearTimeout(timeoutId);
            this._activeTaskTimers.delete(timeoutId);
            if (settled) return;
            settled = true;
            try {
              if (result && typeof result === 'object' && result !== null) {
                this.submitFeedback(task.id, {
                  type: result.success !== false ? FEEDBACK_TYPES.SUCCESS : FEEDBACK_TYPES.FAILURE,
                  result: result.data || result,
                  message: result.message || '',
                });
              } else {
                this.submitFeedback(task.id, {
                  type: FEEDBACK_TYPES.SUCCESS,
                  result: result,
                  message: '',
                });
              }
            } catch (fbErr) {
              emitError(this, 'feedback-error', fbErr, { taskId: task.id });
            }
          }.bind(this)).catch(function(err) {
            debug('AgentWorkflowIntegration', 'rawResult', err && err.message ? err.message : String(err));
            clearTimeout(timeoutId);
            this._activeTaskTimers.delete(timeoutId);
            if (settled) return;
            settled = true;
            try {
              this.submitFeedback(task.id, {
                type: FEEDBACK_TYPES.FAILURE,
                message: errorMessage(err),
              });
            } catch (fbErr) {
              emitError(this, 'feedback-error', fbErr, { taskId: task.id });
            }
          }.bind(this));
        } else if (rawResult && typeof rawResult === 'object' && rawResult !== null) {
          this.submitFeedback(task.id, {
            type: rawResult.success !== false ? FEEDBACK_TYPES.SUCCESS : FEEDBACK_TYPES.FAILURE,
            result: rawResult.data || rawResult,
            message: rawResult.message || '',
          });
        } else {
          this.submitFeedback(task.id, {
            type: FEEDBACK_TYPES.SUCCESS,
            result: rawResult,
            message: '',
          });
        }
      } catch (err) {
        this.submitFeedback(task.id, {
          type: FEEDBACK_TYPES.FAILURE,
          message: err && err.message ? err.message : String(err),
        });
      }
    }
  }

  /**
   * 获取工作流集成的统计信息，包括适配器数、任务数、队列大小、调度数和反馈数
   * @returns {Object} 统计信息对象，包含totalAdapters、totalTasks、taskStateCounts、queueSize、totalSchedules、totalFeedback、totalEventSubscriptions
   */
  getStats() {
    const taskStateCounts = {};
    for (const state of Object.values(TASK_STATES)) {
      taskStateCounts[state] = 0;
    }
    for (const task of this._tasks.values()) {
      taskStateCounts[task.state] = (taskStateCounts[task.state] ?? 0) + 1;
    }

    return {
      totalAdapters: this._adapters.size,
      totalTasks: this._tasks.size,
      taskStateCounts,
      queueSize: this._taskQueue.length,
      totalSchedules: this._schedules.size,
      totalFeedback: this._feedbackHistory.length,
      totalEventSubscriptions: Array.from(this._eventSubscriptions.values()).reduce((sum, subs) => sum + subs.length, 0),
    };
  }

  _onShutdown() {
    for (const tid of this._activeTaskTimers) clearTimeout(tid);
    this._activeTaskTimers.clear();
    this._taskQueue = [];
    this._tasks.clear();
    this._adapters.clear();
    this._schedules.clear();
    this._feedbackHistory = [];
    this._eventSubscriptions.clear();
    this.removeAllListeners();
  }
}

AgentWorkflowIntegration.TRIGGER_TYPES = TRIGGER_TYPES;
AgentWorkflowIntegration.TASK_STATES = TASK_STATES;
AgentWorkflowIntegration.FEEDBACK_TYPES = FEEDBACK_TYPES;

module.exports = withShutdown(AgentWorkflowIntegration);
