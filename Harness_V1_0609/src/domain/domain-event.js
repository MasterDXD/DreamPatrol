'use strict';

/**
 * DDD DomainEvent 与 DomainEventBus。
 * 领域事件表示领域中发生的重要业务事件，用于解耦不同聚合之间的通信。
 * DomainEventBus 提供事件发布-订阅能力，支持同步和异步处理。
 *
 * @module domain/domain-event
 * @example
 * const bus = new DomainEventBus();
 * bus.subscribe('OrderCreated', (event) => console.log('Order created:', event.aggregateId));
 * bus.publish(new OrderCreatedEvent('order-1', 'user-1'));
 */

const { EventEmitter } = require('events');
const { timestampId } = require('../utils/unique-id');
const { withShutdown } = require('../utils/shutdown-mixin');

/**
 * @classdesc DDD领域事件基类。包含事件发生的时间戳和聚合标识。
 */
class DomainEvent {
  /**
   * @param {string} eventName - 事件名称
   * @param {string} aggregateId - 关联的聚合根标识
   * @param {Object} [payload={}] - 事件载荷数据
   */
  constructor(eventName, aggregateId, payload = {}) {
    this.eventId = timestampId();
    this.eventName = eventName;
    this.aggregateId = aggregateId;
    this.payload = payload;
    this.occurredAt = Date.now();
    this.version = 1;
  }

  /**
   * 序列化事件。
   * @returns {{ eventId: string, eventName: string, aggregateId: string, payload: Object, occurredAt: number }}
   */
  toJSON() {
    return {
      eventId: this.eventId,
      eventName: this.eventName,
      aggregateId: this.aggregateId,
      payload: this.payload,
      occurredAt: this.occurredAt,
    };
  }
}

/**
 * @classdesc 领域事件总线。管理领域事件的发布与订阅，支持同步立即处理和异步延迟处理。
 * @extends EventEmitter
 */
class DomainEventBus extends EventEmitter {
  constructor() {
    super();
    // 防止无监听器时 error 事件导致进程崩溃
    this.on('error', function(_err) {
      // 仅记录，不传播 — 外部可通过 on('error') 覆盖此行为
    });
    this._subscriptions = new Map();
    this._eventHistory = [];
    this._maxHistory = 500;
    /** @constant {number} MAX_EVENT_TYPES - 最大事件类型数 */
    this._maxEventTypes = 200;
    /** @constant {number} MAX_HANDLERS_PER_EVENT - 单事件类型最大处理器数 */
    this._maxHandlersPerEvent = 50;
  }

  /**
   * 订阅领域事件。
   * @param {string} eventName - 事件名称，支持 '*' 通配所有事件
   * @param {function(DomainEvent): void} handler - 事件处理函数
   * @param {Object} [options] - 订阅选项
   * @param {boolean} [options.async=false] - 是否异步处理
   * @returns {function(): void} 取消订阅函数
   */
  subscribe(eventName, handler, options = {}) {
    if (!this._subscriptions.has(eventName)) {
      if (this._subscriptions.size >= this._maxEventTypes) {
        const oldestKey = this._subscriptions.keys().next().value;
        if (oldestKey) this._subscriptions.delete(oldestKey);
      }
      this._subscriptions.set(eventName, []);
    }
    const handlers = this._subscriptions.get(eventName);
    if (handlers.length >= this._maxHandlersPerEvent) {
      handlers.shift();
    }
    const entry = { handler, async: !!options.async };
    handlers.push(entry);

    return () => {
      const existingHandlers = this._subscriptions.get(eventName);
      if (existingHandlers) {
        const idx = existingHandlers.indexOf(entry);
        if (idx >= 0) existingHandlers.splice(idx, 1);
      }
    };
  }

  /**
   * 发布领域事件。
   * @param {DomainEvent} event - 领域事件实例
   * @returns {Promise<void>}
   */
  async publish(event) {
    this.guardShutdown();
    if (!(event instanceof DomainEvent)) {
      throw new Error('publish() requires a DomainEvent instance');
    }

    this._eventHistory.push(event.toJSON());
    if (this._eventHistory.length > this._maxHistory) {
      this._eventHistory.shift();
    }

    const handlers = this._subscriptions.get(event.eventName) ?? [];
    const wildcardHandlers = this._subscriptions.get('*') ?? [];
    const allHandlers = [...handlers, ...wildcardHandlers];

    const syncHandlers = allHandlers.filter(h => !h.async);
    const asyncHandlers = allHandlers.filter(h => h.async);

    for (const entry of syncHandlers) {
      try {
        entry.handler(event);
      } catch (_err) {
        this.emit('error', { event, error: _err });
      }
    }

    if (asyncHandlers.length > 0) {
      await Promise.all(asyncHandlers.map(entry =>
        Promise.resolve().then(() => entry.handler(event)).catch(err => {
          this.emit('error', { event, error: err });
        }),
      ));
    }
  }

  /**
   * 批量发布领域事件。
   * @param {DomainEvent[]} events - 领域事件数组
   * @returns {Promise<void>}
   */
  async publishAll(events) {
    for (const event of events) {
      await this.publish(event);
    }
  }

  /**
   * 获取事件历史记录。
   * @param {number} [limit] - 返回最近N条记录
   * @returns {Object[]}
   */
  getHistory(limit) {
    if (limit) return this._eventHistory.slice(-limit);
    return this._eventHistory.slice();
  }

  /**
   * 获取订阅统计信息。
   * @returns {{ totalSubscriptions: number, eventTypes: number, historySize: number }}
   */
  getStats() {
    let totalSubscriptions = 0;
    for (const handlers of this._subscriptions.values()) {
      totalSubscriptions += handlers.length;
    }
    return {
      totalSubscriptions,
      eventTypes: this._subscriptions.size,
      historySize: this._eventHistory.length,
    };
  }

  /** 关闭事件总线。 */
  _onShutdown() {
    this._subscriptions.clear();
    this._eventHistory = [];
    this.removeAllListeners();
  }
}

module.exports = { DomainEvent, DomainEventBus: withShutdown(DomainEventBus) };
