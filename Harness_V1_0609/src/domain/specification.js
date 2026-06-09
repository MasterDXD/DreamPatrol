'use strict';

/**
 * DDD Specification 模式。
 * 规约模式将业务规则封装为可组合的对象，支持AND/OR/NOT逻辑运算。
 * 用于验证、查询过滤和业务规则表达。
 *
 * @module domain/specification
 * @example
 * class ActiveUserSpec extends Specification {
 *   isSatisfiedBy(user) { return user.status === 'active'; }
 * }
 * class PremiumUserSpec extends Specification {
 *   isSatisfiedBy(user) { return user.plan === 'premium'; }
 * }
 * const spec = new ActiveUserSpec().and(new PremiumUserSpec());
 * spec.isSatisfiedBy(user); // true if active AND premium
 */

/**
 * @classdesc DDD规约基类。提供AND/OR/NOT组合能力。
 * @abstract
 */
class Specification {
  /**
   * 检查候选对象是否满足规约。
   * @param {*} candidate - 候选对象
   * @returns {boolean}
   * @abstract
   */
  isSatisfiedBy(_candidate) {
    throw new Error('Specification subclass must implement isSatisfiedBy(candidate)');
  }

  /**
   * AND组合：两个规约都满足时为true。
   * @param {Specification} other - 另一个规约
   * @returns {AndSpecification}
   */
  and(other) {
    return new AndSpecification(this, other);
  }

  /**
   * OR组合：任一规约满足时为true。
   * @param {Specification} other - 另一个规约
   * @returns {OrSpecification}
   */
  or(other) {
    return new OrSpecification(this, other);
  }

  /**
   * NOT取反：规约不满足时为true。
   * @returns {NotSpecification}
   */
  not() {
    return new NotSpecification(this);
  }
}

/**
 * @classdesc AND规约组合。组合两个规约，两者都满足时为true。
 * @extends Specification
 */
class AndSpecification extends Specification {
  /**
   * @param {Specification} left - 左规约
   * @param {Specification} right - 右规约
   */
  constructor(left, right) {
    super();
    this._left = left;
    this._right = right;
  }

  isSatisfiedBy(_candidate) {
    return this._left.isSatisfiedBy(_candidate) && this._right.isSatisfiedBy(_candidate);
  }
}

/**
 * @classdesc OR规约组合。组合两个规约，任一满足时为true。
 * @extends Specification
 */
class OrSpecification extends Specification {
  /**
   * @param {Specification} left - 左规约
   * @param {Specification} right - 右规约
   */
  constructor(left, right) {
    super();
    this._left = left;
    this._right = right;
  }

  isSatisfiedBy(_candidate) {
    return this._left.isSatisfiedBy(_candidate) || this._right.isSatisfiedBy(_candidate);
  }
}

/**
 * @classdesc NOT取反规约。对原规约结果取反。
 * @extends Specification
 */
class NotSpecification extends Specification {
  /**
   * @param {Specification} spec - 被取反的规约
   */
  constructor(spec) {
    super();
    this._spec = spec;
  }

  isSatisfiedBy(_candidate) {
    return !this._spec.isSatisfiedBy(_candidate);
  }
}

module.exports = { Specification, AndSpecification, OrSpecification, NotSpecification };
