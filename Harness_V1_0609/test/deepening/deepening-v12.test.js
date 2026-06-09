'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningThrottle = require('../../src/runtime/deepening/deepening-throttle');

describe('DeepeningThrottle', function() {
  let throttle;

  beforeEach(function() {
    throttle = new DeepeningThrottle({ limit: 3, interval: 5000 });
  });

  afterEach(function() {
    if (throttle) throttle.shutdown();
  });

  it('should create throttle with default options', function() {
    const t = new DeepeningThrottle();
    assert.strictEqual(t.getStats().limit, 10);
    assert.strictEqual(t.getStats().interval, 10000);
  });

  it('should acquire slots', async function() {
    const r1 = await throttle.acquire('test');
    assert.strictEqual(r1, true);
    assert.strictEqual(throttle.getCount('test'), 1);
  });

  it('should throttle when limit reached', async function() {
    await throttle.acquire('test');
    await throttle.acquire('test');
    await throttle.acquire('test');
    const r4 = await throttle.acquire('test');
    assert.strictEqual(r4, false);
  });

  it('should release slots', async function() {
    await throttle.acquire('test');
    await throttle.acquire('test');
    throttle.release('test');
    assert.strictEqual(throttle.getCount('test'), 1);
  });

  it('should track remaining slots', async function() {
    assert.strictEqual(throttle.getRemaining('test'), 3);
    await throttle.acquire('test');
    assert.strictEqual(throttle.getRemaining('test'), 2);
  });

  it('should detect throttled state', async function() {
    assert.strictEqual(throttle.isThrottled('test'), false);
    await throttle.acquire('test');
    await throttle.acquire('test');
    await throttle.acquire('test');
    assert.strictEqual(throttle.isThrottled('test'), true);
  });

  it('should handle different keys independently', async function() {
    await throttle.acquire('key1');
    await throttle.acquire('key1');
    assert.strictEqual(throttle.getCount('key1'), 2);
    assert.strictEqual(throttle.getCount('key2'), 0);
    assert.strictEqual(throttle.getRemaining('key2'), 3);
  });

  it('should use default key when none provided', async function() {
    await throttle.acquire();
    assert.strictEqual(throttle.getCount(), 1);
  });

  it('should reset specific key', async function() {
    await throttle.acquire('test');
    await throttle.acquire('test');
    throttle.reset('test');
    assert.strictEqual(throttle.getCount('test'), 0);
  });

  it('should reset all keys', async function() {
    await throttle.acquire('key1');
    await throttle.acquire('key2');
    throttle.reset();
    assert.strictEqual(throttle.getCount('key1'), 0);
    assert.strictEqual(throttle.getCount('key2'), 0);
  });

  it('should emit throttled event', async function() {
    let emitted = false;
    throttle.on('throttled', function() { emitted = true; });
    await throttle.acquire('test');
    await throttle.acquire('test');
    await throttle.acquire('test');
    await throttle.acquire('test');
    assert.strictEqual(emitted, true);
  });

  it('should emit acquired event', async function() {
    let emitted = false;
    throttle.on('acquired', function() { emitted = true; });
    await throttle.acquire('test');
    assert.strictEqual(emitted, true);
  });

  it('should emit released event', async function() {
    let emitted = false;
    throttle.on('released', function() { emitted = true; });
    await throttle.acquire('test');
    throttle.release('test');
    assert.strictEqual(emitted, true);
  });

  it('should get stats', async function() {
    await throttle.acquire('test');
    const stats = throttle.getStats();
    assert.strictEqual(stats.limit, 3);
    assert.strictEqual(stats.activeKeys, 1);
    assert.strictEqual(stats.keys[0].key, 'test');
    assert.strictEqual(stats.keys[0].count, 1);
  });

  it('should shutdown cleanly', function() {
    throttle.shutdown();
    assert.strictEqual(throttle.isHealthy(), false);
  });

  it('should handle release on empty slot', function() {
    throttle.release('test');
    assert.strictEqual(throttle.getCount('test'), 0);
  });
});
