'use strict';
const DeepeningBase = require('./deepening-base');
const RingBuffer = require('../../utils/ring-buffer');
const BoundedMap = require('../../utils/bounded-map');
const { debug } = require('../../utils/debug-logger');
const { emitError, safeCall } = require('../../utils/safe-execute');
const { counterId, ID_PREFIXES } = require('../../utils/unique-id');

/**
 * @constant {Object} LEVEL_PRIORITY - 通知级别优先级映射，debug=0, info=1, warn=2, error=3
 */
const LEVEL_PRIORITY = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * 编译并缓存正则表达式模式。
 * @param {BoundedMap} cache - 正则编译缓存
 * @param {string} pattern - 正则表达式字符串
 * @returns {RegExp|null} 编译后的正则表达式，编译失败返回 null
 * @private
 */
const REDOS_DANGEROUS_RE = /(?:\([^)]*[+*][^)]*\))[+*{]|(?:\([^)]+\)[+*]){2,}|\(\?:[^)]*\)[+*]{2,}/;

function _getCompiledPattern(cache, pattern) {
  if (typeof pattern !== 'string' || pattern.length > 200) return null;
  const cached = cache.get(pattern);
  if (cached) return cached;
  if (REDOS_DANGEROUS_RE.test(pattern)) {
    debug('DeepeningNotifier', 'pattern rejected: dangerous quantifier nesting', pattern);
    return null;
  }
  try {
    const re = new RegExp(pattern);
    cache.set(pattern, re);
    return re;
  } catch (err) {
    debug('DeepeningNotifier', 'pattern compile failed', pattern, err && err.message ? err.message : String(err));
    return null;
  }
}

/**
 * @module runtime/deepening/deepening-notifier
 * 基于通道的通知分发器。管理命名通道和模式匹配订阅，
 * 支持级别过滤（debug/info/warn/error）、正则和通配符模式匹配、
 * 环形缓冲区通知日志及订阅启用/禁用生命周期控制。
 */

/**
 * @classdesc 深化通知器。多渠道通知、通知模板、通知策略
 *
 * 基于通道的通知分发器 — 为深化管道提供多通道、多级别的通知分发能力。
 * 管理命名通道和模式匹配订阅，支持级别过滤（debug/info/warn/error）、
 * 正则和通配符模式匹配、环形缓冲区通知日志及订阅启用/禁用生命周期控制。
 *
 * @extends DeepeningBase
 * @emits 'notification-dispatched' 当通知分发到订阅时触发，附带 {subscriptionId, channel, level, event}
 * @emits 'notification-sent' 当通知发送完成时触发，附带 {level, event}
 */
class DeepeningNotifier extends DeepeningBase {

  /**
   * 创建 DeepeningNotifier 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxLogSize=1000] - 通知日志环形缓冲区最大容量
   * @param {string} [options.minLevel='info'] - 默认最低通知级别
   */
  constructor(options) {
    super(options);
    this._channels = new Map();
    this._maxChannels = 100;
    this._subscriptions = new Map();
    this._maxSubscriptions = 500;
    this._maxLogSize = (options && options.maxLogSize) ?? 1000;
    this._log = new RingBuffer(this._maxLogSize);
    this._minLevel = (options && options.minLevel) ?? 'info';
    this._enabledCount = 0;
    this._disabledCount = 0;
    this._patternCache = new BoundedMap(200);
  }

  /**
   * 注册命名通知通道。
   * @param {string} name - 通道名称
   * @param {Object} [config] - 通道配置
   * @param {Function} [config.callback] - 通道回调函数，接收通知条目
   * @returns {boolean} 注册成功返回 true，名称无效返回 false
   */
  registerChannel(name, config) {
    if (!name || typeof name !== 'string') return false;
    if (this._channels.size >= this._maxChannels && !this._channels.has(name)) {
      const oldest = this._channels.keys().next().value;
      this._channels.delete(oldest);
    }
    this._channels.set(name, config ?? {});
    return true;
  }

  /**
   * 注销命名通知通道。
   * @param {string} name - 通道名称
   * @returns {boolean} 注销成功返回 true，通道不存在返回 false
   */
  unregisterChannel(name) { return this._channels.delete(name); }

  /**
   * 订阅通知模式。支持通配符（*）、精确匹配和正则表达式模式。
   * @param {string} pattern - 事件匹配模式（'*'匹配所有，支持正则表达式）
   * @param {string} channel - 通道名称
   * @param {Object} [options] - 订阅选项
   * @param {string} [options.minLevel] - 该订阅的最低通知级别，覆盖全局 minLevel
   * @returns {string|null} 订阅ID，模式无效返回 null
   */
  subscribe(pattern, channel, options) {
    this.guardShutdown();
    if (!pattern || typeof pattern !== 'string') return null;
    const opts = options ?? {};
    const id = counterId(ID_PREFIXES.DEEPENING_NOTIF);
    if (this._subscriptions.size >= this._maxSubscriptions) {
      const oldest = this._subscriptions.keys().next().value;
      const oldSub = this._subscriptions.get(oldest);
      if (oldSub) { if (oldSub.enabled) this._enabledCount--; else this._disabledCount--; }
      this._subscriptions.delete(oldest);
    }
    this._subscriptions.set(id, { id, pattern, channel, minLevel: opts.minLevel ?? this._minLevel, enabled: true });
    this._enabledCount++;
    return id;
  }

  /**
   * 取消订阅。
   * @param {string} subId - 订阅ID
   * @returns {boolean} 取消成功返回 true，订阅不存在返回 false
   */
  unsubscribe(subId) {
    this.guardShutdown();
    const sub = this._subscriptions.get(subId);
    if (!sub) return false;
    if (sub.enabled) this._enabledCount--; else this._disabledCount--;
    return this._subscriptions.delete(subId);
  }

  /**
   * 启用指定订阅。
   * @param {string} subId - 订阅ID
   * @returns {boolean} 操作成功返回 true
   */
  enableSubscription(subId) { const s = this._subscriptions.get(subId); if (s && !s.enabled) { s.enabled = true; this._enabledCount++; this._disabledCount--; return true; } return false; }

  /**
   * 禁用指定订阅。
   * @param {string} subId - 订阅ID
   * @returns {boolean} 操作成功返回 true
   */
  disableSubscription(subId) { const s = this._subscriptions.get(subId); if (s && s.enabled) { s.enabled = false; this._enabledCount--; this._disabledCount++; return true; } return false; }

  /**
   * 发送 debug 级别通知。
   * @param {string} event - 事件名称
   * @param {*} data - 事件数据
   * @returns {Promise<boolean>} 发送成功返回 true
   */
  notifyDebug(event, data) { return this._notify('debug', event, data); }

  /**
   * 发送 info 级别通知。
   * @param {string} event - 事件名称
   * @param {*} data - 事件数据
   * @returns {Promise<boolean>} 发送成功返回 true
   */
  notifyInfo(event, data) { return this._notify('info', event, data); }

  /**
   * 发送 warn 级别通知。
   * @param {string} event - 事件名称
   * @param {*} data - 事件数据
   * @returns {Promise<boolean>} 发送成功返回 true
   */
  notifyWarn(event, data) { return this._notify('warn', event, data); }

  /**
   * 发送 error 级别通知。
   * @param {string} event - 事件名称
   * @param {*} data - 事件数据
   * @returns {Promise<boolean>} 发送成功返回 true
   */
  notifyError(event, data) { return this._notify('error', event, data); }

  /**
   * 检查通知级别是否满足最低级别要求。
   * @param {string} entryLevel - 通知条目级别
   * @param {string} minLevel - 最低级别要求
   * @returns {boolean} 满足要求返回 true
   * @private
   */
  _matchesLevel(entryLevel, minLevel) {
    const entryPrio = LEVEL_PRIORITY[entryLevel];
    const minPrio = LEVEL_PRIORITY[minLevel];
    if (entryPrio === undefined || minPrio === undefined) return true;
    return entryPrio >= minPrio;
  }

  /**
   * 检查事件名称是否匹配指定模式。
   * @param {string} event - 事件名称
   * @param {string} pattern - 匹配模式（'*'通配、精确匹配或正则表达式）
   * @returns {boolean} 匹配成功返回 true
   * @private
   */
  _matchesPattern(event, pattern) {
    if (pattern === '*') return true;
    if (pattern === event) return true;
    const re = _getCompiledPattern(this._patternCache, pattern);
    if (re) return re.test(event);
    return event.includes(pattern);
  }

  /**
   * 内部通知分发逻辑。记录日志并按订阅模式匹配分发到通道。
   * @param {string} level - 通知级别
   * @param {string} event - 事件名称
   * @param {*} data - 事件数据
   * @returns {Promise<boolean>} 发送成功返回 true
   * @emits 'notification-dispatched' 通知分发到订阅时触发，附带 {subscriptionId, channel, level, event}
   * @emits 'notification-sent' 通知发送完成时触发，附带 {level, event}
   * @private
   */
  _notify(level, event, data) {
    const entry = { level, event, data, timestamp: Date.now() };
    this._log.push(entry);
    let delivered = 0;

    for (const [, sub] of this._subscriptions) {
      if (!sub.enabled) continue;
      if (!this._matchesLevel(level, sub.minLevel)) continue;
      if (!this._matchesPattern(event, sub.pattern)) continue;
      const channel = this._channels.get(sub.channel);
      if (channel && typeof channel.callback === 'function') {
        try {
          const cbResult = channel.callback(entry);
          if (cbResult && typeof cbResult.then === 'function') {
            cbResult.catch(e => {
              debug('DeepeningNotifier', 'asyncCallbackError', e);
              this.emit('callback-error', { error: e && e.message ? e.message : String(e), channel: sub.channel });
            });
          }
          delivered++;
        } catch (e) { debug('DeepeningNotifier', 'callbackError', e); emitError(this, 'callback-error', e, { channel: sub.channel }); }
      }
      this.emit('notification-dispatched', { subscriptionId: sub.id, channel: sub.channel, level, event });
    }

    this.emit('notification-sent', { level, event });
    return Promise.resolve(delivered > 0);
  }

  /**
   * 获取通知日志，支持按级别过滤和数量限制。
   * @param {Object} [options] - 查询选项
   * @param {number} [options.limit=100] - 返回最大数量
   * @param {string} [options.level] - 按级别过滤
   * @returns {Array<Object>} 通知日志数组 [{level, event, data, timestamp}]
   */
  getNotificationLog(options) {
    const limit = (options && options.limit) ?? 100;
    const level = options && options.level;
    let log = this._log.toArray();
    if (level) log = log.filter(e => e.level === level);
    return log.slice(-limit);
  }

  /**
   * 获取订阅统计信息。
   * @returns {Object} 订阅统计 {total, enabled, disabled}
   */
  getSubscriptionStats() {
    return { total: this._subscriptions.size, enabled: this._enabledCount, disabled: this._disabledCount };
  }

  /**
   * 获取通知分发器的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.channelCount - 通道数量
   * @returns {number} return.subscriptionCount - 订阅数量
   * @returns {number} return.totalNotifications - 累计通知数
   * @returns {number} return.maxLogSize - 日志最大容量
   */
  getStats() {
    return { channelCount: this._channels.size, subscriptionCount: this._subscriptions.size, totalNotifications: this._log.size, maxLogSize: this._maxLogSize, ...super.getStats() };
  }

  /**
   * 关闭时的清理回调。清空所有通道和订阅。
   * @protected
   */
  _onShutdown() {
    this._channels.clear();
    this._subscriptions.clear();
    this._enabledCount = 0;
    this._disabledCount = 0;
    safeCall(() => this._patternCache.shutdown(), 'DeepeningNotifier', 'shutdown-patternCache');
    super._onShutdown();
  }
}

module.exports = DeepeningNotifier;
