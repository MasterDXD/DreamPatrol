'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('SprintCycle - construction and config', () => {
  const { SprintCycle, SPRINT_PHASES, SPRINT_STATES } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'sprint-cycle'));

  it('should expose PHASES and STATES constants', () => {
    assert.strictEqual(SPRINT_PHASES.CODE, 'code');
    assert.strictEqual(SPRINT_PHASES.TEST, 'test');
    assert.strictEqual(SPRINT_PHASES.REVIEW, 'review');
    assert.strictEqual(SPRINT_PHASES.INTEGRATE, 'integrate');
    assert.strictEqual(SPRINT_STATES.IDLE, 'idle');
    assert.strictEqual(SPRINT_STATES.RUNNING, 'running');
    assert.strictEqual(SPRINT_STATES.PAUSED, 'paused');
    assert.strictEqual(SPRINT_STATES.COMPLETED, 'completed');
    assert.strictEqual(SPRINT_STATES.FAILED, 'failed');
  });

  it('should construct with default config', () => {
    const sc = new SprintCycle();
    assert.strictEqual(sc.state, SPRINT_STATES.IDLE);
    assert.strictEqual(sc.currentSprint, 0);
    assert.strictEqual(sc.currentPhase, SPRINT_PHASES.CODE);
    sc.shutdown();
  });

  it('should merge custom config', () => {
    const sc = new SprintCycle({ maxSprints: 3, qualityThreshold: 0.9 });
    const stats = sc.getStats();
    assert.strictEqual(stats.maxSprints, 3);
    assert.strictEqual(stats.qualityThreshold, 0.9);
    sc.shutdown();
  });

  it('should return stats from getStats', () => {
    const sc = new SprintCycle({ maxSprints: 5, qualityThreshold: 0.8 });
    const stats = sc.getStats();
    assert.strictEqual(stats.state, SPRINT_STATES.IDLE);
    assert.strictEqual(stats.currentSprint, 0);
    assert.strictEqual(stats.maxSprints, 5);
    assert.strictEqual(stats.qualityThreshold, 0.8);
    assert.strictEqual(stats.historyLength, 0);
    sc.shutdown();
  });
});

describe('SprintCycle - run lifecycle', () => {
  const { SprintCycle, SPRINT_PHASES, SPRINT_STATES } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'sprint-cycle'));

  it('should run a single sprint and complete when quality meets threshold', async () => {
    const sc = new SprintCycle({ maxSprints: 5, qualityThreshold: 0.8, autoAdvance: true });
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.9 };
      if (phase === SPRINT_PHASES.TEST) return { failed: false, passRate: 1.0 };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false, score: 0.9 };
      return {};
    };
    const result = await sc.run(fn, {});
    assert.strictEqual(result.completed, true);
    assert.strictEqual(result.sprints, 1);
    assert.strictEqual(typeof result.quality, 'number');
    sc.shutdown();
  });

  it('should run multiple sprints until quality threshold is met', async () => {
    let callCount = 0;
    const sc = new SprintCycle({ maxSprints: 5, qualityThreshold: 0.8, autoAdvance: true });
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) {
        callCount++;
        return { quality: callCount >= 3 ? 0.9 : 0.3 };
      }
      if (phase === SPRINT_PHASES.TEST) return { failed: false, passRate: 1.0 };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false, score: 0.9 };
      return {};
    };
    const result = await sc.run(fn);
    assert.strictEqual(result.completed, true);
    assert.strictEqual(result.sprints, 3);
    sc.shutdown();
  });

  it('should fail fast on test failure when failFastOnTest is true', async () => {
    const sc = new SprintCycle({ maxSprints: 5, failFastOnTest: true, autoAdvance: true });
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.TEST) return { failed: true, passRate: 0.2 };
      return {};
    };
    const result = await sc.run(fn);
    assert.strictEqual(result.completed, false);
    assert.strictEqual(result.reason, 'sprint-failed');
    sc.shutdown();
  });

  it('should fail fast on review rejection when requireReviewPass is true', async () => {
    const sc = new SprintCycle({ maxSprints: 5, requireReviewPass: true, autoAdvance: true });
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.TEST) return { failed: false, passRate: 1.0 };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: true, score: 0.3 };
      return {};
    };
    const result = await sc.run(fn);
    assert.strictEqual(result.completed, false);
    assert.strictEqual(result.reason, 'sprint-failed');
    sc.shutdown();
  });

  it('should reach max sprints without meeting quality threshold', async () => {
    const sc = new SprintCycle({ maxSprints: 2, qualityThreshold: 0.99, autoAdvance: true });
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.1 };
      if (phase === SPRINT_PHASES.TEST) return { failed: false, passRate: 0.5 };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false, score: 0.5 };
      return {};
    };
    const result = await sc.run(fn);
    assert.strictEqual(result.completed, false);
    assert.strictEqual(result.reason, 'max-sprints-reached');
    sc.shutdown();
  });

  it('should pause when autoAdvance is false', async () => {
    const sc = new SprintCycle({ maxSprints: 5, autoAdvance: false, qualityThreshold: 0.99 });
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.5 };
      if (phase === SPRINT_PHASES.TEST) return { failed: false, passRate: 1.0 };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false, score: 0.5 };
      return {};
    };
    const result = await sc.run(fn);
    assert.strictEqual(result.completed, false);
    assert.strictEqual(result.reason, 'manual-pause');
    sc.shutdown();
  });

  it('should throw when running while already running', async () => {
    const sc = new SprintCycle({ maxSprints: 5 });
    sc._state = SPRINT_STATES.RUNNING;
    await assert.rejects(() => sc.run(async () => {}), { code: 'SPRINT_ALREADY_RUNNING' });
    sc.shutdown();
  });
});

describe('SprintCycle - abort, pause, resume', () => {
  const { SprintCycle, SPRINT_STATES } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'sprint-cycle'));

  it('should set aborted flag and state on abort', () => {
    const sc = new SprintCycle({ maxSprints: 5 });
    sc._state = SPRINT_STATES.RUNNING;
    sc.abort();
    assert.strictEqual(sc._aborted, true);
    assert.strictEqual(sc.state, SPRINT_STATES.FAILED);
    sc.shutdown();
  });

  it('should pause and resume state', () => {
    const sc = new SprintCycle({ maxSprints: 5, autoAdvance: true, qualityThreshold: 0.99 });
    sc._state = SPRINT_STATES.RUNNING;
    sc.pause();
    assert.strictEqual(sc.state, SPRINT_STATES.PAUSED);
    sc.resume();
    assert.strictEqual(sc.state, SPRINT_STATES.RUNNING);
    sc.shutdown();
  });
});

describe('SprintCycle - events', () => {
  const { SprintCycle, SPRINT_PHASES, SPRINT_STATES } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'sprint-cycle'));

  it('should emit sprint-start and sprint-end events', async () => {
    const sc = new SprintCycle({ maxSprints: 1, qualityThreshold: 0.5, autoAdvance: true });
    const events = [];
    sc.on('sprint-start', (d) => events.push({ type: 'sprint-start', sprint: d.sprint }));
    sc.on('sprint-end', (d) => events.push({ type: 'sprint-end', sprint: d.sprint }));
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.9 };
      if (phase === SPRINT_PHASES.TEST) return { failed: false, passRate: 1.0 };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false, score: 0.9 };
      return {};
    };
    await sc.run(fn);
    assert.strictEqual(events[0].type, 'sprint-start');
    assert.strictEqual(events[0].sprint, 1);
    assert.strictEqual(events[1].type, 'sprint-end');
    assert.strictEqual(events[1].sprint, 1);
    sc.shutdown();
  });

  it('should emit phase-start and phase-end events', async () => {
    const sc = new SprintCycle({ maxSprints: 1, qualityThreshold: 0.5, autoAdvance: true });
    const phases = [];
    sc.on('phase-start', (d) => phases.push(d.phase));
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.9 };
      if (phase === SPRINT_PHASES.TEST) return { failed: false, passRate: 1.0 };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false, score: 0.9 };
      return {};
    };
    await sc.run(fn);
    assert.ok(phases.includes('code'));
    assert.ok(phases.includes('test'));
    assert.ok(phases.includes('review'));
    assert.ok(phases.includes('integrate'));
    sc.shutdown();
  });

  it('should emit phase-error on phase execution error', async () => {
    const sc = new SprintCycle({ maxSprints: 1, autoAdvance: true, failFastOnTest: true });
    let errorEmitted = false;
    sc.on('phase-error', () => { errorEmitted = true; });
    const fn = async () => { throw new Error('phase boom'); };
    const result = await sc.run(fn);
    assert.strictEqual(errorEmitted, true);
    assert.strictEqual(result.completed, false);
    sc.shutdown();
  });

  it('should emit cycle-completed event', async () => {
    const sc = new SprintCycle({ maxSprints: 1, qualityThreshold: 0.5, autoAdvance: true });
    let completed = false;
    sc.on('cycle-completed', () => { completed = true; });
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.9 };
      if (phase === SPRINT_PHASES.TEST) return { failed: false, passRate: 1.0 };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false, score: 0.9 };
      return {};
    };
    await sc.run(fn);
    assert.strictEqual(completed, true);
    sc.shutdown();
  });

  it('should emit cycle-aborted event on abort', () => {
    const sc = new SprintCycle({ maxSprints: 5 });
    let aborted = false;
    sc.on('cycle-aborted', () => { aborted = true; });
    sc._state = SPRINT_STATES.RUNNING;
    sc.abort();
    assert.strictEqual(aborted, true);
    sc.shutdown();
  });
});

describe('SprintCycle - history and edge cases', () => {
  const { SprintCycle, SPRINT_PHASES } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'sprint-cycle'));

  it('should return history from getHistory', async () => {
    const sc = new SprintCycle({ maxSprints: 2, qualityThreshold: 0.5, autoAdvance: true });
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.9 };
      if (phase === SPRINT_PHASES.TEST) return { failed: false, passRate: 1.0 };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false, score: 0.9 };
      return {};
    };
    await sc.run(fn);
    const history = sc.getHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].sprint, 1);
    sc.shutdown();
  });

  it('should handle phase error with non-Error object', async () => {
    const sc = new SprintCycle({ maxSprints: 1, autoAdvance: true, failFastOnTest: true });
    let errorMsg = '';
    sc.on('phase-error', (d) => { errorMsg = d.error; });
    const err = new Error('string error');
    err.name = 'StringError';
    const fn = async () => { throw err; };
    await sc.run(fn);
    assert.ok(errorMsg.includes('string error'));
    sc.shutdown();
  });

  it('should trim sprint history when exceeding 50 entries', async () => {
    const sc = new SprintCycle({ maxSprints: 1, qualityThreshold: 0.5, autoAdvance: true });
    for (let i = 0; i < 55; i++) {
      sc._sprintHistory.push({ sprint: i + 1, timestamp: Date.now() });
    }
    assert.strictEqual(sc._sprintHistory.length, 55);
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.9 };
      if (phase === SPRINT_PHASES.TEST) return { failed: false, passRate: 1.0 };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false, score: 0.9 };
      return {};
    };
    await sc.run(fn);
    assert.strictEqual(sc._sprintHistory.length, 25);
    sc.shutdown();
  });

  it('should shutdown cleanly', async () => {
    const sc = new SprintCycle({ maxSprints: 1, qualityThreshold: 0.5, autoAdvance: true });
    const fn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.9 };
      if (phase === SPRINT_PHASES.TEST) return { failed: false, passRate: 1.0 };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false, score: 0.9 };
      return {};
    };
    await sc.run(fn);
    sc.shutdown();
    assert.strictEqual(sc._sprintHistory.length, 0);
    assert.strictEqual(sc._phaseResults.size, 0);
  });
});
