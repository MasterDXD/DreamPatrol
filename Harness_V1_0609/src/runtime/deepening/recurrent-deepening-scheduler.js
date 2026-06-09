'use strict';
const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');

/**
 * @module runtime/deepening/recurrent-deepening-scheduler
 * 循环深化调度器。驱动Agent反复执行并评估质量，直到收敛或达到最大迭代次数。
 */
/**
 * @classdesc 循环深化调度器。驱动Agent反复执行任务，每轮通过评估器计算质量分数，
 * 当质量分数达到收敛阈值时提前停止。支持可配置的最大迭代次数和收敛阈值。
 *
 * @extends DeepeningBase
 * @emits 'iteration-complete' 当每轮迭代完成时触发，附带 {iteration, qualityScore}
 * @emits 'evaluator-error' 当评估器出错时触发
 * @emits 'iteration-error' 当迭代执行出错时触发
 */
class RecurrentDeepeningScheduler extends DeepeningBase {
  /**
   * 默认最大迭代次数。
   * @static
   * @type {number}
   */
  static DEFAULT_MAX_ITERATIONS = 4;

  /**
   * 默认收敛阈值。
   * @static
   * @type {number}
   */
  static DEFAULT_CONVERGENCE_THRESHOLD = 0.85;

  /**
   * 默认最小改进量。
   * @static
   * @type {number}
   */
  static DEFAULT_MIN_IMPROVEMENT = 0.05;

  /**
   * 构造函数。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxIterations=4] - 最大迭代次数
   * @param {number} [options.convergenceThreshold=0.85] - 收敛阈值
   * @param {number} [options.minImprovement=0.05] - 最小改进量
   */
  constructor(options) {
    super(options);
  }

  /**
   * 执行循环深化调度。反复调用Agent执行任务，每轮通过评估器评估质量，
   * 达到收敛阈值时提前停止。
   * @param {Object} agent - Agent实例，需实现execute方法
   * @param {Object} task - 任务对象
   * @param {Function} [evaluator] - 评估器函数，接收(result, task)返回qualityScore或{qualityScore, score}
   * @returns {Promise<{success: boolean, iterations: number, converged: boolean, qualityScore: number, qualityScores: number[]}>} 执行结果
   * @emits 'iteration-complete'
   */
  async execute(agent, task, evaluator) {
    if (!agent) return { success: false, error: 'No agent provided' };
    if (!task) return { success: false, error: 'No task provided' };
    this.guardShutdown();
    const maxIter = this._options.maxIterations ?? RecurrentDeepeningScheduler.DEFAULT_MAX_ITERATIONS;
    const threshold = this._options.convergenceThreshold ?? RecurrentDeepeningScheduler.DEFAULT_CONVERGENCE_THRESHOLD;
    const qualityScores = [];
    let lastResult = null;
    let converged = false;
    for (let i = 0; i < maxIter; i++) {
      if (this._shutDown) break;
      try {
        if (i > 0) task._ar = { iteration: i };
        lastResult = await agent.execute(task);
        if (this._shutDown) break;
        let score = 0;
        if (evaluator) { try { const r = await evaluator(lastResult, task); if (this._shutDown) break; if (typeof r === 'number' && Number.isFinite(r)) score = r; else score = r.qualityScore ?? (r.score ?? 0); } catch (evalErr) { debug('RecurrentDeepeningScheduler', 'evaluator', evalErr); emitError(this, 'evaluator-error', evalErr, { iteration: i }); } }
        qualityScores.push(score);
        this.emit('iteration-complete', { iteration: i + 1, qualityScore: score });
        if (score >= threshold) { converged = true; break; }
      } catch (e) { emitError(this, 'iteration-error', e, { iteration: i }); }
    }
    return { success: true, iterations: qualityScores.length, converged, qualityScore: qualityScores.length > 0 ? qualityScores[qualityScores.length - 1] : 0, qualityScores };
  }
  /**
   * 获取循环深化调度器运行统计信息。
   * @returns {{maxIterations: number, convergenceThreshold: number, minImprovement: number, activeExecutions: number, healthy: boolean, shutDown: boolean}} 统计信息
   */
  getStats() { return { maxIterations: this._options.maxIterations ?? RecurrentDeepeningScheduler.DEFAULT_MAX_ITERATIONS, convergenceThreshold: this._options.convergenceThreshold ?? RecurrentDeepeningScheduler.DEFAULT_CONVERGENCE_THRESHOLD, minImprovement: this._options.minImprovement ?? RecurrentDeepeningScheduler.DEFAULT_MIN_IMPROVEMENT, activeExecutions: 0, ...super.getStats() }; }


}
module.exports = RecurrentDeepeningScheduler;
