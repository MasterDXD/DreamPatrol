'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DreamScheduler } = require('../../../src/runtime/thought/dream-scheduler');

describe('DreamScheduler', () => {
  it('should start and stop scheduler', () => {
    const scheduler = new DreamScheduler({ intervalMs: 1000 });
    scheduler.start();
    assert.equal(scheduler.isRunning(), true);
    scheduler.stop();
    assert.equal(scheduler.isRunning(), false);
  });

  it('should not start twice', () => {
    const scheduler = new DreamScheduler({ intervalMs: 1000 });
    scheduler.start();
    scheduler.start();
    assert.equal(scheduler.isRunning(), true);
    scheduler.stop();
  });

  it('should handle session end dreaming', async () => {
    let dreamCalled = false;
    const mockEngine = { startDreaming: () => { dreamCalled = true; return [{ id: 'n1' }]; } };
    const scheduler = new DreamScheduler({ dreamEngine: mockEngine });
    const result = await scheduler.onSessionEnd('s1', [], {});
    assert.equal(dreamCalled, true);
    assert.ok(result);
  });

  it('should handle dream engine errors gracefully', async () => {
    const mockEngine = { startDreaming: () => { throw new Error('dream fail'); } };
    const scheduler = new DreamScheduler({ dreamEngine: mockEngine });
    const result = await scheduler.onSessionEnd('s1', [], {});
    assert.equal(result, null);
  });

  it('should work without dream engine', async () => {
    const scheduler = new DreamScheduler();
    const result = await scheduler.onSessionEnd('s1', [], {});
    assert.equal(result, null);
  });

  it('should return stats', () => {
    const scheduler = new DreamScheduler({ intervalMs: 5000 });
    const stats = scheduler.getStats();
    assert.equal(stats.running, false);
    assert.equal(stats.intervalMs, 5000);
  });

  it('should emit events on start and stop', () => {
    const scheduler = new DreamScheduler({ intervalMs: 100000 });
    const events = [];
    scheduler.on('scheduler:started', () => events.push('start'));
    scheduler.on('scheduler:stopped', () => events.push('stop'));
    scheduler.start();
    scheduler.stop();
    assert.ok(events.includes('start'));
    assert.ok(events.includes('stop'));
  });

  it('should emit event on session end dream', async () => {
    const mockEngine = { startDreaming: () => [{ id: 'n1' }] };
    const scheduler = new DreamScheduler({ dreamEngine: mockEngine });
    const events = [];
    scheduler.on('dream:session:end', (e) => events.push(e));
    await scheduler.onSessionEnd('s1', [], {});
    assert.equal(events.length, 1);
    assert.equal(events[0].sessionId, 's1');
  });

  describe('SM-2 adaptive interval', () => {
    it('should record dream performance and adjust interval', () => {
      const scheduler = new DreamScheduler({ intervalMs: 1000 });
      const interval = scheduler.recordDreamPerformance(0.9);
      assert.ok(typeof interval === 'number');
      assert.ok(interval > 0);
      const stats = scheduler.getStats();
      assert.equal(stats.sm2Adjustments, 1);
      assert.equal(stats.sm2LastPerformance, 0.9);
    });

    it('should increase interval for high performance', () => {
      const scheduler = new DreamScheduler({ intervalMs: 1000 });
      const base = scheduler.getAdaptiveIntervalMs();
      scheduler.recordDreamPerformance(0.95);
      const after = scheduler.getAdaptiveIntervalMs();
      assert.ok(after >= base);
    });

    it('should decrease stability for low performance', () => {
      const scheduler = new DreamScheduler({ intervalMs: 1000 });
      scheduler.recordDreamPerformance(0.95);
      const highStability = scheduler.getStats().sm2Stability;
      scheduler.recordDreamPerformance(0.2);
      const lowStability = scheduler.getStats().sm2Stability;
      assert.ok(lowStability < highStability);
    });

    it('should clamp performance to [0, 1]', () => {
      const scheduler = new DreamScheduler({ intervalMs: 1000 });
      scheduler.recordDreamPerformance(5.0);
      assert.equal(scheduler.getStats().sm2LastPerformance, 1);
      scheduler.recordDreamPerformance(-3.0);
      assert.equal(scheduler.getStats().sm2LastPerformance, 0);
    });

    it('should handle non-numeric performance gracefully', () => {
      const scheduler = new DreamScheduler({ intervalMs: 1000 });
      scheduler.recordDreamPerformance('bad');
      assert.equal(scheduler.getStats().sm2LastPerformance, 0.5);
    });

    it('should emit sm2:interval-adjusted event', () => {
      const scheduler = new DreamScheduler({ intervalMs: 1000 });
      const events = [];
      scheduler.on('sm2:interval-adjusted', (e) => events.push(e));
      scheduler.recordDreamPerformance(0.8);
      assert.equal(events.length, 1);
      assert.ok(typeof events[0].intervalMs === 'number');
      assert.ok(typeof events[0].stability === 'number');
      assert.equal(events[0].performance, 0.8);
    });

    it('should reset SM-2 state on shutdown', () => {
      const scheduler = new DreamScheduler({ intervalMs: 1000 });
      scheduler.recordDreamPerformance(0.9);
      scheduler.shutdown();
      const stats = scheduler.getStats();
      assert.equal(stats.sm2Stability, 1.0);
      assert.equal(stats.sm2Adjustments, 0);
    });
  });
});
