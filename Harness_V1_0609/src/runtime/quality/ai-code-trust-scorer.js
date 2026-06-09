'use strict';

/** @module runtime/quality/ai-code-trust-scorer */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const RingBuffer = require('../../utils/ring-buffer');
const safeAssign = require('../../utils/safe-assign');

const TRUST_LEVELS = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNRELIABLE: 'unreliable',
};

const TRUST_THRESHOLDS = {
  high: 0.8,
  medium: 0.6,
  low: 0.4,
};

const RISK_INDICATORS = {
  NO_TESTS: { weight: 0.13, label: 'no-tests' },
  UNHANDLED_EDGE: { weight: 0.17, label: 'unhandled-edge-cases' },
  IMPLICIT_DEPS: { weight: 0.10, label: 'implicit-dependencies' },
  MAGIC_VALUES: { weight: 0.08, label: 'magic-values' },
  MISSING_ERROR_HANDLING: { weight: 0.16, label: 'missing-error-handling' },
  SPEC_VIOLATION: { weight: 0.13, label: 'spec-violation' },
  CONTEXT_DRIFT: { weight: 0.09, label: 'context-drift' },
  ALMOST_CORRECT: { weight: 0.14, label: 'almost-correct' },
};

const MAX_HISTORY = 500;
const DECAY_FACTOR = 0.95;
const SEVEN_DAYS_MS = 7 * 86400000;

/**
 * AI代码可信度评估器
 * @classdesc AI代码可信度评估器。8项风险指标检测（含"似对非对"模式）
 * 基于7项风险指标检测AI生成代码的可信度，
 * 按来源追踪可信度趋势，支持指数衰减的时间衰减机制。
 *
 * @extends EventEmitter
 * @emits AiCodeTrustScorer#assessed 代码评估完成时触发
 */
class AiCodeTrustScorer extends EventEmitter {
  /**
   * 创建AiCodeTrustScorer实例
   *
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.thresholds] - 自定义信任等级阈值
   * @param {Object} [options.riskIndicators] - 自定义风险指标权重
   * @param {number} [options.maxHistory=500] - 历史记录最大容量
   * @param {number} [options.decayFactor=0.95] - 来源评分每日衰减因子
   */
  constructor(options) {
    super();
    this._options = options ?? {};
    this._thresholds = safeAssign({}, TRUST_THRESHOLDS, (this._options.thresholds) ?? {});
    this._riskIndicators = safeAssign({}, RISK_INDICATORS, (this._options.riskIndicators) ?? {});
    this._history = new RingBuffer(this._options.maxHistory ?? MAX_HISTORY);
    this._sourceScores = new Map();
    this._decayFactor = this._options.decayFactor ?? DECAY_FACTOR;
  }

  /**
   * 评估代码上下文的可信度。检测7项风险指标，计算综合评分和信任等级。
   *
   * @param {Object} codeContext - 代码上下文对象
   * @param {boolean} [codeContext.hasTests] - 是否有测试
   * @param {Array} [codeContext.tests] - 测试列表
   * @param {boolean} [codeContext.edgeCasesHandled] - 是否处理了边界情况
   * @param {boolean} [codeContext.implicitDependencies] - 是否存在隐式依赖
   * @param {boolean} [codeContext.magicValues] - 是否存在魔法值
   * @param {boolean} [codeContext.errorHandlingComplete] - 错误处理是否完整
   * @param {boolean} [codeContext.specCompliant] - 是否符合规格
   * @param {boolean} [codeContext.contextDrift] - 是否存在上下文漂移
   * @returns {{score: number, level: string, risks: Array, riskCount: number, recommendation: string, assessedAt: number}} 评估结果
   */
  assess(codeContext) {
    this.guardShutdown();
    if (!codeContext || typeof codeContext !== 'object') {
      return { score: 0, level: TRUST_LEVELS.UNRELIABLE, risks: [], recommendation: 'reject' };
    }

    const risks = this._detectRisks(codeContext);
    const riskPenalty = risks.reduce((sum, r) => { const w = (typeof r.weight === 'number' && Number.isFinite(r.weight)) ? r.weight : 0; const s = (typeof r.severity === 'number' && Number.isFinite(r.severity)) ? r.severity : 0; return sum + w * s; }, 0);
    const baseScore = 1.0;
    const score = Math.max(0, Math.min(1, baseScore - riskPenalty));
    const level = this._classifyLevel(score);
    const recommendation = this._getRecommendation(score, risks);

    const result = {
      score: Math.round(score * 1000) / 1000,
      level,
      risks,
      riskCount: risks.length,
      recommendation,
      assessedAt: Date.now(),
    };

    this._history.push(result);
    this.emit('assessed', result);
    return result;
  }

  /**
   * 评估代码并关联来源追踪。更新来源的可信度评分。
   *
   * @param {string} sourceId - 代码来源标识
   * @param {Object} codeContext - 代码上下文对象（同assess参数）
   * @returns {Object} 评估结果，额外包含sourceId和sourceTrustScore
   */
  assessWithSource(sourceId, codeContext) {
    this.guardShutdown();
    const result = this.assess(codeContext);
    if (sourceId && typeof sourceId === 'string') {
      this._updateSourceScore(sourceId, result.score);
      result.sourceId = sourceId;
      result.sourceTrustScore = this.getSourceTrustScore(sourceId);
    }
    return result;
  }

  _detectRisks(ctx) {
    const risks = [];

    if (ctx.hasTests === false || (Array.isArray(ctx.tests) && ctx.tests.length === 0)) {
      risks.push({ ...this._riskIndicators.NO_TESTS, severity: 1.0 });
    }

    if (ctx.edgeCasesHandled === false) {
      risks.push({ ...this._riskIndicators.UNHANDLED_EDGE, severity: 0.8 });
    }

    if (ctx.implicitDependencies === true || (Array.isArray(ctx.unlistedDeps) && ctx.unlistedDeps.length > 0)) {
      risks.push({ ...this._riskIndicators.IMPLICIT_DEPS, severity: 0.7 });
    }

    if (ctx.magicValues === true || (Array.isArray(ctx.hardcodedValues) && ctx.hardcodedValues.length > 3)) {
      risks.push({ ...this._riskIndicators.MAGIC_VALUES, severity: 0.6 });
    }

    if (ctx.errorHandlingComplete === false) {
      risks.push({ ...this._riskIndicators.MISSING_ERROR_HANDLING, severity: 0.9 });
    }

    if (ctx.specCompliant === false) {
      risks.push({ ...this._riskIndicators.SPEC_VIOLATION, severity: 0.8 });
    }

    if (ctx.contextDrift === true || (typeof ctx.driftScore === 'number' && ctx.driftScore > 0.3)) {
      risks.push({ ...this._riskIndicators.CONTEXT_DRIFT, severity: 0.7 });
    }

    this._checkAlmostCorrect(ctx, risks);

    return risks;
  }

  _checkAlmostCorrect(ctx, risks) {
    if (ctx.almostCorrect === true || (typeof ctx.subtleBugCount === 'number' && ctx.subtleBugCount > 0)) {
      const severity = (typeof ctx.subtleBugCount === 'number' && ctx.subtleBugCount >= 3) ? 0.9
        : (typeof ctx.subtleBugCount === 'number' && ctx.subtleBugCount >= 2) ? 0.8 : 0.7;
      risks.push({ ...this._riskIndicators.ALMOST_CORRECT, severity });
    } else if (ctx.passesBasicTests === true && ctx.edgeCasesHandled === false && ctx.errorHandlingComplete === false) {
      risks.push({ ...this._riskIndicators.ALMOST_CORRECT, severity: 0.6 });
    }
  }

  _classifyLevel(score) {
    if (score >= this._thresholds.high) return TRUST_LEVELS.HIGH;
    if (score >= this._thresholds.medium) return TRUST_LEVELS.MEDIUM;
    if (score >= this._thresholds.low) return TRUST_LEVELS.LOW;
    return TRUST_LEVELS.UNRELIABLE;
  }

  _getRecommendation(score, risks) {
    if (score >= 0.8) return 'accept';
    if (score >= 0.6) return 'review-carefully';
    if (risks.some(r => r.severity >= 0.9)) return 'reject-and-revise';
    return 'reject';
  }

  _updateSourceScore(sourceId, score) {
    if (!this._sourceScores.has(sourceId)) {
      if (this._sourceScores.size >= 500) {
        let oldestId = null;
        let oldestTime = Infinity;
        for (const [id, data] of this._sourceScores) {
          if (data.lastAssessedAt < oldestTime) {
            oldestTime = data.lastAssessedAt;
            oldestId = id;
          }
        }
        if (oldestId) this._sourceScores.delete(oldestId);
      }
      this._sourceScores.set(sourceId, { score, samples: 1, totalScore: score, lastAssessedAt: Date.now() });
    } else {
      const data = this._sourceScores.get(sourceId);
      if (!data) return;
      const now = Date.now();
      const daysSinceUpdate = (now - data.lastAssessedAt) / 86400000;
      if (Number.isFinite(daysSinceUpdate) && daysSinceUpdate > 0) {
        const decay = Math.pow(Math.abs(this._decayFactor), daysSinceUpdate);
        const decayedScore = 0.5 + (data.score - 0.5) * decay;
        data.totalScore = decayedScore * data.samples;
      }
      data.samples++;
      data.totalScore += score;
      data.score = data.totalScore / data.samples;
      data.lastAssessedAt = now;
    }
  }

  /**
   * 获取指定来源的可信度评分。
   *
   * @param {string} sourceId - 来源标识
   * @returns {number} 可信度评分（0-1），未知来源返回0.5
   */
  getSourceTrustScore(sourceId) {
    this.guardShutdown();
    const data = this._sourceScores.get(sourceId);
    return data ? data.score : 0.5;
  }

  /**
   * 获取指定来源的统计信息。
   *
   * @param {string} sourceId - 来源标识
   * @returns {{score: number, samples: number, lastAssessedAt: number}|null} 来源统计，不存在返回null
   */
  getSourceStats(sourceId) {
    this.guardShutdown();
    const data = this._sourceScores.get(sourceId);
    return data ? { score: data.score, samples: data.samples, lastAssessedAt: data.lastAssessedAt } : null;
  }

  /**
   * 对所有来源的可信度评分执行时间衰减。超过7天未更新且评分接近0.5的来源将被移除。
   *
   * @returns {void}
   */
  decaySourceScores() {
    this.guardShutdown();
    if (this._decaying) return;
    this._decaying = true;
    try {
      const now = Date.now();
      const toDelete = [];
      for (const [sourceId, data] of this._sourceScores) {
        const daysSinceUpdate = (now - data.lastAssessedAt) / 86400000;
        if (Number.isFinite(daysSinceUpdate) && daysSinceUpdate > 0) {
          const decay = Math.pow(Math.abs(this._decayFactor), daysSinceUpdate);
          data.score = 0.5 + (data.score - 0.5) * decay;
          data.totalScore = data.score * data.samples;
        }
        if (Math.abs(data.score - 0.5) < 0.01 && (now - data.lastAssessedAt) > SEVEN_DAYS_MS) {
          toDelete.push(sourceId);
        }
      }
      for (const id of toDelete) {
        this._sourceScores.delete(id);
      }
    } finally {
      this._decaying = false;
    }
  }

  /**
   * 获取评估历史记录。
   *
   * @returns {Array<Object>} 评估结果数组
   */
  getHistory() {
    return this._history.toArray().map(h => ({ ...h, risks: h.risks.slice() }));
  }

  /**
   * 计算历史评估的平均评分。
   *
   * @returns {number} 平均评分（0-1），无历史时返回0
   */
  getAverageScore() {
    const history = this._history.toArray();
    if (history.length === 0) return 0;
    return history.reduce((sum, h) => sum + h.score, 0) / history.length;
  }

  /**
   * 获取历史评估中各风险指标的出现次数分布。
   *
   * @returns {Object<string, number>} 风险标签到出现次数的映射
   */
  getRiskDistribution() {
    const history = this._history.toArray();
    const dist = {};
    for (const h of history) {
      for (const r of h.risks) {
        dist[r.label] = (dist[r.label] ?? 0) + 1;
      }
    }
    return dist;
  }

  _onShutdown() {
    this._sourceScores.clear();
    this._history = new RingBuffer(this._options.maxHistory ?? MAX_HISTORY);
    this._thresholds = { ...TRUST_THRESHOLDS };
    this._riskIndicators = { ...RISK_INDICATORS };
    this._decayFactor = DECAY_FACTOR;
    this._options = {};
    this.removeAllListeners();
  }
}

AiCodeTrustScorer.TRUST_LEVELS = TRUST_LEVELS;
AiCodeTrustScorer.RISK_INDICATORS = RISK_INDICATORS;

module.exports = withShutdown(AiCodeTrustScorer);
