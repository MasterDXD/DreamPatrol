'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const DeepeningTaskScheduler = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-task-scheduler'));

describe('DeepeningTaskScheduler - basic', () => {
  it('should create instance with default config', () => {
    const sched = new DeepeningTaskScheduler();
    assert.ok(sched);
    assert.strictEqual(sched._maxConcurrent, 10);
    sched.shutdown();
  });

  it('should schedule and execute a once task', async () => {
    const sched = new DeepeningTaskScheduler();
    let executed = false;
    sched.schedule('test-once', async () => { executed = true; });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(executed, true);
    sched.shutdown();
  });

  it('should cancel a task', () => {
    const sched = new DeepeningTaskScheduler();
    const id = sched.schedule('cancel-test', () => {}, { delay: 5000 });
    const result = sched.cancel(id);
    assert.strictEqual(result, true);
    sched.shutdown();
  });

  it('should throw on schedule during shutdown', () => {
    const sched = new DeepeningTaskScheduler();
    sched.shutdown();
    assert.throws(() => sched.schedule('after-shutdown', () => {}), /SHUTDOWN_IN_PROGRESS/);
  });

  it('should get stats', () => {
    const sched = new DeepeningTaskScheduler();
    const stats = sched.getStats();
    assert.strictEqual(stats.totalTasks, 0);
    assert.strictEqual(stats.maxConcurrent, 10);
    sched.shutdown();
  });
});

describe('DeepeningTaskScheduler - cron', () => {
  it('should emit cron-scheduled event', async () => {
    const sched = new DeepeningTaskScheduler();
    let cronScheduled = false;
    sched.on('cron-scheduled', () => { cronScheduled = true; });
    sched.schedule('cron-emit', () => {}, { scheduleType: 'cron', cronExpression: '0 * * * *' });
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(cronScheduled, true);
    sched.shutdown();
  });

  it('should emit cron-parse-error for invalid expression', async () => {
    const sched = new DeepeningTaskScheduler();
    let parseError = false;
    sched.on('cron-parse-error', () => { parseError = true; });
    sched.schedule('cron-invalid', () => {}, { scheduleType: 'cron', cronExpression: 'bad' });
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(parseError, true);
    sched.shutdown();
  });
});

describe('DeepeningTaskScheduler - trigger', () => {
  it('should trigger a task by name', async () => {
    const sched = new DeepeningTaskScheduler();
    let triggered = false;
    let receivedContext = null;
    sched.schedule('triggerable', async (ctx) => {
      triggered = true;
      receivedContext = ctx;
    }, { delay: 60000 });
    const result = sched.trigger('triggerable', { key: 'value' });
    assert.strictEqual(result, true);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(triggered, true);
    assert.deepStrictEqual(receivedContext, { key: 'value' });
    sched.shutdown();
  });

  it('should emit triggered event', async () => {
    const sched = new DeepeningTaskScheduler();
    let triggeredEvent = null;
    sched.on('triggered', (e) => { triggeredEvent = e; });
    sched.schedule('trigger-evt', () => {}, { delay: 60000 });
    sched.trigger('trigger-evt');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(triggeredEvent);
    assert.strictEqual(triggeredEvent.name, 'trigger-evt');
    assert.strictEqual(triggeredEvent.source, 'external');
    sched.shutdown();
  });

  it('should return false for non-existent task', () => {
    const sched = new DeepeningTaskScheduler();
    const result = sched.trigger('nonexistent');
    assert.strictEqual(result, false);
    sched.shutdown();
  });

  it('should return false for cancelled task', () => {
    const sched = new DeepeningTaskScheduler();
    const id = sched.schedule('cancelled-trigger', () => {}, { delay: 60000 });
    sched.cancel(id);
    const result = sched.trigger('cancelled-trigger');
    assert.strictEqual(result, false);
    sched.shutdown();
  });

  it('should throw on trigger during shutdown', () => {
    const sched = new DeepeningTaskScheduler();
    sched.shutdown();
    assert.throws(() => sched.trigger('any'), /\[SHUTDOWN\]/);
  });
});

describe('DeepeningTaskScheduler - shutdown cleanup', () => {
  it('should clear all timers on shutdown', () => {
    const sched = new DeepeningTaskScheduler();
    sched.schedule('t1', () => {}, { delay: 60000 });
    sched.schedule('t2', () => {}, { scheduleType: 'recurring', interval: 60000 });
    sched.schedule('t3', () => {}, { scheduleType: 'cron', cronExpression: '0 * * * *' });
    sched.shutdown();
    const stats = sched.getStats();
    assert.strictEqual(stats.totalTasks, 0);
  });

  it('should cancel by name', () => {
    const sched = new DeepeningTaskScheduler();
    sched.schedule('named-1', () => {}, { delay: 60000 });
    sched.schedule('named-1', () => {}, { delay: 60000 });
    const count = sched.cancelByName('named-1');
    assert.strictEqual(count, 2);
    sched.shutdown();
  });
});
