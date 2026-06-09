'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const MemoryPipelineModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'memory-pipeline'));
const MemoryPipeline = MemoryPipelineModule.MemoryPipeline || MemoryPipelineModule;

const mockBrainMemory = {
  retrieve: (query, _opts) => [{ key: query, content: 'test', confidence: 0.8 }],
  store: (key, content, metadata) => ({ key, content, metadata }),
};

const mockMemoryStore = {
  queryKnowledge: (_filter) => [],
  addKnowledge: (entry) => ({ id: 'test', ...entry }),
};

const mockDreamEngine = {
  getRelevantNotes: (_context, _opts) => [],
  getNotes: (_category, _minConfidence) => [],
  attachBrainMemory: function() {},
  attachMemoryStore: function() {},
};

describe('MemoryPipeline - Constructor', () => {
  it('should create instance with default config', () => {
    const mp = new MemoryPipeline();
    assert.ok(mp);
    assert.strictEqual(mp._config.enablePrefetch, true);
    assert.strictEqual(mp._config.enableRecall, true);
    assert.strictEqual(mp._config.enableSync, true);
    assert.deepStrictEqual(mp._config.prefetchConfig, {});
    assert.deepStrictEqual(mp._config.recallConfig, {});
    assert.deepStrictEqual(mp._config.syncConfig, {});
  });

  it('should merge custom options with defaults', () => {
    const mp = new MemoryPipeline({ enablePrefetch: false, prefetchConfig: { maxPrefetchedEntries: 100 } });
    assert.strictEqual(mp._config.enablePrefetch, false);
    assert.strictEqual(mp._config.enableRecall, true);
    assert.deepStrictEqual(mp._config.prefetchConfig, { maxPrefetchedEntries: 100 });
  });

  it('should create internal components', () => {
    const mp = new MemoryPipeline();
    assert.ok(mp._prefetcher);
    assert.ok(mp._recaller);
    assert.ok(mp._syncCoordinator);
  });

  it('should expose PIPELINE_STAGES and DEFAULT_PIPELINE_CONFIG', () => {
    assert.ok(MemoryPipelineModule.PIPELINE_STAGES);
    assert.strictEqual(MemoryPipelineModule.PIPELINE_STAGES.RECALL, 'recall');
    assert.strictEqual(MemoryPipelineModule.PIPELINE_STAGES.SYNC, 'sync');
    assert.strictEqual(MemoryPipelineModule.PIPELINE_STAGES.PREFETCH, 'prefetch');
    assert.ok(MemoryPipelineModule.DEFAULT_PIPELINE_CONFIG);
    assert.strictEqual(MemoryPipelineModule.DEFAULT_PIPELINE_CONFIG.enablePrefetch, true);
    assert.strictEqual(MemoryPipelineModule.DEFAULT_PIPELINE_CONFIG.enableRecall, true);
    assert.strictEqual(MemoryPipelineModule.DEFAULT_PIPELINE_CONFIG.enableSync, true);
  });
});

describe('MemoryPipeline - attachComponent', () => {
  it('should attach a component', () => {
    const mp = new MemoryPipeline();
    mp.attachComponent('brain-memory', mockBrainMemory);
    assert.strictEqual(mp._components['brain-memory'], mockBrainMemory);
  });

  it('should return this for chaining', () => {
    const mp = new MemoryPipeline();
    const result = mp.attachComponent('brain-memory', mockBrainMemory);
    assert.strictEqual(result, mp);
  });

  it('should ignore invalid name', () => {
    const mp = new MemoryPipeline();
    mp.attachComponent('', mockBrainMemory);
    mp.attachComponent(null, mockBrainMemory);
    mp.attachComponent(123, mockBrainMemory);
    assert.deepStrictEqual(mp._components, {});
  });

  it('should ignore invalid instance', () => {
    const mp = new MemoryPipeline();
    mp.attachComponent('brain-memory', null);
    mp.attachComponent('brain-memory', 'string');
    mp.attachComponent('brain-memory', 42);
    assert.deepStrictEqual(mp._components, {});
  });
});

describe('MemoryPipeline - initialize', () => {
  it('should initialize and wire components', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.attachComponent('memory-store', mockMemoryStore);
    mp.initialize();
    assert.strictEqual(mp._initialized, true);
    assert.strictEqual(mp._prefetcher._brainMemory, mockBrainMemory);
    assert.strictEqual(mp._prefetcher._memoryStore, mockMemoryStore);
  });

  it('should not initialize twice', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.initialize();
    assert.strictEqual(mp._initialized, true);
    const result = mp.initialize();
    assert.strictEqual(result, mp);
  });

  it('should emit pipeline-initialized event', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    let emitted = false;
    mp.on('pipeline-initialized', () => { emitted = true; });
    mp.initialize();
    assert.strictEqual(emitted, true);
  });

  it('should wire prefetcher with available components', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.attachComponent('memory-store', mockMemoryStore);
    mp.attachComponent('dream-engine', mockDreamEngine);
    mp.initialize();
    assert.strictEqual(mp._prefetcher._brainMemory, mockBrainMemory);
    assert.strictEqual(mp._prefetcher._memoryStore, mockMemoryStore);
    assert.strictEqual(mp._prefetcher._dreamEngine, mockDreamEngine);
  });

  it('should wire recaller with available components', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.attachComponent('memory-store', mockMemoryStore);
    mp.attachComponent('dream-engine', mockDreamEngine);
    mp.initialize();
    assert.ok(mp._recaller._sources.has('brain-memory'));
    assert.ok(mp._recaller._sources.has('memory-store'));
    assert.ok(mp._recaller._sources.has('dream-engine'));
    assert.ok(mp._recaller._sources.has('prefetcher'));
  });

  it('should wire sync coordinator with available components', () => {
    const mp = new MemoryPipeline({ syncConfig: { enableAutoSync: false } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.attachComponent('memory-store', mockMemoryStore);
    mp.attachComponent('dream-engine', mockDreamEngine);
    mp.initialize();
    assert.ok(mp._syncCoordinator._stores.has('brain-memory'));
    assert.ok(mp._syncCoordinator._stores.has('memory-store'));
    assert.ok(mp._syncCoordinator._stores.has('dream-engine'));
  });

  it('should wire dream engine backflow', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    const de = {
      getRelevantNotes: () => [],
      getNotes: () => [],
      attachBrainMemory: function(bm) { this._brainMemory = bm; },
      attachMemoryStore: function(ms) { this._memoryStore = ms; },
    };
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.attachComponent('memory-store', mockMemoryStore);
    mp.attachComponent('dream-engine', de);
    mp.initialize();
    assert.strictEqual(de._brainMemory, mockBrainMemory);
    assert.strictEqual(de._memoryStore, mockMemoryStore);
  });
});

describe('MemoryPipeline - recall', () => {
  it('should return not-initialized result before init', async () => {
    const mp = new MemoryPipeline();
    const result = await mp.recall('test query');
    assert.deepStrictEqual(result.results, []);
    assert.strictEqual(result.meta.notInitialized, true);
  });

  it('should forward to recaller after init', async () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.initialize();
    const result = await mp.recall('test query');
    assert.ok(result);
    assert.ok(result.results);
  });

  it('should increment recallQueries stat', async () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.initialize();
    assert.strictEqual(mp._stats.recallQueries, 0);
    await mp.recall('test query');
    assert.strictEqual(mp._stats.recallQueries, 1);
  });
});

describe('MemoryPipeline - syncAll', () => {
  it('should return empty result before init', async () => {
    const mp = new MemoryPipeline();
    const result = await mp.syncAll();
    assert.deepStrictEqual(result, { synced: 0, conflicts: 0, errors: 0 });
  });

  it('should forward to sync coordinator after init', async () => {
    const mp = new MemoryPipeline({ syncConfig: { enableAutoSync: false } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.attachComponent('memory-store', mockMemoryStore);
    mp.initialize();
    const result = await mp.syncAll();
    assert.ok(result);
    assert.strictEqual(typeof result.synced, 'number');
  });

  it('should increment syncOperations stat', async () => {
    const mp = new MemoryPipeline({ syncConfig: { enableAutoSync: false } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.attachComponent('memory-store', mockMemoryStore);
    mp.initialize();
    assert.strictEqual(mp._stats.syncOperations, 0);
    await mp.syncAll();
    assert.strictEqual(mp._stats.syncOperations, 1);
  });
});

describe('MemoryPipeline - onPhaseChange/onIntentParsed/onTaskAssigned/onUserInteraction', () => {
  it('should forward onPhaseChange to prefetcher after init', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.initialize();
    const before = mp._prefetcher._stats.totalPrefetches;
    mp.onPhaseChange({ phase: 'architecture-design' });
    assert.strictEqual(mp._prefetcher._stats.totalPrefetches, before + 1);
    assert.strictEqual(mp._stats.prefetchTriggers, 1);
  });

  it('should not forward onPhaseChange before init', () => {
    const mp = new MemoryPipeline();
    mp.onPhaseChange({ phase: 'test' });
    assert.strictEqual(mp._stats.prefetchTriggers, 0);
  });

  it('should forward onIntentParsed to prefetcher after init', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.initialize();
    const before = mp._prefetcher._stats.totalPrefetches;
    mp.onIntentParsed({ intent: 'deploy', priorRichness: { entropy: 0.9 } });
    assert.strictEqual(mp._prefetcher._stats.totalPrefetches, before + 1);
  });

  it('should not forward onIntentParsed before init', () => {
    const mp = new MemoryPipeline();
    mp.onIntentParsed({ intent: 'test' });
    assert.strictEqual(mp._stats.prefetchTriggers, 0);
  });

  it('should forward onTaskAssigned to prefetcher after init', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.initialize();
    const before = mp._prefetcher._stats.totalPrefetches;
    mp.onTaskAssigned({ type: 'code-review', skillId: 'review' });
    assert.strictEqual(mp._prefetcher._stats.totalPrefetches, before + 1);
  });

  it('should not forward onTaskAssigned before init', () => {
    const mp = new MemoryPipeline();
    mp.onTaskAssigned({ type: 'test' });
    assert.strictEqual(mp._stats.prefetchTriggers, 0);
  });

  it('should forward onUserInteraction to prefetcher after init', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.attachComponent('user-model-manager', { getPreferences: () => ({ theme: 'dark' }) });
    mp.initialize();
    const before = mp._prefetcher._stats.totalPrefetches;
    mp.onUserInteraction({ userId: 'user-1' });
    assert.strictEqual(mp._prefetcher._stats.totalPrefetches, before + 1);
  });

  it('should not forward onUserInteraction before init', () => {
    const mp = new MemoryPipeline();
    mp.onUserInteraction({ userId: 'user-1' });
    assert.strictEqual(mp._stats.prefetchTriggers, 0);
  });
});

describe('MemoryPipeline - getPrefetched/getPrefetchedForContext', () => {
  it('should forward getPrefetched to prefetcher', () => {
    const mp = new MemoryPipeline();
    const result = mp.getPrefetched('nonexistent');
    assert.strictEqual(result, null);
  });

  it('should forward getPrefetchedForContext to prefetcher', () => {
    const mp = new MemoryPipeline();
    const result = mp.getPrefetchedForContext({ phase: 'design' });
    assert.deepStrictEqual(result, []);
  });
});

describe('MemoryPipeline - enqueueSync', () => {
  it('should forward to sync coordinator', () => {
    const mp = new MemoryPipeline({ syncConfig: { enableAutoSync: false } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.initialize();
    mp.enqueueSync({ source: 'brain-memory', data: { content: 'test' } });
    assert.strictEqual(mp._syncCoordinator._syncQueue.length, 1);
  });
});

describe('MemoryPipeline - getStats', () => {
  it('should return comprehensive stats', () => {
    const mp = new MemoryPipeline({ syncConfig: { enableAutoSync: false } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.initialize();
    const stats = mp.getStats();
    assert.strictEqual(typeof stats.recallQueries, 'number');
    assert.strictEqual(typeof stats.syncOperations, 'number');
    assert.strictEqual(typeof stats.prefetchTriggers, 'number');
    assert.ok(stats.prefetcher);
    assert.ok(stats.recaller);
    assert.ok(stats.syncCoordinator);
    assert.strictEqual(stats.initialized, true);
    assert.ok(Array.isArray(stats.components));
    assert.ok(stats.components.includes('brain-memory'));
  });
});

describe('MemoryPipeline - isHealthy', () => {
  it('should return false before init', () => {
    const mp = new MemoryPipeline();
    assert.strictEqual(mp.isHealthy(), false);
  });

  it('should return true after init with sources', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.initialize();
    assert.strictEqual(mp.isHealthy(), true);
  });
});

describe('MemoryPipeline - Shutdown', () => {
  it('should clean up all components on shutdown', () => {
    const mp = new MemoryPipeline({ prefetchConfig: { periodicIntervalMs: 60000 } });
    mp.attachComponent('brain-memory', mockBrainMemory);
    mp.attachComponent('memory-store', mockMemoryStore);
    mp.attachComponent('dream-engine', mockDreamEngine);
    mp.initialize();
    assert.strictEqual(mp._initialized, true);
    mp.shutdown();
    assert.strictEqual(mp._initialized, false);
    assert.deepStrictEqual(mp._components, {});
  });
});
