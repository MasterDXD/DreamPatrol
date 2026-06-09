'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CausalBufferManager = require('../../../src/runtime/causal/causal-buffer-manager');
const { SharedConnectionPool, SharedLoadBalancer, SharedServiceRegistry, SharedFeatureFlags } = require('../../../src/runtime/infrastructure/shared-infrastructure');
const DeepeningDataPipeline = require('../../../src/runtime/deepening/deepening-data-pipeline');
const DeepeningStateManager = require('../../../src/runtime/deepening/deepening-state-manager');
const DocFreshnessGuard = require('../../../src/runtime/quality/doc-freshness-guard');
const HumanApprovalGate = require('../../../src/runtime/workflow/human-approval-gate');
const { SkillReducer } = require('../../../src/runtime/skill/skill-reducer');

describe('CausalBufferManager', () => {
  it('should construct with default options', () => {
    const mgr = new CausalBufferManager();
    assert.ok(mgr);
    assert.strictEqual(mgr.isHealthy(), true);
  });

  it('should return empty weights without dependencies', () => {
    const mgr = new CausalBufferManager();
    const weights = mgr.computeAttentionWeights('skill-a');
    assert.ok(weights instanceof Map);
    assert.strictEqual(weights.size, 0);
  });

  it('should attach causal data bus and skill router', () => {
    const mgr = new CausalBufferManager();
    const mockBus = { getCausalChain: () => [], getStats: () => ({}) };
    const mockRouter = { registry: {} };
    mgr.attachCausalDataBus(mockBus);
    mgr.attachSkillRouter(mockRouter);
    const stats = mgr.getBufferStats();
    assert.strictEqual(stats.hasCausalDataBus, true);
    assert.strictEqual(stats.hasSkillRouter, true);
  });

  it('should compute attention weights with dependencies', () => {
    const mgr = new CausalBufferManager();
    const mockBus = { getCausalChain: () => [{ skillId: 'skill-a' }], getStats: () => ({}) };
    const mockRouter = {
      registry: {
        'skill-b': { causal_inputs: [{ source: 'skill-a' }] },
        'skill-a': { causal_inputs: [] },
      },
    };
    mgr.attachCausalDataBus(mockBus);
    mgr.attachSkillRouter(mockRouter);
    const weights = mgr.computeAttentionWeights('skill-b');
    assert.ok(weights.has('skill-a'));
    assert.strictEqual(weights.get('skill-a'), 1.0);
  });

  it('should return compression strategy', () => {
    const mgr = new CausalBufferManager();
    const mockBus = { getCausalChain: () => [{ skillId: 'skill-a' }], getStats: () => ({}) };
    const mockRouter = {
      registry: {
        'skill-b': { causal_inputs: [{ source: 'skill-a' }] },
        'skill-a': { causal_inputs: [] },
      },
    };
    mgr.attachCausalDataBus(mockBus);
    mgr.attachSkillRouter(mockRouter);
    assert.strictEqual(mgr.getCompressionStrategy('skill-a', 'skill-b'), 'full');
    assert.strictEqual(mgr.getCompressionStrategy('unknown', 'skill-b'), 'discard');
  });

  it('should invalidate attention cache', () => {
    const mgr = new CausalBufferManager();
    const mockBus = { getCausalChain: () => [{ skillId: 'skill-a' }], getStats: () => ({}) };
    const mockRouter = { registry: { 'skill-b': { causal_inputs: [{ source: 'skill-a' }] }, 'skill-a': { causal_inputs: [] } } };
    mgr.attachCausalDataBus(mockBus);
    mgr.attachSkillRouter(mockRouter);
    mgr.computeAttentionWeights('skill-b');
    assert.strictEqual(mgr.getBufferStats().attentionCacheSize, 1);
    mgr.invalidateAttentionCache();
    assert.strictEqual(mgr.getBufferStats().attentionCacheSize, 0);
  });
});

describe('SharedConnectionPool', () => {
  it('should acquire and release connections', () => {
    const pool = new SharedConnectionPool({ maxConnections: 2 });
    const { connection: conn, error } = pool.acquire('test-1');
    assert.strictEqual(error, null);
    assert.ok(conn);
    assert.strictEqual(conn.id, 'test-1');
    assert.strictEqual(pool.getStats().active, 1);
    pool.release('test-1');
    assert.strictEqual(pool.getStats().active, 0);
    pool.shutdown();
  });

  it('should reject acquire when at capacity', () => {
    const pool = new SharedConnectionPool({ maxConnections: 1 });
    pool.acquire('c1');
    const { connection: conn2, error } = pool.acquire('c2');
    assert.strictEqual(conn2, null);
    assert.ok(error);
    assert.strictEqual(error.code, 'POOL_EXHAUSTED');
    pool.shutdown();
  });

  it('should reject acquire after shutdown', () => {
    const pool = new SharedConnectionPool();
    pool.shutdown();
    const { connection, error } = pool.acquire('x');
    assert.strictEqual(connection, null);
    assert.ok(error);
    assert.strictEqual(error.code, 'POOL_SHUTDOWN');
  });

  it('should use factory function when provided', () => {
    const pool = new SharedConnectionPool();
    const { connection: conn, error } = pool.acquire('x', () => ({ custom: true }));
    assert.strictEqual(error, null);
    assert.strictEqual(conn.custom, true);
    pool.shutdown();
  });

  it('should track stats correctly', () => {
    const pool = new SharedConnectionPool({ maxConnections: 5 });
    pool.acquire('a');
    pool.acquire('b');
    pool.release('a');
    const stats = pool.getStats();
    assert.strictEqual(stats.active, 1);
    assert.strictEqual(stats.totalAcquired, 2);
    assert.strictEqual(stats.totalReleased, 1);
    pool.shutdown();
  });

  it('should handle double shutdown', () => {
    const pool = new SharedConnectionPool();
    pool.shutdown();
    pool.shutdown();
  });

  it('should call onConnectionClose on shutdown', () => {
    const closedIds = [];
    const pool = new SharedConnectionPool({
      maxConnections: 5,
      onConnectionClose: (id) => { closedIds.push(id); },
    });
    pool.acquire('c1');
    pool.acquire('c2');
    pool.shutdown();
    assert.deepStrictEqual(closedIds.sort(), ['c1', 'c2']);
  });

  it('should return FACTORY_ERROR when factory throws', () => {
    const pool = new SharedConnectionPool({ maxConnections: 5 });
    const { connection, error } = pool.acquire('x', () => { throw new Error('factory fail'); });
    assert.strictEqual(connection, null);
    assert.ok(error);
    assert.strictEqual(error.code, 'FACTORY_ERROR');
    pool.shutdown();
  });
});

describe('SharedLoadBalancer', () => {
  it('should register and select endpoints round-robin', () => {
    const lb = new SharedLoadBalancer();
    lb.register('svc', ['ep1', 'ep2', 'ep3']);
    assert.strictEqual(lb.select('svc'), 'ep1');
    assert.strictEqual(lb.select('svc'), 'ep2');
    assert.strictEqual(lb.select('svc'), 'ep3');
    assert.strictEqual(lb.select('svc'), 'ep1');
    lb.shutdown();
  });

  it('should return null for unknown service', () => {
    const lb = new SharedLoadBalancer();
    assert.strictEqual(lb.select('unknown'), null);
    lb.shutdown();
  });

  it('should ignore invalid registration', () => {
    const lb = new SharedLoadBalancer();
    lb.register('', ['ep']);
    lb.register('svc', []);
    lb.register('svc', 'not-array');
    assert.strictEqual(lb.select('svc'), null);
    lb.shutdown();
  });

  it('should handle shutdown', () => {
    const lb = new SharedLoadBalancer();
    lb.shutdown();
    assert.strictEqual(lb.isHealthy(), false);
  });
});

describe('SharedServiceRegistry', () => {
  it('should register and retrieve services', () => {
    const reg = new SharedServiceRegistry();
    reg.register('db', { host: 'localhost' });
    const svc = reg.getService('db');
    assert.ok(svc);
    assert.strictEqual(svc.metadata.host, 'localhost');
    reg.shutdown();
  });

  it('should return null for unknown service', () => {
    const reg = new SharedServiceRegistry();
    assert.strictEqual(reg.getService('missing'), null);
    reg.shutdown();
  });

  it('should list all services', () => {
    const reg = new SharedServiceRegistry();
    reg.register('a', {});
    reg.register('b', {});
    assert.strictEqual(reg.listServices().length, 2);
    reg.shutdown();
  });

  it('should ignore invalid registration', () => {
    const reg = new SharedServiceRegistry();
    reg.register('', {});
    reg.register(123, {});
    assert.strictEqual(reg.listServices().length, 0);
    reg.shutdown();
  });
});

describe('SharedFeatureFlags', () => {
  it('should set and check flags', () => {
    const flags = new SharedFeatureFlags();
    flags.set('dark-mode', true, 'user request');
    assert.strictEqual(flags.isEnabled('dark-mode'), true);
    assert.strictEqual(flags.isEnabled('unknown'), false);
    assert.strictEqual(flags.isEnabled('unknown', true), true);
    flags.shutdown();
  });

  it('should track stats', () => {
    const flags = new SharedFeatureFlags();
    flags.set('a', true);
    flags.set('b', false);
    const stats = flags.getStats();
    assert.strictEqual(stats.totalFlags, 2);
    assert.strictEqual(stats.enabledCount, 1);
    assert.strictEqual(stats.disabledCount, 1);
    flags.shutdown();
  });

  it('should track history', () => {
    const flags = new SharedFeatureFlags({ maxHistory: 3 });
    flags.set('a', true);
    flags.set('a', false);
    flags.set('a', true);
    const stats = flags.getStats();
    assert.strictEqual(stats.historySize, 3);
    flags.set('a', false);
    assert.strictEqual(flags.getStats().historySize, 3);
    flags.shutdown();
  });
});

describe('DeepeningDataPipeline', () => {
  it('should create and remove pipelines', () => {
    const dp = new DeepeningDataPipeline();
    dp.create('test');
    assert.ok(dp.getPipelineInfo('test'));
    dp.remove('test');
    assert.strictEqual(dp.getPipelineInfo('test'), null);
    dp.shutdown();
  });

  it('should return this on duplicate create', () => {
    const dp = new DeepeningDataPipeline();
    dp.create('test');
    const result = dp.create('test');
    assert.strictEqual(result, dp);
    dp.shutdown();
  });

  it('should add stages and process data', async () => {
    const dp = new DeepeningDataPipeline();
    dp.create('etl');
    dp.addStage('etl', 'extract', (d) => d + '-extracted');
    dp.addStage('etl', 'transform', (d) => d.toUpperCase());
    const result = await dp.process('etl', 'data');
    assert.strictEqual(result, 'DATA-EXTRACTED');
    dp.shutdown();
  });

  it('should handle stage errors', async () => {
    const dp = new DeepeningDataPipeline();
    dp.create('fail-pipe');
    dp.addStage('fail-pipe', 'bad', () => { throw new Error('boom'); });
    let handlerCalled = false;
    dp.addErrorHandler('fail-pipe', () => { handlerCalled = true; });
    await assert.rejects(() => dp.process('fail-pipe', 'data'), { message: 'boom' });
    assert.strictEqual(handlerCalled, true);
    dp.shutdown();
  });

  it('should skip optional stages on failure', async () => {
    const dp = new DeepeningDataPipeline();
    dp.create('opt-pipe');
    dp.addStage('opt-pipe', 'step1', (d) => d + '-1');
    dp.addStage('opt-pipe', 'optional-fail', () => { throw new Error('skip me'); }, { optional: true });
    dp.addStage('opt-pipe', 'step3', (d) => d + '-3');
    const result = await dp.process('opt-pipe', 'start');
    assert.strictEqual(result, 'start-1-3');
    dp.shutdown();
  });

  it('should handle stage timeout', async () => {
    const dp = new DeepeningDataPipeline();
    dp.create('timeout-pipe');
    dp.addStage('timeout-pipe', 'slow', () => new Promise(r => setTimeout(r, 300)), { timeout: 50 });
    await assert.rejects(() => dp.process('timeout-pipe', 'data'), { message: /Stage timeout/ });
    dp.shutdown();
  });

  it('should throw on invalid pipeline name', () => {
    const dp = new DeepeningDataPipeline();
    assert.throws(() => dp.create(''), /Pipeline name is required/);
    dp.shutdown();
  });

  it('should throw on invalid stage', () => {
    const dp = new DeepeningDataPipeline();
    dp.create('p');
    assert.throws(() => dp.addStage('p', '', () => {}), /Stage name is required/);
    assert.throws(() => dp.addStage('p', 's', 'not-fn'), /Stage handler must be a function/);
    dp.shutdown();
  });

  it('should track stats', async () => {
    const dp = new DeepeningDataPipeline();
    dp.create('p');
    dp.addStage('p', 's', (d) => d);
    await dp.process('p', 'x');
    const stats = dp.getStats();
    assert.strictEqual(stats.totalProcessed, 1);
    assert.strictEqual(stats.totalSucceeded, 1);
    dp.shutdown();
  });

  it('should handle shutdown', () => {
    const dp = new DeepeningDataPipeline();
    dp.shutdown();
    dp.shutdown();
  });
});

describe('DeepeningStateManager', () => {
  it('should create and remove machines', () => {
    const sm = new DeepeningStateManager();
    sm.create('m1');
    assert.strictEqual(sm.getCurrentState('m1'), 'idle');
    sm.remove('m1');
    assert.strictEqual(sm.getCurrentState('m1'), null);
    sm.shutdown();
  });

  it('should create with custom initial state', () => {
    const sm = new DeepeningStateManager();
    sm.create('m1', { initialState: 'ready' });
    assert.strictEqual(sm.getCurrentState('m1'), 'ready');
    sm.shutdown();
  });

  it('should add states and transitions', () => {
    const sm = new DeepeningStateManager();
    sm.create('m1');
    sm.addState('m1', 'idle');
    sm.addState('m1', 'running');
    sm.addState('m1', 'done', { final: true });
    sm.addTransition('m1', 'idle', 'running', { event: 'start' });
    sm.addTransition('m1', 'running', 'done', { event: 'finish' });
    const info = sm.getMachineInfo('m1');
    assert.strictEqual(info.stateCount, 3);
    assert.strictEqual(info.transitionCount, 2);
    sm.shutdown();
  });

  it('should execute transitions', async () => {
    const sm = new DeepeningStateManager();
    sm.create('m1', { initialState: 'idle' });
    sm.addState('m1', 'idle');
    sm.addState('m1', 'running');
    sm.addTransition('m1', 'idle', 'running');
    await sm.transition('m1', 'running');
    assert.strictEqual(sm.getCurrentState('m1'), 'running');
    sm.shutdown();
  });

  it('should reject invalid transitions', async () => {
    const sm = new DeepeningStateManager();
    sm.create('m1', { initialState: 'idle' });
    sm.addState('m1', 'idle');
    sm.addState('m1', 'done');
    await assert.rejects(() => sm.transition('m1', 'done'), /Invalid transition/);
    sm.shutdown();
  });

  it('should support transition by event', async () => {
    const sm = new DeepeningStateManager();
    sm.create('m1', { initialState: 'idle' });
    sm.addState('m1', 'idle');
    sm.addState('m1', 'running');
    sm.addTransition('m1', 'idle', 'running', { event: 'start' });
    await sm.transitionByEvent('m1', 'start');
    assert.strictEqual(sm.getCurrentState('m1'), 'running');
    sm.shutdown();
  });

  it('should support guard conditions', () => {
    const sm = new DeepeningStateManager();
    sm.create('m1', { initialState: 'idle' });
    sm.addState('m1', 'idle');
    sm.addState('m1', 'running');
    sm.addTransition('m1', 'idle', 'running', { guard: (ctx) => ctx && ctx.authorized });
    assert.strictEqual(sm.canTransition('m1', 'idle', 'running', { authorized: true }), true);
    assert.strictEqual(sm.canTransition('m1', 'idle', 'running', { authorized: false }), false);
    sm.shutdown();
  });

  it('should execute onEnter and onExit callbacks', async () => {
    const sm = new DeepeningStateManager();
    const log = [];
    sm.create('m1', { initialState: 'idle' });
    sm.addState('m1', 'idle', { onExit: () => log.push('exit-idle') });
    sm.addState('m1', 'running', { onEnter: () => log.push('enter-running') });
    sm.addTransition('m1', 'idle', 'running');
    await sm.transition('m1', 'running');
    assert.deepStrictEqual(log, ['exit-idle', 'enter-running']);
    sm.shutdown();
  });

  it('should track history', async () => {
    const sm = new DeepeningStateManager();
    sm.create('m1', { initialState: 'a' });
    sm.addState('m1', 'a');
    sm.addState('m1', 'b');
    sm.addState('m1', 'c');
    sm.addTransition('m1', 'a', 'b');
    sm.addTransition('m1', 'b', 'c');
    await sm.transition('m1', 'b');
    await sm.transition('m1', 'c');
    const history = sm.getHistory('m1');
    assert.strictEqual(history.length, 2);
    sm.shutdown();
  });

  it('should reset machine', async () => {
    const sm = new DeepeningStateManager();
    sm.create('m1', { initialState: 'idle' });
    sm.addState('m1', 'idle');
    sm.addState('m1', 'running');
    sm.addTransition('m1', 'idle', 'running');
    await sm.transition('m1', 'running');
    sm.reset('m1');
    assert.strictEqual(sm.getCurrentState('m1'), 'idle');
    sm.shutdown();
  });

  it('should get available transitions', () => {
    const sm = new DeepeningStateManager();
    sm.create('m1', { initialState: 'idle' });
    sm.addState('m1', 'idle');
    sm.addState('m1', 'running');
    sm.addState('m1', 'done');
    sm.addTransition('m1', 'idle', 'running', { event: 'start' });
    sm.addTransition('m1', 'idle', 'done', { event: 'skip' });
    const avail = sm.getAvailableTransitions('m1');
    assert.strictEqual(avail.length, 2);
    sm.shutdown();
  });

  it('should throw on invalid create', () => {
    const sm = new DeepeningStateManager();
    assert.throws(() => sm.create(''), /non-empty string/);
    assert.throws(() => sm.create(123), /non-empty string/);
    sm.shutdown();
  });

  it('should handle shutdown', () => {
    const sm = new DeepeningStateManager();
    sm.shutdown();
    sm.shutdown();
  });
});

describe('DocFreshnessGuard', () => {
  it('should construct with project root', () => {
    const guard = new DocFreshnessGuard({ projectRoot: process.cwd() });
    assert.ok(guard);
    assert.strictEqual(guard.isHealthy(), true);
    guard.shutdown();
  });

  it('should construct without options', () => {
    const guard = new DocFreshnessGuard();
    assert.ok(guard);
    guard.shutdown();
  });

  it('should handle shutdown idempotently', () => {
    const guard = new DocFreshnessGuard({ projectRoot: process.cwd() });
    guard.shutdown();
    guard.shutdown();
  });
});

describe('HumanApprovalGate', () => {
  it('should construct with default options', () => {
    const gate = new HumanApprovalGate();
    assert.ok(gate);
    assert.strictEqual(gate.isHealthy(), true);
    gate.shutdown();
  });

  it('should request and approve', async () => {
    const gate = new HumanApprovalGate({ timeout: 5000 });
    const promise = gate.requestApproval({ agentId: 'agent-1', operation: 'deploy', target: 'prod', reason: 'release' });
    gate.approve('nonexistent');
    const pending = gate.getPending();
    assert.ok(pending.length > 0);
    gate.approve(pending[0].requestId, 'admin', 'looks good');
    const result = await promise;
    assert.strictEqual(result.approved, true);
    gate.shutdown();
  });

  it('should request and reject', async () => {
    const gate = new HumanApprovalGate({ timeout: 5000 });
    const promise = gate.requestApproval({ agentId: 'agent-1', operation: 'delete', target: 'db', reason: 'cleanup' });
    const pending = gate.getPending();
    gate.reject(pending[0].requestId, 'admin', 'too risky');
    const result = await promise;
    assert.strictEqual(result.approved, false);
    gate.shutdown();
  });

  it('should timeout on no response', async () => {
    const gate = new HumanApprovalGate({ timeout: 100 });
    const result = await gate.requestApproval({ agentId: 'agent-1', operation: 'test', target: 'x', reason: 'y' });
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.approved, false);
    gate.shutdown();
  });

  it('should track stats', () => {
    const gate = new HumanApprovalGate();
    const stats = gate.getStats();
    assert.ok(typeof stats === 'object');
    gate.shutdown();
  });

  it('should handle shutdown with pending requests', async () => {
    const gate = new HumanApprovalGate({ timeout: 60000 });
    gate.requestApproval({ agentId: 'a1', operation: 'op', target: 't', reason: 'r' });
    gate.shutdown();
    assert.strictEqual(gate.getPending().length, 0);
  });

  it('should handle double shutdown', () => {
    const gate = new HumanApprovalGate();
    gate.shutdown();
    gate.shutdown();
  });
});

describe('SkillReducer', () => {
  it('should construct with project root', () => {
    const reducer = new SkillReducer(process.cwd());
    assert.ok(reducer);
    reducer.shutdown();
  });

  it('should discover skills from .harness/skills', () => {
    const reducer = new SkillReducer(process.cwd());
    const skills = reducer.discover();
    assert.ok(Array.isArray(skills));
    reducer.shutdown();
  });

  it('should get stats', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const stats = reducer.getStats();
    assert.ok(typeof stats === 'object');
    assert.ok(typeof stats.l1Count === 'number');
    reducer.shutdown();
  });

  it('should match L1 entries', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const matches = reducer.matchL1({ userMessage: 'implement feature', agent: 'task-worker' });
    assert.ok(Array.isArray(matches));
    reducer.shutdown();
  });

  it('should handle invalid matchL1 input', () => {
    const reducer = new SkillReducer(process.cwd());
    assert.deepStrictEqual(reducer.matchL1(null), []);
    assert.deepStrictEqual(reducer.matchL1('string'), []);
    reducer.shutdown();
  });

  it('should get context estimate', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const est = reducer.getContextEstimate();
    assert.ok(typeof est.totalTokens === 'number');
    reducer.shutdown();
  });

  it('should handle shutdown', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.shutdown();
    reducer.shutdown();
  });
});

describe('SkillReducer - Dynamic Skill Management', () => {
  it('should classify skill layers', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const layer = reducer.classifySkillLayer('tdd-implement');
    assert.ok(layer === 'core' || layer === 'domain' || layer === 'infrastructure');
    reducer.shutdown();
  });

  it('should get skills by layer', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const coreSkills = reducer.getSkillsByLayer('core');
    assert.ok(Array.isArray(coreSkills));
    const domainSkills = reducer.getSkillsByLayer('domain');
    assert.ok(Array.isArray(domainSkills));
    reducer.shutdown();
  });

  it('should get layer distribution', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const dist = reducer.getLayerDistribution();
    assert.ok(typeof dist === 'object');
    assert.ok(typeof dist.core === 'number' || dist.core === undefined);
    assert.ok(typeof dist.domain === 'number' || dist.domain === undefined);
    reducer.shutdown();
  });

  it('should match top K skills', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const topK = reducer.matchTopK({ userMessage: 'implement feature', agent: 'task-worker' }, 2);
    assert.ok(Array.isArray(topK));
    assert.ok(topK.length <= 2);
    reducer.shutdown();
  });

  it('should compress skill summary', () => {
    const reducer = new SkillReducer(process.cwd());
    const compressed = reducer.compressSkillSummary('This is a long summary about test-driven development and feature implementation');
    assert.ok(typeof compressed === 'string');
    assert.ok(compressed.length <= 50);
    reducer.shutdown();
  });

  it('should compress empty summary', () => {
    const reducer = new SkillReducer(process.cwd());
    assert.strictEqual(reducer.compressSkillSummary(''), '');
    assert.strictEqual(reducer.compressSkillSummary(null), '');
    reducer.shutdown();
  });

  it('should get compressed L1 entries', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const entries = reducer.getCompressedL1Entries();
    assert.ok(Array.isArray(entries));
    if (entries.length > 0) {
      assert.ok(entries[0].compressed_summary !== undefined);
      assert.ok(entries[0].skill_layer !== undefined);
    }
    reducer.shutdown();
  });

  it('should detect overload', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const result = reducer.detectOverload();
    assert.ok(result.level === 'none' || result.level === 'warning' || result.level === 'critical');
    assert.ok(typeof result.l2Cached === 'number');
    assert.ok(typeof result.l1Count === 'number');
    reducer.shutdown();
  });

  it('should detect overload with token budget', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const result = reducer.detectOverload(100);
    assert.ok(typeof result.tokenRatio === 'number');
    reducer.shutdown();
  });

  it('should activate and deactivate skills for task', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const skillIds = reducer.activateForTask('task-1', { userMessage: 'implement feature', agent: 'task-worker' });
    assert.ok(Array.isArray(skillIds));
    const active = reducer.getActiveTaskSkills();
    assert.ok(Array.isArray(active));
    const unloaded = reducer.deactivateAfterTask('task-1', true);
    assert.ok(Array.isArray(unloaded));
    reducer.shutdown();
  });

  it('should handle activate with invalid signature', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    assert.deepStrictEqual(reducer.activateForTask('', {}), []);
    assert.deepStrictEqual(reducer.activateForTask(null, {}), []);
    reducer.shutdown();
  });

  it('should handle deactivate with unknown task', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    assert.deepStrictEqual(reducer.deactivateAfterTask('unknown-task', true), []);
    reducer.shutdown();
  });

  it('should not unload core skills', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const coreSkills = reducer.getSkillsByLayer('core');
    if (coreSkills.length > 0) {
      const result = reducer.unloadL2(coreSkills[0]);
      assert.strictEqual(result, false);
    }
    reducer.shutdown();
  });
});

describe('SkillReducer - Context & Lifecycle', () => {
  it('should get compressed context estimate', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const est = reducer.getCompressedContextEstimate();
    assert.ok(typeof est.totalTokens === 'number');
    assert.ok(typeof est.compressionSavings === 'number');
    reducer.shutdown();
  });

  it('should attach event source and handle events', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const { EventEmitter } = require('events');
    const emitter = new EventEmitter();
    reducer.attachEventSource(emitter);
    reducer.activateForTask('evt-task', { userMessage: 'test', agent: 'task-worker' });
    emitter.emit('task:completed', { taskSignature: 'evt-task' });
    reducer.attachEventSource(null);
    reducer.shutdown();
  });

  it('should preload core skills on discover', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const stats = reducer.getStats();
    assert.ok(stats.l2Cached >= 0);
    reducer.shutdown();
  });

  it('should reload core skills after unloadAllL2', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    reducer.unloadAllL2();
    const stats = reducer.getStats();
    assert.ok(stats.l2Cached >= 0);
    reducer.shutdown();
  });

  it('should include new stats fields', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const stats = reducer.getStats();
    assert.ok(typeof stats.topKTruncations === 'number');
    assert.ok(typeof stats.overloadDetections === 'number');
    assert.ok(typeof stats.autoUnloads === 'number');
    assert.ok(typeof stats.taskActivations === 'number');
    assert.ok(typeof stats.taskDeactivations === 'number');
    assert.ok(typeof stats.compressedSummariesGenerated === 'number');
    assert.ok(typeof stats.activeTaskCount === 'number');
    assert.ok(typeof stats.layerDistribution === 'object');
    assert.ok(typeof stats.compressedContextEstimate === 'object');
    reducer.shutdown();
  });

  it('should expose static layer constants', () => {
    assert.strictEqual(SkillReducer.SKILL_LAYER_CORE, 'core');
    assert.strictEqual(SkillReducer.SKILL_LAYER_DOMAIN, 'domain');
    assert.strictEqual(SkillReducer.SKILL_LAYER_INFRASTRUCTURE, 'infrastructure');
    assert.ok(typeof SkillReducer.DEFAULT_TOP_K === 'number');
    assert.ok(typeof SkillReducer.DEFAULT_OVERLOAD_THRESHOLD === 'number');
    assert.ok(typeof SkillReducer.DEFAULT_COMPRESSED_SUMMARY_MAX_LENGTH === 'number');
    assert.ok(typeof SkillReducer.DEFAULT_AUTO_UNLOAD_DELAY_MS === 'number');
  });

  it('should return empty for matchTopK with k=0', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const result = reducer.matchTopK({ userMessage: 'implement', agent: 'task-worker' }, 0);
    assert.deepStrictEqual(result, []);
    reducer.shutdown();
  });

  it('should return empty for matchTopK with negative k', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const result = reducer.matchTopK({ userMessage: 'implement', agent: 'task-worker' }, -1);
    assert.deepStrictEqual(result, []);
    reducer.shutdown();
  });

  it('should detect overload with zero token budget', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    const result = reducer.detectOverload(0);
    assert.ok(result.level === 'none' || result.level === 'warning' || result.level === 'critical');
    assert.strictEqual(result.tokenRatio, undefined);
    reducer.shutdown();
  });

  it('should compress CJK summary', () => {
    const reducer = new SkillReducer(process.cwd());
    const compressed = reducer.compressSkillSummary('这是一个关于测试驱动开发的技能描述');
    assert.ok(typeof compressed === 'string');
    assert.ok(compressed.length > 0);
    reducer.shutdown();
  });

  it('should return empty array on delayed deactivate', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    reducer.activateForTask('delay-test', { userMessage: 'implement', agent: 'task-worker' });
    const result = reducer.deactivateAfterTask('delay-test', false);
    assert.deepStrictEqual(result, []);
    reducer.shutdown();
  });

  it('should classify unknown skill as null', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    assert.strictEqual(reducer.classifySkillLayer('nonexistent-skill-id'), null);
    reducer.shutdown();
  });

  it('should get skills by unknown layer as empty', () => {
    const reducer = new SkillReducer(process.cwd());
    reducer.discover();
    assert.deepStrictEqual(reducer.getSkillsByLayer('unknown-layer'), []);
    reducer.shutdown();
  });
});
