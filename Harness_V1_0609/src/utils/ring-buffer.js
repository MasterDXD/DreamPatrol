'use strict';

const { HarnessError } = require('../errors');

/**
 * 环形缓冲区（Ring Buffer / Circular Buffer）实现。
 * 固定容量的FIFO队列，当容量满时自动淘汰最旧元素。
 * 替代 Array + shift() 模式，避免 O(n) 的 shift 操作性能瓶颈。
 *
 * @module utils/ring-buffer
 * @example
 * const RingBuffer = require('./ring-buffer');
 * const buf = new RingBuffer(3);
 * buf.push(1); buf.push(2); buf.push(3);
 * buf.push(4); // 自动淘汰 1
 * buf.toArray(); // [2, 3, 4]
 */

class RingBuffer {
  /**
   * @classdesc 环形缓冲
   * 创建指定容量的环形缓冲区。
   * @param {number} capacity - 缓冲区最大容量，必须 >= 1
   * @throws {Error} capacity < 1 时抛出错误
   */
  constructor(capacity) {
    if (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity < 1) throw new HarnessError('INVALID_INPUT', 'capacity must be >= 1');
    this._capacity = capacity;
    this._buffer = new Array(capacity);
    this._head = 0;
    this._tail = 0;
    this._size = 0;
  }

  /** 当前元素数量。@type {number} */
  get size() { return this._size; }

  /** 缓冲区最大容量。@type {number} */
  get capacity() { return this._capacity; }

  /**
   * 向缓冲区尾部添加元素。容量满时自动淘汰头部元素。
   * @param {*} item - 要添加的元素
   * @returns {number} 添加后的元素数量
   */
  push(item) {
    this._buffer[this._tail] = item;
    this._tail = (this._tail + 1) % this._capacity;
    if (this._size < this._capacity) {
      this._size++;
    } else {
      this._head = (this._head + 1) % this._capacity;
    }
    return this._size;
  }

  /**
   * 向缓冲区尾部添加元素并返回被淘汰的元素数组。
   * @param {*} item - 要添加的元素
   * @returns {Array} 被淘汰的元素数组，无淘汰时为空数组
   */
  pushWithEvicted(item) {
    const evicted = [];
    if (this._size >= this._capacity) {
      evicted.push(this._buffer[this._head]);
    }
    this._buffer[this._tail] = item;
    this._tail = (this._tail + 1) % this._capacity;
    if (this._size < this._capacity) {
      this._size++;
    } else {
      this._head = (this._head + 1) % this._capacity;
    }
    return evicted;
  }

  /**
   * 从缓冲区头部移除并返回元素。
   * @returns {*} 头部元素，缓冲区为空时返回 undefined
   */
  shift() {
    if (this._size === 0) return undefined;
    const item = this._buffer[this._head];
    this._buffer[this._head] = undefined;
    this._head = (this._head + 1) % this._capacity;
    this._size--;
    return item;
  }

  /**
   * 查看头部元素但不移除。
   * @returns {*} 头部元素，缓冲区为空时返回 undefined
   */
  peek() {
    if (this._size === 0) return undefined;
    return this._buffer[this._head];
  }

  /**
   * 查看尾部元素但不移除。
   * @returns {*} 尾部元素，缓冲区为空时返回 undefined
   */
  peekLast() {
    if (this._size === 0) return undefined;
    const idx = (this._tail - 1 + this._capacity) % this._capacity;
    return this._buffer[idx];
  }

  /** 清空缓冲区。 */
  clear() {
    this._buffer = new Array(this._capacity);
    this._head = 0;
    this._tail = 0;
    this._size = 0;
  }

  /**
   * 将缓冲区内容转为数组（从旧到新）。
   * @returns {Array} 元素数组的浅拷贝
   */
  toArray() {
    const result = new Array(this._size);
    for (let i = 0; i < this._size; i++) {
      result[i] = this._buffer[(this._head + i) % this._capacity];
    }
    return result;
  }

  /**
   * JSON序列化支持，返回toArray()结果。
   * @returns {Array}
   */
  toJSON() {
    return this.toArray();
  }

  /**
   * 遍历缓冲区元素。
   * @param {function(*, number, RingBuffer): void} callback - 遍历回调
   * @param {*} [thisArg] - 回调的this绑定
   */
  forEach(callback, thisArg) {
    for (let i = 0; i < this._size; i++) {
      const item = this._buffer[(this._head + i) % this._capacity];
      callback.call(thisArg, item, i, this);
    }
  }

  /**
   * 迭代器协议支持，可用于 for...of 循环。
   * @returns {Iterator}
   */
  [Symbol.iterator]() {
    let idx = 0;
    const self = this;
    return {
      next() {
        if (idx >= self._size) return { done: true };
        const value = self._buffer[(self._head + idx) % self._capacity];
        idx++;
        return { done: false, value };
      },
    };
  }

  /**
   * 过滤缓冲区元素，返回新数组。
   * @param {function(*, number, RingBuffer): boolean} callback - 过滤条件
   * @param {*} [thisArg] - 回调的this绑定
   * @returns {Array} 过滤后的元素数组
   */
  filter(callback, thisArg) {
    const result = [];
    for (let i = 0; i < this._size; i++) {
      const item = this._buffer[(this._head + i) % this._capacity];
      if (callback.call(thisArg, item, i, this)) result.push(item);
    }
    return result;
  }

  /**
   * 映射缓冲区元素，返回新数组。
   * @param {function(*, number, RingBuffer): *} callback - 映射函数
   * @param {*} [thisArg] - 回调的this绑定
   * @returns {Array} 映射后的元素数组
   */
  map(callback, thisArg) {
    const result = new Array(this._size);
    for (let i = 0; i < this._size; i++) {
      const item = this._buffer[(this._head + i) % this._capacity];
      result[i] = callback.call(thisArg, item, i, this);
    }
    return result;
  }

  /**
   * 检查是否所有元素都满足条件。
   * @param {function(*, number, RingBuffer): boolean} callback - 条件函数
   * @param {*} [thisArg] - 回调的this绑定
   * @returns {boolean}
   */
  every(callback, thisArg) {
    for (let i = 0; i < this._size; i++) {
      const item = this._buffer[(this._head + i) % this._capacity];
      if (!callback.call(thisArg, item, i, this)) return false;
    }
    return true;
  }

  /**
   * 检查是否存在满足条件的元素。
   * @param {function(*, number, RingBuffer): boolean} callback - 条件函数
   * @param {*} [thisArg] - 回调的this绑定
   * @returns {boolean}
   */
  some(callback, thisArg) {
    for (let i = 0; i < this._size; i++) {
      const item = this._buffer[(this._head + i) % this._capacity];
      if (callback.call(thisArg, item, i, this)) return true;
    }
    return false;
  }

  /**
   * 检查是否包含指定元素（严格相等）。
   * @param {*} item - 要查找的元素
   * @returns {boolean}
   */
  includes(item) {
    for (let i = 0; i < this._size; i++) {
      if (this._buffer[(this._head + i) % this._capacity] === item) return true;
    }
    return false;
  }

  /**
   * 按索引获取元素。
   * @param {number} index - 元素索引（0为最旧元素）
   * @returns {*} 对应索引的元素，越界返回 undefined
   */
  get(index) {
    if (index < 0 || index >= this._size) return undefined;
    return this._buffer[(this._head + index) % this._capacity];
  }

  /**
   * 截取缓冲区片段，支持负索引。
   * @param {number} [start=0] - 起始索引（支持负数）
   * @param {number} [end=size] - 结束索引（不含，支持负数）
   * @returns {Array} 截取的元素数组
   */
  slice(start, end) {
    const s = start !== undefined ? (start < 0 ? Math.max(0, this._size + start) : start) : 0;
    const e = end !== undefined ? (end < 0 ? Math.max(0, this._size + end) : Math.min(end, this._size)) : this._size;
    const result = [];
    for (let i = s; i < e; i++) {
      result.push(this._buffer[(this._head + i) % this._capacity]);
    }
    return result;
  }

  /**
   * 归约缓冲区元素。
   * @param {function(*, *, number, RingBuffer): *} callback - 归约函数
   * @param {*} [initialValue] - 初始值，省略则使用第一个元素
   * @returns {*} 归约结果
   * @throws {TypeError} 缓冲区为空且未提供初始值时抛出
   */
  reduce(callback, initialValue) {
    let acc = initialValue;
    let startIdx = 0;
    if (arguments.length < 2) {
      if (this._size === 0) throw new TypeError('Reduce of empty RingBuffer with no initial value');
      acc = this._buffer[this._head];
      startIdx = 1;
    }
    for (let i = startIdx; i < this._size; i++) {
      acc = callback(acc, this._buffer[(this._head + i) % this._capacity], i, this);
    }
    return acc;
  }
}

module.exports = RingBuffer;
