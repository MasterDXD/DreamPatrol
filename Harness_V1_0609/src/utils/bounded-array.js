'use strict';

const { HarnessError } = require('../errors');
const { safeCall } = require('./safe-execute');

/**
 * @module utils/bounded-array
 * BoundedArray — 有界数组
 * 固定容量的环形缓冲区实现，支持FIFO和LRU两种淘汰策略。容量满时
 * FIFO模式淘汰最早元素，LRU模式淘汰最久未访问元素。提供类Array接口
 * （push/slice/map/forEach/reduce/find等）和淘汰回调通知。
 * @classdesc 有界数组。容量限制
 */
class BoundedArray {
  /**
   * 创建有界数组实例
   * @param {number} maxSize - 最大容量（1-1000000）
   * @param {Object} [options] - 配置选项
   * @param {Function} [options.onEvict] - 淘汰回调函数
   * @param {string} [options.strategy='fifo'] - 淘汰策略，'fifo'或'lru'
   * @throws {HarnessError} maxSize不是1-1000000之间的正数时抛出INVALID_INPUT错误
   */
  constructor(maxSize, options) {
    if (typeof maxSize !== 'number' || !Number.isFinite(maxSize) || maxSize <= 0 || maxSize > 1000000) {
      throw new HarnessError('INVALID_INPUT', 'BoundedArray maxSize must be a positive number (1-1000000)');
    }
    this._maxSize = maxSize;
    this._buffer = new Array(maxSize);
    this._head = 0;
    this._tail = 0;
    this._size = 0;
    this._onEvict = (options && typeof options.onEvict === 'function') ? options.onEvict : null;
    this._evictedCount = 0;
    this._strategy = (options && options.strategy) || 'fifo';
    this._accessTimes = new Map();
  }

  /**
   * 向数组末尾添加元素，容量满时按策略淘汰
   * @param {*} item - 待添加的元素
   * @returns {number} 添加后的元素数量
   * @example
   * const arr = new BoundedArray(3, { strategy: 'fifo' });
   * arr.push('a'); // 1
   * arr.push('b'); // 2
   * arr.push('c'); // 3
   * arr.push('d'); // 3 — 'a' evicted, now ['b','c','d']
   */
  push(item) {
    this.guardShutdown();
    if (!this._buffer) return 0;
    if (this._strategy === 'lru' && this._size === this._maxSize) {
      const evictIdx = this._findLRUIndex();
      if (evictIdx >= 0) {
        const realEvictIdx = (this._head + evictIdx) % this._maxSize;
        const evictedItem = this._buffer[realEvictIdx];
        if (this._onEvict) {
          safeCall(() => this._onEvict(evictedItem), 'BoundedArray', 'onEvict');
        }
        for (let i = evictIdx; i > 0; i--) {
          this._buffer[(this._head + i) % this._maxSize] = this._buffer[(this._head + i - 1) % this._maxSize];
        }
        this._buffer[this._head] = undefined;
        this._head = (this._head + 1) % this._maxSize;
        this._accessTimes.delete(realEvictIdx);
        this._rebuildAccessTimes(evictIdx);
        this._buffer[this._tail] = item;
        this._accessTimes.set(this._tail, Date.now());
        this._tail = (this._tail + 1) % this._maxSize;
        this._evictedCount++;
        return this._size;
      }
    }
    if (this._strategy !== 'lru' && this._size === this._maxSize) {
      const evictedItem = this._buffer[this._head];
      if (this._onEvict) {
        safeCall(() => this._onEvict(evictedItem), 'BoundedArray', 'onEvict');
      }
      this._buffer[this._head] = item;
      this._head = (this._head + 1) % this._maxSize;
      this._evictedCount++;
    } else {
      this._buffer[this._tail] = item;
      if (this._strategy === 'lru') {
        this._accessTimes.set(this._tail, Date.now());
      }
      this._tail = (this._tail + 1) % this._maxSize;
      this._size++;
    }
    return this._size;
  }

  /**
   * 更新指定索引元素的访问时间（LRU策略）
   * @param {number} index - 逻辑索引
   * @returns {boolean} 是否成功更新
   */
  touch(index) {
    this.guardShutdown();
    if (!this._buffer) return false;
    if (index < 0 || index >= this._size) return false;
    const realIdx = (this._head + index) % this._maxSize;
    this._accessTimes.set(realIdx, Date.now());
    return true;
  }

  /**
   * 查找最久未访问元素的逻辑索引
   * @returns {number} 逻辑索引，-1表示未找到
   * @private
   */
  _findLRUIndex() {
    let oldestTime = Infinity;
    let oldestIdx = -1;
    for (let i = 0; i < this._size; i++) {
      const realIdx = (this._head + i) % this._maxSize;
      const accessTime = this._accessTimes.get(realIdx) ?? 0;
      if (accessTime < oldestTime) {
        oldestTime = accessTime;
        oldestIdx = i;
      }
    }
    return oldestIdx;
  }

  /**
   * 重建访问时间映射表
   * @param {number} shiftedFromIdx - 移位起始逻辑索引
   * @private
   */
  _rebuildAccessTimes(shiftedFromIdx) {
    const newTimes = new Map();
    for (let i = 0; i < this._size; i++) {
      const realIdx = (this._head + i) % this._maxSize;
      const oldRealIdx = i < shiftedFromIdx
        ? (this._head - 1 + i + this._maxSize) % this._maxSize
        : realIdx;
      const t = this._accessTimes.get(oldRealIdx);
      if (t !== undefined) {
        newTimes.set(realIdx, t);
      }
    }
    this._accessTimes = newTimes;
  }

  /**
   * 获取当前元素数量
   * @returns {number} 元素数量
   */
  get length() {
    return this._buffer ? this._size : 0;
  }

  /**
   * 获取最大容量
   * @returns {number} 最大容量
   */
  get maxSize() {
    return this._maxSize;
  }

  /**
   * 获取已淘汰元素数
   * @returns {number} 淘汰数
   */
  get evictedCount() {
    return this._evictedCount;
  }

  /**
   * 将环形缓冲区内容导出为普通数组
   * @returns {Array} 元素数组
   * @private
   */
  _toArray() {
    if (!this._buffer) return [];
    const result = [];
    for (let i = 0; i < this._size; i++) {
      result.push(this._buffer[(this._head + i) % this._maxSize]);
    }
    return result;
  }

  /**
   * 截取数组片段
   * @param {number} [start] - 起始索引
   * @param {number} [end] - 结束索引
   * @returns {Array} 截取的元素数组
   */
  slice(start, end) {
    return this._toArray().slice(start, end);
  }

  /**
   * 过滤数组元素
   * @param {Function} fn - 过滤函数
   * @returns {Array} 过滤后的元素数组
   */
  filter(fn) {
    return this._toArray().filter(fn);
  }

  /**
   * 映射数组元素
   * @param {Function} fn - 映射函数
   * @returns {Array} 映射后的数组
   */
  map(fn) {
    return this._toArray().map(fn);
  }

  /**
   * 遍历数组元素
   * @param {Function} fn - 遍历回调函数
   */
  forEach(fn) {
    if (!this._buffer) return;
    for (let i = 0; i < this._size; i++) {
      fn(this._buffer[(this._head + i) % this._maxSize], i, this);
    }
  }

  /**
   * 归约数组元素
   * @param {Function} fn - 归约函数
   * @param {*} [initial] - 初始值
   * @returns {*} 归约结果
   */
  reduce(fn, initial) {
    if (!this._buffer) return initial;
    let acc = initial;
    let first = true;
    for (let i = 0; i < this._size; i++) {
      const item = this._buffer[(this._head + i) % this._maxSize];
      if (first && acc === undefined) {
        acc = item;
        first = false;
      } else {
        acc = fn(acc, item, i, this);
      }
    }
    return acc;
  }

  /**
   * 查找第一个满足条件的元素
   * @param {Function} fn - 条件函数
   * @returns {*|undefined} 找到的元素，未找到返回undefined
   */
  find(fn) {
    if (!this._buffer) return undefined;
    for (let i = 0; i < this._size; i++) {
      const item = this._buffer[(this._head + i) % this._maxSize];
      if (fn(item, i, this)) return item;
    }
    return undefined;
  }

  /**
   * 检查是否存在满足条件的元素
   * @param {Function} fn - 条件函数
   * @returns {boolean} 是否存在
   */
  some(fn) {
    if (!this._buffer) return false;
    for (let i = 0; i < this._size; i++) {
      if (fn(this._buffer[(this._head + i) % this._maxSize], i, this)) return true;
    }
    return false;
  }

  /**
   * 检查是否所有元素都满足条件
   * @param {Function} fn - 条件函数
   * @returns {boolean} 是否全部满足
   */
  every(fn) {
    if (!this._buffer) return true;
    for (let i = 0; i < this._size; i++) {
      if (!fn(this._buffer[(this._head + i) % this._maxSize], i, this)) return false;
    }
    return true;
  }

  /**
   * 检查是否包含指定元素
   * @param {*} item - 待检查的元素
   * @returns {boolean} 是否包含
   */
  includes(item) {
    if (!this._buffer) return false;
    for (let i = 0; i < this._size; i++) {
      if (this._buffer[(this._head + i) % this._maxSize] === item) return true;
    }
    return false;
  }

  /**
   * 查找指定元素的索引
   * @param {*} item - 待查找的元素
   * @returns {number} 元素索引，未找到返回-1
   */
  indexOf(item) {
    if (!this._buffer) return -1;
    for (let i = 0; i < this._size; i++) {
      if (this._buffer[(this._head + i) % this._maxSize] === item) return i;
    }
    return -1;
  }

  /**
   * 获取指定逻辑索引的元素
   * @param {number} index - 逻辑索引
   * @returns {*|undefined} 元素值，索引越界返回undefined
   */
  get(index) {
    if (!this._buffer || index < 0 || index >= this._size) return undefined;
    return this._buffer[(this._head + index) % this._maxSize];
  }

  /**
   * 将数组内容导出为普通数组
   * @returns {Array} 元素数组
   */
  toArray() {
    return this._toArray();
  }

  /**
   * 清空数组并重置所有状态
   */
  clear() {
    this.guardShutdown();
    if (!this._buffer) return;
    for (let i = 0; i < this._maxSize; i++) {
      this._buffer[i] = undefined;
    }
    this._head = 0;
    this._tail = 0;
    this._size = 0;
    this._evictedCount = 0;
    this._accessTimes.clear();
  }

  /**
   * 获取默认迭代器
   * @returns {Iterator} 元素迭代器
   */
  [Symbol.iterator]() {
    let idx = 0;
    const self = this;
    if (!self._buffer) return [].values();
    return {
      next() {
        if (idx < self._size) {
          const value = self._buffer[(self._head + idx) % self._maxSize];
          idx++;
          return { value, done: false };
        }
        return { done: true, value: undefined };
      },
    };
  }

  /**
   * 获取条目迭代器
   * @returns {Iterator} 条目迭代器
   */
  entries() {
    const arr = this._toArray();
    return arr.entries();
  }

  /**
   * 从可迭代对象创建有界数组
   * @param {Iterable} iterable - 可迭代对象
   * @param {number} maxSize - 最大容量
   * @returns {BoundedArray} 有界数组实例
   * @static
   */
  static from(iterable, maxSize) {
    const arr = new BoundedArray(maxSize);
    for (const item of iterable) {
      arr.push(item);
    }
    return arr;
  }

  /**
   * 获取当前元素数量
   * @returns {number} 元素数量
   */
  get size() {
    return this._buffer ? this._size : 0;
  }

  /**
   * 关闭数组，清空并释放资源
   */
  shutdown() {
    this._shutDown = true;
    if (this._buffer) {
      for (let i = 0; i < this._maxSize; i++) {
        this._buffer[i] = undefined;
      }
      this._head = 0;
      this._tail = 0;
      this._size = 0;
      this._accessTimes.clear();
    }
    this._buffer = null;
    this._evictedCount = 0;
  }

  guardShutdown() {
    if (this._shutDown) throw new Error('BoundedArray is shut down');
  }

  /**
   * 检查实例是否健康。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._buffer !== null;
  }
}

/** @constant {number} BoundedArray.DEFAULT_MAX - 默认最大容量 */
BoundedArray.DEFAULT_MAX = 1000;

module.exports = BoundedArray;
