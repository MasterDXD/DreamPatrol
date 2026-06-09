'use strict';
const { describe, it , afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

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
describe('DeepeningOrchestrator', () => {
  afterEach(async () => { await _cleanAll(); });
  const DeepeningOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-orchestrator'));

  it('should construct with default config', () => {
    const orch = _track(new DeepeningOrchestrator());
    assert.ok(orch.isHealthy());
    const stats = orch.getStats();
    assert.equal(stats.config.defaultDepthLevel, 'standard');
  });

  it('should construct with custom config', () => {
    const orch = _track(new DeepeningOrchestrator({ defaultDepthLevel: 'deep', maxIterations: 6 }));
    assert.equal(orch.getStats().config.defaultDepthLevel, 'deep');
    assert.equal(orch.getStats().config.maxIterations, 6);
  });

  it('should reject invalid task', async () => {
    const orch = _track(new DeepeningOrchestrator());
    const result = await orch.execute(null, {});
    assert.equal(result.success, false);
  });

  it('should reject invalid agents', async () => {
    const orch = _track(new DeepeningOrchestrator());
    const result = await orch.execute({ description: 'test' }, null);
    assert.equal(result.success, false);
  });

  it('should execute with single agent at standard level', async () => {
    const orch = _track(new DeepeningOrchestrator());
    const agents = [{ id: 'worker', execute: async (_task) => ({ output: 'done', success: true }) }];
    const result = await orch.execute({ description: 'test task' }, agents);
    assert.equal(result.success, true);
    assert.equal(result.depthLevel, 'standard');
    assert.ok(result.agentsUsed.includes('worker'));
  });

  it('should execute at quick level with 1 iteration', async () => {
    const orch = _track(new DeepeningOrchestrator({ defaultDepthLevel: 'quick' }));
    const agents = [{ id: 'worker', execute: async (_task) => ({ output: 'done' }) }];
    const result = await orch.execute({ description: 'test' }, agents, { depthLevel: 'quick' });
    assert.equal(result.success, true);
    assert.equal(result.depthLevel, 'quick');
  });

  it('should execute at intensive level with multiple iterations', async () => {
    const orch = _track(new DeepeningOrchestrator());
    let callCount = 0;
    const agents = [{
      id: 'worker',
      execute: async (_task) => {
        callCount++;
        return { output: `result-${callCount}`, success: true };
      },
    }];
    const result = await orch.execute({ description: 'test' }, agents, { depthLevel: 'intensive' });
    assert.equal(result.success, true);
    assert.equal(result.depthLevel, 'intensive');
    assert.ok(callCount <= 4);
  });

  it('should use adaptive depth when provided', async () => {
    const AdaptiveDepthController = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'adaptive-depth-controller'));
    const orch = _track(new DeepeningOrchestrator());
    const adaptiveDepth = _track(new AdaptiveDepthController());
    const agents = [{ id: 'worker', execute: async (_task) => ({ output: 'done' }) }];
    const result = await orch.execute(
      { description: 'fix typo' },
      agents,
      { adaptiveDepth },
    );
    assert.equal(result.success, true);
    assert.ok(['quick', 'standard'].includes(result.depthLevel));
  });

  it('should use multi-agent router when provided', async () => {
    const MultiAgentRouter = require(path.join(ROOT, 'src', 'runtime', 'agent', 'multi-agent-router'));
    const orch = _track(new DeepeningOrchestrator());
    const router = _track(new MultiAgentRouter({ topK: 2 }));
    const agents = [
      { id: 'task-worker', execute: async (_task) => ({ output: 'implemented' }) },
      { id: 'quality-assurance', execute: async (_task) => ({ output: 'reviewed' }) },
      { id: 'domain-analyst', execute: async (_task) => ({ output: 'analyzed' }) },
    ];
    const result = await orch.execute(
      { description: '实现并测试功能' },
      agents,
      { multiAgentRouter: router },
    );
    assert.equal(result.success, true);
    assert.ok(result.agentsUsed.length <= 2);
  });

  it('should use output fusion when provided', async () => {
    const OutputFusion = require(path.join(ROOT, 'src', 'runtime', 'collaboration', 'output-fusion'));
    const orch = _track(new DeepeningOrchestrator({ defaultDepthLevel: 'quick' }));
    const fusion = _track(new OutputFusion({ defaultStrategy: 'cascade' }));
    const agents = [
      { id: 'worker-a', execute: async (_task) => ({ code: 'fn()', docs: 'a' }) },
    ];
    const result = await orch.execute(
      { description: 'test' },
      agents,
      { outputFusion: fusion, depthLevel: 'quick' },
    );
    assert.equal(result.success, true);
  });

  it('should emit execution events', async () => {
    const orch = _track(new DeepeningOrchestrator());
    const agents = [{ id: 'worker', execute: async (_task) => ({ output: 'done' }) }];
    const events = [];
    orch.on('execution-start', (e) => events.push({ type: 'start', ...e }));
    orch.on('execution-complete', (e) => events.push({ type: 'complete', ...e }));
    await orch.execute({ description: 'test' }, agents, { depthLevel: 'quick' });
    assert.ok(events.length >= 2);
    assert.equal(events[0].type, 'start');
    assert.equal(events[1].type, 'complete');
  });

  it('should handle agent errors gracefully', async () => {
    const orch = _track(new DeepeningOrchestrator());
    const agents = [{
      id: 'failing-agent',
      execute: async () => { throw new Error('agent failed'); },
    }];
    const result = await orch.execute({ description: 'test' }, agents, { depthLevel: 'quick' });
    assert.equal(result.success, true);
    assert.equal(result.totalAgentCalls, 0);
  });

  it('should track execution log', async () => {
    const orch = _track(new DeepeningOrchestrator());
    const agents = [{ id: 'worker', execute: async (_task) => ({ output: 'done' }) }];
    await orch.execute({ description: 'test' }, agents, { depthLevel: 'quick' });
    const log = orch.getExecutionLog();
    assert.equal(log.length, 1);
  });

  it('should shutdown cleanly', () => {
    const orch = _track(new DeepeningOrchestrator());
    orch.shutdown();
    assert.equal(orch.getStats().totalExecutions, 0);
  });
});

describe('QualityScorer', () => {
  const QualityScorer = require(path.join(ROOT, 'src', 'runtime', 'quality', 'quality-scorer'));

  it('should export dimensions and weights', () => {
    assert.ok(QualityScorer.DIMENSIONS.COMPLETENESS);
    assert.ok(QualityScorer.DIMENSIONS.CORRECTNESS);
    assert.ok(QualityScorer.DIMENSION_WEIGHTS);
  });

  it('should score null result as 0', () => {
    const scorer = _track(new QualityScorer());
    const score = scorer.score(null);
    assert.equal(score.total, 0);
    assert.equal(score.grade, 'failing');
  });

  it('should score successful object result highly', () => {
    const scorer = _track(new QualityScorer());
    const result = { success: true, valid: true, passed: true, description: 'good output', coverage: 0.9 };
    const score = scorer.score(result);
    assert.ok(score.total > 0.5);
    assert.ok(['good', 'excellent', 'acceptable'].includes(score.grade));
  });

  it('should score result with error lower', () => {
    const scorer = _track(new QualityScorer());
    const good = scorer.score({ success: true });
    const bad = scorer.score({ success: true, error: 'something failed' });
    assert.ok(bad.total < good.total);
  });

  it('should score against task requirements', () => {
    const scorer = _track(new QualityScorer());
    const task = { requirements: ['auth', 'security', 'testing'] };
    const result = { auth: 'implemented', security: 'checked', testing: 'covered', description: 'complete' };
    const score = scorer.score(result, task);
    assert.ok(score.total > 0.5);
    assert.ok(score.dimensions.completeness > 0.5);
  });

  it('should assign correct grades', () => {
    const scorer = _track(new QualityScorer());
    const excellent = scorer.score({
      success: true, valid: true, passed: true,
      coverage: 1.0,
      description: 'A comprehensive implementation with full test coverage and all requirements met. The solution includes proper error handling and edge case coverage.',
      status: 'complete',
      metadata: { tests: 50, passed: 50 },
      requirements: ['auth', 'security', 'testing'],
      auth: 'implemented', security: 'verified', testing: 'covered',
    }, { requirements: ['auth', 'security', 'testing'] });
    assert.ok(['excellent', 'good', 'acceptable'].includes(excellent.grade), 'Grade should be at least acceptable, got ' + excellent.grade + ' with score ' + excellent.total);
  });

  it('should emit scored event', () => {
    const scorer = _track(new QualityScorer());
    const events = [];
    scorer.on('scored', (e) => events.push(e));
    scorer.score({ output: 'test' });
    assert.equal(events.length, 1);
    assert.ok(events[0].total !== undefined);
  });

  it('should track history and stats', () => {
    const scorer = _track(new QualityScorer());
    scorer.score({ output: 'a' });
    scorer.score({ output: 'b' });
    const stats = scorer.getStats();
    assert.equal(stats.totalScores, 2);
    assert.ok(stats.averageScore > 0);
    const history = scorer.getHistory(1);
    assert.equal(history.length, 1);
  });

  it('should support custom weights', () => {
    const scorer = _track(new QualityScorer({ weights: { completeness: 1.0, correctness: 0, consistency: 0, coverage: 0, clarity: 0 } }));
    const score = scorer.score({ output: 'test' });
    assert.ok(score.total > 0);
  });

  it('should shutdown cleanly', () => {
    const scorer = _track(new QualityScorer());
    assert.equal(scorer.getStats().totalScores, 0);
    scorer.shutdown();
    assert.equal(scorer.isHealthy(), false);
  });
});

describe('TokenAwareDeepening', () => {
  const TokenAwareDeepening = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'token-aware-deepening'));
  const TokenManager = require(path.join(ROOT, 'src', 'runtime', 'model', 'token-manager'));

  it('should export default constants', () => {
    assert.ok(TokenAwareDeepening.DEFAULT_BUDGET_RATIO > 0);
    assert.ok(TokenAwareDeepening.DEFAULT_MIN_BUDGET_REMAINING > 0);
  });

  it('should calculate max iterations based on budget', () => {
    const tad = _track(new TokenAwareDeepening());
    const tm = _track(new TokenManager());
    const sessionId = 'test-session';
    tm.store(sessionId, 100000);
    const result = tad.calculateMaxIterations(tm, sessionId);
    assert.ok(result.maxIterations >= 1);
    assert.equal(result.reason, 'budget-ok');
  });

  it('should return 1 iteration when budget is critical', () => {
    const tad = _track(new TokenAwareDeepening({ minBudgetRemaining: 0.9 }));
    const tm = _track(new TokenManager());
    const sessionId = 'test-session';
    tm.store(sessionId, 950000000);
    const result = tad.calculateMaxIterations(tm, sessionId);
    assert.equal(result.maxIterations, 1);
    assert.equal(result.reason, 'budget-critical');
  });

  it('should return default when no token manager', () => {
    const tad = _track(new TokenAwareDeepening());
    const result = tad.calculateMaxIterations(null, 'session');
    assert.equal(result.maxIterations, 4);
    assert.equal(result.reason, 'no-token-manager');
  });

  it('should check if iteration is affordable', () => {
    const tad = _track(new TokenAwareDeepening());
    const tm = _track(new TokenManager());
    const sessionId = 'test-session';
    const result = tad.canAffordIteration(tm, sessionId, 1000);
    assert.ok(result.canAfford);
  });

  it('should record iteration cost', () => {
    const tad = _track(new TokenAwareDeepening());
    const record = tad.recordIterationCost('session-1', 1, 5000, 0.8);
    assert.equal(record.sessionId, 'session-1');
    assert.equal(record.tokensUsed, 5000);
    assert.ok(record.efficiency > 0);
  });

  it('should generate efficiency report', () => {
    const tad = _track(new TokenAwareDeepening());
    tad.recordIterationCost('s1', 1, 5000, 0.8);
    tad.recordIterationCost('s1', 2, 3000, 0.9);
    const report = tad.getEfficiencyReport('s1');
    assert.equal(report.totalRecords, 2);
    assert.equal(report.totalTokensUsed, 8000);
    assert.ok(report.averageQuality > 0);
  });

  it('should recommend depth based on budget and complexity', () => {
    const tad = _track(new TokenAwareDeepening());
    const tm = _track(new TokenManager());
    const sessionId = 'test-session';
    const recommendation = tad.recommendDepth(tm, sessionId, 0.8);
    assert.ok(recommendation.recommendedLevel);
    assert.ok(recommendation.maxIterations >= 1);
  });

  it('should emit iteration-cost-recorded event', () => {
    const tad = _track(new TokenAwareDeepening());
    const events = [];
    tad.on('iteration-cost-recorded', (e) => events.push(e));
    tad.recordIterationCost('s1', 1, 5000, 0.8);
    assert.equal(events.length, 1);
  });

  it('should shutdown cleanly', () => {
    const tad = _track(new TokenAwareDeepening());
    tad.shutdown();
    assert.equal(tad.getStats().totalRecords, 0);
  });
});

describe('AffinityLearner', () => {
  const AffinityLearner = require(path.join(ROOT, 'src', 'runtime', 'user', 'affinity-learner'));

  it('should export default constants', () => {
    assert.ok(AffinityLearner.LEARNING_RATE > 0);
    assert.ok(AffinityLearner.DECAY_FACTOR > 0 && AffinityLearner.DECAY_FACTOR < 1);
  });

  it('should record execution and update affinity', () => {
    const learner = _track(new AffinityLearner());
    learner.recordExecution('task-worker', 'implementation', 0.9, 100);
    learner.recordExecution('task-worker', 'implementation', 0.85, 120);
    learner.recordExecution('task-worker', 'implementation', 0.95, 90);
    const affinity = learner.getAffinity('task-worker', 'implementation');
    assert.ok(affinity.score > 0.5);
    assert.equal(affinity.samples, 3);
  });

  it('should return low confidence with insufficient samples', () => {
    const learner = _track(new AffinityLearner({ minSamples: 5 }));
    learner.recordExecution('agent-a', 'testing', 0.9, 100);
    const affinity = learner.getAffinity('agent-a', 'testing');
    assert.equal(affinity.confidence, 'low');
    assert.equal(affinity.samples, 1);
  });

  it('should return default affinity for unknown agent', () => {
    const learner = _track(new AffinityLearner());
    const affinity = learner.getAffinity('unknown-agent', 'unknown-type');
    assert.equal(affinity.score, 0.5);
    assert.equal(affinity.samples, 0);
  });

  it('should provide recommendations sorted by score', () => {
    const learner = _track(new AffinityLearner({ minSamples: 1 }));
    for (let i = 0; i < 5; i++) {
      learner.recordExecution('agent-a', 'implementation', 0.9, 100);
      learner.recordExecution('agent-b', 'implementation', 0.5, 100);
    }
    const recs = learner.getRecommendations('implementation', ['agent-a', 'agent-b']);
    assert.equal(recs.length, 2);
    assert.ok(recs[0].score >= recs[1].score);
    assert.equal(recs[0].agentId, 'agent-a');
  });

  it('should decay affinities over time', () => {
    const learner = _track(new AffinityLearner());
    for (let i = 0; i < 5; i++) {
      learner.recordExecution('agent-a', 'testing', 0.9, 100);
    }
    const before = learner.getAffinity('agent-a', 'testing').score;
    learner.decay();
    const after = learner.getAffinity('agent-a', 'testing').score;
    assert.ok(after < before);
  });

  it('should track agent performance across task types', () => {
    const learner = _track(new AffinityLearner());
    learner.recordExecution('agent-a', 'implementation', 0.9, 100);
    learner.recordExecution('agent-a', 'testing', 0.7, 80);
    const perf = learner.getAgentPerformance('agent-a');
    assert.ok(perf.implementation);
    assert.ok(perf.testing);
    assert.ok(perf.implementation.score > perf.testing.score);
  });

  it('should emit execution-recorded event', () => {
    const learner = _track(new AffinityLearner());
    const events = [];
    learner.on('execution-recorded', (e) => events.push(e));
    learner.recordExecution('agent-a', 'testing', 0.9, 100);
    assert.equal(events.length, 1);
    assert.equal(events[0].agentId, 'agent-a');
  });

  it('should ignore invalid inputs', () => {
    const learner = _track(new AffinityLearner());
    learner.recordExecution(null, 'testing', 0.9, 100);
    learner.recordExecution('agent-a', null, 0.9, 100);
    learner.recordExecution('agent-a', 'testing', 'invalid', 100);
    assert.equal(learner.getStats().totalAffinities, 0);
  });

  it('should track stats correctly', () => {
    const learner = _track(new AffinityLearner());
    learner.recordExecution('agent-a', 'testing', 0.9, 100);
    learner.recordExecution('agent-b', 'implementation', 0.8, 120);
    const stats = learner.getStats();
    assert.equal(stats.knownAgents, 2);
    assert.equal(stats.knownTaskTypes, 2);
    assert.equal(stats.totalAffinities, 2);
  });

  it('should shutdown cleanly', () => {
    const learner = _track(new AffinityLearner());
    learner.shutdown();
    assert.equal(learner.getStats().totalAffinities, 0);
  });

  it('should persist and load affinities from SqliteStore', () => {
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const tmpDir = path.join(os.tmpdir(), 'harness-affinity-test-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const store = new SqliteStore(tmpDir);
    store.init();

    const learner = _track(new AffinityLearner({ minSamples: 1 }));
    learner.attachSqliteStore(store);

    learner.recordExecution('agent-persist', 'testing', 0.9, 100);
    learner.recordExecution('agent-persist', 'testing', 0.85, 120);

    const affinity = learner.getAffinity('agent-persist', 'testing');
    assert.ok(affinity.score > 0.5);

    const records = store.getAllAffinityRecords();
    assert.ok(records.length >= 1);
    const found = records.find(r => r.agent_id === 'agent-persist' && r.task_type === 'testing');
    assert.ok(found);
    assert.ok(found.score > 0.5);

    const learner2 = _track(new AffinityLearner({ minSamples: 1 }));
    learner2.attachSqliteStore(store);
    const loaded = learner2.getAffinity('agent-persist', 'testing');
    assert.ok(loaded.score > 0.5);

    learner.shutdown();
    learner2.shutdown();
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should report hasPersistentStore in stats', () => {
    const learner = _track(new AffinityLearner());
    assert.equal(learner.getStats().hasPersistentStore, false);

    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const tmpDir = path.join(os.tmpdir(), 'harness-affinity-stats-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const store = new SqliteStore(tmpDir);
    store.init();
    learner.attachSqliteStore(store);
    assert.equal(learner.getStats().hasPersistentStore, true);

    learner.shutdown();
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('Integration: Second-wave modules with framework', () => {
  it('should create framework with all second-wave modules', async () => {
    const { create } = require(path.join(ROOT, 'src', 'index'));
    const instance = create(ROOT);
    assert.ok(instance.deepeningOrchestrator);
    assert.ok(instance.qualityScorer);
    assert.ok(instance.tokenAwareDeepening);
    assert.ok(instance.affinityLearner);
    await instance.destroy();
  });

  it('should register health checks for second-wave modules', async () => {
    const { create } = require(path.join(ROOT, 'src', 'index'));
    const instance = create(ROOT);
    const result = await instance.healthChecker.checkAll();
    const checks = Object.values(result.checks);
    const secondWave = checks.filter(c =>
      c.name === 'deepening-orchestrator' ||
      c.name === 'quality-scorer' ||
      c.name === 'token-aware-deepening' ||
      c.name === 'affinity-learner',
    );
    assert.equal(secondWave.length, 4);
    for (const check of secondWave) {
      assert.equal(check.status, 'healthy', `${check.name} should be healthy`);
    }
    await instance.destroy();
  });

  it('should export second-wave modules from package', () => {
    const pkg = require(path.join(ROOT, 'src', 'index'));
    assert.ok(pkg.DeepeningOrchestrator);
    assert.ok(pkg.QualityScorer);
    assert.ok(pkg.TokenAwareDeepening);
    assert.ok(pkg.AffinityLearner);
  });

  it('should integrate quality scorer with iterative refinement', async () => {
    const QualityScorer = require(path.join(ROOT, 'src', 'runtime', 'quality', 'quality-scorer'));
    const IterativeRefinement = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'iterative-refinement'));

    const scorer = _track(new QualityScorer());
    const refinement = _track(new IterativeRefinement({ maxRefinements: 3, qualityThreshold: 0.5 }));

    let callCount = 0;
    const executor = {
      execute: async (_task) => {
        callCount++;
        return { output: `This is a detailed result with sufficient content for quality scoring, iteration ${callCount}`, success: true };
      },
    };

    const reviewer = async (result, _task) => {
      const score = scorer.score(result);
      return { qualityScore: score.total, approved: score.total >= 0.5, feedback: score.grade };
    };

    const result = await refinement.refine(executor, { description: 'test' }, reviewer);
    assert.ok(typeof result.success === 'boolean');
    assert.ok(result.rounds >= 1);
  });

  it('should integrate affinity learner with multi-agent router', () => {
    const AffinityLearner = require(path.join(ROOT, 'src', 'runtime', 'user', 'affinity-learner'));
    const MultiAgentRouter = require(path.join(ROOT, 'src', 'runtime', 'agent', 'multi-agent-router'));

    const learner = _track(new AffinityLearner({ minSamples: 1 }));
    const router = _track(new MultiAgentRouter({ topK: 2 }));

    for (let i = 0; i < 5; i++) {
      learner.recordExecution('task-worker', 'implementation', 0.9, 100);
      learner.recordExecution('domain-analyst', 'implementation', 0.6, 150);
    }

    const recs = learner.getRecommendations('implementation', ['task-worker', 'domain-analyst']);
    assert.ok(recs[0].agentId === 'task-worker');

    const routing = router.route({ description: '实现功能' });
    assert.ok(routing.agents.length > 0);
  });

  it('should integrate token-aware deepening with progressive deepening', async () => {
    const TokenAwareDeepening = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'token-aware-deepening'));
    const TokenManager = require(path.join(ROOT, 'src', 'runtime', 'model', 'token-manager'));
    const ProgressiveDeepening = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'progressive-deepening'));

    const tad = _track(new TokenAwareDeepening());
    const tm = _track(new TokenManager());
    const pd = _track(new ProgressiveDeepening());

    const sessionId = 'test-session';
    tm.store(sessionId, 100000);

    const recommendation = tad.recommendDepth(tm, sessionId, 0.5);
    const agent = { execute: async (_task) => ({ output: 'done' }) };
    const result = await pd.execute(agent, { description: 'test' }, recommendation.recommendedLevel);
    assert.equal(result.success, true);
  });

  it('should serve deepening stats via web API', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    delete process.env.HARNESS_API_TOKEN;
    const { create } = require(path.join(ROOT, 'src', 'index'));
    const instance = create(ROOT);

    const DashboardServer = require(path.join(ROOT, 'src', 'web', 'server'));
    const server = new DashboardServer(ROOT, 0, instance);
    await new Promise((resolve) => {
      server.start(() => resolve());
    });

    const port = server.server.address().port;
    const http = require('http');

    const fetchApi = (apiPath) => new Promise((resolve, reject) => {
      const req = http.get('http://localhost:' + port + apiPath, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (_e) { reject(_e); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    });

    try {
      const stats = await fetchApi('/api/deepening/stats');
      assert.ok(stats.modules);
      assert.ok(stats.modules.recurrentDeepening);

      const quality = await fetchApi('/api/deepening/quality');
      assert.ok(quality.stats);

      const budget = await fetchApi('/api/deepening/token-budget');
      assert.ok(budget.stats);

      const affinities = await fetchApi('/api/deepening/affinities');
      assert.ok(affinities.stats);
    } finally {
      server.stop();
      process.env.NODE_ENV = origNodeEnv;
      if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
      else delete process.env.HARNESS_API_TOKEN;
      await instance.destroy();
    }
  });
});
