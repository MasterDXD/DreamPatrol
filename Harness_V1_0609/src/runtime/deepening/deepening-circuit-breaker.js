'use strict';
const DeepeningBase = require('./deepening-base');
const { requireString_, requireFunction_, ensurePositiveNumber } = require('../../utils/param-validator');
const { HarnessError } = require('../../errors');
const { debug } = require('../../utils/debug-logger');

/**
 * @module runtime/deepening/deepening-circuit-breaker
 * 深化推理熔断器。实现熔断器模式，为深化执行提供容错保护。
 * 管理命名熔断器的 Closed → Open → Half-Open 状态转换，支持自动恢复、强制状态覆盖和安全异步执行包装。
 */

/**
 * @classdesc 深化推理熔断器 — 深化执行的容错熔断器模式实现。
 * 管理命名熔断器的 Closed → Open → Half-Open 状态转换，
 * 基于可配置的失败和成功阈值。支持通过重置超时自动恢复、
 * 强制状态覆盖、以及安全异步执行包装（记录执行结果并在失败超阈值时跳闸）。
 *
 * @extends DeepeningBase
 * @emits 'created' 当新熔断器创建时触发，附带 { name, state }
 * @emits 'removed' 当熔断器移除时触发，附带 { name }
 * @emits 'circuit-state-change' 当熔断器状态变更时触发，附带 { name, from, to }
 * @emits 'success' 当记录成功时触发，附带 { name }
 * @emits 'failure' 当记录失败时触发，附带 { name, failureCount }
 * @emits 'rejected' 当请求被熔断器拒绝时触发，附带 { name }
 */
class DeepeningCircuitBreaker extends DeepeningBase {
  /**
   * 熔断器状态枚举。
   * @constant
   * @type {Object}
   * @property {string} CLOSED - 关闭状态（正常通行）
   * @property {string} OPEN - 打开状态（熔断拒绝）
   * @property {string} HALF_OPEN - 半开状态（试探性放行）
   */
  static CIRCUIT_STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

  /**
   * 创建 DeepeningCircuitBreaker 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxCircuits=100] - 最大熔断器数量
   * @param {number} [options.failureThreshold=5] - 触发熔断的连续失败次数阈值
   * @param {number} [options.successThreshold=3] - 半开状态恢复到关闭所需的连续成功次数
   * @param {number} [options.resetTimeout=30000] - 熔断器从打开状态自动恢复的超时时间（毫秒）
   */
  constructor(options) {
    super(options);
    this._circuits = new Map();
    this._maxCircuits = typeof (options && options.maxCircuits) === 'number' && Number.isFinite(options.maxCircuits) && options.maxCircuits > 0 ? options.maxCircuits : 100;
    this._failureThreshold = typeof (options && options.failureThreshold) === 'number' && Number.isFinite(options.failureThreshold) && options.failureThreshold >= 0 ? options.failureThreshold : 5;
    this._successThreshold = typeof (options && options.successThreshold) === 'number' && Number.isFinite(options.successThreshold) && options.successThreshold >= 0 ? options.successThreshold : 3;
    this._resetTimeout = ensurePositiveNumber((options && options.resetTimeout), 30000);
    this._totalTripped = 0;
    this._stateCounts = { closed: 0, open: 0, half_open: 0 };
  }

  /**
   * 创建命名熔断器。若已存在则返回现有实例；若达到上限则淘汰关闭状态的熔断器。
   * @param {string} name - 熔断器名称
   * @param {Object} [options] - 熔断器配置
   * @param {number} [options.failureThreshold] - 该熔断器的失败阈值
   * @param {number} [options.successThreshold] - 该熔断器的成功阈值
   * @param {number} [options.resetTimeout] - 该熔断器的重置超时
   * @param {number} [options.maxHalfOpenCalls=1] - 半开状态最大允许的试探调用数
   * @returns {Object} 熔断器实例对象
   * @emits 'created'
   */
  create(name, options) {
    this.guardShutdown();
    requireString_(name, 'Circuit name');
    if (this._circuits.has(name)) return this._circuits.get(name);
    if (this._circuits.size >= this._maxCircuits) {
      let evicted = false;
      const toDelete = [];
      for (const [n, c] of this._circuits) {
        if (c.state === 'closed') { toDelete.push(n); this._stateCounts.closed--; evicted = true; break; }
      }
      for (const n of toDelete) {
        this._circuits.delete(n);
      }
      if (!evicted && this._circuits.size > 0) {
        const oldestKey = this._circuits.keys().next().value;
        const oldest = this._circuits.get(oldestKey);
        if (oldest) { this._stateCounts[oldest.state]--; this._circuits.delete(oldestKey); }
      }
    }
    const opts = options ?? {};
    const circuit = { name, state: 'closed', failures: 0, successes: 0, lastFailure: null, failureThreshold: opts.failureThreshold ?? this._failureThreshold, successThreshold: opts.successThreshold ?? this._successThreshold, resetTimeout: opts.resetTimeout ?? this._resetTimeout, halfOpenCalls: 0, maxHalfOpenCalls: opts.maxHalfOpenCalls ?? 1, failureCount: 0, totalSuccesses: 0, totalFailures: 0 };
    this._circuits.set(name, circuit);
    this._stateCounts.closed++;
    this.emit('created', { name, state: 'closed' });
    return { name: circuit.name, state: circuit.state, failures: circuit.failures, successes: circuit.successes, lastFailure: circuit.lastFailure, failureThreshold: circuit.failureThreshold, successThreshold: circuit.successThreshold, resetTimeout: circuit.resetTimeout, halfOpenCalls: circuit.halfOpenCalls, maxHalfOpenCalls: circuit.maxHalfOpenCalls, failureCount: circuit.failureCount, totalSuccesses: circuit.totalSuccesses, totalFailures: circuit.totalFailures };
  }

  /**
   * 移除命名熔断器。
   * @param {string} name - 熔断器名称
   * @returns {boolean} 是否成功移除
   * @emits 'removed'
   */
  remove(name) {
    this.guardShutdown();
    const c = this._circuits.get(name);
    if (!c) return false;
    this._stateCounts[c.state]--;
    this._circuits.delete(name);
    this.emit('removed', { name });
    return true;
  }

  /**
   * 创建熔断器的别名方法，等同于 create。
   * @param {string} name - 熔断器名称
   * @param {Object} [options] - 熔断器配置
   * @returns {Object} 熔断器实例对象
   * @throws {Error} When circuit name is not a string or already exists
   * @example
   * const breaker = new DeepeningCircuitBreaker();
   * const circuitId = breaker.createCircuit('api-calls', {
   *   failureThreshold: 5,
   *   resetTimeoutMs: 30000
   * });
   * breaker.recordSuccess(circuitId);
   * breaker.recordFailure(circuitId);
   * const state = breaker.getState(circuitId); // 'closed' | 'open' | 'half-open'
   */
  createCircuit(name, options) { return this.create(name, options); }

  /**
   * 内部状态转换方法，更新状态计数器。
   * @param {Object} c - 熔断器对象
   * @param {string} newState - 新状态
   * @private
   */
  _transitionState(c, newState) {
    if (c.state === newState) return;
    this._stateCounts[c.state] = Math.max(0, (this._stateCounts[c.state] ?? 0) - 1);
    this._stateCounts[newState] = (this._stateCounts[newState] ?? 0) + 1;
    c.state = newState;
  }

  /**
   * 变更熔断器状态并发出事件。
   * @param {Object} c - 熔断器对象
   * @param {string} newState - 新状态
   * @param {string} name - 熔断器名称
   * @emits 'circuit-state-change'
   * @private
   */
  _changeState(c, newState, name) {
    const from = c.state;
    this._transitionState(c, newState);
    this.emit('circuit-state-change', { name, from, to: newState });
  }

  /**
   * 获取命名熔断器的当前状态。
   * @param {string} name - 熔断器名称
   * @returns {string|null} 当前状态（'closed'|'open'|'half_open'），不存在时返回 null
   */
  getState(name) {
    try { this.guardShutdown(); } catch (_e) { debug('DeepeningCircuitBreaker', 'getState:guardShutdown', _e && _e.message ? _e.message : String(_e)); return null; }
    const c = this._circuits.get(name);
    if (!c) return null;
    return c.state;
  }

  /**
   * 尝试恢复打开状态的熔断器。若重置超时已过，则转为半开状态。
   * @param {string} name - 熔断器名称
   * @returns {string|null} 当前状态，不存在时返回 null
   * @emits 'circuit-state-change'
   */
  tryRecover(name) {
    this.guardShutdown();
    const c = this._circuits.get(name);
    if (!c) return null;
    if (c.state === 'open' && c.lastFailure && Date.now() - c.lastFailure > c.resetTimeout) {
      this._transitionState(c, 'half_open'); c.halfOpenCalls = 0;
      this.emit('circuit-state-change', { name, from: 'open', to: 'half_open' });
    }
    return c.state;
  }

  /**
   * 获取命名熔断器的详细信息。
   * @param {string} name - 熔断器名称
   * @returns {Object|null} 熔断器信息对象，包含 name、state、failureThreshold、resetTimeout、failureCount、totalSuccesses、totalFailures
   */
  getCircuitInfo(name) {
    const c = this._circuits.get(name);
    if (!c) return null;
    return { name: c.name, state: c.state, failureThreshold: c.failureThreshold, resetTimeout: c.resetTimeout, failureCount: c.failureCount, totalSuccesses: c.totalSuccesses, totalFailures: c.totalFailures };
  }

  /**
   * 获取所有熔断器名称。
   * @returns {string[]} 熔断器名称数组
   */
  getCircuitNames() { return Array.from(this._circuits.keys()); }

  /**
   * 按状态获取熔断器列表。
   * @param {string} state - 熔断器状态（'closed'|'open'|'half_open'）
   * @returns {Object[]} 匹配状态的熔断器信息数组，每项包含 name
   */
  getByState(state) {
    const result = [];
    for (const c of this._circuits.values()) {
      if (c.state === state) result.push({ name: c.name });
    }
    return result;
  }

  /**
   * 记录成功。半开状态下连续成功达到阈值时恢复为关闭状态。
   * @param {string} name - 熔断器名称
   * @emits 'success'
   * @emits 'circuit-state-change' 当半开恢复为关闭时
   */
  recordSuccess(name) {
    this.guardShutdown();
    const c = this._circuits.get(name);
    if (!c) return;
    c.successes++;
    c.totalSuccesses++;
    c.failures = 0;
    c.failureCount = 0;
    if (c.state === 'half_open') {
      c.halfOpenCalls = Math.max(0, c.halfOpenCalls - 1);
      if (c.successes >= c.successThreshold) {
        this._changeState(c, 'closed', name);
      }
    }
    this.emit('success', { name });
  }

  /**
   * 记录失败。连续失败达到阈值时触发熔断（转为打开状态）。
   * @param {string} name - 熔断器名称
   * @emits 'failure'
   * @emits 'circuit-state-change' 当状态变更时
   */
  recordFailure(name) {
    this.guardShutdown();
    const c = this._circuits.get(name);
    if (!c) return;
    c.totalFailures++;
    c.lastFailure = Date.now();
    if (c.state === 'half_open') {
      c.halfOpenCalls = Math.max(0, c.halfOpenCalls - 1);
      c.failures++;
      c.failureCount++;
      this._changeState(c, 'open', name); this._totalTripped++;
    } else if (c.state === 'closed') {
      c.failures++;
      c.failureCount++;
      if (c.failures >= c.failureThreshold) {
        this._changeState(c, 'open', name); this._totalTripped++;
      }
    }
    this.emit('failure', { name, failureCount: c.failureCount });
  }

  /**
   * 在熔断器保护下执行异步函数。熔断器打开时拒绝执行，半开时限制并发试探调用。
   * @param {string} name - 熔断器名称
   * @param {Function} fn - 异步执行函数
   * @returns {Promise<*>} 函数执行结果
   * @throws {HarnessError} 熔断器不存在、打开状态或半开容量已满时抛出
   * @emits 'rejected' 当请求被拒绝时
   * @emits 'circuit-state-change' 当打开状态超时后自动转为半开时
   */
  async execute(name, fn) {
    this.guardShutdown();
    if (!this._circuits.has(name)) throw new HarnessError('DEEPENING_CIRCUIT_OPEN', 'Circuit not found: ' + name);
    requireFunction_(fn, 'fn');
    const c = this._circuits.get(name);
    if (c.state === 'open') {
      if (c.lastFailure && Date.now() - c.lastFailure > c.resetTimeout) { this._transitionState(c, 'half_open'); c.halfOpenCalls = 0; this.emit('circuit-state-change', { name, from: 'open', to: 'half_open' }); }
      else { this.emit('rejected', { name }); throw new HarnessError('DEEPENING_CIRCUIT_OPEN', 'Circuit ' + name + ' is open'); }
    }
    if (c.state === 'half_open') {
      if (c.halfOpenCalls >= c.maxHalfOpenCalls) { this.emit('rejected', { name }); throw new HarnessError('DEEPENING_CIRCUIT_OPEN', 'Circuit ' + name + ' half-open capacity'); }
      c.halfOpenCalls++;
    }
    const stateAtCall = c.state;
    try {
      const result = await fn();
      if (this._shutDown) return result;
      const circuit = this._circuits.get(name);
      if (circuit && circuit.state === stateAtCall) this.recordSuccess(name);
      return result;
    } catch (e) {
      if (this._shutDown) throw e;
      const circuit = this._circuits.get(name);
      if (circuit && circuit.state === stateAtCall) this.recordFailure(name);
      throw e;
    }
  }

  /**
   * 强制将熔断器设为打开状态。
   * @param {string} name - 熔断器名称
   * @returns {boolean} 操作结果
   * @emits 'circuit-state-change'
   */
  forceOpen(name) { this.guardShutdown(); const c = this._circuits.get(name); if (c) { this._changeState(c, 'open', name); } return true; }

  /**
   * 强制将熔断器设为关闭状态，并重置失败计数。
   * @param {string} name - 熔断器名称
   * @returns {boolean} 操作结果
   * @emits 'circuit-state-change'
   */
  forceClose(name) { this.guardShutdown(); const c = this._circuits.get(name); if (c) { this._changeState(c, 'closed', name); c.failures = 0; } return true; }

  /**
   * 强制将熔断器设为半开状态，并重置试探调用计数。
   * @param {string} name - 熔断器名称
   * @returns {boolean} 操作结果
   * @emits 'circuit-state-change'
   */
  forceHalfOpen(name) { this.guardShutdown(); const c = this._circuits.get(name); if (c) { this._changeState(c, 'half_open', name); c.halfOpenCalls = 0; } return true; }

  /**
   * 重置指定熔断器为关闭状态，清零失败和成功计数。
   * @param {string} name - 熔断器名称
   * @returns {boolean} 操作结果
   */
  reset(name) { this.guardShutdown(); const c = this._circuits.get(name); if (c) { this._transitionState(c, 'closed'); c.failures = 0; c.successes = 0; c.failureCount = 0; } return true; }

  /**
   * 重置所有熔断器为关闭状态。
   * @returns {boolean} 操作结果
   */
  resetAll() { this.guardShutdown(); for (const [n] of this._circuits) this.reset(n); return true; }

  /**
   * 关闭时的清理回调。清空所有熔断器和状态计数器。
   * @protected
   */
  _onShutdown() {
    this._circuits.clear();
    this._stateCounts = { closed: 0, open: 0, half_open: 0 };
    this._totalTripped = 0;
    super._onShutdown();
  }

  /**
   * 获取熔断器运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalCircuits - 熔断器总数
   * @returns {Object} return.stateCounts - 各状态计数 { closed, open, half_open }
   * @returns {number} return.failureThreshold - 默认失败阈值
   * @returns {number} return.totalTripped - 总跳闸次数
   */
  getStats() {
    return { totalCircuits: this._circuits.size, stateCounts: { ...this._stateCounts }, failureThreshold: this._failureThreshold, totalTripped: this._totalTripped, ...super.getStats() };
  }
}

module.exports = DeepeningCircuitBreaker;
