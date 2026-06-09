'use strict';

const { DEFAULT_DEBOUNCE_MS } = require('./constants');
const { debug } = require('./debug-logger');
const { withShutdown } = require('./shutdown-mixin');

/**
 * @module utils/keyed-debouncer
 * KeyedDebouncer — 键控防抖器
 * 按键管理的防抖调度器，每个键独立维护定时器。支持立即执行、
 * 按键刷新、批量冲刷和取消。适用于高频事件场景下的批量持久化和延迟提交。
 * @classdesc 键控防抖器。按键防抖、批量执行
 */
class KeyedDebouncer {
  /**
   * 创建键控防抖器实例
   * @param {Object} [options] - 配置选项
   * @param {number} [options.debounceMs] - 防抖延迟毫秒数
   * @param {string} [options.label] - 调试日志标签
   */
  constructor(options) {
    this._debounceMs = typeof (options && options.debounceMs) === 'number' && Number.isFinite(options.debounceMs) && options.debounceMs > 0 ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
    this._label = (options && options.label) || 'KeyedDebouncer';
    this._timers = new Map();
  }

  /**
   * 调度按键防抖回调，immediate为true时立即执行
   * @param {string} key - 防抖键
   * @param {Function} callback - 回调函数
   * @param {boolean} [immediate=false] - 是否立即执行
   * @example
   * const debouncer = new KeyedDebouncer({ debounceMs: 200 });
   * debouncer.schedule('save', () => persistData());
   * debouncer.schedule('log', () => console.log('immediate'), true);
   */
  schedule(key, callback, immediate) {
    this.guardShutdown();
    if (this._timers.has(key)) {
      clearTimeout(this._timers.get(key).timer);
      this._timers.delete(key);
    }
    if (immediate) {
      try {
        callback();
      } catch (err) {
        debug(this._label, 'schedule:immediate', err);
      }
      return;
    }
    const timer = setTimeout(() => {
      this._timers.delete(key);
      try {
        callback();
      } catch (err) {
        debug(this._label, 'schedule:callback', err);
      }
    }, this._debounceMs);
    this._timers.set(key, { timer, callback });
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /**
   * 冲刷所有待执行的防抖回调
   * @param {Function} keyCallbackProvider - 根据键获取回调的函数
   */
  flush(keyCallbackProvider) {
    this.guardShutdown();
    for (const [key, entry] of this._timers) {
      clearTimeout(entry.timer);
      try {
        const cb = entry.callback || (keyCallbackProvider ? keyCallbackProvider(key) : null);
        if (cb) cb();
      } catch (err) {
        debug(this._label, 'flush', err);
      }
    }
    this._timers.clear();
  }

  /**
   * 取消指定键的防抖定时器
   * @param {string} key - 防抖键
   */
  delete(key) {
    this.guardShutdown();
    if (this._timers.has(key)) {
      clearTimeout(this._timers.get(key).timer);
      this._timers.delete(key);
    }
  }

  /**
   * 取消所有防抖定时器
   */
  clear() {
    this.guardShutdown();
    this._timers.forEach((entry) => {
      if (entry && entry.timer) clearTimeout(entry.timer);
    });
    this._timers.clear();
  }

  /**
   * 检查指定键是否有待执行的防抖定时器
   * @param {string} key - 防抖键
   * @returns {boolean} 是否存在待执行的定时器
   */
  has(key) {
    return this._timers.has(key);
  }

  /**
   * 获取待执行的防抖定时器数量
   * @returns {number} 定时器数量
   */
  get size() {
    return this._timers.size;
  }

  _onShutdown() {
    this._timers.forEach((entry) => {
      if (entry && entry.timer) clearTimeout(entry.timer);
    });
    this._timers.clear();
  }
}

module.exports = withShutdown(KeyedDebouncer);
