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
describe('DeepeningEventStore', () => {
  afterEach(async () => { await _cleanAll(); });
  const DeepeningEventStore = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-event-store'));

  it('should export EVENT_TYPES', () => {
    assert.ok(DeepeningEventStore.EVENT_TYPES);
    assert.ok(DeepeningEventStore.EVENT_TYPES.EXECUTION_START);
    assert.ok(DeepeningEventStore.EVENT_TYPES.EXECUTION_COMPLETE);
    assert.ok(DeepeningEventStore.EVENT_TYPES.ITERATION_COMPLETE);
    assert.ok(DeepeningEventStore.EVENT_TYPES.CONVERGENCE_DETECTED);
  });

  it('should record events', () => {
    const store = _track(new DeepeningEventStore());
    const event = store.record('test-event', { key: 'value' });
    assert.ok(event);
    assert.ok(event.id);
    assert.equal(event.type, 'test-event');
    assert.ok(event.timestamp);
    assert.deepEqual(event.data, { key: 'value' });
  });

  it('should record execution start', () => {
    const store = _track(new DeepeningEventStore());
    const event = store.recordExecutionStart('exec-1', { id: 'task-1' });
    assert.ok(event);
    assert.equal(event.type, DeepeningEventStore.EVENT_TYPES.EXECUTION_START);
    assert.equal(event.data.executionId, 'exec-1');
  });

  it('should record execution complete', () => {
    const store = _track(new DeepeningEventStore());
    const event = store.recordExecutionComplete('exec-1', { bestScore: 0.9 });
    assert.ok(event);
    assert.equal(event.type, DeepeningEventStore.EVENT_TYPES.EXECUTION_COMPLETE);
  });

  it('should record iteration complete', () => {
    const store = _track(new DeepeningEventStore());
    const event = store.recordIterationComplete('exec-1', 2, 0.85);
    assert.ok(event);
    assert.equal(event.data.iteration, 2);
    assert.equal(event.data.score, 0.85);
  });

  it('should record convergence', () => {
    const store = _track(new DeepeningEventStore());
    const event = store.recordConvergence('exec-1', 'quality-threshold-met', 3);
    assert.ok(event);
    assert.equal(event.data.reason, 'quality-threshold-met');
  });

  it('should record cache hit/miss', () => {
    const store = _track(new DeepeningEventStore());
    store.recordCacheHit('task-1', 0.9);
    store.recordCacheMiss('task-2');
    const hits = store.getByType(DeepeningEventStore.EVENT_TYPES.CACHE_HIT);
    const misses = store.getByType(DeepeningEventStore.EVENT_TYPES.CACHE_MISS);
    assert.equal(hits.length, 1);
    assert.equal(misses.length, 1);
  });

  it('should query events by type', () => {
    const store = _track(new DeepeningEventStore());
    store.record('type-a', { v: 1 });
    store.record('type-b', { v: 2 });
    store.record('type-a', { v: 3 });
    const results = store.query({ type: 'type-a' });
    assert.equal(results.length, 2);
  });

  it('should query events by executionId', () => {
    const store = _track(new DeepeningEventStore());
    store.recordExecutionStart('exec-1', { id: 't1' });
    store.recordExecutionStart('exec-2', { id: 't2' });
    store.recordIterationComplete('exec-1', 1, 0.5);
    const results = store.query({ executionId: 'exec-1' });
    assert.equal(results.length, 2);
  });

  it('should query events by time range', () => {
    const store = _track(new DeepeningEventStore());
    const before = Date.now();
    store.record('test', { v: 1 });
    const after = Date.now();
    const results = store.query({ since: before, until: after + 1000 });
    assert.ok(results.length >= 1);
  });

  it('should get events by execution', () => {
    const store = _track(new DeepeningEventStore());
    store.recordExecutionStart('exec-1', { id: 't1' });
    store.recordIterationComplete('exec-1', 1, 0.5);
    store.recordExecutionComplete('exec-1', { bestScore: 0.9 });
    const events = store.getByExecution('exec-1');
    assert.equal(events.length, 3);
  });

  it('should get execution timeline', () => {
    const store = _track(new DeepeningEventStore());
    store.recordExecutionStart('exec-1', { id: 't1' });
    store.recordIterationComplete('exec-1', 1, 0.5);
    store.recordExecutionComplete('exec-1', { bestScore: 0.9 });
    const timeline = store.getExecutionTimeline('exec-1');
    assert.equal(timeline.length, 3);
    assert.ok(timeline[0].timestamp <= timeline[1].timestamp);
  });

  it('should replay execution events', () => {
    const store = _track(new DeepeningEventStore());
    store.recordExecutionStart('exec-1', { id: 't1' });
    store.recordIterationComplete('exec-1', 1, 0.5);
    store.recordExecutionComplete('exec-1', { bestScore: 0.9 });
    const replayed = [];
    store.replay('exec-1', (event) => { replayed.push(event); });
    assert.equal(replayed.length, 3);
  });

  it('should get stats', () => {
    const store = _track(new DeepeningEventStore());
    store.recordExecutionStart('exec-1', { id: 't1' });
    store.recordIterationComplete('exec-1', 1, 0.5);
    const stats = store.getStats();
    assert.equal(stats.totalEvents, 2);
    assert.ok(stats.sequenceNumber >= 2);
    assert.ok(stats.executionCount >= 1);
  });

  it('should get dashboard data', () => {
    const store = _track(new DeepeningEventStore());
    store.recordExecutionStart('exec-1', { id: 't1' });
    store.recordIterationComplete('exec-1', 1, 0.5);
    store.recordExecutionComplete('exec-1', { bestScore: 0.9 });
    const dashboard = store.getDashboard();
    assert.ok(dashboard.stats);
    assert.ok(dashboard.recentEvents);
    assert.ok(dashboard.executionSummaries);
    assert.ok(dashboard.executionSummaries['exec-1']);
  });

  it('should enforce max events', () => {
    const store = _track(new DeepeningEventStore({ maxEvents: 5 }));
    for (let i = 0; i < 10; i++) {
      store.record('test', { i });
    }
    assert.ok(store.getStats().totalEvents <= 5);
  });

  it('should emit event-recorded', () => {
    const store = _track(new DeepeningEventStore());
    let fired = false;
    store.on('event-recorded', () => { fired = true; });
    store.record('test', {});
    assert.ok(fired);
  });

  it('should emit typed events', () => {
    const store = _track(new DeepeningEventStore());
    let fired = false;
    store.on('event:test-type', () => { fired = true; });
    store.record('test-type', {});
    assert.ok(fired);
  });

  it('should clear and shutdown', () => {
    const store = _track(new DeepeningEventStore());
    store.record('test', {});
    store.clear();
    assert.equal(store.getStats().totalEvents, 0);
    store.shutdown();
    assert.ok(!store.isHealthy());
  });
});

describe('DeepeningWorkflowTemplate', () => {
  const DeepeningWorkflowTemplate = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-workflow-template'));

  it('should export TEMPLATE_TYPES', () => {
    assert.ok(DeepeningWorkflowTemplate.TEMPLATE_TYPES);
    assert.ok(DeepeningWorkflowTemplate.TEMPLATE_TYPES.CODE_REVIEW_DEEP);
    assert.ok(DeepeningWorkflowTemplate.TEMPLATE_TYPES.TDD_RED_GREEN);
    assert.ok(DeepeningWorkflowTemplate.TEMPLATE_TYPES.GENERAL_DEEPENING);
  });

  it('should get built-in templates', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    const t = wt.get(DeepeningWorkflowTemplate.TEMPLATE_TYPES.CODE_REVIEW_DEEP);
    assert.ok(t);
    assert.ok(t.name);
    assert.ok(t.stages);
    assert.ok(t.stages.length > 0);
  });

  it('should return null for unknown template', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    assert.equal(wt.get('nonexistent'), null);
  });

  it('should list all templates', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    const list = wt.list();
    assert.ok(list.length >= 6);
    assert.ok(list.some(t => t.builtIn));
  });

  it('should register custom templates', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    const result = wt.register('custom-1', {
      name: 'Custom Template',
      stages: [{ name: 'step1', agent: 'worker', skill: 'impl' }],
      depthLevel: 'deep',
    });
    assert.ok(result);
    const t = wt.get('custom-1');
    assert.ok(t);
    assert.equal(t.name, 'Custom Template');
  });

  it('should not overwrite built-in templates', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    const result = wt.register(DeepeningWorkflowTemplate.TEMPLATE_TYPES.CODE_REVIEW_DEEP, {
      name: 'Override',
      stages: [],
    });
    assert.ok(!result);
  });

  it('should unregister custom templates', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    wt.register('custom-1', { name: 'Test', stages: [{ name: 's1', agent: 'w', skill: 's' }] });
    assert.ok(wt.unregister('custom-1'));
    assert.equal(wt.get('custom-1'), null);
  });

  it('should not unregister built-in templates', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    assert.ok(!wt.unregister(DeepeningWorkflowTemplate.TEMPLATE_TYPES.CODE_REVIEW_DEEP));
  });

  it('should reject invalid template registrations', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    assert.equal(wt.register(null, {}), false);
    assert.equal(wt.register('test', null), false);
    assert.equal(wt.register('test', { name: 'No stages' }), false);
  });

  it('should create pipeline config from template', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    const config = wt.createPipelineConfig(DeepeningWorkflowTemplate.TEMPLATE_TYPES.CODE_REVIEW_DEEP);
    assert.ok(config);
    assert.ok(config.depthLevel);
    assert.ok(config.maxIterations);
    assert.ok(config.templateType);
  });

  it('should create pipeline config with overrides', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    const config = wt.createPipelineConfig(
      DeepeningWorkflowTemplate.TEMPLATE_TYPES.CODE_REVIEW_DEEP,
      { maxIterations: 10 },
    );
    assert.equal(config.maxIterations, 10);
  });

  it('should get stats', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    const stats = wt.getStats();
    assert.ok(stats.builtInTemplates >= 6);
    assert.equal(stats.customTemplates, 0);
  });

  it('should emit template-registered event', () => {
    const wt = _track(new DeepeningWorkflowTemplate());
    let fired = false;
    wt.on('template-registered', () => { fired = true; });
    wt.register('custom-1', { name: 'Test', stages: [{ name: 's1', agent: 'w', skill: 's' }] });
    assert.ok(fired);
  });
});

describe('DeepeningBenchmark', () => {
  const DeepeningBenchmark = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-benchmark'));

  it('should export BENCHMARK_TYPES', () => {
    assert.ok(DeepeningBenchmark.BENCHMARK_TYPES);
    assert.ok(DeepeningBenchmark.BENCHMARK_TYPES.THROUGHPUT);
    assert.ok(DeepeningBenchmark.BENCHMARK_TYPES.LATENCY);
  });

  it('should run a benchmark', async () => {
    const bench = _track(new DeepeningBenchmark({ warmupRuns: 0, measureRuns: 2 }));
    const pipeline = {
      run: async () => ({ success: true, bestScore: 0.85, iterations: 2, fromCache: false }),
    };
    const result = await bench.run('latency', pipeline, { id: 't1' }, []);
    assert.ok(result);
    assert.ok(result.measurements);
    assert.equal(result.measurements.length, 2);
    assert.ok(result.summary);
    assert.ok(result.summary.avgDuration >= 0);
  });

  it('should handle pipeline errors in benchmark', async () => {
    const bench = _track(new DeepeningBenchmark({ warmupRuns: 0, measureRuns: 1 }));
    const pipeline = {
      run: async () => { throw new Error('test error'); },
    };
    const result = await bench.run('latency', pipeline, { id: 't1' }, []);
    assert.ok(result);
    assert.ok(!result.measurements[0].success);
  });

  it('should run throughput benchmark', async () => {
    const bench = _track(new DeepeningBenchmark());
    const pipeline = {
      run: async () => {
        return { success: true, bestScore: 0.8, iterations: 1, fromCache: false };
      },
    };
    const result = await bench.runThroughput(pipeline, { id: 't1' }, [], 1000);
    assert.ok(result);
    assert.ok(result.throughputPerSecond >= 0);
    assert.ok(result.completedTasks > 0);
  });

  it('should get results', async () => {
    const bench = _track(new DeepeningBenchmark({ warmupRuns: 0, measureRuns: 1 }));
    const pipeline = {
      run: async () => ({ success: true, bestScore: 0.8, iterations: 1, fromCache: false }),
    };
    await bench.run('latency', pipeline, { id: 't1' }, []);
    const results = bench.getResults();
    assert.ok(results.length > 0);
  });

  it('should emit benchmark-complete event', async () => {
    const bench = _track(new DeepeningBenchmark({ warmupRuns: 0, measureRuns: 1 }));
    let fired = false;
    bench.on('benchmark-complete', () => { fired = true; });
    const pipeline = {
      run: async () => ({ success: true, bestScore: 0.8, iterations: 1, fromCache: false }),
    };
    await bench.run('latency', pipeline, { id: 't1' }, []);
    assert.ok(fired);
  });

  it('should return null for invalid inputs', async () => {
    const bench = _track(new DeepeningBenchmark());
    const result = await bench.run(null, null, null);
    assert.equal(result, null);
  });
});

describe('DeepeningOrchestrator Parallel Execution', () => {
  const DeepeningOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-orchestrator'));

  it('should execute agents in parallel when enabled', async () => {
    const orch = _track(new DeepeningOrchestrator({
      parallelAgentExecution: true,
      maxIterations: 1,
      topK: 3,
    }));

    const executionOrder = [];
    const agents = [
      {
        id: 'agent-a',
        execute: async () => {
          executionOrder.push('a-start');
          await new Promise(r => setTimeout(r, 50));
          executionOrder.push('a-end');
          return { success: true, qualityScore: 0.8 };
        },
      },
      {
        id: 'agent-b',
        execute: async () => {
          executionOrder.push('b-start');
          await new Promise(r => setTimeout(r, 30));
          executionOrder.push('b-end');
          return { success: true, qualityScore: 0.85 };
        },
      },
    ];

    await orch.execute({ id: 't1', description: 'parallel test' }, agents);
    const aStartIdx = executionOrder.indexOf('a-start');
    const bStartIdx = executionOrder.indexOf('b-start');
    assert.ok(bStartIdx - aStartIdx < 2, 'Agents should start close together (parallel)');
  });

  it('should execute agents sequentially when disabled', async () => {
    const orch = _track(new DeepeningOrchestrator({
      parallelAgentExecution: false,
      maxIterations: 1,
      topK: 3,
    }));

    const executionOrder = [];
    const agents = [
      {
        id: 'agent-a',
        execute: async () => {
          executionOrder.push('a-start');
          await new Promise(r => setTimeout(r, 50));
          executionOrder.push('a-end');
          return { success: true, qualityScore: 0.8 };
        },
      },
      {
        id: 'agent-b',
        execute: async () => {
          executionOrder.push('b-start');
          await new Promise(r => setTimeout(r, 50));
          executionOrder.push('b-end');
          return { success: true, qualityScore: 0.85 };
        },
      },
    ];

    await orch.execute({ id: 't1', description: 'sequential test' }, agents);
    const aEndIdx = executionOrder.indexOf('a-end');
    const bStartIdx = executionOrder.indexOf('b-start');
    assert.ok(bStartIdx > aEndIdx, 'Agent B should start after Agent A ends (sequential)');
  });

  it('should attach event store', () => {
    const DeepeningEventStore = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-event-store'));
    const orch = _track(new DeepeningOrchestrator());
    const eventStore = _track(new DeepeningEventStore());
    orch.attachEventStore(eventStore);
    const stats = orch.getStats();
    assert.equal(stats.attachedModules.eventStore, true);
  });

  it('should record events during execution', async () => {
    const DeepeningEventStore = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-event-store'));
    const orch = _track(new DeepeningOrchestrator({ maxIterations: 1 }));
    const eventStore = _track(new DeepeningEventStore());
    orch.attachEventStore(eventStore);

    const agent = {
      id: 'test-agent',
      execute: async () => ({ success: true, qualityScore: 0.85 }),
    };

    await orch.execute({ id: 't1', description: 'test' }, [agent]);
    const stats = eventStore.getStats();
    assert.ok(stats.totalEvents >= 2);
    const startEvents = eventStore.getByType(DeepeningEventStore.EVENT_TYPES.EXECUTION_START);
    const completeEvents = eventStore.getByType(DeepeningEventStore.EVENT_TYPES.EXECUTION_COMPLETE);
    assert.ok(startEvents.length >= 1);
    assert.ok(completeEvents.length >= 1);
  });
});

describe('Framework Integration: V7 Modules', () => {
  const { create } = require(path.join(ROOT, 'src', 'index'));

  it('should create framework with all v7 modules', () => {
    const framework = create(ROOT);
    assert.ok(framework.deepeningEventStore);
    assert.ok(framework.deepeningWorkflowTemplate);
    assert.ok(framework.deepeningBenchmark);
    framework.destroy();
  });

  it('should register health checks for v7 modules', async () => {
    const framework = create(ROOT);
    const result = await framework.healthChecker.checkAll();
    const checks = result.checks;
    const v7Modules = [
      'deepening-event-store',
      'deepening-workflow-template',
      'deepening-benchmark',
    ];
    for (const name of v7Modules) {
      assert.ok(checks[name], `Missing health check for ${name}`);
      assert.equal(checks[name].status, 'healthy', `${name} should be healthy`);
    }
    framework.destroy();
  });

  it('should export v7 modules from package', () => {
    const pkg = require(path.join(ROOT, 'src', 'index'));
    assert.ok(pkg.DeepeningEventStore);
    assert.ok(pkg.DeepeningWorkflowTemplate);
    assert.ok(pkg.DeepeningBenchmark);
  });

  it('should have event store attached to orchestrator', () => {
    const framework = create(ROOT);
    const stats = framework.deepeningOrchestrator.getStats();
    assert.equal(stats.attachedModules.eventStore, true);
    framework.destroy();
  });

  it('should have workflow templates available', () => {
    const framework = create(ROOT);
    const list = framework.deepeningWorkflowTemplate.list();
    assert.ok(list.length >= 6);
    framework.destroy();
  });
});
