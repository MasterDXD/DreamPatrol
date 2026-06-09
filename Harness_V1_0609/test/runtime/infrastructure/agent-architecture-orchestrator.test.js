'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const Module = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'agent-architecture-orchestrator'));
const {
  ARCHITECTURE_PILLAR,
  CONSTRAINT_TYPE,
  VALIDATION_PHASE,
  ENTROPY_LEVEL,
  DEFAULT_CONFIG,
} = Module;

const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}

function _createInstance(config) {
  return _track(new Module(config));
}

// ─── 1. Constructor & Constants ─────────────────────────────────────────────

describe('Constructor & Constants', () => {
  afterEach(async () => { await _cleanAll(); });

  it('should apply DEFAULT_CONFIG when no config is provided', () => {
    const orch = _createInstance();
    assert.equal(orch.getStatus(), 'idle');
    assert.equal(DEFAULT_CONFIG.contextLayers, 3);
    assert.equal(DEFAULT_CONFIG.maxContextTokens, 8000);
    assert.equal(DEFAULT_CONFIG.disclosureStrategy, 'priority');
    assert.equal(DEFAULT_CONFIG.maxModules, 100);
    assert.equal(DEFAULT_CONFIG.enableMemoryIsolation, true);
    assert.equal(DEFAULT_CONFIG.allowCrossAgentMemory, false);
  });

  it('should merge custom config over DEFAULT_CONFIG', () => {
    const orch = _createInstance({ contextLayers: 5, maxModules: 50 });
    const status = orch.getArchitectureStatus();
    assert.equal(status.progressive_disclosure.layers, 5);
    assert.equal(status.detachability.maxModules, 50);
    // Unchanged defaults still present
    assert.equal(status.progressive_disclosure.strategy, 'priority');
  });

  it('should export all constant enums', () => {
    assert.equal(ARCHITECTURE_PILLAR.PROGRESSIVE_DISCLOSURE, 'progressive_disclosure');
    assert.equal(ARCHITECTURE_PILLAR.CONSTRAINT_ENFORCEMENT, 'constraint_enforcement');
    assert.equal(ARCHITECTURE_PILLAR.SELF_VALIDATION, 'self_validation');
    assert.equal(ARCHITECTURE_PILLAR.CONTEXT_ISOLATION, 'context_isolation');
    assert.equal(ARCHITECTURE_PILLAR.ENTROPY_GOVERNANCE, 'entropy_governance');
    assert.equal(ARCHITECTURE_PILLAR.DETACHABILITY, 'detachability');

    assert.equal(CONSTRAINT_TYPE.PROMPT_SUGGESTION, 'prompt_suggestion');
    assert.equal(CONSTRAINT_TYPE.HARD_CODED, 'hard_coded');
    assert.equal(CONSTRAINT_TYPE.LINTER, 'linter');

    assert.equal(VALIDATION_PHASE.PRE_EXECUTION, 'pre_execution');
    assert.equal(VALIDATION_PHASE.POST_EXECUTION, 'post_execution');
    assert.equal(VALIDATION_PHASE.MULTI_FILE_REVIEW, 'multi_file_review');

    assert.equal(ENTROPY_LEVEL.LOW, 'low');
    assert.equal(ENTROPY_LEVEL.MEDIUM, 'medium');
    assert.equal(ENTROPY_LEVEL.HIGH, 'high');
    assert.equal(ENTROPY_LEVEL.CRITICAL, 'critical');
  });
});

// ─── 2. attach* DI ─────────────────────────────────────────────────────────

describe('attach* DI', () => {
  afterEach(async () => { await _cleanAll(); });

  it('each attach method should return this for chaining', () => {
    const orch = _createInstance();
    const result = orch
      .attachAttentionBudgetManager({})
      .attachContextCompressionEngine({})
      .attachIronRuleEngine({})
      .attachSddDocumentValidator({})
      .attachHookComposer({})
      .attachProgrammableHookExecutor({})
      .attachIsolatedContextManager({})
      .attachDreamEngine({})
      .attachThoughtDeduplicator({})
      .attachDocFreshnessGuard({})
      .attachPluginManager({})
      .attachEventBus({});
    assert.equal(result, orch);
  });

  it('should reject null/undefined for each attach method', () => {
    const orch = _createInstance();
    const attachMethods = [
      'attachAttentionBudgetManager',
      'attachContextCompressionEngine',
      'attachIronRuleEngine',
      'attachSddDocumentValidator',
      'attachHookComposer',
      'attachProgrammableHookExecutor',
      'attachIsolatedContextManager',
      'attachDreamEngine',
      'attachThoughtDeduplicator',
      'attachDocFreshnessGuard',
      'attachPluginManager',
      'attachEventBus',
    ];
    for (const method of attachMethods) {
      assert.throws(() => orch[method](null), { message: /must not be null/ });
      assert.throws(() => orch[method](undefined), { message: /must not be null/ });
    }
  });

  it('should reflect attached modules in getArchitectureStatus', () => {
    const orch = _createInstance();
    orch.attachAttentionBudgetManager({}).attachContextCompressionEngine({});
    const status = orch.getArchitectureStatus();
    assert.equal(status.progressive_disclosure.hasAttentionBudgetManager, true);
    assert.equal(status.progressive_disclosure.hasContextCompressionEngine, true);
  });

  it('should reflect attached constraint modules in status', () => {
    const orch = _createInstance();
    orch.attachIronRuleEngine({}).attachSddDocumentValidator({});
    const status = orch.getArchitectureStatus();
    assert.equal(status.constraint_enforcement.hasIronRuleEngine, true);
    assert.equal(status.constraint_enforcement.hasSddDocumentValidator, true);
  });

  it('should reflect attached validation modules in status', () => {
    const orch = _createInstance();
    orch.attachHookComposer({}).attachProgrammableHookExecutor({});
    const status = orch.getArchitectureStatus();
    assert.equal(status.self_validation.hasHookComposer, true);
    assert.equal(status.self_validation.hasProgrammableHookExecutor, true);
  });
});

// ─── 3. orchestrate() Basic ────────────────────────────────────────────────

describe('orchestrate() Basic', () => {
  afterEach(async () => { await _cleanAll(); });

  it('should reject empty task string', async () => {
    const orch = _createInstance();
    await assert.rejects(() => orch.orchestrate('', [{ id: 'a1' }]), { message: /non-empty string/ });
  });

  it('should reject empty agents array', async () => {
    const orch = _createInstance();
    await assert.rejects(() => orch.orchestrate('task', []), { message: /At least one agent/ });
  });

  it('should reject when shut down', async () => {
    const orch = _createInstance();
    orch.shutdown();
    await assert.rejects(() => orch.orchestrate('task', [{ id: 'a1' }]), { message: /shut down/i });
  });
});

// ─── 4. Progressive Disclosure ──────────────────────────────────────────────

describe('Progressive Disclosure', () => {
  afterEach(async () => { await _cleanAll(); });

  it('registerContextLayer stores data and discloseContext returns layered data', () => {
    const orch = _createInstance();
    orch._progressiveDisclosureController.registerContext(0, { topic: 'core' });
    orch._progressiveDisclosureController.registerContext(1, { topic: 'detail' });
    const result = orch._progressiveDisclosureController.disclose('task-1', 'agent-1', 'planning');
    assert.equal(result.taskId, 'task-1');
    assert.equal(result.agentId, 'agent-1');
    assert.equal(result.currentPhase, 'planning');
    assert.equal(result.layers.length, DEFAULT_CONFIG.contextLayers);
    assert.equal(result.strategy, 'priority');
    assert.equal(result.totalBudget, DEFAULT_CONFIG.maxContextTokens);
  });

  it('discloseContext returns layered data with correct priorities', () => {
    const orch = _createInstance({ contextLayers: 2, disclosureStrategy: 'priority' });
    orch._progressiveDisclosureController.registerContext(0, { a: 1 });
    orch._progressiveDisclosureController.registerContext(1, { b: 2 });
    const result = orch._progressiveDisclosureController.disclose('t1', 'a1');
    assert.equal(result.layers.length, 2);
    // priority strategy: layer 0 gets highest priority (2), layer 1 gets 1
    assert.equal(result.layers[0].priority, 2);
    assert.equal(result.layers[1].priority, 1);
  });

  it('getBudgetAllocation returns correct allocation', () => {
    const orch = _createInstance({ contextLayers: 4, maxContextTokens: 4000 });
    const alloc = orch._progressiveDisclosureController.getBudgetAllocation();
    assert.equal(alloc.total, 4000);
    assert.equal(alloc.perLayer, 1000);
    assert.equal(alloc.layers, 4);
  });
});

// ─── 5. Constraint Enforcement ─────────────────────────────────────────────

describe('Constraint Enforcement', () => {
  afterEach(async () => { await _cleanAll(); });

  it('registerConstraint stores and compileConstraintsToPrompt retrieves by type', () => {
    const orch = _createInstance();
    orch._constraintPromptCompiler.registerConstraint('no-console', CONSTRAINT_TYPE.PROMPT_SUGGESTION, 'Do not use console.log');
    orch._constraintPromptCompiler.registerConstraint('max-files', CONSTRAINT_TYPE.HARD_CODED, () => true);
    orch._constraintPromptCompiler.registerConstraint('lint-rule', CONSTRAINT_TYPE.LINTER, { validate: () => ({ valid: true, errors: [] }) });

    const prompt = orch._constraintPromptCompiler.compile(CONSTRAINT_TYPE.PROMPT_SUGGESTION);
    assert.ok(prompt.includes('Do not use console.log'));

    const hard = orch._constraintPromptCompiler.compile(CONSTRAINT_TYPE.HARD_CODED);
    assert.equal(hard.length, 1);
    assert.equal(hard[0].name, 'max-files');
    assert.equal(typeof hard[0].validate, 'function');

    const lint = orch._constraintPromptCompiler.compile(CONSTRAINT_TYPE.LINTER);
    assert.equal(lint.length, 1);
    assert.equal(lint[0].name, 'lint-rule');
  });

  it('compileConstraintsToPrompt for PROMPT_SUGGESTION returns formatted text', () => {
    const orch = _createInstance();
    orch._constraintPromptCompiler.registerConstraint('c1', CONSTRAINT_TYPE.PROMPT_SUGGESTION, 'Rule A');
    orch._constraintPromptCompiler.registerConstraint('c2', CONSTRAINT_TYPE.PROMPT_SUGGESTION, 'Rule B');
    const result = orch._constraintPromptCompiler.compile(CONSTRAINT_TYPE.PROMPT_SUGGESTION);
    assert.ok(result.includes('架构约束指导方针'));
    assert.ok(result.includes('Rule A'));
    assert.ok(result.includes('Rule B'));
  });

  it('getPromptSuggestions returns prompt suggestion text', () => {
    const orch = _createInstance();
    orch._constraintPromptCompiler.registerConstraint('ps1', CONSTRAINT_TYPE.PROMPT_SUGGESTION, 'Follow SOLID');
    const suggestions = orch._constraintPromptCompiler.getPromptSuggestions();
    assert.ok(suggestions.includes('Follow SOLID'));
  });
});

// ─── 6. Self-Validation ────────────────────────────────────────────────────

describe('Self-Validation', () => {
  afterEach(async () => { await _cleanAll(); });

  it('preValidate passes when no external validators are attached', async () => {
    const orch = _createInstance();
    const result = await orch._verificationLoopMiddleware.preValidate('task', { id: 'a1' });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('postValidate catches errors for null result', async () => {
    const orch = _createInstance();
    const result = await orch._verificationLoopMiddleware.postValidate('task', { id: 'a1' }, null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('null or undefined')));
  });

  it('executeWithValidation retries on post-validation failure', async () => {
    const orch = _createInstance({ maxValidationRetries: 2, enablePreValidation: false, enablePostValidation: true });
    let callCount = 0;
    const failFn = () => {
      callCount++;
      return { success: false, reason: 'intentional' };
    };
    const result = await orch._verificationLoopMiddleware.executeWithValidation('task', { id: 'a1' }, failFn);
    // Should have retried — callCount > 1
    assert.ok(callCount > 1);
    assert.equal(result.success, false);
  });
});

// ─── 7. Context Isolation ──────────────────────────────────────────────────

describe('Context Isolation', () => {
  afterEach(async () => { await _cleanAll(); });

  it('getNamespace creates per-agent namespace', () => {
    const orch = _createInstance();
    const ns1 = orch._agentMemoryNamespace.getNamespace('agent-1');
    const ns2 = orch._agentMemoryNamespace.getNamespace('agent-2');
    assert.ok(ns1 instanceof Map);
    assert.ok(ns2 instanceof Map);
    assert.notEqual(ns1, ns2);
  });

  it('store and retrieve work within same agent namespace', () => {
    const orch = _createInstance();
    orch._agentMemoryNamespace.store('agent-1', 'key1', 'value1');
    const val = orch._agentMemoryNamespace.retrieve('agent-1', 'key1');
    assert.equal(val, 'value1');
  });

  it('cross-agent access is denied by default (allowCrossAgentMemory=false)', () => {
    const orch = _createInstance();
    orch._agentMemoryNamespace.store('agent-1', 'secret', 'data');
    // Agent-2 cannot read agent-1's data through retrieve
    const val = orch._agentMemoryNamespace.retrieve('agent-2', 'secret');
    assert.equal(val, undefined);
    // grantAccess should be a no-op when allowCrossAgentMemory is false
    orch._agentMemoryNamespace.grantAccess('agent-1', 'agent-2', ['secret']);
    // Still cannot access — grant is silently ignored
    const val2 = orch._agentMemoryNamespace.retrieve('agent-2', 'secret');
    assert.equal(val2, undefined);
  });
});

// ─── 8. Entropy Governance ─────────────────────────────────────────────────

describe('Entropy Governance', () => {
  afterEach(async () => { await _cleanAll(); });

  it('measureEntropy returns a score between 0 and 1', () => {
    const orch = _createInstance();
    const score = orch._entropyGovernanceOrchestrator.measureEntropy();
    assert.equal(typeof score, 'number');
    assert.ok(score >= 0 && score <= 1);
  });

  it('governEntropy triggers cleanup and returns result with entropyLevel and actionsTaken', () => {
    const orch = _createInstance();
    orch.attachDreamEngine({ consolidate: () => true });
    orch.attachThoughtDeduplicator({ deduplicate: () => true });
    orch.attachDocFreshnessGuard({ validate: () => true });
    const result = orch._entropyGovernanceOrchestrator.govern();
    assert.ok(Object.values(ENTROPY_LEVEL).includes(result.entropyLevel));
    assert.ok(Array.isArray(result.actionsTaken));
    assert.ok(result.actionsTaken.includes('dream_consolidation'));
    assert.ok(result.actionsTaken.includes('thought_deduplication'));
    assert.ok(result.actionsTaken.includes('doc_freshness_validation'));
  });

  it('getEntropyReport returns detailed report', () => {
    const orch = _createInstance();
    orch._entropyGovernanceOrchestrator.measureEntropy();
    const report = orch._entropyGovernanceOrchestrator.getEntropyReport();
    assert.equal(typeof report.currentScore, 'number');
    assert.ok(Object.values(ENTROPY_LEVEL).includes(report.entropyLevel));
    assert.ok('dimensions' in report);
    assert.ok(Array.isArray(report.history));
    assert.ok('thresholds' in report);
  });
});

// ─── 9. Module Container ───────────────────────────────────────────────────

describe('Module Container', () => {
  afterEach(async () => { await _cleanAll(); });

  it('register and unregister module', () => {
    const orch = _createInstance();
    orch._moduleContainer.register('mod1', { doWork: () => 1 }, ['compute']);
    const mod = orch._moduleContainer.get('mod1');
    assert.ok(mod);
    assert.equal(mod.doWork(), 1);
    orch._moduleContainer.unregister('mod1');
    assert.equal(orch._moduleContainer.get('mod1'), null);
  });

  it('list modules returns all registered modules', () => {
    const orch = _createInstance();
    orch._moduleContainer.register('a', {}, ['cap-a']);
    orch._moduleContainer.register('b', {}, ['cap-b']);
    const list = orch._moduleContainer.list();
    assert.equal(list.length, 2);
    const names = list.map(m => m.name);
    assert.ok(names.includes('a'));
    assert.ok(names.includes('b'));
  });

  it('max module limit prevents registration beyond limit', () => {
    const orch = _createInstance({ maxModules: 2 });
    orch._moduleContainer.register('m1', {}, []);
    orch._moduleContainer.register('m2', {}, []);
    orch._moduleContainer.register('m3', {}, []); // should be silently rejected
    const list = orch._moduleContainer.list();
    assert.equal(list.length, 2);
  });
});

// ─── 10. Query Methods ─────────────────────────────────────────────────────

describe('Query Methods', () => {
  afterEach(async () => { await _cleanAll(); });

  it('getStatus returns current status', () => {
    const orch = _createInstance();
    assert.equal(orch.getStatus(), 'idle');
  });

  it('getArchitectureStatus returns all six pillars', () => {
    const orch = _createInstance();
    const status = orch.getArchitectureStatus();
    const pillars = Object.values(ARCHITECTURE_PILLAR);
    for (const p of pillars) {
      assert.ok(p in status, 'Missing pillar: ' + p);
    }
  });

  it('defensive copies prevent external mutation', () => {
    const orch = _createInstance();
    orch._constraintPromptCompiler.registerConstraint('c1', CONSTRAINT_TYPE.PROMPT_SUGGESTION, 'rule');
    const reg1 = orch.getConstraintRegistry();
    reg1.set('injected', 'bad');
    const reg2 = orch.getConstraintRegistry();
    assert.equal(reg2.has('injected'), false);

    orch._moduleContainer.register('m1', {}, []);
    const modReg1 = orch.getModuleRegistry();
    modReg1.set('injected', 'bad');
    const modReg2 = orch.getModuleRegistry();
    assert.equal(modReg2.has('injected'), false);
  });
});

// ─── 11. Shutdown ──────────────────────────────────────────────────────────

describe('Shutdown', () => {
  afterEach(async () => { await _cleanAll(); });

  it('prevents operations after shutdown', async () => {
    const orch = _createInstance();
    orch._agentMemoryNamespace.store('a1', 'k', 'v');
    orch._constraintPromptCompiler.registerConstraint('c1', CONSTRAINT_TYPE.PROMPT_SUGGESTION, 'rule');
    orch._moduleContainer.register('m1', {}, []);

    orch.shutdown();
    assert.equal(orch.getStatus(), 'shutdown');

    // orchestrate should throw
    await assert.rejects(() => orch.orchestrate('task', [{ id: 'a1' }]), { message: /shut down/i });

    // Internal state should be cleared
    assert.equal(orch.getConstraintRegistry().size, 0);
    assert.equal(orch.getModuleRegistry().size, 0);
    assert.equal(orch.getEntropyScore(), 0);
  });
});
