'use strict';

/**
 * @module runtime/workflow/trigger-dispatcher
 * @classdesc 统一触发调度引擎（TriggerDispatcher）。简化版Cron解析、间隔调度、Webhook路由、事件订阅。
 * TriggerDispatcher — 统一触发调度引擎
 * 融合自 Claude Managed Agents 的"事件触发/定时触发/Webhook触发/即发即忘"四种触发模式。
 * 统一管理多种触发源，将触发事件路由到 ManagedAgentHost 执行。
 * 支持Cron表达式解析（简化版）、间隔调度、事件订阅和Webhook路由。
 * @extends EventEmitter
 * @emits trigger-dispatched | trigger-failed | schedule-registered | schedule-unregistered | webhook-received
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { timestampId } = require('../../utils/unique-id');
const { errorMessage } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

const TRIGGER_TYPES = {
  EVENT: 'event',
  SCHEDULE: 'schedule',
  WEBHOOK: 'webhook',
  FIRE_AND_FORGET: 'fire-and-forget',
};

const SCHEDULE_TYPES = {
  INTERVAL: 'interval',
  CRON: 'cron',
};

const MAX_SCHEDULES = 200;
const MAX_WEBHOOK_ROUTES = 100;
const MAX_EVENT_SUBSCRIPTIONS = 500;

const CRON_FIELD_NAMES = ['minute', 'hour', 'day', 'month', 'weekday'];
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

/**
 * 验证parseInt结果是否为有效数值，NaN时抛出异常
 * @description 验证parseInt结果非NaN，防止NaN通过范围检查
 * @param {number} lo - 解析后的下界值
 * @param {number} hi - 解析后的上界值
 * @param {string} name - 字段名称
 * @param {string} field - 原始字段值
 */
function _ensureParsedInts(lo, hi, name, field) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error('Invalid value in ' + name + ': ' + field);
}

/**
 * 解析Cron列表字段 (N,M,O)
 * @param {string} field - 字段值
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @param {string} name - 字段名称
 * @returns {Function} 匹配函数
 */
function _parseCronList(field, min, max, name) {
  const values = field.split(',').map(function(s) { return parseInt(s, 10); }).filter(function(v) { return Number.isFinite(v); });
  for (const v of values) {
    if (!Number.isFinite(v) || v < min || v > max) throw new Error('Value out of bounds in ' + name + ': ' + field);
  }
  const valueSet = new Set(values);
  return function(v) { return valueSet.has(v); };
}

/**
 * 解析单个Cron字段
 * @param {string} field - 字段值
 * @param {number} index - 字段索引(0-4)
 * @returns {Function} 匹配函数
 */
function _parseCronField(field, index) {
  const [min, max] = CRON_RANGES[index];
  const name = CRON_FIELD_NAMES[index];

  if (field === '*') {
    return function() { return true; };
  }

  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    if (!Number.isFinite(step) || step <= 0) throw new Error('Invalid step in ' + name + ': ' + field);
    return function(v) { return v % step === 0; };
  }

  const rangeMatch = field.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1], 10);
    const hi = parseInt(rangeMatch[2], 10);
    _ensureParsedInts(lo, hi, name, field);
    if (lo < min || hi > max) throw new Error('Range out of bounds in ' + name + ': ' + field);
    if (lo > hi) throw new Error('Range start exceeds end in ' + name + ': ' + field);
    return function(v) { return v >= lo && v <= hi; };
  }

  const rangeStepMatch = field.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (rangeStepMatch) {
    const lo = parseInt(rangeStepMatch[1], 10);
    const hi = parseInt(rangeStepMatch[2], 10);
    const step = parseInt(rangeStepMatch[3], 10);
    if (!Number.isFinite(step) || step <= 0) throw new Error('Invalid step in ' + name + ': ' + field);
    _ensureParsedInts(lo, hi, name, field);
    if (lo > hi) throw new Error('Range start exceeds end in ' + name + ': ' + field);
    return function(v) { return v >= lo && v <= hi && (v - lo) % step === 0; };
  }

  if (field.includes(',')) {
    return _parseCronList(field, min, max, name);
  }

  const val = parseInt(field, 10);
  if (!Number.isFinite(val) || val < min || val > max) {
    throw new Error('Invalid value in ' + name + ': ' + field);
  }
  return function(v) { return v === val; };
}

/**
 * 简化版Cron解析器，支持: * / - , 五种语法
 * @param {string} expression - Cron表达式（分 时 日 月 周）
 * @returns {Function} 返回检查函数，接受Date对象返回boolean
 */
function parseCronExpression(expression) {
  if (!expression || typeof expression !== 'string') {
    throw new Error('Invalid cron expression: ' + expression);
  }
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('Cron expression must have 5 fields (min hour day month weekday): ' + expression);
  }

  const parsers = parts.map(function(field, index) {
    return _parseCronField(field, index);
  });

  return function(date) {
    const d = date ?? new Date();
    return parsers[0](d.getMinutes())
      && parsers[1](d.getHours())
      && parsers[2](d.getDate())
      && parsers[3](d.getMonth() + 1)
      && parsers[4](d.getDay());
  };
}

/**
 * 统一触发调度引擎
 * @classdesc 统一触发调度引擎，管理定时触发、事件触发和条件触发的注册与分发
 */
class TriggerDispatcher extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxSchedules=200] - 最大调度数
   * @param {number} [options.maxWebhookRoutes=100] - 最大Webhook路由数
   * @param {number} [options.maxEventSubscriptions=500] - 最大事件订阅数
   * @param {number} [options.cronCheckIntervalMs=60000] - Cron检查间隔（毫秒）
   */
  constructor(options) {
    super();
    this._options = options ?? {};
    this._maxSchedules = this._options.maxSchedules ?? MAX_SCHEDULES;
    this._maxWebhookRoutes = this._options.maxWebhookRoutes ?? MAX_WEBHOOK_ROUTES;
    this._maxEventSubscriptions = this._options.maxEventSubscriptions ?? MAX_EVENT_SUBSCRIPTIONS;
    this._cronCheckIntervalMs = this._options.cronCheckIntervalMs ?? 60000;

    // 调度注册表: scheduleId -> { type, config, agentId, matcher?, timerId?, lastFire, fireCount }
    this._schedules = new Map();

    // Webhook路由: path -> agentId
    this._webhookRoutes = new Map();

    // 事件订阅: eventType -> Set<agentId>
    this._eventSubscriptions = new Map();

    // Cron检查定时器
    this._cronTimer = null;

    // 附加的ManagedAgentHost
    this._managedHost = null;

    // 附加的EventBus
    this._eventBus = null;

    // 事件处理器引用（用于取消订阅）
    this._eventHandlers = new Map();
  }

  /**
   * 注册调度
   * @param {string} agentId - 目标Agent ID
   * @param {Object} config - 调度配置
   * @param {string} config.type - 调度类型: 'interval' | 'cron'
   * @param {number} [config.intervalMs] - 间隔毫秒数（interval类型）
   * @param {string} [config.cron] - Cron表达式（cron类型）
   * @returns {Object} { scheduleId, type, agentId }
   */
  registerSchedule(agentId, config) {
    this.guardShutdown();
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('TriggerDispatcher: agentId must be a non-empty string');
    }
    if (!config || !config.type) {
      throw new Error('TriggerDispatcher: config.type is required');
    }
    if (this._schedules.size >= this._maxSchedules) {
      throw new Error('TriggerDispatcher: maximum schedules reached (' + this._maxSchedules + ')');
    }

    const scheduleId = 'sched-' + timestampId();
    const entry = {
      scheduleId,
      agentId,
      type: config.type,
      config,
      lastFire: null,
      fireCount: 0,
      timerId: null,
      matcher: null,
    };

    if (config.type === SCHEDULE_TYPES.INTERVAL) {
      if (!config.intervalMs || config.intervalMs <= 0 || !Number.isFinite(config.intervalMs)) {
        throw new Error('TriggerDispatcher: intervalMs must be a finite positive number for interval schedule');
      }
      entry.timerId = setInterval(() => {
        if (this._shutDown) return;
        this._fireSchedule(entry).catch(function(err) {
          debug('TriggerDispatcher', 'fireSchedule failed', err && err.message ? err.message : String(err));
        });
      }, config.intervalMs);
      if (typeof entry.timerId.unref === 'function') entry.timerId.unref();
    } else if (config.type === SCHEDULE_TYPES.CRON) {
      if (!config.cron) {
        throw new Error('TriggerDispatcher: cron expression is required for cron schedule');
      }
      entry.matcher = parseCronExpression(config.cron);
      // Cron调度由_cronTimer统一驱动
      this._ensureCronTimer();
    } else {
      throw new Error('TriggerDispatcher: unknown schedule type: ' + config.type);
    }

    this._schedules.set(scheduleId, entry);
    this.emit('schedule-registered', { scheduleId, type: config.type, agentId });
    debug('TriggerDispatcher', 'registerSchedule', scheduleId + ' (' + config.type + ') for ' + agentId);
    return { scheduleId, type: config.type, agentId };
  }

  /**
   * 注销调度
   * @param {string} scheduleId - 调度ID
   * @returns {boolean} 是否成功注销
   */
  unregisterSchedule(scheduleId) {
    this.guardShutdown();
    const entry = this._schedules.get(scheduleId);
    if (!entry) return false;

    if (entry.timerId != null) {
      clearInterval(entry.timerId);
    }
    this._schedules.delete(scheduleId);

    // 如果没有cron调度了，停止cron定时器
    let hasCron = false;
    for (const [, e] of this._schedules) {
      if (e.type === SCHEDULE_TYPES.CRON) { hasCron = true; break; }
    }
    if (!hasCron) this._stopCronTimer();

    this.emit('schedule-unregistered', { scheduleId });
    return true;
  }

  /**
   * 注册Webhook路由
   * @param {string} path - Webhook路径
   * @param {string} agentId - 目标Agent ID
   * @returns {Object} { path, agentId }
   */
  registerWebhook(path, agentId) {
    this.guardShutdown();
    if (!path || typeof path !== 'string') {
      throw new Error('TriggerDispatcher: path must be a non-empty string');
    }
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('TriggerDispatcher: agentId must be a non-empty string');
    }
    if (this._webhookRoutes.size >= this._maxWebhookRoutes) {
      throw new Error('TriggerDispatcher: maximum webhook routes reached');
    }
    this._webhookRoutes.set(path, agentId);
    debug('TriggerDispatcher', 'registerWebhook', path + ' -> ' + agentId);
    return { path, agentId };
  }

  /**
   * 注销Webhook路由
   * @param {string} path - Webhook路径
   * @returns {boolean} 是否成功注销
   */
  unregisterWebhook(path) {
    this.guardShutdown();
    return this._webhookRoutes.delete(path);
  }

  /**
   * 注册事件订阅
   * @param {string} eventType - 事件类型
   * @param {string} agentId - 目标Agent ID
   * @returns {Object} { eventType, agentId }
   */
  registerEventSubscription(eventType, agentId) {
    this.guardShutdown();
    if (!eventType || typeof eventType !== 'string') {
      throw new Error('TriggerDispatcher: eventType must be a non-empty string');
    }

    let subs = this._eventSubscriptions.get(eventType);
    if (!subs) {
      subs = new Set();
      this._eventSubscriptions.set(eventType, subs);
    }
    if (subs.size >= this._maxEventSubscriptions) {
      throw new Error('TriggerDispatcher: maximum event subscriptions reached');
    }
    subs.add(agentId);

    // 如果有EventBus，订阅事件
    if (this._eventBus && !this._eventHandlers.has(eventType)) {
      const handler = function(data) {
        this._handleEventBusTrigger(eventType, data);
      }.bind(this);
      this._eventBus.on(eventType, handler);
      this._eventHandlers.set(eventType, handler);
    }

    debug('TriggerDispatcher', 'registerEvent', eventType + ' -> ' + agentId);
    return { eventType, agentId };
  }

  /**
   * 注销事件订阅
   * @param {string} eventType - 事件类型
   * @param {string} agentId - 目标Agent ID
   * @returns {boolean} 是否成功注销
   */
  unregisterEventSubscription(eventType, agentId) {
    const subs = this._eventSubscriptions.get(eventType);
    if (!subs) return false;
    const deleted = subs.delete(agentId);
    if (subs.size === 0) {
      this._eventSubscriptions.delete(eventType);
      // 移除EventBus监听
      const handler = this._eventHandlers.get(eventType);
      if (this._eventBus && handler) {
        try { this._eventBus.off(eventType, handler); } catch (_e) { debug('TriggerDispatcher', 'unsubscribeEvent:off', _e && _e.message ? _e.message : String(_e)); }
        this._eventHandlers.delete(eventType);
      }
    }
    return deleted;
  }

  /**
   * 处理Webhook请求
   * @param {string} path - Webhook路径
   * @param {Object} payload - 请求负载
   * @param {string} [signature] - HMAC签名
   * @returns {Promise<Object>} 分发结果
   */
  async dispatchWebhook(path, payload, signature, rawBody) {
    try {
      this.guardShutdown();
      const agentId = this._webhookRoutes.get(path);
      if (!agentId) {
        return { dispatched: false, reason: 'no_route', path };
      }

      this.emit('webhook-received', { path, agentId, timestamp: Date.now() });

      if (this._managedHost) {
        const result = await this._managedHost.handleWebhook(path, payload, signature, rawBody);
        // 签名验证失败时返回dispatched: false
        if (result.status === 'invalid_signature' || result.status === 'signature_required') {
          return { dispatched: false, reason: result.status, agentId, path };
        }
        return { dispatched: true, agentId, result, path };
      }
      return { dispatched: false, reason: 'no_host', agentId, path };
    } catch (err) {
      this.emit('webhook-error', { path, error: err && err.message ? err.message : String(err) });
      return { dispatched: false, error: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 处理即发即忘任务
   * @param {string} agentId - 目标Agent ID
   * @param {Object} payload - 任务负载
   * @returns {Promise<Object>} 分发结果
   */
  async dispatchFireAndForget(agentId, payload) {
    try {
      this.guardShutdown();
      if (this._managedHost) {
        const result = await this._managedHost.triggerExecution(agentId, {
          triggerSource: 'fire-and-forget',
          payload,
        });
        return { dispatched: true, agentId, result };
      }
      return { dispatched: false, reason: 'no_host', agentId };
    } catch (err) {
      this.emit('fire-and-forget-error', { agentId, error: err && err.message ? err.message : String(err) });
      return { dispatched: false, error: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 获取所有调度
   * @returns {Array<Object>} 调度列表
   */
  listSchedules() {
    const result = [];
    for (const [, entry] of this._schedules) {
      result.push({
        scheduleId: entry.scheduleId,
        agentId: entry.agentId,
        type: entry.type,
        config: entry.config,
        lastFire: entry.lastFire,
        fireCount: entry.fireCount,
      });
    }
    return result;
  }

  /**
   * 获取所有Webhook路由
   * @returns {Array<Object>} 路由列表
   */
  listWebhookRoutes() {
    const result = [];
    for (const [path, agentId] of this._webhookRoutes) {
      result.push({ path, agentId });
    }
    return result;
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计数据
   */
  getStats() {
    return {
      scheduleCount: this._schedules.size,
      webhookRouteCount: this._webhookRoutes.size,
      eventSubscriptionCount: this._countEventSubscriptions(),
      cronTimerRunning: this._cronTimer !== null,
    };
  }

  // --- Attach 方法 ---

  /**
   * 注入ManagedAgentHost
   * @param {Object} host - ManagedAgentHost实例
   * @returns {TriggerDispatcher} this
   */
  attachManagedHost(host) {
    this._managedHost = host;
    return this;
  }

  /**
   * 注入EventBus
   * @param {Object} bus - EventBus实例
   * @returns {TriggerDispatcher} this
   */
  attachEventBus(bus) {
    this._eventBus = bus;
    // 回溯注册所有已有事件订阅的EventBus监听器
    if (bus) {
      for (const [eventType, subs] of this._eventSubscriptions) {
        if (subs.size > 0 && !this._eventHandlers.has(eventType)) {
          const handler = function(data) {
            this._handleEventBusTrigger(eventType, data);
          }.bind(this);
          this._eventBus.on(eventType, handler);
          this._eventHandlers.set(eventType, handler);
        }
      }
    }
    return this;
  }

  // --- 内部方法 ---

  async _fireSchedule(entry) {
    entry.fireCount++;
    entry.lastFire = Date.now();
    this.emit('trigger-dispatched', {
      scheduleId: entry.scheduleId,
      agentId: entry.agentId,
      type: 'schedule',
      fireCount: entry.fireCount,
    });

    if (this._managedHost) {
      try {
        await this._managedHost.triggerExecution(entry.agentId, {
          triggerSource: 'schedule:' + entry.scheduleId,
          payload: { scheduleType: entry.type, fireCount: entry.fireCount },
        });
      } catch (err) {
        this.emit('trigger-failed', { scheduleId: entry.scheduleId, error: errorMessage(err) });
        debug('TriggerDispatcher', 'fireSchedule', errorMessage(err));
      }
    }
  }

  _handleEventBusTrigger(eventType, data) {
    if (this._shutDown) return;
    const subs = this._eventSubscriptions.get(eventType);
    if (!subs) return;

    for (const agentId of subs) {
      this.emit('trigger-dispatched', { agentId, type: 'event', eventType });
      if (this._managedHost) {
        this._managedHost.triggerExecution(agentId, {
          triggerSource: 'event:' + eventType,
          payload: data,
        }).catch(function(err) {
          debug('TriggerDispatcher', 'eventTrigger', errorMessage(err));
        });
      }
    }
  }

  _ensureCronTimer() {
    if (this._cronTimer) return;
    this._cronTimer = setInterval(() => {
      if (this._shutDown) return;
      const now = new Date();
      // 生成当前分钟的唯一键，防止同一分钟重复触发
      const minuteKey = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate()
        + '-' + now.getHours() + '-' + now.getMinutes();
      for (const [, entry] of this._schedules) {
        if (entry.type === SCHEDULE_TYPES.CRON && entry.matcher) {
          if (entry.matcher(now) && entry.lastFireMinute !== minuteKey) {
            entry.lastFireMinute = minuteKey;
            this._fireSchedule(entry).catch(function(err) {
              debug('TriggerDispatcher', 'cronFireSchedule failed', err && err.message ? err.message : String(err));
            });
          }
        }
      }
    }, this._cronCheckIntervalMs);
    if (typeof this._cronTimer.unref === 'function') this._cronTimer.unref();
  }

  _stopCronTimer() {
    if (this._cronTimer) {
      clearInterval(this._cronTimer);
      this._cronTimer = null;
    }
  }

  _countEventSubscriptions() {
    let count = 0;
    for (const [, subs] of this._eventSubscriptions) {
      count += subs.size;
    }
    return count;
  }

  _onShutdown() {
    // 停止所有调度定时器
    for (const [, entry] of this._schedules) {
      if (entry.timerId != null) clearInterval(entry.timerId);
    }
    this._schedules.clear();

    // 停止cron定时器
    this._stopCronTimer();

    // 移除EventBus监听
    for (const [eventType, handler] of this._eventHandlers) {
      if (this._eventBus) {
        try { this._eventBus.off(eventType, handler); } catch (_e) { debug('TriggerDispatcher', 'unsubscribeEvent:off', _e && _e.message ? _e.message : String(_e)); }
      }
    }
    this._eventHandlers.clear();

    this._webhookRoutes.clear();
    this._eventSubscriptions.clear();
    this._managedHost = null;
    this._eventBus = null;
    this.removeAllListeners();
  }
}

// 静态属性
TriggerDispatcher.TRIGGER_TYPES = TRIGGER_TYPES;
TriggerDispatcher.SCHEDULE_TYPES = SCHEDULE_TYPES;
TriggerDispatcher.parseCronExpression = parseCronExpression;

module.exports = withShutdown(TriggerDispatcher);
