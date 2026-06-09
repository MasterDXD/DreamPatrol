'use strict';
const DeepeningBase = require('./deepening-base');
const { requireString_, requireFunction_, ensurePositiveNumber } = require('../../utils/param-validator');
const { DEFAULT_RETRY_MAX_DELAY_MS } = require('../../utils/constants');
const { HarnessError } = require('../../errors');
const { debug } = require('../../utils/debug-logger');

/**
 * @module runtime/deepening/deepening-retry-policy
 * 可配置重试策略管理器。支持四种退避策略（固定、线性、指数、带抖动指数），
 * 可重试错误过滤及按策略的尝试追踪。以自动重试和延迟计算执行异步函数，
 * 最多重试至最大重试次数。
 */

/**
 * @classdesc 深化重试策略。指数退避、抖动、最大重试次数
 *
 * 可配置重试策略管理器 — 为深化子系统提供多策略自动重试能力。
 * 支持四种退避策略（fixed/linear/exponential/exponential_jitter），
 * 可重试错误过滤及按策略的尝试追踪。以自动重试和延迟计算执行异步函数，
 * 最多重试至最大重试次数。
 *
 * @extends DeepeningBase
 * @emits 'policyDefined' 当策略定义时触发，附带 {name, maxRetries}
 * @emits 'policyRemoved' 当策略移除时触发，附带 {name}
 * @emits 'policyReset' 当策略重置时触发，附带 {name}
 * @emits 'retrySucceeded' 当重试成功时触发，附带 {attempt}
 * @emits 'retrying' 当正在重试时触发，附带 {policy, attempt}
 * @emits 'nonRetryable' 当遇到不可重试错误时触发，附带 {policy}
 * @emits 'retriesExhausted' 当重试次数耗尽时触发，附带 {maxRetries}
 */
class DeepeningRetryPolicy extends DeepeningBase {
  /**
   * 退避策略枚举。
   * @constant {Object}
   * @property {string} FIXED - 固定退避
   * @property {string} LINEAR - 线性退避
   * @property {string} EXPONENTIAL - 指数退避
   * @property {string} EXPONENTIAL_JITTER - 带抖动的指数退避
   */
  static BACKOFF_STRATEGIES = { FIXED: 'fixed', LINEAR: 'linear', EXPONENTIAL: 'exponential', EXPONENTIAL_JITTER: 'exponential_jitter' };

  /**
   * 创建 DeepeningRetryPolicy 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxPolicies=50] - 最大策略数量
   * @param {number} [options.defaultMaxRetries=3] - 默认最大重试次数
   * @param {number} [options.defaultBaseDelay=100] - 默认基础延迟（毫秒）
   * @param {number} [options.defaultMaxDelay] - 默认最大延迟（毫秒），默认 DEFAULT_RETRY_MAX_DELAY_MS
   */
  constructor(options) {
    super(options);
    this._policies = new Map();
    this._maxPolicies = (options && options.maxPolicies) ?? 50;
    this._defaultMaxRetries = (options && options.defaultMaxRetries) ?? 3;
    this._defaultBaseDelay = ensurePositiveNumber((options && options.defaultBaseDelay), 100);
    this._defaultMaxDelay = ensurePositiveNumber((options && options.defaultMaxDelay), DEFAULT_RETRY_MAX_DELAY_MS);
    this._totalSuccesses = 0;
    this._totalFailures = 0;
    /** 活跃 setTimeout 定时器集合，关闭时批量清理 */
    this._timers = new Set();
    /** 挂起的Promise解析器，关闭时批量reject防止永远挂起 */
    this._pendingResolvers = new Set();
  }

  /**
   * 定义命名重试策略。
   * @param {string} name - 策略名称
   * @param {Object} [options] - 策略选项
   * @param {number} [options.maxRetries] - 最大重试次数，默认 defaultMaxRetries
   * @param {number} [options.baseDelay] - 基础延迟（毫秒），默认 defaultBaseDelay
   * @param {number} [options.maxDelay] - 最大延迟（毫秒），默认 defaultMaxDelay
   * @param {string} [options.backoffStrategy='exponential'] - 退避策略
   * @param {Array<string>} [options.retryableErrors=[]] - 可重试错误消息关键字列表
   * @returns {boolean} 定义成功返回 true，策略已存在返回 false
   * @emits 'policyDefined' 策略定义成功时触发，附带 {name, maxRetries}
   */
  definePolicy(name, options) {
    this.guardShutdown();
    requireString_(name, 'Policy name');
    if (this._policies.has(name)) return false;
    if (this._policies.size >= this._maxPolicies) {
      const oldest = this._policies.keys().next().value;
      if (oldest !== undefined) this._policies.delete(oldest);
    }
    const opts = options ?? {};
    this._policies.set(name, { name, maxRetries: opts.maxRetries !== undefined ? opts.maxRetries : this._defaultMaxRetries, baseDelay: opts.baseDelay ?? this._defaultBaseDelay, maxDelay: opts.maxDelay ?? this._defaultMaxDelay, backoffStrategy: opts.backoffStrategy ?? 'exponential', retryableErrors: opts.retryableErrors ?? [], stats: { attempts: 0, successes: 0, failures: 0 } });
    const policy = this._policies.get(name);
    this.emit('policyDefined', { name, maxRetries: policy ? policy.maxRetries : opts.maxRetries });
    return true;
  }

  /**
   * 获取所有策略名称。
   * @returns {Array<string>} 策略名称数组
   */
  getPolicyNames() { return Array.from(this._policies.keys()); }

  /**
   * 获取指定策略的配置信息。
   * @param {string} name - 策略名称
   * @returns {Object|null} 策略配置对象，不存在返回 null
   */
  getPolicy(_name) { return this._policies.get(_name) ?? null; }

  /**
   * 计算指定策略在指定尝试次数的退避延迟。
   * @param {string} name - 策略名称
   * @param {number} attempt - 当前尝试次数（从1开始）
   * @returns {number} 延迟时间（毫秒）
   * @throws {HarnessError} 当策略不存在时抛出 RESOURCE_NOT_FOUND 异常
   */
  computeDelay(name, attempt) {
    const policy = this._policies.get(name);
    if (!policy) throw new HarnessError('RESOURCE_NOT_FOUND', 'Policy not found: ' + name);
    const base = policy.baseDelay;
    switch (policy.backoffStrategy) {
      case 'fixed': return base;
      case 'linear': return base * attempt;
      case 'exponential': return Math.min(base * Math.pow(2, attempt - 1), policy.maxDelay);
      case 'exponential_jitter': return Math.min(base * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5), policy.maxDelay);
      default: return base;
    }
  }

  /**
   * 使用指定策略执行异步函数，自动重试直到成功或重试次数耗尽。
   * @param {string} name - 策略名称
   * @param {Function} fn - 异步函数
   * @returns {Promise<*>} 函数执行结果
   * @throws {HarnessError} 当策略不存在时抛出 RESOURCE_NOT_FOUND 异常
   * @throws {*} 当重试次数耗尽时抛出最后一次错误
   * @emits 'retrySucceeded' 重试成功时触发，附带 {attempt}
   * @emits 'retrying' 正在重试时触发，附带 {policy, attempt}
   * @emits 'nonRetryable' 遇到不可重试错误时触发，附带 {policy}
   * @emits 'retriesExhausted' 重试次数耗尽时触发，附带 {maxRetries}
   */
  async execute(name, fn) {
    this.guardShutdown();
    if (!this._policies.has(name)) throw new HarnessError('RESOURCE_NOT_FOUND', 'Policy not found: ' + name);
    requireFunction_(fn, 'fn');
    const policy = this._policies.get(name);
    let lastError;
    let retryCount = 0;
    for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt++) {
      if (this._shutDown) throw new Error('Retry policy interrupted by shutdown');
      try {
        const result = await fn();
        policy.stats.successes++;
        this._totalSuccesses++;
        this.emit('retrySucceeded', { attempt: retryCount });
        return result;
      } catch (e) {
        lastError = e;
        policy.stats.attempts++;
        if (attempt <= policy.maxRetries) {
          if (policy.retryableErrors.length > 0) {
            const isRetryable = policy.retryableErrors.some(msg => { const emsg = e && e.message ? e.message : String(e); return emsg && emsg.includes(msg); });
            if (!isRetryable) { this.emit('nonRetryable', { policy: name }); throw e; }
          }
          retryCount++;
          this.emit('retrying', { policy: name, attempt });
          const delay = this.computeDelay(name, attempt);
          await new Promise((resolve, reject) => {
            const entry = { timer: null, resolve, reject };
            const tid = setTimeout(() => {
              this._timers.delete(tid);
              this._pendingResolvers.delete(entry);
              resolve();
            }, delay);
            entry.timer = tid;
            this._timers.add(tid);
            this._pendingResolvers.add(entry);
          });
          if (this._shutDown) {
            this.emit('retryAborted', { policy: name, attempt });
            throw lastError || new Error('Retry aborted due to shutdown');
          }
        }
      }
    }
    policy.stats.failures++;
    this._totalFailures++;
    this.emit('retriesExhausted', { maxRetries: policy.maxRetries });
    throw lastError;
  }

  /**
   * 移除命名重试策略。
   * @param {string} name - 策略名称
   * @returns {boolean} 移除成功返回 true，策略不存在返回 false
   * @emits 'policyRemoved' 策略移除时触发，附带 {name}
   */
  removePolicy(name) {
    this.guardShutdown();
    if (!this._policies.has(name)) return false;
    this._policies.delete(name);
    this.emit('policyRemoved', { name });
    return true;
  }

  /**
   * 重置指定策略的统计信息。
   * @param {string} name - 策略名称
   * @returns {boolean} 重置成功返回 true，策略不存在返回 false
   * @emits 'policyReset' 策略重置时触发，附带 {name}
   */
  resetPolicy(name) { this.guardShutdown(); const p = this._policies.get(name); if (!p) return false; p.stats = { attempts: 0, successes: 0, failures: 0 }; this.emit('policyReset', { name }); return true; }

  _onShutdown() {
    for (const { reject } of this._pendingResolvers) {
      try { reject(new Error('Shutdown')); } catch (_e) { debug('DeepeningRetryPolicy', '_onShutdown:reject', _e && _e.message ? _e.message : String(_e)); }
    }
    this._pendingResolvers.clear();
    for (const tid of this._timers) clearTimeout(tid);
    this._timers.clear();
    this._policies.clear();
    super._onShutdown();
  }

  /**
   * 获取重试策略管理器的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalPolicies - 策略总数
   * @returns {string} return.successRate - 成功率（保留1位小数）
   */
  getStats() {
    const total = this._totalSuccesses + this._totalFailures;
    const successRate = total > 0 ? (this._totalSuccesses / total).toFixed(1) : '0.0';
    return { totalPolicies: this._policies.size, successRate, ...super.getStats() };
  }
}

module.exports = DeepeningRetryPolicy;
