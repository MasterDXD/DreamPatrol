'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningLoadBalancer = require('../../src/runtime/deepening/deepening-load-balancer');
const DeepeningTimeoutManager = require('../../src/runtime/deepening/deepening-timeout-manager');


describe('DeepeningLoadBalancer', function() {
  let lb;

  beforeEach(function() {
    lb = new DeepeningLoadBalancer();
  });

  afterEach(function() {
    if (lb) lb.shutdown();
  });

  it('should create balancer with defaults', function() {
    assert.strictEqual(lb.getStats().totalPools, 0);
  });

  it('should create a pool', function() {
    lb.createPool('api');
    assert.strictEqual(lb.getPoolNames().length, 1);
  });

  it('should throw on create pool without name', function() {
    assert.throws(function() { lb.createPool(''); }, /Pool name is required/);
  });

  it('should not duplicate pool', function() {
    lb.createPool('api');
    lb.createPool('api');
    assert.strictEqual(lb.getPoolNames().length, 1);
  });

  it('should emit poolCreated event', function() {
    let emitted = null;
    lb.on('poolCreated', function(e) { emitted = e; });
    lb.createPool('api', { strategy: 'weighted' });
    assert.strictEqual(emitted.name, 'api');
    assert.strictEqual(emitted.strategy, 'weighted');
  });

  it('should add instance to pool', function() {
    lb.createPool('api');
    lb.addInstance('api', 'srv1', { weight: 3 });
    const info = lb.getPoolInfo('api');
    assert.strictEqual(info.totalInstances, 1);
    assert.strictEqual(info.instances[0].weight, 3);
  });

  it('should throw on add instance to unknown pool', function() {
    assert.throws(function() { lb.addInstance('unknown', 'srv1'); }, /Pool not found/);
  });

  it('should throw on add instance without id', function() {
    lb.createPool('api');
    assert.throws(function() { lb.addInstance('api', ''); }, /Instance ID is required/);
  });

  it('should emit instanceAdded event', function() {
    let emitted = null;
    lb.createPool('api');
    lb.on('instanceAdded', function(e) { emitted = e; });
    lb.addInstance('api', 'srv1', { weight: 5 });
    assert.strictEqual(emitted.instance, 'srv1');
    assert.strictEqual(emitted.weight, 5);
  });

  it('should select with round_robin', function() {
    lb.createPool('api', { strategy: 'round_robin' });
    lb.addInstance('api', 'srv1');
    lb.addInstance('api', 'srv2');
    const s1 = lb.select('api');
    const s2 = lb.select('api');
    assert.notStrictEqual(s1.id, s2.id);
  });

  it('should select with weighted strategy', function() {
    lb.createPool('api', { strategy: 'weighted' });
    lb.addInstance('api', 'heavy', { weight: 10 });
    lb.addInstance('api', 'light', { weight: 1 });
    const counts = { heavy: 0, light: 0 };
    for (let i = 0; i < 100; i++) {
      const s = lb.select('api');
      counts[s.id]++;
      lb.release('api', s.id);
    }
    assert.ok(counts.heavy > counts.light);
  });

  it('should select with least_connections', function() {
    lb.createPool('api', { strategy: 'least_connections' });
    lb.addInstance('api', 'srv1');
    lb.addInstance('api', 'srv2');
    lb.select('api');
    lb.select('api');
    const s = lb.select('api');
    assert.ok(s !== null);
  });

  it('should select with random strategy', function() {
    lb.createPool('api', { strategy: 'random' });
    lb.addInstance('api', 'srv1');
    lb.addInstance('api', 'srv2');
    const s = lb.select('api');
    assert.ok(s !== null);
  });

  it('should return null when no healthy instances', function() {
    lb.createPool('api');
    lb.addInstance('api', 'srv1');
    lb.markUnhealthy('api', 'srv1');
    let emitted = null;
    lb.on('noHealthyInstance', function(e) { emitted = e; });
    const result = lb.select('api');
    assert.strictEqual(result, null);
    assert.strictEqual(emitted.pool, 'api');
  });

  it('should emit selected event', function() {
    let emitted = null;
    lb.createPool('api');
    lb.addInstance('api', 'srv1');
    lb.on('selected', function(e) { emitted = e; });
    lb.select('api');
    assert.strictEqual(emitted.pool, 'api');
    assert.strictEqual(emitted.instance, 'srv1');
  });

  it('should release instance', function() {
    lb.createPool('api');
    lb.addInstance('api', 'srv1');
    const s = lb.select('api');
    assert.strictEqual(s.activeConnections, 1);
    lb.release('api', s.id);
    const info = lb.getPoolInfo('api');
    assert.strictEqual(info.instances[0].activeConnections, 0);
  });

  it('should mark healthy/unhealthy', function() {
    lb.createPool('api');
    lb.addInstance('api', 'srv1');
    let emitted = null;
    lb.on('instanceHealthChanged', function(e) { emitted = e; });
    lb.markUnhealthy('api', 'srv1');
    assert.strictEqual(emitted.healthy, false);
    const info1 = lb.getPoolInfo('api');
    assert.strictEqual(info1.healthyInstances, 0);
    lb.markHealthy('api', 'srv1');
    assert.strictEqual(emitted.healthy, true);
    const info2 = lb.getPoolInfo('api');
    assert.strictEqual(info2.healthyInstances, 1);
  });

  it('should remove instance', function() {
    lb.createPool('api');
    lb.addInstance('api', 'srv1');
    let emitted = null;
    lb.on('instanceRemoved', function(e) { emitted = e; });
    lb.removeInstance('api', 'srv1');
    assert.strictEqual(emitted.instance, 'srv1');
    assert.strictEqual(lb.getPoolInfo('api').totalInstances, 0);
  });

  it('should remove pool', function() {
    lb.createPool('api');
    let emitted = null;
    lb.on('poolRemoved', function(e) { emitted = e; });
    lb.removePool('api');
    assert.strictEqual(emitted.name, 'api');
    assert.strictEqual(lb.getPoolNames().length, 0);
  });

  it('should get pool info', function() {
    lb.createPool('api', { strategy: 'round_robin' });
    lb.addInstance('api', 'srv1');
    lb.addInstance('api', 'srv2');
    const info = lb.getPoolInfo('api');
    assert.strictEqual(info.strategy, 'round_robin');
    assert.strictEqual(info.totalInstances, 2);
    assert.strictEqual(info.healthyInstances, 2);
  });

  it('should return null for unknown pool info', function() {
    assert.strictEqual(lb.getPoolInfo('unknown'), null);
  });

  it('should get stats', function() {
    lb.createPool('api');
    lb.addInstance('api', 'srv1');
    lb.select('api');
    const stats = lb.getStats();
    assert.strictEqual(stats.totalPools, 1);
    assert.strictEqual(stats.totalSelected, 1);
  });

  it('should expose STRATEGIES', function() {
    assert.strictEqual(DeepeningLoadBalancer.STRATEGIES.ROUND_ROBIN, 'round_robin');
    assert.strictEqual(DeepeningLoadBalancer.STRATEGIES.WEIGHTED, 'weighted');
    assert.strictEqual(DeepeningLoadBalancer.STRATEGIES.LEAST_CONNECTIONS, 'least_connections');
    assert.strictEqual(DeepeningLoadBalancer.STRATEGIES.RANDOM, 'random');
  });

  it('should shutdown cleanly', function() {
    lb.createPool('api');
    let shutdownEmitted = false;
    lb.on('shutdown', function() { shutdownEmitted = true; });
    lb.shutdown();
    assert.strictEqual(shutdownEmitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(lb.isHealthy(), true);
  });
});

describe('DeepeningTimeoutManager', function() {
  let tm;

  beforeEach(function() {
    tm = new DeepeningTimeoutManager({ defaultTimeout: 5000 });
  });

  afterEach(function() {
    if (tm) tm.shutdown();
  });

  it('should create manager with defaults', function() {
    const t = new DeepeningTimeoutManager();
    assert.strictEqual(t.getStats().defaultTimeout, 30000);
    t.shutdown();
  });

  it('should set a timeout', function() {
    const id = tm.setTimeout('test-op', { duration: 10000 });
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(tm.getActiveCount(), 1);
  });

  it('should throw on setTimeout without name', function() {
    assert.throws(function() { tm.setTimeout(''); }, /Timeout name is required/);
  });

  it('should emit created event', function() {
    let emitted = null;
    tm.on('created', function(e) { emitted = e; });
    tm.setTimeout('test-op', { duration: 5000 });
    assert.strictEqual(emitted.name, 'test-op');
    assert.strictEqual(emitted.duration, 5000);
  });

  it('should cancel a timeout', function() {
    const id = tm.setTimeout('test-op', { duration: 10000 });
    let emitted = null;
    tm.on('cancelled', function(e) { emitted = e; });
    const result = tm.cancel(id);
    assert.strictEqual(result, true);
    assert.strictEqual(emitted.id, id);
    assert.strictEqual(tm.getActiveCount(), 0);
  });

  it('should return false for cancelling unknown timeout', function() {
    assert.strictEqual(tm.cancel(9999), false);
  });

  it('should complete a timeout', function() {
    const id = tm.setTimeout('test-op', { duration: 10000 });
    let emitted = null;
    tm.on('completed', function(e) { emitted = e; });
    const result = tm.complete(id);
    assert.strictEqual(result, true);
    assert.strictEqual(emitted.name, 'test-op');
    assert.ok(emitted.elapsed >= 0);
  });

  it('should return false for completing unknown timeout', function() {
    assert.strictEqual(tm.complete(9999), false);
  });

  it('should get remaining time', function() {
    const id = tm.setTimeout('test-op', { duration: 10000 });
    const remaining = tm.getRemaining(id);
    assert.ok(remaining > 0 && remaining <= 10000);
  });

  it('should return 0 for unknown remaining', function() {
    assert.strictEqual(tm.getRemaining(9999), 0);
  });

  it('should get deadline', function() {
    const id = tm.setTimeout('test-op', { duration: 10000 });
    const deadline = tm.getDeadline(id);
    assert.ok(deadline > Date.now());
  });

  it('should return null for unknown deadline', function() {
    assert.strictEqual(tm.getDeadline(9999), null);
  });

  it('should get info', function() {
    const id = tm.setTimeout('test-op', { duration: 10000 });
    const info = tm.getInfo(id);
    assert.strictEqual(info.name, 'test-op');
    assert.strictEqual(info.state, 'running');
    assert.ok(info.remaining > 0);
  });

  it('should return null for unknown info', function() {
    assert.strictEqual(tm.getInfo(9999), null);
  });

  it('should get active timeouts sorted by deadline', function() {
    tm.setTimeout('slow', { duration: 30000 });
    tm.setTimeout('fast', { duration: 5000 });
    const active = tm.getActive();
    assert.strictEqual(active.length, 2);
    assert.strictEqual(active[0].name, 'fast');
    assert.strictEqual(active[1].name, 'slow');
  });

  it('should expire and emit event', async function() {
    let emitted = null;
    tm.on('expired', function(e) { emitted = e; });
    tm.setTimeout('quick', { duration: 50 });
    await new Promise(function(r) { setTimeout(r, 100); });
    assert.strictEqual(emitted.name, 'quick');
    assert.strictEqual(tm.getActiveCount(), 0);
  });

  it('should call onTimeout callback on expiry', async function() {
    let called = false;
    tm.setTimeout('quick', { duration: 50, onTimeout: function() { called = true; } });
    await new Promise(function(r) { setTimeout(r, 100); });
    assert.strictEqual(called, true);
  });

  it('should cancel all timeouts', function() {
    tm.setTimeout('a', { duration: 10000 });
    tm.setTimeout('b', { duration: 10000 });
    let emitted = null;
    tm.on('cancelledAll', function(e) { emitted = e; });
    const count = tm.cancelAll();
    assert.strictEqual(count, 2);
    assert.strictEqual(emitted.count, 2);
    assert.strictEqual(tm.getActiveCount(), 0);
  });

  it('should wrap a sync function', function() {
    const wrapped = tm.wrap(function(x) { return x * 2; }, { name: 'double' });
    const result = wrapped(5);
    assert.strictEqual(result, 10);
  });

  it('should wrap an async function', async function() {
    const wrapped = tm.wrap(async function() { return 42; }, { name: 'async-op' });
    const result = await wrapped();
    assert.strictEqual(result, 42);
  });

  it('should throw on wrap without function', function() {
    assert.throws(function() { tm.wrap('not fn'); }, /fn must be a function/);
  });

  it('should get stats', function() {
    const id = tm.setTimeout('test', { duration: 10000 });
    tm.complete(id);
    const stats = tm.getStats();
    assert.strictEqual(stats.totalCreated, 1);
    assert.strictEqual(stats.totalCompleted, 1);
    assert.strictEqual(stats.completionRate, '100.0');
  });

  it('should shutdown cleanly', function() {
    tm.setTimeout('test', { duration: 10000 });
    let shutdownEmitted = false;
    tm.on('shutdown', function() { shutdownEmitted = true; });
    tm.shutdown();
    assert.strictEqual(shutdownEmitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(tm.isHealthy(), true);
  });
});
