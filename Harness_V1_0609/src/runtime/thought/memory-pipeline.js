'use strict';

/**
 * @module runtime/thought/memory-pipeline
 * @classdesc 记忆管道集成（MemoryPipeline）—— Hermes三阶段管道统一接入。
 * 三阶段：Recall（7源跨存储联合召回）→Sync（跨存储一致性协调）→Prefetch（5种预取信号驱动预加载）。
 * 自动布线8+外部组件（BrainMemory/MemoryStore/ThoughtStore/LLMWiki/DreamEngine/CausalStore/Prefetcher/Providers），
 * 支持外部记忆提供商（mem0/Honcho/Hindsight），单入口API，级联shutdown。
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { safeCall } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');

const MemoryPrefetcherModule = require('./memory-prefetcher');
const MemoryPrefetcher = MemoryPrefetcherModule.MemoryPrefetcher || MemoryPrefetcherModule;
const UnifiedMemoryRecallerModule = require('./unified-memory-recaller');
const UnifiedMemoryRecaller = UnifiedMemoryRecallerModule.UnifiedMemoryRecaller || UnifiedMemoryRecallerModule;
const MemorySyncCoordinatorModule = require('./memory-sync-coordinator');
const MemorySyncCoordinator = MemorySyncCoordinatorModule.MemorySyncCoordinator || MemorySyncCoordinatorModule;
const ProviderModule = require('./provider');
const ProviderRegistry = ProviderModule.ProviderRegistry;
const ProviderHealthChecker = ProviderModule.ProviderHealthChecker;
const { SurprisalGate } = require('./surprisal-gate');
const { MutableRAG } = require('./mutable-rag');
const { AffectiveRouter } = require('./affective-router');
const { SpreadingActivation } = require('./spreading-activation');

const PIPELINE_STAGES = {
  RECALL: 'recall',
  SYNC: 'sync',
  PREFETCH: 'prefetch',
};

const DEFAULT_PIPELINE_CONFIG = {
  enablePrefetch: true,
  enableRecall: true,
  enableSync: true,
  prefetchConfig: {},
  recallConfig: {},
  syncConfig: {},
  providers: { enabled: false, adapters: {} },
};

class MemoryPipeline extends EventEmitter {
  /**
   * 创建MemoryPipeline实例。内部创建Prefetcher、Recaller、SyncCoordinator、ProviderRegistry和HealthChecker。
   * @param {Object} [options] - 配置选项
   * @param {boolean} [options.enablePrefetch=true] - 是否启用预取阶段
   * @param {boolean} [options.enableRecall=true] - 是否启用召回阶段
   * @param {boolean} [options.enableSync=true] - 是否启用同步阶段
   * @param {Object} [options.prefetchConfig] - Prefetcher配置
   * @param {Object} [options.recallConfig] - Recaller配置
   * @param {Object} [options.syncConfig] - SyncCoordinator配置
   * @param {Object} [options.providers] - 外部提供商配置（{enabled: boolean, adapters: {name: {type, ...config}}}）
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_PIPELINE_CONFIG, options ?? {});
    this._prefetcher = new MemoryPrefetcher(this._config.prefetchConfig);
    this._recaller = new UnifiedMemoryRecaller(this._config.recallConfig);
    this._syncCoordinator = new MemorySyncCoordinator(this._config.syncConfig);
    this._providerRegistry = new ProviderRegistry();
    this._healthChecker = new ProviderHealthChecker(this._providerRegistry);
    this._attachedProviders = new Map();
    this._components = {};
    this._initialized = false;
    this._stats = { recallQueries: 0, syncOperations: 0, prefetchTriggers: 0 };
    // Mnemosyne-enhanced modules
    this._surprisalGate = new SurprisalGate(this._config.surprisalGateConfig);
    this._mutableRAG = new MutableRAG(this._config.mutableRAGConfig);
    this._affectiveRouter = new AffectiveRouter(this._config.affectiveRouterConfig);
    this._spreadingActivation = new SpreadingActivation(this._config.spreadingActivationConfig);
  }

  /**
   * 附加外部组件到管道，供initialize()时自动布线。
   * 支持的组件名：brain-memory/memory-store/thought-store/llm-wiki/dream-engine/causal-store/
   * structured-intent/affinity-learner/phase-context-injector/user-model-manager/embedding-service/sqlite-store
   * @param {string} name - 组件名称
   * @param {Object} instance - 组件实例
   * @returns {MemoryPipeline} this（支持链式调用）
   */
  attachComponent(name, instance) {
    this.guardShutdown();
    if (typeof name !== 'string' || !name) return this;
    if (!instance || typeof instance !== 'object') return this;
    this._components[name] = instance;
    return this;
  }

  /**
   * 初始化记忆管道，自动布线所有已附加的组件（Prefetcher/Recaller/SyncCoordinator/DreamEngine/Providers）。
   * @returns {MemoryPipeline} this — 支持链式调用
   * @emits 'pipeline-initialized'
   * @throws {Error} When required components are not attached before initialization
   * @example
   * const pipeline = new MemoryPipeline({ syncIntervalMs: 60000 });
   * pipeline.attachComponent('brainMemory', brainMemoryInstance);
   * pipeline.attachComponent('memoryStore', memoryStoreInstance);
   * await pipeline.initialize();
   */
  initialize() {
    this.guardShutdown();
    if (this._initialized) return this;
    this._wirePrefetcher();
    this._wireRecaller();
    this._wireSyncCoordinator();
    this._wireDreamEngine();
    this._wireProviders();
    this._initialized = true;
    this.emit('pipeline-initialized');
    return this;
  }

  _wirePrefetcher() {
    const c = this._components;
    if (c['brain-memory']) this._prefetcher.attachBrainMemory(c['brain-memory']);
    if (c['memory-store']) this._prefetcher.attachMemoryStore(c['memory-store']);
    if (c['structured-intent']) this._prefetcher.attachStructuredIntent(c['structured-intent']);
    if (c['affinity-learner']) this._prefetcher.attachAffinityLearner(c['affinity-learner']);
    if (c['phase-context-injector']) this._prefetcher.attachPhaseContextInjector(c['phase-context-injector']);
    if (c['user-model-manager']) this._prefetcher.attachUserModelManager(c['user-model-manager']);
    if (c['llm-wiki']) this._prefetcher.attachLlmWiki(c['llm-wiki']);
    if (c['dream-engine']) this._prefetcher.attachDreamEngine(c['dream-engine']);
    if (this._config.enablePrefetch) this._prefetcher.start();
  }

  _wireRecaller() {
    const c = this._components;
    if (c['brain-memory']) this._recaller.attachSource('brain-memory', c['brain-memory']);
    if (c['memory-store']) this._recaller.attachSource('memory-store', c['memory-store'], { priority: 2 });
    if (c['thought-store']) this._recaller.attachSource('thought-store', c['thought-store']);
    if (c['llm-wiki']) this._recaller.attachSource('llm-wiki', c['llm-wiki'], { priority: 3 });
    if (c['dream-engine']) this._recaller.attachSource('dream-engine', c['dream-engine']);
    if (c['causal-store']) this._recaller.attachSource('causal-store', c['causal-store']);
    this._recaller.attachSource('prefetcher', this._prefetcher);
  }

  _wireSyncCoordinator() {
    const c = this._components;
    if (c['brain-memory']) this._syncCoordinator.registerStore('brain-memory', c['brain-memory']);
    if (c['memory-store']) this._syncCoordinator.registerStore('memory-store', c['memory-store'], { priority: 2 });
    if (c['llm-wiki']) this._syncCoordinator.registerStore('llm-wiki', c['llm-wiki'], { priority: 3 });
    if (c['dream-engine']) this._syncCoordinator.registerStore('dream-engine', c['dream-engine']);
  }

  _wireDreamEngine() {
    const dreamEngine = this._components['dream-engine'];
    if (!dreamEngine) return;
    const c = this._components;
    const brainMemory = c['brain-memory'];
    const memoryStore = c['memory-store'];
    if (brainMemory && typeof dreamEngine.attachBrainMemory === 'function') {
      dreamEngine.attachBrainMemory(brainMemory);
    }
    if (memoryStore && typeof dreamEngine.attachMemoryStore === 'function') {
      dreamEngine.attachMemoryStore(memoryStore);
    }
    if (this._components['thought-store'] && typeof dreamEngine.attachThoughtMemoryStore === 'function') {
      dreamEngine.attachThoughtMemoryStore(this._components['thought-store']);
    }
    if (this._components['embedding-service'] && typeof dreamEngine.attachEmbeddingService === 'function') {
      dreamEngine.attachEmbeddingService(this._components['embedding-service']);
    }
    if (this._components['sqlite-store'] && typeof dreamEngine.attachSqliteStore === 'function') {
      dreamEngine.attachSqliteStore(this._components['sqlite-store']);
    }
  }

  _wireProviders() {
    const providerConfig = this._config.providers ?? {};
    if (!providerConfig.enabled) return;
    const adapters = providerConfig.adapters ?? {};
    for (const [name, adapterConfig] of Object.entries(adapters)) {
      try {
        const AdapterClass = this._resolveAdapterClass(adapterConfig.type);
        if (AdapterClass) {
          const adapter = new AdapterClass(adapterConfig);
          this.attachExternalProvider(name, adapter, adapterConfig);
        }
      } catch (err) {
        debug('MemoryPipeline', '_wireProviders', name, err && err.message ? err.message : String(err));
      }
    }
  }

  _resolveAdapterClass(type) {
    if (!type || typeof type !== 'string') return null;
    const typeLower = type.toLowerCase();
    if (typeLower === 'mem0') return ProviderModule.Mem0Adapter;
    if (typeLower === 'honcho') return ProviderModule.HonchoAdapter;
    if (typeLower === 'hindsight') return ProviderModule.HindsightAdapter;
    return null;
  }

  /**
   * 附加外部记忆提供商（mem0/Honcho/Hindsight），自动注册到Recaller和SyncCoordinator。
   * @param {string} name - 提供商名称
   * @param {Object} provider - 提供商适配器实例（需实现recall/write/query/disconnect等方法）
   * @param {Object} [options] - 提供商选项
   * @param {number} [options.priority=0] - 提供商优先级
   * @returns {MemoryPipeline} this（支持链式调用）
   */
  attachExternalProvider(name, provider, options) {
    if (!name || typeof name !== 'string') return this;
    if (!provider || typeof provider !== 'object') return this;
    this._providerRegistry.register(name, provider, options);
    this._recaller.attachSource('provider:' + name, provider, {
      priority: (options && options.priority) ?? 0,
      recallFn: function(inst, query, opts) {
        if (typeof inst.recall === 'function') return inst.recall(query, opts);
        return [];
      },
    });
    this._syncCoordinator.registerStore('provider:' + name, provider, {
      priority: (options && options.priority) ?? 0,
      syncFn: function(inst, filter) {
        if (typeof inst.query === 'function') return inst.query(filter);
        return [];
      },
      writeFn: function(entry) {
        if (typeof provider.write === 'function') return provider.write(entry);
        return null;
      },
      queryFn: function(key) {
        if (typeof provider.query === 'function') return provider.query({ key: key });
        return null;
      },
    });
    this._attachedProviders.set(name, provider);
    try {
      if (typeof provider.connect === 'function') {
        provider.connect().catch(e => debug('MemoryPipeline', 'providerConnect', e && e.message ? e.message : String(e)));
      }
    } catch (_e) {
      debug('MemoryPipeline', 'providerConnect', _e && _e.message ? _e.message : String(_e));
    }
    this._healthChecker.start();
    this.emit('provider-attached', { name });
    return this;
  }

  /**
   * 分离外部记忆提供商，自动从Recaller和SyncCoordinator注销。
   * @param {string} name - 提供商名称
   * @returns {MemoryPipeline} this（支持链式调用）
   */
  detachExternalProvider(name) {
    if (!name || typeof name !== 'string') return this;
    const provider = this._attachedProviders.get(name);
    if (!provider) return this;
    this._recaller.disableSource('provider:' + name);
    this._syncCoordinator.unregisterStore('provider:' + name);
    this._providerRegistry.unregister(name);
    this._attachedProviders.delete(name);
    try {
      if (typeof provider.disconnect === 'function') {
        Promise.resolve(provider.disconnect()).catch(function(err) {
          debug('MemoryPipeline', 'detachExternalProvider_disconnect', name, err && err.message ? err.message : String(err));
        });
      }
    } catch (_e) {
      debug('MemoryPipeline', 'detachExternalProvider_disconnect_sync', name, _e && _e.message ? _e.message : String(_e));
    }
    if (this._attachedProviders.size === 0) {
      this._healthChecker.stop();
    }
    this.emit('provider-detached', { name });
    return this;
  }

  /**
   * Recall memories from the pipeline using the configured recaller.
   * @param {string} query - Query text for memory retrieval
   * @param {Object} [options] - Recall options passed to the recaller
   * @returns {Promise<Object>} Recall results containing results array, sources map, and meta info
   * @throws {Error} When called after the pipeline has been shut down
   */
  async recall(query, options) {
    this.guardShutdown();
    if (!this._initialized || !this._config.enableRecall) {
      return { results: [], sources: {}, meta: { notInitialized: true } };
    }
    this._stats.recallQueries++;

    // AffectiveRouter: 分类查询的认知状态
    const queryState = this._affectiveRouter.classifyState(query);

    const rawResults = await this._recaller.recall(query, options);

    // AffectiveRouter: 对检索结果进行情感重排序
    if (rawResults && rawResults.results && rawResults.results.length > 0) {
      rawResults.results = this._affectiveRouter.rerank(rawResults.results, queryState);

      // MutableRAG: 标记检索到的记忆为不稳定状态
      for (const result of rawResults.results) {
        if (result && result.key) {
          this._mutableRAG.markLabile(result, { query, queryState });
        }
      }
    }

    // SpreadingActivation: 如果有知识图谱，执行扩散激活
    const knowledgeGraph = this._components['knowledge-graph'];
    if (knowledgeGraph && rawResults && rawResults.results) {
      const seedKeys = rawResults.results
        .filter(r => r && r.key)
        .slice(0, 5)
        .map(r => r.key);
      if (seedKeys.length > 0) {
        const activationResults = this._spreadingActivation.activate(seedKeys, knowledgeGraph);
        if (activationResults.length > 0) {
          rawResults.meta = rawResults.meta ?? {};
          rawResults.meta.spreadingActivation = activationResults;
        }
      }
    }

    return rawResults;
  }

  /**
   * 评估内容是否值得写入长期记忆（SurprisalGate 预测编码过滤）
   * @param {string} content - 待写入的记忆内容
   * @param {object} [metadata] - 记忆元数据
   * @returns {{allowed: boolean, surprisal: number, reason: string}}
   */
  evaluateForStore(content, metadata) {
    this.guardShutdown();
    return this._surprisalGate.evaluate(content, metadata);
  }

  /**
   * 执行记忆重整合（MutableRAG 过期事实更新）
   * @param {string} newContent - 新的内容/上下文
   * @param {Function} updateFn - 更新函数 (key, newEntry) => void
   * @returns {{reconsolidated: number, superseded: number, stable: number}}
   */
  reconsolidate(newContent, updateFn) {
    this.guardShutdown();
    return this._mutableRAG.reconsolidate(newContent, updateFn);
  }

  /**
   * 获取 Mnemosyne 增强模块的统计信息
   * @returns {object}
   */
  getMnemosyneStats() {
    return {
      surprisalGate: this._surprisalGate.getStats(),
      mutableRAG: this._mutableRAG.getStats(),
      affectiveRouter: this._affectiveRouter.getStats(),
      spreadingActivation: this._spreadingActivation.getStats(),
    };
  }

  /**
   * 同步所有已注册存储的数据（委托给SyncCoordinator）。
   * @param {Object} [options] - 同步选项
   * @returns {Promise<{synced: number, conflicts: number, errors: number}>} 同步结果统计
   */
  async syncAll(options) {
    this.guardShutdown();
    if (!this._initialized || !this._config.enableSync) {
      return { synced: 0, conflicts: 0, errors: 0 };
    }
    this._stats.syncOperations++;
    try {
      return await this._syncCoordinator.syncAll(options);
    } catch (err) {
      debug('MemoryPipeline', 'sync-error', err && err.message ? err.message : String(err));
      return { synced: 0, errors: [err && err.message ? err.message : String(err)], degraded: true };
    }
  }

  onPhaseChange(phaseInfo) {
    if (!this._initialized) return;
    this._stats.prefetchTriggers++;
    this._prefetcher.onPhaseChange(phaseInfo);
  }

  onIntentParsed(intentResult) {
    if (!this._initialized) return;
    this._prefetcher.onIntentParsed(intentResult);
  }

  onTaskAssigned(taskInfo) {
    if (!this._initialized) return;
    this._prefetcher.onTaskAssigned(taskInfo);
  }

  onUserInteraction(interactionInfo) {
    if (!this._initialized) return;
    this._prefetcher.onUserInteraction(interactionInfo);
  }

  getPrefetched(query) {
    return this._prefetcher.getPrefetched(query);
  }

  getPrefetchedForContext(context) {
    return this._prefetcher.getPrefetchedForContext(context);
  }

  enqueueSync(syncItem) {
    return this._syncCoordinator.enqueueSync(syncItem);
  }

  /**
   * 获取统计信息（含各子组件统计）。
   * @returns {{recallQueries: number, syncOperations: number, prefetchTriggers: number, prefetcher: Object, recaller: Object, syncCoordinator: Object, providers: Object, initialized: boolean, components: Array<string>}} 统计数据
   */
  getStats() {
    return {
      recallQueries: this._stats.recallQueries,
      syncOperations: this._stats.syncOperations,
      prefetchTriggers: this._stats.prefetchTriggers,
      prefetcher: this._prefetcher.getStats(),
      recaller: this._recaller.getStats(),
      syncCoordinator: this._syncCoordinator.getStats(),
      providers: this._providerRegistry.getStats(),
      initialized: this._initialized,
      components: Object.keys(this._components),
    };
  }

  isHealthy() {
    if (!this._initialized) return false;
    try {
      if (!this._prefetcher.isHealthy()) return false;
    } catch (_e) { debug('MemoryPipeline', 'prefetcherHealth', _e && _e.message ? _e.message : String(_e)); return false; }
    try {
      if (!this._recaller.isHealthy()) return false;
    } catch (_e) { debug('MemoryPipeline', 'recallerHealth', _e && _e.message ? _e.message : String(_e)); return false; }
    try {
      if (!this._syncCoordinator.isHealthy()) return false;
    } catch (_e) { debug('MemoryPipeline', 'syncCoordinatorHealth', _e && _e.message ? _e.message : String(_e)); return false; }
    return true;
  }

  _onShutdown() {
    debug('MemoryPipeline', '_onShutdown', 'shutting down pipeline');
    safeCall(() => {
      let _r;
      if (typeof this._healthChecker.shutdown === 'function') _r = this._healthChecker.shutdown();
      else if (typeof this._healthChecker._onShutdown === 'function') this._healthChecker._onShutdown();
      if (_r && typeof _r.catch === 'function') _r.catch(function(_e) { /* ignore shutdown error */ });
    }, 'MemoryPipeline', 'shutdown-healthChecker');
    safeCall(() => {
      this._providerRegistry.disconnectAll().catch(function(_e) { debug('MemoryPipeline', 'disconnectAll-error', _e?.message || _e); });
    }, 'MemoryPipeline', 'shutdown-providers');
    safeCall(() => {
      let _r;
      if (typeof this._providerRegistry.shutdown === 'function') _r = this._providerRegistry.shutdown();
      else if (typeof this._providerRegistry._onShutdown === 'function') this._providerRegistry._onShutdown();
      if (_r && typeof _r.catch === 'function') _r.catch(function(_e) { /* ignore shutdown error */ });
    }, 'MemoryPipeline', 'shutdown-providerRegistry');
    safeCall(() => {
      let _r;
      if (typeof this._prefetcher.shutdown === 'function') _r = this._prefetcher.shutdown();
      else if (typeof this._prefetcher._onShutdown === 'function') this._prefetcher._onShutdown();
      if (_r && typeof _r.catch === 'function') _r.catch(function(_e) { /* ignore shutdown error */ });
    }, 'MemoryPipeline', 'shutdown-prefetcher');
    safeCall(() => {
      let _r;
      if (typeof this._recaller.shutdown === 'function') _r = this._recaller.shutdown();
      else if (typeof this._recaller._onShutdown === 'function') this._recaller._onShutdown();
      if (_r && typeof _r.catch === 'function') _r.catch(function(_e) { /* ignore shutdown error */ });
    }, 'MemoryPipeline', 'shutdown-recaller');
    safeCall(() => {
      let _r;
      if (typeof this._syncCoordinator.shutdown === 'function') _r = this._syncCoordinator.shutdown();
      else if (typeof this._syncCoordinator._onShutdown === 'function') this._syncCoordinator._onShutdown();
      if (_r && typeof _r.catch === 'function') _r.catch(function(_e) { /* ignore shutdown error */ });
    }, 'MemoryPipeline', 'shutdown-syncCoordinator');
    // Mnemosyne-enhanced modules shutdown
    safeCall(() => {
      if (typeof this._surprisalGate._onShutdown === 'function') this._surprisalGate._onShutdown();
    }, 'MemoryPipeline', 'shutdown-surprisalGate');
    safeCall(() => {
      if (typeof this._mutableRAG._onShutdown === 'function') this._mutableRAG._onShutdown();
    }, 'MemoryPipeline', 'shutdown-mutableRAG');
    safeCall(() => {
      if (typeof this._affectiveRouter._onShutdown === 'function') this._affectiveRouter._onShutdown();
    }, 'MemoryPipeline', 'shutdown-affectiveRouter');
    safeCall(() => {
      if (typeof this._spreadingActivation._onShutdown === 'function') this._spreadingActivation._onShutdown();
    }, 'MemoryPipeline', 'shutdown-spreadingActivation');
    this._attachedProviders.clear();
    this._components = {};
    this._initialized = false;
    this._stats = { recallQueries: 0, syncOperations: 0, prefetchTriggers: 0 };
    this.removeAllListeners();
  }
}

MemoryPipeline.PIPELINE_STAGES = PIPELINE_STAGES;
MemoryPipeline.DEFAULT_PIPELINE_CONFIG = DEFAULT_PIPELINE_CONFIG;

module.exports = withShutdown(MemoryPipeline);
