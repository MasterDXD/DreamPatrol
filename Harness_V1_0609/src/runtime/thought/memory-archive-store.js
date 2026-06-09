'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { safeCall, emitError } = require('../../utils/safe-execute');
const { safeStringify } = require('../../utils/safe-parse');
const { mergeConfig } = require('../../utils/safe-assign');
const { generateId } = require('../../utils/constants');
const BoundedMap = require('../../utils/bounded-map');

/**
 * 记忆层级枚举，定义三层记忆架构
 * @enum {string}
 * @readonly
 */
const MEMORY_TIERS = {
  WORKING: 'working',
  LONG_TERM: 'long_term',
  ARCHIVE: 'archive',
};

/**
 * 晋升规则定义：描述各层级间的晋升条件
 * @constant {Object}
 * @readonly
 */
const PROMOTION_RULES = {
  /** 工作记忆→长期记忆：访问次数>=阈值 或 存活过半且至少访问1次 */
  WORKING_TO_LONG_TERM: 'working_to_long_term',
  /** 长期记忆→归档：存活过半且7天无访问 */
  LONG_TERM_TO_ARCHIVE: 'long_term_to_archive',
};

/**
 * 默认配置
 * @constant {Object}
 * @readonly
 */
const DEFAULT_CONFIG = {
  workingTTL: 30 * 60 * 1000,             // 30分钟
  longTermTTL: 30 * 24 * 60 * 60 * 1000,  // 30天
  workingCapacity: 500,
  longTermCapacity: 5000,
  archiveCapacity: 50000,
  promotionThreshold: 3,                   // 访问3次后晋升
  autoPromotionInterval: 5 * 60 * 1000,   // 5分钟检查一次
  enableAutoPromotion: true,
  enableAutoArchive: true,
};

/**
 * 层级晋升顺序映射
 * @private
 */
const TIER_PROMOTION_ORDER = {
  [MEMORY_TIERS.WORKING]: MEMORY_TIERS.LONG_TERM,
  [MEMORY_TIERS.LONG_TERM]: MEMORY_TIERS.ARCHIVE,
  [MEMORY_TIERS.ARCHIVE]: null,
};

/**
 * @module runtime/thought/memory-archive-store
 * @classdesc 记忆归档存储
 * MemoryArchiveStore — 三层记忆自动晋升存储
 * 融合OpenHuman三层记忆树架构，实现工作记忆→长期记忆→归档的自动晋升机制。
 * 桥接Harness现有BrainMemory（工作层）+ MemoryStore（长期层）与OpenHuman三层记忆树。
 *
 * 三层架构：
 * - 工作记忆（Working）：当前会话活跃数据，TTL短，容量小
 * - 长期记忆（Long-term）：跨会话持久数据，TTL长，容量中
 * - 归档记忆（Archive）：历史数据压缩存储，永久保留，容量大
 *
 * 晋升规则：
 * - working → long_term：访问次数 >= promotionThreshold 或 存活时间 > workingTTL/2 且访问次数 >= 1
 * - long_term → archive：存活时间 > longTermTTL/2 且最近7天无访问
 *
 * @extends EventEmitter
 * @emits MemoryArchiveStore#memory-stored
 * @emits MemoryArchiveStore#memory-promoted
 * @emits MemoryArchiveStore#memory-archived
 * @emits MemoryArchiveStore#auto-promotion-completed
 * @example
 * const MemoryArchiveStore = require('./memory-archive-store');
 * const store = new MemoryArchiveStore({ promotionThreshold: 5 });
 * store.startAutoPromotion();
 *
 * const entry = store.store('user-pref', { theme: 'dark' });
 * store.retrieve('user-pref'); // 访问计数+1
 * store.promote(entry.id);     // 手动晋升到下一层
 * store.archive('user-pref');  // 手动归档
 */
class MemoryArchiveStore extends EventEmitter {
  /**
   * 创建三层记忆自动晋升存储实例
   * @param {Object} [options={}] - 配置选项
   * @param {number} [options.workingTTL=1800000] - 工作记忆TTL（毫秒）
   * @param {number} [options.longTermTTL=2592000000] - 长期记忆TTL（毫秒）
   * @param {number} [options.workingCapacity=500] - 工作记忆容量上限
   * @param {number} [options.longTermCapacity=5000] - 长期记忆容量上限
   * @param {number} [options.archiveCapacity=50000] - 归档记忆容量上限
   * @param {number} [options.promotionThreshold=3] - 自动晋升访问次数阈值
   * @param {number} [options.autoPromotionInterval=300000] - 自动晋升检查间隔（毫秒）
   * @param {boolean} [options.enableAutoPromotion=true] - 是否启用自动晋升
   * @param {boolean} [options.enableAutoArchive=true] - 是否启用自动归档
   */
  constructor(options = {}) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._tiers = {
      [MEMORY_TIERS.WORKING]: new BoundedMap(this._config.workingCapacity),
      [MEMORY_TIERS.LONG_TERM]: new BoundedMap(this._config.longTermCapacity),
      [MEMORY_TIERS.ARCHIVE]: new BoundedMap(this._config.archiveCapacity),
    };
    this._promotionTimer = null;
    this._stats = {
      stored: 0,
      promoted: 0,
      archived: 0,
      retrieved: 0,
      autoPromotions: 0,
    };
    this._attached = {
      memoryStore: false,
      brainMemory: false,
    };
    this._ms = null;
    this._bm = null;
  }

  /**
   * 附加MemoryStore实例，用于长期记忆持久化桥接
   * @param {Object} store - MemoryStore实例，需提供addKnowledge方法
   * @returns {boolean} 附加成功返回true，验证失败返回false
   * @throws {TypeError} store为null/undefined时抛出
   */
  attachMemoryStore(store) {
    this.guardShutdown();
    if (!store || typeof store !== 'object') {
      throw new TypeError('attachMemoryStore: store must be a non-null object');
    }
    if (typeof store.addKnowledge !== 'function') {
      debug('MemoryArchiveStore', 'attachMemoryStore', 'store missing addKnowledge method');
      return false;
    }
    this._ms = store;
    this._attached.memoryStore = true;
    return true;
  }

  /**
   * 附加BrainMemory实例，用于工作记忆层桥接
   * @param {Object} brainMemory - BrainMemory实例，需提供store方法
   * @returns {boolean} 附加成功返回true，验证失败返回false
   * @throws {TypeError} brainMemory为null/undefined时抛出
   */
  attachBrainMemory(brainMemory) {
    this.guardShutdown();
    if (!brainMemory || typeof brainMemory !== 'object') {
      throw new TypeError('attachBrainMemory: brainMemory must be a non-null object');
    }
    if (typeof brainMemory.store !== 'function') {
      debug('MemoryArchiveStore', 'attachBrainMemory', 'brainMemory missing store method');
      return false;
    }
    this._bm = brainMemory;
    this._attached.brainMemory = true;
    return true;
  }

  /**
   * 存储一条记忆条目到指定层级
   * @param {string} key - 记忆唯一键
   * @param {*} value - 记忆值
   * @param {Object} [options={}] - 存储选项
   * @param {string} [options.tier='working'] - 目标层级
   * @param {Object} [options.metadata={}] - 元数据
   * @returns {Object|null} 成功返回条目对象，层级无效返回null
   * @fires MemoryArchiveStore#memory-stored
   * @example
   * const entry = store.store('config', { port: 3210 }, { tier: 'working' });
   * // entry = { id, key, value, tier, accessCount, createdAt, ... }
   */
  store(key, value, options = {}) {
    this.guardShutdown();
    if (!key || typeof key !== 'string') {
      debug('MemoryArchiveStore', 'store', 'invalid key');
      return null;
    }
    // 确定目标层级，默认为工作记忆
    const tier = options.tier || MEMORY_TIERS.WORKING;
    if (!Object.values(MEMORY_TIERS).includes(tier)) {
      debug('MemoryArchiveStore', 'store', 'invalid tier: ' + tier);
      return null;
    }

    const entry = {
      id: generateId('mar-'),
      key,
      value,
      tier,
      accessCount: 0,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      promotedFrom: null,
      metadata: options.metadata ?? {},
    };

    this._tiers[tier].set(key, entry);
    this._stats.stored++;

    // 桥接到外部记忆系统
    if (tier === MEMORY_TIERS.WORKING && this._attached.brainMemory && this._bm) {
      safeCall(() => this._bm.store(key, safeStringify(value)), 'MemoryArchiveStore', 'bridge-brainMemory');
    }
    if (tier === MEMORY_TIERS.LONG_TERM && this._attached.memoryStore && this._ms) {
      safeCall(() => this._ms.addKnowledge({
        category: 'archive-store',
        content: safeStringify(value),
        source: 'memory-archive-store',
      }), 'MemoryArchiveStore', 'bridge-memoryStore');
    }

    this.emit('memory-stored', { entryId: entry.id, key, tier });
    return entry;
  }

  /**
   * 根据键检索记忆条目，按优先级搜索：working → long_term → archive
   * 找到后自动递增访问计数并更新最后访问时间
   * @param {string} key - 记忆键
   * @returns {Object|null} 找到返回条目对象，未找到返回null
   * @example
   * const entry = store.retrieve('config');
   * // entry.accessCount 已递增
   */
  retrieve(key) {
    this.guardShutdown();
    if (!key || typeof key !== 'string') return null;

    // 按优先级搜索各层级
    const searchOrder = [MEMORY_TIERS.WORKING, MEMORY_TIERS.LONG_TERM, MEMORY_TIERS.ARCHIVE];
    for (const tier of searchOrder) {
      const entry = this._tiers[tier].get(key);
      if (entry) {
        entry.accessCount++;
        entry.lastAccessedAt = Date.now();
        this._stats.retrieved++;
        return entry;
      }
    }
    return null;
  }

  /**
   * 手动晋升条目到下一层级
   * 晋升顺序：working → long_term → archive，archive无法继续晋升
   * @param {string} entryId - 条目ID
   * @returns {Object|null} 晋升成功返回更新后的条目，无下一层级或未找到返回null
   * @fires MemoryArchiveStore#memory-promoted
   * @example
   * const entry = store.promote('mar-abc123');
   * // entry.tier 从 'working' 变为 'long_term'
   */
  promote(entryId) {
    this.guardShutdown();
    if (!entryId || typeof entryId !== 'string') return null;

    // 在所有层级中查找条目
    const found = this._findEntryById(entryId);
    if (!found) return null;

    const { entry, tier: currentTier } = found;
    const nextTier = TIER_PROMOTION_ORDER[currentTier];
    if (!nextTier) return null; // archive层无法继续晋升

    // 从当前层级移除，添加到下一层级
    this._tiers[currentTier].delete(entry.key);
    entry.tier = nextTier;
    entry.promotedFrom = currentTier;
    this._tiers[nextTier].set(entry.key, entry);

    this._stats.promoted++;
    this.emit('memory-promoted', { entryId, fromTier: currentTier, toTier: nextTier });
    return entry;
  }

  /**
   * 手动归档一条记忆条目，从working或long_term层移至archive层
   * @param {string} key - 记忆键
   * @returns {Object|null} 归档成功返回更新后的条目，未找到返回null
   * @fires MemoryArchiveStore#memory-archived
   * @example
   * const entry = store.archive('old-config');
   * // entry.tier 变为 'archive'
   */
  archive(key) {
    this.guardShutdown();
    if (!key || typeof key !== 'string') return null;

    // 在working和long_term层中查找
    const searchTiers = [MEMORY_TIERS.WORKING, MEMORY_TIERS.LONG_TERM];
    for (const tier of searchTiers) {
      const entry = this._tiers[tier].get(key);
      if (entry) {
        this._tiers[tier].delete(key);
        entry.tier = MEMORY_TIERS.ARCHIVE;
        entry.promotedFrom = tier;
        this._tiers[MEMORY_TIERS.ARCHIVE].set(key, entry);

        this._stats.archived++;
        this.emit('memory-archived', { entryId: entry.id, key });
        return entry;
      }
    }
    return null;
  }

  /**
   * 自动晋升检查，由定时器周期性调用
   * 检查working层中满足晋升条件的条目并自动晋升
   * 检查long_term层中满足归档条件的条目并自动归档
   * @private
   * @fires MemoryArchiveStore#auto-promotion-completed
   */
  _checkPromotions() {
    if (!this._config.enableAutoPromotion) return;

    try {
      const now = Date.now();
      let promotedCount = 0;
      let archivedCount = 0;

      // 检查working层中满足晋升条件的条目
      const workingEntries = [];
      this._tiers[MEMORY_TIERS.WORKING].forEach((entry) => {
        workingEntries.push(entry);
      });

      for (const entry of workingEntries) {
        const age = now - entry.createdAt;
        const halfTTL = this._config.workingTTL / 2;
        // 晋升条件：访问次数>=阈值 或 存活过半且至少访问1次
        if (entry.accessCount >= this._config.promotionThreshold ||
            (age > halfTTL && entry.accessCount >= 1)) {
          const result = this.promote(entry.id);
          if (result) promotedCount++;
        }
      }

      // 检查long_term层中满足归档条件的条目
      if (this._config.enableAutoArchive) {
        const longTermEntries = [];
        this._tiers[MEMORY_TIERS.LONG_TERM].forEach((entry) => {
          longTermEntries.push(entry);
        });

        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        for (const entry of longTermEntries) {
          const age = now - entry.createdAt;
          const halfTTL = this._config.longTermTTL / 2;
          const daysSinceAccess = now - entry.lastAccessedAt;
          // 归档条件：存活过半且7天无访问
          if (age > halfTTL && daysSinceAccess > sevenDays) {
            const result = this.archive(entry.key);
            if (result) archivedCount++;
          }
        }
      }

      const totalAuto = promotedCount + archivedCount;
      if (totalAuto > 0) {
        this._stats.autoPromotions += totalAuto;
        this.emit('auto-promotion-completed', { promoted: promotedCount, archived: archivedCount });
      }
    } catch (err) {
      emitError(this, 'promotion-error', err, { phase: 'auto-promotion-check' });
    }
  }

  /**
   * 启动自动晋升定时器
   * 定时器在后台运行，不阻止进程退出（调用unref）
   */
  startAutoPromotion() {
    this.guardShutdown();
    if (this._promotionTimer) return; // 已启动则跳过

    this._promotionTimer = setInterval(() => {
      if (this._shutDown) return;
      safeCall(() => this._checkPromotions(), 'MemoryArchiveStore', 'auto-promotion-check');
    }, this._config.autoPromotionInterval);

    // 不阻止进程退出
    if (typeof this._promotionTimer.unref === 'function') {
      this._promotionTimer.unref();
    }
  }

  /**
   * 停止自动晋升定时器
   */
  stopAutoPromotion() {
    if (this._promotionTimer) {
      clearInterval(this._promotionTimer);
      this._promotionTimer = null;
    }
  }

  /**
   * 获取指定层级的所有条目
   * @param {string} tier - 层级名称（working/long_term/archive）
   * @returns {Array<Object>} 该层级的所有条目数组
   * @example
   * const workingEntries = store.getByTier('working');
   */
  getByTier(tier) {
    this.guardShutdown();
    if (!Object.values(MEMORY_TIERS).includes(tier)) return [];

    const entries = [];
    this._tiers[tier].forEach((entry) => {
      entries.push({ ...entry, metadata: { ...entry.metadata } });
    });
    return entries;
  }

  /**
   * 获取指定层级的统计信息
   * @param {string} tier - 层级名称
   * @returns {Object|null} 层级统计对象，层级无效返回null
   * @example
   * const stats = store.getTierStats('working');
   * // { count: 42, avgAccessCount: 2.5, oldestEntry: 1700000000000, newestEntry: 1700001000000 }
   */
  getTierStats(tier) {
    this.guardShutdown();
    if (!Object.values(MEMORY_TIERS).includes(tier)) return null;

    const entries = this.getByTier(tier);
    if (entries.length === 0) {
      return { count: 0, avgAccessCount: 0, oldestEntry: null, newestEntry: null };
    }

    let totalAccess = 0;
    let oldest = Infinity;
    let newest = -Infinity;

    for (const entry of entries) {
      totalAccess += entry.accessCount;
      if (entry.createdAt < oldest) oldest = entry.createdAt;
      if (entry.createdAt > newest) newest = entry.createdAt;
    }

    return {
      count: entries.length,
      avgAccessCount: entries.length > 0 ? totalAccess / entries.length : 0,
      oldestEntry: oldest === Infinity ? null : oldest,
      newestEntry: newest === -Infinity ? null : newest,
    };
  }

  /**
   * 跨层级搜索记忆条目，支持按key部分匹配
   * @param {string} query - 搜索关键词（对key进行部分匹配）
   * @param {Object} [options={}] - 搜索选项
   * @param {string} [options.tier] - 限定搜索层级
   * @param {number} [options.limit=100] - 返回结果数量上限
   * @returns {Array<Object>} 匹配的条目数组
   * @example
   * const results = store.search('config', { tier: 'working', limit: 10 });
   */
  search(query, options = {}) {
    this.guardShutdown();
    if (!query || typeof query !== 'string') return [];

    const limit = options.limit ?? 100;
    const lowerQuery = query.toLowerCase();
    const results = [];

    // 确定搜索的层级范围
    const tiersToSearch = options.tier
      ? [options.tier]
      : [MEMORY_TIERS.WORKING, MEMORY_TIERS.LONG_TERM, MEMORY_TIERS.ARCHIVE];

    for (const tier of tiersToSearch) {
      if (!Object.values(MEMORY_TIERS).includes(tier)) continue;
      this._tiers[tier].forEach((entry) => {
        if (results.length >= limit) return;
        // 对key进行部分匹配
        if (entry.key && entry.key.toLowerCase().includes(lowerQuery)) {
          results.push(entry);
        }
      });
      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * 获取全局统计信息，包含操作计数和各层级条目数
   * @returns {Object} 统计对象
   * @example
   * const stats = store.getStats();
   * // { stored: 100, promoted: 20, archived: 5, retrieved: 500,
   * //   autoPromotions: 15, tierCounts: { working: 50, long_term: 30, archive: 5 } }
   */
  getStats() {
    const tierCounts = {};
    for (const tier of Object.values(MEMORY_TIERS)) {
      tierCounts[tier] = this._tiers[tier].size;
    }
    return {
      stored: this._stats.stored,
      promoted: this._stats.promoted,
      archived: this._stats.archived,
      retrieved: this._stats.retrieved,
      autoPromotions: this._stats.autoPromotions,
      tierCounts,
    };
  }

  /**
   * 在所有层级中根据条目ID查找条目及其所在层级
   * @param {string} entryId - 条目ID
   * @returns {Object|null} 找到返回 { entry, tier }，未找到返回null
   * @private
   */
  _findEntryById(entryId) {
    for (const tier of Object.values(MEMORY_TIERS)) {
      let found = null;
      this._tiers[tier].forEach((entry) => {
        if (entry.id === entryId) {
          found = { entry, tier };
        }
      });
      if (found) return found;
    }
    return null;
  }

  /**
   * 关闭存储，停止自动晋升定时器，清空所有层级
   * @private
   */
  _onShutdown() {
    this.stopAutoPromotion();
    for (const tier of Object.values(MEMORY_TIERS)) {
      safeCall(() => this._tiers[tier].shutdown(), 'MemoryArchiveStore', 'shutdown-tier-' + tier);
    }
    this._ms = null;
    this._bm = null;
    this._attached.memoryStore = false;
    this._attached.brainMemory = false;
    this.removeAllListeners();
  }
}

// 静态属性：层级枚举
MemoryArchiveStore.MEMORY_TIERS = MEMORY_TIERS;

// 静态属性：晋升规则
MemoryArchiveStore.PROMOTION_RULES = PROMOTION_RULES;

// 静态属性：默认配置
MemoryArchiveStore.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(MemoryArchiveStore);
