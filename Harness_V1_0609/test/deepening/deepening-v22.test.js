'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningTaskScheduler = require('../../src/runtime/deepening/deepening-task-scheduler');

describe('DeepeningTaskScheduler - Schedule and Execute', function() {
  let ts;

  beforeEach(function() {
    ts = new DeepeningTaskScheduler({ maxConcurrent: 5 });
  });

  afterEach(async function() {
    if (ts) await ts.shutdown();
  });

  it('should create with defaults', function() {
    const t = new DeepeningTaskScheduler();
    assert.strictEqual(t.getStats().totalTasks, 0);
    assert.strictEqual(t.getStats().maxConcurrent, 10);
    t.shutdown();
  });

  it('should schedule a one-time task', function() {
    const id = ts.schedule('test-task', function() {});
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(ts.getStats().totalScheduled, 1);
  });

  it('should throw on schedule without name', function() {
    assert.throws(function() { ts.schedule('', function() {}); }, /Task name is required/);
  });

  it('should throw on schedule without function', function() {
    assert.throws(function() { ts.schedule('test', 'not-fn'); }, /Task handler must be a function/);
  });

  it('should emit scheduled event', function() {
    let emitted = null;
    ts.on('scheduled', function(e) { emitted = e; });
    ts.schedule('test-task', function() {});
    assert.strictEqual(emitted.name, 'test-task');
    assert.strictEqual(emitted.scheduleType, 'once');
  });

  it('should execute a task immediately', async function() {
    let executed = false;
    ts.schedule('test', function() { executed = true; });
    await new Promise(function(r) { setTimeout(r, 50); });
    assert.strictEqual(executed, true);
  });

  it('should emit started and completed events', async function() {
    let started = null;
    let completed = null;
    ts.on('started', function(e) { started = e; });
    ts.on('completed', function(e) { completed = e; });
    ts.schedule('test', function() { return 42; });
    await new Promise(function(r) { setTimeout(r, 50); });
    assert.strictEqual(started.name, 'test');
    assert.strictEqual(completed.name, 'test');
  });

  it('should execute a delayed task', async function() {
    let executed = false;
    ts.schedule('delayed', function() { executed = true; }, { delay: 80 });
    await new Promise(function(r) { setTimeout(r, 30); });
    assert.strictEqual(executed, false);
    await new Promise(function(r) { setTimeout(r, 80); });
    assert.strictEqual(executed, true);
  });

  it('should execute a recurring task', async function() {
    let count = 0;
    ts.schedule('recurring', function() { count++; }, { scheduleType: 'recurring', interval: 50 });
    await new Promise(function(r) { setTimeout(r, 300); });
    assert.ok(count >= 2);
  });

  it('should cancel a pending task', function() {
    const id = ts.schedule('cancel-me', function() {}, { delay: 5000 });
    let emitted = null;
    ts.on('cancelled', function(e) { emitted = e; });
    const result = ts.cancel(id);
    assert.strictEqual(result, true);
    assert.strictEqual(emitted.name, 'cancel-me');
  });

  it('should return false for cancelling unknown task', function() {
    assert.strictEqual(ts.cancel(9999), false);
  });

  it('should cancel tasks by name', function() {
    ts.schedule('task-a', function() {}, { delay: 5000 });
    ts.schedule('task-a', function() {}, { delay: 5000 });
    ts.schedule('task-b', function() {}, { delay: 5000 });
    const count = ts.cancelByName('task-a');
    assert.strictEqual(count, 2);
  });
});

describe('DeepeningTaskScheduler - Failure and Stats', function() {
  let ts;

  beforeEach(function() {
    ts = new DeepeningTaskScheduler({ maxConcurrent: 5 });
  });

  afterEach(async function() {
    if (ts) await ts.shutdown();
  });

  it('should handle task failure', async function() {
    let failed = null;
    ts.on('failed', function(e) { failed = e; });
    ts.schedule('fail-task', function() { throw new Error('boom'); });
    await new Promise(function(r) { setTimeout(r, 50); });
    assert.strictEqual(failed.name, 'fail-task');
    assert.strictEqual(failed.error, 'boom');
  });

  it('should retry on failure', async function() {
    let attempts = 0;
    ts.schedule('retry-task', function() {
      attempts++;
      if (attempts < 3) throw new Error('not yet');
    }, { retries: 3, delay: 0 });
    await new Promise(function(r) { setTimeout(r, 100); });
    assert.ok(attempts >= 2);
  });

  it('should emit retrying event', async function() {
    let retrying = null;
    ts.on('retrying', function(e) { retrying = e; });
    ts.schedule('retry-emit', function() { throw new Error('fail'); }, { retries: 1 });
    await new Promise(function(r) { setTimeout(r, 200); });
    assert.strictEqual(retrying.name, 'retry-emit');
    assert.strictEqual(retrying.retryCount, 1);
  });

  it('should get task info', function() {
    const id = ts.schedule('info-task', function() {}, { delay: 5000 });
    const info = ts.getTask(id);
    assert.strictEqual(info.name, 'info-task');
    assert.strictEqual(info.state, 'pending');
    assert.strictEqual(info.scheduleType, 'once');
  });

  it('should return null for unknown task', function() {
    assert.strictEqual(ts.getTask(9999), null);
  });

  it('should get pending tasks', function() {
    ts.schedule('p1', function() {}, { delay: 5000 });
    ts.schedule('p2', function() {}, { delay: 5000 });
    const pending = ts.getPending();
    assert.strictEqual(pending.length, 2);
  });

  it('should get running tasks', async function() {
    ts.schedule('run-me', function() { return new Promise(function(r) { setTimeout(r, 200); }); });
    await new Promise(function(r) { setTimeout(r, 30); });
    const running = ts.getRunning();
    assert.strictEqual(running.length, 1);
  });

  it('should get tasks by name', function() {
    ts.schedule('dup', function() {}, { delay: 5000 });
    ts.schedule('dup', function() {}, { delay: 5000 });
    const results = ts.getByName('dup');
    assert.strictEqual(results.length, 2);
  });

  it('should get stats', function() {
    ts.schedule('s1', function() {}, { delay: 5000 });
    ts.schedule('s2', function() {}, { delay: 5000 });
    const stats = ts.getStats();
    assert.strictEqual(stats.totalTasks, 2);
    assert.strictEqual(stats.totalScheduled, 2);
    assert.strictEqual(stats.maxConcurrent, 5);
  });

  it('should track byState in stats', async function() {
    ts.schedule('done', function() { return 1; });
    await new Promise(function(r) { setTimeout(r, 50); });
    const stats = ts.getStats();
    assert.strictEqual(stats.byState.completed, 1);
  });

  it('should throw on schedule during shutdown', async function() {
    await ts.shutdown();
    assert.throws(function() { ts.schedule('late', function() {}); }, /Cannot schedule during shutdown/);
  });

  it('should expose TASK_STATES', function() {
    assert.strictEqual(DeepeningTaskScheduler.TASK_STATES.PENDING, 'pending');
    assert.strictEqual(DeepeningTaskScheduler.TASK_STATES.RUNNING, 'running');
    assert.strictEqual(DeepeningTaskScheduler.TASK_STATES.COMPLETED, 'completed');
    assert.strictEqual(DeepeningTaskScheduler.TASK_STATES.FAILED, 'failed');
    assert.strictEqual(DeepeningTaskScheduler.TASK_STATES.CANCELLED, 'cancelled');
  });

  it('should expose SCHEDULE_TYPES', function() {
    assert.strictEqual(DeepeningTaskScheduler.SCHEDULE_TYPES.ONCE, 'once');
    assert.strictEqual(DeepeningTaskScheduler.SCHEDULE_TYPES.RECURRING, 'recurring');
    assert.strictEqual(DeepeningTaskScheduler.SCHEDULE_TYPES.CRON, 'cron');
  });

  it('should be healthy', function() {
    assert.strictEqual(ts.isHealthy(), true);
  });
});
