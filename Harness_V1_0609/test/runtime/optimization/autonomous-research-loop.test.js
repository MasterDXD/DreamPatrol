'use strict';

/**
 * 自主研究闭环模块测试。覆盖 AutonomousResearchLoop、ExperimentSandbox、ResearchDomainAdapter 的核心功能。
 * 测试场景包括：七阶段闭环执行、实验沙箱创建与执行、领域适配与假设生成、多领域并行研究。
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ExperimentSandbox = require('../../../src/runtime/optimization/experiment-sandbox');
const { EXPERIMENT_STATUS } = require('../../../src/runtime/optimization/experiment-sandbox');
const ResearchDomainAdapter = require('../../../src/runtime/optimization/research-domain-adapter');
const { RESEARCH_DOMAINS, DOMAIN_META } = require('../../../src/runtime/optimization/research-domain-adapter');
const AutonomousResearchLoop = require('../../../src/runtime/optimization/autonomous-research-loop');
const { LOOP_STAGES, LOOP_STATUS } = require('../../../src/runtime/optimization/autonomous-research-loop');

// =========================== ExperimentSandbox 测试 ===========================

describe('ExperimentSandbox', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = new ExperimentSandbox({ maxConcurrentExperiments: 3, defaultTimeoutMs: 5000 });
  });

  afterEach(() => {
    if (sandbox && sandbox.isHealthy()) sandbox.shutdown();
  });

  describe('Constructor', () => {
    it('should create instance with default options', () => {
      const sb = new ExperimentSandbox();
      assert.ok(sb);
      assert.ok(sb.isHealthy());
      assert.strictEqual(sb._options.maxConcurrentExperiments, 5);
      assert.strictEqual(sb._options.defaultTimeoutMs, 60000);
      assert.strictEqual(sb._options.enableCodeGeneration, true);
    });

    it('should merge custom options', () => {
      const sb = new ExperimentSandbox({ maxConcurrentExperiments: 2, defaultTimeoutMs: 30000 });
      assert.strictEqual(sb._options.maxConcurrentExperiments, 2);
      assert.strictEqual(sb._options.defaultTimeoutMs, 30000);
    });

    it('should expose EXPERIMENT_STATUS static property', () => {
      assert.strictEqual(EXPERIMENT_STATUS.CREATED, 'created');
      assert.strictEqual(EXPERIMENT_STATUS.RUNNING, 'running');
      assert.strictEqual(EXPERIMENT_STATUS.COMPLETED, 'completed');
      assert.strictEqual(EXPERIMENT_STATUS.FAILED, 'failed');
      assert.strictEqual(EXPERIMENT_STATUS.TIMEOUT, 'timeout');
      assert.strictEqual(EXPERIMENT_STATUS.CANCELLED, 'cancelled');
    });
  });

  describe('createExperiment', () => {
    it('should create experiment with domain', () => {
      const result = sandbox.createExperiment({
        domain: 'content',
        hypothesisId: 'hyp-001',
        parameters: { variants: ['A', 'B'], metrics: ['clickRate'] },
      });
      assert.strictEqual(result.success, true);
      assert.ok(result.experimentId);
      assert.ok(result.experimentId.startsWith('exp-'));
    });

    it('should reject experiment without domain', () => {
      const result = sandbox.createExperiment({ hypothesisId: 'hyp-001' });
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    it('should generate code for experiment', () => {
      const result = sandbox.createExperiment({
        domain: 'content',
        parameters: { variants: ['A', 'B'], metrics: ['clickRate'] },
      });
      const exp = sandbox.getExperiment(result.experimentId);
      assert.ok(exp);
      assert.ok(exp.code);
      assert.ok(exp.code.includes('content'));
    });

    it('should reject when max concurrent reached', () => {
      const sb = new ExperimentSandbox({ maxConcurrentExperiments: 1 });
      sb.createExperiment({ domain: 'content' });
      const result = sb.createExperiment({ domain: 'operations' });
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Max concurrent'));
      sb.shutdown();
    });

    it('should track experiment status as CREATED', () => {
      const result = sandbox.createExperiment({ domain: 'content' });
      const exp = sandbox.getExperiment(result.experimentId);
      assert.strictEqual(exp.status, EXPERIMENT_STATUS.CREATED);
    });
  });

  describe('startExperiment', () => {
    it('should execute and complete experiment', async () => {
      const createResult = sandbox.createExperiment({ domain: 'content', parameters: { variants: ['A', 'B'] } });
      const expResult = await sandbox.startExperiment(createResult.experimentId);
      assert.strictEqual(expResult.success, true);
      const exp = sandbox.getExperiment(createResult.experimentId);
      assert.strictEqual(exp, null); // 已归档
    });

    it('should fail for unknown experiment', async () => {
      const result = await sandbox.startExperiment('unknown-id');
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    it('should run content experiment with variants', async () => {
      const createResult = sandbox.createExperiment({
        domain: 'content',
        parameters: { variants: ['A', 'B', 'C'], metrics: ['engagement', 'clickRate'] },
      });
      const result = await sandbox.startExperiment(createResult.experimentId);
      assert.strictEqual(result.success, true);
    });

    it('should run operations experiment', async () => {
      const createResult = sandbox.createExperiment({
        domain: 'operations',
        parameters: { strategy: 'new_strategy', baseline: { responseTime: 100 }, targetMetrics: ['responseTime'] },
      });
      const result = await sandbox.startExperiment(createResult.experimentId);
      assert.strictEqual(result.success, true);
    });

    it('should run ml_research experiment', async () => {
      const createResult = sandbox.createExperiment({
        domain: 'ml_research',
        parameters: { modelConfig: { layers: 3 }, hyperparameterVariants: [{ learningRate: 0.001 }] },
      });
      const result = await sandbox.startExperiment(createResult.experimentId);
      assert.strictEqual(result.success, true);
    });

    it('should run workflow experiment', async () => {
      const createResult = sandbox.createExperiment({
        domain: 'workflow',
        parameters: { currentFlow: ['step1', 'step2', 'step3'], proposedFlow: ['step1', 'step2'], avgStepDuration: 30 },
      });
      const result = await sandbox.startExperiment(createResult.experimentId);
      assert.strictEqual(result.success, true);
    });
  });

  describe('cancelExperiment', () => {
    it('should cancel running experiment', async () => {
      const createResult = sandbox.createExperiment({ domain: 'content' });
      sandbox.getExperiment(createResult.experimentId).status = EXPERIMENT_STATUS.RUNNING;
      const cancelled = sandbox.cancelExperiment(createResult.experimentId);
      assert.strictEqual(cancelled, true);
    });

    it('should not cancel created experiment', () => {
      const createResult = sandbox.createExperiment({ domain: 'content' });
      const cancelled = sandbox.cancelExperiment(createResult.experimentId);
      assert.strictEqual(cancelled, false);
    });
  });

  describe('getHistory', () => {
    it('should return experiment history', async () => {
      const createResult = sandbox.createExperiment({ domain: 'content' });
      await sandbox.startExperiment(createResult.experimentId);
      const history = sandbox.getHistory();
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].domain, 'content');
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 3; i++) {
        const r = sandbox.createExperiment({ domain: 'content' });
        await sandbox.startExperiment(r.experimentId);
      }
      const history = sandbox.getHistory(2);
      assert.strictEqual(history.length, 2);
    });
  });

  describe('getStats', () => {
    it('should return statistics', async () => {
      sandbox.createExperiment({ domain: 'content' });
      const createResult = sandbox.createExperiment({ domain: 'operations' });
      await sandbox.startExperiment(createResult.experimentId);
      const stats = sandbox.getStats();
      assert.strictEqual(stats.totalCreated, 2);
      assert.strictEqual(stats.totalCompleted, 1);
      assert.ok(stats.healthy);
    });
  });

  describe('shutdown', () => {
    it('should shutdown and cancel active experiments', () => {
      sandbox.shutdown();
      assert.strictEqual(sandbox.isHealthy(), false);
      assert.throws(() => sandbox.guardShutdown());
    });
  });
});

// =========================== ResearchDomainAdapter 测试 ===========================

describe('ResearchDomainAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new ResearchDomainAdapter();
  });

  afterEach(() => {
    if (adapter && adapter.isHealthy()) adapter.shutdown();
  });

  describe('Constructor', () => {
    it('should create instance', () => {
      assert.ok(adapter);
      assert.ok(adapter.isHealthy());
    });

    it('should expose RESEARCH_DOMAINS static property', () => {
      assert.strictEqual(RESEARCH_DOMAINS.CONTENT, 'content');
      assert.strictEqual(RESEARCH_DOMAINS.OPERATIONS, 'operations');
      assert.strictEqual(RESEARCH_DOMAINS.ML_RESEARCH, 'ml_research');
      assert.strictEqual(RESEARCH_DOMAINS.WORKFLOW, 'workflow');
    });

    it('should expose DOMAIN_META', () => {
      assert.ok(DOMAIN_META[RESEARCH_DOMAINS.CONTENT]);
      assert.strictEqual(DOMAIN_META[RESEARCH_DOMAINS.CONTENT].name, '内容优化');
      assert.ok(DOMAIN_META[RESEARCH_DOMAINS.ML_RESEARCH].metrics.includes('accuracy'));
    });
  });

  describe('getDomains', () => {
    it('should return all pre-defined domains', () => {
      const domains = adapter.getDomains();
      assert.ok(domains.length >= 8);
      const contentDomain = domains.find(d => d.id === 'content');
      assert.ok(contentDomain);
      assert.strictEqual(contentDomain.name, '内容优化');
    });
  });

  describe('getDomainMeta', () => {
    it('should return meta for known domain', () => {
      const meta = adapter.getDomainMeta('content');
      assert.ok(meta);
      assert.strictEqual(meta.name, '内容优化');
      assert.ok(meta.metrics.includes('engagement'));
      assert.ok(meta.experimentTypes.includes('ab_test'));
    });

    it('should return null for unknown domain', () => {
      const meta = adapter.getDomainMeta('unknown_domain');
      assert.strictEqual(meta, null);
    });
  });

  describe('registerDomain', () => {
    it('should register custom domain', () => {
      const result = adapter.registerDomain('custom_domain', {
        name: 'Custom',
        description: 'Custom research domain',
        metrics: ['customMetric'],
        experimentTypes: ['custom_test'],
        optimizationTargets: ['customTarget'],
      });
      assert.strictEqual(result, true);
      const meta = adapter.getDomainMeta('custom_domain');
      assert.strictEqual(meta.name, 'Custom');
    });

    it('should not override pre-defined domain', () => {
      const result = adapter.registerDomain('content', { name: 'Override' });
      assert.strictEqual(result, false);
    });

    it('should reject invalid registration', () => {
      assert.strictEqual(adapter.registerDomain(null, null), false);
      assert.strictEqual(adapter.registerDomain('test', null), false);
      assert.strictEqual(adapter.registerDomain('test', {}), false);
    });
  });

  describe('generateHypotheses', () => {
    it('should generate hypotheses for content domain', () => {
      const hypotheses = adapter.generateHypotheses('content', {
        patterns: [{ metric: 'engagement', mean: 0.5, trend: 0.1, sampleSize: 20 }],
        currentMetrics: { engagement: 0.5, clickRate: 0.3 },
      }, 3);
      assert.ok(Array.isArray(hypotheses));
      assert.strictEqual(hypotheses.length, 3);
      for (const h of hypotheses) {
        assert.ok(h.id);
        assert.strictEqual(h.domain, 'content');
        assert.ok(h.prediction);
        assert.ok(h.confidence >= 0 && h.confidence <= 1);
      }
    });

    it('should generate hypotheses for ml_research domain', () => {
      const hypotheses = adapter.generateHypotheses('ml_research', {
        patterns: [{ metric: 'accuracy', mean: 0.8, trend: 0.05, sampleSize: 30 }],
        currentMetrics: { accuracy: 0.8, loss: 0.3 },
      }, 2);
      assert.strictEqual(hypotheses.length, 2);
      assert.strictEqual(hypotheses[0].domain, 'ml_research');
    });

    it('should return empty for unknown domain', () => {
      const hypotheses = adapter.generateHypotheses('unknown', {});
      assert.strictEqual(hypotheses.length, 0);
    });

    it('should cap at 5 hypotheses', () => {
      const hypotheses = adapter.generateHypotheses('content', {}, 10);
      assert.ok(hypotheses.length <= 5);
    });
  });

  describe('interpretResults', () => {
    it('should interpret experiment results', () => {
      const result = adapter.interpretResults('content', {
        metrics: { improvement: { clickRate: 0.15 } },
      }, { id: 'hyp-001', target: 'title' });
      assert.strictEqual(result.success, true);
      assert.ok(result.improvement);
      assert.ok(result.significance);
      assert.ok(Array.isArray(result.recommendations));
      assert.ok(result.recommendations.length > 0);
    });

    it('should return error for unknown domain', () => {
      const result = adapter.interpretResults('unknown', {});
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });
  });

  describe('generateOptimizationStrategy', () => {
    it('should generate strategy from history', () => {
      const history = [
        { id: 'exp-1', domain: 'content', status: 'completed', metrics: { duration: 100 } },
        { id: 'exp-2', domain: 'content', status: 'completed', metrics: { duration: 200 } },
        { id: 'exp-3', domain: 'content', status: 'failed' },
      ];
      const result = adapter.generateOptimizationStrategy('content', history);
      assert.strictEqual(result.success, true);
      assert.ok(result.strategy);
      assert.strictEqual(result.strategy.totalExperiments, 3);
      assert.strictEqual(result.strategy.successfulExperiments, 2);
      assert.ok(Math.abs(result.strategy.successRate - 2 / 3) < 0.001);
    });
  });

  describe('shutdown', () => {
    it('should shutdown adapter', () => {
      adapter.shutdown();
      assert.strictEqual(adapter.isHealthy(), false);
      assert.throws(() => adapter.guardShutdown());
    });
  });
});

// =========================== AutonomousResearchLoop 测试 ===========================

describe('AutonomousResearchLoop - Construction & Configuration', () => {
  let loop;

  beforeEach(() => {
    loop = new AutonomousResearchLoop({
      maxConcurrentLoops: 3,
      maxIterationsPerLoop: 3,
      experimentTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    if (loop && loop.isHealthy()) loop.shutdown();
  });

  describe('Constructor', () => {
    it('should create instance with default options', () => {
      const l = new AutonomousResearchLoop();
      assert.ok(l);
      assert.ok(l.isHealthy());
      assert.strictEqual(l._options.maxConcurrentLoops, 3);
      assert.strictEqual(l._options.maxIterationsPerLoop, 10);
      assert.strictEqual(l._options.enableAutoRefine, true);
    });

    it('should merge custom options', () => {
      const l = new AutonomousResearchLoop({ maxIterationsPerLoop: 5, enableAutoRefine: false });
      assert.strictEqual(l._options.maxIterationsPerLoop, 5);
      assert.strictEqual(l._options.enableAutoRefine, false);
    });

    it('should expose LOOP_STAGES static property', () => {
      assert.strictEqual(LOOP_STAGES.DEFINE, 'define');
      assert.strictEqual(LOOP_STAGES.OBSERVE, 'observe');
      assert.strictEqual(LOOP_STAGES.HYPOTHESIZE, 'hypothesize');
      assert.strictEqual(LOOP_STAGES.CODE, 'code');
      assert.strictEqual(LOOP_STAGES.EXPERIMENT, 'experiment');
      assert.strictEqual(LOOP_STAGES.ANALYZE, 'analyze');
      assert.strictEqual(LOOP_STAGES.REFINE, 'refine');
    });

    it('should expose LOOP_STATUS static property', () => {
      assert.strictEqual(LOOP_STATUS.IDLE, 'idle');
      assert.strictEqual(LOOP_STATUS.RUNNING, 'running');
      assert.strictEqual(LOOP_STATUS.COMPLETED, 'completed');
      assert.strictEqual(LOOP_STATUS.FAILED, 'failed');
    });
  });

  describe('attachComponent', () => {
    it('should attach experiment sandbox', () => {
      const sandbox = new ExperimentSandbox();
      const result = loop.attachComponent('experimentSandbox', sandbox);
      assert.strictEqual(result, true);
      sandbox.shutdown();
    });

    it('should attach domain adapter', () => {
      const adapter = new ResearchDomainAdapter();
      const result = loop.attachComponent('domainAdapter', adapter);
      assert.strictEqual(result, true);
      adapter.shutdown();
    });

    it('should reject unknown component', () => {
      const result = loop.attachComponent('unknownComponent', {});
      assert.strictEqual(result, false);
    });
  });

  describe('startLoop', () => {
    it('should start a research loop', () => {
      const result = loop.startLoop({ domain: 'content', goal: 'Optimize content titles' });
      assert.strictEqual(result.success, true);
      assert.ok(result.loopId);
      assert.ok(result.loopId.startsWith('arl-'));
    });

    it('should reject without domain', () => {
      const result = loop.startLoop({ goal: 'test' });
      assert.strictEqual(result.success, false);
    });

    it('should reject without goal', () => {
      const result = loop.startLoop({ domain: 'content' });
      assert.strictEqual(result.success, false);
    });

    it('should reject when max concurrent loops reached', () => {
      const l = new AutonomousResearchLoop({ maxConcurrentLoops: 1 });
      l.startLoop({ domain: 'content', goal: 'test1' });
      const result = l.startLoop({ domain: 'operations', goal: 'test2' });
      assert.strictEqual(result.success, false);
      l.shutdown();
    });

    it('should set loop status to RUNNING', () => {
      const result = loop.startLoop({ domain: 'content', goal: 'test' });
      const activeLoop = loop.getLoop(result.loopId);
      assert.strictEqual(activeLoop.status, LOOP_STATUS.RUNNING);
      assert.strictEqual(activeLoop.stage, LOOP_STAGES.DEFINE);
    });
  });
});

describe('AutonomousResearchLoop - Stage Operations', () => {
  let loop;

  beforeEach(() => {
    loop = new AutonomousResearchLoop({
      maxConcurrentLoops: 3,
      maxIterationsPerLoop: 3,
      experimentTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    if (loop && loop.isHealthy()) loop.shutdown();
  });

  describe('observe', () => {
    it('should observe and transition to HYPOTHESIZE', () => {
      const startResult = loop.startLoop({ domain: 'content', goal: 'test' });
      const obsResult = loop.observe(startResult.loopId, {
        metrics: { engagement: 0.5 },
        context: { domain: 'content' },
      });
      assert.strictEqual(obsResult.success, true);
      assert.ok(obsResult.observation);
      const activeLoop = loop.getLoop(startResult.loopId);
      assert.strictEqual(activeLoop.stage, LOOP_STAGES.HYPOTHESIZE);
    });

    it('should reject unknown loop', () => {
      const result = loop.observe('unknown-id', {});
      assert.strictEqual(result.success, false);
    });
  });

  describe('hypothesize', () => {
    it('should generate hypotheses', () => {
      const startResult = loop.startLoop({ domain: 'content', goal: 'test' });
      loop.observe(startResult.loopId, { metrics: { engagement: 0.5 } });
      const hypResult = loop.hypothesize(startResult.loopId);
      assert.strictEqual(hypResult.success, true);
      assert.ok(Array.isArray(hypResult.hypotheses));
      const activeLoop = loop.getLoop(startResult.loopId);
      assert.strictEqual(activeLoop.stage, LOOP_STAGES.CODE);
    });

    it('should generate hypotheses with domain adapter', () => {
      const adapter = new ResearchDomainAdapter();
      loop.attachComponent('domainAdapter', adapter);
      const startResult = loop.startLoop({ domain: 'content', goal: 'test' });
      loop.observe(startResult.loopId, { metrics: { engagement: 0.5, clickRate: 0.3 } });
      const hypResult = loop.hypothesize(startResult.loopId);
      assert.strictEqual(hypResult.success, true);
      assert.ok(hypResult.hypotheses.length > 0);
      adapter.shutdown();
    });
  });

  describe('code', () => {
    it('should generate experiment configs', () => {
      const startResult = loop.startLoop({ domain: 'content', goal: 'test' });
      loop.observe(startResult.loopId, { metrics: { engagement: 0.5 } });
      loop.hypothesize(startResult.loopId);
      const codeResult = loop.code(startResult.loopId);
      assert.strictEqual(codeResult.success, true);
      assert.ok(Array.isArray(codeResult.experiments));
      const activeLoop = loop.getLoop(startResult.loopId);
      assert.strictEqual(activeLoop.stage, LOOP_STAGES.EXPERIMENT);
    });
  });

  describe('experiment', () => {
    it('should execute experiments in sandbox', async () => {
      const sandbox = new ExperimentSandbox({ defaultTimeoutMs: 5000 });
      loop.attachComponent('experimentSandbox', sandbox);
      const startResult = loop.startLoop({ domain: 'content', goal: 'test' });
      loop.observe(startResult.loopId, { metrics: { engagement: 0.5 } });
      loop.hypothesize(startResult.loopId);
      loop.code(startResult.loopId);
      const expResult = await loop.experiment(startResult.loopId);
      assert.strictEqual(expResult.success, true);
      assert.ok(Array.isArray(expResult.results));
      const activeLoop = loop.getLoop(startResult.loopId);
      assert.strictEqual(activeLoop.stage, LOOP_STAGES.ANALYZE);
      sandbox.shutdown();
    });

    it('should simulate experiments without sandbox', async () => {
      const startResult = loop.startLoop({ domain: 'content', goal: 'test' });
      loop.observe(startResult.loopId, { metrics: { engagement: 0.5 } });
      loop.hypothesize(startResult.loopId);
      loop.code(startResult.loopId);
      const expResult = await loop.experiment(startResult.loopId);
      assert.strictEqual(expResult.success, true);
      assert.ok(expResult.results.length > 0);
    });
  });

  describe('analyze', () => {
    it('should analyze experiment results', async () => {
      const startResult = loop.startLoop({ domain: 'content', goal: 'test' });
      loop.observe(startResult.loopId, { metrics: { engagement: 0.5 } });
      loop.hypothesize(startResult.loopId);
      loop.code(startResult.loopId);
      await loop.experiment(startResult.loopId);
      const analyzeResult = loop.analyze(startResult.loopId);
      assert.strictEqual(analyzeResult.success, true);
      assert.ok(analyzeResult.analysis);
      assert.ok(analyzeResult.analysis.shouldContinue !== undefined);
      const activeLoop = loop.getLoop(startResult.loopId);
      assert.strictEqual(activeLoop.stage, LOOP_STAGES.REFINE);
    });
  });

  describe('refine', () => {
    it('should apply optimizations and continue', async () => {
      const startResult = loop.startLoop({ domain: 'content', goal: 'test' });
      loop.observe(startResult.loopId, { metrics: { engagement: 0.5 } });
      loop.hypothesize(startResult.loopId);
      loop.code(startResult.loopId);
      await loop.experiment(startResult.loopId);
      loop.analyze(startResult.loopId);
      const refineResult = loop.refine(startResult.loopId);
      assert.strictEqual(refineResult.success, true);
    });

    it('should complete after max iterations', async () => {
      const l = new AutonomousResearchLoop({ maxIterationsPerLoop: 1, enableAutoRefine: false });
      const startResult = l.startLoop({ domain: 'content', goal: 'test' });
      l.observe(startResult.loopId, { metrics: { engagement: 0.5 } });
      l.hypothesize(startResult.loopId);
      l.code(startResult.loopId);
      await l.experiment(startResult.loopId);
      l.analyze(startResult.loopId);
      l.refine(startResult.loopId);
      const activeLoop = l.getLoop(startResult.loopId);
      assert.strictEqual(activeLoop, null);
      const completed = l.getCompletedLoops();
      assert.strictEqual(completed.length, 1);
      l.shutdown();
    });
  });
});

describe('AutonomousResearchLoop - Loop Management', () => {
  let loop;

  beforeEach(() => {
    loop = new AutonomousResearchLoop({
      maxConcurrentLoops: 3,
      maxIterationsPerLoop: 3,
      experimentTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    if (loop && loop.isHealthy()) loop.shutdown();
  });

  describe('executeFullLoop', () => {
    it('should execute complete seven-stage loop', async () => {
      const sandbox = new ExperimentSandbox({ defaultTimeoutMs: 5000 });
      const adapter = new ResearchDomainAdapter();
      loop.attachComponent('experimentSandbox', sandbox);
      loop.attachComponent('domainAdapter', adapter);

      const result = await loop.executeFullLoop({
        domain: 'content',
        goal: 'Optimize content engagement',
        targetMetrics: ['engagement', 'clickRate'],
        maxIterations: 2,
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.loopId);
      assert.ok(result.summary);
      assert.ok(result.summary.totalIterations > 0);
      sandbox.shutdown();
      adapter.shutdown();
    });

    it('should execute without external components', async () => {
      const result = await loop.executeFullLoop({
        domain: 'operations',
        goal: 'Improve operations efficiency',
        maxIterations: 2,
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.summary.totalIterations > 0);
    });
  });

  describe('pauseLoop / resumeLoop', () => {
    it('should pause and resume loop', () => {
      const startResult = loop.startLoop({ domain: 'content', goal: 'test' });
      assert.strictEqual(loop.pauseLoop(startResult.loopId), true);
      assert.strictEqual(loop.getLoop(startResult.loopId).status, LOOP_STATUS.PAUSED);
      assert.strictEqual(loop.resumeLoop(startResult.loopId), true);
      assert.strictEqual(loop.getLoop(startResult.loopId).status, LOOP_STATUS.RUNNING);
    });
  });

  describe('cancelLoop', () => {
    it('should cancel loop', () => {
      const startResult = loop.startLoop({ domain: 'content', goal: 'test' });
      assert.strictEqual(loop.cancelLoop(startResult.loopId), true);
      assert.strictEqual(loop.getLoop(startResult.loopId), null);
      const completed = loop.getCompletedLoops();
      assert.strictEqual(completed.length, 1);
      assert.strictEqual(completed[0].status, LOOP_STATUS.CANCELLED);
    });
  });

  describe('getStats', () => {
    it('should return statistics', async () => {
      await loop.executeFullLoop({ domain: 'content', goal: 'test', maxIterations: 1 });
      const stats = loop.getStats();
      assert.ok(stats.loopsStarted >= 1);
      assert.ok(stats.experimentsRun >= 1);
      assert.ok(stats.healthy);
    });
  });

  describe('shutdown', () => {
    it('should shutdown and cancel active loops', () => {
      loop.startLoop({ domain: 'content', goal: 'test' });
      loop.shutdown();
      assert.strictEqual(loop.isHealthy(), false);
      assert.throws(() => loop.guardShutdown());
    });
  });
});

// =========================== 集成测试 ===========================

describe('AutonomousResearchLoop - Integration', () => {
  it('should integrate all components in full cycle', async () => {
    const sandbox = new ExperimentSandbox({ defaultTimeoutMs: 5000 });
    const adapter = new ResearchDomainAdapter();
    const researchLoop = new AutonomousResearchLoop({ maxIterationsPerLoop: 2 });

    researchLoop.attachComponent('experimentSandbox', sandbox);
    researchLoop.attachComponent('domainAdapter', adapter);

    // 测试内容领域
    const contentResult = await researchLoop.executeFullLoop({
      domain: 'content',
      goal: 'Optimize content titles for higher engagement',
      targetMetrics: ['engagement', 'clickRate'],
      maxIterations: 2,
    });
    assert.strictEqual(contentResult.success, true);
    assert.ok(contentResult.summary.totalIterations > 0);

    // 测试运营领域
    const opsResult = await researchLoop.executeFullLoop({
      domain: 'operations',
      goal: 'Improve customer service response time',
      targetMetrics: ['responseTime', 'successRate'],
      maxIterations: 2,
    });
    assert.strictEqual(opsResult.success, true);

    // 验证统计
    const stats = researchLoop.getStats();
    assert.strictEqual(stats.loopsCompleted, 2);
    assert.ok(stats.experimentsRun >= 4);
    assert.ok(stats.hypothesesGenerated >= 4);

    sandbox.shutdown();
    adapter.shutdown();
    researchLoop.shutdown();
  });

  it('should handle multiple domains in parallel', async () => {
    const sandbox = new ExperimentSandbox({ defaultTimeoutMs: 5000, maxConcurrentExperiments: 5 });
    const adapter = new ResearchDomainAdapter();
    const researchLoop = new AutonomousResearchLoop({ maxConcurrentLoops: 3, maxIterationsPerLoop: 2 });

    researchLoop.attachComponent('experimentSandbox', sandbox);
    researchLoop.attachComponent('domainAdapter', adapter);

    const domains = [
      { domain: 'content', goal: 'Content optimization', maxIterations: 1 },
      { domain: 'ml_research', goal: 'ML hyperparameter tuning', maxIterations: 1 },
      { domain: 'workflow', goal: 'Workflow optimization', maxIterations: 1 },
    ];

    const promises = domains.map(d => researchLoop.executeFullLoop(d));
    const results = await Promise.all(promises);

    for (const result of results) {
      assert.strictEqual(result.success, true);
    }

    const stats = researchLoop.getStats();
    assert.strictEqual(stats.loopsCompleted, 3);
    assert.ok(stats.byDomain.content >= 1);
    assert.ok(stats.byDomain.ml_research >= 1);
    assert.ok(stats.byDomain.workflow >= 1);

    sandbox.shutdown();
    adapter.shutdown();
    researchLoop.shutdown();
  });
});
