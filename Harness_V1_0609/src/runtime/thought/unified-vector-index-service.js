'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { safeCall, roundTo } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const { mergeConfig } = safeAssign;
const BoundedMap = require('../../utils/bounded-map');

/**
 * 命名空间枚举，标识向量来源的模块
 * @enum {string}
 */
const VECTOR_NAMESPACES = {
  CAUSAL: 'causal',
  SEMANTIC: 'semantic',
  ENTITY: 'entity',
  MEMORY: 'memory',
  THOUGHT: 'thought',
};

const DEFAULT_CONFIG = {
  maxVectorsPerNamespace: 2000,
  defaultTopK: 5,
  defaultThreshold: 0.3,
  vectorDimensions: 128,
  enableCrossNamespaceSearch: true,
  cacheMaxSize: 100,
  cacheTTL: 60000,
};

const MAX_NAMESPACES = 20;

/**
 * @module runtime/thought/unified-vector-index-service
 * @classdesc 统一向量索引服务。实现MAGMA数据基座的统一向量存储与跨命名空间搜索
 * UnifiedVectorIndexService — Unified vector storage and cross-namespace ANN search
 * implementing MAGMA's "Data Base" unified index concept.
 *
 * 融合MAGMA架构核心能力：将Harness现有的CausalVectorIndex、BrainMemory嵌入、
 * KnowledgeGraphStore语义索引统一到一个共享向量索引服务中，实现跨模块的
 * 向量搜索能力，消除各模块独立维护向量索引的冗余。
 *
 * 核心特性：
 * - 命名空间隔离：不同模块的向量存储在独立命名空间中
 * - 跨命名空间搜索：支持跨模块联合向量搜索
 * - 共享嵌入服务：统一嵌入服务，避免重复计算
 * - 容量管理：每个命名空间独立容量限制
 *
 * @extends EventEmitter
 * @emits UnifiedVectorIndexService#vector-indexed
 * @emits UnifiedVectorIndexService#cross-namespace-search
 * @emits UnifiedVectorIndexService#error
 *
 * @example
 * const UnifiedVectorIndexService = require('./unified-vector-index-service');
 * const service = new UnifiedVectorIndexService();
 * service.attachEmbeddingService(embeddingService);
 *
 * // 索引向量到不同命名空间
 * await service.index('causal', 'cause-1', 'authentication failure');
 * await service.index('semantic', 'entity-1', 'JWT token');
 *
 * // 跨命名空间搜索
 * const results = await service.search('auth error', {
 *   namespaces: ['causal', 'semantic'],
 *   topK: 5,
 * });
 */
class UnifiedVectorIndexService extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    this._namespaces = new Map();
    this._embeddingService = null;
    this._queryCache = new BoundedMap(this._config.cacheMaxSize);
    this._stats = {
      totalIndexed: 0,
      totalQueries: 0,
      crossNamespaceQueries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      namespaceStats: {},
    };
  }

  /**
   * 附加嵌入服务实例，用于生成文本向量
   * @param {Object} service - 嵌入服务实例，须实现embed方法
   * @returns {UnifiedVectorIndexService} this
   */
  attachEmbeddingService(service) {
    this.guardShutdown();
    if (service && typeof service.embed === 'function') {
      this._embeddingService = service;
      debug('UnifiedVectorIndexService', 'attachEmbeddingService', 'attached');
    }
    return this;
  }

  /**
   * 将文本索引到指定命名空间
   * @param {string} namespace - 命名空间标识
   * @param {string} id - 条目唯一ID
   * @param {string} text - 待索引文本
   * @param {Object} [metadata] - 附加元数据
   * @returns {Promise<{success: boolean, id?: string, namespace?: string, error?: string}>}
   */
  async index(namespace, id, text, metadata) {
    this.guardShutdown();
    if (!namespace || typeof namespace !== 'string') {
      return { success: false, error: 'namespace is required' };
    }
    if (!id || typeof id !== 'string') {
      return { success: false, error: 'id is required' };
    }
    if (!text || typeof text !== 'string') {
      return { success: false, error: 'text is required' };
    }

    const ns = this._ensureNamespace(namespace);
    if (ns.vectors.size >= this._config.maxVectorsPerNamespace && !ns.vectors.has(id)) {
      const oldestKey = ns.vectors.keys().next().value;
      ns.vectors.delete(oldestKey);
    }

    let vector = null;
    if (this._embeddingService && typeof this._embeddingService.embed === 'function') {
      try {
        vector = await this._embeddingService.embed(text);
      } catch (err) {
        debug('UnifiedVectorIndexService', 'embed failed', err);
        vector = this._generateFallbackVector(text);
      }
    } else {
      vector = this._generateFallbackVector(text);
    }

    if (this._shutDown) {
      return { success: false, error: 'service is shut down' };
    }

    const entry = {
      id,
      namespace,
      text,
      vector,
      metadata: metadata ?? {},
      contentHash: crypto.createHash('md5').update(text).digest('hex').slice(0, 8),
      indexedAt: Date.now(),
    };

    ns.vectors.set(id, entry);
    this._stats.totalIndexed++;
    this._stats.namespaceStats[namespace] = this._stats.namespaceStats[namespace] ?? { indexed: 0, queries: 0 };
    this._stats.namespaceStats[namespace].indexed++;

    this.emit('vector-indexed', { namespace, id });
    return { success: true, id, namespace };
  }

  /**
   * 批量索引文本到指定命名空间
   * @param {string} namespace - 命名空间标识
   * @param {Array<{id: string, text: string, metadata?: Object}>} items - 待索引条目数组
   * @returns {Promise<{successCount: number, failCount: number, errors: Array}>}
   */
  async batchIndex(namespace, items) {
    this.guardShutdown();
    if (!Array.isArray(items)) return { successCount: 0, failCount: 0, errors: ['items must be an array'] };

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    for (const item of items) {
      const result = await this.index(namespace, item.id, item.text, item.metadata);
      if (result.success) {
        successCount++;
      } else {
        failCount++;
        errors.push({ id: item.id, error: result.error });
      }
    }

    return { successCount, failCount, errors };
  }

  /**
   * 搜索相似向量。支持单命名空间和跨命名空间搜索。
   * 实现MAGMA的"统一数据基座"跨维度查询能力。
   *
   * @param {string} queryText - 查询文本
   * @param {Object} [options] - 搜索选项
   * @param {string[]} [options.namespaces] - 搜索的命名空间（默认全部）
   * @param {number} [options.topK] - 返回结果数
   * @param {number} [options.threshold] - 相似度阈值
   * @returns {Promise<Array<Object>>} 搜索结果
   */
  async search(queryText, options) {
    this.guardShutdown();
    if (!queryText || typeof queryText !== 'string') return [];

    const opts = options ?? {};
    const namespaces = opts.namespaces ?? Array.from(this._namespaces.keys());
    const topK = opts.topK ?? this._config.defaultTopK;
    const threshold = opts.threshold ?? this._config.defaultThreshold;

    const cacheKey = queryText + ':' + namespaces.sort().join(',') + ':' + topK + ':' + threshold;
    const cached = this._queryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this._config.cacheTTL) {
      this._stats.cacheHits++;
      return cached.results;
    }
    this._stats.cacheMisses++;

    const queryVector = await this._embedQuery(queryText);
    if (this._shutDown || !queryVector) return [];

    const allResults = this._searchNamespaces(namespaces, queryVector, threshold);

    allResults.sort((a, b) => b.similarity - a.similarity);
    const results = allResults.slice(0, topK);

    this._stats.totalQueries++;
    if (namespaces.length > 1) {
      this._stats.crossNamespaceQueries++;
    }

    this._queryCache.set(cacheKey, { results, timestamp: Date.now() });

    if (namespaces.length > 1) {
      this.emit('cross-namespace-search', {
        query: queryText,
        namespaces,
        resultCount: results.length,
      });
    }

    return results;
  }

  /**
   * 从指定命名空间移除向量
   * @param {string} namespace - 命名空间
   * @param {string} id - 条目ID
   * @returns {boolean} 是否成功移除
   */
  remove(namespace, id) {
    this.guardShutdown();
    const ns = this._namespaces.get(namespace);
    if (!ns) return false;
    return ns.vectors.delete(id);
  }

  /**
   * 获取指定命名空间的向量条目
   * @param {string} namespace - 命名空间
   * @param {string} id - 条目ID
   * @returns {Object|null} 向量条目
   */
  get(namespace, id) {
    if (this._shutDown) return null;
    const ns = this._namespaces.get(namespace);
    if (!ns) return null;
    const entry = ns.vectors.get(id);
    return entry ? { id: entry.id, namespace: entry.namespace, text: entry.text, metadata: entry.metadata, indexedAt: entry.indexedAt } : null;
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计数据
   */
  getStats() {
    if (this._shutDown) return { totalIndexed: 0, totalQueries: 0, namespaceCounts: {}, totalNamespaces: 0 };
    const namespaceCounts = {};
    for (const [name, ns] of this._namespaces) {
      namespaceCounts[name] = ns.vectors.size;
    }
    return {
      ...this._stats,
      namespaceCounts,
      totalNamespaces: this._namespaces.size,
      embeddingServiceAvailable: this._embeddingService !== null,
    };
  }

  /**
   * 确保命名空间存在
   * @param {string} name - 命名空间名称
   * @returns {Object} 命名空间对象
   */
  _ensureNamespace(name) {
    if (!this._namespaces.has(name)) {
      if (this._namespaces.size >= MAX_NAMESPACES) {
        const oldestKey = this._namespaces.keys().next().value;
        this._namespaces.delete(oldestKey);
      }
      this._namespaces.set(name, {
        vectors: new Map(),
        createdAt: Date.now(),
      });
    }
    return this._namespaces.get(name);
  }

  /**
   * 生成查询文本的嵌入向量
   * @param {string} queryText - 查询文本
   * @returns {Promise<number[]|null>} 嵌入向量
   */
  async _embedQuery(queryText) {
    if (this._embeddingService && typeof this._embeddingService.embed === 'function') {
      try {
        return await this._embeddingService.embed(queryText);
      } catch (err) {
        debug('UnifiedVectorIndexService', 'query embed failed', err);
        return this._generateFallbackVector(queryText);
      }
    }
    return this._generateFallbackVector(queryText);
  }

  /**
   * 在指定命名空间中搜索相似向量
   * @param {string[]} namespaces - 命名空间列表
   * @param {number[]} queryVector - 查询向量
   * @param {number} threshold - 相似度阈值
   * @returns {Array<Object>} 搜索结果
   */
  _searchNamespaces(namespaces, queryVector, threshold) {
    const allResults = [];
    for (const nsName of namespaces) {
      const ns = this._namespaces.get(nsName);
      if (!ns) continue;

      for (const [, entry] of ns.vectors) {
        const similarity = this._cosineSimilarity(queryVector, entry.vector);
        if (similarity >= threshold) {
          allResults.push({
            id: entry.id,
            namespace: nsName,
            text: entry.text,
            metadata: entry.metadata,
            similarity: roundTo(similarity, 3),
            indexedAt: entry.indexedAt,
          });
        }
      }

      this._stats.namespaceStats[nsName] = this._stats.namespaceStats[nsName] ?? { indexed: 0, queries: 0 };
      this._stats.namespaceStats[nsName].queries++;
    }
    return allResults;
  }

  /**
   * 生成回退向量（基于文本哈希）
   * @param {string} text - 输入文本
   * @returns {number[]} 向量
   */
  _generateFallbackVector(text) {
    const dims = this._config.vectorDimensions;
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

  /**
   * 计算余弦相似度
   * @param {number[]} a - 向量A
   * @param {number[]} b - 向量B
   * @returns {number} 相似度
   */
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
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  _onShutdown() {
    for (const [, ns] of this._namespaces) {
      ns.vectors.clear();
    }
    this._namespaces.clear();
    safeCall(() => this._queryCache.shutdown(), 'UnifiedVectorIndexService', 'shutdown-queryCache');
    this.removeAllListeners();
  }
}

module.exports = withShutdown(UnifiedVectorIndexService);
module.exports.VECTOR_NAMESPACES = VECTOR_NAMESPACES;
