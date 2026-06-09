'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { mergeConfig } = require('../../utils/safe-assign');
const { safeCall, roundTo } = require('../../utils/safe-execute');
const { safeStringify } = require('../../utils/safe-parse');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_CONFIG = {
  maxMemories: 2000,
  defaultTTL: 86400000,
  retrievalTimeout: 100,
  consolidationInterval: 3600000,
  similarityThreshold: 0.8,
  maxDocumentFreqTokens: 50000,
};

const KEYWORD_WEIGHT = 0.4;
const SEMANTIC_WEIGHT = 0.6;

/**
 * 时间衰减因子（每天）。融合OpenClaw Brain v1.2.0乘法衰减模型，
 * 解决加法模型导致的分数溢出问题，让记忆热度衰减更平滑、更合理。
 */
const TIME_DECAY_FACTOR_PER_DAY = 0.95;

/**
 * @module runtime/thought/brain-memory
 * @classdesc 脑记忆。分层记忆架构、工作记忆与长期记忆协调。
 * 融合OpenClaw Brain v1.2.0：记忆列表分页(BrainList)、乘法时间衰减、
 * 记忆统计增强(BrainMemoryStats)、7项健康检查(BrainHealthCheck)、欢迎仪式。
 * BrainMemory — Layered memory architecture coordinating working and long-term memory
 * Provides keyword and semantic hybrid retrieval with TF-IDF scoring, periodic memory
 * consolidation, TTL-based expiry, and LRU eviction when capacity is exceeded.
 * @extends EventEmitter
 * @emits BrainMemory#memory-stored
 * @emits BrainMemory#memory-retrieved
 * @emits BrainMemory#memory-expired
 * @emits BrainMemory#consolidation-complete
 */
class BrainMemory extends EventEmitter {
  /**
   * 构造BrainMemory实例
   * @param {Object} [options={}] - 配置选项
   * @param {number} [options.maxDocumentFreqTokens=50000] - 文档频率词典最大Token数
   * @param {number} [options.maxCacheSize=1000] - 缓存最大容量
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._memories = new Map();
    this._embeddings = new Map();
    this._sqliteStore = null;
    this._embeddingService = null;
    this._eventBus = null;
    this._retrievalTimes = [];
    this._hitCount = 0;
    this._missCount = 0;
    this._lastError = null;
    this._consolidationTimer = null;
    this._documentFreq = new Map();
    this._totalDocuments = 0;
    this._consolidationTimerStarted = false;
    this._evicting = false;
  }

  /**
   * 存储一条记忆记录，支持关键词和语义嵌入，容量满时自动淘汰最旧条目
   * @param {string} key - 记忆唯一键
   * @param {string} content - 记忆内容文本
   * @param {object} [metadata] - 元数据对象，可包含category、tags、confidence、source、ttl
   * @returns {object|null} 成功返回记忆记录对象，key或content无效返回null
   * @throws {Error} When key is empty or content is missing
   * @example
   * const bm = new BrainMemory({ maxMemories: 500 });
   * const record = bm.store('auth-design', 'Use JWT with RS256 for API authentication', {
   *   category: 'architecture',
   *   tags: ['auth', 'jwt', 'security'],
   *   confidence: 0.9
   * });
   * console.log(record.key, record.metadata.category);
   */
  store(key, content, metadata) {
    this.guardShutdown();
    if (!this._consolidationTimerStarted) {
      this._consolidationTimerStarted = true;
      this._startConsolidationTimer();
    }
    if (!key || typeof key !== 'string') {
      debug('BrainMemory', 'store', 'Invalid key');
      return null;
    }
    if (!content || typeof content !== 'string') {
      debug('BrainMemory', 'store', 'Invalid content');
      return null;
    }

    const now = Date.now();
    const meta = metadata ?? {};
    const record = {
      key,
      content,
      metadata: {
        category: meta.category ?? 'general',
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        confidence: Number.isFinite(meta.confidence) ? meta.confidence : 0.5,
        source: meta.source || '',
        ttl: meta.ttl ?? this._config.defaultTTL,
      },
      embedding: null,
      stale: false,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + (meta.ttl ?? this._config.defaultTTL),
    };

    if (this._memories.size >= this._config.maxMemories) {
      this._evictOldest();
    }

    this._embedContent(key, content, record);

    const existing = this._memories.get(key);
    if (existing) {
      this._removeFromIndex(existing);
    }

    this._memories.set(key, record);
    this._addToIndex(record);
    this._persistRecord(record);
    this._notifyStored(key, record);
    this.emit('memory-stored', { key, category: record.metadata.category });
    return record;
  }

  /**
   * 检索与查询相关的记忆，支持keyword、semantic、hybrid三种模式
   * @param {string} query - 查询文本
   * @param {object} [options] - 检索选项
   * @param {string} [options.mode='hybrid'] - 检索模式，可选'keyword'、'semantic'、'hybrid'
   * @param {number} [options.topK=10] - 返回结果数量上限
   * @param {number} [options.minConfidence=0.5] - 最低置信度阈值
   * @param {Array<string>} [options.categories] - 限定检索的类别列表
   * @returns {Array<object>} 按分数降序排列的检索结果数组，每条包含key、content、metadata、score、mode字段
   */
  retrieve(query, options) {
    this.guardShutdown();
    if (!query || typeof query !== 'string') {
      return [];
    }

    const startTime = Date.now();
    const opts = options ?? {};
    const mode = opts.mode ?? 'hybrid';
    const topK = opts.topK ?? 10;
    const minConfidence = opts.minConfidence ?? 0.5;
    const categories = opts.categories;

    const candidates = [];
    for (const [, record] of this._memories) {
      if (record.stale) continue;
      if (record.metadata.confidence < minConfidence) continue;
      if (categories && categories.length > 0 && !categories.includes(record.metadata.category)) continue;
      candidates.push(record);
    }

    let results;

    if (mode === 'keyword') {
      results = this._retrieveKeyword(query, candidates);
    } else if (mode === 'semantic') {
      results = this._retrieveSemantic(query, candidates);
    } else {
      const keywordResults = this._retrieveKeyword(query, candidates);
      const semanticResults = this._retrieveSemantic(query, candidates);
      results = this._fuseResults(keywordResults, semanticResults);
    }

    results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    // 应用时间衰减：融合OpenClaw Brain v1.2.0乘法衰减模型
    for (const r of results) {
      const record = this._memories.get(r.key);
      if (record) {
        r.score = this._applyTimeDecay(record, r.score);
        r.decayedScore = r.score;
      }
    }
    results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    results = results.slice(0, topK);

    const elapsed = Date.now() - startTime;
    this._retrievalTimes.push(elapsed);
    if (this._retrievalTimes.length > 100) {
      this._retrievalTimes.shift();
    }

    if (results.length > 0) {
      this._hitCount++;
    } else {
      this._missCount++;
    }

    if (this._eventBus) {
      safeCall(() => {
        this._eventBus.emit('brain-memory-retrieved', { query, mode, resultCount: results.length, elapsed });
      }, 'BrainMemory', 'retrieve-event');
    }

    this.emit('memory-retrieved', { query, mode, resultCount: results.length, elapsed });
    return results;
  }

  /**
   * 获取脑记忆的健康状态，综合评估平均检索耗时、命中率等因素。
   * 融合OpenClaw Brain v1.2.0 BrainHealthCheck：增加记忆专属检查项
   * （嵌入索引完整性、损坏记录检测、维度一致性等）。
   * @returns {object} 健康状态对象，包含status('healthy'|'degraded'|'unhealthy')、memoryCount、avgRetrievalTime、hitRate、lastError、checks字段
   */
  getHealthStatus() {
    const memoryCount = this._memories.size;
    const avgRetrievalTime = this._retrievalTimes.length > 0
      ? this._retrievalTimes.reduce((a, b) => a + b, 0) / this._retrievalTimes.length
      : 0;
    const totalRetrievals = this._hitCount + this._missCount;
    const hitRate = totalRetrievals > 0 ? this._hitCount / totalRetrievals : 0;

    let status = 'healthy';
    if (avgRetrievalTime > this._config.retrievalTimeout * 2 || memoryCount === 0) {
      status = 'unhealthy';
    } else if (avgRetrievalTime > this._config.retrievalTimeout || hitRate < 0.3) {
      status = 'degraded';
    }

    if (this._lastError) {
      status = 'degraded';
    }

    const checks = {
      config: this._checkConfig(),
      backendService: this._checkBackendService(),
      embeddingIndex: this._checkEmbeddingIndex(),
      corruptedRecords: this._checkCorruptedRecords(),
      expiredMemories: this._checkExpiredMemories(),
      dimensionConsistency: this._checkDimensionConsistency(),
      capacity: this._checkCapacity(memoryCount),
    };

    for (const [, check] of Object.entries(checks)) {
      if (check.status === 'unhealthy' && status !== 'unhealthy') {
        status = 'unhealthy';
      } else if (check.status === 'degraded' && status === 'healthy') {
        status = 'degraded';
      }
    }

    return {
      status,
      memoryCount,
      avgRetrievalTime: roundTo(avgRetrievalTime, 2),
      hitRate: roundTo(hitRate, 4),
      lastError: this._lastError ?? undefined,
      checks,
    };
  }

  _checkConfig() {
    if (!this._config.maxMemories || this._config.maxMemories < 1) {
      return { status: 'unhealthy', message: 'Invalid maxMemories config' };
    }
    return { status: 'healthy', message: 'Config valid' };
  }

  _checkBackendService() {
    return { status: 'healthy', message: this._sqliteStore ? 'SQLite attached' : 'In-memory only' };
  }

  _checkEmbeddingIndex() {
    let embeddingMismatch = 0;
    for (const [key] of this._memories) {
      const mem = this._memories.get(key);
      if (!mem) continue;
      if (this._embeddings.has(key) && !mem.embedding) {
        embeddingMismatch++;
      }
    }
    return {
      status: embeddingMismatch > 5 ? 'degraded' : 'healthy',
      message: embeddingMismatch > 0 ? embeddingMismatch + ' index mismatches' : 'Index consistent',
      mismatches: embeddingMismatch,
    };
  }

  _checkCorruptedRecords() {
    let corruptedCount = 0;
    for (const [, record] of this._memories) {
      if (!record.content || typeof record.content !== 'string' || !record.metadata || typeof record.metadata.confidence !== 'number') {
        corruptedCount++;
      }
    }
    return {
      status: corruptedCount > 0 ? 'degraded' : 'healthy',
      message: corruptedCount > 0 ? corruptedCount + ' corrupted records' : 'No corrupted records',
      corruptedCount,
    };
  }

  _checkExpiredMemories() {
    let expiredCount = 0;
    const now = Date.now();
    for (const [, record] of this._memories) {
      if (record.expiresAt && record.expiresAt < now && !record.stale) {
        expiredCount++;
      }
    }
    return {
      status: expiredCount > 10 ? 'degraded' : 'healthy',
      message: expiredCount > 0 ? expiredCount + ' uncleaned expired memories' : 'No expired memories',
      expiredCount,
    };
  }

  _checkDimensionConsistency() {
    if (!this._embeddingService || this._embeddings.size === 0) {
      return { status: 'healthy', message: 'No embedding service' };
    }
    const dimensions = new Set();
    for (const [, vec] of this._embeddings) {
      if (Array.isArray(vec)) dimensions.add(vec.length);
    }
    if (dimensions.size > 1) {
      return { status: 'unhealthy', message: dimensions.size + ' different embedding dimensions', dimensions: [...dimensions] };
    }
    const firstDim = dimensions.size > 0 ? [...dimensions][0] : null;
    return { status: 'healthy', message: firstDim !== null ? 'Consistent dimension: ' + firstDim : 'No dimensions recorded' };
  }

  _checkCapacity(memoryCount) {
    const utilization = this._config.maxMemories > 0 ? memoryCount / this._config.maxMemories : 0;
    return {
      status: utilization > 0.9 ? 'degraded' : 'healthy',
      message: roundTo(utilization * 100, 1) + '% utilized',
      utilization: roundTo(utilization, 4),
    };
  }

  /**
   * 获取状态栏摘要信息，用于仪表盘展示
   * @returns {object} 状态栏对象，包含totalMemories、categories、recentHits、avgConfidence、storageUsage字段
   */
  getStatusBar() {
    const categories = {};
    let totalConfidence = 0;
    let activeCount = 0;
    let storageBytes = 0;

    for (const [, record] of this._memories) {
      if (!record.stale) {
        activeCount++;
        const cat = record.metadata.category;
        categories[cat] = (categories[cat] ?? 0) + 1;
        totalConfidence += record.metadata.confidence;
        storageBytes += record.content.length * 2;
      }
    }

    return {
      totalMemories: this._memories.size,
      categories,
      recentHits: this._hitCount,
      avgConfidence: activeCount > 0 ? roundTo(totalConfidence / activeCount, 3) : 0,
      storageUsage: {
        bytes: storageBytes,
        kb: roundTo(storageBytes / 1024, 2),
        maxMemories: this._config.maxMemories,
        utilization: roundTo(this._memories.size / (this._config.maxMemories ?? 1), 4),
      },
    };
  }

  /**
   * 按前缀或标签使匹配的记忆失效（标记为stale）
   * @param {string} pattern - 键前缀或标签名
   * @returns {number} 被标记为失效的记忆数量
   */
  invalidate(pattern) {
    this.guardShutdown();
    if (!pattern) return 0;

    let count = 0;
    for (const [key, record] of this._memories) {
      if (key.startsWith(pattern)) {
        record.stale = true;
        record.updatedAt = Date.now();
        count++;
      } else if (record.metadata && Array.isArray(record.metadata.tags) && record.metadata.tags.includes(pattern)) {
        record.stale = true;
        record.updatedAt = Date.now();
        count++;
      }
    }

    if (this._eventBus) {
      safeCall(() => {
        this._eventBus.emit('brain-memory-invalidated', { pattern, count });
      }, 'BrainMemory', 'invalidate-event');
    }

    this.emit('memory-invalidated', { pattern, count });
    return count;
  }

  /**
   * 分页浏览记忆列表。融合OpenClaw Brain v1.2.0 BrainList功能，
   * 支持按页码、每页条数、类型过滤和优先级排序，解决大规模记忆库的查看效率问题。
   * @param {Object} [options] - 分页选项
   * @param {number} [options.page=1] - 页码（从1开始）
   * @param {number} [options.pageSize=20] - 每页条数（最大100）
   * @param {string} [options.category] - 按类型过滤
   * @param {string} [options.sortBy='updatedAt'] - 排序字段（updatedAt/createdAt/confidence/key）
   * @param {string} [options.sortOrder='desc'] - 排序方向（asc/desc）
   * @param {boolean} [options.includeStale=false] - 是否包含已失效的记忆
   * @returns {Object} 分页结果，包含items、total、page、pageSize、totalPages
   */
  listMemories(options) {
    this.guardShutdown();
    const opts = options ?? {};
    const page = Math.max(1, Math.floor(opts.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize) || 20));
    const category = opts.category;
    const sortBy = opts.sortBy || 'updatedAt';
    const sortOrder = opts.sortOrder === 'asc' ? 1 : -1;
    const includeStale = opts.includeStale === true;

    const items = [];
    for (const [key, record] of this._memories) {
      if (!includeStale && record.stale) continue;
      if (category && record.metadata.category !== category) continue;
      items.push({
        key,
        content: record.content,
        category: record.metadata.category,
        confidence: record.metadata.confidence,
        tags: record.metadata.tags ?? [],
        stale: record.stale,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    }

    items.sort((a, b) => {
      const va = a[sortBy];
      const vb = b[sortBy];
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sortOrder;
      return String(va).localeCompare(String(vb)) * sortOrder;
    });

    const total = items.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    return { items: pageItems, total, page, pageSize, totalPages };
  }

  /**
   * 对记忆记录应用时间衰减。融合OpenClaw Brain v1.2.0乘法衰减模型，
   * 从加法改为乘法，解决分数溢出问题，让记忆热度衰减更平滑、更合理。
   * @param {Object} record - 记忆记录
   * @param {number} baseScore - 基础分数
   * @returns {number} 衰减后的分数
   */
  _applyTimeDecay(record, baseScore) {
    if (!record.updatedAt) return baseScore;
    const ageMs = Date.now() - record.updatedAt;
    const ageDays = ageMs / 86400000;
    const decayMultiplier = Math.pow(TIME_DECAY_FACTOR_PER_DAY, ageDays);
    return baseScore * decayMultiplier;
  }

  /**
   * 生成Agent欢迎词。融合OpenClaw Brain v1.2.0欢迎仪式功能，
   * 读取最早记忆，计算陪伴天数，生成独一无二的诞生欢迎词，
   * 强化Agent与用户的情感连接。
   * @param {string} [agentName] - Agent名称
   * @returns {Object|null} 欢迎信息对象，包含message、companionDays、firstMemory、totalMemories；无记忆时返回null
   */
  generateWelcomeMessage(agentName) {
    this.guardShutdown();
    if (this._memories.size === 0) return null;

    let earliestRecord = null;
    let earliestTime = Infinity;
    for (const [, record] of this._memories) {
      if (record.stale) continue;
      if (record.createdAt < earliestTime) {
        earliestTime = record.createdAt;
        earliestRecord = record;
      }
    }

    if (!earliestRecord) return null;

    const now = Date.now();
    const companionDays = Math.floor((now - earliestTime) / 86400000);
    const name = agentName || 'Agent';

    const message = companionDays === 0
      ? name + '，欢迎来到这个世界！这是我们共同的第一天。'
      : name + '，你好！我们已经一起走过了' + companionDays + '天。从"' + (earliestRecord.content.slice(0, 50)) + '"开始，到现在的' + this._memories.size + '段记忆，每一段都是我们共同成长的印记。';

    return {
      message,
      companionDays,
      firstMemory: {
        key: earliestRecord.key,
        content: earliestRecord.content.slice(0, 200),
        createdAt: earliestRecord.createdAt,
        category: earliestRecord.metadata.category,
      },
      totalMemories: this._memories.size,
    };
  }

  _mergeSimilarEntries(batch, now) {
    let merged = 0;
    const mergedKeys = new Set();
    for (let i = 0; i < batch.length; i++) {
      const bi = batch[i];
      if (mergedKeys.has(bi.key) || !bi.embedding) continue;
      for (let j = i + 1; j < batch.length; j++) {
        const bj = batch[j];
        if (mergedKeys.has(bj.key) || !bj.embedding) continue;
        const sim = this._embeddingService.cosineSimilarity(
          bi.embedding,
          bj.embedding,
        );
        if (sim > this._config.similarityThreshold) {
          const metaI = bi.metadata ?? {};
          const metaJ = bj.metadata ?? {};
          const keeper = (metaI.confidence ?? 0) >= (metaJ.confidence ?? 0) ? bi : bj;
          const removed = keeper === bi ? bj : bi;
          const keeperMeta = keeper.metadata ?? {};
          const removedMeta = removed.metadata ?? {};
          keeper.metadata = {
            ...keeperMeta,
            tags: [...new Set([...(keeperMeta.tags ?? []), ...(removedMeta.tags ?? [])])],
            confidence: Math.max(keeperMeta.confidence ?? 0, removedMeta.confidence ?? 0),
          };
          keeper.updatedAt = now;
          mergedKeys.add(removed.key);
          merged++;
        }
      }
    }
    return { merged, mergedKeys };
  }

  /**
   * 执行记忆整合：移除过期和失效记忆，合并高相似度记忆，重建倒排索引
   * @returns {{merged: number, expired: number, staleRemoved: number}} 整合结果对象，包含merged(合并数)、expired(过期数)、staleRemoved(失效移除数)
   */
  consolidate() {
    this.guardShutdown();
    const now = Date.now();
    let merged = 0;
    let expired = 0;
    let staleRemoved = 0;

    const toDelete = [];
    for (const [key, record] of this._memories) {
      if (record.stale) {
        toDelete.push(key);
        staleRemoved++;
        continue;
      }
      if (record.expiresAt && now > record.expiresAt) {
        toDelete.push(key);
        expired++;
      }
    }
    for (const key of toDelete) {
      this._removeFromIndex(this._memories.get(key));
      this._memories.delete(key);
      this._embeddings.delete(key);
    }

    if (this._embeddingService) {
      const activeEntries = [];
      for (const [, record] of this._memories) {
        if (!record.stale && record.embedding) {
          activeEntries.push(record);
        }
      }

      const MAX_CONSOLIDATION_BATCH = 200;
      const batch = activeEntries.length > MAX_CONSOLIDATION_BATCH
        ? activeEntries.slice(0, MAX_CONSOLIDATION_BATCH)
        : activeEntries;

      const result = this._mergeSimilarEntries(batch, now);
      merged = result.merged;

      for (const key of result.mergedKeys) {
        this._removeFromIndex(this._memories.get(key));
        this._memories.delete(key);
        this._embeddings.delete(key);
      }
    }

    this._rebuildIndex();

    if (this._eventBus) {
      safeCall(() => {
        this._eventBus.emit('brain-memory-consolidated', { merged, expired, staleRemoved });
      }, 'BrainMemory', 'consolidate-event');
    }

    this.emit('memory-consolidated', { merged, expired, staleRemoved });
    return { merged, expired, staleRemoved };
  }

  _computeTfIdf(query, content) {
    const tokenize = (text) => {
      if (!text) return [];
      return text.toLowerCase()
        .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 0);
    };

    const queryTokens = tokenize(query);
    const contentTokens = tokenize(content);
    if (queryTokens.length === 0 || contentTokens.length === 0) return 0;

    const contentFreq = new Map();
    for (const token of contentTokens) {
      contentFreq.set(token, (contentFreq.get(token) ?? 0) + 1);
    }

    const maxFreq = [...contentFreq.values()].filter(v => Number.isFinite(v)).reduce((a, b) => Math.max(a, b), 1);

    let score = 0;
    for (const token of queryTokens) {
      const tf = (contentFreq.get(token) ?? 0) / maxFreq;
      const df = this._documentFreq.get(token) ?? 1;
      const idf = Math.log((this._totalDocuments + 1) / (df + 1)) + 1;
      score += tf * idf;
    }

    return queryTokens.length > 0 ? score / queryTokens.length : 0;
  }

  /**
   * 获取脑记忆的统计信息
   * @returns {object} 统计对象，包含totalMemories、activeMemories、staleMemories、categories、avgConfidence、hitRate、totalRetrievals、avgRetrievalTime、embeddingService、sqliteStore、eventBus、config字段
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('BrainMemory', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalMemories: 0, activeMemories: 0, staleMemories: 0, categories: {}, avgConfidence: 0, hitRate: 0, totalRetrievals: 0, avgRetrievalTime: 0, embeddingService: 'none', sqliteStore: 'none', eventBus: 'none', config: {} }; }
    const categories = {};
    let totalConfidence = 0;
    let staleCount = 0;
    const now = Date.now();
    let earliestTime = Infinity;
    let latestTime = 0;
    let totalAgeMs = 0;
    const hotMemories = [];

    for (const [, record] of this._memories) {
      const cat = record.metadata.category;
      categories[cat] = (categories[cat] ?? 0) + 1;
      totalConfidence += record.metadata.confidence;
      if (record.stale) staleCount++;
      // 融合OpenClaw Brain v1.2.0 BrainMemoryStats：时间范围和平均年龄
      if (record.createdAt) {
        if (record.createdAt < earliestTime) earliestTime = record.createdAt;
        if (record.createdAt > latestTime) latestTime = record.createdAt;
        totalAgeMs += now - record.createdAt;
      }
      // 融合OpenClaw Brain v1.2.0 BrainMemoryStats：热度排名（基于检索命中+置信度）
      hotMemories.push({ key: record.key, confidence: record.metadata.confidence, category: cat, updatedAt: record.updatedAt });
    }

    // 按置信度排序取Top5最热记忆
    hotMemories.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const topHotMemories = hotMemories.slice(0, 5).map(m => ({ key: m.key, confidence: roundTo(m.confidence, 3), category: m.category }));

    const totalRetrievals = this._hitCount + this._missCount;
    const avgRetrievalTime = this._retrievalTimes.length > 0
      ? this._retrievalTimes.reduce((a, b) => a + b, 0) / this._retrievalTimes.length
      : 0;

    const memoryCount = this._memories.size;
    return {
      totalMemories: memoryCount,
      activeMemories: memoryCount - staleCount,
      staleMemories: staleCount,
      categories,
      avgConfidence: memoryCount > 0
        ? roundTo(totalConfidence / memoryCount, 3)
        : 0,
      hitRate: totalRetrievals > 0 ? roundTo(this._hitCount / totalRetrievals, 4) : 0,
      totalRetrievals,
      avgRetrievalTime: roundTo(avgRetrievalTime, 2),
      // 融合OpenClaw Brain v1.2.0 BrainMemoryStats增强字段
      topHotMemories,
      timeRange: memoryCount > 0 ? {
        earliest: earliestTime === Infinity ? null : new Date(earliestTime).toISOString(),
        latest: latestTime === 0 ? null : new Date(latestTime).toISOString(),
      } : null,
      avgAgeDays: memoryCount > 0 ? roundTo(totalAgeMs / memoryCount / 86400000, 2) : 0,
      embeddingService: this._embeddingService ? 'attached' : 'none',
      sqliteStore: this._sqliteStore ? 'attached' : 'none',
      eventBus: this._eventBus ? 'attached' : 'none',
      config: { ...this._config },
    };
  }

  /**
   * 附加SQLite存储实例，用于持久化记忆记录
   * @param {object|null} store - SQLite存储实例
   * @returns {BrainMemory} 返回this以支持链式调用
   */
  attachSqliteStore(store) {
    this.guardShutdown();
    this._sqliteStore = store ?? null;
    return this;
  }

  /**
   * 附加嵌入服务实例，用于语义检索和记忆整合，附加后自动启动整合定时器
   * @param {object|null} service - 嵌入服务实例，需提供embed和cosineSimilarity方法
   * @returns {BrainMemory} 返回this以支持链式调用
   */
  attachEmbeddingService(service) {
    this.guardShutdown();
    this._embeddingService = service ?? null;
    if (!this._consolidationTimerStarted && this._embeddingService) {
      this._consolidationTimerStarted = true;
      this._startConsolidationTimer();
    }
    return this;
  }

  /**
   * 附加事件总线实例，用于发布记忆存储、检索、失效、整合等事件
   * @param {object|null} bus - 事件总线实例，需提供emit方法
   * @returns {BrainMemory} 返回this以支持链式调用
   */
  attachEventBus(bus) {
    this.guardShutdown();
    this._eventBus = bus ?? null;
    return this;
  }

  _embedContent(key, content, record) {
    if (!this._embeddingService) return;
    if (record._embeddingPending) return;
    record._embeddingPending = true;
    if (this._embeddings.size >= this._config.maxMemories) {
      if (!this._evicting) {
        this._evicting = true;
        try {
          const oldestKey = this._embeddings.keys().next().value;
          if (oldestKey) this._embeddings.delete(oldestKey);
        } finally {
          this._evicting = false;
        }
      }
    }
    try {
      const vector = this._embeddingService.embed(content);
      if (vector && typeof vector.then === 'function') {
        vector.then(function(v) {
          try {
            if (this._shutDown) { record._embeddingPending = false; return; }
            const current = this._memories.get(key);
            if (current !== record) { record._embeddingPending = false; return; }
            if (!this._memories.has(key)) { record._embeddingPending = false; return; }
            record.embedding = v;
            record._embeddingPending = false;
            if (this._embeddings.size >= this._config.maxMemories) {
              if (!this._evicting) {
                this._evicting = true;
                try {
                  const oldestKey = this._embeddings.keys().next().value;
                  if (oldestKey) this._embeddings.delete(oldestKey);
                } finally {
                  this._evicting = false;
                }
              }
            }
            this._embeddings.set(key, v);
          } catch (cbErr) {
            debug('BrainMemory', 'embedding-callback', cbErr);
          }
        }.bind(this)).catch(function(e) {
          if (this._shutDown) { record._embeddingPending = false; return; }
          const errMsg = e && e.message ? e.message : String(e);
          debug('BrainMemory', '_embedContent', 'Embedding failed for ' + key + ': ' + errMsg);
          record._embeddingPending = false;
          this._lastError = e;
          this.emit('embedding-error', { key, error: errMsg });
        });
      } else if (vector) {
        record.embedding = vector;
        record._embeddingPending = false;
        this._embeddings.set(key, vector);
      } else {
        record._embeddingPending = false;
      }
    } catch (e) {
      record._embeddingPending = false;
      const errMsg = e && e.message ? e.message : String(e);
      debug('BrainMemory', '_embedContent', 'Embedding failed: ' + errMsg);
      this._lastError = e;
      this.emit('embedding-error', { key, error: errMsg });
    }
  }

  _persistRecord(record) {
    if (!this._sqliteStore) return;
    safeCall(() => {
      this._sqliteStore.addMemory('brain', safeStringify({
        key: record.key,
        content: record.content,
        metadata: record.metadata,
        stale: false,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      }), { tier: 'semantic', importance: record.metadata.confidence });
    }, 'BrainMemory', 'store-persist');
  }

  _notifyStored(key, record) {
    if (!this._eventBus) return;
    safeCall(() => {
      this._eventBus.emit('brain-memory-stored', { key, category: record.metadata.category });
    }, 'BrainMemory', 'store-event');
  }

  _retrieveKeyword(query, candidates) {
    const results = [];
    for (const record of candidates) {
      const contentScore = this._computeTfIdf(query, record.content);
      const tagText = (record.metadata.tags ?? []).join(' ');
      const tagScore = tagText ? this._computeTfIdf(query, tagText) * 0.5 : 0;
      const score = contentScore + tagScore;
      if (score > 0) {
        results.push({
          key: record.key,
          content: record.content,
          metadata: { ...record.metadata, tags: [...(record.metadata.tags ?? [])] },
          score,
          mode: 'keyword',
        });
      }
    }
    return results;
  }

  _retrieveSemantic(query, candidates) {
    if (!this._embeddingService) return [];
    const results = [];

    let queryVector;
    try {
      queryVector = this._embeddingService.embed(query);
    } catch (e) {
      const errMsg = e && e.message ? e.message : String(e);
      debug('BrainMemory', '_retrieveSemantic', 'Query embedding failed: ' + errMsg);
      this._lastError = e;
      this.emit('retrieval-error', { query, error: errMsg });
      return [];
    }

    if (!queryVector) return [];

    if (typeof queryVector.then === 'function') {
      debug('BrainMemory', '_retrieveSemantic', 'Async embedding not supported in sync context');
      return [];
    }

    for (const record of candidates) {
      if (record._embeddingPending) continue;
      const recordVector = this._embeddings.get(record.key) ?? record.embedding;
      if (!recordVector) continue;
      const similarity = this._embeddingService.cosineSimilarity(queryVector, recordVector);
      if (similarity > 0) {
        results.push({
          key: record.key,
          content: record.content,
          metadata: { ...record.metadata, tags: [...(record.metadata.tags ?? [])] },
          score: similarity,
          mode: 'semantic',
        });
      }
    }
    return results;
  }

  _fuseResults(keywordResults, semanticResults) {
    const fused = new Map();

    for (const r of keywordResults) {
      const existing = fused.get(r.key);
      const score = r.score * KEYWORD_WEIGHT;
      if (existing) {
        existing.score += score;
        existing.modes.push('keyword');
      } else {
        fused.set(r.key, {
          key: r.key,
          content: r.content,
          metadata: r.metadata,
          score,
          mode: 'hybrid',
          modes: ['keyword'],
        });
      }
    }

    for (const r of semanticResults) {
      const existing = fused.get(r.key);
      const score = r.score * SEMANTIC_WEIGHT;
      if (existing) {
        existing.score += score;
        existing.modes.push('semantic');
      } else {
        fused.set(r.key, {
          key: r.key,
          content: r.content,
          metadata: r.metadata,
          score,
          mode: 'hybrid',
          modes: ['semantic'],
        });
      }
    }

    return Array.from(fused.values());
  }

  _addToIndex(record) {
    this._totalDocuments++;
    const tokens = this._tokenize(record.content);
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      this._documentFreq.set(token, (this._documentFreq.get(token) ?? 0) + 1);
    }
    const tagTokens = this._tokenize((record.metadata.tags ?? []).join(' '));
    const uniqueTagTokens = new Set(tagTokens);
    for (const token of uniqueTagTokens) {
      this._documentFreq.set(token, (this._documentFreq.get(token) ?? 0) + 1);
    }
    this._trimDocumentFreq();
  }

  _removeFromIndex(record) {
    if (!record) return;
    if (this._totalDocuments > 0) this._totalDocuments--;
    const tokens = this._tokenize(record.content);
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      const freq = this._documentFreq.get(token);
      if (freq && freq > 1) {
        this._documentFreq.set(token, freq - 1);
      } else {
        this._documentFreq.delete(token);
      }
    }
    const tagTokens = this._tokenize((record.metadata.tags ?? []).join(' '));
    const uniqueTagTokens = new Set(tagTokens);
    for (const token of uniqueTagTokens) {
      const freq = this._documentFreq.get(token);
      if (freq && freq > 1) {
        this._documentFreq.set(token, freq - 1);
      } else {
        this._documentFreq.delete(token);
      }
    }
  }

  _trimDocumentFreq() {
    const maxTokens = this._config.maxDocumentFreqTokens;
    if (this._documentFreq.size <= maxTokens) return;
    const entries = [];
    for (const [token, freq] of this._documentFreq) {
      entries.push({ token, freq });
    }
    entries.sort((a, b) => a.freq - b.freq);
    const toRemove = this._documentFreq.size - maxTokens;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      this._documentFreq.delete(entries[i].token);
    }
  }

  _rebuildIndex() {
    this._documentFreq.clear();
    this._totalDocuments = 0;
    for (const [, record] of this._memories) {
      this._addToIndex(record);
    }
  }

  _tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 0);
  }

  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, record] of this._memories) {
      if (record.stale) {
        oldestKey = key;
        break;
      }
      if (record.updatedAt < oldestTime) {
        oldestTime = record.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this._removeFromIndex(this._memories.get(oldestKey));
      this._memories.delete(oldestKey);
      this._embeddings.delete(oldestKey);
    }
  }

  _startConsolidationTimer() {
    if (this._consolidationTimer) clearInterval(this._consolidationTimer);
    const interval = typeof this._config.consolidationInterval === 'number' && Number.isFinite(this._config.consolidationInterval) ? this._config.consolidationInterval : 300000;
    if (interval > 0) {
      this._consolidationTimer = setInterval(() => {
        if (this._shutDown) return;
        safeCall(() => this.consolidate(), 'BrainMemory', 'auto-consolidate');
      }, interval);
      if (this._consolidationTimer && typeof this._consolidationTimer.unref === 'function') {
        this._consolidationTimer.unref();
      }
    }
  }

  _onShutdown() {
    if (this._consolidationTimer) {
      clearInterval(this._consolidationTimer);
      this._consolidationTimer = null;
    }

    if (this._sqliteStore) {
      let persisted = 0;
      let failed = 0;
      for (const [, record] of this._memories) {
        try {
          this._sqliteStore.addMemory('brain', safeStringify({
            key: record.key,
            content: record.content,
            metadata: record.metadata,
            stale: record.stale,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
          }), { tier: 'semantic', importance: record.metadata.confidence });
          persisted++;
        } catch (e) {
          failed++;
          if (failed <= 3) debug('BrainMemory', 'shutdown-persist', 'Failed for key ' + record.key + ': ' + (e && e.message ? e.message : String(e)));
        }
      }
      if (persisted > 0 || failed > 0) {
        debug('BrainMemory', 'shutdown-persist', 'Persisted ' + persisted + ' memories, ' + failed + ' failed');
      }
    }

    this._memories.clear();
    this._embeddings.clear();
    this._documentFreq.clear();
    this._retrievalTimes = [];
    this._consolidationTimerStarted = false;
    this._sqliteStore = null;
    this._embeddingService = null;
    this._eventBus = null;
    this._hitCount = 0;
    this._missCount = 0;
    this._lastError = null;
    this.removeAllListeners();
  }
}

BrainMemory.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(BrainMemory);
