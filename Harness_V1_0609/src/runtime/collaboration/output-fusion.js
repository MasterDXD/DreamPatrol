'use strict';

const { EventEmitter } = require('events');
const { DEFAULT_CONFIDENCE } = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const RingBuffer = require('../../utils/ring-buffer');
const { ensureArray } = require('../../utils/safe-execute');

const FUSION_STRATEGIES = {
  CASCADE: 'cascade',
  VOTE: 'vote',
  WEIGHTED: 'weighted',
  REVIEW: 'review',
};

/**
 * @module runtime/collaboration/output-fusion
 * @classdesc 输出融合。多Agent结果合并、冲突解决、质量加权
 * OutputFusion — 多Agent输出融合器
 * 将多个Agent的输出结果合并为单一高质量结果，支持四种融合策略：
 * Cascade（级联，按置信度降序取首个有效结果）、Vote（投票，多数表决）、
 * Weighted（加权，按置信度加权平均）、Review（审查，高置信度结果优先+低置信度补充）。
 * 维护融合历史环形缓冲区用于审计和回溯。
 * @extends EventEmitter
 * @emits OutputFusion#fusion-complete
 */
class OutputFusion extends EventEmitter {
  /**
   * 创建OutputFusion实例
   * @param {Object} [options] - 配置选项
   * @param {string} [options.defaultStrategy='cascade'] - 默认融合策略
   * @param {number} [options.maxHistory=200] - 融合历史环形缓冲区最大容量
   */
  constructor(options) {
    super();
    this._defaultStrategy = (options && options.defaultStrategy) ?? FUSION_STRATEGIES.CASCADE;
    this._maxHistory = Math.max(1, (options && options.maxHistory) || 200);
    this._fusionHistory = new RingBuffer(this._maxHistory);
  }

  /**
   * 融合多个Agent的输出结果为单一高质量结果
   * 支持四种策略：cascade（级联，按优先级取主结果+补充缺失字段）、vote（投票，按置信度加权多数表决）、
   * weighted（加权，按权重归一化合并数值字段）、review（审查，实现者输出+审查者反馈）。
   * 单个结果时直接返回，空或无效输入返回零置信度。
   * @param {Array<{ output: *, confidence?: number, agentId: string }>} results - Agent输出结果数组
   * @param {string} [strategy] - 融合策略，可选 cascade/vote/weighted/review
   * @param {object} [options] - 策略相关选项
   * @param {string[]} [options.priorityOrder] - Agent优先级排序（cascade/review策略）
   * @param {string} [options.voteField='decision'] - 投票字段名（vote策略）
   * @param {object} [options.weights] - Agent权重映射（weighted策略）
   * @returns {Promise<{ fused: *, strategy: string, confidence: number, metadata?: object }>} 融合结果
   * @example
   * const fusion = new OutputFusion();
   * const result = fusion.fuse({
   *   outputs: [
   *     { agent: 'analyst', content: 'Design complete', score: 0.9 },
   *     { agent: 'reviewer', content: 'Approved', score: 0.85 }
   *   ],
   *   strategy: 'weighted-average',
   *   weights: { analyst: 0.6, reviewer: 0.4 }
   * });
   * console.log(result.fused, result.confidence);
   */
  async fuse(results, strategy, options) {
    this.guardShutdown();
    if (!Array.isArray(results) || results.length === 0) {
      return { fused: null, strategy: strategy || this._defaultStrategy, confidence: 0 };
    }

    const filtered = results.filter(r => r != null);
    if (filtered.length === 0) {
      return { fused: null, strategy: strategy || this._defaultStrategy, confidence: 0 };
    }

    if (filtered.length === 1) {
      return {
        fused: filtered[0].output,
        strategy: 'single',
        confidence: filtered[0].confidence ?? DEFAULT_CONFIDENCE,
        metadata: { agentCount: 1 },
      };
    }

    const effectiveStrategy = strategy || this._defaultStrategy;
    let fusionResult;

    switch (effectiveStrategy) {
      case FUSION_STRATEGIES.CASCADE:
        fusionResult = this._cascadeFusion(filtered, options);
        break;
      case FUSION_STRATEGIES.VOTE:
        fusionResult = this._voteFusion(filtered, options);
        break;
      case FUSION_STRATEGIES.WEIGHTED:
        fusionResult = this._weightedFusion(filtered, options);
        break;
      case FUSION_STRATEGIES.REVIEW:
        fusionResult = this._reviewFusion(filtered, options);
        break;
      default:
        fusionResult = this._cascadeFusion(filtered, options);
    }

    if (this._shutDown) return { fused: null, strategy: effectiveStrategy, confidence: 0 };

    const record = {
      strategy: effectiveStrategy,
      agentCount: filtered.length,
      confidence: fusionResult.confidence,
      timestamp: new Date().toISOString(),
    };
    this._fusionHistory.push(record);
    this.emit('fusion-complete', record);
    return fusionResult;
  }

  _cascadeFusion(results, options) {
    const ordered = this._orderByPriority(results, options);
    if (ordered.length === 0) return { fused: null, strategy: FUSION_STRATEGIES.CASCADE, confidence: 0 };
    const primary = ordered[0];
    const supplements = ordered.slice(1);

    let fused = primary.output;
    if (Array.isArray(fused)) {
      fused = [...fused];
    } else if (typeof fused === 'object' && fused !== null) {
      fused = { ...fused };
      for (const supplement of supplements) {
        if (typeof supplement.output === 'object' && supplement.output !== null) {
          for (const key of Object.keys(supplement.output)) {
            if (fused[key] === undefined) {
              fused[key] = supplement.output[key];
            }
          }
        }
      }
    }

    const confidence = primary?.confidence ?? DEFAULT_CONFIDENCE;
    return {
      fused,
      strategy: FUSION_STRATEGIES.CASCADE,
      confidence,
      metadata: {
        primaryAgent: primary.agentId,
        supplementCount: supplements.length,
      },
    };
  }

  _voteFusion(results, options) {
    const voteField = (options && options.voteField) ?? 'decision';
    const votes = {};
    const weights = {};

    for (const result of results) {
      const vote = this._extractVote(result, voteField);
      const rawConf = result.confidence; const weight = typeof rawConf === 'number' && Number.isFinite(rawConf) ? rawConf : 1.0;
      votes[vote] = (votes[vote] ?? 0) + weight;
      weights[vote] = (weights[vote] ?? 0) + 1;
    }

    let winner = null;
    let maxVotes = -Infinity;
    for (const [vote, totalWeight] of Object.entries(votes)) {
      if (totalWeight > maxVotes) {
        maxVotes = totalWeight;
        winner = vote;
      }
    }

    const totalWeight = Object.values(votes).reduce((a, b) => a + b, 0);
    if (totalWeight === 0) winner = null;
    const confidence = totalWeight > 0 ? maxVotes / totalWeight : 0;

    if (!winner) {
      return {
        fused: { [voteField]: 'no_consensus', voteDistribution: votes },
        strategy: FUSION_STRATEGIES.VOTE,
        confidence: 0,
        metadata: {
          totalVoters: results.length,
          winnerVotes: 0,
        },
      };
    }

    return {
      fused: { [voteField]: winner, voteDistribution: votes },
      strategy: FUSION_STRATEGIES.VOTE,
      confidence,
      metadata: {
        totalVoters: results.length,
        winnerVotes: weights[winner] ?? 0,
      },
    };
  }

  _weightedFusion(results, options) {
    const weights = (options && options.weights) ?? {};
    const totalWeight = results.reduce((sum, r) => {
      const w = this._resolveWeight(r, weights);
      return sum + w;
    }, 0);

    if (totalWeight === 0) {
      return {
        fused: results.length > 0 ? results[0].output : null,
        strategy: FUSION_STRATEGIES.WEIGHTED,
        confidence: 0,
        metadata: { totalWeight: 0 },
      };
    }

    if (this._hasMixedOutputTypes(results)) {
      return this._cascadeFusion(results, options);
    }

    let normalizedTotalWeight = totalWeight;
    if (options && options.weights && totalWeight > 0) {
      normalizedTotalWeight = results.length;
    }

    const safeResults = ensureArray(results);
    const sorted = [...safeResults].sort((a, b) => {
      const wa = this._resolveWeight(a, weights);
      const wb = this._resolveWeight(b, weights);
      return wb - wa;
    });
    const mergedOutput = this._mergeWeightedOutputs(sorted, weights, totalWeight);
    const confidence = normalizedTotalWeight > 0 ? Math.min(normalizedTotalWeight / results.length, 1.0) : 0;

    return {
      fused: mergedOutput,
      strategy: FUSION_STRATEGIES.WEIGHTED,
      confidence,
      metadata: {
        weights,
        totalWeight,
        agentCount: results.length,
      },
    };
  }

  _resolveWeight(result, weights) {
    const rawW = weights[result.agentId];
    if (typeof rawW === 'number' && Number.isFinite(rawW)) return rawW;
    if (typeof result.confidence === 'number' && Number.isFinite(result.confidence)) return result.confidence;
    return DEFAULT_CONFIDENCE;
  }

  _mergeWeightedOutputs(sorted, weights, totalWeight) {
    let mergedOutput = {};
    for (const result of sorted) {
      const w = this._resolveWeight(result, weights);
      const normalizedWeight = totalWeight > 0 ? w / totalWeight : 0;

      if (Array.isArray(result.output)) {
        if (!Array.isArray(mergedOutput)) mergedOutput = [];
        for (let i = 0; i < result.output.length; i++) {
          if (mergedOutput[i] === undefined) mergedOutput[i] = result.output[i];
        }
      } else if (typeof result.output === 'object' && result.output !== null) {
        for (const [key, value] of Object.entries(result.output)) {
          if (typeof value === 'number' && Number.isFinite(value)) {
            mergedOutput[key] = (mergedOutput[key] ?? 0) + value * normalizedWeight;
          } else if (mergedOutput[key] === undefined) {
            mergedOutput[key] = value;
          }
        }
      }
    }
    return mergedOutput;
  }

  _reviewFusion(results, options) {
    const ordered = this._orderByPriority(results, options);
    if (ordered.length === 0) return { fused: null, strategy: FUSION_STRATEGIES.REVIEW, confidence: 0 };
    const implementer = ordered[0];
    const reviewers = ordered.slice(1);

    const reviewFeedback = [];
    for (const reviewer of reviewers) {
      if (reviewer.output && typeof reviewer.output === 'object') {
        reviewFeedback.push({
          agentId: reviewer.agentId,
          feedback: reviewer.output.feedback || reviewer.output.review || '',
          approved: reviewer.output.approved !== false,
        });
      }
    }

    const allApproved = reviewFeedback.length > 0 && reviewFeedback.every(r => r.approved);
    const confidence = allApproved ? 0.9 : (reviewFeedback.length > 0 ? DEFAULT_CONFIDENCE : 0.3);

    return {
      fused: {
        output: implementer.output,
        reviews: reviewFeedback,
        approved: allApproved,
      },
      strategy: FUSION_STRATEGIES.REVIEW,
      confidence,
      metadata: {
        implementer: implementer.agentId,
        reviewerCount: reviewers.length,
        allApproved,
      },
    };
  }

  _hasMixedOutputTypes(results) {
    const outputTypes = new Set();
    for (const r of results) {
      if (Array.isArray(r.output)) outputTypes.add('array');
      else if (r.output !== null && typeof r.output === 'object') outputTypes.add('object');
      else outputTypes.add('primitive');
    }
    return outputTypes.size > 1;
  }

  _extractVote(result, voteField) {
    if (result.output && typeof result.output === 'object') {
      const val = result.output[voteField];
      if (val != null) return String(val);
      const decision = result.output.decision;
      if (decision != null) return String(decision);
      return 'abstain';
    }
    if (result.output != null) return String(result.output);
    return 'abstain';
  }

  _orderByPriority(results, options) {
    const priorityOrder = (options && options.priorityOrder) ?? [];
    const safeResults = ensureArray(results);
    if (priorityOrder.length === 0) {
      return [...safeResults].sort((a, b) => (b.confidence ?? DEFAULT_CONFIDENCE) - (a.confidence ?? DEFAULT_CONFIDENCE));
    }

    return [...safeResults].sort((a, b) => {
      const idxA = priorityOrder.indexOf(a.agentId);
      const idxB = priorityOrder.indexOf(b.agentId);
      const orderA = idxA === -1 ? 999 : idxA;
      const orderB = idxB === -1 ? 999 : idxB;
      if (orderA !== orderB) return orderA - orderB;
      return (b.confidence ?? DEFAULT_CONFIDENCE) - (a.confidence ?? DEFAULT_CONFIDENCE);
    });
  }

  /**
   * 获取融合器运行统计信息
   * @returns {{ totalFusions: number, defaultStrategy: string, strategyCounts: object, avgConfidence: number, avgAgentCount: number, recentFusions: Array }} 统计数据
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('OutputFusion', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalFusions: 0, defaultStrategy: this._defaultStrategy, strategyCounts: {}, avgConfidence: 0, avgAgentCount: 0, recentFusions: [] }; }
    const strategyCounts = this._countByStrategy();
    const totalConfidence = this._fusionHistory.reduce((sum, r) => sum + (r.confidence ?? 0), 0);
    const recentHistory = this._fusionHistory.slice(-10);
    const len = this._fusionHistory.size;
    return {
      totalFusions: len,
      defaultStrategy: this._defaultStrategy,
      strategyCounts: strategyCounts,
      avgConfidence: len > 0
        ? Number((totalConfidence / len).toFixed(4))
        : 0,
      avgAgentCount: len > 0
        ? Number((this._fusionHistory.reduce((sum, r) => sum + (r.agentCount ?? 0), 0) / len).toFixed(2))
        : 0,
      recentFusions: recentHistory.map(function(r) {
        return {
          strategy: r.strategy,
          agentCount: r.agentCount,
          confidence: r.confidence ? Number(r.confidence.toFixed(4)) : 0,
          timestamp: r.timestamp,
        };
      }),
    };
  }

  _countByStrategy() {
    const counts = {};
    for (const record of this._fusionHistory) {
      counts[record.strategy] = (counts[record.strategy] ?? 0) + 1;
    }
    return counts;
  }

  _onShutdown() {
    this._fusionHistory.clear();
    this.removeAllListeners();
  }
}

OutputFusion = withShutdown(OutputFusion);

OutputFusion.STRATEGIES = FUSION_STRATEGIES;

module.exports = OutputFusion;
