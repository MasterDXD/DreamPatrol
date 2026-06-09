'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');

const QUERY_STRATEGIES = {
  CLASSIFIED_INDEX: 'classified-index',
  SELECTIVE_PRIORITY: 'selective-priority',
  BIDIRECTIONAL_SEARCH: 'bidirectional-search',
  CACHE_MATERIALIZATION: 'cache-materialization',
};

const DEFAULT_CONFIG = {
  maxCacheSize: 300,
  maxPathLength: 10,
  maxSubgraphSize: 100,
  defaultStrategy: QUERY_STRATEGIES.CLASSIFIED_INDEX,
};

/**
 * @module runtime/graphify/graph-query-engine
 * @classdesc 图谱查询引擎。4种优化策略、路径查找、子图提取
 */
class GraphQueryEngine extends EventEmitter {
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._nodes = new Map();
    this._edges = new Map();
    this._clusters = new Map();
    this._typeIndex = new Map();
    this._nameIndex = new Map();
    this._clusterIndex = new Map();
    this._adjacency = new Map();
    this._queryCache = new BoundedMap(this._config.maxCacheSize);
    this._stats = { queriesExecuted: 0, cacheHits: 0, cacheMisses: 0 };
  }

  /**
   * 挂载图谱和聚类数据，并重建内部索引
   * @param {{ nodes: Map|Object, edges: Map|Object }} graph - 图谱数据
   * @param {Map|Object} clusters - 聚类数据
   */
  attachGraph(graph, clusters) {
    this.guardShutdown();
    this._nodes = graph.nodes instanceof Map ? new Map(graph.nodes) : new Map();
    this._edges = graph.edges instanceof Map ? new Map(graph.edges) : new Map();
    this._clusters = clusters instanceof Map ? clusters : new Map();
    this._rebuildIndices();
  }

  _rebuildIndices() {
    this._typeIndex.clear();
    this._nameIndex.clear();
    this._clusterIndex.clear();
    this._adjacency.clear();

    for (const [, node] of this._nodes) {
      if (!this._typeIndex.has(node.type)) {
        this._typeIndex.set(node.type, []);
      }
      this._typeIndex.get(node.type).push(node.id);

      const nameLower = (node.name || '').toLowerCase();
      if (!this._nameIndex.has(nameLower)) {
        this._nameIndex.set(nameLower, []);
      }
      this._nameIndex.get(nameLower).push(node.id);

      if (!this._adjacency.has(node.id)) {
        this._adjacency.set(node.id, { incoming: [], outgoing: [] });
      }
    }

    for (const [, edge] of this._edges) {
      if (!this._adjacency.has(edge.source)) {
        this._adjacency.set(edge.source, { incoming: [], outgoing: [] });
      }
      this._adjacency.get(edge.source).outgoing.push(edge);

      if (!this._adjacency.has(edge.target)) {
        this._adjacency.set(edge.target, { incoming: [], outgoing: [] });
      }
      this._adjacency.get(edge.target).incoming.push(edge);
    }

    for (const [clusterId, cluster] of this._clusters) {
      if (!cluster || !cluster.nodeIds) continue;
      for (let i = 0; i < cluster.nodeIds.length; i++) {
        this._clusterIndex.set(cluster.nodeIds[i], clusterId);
      }
    }
  }

  /**
   * 执行图谱查询，支持4种优化策略（classified-index/selective-priority/bidirectional-search/cache-materialization）
   * @param {Object} spec - 查询规格
   * @param {string} [spec.nodeId] - 按节点ID查询
   * @param {string} [spec.type] - 按节点类型查询
   * @param {string} [spec.name] - 按节点名称查询
   * @param {string} [spec.clusterId] - 按聚类ID查询
   * @param {string} [spec.strategy] - 查询策略
   * @param {number} [spec.limit=100] - 结果数量上限
   * @returns {{ results: Array<Object>, strategy: string }} 查询结果
   */
  query(spec) {
    this.guardShutdown();
    if (!spec || typeof spec !== 'object') return { results: [], strategy: 'none' };

    this._stats.queriesExecuted++;

    const cacheKey = this._makeQueryCacheKey(spec);
    const cached = this._queryCache.get(cacheKey);
    if (cached) {
      this._stats.cacheHits++;
      return cached;
    }
    this._stats.cacheMisses++;

    const strategy = spec.strategy || this._config.defaultStrategy;
    let result;

    switch (strategy) {
      case QUERY_STRATEGIES.CLASSIFIED_INDEX:
        result = this._queryClassifiedIndex(spec);
        break;
      case QUERY_STRATEGIES.SELECTIVE_PRIORITY:
        result = this._querySelectivePriority(spec);
        break;
      case QUERY_STRATEGIES.BIDIRECTIONAL_SEARCH:
        result = this._queryBidirectional(spec);
        break;
      case QUERY_STRATEGIES.CACHE_MATERIALIZATION:
        result = this._queryCacheMaterialization(spec);
        break;
      default:
        result = this._queryClassifiedIndex(spec);
    }

    result.strategy = strategy;
    this._queryCache.set(cacheKey, result);
    this.emit('query-executed', { strategy, resultCount: result.results.length });
    return result;
  }

  _queryClassifiedIndex(spec) {
    if (spec.nodeId) {
      const node = this._nodes.get(spec.nodeId);
      return { results: node ? [{ ...node }] : [] };
    }

    const results = [];
    this._collectByType(spec, results);
    this._collectByName(spec, results);
    this._collectByCluster(spec, results);

    if (!spec.type && !spec.name && !spec.clusterId && !spec.nodeId) {
      const limit = spec.limit ?? 100;
      for (const [, node] of this._nodes) {
        results.push({ ...node });
        if (results.length >= limit) break;
      }
    }

    return { results: results.slice(0, spec.limit ?? 100) };
  }

  _collectByType(spec, results) {
    if (!spec.type || !this._typeIndex.has(spec.type)) return;
    const nodeIds = this._typeIndex.get(spec.type);
    for (let i = 0; i < nodeIds.length; i++) {
      const node = this._nodes.get(nodeIds[i]);
      if (node) results.push(node);
    }
  }

  _collectByName(spec, results) {
    if (!spec.name) return;
    const nameLower = spec.name.toLowerCase();
    const nodeIds = this._nameIndex.get(nameLower);
    if (!nodeIds) return;
    for (let i = 0; i < nodeIds.length; i++) {
      const node = this._nodes.get(nodeIds[i]);
      if (node && results.indexOf(node) < 0) results.push(node);
    }
  }

  _collectByCluster(spec, results) {
    if (!spec.clusterId || !this._clusters.has(spec.clusterId)) return;
    const cluster = this._clusters.get(spec.clusterId);
    if (!cluster || !cluster.nodeIds) return;
    for (let i = 0; i < cluster.nodeIds.length; i++) {
      const node = this._nodes.get(cluster.nodeIds[i]);
      if (node && results.indexOf(node) < 0) results.push(node);
    }
  }

  _querySelectivePriority(spec) {
    const results = [];
    const priorities = spec.priorities ?? ['type', 'name', 'clusterId'];

    for (let p = 0; p < priorities.length; p++) {
      const priority = priorities[p];
      this._collectByPriority(priority, spec, results);
    }

    return { results: results.slice(0, spec.limit ?? 100) };
  }

  _collectByPriority(priority, spec, results) {
    if (priority === 'type' && spec.type) {
      const nodeIds = this._typeIndex.get(spec.type) ?? [];
      for (let i = 0; i < nodeIds.length; i++) {
        const node = this._nodes.get(nodeIds[i]);
        if (node && results.indexOf(node) < 0) results.push(node);
      }
    }
    if (priority === 'name' && spec.name) {
      const nameLower = spec.name.toLowerCase();
      const nodeIds = this._nameIndex.get(nameLower) ?? [];
      for (let i = 0; i < nodeIds.length; i++) {
        const node = this._nodes.get(nodeIds[i]);
        if (node && results.indexOf(node) < 0) results.push(node);
      }
    }
    if (priority === 'clusterId' && spec.clusterId) {
      const cluster = this._clusters.get(spec.clusterId);
      if (cluster && cluster.nodeIds) {
        for (let i = 0; i < cluster.nodeIds.length; i++) {
          const node = this._nodes.get(cluster.nodeIds[i]);
          if (node && results.indexOf(node) < 0) results.push(node);
        }
      }
    }
  }

  _queryBidirectional(spec) {
    if (!spec.fromId || !spec.toId) return { results: [], path: null };

    const path = this.findPath(spec.fromId, spec.toId);
    const results = [];
    if (path && path.nodes) {
      for (let i = 0; i < path.nodes.length; i++) {
        const node = this._nodes.get(path.nodes[i]);
        if (node) results.push(node);
      }
    }

    return { results, path };
  }

  _queryCacheMaterialization(spec) {
    const classified = this._queryClassifiedIndex(spec);
    return classified;
  }

  /**
   * 使用双向BFS查找两个节点之间的最短路径
   * @param {string} fromId - 起始节点ID
   * @param {string} toId - 目标节点ID
   * @returns {{ nodes: Array<string>, edges: Array<string>, length: number }|null} 路径信息；不可达时返回 null
   */
  findPath(fromId, toId) {
    this.guardShutdown();
    if (!fromId || !toId) return null;
    if (!this._nodes.has(fromId) || !this._nodes.has(toId)) return null;
    if (fromId === toId) return { nodes: [fromId], edges: [], length: 0 };

    const forwardVisited = new Map();
    const backwardVisited = new Map();
    const forwardQueue = [{ id: fromId, path: [fromId], edges: [] }];
    const backwardQueue = [{ id: toId, path: [toId], edges: [] }];
    forwardVisited.set(fromId, { path: [fromId], edges: [] });
    backwardVisited.set(toId, { path: [toId], edges: [] });

    let iteration = 0;
    const maxIterations = this._config.maxPathLength * 2;

    while (forwardQueue.length > 0 && backwardQueue.length > 0 && iteration < maxIterations) {
      iteration++;

      const forwardCurrent = forwardQueue.shift();
      const adj = this._adjacency.get(forwardCurrent.id);
      if (adj) {
        const outgoing = adj.outgoing ?? [];
        for (let i = 0; i < outgoing.length; i++) {
          const edge = outgoing[i];
          if (forwardVisited.has(edge.target)) continue;
          const newPath = forwardCurrent.path.concat([edge.target]);
          const newEdges = forwardCurrent.edges.concat([edge.id]);
          forwardVisited.set(edge.target, { path: newPath, edges: newEdges });

          if (backwardVisited.has(edge.target)) {
            const forwardPart = newPath;
            const backwardPart = backwardVisited.get(edge.target).path;
            const combinedPath = forwardPart.concat(backwardPart.slice(0, -1).reverse());
            return { nodes: combinedPath, edges: newEdges.concat(backwardVisited.get(edge.target).edges.slice().reverse()), length: combinedPath.length - 1 };
          }

          forwardQueue.push({ id: edge.target, path: newPath, edges: newEdges });
        }
      }

      const backwardCurrent = backwardQueue.shift();
      const backAdj = this._adjacency.get(backwardCurrent.id);
      if (backAdj) {
        const incoming = backAdj.incoming ?? [];
        for (let i = 0; i < incoming.length; i++) {
          const edge = incoming[i];
          if (backwardVisited.has(edge.source)) continue;
          const newPath = backwardCurrent.path.concat([edge.source]);
          const newEdges = backwardCurrent.edges.concat([edge.id]);
          backwardVisited.set(edge.source, { path: newPath, edges: newEdges });

          if (forwardVisited.has(edge.source)) {
            const forwardPart = forwardVisited.get(edge.source).path;
            const backwardPart = newPath;
            const combinedPath = forwardPart.concat(backwardPart.slice(0, -1).reverse());
            return { nodes: combinedPath, edges: forwardVisited.get(edge.source).edges.concat(newEdges.slice().reverse()), length: combinedPath.length - 1 };
          }

          backwardQueue.push({ id: edge.source, path: newPath, edges: newEdges });
        }
      }
    }

    return null;
  }

  /**
   * 根据节点ID列表提取子图，包含指定节点及其之间的边
   * @param {Array<string>} nodeIds - 节点ID列表
   * @returns {{ nodes: Array<Object>, edges: Array<Object> }} 子图数据
   */
  getSubgraph(nodeIds) {
    this.guardShutdown();
    if (!Array.isArray(nodeIds)) return { nodes: [], edges: [] };

    const nodeIdSet = new Set(nodeIds);
    const nodes = [];
    const edges = [];

    for (let i = 0; i < nodeIds.length; i++) {
      const node = this._nodes.get(nodeIds[i]);
      if (node) nodes.push(node);
    }

    for (const [, edge] of this._edges) {
      if (nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target)) {
        edges.push(edge);
      }
      if (edges.length >= this._config.maxSubgraphSize) break;
    }

    return { nodes, edges };
  }

  /**
   * 获取架构概览，包含节点/边/聚类的统计信息
   * @returns {{ totalNodes: number, totalEdges: number, totalClusters: number, nodeTypes: Object<string, number>, edgeTypes: Object<string, number>, clusters: Array<Object> }} 架构概览
   */
  getArchitectureOverview() {
    this.guardShutdown();

    const typeCounts = {};
    for (const [type, ids] of this._typeIndex) {
      typeCounts[type] = ids.length;
    }

    const clusterSummaries = [];
    for (const [clusterId, cluster] of this._clusters) {
      clusterSummaries.push({
        id: clusterId,
        size: cluster.size ?? (cluster.nodeIds ? cluster.nodeIds.length : 0),
      });
    }

    const edgeTypeCounts = {};
    for (const [, edge] of this._edges) {
      edgeTypeCounts[edge.type] = (edgeTypeCounts[edge.type] ?? 0) + 1;
    }

    return {
      totalNodes: this._nodes.size,
      totalEdges: this._edges.size,
      totalClusters: this._clusters.size,
      nodeTypes: typeCounts,
      edgeTypes: edgeTypeCounts,
      clusters: clusterSummaries,
    };
  }

  /**
   * 获取查询引擎的统计信息
   * @returns {{ queriesExecuted: number, cacheHits: number, cacheMisses: number, cacheHitRate: number }} 统计信息
   */
  getStats() {
    this.guardShutdown();
    return {
      queriesExecuted: this._stats.queriesExecuted,
      cacheHits: this._stats.cacheHits,
      cacheMisses: this._stats.cacheMisses,
      cacheHitRate: this._stats.queriesExecuted > 0
        ? this._stats.cacheHits / this._stats.queriesExecuted
        : 0,
    };
  }

  /**
   * 清空查询缓存
   */
  clearCache() {
    this.guardShutdown();
    this._queryCache.clear();
  }

  _makeQueryCacheKey(spec) {
    const parts = [spec.nodeId || '', spec.type || '', spec.name || '', spec.clusterId || '', spec.strategy || '', spec.fromId || '', spec.toId || ''];
    return parts.join('|');
  }

  _onShutdown() {
    this._nodes.clear();
    this._edges.clear();
    this._clusters.clear();
    this._typeIndex.clear();
    this._nameIndex.clear();
    this._clusterIndex.clear();
    this._adjacency.clear();
    this._queryCache.clear();
    this._stats = { queriesExecuted: 0, cacheHits: 0, cacheMisses: 0 };
    this.removeAllListeners();
  }
}

GraphQueryEngine.QUERY_STRATEGIES = QUERY_STRATEGIES;

module.exports = withShutdown(GraphQueryEngine);
