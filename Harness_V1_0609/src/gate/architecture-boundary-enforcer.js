'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../utils/shutdown-mixin');
const { debug } = require('../utils/debug-logger');

/**
 * @module gate/architecture-boundary-enforcer
 * 架构边界执行器。强制模块级依赖方向约束，支持三种执行模式（strict/recommended/optional）
 * 和白名单覆盖。
 */

/** @constant {object} DEPENDENCY_RULES - 模块依赖规则矩阵 */
const DEPENDENCY_RULES = {
  gate: { allowedDeps: ['utils'] },
  permission: { allowedDeps: ['utils'] },
  runtime: { allowedDeps: ['utils'] },
  web: { allowedDeps: ['gate', 'permission', 'runtime', 'utils'] },
  utils: { allowedDeps: [] },
  errors: { allowedDeps: [] },
};

/** @constant {Array<{prefix: string, module: string}>} PATH_MODULE_MAP - 文件路径前缀到模块的映射 */
const PATH_MODULE_MAP = [
  { prefix: 'src/gate/', module: 'gate' },
  { prefix: 'src/permission/', module: 'permission' },
  { prefix: 'src/runtime/', module: 'runtime' },
  { prefix: 'src/web/', module: 'web' },
  { prefix: 'src/utils/', module: 'utils' },
  { prefix: 'src/errors/', module: 'errors' },
];

/** @constant {object} ENFORCEMENT_MODES - 执行模式枚举 */
const ENFORCEMENT_MODES = {
  STRICT: 'strict',
  RECOMMENDED: 'recommended',
  OPTIONAL: 'optional',
};

/** @constant {object} BOUNDARY_RULES - 边界规则枚举 */
const BOUNDARY_RULES = {
  NO_UPWARD_IMPORT: 'no_upward_import',
  NO_CROSS_DOMAIN: 'no_cross_domain',
  NO_CIRCULAR: 'no_circular',
  SINGLE_RESPONSIBILITY: 'single_responsibility',
};

/** @constant {number} DEFAULT_MAX_WHITELIST - 白名单默认最大条目数 */
const DEFAULT_MAX_WHITELIST = 100;

/**
 * @classdesc 架构边界执行器。模块间依赖方向约束矩阵
 * 架构边界执行器。强制模块级依赖方向约束，使用可配置的规则矩阵
 * （gate、permission、runtime、web、utils、errors），支持三种执行模式
 * （strict、recommended、optional）、白名单覆盖和违规追踪。
 * @extends EventEmitter
 * @emits violation | whitelist:added
 */
class ArchitectureBoundaryEnforcer extends EventEmitter {
  /**
   * 创建ArchitectureBoundaryEnforcer实例。
   * @param {object} [options] - 配置选项
   * @param {'strict'|'recommended'|'optional'} [options.mode='recommended'] - 执行模式
   * @param {number} [options.maxViolations=1000] - 最大违规记录数
   * @param {number} [options.maxWhitelist=100] - 最大白名单条目数
   */
  constructor(options) {
    super();
    this._whitelistMap = new Map();
    this._violations = [];
    this._mode = (options ?? {}).mode ?? ENFORCEMENT_MODES.RECOMMENDED;
    this._maxViolations = typeof (options ?? {}).maxViolations === 'number' && Number.isFinite((options ?? {}).maxViolations) ? (options ?? {}).maxViolations : 1000;
    this._maxWhitelist = typeof (options ?? {}).maxWhitelist === 'number' && Number.isFinite((options ?? {}).maxWhitelist) ? (options ?? {}).maxWhitelist : DEFAULT_MAX_WHITELIST;
  }

  /**
   * 根据文件路径判断所属模块。
   * @param {string} filePath - 文件路径
   * @returns {string|null} 模块名称，无法识别时返回null
   */
  getModuleForPath(filePath) {
    if (!filePath || typeof filePath !== 'string') return null;
    const normalized = filePath.replace(/\\/g, '/');
    for (let i = 0; i < PATH_MODULE_MAP.length; i++) {
      if (normalized.startsWith(PATH_MODULE_MAP[i].prefix)) {
        return PATH_MODULE_MAP[i].module;
      }
    }
    return null;
  }

  /**
   * 检查从源模块到目标模块的依赖是否被允许。
   * @param {string|null} fromModule - 源模块
   * @param {string|null} toModule - 目标模块
   * @returns {boolean} 依赖是否被允许
   */
  isDependencyAllowed(fromModule, toModule) {
    if (fromModule === null || toModule === null) {
      debug('ArchitectureBoundaryEnforcer', 'isDependencyAllowed', 'Unknown module: from=' + fromModule + ' to=' + toModule);
      return true;
    }
    if (fromModule === toModule) return true;
    if (this._whitelistMap.has(fromModule + '->' + toModule)) return true;
    const rule = DEPENDENCY_RULES[fromModule];
    if (!rule) {
      debug('ArchitectureBoundaryEnforcer', 'isDependencyAllowed', 'Unrecognized module: ' + fromModule);
      return true;
    }
    return rule.allowedDeps.includes(toModule);
  }

  /**
   * 添加白名单条目，允许特定模块间的依赖。
   * @param {string} fromModule - 源模块
   * @param {string} toModule - 目标模块
   * @emits ArchitectureBoundaryEnforcer#whitelist:added
   * @returns {void}
   */
  addWhitelistEntry(fromModule, toModule) {
    this.guardShutdown();
    const key = fromModule + '->' + toModule;
    if (this._whitelistMap.has(key)) return;
    if (this._whitelistMap.size >= this._maxWhitelist) {
      debug('ArchitectureBoundaryEnforcer', 'addWhitelistEntry', 'Whitelist capacity reached: ' + this._maxWhitelist);
      return;
    }
    this._whitelistMap.set(key, { from: fromModule, to: toModule });
    this.emit('whitelist:added', { from: fromModule, to: toModule });
  }

  /**
   * 检查文件的所有依赖是否违反架构边界规则。
   * @param {string} filePath - 文件路径
   * @param {string[]} deps - 依赖路径列表
   * @returns {Array<{fromModule: string, toModule: string, filePath: string, dependency: string}>} 违规列表
   * @emits ArchitectureBoundaryEnforcer#violation
   */
  checkFile(filePath, deps) {
    this.guardShutdown();
    if (!Array.isArray(deps)) return [];
    const fromModule = this.getModuleForPath(filePath);
    const violations = [];
    for (let i = 0; i < deps.length; i++) {
      const toModule = this.getModuleForPath(deps[i]);
      if (!this.isDependencyAllowed(fromModule, toModule)) {
        const violation = {
          fromModule: fromModule,
          toModule: toModule,
          filePath: filePath,
          dependency: deps[i],
        };
        violations.push(violation);
        this._violations.push(violation);
        if (this._violations.length > this._maxViolations) {
          this._violations.shift();
        }
        this.emit('violation', violation);
      }
    }
    if (violations.length > 0 && this._mode === ENFORCEMENT_MODES.STRICT) {
      const err = new Error('Architecture boundary violation in ' + filePath + ': ' + violations.map(function(v) { return v.fromModule + '->' + v.toModule; }).join(', '));
      err.violations = violations;
      throw err;
    }
    return violations;
  }

  /**
   * 获取当前执行模式。
   * @returns {'strict'|'recommended'|'optional'} 执行模式
   */
  getMode() {
    return this._mode;
  }

  /**
   * 获取依赖规则矩阵。
   * @returns {object} 依赖规则对象
   */
  getRules() {
    return DEPENDENCY_RULES;
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
    this._whitelistMap.clear();
    this.removeAllListeners();
  }
}

module.exports = withShutdown(ArchitectureBoundaryEnforcer);
Object.assign(module.exports, { ArchitectureBoundaryEnforcer, DEPENDENCY_RULES, ENFORCEMENT_MODES, BOUNDARY_RULES });
