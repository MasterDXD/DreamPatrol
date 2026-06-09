'use strict';

/**
 * @module runtime/deepening/deepening-timeout-manager
 * 深化推理超时生命周期管理器。创建具名超时并设置截止时间和可配置默认时长，
 * 追踪创建/完成/取消事件，支持批量取消，提供 wrap 工具自动管理同步和异步函数的超时生命周期。
 */

const DeepeningBase = require('./deepening-base');
const { requireString_, requireFunction_, ensurePositiveNumber, ensureSafeTimeout } = require('../../utils/param-validator');
const { counterId, ID_PREFIXES } = require('../../utils/unique-id');
const { DEFAULT_REQUEST_TIMEOUT_MS } = require('../../utils/constants');

/**
 * @classdesc 深化超时管理器。超时设置、超时回调、超时链
 *
 * 深化推理超时生命周期管理器。创建具名超时并设置截止时间和可配置默认时长，
 * 追踪创建/完成/取消事件，支持批量取消，提供 wrap 工具自动管理同步和异步函数的超时生命周期。
 * @extends DeepeningBase
 */
class DeepeningTimeoutManager extends DeepeningBase {

  /**
   * 创建 DeepeningTimeoutManager 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.defaultTimeout] - 默认超时时长毫秒数
   */
  constructor(options) {
    super(options);
    this._timeouts = new Map();
    this._maxTimeouts = 1000;
    this._defaultTimeout = ensurePositiveNumber((options && options.defaultTimeout), DEFAULT_REQUEST_TIMEOUT_MS);
    this._totalCreated = 0;
    this._totalCompleted = 0;
  }

  /**
   * 创建具名超时。设置截止时间，超时后自动触发回调并发出事件。
   * @param {string} name - 超时名称
   * @param {Object} [options] - 超时配置
   * @param {number} [options.duration] - 超时时长毫秒数，默认使用 defaultTimeout
   * @param {Function} [options.onTimeout] - 超时回调函数
   * @returns {string} 超时ID
   * @emits 'created' 当超时创建时触发
   * @emits 'expired' 当超时到期时触发
   */
  setTimeout(name, options) {
    this.guardShutdown();
    requireString_(name, 'Timeout name');
    const opts = options ?? {};
    const id = counterId(ID_PREFIXES.DEEPENING_TIMEOUT);
    const duration = ensureSafeTimeout(ensurePositiveNumber(opts.duration, this._defaultTimeout), this._defaultTimeout);
    const deadline = Date.now() + duration;
    const timerId = global.setTimeout(() => {
      if (this._shutDown) return;
      this._timeouts.delete(id);
      if (opts.onTimeout) opts.onTimeout();
      this.emit('expired', { id, name });
    }, duration);
    if (timerId && typeof timerId.unref === 'function') timerId.unref();
    if (this._timeouts.size >= this._maxTimeouts && !this._timeouts.has(id)) {
      const oldest = this._timeouts.keys().next().value;
      const oldT = this._timeouts.get(oldest);
      if (oldT) global.clearTimeout(oldT.timerId);
      this._timeouts.delete(oldest);
    }
    this._timeouts.set(id, { id, name, deadline, timerId, onTimeout: opts.onTimeout, duration });
    this._totalCreated++;
    this.emit('created', { name, duration });
    return id;
  }

  /**
   * 取消指定超时。清除定时器并从跟踪映射中移除。
   * @param {string} id - 超时ID
   * @returns {boolean} 取消成功返回 true，超时不存在返回 false
   * @emits 'cancelled' 当超时取消时触发
   */
  cancel(id) {
    this.guardShutdown();
    const t = this._timeouts.get(id);
    if (!t) return false;
    global.clearTimeout(t.timerId);
    this._timeouts.delete(id);
    this.emit('cancelled', { id });
    return true;
  }

  /**
   * 标记超时完成。清除定时器，记录耗时并发出完成事件。
   * @param {string} id - 超时ID
   * @returns {boolean} 完成成功返回 true，超时不存在返回 false
   * @emits 'completed' 当超时完成时触发
   */
  complete(id) {
    const t = this._timeouts.get(id);
    if (!t) return false;
    const elapsed = Date.now() - (t.deadline - t.duration);
    global.clearTimeout(t.timerId);
    this._timeouts.delete(id);
    this._totalCompleted++;
    this.emit('completed', { name: t.name, elapsed });
    return true;
  }

  /**
   * 获取指定超时的剩余时间。
   * @param {string} id - 超时ID
   * @returns {number} 剩余毫秒数，超时不存在返回 0
   */
  getRemaining(id) { const t = this._timeouts.get(id); return t ? Math.max(0, t.deadline - Date.now()) : 0; }

  /**
   * 获取指定超时的截止时间。
   * @param {string} id - 超时ID
   * @returns {number|null} 截止时间戳，超时不存在返回 null
   */
  getDeadline(id) { const t = this._timeouts.get(id); return t ? t.deadline : null; }

  /**
   * 获取指定超时的详细信息。
   * @param {string} id - 超时ID
   * @returns {Object|null} 超时信息对象，包含 id、name、state、remaining；不存在返回 null
   */
  getInfo(id) {
    const t = this._timeouts.get(id);
    if (!t) return null;
    return { id: t.id, name: t.name, state: 'running', remaining: Math.max(0, t.deadline - Date.now()) };
  }

  /**
   * 获取所有活跃超时列表，按截止时间排序。
   * @returns {Object[]} 活跃超时数组，每项包含 id、name、deadline
   */
  getActive() { return Array.from(this._timeouts.values()).sort((a, b) => a.deadline - b.deadline).map(t => ({ id: t.id, name: t.name, deadline: t.deadline })); }

  /**
   * 获取活跃超时数量。
   * @returns {number} 活跃超时数量
   */
  getActiveCount() { return this._timeouts.size; }

  /**
   * 取消所有活跃超时。
   * @returns {number} 取消的超时数量
   * @emits 'cancelledAll' 当批量取消时触发
   */
  cancelAll() {
    this.guardShutdown();
    const count = this._timeouts.size;
    for (const [, t] of this._timeouts) global.clearTimeout(t.timerId);
    this._timeouts.clear();
    this.emit('cancelledAll', { count });
    return count;
  }

  /**
   * 包装函数，自动管理超时生命周期。支持同步和异步函数，
   * 成功时自动完成超时，异常时自动取消超时。
   * @param {Function} fn - 要包装的函数
   * @param {Object} [options] - 超时配置，传递给 setTimeout
   * @returns {Function} 包装后的函数
   */
  wrap(fn, options) {
    requireFunction_(fn, 'fn');
    const self = this;
    return function() {
      const id = self.setTimeout('wrapped', options ?? {});
      let result;
      try {
        result = fn.apply(this, arguments);
      } catch (syncErr) {
        self.cancel(id);
        throw syncErr;
      }
      if (result && typeof result.then === 'function') { return result.then(r => { self.complete(id); return r; }).catch(e => { self.cancel(id); throw e; }); }
      self.complete(id);
      return result;
    };
  }

  /**
   * 获取超时管理器统计信息。
   * @returns {Object} 统计对象，包含 totalCreated、totalCompleted、completionRate、defaultTimeout、activeTimeouts
   */
  getStats() {
    const completionRate = this._totalCreated > 0 ? ((this._totalCompleted / this._totalCreated) * 100).toFixed(1) : '0.0';
    return { totalCreated: this._totalCreated, totalCompleted: this._totalCompleted, completionRate, defaultTimeout: this._defaultTimeout, activeTimeouts: this._timeouts.size, ...super.getStats() };
  }

  /**
   * 关闭时清理所有活跃超时。
   * @protected
   */
  _onShutdown() {
    for (const [, t] of this._timeouts) global.clearTimeout(t.timerId);
    this._timeouts.clear();
    super._onShutdown();
  }
}

module.exports = DeepeningTimeoutManager;
