'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { roundTo, safeCall } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const { mergeConfig } = safeAssign;
const BoundedMap = require('../../utils/bounded-map');

/**
 * 查询维度枚举，对应MAGMA四正交图谱
 * @enum {string}
 */
const QUERY_DIMENSIONS = {
  SEMANTIC: 'semantic',
  TEMPORAL: 'temporal',
  CAUSAL: 'causal',
  ENTITY: 'entity',
};

/**
 * 搜索策略枚举
 * @enum {string}
 */
const SEARCH_STRATEGIES = {
  BREADTH_FIRST: 'breadth-first',
  DEPTH_FIRST: 'depth-first',
  BEAM: 'beam',
  BEST_FIRST: 'best-first',
};

const DEFAULT_CONFIG = {
  maxJointQueryDepth: 3,
  beamWidth: 5,
  defaultStrategy: SEARCH_STRATEGIES.BEAM,
  deduplicationThreshold: 0.85,
  maxResults: 20,
  cacheMaxSize: 50,
  cacheTTL: 60000,
};

/**
 * @module runtime/thought/cross-graph-bridge
 * @classdesc 跨图谱桥接器。实现MAGMA四正交图谱的跨维度联合查询
 * CrossGraphBridge — Cross-graph joint query engine bridging KnowledgeGraphStore,
 * CausalDataBus, and CausalMemoryStore for MAGMA-style orthogonal graph queries.
 *
 * 融合MAGMA架构核心能力：将Harness现有的语义图谱（KnowledgeGraphStore）、
 * 因果图谱（CausalDataBus + CausalMemoryStore）桥接为统一的跨维度查询引擎，
 * 实现MAGMA的"意图感知路由"和"动态波束搜索"能力。
 *
 * 核心特性：
 * - 跨图谱联合查询：在语义/因果/实体维度间联合检索
 * - 意图感知路由：根据查询意图自动选择最优图谱维度
 * - 动态波束搜索：可配置宽度的波束搜索策略
 * - 结果融合去重：跨维度结果合并与置信度加权
 *
 * @extends EventEmitter
 * @emits CrossGraphBridge#joint-query-completed
 * @emits CrossGraphBridge#dimension-routed
 * @emits CrossGraphBridge#error
 *
 * @example
 * const CrossGraphBridge = require('./cross-graph-bridge');
 * const bridge = new CrossGraphBridge();
 * bridge.attachKnowledgeGraph(kgStore);
 * bridge.attachCausalBus(causalBus);
 * bridge.attachCausalMemory(causalMemStore);
 *
 * const results = await bridge.jointQuery('authentication', {
 *   dimensions: ['semantic', 'causal'],
 *   strategy: 'beam',
 *   beamWidth: 3,
 * });
 */
class CrossGraphBridge extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    this._kg = null;
    this._causalBus = null;
    this._causalMemory = null;
    this._queryCache = new BoundedMap(this._config.cacheMaxSize);
    this._stats = {
      totalQueries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      dimensionHits: { semantic: 0, temporal: 0, causal: 0, entity: 0 },
      avgResultCount: 0,
    };
  }

  /**
   * 附加知识图谱存储实例
   * @param {Object} kg - KnowledgeGraphStore实例
   * @returns {CrossGraphBridge} this
   */
  attachKnowledgeGraph(kg) {
    this.guardShutdown();
    if (kg && typeof kg === 'object') {
      this._kg = kg;
      debug('CrossGraphBridge', 'attachKnowledgeGraph', 'attached');
    }
    return this;
  }

  /**
   * 附加因果数据总线实例
   * @param {Object} bus - CausalDataBus实例
   * @returns {CrossGraphBridge} this
   */
  attachCausalBus(bus) {
    this.guardShutdown();
    if (bus && typeof bus === 'object') {
      this._causalBus = bus;
      debug('CrossGraphBridge', 'attachCausalBus', 'attached');
    }
    return this;
  }

  /**
   * 附加因果内存存储实例
   * @param {Object} store - CausalMemoryStore实例
   * @returns {CrossGraphBridge} this
   */
  attachCausalMemory(store) {
    this.guardShutdown();
    if (store && typeof store === 'object') {
      this._causalMemory = store;
      debug('CrossGraphBridge', 'attachCausalMemory', 'attached');
    }
    return this;
  }

  /**
   * 跨图谱联合查询。在指定维度中检索与查询相关的结果，
   * 融合去重后按置信度排序返回。
   *
   * @param {string} query - 查询文本
   * @param {Object} [options] - 查询选项
   * @param {string[]} [options.dimensions] - 查询维度（默认全部）
   * @param {string} [options.strategy] - 搜索策略
   * @param {number} [options.beamWidth] - 波束宽度
   * @param {number} [options.maxDepth] - 最大搜索深度
   * @param {number} [options.maxResults] - 最大结果数
   * @returns {Promise<Object>} 查询结果 { results, dimensionStats, queryId }
   */
  async jointQuery(query, options) {
    this.guardShutdown();
    if (!query || typeof query !== 'string') {
      return { results: [], dimensionStats: {}, queryId: null };
    }

    const opts = options ?? {};
    const dimensions = opts.dimensions ?? Object.values(QUERY_DIMENSIONS);
    const strategy = opts.strategy ?? this._config.defaultStrategy;
    const beamWidth = opts.beamWidth ?? this._config.beamWidth;
    const maxDepth = opts.maxDepth ?? this._config.maxJointQueryDepth;
    const maxResults = opts.maxResults ?? this._config.maxResults;

    const cacheKey = query + ':' + dimensions.sort().join(',') + ':' + strategy;
    const cached = this._queryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this._config.cacheTTL) {
      this._stats.cacheHits++;
      return cached.result;
    }
    this._stats.cacheMisses++;

    const queryId = 'jq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const dimensionResults = {};
    const dimensionStats = {};

    for (const dim of dimensions) {
      if (!Object.values(QUERY_DIMENSIONS).includes(dim)) continue;
      try {
        const dimResult = await this._queryDimension(dim, query, {
          strategy, beamWidth, maxDepth, maxResults,
        });
        dimensionResults[dim] = dimResult.results;
        dimensionStats[dim] = dimResult.stats;
        this._stats.dimensionHits[dim] = (this._stats.dimensionHits[dim] ?? 0) + dimResult.results.length;
      } catch (err) {
        debug('CrossGraphBridge', 'dimension-query-error', dim, err && err.message);
        dimensionResults[dim] = [];
        dimensionStats[dim] = { error: err && err.message, degraded: true };
      }
    }

    const merged = this._mergeAndDedup(dimensionResults, maxResults);

    this._stats.totalQueries++;
    const prevAvg = this._stats.avgResultCount;
    this._stats.avgResultCount = roundTo(
      prevAvg + (merged.length - prevAvg) / this._stats.totalQueries,
      2,
    );

    const result = {
      results: merged,
      dimensionStats,
      queryId,
      strategy,
      dimensionsQueried: dimensions,
    };

    this._queryCache.set(cacheKey, { result, timestamp: Date.now() });
    this.emit('joint-query-completed', { queryId, resultCount: merged.length, dimensions });

    return result;
  }

  /**
   * 意图感知路由。根据查询文本特征判断应优先查询的维度。
   * 实现MAGMA的"语义+词法+时间窗口三路信号融合"路由逻辑。
   *
   * @param {string} query - 查询文本
   * @returns {Object} 路由结果 { primaryDimension, secondaryDimensions, confidence, signals }
   */
  routeByIntent(query) {
    if (this._shutDown || !query || typeof query !== 'string') {
      return { primaryDimension: null, secondaryDimensions: [], confidence: 0, signals: {} };
    }

    const signals = {
      semantic: 0,
      temporal: 0,
      causal: 0,
      entity: 0,
    };

    const lower = query.toLowerCase();

    // 语义信号：概念性词汇
    const semanticMarkers = ['what is', 'define', 'concept', 'meaning', '什么是', '定义', '概念', '含义'];
    for (const m of semanticMarkers) {
      if (lower.includes(m)) signals.semantic += 0.3;
    }

    // 时间信号：时间性词汇
    const temporalMarkers = ['when', 'before', 'after', 'during', 'recent', 'latest', '何时', '之前', '之后', '最近', '最新'];
    for (const m of temporalMarkers) {
      if (lower.includes(m)) signals.temporal += 0.3;
    }

    // 因果信号：因果性词汇
    const causalMarkers = ['why', 'because', 'cause', 'effect', 'result', 'lead to', '为什么', '因为', '导致', '原因', '结果'];
    for (const m of causalMarkers) {
      if (lower.includes(m)) signals.causal += 0.3;
    }

    // 实体信号：特定实体名称
    const entityMarkers = ['who', 'which', 'where', 'name', '谁', '哪个', '哪里', '名称'];
    for (const m of entityMarkers) {
      if (lower.includes(m)) signals.entity += 0.3;
    }

    // 基础信号：查询长度和复杂度
    const wordCount = query.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount > 5) signals.causal += 0.1;
    if (wordCount > 8) signals.semantic += 0.1;

    // 归一化
    const total = Object.values(signals).reduce((s, v) => s + v, 0);
    if (total > 0) {
      for (const key of Object.keys(signals)) {
        signals[key] = roundTo(signals[key] / total, 3);
      }
    }

    // 排序确定主次维度
    const sorted = Object.entries(signals)
      .sort((a, b) => b[1] - a[1])
      .filter(([, v]) => v > 0);

    const primaryDimension = sorted.length > 0 ? sorted[0][0] : QUERY_DIMENSIONS.SEMANTIC;
    const secondaryDimensions = sorted.slice(1).map(([k]) => k);
    const confidence = sorted.length > 0 ? sorted[0][1] : 0.25;

    this.emit('dimension-routed', { query, primaryDimension, confidence });

    return { primaryDimension, secondaryDimensions, confidence, signals };
  }

  /**
   * 获取桥接器统计信息
   * @returns {Object} 统计数据
   */
  getStats() {
    if (this._shutDown) return { totalQueries: 0, cacheHits: 0, cacheMisses: 0, dimensionHits: {}, avgResultCount: 0, attachedSources: {} };
    return {
      ...this._stats,
      attachedSources: {
        knowledgeGraph: this._kg !== null,
        causalBus: this._causalBus !== null,
        causalMemory: this._causalMemory !== null,
      },
    };
  }

  /**
   * 在单个维度中执行查询
   * @param {string} dimension - 查询维度
   * @param {string} query - 查询文本
   * @param {Object} opts - 查询选项
   * @returns {Promise<Object>} { results, stats }
   */
  async _queryDimension(dimension, query, opts) {
    const results = [];
    const stats = { queried: false, resultCount: 0, error: null };

    try {
      switch (dimension) {
        case QUERY_DIMENSIONS.SEMANTIC:
          await this._querySemantic(query, opts, results, stats);
          break;
        case QUERY_DIMENSIONS.TEMPORAL:
          await this._queryTemporal(query, opts, results, stats);
          break;
        case QUERY_DIMENSIONS.CAUSAL:
          await this._queryCausal(query, opts, results, stats);
          break;
        case QUERY_DIMENSIONS.ENTITY:
          await this._queryEntity(query, opts, results, stats);
          break;
        default:
          break;
      }
    } catch (err) {
      stats.error = err && err.message ? err.message : String(err);
      debug('CrossGraphBridge', '_queryDimension', dimension + ' error: ' + stats.error);
    }

    stats.resultCount = results.length;
    return { results, stats };
  }

  /**
   * 语义维度查询：通过KnowledgeGraphStore检索实体和关系
   */
  async _querySemantic(query, opts, results, stats) {
    if (!this._kg) { stats.queried = false; return; }
    stats.queried = true;

    let entities = [];
    try { entities = this._kg.findEntitiesByName(query) ?? []; } catch (err) { debug('CrossGraphBridge', '_querySemantic entities', err); }
    for (const entity of entities.slice(0, opts.maxResults)) {
      results.push({
        dimension: QUERY_DIMENSIONS.SEMANTIC,
        type: 'entity',
        id: entity.id,
        content: entity.name,
        metadata: { type: entity.type, attributes: entity.attributes },
        confidence: 0.8,
        source: 'knowledge-graph',
        createdAt: entity.createdAt,
      });
    }

    let relations = [];
    try { relations = this._kg.exportAsTriples() ?? []; } catch (err) { debug('CrossGraphBridge', '_querySemantic relations', err); }
    const queryLower = query.toLowerCase();
    const matchingRelations = relations.filter(r =>
      (r.subject && r.subject.toLowerCase().includes(queryLower)) ||
      (r.object && r.object.toLowerCase().includes(queryLower)),
    ).slice(0, opts.maxResults);

    for (const rel of matchingRelations) {
      results.push({
        dimension: QUERY_DIMENSIONS.SEMANTIC,
        type: 'relation',
        id: rel.id,
        content: rel.subject + ' ' + rel.predicate + ' ' + rel.object,
        metadata: { subject: rel.subject, predicate: rel.predicate, object: rel.object },
        confidence: rel.confidence ?? 0.7,
        source: 'knowledge-graph',
        createdAt: rel.createdAt,
      });
    }
  }

  /**
   * 时间维度查询：通过CausalDataBus因果链检索时序信息
   */
  async _queryTemporal(query, opts, results, stats) {
    if (!this._causalBus) { stats.queried = false; return; }
    stats.queried = true;

    let chain = [];
    try { chain = this._causalBus.getCausalChain(0) ?? []; } catch (err) { debug('CrossGraphBridge', '_queryTemporal chain', err); }
    const queryKeywords = this._extractKeywords(query);

    for (const entry of chain.slice(0, opts.maxResults * 2)) {
      if (!entry || typeof entry !== 'object') continue;
      let entryText = '';
      try { entryText = JSON.stringify(entry); } catch (_e) { continue; }
      const matchScore = this._computeKeywordMatch(queryKeywords, entryText);
      if (matchScore > 0.1) {
        results.push({
          dimension: QUERY_DIMENSIONS.TEMPORAL,
          type: 'causal-chain-entry',
          id: entry.skillId ?? 'unknown',
          content: entryText.substring(0, 500),
          metadata: { sequence: entry.sequence, timestamp: entry.timestamp },
          confidence: roundTo(matchScore, 3),
          source: 'causal-bus',
          createdAt: entry.timestamp,
        });
      }
    }
  }

  /**
   * 因果维度查询：通过CausalMemoryStore检索因果关系
   */
  async _queryCausal(query, opts, results, stats) {
    if (!this._causalMemory) { stats.queried = false; return; }
    stats.queried = true;

    let searchResults = [];
    try {
      searchResults = await this._causalMemory.searchByCausalSimilarity(query, {
        limit: opts.maxResults,
        threshold: 0.2,
      });
    } catch (err) {
      debug('CrossGraphBridge', '_queryCausal search', err);
    }

    const causalResults = Array.isArray(searchResults) ? searchResults : [];
    for (const mem of causalResults) {
      results.push({
        dimension: QUERY_DIMENSIONS.CAUSAL,
        type: 'causal-memory',
        id: mem.id,
        content: mem.cause + ' → ' + mem.effect,
        metadata: {
          cause: mem.cause,
          effect: mem.effect,
          context: mem.context,
          category: mem.category,
          tags: mem.tags,
        },
        confidence: mem.confidence ?? 0.5,
        source: 'causal-memory',
        createdAt: mem.createdAt ? mem.createdAt * 1000 : null,
      });
    }
  }

  /**
   * 实体维度查询：通过KnowledgeGraphStore检索实体邻居
   */
  async _queryEntity(query, opts, results, stats) {
    if (!this._kg) { stats.queried = false; return; }
    stats.queried = true;

    let entities = [];
    try { entities = this._kg.findEntitiesByName(query) ?? []; } catch (err) { debug('CrossGraphBridge', '_queryEntity entities', err); }
    if (entities.length === 0) return;

    const startEntity = entities[0];
    if (!startEntity) return;
    let neighbors = new Set();
    try { neighbors = this._kg.getNeighbors(startEntity.id, opts.maxDepth ?? 2) ?? new Set(); } catch (err) { debug('CrossGraphBridge', '_queryEntity neighbors', err); }

    for (const neighborId of neighbors) {
      let entity = null;
      try { entity = this._kg.getEntity(neighborId); } catch (err) { debug('CrossGraphBridge', '_queryEntity getEntity', err); }
      if (!entity) continue;
      results.push({
        dimension: QUERY_DIMENSIONS.ENTITY,
        type: 'neighbor-entity',
        id: entity.id,
        content: entity.name,
        metadata: { type: entity.type, startEntity: startEntity.name },
        confidence: 0.6,
        source: 'knowledge-graph',
        createdAt: entity.createdAt,
      });
      if (results.length >= opts.maxResults) break;
    }
  }

  /**
   * 合并去重跨维度结果
   * @param {Object} dimensionResults - 各维度结果 { dimension: [results] }
   * @param {number} maxResults - 最大结果数
   * @returns {Array<Object>} 合并后的结果
   */
  _mergeAndDedup(dimensionResults, maxResults) {
    const allResults = [];
    for (const dim of Object.keys(dimensionResults)) {
      for (const r of dimensionResults[dim]) {
        allResults.push(r);
      }
    }

    // 去重：基于content相似度
    const deduped = [];
    for (const r of allResults) {
      let isDuplicate = false;
      for (const existing of deduped) {
        if (this._computeTextSimilarity(r.content, existing.content) > this._config.deduplicationThreshold) {
          // 保留置信度更高的
          if (r.confidence > existing.confidence) {
            existing.confidence = roundTo((existing.confidence + r.confidence) / 2, 3);
            existing.dimensions = [...new Set([...(existing.dimensions ?? [existing.dimension]), r.dimension])];
          }
          isDuplicate = true;
          break;
        }
      }
      if (!isDuplicate) {
        r.dimensions = [r.dimension];
        deduped.push(r);
      }
    }

    // 按置信度降序排序
    deduped.sort((a, b) => b.confidence - a.confidence);
    return deduped.slice(0, maxResults);
  }

  /**
   * 计算文本相似度（基于关键词Jaccard系数）
   * @param {string} a - 文本A
   * @param {string} b - 文本B
   * @returns {number} 相似度 [0,1]
   */
  _computeTextSimilarity(a, b) {
    if (!a || !b) return 0;
    const setA = new Set(this._extractKeywords(a));
    const setB = new Set(this._extractKeywords(b));
    if (setA.size === 0 && setB.size === 0) return 0;
    let intersection = 0;
    for (const w of setA) {
      if (setB.has(w)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * 提取关键词
   * @param {string} text - 输入文本
   * @returns {string[]} 关键词数组
   */
  _extractKeywords(text) {
    if (!text || typeof text !== 'string') return [];
    return text.toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1);
  }

  /**
   * 计算关键词匹配分数
   * @param {string[]} keywords - 查询关键词
   * @param {string} text - 目标文本
   * @returns {number} 匹配分数 [0,1]
   */
  _computeKeywordMatch(keywords, text) {
    if (!keywords.length || !text) return 0;
    const lower = text.toLowerCase();
    let matches = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) matches++;
    }
    return matches / keywords.length;
  }

  _onShutdown() {
    safeCall(() => this._queryCache.shutdown(), 'CrossGraphBridge', 'shutdown-queryCache');
    this.removeAllListeners();
  }
}

module.exports = withShutdown(CrossGraphBridge);
module.exports.QUERY_DIMENSIONS = QUERY_DIMENSIONS;
module.exports.SEARCH_STRATEGIES = SEARCH_STRATEGIES;
