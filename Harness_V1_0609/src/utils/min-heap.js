'use strict';

/**
 * @module utils/min-heap
 * MinHeap — 二叉最小堆
 * 基于数组的二叉最小堆实现，支持自定义比较函数。提供O(log n)的插入和删除操作，
 * O(1)的堆顶访问。用于优先级调度和有序数据结构场景。
 * @classdesc 最小堆
 */
class MinHeap {
  /**
   * 创建最小堆实例
   * @param {Function} [compareFn] - 比较函数，返回负数表示a<b，默认为数值比较
   */
  constructor(compareFn) {
    if (compareFn !== undefined && typeof compareFn !== 'function') throw new TypeError('compareFn must be a function');
    this._heap = [];
    this._compare = compareFn || function(a, b) { return a - b; };
  }

  /**
   * 获取堆中元素数量
   * @returns {number} 元素数量
   */
  get size() { return this._heap.length; }

  /**
   * 向堆中插入元素
   * @param {*} item - 待插入的元素
   */
  push(item) {
    this._heap.push(item);
    this._siftUp(this._heap.length - 1);
  }

  /**
   * 弹出堆顶最小元素
   * @returns {*|undefined} 堆顶元素，堆为空时返回undefined
   */
  pop() {
    if (this._heap.length === 0) return undefined;
    const top = this._heap[0];
    const last = this._heap.pop();
    if (this._heap.length > 0) {
      this._heap[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  /**
   * 查看堆顶元素但不移除
   * @returns {*|undefined} 堆顶元素，堆为空时返回undefined
   */
  peek() {
    return this._heap.length > 0 ? this._heap[0] : undefined;
  }

  /**
   * 清空堆
   */
  clear() {
    this._heap.length = 0;
  }

  /**
   * 将堆内容导出为数组副本
   * @returns {Array} 堆元素数组
   */
  toArray() {
    return this._heap.slice();
  }

  /**
   * 上浮操作，维护堆性质
   * @param {number} index - 起始索引
   * @private
   */
  _siftUp(index) {
    const heap = this._heap;
    const compare = this._compare;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      if (compare(heap[index], heap[parentIndex]) < 0) {
        const tmp = heap[index];
        heap[index] = heap[parentIndex];
        heap[parentIndex] = tmp;
        index = parentIndex;
      } else {
        break;
      }
    }
  }

  /**
   * 下沉操作，维护堆性质
   * @param {number} index - 起始索引
   * @private
   */
  _siftDown(index) {
    const heap = this._heap;
    const compare = this._compare;
    const length = heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (left < length && compare(heap[left], heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < length && compare(heap[right], heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest !== index) {
        const tmp = heap[index];
        heap[index] = heap[smallest];
        heap[smallest] = tmp;
        index = smallest;
      } else {
        break;
      }
    }
  }
}

module.exports = MinHeap;
