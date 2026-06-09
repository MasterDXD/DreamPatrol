'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { debug } = require('../../utils/debug-logger');
const { DEFAULT_CONFIDENCE, HARNESS_DIR, MAX_CATEGORY_LENGTH, MAX_SOURCE_LENGTH, DEFAULT_PERSIST_DEBOUNCE_MS } = require('../../utils/constants');
const { getCapacity } = require('../../utils/capacity-config');
const { createPersister, readJson } = require('../../utils/debounced-persister');
const RingBuffer = require('../../utils/ring-buffer');
const { ensureDirSync } = require('../../utils/fs-utils');
const { uuid, ID_PREFIXES } = require('../../utils/unique-id');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { emitError, ensureArray } = require('../../utils/safe-execute');

const DEFAULT_MAX_CAUSAL_MEMORIES = 500;
const DEFAULT_CAUSAL_MEMORY_TTL_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_SIMILARITY_THRESHOLD = 0.3;
const DEFAULT_DECAY_FACTOR_PER_DAY = 0.98;
const DEFAULT_CONFLICT_SIMILARITY_THRESHOLD = 0.7;
const WAL_DIR_NAME = 'causal-memory-wal';
const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because', 'if', 'when', 'where', 'how', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'it', 'its']);

function _finiteNum(val, defaultVal) {
  return typeof val === 'number' && Number.isFinite(val) ? val : defaultVal;
}

/**
 * @module runtime/causal/causal-memory-store
 * 因果内存存储。内存索引、快速查询、TTL过期，
 * 支持相似度搜索和容量淘汰。
 *
 * @classdesc 因果内存存储，提供因果链数据的持久化存储和检索服务
 * @extends EventEmitter
 */
class CausalMemoryStore extends EventEmitter {
  /**
   * 创建CausalMemoryStore实例。
   * @param {Object} [sqliteStore] - SQLite存储实例
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.embeddingService] - 嵌入服务实例
   * @param {number} [options.maxMemories=10000] - 最大记忆数量
   * @param {number} [options.ttlMs=86400000] - 记忆TTL（毫秒）
   * @param {number} [options.similarityThreshold=0.7] - 相似度阈值
   * @param {number} [options.decayFactor=0.9] - 每日衰减因子
   * @param {number} [options.conflictThreshold=0.85] - 冲突检测相似度阈值
   * @param {string} [options.root] - 项目根目录，提供时启用WAL持久化
   */
  constructor(sqliteStore, options) {
    super();
    this._sqliteStore = sqliteStore ?? null;
    this._memoryCache = new Map();
    this._similarityIndex = new Map();
    this._maxSimilarityIndex = 1000;
    this._embeddingCache = new Map();
    this._maxEmbeddingCache = 500;
    this._embeddingService = (options && options.embeddingService) ?? null;
    this._maxMemories = _finiteNum(options && options.maxMemories, DEFAULT_MAX_CAUSAL_MEMORIES);
    this._ttlMs = _finiteNum(options && options.ttlMs, DEFAULT_CAUSAL_MEMORY_TTL_MS);
    this._similarityThreshold = _finiteNum(options && options.similarityThreshold, DEFAULT_SIMILARITY_THRESHOLD);
    this._decayFactor = _finiteNum(options && options.decayFactor, DEFAULT_DECAY_FACTOR_PER_DAY);
    this._conflictThreshold = _finiteNum(options && options.conflictThreshold, DEFAULT_CONFLICT_SIMILARITY_THRESHOLD);
    this._root = (options && options.root) ?? null;
    this._walDir = this._root ? path.join(this._root, HARNESS_DIR, WAL_DIR_NAME) : null;
    this._persister = null;
    if (this._root) {
      this._initWAL();
    }
  }

  /**
   * 从项目配置创建CausalMemoryStore实例，自动读取容量配置。
   * @param {object} sqliteStore - SQLite存储实例
   * @param {string} projectRoot - 项目根目录路径
   * @returns {CausalMemoryStore} 新的CausalMemoryStore实例
   */
  static fromConfig(sqliteStore, projectRoot) {
    return new CausalMemoryStore(sqliteStore, {
      root: projectRoot,
      maxMemories: getCapacity('causal_memory_max', projectRoot),
      ttlMs: getCapacity('causal_memory_ttl_days', projectRoot) * 24 * 3600 * 1000,
      similarityThreshold: getCapacity('similarity_threshold', projectRoot),
      decayFactor: getCapacity('decay_factor_per_day', projectRoot),
      conflictThreshold: getCapacity('conflict_similarity_threshold', projectRoot),
    });
  }

  _initWAL() {
    try {
      const walDir = this._walDir;
      ensureDirSync(walDir);
      this._restoreFromWAL();
      this._persister = createPersister({
        root: this._root,
        dir: WAL_DIR_NAME,
        filename: 'causal-memory-state.json',
        debounceMs: DEFAULT_PERSIST_DEBOUNCE_MS,
        serialize: () => this._serializeState(),
        onError: (err) => {
          debug('CausalMemoryStore', 'WAL persist error', err);
        },
      });
    } catch (err) {
      debug('CausalMemoryStore', '_initWAL', err);
      this._walInitFailed = true;
      emitError(this, 'wal-init-error', err);
    }
  }

  _restoreFromWAL() {
    const stateFile = path.join(this._walDir, 'causal-memory-state.json');
    if (!fs.existsSync(stateFile)) return;
    try {
      const data = readJson(stateFile);
      if (data && Array.isArray(data.memories)) {
        for (const entry of data.memories) {
          if (entry && entry.id) {
            this._memoryCache.set(entry.id, entry);
            this._updateSimilarityIndex(entry);
          }
        }
      }
    } catch (err) {
      debug('CausalMemoryStore', '_restoreFromWAL', err);
    }
  }

  _serializeState() {
    const memories = Array.from(this._memoryCache.values());
    return { memories, savedAt: Date.now() };
  }

  _scheduleWALPersist() {
    if (this._persister) {
      this._persister.schedule();
    }
  }

  /**
   * 添加一条因果记忆条目，包含原因、结果、上下文和置信度。超出容量时自动淘汰。
   * @param {object} entry - 因果记忆条目
   * @param {string} entry.cause - 原因描述
   * @param {string} entry.effect - 结果描述
   * @param {string} [entry.context=''] - 上下文描述
   * @param {number} [entry.confidence=0.8] - 置信度（0-1）
   * @param {string} [entry.temporalScope='session'] - 时间作用域
   * @param {string} [entry.category='general'] - 分类标签
   * @param {string[]} [entry.tags=[]] - 标签列表
   * @param {string} [entry.source='unknown'] - 来源标识
   * @returns {Promise<{success: boolean, id?: string, error?: string}>} 添加结果
   */
  async addCausalMemory(entry) {
    this.guardShutdown();
    const validationError = this._validateEntry(entry);
    if (validationError) {
      return { success: false, error: validationError };
    }
    const causalEntry = this._buildCausalEntry(entry);
    this._memoryCache.set(causalEntry.id, causalEntry);
    if (this._memoryCache.size > this._maxMemories) {
      this._evictMemory();
    }
    this._updateSimilarityIndex(causalEntry);
    if (this._sqliteStore && typeof this._sqliteStore.addMemory === 'function') {
      try {
        await this._sqliteStore.addMemory(entry.target || 'causal', JSON.stringify(causalEntry));
      } catch (e) {
        debug('CausalMemoryStore', 'persist', e && e.message ? e.message : String(e));
        return { success: false, persisted: false, error: e.message || String(e) };
      }
    }
    this.emit('causal-memory-added', { id: causalEntry.id, cause: causalEntry.cause });
    this._scheduleWALPersist();
    return { success: true, id: causalEntry.id, persisted: true };
  }

  _validateEntry(entry) {
    if (!entry || typeof entry !== 'object') {
      return 'entry must be an object';
    }
    if (typeof entry.cause !== 'string' || typeof entry.effect !== 'string') {
      return 'cause and effect must be strings';
    }
    const MAX_STRING_LENGTH = 2000;
    if (entry.cause.length > MAX_STRING_LENGTH || entry.effect.length > MAX_STRING_LENGTH) {
      return 'cause or effect exceeds maximum length';
    }
    return null;
  }

  _buildCausalEntry(entry) {
    const MAX_STRING_LENGTH = 2000;
    return {
      id: uuid(ID_PREFIXES.CAUSAL_MEMORY),
      cause: entry.cause,
      effect: entry.effect,
      context: typeof entry.context === 'string' ? entry.context.substring(0, MAX_STRING_LENGTH) : '',
      confidence: Math.min(1, Math.max(0, _finiteNum(entry.confidence, DEFAULT_CONFIDENCE))),
      temporalScope: entry.temporalScope || 'session',
      category: typeof entry.category === 'string' ? entry.category.substring(0, MAX_CATEGORY_LENGTH) : 'general',
      tags: Array.isArray(entry.tags) ? entry.tags.filter(t => typeof t === 'string' && t.length <= MAX_CATEGORY_LENGTH).slice(0, 20) : [],
      source: typeof entry.source === 'string' ? entry.source.substring(0, MAX_SOURCE_LENGTH) : 'unknown',
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
      verifiedAt: null,
    };
  }

  _evictMemory() {
    let evicted = false;
    const now = Date.now();
    const expiredKeys = [];
    for (const [k, v] of this._memoryCache) {
      if (v.expiresAt && now > v.expiresAt) {
        expiredKeys.push(k);
        this._removeFromSimilarityIndex(v);
        evicted = true;
        break;
      }
    }
    for (const ek of expiredKeys) { this._memoryCache.delete(ek); }
    if (!evicted && this._memoryCache.size > 0) {
      const oldest = this._memoryCache.keys().next().value;
      if (oldest !== undefined) {
        const oldestEntry = this._memoryCache.get(oldest);
        if (oldestEntry) {
          this._removeFromSimilarityIndex(oldestEntry);
        }
        this._memoryCache.delete(oldest);
      }
    }
  }

  _updateSimilarityIndex(entry) {
    const keywords = this._extractKeywords(entry.cause + ' ' + entry.context);
    for (const kw of keywords) {
      if (this._similarityIndex.size >= this._maxSimilarityIndex && !this._similarityIndex.has(kw)) {
        const oldestKey = this._similarityIndex.keys().next().value;
        this._similarityIndex.delete(oldestKey);
      }
      if (!this._similarityIndex.has(kw)) {
        this._similarityIndex.set(kw, new RingBuffer(100));
      }
      const list = this._similarityIndex.get(kw);
      if (!list.includes(entry.id)) {
        list.push(entry.id);
      }
    }
  }

  _removeFromSimilarityIndex(entry) {
    if (!entry || !entry.id) return;
    const keywords = this._extractKeywords((entry.cause || '') + ' ' + (entry.context || ''));
    for (const kw of keywords) {
      const list = this._similarityIndex.get(kw);
      if (!list) continue;
      const arr = list.toArray();
      const idx = arr.indexOf(entry.id);
      if (idx >= 0) {
        arr.splice(idx, 1);
      }
      if (arr.length > 0) {
        const rb = new RingBuffer(100);
        for (const item of arr) rb.push(item);
        this._similarityIndex.set(kw, rb);
      } else {
        this._similarityIndex.delete(kw);
      }
    }
  }

  _extractKeywords(text) {
    if (!text || typeof text !== 'string') return [];
    return text.toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  }

  /**
   * 基于因果相似度搜索记忆条目，支持关键词匹配和语义嵌入两种模式。
   * @param {string} queryContext - 查询文本
   * @param {object} [options] - 搜索选项
   * @param {number} [options.limit=10] - 返回结果上限
   * @param {number} [options.threshold] - 相似度阈值
   * @param {string} [options.mode='auto'] - 搜索模式（auto/semantic/keyword）
   * @returns {Promise<Array<object>>} 匹配的记忆条目列表
   */
  async searchByCausalSimilarity(queryContext, options) {
    this.guardShutdown();
    const opts = options ?? {};
    const limit = opts.limit ?? 10;
    const threshold = opts.threshold ?? this._similarityThreshold;
    const mode = opts.mode ?? 'auto';

    if (mode === 'semantic' || (mode === 'auto' && this._embeddingService)) {
      return this._searchBySemanticSimilarity(queryContext, limit, threshold);
    }

    const queryKeywords = this._extractKeywords(queryContext);
    if (queryKeywords.length === 0) return [];
    const candidateScores = new Map();
    for (const kw of queryKeywords) {
      const matching = this._similarityIndex.get(kw) ?? [];
      for (const id of matching) {
        candidateScores.set(id, (candidateScores.get(id) ?? 0) + 1);
      }
    }
    const maxPossible = queryKeywords.length;
    const results = [];
    for (const [id, score] of candidateScores) {
      const similarity = maxPossible > 0 ? score / maxPossible : 0;
      if (similarity >= threshold) {
        const entry = this._memoryCache.get(id);
        if (entry) {
          results.push({ ...entry, similarity });
        }
      }
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  async _searchBySemanticSimilarity(queryContext, limit, threshold) {
    if (!this._embeddingService) return [];
    const queryVec = await this._embeddingService.embed(queryContext);
    if (!queryVec || queryVec.length === 0) return [];
    const results = [];
    for (const [id, entry] of this._memoryCache) {
      let entryVec = this._embeddingCache.get(id);
      if (!entryVec) {
        const text = (entry.cause || '') + ' ' + (entry.context || '') + ' ' + (entry.effect || '');
        entryVec = await this._embeddingService.embed(text);
        if (entryVec && entryVec.length > 0) {
          if (!this._embeddingCache.has(id)) {
            this._embeddingCache.set(id, entryVec);
          }
          if (this._embeddingCache.size > this._maxEmbeddingCache) {
            const oldestKey = this._embeddingCache.keys().next().value;
            this._embeddingCache.delete(oldestKey);
          }
        }
      } else {
        entryVec = this._embeddingCache.get(id) || entryVec;
      }
      if (entryVec && entryVec.length > 0) {
        const similarity = this._cosineSimilarity(queryVec, entryVec);
        if (similarity >= threshold) {
          results.push({ ...entry, similarity });
        }
      }
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    const COSINE_EPSILON = 1e-10;
    if (!Number.isFinite(denom) || denom < COSINE_EPSILON) return 0;
    return dot / denom;
  }

  /**
   * 基于语义分组搜索记忆条目，支持按分类、标签和最低置信度过滤，并应用时间衰减。
   * @param {string} queryContext - 查询文本
   * @param {object} [options] - 搜索选项
   * @param {number} [options.limit=10] - 返回结果上限
   * @param {string} [options.category] - 分类过滤
   * @param {string[]} [options.tags=[]] - 标签过滤
   * @param {number} [options.minConfidence=0] - 最低置信度过滤
   * @returns {Promise<Array<object>>} 带衰减置信度和加权评分的记忆条目列表
   */
  async searchBySemanticGroup(queryContext, options) {
    this.guardShutdown();
    const opts = options ?? {};
    const limit = opts.limit ?? 10;
    const category = opts.category ?? null;
    const tags = opts.tags ?? [];
    const minConfidence = opts.minConfidence ?? 0;
    const baseResults = await this.searchByCausalSimilarity(queryContext, { limit: limit * 3, threshold: this._similarityThreshold });
    const filtered = baseResults.filter(entry => {
      if (category && entry.category !== category) return false;
      if (entry.confidence < minConfidence) return false;
      if (tags.length > 0) {
        const entryTags = Array.isArray(entry.tags) ? entry.tags : [];
        const hasMatchingTag = tags.some(t => entryTags.includes(t));
        if (!hasMatchingTag) return false;
      }
      return true;
    });
    return filtered.map(entry => {
      const decayedConfidence = this._applyTimeDecay(entry);
      const weightedScore = entry.similarity * 0.6 + decayedConfidence * 0.4;
      return { ...entry, decayedConfidence, weightedScore };
    }).sort((a, b) => b.weightedScore - a.weightedScore).slice(0, limit);
  }

  /**
   * 基于上下文链搜索记忆条目，先直接搜索再沿已完成技能链扩展搜索。
   * @param {string} queryContext - 查询文本
   * @param {string[]} completedSkills - 已完成的技能ID列表
   * @param {object} [options] - 搜索选项
   * @param {number} [options.limit=10] - 返回结果上限
   * @returns {Promise<Array<object>>} 合并去重后的记忆条目列表
   */
  async searchByContextChain(queryContext, completedSkills, options) {
    this.guardShutdown();
    const opts = options ?? {};
    const limit = opts.limit ?? 10;
    const safeCompleted = ensureArray(completedSkills);
    const directResults = await this.searchBySemanticGroup(queryContext, opts);
    const chainResults = [];
    const visited = new Set(directResults.map(r => r.id));
    for (const skillId of safeCompleted) {
      const skillQuery = queryContext + ' ' + skillId;
      const skillMatches = await this.searchBySemanticGroup(skillQuery, { ...opts, limit: 3 });
      for (const match of skillMatches) {
        if (!visited.has(match.id)) {
          visited.add(match.id);
          chainResults.push({ ...match, contextSource: skillId });
        }
      }
    }
    const allResults = [...directResults, ...chainResults];
    allResults.sort((a, b) => (b.weightedScore ?? 0) - (a.weightedScore ?? 0));
    return allResults.slice(0, limit);
  }

  /**
   * 验证指定记忆条目的因果一致性，超TTL的条目置信度降级为50%。
   * @param {string} entryId - 记忆条目ID
   * @returns {Promise<{valid: boolean, degraded: boolean, confidence: number, reason?: string}>} 验证结果
   */
  async verifyCausalConsistency(entryId) {
    this.guardShutdown();
    const entry = this._memoryCache.get(entryId);
    if (!entry) return { valid: false, reason: 'entry_not_found' };
    const now = Date.now();
    const age = now - entry.createdAt * 1000;
    if (age > this._ttlMs) {
      if (!entry._degraded) {
        this._memoryCache.set(entryId, {
          ...entry,
          confidence: entry.confidence * 0.5,
          _degraded: true,
          verifiedAt: Date.now(),
        });
        this._scheduleWALPersist();
        this.emit('causal-memory-degraded', { id: entryId, newConfidence: entry.confidence * 0.5 });
      } else {
        this._memoryCache.set(entryId, {
          ...entry,
          verifiedAt: Date.now(),
        });
      }
      const updated = this._memoryCache.get(entryId);
      return { valid: true, degraded: true, confidence: updated.confidence, reason: 'exceeded_ttl' };
    }
    this._memoryCache.set(entryId, {
      ...entry,
      verifiedAt: now / 1000,
    });
    return { valid: true, degraded: false, confidence: entry.confidence };
  }

  /**
   * 获取因果记忆条目列表，支持按分类、最低置信度和时间作用域过滤。
   * @param {object} [filter] - 过滤条件
   * @param {string} [filter.category] - 分类过滤
   * @param {number} [filter.minConfidence] - 最低置信度过滤
   * @param {string} [filter.temporalScope] - 时间作用域过滤
   * @returns {Array<object>} 符合条件的记忆条目列表
   */
  getCausalMemories(filter) {
    this.guardShutdown();
    const result = [];
    for (const e of this._memoryCache.values()) {
      if (filter) {
        if (filter.category && e.category !== filter.category) continue;
        if (filter.minConfidence && e.confidence < filter.minConfidence) continue;
        if (filter.temporalScope && e.temporalScope !== filter.temporalScope) continue;
      }
      result.push({ ...e, tags: Array.isArray(e.tags) ? e.tags.slice() : e.tags });
    }
    return result;
  }

  /**
   * 获取指定ID的因果记忆条目。
   * @param {string} id - 记忆条目ID
   * @returns {object|null} 记忆条目，不存在时返回null
   */
  getCausalMemory(id) {
    this.guardShutdown();
    const entry = this._memoryCache.get(id);
    return entry ? { ...entry, tags: Array.isArray(entry.tags) ? entry.tags.slice() : entry.tags } : null;
  }

  /**
   * 删除指定ID的因果记忆条目。
   * @param {string} id - 记忆条目ID
   * @returns {boolean} 条目是否存在且已被删除
   */
  removeCausalMemory(id) {
    this.guardShutdown();
    const entry = this._memoryCache.get(id);
    const existed = this._memoryCache.delete(id);
    if (existed) {
      if (entry) this._removeFromSimilarityIndex(entry);
      this.emit('causal-memory-removed', { id });
      this._scheduleWALPersist();
    }
    return existed;
  }

  /**
   * 获取因果内存存储统计信息。
   * @returns {{ totalMemories: number, avgConfidence: number, verifiedMemories: number, degradedMemories: number, similarityIndexSize: number }} 统计数据
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('CausalMemoryStore', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalMemories: 0, avgConfidence: 0, verifiedMemories: 0, degradedMemories: 0, similarityIndexSize: 0 }; }
    let totalConfidence = 0;
    let verifiedCount = 0;
    let degradedCount = 0;
    const now = Date.now();
    for (const entry of this._memoryCache.values()) {
      totalConfidence += entry.confidence;
      if (entry.verifiedAt) verifiedCount++;
      if (now - entry.createdAt * 1000 > this._ttlMs) degradedCount++;
    }
    const count = this._memoryCache.size;
    return {
      totalMemories: count,
      avgConfidence: count > 0 ? totalConfidence / count : 0,
      verifiedMemories: verifiedCount,
      degradedMemories: degradedCount,
      similarityIndexSize: this._similarityIndex.size,
    };
  }

  _applyTimeDecay(entry) {
    const now = Date.now();
    const ageDays = (now - entry.createdAt * 1000) / (24 * 3600 * 1000);
    if (!Number.isFinite(ageDays) || ageDays < 0) return entry.confidence;
    const decayedConfidence = entry.confidence * Math.pow(Math.abs(this._decayFactor), ageDays);
    return Math.max(0.01, decayedConfidence);
  }

  /**
   * 批量添加因果记忆条目。
   * @param {Array<object>} entries - 因果记忆条目数组
   * @returns {Promise<{success: boolean, count: number, results: Array}>} 批量添加结果
   */
  async addCausalMemories(entries) {
    this.guardShutdown();
    if (!Array.isArray(entries)) return { success: false, error: 'entries must be an array' };
    const results = [];
    for (const entry of entries) {
      try {
        const result = await this.addCausalMemory(entry);
        results.push(result);
      } catch (err) {
        results.push({ success: false, error: err && err.message ? err.message : String(err) });
      }
    }
    return { success: true, count: results.reduce((c, r) => c + (r.success ? 1 : 0), 0), results };
  }

  /**
   * 追踪因果链，从指定效果关键词沿因果链逆向搜索原因。
   * @param {string} effectKeyword - 效果关键词
   * @param {object} [options] - 追踪选项
   * @param {number} [options.maxDepth=5] - 最大追踪深度
   * @returns {Promise<Array<{id: string, cause: string, effect: string, confidence: number, depth: number}>>} 因果链条目列表
   */
  async traceCausalChain(effectKeyword, options) {
    this.guardShutdown();
    const opts = options ?? {};
    const maxDepth = opts.maxDepth ?? 5;
    const chain = [];
    const visited = new Set();
    const queue = [{ keyword: effectKeyword, depth: 0 }];
    while (queue.length > 0 && chain.length < 50) {
      const item = queue.shift();
      if (item.depth >= maxDepth) continue;
      const matches = await this.searchByCausalSimilarity(item.keyword, { limit: 3, threshold: 0.4 });
      for (const match of matches) {
        if (visited.has(match.id)) continue;
        visited.add(match.id);
        chain.push({
          id: match.id,
          cause: match.cause,
          effect: match.effect,
          confidence: this._applyTimeDecay(match),
          depth: item.depth,
        });
        queue.push({ keyword: match.cause, depth: item.depth + 1 });
      }
    }
    return chain;
  }

  /**
   * 检测因果记忆中的冲突条目（原因相似但结果不同的条目对）。
   * @returns {Array<{entryA: object, entryB: object, causeSimilarity: number, effectSimilarity: number}>} 冲突列表
   */
  detectCausalConflicts() {
    this.guardShutdown();
    const entries = Array.from(this._memoryCache.values());
    const conflicts = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        const causeSimilarity = this._computeTextSimilarity(a.cause, b.cause);
        if (causeSimilarity >= this._conflictThreshold) {
          const effectSimilarity = this._computeTextSimilarity(a.effect, b.effect);
          if (effectSimilarity < this._similarityThreshold) {
            conflicts.push({
              entryA: { id: a.id, cause: a.cause, effect: a.effect, confidence: a.confidence },
              entryB: { id: b.id, cause: b.cause, effect: b.effect, confidence: b.confidence },
              causeSimilarity,
              effectSimilarity,
            });
          }
        }
      }
    }
    if (conflicts.length > 0) {
      this.emit('causal-conflicts-detected', { count: conflicts.length });
    }
    return conflicts;
  }

  _computeTextSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    const kw1 = new Set(this._extractKeywords(text1));
    const kw2 = new Set(this._extractKeywords(text2));
    if (kw1.size === 0 && kw2.size === 0) return 0;
    let intersection = 0;
    for (const kw of kw1) {
      if (kw2.has(kw)) intersection++;
    }
    const union = kw1.size + kw2.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * 获取带时间衰减置信度的记忆条目列表。
   * @param {object} [filter] - 过滤条件（同getCausalMemories）
   * @returns {Array<object>} 带decayedConfidence字段的记忆条目列表
   */
  getMemoriesWithDecay(filter) {
    this.guardShutdown();
    const entries = this.getCausalMemories(filter);
    return entries.map(e => ({
      ...e,
      decayedConfidence: this._applyTimeDecay(e),
    }));
  }

  _onShutdown() {
    const doCleanup = () => {
      this._memoryCache.clear();
      this._similarityIndex.clear();
      this._embeddingCache.clear();
      this._sqliteStore = null;
      this._embeddingService = null;
    };
    if (this._persister) {
      // Synchronous emergency write: persist in-memory state to disk immediately
      // so data is not lost if the async flush never completes.
      try {
        const state = this._serializeState();
        const statePath = path.join(this._walDir, 'causal-memory-state.json');
        const tmpPath = statePath + '.shutdown';
        fs.writeFileSync(tmpPath, JSON.stringify(state), 'utf8');
        try { fs.renameSync(tmpPath, statePath); } catch (_renameErr) {
          try { fs.unlinkSync(tmpPath); } catch (_e) { debug('CausalMemoryStore', '_onShutdown:unlinkTmp', _e && _e.message ? _e.message : String(_e)); }
        }
      } catch (_syncErr) {
        debug('CausalMemoryStore', '_onShutdown:syncWrite', _syncErr && _syncErr.message ? _syncErr.message : String(_syncErr));
      }
      const flushResult = this._persister.flush();
      this._persister = null;
      if (flushResult && typeof flushResult.then === 'function') {
        return flushResult.then(doCleanup, doCleanup);
      }
    }
    doCleanup();
  }

  /**
   * 检查实例是否健康（未关闭）。
   * @returns {boolean} 健康状态
   */
  isHealthy() { return !this._shutDown; }
}

module.exports = withShutdown(CausalMemoryStore);
