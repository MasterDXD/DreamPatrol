'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningGracefulShutdown = require('../../src/runtime/deepening/deepening-graceful-shutdown');

describe('DeepeningGracefulShutdown', function() {
  let gs;

  beforeEach(function() {
    gs = new DeepeningGracefulShutdown({ timeout: 5000 });
  });

  afterEach(async function() {
    const old = gs;
    gs = null;
    if (old) await old.shutdownManager();
  });

  it('should create with defaults', function() {
    const g = new DeepeningGracefulShutdown();
    assert.strictEqual(g.getStats().timeout, 30000);
    assert.strictEqual(g.getStats().totalSteps, 0);
    g.shutdownManager();
  });

  it('should add a step', function() {
    gs.addStep('close-db', function() {}, { phase: 'drain' });
    assert.strictEqual(gs.getStats().totalSteps, 1);
  });

  it('should throw on add step without name', function() {
    assert.throws(function() { gs.addStep(''); }, /Step name is required/);
  });

  it('should throw on add step without function', function() {
    assert.throws(function() { gs.addStep('test', 'not-fn'); }, /Step handler must be a function/);
  });

  it('should not add duplicate step', function() {
    gs.addStep('close-db', function() {});
    gs.addStep('close-db', function() {});
    assert.strictEqual(gs.getStats().totalSteps, 1);
  });

  it('should emit stepAdded event', function() {
    let emitted = null;
    gs.on('stepAdded', function(e) { emitted = e; });
    gs.addStep('close-db', function() {}, { phase: 'drain' });
    assert.strictEqual(emitted.name, 'close-db');
    assert.strictEqual(emitted.phase, 'drain');
  });

  it('should throw on add step during shutdown', async function() {
    gs.addStep('s1', function() { return new Promise(function(r) { setTimeout(r, 200); }); });
    const p = gs.shutdown();
    assert.throws(function() { gs.addStep('s2', function() {}); }, /Cannot add steps during shutdown/);
    await p;
  });

  it('should remove a step', function() {
    gs.addStep('close-db', function() {});
    const result = gs.removeStep('close-db');
    assert.strictEqual(result, true);
    assert.strictEqual(gs.getStats().totalSteps, 0);
  });

  it('should return false for removing unknown step', function() {
    assert.strictEqual(gs.removeStep('unknown'), false);
  });

  it('should get steps sorted by order', function() {
    gs.addStep('step-b', function() {}, { phase: 'stop', order: 2 });
    gs.addStep('step-a', function() {}, { phase: 'drain', order: 1 });
    const steps = gs.getSteps();
    assert.strictEqual(steps[0].name, 'step-a');
    assert.strictEqual(steps[1].name, 'step-b');
  });

  it('should execute shutdown in phases', async function() {
    const order = [];
    gs.addStep('drain-1', function() { order.push('drain-1'); }, { phase: 'drain' });
    gs.addStep('stop-1', function() { order.push('stop-1'); }, { phase: 'stop' });
    gs.addStep('cleanup-1', function() { order.push('cleanup-1'); }, { phase: 'cleanup' });
    await gs.shutdown();
    assert.strictEqual(order[0], 'drain-1');
    assert.strictEqual(order[1], 'stop-1');
    assert.strictEqual(order[2], 'cleanup-1');
  });

  it('should emit shutdownStarted and shutdownCompleted events', async function() {
    let started = null;
    let completed = null;
    gs.on('shutdownStarted', function(e) { started = e; });
    gs.on('shutdownCompleted', function(e) { completed = e; });
    gs.addStep('s1', function() {});
    await gs.shutdown();
    assert.strictEqual(started.steps, 1);
    assert.strictEqual(completed.completed, 1);
    assert.strictEqual(completed.failed, 0);
    assert.ok(completed.duration >= 0);
  });

  it('should emit phaseStarted and phaseCompleted events', async function() {
    const phases = [];
    gs.on('phaseStarted', function(e) { phases.push('start:' + e.phase); });
    gs.on('phaseCompleted', function(e) { phases.push('end:' + e.phase); });
    gs.addStep('s1', function() {}, { phase: 'drain' });
    await gs.shutdown();
    assert.ok(phases.indexOf('start:drain') >= 0);
    assert.ok(phases.indexOf('end:drain') >= 0);
  });

  it('should emit stepStarted and stepCompleted events', async function() {
    let started = null;
    let completed = null;
    gs.on('stepStarted', function(e) { started = e; });
    gs.on('stepCompleted', function(e) { completed = e; });
    gs.addStep('close-db', function() {});
    await gs.shutdown();
    assert.strictEqual(started.name, 'close-db');
    assert.strictEqual(completed.name, 'close-db');
    assert.ok(completed.duration >= 0);
  });

  it('should handle step failure', async function() {
    let failed = null;
    gs.on('stepFailed', function(e) { failed = e; });
    gs.addStep('bad-step', function() { throw new Error('boom'); });
    await gs.shutdown();
    assert.strictEqual(failed.name, 'bad-step');
    assert.strictEqual(failed.error, 'boom');
    const progress = gs.getProgress();
    assert.strictEqual(progress.failed, 1);
  });

  it('should handle step dependencies', async function() {
    const order = [];
    gs.addStep('step-a', function() { order.push('a'); }, { phase: 'stop', order: 1 });
    gs.addStep('step-b', function() { order.push('b'); }, { phase: 'stop', order: 2, dependsOn: ['step-a'] });
    await gs.shutdown();
    assert.strictEqual(order[0], 'a');
    assert.strictEqual(order[1], 'b');
  });

  it('should handle unresolved dependencies', async function() {
    let failed = null;
    gs.on('stepFailed', function(e) { failed = e; });
    gs.addStep('step-b', function() {}, { phase: 'stop', dependsOn: ['missing-step'] });
    await gs.shutdown();
    assert.strictEqual(failed.name, 'step-b');
    assert.strictEqual(failed.error, 'Unresolved dependency');
  });

  it('should track progress', async function() {
    gs.addStep('s1', function() {}, { phase: 'drain' });
    gs.addStep('s2', function() {}, { phase: 'stop' });
    await gs.shutdown();
    const progress = gs.getProgress();
    assert.strictEqual(progress.total, 2);
    assert.strictEqual(progress.completed, 2);
    assert.strictEqual(progress.failed, 0);
    assert.strictEqual(progress.remaining, 0);
    assert.strictEqual(progress.phase, 'done');
  });

  it('should return isShuttingDown', async function() {
    gs.addStep('s1', function() { return new Promise(function(r) { setTimeout(r, 50); }); });
    const p = gs.shutdown();
    assert.strictEqual(gs.isShuttingDown(), true);
    await p;
  });

  it('should get phase', async function() {
    let phaseDuringDrain = null;
    gs.addStep('s1', function() {
      phaseDuringDrain = gs.getPhase();
    }, { phase: 'drain' });
    await gs.shutdown();
    assert.strictEqual(phaseDuringDrain, 'drain');
    assert.strictEqual(gs.getPhase(), 'done');
  });

  it('should increment totalShutdowns', async function() {
    gs.addStep('s1', function() {});
    await gs.shutdown();
    gs.reset();
    gs.addStep('s1', function() {});
    await gs.shutdown();
    assert.strictEqual(gs.getStats().totalShutdowns, 2);
  });

  it('should reset state', async function() {
    gs.addStep('s1', function() {});
    await gs.shutdown();
    let resetEmitted = false;
    gs.on('reset', function() { resetEmitted = true; });
    gs.reset();
    assert.strictEqual(gs.isShuttingDown(), false);
    assert.strictEqual(gs.getPhase(), null);
    assert.strictEqual(resetEmitted, true);
  });

  it('should expose SHUTDOWN_PHASES', function() {
    assert.strictEqual(DeepeningGracefulShutdown.SHUTDOWN_PHASES.DRAIN, 'drain');
    assert.strictEqual(DeepeningGracefulShutdown.SHUTDOWN_PHASES.STOP, 'stop');
    assert.strictEqual(DeepeningGracefulShutdown.SHUTDOWN_PHASES.CLEANUP, 'cleanup');
    assert.strictEqual(DeepeningGracefulShutdown.SHUTDOWN_PHASES.DONE, 'done');
  });

  it('should shutdownManager cleanly', function() {
    gs.addStep('s1', function() {});
    let emitted = false;
    gs.on('shutdownManager', function() { emitted = true; });
    gs.shutdownManager();
    assert.strictEqual(emitted, true);
    assert.strictEqual(gs.getStats().totalSteps, 0);
  });

  it('should be healthy', function() {
    assert.strictEqual(gs.isHealthy(), true);
  });
});
