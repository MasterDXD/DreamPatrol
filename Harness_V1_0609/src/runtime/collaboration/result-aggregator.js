/**
 * @module runtime/collaboration/result-aggregator
 * @description 结果聚合器模块，将多个子代理的结果聚合为一致的交付物。
 * 支持投票、融合、摘要、层级汇总和择优五种聚合策略，
 * 并对聚合结果进行质量评估。
 * @extends EventEmitter
 * @emits ResultAggregator#aggregated 结果聚合完成事件
 */

'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, clamp01 } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

/** @constant {Object} AGGREGATION_STRATEGY - 聚合策略枚举 */
const AGGREGATION_STRATEGY = Object.freeze({
  VOTE: 'vote',               // 多数投票
  FUSION: 'fusion',           // 内容融合
  SUMMARY: 'summary',         // 摘要合成
  HIERARCHICAL: 'hierarchical', // 层级汇总
  BEST_OF: 'best_of',         // 择优选择
});

/** @constant {number} MAX_HISTORY - 聚合历史最大条目数 */
const MAX_HISTORY = 500;

/** @constant {Object} DEFAULT_CONFIG - 默认配置 */
const DEFAULT_CONFIG = {
  defaultStrategy: AGGREGATION_STRATEGY.FUSION,
  qualityThreshold: 0.7,
  maxRetries: 2,
};

/**
 * @class ResultAggregator
 * @classdesc 结果聚合器，将多个子代理的结果聚合为一致的交付物。
 * 支持五种聚合策略：投票（多数表决）、融合（内容合并）、摘要（合成总结）、
 * 层级汇总（分层聚合）、择优（选择最优结果），并评估聚合质量。
 * @extends EventEmitter
 */
class ResultAggregator extends EventEmitter {
  /**
   * 创建ResultAggregator实例
   * @param {Object} [config={}] - 配置选项
   * @param {string} [config.defaultStrategy='fusion'] - 默认聚合策略
   * @param {number} [config.qualityThreshold=0.7] - 质量阈值（0-1）
   * @param {number} [config.maxRetries=2] - 最大重试次数
   */
  constructor(config = {}) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._aggregationHistory = [];
    this._llmClient = null;
  }

  /**
   * 聚合多个子代理的结果
   * @param {Array<Object>} results - 待聚合的结果数组
   * @param {Object} [options={}] - 聚合选项
   * @param {string} [options.strategy] - 指定聚合策略，未指定时使用默认策略
   * @returns {{ success: boolean, strategy: string, aggregated: *, qualityScore: number, sourceCount: number, timestamp: number }} 聚合结果
   * @emits ResultAggregator#aggregated
   */
  aggregate(results, options = {}) {
    this.guardShutdown();
    if (!Array.isArray(results) || results.length === 0) {
      return { success: false, reason: 'no_results', aggregated: null };
    }

    const strategy = options.strategy ?? this._config.defaultStrategy;

    let aggregated;
    try {
      switch (strategy) {
        case AGGREGATION_STRATEGY.VOTE:
          aggregated = this._aggregateByVote(results, options);
          break;
        case AGGREGATION_STRATEGY.FUSION:
          aggregated = this._aggregateByFusion(results, options);
          break;
        case AGGREGATION_STRATEGY.SUMMARY:
          aggregated = this._aggregateBySummary(results, options);
          break;
        case AGGREGATION_STRATEGY.HIERARCHICAL:
          aggregated = this._aggregateByHierarchy(results, options);
          break;
        case AGGREGATION_STRATEGY.BEST_OF:
          aggregated = this._aggregateByBestOf(results, options);
          break;
        default:
          aggregated = this._aggregateByFusion(results, options);
      }
    } catch (err) {
      this.emit('aggregation-error', { strategy, error: err.message });
      return { success: false, strategy, aggregated: null, qualityScore: 0, sourceCount: results.length, timestamp: Date.now() };
    }

    const qualityScore = this._assessQuality(aggregated, results);
    const finalResult = {
      success: qualityScore >= this._config.qualityThreshold,
      strategy,
      aggregated,
      qualityScore,
      sourceCount: results.length,
      timestamp: Date.now(),
    };

    if (this._aggregationHistory.length >= MAX_HISTORY) {
      this._aggregationHistory.shift();
    }
    this._aggregationHistory.push({
      strategy,
      sourceCount: results.length,
      qualityScore,
      success: finalResult.success,
      timestamp: finalResult.timestamp,
    });

    this.emit('aggregated', finalResult);
    return finalResult;
  }

  /**
   * 多数投票聚合 — 对分类结果进行多数表决
   * @param {Array<Object>} results - 结果数组，每个结果应包含可投票的字段
   * @param {Object} options - 聚合选项
   * @param {string} [options.voteField='decision'] - 投票字段名
   * @returns {{ winner: string|null, votes: Object, confidence: number }} 投票结果
   * @private
   */
  _aggregateByVote(results, options) {
    return safeExecute(() => {
      const voteField = (options && options.voteField) || 'decision';
      const tally = {};

      for (const result of results) {
        const vote = this._extractVoteValue(result, voteField);
        tally[vote] = (tally[vote] ?? 0) + 1;
      }

      let winner = null;
      let maxVotes = 0;
      for (const [candidate, count] of Object.entries(tally)) {
        if (count > maxVotes) {
          maxVotes = count;
          winner = candidate;
        }
      }

      const totalVotes = results.length;
      const confidence = totalVotes > 0 ? maxVotes / totalVotes : 0;

      return {
        winner,
        votes: tally,
        confidence,
      };
    }, 'ResultAggregator', 'aggregateByVote', { winner: null, votes: {}, confidence: 0 });
  }

  /**
   * 内容融合聚合 — 合并不同结果中的内容段落
   * @param {Array<Object>} results - 结果数组
   * @param {Object} _options - 聚合选项（保留）
   * @returns {{ content: Object, mergedFields: number, totalFields: number }} 融合结果
   * @private
   */
  _aggregateByFusion(results, _options) {
    return safeExecute(() => {
      const merged = {};
      let mergedFields = 0;
      let totalFields = 0;

      for (const result of results) {
        const content = this._extractContent(result);
        if (content && typeof content === 'object') {
          for (const [key, value] of Object.entries(content)) {
            totalFields++;
            if (merged[key] === undefined) {
              merged[key] = value;
              mergedFields++;
            } else if (Array.isArray(merged[key]) && Array.isArray(value)) {
              // Merge arrays, deduplicate by JSON string
              const existing = new Set(merged[key].map(v => JSON.stringify(v)));
              for (const item of value) {
                if (!existing.has(JSON.stringify(item))) {
                  merged[key].push(item);
                }
              }
              mergedFields++;
            }
            // If key already exists and is not an array, keep the first value
          }
        } else if (typeof content === 'string') {
          totalFields++;
          const field = 'content';
          if (merged[field] === undefined) {
            merged[field] = [content];
            mergedFields++;
          } else if (Array.isArray(merged[field])) {
            merged[field].push(content);
            mergedFields++;
          }
        }
      }

      return {
        content: merged,
        mergedFields,
        totalFields,
      };
    }, 'ResultAggregator', 'aggregateByFusion', { content: {}, mergedFields: 0, totalFields: 0 });
  }

  /**
   * 摘要合成聚合 — 将多个结果合成为摘要
   * @param {Array<Object>} results - 结果数组
   * @param {Object} _options - 聚合选项（保留）
   * @returns {{ summary: string, sourceCount: number, keyPoints: Array<string> }} 摘要结果
   * @private
   */
  _aggregateBySummary(results, _options) {
    return safeExecute(() => {
      // Try LLM-based summarization if client is attached
      if (this._llmClient && typeof this._llmClient.summarize === 'function') {
        const llmSummary = this._llmClient.summarize(results);
        if (llmSummary && typeof llmSummary === 'object') {
          return llmSummary;
        }
      }

      // Rule-based summarization
      const keyPoints = [];
      const contentParts = [];

      for (const result of results) {
        const content = this._extractContent(result);
        if (typeof content === 'string' && content.trim()) {
          contentParts.push(content.trim());
          // Extract first sentence as key point
          const firstSentence = content.split(/[。.!！\n]/)[0].trim();
          if (firstSentence) keyPoints.push(firstSentence);
        } else if (content && typeof content === 'object') {
          const values = Object.values(content).filter(v => typeof v === 'string');
          for (const v of values) {
            contentParts.push(v);
            const firstSentence = v.split(/[。.!！\n]/)[0].trim();
            if (firstSentence) keyPoints.push(firstSentence);
          }
        }
      }

      const summary = contentParts.length > 0
        ? contentParts.join('；')
        : 'No content to summarize';

      return {
        summary,
        sourceCount: results.length,
        keyPoints: keyPoints.slice(0, 10),
      };
    }, 'ResultAggregator', 'aggregateBySummary', { summary: '', sourceCount: 0, keyPoints: [] });
  }

  /**
   * 层级汇总聚合 — 分层聚合结果
   * @param {Array<Object>} results - 结果数组
   * @param {Object} _options - 聚合选项（保留）
   * @returns {{ layers: Array<Object>, topLevel: *, depth: number }} 层级汇总结果
   * @private
   */
  _aggregateByHierarchy(results, _options) {
    return safeExecute(() => {
      if (results.length === 1) {
        return {
          layers: [results[0]],
          topLevel: this._extractContent(results[0]),
          depth: 1,
        };
      }

      // Build hierarchy by grouping results in pairs and aggregating upward
      let currentLayer = results.map(r => this._extractContent(r));
      const layers = [currentLayer.slice()];
      let depth = 1;

      while (currentLayer.length > 1) {
        const nextLayer = [];
        for (let i = 0; i < currentLayer.length; i += 2) {
          if (i + 1 < currentLayer.length) {
            nextLayer.push(this._mergeTwo(currentLayer[i], currentLayer[i + 1]));
          } else {
            nextLayer.push(currentLayer[i]);
          }
        }
        currentLayer = nextLayer;
        layers.push(currentLayer.slice());
        depth++;
      }

      return {
        layers,
        topLevel: currentLayer[0] || null,
        depth,
      };
    }, 'ResultAggregator', 'aggregateByHierarchy', { layers: [], topLevel: null, depth: 0 });
  }

  /**
   * 择优聚合 — 根据质量分数选择最优结果
   * @param {Array<Object>} results - 结果数组，每个结果应包含qualityScore或confidence字段
   * @param {Object} _options - 聚合选项（保留）
   * @returns {{ best: *, bestIndex: number, scores: Array<number> }} 择优结果
   * @private
   */
  _aggregateByBestOf(results, _options) {
    return safeExecute(() => {
      let bestIndex = 0;
      let bestScore = -1;
      const scores = [];

      for (let i = 0; i < results.length; i++) {
        const score = this._extractScore(results[i]);
        scores.push(score);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      return {
        best: this._extractContent(results[bestIndex]),
        bestIndex,
        scores,
      };
    }, 'ResultAggregator', 'aggregateByBestOf', { best: null, bestIndex: -1, scores: [] });
  }

  /**
   * 评估聚合结果的质量
   * @param {*} aggregated - 聚合后的结果
   * @param {Array<Object>} results - 原始结果数组
   * @returns {number} 质量分数（0-1）
   * @private
   */
  _assessQuality(aggregated, results) {
    return safeExecute(() => {
      if (!aggregated) return 0;

      let score = 0;
      const weights = { coverage: 0.3, consistency: 0.4, completeness: 0.3 };

      // Coverage: ratio of results contributing to the aggregation
      const coverage = results.length > 0 ? Math.min(results.length / 3, 1) : 0;
      score += coverage * weights.coverage;

      // Consistency: check if results agree with each other
      const consistency = this._computeConsistency(results);
      score += consistency * weights.consistency;

      // Completeness: check if aggregated result has substantial content
      const completeness = this._computeCompleteness(aggregated);
      score += completeness * weights.completeness;

      return clamp01(score);
    }, 'ResultAggregator', 'assessQuality', 0.5);
  }

  /**
   * 计算结果间的一致性
   * @param {Array<Object>} results - 结果数组
   * @returns {number} 一致性分数（0-1）
   * @private
   */
  _computeConsistency(results) {
    if (results.length <= 1) return 1;

    let agreements = 0;
    let comparisons = 0;

    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        comparisons++;
        const contentA = this._extractContent(results[i]);
        const contentB = this._extractContent(results[j]);

        if (contentA === contentB) {
          agreements++;
        } else if (typeof contentA === 'object' && typeof contentB === 'object') {
          const keysA = contentA ? Object.keys(contentA) : [];
          const keysB = contentB ? Object.keys(contentB) : [];
          const commonKeys = keysA.filter(k => keysB.includes(k));
          if (commonKeys.length > 0) {
            let matchCount = 0;
            for (const key of commonKeys) {
              if (JSON.stringify(contentA[key]) === JSON.stringify(contentB[key])) {
                matchCount++;
              }
            }
            agreements += matchCount / commonKeys.length;
          }
        }
      }
    }

    return comparisons > 0 ? agreements / comparisons : 1;
  }

  /**
   * 计算聚合结果的完整性
   * @param {*} aggregated - 聚合结果
   * @returns {number} 完整性分数（0-1）
   * @private
   */
  _computeCompleteness(aggregated) {
    if (aggregated == null) return 0;
    if (typeof aggregated === 'string') return aggregated.length > 0 ? 0.5 : 0;
    if (typeof aggregated === 'number') return 0.5;
    if (typeof aggregated === 'boolean') return 0.3;
    if (typeof aggregated === 'object') {
      const keys = Object.keys(aggregated);
      if (keys.length === 0) return 0;
      const nonNullValues = keys.filter(k => aggregated[k] != null && aggregated[k] !== '');
      return nonNullValues.length / keys.length;
    }
    return 0.3;
  }

  /**
   * 从结果中提取投票值
   * @param {Object} result - 单个结果
   * @param {string} voteField - 投票字段名
   * @returns {string} 投票值
   * @private
   */
  _extractVoteValue(result, voteField) {
    if (result && typeof result === 'object') {
      if (result[voteField] != null) return String(result[voteField]);
      const content = result.content || result.output || result.result;
      if (content && typeof content === 'object' && content[voteField] != null) {
        return String(content[voteField]);
      }
      if (content != null) return String(content);
    }
    return result != null ? String(result) : 'abstain';
  }

  /**
   * 从结果中提取内容
   * @param {Object} result - 单个结果
   * @returns {*} 提取的内容
   * @private
   */
  _extractContent(result) {
    if (result == null) return null;
    if (typeof result === 'string') return result;
    if (typeof result === 'object') {
      return result.content !== undefined
        ? result.content
        : (result.output !== undefined ? result.output : (result.result !== undefined ? result.result : result));
    }
    return result;
  }

  /**
   * 从结果中提取质量分数
   * @param {Object} result - 单个结果
   * @returns {number} 质量分数（0-1）
   * @private
   */
  _extractScore(result) {
    if (result && typeof result === 'object') {
      const raw = result.qualityScore ?? result.confidence ?? result.score ?? 0;
      return Number.isFinite(raw) ? clamp01(raw) : 0;
    }
    return 0.5;
  }

  /**
   * 合并两个内容对象
   * @param {*} a - 内容A
   * @param {*} b - 内容B
   * @returns {Object} 合并后的内容
   * @private
   */
  _mergeTwo(a, b) {
    if (a == null) return b;
    if (b == null) return a;

    if (typeof a === 'object' && typeof b === 'object') {
      const merged = { ...a };
      for (const [key, value] of Object.entries(b)) {
        if (merged[key] === undefined) {
          merged[key] = value;
        }
      }
      return merged;
    }

    return { a, b };
  }

  /**
   * 附加LLM客户端，用于基于LLM的聚合（可选）
   * @param {Object} client - LLM客户端实例，需提供summarize方法
   * @returns {ResultAggregator} 当前实例，支持链式调用
   */
  attachLlmClient(client) {
    this.guardShutdown();
    this._llmClient = client || null;
    debug('ResultAggregator', 'attachLlmClient', 'LLM client attached');
    return this;
  }

  /**
   * 关闭时的清理操作
   * @private
   */
  _onShutdown() {
    this._aggregationHistory = [];
    this._llmClient = null;
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
  }
}

ResultAggregator.AGGREGATION_STRATEGY = AGGREGATION_STRATEGY;

module.exports = withShutdown(ResultAggregator);
