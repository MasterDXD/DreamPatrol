'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const BrainMemoryModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'brain-memory'));
const BrainMemory = BrainMemoryModule.BrainMemory || BrainMemoryModule;

describe('BrainMemory - Constructor', () => {
  it('should create instance with default config', () => {
    const bm = new BrainMemory();
    assert.ok(bm);
    assert.strictEqual(bm._config.maxMemories, 2000);
    assert.strictEqual(bm._config.defaultTTL, 86400000);
    assert.strictEqual(bm._config.similarityThreshold, 0.8);
  });

  it('should merge custom options with defaults', () => {
    const bm = new BrainMemory({ maxMemories: 100, defaultTTL: 5000 });
    assert.strictEqual(bm._config.maxMemories, 100);
    assert.strictEqual(bm._config.defaultTTL, 5000);
    assert.strictEqual(bm._config.retrievalTimeout, 100);
  });

  it('should initialize empty data structures', () => {
    const bm = new BrainMemory();
    assert.strictEqual(bm._memories.size, 0);
    assert.strictEqual(bm._embeddings.size, 0);
    assert.strictEqual(bm._hitCount, 0);
    assert.strictEqual(bm._missCount, 0);
  });

  it('should expose DEFAULT_CONFIG', () => {
    assert.ok(BrainMemoryModule.DEFAULT_CONFIG);
    assert.strictEqual(BrainMemoryModule.DEFAULT_CONFIG.maxMemories, 2000);
  });
});

describe('BrainMemory - store', () => {
  it('should store a memory record', () => {
    const bm = new BrainMemory();
    const record = bm.store('key1', 'content1');
    assert.ok(record);
    assert.strictEqual(record.key, 'key1');
    assert.strictEqual(record.content, 'content1');
    assert.strictEqual(bm._memories.size, 1);
  });

  it('should store with custom metadata', () => {
    const bm = new BrainMemory();
    const record = bm.store('key1', 'content1', { category: 'test', tags: ['a', 'b'], confidence: 0.9 });
    assert.strictEqual(record.metadata.category, 'test');
    assert.deepStrictEqual(record.metadata.tags, ['a', 'b']);
    assert.strictEqual(record.metadata.confidence, 0.9);
  });

  it('should return null for invalid key', () => {
    const bm = new BrainMemory();
    assert.strictEqual(bm.store('', 'content'), null);
    assert.strictEqual(bm.store(null, 'content'), null);
    assert.strictEqual(bm.store(123, 'content'), null);
  });

  it('should return null for invalid content', () => {
    const bm = new BrainMemory();
    assert.strictEqual(bm.store('key1', ''), null);
    assert.strictEqual(bm.store('key1', null), null);
  });

  it('should update existing key', () => {
    const bm = new BrainMemory();
    bm.store('key1', 'old content');
    const record = bm.store('key1', 'new content');
    assert.strictEqual(record.content, 'new content');
    assert.strictEqual(bm._memories.size, 1);
  });

  it('should evict oldest when maxMemories reached', () => {
    const bm = new BrainMemory({ maxMemories: 2 });
    bm.store('key1', 'content1');
    bm.store('key2', 'content2');
    bm.store('key3', 'content3');
    assert.strictEqual(bm._memories.size, 2);
    assert.strictEqual(bm._memories.has('key3'), true);
  });

  it('should emit memory-stored event', () => {
    const bm = new BrainMemory();
    let emitted = false;
    bm.on('memory-stored', () => { emitted = true; });
    bm.store('key1', 'content1');
    assert.strictEqual(emitted, true);
  });
});

describe('BrainMemory - retrieve', () => {
  it('should retrieve stored memories by keyword', () => {
    const bm = new BrainMemory();
    bm.store('key1', 'database connection pooling best practice');
    bm.store('key2', 'unrelated weather forecast');
    const results = bm.retrieve('database', { mode: 'keyword' });
    assert.ok(results.length > 0);
    assert.strictEqual(results[0].key, 'key1');
  });

  it('should return empty for empty query', () => {
    const bm = new BrainMemory();
    bm.store('key1', 'content1');
    assert.deepStrictEqual(bm.retrieve(''), []);
    assert.deepStrictEqual(bm.retrieve(null), []);
  });

  it('should respect topK option', () => {
    const bm = new BrainMemory();
    bm.store('k1', 'test content alpha');
    bm.store('k2', 'test content beta');
    bm.store('k3', 'test content gamma');
    const results = bm.retrieve('test', { mode: 'keyword', topK: 2 });
    assert.ok(results.length <= 2);
  });

  it('should respect minConfidence option', () => {
    const bm = new BrainMemory();
    bm.store('k1', 'test content', { confidence: 0.3 });
    const results = bm.retrieve('test', { mode: 'keyword', minConfidence: 0.8 });
    assert.strictEqual(results.length, 0);
  });

  it('should track hit and miss counts', () => {
    const bm = new BrainMemory();
    bm.store('k1', 'database connection');
    bm.retrieve('database', { mode: 'keyword' });
    bm.retrieve('nonexistent', { mode: 'keyword' });
    assert.strictEqual(bm._hitCount, 1);
    assert.strictEqual(bm._missCount, 1);
  });

  it('should emit memory-retrieved event', () => {
    const bm = new BrainMemory();
    bm.store('k1', 'test content');
    let emitted = false;
    bm.on('memory-retrieved', () => { emitted = true; });
    bm.retrieve('test');
    assert.strictEqual(emitted, true);
  });
});

describe('BrainMemory - invalidate', () => {
  it('should invalidate memories by key prefix', () => {
    const bm = new BrainMemory();
    bm.store('cache/a', 'content a');
    bm.store('cache/b', 'content b');
    bm.store('other/c', 'content c');
    const count = bm.invalidate('cache/');
    assert.strictEqual(count, 2);
    assert.strictEqual(bm._memories.get('cache/a').stale, true);
    assert.strictEqual(bm._memories.get('other/c').stale, false);
  });

  it('should invalidate memories by tag', () => {
    const bm = new BrainMemory();
    bm.store('k1', 'content1', { tags: ['temp'] });
    bm.store('k2', 'content2', { tags: ['permanent'] });
    const count = bm.invalidate('temp');
    assert.strictEqual(count, 1);
    assert.strictEqual(bm._memories.get('k1').stale, true);
  });

  it('should return 0 for null pattern', () => {
    const bm = new BrainMemory();
    bm.store('k1', 'content1');
    assert.strictEqual(bm.invalidate(null), 0);
  });
});

describe('BrainMemory - consolidate', () => {
  it('should remove stale and expired memories', () => {
    const bm = new BrainMemory({ defaultTTL: -1 });
    bm.store('k1', 'content1');
    const result = bm.consolidate();
    assert.ok(result.expired >= 0);
  });

  it('should emit memory-consolidated event', () => {
    const bm = new BrainMemory();
    bm.store('k1', 'content1');
    let emitted = false;
    bm.on('memory-consolidated', () => { emitted = true; });
    bm.consolidate();
    assert.strictEqual(emitted, true);
  });
});

describe('BrainMemory - getHealthStatus', () => {
  it('should return unhealthy when no memories', () => {
    const bm = new BrainMemory();
    const health = bm.getHealthStatus();
    assert.ok(['healthy', 'degraded', 'unhealthy'].includes(health.status));
    assert.strictEqual(health.memoryCount, 0);
  });
});

describe('BrainMemory - getStats', () => {
  it('should return stats object', () => {
    const bm = new BrainMemory();
    bm.store('k1', 'content1');
    const stats = bm.getStats();
    assert.strictEqual(stats.totalMemories, 1);
    assert.strictEqual(stats.activeMemories, 1);
    assert.strictEqual(stats.staleMemories, 0);
    assert.ok(stats.categories);
    assert.ok(stats.config);
  });

  it('should reflect retrieval stats', () => {
    const bm = new BrainMemory();
    bm.store('k1', 'test content');
    bm.retrieve('test', { mode: 'keyword' });
    const stats = bm.getStats();
    assert.strictEqual(stats.totalRetrievals, 1);
    assert.ok(stats.hitRate > 0);
  });
});

describe('BrainMemory - attach methods', () => {
  it('should attach sqlite store', () => {
    const bm = new BrainMemory();
    const mock = {};
    bm.attachSqliteStore(mock);
    assert.strictEqual(bm._sqliteStore, mock);
  });

  it('should attach embedding service', () => {
    const bm = new BrainMemory();
    const mock = {};
    bm.attachEmbeddingService(mock);
    assert.strictEqual(bm._embeddingService, mock);
  });

  it('should attach event bus', () => {
    const bm = new BrainMemory();
    const mock = {};
    bm.attachEventBus(mock);
    assert.strictEqual(bm._eventBus, mock);
  });
});

describe('BrainMemory - shutdown', () => {
  it('should clear all data on shutdown', () => {
    const bm = new BrainMemory();
    bm.store('k1', 'content1');
    bm.shutdown();
    assert.strictEqual(bm._memories.size, 0);
    assert.strictEqual(bm._embeddings.size, 0);
    assert.strictEqual(bm._shutDown, true);
  });

  it('should prevent operations after shutdown', () => {
    const bm = new BrainMemory();
    bm.shutdown();
    assert.throws(() => bm.store('k1', 'content1'), /shut down/i);
  });

  it('should clear consolidation timer on shutdown', () => {
    const bm = new BrainMemory({ consolidationInterval: 1000 });
    bm.store('k1', 'content1');
    assert.ok(bm._consolidationTimer);
    bm.shutdown();
    assert.strictEqual(bm._consolidationTimer, null);
  });
});
