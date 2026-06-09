'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const { mergeConfig } = safeAssign;

const DEFAULT_CONFIG = {
  maxEntities: 5000,
  maxRelations: 10000,
  maxClusters: 100,
  maxDocuments: 500,
  cooccurrenceWindow: 'paragraph',
  minRelationWeight: 0.1,
};

const ENTITY_TYPES = {
  PERSON: 'PERSON',
  ORG: 'ORG',
  TECH: 'TECH',
  CONCEPT: 'CONCEPT',
};

const RELATION_TYPES = {
  DEPENDS_ON: 'DEPENDS_ON',
  PART_OF: 'PART_OF',
  RELATED_TO: 'RELATED_TO',
};

const PERSON_PATTERN = /(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}|[A-Z][a-z]+\s+[A-Z]\.?\s+[A-Z][a-z]+/g;
const ORG_PATTERN = /[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,5}(?:\s+(?:Inc|Corp|Ltd|LLC|Company|Group|Foundation|Organization|Institute|University|Team|Lab|Labs))/g;
const TECH_PATTERN = /[A-Z][a-zA-Z]*(?:\.[A-Z][a-zA-Z]*)+|[a-z]+(?:-[a-z]+)+\.js|[a-z]+(?:-[a-z]+)+\.ts|[A-Z][a-zA-Z0-9]*(?:JS|TS|API|SDK|CLI|ORM|DB|SQL|HTTP|REST|RPC|ML|AI|LLM)\b|[A-Z][a-z]+[A-Z][a-zA-Z0-9]*\b/g;
const CONCEPT_PATTERN = /[\u4e00-\u9fff]{2,8}(?:\u6a21\u578f|\u67b6\u6784|\u7cfb\u7edf|\u5f15\u64ce|\u6846\u67b6|\u5e73\u53f0|\u6a21\u5757|\u7ec4\u4ef6|\u670d\u52a1|\u6d41\u7a0b|\u7b56\u7565|\u89c4\u5219|\u534f\u8bae|\u63a5\u53e3|\u6570\u636e|\u7f13\u5b58|\u961f\u5217|\u4efb\u52a1|\u8c03\u5ea6|\u76d1\u63a7|\u5b89\u5168|\u6743\u9650|\u8ba4\u8bc1|\u6388\u6743)/g;

const DEPENDS_KEYWORDS = /(?:depends?\s+on|relies?\s+on|requires?|needs?|uses?|依赖|需要|引用|调用)/i;
const PART_OF_KEYWORDS = /(?:part\s+of|belongs?\s+to|contained?\s+in|member\s+of|submodule\s+of|包含|属于|组成|一部分)/i;
const RELATED_KEYWORDS = /(?:related\s+to|associated\s+with|connected\s+to|links?\s+to|references?|相关|关联|连接|涉及)/i;

const PARAGRAPH_SPLIT = /\n\s*\n/;

function _normalizeEntityName(name) {
  return name.trim().replace(/\s+/g, ' ');
}

function _makeEntityKey(name, type) {
  return type + ':' + _normalizeEntityName(name);
}

/**
 * @module runtime/workflow/graph-rag
 * @classdesc 图谱RAG引擎（GraphRAG）。知识图谱检索、实体关系推理、多跳查询。
 * GraphRAG — 知识图谱RAG引擎
 * Knowledge graph construction and query engine for graph-augmented retrieval. Extracts entities
 * (PERSON, ORG, TECH, CONCEPT) and relations (DEPENDS_ON, PART_OF, RELATED_TO) from documents
 * using regex patterns and co-occurrence analysis. Builds entity clusters via connected component
 * detection, supports multi-hop subgraph expansion for queries, and integrates with embedding
 * services for vector-augmented retrieval.
 * @extends EventEmitter
 * @emits document-ingested | clusters-built | query-executed | error
 */
class GraphRAG extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxEntities=5000] - 最大实体数
   * @param {number} [options.maxRelations=10000] - 最大关系数
   * @param {number} [options.maxClusters=100] - 最大聚类数
   * @param {number} [options.maxDocuments=500] - 最大文档数
   * @param {string} [options.cooccurrenceWindow='paragraph'] - 共现窗口粒度
   * @param {number} [options.minRelationWeight=0.1] - 最小关系权重
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._entityIdCounter = 0;
    this._relationIdCounter = 0;
    this._clusterIdCounter = 0;
    this._entities = new Map();
    this._entityKeyIndex = new Map();
    this._relations = new Map();
    this._relationKeyIndex = new Map();
    this._clusters = new Map();
    this._documents = new Map();
    this._embeddingService = null;
    this._vectorIndex = null;
    this._graphifyCompiler = null;
    this._stats = {
      documentsIngested: 0,
      entitiesExtracted: 0,
      relationsExtracted: 0,
      clustersBuilt: 0,
      queriesExecuted: 0,
      graphifyQueries: 0,
    };
  }

  /**
   * 导入文档并提取实体和关系。若文档已存在则先移除旧数据，
   * 超过文档上限时淘汰最早导入的文档。
   *
   * @param {string} docId - 文档唯一标识符
   * @param {string} content - 文档文本内容
   * @param {Object} [metadata] - 文档元数据
   * @returns {{success: boolean, docId?: string, entityCount?: number, relationCount?: number, error?: string}} 导入结果
   */
  ingestDocument(docId, content, metadata) {
    this.guardShutdown();
    if (!docId || typeof docId !== 'string') return { success: false, error: 'docId is required' };
    if (!content || typeof content !== 'string') return { success: false, error: 'content is required' };

    try {
      if (this._documents.has(docId)) {
        this._removeDocumentEntities(docId);
      }

      if (this._documents.size >= this._config.maxDocuments) {
        const oldestDocId = this._documents.keys().next().value;
        if (oldestDocId) this._removeDocumentEntities(oldestDocId);
        this._documents.delete(oldestDocId);
      }

      this._documents.set(docId, {
        id: docId,
        content: content,
        metadata: metadata ?? {},
        ingestedAt: new Date().toISOString(),
      });

      const entities = this._extractEntities(content, docId);
      const relations = this._extractRelations(content, entities, docId);

      this._stats.documentsIngested++;
      this._stats.entitiesExtracted += entities.length;
      this._stats.relationsExtracted += relations.length;

      this.emit('document-ingested', { docId, entityCount: entities.length, relationCount: relations.length });
      return { success: true, docId, entityCount: entities.length, relationCount: relations.length };
    } catch (err) {
      debug('GraphRAG', 'ingestDocument', err);
      emitError(this, 'error', err);
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  _extractEntities(content, docId) {
    const found = [];
    const seen = new Set();

    const extractByPattern = (pattern, type) => {
      let match;
      let regex;
      try {
        regex = new RegExp(pattern.source, pattern.flags);
      } catch (_e) {
        debug('GraphRag', 'extractByPattern-regex-error', _e && _e.message ? _e.message : String(_e));
        return;
      }
      while ((match = regex.exec(content)) !== null) {
        const name = _normalizeEntityName(match[0]);
        const key = _makeEntityKey(name, type);
        if (!seen.has(key) && name.length > 1) {
          seen.add(key);
          found.push({ name, type, position: match.index });
        }
      }
    };

    extractByPattern(PERSON_PATTERN, ENTITY_TYPES.PERSON);
    extractByPattern(ORG_PATTERN, ENTITY_TYPES.ORG);
    extractByPattern(TECH_PATTERN, ENTITY_TYPES.TECH);
    extractByPattern(CONCEPT_PATTERN, ENTITY_TYPES.CONCEPT);

    const entities = [];
    for (const item of found) {
      if (this._entities.size >= this._config.maxEntities) break;

      const key = _makeEntityKey(item.name, item.type);
      let entity;
      if (this._entityKeyIndex.has(key)) {
        entity = this._entities.get(this._entityKeyIndex.get(key));
        if (entity) {
          entity.mentions.push({ docId, position: item.position });
        }
      } else {
        const id = this._nextEntityId();
        entity = {
          id,
          name: item.name,
          type: item.type,
          mentions: [{ docId, position: item.position }],
        };
        this._entities.set(id, entity);
        this._entityKeyIndex.set(key, id);
      }
      entities.push(entity);
    }

    return entities;
  }

  _extractRelations(content, entities, docId) {
    const relations = [];
    if (!entities || entities.length < 2) return relations;

    const entityDocIndices = this._buildEntityDocIndices(entities, docId);

    let offset = 0;
    const parts = content.split(PARAGRAPH_SPLIT);
    for (let pi = 0; pi < parts.length; pi++) {
      if (this._relations.size >= this._config.maxRelations) break;
      const paragraph = parts[pi];
      const paraEntities = this._findParagraphEntities(paragraph, offset, paragraph.length, entities, entityDocIndices);
      this._createCooccurrenceRelations(paragraph, paraEntities, relations);
      offset += paragraph.length;
      if (pi < parts.length - 1) {
        const sep = content.substring(offset, offset + 10).match(/^\n\s*\n/);
        offset += sep ? sep[0].length : 2;
      }
    }

    this._pruneWeakRelations(relations);
    return relations.filter(r => this._relations.has(r.id));
  }

  _buildEntityDocIndices(entities, docId) {
    const entityDocIndices = new Map();
    for (const entity of entities) {
      for (const mention of Array.isArray(entity.mentions) ? entity.mentions : []) {
        if (mention.docId !== docId) continue;
        if (!entityDocIndices.has(entity.id)) {
          entityDocIndices.set(entity.id, []);
        }
        entityDocIndices.get(entity.id).push(mention.position);
      }
    }
    return entityDocIndices;
  }

  _findParagraphEntities(paragraph, paraStart, paraLen, entities, entityDocIndices) {
    const paraEnd = paraStart + paraLen;
    const paraEntities = [];
    for (const entity of entities) {
      const positions = entityDocIndices.get(entity.id);
      if (!positions) continue;
      for (const pos of positions) {
        if (pos >= paraStart && pos < paraEnd) {
          paraEntities.push(entity);
          break;
        }
      }
    }
    return paraEntities;
  }

  _createCooccurrenceRelations(paragraph, paraEntities, relations) {
    for (let i = 0; i < paraEntities.length; i++) {
      if (this._relations.size >= this._config.maxRelations) break;
      for (let j = i + 1; j < paraEntities.length; j++) {
        if (this._relations.size >= this._config.maxRelations) break;
        const source = paraEntities[i];
        const target = paraEntities[j];
        const relType = this._detectRelationType(paragraph, source, target);
        const relKey = source.id + '->' + target.id + ':' + relType;
        const reverseKey = target.id + '->' + source.id + ':' + relType;

        if (this._relationKeyIndex.has(relKey) || this._relationKeyIndex.has(reverseKey)) {
          const existingId = this._relationKeyIndex.get(relKey) ?? this._relationKeyIndex.get(reverseKey);
          const existing = this._relations.get(existingId);
          if (existing) {
            existing.weight = Math.min(existing.weight + 0.1, 1.0);
          }
          continue;
        }

        const id = this._nextRelationId();
        const relation = {
          id,
          source: source.id,
          target: target.id,
          type: relType,
          weight: 0.3,
          evidence: paragraph.substring(0, 200),
        };

        this._relations.set(id, relation);
        this._relationKeyIndex.set(relKey, id);
        relations.push(relation);
      }
    }
  }

  _pruneWeakRelations(relations) {
    for (const relation of relations) {
      if (relation.weight < this._config.minRelationWeight) {
        this._relations.delete(relation.id);
        const fwdKey = relation.source + '->' + relation.target + ':' + relation.type;
        const revKey = relation.target + '->' + relation.source + ':' + relation.type;
        this._relationKeyIndex.delete(fwdKey);
        this._relationKeyIndex.delete(revKey);
      }
    }
  }

  _detectRelationType(paragraph, source, target) {
    const text = paragraph.toLowerCase();
    if (DEPENDS_KEYWORDS.test(text)) {
      const sourceIdx = text.indexOf(source.name.toLowerCase());
      const targetIdx = text.indexOf(target.name.toLowerCase());
      if (sourceIdx !== -1 && targetIdx !== -1 && sourceIdx < targetIdx) {
        return RELATION_TYPES.DEPENDS_ON;
      }
    }
    if (PART_OF_KEYWORDS.test(text)) {
      return RELATION_TYPES.PART_OF;
    }
    if (RELATED_KEYWORDS.test(text)) {
      return RELATION_TYPES.RELATED_TO;
    }
    return RELATION_TYPES.RELATED_TO;
  }

  /**
   * 基于连通分量检测构建实体聚类。按实体数量降序排列，
   * 超过最大聚类数时截断。
   *
   * @returns {{success: boolean, clusterCount?: number, error?: string}} 构建结果
   */
  buildClusters() {
    this.guardShutdown();

    try {
      this._clusters.clear();
      this._clusterIdCounter = 0;

      const adjacency = this._buildAdjacency();
      const communities = this._findConnectedComponents(adjacency);
      communities.sort((a, b) => b.length - a.length);

      let clusterCount = 0;
      for (const community of communities) {
        if (clusterCount >= this._config.maxClusters) break;
        const cluster = this._buildClusterFromCommunity(community);
        if (cluster) {
          this._clusters.set(cluster.id, cluster);
          clusterCount++;
        }
      }

      this._stats.clustersBuilt = this._clusters.size;
      this.emit('clusters-built', { clusterCount: this._clusters.size });
      return { success: true, clusterCount: this._clusters.size };
    } catch (err) {
      debug('GraphRAG', 'buildClusters', err);
      emitError(this, 'error', err);
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  _buildAdjacency() {
    const adjacency = new Map();
    for (const [entityId] of this._entities) {
      adjacency.set(entityId, new Set());
    }
    for (const [, relation] of this._relations) {
      const srcAdj = adjacency.get(relation.source);
      if (srcAdj) srcAdj.add(relation.target);
      const tgtAdj = adjacency.get(relation.target);
      if (tgtAdj) tgtAdj.add(relation.source);
    }
    return adjacency;
  }

  _findConnectedComponents(adjacency) {
    const visited = new Set();
    const communities = [];
    for (const [entityId] of this._entities) {
      if (visited.has(entityId)) continue;
      const community = [];
      const stack = [entityId];
      while (stack.length > 0) {
        const current = stack.pop();
        if (visited.has(current)) continue;
        visited.add(current);
        community.push(current);
        const neighbors = adjacency.get(current);
        if (neighbors) {
          for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
              stack.push(neighbor);
            }
          }
        }
      }
      if (community.length > 0) {
        communities.push(community);
      }
    }
    return communities;
  }

  _buildClusterFromCommunity(community) {
    const clusterEntities = [];
    const clusterDocIds = new Set();
    const clusterRelations = [];
    const communitySet = new Set(Array.isArray(community) ? community : []);

    for (const eid of community) {
      const entity = this._entities.get(eid);
      if (!entity) continue;
      clusterEntities.push(entity);
      for (const mention of Array.isArray(entity.mentions) ? entity.mentions : []) {
        clusterDocIds.add(mention.docId);
      }
    }

    for (const [, relation] of this._relations) {
      if (communitySet.has(relation.source) && communitySet.has(relation.target)) {
        clusterRelations.push(relation);
      }
    }

    const summary = this._generateClusterSummary(clusterEntities, clusterRelations);
    const clusterId = this._nextClusterId();
    return {
      id: clusterId,
      entities: clusterEntities,
      relations: clusterRelations,
      summary,
      documentIds: Array.from(clusterDocIds),
    };
  }

  _generateClusterSummary(entities, relations) {
    const entityNames = entities.slice(0, 10).map(e => e.name);
    const typeCounts = {};
    for (const entity of entities) {
      typeCounts[entity.type] = (typeCounts[entity.type] ?? 0) + 1;
    }

    const relTypeCounts = {};
    for (const relation of relations) {
      relTypeCounts[relation.type] = (relTypeCounts[relation.type] ?? 0) + 1;
    }

    const parts = [];
    if (entityNames.length > 0) {
      parts.push('Entities: ' + entityNames.join(', '));
    }
    const typeParts = Object.entries(typeCounts).map(([type, count]) => count + ' ' + type);
    if (typeParts.length > 0) {
      parts.push('Types: ' + typeParts.join(', '));
    }
    const relParts = Object.entries(relTypeCounts).map(([type, count]) => count + ' ' + type);
    if (relParts.length > 0) {
      parts.push('Relations: ' + relParts.join(', '));
    }

    return parts.join('. ');
  }

  /**
   * 执行图谱查询。从问题中提取实体，匹配已有实体后扩展子图，
   * 按相关性评分排序返回结果。score应为有限数值，非有限值在排序时视为0。
   *
   * @param {string} question - 查询问题
   * @param {Object} [options] - 查询选项
   * @param {number} [options.topK=5] - 返回结果数量上限
   * @param {number} [options.maxHops=2] - 子图扩展最大跳数
   * @param {number} [options.minRelevance=0.3] - 最低相关性阈值
   * @returns {Promise<{success: boolean, question?: string, results?: Array, paths?: Array, error?: string}>} 查询结果
   */
  async query(question, options) {
    this.guardShutdown();
    if (!question || typeof question !== 'string') return { success: false, error: 'question is required' };

    try {
      const topK = (options && options.topK) ?? 5;
      const maxHops = (options && options.maxHops) ?? 2;
      const minRelevance = (options && options.minRelevance) ?? 0.3;

      this._stats.queriesExecuted++;

      const graphifyResults = await this._queryWithGraphify(question, options);

      const queryEntities = this._extractQueryEntities(question);
      if (queryEntities.length === 0) {
        if (graphifyResults && graphifyResults.length > 0) {
          this.emit('query-executed', { question, resultCount: graphifyResults.length, source: 'graphify' });
          return { success: true, question, results: graphifyResults.map(r => ({ entity: r, score: 0.7, source: 'graphify' })), paths: [] };
        }
        return { success: true, question, results: [], paths: [] };
      }

      const matchedEntities = this._matchEntities(queryEntities);
      if (matchedEntities.length === 0) {
        if (graphifyResults && graphifyResults.length > 0) {
          this.emit('query-executed', { question, resultCount: graphifyResults.length, source: 'graphify' });
          return { success: true, question, results: graphifyResults.map(r => ({ entity: r, score: 0.7, source: 'graphify' })), paths: [] };
        }
        return { success: true, question, results: [], paths: [] };
      }

      const subGraph = this._expandSubGraph(matchedEntities, maxHops);
      const scored = this._scoreSubGraph(subGraph, matchedEntities);

      const results = scored
        .filter(s => s.score >= minRelevance)
        .sort((a, b) => (Number.isFinite(b.score) ? b.score : 0) - (Number.isFinite(a.score) ? a.score : 0))
        .slice(0, topK);

      const paths = this._extractPaths(matchedEntities, results, maxHops);

      this.emit('query-executed', { question, resultCount: results.length });
      return { success: true, question, results, paths };
    } catch (err) {
      debug('GraphRAG', 'query', err);
      emitError(this, 'error', err);
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  _extractQueryEntities(question) {
    const entities = [];
    const seen = new Set();

    const tryPush = (name, type) => {
      const n = _normalizeEntityName(name);
      const key = _makeEntityKey(n, type);
      if (!seen.has(key) && n.length > 1) {
        seen.add(key);
        entities.push({ name: n, type });
      }
    };

    let match;
    const personRegex = new RegExp(PERSON_PATTERN.source, PERSON_PATTERN.flags);
    while ((match = personRegex.exec(question)) !== null) {
      tryPush(match[0], ENTITY_TYPES.PERSON);
    }

    const orgRegex = new RegExp(ORG_PATTERN.source, ORG_PATTERN.flags);
    while ((match = orgRegex.exec(question)) !== null) {
      tryPush(match[0], ENTITY_TYPES.ORG);
    }

    const techRegex = new RegExp(TECH_PATTERN.source, TECH_PATTERN.flags);
    while ((match = techRegex.exec(question)) !== null) {
      tryPush(match[0], ENTITY_TYPES.TECH);
    }

    const conceptRegex = new RegExp(CONCEPT_PATTERN.source, CONCEPT_PATTERN.flags);
    while ((match = conceptRegex.exec(question)) !== null) {
      tryPush(match[0], ENTITY_TYPES.CONCEPT);
    }

    const upperWords = question.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [];
    for (const word of upperWords) {
      tryPush(word, ENTITY_TYPES.CONCEPT);
    }

    return entities;
  }

  _matchEntities(queryEntities) {
    const matched = [];
    const seen = new Set();

    for (const qe of queryEntities) {
      const exactKey = _makeEntityKey(qe.name, qe.type);
      if (this._entityKeyIndex.has(exactKey)) {
        const entityId = this._entityKeyIndex.get(exactKey);
        if (!seen.has(entityId)) {
          seen.add(entityId);
          matched.push({ entityId, score: 1.0 });
        }
        continue;
      }

      const qLower = qe.name.toLowerCase();
      for (const [id, entity] of this._entities) {
        if (seen.has(id)) continue;
        const eLower = entity.name.toLowerCase();
        if (eLower === qLower || (qLower.length >= 3 && eLower.indexOf(qLower) >= 0) || (eLower.length >= 3 && qLower.indexOf(eLower) >= 0)) {
          seen.add(id);
          matched.push({ entityId: id, score: 0.8 });
        }
      }
    }

    return matched;
  }

  _expandSubGraph(matchedEntities, maxHops) {
    const subGraphEntities = new Map();
    const subGraphRelations = [];
    const adjacency = new Map();

    for (const [, relation] of this._relations) {
      if (!adjacency.has(relation.source)) adjacency.set(relation.source, []);
      if (!adjacency.has(relation.target)) adjacency.set(relation.target, []);
      adjacency.get(relation.source).push({ neighbor: relation.target, relation });
      adjacency.get(relation.target).push({ neighbor: relation.source, relation });
    }

    const visited = new Set();
    const queue = [];

    for (const me of matchedEntities) {
      queue.push({ entityId: me.entityId, hops: 0 });
    }

    while (queue.length > 0) {
      const { entityId, hops } = queue.shift();
      if (visited.has(entityId)) continue;
      visited.add(entityId);

      const entity = this._entities.get(entityId);
      if (entity) {
        subGraphEntities.set(entityId, { entity, distance: hops });
      }

      if (hops < maxHops) {
        const edges = adjacency.get(entityId) ?? [];
        for (const edge of edges) {
          if (!visited.has(edge.neighbor)) {
            subGraphRelations.push(edge.relation);
            queue.push({ entityId: edge.neighbor, hops: hops + 1 });
          }
        }
      }
    }

    const uniqueRelations = [];
    const seenRelIds = new Set();
    for (const r of subGraphRelations) {
      if (!seenRelIds.has(r.id) && subGraphEntities.has(r.source) && subGraphEntities.has(r.target)) {
        seenRelIds.add(r.id);
        uniqueRelations.push(r);
      }
    }

    return { entities: subGraphEntities, relations: uniqueRelations };
  }

  _scoreSubGraph(subGraph, matchedEntities) {
    const matchSet = new Map();
    for (const me of matchedEntities) {
      matchSet.set(me.entityId, me.score);
    }

    const scored = [];
    for (const [entityId, info] of subGraph.entities) {
      let score = 0;

      if (matchSet.has(entityId)) {
        score = matchSet.get(entityId);
      } else {
        const distance = Math.max(Number.isFinite(info.distance) ? info.distance : 1, 1);
        score = 0.5 / distance;
      }

      const entity = info.entity;
      const relationBoost = this._getRelationWeight(entityId, subGraph.relations);
      score += relationBoost * 0.2;

      const docIds = new Set();
      for (const mention of Array.isArray(entity.mentions) ? entity.mentions : []) {
        docIds.add(mention.docId);
      }

      scored.push({
        entityId,
        entity,
        score: Math.min(score, 1.0),
        documentIds: Array.from(docIds),
        distance: info.distance,
      });
    }

    return scored;
  }

  _getRelationWeight(entityId, relations) {
    let totalWeight = 0;
    for (const relation of relations) {
      if (relation.source === entityId || relation.target === entityId) {
        totalWeight += relation.weight;
      }
    }
    return totalWeight;
  }

  _extractPaths(matchedEntities, results, _maxHops) {
    const paths = [];
    const matchIds = new Set(matchedEntities.map(m => m.entityId));

    for (const result of results) {
      if (matchIds.has(result.entityId)) continue;
      if (result.distance <= 0) continue;

      const pathEntities = [result.entity];
      let current = result.entityId;
      const visited = new Set();

      for (let hop = 0; hop < result.distance; hop++) {
        visited.add(current);
        let found = false;
        for (const [, relation] of this._relations) {
          const nextId = relation.source === current ? relation.target : (relation.target === current ? relation.source : null);
          if (!nextId || visited.has(nextId)) continue;
          const nextEntity = this._entities.get(nextId);
          if (!nextEntity) continue;
          pathEntities.push(nextEntity);
          current = nextId;
          found = true;
          break;
        }
        if (!found) break;
      }

      if (pathEntities.length > 1) {
        paths.push({
          from: pathEntities[pathEntities.length - 1].name,
          to: result.entity.name,
          length: pathEntities.length - 1,
          entities: pathEntities,
        });
      }
    }

    return paths.slice(0, 10);
  }

  /**
   * 获取指定实体周围的子图。BFS扩展指定深度，返回中心实体、
   * 邻居实体和关联关系。
   *
   * @param {string} entityId - 中心实体ID
   * @param {number} [depth=1] - 扩展深度
   * @returns {{success: boolean, center?: Object, entities?: Array, relations?: Array, error?: string}} 子图数据
   */
  getEntityGraph(entityId, depth) {
    this.guardShutdown();
    if (!entityId || !this._entities.has(entityId)) {
      return { success: false, error: 'Entity not found' };
    }

    const maxDepth = depth ?? 1;
    const entity = this._entities.get(entityId);
    const visitedEntities = new Map();
    const visitedRelations = new Set();
    const collectedRelations = [];

    const queue = [{ id: entityId, currentDepth: 0 }];
    visitedEntities.set(entityId, entity);

    while (queue.length > 0) {
      const { id, currentDepth } = queue.shift();
      if (currentDepth >= maxDepth) continue;

      for (const [, relation] of this._relations) {
        let neighborId = null;
        if (relation.source === id) {
          neighborId = relation.target;
        } else if (relation.target === id) {
          neighborId = relation.source;
        }
        if (neighborId === null) continue;
        if (visitedRelations.has(relation.id)) continue;
        visitedRelations.add(relation.id);
        collectedRelations.push(relation);

        if (!visitedEntities.has(neighborId)) {
          const neighbor = this._entities.get(neighborId);
          if (neighbor) {
            visitedEntities.set(neighborId, neighbor);
            queue.push({ id: neighborId, currentDepth: currentDepth + 1 });
          }
        }
      }
    }

    return {
      success: true,
      center: { ...entity },
      entities: Array.from(visitedEntities.values()).map(e => ({ ...e })),
      relations: collectedRelations.map(r => ({ ...r })),
    };
  }

  /**
   * 获取所有已构建的聚类列表。
   *
   * @returns {Array<Object>} 聚类对象数组
   */
  getClusters() {
    this.guardShutdown();
    return Array.from(this._clusters.values()).map(c => ({ ...c, entityIds: c.entityIds ? [...c.entityIds] : [] }));
  }

  /**
   * 获取GraphRAG引擎统计信息。
   *
   * @returns {Object} 统计快照，包含文档/实体/关系/聚类的累计和当前数量及配置
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('GraphRAG', 'getStats', _e && _e.message ? _e.message : String(_e)); return { documentsIngested: 0, entitiesExtracted: 0, relationsExtracted: 0, clustersBuilt: 0, queriesExecuted: 0, graphifyQueries: 0, currentEntities: 0, currentRelations: 0, currentClusters: 0, currentDocuments: 0, config: {} }; }
    return {
      documentsIngested: this._stats.documentsIngested,
      entitiesExtracted: this._stats.entitiesExtracted,
      relationsExtracted: this._stats.relationsExtracted,
      clustersBuilt: this._stats.clustersBuilt,
      queriesExecuted: this._stats.queriesExecuted,
      graphifyQueries: this._stats.graphifyQueries,
      currentEntities: this._entities.size,
      currentRelations: this._relations.size,
      currentClusters: this._clusters.size,
      currentDocuments: this._documents.size,
      config: safeAssign({}, this._config),
    };
  }

  /**
   * 挂载嵌入服务实例，用于向量增强检索。
   *
   * @param {Object} service - EmbeddingService实例
   * @returns {GraphRAG} 当前实例，支持链式调用
   */
  attachEmbeddingService(service) {
    if (!service) return this;
    this._embeddingService = service;
    return this;
  }

  /**
   * 挂载向量索引实例，用于向量相似度搜索。
   *
   * @param {Object} index - CausalVectorIndex实例
   * @returns {GraphRAG} 当前实例，支持链式调用
   */
  attachVectorIndex(index) {
    if (!index) return this;
    this._vectorIndex = index;
    return this;
  }

  attachGraphifyCompiler(compiler) {
    if (!compiler) return this;
    this._graphifyCompiler = compiler;
    return this;
  }

  async _queryWithGraphify(question, options) {
    if (!this._graphifyCompiler) return null;

    try {
      const queryEntities = this._extractQueryEntities(question);
      if (queryEntities.length === 0) return null;

      const graphifyResults = [];
      for (let i = 0; i < queryEntities.length; i++) {
        const qe = queryEntities[i];
        const nameResult = await this._graphifyCompiler.query({ name: qe.name, limit: (options && options.topK) ?? 5 });
        if (nameResult && nameResult.results) {
          for (let j = 0; j < nameResult.results.length; j++) {
            graphifyResults.push(nameResult.results[j]);
          }
        }
      }

      if (graphifyResults.length === 0) return null;

      this._stats.graphifyQueries++;
      return graphifyResults;
    } catch (err) {
      debug('GraphRAG', '_queryWithGraphify', err);
      return { _error: err.message || String(err) };
    }
  }

  _removeDocumentEntities(docId) {
    const entityIdsToRemove = [];
    for (const [id, entity] of this._entities) {
      const remaining = entity.mentions.filter(m => m.docId !== docId);
      if (remaining.length === 0) {
        entityIdsToRemove.push(id);
      } else {
        entity.mentions = remaining;
      }
    }

    for (const eid of entityIdsToRemove) {
      const entity = this._entities.get(eid);
      if (entity) {
        const key = _makeEntityKey(entity.name, entity.type);
        this._entityKeyIndex.delete(key);
      }
      this._entities.delete(eid);
    }

    const entityIdsToRemoveSet = new Set(entityIdsToRemove);
    const relationIdsToRemove = [];
    for (const [rid, relation] of this._relations) {
      if (entityIdsToRemoveSet.has(relation.source) || entityIdsToRemoveSet.has(relation.target)) {
        relationIdsToRemove.push(rid);
      }
    }

    for (const rid of relationIdsToRemove) {
      const relation = this._relations.get(rid);
      if (relation) {
        const key = relation.source + '->' + relation.target + ':' + relation.type;
        this._relationKeyIndex.delete(key);
      }
      this._relations.delete(rid);
    }

    this._documents.delete(docId);
  }

  _nextEntityId() {
    return 'ent_' + (++this._entityIdCounter);
  }

  _nextRelationId() {
    return 'rel_' + (++this._relationIdCounter);
  }

  _nextClusterId() {
    return 'cluster_' + (++this._clusterIdCounter);
  }

  _onShutdown() {
    this._entities.clear();
    this._entityKeyIndex.clear();
    this._relations.clear();
    this._relationKeyIndex.clear();
    this._clusters.clear();
    this._documents.clear();
    this._embeddingService = null;
    this._vectorIndex = null;
    this._graphifyCompiler = null;
    this._entityIdCounter = 0;
    this._relationIdCounter = 0;
    this._clusterIdCounter = 0;
    this._stats = {
      documentsIngested: 0,
      entitiesExtracted: 0,
      relationsExtracted: 0,
      clustersBuilt: 0,
      queriesExecuted: 0,
      graphifyQueries: 0,
    };
    this.removeAllListeners();
  }
}

module.exports = withShutdown(GraphRAG);
