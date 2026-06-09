'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const AutoReinLearningLoop = require('../../../src/runtime/quality/auto-rein-learning-loop');
const SkillMemoryStore = require('../../../src/runtime/skill/skill-memory-store');
const PostTaskReviewer = require('../../../src/runtime/quality/post-task-reviewer');
const IronRuleEngine = require('../../../src/runtime/sdd/iron-rule-engine');
const { ErrorPreventionGuard } = require('../../../src/gate/error-prevention-guard');
const SelfReflection = require('../../../src/runtime/quality/self-reflection');
const DreamBridge = require('../../../src/runtime/thought/dream-bridge');

function createMockIronRuleEngine() {
  const engine = new IronRuleEngine();
  return engine;
}

function createMockErrorPreventionGuard() {
  return new ErrorPreventionGuard();
}

function createMockSkillImprovementLoop() {
  const learnings = [];
  return {
    recordLearning(entry) {
      const id = learnings.length + 1;
      learnings.push({ id, ...entry });
      return { id };
    },
    getLearnings(skillId) {
      return learnings.filter(function(l) { return l.skillId === skillId; });
    },
    _learnings: learnings,
  };
}

function createMockMemoryPipeline() {
  const entries = [];
  return {
    write(category, data) {
      entries.push({ category, data });
    },
    recall(query) {
      return entries.filter(function(e) { return e.category === query; });
    },
    _entries: entries,
  };
}

function createMockSkillGraph() {
  return {
    getSimilarSkills(skillId) {
      if (skillId === 'skill-a') {
        return [{ skillId: 'skill-b', similarity: 0.8 }];
      }
      return [];
    },
  };
}

const instances = [];

afterEach(function() {
  for (const inst of instances) {
    try { inst.shutdown(); } catch (_e) { void _e; }
  }
  instances.length = 0;
});

describe('AutoReinLearningLoop', function() {
  it('should construct with default config', function() {
    const loop = new AutoReinLearningLoop();
    instances.push(loop);
    assert.ok(loop);
    assert.deepStrictEqual(loop.getStats(), { rulesGenerated: 0, patternsRegistered: 0, learningsRecorded: 0, reviewsCompleted: 0 });
  });

  it('should attach dependencies', function() {
    const loop = new AutoReinLearningLoop();
    instances.push(loop);
    const engine = createMockIronRuleEngine();
    instances.push(engine);
    const guard = createMockErrorPreventionGuard();
    const store = new SkillMemoryStore();
    instances.push(store);
    const impLoop = createMockSkillImprovementLoop();

    loop.attachIronRuleEngine(engine);
    loop.attachErrorPreventionGuard(guard);
    loop.attachSkillMemoryStore(store);
    loop.attachSkillImprovementLoop(impLoop);

    assert.strictEqual(loop._ironRuleEngine, engine);
    assert.strictEqual(loop._errorPreventionGuard, guard);
    assert.strictEqual(loop._skillMemoryStore, store);
    assert.strictEqual(loop._skillImprovementLoop, impLoop);
  });

  it('should process task result with errors', async function() {
    const loop = new AutoReinLearningLoop();
    instances.push(loop);
    const engine = createMockIronRuleEngine();
    instances.push(engine);
    const guard = createMockErrorPreventionGuard();
    loop.attachIronRuleEngine(engine);
    loop.attachErrorPreventionGuard(guard);

    const result = await loop.processTaskResult({
      taskId: 'task-1',
      errors: [{ message: 'Missing null check before method call', description: 'null pointer', solution: 'Add null check' }],
      skillId: 'skill-1',
      agentId: 'agent-1',
    });

    assert.strictEqual(result.processed, true);
    assert.ok(result.patternsRegistered >= 1);
    const stats = loop.getStats();
    assert.ok(stats.reviewsCompleted >= 1);
  });

  it('should extract error patterns from task result', function() {
    const loop = new AutoReinLearningLoop();
    instances.push(loop);

    const patterns = loop._extractErrorPatterns({
      errors: [
        { message: 'error1', description: 'desc1', solution: 'sol1' },
        { message: 'error2' },
      ],
      error: 'single error',
      violations: [{ evidence: 'violation evidence', ruleName: 'test-rule' }],
    });

    assert.strictEqual(patterns.length, 4);
    assert.strictEqual(patterns[0].pattern, 'error1');
    assert.strictEqual(patterns[1].pattern, 'error2');
    assert.strictEqual(patterns[2].pattern, 'single error');
    assert.strictEqual(patterns[3].pattern, 'violation evidence');
  });

  it('should extract rules from reflection result', function() {
    const loop = new AutoReinLearningLoop();
    instances.push(loop);

    const candidates = loop._extractRulesFromReflection({
      reflection: {
        improvements: [
          { description: 'Missing null check', dimension: 'reliability' },
        ],
        qualityTrend: 'degrading',
        recommendedAction: 'rollback-and-revise',
        dimensions: {
          boundary_conditions: { needsAttention: true, score: 0.3 },
          consistency: { needsAttention: false, score: 0.8 },
        },
      },
    });

    assert.ok(candidates.length >= 3);
    assert.ok(candidates.some(function(c) { return c.pattern === 'quality-degradation'; }));
    assert.ok(candidates.some(function(c) { return c.pattern.includes('boundary_conditions'); }));
  });

  it('should match rule templates', function() {
    const loop = new AutoReinLearningLoop();
    instances.push(loop);

    const match = loop._matchTemplate({ pattern: 'Missing null check before method call' });
    assert.ok(match);

    const noMatch = loop._matchTemplate({ pattern: 'completely unrelated pattern xyz' });
    assert.strictEqual(noMatch, null);
  });

  it('should add and remove rule templates', function() {
    const loop = new AutoReinLearningLoop();
    instances.push(loop);

    const added = loop.addRuleTemplate('custom', {
      pattern: /custom\s+pattern/,
      description: 'Custom pattern',
      solution: 'Fix it',
      severity: 'warning',
      category: 'custom',
    });
    assert.strictEqual(added, true);

    const templates = loop.getRuleTemplates();
    assert.ok(templates['custom']);

    const removed = loop.removeRuleTemplate('custom');
    assert.strictEqual(removed, true);
  });

  it('should reject invalid task result', async function() {
    const loop = new AutoReinLearningLoop();
    instances.push(loop);

    const result = await loop.processTaskResult(null);
    assert.strictEqual(result.processed, false);

    const result2 = await loop.processTaskResult('invalid');
    assert.strictEqual(result2.processed, false);
  });

  it('should emit task-processed event', async function() {
    const loop = new AutoReinLearningLoop();
    instances.push(loop);

    let eventFired = false;
    loop.on('task-processed', function() { eventFired = true; });

    await loop.processTaskResult({ taskId: 't1' });
    assert.strictEqual(eventFired, true);
  });

  it('should record history', async function() {
    const loop = new AutoReinLearningLoop();
    instances.push(loop);

    await loop.processTaskResult({ taskId: 't1' });
    await loop.processTaskResult({ taskId: 't2' });

    const history = loop.getHistory();
    assert.strictEqual(history.length, 2);
  });

  it('should shutdown cleanly', function() {
    const loop = new AutoReinLearningLoop();
    instances.push(loop);
    loop.shutdown();
    assert.strictEqual(loop._shutDown, true);
    assert.deepStrictEqual(loop.getStats(), { rulesGenerated: 0, patternsRegistered: 0, learningsRecorded: 0, reviewsCompleted: 0 });
  });
});

describe('SkillMemoryStore', function() {
  it('should construct with default config', function() {
    const store = new SkillMemoryStore();
    instances.push(store);
    assert.ok(store);
    assert.deepStrictEqual(store.getStats(), { experiencesStored: 0, experiencesRetrieved: 0, transfersCompleted: 0, prunedCount: 0 });
  });

  it('should store and retrieve experiences', function() {
    const store = new SkillMemoryStore();
    instances.push(store);

    const result = store.storeExperience('skill-1', {
      type: 'tip',
      content: 'Always validate inputs',
      context: 'API endpoint',
      confidence: 0.9,
    });
    assert.ok(result.id);

    const experiences = store.getExperiences('skill-1');
    assert.strictEqual(experiences.length, 1);
    assert.strictEqual(experiences[0].content, 'Always validate inputs');
    assert.strictEqual(experiences[0].type, 'tip');
  });

  it('should reject invalid experience', function() {
    const store = new SkillMemoryStore();
    instances.push(store);

    const r1 = store.storeExperience('', { type: 'tip', content: 'test' });
    assert.strictEqual(r1.id, null);

    const r2 = store.storeExperience('skill-1', { type: '', content: 'test' });
    assert.strictEqual(r2.id, null);

    const r3 = store.storeExperience('skill-1', { type: 'tip', content: '' });
    assert.strictEqual(r3.id, null);
  });

  it('should get tips, avoidances, and patterns separately', function() {
    const store = new SkillMemoryStore();
    instances.push(store);

    store.storeExperience('skill-1', { type: 'tip', content: 'tip1' });
    store.storeExperience('skill-1', { type: 'avoidance', content: 'avoid1' });
    store.storeExperience('skill-1', { type: 'pattern', content: 'pattern1' });

    const tips = store.getTips('skill-1');
    assert.strictEqual(tips.length, 1);
    assert.strictEqual(tips[0].type, 'tip');

    const avoidances = store.getAvoidances('skill-1');
    assert.strictEqual(avoidances.length, 1);
    assert.strictEqual(avoidances[0].type, 'avoidance');

    const patterns = store.getPatterns('skill-1');
    assert.strictEqual(patterns.length, 1);
    assert.strictEqual(patterns[0].type, 'pattern');
  });

  it('should return empty for unknown skill', function() {
    const store = new SkillMemoryStore();
    instances.push(store);

    assert.deepStrictEqual(store.getExperiences('unknown'), []);
    assert.deepStrictEqual(store.getTips('unknown'), []);
    assert.deepStrictEqual(store.getAvoidances('unknown'), []);
  });

  it('should transfer experiences between skills', function() {
    const store = new SkillMemoryStore();
    instances.push(store);

    store.storeExperience('skill-a', { type: 'tip', content: 'shared tip', confidence: 0.9 });
    store.storeExperience('skill-a', { type: 'avoidance', content: 'shared avoidance', confidence: 0.8 });

    const result = store.transferExperiences('skill-a', 'skill-b', 0.8);
    assert.strictEqual(result.transferred, 2);

    const tipsB = store.getTips('skill-b');
    assert.strictEqual(tipsB.length, 1);
    assert.ok(tipsB[0].context.includes('transferred from skill-a'));
  });

  it('should reject transfer with low similarity', function() {
    const store = new SkillMemoryStore();
    instances.push(store);

    store.storeExperience('skill-a', { type: 'tip', content: 'tip' });
    const result = store.transferExperiences('skill-a', 'skill-b', 0.1);
    assert.strictEqual(result.transferred, 0);
  });

  it('should auto-transfer using skill graph', function() {
    const store = new SkillMemoryStore();
    instances.push(store);
    const graph = createMockSkillGraph();

    store.storeExperience('skill-a', { type: 'tip', content: 'tip', confidence: 0.9 });
    const result = store.autoTransfer(graph);
    assert.strictEqual(result.transferred, 1);
  });

  it('should record outcome and generate effectiveness report', function() {
    const store = new SkillMemoryStore();
    instances.push(store);

    const r = store.storeExperience('skill-1', { type: 'tip', content: 'tip1', confidence: 0.9 });
    assert.ok(r.id);

    store.recordOutcome('skill-1', r.id, true);
    store.recordOutcome('skill-1', r.id, false);

    const report = store.getEffectivenessReport('skill-1');
    assert.ok(report);
    assert.strictEqual(report.totalExperiences, 1);
    assert.strictEqual(report.totalTriggered, 2);
    assert.strictEqual(report.totalEffective, 1);
    assert.strictEqual(report.overallEffectiveness, 0.5);
  });

  it('should prune low effectiveness experiences', function() {
    const store = new SkillMemoryStore();
    instances.push(store);

    const r1 = store.storeExperience('skill-1', { type: 'tip', content: 'good tip', confidence: 0.9 });
    const r2 = store.storeExperience('skill-1', { type: 'tip', content: 'bad tip', confidence: 0.1 });

    store.recordOutcome('skill-1', r1.id, true);
    store.recordOutcome('skill-1', r1.id, true);
    store.recordOutcome('skill-1', r2.id, false);
    store.recordOutcome('skill-1', r2.id, false);

    const pruned = store.pruneLowEffectiveness(0.5);
    assert.strictEqual(pruned, 1);

    const remaining = store.getTips('skill-1');
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].content, 'good tip');
  });

  it('should return null for unknown skill effectiveness report', function() {
    const store = new SkillMemoryStore();
    instances.push(store);
    assert.strictEqual(store.getEffectivenessReport('unknown'), null);
  });

  it('should emit experience-stored event', function() {
    const store = new SkillMemoryStore();
    instances.push(store);

    let eventFired = false;
    store.on('experience-stored', function() { eventFired = true; });

    store.storeExperience('skill-1', { type: 'tip', content: 'test' });
    assert.strictEqual(eventFired, true);
  });

  it('should get skill ids', function() {
    const store = new SkillMemoryStore();
    instances.push(store);

    store.storeExperience('skill-1', { type: 'tip', content: 'test' });
    store.storeExperience('skill-2', { type: 'tip', content: 'test' });

    const ids = store.getSkillIds();
    assert.ok(ids.includes('skill-1'));
    assert.ok(ids.includes('skill-2'));
  });

  it('should shutdown cleanly', function() {
    const store = new SkillMemoryStore();
    instances.push(store);
    store.storeExperience('skill-1', { type: 'tip', content: 'test' });
    store.shutdown();
    assert.strictEqual(store._shutDown, true);
    assert.deepStrictEqual(store.getStats(), { experiencesStored: 0, experiencesRetrieved: 0, transfersCompleted: 0, prunedCount: 0 });
  });
});

describe('PostTaskReviewer', function() {
  it('should construct with default config', function() {
    const reviewer = new PostTaskReviewer();
    instances.push(reviewer);
    assert.ok(reviewer);
    assert.deepStrictEqual(reviewer.getStats(), { reviewsTriggered: 0, rulesGenerated: 0, memoriesStored: 0, reflectionsGenerated: 0 });
  });

  it('should attach dependencies', function() {
    const reviewer = new PostTaskReviewer();
    instances.push(reviewer);

    const loop = new AutoReinLearningLoop();
    instances.push(loop);
    const reflection = new SelfReflection();
    instances.push(reflection);
    const pipeline = createMockMemoryPipeline();

    reviewer.attachAutoReinLoop(loop);
    reviewer.attachSelfReflection(reflection);
    reviewer.attachMemoryPipeline(pipeline);

    assert.strictEqual(reviewer._autoReinLoop, loop);
    assert.strictEqual(reviewer._selfReflection, reflection);
    assert.strictEqual(reviewer._memoryPipeline, pipeline);
  });

  it('should review after task with reflection', async function() {
    const reviewer = new PostTaskReviewer();
    instances.push(reviewer);

    const reflection = new SelfReflection();
    instances.push(reflection);
    reviewer.attachSelfReflection(reflection);

    const result = await reviewer.reviewAfterTask({
      taskId: 'task-1',
      agentId: 'agent-1',
      skillId: 'skill-1',
      artifactType: 'code',
    });

    assert.strictEqual(result.reflected, true);
    assert.ok(result.reviewId);
  });

  it('should review without reflection when no agentId', async function() {
    const reviewer = new PostTaskReviewer();
    instances.push(reviewer);

    const reflection = new SelfReflection();
    instances.push(reflection);
    reviewer.attachSelfReflection(reflection);

    const result = await reviewer.reviewAfterTask({
      taskId: 'task-1',
    });

    assert.strictEqual(result.reflected, false);
  });

  it('should reject invalid task result', async function() {
    const reviewer = new PostTaskReviewer();
    instances.push(reviewer);

    const result = await reviewer.reviewAfterTask(null);
    assert.strictEqual(result.reviewed, false);

    const result2 = await reviewer.reviewAfterTask('invalid');
    assert.strictEqual(result2.reviewed, false);
  });

  it('should emit review-complete event', async function() {
    const reviewer = new PostTaskReviewer();
    instances.push(reviewer);

    let eventFired = false;
    reviewer.on('review-complete', function() { eventFired = true; });

    await reviewer.reviewAfterTask({ taskId: 't1' });
    assert.strictEqual(eventFired, true);
  });

  it('should track review queue', async function() {
    const reviewer = new PostTaskReviewer();
    instances.push(reviewer);

    await reviewer.reviewAfterTask({ taskId: 't1' });
    await reviewer.reviewAfterTask({ taskId: 't2' });

    const queue = reviewer.getReviewQueue();
    assert.strictEqual(queue.length, 2);
  });

  it('should update stats', async function() {
    const reviewer = new PostTaskReviewer();
    instances.push(reviewer);

    await reviewer.reviewAfterTask({ taskId: 't1' });

    const stats = reviewer.getStats();
    assert.strictEqual(stats.reviewsTriggered, 1);
  });

  it('should shutdown cleanly', function() {
    const reviewer = new PostTaskReviewer();
    instances.push(reviewer);
    reviewer.shutdown();
    assert.strictEqual(reviewer._shutDown, true);
    assert.deepStrictEqual(reviewer.getStats(), { reviewsTriggered: 0, rulesGenerated: 0, memoriesStored: 0, reflectionsGenerated: 0 });
  });
});

describe('IronRuleEngine enhancements', function() {
  it('should add pattern rule', function() {
    const engine = new IronRuleEngine();
    instances.push(engine);

    const result = engine.addPatternRule(
      /hardcoded\s+password/i,
      'Hardcoded password detected',
      'Use environment variables',
      { severity: 'critical', category: 'security' },
    );

    assert.strictEqual(result.added, true);
    assert.ok(result.ruleId);
  });

  it('should reject pattern rule without pattern', function() {
    const engine = new IronRuleEngine();
    instances.push(engine);

    const result = engine.addPatternRule(null, 'test', 'test');
    assert.strictEqual(result.added, false);
  });

  it('should generate check function from regex pattern', function() {
    const engine = new IronRuleEngine();
    instances.push(engine);

    engine.addPatternRule(/TODO/i, 'TODO found', 'Resolve TODOs');

    const result = engine.checkViolation('const x = 1; // TODO: fix this');
    assert.ok(result.violations.length >= 1);
    const todoViolation = result.violations.find(function(v) { return v.evidence && v.evidence.includes('TODO'); });
    assert.ok(todoViolation);
  });

  it('should generate check function from string pattern', function() {
    const engine = new IronRuleEngine();
    instances.push(engine);

    engine.addPatternRule(/console\.log/, 'Console log found', 'Remove console.log');

    const result = engine.checkViolation('console.log("debug")');
    assert.ok(result.violations.length >= 1);
  });

  it('should track rule effectiveness', function() {
    const engine = new IronRuleEngine();
    instances.push(engine);

    const ruleResult = engine.addPatternRule(/test/i, 'Test rule', 'Fix');
    assert.strictEqual(ruleResult.added, true);

    engine.recordRuleOutcome(ruleResult.ruleId, true);
    engine.recordRuleOutcome(ruleResult.ruleId, false);
    engine.recordRuleOutcome(ruleResult.ruleId, true);

    const effectiveness = engine.getRuleEffectiveness(ruleResult.ruleId);
    assert.ok(effectiveness);
    assert.strictEqual(effectiveness.triggered, 3);
    assert.strictEqual(effectiveness.prevented, 2);
    assert.ok(Math.abs(effectiveness.rate - 2 / 3) < 0.01);
  });

  it('should return null for unknown rule effectiveness', function() {
    const engine = new IronRuleEngine();
    instances.push(engine);

    assert.strictEqual(engine.getRuleEffectiveness('nonexistent'), null);
  });

  it('should return false for recording outcome of unknown rule', function() {
    const engine = new IronRuleEngine();
    instances.push(engine);

    assert.strictEqual(engine.recordRuleOutcome('nonexistent', true), false);
  });

  it('should accept custom id in addPatternRule options', function() {
    const engine = new IronRuleEngine();
    instances.push(engine);

    const result = engine.addPatternRule(/test/i, 'Test', 'Fix', { id: 'custom-pattern-rule' });
    assert.strictEqual(result.added, true);
    assert.strictEqual(result.ruleId, 'custom-pattern-rule');
  });
});

describe('ErrorPreventionGuard autoRegisterFromReflection', function() {
  it('should register patterns from reflection improvements', function() {
    const guard = new ErrorPreventionGuard();
    instances.push(guard);

    const result = guard.autoRegisterFromReflection({
      improvements: [
        { description: 'Missing null check', dimension: 'reliability' },
        { description: 'No error handling', dimension: 'security' },
      ],
    });

    assert.strictEqual(result.registered, 2);
    assert.strictEqual(guard.getPatternCount(), 2);
  });

  it('should register pattern for degrading quality trend', function() {
    const guard = new ErrorPreventionGuard();
    instances.push(guard);

    const result = guard.autoRegisterFromReflection({
      qualityTrend: 'degrading',
      recommendedAction: 'rollback-and-revise',
    });

    assert.strictEqual(result.registered, 1);
  });

  it('should register patterns for dimensions needing attention', function() {
    const guard = new ErrorPreventionGuard();
    instances.push(guard);

    const result = guard.autoRegisterFromReflection({
      dimensions: {
        boundary_conditions: { needsAttention: true, score: 0.3 },
        consistency: { needsAttention: false, score: 0.8 },
        security: { needsAttention: true, score: 0.4 },
      },
    });

    assert.strictEqual(result.registered, 2);
  });

  it('should return 0 for invalid input', function() {
    const guard = new ErrorPreventionGuard();
    instances.push(guard);

    assert.deepStrictEqual(guard.autoRegisterFromReflection(null), { registered: 0 });
    assert.deepStrictEqual(guard.autoRegisterFromReflection('invalid'), { registered: 0 });
  });

  it('should emit auto-registered-from-reflection event', function() {
    const guard = new ErrorPreventionGuard();
    instances.push(guard);

    let eventFired = false;
    guard.on('auto-registered-from-reflection', function() { eventFired = true; });

    guard.autoRegisterFromReflection({
      improvements: [{ description: 'test', dimension: 'general' }],
    });

    assert.strictEqual(eventFired, true);
  });
});

describe('DreamBridge new bridge rules', function() {
  it('should attach ErrorPreventionGuard and IronRuleEngine', function() {
    const bridge = new DreamBridge();
    instances.push(bridge);

    const guard = new ErrorPreventionGuard();
    instances.push(guard);
    const engine = new IronRuleEngine();
    instances.push(engine);

    bridge.attachErrorPreventionGuard(guard);
    bridge.attachIronRuleEngine(engine);

    assert.strictEqual(bridge._modules['ErrorPreventionGuard'], guard);
    assert.strictEqual(bridge._modules['IronRuleEngine'], engine);
  });

  it('should register SelfReflection->ErrorPreventionGuard bridge', function() {
    const bridge = new DreamBridge();
    instances.push(bridge);

    const reflection = new SelfReflection();
    instances.push(reflection);
    const guard = new ErrorPreventionGuard();
    instances.push(guard);

    bridge.attachSelfReflection(reflection);
    bridge.attachErrorPreventionGuard(guard);
    bridge.activate();

    assert.strictEqual(bridge.isActive(), true);
    const stats = bridge.getBridgeStats();
    assert.ok(stats.bridgesActivated['SelfReflection->ErrorPreventionGuard']);
  });

  it('should register ErrorPreventionGuard->IronRuleEngine bridge', function() {
    const bridge = new DreamBridge();
    instances.push(bridge);

    const guard = new ErrorPreventionGuard();
    instances.push(guard);
    const engine = new IronRuleEngine();
    instances.push(engine);

    bridge.attachErrorPreventionGuard(guard);
    bridge.attachIronRuleEngine(engine);
    bridge.activate();

    assert.strictEqual(bridge.isActive(), true);
    const stats = bridge.getBridgeStats();
    assert.ok(stats.bridgesActivated['ErrorPreventionGuard->IronRuleEngine']);
  });

  it('should propagate reflection to ErrorPreventionGuard via bridge', function() {
    const bridge = new DreamBridge();
    instances.push(bridge);

    const reflection = new SelfReflection();
    instances.push(reflection);
    const guard = new ErrorPreventionGuard();
    instances.push(guard);

    bridge.attachSelfReflection(reflection);
    bridge.attachErrorPreventionGuard(guard);
    bridge.activate();

    reflection.reflect({
      agentId: 'agent-1',
      skillId: 'skill-1',
      artifactType: 'code',
    });

    const stats = bridge.getBridgeStats();
    assert.ok(stats.bridgesActivated['SelfReflection->ErrorPreventionGuard'] >= 1);
  });

  it('should deactivate cleanly with new bridges', function() {
    const bridge = new DreamBridge();
    instances.push(bridge);

    const reflection = new SelfReflection();
    instances.push(reflection);
    const guard = new ErrorPreventionGuard();
    instances.push(guard);
    const engine = new IronRuleEngine();
    instances.push(engine);

    bridge.attachSelfReflection(reflection);
    bridge.attachErrorPreventionGuard(guard);
    bridge.attachIronRuleEngine(engine);
    bridge.activate();
    bridge.deactivate();

    assert.strictEqual(bridge.isActive(), false);
  });
});

describe('Integration: full learning loop', function() {
  it('should process task result through AutoReinLearningLoop with all dependencies', async function() {
    const engine = new IronRuleEngine();
    instances.push(engine);
    const guard = new ErrorPreventionGuard();
    instances.push(guard);
    const store = new SkillMemoryStore();
    instances.push(store);
    const impLoop = createMockSkillImprovementLoop();

    const loop = new AutoReinLearningLoop();
    instances.push(loop);
    loop.attachIronRuleEngine(engine);
    loop.attachErrorPreventionGuard(guard);
    loop.attachSkillMemoryStore(store);
    loop.attachSkillImprovementLoop(impLoop);

    const result = await loop.processTaskResult({
      taskId: 'task-int-1',
      errors: [
        { message: 'Missing null check before method call', description: 'null pointer', solution: 'Add null check' },
      ],
      violations: [{ evidence: 'Hardcoded secret found', ruleName: 'no-hardcoded-secrets' }],
      skillId: 'skill-1',
      agentId: 'agent-1',
      whatWorked: 'Used proper validation',
      whatFailed: 'Forgot null check',
    });

    assert.strictEqual(result.processed, true);
    assert.ok(result.patternsRegistered >= 1);

    const stats = loop.getStats();
    assert.ok(stats.reviewsCompleted >= 1);
    assert.ok(stats.patternsRegistered >= 1);
  });

  it('should run full PostTaskReviewer pipeline', async function() {
    const engine = new IronRuleEngine();
    instances.push(engine);
    const guard = new ErrorPreventionGuard();
    instances.push(guard);
    const reflection = new SelfReflection();
    instances.push(reflection);

    const loop = new AutoReinLearningLoop();
    instances.push(loop);
    loop.attachIronRuleEngine(engine);
    loop.attachErrorPreventionGuard(guard);

    const reviewer = new PostTaskReviewer();
    instances.push(reviewer);
    reviewer.attachAutoReinLoop(loop);
    reviewer.attachSelfReflection(reflection);

    const result = await reviewer.reviewAfterTask({
      taskId: 'task-pipeline-1',
      agentId: 'agent-1',
      skillId: 'skill-1',
      artifactType: 'code',
      errors: [{ message: 'Missing error handling for async operation' }],
    });

    assert.strictEqual(result.reflected, true);

    const stats = reviewer.getStats();
    assert.strictEqual(stats.reviewsTriggered, 1);
    assert.strictEqual(stats.reflectionsGenerated, 1);
  });

  it('should connect DreamBridge with new modules for end-to-end flow', function() {
    const engine = new IronRuleEngine();
    instances.push(engine);
    const guard = new ErrorPreventionGuard();
    instances.push(guard);
    const reflection = new SelfReflection();
    instances.push(reflection);

    const bridge = new DreamBridge();
    instances.push(bridge);
    bridge.attachSelfReflection(reflection);
    bridge.attachErrorPreventionGuard(guard);
    bridge.attachIronRuleEngine(engine);
    bridge.activate();

    reflection.reflect({
      agentId: 'agent-1',
      skillId: 'skill-1',
      artifactType: 'code',
    });

    const stats = bridge.getBridgeStats();
    assert.ok(stats.bridgesActivated['SelfReflection->ErrorPreventionGuard'] >= 1);
  });
});
