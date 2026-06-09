/**
 * @module runtime/model/inference-cache
 * @description 推理缓存模块，提供基于LRU淘汰和TTL过期的推理结果缓存机制。
 * 当相同或相似的Prompt重复请求时，可直接复用缓存结果，避免重复调用模型推理，
 * 从而节省Token消耗和响应时间。支持缓存命中统计、自动过期清理和容量溢出淘汰。
 *
 * v2.10.1增强（借鉴OpenClaw 4.5缓存优化思路）：
 * - 缓存键标准化：对Prompt和上下文进行标准化处理，提高语义相同但格式不同的请求命中率
 * - 分层TTL策略：热/温/冷数据采用不同TTL，高频访问的缓存条目存活更久
 * - 缓存-成本闭环：缓存命中时将节省的Token反馈到TokenManager成本控制系统
 * - 增强统计：按分层统计命中率、累计节省Token、估算节省成本等
 */

'use strict';

const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { ensureSafeTimeout } = require('../../utils/param-validator');
const crypto = require('crypto');

/**
 * @typedef {Object} CacheEntry
 * @property {*} result - 缓存的推理结果
 * @property {number} tokenEstimate - 该条目预估节省的Token数量
 * @property {number} createdAt - 条目创建时间戳（Date.now()）
 * @property {number} hitCount - 累计命中次数
 * @property {number} effectiveTtl - 条目实际生效的TTL（毫秒），由分层策略动态调整
 */

/**
 * @typedef {Object} CacheHitResult
 * @property {*} result - 缓存的推理结果
 * @property {number} tokensSaved - 该条目预估节省的Token数量
 * @property {number} hitCount - 累计命中次数
 */

/**
 * @typedef {Object} CacheStats
 * @property {number} size - 当前缓存条目数
 * @property {number} maxSize - 缓存最大容量
 * @property {number} hits - 缓存命中次数
 * @property {number} misses - 缓存未命中次数
 * @property {number} hitRate - 缓存命中率（0~1之间）
 * @property {number} evictions - 缓存淘汰次数
 * @property {number} tokensSaved - 累计节省的Token估算总量
 * @property {number} tokensSavedTotal - 累计节省的Token总量（含已淘汰条目）
 * @property {number} costSavedEstimate - 估算节省成本（美元），按$0.01/1K Token估算
 * @property {Object} hitRateByTier - 按分层统计命中率 { hot: number, warm: number, cold: number }
 * @property {number} keyNormalizationHits - 标准化键命中次数
 */

/** @constant {number} 默认TTL（30分钟） */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** @constant {number} Token成本估算单价（美元/千Token） */
const COST_PER_1K_TOKENS = 0.01;

/** @constant {Object} 分层TTL倍率配置 */
const TIER_MULTIPLIERS = {
  hot: 2,    // hitCount >= 5，TTL延长至2倍（60分钟）
  warm: 1,   // hitCount >= 2，TTL保持默认（30分钟）
  cold: 0.5, // hitCount < 2，TTL缩短至0.5倍（15分钟）
};

/** @constant {Object} 分层命中次数阈值 */
const TIER_THRESHOLDS = {
  hot: 5,
  warm: 2,
};

/**
 * 推理缓存类，基于Map实现LRU淘汰与TTL过期策略的推理结果缓存。
 *
 * 核心特性：
 * - 基于Prompt+上下文的复合键进行缓存索引，支持键标准化提高命中率
 * - TTL（生存时间）过期自动淘汰，分层TTL策略动态调整存活时间
 * - 容量达到上限时淘汰最旧或已过期的条目
 * - 定时后台清理过期条目（定时器通过unref避免阻塞进程退出）
 * - 缓存命中/未命中/淘汰统计与Token节省估算
 * - 缓存-成本闭环：命中节省的Token反馈到TokenManager
 *
 * @classdesc 推理缓存。相似Prompt结果复用、TTL过期、LRU淘汰
 * @example
 * const cache = new InferenceCache({ maxSize: 200, ttlMs: 1800000 });
 * cache.set('你好', { text: '你好！有什么可以帮助你的？' }, null, 15);
 * const hit = cache.get('你好');
 * // hit => { result: { text: '你好！有什么可以帮助你的？' }, tokensSaved: 15, hitCount: 1 }
 */
class InferenceCache {
  /**
   * 创建推理缓存实例。
   *
   * @param {Object} [options] - 缓存配置选项
   * @param {number} [options.maxSize=100] - 缓存最大条目数，超出时触发LRU淘汰
   * @param {number} [options.ttlMs=1800000] - 缓存条目生存时间（毫秒），默认30分钟。
   *   过期条目在访问时惰性删除，同时由后台定时器周期性清理。
   *   分层TTL策略会在此基础上根据命中次数动态调整
   */
  constructor(options) {
    this._maxSize = Number.isFinite((options ?? {}).maxSize) ? (options ?? {}).maxSize : 100;
    this._ttlMs = ensureSafeTimeout(Number.isFinite((options ?? {}).ttlMs) ? (options ?? {}).ttlMs : DEFAULT_TTL_MS, DEFAULT_TTL_MS);
    this._cache = new Map();
    this._stats = { hits: 0, misses: 0, evictions: 0 };
    /** @type {TokenManager|null} 关联的TokenManager实例，用于缓存-成本闭环 */
    this._tokenManager = null;
    /** @type {number} 累计节省Token总量（含已淘汰条目） */
    this._tokensSavedTotal = 0;
    /** @type {number} 标准化键命中次数 */
    this._keyNormalizationHits = 0;
    /** @type {{ hot: number, warm: number, cold: number }} 分层命中统计 */
    this._tierHits = { hot: 0, warm: 0, cold: 0 };
    /** @type {{ hot: number, warm: number, cold: number }} 分层未命中统计 */
    this._tierMisses = { hot: 0, warm: 0, cold: 0 };
    this._cleanupInterval = setInterval(() => { if (this._shutDown) return; try { this._cleanupExpired(); } catch (e) { debug('InferenceCache', 'cleanup', e && e.message ? e.message : String(e)); } }, ensureSafeTimeout(this._ttlMs / 2, 900000));
    if (this._cleanupInterval && typeof this._cleanupInterval.unref === 'function') {
      this._cleanupInterval.unref();
    }
  }

  /**
   * 对Prompt进行标准化处理，去除格式差异以提高缓存命中率。
   * 处理步骤：去除多余空白、统一引号、排序JSON键。
   *
   * @private
   * @param {string|Object|null|undefined} prompt - 原始提示词
   * @returns {string} 标准化后的提示词字符串
   */
  _normalizePrompt(prompt) {
    if (prompt == null) return '\x00null';
    if (typeof prompt === 'string') {
      return prompt
        .replace(/\s+/g, ' ')
        .replace(/[\u2018\u2019\u201C\u201D'`]/g, '"')
        .trim();
    }
    try {
      return this._sortJsonKeys(prompt);
    } catch (_e) {
      debug('InferenceCache', '_normalizePrompt', _e && _e.message ? _e.message : String(_e));
      return String(prompt)
        .replace(/\s+/g, ' ')
        .replace(/[\u2018\u2019\u201C\u201D'`]/g, '"')
        .trim();
    }
  }

  /**
   * 对上下文进行标准化处理，提取关键特征，忽略时间戳等易变字段。
   * 移除以timestamp/date/time/updatedAt/createdAt/requestId结尾（不区分大小写）的键。
   *
   * @private
   * @param {Object|null|undefined} context - 原始上下文
   * @returns {string} 标准化后的上下文字符串
   */
  _normalizeContext(context) {
    if (!context || typeof context !== 'object') return '';
    const volatileKeyPattern = /^(timestamp|date|time|updatedAt|createdAt|requestId)$/i;
    const filtered = {};
    for (const key of Object.keys(context)) {
      if (!volatileKeyPattern.test(key)) {
        filtered[key] = context[key];
      }
    }
    try {
      return this._sortJsonKeys(filtered);
    } catch (_e) {
      debug('InferenceCache', '_normalizeContext', _e && _e.message ? _e.message : String(_e));
      return String(filtered);
    }
  }

  /**
   * 对对象进行JSON序列化并排序键，确保相同内容不同键序产生相同字符串。
   *
   * @private
   * @param {*} obj - 待序列化对象
   * @returns {string} 键排序后的JSON字符串
   */
  _sortJsonKeys(obj) {
    if (obj == null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      return JSON.stringify(obj.map(item => {
        if (item != null && typeof item === 'object') {
          try { return JSON.parse(this._sortJsonKeys(item)); }
          catch (_e) { debug('InferenceCache', 'parseSortKey', _e && _e.message ? _e.message : String(_e)); return item; }
        }
        return item;
      }));
    }
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
      const val = obj[key];
      if (val != null && typeof val === 'object') {
        try { sorted[key] = JSON.parse(this._sortJsonKeys(val)); }
        catch (_e) { debug('InferenceCache', '_sortJsonKeys', _e && _e.message ? _e.message : String(_e)); sorted[key] = val; }
      } else {
        sorted[key] = val;
      }
    }
    return JSON.stringify(sorted);
  }

  /**
   * 缓存键标准化方法。对Prompt和上下文分别标准化后生成缓存键。
   * 语义相同但格式不同的请求将产生相同的标准化键，从而提高命中率。
   *
   * @private
   * @param {string|Object|null|undefined} prompt - 提示词
   * @param {Object|null|undefined} context - 上下文信息
   * @returns {string} 标准化后的缓存键
   */
  _normalizeCacheKey(prompt, context) {
    const normalizedPrompt = this._normalizePrompt(prompt);
    const normalizedContext = this._normalizeContext(context);
    const raw = normalizedPrompt + '\x00' + normalizedContext;
    /* 检测标准化是否产生了与原始输入不同的键，用于统计标准化命中 */
    const originalRaw = (prompt != null ? String(prompt) : '\x00null') + '\x00' + (context != null ? String(context) : '');
    if (raw !== originalRaw) {
      this._keyNormalizationHits++;
    }
    if (raw.length > 256) {
      return 'h:' + crypto.createHash('sha256').update(raw).digest('hex');
    }
    return raw;
  }

  /**
   * 根据Prompt和上下文生成缓存键。
   * 优先使用标准化键查找缓存；若未命中标准化键，回退到原始键逻辑。
   *
   * @private
   * @param {string|Object|null|undefined} prompt - 提示词
   * @param {Object|null|undefined} context - 上下文信息
   * @returns {string} 缓存键字符串
   */
  _hashKey(prompt, context) {
    return this._normalizeCacheKey(prompt, context);
  }

  /**
   * 根据命中次数判断缓存条目所属分层。
   *
   * @private
   * @param {number} hitCount - 命中次数
   * @returns {'hot'|'warm'|'cold'} 分层标识
   */
  _getTier(hitCount) {
    if (hitCount >= TIER_THRESHOLDS.hot) return 'hot';
    if (hitCount >= TIER_THRESHOLDS.warm) return 'warm';
    return 'cold';
  }

  /**
   * 根据分层计算实际生效的TTL。
   *
   * @private
   * @param {'hot'|'warm'|'cold'} tier - 分层标识
   * @returns {number} 实际生效的TTL（毫秒）
   */
  _getEffectiveTtl(tier) {
    return this._ttlMs * TIER_MULTIPLIERS[tier];
  }

  /**
   * 清理所有已过期的缓存条目。
   * 由后台定时器周期性调用，遍历缓存并删除超过其生效TTL的条目。
   *
   * @private
   * @returns {void}
   */
  _cleanupExpired() {
    const now = Date.now();
    const expiredKeys = [];
    for (const [key, entry] of this._cache) {
      const tier = this._getTier(entry.hitCount);
      const effectiveTtl = this._getEffectiveTtl(tier);
      if (now - entry.createdAt > effectiveTtl) {
        expiredKeys.push(key);
        this._stats.evictions++;
      }
    }
    for (const key of expiredKeys) this._cache.delete(key);
  }

  /**
   * 从缓存中获取推理结果。
   * 若缓存命中且未过期，返回结果并更新命中计数；若未命中或已过期，返回null。
   * 命中时根据分层TTL策略动态调整条目存活时间，并通过TokenManager记录节省的Token。
   *
   * @param {string|Object} prompt - 提示词，与set时传入的值对应
   * @param {Object} [context] - 上下文信息，与set时传入的值对应
   * @returns {CacheHitResult|null}
   *   命中时返回包含结果、节省Token数和累计命中次数的对象；未命中返回null
   */
  get(prompt, context) {
    this.guardShutdown();
    const key = this._hashKey(prompt, context);
    const entry = this._cache.get(key);
    if (!entry) {
      this._stats.misses++;
      this._tierMisses.cold++;
      return null;
    }
    const tier = this._getTier(entry.hitCount);
    const effectiveTtl = this._getEffectiveTtl(tier);
    if (Date.now() - entry.createdAt > effectiveTtl) {
      this._cache.delete(key);
      this._stats.evictions++;
      this._stats.misses++;
      this._tierMisses[tier]++;
      return null;
    }
    entry.hitCount++;
    const newTier = this._getTier(entry.hitCount);
    entry.effectiveTtl = this._getEffectiveTtl(newTier);
    this._stats.hits++;
    this._tierHits[newTier]++;
    this._tokensSavedTotal += entry.tokenEstimate;
    this._reportSavings(entry.tokenEstimate);
    return { result: entry.result, tokensSaved: entry.tokenEstimate, hitCount: entry.hitCount };
  }

  /**
   * 将推理结果写入缓存。
   * 若缓存已满，先淘汰最旧或已过期的条目再写入。
   * 若未提供tokenEstimate，则根据结果JSON序列化长度按4字符≈1 Token估算。
   *
   * @param {string|Object} prompt - 提示词，作为缓存键的一部分
   * @param {*} result - 推理结果，可为任意可序列化值
   * @param {Object} [context] - 上下文信息，作为缓存键的一部分
   * @param {number} [tokenEstimate] - 预估该结果节省的Token数量，
   *   默认按 Math.ceil(JSON.stringify(result).length / 4) 估算
   * @returns {void}
   */
  set(prompt, result, context, tokenEstimate) {
    this.guardShutdown();
    const key = this._hashKey(prompt, context);
    if (this._cache.size >= this._maxSize) {
      this._evictOldest();
    }
    let estimate = tokenEstimate;
    if (!Number.isFinite(estimate)) {
      try { estimate = Math.ceil(JSON.stringify(result).length / 4); }
      catch (_e) { debug('InferenceCache', 'set:estimateTokens', _e && _e.message ? _e.message : String(_e)); estimate = 0; }
    }
    const tier = 'cold';
    this._cache.set(key, {
      result,
      tokenEstimate: estimate,
      createdAt: Date.now(),
      hitCount: 0,
      effectiveTtl: this._getEffectiveTtl(tier),
    });
  }

  /**
   * 淘汰最旧的缓存条目。
   * 优先淘汰已过期的条目；若无过期条目，则淘汰创建时间最早的条目。
   * 在缓存容量达到上限时由set方法内部调用。
   *
   * @private
   * @returns {void}
   */
  _evictOldest() {
    const now = Date.now();
    let expiredKey = null;
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this._cache) {
      const tier = this._getTier(entry.hitCount);
      const effectiveTtl = this._getEffectiveTtl(tier);
      if (now - entry.createdAt > effectiveTtl) {
        expiredKey = key;
        break;
      }
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    const keyToDelete = expiredKey || oldestKey;
    if (keyToDelete !== null) {
      this._cache.delete(keyToDelete);
      this._stats.evictions++;
    }
  }

  /**
   * 使指定Prompt和上下文对应的缓存条目失效。
   * 从缓存中删除匹配的条目。
   *
   * @param {string|Object} prompt - 提示词，与set时传入的值对应
   * @param {Object} [context] - 上下文信息，与set时传入的值对应
   * @returns {boolean} 若条目存在并被删除返回true，否则返回false
   */
  invalidate(prompt, context) {
    this.guardShutdown();
    const key = this._hashKey(prompt, context);
    return this._cache.delete(key);
  }

  /**
   * 清空全部缓存并停止后台清理定时器。
   * 调用后缓存实例不再可用，如需继续使用应创建新实例。
   *
   * @returns {void}
   */
  clear() {
    this.guardShutdown();
    this._cache.clear();
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }

  /**
   * 关联TokenManager实例，启用缓存-成本闭环。
   * 缓存命中时将节省的Token通过TokenManager记录到成本控制系统。
   *
   * @param {TokenManager} tokenManager - TokenManager实例
   * @returns {void}
   */
  attachTokenManager(tokenManager) {
    this._tokenManager = tokenManager;
  }

  /**
   * 缓存命中时向TokenManager报告节省的Token数量。
   * 仅在已关联TokenManager时生效。
   *
   * @private
   * @param {number} tokensSaved - 本次命中节省的Token数量
   * @returns {void}
   */
  _reportSavings(tokensSaved) {
    if (this._tokenManager && typeof this._tokenManager.store === 'function') {
      try {
        this._tokenManager.store('__inference_cache_savings', tokensSaved);
      } catch (_e) {
        debug('InferenceCache', 'reportSavings', _e && _e.message ? _e.message : String(_e));
      }
    }
  }

  /**
   * 获取缓存运行统计数据。
   * 返回包含缓存大小、命中率、淘汰次数、Token节省总量和分层统计的快照。
   *
   * @returns {CacheStats} 缓存运行统计数据快照
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('InferenceCache', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { size: 0, maxSize: this._maxSize, hits: 0, misses: 0, hitRate: 0, evictions: 0, tokensSaved: 0, tokensSavedTotal: 0, costSavedEstimate: 0, hitRateByTier: { hot: 0, warm: 0, cold: 0 }, keyNormalizationHits: 0 }; }
    const total = this._stats.hits + this._stats.misses;
    const hitRateByTier = {
      hot: this._tierHits.hot + this._tierMisses.hot > 0
        ? Math.round(this._tierHits.hot / (this._tierHits.hot + this._tierMisses.hot) * 100) / 100 : 0,
      warm: this._tierHits.warm + this._tierMisses.warm > 0
        ? Math.round(this._tierHits.warm / (this._tierHits.warm + this._tierMisses.warm) * 100) / 100 : 0,
      cold: this._tierHits.cold + this._tierMisses.cold > 0
        ? Math.round(this._tierHits.cold / (this._tierHits.cold + this._tierMisses.cold) * 100) / 100 : 0,
    };
    return {
      size: this._cache.size,
      maxSize: this._maxSize,
      hits: this._stats.hits,
      misses: this._stats.misses,
      hitRate: total > 0 ? Math.round(this._stats.hits / total * 100) / 100 : 0,
      evictions: this._stats.evictions,
      tokensSaved: this._computeTokensSaved(),
      tokensSavedTotal: this._tokensSavedTotal,
      costSavedEstimate: Math.round(this._tokensSavedTotal * COST_PER_1K_TOKENS / 1000 * 10000) / 10000,
      hitRateByTier,
      keyNormalizationHits: this._keyNormalizationHits,
    };
  }

  /**
   * 计算缓存累计节省的Token总量。
   * 对每个缓存条目，将tokenEstimate乘以该条目的命中次数后求和。
   *
   * @private
   * @returns {number} 累计节省的Token估算总量
   */
  _computeTokensSaved() {
    let saved = 0;
    for (const entry of this._cache.values()) {
      saved += entry.tokenEstimate * Math.max(0, entry.hitCount);
    }
    return saved;
  }

  _onShutdown() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this._cache.clear();
    this._stats = { hits: 0, misses: 0, evictions: 0 };
  }
}

module.exports = { InferenceCache: withShutdown(InferenceCache) };
