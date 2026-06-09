'use strict';

const { DEFAULT_TTL_CACHE_MS } = require('./constants');
const { withShutdown } = require('./shutdown-mixin');
const { safeDateGetTime } = require('./safe-execute');
const { ensureSafeTimeout } = require('./param-validator');

/**
 * 带过期时间的缓存（TTL Cache）实现。
 * 替代代码库中散落的手动时间戳检查模式，提供统一的缓存过期管理。
 *
 * 特性：
 * - 自动过期检查（惰性删除 + 可选定时清理）
 * - 最大容量限制（LRU淘汰最早过期的条目）
 * - 完整的统计信息（命中/未命中/过期/淘汰）
 * - 静态工具方法（时间戳过期检查、过期时间计算）
 *
 * @module utils/ttl-cache
 * @example
 * const TTLCache = require('./ttl-cache');
 * const cache = new TTLCache({ defaultTTL: 60000, maxSize: 500 });
 * cache.set('key', 'value');
 * cache.get('key'); // 'value'
 * cache.isExpired('key'); // false
 */

class TTLCache {
  /**
   * @classdesc TTL过期缓存
   * 创建TTL缓存实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.defaultTTL=60000] - 默认过期时间（毫秒）
   * @param {number} [options.maxSize=1000] - 最大缓存条目数
   * @param {number} [options.cleanupInterval=0] - 自动清理间隔（毫秒），0表示禁用
   */
  constructor(options) {
    const opts = options ?? {};
    this._defaultTTL = typeof opts.defaultTTL === 'number' && Number.isFinite(opts.defaultTTL) ? opts.defaultTTL : DEFAULT_TTL_CACHE_MS;
    this._maxSize = typeof opts.maxSize === 'number' && Number.isFinite(opts.maxSize) ? opts.maxSize : 1000;
    this._cache = new Map();
    this._cleanupInterval = ensureSafeTimeout(typeof opts.cleanupInterval === 'number' && Number.isFinite(opts.cleanupInterval) ? opts.cleanupInterval : 0, 0);
    this._cleanupTimer = null;
    this._stats = { hits: 0, misses: 0, expired: 0, evicted: 0 };
    if (this._cleanupInterval > 0) {
      this._startCleanup();
    }
  }

  /** 默认TTL（毫秒）。@type {number} */
  get defaultTTL() { return this._defaultTTL; }

  /** 最大缓存条目数。@type {number} */
  get maxSize() { return this._maxSize; }

  /** 当前缓存条目数。@type {number} */
  get size() { return this._cache.size; }

  /** 缓存统计信息。@type {{hits: number, misses: number, expired: number, evicted: number, size: number}} */
  get stats() { return { ...this._stats, size: this._cache.size }; }

  /**
   * 设置缓存条目。
   * @param {string} key - 缓存键
   * @param {*} value - 缓存值
   * @param {number} [ttl] - 自定义TTL（毫秒），省略使用默认值
   * @returns {TTLCache} this（支持链式调用）
   */
  set(key, value, ttl) {
    this.guardShutdown();
    let effectiveTTL = ttl !== undefined ? ttl : this._defaultTTL;
    if (!Number.isFinite(effectiveTTL) || effectiveTTL <= 0) {
      if (effectiveTTL <= 0) {
        this._cache.delete(key);
        return this;
      }
      effectiveTTL = this._defaultTTL;
    }
    if (this._cache.size >= this._maxSize && !this._cache.has(key)) {
      this._evictOne();
    }
    this._cache.set(key, {
      value,
      expiresAt: Date.now() + effectiveTTL,
    });
    return this;
  }

  /**
   * 获取缓存条目。自动检查过期。
   * @param {string} key - 缓存键
   * @returns {*} 缓存值，不存在或已过期返回 undefined
   */
  get(key) {
    this.guardShutdown();
    const entry = this._cache.get(key);
    if (!entry) {
      this._stats.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      this._stats.expired++;
      this._stats.misses++;
      return undefined;
    }
    this._stats.hits++;
    return entry.value;
  }

  /**
   * 检查缓存键是否存在且未过期。
   * @param {string} key - 缓存键
   * @returns {boolean}
   */
  has(key) {
    this.guardShutdown();
    const entry = this._cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      this._stats.expired++;
      return false;
    }
    return true;
  }

  /**
   * 删除缓存条目。
   * @param {string} key - 缓存键
   * @returns {boolean} 是否成功删除
   */
  delete(key) {
    this.guardShutdown();
    return this._cache.delete(key);
  }

  /** 清空所有缓存条目。@returns {TTLCache} this */
  clear() {
    this.guardShutdown();
    this._cache.clear();
    return this;
  }

  /** 获取所有未过期的键。@returns {string[]} */
  keys() {
    this._purgeExpired();
    return Array.from(this._cache.keys());
  }

  /** 获取所有未过期的值。@returns {Array} */
  values() {
    this._purgeExpired();
    const result = [];
    for (const entry of this._cache.values()) {
      result.push(entry.value);
    }
    return result;
  }

  /** 获取所有未过期的键值对。@returns {Array<[string, *]>} */
  entries() {
    this._purgeExpired();
    const result = [];
    for (const [key, entry] of this._cache.entries()) {
      result.push([key, entry.value]);
    }
    return result;
  }

  /**
   * 遍历未过期的缓存条目。
   * @param {function(*, string, TTLCache): void} callback - 遍历回调
   * @param {*} [thisArg] - 回调的this绑定
   */
  forEach(callback, thisArg) {
    this._purgeExpired();
    for (const [key, entry] of this._cache.entries()) {
      callback.call(thisArg, entry.value, key, this);
    }
  }

  /**
   * 获取缓存条目的剩余TTL。
   * @param {string} key - 缓存键
   * @returns {number} 剩余毫秒数，不存在返回0
   */
  getRemainingTTL(key) {
    const entry = this._cache.get(key);
    if (!entry) return 0;
    const remaining = entry.expiresAt - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * 检查缓存条目是否已过期。
   * @param {string} key - 缓存键
   * @returns {boolean} 不存在也返回true
   */
  isExpired(key) {
    const entry = this._cache.get(key);
    if (!entry) return true;
    return Date.now() > entry.expiresAt;
  }

  /**
   * 刷新缓存条目的TTL。
   * @param {string} key - 缓存键
   * @param {number} [ttl] - 新的TTL（毫秒），省略使用默认值
   * @returns {boolean} 是否成功刷新
   */
  refresh(key, ttl) {
    this.guardShutdown();
    const entry = this._cache.get(key);
    if (!entry) return false;
    let effectiveTTL = ttl !== undefined ? ttl : this._defaultTTL;
    if (!Number.isFinite(effectiveTTL) || effectiveTTL <= 0) {
      effectiveTTL = this._defaultTTL;
    }
    entry.expiresAt = Date.now() + effectiveTTL;
    return true;
  }

  /**
   * 手动清除所有过期条目。
   * @returns {number} 清除的条目数
   */
  purgeExpired() {
    this.guardShutdown();
    const purged = this._purgeExpired();
    return purged;
  }

  /** @private 清除过期条目内部实现 */
  _purgeExpired() {
    const now = Date.now();
    let count = 0;
    const toDelete = [];
    for (const [key, entry] of this._cache.entries()) {
      if (now > entry.expiresAt) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this._cache.delete(key);
      this._stats.expired++;
      count++;
    }
    return count;
  }

  /** @private 淘汰最早过期的条目 */
  _evictOne() {
    let oldestKey = null;
    let oldestExpiry = Infinity;
    for (const [key, entry] of this._cache.entries()) {
      if (entry.expiresAt < oldestExpiry || (oldestKey === null && !Number.isFinite(entry.expiresAt))) {
        oldestExpiry = entry.expiresAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) {
      this._cache.delete(oldestKey);
      this._stats.evicted++;
    }
  }

  /** @private 启动定时清理 */
  _startCleanup() {
    if (this._cleanupTimer) return;
    const self = this;
    this._cleanupTimer = setInterval(function() {
      try { self._purgeExpired(); } catch (_e) { /* prevent timer death */ }
    }, this._cleanupInterval);
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') {
      this._cleanupTimer.unref();
    }
  }

  /** 停止定时清理。 */
  stopCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  /** 销毁缓存，停止清理并清空数据。 */
  destroy() {
    this.stopCleanup();
    this._cache.clear();
    this._stats = { hits: 0, misses: 0, expired: 0, evicted: 0 };
  }

  _onShutdown() {
    this.destroy();
  }
}

/**
 * 检查缓存条目是否已过期。支持多种时间戳格式。
 * @param {Object} entry - 缓存条目，需包含 expiresAt 或 ts+ttl 或 createdAt+ttlMs
 * @param {number} [now=Date.now()] - 当前时间戳
 * @returns {boolean}
 */
TTLCache.isEntryExpired = function isEntryExpired(entry, now) {
  if (!entry) return true;
  const checkTime = now !== undefined ? now : Date.now();
  if (entry.expiresAt !== undefined) return checkTime > entry.expiresAt;
  if (entry.ts !== undefined && entry.ttl !== undefined) return checkTime - entry.ts > entry.ttl;
  if (entry.createdAt !== undefined) {
    const createdTs = typeof entry.createdAt === 'number' ? entry.createdAt : safeDateGetTime(entry.createdAt);
    if (isNaN(createdTs)) return true;
    return checkTime - createdTs > (typeof entry.ttlMs === 'number' && Number.isFinite(entry.ttlMs) ? entry.ttlMs : (typeof entry.ttl === 'number' && Number.isFinite(entry.ttl) ? entry.ttl : Infinity));
  }
  return false;
};

/**
 * 计算过期时间戳。
 * @param {number} ttlMs - TTL毫秒数
 * @returns {number} 过期时间戳
 */
TTLCache.computeExpiresAt = function computeExpiresAt(ttlMs) {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) return Date.now() + DEFAULT_TTL_CACHE_MS;
  return Date.now() + ttlMs;
};

/**
 * 检查时间戳是否已过期。
 * @param {number|string} timestamp - 时间戳（数字或ISO字符串）
 * @param {number} ttlMs - TTL毫秒数
 * @param {number} [now=Date.now()] - 当前时间戳
 * @returns {boolean} 无效时间戳返回true
 */
TTLCache.isTimestampExpired = function isTimestampExpired(timestamp, ttlMs, now) {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) return true;
  const checkTime = now !== undefined ? now : Date.now();
  const ts = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : safeDateGetTime(timestamp);
  if (isNaN(ts)) return true;
  return checkTime - ts > ttlMs;
};

module.exports = withShutdown(TTLCache);
