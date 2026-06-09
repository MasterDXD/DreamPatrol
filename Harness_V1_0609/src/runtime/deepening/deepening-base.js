'use strict';
const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { ShutdownMixin } = require('../../utils/shutdown-mixin');

/**
 * @constant {Array<{method: string, prop: string}>}
 * 可挂载依赖的定义列表，每项包含 attach 方法名和对应属性键名。
 */
const ATTACH_DEFS = [
  { method: 'attachSqliteStore', prop: '_sqliteStore' },
  { method: 'attachSignalPersistence', prop: '_signalPersistence' },
  { method: 'attachPatchApproval', prop: '_patchApproval' },
  { method: 'attachSessionManager', prop: '_sessionManager' },
  { method: 'attachPlanPersistence', prop: '_planPersistence' },
  { method: 'attachDeepeningOrchestrator', prop: '_deepeningOrchestrator' },
  { method: 'attachSubagentExecutor', prop: '_subagentExecutor' },
  { method: 'attachThoughtRetrieverCycle', prop: '_thoughtRetrieverCycle' },
  { method: 'attachCausalDataBus', prop: '_causalDataBus' },
  { method: 'attachModelSelector', prop: '_modelSelector' },
  { method: 'attachRBACEnforcer', prop: '_rbacEnforcer' },
  { method: 'attachContextManager', prop: '_contextManager' },
  { method: 'attachQualityScorer', prop: '_qualityScorer' },
  { method: 'attachConvergenceDetector', prop: '_convergenceDetector' },
  { method: 'attachScheduler', prop: '_scheduler' },
  { method: 'attachVectorIndex', prop: '_vectorIndex' },
  { method: 'attachConfigCausalValidator', prop: '_configCausalValidator' },
  { method: 'attachCausalBufferManager', prop: '_causalBufferManager' },
  { method: 'attachSkillRouter', prop: '_skillRouter' },
  { method: 'attachPhaseContextInjector', prop: '_phaseContextInjector' },
  { method: 'attachHealthChecker', prop: '_healthChecker' },
  { method: 'attachMetricsCollector', prop: '_metricsCollector' },
  { method: 'attachCache', prop: '_cache' },
  { method: 'attachStrategyPlugin', prop: '_strategyPlugin' },
  { method: 'attachReportGenerator', prop: '_reportGenerator' },
  { method: 'attachEventStore', prop: '_eventStore' },
  { method: 'attachGeneratorVerifier', prop: '_generatorVerifier' },
  { method: 'attachOodaLoop', prop: '_oodaLoop' },
];

/**
 * @constant {Map<string, {method: string, prop: string}>}
 * 依赖定义索引映射，以属性键名和方法名双向索引ATTACH_DEFS。
 */
const _ATTACH_INDEX = new Map();
for (const def of ATTACH_DEFS) {
  _ATTACH_INDEX.set(def.prop, def);
  _ATTACH_INDEX.set(def.method, def);
}

/**
 * @module runtime/deepening/deepening-base
 * 深化推理子系统抽象基类。提供依赖注入（attach方法）、健康检查、
 * 关闭生命周期管理和废弃警告工具。所有深化推理组件均继承此类。
 */
/**
 * @classdesc 深化推理子系统抽象基类。提供依赖注入（attach方法）、健康检查、
 * 关闭生命周期管理和废弃警告工具。所有深化推理组件均继承此类。
 *
 * @extends EventEmitter
 * @emits 'shutdown' 当实例关闭时触发
 */
class DeepeningBase extends EventEmitter {
  /**
   * 已发出废弃警告的类名集合，防止重复警告。
   * @static
   * @type {Set<string>}
   */
  static _deprecationWarnedSet = new Set();

  /**
   * 发出废弃警告，同一类名仅警告一次。
   * @static
   * @param {string} className - 已废弃的类名
   * @param {string} replacement - 推荐的替代类名
   * @param {string} moduleTag - 模块标签，用于日志定位
   */
  static _warnDeprecated(className, replacement, moduleTag) {
    if (DeepeningBase._deprecationWarnedSet.has(className)) return;
    DeepeningBase._deprecationWarnedSet.add(className);
    debug(moduleTag, 'deprecation', className + ' is deprecated. Use ' + replacement + ' instead.');
  }

  /**
   * 构造函数。
   * @param {Object} [options] - 配置选项
   */
  constructor(options) {
    super();
    this._options = options ?? {};
    this._shutDown = false;
    this._deps = {};
  }

  /**
   * 通用依赖注入方法，通过名称查找ATTACH_DEFS定义并挂载依赖。
   * @param {string} name - 依赖名称（不含'attach'前缀和下划线）
   * @param {*} dep - 要注入的依赖实例
   * @returns {DeepeningBase} 当前实例，支持链式调用
   */
  attach(name, dep) {
    const propKey = '_' + name;
    const methodKey = 'attach' + name.charAt(0).toUpperCase() + name.slice(1);
    const def = _ATTACH_INDEX.get(propKey) || _ATTACH_INDEX.get(methodKey);
    if (!def) return this;
    this[def.prop] = dep;
    this._deps[name] = dep;
    return this;
  }

  /**
   * 检查实例是否健康（未关闭）。
   * @returns {boolean} 健康状态
   */
  isHealthy() { return !this._shutDown; }

  /**
   * 获取指定键的资源锁（基类默认始终返回true）。
   * @param {string} _key - 资源键名
   * @returns {boolean} 是否成功获取
   */
  acquire(_key) { return true; }

  /**
   * 释放指定键的资源锁（基类默认始终返回true）。
   * @param {string} _key - 资源键名
   * @returns {boolean} 是否成功释放
   */
  release(_key) { return true; }

  /**
   * 获取实例可用性信息。
   * @returns {{ available: boolean }} 可用性对象
   */
  getAvailability() { return { available: this.isHealthy() }; }

  /**
   * 获取实例运行统计信息。
   * @returns {{ healthy: boolean, shutDown: boolean }} 统计信息对象
   */
  getStats() {
    return { healthy: this.isHealthy(), shutDown: this._shutDown };
  }

  /**
   * 关闭时的清理回调，清空所有挂载依赖并移除事件监听器。
   * @protected
   */
  _onShutdown() {
    for (const def of ATTACH_DEFS) {
      this[def.prop] = undefined;
    }
    this._deps = {};
    this.removeAllListeners();
  }
}

Object.assign(DeepeningBase.prototype, ShutdownMixin);

for (const def of ATTACH_DEFS) {
  DeepeningBase.prototype[def.method] = function(dep) {
    this[def.prop] = dep;
    this._deps[def.method] = dep;
    return this;
  };
}

/**
 * 可挂载依赖的公开定义，供外部查询可用依赖列表。
 * @static
 * @type {Array<{method: string, prop: string}>}
 */
DeepeningBase.ATTACHABLE_DEPS = ATTACH_DEFS;

module.exports = DeepeningBase;
