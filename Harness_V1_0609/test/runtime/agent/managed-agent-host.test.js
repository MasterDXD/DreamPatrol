'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ManagedAgentHost = require('../../../src/runtime/agent/managed-agent-host');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mah-test-'));
}

describe('ManagedAgentHost', () => {
  let tmpDir;
  let host;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    host = new ManagedAgentHost(tmpDir);
  });

  after(() => {
    try { host.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should expose static constants', () => {
    assert.ok(ManagedAgentHost.TRIGGER_MODES);
    assert.equal(ManagedAgentHost.TRIGGER_MODES.EVENT, 'event');
    assert.equal(ManagedAgentHost.TRIGGER_MODES.SCHEDULE, 'schedule');
    assert.equal(ManagedAgentHost.TRIGGER_MODES.WEBHOOK, 'webhook');
    assert.equal(ManagedAgentHost.TRIGGER_MODES.FIRE_AND_FORGET, 'fire-and-forget');
    assert.ok(ManagedAgentHost.HOST_STATES);
    assert.equal(ManagedAgentHost.HOST_STATES.IDLE, 'idle');
    assert.equal(ManagedAgentHost.HOST_STATES.RUNNING, 'running');
    assert.equal(ManagedAgentHost.HOST_STATES.PAUSED, 'paused');
    assert.equal(ManagedAgentHost.HOST_STATES.STOPPED, 'stopped');
    assert.equal(ManagedAgentHost.HOST_STATES.ERROR, 'error');
    assert.ok(ManagedAgentHost.MAX_HOSTED_AGENTS > 0);
  });

  it('should register an agent', () => {
    const result = host.registerAgent('test-agent', {
      runtime: { infer: async () => 'ok' },
      triggerMode: 'event',
    });
    assert.equal(result.agentId, 'test-agent');
    assert.equal(result.state, 'idle');
    assert.equal(result.triggerMode, 'event');
  });

  it('should throw on duplicate registration', () => {
    assert.throws(() => {
      host.registerAgent('test-agent', {
        runtime: { infer: async () => 'ok' },
      });
    }, /already registered/);
  });

  it('should throw on missing agentId', () => {
    assert.throws(() => {
      host.registerAgent('', { runtime: {} });
    }, /must be a non-empty string/);
  });

  it('should throw on missing config.runtime', () => {
    assert.throws(() => {
      host.registerAgent('no-runtime', {});
    }, /config\.runtime is required/);
  });

  it('should throw on invalid triggerMode', () => {
    assert.throws(() => {
      host.registerAgent('bad-trigger', { runtime: {}, triggerMode: 'invalid' });
    }, /invalid triggerMode/);
  });

  it('should start an agent', () => {
    const ok = host.startAgent('test-agent');
    assert.equal(ok, true);
    const status = host.getAgentStatus('test-agent');
    assert.equal(status.state, 'running');
  });

  it('should not start already running agent', () => {
    const ok = host.startAgent('test-agent');
    assert.equal(ok, false);
  });

  it('should pause an agent', () => {
    const ok = host.pauseAgent('test-agent');
    assert.equal(ok, true);
    const status = host.getAgentStatus('test-agent');
    assert.equal(status.state, 'paused');
  });

  it('should resume a paused agent', () => {
    const ok = host.resumeAgent('test-agent');
    assert.equal(ok, true);
    const status = host.getAgentStatus('test-agent');
    assert.equal(status.state, 'running');
  });

  it('should stop an agent', () => {
    const ok = host.stopAgent('test-agent');
    assert.equal(ok, true);
    const status = host.getAgentStatus('test-agent');
    assert.equal(status.state, 'stopped');
  });

  it('should not trigger a stopped agent', async () => {
    const result = await host.triggerExecution('test-agent', {});
    assert.equal(result.status, 'not_running');
  });

  it('should return null for non-existent agent status', () => {
    assert.equal(host.getAgentStatus('non-existent'), null);
  });

  it('should unregister an agent', () => {
    const ok = host.unregisterAgent('test-agent');
    assert.equal(ok, true);
    assert.equal(host.getAgentStatus('test-agent'), null);
  });

  it('should return false for unregistering non-existent agent', () => {
    const ok = host.unregisterAgent('non-existent');
    assert.equal(ok, false);
  });
});

describe('ManagedAgentHost - Trigger Execution', () => {
  let tmpDir;
  let host;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    host = new ManagedAgentHost(tmpDir);
  });

  after(() => {
    try { host.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should trigger execution with runtime.infer', async () => {
    const runtime = {
      infer: async (payload) => ({ result: 'inferred', payload }),
    };
    host.registerAgent('infer-agent', { runtime, triggerMode: 'event' });
    host.startAgent('infer-agent');

    const result = await host.triggerExecution('infer-agent', {
      payload: { test: true },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.agentId, 'infer-agent');
    assert.ok(result.executionId);
    assert.ok(result.duration >= 0);
    assert.ok(result.result);
    assert.equal(result.result.result, 'inferred');
  });

  it('should trigger execution with GoalExecutor', async () => {
    const goalExecutor = {
      createGoal: async (agentId, opts) => ({ goalCreated: true, agentId, objective: opts.objective }),
    };
    host.attachGoalExecutor(goalExecutor);

    host.registerAgent('goal-agent', {
      runtime: { infer: async () => 'fallback' },
      triggerMode: 'event',
    });
    host.startAgent('goal-agent');

    const result = await host.triggerExecution('goal-agent', {
      payload: { action: 'test' },
    });
    assert.equal(result.status, 'completed');
    assert.ok(result.result);
    assert.equal(result.result.goalCreated, true);
  });

  it('should not trigger already executing agent', async () => {
    // 使用独立的host，避免GoalExecutor干扰
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mah-slow-'));
    fs.mkdirSync(path.join(tmpDir2, '.harness'), { recursive: true });
    const slowHost = new ManagedAgentHost(tmpDir2);

    let resolveInfer;
    const slowRuntime = {
      infer: async () => new Promise((resolve) => { resolveInfer = resolve; }),
    };
    slowHost.registerAgent('slow-agent', { runtime: slowRuntime, triggerMode: 'event' });
    slowHost.startAgent('slow-agent');

    // Start first execution (don't await)
    const firstExec = slowHost.triggerExecution('slow-agent', { payload: 'first' });

    // Try to trigger again while executing
    const secondResult = await slowHost.triggerExecution('slow-agent', { payload: 'second' });
    assert.equal(secondResult.status, 'already_executing');

    // Complete the first execution
    resolveInfer('done');
    await firstExec;

    try { slowHost.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should record execution history', async () => {
    const runtime = { infer: async () => 'ok' };
    host.registerAgent('history-agent', { runtime, triggerMode: 'event' });
    host.startAgent('history-agent');

    await host.triggerExecution('history-agent', { payload: 'test1' });
    await host.triggerExecution('history-agent', { payload: 'test2' });

    const history = host.getExecutionHistory('history-agent');
    assert.ok(Array.isArray(history));
    assert.ok(history.length >= 2);
  });

  it('should return empty history for non-existent agent', () => {
    const history = host.getExecutionHistory('non-existent');
    assert.ok(Array.isArray(history));
    assert.equal(history.length, 0);
  });

  it('should return not_found for non-existent agent trigger', async () => {
    const result = await host.triggerExecution('non-existent', {});
    assert.equal(result.status, 'not_found');
  });
});

describe('ManagedAgentHost - Webhook Handling', () => {
  let tmpDir;
  let host;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    host = new ManagedAgentHost(tmpDir, { webhookSecret: 'test-secret' });
  });

  after(() => {
    try { host.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should handle webhook with valid signature', async () => {
    const runtime = { infer: async () => 'webhook-result' };
    host.registerAgent('webhook-agent', {
      runtime,
      triggerMode: 'webhook',
      webhookPath: '/github/push',
    });
    host.startAgent('webhook-agent');

    const payload = { ref: 'refs/heads/main', commits: [] };
    const signature = crypto.createHmac('sha256', 'test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const result = await host.handleWebhook('/github/push', payload, signature);
    assert.equal(result.status, 'completed');
    assert.equal(result.agentId, 'webhook-agent');
  });

  it('should reject webhook with invalid signature', async () => {
    const payload = { ref: 'refs/heads/main' };
    const result = await host.handleWebhook('/github/push', payload, 'invalid-sig');
    assert.equal(result.status, 'invalid_signature');
  });

  it('should return no_matching_agent for unknown path', async () => {
    const result = await host.handleWebhook('/unknown/path', {}, null);
    assert.equal(result.status, 'no_matching_agent');
  });

  it('should return invalid_path for empty path', async () => {
    const result = await host.handleWebhook('', {}, null);
    assert.equal(result.status, 'invalid_path');
  });
});

describe('ManagedAgentHost - Event Trigger', () => {
  let tmpDir;
  let host;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    host = new ManagedAgentHost(tmpDir);
  });

  after(() => {
    try { host.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should handle event trigger for subscribed agents', async () => {
    const runtime = { infer: async () => 'event-result' };
    host.registerAgent('event-agent', {
      runtime,
      triggerMode: 'event',
      eventSubscriptions: ['bug:detected', 'deploy:completed'],
    });
    host.startAgent('event-agent');

    const promises = host.handleEventTrigger('bug:detected', { bugId: 'BUG-001' });
    assert.ok(Array.isArray(promises));
    assert.equal(promises.length, 1);

    const result = await promises[0];
    assert.equal(result.status, 'completed');
    assert.equal(result.agentId, 'event-agent');
  });

  it('should not trigger agents for unsubscribed events', () => {
    const promises = host.handleEventTrigger('unrelated:event', {});
    assert.ok(Array.isArray(promises));
    assert.equal(promises.length, 0);
  });
});

describe('ManagedAgentHost - Stats and List', () => {
  let tmpDir;
  let host;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    host = new ManagedAgentHost(tmpDir);
  });

  after(() => {
    try { host.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should list agents', () => {
    host.registerAgent('list-a1', { runtime: { infer: async () => 'ok' }, triggerMode: 'event' });
    host.registerAgent('list-a2', { runtime: { infer: async () => 'ok' }, triggerMode: 'schedule' });

    const list = host.listAgents();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 2);
    const ids = list.map((a) => a.agentId);
    assert.ok(ids.includes('list-a1'));
    assert.ok(ids.includes('list-a2'));
  });

  it('should return stats', () => {
    const stats = host.getStats();
    assert.ok(stats.totalAgents >= 2);
    assert.ok(stats.maxAgents > 0);
    assert.ok(typeof stats.runningCount === 'number');
    assert.ok(typeof stats.idleCount === 'number');
    assert.ok(typeof stats.totalExecutions === 'number');
  });

  it('should enforce max hosted agents', () => {
    const smallHost = new ManagedAgentHost(tmpDir, { maxHostedAgents: 2 });
    smallHost.registerAgent('max-a1', { runtime: { infer: async () => 'ok' } });
    smallHost.registerAgent('max-a2', { runtime: { infer: async () => 'ok' } });
    assert.throws(() => {
      smallHost.registerAgent('max-a3', { runtime: { infer: async () => 'ok' } });
    }, /maximum hosted agents/);
    try { smallHost.shutdown(); } catch (_e) { /* best effort */ }
  });
});

describe('ManagedAgentHost - Shutdown', () => {
  it('should clean up on shutdown', () => {
    const tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    const h = new ManagedAgentHost(tmpDir);
    h.registerAgent('shutdown-agent', { runtime: { infer: async () => 'ok' } });
    h.startAgent('shutdown-agent');

    h.shutdown();
    assert.equal(h._shutDown, true);
    assert.equal(h._agents.size, 0);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should throw on register after shutdown', () => {
    const tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    const h = new ManagedAgentHost(tmpDir);
    h.shutdown();
    assert.throws(() => {
      h.registerAgent('after-shutdown', { runtime: {} });
    }, /shut down/);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });
});
