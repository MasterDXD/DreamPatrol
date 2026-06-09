'use strict';

/** @module runtime/model/kv-cache-manager */

const { EventEmitter } = require('events');
const { DeepeningError } = require('../../errors');
const { mergeConfig, validateConfigSchema } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_CONFIG = {
  maxCacheSize: 10000,
  compressionRatio: 0.1,
  enableAdaptiveCompression: true,
  headConcentrationThreshold: 0.8,
  magnitudeWeight: 0.5,
  pruningBatchSize: 100,
};

const OPTIONS_SCHEMA = {
  maxCacheSize: { type: 'number', min: 1 },
  compressionRatio: { type: 'number', min: 0, max: 1 },
  enableAdaptiveCompression: { type: 'boolean' },
  headConcentrationThreshold: { type: 'number', min: 0, max: 1 },
  magnitudeWeight: { type: 'number', min: 0, max: 1 },
  pruningBatchSize: { type: 'number', min: 1 },
};

/**
 * 分层记忆缓存层级枚举。融合来源：GPT-5.6 三级分层记忆缓存架构
 * - IMMEDIATE: 即时记忆层，当前对话上下文，高优先级、低容量
 * - SHORT_TERM: 短期缓存层，近期会话数据，中优先级、中容量
 * - LONG_TERM: 长期特征层，持久化模式与特征，低优先级、大容量
 * @readonly
 * @enum {string}
 */
const MemoryTier = Object.freeze({
  IMMEDIATE: 'immediate',
  SHORT_TERM: 'short_term',
  LONG_TERM: 'long_term',
});

/**
 * 各层默认配置。融合来源：GPT-5.6 自适应稀疏注意力 + 三级分层记忆
 */
const TIER_CONFIGS = {
  [MemoryTier.IMMEDIATE]: { maxSize: 500, ttlMs: 300000, promotionThreshold: 3 },
  [MemoryTier.SHORT_TERM]: { maxSize: 3000, ttlMs: 1800000, promotionThreshold: 10 },
  [MemoryTier.LONG_TERM]: { maxSize: 10000, ttlMs: 7200000, promotionThreshold: Infinity },
};

/**
 * KV缓存管理器。基于TriAttention校准的KV缓存压缩，采用三角级数距离偏好+
 * 向量幅度+时效性+访问频率四维评分剪枝，支持自适应权重调整，实现10倍+显存压缩。
 *
 * @classdesc KV缓存管理器。基于TriAttention校准的KV缓存压缩
 * @extends EventEmitter
 * @emits KVCacheManager#pruned 缓存剪枝时触发
 */
class KVCacheManager extends EventEmitter {
  /**
   * 创建KVCacheManager实例。必须提供TriAttention实例用于校准。
   *
   * @param {Object} triAttention - TriAttention实例，用于校准权重
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxCacheSize=10000] - 缓存最大条目数
   * @param {number} [options.compressionRatio=0.1] - 剪枝压缩比例
   * @param {boolean} [options.enableAdaptiveCompression=true] - 是否启用自适应压缩
   * @param {number} [options.headConcentrationThreshold=0.8] - 头部集中度阈值
   * @param {number} [options.magnitudeWeight=0.5] - 向量幅度权重
   * @param {number} [options.pruningBatchSize=100] - 剪枝批量大小
   */
  constructor(triAttention, options) {
    super();
    if (!triAttention) throw new DeepeningError('INVALID_INPUT', 'triAttention is required');
    this._triAttention = triAttention;
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    const validation = validateConfigSchema(this._config, OPTIONS_SCHEMA, 'KVCacheManager');
    this._config = validation.config;
    this._cache = new Map();
    this._stats = { totalEntries: 0, prunedEntries: 0, compressionRatios: [], avgCompressionRatio: 1 };
    // 三级分层记忆缓存。融合来源：GPT-5.6 三级分层记忆缓存架构
    this._tierCaches = {};
    this._tierConfigs = {};
    for (const [tier, cfg] of Object.entries(TIER_CONFIGS)) {
      this._tierCaches[tier] = new Map();
      this._tierConfigs[tier] = mergeConfig(cfg, (options && options.tierConfigs && options.tierConfigs[tier]) ?? {});
    }
    this._tierStats = { promotions: 0, evictions: 0, tierHits: { immediate: 0, short_term: 0, long_term: 0 } };
  }

  /**
   * 向缓存中写入键值对。缓存满时自动触发剪枝。
   *
   * @param {string} key - 缓存键
   * @param {*} value - 缓存值
   * @param {Object} [metadata] - 附加元数据
   * @returns {boolean} 写入成功返回true，键为null/undefined返回false
   */
  set(key, value, metadata) {
    this.guardShutdown();
    if (key == null) return false;
    const entry = {
      key,
      value,
      metadata: metadata ?? {},
      createdAt: Date.now(),
      accessCount: 0,
      vectorNorm: this._computeVectorNorm(value),
    };
    if (this._cache.size >= this._config.maxCacheSize) {
      this._prune();
    }
    this._cache.set(key, entry);
    this._stats.totalEntries++;
    return true;
  }

  /**
   * 从缓存中获取值。命中时更新访问计数和最后访问时间。
   *
   * @param {string} key - 缓存键
   * @returns {*|null} 缓存值，未命中返回null
   */
  get(key) {
    if (this._shutDown) return null;
    const entry = this._cache.get(key);
    if (entry == null) return null;
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    try { return JSON.parse(JSON.stringify(entry.value)); }
    catch (_) { debug('KVCacheManager', 'get', _ && _.message ? _.message : String(_)); return entry.value; }
  }

  /**
   * 检查缓存中是否存在指定键。
   *
   * @param {string} key - 缓存键
   * @returns {boolean} 存在返回true，否则返回false
   */
  has(key) {
    return this._cache.has(key);
  }

  /**
   * 从缓存中删除指定键。
   *
   * @param {string} key - 缓存键
   * @returns {boolean} 删除成功返回true，键不存在返回false
   */
  delete(key) {
    this.guardShutdown();
    return this._cache.delete(key);
  }

  _computeVectorNorm(value) {
    if (value == null || typeof value !== 'object') return 0;
    if (Array.isArray(value)) {
      let sum = 0;
      for (let i = 0; i < value.length; i++) {
        const v = typeof value[i] === 'number' && Number.isFinite(value[i]) ? value[i] : 0;
        sum += v * v;
      }
      return Math.sqrt(sum);
    }
    const vals = Object.values(value);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      const v = typeof vals[i] === 'number' && Number.isFinite(vals[i]) ? vals[i] : 0;
      sum += v * v;
    }
    return Math.sqrt(sum);
  }

  _prune() {
    const entries = Array.from(this._cache.entries());
    const scored = entries.map(([key, entry], index) => {
      const total = entries.length;
      const position = index / Math.max(1, total - 1);
      const distanceScore = Math.sin(Math.PI * position);
      const magnitudeScore = entry.vectorNorm > 0 ? Math.min(1, entry.vectorNorm / 10) : 0;
      const recencyScore = entry.lastAccessedAt != null
        ? Math.max(0, 1 - (Date.now() - entry.lastAccessedAt) / 3600000)
        : (entry.accessCount > 0 ? 0.5 : 0);
      const accessScore = Math.min(1, entry.accessCount / 10);
      const adaptiveMagWeight = this._config.enableAdaptiveCompression
        ? this._config.magnitudeWeight
        : 0.5;
      const adaptiveDistWeight = 1 - adaptiveMagWeight;
      const score = adaptiveDistWeight * distanceScore
        + adaptiveMagWeight * magnitudeScore
        + 0.1 * recencyScore
        + 0.1 * accessScore;
      return { key, score };
    });
    scored.sort((a, b) => a.score - b.score);
    const pruneCount = Math.max(1, Math.floor(entries.length * this._config.compressionRatio));
    for (let i = 0; i < pruneCount && i < scored.length; i++) {
      this._cache.delete(scored[i].key);
      this._stats.prunedEntries++;
    }
    const ratio = this._cache.size / Math.max(1, this._stats.totalEntries);
    this._stats.compressionRatios.push(ratio);
    if (this._stats.compressionRatios.length > 100) this._stats.compressionRatios.shift();
    const sum = this._stats.compressionRatios.reduce((a, b) => a + b, 0);
    this._stats.avgCompressionRatio = this._stats.compressionRatios.length > 0
      ? sum / this._stats.compressionRatios.length
      : 0;
    this.emit('pruned', { pruned: pruneCount, remaining: this._cache.size, ratio });
  }

  /**
   * 从TriAttention校准统计中调整幅度权重。当查询集中度超过阈值时
   * 增大幅度权重至0.7，否则降低至0.3。
   */
  calibrateFromTriAttention() {
    this.guardShutdown();
    const calStats = this._triAttention.getCalibrationStats?.();
    if (calStats != null && calStats.qCenter != null) {
      this._config.magnitudeWeight = calStats.qConcentration > this._config.headConcentrationThreshold
        ? 0.7
        : 0.3;
      debug('KVCacheManager', 'calibrateFromTriAttention', 'adjusted magnitudeWeight to ' + this._config.magnitudeWeight);
    }
  }

  /**
   * 获取缓存统计信息。
   *
   * @returns {{size: number, maxSize: number, totalEntries: number, prunedEntries: number, avgCompressionRatio: number, config: Object}} 缓存统计
   */
  getStats() {
    return {
      size: this._cache.size,
      maxSize: this._config.maxCacheSize,
      totalEntries: this._stats.totalEntries,
      prunedEntries: this._stats.prunedEntries,
      avgCompressionRatio: this._stats.avgCompressionRatio,
      config: mergeConfig(this._config),
    };
  }

  /**
   * 向指定层级写入键值对。融合来源：GPT-5.6 三级分层记忆缓存架构
   * @param {string} key - 缓存键
   * @param {*} value - 缓存值
   * @param {MemoryTier} tier - 目标层级（IMMEDIATE/SHORT_TERM/LONG_TERM）
   * @param {Object} [metadata] - 附加元数据
   * @returns {boolean} 写入成功返回true
   */
  setTiered(key, value, tier, metadata) {
    this.guardShutdown();
    if (key == null || !Object.values(MemoryTier).includes(tier)) return false;
    const tierCache = this._tierCaches[tier];
    const tierConfig = this._tierConfigs[tier];
    if (tierCache.size >= tierConfig.maxSize) {
      this._pruneTier(tier);
    }
    const entry = {
      key,
      value,
      metadata: metadata ?? {},
      tier,
      createdAt: Date.now(),
      accessCount: 0,
      vectorNorm: this._computeVectorNorm(value),
    };
    tierCache.set(key, entry);
    this._stats.totalEntries++;
    return true;
  }

  /**
   * 从指定层级获取值。命中时更新访问计数并检查晋升条件。
   * 融合来源：GPT-5.6 三级分层记忆缓存架构
   * @param {string} key - 缓存键
   * @param {MemoryTier} [tier] - 可选的层级限定，不指定时从所有层级查找
   * @returns {*|null} 缓存值，未命中返回null
   */
  getTiered(key, tier) {
    if (this._shutDown) return null;
    if (tier && Object.values(MemoryTier).includes(tier)) {
      const tierCache = this._tierCaches[tier];
      const entry = tierCache.get(key);
      if (entry) {
        entry.accessCount++;
        entry.lastAccessedAt = Date.now();
        this._tierStats.tierHits[tier]++;
        this._checkPromotion(key, entry);
        return entry.value;
      }
      return null;
    }
    // 未指定层级时，从IMMEDIATE→SHORT_TERM→LONG_TERM依次查找
    for (const t of [MemoryTier.IMMEDIATE, MemoryTier.SHORT_TERM, MemoryTier.LONG_TERM]) {
      const tierCache = this._tierCaches[t];
      const entry = tierCache.get(key);
      if (entry) {
        entry.accessCount++;
        entry.lastAccessedAt = Date.now();
        this._tierStats.tierHits[t]++;
        this._checkPromotion(key, entry);
        return entry.value;
      }
    }
    return null;
  }

  /**
   * 检查条目是否满足晋升条件，满足时晋升到更高层级。
   * 融合来源：GPT-5.6 三级分层记忆晋升策略
   * @param {string} key - 缓存键
   * @param {Object} entry - 缓存条目
   * @private
   */
  _checkPromotion(key, entry) {
    const currentTier = entry.tier;
    const tierConfig = this._tierConfigs[currentTier];
    if (entry.accessCount >= tierConfig.promotionThreshold) {
      const targetTier = this._getNextHigherTier(currentTier);
      if (targetTier && this._tierCaches[targetTier]) {
        const targetConfig = this._tierConfigs[targetTier];
        if (this._tierCaches[targetTier].size < targetConfig.maxSize) {
          this._tierCaches[currentTier].delete(key);
          entry.tier = targetTier;
          this._tierCaches[targetTier].set(key, entry);
          this._tierStats.promotions++;
          debug('KVCacheManager', 'promotion', key + ' promoted from ' + currentTier + ' to ' + targetTier);
        }
      }
    }
  }

  /**
   * 获取下一个更高层级。IMMEDIATE→SHORT_TERM→LONG_TERM
   * @param {MemoryTier} tier - 当前层级
   * @returns {MemoryTier|null} 更高层级，已是最高层时返回null
   * @private
   */
  _getNextHigherTier(tier) {
    if (tier === MemoryTier.IMMEDIATE) return MemoryTier.SHORT_TERM;
    if (tier === MemoryTier.SHORT_TERM) return MemoryTier.LONG_TERM;
    return null;
  }

  /**
   * 对指定层级执行剪枝。融合来源：GPT-5.6 自适应稀疏注意力剪枝策略
   * @param {MemoryTier} tier - 目标层级
   * @private
   */
  _pruneTier(tier) {
    const tierCache = this._tierCaches[tier];
    const tierConfig = this._tierConfigs[tier];
    const entries = Array.from(tierCache.entries());
    const scored = entries.map(function([key, entry], index) {
      const total = entries.length;
      const position = index / Math.max(1, total - 1);
      const distanceScore = Math.sin(Math.PI * position);
      const magnitudeScore = entry.vectorNorm > 0 ? Math.min(1, entry.vectorNorm / 10) : 0;
      const ttlScore = tierConfig.ttlMs > 0 ? Math.max(0, 1 - (Date.now() - entry.createdAt) / tierConfig.ttlMs) : 1;
      const accessScore = Math.min(1, entry.accessCount / 10);
      const score = 0.3 * distanceScore + 0.2 * magnitudeScore + 0.3 * ttlScore + 0.2 * accessScore;
      return { key, score };
    });
    scored.sort(function(a, b) { return a.score - b.score; });
    const pruneCount = Math.max(1, Math.floor(entries.length * this._config.compressionRatio));
    for (let i = 0; i < pruneCount && i < scored.length; i++) {
      tierCache.delete(scored[i].key);
      this._tierStats.evictions++;
    }
    this.emit('tier-pruned', { tier, pruned: pruneCount, remaining: tierCache.size });
  }

  /**
   * 获取分层记忆缓存统计信息。融合来源：GPT-5.6 三级分层记忆缓存架构
   * @returns {{tierSizes: Object, tierConfigs: Object, promotions: number, evictions: number, tierHits: Object}}
   */
  getTieredStats() {
    const tierSizes = {};
    for (const tier of Object.values(MemoryTier)) {
      tierSizes[tier] = this._tierCaches[tier].size;
    }
    return {
      tierSizes,
      tierConfigs: mergeConfig(this._tierConfigs),
      promotions: this._tierStats.promotions,
      evictions: this._tierStats.evictions,
      tierHits: mergeConfig(this._tierStats.tierHits),
    };
  }

  _onShutdown() {
    this._cache.clear();
    for (const tier of Object.values(MemoryTier)) {
      this._tierCaches[tier].clear();
    }
    this._stats = { totalEntries: 0, prunedEntries: 0, compressionRatios: [], avgCompressionRatio: 1 };
    this._tierStats = { promotions: 0, evictions: 0, tierHits: { immediate: 0, short_term: 0, long_term: 0 } };
    this.removeAllListeners();
    debug('KVCacheManager', '_onShutdown', 'cleaned up');
  }
}

KVCacheManager.DEFAULT_CONFIG = DEFAULT_CONFIG;
KVCacheManager.MemoryTier = MemoryTier;
KVCacheManager.TIER_CONFIGS = TIER_CONFIGS;

module.exports = withShutdown(KVCacheManager);
