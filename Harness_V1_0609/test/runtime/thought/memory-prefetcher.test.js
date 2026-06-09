'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const MemoryPrefetcherModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'memory-prefetcher'));
const MemoryPrefetcher = MemoryPrefetcherModule.MemoryPrefetcher || MemoryPrefetcherModule;

describe('MemoryPrefetcher - Constructor', () => {
  it('should create instance with default config', () => {
    const mp = new MemoryPrefetcher();
    assert.ok(mp);
    assert.strictEqual(mp._config.maxPrefetchedEntries, 50);
    assert.strictEqual(mp._config.prefetchTTL, 300000);
    assert.strictEqual(mp._config.entropyThreshold, 0.7);
    assert.strictEqual(mp._config.affinityThreshold, 0.6);
    assert.strictEqual(mp._config.periodicIntervalMs, 60000);
    assert.strictEqual(mp._config.maxConcurrentPrefetches, 3);
  });

  it('should merge custom options with defaults', () => {
    const mp = new MemoryPrefetcher({ maxPrefetchedEntries: 100, prefetchTTL: 5000 });
    assert.strictEqual(mp._config.maxPrefetchedEntries, 100);
    assert.strictEqual(mp._config.prefetchTTL, 5000);
    assert.strictEqual(mp._config.entropyThreshold, 0.7);
    assert.strictEqual(mp._config.affinityThreshold, 0.6);
  });

  it('should initialize empty data structures', () => {
    const mp = new MemoryPrefetcher();
    assert.strictEqual(mp._prefetched.size, 0);
    assert.strictEqual(mp._accessPatterns.length, 0);
    assert.strictEqual(mp._activePrefetches, 0);
    assert.strictEqual(mp._stats.totalPrefetches, 0);
    assert.strictEqual(mp._stats.hitCount, 0);
    assert.strictEqual(mp._stats.missCount, 0);
    assert.strictEqual(mp._stats.evictionCount, 0);
    assert.deepStrictEqual(mp._stats.bySignal, {});
  });

  it('should expose PREFETCH_SIGNALS and DEFAULT_PREFETCH_CONFIG', () => {
    assert.ok(MemoryPrefetcherModule.PREFETCH_SIGNALS);
    assert.strictEqual(MemoryPrefetcherModule.PREFETCH_SIGNALS.PHASE_CHANGE, 'phase-change');
    assert.strictEqual(MemoryPrefetcherModule.PREFETCH_SIGNALS.HIGH_ENTROPY, 'high-entropy');
    assert.strictEqual(MemoryPrefetcherModule.PREFETCH_SIGNALS.TASK_AFFINITY, 'task-affinity');
    assert.strictEqual(MemoryPrefetcherModule.PREFETCH_SIGNALS.USER_PATTERN, 'user-pattern');
    assert.strictEqual(MemoryPrefetcherModule.PREFETCH_SIGNALS.PERIODIC, 'periodic');
    assert.ok(MemoryPrefetcherModule.DEFAULT_PREFETCH_CONFIG);
    assert.strictEqual(MemoryPrefetcherModule.DEFAULT_PREFETCH_CONFIG.maxPrefetchedEntries, 50);
    assert.strictEqual(MemoryPrefetcherModule.DEFAULT_PREFETCH_CONFIG.prefetchTTL, 300000);
  });
});

describe('MemoryPrefetcher - Attach methods', () => {
  it('should attach brain memory', () => {
    const mp = new MemoryPrefetcher();
    const mock = { retrieve: () => [] };
    mp.attachBrainMemory(mock);
    assert.strictEqual(mp._brainMemory, mock);
  });

  it('should attach memory store', () => {
    const mp = new MemoryPrefetcher();
    const mock = { queryKnowledge: () => [] };
    mp.attachMemoryStore(mock);
    assert.strictEqual(mp._memoryStore, mock);
  });

  it('should attach structured intent', () => {
    const mp = new MemoryPrefetcher();
    const mock = { parse: () => {} };
    mp.attachStructuredIntent(mock);
    assert.strictEqual(mp._structuredIntent, mock);
  });

  it('should attach affinity learner', () => {
    const mp = new MemoryPrefetcher();
    const mock = { getRecommendations: () => [] };
    mp.attachAffinityLearner(mock);
    assert.strictEqual(mp._affinityLearner, mock);
  });

  it('should attach phase context injector', () => {
    const mp = new MemoryPrefetcher();
    const mock = { inject: () => {} };
    mp.attachPhaseContextInjector(mock);
    assert.strictEqual(mp._phaseContextInjector, mock);
  });

  it('should attach user model manager', () => {
    const mp = new MemoryPrefetcher();
    const mock = { getPreferences: () => {} };
    mp.attachUserModelManager(mock);
    assert.strictEqual(mp._userModelManager, mock);
  });

  it('should attach llm wiki', () => {
    const mp = new MemoryPrefetcher();
    const mock = { search: () => [] };
    mp.attachLlmWiki(mock);
    assert.strictEqual(mp._llmWiki, mock);
  });

  it('should attach dream engine', () => {
    const mp = new MemoryPrefetcher();
    const mock = { getRelevantNotes: () => [] };
    mp.attachDreamEngine(mock);
    assert.strictEqual(mp._dreamEngine, mock);
  });

  it('should return this for chaining', () => {
    const mp = new MemoryPrefetcher();
    const result = mp
      .attachBrainMemory({})
      .attachMemoryStore({})
      .attachStructuredIntent({})
      .attachAffinityLearner({})
      .attachPhaseContextInjector({})
      .attachUserModelManager({})
      .attachLlmWiki({})
      .attachDreamEngine({});
    assert.strictEqual(result, mp);
  });

  it('should ignore invalid instances', () => {
    const mp = new MemoryPrefetcher();
    mp.attachBrainMemory(null);
    mp.attachBrainMemory(undefined);
    mp.attachBrainMemory('string');
    mp.attachBrainMemory(123);
    assert.strictEqual(mp._brainMemory, null);
    mp.attachMemoryStore(null);
    assert.strictEqual(mp._memoryStore, null);
    mp.attachLlmWiki(0);
    assert.strictEqual(mp._llmWiki, null);
    mp.attachDreamEngine(false);
    assert.strictEqual(mp._dreamEngine, null);
  });
});

describe('MemoryPrefetcher - Start/Stop', () => {
  it('should start periodic prefetch timer', () => {
    const mp = new MemoryPrefetcher({ periodicIntervalMs: 60000 });
    mp.start();
    assert.ok(mp._periodicTimer);
    mp.stop();
  });

  it('should stop periodic prefetch timer', () => {
    const mp = new MemoryPrefetcher({ periodicIntervalMs: 60000 });
    mp.start();
    mp.stop();
    assert.strictEqual(mp._periodicTimer, null);
  });

  it('should not start duplicate timer', () => {
    const mp = new MemoryPrefetcher({ periodicIntervalMs: 60000 });
    mp.start();
    const firstTimer = mp._periodicTimer;
    mp.start();
    assert.strictEqual(mp._periodicTimer, firstTimer);
    mp.stop();
  });

  it('should emit started/stopped events', () => {
    const mp = new MemoryPrefetcher({ periodicIntervalMs: 60000 });
    let startedFired = false;
    let stoppedFired = false;
    mp.on('started', () => { startedFired = true; });
    mp.on('stopped', () => { stoppedFired = true; });
    mp.start();
    assert.strictEqual(startedFired, true);
    mp.stop();
    assert.strictEqual(stoppedFired, true);
  });
});

describe('MemoryPrefetcher - onPhaseChange', () => {
  it('should trigger prefetch by phase', () => {
    const mp = new MemoryPrefetcher();
    mp.attachBrainMemory({ retrieve: () => [{ key: 'test', content: 'data' }] });
    mp.onPhaseChange({ phase: 'architecture-design' });
    assert.strictEqual(mp._stats.totalPrefetches, 1);
    assert.strictEqual(mp._accessPatterns.length, 1);
  });

  it('should not prefetch when shut down', () => {
    const mp = new MemoryPrefetcher();
    mp._shutDown = true;
    const beforeTotal = mp._stats.totalPrefetches;
    const beforePatterns = mp._accessPatterns.length;
    mp.onPhaseChange({ phase: 'test' });
    assert.strictEqual(mp._stats.totalPrefetches, beforeTotal);
    assert.strictEqual(mp._accessPatterns.length, beforePatterns);
  });

  it('should respect concurrency limit', () => {
    const mp = new MemoryPrefetcher({ maxConcurrentPrefetches: 1 });
    mp.attachBrainMemory({ retrieve: () => [] });
    mp._activePrefetches = 1;
    const beforeTotal = mp._stats.totalPrefetches;
    mp.onPhaseChange({ phase: 'test' });
    assert.strictEqual(mp._stats.totalPrefetches, beforeTotal);
  });
});

describe('MemoryPrefetcher - onIntentParsed', () => {
  it('should trigger prefetch for high entropy intent', () => {
    const mp = new MemoryPrefetcher({ entropyThreshold: 0.5 });
    mp.attachBrainMemory({ retrieve: () => [] });
    mp.onIntentParsed({ intent: 'deploy', priorRichness: { entropy: 0.8 } });
    assert.strictEqual(mp._stats.totalPrefetches, 1);
    assert.strictEqual(mp._accessPatterns.length, 1);
  });

  it('should ignore low entropy intent', () => {
    const mp = new MemoryPrefetcher({ entropyThreshold: 0.7 });
    mp.attachBrainMemory({ retrieve: () => [] });
    mp.onIntentParsed({ intent: 'hello', priorRichness: { entropy: 0.3 } });
    assert.strictEqual(mp._stats.totalPrefetches, 0);
  });

  it('should ignore invalid intent result', () => {
    const mp = new MemoryPrefetcher();
    mp.onIntentParsed(null);
    mp.onIntentParsed(undefined);
    mp.onIntentParsed('string');
    mp.onIntentParsed(123);
    assert.strictEqual(mp._stats.totalPrefetches, 0);
  });
});

describe('MemoryPrefetcher - onTaskAssigned', () => {
  it('should trigger prefetch by task affinity', () => {
    const mp = new MemoryPrefetcher();
    mp.attachBrainMemory({ retrieve: () => [] });
    mp.onTaskAssigned({ type: 'code-review', skillId: 'review' });
    assert.strictEqual(mp._stats.totalPrefetches, 1);
    assert.strictEqual(mp._accessPatterns.length, 1);
  });

  it('should ignore task without type', () => {
    const mp = new MemoryPrefetcher();
    mp.attachBrainMemory({ retrieve: () => [] });
    mp.onTaskAssigned({});
    mp.onTaskAssigned({ name: 'task' });
    assert.strictEqual(mp._stats.totalPrefetches, 0);
  });
});

describe('MemoryPrefetcher - onUserInteraction', () => {
  it('should trigger prefetch by user pattern', () => {
    const mp = new MemoryPrefetcher();
    mp.attachUserModelManager({ getPreferences: () => ({ theme: 'dark' }) });
    mp.onUserInteraction({ userId: 'user-1' });
    assert.strictEqual(mp._stats.totalPrefetches, 1);
    assert.strictEqual(mp._accessPatterns.length, 1);
  });

  it('should ignore interaction without userId', () => {
    const mp = new MemoryPrefetcher();
    mp.attachUserModelManager({ getPreferences: () => ({}) });
    mp.onUserInteraction({});
    mp.onUserInteraction({ action: 'click' });
    assert.strictEqual(mp._stats.totalPrefetches, 0);
  });
});

describe('MemoryPrefetcher - getPrefetched', () => {
  it('should return prefetched data for valid query', () => {
    const mp = new MemoryPrefetcher();
    const data = { memories: [{ key: 'test' }], metadata: { phase: 'design' } };
    mp._prefetched.set('phase:design', { data, prefetchedAt: Date.now(), hitCount: 0, metadata: data.metadata });
    const result = mp.getPrefetched('phase:design');
    assert.deepStrictEqual(result, data);
    assert.strictEqual(mp._stats.hitCount, 1);
  });

  it('should return null for miss', () => {
    const mp = new MemoryPrefetcher();
    const result = mp.getPrefetched('nonexistent');
    assert.strictEqual(result, null);
    assert.strictEqual(mp._stats.missCount, 1);
  });

  it('should return null for expired entries', () => {
    const mp = new MemoryPrefetcher({ prefetchTTL: 1000 });
    const data = { memories: [] };
    mp._prefetched.set('expired:key', { data, prefetchedAt: Date.now() - 2000, hitCount: 0, metadata: {} });
    const result = mp.getPrefetched('expired:key');
    assert.strictEqual(result, null);
    assert.strictEqual(mp._stats.evictionCount, 1);
    assert.strictEqual(mp._stats.missCount, 1);
    assert.strictEqual(mp._prefetched.has('expired:key'), false);
  });

  it('should return null for invalid query', () => {
    const mp = new MemoryPrefetcher();
    assert.strictEqual(mp.getPrefetched(null), null);
    assert.strictEqual(mp.getPrefetched(''), null);
    assert.strictEqual(mp.getPrefetched(123), null);
    assert.strictEqual(mp.getPrefetched(undefined), null);
  });
});

describe('MemoryPrefetcher - getPrefetchedForContext', () => {
  it('should return matching entries for context', () => {
    const mp = new MemoryPrefetcher();
    const data1 = { memories: [], metadata: { phase: 'design' } };
    const data2 = { memories: [], metadata: { skillId: 'code-review' } };
    mp._prefetched.set('k1', { data: data1, prefetchedAt: Date.now(), hitCount: 0, metadata: { phase: 'design' } });
    mp._prefetched.set('k2', { data: data2, prefetchedAt: Date.now(), hitCount: 0, metadata: { skillId: 'code-review' } });
    const results = mp.getPrefetchedForContext({ phase: 'design' });
    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual(results[0], data1);
  });

  it('should return empty array for invalid context', () => {
    const mp = new MemoryPrefetcher();
    assert.deepStrictEqual(mp.getPrefetchedForContext(null), []);
    assert.deepStrictEqual(mp.getPrefetchedForContext(undefined), []);
    assert.deepStrictEqual(mp.getPrefetchedForContext('string'), []);
    assert.deepStrictEqual(mp.getPrefetchedForContext(123), []);
  });

  it('should skip expired entries', () => {
    const mp = new MemoryPrefetcher({ prefetchTTL: 1000 });
    const data = { memories: [] };
    mp._prefetched.set('k1', { data, prefetchedAt: Date.now() - 2000, hitCount: 0, metadata: { phase: 'design' } });
    const results = mp.getPrefetchedForContext({ phase: 'design' });
    assert.strictEqual(results.length, 0);
    assert.strictEqual(mp._stats.evictionCount, 1);
  });
});

describe('MemoryPrefetcher - getStats', () => {
  it('should return stats object with expected fields', () => {
    const mp = new MemoryPrefetcher();
    const stats = mp.getStats();
    assert.strictEqual(typeof stats.totalPrefetches, 'number');
    assert.strictEqual(typeof stats.hitCount, 'number');
    assert.strictEqual(typeof stats.missCount, 'number');
    assert.strictEqual(typeof stats.evictionCount, 'number');
    assert.strictEqual(typeof stats.hitRate, 'number');
    assert.strictEqual(typeof stats.prefetchedSize, 'number');
    assert.strictEqual(typeof stats.activePrefetches, 'number');
    assert.ok(stats.bySignal);
    assert.strictEqual(stats.totalPrefetches, 0);
    assert.strictEqual(stats.hitCount, 0);
    assert.strictEqual(stats.missCount, 0);
    assert.strictEqual(stats.evictionCount, 0);
    assert.strictEqual(stats.hitRate, 0);
    assert.strictEqual(stats.prefetchedSize, 0);
    assert.strictEqual(stats.activePrefetches, 0);
  });
});

describe('MemoryPrefetcher - isHealthy', () => {
  it('should return true when not shut down', () => {
    const mp = new MemoryPrefetcher();
    assert.strictEqual(mp.isHealthy(), true);
  });

  it('should return false when shut down', () => {
    const mp = new MemoryPrefetcher();
    mp._shutDown = true;
    assert.strictEqual(mp.isHealthy(), false);
  });
});

describe('MemoryPrefetcher - Shutdown', () => {
  it('should clean up on shutdown', () => {
    const mp = new MemoryPrefetcher();
    mp.attachBrainMemory({ retrieve: () => [] });
    mp.attachMemoryStore({ queryKnowledge: () => [] });
    mp.shutdown();
    assert.strictEqual(mp._shutDown, true);
    assert.strictEqual(mp._brainMemory, null);
    assert.strictEqual(mp._memoryStore, null);
  });

  it('should stop timer on shutdown', () => {
    const mp = new MemoryPrefetcher({ periodicIntervalMs: 60000 });
    mp.start();
    assert.ok(mp._periodicTimer);
    mp.shutdown();
    assert.strictEqual(mp._periodicTimer, null);
  });
});
