'use strict';

const { safeCall } = require('./safe-execute');

/**
 * @module utils/bounded-map
 * BoundedMap — 有界映射
 * 固定容量上限的Map封装，容量满时按FIFO策略淘汰最早插入的条目。
 * 支持淘汰回调通知、淘汰计数统计、完整迭代接口和优雅关闭。
 * @classdesc 有界映射。容量限制
 */
class BoundedMap {
  /**
   * 创建有界映射实例
   * @param {number} maxSize - 最大容量
   * @param {Object} [options] - 配置选项
   * @param {Function} [options.onEvict] - 淘汰回调函数，接收(key, value)参数
   * @throws {TypeError} maxSize不是正数时抛出
   */
  constructor(maxSize, options) {
    if (typeof maxSize !== 'number' || !Number.isFinite(maxSize) || maxSize <= 0) {
      throw new TypeError('BoundedMap maxSize must be a positive number');
    }
    this._maxSize = maxSize;
    this._map = new Map();
    this._evictedCount = 0;
    this._onEvict = (options && typeof options.onEvict === 'function') ? options.onEvict : null;
  }

  /**
   * 获取指定键的值
   * @param {*} key - 键
   * @returns {*|undefined} 值，不存在时返回undefined
   */
  get(key) {
    return this._map ? this._map.get(key) : undefined;
  }

  /**
   * 设置键值对，容量满时淘汰最早插入的条目
   * @param {*} key - 键
   * @param {*} value - 值
   * @returns {BoundedMap} 当前实例，支持链式调用
   * @example
   * const map = new BoundedMap(2);
   * map.set('a', 1).set('b', 2);
   * map.set('c', 3); // 'a' evicted, map now has 'b' and 'c'
   */
  set(key, value) {
    this.guardShutdown();
    if (!this._map) return this;
    if (this._map.has(key)) {
      this._map.set(key, value);
    } else {
      if (this._map.size >= this._maxSize) {
        const oldestKey = this._map.keys().next().value;
        const oldestValue = this._map.get(oldestKey);
        this._map.delete(oldestKey);
        this._evictedCount++;
        if (this._onEvict) {
          safeCall(() => this._onEvict(oldestKey, oldestValue), 'BoundedMap', 'onEvict');
        }
      }
      this._map.set(key, value);
    }
    return this;
  }

  /**
   * 检查指定键是否存在
   * @param {*} key - 键
   * @returns {boolean} 是否存在
   */
  has(key) {
    return this._map ? this._map.has(key) : false;
  }

  /**
   * 删除指定键的条目
   * @param {*} key - 键
   * @returns {boolean} 是否成功删除
   */
  delete(key) {
    this.guardShutdown();
    if (!this._map) return false;
    return this._map.delete(key);
  }

  /**
   * 获取当前条目数
   * @returns {number} 条目数
   */
  get size() {
    return this._map ? this._map.size : 0;
  }

  /**
   * 获取最大容量
   * @returns {number} 最大容量
   */
  get maxSize() {
    return this._maxSize;
  }

  /**
   * 获取已淘汰条目数
   * @returns {number} 淘汰数
   */
  get evictedCount() {
    return this._evictedCount;
  }

  /**
   * 清空所有条目并重置淘汰计数
   */
  clear() {
    this.guardShutdown();
    if (!this._map) return;
    this._map.clear();
    this._evictedCount = 0;
  }

  /**
   * 获取所有键的迭代器
   * @returns {Iterator} 键迭代器
   */
  keys() {
    return this._map ? this._map.keys() : [].values();
  }

  /**
   * 获取所有值的迭代器
   * @returns {Iterator} 值迭代器
   */
  values() {
    return this._map ? this._map.values() : [].values();
  }

  /**
   * 获取所有条目的迭代器
   * @returns {Iterator} 条目迭代器
   */
  entries() {
    return this._map ? this._map.entries() : [].values();
  }

  /**
   * 遍历所有条目
   * @param {Function} callback - 遍历回调函数
   */
  forEach(callback) {
    this.guardShutdown();
    if (this._map) this._map.forEach(callback);
  }

  /**
   * 获取默认迭代器
   * @returns {Iterator} 条目迭代器
   */
  [Symbol.iterator]() {
    return this._map ? this._map[Symbol.iterator]() : [].values();
  }

  /**
   * 关闭映射，清空并释放资源
   */
  shutdown() {
    this._shutDown = true;
    if (this._map) {
      this._map.clear();
    }
    this._map = null;
    this._evictedCount = 0;
  }

  guardShutdown() {
    if (this._shutDown) throw new Error('BoundedMap is shut down');
  }

  /**
   * 检查实例是否健康。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._map !== null;
  }
}

/** @constant {number} BoundedMap.DEFAULT_MAX - 默认最大容量 */
BoundedMap.DEFAULT_MAX = 1000;

module.exports = BoundedMap;
