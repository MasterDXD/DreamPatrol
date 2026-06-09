'use strict';
const DeepeningBase = require('./deepening-base');
const { requireString_ } = require('../../utils/param-validator');
const { MS_PER_MINUTE, MS_PER_HOUR } = require('../../utils/constants');
const { HarnessError, DeepeningError } = require('../../errors');
const { debug } = require('../../utils/debug-logger');

/**
 * @module runtime/deepening/deepening-rate-limiter
 * 多维度限流器。强制执行并发执行上限、每分钟和每小时的Agent速率窗口、
 * 以及可配置填充间隔的令牌桶节流。支持按Agent自定义限制和命名桶创建。
 */

/**
 * @classdesc 多维度限流器 — 为深化操作提供并发、时间窗口和令牌桶三维度限流能力。
 * 强制执行并发执行上限、每分钟和每小时的Agent速率窗口、
 * 以及可配置填充间隔的令牌桶节流。支持按Agent自定义限制和命名桶创建。
 *
 * @extends DeepeningBase
 * @emits 'bucketCreated' 当令牌桶创建时触发，附带 {name, rate, capacity}
 * @emits 'bucketRemoved' 当令牌桶移除时触发，附带 {name}
 * @emits 'allowed' 当请求被允许时触发，附带 {name, tokensRemaining}
 * @emits 'denied' 当请求被拒绝时触发，附带 {name, retryAfter}
 * @emits 'bucketReset' 当令牌桶重置时触发，附带 {name}
 * @emits 'rateUpdated' 当令牌桶速率更新时触发，附带 {name, newRate}
 */
class DeepeningRateLimiter extends DeepeningBase {
  /**
   * 创建 DeepeningRateLimiter 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxConcurrent=10] - 最大并发执行数
   * @param {number} [options.maxPerMinute=60] - 每分钟最大请求数
   * @param {number} [options.maxPerHour=1000] - 每小时最大请求数
   * @param {number} [options.maxAgentLimits=200] - 最大Agent自定义限制数
   * @param {number} [options.defaultRate=10] - 令牌桶默认填充速率
   * @param {number} [options.defaultCapacity=10] - 令牌桶默认容量
   * @param {number} [options.refillInterval=1000] - 令牌桶填充间隔（毫秒）
   */
  constructor(options) {
    super(options);
    this._maxConcurrent = (options && options.maxConcurrent) ?? 10;
    this._maxPerMinute = (options && options.maxPerMinute) ?? 60;
    this._maxPerHour = (options && options.maxPerHour) ?? 1000;
    this._activeExecutions = new Map();
    this._agentLimits = new Map();
    this._maxAgentLimits = (options && options.maxAgentLimits) ?? 200;
    this._agentMinuteUsage = new Map();
    this._maxAgentUsageEntries = 500;
    this._acceptedCount = 0;
    this._rejectedCount = 0;
    this._defaultRate = (options && options.defaultRate) ?? 10;
    this._defaultCapacity = (options && options.defaultCapacity) ?? 10;
    this._refillInterval = (options && options.refillInterval) ?? 1000;
    this._agentHourUsage = new Map();
    this._buckets = new Map();
    this._maxBuckets = (options && options.maxBuckets) ?? 100;
    this._totalAllowed = 0;
    this._totalDenied = 0;
  }

  /**
   * 创建命名令牌桶。
   * @param {string} name - 桶名称
   * @param {Object} [options] - 桶配置选项
   * @param {number} [options.rate] - 填充速率，默认 defaultRate
   * @param {number} [options.capacity] - 桶容量，默认 defaultCapacity
   * @returns {boolean} 创建成功返回 true，桶已存在返回 false
   * @emits 'bucketCreated' 桶创建成功时触发，附带 {name, rate, capacity}
   */
  createBucket(name, options) {
    this.guardShutdown();
    requireString_(name, 'Bucket name');
    if (this._buckets.has(name)) return false;
    if (this._buckets.size >= this._maxBuckets) return false;
    const opts = options ?? {};
    const bucket = { name, rate: opts.rate ?? this._defaultRate, capacity: opts.capacity ?? this._defaultCapacity, tokens: opts.capacity ?? this._defaultCapacity, allowed: 0, denied: 0, lastRefill: Date.now() };
    this._buckets.set(name, bucket);
    this.emit('bucketCreated', { name, rate: bucket.rate, capacity: bucket.capacity });
    return true;
  }

  /**
   * 移除命名令牌桶。
   * @param {string} name - 桶名称
   * @returns {boolean} 移除成功返回 true，桶不存在返回 false
   * @emits 'bucketRemoved' 桶移除时触发，附带 {name}
   */
  removeBucket(name) {
    this.guardShutdown();
    if (!this._buckets.has(name)) return false;
    this._buckets.delete(name);
    this.emit('bucketRemoved', { name });
    return true;
  }

  /**
   * 获取所有令牌桶名称。
   * @returns {Array<string>} 桶名称数组
   */
  getBucketNames() { return Array.from(this._buckets.keys()); }

  /**
   * 获取指定令牌桶的状态信息（自动填充后）。
   * @param {string} name - 桶名称
   * @returns {Object|null} 桶状态 {name, rate, capacity, allowed, denied, utilization}，桶不存在返回 null
   */
  getBucket(name) {
    const bucket = this._buckets.get(name);
    if (!bucket) return null;
    this._refillBucket(bucket);
    return { name: bucket.name, rate: bucket.rate, capacity: bucket.capacity, allowed: bucket.allowed, denied: bucket.denied, utilization: bucket.capacity > 0 ? Math.max(0, (bucket.capacity - bucket.tokens) / bucket.capacity) : 0 };
  }

  /**
   * 根据填充间隔为令牌桶补充令牌。
   * @param {Object} bucket - 令牌桶对象
   * @private
   */
  _refillBucket(bucket) {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = this._refillInterval > 0 ? Math.floor(elapsed / this._refillInterval) * bucket.rate : bucket.rate;
    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }
  }

  /**
   * 尝试从指定令牌桶消费令牌。
   * @param {string} name - 桶名称
   * @param {number} [count=1] - 消费令牌数
   * @returns {Object} 消费结果 {allowed, tokensRemaining?|retryAfter?}
   * @throws {HarnessError} 当桶不存在时抛出 DEEPENING_RATE_LIMITED 异常
   * @emits 'allowed' 请求被允许时触发，附带 {name, tokensRemaining}
   * @emits 'denied' 请求被拒绝时触发，附带 {name, retryAfter}
   */
  tryConsume(name, count) {
    if (!this._buckets.has(name)) throw new HarnessError('DEEPENING_RATE_LIMITED', 'Bucket not found: ' + name);
    const bucket = this._buckets.get(name);
    this._refillBucket(bucket);
    const n = count ?? 1;
    if (bucket.tokens >= n) {
      bucket.tokens -= n;
      bucket.allowed++;
      this._totalAllowed++;
      this.emit('allowed', { name, tokensRemaining: bucket.tokens });
      return { allowed: true, tokensRemaining: bucket.tokens };
    }
    bucket.denied++;
    this._totalDenied++;
    const retryAfter = bucket.rate > 0 ? Math.ceil((n - bucket.tokens) / bucket.rate) * this._refillInterval : this._refillInterval;
    this.emit('denied', { name, retryAfter });
    return { allowed: false, retryAfter };
  }

  /**
   * 重置指定令牌桶（恢复满容量，清零统计）。
   * @param {string} name - 桶名称
   * @returns {boolean} 重置成功返回 true，桶不存在返回 false
   * @emits 'bucketReset' 桶重置时触发，附带 {name}
   */
  resetBucket(name) {
    const bucket = this._buckets.get(name);
    if (!bucket) return false;
    bucket.tokens = bucket.capacity;
    bucket.allowed = 0;
    bucket.denied = 0;
    bucket.lastRefill = Date.now();
    this.emit('bucketReset', { name });
    return true;
  }

  /**
   * 更新指定令牌桶的填充速率。
   * @param {string} name - 桶名称
   * @param {number} rate - 新的填充速率（正数）
   * @returns {boolean} 更新成功返回 true
   * @throws {HarnessError} 当桶不存在时抛出 DEEPENING_RATE_LIMITED 异常
   * @throws {DeepeningError} 当速率非正数时抛出 INVALID_VALUE 异常
   * @emits 'rateUpdated' 速率更新时触发，附带 {name, newRate}
   */
  updateRate(name, rate) {
    if (!this._buckets.has(name)) throw new HarnessError('DEEPENING_RATE_LIMITED', 'Bucket not found: ' + name);
    if (typeof rate !== 'number' || rate <= 0) throw new DeepeningError('INVALID_VALUE', 'Rate must be a positive number');
    const bucket = this._buckets.get(name);
    bucket.rate = rate;
    this.emit('rateUpdated', { name, newRate: rate });
    return true;
  }

  /**
   * 检查Agent每分钟速率限制。
   * @param {string} agentKey - Agent键
   * @param {number} maxPerMinute - 每分钟最大请求数
   * @returns {boolean} 未超限返回 true，超限返回 false
   * @private
   */
  _checkMinuteRate(agentKey, maxPerMinute) {
    const now = Date.now();
    const expiredKeys = [];
    for (const [key, entry] of this._agentMinuteUsage) {
      if (now - entry.windowStart > 2 * MS_PER_MINUTE) {
        expiredKeys.push(key);
      }
    }
    for (const key of expiredKeys) {
      this._agentMinuteUsage.delete(key);
    }
    if (this._agentMinuteUsage.size >= this._maxAgentUsageEntries && !this._agentMinuteUsage.has(agentKey)) {
      const oldest = this._agentMinuteUsage.keys().next().value;
      this._agentMinuteUsage.delete(oldest);
    }
    const usage = this._agentMinuteUsage.get(agentKey) ?? { count: 0, windowStart: now };
    if (now - usage.windowStart >= MS_PER_MINUTE) {
      usage.count = 0;
      usage.windowStart = now;
    }
    if (usage.count >= maxPerMinute) {
      this._rejectedCount++;
      return false;
    }
    usage.count++;
    this._agentMinuteUsage.set(agentKey, usage);
    return true;
  }

  /**
   * 检查Agent每小时速率限制。
   * @param {string} agentKey - Agent键
   * @returns {boolean} 未超限返回 true，超限返回 false
   * @private
   */
  _checkHourRate(agentKey) {
    const now = Date.now();
    const expiredKeys = [];
    for (const [key, entry] of this._agentHourUsage) {
      if (now - entry.windowStart > 2 * MS_PER_HOUR) {
        expiredKeys.push(key);
      }
    }
    for (const key of expiredKeys) {
      this._agentHourUsage.delete(key);
    }
    if (this._agentHourUsage.size >= this._maxAgentUsageEntries && !this._agentHourUsage.has(agentKey)) {
      const oldest = this._agentHourUsage.keys().next().value;
      this._agentHourUsage.delete(oldest);
    }
    const usage = this._agentHourUsage.get(agentKey) ?? { count: 0, windowStart: now };
    if (now - usage.windowStart >= MS_PER_HOUR) {
      usage.count = 0;
      usage.windowStart = now;
    }
    if (usage.count >= this._maxPerHour) return false;
    usage.count++;
    this._agentHourUsage.set(agentKey, usage);
    return true;
  }

  /**
   * 获取执行许可（并发+时间窗口限流）。
   * @param {string} executionId - 执行标识
   * @param {string} [agentId] - Agent标识
   * @returns {Promise<boolean>} 获得许可返回 true，被拒绝返回 false
   */
  async acquire(executionId, agentId) {
    this.guardShutdown();
    if (!this.isHealthy()) return false;
    if (this._activeExecutions.size >= this._maxConcurrent) {
      this._rejectedCount++;
      return false;
    }
    const agentKey = agentId ?? '_default';
    const agentLimit = this._agentLimits.get(agentKey);
    if (!this._checkHourRate(agentKey)) {
      return false;
    }
    const maxPerMinute = agentLimit ? agentLimit.maxPerMinute : this._maxPerMinute;
    if (!this._checkMinuteRate(agentKey, maxPerMinute)) return false;
    this._activeExecutions.set(executionId, { agentId, startTime: Date.now() });
    this._acceptedCount++;
    return true;
  }

  /**
   * 释放执行许可。
   * @param {string} executionId - 执行标识
   * @returns {boolean} 释放成功返回 true，执行不存在返回 false
   */
  release(executionId) {
    if (!this._activeExecutions.has(executionId)) return false;
    this._activeExecutions.delete(executionId);
    return true;
  }

  /**
   * 设置Agent自定义速率限制。
   * @param {string} agentId - Agent标识
   * @param {Object} limits - 限制配置
   * @param {number} [limits.maxPerMinute] - 该Agent每分钟最大请求数
   * @returns {boolean} 设置成功返回 true
   */
  setAgentLimit(agentId, limits) {
    this.guardShutdown();
    if (this._agentLimits.size >= this._maxAgentLimits) {
      const oldest = this._agentLimits.keys().next().value;
      if (oldest !== undefined) this._agentLimits.delete(oldest);
    }
    this._agentLimits.set(agentId, limits);
    return true;
  }

  /**
   * 移除Agent自定义速率限制。
   * @param {string} agentId - Agent标识
   * @returns {boolean} 移除成功返回 true，限制不存在返回 false
   */
  removeAgentLimit(agentId) {
    this.guardShutdown();
    return this._agentLimits.delete(agentId);
  }

  /**
   * 获取当前可用性信息。
   * @returns {Object} 可用性信息 {concurrent, perMinute, perHour}
   */
  getAvailability() {
    return {
      concurrent: { available: this._maxConcurrent - this._activeExecutions.size, max: this._maxConcurrent },
      perMinute: { available: this._maxPerMinute, max: this._maxPerMinute },
      perHour: { available: this._maxPerHour, max: this._maxPerHour },
    };
  }

  /**
   * 关闭时的清理回调。清空所有执行、限制和桶数据。
   * @protected
   */
  _onShutdown() {
    this._activeExecutions.clear();
    this._agentLimits.clear();
    this._agentMinuteUsage.clear();
    this._agentHourUsage.clear();
    this._buckets.clear();
    this._acceptedCount = 0;
    this._rejectedCount = 0;
    this._totalAllowed = 0;
    this._totalDenied = 0;
    super._onShutdown();
  }

  /**
   * 获取限流器的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalBuckets - 令牌桶总数
   * @returns {number} return.totalAllowed - 令牌桶累计允许数
   * @returns {number} return.totalDenied - 令牌桶累计拒绝数
   * @returns {number} return.defaultRate - 默认填充速率
   * @returns {number} return.defaultCapacity - 默认容量
   * @returns {Object} return.buckets - 所有令牌桶状态
   * @returns {number} return.activeExecutions - 活跃执行数
   * @returns {number} return.acceptedCount - 累计接受数
   * @returns {number} return.rejectedCount - 累计拒绝数
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('DeepeningRateLimiter', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { healthy: false, shutDown: true, totalBuckets: 0, totalAllowed: 0, totalDenied: 0, defaultRate: 0, defaultCapacity: 0, buckets: {}, activeExecutions: 0, acceptedCount: 0, rejectedCount: 0 }; }
    const buckets = {};
    for (const [name] of this._buckets) {
      const raw = this._buckets.get(name);
      buckets[name] = raw ? { ...raw } : null;
    }
    return {
      ...super.getStats(),
      totalBuckets: this._buckets.size,
      totalAllowed: this._totalAllowed,
      totalDenied: this._totalDenied,
      defaultRate: this._defaultRate,
      defaultCapacity: this._defaultCapacity,
      buckets,
      activeExecutions: this._activeExecutions.size,
      acceptedCount: this._acceptedCount,
      rejectedCount: this._rejectedCount,
    };
  }
}

module.exports = DeepeningRateLimiter;
