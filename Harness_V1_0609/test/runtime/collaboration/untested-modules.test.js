'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}

describe('ChatChain', () => {
  const ChatChain = require(path.join(ROOT, 'src', 'runtime', 'collaboration', 'chat-chain'));

  afterEach(async () => { await _cleanAll(); });

  it('should construct with default options', () => {
    const chain = _track(new ChatChain());
    assert.ok(chain);
    assert.strictEqual(chain.isHealthy(), true);
  });

  it('should create chain for known phase', () => {
    const chain = _track(new ChatChain());
    const result = chain.createChain('brainstorming');
    assert.ok(result.chainId);
    assert.ok(result.tasks);
    assert.ok(result.tasks.length >= 2);
  });

  it('should return error for unknown phase', () => {
    const chain = _track(new ChatChain());
    const result = chain.createChain('unknown-phase');
    assert.strictEqual(result.chainId, null);
    assert.ok(result.error);
  });

  it('should return error for missing phase', () => {
    const chain = _track(new ChatChain());
    const result = chain.createChain(null);
    assert.strictEqual(result.chainId, null);
    assert.ok(result.error);
  });

  it('should create chain with custom tasks', () => {
    const chain = _track(new ChatChain());
    const result = chain.createChain('custom', [
      { taskId: 'task-1', agent: 'worker', skill: 'test', description: 'Test task', required: true },
    ]);
    assert.ok(result.chainId);
    assert.strictEqual(result.tasks.length, 1);
  });

  it('should complete task in chain', () => {
    const chain = _track(new ChatChain());
    const { chainId, tasks } = chain.createChain('brainstorming');
    const result = chain.completeTask(chainId, tasks[0].taskId, { output: 'done' });
    assert.ok(result);
  });

  it('should get chain progress', () => {
    const chain = _track(new ChatChain());
    const { chainId } = chain.createChain('brainstorming');
    const progress = chain.getChainProgress(chainId);
    assert.ok(progress);
  });

  it('should get chain by id', () => {
    const chain = _track(new ChatChain());
    const { chainId } = chain.createChain('brainstorming');
    const retrieved = chain.getChain(chainId);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.chainId, chainId);
  });

  it('should get stats', () => {
    const chain = _track(new ChatChain());
    chain.createChain('brainstorming');
    const stats = chain.getStats();
    assert.ok(stats);
    assert.strictEqual(stats.totalChains, 1);
  });

  it('should shutdown cleanly', () => {
    const chain = _track(new ChatChain());
    chain.createChain('brainstorming');
    chain.shutdown();
    assert.strictEqual(chain._shutDown, true);
  });
});

describe('IsolatedContextManager', () => {
  const IsolatedContextManager = require(path.join(ROOT, 'src', 'runtime', 'context', 'isolated-context-manager'));

  afterEach(async () => { await _cleanAll(); });

  it('should construct with default options', () => {
    const mgr = _track(new IsolatedContextManager());
    assert.ok(mgr);
  });

  it('should create isolated context', () => {
    const mgr = _track(new IsolatedContextManager());
    const ctx = mgr.createIsolatedContext({
      taskDescription: 'Test task',
      agentId: 'task-worker',
    });
    assert.ok(ctx);
    assert.ok(ctx.contextId);
    assert.strictEqual(ctx.agentId, 'task-worker');
    assert.ok(Array.isArray(ctx.toolSet));
  });

  it('should return null for missing taskDescription', () => {
    const mgr = _track(new IsolatedContextManager());
    const ctx = mgr.createIsolatedContext({});
    assert.strictEqual(ctx, null);
  });

  it('should assign default tool set by agent role', () => {
    const mgr = _track(new IsolatedContextManager());
    const ctx = mgr.createIsolatedContext({
      taskDescription: 'Test task',
      agentId: 'domain-analyst',
    });
    assert.ok(ctx.toolSet.includes('read'));
    assert.ok(ctx.toolSet.includes('search'));
  });

  it('should grant context access to another agent', () => {
    const mgr = _track(new IsolatedContextManager());
    const ctx = mgr.createIsolatedContext({
      taskDescription: 'Test task',
      agentId: 'task-worker',
    });
    const result = mgr.grantContextAccess(ctx.contextId, 'domain-analyst');
    assert.strictEqual(result, true);
  });

  it('should return false for granting access to nonexistent context', () => {
    const mgr = _track(new IsolatedContextManager());
    const result = mgr.grantContextAccess('nonexistent', 'agent');
    assert.strictEqual(result, false);
  });

  it('should get context by id', () => {
    const mgr = _track(new IsolatedContextManager());
    const ctx = mgr.createIsolatedContext({
      taskDescription: 'Test task',
      agentId: 'task-worker',
    });
    const retrieved = mgr.getContext(ctx.contextId);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.contextId, ctx.contextId);
  });

  it('should submit result to context', () => {
    const mgr = _track(new IsolatedContextManager());
    const ctx = mgr.createIsolatedContext({
      taskDescription: 'Test task',
      agentId: 'task-worker',
    });
    const result = mgr.submitResult(ctx.contextId, { output: 'done' });
    assert.ok(result);
  });

  it('should release context', () => {
    const mgr = _track(new IsolatedContextManager());
    const ctx = mgr.createIsolatedContext({
      taskDescription: 'Test task',
      agentId: 'task-worker',
    });
    const result = mgr.releaseContext(ctx.contextId);
    assert.ok(result);
  });

  it('should get active contexts', () => {
    const mgr = _track(new IsolatedContextManager());
    mgr.createIsolatedContext({ taskDescription: 'Task 1', agentId: 'worker' });
    mgr.createIsolatedContext({ taskDescription: 'Task 2', agentId: 'worker' });
    const active = mgr.getActiveContexts();
    assert.strictEqual(active.length, 2);
  });

  it('should get stats', () => {
    const mgr = _track(new IsolatedContextManager());
    mgr.createIsolatedContext({ taskDescription: 'Task 1', agentId: 'worker' });
    const stats = mgr.getStats();
    assert.ok(stats);
  });

  it('should evict oldest when max contexts reached', () => {
    const mgr = _track(new IsolatedContextManager({ maxContexts: 2 }));
    mgr.createIsolatedContext({ taskDescription: 'Task 1', agentId: 'worker' });
    mgr.createIsolatedContext({ taskDescription: 'Task 2', agentId: 'worker' });
    mgr.createIsolatedContext({ taskDescription: 'Task 3', agentId: 'worker' });
    assert.strictEqual(mgr._contexts.size, 2);
  });

  it('should shutdown cleanly', () => {
    const mgr = _track(new IsolatedContextManager());
    mgr.shutdown();
    assert.strictEqual(mgr._shutDown, true);
  });
});

describe('LTIContextInjector', () => {
  const LTIContextInjector = require(path.join(ROOT, 'src', 'runtime', 'context', 'lti-context-injector'));

  afterEach(async () => { await _cleanAll(); });

  it('should construct with default options', () => {
    const injector = _track(new LTIContextInjector());
    assert.ok(injector);
    assert.strictEqual(injector._mode, 'lti');
  });

  it('should register original context', () => {
    const injector = _track(new LTIContextInjector());
    injector.registerOriginalContext('task-1', { description: 'Original task', goal: 'Test goal' });
    assert.ok(injector._originalContexts.has('task-1'));
  });

  it('should ignore invalid taskId', () => {
    const injector = _track(new LTIContextInjector());
    injector.registerOriginalContext(null, { description: 'Test' });
    injector.registerOriginalContext('', { description: 'Test' });
    assert.strictEqual(injector._originalContexts.size, 0);
  });

  it('should inject context into current task', () => {
    const injector = _track(new LTIContextInjector());
    injector.registerOriginalContext('task-1', { description: 'Original', goal: 'Test goal', constraints: ['c1'] });
    const result = injector.inject('task-1', { description: 'Current' }, 0);
    assert.ok(result._ltiContext);
    assert.strictEqual(result._ltiContext.mode, 'lti');
  });

  it('should return current task if no original registered', () => {
    const injector = _track(new LTIContextInjector());
    const current = { description: 'Current task' };
    const result = injector.inject('nonexistent', current, 0);
    assert.strictEqual(result, current);
  });

  it('should emit context-registered event', () => {
    const injector = _track(new LTIContextInjector());
    let fired = false;
    injector.on('context-registered', () => { fired = true; });
    injector.registerOriginalContext('task-1', { description: 'Test' });
    assert.strictEqual(fired, true);
  });

  it('should emit context-injected event', () => {
    const injector = _track(new LTIContextInjector());
    injector.registerOriginalContext('task-1', { description: 'Original' });
    let fired = false;
    injector.on('context-injected', () => { fired = true; });
    injector.inject('task-1', { description: 'Current' }, 0);
    assert.strictEqual(fired, true);
  });

  it('should get injection history', () => {
    const injector = _track(new LTIContextInjector());
    injector.registerOriginalContext('task-1', { description: 'Original' });
    injector.inject('task-1', { description: 'Current' }, 0);
    const history = injector.getInjectionHistory('task-1');
    assert.ok(Array.isArray(history));
    assert.strictEqual(history.length, 1);
  });

  it('should shutdown cleanly', () => {
    const injector = _track(new LTIContextInjector());
    injector.shutdown();
    assert.strictEqual(injector._shutDown, true);
  });
});

describe('SelfReflection', () => {
  const SelfReflection = require(path.join(ROOT, 'src', 'runtime', 'quality', 'self-reflection'));

  afterEach(async () => { await _cleanAll(); });

  it('should construct with default config', () => {
    const sr = _track(new SelfReflection());
    assert.ok(sr);
    assert.strictEqual(sr._config.maxReflections, 3);
  });

  it('should perform reflection on code artifact', () => {
    const sr = _track(new SelfReflection());
    const result = sr.reflect({
      agentId: 'task-worker',
      skillId: 'tdd-implement',
      artifactType: 'code',
      artifact: 'function add(a, b) { return a + b; }',
    });
    assert.ok(result);
    assert.ok(result.reflectionId);
    assert.ok(result.dimensions || result.scores || result.selfCheckPrompt);
  });

  it('should return error for missing required fields', () => {
    const sr = _track(new SelfReflection());
    const result = sr.reflect({});
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });

  it('should use design templates for design artifact', () => {
    const sr = _track(new SelfReflection());
    const result = sr.reflect({
      agentId: 'domain-analyst',
      skillId: 'architecture-design',
      artifactType: 'design',
      artifact: 'System uses microservices pattern',
    });
    assert.ok(result);
    assert.ok(result.reflectionId);
  });

  it('should get agent reflections', () => {
    const sr = _track(new SelfReflection());
    sr.reflect({
      agentId: 'task-worker',
      skillId: 'tdd-implement',
      artifactType: 'code',
      artifact: 'test code',
    });
    const reflections = sr.getAgentReflections('task-worker');
    assert.ok(Array.isArray(reflections));
  });

  it('should get stats', () => {
    const sr = _track(new SelfReflection());
    sr.reflect({
      agentId: 'task-worker',
      skillId: 'tdd-implement',
      artifactType: 'code',
      artifact: 'test code',
    });
    const stats = sr.getStats();
    assert.strictEqual(stats.totalReflections, 1);
  });

  it('should shutdown cleanly', () => {
    const sr = _track(new SelfReflection());
    sr.shutdown();
    assert.strictEqual(sr._shutDown, true);
  });
});

describe('PlanPersistence', () => {
  const PlanPersistence = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'plan-persistence'));
  const TEST_DIR = path.join(os.tmpdir(), 'harness-plan-test-' + Date.now());

  afterEach(async () => { await _cleanAll(); });

  it('should construct with project root', () => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace'), { recursive: true });
    const pp = _track(new PlanPersistence(TEST_DIR));
    assert.ok(pp);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should create a plan', () => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace'), { recursive: true });
    const pp = _track(new PlanPersistence(TEST_DIR));
    const plan = pp.createPlan('session-1', {
      objective: 'Build feature X',
      strategy: 'TDD approach',
      tasks: [{ description: 'Write tests', agent: 'worker', status: 'pending' }],
    });
    assert.ok(plan);
    assert.ok(plan.planId);
    assert.strictEqual(plan.objective, 'Build feature X');
    assert.strictEqual(plan.version, 1);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should return null for missing sessionId or plan', () => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace'), { recursive: true });
    const pp = _track(new PlanPersistence(TEST_DIR));
    assert.strictEqual(pp.createPlan(null, {}), null);
    assert.strictEqual(pp.createPlan('s1', null), null);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should update a plan', () => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace'), { recursive: true });
    const pp = _track(new PlanPersistence(TEST_DIR));
    const plan = pp.createPlan('session-1', { objective: 'Test' });
    const updated = pp.updatePlan(plan.planId, { strategy: 'Updated strategy' });
    assert.ok(updated);
    assert.strictEqual(updated.strategy, 'Updated strategy');
    assert.strictEqual(updated.version, 2);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should return null for updating nonexistent plan', () => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace'), { recursive: true });
    const pp = _track(new PlanPersistence(TEST_DIR));
    const result = pp.updatePlan('nonexistent', { strategy: 'test' });
    assert.strictEqual(result, null);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should load plan by id', async () => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace'), { recursive: true });
    const pp = _track(new PlanPersistence(TEST_DIR));
    const plan = pp.createPlan('session-1', { objective: 'Test' });
    const loaded = await pp.loadPlan(plan.planId);
    assert.ok(loaded);
    assert.strictEqual(loaded.planId, plan.planId);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should get active plan for session', () => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace'), { recursive: true });
    const pp = _track(new PlanPersistence(TEST_DIR));
    pp.createPlan('session-1', { objective: 'Test' });
    const active = pp.getActivePlan('session-1');
    assert.ok(active);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should get stats', () => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace'), { recursive: true });
    const pp = _track(new PlanPersistence(TEST_DIR));
    pp.createPlan('session-1', { objective: 'Test' });
    const stats = pp.getStats();
    assert.strictEqual(stats.created, 1);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should shutdown cleanly', () => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace'), { recursive: true });
    const pp = _track(new PlanPersistence(TEST_DIR));
    pp.shutdown();
    assert.strictEqual(pp._shutDown, true);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });
});

describe('PairChat - Cross-Validation Protocol', () => {
  const PairChat = require(path.join(ROOT, 'src', 'runtime', 'collaboration', 'pair-chat'));

  afterEach(async () => { await _cleanAll(); });

  it('should start cross-validation session', () => {
    const pc = _track(new PairChat());
    const result = pc.startCrossValidation({
      agentA: 'programmer',
      agentB: 'reviewer',
      artifact: 'function add(a, b) { return a + b; }',
      artifactType: 'code',
      validationCriteria: [
        { id: 'correctness', description: 'Output is correct', required: true },
        { id: 'security', description: 'No security issues', required: true },
      ],
    });
    assert.ok(result.sessionId);
    assert.ok(result.sessionId.startsWith('xval-'));
    assert.strictEqual(result.mode, 'bidirectional');
    assert.strictEqual(result.criteriaCount, 2);
  });

  it('should require agentA and agentB', () => {
    const pc = _track(new PairChat());
    const result = pc.startCrossValidation({ artifact: 'code' });
    assert.strictEqual(result.sessionId, null);
    assert.ok(result.error);
  });

  it('should require artifact', () => {
    const pc = _track(new PairChat());
    const result = pc.startCrossValidation({ agentA: 'a', agentB: 'b' });
    assert.strictEqual(result.sessionId, null);
    assert.ok(result.error);
  });

  it('should add cross-validation round with hallucination tracking', () => {
    const pc = _track(new PairChat());
    const { sessionId } = pc.startCrossValidation({
      agentA: 'programmer',
      agentB: 'reviewer',
      artifact: 'code',
    });
    const result = pc.addCrossValidationRound(sessionId, {
      proposerOutput: 'revised code',
      reviewerFeedback: 'looks good',
      corrections: [
        { description: 'typo fix', isHallucination: false },
        { description: 'hallucinated API call', isHallucination: true, severity: 'high' },
      ],
      approved: false,
      direction: 'A-to-B',
    });
    assert.ok(result.round);
    assert.strictEqual(result.hallucinationCorrectionsCount, 1);
    assert.strictEqual(result.consensus, 'pending');
  });

  it('should reject round for non-cross-validation session', () => {
    const pc = _track(new PairChat());
    const { sessionId } = pc.startSession({
      proposer: 'a',
      reviewer: 'b',
      artifact: 'code',
    });
    const result = pc.addCrossValidationRound(sessionId, {
      proposerOutput: 'test',
      corrections: [],
      approved: true,
    });
    assert.strictEqual(result.error, 'Not a cross-validation session');
  });

  it('should track criteria results in cross-validation', () => {
    const pc = _track(new PairChat());
    const { sessionId } = pc.startCrossValidation({
      agentA: 'a',
      agentB: 'b',
      artifact: 'code',
      validationCriteria: [
        { id: 'correctness', description: 'Output correct', required: true },
        { id: 'security', description: 'No security issues', required: true },
      ],
    });
    pc.addCrossValidationRound(sessionId, {
      proposerOutput: 'code',
      corrections: [],
      approved: false,
      direction: 'A-to-B',
      criteriaResults: {
        correctness: { passed: true, checkedBy: 'A-to-B' },
        security: { passed: false, checkedBy: 'A-to-B' },
      },
    });
    const report = pc.getCrossValidationReport(sessionId);
    assert.ok(report);
    assert.strictEqual(report.criteriaSummary.total, 2);
    assert.strictEqual(report.criteriaSummary.passed, 1);
    assert.strictEqual(report.criteriaSummary.failed, 1);
  });

  it('should generate cross-validation report', () => {
    const pc = _track(new PairChat());
    const { sessionId } = pc.startCrossValidation({
      agentA: 'programmer',
      agentB: 'reviewer',
      artifact: 'code',
      mode: 'bidirectional',
      validationCriteria: [
        { id: 'test', description: 'Test criteria', required: true },
      ],
    });
    pc.addCrossValidationRound(sessionId, {
      proposerOutput: 'code v1',
      corrections: [{ description: 'hallucinated import', isHallucination: true, severity: 'critical' }],
      approved: false,
      direction: 'A-to-B',
    });
    pc.addCrossValidationRound(sessionId, {
      proposerOutput: 'code v2',
      corrections: [],
      approved: true,
      direction: 'B-to-A',
      criteriaResults: { test: { passed: true, checkedBy: 'B-to-A' } },
    });
    const report = pc.getCrossValidationReport(sessionId);
    assert.ok(report);
    assert.strictEqual(report.mode, 'bidirectional');
    assert.strictEqual(report.hallucinationCorrections, 1);
    assert.strictEqual(report.hallucinationBySeverity.critical, 1);
    assert.strictEqual(report.directionARounds, 1);
    assert.strictEqual(report.directionBRounds, 1);
    assert.ok(report.bidirectionalResults);
    assert.strictEqual(report.bidirectionalResults.directionA.hallucinations, 1);
    assert.strictEqual(report.bidirectionalResults.directionB.hallucinations, 0);
  });

  it('should return null for non-cross-validation report', () => {
    const pc = _track(new PairChat());
    const { sessionId } = pc.startSession({
      proposer: 'a',
      reviewer: 'b',
      artifact: 'code',
    });
    assert.strictEqual(pc.getCrossValidationReport(sessionId), null);
  });

  it('should return null for nonexistent session report', () => {
    const pc = _track(new PairChat());
    assert.strictEqual(pc.getCrossValidationReport('nonexistent'), null);
  });
});

describe('PairChat - Cross-Validation Stats & Events', () => {
  const PairChat = require(path.join(ROOT, 'src', 'runtime', 'collaboration', 'pair-chat'));

  afterEach(async () => { await _cleanAll(); });

  it('should track cross-validation stats', () => {
    const pc = _track(new PairChat());
    pc.startCrossValidation({ agentA: 'a', agentB: 'b', artifact: 'code' });
    const stats = pc.getCrossValidationStats();
    assert.strictEqual(stats.totalCrossValidations, 1);
  });

  it('should include cross-validation in getStats', () => {
    const pc = _track(new PairChat());
    pc.startCrossValidation({ agentA: 'a', agentB: 'b', artifact: 'code' });
    const stats = pc.getStats();
    assert.ok(stats.crossValidation);
    assert.strictEqual(stats.crossValidation.totalCrossValidations, 1);
  });

  it('should emit hallucination-detected event', () => {
    const pc = _track(new PairChat());
    let detected = false;
    pc.on('hallucination-detected', () => { detected = true; });
    const { sessionId } = pc.startCrossValidation({ agentA: 'a', agentB: 'b', artifact: 'code' });
    pc.addCrossValidationRound(sessionId, {
      corrections: [{ description: 'hallucination', isHallucination: true, severity: 'medium' }],
      approved: false,
      direction: 'A-to-B',
    });
    assert.strictEqual(detected, true);
  });

  it('should emit cross-validation-started event', () => {
    const pc = _track(new PairChat());
    let started = false;
    pc.on('cross-validation-started', () => { started = true; });
    pc.startCrossValidation({ agentA: 'a', agentB: 'b', artifact: 'code' });
    assert.strictEqual(started, true);
  });

  it('should support unidirectional mode', () => {
    const pc = _track(new PairChat());
    const result = pc.startCrossValidation({
      agentA: 'a',
      agentB: 'b',
      artifact: 'code',
      mode: 'unidirectional',
    });
    assert.strictEqual(result.mode, 'unidirectional');
  });

  it('should export CROSS_VALIDATION_MODES and HALLUCINATION_SEVERITY', () => {
    assert.ok(PairChat.CROSS_VALIDATION_MODES);
    assert.ok(PairChat.HALLUCINATION_SEVERITY);
    assert.strictEqual(PairChat.CROSS_VALIDATION_MODES.BIDIRECTIONAL, 'bidirectional');
    assert.strictEqual(PairChat.HALLUCINATION_SEVERITY.CRITICAL, 'critical');
  });

  it('should reject null roundData in addCrossValidationRound', () => {
    const pc = _track(new PairChat());
    const { sessionId } = pc.startCrossValidation({ agentA: 'a', agentB: 'b', artifact: 'code' });
    const result = pc.addCrossValidationRound(sessionId, null);
    assert.strictEqual(result.error, 'roundData is required');
    assert.strictEqual(result.round, null);
  });

  it('should reject undefined roundData in addCrossValidationRound', () => {
    const pc = _track(new PairChat());
    const { sessionId } = pc.startCrossValidation({ agentA: 'a', agentB: 'b', artifact: 'code' });
    const result = pc.addCrossValidationRound(sessionId);
    assert.strictEqual(result.error, 'roundData is required');
    assert.strictEqual(result.round, null);
  });

  it('should emit cross-validation-completed on consensus', () => {
    const pc = _track(new PairChat());
    let completed = false;
    pc.on('cross-validation-completed', () => { completed = true; });
    const { sessionId } = pc.startCrossValidation({ agentA: 'a', agentB: 'b', artifact: 'code' });
    pc.addCrossValidationRound(sessionId, { corrections: [], approved: true, direction: 'A-to-B' });
    assert.strictEqual(completed, true);
  });
});

describe('ChatChain - Phase Artifact Tracking', () => {
  const ChatChain = require(path.join(ROOT, 'src', 'runtime', 'collaboration', 'chat-chain'));

  afterEach(async () => { await _cleanAll(); });

  it('should register artifact in chain', () => {
    const chain = _track(new ChatChain());
    const { chainId } = chain.createChain('brainstorming');
    const result = chain.registerArtifact(chainId, {
      name: 'requirements-doc',
      type: 'document',
      phase: 'brainstorming',
      content: 'Requirements specification',
    });
    assert.ok(result.artifactId);
    assert.strictEqual(result.name, 'requirements-doc');
    assert.strictEqual(result.version, 1);
  });

  it('should require artifact name and type', () => {
    const chain = _track(new ChatChain());
    const { chainId } = chain.createChain('brainstorming');
    const result = chain.registerArtifact(chainId, { content: 'test' });
    assert.ok(result.error);
  });

  it('should return error for nonexistent chain', () => {
    const chain = _track(new ChatChain());
    const result = chain.registerArtifact('nonexistent', { name: 'test', type: 'doc' });
    assert.ok(result.error);
  });

  it('should version artifacts with same name', () => {
    const chain = _track(new ChatChain());
    const { chainId } = chain.createChain('brainstorming');
    const v1 = chain.registerArtifact(chainId, { name: 'design', type: 'document', phase: 'brainstorming' });
    const v2 = chain.registerArtifact(chainId, { name: 'design', type: 'document', phase: 'requirement-analysis' });
    assert.strictEqual(v1.version, 1);
    assert.strictEqual(v2.version, 2);
    assert.strictEqual(v2.parentArtifactId, v1.artifactId);
  });

  it('should get phase artifacts', () => {
    const chain = _track(new ChatChain());
    const { chainId } = chain.createChain('brainstorming');
    chain.registerArtifact(chainId, { name: 'doc1', type: 'document', phase: 'brainstorming' });
    chain.registerArtifact(chainId, { name: 'doc2', type: 'document', phase: 'brainstorming' });
    chain.registerArtifact(chainId, { name: 'spec', type: 'specification', phase: 'requirement-analysis' });
    const artifacts = chain.getPhaseArtifacts(chainId, 'brainstorming');
    assert.strictEqual(artifacts.length, 2);
  });

  it('should return null for nonexistent chain phase artifacts', () => {
    const chain = _track(new ChatChain());
    assert.strictEqual(chain.getPhaseArtifacts('nonexistent', 'brainstorming'), null);
  });

  it('should get artifact flow', () => {
    const chain = _track(new ChatChain());
    const { chainId } = chain.createChain('brainstorming');
    chain.registerArtifact(chainId, { name: 'design', type: 'document', phase: 'brainstorming' });
    chain.registerArtifact(chainId, { name: 'design', type: 'document', phase: 'requirement-analysis' });
    chain.registerArtifact(chainId, { name: 'code', type: 'source', phase: 'module-development' });
    const flow = chain.getArtifactFlow(chainId);
    assert.ok(flow);
    assert.strictEqual(flow.totalArtifacts, 3);
    assert.ok(flow.phaseFlow.length >= 2);
    assert.ok(flow.lineage.length >= 1);
  });

  it('should return null for nonexistent chain artifact flow', () => {
    const chain = _track(new ChatChain());
    assert.strictEqual(chain.getArtifactFlow('nonexistent'), null);
  });

  it('should get artifact by id', () => {
    const chain = _track(new ChatChain());
    const { chainId } = chain.createChain('brainstorming');
    const { artifactId } = chain.registerArtifact(chainId, { name: 'test', type: 'doc', phase: 'brainstorming' });
    const artifact = chain.getArtifact(chainId, artifactId);
    assert.ok(artifact);
    assert.strictEqual(artifact.artifactId, artifactId);
    assert.strictEqual(artifact.name, 'test');
  });

  it('should get latest artifact by name', () => {
    const chain = _track(new ChatChain());
    const { chainId } = chain.createChain('brainstorming');
    chain.registerArtifact(chainId, { name: 'design', type: 'doc', phase: 'brainstorming' });
    chain.registerArtifact(chainId, { name: 'design', type: 'doc', phase: 'requirement-analysis' });
    const latest = chain.getLatestArtifactByName(chainId, 'design');
    assert.ok(latest);
    assert.strictEqual(latest.version, 2);
  });

  it('should include artifactCount in chain summary', () => {
    const chain = _track(new ChatChain());
    const { chainId } = chain.createChain('brainstorming');
    chain.registerArtifact(chainId, { name: 'test', type: 'doc', phase: 'brainstorming' });
    const summary = chain.getChain(chainId);
    assert.strictEqual(summary.artifactCount, 1);
  });

  it('should include totalArtifacts in stats', () => {
    const chain = _track(new ChatChain());
    const { chainId } = chain.createChain('brainstorming');
    chain.registerArtifact(chainId, { name: 'test', type: 'doc', phase: 'brainstorming' });
    const stats = chain.getStats();
    assert.strictEqual(stats.totalArtifacts, 1);
  });

  it('should emit artifact-registered event', () => {
    const chain = _track(new ChatChain());
    let fired = false;
    chain.on('artifact-registered', () => { fired = true; });
    const { chainId } = chain.createChain('brainstorming');
    chain.registerArtifact(chainId, { name: 'test', type: 'doc', phase: 'brainstorming' });
    assert.strictEqual(fired, true);
  });

  it('should emit artifact-versioned event on version bump', () => {
    const chain = _track(new ChatChain());
    let versioned = false;
    chain.on('artifact-versioned', () => { versioned = true; });
    const { chainId } = chain.createChain('brainstorming');
    chain.registerArtifact(chainId, { name: 'design', type: 'doc', phase: 'brainstorming' });
    chain.registerArtifact(chainId, { name: 'design', type: 'doc', phase: 'requirement-analysis' });
    assert.strictEqual(versioned, true);
  });
});

describe('DevMetricsCollector', () => {
  const DevMetricsCollector = require(path.join(ROOT, 'src', 'runtime', 'collaboration', 'dev-metrics-collector'));

  afterEach(async () => { await _cleanAll(); });

  it('should construct with default options', () => {
    const mc = _track(new DevMetricsCollector());
    assert.ok(mc);
    assert.strictEqual(mc.isHealthy(), true);
  });

  it('should start a project', () => {
    const mc = _track(new DevMetricsCollector());
    const result = mc.startProject({ projectName: 'test-project', agentCount: 5 });
    assert.ok(result.projectId);
    assert.strictEqual(result.status, 'in_progress');
  });

  it('should require projectName', () => {
    const mc = _track(new DevMetricsCollector());
    const result = mc.startProject({});
    assert.strictEqual(result.projectId, null);
    assert.ok(result.error);
  });

  it('should start and complete a phase', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    mc.startPhase(projectId, 'brainstorming');
    const result = mc.completePhase(projectId, 'brainstorming', {
      fileCount: 2,
      hallucinationCorrections: 3,
      artifactCount: 1,
    });
    assert.ok(result.durationMs >= 0);
  });

  it('should reject completing unstarted phase', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    const result = mc.completePhase(projectId, 'brainstorming');
    assert.ok(result.error);
  });

  it('should record token usage', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    mc.startPhase(projectId, 'coding');
    const result = mc.recordTokenUsage(projectId, 'coding', { input: 1000, output: 500 });
    assert.strictEqual(result.totalTokens, 1500);
  });

  it('should record hallucination corrections', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    mc.startPhase(projectId, 'coding');
    const result = mc.recordHallucinationCorrection(projectId, 'coding', 5);
    assert.strictEqual(result.totalCorrections, 5);
  });

  it('should record file count', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    mc.startPhase(projectId, 'coding');
    const result = mc.recordFileCount(projectId, 'coding', 17);
    assert.strictEqual(result.totalFiles, 17);
  });

  it('should complete project and generate report', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'gobang', agentCount: 4, description: 'A gobang game' });
    mc.startPhase(projectId, 'brainstorming');
    mc.completePhase(projectId, 'brainstorming', { fileCount: 2, hallucinationCorrections: 5 });
    mc.startPhase(projectId, 'module-development');
    mc.completePhase(projectId, 'module-development', { fileCount: 15, hallucinationCorrections: 8 });
    mc.recordTokenUsage(projectId, 'brainstorming', { input: 5000, output: 2000 });
    mc.recordTokenUsage(projectId, 'module-development', { input: 10000, output: 8000 });
    const report = mc.completeProject(projectId);
    assert.ok(report);
    assert.strictEqual(report.projectName, 'gobang');
    assert.strictEqual(report.status, 'completed');
    assert.strictEqual(report.totalFiles, 17);
    assert.strictEqual(report.totalHallucinationCorrections, 13);
    assert.ok(report.totalDurationSeconds >= 0);
    assert.ok(report.estimatedCost >= 0);
  });

  it('should include phase breakdown in report', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    mc.startPhase(projectId, 'brainstorming');
    mc.completePhase(projectId, 'brainstorming', { fileCount: 2, hallucinationCorrections: 5 });
    mc.recordTokenUsage(projectId, 'brainstorming', { input: 5000, output: 2000 });
    const report = mc.generateReport(projectId);
    assert.ok(report.phaseBreakdown);
    assert.ok(report.phaseBreakdown.brainstorming);
    assert.strictEqual(report.phaseBreakdown.brainstorming.fileCount, 2);
  });

  it('should generate report for in-progress project', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    const report = mc.generateReport(projectId);
    assert.ok(report);
    assert.strictEqual(report.status, 'in_progress');
  });

  it('should return null for nonexistent project report', () => {
    const mc = _track(new DevMetricsCollector());
    assert.strictEqual(mc.generateReport('nonexistent'), null);
  });
});

describe('DevMetricsCollector - Advanced', () => {
  const DevMetricsCollector = require(path.join(ROOT, 'src', 'runtime', 'collaboration', 'dev-metrics-collector'));

  afterEach(async () => { await _cleanAll(); });

  it('should track global stats', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    mc.startPhase(projectId, 'coding');
    mc.completePhase(projectId, 'coding', { fileCount: 5, hallucinationCorrections: 2 });
    mc.recordTokenUsage(projectId, 'coding', { input: 1000, output: 500 });
    mc.completeProject(projectId);
    const stats = mc.getGlobalStats();
    assert.strictEqual(stats.totalProjects, 1);
    assert.strictEqual(stats.completedProjects, 1);
    assert.ok(stats.avgDurationSeconds >= 0);
    assert.ok(stats.avgCost >= 0);
    assert.strictEqual(stats.avgFiles, 5);
    assert.strictEqual(stats.avgHallucinationCorrections, 2);
  });

  it('should track history', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    mc.startPhase(projectId, 'coding');
    mc.completePhase(projectId, 'coding', { fileCount: 3 });
    mc.completeProject(projectId);
    const history = mc.getHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].projectName, 'test');
  });

  it('should estimate tokens for text', () => {
    const mc = _track(new DevMetricsCollector());
    const tokens = mc.estimateTokens('Hello world');
    assert.ok(tokens > 0);
  });

  it('should estimate tokens for CJK text', () => {
    const mc = _track(new DevMetricsCollector());
    const tokens = mc.estimateTokens('你好世界');
    assert.ok(tokens > 0);
  });

  it('should emit project-started event', () => {
    const mc = _track(new DevMetricsCollector());
    let fired = false;
    mc.on('project-started', () => { fired = true; });
    mc.startProject({ projectName: 'test' });
    assert.strictEqual(fired, true);
  });

  it('should emit project-completed event', () => {
    const mc = _track(new DevMetricsCollector());
    let fired = false;
    mc.on('project-completed', () => { fired = true; });
    const { projectId } = mc.startProject({ projectName: 'test' });
    mc.completeProject(projectId);
    assert.strictEqual(fired, true);
  });

  it('should emit hallucination-corrected event', () => {
    const mc = _track(new DevMetricsCollector());
    let fired = false;
    mc.on('hallucination-corrected', () => { fired = true; });
    const { projectId } = mc.startProject({ projectName: 'test' });
    mc.startPhase(projectId, 'coding');
    mc.recordHallucinationCorrection(projectId, 'coding', 1);
    assert.strictEqual(fired, true);
  });

  it('should export METRIC_TYPES', () => {
    assert.ok(DevMetricsCollector.METRIC_TYPES);
    assert.strictEqual(DevMetricsCollector.METRIC_TYPES.TIME, 'time');
    assert.strictEqual(DevMetricsCollector.METRIC_TYPES.COST, 'cost');
    assert.strictEqual(DevMetricsCollector.METRIC_TYPES.HALLUCINATION_CORRECTIONS, 'hallucination_corrections');
  });

  it('should shutdown cleanly', () => {
    const mc = _track(new DevMetricsCollector());
    mc.startProject({ projectName: 'test' });
    mc.shutdown();
    assert.strictEqual(mc._shutDown, true);
  });

  it('should reject double completeProject', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    mc.completeProject(projectId);
    const result = mc.completeProject(projectId);
    assert.ok(result.error);
    assert.strictEqual(result.error, 'Project already completed');
  });

  it('should not double-count when using recordFileCount and completePhase together', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    mc.startPhase(projectId, 'coding');
    mc.recordFileCount(projectId, 'coding', 5);
    mc.recordHallucinationCorrection(projectId, 'coding', 3);
    mc.completePhase(projectId, 'coding', { fileCount: 5, hallucinationCorrections: 3 });
    const report = mc.generateReport(projectId);
    assert.strictEqual(report.totalFiles, 5);
    assert.strictEqual(report.totalHallucinationCorrections, 3);
  });

  it('should handle recordFileCount for unstarted phase', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    const result = mc.recordFileCount(projectId, 'coding', 10);
    assert.strictEqual(result.totalFiles, 10);
  });

  it('should estimate tokens for empty string', () => {
    const mc = _track(new DevMetricsCollector());
    assert.strictEqual(mc.estimateTokens(''), 0);
    assert.strictEqual(mc.estimateTokens(null), 0);
    assert.strictEqual(mc.estimateTokens(123), 0);
  });

  it('should get project by id', () => {
    const mc = _track(new DevMetricsCollector());
    const { projectId } = mc.startProject({ projectName: 'test' });
    const project = mc.getProject(projectId);
    assert.ok(project);
    assert.strictEqual(project.projectName, 'test');
  });

  it('should return null for nonexistent project', () => {
    const mc = _track(new DevMetricsCollector());
    assert.strictEqual(mc.getProject('nonexistent'), null);
  });
});
