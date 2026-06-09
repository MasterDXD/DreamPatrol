'use strict';

/**
 * DDD Repository 接口与内存实现。
 * 仓储模式为聚合根提供持久化抽象，隔离领域层与基础设施层。
 * 提供契约式接口和内存实现，方便测试与快速原型。
 *
 * @module domain/repository
 * @example
 * class UserRepository extends Repository {
 *   async findByEmail(email) { ... }
 * }
 */

/**
 * @classdesc DDD仓储基类。定义CRUD契约，子类继承并实现具体持久化逻辑。
 * @abstract
 */
class Repository {
  /**
   * 依ID查找聚合根。
   * @param {string} id - 聚合根标识
   * @returns {Promise<AggregateRoot|null>}
   * @abstract
   */
  async findById(_id) {
    throw new Error('Repository subclass must implement findById(id)');
  }

  /**
   * 保存聚合根（新增或更新）。
   * @param {AggregateRoot} aggregate - 聚合根实例
   * @returns {Promise<void>}
   * @abstract
   */
  async save(_aggregate) {
    throw new Error('Repository subclass must implement save(aggregate)');
  }

  /**
   * 删除聚合根。
   * @param {string} id - 聚合根标识
   * @returns {Promise<void>}
   * @abstract
   */
  async delete(_id) {
    throw new Error('Repository subclass must implement delete(id)');
  }

  /**
   * 查找所有聚合根。
   * @returns {Promise<AggregateRoot[]>}
   * @abstract
   */
  async findAll() {
    throw new Error('Repository subclass must implement findAll()');
  }

  /**
   * 按条件查找聚合根。
   * @param {Object} criteria - 查询条件
   * @returns {Promise<AggregateRoot[]>}
   * @abstract
   */
  async findBy(_criteria) {
    throw new Error('Repository subclass must implement findBy(criteria)');
  }

  /**
   * 统计聚合根数量。
   * @param {Object} [criteria] - 可选的过滤条件
   * @returns {Promise<number>}
   * @abstract
   */
  async count(_criteria) {
    throw new Error('Repository subclass must implement count(criteria)');
  }
}

/**
 * @classdesc 内存仓储实现。使用Map存储聚合根快照，适用于测试和快速原型。
 * @extends Repository
 *
 * @example
 * class UserMemoryRepo extends InMemoryRepository {
 *   _getIdentity(aggregate) { return aggregate.id; }
 * }
 * const repo = new UserMemoryRepo();
 * await repo.save(user);
 * const found = await repo.findById(user.id);
 */
class InMemoryRepository extends Repository {
  constructor() {
    super();
    this._store = new Map();
  }

  /**
   * 获取聚合根的存储标识。子类可重写。
   * @param {AggregateRoot} aggregate - 聚合根
   * @returns {string}
   * @protected
   */
  _getIdentity(aggregate) {
    return aggregate.id;
  }

  async findById(id) {
    return this._store.get(id) || null;
  }

  async save(aggregate) {
    const id = this._getIdentity(aggregate);
    this._store.set(id, aggregate);
  }

  async delete(id) {
    this._store.delete(id);
  }

  async findAll() {
    return Array.from(this._store.values());
  }

  async findBy(criteria) {
    const all = await this.findAll();
    return all.filter(item => {
      for (const key of Object.keys(criteria)) {
        if (item[key] !== criteria[key]) return false;
      }
      return true;
    });
  }

  async count(criteria) {
    if (!criteria) return this._store.size;
    const found = await this.findBy(criteria);
    return found.length;
  }

  /** 清空存储。 */
  clear() {
    this._store.clear();
  }
}

module.exports = { Repository, InMemoryRepository };
