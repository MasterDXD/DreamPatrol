'use strict';

/**
 * @module runtime/thought/memory-prefetcher
 * @classdesc 记忆预取器。5种预取信号、8组件attach、TTL淘汰
 * MemoryPrefetcher — Predictive memory loader based on five signal types for Hermes Prefetch stage
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { safeCall } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const { mergeConfig } = safeAssign;
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');

const PREFETCH_SIGNALS = {
  PHASE_CHANGE: 'phase-change',
  HIGH_ENTROPY: 'high-entropy',
  TASK_AFFINITY: 'task-affinity',
  USER_PATTERN: 'user-pattern',
  PERIODIC: 'periodic',
};

const DEFAULT_PREFETCH_CONFIG = {
  maxPrefetchedEntries: 50,
  prefetchTTL: 300000,
  entropyThreshold: 0.7,
  affinityThreshold: 0.6,
  periodicIntervalMs: 60000,
  maxConcurrentPrefetches: 3,
  maxAccessPatterns: 200,
};

/**
 * MemoryPrefetcher — 记忆预取器，Hermes Prefetch阶段实现。
 * 基于5种信号（阶段变更/高熵意图/任务亲和/用户模式/周期）预测性加载可能需要的记忆。
 */
class MemoryPrefetcher extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_PREFETCH_CONFIG, options ?? {});
    this._prefetched = new BoundedMap(this._config.maxPrefetchedEntries);
    this._accessPatterns = new BoundedArray(this._config.maxAccessPatterns);
    this._activePrefetches = 0;
    this._stats = {
      totalPrefetches: 0,
      hitCount: 0,
      missCount: 0,
      evictionCount: 0,
      bySignal: {},
    };
    this._brainMemory = null;
    this._memoryStore = null;
    this._structuredIntent = null;
    this._affinityLearner = null;
    this._phaseContextInjector = null;
    this._userModelManager = null;
    this._periodicTimer = null;
    this._llmWiki = null;
    this._dreamEngine = null;
    this.removeAllListeners();
  }

  /**
   * @param {Object} brainMemory - BrainMemory实例
   * @returns {MemoryPrefetcher} this
   */
  attachBrainMemory(bm) {
    if (bm && typeof bm === 'object') this._brainMemory = bm;
    return this;
  }

  /**
   * @param {Object} memoryStore - MemoryStore实例
   * @returns {MemoryPrefetcher} this
   */
  attachMemoryStore(ms) {
    if (ms && typeof ms === 'object') this._memoryStore = ms;
    return this;
  }

  /**
   * @param {Object} structuredIntent - StructuredIntent实例
   * @returns {MemoryPrefetcher} this
   */
  attachStructuredIntent(si) {
    if (si && typeof si === 'object') this._structuredIntent = si;
    return this;
  }

  /**
   * @param {Object} affinityLearner - AffinityLearner实例
   * @returns {MemoryPrefetcher} this
   */
  attachAffinityLearner(al) {
    if (al && typeof al === 'object') this._affinityLearner = al;
    return this;
  }

  /**
   * @param {Object} phaseContextInjector - PhaseContextInjector实例
   * @returns {MemoryPrefetcher} this
   */
  attachPhaseContextInjector(pci) {
    if (pci && typeof pci === 'object') this._phaseContextInjector = pci;
    return this;
  }

  /**
   * @param {Object} userModelManager - UserModelManager实例
   * @returns {MemoryPrefetcher} this
   */
  attachUserModelManager(umm) {
    if (umm && typeof umm === 'object') this._userModelManager = umm;
    return this;
  }

  /**
   * @param {Object} llmWiki - LLMWiki实例
   * @returns {MemoryPrefetcher} this
   */
  attachLlmWiki(wiki) {
    if (wiki && typeof wiki === 'object') this._llmWiki = wiki;
    return this;
  }

  /**
   * @param {Object} dreamEngine - DreamEngine实例
   * @returns {MemoryPrefetcher} this
   */
  attachDreamEngine(de) {
    if (de && typeof de === 'object') this._dreamEngine = de;
    return this;
  }

  /**
   * 启动周期性预取定时器
   * @fires MemoryPrefetcher#started
   */
  start() {
    this.guardShutdown();
    if (this._periodicTimer) return;
    const interval = typeof this._config.periodicIntervalMs === 'number' && Number.isFinite(this._config.periodicIntervalMs) ? this._config.periodicIntervalMs : 60000;
    this._periodicTimer = setInterval(() => {
      if (this._shutDown) return;
      try { this._performPeriodicPrefetch(); }
      catch (err) { debug('MemoryPrefetcher', 'periodicPrefetch', err); }
    }, interval);
    if (this._periodicTimer && typeof this._periodicTimer.unref === 'function') {
      this._periodicTimer.unref();
    }
    this.emit('started');
  }

  /**
   * 停止周期性预取定时器
   * @fires MemoryPrefetcher#stopped
   */
  stop() {
    if (this._periodicTimer) {
      clearInterval(this._periodicTimer);
      this._periodicTimer = null;
    }
    this.emit('stopped');
  }

  /**
   * @param {Object} phaseInfo - 阶段变更信息
   */
  onPhaseChange(phaseInfo) {
    if (this._shutDown) return;
    this._recordAccessPattern(PREFETCH_SIGNALS.PHASE_CHANGE, phaseInfo);
    this._prefetchByPhase(phaseInfo);
  }

  /**
   * @param {Object} intentResult - 意图解析结果
   */
  onIntentParsed(intentResult) {
    if (this._shutDown) return;
    if (!intentResult || typeof intentResult !== 'object') return;
    const richness = intentResult.priorRichness;
    if (richness && richness.entropy > this._config.entropyThreshold) {
      this._recordAccessPattern(PREFETCH_SIGNALS.HIGH_ENTROPY, intentResult);
      this._prefetchByEntropy(intentResult);
    }
  }

  /**
   * @param {Object} taskInfo - 任务分配信息
   */
  onTaskAssigned(taskInfo) {
    if (this._shutDown) return;
    this._recordAccessPattern(PREFETCH_SIGNALS.TASK_AFFINITY, taskInfo);
    this._prefetchByAffinity(taskInfo);
  }

  /**
   * @param {Object} interactionInfo - 用户交互信息
   */
  onUserInteraction(interactionInfo) {
    if (this._shutDown) return;
    this._recordAccessPattern(PREFETCH_SIGNALS.USER_PATTERN, interactionInfo);
    this._prefetchByUserPattern(interactionInfo);
  }

  /**
   * @param {string} query - 查询键
   * @returns {Object|null} 预取数据或null
   */
  getPrefetched(query) {
    if (!query || typeof query !== 'string') return null;
    const entry = this._prefetched.get(query);
    if (!entry) {
      this._stats.missCount++;
      return null;
    }
    if (Date.now() - entry.prefetchedAt > this._config.prefetchTTL) {
      this._prefetched.delete(query);
      this._stats.evictionCount++;
      this._stats.missCount++;
      return null;
    }
    entry.hitCount++;
    this._stats.hitCount++;
    return entry.data;
  }

  /**
   * @param {Object} context - 上下文信息
   * @returns {Array} 匹配的预取条目
   */
  getPrefetchedForContext(context) {
    if (!context || typeof context !== 'object') return [];
    const results = [];
    const now = Date.now();
    const expiredKeys = [];
    for (const [key, entry] of this._prefetched) {
      if (now - entry.prefetchedAt > this._config.prefetchTTL) {
        expiredKeys.push(key);
        this._stats.evictionCount++;
        continue;
      }
      if (this._matchesContext(entry, context)) {
        entry.hitCount++;
        results.push(entry.data);
      }
    }
    for (const ek of expiredKeys) { this._prefetched.delete(ek); }
    if (results.length > 0) {
      this._stats.hitCount += results.length;
    }
    return results;
  }

  _matchesContext(entry, context) {
    if (!entry.metadata) return false;
    if (context.phase && entry.metadata.phase === context.phase) return true;
    if (context.skillId && entry.metadata.skillId === context.skillId) return true;
    if (context.taskType && entry.metadata.taskType === context.taskType) return true;
    return false;
  }

  _prefetchByPhase(phaseInfo) {
    if (this._activePrefetches >= this._config.maxConcurrentPrefetches) return;
    const phase = phaseInfo && phaseInfo.phase;
    if (!phase) return;
    this._activePrefetches++;
    this._doPrefetch(PREFETCH_SIGNALS.PHASE_CHANGE, 'phase:' + phase, async () => {
      const memories = [];
      if (this._brainMemory) {
        safeCall(() => {
          const retrieved = this._brainMemory.retrieve(phase, { limit: 5 });
          if (Array.isArray(retrieved)) memories.push(...retrieved);
        }, 'MemoryPrefetcher', 'prefetchByPhase_brainMemory');
      }
      if (this._llmWiki) {
        safeCall(() => {
          const results = this._llmWiki.search(phase);
          if (Array.isArray(results)) memories.push(...results.slice(0, 3));
        }, 'MemoryPrefetcher', 'prefetchByPhase_llmWiki');
      }
      if (this._dreamEngine) {
        safeCall(() => {
          const notes = this._dreamEngine.getRelevantNotes(phase);
          if (Array.isArray(notes)) memories.push(...notes.slice(0, 3));
        }, 'MemoryPrefetcher', 'prefetchByPhase_dreamEngine');
      }
      return { memories, metadata: { phase, signal: PREFETCH_SIGNALS.PHASE_CHANGE } };
    });
  }

  _prefetchByEntropy(intentResult) {
    if (this._activePrefetches >= this._config.maxConcurrentPrefetches) return;
    const query = intentResult.intent || intentResult.action || '';
    if (!query) return;
    this._activePrefetches++;
    this._doPrefetch(PREFETCH_SIGNALS.HIGH_ENTROPY, 'entropy:' + query, async () => {
      const memories = [];
      if (this._brainMemory) {
        safeCall(() => {
          const retrieved = this._brainMemory.retrieve(query, { limit: 8 });
          if (Array.isArray(retrieved)) memories.push(...retrieved);
        }, 'MemoryPrefetcher', 'prefetchByEntropy_brainMemory');
      }
      if (this._memoryStore) {
        safeCall(() => {
          const knowledge = this._memoryStore.queryKnowledge(query);
          if (Array.isArray(knowledge)) memories.push(...knowledge.slice(0, 5));
        }, 'MemoryPrefetcher', 'prefetchByEntropy_memoryStore');
      }
      return { memories, metadata: { query, entropy: intentResult.priorRichness?.entropy, signal: PREFETCH_SIGNALS.HIGH_ENTROPY } };
    });
  }

  _prefetchByAffinity(taskInfo) {
    if (this._activePrefetches >= this._config.maxConcurrentPrefetches) return;
    const taskType = taskInfo && (taskInfo.type || taskInfo.skillId || '');
    if (!taskType) return;
    this._activePrefetches++;
    this._doPrefetch(PREFETCH_SIGNALS.TASK_AFFINITY, 'affinity:' + taskType, async () => {
      const memories = [];
      if (this._brainMemory) {
        safeCall(() => {
          const retrieved = this._brainMemory.retrieve(taskType, { limit: 5 });
          if (Array.isArray(retrieved)) memories.push(...retrieved);
        }, 'MemoryPrefetcher', 'prefetchByAffinity_brainMemory');
      }
      if (this._affinityLearner) {
        safeCall(() => {
          const recommendations = this._affinityLearner.getRecommendations(taskType, { limit: 3 });
          if (Array.isArray(recommendations)) {
            for (const rec of recommendations) {
              if (rec.score >= this._config.affinityThreshold && rec.agentId) {
                memories.push({ type: 'affinity_recommendation', agentId: rec.agentId, score: rec.score, taskType });
              }
            }
          }
        }, 'MemoryPrefetcher', 'prefetchByAffinity_affinityLearner');
      }
      return { memories, metadata: { taskType, signal: PREFETCH_SIGNALS.TASK_AFFINITY } };
    });
  }

  _prefetchByUserPattern(interactionInfo) {
    if (this._activePrefetches >= this._config.maxConcurrentPrefetches) return;
    const userId = interactionInfo && interactionInfo.userId;
    if (!userId) return;
    this._activePrefetches++;
    this._doPrefetch(PREFETCH_SIGNALS.USER_PATTERN, 'user:' + userId, async () => {
      const memories = [];
      if (this._userModelManager) {
        safeCall(() => {
          const prefs = this._userModelManager.getPreferences(userId);
          if (prefs && typeof prefs === 'object') {
            memories.push({ type: 'user_preferences', userId, preferences: prefs });
          }
        }, 'MemoryPrefetcher', 'prefetchByUser_userModel');
      }
      return { memories, metadata: { userId, signal: PREFETCH_SIGNALS.USER_PATTERN } };
    });
  }

  _performPeriodicPrefetch() {
    if (this._shutDown) return;
    if (this._accessPatterns.length === 0) return;
    this._activePrefetches++;
    this._doPrefetch(PREFETCH_SIGNALS.PERIODIC, 'periodic:' + Date.now(), async () => {
      const recentPatterns = this._accessPatterns.slice(-10);
      const queries = [];
      for (const pattern of recentPatterns) {
        if (pattern && pattern.data && typeof pattern.data === 'object') {
          const q = pattern.data.phase || pattern.data.intent || pattern.data.type || '';
          if (q && !queries.includes(q)) queries.push(q);
        }
      }
      const memories = [];
      for (const query of queries.slice(0, 3)) {
        if (this._brainMemory) {
          safeCall(() => {
            const retrieved = this._brainMemory.retrieve(query, { limit: 3 });
            if (Array.isArray(retrieved)) memories.push(...retrieved);
          }, 'MemoryPrefetcher', 'periodicPrefetch');
        }
      }
      return { memories, metadata: { signal: PREFETCH_SIGNALS.PERIODIC, queryCount: queries.length } };
    });
  }

  _doPrefetch(signal, cacheKey, computeFn) {
    if (this._prefetched.has(cacheKey)) {
      const existing = this._prefetched.get(cacheKey);
      if (existing && Date.now() - existing.prefetchedAt <= this._config.prefetchTTL) {
        this._activePrefetches = Math.max(0, this._activePrefetches - 1);
        return;
      }
      this._prefetched.delete(cacheKey);
      this._stats.evictionCount++;
    }
    this._stats.totalPrefetches++;
    if (!this._stats.bySignal[signal]) this._stats.bySignal[signal] = 0;
    this._stats.bySignal[signal]++;
    let settled = false;
    const self = this;
    const decActive = () => { if (!settled) { settled = true; self._activePrefetches = Math.max(0, self._activePrefetches - 1); } };
    try {
      const result = computeFn();
      if (result && typeof result.then === 'function') {
        result.then(function(data) {
          try {
            if (self._shutDown) { return; }
            self._storePrefetched(cacheKey, data);
            self.emit('prefetch-completed', { signal, cacheKey, memoryCount: data && data.memories ? data.memories.length : 0 });
          } finally {
            decActive();
          }
        }).catch(function(err) {
          if (self._shutDown) { decActive(); return; }
          debug('MemoryPrefetcher', '_doPrefetch async error', err);
          decActive();
        });
      } else if (result) {
        this._storePrefetched(cacheKey, result);
        decActive();
        this.emit('prefetch-completed', { signal, cacheKey, memoryCount: result && result.memories ? result.memories.length : 0 });
      } else {
        decActive();
      }
    } catch (err) {
      debug('MemoryPrefetcher', '_doPrefetch sync error', err);
      decActive();
    }
  }

  _storePrefetched(key, data) {
    this._prefetched.set(key, {
      data,
      prefetchedAt: Date.now(),
      hitCount: 0,
      metadata: data && data.metadata ? data.metadata : {},
    });
  }

  _recordAccessPattern(signal, data) {
    this._accessPatterns.push({ signal, data, timestamp: Date.now() });
  }

  /**
   * @returns {Object} 统计信息
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('MemoryPrefetcher', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalPrefetches: 0, hitCount: 0, missCount: 0, evictionCount: 0, hitRate: 0, prefetchedSize: 0, activePrefetches: 0, bySignal: {} }; }
    return {
      totalPrefetches: this._stats.totalPrefetches,
      hitCount: this._stats.hitCount,
      missCount: this._stats.missCount,
      evictionCount: this._stats.evictionCount,
      hitRate: this._stats.hitCount + this._stats.missCount > 0
        ? Math.round(this._stats.hitCount / (this._stats.hitCount + this._stats.missCount) * 100) / 100
        : 0,
      prefetchedSize: this._prefetched.size,
      activePrefetches: this._activePrefetches,
      bySignal: safeAssign({}, this._stats.bySignal),
    };
  }

  /**
   * @returns {boolean} 健康状态（未关闭）
   */
  isHealthy() {
    return !this._shutDown;
  }

  /**
   * @returns {boolean} 是否有容量（预取数未超限）
   */
  hasCapacity() {
    return this._activePrefetches < this._config.maxConcurrentPrefetches * 2;
  }

  _onShutdown() {
    this.stop();
    safeCall(() => this._prefetched.shutdown(), 'MemoryPrefetcher', 'shutdown-prefetched');
    safeCall(() => this._accessPatterns.shutdown(), 'MemoryPrefetcher', 'shutdown-accessPatterns');
    this._activePrefetches = 0;
    this._stats = { totalPrefetches: 0, hitCount: 0, missCount: 0, evictionCount: 0, bySignal: {} };
    this._brainMemory = null;
    this._memoryStore = null;
    this._structuredIntent = null;
    this._affinityLearner = null;
    this._phaseContextInjector = null;
    this._userModelManager = null;
    this._llmWiki = null;
    this._dreamEngine = null;
    this.removeAllListeners();
  }
}

MemoryPrefetcher.PREFETCH_SIGNALS = PREFETCH_SIGNALS;
MemoryPrefetcher.DEFAULT_PREFETCH_CONFIG = DEFAULT_PREFETCH_CONFIG;

module.exports = withShutdown(MemoryPrefetcher);
