'use strict';

/**
 * EntropyGovernanceOrchestrator — 熵治理编排器
 *
 * 融合 Harness Engineering 范式"持续熵治理"体系的核心编排器。
 * 聚合 ContextDriftMonitor、ComprehensionDebtTracker、CodeDriftDetector、
 * SkillReducer、AiCodeTrustScorer、DeliveryEfficiencyMeter 六大熵指标源，
 * 计算统一系统熵评分，并实现"检测→告警→约束强化→验证"闭环。
 *
 * @module runtime/quality/entropy-governance-orchestrator
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedArray = require('../../utils/bounded-array');
const { debug } = require('../../utils/debug-logger');

// ─── 常量 ───────────────────────────────────────────────────────

const ENTROPY_LEVELS = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

const ENTROPY_THRESHOLDS = {
  none: 0.1,
  low: 0.25,
  medium: 0.45,
  high: 0.65,
  critical: 0.85,
};

const DEFAULT_CONFIG = {
  /** 熵评分计算间隔（毫秒） */
  assessmentIntervalMs: 60000,
  /** 历史记录容量 */
  historySize: 200,
  /** 主动简化触发阈值（熵评分超过此值时触发） */
  autoSimplifyThreshold: 0.7,
  /** 约束强化触发阈值 */
  constraintReinforceThreshold: 0.6,
  /** 各指标源权重 */
  weights: {
    contextDrift: 0.20,
    comprehensionDebt: 0.20,
    codeDrift: 0.20,
    skillOverload: 0.15,
    codeTrust: 0.15,
    deliveryEfficiency: 0.10,
  },
};

// ─── 类定义 ─────────────────────────────────────────────────────

class EntropyGovernanceOrchestrator extends EventEmitter {
  /**
   * @param {Object} [config]
   * @param {Object} [config.contextDriftMonitor]   ContextDriftMonitor 实例
   * @param {Object} [config.comprehensionDebtTracker] ComprehensionDebtTracker 实例
   * @param {Object} [config.codeDriftDetector]      CodeDriftDetector 实例
   * @param {Object} [config.skillReducer]           SkillReducer 实例
   * @param {Object} [config.aiCodeTrustScorer]      AiCodeTrustScorer 实例
   * @param {Object} [config.deliveryEfficiencyMeter] DeliveryEfficiencyMeter 实例
   * @param {number} [config.assessmentIntervalMs]   评估间隔
   * @param {number} [config.autoSimplifyThreshold]  主动简化阈值
   * @param {number} [config.constraintReinforceThreshold] 约束强化阈值
   * @param {Object} [config.weights]                指标权重
   */
  constructor(config) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config ?? {});
    this._weights = Object.assign({}, DEFAULT_CONFIG.weights, this._config.weights ?? {});

    // 六大熵指标源
    this._contextDriftMonitor = this._config.contextDriftMonitor ?? null;
    this._comprehensionDebtTracker = this._config.comprehensionDebtTracker ?? null;
    this._codeDriftDetector = this._config.codeDriftDetector ?? null;
    this._skillReducer = this._config.skillReducer ?? null;
    this._aiCodeTrustScorer = this._config.aiCodeTrustScorer ?? null;
    this._deliveryEfficiencyMeter = this._config.deliveryEfficiencyMeter ?? null;

    // 熵评分历史
    this._history = new BoundedArray(this._config.historySize);

    // 当前熵评分
    this._currentScore = 0;
    this._currentLevel = ENTROPY_LEVELS.NONE;
    this._lastAssessmentAt = 0;
    this._assessmentCount = 0;

    // 自动简化触发记录
    this._simplifyTriggerCount = 0;
    this._reinforceTriggerCount = 0;

    // 定时评估
    this._assessmentTimer = null;

    // 事件监听绑定
    this._boundOnDriftDetected = this._onDriftDetected.bind(this);
    this._boundOnDebtRecorded = this._onDebtRecorded.bind(this);
    this._boundOnOverload = this._onOverload.bind(this);
    this._boundOnAssessed = this._onTrustAssessed.bind(this);

    this._attachEventListeners();
    this._startPeriodicAssessment();
  }

  // ─── 公共 API ────────────────────────────────────────────────

  /**
   * 执行一次完整的熵评估，聚合所有指标源。
   * @returns {Object} 熵评估结果
   */
  assess() {
    this.guardShutdown();

    const metrics = this._collectMetrics();
    const score = this._calculateEntropyScore(metrics);
    const level = this._determineLevel(score);
    const recommendations = this._generateRecommendations(score, metrics);

    const result = {
      score: Math.round(score * 1000) / 1000,
      level: level,
      metrics: metrics,
      recommendations: recommendations,
      assessedAt: Date.now(),
    };

    this._currentScore = result.score;
    this._currentLevel = level;
    this._lastAssessmentAt = result.assessedAt;
    this._assessmentCount++;
    this._history.push(result);

    // 检查是否需要触发主动简化
    if (score >= this._config.autoSimplifyThreshold) {
      this._triggerAutoSimplify(result);
    }

    // 检查是否需要触发约束强化
    if (score >= this._config.constraintReinforceThreshold) {
      this._triggerConstraintReinforcement(result);
    }

    this.emit('entropy-assessed', result);
    return result;
  }

  /**
   * 获取当前熵评分（不重新计算）。
   * @returns {Object}
   */
  getCurrentScore() {
    return {
      score: this._currentScore,
      level: this._currentLevel,
      assessedAt: this._lastAssessmentAt,
    };
  }

  /**
   * 获取熵评分历史。
   * @param {number} [limit=50]
   * @returns {Array}
   */
  getHistory(limit) {
    if (!this._history) return [];
    const arr = this._history.toArray();
    if (limit && limit > 0) return arr.slice(-limit);
    return arr;
  }

  /**
   * 获取熵趋势分析。
   * @returns {Object}
   */
  getTrend() {
    if (!this._history) return { trend: 'no-data', slope: 0, samples: 0 };
    const history = this._history.toArray();
    if (history.length < 2) {
      return { trend: 'insufficient-data', slope: 0, samples: history.length };
    }

    // 线性回归计算趋势
    const recent = history.slice(-Math.min(20, history.length));
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    const n = recent.length;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += recent[i].score;
      sumXY += i * recent[i].score;
      sumXX += i * i;
    }
    const slope = n > 1 ? (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) : 0;

    let trend = 'stable';
    if (slope > 0.01) trend = 'increasing';
    else if (slope < -0.01) trend = 'decreasing';

    return {
      trend: trend,
      slope: Math.round(slope * 10000) / 10000,
      samples: n,
      latestScore: history[history.length - 1].score,
      earliestScore: recent[0].score,
    };
  }

  /**
   * 获取统计信息。
   * @returns {Object}
   */
  getStats() {
    if (!this._history) return { currentScore: 0, avgScore: 0, maxScore: 0, minScore: 0, totalAssessments: 0 };
    const history = this._history.toArray();
    let maxScore = 0;
    let minScore = 1;
    let sumScore = 0;
    for (const h of history) {
      if (h.score > maxScore) maxScore = h.score;
      if (h.score < minScore) minScore = h.score;
      sumScore += h.score;
    }
    const avgScore = history.length > 0 ? sumScore / history.length : 0;

    return {
      currentScore: this._currentScore,
      currentLevel: this._currentLevel,
      assessmentCount: this._assessmentCount,
      simplifyTriggerCount: this._simplifyTriggerCount,
      reinforceTriggerCount: this._reinforceTriggerCount,
      historySize: history.length,
      avgScore: Math.round(avgScore * 1000) / 1000,
      maxScore: Math.round(maxScore * 1000) / 1000,
      minScore: Math.round(minScore * 1000) / 1000,
      trend: this.getTrend(),
      sources: {
        contextDriftMonitor: !!this._contextDriftMonitor,
        comprehensionDebtTracker: !!this._comprehensionDebtTracker,
        codeDriftDetector: !!this._codeDriftDetector,
        skillReducer: !!this._skillReducer,
        aiCodeTrustScorer: !!this._aiCodeTrustScorer,
        deliveryEfficiencyMeter: !!this._deliveryEfficiencyMeter,
      },
      weights: Object.assign({}, this._weights),
    };
  }

  /**
   * 手动触发主动简化流程。
   * @returns {Object} 简化结果
   */
  triggerSimplify() {
    this.guardShutdown();
    return this._triggerAutoSimplify({ score: this._currentScore, level: this._currentLevel });
  }

  // ─── 内部方法 ────────────────────────────────────────────────

  /**
   * 收集各指标源的度量数据。
   * @private
   */
  _collectMetrics() {
    const metrics = {};
    this._collectContextDrift(metrics);
    this._collectComprehensionDebt(metrics);
    this._collectCodeDrift(metrics);
    this._collectSkillOverload(metrics);
    this._collectCodeTrust(metrics);
    this._collectDeliveryEfficiency(metrics);
    return metrics;
  }

  /** @private */
  _collectContextDrift(metrics) {
    if (!this._contextDriftMonitor) return;
    try {
      const stats = this._contextDriftMonitor.getStats();
      const drift = this._contextDriftMonitor.checkDrift();
      metrics.contextDrift = {
        score: drift.driftScore ?? 0,
        level: drift.level || 'none',
        violatedConstraints: drift.violatedConstraints ?? 0,
        totalConstraints: drift.totalConstraints ?? 0,
        trend: stats.driftTrend || 'insufficient-data',
      };
    } catch (_err) {
      metrics.contextDrift = { score: 0, level: 'none', error: true };
    }
  }

  /** @private */
  _collectComprehensionDebt(metrics) {
    if (!this._comprehensionDebtTracker) return;
    try {
      const debtScore = this._comprehensionDebtTracker.calculateDebtScore();
      const distribution = this._comprehensionDebtTracker.getDebtDistribution();
      const resolutionRate = this._comprehensionDebtTracker.getResolutionRate();
      metrics.comprehensionDebt = {
        score: debtScore.score ?? 0,
        level: debtScore.level || 'none',
        openCount: debtScore.openCount ?? 0,
        resolutionRate: resolutionRate,
        distribution: distribution,
      };
    } catch (_err) {
      metrics.comprehensionDebt = { score: 0, level: 'none', error: true };
    }
  }

  /** @private */
  _collectCodeDrift(metrics) {
    if (!this._codeDriftDetector) return;
    try {
      const drift = this._codeDriftDetector.detectDrift();
      metrics.codeDrift = {
        drifting: drift.drifting ?? false,
        trend: drift.trend || 'stable',
        alertCount: (drift.alerts ?? []).length,
        reason: drift.reason || 'stable',
      };
      metrics.codeDrift.score = drift.drifting ? 0.5 + (drift.alerts ?? []).length * 0.1 : 0.1;
      if (metrics.codeDrift.score > 1) metrics.codeDrift.score = 1;
    } catch (_err) {
      metrics.codeDrift = { score: 0, drifting: false, error: true };
    }
  }

  /** @private */
  _collectSkillOverload(metrics) {
    if (!this._skillReducer) return;
    try {
      const stats = this._skillReducer.getStats();
      const overload = this._skillReducer.detectOverload();
      metrics.skillOverload = {
        score: overload.level === 'overloaded' ? 0.8 : (overload.level === 'warning' ? 0.5 : 0.1),
        level: overload.level || 'normal',
        l2Cached: stats.l2Cached ?? 0,
        l1Count: stats.l1Count ?? 0,
        overloadDetections: stats.overloadDetections ?? 0,
        contextTokens: (stats.contextEstimate ?? {}).totalTokens ?? 0,
      };
    } catch (_err) {
      metrics.skillOverload = { score: 0, level: 'normal', error: true };
    }
  }

  /** @private */
  _collectCodeTrust(metrics) {
    if (!this._aiCodeTrustScorer) return;
    try {
      const avgScore = this._aiCodeTrustScorer.getAverageScore();
      const riskDist = this._aiCodeTrustScorer.getRiskDistribution();
      metrics.codeTrust = {
        score: 1 - avgScore,
        averageTrustScore: avgScore,
        riskDistribution: riskDist,
      };
    } catch (_err) {
      metrics.codeTrust = { score: 0, error: true };
    }
  }

  /** @private */
  _collectDeliveryEfficiency(metrics) {
    if (!this._deliveryEfficiencyMeter) return;
    try {
      const effMetrics = this._deliveryEfficiencyMeter.getEfficiencyMetrics();
      const deviation = effMetrics.distributionDeviation ?? 0;
      const bottleneckScore = effMetrics.reviewBottleneckScore ?? 0;
      metrics.deliveryEfficiency = {
        score: Math.min(1, deviation * 0.5 + bottleneckScore * 0.5),
        distributionDeviation: deviation,
        reviewBottleneckScore: bottleneckScore,
        aiAccelerationRatio: effMetrics.aiAccelerationRatio ?? 0,
        codingRatio: effMetrics.codingRatio ?? 0,
      };
    } catch (_err) {
      metrics.deliveryEfficiency = { score: 0, error: true };
    }
  }

  /**
   * 根据各指标源数据计算统一熵评分。
   * @param {Object} metrics
   * @returns {number} 0-1 熵评分
   * @private
   */
  _calculateEntropyScore(metrics) {
    let weightedSum = 0;
    let totalWeight = 0;

    const metricKeyMap = {
      contextDrift: 'contextDrift',
      comprehensionDebt: 'comprehensionDebt',
      codeDrift: 'codeDrift',
      skillOverload: 'skillOverload',
      codeTrust: 'codeTrust',
      deliveryEfficiency: 'deliveryEfficiency',
    };

    for (const [key, metric] of Object.entries(metrics)) {
      const weight = this._weights[metricKeyMap[key] ?? key] ?? 0;
      if (weight > 0 && metric && typeof metric.score === 'number' && !metric.error) {
        weightedSum += metric.score * weight;
        totalWeight += weight;
      }
    }

    return totalWeight > 0 ? Math.min(1, Math.max(0, weightedSum / totalWeight)) : 0;
  }

  /**
   * 根据熵评分确定等级。
   * @param {number} score
   * @returns {string}
   * @private
   */
  _determineLevel(score) {
    if (score >= ENTROPY_THRESHOLDS.critical) return ENTROPY_LEVELS.CRITICAL;
    if (score >= ENTROPY_THRESHOLDS.high) return ENTROPY_LEVELS.HIGH;
    if (score >= ENTROPY_THRESHOLDS.medium) return ENTROPY_LEVELS.MEDIUM;
    if (score >= ENTROPY_THRESHOLDS.low) return ENTROPY_LEVELS.LOW;
    return ENTROPY_LEVELS.NONE;
  }

  /**
   * 生成熵治理建议。
   * @param {number} score
   * @param {Object} metrics
   * @returns {Array}
   * @private
   */
  _generateRecommendations(score, metrics) {
    const recs = [];

    if (metrics.contextDrift && metrics.contextDrift.score > 0.4) {
      recs.push({
        type: 'context-drift',
        priority: 'high',
        action: 'review-constraints',
        description: '上下文漂移较高，建议审查约束条件并补充丢失的约束',
      });
    }

    if (metrics.comprehensionDebt && metrics.comprehensionDebt.score > 0.5) {
      recs.push({
        type: 'comprehension-debt',
        priority: 'high',
        action: 'resolve-debts',
        description: '理解债务较高，建议优先解决 critical/high 级别债务',
      });
    }

    if (metrics.codeDrift && metrics.codeDrift.drifting) {
      recs.push({
        type: 'code-drift',
        priority: 'medium',
        action: 'reinforce-constraints',
        description: '代码漂移检测到，建议强化架构边界约束',
      });
    }

    if (metrics.skillOverload && metrics.skillOverload.level === 'overloaded') {
      recs.push({
        type: 'skill-overload',
        priority: 'medium',
        action: 'reduce-skill-load',
        description: '技能上下文过载，建议卸载非核心技能L2/L3层',
      });
    }

    if (metrics.codeTrust && metrics.codeTrust.score > 0.5) {
      recs.push({
        type: 'code-trust',
        priority: 'medium',
        action: 'improve-code-quality',
        description: 'AI代码可信度较低，建议增加测试覆盖和错误处理',
      });
    }

    if (metrics.deliveryEfficiency && metrics.deliveryEfficiency.score > 0.5) {
      recs.push({
        type: 'delivery-efficiency',
        priority: 'low',
        action: 'optimize-pipeline',
        description: '交付效率偏差较大，建议优化阶段时间分配',
      });
    }

    return recs;
  }

  /**
   * 触发主动简化流程。
   * @param {Object} result
   * @private
   */
  _triggerAutoSimplify(result) {
    this._simplifyTriggerCount++;

    const actions = [];

    // 1. 技能上下文简化
    if (this._skillReducer) {
      try {
        const unloaded = this._skillReducer.unloadAllL2();
        actions.push({ type: 'skill-unload', count: unloaded });
      } catch (err) {
        debug('EntropyGovernance', 'autoSimplify', 'skill-unload failed:', err && err.message ? err.message : String(err));
      }
    }

    // 2. 上下文压缩（通过事件通知其他模块）
    actions.push({ type: 'context-compression', reason: 'entropy-threshold' });

    this.emit('auto-simplify-triggered', {
      score: result.score,
      level: result.level,
      actions: actions,
      triggeredAt: Date.now(),
    });
  }

  /**
   * 触发约束强化闭环。
   * @param {Object} result
   * @private
   */
  _triggerConstraintReinforcement(result) {
    this._reinforceTriggerCount++;

    this.emit('constraint-reinforce-triggered', {
      score: result.score,
      level: result.level,
      metrics: result.metrics ?? {},
      recommendations: result.recommendations ?? [],
      triggeredAt: Date.now(),
    });
  }

  /**
   * 绑定各指标源的事件监听。
   * @private
   */
  _attachEventListeners() {
    if (this._contextDriftMonitor) {
      this._contextDriftMonitor.on('drift-detected', this._boundOnDriftDetected);
    }
    if (this._comprehensionDebtTracker) {
      this._comprehensionDebtTracker.on('debt-recorded', this._boundOnDebtRecorded);
    }
    if (this._skillReducer) {
      this._skillReducer.on('overload-detected', this._boundOnOverload);
    }
    if (this._aiCodeTrustScorer) {
      this._aiCodeTrustScorer.on('assessed', this._boundOnAssessed);
    }
  }

  /**
   * 解绑所有事件监听。
   * @private
   */
  _detachEventListeners() {
    if (this._contextDriftMonitor) {
      this._contextDriftMonitor.removeListener('drift-detected', this._boundOnDriftDetected);
    }
    if (this._comprehensionDebtTracker) {
      this._comprehensionDebtTracker.removeListener('debt-recorded', this._boundOnDebtRecorded);
    }
    if (this._skillReducer) {
      this._skillReducer.removeListener('overload-detected', this._boundOnOverload);
    }
    if (this._aiCodeTrustScorer) {
      this._aiCodeTrustScorer.removeListener('assessed', this._boundOnAssessed);
    }
  }

  // ─── 事件处理器 ──────────────────────────────────────────────

  _onDriftDetected(data) {
    debug('EntropyGovernance', 'drift-detected', 'level=' + data.level + ' score=' + data.driftScore);
    // 漂移事件触发即时评估
    this.assess();
  }

  _onDebtRecorded(data) {
    if (data && data.severity === 'critical') {
      debug('EntropyGovernance', 'critical-debt', data.description || '');
      this.assess();
    }
  }

  _onOverload(data) {
    debug('EntropyGovernance', 'skill-overload', 'level=' + data.level);
    this.assess();
  }

  _onTrustAssessed(data) {
    if (data && data.level === 'unreliable') {
      debug('EntropyGovernance', 'unreliable-code', 'recommendation=' + data.recommendation);
      this.assess();
    }
  }

  // ─── 定时评估 ────────────────────────────────────────────────

  _startPeriodicAssessment() {
    if (this._config.assessmentIntervalMs > 0) {
      this._assessmentTimer = setInterval(() => {
        if (this._shutDown) return;
        try { this.assess(); }
        catch (err) { debug('EntropyGovernance', 'periodicAssess', err && err.message ? err.message : String(err)); }
      }, this._config.assessmentIntervalMs);
      if (this._assessmentTimer && typeof this._assessmentTimer.unref === 'function') {
        this._assessmentTimer.unref();
      }
    }
  }

  // ─── 生命周期 ────────────────────────────────────────────────

  _onShutdown() {
    if (this._assessmentTimer) {
      clearInterval(this._assessmentTimer);
      this._assessmentTimer = null;
    }
    this._detachEventListeners();
    if (this._history) {
      this._history.shutdown();
      this._history = null;
    }
    this._contextDriftMonitor = null;
    this._comprehensionDebtTracker = null;
    this._codeDriftDetector = null;
    this._skillReducer = null;
    this._aiCodeTrustScorer = null;
    this._deliveryEfficiencyMeter = null;
    this.removeAllListeners();
  }
}

// ─── 导出 ───────────────────────────────────────────────────────

module.exports = {
  EntropyGovernanceOrchestrator: withShutdown(EntropyGovernanceOrchestrator),
  ENTROPY_LEVELS: ENTROPY_LEVELS,
  ENTROPY_THRESHOLDS: ENTROPY_THRESHOLDS,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
};
