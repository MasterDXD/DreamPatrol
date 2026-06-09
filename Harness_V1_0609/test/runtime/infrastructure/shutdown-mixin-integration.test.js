'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}

describe('ShutdownMixin Integration', () => {
  afterEach(async () => { await _cleanAll(); });

  describe('EventBus with ShutdownMixin', () => {
    const EventBus = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'event-bus'));
    it('should have isHealthy and shutdown from mixin', () => {
      const eb = _track(new EventBus());
      assert.equal(typeof eb.isHealthy, 'function');
      assert.equal(typeof eb.shutdown, 'function');
      assert.equal(eb.isHealthy(), true);
      eb.shutdown();
      assert.equal(eb.isHealthy(), false);
    });
    it('should clear history and middleware on shutdown', () => {
      const eb = _track(new EventBus());
      eb.use(function testMw() {});
      assert.equal(eb._middleware.length, 1);
      eb.shutdown();
      assert.equal(eb._middleware.length, 0);
    });
  });

  describe('HealthChecker with ShutdownMixin', () => {
    const HealthChecker = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'health-checker'));
    it('should have isHealthy and shutdown from mixin', () => {
      const hc = _track(new HealthChecker());
      assert.equal(hc.isHealthy(), true);
      hc.shutdown();
      assert.equal(hc.isHealthy(), false);
    });
  });

  describe('RetryEngine with ShutdownMixin', () => {
    const RetryEngine = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'retry-engine'));
    it('should have isHealthy and shutdown from mixin', () => {
      const re = _track(new RetryEngine());
      assert.equal(re.isHealthy(), true);
      re.shutdown();
      assert.equal(re.isHealthy(), false);
    });
  });

  describe('PlatformCoordinator with ShutdownMixin', () => {
    const PlatformCoordinator = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'platform-coordinator'));
    it('should have isHealthy and shutdown from mixin', () => {
      const pc = _track(new PlatformCoordinator());
      assert.equal(pc.isHealthy(), true);
      pc.shutdown();
      assert.equal(pc.isHealthy(), false);
    });
  });
});

describe('DeepeningBase Declarative Attach', () => {
  const DeepeningBase = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-base'));

  it('should have attachable deps defined', () => {
    assert.ok(Array.isArray(DeepeningBase.ATTACHABLE_DEPS));
    assert.ok(DeepeningBase.ATTACHABLE_DEPS.length > 0);
  });

  it('should support attach by name', () => {
    const b = _track(new DeepeningBase());
    const mock = { id: 'test' };
    b.attach('cache', mock);
    assert.equal(b._cache, mock);
    assert.equal(b._deps.cache, mock);
  });

  it('should support attach by method name', () => {
    const b = _track(new DeepeningBase());
    const mock = { id: 'test' };
    b.attachCache(mock);
    assert.equal(b._cache, mock);
  });

  it('should ignore unknown deps', () => {
    const b = _track(new DeepeningBase());
    b.attach('unknownDep', { id: 'test' });
    assert.equal(b._unknownDep, undefined);
  });

  it('should return this for chaining', () => {
    const b = _track(new DeepeningBase());
    const result = b.attachCache({}).attachEventStore({});
    assert.equal(result, b);
  });
});

describe('TokenAwareDeepening Budget Safety', () => {
  const TokenAwareDeepening = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'token-aware-deepening'));

  it('should return canAfford:false when token manager throws', () => {
    const tad = _track(new TokenAwareDeepening());
    const badManager = { getUsage: function() { throw new Error('connection lost'); } };
    const result = tad.canAffordIteration(badManager, 'session-1', 100);
    assert.equal(result.canAfford, false);
    assert.equal(result.reason, 'token-query-error');
  });

  it('should return maxIterations:1 when token manager throws', () => {
    const tad = _track(new TokenAwareDeepening());
    const badManager = { getUsage: function() { throw new Error('timeout'); } };
    const result = tad.calculateMaxIterations(badManager, 'session-1');
    assert.equal(result.maxIterations, 1);
    assert.equal(result.reason, 'token-manager-error');
  });
});
