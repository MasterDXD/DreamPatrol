'use strict';

const EventEmitter = require('events');
const BoundedArray = require('../../utils/bounded-array');
const { debug } = require('../../utils/debug-logger');
const { HarnessError } = require('../../errors');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { DEFAULT_REQUEST_TIMEOUT_MS } = require('../../utils/constants');
const deepClone = require('../../utils/deep-clone');
const safeAssign = require('../../utils/safe-assign');

/**
 * @module runtime/infrastructure/event-bus
 * Central event bus for inter-module communication.
 * Provides middleware interception, event history, and graceful shutdown.
 * @classdesc 事件总线。发布/订阅、事件过滤、优先级排序
 *
 * @class EventBus
 * @extends {EventEmitter}
 * @param {object} [options] - Configuration options
 * @param {number} [options.maxListeners=50] - Maximum number of listeners per event
 * @param {number} [options.maxHistory=1000] - Maximum number of events stored in history
 * @param {number} [options.maxMiddleware=50] - Maximum number of middleware functions
 */
class EventBus extends EventEmitter {
  /**
   * 创建 EventBus 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxListeners=50] - 每个事件的最大监听器数量
   * @param {number} [options.maxHistory=1000] - 事件历史记录最大条数
   * @param {number} [options.maxMiddleware=50] - 最大中间件函数数量
   * @param {number} [options.maxPendingOnceAsync=1000] - 未结算的 onceAsync Promise 最大数量
   */
  constructor(options) {
    super();
    this._maxListeners = (options && options.maxListeners) ?? 50;
    this.setMaxListeners(this._maxListeners);
    this._history = new BoundedArray((options && options.maxHistory) ?? 1000);
    this._middleware = [];
    this._maxMiddleware = (options && options.maxMiddleware) ?? 50;
    /** 活跃 onceAsync 超时定时器集合，关闭时批量清理 */
    this._onceAsyncTimers = new Set();
    /** 未结算的 onceAsync Promise 控制器，关闭时统一 reject */
    this._pendingOnceAsync = new Set();
    this._maxPendingOnceAsync = (options && options.maxPendingOnceAsync) ?? 1000;
  }

  /**
   * 注册中间件函数，事件发射时按注册顺序依次调用。超过最大中间件数量时抛出错误。
   * @param {Function} fn - 中间件函数，签名为 (event: string, data: *) => void
   * @returns {EventBus} 返回 this 以支持链式调用
   */
  use(fn) {
    this.guardShutdown();
    if (this._middleware.length >= this._maxMiddleware) {
      throw new HarnessError('CAPACITY_EXCEEDED', 'Middleware limit reached (' + this._maxMiddleware + ')');
    }
    this._middleware.push(fn);
    return this;
  }

  /**
   * 发射事件，依次经过中间件处理后分发给所有监听器。事件数据为对象时进行浅拷贝后存入历史。
   * @param {string} event - 事件名称
   * @param {*} data - 事件数据
   * @returns {boolean} 是否有监听器被调用（包括出错的情况）
   */
  emit(event, data) {
    if (event !== 'shutdown') this.guardShutdown();
    let historyData = data;
    if (data !== null && typeof data === 'object') {
      try {
        historyData = deepClone(data);
      } catch (_e) {
        historyData = Array.isArray(data) ? [...data] : safeAssign({}, data);
      }
    }
    this._history.push({ event, data: historyData, timestamp: Date.now() });

    for (const mw of this._middleware) {
      try {
        mw(event, data);
      } catch (err) {
        debug('EventBus', 'middleware-error:' + event, err);
        super.emit('middleware-error', { originalEvent: event, error: err, middleware: mw.name || 'anonymous' });
      }
    }

    const listeners = this.listeners(event);
    let emitted = false;
    for (const listener of listeners) {
      try {
        listener(data);
        emitted = true;
      } catch (err) {
        debug('EventBus', 'listener-error:' + event, err);
        if (event !== 'listener-error') {
          super.emit('listener-error', { originalEvent: event, error: err, listener: listener.name || 'anonymous' });
        }
        emitted = true;
      }
    }
    return emitted;
  }

  /**
   * 获取事件历史记录。可按事件名称过滤。
   * @param {string} [eventFilter] - 事件名称过滤器，提供时仅返回匹配该名称的历史条目
   * @returns {Array<{event: string, data: *, timestamp: number}>} 历史记录数组
   */
  getHistory(eventFilter) {
    if (!eventFilter) return this._history.toArray().slice();
    return this._history.filter(e => e.event === eventFilter);
  }

  /**
   * 清空所有事件历史记录。
   * @returns {void}
   */
  clearHistory() {
    this._history.clear();
  }

  /**
   * 异步等待事件触发一次，支持超时机制。超时为0时立即返回，未指定超时时使用默认请求超时。
   * @param {string} event - 要等待的事件名称
   * @param {number} [timeoutMs] - 超时时间（毫秒），0表示立即返回
   * @returns {Promise<{timedOut: boolean, data: *}>} 事件数据对象，timedOut 为 false 表示正常收到事件
   * @throws {Error} 超时时抛出错误
   */
  onceAsync(event, timeoutMs) {
    this.guardShutdown();
    if (timeoutMs === 0) {
      return Promise.resolve({ timedOut: false, data: undefined });
    }
    if (this._pendingOnceAsync.size >= this._maxPendingOnceAsync) {
      return Promise.reject(new HarnessError('CAPACITY_EXCEEDED', 'Too many pending onceAsync calls (' + this._maxPendingOnceAsync + ')'));
    }
    const effectiveTimeout = timeoutMs != null ? Math.max(1, timeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS;
    const bus = this;
    return new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;
      const pending = { resolve, reject };
      bus._pendingOnceAsync.add(pending);
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        bus._pendingOnceAsync.delete(pending);
        fn(arg);
      };
      const handler = (data) => {
        if (timer) { clearTimeout(timer); bus._onceAsyncTimers.delete(timer); }
        settle(resolve, { timedOut: false, data: data });
      };
      this.once(event, handler);
      timer = setTimeout(() => {
        bus._onceAsyncTimers.delete(timer);
        this.removeListener(event, handler);
        if (!settled) {
          if (bus._shutDown) {
            settle(resolve, { timedOut: true, data: undefined });
          } else {
            settle(reject, new Error('Event "' + event + '" timed out after ' + effectiveTimeout + 'ms'));
          }
        }
      }, effectiveTimeout);
      bus._onceAsyncTimers.add(timer);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  _onShutdown() {
    for (const t of this._onceAsyncTimers) {
      clearTimeout(t);
    }
    this._onceAsyncTimers.clear();
    for (const pending of this._pendingOnceAsync) {
      pending.reject(new Error('EventBus shutdown: onceAsync promise will never settle'));
    }
    this._pendingOnceAsync.clear();
    this._history.clear();
    this._middleware = [];
    this.removeAllListeners();
  }

  /**
   * 创建带前缀的事件命名空间，返回一个代理对象，其所有方法自动为事件名添加前缀。
   * @param {string} prefix - 事件名前缀，为空或非字符串时返回 this
   * @returns {{emit: Function, on: Function, once: Function, off: Function, onceAsync: Function, removeAllListeners: Function, getPrefix: Function}} 命名空间代理对象
   */
  createNamespace(prefix) {
    if (!prefix || typeof prefix !== 'string') return this;
    const self = this;
    return {
      emit(event, data) {
        return self.emit(prefix + ':' + event, data);
      },
      on(event, handler) {
        return self.on(prefix + ':' + event, handler);
      },
      once(event, handler) {
        return self.once(prefix + ':' + event, handler);
      },
      off(event, handler) {
        return self.off(prefix + ':' + event, handler);
      },
      onceAsync(event, timeoutMs) {
        return self.onceAsync(prefix + ':' + event, timeoutMs);
      },
      removeAllListeners(event) {
        if (event) return self.removeAllListeners(prefix + ':' + event);
        const events = self.eventNames().filter(e => typeof e === 'string' && e.startsWith(prefix + ':'));
        for (const e of events) self.removeAllListeners(e);
        return self;
      },
      getPrefix() {
        return prefix;
      },
    };
  }
}

EventBus = withShutdown(EventBus);

EventBus.DEFAULT_MAX_HISTORY = 1000;

module.exports = EventBus;
