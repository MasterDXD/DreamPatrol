'use strict';

const { describe, it , afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ThoughtExtractor = require('../../../src/runtime/thought/thought-extractor');
const ThoughtDeduplicator = require('../../../src/runtime/thought/thought-deduplicator');
const ThoughtMemoryStore = require('../../../src/runtime/thought/thought-memory-store');
const ThoughtRetrieverCycle = require('../../../src/runtime/thought/thought-retriever-cycle');
const EmbeddingService = require('../../../src/runtime/model/embedding-service');

function _createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-thought-test-'));
}


const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { const r = obj.destroy(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}
describe('ThoughtExtractor', () => {
  afterEach(async () => { await _cleanAll(); });
  it('should extract thoughts from marked output', () => {
    const extractor = _track(new ThoughtExtractor());
    const output = [
      'Some regular text here.',
      'Insight: This is a key finding about the system.',
      'Decision: We will use the microservices pattern.',
      'Pattern: Recurring issue with memory leaks in event listeners.',
    ].join('\n');

    const result = extractor.extract(output, { taskId: 'test-1', domain: 'architecture' });
    assert.ok(result.thoughts.length >= 2);
    assert.ok(result.thoughts.some(t => t.type === 'insight'));
    assert.ok(result.thoughts.some(t => t.type === 'decision'));
    assert.ok(result.thoughts.some(t => t.type === 'pattern'));
  });

  it('should filter thoughts below confidence threshold', () => {
    const extractor = _track(new ThoughtExtractor({ confidenceThreshold: 0.8 }));
    const output = 'Insight: Short';
    const result = extractor.extract(output, { qualityScore: 0.3 });
    assert.ok(result.thoughts.length === 0 || result.thoughts.every(t => t.confidence >= 0.8));
  });

  it('should extract implicit thoughts from significant sentences', () => {
    const extractor = _track(new ThoughtExtractor({ confidenceThreshold: 0.5 }));
    const output = 'The system therefore must handle concurrent access carefully. This is crucially important for data integrity.';
    const result = extractor.extract(output, { taskId: 'test-2' });
    assert.ok(result.thoughts.length >= 1);
  });

  it('should return empty for null/empty input', () => {
    const extractor = _track(new ThoughtExtractor());
    assert.deepStrictEqual(extractor.extract(null).thoughts, []);
    assert.deepStrictEqual(extractor.extract('').thoughts, []);
    assert.deepStrictEqual(extractor.extract(123).thoughts, []);
  });

  it('should build source trace with context', () => {
    const extractor = _track(new ThoughtExtractor());
    const output = 'Decision: Use Redis for caching.';
    const result = extractor.extract(output, { taskId: 'task-1', sessionId: 'sess-1', agentId: 'analyst' });
    if (result.thoughts.length > 0) {
      assert.strictEqual(result.thoughts[0].sourceTrace.taskId, 'task-1');
      assert.strictEqual(result.thoughts[0].sourceTrace.sessionId, 'sess-1');
      assert.strictEqual(result.thoughts[0].sourceTrace.agentId, 'analyst');
    }
  });

  it('should infer tags from content', () => {
    const extractor = _track(new ThoughtExtractor());
    const output = 'Insight: Security vulnerability found in XSS handling.';
    const result = extractor.extract(output, {});
    if (result.thoughts.length > 0) {
      assert.ok(result.thoughts[0].tags.includes('security'));
    }
  });

  it('should track stats', () => {
    const extractor = _track(new ThoughtExtractor());
    extractor.extract('Decision: Use PostgreSQL.', {});
    extractor.extract('Pattern: Memory leak in closures.', {});
    const stats = extractor.getStats();
    assert.strictEqual(stats.totalExtractions, 2);
    assert.ok(stats.thoughtsExtracted >= 0);
  });
});

describe('ThoughtDeduplicator', () => {
  it('should detect duplicate thoughts', () => {
    const dedup = _track(new ThoughtDeduplicator({ similarityThreshold: 0.6 }));
    const existing = {
      id: 'tht-1', type: 'insight', content: 'Memory leaks occur in event listeners',
      confidence: 0.8, tags: ['performance'],
    };
    dedup.loadExisting([existing]);

    const incoming = [{
      id: 'tht-2', type: 'insight', content: 'Memory leaks occur in event listeners',
      confidence: 0.85, tags: ['performance'],
    }];

    const result = dedup.deduplicate(incoming);
    assert.ok(result.duplicates.length + result.merged.length >= 1);
    assert.ok(result.accepted.length === 0);
  });

  it('should accept unique thoughts', () => {
    const dedup = _track(new ThoughtDeduplicator({ similarityThreshold: 0.9 }));
    dedup.loadExisting([{
      id: 'tht-1', type: 'insight', content: 'Security vulnerability in authentication',
      confidence: 0.8, tags: ['security'],
    }]);

    const incoming = [{
      id: 'tht-2', type: 'decision', content: 'Use Redis for session caching',
      confidence: 0.9, tags: ['architecture'],
    }];

    const result = dedup.deduplicate(incoming);
    assert.strictEqual(result.accepted.length, 1);
  });

  it('should merge with higher-confidence strategy', () => {
    const dedup = _track(new ThoughtDeduplicator({
      similarityThreshold: 0.6,
      mergeStrategy: 'higher-confidence',
    }));
    dedup.loadExisting([{
      id: 'tht-1', type: 'insight', content: 'Memory leaks in event listeners are common',
      confidence: 0.7, tags: ['performance'],
    }]);

    const incoming = [{
      id: 'tht-2', type: 'insight', content: 'Memory leaks in event listeners are common',
      confidence: 0.95, tags: ['performance', 'bug'],
    }];

    const result = dedup.deduplicate(incoming);
    assert.ok(result.merged.length >= 1);
  });

  it('should handle empty input', () => {
    const dedup = _track(new ThoughtDeduplicator());
    const result = dedup.deduplicate([]);
    assert.deepStrictEqual(result.accepted, []);
    assert.deepStrictEqual(result.duplicates, []);
  });

  it('should compute similarity correctly', () => {
    const dedup = _track(new ThoughtDeduplicator());
    const sim = dedup._computeSimilarity('hello world test', 'hello world test');
    assert.strictEqual(sim, 1.0);
  });

  it('should track stats', () => {
    const dedup = _track(new ThoughtDeduplicator());
    dedup.deduplicate([{ id: '1', type: 'insight', content: 'unique thought', confidence: 0.9, tags: [] }]);
    const stats = dedup.getStats();
    assert.strictEqual(stats.totalChecks, 1);
    assert.strictEqual(stats.uniquePassed, 1);
  });
});

describe('ThoughtMemoryStore', () => {
  let tempDir;

  function _beforeEach() {
    tempDir = _createTempDir();
    const thoughtsDir = path.join(tempDir, '.harness', 'thoughts');
    fs.mkdirSync(thoughtsDir, { recursive: true });
    return tempDir;
  }

  function _afterEach() {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it('should store and retrieve thoughts', () => {
    const dir = _beforeEach();
    try {
      const store = _track(new ThoughtMemoryStore(dir));
      const thought = store.storeThought({
        id: 'tht-1', type: 'insight', content: 'Key architectural insight',
        confidence: 0.9, domain: 'architecture', tags: ['design'],
      });
      assert.ok(thought);
      assert.strictEqual(thought.content, 'Key architectural insight');

      const retrieved = store.retrieveThoughts({ type: 'insight' });
      assert.strictEqual(retrieved.length, 1);
    } finally { _afterEach(); }
  });

  it('should filter by confidence threshold', () => {
    const dir = _beforeEach();
    try {
      const store = _track(new ThoughtMemoryStore(dir, { confidenceThreshold: 0.8 }));
      const low = store.storeThought({
        id: 'tht-low', type: 'insight', content: 'Low confidence',
        confidence: 0.5, domain: 'general', tags: [],
      });
      assert.strictEqual(low, null);

      const high = store.storeThought({
        id: 'tht-high', type: 'insight', content: 'High confidence',
        confidence: 0.95, domain: 'general', tags: [],
      });
      assert.ok(high);
    } finally { _afterEach(); }
  });

  it('should trace source', () => {
    const dir = _beforeEach();
    try {
      const store = _track(new ThoughtMemoryStore(dir));
      store.storeThought({
        id: 'tht-trace', type: 'decision', content: 'Use PostgreSQL',
        confidence: 0.9, domain: 'database', tags: ['database'],
        sourceTrace: { taskId: 'task-1', agentId: 'analyst' },
      });

      const trace = store.traceSource('tht-trace');
      assert.ok(trace);
      assert.strictEqual(trace.sourceTrace.taskId, 'task-1');
    } finally { _afterEach(); }
  });

  it('should persist and restore', async () => {
    const dir = _beforeEach();
    try {
      const store1 = _track(new ThoughtMemoryStore(dir));
      store1.storeThought({
        id: 'tht-persist', type: 'insight', content: 'Persistent thought',
        confidence: 0.9, domain: 'general', tags: [],
      });
      store1.flush();

      const store2 = _track(new ThoughtMemoryStore(dir));
      await store2.ready;
      const retrieved = store2.retrieveThoughts({});
      assert.strictEqual(retrieved.length, 1);
      assert.strictEqual(retrieved[0].content, 'Persistent thought');
    } finally { _afterEach(); }
  });

  it('should return stats', () => {
    const dir = _beforeEach();
    try {
      const store = _track(new ThoughtMemoryStore(dir));
      store.storeThought({ id: '1', type: 'insight', content: 'Test', confidence: 0.9, domain: 'arch', tags: [] });
      store.storeThought({ id: '2', type: 'decision', content: 'Test2', confidence: 0.85, domain: 'arch', tags: [] });
      const stats = store.getStats();
      assert.strictEqual(stats.totalThoughts, 2);
      assert.ok(stats.avgConfidence > 0);
    } finally { _afterEach(); }
  });
});

describe('ThoughtRetrieverCycle', () => {
  it('should execute full five-step cycle', () => {
    const tempDir = _createTempDir();
    const thoughtsDir = path.join(tempDir, '.harness', 'thoughts');
    fs.mkdirSync(thoughtsDir, { recursive: true });

    try {
      const extractor = _track(new ThoughtExtractor({ confidenceThreshold: 0.5 }));
      const deduplicator = _track(new ThoughtDeduplicator({ similarityThreshold: 0.9 }));
      const memoryStore = _track(new ThoughtMemoryStore(tempDir));
      const cycle = _track(new ThoughtRetrieverCycle({
        thoughtExtractor: extractor,
        thoughtDeduplicator: deduplicator,
        thoughtMemoryStore: memoryStore,
      }));

      const output = 'Decision: Use Redis for caching. Insight: Memory leaks are common in event listeners. Pattern: Recurring issue with unclosed connections.';
      const result = cycle.execute(output, { taskId: 'cycle-test', domain: 'architecture' });

      assert.strictEqual(result.cycleComplete, true);
      assert.ok(Array.isArray(result.retrievedThoughts));
      assert.ok(Array.isArray(result.distilledThoughts));
      assert.ok(result.deduplicationResult);
      assert.ok(Array.isArray(result.storedThoughts));
      assert.strictEqual(result.storedThoughts.length, result.distilledThoughts.length - result.deduplicationResult.duplicates.length);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should retrieve relevant thoughts in subsequent cycles', () => {
    const tempDir = _createTempDir();
    const thoughtsDir = path.join(tempDir, '.harness', 'thoughts');
    fs.mkdirSync(thoughtsDir, { recursive: true });

    try {
      const extractor = _track(new ThoughtExtractor({ confidenceThreshold: 0.5 }));
      const deduplicator = _track(new ThoughtDeduplicator({ similarityThreshold: 0.9 }));
      const memoryStore = _track(new ThoughtMemoryStore(tempDir));
      const cycle = _track(new ThoughtRetrieverCycle({
        thoughtExtractor: extractor,
        thoughtDeduplicator: deduplicator,
        thoughtMemoryStore: memoryStore,
      }));

      cycle.execute('Decision: Use PostgreSQL for persistence. Insight: Security requires input validation.', { taskId: 'cycle-1', domain: 'database' });

      const result2 = cycle.execute('Pattern: Database connections should be pooled.', { taskId: 'cycle-2', domain: 'database' });
      assert.ok(result2.retrievedThoughts.length >= 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should track cycle stats', () => {
    const cycle = _track(new ThoughtRetrieverCycle({}));
    cycle.execute('Simple output', { taskId: 'stats-test' });
    const stats = cycle.getStats();
    assert.strictEqual(stats.totalCycles, 1);
  });
});

describe('EmbeddingService', () => {
  it('should generate embeddings', () => {
    const service = _track(new EmbeddingService({ dimensions: 64 }));
    const vec = service.embed('hello world');
    assert.strictEqual(vec.length, 64);
    assert.ok(vec.some(v => v !== 0));
  });

  it('should generate consistent embeddings for same text', () => {
    const service = _track(new EmbeddingService({ dimensions: 64 }));
    const v1 = service.embed('test string');
    const v2 = service.embed('test string');
    assert.deepStrictEqual(v1, v2);
  });

  it('should compute cosine similarity', () => {
    const service = _track(new EmbeddingService({ dimensions: 64 }));
    const v1 = service.embed('security vulnerability');
    const v2 = service.embed('security vulnerability');
    const sim = service.cosineSimilarity(v1, v2);
    assert.ok(sim > 0.99);
  });

  it('should find similar vectors', () => {
    const service = _track(new EmbeddingService({ dimensions: 64 }));
    const query = service.embed('database optimization');
    const candidates = [
      { vector: service.embed('database optimization'), label: 'same' },
      { vector: service.embed('completely different topic about art'), label: 'irrelevant' },
    ];
    const results = service.findSimilar(query, candidates, { topK: 2, minSimilarity: 0.5 });
    assert.ok(results.length >= 1);
    assert.ok(results[0].similarity > 0.9);
  });

  it('should handle batch embedding', () => {
    const service = _track(new EmbeddingService({ dimensions: 32 }));
    const texts = ['hello', 'world', 'test'];
    const vectors = service.embedBatch(texts);
    assert.strictEqual(vectors.length, 3);
    assert.strictEqual(vectors[0].length, 32);
  });

  it('should cache embeddings', () => {
    const service = _track(new EmbeddingService({ dimensions: 32, cacheEnabled: true }));
    service.embed('cached text');
    service.embed('cached text');
    const stats = service.getStats();
    assert.strictEqual(stats.cacheHits, 1);
  });

  it('should return empty for invalid input', () => {
    const service = _track(new EmbeddingService());
    assert.deepStrictEqual(service.embed(''), []);
    assert.deepStrictEqual(service.embed(null), []);
  });

  it('should track stats', () => {
    const service = _track(new EmbeddingService({ dimensions: 32 }));
    service.embed('test');
    const stats = service.getStats();
    assert.strictEqual(stats.totalEmbeddings, 1);
    assert.strictEqual(stats.provider, 'local');
    assert.strictEqual(stats.dimensions, 32);
  });
});
