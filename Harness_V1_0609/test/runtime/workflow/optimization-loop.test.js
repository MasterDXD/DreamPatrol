'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OptimizationLoop = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'optimization-loop'));

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-optloop-test-'));

before(() => {
});

after(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ }
});

describe('OptimizationLoop constructor', () => {
  it('should construct with default config', () => {
    const loop = new OptimizationLoop();
    assert.strictEqual(loop._config.maxIterations, Infinity);
    assert.strictEqual(loop._config.convergenceThreshold, 0.85);
    assert.strictEqual(loop._config.iterationIntervalMs, 0);
    assert.strictEqual(loop._config.stagnationWindow, 5);
    assert.strictEqual(loop._config.resourceBudget, null);
    assert.strictEqual(loop._status, 'idle');
    loop.shutdown();
  });

  it('should construct with custom options', () => {
    const loop = new OptimizationLoop({
      maxIterations: 100,
      convergenceThreshold: 0.95,
      iterationIntervalMs: 1000,
      stagnationWindow: 10,
      resourceBudget: 5000,
      journalPath: path.join(TEST_DIR, 'custom-journal.md'),
    });
    assert.strictEqual(loop._config.maxIterations, 100);
    assert.strictEqual(loop._config.convergenceThreshold, 0.95);
    assert.strictEqual(loop._config.iterationIntervalMs, 1000);
    assert.strictEqual(loop._config.stagnationWindow, 10);
    assert.strictEqual(loop._config.resourceBudget, 5000);
    loop.shutdown();
  });
});

describe('defineObjective()', () => {
  it('should define objective with metrics', () => {
    const loop = new OptimizationLoop();
    const result = loop.defineObjective(
      '将模型loss降至0.01以下',
      ['maxTrainingTime: 2h'],
      [
        { name: 'val_loss', direction: 'minimize', target: 0.01, weight: 0.6 },
        { name: 'val_accuracy', direction: 'maximize', target: 0.99, weight: 0.4 },
      ],
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.objective, '将模型loss降至0.01以下');
    assert.strictEqual(result.metricCount, 2);
    loop.shutdown();
  });

  it('should reject empty objective', () => {
    const loop = new OptimizationLoop();
    const result = loop.defineObjective('', [], []);
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    loop.shutdown();
  });

  it('should reject non-string objective', () => {
    const loop = new OptimizationLoop();
    const result = loop.defineObjective(null, [], []);
    assert.strictEqual(result.success, false);
    loop.shutdown();
  });

  it('should apply objective options', () => {
    const loop = new OptimizationLoop();
    loop.defineObjective(
      'test objective',
      [],
      [{ name: 'm1', direction: 'maximize', target: 1, weight: 1 }],
      { convergenceThreshold: 0.9, stagnationWindow: 8, resourceBudget: 1000 },
    );
    assert.strictEqual(loop._config.convergenceThreshold, 0.9);
    assert.strictEqual(loop._config.stagnationWindow, 8);
    assert.strictEqual(loop._config.resourceBudget, 1000);
    loop.shutdown();
  });

  it('should use default direction for builtin metric types', () => {
    const loop = new OptimizationLoop();
    loop.defineObjective('test', [], [
      { name: 'loss_val', type: 'loss', target: 0.01, weight: 1 },
      { name: 'roi_val', type: 'roi', target: 3.0, weight: 1 },
    ]);
    assert.strictEqual(loop._metricsDefs.get('loss_val').direction, 'minimize');
    assert.strictEqual(loop._metricsDefs.get('roi_val').direction, 'maximize');
    loop.shutdown();
  });
});

describe('start() with bounded iterations', () => {
  it('should run bounded iterations and exhaust', async () => {
    const loop = new OptimizationLoop({ maxIterations: 3 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    const result = await loop.start(async () => ({
      metrics: { score: 0.5 },
    }));
    assert.strictEqual(result.success, true);
    await loop._loopPromise;
    assert.strictEqual(loop._status, 'exhausted');
    assert.strictEqual(loop._currentIteration, 3);
    loop.shutdown();
  });

  it('should reject start without objective', async () => {
    const loop = new OptimizationLoop();
    const result = await loop.start(async () => ({}));
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Objective'));
    loop.shutdown();
  });

  it('should reject start without executeFn', async () => {
    const loop = new OptimizationLoop();
    loop.defineObjective('test', [], [
      { name: 'm', direction: 'maximize', target: 1, weight: 1 },
    ]);
    const result = await loop.start(null);
    assert.strictEqual(result.success, false);
    loop.shutdown();
  });

  it('should reject double start', async () => {
    const loop = new OptimizationLoop({ maxIterations: 100 });
    loop.defineObjective('test', [], [
      { name: 'm', direction: 'maximize', target: 1, weight: 1 },
    ]);
    await loop.start(async () => ({ metrics: { m: 0.5 } }));
    const second = await loop.start(async () => ({}));
    assert.strictEqual(second.success, false);
    loop.stop();
    loop.shutdown();
  });
});

describe('start() with infinite mode', () => {
  it('should run until manually stopped', async () => {
    const loop = new OptimizationLoop({ maxIterations: Infinity, convergenceThreshold: 1.0, iterationIntervalMs: 10 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    loop.attachConvergenceDetector({ check: () => ({ converged: false, reason: 'disabled' }) });
    let iterationCount = 0;
    await loop.start(async () => {
      iterationCount++;
      if (iterationCount >= 3) {
        loop.stop();
      }
      return { metrics: { score: 0.5 } };
    });
    await loop._loopPromise;
    assert.strictEqual(loop._status, 'stopped');
    assert.strictEqual(loop._currentIteration, 3);
    loop.shutdown();
  });
});

describe('iteration interval', () => {
  it('should respect iterationIntervalMs > 0', async () => {
    const loop = new OptimizationLoop({ maxIterations: 2, iterationIntervalMs: 50 });
    loop.defineObjective('test', [], [
      { name: 'm', direction: 'maximize', target: 1, weight: 1 },
    ]);
    const start = Date.now();
    await loop.start(async () => ({ metrics: { m: 0.5 } }));
    await loop._loopPromise;
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, 'Should take at least ~50ms for interval');
    loop.shutdown();
  });
});

describe('metrics collection and composite score', () => {
  it('should compute composite score from weighted metrics', async () => {
    const loop = new OptimizationLoop({ maxIterations: 1 });
    loop.defineObjective('test', [], [
      { name: 'loss', direction: 'minimize', target: 0.01, weight: 0.6 },
      { name: 'acc', direction: 'maximize', target: 1.0, weight: 0.4 },
    ]);
    await loop.start(async () => ({
      metrics: { loss: 0.05, acc: 0.9 },
    }));
    await loop._loopPromise;
    const progress = loop.getProgress();
    assert.strictEqual(progress.currentIteration, 1);
    assert.ok(typeof progress.lastScore === 'number');
    assert.ok(progress.lastScore >= 0 && progress.lastScore <= 1);
    loop.shutdown();
  });

  it('should handle missing metrics gracefully', async () => {
    const loop = new OptimizationLoop({ maxIterations: 1 });
    loop.defineObjective('test', [], [
      { name: 'm1', direction: 'maximize', target: 1, weight: 1 },
    ]);
    await loop.start(async () => ({}));
    await loop._loopPromise;
    assert.strictEqual(loop._currentIteration, 1);
    loop.shutdown();
  });
});

describe('convergence detection', () => {
  it('should detect convergence when threshold met', async () => {
    const loop = new OptimizationLoop({ maxIterations: 100, convergenceThreshold: 0.5 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    let converged = false;
    loop.on('convergence-detected', () => { converged = true; });
    await loop.start(async () => ({
      metrics: { score: 0.9 },
    }));
    await loop._loopPromise;
    assert.strictEqual(loop._status, 'converged');
    assert.strictEqual(converged, true);
    loop.shutdown();
  });
});

describe('stagnation detection', () => {
  it('should detect stagnation after stagnationWindow', async () => {
    const loop = new OptimizationLoop({ maxIterations: 10, stagnationWindow: 3, convergenceThreshold: 1.0 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    loop.attachConvergenceDetector({ check: () => ({ converged: false, reason: 'disabled' }) });
    let stagnationDetected = false;
    loop.on('stagnation-detected', () => { stagnationDetected = true; });
    await loop.start(async () => ({
      metrics: { score: 0.3 },
    }));
    await loop._loopPromise;
    assert.strictEqual(stagnationDetected, true);
    loop.shutdown();
  });
});

describe('strategy auto-switching', () => {
  it('should emit strategy-suggestion on plateau', async () => {
    const loop = new OptimizationLoop({ maxIterations: 10, convergenceThreshold: 1.0 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    let suggestionEmitted = false;
    loop.on('strategy-suggestion', () => { suggestionEmitted = true; });
    await loop.start(async () => {
      return { metrics: { score: 0.5 } };
    });
    await loop._loopPromise;
    assert.strictEqual(suggestionEmitted, true);
    loop.shutdown();
  });
});

describe('auto-rollback on degrading', () => {
  it('should emit auto-rollback when quality degrades significantly', async () => {
    const loop = new OptimizationLoop({ maxIterations: 10, convergenceThreshold: 1.0 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    loop.attachConvergenceDetector({ check: () => ({ converged: false, reason: 'disabled' }) });
    let rollbackEmitted = false;
    loop.on('auto-rollback', () => { rollbackEmitted = true; });
    let iter = 0;
    await loop.start(async () => {
      iter++;
      if (iter <= 2) return { metrics: { score: 0.9 } };
      return { metrics: { score: 0.1 } };
    });
    await loop._loopPromise;
    assert.strictEqual(rollbackEmitted, true);
    loop.shutdown();
  });
});

describe('MD journal', () => {
  it('should create and update journal file', async () => {
    const journalPath = path.join(TEST_DIR, 'journal-test.md');
    const loop = new OptimizationLoop({ maxIterations: 2, journalPath });
    loop.defineObjective('test objective', ['constraint1'], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    await loop.start(async () => ({
      metrics: { score: 0.7 },
      summary: 'improved model',
    }));
    await loop._loopPromise;
    const journal = loop.getJournal();
    assert.ok(journal.includes('Optimization Journal'));
    assert.ok(journal.includes('test objective'));
    assert.ok(journal.includes('Iteration 1'));
    assert.ok(journal.includes('Iteration 2'));
    loop.shutdown();
  });

  it('should return empty string for non-existent journal', () => {
    const loop = new OptimizationLoop({ journalPath: path.join(TEST_DIR, 'nonexistent.md') });
    const journal = loop.getJournal();
    assert.strictEqual(journal, '');
    loop.shutdown();
  });
});

describe('snapshot and rollback', () => {
  it('should save snapshots and allow rollback', async () => {
    const loop = new OptimizationLoop({ maxIterations: 3 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    await loop.start(async () => ({ metrics: { score: 0.5 } }));
    await loop._loopPromise;
    const result = loop.rollbackTo(2);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.iteration, 2);
    loop.shutdown();
  });

  it('should reject rollback to non-existent iteration', () => {
    const loop = new OptimizationLoop();
    const result = loop.rollbackTo(999);
    assert.strictEqual(result.success, false);
    loop.shutdown();
  });

  it('should reject rollback with invalid iteration', () => {
    const loop = new OptimizationLoop();
    const result = loop.rollbackTo(-1);
    assert.strictEqual(result.success, false);
    loop.shutdown();
  });
});

describe('getProgress()', () => {
  it('should return progress info', async () => {
    const loop = new OptimizationLoop({ maxIterations: 2 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    await loop.start(async () => ({ metrics: { score: 0.5 } }));
    await loop._loopPromise;
    const progress = loop.getProgress();
    assert.strictEqual(progress.currentIteration, 2);
    assert.ok(progress.bestScore !== null);
    assert.strictEqual(progress.objective, 'test');
    assert.ok(typeof progress.elapsed === 'number');
    loop.shutdown();
  });
});

describe('pause/resume/stop lifecycle', () => {
  it('should pause and resume the loop', async () => {
    const loop = new OptimizationLoop({ maxIterations: 100, iterationIntervalMs: 50 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    await loop.start(async () => ({ metrics: { score: 0.5 } }));
    await new Promise(r => setTimeout(r, 80));
    const pauseResult = loop.pause();
    assert.strictEqual(pauseResult.success, true);
    assert.strictEqual(loop._status, 'paused');
    const resumeResult = loop.resume();
    assert.strictEqual(resumeResult.success, true);
    assert.strictEqual(loop._status, 'running');
    loop.stop();
    loop.shutdown();
  });

  it('should reject pause when not running', () => {
    const loop = new OptimizationLoop();
    const result = loop.pause();
    assert.strictEqual(result.success, false);
    loop.shutdown();
  });

  it('should reject resume when not paused', () => {
    const loop = new OptimizationLoop();
    const result = loop.resume();
    assert.strictEqual(result.success, false);
    loop.shutdown();
  });

  it('should stop the loop', async () => {
    const loop = new OptimizationLoop({ maxIterations: 100, iterationIntervalMs: 50 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    await loop.start(async () => ({ metrics: { score: 0.5 } }));
    await new Promise(r => setTimeout(r, 80));
    const stopResult = loop.stop();
    assert.strictEqual(stopResult.success, true);
    assert.strictEqual(loop._status, 'stopped');
    loop.shutdown();
  });

  it('should reject stop when not running or paused', () => {
    const loop = new OptimizationLoop();
    const result = loop.stop();
    assert.strictEqual(result.success, false);
    loop.shutdown();
  });
});

describe('event emission', () => {
  it('should emit iteration-complete events', async () => {
    const loop = new OptimizationLoop({ maxIterations: 2 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    const events = [];
    loop.on('iteration-complete', (data) => events.push(data));
    await loop.start(async () => ({ metrics: { score: 0.5 } }));
    await loop._loopPromise;
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].iteration, 1);
    assert.strictEqual(events[1].iteration, 2);
    loop.shutdown();
  });

  it('should emit iteration-start events', async () => {
    const loop = new OptimizationLoop({ maxIterations: 1 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    let started = false;
    loop.on('iteration-start', () => { started = true; });
    await loop.start(async () => ({ metrics: { score: 0.5 } }));
    await loop._loopPromise;
    assert.strictEqual(started, true);
    loop.shutdown();
  });

  it('should emit exhausted event', async () => {
    const loop = new OptimizationLoop({ maxIterations: 1 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    let exhausted = false;
    loop.on('exhausted', () => { exhausted = true; });
    await loop.start(async () => ({ metrics: { score: 0.1 } }));
    await loop._loopPromise;
    assert.strictEqual(exhausted, true);
    loop.shutdown();
  });
});

describe('shutdown cleanup', () => {
  it('should clean up on shutdown', async () => {
    const loop = new OptimizationLoop({ maxIterations: 2 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    await loop.start(async () => ({ metrics: { score: 0.5 } }));
    await loop._loopPromise;
    loop.shutdown();
    assert.strictEqual(loop._shutDown, true);
    assert.strictEqual(loop._snapshots.size, 0);
    assert.strictEqual(loop._metricsHistory.length, 0);
  });
});

describe('capacity limits', () => {
  it('should respect MAX_SNAPSHOTS limit', async () => {
    const loop = new OptimizationLoop({ maxIterations: 105 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    await loop.start(async () => ({ metrics: { score: 0.5 } }));
    await loop._loopPromise;
    assert.ok(loop._snapshots.size <= OptimizationLoop.MAX_SNAPSHOTS);
    loop.shutdown();
  });
});

describe('attachMetricsCollector()', () => {
  it('should attach a metrics collector', () => {
    const loop = new OptimizationLoop();
    const collector = {
      record: () => {},
      recordIteration: () => {},
    };
    const result = loop.attachMetricsCollector(collector);
    assert.strictEqual(result, loop);
    assert.strictEqual(loop._metricsCollector, collector);
    loop.shutdown();
  });

  it('should ignore invalid collector', () => {
    const loop = new OptimizationLoop();
    loop.attachMetricsCollector(null);
    assert.strictEqual(loop._metricsCollector, null);
    loop.attachMetricsCollector({});
    assert.strictEqual(loop._metricsCollector, null);
    loop.shutdown();
  });
});

describe('attachConvergenceDetector()', () => {
  it('should attach a custom convergence detector', () => {
    const loop = new OptimizationLoop();
    const detector = { check: () => ({ converged: false, reason: 'custom' }) };
    const result = loop.attachConvergenceDetector(detector);
    assert.strictEqual(result, loop);
    assert.strictEqual(loop._convergenceDetector, detector);
    loop.shutdown();
  });

  it('should ignore invalid detector', () => {
    const loop = new OptimizationLoop();
    loop.attachConvergenceDetector(null);
    loop.attachConvergenceDetector({});
    loop.shutdown();
  });
});

describe('resource budget', () => {
  it('should stop when resource budget exhausted', async () => {
    const loop = new OptimizationLoop({ maxIterations: 100, resourceBudget: 10 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    let resourceExhausted = false;
    loop.on('resource-exhausted', () => { resourceExhausted = true; });
    await loop.start(async () => ({
      metrics: { score: 0.5 },
      resourceUsed: 5,
    }));
    await loop._loopPromise;
    assert.strictEqual(loop._status, 'exhausted');
    assert.strictEqual(resourceExhausted, true);
    loop.shutdown();
  });
});

describe('isHealthy() and getStats()', () => {
  it('should report healthy when not failed', () => {
    const loop = new OptimizationLoop();
    assert.strictEqual(loop.isHealthy(), true);
    loop.shutdown();
  });

  it('should report stats correctly', async () => {
    const loop = new OptimizationLoop({ maxIterations: 1 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    await loop.start(async () => ({ metrics: { score: 0.5 } }));
    await loop._loopPromise;
    const stats = loop.getStats();
    assert.strictEqual(stats.currentIteration, 1);
    assert.ok(stats.bestScore !== null);
    assert.strictEqual(stats.healthy, true);
    loop.shutdown();
  });
});

describe('static properties', () => {
  it('should expose LOOP_STATUS', () => {
    assert.ok(OptimizationLoop.LOOP_STATUS);
    assert.strictEqual(OptimizationLoop.LOOP_STATUS.IDLE, 'idle');
    assert.strictEqual(OptimizationLoop.LOOP_STATUS.RUNNING, 'running');
    assert.strictEqual(OptimizationLoop.LOOP_STATUS.PAUSED, 'paused');
    assert.strictEqual(OptimizationLoop.LOOP_STATUS.STOPPED, 'stopped');
    assert.strictEqual(OptimizationLoop.LOOP_STATUS.CONVERGED, 'converged');
    assert.strictEqual(OptimizationLoop.LOOP_STATUS.EXHAUSTED, 'exhausted');
  });

  it('should expose DEFAULT_CONFIG', () => {
    assert.ok(OptimizationLoop.DEFAULT_CONFIG);
    assert.strictEqual(OptimizationLoop.DEFAULT_CONFIG.convergenceThreshold, 0.85);
  });

  it('should expose MAX_SNAPSHOTS', () => {
    assert.strictEqual(OptimizationLoop.MAX_SNAPSHOTS, 100);
  });

  it('should expose BUILTIN_METRIC_TYPES', () => {
    assert.ok(OptimizationLoop.BUILTIN_METRIC_TYPES.has('loss'));
    assert.ok(OptimizationLoop.BUILTIN_METRIC_TYPES.has('roi'));
  });
});

describe('pause/resume with iterationIntervalMs=0', () => {
  it('should pause and resume when iterationIntervalMs is 0', async () => {
    const loop = new OptimizationLoop({ maxIterations: 100, convergenceThreshold: 1.0, iterationIntervalMs: 0 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    loop.attachConvergenceDetector({ check: () => ({ converged: false, reason: 'disabled' }) });
    let iterationCount = 0;
    await loop.start(async () => {
      iterationCount++;
      if (iterationCount === 2) {
        loop.pause();
      }
      if (iterationCount === 4) {
        loop.stop();
      }
      return { metrics: { score: 0.5 } };
    });
    await loop._loopPromise;
    assert.strictEqual(loop._status, 'paused');
    assert.strictEqual(iterationCount, 2);
    const resumeResult = loop.resume();
    assert.strictEqual(resumeResult.success, true);
    assert.strictEqual(loop._status, 'running');
    await loop._loopPromise;
    assert.strictEqual(loop._status, 'stopped');
    assert.strictEqual(iterationCount, 4);
    loop.shutdown();
  });
});

describe('consecutive executeFn failures', () => {
  it('should stop after 5 consecutive failures', async () => {
    const loop = new OptimizationLoop({ maxIterations: Infinity, convergenceThreshold: 1.0 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    loop.attachConvergenceDetector({ check: () => ({ converged: false, reason: 'disabled' }) });
    let loopFailed = false;
    loop.on('loop-failed', () => { loopFailed = true; });
    await loop.start(async () => {
      throw new Error('always fails');
    });
    await loop._loopPromise;
    assert.strictEqual(loop._status, 'failed');
    assert.strictEqual(loopFailed, true);
    assert.strictEqual(loop._consecutiveFailures, 5);
    loop.shutdown();
  });
});

describe('defineObjective while running', () => {
  it('should reject defineObjective when loop is running', async () => {
    const loop = new OptimizationLoop({ maxIterations: 100, iterationIntervalMs: 50 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    await loop.start(async () => ({ metrics: { score: 0.5 } }));
    await new Promise(r => setTimeout(r, 30));
    const result = loop.defineObjective('new objective', [], []);
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('running'));
    loop.stop();
    loop.shutdown();
  });
});

describe('stop then start behavior', () => {
  it('should allow restart after stop', async () => {
    const loop = new OptimizationLoop({ maxIterations: 100, convergenceThreshold: 1.0, iterationIntervalMs: 0 });
    loop.defineObjective('test', [], [
      { name: 'score', direction: 'maximize', target: 1, weight: 1 },
    ]);
    loop.attachConvergenceDetector({ check: () => ({ converged: false, reason: 'disabled' }) });
    let iterationCount = 0;
    await loop.start(async () => {
      iterationCount++;
      if (iterationCount === 2) {
        loop.stop();
      }
      return { metrics: { score: 0.5 } };
    });
    await loop._loopPromise;
    assert.strictEqual(loop._status, 'stopped');
    assert.strictEqual(iterationCount, 2);
    const restartResult = await loop.start(async () => {
      iterationCount++;
      if (iterationCount >= 5) {
        loop.stop();
      }
      return { metrics: { score: 0.6 } };
    });
    assert.strictEqual(restartResult.success, true);
    await loop._loopPromise;
    assert.strictEqual(loop._status, 'stopped');
    assert.strictEqual(iterationCount, 5);
    loop.shutdown();
  });
});
