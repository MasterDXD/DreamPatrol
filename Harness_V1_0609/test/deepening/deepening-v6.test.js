'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}

describe('DeepeningOrchestrator V6 Integration', () => {
  const DeepeningOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-orchestrator'));
  const DeepeningMetricsCollector = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-metrics-collector'));
  const DeepeningCache = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-cache'));
  const DeepeningStrategyPlugin = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-strategy-plugin'));
  const DeepeningReportGenerator = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-report-generator'));
  const ConvergenceDetector = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'convergence-detector'));
  const QualityScorer = require(path.join(ROOT, 'src', 'runtime', 'quality', 'quality-scorer'));

  it('should attach all v5 modules via fluent API', () => {
    const orch = new DeepeningOrchestrator();
    const metrics = new DeepeningMetricsCollector();
    const cache = new DeepeningCache();
    const strategy = new DeepeningStrategyPlugin('test', { type: 'adaptive' });
    const report = new DeepeningReportGenerator();
    const convergence = new ConvergenceDetector();
    const scorer = new QualityScorer();

    const result = orch
      .attachMetricsCollector(metrics)
      .attachCache(cache)
      .attachStrategyPlugin(strategy)
      .attachReportGenerator(report)
      .attachConvergenceDetector(convergence)
      .attachQualityScorer(scorer);

    assert.equal(result, orch);
    const stats = orch.getStats();
    assert.ok(stats.attachedModules);
    assert.equal(stats.attachedModules.metricsCollector, true);
    assert.equal(stats.attachedModules.cache, true);
    assert.equal(stats.attachedModules.strategyPlugin, true);
    assert.equal(stats.attachedModules.reportGenerator, true);
    assert.equal(stats.attachedModules.convergenceDetector, true);
    assert.equal(stats.attachedModules.qualityScorer, true);
  });

  it('should reject invalid module attachments', () => {
    const orch = new DeepeningOrchestrator();
    orch.attachMetricsCollector(null);
    assert.throws(function() { orch.attachMetricsCollector({}); }, /MetricsCollector must have a record method/);
    const stats = orch.getStats();
    assert.equal(stats.attachedModules.metricsCollector, false);
  });

  it('should use cache for high-quality cached results', async () => {
    const orch = new DeepeningOrchestrator({ enableCache: true, convergenceThreshold: 0.85 });
    const cache = new DeepeningCache();
    orch.attachCache(cache);

    const task = { id: 'cached-task', type: 'test', description: 'test cached task' };
    cache.store(task, { success: true, data: 'cached' }, { qualityScore: 0.92, iteration: 1, agentId: 'a1' });

    const result = await orch.execute(task, []);
    assert.ok(result.success);
    assert.ok(result.fromCache);
    assert.equal(result.bestScore, 0.92);
  });

  it('should record metrics during execution', async () => {
    const orch = new DeepeningOrchestrator({ enableMetrics: true, maxIterations: 1 });
    const metrics = new DeepeningMetricsCollector();
    orch.attachMetricsCollector(metrics);

    const agent = {
      id: 'test-agent',
      execute: async () => ({ success: true, qualityScore: 0.8 }),
    };

    await orch.execute({ id: 't1', description: 'test' }, [agent]);
    const stats = metrics.getStats();
    assert.ok(stats.totalMetrics > 0);
  });

  it('should generate report after execution', async () => {
    const orch = new DeepeningOrchestrator({ enableReportGeneration: true, maxIterations: 1 });
    const report = new DeepeningReportGenerator();
    orch.attachReportGenerator(report);

    const agent = {
      id: 'test-agent',
      execute: async () => ({ success: true, qualityScore: 0.85 }),
    };

    await orch.execute({ id: 't1', description: 'test' }, [agent]);
    const history = report.getReportHistory();
    assert.ok(history.length > 0);
  });

  it('should use strategy plugin for iteration control', async () => {
    const orch = new DeepeningOrchestrator({ enableStrategyPlugin: true, maxIterations: 4 });
    const strategy = new DeepeningStrategyPlugin('test', { type: 'fixed-depth', maxIterations: 1 });
    orch.attachStrategyPlugin(strategy);

    const agent = {
      id: 'test-agent',
      execute: async () => ({ success: true, qualityScore: 0.6 }),
    };

    const result = await orch.execute({ id: 't1', description: 'test' }, [agent]);
    assert.ok(result.success);
  });

  it('should store result in cache after execution', async () => {
    const orch = new DeepeningOrchestrator({ enableCache: true, maxIterations: 1 });
    const cache = new DeepeningCache();
    orch.attachCache(cache);

    const agent = {
      id: 'test-agent',
      execute: async () => ({ success: true, qualityScore: 0.8 }),
    };

    await orch.execute({ id: 't1', type: 'test', description: 'test' }, [agent]);
    const cached = cache.retrieve({ id: 't1', type: 'test', description: 'test' });
    assert.ok(cached);
    assert.ok(cached.qualityScore > 0);
  });

  it('should include qualityHistory in execution result', async () => {
    const orch = new DeepeningOrchestrator({ maxIterations: 2 });
    let callCount = 0;
    const agent = {
      id: 'test-agent',
      execute: async () => {
        callCount++;
        return { success: true, qualityScore: 0.5 + callCount * 0.15 };
      },
    };

    const result = await orch.execute({ id: 't1', description: 'test' }, [agent]);
    assert.ok(result.qualityHistory);
    assert.ok(Array.isArray(result.qualityHistory));
  });

  it('should generate report via generateReport method', () => {
    const orch = new DeepeningOrchestrator();
    const report = new DeepeningReportGenerator();
    orch.attachReportGenerator(report);

    const result = orch.generateReport('execution-summary', { executions: [] });
    assert.ok(result);
  });

  it('should return null for generateReport without generator', () => {
    const orch = new DeepeningOrchestrator();
    assert.equal(orch.generateReport('test'), null);
  });
});

describe('DeepeningPipeline', () => {
  const DeepeningPipeline = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-pipeline'));

  it('should export PIPELINE_STAGES', () => {
    assert.ok(DeepeningPipeline.PIPELINE_STAGES);
    assert.ok(DeepeningPipeline.PIPELINE_STAGES.INIT);
    assert.ok(DeepeningPipeline.PIPELINE_STAGES.CACHE_CHECK);
    assert.ok(DeepeningPipeline.PIPELINE_STAGES.ITERATIVE_EXECUTION);
    assert.ok(DeepeningPipeline.PIPELINE_STAGES.COMPLETE);
  });

  it('should initialize all modules', () => {
    const pipeline = new DeepeningPipeline();
    pipeline.initialize();
    const stats = pipeline.getStats();
    assert.ok(stats.initialized);
    assert.ok(stats.moduleCount > 0);
    assert.ok(stats.modules.includes('orchestrator'));
    assert.ok(stats.modules.includes('metricsCollector'));
    assert.ok(stats.modules.includes('cache'));
    assert.ok(stats.modules.includes('strategyPlugin'));
    assert.ok(stats.modules.includes('reportGenerator'));
    assert.ok(stats.modules.includes('convergenceDetector'));
    assert.ok(stats.modules.includes('qualityScorer'));
  });

  it('should auto-initialize on first run', async () => {
    const pipeline = new DeepeningPipeline({ maxIterations: 1 });
    const agent = {
      id: 'test-agent',
      execute: async () => ({ success: true, qualityScore: 0.8 }),
    };

    await pipeline.run({ id: 't1', description: 'test' }, [agent]);
    assert.ok(pipeline.getStats().initialized);
  });

  it('should execute pipeline and return result', async () => {
    const pipeline = new DeepeningPipeline({ maxIterations: 1, enableMultiAgent: false });
    pipeline.initialize();

    const agent = {
      id: 'test-agent',
      execute: async () => ({ success: true, qualityScore: 0.85 }),
    };

    const result = await pipeline.run({ id: 't1', description: 'test' }, [agent]);
    assert.ok(result, 'Pipeline should return a result');
    assert.ok(result.success, `Pipeline result should be success, got: ${JSON.stringify(result)}`);
    assert.ok(result.pipelineId);
    assert.ok(result.duration >= 0);
  });

  it('should return cached result for repeated tasks', async () => {
    const DeepeningCache = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-cache'));
    const cache = new DeepeningCache();
    const pipeline = new DeepeningPipeline({ convergenceThreshold: 0.3, enableMultiAgent: false });
    pipeline.initialize();
    pipeline._modules.cache = cache;
    pipeline._modules.orchestrator.attachCache(cache);

    let execCount = 0;
    const agent = {
      id: 'test-agent',
      execute: async () => {
        execCount++;
        return { success: true, qualityScore: 0.9 };
      },
    };

    const task = { id: 'cache-test', type: 'test', description: 'test cache hit' };
    const result1 = await pipeline.run(task, [agent]);
    assert.ok(result1.success);
    assert.equal(execCount, 1, 'First run should execute agent');

    const cached = cache.retrieve(task);
    assert.ok(cached, 'Result should be in cache');

    const result2 = await pipeline.run(task, [agent]);
    assert.ok(result2.success);
    assert.equal(execCount, 1, 'Second run should not execute agent again');
  });

  it('should get module by name', () => {
    const pipeline = new DeepeningPipeline();
    pipeline.initialize();
    const orch = pipeline.getModule('orchestrator');
    assert.ok(orch);
    assert.ok(typeof orch.execute === 'function');
  });

  it('should return null for unknown module', () => {
    const pipeline = new DeepeningPipeline();
    pipeline.initialize();
    assert.equal(pipeline.getModule('nonexistent'), null);
  });

  it('should generate reports', () => {
    const pipeline = new DeepeningPipeline();
    pipeline.initialize();
    const report = pipeline.generateReport('execution-summary');
    assert.ok(report);
  });

  it('should track pipeline runs', async () => {
    const pipeline = new DeepeningPipeline({ maxIterations: 1 });
    pipeline.initialize();

    const agent = {
      id: 'test-agent',
      execute: async () => ({ success: true, qualityScore: 0.8 }),
    };

    await pipeline.run({ id: 't1', description: 'test' }, [agent]);
    await pipeline.run({ id: 't2', description: 'test2' }, [agent]);
    const stats = pipeline.getStats();
    assert.equal(stats.pipelineRuns, 2);
  });

  it('should emit pipeline events', async () => {
    const pipeline = new DeepeningPipeline({ maxIterations: 1 });
    pipeline.initialize();

    let startEmitted = false;
    let completeEmitted = false;
    pipeline.on('pipeline-start', () => { startEmitted = true; });
    pipeline.on('pipeline-complete', () => { completeEmitted = true; });

    const agent = {
      id: 'test-agent',
      execute: async () => ({ success: true, qualityScore: 0.8 }),
    };

    await pipeline.run({ id: 't1', description: 'test' }, [agent]);
    assert.ok(startEmitted);
    assert.ok(completeEmitted);
  });

  it('should shutdown cleanly', () => {
    const pipeline = new DeepeningPipeline();
    pipeline.initialize();
    pipeline.shutdown();
    assert.ok(!pipeline.getStats().initialized);
  });

  it('should handle errors gracefully', async () => {
    const pipeline = new DeepeningPipeline({ maxIterations: 1 });
    pipeline.initialize();

    const result = await pipeline.run(null, null);
    assert.ok(result);
  });
});

describe('DeepeningHealthMonitor', () => {
  const DeepeningHealthMonitor = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-health-monitor'));

  afterEach(async () => { await _cleanAll(); });

  it('should register and run health checks', async () => {
    const monitor = _track(new DeepeningHealthMonitor());
    monitor.register('test-module', () => ({
      healthy: true,
      message: 'All good',
      details: { uptime: 1000 },
    }));

    const report = await monitor.check();
    assert.ok(report.healthy);
    assert.equal(report.moduleCount, 1);
    assert.equal(report.healthyCount, 1);
    assert.equal(report.unhealthyCount, 0);
  });

  it('should detect unhealthy modules', async () => {
    const monitor = _track(new DeepeningHealthMonitor());
    monitor.register('healthy-mod', () => ({ healthy: true, message: 'OK' }));
    monitor.register('sick-mod', () => ({ healthy: false, message: 'Down' }));

    const report = await monitor.check();
    assert.ok(!report.healthy);
    assert.equal(report.healthyCount, 1);
    assert.equal(report.unhealthyCount, 1);
  });

  it('should handle check function errors', async () => {
    const monitor = new DeepeningHealthMonitor();
    monitor.register('error-mod', () => { throw new Error('check failed'); });

    const report = await monitor.check();
    assert.ok(!report.healthy);
    assert.ok(report.results._byName['error-mod']);
    assert.ok(!report.results._byName['error-mod'].healthy);
  });

  it('should unregister modules', () => {
    const monitor = new DeepeningHealthMonitor();
    monitor.register('test', () => ({ healthy: true, message: 'OK' }));
    assert.ok(monitor.unregister('test'));
    assert.ok(!monitor.unregister('nonexistent'));
    assert.equal(monitor.getModuleNames().length, 0);
  });

  it('should reject invalid registrations', () => {
    const monitor = new DeepeningHealthMonitor();
    assert.equal(monitor.register(null, () => ({ healthy: true })), false);
    assert.equal(monitor.register('test', 'not-a-function'), false);
  });

  it('should track last report', async () => {
    const monitor = new DeepeningHealthMonitor();
    monitor.register('test', () => ({ healthy: true, message: 'OK' }));
    await monitor.check();
    const last = monitor.getLastReport();
    assert.ok(last);
    assert.ok(last.timestamp);
  });

  it('should support periodic checks', () => {
    const monitor = new DeepeningHealthMonitor();
    monitor.register('test', () => ({ healthy: true, message: 'OK' }));
    monitor.startPeriodicCheck(1000);
    const stats = monitor.getStats();
    assert.ok(stats.periodicCheckActive);
    monitor.stopPeriodicCheck();
    assert.ok(!monitor.getStats().periodicCheckActive);
  });

  it('should emit health-checked event', async () => {
    const monitor = new DeepeningHealthMonitor();
    monitor.register('test', () => ({ healthy: true, message: 'OK' }));
    let eventFired = false;
    monitor.on('health-checked', () => { eventFired = true; });
    await monitor.check();
    assert.ok(eventFired);
  });

  it('should emit health-degraded event when unhealthy', async () => {
    const monitor = new DeepeningHealthMonitor();
    monitor.register('test', () => ({ healthy: false, message: 'Down' }));
    let degraded = false;
    monitor.on('health-degraded', () => { degraded = true; });
    await monitor.check();
    assert.ok(degraded);
  });

  it('should get stats', async () => {
    const monitor = new DeepeningHealthMonitor();
    monitor.register('test', () => ({ healthy: true, message: 'OK' }));
    await monitor.check();
    const stats = monitor.getStats();
    assert.equal(stats.registeredModules, 1);
    assert.equal(stats.checkCount, 1);
  });

  it('should shutdown cleanly', () => {
    const monitor = new DeepeningHealthMonitor();
    monitor.register('test', () => ({ healthy: true, message: 'OK' }));
    monitor.startPeriodicCheck(1000);
    monitor.shutdown();
    assert.strictEqual(monitor.isHealthy(), false);
  });
});

describe('Framework Integration: V6 Modules', () => {
  const { create } = require(path.join(ROOT, 'src', 'index'));

  it('should create framework with all v6 modules', () => {
    const framework = create(ROOT);
    assert.ok(framework.deepeningMetricsCollector);
    assert.ok(framework.deepeningCache);
    assert.ok(framework.deepeningStrategyPlugin);
    assert.ok(framework.deepeningReportGenerator);
    assert.ok(framework.deepeningPipeline);
    assert.ok(framework.deepeningHealthMonitor);
    framework.destroy();
  });

  it('should register health checks for v6 modules', async () => {
    const framework = create(ROOT);
    const result = await framework.healthChecker.checkAll();
    const checks = result.checks;
    const v6Modules = [
      'deepening-metrics-collector',
      'deepening-cache',
      'deepening-strategy-plugin',
      'deepening-report-generator',
      'deepening-pipeline',
      'deepening-health-monitor',
    ];
    for (const name of v6Modules) {
      assert.ok(checks[name], `Missing health check for ${name}`);
      assert.equal(checks[name].status, 'healthy', `${name} should be healthy`);
    }
    framework.destroy();
  });

  it('should export v6 modules from package', () => {
    const pkg = require(path.join(ROOT, 'src', 'index'));
    assert.ok(pkg.DeepeningMetricsCollector);
    assert.ok(pkg.DeepeningCache);
    assert.ok(pkg.DeepeningStrategyPlugin);
    assert.ok(pkg.DeepeningReportGenerator);
    assert.ok(pkg.DeepeningPipeline);
    assert.ok(pkg.DeepeningHealthMonitor);
  });

  it('should have deepening orchestrator with attached modules', () => {
    const framework = create(ROOT);
    const stats = framework.deepeningOrchestrator.getStats();
    assert.ok(stats.attachedModules);
    assert.equal(stats.attachedModules.metricsCollector, true);
    assert.equal(stats.attachedModules.cache, true);
    assert.equal(stats.attachedModules.strategyPlugin, true);
    assert.equal(stats.attachedModules.reportGenerator, true);
    assert.equal(stats.attachedModules.convergenceDetector, true);
    assert.equal(stats.attachedModules.qualityScorer, true);
    framework.destroy();
  });

  it('should have deepening health monitor with registered modules', () => {
    const framework = create(ROOT);
    const modules = framework.deepeningHealthMonitor.getModuleNames();
    assert.ok(modules.length >= 5);
    framework.destroy();
  });

  it('should have pipeline with all modules initialized', () => {
    const framework = create(ROOT);
    const stats = framework.deepeningPipeline.getStats();
    assert.ok(stats.initialized);
    assert.ok(stats.moduleCount >= 7);
    framework.destroy();
  });
});
