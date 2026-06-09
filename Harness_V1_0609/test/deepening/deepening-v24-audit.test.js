'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningAuditTrail = require('../../src/runtime/deepening/deepening-audit-trail');

describe('DeepeningAuditTrail - Record and Query', function() {
  let at;

  beforeEach(function() {
    at = new DeepeningAuditTrail({ maxEntries: 100 });
  });

  afterEach(function() {
    if (at) at.shutdown();
  });

  it('should create with defaults', function() {
    const a = new DeepeningAuditTrail();
    assert.strictEqual(a.getStats().totalEntries, 0);
    a.shutdown();
  });

  it('should record an entry', function() {
    const entry = at.record('user.login', { actor: 'alice' });
    assert.strictEqual(typeof entry, 'object');
    assert.strictEqual(entry.action, 'user.login');
    assert.strictEqual(entry.actor, 'alice');
  });

  it('should throw on record without action', function() {
    assert.throws(function() { at.record(''); }, /Action must be a non-empty string/);
  });

  it('should emit recorded event', function() {
    let emitted = null;
    at.on('recorded', function(e) { emitted = e; });
    at.record('user.login', { actor: 'alice' });
    assert.strictEqual(emitted.action, 'user.login');
    assert.strictEqual(emitted.actor, 'alice');
  });

  it('should emit audit-recorded for backward compat', function() {
    let emitted = null;
    at.on('audit-recorded', function(e) { emitted = e; });
    at.record('user.login', { actor: 'alice' });
    assert.strictEqual(emitted.action, 'user.login');
  });

  it('should record with all options', function() {
    const recorded = at.record('file.delete', {
      actor: 'bob',
      resource: '/tmp/test.txt',
      details: 'Deleted temp file',
      result: 'success',
      category: 'file',
      severity: 'warning',
      metadata: { ip: '127.0.0.1' },
    });
    const entry = at.getEntry(recorded.id);
    assert.strictEqual(entry.actor, 'bob');
    assert.strictEqual(entry.resource, '/tmp/test.txt');
    assert.strictEqual(entry.result, 'success');
    assert.strictEqual(entry.category, 'file');
    assert.strictEqual(entry.severity, 'warning');
  });

  it('should get entry by id', function() {
    const recorded = at.record('test');
    const entry = at.getEntry(recorded.id);
    assert.strictEqual(entry.action, 'test');
  });

  it('should return null for unknown entry', function() {
    assert.strictEqual(at.getEntry(999), null);
  });

  it('should get entries with filters', function() {
    at.record('a', { actor: 'alice' });
    at.record('b', { actor: 'bob' });
    at.record('a', { actor: 'alice' });
    const results = at.getEntries({ action: 'a' });
    assert.strictEqual(results.length, 2);
  });

  it('should get entries with actor filter', function() {
    at.record('a', { actor: 'alice' });
    at.record('b', { actor: 'bob' });
    const results = at.getEntries({ actor: 'alice' });
    assert.strictEqual(results.length, 1);
  });

  it('should get entries with limit and offset', function() {
    for (let i = 0; i < 10; i++) at.record('test');
    const results = at.getEntries({ limit: 3, offset: 5 });
    assert.strictEqual(results.length, 3);
  });

  it('should get by action', function() {
    at.record('login');
    at.record('logout');
    at.record('login');
    const results = at.getByAction('login');
    assert.strictEqual(results.length, 2);
  });

  it('should get by actor', function() {
    at.record('test', { actor: 'alice' });
    at.record('test', { actor: 'bob' });
    at.record('test', { actor: 'alice' });
    const results = at.getByActor('alice');
    assert.strictEqual(results.length, 2);
  });

  it('should get by resource', function() {
    at.record('read', { resource: 'file1' });
    at.record('read', { resource: 'file2' });
    at.record('write', { resource: 'file1' });
    const results = at.getByResource('file1');
    assert.strictEqual(results.length, 2);
  });

  it('should get by category', function() {
    at.record('test', { category: 'auth' });
    at.record('test', { category: 'file' });
    const results = at.getByCategory('auth');
    assert.strictEqual(results.length, 1);
  });

  it('should get by severity', function() {
    at.record('test', { severity: 'error' });
    at.record('test', { severity: 'info' });
    const results = at.getBySeverity('error');
    assert.strictEqual(results.length, 1);
  });

  it('should get failures', function() {
    at.record('test', { result: 'success' });
    at.record('test', { result: 'failure' });
    at.record('test', { result: 'failure' });
    const results = at.getFailures();
    assert.strictEqual(results.length, 2);
  });
});

describe('DeepeningAuditTrail - Filters and Stats', function() {
  let at;

  beforeEach(function() {
    at = new DeepeningAuditTrail({ maxEntries: 100 });
  });

  afterEach(function() {
    if (at) at.shutdown();
  });

  it('should support filters', function() {
    at.addFilter(function(entry) { return entry.severity !== 'debug'; });
    const result = at.record('test', { severity: 'debug' });
    assert.strictEqual(result, null);
    const result2 = at.record('test', { severity: 'info' });
    assert.strictEqual(typeof result2, 'object');
  });

  it('should emit filtered event', function() {
    let emitted = null;
    at.addFilter(function() { return false; });
    at.on('filtered', function(e) { emitted = e; });
    at.record('test');
    assert.strictEqual(emitted.action, 'test');
  });

  it('should remove filter', function() {
    const fn = function() { return false; };
    at.addFilter(fn);
    at.record('test');
    assert.strictEqual(at.getStats().totalFiltered, 1);
    at.removeFilter(fn);
    at.record('test2');
    assert.strictEqual(at.getStats().totalFiltered, 1);
  });

  it('should throw on add filter without function', function() {
    assert.throws(function() { at.addFilter('not-fn'); }, /Filter must be a function/);
  });

  it('should get action counts', function() {
    at.record('login');
    at.record('login');
    at.record('logout');
    const counts = at.getActionCounts();
    assert.strictEqual(counts.login, 2);
    assert.strictEqual(counts.logout, 1);
  });

  it('should get actor counts', function() {
    at.record('test', { actor: 'alice' });
    at.record('test', { actor: 'alice' });
    at.record('test', { actor: 'bob' });
    const counts = at.getActorCounts();
    assert.strictEqual(counts.alice, 2);
    assert.strictEqual(counts.bob, 1);
  });

  it('should get severity counts', function() {
    at.record('test', { severity: 'info' });
    at.record('test', { severity: 'error' });
    at.record('test', { severity: 'critical' });
    const counts = at.getSeverityCounts();
    assert.strictEqual(counts.info, 1);
    assert.strictEqual(counts.error, 1);
    assert.strictEqual(counts.critical, 1);
  });

  it('should limit entries', function() {
    const small = new DeepeningAuditTrail({ maxEntries: 5 });
    for (let i = 0; i < 10; i++) small.record('test');
    assert.strictEqual(small.getStats().totalEntries, 5);
    small.shutdown();
  });

  it('should clear entries', function() {
    at.record('test');
    at.record('test');
    const count = at.clear();
    assert.strictEqual(count, 2);
    assert.strictEqual(at.getStats().totalEntries, 0);
  });

  it('should get stats', function() {
    at.record('test', { result: 'success' });
    at.record('test', { result: 'failure' });
    const stats = at.getStats();
    assert.strictEqual(stats.totalEntries, 2);
    assert.strictEqual(stats.totalRecorded, 2);
    assert.strictEqual(stats.byResult.success, 1);
    assert.strictEqual(stats.byResult.failure, 1);
  });

  it('should shutdown cleanly', function() {
    at.record('test');
    let emitted = false;
    at.on('shutdown', function() { emitted = true; });
    at.shutdown();
    assert.strictEqual(emitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(at.isHealthy(), true);
  });
});
