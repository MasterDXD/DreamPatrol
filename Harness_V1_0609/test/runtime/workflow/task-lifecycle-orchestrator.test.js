'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const TaskLifecycleOrchestrator = require('../../../src/runtime/workflow/task-lifecycle-orchestrator');

describe('TaskLifecycleOrchestrator', () => {
  it('should use default options', () => {
    const tlo = new TaskLifecycleOrchestrator();
    const status = tlo.getStatus();
    assert.equal(status.phase, 'idle');
    assert.equal(status.maxRounds, 10);
    assert.equal(status.evaluationThreshold, 0.7);
  });

  it('should accept custom options', () => {
    const tlo = new TaskLifecycleOrchestrator({ maxRounds: 5, evaluationThreshold: 0.8 });
    const status = tlo.getStatus();
    assert.equal(status.maxRounds, 5);
    assert.equal(status.evaluationThreshold, 0.8);
  });

  it('should support dependency injection', () => {
    const tlo = new TaskLifecycleOrchestrator();
    const mock = { foo: 'bar' };
    const result = tlo.attachGoalExecutor(mock);
    assert.equal(result, tlo); // returns this
  });

  it('should execute with degraded planner (no SddContractManager)', async () => {
    const tlo = new TaskLifecycleOrchestrator({ maxRounds: 1 });
    // No dependencies attached — all layers degrade gracefully
    const result = await tlo.execute('build a feature');
    // With no evaluator, score defaults to 0.5 which is below threshold 0.7
    // So it should fail with max_rounds_exceeded
    assert.equal(result.success, false);
    assert.equal(result.reason, 'max_rounds_exceeded');
  });

  it('should return evaluation history', async () => {
    const tlo = new TaskLifecycleOrchestrator({ maxRounds: 2 });
    await tlo.execute('test task');
    const history = tlo.getEvaluationHistory();
    assert.ok(Array.isArray(history));
    assert.ok(history.length > 0);
  });

  it('should return status', () => {
    const tlo = new TaskLifecycleOrchestrator();
    const status = tlo.getStatus();
    assert.ok('phase' in status);
    assert.ok('currentRound' in status);
    assert.ok('maxRounds' in status);
    assert.ok('contextMode' in status);
  });

  it('should shutdown cleanly', () => {
    const tlo = new TaskLifecycleOrchestrator();
    tlo.shutdown();
    assert.equal(tlo.isHealthy(), false);
  });

  it('should reject method calls after shutdown', () => {
    const tlo = new TaskLifecycleOrchestrator();
    tlo.shutdown();
    assert.throws(() => {
      tlo.getStatus();
    });
  });
});
