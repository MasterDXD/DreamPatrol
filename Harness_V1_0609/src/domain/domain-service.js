'use strict';

/**
 * DDD DomainService 标记类。
 * 领域服务封装不属于任何单一实体或值对象的领域逻辑。
 * 与ApplicationService的区别：领域服务包含业务规则，应用服务编排流程。
 *
 * @module domain/domain-service
 * @example
 * class TransferService extends DomainService {
 *   async transfer(fromAccount, toAccount, amount) {
 *     if (!fromAccount.canWithdraw(amount)) {
 *       throw new DomainError('Insufficient funds');
 *     }
 *     fromAccount.withdraw(amount);
 *     toAccount.deposit(amount);
 *     return { fromAccount, toAccount };
 *   }
 * }
 */

/**
 * @classdesc DomainService 标记基类。领域服务应是无状态的，封装跨聚合的业务逻辑。
 */
class DomainService {
  /**
   * 获取服务名称。子类可重写以提供有意义的名称。
   * @returns {string}
   */
  getServiceName() {
    return this.constructor.name;
  }

  /**
   * 验证服务是否可以执行。子类可重写以实现前置条件检查。
   * @returns {boolean}
   */
  canExecute() {
    return true;
  }
}

module.exports = DomainService;
