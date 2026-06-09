'use strict';

const { EventEmitter } = require('events');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedMap = require('../../utils/bounded-map');

const DEFAULT_CONFIG = {
  maxCacheEntries: 200,
  cacheTtlMs: 3600000,
  minPrefixTokens: 500,
  enableCacheBreakpoints: true,
  trackSavings: true,
};

/**
 * @module runtime/prompt/prompt-cache-manager
 * @classdesc 提示词缓存管理器（PromptCacheManager）。Anthropic cache_control标记，
 * 命中率统计，Token节省追踪。
 *
 * @fires PromptCacheManager#cache-hit
 * @fires PromptCacheManager#cache-miss
 * @fires PromptCacheManager#cache-invalidated
 */
class PromptCacheManager extends EventEmitter {
  /**
   * @param {Object} [options] - Configuration options
   * @param {number} [options.maxCacheEntries=200] - Maximum number of cache entries
   * @param {number} [options.cacheTtlMs=3600000] - Cache entry TTL in milliseconds
   * @param {number} [options.minPrefixTokens=500] - Minimum tokens required for caching
   * @param {boolean} [options.enableCacheBreakpoints=true] - Whether to insert cache breakpoints
   * @param {boolean} [options.trackSavings=true] - Whether to track token/cost savings
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    this._entries = new BoundedMap(this._config.maxCacheEntries, {
      onEvict: function(key, _value) {
        this.emit('cache-invalidated', { prefixHash: key, reason: 'evicted' });
      }.bind(this),
    });
    this._stats = {
      hits: 0,
      misses: 0,
      tokensSaved: 0,
      costSaved: 0,
    };
  }

  /**
   * Marks a text segment as cacheable and returns a cache breakpoint marker.
   * @param {string} text - The text content to mark as cacheable
   * @param {Object} [metadata] - Additional metadata for the cache entry
   * @param {string} [metadata.prefixHash] - Hash of the prefix for cache lookup
   * @param {number} [metadata.tokenCount] - Estimated token count of the text
   * @returns {{ text: string, cacheControl: { type: string } }} Object with text and cache_control marker
   */
  markCacheable(text, metadata) {
    this.guardShutdown();
    const meta = metadata ?? {};
    const prefixHash = meta.prefixHash || '';
    const tokenCount = meta.tokenCount ?? Math.ceil((text || '').length / 4);
    if (prefixHash && this._config.enableCacheBreakpoints) {
      const existing = this._entries.get(prefixHash);
      if (existing) {
        existing.lastAccessedAt = Date.now();
        existing.accessCount = (existing.accessCount ?? 0) + 1;
      } else {
        this._entries.set(prefixHash, {
          tokenCount: tokenCount,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          accessCount: 1,
        });
      }
    }
    return {
      text: text,
      cache_control: { type: 'ephemeral' },
    };
  }

  /**
   * Marks a text segment as non-cacheable.
   * @param {string} text - The text content to mark as non-cacheable
   * @param {Object} [metadata] - Additional metadata
   * @returns {{ text: string }} Object with text (no cache_control)
   */
  markNonCacheable(text, _metadata) {
    this.guardShutdown();
    return { text: text };
  }

  /**
   * Assembles prompt with cache_control markers for Anthropic API.
   * @param {string} staticPrefix - The static prefix content
   * @param {string} dynamicSuffix - The dynamic suffix content
   * @returns {{ role: string, content: Array<{ type: string, text: string, cache_control?: { type: string } }> }} Formatted message for Anthropic API
   */
  buildCacheAwarePrompt(staticPrefix, dynamicSuffix) {
    this.guardShutdown();
    const content = [];
    if (staticPrefix && this._config.enableCacheBreakpoints) {
      const cacheable = this.markCacheable(staticPrefix, {
        tokenCount: Math.ceil(staticPrefix.length / 4),
      });
      content.push({
        type: 'text',
        text: cacheable.text,
        cache_control: cacheable.cache_control,
      });
    } else if (staticPrefix) {
      content.push({
        type: 'text',
        text: staticPrefix,
      });
    }
    if (dynamicSuffix) {
      const nonCacheable = this.markNonCacheable(dynamicSuffix);
      content.push({
        type: 'text',
        text: nonCacheable.text,
      });
    }
    return {
      role: 'system',
      content: content,
    };
  }

  /**
   * Records a cache hit and updates savings stats.
   * @param {string} prefixHash - Hash of the cached prefix
   * @param {number} tokensSaved - Number of tokens saved by the cache hit
   */
  recordCacheHit(prefixHash, tokensSaved) {
    this.guardShutdown();
    this._stats.hits++;
    this._stats.tokensSaved += (typeof tokensSaved === 'number' && Number.isFinite(tokensSaved) ? tokensSaved : 0);
    this._stats.costSaved = this._stats.tokensSaved * 0.000003;
    const entry = this._entries.get(prefixHash);
    if (entry) {
      entry.lastAccessedAt = Date.now();
      entry.accessCount = (entry.accessCount ?? 0) + 1;
    }
    this.emit('cache-hit', { prefixHash: prefixHash, tokensSaved: tokensSaved });
  }

  /**
   * Records a cache miss.
   * @param {string} prefixHash - Hash of the prefix that was not cached
   */
  recordCacheMiss(prefixHash) {
    this.guardShutdown();
    this._stats.misses++;
    this.emit('cache-miss', { prefixHash: prefixHash });
  }

  /**
   * Returns cache hit rate, tokens saved, and cost savings statistics.
   * @returns {{ hits: number, misses: number, hitRate: number, tokensSaved: number, costSaved: number, entryCount: number }}
   */
  getCacheStats() {
    this.guardShutdown();
    const total = this._stats.hits + this._stats.misses;
    return {
      hits: this._stats.hits,
      misses: this._stats.misses,
      hitRate: total > 0 ? this._stats.hits / total : 0,
      tokensSaved: this._stats.tokensSaved,
      costSaved: this._stats.costSaved,
      entryCount: this._entries.size,
    };
  }

  /**
   * Checks if the prefix is worth caching (meets minimum token threshold).
   * @param {string} prefixHash - Hash of the prefix to check
   * @returns {boolean} Whether the prefix meets the minimum token threshold
   */
  shouldUseCache(prefixHash) {
    this.guardShutdown();
    const entry = this._entries.get(prefixHash);
    if (!entry) return false;
    return entry.tokenCount >= this._config.minPrefixTokens;
  }

  /**
   * Invalidates a specific cache entry.
   * @param {string} prefixHash - Hash of the cache entry to invalidate
   */
  invalidateCache(prefixHash) {
    this.guardShutdown();
    const deleted = this._entries.delete(prefixHash);
    if (deleted) {
      this.emit('cache-invalidated', { prefixHash: prefixHash, reason: 'manual' });
    }
  }

  /**
   * Clears all cache entries and resets statistics.
   */
  invalidateAll() {
    this.guardShutdown();
    this._entries.clear();
    this._stats = { hits: 0, misses: 0, tokensSaved: 0, costSaved: 0 };
    this.emit('cache-invalidated', { prefixHash: '*', reason: 'invalidate-all' });
  }

  _onShutdown() {
    this._entries.shutdown();
    this._stats = { hits: 0, misses: 0, tokensSaved: 0, costSaved: 0 };
    this.removeAllListeners();
  }
}

PromptCacheManager.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(PromptCacheManager);
