'use strict';

const { EventEmitter } = require('events');
const { HarnessError } = require('../../errors');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { DEFAULT_REQUEST_TIMEOUT_MS } = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');

const CHECK_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;

/**
 * @module runtime/infrastructure/health-checker
 * HealthChecker — 健康检查器
 * 注册和管理分层健康检查项（critical/warning/info），提供单项检查、
 * 全量检查、按层级检查和聚合报告。支持liveness/readiness探针、
 * 超时保护、因果数据总线状态变更通知和检查统计。
 * @classdesc 健康检查器。liveness/readiness探针
 * @extends EventEmitter
 */
class HealthChecker extends EventEmitter {
  /**
   * 创建 HealthChecker 实例。
   */
  constructor() {
    super();
    this._checks = new Map();
    this._tiers = new Map();
    this._timeouts = new Map();
    this._pendingChecks = new Set();
    this._maxChecks = 100;
    this._startTime = Date.now();
    this._lastCheckTime = null;
    this._lastCheckResult = null;
    this._checkCount = 0;
    this._tierCounts = { critical: 0, warning: 0, info: 0 };
    this._causalDataBus = null;
    this._prevStatusMap = Object.create(null);
    this._maxConcurrentChecks = 50;
    this._activeChecks = 0;
  }

  /**
   * 附加CausalDataBus实例，用于在健康状态变更时发布因果事件。
   * @param {CausalDataBus} cdb - 因果数据总线实例
   * @returns {HealthChecker} this（链式调用）
   */
  attachCausalDataBus(cdb) {
    this._causalDataBus = cdb;
    return this;
  }

  /**
   * 注册健康检查项。检查函数可以是同步或异步，支持超时保护。
   * @param {string} name - 检查项名称（非空字符串，唯一标识）
   * @param {Function} checkFn - 检查函数，返回{status, message}或抛出异常
   * @param {string} [tier='warning'] - 严重层级（critical/warning/info）
   * @param {Object} [options] - 配置选项
   * @param {number} [options.timeoutMs] - 超时时间（毫秒）
   * @returns {HealthChecker} this（链式调用）
   * @throws {HarnessError} 名称无效、检查函数非函数、或超过最大检查数量时抛出
   */
  register(name, checkFn, tier, options) {
    this.guardShutdown();
    if (!name || typeof name !== 'string') {
      throw new HarnessError('INVALID_INPUT', 'Health check name must be a non-empty string');
    }
    if (typeof checkFn !== 'function') {
      throw new HarnessError('INVALID_INPUT', 'Health check must be a function');
    }
    if (this._checks.size >= this._maxChecks) {
      throw new HarnessError('LIMIT_EXCEEDED', 'Maximum number of health checks (' + this._maxChecks + ') reached');
    }
    this._checks.set(name, checkFn);
    const tierName = tier ?? 'warning';
    this._tiers.set(name, tierName);
    this._tierCounts[tierName] = (this._tierCounts[tierName] ?? 0) + 1;
    if (options && typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
      this._timeouts.set(name, options.timeoutMs);
    }
    return this;
  }

  /**
   * 注销健康检查项。移除检查函数、层级映射、超时配置和状态缓存。
   * @param {string} name - 检查项名称
   * @returns {boolean} 注销成功返回 true，检查项不存在时返回 false
   */
  unregister(name) {
    this.guardShutdown();
    const tier = this._tiers.get(name);
    if (tier && this._tierCounts[tier] > 0) this._tierCounts[tier]--;
    this._tiers.delete(name);
    this._timeouts.delete(name);
    delete this._prevStatusMap[name];
    return this._checks.delete(name);
  }

  /**
   * 执行指定名称的健康检查。检查函数可以是同步或异步，支持超时保护。
   * @param {string} name - 检查项名称
   * @returns {Promise<{name: string, status: string, message: string, details: Object, tier: string, timestamp: string, timedOut?: boolean}>} 检查结果
   */
  async check(name) {
    this.guardShutdown();
    const fn = this._checks.get(name);
    if (!fn) return { name, status: 'unknown', message: 'Check not found' };

    return this._runCheck(name, fn);
  }

  async _runCheck(name, checkFn) {
    if (this._shutDown) {
      return { name, status: 'error', message: 'HealthChecker is shutting down', tier: this._tiers.get(name) || 'warning', timestamp: new Date().toISOString() };
    }
    if (this._activeChecks >= this._maxConcurrentChecks) {
      return { name, status: 'error', message: 'Too many concurrent health checks', tier: this._tiers.get(name) || 'warning', timestamp: new Date().toISOString() };
    }
    this._activeChecks++;
    const timeoutMs = this._timeouts.get(name) || CHECK_TIMEOUT_MS;
    this._pendingChecks.add(name);
    try {
      let timeoutId;
      const checkResult = checkFn();
      const checkPromise = checkResult && typeof checkResult.then === 'function' ? checkResult : Promise.resolve(checkResult);
      checkPromise.catch(function(err) { debug('HealthChecker', 'checkFailed', name + ': ' + (err && err.message ? err.message : String(err))); });
      const result = await Promise.race([
        checkPromise,
        new Promise(function(_, reject) {
          timeoutId = setTimeout(function() { reject(new HarnessError('TIMEOUT', 'Health check "' + name + '" timed out after ' + timeoutMs + 'ms')); }, timeoutMs);
          if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
        }),
      ]).finally(function() { if (timeoutId) clearTimeout(timeoutId); });
      return {
        name,
        status: result && result.healthy ? 'healthy' : 'unhealthy',
        message: (result && result.message) || '',
        details: (result && result.details) ?? {},
        tier: this._tiers.get(name) || 'warning',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return {
        name,
        status: 'error',
        message: err && err.message ? err.message : String(err),
        tier: this._tiers.get(name) || 'warning',
        timestamp: new Date().toISOString(),
        timedOut: (err && err.code) === 'TIMEOUT',
      };
    } finally {
      this._activeChecks--;
      this._pendingChecks.delete(name);
    }
  }

  /**
   * 执行所有已注册的健康检查。按批次并发执行，状态变更时通过因果数据总线发布事件。
   * @returns {Promise<{status: string, checks: Object<string, {name: string, status: string, message: string, details: Object, tier: string, timestamp: string}>, timestamp: string}>} 全量检查结果
   */
  async checkAll() {
    if (this._shutDown) {
      return { status: 'degraded', checks: {}, timestamp: new Date().toISOString() };
    }
    const results = {};
    const snapshot = [];
    for (const [name, fn] of this._checks) {
      snapshot.push({ name, fn });
    }

    this._checkCount++;

    const batchSize = this._maxConcurrentChecks;
    for (let i = 0; i < snapshot.length; i += batchSize) {
      if (this._shutDown) break;
      const batch = snapshot.slice(i, i + batchSize);
      const batchChecks = batch.map(async function(entry) {
        try {
          const result = await this._runCheck(entry.name, entry.fn);
          results[entry.name] = result;
        } catch (err) {
          results[entry.name] = {
            name: entry.name,
            status: 'error',
            message: err && err.message ? err.message : String(err),
            tier: this._tiers.get(entry.name) || 'warning',
            timestamp: new Date().toISOString(),
          };
        }
      }.bind(this));
      await Promise.allSettled(batchChecks);
    }

    const resultValues = Object.values(results);
    const healthy = resultValues.length > 0 && resultValues.every(function(r) { return r.status === 'healthy'; });
    this._lastCheckTime = Date.now();
    this._lastCheckResult = resultValues.length === 0 ? 'unknown' : (healthy ? 'healthy' : 'degraded');

    if (this._causalDataBus) {
      for (const [name, result] of Object.entries(results)) {
        const prevStatus = this._prevStatusMap[name];
        if (prevStatus && prevStatus !== result.status) {
          this._causalDataBus.publishOutput('health-checker', {
            checkName: name,
            previousStatus: prevStatus,
            currentStatus: result.status,
            tier: result.tier,
            message: result.message,
          }).catch(function(err) {
            debug('HealthChecker', 'publishOutput', err && err.message ? err.message : String(err));
          });
        }
        this._prevStatusMap[name] = result.status;
      }
    }

    return {
      status: healthy ? 'healthy' : 'degraded',
      checks: results,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 按严重层级执行健康检查。仅执行指定层级的检查项。
   * @param {string} tier - 严重层级（critical/warning/info）
   * @returns {Promise<{tier: string, checks: Object<string, {name: string, status: string, message: string, tier: string, timestamp: string}>, timestamp: string}>} 按层级检查结果
   */
  async checkByTier(tier) {
    const names = Array.from(this._checks.keys()).filter(n => this._tiers.get(n) === tier);
    const results = {};
    for (const name of names) {
      try {
        results[name] = await this.check(name);
      } catch (err) {
        results[name] = {
          name,
          status: 'unhealthy',
          message: err && err.message ? err.message : String(err),
          tier: tier,
          timestamp: new Date().toISOString(),
        };
      }
    }
    return {
      tier,
      checks: results,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 执行所有critical级别的健康检查。
   * @returns {Promise<{tier: string, checks: Object, timestamp: string}>} critical层级检查结果
   */
  async checkCritical() {
    return this.checkByTier('critical');
  }

  /**
   * 获取聚合健康报告。按层级分组汇总所有检查结果，计算整体状态和统计信息。
   * @returns {Promise<{status: string, summary: {total: number, healthy: number, unhealthy: number, criticalIssues: number, warningIssues: number}, tiers: {critical: Array, warning: Array, info: Array}, timestamp: string, error?: string}>} 聚合健康报告
   */
  async getAggregatedReport() {
    let allResults;
    try {
      allResults = await this.checkAll();
    } catch (err) {
      return {
        status: 'degraded',
        summary: { total: 0, healthy: 0, unhealthy: 0, criticalIssues: 0, warningIssues: 0 },
        tiers: { critical: [], warning: [], info: [] },
        timestamp: new Date().toISOString(),
        error: err && err.message ? err.message : String(err),
      };
    }
    const tiers = { critical: [], warning: [], info: [] };
    for (const [name, result] of Object.entries(allResults.checks)) {
      const tier = this._tiers.get(name) || 'warning';
      result.tier = tier;
      if (tiers[tier]) tiers[tier].push(result);
    }
    const criticalUnhealthy = tiers.critical.filter(r => r.status !== 'healthy');
    const warningUnhealthy = tiers.warning.filter(r => r.status !== 'healthy');
    let overallStatus = 'healthy';
    if (criticalUnhealthy.length > 0) overallStatus = 'critical';
    else if (warningUnhealthy.length > 0) overallStatus = 'degraded';
    return {
      status: overallStatus,
      summary: {
        total: Object.keys(allResults.checks).length,
        healthy: Object.values(allResults.checks).reduce((c, r) => c + (r.status === 'healthy' ? 1 : 0), 0),
        unhealthy: Object.values(allResults.checks).reduce((c, r) => c + (r.status !== 'healthy' ? 1 : 0), 0),
        criticalIssues: criticalUnhealthy.length,
        warningIssues: warningUnhealthy.length,
      },
      tiers,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 存活探针。返回进程存活状态和运行时间。
   * @returns {Promise<{alive: boolean, uptimeMs: number, timestamp: string}>} 存活状态
   */
  async liveness() {
    return {
      alive: true,
      uptimeMs: Date.now() - this._startTime,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 就绪探针。检查所有critical级别检查项是否健康，决定服务是否可接收流量。
   * @returns {Promise<{ready: boolean, criticalChecks: number, unhealthyCritical: number, timestamp: string, error?: string}>} 就绪状态
   */
  async readiness() {
    let criticalResult;
    try {
      criticalResult = await this.checkCritical();
    } catch (err) {
      return {
        ready: false,
        criticalChecks: 0,
        unhealthyCritical: 0,
        timestamp: new Date().toISOString(),
        error: err && err.message ? err.message : String(err),
      };
    }
    const criticalUnhealthy = Object.values(criticalResult.checks).filter(r => r.status !== 'healthy');
    return {
      ready: criticalUnhealthy.length === 0,
      criticalChecks: Object.keys(criticalResult.checks).length,
      unhealthyCritical: criticalUnhealthy.length,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 获取指定检查项的严重层级。
   * @param {string} name - 检查项名称
   * @returns {string|null} 严重层级（critical/warning/info），不存在时返回 null
   */
  getCheckTier(name) {
    return this._tiers.get(name) ?? null;
  }

  /**
   * 获取所有已注册检查项的名称列表。
   * @returns {string[]} 检查项名称数组
   */
  listChecks() {
    return Array.from(this._checks.keys());
  }

  /**
   * 获取健康检查器的运行统计数据。
   * @returns {{totalChecks: number, checkCount: number, startTime: number, uptimeMs: number, lastCheckTime: number|null, lastCheckResult: string|null, tiers: {critical: number, warning: number, info: number}}} 统计信息对象
   */
  getStats() {
    return {
      totalChecks: this._checks.size,
      checkCount: this._checkCount,
      startTime: this._startTime,
      uptimeMs: Date.now() - this._startTime,
      lastCheckTime: this._lastCheckTime,
      lastCheckResult: this._lastCheckResult,
      tiers: { ...this._tierCounts },
    };
  }

  _onShutdown() {
    this._checks.clear();
    this._tiers.clear();
    this._timeouts.clear();
    this._pendingChecks.clear();
    this._prevStatusMap = {};
    this.removeAllListeners();
  }

}

module.exports = withShutdown(HealthChecker);
