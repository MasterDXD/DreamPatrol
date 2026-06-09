'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');

const QUALITY_LEVELS = {
  EXCELLENT: 'excellent',
  GOOD: 'good',
  ACCEPTABLE: 'acceptable',
  POOR: 'poor',
  CRITICAL: 'critical',
};

const DEFAULT_OPTIONS = {
  maxIndexSize: 500,
  maxHistorySize: 1000,
  weights: {
    successRate: 0.3,
    effectiveness: 0.25,
    healthScore: 0.2,
    usageFrequency: 0.1,
    maintenanceCost: 0.05,
    communityFeedback: 0.1,
  },
  thresholds: {
    excellent: 0.85,
    good: 0.7,
    acceptable: 0.5,
    poor: 0.3,
  },
  recencyDecayHours: 168,
};

class SkillQualityIndex {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._index = new BoundedMap(this._options.maxIndexSize);
    this._history = new BoundedArray(this._options.maxHistorySize);
    this._skillObservability = null;
    this._skillEffectivenessOptimizer = null;
    this._skillRetirementManager = null;
    this._stats = {
      scoresComputed: 0,
      updatesReceived: 0,
      qualityAlerts: 0,
      byLevel: {},
    };
  }

  attachSkillObservability(observability) {
    this._skillObservability = observability;
  }

  attachSkillEffectivenessOptimizer(optimizer) {
    this._skillEffectivenessOptimizer = optimizer;
  }

  attachSkillRetirementManager(manager) {
    this._skillRetirementManager = manager;
  }

  /**
   * 更新可学习奖励权重，融合自SkillOS的"RL驱动技能质量评估"概念。
   * 通过RL训练结果动态调整6维评分权重，实现"越用越准"的质量评估。
   * @param {Object} weightDeltas - 权重增量（各维度名称到增量值的映射）
   * @param {number} [weightDeltas.successRate] - successRate权重增量
   * @param {number} [weightDeltas.effectiveness] - effectiveness权重增量
   * @param {number} [weightDeltas.healthScore] - healthScore权重增量
   * @param {number} [weightDeltas.usageFrequency] - usageFrequency权重增量
   * @param {number} [weightDeltas.maintenanceCost] - maintenanceCost权重增量
   * @param {number} [weightDeltas.communityFeedback] - communityFeedback权重增量
   * @param {number} [learningRate=0.1] - 学习率
   * @returns {{ applied: boolean, weights: Object }} 更新后的权重
   */
  updateLearnableWeights(weightDeltas, learningRate) {
    if (!weightDeltas || typeof weightDeltas !== 'object') return { applied: false, weights: Object.assign({}, this._options.weights) };

    const lr = typeof learningRate === 'number' && learningRate > 0 && learningRate <= 1 ? learningRate : 0.1;
    const currentWeights = this._options.weights;
    const newWeights = Object.assign({}, currentWeights);

    for (const [key, delta] of Object.entries(weightDeltas)) {
      if (key in newWeights && typeof delta === 'number' && Number.isFinite(delta)) {
        newWeights[key] = Math.max(0.01, Math.min(0.6, currentWeights[key] + delta * lr));
      }
    }

    // 归一化：确保权重总和为1
    const sum = Object.values(newWeights).reduce(function(a, b) { return a + b; }, 0);
    if (sum > 0) {
      for (const key of Object.keys(newWeights)) {
        newWeights[key] = newWeights[key] / sum;
      }
    }

    this._options.weights = newWeights;
    return { applied: true, weights: Object.assign({}, newWeights) };
  }

  /**
   * 获取当前权重配置。
   * @returns {Object} 当前权重
   */
  getWeights() {
    return Object.assign({}, this._options.weights);
  }

  computeQualityScore(skillId) {
    if (!skillId) return null;
    this._stats.scoresComputed++;
    const metrics = this._collectMetrics(skillId);
    const weights = this._options.weights;
    let compositeScore = 0;
    let totalWeight = 0;
    for (const [key, weight] of Object.entries(weights)) {
      const value = metrics[key] ?? 0;
      if (value != null || key === 'successRate') {
        compositeScore += value * weight;
        totalWeight += weight;
      }
    }
    if (totalWeight > 0) compositeScore = compositeScore / totalWeight;
    const qualityLevel = this._classifyQuality(compositeScore);
    const entry = {
      skillId,
      compositeScore,
      qualityLevel,
      metrics,
      computedAt: Date.now(),
    };
    this._index.set(skillId, entry);
    this._history.push({
      skillId,
      compositeScore,
      qualityLevel,
      timestamp: Date.now(),
    });
    this._stats.byLevel[qualityLevel] = (this._stats.byLevel[qualityLevel] ?? 0) + 1;
    if (qualityLevel === QUALITY_LEVELS.CRITICAL || qualityLevel === QUALITY_LEVELS.POOR) {
      this._stats.qualityAlerts++;
    }
    return entry;
  }

  getQualityScore(skillId) {
    const entry = this._index.get(skillId);
    if (!entry) return this.computeQualityScore(skillId);
    return entry;
  }

  getQualityLevel(skillId) {
    const entry = this.getQualityScore(skillId);
    return entry?.qualityLevel ?? QUALITY_LEVELS.ACCEPTABLE;
  }

  getTopSkills(count) {
    const entries = [];
    for (const [, entry] of this._index) {
      entries.push(entry);
    }
    entries.sort((a, b) => b.compositeScore - a.compositeScore);
    return entries.slice(0, count ?? 10);
  }

  getBottomSkills(count) {
    const entries = [];
    for (const [, entry] of this._index) {
      entries.push(entry);
    }
    entries.sort((a, b) => a.compositeScore - b.compositeScore);
    return entries.slice(0, count ?? 10);
  }

  getQualityDistribution() {
    const distribution = {};
    for (const level of Object.values(QUALITY_LEVELS)) {
      distribution[level] = 0;
    }
    for (const [, entry] of this._index) {
      const level = entry.qualityLevel ?? QUALITY_LEVELS.ACCEPTABLE;
      distribution[level] = (distribution[level] ?? 0) + 1;
    }
    return distribution;
  }

  updateMetric(skillId, metricName, value) {
    this._stats.updatesReceived++;
    const entry = this._index.get(skillId);
    if (entry && entry.metrics) {
      entry.metrics[metricName] = value;
      return this.computeQualityScore(skillId);
    }
    return this.computeQualityScore(skillId);
  }

  _collectMetrics(skillId) {
    const metrics = {
      successRate: 0,
      effectiveness: 0,
      healthScore: 0,
      usageFrequency: 0,
      maintenanceCost: 0,
      communityFeedback: 0,
    };
    if (this._skillObservability) {
      safeExecute(() => {
        const dashboard = this._skillObservability.getHealthDashboard?.();
        if (dashboard && dashboard.skills) {
          const skillData = dashboard.skills[skillId] ?? dashboard.skills.find(s => s.skillId === skillId);
          if (skillData) {
            metrics.healthScore = skillData.healthScore ?? skillData.health ?? 0;
            metrics.successRate = skillData.successRate ?? skillData.success_rate ?? 0;
          }
        }
      }, 'SkillQualityIndex', 'collectMetrics-observability');
    }
    if (this._skillEffectivenessOptimizer) {
      safeExecute(() => {
        const accuracy = this._skillEffectivenessOptimizer.getAccuracyMetrics?.(skillId);
        if (accuracy) {
          metrics.effectiveness = accuracy.f1 ?? accuracy.f1Score ?? 0;
          if (metrics.successRate === 0 && accuracy.precision) {
            metrics.successRate = accuracy.precision;
          }
        }
      }, 'SkillQualityIndex', 'collectMetrics-effectiveness');
    }
    if (this._skillRetirementManager) {
      safeExecute(() => {
        const evaluation = this._skillRetirementManager.evaluateSkill?.(skillId);
        if (evaluation) {
          metrics.maintenanceCost = evaluation.maintenanceCost ?? 0;
          if (metrics.successRate === 0 && evaluation.successRate) {
            metrics.successRate = evaluation.successRate;
          }
        }
      }, 'SkillQualityIndex', 'collectMetrics-retirement');
    }
    return metrics;
  }

  _classifyQuality(score) {
    const thresholds = this._options.thresholds;
    if (score >= thresholds.excellent) return QUALITY_LEVELS.EXCELLENT;
    if (score >= thresholds.good) return QUALITY_LEVELS.GOOD;
    if (score >= thresholds.acceptable) return QUALITY_LEVELS.ACCEPTABLE;
    if (score >= thresholds.poor) return QUALITY_LEVELS.POOR;
    return QUALITY_LEVELS.CRITICAL;
  }

  getStats() {
    return {
      scoresComputed: this._stats.scoresComputed,
      updatesReceived: this._stats.updatesReceived,
      qualityAlerts: this._stats.qualityAlerts,
      byLevel: Object.assign({}, this._stats.byLevel),
      indexedSkills: this._index.size,
    };
  }

  _onShutdown() {
    this._index.shutdown();
    this._history.shutdown();
  }
}

module.exports = withShutdown(SkillQualityIndex);
module.exports.QUALITY_LEVELS = QUALITY_LEVELS;
