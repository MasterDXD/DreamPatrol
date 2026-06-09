'use strict';
const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');

/**
 * @constant {number}
 * Token消耗记录最大保留条数。
 */
const MAX_TOKEN_RECORDS = 100;

/**
 * @module runtime/deepening/token-aware-deepening
 * Token预算感知深化策略。根据剩余Token预算动态调整深化深度和迭代次数。
 */
/**
 * @classdesc Token预算感知深化策略。根据剩余Token预算计算最大迭代次数，
 * 跟踪每轮迭代的Token消耗和质量效率，并根据任务复杂度和预算可用性
 * 推荐深化深度级别（quick/standard/deep/intensive）。
 *
 * @extends DeepeningBase
 * @emits 'iteration-cost-recorded' 当记录迭代消耗时触发，附带 {sessionId, tokensUsed, efficiency}
 */
class TokenAwareDeepening extends DeepeningBase {
  /**
   * 默认预算使用比例。
   * @static
   * @type {number}
   */
  static DEFAULT_BUDGET_RATIO = 0.7;

  /**
   * 默认最低剩余Token数。
   * @static
   * @type {number}
   */
  static DEFAULT_MIN_BUDGET_REMAINING = 1000;

  /**
   * 构造函数。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.minBudgetRemaining=1000] - 最低剩余Token数（绝对值或比例）
   * @param {number} [options.maxIterationCap=10] - 最大迭代次数上限
   */
  constructor(options) { super(options); this._records = []; }

  /**
   * 根据Token预算计算最大迭代次数。预算不足时返回1次迭代。
   * @param {Object} tokenManager - Token管理器实例，需实现getUsage方法
   * @param {string} sessionId - 会话ID
   * @returns {{maxIterations: number, reason: string}} 最大迭代次数及原因
   */
  calculateMaxIterations(tokenManager, sessionId) {
    if (!tokenManager) return { maxIterations: 4, reason: 'no-token-manager' };
    try {
      const usage = tokenManager.getUsage ? tokenManager.getUsage(sessionId) : {};
      const remaining = usage.remaining !== undefined ? usage.remaining : 10000;
      const budget = typeof usage.budget === 'number' && Number.isFinite(usage.budget) ? usage.budget : 1000000000;
      const minBudgetOpt = this._options.minBudgetRemaining;
      const isRatio = typeof minBudgetOpt === 'number' && Number.isFinite(minBudgetOpt) && minBudgetOpt > 0 && minBudgetOpt < 1;
      if (isRatio) {
        const remainingRatio = budget > 0 ? remaining / budget : 0;
        if (remainingRatio < minBudgetOpt) return { maxIterations: 1, reason: 'budget-critical' };
      } else {
        const minBudget = typeof minBudgetOpt === 'number' && Number.isFinite(minBudgetOpt) ? minBudgetOpt : TokenAwareDeepening.DEFAULT_MIN_BUDGET_REMAINING;
        if (remaining < minBudget * 0.1) return { maxIterations: 1, reason: 'budget-critical' };
      }
      const rawMax = Math.floor(remaining / 2000);
      const cappedMax = Math.min(rawMax, typeof this._options.maxIterationCap === 'number' && Number.isFinite(this._options.maxIterationCap) ? this._options.maxIterationCap : 10);
      return { maxIterations: Math.max(1, cappedMax), reason: 'budget-ok' };
    } catch (calcErr) { debug('TokenAwareDeepening', 'calculateMaxIterations', calcErr); return { maxIterations: 1, reason: 'token-manager-error', _error: calcErr.message || String(calcErr) }; }
  }
  /**
   * 检查当前Token预算是否足以支付指定Token消耗。
   * @param {Object} tokenManager - Token管理器实例
   * @param {string} sessionId - 会话ID
   * @param {number} tokenCost - 预计Token消耗量
   * @returns {{canAfford: boolean, reason?: string}} 是否可支付及原因
   */
  canAffordIteration(tokenManager, sessionId, tokenCost) {
    if (!tokenManager) return { canAfford: true };
    try { const u = tokenManager.getUsage ? tokenManager.getUsage(sessionId) : {}; return { canAfford: (typeof u.remaining === 'number' && Number.isFinite(u.remaining) ? u.remaining : 10000) >= tokenCost }; } catch (affordErr) { debug('TokenAwareDeepening', 'canAffordIteration', affordErr); return { canAfford: false, reason: 'token-query-error' }; }
  }
  /**
   * 记录单轮迭代的Token消耗和质量分数，计算效率指标。
   * @param {string} sessionId - 会话ID
   * @param {number} iteration - 迭代序号
   * @param {number} tokensUsed - 本轮消耗的Token数
   * @param {number} qualityScore - 本轮质量分数
   * @returns {{sessionId: string, tokensUsed: number, efficiency: number}} 记录结果
   * @emits 'iteration-cost-recorded'
   */
  recordIterationCost(sessionId, iteration, tokensUsed, qualityScore) {
    this.guardShutdown();
    const safeTokens = typeof tokensUsed === 'number' && Number.isFinite(tokensUsed) ? tokensUsed : 0;
    const safeQuality = typeof qualityScore === 'number' && Number.isFinite(qualityScore) ? qualityScore : 0;
    const efficiency = safeTokens > 0 ? safeQuality / safeTokens : 0;
    this._records.push({ sessionId, iteration, tokensUsed, qualityScore, efficiency });
    if (this._records.length > MAX_TOKEN_RECORDS) {
      this._records.splice(0, this._records.length - MAX_TOKEN_RECORDS);
    }
    this.emit('iteration-cost-recorded', { sessionId, tokensUsed, efficiency });
    return { sessionId, tokensUsed, efficiency };
  }
  /**
   * 获取指定会话的Token效率报告。
   * @param {string} sessionId - 会话ID
   * @returns {{totalRecords: number, totalTokensUsed: number, averageQuality: number}} 效率报告
   */
  getEfficiencyReport(sessionId) {
    let totalTokens = 0;
    let totalQuality = 0;
    let count = 0;
    for (const r of this._records) {
      if (r.sessionId !== sessionId) continue;
      totalTokens += r.tokensUsed;
      totalQuality += r.qualityScore;
      count++;
    }
    return { totalRecords: count, totalTokensUsed: totalTokens, averageQuality: count ? totalQuality / count : 0 };
  }
  /**
   * 根据Token预算和任务复杂度推荐深化深度级别。
   * @param {Object} tokenManager - Token管理器实例
   * @param {string} sessionId - 会话ID
   * @param {number} complexity - 任务复杂度分数（0-1）
   * @returns {{recommendedLevel: string, maxIterations: number}} 推荐的深度级别和最大迭代次数
   */
  recommendDepth(tokenManager, sessionId, complexity) {
    const calc = this.calculateMaxIterations(tokenManager, sessionId);
    let level = 'standard';
    if (complexity > 0.7) level = 'intensive';
    else if (complexity > 0.5) level = 'deep';
    else if (complexity < 0.25) level = 'quick';
    return { recommendedLevel: level, maxIterations: calc.maxIterations };
  }
  /**
   * 获取Token感知深化策略运行统计信息。
   * @returns {{totalRecords: number, healthy: boolean, shutDown: boolean}} 统计信息
   */
  getStats() { return { totalRecords: this._shutDown ? 0 : this._records.length, ...super.getStats() }; }

  /**
   * 关闭时清空所有Token消耗记录。
   * @protected
   */
  _onShutdown() {
    this._records = [];
    super._onShutdown();
  }
}
module.exports = TokenAwareDeepening;
