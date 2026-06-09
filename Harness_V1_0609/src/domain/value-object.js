'use strict';

/**
 * DDD ValueObject 基类。
 * 值对象由属性值定义，无唯一标识。相同属性值即相等，且应不可变。
 *
 * @module domain/value-object
 * @example
 * class Money extends ValueObject {
 *   constructor(amount, currency) {
 *     super();
 *     this.amount = amount;
 *     this.currency = currency;
 *   }
 *   getEqualityComponents() { return [this.amount, this.currency]; }
 * }
 * const m1 = new Money(100, 'USD');
 * const m2 = new Money(100, 'USD');
 * m1.equals(m2); // true
 */

/**
 * @classdesc DDD值对象基类。基于属性值相等性比较，设计为不可变。
 */
class ValueObject {
  /**
   * 获取用于相等性比较的属性组件数组。
   * 子类必须重写此方法，返回所有用于判定相等性的属性值。
   * @returns {Array<*>}
   * @abstract
   */
  getEqualityComponents() {
    throw new Error('ValueObject subclass must implement getEqualityComponents()');
  }

  /**
   * 基于属性值判断相等性。
   * @param {ValueObject} other - 另一个值对象
   * @returns {boolean}
   */
  equals(other) {
    if (!(other instanceof ValueObject)) return false;
    if (this.constructor !== other.constructor) return false;
    const a = this.getEqualityComponents();
    const b = other.getEqualityComponents();
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * 基于属性值计算哈希码。
   * @returns {string}
   */
  hashCode() {
    const components = this.getEqualityComponents();
    return components.map(c => String(c)).join('|');
  }

  /**
   * 序列化所有属性。
   * @returns {Object}
   */
  toJSON() {
    const obj = {};
    for (const key of Object.keys(this)) {
      if (!key.startsWith('_')) {
        obj[key] = this[key];
      }
    }
    return obj;
  }
}

module.exports = ValueObject;
