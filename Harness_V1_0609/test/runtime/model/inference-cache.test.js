'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { InferenceCache } = require(path.join(__dirname, '..', '..', '..', 'src', 'runtime', 'model', 'inference-cache'));

describe('InferenceCache', () => {
  it('should cache and retrieve results', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', { answer: 'yes' });
    const result = cache.get('prompt1');
    assert.ok(result);
    assert.deepEqual(result.result, { answer: 'yes' });
  });

  it('should return null for cache miss', () => {
    const cache = new InferenceCache();
    assert.equal(cache.get('nonexistent'), null);
  });

  it('should track hit and miss stats', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1');
    cache.get('prompt1');
    cache.get('nonexistent');
    const stats = cache.getStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.equal(stats.hitRate, 0.5);
  });

  it('should evict oldest when full', () => {
    const cache = new InferenceCache({ maxSize: 2 });
    cache.set('first', 'r1');
    cache.set('second', 'r2');
    cache.set('third', 'r3');
    assert.equal(cache.get('first'), null);
    assert.ok(cache.get('third'));
  });

  it('should expire entries by TTL', () => {
    const cache = new InferenceCache({ ttlMs: 1 });
    cache.set('prompt1', 'result1');
    return new Promise(resolve => {
      setTimeout(() => {
        assert.equal(cache.get('prompt1'), null);
        resolve();
      }, 50);
    });
  });

  it('should invalidate specific entries', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'r1');
    cache.invalidate('prompt1');
    assert.equal(cache.get('prompt1'), null);
  });

  it('should compute tokens saved', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1', null, 100);
    cache.get('prompt1');
    cache.get('prompt1');
    const stats = cache.getStats();
    assert.ok(stats.tokensSaved > 0);
  });

  it('should clear all entries', () => {
    const cache = new InferenceCache();
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    assert.equal(cache.getStats().size, 0);
  });

  it('should handle circular reference results without crashing', () => {
    const cache = new InferenceCache();
    const circular = { name: 'test' };
    circular.self = circular;
    assert.doesNotThrow(() => {
      cache.set('circular-prompt', circular);
    });
    const hit = cache.get('circular-prompt');
    assert.ok(hit);
    assert.strictEqual(hit.tokensSaved, 0);
  });

  it('should use provided tokenEstimate even with circular reference', () => {
    const cache = new InferenceCache();
    const circular = { name: 'test' };
    circular.self = circular;
    cache.set('circular-prompt', circular, null, 42);
    const hit = cache.get('circular-prompt');
    assert.ok(hit);
    assert.strictEqual(hit.tokensSaved, 42);
  });
});
