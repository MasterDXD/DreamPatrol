'use strict';

/** @module runtime/search/knowledge-cluster-store */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { generateId } = require('../../utils/constants');
const BoundedMap = require('../../utils/bounded-map');

const CLUSTER_CATEGORIES = {
  PERSON: 'person',
  PROJECT: 'project',
  MEMORY_TYPE: 'memory_type',
  TOPIC: 'topic',
  DECISION: 'decision',
  ERROR_PATTERN: 'error_pattern',
};

const DEFAULT_CONFIG = {
  maxClusters: 500,
  maxEvidencePerCluster: 50,
  minConfidence: 0.5,
  similarityThreshold: 0.75,
  autoMergeThreshold: 0.85,
};

/**
 * 知识集群存储，借鉴Sirchnunk的KnowledgeCluster设计
 * 使用Harness原生的BoundedMap+内存方案实现
 * @extends EventEmitter
 */
class KnowledgeClusterStore extends EventEmitter {
  /**
   * 创建KnowledgeClusterStore实例
   * @param {object} [options]
   * @param {object} [options.sqliteStore] - SQLite存储实例（可选）
   * @param {object} [options.embeddingService] - 嵌入服务实例（可选）
   */
  constructor(options) {
    super();
    this._config = { ...DEFAULT_CONFIG, ...(options ?? {}) };
    this._clusters = new BoundedMap(this._config.maxClusters);
    this._categoryIndex = new Map();
    this._sqliteStore = this._config.sqliteStore ?? null;
    this._embeddingService = this._config.embeddingService ?? null;
    this._stats = { totalClusters: 0, totalMerges: 0, totalReuses: 0, byCategory: {} };
  }

  /**
   * 创建知识集群
   * @param {object} clusterData - 集群数据
   * @param {string} [clusterData.name] - 集群名称
   * @param {string} [clusterData.category] - 集群分类
   * @param {string} [clusterData.description] - 集群描述
   * @param {Array} [clusterData.evidence] - 证据列表
   * @param {string[]} [clusterData.keywords] - 关键词列表
   * @param {number} [clusterData.confidence] - 置信度
   * @param {string[]} [clusterData.sourceQueries] - 来源查询列表
   * @returns {object} 创建的集群对象
   */
  createCluster(clusterData) {
    this.guardShutdown();
    const id = generateId('kc-');
    const cluster = {
      id: id,
      name: clusterData.name || 'Unnamed Cluster',
      category: clusterData.category || CLUSTER_CATEGORIES.TOPIC,
      description: clusterData.description || '',
      evidence: clusterData.evidence ?? [],
      keywords: clusterData.keywords ?? [],
      confidence: clusterData.confidence ?? 0,
      sourceQueries: clusterData.sourceQueries ?? [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
    };
    this._clusters.set(id, cluster);
    this._addToCategoryIndex(cluster.category, id);
    this._stats.totalClusters++;
    this._stats.byCategory[cluster.category] = (this._stats.byCategory[cluster.category] ?? 0) + 1;
    this.emit('cluster-created', cluster);
    return cluster;
  }

  /**
   * 查找匹配的知识集群
   * @param {string} query - 查询文本
   * @param {string} [category] - 限定分类
   * @returns {object|null} 匹配结果，包含cluster和score
   */
  findMatchingCluster(query, category) {
    this.guardShutdown();
    const queryLower = query.toLowerCase();
    const queryKeywords = queryLower.split(/\s+/).filter(Boolean);
    let bestMatch = null;
    let bestScore = 0;

    const candidates = category ? this._getByCategory(category) : Array.from(this._clusters.values());
    for (const cluster of candidates) {
      const score = this._computeMatchScore(queryKeywords, cluster);
      if (score > bestScore && score >= this._config.similarityThreshold) {
        bestScore = score;
        bestMatch = cluster;
      }
    }

    if (bestMatch) {
      bestMatch.accessCount++;
      bestMatch.updatedAt = Date.now();
      this._stats.totalReuses++;
      this.emit('cluster-reused', { clusterId: bestMatch.id, score: bestScore, query: query });
    }

    return bestMatch ? { cluster: bestMatch, score: bestScore } : null;
  }

  /**
   * 向集群添加证据
   * @param {string} clusterId - 集群ID
   * @param {object} evidence - 证据数据
   * @param {string} evidence.content - 证据内容
   * @param {string} [evidence.source] - 证据来源
   * @param {number} [evidence.confidence] - 证据置信度
   * @returns {object|null} 更新后的集群，不存在返回null
   */
  addEvidence(clusterId, evidence) {
    this.guardShutdown();
    const cluster = this._clusters.get(clusterId);
    if (!cluster) return null;
    if (cluster.evidence.length >= this._config.maxEvidencePerCluster) {
      cluster.evidence.shift();
    }
    cluster.evidence.push({
      content: evidence.content,
      source: evidence.source || 'unknown',
      confidence: evidence.confidence ?? 0.5,
      addedAt: Date.now(),
    });
    cluster.updatedAt = Date.now();
    this.emit('evidence-added', { clusterId: clusterId, evidenceCount: cluster.evidence.length });
    return cluster;
  }

  /**
   * 合并两个相似集群
   * @param {string} sourceId - 源集群ID
   * @param {string} targetId - 目标集群ID
   * @returns {boolean} 是否合并成功
   */
  mergeClusters(sourceId, targetId) {
    this.guardShutdown();
    const source = this._clusters.get(sourceId);
    const target = this._clusters.get(targetId);
    if (!source || !target) return false;

    target.evidence = target.evidence.concat(source.evidence).slice(-this._config.maxEvidencePerCluster);
    target.keywords = Array.from(new Set(target.keywords.concat(source.keywords)));
    target.sourceQueries = Array.from(new Set(target.sourceQueries.concat(source.sourceQueries)));
    target.confidence = Math.max(target.confidence, source.confidence);
    target.updatedAt = Date.now();

    this._clusters.delete(sourceId);
    this._removeFromCategoryIndex(source.category, sourceId);
    this._stats.totalMerges++;
    this.emit('clusters-merged', { sourceId: sourceId, targetId: targetId });
    return true;
  }

  /**
   * 获取指定集群
   * @param {string} clusterId - 集群ID
   * @returns {object|null} 集群对象
   */
  getCluster(clusterId) {
    return this._clusters.get(clusterId) ?? null;
  }

  /**
   * 获取所有集群
   * @param {string} [category] - 限定分类
   * @returns {Array} 集群列表
   */
  getAllClusters(category) {
    if (category) return this._getByCategory(category);
    return Array.from(this._clusters.values());
  }

  /**
   * 获取统计信息
   * @returns {object} 统计数据
   */
  getStats() {
    if (this._shutDown) return {};
    return {
      ...this._stats,
      cacheSize: this._clusters.size,
      categories: Object.keys(this._categoryIndex),
    };
  }

  _addToCategoryIndex(category, clusterId) {
    if (!this._categoryIndex.has(category)) this._categoryIndex.set(category, new Set());
    const catSet = this._categoryIndex.get(category);
    if (catSet) catSet.add(clusterId);
  }

  _removeFromCategoryIndex(category, clusterId) {
    const set = this._categoryIndex.get(category);
    if (set) {
      set.delete(clusterId);
      if (set.size === 0) this._categoryIndex.delete(category);
    }
  }

  _getByCategory(category) {
    const ids = this._categoryIndex.get(category);
    if (!ids) return [];
    const result = [];
    for (const id of ids) {
      const c = this._clusters.get(id);
      if (c) result.push(c);
    }
    return result;
  }

  _computeMatchScore(queryKeywords, cluster) {
    if (queryKeywords.length === 0) return 0;
    const clusterText = (cluster.keywords ?? []).join(' ').toLowerCase() + ' ' + (cluster.name || '').toLowerCase();
    let matches = 0;
    for (const kw of queryKeywords) {
      if (clusterText.includes(kw)) matches++;
    }
    return matches / queryKeywords.length;
  }

  _onShutdown() {
    safeCall(() => this._clusters.shutdown(), 'KnowledgeClusterStore', 'shutdown-clusters');
    this._categoryIndex.clear();
    this._stats = { totalClusters: 0, totalMerges: 0, totalReuses: 0, byCategory: {} };
    this.removeAllListeners();
  }
}

module.exports = {
  KnowledgeClusterStore: withShutdown(KnowledgeClusterStore),
  CLUSTER_CATEGORIES,
  DEFAULT_CONFIG,
};
