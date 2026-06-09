'use strict';
const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');

/**
 * @constant {Object<string, {name: string, iterations: number, reviewEnabled: boolean, adversarialEnabled: boolean}>}
 * 各深度级别的配置映射，定义每级的迭代次数和审查/对抗审查开关。
 */
const LEVEL_CONFIGS = {
  quick: { name: 'quick', iterations: 1, reviewEnabled: false, adversarialEnabled: false },
  standard: { name: 'standard', iterations: 2, reviewEnabled: true, adversarialEnabled: false },
  deep: { name: 'deep', iterations: 3, reviewEnabled: true, adversarialEnabled: false },
  intensive: { name: 'intensive', iterations: 4, reviewEnabled: true, adversarialEnabled: true },
};

/**
 * @module runtime/deepening/progressive-deepening
 * 渐进深化执行器。在四个深度级别上逐步深化执行Agent任务。
 */
/**
 * @classdesc 渐进深化执行器。在quick/standard/deep/intensive四个深度级别上执行Agent任务，
 * 级别越高迭代次数越多，支持审查器反馈早停和intensive级别的对抗审查。
 * 跟踪各级别的执行次数统计。
 *
 * @extends DeepeningBase
 * @emits 'execution-start' 当级别执行开始时触发，附带 {level}
 * @emits 'execution-complete' 当级别执行完成时触发，附带 {level}
 * @emits 'review-error' 当审查器出错时触发
 * @emits 'adversarial-error' 当对抗审查出错时触发
 */
class ProgressiveDeepening extends DeepeningBase {
  /**
   * 深度级别枚举。
   * @static
   * @type {{QUICK: number, STANDARD: number, DEEP: number, INTENSIVE: number}}
   */
  static DEPTH_LEVELS = { QUICK: 1, STANDARD: 2, DEEP: 3, INTENSIVE: 4 };

  /**
   * 构造函数。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.earlyStopThreshold=0.95] - 审查器早停质量阈值
   */
  constructor(options) { super(options); this._levelCounts = { quick: 0, standard: 0, deep: 0, intensive: 0 }; this._earlyStopThreshold = (options && options.earlyStopThreshold) ?? 0.95; }

  /**
   * 在指定深度级别上执行Agent任务。根据级别配置决定迭代次数、
   * 是否启用审查器反馈和对抗审查。
   * @param {Object} agent - Agent实例，需实现execute方法
   * @param {Object} task - 任务对象
   * @param {string} [level='standard'] - 深度级别（quick/standard/deep/intensive）
   * @param {Object} [options] - 执行选项
   * @param {Function} [options.reviewer] - 审查器函数，接收(result, task)返回{qualityScore}
   * @param {Object} [options.adversarialReviewer] - 对抗审查器实例，需实现review方法
   * @param {Object} [options.reviewerA] - 对抗审查器A
   * @param {Object} [options.reviewerB] - 对抗审查器B
   * @returns {Promise<{success: boolean, level: string, iterations: number, reviews?: Array, adversarialResult?: Object}>} 执行结果
   * @emits 'execution-start'
   * @emits 'execution-complete'
   */
  async execute(agent, task, level, options) {
    if (!agent) return { success: false };
    if (!task) return { success: false };
    this.guardShutdown();
    const lvl = level ?? 'standard';
    const cfg = this.getLevelConfig(lvl);
    const opts = options ?? {};
    this._levelCounts[lvl] = (this._levelCounts[lvl] ?? 0) + 1;
    this.emit('execution-start', { level: lvl });
    const { result, reviews } = await this._runIterations(agent, task, cfg, opts);
    const adversarialResult = await this._runAdversarialReview(result, cfg, opts, lvl);
    this.emit('execution-complete', { level: lvl });
    const res = { success: true, level: lvl, iterations: cfg.iterations };
    if (reviews.length) res.reviews = reviews;
    if (adversarialResult) res.adversarialResult = adversarialResult;
    return res;
  }

  async _runIterations(agent, task, cfg, opts) {
    let result; const reviews = [];
    for (let i = 0; i < cfg.iterations; i++) {
      if (!this.isHealthy()) break;
      try { result = await agent.execute(task); } catch (e) { result = { error: e && e.message ? e.message : String(e) }; }
      if (this._shutDown) break;
      if (opts.reviewer && cfg.reviewEnabled) {
        try { const r = await opts.reviewer(result, task); if (this._shutDown) break; reviews.push(r); if (r.qualityScore >= this._earlyStopThreshold) break; } catch (revErr) { debug('ProgressiveDeepening', 'reviewer', revErr); emitError(this, 'review-error', revErr, { level: cfg.name }); }
      }
    }
    return { result, reviews };
  }

  async _runAdversarialReview(result, cfg, opts, lvl) {
    if (!(opts.adversarialReviewer && cfg.adversarialEnabled && result)) return null;
    try { return await opts.adversarialReviewer.review(result, opts.reviewerA, opts.reviewerB); } catch (advErr) { debug('ProgressiveDeepening', 'adversarialReviewer', advErr); emitError(this, 'adversarial-error', advErr, { level: lvl }); return null; }
  }
  /**
   * 获取指定深度级别的配置。
   * @param {string} level - 深度级别名称
   * @returns {{name: string, iterations: number, reviewEnabled: boolean, adversarialEnabled: boolean}} 级别配置
   */
  getLevelConfig(level) { return LEVEL_CONFIGS[level] || LEVEL_CONFIGS.standard; }

  /**
   * 获取渐进深化执行器运行统计信息。
   * @returns {{totalExecutions: number, levelCounts: Object, healthy: boolean, shutDown: boolean}} 统计信息
   */
  getStats() { return { totalExecutions: this._shutDown ? 0 : Object.values(this._levelCounts).reduce((a, b) => a + b, 0), levelCounts: { ...this._levelCounts }, ...super.getStats() }; }
  /**
   * 关闭时重置各级别执行计数。
   * @protected
   */
  _onShutdown() {
    this._levelCounts = { quick: 0, standard: 0, deep: 0, intensive: 0 };
    super._onShutdown();
  }


}
module.exports = ProgressiveDeepening;
