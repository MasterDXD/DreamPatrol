'use strict';

/**
 * @module runtime/deepening/deepening-strategy-plugin
 * 深化推理可插拔策略决策引擎。实现五种策略类型（固定深度、自适应、收敛驱动、
 * 预算感知、质量优化），根据迭代次数、质量评分、收敛状态和Token预算等执行上下文
 * 决定是否继续深化及深度级别。
 */

const DeepeningBase = require('./deepening-base');

/**
 * 深化推理可插拔策略决策引擎。实现五种策略类型（固定深度、自适应、收敛驱动、
 * 预算感知、质量优化），根据迭代次数、质量评分、收敛状态和Token预算等执行上下文
 * 决定是否继续深化及深度级别。
 *
 * @classdesc 深化策略插件。策略模式、策略选择、策略组合。
 * @extends DeepeningBase
 */
class DeepeningStrategyPlugin extends DeepeningBase {
  /** @constant {Object} 策略类型枚举 */
  static STRATEGY_TYPES = { FIXED_DEPTH: 'fixed-depth', ADAPTIVE: 'adaptive', CONVERGENCE_DRIVEN: 'convergence-driven', BUDGET_AWARE: 'budget-aware', QUALITY_OPTIMIZED: 'quality-optimized' };

  /**
   * 创建 DeepeningStrategyPlugin 实例。
   * @param {string} [name='default'] - 策略插件名称
   * @param {Object} [config] - 策略配置
   * @param {string} [config.type='fixed-depth'] - 策略类型
   * @param {number} [config.maxIterations] - 最大迭代次数
   * @param {number} [config.qualityThreshold] - 质量阈值
   * @param {boolean} [config.enabled] - 是否启用策略
   */
  constructor(name, config) {
    super(config);
    this._name = name ?? 'default';
    this._config = config ?? {};
    this._executionCount = 0;
    this._successCount = 0;
    this._strategies = new Map([
      ['fixed-depth', (ctx) => this._fixedDepth(ctx)],
      ['adaptive', (ctx) => this._adaptive(ctx)],
      ['convergence-driven', (ctx) => this._convergenceDriven(ctx)],
      ['budget-aware', (ctx) => this._budgetAware(ctx)],
      ['quality-optimized', (ctx) => this._qualityOptimized(ctx)],
    ]);
  }

  /**
   * 根据当前策略做出深化决策。策略被禁用时返回 null。
   * @param {Object} [context] - 执行上下文
   * @param {number} [context.iteration] - 当前迭代次数
   * @param {number} [context.qualityScore] - 当前质量评分
   * @param {number} [context.improvementRate] - 改进率
   * @param {Object} [context.convergenceStatus] - 收敛状态
   * @param {number} [context.tokensRemaining] - 剩余Token数
   * @param {number} [context.tokensBudget] - Token预算
   * @returns {Promise<Object|null>} 决策结果，包含 shouldContinue、depthLevel、reason；禁用时返回 null
   * @emits 'invalid-strategy' 当策略类型无效时触发，回退到 fixed-depth
   */
  decide(context) {
    this.guardShutdown();
    if (this._config.enabled === false) return Promise.resolve(null);
    this._executionCount++;
    const ctx = context ?? {};
    const type = this._config.type ?? 'fixed-depth';
    const strategy = this._strategies.get(type);
    let result;
    if (strategy) {
      result = strategy(ctx);
    } else {
      this.emit('invalid-strategy', { type, fallback: 'fixed-depth' });
      result = this._fixedDepth(ctx);
    }

    if (result.shouldContinue) this._successCount++;
    return Promise.resolve(result);
  }

  /**
   * 固定深度策略。在达到最大迭代次数前持续深化。
   * @param {Object} ctx - 执行上下文
   * @returns {Object} 决策结果
   * @private
   */
  _fixedDepth(ctx) {
    const maxIter = this._config.maxIterations > 0 ? this._config.maxIterations : 4;
    const shouldContinue = (typeof ctx.iteration === 'number' && Number.isFinite(ctx.iteration) ? ctx.iteration : 0) < maxIter;
    return { shouldContinue, depthLevel: this._config.depthLevel ?? 'standard', reason: shouldContinue ? 'within-iterations' : 'max-iterations-reached' };
  }

  /**
   * 自适应策略。根据质量评分和改进率动态调整深度级别。
   * @param {Object} ctx - 执行上下文
   * @returns {Object} 决策结果
   * @private
   */
  _adaptive(ctx) {
    const maxIter = this._config.maxIterations > 0 ? this._config.maxIterations : 6;
    const threshold = typeof this._config.qualityThreshold === 'number' && Number.isFinite(this._config.qualityThreshold) ? this._config.qualityThreshold : 0.85;
    const quality = typeof ctx.qualityScore === 'number' && Number.isFinite(ctx.qualityScore) ? ctx.qualityScore : 0;
    const improvement = typeof ctx.improvementRate === 'number' && Number.isFinite(ctx.improvementRate) ? ctx.improvementRate : 0;
    const iteration = typeof ctx.iteration === 'number' && Number.isFinite(ctx.iteration) ? ctx.iteration : 0;
    if (quality >= threshold && improvement < 0.05) {
      return { shouldContinue: false, depthLevel: 'standard', reason: 'quality-threshold-met' };
    }
    if (iteration >= maxIter) {
      return { shouldContinue: false, depthLevel: 'standard', reason: 'max-iterations-reached' };
    }
    const depthLevel = quality < 0.5 ? 'intensive' : quality < threshold ? 'deep' : 'standard';
    return { shouldContinue: true, depthLevel, reason: 'within-iterations' };
  }

  /**
   * 收敛驱动策略。根据收敛状态决定是否继续深化。
   * @param {Object} ctx - 执行上下文
   * @returns {Object} 决策结果
   * @private
   */
  _convergenceDriven(ctx) {
    const maxIter = this._config.maxIterations > 0 ? this._config.maxIterations : 10;
    const conv = ctx.convergenceStatus ?? {};
    const iteration = typeof ctx.iteration === 'number' && Number.isFinite(ctx.iteration) ? ctx.iteration : 0;
    if (conv.converged) {
      return { shouldContinue: false, depthLevel: 'standard', reason: conv.reason ?? 'converged' };
    }
    if (iteration >= maxIter) {
      return { shouldContinue: false, depthLevel: 'standard', reason: 'max-iterations-reached' };
    }
    return { shouldContinue: true, depthLevel: 'standard', reason: 'within-iterations' };
  }

  /**
   * 预算感知策略。根据Token预算剩余比例决定是否继续深化。
   * @param {Object} ctx - 执行上下文
   * @returns {Object} 决策结果
   * @private
   */
  _budgetAware(ctx) {
    const maxIter = this._config.maxIterations > 0 ? this._config.maxIterations : 4;
    const iteration = typeof ctx.iteration === 'number' && Number.isFinite(ctx.iteration) ? ctx.iteration : 0;
    const remaining = typeof ctx.tokensRemaining === 'number' && Number.isFinite(ctx.tokensRemaining) ? ctx.tokensRemaining : 0;
    const budget = typeof ctx.tokensBudget === 'number' && Number.isFinite(ctx.tokensBudget) && ctx.tokensBudget > 0 ? ctx.tokensBudget : 1;
    if (remaining / budget < 0.1) {
      return { shouldContinue: false, depthLevel: 'standard', reason: 'budget-exhausted' };
    }
    if (iteration >= maxIter) {
      return { shouldContinue: false, depthLevel: 'standard', reason: 'max-iterations-reached' };
    }
    const depthLevel = remaining / budget > 0.5 ? 'deep' : 'standard';
    return { shouldContinue: true, depthLevel, reason: 'within-budget' };
  }

  /**
   * 质量优化策略。持续深化直到达到质量阈值，使用强化深度级别。
   * @param {Object} ctx - 执行上下文
   * @returns {Object} 决策结果
   * @private
   */
  _qualityOptimized(ctx) {
    const maxIter = this._config.maxIterations > 0 ? this._config.maxIterations : 5;
    const threshold = typeof this._config.qualityThreshold === 'number' && Number.isFinite(this._config.qualityThreshold) ? this._config.qualityThreshold : 0.9;
    const quality = typeof ctx.qualityScore === 'number' && Number.isFinite(ctx.qualityScore) ? ctx.qualityScore : 0;
    const iteration = typeof ctx.iteration === 'number' && Number.isFinite(ctx.iteration) ? ctx.iteration : 0;
    if (quality >= threshold) {
      return { shouldContinue: false, depthLevel: 'standard', reason: 'quality-threshold-met' };
    }
    if (iteration >= maxIter) {
      return { shouldContinue: false, depthLevel: 'standard', reason: 'max-iterations-reached' };
    }
    return { shouldContinue: true, depthLevel: 'intensive', reason: 'within-iterations' };
  }

  /**
   * 获取策略插件统计信息。
   * @returns {Object} 统计对象，包含 name、executionCount、successCount
   */
  getStats() {
    return {
      ...super.getStats(),
      name: this._name,
      executionCount: this._executionCount,
      successCount: this._successCount,
    };
  }
}

module.exports = DeepeningStrategyPlugin;
