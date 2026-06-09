'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { safeCall } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const { generateId } = require('../../utils/constants');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');

/**
 * 关系类型枚举，定义知识图谱中实体间的基本关系
 * @enum {string}
 */
const RELATION_TYPES = {
  IS_A: 'is_a',           // 分类关系（A是B的一种）
  PART_OF: 'part_of',     // 组成关系（A是B的一部分）
  DEPENDS_ON: 'depends_on', // 依赖关系（A依赖B）
  PRODUCES: 'produces',   // 产出关系（A产出B）
  USES: 'uses',           // 使用关系（A使用B）
  RELATES_TO: 'relates_to', // 关联关系（A与B相关）
  CONTRADICTS: 'contradicts', // 矛盾关系（A与B矛盾）
  SUPPORTS: 'supports',   // 支持关系（A支持B）
};

/** 关系类型值集合，用于快速校验 */
const RELATION_TYPE_VALUES = new Set(Object.values(RELATION_TYPES));

/**
 * 默认配置
 * @constant
 */
const DEFAULT_CONFIG = {
  maxEntities: 5000,
  maxRelations: 10000,
  maxQueryDepth: 5,
  enableAutoIndex: true,
  persistToDisk: false,
  persistPath: null,
};

/**
 * @module runtime/thought/knowledge-graph-store
 * @classdesc 知识图谱存储
 * KnowledgeGraphStore — 基于三元组的知识图谱存储
 *
 * 融合Vibe Coding "MemoryPlus"技能的核心能力（三元组知识图谱）到Harness框架中。
 * 以Entity-Relation-Entity三元组为基础，提供结构化知识表示与多跳推理能力。
 * 弥补Harness现有MemoryPipeline/BrainMemory/LLMWiki缺乏三元组建模和图查询的不足。
 *
 * 核心特性：
 * - 三元组建模：实体-关系-实体的结构化知识表示
 * - 多跳推理：基于BFS的图遍历查询，支持路径发现
 * - 传递推理：对IS_A/DEPENDS_ON/PART_OF等关系进行传递推理
 * - 双向索引：主体索引+客体索引，支持高效的正向/反向查询
 * - 容量限制：基于BoundedMap/BoundedArray的自动淘汰机制 *
 * @extends EventEmitter
 * @emits KnowledgeGraphStore#entity-added
 * @emits KnowledgeGraphStore#relation-added
 * @emits KnowledgeGraphStore#error
 *
 * @example
 * const KnowledgeGraphStore = require('./knowledge-graph-store');
 * const kg = new KnowledgeGraphStore({ maxEntities: 1000 });
 *
 * // 添加三元组
 * kg.addTriple('Node.js', 'is_a', 'Runtime', { subjectType: 'technology' });
 * kg.addTriple('Express', 'depends_on', 'Node.js');
 * kg.addTriple('Harness', 'uses', 'Node.js');
 *
 * // 多跳查询
 * const result = kg.query('Express', { maxDepth: 2, direction: 'both' });
 * console.log(result.paths);
 *
 * // 传递推理
 * const inferred = kg.inferRelations('Express');
 *
 * // 导出为三元组
 * const triples = kg.exportAsTriples();
 */
class KnowledgeGraphStore extends EventEmitter {
  /**
   * 创建知识图谱存储实例
   * @param {Object} [options={}] - 配置选项
   * @param {number} [options.maxEntities=5000] - 最大实体数量
   * @param {number} [options.maxRelations=10000] - 最大关系数量
   * @param {number} [options.maxQueryDepth=5] - 最大查询深度
   * @param {boolean} [options.enableAutoIndex=true] - 是否启用自动索引
   * @param {boolean} [options.persistToDisk=false] - 是否持久化到磁盘
   * @param {string|null} [options.persistPath=null] - 持久化路径   */
  constructor(options = {}) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);

    // 实体存储：entityId → { id, name, type, attributes, createdAt, updatedAt }
    this._entities = new BoundedMap(this._config.maxEntities);

    // 关系存储：三元组数组 [{ id, subject, predicate, object, confidence, source, createdAt }]
    this._relations = new BoundedArray(this._config.maxRelations);

    // 索引：加速图查询
    this._subjectIndex = new Map();   // subjectId → Set<relationIndex>
    this._objectIndex = new Map();    // objectId → Set<relationIndex>
    this._predicateIndex = new Map(); // predicate → Set<relationIndex>

    // 统计信息
    this._stats = {
      entitiesAdded: 0,
      relationsAdded: 0,
      queriesExecuted: 0,
      avgQueryDepth: 0,
    };

    // 依赖注入标记
    this._attached = { memoryStore: false, embeddingService: false };
    this._ms = null; // MemoryStore实例
    this._es = null; // EmbeddingService实例
  }

  /**
   * 注入MemoryStore依赖，用于知识持久化
   * @param {Object} store - MemoryStore实例，需提供storeExperience方法
   * @returns {KnowledgeGraphStore} 当前实例，支持链式调用
   * @throws {TypeError} store缺少storeExperience方法时抛出
   */
  attachMemoryStore(store) {
    this.guardShutdown();
    if (!store || typeof store.storeExperience !== 'function') {
      throw new TypeError('MemoryStore must implement storeExperience()');
    }
    this._ms = store;
    this._attached.memoryStore = true;
    debug('KnowledgeGraphStore', 'attachMemoryStore', 'attached');
    return this;
  }

  /**
   * 注入EmbeddingService依赖，用于语义相似度计算
   * @param {Object} service - EmbeddingService实例，需提供embed方法
   * @returns {KnowledgeGraphStore} 当前实例，支持链式调用
   * @throws {TypeError} service缺少embed方法时抛出
   */
  attachEmbeddingService(service) {
    this.guardShutdown();
    if (!service || typeof service.embed !== 'function') {
      throw new TypeError('EmbeddingService must implement embed()');
    }
    this._es = service;
    this._attached.embeddingService = true;
    debug('KnowledgeGraphStore', 'attachEmbeddingService', 'attached');
    return this;
  }

  /**
   * 添加实体到知识图谱
   * @param {string} name - 实体名称
   * @param {string} [type='concept'] - 实体类型
   * @param {Object} [attributes={}] - 实体属性
   * @returns {Object} 创建的实体对象 { id, name, type, attributes, createdAt, updatedAt }
   * @fires KnowledgeGraphStore#entity-added
   */
  addEntity(name, type = 'concept', attributes = {}) {
    this.guardShutdown();
    if (!name || typeof name !== 'string') {
      debug('KnowledgeGraphStore', 'addEntity', 'invalid name: ' + name);
      return null;
    }

    const entityId = generateId('ent-');
    const now = Date.now();
    const entity = {
      id: entityId,
      name,
      type,
      attributes: { ...attributes },
      createdAt: now,
      updatedAt: now,
    };

    this._entities.set(entityId, entity);
    this._stats.entitiesAdded++;

    // 自动索引：如果启用，检查已有关系是否涉及此实体
    if (this._config.enableAutoIndex) {
      this._updateIndicesForEntity(entityId);
    }

    this.emit('entity-added', { entityId, name, type });
    return entity;
  }

  /**
   * 根据ID获取实体
   * @param {string} entityId - 实体ID
   * @returns {Object|null} 实体对象，未找到返回null
   */
  getEntity(entityId) {
    if (this._shutDown) return null;
    const e = this._entities.get(entityId);
    return e ? { ...e, attributes: { ...e.attributes } } : null;
  }

  /**
   * 按名称查找实体（不区分大小写的部分匹配）
   * @param {string} name - 搜索名称
   * @returns {Array<Object>} 匹配的实体数组
   */
  findEntitiesByName(name) {
    if (this._shutDown || !name) return [];
    const lowerName = name.toLowerCase();
    const results = [];
    this._entities.forEach(entity => {
      if (entity && entity.name && entity.name.toLowerCase().includes(lowerName)) {
        results.push({ ...entity, attributes: { ...entity.attributes } });
      }
    });
    return results;
  }

  /**
   * 按类型查找实体
   * @param {string} type - 实体类型
   * @returns {Array<Object>} 匹配的实体数组
   */
  findEntitiesByType(type) {
    if (this._shutDown || !type) return [];
    const results = [];
    this._entities.forEach(entity => {
      if (entity && entity.type === type) {
        results.push(entity);
      }
    });
    return results;
  }

  /**
   * 添加关系（三元组）到知识图谱
   * @param {string} subjectId - 主体实体ID
   * @param {string} predicate - 关系谓词，须为RELATION_TYPES中的值
   * @param {string} objectId - 客体实体ID
   * @param {Object} [options={}] - 关系选项
   * @param {number} [options.confidence=1.0] - 置信度（0-1范围）   * @param {string} [options.source='manual'] - 来源标记
   * @returns {Object|null} 创建的关系对象，校验失败返回null
   * @fires KnowledgeGraphStore#relation-added
   */
  addRelation(subjectId, predicate, objectId, options = {}) {
    this.guardShutdown();

    // 校验主体和客体实体存在
    if (!this._entities.has(subjectId)) {
      debug('KnowledgeGraphStore', 'addRelation', 'subject not found: ' + subjectId);
      return null;
    }
    if (!this._entities.has(objectId)) {
      debug('KnowledgeGraphStore', 'addRelation', 'object not found: ' + objectId);
      return null;
    }

    // 校验谓词合法性
    if (!RELATION_TYPE_VALUES.has(predicate)) {
      debug('KnowledgeGraphStore', 'addRelation', 'invalid predicate: ' + predicate);
      return null;
    }

    const relation = {
      id: generateId('rel-'),
      subject: subjectId,
      predicate,
      object: objectId,
      confidence: options.confidence ?? 1.0,
      source: options.source || 'manual',
      createdAt: Date.now(),
    };

    this._relations.push(relation);

    // 使用relation.id而非BoundedArray索引，避免索引碰撞
    this._addToIndex(this._subjectIndex, subjectId, relation.id);
    this._addToIndex(this._objectIndex, objectId, relation.id);
    this._addToIndex(this._predicateIndex, predicate, relation.id);

    this._stats.relationsAdded++;
    this.emit('relation-added', { relationId: relation.id, subjectId, predicate, objectId });
    return relation;
  }

  /**
   * 便捷方法：一次性添加主体实体、客体实体和关系
   * @param {string} subjectName - 主体实体名称
   * @param {string} predicate - 关系谓词
   * @param {string} objectName - 客体实体名称
   * @param {Object} [options={}] - 选项
   * @param {string} [options.subjectType='concept'] - 主体实体类型
   * @param {string} [options.objectType='concept'] - 客体实体类型
   * @param {number} [options.confidence=1.0] - 置信度
   * @param {string} [options.source='manual'] - 来源标记
   * @returns {Object|null} { subject, object, relation }，失败返回null
   */
  addTriple(subjectName, predicate, objectName, options = {}) {
    this.guardShutdown();
    if (!subjectName || !predicate || !objectName) {
      debug('KnowledgeGraphStore', 'addTriple', 'missing required params');
      return null;
    }

    // 添加主体实体（如已存在同名实体则复用）
    const subject = this._findOrCreateEntity(subjectName, options.subjectType || 'concept');
    const object = this._findOrCreateEntity(objectName, options.objectType || 'concept');

    if (!subject || !object) return null;

    const relation = this.addRelation(subject.id, predicate, object.id, options);
    if (!relation) return null;

    return { subject, object, relation };
  }

  /**
   * 获取从指定主体出发的关系，可按谓词过滤   * @param {string} subjectId - 主体实体ID
   * @param {string} [predicate=null] - 可选的谓词过滤
   * @returns {Array<Object>} 关系数组
   */
  getRelations(subjectId, predicate = null) {
    if (this._shutDown) return [];
    const indices = this._subjectIndex.get(subjectId);
    if (!indices || indices.size === 0) return [];

    const results = [];
    for (const idx of indices) {
      const rel = this._findRelationById(idx);
      if (rel && (!predicate || rel.predicate === predicate)) {
        results.push({ ...rel });
      }
    }
    return results;
  }

  /**
   * 获取指向指定实体的入边关系   * @param {string} entityId - 实体ID
   * @returns {Array<Object>} 入边关系数组
   */
  getIncomingRelations(entityId) {
    if (this._shutDown) return [];
    const indices = this._objectIndex.get(entityId);
    if (!indices || indices.size === 0) return [];

    const results = [];
    for (const idx of indices) {
      const rel = this._findRelationById(idx);
      if (rel) results.push({ ...rel });
    }
    return results;
  }

  /**
   * 获取指定实体的邻居实体（N跳以内）
   * @param {string} entityId - 起始实体ID
   * @param {number} [depth=1] - 遍历深度
   * @returns {Set<string>} 可达实体ID集合
   */
  getNeighbors(entityId, depth = 1) {
    if (this._shutDown) return new Set();
    const visited = new Set();
    const queue = [{ id: entityId, d: 0 }];
    visited.add(entityId);

    while (queue.length > 0) {
      const { id, d } = queue.shift();
      if (d >= depth) continue;

      // 正向邻居（主体→客体）
      const outIndices = this._subjectIndex.get(id);
      if (outIndices) {
        for (const idx of outIndices) {
          const rel = this._findRelationById(idx);
          if (rel && !visited.has(rel.object)) {
            visited.add(rel.object);
            queue.push({ id: rel.object, d: d + 1 });
          }
        }
      }

      // 反向邻居（客体→主体）
      const inIndices = this._objectIndex.get(id);
      if (inIndices) {
        for (const idx of inIndices) {
          const rel = this._findRelationById(idx);
          if (rel && !visited.has(rel.subject)) {
            visited.add(rel.subject);
            queue.push({ id: rel.subject, d: d + 1 });
          }
        }
      }
    }

    return visited;
  }

  /**
   * 多跳图查询（核心特性：多跳推理能力）
   *
   * 从起始实体出发，沿关系图进行BFS遍历，发现所有可达路径。
   * 支持谓词过滤、方向控制、置信度过滤和深度限制。
   *
   * @param {string} startEntityId - 起始实体ID
   * @param {Object} [options={}] - 查询选项
   * @param {string} [options.predicate] - 谓词过滤
   * @param {number} [options.maxDepth] - 最大遍历深度
   * @param {string} [options.direction='outgoing'] - 遍历方向：outgoing'|'incoming'|'both'
   * @param {number} [options.minConfidence=0] - 最低置信度阈值   * @returns {Object} { paths: [{ entities, relations, length }], discoveredEntities: Set, totalPaths: number }
   */
  query(startEntityId, options = {}) {
    this.guardShutdown();
    if (!this._entities.has(startEntityId)) {
      return { paths: [], discoveredEntities: new Set(), totalPaths: 0 };
    }

    const predicate = options.predicate ?? null;
    const maxDepth = Math.min(options.maxDepth ?? this._config.maxQueryDepth, this._config.maxQueryDepth);
    const direction = options.direction || 'outgoing';
    const minConfidence = options.minConfidence ?? 0;

    const paths = [];
    const discoveredEntities = new Set();
    let totalDepth = 0;

    // BFS队列：每项包含当前实体ID和到达该实体的路径
    const queue = [{ entityId: startEntityId, pathEntities: [startEntityId], pathRelations: [] }];
    const visited = new Set();
    visited.add(startEntityId);
    discoveredEntities.add(startEntityId);

    while (queue.length > 0) {
      const { entityId, pathEntities, pathRelations } = queue.shift();
      const currentDepth = pathRelations.length;

      if (currentDepth >= maxDepth) continue;

      // 收集下一步可达的关系
      const nextSteps = this._getNextSteps(entityId, direction, predicate, minConfidence);

      for (const { relation, nextEntityId } of nextSteps) {
        if (visited.has(nextEntityId)) continue;
        visited.add(nextEntityId);
        discoveredEntities.add(nextEntityId);

        const newPathEntities = [...pathEntities, nextEntityId];
        const newPathRelations = [...pathRelations, relation];

        paths.push({
          entities: newPathEntities.map(id => this._entities.get(id)).filter(Boolean),
          relations: [...newPathRelations],
          length: newPathRelations.length,
        });

        totalDepth += newPathRelations.length;
        queue.push({ entityId: nextEntityId, pathEntities: newPathEntities, pathRelations: newPathRelations });
      }
    }

    // 更新统计
    this._stats.queriesExecuted++;
    if (paths.length > 0) {
      this._stats.avgQueryDepth = totalDepth / paths.length;
    }

    return { paths, discoveredEntities, totalPaths: paths.length };
  }

  /**
   * 查找两个实体间的最短路径（双向BFS算法）
   * @param {string} fromEntityId - 起始实体ID
   * @param {string} toEntityId - 目标实体ID
   * @param {Object} [options={}] - 查询选项
   * @param {number} [options.maxDepth] - 最大搜索深度
   * @param {string} [options.predicate] - 谓词过滤
   * @returns {Object} { found: boolean, path?: { entities, relations }, length?: number }
   */
  findPath(fromEntityId, toEntityId, options = {}) {
    this.guardShutdown();
    if (!this._entities.has(fromEntityId) || !this._entities.has(toEntityId)) {
      return { found: false };
    }
    if (fromEntityId === toEntityId) {
      return { found: true, path: { entities: [this._entities.get(fromEntityId)], relations: [] }, length: 0 };
    }

    const maxDepth = Math.min(options.maxDepth ?? this._config.maxQueryDepth, this._config.maxQueryDepth);
    const predicate = options.predicate ?? null;

    // 正向BFS：从from出发
    const forwardVisited = new Map(); // entityId → { parent, relation }
    forwardVisited.set(fromEntityId, null);

    // 反向BFS：从to出发
    const backwardVisited = new Map();
    backwardVisited.set(toEntityId, null);

    let forwardQueue = [fromEntityId];
    let backwardQueue = [toEntityId];
    let depth = 0;

    while (forwardQueue.length > 0 && backwardQueue.length > 0 && depth < maxDepth) {
      depth++;

      // 扩展正向层
      const nextForward = [];
      for (const entityId of forwardQueue) {
        const outRels = this._getOutgoingRelations(entityId, predicate);
        for (const rel of outRels) {
          if (!forwardVisited.has(rel.object)) {
            forwardVisited.set(rel.object, { parent: entityId, relation: rel });
            nextForward.push(rel.object);
            // 检查是否与反向相遇
            if (backwardVisited.has(rel.object)) {
              return this._reconstructPath(fromEntityId, toEntityId, rel.object, forwardVisited, backwardVisited);
            }
          }
        }
      }
      forwardQueue = nextForward;

      // 扩展反向层
      const nextBackward = [];
      for (const entityId of backwardQueue) {
        const inRels = this._getIncomingRelationsFiltered(entityId, predicate);
        for (const rel of inRels) {
          if (!backwardVisited.has(rel.subject)) {
            backwardVisited.set(rel.subject, { parent: entityId, relation: rel });
            nextBackward.push(rel.subject);
            // 检查是否与正向相遇
            if (forwardVisited.has(rel.subject)) {
              return this._reconstructPath(fromEntityId, toEntityId, rel.subject, forwardVisited, backwardVisited);
            }
          }
        }
      }
      backwardQueue = nextBackward;
    }

    return { found: false };
  }

  /**
   * 提取包含指定实体及其相互关系的子图   * @param {Array<string>} entityIds - 实体ID数组
   * @returns {Object} { entities: [...], relations: [...] }
   */
  getSubgraph(entityIds) {
    if (this._shutDown || !Array.isArray(entityIds)) {
      return { entities: [], relations: [] };
    }

    const idSet = new Set(entityIds);
    const entities = [];
    const relations = [];

    // 收集指定范围内的实体
    for (const id of idSet) {
      const entity = this._entities.get(id);
      if (entity) entities.push(entity);
    }

    // 收集两端都在范围内的关系
    const allRelations = this._relations.toArray();
    for (const rel of allRelations) {
      if (idSet.has(rel.subject) && idSet.has(rel.object)) {
        relations.push(rel);
      }
    }

    return { entities, relations };
  }

  /**
   * 基本推理：通过传递链发现隐含关系
   *
   * 支持的传递关系类型：
   * - IS_A：A is_a B, B is_a C ⇒ A is_a C
   * - DEPENDS_ON：A depends_on B, B depends_on C ⇒ A depends_on C
   * - PART_OF：A part_of B, B part_of C ⇒ A part_of C
   *
   * @param {string} entityId - 起始实体ID
   * @returns {Array<Object>} 推理出的隐含关系数组（未添加到图谱，仅返回）
   */
  inferRelations(entityId) {
    this.guardShutdown();
    if (!this._entities.has(entityId)) return [];

    // 支持传递推理的关系类型
    const transitivePredicates = new Set([
      RELATION_TYPES.IS_A,
      RELATION_TYPES.DEPENDS_ON,
      RELATION_TYPES.PART_OF,
    ]);

    const inferred = [];

    for (const predicate of transitivePredicates) {
      // 沿传递链BFS收集所有可达实体
      const visited = new Set();
      const queue = [entityId];
      visited.add(entityId);

      while (queue.length > 0) {
        const currentId = queue.shift();
        const outRels = this.getRelations(currentId, predicate);

        for (const rel of outRels) {
          if (!visited.has(rel.object)) {
            visited.add(rel.object);
            queue.push(rel.object);

            // 跳过直接关系（只返回推理出的间接关系）
            if (currentId !== entityId) {
              const subjectEntity = this._entities.get(entityId);
              const objectEntity = this._entities.get(rel.object);
              inferred.push({
                subject: entityId,
                predicate,
                object: rel.object,
                confidence: rel.confidence * 0.9, // 传递推理置信度衰减
                source: 'inferred',
                subjectName: subjectEntity ? subjectEntity.name : null,
                objectName: objectEntity ? objectEntity.name : null,
              });
            }
          }
        }
      }
    }

    return inferred;
  }

  /**
   * 导出所有数据为三元组数组
   * @returns {Array<Object>} 三元组数组 [{ subject, predicate, object, confidence }]
   */
  exportAsTriples() {
    if (this._shutDown) return [];
    const allRelations = this._relations.toArray();
    return allRelations.map(r => ({
      subject: this._entities.get(r.subject)?.name ?? null,
      predicate: r.predicate,
      object: this._entities.get(r.object)?.name ?? null,
      confidence: r.confidence,
    })).filter(t => t.subject !== null && t.object !== null);
  }

  /**
   * 从三元组数组导入数据
   * @param {Array<Object>} triples - 三元组数组 [{ subject, predicate, object, confidence?, source?, subjectType?, objectType? }]
   * @returns {Object} { entitiesAdded, relationsAdded }
   */
  importFromTriples(triples) {
    this.guardShutdown();
    if (!Array.isArray(triples)) return { entitiesAdded: 0, relationsAdded: 0 };

    let entitiesAdded = 0;
    let relationsAdded = 0;

    for (const triple of triples) {
      if (!triple.subject || !triple.predicate || !triple.object) continue;

      const result = this.addTriple(triple.subject, triple.predicate, triple.object, {
        confidence: triple.confidence,
        source: triple.source || 'import',
        subjectType: triple.subjectType,
        objectType: triple.objectType,
      });

      if (result) {
        entitiesAdded++; // addTriple内部可能复用已有实体，此处简化计数
        relationsAdded++;
      }
    }

    return { entitiesAdded, relationsAdded };
  }

  /**
   * 获取统计信息和图谱指标
   * @returns {Object} 统计对象，包含实体数、关系数、平均度、密度等
   */
  getStats() {
    if (this._shutDown) {
      return { entitiesAdded: 0, relationsAdded: 0, queriesExecuted: 0, avgQueryDepth: 0, entityCount: 0, relationCount: 0, avgDegree: 0, density: 0 };
    }

    const entityCount = this._entities.size;
    const relationCount = this._relations.length;

    // 平均度：每个实体的平均关系数（入度+出度）
    const avgDegree = entityCount > 0
      ? (relationCount * 2) / entityCount
      : 0;

    // 图密度：实际关系数 / 最大可能关系数（有向图，不含自环）
    const maxPossible = entityCount * (entityCount - 1);
    const density = maxPossible > 0
      ? relationCount / maxPossible
      : 0;

    return {
      entitiesAdded: this._stats.entitiesAdded,
      relationsAdded: this._stats.relationsAdded,
      queriesExecuted: this._stats.queriesExecuted,
      avgQueryDepth: this._stats.avgQueryDepth,
      entityCount,
      relationCount,
      avgDegree: Math.round(avgDegree * 100) / 100,
      density: Math.round(density * 10000) / 10000,
    };
  }

  // ─── 私有方法 ────────────────────────────────────────────────

  /**
   * 查找或创建实体：按名称查找已有实体，不存在则创建
   * @param {string} name - 实体名称
   * @param {string} type - 实体类型
   * @returns {Object|null} 实体对象
   * @private
   */
  _findOrCreateEntity(name, type) {
    // 按名称精确匹配查找已有实体
    const existing = this.findEntitiesByName(name);
    const exactMatch = existing.find(e => e.name === name);
    if (exactMatch) return exactMatch;

    // 不存在则创建新实体
    return this.addEntity(name, type);
  }

  /**
   * 为实体更新索引（自动索引时使用）
   * @param {string} entityId - 实体ID
   * @private
   */
  _updateIndicesForEntity(_entityId) {
    // 遍历关系，检查是否有涉及此实体的关系需要更新索引
    // 由于新添加实体时不太可能已有关系引用它，此方法为预留扩展
  }

  /**
   * 向索引中添加条目
   * @param {Map} index - 索引Map
   * @param {string} key - 索引键
   * @param {number} relationIndex - 关系在_relations中的位置
   * @private
   */
  _findRelationById(id) {
    const arr = this._relations.toArray();
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === id) return arr[i];
    }
    return undefined;
  }

  /**
   * @private
   */
  _addToIndex(index, key, relationIndex) {
    let set = index.get(key);
    if (!set) {
      set = new Set();
      index.set(key, set);
    }
    set.add(relationIndex);
    // 索引容量保护：单个键的索引集超过上限时截断
    if (set.size > 500) {
      const arr = Array.from(set);
      const trimmed = new Set(arr.slice(-250));
      index.set(key, trimmed);
    }
  }

  /**
   * 获取从指定实体出发的下一步可达关系和目标实体
   * @param {string} entityId - 当前实体ID
   * @param {string} direction - 遍历方向
   * @param {string|null} predicate - 谓词过滤
   * @param {number} minConfidence - 最低置信度
   * @returns {Array<{relation: Object, nextEntityId: string}>}
   * @private
   */
  _getNextSteps(entityId, direction, predicate, minConfidence) {
    const steps = [];

    // 正向出边
    if (direction === 'outgoing' || direction === 'both') {
      const outIndices = this._subjectIndex.get(entityId);
      if (outIndices) {
        for (const idx of outIndices) {
          const rel = this._findRelationById(idx);
          if (rel && rel.confidence >= minConfidence && (!predicate || rel.predicate === predicate)) {
            steps.push({ relation: rel, nextEntityId: rel.object });
          }
        }
      }
    }

    // 反向入边
    if (direction === 'incoming' || direction === 'both') {
      const inIndices = this._objectIndex.get(entityId);
      if (inIndices) {
        for (const idx of inIndices) {
          const rel = this._findRelationById(idx);
          if (rel && rel.confidence >= minConfidence && (!predicate || rel.predicate === predicate)) {
            steps.push({ relation: rel, nextEntityId: rel.subject });
          }
        }
      }
    }

    return steps;
  }

  /**
   * 获取指定实体的出边关系（可按谓词过滤）
   * @param {string} entityId - 实体ID
   * @param {string|null} predicate - 谓词过滤
   * @returns {Array<Object>} 关系数组
   * @private
   */
  _getOutgoingRelations(entityId, predicate) {
    const indices = this._subjectIndex.get(entityId);
    if (!indices) return [];
    const results = [];
    for (const idx of indices) {
      const rel = this._findRelationById(idx);
      if (rel && (!predicate || rel.predicate === predicate)) {
        results.push(rel);
      }
    }
    return results;
  }

  /**
   * 获取指定实体的入边关系（可按谓词过滤）   * @param {string} entityId - 实体ID
   * @param {string|null} predicate - 谓词过滤
   * @returns {Array<Object>} 关系数组
   * @private
   */
  _getIncomingRelationsFiltered(entityId, predicate) {
    const indices = this._objectIndex.get(entityId);
    if (!indices) return [];
    const results = [];
    for (const idx of indices) {
      const rel = this._findRelationById(idx);
      if (rel && (!predicate || rel.predicate === predicate)) {
        results.push(rel);
      }
    }
    return results;
  }

  /**
   * 双向BFS路径重建
   * @param {string} fromId - 起始实体ID
   * @param {string} toId - 目标实体ID
   * @param {string} meetingId - 相遇实体ID
   * @param {Map} forwardVisited - 正向访问记录
   * @param {Map} backwardVisited - 反向访问记录
   * @returns {Object} { found: true, path: { entities, relations }, length }
   * @private
   */
  _reconstructPath(fromId, toId, meetingId, forwardVisited, backwardVisited) {
    // 从相遇点向起始点回溯正向路径
    const forwardPath = [];
    let current = meetingId;
    while (forwardVisited.get(current) !== null && forwardVisited.get(current) !== undefined) {
      const { parent, relation } = forwardVisited.get(current);
      forwardPath.unshift({ entityId: parent, relation });
      current = parent;
    }

    // 从相遇点向目标点回溯反向路径
    const backwardPath = [];
    current = meetingId;
    while (backwardVisited.get(current) !== null && backwardVisited.get(current) !== undefined) {
      const { parent, relation } = backwardVisited.get(current);
      backwardPath.push({ entityId: parent, relation });
      current = parent;
    }

    // 合并路径
    const entityIds = [fromId];
    const relations = [];

    for (const step of forwardPath) {
      entityIds.push(step.entityId);
      relations.push(step.relation);
    }
    for (const step of backwardPath) {
      entityIds.push(step.entityId);
      relations.push(step.relation);
    }

    // 去重相遇点
    if (meetingId !== fromId && meetingId !== toId) {
      // meetingId已在forwardPath中添加，无需重复
    }

    const entities = entityIds.map(id => this._entities.get(id)).filter(Boolean);

    return {
      found: true,
      path: { entities, relations },
      length: relations.length,
    };
  }

  /**
   * 关闭知识图谱存储，清空所有状态   * @private
   */
  _onShutdown() {
    safeCall(() => this._entities.shutdown(), 'KnowledgeGraphStore', 'shutdown-entities');
    safeCall(() => this._relations.shutdown(), 'KnowledgeGraphStore', 'shutdown-relations');
    this._subjectIndex.clear();
    this._objectIndex.clear();
    this._predicateIndex.clear();
    this._subjectIndex = null;
    this._objectIndex = null;
    this._predicateIndex = null;
    this._stats = null;
    this._ms = null;
    this._es = null;
    this._attached = null;
    this.removeAllListeners();
  }
}

// 静态属性
KnowledgeGraphStore.RELATION_TYPES = RELATION_TYPES;
KnowledgeGraphStore.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(KnowledgeGraphStore);
