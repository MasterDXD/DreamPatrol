'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

describe('DeepeningMetricsCollector', () => {
  const DeepeningMetricsCollector = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-metrics-collector'));

  it('should export METRIC_TYPES', () => {
    assert.ok(DeepeningMetricsCollector.METRIC_TYPES);
    assert.ok(DeepeningMetricsCollector.METRIC_TYPES.QUALITY_SCORE);
    assert.ok(DeepeningMetricsCollector.METRIC_TYPES.CONVERGENCE_RATE);
    assert.ok(DeepeningMetricsCollector.METRIC_TYPES.ITERATION_DURATION);
  });

  it('should record metrics', () => {
    const collector = new DeepeningMetricsCollector();
    const result = collector.record(DeepeningMetricsCollector.METRIC_TYPES.QUALITY_SCORE, 0.85, { executionId: 'test-1' });
    assert.ok(result);
    const stats = collector.getStats();
    assert.equal(stats.totalMetrics, 1);
  });

  it('should reject invalid metric records', () => {
    const collector = new DeepeningMetricsCollector();
    assert.equal(collector.record('', 0.5), false);
    assert.equal(collector.record('test', 'not-a-number'), false);
    assert.equal(collector.record(null, 0.5), false);
  });

  it('should record iteration data', () => {
    const collector = new DeepeningMetricsCollector();
    collector.recordIteration('exec-1', {
      iteration: 1,
      qualityScore: 0.75,
      duration: 1500,
      tokensUsed: 5000,
    });
    const stats = collector.getStats();
    assert.ok(stats.totalMetrics >= 3);
  });

  it('should record convergence data', () => {
    const collector = new DeepeningMetricsCollector();
    collector.recordConvergence('exec-1', {
      converged: true,
      reason: 'quality-threshold-met',
      signals: { qualityScore: { value: 0.9, passed: true } },
    });
    const series = collector.getTimeSeries(DeepeningMetricsCollector.METRIC_TYPES.CONVERGENCE_RATE);
    assert.ok(series.length > 0);
    assert.equal(series[0].value, 1);
  });

  it('should record agent performance', () => {
    const collector = new DeepeningMetricsCollector();
    collector.recordAgentPerformance('agent-1', { score: 0.88, executionTime: 2000 });
    const series = collector.getTimeSeries(DeepeningMetricsCollector.METRIC_TYPES.AGENT_PERFORMANCE);
    assert.ok(series.length > 0);
    assert.equal(series[0].value, 0.88);
  });

  it('should compute aggregates', () => {
    const collector = new DeepeningMetricsCollector();
    collector.record('test-metric', 0.5);
    collector.record('test-metric', 0.8);
    collector.record('test-metric', 0.3);
    const agg = collector.getAggregates('test-metric');
    assert.ok(agg);
    assert.equal(agg.count, 3);
    assert.equal(agg.min, 0.3);
    assert.equal(agg.max, 0.8);
    assert.ok(agg.average > 0);
  });

  it('should compute histograms with percentiles', () => {
    const collector = new DeepeningMetricsCollector();
    for (let i = 0; i < 20; i++) {
      collector.record('latency', Math.random() * 100);
    }
    const hist = collector.getHistogram('latency');
    assert.ok(hist);
    assert.ok(hist.buckets);
    assert.ok(typeof hist.buckets.p50 === 'number');
    assert.ok(typeof hist.buckets.p95 === 'number');
  });

  it('should filter time series by tags', () => {
    const collector = new DeepeningMetricsCollector();
    collector.record('score', 0.7, { executionId: 'e1' });
    collector.record('score', 0.8, { executionId: 'e2' });
    collector.record('score', 0.9, { executionId: 'e1' });
    const filtered = collector.getTimeSeries('score', { tags: { executionId: 'e1' } });
    assert.equal(filtered.length, 2);
  });

  it('should get dashboard data', () => {
    const collector = new DeepeningMetricsCollector();
    collector.record(DeepeningMetricsCollector.METRIC_TYPES.QUALITY_SCORE, 0.85);
    collector.record(DeepeningMetricsCollector.METRIC_TYPES.CONVERGENCE_RATE, 1);
    const dashboard = collector.getDashboard();
    assert.ok(typeof dashboard.uptime === 'number');
    assert.ok(dashboard.totalMetrics > 0);
    assert.ok(typeof dashboard.convergenceRate === 'number');
  });

  it('should reset and shutdown cleanly', () => {
    const collector = new DeepeningMetricsCollector();
    collector.record('test', 0.5);
    collector.reset();
    assert.equal(collector.getStats().totalMetrics, 0);
    collector.shutdown();
    assert.ok(!collector.isHealthy());
  });
});

describe('DeepeningCache', () => {
  const DeepeningCache = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-cache'));

  it('should store and retrieve results', () => {
    const cache = new DeepeningCache();
    const task = { id: 'task-1', type: 'test', description: 'test task', requirements: ['req1'] };
    const result = { success: true, data: 'test' };
    cache.store(task, result, { qualityScore: 0.85, iteration: 1, agentId: 'agent-1' });
    const retrieved = cache.retrieve(task);
    assert.ok(retrieved);
    assert.deepEqual(retrieved.result, result);
    assert.equal(retrieved.qualityScore, 0.85);
  });

  it('should return null for missing tasks', () => {
    const cache = new DeepeningCache();
    const result = cache.retrieve({ id: 'missing', description: 'not found' });
    assert.equal(result, null);
  });

  it('should update entry when quality improves', () => {
    const cache = new DeepeningCache();
    const task = { id: 'task-1', type: 'test', description: 'test' };
    cache.store(task, { v: 1 }, { qualityScore: 0.5 });
    cache.store(task, { v: 2 }, { qualityScore: 0.9 });
    const retrieved = cache.retrieve(task);
    assert.equal(retrieved.result.v, 2);
  });

  it('should not update entry when quality is lower', () => {
    const cache = new DeepeningCache();
    const task = { id: 'task-1', type: 'test', description: 'test' };
    cache.store(task, { v: 1 }, { qualityScore: 0.9 });
    cache.store(task, { v: 2 }, { qualityScore: 0.5 });
    const retrieved = cache.retrieve(task);
    assert.equal(retrieved.result.v, 1);
  });

  it('should invalidate entries', () => {
    const cache = new DeepeningCache();
    const task = { id: 'task-1', type: 'test', description: 'test' };
    cache.store(task, { data: 'test' });
    assert.ok(cache.invalidate(task));
    assert.equal(cache.retrieve(task), null);
  });

  it('should invalidate by pattern', () => {
    const cache = new DeepeningCache();
    cache.store({ id: 't1', type: 'test', description: 'a' }, { data: 1 }, { qualityScore: 0.5, agentId: 'agent-a' });
    cache.store({ id: 't2', type: 'test', description: 'b' }, { data: 2 }, { qualityScore: 0.9, agentId: 'agent-b' });
    const count = cache.invalidateByPattern({ agentId: 'agent-a' });
    assert.equal(count, 1);
  });

  it('should track stats', () => {
    const cache = new DeepeningCache();
    const task = { id: 'task-1', type: 'test', description: 'test' };
    cache.store(task, { data: 'test' });
    cache.retrieve(task);
    cache.retrieve({ id: 'missing', description: 'not found' });
    const stats = cache.getStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.ok(stats.hitRate > 0);
  });

  it('should enforce max size', () => {
    const cache = new DeepeningCache({ maxSize: 3 });
    for (let i = 0; i < 5; i++) {
      cache.store({ id: 'task-' + i, type: 'test', description: 'task ' + i }, { data: i });
    }
    const stats = cache.getStats();
    assert.ok(stats.size <= 3);
    assert.ok(stats.evictions > 0);
  });

  it('should list entries sorted by quality', () => {
    const cache = new DeepeningCache();
    cache.store({ id: 't1', type: 'test', description: 'a' }, { data: 1 }, { qualityScore: 0.5 });
    cache.store({ id: 't2', type: 'test', description: 'b' }, { data: 2 }, { qualityScore: 0.9 });
    cache.store({ id: 't3', type: 'test', description: 'c' }, { data: 3 }, { qualityScore: 0.7 });
    const entries = cache.getEntries();
    assert.equal(entries[0].qualityScore, 0.9);
  });

  it('should reject invalid inputs', () => {
    const cache = new DeepeningCache();
    assert.equal(cache.store(null, { data: 1 }), false);
    assert.equal(cache.store({ id: 't1' }, null), false);
    assert.equal(cache.retrieve(null), null);
  });

  it('should clear and shutdown', () => {
    const cache = new DeepeningCache();
    cache.store({ id: 't1', type: 'test', description: 'test' }, { data: 1 });
    cache.clear();
    assert.equal(cache.getStats().size, 0);
    cache.shutdown();
    assert.strictEqual(cache.isHealthy(), false);
  });
});

describe('DeepeningStrategyPlugin', () => {
  const DeepeningStrategyPlugin = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-strategy-plugin'));

  it('should export STRATEGY_TYPES', () => {
    assert.ok(DeepeningStrategyPlugin.STRATEGY_TYPES);
    assert.ok(DeepeningStrategyPlugin.STRATEGY_TYPES.FIXED_DEPTH);
    assert.ok(DeepeningStrategyPlugin.STRATEGY_TYPES.ADAPTIVE);
    assert.ok(DeepeningStrategyPlugin.STRATEGY_TYPES.CONVERGENCE_DRIVEN);
    assert.ok(DeepeningStrategyPlugin.STRATEGY_TYPES.BUDGET_AWARE);
    assert.ok(DeepeningStrategyPlugin.STRATEGY_TYPES.QUALITY_OPTIMIZED);
  });

  it('should make fixed-depth decisions', async () => {
    const plugin = new DeepeningStrategyPlugin('fixed', {
      type: 'fixed-depth',
      maxIterations: 3,
      depthLevel: 'standard',
    });
    const d1 = await plugin.decide({ iteration: 0 });
    assert.ok(d1.shouldContinue);
    const d2 = await plugin.decide({ iteration: 3 });
    assert.ok(!d2.shouldContinue);
  });

  it('should make adaptive decisions', async () => {
    const plugin = new DeepeningStrategyPlugin('adaptive', {
      type: 'adaptive',
      maxIterations: 6,
      qualityThreshold: 0.85,
    });
    const d1 = await plugin.decide({ iteration: 0, qualityScore: 0.3, improvementRate: 0.1 });
    assert.ok(d1.shouldContinue);
    assert.equal(d1.depthLevel, 'intensive');
    const d2 = await plugin.decide({ iteration: 2, qualityScore: 0.9, improvementRate: 0.01 });
    assert.ok(!d2.shouldContinue);
  });

  it('should make convergence-driven decisions', async () => {
    const plugin = new DeepeningStrategyPlugin('conv', {
      type: 'convergence-driven',
      maxIterations: 10,
    });
    const d1 = await plugin.decide({ iteration: 0, convergenceStatus: { converged: false } });
    assert.ok(d1.shouldContinue);
    const d2 = await plugin.decide({ iteration: 3, convergenceStatus: { converged: true, reason: 'quality-threshold-met' } });
    assert.ok(!d2.shouldContinue);
    assert.equal(d2.reason, 'quality-threshold-met');
  });

  it('should make budget-aware decisions', async () => {
    const plugin = new DeepeningStrategyPlugin('budget', {
      type: 'budget-aware',
      maxIterations: 4,
    });
    const d1 = await plugin.decide({ iteration: 0, tokensRemaining: 800000, tokensBudget: 1000000 });
    assert.ok(d1.shouldContinue);
    assert.equal(d1.depthLevel, 'deep');
    const d2 = await plugin.decide({ iteration: 2, tokensRemaining: 50000, tokensBudget: 1000000 });
    assert.ok(!d2.shouldContinue);
    assert.equal(d2.reason, 'budget-exhausted');
  });

  it('should make quality-optimized decisions', async () => {
    const plugin = new DeepeningStrategyPlugin('quality', {
      type: 'quality-optimized',
      maxIterations: 5,
      qualityThreshold: 0.9,
    });
    const d1 = await plugin.decide({ iteration: 0, qualityScore: 0.5, previousScores: [0.3, 0.5] });
    assert.ok(d1.shouldContinue);
    const d2 = await plugin.decide({ iteration: 3, qualityScore: 0.95, previousScores: [0.7, 0.85, 0.92, 0.95] });
    assert.ok(!d2.shouldContinue);
  });

  it('should return null when disabled', async () => {
    const plugin = new DeepeningStrategyPlugin('disabled', { enabled: false });
    const d = await plugin.decide({ iteration: 0 });
    assert.equal(d, null);
  });

  it('should track stats', async () => {
    const plugin = new DeepeningStrategyPlugin('test', { type: 'fixed-depth', maxIterations: 2 });
    await plugin.decide({ iteration: 0 });
    await plugin.decide({ iteration: 3 });
    const stats = plugin.getStats();
    assert.equal(stats.executionCount, 2);
    assert.equal(stats.successCount, 1);
  });
});

describe('DeepeningReportGenerator', () => {
  const DeepeningReportGenerator = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-report-generator'));

  it('should export REPORT_TYPES', () => {
    assert.ok(DeepeningReportGenerator.REPORT_TYPES);
    assert.ok(DeepeningReportGenerator.REPORT_TYPES.EXECUTION_SUMMARY);
    assert.ok(DeepeningReportGenerator.REPORT_TYPES.FULL_REPORT);
  });

  it('should generate execution summary report', () => {
    const gen = new DeepeningReportGenerator();
    const report = gen.generate(DeepeningReportGenerator.REPORT_TYPES.EXECUTION_SUMMARY, {
      executions: [
        { success: true, bestScore: 0.85, duration: 1000, iterations: 3, depthLevel: 'deep' },
        { success: true, bestScore: 0.92, duration: 800, iterations: 2, depthLevel: 'standard' },
      ],
    });
    assert.ok(report);
    assert.equal(report.totalExecutions, 2);
    assert.equal(report.successfulExecutions, 2);
    assert.ok(report.averageScore > 0);
  });

  it('should generate quality trend report', () => {
    const gen = new DeepeningReportGenerator();
    const report = gen.generate(DeepeningReportGenerator.REPORT_TYPES.QUALITY_TREND, {
      qualityScores: [0.5, 0.65, 0.78, 0.85, 0.9],
    });
    assert.ok(report);
    assert.equal(report.dataPoints, 5);
    assert.ok(report.improvement > 0);
    assert.ok(report.peakScore > 0);
  });

  it('should generate convergence analysis report', () => {
    const gen = new DeepeningReportGenerator();
    const report = gen.generate(DeepeningReportGenerator.REPORT_TYPES.CONVERGENCE_ANALYSIS, {
      convergenceResults: [
        { converged: true, reason: 'quality-threshold-met', iteration: 3 },
        { converged: true, reason: 'plateau-detected', iteration: 5 },
        { converged: false, reason: 'not-converged', iteration: 10 },
      ],
    });
    assert.ok(report);
    assert.equal(report.totalChecks, 3);
    assert.equal(report.convergedCount, 2);
    assert.ok(report.convergenceRate > 0);
  });

  it('should generate agent performance report', () => {
    const gen = new DeepeningReportGenerator();
    const report = gen.generate(DeepeningReportGenerator.REPORT_TYPES.AGENT_PERFORMANCE, {
      agentResults: [
        { agentId: 'agent-1', score: 0.85, duration: 500 },
        { agentId: 'agent-2', score: 0.72, duration: 800 },
        { agentId: 'agent-1', score: 0.9, duration: 450 },
      ],
    });
    assert.ok(report);
    assert.equal(report.agentCount, 2);
    assert.ok(report.agents['agent-1']);
    assert.ok(report.agents['agent-2']);
  });

  it('should generate token efficiency report', () => {
    const gen = new DeepeningReportGenerator();
    const report = gen.generate(DeepeningReportGenerator.REPORT_TYPES.TOKEN_EFFICIENCY, {
      tokenUsages: [
        { tokensUsed: 5000 },
        { tokensUsed: 3000 },
      ],
      totalBudget: 1000000,
    });
    assert.ok(report);
    assert.equal(report.totalTokensUsed, 8000);
    assert.ok(report.budgetUtilization > 0);
  });

  it('should generate full report', () => {
    const gen = new DeepeningReportGenerator();
    const report = gen.generate(DeepeningReportGenerator.REPORT_TYPES.FULL_REPORT, {
      executions: [{ success: true, bestScore: 0.85 }],
      qualityScores: [0.5, 0.85],
      convergenceResults: [{ converged: true, reason: 'quality-threshold-met', iteration: 2 }],
      agentResults: [{ agentId: 'a1', score: 0.85 }],
      tokenUsages: [{ tokensUsed: 5000 }],
    });
    assert.ok(report);
    assert.ok(report.executionSummary);
    assert.ok(report.qualityTrend);
    assert.ok(report.convergenceAnalysis);
    assert.ok(report.agentPerformance);
    assert.ok(report.tokenEfficiency);
  });

  it('should track report history', () => {
    const gen = new DeepeningReportGenerator();
    gen.generate(DeepeningReportGenerator.REPORT_TYPES.EXECUTION_SUMMARY, { executions: [] });
    gen.generate(DeepeningReportGenerator.REPORT_TYPES.QUALITY_TREND, { qualityScores: [] });
    const history = gen.getReportHistory();
    assert.equal(history.length, 2);
  });

  it('should return null for invalid inputs', () => {
    const gen = new DeepeningReportGenerator();
    assert.equal(gen.generate(null, {}), null);
    assert.equal(gen.generate('test', null), null);
  });
});

describe('WorkflowDAG Deepening Integration', () => {
  const WorkflowDAG = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'workflow-dag'));

  it('should add deepening nodes to DAG', () => {
    const dag = new WorkflowDAG();
    dag.addNode('step-1', { phase: 'module-development', agent: 'worker', skill: 'tdd-implement' });
    dag.addNode('step-2', { phase: 'module-development', agent: 'analyst', skill: 'code-review' });
    dag.addEdge('step-1', 'step-2');

    const deepeningId = dag.addDeepeningNode('step-1', {
      iteration: 1,
      depthLevel: 'deep',
      qualityScore: 0.75,
    });

    assert.ok(deepeningId);
    assert.ok(deepeningId.startsWith('step-1-deepen-'));

    const deepeningNode = dag.getNode(deepeningId);
    assert.ok(deepeningNode);
    assert.ok(deepeningNode.deepening);
    assert.equal(deepeningNode.deepening.parentId, 'step-1');
    assert.equal(deepeningNode.deepening.iteration, 1);
    assert.equal(deepeningNode.skill, 'iterative-deepening');
  });

  it('should rewire edges when adding deepening node', () => {
    const dag = new WorkflowDAG();
    dag.addNode('step-1', { phase: 'dev', agent: 'worker', skill: 'implement' });
    dag.addNode('step-2', { phase: 'dev', agent: 'reviewer', skill: 'review' });
    dag.addEdge('step-1', 'step-2');

    const deepeningId = dag.addDeepeningNode('step-1', { iteration: 1 });

    const edges = dag.getEdges();
    const step1ToDeepening = edges.some(e => e.from === 'step-1' && e.to === deepeningId);
    const deepeningToStep2 = edges.some(e => e.from === deepeningId && e.to === 'step-2');
    const step1ToStep2 = edges.some(e => e.from === 'step-1' && e.to === 'step-2');

    assert.ok(step1ToDeepening);
    assert.ok(deepeningToStep2);
    assert.ok(!step1ToStep2);
  });

  it('should get deepening nodes by parent', () => {
    const dag = new WorkflowDAG();
    dag.addNode('step-1', { phase: 'dev', agent: 'worker', skill: 'impl' });
    dag.addNode('step-2', { phase: 'dev', agent: 'worker', skill: 'impl' });
    const d1 = dag.addDeepeningNode('step-1', { iteration: 1 });
    dag.addDeepeningNode(d1, { iteration: 2 });
    dag.addDeepeningNode('step-2', { iteration: 1 });

    const step1Deepening = dag.getDeepeningNodes('step-1');
    assert.equal(step1Deepening.length, 1);

    const allDeepening = dag.getDeepeningNodes();
    assert.equal(allDeepening.length, 3);
  });

  it('should get deepening chain', () => {
    const dag = new WorkflowDAG();
    dag.addNode('step-1', { phase: 'dev', agent: 'worker', skill: 'impl' });
    const d1 = dag.addDeepeningNode('step-1', { iteration: 1 });
    dag.addDeepeningNode(d1, { iteration: 2 });

    const chain = dag.getDeepeningChain('step-1');
    assert.ok(chain.length >= 1);
  });

  it('should get deepening stats', () => {
    const dag = new WorkflowDAG();
    dag.addNode('step-1', { phase: 'dev', agent: 'worker', skill: 'impl' });
    dag.addNode('step-2', { phase: 'dev', agent: 'worker', skill: 'impl' });
    dag.addDeepeningNode('step-1', { iteration: 1, iterationCount: 1 });
    dag.addDeepeningNode('step-2', { iteration: 1, iterationCount: 2 });

    const stats = dag.getDeepeningStats();
    assert.equal(stats.totalDeepeningNodes, 2);
    assert.equal(stats.totalDeepenedTasks, 2);
  });

  it('should return null for invalid parent in addDeepeningNode', () => {
    const dag = new WorkflowDAG();
    assert.equal(dag.addDeepeningNode('nonexistent', { iteration: 1 }), null);
  });

  it('should remove edges', () => {
    const dag = new WorkflowDAG();
    dag.addNode('a', { phase: 'dev', agent: 'w', skill: 's' });
    dag.addNode('b', { phase: 'dev', agent: 'w', skill: 's' });
    dag.addEdge('a', 'b');
    assert.ok(dag.removeEdge('a', 'b'));
    assert.ok(!dag.removeEdge('a', 'b'));
  });

  it('should emit deepening-node-added event', () => {
    const dag = new WorkflowDAG();
    let eventData = null;
    dag.addNode('step-1', { phase: 'dev', agent: 'worker', skill: 'impl' });
    dag.on('deepening-node-added', (data) => {
      eventData = data;
    });
    dag.addDeepeningNode('step-1', { iteration: 1 });
    assert.ok(eventData);
    assert.equal(eventData.parentId, 'step-1');
    assert.ok(eventData.deepeningId);
  });
});

describe('WorkflowDAG regression: getReadyNodes side effects', () => {
  const WorkflowDAG = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'workflow-dag'));

  it('should not modify node status when calling getReadyNodes', () => {
    const dag = new WorkflowDAG();
    dag.addNode('a', { phase: 'dev', agent: 'w', skill: 's' });
    dag.addNode('b', { phase: 'dev', agent: 'w', skill: 's' });
    dag.addEdge('a', 'b');
    const beforeA = dag.getNode('a').status;
    const beforeB = dag.getNode('b').status;
    const result = dag.getReadyNodes();
    assert.ok(Array.isArray(result.ready));
    assert.ok(Array.isArray(result.dependencyFailed));
    assert.equal(dag.getNode('a').status, beforeA);
    assert.equal(dag.getNode('b').status, beforeB);
  });

  it('should return dependencyFailed without modifying state', () => {
    const dag = new WorkflowDAG();
    dag.addNode('a', { phase: 'dev', agent: 'w', skill: 's' });
    dag.addNode('b', { phase: 'dev', agent: 'w', skill: 's' });
    dag.addEdge('a', 'b');
    dag.startNode('a');
    dag.failNode('a', 'error');
    const beforeB = dag.getNode('b').status;
    const result = dag.getReadyNodes();
    assert.ok(result.dependencyFailed.includes('b'));
    assert.equal(dag.getNode('b').status, beforeB);
  });
});

describe('Dashboard Deepening API Endpoints', () => {
  const DashboardServer = require(path.join(ROOT, 'src', 'web', 'server'));
  const http = require('http');
  let server;
  let port;
  let origNodeEnv;
  let origApiToken;

  before(async () => {
    origNodeEnv = process.env.NODE_ENV;
    origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    port = 0;
    server = new DashboardServer(ROOT, port);
    await server.start();
    port = server.port;
  });

  after(() => {
    process.env.NODE_ENV = origNodeEnv;
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    server.stop();
  });

  function fetchJson(urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.get('http://localhost:' + port + urlPath, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, data }); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    });
  }

  it('should serve deepening dashboard endpoint', async () => {
    const res = await fetchJson('/api/deepening/dashboard');
    assert.equal(res.status, 200);
    assert.ok(res.data);
    assert.ok(res.data.modules);
    assert.ok(res.data.metrics);
    assert.ok(res.data.cache);
  });

  it('should serve deepening metrics endpoint', async () => {
    const res = await fetchJson('/api/deepening/metrics');
    assert.equal(res.status, 200);
    assert.ok(res.data);
    assert.ok(res.data.stats);
    assert.ok(res.data.dashboard);
  });

  it('should serve deepening cache endpoint', async () => {
    const res = await fetchJson('/api/deepening/cache');
    assert.equal(res.status, 200);
    assert.ok(res.data);
    assert.ok(res.data.stats);
    assert.ok(Array.isArray(res.data.entries));
  });

  it('should serve deepening convergence endpoint', async () => {
    const res = await fetchJson('/api/deepening/convergence');
    assert.equal(res.status, 200);
    assert.ok(res.data);
    assert.ok(res.data.stats);
  });

  it('should serve deepening report endpoint', async () => {
    const res = await fetchJson('/api/deepening/report');
    assert.equal(res.status, 200);
    assert.ok(res.data);
    assert.ok(res.data.stats);
    assert.ok(Array.isArray(res.data.history));
  });
});
