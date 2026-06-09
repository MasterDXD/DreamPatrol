'use strict';
const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');

/**
 * @constant {Object} TIER_ORDER - 模块层级排序映射，core=0, infrastructure=1, advanced=2
 */
const TIER_ORDER = { core: 0, infrastructure: 1, advanced: 2 };

/**
 * @constant {Object} MODULE_DEFS - 深化子系统模块定义表，包含所有模块的层级和路径信息
 * @property {string} tier - 模块层级（core/infrastructure/advanced）
 * @property {string} path - 模块相对路径
 * @property {boolean} [deprecated] - 是否已废弃
 * @property {string} [replacement] - 替代模块名称
 */
const MODULE_DEFS = {
  'quality-scorer': { tier: 'core', path: '../quality/quality-scorer' },
  'ai-code-trust-scorer': { tier: 'core', path: '../quality/ai-code-trust-scorer' },
  'comprehension-debt-tracker': { tier: 'core', path: '../quality/comprehension-debt-tracker' },
  'delivery-efficiency-meter': { tier: 'core', path: '../quality/delivery-efficiency-meter' },
  'recurrent-deepening-scheduler': { tier: 'core', path: './recurrent-deepening-scheduler' },
  'adaptive-depth-controller': { tier: 'core', path: './adaptive-depth-controller' },
  'multi-agent-router': { tier: 'core', path: '../agent/multi-agent-router' },
  'output-fusion': { tier: 'core', path: '../collaboration/output-fusion' },
  'lti-context-injector': { tier: 'core', path: '../context/lti-context-injector' },
  'iterative-refinement': { tier: 'core', path: './iterative-refinement' },
  'progressive-deepening': { tier: 'core', path: './progressive-deepening' },
  'deepening-orchestrator': { tier: 'core', path: './deepening-orchestrator' },
  'ooda-loop': { tier: 'core', path: './ooda-loop' },
  'token-aware-deepening': { tier: 'core', path: './token-aware-deepening' },
  'affinity-learner': { tier: 'core', path: '../user/affinity-learner' },
  'convergence-detector': { tier: 'core', path: './convergence-detector' },
  'deepening-metrics-collector': { tier: 'core', path: './deepening-metrics-collector' },
  'deepening-cache': { tier: 'core', path: './deepening-cache' },
  'deepening-strategy-plugin': { tier: 'core', path: './deepening-strategy-plugin' },
  'deepening-report-generator': { tier: 'core', path: './deepening-report-generator' },
  'deepening-pipeline': { tier: 'core', path: './deepening-pipeline' },
  'deepening-health-monitor': { tier: 'core', path: './deepening-health-monitor', deprecated: true, replacement: 'HealthChecker' },
  'deepening-event-store': { tier: 'core', path: './deepening-event-store' },
  'deepening-workflow-template': { tier: 'core', path: './deepening-workflow-template', deprecated: true, replacement: 'WorkflowTemplate' },
  'deepening-benchmark': { tier: 'core', path: './deepening-benchmark' },
  'deepening-circuit-breaker': { tier: 'infrastructure', path: './deepening-circuit-breaker' },
  'deepening-connection-pool': { tier: 'advanced', path: './deepening-connection-pool' },
  'deepening-rate-limiter': { tier: 'infrastructure', path: './deepening-rate-limiter' },
  'deepening-lock-manager': { tier: 'infrastructure', path: './deepening-lock-manager' },
  'deepening-config-manager': { tier: 'infrastructure', path: './deepening-config-manager' },
  'deepening-event-bus': { tier: 'infrastructure', path: './deepening-event-bus', deprecated: true, replacement: 'EventBus' },
  'deepening-validator': { tier: 'infrastructure', path: './deepening-validator' },
  'deepening-notifier': { tier: 'infrastructure', path: './deepening-notifier' },
  'deepening-feature-flags': { tier: 'infrastructure', path: './deepening-feature-flags' },
  'deepening-priority-queue': { tier: 'infrastructure', path: './deepening-priority-queue', deprecated: true, replacement: 'PriorityQueue' },
  'deepening-throttle': { tier: 'infrastructure', path: './deepening-throttle' },
  'deepening-load-balancer': { tier: 'infrastructure', path: './deepening-load-balancer' },
  'deepening-retry-policy': { tier: 'infrastructure', path: './deepening-retry-policy' },
  'deepening-task-queue': { tier: 'infrastructure', path: './deepening-task-queue' },
  'deepening-snapshot-store': { tier: 'infrastructure', path: './deepening-snapshot-store' },
  'deepening-data-pipeline': { tier: 'infrastructure', path: './deepening-data-pipeline' },
  'deepening-dependency-resolver': { tier: 'infrastructure', path: './deepening-dependency-resolver' },
  'deepening-graceful-shutdown': { tier: 'infrastructure', path: './deepening-graceful-shutdown' },
  'deepening-task-scheduler': { tier: 'infrastructure', path: './deepening-task-scheduler' },
  'deepening-plugin-system': { tier: 'infrastructure', path: './deepening-plugin-system', deprecated: true, replacement: 'PluginManager' },
  'deepening-service-registry': { tier: 'infrastructure', path: './deepening-service-registry' },
  'deepening-security-guard': { tier: 'advanced', path: './deepening-security-guard' },
  'deepening-resource-manager': { tier: 'advanced', path: './deepening-resource-manager' },
  'deepening-snapshot': { tier: 'advanced', path: './deepening-snapshot' },
  'deepening-state-manager': { tier: 'advanced', path: './deepening-state-manager' },
  'deepening-deployment': { tier: 'advanced', path: './deepening-deployment' },
  'deepening-error-handler': { tier: 'advanced', path: './deepening-error-handler' },
  'deepening-event-replay': { tier: 'advanced', path: './deepening-event-replay' },
  'deepening-metrics-aggregator': { tier: 'advanced', path: './deepening-metrics-aggregator' },
  'deepening-state-machine': { tier: 'advanced', path: './deepening-state-machine' },
  'deepening-timeout-manager': { tier: 'advanced', path: './deepening-timeout-manager' },
  'deepening-visualizer': { tier: 'advanced', path: './deepening-visualizer' },
  'deepening-audit-trail': { tier: 'advanced', path: './deepening-audit-trail' },
  'deepening-backpressure-manager': { tier: 'advanced', path: './deepening-backpressure-manager' },
};

/**
 * @constant {Object} _TIER_TOTALS - 各层级模块总数统计
 * @property {number} core - 核心层模块数
 * @property {number} infrastructure - 基础设施层模块数
 * @property {number} advanced - 高级层模块数
 */
const _TIER_TOTALS = { core: 0, infrastructure: 0, advanced: 0 };
for (const def of Object.values(MODULE_DEFS)) {
  _TIER_TOTALS[def.tier] = (_TIER_TOTALS[def.tier] ?? 0) + 1;
}

/**
 * @constant {number} _TOTAL_DEFINED - 已定义模块总数
 */
const _TOTAL_DEFINED = Object.keys(MODULE_DEFS).length;

/**
 * @module runtime/deepening/deepening-module-registry
 * 分层模块注册表。管理三个层级（core/infrastructure/advanced）的懒加载模块实例，
 * 支持深度感知加载、废弃警告和生命周期感知关闭。
 */

/**
 * @classdesc 深化模块注册表。模块发现、注册、依赖管理
 *
 * 分层模块注册表 — 为深化子系统提供三层级模块的懒加载注册与生命周期管理。
 * 管理三个层级（core/infrastructure/advanced）的懒加载模块实例，
 * 支持深度感知加载（根据深化深度级别按需加载对应层级模块）、
 * 废弃警告（已废弃模块自动发出替代提示）和生命周期感知关闭。
 *
 * @extends DeepeningBase
 * @emits 'modules-loaded' 当层级模块批量加载完成时触发，附带 {loaded, tierLevels}
 * @emits 'deprecation-warning' 当访问已废弃模块时触发，附带 {module, replacement}
 * @emits 'module-unloaded' 当模块卸载时触发，附带 {moduleName}
 */
class DeepeningModuleRegistry extends DeepeningBase {
  /**
   * 模块层级枚举。
   * @constant {Object}
   * @property {string} CORE - 核心层
   * @property {string} INFRASTRUCTURE - 基础设施层
   * @property {string} ADVANCED - 高级层
   */
  static MODULE_TIERS = { CORE: 'core', INFRASTRUCTURE: 'infrastructure', ADVANCED: 'advanced' };

  /**
   * 创建 DeepeningModuleRegistry 实例。
   * @param {Object} [config] - 配置对象
   */
  constructor(config) {
    super(config);
    this._config = config ?? {};
    this._instances = new Map();
    this._maxInstances = 200;
    this._lazyLoads = 0;
    this._currentDepthLevel = 'none';
    this._tierLoadedCounts = { core: 0, infrastructure: 0, advanced: 0 };
  }

  /**
   * 获取所有已加载模块的名称列表。
   * @returns {Array<string>} 已加载模块名称数组
   */
  listLoaded() { return Array.from(this._instances.keys()); }

  /**
   * 获取所有可用模块的名称列表（包括未加载的）。
   * @returns {Array<string>} 可用模块名称数组
   */
  listAvailable() { return Object.keys(MODULE_DEFS); }

  /**
   * 加载核心层模块。
   * @returns {Array<string>} 本次加载的模块名称数组
   */
  loadCore() { return this._loadTier('core', 'quick'); }

  /**
   * 根据深度级别加载对应层级的模块。quick=核心层，standard=基础设施层，其他=高级层。
   * @param {string} level - 深度级别：'quick' | 'standard' | 其他
   * @returns {Array<string>} 本次加载的模块名称数组
   */
  loadForDepth(level) {
    if (level === 'quick') return this._loadTier('core', level);
    if (level === 'standard') return this._loadTier('infrastructure', level);
    return this._loadTier('advanced', level);
  }

  /**
   * 加载指定层级及以下的所有未加载模块。
   * @param {string} maxTier - 最大加载层级
   * @param {string} depthLevel - 当前深度级别标识
   * @returns {Array<string>} 本次加载的模块名称数组
   * @emits 'modules-loaded' 层级模块批量加载完成时触发，附带 {loaded, tierLevels}
   * @private
   */
  _loadTier(maxTier, depthLevel) {
    const maxOrder = TIER_ORDER[maxTier];
    const loaded = [];
    for (const [name, def] of Object.entries(MODULE_DEFS)) {
      if (TIER_ORDER[def.tier] <= maxOrder && !this._instances.has(name)) {
        try { this.get(name); loaded.push(name); } catch (loadErr) { debug('DeepeningModuleRegistry', 'loadTier:' + name, loadErr); emitError(this, 'tier-load-error', loadErr, { moduleName: name }); }
      }
    }
    this._currentDepthLevel = depthLevel;
    this.emit('modules-loaded', { loaded, tierLevels: maxTier });
    return loaded;
  }

  /**
   * 获取指定模块的实例（懒加载）。已废弃模块首次访问时发出废弃警告。
   * @param {string} name - 模块名称
   * @returns {Object|null} 模块实例，模块未定义或加载失败返回 null
   * @emits 'deprecation-warning' 访问已废弃模块时触发，附带 {module, replacement}
   */
  get(name) {
    if (!MODULE_DEFS[name]) return null;
    if (MODULE_DEFS[name].deprecated && !this._deprecationWarned) {
      this._deprecationWarned = this._deprecationWarned ?? new Set();
      if (!this._deprecationWarned.has(name)) {
        this._deprecationWarned.add(name);
        this.emit('deprecation-warning', { module: name, replacement: MODULE_DEFS[name].replacement });
      }
    }
    if (this._instances.has(name)) return this._instances.get(name);
    try {
      const mod = require(MODULE_DEFS[name].path);
      const Cls = mod.default || mod;
      const inst = typeof Cls === 'function' ? new Cls({}) : Cls;
      if (this._instances.size >= this._maxInstances && !this._instances.has(name)) {
        const oldest = this._instances.keys().next().value;
        const oldInst = this._instances.get(oldest);
        if (oldInst && typeof oldInst.shutdown === 'function') { try { const r = oldInst.shutdown(); if (r && typeof r.then === 'function') r.catch(_e => { debug('DeepeningModuleRegistry', 'evictShutdown', _e && _e.message ? _e.message : String(_e)); }); } catch (_e) { debug('DeepeningModuleRegistry', 'evictShutdown', _e && _e.message ? _e.message : String(_e)); } }
        this._instances.delete(oldest);
      }
      this._instances.set(name, inst);
      this._lazyLoads++;
      const tier = MODULE_DEFS[name].tier;
      if (tier) this._tierLoadedCounts[tier]++;
      return inst;
    } catch (e) { debug('DeepeningModuleRegistry', 'get:' + name, e); emitError(this, 'module-load-error', e, { moduleName: name }); return null; }
  }

  /**
   * 检查指定模块是否已加载。
   * @param {string} name - 模块名称
   * @returns {boolean} 已加载返回 true
   */
  has(name) { return this._instances.has(name); }

  /**
   * 获取或懒加载指定模块（get 方法的别名）。
   * @param {string} name - 模块名称
   * @returns {Object|null} 模块实例
   */
  getOrLoad(name) { return this.get(name); }

  /**
   * 卸载指定模块。
   * @param {string} name - 模块名称
   * @returns {boolean} 卸载成功返回 true，模块未加载返回 false
   * @emits 'module-unloaded' 模块卸载时触发，附带 {moduleName}
   */
  unload(name) {
    if (!this._instances.has(name)) return false;
    const inst = this._instances.get(name);
    if (inst && typeof inst.shutdown === 'function') { try { const r = inst.shutdown(); if (r && typeof r.then === 'function') r.catch(sErr => { debug('DeepeningModuleRegistry', 'unload shutdown', sErr); emitError(this, 'shutdown-error', sErr); }); } catch (sErr) { debug('DeepeningModuleRegistry', 'unload shutdown', sErr); emitError(this, 'shutdown-error', sErr); } }
    this._instances.delete(name);
    const tier = MODULE_DEFS[name] && MODULE_DEFS[name].tier;
    if (tier && this._tierLoadedCounts[tier] > 0) this._tierLoadedCounts[tier]--;
    this.emit('module-unloaded', { moduleName: name });
    return true;
  }

  /**
   * 卸载指定层级的所有模块。
   * @param {string} tier - 层级名称（core/infrastructure/advanced）
   * @returns {number} 卸载的模块数量
   */
  unloadTier(tier) {
    let count = 0;
    for (const [name, def] of Object.entries(MODULE_DEFS)) {
      if (def.tier === tier && this._instances.has(name)) {
        const inst = this._instances.get(name);
        if (inst && typeof inst.shutdown === 'function') { try { const r = inst.shutdown(); if (r && typeof r.then === 'function') r.catch(sErr => { debug('DeepeningModuleRegistry', 'unloadTier shutdown', sErr); }); } catch (sErr) { debug('DeepeningModuleRegistry', 'unloadTier shutdown', sErr); } }
        this._instances.delete(name);
        count++;
      }
    }
    this._tierLoadedCounts[tier] = 0;
    return count;
  }

  /**
   * 检查指定模块是否在定义表中。
   * @param {string} name - 模块名称
   * @returns {boolean} 已定义返回 true
   */
  isDefined(name) { return name in MODULE_DEFS; }

  /**
   * 获取指定模块的层级信息。
   * @param {string} name - 模块名称
   * @returns {string|null} 层级名称（core/infrastructure/advanced），未定义返回 null
   */
  getTier(name) { return MODULE_DEFS[name] ? MODULE_DEFS[name].tier : null; }

  /**
   * 获取模块注册表的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalDefined - 已定义模块总数
   * @returns {number} return.totalLoaded - 已加载模块数
   * @returns {string} return.currentDepthLevel - 当前深度级别
   * @returns {Object} return.loadedByTier - 各层级加载统计 {core, infrastructure, advanced}
   * @returns {number} return.lazyLoads - 懒加载次数
   */
  getStats() {
    const loadedByTier = {};
    for (const tierName of ['core', 'infrastructure', 'advanced']) {
      loadedByTier[tierName] = { loaded: this._tierLoadedCounts[tierName], total: _TIER_TOTALS[tierName] };
    }
    return {
      ...super.getStats(),
      totalDefined: _TOTAL_DEFINED,
      totalLoaded: this._instances.size,
      currentDepthLevel: this._currentDepthLevel,
      loadedByTier,
      lazyLoads: this._lazyLoads,
    };
  }

  /**
   * 关闭时的清理回调。依次关闭所有已加载模块并清空实例映射。
   * @protected
   */
  _onShutdown() {
    const promises = [];
    for (const [, inst] of this._instances) {
      if (inst && typeof inst.shutdown === 'function') {
        try {
          const r = inst.shutdown();
          if (r && typeof r.then === 'function') {
            promises.push(r.catch(function(sErr) {
              debug('DeepeningModuleRegistry', 'async shutdown', sErr);
              emitError(this, 'shutdown-error', sErr);
            }.bind(this)));
          }
        } catch (sErr) {
          debug('DeepeningModuleRegistry', 'shutdown', sErr);
          emitError(this, 'shutdown-error', sErr);
        }
      }
    }
    this._instances.clear();
    super._onShutdown();
    if (promises.length > 0) {
      return Promise.allSettled(promises);
    }
  }
}
module.exports = DeepeningModuleRegistry;
