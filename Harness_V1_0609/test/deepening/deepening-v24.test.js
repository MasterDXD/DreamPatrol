'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningResourceManager = require('../../src/runtime/deepening/deepening-resource-manager');

describe('DeepeningResourceManager', function() {
  let rm;

  beforeEach(function() {
    rm = new DeepeningResourceManager();
  });

  afterEach(function() {
    if (rm) rm.shutdown();
  });

  it('should create with defaults', function() {
    const r = new DeepeningResourceManager();
    assert.strictEqual(r.getStats().totalPools, 0);
    r.shutdown();
  });

  it('should create a pool', function() {
    rm.createPool('db', { maxSize: 5 });
    assert.strictEqual(rm.getStats().totalPools, 1);
  });

  it('should throw on create without name', function() {
    assert.throws(function() { rm.createPool(''); }, /Pool name is required/);
  });

  it('should not create duplicate pool', function() {
    rm.createPool('db');
    rm.createPool('db');
    assert.strictEqual(rm.getStats().totalPools, 1);
  });

  it('should emit poolCreated event', function() {
    let emitted = null;
    rm.on('poolCreated', function(e) { emitted = e; });
    rm.createPool('db', { maxSize: 5, minSize: 2 });
    assert.strictEqual(emitted.name, 'db');
    assert.strictEqual(emitted.maxSize, 5);
  });

  it('should remove a pool', function() {
    rm.createPool('db');
    let emitted = null;
    rm.on('poolRemoved', function(e) { emitted = e; });
    const result = rm.removePool('db');
    assert.strictEqual(result, true);
    assert.strictEqual(emitted.name, 'db');
  });

  it('should return false for removing unknown pool', function() {
    assert.strictEqual(rm.removePool('unknown'), false);
  });

  it('should acquire a resource from factory', async function() {
    rm.createPool('db', { factory: function() { return { id: Date.now() }; } });
    const resource = await rm.acquire('db');
    assert.strictEqual(typeof resource, 'object');
    assert.strictEqual(resource.id !== undefined, true);
  });

  it('should emit acquired event', async function() {
    let emitted = null;
    rm.createPool('db', { factory: function() { return {}; } });
    rm.on('acquired', function(e) { emitted = e; });
    await rm.acquire('db');
    assert.strictEqual(emitted.pool, 'db');
  });

  it('should emit resource-allocated for backward compat', async function() {
    let emitted = null;
    rm.createPool('db', { factory: function() { return {}; } });
    rm.on('resource-allocated', function(e) { emitted = e; });
    await rm.acquire('db');
    assert.strictEqual(emitted.pool, 'db');
  });

  it('should release a resource', async function() {
    rm.createPool('db', { factory: function() { return { id: 1 }; } });
    const resource = await rm.acquire('db');
    const result = rm.release('db', resource);
    assert.strictEqual(result, true);
  });

  it('should emit released event', async function() {
    let emitted = null;
    rm.createPool('db', { factory: function() { return {}; } });
    const resource = await rm.acquire('db');
    rm.on('released', function(e) { emitted = e; });
    rm.release('db', resource);
    assert.strictEqual(emitted.pool, 'db');
  });

  it('should return false for releasing unknown resource', function() {
    rm.createPool('db');
    assert.strictEqual(rm.release('db', {}), false);
  });

  it('should reuse released resources', async function() {
    rm.createPool('db', { factory: function() { return { id: 1 }; }, maxSize: 1 });
    const r1 = await rm.acquire('db');
    rm.release('db', r1);
    const r2 = await rm.acquire('db');
    assert.strictEqual(r1, r2);
  });

  it('should respect maxSize', async function() {
    rm.createPool('db', { factory: function() { return {}; }, maxSize: 1, acquireTimeout: 100 });
    await rm.acquire('db');
    await assert.rejects(function() { return rm.acquire('db'); }, /Acquire timeout/);
  });

  it('should deliver to waiting queue on release', async function() {
    rm.createPool('db', { factory: function() { return { id: 1 }; }, maxSize: 1 });
    const r1 = await rm.acquire('db');
    let gotResource = null;
    const p = rm.acquire('db').then(function(r) { gotResource = r; });
    rm.release('db', r1);
    await p;
    assert.strictEqual(gotResource, r1);
  });

  it('should validate resources from pool', async function() {
    let destroyed = false;
    rm.createPool('db', {
      factory: function() { return { id: 1 }; },
      validate: function() { return false; },
      destroy: function() { destroyed = true; },
      maxSize: 5,
    });
    const r1 = await rm.acquire('db');
    rm.release('db', r1);
    await rm.acquire('db');
    assert.strictEqual(destroyed, true);
    const info = rm.getPoolInfo('db');
    assert.strictEqual(info.totalValidationFailures, 1);
  });

  it('should destroy a resource', async function() {
    let destroyed = false;
    rm.createPool('db', { factory: function() { return {}; }, destroy: function() { destroyed = true; } });
    const resource = await rm.acquire('db');
    rm.release('db', resource);
    rm.destroy('db', resource);
    assert.strictEqual(destroyed, true);
  });

  it('should throw on acquire unknown pool', async function() {
    await assert.rejects(function() { return rm.acquire('unknown'); }, /Pool not found/);
  });

  it('should get pool info', async function() {
    rm.createPool('db', { maxSize: 5, factory: function() { return {}; } });
    await rm.acquire('db');
    const info = rm.getPoolInfo('db');
    assert.strictEqual(info.name, 'db');
    assert.strictEqual(info.maxSize, 5);
    assert.strictEqual(info.inUse, 1);
  });

  it('should return null for unknown pool info', function() {
    assert.strictEqual(rm.getPoolInfo('unknown'), null);
  });

  it('should get pool names', function() {
    rm.createPool('a');
    rm.createPool('b');
    assert.deepStrictEqual(rm.getPoolNames(), ['a', 'b']);
  });

  it('should track stats', async function() {
    rm.createPool('db', { factory: function() { return {}; } });
    await rm.acquire('db');
    const stats = rm.getStats();
    assert.strictEqual(stats.totalPools, 1);
    assert.strictEqual(stats.totalAcquired, 1);
  });

  it('should pre-populate minSize', function() {
    rm.createPool('db', { factory: function() { return {}; }, minSize: 3 });
    const info = rm.getPoolInfo('db');
    assert.strictEqual(info.available, 3);
  });

  it('should shutdown cleanly', function() {
    rm.createPool('db');
    let emitted = false;
    rm.on('shutdown', function() { emitted = true; });
    rm.shutdown();
    assert.strictEqual(emitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(rm.isHealthy(), true);
  });
});
