'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ParamValidator = require('../../src/utils/param-validator');
const TTLCache = require('../../src/utils/ttl-cache');

describe('ParamValidator', () => {
  describe('fluent API', () => {
    it('should collect no errors for valid params', () => {
      const v = ParamValidator.create()
        .requireNonEmptyString('hello', 'name')
        .requireFunction(() => {}, 'handler')
        .requireObject({}, 'config');
      assert.strictEqual(v.hasErrors, false);
      assert.deepStrictEqual(v.errors, []);
    });

    it('should collect errors for invalid params', () => {
      const v = ParamValidator.create()
        .requireNonEmptyString('', 'name')
        .requireFunction('not a fn', 'handler')
        .requireObject(null, 'config');
      assert.strictEqual(v.hasErrors, true);
      assert.strictEqual(v.errors.length, 3);
    });

    it('should throw on throwIfInvalid', () => {
      assert.throws(() => {
        ParamValidator.create()
          .requireNonEmptyString('', 'name')
          .throwIfInvalid();
      }, /name/);
    });

    it('should not throw when no errors', () => {
      ParamValidator.create()
        .requireNonEmptyString('hello', 'name')
        .throwIfInvalid();
    });

    it('should return result object', () => {
      const result = ParamValidator.create()
        .requireNonEmptyString('', 'name')
        .returnResult();
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.errors.length, 1);
    });

    it('should return valid result for no errors', () => {
      const result = ParamValidator.create()
        .requireNonEmptyString('hello', 'name')
        .returnResult();
      assert.strictEqual(result.valid, true);
      assert.deepStrictEqual(result.errors, []);
    });

    it('should support requireArray', () => {
      const v = ParamValidator.create().requireArray('not array', 'items');
      assert.strictEqual(v.hasErrors, true);
    });

    it('should support requireNonEmptyArray', () => {
      const v1 = ParamValidator.create().requireNonEmptyArray([], 'items');
      assert.strictEqual(v1.hasErrors, true);
      const v2 = ParamValidator.create().requireNonEmptyArray([1], 'items');
      assert.strictEqual(v2.hasErrors, false);
    });

    it('should support requireBoolean', () => {
      const v = ParamValidator.create().requireBoolean('yes', 'flag');
      assert.strictEqual(v.hasErrors, true);
    });

    it('should support requireTruthy', () => {
      const v = ParamValidator.create().requireTruthy(null, 'value');
      assert.strictEqual(v.hasErrors, true);
    });

    it('should support requireNumber with range', () => {
      const v = ParamValidator.create().requireNumberRange(5, 0, 10, 'score');
      assert.strictEqual(v.hasErrors, false);
      const v2 = ParamValidator.create().requireNumberRange(15, 0, 10, 'score');
      assert.strictEqual(v2.hasErrors, true);
    });

    it('should support custom validation', () => {
      const v = ParamValidator.create().custom(1 === 2, 'math is broken');
      assert.strictEqual(v.hasErrors, true);
      assert.strictEqual(v.errors[0], 'math is broken');
    });

    it('should support reset', () => {
      const v = ParamValidator.create().requireTruthy(null, 'val');
      assert.strictEqual(v.hasErrors, true);
      v.reset();
      assert.strictEqual(v.hasErrors, false);
    });
  });

  describe('static throw helpers', () => {
    it('requireString_ should throw for invalid', () => {
      assert.throws(() => ParamValidator.requireString_('', 'name'), /name/);
      assert.throws(() => ParamValidator.requireString_(null, 'name'), /name/);
    });

    it('requireString_ should not throw for valid', () => {
      ParamValidator.requireString_('hello', 'name');
    });

    it('requireFunction_ should throw for invalid', () => {
      assert.throws(() => ParamValidator.requireFunction_('not fn', 'fn'), /fn/);
    });

    it('requireObject_ should throw for invalid', () => {
      assert.throws(() => ParamValidator.requireObject_(null, 'obj'), /obj/);
      assert.throws(() => ParamValidator.requireObject_([], 'obj'), /obj/);
    });

    it('requireArray_ should throw for invalid', () => {
      assert.throws(() => ParamValidator.requireArray_({}, 'arr'), /arr/);
    });

    it('requireNumber_ should throw for invalid', () => {
      assert.throws(() => ParamValidator.requireNumber_(NaN, 'num'), /num/);
    });

    it('requireTruthy_ should throw for falsy', () => {
      assert.throws(() => ParamValidator.requireTruthy_(null, 'val'), /val/);
    });
  });

  describe('ensureSafeTimeout', () => {
    it('should return value when within safe range', () => {
      assert.strictEqual(ParamValidator.ensureSafeTimeout(5000), 5000);
    });

    it('should clamp value exceeding 2^31-1', () => {
      assert.strictEqual(ParamValidator.ensureSafeTimeout(3000000000), 2147483647);
    });

    it('should use fallback for invalid value', () => {
      assert.strictEqual(ParamValidator.ensureSafeTimeout(-1, 10000), 10000);
      assert.strictEqual(ParamValidator.ensureSafeTimeout(0, 10000), 10000);
      assert.strictEqual(ParamValidator.ensureSafeTimeout(NaN, 10000), 10000);
    });

    it('should use default fallback when no fallback provided', () => {
      assert.strictEqual(ParamValidator.ensureSafeTimeout(undefined), 60000);
    });

    it('should clamp fallback too if it exceeds limit', () => {
      assert.strictEqual(ParamValidator.ensureSafeTimeout(-1, 9999999999), 2147483647);
    });
  });
});

describe('TTLCache', () => {
  it('should set and get values', () => {
    const cache = new TTLCache({ defaultTTL: 1000 });
    cache.set('key', 'value');
    assert.strictEqual(cache.get('key'), 'value');
  });

  it('should return undefined for missing key', () => {
    const cache = new TTLCache();
    assert.strictEqual(cache.get('missing'), undefined);
  });

  it('should expire entries after TTL', () => {
    return new Promise((resolve) => {
      const cache = new TTLCache({ defaultTTL: 50 });
      cache.set('key', 'value');
      assert.strictEqual(cache.get('key'), 'value');
      setTimeout(() => {
        assert.strictEqual(cache.get('key'), undefined);
        resolve();
      }, 100);
    });
  });

  it('should support custom TTL per entry', () => {
    return new Promise((resolve) => {
      const cache = new TTLCache({ defaultTTL: 1000 });
      cache.set('short', 'value', 50);
      cache.set('long', 'value', 5000);
      setTimeout(() => {
        assert.strictEqual(cache.get('short'), undefined);
        assert.strictEqual(cache.get('long'), 'value');
        resolve();
      }, 100);
    });
  });

  it('should check has() correctly', () => {
    const cache = new TTLCache({ defaultTTL: 1000 });
    cache.set('key', 'value');
    assert.strictEqual(cache.has('key'), true);
    assert.strictEqual(cache.has('missing'), false);
  });

  it('should delete entries', () => {
    const cache = new TTLCache({ defaultTTL: 1000 });
    cache.set('key', 'value');
    assert.strictEqual(cache.delete('key'), true);
    assert.strictEqual(cache.get('key'), undefined);
  });

  it('should clear all entries', () => {
    const cache = new TTLCache({ defaultTTL: 1000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.strictEqual(cache.size, 0);
  });

  it('should respect maxSize', () => {
    const cache = new TTLCache({ defaultTTL: 1000, maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.strictEqual(cache.size, 2);
  });

  it('should track stats', () => {
    const cache = new TTLCache({ defaultTTL: 1000 });
    cache.set('key', 'value');
    cache.get('key');
    cache.get('missing');
    assert.strictEqual(cache.stats.hits, 1);
    assert.strictEqual(cache.stats.misses, 1);
  });

  it('should purge expired entries', () => {
    return new Promise((resolve) => {
      const cache = new TTLCache({ defaultTTL: 50 });
      cache.set('a', 1);
      cache.set('b', 2);
      setTimeout(() => {
        const purged = cache.purgeExpired();
        assert.strictEqual(purged, 2);
        assert.strictEqual(cache.size, 0);
        resolve();
      }, 100);
    });
  });

  it('should get remaining TTL', () => {
    const cache = new TTLCache({ defaultTTL: 1000 });
    cache.set('key', 'value');
    const remaining = cache.getRemainingTTL('key');
    assert.ok(remaining > 900 && remaining <= 1000);
  });

  it('should refresh TTL', () => {
    const cache = new TTLCache({ defaultTTL: 100 });
    cache.set('key', 'value');
    cache.refresh('key', 5000);
    const remaining = cache.getRemainingTTL('key');
    assert.ok(remaining > 4000);
  });

  it('should check isExpired', () => {
    const cache = new TTLCache({ defaultTTL: 1000 });
    cache.set('key', 'value');
    assert.strictEqual(cache.isExpired('key'), false);
    assert.strictEqual(cache.isExpired('missing'), true);
  });

  it('should return keys, values, entries', () => {
    const cache = new TTLCache({ defaultTTL: 1000 });
    cache.set('a', 1);
    cache.set('b', 2);
    assert.deepStrictEqual(cache.keys().sort(), ['a', 'b']);
    assert.deepStrictEqual(cache.values().sort(), [1, 2]);
  });

  it('should support forEach', () => {
    const cache = new TTLCache({ defaultTTL: 1000 });
    cache.set('a', 1);
    cache.set('b', 2);
    const result = {};
    cache.forEach((value, key) => { result[key] = value; });
    assert.deepStrictEqual(result, { a: 1, b: 2 });
  });

  describe('static helpers', () => {
    it('isTimestampExpired should work', () => {
      const now = Date.now();
      assert.strictEqual(TTLCache.isTimestampExpired(now - 2000, 1000), true);
      assert.strictEqual(TTLCache.isTimestampExpired(now - 500, 1000), false);
    });

    it('isTimestampExpired should handle string timestamps', () => {
      const now = Date.now();
      const ts = new Date(now - 2000).toISOString();
      assert.strictEqual(TTLCache.isTimestampExpired(ts, 1000), true);
    });

    it('isTimestampExpired should handle invalid timestamps', () => {
      assert.strictEqual(TTLCache.isTimestampExpired('invalid', 1000), true);
    });

    it('computeExpiresAt should work', () => {
      const expiresAt = TTLCache.computeExpiresAt(5000);
      assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 5000);
    });
  });
});
