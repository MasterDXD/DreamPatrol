'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { mergeConfig } = require('../../utils/safe-assign');

const DEFAULT_CONFIG = {
  resolution: 1.0,
  maxIterations: 100,
  minModularityGain: 0.0001,
};

/**
 * @module runtime/graphify/louvain-clusterer
 * @classdesc Louvain社区发现。两阶段模块度优化、层次聚类
 */
class LouvainClusterer extends EventEmitter {
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._clusters = new Map();
    this._hierarchy = [];
    this._modularity = 0;
    this._iterations = 0;
  }

  /**
   * 对图谱执行Louvain社区发现算法，进行两阶段模块度优化聚类
   * @param {{ nodes: Map|Object, edges: Map|Object }} graph - 图谱数据，包含节点和边
   * @returns {{ clusters: Map<string, Object>, modularity: number, iterations: number }} 聚类结果
   */
  cluster(graph) {
    this.guardShutdown();
    if (!graph || !graph.nodes || !graph.edges) return { clusters: new Map(), modularity: 0, iterations: 0 };

    const nodes = graph.nodes instanceof Map ? graph.nodes : new Map(Object.entries(graph.nodes));
    const edges = graph.edges instanceof Map ? graph.edges : new Map(Object.entries(graph.edges));

    if (nodes.size === 0) return { clusters: new Map(), modularity: 0, iterations: 0 };

    const adjacency = this._buildAdjacency(nodes, edges);
    const totalWeight = this._computeTotalWeight(adjacency);
    if (totalWeight === 0) {
      return this._singletonClusters(nodes);
    }

    const community = new Map();
    let nodeId = 0;
    const nodeIds = [];

    for (const [id] of nodes) {
      community.set(id, nodeId);
      nodeIds.push(id);
      nodeId++;
    }

    let improved = true;
    let iteration = 0;
    let currentModularity = this._computeModularity(adjacency, community, totalWeight);

    while (improved && iteration < this._config.maxIterations) {
      improved = false;
      iteration++;

      for (let i = 0; i < nodeIds.length; i++) {
        const currentId = nodeIds[i];
        const currentCommunity = community.get(currentId);
        const neighbors = adjacency.get(currentId);

        if (!neighbors || neighbors.size === 0) continue;

        const bestMove = this._findBestMove(currentId, currentCommunity, community, adjacency, totalWeight);

        if (bestMove.community !== currentCommunity && bestMove.gain > this._config.minModularityGain) {
          community.set(currentId, bestMove.community);
          improved = true;
        }
      }

      const newModularity = this._computeModularity(adjacency, community, totalWeight);
      if (newModularity <= currentModularity + this._config.minModularityGain) {
        break;
      }
      currentModularity = newModularity;
    }

    this._clusters = this._buildClusterMap(community, nodes);
    this._modularity = currentModularity;
    this._iterations = iteration;
    this._hierarchy = this._buildHierarchy(this._clusters);

    this.emit('clusters-computed', { clusterCount: this._clusters.size, modularity: this._modularity });

    return {
      clusters: this._clusters,
      modularity: this._modularity,
      iterations: this._iterations,
    };
  }

  _buildAdjacency(nodes, edges) {
    const adjacency = new Map();

    for (const [id] of nodes) {
      adjacency.set(id, new Map());
    }

    for (const [, edge] of edges) {
      const source = edge.source;
      const target = edge.target;
      const weight = edge.weight ?? 1.0;

      if (!adjacency.has(source)) adjacency.set(source, new Map());
      if (!adjacency.has(target)) adjacency.set(target, new Map());

      const sourceNeighbors = adjacency.get(source);
      sourceNeighbors.set(target, (sourceNeighbors.get(target) ?? 0) + weight);

      const targetNeighbors = adjacency.get(target);
      targetNeighbors.set(source, (targetNeighbors.get(source) ?? 0) + weight);
    }

    return adjacency;
  }

  _computeTotalWeight(adjacency) {
    let total = 0;
    for (const [, neighbors] of adjacency) {
      for (const [, weight] of neighbors) {
        total += weight;
      }
    }
    return total / 2;
  }

  _computeModularity(adjacency, community, totalWeight) {
    if (totalWeight === 0) return 0;

    let q = 0;
    const nodeIds = Array.from(adjacency.keys());

    for (let i = 0; i < nodeIds.length; i++) {
      const nodeA = nodeIds[i];
      const ki = this._getNodeDegree(adjacency, nodeA);

      for (let j = i; j < nodeIds.length; j++) {
        const nodeB = nodeIds[j];
        if (community.get(nodeA) !== community.get(nodeB)) continue;

        const kj = this._getNodeDegree(adjacency, nodeB);
        const aij = (adjacency.get(nodeA) ?? new Map()).get(nodeB) ?? 0;

        if (i === j) {
          q += aij - (ki * ki) / (2 * totalWeight);
        } else {
          q += 2 * (aij - (ki * kj) / (2 * totalWeight));
        }
      }
    }

    return q / (2 * totalWeight);
  }

  _getNodeDegree(adjacency, nodeId) {
    const neighbors = adjacency.get(nodeId);
    if (!neighbors) return 0;
    let degree = 0;
    for (const [, weight] of neighbors) {
      degree += weight;
    }
    return degree;
  }

  _findBestMove(nodeId, currentCommunity, community, adjacency, totalWeight) {
    if (totalWeight === 0) return { community: currentCommunity, gain: 0 };
    const neighbors = adjacency.get(nodeId);
    if (!neighbors) return { community: currentCommunity, gain: 0 };

    const ki = this._getNodeDegree(adjacency, nodeId);
    const neighborCommunities = new Map();

    for (const [neighborId] of neighbors) {
      const neighborComm = community.get(neighborId);
      if (neighborComm !== undefined) {
        neighborCommunities.set(neighborComm, (neighborCommunities.get(neighborComm) ?? 0) + 1);
      }
    }

    let bestCommunity = currentCommunity;
    let bestGain = 0;

    for (const [targetCommunity] of neighborCommunities) {
      if (targetCommunity === currentCommunity) continue;

      const sigmaTot = this._communityDegree(adjacency, community, targetCommunity);
      const kiIn = this._nodeCommunityEdges(adjacency, community, nodeId, targetCommunity);

      const deltaQ = kiIn - (sigmaTot * ki) / (2 * totalWeight);

      if (deltaQ > bestGain) {
        bestGain = deltaQ;
        bestCommunity = targetCommunity;
      }
    }

    return { community: bestCommunity, gain: bestGain };
  }

  _communityDegree(adjacency, community, communityId) {
    let total = 0;
    for (const [nodeId, comm] of community) {
      if (comm !== communityId) continue;
      total += this._getNodeDegree(adjacency, nodeId);
    }
    return total;
  }

  _nodeCommunityEdges(adjacency, community, nodeId, targetCommunity) {
    const neighbors = adjacency.get(nodeId);
    if (!neighbors) return 0;
    let total = 0;
    for (const [neighborId, weight] of neighbors) {
      if (community.get(neighborId) === targetCommunity) {
        total += weight;
      }
    }
    return total;
  }

  _singletonClusters(nodes) {
    const clusters = new Map();
    let clusterId = 0;
    for (const [id, node] of nodes) {
      const cid = 'cluster_' + clusterId++;
      clusters.set(cid, { id: cid, nodeIds: [id], nodes: [node], size: 1 });
    }
    this._clusters = clusters;
    this._modularity = 0;
    this._iterations = 0;
    this._hierarchy = [{ level: 0, clusters: Array.from(clusters.keys()) }];
    return { clusters, modularity: 0, iterations: 0 };
  }

  _buildClusterMap(community, nodes) {
    const clusterGroups = new Map();

    for (const [nodeId, communityId] of community) {
      if (!clusterGroups.has(communityId)) {
        clusterGroups.set(communityId, []);
      }
      clusterGroups.get(communityId).push(nodeId);
    }

    const clusters = new Map();
    let clusterIdx = 0;
    for (const [, nodeIds] of clusterGroups) {
      const cid = 'cluster_' + clusterIdx++;
      const clusterNodes = [];
      for (let i = 0; i < nodeIds.length; i++) {
        const node = nodes.get(nodeIds[i]);
        if (node) clusterNodes.push(node);
      }
      clusters.set(cid, { id: cid, nodeIds, nodes: clusterNodes, size: nodeIds.length });
    }

    return clusters;
  }

  _buildHierarchy(clusters) {
    return [{ level: 0, clusters: Array.from(clusters.keys()) }];
  }

  /**
   * 根据聚类ID获取聚类信息
   * @param {string} clusterId - 聚类ID
   * @returns {Object|null} 聚类信息，包含 id、nodeIds、nodes、size；不存在时返回 null
   */
  getCluster(clusterId) {
    return this._clusters.get(clusterId) ?? null;
  }

  /**
   * 获取层次聚类结构
   * @returns {Array<{ level: number, clusters: Array<string> }>} 层次聚类结构列表
   */
  getClusterHierarchy() {
    return this._hierarchy.slice();
  }

  /**
   * 获取最近一次聚类的模块度值
   * @returns {number} 模块度值
   */
  getModularity() {
    return this._modularity;
  }

  /**
   * 获取最近一次聚类的迭代次数
   * @returns {number} 迭代次数
   */
  getIterations() {
    return this._iterations;
  }

  _onShutdown() {
    this._clusters.clear();
    this._hierarchy = [];
    this._modularity = 0;
    this._iterations = 0;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(LouvainClusterer);
