'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { safeCall } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const { mergeConfig } = safeAssign;
const BoundedArray = require('../../utils/bounded-array');

/**
 * 反馈类型枚举
 * @enum {string}
 */
const FEEDBACK_TYPES = {
  DREAM_TO_CAUSAL: 'dream-to-causal',
  CAUSAL_TO_MEMORY: 'causal-to-memory',
  MEMORY_TO_PREFETCH: 'memory-to-prefetch',
  CONSOLIDATION: 'consolidation',
};

/**
 * 巩固策略枚举
 * @enum {string}
 */
const CONSOLIDATION_STRATEGIES = {
  IMMEDIATE: 'immediate',
  BATCHED: 'batched',
  SCHEDULED: 'scheduled',
};

const DEFAULT_CONFIG = {
  maxFeedbackHistory: 200,
  consolidationBatchSize: 10,
  consolidationIntervalMs: 300000,
  causalPrefetchThreshold: 0.5,
  dreamToCausalMinConfidence: 0.6,
  memoryDecayWeight: 0.1,
  enableAutoConsolidation: true,
};

const MAX_CONSOLIDATION_QUEUE = 200;

/**
 * @module runtime/thought/causal-memory-bridge
 * @classdesc 因果-记忆桥接器。实现MAGMA双流读写机制与进化机制的跨模块桥接
 * CausalMemoryBridge — Bridge between DreamEngine, CausalMemoryStore, and
 * MemoryPrefetcher implementing MAGMA's "dual-stream read/write" and "evolution" concepts.
 *
 * 融合MAGMA架构核心能力：将Harness现有的DreamEngine（进化机制）、
 * CausalMemoryStore（因果图谱）、MemoryPrefetcher（预取机制）桥接为统一的
 * 因果-记忆反馈闭环，实现MAGMA的"快车道/慢车道双流"和"动态巩固"能力。
 *
 * 核心特性：
 * - Dream→Causal反馈：将DreamEngine提炼的模式注入CausalMemoryStore
 * - Causal→Memory反馈：将因果记忆写入BrainMemory长期存储
 * - 因果感知预取：基于因果链预测性预加载相关记忆
 * - 双流巩固：即时响应（快车道）+后台异步巩固（慢车道）
 *
 * @extends EventEmitter
 * @emits CausalMemoryBridge#feedback-applied
 * @emits CausalMemoryBridge#consolidation-completed
 * @emits CausalMemoryBridge#causal-prefetch-triggered
 * @emits CausalMemoryBridge#error
 *
 * @example
 * const CausalMemoryBridge = require('./causal-memory-bridge');
 * const bridge = new CausalMemoryBridge();
 * bridge.attachDreamEngine(dreamEngine);
 * bridge.attachCausalMemory(causalMemoryStore);
 * bridge.attachBrainMemory(brainMemory);
 * bridge.attachPrefetcher(memoryPrefetcher);
 *
 * // DreamEngine完成后自动反馈到因果记忆
 * bridge.onDreamCompleted(dreamResult);
 *
 * // 基于因果链预取
 * const prefetched = await bridge.prefetchByCausalChain('auth-failure');
 */
class CausalMemoryBridge extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    this._dreamEngine = null;
    this._causalMemory = null;
    this._brainMemory = null;
    this._prefetcher = null;
    this._causalBus = null;
    this._feedbackHistory = new BoundedArray(this._config.maxFeedbackHistory);
    this._consolidationQueue = [];
    this._consolidationTimer = null;
    this._stats = {
      feedbackApplied: 0,
      consolidationsCompleted: 0,
      causalPrefetches: 0,
      dreamToCausalCount: 0,
      causalToMemoryCount: 0,
      errors: 0,
    };
  }

  /**
   * 附加DreamEngine实例
   * @param {Object} engine - DreamEngine实例
   * @returns {CausalMemoryBridge} this
   */
  attachDreamEngine(engine) {
    this.guardShutdown();
    if (engine && typeof engine === 'object') {
      this._dreamEngine = engine;
      debug('CausalMemoryBridge', 'attachDreamEngine', 'attached');
    }
    return this;
  }

  /**
   * 附加CausalMemoryStore实例
   * @param {Object} store - CausalMemoryStore实例
   * @returns {CausalMemoryBridge} this
   */
  attachCausalMemory(store) {
    this.guardShutdown();
    if (store && typeof store === 'object') {
      this._causalMemory = store;
      debug('CausalMemoryBridge', 'attachCausalMemory', 'attached');
    }
    return this;
  }

  /**
   * 附加BrainMemory实例
   * @param {Object} memory - BrainMemory实例
   * @returns {CausalMemoryBridge} this
   */
  attachBrainMemory(memory) {
    this.guardShutdown();
    if (memory && typeof memory === 'object') {
      this._brainMemory = memory;
      debug('CausalMemoryBridge', 'attachBrainMemory', 'attached');
    }
    return this;
  }

  /**
   * 附加MemoryPrefetcher实例
   * @param {Object} prefetcher - MemoryPrefetcher实例
   * @returns {CausalMemoryBridge} this
   */
  attachPrefetcher(prefetcher) {
    this.guardShutdown();
    if (prefetcher && typeof prefetcher === 'object') {
      this._prefetcher = prefetcher;
      debug('CausalMemoryBridge', 'attachPrefetcher', 'attached');
    }
    return this;
  }

  /**
   * 附加CausalDataBus实例
   * @param {Object} bus - CausalDataBus实例
   * @returns {CausalMemoryBridge} this
   */
  attachCausalBus(bus) {
    this.guardShutdown();
    if (bus && typeof bus === 'object') {
      this._causalBus = bus;
      debug('CausalMemoryBridge', 'attachCausalBus', 'attached');
    }
    return this;
  }

  /**
   * 启动自动巩固定时器（慢车道）
   * @fires CausalMemoryBridge#started
   */
  startAutoConsolidation() {
    this.guardShutdown();
    if (this._consolidationTimer) return;
    if (!this._config.enableAutoConsolidation) return;

    const interval = typeof this._config.consolidationIntervalMs === 'number' &&
      Number.isFinite(this._config.consolidationIntervalMs) &&
      this._config.consolidationIntervalMs > 0
      ? this._config.consolidationIntervalMs
      : 300000;

    this._consolidationTimer = setInterval(() => {
      if (this._shutDown) return;
      this._runConsolidation().catch(err => {
        debug('CausalMemoryBridge', 'autoConsolidation error', err);
        this._stats.errors++;
      });
    }, interval);

    if (this._consolidationTimer && typeof this._consolidationTimer.unref === 'function') {
      this._consolidationTimer.unref();
    }

    this.emit('started');
  }

  /**
   * 停止自动巩固定时器
   */
  stopAutoConsolidation() {
    if (this._consolidationTimer) {
      clearInterval(this._consolidationTimer);
      this._consolidationTimer = null;
    }
  }

  /**
   * DreamEngine完成后的反馈处理（快车道）。
   * 将DreamEngine提炼的模式注入CausalMemoryStore，实现MAGMA的
   * "进化机制→数据基座"反馈闭环。
   *
   * @param {Object} dreamResult - DreamEngine的做梦结果
   * @returns {Promise<{applied: number, skipped: number}>}
   */
  async onDreamCompleted(dreamResult) {
    this.guardShutdown();
    if (!dreamResult || typeof dreamResult !== 'object') {
      return { applied: 0, skipped: 0 };
    }

    let applied = 0;
    let skipped = 0;

    // 提取DreamEngine笔记中的因果关系
    const notes = dreamResult.notes ?? dreamResult.newNotes ?? [];
    for (const note of notes) {
      if (!note || typeof note !== 'object') continue;

      const confidence = note.confidence ?? 0.5;
      if (confidence < this._config.dreamToCausalMinConfidence) {
        skipped++;
        continue;
      }

      // 将DreamEngine笔记转化为因果记忆
      if (this._causalMemory && typeof this._causalMemory.store === 'function') {
        try {
          const cause = this._extractCause(note);
          const effect = this._extractEffect(note);
          if (cause && effect) {
            await this._causalMemory.store({
              cause,
              effect,
              context: note.content ?? '',
              confidence,
              category: note.category ?? 'dream-derived',
              tags: note.tags ?? ['dream', 'auto-derived'],
              source: 'dream-engine',
            });
            applied++;
            this._stats.dreamToCausalCount++;
          } else {
            skipped++;
          }
        } catch (err) {
          debug('CausalMemoryBridge', 'onDreamCompleted store error', err);
          skipped++;
        }
      } else {
        skipped++;
      }
    }

    if (applied > 0) {
      this._recordFeedback(FEEDBACK_TYPES.DREAM_TO_CAUSAL, {
        dreamId: dreamResult.dreamId,
        applied,
        skipped,
      });
    }

    this._stats.feedbackApplied += applied;
    this.emit('feedback-applied', { type: FEEDBACK_TYPES.DREAM_TO_CAUSAL, applied, skipped });

    return { applied, skipped };
  }

  /**
   * 将因果记忆写入BrainMemory长期存储（慢车道巩固）。
   * 实现MAGMA的"数据基座→记忆巩固"流程。
   *
   * @param {Object} causalEntry - 因果记忆条目
   * @returns {Promise<boolean>} 是否成功写入
   */
  async consolidateToMemory(causalEntry) {
    this.guardShutdown();
    if (!causalEntry || typeof causalEntry !== 'object') return false;
    if (!this._brainMemory) return false;

    try {
      const key = 'causal-' + (causalEntry.id ?? Date.now());
      const content = causalEntry.cause + ' → ' + causalEntry.effect;
      const metadata = {
        category: causalEntry.category ?? 'causal',
        tags: causalEntry.tags ?? ['causal', 'consolidated'],
        confidence: causalEntry.confidence ?? 0.5,
        source: 'causal-memory-bridge',
        causalId: causalEntry.id,
        consolidatedAt: Date.now(),
      };

      if (typeof this._brainMemory.store === 'function') {
        this._brainMemory.store(key, content, metadata);
      } else {
        return false;
      }
      this._stats.causalToMemoryCount++;
      this._recordFeedback(FEEDBACK_TYPES.CAUSAL_TO_MEMORY, { causalId: causalEntry.id });
      return true;
    } catch (err) {
      debug('CausalMemoryBridge', 'consolidateToMemory error', err);
      return false;
    }
  }

  /**
   * 基于因果链的预测性预取（快车道）。
   * 实现MAGMA的"因果感知预取"能力，根据当前因果链
   * 预测可能需要的记忆并预加载。
   *
   * @param {string} currentContext - 当前上下文
   * @param {Object} [options] - 预取选项
   * @param {number} [options.maxDepth=2] - 因果链追踪深度
   * @param {number} [options.maxResults=5] - 最大预取结果数
   * @returns {Promise<Array<Object>>} 预取的记忆条目
   */
  async prefetchByCausalChain(currentContext, options) {
    this.guardShutdown();
    if (!currentContext || typeof currentContext !== 'string') return [];
    if (!this._causalMemory) return [];

    const opts = options ?? {};
    const maxDepth = opts.maxDepth ?? 2;
    const maxResults = opts.maxResults ?? 5;

    try {
      // 搜索与当前上下文相关的因果记忆
      let relatedMemories = [];
      try {
        relatedMemories = await this._causalMemory.searchByCausalSimilarity(currentContext, {
          limit: maxResults * 2,
          threshold: this._config.causalPrefetchThreshold,
        });
      } catch (searchErr) {
        debug('CausalMemoryBridge', 'prefetchByCausalChain search', searchErr);
      }

      const memories = Array.isArray(relatedMemories) ? relatedMemories : [];
      const prefetched = [];

      for (const mem of memories.slice(0, maxResults)) {
        // 追踪因果链
        const chainResults = await this._traceCausalChain(mem, maxDepth);
        prefetched.push({
          source: 'causal-chain',
          causalMemory: mem,
          relatedChain: chainResults,
          prefetchedAt: Date.now(),
        });

        // 如果有Prefetcher，注入预取结果
        if (this._prefetcher && typeof this._prefetcher._prefetched === 'object') {
          try {
            this._prefetcher._prefetched.set('causal:' + mem.id, {
              data: mem,
              prefetchedAt: Date.now(),
              hitCount: 0,
              metadata: { source: 'causal-bridge', cause: mem.cause },
            });
          } catch (prefetchErr) {
            debug('CausalMemoryBridge', 'prefetcher inject error', prefetchErr);
          }
        }
      }

      this._stats.causalPrefetches += prefetched.length;
      this._recordFeedback(FEEDBACK_TYPES.MEMORY_TO_PREFETCH, {
        context: currentContext,
        count: prefetched.length,
      });

      this.emit('causal-prefetch-triggered', {
        context: currentContext,
        count: prefetched.length,
      });

      return prefetched;
    } catch (err) {
      debug('CausalMemoryBridge', 'prefetchByCausalChain error', err);
      return [];
    }
  }

  /**
   * 执行巩固批次（慢车道）。
   * 将因果记忆队列中的条目批量写入BrainMemory。
   *
   * @returns {Promise<{consolidated: number, failed: number}>}
   */
  async _runConsolidation() {
    if (this._shutDown) return { consolidated: 0, failed: 0 };
    if (this._consolidationQueue.length === 0) {
      // 从CausalMemoryStore中获取需要巩固的条目
      if (this._causalMemory && typeof this._causalMemory.getCausalMemories === 'function') {
        let memories = [];
        try { memories = this._causalMemory.getCausalMemories({ limit: this._config.consolidationBatchSize }) ?? []; } catch (err) { debug('CausalMemoryBridge', '_runConsolidation getCausalMemories', err); }
        const memList = Array.isArray(memories) ? memories : [];
        for (const mem of memList) {
          if (mem && mem.confidence >= this._config.dreamToCausalMinConfidence) {
            if (this._consolidationQueue.length >= MAX_CONSOLIDATION_QUEUE) {
              this._consolidationQueue.shift();
            }
            this._consolidationQueue.push(mem);
          }
        }
      }
    }

    let consolidated = 0;
    let failed = 0;
    const batch = this._consolidationQueue.splice(0, this._config.consolidationBatchSize);

    for (const entry of batch) {
      const success = await this.consolidateToMemory(entry);
      if (success) {
        consolidated++;
      } else {
        failed++;
      }
    }

    if (consolidated > 0) {
      this._stats.consolidationsCompleted++;
      this._recordFeedback(FEEDBACK_TYPES.CONSOLIDATION, { consolidated, failed });
      this.emit('consolidation-completed', { consolidated, failed });
    }

    return { consolidated, failed };
  }

  /**
   * 追踪因果链，获取与指定记忆因果相关的后续记忆
   * @param {Object} mem - 起始因果记忆
   * @param {number} maxDepth - 最大追踪深度
   * @returns {Promise<Array<Object>>} 关联的因果记忆
   */
  async _traceCausalChain(mem, maxDepth) {
    if (!this._causalMemory || !mem) return [];
    const results = [];
    const visited = new Set();
    visited.add(mem.id);

    let currentEffects = [mem.effect];
    for (let depth = 0; depth < maxDepth; depth++) {
      const nextEffects = [];
      for (const effect of currentEffects) {
        let related = [];
        try {
          related = await this._causalMemory.searchByCausalSimilarity(effect, { limit: 3, threshold: 0.4 });
        } catch (err) { debug('CausalMemoryBridge', '_traceCausalChain search', err); }
        const relatedList = Array.isArray(related) ? related : [];
        for (const r of relatedList) {
          if (!visited.has(r.id)) {
            visited.add(r.id);
            results.push(r);
            nextEffects.push(r.effect);
          }
        }
      }
      if (nextEffects.length === 0) break;
      currentEffects = nextEffects;
    }

    return results;
  }

  /**
   * 从DreamEngine笔记中提取因果关系（cause部分）
   * @param {Object} note - DreamEngine笔记
   * @returns {string|null} cause描述
   */
  _extractCause(note) {
    if (!note) return null;
    const content = note.content ?? note.text ?? '';
    if (!content) return null;

    // 尝试从错误规避笔记中提取
    if (note.category === 'error-avoidance') {
      const markers = ['error:', 'fail:', 'bug:', '错误:', '失败:'];
      for (const m of markers) {
        const idx = content.toLowerCase().indexOf(m);
        if (idx >= 0) {
          return content.substring(0, Math.min(idx + m.length + 100, content.length)).trim();
        }
      }
    }

    // 默认：使用内容前100字符作为cause
    return content.substring(0, Math.min(100, content.length)).trim() || null;
  }

  /**
   * 从DreamEngine笔记中提取效果描述（effect部分）
   * @param {Object} note - DreamEngine笔记
   * @returns {string|null} effect描述
   */
  _extractEffect(note) {
    if (!note) return null;
    const content = note.content ?? note.text ?? '';
    if (!content) return null;

    // 尝试从最佳实践笔记中提取
    if (note.category === 'best-practice') {
      const markers = ['should:', 'recommend:', 'best:', '建议:', '推荐:'];
      for (const m of markers) {
        const idx = content.toLowerCase().indexOf(m);
        if (idx >= 0) {
          return content.substring(idx, Math.min(idx + 100, content.length)).trim();
        }
      }
    }

    // 默认：使用笔记类别作为effect
    const category = note.category ?? 'insight';
    const effect = category + ': ' + content.substring(0, Math.min(80, content.length)).trim();
    return effect || null;
  }

  /**
   * 记录反馈历史
   * @param {string} type - 反馈类型
   * @param {Object} data - 反馈数据
   */
  _recordFeedback(type, data) {
    this._feedbackHistory.push({
      type,
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * 获取桥接器统计信息
   * @returns {Object} 统计数据
   */
  getStats() {
    if (this._shutDown) return { feedbackApplied: 0, consolidationsCompleted: 0, causalPrefetches: 0, attachedSources: {}, consolidationQueueSize: 0, feedbackHistorySize: 0, autoConsolidationRunning: false };
    return {
      ...this._stats,
      attachedSources: {
        dreamEngine: this._dreamEngine !== null,
        causalMemory: this._causalMemory !== null,
        brainMemory: this._brainMemory !== null,
        prefetcher: this._prefetcher !== null,
        causalBus: this._causalBus !== null,
      },
      consolidationQueueSize: this._consolidationQueue.length,
      feedbackHistorySize: this._feedbackHistory.length,
      autoConsolidationRunning: this._consolidationTimer !== null,
    };
  }

  /**
   * 获取反馈历史
   * @param {string} [type] - 按类型过滤
   * @returns {Array<Object>} 反馈记录
   */
  getFeedbackHistory(type) {
    this.guardShutdown();
    const history = this._feedbackHistory.toArray();
    if (type) {
      return history.filter(h => h.type === type);
    }
    return history;
  }

  _onShutdown() {
    this.stopAutoConsolidation();
    this._consolidationQueue = [];
    safeCall(() => this._feedbackHistory.shutdown(), 'CausalMemoryBridge', 'shutdown-feedbackHistory');
    this._feedbackHistory = null;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(CausalMemoryBridge);
module.exports.FEEDBACK_TYPES = FEEDBACK_TYPES;
module.exports.CONSOLIDATION_STRATEGIES = CONSOLIDATION_STRATEGIES;
