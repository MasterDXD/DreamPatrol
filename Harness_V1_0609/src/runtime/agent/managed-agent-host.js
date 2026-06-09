'use strict';

/**
 * @module runtime/agent/managed-agent-host
 * @classdesc 托管Agent运行容器（ManagedAgentHost）。4种触发模式（事件/定时/Webhook/即发即忘）、
 * HMAC-SHA256签名验证、执行超时保护、心跳监控、BoundedArray执行历史。
 *
 * ManagedAgentHost — 托管Agent运行容器
 * 融合自 Claude Managed Agents 的"托管服务"概念，将 AgentRuntime 组合为可独立运行的托管单元。
 * 支持4种触发模式：事件触发、定时触发、Webhook触发、即发即忘。
 * 核心设计遵循"Brain-Hands-Memory"分离原则，通过AgentRuntime组合ModelLayer/HarnessLayer。
 * @extends EventEmitter
 * @emits agent-started | agent-stopped | agent-paused | agent-resumed | trigger-fired | execution-completed | execution-failed
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { timestampId } = require('../../utils/unique-id');
const { errorMessage, emitError, safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const BoundedArray = require('../../utils/bounded-array');

const TRIGGER_MODES = {
  EVENT: 'event',
  SCHEDULE: 'schedule',
  WEBHOOK: 'webhook',
  FIRE_AND_FORGET: 'fire-and-forget',
};

const HOST_STATES = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  ERROR: 'error',
};

const MAX_EXECUTION_HISTORY = 200;
const MAX_HOSTED_AGENTS = 50;
const DEFAULT_EXECUTION_TIMEOUT_MS = 300000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * 托管Agent运行容器，管理Agent实例的生命周期、触发调度和执行上下文
 */
class ManagedAgentHost extends EventEmitter {
  /**
   * @param {string} projectRoot - 项目根目录
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxHostedAgents=50] - 最大托管Agent数
   * @param {number} [options.executionTimeoutMs=300000] - 默认执行超时
   * @param {number} [options.heartbeatIntervalMs=30000] - 心跳间隔
   */
  constructor(projectRoot, options) {
    super();
    this.root = projectRoot;
    this._options = options ?? {};
    this._maxHostedAgents = this._options.maxHostedAgents ?? MAX_HOSTED_AGENTS;
    this._defaultTimeoutMs = this._options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this._heartbeatIntervalMs = this._options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

    // 托管Agent注册表: agentId -> { runtime, config, state, trigger, lastExecution, executionCount, createdAt }
    this._agents = new Map();

    // 执行历史: agentId -> BoundedArray of execution records
    this._executionHistory = new Map();

    // 调度定时器: agentId -> timerId
    this._scheduleTimers = new Map();

    // 心跳定时器
    this._heartbeatTimer = null;

    // 执行中的Agent集合
    this._executing = new Set();

    // Webhook签名密钥
    this._webhookSecret = this._options.webhookSecret ?? null;

    // 附加的依赖
    this._goalExecutor = null;
    this._eventBus = null;
  }

  /**
   * 注册托管Agent
   * @param {string} agentId - Agent唯一标识
   * @param {Object} config - 托管配置
   * @param {Object} config.runtime - AgentRuntime实例
   * @param {string} [config.triggerMode='event'] - 触发模式
   * @param {Object} [config.schedule] - 定时调度配置 { cron, intervalMs }
   * @param {string[]} [config.eventSubscriptions=[]] - 订阅的事件类型列表
   * @param {string} [config.webhookPath] - Webhook路径
   * @param {number} [config.executionTimeoutMs] - 执行超时
   * @param {Object} [config.metadata={}] - 附加元数据
   * @returns {Object} 注册结果 { agentId, state, triggerMode }
   */
  registerAgent(agentId, config) {
    this.guardShutdown();
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('ManagedAgentHost: agentId must be a non-empty string');
    }
    if (this._agents.has(agentId)) {
      throw new Error('ManagedAgentHost: agent ' + agentId + ' is already registered');
    }
    if (this._agents.size >= this._maxHostedAgents) {
      throw new Error('ManagedAgentHost: maximum hosted agents reached (' + this._maxHostedAgents + ')');
    }
    if (!config || !config.runtime) {
      throw new Error('ManagedAgentHost: config.runtime is required');
    }

    const triggerMode = config.triggerMode ?? TRIGGER_MODES.EVENT;
    if (!Object.values(TRIGGER_MODES).includes(triggerMode)) {
      throw new Error('ManagedAgentHost: invalid triggerMode: ' + triggerMode);
    }

    const entry = {
      agentId,
      runtime: config.runtime,
      triggerMode,
      schedule: config.schedule ?? null,
      eventSubscriptions: Array.isArray(config.eventSubscriptions) ? config.eventSubscriptions : [],
      webhookPath: config.webhookPath ?? null,
      executionTimeoutMs: config.executionTimeoutMs ?? this._defaultTimeoutMs,
      metadata: config.metadata ?? {},
      state: HOST_STATES.IDLE,
      executionCount: 0,
      lastExecution: null,
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
    };

    this._agents.set(agentId, entry);
    this._executionHistory.set(agentId, new BoundedArray(MAX_EXECUTION_HISTORY));

    // 如果是定时触发，启动调度
    if (triggerMode === TRIGGER_MODES.SCHEDULE && entry.schedule) {
      this._startScheduleTimer(agentId);
    }

    // 如果订阅了事件，注册监听
    if (triggerMode === TRIGGER_MODES.EVENT && entry.eventSubscriptions.length > 0 && this._eventBus) {
      this._subscribeToEvents(agentId);
    }

    this.emit('agent-registered', { agentId, state: entry.state, triggerMode });
    debug('ManagedAgentHost', 'registerAgent', 'Registered managed agent: ' + agentId + ' (' + triggerMode + ')');
    return { agentId, state: entry.state, triggerMode };
  }

  /**
   * 注销托管Agent
   * @param {string} agentId - Agent唯一标识
   * @returns {boolean} 是否成功注销
   */
  unregisterAgent(agentId) {
    this.guardShutdown();
    const entry = this._agents.get(agentId);
    if (!entry) return false;

    // 停止调度定时器
    this._stopScheduleTimer(agentId);

    // 取消事件订阅
    if (this._eventBus && entry.eventSubscriptions.length > 0) {
      this._unsubscribeFromEvents(agentId);
    }

    this._agents.delete(agentId);
    this._executionHistory.delete(agentId);
    this._executing.delete(agentId);

    this.emit('agent-unregistered', { agentId });
    debug('ManagedAgentHost', 'unregisterAgent', 'Unregistered managed agent: ' + agentId);
    return true;
  }

  /**
   * 启动托管Agent（从IDLE/PAUSED状态转为RUNNING）
   * @param {string} agentId - Agent唯一标识
   * @returns {boolean} 是否成功启动
   */
  startAgent(agentId) {
    this.guardShutdown();
    const entry = this._agents.get(agentId);
    if (!entry) return false;
    if (entry.state !== HOST_STATES.IDLE && entry.state !== HOST_STATES.PAUSED) return false;

    entry.state = HOST_STATES.RUNNING;
    entry.lastHeartbeat = Date.now();
    this._startHeartbeat();
    this.emit('agent-started', { agentId, state: entry.state });
    debug('ManagedAgentHost', 'startAgent', 'Started managed agent: ' + agentId);
    return true;
  }

  /**
   * 暂停托管Agent
   * @param {string} agentId - Agent唯一标识
   * @returns {boolean} 是否成功暂停
   */
  pauseAgent(agentId) {
    this.guardShutdown();
    const entry = this._agents.get(agentId);
    if (!entry) return false;
    if (entry.state !== HOST_STATES.RUNNING) return false;

    entry.state = HOST_STATES.PAUSED;
    this.emit('agent-paused', { agentId, state: entry.state });
    debug('ManagedAgentHost', 'pauseAgent', 'Paused managed agent: ' + agentId);
    return true;
  }

  /**
   * 恢复暂停的托管Agent
   * @param {string} agentId - Agent唯一标识
   * @returns {boolean} 是否成功恢复
   */
  resumeAgent(agentId) {
    return this.startAgent(agentId);
  }

  /**
   * 停止托管Agent
   * @param {string} agentId - Agent唯一标识
   * @returns {boolean} 是否成功停止
   */
  stopAgent(agentId) {
    this.guardShutdown();
    const entry = this._agents.get(agentId);
    if (!entry) return false;

    this._stopScheduleTimer(agentId);
    entry.state = HOST_STATES.STOPPED;
    this.emit('agent-stopped', { agentId, state: entry.state });
    debug('ManagedAgentHost', 'stopAgent', 'Stopped managed agent: ' + agentId);
    return true;
  }

  /**
   * 触发托管Agent执行
   * @param {string} agentId - Agent唯一标识
   * @param {Object} [context={}] - 执行上下文
   * @param {string} [context.triggerSource] - 触发来源
   * @param {Object} [context.payload] - 触发负载数据
   * @returns {Promise<Object>} 执行结果 { executionId, agentId, status, duration, result }
   */
  async triggerExecution(agentId, context) {
    this.guardShutdown();
    const entry = this._agents.get(agentId);
    if (!entry) {
      return { executionId: null, agentId, status: 'not_found', duration: 0, result: null };
    }
    if (entry.state !== HOST_STATES.RUNNING) {
      return { executionId: null, agentId, status: 'not_running', duration: 0, result: null };
    }
    if (this._executing.has(agentId)) {
      return { executionId: null, agentId, status: 'already_executing', duration: 0, result: null };
    }

    const executionId = 'exec-' + timestampId();
    const startTime = Date.now();
    const ctx = context ?? {};
    ctx.triggerSource = ctx.triggerSource ?? 'manual';
    ctx.executionId = executionId;

    this._executing.add(agentId);
    this.emit('trigger-fired', { agentId, executionId, triggerSource: ctx.triggerSource });

    let status = 'completed';
    let result = null;
    let error = null;

    try {
      // 如果有GoalExecutor，委托执行
      if (this._goalExecutor && typeof this._goalExecutor.createGoal === 'function') {
        const goalResult = await this._executeWithTimeout(
          this._goalExecutor.createGoal(agentId, {
            objective: ctx.payload ?? 'Execute managed agent task',
            maxIterations: 10,
          }),
          entry.executionTimeoutMs,
        );
        result = goalResult;
      } else if (entry.runtime && typeof entry.runtime.infer === 'function') {
        // 直接通过AgentRuntime执行推理
        const inferResult = await this._executeWithTimeout(
          entry.runtime.infer(ctx.payload ?? []),
          entry.executionTimeoutMs,
        );
        result = inferResult;
      } else {
        result = { message: 'No execution backend available' };
      }
    } catch (err) {
      status = 'failed';
      error = errorMessage(err);
      emitError(this, 'execution-failed', err);
    }

    const duration = Date.now() - startTime;

    // 如果在执行期间发生了shutdown，提前返回（在操作共享状态前检查）
    if (this._shutDown) {
      this._executing.delete(agentId);
      return { executionId, agentId, status: 'aborted', duration, result: null, error: null };
    }

    // 二次检查：在修改共享状态前确认未shutdown
    if (this._shutDown) {
      this._executing.delete(agentId);
      return { executionId, agentId, status: 'aborted', duration, result: null, error: null };
    }

    this._executing.delete(agentId);

    // 更新执行统计
    entry.executionCount++;
    entry.lastExecution = { executionId, status, duration, timestamp: Date.now() };
    entry.lastHeartbeat = Date.now();

    // 记录执行历史
    const history = this._executionHistory.get(agentId);
    if (history) {
      history.push({ executionId, status, duration, triggerSource: ctx.triggerSource, error, timestamp: Date.now() });
    }

    const execResult = { executionId, agentId, status, duration, result, error };
    if (status === 'completed') {
      this.emit('execution-completed', execResult);
    } else {
      this.emit('execution-failed', execResult);
    }

    debug('ManagedAgentHost', 'triggerExecution', agentId + ' ' + status + ' in ' + duration + 'ms');
    return execResult;
  }

  /**
   * 处理Webhook触发
   * @param {string} webhookPath - Webhook路径
   * @param {Object} payload - Webhook负载数据
   * @param {string} [signature] - 签名（用于验证）
   * @returns {Promise<Object>} 执行结果
   */
  async handleWebhook(webhookPath, payload, signature, rawBody) {
    this.guardShutdown();
    if (!webhookPath || typeof webhookPath !== 'string') {
      return { status: 'invalid_path', agentId: null };
    }

    // 查找匹配webhookPath的Agent
    let matchedAgentId = null;
    for (const [agentId, entry] of this._agents) {
      if (entry.webhookPath === webhookPath) {
        matchedAgentId = agentId;
        break;
      }
    }

    if (!matchedAgentId) {
      return { status: 'no_matching_agent', agentId: null };
    }

    // 验证签名（如果配置了密钥则必须提供签名）
    if (this._webhookSecret) {
      if (!signature) {
        return { status: 'signature_required', agentId: matchedAgentId };
      }
      const expected = crypto.createHmac('sha256', this._webhookSecret)
        .update(rawBody ?? JSON.stringify(payload))
        .digest('hex');
      const sigBuf = Buffer.from(signature, 'hex');
      const expBuf = Buffer.from(expected, 'hex');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return { status: 'invalid_signature', agentId: matchedAgentId };
      }
    }

    return this.triggerExecution(matchedAgentId, {
      triggerSource: 'webhook',
      payload,
    });
  }

  /**
   * 处理事件触发
   * @param {string} eventType - 事件类型
   * @param {Object} eventData - 事件数据
   * @returns {Array<Promise>} 所有匹配Agent的执行Promise
   */
  handleEventTrigger(eventType, eventData) {
    if (this._shutDown) return [];
    const promises = [];
    for (const [agentId, entry] of this._agents) {
      if (entry.triggerMode === TRIGGER_MODES.EVENT
        && entry.eventSubscriptions.includes(eventType)
        && entry.state === HOST_STATES.RUNNING) {
        promises.push(this.triggerExecution(agentId, {
          triggerSource: 'event:' + eventType,
          payload: eventData,
        }));
      }
    }
    return promises;
  }

  /**
   * 获取托管Agent状态
   * @param {string} agentId - Agent唯一标识
   * @returns {Object|null} Agent状态信息
   */
  getAgentStatus(agentId) {
    const entry = this._agents.get(agentId);
    if (!entry) return null;
    return {
      agentId,
      state: entry.state,
      triggerMode: entry.triggerMode,
      executionCount: entry.executionCount,
      lastExecution: entry.lastExecution,
      isExecuting: this._executing.has(agentId),
      lastHeartbeat: entry.lastHeartbeat,
      createdAt: entry.createdAt,
    };
  }

  /**
   * 获取所有托管Agent列表
   * @returns {Array<Object>} Agent状态列表
   */
  listAgents() {
    const result = [];
    for (const [agentId] of this._agents) {
      result.push(this.getAgentStatus(agentId));
    }
    return result;
  }

  /**
   * 获取执行历史
   * @param {string} agentId - Agent唯一标识
   * @param {number} [limit=20] - 返回条数
   * @returns {Array<Object>} 执行历史记录
   */
  getExecutionHistory(agentId, limit) {
    const history = this._executionHistory.get(agentId);
    if (!history) return [];
    const n = limit ?? 20;
    const items = history.toArray();
    return items.slice(-n);
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计数据
   */
  getStats() {
    let totalExecutions = 0;
    let runningCount = 0;
    let pausedCount = 0;
    let idleCount = 0;
    for (const [, entry] of this._agents) {
      totalExecutions += entry.executionCount;
      if (entry.state === HOST_STATES.RUNNING) runningCount++;
      else if (entry.state === HOST_STATES.PAUSED) pausedCount++;
      else if (entry.state === HOST_STATES.IDLE) idleCount++;
    }
    return {
      totalAgents: this._agents.size,
      maxAgents: this._maxHostedAgents,
      runningCount,
      pausedCount,
      idleCount,
      executingCount: this._executing.size,
      totalExecutions,
    };
  }

  // --- Attach 方法 ---

  /**
   * 注入GoalExecutor
   * @param {Object} executor - GoalExecutor实例
   * @returns {ManagedAgentHost} this
   */
  attachGoalExecutor(executor) {
    this._goalExecutor = executor;
    return this;
  }

  /**
   * 注入EventBus
   * @param {Object} bus - EventBus实例
   * @returns {ManagedAgentHost} this
   */
  attachEventBus(bus) {
    this._eventBus = bus;
    // 回溯订阅所有已注册的事件模式Agent
    if (bus) {
      for (const [agentId, entry] of this._agents) {
        if (entry.triggerMode === TRIGGER_MODES.EVENT && entry.eventSubscriptions.length > 0) {
          this._subscribeToEvents(agentId);
        }
      }
    }
    return this;
  }

  // --- 内部方法 ---

  _startScheduleTimer(agentId) {
    this._stopScheduleTimer(agentId);
    const entry = this._agents.get(agentId);
    if (!entry || !entry.schedule) return;

    const intervalMs = entry.schedule.intervalMs;
    if (!intervalMs || intervalMs <= 0 || !Number.isFinite(intervalMs)) return;

    const timerId = setInterval(() => {
      if (this._shutDown) return;
      if (entry.state !== HOST_STATES.RUNNING) return;
      this.triggerExecution(agentId, {
        triggerSource: 'schedule',
        payload: { scheduledAt: Date.now(), intervalMs },
      }).catch(function(err) {
        debug('ManagedAgentHost', 'scheduleTrigger', errorMessage(err));
      });
    }, intervalMs);

    if (typeof timerId.unref === 'function') timerId.unref();
    this._scheduleTimers.set(agentId, timerId);
    debug('ManagedAgentHost', 'startSchedule', agentId + ' every ' + intervalMs + 'ms');
  }

  _stopScheduleTimer(agentId) {
    const timerId = this._scheduleTimers.get(agentId);
    if (timerId != null) {
      clearInterval(timerId);
      this._scheduleTimers.delete(agentId);
    }
  }

  _subscribeToEvents(agentId) {
    const entry = this._agents.get(agentId);
    if (!entry || !this._eventBus) return;

    // Remove old handlers from eventBus before clearing references
    if (entry._eventHandlers && entry._eventHandlers.length > 0) {
      for (const { eventType, handler } of entry._eventHandlers) {
        try { this._eventBus.off(eventType, handler); } catch (_e) { debug('ManagedAgentHost', 'subscribeToEvents:off', _e && _e.message ? _e.message : String(_e)); }
      }
    }
    entry._eventHandlers = [];
    for (const eventType of entry.eventSubscriptions) {
      const handler = function(data) {
        const promises = this.handleEventTrigger(eventType, data);
        for (const p of promises) {
          p.catch(err => {
            debug('ManagedAgentHost', 'eventTriggerError', { eventType, error: err && err.message ? err.message : String(err) });
          });
        }
      }.bind(this);
      this._eventBus.on(eventType, handler);
      entry._eventHandlers.push({ eventType, handler });
    }
  }

  _unsubscribeFromEvents(agentId) {
    const entry = this._agents.get(agentId);
    if (!entry || !this._eventBus || !entry._eventHandlers) return;

    for (const { eventType, handler } of entry._eventHandlers) {
      try { this._eventBus.off(eventType, handler); } catch (_e) { debug('ManagedAgentHost', 'stopAgent:off', _e && _e.message ? _e.message : String(_e)); }
    }
    entry._eventHandlers = [];
  }

  async _executeWithTimeout(promise, timeoutMs) {
    let timerId = null;
    promise.catch(function(err) { debug('ManagedAgentHost', 'executeWithTimeout:unhandled', err && err.message ? err.message : String(err)); });
    const timeoutPromise = new Promise(function(_resolve, reject) {
      timerId = setTimeout(function() {
        reject(new Error('Execution timeout after ' + timeoutMs + 'ms'));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([promise, timeoutPromise]);
      return result;
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      if (this._shutDown) return;
      for (const [, entry] of this._agents) {
        if (entry.state === HOST_STATES.RUNNING) {
          entry.lastHeartbeat = Date.now();
        }
      }
    }, this._heartbeatIntervalMs);
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  _onShutdown() {
    // 停止所有调度定时器
    for (const [agentId] of this._scheduleTimers) {
      this._stopScheduleTimer(agentId);
    }

    // 停止心跳
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    // 取消所有事件订阅
    for (const [agentId] of this._agents) {
      this._unsubscribeFromEvents(agentId);
    }

    // 将所有运行中的Agent设为STOPPED
    for (const [, entry] of this._agents) {
      if (entry.state === HOST_STATES.RUNNING) {
        entry.state = HOST_STATES.STOPPED;
      }
    }

    this._executing.clear();
    this._agents.clear();
    for (const ba of this._executionHistory.values()) { safeCall(() => ba.shutdown(), 'ManagedAgentHost', 'shutdown-execHistory'); }
    try { this._executionHistory.clear(); } catch (_e) { debug('ManagedAgentHost', 'shutdown:clearHistory', _e && _e.message ? _e.message : String(_e)); }
    this._scheduleTimers.clear();
    this._goalExecutor = null;
    this._eventBus = null;
    this.removeAllListeners();
  }
}

// 静态属性
ManagedAgentHost.TRIGGER_MODES = TRIGGER_MODES;
ManagedAgentHost.HOST_STATES = HOST_STATES;
ManagedAgentHost.MAX_HOSTED_AGENTS = MAX_HOSTED_AGENTS;

module.exports = withShutdown(ManagedAgentHost);
