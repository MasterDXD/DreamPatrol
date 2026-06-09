'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../utils/shutdown-mixin');
const { debug } = require('../utils/debug-logger');

/**
 * @module gate/layer-boundary-guard
 * 层级边界守卫。强制四层架构依赖方向（交互层→业务层→领域层→基础设施层），
 * 通过文件路径映射到层级并检测跨层导入违规。
 */

/** @constant {object} LAYERS - 四层架构层级定义 */
const LAYERS = {
  interaction: { level: 3 },
  business: { level: 2 },
  domain: { level: 1 },
  infrastructure: { level: 0 },
};

/** @constant {string[]} LAYER_ORDER - 层级排序（从高到低） */
const LAYER_ORDER = ['interaction', 'business', 'domain', 'infrastructure'];

const MAX_VIOLATIONS = 1000;

/** @constant {Array<{prefix: string, layer: string}>} PATH_PREFIX_MAP - 文件路径前缀到层级的映射 */
const PATH_PREFIX_MAP = [
  { prefix: 'src/web/', layer: 'interaction' },
  { prefix: 'src/runtime/workflow/', layer: 'business' },
  { prefix: 'src/runtime/collaboration/', layer: 'business' },
  { prefix: 'src/runtime/agent/', layer: 'domain' },
  { prefix: 'src/runtime/causal/', layer: 'domain' },
  { prefix: 'src/runtime/context/', layer: 'domain' },
  { prefix: 'src/runtime/deepening/', layer: 'domain' },
  { prefix: 'src/runtime/model/', layer: 'domain' },
  { prefix: 'src/runtime/quality/', layer: 'domain' },
  { prefix: 'src/runtime/session/', layer: 'domain' },
  { prefix: 'src/runtime/skill/', layer: 'domain' },
  { prefix: 'src/runtime/thought/', layer: 'domain' },
  { prefix: 'src/runtime/user/', layer: 'domain' },
  { prefix: 'src/runtime/infrastructure/', layer: 'infrastructure' },
  { prefix: 'src/utils/', layer: 'infrastructure' },
];

/** @constant {object} LAYER_DEFINITIONS - 模块层级定义和允许的依赖 */
const LAYER_DEFINITIONS = {
  runtime: { level: 0, allowedDeps: [] },
  gate: { level: 1, allowedDeps: ['runtime'] },
  permission: { level: 1, allowedDeps: ['runtime'] },
  web: { level: 2, allowedDeps: ['runtime', 'gate', 'permission'] },
  utils: { level: -1, allowedDeps: [] },
};

/** @constant {object} VIOLATION_TYPES - 违规类型枚举 */
const VIOLATION_TYPES = {
  CROSS_LAYER_IMPORT: 'cross_layer_import',
  CIRCULAR_DEPENDENCY: 'circular_dependency',
  UNREGISTERED_LAYER: 'unregistered_layer',
  DIRECTION_VIOLATION: 'direction_violation',
};

/**
 * @classdesc 层级边界守卫。四层架构依赖方向强制
 * 层级边界守卫。强制四层架构依赖方向（交互层→业务层→领域层→基础设施层），
 * 通过文件路径映射到层级并检测跨层导入违规，确保高层不反向依赖低层。
 * @extends EventEmitter
 * @emits violation
 */
class LayerBoundaryGuard extends EventEmitter {
  /**
   * 创建LayerBoundaryGuard实例。
   * @param {object} [options] - 配置选项
   * @param {boolean} [options.strict=false] - 是否启用严格模式
   */
  constructor(options) {
    super();
    this._violations = [];
    this._strict = (options ?? {}).strict ?? false;
  }

  /**
   * 根据文件路径判断所属层级。
   * @param {string} modulePath - 模块文件路径
   * @returns {string|null} 层级名称（interaction/business/domain/infrastructure），无法识别时返回null
   */
  getLayerForPath(modulePath) {
    if (!modulePath || typeof modulePath !== 'string') return null;
    const normalized = modulePath.replace(/\\/g, '/');
    for (let i = 0; i < PATH_PREFIX_MAP.length; i++) {
      if (normalized.startsWith(PATH_PREFIX_MAP[i].prefix)) {
        return PATH_PREFIX_MAP[i].layer;
      }
    }
    return null;
  }

  /**
   * 检查从源层级到目标层级的依赖是否被允许。高层可以依赖低层，同层可互相依赖。
   * @param {string|null} fromLayer - 源层级
   * @param {string|null} toLayer - 目标层级
   * @returns {boolean} 依赖是否被允许
   */
  isDependencyAllowed(fromLayer, toLayer) {
    if (fromLayer === null || toLayer === null) {
      debug('LayerBoundaryGuard', 'isDependencyAllowed', 'Unknown layer: from=' + fromLayer + ' to=' + toLayer);
      return true;
    }
    if (fromLayer === toLayer) return true;
    const fromDef = LAYERS[fromLayer];
    const toDef = LAYERS[toLayer];
    if (!fromDef || !toDef) {
      debug('LayerBoundaryGuard', 'isDependencyAllowed', 'Unrecognized layer: from=' + fromLayer + ' to=' + toLayer);
      return true;
    }
    return fromDef.level >= toDef.level;
  }

  /**
   * 检查文件的所有依赖是否违反层级边界规则。
   * @param {string} filePath - 文件路径
   * @param {string[]} deps - 依赖路径列表
   * @returns {Array<{fromLayer: string, toLayer: string, filePath: string, dependency: string}>} 违规列表
   * @emits LayerBoundaryGuard#violation
   */
  checkFile(filePath, deps) {
    this.guardShutdown();
    if (!Array.isArray(deps)) return [];
    const fromLayer = this.getLayerForPath(filePath);
    const violations = [];
    for (let i = 0; i < deps.length; i++) {
      const toLayer = this.getLayerForPath(deps[i]);
      if (!this.isDependencyAllowed(fromLayer, toLayer)) {
        const violation = {
          fromLayer: fromLayer,
          toLayer: toLayer,
          filePath: filePath,
          dependency: deps[i],
        };
        violations.push(violation);
        this._violations.push(violation);
        if (this._violations.length > MAX_VIOLATIONS) this._violations.shift();
        this.emit('violation', violation);
      }
    }
    if (violations.length > 0 && this._strict) {
      const err = new Error('Layer boundary violation in ' + filePath + ': ' + violations.map(function(v) { return v.fromLayer + '->' + v.toLayer; }).join(', '));
      err.violations = violations;
      throw err;
    }
    return violations;
  }

  /**
   * 获取所有违规记录的副本。
   * @returns {Array<object>} 违规列表
   */
  getViolations() {
    return this._violations.slice();
  }

  /**
   * 清空所有违规记录。
   * @returns {void}
   */
  clearViolations() {
    this._violations = [];
  }

  _onShutdown() {
    this._violations = [];
    this._strict = false;
    this.removeAllListeners();
  }

  /**
   * 获取层级定义。
   * @returns {object} 层级定义对象
   */
  getLayers() {
    return LAYERS;
  }

  /**
   * 获取层级排序。
   * @returns {string[]} 层级名称数组（从高到低）
   */
  getOrder() {
    return LAYER_ORDER;
  }
}

module.exports = withShutdown(LayerBoundaryGuard);
Object.assign(module.exports, { LayerBoundaryGuard, LAYERS, LAYER_ORDER, LAYER_DEFINITIONS, VIOLATION_TYPES });
