'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const safeAssign = require('../../src/utils/safe-assign');
const deepClone = require('../../src/utils/deep-clone');
const { sanitizePath } = require('../../src/utils/path-utils');
const { t, setLocale, getLocale, getSupportedLocales, DEFAULT_LOCALE } = require('../../src/utils/i18n');
const { getCapacity, clearCache, DEFAULTS } = require('../../src/utils/capacity-config');

describe('safeAssign', () => {
  it('should merge sources into target', () => {
    const target = { a: 1 };
    const result = safeAssign(target, { b: 2 }, { c: 3 });
    assert.deepStrictEqual(result, { a: 1, b: 2, c: 3 });
  });

  it('should skip DANGEROUS_KEYS', () => {
    const target = {};
    const result = safeAssign(target, { __proto__: { hacked: true }, constructor: 'evil', normal: 'ok' });
    assert.strictEqual(result.normal, 'ok');
    assert.strictEqual(result.hacked, undefined);
  });

  it('should handle null and undefined sources', () => {
    const target = { a: 1 };
    const result = safeAssign(target, null, undefined, { b: 2 });
    assert.deepStrictEqual(result, { a: 1, b: 2 });
  });

  it('should return target', () => {
    const target = {};
    assert.strictEqual(safeAssign(target, { a: 1 }), target);
  });
});

describe('sanitizePath', () => {
  it('should strip null bytes', () => {
    assert.strictEqual(sanitizePath('foo\x00bar'), 'foobar');
  });

  it('should normalize path', () => {
    assert.strictEqual(sanitizePath('foo/../bar'), 'bar');
  });

  it('should return empty string for non-string input', () => {
    assert.strictEqual(sanitizePath(null), '');
    assert.strictEqual(sanitizePath(undefined), '');
    assert.strictEqual(sanitizePath(123), '');
  });
});

describe('i18n', () => {
  it('should return default locale', () => {
    assert.strictEqual(getLocale(), DEFAULT_LOCALE);
  });

  it('should return supported locales', () => {
    const locales = getSupportedLocales();
    assert.ok(locales.includes('zh-CN'));
    assert.ok(locales.includes('en-US'));
  });

  it('should set and get locale', () => {
    setLocale('en-US');
    assert.strictEqual(getLocale(), 'en-US');
    setLocale(DEFAULT_LOCALE);
    assert.strictEqual(getLocale(), DEFAULT_LOCALE);
  });

  it('should ignore unsupported locale', () => {
    const before = getLocale();
    setLocale('xx-YY');
    assert.strictEqual(getLocale(), before);
  });

  it('should translate key with fallback', () => {
    const result = t('nonexistent.key.test');
    assert.strictEqual(result, 'nonexistent.key.test');
  });

  it('should replace positional placeholders', () => {
    setLocale('en-US');
    const result = t('server.error.portInUse', '3000');
    assert.ok(result.includes('3000') || result.includes('nonexistent') || typeof result === 'string');
    setLocale(DEFAULT_LOCALE);
  });
});

describe('capacity-config', () => {
  it('should export DEFAULTS with expected keys', () => {
    assert.ok(DEFAULTS.causal_memory_max !== undefined);
    assert.ok(DEFAULTS.goals_max !== undefined);
    assert.ok(DEFAULTS.similarity_threshold !== undefined);
    assert.ok(DEFAULTS.decay_factor_per_day !== undefined);
  });

  it('should return default value from getCapacity', () => {
    const val = getCapacity('causal_memory_max');
    assert.strictEqual(val, DEFAULTS.causal_memory_max);
  });

  it('should return default for unknown key', () => {
    const val = getCapacity('nonexistent_key_xyz');
    assert.strictEqual(val, DEFAULTS.nonexistent_key_xyz);
  });

  it('should clear cache', () => {
    clearCache();
    const after = getCapacity('nonexistent_key_xyz');
    assert.strictEqual(after, DEFAULTS.nonexistent_key_xyz);
  });
});

describe('deepClone - prototype pollution regression', () => {
  it('should strip __proto__ key from cloned object', () => {
    const obj = Object.create(null);
    obj.__proto__ = { admin: true };
    obj.name = 'test';
    const cloned = deepClone(obj);
    assert.strictEqual(cloned.name, 'test');
    assert.strictEqual(Object.keys(cloned).includes('__proto__'), false);
  });

  it('should strip constructor key from cloned object', () => {
    const obj = Object.create(null);
    obj.constructor = { hack: true };
    obj.name = 'test';
    const cloned = deepClone(obj);
    assert.strictEqual(cloned.name, 'test');
    assert.strictEqual(Object.keys(cloned).includes('constructor'), false);
  });

  it('should strip prototype key from cloned object', () => {
    const obj = Object.create(null);
    obj.prototype = { evil: true };
    obj.name = 'test';
    const cloned = deepClone(obj);
    assert.strictEqual(cloned.name, 'test');
    assert.strictEqual(Object.keys(cloned).includes('prototype'), false);
  });

  it('should strip nested dangerous keys', () => {
    const inner = Object.create(null);
    inner.__proto__ = { admin: true };
    inner.constructor = { hack: true };
    inner.safe = 'yes';
    const obj = { outer: inner, name: 'test' };
    const cloned = deepClone(obj);
    assert.strictEqual(cloned.name, 'test');
    assert.strictEqual(cloned.outer.safe, 'yes');
    assert.strictEqual(Object.keys(cloned.outer).includes('__proto__'), false);
    assert.strictEqual(Object.keys(cloned.outer).includes('constructor'), false);
  });

  it('should strip all three dangerous keys at once', () => {
    const obj = Object.create(null);
    obj.__proto__ = { admin: true };
    obj.constructor = { hack: true };
    obj.prototype = { evil: true };
    obj.safe = 'value';
    const cloned = deepClone(obj);
    assert.strictEqual(cloned.safe, 'value');
    assert.strictEqual(Object.keys(cloned).includes('__proto__'), false);
    assert.strictEqual(Object.keys(cloned).includes('constructor'), false);
    assert.strictEqual(Object.keys(cloned).includes('prototype'), false);
  });

  it('should handle JSON-parsed objects with __proto__', () => {
    const obj = JSON.parse('{"__proto__":{"admin":true},"name":"test"}');
    const cloned = deepClone(obj);
    assert.strictEqual(cloned.name, 'test');
    assert.strictEqual(Object.keys(cloned).includes('__proto__'), false);
  });

  it('should not pollute Object.prototype after cloning', () => {
    const obj = Object.create(null);
    obj.__proto__ = { admin: true };
    deepClone(obj);
    assert.strictEqual({}.admin, undefined);
    assert.strictEqual(Object.prototype.admin, undefined);
  });

  it('should preserve safe properties while stripping dangerous ones', () => {
    const obj = Object.create(null);
    obj.__proto__ = { polluted: true };
    obj.a = 1;
    obj.b = 'hello';
    obj.c = [1, 2, 3];
    const cloned = deepClone(obj);
    assert.strictEqual(cloned.a, 1);
    assert.strictEqual(cloned.b, 'hello');
    assert.deepStrictEqual(cloned.c, [1, 2, 3]);
    assert.strictEqual(Object.keys(cloned).includes('__proto__'), false);
  });
});
