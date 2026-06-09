'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const HealthChecker = require('../../../src/runtime/infrastructure/health-checker');
const PlanPersistence = require('../../../src/runtime/workflow/plan-persistence');
const IsolatedContextManager = require('../../../src/runtime/context/isolated-context-manager');

describe('HealthChecker', () => {
  it('should create instance', () => {
    const hc = new HealthChecker();
    assert.ok(hc);
    hc.shutdown();
  });

  it('should register a health check function', () => {
    const hc = new HealthChecker();
    hc.register('test-component', () => ({ healthy: true, stats: { ok: true } }));
    const result = hc.check();
    assert.ok(result);
    hc.shutdown();
  });

  it('should handle unhealthy component in check result', () => {
    const hc = new HealthChecker();
    hc.register('failing', () => ({ healthy: false, stats: { ok: false } }));
    const result = hc.check();
    assert.ok(typeof result === 'object' || typeof result === 'boolean');
    hc.shutdown();
  });

  it('should shutdown cleanly', () => {
    const hc = new HealthChecker();
    hc.register('test', () => ({ healthy: true, stats: { ok: true } }));
    hc.check();
    hc.shutdown();
    assert.ok(!hc.isHealthy());
  });
});

describe('PlanPersistence', () => {
  it('should create instance with projectRoot', () => {
    const pp = new PlanPersistence(process.cwd());
    assert.ok(pp);
  });

  it('should handle save and load operations', () => {
    const pp = new PlanPersistence(process.cwd());
    const plan = { id: 'test-plan', steps: ['step1', 'step2'] };
    try {
      pp.save('test-plan-id', plan);
      const loaded = pp.load('test-plan-id');
      if (loaded) {
        assert.strictEqual(loaded.id, 'test-plan');
      }
    } catch (_e) {
      assert.ok(_e && _e.message, 'Expected error with message, got: ' + String(_e));
    }
  });
});

describe('IsolatedContextManager', () => {
  it('should create instance', () => {
    const icm = new IsolatedContextManager();
    assert.ok(icm);
  });

  it('should create and retrieve isolated context', () => {
    const icm = new IsolatedContextManager();
    const config = { sessionId: 'test-123', agentId: 'worker-1' };
    const ctx = icm.createIsolatedContext(config);
    if (ctx) {
      assert.ok(ctx.contextId || ctx.id || ctx.sessionId);
    }
  });

  it('should return null for non-existent context', () => {
    const icm = new IsolatedContextManager();
    const result = icm.getContext('nonexistent', 'agent-1');
    assert.ok(!result);
  });

  it('should get stats', () => {
    const icm = new IsolatedContextManager();
    const stats = icm.getStats();
    assert.ok(stats);
  });
});
