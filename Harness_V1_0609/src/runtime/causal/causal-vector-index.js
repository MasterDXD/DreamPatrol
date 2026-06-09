'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { roundTo } = require('../../utils/safe-execute');
const _ComputeAccelerator = require('../model/compute-accelerator');

const DEFAULT_SIMILARITY_THRESHOLD = 0.3;
const MAX_VECTORS = 5000;
const VECTOR_DIMENSIONS = 128;

/**
 * @module runtime/causal/causal-vector-index
 * 因果向量索引。向量相似度搜索、嵌入管理，
 * 支持维度自适应和统计追踪。
 *
 * @classdesc 因果向量索引，基于向量时钟实现因果关系的快速查询和一致性检测
 * @extends EventEmitter
 */
class CausalVectorIndex extends EventEmitter {
  /**
   * 创建CausalVectorIndex实例。
   * @param {Object} [options] - 配置选项
   */
  constructor(options) {
    super();
    this._embeddingService = options?.embeddingService ?? null;
    this._similarityThreshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this._vectors = new Map();
    this._maxVectors = Math.max(1, options?.maxVectors ?? MAX_VECTORS);
    this._stats = { indexed: 0, queries: 0, hits: 0, misses: 0, fallbackQueries: 0 };
  }

  /**
   * 附加嵌入服务实例，用于生成文本向量。
   * @param {object} service - 嵌入服务实例，须实现 embed 方法
   * @returns {CausalVectorIndex} 当前实例，支持链式调用
   */
  attachEmbeddingService(service) {
    this._embeddingService = service;
    return this;
  }

  /**
   * 挂载计算加速器，用于批量余弦相似度计算的GPU加速。
   * @param {object} accelerator - ComputeAccelerator实例，须实现execute方法
   * @returns {CausalVectorIndex} 当前实例，支持链式调用
   */
  attachComputeAccelerator(accelerator) {
    this.guardShutdown();
    if (accelerator && typeof accelerator.execute === 'function') {
      this._computeAccelerator = accelerator;
    }
    return this;
  }

  /**
   * 将文本索引到向量存储中，使用嵌入服务或回退到哈希向量生成。
   * 超出容量上限时自动淘汰最早的条目。
   * @param {string} causalId - 因果ID
   * @param {string} text - 待索引的文本
   * @param {object} [metadata] - 附加元数据
   * @returns {Promise<{success: boolean, causalId?: string, error?: string}>} 索引结果
   */
  async index(causalId, text, metadata) {
    try { this.guardShutdown(); } catch (_e) { return { success: false, error: 'CausalVectorIndex is shut down' }; }
    if (!causalId || typeof causalId !== 'string') {
      return { success: false, error: 'causalId is required and must be a string' };
    }
    if (this._vectors.size >= this._maxVectors && !this._vectors.has(causalId)) {
      const oldestKey = this._vectors.keys().next().value;
      this._vectors.delete(oldestKey);
    }
    let vector = null;
    if (this._embeddingService && typeof this._embeddingService.embed === 'function') {
      try {
        vector = await this._embeddingService.embed(text);
      } catch (err) {
        debug('CausalVectorIndex', 'embed failed', err);
        vector = this._generateFallbackVector(text);
      }
    } else {
      vector = this._generateFallbackVector(text);
    }
    if (!this.isHealthy()) {
      return { success: false, error: 'CausalVectorIndex is shut down after embed' };
    }
    const entry = {
      causalId: causalId,
      text: text,
      vector: vector,
      metadata: metadata ?? {},
      indexedAt: new Date().toISOString(),
    };
    this._vectors.set(causalId, entry);
    this._stats.indexed++;
    this.emit('indexed', { causalId: causalId });
    return { success: true, causalId: causalId };
  }

  /**
   * 基于查询文本搜索相似向量，返回按相似度降序排列的TopK结果。
   * @param {string} queryText - 查询文本
   * @param {object} [options] - 查询选项
   * @param {number} [options.topK=5] - 返回结果数量上限
   * @param {number} [options.threshold] - 相似度阈值
   * @returns {Promise<Array<{causalId: string, text: string, metadata: object, similarity: number}>>} 相似结果列表
   */
  async query(queryText, options) {
    try { this.guardShutdown(); } catch (_e) { debug('CausalVectorIndex', 'query-guardShutdown', _e); return []; }
    const opts = options ?? {};
    const topK = Math.max(1, Math.min(100, opts.topK ?? 5));
    const threshold = opts.threshold ?? this._similarityThreshold;
    this._stats.queries++;

    const queryVector = await this._embedQuery(queryText);
    if (!queryVector || !this.isHealthy()) {
      return [];
    }

    const accelResults = await this._queryWithAccelerator(queryVector, threshold, topK);
    if (accelResults !== null) {
      return accelResults;
    }

    return this._queryFallback(queryVector, threshold, topK);
  }

  async _embedQuery(queryText) {
    if (this._embeddingService && typeof this._embeddingService.embed === 'function') {
      try {
        return await this._embeddingService.embed(queryText);
      } catch (err) {
        debug('CausalVectorIndex', 'query embed failed', err);
        this._stats.fallbackQueries++;
        return this._generateFallbackVector(queryText);
      }
    }
    this._stats.fallbackQueries++;
    return this._generateFallbackVector(queryText);
  }

  async _queryWithAccelerator(queryVector, threshold, topK) {
    if (!this._computeAccelerator || !queryVector || queryVector.length === 0) {
      return null;
    }
    try {
      const allVectors = [];
      const allKeys = [];
      for (const [key, entry] of this._vectors) {
        if (entry && entry.vector && entry.vector.length === queryVector.length) {
          allVectors.push(entry.vector);
          allKeys.push(key);
        }
      }
      if (allVectors.length === 0) return null;
      const batchResults = await this._computeAccelerator.execute('batchCosineSimilarity', {
        queryVec: queryVector,
        vectors: allVectors,
      });
      if (!Array.isArray(batchResults) || batchResults.length !== allKeys.length) return null;
      const scored = [];
      for (let i = 0; i < allKeys.length; i++) {
        if (typeof batchResults[i] === 'number' && batchResults[i] >= threshold) {
          scored.push({ id: allKeys[i], similarity: batchResults[i] });
        }
      }
      scored.sort(function(a, b) { return (b.similarity ?? 0) - (a.similarity ?? 0); });
      return scored.slice(0, topK);
    } catch (_e) {
      debug('CausalVectorIndex', 'accelerator-batchQuery-fallback', _e && _e.message ? _e.message : String(_e));
      return null;
    }
  }

  _queryFallback(queryVector, threshold, topK) {
    const scored = [];
    for (const [, entry] of this._vectors) {
      const similarity = this._cosineSimilarity(queryVector, entry.vector);
      if (similarity >= threshold) {
        scored.push({
          causalId: entry.causalId,
          text: entry.text,
          metadata: entry.metadata,
          similarity: roundTo(similarity, 3),
        });
      }
    }

    scored.sort(function(a, b) { return (b.similarity ?? 0) - (a.similarity ?? 0); });
    const results = scored.slice(0, topK);

    if (results.length > 0) {
      this._stats.hits++;
    } else {
      this._stats.misses++;
    }

    return results;
  }

  /**
   * 移除指定因果ID的向量条目。
   * @param {string} causalId - 因果ID
   */
  remove(causalId) {
    this.guardShutdown();
    if (this._vectors.delete(causalId)) {
      this._stats.indexed = Math.max(0, this._stats.indexed - 1);
      return true;
    }
    return false;
  }

  /**
   * 获取指定因果ID的向量条目。
   * @param {string} causalId - 因果ID
   * @returns {object|null} 向量条目，不存在时返回null
   */
  get(causalId) {
    this.guardShutdown();
    const entry = this._vectors.get(causalId);
    return entry ? { ...entry, vector: [...entry.vector] } : null;
  }

  _generateFallbackVector(text) {
    const dims = (this._embeddingService && this._embeddingService.dimensions) ? this._embeddingService.dimensions : VECTOR_DIMENSIONS;
    const vector = new Float32Array(dims);
    if (!text || typeof text !== 'string') return Array.from(vector);
    const words = text.toLowerCase().split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (!word) continue;
      let hash = 0;
      for (let j = 0; j < word.length; j++) {
        hash = ((hash << 5) - hash + word.charCodeAt(j)) | 0;
      }
      const idx = Math.abs(hash) % dims;
      vector[idx] += 1.0 / (i + 1);
    }
    const norm = Math.sqrt(vector.reduce(function(s, v) { return s + v * v; }, 0));
    if (Number.isFinite(norm) && norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }
    return Array.from(vector);
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const EPSILON = 1e-10;
    if (!Number.isFinite(normA) || !Number.isFinite(normB) || normA < EPSILON || normB < EPSILON) return 0;
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }

  /**
   * 获取向量索引统计信息。
   * @returns {{ totalVectors: number, maxVectors: number, indexed: number, queries: number, hits: number, misses: number, hitRate: number, fallbackQueries: number, embeddingServiceAvailable: boolean, shutDown: boolean }} 统计数据
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('CausalVectorIndex', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalVectors: 0, maxVectors: this._maxVectors, indexed: 0, queries: 0, hits: 0, misses: 0, hitRate: 0, fallbackQueries: 0, embeddingServiceAvailable: !!this._embeddingService, shutDown: true }; }
    return {
      totalVectors: this._vectors.size,
      maxVectors: this._maxVectors,
      indexed: this._stats.indexed,
      queries: this._stats.queries,
      hits: this._stats.hits,
      misses: this._stats.misses,
      hitRate: this._stats.queries > 0 ? Math.round((this._stats.hits / this._stats.queries) * 100) / 100 : 0,
      fallbackQueries: this._stats.fallbackQueries,
      embeddingServiceAvailable: !!this._embeddingService,
      shutDown: this._shutDown,
    };
  }

  /**
   * 检查实例是否健康（未关闭）。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown;
  }

  _onShutdown() {
    this._vectors.clear();
    this._embeddingService = null;
    this._stats = { indexed: 0, queries: 0, hits: 0, misses: 0, fallbackQueries: 0 };
    this.removeAllListeners();
  }
}

CausalVectorIndex.VECTOR_DIMENSIONS = VECTOR_DIMENSIONS;

module.exports = withShutdown(CausalVectorIndex);
