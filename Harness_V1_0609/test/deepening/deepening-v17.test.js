'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningBackpressureManager = require('../../src/runtime/deepening/deepening-backpressure-manager');
const DeepeningConnectionPool = require('../../src/runtime/deepening/deepening-connection-pool');


describe('DeepeningBackpressureManager', function() {
  let bp;

  beforeEach(function() {
    bp = new DeepeningBackpressureManager({ defaultHighWatermark: 10, defaultLowWatermark: 3, checkInterval: 1000 });
  });

  afterEach(function() {
    if (bp) bp.shutdown();
  });

  it('should create manager with default options', function() {
    const b = new DeepeningBackpressureManager();
    assert.strictEqual(b.getStats().totalStreams, 0);
    b.shutdown();
  });

  it('should register a stream', function() {
    bp.registerStream('input');
    assert.strictEqual(bp.getStreamNames().length, 1);
  });

  it('should throw on register without name', function() {
    assert.throws(function() { bp.registerStream(''); }, /Stream name is required/);
  });

  it('should not duplicate stream', function() {
    bp.registerStream('input');
    bp.registerStream('input');
    assert.strictEqual(bp.getStreamNames().length, 1);
  });

  it('should emit streamRegistered event', function() {
    let emitted = null;
    bp.on('streamRegistered', function(e) { emitted = e; });
    bp.registerStream('input', { highWatermark: 20 });
    assert.strictEqual(emitted.name, 'input');
    assert.strictEqual(emitted.highWatermark, 20);
  });

  it('should push data to stream', function() {
    bp.registerStream('input');
    const result = bp.push('input', 3);
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.bufferSize, 3);
  });

  it('should throw on push to unknown stream', function() {
    assert.throws(function() { bp.push('unknown'); }, /Stream not found/);
  });

  it('should ack data from stream', function() {
    bp.registerStream('input');
    bp.push('input', 5);
    const result = bp.ack('input', 3);
    assert.strictEqual(result.bufferSize, 2);
  });

  it('should throw on ack unknown stream', function() {
    assert.throws(function() { bp.ack('unknown'); }, /Stream not found/);
  });

  it('should detect pressure levels', function() {
    bp.registerStream('input', { highWatermark: 10, lowWatermark: 3 });
    bp.push('input', 5);
    const p = bp.getPressure('input');
    assert.strictEqual(p.level, 'medium');
  });

  it('should detect critical pressure', function() {
    bp.registerStream('input', { highWatermark: 10, lowWatermark: 3 });
    bp.push('input', 10);
    const p = bp.getPressure('input');
    assert.strictEqual(p.level, 'critical');
  });

  it('should auto-pause on critical', function() {
    bp.registerStream('input', { highWatermark: 10, lowWatermark: 3 });
    let pausedEmitted = null;
    bp.on('paused', function(e) { pausedEmitted = e; });
    bp.push('input', 10);
    assert.strictEqual(bp.isPaused('input'), true);
    assert.strictEqual(pausedEmitted.name, 'input');
  });

  it('should auto-resume on low', function() {
    bp.registerStream('input', { highWatermark: 10, lowWatermark: 3 });
    bp.push('input', 10);
    bp.ack('input', 10);
    assert.strictEqual(bp.isPaused('input'), false);
  });

  it('should emit pressureChanged event', function() {
    let emitted = null;
    bp.registerStream('input', { highWatermark: 10, lowWatermark: 3 });
    bp.on('pressureChanged', function(e) { emitted = e; });
    bp.push('input', 8);
    assert.strictEqual(emitted.from, 'low');
    assert.strictEqual(emitted.to, 'high');
  });

  it('should drop data when paused and overflow', function() {
    bp.registerStream('input', { highWatermark: 5, lowWatermark: 2, maxBufferSize: 8 });
    bp.push('input', 5);
    bp.push('input', 3);
    let droppedEmitted = null;
    bp.on('dropped', function(e) { droppedEmitted = e; });
    const result = bp.push('input', 2);
    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.reason, 'paused_overflow');
    assert.strictEqual(droppedEmitted.count, 2);
  });

  it('should force pause and resume', function() {
    bp.registerStream('input');
    bp.forcePause('input');
    assert.strictEqual(bp.isPaused('input'), true);
    bp.forceResume('input');
    assert.strictEqual(bp.isPaused('input'), false);
  });

  it('should return false for force pause/resume unknown stream', function() {
    assert.strictEqual(bp.forcePause('unknown'), false);
    assert.strictEqual(bp.forceResume('unknown'), false);
  });

  it('should reset stream', function() {
    bp.registerStream('input');
    bp.push('input', 5);
    let resetEmitted = null;
    bp.on('streamReset', function(e) { resetEmitted = e; });
    bp.resetStream('input');
    assert.strictEqual(resetEmitted.name, 'input');
    const p = bp.getPressure('input');
    assert.strictEqual(p.bufferSize, 0);
    assert.strictEqual(p.level, 'low');
  });

  it('should unregister stream', function() {
    bp.registerStream('input');
    let emitted = null;
    bp.on('streamUnregistered', function(e) { emitted = e; });
    bp.unregisterStream('input');
    assert.strictEqual(emitted.name, 'input');
    assert.strictEqual(bp.getStreamNames().length, 0);
  });

  it('should get stats', function() {
    bp.registerStream('input');
    bp.push('input', 3);
    bp.ack('input', 1);
    const stats = bp.getStats();
    assert.strictEqual(stats.totalStreams, 1);
    assert.ok(stats.streams.input);
  });

  it('should expose PRESSURE_LEVELS', function() {
    assert.strictEqual(DeepeningBackpressureManager.PRESSURE_LEVELS.LOW, 'low');
    assert.strictEqual(DeepeningBackpressureManager.PRESSURE_LEVELS.CRITICAL, 'critical');
  });

  it('should shutdown cleanly', function() {
    bp.registerStream('input');
    let shutdownEmitted = false;
    bp.on('shutdown', function() { shutdownEmitted = true; });
    bp.shutdown();
    assert.strictEqual(shutdownEmitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(bp.isHealthy(), true);
  });
});

describe('DeepeningConnectionPool', function() {
  let cp;

  beforeEach(function() {
    cp = new DeepeningConnectionPool({ defaultMaxConnections: 5, defaultIdleTimeout: 300000, healthCheckInterval: 30000 });
  });

  afterEach(function() {
    if (cp) cp.shutdown();
  });

  it('should create pool with default options', function() {
    const c = new DeepeningConnectionPool();
    assert.strictEqual(c.getStats().totalPools, 0);
    c.shutdown();
  });

  it('should create a pool', function() {
    cp.createPool('db');
    assert.strictEqual(cp.getPoolNames().length, 1);
  });

  it('should throw on create pool without name', function() {
    assert.throws(function() { cp.createPool(''); }, /Pool name is required/);
  });

  it('should not duplicate pool', function() {
    cp.createPool('db');
    cp.createPool('db');
    assert.strictEqual(cp.getPoolNames().length, 1);
  });

  it('should emit poolCreated event', function() {
    let emitted = null;
    cp.on('poolCreated', function(e) { emitted = e; });
    cp.createPool('db', { maxConnections: 20 });
    assert.strictEqual(emitted.name, 'db');
    assert.strictEqual(emitted.maxConnections, 20);
  });

  it('should acquire a connection', async function() {
    cp.createPool('db');
    const result = await cp.acquire('db');
    assert.strictEqual(result.connectionId !== null, true);
    assert.strictEqual(result.state, 'active');
  });

  it('should throw on acquire from unknown pool', function() {
    assert.throws(function() { cp.acquire('unknown'); }, /Pool not found/);
  });

  it('should emit acquired event', async function() {
    let emitted = null;
    cp.createPool('db');
    cp.on('acquired', function(e) { emitted = e; });
    await cp.acquire('db');
    assert.strictEqual(emitted.pool, 'db');
  });

  it('should reuse idle connections', async function() {
    cp.createPool('db');
    const conn1 = await cp.acquire('db');
    cp.release('db', conn1.connectionId);
    const conn2 = await cp.acquire('db');
    assert.strictEqual(conn2.connectionId, conn1.connectionId);
    assert.strictEqual(conn2.useCount, 2);
  });

  it('should release a connection', async function() {
    cp.createPool('db');
    const conn = await cp.acquire('db');
    let emitted = null;
    cp.on('released', function(e) { emitted = e; });
    cp.release('db', conn.connectionId);
    assert.strictEqual(emitted.pool, 'db');
    const info = cp.getPoolInfo('db');
    assert.strictEqual(info.idle, 1);
    assert.strictEqual(info.active, 0);
  });

  it('should return false for releasing unknown connection', function() {
    cp.createPool('db');
    assert.strictEqual(cp.release('db', 'unknown-id'), false);
  });

  it('should reject when pool is full', async function() {
    const small = new DeepeningConnectionPool({ defaultMaxConnections: 2 });
    small.createPool('db');
    await small.acquire('db');
    await small.acquire('db');
    let threw = false;
    try { await small.acquire('db', { queue: false }); } catch (e) { threw = /Connection pool exhausted/.test(e.message); }
    assert.ok(threw, 'Should throw when pool exhausted');
    small.shutdown();
  });

  it('should emit rejected event when pool full', async function() {
    let emitted = null;
    const small = new DeepeningConnectionPool({ defaultMaxConnections: 1 });
    small.createPool('db');
    small.on('rejected', function(e) { emitted = e; });
    await small.acquire('db');
    try { await small.acquire('db', { queue: false }); } catch (_e) { _e; }
    assert.strictEqual(emitted.pool, 'db');
    small.shutdown();
  });

  it('should mark error on connection', async function() {
    cp.createPool('db');
    const conn = await cp.acquire('db');
    let emitted = null;
    cp.on('connection-error', function(e) { emitted = e; });
    cp.markError('db', conn.connectionId);
    assert.strictEqual(emitted.connectionId, conn.connectionId);
    const info = cp.getPoolInfo('db');
    assert.strictEqual(info.totalConnections, 0);
  });

  it('should get pool info', async function() {
    cp.createPool('db', { maxConnections: 5 });
    await cp.acquire('db');
    const info = cp.getPoolInfo('db');
    assert.strictEqual(info.name, 'db');
    assert.strictEqual(info.maxConnections, 5);
    assert.strictEqual(info.active, 1);
    assert.strictEqual(info.idle, 0);
  });

  it('should return null for unknown pool info', function() {
    assert.strictEqual(cp.getPoolInfo('unknown'), null);
  });

  it('should drain idle connections', async function() {
    cp.createPool('db');
    const conn = await cp.acquire('db');
    cp.release('db', conn.connectionId);
    let emitted = null;
    cp.on('drained', function(e) { emitted = e; });
    const count = cp.drainPool('db');
    assert.strictEqual(count, 1);
    assert.strictEqual(emitted.pool, 'db');
  });

  it('should remove pool', function() {
    cp.createPool('db');
    let emitted = null;
    cp.on('poolRemoved', function(e) { emitted = e; });
    cp.removePool('db');
    assert.strictEqual(emitted.name, 'db');
    assert.strictEqual(cp.getPoolNames().length, 0);
  });

  it('should return false for removing unknown pool', function() {
    assert.strictEqual(cp.removePool('unknown'), false);
  });

  it('should get stats', function() {
    cp.createPool('db');
    cp.acquire('db');
    const stats = cp.getStats();
    assert.strictEqual(stats.totalPools, 1);
    assert.strictEqual(stats.totalAcquired, 1);
    assert.ok(stats.pools.db);
  });

  it('should expose CONNECTION_STATES', function() {
    assert.strictEqual(DeepeningConnectionPool.CONNECTION_STATES.IDLE, 'idle');
    assert.strictEqual(DeepeningConnectionPool.CONNECTION_STATES.ACTIVE, 'active');
    assert.strictEqual(DeepeningConnectionPool.CONNECTION_STATES.ERROR, 'error');
  });

  it('should shutdown cleanly', function() {
    cp.createPool('db');
    let shutdownEmitted = false;
    cp.on('shutdown', function() { shutdownEmitted = true; });
    cp.shutdown();
    assert.strictEqual(shutdownEmitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(cp.isHealthy(), true);
  });
});
