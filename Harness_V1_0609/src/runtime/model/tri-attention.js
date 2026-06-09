'use strict';

const { EventEmitter } = require('events');
const { DeepeningError } = require('../../errors');
const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const _ComputeAccelerator = require('./compute-accelerator');

const DEFAULT_CONFIG = {
  attentionThreshold: 0.3,
  maxContextEntries: 500,
  recencyDecay: 0.95,
  enablePreRopeScoring: false,
  calibrationCenter: null,
  magnitudeWeight: 0.5,
  concentrationThreshold: 0.8,
};

/**
 * @module runtime/model/tri-attention
 * TriAttention — Multi-dimensional attention weight calculator for context optimization
 * Estimates per-entry attention using recency, relevance, and position signals, then prunes
 * low-attention entries to fit within token budgets while preserving critical information.
 * @classdesc 三重注意力。Pre-RoPE空间三角级数评分+向量幅度双引擎注意力
 * @extends EventEmitter
 * @emits TriAttention#optimized
 */
class TriAttention extends EventEmitter {
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    this._optimizeCount = 0;
    this._totalPruned = 0;
    this._totalTokensSaved = 0;
    this._qCenter = null;
    this._kCenter = null;
    this._qConcentration = 0;
    this._kConcentration = 0;
    if (this._config.calibrationCenter != null) {
      this._qCenter = this._config.calibrationCenter.qCenter ?? null;
      this._kCenter = this._config.calibrationCenter.kCenter ?? null;
    }
  }

  attachComputeAccelerator(accelerator) {
    this.guardShutdown();
    if (accelerator && typeof accelerator.execute === 'function') {
      this._computeAccelerator = accelerator;
    }
    return this;
  }

  _validateOptimizeInputs(contextWindow, budget) {
    if (!contextWindow || typeof contextWindow !== 'object') {
      throw new DeepeningError('INVALID_INPUT', 'contextWindow must be an object');
    }
    if (!budget || typeof budget !== 'object') {
      throw new DeepeningError('INVALID_INPUT', 'budget must be an object');
    }
  }

  _parseBudget(budget) {
    const maxTokens = typeof budget.maxTokens === 'number' && Number.isFinite(budget.maxTokens) && budget.maxTokens > 0
      ? budget.maxTokens
      : Infinity;
    const reservedTokens = typeof budget.reservedTokens === 'number' && Number.isFinite(budget.reservedTokens) && budget.reservedTokens >= 0
      ? budget.reservedTokens
      : 0;
    return { availableTokens: maxTokens - reservedTokens };
  }

  _emptyResult(entries, tokensSaved, compressionRatio) {
    this._optimizeCount++;
    this.emit('optimized', { optimized: [], pruned: entries ?? [], tokensSaved, compressionRatio });
    return { optimized: [], pruned: entries ?? [], tokensSaved, compressionRatio };
  }

  /**
   * 根据注意力权重优化上下文窗口，裁剪低注意力条目以适配Token预算
   * @param {Object} contextWindow - 上下文窗口对象，包含entries数组
   * @param {Array} contextWindow.entries - 上下文条目列表
   * @param {Object} budget - Token预算配置
   * @param {number} budget.maxTokens - 最大可用Token数
   * @param {number} [budget.reservedTokens] - 预留Token数
   * @returns {{ optimized: Array, pruned: Array, tokensSaved: number, compressionRatio: number }} 优化结果，包含保留条目、裁剪条目、节省Token数和压缩比
   * @emits TriAttention#optimized
   */
  optimize(contextWindow, budget) {
    this.guardShutdown();
    this._validateOptimizeInputs(contextWindow, budget);

    const entries = Array.isArray(contextWindow.entries) ? contextWindow.entries : [];
    const { availableTokens } = this._parseBudget(budget);

    if (availableTokens <= 0) {
      return this._emptyResult(contextWindow.entries, 0, 0);
    }

    if (entries.length === 0) {
      return this._emptyResult(null, 0, 1);
    }

    const totalPositions = entries.length;
    const scored = entries.map((entry, index) => {
      const attention = this.estimateAttention(entry, index, totalPositions);
      const tokenEstimate = typeof entry.content === 'string'
        ? Math.ceil(entry.content.length / 4)
        : 1;
      return { entry, attention, tokenEstimate, originalIndex: index };
    });

    scored.sort((a, b) => b.attention - a.attention);

    const optimized = [];
    const pruned = [];
    let tokensUsed = 0;

    for (const item of scored) {
      if (item.attention >= this._config.attentionThreshold && tokensUsed + item.tokenEstimate <= availableTokens) {
        optimized.push(item);
        tokensUsed += item.tokenEstimate;
      } else {
        pruned.push(item);
      }
    }

    if (optimized.length === 0 && scored.length > 0) {
      const best = scored.reduce((a, b) => a.attention >= b.attention ? a : b, scored[0]);
      optimized.push(best);
      const idx = pruned.indexOf(best);
      if (idx !== -1) pruned.splice(idx, 1);
      tokensUsed = best.tokenEstimate;
    }

    optimized.sort((a, b) => a.originalIndex - b.originalIndex);

    const totalTokensBefore = scored.reduce((sum, item) => sum + item.tokenEstimate, 0);
    const tokensSaved = totalTokensBefore - tokensUsed;
    const compressionRatio = totalTokensBefore > 0 ? tokensUsed / totalTokensBefore : 1;

    this._optimizeCount++;
    this._totalPruned += pruned.length;
    this._totalTokensSaved += tokensSaved;

    const result = {
      optimized: optimized.map(item => item.entry),
      pruned: pruned.map(item => item.entry),
      tokensSaved,
      compressionRatio,
    };

    this.emit('optimized', result);
    return result;
  }

  /**
   * 估算单条上下文条目的注意力权重，综合位置、重要性和时效性三维度
   * @param {Object} entry - 上下文条目对象
   * @param {number} entry.importance - 条目重要性分数
   * @param {number} entry.recency - 条目时效性分数
   * @param {number} position - 条目在列表中的位置索引
   * @param {number} total - 条目总数
   * @returns {number} 注意力权重值，范围[0, 1]
   */
  _validateNum(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  estimateAttention(entry, position, total) {
    if (!entry || typeof entry !== 'object') return 0;
    if (this._config.enablePreRopeScoring && this._qCenter != null) {
      return this._computePreRopeScore(entry, position, total);
    }
    const totalPositions = this._validateNum(total, 1);
    const pos = this._validateNum(position, 0);
    const importance = this._validateNum(entry.importance, 0);
    const recency = this._validateNum(entry.recency, 0);
    if (totalPositions <= 0) return 0;
    if (this._computeAccelerator) {
      try {
        const result = this._computeAccelerator.executeSync('attentionScore', {
          query: entry,
          key: entry,
          position: pos,
          total: totalPositions,
          importance,
          recency,
        });
        if (typeof result === 'number' && Number.isFinite(result)) return Math.max(0, Math.min(1, result));
      } catch (_e) {
        debug('TriAttention', 'accelerator-attentionScore-fallback', _e && _e.message ? _e.message : String(_e));
      }
    }
    const positionalWeight = totalPositions === 1 ? 1.0 : Math.sin(Math.PI * pos / totalPositions);
    const attentionWeight = positionalWeight * importance * recency;
    const result = Math.max(0, Math.min(1, attentionWeight));
    return Number.isFinite(result) ? result : 0;
  }

  /**
   * 异步估算单条上下文条目的注意力权重，优先使用计算加速器，回退至同步估算。
   * @async
   * @param {Object} entry - 上下文条目对象
   * @param {number} entry.importance - 条目重要性分数
   * @param {number} entry.recency - 条目时效性分数
   * @param {number} position - 条目在列表中的位置索引
   * @param {number} total - 条目总数
   * @returns {Promise<number>} 注意力权重值，范围[0, 1]
   */
  async estimateAttentionAsync(entry, position, total) {
    if (!entry || typeof entry !== 'object') return 0;
    if (this._computeAccelerator) {
      try {
        const totalPositions = typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : 1;
        const pos = typeof position === 'number' && Number.isFinite(position) && position >= 0 ? position : 0;
        const importance = typeof entry.importance === 'number' && Number.isFinite(entry.importance) ? entry.importance : 0;
        const recency = typeof entry.recency === 'number' && Number.isFinite(entry.recency) ? entry.recency : 0;
        const result = await this._computeAccelerator.execute('attentionScore', {
          query: entry,
          key: entry,
          position: pos,
          total: totalPositions,
          importance,
          recency,
        });
        if (typeof result === 'number' && Number.isFinite(result)) return Math.max(0, Math.min(1, result));
      } catch (_e) {
        debug('TriAttention', 'accelerator-attentionScoreAsync-fallback', _e && _e.message ? _e.message : String(_e));
      }
    }
    return this.estimateAttention(entry, position, total);
  }

  /**
   * 校准Q/K聚类中心，基于提供的向量集合计算中心点和集中度
   * @param {Array<number[]>} qVectors - Query向量集合，非空数组
   * @param {Array<number[]>} kVectors - Key向量集合，非空数组
   * @returns {{ qCenter: number[], kCenter: number[], qConcentration: number, kConcentration: number }} 校准结果，包含Q/K中心向量和集中度
   * @throws {DeepeningError} qVectors或kVectors为空或非数组时抛出
   */
  calibrate(qVectors, kVectors) {
    this.guardShutdown();
    if (!Array.isArray(qVectors) || qVectors.length === 0) {
      throw new DeepeningError('INVALID_INPUT', 'qVectors must be a non-empty array');
    }
    if (!Array.isArray(kVectors) || kVectors.length === 0) {
      throw new DeepeningError('INVALID_INPUT', 'kVectors must be a non-empty array');
    }

    this._qCenter = this._computeCenter(qVectors);
    this._kCenter = this._computeCenter(kVectors);
    this._qConcentration = this._computeConcentration(qVectors, this._qCenter);
    this._kConcentration = this._computeConcentration(kVectors, this._kCenter);

    debug('TriAttention', 'calibrate', 'qConcentration=' + this._qConcentration.toFixed(4) + ' kConcentration=' + this._kConcentration.toFixed(4));

    return {
      qCenter: this._qCenter,
      kCenter: this._kCenter,
      qConcentration: this._qConcentration,
      kConcentration: this._kConcentration,
    };
  }

  _computeCenter(vectors) {
    if (!vectors || vectors.length === 0) return [];
    if (!Array.isArray(vectors[0])) return [];
    const dim = vectors[0].length;
    const center = new Array(dim).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      for (let j = 0; j < dim; j++) {
        center[j] += (typeof vectors[i][j] === 'number' && Number.isFinite(vectors[i][j])) ? vectors[i][j] : 0;
      }
    }
    for (let j = 0; j < dim; j++) {
      center[j] /= vectors.length;
    }
    return center;
  }

  _computeConcentration(vectors, center) {
    if (vectors.length <= 1) return 1;
    let totalDist = 0;
    let maxDist = 0;
    for (let i = 0; i < vectors.length; i++) {
      let dist = 0;
      for (let j = 0; j < center.length; j++) {
        const v = (typeof vectors[i][j] === 'number' && Number.isFinite(vectors[i][j])) ? vectors[i][j] : 0;
        const d = v - center[j];
        dist += d * d;
      }
      dist = Math.sqrt(dist);
      totalDist += dist;
      if (dist > maxDist) maxDist = dist;
    }
    if (maxDist === 0) return 1;
    const avgDist = totalDist / vectors.length;
    return 1 - (avgDist / maxDist);
  }

  _computeMagnitudeScore(entryVector) {
    if (!Array.isArray(entryVector) || entryVector.length === 0 || this._qCenter == null) return 0;
    let normSq = 0;
    for (let i = 0; i < entryVector.length; i++) {
      const v = (typeof entryVector[i] === 'number' && Number.isFinite(entryVector[i])) ? entryVector[i] : 0;
      normSq += v * v;
    }
    const norm = Math.sqrt(normSq);
    let distSq = 0;
    const dim = Math.min(entryVector.length, this._qCenter.length);
    for (let i = 0; i < dim; i++) {
      const vi = (typeof entryVector[i] === 'number' && Number.isFinite(entryVector[i])) ? entryVector[i] : 0;
      const d = vi - this._qCenter[i];
      distSq += d * d;
    }
    const centerDist = Math.sqrt(distSq);
    return norm > 0 ? Math.max(0, 1 - centerDist / (norm + 1)) : 0;
  }

  _computePreRopeScore(entry, position, total) {
    const totalPositions = typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : 1;
    const pos = typeof position === 'number' && Number.isFinite(position) && position >= 0 ? position : 0;

    const distanceScore = totalPositions === 1 ? 1.0 : Math.sin(Math.PI * pos / totalPositions);

    const magnitudeScore = this._computeMagnitudeScore(entry.vector);

    const concentration = this._qConcentration;
    const threshold = this._config.concentrationThreshold;
    let magWeight = this._config.magnitudeWeight;
    if (concentration > threshold) {
      magWeight = Math.min(1, magWeight + 0.2);
    } else {
      magWeight = Math.max(0, magWeight - 0.2);
    }
    const distWeight = 1 - magWeight;

    const importance = typeof entry.importance === 'number' && Number.isFinite(entry.importance) ? entry.importance : 0.5;
    const recency = typeof entry.recency === 'number' && Number.isFinite(entry.recency) ? entry.recency : 0.5;

    const rawScore = distWeight * distanceScore + magWeight * magnitudeScore;
    const result = Math.max(0, Math.min(1, rawScore * importance * recency));
    return Number.isFinite(result) ? result : 0;
  }

  /**
   * 获取校准统计信息，包含Q/K中心向量、集中度和是否已校准标志
   * @returns {{ qCenter: number[]|null, kCenter: number[]|null, qConcentration: number, kConcentration: number, isCalibrated: boolean }} 校准统计数据
   */
  getCalibrationStats() {
    return {
      qCenter: this._qCenter ? this._qCenter.slice() : null,
      kCenter: this._kCenter ? this._kCenter.slice() : null,
      qConcentration: this._qConcentration,
      kConcentration: this._kConcentration,
      isCalibrated: this._qCenter != null,
    };
  }

  /**
   * 获取TriAttention运行统计信息
   * @returns {{ optimizeCount: number, totalPruned: number, totalTokensSaved: number, config: Object }} 统计数据，包含优化次数、裁剪总数、节省Token总数和当前配置
   */
  getStats() {
    return {
      optimizeCount: this._optimizeCount,
      totalPruned: this._totalPruned,
      totalTokensSaved: this._totalTokensSaved,
      config: mergeConfig(this._config),
    };
  }

  _onShutdown() {
    this._optimizeCount = 0;
    this._totalPruned = 0;
    this._totalTokensSaved = 0;
    this._qCenter = null;
    this._kCenter = null;
    this._qConcentration = 0;
    this._kConcentration = 0;
    this.removeAllListeners();
    debug('TriAttention', '_onShutdown', 'cleaned up');
  }
}

TriAttention.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(TriAttention);
