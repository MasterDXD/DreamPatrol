'use strict';

/**
 * @module runtime/thought/provider/provider-registry
 * @classdesc 提供商注册表。注册/注销/健康检查/连接管理
 * ProviderRegistry — Registry for managing multiple memory providers with health monitoring
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../../utils/shutdown-mixin');
const { debug } = require('../../../utils/debug-logger');
const { safeCall } = require('../../../utils/safe-execute');

const REGISTRY_EVENTS = {
  PROVIDER_REGISTERED: 'provider-registered',
  PROVIDER_UNREGISTERED: 'provider-unregistered',
  PROVIDER_HEALTH_CHANGED: 'provider-health-changed',
};

/**
 * 提供者注册表。管理多个记忆提供者的注册、注销、连接、断开和健康检查，
 * 支持按名称查询和批量操作。
 *
 * @extends EventEmitter
 * @emits ProviderRegistry#provider-registered 提供者注册时触发
 * @emits ProviderRegistry#provider-unregistered 提供者注销时触发
 * @emits ProviderRegistry#provider-health-changed 提供者健康状态变更时触发
 */
class ProviderRegistry extends EventEmitter {
  /**
   * 创建ProviderRegistry实例。
   */
  constructor() {
    super();
    this._providers = new Map();
    this._options = new Map();
    this._log = debug('ProviderRegistry');
  }

  /**
   * 注册一个记忆提供者。名称或提供者无效时忽略。
   *
   * @param {string} name - 提供者名称
   * @param {Object} provider - 提供者实例
   * @param {Object} [options] - 注册选项
   * @returns {ProviderRegistry} 当前实例（支持链式调用）
   */
  register(name, provider, options) {
    if (!name || typeof name !== 'string') return this;
    if (!provider || typeof provider !== 'object') return this;
    this._providers.set(name, provider);
    this._options.set(name, options ?? {});
    this.emit(REGISTRY_EVENTS.PROVIDER_REGISTERED, { name, provider });
    this._log('register', name);
    return this;
  }

  /**
   * 注销一个记忆提供者。注销前尝试断开连接。
   *
   * @param {string} name - 提供者名称
   * @returns {Promise<ProviderRegistry>} 当前实例（支持链式调用）
   */
  async unregister(name) {
    const provider = this._providers.get(name);
    if (!provider) return this;
    try {
      if (typeof provider.disconnect === 'function') {
        await Promise.resolve(provider.disconnect());
      }
    } catch (err) {
      this._log('unregister_disconnect', name, err && err.message ? err.message : String(err));
    }
    this._providers.delete(name);
    this._options.delete(name);
    this.emit(REGISTRY_EVENTS.PROVIDER_UNREGISTERED, { name });
    this._log('unregister', name);
    return this;
  }

  /**
   * 按名称获取提供者实例。
   *
   * @param {string} name - 提供者名称
   * @returns {Object|null} 提供者实例，未找到返回null
   */
  get(name) {
    return this._providers.get(name) ?? null;
  }

  /**
   * 获取所有已注册的提供者。
   *
   * @returns {Object.<string, Object>} 名称到提供者实例的映射
   */
  getAll() {
    const result = {};
    for (const [name, provider] of this._providers) {
      result[name] = provider;
    }
    return result;
  }

  /**
   * 获取所有已连接且健康的提供者。
   *
   * @returns {Object.<string, Object>} 名称到健康提供者实例的映射
   */
  getHealthy() {
    const result = {};
    for (const [name, provider] of this._providers) {
      if (typeof provider.isConnected === 'function' && provider.isConnected()) {
        result[name] = provider;
      }
    }
    return result;
  }

  /**
   * 按名称获取提供者实例（get的别名）。
   *
   * @param {string} name - 提供者名称
   * @returns {Object|null} 提供者实例，未找到返回null
   */
  getByName(name) {
    return this.get(name);
  }

  /**
   * 连接所有已注册的提供者。并行执行，单个失败不影响其他提供者。
   *
   * @returns {Promise<Object.<string, {connected: boolean, error: string|null}>>} 各提供者连接结果
   */
  async connectAll() {
    const results = {};
    const promises = [];
    for (const [name, provider] of this._providers) {
      promises.push(this._connectOne(name, provider, results));
    }
    await Promise.allSettled(promises);
    return results;
  }

  async _connectOne(name, provider, results) {
    try {
      if (typeof provider.connect === 'function') {
        await Promise.resolve(provider.connect());
      }
      results[name] = { connected: true, error: null };
    } catch (err) {
      const errorMsg = err && err.message ? err.message : String(err);
      results[name] = { connected: false, error: errorMsg };
      this._log('connectAll', name, errorMsg);
    }
  }

  /**
   * 断开所有已注册的提供者。并行执行，单个失败不影响其他提供者。
   *
   * @returns {Promise<Object.<string, {disconnected: boolean, error: string|null}>>} 各提供者断开结果
   */
  async disconnectAll() {
    const results = {};
    const promises = [];
    for (const [name, provider] of this._providers) {
      promises.push(this._disconnectOne(name, provider, results));
    }
    await Promise.allSettled(promises);
    return results;
  }

  async _disconnectOne(name, provider, results) {
    try {
      if (typeof provider.disconnect === 'function') {
        await Promise.resolve(provider.disconnect());
      }
      results[name] = { disconnected: true, error: null };
    } catch (err) {
      const errorMsg = err && err.message ? err.message : String(err);
      results[name] = { disconnected: false, error: errorMsg };
      this._log('disconnectAll', name, errorMsg);
    }
  }

  /**
   * 对所有已注册的提供者执行健康检查。并行执行，单个失败不影响其他提供者。
   *
   * @returns {Promise<Object.<string, {healthy: boolean, latency: number, error: string|null}>>} 各提供者健康检查结果
   */
  async healthCheckAll() {
    const results = {};
    const promises = [];
    for (const [name, provider] of this._providers) {
      promises.push(this._healthCheckOne(name, provider, results));
    }
    await Promise.allSettled(promises);
    return results;
  }

  async _healthCheckOne(name, provider, results) {
    try {
      if (typeof provider.healthCheck === 'function') {
        results[name] = await Promise.resolve(provider.healthCheck());
      } else {
        results[name] = { healthy: false, latency: -1, error: 'no healthCheck method' };
      }
    } catch (err) {
      const errorMsg = err && err.message ? err.message : String(err);
      results[name] = { healthy: false, latency: -1, error: errorMsg };
      this._log('healthCheckAll', name, errorMsg);
    }
  }

  /**
   * 获取注册表统计信息，包含总数、健康/不健康数量和各提供者状态。
   *
   * @returns {{total: number, healthy: number, unhealthy: number, byName: Object.<string, {healthy: boolean, connected: boolean}>}} 注册表统计
   */
  getStats() {
    const byName = {};
    for (const [name, provider] of this._providers) {
      const connected = typeof provider.isConnected === 'function' ? provider.isConnected() : false;
      const healthy = typeof provider.isHealthy === 'function' ? provider.isHealthy() : connected;
      byName[name] = { healthy, connected };
    }
    let totalHealthy = 0;
    let totalUnhealthy = 0;
    for (const entry of Object.values(byName)) {
      if (entry.healthy) totalHealthy++;
      else totalUnhealthy++;
    }
    return {
      total: this._providers.size,
      healthy: totalHealthy,
      unhealthy: totalUnhealthy,
      byName,
    };
  }

  _onShutdown() {
    safeCall(() => {
      for (const [_name, provider] of this._providers) {
        try {
          if (typeof provider.disconnect === 'function') Promise.resolve(provider.disconnect()).catch(function(_err) { debug('ProviderRegistry', 'disconnectReject', _err && _err.message ? _err.message : String(_err)); });
        } catch (_e) { this._log('shutdown_disconnect', _e && _e.message ? _e.message : String(_e)); }
      }
    }, 'ProviderRegistry', 'shutdown');
    this._providers.clear();
    this._options.clear();
    this.removeAllListeners();
  }
}

ProviderRegistry.REGISTRY_EVENTS = REGISTRY_EVENTS;

module.exports = withShutdown(ProviderRegistry);
