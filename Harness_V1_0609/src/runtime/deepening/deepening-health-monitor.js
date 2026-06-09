'use strict';
const DeepeningBase = require('./deepening-base');
const RingBuffer = require('../../utils/ring-buffer');
const { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_MIN_HEARTBEAT_MS } = require('../../utils/constants');
const { ensurePositiveNumber } = require('../../utils/param-validator');
const { debug } = require('../../utils/debug-logger');
const { HarnessError, DeepeningError } = require('../../errors');

/**
 * @module runtime/deepening/deepening-health-monitor
 * 深化推理健康监控器。注册命名健康检查函数，以超时保护方式运行，
 * 并基于各项检查结果和关键检查标记计算聚合状态（healthy/degraded/unhealthy/critical）。
 * 维护环形缓冲区报告历史，支持周期性后台检查。
 * @deprecated 请使用 runtime/infrastructure/health-checker 中的 HealthChecker 替代
 */

/**
 * 深化推理健康监控器 — 为深化子系统提供健康监测与周期性检查能力。
 * 注册命名健康检查函数，以超时保护方式运行，并基于各项检查结果和关键检查标记
 * 计算聚合状态（healthy/degraded/unhealthy/critical）。维护环形缓冲区报告历史，
 * 支持周期性后台检查。
 *
 * @classdesc 深化健康监控。组件健康检查、依赖探测、告警
 * @extends DeepeningBase
 * @emits 'check-registered' 当健康检查注册成功时触发，附带 {name}
 * @emits 'check' 当健康检查完成时触发，附带完整报告
 * @emits 'report' 当健康报告生成时触发，附带完整报告
 * @emits 'health-checked' 当健康检查完成时触发，附带完整报告
 * @emits 'health-degraded' 当健康状态非 healthy 时触发，附带完整报告
 * @deprecated 请使用 runtime/infrastructure/health-checker 中的 HealthChecker 替代
 */
class DeepeningHealthMonitor extends DeepeningBase {
  /**
   * 创建 DeepeningHealthMonitor 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.historySize=100] - 历史报告环形缓冲区大小
   * @param {number} [options.interval] - 周期性检查间隔（毫秒），默认 DEFAULT_HEARTBEAT_INTERVAL_MS
   * @param {number} [options.timeout] - 单次检查超时时间（毫秒），默认 DEFAULT_MIN_HEARTBEAT_MS
   */
  constructor(options) {
    super(options);
    const opts = options ?? {};
    DeepeningHealthMonitor._warnDeprecated('DeepeningHealthMonitor', 'HealthChecker from runtime/infrastructure/health-checker', 'deepening-health-monitor');
    this._checks = new Map();
    this._checkOptions = new Map();
    this._maxChecks = 100;
    this._lastReport = null;
    this._intervalId = null;
    this._checkCount = 0;
    this._historySize = opts.historySize ?? 100;
    this._history = new RingBuffer(this._historySize);
    this._interval = ensurePositiveNumber(opts.interval, DEFAULT_HEARTBEAT_INTERVAL_MS);
    this._timeout = ensurePositiveNumber(opts.timeout, DEFAULT_MIN_HEARTBEAT_MS);
  }

  /**
   * 注册命名健康检查函数。
   * @param {string} name - 检查项名称
   * @param {Function} checkFn - 健康检查函数，返回布尔值或对象 {status, message, healthy}
   * @param {Object} [options] - 检查选项
   * @param {boolean} [options.critical=false] - 是否为关键检查项（关键项不健康时状态升级为 critical）
   * @param {number} [options.timeout] - 该检查项的超时时间（毫秒），覆盖全局超时
   * @returns {boolean} 注册成功返回 true，参数无效返回 false
   * @emits 'check-registered' 注册成功时触发，附带 {name}
   */
  register(name, checkFn, options) {
    this.guardShutdown();
    if (!name || typeof name !== 'string' || typeof checkFn !== 'function') {
      return false;
    }
    if (this._checks.size >= this._maxChecks && !this._checks.has(name)) {
      const oldest = this._checks.keys().next().value;
      this._checks.delete(oldest);
      this._checkOptions.delete(oldest);
    }
    this._checks.set(name, checkFn);
    this._checkOptions.set(name, options ?? {});
    this.emit('check-registered', { name });
    return true;
  }

  /**
   * 注销命名健康检查函数。
   * @param {string} name - 检查项名称
   * @returns {boolean} 注销成功返回 true，检查项不存在返回 false
   */
  unregister(name) {
    this.guardShutdown();
    this._checkOptions.delete(name);
    return this._checks.delete(name);
  }

  /**
   * 注册健康检查（严格模式，参数缺失时抛出异常）。
   * @param {string} name - 检查项名称
   * @param {Function} checkFn - 健康检查函数
   * @param {Object} [options] - 检查选项
   * @returns {boolean} 注册成功返回 true
   * @throws {DeepeningError} 当 name 或 checkFn 缺失时抛出 MISSING_PARAMETER 异常
   */
  registerCheck(name, checkFn, options) {
    if (!name || typeof name !== 'string' || typeof checkFn !== 'function') {
      throw new DeepeningError('MISSING_PARAMETER', 'Name and checkFn are required');
    }
    return this.register(name, checkFn, options);
  }

  /**
   * 注销健康检查（registerCheck 的反向操作）。
   * @param {string} name - 检查项名称
   * @returns {boolean} 注销成功返回 true，检查项不存在返回 false
   */
  unregisterCheck(name) { return this.unregister(name); }

  /**
   * 标准化检查结果为统一格式。
   * @param {string} name - 检查项名称
   * @param {boolean|Object} value - 原始检查结果
   * @returns {Object} 标准化结果 {name, status, message, healthy}
   * @private
   */
  _normalizeResult(name, value) {
    if (value && typeof value === 'object' && value !== null) {
      return { name, status: value.status || (value.healthy ? 'healthy' : 'unhealthy'), message: value.message || '', healthy: value.healthy !== undefined ? value.healthy : (value.status === 'healthy'), ...value };
    }
    return { name, status: value ? 'healthy' : 'unhealthy', message: '', healthy: !!value };
  }

  /**
   * 根据检查结果计算聚合健康状态。
   * @param {Array<Object>} results - 各项检查结果数组
   * @param {number} total - 检查总数
   * @param {number} unhealthyCount - 不健康检查项数量
   * @returns {string} 聚合状态：'healthy' | 'degraded' | 'unhealthy' | 'critical'
   * @private
   */
  _computeStatus(results, total, unhealthyCount) {
    let status = 'healthy';
    if (unhealthyCount > 0 && unhealthyCount < total) status = 'degraded';
    if (unhealthyCount === total) status = 'unhealthy';
    const resultMap = new Map();
    for (const r of results) resultMap.set(r.name, r);
    for (const [n, o] of this._checkOptions) {
      if (o.critical) {
        const r = resultMap.get(n);
        if (r && r.status !== 'healthy') { status = 'critical'; break; }
      }
    }
    if (total > 0 && unhealthyCount > total / 2 && status !== 'critical') status = 'unhealthy';
    return status;
  }

  /**
   * 执行所有已注册的健康检查，生成聚合报告。
   * @returns {Promise<Object>} 健康报告 {status, score, results, timestamp, healthy, moduleCount, healthyCount, unhealthyCount}
   * @throws {Error} When module name is not a valid string
   * @emits 'check' 检查完成时触发，附带完整报告
   * @emits 'report' 报告生成时触发，附带完整报告
   * @emits 'health-checked' 检查完成时触发，附带完整报告
   * @emits 'health-degraded' 状态非 healthy 时触发，附带完整报告
   */
  async check() {
    this.guardShutdown();
    const results = [];
    for (const [name, fn] of this._checks) {
      const opts = this._checkOptions.get(name) ?? {};
      const timeout = opts.timeout ?? this._timeout;
      let result;
      try {
        const checkPromise = Promise.resolve(fn());
        checkPromise.catch(function() { /* prevent unhandled rejection if timeout wins */ });
        const value = await Promise.race([
          checkPromise,
          new Promise((_, reject) => { const _tid = setTimeout(() => reject(new DeepeningError('TIMEOUT', 'Health check timeout')), timeout); if (_tid && typeof _tid.unref === 'function') _tid.unref(); checkPromise.finally(() => clearTimeout(_tid)); }),
        ]);
        if (this._shutDown) return { status: 'unhealthy', score: 0, results: [], timestamp: Date.now(), healthy: false, moduleCount: 0, healthyCount: 0, unhealthyCount: 0 };
        result = this._normalizeResult(name, value !== undefined ? value : true);
      } catch (e) {
        debug('DeepeningHealthMonitor', 'check', e && e.message ? e.message : String(e));
        result = { name, status: 'unhealthy', message: e && e.message ? e.message : String(e), healthy: false };
      }
      result.healthy = result.status === 'healthy';
      results.push(result);
      results._byName = results._byName ?? {};
      results._byName[name] = result;
    }
    this._checkCount++;
    let healthyCount = 0;
    for (const r of results) { if (r.status === 'healthy') healthyCount++; }
    const unhealthyCount = results.length - healthyCount;
    const total = results.length;
    const status = this._computeStatus(results, total, unhealthyCount);
    const score = total > 0 ? Math.round((healthyCount / total) * 100) : 100;
    this._lastReport = { status, score, results, timestamp: Date.now(), healthy: status === 'healthy', moduleCount: total, healthyCount, unhealthyCount };
    this._history.push(this._lastReport);
    this.emit('check', this._lastReport);
    this.emit('report', this._lastReport);
    this.emit('health-checked', this._lastReport);
    if (status !== 'healthy') this.emit('health-degraded', this._lastReport);
    return this._lastReport;
  }

  /**
   * 执行指定名称的单项健康检查。
   * @param {string} name - 检查项名称
   * @returns {Promise<Object>} 检查结果 {name, status, message}
   * @throws {HarnessError} 当检查项不存在时抛出 RESOURCE_NOT_FOUND 异常
   */
  async runCheck(name) {
    this.guardShutdown();
    const fn = this._checks.get(name);
    if (!fn) throw new HarnessError('RESOURCE_NOT_FOUND', 'Check not found: ' + name);
    const opts = this._checkOptions.get(name) ?? {};
    const timeout = opts.timeout ?? this._timeout;
    try {
      const checkPromise = Promise.resolve(fn());
      checkPromise.catch(function() { /* prevent unhandled rejection if timeout wins */ });
      const value = await Promise.race([
        checkPromise,
        new Promise((_, reject) => { const _tid = setTimeout(() => reject(new DeepeningError('TIMEOUT', 'Health check timeout')), timeout); if (_tid && typeof _tid.unref === 'function') _tid.unref(); checkPromise.finally(() => clearTimeout(_tid)); }),
      ]);
      if (this._shutDown) return { name, status: 'unhealthy', message: 'Shut down during check' };
      if (value && typeof value === 'object' && value !== null) {
        return { name, status: value.status || (value.healthy ? 'healthy' : 'unhealthy'), message: value.message || '', ...value };
      }
      return { name, status: value ? 'healthy' : 'unhealthy', message: '' };
    } catch (e) {
      debug('DeepeningHealthMonitor', 'runCheck', e && e.message ? e.message : String(e));
      return { name, status: 'unhealthy', message: e && e.message ? e.message : String(e) };
    }
  }

  /**
   * 执行所有已注册的健康检查（check 方法的别名）。
   * @returns {Object} 健康报告
   */
  runAllChecks() { return this.check(); }

  /**
   * 获取最近一次报告中指定检查项的结果。
   * @param {string} name - 检查项名称
   * @returns {Object|null} 检查结果对象，无报告或未找到时返回 null
   */
  getResult(name) {
    if (!this._lastReport) return null;
    const found = this._lastReport.results.find(r => r.name === name);
    return found ?? null;
  }

  /**
   * 获取历史健康报告。
   * @param {number} [limit] - 返回的最大报告数量
   * @returns {Array<Object>} 历史报告数组
   */
  getHistory(limit) {
    if (limit) return this._history.slice(-limit);
    return this._history.toArray().slice();
  }

  /**
   * 获取最近一次健康报告。
   * @returns {Object|null} 最近一次报告，无报告时返回 null
   */
  getLastReport() {
    if (!this._lastReport) return null;
    try { return JSON.parse(JSON.stringify(this._lastReport)); } catch (_) { debug('DeepeningHealthMonitor', 'getLastReport', _ && _.message ? _.message : String(_)); return { ...this._lastReport }; }
  }

  /**
   * 启动周期性健康检查。
   * @returns {boolean} 启动成功返回 true，已在运行返回 true
   */
  start() {
    this.guardShutdown();
    if (this._intervalId) return true;
    this._intervalId = setInterval(() => { this.check().catch(function(_e) { debug('DeepeningHealthMonitor', 'periodicCheck', _e && _e.message ? _e.message : String(_e)); }); }, this._interval);
    if (this._intervalId && this._intervalId.unref) this._intervalId.unref();
    return true;
  }

  /**
   * 启动周期性健康检查（可指定间隔）。
   * @param {number} [interval] - 检查间隔（毫秒），默认使用构造时的 interval
   * @returns {boolean} 启动成功返回 true
   */
  startPeriodicCheck(interval) {
    this.guardShutdown();
    if (this._intervalId) clearInterval(this._intervalId);
    this._intervalId = setInterval(() => { if (this._shutDown) return; this.check().catch(function(_e) { debug('DeepeningHealthMonitor', 'periodicCheck', _e && _e.message ? _e.message : String(_e)); }); }, interval ?? this._interval);
    if (this._intervalId && this._intervalId.unref) this._intervalId.unref();
    return true;
  }

  /**
   * 停止周期性健康检查。
   * @returns {boolean} 停止成功返回 true
   */
  stop() {
    if (this._intervalId) { clearInterval(this._intervalId); this._intervalId = null; }
    return true;
  }

  /**
   * 停止周期性健康检查（stop 方法的别名）。
   * @returns {boolean} 停止成功返回 true
   */
  stopPeriodicCheck() { return this.stop(); }

  /**
   * 关闭时的清理回调。停止周期性检查。
   * @protected
   */
  _onShutdown() {
    this.stop();
    this._checks.clear();
    this._checkOptions.clear();
    this._history = new RingBuffer(this._historySize);
    this._lastReport = null;
    this._checkCount = 0;
    super._onShutdown();
  }

  /**
   * 获取所有已注册检查项的名称列表。
   * @returns {Array<string>} 检查项名称数组
   */
  getModuleNames() { return Array.from(this._checks.keys()); }

  /**
   * 获取健康监控器的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.registeredModules - 已注册模块数
   * @returns {number} return.registeredChecks - 已注册检查数
   * @returns {number} return.checksRegistered - 已注册检查数（同义词）
   * @returns {boolean} return.periodicCheckActive - 周期性检查是否活跃
   * @returns {boolean} return.monitoring - 是否正在监控
   * @returns {boolean} return.running - 是否正在运行
   * @returns {number} return.checkCount - 累计检查次数
   * @returns {boolean} return.hasLastReport - 是否有最近报告
   */
  getStats() {
    return {
      ...super.getStats(),
      registeredModules: this._checks.size,
      registeredChecks: this._checks.size,
      checksRegistered: this._checks.size,
      periodicCheckActive: !!this._intervalId,
      monitoring: !!this._intervalId,
      running: !!this._intervalId,
      checkCount: this._checkCount,
      hasLastReport: !!this._lastReport,
    };
  }
}

module.exports = DeepeningHealthMonitor;
