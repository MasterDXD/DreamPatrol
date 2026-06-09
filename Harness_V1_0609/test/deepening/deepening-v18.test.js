'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningRetryPolicy = require('../../src/runtime/deepening/deepening-retry-policy');
const DeepeningServiceRegistry = require('../../src/runtime/deepening/deepening-service-registry');


describe('DeepeningRetryPolicy', function() {
  let rp;

  beforeEach(function() {
    rp = new DeepeningRetryPolicy({ defaultMaxRetries: 3, defaultBaseDelay: 10, defaultMaxDelay: 500 });
  });

  afterEach(function() {
    if (rp) rp.shutdown();
  });

  it('should create policy manager with defaults', function() {
    const r = new DeepeningRetryPolicy();
    assert.strictEqual(r.getStats().totalPolicies, 0);
    r.shutdown();
  });

  it('should define a policy', function() {
    rp.definePolicy('api-call');
    assert.strictEqual(rp.getPolicyNames().length, 1);
  });

  it('should throw on define without name', function() {
    assert.throws(function() { rp.definePolicy(''); }, /Policy name is required/);
  });

  it('should not duplicate policy', function() {
    rp.definePolicy('api-call');
    rp.definePolicy('api-call');
    assert.strictEqual(rp.getPolicyNames().length, 1);
  });

  it('should emit policyDefined event', function() {
    let emitted = null;
    rp.on('policyDefined', function(e) { emitted = e; });
    rp.definePolicy('api-call', { maxRetries: 5, backoffStrategy: 'exponential' });
    assert.strictEqual(emitted.name, 'api-call');
    assert.strictEqual(emitted.maxRetries, 5);
  });

  it('should get policy info', function() {
    rp.definePolicy('api-call', { maxRetries: 3, baseDelay: 100, maxDelay: 5000 });
    const info = rp.getPolicy('api-call');
    assert.strictEqual(info.maxRetries, 3);
    assert.strictEqual(info.baseDelay, 100);
    assert.strictEqual(info.maxDelay, 5000);
  });

  it('should return null for unknown policy', function() {
    assert.strictEqual(rp.getPolicy('unknown'), null);
  });

  it('should compute fixed delay', function() {
    rp.definePolicy('test', { backoffStrategy: 'fixed', baseDelay: 100 });
    assert.strictEqual(rp.computeDelay('test', 1), 100);
    assert.strictEqual(rp.computeDelay('test', 3), 100);
  });

  it('should compute linear delay', function() {
    rp.definePolicy('test', { backoffStrategy: 'linear', baseDelay: 100 });
    assert.strictEqual(rp.computeDelay('test', 1), 100);
    assert.strictEqual(rp.computeDelay('test', 3), 300);
  });

  it('should compute exponential delay', function() {
    rp.definePolicy('test', { backoffStrategy: 'exponential', baseDelay: 100, maxDelay: 50000 });
    assert.strictEqual(rp.computeDelay('test', 1), 100);
    assert.strictEqual(rp.computeDelay('test', 2), 200);
    assert.strictEqual(rp.computeDelay('test', 3), 400);
  });

  it('should cap delay at maxDelay', function() {
    rp.definePolicy('test', { backoffStrategy: 'exponential', baseDelay: 100, maxDelay: 300 });
    assert.strictEqual(rp.computeDelay('test', 5), 300);
  });

  it('should compute exponential jitter delay', function() {
    rp.definePolicy('test', { backoffStrategy: 'exponential_jitter', baseDelay: 100, maxDelay: 50000 });
    const d1 = rp.computeDelay('test', 1);
    assert.ok(d1 >= 50 && d1 <= 100);
  });

  it('should throw on computeDelay for unknown policy', function() {
    assert.throws(function() { rp.computeDelay('unknown', 1); }, /Policy not found/);
  });

  it('should execute successfully on first try', async function() {
    rp.definePolicy('test');
    const result = await rp.execute('test', function() { return 42; });
    assert.strictEqual(result, 42);
  });

  it('should retry on failure and succeed', async function() {
    rp.definePolicy('test', { maxRetries: 3, baseDelay: 10 });
    let attempts = 0;
    let retryEmitted = null;
    rp.on('retrying', function(e) { retryEmitted = e; });
    const result = await rp.execute('test', function() {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'ok';
    });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(attempts, 3);
    assert.strictEqual(retryEmitted.policy, 'test');
  });

  it('should emit retrySucceeded event', async function() {
    rp.definePolicy('test', { maxRetries: 2, baseDelay: 10 });
    let attempts = 0;
    let emitted = null;
    rp.on('retrySucceeded', function(e) { emitted = e; });
    await rp.execute('test', function() {
      attempts++;
      if (attempts < 2) throw new Error('fail');
      return 'ok';
    });
    assert.strictEqual(emitted.attempt, 1);
  });

  it('should throw after max retries exhausted', async function() {
    rp.definePolicy('test', { maxRetries: 2, baseDelay: 10 });
    let emitted = null;
    rp.on('retriesExhausted', function(e) { emitted = e; });
    await assert.rejects(async function() {
      await rp.execute('test', function() { throw new Error('always fail'); });
    }, /always fail/);
    assert.strictEqual(emitted.maxRetries, 2);
  });

  it('should throw on execute without function', async function() {
    rp.definePolicy('test');
    await assert.rejects(async function() {
      await rp.execute('test', 'not a function');
    }, /fn must be a function/);
  });

  it('should throw on execute for unknown policy', async function() {
    await assert.rejects(async function() {
      await rp.execute('unknown', function() {});
    }, /Policy not found/);
  });

  it('should respect retryableErrors filter', async function() {
    rp.definePolicy('test', { maxRetries: 3, baseDelay: 10, retryableErrors: ['TIMEOUT'] });
    let emitted = null;
    rp.on('nonRetryable', function(e) { emitted = e; });
    await assert.rejects(async function() {
      await rp.execute('test', function() { throw new Error('CONNECTION_REFUSED'); });
    }, /CONNECTION_REFUSED/);
    assert.strictEqual(emitted.policy, 'test');
  });

  it('should remove policy', function() {
    rp.definePolicy('test');
    let emitted = null;
    rp.on('policyRemoved', function(e) { emitted = e; });
    rp.removePolicy('test');
    assert.strictEqual(emitted.name, 'test');
    assert.strictEqual(rp.getPolicyNames().length, 0);
  });

  it('should return false for removing unknown policy', function() {
    assert.strictEqual(rp.removePolicy('unknown'), false);
  });

  it('should reset policy stats', function() {
    rp.definePolicy('test');
    let emitted = null;
    rp.on('policyReset', function(e) { emitted = e; });
    rp.resetPolicy('test');
    assert.strictEqual(emitted.name, 'test');
  });

  it('should get stats', function() {
    rp.definePolicy('test');
    const stats = rp.getStats();
    assert.strictEqual(stats.totalPolicies, 1);
    assert.strictEqual(stats.successRate, '0.0');
  });

  it('should expose BACKOFF_STRATEGIES', function() {
    assert.strictEqual(DeepeningRetryPolicy.BACKOFF_STRATEGIES.FIXED, 'fixed');
    assert.strictEqual(DeepeningRetryPolicy.BACKOFF_STRATEGIES.EXPONENTIAL, 'exponential');
    assert.strictEqual(DeepeningRetryPolicy.BACKOFF_STRATEGIES.EXPONENTIAL_JITTER, 'exponential_jitter');
  });

  it('should shutdown cleanly', function() {
    rp.definePolicy('test');
    let shutdownEmitted = false;
    rp.on('shutdown', function() { shutdownEmitted = true; });
    rp.shutdown();
    assert.strictEqual(shutdownEmitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(rp.isHealthy(), true);
  });
});

describe('DeepeningServiceRegistry', function() {
  let sr;

  beforeEach(function() {
    sr = new DeepeningServiceRegistry({ healthCheckInterval: 30000 });
  });

  afterEach(function() {
    if (sr) sr.shutdown();
  });

  it('should create registry with defaults', function() {
    const s = new DeepeningServiceRegistry();
    assert.strictEqual(s.getStats().totalServices, 0);
    s.shutdown();
  });

  it('should register a service', function() {
    sr.register('api-gateway', { host: 'localhost', port: 8080 });
    assert.strictEqual(sr.getServiceNames().length, 1);
  });

  it('should throw on register without name', function() {
    assert.throws(function() { sr.register(''); }, /Service name is required/);
  });

  it('should emit registered event', function() {
    let emitted = null;
    sr.on('registered', function(e) { emitted = e; });
    sr.register('api-gateway', { version: '2.0', port: 8080 });
    assert.strictEqual(emitted.name, 'api-gateway');
    assert.strictEqual(emitted.version, '2.0');
    assert.strictEqual(emitted.port, 8080);
  });

  it('should get service info', function() {
    sr.register('api-gateway', { host: '10.0.0.1', port: 8080, tags: ['api', 'gateway'] });
    const info = sr.getService('api-gateway');
    assert.strictEqual(info.host, '10.0.0.1');
    assert.strictEqual(info.port, 8080);
    assert.deepStrictEqual(info.tags, ['api', 'gateway']);
    assert.strictEqual(info.state, 'starting');
  });

  it('should return null for unknown service', function() {
    assert.strictEqual(sr.getService('unknown'), null);
  });

  it('should send heartbeat', function() {
    sr.register('api-gateway');
    let emitted = null;
    sr.on('heartbeat', function(e) { emitted = e; });
    sr.heartbeat('api-gateway');
    assert.strictEqual(emitted.name, 'api-gateway');
    const info = sr.getService('api-gateway');
    assert.strictEqual(info.state, 'healthy');
  });

  it('should throw on heartbeat for unknown service', function() {
    assert.throws(function() { sr.heartbeat('unknown'); }, /Service not found/);
  });

  it('should mark unhealthy', function() {
    sr.register('api-gateway');
    let emitted = null;
    sr.on('stateChanged', function(e) { emitted = e; });
    sr.markUnhealthy('api-gateway');
    assert.strictEqual(emitted.to, 'unhealthy');
    assert.strictEqual(sr.getService('api-gateway').state, 'unhealthy');
  });

  it('should mark degraded', function() {
    sr.register('api-gateway');
    sr.markDegraded('api-gateway');
    assert.strictEqual(sr.getService('api-gateway').state, 'degraded');
  });

  it('should mark healthy', function() {
    sr.register('api-gateway');
    sr.markUnhealthy('api-gateway');
    sr.markHealthy('api-gateway');
    assert.strictEqual(sr.getService('api-gateway').state, 'healthy');
  });

  it('should return false for marking unknown service', function() {
    assert.strictEqual(sr.markUnhealthy('unknown'), false);
    assert.strictEqual(sr.markDegraded('unknown'), false);
    assert.strictEqual(sr.markHealthy('unknown'), false);
  });

  it('should get services by tag', function() {
    sr.register('api-gateway', { tags: ['api', 'gateway'] });
    sr.register('auth-service', { tags: ['api', 'auth'] });
    sr.register('worker', { tags: ['worker'] });
    const apiServices = sr.getServicesByTag('api');
    assert.strictEqual(apiServices.length, 2);
  });

  it('should get services by state', function() {
    sr.register('svc1');
    sr.register('svc2');
    sr.heartbeat('svc1');
    const healthy = sr.getServicesByState('healthy');
    assert.strictEqual(healthy.length, 1);
    assert.strictEqual(healthy[0].name, 'svc1');
  });

  it('should deregister a service', function() {
    sr.register('api-gateway');
    let emitted = null;
    sr.on('deregistered', function(e) { emitted = e; });
    sr.deregister('api-gateway');
    assert.strictEqual(emitted.name, 'api-gateway');
    assert.strictEqual(sr.getServiceNames().length, 0);
  });

  it('should return false for deregistering unknown service', function() {
    assert.strictEqual(sr.deregister('unknown'), false);
  });

  it('should get stats', function() {
    sr.register('svc1');
    sr.register('svc2');
    sr.heartbeat('svc1');
    const stats = sr.getStats();
    assert.strictEqual(stats.totalServices, 2);
    assert.strictEqual(stats.totalRegistered, 2);
    assert.strictEqual(stats.byState.healthy, 1);
    assert.strictEqual(stats.byState.starting, 1);
  });

  it('should expose SERVICE_STATES', function() {
    assert.strictEqual(DeepeningServiceRegistry.SERVICE_STATES.HEALTHY, 'healthy');
    assert.strictEqual(DeepeningServiceRegistry.SERVICE_STATES.UNHEALTHY, 'unhealthy');
    assert.strictEqual(DeepeningServiceRegistry.SERVICE_STATES.DEGRADED, 'degraded');
  });

  it('should shutdown cleanly', function() {
    sr.register('svc1');
    let shutdownEmitted = false;
    sr.on('shutdown', function() { shutdownEmitted = true; });
    sr.shutdown();
    assert.strictEqual(shutdownEmitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(sr.isHealthy(), true);
  });
});
