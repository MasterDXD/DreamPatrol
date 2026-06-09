'use strict';

/**
 * @module runtime/thought/provider/provider-health-checker
 * @classdesc 提供商健康检查器。周期性探测+熔断器
 * ProviderHealthChecker — Circuit-breaker-based health checker for memory providers
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../../utils/shutdown-mixin');
const { debug } = require('../../../utils/debug-logger');
const { mergeConfig } = require('../../../utils/safe-assign');

const CIRCUIT_STATES = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open',
};

const DEFAULT_HEALTH_CHECK_CONFIG = {
  intervalMs: 60000,
  failureThreshold: 3,
  recoveryIntervalMs: 300000,
};

/**
 * 提供者健康检查器。基于熔断器模式定期检查提供者健康状态，
 * 支持closed/open/half-open三种熔断状态转换。
 *
 * @extends EventEmitter
 * @emits ProviderHealthChecker#provider-health-changed 提供者健康状态变更时触发
 */
class ProviderHealthChecker extends EventEmitter {
  /**
   * 创建ProviderHealthChecker实例。
   *
   * @param {Object} registry - 提供者注册表实例
   * @param {Object} [config] - 健康检查配置
   * @param {number} [config.intervalMs=60000] - 检查间隔（毫秒）
   * @param {number} [config.failureThreshold=3] - 连续失败阈值，超过则打开熔断器
   * @param {number} [config.recoveryIntervalMs=300000] - 熔断恢复间隔（毫秒）
   */
  constructor(registry, config) {
    super();
    this._registry = registry;
    this._config = mergeConfig(DEFAULT_HEALTH_CHECK_CONFIG, config ?? {});
    this._statuses = new Map();
    this._timer = null;
    this._log = debug('ProviderHealthChecker');
  }

  /**
   * 启动定期健康检查。若已在运行则忽略。
   */
  start() {
    this.guardShutdown();
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this._shutDown) return;
      this._runHealthChecks().catch(e => { this._log('healthCheck', e && e.message ? e.message : String(e)); });
    }, this._config.intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
    this._log('start', 'health checker started');
  }

  /**
   * 停止定期健康检查。
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._log('stop', 'health checker stopped');
  }

  /**
   * 获取指定提供者的熔断状态信息。未跟踪的提供者返回默认closed状态。
   *
   * @param {string} name - 提供者名称
   * @returns {{state: string, consecutiveFailures: number, lastCheck: number|null, lastError: string|null, openedAt: number|null}} 熔断状态
   */
  getStatus(name) {
    const status = this._statuses.get(name);
    if (!status) {
      return {
        state: CIRCUIT_STATES.CLOSED,
        consecutiveFailures: 0,
        lastCheck: null,
        lastError: null,
        openedAt: null,
      };
    }
    return {
      state: status.state,
      consecutiveFailures: status.consecutiveFailures,
      lastCheck: status.lastCheck,
      lastError: status.lastError,
      openedAt: status.openedAt,
    };
  }

  _initStatus(name) {
    if (!this._statuses.has(name)) {
      this._statuses.set(name, {
        state: CIRCUIT_STATES.CLOSED,
        consecutiveFailures: 0,
        lastCheck: null,
        lastError: null,
        openedAt: null,
      });
    }
    return this._statuses.get(name);
  }

  async _runHealthChecks() {
    if (!this._registry) return;
    const providers = this._registry.getAll();
    const promises = [];
    for (const name of Object.keys(providers ?? {})) {
      promises.push(this._checkOne(name, providers[name]));
    }
    await Promise.allSettled(promises);
  }

  async _checkOne(name, provider) {
    const status = this._initStatus(name);
    if (status.state === CIRCUIT_STATES.OPEN) {
      const elapsed = Date.now() - (status.openedAt ?? 0);
      if (elapsed < this._config.recoveryIntervalMs) return;
      status.state = CIRCUIT_STATES.HALF_OPEN;
    }
    try {
      const result = await Promise.resolve(provider.healthCheck());
      status.lastCheck = Date.now();
      if (result.healthy) {
        if (status.state === CIRCUIT_STATES.HALF_OPEN) {
          status.state = CIRCUIT_STATES.CLOSED;
          this.emit('provider-health-changed', { name, state: CIRCUIT_STATES.CLOSED, healthy: true });
        }
        status.consecutiveFailures = 0;
        status.lastError = null;
      } else {
        this._recordFailure(name, status, result.error);
      }
    } catch (err) {
      status.lastCheck = Date.now();
      this._recordFailure(name, status, err && err.message ? err.message : String(err));
    }
  }

  _recordFailure(name, status, errorMsg) {
    status.consecutiveFailures++;
    status.lastError = errorMsg ?? 'unknown error';
    if (status.state === CIRCUIT_STATES.HALF_OPEN) {
      status.state = CIRCUIT_STATES.OPEN;
      status.openedAt = Date.now();
      this.emit('provider-health-changed', { name, state: CIRCUIT_STATES.OPEN, healthy: false, error: errorMsg });
    } else if (status.consecutiveFailures >= this._config.failureThreshold) {
      status.state = CIRCUIT_STATES.OPEN;
      status.openedAt = Date.now();
      this.emit('provider-health-changed', { name, state: CIRCUIT_STATES.OPEN, healthy: false, error: errorMsg });
    }
  }

  /**
   * 检查指定提供者的熔断器是否处于打开状态。
   *
   * @param {string} name - 提供者名称
   * @returns {boolean} 熔断器打开返回true
   */
  isCircuitOpen(name) {
    const status = this._statuses.get(name);
    if (!status) return false;
    return status.state === CIRCUIT_STATES.OPEN;
  }

  /**
   * 检查指定提供者是否可用（熔断器非打开状态）。
   *
   * @param {string} name - 提供者名称
   * @returns {boolean} 可用返回true
   */
  isAvailable(name) {
    const status = this._statuses.get(name);
    if (!status) return true;
    return status.state !== CIRCUIT_STATES.OPEN;
  }

  _onShutdown() {
    this.stop();
    this._statuses.clear();
    this._registry = null;
    this.removeAllListeners();
  }
}

ProviderHealthChecker.CIRCUIT_STATES = CIRCUIT_STATES;
ProviderHealthChecker.DEFAULT_HEALTH_CHECK_CONFIG = DEFAULT_HEALTH_CHECK_CONFIG;

module.exports = withShutdown(ProviderHealthChecker);
