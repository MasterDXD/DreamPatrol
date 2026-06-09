/**
 * @module runtime/model/embedding-service
 * @description 嵌入服务模块，提供文本向量化、相似度计算与向量检索能力。
 * 支持本地哈希嵌入、OpenAI嵌入（预留）和预计算嵌入（预留）三种提供者，
 * 内置LRU缓存与运行统计，用于语义匹配、技能路由等场景。
 */
'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { DEFAULT_CONFIDENCE } = require('../../utils/constants');
const { mergeConfig, validateConfigSchema } = require('../../utils/safe-assign');
const LRUCache = require('../../utils/lru-cache');
const { withShutdown } = require('../../utils/shutdown-mixin');
const _ComputeAccelerator = require('./compute-accelerator');

/**
 * @constant {Object.<string, string>} PROVIDERS
 * @description 嵌入提供者类型枚举，定义可用的向量化后端。
 * - `LOCAL` — 本地哈希嵌入，基于字符特征与二元组生成确定性向量
 * - `OPENAI` — OpenAI嵌入接口（预留，当前回退至本地）
 * - `PRECOMPUTED` — 预计算嵌入（预留，当前回退至本地）
 */
const PROVIDERS = {
  LOCAL: 'local',
  OPENAI: 'openai',
  PRECOMPUTED: 'precomputed',
};

/**
 * @constant {Object} DEFAULT_OPTIONS
 * @description EmbeddingService默认配置项。
 * @property {string} provider - 嵌入提供者，默认为 'local'
 * @property {number} dimensions - 输出向量维度，默认为 128
 * @property {number} maxBatchSize - 批量嵌入时每批最大文本数，默认为 32
 * @property {boolean} cacheEnabled - 是否启用LRU缓存，默认为 true
 * @property {number} cacheMaxSize - LRU缓存最大条目数，默认为 500
 */
const DEFAULT_OPTIONS = {
  provider: PROVIDERS.LOCAL,
  dimensions: 128,
  maxBatchSize: 32,
  cacheEnabled: true,
  cacheMaxSize: 500,
};

const OPTIONS_SCHEMA = {
  provider: { type: 'string', enum: ['local', 'openai', 'precomputed'] },
  dimensions: { type: 'number', min: 1, max: 4096 },
  maxBatchSize: { type: 'number', min: 1, max: 1000 },
  cacheEnabled: { type: 'boolean' },
  cacheMaxSize: { type: 'number', min: 1, max: 10000 },
};

/**
 * 嵌入服务类，提供文本向量化、余弦相似度计算与向量检索功能。
 * 支持多种嵌入提供者（本地/OpenAI/预计算），内置LRU缓存与运行统计。
 * 通过withShutdown混入优雅关闭能力。
 *
 * @classdesc 嵌入服务。文本向量化、相似度计算
 * @extends EventEmitter
 * @emits 'embedding-created' 当生成新嵌入向量时触发，载荷为 {textLength: number, dimensions: number, timeMs: number}
 */
class EmbeddingService extends EventEmitter {
  /**
   * 创建EmbeddingService实例。
   * @param {Object} [options={}] - 配置选项，与DEFAULT_OPTIONS合并
   * @param {string} [options.provider='local'] - 嵌入提供者，可选 'local'、'openai'、'precomputed'
   * @param {number} [options.dimensions=128] - 输出向量维度
   * @param {number} [options.maxBatchSize=32] - 批量嵌入时每批最大文本数
   * @param {boolean} [options.cacheEnabled=true] - 是否启用LRU缓存
   * @param {number} [options.cacheMaxSize=500] - LRU缓存最大条目数
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_OPTIONS, options);
    const validation = validateConfigSchema(this._config, OPTIONS_SCHEMA, 'EmbeddingService');
    this._config = validation.config;
    this._cache = new LRUCache(this._config.cacheMaxSize);
    this._stats = {
      totalEmbeddings: 0,
      cacheHits: 0,
      cacheMisses: 0,
      avgTimeMs: 0,
    };
  }

  /**
   * 将文本转换为嵌入向量。支持缓存，命中时直接返回缓存结果。
   * 输入为空、非字符串或超过100000字符时返回空数组。
   *
   * @param {string} text - 待向量化的文本
   * @returns {number[]} 嵌入向量数组，维度由配置的dimensions决定；无效输入返回空数组
   */
  embed(text) {
    this.guardShutdown();
    if (!text || typeof text !== 'string') return [];
    if (text.trim().length === 0) return [];
    if (text.length > 100000) return [];

    if (this._config.cacheEnabled) {
      const cached = this._cache.get(text);
      if (cached) {
        this._stats.cacheHits++;
        return cached.slice();
      }
      this._stats.cacheMisses++;
    }

    const startTime = Date.now();
    let vector;

    switch (this._config.provider) {
      case PROVIDERS.OPENAI:
        vector = this._embedOpenAI(text);
        break;
      case PROVIDERS.PRECOMPUTED:
        vector = this._embedPrecomputed(text);
        break;
      case PROVIDERS.LOCAL:
      default:
        vector = this._embedLocal(text);
        break;
    }

    const elapsed = Date.now() - startTime;
    this._stats.totalEmbeddings++;
    this._stats.avgTimeMs = this._stats.totalEmbeddings > 1
      ? (this._stats.avgTimeMs * (this._stats.totalEmbeddings - 1) + elapsed) / this._stats.totalEmbeddings
      : elapsed;

    if (this._config.cacheEnabled) {
      this._cache.set(text, vector);
    }

    this.emit('embedding-created', { textLength: text.length, dimensions: vector.length, timeMs: elapsed });
    return vector;
  }

  /**
   * 批量将文本数组转换为嵌入向量。按maxBatchSize分批调用embed方法。
   *
   * @param {string[]} texts - 待向量化的文本数组
   * @returns {number[][]} 嵌入向量数组的数组，与输入文本一一对应；无效输入返回空数组
   */
  embedBatch(texts) {
    this.guardShutdown();
    if (!Array.isArray(texts)) return [];
    const results = [];
    for (let i = 0; i < texts.length; i += this._config.maxBatchSize) {
      const batch = texts.slice(i, i + this._config.maxBatchSize);
      for (const text of batch) {
        results.push(this.embed(text));
      }
    }
    return results;
  }

  /**
   * 计算两个向量的余弦相似度。向量长度不一致或为零时返回0。
   *
   * @param {number[]} a - 向量A
   * @param {number[]} b - 向量B
   * @returns {number} 余弦相似度，范围 [-1, 1]；无效输入返回0
   * @example
   * const es = new EmbeddingService({ dimensions: 128 });
   * const vecA = es.embed('Hello world');
   * const vecB = es.embed('Hi there');
   * const score = es.cosineSimilarity(vecA, vecB);
   * console.log('Similarity:', score.toFixed(4));
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (!Number.isFinite(denominator) || denominator === 0) return 0;
    return dotProduct / denominator;
  }

  attachComputeAccelerator(accelerator) {
    this.guardShutdown();
    if (accelerator instanceof _ComputeAccelerator || (accelerator && typeof accelerator.execute === 'function')) {
      this._computeAccelerator = accelerator;
    }
    return this;
  }

  /**
   * 异步计算两个向量的余弦相似度，优先使用计算加速器，回退至同步计算。
   * @async
   * @param {number[]} a - 向量A
   * @param {number[]} b - 向量B
   * @returns {Promise<number>} 余弦相似度，范围 [-1, 1]；无效输入返回0
   */
  async cosineSimilarityAsync(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    if (this._computeAccelerator) {
      try {
        const result = await this._computeAccelerator.execute('cosineSimilarity', { vecA: a, vecB: b });
        if (typeof result === 'number' && Number.isFinite(result)) return result;
      } catch (_err) {
        debug('EmbeddingService', 'cosineSimilarityAsync', 'accelerator failed, falling back to local:', _err.message);
      }
    }
    return this.cosineSimilarity(a, b);
  }

  /**
   * 异步查找与查询向量最相似的候选向量，优先使用计算加速器批量计算，回退至同步查找。
   * @async
   * @param {number[]} queryVector - 查询向量
   * @param {Array<Object|number[]>} candidateVectors - 候选向量数组，元素可为向量数组或包含vector属性的对象
   * @param {Object} [options] - 检索选项
   * @param {number} [options.topK=5] - 返回的最大结果数
   * @param {number} [options.minSimilarity=DEFAULT_CONFIDENCE] - 最小相似度阈值
   * @returns {Promise<Array<object>>} 按相似度降序排列的结果数组，每项含index和similarity
   */
  async findSimilarAsync(queryVector, candidateVectors, options) {
    const topK = Number.isFinite(options && options.topK) ? options.topK : 5;
    const minSimilarity = Number.isFinite(options && options.minSimilarity) ? options.minSimilarity : DEFAULT_CONFIDENCE;

    if (!Array.isArray(candidateVectors)) return [];

    if (this._computeAccelerator) {
      try {
        const vectors = [];
        for (let i = 0; i < candidateVectors.length; i++) {
          vectors.push(candidateVectors[i]?.vector || candidateVectors[i]);
        }
        const similarities = await this._computeAccelerator.execute('batchCosineSimilarity', {
          queryVec: queryVector,
          vectors: vectors,
        });
        if (Array.isArray(similarities) && similarities.length === candidateVectors.length) {
          const scored = [];
          for (let i = 0; i < similarities.length; i++) {
            const sim = similarities[i];
            if (typeof sim === 'number' && Number.isFinite(sim) && sim >= minSimilarity) {
              scored.push({ index: i, similarity: sim });
            }
          }
          scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
          return scored.slice(0, topK);
        }
      } catch (_err) {
        debug('EmbeddingService', 'findSimilarAsync', 'accelerator failed, falling back to local:', _err && _err.message ? _err.message : String(_err));
      }
    }

    return this.findSimilar(queryVector, candidateVectors, options);
  }

  /**
   * 在候选向量列表中查找与查询向量最相似的向量。
   * 基于余弦相似度排序，返回满足最小相似度阈值的前topK个结果。
   *
   * @param {number[]} queryVector - 查询向量
   * @param {Array<Object|number[]>} candidateVectors - 候选向量数组，
   *   元素可为向量数组或包含vector属性的对象
   * @param {Object} [options={}] - 检索选项
   * @param {number} [options.topK=5] - 返回的最大结果数
   * @param {number} [options.minSimilarity=DEFAULT_CONFIDENCE] - 最小相似度阈值
   * @returns {Array<Object>} 按相似度降序排列的结果数组，每项含index和similarity
   */
  findSimilar(queryVector, candidateVectors, options) {
    const topK = Number.isFinite(options && options.topK) ? options.topK : 5;
    const minSimilarity = Number.isFinite(options && options.minSimilarity) ? options.minSimilarity : DEFAULT_CONFIDENCE;

    if (!Array.isArray(candidateVectors)) return [];
    const scored = [];
    for (let i = 0; i < candidateVectors.length; i++) {
      const sim = this.cosineSimilarity(queryVector, candidateVectors[i]?.vector || candidateVectors[i]);
      if (sim >= minSimilarity) {
        scored.push({ index: i, similarity: sim });
      }
    }

    scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    return scored.slice(0, topK);
  }

  /**
   * 本地哈希嵌入算法。基于文本字符特征生成确定性种子，结合二元组特征
   * 在向量对应维度上叠加权重，最终归一化为单位向量。
   *
   * @private
   * @param {string} text - 待向量化的文本
   * @returns {number[]} 归一化后的嵌入向量
   */
  _embedLocal(text) {
    const dims = (Number.isFinite(this._config.dimensions) && this._config.dimensions > 0) ? this._config.dimensions : 128;
    const vector = new Array(dims);
    const normalized = text.toLowerCase().replace(/[^\w\s\u4e00-\u9fff]/g, ' ').trim();
    if (!normalized) return vector.fill(0);
    const chars = normalized.split('');

    let seed = 0;
    for (let i = 0; i < chars.length; i++) {
      seed = ((seed << 5) - seed + chars[i].charCodeAt(0)) | 0;
    }

    for (let i = 0; i < dims; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      vector[i] = (seed / 0x7fffffff) * 2 - 1;
    }

    const bigrams = new Set();
    for (let i = 0; i < normalized.length - 1; i++) {
      if (bigrams.size >= 5000) break;
      bigrams.add(normalized.substring(i, i + 2));
    }

    for (const bigram of bigrams) {
      let hash = 0;
      for (let i = 0; i < bigram.length; i++) {
        hash = ((hash << 5) - hash + bigram.charCodeAt(i)) | 0;
      }
      const idx = Math.abs(hash) % dims;
      vector[idx] += 0.3;
      const secondaryIdx = Math.abs(hash * 31 + 7) % dims;
      if (secondaryIdx !== idx) {
        vector[secondaryIdx] += 0.15;
      }
    }

    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    if (Number.isFinite(norm) && norm > 0) {
      for (let i = 0; i < dims; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  /**
   * OpenAI嵌入提供者（预留）。当前未接入OpenAI API，自动回退至本地嵌入。
   *
   * @private
   * @param {string} text - 待向量化的文本
   * @returns {number[]} 嵌入向量（当前回退至本地嵌入结果）
   */
  _embedOpenAI(text) {
    debug('EmbeddingService', '_embedOpenAI', 'OpenAI provider not yet connected, falling back to local');
    return this._embedLocal(text);
  }

  /**
   * 预计算嵌入提供者（预留）。需要外部预置向量数据，当前自动回退至本地嵌入。
   *
   * @private
   * @param {string} text - 待向量化的文本
   * @returns {number[]} 嵌入向量（当前回退至本地嵌入结果）
   */
  _embedPrecomputed(text) {
    debug('EmbeddingService', '_embedPrecomputed', 'Precomputed provider requires external setup, falling back to local');
    return this._embedLocal(text);
  }

  /**
   * 获取嵌入服务的运行统计信息，包含缓存大小、提供者类型和向量维度。
   *
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalEmbeddings - 累计生成的嵌入向量数
   * @returns {number} return.cacheHits - 缓存命中次数
   * @returns {number} return.cacheMisses - 缓存未命中次数
   * @returns {number} return.avgTimeMs - 平均嵌入耗时（毫秒）
   * @returns {number} return.cacheSize - 当前缓存条目数
   * @returns {string} return.provider - 当前嵌入提供者
   * @returns {number} return.dimensions - 当前向量维度
   */
  getStats() {
    return mergeConfig(this._stats, {
      cacheSize: this._cache.size,
      provider: this._config.provider,
      dimensions: this._config.dimensions,
    });
  }

  /**
   * 清空嵌入向量LRU缓存。
   */
  clearCache() {
    this.guardShutdown();
    this._cache.clear();
  }

  /**
   * 优雅关闭回调，清空LRU缓存。由withShutdown混入在进程关闭时自动调用。
   *
   * @private
   */
  _onShutdown() {
    this._cache.clear();
    this._stats = { totalEmbeddings: 0, cacheHits: 0, cacheMisses: 0, avgTimeMs: 0 };
    this._config = mergeConfig(DEFAULT_OPTIONS);
    this._computeAccelerator = null;
    this.removeAllListeners();
  }
}

/**
 * 嵌入提供者类型枚举的静态引用，便于外部通过类名访问。
 * @static
 * @type {Object.<string, string>}
 */
EmbeddingService.PROVIDERS = PROVIDERS;

module.exports = withShutdown(EmbeddingService);
