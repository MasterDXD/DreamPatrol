'use strict';

const { EventEmitter } = require('events');
const { TDDGateError } = require('../errors');
const { mergeConfig } = require('../utils/safe-assign');
const { debug } = require('../utils/debug-logger');
const { withShutdown } = require('../utils/shutdown-mixin');

/**
 * @module gate/karpathy-enhancer
 * Karpathy原则增强器。基于Andrej Karpathy编码哲学，增强TDD门禁规则，
 * 涵盖diff卫生、返工率、澄清优先、孤立代码检测、思维质量、强标准比例六个维度。
 */

/** @constant {object} DEFAULT_CONFIG - 默认配置 */
const DEFAULT_CONFIG = {
  diffHygieneThreshold: 0.8,
  maxReworkCount: 3,
  minClarificationRate: 0.5,
  maxOrphanRate: 0.05,
  minThinkingQuality: 0.6,
  minStrongCriteriaRatio: 0.7,
};

const MAX_REWORK_TRACKER_SIZE = 500;

/** @constant {object} ENHANCEMENT_RULES - 增强规则定义 */
const ENHANCEMENT_RULES = {
  DIFF_HYGIENE: {
    id: 'diff-hygiene',
    level: 'warn',
    description: 'Diff must not contain unrelated changes',
    metric: 'diffHygiene',
    threshold: DEFAULT_CONFIG.diffHygieneThreshold,
  },
  REWORK_RATE: {
    id: 'rework-rate',
    level: 'warn',
    description: 'Same area modified more than threshold times indicates design issues',
    metric: 'reworkRate',
    threshold: DEFAULT_CONFIG.maxReworkCount,
  },
  CLARIFICATION_FIRST: {
    id: 'clarification-first',
    level: 'info',
    description: 'Coding tasks should have clarification before implementation',
    metric: 'clarificationRate',
    threshold: DEFAULT_CONFIG.minClarificationRate,
  },
  ORPHAN_CODE_RATE: {
    id: 'orphan-code-rate',
    level: 'warn',
    description: 'Code with no callers indicates dead code or missing integration',
    metric: 'orphanRate',
    threshold: DEFAULT_CONFIG.maxOrphanRate,
  },
  THINKING_QUALITY: {
    id: 'thinking-quality',
    level: 'warn',
    description: 'Pre-coding thinking must include assumptions, ambiguities, and alternatives',
    metric: 'thinkingQuality',
    threshold: DEFAULT_CONFIG.minThinkingQuality,
  },
  STRONG_CRITERIA_RATIO: {
    id: 'strong-criteria-ratio',
    level: 'info',
    description: 'Success criteria should be predominantly strong (verifiable) rather than weak (subjective)',
    metric: 'strongCriteriaRatio',
    threshold: DEFAULT_CONFIG.minStrongCriteriaRatio,
  },
};

/**
 * @classdesc Karpathy原则增强器。代码简洁性检查、可读性评分
 * Karpathy原则增强器。基于Andrej Karpathy编码哲学，增强TDD门禁规则，
 * 涵盖diff卫生、返工率、澄清优先、孤立代码检测、思维质量、强标准比例六个维度，
 * 通过加权评分衡量整体有效性。
 * @extends EventEmitter
 * @emits rules-enhanced | effectiveness-measured
 */
class KarpathyEnhancer extends EventEmitter {
  /**
   * 创建KarpathyEnhancer实例。
   * @param {object} [options] - 配置选项，覆盖DEFAULT_CONFIG中的值
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    this._enhanceCount = 0;
    this._measureCount = 0;
    this._reworkTracker = new Map();
  }

  /**
   * 增强现有规则集，添加六个Karpathy原则维度规则。
   * @param {object} existingRules - 现有规则对象
   * @returns {object} 增强后的规则对象
   * @throws {Error} When code input is not a string
   * @emits KarpathyEnhancer#rules-enhanced
   */
  enhance(existingRules) {
    this.guardShutdown();
    const rules = existingRules && typeof existingRules === 'object' ? mergeConfig(existingRules) : {};

    rules['diff-hygiene'] = this._buildDiffHygieneRule();
    rules['rework-rate'] = this._buildReworkRateRule();
    rules['clarification-first'] = this._buildClarificationFirstRule();
    rules['orphan-code-rate'] = this._buildOrphanCodeRateRule();
    rules['thinking-quality'] = this._buildThinkingQualityRule();
    rules['strong-criteria-ratio'] = this._buildStrongCriteriaRatioRule();

    this._enhanceCount++;
    this.emit('rules-enhanced', { ruleCount: Object.keys(rules).length, addedRules: Object.keys(ENHANCEMENT_RULES) });
    return rules;
  }

  _buildDiffHygieneRule() {
    const threshold = this._config.diffHygieneThreshold;
    return {
      id: ENHANCEMENT_RULES.DIFF_HYGIENE.id,
      level: ENHANCEMENT_RULES.DIFF_HYGIENE.level,
      description: ENHANCEMENT_RULES.DIFF_HYGIENE.description,
      threshold,
      check: function(ctx) {
        const totalDiffs = ctx.totalDiffs ?? 0;
        const cleanDiffs = ctx.cleanDiffs ?? 0;
        if (totalDiffs === 0) return false;
        return (cleanDiffs / totalDiffs) < threshold;
      },
    };
  }

  _buildReworkRateRule() {
    const maxReworkCount = this._config.maxReworkCount;
    return {
      id: ENHANCEMENT_RULES.REWORK_RATE.id,
      level: ENHANCEMENT_RULES.REWORK_RATE.level,
      description: ENHANCEMENT_RULES.REWORK_RATE.description,
      maxReworkCount,
      check: function(ctx) {
        const reworkAreas = ctx.reworkAreas ?? [];
        return reworkAreas.some(function(area) {
          return (area.count ?? 0) > maxReworkCount;
        });
      },
    };
  }

  _buildClarificationFirstRule() {
    const minRate = this._config.minClarificationRate;
    return {
      id: ENHANCEMENT_RULES.CLARIFICATION_FIRST.id,
      level: ENHANCEMENT_RULES.CLARIFICATION_FIRST.level,
      description: ENHANCEMENT_RULES.CLARIFICATION_FIRST.description,
      minRate,
      check: function(ctx) {
        const totalTasks = ctx.totalTasks ?? 0;
        const clarifications = ctx.clarificationsBefore ?? 0;
        if (totalTasks === 0) return false;
        return (clarifications / totalTasks) < minRate;
      },
    };
  }

  _buildOrphanCodeRateRule() {
    const maxRate = this._config.maxOrphanRate;
    return {
      id: ENHANCEMENT_RULES.ORPHAN_CODE_RATE.id,
      level: ENHANCEMENT_RULES.ORPHAN_CODE_RATE.level,
      description: ENHANCEMENT_RULES.ORPHAN_CODE_RATE.description,
      maxRate,
      check: function(ctx) {
        const totalLines = ctx.totalLines ?? 0;
        const orphanLines = ctx.orphanCodeLines ?? 0;
        if (totalLines === 0) return false;
        return (orphanLines / totalLines) > maxRate;
      },
    };
  }

  _buildThinkingQualityRule() {
    const minQuality = this._config.minThinkingQuality;
    return {
      id: ENHANCEMENT_RULES.THINKING_QUALITY.id,
      level: ENHANCEMENT_RULES.THINKING_QUALITY.level,
      description: ENHANCEMENT_RULES.THINKING_QUALITY.description,
      minQuality,
      check: function(ctx) {
        const thinking = ctx.thinkingOutput;
        if (!thinking || typeof thinking !== 'object') return true;
        let score = 0;
        const components = ['assumptions', 'ambiguities', 'simpler_alternative'];
        for (const key of components) {
          const val = thinking[key];
          if (Array.isArray(val) && val.length > 0) score += 1 / components.length;
          else if (typeof val === 'string' && val.trim().length > 0) score += 1 / components.length;
        }
        return score < minQuality;
      },
    };
  }

  _buildStrongCriteriaRatioRule() {
    const minRatio = this._config.minStrongCriteriaRatio;
    return {
      id: ENHANCEMENT_RULES.STRONG_CRITERIA_RATIO.id,
      level: ENHANCEMENT_RULES.STRONG_CRITERIA_RATIO.level,
      description: ENHANCEMENT_RULES.STRONG_CRITERIA_RATIO.description,
      minRatio,
      check: function(ctx) {
        const total = ctx.totalCriteria ?? 0;
        const strong = ctx.strongCriteria ?? 0;
        if (total === 0) return false;
        return (strong / total) < minRatio;
      },
    };
  }

  /**
   * 测量六个维度的有效性指标，计算加权综合评分。
   * @param {object} metrics - 指标数据
   * @param {number} [metrics.totalDiffs] - 总diff数
   * @param {number} [metrics.cleanDiffs] - 干净diff数
   * @param {Array<{name: string, count: number}>} [metrics.reworkAreas] - 返工区域列表
   * @param {number} [metrics.clarificationsBefore] - 编码前澄清次数
   * @param {number} [metrics.totalTasks] - 总任务数
   * @param {number} [metrics.orphanCodeLines] - 孤立代码行数
   * @param {number} [metrics.totalLines] - 总代码行数
   * @param {Array<object>} [metrics.thinkingOutputs] - 思维输出列表
   * @param {number} [metrics.strongCriteria] - 强标准数
   * @param {number} [metrics.totalCriteria] - 总标准数
   * @returns {{diffHygiene: number, reworkRate: number, clarificationRate: number, orphanRate: number, thinkingQuality: number, strongCriteriaRatio: number, overallScore: number}} 有效性测量结果
   * @throws {TDDGateError} metrics无效时抛出
   * @emits KarpathyEnhancer#effectiveness-measured
   */
  measureEffectiveness(metrics) {
    this.guardShutdown();
    if (!metrics || typeof metrics !== 'object') {
      throw new TDDGateError('INVALID_INPUT', 'metrics must be an object');
    }

    const parsed = this._parseMetrics(metrics);
    const diffHygiene = parsed.totalDiffs > 0 ? parsed.cleanDiffs / parsed.totalDiffs : 1;
    const reworkRate = this._calcReworkRate(parsed.reworkAreas);
    this._trackReworkAreas(parsed.reworkAreas);
    const clarificationRate = parsed.totalTasks > 0 ? parsed.clarificationsBefore / parsed.totalTasks : 0;
    const orphanRate = parsed.totalLines > 0 ? parsed.orphanCodeLines / parsed.totalLines : 0;
    const thinkingQuality = this._calcThinkingQuality(parsed.thinkingOutputs);
    const strongCriteriaRatio = parsed.totalCriteria > 0 ? parsed.strongCriteria / parsed.totalCriteria : 0;

    const overallScore = this._calcOverallScore(diffHygiene, reworkRate, clarificationRate, orphanRate, thinkingQuality, strongCriteriaRatio);

    this._measureCount++;
    const result = {
      diffHygiene,
      reworkRate,
      clarificationRate,
      orphanRate,
      thinkingQuality,
      strongCriteriaRatio,
      overallScore: Math.max(0, Math.min(1, overallScore)),
    };

    this.emit('effectiveness-measured', result);
    return result;
  }

  _parseMetrics(metrics) {
    const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    return {
      totalDiffs: num(metrics.totalDiffs),
      cleanDiffs: num(metrics.cleanDiffs),
      reworkAreas: Array.isArray(metrics.reworkAreas) ? metrics.reworkAreas : [],
      clarificationsBefore: num(metrics.clarificationsBefore),
      totalTasks: num(metrics.totalTasks),
      orphanCodeLines: num(metrics.orphanCodeLines),
      totalLines: num(metrics.totalLines),
      thinkingOutputs: Array.isArray(metrics.thinkingOutputs) ? metrics.thinkingOutputs : [],
      strongCriteria: num(metrics.strongCriteria),
      totalCriteria: num(metrics.totalCriteria),
    };
  }

  _calcReworkRate(reworkAreas) {
    if (reworkAreas.length === 0) return 0;
    const reworkCount = reworkAreas.filter(area =>
      typeof area === 'object' && area !== null && (area.count ?? 0) > this._config.maxReworkCount,
    ).length;
    return reworkCount / reworkAreas.length;
  }

  _trackReworkAreas(reworkAreas) {
    for (const area of reworkAreas) {
      if (area && typeof area === 'object' && typeof area.name === 'string') {
        const prev = this._reworkTracker.get(area.name) ?? 0;
        this._reworkTracker.delete(area.name);
        this._reworkTracker.set(area.name, Math.max(prev, area.count ?? 0));
        if (this._reworkTracker.size > MAX_REWORK_TRACKER_SIZE) {
          const firstKey = this._reworkTracker.keys().next().value;
          this._reworkTracker.delete(firstKey);
        }
      }
    }
  }

  _calcOverallScore(diffHygiene, reworkRate, clarificationRate, orphanRate, thinkingQuality, strongCriteriaRatio) {
    const hygieneScore = this._config.diffHygieneThreshold > 0 ? Math.min(1, diffHygiene / this._config.diffHygieneThreshold) : 1;
    const reworkScore = 1 - reworkRate;
    const clarificationScore = this._config.minClarificationRate > 0 ? Math.min(1, clarificationRate / this._config.minClarificationRate) : 1;
    const orphanScore = 1 - Math.min(1, this._config.maxOrphanRate > 0 ? orphanRate / this._config.maxOrphanRate : 0);
    const thinkingScore = this._config.minThinkingQuality > 0 ? Math.min(1, thinkingQuality / this._config.minThinkingQuality) : 1;
    const criteriaScore = this._config.minStrongCriteriaRatio > 0 ? Math.min(1, strongCriteriaRatio / this._config.minStrongCriteriaRatio) : 1;
    return hygieneScore * 0.2 + reworkScore * 0.15 + clarificationScore * 0.15 + orphanScore * 0.15 + thinkingScore * 0.2 + criteriaScore * 0.15;
  }

  _calcThinkingQuality(thinkingOutputs) {
    if (thinkingOutputs.length === 0) return 0;
    const components = ['assumptions', 'ambiguities', 'simpler_alternative'];
    let totalScore = 0;
    for (const thinking of thinkingOutputs) {
      if (!thinking || typeof thinking !== 'object') continue;
      let score = 0;
      for (const key of components) {
        const val = thinking[key];
        if (Array.isArray(val) && val.length > 0) score += 1 / components.length;
        else if (typeof val === 'string' && val.trim().length > 0) score += 1 / components.length;
      }
      totalScore += score;
    }
    return totalScore / thinkingOutputs.length;
  }

  /**
   * 获取增强器统计信息。
   * @returns {{enhanceCount: number, measureCount: number, trackedAreas: number, config: object}} 统计信息
   */
  getStats() {
    return {
      enhanceCount: this._enhanceCount,
      measureCount: this._measureCount,
      trackedAreas: this._reworkTracker.size,
      config: mergeConfig(this._config),
    };
  }

  _onShutdown() {
    this._enhanceCount = 0;
    this._measureCount = 0;
    this._reworkTracker.clear();
    debug('KarpathyEnhancer', '_onShutdown', 'cleaned up');
    this.removeAllListeners();
  }
}

KarpathyEnhancer.DEFAULT_CONFIG = DEFAULT_CONFIG;
KarpathyEnhancer.ENHANCEMENT_RULES = ENHANCEMENT_RULES;

module.exports = withShutdown(KarpathyEnhancer);
