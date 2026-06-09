'use strict';

/**
 * @module runtime/deepening/deepening-task-queue
 * 深化推理优先级任务队列。使用最小堆按优先级排序任务（高/普通/低），
 * 强制容量限制，支持惰性取消的出队过滤，追踪并发配置和队列统计。
 */

const DeepeningBase = require('./deepening-base');
const MinHeap = require('../../utils/min-heap');
const { counterId, ID_PREFIXES } = require('../../utils/unique-id');
const { HarnessError } = require('../../errors');

/**
 * 深化推理优先级任务队列。使用最小堆按优先级排序任务（高/普通/低），
 * 强制容量限制，支持惰性取消的出队过滤，追踪并发配置和队列统计。
 *
 * @classdesc 深化任务队列。优先级队列、延迟队列、死信队列。
 * @extends DeepeningBase
 */
class DeepeningTaskQueue extends DeepeningBase {

  /**
   * 创建 DeepeningTaskQueue 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.concurrency=1] - 并发执行数
   * @param {number} [options.maxSize=1000] - 队列最大容量
   */
  constructor(options) {
    super(options);
    this._heap = new MinHeap((a, b) => a.priority - b.priority);
    this._entries = new Map();
    this._cancelled = new Set();
    this._concurrency = (options && options.concurrency !== undefined) ? options.concurrency : 1;
    this._maxSize = (options && options.maxSize) ?? 1000;
    this._running = 0;
    this._totalQueued = 0;
  }

  /**
   * 以普通优先级（2）入队任务。
   * @param {*} data - 任务数据
   * @returns {string} 任务ID
   */
  enqueueNormal(data) { return this._enqueue(data, 2); }

  /**
   * 以高优先级（1）入队任务。
   * @param {*} data - 任务数据
   * @returns {string} 任务ID
   */
  enqueueHigh(data) { return this._enqueue(data, 1); }

  /**
   * 以低优先级（3）入队任务。
   * @param {*} data - 任务数据
   * @returns {string} 任务ID
   */
  enqueueLow(data) { return this._enqueue(data, 3); }

  /**
   * 内部入队方法。将任务加入堆和索引映射。
   * @param {*} data - 任务数据
   * @param {number} priority - 优先级数值（1=高，2=普通，3=低）
   * @returns {string} 任务ID
   * @throws {HarnessError} 队列已满时抛出容量超限异常
   * @private
   */
  _enqueue(data, priority) {
    this.guardShutdown();
    if (this._entries.size >= this._maxSize) throw new HarnessError('CAPACITY_EXCEEDED', 'Task queue is full');
    const id = counterId(ID_PREFIXES.DEEPENING_TQ);
    const entry = { id, data, priority };
    this._heap.push(entry);
    this._entries.set(id, entry);
    this._totalQueued++;
    return id;
  }

  /**
   * 出队最高优先级任务。跳过已取消的任务（惰性过滤）。
   * @returns {Object|null} 任务对象，包含 id、data、priority；队列为空返回 null
   */
  dequeue() {
    if (this._heap.size === 0) return null;
    const entry = this._heap.pop();
    this._entries.delete(entry.id);
    if (this._cancelled.has(entry.id)) {
      this._cancelled.delete(entry.id);
      return this.dequeue();
    }
    return entry;
  }

  /**
   * 获取当前队列大小。
   * @returns {number} 队列中的任务数量
   */
  getQueueSize() { return this._entries.size; }

  /**
   * 取消指定任务。标记为已取消，出队时自动跳过。
   * @param {string} id - 任务ID
   * @returns {boolean} 取消成功返回 true，任务不存在返回 false
   */
  cancelTask(id) { if (this._entries.delete(id)) { this._cancelled.add(id); return true; } return false; }

  /**
   * 获取指定任务。
   * @param {string} id - 任务ID
   * @returns {Object|null} 任务对象，未找到返回 null
   */
  getTask(id) { const e = this._entries.get(id); return e ?? null; }

  /**
   * 获取任务队列统计信息。
   * @returns {Object} 统计对象，包含 queueSize、maxSize、concurrency、totalQueued
   */
  getStats() {
    return { queueSize: this._entries.size, maxSize: this._maxSize, concurrency: this._concurrency, totalQueued: this._totalQueued, ...super.getStats() };
  }

  /**
   * 关闭时清理取消集合和队列。
   * @protected
   */
  _onShutdown() {
    this._cancelled.clear();
    this._heap.clear();
    this._entries.clear();
    super._onShutdown();
  }
}

module.exports = DeepeningTaskQueue;
