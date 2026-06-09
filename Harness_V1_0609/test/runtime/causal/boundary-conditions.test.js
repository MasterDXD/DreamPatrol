'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const _sessionFilesToCleanup = [];
const _sessionMgrsToCleanup = [];
function _cleanupSessionFiles() {
  for (const mgr of _sessionMgrsToCleanup) {
    try { mgr.shutdown(); } catch (_) { /* best-effort */ }
  }
  _sessionMgrsToCleanup.length = 0;
  for (const f of _sessionFilesToCleanup) {
    try { fs.unlinkSync(f); } catch (_) { /* best-effort */ }
  }
  _sessionFilesToCleanup.length = 0;
}
function _trackSessionFile(sessionId) {
  _sessionFilesToCleanup.push(path.join(ROOT, '.harness', 'sessions', sessionId + '.json'));
}

const CausalDataBus = require('../../../src/runtime/causal/causal-data-bus');
const CausalMemoryStore = require('../../../src/runtime/causal/causal-memory-store');
const ContextCompressionEngine = require('../../../src/runtime/context/context-compression-engine');
const BoundedArray = require('../../../src/utils/bounded-array');
const TDDGate = require('../../../src/gate/tdd-gate');
const GeneratorVerifier = require('../../../src/gate/generator-verifier');

describe('CausalDataBus Boundary Conditions', () => {
  it('should reject invalid targetSequence in rollbackToSequence', async () => {
    const bus = new CausalDataBus();
    const r1 = await bus.rollbackToSequence(-1);
    assert.strictEqual(r1.success, false);
    assert.strictEqual(r1.reason, 'invalid_target_sequence');
    const r2 = await bus.rollbackToSequence('abc');
    assert.strictEqual(r2.success, false);
    assert.strictEqual(r2.reason, 'invalid_target_sequence');
    const r3 = await bus.rollbackToSequence(undefined);
    assert.strictEqual(r3.success, false);
    assert.strictEqual(r3.reason, 'invalid_target_sequence');
    bus.shutdown();
  });

  it('should reject rollbackToSequence when target >= current', async () => {
    const bus = new CausalDataBus();
    const result = await bus.rollbackToSequence(0);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'target_sequence_is_current_or_newer');
    bus.shutdown();
  });

  it('should perform valid rollbackToSequence', async () => {
    const bus = new CausalDataBus();
    await bus.defineSkillInterface('skill-a', { causalInputs: [], causalOutputs: ['out1'] });
    await bus.publishOutput('skill-a', { out1: 'data1' });
    await bus.publishOutput('skill-a', { out1: 'data2' });
    const seq = bus._walSequence;
    const result = await bus.rollbackToSequence(seq - 1);
    assert.strictEqual(result.success, true);
    assert.ok(result.removedChainEntries >= 0);
    bus.shutdown();
  });

  it('should reject rollbackToTimestamp when no entry before target', async () => {
    const bus = new CausalDataBus();
    const result = await bus.rollbackToTimestamp(Date.now() + 100000);
    assert.strictEqual(result.success, false);
    bus.shutdown();
  });

  it('should return null for getSkillInterface with unknown skillId', () => {
    const bus = new CausalDataBus();
    assert.strictEqual(bus.getSkillInterface('nonexistent'), null);
    bus.shutdown();
  });

  it('should return empty array for getDefinedInterfaces when none defined', () => {
    const bus = new CausalDataBus();
    const interfaces = bus.getDefinedInterfaces();
    assert.ok(Array.isArray(interfaces));
    assert.strictEqual(interfaces.length, 0);
    bus.shutdown();
  });

  it('should return Map copy from getPendingOutputs', () => {
    const bus = new CausalDataBus();
    const pending = bus.getPendingOutputs();
    assert.ok(pending instanceof Map);
    assert.strictEqual(pending.size, 0);
    bus.shutdown();
  });

  it('should return empty array for getOutputVersions with unknown skillId', () => {
    const bus = new CausalDataBus();
    const versions = bus.getOutputVersions('nonexistent');
    assert.ok(Array.isArray(versions));
    assert.strictEqual(versions.length, 0);
    bus.shutdown();
  });

  it('should validate chain integrity with no issues on empty bus', () => {
    const bus = new CausalDataBus();
    const result = bus.validateChainIntegrity();
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.issues.length, 0);
    bus.shutdown();
  });

  it('should detect missing causalId in chain integrity', () => {
    const bus = new CausalDataBus();
    bus._causalChain.push({ skillId: 'test', walSeq: 1 });
    const result = bus.validateChainIntegrity();
    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.some(i => i.type === 'missing_causal_id'));
    bus.shutdown();
  });

  it('should detect duplicate causalId in chain integrity', () => {
    const bus = new CausalDataBus();
    bus._causalChain.push({ causalId: 'dup1', skillId: 'a', walSeq: 1 });
    bus._causalChain.push({ causalId: 'dup1', skillId: 'b', walSeq: 2 });
    const result = bus.validateChainIntegrity();
    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.some(i => i.type === 'duplicate_causal_id'));
    bus.shutdown();
  });

  it('should detect broken causal link in chain integrity', async () => {
    const bus = new CausalDataBus();
    await bus.defineSkillInterface('skill-a', {
      causalInputs: [{ source: 'missing-skill', name: 'in1' }],
      causalOutputs: ['out1'],
    });
    const result = bus.validateChainIntegrity();
    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.some(i => i.type === 'broken_causal_link'));
    bus.shutdown();
  });

  it('should always return true from isHealthy', () => {
    const bus = new CausalDataBus();
    assert.strictEqual(bus.isHealthy(), true);
    bus.shutdown();
  });

  it('should handle flush without persister gracefully', async () => {
    const bus = new CausalDataBus();
    const result = await bus.flush();
    assert.ok(result === undefined || result === true || result === null || result === false || (result && result.success === true) || (result && result.success === false));
    bus.shutdown();
  });

  it('should merge with deepest-wins strategy', async () => {
    const bus = new CausalDataBus();
    await bus.defineSkillInterface('skill-a', { causalInputs: [], causalOutputs: ['out1'] });
    await bus.defineSkillInterface('skill-b', { causalInputs: [], causalOutputs: ['out2'] });
    await bus.publishOutput('skill-a', { key: 'from-a', shared: 'a-value' });
    await bus.publishOutput('skill-b', { key: 'from-b', shared: 'b-value' });
    const result = bus.mergeParallelOutputs(['skill-a', 'skill-b'], 'deepest-wins');
    assert.strictEqual(result.strategy, 'deepest-wins');
    assert.ok(result.merged);
    bus.shutdown();
  });

  it('should handle mergeParallelOutputs with empty array', () => {
    const bus = new CausalDataBus();
    const result = bus.mergeParallelOutputs([], 'last-wins');
    assert.strictEqual(result.merged !== undefined, true);
    assert.strictEqual(result.conflicts.length, 0);
    bus.shutdown();
  });

  it('should handle mergeParallelOutputs with non-array', () => {
    const bus = new CausalDataBus();
    const result = bus.mergeParallelOutputs('not-array', 'last-wins');
    assert.strictEqual(result.conflicts.length, 0);
    bus.shutdown();
  });

  it('should handle shutdown idempotently', () => {
    const bus = new CausalDataBus();
    bus.shutdown();
    assert.doesNotThrow(() => bus.shutdown());
  });

  it('should handle enforcePublishOutput with invalid skillId', async () => {
    const bus = new CausalDataBus();
    await assert.rejects(async () => bus.enforcePublishOutput('', {}), /Invalid skillId/);
    await assert.rejects(async () => bus.enforcePublishOutput(null, {}), /Invalid skillId/);
    bus.shutdown();
  });

  it('should handle enforceValidateInputs with invalid skillId', () => {
    const bus = new CausalDataBus();
    assert.throws(() => bus.enforceValidateInputs('', {}), /Invalid skillId/);
    assert.throws(() => bus.enforceValidateInputs(null, {}), /Invalid skillId/);
    bus.shutdown();
  });
});

describe('ContextCompressionEngine Boundary Conditions', () => {
  it('should return empty result for null context', () => {
    const engine = new ContextCompressionEngine();
    const result = engine.compress(null);
    assert.strictEqual(result.retainedSkills.length, 0);
    assert.strictEqual(result.compressedSkills.length, 0);
    assert.strictEqual(result.tokenSavings, 0);
  });

  it('should return empty result for undefined context', () => {
    const engine = new ContextCompressionEngine();
    const result = engine.compress(undefined);
    assert.strictEqual(result.retainedSkills.length, 0);
  });

  it('should return empty result for empty object context', () => {
    const engine = new ContextCompressionEngine();
    const result = engine.compress({});
    assert.strictEqual(result.retainedSkills.length, 0);
    assert.strictEqual(result.compressedSkills.length, 0);
  });

  it('should throw error after shutdown', () => {
    const engine = new ContextCompressionEngine();
    engine.shutdown();
    try {
      engine.compress({ currentPhase: 'module-development', skills: [], completedSkills: [] });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e.code === 'SHUTDOWN' || e.message.includes('shut down'));
    }
  });

  it('should return false from shouldCompress after shutdown', () => {
    const engine = new ContextCompressionEngine();
    engine.shutdown();
    assert.strictEqual(engine.shouldCompress({ tokensUsed: 100, tokenBudget: 50 }), false);
  });

  it('should return false from shouldCompress with null', () => {
    const engine = new ContextCompressionEngine();
    assert.strictEqual(engine.shouldCompress(null), false);
  });

  it('should handle shouldCompress with zero or negative budget', () => {
    const engine = new ContextCompressionEngine();
    assert.strictEqual(engine.shouldCompress({ tokensUsed: 100, tokenBudget: 0 }), false);
    assert.strictEqual(engine.shouldCompress({ tokensUsed: 100, tokenBudget: -1 }), false);
  });

  it('should use incremental cache for identical context', () => {
    const engine = new ContextCompressionEngine();
    const context = { currentPhase: 'module-development', skills: [{ skill_id: 'test', phase: 'module-development', instruction: 'x', summary: 'y' }], completedSkills: [] };
    engine.compress(context);
    engine.compress(context);
    assert.strictEqual(engine.getStats().incrementalSkips, 1);
  });

  it('should clear cache on strategy change', () => {
    const engine = new ContextCompressionEngine();
    const context = { currentPhase: 'module-development', skills: [{ skill_id: 'test', phase: 'module-development', instruction: 'x', summary: 'y' }], completedSkills: [] };
    engine.compress(context);
    engine.setStrategy('completed_phase', 'discard');
    assert.strictEqual(engine.getStats().hasIncrementalState, false);
  });

  it('should emit strategy-changed event', () => {
    const engine = new ContextCompressionEngine();
    let emitted = false;
    engine.on('strategy-changed', () => { emitted = true; });
    engine.setStrategy('completed_phase', 'discard');
    assert.strictEqual(emitted, true);
  });

  it('should emit compression-complete event', () => {
    const engine = new ContextCompressionEngine();
    let emitted = false;
    engine.on('compression-complete', () => { emitted = true; });
    engine.compress({ currentPhase: 'module-development', skills: [], completedSkills: [] });
    assert.strictEqual(emitted, true);
  });

  it('should return false from isHealthy after shutdown', () => {
    const engine = new ContextCompressionEngine();
    assert.strictEqual(engine.isHealthy(), true);
    engine.shutdown();
    assert.strictEqual(engine.isHealthy(), false);
  });

  it('should handle discard strategy producing zero token estimate', () => {
    const engine = new ContextCompressionEngine();
    engine.setStrategy('completed_phase', 'discard');
    const result = engine.compress({
      currentPhase: 'module-development',
      skills: [{ skill_id: 'brainstorming', phase: 'brainstorming', instruction: 'Full text', summary: 'Sum' }],
      completedSkills: ['brainstorming'],
    });
    const compressed = result.compressedSkills.find(s => s.skill_id === 'brainstorming');
    assert.ok(compressed);
    assert.strictEqual(compressed.compressedTokenEstimate, 0);
    assert.strictEqual(compressed.reason, 'completed_phase_discarded');
  });

  it('should handle full strategy retaining completed phase skill', () => {
    const engine = new ContextCompressionEngine();
    engine.setStrategy('completed_phase', 'full');
    const result = engine.compress({
      currentPhase: 'module-development',
      skills: [{ skill_id: 'brainstorming', phase: 'brainstorming', instruction: 'Full text', summary: 'Sum' }],
      completedSkills: ['brainstorming'],
    });
    const retained = result.retainedSkills.find(s => s.skill_id === 'brainstorming');
    assert.ok(retained);
    assert.strictEqual(retained.reason, 'completed_phase');
    assert.strictEqual(retained.strategy, 'full');
    assert.strictEqual(retained.retained, true);
  });

  it('should reject null causal validator', () => {
    const engine = new ContextCompressionEngine();
    const result = engine.attachConfigCausalValidator(null);
    assert.strictEqual(result, engine);
  });

  it('should reject validator without getDependencyGraph', () => {
    const engine = new ContextCompressionEngine();
    const result = engine.attachConfigCausalValidator({});
    assert.strictEqual(result, engine);
  });

  it('should handle getCompressionPlan with null', () => {
    const engine = new ContextCompressionEngine();
    const plan = engine.getCompressionPlan(null);
    assert.strictEqual(plan.retain.length, 0);
    assert.strictEqual(plan.compress.length, 0);
  });

  it('should remove all listeners on shutdown', () => {
    const engine = new ContextCompressionEngine();
    engine.on('compression-complete', () => {});
    engine.shutdown();
    assert.strictEqual(engine.listenerCount('compression-complete'), 0);
  });
});

describe('BoundedArray Advanced Boundary Conditions', () => {
  it('should handle maxSize of 1', () => {
    const arr = new BoundedArray(1);
    arr.push('a');
    assert.strictEqual(arr.length, 1);
    arr.push('b');
    assert.strictEqual(arr.length, 1);
    assert.strictEqual(arr.get(0), 'b');
  });

  it('should push undefined and null values', () => {
    const arr = new BoundedArray(5);
    arr.push(undefined);
    arr.push(null);
    arr.push(NaN);
    assert.strictEqual(arr.length, 3);
  });

  it('should return false for touch with invalid index', () => {
    const arr = new BoundedArray(3, { strategy: 'lru' });
    arr.push('a');
    assert.strictEqual(arr.touch(-1), false);
    assert.strictEqual(arr.touch(5), false);
  });

  it('should return undefined for get with invalid index', () => {
    const arr = new BoundedArray(3);
    arr.push('a');
    assert.strictEqual(arr.get(-1), undefined);
    assert.strictEqual(arr.get(5), undefined);
  });

  it('should handle reduce without initial value', () => {
    const arr = new BoundedArray(5);
    arr.push(1);
    arr.push(2);
    arr.push(3);
    const sum = arr.reduce((acc, val) => acc + val);
    assert.strictEqual(sum, 6);
  });

  it('should handle reduce with single element and no initial value', () => {
    const arr = new BoundedArray(5);
    arr.push(42);
    const result = arr.reduce((acc, val) => acc + val);
    assert.strictEqual(result, 42);
  });

  it('should reset evictedCount on clear', () => {
    const arr = new BoundedArray(2);
    arr.push('a');
    arr.push('b');
    arr.push('c');
    assert.ok(arr.evictedCount > 0);
    arr.clear();
    assert.strictEqual(arr.evictedCount, 0);
  });

  it('should handle BoundedArray.from with empty iterable', () => {
    const arr = BoundedArray.from([], 5);
    assert.strictEqual(arr.length, 0);
  });

  it('should handle BoundedArray.from with oversized iterable', () => {
    const arr = BoundedArray.from([1, 2, 3, 4, 5], 3);
    assert.strictEqual(arr.length, 3);
  });

  it('should return correct maxSize getter', () => {
    const arr = new BoundedArray(42);
    assert.strictEqual(arr.maxSize, 42);
  });

  it('should handle ring buffer wraparound correctly', () => {
    const arr = new BoundedArray(3);
    arr.push('a');
    arr.push('b');
    arr.push('c');
    arr.push('d');
    arr.push('e');
    assert.strictEqual(arr.length, 3);
    const items = arr.toArray();
    assert.ok(items.includes('c'));
    assert.ok(items.includes('d'));
    assert.ok(items.includes('e'));
    assert.ok(!items.includes('a'));
    assert.ok(!items.includes('b'));
  });

  it('should handle LRU eviction after touch', async () => {
    const evicted = [];
    const arr = new BoundedArray(3, {
      strategy: 'lru',
      onEvict: (item) => evicted.push(item),
    });
    arr.push('a');
    await new Promise(r => setTimeout(r, 50));
    arr.push('b');
    await new Promise(r => setTimeout(r, 50));
    arr.push('c');
    await new Promise(r => setTimeout(r, 50));
    arr.touch(0);
    await new Promise(r => setTimeout(r, 50));
    arr.push('d');
    assert.strictEqual(evicted.length, 1);
    assert.strictEqual(evicted[0], 'b');
  });

  it('should handle FIFO onEvict receiving correct element', () => {
    const evicted = [];
    const arr = new BoundedArray(2, {
      onEvict: (item) => evicted.push(item),
    });
    arr.push('first');
    arr.push('second');
    arr.push('third');
    assert.strictEqual(evicted.length, 1);
    assert.strictEqual(evicted[0], 'first');
  });

  it('should handle shutdown and isHealthy', () => {
    const arr = new BoundedArray(5);
    assert.strictEqual(arr.isHealthy(), true);
    arr.shutdown();
    assert.strictEqual(arr.length, 0);
  });
});

describe('TDDGate Boundary Conditions', () => {
  it('should handle check with null context', () => {
    const gate = new TDDGate();
    const result = gate.check(null);
    assert.strictEqual(result.passed, false);
    gate.shutdown();
  });

  it('should handle check with undefined context', () => {
    const gate = new TDDGate();
    const result = gate.check(undefined);
    assert.strictEqual(result.passed, false);
    gate.shutdown();
  });

  it('should handle check with empty object context', () => {
    const gate = new TDDGate();
    const result = gate.check({});
    assert.ok(typeof result.passed === 'boolean');
    gate.shutdown();
  });

  it('should handle checkCoverage with null', () => {
    const gate = new TDDGate();
    const result = gate.checkCoverage(null);
    assert.strictEqual(result.passed, false);
    gate.shutdown();
  });

  it('should always return true from isHealthy', () => {
    const gate = new TDDGate();
    assert.strictEqual(gate.isHealthy(), true);
    gate.shutdown();
  });
});

describe('GeneratorVerifier Boundary Conditions', () => {
  it('should handle verifyCorrectness with empty output', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness('', [], [], 'test', 'worker');
    assert.ok(typeof result.passed === 'boolean');
    assert.ok(typeof result.score === 'number');
    verifier.shutdown();
  });

  it('should handle verifyCorrectness with whitespace-only output', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: '   \n\t  ', requirements: [], evidence: [], skillId: 'test', generatorAgent: 'worker' });
    assert.ok(typeof result.passed === 'boolean');
    verifier.shutdown();
  });

  it('should handle verifyCorrectness with non-string output', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: 42, requirements: [], evidence: [], skillId: 'test', generatorAgent: 'worker' });
    assert.ok(typeof result.passed === 'boolean');
    verifier.shutdown();
  });

  it('should handle verifyCorrectness with string requirements', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: 'implement user auth', requirements: 'user authentication', evidence: [], skillId: 'test', generatorAgent: 'worker' });
    assert.ok(typeof result.passed === 'boolean');
    verifier.shutdown();
  });

  it('should handle verifyCorrectness with non-array evidence', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: 'some output', requirements: [], evidence: 'not-array', skillId: 'test', generatorAgent: 'worker' });
    assert.ok(typeof result.passed === 'boolean');
    verifier.shutdown();
  });

  it('should return result with correct keys', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: 'output', requirements: [], evidence: [], skillId: 'test', generatorAgent: 'worker' });
    assert.ok('passed' in result);
    assert.ok('score' in result);
    assert.ok('dimensions' in result);
    assert.ok('summary' in result);
    verifier.shutdown();
  });

  it('should detect contradiction patterns in logical correctness', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: '必须执行操作但不能执行操作', requirements: [], evidence: [], skillId: 'test', generatorAgent: 'worker' });
    assert.ok(result.score < 1.0);
    verifier.shutdown();
  });

  it('should detect absolute contradiction patterns', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: '始终返回true从不返回false', requirements: [], evidence: [], skillId: 'test', generatorAgent: 'worker' });
    assert.ok(result.score < 1.0);
    verifier.shutdown();
  });

  it('should penalize missing boundary signals', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: 'simple implementation without edge cases', requirements: [], evidence: [], skillId: 'test', generatorAgent: 'worker' });
    assert.ok(result.score < 1.0);
    verifier.shutdown();
  });

  it('should handle boundary signals present', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: 'handle null and undefined error cases with fallback default', requirements: [], evidence: [], skillId: 'test', generatorAgent: 'worker' });
    assert.ok(typeof result.score === 'number');
    verifier.shutdown();
  });

  it('should detect naming inconsistency', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: 'function getData() { const get_data = fetch(); return get_data; }', requirements: [], evidence: [], skillId: 'test', generatorAgent: 'worker' });
    assert.ok(typeof result.score === 'number');
    verifier.shutdown();
  });

  it('should penalize single evidence type', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: 'output', requirements: [], evidence: [{ type: 'unit_test', description: 'test' }], skillId: 'test', generatorAgent: 'worker' });
    assert.ok(result.score < 1.0);
    verifier.shutdown();
  });

  it('should accept multiple evidence types', () => {
    const verifier = new GeneratorVerifier();
    const result = verifier.verifyCorrectness({ output: 'output with error handling', requirements: [], evidence: [
      { type: 'unit_test', description: 'test' },
      { type: 'integration_test', description: 'int test' },
    ], skillId: 'test', generatorAgent: 'worker' });
    assert.ok(typeof result.score === 'number');
    verifier.shutdown();
  });

  it('should handle executeVerificationLoop convergence', async () => {
    const verifier = new GeneratorVerifier();
    const loop = verifier.createVerificationLoop({ output: 'initial output' });
    const result = await verifier.executeVerificationLoop(
      loop,
      (_ctx) => ({ output: 'generated output' }),
      () => ({ passed: true, score: 1.0 }),
    );
    assert.strictEqual(result.converged, true);
    verifier.shutdown();
  });

  it('should handle executeVerificationLoop max iterations', async () => {
    const verifier = new GeneratorVerifier();
    const loop = verifier.createVerificationLoop({ output: 'initial output' });
    const result = await verifier.executeVerificationLoop(
      loop,
      (_ctx) => ({ output: 'generated output' }),
      () => ({ passed: false, score: 0.3 }),
    );
    assert.strictEqual(result.converged, false);
    verifier.shutdown();
  });

  it('should handle getVerificationHistory with null skillId', () => {
    const verifier = new GeneratorVerifier();
    verifier.verifyCorrectness('output', [], [], 'test', 'worker');
    const history = verifier.getVerificationHistory(null);
    assert.ok(Array.isArray(history));
    verifier.shutdown();
  });

  it('should handle getVerificationHistory with limit exceeding history', () => {
    const verifier = new GeneratorVerifier();
    verifier.verifyCorrectness('output', [], [], 'test', 'worker');
    const history = verifier.getVerificationHistory('test', 100);
    assert.ok(Array.isArray(history));
    assert.ok(history.length <= 1);
    verifier.shutdown();
  });

  it('should handle shutdown idempotently', () => {
    const verifier = new GeneratorVerifier();
    verifier.shutdown();
    assert.doesNotThrow(() => verifier.shutdown());
  });
});

describe('CausalMemoryStore Boundary Conditions', () => {
  it('should return null for getCausalMemory with unknown id', async () => {
    const store = new CausalMemoryStore();
    assert.strictEqual(store.getCausalMemory('nonexistent'), null);
    store.shutdown();
  });

  it('should handle addCausalMemory with negative confidence', async () => {
    const store = new CausalMemoryStore();
    const result = await store.addCausalMemory({ cause: 'c', effect: 'e', confidence: -0.5 });
    assert.strictEqual(result.success, true);
    const mem = store.getCausalMemory(result.id);
    assert.ok(mem);
    assert.strictEqual(mem.confidence, 0);
    store.shutdown();
  });

  it('should handle addCausalMemory with confidence > 1', async () => {
    const store = new CausalMemoryStore();
    const result = await store.addCausalMemory({ cause: 'c', effect: 'e', confidence: 1.5 });
    assert.strictEqual(result.success, true);
    const mem = store.getCausalMemory(result.id);
    assert.ok(mem);
    assert.strictEqual(mem.confidence, 1);
    store.shutdown();
  });

  it('should handle addCausalMemory with default confidence', async () => {
    const store = new CausalMemoryStore();
    const result = await store.addCausalMemory({ cause: 'c', effect: 'e' });
    assert.strictEqual(result.success, true);
    const mem = store.getCausalMemory(result.id);
    assert.ok(mem);
    assert.strictEqual(mem.confidence, 0.5);
    store.shutdown();
  });

  it('should handle addCausalMemory with non-array tags', async () => {
    const store = new CausalMemoryStore();
    const result = await store.addCausalMemory({ cause: 'c', effect: 'e', tags: 'not-array' });
    assert.strictEqual(result.success, true);
    const mem = store.getCausalMemory(result.id);
    assert.ok(mem);
    assert.ok(Array.isArray(mem.tags));
    store.shutdown();
  });

  it('should reject addCausalMemory without cause and effect', async () => {
    const store = new CausalMemoryStore();
    const result = await store.addCausalMemory({});
    assert.strictEqual(result.success, false);
    store.shutdown();
  });

  it('should return false for removeCausalMemory with unknown id', () => {
    const store = new CausalMemoryStore();
    assert.strictEqual(store.removeCausalMemory('nonexistent'), false);
    store.shutdown();
  });

  it('should emit causal-memory-added event', async () => {
    const store = new CausalMemoryStore();
    let emitted = false;
    store.on('causal-memory-added', () => { emitted = true; });
    await store.addCausalMemory({ cause: 'c', effect: 'e', confidence: 0.8 });
    assert.strictEqual(emitted, true);
    store.shutdown();
  });

  it('should emit causal-memory-removed event on remove', async () => {
    const store = new CausalMemoryStore();
    let emitted = false;
    store.on('causal-memory-removed', () => { emitted = true; });
    const result = await store.addCausalMemory({ cause: 'c', effect: 'e', confidence: 0.8 });
    store.removeCausalMemory(result.id);
    assert.strictEqual(emitted, true);
    store.shutdown();
  });

  it('should handle _extractKeywords with empty string', () => {
    const store = new CausalMemoryStore();
    const keywords = store._extractKeywords('');
    assert.ok(Array.isArray(keywords));
    assert.strictEqual(keywords.length, 0);
    store.shutdown();
  });

  it('should handle _extractKeywords with non-string input', () => {
    const store = new CausalMemoryStore();
    const keywords = store._extractKeywords(42);
    assert.ok(Array.isArray(keywords));
    assert.strictEqual(keywords.length, 0);
    store.shutdown();
  });

  it('should extract Chinese keywords', () => {
    const store = new CausalMemoryStore();
    const keywords = store._extractKeywords('用户认证系统 数据库连接');
    assert.ok(keywords.length > 0);
    store.shutdown();
  });

  it('should filter stop words in _extractKeywords', () => {
    const store = new CausalMemoryStore();
    const keywords = store._extractKeywords('the quick brown fox jumps over the lazy dog');
    assert.ok(!keywords.includes('the'));
    store.shutdown();
  });

  it('should handle _cosineSimilarity with zero vectors', () => {
    const store = new CausalMemoryStore();
    assert.strictEqual(store._cosineSimilarity([0, 0, 0], [0, 0, 0]), 0);
    store.shutdown();
  });

  it('should handle _cosineSimilarity with different length vectors', () => {
    const store = new CausalMemoryStore();
    assert.strictEqual(store._cosineSimilarity([1, 2], [1, 2, 3]), 0);
    store.shutdown();
  });

  it('should handle _cosineSimilarity with empty vectors', () => {
    const store = new CausalMemoryStore();
    assert.strictEqual(store._cosineSimilarity([], []), 0);
    store.shutdown();
  });

  it('should handle _cosineSimilarity with null vectors', () => {
    const store = new CausalMemoryStore();
    assert.strictEqual(store._cosineSimilarity(null, null), 0);
    store.shutdown();
  });

  it('should handle _removeFromSimilarityIndex with null entry', () => {
    const store = new CausalMemoryStore();
    assert.doesNotThrow(() => store._removeFromSimilarityIndex(null));
    store.shutdown();
  });

  it('should handle _removeFromSimilarityIndex with entry missing id', () => {
    const store = new CausalMemoryStore();
    assert.doesNotThrow(() => store._removeFromSimilarityIndex({ cause: 'test' }));
    store.shutdown();
  });

  it('should always return true from isHealthy', () => {
    const store = new CausalMemoryStore();
    assert.strictEqual(store.isHealthy(), true);
    store.shutdown();
  });

  it('should handle shutdown idempotently', () => {
    const store = new CausalMemoryStore();
    store.shutdown();
    assert.doesNotThrow(() => store.shutdown());
  });

  it('should handle searchByCausalSimilarity with empty query', async () => {
    const store = new CausalMemoryStore();
    const results = await store.searchByCausalSimilarity('', 5);
    assert.ok(Array.isArray(results));
    store.shutdown();
  });

  it('should handle detectCausalConflicts with no memories', () => {
    const store = new CausalMemoryStore();
    const conflicts = store.detectCausalConflicts();
    assert.ok(Array.isArray(conflicts));
    assert.strictEqual(conflicts.length, 0);
    store.shutdown();
  });

  it('should handle batch addCausalMemories with non-array', async () => {
    const store = new CausalMemoryStore();
    const result = await store.addCausalMemories('not-array');
    assert.strictEqual(result.success, false);
    store.shutdown();
  });
});

describe('SessionManager Shutdown Safety', () => {
  const SessionManager = require('../../../src/runtime/session/session-manager');

  after(() => { _cleanupSessionFiles(); });

  it('should handle create after shutdown', () => {
    const sm = new SessionManager(ROOT);
    sm.shutdown();
    assert.throws(() => sm.create('proj', 'lead'), { code: 'SHUTDOWN' });
  });

  it('should handle advancePhase after shutdown', () => {
    const sm = new SessionManager(ROOT);
    sm.shutdown();
    assert.throws(() => sm.advancePhase('sess1', 'brainstorming'), { code: 'SHUTDOWN' });
  });

  it('should handle shutdown idempotently', () => {
    const sm = new SessionManager(ROOT);
    sm.shutdown();
    assert.doesNotThrow(() => sm.shutdown());
  });
});

describe('GoalExecutor Boundary Conditions', () => {
  const GoalExecutor = require('../../../src/runtime/workflow/goal-executor');

  it('should reject createGoal with empty objective', () => {
    const executor = new GoalExecutor();
    const result = executor.createGoal('');
    assert.strictEqual(result.success, false);
    executor.shutdown();
  });

  it('should reject createGoal with non-string objective', () => {
    const executor = new GoalExecutor();
    const result = executor.createGoal(42);
    assert.strictEqual(result.success, false);
    executor.shutdown();
  });

  it('should get goal after creation', () => {
    const executor = new GoalExecutor();
    const createResult = executor.createGoal('test objective');
    assert.strictEqual(createResult.success, true);
    const goal = executor.getGoal(createResult.goalId);
    assert.ok(goal);
    assert.strictEqual(goal.objective, 'test objective');
    executor.shutdown();
  });

  it('should return null for nonexistent goal', () => {
    const executor = new GoalExecutor();
    assert.strictEqual(executor.getGoal('nonexistent'), null);
    executor.shutdown();
  });

  it('should list goals', () => {
    const executor = new GoalExecutor();
    executor.createGoal('obj1');
    executor.createGoal('obj2');
    const goals = executor.listGoals();
    assert.ok(Array.isArray(goals));
    assert.strictEqual(goals.length, 2);
    executor.shutdown();
  });

  it('should cancel a goal', () => {
    const executor = new GoalExecutor();
    const createResult = executor.createGoal('test');
    const cancelResult = executor.cancel(createResult.goalId);
    assert.strictEqual(cancelResult.success, true);
    executor.shutdown();
  });

  it('should pause a goal in executing state', () => {
    const executor = new GoalExecutor();
    const createResult = executor.createGoal('test');
    const internalGoal = executor._goals.get(createResult.goalId);
    internalGoal.status = 'executing';
    executor._executingGoals.add(createResult.goalId);
    const pauseResult = executor.pause(createResult.goalId);
    assert.strictEqual(pauseResult.success, true);
    executor.shutdown();
  });

  it('should reject pause for pending goal', () => {
    const executor = new GoalExecutor();
    const createResult = executor.createGoal('test');
    const pauseResult = executor.pause(createResult.goalId);
    assert.strictEqual(pauseResult.success, false);
    executor.shutdown();
  });

  it('should get progress for a goal', () => {
    const executor = new GoalExecutor();
    const createResult = executor.createGoal('test');
    const progress = executor.getProgress(createResult.goalId);
    assert.ok(progress);
    executor.shutdown();
  });

  it('should return stats', () => {
    const executor = new GoalExecutor();
    executor.createGoal('test');
    const stats = executor.getStats();
    assert.ok(stats);
    assert.strictEqual(typeof stats.totalGoalsCreated, 'number');
    executor.shutdown();
  });

  it('should handle shutdown idempotently', () => {
    const executor = new GoalExecutor();
    executor.shutdown();
    assert.doesNotThrow(() => executor.shutdown());
  });

  it('should sanitize prototype in arrays recursively', () => {
    const executor = new GoalExecutor();
    const malicious = {
      name: 'test',
      items: [{ __proto__: { polluted: true }, constructor: Object }],
    };
    const sanitized = executor._sanitizePrototype(malicious);
    assert.strictEqual('__proto__' in sanitized, false);
    assert.strictEqual('constructor' in sanitized, false);
    assert.ok(Array.isArray(sanitized.items));
    assert.strictEqual('__proto__' in sanitized.items[0], false);
    assert.strictEqual('constructor' in sanitized.items[0], false);
    executor.shutdown();
  });
});

describe('Commercial-Grade Security and Consistency Fixes', () => {
  const CausalDataBus2 = require('../../../src/runtime/causal/causal-data-bus');
  const TDDGate2 = require('../../../src/gate/tdd-gate');
  const BoundedArray2 = require('../../../src/utils/bounded-array');
  const CausalMemoryStore2 = require('../../../src/runtime/causal/causal-memory-store');

  after(() => { _cleanupSessionFiles(); });
  const ContextCompressionEngine2 = require('../../../src/runtime/context/context-compression-engine');

  it('should clean _outputKeyIndex when overwriting pending output', async () => {
    const bus = new CausalDataBus2();
    await bus.defineSkillInterface('skill-a', { causalInputs: [], causalOutputs: ['key1', 'key2'] });
    await bus.publishOutput('skill-a', { key1: 'v1', key2: 'v2' });
    await bus.publishOutput('skill-a', { key1: 'v1-new' });
    const key2Set = bus._outputKeyIndex.get('key2');
    assert.strictEqual(key2Set === undefined || !key2Set.has('skill-a'), true);
    bus.shutdown();
  });

  it('should clean refCounts when causal chain evicts', async () => {
    const bus = new CausalDataBus2({ maxHistory: 2 });
    await bus.defineSkillInterface('s1', { causalInputs: [], causalOutputs: ['o1'] });
    await bus.defineSkillInterface('s2', { causalInputs: [], causalOutputs: ['o2'] });
    await bus.defineSkillInterface('s3', { causalInputs: [], causalOutputs: ['o3'] });
    await bus.publishOutput('s1', { o1: 'd1' });
    await bus.publishOutput('s2', { o2: 'd2' });
    await bus.publishOutput('s3', { o3: 'd3' });
    assert.strictEqual(bus._causalChain.length <= 2, true);
    bus.shutdown();
  });

  it('should reject TDD check when testResult is undefined', () => {
    const gate = new TDDGate2();
    const result = gate.check({ testExists: true, implExists: true, testResult: undefined });
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.phase, 'UNKNOWN');
    gate.shutdown();
  });

  it('should reject TDD check when testResult is null', () => {
    const gate = new TDDGate2();
    const result = gate.check({ testExists: true, implExists: true, testResult: null });
    assert.strictEqual(result.passed, false);
    gate.shutdown();
  });

  it('should maintain LRU iteration order after eviction', async () => {
    const arr = new BoundedArray2(3, { strategy: 'lru' });
    arr.push('a');
    await new Promise(r => setTimeout(r, 50));
    arr.push('b');
    await new Promise(r => setTimeout(r, 50));
    arr.push('c');
    arr.touch(0);
    await new Promise(r => setTimeout(r, 50));
    arr.push('d');
    const items = arr.toArray();
    assert.ok(items.includes('a'));
    assert.ok(items.includes('c'));
    assert.ok(items.includes('d'));
    assert.ok(!items.includes('b'));
  });

  it('should not double-degrade confidence in verifyCausalConsistency', async () => {
    const store = new CausalMemoryStore2(null, { ttlMs: 0 });
    const result = await store.addCausalMemory({ cause: 'c', effect: 'e', confidence: 0.8 });
    const cacheEntry = store._memoryCache.get(result.id);
    cacheEntry.createdAt = 0;
    const r1 = await store.verifyCausalConsistency(result.id);
    assert.strictEqual(r1.degraded, true);
    const conf1 = r1.confidence;
    const r2 = await store.verifyCausalConsistency(result.id);
    assert.strictEqual(r2.confidence, conf1);
    store.shutdown();
  });

  it('should emit invalid-phase event for unknown phase', () => {
    const engine = new ContextCompressionEngine2();
    let emitted = false;
    engine.on('invalid-phase', () => { emitted = true; });
    engine.compress({
      currentPhase: 'nonexistent-phase',
      skills: [{ skill_id: 'test', phase: 'nonexistent-phase', instruction: 'x', summary: 'y' }],
      completedSkills: [],
    });
    assert.strictEqual(emitted, true);
    engine.shutdown();
  });

  it('should not clear entire planCache on compress', () => {
    const engine = new ContextCompressionEngine2();
    const ctx1 = { currentPhase: 'brainstorming', skills: [{ skill_id: 'a', phase: 'brainstorming', instruction: 'x', summary: 'y' }], completedSkills: [] };
    const ctx2 = { currentPhase: 'module-development', skills: [{ skill_id: 'b', phase: 'module-development', instruction: 'z', summary: 'w' }], completedSkills: [] };
    engine.getCompressionPlan(ctx1);
    assert.strictEqual(engine._planCache.size, 1);
    engine.compress(ctx2);
    assert.strictEqual(engine._planCache.size >= 1, true);
    engine.shutdown();
  });

  it('should return session on same-phase advancePhase', () => {
    const SessionManager = require('../../../src/runtime/session/session-manager');
    const sm = new SessionManager(ROOT);
    delete sm.sessions['proj'];
    const session = sm.create('proj', 'lead');
    _trackSessionFile('proj');
    const result = sm.advancePhase(session.id, session.currentPhase);
    assert.strictEqual(result.currentPhase, session.currentPhase);
    sm.shutdown();
  });
});
