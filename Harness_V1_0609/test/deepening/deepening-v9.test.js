'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const DeepeningStateMachine = require('../../src/runtime/deepening/deepening-state-machine');
const DeepeningErrorHandler = require('../../src/runtime/deepening/deepening-error-handler');
const DeepeningRateLimiter = require('../../src/runtime/deepening/deepening-rate-limiter');
const DeepeningSnapshot = require('../../src/runtime/deepening/deepening-snapshot');
const DeepeningNotifier = require('../../src/runtime/deepening/deepening-notifier');

describe('DeepeningStateMachine', () => {
  let stateMachine;

  beforeEach(() => {
    stateMachine = new DeepeningStateMachine();
  });

  it('should create execution with idle state', () => {
    const entry = stateMachine.createExecution('exec-1');
    assert.strictEqual(entry.currentState, 'idle');
    assert.strictEqual(entry.executionId, 'exec-1');
  });

  it('should perform valid state transitions', () => {
    stateMachine.createExecution('exec-1');
    stateMachine.transition('exec-1', 'initializing');
    stateMachine.transition('exec-1', 'cache-check');
    assert.strictEqual(stateMachine.getState('exec-1'), 'cache-check');
  });

  it('should reject invalid state transitions', () => {
    stateMachine.createExecution('exec-1');
    const result = stateMachine.transition('exec-1', 'executing');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Invalid transition'));
  });

  it('should check if transition is valid', () => {
    stateMachine.createExecution('exec-1');
    assert.strictEqual(stateMachine.canTransition('exec-1', 'initializing'), true);
    assert.strictEqual(stateMachine.canTransition('exec-1', 'executing'), false);
  });

  it('should pause and resume execution', () => {
    stateMachine.createExecution('exec-1');
    stateMachine.transition('exec-1', 'initializing');
    stateMachine.transition('exec-1', 'cache-check');
    stateMachine.transition('exec-1', 'depth-assessment');
    stateMachine.transition('exec-1', 'agent-routing');
    stateMachine.transition('exec-1', 'context-enrichment');
    stateMachine.transition('exec-1', 'executing');

    stateMachine.pause('exec-1');
    assert.strictEqual(stateMachine.getState('exec-1'), 'paused');

    stateMachine.resume('exec-1');
    assert.strictEqual(stateMachine.getState('exec-1'), 'executing');
  });

  it('should cancel execution', () => {
    stateMachine.createExecution('exec-1');
    stateMachine.transition('exec-1', 'initializing');
    stateMachine.transition('exec-1', 'cache-check');
    stateMachine.transition('exec-1', 'depth-assessment');
    stateMachine.transition('exec-1', 'agent-routing');
    stateMachine.transition('exec-1', 'context-enrichment');
    stateMachine.transition('exec-1', 'executing');

    stateMachine.cancel('exec-1');
    assert.strictEqual(stateMachine.getState('exec-1'), 'cancelled');
  });

  it('should fail execution', () => {
    stateMachine.createExecution('exec-1');
    stateMachine.transition('exec-1', 'initializing');
    stateMachine.fail('exec-1', 'Something went wrong');
    assert.strictEqual(stateMachine.getState('exec-1'), 'failed');
  });

  it('should complete execution and reset', () => {
    stateMachine.createExecution('exec-1');
    stateMachine.transition('exec-1', 'initializing');
    stateMachine.transition('exec-1', 'cache-check');
    stateMachine.transition('exec-1', 'depth-assessment');
    stateMachine.transition('exec-1', 'agent-routing');
    stateMachine.transition('exec-1', 'context-enrichment');
    stateMachine.transition('exec-1', 'executing');
    stateMachine.transition('exec-1', 'convergence-check');
    stateMachine.transition('exec-1', 'output-fusion');
    stateMachine.transition('exec-1', 'reporting');
    stateMachine.complete('exec-1', { bestScore: 0.95 });

    assert.strictEqual(stateMachine.getState('exec-1'), 'completed');

    stateMachine.reset('exec-1');
    assert.strictEqual(stateMachine.getState('exec-1'), 'idle');
  });

  it('should track state history', () => {
    stateMachine.createExecution('exec-1');
    stateMachine.transition('exec-1', 'initializing');

    const history = stateMachine.getHistory('exec-1');
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].to, 'idle');
    assert.strictEqual(history[1].to, 'initializing');
  });

  it('should get stats', () => {
    stateMachine.createExecution('exec-1');
    stateMachine.transition('exec-1', 'initializing');

    const stats = stateMachine.getStats();
    assert.strictEqual(stats.totalExecutions, 1);
    assert.strictEqual(stats.stateCounts.initializing, 1);
  });
});

describe('DeepeningErrorHandler', () => {
  let errorHandler;

  beforeEach(() => {
    errorHandler = new DeepeningErrorHandler({ maxRetries: 2, retryDelay: 10 });
  });

  it('should categorize errors', async () => {
    const result = await errorHandler.handleError(new Error('timeout occurred'), { executionId: 'exec-1' });
    assert.strictEqual(result.category, 'timeout-error');
  });

  it('should categorize agent errors', async () => {
    const result = await errorHandler.handleError(new Error('agent failed'), { executionId: 'exec-1', type: 'agent' });
    assert.strictEqual(result.category, 'agent-error');
  });

  it('should categorize convergence errors', async () => {
    const result = await errorHandler.handleError(new Error('convergence not achieved'), { executionId: 'exec-1' });
    assert.strictEqual(result.category, 'convergence-error');
  });

  it('should categorize validation errors', async () => {
    const result = await errorHandler.handleError(new Error('invalid configuration'), { executionId: 'exec-1' });
    assert.strictEqual(result.category, 'validation-error');
  });

  it('should categorize resource errors', async () => {
    const result = await errorHandler.handleError(new Error('memory limit exceeded'), { executionId: 'exec-1' });
    assert.strictEqual(result.category, 'resource-error');
  });

  it('should retry agent errors up to max retries', async () => {
    const result1 = await errorHandler.handleError(new Error('agent failed'), { executionId: 'exec-1', type: 'agent' });
    assert.strictEqual(result1.strategy, 'retry');
    assert.strictEqual(result1.retryCount, 1);

    const result2 = await errorHandler.handleError(new Error('agent failed'), { executionId: 'exec-1', type: 'agent' });
    assert.strictEqual(result2.strategy, 'retry');
    assert.strictEqual(result2.retryCount, 2);

    const result3 = await errorHandler.handleError(new Error('agent failed'), { executionId: 'exec-1', type: 'agent' });
    assert.strictEqual(result3.strategy, 'skip');
  });

  it('should use fallback handler when available', async () => {
    errorHandler.registerFallback('agent-error', async () => ({ fallback: true }));

    const result1 = await errorHandler.handleError(new Error('agent failed'), { executionId: 'exec-2', type: 'agent' });
    assert.strictEqual(result1.strategy, 'retry');

    await errorHandler.handleError(new Error('agent failed'), { executionId: 'exec-2', type: 'agent' });
    const result3 = await errorHandler.handleError(new Error('agent failed'), { executionId: 'exec-2', type: 'agent' });
    assert.strictEqual(result3.strategy, 'fallback');
    assert.strictEqual(result3.fallbackResult.fallback, true);
  });

  it('should log errors', async () => {
    await errorHandler.handleError(new Error('test error'), { executionId: 'exec-1' });
    const log = errorHandler.getErrorLog({ executionId: 'exec-1' });
    assert.strictEqual(log.length, 1);
  });

  it('should get stats', async () => {
    await errorHandler.handleError(new Error('timeout'), { executionId: 'exec-1' });
    await errorHandler.handleError(new Error('invalid'), { executionId: 'exec-2' });

    const stats = errorHandler.getStats();
    assert.strictEqual(stats.totalErrors, 2);
  });
});

describe('DeepeningRateLimiter', () => {
  let rateLimiter;

  beforeEach(() => {
    rateLimiter = new DeepeningRateLimiter({ maxConcurrent: 2, maxPerMinute: 5, maxPerHour: 100 });
  });

  it('should acquire and release slots', async () => {
    const acquired = await rateLimiter.acquire('exec-1', 'agent-1');
    assert.strictEqual(acquired, true);

    const stats = rateLimiter.getStats();
    assert.strictEqual(stats.activeExecutions, 1);

    rateLimiter.release('exec-1');
    const statsAfter = rateLimiter.getStats();
    assert.strictEqual(statsAfter.activeExecutions, 0);
  });

  it('should reject when concurrent limit reached', async () => {
    await rateLimiter.acquire('exec-1', 'agent-1');
    await rateLimiter.acquire('exec-2', 'agent-1');

    const acquired = await rateLimiter.acquire('exec-3', 'agent-1');
    assert.strictEqual(acquired, false);
  });

  it('should reject when per-minute limit reached', async () => {
    for (let i = 0; i < 5; i++) {
      await rateLimiter.acquire(`exec-${i}`, 'agent-1');
      rateLimiter.release(`exec-${i}`);
    }

    const acquired = await rateLimiter.acquire('exec-5', 'agent-1');
    assert.strictEqual(acquired, false);
  });

  it('should support per-agent limits', async () => {
    rateLimiter.setAgentLimit('agent-1', { maxPerMinute: 2, maxPerHour: 10 });

    await rateLimiter.acquire('exec-1', 'agent-1');
    rateLimiter.release('exec-1');
    await rateLimiter.acquire('exec-2', 'agent-1');
    rateLimiter.release('exec-2');

    const acquired = await rateLimiter.acquire('exec-3', 'agent-1');
    assert.strictEqual(acquired, false);
  });

  it('should get availability info', async () => {
    const availability = rateLimiter.getAvailability();
    assert.strictEqual(availability.concurrent.available, 2);
    assert.strictEqual(availability.perMinute.available, 5);
  });

  it('should get stats', async () => {
    await rateLimiter.acquire('exec-1', 'agent-1');
    const stats = rateLimiter.getStats();
    assert.strictEqual(stats.acceptedCount, 1);
    assert.strictEqual(stats.activeExecutions, 1);
  });
});

describe('DeepeningSnapshot', () => {
  let snapshot;

  beforeEach(() => {
    snapshot = new DeepeningSnapshot({ maxSnapshots: 5 });
  });

  it('should create and restore snapshots', () => {
    const state = { iteration: 1, score: 0.5, agents: ['a', 'b'] };
    const created = snapshot.create('exec-1', state);

    assert.strictEqual(created.executionId, 'exec-1');
    assert.strictEqual(created.state.iteration, 1);

    const restored = snapshot.restore(created.snapshotId);
    assert.strictEqual(restored.state.iteration, 1);
    assert.strictEqual(restored.state.agents.length, 2);
  });

  it('should list snapshots by execution', () => {
    snapshot.create('exec-1', { iteration: 1 });
    snapshot.create('exec-1', { iteration: 2 });
    snapshot.create('exec-2', { iteration: 1 });

    const list = snapshot.listByExecution('exec-1');
    assert.strictEqual(list.length, 2);
  });

  it('should compare snapshots', () => {
    const snap1 = snapshot.create('exec-1', { iteration: 1, score: 0.5 });
    const snap2 = snapshot.create('exec-1', { iteration: 2, score: 0.8 });

    const comparison = snapshot.compare(snap1.snapshotId, snap2.snapshotId);
    assert.strictEqual(comparison.diff.length, 2);
    assert.strictEqual(comparison.timeDiff >= 0, true);
  });

  it('should delete snapshots', () => {
    const created = snapshot.create('exec-1', { iteration: 1 });
    assert.strictEqual(snapshot.delete(created.snapshotId), true);
    assert.strictEqual(snapshot.get(created.snapshotId), null);
  });

  it('should enforce max snapshots limit', () => {
    for (let i = 0; i < 7; i++) {
      snapshot.create('exec-1', { iteration: i });
    }

    const stats = snapshot.getStats();
    assert.strictEqual(stats.totalSnapshots, 5);
  });

  it('should get stats', () => {
    snapshot.create('exec-1', { iteration: 1 });
    snapshot.create('exec-2', { iteration: 1 });

    const stats = snapshot.getStats();
    assert.strictEqual(stats.totalSnapshots, 2);
    assert.strictEqual(stats.maxSnapshots, 5);
  });
});

describe('DeepeningNotifier', () => {
  let notifier;

  beforeEach(() => {
    notifier = new DeepeningNotifier({ minLevel: 'info' });
  });

  it('should register and unregister channels', () => {
    notifier.registerChannel('console', { type: 'console' });
    assert.strictEqual(notifier.getStats().channelCount, 1);

    notifier.unregisterChannel('console');
    assert.strictEqual(notifier.getStats().channelCount, 0);
  });

  it('should subscribe and unsubscribe', () => {
    notifier.registerChannel('console', { type: 'console' });
    const subId = notifier.subscribe('execution.*', 'console');
    assert.strictEqual(notifier.getStats().subscriptionCount, 1);

    notifier.unsubscribe(subId);
    assert.strictEqual(notifier.getStats().subscriptionCount, 0);
  });

  it('should send notifications to matching channels', async () => {
    let received = null;
    notifier.registerChannel('callback', {
      type: 'callback',
      callback: (notification) => { received = notification; },
    });

    notifier.subscribe('execution.complete', 'callback');
    await notifier.notifyInfo('execution.complete', { score: 0.95 });

    assert.ok(received);
    assert.strictEqual(received.event, 'execution.complete');
    assert.strictEqual(received.level, 'info');
  });

  it('should filter notifications by level', async () => {
    let received = null;
    notifier.registerChannel('callback', {
      type: 'callback',
      callback: (notification) => { received = notification; },
    });

    notifier.subscribe('test.*', 'callback', { minLevel: 'error' });

    await notifier.notifyInfo('test.event', { data: 'test' });
    assert.strictEqual(received, null);

    await notifier.notifyError('test.event', { data: 'test' });
    assert.ok(received);
    assert.strictEqual(received.level, 'error');
  });

  it('should support wildcard event patterns', async () => {
    let received = null;
    notifier.registerChannel('callback', {
      type: 'callback',
      callback: (notification) => { received = notification; },
    });

    notifier.subscribe('execution.*', 'callback');
    await notifier.notifyInfo('execution.complete', { score: 0.95 });

    assert.ok(received);
    assert.strictEqual(received.event, 'execution.complete');
  });

  it('should log notifications', async () => {
    await notifier.notifyInfo('test.event', { data: 'test' });
    const log = notifier.getNotificationLog({ limit: 10 });
    assert.strictEqual(log.length, 1);
  });

  it('should get stats', async () => {
    notifier.registerChannel('console', { type: 'console' });
    notifier.subscribe('test.*', 'console');
    await notifier.notifyInfo('test.event', { data: 'test' });

    const stats = notifier.getStats();
    assert.strictEqual(stats.channelCount, 1);
    assert.strictEqual(stats.subscriptionCount, 1);
    assert.strictEqual(stats.totalNotifications, 1);
  });

  it('should enable and disable subscriptions', async () => {
    let received = null;
    notifier.registerChannel('callback', {
      type: 'callback',
      callback: (notification) => { received = notification; },
    });

    const subId = notifier.subscribe('test.*', 'callback');

    notifier.disableSubscription(subId);
    await notifier.notifyInfo('test.event', { data: 'test' });
    assert.strictEqual(received, null);

    notifier.enableSubscription(subId);
    await notifier.notifyInfo('test.event', { data: 'test' });
    assert.ok(received);
  });
});
