'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningCircuitBreaker = require('../../src/runtime/deepening/deepening-circuit-breaker');

describe('DeepeningCircuitBreaker - Core', function() {
  let cb;

  beforeEach(function() {
    cb = new DeepeningCircuitBreaker({ failureThreshold: 3, successThreshold: 2, resetTimeout: 200 });
  });

  afterEach(function() {
    if (cb) cb.shutdown();
  });

  it('should create with defaults', function() {
    const c = new DeepeningCircuitBreaker();
    assert.strictEqual(c.getStats().totalCircuits, 0);
    assert.strictEqual(c.getStats().failureThreshold, 5);
    c.shutdown();
  });

  it('should create a circuit', function() {
    cb.create('api-service');
    assert.strictEqual(cb.getStats().totalCircuits, 1);
  });

  it('should throw on create without name', function() {
    assert.throws(function() { cb.create(''); }, /Circuit name/);
  });

  it('should not create duplicate circuit', function() {
    cb.create('api');
    cb.create('api');
    assert.strictEqual(cb.getStats().totalCircuits, 1);
  });

  it('should emit created event', function() {
    let emitted = null;
    cb.on('created', function(e) { emitted = e; });
    cb.create('api');
    assert.strictEqual(emitted.name, 'api');
    assert.strictEqual(emitted.state, 'closed');
  });

  it('should remove a circuit', function() {
    cb.create('api');
    let emitted = null;
    cb.on('removed', function(e) { emitted = e; });
    const result = cb.remove('api');
    assert.strictEqual(result, true);
    assert.strictEqual(emitted.name, 'api');
    assert.strictEqual(cb.getStats().totalCircuits, 0);
  });

  it('should return false for removing unknown circuit', function() {
    assert.strictEqual(cb.remove('unknown'), false);
  });

  it('should get circuit state', function() {
    cb.create('api');
    assert.strictEqual(cb.getState('api'), 'closed');
  });

  it('should return null for unknown circuit state', function() {
    assert.strictEqual(cb.getState('unknown'), null);
  });

  it('should record success and reset failure count', function() {
    cb.create('api');
    cb.recordFailure('api');
    cb.recordFailure('api');
    cb.recordSuccess('api');
    const info = cb.getCircuitInfo('api');
    assert.strictEqual(info.failureCount, 0);
    assert.strictEqual(info.totalSuccesses, 1);
  });

  it('should emit success event', function() {
    let emitted = null;
    cb.create('api');
    cb.on('success', function(e) { emitted = e; });
    cb.recordSuccess('api');
    assert.strictEqual(emitted.name, 'api');
  });

  it('should record failure and trip circuit at threshold', function() {
    cb.create('api');
    let stateChanged = null;
    cb.on('circuit-state-change', function(e) { stateChanged = e; });
    cb.recordFailure('api');
    cb.recordFailure('api');
    cb.recordFailure('api');
    assert.strictEqual(cb.getState('api'), 'open');
    assert.strictEqual(stateChanged.from, 'closed');
    assert.strictEqual(stateChanged.to, 'open');
  });

  it('should emit failure event', function() {
    let emitted = null;
    cb.create('api');
    cb.on('failure', function(e) { emitted = e; });
    cb.recordFailure('api');
    assert.strictEqual(emitted.name, 'api');
    assert.strictEqual(emitted.failureCount, 1);
  });

  it('should increment totalTripped on open', function() {
    cb.create('api');
    cb.recordFailure('api');
    cb.recordFailure('api');
    cb.recordFailure('api');
    assert.strictEqual(cb.getStats().totalTripped, 1);
  });

  it('should transition to half-open after reset timeout', async function() {
    cb.create('api', { resetTimeout: 100 });
    cb.recordFailure('api');
    cb.recordFailure('api');
    cb.recordFailure('api');
    assert.strictEqual(cb.getState('api'), 'open');
    let stateChanged = null;
    cb.on('circuit-state-change', function(e) { stateChanged = e; });
    await new Promise(function(r) { setTimeout(r, 150); });
    assert.strictEqual(cb.tryRecover('api'), 'half_open');
    assert.strictEqual(stateChanged.to, 'half_open');
  });

  it('should close circuit after success threshold in half-open', function() {
    cb.create('api', { successThreshold: 2 });
    cb.forceOpen('api');
    cb.forceHalfOpen('api');
    cb.recordSuccess('api');
    cb.recordSuccess('api');
    assert.strictEqual(cb.getState('api'), 'closed');
  });

  it('should re-open circuit on failure in half-open', function() {
    cb.create('api');
    cb.forceOpen('api');
    cb.forceHalfOpen('api');
    cb.recordFailure('api');
    assert.strictEqual(cb.getState('api'), 'open');
  });
});

describe('DeepeningCircuitBreaker - Execute and Info', function() {
  let cb;

  beforeEach(function() {
    cb = new DeepeningCircuitBreaker({ failureThreshold: 3, successThreshold: 2, resetTimeout: 200 });
  });

  afterEach(function() {
    if (cb) cb.shutdown();
  });

  it('should reject execute when circuit is open', async function() {
    cb.create('api');
    cb.forceOpen('api');
    let rejected = null;
    cb.on('rejected', function(e) { rejected = e; });
    await assert.rejects(function() { return cb.execute('api', function() {}); }, /is open/);
    assert.strictEqual(rejected.name, 'api');
  });

  it('should execute successfully when circuit is closed', async function() {
    cb.create('api');
    const result = await cb.execute('api', function() { return 42; });
    assert.strictEqual(result, 42);
  });

  it('should record failure on execute exception', async function() {
    cb.create('api');
    await assert.rejects(function() { return cb.execute('api', function() { throw new Error('boom'); }); }, /boom/);
    const info = cb.getCircuitInfo('api');
    assert.strictEqual(info.totalFailures, 1);
  });

  it('should throw on execute for unknown circuit', async function() {
    await assert.rejects(function() { return cb.execute('unknown', function() {}); }, /Circuit not found/);
  });

  it('should throw on execute without function', async function() {
    cb.create('api');
    await assert.rejects(function() { return cb.execute('api', 'not-fn'); }, /fn must be a function/);
  });

  it('should force open a circuit', function() {
    cb.create('api');
    cb.forceOpen('api');
    assert.strictEqual(cb.getState('api'), 'open');
  });

  it('should force close a circuit', function() {
    cb.create('api');
    cb.forceOpen('api');
    cb.forceClose('api');
    assert.strictEqual(cb.getState('api'), 'closed');
  });

  it('should force half-open a circuit', function() {
    cb.create('api');
    cb.forceHalfOpen('api');
    assert.strictEqual(cb.getState('api'), 'half_open');
  });

  it('should get circuit info', function() {
    cb.create('api', { failureThreshold: 3, resetTimeout: 5000 });
    const info = cb.getCircuitInfo('api');
    assert.strictEqual(info.name, 'api');
    assert.strictEqual(info.state, 'closed');
    assert.strictEqual(info.failureThreshold, 3);
    assert.strictEqual(info.resetTimeout, 5000);
  });

  it('should return null for unknown circuit info', function() {
    assert.strictEqual(cb.getCircuitInfo('unknown'), null);
  });

  it('should get circuit names', function() {
    cb.create('api');
    cb.create('db');
    assert.deepStrictEqual(cb.getCircuitNames(), ['api', 'db']);
  });

  it('should get circuits by state', function() {
    cb.create('api');
    cb.create('db');
    cb.forceOpen('db');
    const open = cb.getByState('open');
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].name, 'db');
  });

  it('should reset a circuit', function() {
    cb.create('api');
    cb.forceOpen('api');
    cb.reset('api');
    assert.strictEqual(cb.getState('api'), 'closed');
  });

  it('should reset all circuits', function() {
    cb.create('api');
    cb.create('db');
    cb.forceOpen('api');
    cb.forceOpen('db');
    cb.resetAll();
    assert.strictEqual(cb.getState('api'), 'closed');
    assert.strictEqual(cb.getState('db'), 'closed');
  });

  it('should reject half-open when capacity reached', async function() {
    cb.create('api', { maxHalfOpenCalls: 1 });
    cb.forceHalfOpen('api');
    cb.execute('api', function() { return 1; });
    let rejected = null;
    cb.on('rejected', function(e) { rejected = e; });
    await assert.rejects(function() { return cb.execute('api', function() { return 2; }); }, /half-open capacity/);
    assert.strictEqual(rejected.name, 'api');
  });

  it('should expose CIRCUIT_STATES', function() {
    assert.strictEqual(DeepeningCircuitBreaker.CIRCUIT_STATES.CLOSED, 'closed');
    assert.strictEqual(DeepeningCircuitBreaker.CIRCUIT_STATES.OPEN, 'open');
    assert.strictEqual(DeepeningCircuitBreaker.CIRCUIT_STATES.HALF_OPEN, 'half_open');
  });

  it('should emit circuit-state-change for backward compatibility', function() {
    let emitted = null;
    cb.create('api');
    cb.on('circuit-state-change', function(e) { emitted = e; });
    cb.forceOpen('api');
    assert.strictEqual(emitted.name, 'api');
    assert.strictEqual(emitted.to, 'open');
  });

  it('should shutdown cleanly', function() {
    cb.create('api');
    let emitted = false;
    cb.on('shutdown', function() { emitted = true; });
    cb.shutdown();
    assert.strictEqual(emitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(cb.isHealthy(), true);
  });
});
