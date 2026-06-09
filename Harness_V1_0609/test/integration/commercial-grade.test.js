'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CausalConsistencyChecker = require('../../src/runtime/causal/causal-consistency-checker');
const CausalDataBus = require('../../src/runtime/causal/causal-data-bus');
const CausalMemoryStore = require('../../src/runtime/causal/causal-memory-store');
const BoundedArray = require('../../src/utils/bounded-array');

describe('CausalConsistencyChecker', () => {
  it('should create instance with default options', () => {
    const checker = new CausalConsistencyChecker();
    assert.ok(checker);
    checker.shutdown();
  });

  it('should reject null bus in attachCausalDataBus', () => {
    const checker = new CausalConsistencyChecker();
    let errorEmitted = false;
    checker.on('attach-error', () => { errorEmitted = true; });
    checker.attachCausalDataBus(null);
    assert.strictEqual(errorEmitted, true);
    checker.shutdown();
  });

  it('should accept valid bus in attachCausalDataBus', () => {
    const checker = new CausalConsistencyChecker();
    const bus = new CausalDataBus();
    checker.attachCausalDataBus(bus);
    const result = checker.checkRuntimeVsStatic();
    assert.strictEqual(result.consistent, true);
    checker.shutdown();
    bus.shutdown();
  });

  it('should reject null store in attachCausalMemoryStore', () => {
    const checker = new CausalConsistencyChecker();
    let errorEmitted = false;
    checker.on('attach-error', () => { errorEmitted = true; });
    checker.attachCausalMemoryStore(null);
    assert.strictEqual(errorEmitted, true);
    checker.shutdown();
  });

  it('should accept valid store in attachCausalMemoryStore', async () => {
    const checker = new CausalConsistencyChecker();
    const store = new CausalMemoryStore();
    const bus = new CausalDataBus();
    checker.attachCausalDataBus(bus);
    checker.attachCausalMemoryStore(store);
    const result = await checker.checkMemoryVsRuntime();
    assert.strictEqual(result.consistent, true);
    checker.shutdown();
    bus.shutdown();
    store.shutdown();
  });

  it('should return consistent true when components missing', async () => {
    const checker = new CausalConsistencyChecker();
    const result = await checker.checkFullConsistency();
    assert.strictEqual(result.consistent, true);
    checker.shutdown();
  });

  it('should detect runtime vs static issues', () => {
    const checker = new CausalConsistencyChecker();
    const bus = new CausalDataBus();
    const mockValidator = {
      getDependencyGraph: () => undefined,
      buildDependencyGraph: () => ({
        skills: [{ id: 'missing-skill', dependsOn: ['other'] }],
      }),
    };
    checker.attachCausalDataBus(bus);
    checker.attachConfigCausalValidator(mockValidator);
    const result = checker.checkRuntimeVsStatic();
    assert.strictEqual(result.consistent, false);
    assert.strictEqual(result.issues.length, 1);
    assert.strictEqual(result.issues[0].type, 'missing_runtime_interface');
    checker.shutdown();
    bus.shutdown();
  });

  it('should shutdown cleanly', () => {
    const checker = new CausalConsistencyChecker();
    checker.shutdown();
    assert.strictEqual(checker._causalDataBus, null);
    assert.strictEqual(checker._causalMemoryStore, null);
  });
});

describe('BoundedArray LRU Strategy', () => {
  it('should support LRU strategy', () => {
    const arr = new BoundedArray(3, { strategy: 'lru' });
    arr.push('a');
    arr.push('b');
    arr.push('c');
    assert.strictEqual(arr.length, 3);
    assert.deepEqual(Array.from(arr), ['a', 'b', 'c']);
  });

  it('should evict least recently used when full', () => {
    const evicted = [];
    const arr = new BoundedArray(3, {
      strategy: 'lru',
      onEvict: (item) => evicted.push(item),
    });
    arr.push('a');
    arr.push('b');
    arr.push('c');
    arr.touch(2);
    arr.touch(1);
    arr.push('d');
    assert.strictEqual(arr.length, 3);
    assert.ok(evicted.length > 0);
  });

  it('should clear access times on clear', () => {
    const arr = new BoundedArray(3, { strategy: 'lru' });
    arr.push('a');
    arr.push('b');
    arr.clear();
    assert.strictEqual(arr.length, 0);
  });

  it('should not set access times in FIFO mode', () => {
    const arr = new BoundedArray(3);
    arr.push('a');
    arr.push('b');
    arr.push('c');
    arr.push('d');
    assert.strictEqual(arr.length, 3);
    assert.deepEqual(Array.from(arr), ['b', 'c', 'd']);
  });

  it('should handle onEvict exception in LRU mode', () => {
    const arr = new BoundedArray(2, {
      strategy: 'lru',
      onEvict: () => { throw new Error('evict error'); },
    });
    arr.push('a');
    arr.push('b');
    assert.doesNotThrow(() => arr.push('c'));
    assert.strictEqual(arr.length, 2);
  });

  it('should handle onEvict exception in FIFO mode', () => {
    const arr = new BoundedArray(2, {
      onEvict: () => { throw new Error('evict error'); },
    });
    arr.push('a');
    arr.push('b');
    assert.doesNotThrow(() => arr.push('c'));
    assert.strictEqual(arr.length, 2);
  });
});

describe('CausalViolationError', () => {
  it('should be importable from errors module', () => {
    const { CausalViolationError } = require('../../src/errors');
    assert.strictEqual(typeof CausalViolationError, 'function');
  });

  it('should create error with correct properties', () => {
    const { CausalViolationError } = require('../../src/errors');
    const err = new CausalViolationError('CAUSAL_INPUT_MISSING', 'test message', { skillId: 'test' });
    assert.strictEqual(err.name, 'CausalViolationError');
    assert.strictEqual(err.code, 'CAUSAL_INPUT_MISSING');
    assert.strictEqual(err.message, 'test message');
  });
});
