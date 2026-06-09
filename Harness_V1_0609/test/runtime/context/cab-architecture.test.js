'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const PhaseContextInjector = require('../../../src/runtime/context/phase-context-injector');
const CausalDataBus = require('../../../src/runtime/causal/causal-data-bus');
const CausalMemoryStore = require('../../../src/runtime/causal/causal-memory-store');
const ConfigCausalValidator = require('../../../src/runtime/causal/causal-config-validator');

describe('PhaseContextInjector', () => {
  let injector;

  beforeEach(() => {
    injector = new PhaseContextInjector(process.cwd());
  });

  it('should inject context for brainstorming phase', () => {
    const result = injector.injectForPhase('brainstorming');
    assert.strictEqual(result.phase, 'brainstorming');
    assert.strictEqual(Array.isArray(result.rules), true);
    assert.strictEqual(Array.isArray(result.agents), true);
    assert.strictEqual(Array.isArray(result.phaseSkills), true);
    assert.strictEqual(typeof result.estimatedTokens, 'number');
  });

  it('should inject fewer rules for brainstorming than module-development', () => {
    const brainstorm = injector.injectForPhase('brainstorming');
    const moduleDev = injector.injectForPhase('module-development');
    assert.strictEqual(brainstorm.rules.length < moduleDev.rules.length, true);
  });

  it('should inject fewer agents for brainstorming than module-development', () => {
    const brainstorm = injector.injectForPhase('brainstorming');
    const moduleDev = injector.injectForPhase('module-development');
    assert.strictEqual(brainstorm.agents.length < moduleDev.agents.length, true);
  });

  it('should use cache for same phase', () => {
    const r1 = injector.injectForPhase('brainstorming');
    const r2 = injector.injectForPhase('brainstorming');
    assert.deepStrictEqual(r1, r2);
  });

  it('should default to brainstorming for invalid phase', () => {
    const result = injector.injectForPhase('invalid-phase');
    assert.strictEqual(result.phase, 'brainstorming');
  });

  it('should extract core identity from CLAUDE.md', () => {
    const result = injector.injectForPhase('brainstorming');
    assert.strictEqual(typeof result.coreIdentity.content, 'string');
    assert.strictEqual(result.coreIdentity.lines <= 60, true);
  });

  it('should get stats', () => {
    injector.injectForPhase('brainstorming');
    const stats = injector.getStats();
    assert.strictEqual(stats.currentPhase, 'brainstorming');
    assert.strictEqual(typeof stats.injectedTokenEstimate, 'number');
  });

  it('should get phase rules map', () => {
    const map = injector.getPhaseRulesMap();
    assert.strictEqual(typeof map, 'object');
    assert.strictEqual(Array.isArray(map['module-development']), true);
    assert.strictEqual(map['module-development'].includes('coding-standards'), true);
    assert.strictEqual(map['brainstorming'].includes('coding-standards'), false);
  });

  it('should get phase agents map', () => {
    const map = injector.getPhaseAgentsMap();
    assert.strictEqual(typeof map, 'object');
    assert.strictEqual(map['brainstorming'].includes('team-lead'), true);
    assert.strictEqual(map['module-development'].includes('task-worker'), true);
  });

  it('should clear cache', () => {
    injector.injectForPhase('brainstorming');
    injector.clearCache();
    const stats = injector.getStats();
    assert.strictEqual(stats.cacheSize, 0);
  });

  it('should shutdown cleanly', () => {
    injector.shutdown();
  });
});

describe('CausalDataBus', () => {
  let bus;

  beforeEach(() => {
    bus = new CausalDataBus();
  });

  it('should define skill interface', async () => {
    const iface = await bus.defineSkillInterface('tdd-implement', {
      causalInputs: ['description', 'goal'],
      causalOutputs: ['test_code', 'implementation_code', 'test_results'],
      invariants: ['tests_must_pass'],
    });
    assert.strictEqual(iface.skillId, 'tdd-implement');
    assert.strictEqual(iface.causalInputs.length, 2);
    assert.strictEqual(iface.causalOutputs.length, 3);
  });

  it('should reject invalid skill interface', async () => {
    await assert.rejects(async () => bus.defineSkillInterface('', {}));
    await assert.rejects(async () => bus.defineSkillInterface(null, {}));
  });

  it('should validate inputs for skill with interface', async () => {
    await bus.defineSkillInterface('tdd-implement', {
      causalInputs: ['description', 'goal'],
      causalOutputs: ['test_code'],
    });
    const valid = bus.validateInputs('tdd-implement', { description: 'test', goal: 'pass' });
    assert.strictEqual(valid.valid, true);
    const invalid = bus.validateInputs('tdd-implement', {});
    assert.strictEqual(invalid.valid, false);
    assert.strictEqual(invalid.missing.length, 2);
  });

  it('should validate inputs for skill without interface', () => {
    const result = bus.validateInputs('unknown-skill', {});
    assert.strictEqual(result.valid, true);
  });

  it('should publish output', async () => {
    await bus.defineSkillInterface('tdd-implement', {
      causalInputs: ['description'],
      causalOutputs: ['test_code', 'implementation_code'],
    });
    const result = await bus.publishOutput('tdd-implement', {
      test_code: 'assert(true)',
      implementation_code: 'function add(a,b) { return a+b; }',
    });
    assert.strictEqual(result, true);
  });

  it('should consume inputs from published outputs', async () => {
    await bus.defineSkillInterface('tdd-implement', {
      causalInputs: ['description'],
      causalOutputs: ['test_code', 'implementation_code'],
    });
    await bus.defineSkillInterface('code-review', {
      causalInputs: [{ name: 'implementation_code', source: 'tdd-implement' }],
      causalOutputs: ['review_result'],
    });
    await bus.publishOutput('tdd-implement', {
      test_code: 'assert(true)',
      implementation_code: 'function add(a,b) { return a+b; }',
    });
    const inputs = bus.consumeInputs('code-review');
    assert.strictEqual(typeof inputs.implementation_code, 'string');
  });

  it('should detect conflicts between outputs', () => {
    const conflicts = bus.detectConflicts(
      { name: 'Alice', version: 1 },
      { name: 'Bob', version: 2 },
    );
    assert.strictEqual(conflicts.length, 2);
    assert.strictEqual(conflicts[0].key, 'name');
  });

  it('should resolve conflicts with default strategy', () => {
    const conflicts = bus.detectConflicts(
      { name: 'Alice' },
      { name: 'Bob' },
    );
    const resolved = bus.resolveConflicts(conflicts, 'default');
    assert.strictEqual(resolved.name, 'Alice');
  });

  it('should register custom conflict resolver', () => {
    bus.registerConflictResolver('latest', (c) => c.value2);
    const conflicts = bus.detectConflicts({ name: 'Alice' }, { name: 'Bob' });
    const resolved = bus.resolveConflicts(conflicts, 'latest');
    assert.strictEqual(resolved.name, 'Bob');
  });

  it('should get causal chain', async () => {
    await bus.publishOutput('skill-a', { result: 1 });
    await bus.publishOutput('skill-b', { result: 2 });
    const chain = bus.getCausalChain();
    assert.strictEqual(chain.length, 2);
  });

  it('should get causal chain for specific skill', async () => {
    await bus.publishOutput('skill-a', { result: 1 });
    await bus.publishOutput('skill-b', { result: 2 });
    await bus.publishOutput('skill-a', { result: 3 });
    const chain = bus.getCausalChainForSkill('skill-a');
    assert.strictEqual(chain.length, 2);
  });

  it('should get stats', async () => {
    await bus.defineSkillInterface('test', { causalInputs: ['x'], causalOutputs: ['y'] });
    await bus.publishOutput('test', { y: 42 });
    const stats = bus.getStats();
    assert.strictEqual(stats.definedInterfaces, 1);
    assert.strictEqual(stats.chainLength, 1);
  });

  it('should shutdown cleanly', () => {
    bus.shutdown();
  });

  it('should detect parallel conflicts', async () => {
    await bus.publishOutput('skill-a', { name: 'Alice', version: 1 });
    await bus.publishOutput('skill-b', { name: 'Bob', version: 1 });
    const result = bus.detectParallelConflicts(['skill-a', 'skill-b']);
    assert.strictEqual(result.hasConflicts, true);
    assert.strictEqual(result.conflicts.length > 0, true);
    assert.strictEqual(result.overlappingKeys.includes('name'), true);
  });

  it('should return no conflicts for non-overlapping parallel outputs', async () => {
    await bus.publishOutput('skill-a', { output_a: 1 });
    await bus.publishOutput('skill-b', { output_b: 2 });
    const result = bus.detectParallelConflicts(['skill-a', 'skill-b']);
    assert.strictEqual(result.hasConflicts, false);
  });

  it('should merge parallel outputs with last-wins strategy', async () => {
    await bus.publishOutput('skill-a', { name: 'Alice', shared: 1 });
    await bus.publishOutput('skill-b', { name: 'Bob', shared: 2 });
    const result = bus.mergeParallelOutputs(['skill-a', 'skill-b'], 'last-wins');
    assert.strictEqual(result.merged.name, 'Bob');
    assert.strictEqual(result.merged.shared, 2);
    assert.strictEqual(result.conflicts.length > 0, true);
  });

  it('should merge parallel outputs with first-wins strategy', async () => {
    await bus.publishOutput('skill-a', { name: 'Alice', shared: 1 });
    await bus.publishOutput('skill-b', { name: 'Bob', shared: 2 });
    const result = bus.mergeParallelOutputs(['skill-a', 'skill-b'], 'first-wins');
    assert.strictEqual(result.merged.name, 'Alice');
    assert.strictEqual(result.merged.shared, 1);
  });

  it('should merge parallel outputs with union strategy', async () => {
    await bus.publishOutput('skill-a', { items: [1, 2], extra: 'a' });
    await bus.publishOutput('skill-b', { items: [3, 4], extra2: 'b' });
    const result = bus.mergeParallelOutputs(['skill-a', 'skill-b'], 'union');
    assert.strictEqual(Array.isArray(result.merged.items), true);
    assert.strictEqual(result.merged.items.length, 4);
    assert.strictEqual(result.merged.extra, 'a');
    assert.strictEqual(result.merged.extra2, 'b');
  });

  it('should handle empty skillIds for merge', () => {
    const result = bus.mergeParallelOutputs([], 'last-wins');
    assert.strictEqual(Object.keys(result.merged).length, 0);
  });

  it('should handle single skill for merge', async () => {
    await bus.publishOutput('skill-a', { name: 'Alice' });
    const result = bus.mergeParallelOutputs(['skill-a'], 'last-wins');
    assert.strictEqual(result.merged.name, 'Alice');
    assert.strictEqual(result.conflicts.length, 0);
  });

  it('should expose MERGE_STRATEGIES', () => {
    assert.strictEqual(typeof CausalDataBus.MERGE_STRATEGIES, 'object');
    assert.strictEqual(CausalDataBus.MERGE_STRATEGIES.LAST_WINS, 'last-wins');
    assert.strictEqual(CausalDataBus.MERGE_STRATEGIES.FIRST_WINS, 'first-wins');
    assert.strictEqual(CausalDataBus.MERGE_STRATEGIES.UNION, 'union');
  });
});

describe('CausalMemoryStore', () => {
  let store;

  beforeEach(() => {
    store = new CausalMemoryStore(null);
  });

  it('should add causal memory', async () => {
    const result = await store.addCausalMemory({
      cause: 'User requested authentication feature',
      effect: 'Implemented JWT-based auth module',
      context: 'E-commerce platform, Node.js backend',
      confidence: 0.9,
      category: 'implementation',
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(typeof result.id, 'string');
  });

  it('should reject memory without cause and effect', async () => {
    const result = await store.addCausalMemory({ context: 'test' });
    assert.strictEqual(result.success, false);
  });

  it('should clamp confidence to 0-1 range', async () => {
    const result = await store.addCausalMemory({
      cause: 'test cause',
      effect: 'test effect',
      confidence: 1.5,
    });
    assert.strictEqual(result.success, true);
    const mem = store.getCausalMemory(result.id);
    assert.strictEqual(mem.confidence, 1);
  });

  it('should search by causal similarity', async () => {
    await store.addCausalMemory({
      cause: 'Implement user authentication with JWT tokens',
      effect: 'Created auth middleware and login endpoint',
      context: 'Node.js Express application',
      confidence: 0.9,
    });
    await store.addCausalMemory({
      cause: 'Fix memory leak in event listeners',
      effect: 'Added cleanup in shutdown method',
      context: 'Browser application',
      confidence: 0.8,
    });
    const results = await store.searchByCausalSimilarity('authentication JWT login', { limit: 5 });
    assert.strictEqual(results.length > 0, true);
    assert.strictEqual(results[0].cause.includes('authentication'), true);
  });

  it('should verify causal consistency', async () => {
    const { id } = await store.addCausalMemory({
      cause: 'test cause',
      effect: 'test effect',
      confidence: 0.8,
    });
    const result = await store.verifyCausalConsistency(id);
    assert.strictEqual(result.valid, true);
  });

  it('should get causal memories with filter', async () => {
    await store.addCausalMemory({ cause: 'c1', effect: 'e1', category: 'bug' });
    await store.addCausalMemory({ cause: 'c2', effect: 'e2', category: 'feature' });
    const bugs = store.getCausalMemories({ category: 'bug' });
    assert.strictEqual(bugs.length, 1);
    assert.strictEqual(bugs[0].category, 'bug');
  });

  it('should remove causal memory', async () => {
    const { id } = await store.addCausalMemory({ cause: 'c', effect: 'e' });
    assert.strictEqual(store.removeCausalMemory(id), true);
    assert.strictEqual(store.getCausalMemory(id), null);
  });

  it('should get stats', async () => {
    await store.addCausalMemory({ cause: 'c', effect: 'e', confidence: 0.8 });
    const stats = store.getStats();
    assert.strictEqual(stats.totalMemories, 1);
    assert.strictEqual(typeof stats.avgConfidence, 'number');
  });

  it('should shutdown cleanly', () => {
    store.shutdown();
  });

  it('should add multiple causal memories', async () => {
    const result = await store.addCausalMemories([
      { cause: 'c1', effect: 'e1', confidence: 0.8 },
      { cause: 'c2', effect: 'e2', confidence: 0.7 },
      { cause: 'c3', effect: 'e3', confidence: 0.6 },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.count, 3);
  });

  it('should reject non-array for batch add', async () => {
    const result = await store.addCausalMemories('not an array');
    assert.strictEqual(result.success, false);
  });

  it('should trace causal chain', async () => {
    await store.addCausalMemory({ cause: 'User requested feature', effect: 'Designed architecture', confidence: 0.9 });
    await store.addCausalMemory({ cause: 'Designed architecture', effect: 'Implemented module', confidence: 0.85 });
    await store.addCausalMemory({ cause: 'Implemented module', effect: 'Wrote tests', confidence: 0.8 });
    const chain = await store.traceCausalChain('Wrote tests', { maxDepth: 3 });
    assert.strictEqual(Array.isArray(chain), true);
  });

  it('should detect causal conflicts', async () => {
    await store.addCausalMemory({
      cause: 'Implement user authentication with JWT',
      effect: 'Created auth middleware',
      confidence: 0.9,
    });
    await store.addCausalMemory({
      cause: 'Implement user authentication with JWT',
      effect: 'Removed all security checks',
      confidence: 0.3,
    });
    const conflicts = store.detectCausalConflicts();
    assert.strictEqual(Array.isArray(conflicts), true);
  });

  it('should get memories with decay', async () => {
    await store.addCausalMemory({ cause: 'test cause', effect: 'test effect', confidence: 0.9 });
    const withDecay = store.getMemoriesWithDecay();
    assert.strictEqual(withDecay.length, 1);
    assert.strictEqual(typeof withDecay[0].decayedConfidence, 'number');
    assert.strictEqual(withDecay[0].decayedConfidence <= withDecay[0].confidence, true);
  });

  it('should compute text similarity', () => {
    const sim1 = store._computeTextSimilarity('user authentication JWT', 'user authentication JWT');
    assert.strictEqual(sim1, 1);
    const sim2 = store._computeTextSimilarity('user authentication JWT', 'memory leak cleanup');
    assert.strictEqual(sim2 < 0.5, true);
  });

  it('should search by semantic group with category filter', async () => {
    await store.addCausalMemory({ cause: 'auth JWT', effect: 'auth middleware', category: 'security', confidence: 0.9, tags: ['auth'] });
    await store.addCausalMemory({ cause: 'auth JWT', effect: 'login page', category: 'ui', confidence: 0.8, tags: ['auth'] });
    const results = await store.searchBySemanticGroup('authentication JWT', { category: 'security' });
    assert.strictEqual(results.length > 0, true);
    assert.strictEqual(results.every(r => r.category === 'security'), true);
    assert.strictEqual(typeof results[0].weightedScore, 'number');
  });

  it('should search by semantic group with tag filter', async () => {
    await store.addCausalMemory({ cause: 'deploy production', effect: 'release v1', category: 'devops', confidence: 0.9, tags: ['deploy', 'production'] });
    await store.addCausalMemory({ cause: 'deploy staging', effect: 'test release', category: 'devops', confidence: 0.8, tags: ['deploy', 'staging'] });
    const results = await store.searchBySemanticGroup('deploy', { tags: ['production'] });
    assert.strictEqual(results.length > 0, true);
    assert.strictEqual(results.every(r => Array.isArray(r.tags) && r.tags.includes('production')), true);
  });

  it('should search by context chain with completed skills', async () => {
    await store.addCausalMemory({ cause: 'brainstorming design', effect: 'requirement spec', category: 'planning', confidence: 0.9 });
    await store.addCausalMemory({ cause: 'architecture brainstorming', effect: 'system design', category: 'planning', confidence: 0.85 });
    const results = await store.searchByContextChain('design', ['brainstorming'], { limit: 5 });
    assert.strictEqual(Array.isArray(results), true);
  });

  it('should return empty for semantic group with no matches', async () => {
    await store.addCausalMemory({ cause: 'auth JWT', effect: 'auth middleware', category: 'security', confidence: 0.9 });
    const results = await store.searchBySemanticGroup('database migration', { category: 'security' });
    assert.strictEqual(results.length, 0);
  });
});

describe('ConfigCausalValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new ConfigCausalValidator(process.cwd());
  });

  it('should build dependency graph', () => {
    const graph = validator.buildDependencyGraph();
    assert.strictEqual(typeof graph, 'object');
    assert.strictEqual(Array.isArray(graph.errors), true);
  });

  it('should validate configuration', () => {
    const result = validator.validate();
    assert.strictEqual(typeof result.valid, 'boolean');
    assert.strictEqual(Array.isArray(result.errors), true);
    assert.strictEqual(Array.isArray(result.warnings), true);
    assert.strictEqual(typeof result.stats, 'object');
  });

  it('should get stats', () => {
    validator.buildDependencyGraph();
    const stats = validator.getStats();
    assert.strictEqual(stats.status, 'built');
    assert.strictEqual(typeof stats.skills, 'number');
    assert.strictEqual(typeof stats.agents, 'number');
  });

  it('should get impact analysis', () => {
    validator.buildDependencyGraph();
    const impacted = validator.getImpactAnalysis('tdd-implement', 'skill');
    assert.strictEqual(Array.isArray(impacted), true);
  });

  it('should get last validation', () => {
    validator.validate();
    const last = validator.getLastValidation();
    assert.strictEqual(last !== null, true);
  });

  it('should detect circular dependencies', () => {
    validator.buildDependencyGraph();
    const cycles = validator.detectCircularDependencies();
    assert.strictEqual(Array.isArray(cycles), true);
  });

  it('should include circular dependency warning in validation', () => {
    const result = validator.validate();
    assert.strictEqual(Array.isArray(result.warnings), true);
  });

  it('should snapshot config', () => {
    const result = validator.snapshotConfig();
    assert.strictEqual(typeof result, 'boolean');
  });

  it('should detect config drift', () => {
    validator.snapshotConfig();
    const drift = validator.detectConfigDrift();
    assert.strictEqual(typeof drift.drifted, 'boolean');
    assert.strictEqual(typeof drift.reason, 'string');
  });

  it('should track drift state', () => {
    validator.snapshotConfig();
    assert.strictEqual(validator.isDriftDetected(), false);
  });
});
