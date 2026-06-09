'use strict';

const { mergeConfig, validateConfigSchema } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

const MEMORY_TIERS = {
  IMMEDIATE: 'immediate',
  SHORT_TERM: 'short-term',
  LONG_TERM: 'long-term',
};

const TIER_CONFIG = {
  immediate: {
    maxTokens: 50000,
    maxEntries: 20,
    retentionMs: 300000,
    priority: 1,
  },
  'short-term': {
    maxTokens: 200000,
    maxEntries: 100,
    retentionMs: 3600000,
    priority: 2,
  },
  'long-term': {
    maxTokens: 1250000,
    maxEntries: 500,
    retentionMs: Infinity,
    priority: 3,
  },
};

const DEFAULT_OPTIONS = {
  totalBudgetTokens: 1500000,
  immediateRatio: 0.033,
  shortTermRatio: 0.133,
  longTermRatio: 0.834,
  promotionThreshold: 3,
  demotionThreshold: 0.1,
  accessDecayMs: 1800000,
  maxHistorySize: 500,
};

const OPTIONS_SCHEMA = {
  totalBudgetTokens: { type: 'number', min: 1 },
  immediateRatio: { type: 'number', min: 0, max: 1 },
  shortTermRatio: { type: 'number', min: 0, max: 1 },
  longTermRatio: { type: 'number', min: 0, max: 1 },
  promotionThreshold: { type: 'number', min: 1 },
  demotionThreshold: { type: 'number', min: 0, max: 1 },
  accessDecayMs: { type: 'number', min: 0 },
  maxHistorySize: { type: 'number', min: 1, max: 10000 },
};

class ThreeTierMemoryManager {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    const validation = validateConfigSchema(this._options, OPTIONS_SCHEMA, 'ThreeTierMemoryManager');
    this._options = validation.config;
    this._tiers = {
      immediate: new BoundedMap(TIER_CONFIG.immediate.maxEntries),
      'short-term': new BoundedMap(TIER_CONFIG['short-term'].maxEntries),
      'long-term': new BoundedMap(TIER_CONFIG['long-term'].maxEntries),
    };
    this._tokenUsage = {
      immediate: 0,
      'short-term': 0,
      'long-term': 0,
    };
    this._accessCounts = new BoundedMap(1000);
    this._history = new BoundedArray(this._options.maxHistorySize);
    this._stats = {
      stores: 0,
      retrievals: 0,
      promotions: 0,
      demotions: 0,
      evictions: 0,
      byTier: { immediate: 0, 'short-term': 0, 'long-term': 0 },
    };
  }

  store(key, value, options) {
    this.guardShutdown();
    const opts = options ?? {};
    const tokenEstimate = opts.tokenEstimate ?? this._estimateTokens(value);
    const tier = opts.tier ?? this._determineTier(tokenEstimate, opts);
    const entry = {
      key,
      value,
      tier,
      tokenEstimate,
      accessCount: 0,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      importance: opts.importance ?? 0.5,
    };
    const tierConfig = TIER_CONFIG[tier] ?? TIER_CONFIG.immediate;
    if (this._tokenUsage[tier] + tokenEstimate > tierConfig.maxTokens) {
      this._evict(tier, tokenEstimate);
    }
    this._tiers[tier].set(key, entry);
    this._tokenUsage[tier] += tokenEstimate;
    this._stats.stores++;
    this._stats.byTier[tier] = (this._stats.byTier[tier] ?? 0) + 1;
    return { tier, tokenEstimate };
  }

  retrieve(key) {
    this.guardShutdown();
    this._stats.retrievals++;
    for (const tierName of Object.keys(this._tiers)) {
      const entry = this._tiers[tierName].get(key);
      if (entry) {
        entry.accessCount++;
        entry.lastAccessedAt = Date.now();
        this._accessCounts.set(key, (this._accessCounts.get(key) ?? 0) + 1);
        this._checkPromotion(key, tierName, entry);
        return entry.value;
      }
    }
    return undefined;
  }

  _determineTier(tokenEstimate, options) {
    const importance = options.importance ?? 0.5;
    if (importance >= 0.8 || tokenEstimate <= TIER_CONFIG.immediate.maxTokens * 0.5) {
      return MEMORY_TIERS.IMMEDIATE;
    }
    if (importance >= 0.4 || tokenEstimate <= TIER_CONFIG['short-term'].maxTokens * 0.5) {
      return MEMORY_TIERS.SHORT_TERM;
    }
    return MEMORY_TIERS.LONG_TERM;
  }

  _checkPromotion(key, currentTier, entry) {
    const accessCount = this._accessCounts.get(key) ?? 0;
    const tierOrder = [MEMORY_TIERS.LONG_TERM, MEMORY_TIERS.SHORT_TERM, MEMORY_TIERS.IMMEDIATE];
    const currentIndex = tierOrder.indexOf(currentTier);
    if (currentIndex > 0 && accessCount >= this._options.promotionThreshold) {
      const targetTier = tierOrder[currentIndex - 1];
      this._promote(key, currentTier, targetTier, entry);
    }
  }

  _promote(key, fromTier, toTier, entry) {
    this._tiers[fromTier].delete(key);
    this._tokenUsage[fromTier] -= entry.tokenEstimate;
    entry.tier = toTier;
    const tierConfig = TIER_CONFIG[toTier];
    if (this._tokenUsage[toTier] + entry.tokenEstimate > tierConfig.maxTokens) {
      this._evict(toTier, entry.tokenEstimate);
    }
    this._tiers[toTier].set(key, entry);
    this._tokenUsage[toTier] += entry.tokenEstimate;
    this._stats.promotions++;
    this._history.push({ key, from: fromTier, to: toTier, action: 'promote', timestamp: Date.now() });
  }

  _evict(tier, neededTokens) {
    const entries = [];
    for (const [key, entry] of this._tiers[tier]) {
      entries.push({ key, entry });
    }
    const now = Date.now();
    entries.sort((a, b) => {
      const scoreA = a.entry.importance * 0.5 + (a.entry.accessCount / Math.max(1, now - a.entry.createdAt)) * 0.5;
      const scoreB = b.entry.importance * 0.5 + (b.entry.accessCount / Math.max(1, now - b.entry.createdAt)) * 0.5;
      return scoreA - scoreB;
    });
    let freed = 0;
    for (const { key, entry } of entries) {
      if (freed >= neededTokens) break;
      const tierOrder = [MEMORY_TIERS.IMMEDIATE, MEMORY_TIERS.SHORT_TERM, MEMORY_TIERS.LONG_TERM];
      const currentIndex = tierOrder.indexOf(tier);
      if (currentIndex < tierOrder.length - 1) {
        this._demote(key, tier, tierOrder[currentIndex + 1], entry);
      } else {
        this._tiers[tier].delete(key);
        this._tokenUsage[tier] -= entry.tokenEstimate;
      }
      freed += entry.tokenEstimate;
      this._stats.evictions++;
    }
  }

  _demote(key, fromTier, toTier, entry) {
    this._tiers[fromTier].delete(key);
    this._tokenUsage[fromTier] -= entry.tokenEstimate;
    entry.tier = toTier;
    this._tiers[toTier].set(key, entry);
    this._tokenUsage[toTier] += entry.tokenEstimate;
    this._stats.demotions++;
    this._history.push({ key, from: fromTier, to: toTier, action: 'demote', timestamp: Date.now() });
  }

  _estimateTokens(value) {
    if (typeof value === 'string') return Math.ceil(value.length / 4);
    try {
      const serialized = JSON.stringify(value);
      return Math.ceil((serialized ?? '').length / 4);
    } catch (_e) {
      debug('ThreeTierMemoryManager', 'estimateTokens', _e && _e.message ? _e.message : String(_e));
      return 0;
    }
  }

  getMemoryStats() {
    this.guardShutdown();
    return {
      tokenUsage: Object.assign({}, this._tokenUsage),
      totalTokens: Object.values(this._tokenUsage).reduce((a, b) => a + b, 0),
      budget: this._options.totalBudgetTokens,
      utilization: this._options.totalBudgetTokens > 0 ? Object.values(this._tokenUsage).reduce((a, b) => a + b, 0) / this._options.totalBudgetTokens : 0,
      tierSizes: {
        immediate: this._tiers.immediate.size,
        'short-term': this._tiers['short-term'].size,
        'long-term': this._tiers['long-term'].size,
      },
    };
  }

  getStats() {
    this.guardShutdown();
    return {
      stores: this._stats.stores,
      retrievals: this._stats.retrievals,
      promotions: this._stats.promotions,
      demotions: this._stats.demotions,
      evictions: this._stats.evictions,
      byTier: Object.assign({}, this._stats.byTier),
    };
  }

  _onShutdown() {
    for (const tier of Object.values(this._tiers)) {
      tier.shutdown();
    }
    this._accessCounts.shutdown();
    this._history.shutdown();
  }
}

module.exports = withShutdown(ThreeTierMemoryManager);
module.exports.MEMORY_TIERS = MEMORY_TIERS;
module.exports.TIER_CONFIG = TIER_CONFIG;
