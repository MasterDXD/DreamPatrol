'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const DeepeningCircuitBreaker = require('../../src/runtime/deepening/deepening-circuit-breaker');
const DeepeningTaskQueue = require('../../src/runtime/deepening/deepening-task-queue');
const DeepeningResourceManager = require('../../src/runtime/deepening/deepening-resource-manager');
const DeepeningAuditTrail = require('../../src/runtime/deepening/deepening-audit-trail');
const DeepeningConfigManager = require('../../src/runtime/deepening/deepening-config-manager');

describe('DeepeningCircuitBreaker', () => {
  let circuitBreaker;

  beforeEach(() => {
    circuitBreaker = new DeepeningCircuitBreaker({ failureThreshold: 3, resetTimeout: 100 });
  });

  afterEach(() => {
    if (circuitBreaker) circuitBreaker.shutdown();
  });

  it('should create circuit in closed state', () => {
    const circuit = circuitBreaker.createCircuit('test');
    assert.strictEqual(circuit.state, 'closed');
  });

  it('should open circuit after failure threshold', () => {
    circuitBreaker.createCircuit('test');
    for (let i = 0; i < 3; i++) {
      circuitBreaker.recordFailure('test');
    }
    assert.strictEqual(circuitBreaker.getState('test'), 'open');
  });

  it('should close circuit after success threshold in half-open', () => {
    circuitBreaker.createCircuit('test', { successThreshold: 2 });
    for (let i = 0; i < 3; i++) {
      circuitBreaker.recordFailure('test');
    }
    assert.strictEqual(circuitBreaker.getState('test'), 'open');

    circuitBreaker.forceClose('test');
    assert.strictEqual(circuitBreaker.getState('test'), 'closed');
  });

  it('should reject execution when circuit is open', async () => {
    circuitBreaker.createCircuit('test');
    for (let i = 0; i < 3; i++) {
      circuitBreaker.recordFailure('test');
    }

    await assert.rejects(async () => {
      await circuitBreaker.execute('test', () => Promise.resolve('ok'));
    }, /Circuit test is open/);
  });

  it('should allow execution when circuit is closed', async () => {
    circuitBreaker.createCircuit('test');
    const result = await circuitBreaker.execute('test', () => Promise.resolve('ok'));
    assert.strictEqual(result, 'ok');
  });

  it('should force open and close circuit', () => {
    circuitBreaker.createCircuit('test');
    circuitBreaker.forceOpen('test');
    assert.strictEqual(circuitBreaker.getState('test'), 'open');

    circuitBreaker.forceClose('test');
    assert.strictEqual(circuitBreaker.getState('test'), 'closed');
  });

  it('should get stats', () => {
    circuitBreaker.createCircuit('test');
    const stats = circuitBreaker.getStats();
    assert.strictEqual(stats.totalCircuits, 1);
    assert.strictEqual(stats.stateCounts.closed, 1);
  });
});

describe('DeepeningTaskQueue', () => {
  let taskQueue;

  beforeEach(() => {
    taskQueue = new DeepeningTaskQueue({ concurrency: 2, maxSize: 10 });
  });

  afterEach(() => {
    if (taskQueue) taskQueue.shutdown();
  });

  it('should enqueue tasks with priority', () => {
    const id1 = taskQueue.enqueueNormal({ data: 'normal' });
    const id2 = taskQueue.enqueueHigh({ data: 'high' });

    assert.ok(id1);
    assert.ok(id2);
  });

  it('should dequeue highest priority first', () => {
    const syncQueue = new DeepeningTaskQueue({ concurrency: 0, maxSize: 10 });
    syncQueue.enqueueLow({ data: 'low' });
    syncQueue.enqueueHigh({ data: 'high' });
    syncQueue.enqueueNormal({ data: 'normal' });

    const task = syncQueue.dequeue();
    assert.strictEqual(task.priority, 1);
  });

  it('should get queue size', () => {
    const syncQueue = new DeepeningTaskQueue({ concurrency: 0, maxSize: 10 });
    syncQueue.enqueueNormal({ data: '1' });
    syncQueue.enqueueNormal({ data: '2' });

    assert.strictEqual(syncQueue.getQueueSize(), 2);
  });

  it('should cancel a task', () => {
    const syncQueue = new DeepeningTaskQueue({ concurrency: 0, maxSize: 10 });
    const id = syncQueue.enqueueNormal({ data: 'test' });
    const cancelled = syncQueue.cancelTask(id);
    assert.strictEqual(cancelled, true);
    assert.strictEqual(syncQueue.getQueueSize(), 0);
  });

  it('should get task by id', () => {
    const syncQueue = new DeepeningTaskQueue({ concurrency: 0, maxSize: 10 });
    const id = syncQueue.enqueueNormal({ data: 'test' });
    const task = syncQueue.getTask(id);
    assert.ok(task);
    assert.strictEqual(task.id, id);
  });

  it('should get stats', () => {
    const syncQueue = new DeepeningTaskQueue({ concurrency: 0, maxSize: 10 });
    syncQueue.enqueueNormal({ data: '1' });
    syncQueue.enqueueHigh({ data: '2' });

    const stats = syncQueue.getStats();
    assert.strictEqual(stats.totalQueued, 2);
    assert.strictEqual(stats.concurrency, 0);
  });

  it('should throw when queue is full', () => {
    const smallQueue = new DeepeningTaskQueue({ maxSize: 2, concurrency: 0 });
    smallQueue.enqueueNormal({ data: '1' });
    smallQueue.enqueueNormal({ data: '2' });

    assert.throws(() => {
      smallQueue.enqueueNormal({ data: '3' });
    }, /Task queue is full/);
  });
});

describe('DeepeningResourceManager', () => {
  let resourceManager;

  beforeEach(() => {
    resourceManager = new DeepeningResourceManager({
      memoryCapacity: 1000,
      cpuCapacity: 100,
      tokenCapacity: 10000,
      concurrentCapacity: 5,
    });
  });

  afterEach(() => {
    if (resourceManager) resourceManager.shutdown();
  });

  it('should allocate and release resources', () => {
    const allocId = resourceManager.allocate('memory', 100);
    assert.ok(allocId);

    const available = resourceManager.getAvailable('memory');
    assert.strictEqual(available, 900);

    resourceManager.release(allocId);
    const availableAfter = resourceManager.getAvailable('memory');
    assert.strictEqual(availableAfter, 1000);
  });

  it('should throw when insufficient resources', () => {
    assert.throws(() => {
      resourceManager.allocate('memory', 2000);
    }, /Insufficient memory/);
  });

  it('should reserve resources', () => {
    resourceManager.reserve('memory', 200);
    const available = resourceManager.getAvailable('memory');
    assert.strictEqual(available, 800);

    resourceManager.unreserve('memory', 100);
    const availableAfter = resourceManager.getAvailable('memory');
    assert.strictEqual(availableAfter, 900);
  });

  it('should get utilization', () => {
    resourceManager.allocate('memory', 500);
    const utilization = resourceManager.getUtilization('memory');
    assert.strictEqual(utilization, 0.5);
  });

  it('should register custom resources', () => {
    resourceManager.registerResource('custom', { capacity: 50, unit: 'items' });
    const info = resourceManager.getResourceInfo('custom');
    assert.strictEqual(info.capacity, 50);
  });

  it('should get stats', () => {
    const stats = resourceManager.getStats();
    assert.strictEqual(stats.totalResources, 4);
    assert.strictEqual(stats.activeAllocations, 0);
  });

  it('should track allocation history', () => {
    const allocId = resourceManager.allocate('memory', 100);
    resourceManager.release(allocId);

    const history = resourceManager.getAllocationHistory({ limit: 10 });
    assert.strictEqual(history.length, 2);
  });
});

describe('DeepeningAuditTrail', () => {
  let auditTrail;

  beforeEach(() => {
    auditTrail = new DeepeningAuditTrail();
  });

  afterEach(() => {
    if (auditTrail) auditTrail.shutdown();
  });

  it('should record audit entries', () => {
    const entry = auditTrail.record('execution-start', { executionId: 'exec-1', actor: 'system' });
    assert.ok(entry);
    assert.strictEqual(entry.action, 'execution-start');
  });

  it('should query by action', () => {
    auditTrail.record('execution-start', { executionId: 'exec-1' });
    auditTrail.record('execution-complete', { executionId: 'exec-1' });
    auditTrail.record('execution-start', { executionId: 'exec-2' });

    const results = auditTrail.query({ action: 'execution-start' });
    assert.strictEqual(results.length, 2);
  });

  it('should query by actor', () => {
    auditTrail.record('execution-start', { executionId: 'exec-1', actor: 'agent-1' });
    auditTrail.record('execution-start', { executionId: 'exec-2', actor: 'agent-2' });

    const results = auditTrail.query({ actor: 'agent-1' });
    assert.strictEqual(results.length, 1);
  });

  it('should query by execution id', () => {
    auditTrail.record('execution-start', { executionId: 'exec-1' });
    auditTrail.record('execution-complete', { executionId: 'exec-1' });
    auditTrail.record('execution-start', { executionId: 'exec-2' });

    const timeline = auditTrail.getExecutionTimeline('exec-1');
    assert.strictEqual(timeline.length, 2);
  });

  it('should get action counts', () => {
    auditTrail.record('execution-start', {});
    auditTrail.record('execution-start', {});
    auditTrail.record('execution-complete', {});

    const counts = auditTrail.getActionCounts();
    assert.strictEqual(counts['execution-start'], 2);
    assert.strictEqual(counts['execution-complete'], 1);
  });

  it('should generate compliance report', () => {
    auditTrail.record('execution-start', { actor: 'system' });
    auditTrail.record('security-violation', { actor: 'attacker' });

    const report = auditTrail.generateComplianceReport();
    assert.strictEqual(report.totalEntries, 2);
    assert.strictEqual(report.securityViolations, 1);
    assert.strictEqual(report.complianceStatus, 'violations-detected');
  });

  it('should get stats', () => {
    auditTrail.record('execution-start', {});
    const stats = auditTrail.getStats();
    assert.strictEqual(stats.totalEntries, 1);
  });
});

describe('DeepeningConfigManager', () => {
  let configManager;

  beforeEach(() => {
    configManager = new DeepeningConfigManager();
  });

  afterEach(() => {
    if (configManager) configManager.shutdown();
  });

  it('should set and get config values', () => {
    configManager.set('maxIterations', 10);
    assert.strictEqual(configManager.get('maxIterations'), 10);
  });

  it('should return default value for missing keys', () => {
    assert.strictEqual(configManager.get('missing', 42), 42);
  });

  it('should delete config values', () => {
    configManager.set('test', 'value');
    assert.strictEqual(configManager.has('test'), true);

    configManager.delete('test');
    assert.strictEqual(configManager.has('test'), false);
  });

  it('should track config history', () => {
    configManager.set('key1', 'value1');
    configManager.set('key1', 'value2');

    const history = configManager.getHistory({ key: 'key1' });
    assert.strictEqual(history.length, 2);
  });

  it('should watch config changes', () => {
    let receivedNew = null;
    let receivedOld = null;

    configManager.watch('test', (newVal, oldVal) => {
      receivedNew = newVal;
      receivedOld = oldVal;
    });

    configManager.set('test', 'value1');
    assert.strictEqual(receivedNew, 'value1');
    assert.strictEqual(receivedOld, undefined);

    configManager.set('test', 'value2');
    assert.strictEqual(receivedNew, 'value2');
    assert.strictEqual(receivedOld, 'value1');
  });

  it('should batch update configs', () => {
    configManager.batchUpdate({
      key1: 'value1',
      key2: 'value2',
      key3: 'value3',
    });

    assert.strictEqual(configManager.get('key1'), 'value1');
    assert.strictEqual(configManager.get('key2'), 'value2');
    assert.strictEqual(configManager.get('key3'), 'value3');
  });

  it('should validate config values', () => {
    const validResult = configManager.validate('test', 5, { type: 'number', min: 0, max: 10 });
    assert.strictEqual(validResult.valid, true);

    const invalidResult = configManager.validate('test', 15, { type: 'number', min: 0, max: 10 });
    assert.strictEqual(invalidResult.valid, false);
  });

  it('should set with validation', () => {
    configManager.setWithValidation('test', 5, { type: 'number', min: 0, max: 10 });
    assert.strictEqual(configManager.get('test'), 5);

    assert.throws(() => {
      configManager.setWithValidation('test', 15, { type: 'number', min: 0, max: 10 });
    });
  });

  it('should export and import configs', () => {
    configManager.set('key1', 'value1');
    configManager.set('key2', 42);

    const exported = configManager.export();
    const parsed = JSON.parse(exported);
    assert.strictEqual(parsed.key1, 'value1');
    assert.strictEqual(parsed.key2, 42);

    const newManager = new DeepeningConfigManager();
    newManager.import(exported);
    assert.strictEqual(newManager.get('key1'), 'value1');
  });

  it('should get stats', () => {
    configManager.set('key1', 'value1');
    const stats = configManager.getStats();
    assert.strictEqual(stats.totalConfigs, 1);
  });
});
