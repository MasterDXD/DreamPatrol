'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AgentDebugLoop, LOOP_STATES } = require('../../../src/runtime/agent/agent-debug-loop');

describe('AgentDebugLoop', () => {
  it('should start in IDLE state', () => {
    const loop = new AgentDebugLoop();
    assert.equal(loop.state, LOOP_STATES.IDLE);
  });

  it('should complete immediately if tests pass', async () => {
    const loop = new AgentDebugLoop({
      testRunner: async () => ({ passed: true }),
    });
    const result = await loop.execute({ name: 'test-task' });
    assert.equal(result.success, true);
    assert.equal(result.iterations, 1);
    assert.equal(loop.state, LOOP_STATES.COMPLETED);
  });

  it('should iterate when tests fail then pass', async () => {
    let callCount = 0;
    const loop = new AgentDebugLoop({
      testRunner: async () => {
        callCount++;
        return { passed: callCount >= 2 };
      },
      codeFixer: async () => ({ applied: true }),
      analyzer: async () => ({ rootCause: 'bug', suggestions: ['fix it'] }),
    });
    const result = await loop.execute({ name: 'test-task' });
    assert.equal(result.success, true);
    assert.equal(result.iterations, 2);
  });

  it('should fail after max iterations', async () => {
    const loop = new AgentDebugLoop({
      maxIterations: 2,
      testRunner: async () => ({ passed: false, error: 'always fails' }),
      codeFixer: async () => ({ applied: true }),
      analyzer: async () => ({ rootCause: 'unknown' }),
    });
    const result = await loop.execute({ name: 'test-task' });
    assert.equal(result.success, false);
    assert.equal(result.reason, 'max_iterations_reached');
  });

  it('should fail if fix is not applied', async () => {
    const loop = new AgentDebugLoop({
      testRunner: async () => ({ passed: false, error: 'fail' }),
      codeFixer: async () => ({ applied: false }),
      analyzer: async () => ({ rootCause: 'unknown' }),
    });
    const result = await loop.execute({ name: 'test-task' });
    assert.equal(result.success, false);
    assert.equal(result.reason, 'fix_not_applied');
  });

  it('should emit events during execution', async () => {
    const loop = new AgentDebugLoop({
      testRunner: async () => ({ passed: true }),
    });
    const events = [];
    loop.on('loop:start', (_e) => events.push('start'));
    loop.on('loop:complete', (_e) => events.push('complete'));
    await loop.execute({ name: 'test' });
    assert.ok(events.includes('start'));
    assert.ok(events.includes('complete'));
  });

  it('should handle test runner errors', async () => {
    const loop = new AgentDebugLoop({
      testRunner: async () => { throw new Error('runner crashed'); },
      codeFixer: async () => ({ applied: true }),
      analyzer: async () => ({ rootCause: 'unknown' }),
    });
    const result = await loop.execute({ name: 'test' });
    assert.equal(result.success, false);
  });

  it('should reset state', async () => {
    const loop = new AgentDebugLoop({
      testRunner: async () => ({ passed: true }),
    });
    await loop.execute({ name: 'test' });
    loop.reset();
    assert.equal(loop.state, LOOP_STATES.IDLE);
    assert.equal(loop.iteration, 0);
    assert.equal(loop.history.length, 0);
  });

  it('should return stats', () => {
    const loop = new AgentDebugLoop({ maxIterations: 3 });
    const stats = loop.getStats();
    assert.equal(stats.state, LOOP_STATES.IDLE);
    assert.equal(stats.maxIterations, 3);
  });

  it('should work without test runner', async () => {
    const loop = new AgentDebugLoop();
    const result = await loop.execute({ name: 'test' });
    assert.equal(result.success, true);
  });

  it('should run regression tests after fix when regressionRunner is provided', async () => {
    let regressionCalled = false;
    let callCount = 0;
    const loop = new AgentDebugLoop({
      testRunner: async () => {
        callCount++;
        return { passed: callCount >= 2 };
      },
      codeFixer: async () => ({ applied: true }),
      analyzer: async () => ({ rootCause: 'bug', suggestions: ['fix it'] }),
      regressionRunner: async () => {
        regressionCalled = true;
        return { passed: true };
      },
    });
    const result = await loop.execute({ name: 'test-task' });
    assert.equal(result.success, true);
    assert.equal(regressionCalled, true);
  });

  it('should fail loop when regression tests fail', async () => {
    let callCount = 0;
    const loop = new AgentDebugLoop({
      testRunner: async () => {
        callCount++;
        return { passed: callCount >= 2 };
      },
      codeFixer: async () => ({ applied: true }),
      analyzer: async () => ({ rootCause: 'bug', suggestions: ['fix it'] }),
      regressionRunner: async () => ({
        passed: false,
        failures: ['old_test_broken'],
      }),
    });
    const result = await loop.execute({ name: 'test-task' });
    assert.equal(result.success, false);
    assert.equal(result.reason, 'regression_failed');
    assert.deepEqual(result.regressionFailures, ['old_test_broken']);
    assert.equal(loop.state, LOOP_STATES.FAILED);
  });

  it('should skip regression when no regressionRunner', async () => {
    let callCount = 0;
    const loop = new AgentDebugLoop({
      testRunner: async () => {
        callCount++;
        return { passed: callCount >= 2 };
      },
      codeFixer: async () => ({ applied: true }),
      analyzer: async () => ({ rootCause: 'bug', suggestions: ['fix it'] }),
    });
    const result = await loop.execute({ name: 'test-task' });
    assert.equal(result.success, true);
    const regressionPhases = result.history.filter((h) => h.phase === 'regression');
    assert.equal(regressionPhases.length, 0);
  });

  it('should include regression in stats', () => {
    const loopWithRunner = new AgentDebugLoop({
      regressionRunner: async () => ({ passed: true }),
    });
    const loopWithoutRunner = new AgentDebugLoop();
    assert.equal(loopWithRunner.getStats().hasRegressionRunner, true);
    assert.equal(loopWithoutRunner.getStats().hasRegressionRunner, false);
  });

  it('should clean up regressionRunner on shutdown', async () => {
    const loop = new AgentDebugLoop({
      testRunner: async () => ({ passed: true }),
      regressionRunner: async () => ({ passed: true }),
    });
    assert.equal(loop.getStats().hasRegressionRunner, true);
    await loop.shutdown();
    assert.equal(loop.getStats().hasRegressionRunner, false);
  });
});
