'use strict';
const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');

/**
 * @module runtime/deepening/iterative-refinement
 * 迭代精化器。通过多轮执行-审查-反馈循环逐步提升输出质量。
 */
/**
 * @classdesc 迭代精化器。反复通过执行器执行任务，由审查器评估输出质量，
 * 并将审查反馈注入任务上下文，直到质量阈值满足或最大精化轮次耗尽。
 * 每轮执行失败时支持单次重试。
 *
 * @extends DeepeningBase
 * @emits 'refinement-round' 当每轮精化完成时触发，附带 {round}
 */
class IterativeRefinement extends DeepeningBase {
  /**
   * 默认最大精化轮次。
   * @static
   * @type {number}
   */
  static DEFAULT_MAX_REFINEMENTS = 5;

  /**
   * 默认质量阈值。
   * @static
   * @type {number}
   */
  static DEFAULT_QUALITY_THRESHOLD = 0.8;

  /**
   * 构造函数。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxRefinements=5] - 最大精化轮次
   * @param {number} [options.qualityThreshold=0.8] - 质量阈值
   */
  constructor(options) { super(options); }

  /**
   * 执行迭代精化流程。每轮调用执行器执行任务，若有审查器则评估质量，
   * 不达标时将反馈注入任务上下文继续下一轮，直到达标或轮次耗尽。
   * @param {Object} executor - 执行器实例，需实现execute方法
   * @param {Object} task - 任务对象
   * @param {Function} [reviewer] - 审查器函数，接收(result, task)返回{approved, qualityScore, feedback}
   * @returns {Promise<{success: boolean, rounds: number, converged: boolean, error?: string}>} 精化结果
   * @emits 'refinement-round'
   */
  async _executeWithRetry(executor, task, attempt) {
    try {
      return await executor.execute(task);
    } catch (e) {
      const lastError = e;
      try {
        debug('IterativeRefinement', 'refine', 'Attempt ' + (attempt + 1) + ' failed, retrying: ' + (e && e.message ? e.message : String(e)));
        return await executor.execute(task);
      } catch (_e2) {
        return { __failed: true, error: lastError && lastError.message ? lastError.message : String(lastError) };
      }
    }
  }

  async _reviewResult(reviewer, result, task, roundIndex, qThresh) {
    try {
      const rev = await reviewer(result, task);
      if (this._shutDown) return 'shutdown';
      if (rev.approved || (rev.qualityScore !== undefined && rev.qualityScore >= qThresh)) return 'approved';
      if (rev.feedback) {
        const taskWithContext = { ...task, _ar: { iteration: roundIndex + 1, feedback: rev.feedback }, refinementInstructions: rev.feedback };
        return { continueWith: taskWithContext };
      }
      return 'continue';
    } catch (revErr) {
      debug('IterativeRefinement', 'reviewer', revErr);
      emitError(this, 'review-error', revErr, { round: roundIndex + 1 });
      return 'error';
    }
  }

  /**
   * 执行迭代精化流程。每轮调用执行器执行任务，若有审查器则评估质量，
   * 不达标时将反馈注入任务上下文继续下一轮，直到达标或轮次耗尽。
   * @param {Object} executor - 执行器实例，需实现execute方法
   * @param {Object} task - 任务对象
   * @param {Function} [reviewer] - 审查器函数，接收(result, task)返回{approved, qualityScore, feedback}
   * @returns {Promise<{success: boolean, rounds: number, converged: boolean, result?: *}>} 精化结果
   */
  async refine(executor, task, reviewer) {
    if (!executor) return { success: false, rounds: 0 };
    if (!task) return { success: false, rounds: 0 };
    this.guardShutdown();
    const maxR = this._options.maxRefinements ?? IterativeRefinement.DEFAULT_MAX_REFINEMENTS;
    const qThresh = this._options.qualityThreshold ?? IterativeRefinement.DEFAULT_QUALITY_THRESHOLD;
    let result = null; let rounds = 0;
    let exitReason = 'max_refinements';
    for (let i = 0; i < maxR; i++) {
      if (!this.isHealthy()) { exitReason = 'unhealthy'; break; }
      result = await this._executeWithRetry(executor, task, i);
      if (result && result.__failed) return { success: false, rounds: i + 1, error: result.error };
      if (this._shutDown) { exitReason = 'shutdown'; break; }
      rounds++;
      this.emit('refinement-round', { round: i + 1 });
      if (!reviewer) { exitReason = 'no_reviewer'; break; }
      const reviewOutcome = await this._reviewResult(reviewer, result, task, i, qThresh);
      if (reviewOutcome === 'shutdown') { exitReason = 'shutdown'; break; }
      if (reviewOutcome === 'approved') { exitReason = 'approved'; break; }
      if (reviewOutcome === 'error') { exitReason = 'review_error'; break; }
      if (reviewOutcome.continueWith) task = reviewOutcome.continueWith;
    }
    const success = exitReason === 'approved' || (exitReason === 'no_reviewer' && rounds > 0);
    return { success, rounds, converged: exitReason === 'approved', result };
  }
  /**
   * 获取迭代精化器运行统计信息。
   * @returns {{activeRefinements: number, healthy: boolean, shutDown: boolean}} 统计信息
   */
  getStats() { return { activeRefinements: 0, ...super.getStats() }; }


}
module.exports = IterativeRefinement;
