'use strict';

const { EventEmitter } = require('events');
const { HarnessError } = require('../../errors');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { DEFAULT_ACQUIRE_TIMEOUT_MS } = require('../../utils/constants');

const DEFAULT_MAX_CONCURRENT = 6;
const DEFAULT_MAX_QUEUE = 100;
const ACQUIRE_TIMEOUT_MS = DEFAULT_ACQUIRE_TIMEOUT_MS;
const DEFAULT_LEASE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @module runtime/infrastructure/concurrency-controller
 * ConcurrencyController — 并发控制器
 * 信号量式并发限制器，控制同时执行的任务数量。提供acquire/release手动控制
 * 和run自动管理模式，支持等待队列、超时自动释放、任务元数据追踪和统计信息。
 * @classdesc 并发控制器。信号量、读写锁、并发限制
 * @extends EventEmitter
 */
class ConcurrencyController extends EventEmitter {
  /**
   * 创建 ConcurrencyController 实例。
   * @param {number} [maxConcurrent=6] - 最大并发任务数
   * @param {number} [maxQueue=100] - 最大等待队列长度
   * @param {Object} [options] - 额外配置选项
   * @param {number} [options.leaseTimeoutMs=300000] - 任务租约超时时间（毫秒），超时后自动释放
   */
  constructor(maxConcurrent, maxQueue, options) {
    super();
    this._max = maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this._maxQueue = maxQueue ?? DEFAULT_MAX_QUEUE;
    this._leaseTimeout = (options && options.leaseTimeoutMs) ?? DEFAULT_LEASE_TIMEOUT_MS;
    this._running = new Map();
    this._queue = [];
  }

  /**
   * 获取最大并发数。
   * @type {number}
   */
  get maxConcurrent() {
    return this._max;
  }

  /**
   * 获取当前正在运行的任务数。
   * @type {number}
   */
  get runningCount() {
    return this._running.size;
  }

  /**
   * 获取等待队列中的任务数。
   * @type {number}
   */
  get queuedCount() {
    return this._queue.length;
  }

  /**
   * 获取当前可用的并发槽位数。
   * @type {number}
   */
  get availableSlots() {
    return Math.max(0, this._max - this._running.size);
  }

  /**
   * 获取并发槽位。有空闲槽位时立即获取，否则进入等待队列。支持超时自动出队和租约超时自动释放。
   * @param {string|number} taskId - 任务标识符
   * @param {Object} [metadata] - 任务元数据，将附加到运行记录中
   * @returns {Promise<boolean>} 获取成功返回 true，失败（关闭、无效ID、队列满、超时）返回 false
   * @throws {TypeError} If taskId is null or undefined
   */
  async acquire(taskId, metadata) {
    this.guardShutdown();
    if (taskId == null) {
      this.emit('rejected', { taskId, reason: 'invalid_task_id' });
      return false;
    }
    const safeTaskId = String(taskId);
    if (this._running.has(safeTaskId)) {
      return false;
    }

    if (this._running.size < this._max) {
      const leaseTimer = this._startLeaseTimer(safeTaskId);
      this._running.set(safeTaskId, {
        startedAt: Date.now(),
        metadata: metadata ?? {},
        leaseTimer: leaseTimer,
      });
      this.emit('acquired', { taskId: safeTaskId, runningCount: this._running.size });
      return true;
    }

    return new Promise((resolve) => {
      if (this._queue.length >= this._maxQueue) {
        this.emit('rejected', { taskId: safeTaskId, reason: 'queue_full' });
        resolve(false);
        return;
      }
      if (this._queue.some(e => e.taskId === safeTaskId)) {
        resolve(false);
        return;
      }
      const entry = { taskId: safeTaskId, metadata, resolve, timer: null };
      entry.timer = setTimeout(() => {
        if (this._shutDown) return;
        const idx = this._queue.indexOf(entry);
        if (idx !== -1) this._queue.splice(idx, 1);
        this.emit('timeout', { taskId: safeTaskId, reason: 'acquire_timeout' });
        resolve(false);
      }, ACQUIRE_TIMEOUT_MS);
      if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
      this._queue.push(entry);
      this.emit('queued', { taskId: safeTaskId, queuedCount: this._queue.length });
    });
  }

  /**
   * 释放并发槽位。释放后自动从等待队列中取出下一个任务分配槽位。
   * @param {string|number} taskId - 要释放的任务标识符
   * @returns {boolean} 释放成功返回 true，任务不存在时返回 false
   */
  release(taskId) {
    this.guardShutdown();
    if (taskId == null) return false;
    const safeTaskId = String(taskId);
    if (!this._running.has(safeTaskId)) return false;

    const entry = this._running.get(safeTaskId);
    this._running.delete(safeTaskId);
    if (entry && entry.leaseTimer) clearTimeout(entry.leaseTimer);
    this.emit('released', { taskId: safeTaskId, duration: (entry && entry.startedAt) ? Date.now() - entry.startedAt : 0, runningCount: this._running.size });

    if (!this._shutDown && this._queue.length > 0) {
      const next = this._queue.shift();
      if (next.timer) clearTimeout(next.timer);
      const leaseTimer = this._startLeaseTimer(next.taskId);
      this._running.set(next.taskId, {
        startedAt: Date.now(),
        metadata: next.metadata ?? {},
        leaseTimer: leaseTimer,
      });
      this.emit('acquired', { taskId: next.taskId, runningCount: this._running.size, fromQueue: true });
      next.resolve(true);
    } else if (this._shutDown && this._queue.length > 0) {
      while (this._queue.length > 0) {
        const pending = this._queue.shift();
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(false);
      }
    }

    return true;
  }

  /**
   * 在并发控制下执行异步函数。自动获取和释放槽位，函数执行完成后自动释放。
   * @param {string|number} taskId - 任务标识符
   * @param {Function} fn - 要执行的异步函数
   * @param {Object} [metadata] - 任务元数据
   * @returns {Promise<*>} fn 的返回值
   * @throws {HarnessError} 获取槽位失败时抛出 ACQUIRE_FAILED 错误
   */
  async run(taskId, fn, metadata) {
    let acquired = false;
    try {
      acquired = await this.acquire(taskId, metadata);
    } catch (acquireErr) {
      this.emit('run-rejected', { taskId, reason: 'acquire_error' });
      throw acquireErr;
    }
    if (!acquired) {
      this.emit('run-rejected', { taskId, reason: 'acquire_failed' });
      throw new HarnessError('ACQUIRE_FAILED', `ConcurrencyController: failed to acquire slot for task "${taskId}"`);
    }
    try {
      const result = await fn();
      return result;
    } finally {
      if (acquired) {
        this.release(taskId);
      }
    }
  }

  /**
   * 检查指定任务是否正在运行。
   * @param {string|number} taskId - 任务标识符
   * @returns {boolean} 任务正在运行返回 true，否则返回 false
   */
  isRunning(taskId) {
    return this._running.has(String(taskId));
  }

  /**
   * 获取所有正在运行的任务信息列表。
   * @returns {Array<{taskId: string, startedAt: number, duration: number, metadata: Object}>} 运行中任务信息数组
   */
  getRunningTasks() {
    const tasks = [];
    for (const [id, entry] of this._running) {
      tasks.push({
        taskId: id,
        startedAt: entry.startedAt,
        duration: Date.now() - entry.startedAt,
        metadata: entry.metadata,
      });
    }
    return tasks;
  }

  /**
   * 获取并发控制器的运行统计数据。
   * @returns {{maxConcurrent: number, runningCount: number, queuedCount: number, availableSlots: number}} 统计信息对象
   */
  getStats() {
    return {
      maxConcurrent: this._max,
      runningCount: this._running.size,
      queuedCount: this._queue.length,
      availableSlots: this.availableSlots,
    };
  }

  /**
   * 清空所有等待队列和运行中的任务。对队列中的等待任务返回 false，对运行中的任务清除租约定时器。
   * @returns {void}
   */
  clear() {
    for (const entry of this._queue) {
      if (entry && entry.timer) clearTimeout(entry.timer);
      if (entry && typeof entry.resolve === 'function') {
        entry.resolve(false);
      }
    }
    this._queue = [];
    for (const entry of this._running.values()) {
      if (entry && entry.leaseTimer) clearTimeout(entry.leaseTimer);
    }
    this._running.clear();
  }

  _startLeaseTimer(taskId) {
    const self = this;
    const timer = setTimeout(function() {
      if (self._shutDown) return;
      if (self._running.has(taskId)) {
        self.emit('lease-expired', { taskId: taskId, reason: 'lease_timeout' });
        self.release(taskId);
      }
    }, this._leaseTimeout);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  _onShutdown() {
    this.clear();
    this.removeAllListeners();
  }

  /**
   * 检查并发控制器是否健康。运行数未达上限或等待队列为空时返回true。
   * @returns {boolean} 健康状态
   */
  isHealthy() { return !this._shutDown; }
}

ConcurrencyController = withShutdown(ConcurrencyController);

ConcurrencyController.DEFAULT_MAX_CONCURRENT = DEFAULT_MAX_CONCURRENT;
ConcurrencyController.DEFAULT_MAX_QUEUE = DEFAULT_MAX_QUEUE;

module.exports = ConcurrencyController;
