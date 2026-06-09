'use strict';

/**
 * DDD Entity 基类。
 * 实体由唯一标识定义，而非属性值。即使所有属性相同，不同标识即不同实体。
 *
 * @module domain/entity
 * @example
 * class User extends Entity {
 *   constructor(id, name, email) {
 *     super(id);
 *     this.name = name;
 *     this.email = email;
 *   }
 * }
 * const user1 = new User('1', 'Alice', 'a@b.com');
 * const user2 = new User('1', 'Bob', 'b@c.com');
 * user1.equals(user2); // true — same identity
 */

const { timestampId } = require('../utils/unique-id');

/**
 * @classdesc DDD实体基类。提供基于标识的相等性比较和领域事件管理。
 */
class Entity {
  /**
   * @param {string} [id] - 实体唯一标识，不提供时自动生成
   */
  constructor(id) {
    this._id = id || timestampId();
    this._domainEvents = [];
  }

  /** @returns {string} 实体唯一标识 */
  get id() { return this._id; }

  /**
   * 基于标识判断实体相等性。
   * @param {Entity} other - 另一个实体
   * @returns {boolean}
   */
  equals(other) {
    if (!(other instanceof Entity)) return false;
    return this._id === other._id;
  }

  /**
   * 添加领域事件到待发布队列。
   * @param {DomainEvent} event - 领域事件
   */
  addDomainEvent(event) {
    this._domainEvents.push(event);
  }

  /**
   * 获取并清空待发布领域事件队列。
   * @returns {DomainEvent[]}
   */
  pullDomainEvents() {
    const events = this._domainEvents.slice();
    this._domainEvents = [];
    return events;
  }

  /** 清空领域事件队列。 */
  clearDomainEvents() {
    this._domainEvents = [];
  }

  /**
   * 序列化为普通对象。
   * @returns {{ id: string }}
   */
  toJSON() {
    return { id: this._id };
  }
}

module.exports = Entity;
