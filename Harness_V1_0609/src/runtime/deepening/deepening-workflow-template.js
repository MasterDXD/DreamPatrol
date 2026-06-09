'use strict';

/**
 * @module runtime/deepening/deepening-workflow-template
 * 深化推理子系统工作流模板管理模块。提供内置模板（code-review-deep、tdd-red-green、general-deepening、
 * security-audit、performance-optimization、refactoring）和自定义模板注册，生成带深度和迭代默认值的管道配置。
 * 已弃用，推荐使用runtime/workflow/workflow-template中的WorkflowTemplate。
 */

const { mergeConfig } = require('../../utils/safe-assign');
const DeepeningBase = require('./deepening-base');

/**
 * 深化推理工作流模板管理器。提供6种内置模板和自定义模板注册，
 * 生成带深度级别和迭代次数默认值的管道配置。
 *
 * @classdesc 深化工作流模板。预定义深化流程、参数化。
 * @extends DeepeningBase
 * @deprecated 推荐使用runtime/workflow/workflow-template中的WorkflowTemplate
 * @emits DeepeningWorkflowTemplate#template-registered - 自定义模板注册时触发
 */
class DeepeningWorkflowTemplate extends DeepeningBase {
  /** @constant {Object<string, string>} 模板类型枚举 */
  static TEMPLATE_TYPES = { CODE_REVIEW_DEEP: 'code-review-deep', TDD_RED_GREEN: 'tdd-red-green', GENERAL_DEEPENING: 'general-deepening', SECURITY_AUDIT: 'security-audit', PERFORMANCE_OPT: 'performance-optimization', REFACTORING: 'refactoring' };
  /**
   * 创建DeepeningWorkflowTemplate实例。初始化6种内置模板。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxCustom=50] - 最大自定义模板数
   */
  constructor() {
    super();
    DeepeningWorkflowTemplate._warnDeprecated('DeepeningWorkflowTemplate', 'WorkflowTemplate from runtime/workflow/workflow-template', 'deepening-workflow-template');
    this._builtIn = {
      'code-review-deep': { name: 'code-review-deep', stages: ['init', 'cache-check', 'iterative-execution', 'complete'], defaultDepth: 'intensive' },
      'tdd-red-green': { name: 'tdd-red-green', stages: ['init', 'cache-check', 'iterative-execution', 'complete'], defaultDepth: 'standard' },
      'general-deepening': { name: 'general-deepening', stages: ['init', 'cache-check', 'iterative-execution', 'complete'], defaultDepth: 'standard' },
      'security-audit': { name: 'security-audit', stages: ['init', 'cache-check', 'iterative-execution', 'complete'], defaultDepth: 'intensive' },
      'performance-optimization': { name: 'performance-optimization', stages: ['init', 'cache-check', 'iterative-execution', 'complete'], defaultDepth: 'standard' },
      'refactoring': { name: 'refactoring', stages: ['init', 'cache-check', 'iterative-execution', 'complete'], defaultDepth: 'standard' },
    };
    this._custom = new Map();
    this._maxCustom = 50;
  }

  /**
   * 根据模板类型获取模板定义。
   * @param {string} templateType - 模板类型标识
   * @returns {Object|null} 模板定义对象，未找到返回null
   */
  get(templateType) { return this._builtIn[templateType] ?? this._custom.get(templateType) ?? null; }

  /**
   * 列出所有可用模板（内置+自定义）。
   * @returns {Object[]} 模板列表，每个对象包含builtIn标记
   */
  list() {
    const builtInList = Object.keys(this._builtIn).map(key => ({
      ...this._builtIn[key],
      builtIn: true,
    }));
    const customList = Array.from(this._custom.entries()).map(([_key, val]) => ({
      ...val,
      builtIn: false,
    }));
    return [...builtInList, ...customList];
  }

  /**
   * 注册自定义模板。不允许覆盖内置模板。
   * @param {string} name - 模板名称
   * @param {Object} template - 模板定义，必须包含stages数组
   * @param {string[]} template.stages - 模板阶段列表
   * @returns {boolean} 注册成功返回true，参数无效或名称冲突返回false
   * @emits DeepeningWorkflowTemplate#template-registered
   */
  register(name, template) {
    this.guardShutdown();
    if (!name || typeof name !== 'string') return false;
    if (!template || typeof template !== 'object') return false;
    if (!Array.isArray(template.stages) || template.stages.length === 0) return false;
    if (this._builtIn[name]) return false;
    if (this._custom.size >= this._maxCustom && !this._custom.has(name)) {
      const oldest = this._custom.keys().next().value;
      this._custom.delete(oldest);
    }
    this._custom.set(name, template);
    this.emit('template-registered', { name });
    return true;
  }

  /**
   * 注销自定义模板。不允许注销内置模板。
   * @param {string} name - 模板名称
   * @returns {boolean} 注销成功返回true，内置模板或不存在返回false
   */
  unregister(name) {
    this.guardShutdown();
    if (this._builtIn[name]) return false;
    return this._custom.delete(name);
  }

  /**
   * 根据模板类型生成管道配置，支持覆盖参数。
   * @param {string} templateType - 模板类型标识
   * @param {Object} [overrides] - 覆盖参数
   * @returns {Object|null} 管道配置对象，模板不存在时返回null
   */
  createPipelineConfig(templateType, overrides) {
    const tpl = this.get(templateType);
    if (!tpl) return null;
    const config = {
      ...tpl,
      depthLevel: tpl.defaultDepth ?? tpl.depthLevel ?? 'standard',
      maxIterations: tpl.maxIterations ?? (tpl.defaultDepth === 'intensive' ? 4 : 2),
      templateType,
    };
    return mergeConfig(config, overrides ?? {});
  }

  /**
   * 获取模板管理器统计信息。
   * @returns {Object} 统计对象，包含builtInTemplates和customTemplates数量
   */
  getStats() {
    return {
      ...super.getStats(),
      builtInTemplates: Object.keys(this._builtIn).length,
      customTemplates: this._custom.size,
    };
  }

  /**
   * 关闭时清理自定义模板。
   * @private
   */
  _onShutdown() {
    this._custom.clear();
    super._onShutdown();
  }
}

module.exports = DeepeningWorkflowTemplate;
