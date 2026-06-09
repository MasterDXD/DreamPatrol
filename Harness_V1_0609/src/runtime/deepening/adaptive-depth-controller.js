'use strict';
const DeepeningBase = require('./deepening-base');

/**
 * @constant {string[]}
 * 范围关键词列表，用于检测任务描述中的系统级/架构级关键词。
 */
const SCOPE_KW = ['构建','系统','平台','架构','重构','全栈','design','system','platform','refactor'];

/**
 * @constant {string[]}
 * 风险关键词列表，用于检测任务描述中的安全/生产/合规关键词。
 */
const RISK_KW = ['安全','关键','生产','合规','security','critical','production','compliance'];

/**
 * @constant {string[]}
 * 推理关键词列表，用于检测任务描述中的推理/分析/优化关键词。
 */
const REASON_KW = ['推理','分析','优化','决策','reasoning','analysis','optimize','decision'];

/**
 * @module runtime/deepening/adaptive-depth-controller
 * 自适应深度控制器。根据任务复杂度评估结果，动态调整深化推理的深度级别。
 */
/**
 * @classdesc 自适应深度控制器。通过关键词信号在范围、风险、推理、依赖深度四个维度
 * 评估任务复杂度，将复杂度分数映射到四个深度级别
 * （quick=1, standard=2, deep=3, intensive=4），控制深化推理的迭代次数。
 *
 * @extends DeepeningBase
 * @emits 'complexity-assessed' 当复杂度评估完成时触发，附带 {score}
 */
class AdaptiveDepthController extends DeepeningBase {
  /**
   * 深度级别枚举，数值越大表示深化程度越深。
   * @static
   * @type {{QUICK: number, STANDARD: number, DEEP: number, INTENSIVE: number}}
   */
  static DEPTH_LEVELS = { QUICK: 1, STANDARD: 2, DEEP: 3, INTENSIVE: 4 };

  /**
   * 复杂度信号占位对象。
   * @static
   * @type {Object}
   */
  static COMPLEXITY_SIGNALS = {};

  /**
   * 构造函数。
   * @param {Object} [options] - 配置选项
   */
  constructor(options) { super(options); this._totalAssessments = 0; }

  _onShutdown() { this._totalAssessments = 0; super._onShutdown(); }

  /**
   * 评估任务复杂度。根据任务描述中的关键词信号和依赖深度计算复杂度分数，
   * 并映射到对应的深度级别。
   * @param {Object} [task] - 任务对象，可包含description/prompt和depends_on属性
   * @param {string} [task.description] - 任务描述文本
   * @param {string} [task.prompt] - 任务提示文本
   * @param {Array} [task.depends_on] - 依赖任务列表
   * @returns {{score: number, level: string, depth: number, signals: {scope: number, risk: number, reasoning: number, dependencyDepth: number}}} 复杂度评估结果
   * @emits 'complexity-assessed'
   */
  assessComplexity(task) {
    this.guardShutdown();
    this._totalAssessments++;
    if (task == null) {
      const r = { score: 0.3, level: 'standard', depth: 2, signals: { scope: 0, risk: 0, reasoning: 0, dependencyDepth: 0 } };
      this.emit('complexity-assessed', { score: r.score });
      return r;
    }
    if (typeof task !== 'object' || Array.isArray(task)) {
      const r = { score: 0.3, level: 'standard', depth: 2, signals: { scope: 0, risk: 0, reasoning: 0, dependencyDepth: 0 } };
      this.emit('complexity-assessed', { score: r.score });
      return r;
    }
    const descRaw = task.description || task.prompt || '';
    const desc = typeof descRaw === 'string' ? descRaw : String(descRaw);
    const deps = Array.isArray(task.depends_on) ? task.depends_on : [];
    let scope = 0; let risk = 0; let reasoning = 0;
    for (const kw of SCOPE_KW) { if (desc.includes(kw)) scope = Math.min(1, scope + 0.4); }
    for (const kw of RISK_KW) { if (desc.includes(kw)) risk = Math.min(1, risk + 0.45); }
    for (const kw of REASON_KW) { if (desc.includes(kw)) reasoning = Math.min(1, reasoning + 0.4); }
    const depDepth = Math.min(1, deps.length * 0.2);
    let score = Math.min(1, (scope * 0.35 + risk * 0.35 + reasoning * 0.2 + depDepth * 0.1));
    if (!Number.isFinite(score)) score = 0.3;
    let level, depth;
    if (score < 0.25) { level = 'quick'; depth = 1; }
    else if (score < 0.5) { level = 'standard'; depth = 2; }
    else if (score < 0.75) { level = 'deep'; depth = 3; }
    else { level = 'intensive'; depth = 4; }
    const r = { score, level, depth, signals: { scope, risk, reasoning, dependencyDepth: depDepth } };
    this.emit('complexity-assessed', { score });
    return r;
  }
  /**
   * 获取推荐深度数值。
   * @param {Object} task - 任务对象
   * @returns {number} 推荐深度（1-4）
   */
  getRecommendedDepth(task) { return this.assessComplexity(task).depth; }

  /**
   * 获取推荐深度级别名称。
   * @param {Object} task - 任务对象
   * @returns {string} 推荐深度级别（quick/standard/deep/intensive）
   */
  getRecommendedLevel(task) { return this.assessComplexity(task).level; }

  /**
   * 获取控制器运行统计信息。
   * @returns {{totalAssessments: number, healthy: boolean, shutDown: boolean}} 统计信息
   */
  getStats() { return { totalAssessments: this._shutDown ? 0 : this._totalAssessments, ...super.getStats() }; }


}
module.exports = AdaptiveDepthController;
