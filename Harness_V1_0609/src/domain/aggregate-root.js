'use strict';

/**
 * DDD AggregateRoot 基类。
 * 聚合根是聚合的入口，负责维护聚合内部的一致性边界。
 * 外部只能通过聚合根引用聚合内的实体。
 *
 * @module domain/aggregate-root
 * @example
 * class Order extends AggregateRoot {
 *   constructor(id, customerId) {
 *     super(id);
 *     this.customerId = customerId;
 *     this._items = [];
 *     this._status = 'draft';
 *   }
 *   addItem(productId, quantity, price) {
 *     this._items.push(new OrderItem(productId, quantity, price));
 *     this.addDomainEvent(new OrderItemAddedEvent(this.id, productId));
 *   }
 * }
 */

const Entity = require('./entity');

/**
 * @classdesc DDD聚合根基类。继承Entity，增加版本控制和聚合边界管理。
 * @extends Entity
 */
class AggregateRoot extends Entity {
  /**
   * @param {string} [id] - 聚合根唯一标识
   */
  constructor(id) {
    super(id);
    this._version = 0;
    this._createdAt = Date.now();
    this._updatedAt = Date.now();
  }

  /** @returns {number} 聚合版本号（乐观锁用） */
  get version() { return this._version; }

  /** @returns {number} 创建时间戳 */
  get createdAt() { return this._createdAt; }

  /** @returns {number} 最后更新时间戳 */
  get updatedAt() { return this._updatedAt; }

  /**
   * 递增版本号（每次状态变更时调用）。
   * @returns {number} 新版本号
   */
  _incrementVersion() {
    this._version++;
    this._updatedAt = Date.now();
    return this._version;
  }

  /**
   * 序列化聚合根完整状态。
   * @returns {{ id: string, version: number, createdAt: number, updatedAt: number }}
   */
  toJSON() {
    return Object.assign({}, super.toJSON(), {
      version: this._version,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    });
  }
}

module.exports = AggregateRoot;
