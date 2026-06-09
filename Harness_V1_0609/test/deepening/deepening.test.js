'use strict';
const { describe, it , afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');


const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { const r = obj.destroy(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}
describe('RecurrentDeepeningScheduler', () => {
  afterEach(async () => { await _cleanAll(); });
  const RecurrentDeepeningScheduler = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'recurrent-deepening-scheduler'));

  it('should export default constants', () => {
    assert.equal(RecurrentDeepeningScheduler.DEFAULT_MAX_ITERATIONS, 4);
    assert.equal(RecurrentDeepeningScheduler.DEFAULT_CONVERGENCE_THRESHOLD, 0.85);
    assert.ok(RecurrentDeepeningScheduler.DEFAULT_MIN_IMPROVEMENT > 0);
  });

  it('should construct with default options', () => {
    const scheduler = _track(new RecurrentDeepeningScheduler());
    assert.ok(scheduler.isHealthy());
    const stats = scheduler.getStats();
    assert.equal(stats.maxIterations, 4);
    assert.equal(stats.convergenceThreshold, 0.85);
  });

  it('should construct with custom options', () => {
    const scheduler = _track(new RecurrentDeepeningScheduler({ maxIterations: 2, convergenceThreshold: 0.9 }));
    const stats = scheduler.getStats();
    assert.equal(stats.maxIterations, 2);
    assert.equal(stats.convergenceThreshold, 0.9);
  });

  it('should reject invalid agent', async () => {
    const scheduler = _track(new RecurrentDeepeningScheduler());
    const result = await scheduler.execute(null, { description: 'test' });
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('should reject invalid task', async () => {
    const scheduler = _track(new RecurrentDeepeningScheduler());
    const agent = { execute: async () => 'ok' };
    const result = await scheduler.execute(agent, null);
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('should execute single iteration and converge with high quality evaluator', async () => {
    const scheduler = _track(new RecurrentDeepeningScheduler({ maxIterations: 4, convergenceThreshold: 0.9 }));
    const agent = { execute: async (_task) => ({ output: 'result' }) };
    const evaluator = async () => 0.95;

    const result = await scheduler.execute(agent, { description: 'test task' }, evaluator);
    assert.equal(result.success, true);
    assert.equal(result.iterations, 1);
    assert.equal(result.converged, true);
    assert.ok(result.qualityScore >= 0.9);
  });

  it('should iterate multiple times with low quality evaluator', async () => {
    const scheduler = _track(new RecurrentDeepeningScheduler({ maxIterations: 4, convergenceThreshold: 0.9, minImprovement: 0.01 }));
    let callCount = 0;
    const agent = {
      execute: async (_task) => {
        callCount++;
        return { output: `result-${callCount}` };
      },
    };
    const evaluator = async () => 0.5;

    const result = await scheduler.execute(agent, { description: 'test' }, evaluator);
    assert.equal(result.success, true);
    assert.ok(result.iterations >= 2);
    assert.ok(result.qualityScores.length >= 2);
  });

  it('should emit iteration-complete events', async () => {
    const scheduler = _track(new RecurrentDeepeningScheduler({ maxIterations: 2, convergenceThreshold: 0.99, minImprovement: 0.001 }));
    const agent = { execute: async (_task) => ({ output: 'result' }) };
    const evaluator = async () => 0.5;

    const events = [];
    scheduler.on('iteration-complete', (e) => events.push(e));

    await scheduler.execute(agent, { description: 'test' }, evaluator);
    assert.ok(events.length >= 1);
    assert.ok(events[0].iteration >= 1);
    assert.ok(events[0].qualityScore !== undefined);
  });

  it('should handle agent execution errors gracefully', async () => {
    const scheduler = _track(new RecurrentDeepeningScheduler({ maxIterations: 3 }));
    let callCount = 0;
    const agent = {
      execute: async () => {
        callCount++;
        if (callCount === 1) throw new Error('first fail');
        return { output: 'recovered' };
      },
    };
    const evaluator = async () => 0.9;

    const events = [];
    scheduler.on('iteration-error', (e) => events.push(e));

    const result = await scheduler.execute(agent, { description: 'test' }, evaluator);
    assert.ok(events.length >= 1);
    assert.ok(result.success === true || result.iterations > 0);
  });

  it('should enrich task with deepening context on subsequent iterations', async () => {
    const scheduler = _track(new RecurrentDeepeningScheduler({ maxIterations: 3, convergenceThreshold: 0.99, minImprovement: 0.001 }));
    const capturedTasks = [];
    const agent = {
      execute: async (task) => {
        capturedTasks.push(task);
        return { output: 'result' };
      },
    };
    const evaluator = async () => 0.5;

    await scheduler.execute(agent, { description: 'test' }, evaluator);
    assert.ok(capturedTasks.length >= 2);
    const secondTask = capturedTasks[1];
    assert.ok(secondTask._ar);
    assert.ok(secondTask._ar.iteration >= 1);
  });

  it('should shutdown cleanly', () => {
    const scheduler = _track(new RecurrentDeepeningScheduler());
    scheduler.shutdown();
    assert.equal(scheduler.getStats().activeExecutions, 0);
  });
});

describe('AdaptiveDepthController', () => {
  const AdaptiveDepthController = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'adaptive-depth-controller'));

  it('should export depth levels and signals', () => {
    assert.ok(AdaptiveDepthController.DEPTH_LEVELS.QUICK);
    assert.ok(AdaptiveDepthController.DEPTH_LEVELS.STANDARD);
    assert.ok(AdaptiveDepthController.DEPTH_LEVELS.DEEP);
    assert.ok(AdaptiveDepthController.COMPLEXITY_SIGNALS);
  });

  it('should assess simple task as quick depth', () => {
    const controller = _track(new AdaptiveDepthController());
    const assessment = controller.assessComplexity({ description: 'fix a typo' });
    assert.ok(assessment.score < 0.5);
    assert.ok(['quick', 'standard'].includes(assessment.level));
  });

  it('should assess complex task as deep or intensive', () => {
    const controller = _track(new AdaptiveDepthController());
    const assessment = controller.assessComplexity({
      description: '设计一个安全的分布式系统架构并优化性能',
      depends_on: ['component-a', 'component-b', 'component-c'],
    });
    assert.ok(assessment.score >= 0.5);
    assert.ok(['deep', 'intensive'].includes(assessment.level));
  });

  it('should return default assessment for null task', () => {
    const controller = _track(new AdaptiveDepthController());
    const assessment = controller.assessComplexity(null);
    assert.equal(assessment.level, 'standard');
    assert.equal(assessment.depth, 2);
  });

  it('should return default assessment for invalid task', () => {
    const controller = _track(new AdaptiveDepthController());
    const assessment = controller.assessComplexity('not an object');
    assert.equal(assessment.level, 'standard');
  });

  it('should detect scope keywords', () => {
    const controller = _track(new AdaptiveDepthController());
    const assessment = controller.assessComplexity({ description: '构建一个系统平台' });
    assert.ok(assessment.signals.scope >= 0.5);
  });

  it('should detect high risk signals', () => {
    const controller = _track(new AdaptiveDepthController());
    const assessment = controller.assessComplexity({ description: '安全关键的生产环境部署' });
    assert.ok(assessment.signals.risk >= 0.7);
  });

  it('should detect deep reasoning signals', () => {
    const controller = _track(new AdaptiveDepthController());
    const assessment = controller.assessComplexity({ description: '推理分析优化算法' });
    assert.ok(assessment.signals.reasoning >= 0.5);
  });

  it('should factor in dependency depth', () => {
    const controller = _track(new AdaptiveDepthController());
    const a1 = controller.assessComplexity({ description: 'simple task' });
    const a2 = controller.assessComplexity({ description: 'simple task', depends_on: ['a', 'b', 'c', 'd', 'e'] });
    assert.ok(a2.signals.dependencyDepth > a1.signals.dependencyDepth);
  });

  it('should emit complexity-assessed event', () => {
    const controller = _track(new AdaptiveDepthController());
    const events = [];
    controller.on('complexity-assessed', (e) => events.push(e));
    controller.assessComplexity({ description: 'test' });
    assert.equal(events.length, 1);
    assert.ok(events[0].score !== undefined);
  });

  it('should provide recommended depth and level', () => {
    const controller = _track(new AdaptiveDepthController());
    const task = { description: 'test' };
    const depth = controller.getRecommendedDepth(task);
    const level = controller.getRecommendedLevel(task);
    assert.ok(typeof depth === 'number');
    assert.ok(typeof level === 'string');
  });

  it('should shutdown cleanly', () => {
    const controller = _track(new AdaptiveDepthController());
    controller.shutdown();
    assert.equal(controller.getStats().totalAssessments, 0);
  });
});

describe('LTIContextInjector', () => {
  const LTIContextInjector = require(path.join(ROOT, 'src', 'runtime', 'context', 'lti-context-injector'));

  it('should register and retrieve original context', () => {
    const injector = _track(new LTIContextInjector());
    injector.registerOriginalContext('task-1', { description: 'original goal', constraints: ['c1'] });
    const ctx = injector.getOriginalContext('task-1');
    assert.ok(ctx);
    assert.equal(ctx.description, 'original goal');
  });

  it('should inject context into current task', () => {
    const injector = _track(new LTIContextInjector());
    injector.registerOriginalContext('task-1', { description: 'original goal', constraints: ['c1'] });
    const currentTask = { description: 'modified task', data: 'current' };
    const injected = injector.inject('task-1', currentTask, 1);
    assert.ok(injected._ltiContext);
    assert.equal(injected._ltiContext.iteration, 1);
    assert.equal(injected._ltiContext.originalGoal, 'original goal');
  });

  it('should return current task unchanged if no original context', () => {
    const injector = _track(new LTIContextInjector());
    const currentTask = { description: 'test' };
    const injected = injector.inject('unknown-task', currentTask, 0);
    assert.equal(injected, currentTask);
  });

  it('should compute goal signal when goals diverge', () => {
    const injector = _track(new LTIContextInjector({ mode: 'lti' }));
    injector.registerOriginalContext('task-1', { description: 'build authentication system' });
    const currentTask = { description: 'fix a CSS bug' };
    const injected = injector.inject('task-1', currentTask, 2);
    assert.ok(injected._ltiContext.goalSignal);
  });

  it('should not inject goal signal when goals overlap', () => {
    const injector = _track(new LTIContextInjector({ mode: 'lti' }));
    injector.registerOriginalContext('task-1', { description: 'build authentication system' });
    const currentTask = { description: 'build authentication system with OAuth' };
    const injected = injector.inject('task-1', currentTask, 1);
    assert.equal(injected._ltiContext.goalSignal, null);
  });

  it('should track injection history', () => {
    const injector = _track(new LTIContextInjector());
    injector.registerOriginalContext('task-1', { description: 'test' });
    injector.inject('task-1', { description: 'test' }, 0);
    injector.inject('task-1', { description: 'test' }, 1);
    const history = injector.getInjectionHistory('task-1');
    assert.equal(history.length, 2);
  });

  it('should unregister context', () => {
    const injector = _track(new LTIContextInjector());
    injector.registerOriginalContext('task-1', { description: 'test' });
    const result = injector.unregisterContext('task-1');
    assert.equal(result, true);
    assert.equal(injector.getOriginalContext('task-1'), null);
  });

  it('should emit context-registered and context-injected events', () => {
    const injector = _track(new LTIContextInjector());
    const events = [];
    injector.on('context-registered', (e) => events.push({ type: 'registered', ...e }));
    injector.on('context-injected', (e) => events.push({ type: 'injected', ...e }));
    injector.registerOriginalContext('task-1', { description: 'test' });
    injector.inject('task-1', { description: 'test' }, 0);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'registered');
    assert.equal(events[1].type, 'injected');
  });

  it('should shutdown cleanly', () => {
    const injector = _track(new LTIContextInjector());
    injector.shutdown();
    assert.equal(injector.getStats().registeredContexts, 0);
  });
});

describe('MultiAgentRouter', () => {
  const MultiAgentRouter = require(path.join(ROOT, 'src', 'runtime', 'agent', 'multi-agent-router'));

  it('should route implementation task to task-worker', () => {
    const router = _track(new MultiAgentRouter());
    const result = router.route({ description: '实现用户登录功能' });
    assert.ok(result.agents.length > 0);
    const agentIds = result.agents.map(a => a.agentId);
    assert.ok(agentIds.includes('task-worker'));
  });

  it('should route review task to quality-assurance and domain-analyst', () => {
    const router = _track(new MultiAgentRouter({ topK: 3 }));
    const result = router.route({ description: '审查代码安全漏洞' });
    assert.ok(result.agents.length >= 2);
    const agentIds = result.agents.map(a => a.agentId);
    assert.ok(agentIds.includes('quality-assurance'));
  });

  it('should route architecture task to domain-analyst', () => {
    const router = _track(new MultiAgentRouter());
    const result = router.route({ description: '设计系统架构' });
    assert.ok(result.agents.length > 0);
    const agentIds = result.agents.map(a => a.agentId);
    assert.ok(agentIds.includes('domain-analyst'));
  });

  it('should return empty for null task', () => {
    const router = _track(new MultiAgentRouter());
    const result = router.route(null);
    assert.equal(result.agents.length, 0);
  });

  it('should respect topK limit', () => {
    const router = _track(new MultiAgentRouter({ topK: 1 }));
    const result = router.route({ description: '实现功能并测试' });
    assert.ok(result.agents.length <= 1);
  });

  it('should respect minAffinity threshold', () => {
    const router = _track(new MultiAgentRouter({ minAffinity: 0.99 }));
    const result = router.route({ description: 'simple task' });
    assert.ok(result.agents.every(a => a.score >= 0.99));
  });

  it('should update and retrieve affinity', () => {
    const router = _track(new MultiAgentRouter());
    router.updateAffinity('task-worker', 'implementation', 0.3);
    const affinity = router.getAffinity('task-worker', 'implementation');
    assert.ok(affinity > 0.5);
  });

  it('should identify task types correctly', () => {
    const router = _track(new MultiAgentRouter());
    const result = router.route({ description: '测试并部署系统' });
    assert.ok(result.taskTypes.includes('testing'));
    assert.ok(result.taskTypes.includes('deployment'));
  });

  it('should emit routed event', () => {
    const router = _track(new MultiAgentRouter());
    const events = [];
    router.on('routed', (e) => events.push(e));
    router.route({ description: 'test' });
    assert.equal(events.length, 1);
    assert.ok(events[0].routingId);
  });

  it('should track routing history', () => {
    const router = _track(new MultiAgentRouter());
    router.route({ description: 'test 1' });
    router.route({ description: 'test 2' });
    const history = router.getRoutingHistory();
    assert.ok(history.length >= 2);
  });

  it('should shutdown cleanly', () => {
    const router = _track(new MultiAgentRouter());
    router.shutdown();
    assert.equal(router.getStats().totalRoutings, 0);
  });
});

describe('OutputFusion', () => {
  const OutputFusion = require(path.join(ROOT, 'src', 'runtime', 'collaboration', 'output-fusion'));

  it('should export fusion strategies', () => {
    assert.ok(OutputFusion.STRATEGIES.CASCADE);
    assert.ok(OutputFusion.STRATEGIES.VOTE);
    assert.ok(OutputFusion.STRATEGIES.WEIGHTED);
    assert.ok(OutputFusion.STRATEGIES.REVIEW);
  });

  it('should return single result unchanged', async () => {
    const fusion = _track(new OutputFusion());
    const result = await fusion.fuse([{ agentId: 'a', output: 'hello', confidence: 0.9 }]);
    assert.equal(result.fused, 'hello');
    assert.equal(result.strategy, 'single');
  });

  it('should return null for empty results', async () => {
    const fusion = _track(new OutputFusion());
    const result = await fusion.fuse([]);
    assert.equal(result.fused, null);
    assert.equal(result.confidence, 0);
  });

  it('should fuse with cascade strategy', async () => {
    const fusion = _track(new OutputFusion({ defaultStrategy: 'cascade' }));
    const results = [
      { agentId: 'primary', output: { code: 'fn()', docs: 'primary docs' }, confidence: 0.9 },
      { agentId: 'secondary', output: { code: 'fn2()', tests: 'test suite' }, confidence: 0.7 },
    ];
    const result = await fusion.fuse(results);
    assert.ok(result.fused);
    assert.equal(result.fused.code, 'fn()');
    assert.equal(result.fused.tests, 'test suite');
    assert.equal(result.strategy, 'cascade');
  });

  it('should fuse with vote strategy', async () => {
    const fusion = _track(new OutputFusion({ defaultStrategy: 'vote' }));
    const results = [
      { agentId: 'a', output: { decision: 'approve' }, confidence: 0.9 },
      { agentId: 'b', output: { decision: 'approve' }, confidence: 0.8 },
      { agentId: 'c', output: { decision: 'reject' }, confidence: 0.6 },
    ];
    const result = await fusion.fuse(results, 'vote');
    assert.equal(result.fused.decision, 'approve');
    assert.ok(result.confidence > 0.5);
  });

  it('should fuse with weighted strategy', async () => {
    const fusion = _track(new OutputFusion({ defaultStrategy: 'weighted' }));
    const results = [
      { agentId: 'a', output: { score: 0.8, label: 'good' }, confidence: 0.9 },
      { agentId: 'b', output: { score: 0.6, label: 'ok' }, confidence: 0.7 },
    ];
    const result = await fusion.fuse(results, 'weighted');
    assert.ok(result.fused.score > 0);
    assert.ok(result.fused.score < 1);
  });

  it('should fuse with review strategy', async () => {
    const fusion = _track(new OutputFusion({ defaultStrategy: 'review' }));
    const results = [
      { agentId: 'implementer', output: { code: 'fn()' }, confidence: 0.8 },
      { agentId: 'reviewer', output: { approved: true, feedback: 'looks good' }, confidence: 0.9 },
    ];
    const result = await fusion.fuse(results, 'review');
    assert.ok(result.fused.output);
    assert.ok(result.fused.approved);
    assert.ok(result.fused.reviews.length > 0);
  });

  it('should emit fusion-complete event', async () => {
    const fusion = _track(new OutputFusion());
    const events = [];
    fusion.on('fusion-complete', (e) => events.push(e));
    await fusion.fuse([
      { agentId: 'a', output: 'hello', confidence: 0.9 },
      { agentId: 'b', output: 'world', confidence: 0.8 },
    ]);
    assert.equal(events.length, 1);
  });

  it('should track fusion stats', async () => {
    const fusion = _track(new OutputFusion());
    await fusion.fuse([
      { agentId: 'a', output: 'x', confidence: 0.9 },
      { agentId: 'b', output: 'y', confidence: 0.8 },
    ]);
    const stats = fusion.getStats();
    assert.equal(stats.totalFusions, 1);
  });

  it('should shutdown cleanly', () => {
    const fusion = _track(new OutputFusion());
    fusion.shutdown();
    assert.equal(fusion.getStats().totalFusions, 0);
  });
});

describe('IterativeRefinement', () => {
  const IterativeRefinement = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'iterative-refinement'));

  it('should export default constants', () => {
    assert.equal(IterativeRefinement.DEFAULT_MAX_REFINEMENTS, 5);
    assert.equal(IterativeRefinement.DEFAULT_QUALITY_THRESHOLD, 0.8);
  });

  it('should execute without reviewer and return result', async () => {
    const refinement = _track(new IterativeRefinement());
    const executor = { execute: async (_task) => ({ output: 'result' }) };
    const result = await refinement.refine(executor, { description: 'test' });
    assert.equal(result.success, true);
    assert.equal(result.rounds, 1);
  });

  it('should refine until quality threshold is met', async () => {
    const refinement = _track(new IterativeRefinement({ maxRefinements: 3, qualityThreshold: 0.8 }));
    let callCount = 0;
    const executor = {
      execute: async (_task) => {
        callCount++;
        return { output: `result-${callCount}` };
      },
    };
    const reviewer = async (_result, _task) => {
      if (callCount >= 2) return { qualityScore: 0.9, approved: true, feedback: '' };
      return { qualityScore: 0.5, approved: false, feedback: 'needs improvement' };
    };

    const result = await refinement.refine(executor, { description: 'test' }, reviewer);
    assert.equal(result.success, true);
    assert.ok(result.converged);
    assert.ok(result.rounds >= 2);
  });

  it('should stop at max refinements if not converged', async () => {
    const refinement = _track(new IterativeRefinement({ maxRefinements: 2, qualityThreshold: 0.99 }));
    const executor = { execute: async (_task) => ({ output: 'result' }) };
    const reviewer = async () => ({ qualityScore: 0.5, approved: false, feedback: 'not enough' });

    const result = await refinement.refine(executor, { description: 'test' }, reviewer);
    assert.equal(result.success, false);
    assert.ok(result.rounds <= 3);
  });

  it('should reject invalid executor', async () => {
    const refinement = _track(new IterativeRefinement());
    const result = await refinement.refine(null, { description: 'test' });
    assert.equal(result.success, false);
  });

  it('should reject invalid task', async () => {
    const refinement = _track(new IterativeRefinement());
    const executor = { execute: async () => 'ok' };
    const result = await refinement.refine(executor, null);
    assert.equal(result.success, false);
  });

  it('should emit refinement-round events', async () => {
    const refinement = _track(new IterativeRefinement({ maxRefinements: 2, qualityThreshold: 0.99 }));
    const executor = { execute: async (_task) => ({ output: 'result' }) };
    const reviewer = async () => ({ qualityScore: 0.5, approved: false, feedback: 'improve' });

    const events = [];
    refinement.on('refinement-round', (e) => events.push(e));
    await refinement.refine(executor, { description: 'test' }, reviewer);
    assert.ok(events.length >= 1);
  });

  it('should build refinement task with feedback', async () => {
    const refinement = _track(new IterativeRefinement({ maxRefinements: 2, qualityThreshold: 0.99 }));
    const capturedTasks = [];
    const executor = {
      execute: async (task) => {
        capturedTasks.push(task);
        return { output: 'result' };
      },
    };
    const reviewer = async () => ({ qualityScore: 0.5, approved: false, feedback: 'add more tests' });

    await refinement.refine(executor, { description: 'test' }, reviewer);
    assert.ok(capturedTasks.length >= 2);
    const refinedTask = capturedTasks[capturedTasks.length - 1];
    assert.ok(refinedTask._ar || refinedTask.refinementInstructions);
  });

  it('should shutdown cleanly', () => {
    const refinement = _track(new IterativeRefinement());
    refinement.shutdown();
    assert.equal(refinement.getStats().activeRefinements, 0);
  });
});

describe('ProgressiveDeepening', () => {
  const ProgressiveDeepening = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'progressive-deepening'));

  it('should export depth levels', () => {
    assert.ok(ProgressiveDeepening.DEPTH_LEVELS.QUICK);
    assert.ok(ProgressiveDeepening.DEPTH_LEVELS.STANDARD);
    assert.ok(ProgressiveDeepening.DEPTH_LEVELS.DEEP);
    assert.ok(ProgressiveDeepening.DEPTH_LEVELS.INTENSIVE);
  });

  it('should execute at quick level with 1 iteration', async () => {
    const pd = _track(new ProgressiveDeepening());
    const agent = { execute: async (_task) => ({ output: 'result' }) };
    const result = await pd.execute(agent, { description: 'test' }, 'quick');
    assert.equal(result.success, true);
    assert.equal(result.level, 'quick');
    assert.equal(result.iterations, 1);
  });

  it('should execute at intensive level with 4 iterations', async () => {
    const pd = _track(new ProgressiveDeepening());
    let callCount = 0;
    const agent = {
      execute: async (_task) => {
        callCount++;
        return { output: `result-${callCount}` };
      },
    };
    const result = await pd.execute(agent, { description: 'test' }, 'intensive');
    assert.equal(result.success, true);
    assert.equal(result.level, 'intensive');
    assert.ok(result.iterations <= 4);
    assert.ok(callCount <= 4);
  });

  it('should reject invalid agent', async () => {
    const pd = _track(new ProgressiveDeepening());
    const result = await pd.execute(null, { description: 'test' }, 'standard');
    assert.equal(result.success, false);
  });

  it('should reject invalid task', async () => {
    const pd = _track(new ProgressiveDeepening());
    const agent = { execute: async () => 'ok' };
    const result = await pd.execute(agent, null, 'standard');
    assert.equal(result.success, false);
  });

  it('should use reviewer when reviewEnabled and reviewer provided', async () => {
    const pd = _track(new ProgressiveDeepening());
    const agent = { execute: async (_task) => ({ output: 'result' }) };
    const reviewer = async (_result, _task) => ({ qualityScore: 0.7, feedback: 'ok' });

    const result = await pd.execute(agent, { description: 'test' }, 'deep', { reviewer });
    assert.equal(result.success, true);
    assert.ok(result.reviews.length > 0);
  });

  it('should use adversarial reviewer when adversarialEnabled', async () => {
    const pd = _track(new ProgressiveDeepening());
    const agent = { execute: async (_task) => ({ output: 'result' }) };
    const reviewer = async (_result, _task) => ({ qualityScore: 0.7, feedback: 'ok' });
    const adversarialReviewer = {
      review: async (_subject, _rA, _rB) => ({
        consensus: true,
        rounds: 1,
        details: [],
      }),
    };

    const result = await pd.execute(agent, { description: 'test' }, 'intensive', {
      reviewer,
      adversarialReviewer,
      reviewerA: async () => ({ approved: true, feedback: '' }),
      reviewerB: async () => ({ approved: true, feedback: '' }),
    });
    assert.equal(result.success, true);
    assert.ok(result.adversarialResult);
  });

  it('should early converge when quality is high', async () => {
    const pd = _track(new ProgressiveDeepening());
    let callCount = 0;
    const agent = {
      execute: async (_task) => {
        callCount++;
        return { output: `result-${callCount}` };
      },
    };
    const reviewer = async () => ({ qualityScore: 0.95, feedback: 'excellent' });

    await pd.execute(agent, { description: 'test' }, 'deep', { reviewer });
    assert.ok(callCount <= 2);
  });

  it('should emit execution-start and execution-complete events', async () => {
    const pd = _track(new ProgressiveDeepening());
    const agent = { execute: async (_task) => ({ output: 'result' }) };
    const events = [];
    pd.on('execution-start', (e) => events.push({ type: 'start', ...e }));
    pd.on('execution-complete', (e) => events.push({ type: 'complete', ...e }));

    await pd.execute(agent, { description: 'test' }, 'quick');
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'start');
    assert.equal(events[1].type, 'complete');
  });

  it('should return level config', () => {
    const pd = _track(new ProgressiveDeepening());
    const config = pd.getLevelConfig('intensive');
    assert.equal(config.name, 'intensive');
    assert.equal(config.iterations, 4);
    assert.equal(config.reviewEnabled, true);
    assert.equal(config.adversarialEnabled, true);
  });

  it('should track execution stats', async () => {
    const pd = _track(new ProgressiveDeepening());
    const agent = { execute: async (_task) => ({ output: 'result' }) };
    await pd.execute(agent, { description: 'test' }, 'quick');
    await pd.execute(agent, { description: 'test' }, 'deep');

    const stats = pd.getStats();
    assert.equal(stats.totalExecutions, 2);
    assert.ok(stats.levelCounts.quick >= 1);
    assert.ok(stats.levelCounts.deep >= 1);
  });

  it('should shutdown cleanly', () => {
    const pd = _track(new ProgressiveDeepening());
    pd.shutdown();
    assert.equal(pd.getStats().totalExecutions, 0);
  });
});

describe('Integration: Deepening Modules with Framework', () => {
  it('should create framework with all new modules', async () => {
    const { create } = require(path.join(ROOT, 'src', 'index'));
    const instance = create(ROOT);
    assert.ok(instance.recurrentDeepening);
    assert.ok(instance.adaptiveDepth);
    assert.ok(instance.ltiInjector);
    assert.ok(instance.multiAgentRouter);
    assert.ok(instance.outputFusion);
    assert.ok(instance.iterativeRefinement);
    assert.ok(instance.progressiveDeepening);
    await instance.destroy();
  });

  it('should register health checks for new modules', async () => {
    const { create } = require(path.join(ROOT, 'src', 'index'));
    const instance = create(ROOT);
    const result = await instance.healthChecker.checkAll();
    const checks = Object.values(result.checks);
    const deepeningChecks = checks.filter(c =>
      c.name === 'recurrent-deepening' ||
      c.name === 'adaptive-depth' ||
      c.name === 'lti-injector' ||
      c.name === 'multi-agent-router' ||
      c.name === 'output-fusion' ||
      c.name === 'iterative-refinement' ||
      c.name === 'progressive-deepening',
    );
    assert.equal(deepeningChecks.length, 7);
    for (const check of deepeningChecks) {
      assert.equal(check.status, 'healthy', `${check.name} should be healthy`);
    }
    await instance.destroy();
  });

  it('should export new modules from package', () => {
    const pkg = require(path.join(ROOT, 'src', 'index'));
    assert.ok(pkg.RecurrentDeepeningScheduler);
    assert.ok(pkg.AdaptiveDepthController);
    assert.ok(pkg.LTIContextInjector);
    assert.ok(pkg.MultiAgentRouter);
    assert.ok(pkg.OutputFusion);
    assert.ok(pkg.IterativeRefinement);
    assert.ok(pkg.ProgressiveDeepening);
  });

  it('should integrate adaptive depth with progressive deepening', async () => {
    const AdaptiveDepthController = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'adaptive-depth-controller'));
    const ProgressiveDeepening = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'progressive-deepening'));

    const controller = _track(new AdaptiveDepthController());
    const pd = _track(new ProgressiveDeepening());

    const simpleTask = { description: 'fix a typo' };
    const assessment = controller.assessComplexity(simpleTask);
    const result = await pd.execute(
      { execute: async (_task) => ({ output: 'fixed' }) },
      simpleTask,
      assessment.level,
    );
    assert.equal(result.success, true);
    assert.ok(['quick', 'standard'].includes(result.level));
  });

  it('should integrate multi-agent router with output fusion', async () => {
    const MultiAgentRouter = require(path.join(ROOT, 'src', 'runtime', 'agent', 'multi-agent-router'));
    const OutputFusion = require(path.join(ROOT, 'src', 'runtime', 'collaboration', 'output-fusion'));

    const router = _track(new MultiAgentRouter({ topK: 2 }));
    const fusion = _track(new OutputFusion({ defaultStrategy: 'cascade' }));

    const routing = router.route({ description: '实现并测试登录功能' });
    assert.ok(routing.agents.length >= 1);

    const agentResults = routing.agents.map(a => ({
      agentId: a.agentId,
      output: { result: `output from ${a.agentId}` },
      confidence: a.score,
    }));

    const fusedResult = await fusion.fuse(agentResults);
    assert.ok(fusedResult.fused);
    assert.ok(fusedResult.confidence > 0);
  });

  it('should integrate LTI injector with recurrent deepening', async () => {
    const LTIContextInjector = require(path.join(ROOT, 'src', 'runtime', 'context', 'lti-context-injector'));
    const RecurrentDeepeningScheduler = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'recurrent-deepening-scheduler'));

    const injector = _track(new LTIContextInjector());
    const scheduler = _track(new RecurrentDeepeningScheduler({ maxIterations: 2, convergenceThreshold: 0.99, minImprovement: 0.001 }));

    const taskId = 'integration-test';
    const originalTask = { description: 'build auth system', constraints: ['secure', 'fast'] };
    injector.registerOriginalContext(taskId, originalTask);

    let callCount = 0;
    const agent = {
      execute: async (task) => {
        callCount++;
        const injected = injector.inject(taskId, task, callCount - 1);
        return { output: `result-${callCount}`, hasLTI: !!injected._ltiContext };
      },
    };

    const result = await scheduler.execute(agent, originalTask, async () => 0.5);
    assert.equal(result.success, true);
    assert.ok(result.iterations >= 1);
  });
});
