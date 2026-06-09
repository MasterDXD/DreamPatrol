'use strict';

const { EventEmitter } = require('events');
const { DEFAULT_MAX_QUEUE_SIZE } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_PRIORITY = 5;
const DEFAULT_MAX_SIZE = DEFAULT_MAX_QUEUE_SIZE;

/**
 * @module runtime/infrastructure/priority-queue
 * PriorityQueue — 优先级队列
 * 基于二叉堆的优先级队列实现，低优先级值先出队。同优先级按插入顺序（FIFO）排列。
 * 容量满时自动淘汰最低优先级条目，支持序列号保序、统计信息和优雅关闭。
 * @classdesc 优先级队列。堆实现、优先级调度
 * @extends EventEmitter
 */
class PriorityQueue extends EventEmitter {
  /**
   * 创建 PriorityQueue 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxSize] - 队列最大容量，默认使用 DEFAULT_MAX_QUEUE_SIZE
   */
  constructor(options) {
    super();
    this._maxSize = Math.max(1, (options && options.maxSize) ?? DEFAULT_MAX_SIZE);
    this._heap = [];
    this._size = 0;
    this._seqCounter = 0;
    this._stats = { pushed: 0, popped: 0, evicted: 0 };
    this._shutDown = false;
  }

  /**
   * 将条目推入优先级队列。容量满时自动淘汰最低优先级条目。条目须为对象，可包含 priority 和 id 字段。
   * @param {Object} item - 入队条目，须为对象，可包含 priority（数字，默认5）和 id 字段
   * @returns {number} 入队后队列的大小，关闭或条目无效时返回 0
   */
  push(item) {
    if (!this.isHealthy()) return 0;
    if (!item || typeof item !== 'object') return 0;
    if (this._size >= this._maxSize) {
      this._evictLowest();
    }
    item._seq = this._seqCounter++;
    this._heap.push(item);
    this._size++;
    this._bubbleUp(this._size - 1);
    this._stats.pushed++;
    this.emit('pushed', { id: item.id, priority: item.priority !== undefined ? item.priority : DEFAULT_PRIORITY });
    return this._size;
  }

  /**
   * 弹出优先级最高的条目（优先级值最小者）。同优先级按插入顺序（FIFO）出队。
   * @returns {Object|undefined} 优先级最高的条目，队列为空或已关闭时返回 undefined
   */
  pop() {
    if (!this.isHealthy() || this._size === 0) return undefined;
    const top = this._heap[0];
    const last = this._heap.pop();
    this._size--;
    if (this._size > 0) {
      this._heap[0] = last;
      this._sinkDown(0);
    }
    this._stats.popped++;
    return top;
  }

  /**
   * 查看队首条目但不移除。
   * @returns {Object|undefined} 队首条目，队列为空时返回 undefined
   */
  peek() {
    return this._size > 0 ? this._heap[0] : undefined;
  }

  /**
   * 获取队列当前大小。
   * @returns {number} 队列中的条目数
   */
  size() {
    return this._size;
  }

  /**
   * 检查队列是否为空。
   * @returns {boolean} 队列为空返回 true，否则返回 false
   */
  isEmpty() {
    return this._size === 0;
  }

  /**
   * 将队列中所有条目按优先级顺序输出为数组（低优先级值在前）。操作不修改原队列。
   * @returns {Object[]} 按优先级排序的条目数组
   */
  toArray() {
    const result = [];
    const copy = this._heap.slice();
    const copySize = this._size;
    const tempHeap = new PriorityQueue();
    tempHeap._heap = copy;
    tempHeap._size = copySize;
    while (!tempHeap.isEmpty()) {
      result.push(tempHeap.pop());
    }
    return result;
  }

  /**
   * 清空队列中的所有条目。
   * @returns {void}
   */
  clear() {
    this._heap = [];
    this._size = 0;
  }

  _bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this._compare(index, parentIndex) < 0) {
        this._swap(index, parentIndex);
        index = parentIndex;
      } else {
        break;
      }
    }
  }

  _sinkDown(index) {
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (left < this._size && this._compare(left, smallest) < 0) {
        smallest = left;
      }
      if (right < this._size && this._compare(right, smallest) < 0) {
        smallest = right;
      }
      if (smallest !== index) {
        this._swap(index, smallest);
        index = smallest;
      } else {
        break;
      }
    }
  }

  _compare(a, b) {
    const rawA = this._heap[a].priority;
    const rawB = this._heap[b].priority;
    const priorityA = (typeof rawA === 'number' && Number.isFinite(rawA)) ? rawA : DEFAULT_PRIORITY;
    const priorityB = (typeof rawB === 'number' && Number.isFinite(rawB)) ? rawB : DEFAULT_PRIORITY;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const seqA = this._heap[a]._seq ?? 0;
    const seqB = this._heap[b]._seq ?? 0;
    return seqA - seqB;
  }

  _swap(a, b) {
    const temp = this._heap[a];
    this._heap[a] = this._heap[b];
    this._heap[b] = temp;
  }

  _evictLowest() {
    if (this._size <= 1) return;
    let lowestIdx = this._size - 1;
    let lowestPriority = Number.isFinite(this._heap[lowestIdx].priority) ? this._heap[lowestIdx].priority : DEFAULT_PRIORITY;
    let lowestSeq = this._heap[lowestIdx]._seq ?? 0;
    for (let i = this._size - 2; i >= Math.floor(this._size / 2); i--) {
      const p = Number.isFinite(this._heap[i].priority) ? this._heap[i].priority : DEFAULT_PRIORITY;
      const s = this._heap[i]._seq ?? 0;
      if (p > lowestPriority || (p === lowestPriority && s > lowestSeq)) {
        lowestIdx = i;
        lowestPriority = p;
        lowestSeq = s;
      }
    }
    if (lowestIdx === this._size - 1) {
      this._heap.pop();
    } else {
      this._heap[lowestIdx] = this._heap.pop();
      this._bubbleUp(lowestIdx);
      this._sinkDown(lowestIdx);
    }
    this._size--;
    this._stats.evicted++;
    this.emit('evicted', { priority: lowestPriority });
  }

  _rebuildHeap() {
    for (let i = Math.floor(this._size / 2) - 1; i >= 0; i--) {
      this._sinkDown(i);
    }
  }

  /**
   * 获取优先级队列的运行统计数据。
   * @returns {{size: number, maxSize: number, pushed: number, popped: number, evicted: number, shutDown: boolean}} 统计信息对象
   */
  getStats() {
    if (typeof this._initShutdownState === 'function') this._initShutdownState();
    return {
      size: this._size,
      maxSize: this._maxSize,
      pushed: this._stats.pushed,
      popped: this._stats.popped,
      evicted: this._stats.evicted,
      shutDown: this._shutDown,
    };
  }

  /**
   * 检查优先级队列是否健康。未关闭且大小未超过最大容量时返回true。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._size <= this._maxSize;
  }

  _onShutdown() {
    this._heap = [];
    this._size = 0;
    this.removeAllListeners();
  }
}

PriorityQueue.DEFAULT_PRIORITY = DEFAULT_PRIORITY;

module.exports = withShutdown(PriorityQueue);
