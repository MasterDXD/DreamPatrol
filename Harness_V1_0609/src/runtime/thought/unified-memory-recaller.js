'use strict';

/**
 * @module runtime/thought/unified-memory-recaller
 * @classdesc 统一记忆召回器。7源跨存储联合召回、并行/顺序双模式
 * UnifiedMemoryRecaller — Seven-source cross-store memory recall with parallel/sequential modes and deduplication
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');
const { safeCall, ensureArray } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const deepClone = require('../../utils/deep-clone');
const { mergeConfig } = safeAssign;

const RECALL_SOURCES = {
  BRAIN_MEMORY: 'brain-memory',
  MEMORY_STORE: 'memory-store',
  THOUGHT_STORE: 'thought-store',
  LLM_WIKI: 'llm-wiki',
  DREAM_ENGINE: 'dream-engine',
  CAUSAL_STORE: 'causal-store',
  PREFETCHER: 'prefetcher',
};

const DEFAULT_RECALL_CONFIG = {
  maxResults: 20,
  minConfidence: 0.3,
  deduplicationThreshold: 0.85,
  sourceTimeoutMs: 5000,
  enableParallelRecall: true,
  cacheMaxSize: 100,
  cacheTTL: 60000,
};

/**
 * UnifiedMemoryRecaller — 统一记忆召回器，Hermes Recall阶段实现。
 * 跨7种存储源（BrainMemory/MemoryStore/ThoughtStore/LLMWiki/DreamEngine/CausalStore/Prefetcher）并行联合召回。
 */
class UnifiedMemoryRecaller extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_RECALL_CONFIG, options ?? {});
    this._sources = new Map();
    this._queryCache = new BoundedMap(this._config.cacheMaxSize);
    this._stats = {
      totalQueries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      sourceStats: {},
      dedupedCount: 0,
    };
  }

  /**
   * @param {string} sourceName - 源名称
   * @param {Object} sourceInstance - 源实例
   * @param {Object} [options] - 选项(priority, recallFn)
   * @returns {UnifiedMemoryRecaller} this
   */
  attachSource(sourceName, sourceInstance, options) {
    if (!sourceName || typeof sourceName !== 'string') return this;
    if (!sourceInstance || typeof sourceInstance !== 'object') return this;
    const recallFn = (options && options.recallFn) || this._getDefaultRecallFn(sourceName);
    this._sources.set(sourceName, {
      instance: sourceInstance,
      recallFn,
      priority: (options && options.priority) ?? 1,
      enabled: true,
    });
    this._stats.sourceStats[sourceName] = { queries: 0, results: 0, errors: 0 };
    return this;
  }

  _getDefaultRecallFn(sourceName) {
    const fnMap = {
      [RECALL_SOURCES.BRAIN_MEMORY]: (inst, query, opts) => {
        if (typeof inst.retrieve === 'function') return inst.retrieve(query, opts);
        return [];
      },
      [RECALL_SOURCES.MEMORY_STORE]: (inst, query, _opts) => {
        if (typeof inst.queryKnowledge === 'function') return inst.queryKnowledge(query);
        return [];
      },
      [RECALL_SOURCES.THOUGHT_STORE]: (inst, query, opts) => {
        if (typeof inst.search === 'function') return inst.search(query, opts);
        return [];
      },
      [RECALL_SOURCES.LLM_WIKI]: (inst, query, _opts) => {
        if (typeof inst.search === 'function') return inst.search(query);
        return [];
      },
      [RECALL_SOURCES.DREAM_ENGINE]: (inst, query, opts) => {
        if (typeof inst.getRelevantNotes === 'function') return inst.getRelevantNotes(query, opts);
        return [];
      },
      [RECALL_SOURCES.CAUSAL_STORE]: (inst, query, opts) => {
        if (typeof inst.searchByCausalSimilarity === 'function') return inst.searchByCausalSimilarity(query, opts);
        return [];
      },
      [RECALL_SOURCES.PREFETCHER]: (inst, query, _opts) => {
        if (typeof inst.getPrefetched === 'function') {
          const result = inst.getPrefetched(query);
          return result ? [result] : [];
        }
        return [];
      },
    };
    return fnMap[sourceName] || (() => []);
  }

  /**
   * @param {string} sourceName - 源名称
   * @returns {UnifiedMemoryRecaller} this
   */
  enableSource(sourceName) {
    const source = this._sources.get(sourceName);
    if (source) source.enabled = true;
    return this;
  }

  /**
   * @param {string} sourceName - 源名称
   * @returns {UnifiedMemoryRecaller} this
   */
  disableSource(sourceName) {
    const source = this._sources.get(sourceName);
    if (source) source.enabled = false;
    return this;
  }

  /**
   * @param {string} query - 查询
   * @param {Object} [options] - 选项
   * @returns {Promise<Object>} 召回结果
   * @fires UnifiedMemoryRecaller#recall-completed
   * @throws {Error} When query string is empty or not a string
   */
  async recall(query, options) {
    if (this._shutDown) return { results: [], sources: {}, meta: { shutDown: true } };
    if (!query || typeof query !== 'string') return { results: [], sources: {}, meta: { invalidQuery: true } };

    this._stats.totalQueries++;
    const opts = safeAssign({ limit: this._config.maxResults, minConfidence: this._config.minConfidence }, options ?? {});

    const cacheKey = query + ':' + JSON.stringify(opts);
    const cached = this._queryCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this._config.cacheTTL) {
      this._stats.cacheHits++;
      return cached.data;
    }
    this._stats.cacheMisses++;

    let sourceResults;
    let allResults;
    try {
      ({ sourceResults, allResults } = await this._collectFromSources(query, opts));
    } catch (err) {
      debug('UnifiedMemoryRecaller', 'recall', err && err.message ? err.message : String(err));
      return { results: [], sources: {}, meta: { error: err && err.message ? err.message : String(err) } };
    }

    if (this._shutDown) return { results: [], sources: {}, meta: { shutDown: true } };

    const deduped = this._deduplicateResults(allResults);
    const ranked = this._rankResults(deduped, query);
    const final = ranked.slice(0, opts.limit);

    const output = {
      results: final,
      sources: sourceResults,
      meta: {
        totalRaw: allResults.length,
        afterDedup: deduped.length,
        returned: final.length,
        query,
      },
    };

    try {
      this._queryCache.set(cacheKey, { data: deepClone(output), ts: Date.now() });
    } catch (_e) {
      debug('UnifiedMemoryRecaller', 'cacheDeepCopy', _e && _e.message ? _e.message : String(_e));
      this._queryCache.set(cacheKey, { data: { results: [], sources: {}, meta: output && output.meta ? safeAssign({}, output.meta) : {} }, ts: Date.now() });
    }
    this.emit('recall-completed', { query, resultCount: final.length, sourceCount: Object.keys(sourceResults).length });
    return output;
  }

  async _collectFromSources(query, opts) {
    if (this._config.enableParallelRecall) {
      return this._collectParallel(query, opts);
    }
    return this._collectSequential(query, opts);
  }

  async _collectParallel(query, opts) {
    const sourceResults = {};
    const allResults = [];
    const promises = [];
    for (const [name, source] of this._sources) {
      if (!source.enabled) continue;
      promises.push(this._recallFromSource(name, source, query, opts));
    }
    const settled = await Promise.allSettled(promises);
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) {
        sourceResults[result.value.sourceName] = result.value;
        if (Array.isArray(result.value.items)) {
          allResults.push(...result.value.items);
        }
      }
    }
    return { sourceResults, allResults };
  }

  async _collectSequential(query, opts) {
    const sourceResults = {};
    const allResults = [];
    const sortedSources = [...this._sources.entries()].sort((a, b) => b[1].priority - a[1].priority);
    for (const [name, source] of sortedSources) {
      if (!source.enabled) continue;
      try {
        const result = await this._recallFromSource(name, source, query, opts);
        if (result) {
          sourceResults[name] = result;
          if (Array.isArray(result.items)) {
            allResults.push(...result.items);
          }
        }
      } catch (err) {
        debug('UnifiedMemoryRecaller', '_collectSequential', name, err && err.message ? err.message : String(err));
        sourceResults[name] = { sourceName: name, items: [], itemCount: 0, error: String(err) };
      }
    }
    return { sourceResults, allResults };
  }

  async _recallFromSource(sourceName, source, query, opts) {
    if (!source.recallFn || !source.instance) return null;
    const sourceStat = this._stats.sourceStats[sourceName];
    if (sourceStat) sourceStat.queries++;

    try {
      let timer;
      try {
        const sourceTimeoutMs = this._config ? this._config.sourceTimeoutMs : 30000;
        const recallPromise = Promise.resolve(source.recallFn(source.instance, query, opts));
        recallPromise.catch(function(err) { debug('UnifiedMemoryRecaller', 'recallFailed', err && err.message ? err.message : String(err)); });
        const items = await Promise.race([
          recallPromise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Source timeout')), sourceTimeoutMs);
            if (timer && typeof timer.unref === 'function') timer.unref();
          }),
        ]);
        const resultItems = ensureArray(items);
        if (sourceStat) sourceStat.results += resultItems.length;
        return {
          sourceName,
          items: resultItems.map(item => this._normalizeResult(item, sourceName)),
          itemCount: resultItems.length,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (sourceStat) sourceStat.errors++;
      debug('UnifiedMemoryRecaller', '_recallFromSource', sourceName, err && err.message ? err.message : String(err));
      return { sourceName, items: [], itemCount: 0, error: err && err.message ? err.message : String(err) };
    }
  }

  _normalizeResult(item, sourceName) {
    return {
      data: item,
      source: sourceName,
      confidence: (item && Number.isFinite(item.confidence)) ? item.confidence : 0.5,
      timestamp: (item && item.timestamp) ?? Date.now(),
      key: (item && (item.key ?? item.id ?? item.causalId)) ?? sourceName + ':' + ((item && item.content && typeof item.content === 'string') ? item.content.slice(0, 100) : Date.now()),
    };
  }

  _deduplicateResults(results) {
    if (results.length <= 1) return results;
    const deduped = [];
    const dedupedIndex = new Map();
    for (const result of results) {
      const key = result.key;
      if (dedupedIndex.has(key)) {
        const idx = dedupedIndex.get(key);
        if (result.confidence > deduped[idx].confidence) {
          deduped[idx] = result;
        }
        this._stats.dedupedCount++;
      } else {
        dedupedIndex.set(key, deduped.length);
        deduped.push(result);
      }
    }
    return deduped;
  }

  _rankResults(results, _query) {
    return results.slice().sort((a, b) => {
      const confDiff = b.confidence - a.confidence;
      if (Math.abs(confDiff) > 0.1) return confDiff;
      const aSource = this._sources.get(a.source);
      const bSource = this._sources.get(b.source);
      const aPriority = aSource ? aSource.priority : 0;
      const bPriority = bSource ? bSource.priority : 0;
      return bPriority - aPriority;
    });
  }

  /**
   * 同步召回（不支持异步源）
   * @param {string} query - 查询
   * @param {Object} [options] - 选项
   * @returns {Object} 召回结果
   */
  recallSync(query, options) {
    if (this._shutDown) return { results: [], sources: {}, meta: { shutDown: true } };
    if (!query || typeof query !== 'string') return { results: [], sources: {}, meta: { invalidQuery: true } };

    this._stats.totalQueries++;
    const opts = safeAssign({ limit: this._config.maxResults, minConfidence: this._config.minConfidence }, options ?? {});

    const allResults = [];
    const sourceResults = {};

    for (const [name, source] of this._sources) {
      if (!source.enabled) continue;
      try {
        const items = source.recallFn(source.instance, query, opts);
        if (items && typeof items.then === 'function') {
          debug('UnifiedMemoryRecaller', 'recallSync', name, 'async source skipped in sync mode');
          sourceResults[name] = { sourceName: name, items: [], itemCount: 0, error: 'async source not supported in sync mode' };
          continue;
        }
        const resultItems = ensureArray(items);
        const normalized = resultItems.map(item => this._normalizeResult(item, name));
        sourceResults[name] = { sourceName: name, items: normalized, itemCount: normalized.length };
        allResults.push(...normalized);
      } catch (err) {
        debug('UnifiedMemoryRecaller', 'recallSync', name, err && err.message ? err.message : String(err));
        sourceResults[name] = { sourceName: name, items: [], itemCount: 0, error: err && err.message ? err.message : String(err) };
      }
    }

    const deduped = this._deduplicateResults(allResults);
    const ranked = this._rankResults(deduped, query);
    const final = ranked.slice(0, opts.limit);

    return {
      results: final,
      sources: sourceResults,
      meta: { totalRaw: allResults.length, afterDedup: deduped.length, returned: final.length, query },
    };
  }

  /**
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      totalQueries: this._stats.totalQueries,
      cacheHits: this._stats.cacheHits,
      cacheMisses: this._stats.cacheMisses,
      cacheHitRate: this._stats.cacheHits + this._stats.cacheMisses > 0
        ? Math.round(this._stats.cacheHits / (this._stats.cacheHits + this._stats.cacheMisses) * 100) / 100
        : 0,
      dedupedCount: this._stats.dedupedCount,
      sourceCount: this._sources.size,
      sourceStats: safeAssign({}, this._stats.sourceStats),
    };
  }

  /**
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._sources.size > 0;
  }

  _onShutdown() {
    this._sources.clear();
    safeCall(() => this._queryCache.shutdown(), 'UnifiedMemoryRecaller', 'shutdown-queryCache');
    this._stats = { totalQueries: 0, cacheHits: 0, cacheMisses: 0, sourceStats: {}, dedupedCount: 0 };
    this.removeAllListeners();
  }
}

UnifiedMemoryRecaller.RECALL_SOURCES = RECALL_SOURCES;
UnifiedMemoryRecaller.DEFAULT_RECALL_CONFIG = DEFAULT_RECALL_CONFIG;

module.exports = withShutdown(UnifiedMemoryRecaller);
