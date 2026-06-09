'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('RalphWiggumLoop - constructor', () => {
  const RalphWiggumLoop = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'ralph-wiggum-loop'));

  it('should construct with default config', () => {
    const loop = new RalphWiggumLoop();
    assert.strictEqual(loop._config.maxIterations, 10);
    assert.strictEqual(loop._config.maxDepth, 5);
    assert.strictEqual(loop._config.reviewRounds, 2);
    assert.strictEqual(loop._config.convergeThreshold, 0.85);
    assert.strictEqual(loop._config.autoFix, true);
    assert.strictEqual(loop._config.autoLearn, true);
    assert.strictEqual(loop._config.gapAnalysisOnFailure, true);
    assert.strictEqual(loop._state, 'idle');
    assert.ok(loop.isHealthy());
    loop.shutdown();
  });

  it('should construct with custom options', () => {
    const loop = new RalphWiggumLoop({
      maxIterations: 5,
      maxDepth: 3,
      reviewRounds: 1,
      autoFix: false,
      autoLearn: false,
      gapAnalysisOnFailure: false,
    });
    assert.strictEqual(loop._config.maxIterations, 5);
    assert.strictEqual(loop._config.maxDepth, 3);
    assert.strictEqual(loop._config.reviewRounds, 1);
    assert.strictEqual(loop._config.autoFix, false);
    assert.strictEqual(loop._config.autoLearn, false);
    assert.strictEqual(loop._config.gapAnalysisOnFailure, false);
    loop.shutdown();
  });

  it('should be healthy after construction', () => {
    const loop = new RalphWiggumLoop();
    assert.ok(loop.isHealthy());
    loop.shutdown();
  });

  it('should not be healthy after shutdown', () => {
    const loop = new RalphWiggumLoop();
    loop.shutdown();
    assert.strictEqual(loop.isHealthy(), false);
  });
});

describe('RalphWiggumLoop - dependency injection', () => {
  const RalphWiggumLoop = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'ralph-wiggum-loop'));

  it('should attach meta skill orchestrator', () => {
    const loop = new RalphWiggumLoop();
    const mockOrchestrator = { executeMetaSkill: async () => ({ success: true }) };
    const result = loop.attachMetaSkillOrchestrator(mockOrchestrator);
    assert.strictEqual(result, loop);
    assert.strictEqual(loop._metaSkillOrchestrator, mockOrchestrator);
    loop.shutdown();
  });

  it('should attach skill executor', () => {
    const loop = new RalphWiggumLoop();
    const mockExecutor = async () => 'result';
    const result = loop.attachSkillExecutor(mockExecutor);
    assert.strictEqual(result, loop);
    assert.strictEqual(loop._skillExecutor, mockExecutor);
    loop.shutdown();
  });

  it('should reject non-function skill executor', () => {
    const loop = new RalphWiggumLoop();
    assert.throws(() => loop.attachSkillExecutor('not a function'), TypeError);
    loop.shutdown();
  });

  it('should attach optimization loop', () => {
    const loop = new RalphWiggumLoop();
    const mockOptLoop = { defineObjective: () => {}, start: () => {} };
    const result = loop.attachOptimizationLoop(mockOptLoop);
    assert.strictEqual(result, loop);
    assert.strictEqual(loop._optimizationLoop, mockOptLoop);
    loop.shutdown();
  });

  it('should attach adversarial review', () => {
    const loop = new RalphWiggumLoop();
    const mockReview = { review: async () => ({ consensus: true }) };
    const result = loop.attachAdversarialReview(mockReview);
    assert.strictEqual(result, loop);
    assert.strictEqual(loop._adversarialReview, mockReview);
    loop.shutdown();
  });

  it('should attach auto rein learning loop', () => {
    const loop = new RalphWiggumLoop();
    const mockLearningLoop = { processTaskResult: async () => {} };
    const result = loop.attachAutoReinLearningLoop(mockLearningLoop);
    assert.strictEqual(result, loop);
    assert.strictEqual(loop._autoReinLearningLoop, mockLearningLoop);
    loop.shutdown();
  });

  it('should attach state graph', () => {
    const loop = new RalphWiggumLoop();
    const mockGraph = { addNode: () => {}, invoke: async () => ({}) };
    const result = loop.attachStateGraph(mockGraph);
    assert.strictEqual(result, loop);
    assert.strictEqual(loop._stateGraph, mockGraph);
    loop.shutdown();
  });

  it('should attach test runner', () => {
    const loop = new RalphWiggumLoop();
    const mockRunner = async () => ({ success: true, output: '' });
    const result = loop.attachTestRunner(mockRunner);
    assert.strictEqual(result, loop);
    assert.strictEqual(loop._testRunner, mockRunner);
    loop.shutdown();
  });

  it('should reject non-function test runner', () => {
    const loop = new RalphWiggumLoop();
    assert.throws(() => loop.attachTestRunner(123), TypeError);
    loop.shutdown();
  });
});

describe('RalphWiggumLoop - run with skill executor', () => {
  const RalphWiggumLoop = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'ralph-wiggum-loop'));

  it('should run successfully with skill executor', async () => {
    const loop = new RalphWiggumLoop({ maxIterations: 3, autoLearn: false, gapAnalysisOnFailure: false });
    loop.attachSkillExecutor(async (skillId, ctx) => {
      return JSON.stringify({ skillId, module: ctx.module, success: true });
    });
    loop.attachTestRunner(async (_cmd, _ctx) => {
      return { success: true, failures: [], output: 'All tests passed' };
    });

    const result = await loop.run('build a REST API with auth and database', {
      projectRoot: '/test',
    });

    assert.ok(result.success);
    assert.ok(result.summary.length > 0);
    assert.ok(result.modules.completed.length > 0);
    assert.ok(result.iterations > 0);
    loop.shutdown();
  });

  it('should handle task decomposition for API tasks', async () => {
    const loop = new RalphWiggumLoop({ maxIterations: 3, autoLearn: false, gapAnalysisOnFailure: false });
    loop.attachSkillExecutor(async (skillId, ctx) => {
      return JSON.stringify({ skillId, module: ctx.module, success: true });
    });
    loop.attachTestRunner(async () => ({ success: true, failures: [], output: '' }));

    const result = await loop.run('build a REST API with authentication', {
      projectRoot: '/test',
    });

    assert.ok(result.success);
    const moduleNames = result.modules.completed.map(m => m.name);
    assert.ok(moduleNames.some(n => n.toLowerCase().includes('api') || n.toLowerCase().includes('auth')));
    loop.shutdown();
  });

  it('should handle task decomposition for bug-fix tasks', async () => {
    const loop = new RalphWiggumLoop({ maxIterations: 3, autoLearn: false, gapAnalysisOnFailure: false });
    loop.attachSkillExecutor(async (skillId, ctx) => {
      return JSON.stringify({ skillId, module: ctx.module, success: true });
    });
    loop.attachTestRunner(async () => ({ success: true, failures: [], output: '' }));

    const result = await loop.run('fix a critical bug in the login system', {
      projectRoot: '/test',
    });

    assert.ok(result.success);
    loop.shutdown();
  });

  it('should reject empty task description', async () => {
    const loop = new RalphWiggumLoop();
    const result = await loop.run('', {});
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    loop.shutdown();
  });

  it('should reject null task description', async () => {
    const loop = new RalphWiggumLoop();
    const result = await loop.run(null, {});
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    loop.shutdown();
  });
});

describe('RalphWiggumLoop - run with full dependency chain', () => {
  const RalphWiggumLoop = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'ralph-wiggum-loop'));

  it('should run with adversarial review', async () => {
    const loop = new RalphWiggumLoop({ maxIterations: 3, autoLearn: false, gapAnalysisOnFailure: false });
    loop.attachSkillExecutor(async (skillId, ctx) => {
      return JSON.stringify({ skillId, module: ctx.module, success: true });
    });
    loop.attachAdversarialReview({
      review: async (subject, reviewerA, reviewerB) => {
        const a = await reviewerA(subject, {});
        const b = await reviewerB(subject, {});
        return {
          consensus: a.approved && b.approved,
          finalFeedback: a.approved ? 'OK' : 'Issues found',
          details: [{ reviewerA: a, reviewerB: b }],
        };
      },
    });
    loop.attachTestRunner(async () => ({ success: true, failures: [], output: '' }));

    const result = await loop.run('build a simple feature', {
      projectRoot: '/test',
    });

    assert.ok(result.success);
    assert.ok(result.modules.completed.length > 0);
    loop.shutdown();
  });

  it('should run with learning loop', async () => {
    const learningResults = [];
    const loop = new RalphWiggumLoop({ maxIterations: 3, autoLearn: true, gapAnalysisOnFailure: false });
    loop.attachSkillExecutor(async (skillId, ctx) => {
      return JSON.stringify({ skillId, module: ctx.module, success: true });
    });
    loop.attachAutoReinLearningLoop({
      processTaskResult: async (result) => {
        learningResults.push(result);
      },
    });
    loop.attachTestRunner(async () => ({ success: true, failures: [], output: '' }));

    const result = await loop.run('build a simple feature', {
      projectRoot: '/test',
    });

    assert.ok(result.success);
    assert.ok(learningResults.length > 0);
    loop.shutdown();
  });
});

describe('RalphWiggumLoop - failure handling', () => {
  const RalphWiggumLoop = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'ralph-wiggum-loop'));

  it('should handle skill executor failure', async () => {
    const loop = new RalphWiggumLoop({ maxIterations: 2, autoLearn: false, gapAnalysisOnFailure: false });
    loop.attachSkillExecutor(async () => null);

    const result = await loop.run('build a feature', {
      projectRoot: '/test',
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Too many consecutive failures'));
    loop.shutdown();
  });

  it('should handle test failure with autoFix', async () => {
    const loop = new RalphWiggumLoop({ maxIterations: 3, autoFix: true, autoLearn: false, gapAnalysisOnFailure: false });
    let fixCallCount = 0;
    loop.attachSkillExecutor(async (skillId, ctx) => {
      if (skillId === 'bug-fix') {
        fixCallCount++;
        return JSON.stringify({ fixed: true, iteration: fixCallCount });
      }
      return JSON.stringify({ skillId, module: ctx.module });
    });
    loop.attachTestRunner(async () => ({
      success: false,
      failures: ['Test 1 failed: expected true got false'],
      output: '1 failing',
    }));

    const result = await loop.run('build a feature', {
      projectRoot: '/test',
    });

    assert.strictEqual(result.success, false);
    assert.ok(fixCallCount > 0, 'Fix should have been called');
    loop.shutdown();
  });

  it('should handle gap analysis on failure', async () => {
    const loop = new RalphWiggumLoop({ maxIterations: 2, autoLearn: false, gapAnalysisOnFailure: true, haltOnCriticalGap: false });
    loop.attachSkillExecutor(async () => null);

    const result = await loop.run('build a full-stack web application', {
      projectRoot: '/test',
      availableSkills: [],
      environment: { hasCI: true, hasLint: true, hasTests: true },
    });

    assert.strictEqual(result.success, false);
    const gaps = loop.getCapabilityGaps();
    assert.ok(gaps.length > 0, 'Gap analysis should have been performed');
    loop.shutdown();
  });

  it('should emit state-change events', async () => {
    const loop = new RalphWiggumLoop({ maxIterations: 3, autoLearn: false, gapAnalysisOnFailure: false });
    const stateChanges = [];
    loop.on('state-change', (data) => {
      stateChanges.push(data);
    });

    loop.attachSkillExecutor(async (skillId, ctx) => {
      return JSON.stringify({ skillId, module: ctx.module });
    });
    loop.attachTestRunner(async () => ({ success: true, failures: [], output: '' }));

    await loop.run('build a feature', { projectRoot: '/test' });

    assert.ok(stateChanges.length > 0);
    assert.strictEqual(stateChanges[stateChanges.length - 1].to, 'completed');
    loop.shutdown();
  });
});

describe('RalphWiggumLoop - progress and stats', () => {
  const RalphWiggumLoop = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'ralph-wiggum-loop'));

  it('should report progress', async () => {
    const loop = new RalphWiggumLoop({ maxIterations: 3, autoLearn: false, gapAnalysisOnFailure: false });
    loop.attachSkillExecutor(async (skillId, ctx) => {
      return JSON.stringify({ skillId, module: ctx.module });
    });
    loop.attachTestRunner(async () => ({ success: true, failures: [], output: '' }));

    const progressBefore = loop.getProgress();
    assert.strictEqual(progressBefore.state, 'idle');

    await loop.run('build a feature', { projectRoot: '/test' });

    const progressAfter = loop.getProgress();
    assert.strictEqual(progressAfter.state, 'completed');
    assert.strictEqual(progressAfter.completed, progressAfter.total);
    loop.shutdown();
  });

  it('should return stats', async () => {
    const loop = new RalphWiggumLoop({ maxIterations: 3, autoLearn: false, gapAnalysisOnFailure: false });
    loop.attachSkillExecutor(async (skillId, ctx) => {
      return JSON.stringify({ skillId, module: ctx.module });
    });
    loop.attachTestRunner(async () => ({ success: true, failures: [], output: '' }));

    await loop.run('build a feature', { projectRoot: '/test' });

    const stats = loop.getStats();
    assert.strictEqual(stats.totalRuns, 1);
    assert.strictEqual(stats.state, 'completed');
    assert.ok(stats.lastRun !== null);
    loop.shutdown();
  });
});

describe('RalphWiggumLoop - shutdown', () => {
  const RalphWiggumLoop = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'ralph-wiggum-loop'));

  it('should throw after shutdown', async () => {
    const loop = new RalphWiggumLoop();
    loop.shutdown();
    assert.throws(() => loop.guardShutdown());
    await assert.rejects(() => loop.run('test', {}));
  });

  it('should not throw on double shutdown', () => {
    const loop = new RalphWiggumLoop();
    loop.shutdown();
    assert.doesNotThrow(() => loop.shutdown());
  });
});
