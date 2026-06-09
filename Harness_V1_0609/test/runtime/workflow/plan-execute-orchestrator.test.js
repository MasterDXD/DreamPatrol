'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PlanExecuteOrchestrator,
  STEP_STATUS,
  PLAN_STATUS,
  ESCALATION_LEVELS,
} = require('../../../src/runtime/workflow/plan-execute-orchestrator');

// ─── 辅助函数 ────────────────────────────────────────────────────

// ─── 测试 ───────────────────────────────────────────────────────

describe('PlanExecuteOrchestrator', () => {

  it('should create instance with default config', () => {
    const peo = new PlanExecuteOrchestrator();
    assert.ok(peo);
    assert.strictEqual(peo.getStats().plansCreated, 0);
    peo.shutdown();
  });

  it('should execute a simple plan with string steps', async () => {
    const peo = new PlanExecuteOrchestrator();
    const executed = [];

    const result = await peo.execute('test objective', {
      planFn: async (_obj) => ['step1', 'step2', 'step3'],
      executeFn: async (step) => { executed.push(step.description); return 'ok'; },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.steps, 3);
    assert.deepStrictEqual(executed, ['step1', 'step2', 'step3']);
    peo.shutdown();
  });

  it('should execute a plan with object steps', async () => {
    const peo = new PlanExecuteOrchestrator();
    const result = await peo.execute('test', {
      planFn: async () => [
        { id: 's1', description: 'First step' },
        { id: 's2', description: 'Second step' },
      ],
      executeFn: async (_step) => 'done',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.steps, 2);
    peo.shutdown();
  });

  it('should return failure for empty plan', async () => {
    const peo = new PlanExecuteOrchestrator();
    const result = await peo.execute('test', {
      planFn: async () => [],
      executeFn: async () => 'ok',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'empty-plan');
    peo.shutdown();
  });

  it('should return failure when planning fails', async () => {
    const peo = new PlanExecuteOrchestrator();
    const result = await peo.execute('test', {
      planFn: async () => { throw new Error('planning error'); },
      executeFn: async () => 'ok',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'planning-failed');
    peo.shutdown();
  });

  it('should retry on step failure', async () => {
    const peo = new PlanExecuteOrchestrator({ maxStepRetries: 2 });
    let attempt = 0;

    const result = await peo.execute('test', {
      planFn: async () => ['step1'],
      executeFn: async (_step) => {
        attempt++;
        if (attempt < 3) throw new Error('fail attempt ' + attempt);
        return 'ok';
      },
    });

    assert.strictEqual(result.success, true);
    assert.ok(attempt >= 3, 'Should have retried');
    peo.shutdown();
  });

  it('should trigger replan when retries exhausted', async () => {
    const peo = new PlanExecuteOrchestrator({ maxStepRetries: 1, maxReplanCount: 1 });
    let replanCalled = false;
    const executed = [];

    const _result = await peo.execute('test', {
      planFn: async () => ['failing-step', 'step2'],
      executeFn: async (step) => {
        executed.push(step.description);
        if (step.description === 'failing-step') throw new Error('always fails');
        return 'ok';
      },
      replanFn: async (_obj, _failedStep, _reason, _ctx) => {
        replanCalled = true;
        return ['alternative-step'];
      },
    });

    assert.ok(replanCalled, 'replanFn should be called');
    assert.ok(executed.includes('alternative-step'), 'Alternative step should be executed');
    peo.shutdown();
  });

  it('should trigger decompose when replan fails', async () => {
    const peo = new PlanExecuteOrchestrator({ maxStepRetries: 0, maxReplanCount: 0, maxDecomposeDepth: 1 });
    let decomposeCalled = false;

    const _result = await peo.execute('test', {
      planFn: async () => ['failing-step'],
      executeFn: async (step) => {
        if (step.description === 'failing-step') throw new Error('fail');
        return 'ok';
      },
      decomposeFn: async (_obj, _ctx) => {
        decomposeCalled = true;
        return ['sub-step-1', 'sub-step-2'];
      },
    });

    assert.ok(decomposeCalled, 'decomposeFn should be called');
    peo.shutdown();
  });

  it('should fail when all escalation levels exhausted', async () => {
    const peo = new PlanExecuteOrchestrator({ maxStepRetries: 0, maxReplanCount: 0, maxDecomposeDepth: 0 });

    const result = await peo.execute('test', {
      planFn: async () => ['failing-step'],
      executeFn: async (_step) => { throw new Error('always fails'); },
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'escalation-exhausted');
    peo.shutdown();
  });

  it('should verify step results', async () => {
    const peo = new PlanExecuteOrchestrator();
    let verifyCalled = false;

    const result = await peo.execute('test', {
      planFn: async () => ['step1'],
      executeFn: async () => 'result',
      verifyFn: async (_step, _result, _ctx) => {
        verifyCalled = true;
        return { passed: true };
      },
    });

    assert.ok(verifyCalled, 'verifyFn should be called');
    assert.strictEqual(result.success, true);
    peo.shutdown();
  });

  it('should trigger replan on verification failure', async () => {
    const peo = new PlanExecuteOrchestrator({ maxStepRetries: 0, maxReplanCount: 1 });
    let replanCalled = false;

    const _result = await peo.execute('test', {
      planFn: async () => ['step1'],
      executeFn: async () => 'bad result',
      verifyFn: async () => ({ passed: false, reason: 'quality too low' }),
      replanFn: async () => {
        replanCalled = true;
        return ['improved-step'];
      },
    });

    assert.ok(replanCalled, 'replanFn should be called on verification failure');
    peo.shutdown();
  });
});

describe('PlanExecuteOrchestrator - events and stats', () => {

  it('should emit plan-started and plan-completed events', async () => {
    const peo = new PlanExecuteOrchestrator();
    const events = [];

    peo.on('plan-started', (_e) => events.push('plan-started'));
    peo.on('plan-created', (_e) => events.push('plan-created'));
    peo.on('plan-completed', (_e) => events.push('plan-completed'));

    await peo.execute('test', {
      planFn: async () => ['step1'],
      executeFn: async () => 'ok',
    });

    assert.ok(events.includes('plan-started'));
    assert.ok(events.includes('plan-created'));
    assert.ok(events.includes('plan-completed'));
    peo.shutdown();
  });

  it('should emit step events', async () => {
    const peo = new PlanExecuteOrchestrator();
    const events = [];

    peo.on('step-started', (e) => events.push('step-started:' + e.stepId));
    peo.on('step-completed', (e) => events.push('step-completed:' + e.stepId));

    await peo.execute('test', {
      planFn: async () => ['step1'],
      executeFn: async () => 'ok',
    });

    assert.ok(events.some(e => e.startsWith('step-started:')));
    assert.ok(events.some(e => e.startsWith('step-completed:')));
    peo.shutdown();
  });

  it('should emit replan-triggered event', async () => {
    const peo = new PlanExecuteOrchestrator({ maxStepRetries: 0, maxReplanCount: 1 });
    let replanEvent = null;

    peo.on('replan-triggered', (e) => { replanEvent = e; });

    await peo.execute('test', {
      planFn: async () => ['failing-step'],
      executeFn: async (step) => { if (step.description === 'failing-step') throw new Error('fail'); return 'ok'; },
      replanFn: async () => ['alt-step'],
    });

    assert.ok(replanEvent);
    assert.strictEqual(replanEvent.failedStepId, 'step-1');
    peo.shutdown();
  });

  it('should track stats correctly', async () => {
    const peo = new PlanExecuteOrchestrator();

    await peo.execute('test', {
      planFn: async () => ['step1', 'step2'],
      executeFn: async () => 'ok',
    });

    const stats = peo.getStats();
    assert.strictEqual(stats.plansCreated, 1);
    assert.strictEqual(stats.stepsExecuted, 2);
    assert.strictEqual(stats.stepsCompleted, 2);
    assert.strictEqual(stats.stepsFailed, 0);
    peo.shutdown();
  });

  it('should track history', async () => {
    const peo = new PlanExecuteOrchestrator();

    await peo.execute('test1', { planFn: async () => ['s1'], executeFn: async () => 'ok' });
    await peo.execute('test2', { planFn: async () => ['s1'], executeFn: async () => 'ok' });

    const history = peo.getHistory();
    assert.strictEqual(history.length, 2);
    peo.shutdown();
  });

  it('should throw on invalid objective', async () => {
    const peo = new PlanExecuteOrchestrator();
    await assert.rejects(() => peo.execute('', { planFn: async () => [] }), /non-empty string/);
    peo.shutdown();
  });

  it('should throw on missing planFn', async () => {
    const peo = new PlanExecuteOrchestrator();
    await assert.rejects(() => peo.execute('test', { executeFn: async () => 'ok' }), /planFn is required/);
    peo.shutdown();
  });

  it('should throw on missing executeFn', async () => {
    const peo = new PlanExecuteOrchestrator();
    await assert.rejects(() => peo.execute('test', { planFn: async () => ['s1'] }), /executeFn is required/);
    peo.shutdown();
  });

  it('should shutdown cleanly', async () => {
    const peo = new PlanExecuteOrchestrator();
    peo.shutdown();
    await assert.rejects(
      () => peo.execute('test', { planFn: async () => [], executeFn: async () => 'ok' }),
      /shut down/,
    );
  });

  it('should expose STEP_STATUS constants', () => {
    assert.strictEqual(STEP_STATUS.PENDING, 'pending');
    assert.strictEqual(STEP_STATUS.RUNNING, 'running');
    assert.strictEqual(STEP_STATUS.COMPLETED, 'completed');
    assert.strictEqual(STEP_STATUS.FAILED, 'failed');
    assert.strictEqual(STEP_STATUS.REPLANNED, 'replanned');
  });

  it('should expose PLAN_STATUS constants', () => {
    assert.strictEqual(PLAN_STATUS.PLANNING, 'planning');
    assert.strictEqual(PLAN_STATUS.EXECUTING, 'executing');
    assert.strictEqual(PLAN_STATUS.REPLANNING, 'replanning');
    assert.strictEqual(PLAN_STATUS.COMPLETED, 'completed');
    assert.strictEqual(PLAN_STATUS.FAILED, 'failed');
  });

  it('should expose ESCALATION_LEVELS constants', () => {
    assert.strictEqual(ESCALATION_LEVELS.RETRY, 'retry');
    assert.strictEqual(ESCALATION_LEVELS.REPLAN, 'replan');
    assert.strictEqual(ESCALATION_LEVELS.DECOMPOSE, 'decompose');
  });

  it('should handle verification error gracefully', async () => {
    const peo = new PlanExecuteOrchestrator({ maxStepRetries: 0, maxReplanCount: 1 });
    let replanCalled = false;

    const _result = await peo.execute('test', {
      planFn: async () => ['step1'],
      executeFn: async () => 'result',
      verifyFn: async () => { throw new Error('verify crash'); },
      replanFn: async () => {
        replanCalled = true;
        return ['alt-step'];
      },
    });

    // Verification error should be treated as verification failure
    assert.ok(replanCalled, 'Replan should be triggered on verification error');
    peo.shutdown();
  });

  it('should skip already completed steps', async () => {
    const peo = new PlanExecuteOrchestrator();
    const executed = [];

    const result = await peo.execute('test', {
      planFn: async () => [
        { id: 's1', description: 'step1', status: STEP_STATUS.COMPLETED },
        'step2',
      ],
      executeFn: async (step) => { executed.push(step.description); return 'ok'; },
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(executed, ['step2']);
    peo.shutdown();
  });
});
