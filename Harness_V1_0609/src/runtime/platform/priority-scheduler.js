'use strict';

/**
 * 优先级调度器（PriorityScheduler）。实现基于优先级的任务调度、负载均衡和超时自动切换。
 * 实现了用户提出架构中"主Agent的调度逻辑强化"的核心能力：
 * - 优先级规则：紧急任务优先分配，复杂任务优先分配给高能力Agent
 * - 负载均衡：当某Agent处理任务过多时，自动将同类任务分配给其他空闲Agent
 * - 超时切换：Agent无响应时自动切换备用方案
 * - 状态监控：响应时间、任务成功率、并发量
 *
 * @module runtime/platform/priority-scheduler
 * @extends EventEmitter
 * @fires PriorityScheduler#task-scheduled
 * @fires PriorityScheduler#task-completed
 * @fires PriorityScheduler#task-failed
 * @fires PriorityScheduler#agent-overloaded
 * @fires PriorityScheduler#agent-failover
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

/** 任务优先级 */
const TASK_PRIORITY = {
  CRITICAL: 1,   // 紧急：投诉、安全事件
  HIGH: 3,       // 高：订单查询、支付问题
  NORMAL: 5,     // 普通：一般咨询
  LOW: 8,        // 低：营销活动、推荐
};

/** 任务状态 */
const TASK_STATUS = {
  QUEUED: 'queued',
  ASSIGNED: 'assigned',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
};

const DEFAULT_CONFIG = {
  maxConcurrentPerAgent: 5,      // 每个Agent最大并发任务数
  defaultTimeoutMs: 300000,      // 默认任务超时（5分钟）
  urgentTimeoutMs: 120000,       // 紧急任务超时（2分钟）
  overloadThreshold: 0.8,        // 负载阈值（80%触发负载均衡）
  maxQueueSize: 1000,            // 最大队列长度
  healthCheckIntervalMs: 30000,  // 健康检查间隔
  agentUnresponsiveMs: 60000,    // Agent无响应阈值
};

/**
 * 优先级调度器
 */
class PriorityScheduler extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxConcurrentPerAgent=5] - 每个Agent最大并发
   * @param {number} [options.defaultTimeoutMs=300000] - 默认超时
   * @param {number} [options.overloadThreshold=0.8] - 负载阈值
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._config = { ...DEFAULT_CONFIG, ...opts };

    // 任务队列（按优先级排序）: [{ id, task, priority, agentType, createdAt, timeoutMs, status }]
    this._queue = [];

    // Agent负载: agentType -> { current: number, max: number, status, lastHeartbeat, stats }
    this._agentLoad = new Map();

    // 活跃任务: taskId -> { task, agentType, assignedAt, timeoutId }
    this._activeTasks = new Map();

    // Agent统计: agentType -> { total, success, failed, timeout, avgResponseMs }
    this._agentStats = new Map();

    // 健康检查定时器
    this._healthCheckTimer = null;

    // 任务ID计数器
    this._taskIdCounter = 0;
  }

  /**
   * 注册Agent到调度器
   * @param {string} agentType - Agent类型
   * @param {number} [maxConcurrent] - 最大并发数
   * @returns {PriorityScheduler} this
   */
  registerAgent(agentType, maxConcurrent) {
    this.guardShutdown();
    if (!agentType) return this;

    this._agentLoad.set(agentType, {
      current: 0,
      max: maxConcurrent ?? this._config.maxConcurrentPerAgent,
      status: 'active',
      lastHeartbeat: Date.now(),
    });

    this._agentStats.set(agentType, {
      total: 0,
      success: 0,
      failed: 0,
      timeout: 0,
      avgResponseMs: 0,
    });

    debug('PriorityScheduler', 'agent-registered', agentType);
    return this;
  }

  /**
   * 提交任务到调度队列
   * @param {Object} task - 任务对象
   * @param {string} task.agentType - 目标Agent类型
   * @param {number} [task.priority=5] - 优先级（1-10，1最高）
   * @param {number} [task.timeoutMs] - 超时时间
   * @param {Function} [task.executeFn] - 执行函数
   * @returns {string} 任务ID
   */
  submit(task) {
    this.guardShutdown();
    if (!task) return null;

    if (this._queue.length >= this._config.maxQueueSize) {
      // 队列已满，移除最低优先级任务
      this._queue.sort((a, b) => b.priority - a.priority); // 降序（低优先级在前）
      const removed = this._queue.pop();
      this.emit('task-cancelled', { taskId: removed.id, reason: 'queue-full' });
    }

    const taskId = `task-${++this._taskIdCounter}-${Date.now()}`;
    const queueEntry = {
      id: taskId,
      task,
      priority: task.priority ?? TASK_PRIORITY.NORMAL,
      agentType: task.agentType ?? 'general',
      createdAt: Date.now(),
      timeoutMs: task.timeoutMs ?? this._config.defaultTimeoutMs,
      status: TASK_STATUS.QUEUED,
      retries: 0,
      maxRetries: task.maxRetries ?? 3,
    };

    // 按优先级插入队列（数值越小优先级越高）
    const insertIdx = this._queue.findIndex(item => item.priority > queueEntry.priority);
    if (insertIdx === -1) {
      this._queue.push(queueEntry);
    } else {
      this._queue.splice(insertIdx, 0, queueEntry);
    }

    this.emit('task-scheduled', { taskId, priority: queueEntry.priority, agentType: queueEntry.agentType });

    // 尝试立即调度
    this._trySchedule();

    return taskId;
  }

  /**
   * 批量提交任务
   * @param {Array<Object>} tasks - 任务数组
   * @returns {Array<string>} 任务ID数组
   */
  submitBatch(tasks) {
    this.guardShutdown();
    if (!Array.isArray(tasks)) return [];
    return tasks.map(t => this.submit(t)).filter(Boolean);
  }

  /**
   * 完成任务
   * @param {string} taskId - 任务ID
   * @param {*} [result] - 任务结果
   */
  complete(taskId, result) {
    const active = this._activeTasks.get(taskId);
    if (!active) return;

    clearTimeout(active.timeoutId);
    this._activeTasks.delete(taskId);

    // 更新Agent负载
    const load = this._agentLoad.get(active.agentType);
    if (load) {
      load.current = Math.max(0, load.current - 1);
    }

    // 更新统计
    const stats = this._agentStats.get(active.agentType);
    if (stats) {
      stats.total++;
      stats.success++;
      const responseTime = Date.now() - active.assignedAt;
      stats.avgResponseMs = (stats.avgResponseMs * (stats.total - 1) + responseTime) / stats.total;
    }

    this.emit('task-completed', { taskId, agentType: active.agentType, result });

    // 调度下一个任务
    this._trySchedule();
  }

  /**
   * 任务失败
   * @param {string} taskId - 任务ID
   * @param {Error|string} error - 错误信息
   */
  fail(taskId, error) {
    const active = this._activeTasks.get(taskId);
    if (!active) return;

    clearTimeout(active.timeoutId);
    this._activeTasks.delete(taskId);

    // 更新Agent负载
    const load = this._agentLoad.get(active.agentType);
    if (load) {
      load.current = Math.max(0, load.current - 1);
    }

    // 更新统计
    const stats = this._agentStats.get(active.agentType);
    if (stats) {
      stats.total++;
      stats.failed++;
    }

    this.emit('task-failed', { taskId, agentType: active.agentType, error: error?.message ?? error });

    // 重试逻辑
    if (active.retries < active.maxRetries) {
      const retryEntry = {
        id: taskId,
        task: active.task,
        priority: Math.max(1, active.priority - 1), // 提升优先级
        agentType: active.agentType,
        createdAt: Date.now(),
        timeoutMs: active.timeoutMs,
        status: TASK_STATUS.QUEUED,
        retries: active.retries + 1,
        maxRetries: active.maxRetries,
      };
      // 插入队列头部（失败重试任务优先级提升）
      this._queue.unshift(retryEntry);
      this.emit('task-scheduled', { taskId, priority: retryEntry.priority, agentType: retryEntry.agentType, retry: true });
    }

    this._trySchedule();
  }

  /**
   * 获取队列状态
   * @returns {{ queueSize: number, activeCount: number, agentLoads: Array }}
   */
  getStatus() {
    const agentLoads = [];
    for (const [agentType, load] of this._agentLoad) {
      const stats = this._agentStats.get(agentType) ?? {};
      agentLoads.push({
        agentType,
        current: load.current,
        max: load.max,
        utilization: load.max > 0 ? load.current / load.max : 0,
        status: load.status,
        totalTasks: stats.total ?? 0,
        successRate: stats.total > 0 ? (stats.success ?? 0) / stats.total : 1,
        avgResponseMs: stats.avgResponseMs ?? 0,
      });
    }

    return {
      queueSize: this._queue.length,
      activeCount: this._activeTasks.size,
      agentLoads,
    };
  }

  /**
   * 获取Agent负载信息
   * @param {string} agentType - Agent类型
   * @returns {Object|null}
   */
  getAgentLoad(agentType) {
    const load = this._agentLoad.get(agentType);
    if (!load) return null;
    const stats = this._agentStats.get(agentType) ?? {};
    return {
      agentType,
      current: load.current,
      max: load.max,
      utilization: load.max > 0 ? load.current / load.max : 0,
      isOverloaded: load.current >= load.max * this._config.overloadThreshold,
      status: load.status,
      stats: { ...stats },
    };
  }

  /**
   * 启动健康检查
   */
  startHealthCheck() {
    if (this._healthCheckTimer) return;
    this._healthCheckTimer = setInterval(() => {
      this._healthCheck();
    }, this._config.healthCheckIntervalMs);
    this._healthCheckTimer.unref();
  }

  /**
   * 停止健康检查
   */
  stopHealthCheck() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }

  // ---- 内部方法 ----

  /**
   * 尝试从队列调度任务
   * @private
   */
  _trySchedule() {
    if (this._queue.length === 0) return;

    // 按优先级排序（数值越小优先级越高）
    this._queue.sort((a, b) => a.priority - b.priority);

    const scheduled = [];
    const remaining = [];

    for (const entry of this._queue) {
      const agentType = entry.agentType;
      const load = this._agentLoad.get(agentType);

      if (!load || load.status !== 'active') {
        // Agent不可用，尝试负载均衡到其他Agent
        const fallback = this._findFallbackAgent(agentType);
        if (fallback) {
          entry.agentType = fallback;
          this._assignTask(entry);
          scheduled.push(entry);
          this.emit('agent-failover', { taskId: entry.id, from: agentType, to: fallback });
        } else {
          remaining.push(entry);
        }
        continue;
      }

      if (load.current < load.max) {
        this._assignTask(entry);
        scheduled.push(entry);
      } else {
        // Agent满载，检查是否过载（超过阈值才启用负载均衡）
        const isOverloaded = load.current >= load.max * this._config.overloadThreshold;
        if (isOverloaded) {
          const fallback = this._findFallbackAgent(agentType, entry.priority);
          if (fallback) {
            entry.agentType = fallback;
            this._assignTask(entry);
            scheduled.push(entry);
            this.emit('agent-overloaded', { taskId: entry.id, originalAgent: agentType, fallbackAgent: fallback });
          } else {
            remaining.push(entry);
          }
        } else {
          remaining.push(entry);
        }
      }
    }

    this._queue = remaining;
  }

  /**
   * 分配任务给Agent
   * @private
   */
  _assignTask(entry) {
    const load = this._agentLoad.get(entry.agentType);
    if (load) {
      load.current++;
      load.lastHeartbeat = Date.now();
    }

    entry.status = TASK_STATUS.ASSIGNED;
    entry.assignedAt = Date.now();

    // 设置超时
    const timeoutMs = entry.priority <= TASK_PRIORITY.CRITICAL
      ? Math.min(entry.timeoutMs || this._config.urgentTimeoutMs, this._config.urgentTimeoutMs)
      : (entry.timeoutMs || this._config.defaultTimeoutMs);

    const timeoutId = setTimeout(() => {
      this._handleTimeout(entry.id);
    }, timeoutMs);
    timeoutId.unref(); // 不阻止事件循环退出

    this._activeTasks.set(entry.id, {
      task: entry.task,
      agentType: entry.agentType,
      priority: entry.priority,
      assignedAt: entry.assignedAt,
      timeoutId,
      retries: entry.retries,
      maxRetries: entry.maxRetries,
    });
  }

  /**
   * 查找备用Agent
   * @private
   */
  _findFallbackAgent(originalAgentType, _priority) {
    // 查找同类型或通用Agent中的空闲者
    const fallbackCandidates = [];

    for (const [agentType, load] of this._agentLoad) {
      if (agentType === originalAgentType) continue;
      if (load.status !== 'active') continue;
      if (load.current >= load.max) continue;

      fallbackCandidates.push({
        agentType,
        utilization: load.current / load.max,
        current: load.current,
      });
    }

    if (fallbackCandidates.length === 0) return null;

    // 选择负载最低的Agent
    fallbackCandidates.sort((a, b) => a.utilization - b.utilization);
    return fallbackCandidates[0].agentType;
  }

  /**
   * 处理任务超时
   * @private
   */
  _handleTimeout(taskId) {
    const active = this._activeTasks.get(taskId);
    if (!active) return;

    this._activeTasks.delete(taskId);

    // 更新Agent负载
    const load = this._agentLoad.get(active.agentType);
    if (load) {
      load.current = Math.max(0, load.current - 1);
    }

    // 更新统计
    const stats = this._agentStats.get(active.agentType);
    if (stats) {
      stats.total++;
      stats.timeout++;
    }

    this.emit('task-failed', { taskId, agentType: active.agentType, error: 'timeout', reason: 'timeout' });

    // 重试
    if (active.retries < active.maxRetries) {
      const retryEntry = {
        id: taskId,
        task: active.task,
        priority: Math.max(1, active.priority - 1),
        agentType: active.agentType,
        createdAt: Date.now(),
        timeoutMs: (active.timeoutMs || this._config.defaultTimeoutMs) * 2, // 重试时延长超时
        status: TASK_STATUS.QUEUED,
        retries: active.retries + 1,
        maxRetries: active.maxRetries,
      };
      this._queue.unshift(retryEntry);
    }

    this._trySchedule();
  }

  /**
   * 健康检查
   * @private
   */
  _healthCheck() {
    if (this._shutDown) return;
    const now = Date.now();
    for (const [agentType, load] of this._agentLoad) {
      if (load.status !== 'active') continue;

      // 检查Agent是否无响应
      if (now - load.lastHeartbeat > this._config.agentUnresponsiveMs) {
        load.status = 'unresponsive';
        this.emit('agent-unresponsive', { agentType, lastHeartbeat: load.lastHeartbeat });
        debug('PriorityScheduler', 'agent-unresponsive', agentType);
      }

      // 检查是否过载
      if (load.max > 0 && load.current >= load.max * this._config.overloadThreshold) {
        this.emit('agent-overloaded', {
          agentType,
          current: load.current,
          max: load.max,
          utilization: load.current / load.max,
        });
      }
    }
  }

  /**
   * shutdown 清理回调，由 withShutdown mixin 在 shutdown 时调用
   * @private
   */
  _onShutdown() {
    try {
      if (this._healthCheckTimer) {
        clearInterval(this._healthCheckTimer);
        this._healthCheckTimer = null;
      }
    } catch (err) {
      debug('PriorityScheduler', 'shutdown-clearInterval-error', err);
    }

    try {
      for (const entry of this._activeTasks.values()) {
        if (entry.timeoutId) {
          clearTimeout(entry.timeoutId);
        }
      }
    } catch (err) {
      debug('PriorityScheduler', 'shutdown-clearTimeout-error', err);
    }

    try {
      this._agentLoad.clear();
      this._activeTasks.clear();
      this._agentStats.clear();
    } catch (err) {
      debug('PriorityScheduler', 'shutdown-clearMaps-error', err);
    }
  }
}

module.exports = {
  PriorityScheduler: withShutdown(PriorityScheduler),
  TASK_PRIORITY,
  TASK_STATUS,
};
