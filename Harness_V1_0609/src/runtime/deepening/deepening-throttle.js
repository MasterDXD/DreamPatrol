'use strict';

/**
 * @module runtime/deepening/deepening-throttle
 * 深化推理按键限流机制。使用滑动窗口计数器强制执行可配置的每键速率限制，
 * 自动过期陈旧条目，发出 throttled/acquired/released 事件，维护获取和限流的聚合统计。
 */

const DeepeningBase = require('./deepening-base');
const { MS_PER_SECOND } = require('../../utils/constants');
const { ensurePositiveNumber } = require('../../utils/param-validator');

/**
 * 默认限流间隔（10秒）
 * @constant {number}
 */
const DEFAULT_THROTTLE_INTERVAL_MS = 10 * MS_PER_SECOND;

/**
 * 限流键最大数量
 * @constant {number}
 */
const MAX_THROTTLE_KEYS = 10000;

/**
 * @classdesc 深化节流器。请求节流、滑动窗口、令牌桶
 *
 * 深化推理按键限流机制。使用滑动窗口计数器强制执行可配置的每键速率限制，
 * 自动过期陈旧条目，发出 throttled/acquired/released 事件，
 * 维护获取和限流的聚合统计。
 * @extends DeepeningBase
 */
class DeepeningThrottle extends DeepeningBase {

  /**
   * 创建 DeepeningThrottle 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.limit=10] - 每键速率限制
   * @param {number} [options.interval] - 限流间隔毫秒数，默认10秒
   */
  constructor(options) {
    super(options);
    this._limit = (options && options.limit) ?? 10;
    this._interval = ensurePositiveNumber((options && options.interval), DEFAULT_THROTTLE_INTERVAL_MS);
    this._counts = new Map();
    this._timestamps = new Map();
    this._totalAcquired = 0;
    this._totalThrottled = 0;
  }

  /**
   * 获取限流许可。在限制内递增计数，超出限制时拒绝并发出事件。
   * 自动清理过期条目和超出键数量上限的条目。
   * @param {string} [key='default'] - 限流键
   * @returns {boolean} 获取成功返回 true，被限流返回 false
   * @emits 'throttled' 当请求被限流时触发
   * @emits 'acquired' 当成功获取许可时触发
   */
  acquire(key) {
    this.guardShutdown();
    const k = key ?? 'default';
    const now = Date.now();
    const expiredKeys = [];
    for (const [tk, ts] of this._timestamps) {
      if (now - ts > this._interval * 2) expiredKeys.push(tk);
    }
    for (const tk of expiredKeys) {
      this._counts.delete(tk);
      this._timestamps.delete(tk);
    }
    if (this._counts.size >= MAX_THROTTLE_KEYS) {
      const oldestKey = this._timestamps.keys().next().value;
      if (oldestKey) {
        this._counts.delete(oldestKey);
        this._timestamps.delete(oldestKey);
      }
    }
    const lastTs = this._timestamps.get(k);
    if (lastTs && (now - lastTs > this._interval)) {
      this._counts.set(k, 0);
    }
    const count = this._counts.get(k) ?? 0;
    if (count >= this._limit) { this.emit('throttled', { key: k }); this._totalThrottled++; return false; }
    this._counts.set(k, count + 1);
    this._timestamps.set(k, now);
    this._totalAcquired++;
    this.emit('acquired', { key: k });
    return true;
  }

  /**
   * 释放限流许可。递减指定键的计数。
   * @param {string} [key='default'] - 限流键
   * @returns {boolean} 始终返回 true
   * @emits 'released' 当许可释放时触发
   */
  release(key) {
    const k = key ?? 'default';
    const count = this._counts.get(k) ?? 0;
    if (count > 0) this._counts.set(k, count - 1);
    this.emit('released', { key: k });
    return true;
  }

  /**
   * 获取指定键的当前计数。
   * @param {string} [key='default'] - 限流键
   * @returns {number} 当前计数
   */
  getCount(key) { return this._counts.get(key ?? 'default') ?? 0; }

  /**
   * 获取指定键的剩余可用次数。
   * @param {string} [key='default'] - 限流键
   * @returns {number} 剩余可用次数
   */
  getRemaining(key) { return Math.max(0, this._limit - this.getCount(key)); }

  /**
   * 检查指定键是否被限流。
   * @param {string} [key='default'] - 限流键
   * @returns {boolean} 被限流返回 true
   */
  isThrottled(key) { return this.getCount(key) >= this._limit; }

  /**
   * 重置指定键的限流计数。
   * @param {string} [key='default'] - 限流键
   * @returns {boolean} 始终返回 true
   */
  resetKey(key) { this.guardShutdown(); this._counts.delete(key ?? 'default'); return true; }

  /**
   * 重置所有键的限流计数。
   * @returns {boolean} 始终返回 true
   */
  resetAll() { this.guardShutdown(); this._counts.clear(); return true; }

  /**
   * 重置限流计数。指定键时重置该键，否则重置所有。
   * @param {string} [key] - 限流键，省略则重置所有
   * @returns {boolean} 始终返回 true
   */
  reset(key) { if (key) return this.resetKey(key); return this.resetAll(); }

  /**
   * 获取限流器统计信息。
   * @returns {Object} 统计对象，包含 limit、interval、activeKeys、totalAcquired、totalThrottled、keys
   */
  getStats() {
    const keys = [];
    for (const [key, count] of this._counts) keys.push({ key, count });
    return { limit: this._limit, interval: this._interval, activeKeys: this._counts.size, totalAcquired: this._totalAcquired, totalThrottled: this._totalThrottled, keys, ...super.getStats() };
  }

  /**
   * 关闭时清理所有计数和时间戳。
   * @protected
   */
  _onShutdown() {
    this._counts.clear();
    this._timestamps.clear();
    super._onShutdown();
  }

  /**
   * 健康检查。关闭后返回 false，否则返回 true。
   * @returns {boolean} 未关闭时返回 true
   */
  isHealthy() { return !this._shutDown; }
}

module.exports = DeepeningThrottle;
