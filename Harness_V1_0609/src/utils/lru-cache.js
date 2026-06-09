'use strict';

const { withShutdown } = require('./shutdown-mixin');

/**
 * @module utils/lru-cache
 * LRUCache — 最近最少使用缓存
 * 基于Map的LRU淘汰策略缓存实现。访问时自动将条目移至最近位置，
 * 容量满时淘汰最久未访问的条目。提供O(1)的增删查改操作，支持迭代和优雅关闭。
 * @classdesc LRU缓存。LRU淘汰
 */
class LRUCache {
  /**
   * 创建LRU缓存实例
   * @param {number} [maxSize=50] - 最大缓存条目数
   */
  constructor(maxSize) {
    if (typeof maxSize !== 'number' || !Number.isFinite(maxSize) || maxSize <= 0) maxSize = 50;
    this._maxSize = maxSize;
    this._cache = new Map();
  }

  /**
   * 获取缓存值，访问时自动移至最近位置
   * @param {*} key - 缓存键
   * @returns {*|undefined} 缓存值，不存在时返回undefined
   * @example
   * const cache = new LRUCache(3);
   * cache.set('a', 1);
   * cache.set('b', 2);
   * cache.get('a'); // 1 — 'a' moved to most-recent
   * cache.set('c', 3);
   * cache.set('d', 4); // 'b' evicted (least recently used)
   */
  get(key) {
    if (!this._cache) return undefined;
    if (!this._cache.has(key)) return undefined;
    const value = this._cache.get(key);
    this._cache.delete(key);
    this._cache.set(key, value);
    return value;
  }

  /**
   * 设置缓存键值对，容量满时淘汰最久未访问的条目
   * @param {*} key - 缓存键
   * @param {*} value - 缓存值
   * @example
   * const cache = new LRUCache(2);
   * cache.set('x', 10);
   * cache.set('y', 20);
   * cache.set('z', 30); // 'x' evicted
   * cache.get('x');      // undefined
   */
  set(key, value) {
    this.guardShutdown();
    if (!this._cache) return;
    if (this._cache.has(key)) {
      this._cache.delete(key);
    } else if (this._cache.size >= this._maxSize) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
    this._cache.set(key, value);
  }

  /**
   * 检查缓存键是否存在
   * @param {*} key - 缓存键
   * @returns {boolean} 是否存在
   */
  has(key) {
    return this._cache ? this._cache.has(key) : false;
  }

  /**
   * 删除指定缓存条目
   * @param {*} key - 缓存键
   * @returns {boolean} 是否成功删除
   */
  delete(key) {
    this.guardShutdown();
    return this._cache ? this._cache.delete(key) : false;
  }

  /**
   * 获取当前缓存条目数
   * @returns {number} 条目数
   */
  get size() {
    return this._cache ? this._cache.size : 0;
  }

  /**
   * 清空缓存
   */
  clear() {
    this.guardShutdown();
    if (this._cache) this._cache.clear();
  }

  /**
   * 获取所有缓存键的迭代器
   * @returns {Iterator} 键迭代器
   */
  keys() {
    return this._cache ? this._cache.keys() : [].values();
  }

  /**
   * 获取所有缓存值的迭代器
   * @returns {Iterator} 值迭代器
   */
  values() {
    return this._cache ? this._cache.values() : [].values();
  }

  /**
   * 获取所有缓存条目的迭代器
   * @returns {Iterator} 条目迭代器
   */
  entries() {
    return this._cache ? this._cache.entries() : [].entries();
  }

  /**
   * 遍历缓存条目
   * @param {Function} callback - 遍历回调函数
   */
  forEach(callback) {
    if (this._cache) this._cache.forEach(callback);
  }

  /**
   * 关闭缓存，清空并释放资源
   */
  _onShutdown() {
    if (this._cache) this._cache.clear();
    this._cache = null;
  }

  /**
   * 检查实例是否健康。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._cache !== null;
  }
}

module.exports = withShutdown(LRUCache);
