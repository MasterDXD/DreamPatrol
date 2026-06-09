'use strict';

/**
 * DDD ContextMapper — 限界上下文映射器。
 * 管理限界上下文之间的映射关系，支持共享内核、客户-供应商、防腐层等集成模式。
 * 与 config.json 中的 bounded_contexts 配置对齐，实现上下文的注册、发现和关系管理。
 *
 * @module domain/context-mapper
 * @example
 * const mapper = new ContextMapper();
 * mapper.registerContext('orders', { modules: ['order', 'payment'] });
 * mapper.registerContext('shipping', { modules: ['logistics', 'tracking'] });
 * mapper.defineRelationship('orders', 'shipping', 'customer-supplier', { upstream: 'orders' });
 */

const { timestampId } = require('../utils/unique-id');

/**
 * 上下文关系类型常量。
 * @enum {string}
 */
const RELATIONSHIP_TYPES = {
  SHARED_KERNEL: 'shared-kernel',
  CUSTOMER_SUPPLIER: 'customer-supplier',
  CONFORMIST: 'conformist',
  ANTI_CORRUPTION_LAYER: 'anti-corruption-layer',
  OPEN_HOST_SERVICE: 'open-host-service',
  PUBLISHED_LANGUAGE: 'published-language',
  SEPARATE_WAYS: 'separate-ways',
  PARTNERSHIP: 'partnership',
};

/**
 * @classdesc DDD上下文映射器。管理限界上下文的注册、查询和关系映射。
 */
class ContextMapper {
  constructor() {
    this._contexts = new Map();
    this._relationships = new Map();
    this._ubiquitousLanguage = new Map();
  }

  /**
   * 注册限界上下文。
   * @param {string} name - 上下文名称
   * @param {Object} definition - 上下文定义
   * @param {string[]} definition.modules - 所属模块列表
   * @param {string} [definition.description] - 上下文描述
   * @param {string[]} [definition.coreConcepts] - 核心概念列表
   * @returns {{ id: string, name: string }} 注册结果
   */
  registerContext(name, definition) {
    const id = timestampId();
    this._contexts.set(name, Object.assign({}, definition, {
      id,
      name,
      registeredAt: Date.now(),
    }));
    return { id, name };
  }

  /**
   * 获取指定上下文。
   * @param {string} name - 上下文名称
   * @returns {Object|null}
   */
  getContext(name) {
    return this._contexts.get(name) || null;
  }

  /**
   * 获取所有已注册上下文。
   * @returns {Object[]}
   */
  getAllContexts() {
    return Array.from(this._contexts.values());
  }

  /**
   * 定义两个上下文之间的关系。
   * @param {string} sourceName - 源上下文名称
   * @param {string} targetName - 目标上下文名称
   * @param {string} relationshipType - 关系类型（使用 RELATIONSHIP_TYPES 常量）
   * @param {Object} [metadata] - 关系元数据
   * @returns {{ id: string, source: string, target: string, type: string }}
   */
  defineRelationship(sourceName, targetName, relationshipType, metadata = {}) {
    if (!this._contexts.has(sourceName)) {
      throw new Error(`Context "${sourceName}" not registered`);
    }
    if (!this._contexts.has(targetName)) {
      throw new Error(`Context "${targetName}" not registered`);
    }
    const id = timestampId();
    const relationship = {
      id,
      source: sourceName,
      target: targetName,
      type: relationshipType,
      metadata,
      createdAt: Date.now(),
    };
    const key = `${sourceName}->${targetName}`;
    this._relationships.set(key, relationship);
    return relationship;
  }

  /**
   * 获取两个上下文间的关系。
   * @param {string} sourceName - 源上下文
   * @param {string} targetName - 目标上下文
   * @returns {Object|null}
   */
  getRelationship(sourceName, targetName) {
    return this._relationships.get(`${sourceName}->${targetName}`) || null;
  }

  /**
   * 获取某上下文的所有关系。
   * @param {string} contextName - 上下文名称
   * @returns {Object[]}
   */
  getContextRelationships(contextName) {
    const results = [];
    for (const [, rel] of this._relationships) {
      if (rel.source === contextName || rel.target === contextName) {
        results.push(rel);
      }
    }
    return results;
  }

  /**
   * 注册统一语言术语。
   * @param {string} contextName - 上下文名称
   * @param {string} term - 术语
   * @param {string} definition - 术语定义
   */
  registerTerm(contextName, term, definition) {
    if (!this._ubiquitousLanguage.has(contextName)) {
      this._ubiquitousLanguage.set(contextName, new Map());
    }
    this._ubiquitousLanguage.get(contextName).set(term, definition);
  }

  /**
   * 获取指定上下文的统一语言。
   * @param {string} contextName - 上下文名称
   * @returns {Object.<string, string>}
   */
  getUbiquitousLanguage(contextName) {
    const terms = this._ubiquitousLanguage.get(contextName);
    if (!terms) return {};
    return Object.fromEntries(terms);
  }

  /**
   * 从 config.json 的 bounded_contexts 批量导入上下文。
   * @param {Object.<string, Object>} boundedContexts - bounded_contexts 配置
   * @returns {void}
   */
  importFromConfig(boundedContexts) {
    for (const [name, def] of Object.entries(boundedContexts)) {
      this.registerContext(name, {
        modules: def.modules ?? [],
        description: def.description || '',
        coreConcepts: def.core_concepts ?? [],
      });
    }
  }

  /**
   * 获取统计信息。
   * @returns {{ totalContexts: number, totalRelationships: number, totalTerms: number }}
   */
  getStats() {
    let totalTerms = 0;
    for (const terms of this._ubiquitousLanguage.values()) {
      totalTerms += terms.size;
    }
    return {
      totalContexts: this._contexts.size,
      totalRelationships: this._relationships.size,
      totalTerms,
    };
  }
}

ContextMapper.RELATIONSHIP_TYPES = RELATIONSHIP_TYPES;

module.exports = ContextMapper;
