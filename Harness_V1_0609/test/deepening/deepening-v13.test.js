'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');
const DeepeningLockManager = require('../../src/runtime/deepening/deepening-lock-manager');
const DeepeningEventReplay = require('../../src/runtime/deepening/deepening-event-replay');


describe('DeepeningLockManager', function() {
  let lockManager;

  beforeEach(function() {
    lockManager = new DeepeningLockManager({ defaultTimeout: 5000, maxLocks: 100 });
  });

  it('should create lock manager with default options', function() {
    const lm = new DeepeningLockManager();
    assert.strictEqual(lm.getStats().defaultTimeout, 300000);
    assert.strictEqual(lm.getStats().maxLocks, 1000);
  });

  it('should acquire a lock', function() {
    const result = lockManager.acquire('resource1', 'owner1');
    assert.strictEqual(result, true);
    assert.strictEqual(lockManager.isLocked('resource1'), true);
  });

  it('should throw on missing args', function() {
    assert.throws(function() { lockManager.acquire('', 'owner'); }, /resourceId and ownerId are required/);
    assert.throws(function() { lockManager.acquire('res', ''); }, /resourceId and ownerId are required/);
  });

  it('should deny lock when held by another owner', function() {
    lockManager.acquire('resource1', 'owner1');
    const result = lockManager.acquire('resource1', 'owner2');
    assert.strictEqual(result, false);
  });

  it('should allow reentrant lock by same owner', function() {
    lockManager.acquire('resource1', 'owner1');
    const result = lockManager.acquire('resource1', 'owner1');
    assert.strictEqual(result, true);
    const lock = lockManager.getLock('resource1');
    assert.strictEqual(lock.refCount, 2);
  });

  it('should release a lock', function() {
    lockManager.acquire('resource1', 'owner1');
    const result = lockManager.release('resource1', 'owner1');
    assert.strictEqual(result, true);
    assert.strictEqual(lockManager.isLocked('resource1'), false);
  });

  it('should decrement refCount on reentrant release', function() {
    lockManager.acquire('resource1', 'owner1');
    lockManager.acquire('resource1', 'owner1');
    lockManager.release('resource1', 'owner1');
    assert.strictEqual(lockManager.isLocked('resource1'), true);
    assert.strictEqual(lockManager.getLock('resource1').refCount, 1);
    lockManager.release('resource1', 'owner1');
    assert.strictEqual(lockManager.isLocked('resource1'), false);
  });

  it('should deny release by different owner', function() {
    lockManager.acquire('resource1', 'owner1');
    const result = lockManager.release('resource1', 'owner2');
    assert.strictEqual(result, false);
  });

  it('should return false for releasing non-existent lock', function() {
    assert.strictEqual(lockManager.release('nonexistent', 'owner1'), false);
  });

  it('should force release a lock', function() {
    lockManager.acquire('resource1', 'owner1');
    const result = lockManager.forceRelease('resource1');
    assert.strictEqual(result, true);
    assert.strictEqual(lockManager.isLocked('resource1'), false);
  });

  it('should return false for force releasing non-existent lock', function() {
    assert.strictEqual(lockManager.forceRelease('nonexistent'), false);
  });

  it('should get lock info', function() {
    lockManager.acquire('resource1', 'owner1');
    const lock = lockManager.getLock('resource1');
    assert.strictEqual(lock.resourceId, 'resource1');
    assert.strictEqual(lock.ownerId, 'owner1');
    assert.strictEqual(lock.refCount, 1);
    assert.ok(lock.elapsed >= 0);
  });

  it('should return null for non-existent lock', function() {
    assert.strictEqual(lockManager.getLock('nonexistent'), null);
  });

  it('should get locks by owner', function() {
    lockManager.acquire('res1', 'owner1');
    lockManager.acquire('res2', 'owner1');
    lockManager.acquire('res3', 'owner2');
    const locks = lockManager.getLocksByOwner('owner1');
    assert.strictEqual(locks.length, 2);
  });

  it('should enforce max locks limit', function() {
    const lm = new DeepeningLockManager({ maxLocks: 2 });
    lm.acquire('res1', 'owner1');
    lm.acquire('res2', 'owner1');
    const result = lm.acquire('res3', 'owner1');
    assert.strictEqual(result, false);
  });

  it('should expire locks after timeout', async function() {
    const lm = new DeepeningLockManager({ defaultTimeout: 50 });
    lm.acquire('resource1', 'owner1');
    assert.strictEqual(lm.isLocked('resource1'), true);
    await new Promise(function(r) { setTimeout(r, 100); });
    assert.strictEqual(lm.isLocked('resource1'), false);
  });

  it('should emit acquired event', function() {
    let emitted = null;
    lockManager.on('acquired', function(e) { emitted = e; });
    lockManager.acquire('resource1', 'owner1');
    assert.ok(emitted);
    assert.strictEqual(emitted.resourceId, 'resource1');
    assert.strictEqual(emitted.ownerId, 'owner1');
  });

  it('should emit denied event', function() {
    lockManager.acquire('resource1', 'owner1');
    let emitted = null;
    lockManager.on('denied', function(e) { emitted = e; });
    lockManager.acquire('resource1', 'owner2');
    assert.ok(emitted);
    assert.strictEqual(emitted.ownerId, 'owner2');
  });

  it('should emit released event', function() {
    lockManager.acquire('resource1', 'owner1');
    let emitted = null;
    lockManager.on('released', function(e) { emitted = e; });
    lockManager.release('resource1', 'owner1');
    assert.ok(emitted);
    assert.strictEqual(emitted.resourceId, 'resource1');
  });

  it('should emit expired event', async function() {
    const lm = new DeepeningLockManager({ defaultTimeout: 50 });
    let emitted = null;
    lm.on('expired', function(e) { emitted = e; });
    lm.acquire('resource1', 'owner1');
    await new Promise(function(r) { setTimeout(r, 100); });
    assert.ok(emitted);
    assert.strictEqual(emitted.resourceId, 'resource1');
  });

  it('should get stats', function() {
    lockManager.acquire('res1', 'owner1');
    lockManager.acquire('res2', 'owner1');
    const stats = lockManager.getStats();
    assert.strictEqual(stats.activeLocks, 2);
    assert.strictEqual(stats.totalRefCount, 2);
  });

  it('should shutdown cleanly', function() {
    lockManager.acquire('resource1', 'owner1');
    lockManager.shutdown();
    assert.strictEqual(lockManager.isLocked('resource1'), false);
    assert.strictEqual(lockManager.isHealthy(), false);
  });

  it('should get expired locks', function() {
    const lm = new DeepeningLockManager({ defaultTimeout: 50 });
    lm.acquire('resource1', 'owner1');
    lm.acquire('resource2', 'owner2', { timeout: 60000 });
    const expired = lm.getExpiredLocks();
    assert.strictEqual(expired.length, 0);
  });

  it('should release expired locks', function() {
    const lm = new DeepeningLockManager({ defaultTimeout: 50 });
    lm.acquire('resource1', 'owner1');
    lm.acquire('resource2', 'owner2', { timeout: 60000 });
    const released = lm.releaseExpiredLocks();
    assert.strictEqual(released.length, 0);
  });
});

describe('DeepeningEventReplay', function() {
  let replay;

  beforeEach(function() {
    replay = new DeepeningEventReplay({ maxSize: 1000, speed: 100 });
  });

  it('should create replay with default options', function() {
    const r = new DeepeningEventReplay();
    assert.strictEqual(r.getStats().maxSize, 10000);
    assert.strictEqual(r.getStats().totalEvents, 0);
  });

  it('should record events', function() {
    const id = replay.record('test.event', { key: 'value' });
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(replay.getEventCount(), 1);
  });

  it('should throw on missing eventType', function() {
    assert.throws(function() { replay.record(''); }, /eventType is required/);
  });

  it('should record events with metadata', function() {
    replay.record('test.event', { data: 1 }, { source: 'unit-test' });
    const events = replay.getEvents();
    assert.strictEqual(events[0].metadata.source, 'unit-test');
  });

  it('should get events by type', function() {
    replay.record('type.a', {});
    replay.record('type.b', {});
    replay.record('type.a', {});
    const events = replay.getEvents({ type: 'type.a' });
    assert.strictEqual(events.length, 2);
  });

  it('should get events by time range', function() {
    const now = Date.now();
    replay.record('old', {});
    const events = replay.getEvents({ since: now });
    assert.ok(events.length <= 1);
  });

  it('should get events with limit', function() {
    for (let i = 0; i < 10; i++) replay.record('test', { i: i });
    const events = replay.getEvents({ limit: 3 });
    assert.strictEqual(events.length, 3);
  });

  it('should get event by id', function() {
    const id = replay.record('test', { value: 42 });
    const event = replay.getEvent(id);
    assert.strictEqual(event.type, 'test');
    assert.deepStrictEqual(event.data, { value: 42 });
  });

  it('should return null for non-existent event', function() {
    assert.strictEqual(replay.getEvent(99999), null);
  });

  it('should get event count by type', function() {
    replay.record('type.a', {});
    replay.record('type.b', {});
    replay.record('type.a', {});
    assert.strictEqual(replay.getEventCount('type.a'), 2);
    assert.strictEqual(replay.getEventCount('type.b'), 1);
  });

  it('should get event types', function() {
    replay.record('alpha', {});
    replay.record('beta', {});
    const types = replay.getEventTypes();
    assert.ok(types.indexOf('alpha') >= 0);
    assert.ok(types.indexOf('beta') >= 0);
  });

  it('should register and use filters', function() {
    replay.registerFilter('high-priority', function(e) { return e.data.priority === 'high'; });
    replay.record('task', { priority: 'high' });
    replay.record('task', { priority: 'low' });
    replay.record('task', { priority: 'high' });
    const count = replay.replay({ filters: ['high-priority'] });
    assert.strictEqual(count, 2);
  });

  it('should throw on invalid filter registration', function() {
    assert.throws(function() { replay.registerFilter('', function() {}); }, /Name and filterFn are required/);
    assert.throws(function() { replay.registerFilter('test', null); }, /Name and filterFn are required/);
  });

  it('should unregister filters', function() {
    replay.registerFilter('test', function() { return true; });
    replay.unregisterFilter('test');
    assert.strictEqual(replay.getStats().filtersRegistered, 0);
  });

  it('should replay events synchronously', function() {
    replay.record('event1', {});
    replay.record('event2', {});
    const count = replay.replay();
    assert.strictEqual(count, 2);
  });

  it('should replay events by type', function() {
    replay.record('type.a', {});
    replay.record('type.b', {});
    replay.record('type.a', {});
    const count = replay.replay({ type: 'type.a' });
    assert.strictEqual(count, 2);
  });

  it('should emit replay event', function() {
    let count = 0;
    replay.on('replay', function() { count++; });
    replay.record('test', {});
    replay.record('test', {});
    replay.replay();
    assert.strictEqual(count, 2);
  });

  it('should emit replayComplete event', function() {
    let emitted = null;
    replay.on('replayComplete', function(e) { emitted = e; });
    replay.record('test', {});
    replay.record('test', {});
    replay.replay();
    assert.ok(emitted);
    assert.strictEqual(emitted.count, 2);
  });

  it('should emit recorded event', function() {
    let emitted = null;
    replay.on('recorded', function(e) { emitted = e; });
    replay.record('test', {});
    assert.ok(emitted);
    assert.strictEqual(emitted.type, 'test');
  });

  it('should start and stop async replay', async function() {
    replay.record('event1', {});
    replay.record('event2', {});
    const count = await replay.startReplay({ speed: 100 });
    assert.strictEqual(count, 2);
    assert.strictEqual(replay.isPlaying(), false);
  });

  it('should stop replay', function() {
    for (let i = 0; i < 100; i++) replay.record('event', { i: i });
    replay.startReplay({ speed: 1 });
    assert.strictEqual(replay.isPlaying(), true);
    replay.stopReplay();
    assert.strictEqual(replay.isPlaying(), false);
  });

  it('should clear events', function() {
    replay.record('test', {});
    replay.clear();
    assert.strictEqual(replay.getEventCount(), 0);
  });

  it('should emit cleared event', function() {
    let emitted = false;
    replay.on('cleared', function() { emitted = true; });
    replay.clear();
    assert.strictEqual(emitted, true);
  });

  it('should limit max size', function() {
    const r = new DeepeningEventReplay({ maxSize: 5 });
    for (let i = 0; i < 10; i++) r.record('test', { i: i });
    assert.strictEqual(r.getEventCount(), 5);
  });

  it('should get stats', function() {
    replay.record('type.a', {});
    replay.record('type.b', {});
    const stats = replay.getStats();
    assert.strictEqual(stats.totalEvents, 2);
    assert.strictEqual(stats.eventTypes, 2);
    assert.ok(stats.typeCounts['type.a'] === 1);
  });

  it('should shutdown cleanly', function() {
    replay.record('test', {});
    replay.shutdown();
    assert.strictEqual(replay.isHealthy(), false);
  });
});
