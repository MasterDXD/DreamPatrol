'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const KVCacheManagerModule = require(path.join(ROOT, 'src', 'runtime', 'model', 'kv-cache-manager'));
const KVCacheManager = KVCacheManagerModule.KVCacheManager || KVCacheManagerModule;
const TriAttentionModule = require(path.join(ROOT, 'src', 'runtime', 'model', 'tri-attention'));
const TriAttention = TriAttentionModule.TriAttention || TriAttentionModule;

function createTA() {
  return new TriAttention();
}

describe('KVCacheManager - Constructor', () => {
  it('should create instance with default config', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.ok(mgr);
    assert.strictEqual(mgr._config.maxCacheSize, 10000);
    assert.strictEqual(mgr._config.compressionRatio, 0.1);
    assert.strictEqual(mgr._config.enableAdaptiveCompression, true);
    assert.strictEqual(mgr._config.magnitudeWeight, 0.5);
    assert.strictEqual(mgr._config.pruningBatchSize, 100);
  });

  it('should merge custom options with defaults', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta, { maxCacheSize: 500, compressionRatio: 0.2 });
    assert.strictEqual(mgr._config.maxCacheSize, 500);
    assert.strictEqual(mgr._config.compressionRatio, 0.2);
    assert.strictEqual(mgr._config.enableAdaptiveCompression, true);
  });

  it('should throw DeepeningError when triAttention is null', () => {
    assert.throws(() => new KVCacheManager(null), /triAttention is required/);
  });

  it('should throw DeepeningError when triAttention is undefined', () => {
    assert.throws(() => new KVCacheManager(undefined), /triAttention is required/);
  });

  it('should expose DEFAULT_CONFIG', () => {
    assert.ok(KVCacheManagerModule.DEFAULT_CONFIG);
    assert.strictEqual(KVCacheManagerModule.DEFAULT_CONFIG.maxCacheSize, 10000);
  });

  it('should initialize stats to defaults', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._stats.totalEntries, 0);
    assert.strictEqual(mgr._stats.prunedEntries, 0);
    assert.strictEqual(mgr._stats.avgCompressionRatio, 1);
  });
});

describe('KVCacheManager - set/get/has/delete', () => {
  it('should set and get a value', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    mgr.set('key1', 'value1');
    assert.strictEqual(mgr.get('key1'), 'value1');
  });

  it('should return null for missing key', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr.get('nonexistent'), null);
  });

  it('should return true for has with existing key', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    mgr.set('key1', 'value1');
    assert.strictEqual(mgr.has('key1'), true);
  });

  it('should return false for has with missing key', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr.has('nonexistent'), false);
  });

  it('should delete a key', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    mgr.set('key1', 'value1');
    assert.strictEqual(mgr.delete('key1'), true);
    assert.strictEqual(mgr.has('key1'), false);
  });

  it('should return false for delete of missing key', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr.delete('nonexistent'), false);
  });

  it('should return false for set with null key', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr.set(null, 'value'), false);
  });

  it('should return false for set with undefined key', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr.set(undefined, 'value'), false);
  });

  it('should store metadata', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    mgr.set('key1', 'value1', { source: 'test' });
    const entry = mgr._cache.get('key1');
    assert.deepStrictEqual(entry.metadata, { source: 'test' });
  });

  it('should use empty object as default metadata', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    mgr.set('key1', 'value1');
    const entry = mgr._cache.get('key1');
    assert.deepStrictEqual(entry.metadata, {});
  });

  it('should increment accessCount on get', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    mgr.set('key1', 'value1');
    mgr.get('key1');
    mgr.get('key1');
    const entry = mgr._cache.get('key1');
    assert.strictEqual(entry.accessCount, 2);
  });

  it('should set lastAccessedAt on get', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    mgr.set('key1', 'value1');
    const before = Date.now();
    mgr.get('key1');
    const entry = mgr._cache.get('key1');
    assert.ok(entry.lastAccessedAt >= before);
  });

  it('should increment totalEntries on each set', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    mgr.set('key1', 'value1');
    mgr.set('key2', 'value2');
    assert.strictEqual(mgr._stats.totalEntries, 2);
  });
});

describe('KVCacheManager - _computeVectorNorm', () => {
  it('should compute norm for array value', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._computeVectorNorm([3, 4]), 5);
  });

  it('should compute norm for single element array', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._computeVectorNorm([5]), 5);
  });

  it('should compute norm for object with numeric values', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    const norm = mgr._computeVectorNorm({ a: 3, b: 4 });
    assert.strictEqual(norm, 5);
  });

  it('should return 0 for null value', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._computeVectorNorm(null), 0);
  });

  it('should return 0 for undefined value', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._computeVectorNorm(undefined), 0);
  });

  it('should return 0 for string value', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._computeVectorNorm('hello'), 0);
  });

  it('should return 0 for number value', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._computeVectorNorm(42), 0);
  });

  it('should handle non-numeric array elements', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._computeVectorNorm([3, 'bad', 4]), 5);
  });

  it('should handle NaN in array', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._computeVectorNorm([3, NaN, 4]), 5);
  });

  it('should handle Infinity in array', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._computeVectorNorm([3, Infinity, 4]), 5);
  });

  it('should return 0 for empty array', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._computeVectorNorm([]), 0);
  });

  it('should return 0 for empty object', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    assert.strictEqual(mgr._computeVectorNorm({}), 0);
  });
});

describe('KVCacheManager - _prune', () => {
  it('should prune entries when cache is full', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta, { maxCacheSize: 5, compressionRatio: 0.2 });
    for (let i = 0; i < 6; i++) {
      mgr.set('key' + i, 'value' + i);
    }
    assert.ok(mgr._cache.size <= 5);
    assert.ok(mgr._stats.prunedEntries > 0);
  });

  it('should emit pruned event', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta, { maxCacheSize: 3, compressionRatio: 0.34 });
    let emitted = false;
    mgr.on('pruned', () => { emitted = true; });
    for (let i = 0; i < 5; i++) {
      mgr.set('key' + i, 'value' + i);
    }
    assert.strictEqual(emitted, true);
  });

  it('should update compression ratio stats', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta, { maxCacheSize: 3, compressionRatio: 0.34 });
    for (let i = 0; i < 5; i++) {
      mgr.set('key' + i, 'value' + i);
    }
    assert.ok(mgr._stats.avgCompressionRatio < 1);
  });

  it('should prefer keeping high-scoring entries', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta, { maxCacheSize: 5, compressionRatio: 0.2 });
    mgr.set('low', [0.1]);
    mgr.set('mid', [1]);
    mgr.set('high', [10]);
    mgr.set('veryhigh', [100]);
    mgr.set('another', [0.5]);
    mgr.set('trigger', [0.01]);
    assert.ok(mgr.has('veryhigh'));
  });

  it('should prune at least 1 entry', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta, { maxCacheSize: 2, compressionRatio: 0.1 });
    mgr.set('key1', 'val1');
    mgr.set('key2', 'val2');
    mgr.set('key3', 'val3');
    assert.ok(mgr._stats.prunedEntries >= 1);
  });

  it('should cap compressionRatios history at 100', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta, { maxCacheSize: 2, compressionRatio: 0.5 });
    for (let round = 0; round < 110; round++) {
      mgr._cache.clear();
      mgr.set('a', 'va');
      mgr.set('b', 'vb');
      mgr.set('c', 'vc');
    }
    assert.ok(mgr._stats.compressionRatios.length <= 100);
  });
});

describe('KVCacheManager - calibrateFromTriAttention', () => {
  it('should adjust magnitudeWeight based on high concentration', () => {
    const ta = createTA({ enablePreRopeScoring: true });
    const qVectors = [[1, 0], [1, 0], [1, 0]];
    const kVectors = [[0, 1], [0, 1], [0, 1]];
    ta.calibrate(qVectors, kVectors);
    const mgr = new KVCacheManager(ta, { headConcentrationThreshold: 0.5 });
    mgr.calibrateFromTriAttention();
    assert.strictEqual(mgr._config.magnitudeWeight, 0.7);
  });

  it('should adjust magnitudeWeight based on low concentration', () => {
    const ta = createTA({ enablePreRopeScoring: true });
    const qVectors = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const kVectors = [[1, 1], [-1, -1], [1, -1], [-1, 1]];
    ta.calibrate(qVectors, kVectors);
    const mgr = new KVCacheManager(ta, { headConcentrationThreshold: 0.99 });
    mgr.calibrateFromTriAttention();
    assert.strictEqual(mgr._config.magnitudeWeight, 0.3);
  });

  it('should not adjust when triAttention is not calibrated', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    const original = mgr._config.magnitudeWeight;
    mgr.calibrateFromTriAttention();
    assert.strictEqual(mgr._config.magnitudeWeight, original);
  });
});

describe('KVCacheManager - getStats', () => {
  it('should return stats object', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    const stats = mgr.getStats();
    assert.strictEqual(stats.size, 0);
    assert.strictEqual(stats.maxSize, 10000);
    assert.strictEqual(stats.totalEntries, 0);
    assert.strictEqual(stats.prunedEntries, 0);
    assert.strictEqual(stats.avgCompressionRatio, 1);
    assert.ok(stats.config);
  });

  it('should reflect set operations', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    mgr.set('key1', 'val1');
    mgr.set('key2', 'val2');
    const stats = mgr.getStats();
    assert.strictEqual(stats.size, 2);
    assert.strictEqual(stats.totalEntries, 2);
  });
});

describe('KVCacheManager - shutdown', () => {
  it('should clear cache and reset stats on shutdown', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    mgr.set('key1', 'val1');
    mgr.shutdown();
    assert.strictEqual(mgr._cache.size, 0);
    assert.strictEqual(mgr._stats.totalEntries, 0);
    assert.strictEqual(mgr._stats.prunedEntries, 0);
    assert.strictEqual(mgr._stats.avgCompressionRatio, 1);
    assert.strictEqual(mgr._shutDown, true);
  });

  it('should prevent operations after shutdown', () => {
    const ta = createTA();
    const mgr = new KVCacheManager(ta);
    mgr.shutdown();
    assert.throws(() => mgr.set('key1', 'val1'), /shut down/i);
  });
});
