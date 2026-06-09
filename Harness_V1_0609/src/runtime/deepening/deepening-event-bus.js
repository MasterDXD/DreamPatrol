'use strict';
const DeepeningBase = require('./deepening-base');
const RingBuffer = require('../../utils/ring-buffer');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');
const { requireFunction_ } = require('../../utils/param-validator');
const { counterId, ID_PREFIXES } = require('../../utils/unique-id');
const { HarnessError } = require('../../errors');

/**
 * @module runtime/deepening/deepening-event-bus
 * 深化推理事件总线。发布/订阅事件总线，支持主题订阅、通配符模式、
 * 优先级投递、拦截器、死信收集及异步处理器执行。
 * @deprecated 请使用 runtime/infrastructure/event-bus 中的 EventBus 替代
 */

/**
 * 深化推理事件总线 — 深化子系统的发布/订阅事件总线。
 * 支持基于主题的订阅与通配符模式、优先级排序投递、
 * 发布前拦截器过滤、失败处理器的死信收集、
 * 以及带订阅上限背压控制的异步处理器执行。
 *
 * @classdesc 深化事件总线。发布/订阅、事件过滤、优先级排序
 * @extends DeepeningBase
 * @deprecated 请使用 runtime/infrastructure/event-bus 中的 EventBus 替代
 * @emits 'subscribed' 当新订阅创建时触发，附带 { id, topic }
 * @emits 'published' 当事件发布完成时触发，附带 { topic, delivered }
 * @emits 'interceptor-error' 当拦截器抛出异常时触发
 * @emits 'handler-error' 当事件处理器抛出异常时触发
 */
class DeepeningEventBus extends DeepeningBase {
  /**
   * 创建 DeepeningEventBus 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxDeadLetters=100] - 死信队列最大容量
   * @param {number} [options.maxInterceptors=50] - 最大拦截器数量
   * @param {number} [options.maxSubscriptions=500] - 最大订阅数量
   */
  constructor(options) {
    super(options);
    DeepeningEventBus._warnDeprecated('DeepeningEventBus', 'EventBus from runtime/infrastructure/event-bus', 'deepening-event-bus');
    this._subscriptions = new Map();
    this._maxDeadLetters = (options && options.maxDeadLetters) ?? 100;
    this._deadLetters = new RingBuffer(this._maxDeadLetters);
    this._maxInterceptors = (options && options.maxInterceptors) ?? 50;
    this._maxSubscriptions = (options && options.maxSubscriptions) ?? 500;
    this._interceptors = [];
    this._totalPublished = 0;
    this._totalDelivered = 0;
    this._wildcardSubs = 0;
    this._topicSet = new Set();
  }

  /**
   * 订阅主题。支持通配符（'*' 匹配所有主题，'prefix.*' 匹配前缀）。
   * @param {string} topic - 主题名称，支持 '*' 和 'prefix.*' 通配符
   * @param {Function} handler - 事件处理函数，签名 (event) => void|Promise
   * @param {Object} [options] - 订阅选项
   * @param {number} [options.priority=0] - 处理器优先级，数值越小优先级越高
   * @param {Function} [options.filter] - 事件过滤函数，签名 (event) => boolean
   * @returns {string} 订阅标识 ID
   * @throws {HarnessError} 主题为空时抛出
   * @emits 'subscribed'
   */
  subscribe(topic, handler, options) {
    this.guardShutdown();
    if (!topic) throw new HarnessError('EVENT_BUS_ERROR', 'Topic is required');
    requireFunction_(handler, 'Handler');
    const opts = options ?? {};
    const id = counterId(ID_PREFIXES.DEEPENING_SUB);
    this._subscriptions.set(id, { id, topic, handler, priority: opts.priority ?? 0, filter: opts.filter });
    this._topicSet.add(topic);
    if (topic === '*') this._wildcardSubs++;
    if (this._subscriptions.size > this._maxSubscriptions) {
      const oldest = this._subscriptions.keys().next().value;
      if (oldest !== undefined) {
        const sub = this._subscriptions.get(oldest);
        if (sub && sub.topic === '*') this._wildcardSubs--;
        this._subscriptions.delete(oldest);
      }
    }
    this.emit('subscribed', { id, topic });
    return id;
  }

  /**
   * 一次性订阅主题。触发一次后自动取消订阅。
   * @param {string} topic - 主题名称
   * @param {Function} handler - 事件处理函数
   * @returns {string} 订阅标识 ID
   */
  subscribeOnce(topic, handler) {
    const id = this.subscribe(topic, (data) => { this.unsubscribe(id); return handler(data); });
    return id;
  }

  /**
   * 取消订阅。
   * @param {string} subId - 订阅标识 ID
   * @returns {boolean} 是否成功取消
   */
  unsubscribe(subId) {
    this.guardShutdown();
    const sub = this._subscriptions.get(subId);
    if (!sub) return false;
    this._subscriptions.delete(subId);
    if (sub.topic === '*') this._wildcardSubs--;
    let topicStillExists = false;
    for (const [, s] of this._subscriptions) { if (s.topic === sub.topic) { topicStillExists = true; break; } }
    if (!topicStillExists) this._topicSet.delete(sub.topic);
    return true;
  }

  /**
   * 异步发布事件。先经过拦截器过滤，再按优先级顺序分发给匹配的订阅者。
   * 异步处理器失败时将事件移入死信队列。
   * @param {string} topic - 主题名称
   * @param {*} data - 事件数据
   * @returns {Promise<number>} 成功投递的订阅者数量
   * @throws {HarnessError} 主题为空时抛出
   * @emits 'published'
   * @emits 'interceptor-error' 当拦截器异常时
   * @emits 'handler-error' 当处理器异常时
   */
  _collectMatchingSubscriptions(topic, event) {
    const matching = [];
    for (const [, sub] of this._subscriptions) {
      if (this._matchesTopic(sub.topic, topic)) {
        if (sub.filter && !sub.filter(event)) continue;
        matching.push(sub);
      }
    }
    matching.sort((a, b) => a.priority - b.priority);
    return matching;
  }

  _dispatchSync(sub, event) {
    try {
      const result = sub.handler(event);
      if (result && typeof result.then === 'function') {
        return { async: true, promise: result };
      }
      return { async: false, delivered: 1 };
    } catch (hErr) {
      this._deadLetters.push({ ...event, error: hErr && hErr.message ? hErr.message : String(hErr) });
      debug('DeepeningEventBus', 'handler', hErr);
      emitError(this, 'handler-error', hErr, { topic: event.topic, subscriptionId: sub.id });
      return { async: false, delivered: 0 };
    }
  }

  /**
   * 发布事件到指定主题。先经过拦截器过滤，再按优先级顺序分发给匹配的订阅者。
   * 异步处理器失败时将事件移入死信队列。
   * @param {string} topic - 主题名称
   * @param {*} data - 事件数据
   * @returns {Promise<number>} 成功投递的订阅者数量
   * @throws {HarnessError} 主题为空时抛出
   * @emits 'published'
   * @emits 'interceptor-error' 当拦截器异常时
   * @emits 'handler-error' 当处理器异常时
   */
  async publish(topic, data) {
    this.guardShutdown();
    if (!topic) throw new HarnessError('EVENT_BUS_ERROR', 'Topic is required');
    const event = { topic, data, timestamp: Date.now() };
    for (const fn of this._interceptors) {
      try {
        const allowed = fn(event);
        if (allowed === false) return 0;
      } catch (iErr) { debug('DeepeningEventBus', 'interceptor', iErr); emitError(this, 'interceptor-error', iErr, { topic }); }
    }
    let matching;
    try {
      matching = this._collectMatchingSubscriptions(topic, event);
    } catch (err) {
      debug('DeepeningEventBus', 'collectSubscriptions', err && err.message ? err.message : String(err));
      return 0;
    }
    let delivered = 0;
    const asyncResults = [];
    for (const sub of matching) {
      const dispatch = this._dispatchSync(sub, event);
      if (dispatch.async) {
        asyncResults.push(dispatch.promise.then(() => {
          delivered++;
        }).catch(err => {
          if (this._shutDown) return;
          this._deadLetters.push({ ...event, error: err && err.message ? err.message : String(err) });
          debug('DeepeningEventBus', 'asyncHandler', err && err.message ? err.message : String(err));
          emitError(this, 'handler-error', err, { topic, subscriptionId: sub.id });
        }));
      } else {
        delivered += dispatch.delivered;
      }
    }
    if (asyncResults.length > 0) {
      const settled = await Promise.allSettled(asyncResults);
      if (this._shutDown) return 0;
      for (const r of settled) {
        if (r.status === 'rejected' && r.reason) {
          debug('DeepeningEventBus', 'asyncSettled', r.reason && r.reason.message ? r.reason.message : String(r.reason));
        }
      }
    }
    this._totalPublished++;
    this._totalDelivered += delivered;
    this.emit('published', { topic, delivered });
    return delivered;
  }

  /**
   * 判断主题模式是否匹配目标主题。支持 '*' 全匹配和 'prefix.*' 前缀匹配。
   * @param {string} pattern - 主题模式
   * @param {string} topic - 目标主题
   * @returns {boolean} 是否匹配
   * @private
   */
  _matchesTopic(pattern, topic) {
    if (pattern === '*') return true;
    if (pattern === topic) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1);
      return topic.startsWith(prefix) && topic.length > prefix.length;
    }
    return false;
  }

  /**
   * 获取订阅者数量。可按主题过滤。
   * @param {string} [topic] - 主题名称，不指定时返回总订阅数
   * @returns {number} 订阅者数量
   */
  getSubscriberCount(topic) {
    if (!topic) {
      return this._subscriptions.size;
    }
    let count = 0;
    for (const [, sub] of this._subscriptions) { if (this._matchesTopic(sub.topic, topic)) count++; }
    return count;
  }

  /**
   * 获取死信队列中的所有事件。
   * @returns {Object[]} 死信事件数组
   */
  getDeadLetters() { return this._deadLetters.toArray().slice(); }

  /**
   * 清空死信队列。
   * @returns {number} 被清除的死信数量
   */
  clearDeadLetters() { const count = this._deadLetters.size; this._deadLetters.clear(); return count; }

  /**
   * 添加发布前拦截器。拦截器返回 false 时阻止事件发布。
   * @param {Function} fn - 拦截器函数，签名 (event) => boolean|undefined
   * @returns {boolean} 添加是否成功，达到上限时返回 false
   */
  addInterceptor(fn) {
    this.guardShutdown();
    requireFunction_(fn, 'Interceptor');
    if (this._interceptors.length >= this._maxInterceptors) return false;
    this._interceptors.push(fn);
    return true;
  }

  /**
   * 移除拦截器。
   * @param {Function} fn - 要移除的拦截器函数引用
   * @returns {boolean} 操作结果
   */
  removeInterceptor(fn) { this.guardShutdown(); const i = this._interceptors.indexOf(fn); if (i >= 0) this._interceptors.splice(i, 1); return true; }

  /**
   * 获取所有主题名称。
   * @returns {string[]} 主题名称数组
   */
  getTopicNames() { return Array.from(this._topicSet); }

  /**
   * 获取事件总线运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalSubscriptions - 当前订阅总数
   * @returns {number} return.totalTopics - 主题总数
   * @returns {number} return.totalPublished - 累计发布事件数
   * @returns {number} return.totalDelivered - 累计投递数
   * @returns {number} return.wildcardSubs - 通配符订阅数
   * @returns {number} return.deadLetters - 死信队列当前大小
   * @returns {number} return.interceptorCount - 拦截器数量
   */
  getStats() {
    return {
      ...super.getStats(),
      totalSubscriptions: this._subscriptions.size,
      totalTopics: this._topicSet.size,
      totalPublished: this._totalPublished,
      totalDelivered: this._totalDelivered,
      wildcardSubs: this._wildcardSubs,
      deadLetters: this._deadLetters.size,
      interceptorCount: this._interceptors.length,
    };
  }

  /**
   * 关闭时的清理回调。清空所有订阅、主题、拦截器和死信队列。
   * @protected
   */
  _onShutdown() {
    this._subscriptions.clear();
    this._topicSet.clear();
    this._interceptors = [];
    this._deadLetters.clear();
    this._totalPublished = 0;
    this._totalDelivered = 0;
    this._wildcardSubs = 0;
    super._onShutdown();
  }
}

module.exports = DeepeningEventBus;
