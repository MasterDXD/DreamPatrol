'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const UnifiedMemoryRecallerModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'unified-memory-recaller'));
const UnifiedMemoryRecaller = UnifiedMemoryRecallerModule.UnifiedMemoryRecaller || UnifiedMemoryRecallerModule;

const mockBrainMemory = {
  retrieve: (_query, _opts) => [
    { key: 'brain-1', content: 'brain memory content', confidence: 0.9 },
  ],
};

const mockMemoryStore = {
  queryKnowledge: (_query) => [
    { id: 'mem-1', content: 'knowledge entry', confidence: 0.8 },
  ],
};

describe('UnifiedMemoryRecaller - Constructor', () => {
  it('should create instance with default config', () => {
    const recaller = new UnifiedMemoryRecaller();
    assert.ok(recaller);
    assert.strictEqual(recaller._config.maxResults, 20);
    assert.strictEqual(recaller._config.minConfidence, 0.3);
    assert.strictEqual(recaller._config.deduplicationThreshold, 0.85);
    assert.strictEqual(recaller._config.sourceTimeoutMs, 5000);
    assert.strictEqual(recaller._config.enableParallelRecall, true);
    assert.strictEqual(recaller._config.cacheMaxSize, 100);
    assert.strictEqual(recaller._config.cacheTTL, 60000);
  });

  it('should merge custom options with defaults', () => {
    const recaller = new UnifiedMemoryRecaller({ maxResults: 50, sourceTimeoutMs: 10000 });
    assert.strictEqual(recaller._config.maxResults, 50);
    assert.strictEqual(recaller._config.sourceTimeoutMs, 10000);
    assert.strictEqual(recaller._config.minConfidence, 0.3);
  });

  it('should initialize empty sources and stats', () => {
    const recaller = new UnifiedMemoryRecaller();
    assert.strictEqual(recaller._sources.size, 0);
    assert.strictEqual(recaller._stats.totalQueries, 0);
    assert.strictEqual(recaller._stats.cacheHits, 0);
    assert.strictEqual(recaller._stats.cacheMisses, 0);
    assert.strictEqual(recaller._stats.dedupedCount, 0);
    assert.deepStrictEqual(recaller._stats.sourceStats, {});
  });

  it('should expose RECALL_SOURCES and DEFAULT_RECALL_CONFIG', () => {
    assert.ok(UnifiedMemoryRecallerModule.RECALL_SOURCES);
    assert.strictEqual(UnifiedMemoryRecallerModule.RECALL_SOURCES.BRAIN_MEMORY, 'brain-memory');
    assert.strictEqual(UnifiedMemoryRecallerModule.RECALL_SOURCES.MEMORY_STORE, 'memory-store');
    assert.strictEqual(UnifiedMemoryRecallerModule.RECALL_SOURCES.THOUGHT_STORE, 'thought-store');
    assert.strictEqual(UnifiedMemoryRecallerModule.RECALL_SOURCES.LLM_WIKI, 'llm-wiki');
    assert.strictEqual(UnifiedMemoryRecallerModule.RECALL_SOURCES.DREAM_ENGINE, 'dream-engine');
    assert.strictEqual(UnifiedMemoryRecallerModule.RECALL_SOURCES.CAUSAL_STORE, 'causal-store');
    assert.strictEqual(UnifiedMemoryRecallerModule.RECALL_SOURCES.PREFETCHER, 'prefetcher');
    assert.ok(UnifiedMemoryRecallerModule.DEFAULT_RECALL_CONFIG);
    assert.strictEqual(UnifiedMemoryRecallerModule.DEFAULT_RECALL_CONFIG.maxResults, 20);
  });
});

describe('UnifiedMemoryRecaller - attachSource', () => {
  it('should attach a source with default recall function', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    assert.strictEqual(recaller._sources.size, 1);
    assert.ok(recaller._sources.has('brain-memory'));
    const source = recaller._sources.get('brain-memory');
    assert.strictEqual(source.instance, mockBrainMemory);
    assert.strictEqual(source.enabled, true);
    assert.strictEqual(source.priority, 1);
    assert.strictEqual(typeof source.recallFn, 'function');
  });

  it('should attach a source with custom recall function', () => {
    const recaller = new UnifiedMemoryRecaller();
    const customFn = () => [{ key: 'custom', content: 'custom result', confidence: 0.95 }];
    recaller.attachSource('brain-memory', mockBrainMemory, { recallFn: customFn });
    const source = recaller._sources.get('brain-memory');
    assert.strictEqual(source.recallFn, customFn);
  });

  it('should attach a source with custom priority', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory, { priority: 10 });
    const source = recaller._sources.get('brain-memory');
    assert.strictEqual(source.priority, 10);
  });

  it('should return this for chaining', () => {
    const recaller = new UnifiedMemoryRecaller();
    const result = recaller.attachSource('brain-memory', mockBrainMemory);
    assert.strictEqual(result, recaller);
  });

  it('should ignore invalid source name', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('', mockBrainMemory);
    recaller.attachSource(null, mockBrainMemory);
    recaller.attachSource(123, mockBrainMemory);
    assert.strictEqual(recaller._sources.size, 0);
  });

  it('should ignore invalid source instance', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', null);
    recaller.attachSource('brain-memory', undefined);
    recaller.attachSource('brain-memory', 'string');
    assert.strictEqual(recaller._sources.size, 0);
  });
});

describe('UnifiedMemoryRecaller - enableSource/disableSource', () => {
  it('should enable a disabled source', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    recaller.disableSource('brain-memory');
    assert.strictEqual(recaller._sources.get('brain-memory').enabled, false);
    recaller.enableSource('brain-memory');
    assert.strictEqual(recaller._sources.get('brain-memory').enabled, true);
  });

  it('should disable an enabled source', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    assert.strictEqual(recaller._sources.get('brain-memory').enabled, true);
    recaller.disableSource('brain-memory');
    assert.strictEqual(recaller._sources.get('brain-memory').enabled, false);
  });
});

describe('UnifiedMemoryRecaller - recall (async)', () => {
  it('should return empty results for invalid query', async () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    const emptyResult = await recaller.recall('');
    assert.deepStrictEqual(emptyResult.results, []);
    assert.ok(emptyResult.meta.invalidQuery);
    const nullResult = await recaller.recall(null);
    assert.deepStrictEqual(nullResult.results, []);
    assert.ok(nullResult.meta.invalidQuery);
  });

  it('should return empty results when shut down', async () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    recaller._shutDown = true;
    const result = await recaller.recall('test query');
    assert.deepStrictEqual(result.results, []);
    assert.ok(result.meta.shutDown);
  });

  it('should recall from multiple sources in parallel', async () => {
    const recaller = new UnifiedMemoryRecaller({ enableParallelRecall: true });
    recaller.attachSource('brain-memory', mockBrainMemory);
    recaller.attachSource('memory-store', mockMemoryStore);
    const result = await recaller.recall('test query');
    assert.ok(result.results.length >= 2);
    assert.ok(result.sources['brain-memory']);
    assert.ok(result.sources['memory-store']);
  });

  it('should handle source timeout gracefully', async () => {
    const recaller = new UnifiedMemoryRecaller({ sourceTimeoutMs: 50 });
    const slowSource = {
      retrieve: () => new Promise((resolve) => setTimeout(() => resolve([{ key: 'slow', content: 'slow', confidence: 0.5 }]), 500)),
    };
    recaller.attachSource('brain-memory', slowSource);
    const result = await recaller.recall('test query');
    assert.ok(result.sources['brain-memory']);
    assert.strictEqual(result.sources['brain-memory'].items.length, 0);
    assert.ok(result.sources['brain-memory'].error);
  });

  it('should deduplicate results', async () => {
    const recaller = new UnifiedMemoryRecaller();
    const duplicateSource = {
      retrieve: () => [
        { key: 'dup-1', content: 'same content', confidence: 0.8 },
        { key: 'dup-1', content: 'same content', confidence: 0.9 },
      ],
    };
    recaller.attachSource('brain-memory', duplicateSource);
    const result = await recaller.recall('test');
    const keys = result.results.map(r => r.key);
    const dupCount = keys.filter(k => k === 'dup-1').length;
    assert.strictEqual(dupCount, 1);
    assert.ok(recaller._stats.dedupedCount > 0);
  });

  it('should rank results by confidence and priority', async () => {
    const recaller = new UnifiedMemoryRecaller();
    const lowConfSource = {
      retrieve: () => [{ key: 'low', content: 'low confidence', confidence: 0.4 }],
    };
    const highConfSource = {
      retrieve: () => [{ key: 'high', content: 'high confidence', confidence: 0.95 }],
    };
    const recallFn = (inst) => inst.retrieve();
    recaller.attachSource('brain-memory', lowConfSource, { priority: 5, recallFn });
    recaller.attachSource('memory-store', highConfSource, { priority: 1, recallFn });
    const result = await recaller.recall('test');
    assert.strictEqual(result.results[0].key, 'high');
  });

  it('should respect maxResults limit', async () => {
    const recaller = new UnifiedMemoryRecaller({ maxResults: 2 });
    const manySource = {
      retrieve: () => [
        { key: 'a', content: 'a', confidence: 0.9 },
        { key: 'b', content: 'b', confidence: 0.8 },
        { key: 'c', content: 'c', confidence: 0.7 },
        { key: 'd', content: 'd', confidence: 0.6 },
      ],
    };
    recaller.attachSource('brain-memory', manySource);
    const result = await recaller.recall('test');
    assert.strictEqual(result.results.length, 2);
  });

  it('should use query cache on repeated calls', async () => {
    const recaller = new UnifiedMemoryRecaller({ cacheTTL: 60000 });
    recaller.attachSource('brain-memory', mockBrainMemory);
    const first = await recaller.recall('cache test');
    const second = await recaller.recall('cache test');
    assert.deepStrictEqual(first.results, second.results);
    assert.strictEqual(recaller._stats.cacheHits, 1);
    assert.strictEqual(recaller._stats.cacheMisses, 1);
  });

  it('should emit recall-completed event', async () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    let emitted = false;
    let eventData = null;
    recaller.on('recall-completed', (data) => {
      emitted = true;
      eventData = data;
    });
    await recaller.recall('test query');
    assert.strictEqual(emitted, true);
    assert.strictEqual(eventData.query, 'test query');
    assert.strictEqual(typeof eventData.resultCount, 'number');
    assert.strictEqual(typeof eventData.sourceCount, 'number');
  });
});

describe('UnifiedMemoryRecaller - recallSync', () => {
  it('should recall from sources synchronously', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    const result = recaller.recallSync('test query');
    assert.ok(result.results.length > 0);
    assert.ok(result.sources['brain-memory']);
    assert.strictEqual(result.meta.query, 'test query');
  });

  it('should return empty results for invalid query', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    const emptyResult = recaller.recallSync('');
    assert.deepStrictEqual(emptyResult.results, []);
    assert.ok(emptyResult.meta.invalidQuery);
    const nullResult = recaller.recallSync(null);
    assert.deepStrictEqual(nullResult.results, []);
    assert.ok(nullResult.meta.invalidQuery);
  });

  it('should handle source errors gracefully', () => {
    const recaller = new UnifiedMemoryRecaller();
    const errorSource = {
      retrieve: () => { throw new Error('source error'); },
    };
    recaller.attachSource('brain-memory', errorSource);
    const result = recaller.recallSync('test query');
    assert.ok(result.sources['brain-memory']);
    assert.strictEqual(result.sources['brain-memory'].items.length, 0);
    assert.ok(result.sources['brain-memory'].error);
  });
});

describe('UnifiedMemoryRecaller - getStats', () => {
  it('should return stats with expected fields', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    const stats = recaller.getStats();
    assert.strictEqual(typeof stats.totalQueries, 'number');
    assert.strictEqual(typeof stats.cacheHits, 'number');
    assert.strictEqual(typeof stats.cacheMisses, 'number');
    assert.strictEqual(typeof stats.cacheHitRate, 'number');
    assert.strictEqual(typeof stats.dedupedCount, 'number');
    assert.strictEqual(typeof stats.sourceCount, 'number');
    assert.ok(stats.sourceStats);
    assert.ok(stats.sourceStats['brain-memory']);
    assert.strictEqual(stats.sourceCount, 1);
  });
});

describe('UnifiedMemoryRecaller - isHealthy', () => {
  it('should return true when sources attached', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    assert.strictEqual(recaller.isHealthy(), true);
  });

  it('should return false when no sources', () => {
    const recaller = new UnifiedMemoryRecaller();
    assert.strictEqual(recaller.isHealthy(), false);
  });

  it('should return false when shut down', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    recaller._shutDown = true;
    assert.strictEqual(recaller.isHealthy(), false);
  });
});

describe('UnifiedMemoryRecaller - Shutdown', () => {
  it('should clear sources and cache on shutdown', () => {
    const recaller = new UnifiedMemoryRecaller();
    recaller.attachSource('brain-memory', mockBrainMemory);
    recaller.attachSource('memory-store', mockMemoryStore);
    assert.strictEqual(recaller._sources.size, 2);
    recaller._onShutdown();
    assert.strictEqual(recaller._sources.size, 0);
  });
});
