'use strict';

/** @module runtime/search/evolving-search-engine */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const BoundedMap = require('../../utils/bounded-map');
const { debug } = require('../../utils/debug-logger');
const { SirchnunkMcpAdapter, SEARCH_MODES } = require('./sirchnunk-mcp-adapter');
const { KnowledgeClusterStore, CLUSTER_CATEGORIES } = require('./knowledge-cluster-store');

const SEARCH_PHASES = {
  CLUSTER_REUSE: 'cluster_reuse',
  PARALLEL_PROBE: 'parallel_probe',
  IDF_RANKING: 'idf_ranking',
  CLUSTER_BUILD: 'cluster_build',
  REACTIVE_REFINE: 'reactive_refine',
};

const DEFAULT_CONFIG = {
  defaultMode: SEARCH_MODES.FAST,
  enableClusterReuse: true,
  enableIdfRanking: true,
  enableReactiveRefine: false,
  minConfidenceForAnswer: 0.7,
  maxRefineLoops: 3,
};

/**
 * 自进化搜索引擎，融合Sirchnunk搜索流程设计
 * 实现5阶段搜索：集群复用→平行探测→IDF排名→集群建设→反应精炼
 * @extends EventEmitter
 */
class EvolvingSearchEngine extends EventEmitter {
  /**
   * 创建EvolvingSearchEngine实例
   * @param {object} [options]
   * @param {object} [options.mcpClient] - MCPClient实例
   * @param {object} [options.knowledgeClusterStore] - 知识集群存储
   * @param {object} [options.sirchnunkAdapter] - Sirchnunk MCP适配器
   */
  constructor(options) {
    super();
    this._config = { ...DEFAULT_CONFIG, ...(options ?? {}) };
    this._sirchnunk = this._config.sirchnunkAdapter || new SirchnunkMcpAdapter({ mcpClient: this._config.mcpClient });
    this._clusterStore = this._config.knowledgeClusterStore || new KnowledgeClusterStore();
    this._idfIndex = new BoundedMap(5000);
    this._stats = { totalSearches: 0, clusterReuseHits: 0, phaseStats: {}, totalRefineLoops: 0 };
  }

  /**
   * 执行搜索（完整5阶段流程）
   * @param {string} query - 搜索查询关键词
   * @param {object} [options] - 搜索选项
   * @param {string} [options.mode] - 搜索模式（fast/standard/deep）
   * @returns {Promise<{answer: string, source: string, clusterId: string, confidence: number, phases: string[], evidenceUnits?: Array, refineLoops?: number}>} 搜索结果，包含答案、来源、置信度和执行阶段等信息
   */
  async search(query, options) {
    this.guardShutdown();
    const mode = (options && options.mode) || this._config.defaultMode;
    this._stats.totalSearches++;

    // Phase 1: 知识集群复用
    let clusterResult = null;
    if (this._config.enableClusterReuse) {
      clusterResult = this._clusterStore.findMatchingCluster(query);
      if (clusterResult && clusterResult.score >= this._config.minConfidenceForAnswer) {
        this._stats.clusterReuseHits++;
        this._recordPhase(SEARCH_PHASES.CLUSTER_REUSE, true);
        this.emit('search-phase', { phase: SEARCH_PHASES.CLUSTER_REUSE, hit: true, clusterId: clusterResult.cluster.id });
        return {
          answer: this._synthesizeFromCluster(clusterResult.cluster, query),
          source: 'cluster_reuse',
          clusterId: clusterResult.cluster.id,
          confidence: clusterResult.score,
          phases: [SEARCH_PHASES.CLUSTER_REUSE],
        };
      }
      this._recordPhase(SEARCH_PHASES.CLUSTER_REUSE, false);
      this.emit('search-phase', { phase: SEARCH_PHASES.CLUSTER_REUSE, hit: false });
    }

    // Phase 2-4: 调用Sirchnunk执行搜索
    let searchResult;
    try {
      searchResult = await this._sirchnunk.search(query, { ...options, mode: mode });
    } catch (err) {
      // Sirchnunk不可用时回退到集群搜索
      if (clusterResult) {
        return {
          answer: this._synthesizeFromCluster(clusterResult.cluster, query),
          source: 'cluster_fallback',
          clusterId: clusterResult.cluster.id,
          confidence: clusterResult.score * 0.8,
          phases: [SEARCH_PHASES.CLUSTER_REUSE, 'fallback'],
        };
      }
      throw err;
    }

    // Phase 3: IDF加权排名
    if (this._config.enableIdfRanking && searchResult.evidenceUnits) {
      searchResult.evidenceUnits = this._idfRankEvidence(searchResult.evidenceUnits, query);
      this._recordPhase(SEARCH_PHASES.IDF_RANKING, true);
    }

    // Phase 4: 知识集群建设
    if (searchResult.confidence >= this._config.minConfidenceForAnswer) {
      this._buildOrUpdateCluster(query, searchResult);
      this._recordPhase(SEARCH_PHASES.CLUSTER_BUILD, true);
    }

    // Phase 5: 反应精炼（DEEP模式且置信度不足时）
    let refineCount = 0;
    if (this._config.enableReactiveRefine && mode === SEARCH_MODES.DEEP && searchResult.confidence < this._config.minConfidenceForAnswer) {
      while (refineCount < this._config.maxRefineLoops && searchResult.confidence < this._config.minConfidenceForAnswer) {
        refineCount++;
        try {
          const refinedResult = await this._sirchnunk.search(query, { ...options, mode: SEARCH_MODES.DEEP, maxLoops: 10 + refineCount * 5 });
          if (refinedResult.confidence > searchResult.confidence) {
            searchResult = refinedResult;
          }
        } catch (_err) {
          debug('EvolvingSearchEngine', 'reactiveRefine', _err && _err.message ? _err.message : String(_err));
          break;
        }
      }
      this._stats.totalRefineLoops += refineCount;
      this._recordPhase(SEARCH_PHASES.REACTIVE_REFINE, refineCount > 0);
    }

    this.emit('search-complete', { query: query, confidence: searchResult.confidence, phases: this._getExecutedPhases() });
    return {
      answer: searchResult.answer,
      source: 'sirchnunk',
      clusterId: searchResult.clusterId,
      confidence: searchResult.confidence,
      evidenceUnits: searchResult.evidenceUnits,
      phases: this._getExecutedPhases(),
      refineLoops: refineCount,
    };
  }

  /**
   * 获取统计信息
   * @returns {object} 统计数据
   */
  getStats() {
    if (this._shutDown) return {};
    return {
      ...this._stats,
      sirchnunkStats: this._sirchnunk && typeof this._sirchnunk.getStats === 'function' ? this._sirchnunk.getStats() : {},
      clusterStoreStats: this._clusterStore && typeof this._clusterStore.getStats === 'function' ? this._clusterStore.getStats() : {},
    };
  }

  _synthesizeFromCluster(cluster, _query) {
    const topEvidence = [...cluster.evidence]
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, 5);
    return topEvidence.map(e => e.content).join('\n\n');
  }

  _idfRankEvidence(evidenceUnits, query) {
    if (!evidenceUnits || evidenceUnits.length === 0) return evidenceUnits;
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return evidenceUnits.map(unit => {
      const content = (unit.content || '').toLowerCase();
      let idfScore = 0;
      for (const term of queryTerms) {
        if (content.includes(term)) {
          const entry = this._idfIndex.get(term);
          const docFreq = entry ? entry.docFreq : 1;
          const totalDocs = entry ? entry.totalDocs : 1;
          idfScore += Math.log((totalDocs + 1) / (docFreq + 1)) + 1;
        }
      }
      return { ...unit, idfScore: idfScore };
    }).sort((a, b) => (b.idfScore ?? 0) - (a.idfScore ?? 0));
  }

  _buildOrUpdateCluster(query, searchResult) {
    const existing = this._clusterStore.findMatchingCluster(query);
    if (existing && existing.score >= 0.6) {
      this._clusterStore.addEvidence(existing.cluster.id, {
        content: searchResult.answer,
        source: 'sirchnunk',
        confidence: searchResult.confidence,
      });
    } else {
      this._clusterStore.createCluster({
        name: query.slice(0, 100),
        category: CLUSTER_CATEGORIES.TOPIC,
        description: 'Auto-generated from search: ' + query.slice(0, 200),
        evidence: [{ content: searchResult.answer, source: 'sirchnunk', confidence: searchResult.confidence, addedAt: Date.now() }],
        keywords: query.split(/\s+/).filter(Boolean),
        confidence: searchResult.confidence,
        sourceQueries: [query],
      });
    }
  }

  _recordPhase(phase, success) {
    if (!this._stats.phaseStats[phase]) this._stats.phaseStats[phase] = { count: 0, successes: 0 };
    this._stats.phaseStats[phase].count++;
    if (success) this._stats.phaseStats[phase].successes++;
  }

  _getExecutedPhases() {
    return Object.keys(this._stats.phaseStats);
  }

  _onShutdown() {
    if (this._sirchnunk && typeof this._sirchnunk.shutdown === 'function') {
      safeCall(() => this._sirchnunk.shutdown(), 'EvolvingSearchEngine', 'shutdown-sirchnunk');
    }
    if (this._clusterStore && typeof this._clusterStore.shutdown === 'function') {
      safeCall(() => this._clusterStore.shutdown(), 'EvolvingSearchEngine', 'shutdown-clusterStore');
    }
    this._sirchnunk = null;
    this._clusterStore = null;
    this._idfIndex.clear();
    this._stats = { totalSearches: 0, clusterReuseHits: 0, phaseStats: {}, totalRefineLoops: 0 };
    this.removeAllListeners();
  }
}

module.exports = {
  EvolvingSearchEngine: withShutdown(EvolvingSearchEngine),
  SEARCH_PHASES,
  SEARCH_MODES,
  CLUSTER_CATEGORIES,
};
