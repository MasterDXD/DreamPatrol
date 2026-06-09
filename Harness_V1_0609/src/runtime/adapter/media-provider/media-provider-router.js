'use strict';

/**
 * @module runtime/adapter/media-provider/media-provider-router
 * MediaProviderRouter — 媒体生成提供商路由器。
 * 自动选择最优Provider，支持多种路由策略和故障转移。
 */

const { EventEmitter } = require('events');
const { debug } = require('../../../utils/debug-logger');
const { withShutdown } = require('../../../utils/shutdown-mixin');
const BoundedMap = require('../../../utils/bounded-map');

const ROUTING_STRATEGIES = {
  COST_OPTIMAL: 'cost-optimal',
  QUALITY_OPTIMAL: 'quality-optimal',
  SPEED_OPTIMAL: 'speed-optimal',
  ROUND_ROBIN: 'round-robin',
  FAILFAST: 'failfast',
};

/**
 * 媒体生成提供商路由器。自动选择最优Provider，支持多种路由策略和故障转移。
 * 管理多个Provider的生命周期，不使用withShutdown，使用独立的shutdown方法。
 *
 * @classdesc 媒体提供者路由器，根据请求类型和可用性将媒体请求分发到合适的提供者
 * @extends EventEmitter
 * @emits MediaProviderRouter#provider-registered Provider注册时触发
 * @emits MediaProviderRouter#provider-unregistered Provider注销时触发
 * @emits MediaProviderRouter#routed 请求路由时触发
 * @emits MediaProviderRouter#fallback 故障转移时触发
 */
class MediaProviderRouter extends EventEmitter {
  /**
   * 创建MediaProviderRouter实例。
   *
   * @param {Object} [config] - 路由器配置
   * @param {string} [config.strategy='cost-optimal'] - 路由策略
   */
  constructor(config) {
    super();
    this._providers = new Map();
    this._strategy = (config && config.strategy) || ROUTING_STRATEGIES.COST_OPTIMAL;
    this._roundRobinIndex = 0;
    this._healthStatus = new BoundedMap(50);
    this._stats = { totalRouted: 0, byProvider: {}, fallbacks: 0 };
    this._log = debug('MediaProviderRouter');
  }

  /**
   * 注册Provider。
   *
   * @param {Object} provider - Provider实例（需实现MediaProviderInterface）
   * @throws {Error} Provider无效或缺少name属性时抛出
   */
  registerProvider(provider) {
    this.guardShutdown();
    if (!provider || typeof provider !== 'object') throw new Error('Invalid provider');
    if (!provider.name) throw new Error('Provider must have a name');
    this._providers.set(provider.name, provider);
    this._stats.byProvider[provider.name] = 0;
    this.emit('provider-registered', { provider: provider.name });
    this._log('registerProvider', provider.name);
  }

  /**
   * 注销Provider。
   *
   * @param {string} name - Provider名称
   * @returns {boolean} 注销成功返回true
   */
  unregisterProvider(name) {
    this.guardShutdown();
    if (!name || !this._providers.has(name)) return false;
    this._providers.delete(name);
    this._healthStatus.delete(name);
    delete this._stats.byProvider[name];
    this.emit('provider-unregistered', { provider: name });
    this._log('unregisterProvider', name);
    return true;
  }

  /**
   * 路由请求到最优Provider。支持故障转移（FAILFAST策略除外）。
   *
   * @param {Object} request - 生成请求
   * @param {string} request.prompt - 文本描述
   * @param {string} [request.mode] - 生成模式
   * @param {Object} [request.options] - Provider特定选项
   * @returns {Promise<{taskId: string, status: string, provider: string}>}
   * @throws {Error} 无可用Provider时抛出
   */
  async route(request) {
    this.guardShutdown();
    const available = this._getAvailableProviders(request && request.mode);
    if (available.length === 0) {
      throw new Error('No available provider for mode: ' + (request && request.mode ? request.mode : '(unknown)'));
    }

    const selected = this._selectProvider(available);
    try {
      const result = await selected.generate(request);
      this._stats.totalRouted++;
      this._stats.byProvider[selected.name] = (this._stats.byProvider[selected.name] ?? 0) + 1;
      this.emit('routed', { provider: selected.name, taskId: result && result.taskId });
      return Object.assign({}, result, { provider: selected.name });
    } catch (err) {
      if (this._strategy === ROUTING_STRATEGIES.FAILFAST) throw err;
      const fallback = available.find(function(p) { return p.name !== selected.name; });
      if (fallback) {
        this._stats.fallbacks++;
        this._log('route fallback', { from: selected.name, to: fallback.name });
        const fallbackResult = await fallback.generate(request);
        this._stats.totalRouted++;
        this._stats.byProvider[fallback.name] = (this._stats.byProvider[fallback.name] ?? 0) + 1;
        this.emit('fallback', { from: selected.name, to: fallback.name });
        this.emit('routed', { provider: fallback.name, taskId: fallbackResult && fallbackResult.taskId });
        return Object.assign({}, fallbackResult, { provider: fallback.name });
      }
      throw err;
    }
  }

  /**
   * 健康检查所有Provider。
   *
   * @returns {Promise<Object.<string, {healthy: boolean, latency: number}>>}
   */
  async checkAllHealth() {
    this.guardShutdown();
    const results = {};
    const entries = Array.from(this._providers.entries());
    for (const [name, provider] of entries) {
      try {
        const health = await provider.healthCheck();
        results[name] = health;
        this._healthStatus.set(name, { healthy: health.healthy, latency: health.latency, checkedAt: Date.now() });
      } catch (err) {
        results[name] = { healthy: false, latency: -1, error: err && err.message ? err.message : String(err) };
        this._healthStatus.set(name, { healthy: false, latency: -1, checkedAt: Date.now() });
      }
    }
    return results;
  }

  /**
   * 获取路由统计。
   *
   * @returns {{totalRouted: number, byProvider: Object.<string, number>, fallbacks: number, strategy: string, providerCount: number}}
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { totalRouted: 0, byProvider: {}, fallbacks: 0, strategy: this._strategy, providerCount: 0 };
    }
    return {
      totalRouted: this._stats.totalRouted,
      byProvider: Object.assign({}, this._stats.byProvider),
      fallbacks: this._stats.fallbacks,
      strategy: this._strategy,
      providerCount: this._providers.size,
    };
  }

  /**
   * 获取所有已注册Provider。
   *
   * @returns {Object[]} Provider实例数组
   */
  getProviders() {
    this.guardShutdown();
    return Array.from(this._providers.values());
  }

  /**
   * 获取指定名称的Provider。
   *
   * @param {string} name - Provider名称
   * @returns {Object|null} Provider实例，不存在返回null
   */
  getProvider(name) {
    this.guardShutdown();
    return this._providers.get(name) ?? null;
  }

  /**
   * 获取当前路由策略。
   *
   * @type {string}
   */
  get strategy() {
    return this._strategy;
  }

  /**
   * 设置路由策略。
   *
   * @param {string} strategy - 路由策略
   * @throws {Error} 无效策略时抛出
   */
  set strategy(strategy) {
    const valid = Object.values(ROUTING_STRATEGIES);
    if (!valid.includes(strategy)) throw new Error('Invalid strategy: ' + strategy);
    this._strategy = strategy;
  }

  /**
   * 获取可用Provider列表，过滤已关闭和不支持指定模式的Provider。
   *
   * @param {string} [mode] - 所需模式
   * @returns {Object[]} 可用Provider列表
   * @private
   */
  _getAvailableProviders(mode) {
    const available = [];
    for (const [, provider] of this._providers) {
      if (provider._shutDown) continue;
      try {
        const caps = provider.getCapabilities();
        if (mode && caps.modes && !caps.modes.includes(mode)) continue;
      } catch (_err) {
        debug('MediaProviderRouter', 'getProvidersByMode:getCapabilities', _err && _err.message ? _err.message : String(_err));
        continue;
      }
      available.push(provider);
    }
    return available;
  }

  /**
   * 根据路由策略选择Provider。
   *
   * @param {Object[]} available - 可用Provider列表
   * @returns {Object} 选中的Provider
   * @private
   */
  _selectProvider(available) {
    if (!available || available.length === 0) return null;
    switch (this._strategy) {
      case ROUTING_STRATEGIES.ROUND_ROBIN:
        return available[this._roundRobinIndex++ % available.length];
      case ROUTING_STRATEGIES.SPEED_OPTIMAL:
        return this._selectByHealth(available);
      case ROUTING_STRATEGIES.QUALITY_OPTIMAL:
        return available[0];
      case ROUTING_STRATEGIES.COST_OPTIMAL:
      default:
        return available[available.length - 1];
    }
  }

  /**
   * 按健康状态选择延迟最低的Provider。
   *
   * @param {Object[]} available - 可用Provider列表
   * @returns {Object} 选中的Provider
   * @private
   */
  _selectByHealth(available) {
    let best = available[0];
    let bestLatency = Infinity;
    for (const provider of available) {
      const health = this._healthStatus.get(provider.name);
      if (health && health.healthy && health.latency < bestLatency) {
        bestLatency = health.latency;
        best = provider;
      }
    }
    return best;
  }

  /**
   * 关闭路由器，断开所有Provider连接并清理资源。
   */
  _onShutdown() {
    const disconnectPromises = [];
    for (const [, provider] of this._providers) {
      if (provider.disconnect) {
        disconnectPromises.push(Promise.resolve(provider.disconnect()).catch(function(_err) {
          debug('MediaProviderRouter', 'shutdown_disconnect', _err && _err.message ? _err.message : String(_err));
        }));
      }
      if (typeof provider.shutdown === 'function') {
        try { provider.shutdown(); } catch (_e) { debug('MediaProviderRouter', '_onShutdown:providerShutdown', _e && _e.message ? _e.message : String(_e)); }
      }
    }
    this._providers.clear();
    this._healthStatus.shutdown();
    this._stats = { totalRouted: 0, byProvider: {}, fallbacks: 0 };
    this.removeAllListeners();
    return Promise.all(disconnectPromises).catch(() => {});
  }
}

MediaProviderRouter.ROUTING_STRATEGIES = ROUTING_STRATEGIES;

module.exports = { MediaProviderRouter: withShutdown(MediaProviderRouter), ROUTING_STRATEGIES };
