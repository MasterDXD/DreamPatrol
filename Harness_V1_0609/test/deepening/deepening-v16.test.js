'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');
const DeepeningRateLimiter = require('../../src/runtime/deepening/deepening-rate-limiter');
const DeepeningSnapshotStore = require('../../src/runtime/deepening/deepening-snapshot-store');


describe('DeepeningRateLimiter', function() {
  let rl;

  beforeEach(function() {
    rl = new DeepeningRateLimiter({ defaultRate: 10, defaultCapacity: 5, refillInterval: 1000 });
  });

  it('should create limiter with default options', function() {
    const r = new DeepeningRateLimiter();
    assert.strictEqual(r.getStats().defaultRate, 10);
    assert.strictEqual(r.getStats().defaultCapacity, 10);
  });

  it('should create a bucket', function() {
    rl.createBucket('api');
    assert.strictEqual(rl.getBucketNames().length, 1);
    assert.strictEqual(rl.getBucketNames()[0], 'api');
  });

  it('should throw on create bucket without name', function() {
    assert.throws(function() { rl.createBucket(''); }, /Bucket name is required/);
  });

  it('should not duplicate bucket', function() {
    rl.createBucket('api');
    rl.createBucket('api');
    assert.strictEqual(rl.getBucketNames().length, 1);
  });

  it('should emit bucketCreated event', function() {
    let emitted = null;
    rl.on('bucketCreated', function(e) { emitted = e; });
    rl.createBucket('api', { rate: 5, capacity: 10 });
    assert.strictEqual(emitted.name, 'api');
    assert.strictEqual(emitted.rate, 5);
    assert.strictEqual(emitted.capacity, 10);
  });

  it('should tryConsume from bucket', function() {
    rl.createBucket('api', { rate: 10, capacity: 5 });
    const result = rl.tryConsume('api');
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.tokensRemaining < 5, true);
  });

  it('should deny when tokens exhausted', function() {
    rl.createBucket('api', { rate: 1, capacity: 2 });
    rl.tryConsume('api');
    rl.tryConsume('api');
    const result = rl.tryConsume('api');
    assert.strictEqual(result.allowed, false);
    assert.ok(result.retryAfter > 0);
  });

  it('should throw on consume from unknown bucket', function() {
    assert.throws(function() { rl.tryConsume('unknown'); }, /Bucket not found/);
  });

  it('should emit allowed event', function() {
    let emitted = null;
    rl.createBucket('api');
    rl.on('allowed', function(e) { emitted = e; });
    rl.tryConsume('api');
    assert.strictEqual(emitted.name, 'api');
  });

  it('should emit denied event', function() {
    let emitted = null;
    rl.createBucket('api', { rate: 1, capacity: 1 });
    rl.on('denied', function(e) { emitted = e; });
    rl.tryConsume('api');
    rl.tryConsume('api');
    assert.strictEqual(emitted.name, 'api');
    assert.ok(emitted.retryAfter > 0);
  });

  it('should consume multiple tokens', function() {
    rl.createBucket('api', { rate: 10, capacity: 10 });
    const result = rl.tryConsume('api', 3);
    assert.strictEqual(result.allowed, true);
  });

  it('should get bucket info', function() {
    rl.createBucket('api', { rate: 5, capacity: 10 });
    const info = rl.getBucket('api');
    assert.strictEqual(info.name, 'api');
    assert.strictEqual(info.rate, 5);
    assert.strictEqual(info.capacity, 10);
    assert.strictEqual(info.allowed, 0);
    assert.strictEqual(info.denied, 0);
  });

  it('should return null for unknown bucket', function() {
    assert.strictEqual(rl.getBucket('unknown'), null);
  });

  it('should remove bucket', function() {
    rl.createBucket('api');
    let emitted = null;
    rl.on('bucketRemoved', function(e) { emitted = e; });
    const result = rl.removeBucket('api');
    assert.strictEqual(result, true);
    assert.strictEqual(emitted.name, 'api');
    assert.strictEqual(rl.getBucketNames().length, 0);
  });

  it('should return false for removing unknown bucket', function() {
    assert.strictEqual(rl.removeBucket('unknown'), false);
  });

  it('should reset bucket', function() {
    rl.createBucket('api', { rate: 1, capacity: 2 });
    rl.tryConsume('api');
    rl.tryConsume('api');
    let emitted = null;
    rl.on('bucketReset', function(e) { emitted = e; });
    rl.resetBucket('api');
    assert.strictEqual(emitted.name, 'api');
    const info = rl.getBucket('api');
    assert.strictEqual(info.allowed, 0);
    assert.strictEqual(info.denied, 0);
  });

  it('should return false for resetting unknown bucket', function() {
    assert.strictEqual(rl.resetBucket('unknown'), false);
  });

  it('should update rate', function() {
    rl.createBucket('api');
    let emitted = null;
    rl.on('rateUpdated', function(e) { emitted = e; });
    rl.updateRate('api', 20);
    assert.strictEqual(emitted.newRate, 20);
    assert.strictEqual(rl.getBucket('api').rate, 20);
  });

  it('should throw on update rate for unknown bucket', function() {
    assert.throws(function() { rl.updateRate('unknown', 10); }, /Bucket not found/);
  });

  it('should throw on invalid rate', function() {
    rl.createBucket('api');
    assert.throws(function() { rl.updateRate('api', -1); }, /Rate must be a positive number/);
  });

  it('should get stats', function() {
    rl.createBucket('api');
    rl.createBucket('web');
    rl.tryConsume('api');
    const stats = rl.getStats();
    assert.strictEqual(stats.totalBuckets, 2);
    assert.strictEqual(stats.totalAllowed, 1);
    assert.strictEqual(stats.totalDenied, 0);
    assert.ok(stats.buckets.api);
    assert.ok(stats.buckets.web);
  });

  it('should compute utilization', function() {
    rl.createBucket('api', { rate: 10, capacity: 10 });
    rl.tryConsume('api', 5);
    const info = rl.getBucket('api');
    assert.ok(parseFloat(info.utilization) > 0);
  });

  it('should shutdown cleanly', function() {
    rl.createBucket('api');
    let shutdownEmitted = false;
    rl.on('shutdown', function() { shutdownEmitted = true; });
    rl.shutdown();
    assert.strictEqual(shutdownEmitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(rl.isHealthy(), true);
  });
});

describe('DeepeningSnapshotStore', function() {
  let ss;

  beforeEach(function() {
    ss = new DeepeningSnapshotStore({ maxSnapshots: 50, maxVersions: 5 });
  });

  it('should create store with default options', function() {
    const s = new DeepeningSnapshotStore();
    assert.strictEqual(s.getStats().maxSnapshots, 50);
    assert.strictEqual(s.getStats().maxVersions, 10);
  });

  it('should capture a snapshot', function() {
    const id = ss.capture('config', { key: 'value' });
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(ss.getStats().totalSnapshots, 1);
  });

  it('should throw on capture without name', function() {
    assert.throws(function() { ss.capture('', { a: 1 }); }, /Snapshot name is required/);
  });

  it('should throw on capture without state', function() {
    assert.throws(function() { ss.capture('test', null); }, /State is required/);
  });

  it('should emit captured event', function() {
    let emitted = null;
    ss.on('captured', function(e) { emitted = e; });
    ss.capture('config', { key: 'value' });
    assert.strictEqual(emitted.name, 'config');
    assert.strictEqual(emitted.version, 1);
  });

  it('should restore a snapshot', function() {
    const id = ss.capture('config', { key: 'value' });
    const state = ss.restore(id);
    assert.deepStrictEqual(state, { key: 'value' });
  });

  it('should return null for unknown snapshot', function() {
    assert.strictEqual(ss.restore(9999), null);
  });

  it('should emit restored event', function() {
    const id = ss.capture('config', { key: 'value' });
    let emitted = null;
    ss.on('restored', function(e) { emitted = e; });
    ss.restore(id);
    assert.strictEqual(emitted.id, id);
    assert.strictEqual(emitted.name, 'config');
  });

  it('should restore latest by name', function() {
    ss.capture('config', { v: 1 });
    ss.capture('config', { v: 2 });
    const state = ss.restoreLatest('config');
    assert.deepStrictEqual(state, { v: 2 });
  });

  it('should return null for restoreLatest unknown name', function() {
    assert.strictEqual(ss.restoreLatest('unknown'), null);
  });

  it('should track versions', function() {
    ss.capture('config', { v: 1 });
    ss.capture('config', { v: 2 });
    ss.capture('config', { v: 3 });
    const versions = ss.getVersions('config');
    assert.strictEqual(versions.length, 3);
    assert.strictEqual(versions[0].version, 1);
    assert.strictEqual(versions[2].version, 3);
  });

  it('should limit versions per name', function() {
    for (let i = 0; i < 8; i++) {
      ss.capture('config', { v: i });
    }
    const versions = ss.getVersions('config');
    assert.strictEqual(versions.length, 5);
  });

  it('should get snapshot metadata', function() {
    const id = ss.capture('config', { key: 'value' }, { author: 'test' });
    const meta = ss.get(id);
    assert.strictEqual(meta.name, 'config');
    assert.strictEqual(meta.version, 1);
    assert.strictEqual(meta.metadata.author, 'test');
    assert.ok(meta.size > 0);
  });

  it('should return null for unknown snapshot metadata', function() {
    assert.strictEqual(ss.get(9999), null);
  });

  it('should get names', function() {
    ss.capture('config', {});
    ss.capture('state', {});
    assert.deepStrictEqual(ss.getNames(), ['config', 'state']);
  });

  it('should compare snapshots', function() {
    const id1 = ss.capture('config', { a: 1, b: 2, c: 3 });
    const id2 = ss.capture('config', { a: 1, b: 99, d: 4 });
    const diff = ss.compare(id1, id2);
    assert.deepStrictEqual(diff.added, ['d']);
    assert.deepStrictEqual(diff.removed, ['c']);
    assert.deepStrictEqual(diff.changed, ['b']);
    assert.deepStrictEqual(diff.unchanged, ['a']);
  });

  it('should return null for comparing unknown snapshots', function() {
    assert.strictEqual(ss.compare(9999, 8888), null);
  });

  it('should delete a snapshot', function() {
    const id = ss.capture('config', { key: 'value' });
    let emitted = null;
    ss.on('deleted', function(e) { emitted = e; });
    const result = ss.delete(id);
    assert.strictEqual(result, true);
    assert.strictEqual(emitted.id, id);
    assert.strictEqual(ss.restore(id), null);
  });

  it('should return false for deleting unknown snapshot', function() {
    assert.strictEqual(ss.delete(9999), false);
  });

  it('should delete by name', function() {
    ss.capture('config', { v: 1 });
    ss.capture('config', { v: 2 });
    let emitted = null;
    ss.on('deletedByName', function(e) { emitted = e; });
    const count = ss.deleteByName('config');
    assert.strictEqual(count, 2);
    assert.strictEqual(emitted.name, 'config');
    assert.strictEqual(emitted.count, 2);
  });

  it('should return 0 for deleting unknown name', function() {
    assert.strictEqual(ss.deleteByName('unknown'), 0);
  });

  it('should evict oldest when maxSnapshots exceeded', function() {
    const small = new DeepeningSnapshotStore({ maxSnapshots: 3, maxVersions: 10 });
    small.capture('a', { v: 1 });
    small.capture('b', { v: 1 });
    small.capture('c', { v: 1 });
    small.capture('d', { v: 1 });
    assert.strictEqual(small.getStats().totalSnapshots, 3);
  });

  it('should deep clone state', function() {
    const state = { nested: { key: 'value' } };
    const id = ss.capture('config', state);
    state.nested.key = 'modified';
    const restored = ss.restore(id);
    assert.strictEqual(restored.nested.key, 'value');
  });

  it('should clear all snapshots', function() {
    ss.capture('config', {});
    ss.capture('state', {});
    let clearedEmitted = false;
    ss.on('cleared', function() { clearedEmitted = true; });
    ss.clear();
    assert.strictEqual(ss.getStats().totalSnapshots, 0);
    assert.strictEqual(clearedEmitted, true);
  });

  it('should get stats', function() {
    const id1 = ss.capture('config', { key: 'value' });
    ss.capture('config', { key: 'value2' });
    ss.restore(id1);
    const stats = ss.getStats();
    assert.strictEqual(stats.totalSnapshots, 2);
    assert.strictEqual(stats.totalNames, 1);
    assert.strictEqual(stats.totalCreated, 2);
    assert.strictEqual(stats.totalRestored, 1);
    assert.ok(stats.totalSizeBytes > 0);
  });

  it('should shutdown cleanly', function() {
    ss.capture('config', {});
    let shutdownEmitted = false;
    ss.on('shutdown', function() { shutdownEmitted = true; });
    ss.shutdown();
    assert.strictEqual(shutdownEmitted, true);
    assert.strictEqual(ss.getStats().totalSnapshots, 0);
  });

  it('should be healthy', function() {
    assert.strictEqual(ss.isHealthy(), true);
  });
});
