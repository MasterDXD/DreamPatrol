'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..', '..', '..');
const DreamBridge = require(path.join(ROOT, 'src', 'runtime', 'thought', 'dream-bridge'));

class MockQualityScorer extends EventEmitter {}
class MockDreamOutcomes extends EventEmitter {
  constructor() {
    super();
    this.evaluateOutcomeCalls = [];
    this.syncToDreamEngineCalls = 0;
    this.syncToSkillImprovementLoopCalls = 0;
  }
  evaluateOutcome(...args) {
    this.evaluateOutcomeCalls.push(args);
    return null;
  }
  syncToDreamEngine() {
    this.syncToDreamEngineCalls++;
    return { synced: 0, errors: 0 };
  }
  syncToSkillImprovementLoop() {
    this.syncToSkillImprovementLoopCalls++;
    return { synced: 0, errors: 0 };
  }
}
class MockSelfReflection extends EventEmitter {}
class MockDreamEngine extends EventEmitter {
  constructor() {
    super();
    this.consumeReflectionInputCalls = [];
  }
  consumeReflectionInput(input) {
    this.consumeReflectionInputCalls.push(input);
  }
  startDreaming() {
    return true;
  }
}
class MockSkillImprovementLoop extends EventEmitter {
  constructor() {
    super();
    this.recordLearningCalls = [];
  }
  recordLearning(entry) {
    this.recordLearningCalls.push(entry);
    return { success: true };
  }
}
class MockLlmWiki extends EventEmitter {
  constructor() {
    super();
    this.createEntryCalls = [];
  }
  createEntry(category, title, content, meta) {
    this.createEntryCalls.push({ category, title, content, meta });
  }
}
class MockBrainMemory extends EventEmitter {}

describe('DreamBridge - Constructor', () => {
  it('should create instance with default values', () => {
    const bridge = new DreamBridge();
    assert.ok(bridge);
    assert.deepStrictEqual(bridge._modules, {});
    assert.strictEqual(bridge._active, false);
    assert.strictEqual(bridge._listeners.length, 0);
    assert.deepStrictEqual(bridge._bridgeStats, { activated: {}, failed: {} });
  });
});

describe('DreamBridge - attach methods', () => {
  it('should attach modules for chaining', () => {
    const bridge = new DreamBridge();
    const engine = new MockDreamEngine();
    const outcomes = new MockDreamOutcomes();
    const scorer = new MockQualityScorer();
    const reflection = new MockSelfReflection();
    const loop = new MockSkillImprovementLoop();
    const wiki = new MockLlmWiki();
    const brainMemory = new MockBrainMemory();

    bridge.attachDreamEngine(engine);
    bridge.attachDreamOutcomes(outcomes);
    bridge.attachQualityScorer(scorer);
    bridge.attachSelfReflection(reflection);
    bridge.attachSkillImprovementLoop(loop);
    bridge.attachLlmWiki(wiki);
    bridge.attachBrainMemory(brainMemory);

    assert.strictEqual(bridge._modules.DreamEngine, engine);
    assert.strictEqual(bridge._modules.DreamOutcomes, outcomes);
    assert.strictEqual(bridge._modules.QualityScorer, scorer);
    assert.strictEqual(bridge._modules.SelfReflection, reflection);
    assert.strictEqual(bridge._modules.SkillImprovementLoop, loop);
    assert.strictEqual(bridge._modules.LlmWiki, wiki);
    assert.strictEqual(bridge._modules.BrainMemory, brainMemory);
  });

  it('should set module to null when called with null', () => {
    const bridge = new DreamBridge();
    bridge.attachDreamEngine(null);
    assert.strictEqual(bridge._modules.DreamEngine, null);
  });
});

describe('DreamBridge - activate / deactivate', () => {
  it('should activate and register event listeners', () => {
    const bridge = new DreamBridge();
    const scorer = new MockQualityScorer();
    const outcomes = new MockDreamOutcomes();
    const reflection = new MockSelfReflection();
    const engine = new MockDreamEngine();
    const loop = new MockSkillImprovementLoop();
    const wiki = new MockLlmWiki();

    bridge.attachQualityScorer(scorer);
    bridge.attachDreamOutcomes(outcomes);
    bridge.attachSelfReflection(reflection);
    bridge.attachDreamEngine(engine);
    bridge.attachSkillImprovementLoop(loop);
    bridge.attachLlmWiki(wiki);

    bridge.activate();
    assert.strictEqual(bridge._active, true);
    assert.ok(bridge._listeners.length > 0);
  });

  it('should emit bridge-activated event', () => {
    const bridge = new DreamBridge();
    let eventData = null;
    bridge.on('bridge-activated', (data) => { eventData = data; });
    bridge.activate();
    assert.ok(eventData);
    assert.ok(Array.isArray(eventData.bridges));
  });

  it('should not activate twice', () => {
    const bridge = new DreamBridge();
    bridge.activate();
    const listenerCountBefore = bridge._listeners.length;
    bridge.activate();
    assert.strictEqual(bridge._listeners.length, listenerCountBefore);
  });

  it('should deactivate and remove event listeners', () => {
    const bridge = new DreamBridge();
    const scorer = new MockQualityScorer();
    const outcomes = new MockDreamOutcomes();
    bridge.attachQualityScorer(scorer);
    bridge.attachDreamOutcomes(outcomes);

    bridge.activate();
    assert.ok(bridge._listeners.length > 0);

    bridge.deactivate();
    assert.strictEqual(bridge._active, false);
    assert.strictEqual(bridge._listeners.length, 0);
  });

  it('should emit bridge-deactivated event', () => {
    const bridge = new DreamBridge();
    bridge.activate();
    let eventData = null;
    bridge.on('bridge-deactivated', (data) => { eventData = data; });
    bridge.deactivate();
    assert.ok(eventData);
  });

  it('should not deactivate when already inactive', () => {
    const bridge = new DreamBridge();
    let emitCount = 0;
    bridge.on('bridge-deactivated', () => { emitCount++; });
    bridge.deactivate();
    assert.strictEqual(emitCount, 0);
  });

  it('should track active state', () => {
    const bridge = new DreamBridge();
    assert.strictEqual(bridge.isActive(), false);
    bridge.activate();
    assert.strictEqual(bridge.isActive(), true);
    bridge.deactivate();
    assert.strictEqual(bridge.isActive(), false);
  });
});

describe('DreamBridge - QualityScorer -> DreamOutcomes bridge', () => {
  it('should bridge score-computed event to DreamOutcomes', () => {
    const bridge = new DreamBridge();
    const scorer = new MockQualityScorer();
    const outcomes = new MockDreamOutcomes();
    bridge.attachQualityScorer(scorer);
    bridge.attachDreamOutcomes(outcomes);
    bridge.activate();

    scorer.emit('score-computed', { total: 0.9, grade: 'A' });

    assert.strictEqual(outcomes.evaluateOutcomeCalls.length, 1);
    const evaluation = outcomes.evaluateOutcomeCalls[0][1];
    assert.strictEqual(evaluation.achieved, true);
    assert.strictEqual(evaluation.score, 0.9);
    assert.strictEqual(evaluation.grade, 'A');
  });

  it('should handle score below threshold', () => {
    const bridge = new DreamBridge();
    const scorer = new MockQualityScorer();
    const outcomes = new MockDreamOutcomes();
    bridge.attachQualityScorer(scorer);
    bridge.attachDreamOutcomes(outcomes);
    bridge.activate();

    scorer.emit('score-computed', { total: 0.4, grade: 'D' });

    assert.strictEqual(outcomes.evaluateOutcomeCalls.length, 1);
    const evaluation = outcomes.evaluateOutcomeCalls[0][1];
    assert.strictEqual(evaluation.achieved, false);
    assert.strictEqual(evaluation.score, 0.4);
  });

  it('should handle missing score data', () => {
    const bridge = new DreamBridge();
    const scorer = new MockQualityScorer();
    const outcomes = new MockDreamOutcomes();
    bridge.attachQualityScorer(scorer);
    bridge.attachDreamOutcomes(outcomes);
    bridge.activate();

    scorer.emit('score-computed', null);

    assert.strictEqual(outcomes.evaluateOutcomeCalls.length, 1);
    const evaluation = outcomes.evaluateOutcomeCalls[0][1];
    assert.strictEqual(evaluation.achieved, false);
    assert.strictEqual(evaluation.score, 0);
    assert.strictEqual(evaluation.grade, 'unknown');
  });

  it('should emit bridge-executed event', () => {
    const bridge = new DreamBridge();
    const scorer = new MockQualityScorer();
    const outcomes = new MockDreamOutcomes();
    bridge.attachQualityScorer(scorer);
    bridge.attachDreamOutcomes(outcomes);
    bridge.activate();

    let executedData = null;
    bridge.on('bridge-executed', (data) => { executedData = data; });
    scorer.emit('score-computed', { total: 0.9 });

    assert.ok(executedData);
    assert.strictEqual(executedData.bridge, 'QualityScorer->DreamOutcomes');
  });

  it('should not bridge when modules are missing', () => {
    const bridge = new DreamBridge();
    bridge.activate();
    assert.strictEqual(bridge._listeners.length, 0);
  });
});

describe('DreamBridge - SelfReflection -> DreamEngine bridge', () => {
  it('should bridge reflection-completed event to DreamEngine', () => {
    const bridge = new DreamBridge();
    const reflection = new MockSelfReflection();
    const engine = new MockDreamEngine();
    bridge.attachSelfReflection(reflection);
    bridge.attachDreamEngine(engine);
    bridge.activate();

    reflection.emit('reflection-completed', {
      improvements: ['imp-1'],
      suggestions: ['sug-1'],
      qualityTrend: 'improving',
      recommendedAction: 'continue',
    });

    assert.strictEqual(engine.consumeReflectionInputCalls.length, 1);
    const input = engine.consumeReflectionInputCalls[0];
    assert.strictEqual(input.source, 'self-reflection');
    assert.deepStrictEqual(input.improvements, ['imp-1']);
    assert.deepStrictEqual(input.suggestions, ['sug-1']);
    assert.strictEqual(input.qualityTrend, 'improving');
    assert.strictEqual(input.recommendedAction, 'continue');
  });

  it('should handle missing reflection data fields', () => {
    const bridge = new DreamBridge();
    const reflection = new MockSelfReflection();
    const engine = new MockDreamEngine();
    bridge.attachSelfReflection(reflection);
    bridge.attachDreamEngine(engine);
    bridge.activate();

    reflection.emit('reflection-completed', {});

    assert.strictEqual(engine.consumeReflectionInputCalls.length, 1);
    const input = engine.consumeReflectionInputCalls[0];
    assert.deepStrictEqual(input.improvements, []);
    assert.deepStrictEqual(input.suggestions, []);
  });

  it('should emit bridge-executed event', () => {
    const bridge = new DreamBridge();
    const reflection = new MockSelfReflection();
    const engine = new MockDreamEngine();
    bridge.attachSelfReflection(reflection);
    bridge.attachDreamEngine(engine);
    bridge.activate();

    let executedData = null;
    bridge.on('bridge-executed', (data) => { executedData = data; });
    reflection.emit('reflection-completed', {});

    assert.ok(executedData);
    assert.strictEqual(executedData.bridge, 'SelfReflection->DreamEngine');
  });
});

describe('DreamBridge - DreamOutcomes -> DreamEngine bridge', () => {
  it('should bridge outcome-evaluated event to syncToDreamEngine', async () => {
    const bridge = new DreamBridge();
    const outcomes = new MockDreamOutcomes();
    const engine = new MockDreamEngine();
    bridge.attachDreamOutcomes(outcomes);
    bridge.attachDreamEngine(engine);
    bridge.activate();

    outcomes.emit('outcome-evaluated', { taskId: 'task-1', achieved: true });

    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(outcomes.syncToDreamEngineCalls, 1);
  });

  it('should emit bridge-executed event', async () => {
    const bridge = new DreamBridge();
    const outcomes = new MockDreamOutcomes();
    const engine = new MockDreamEngine();
    bridge.attachDreamOutcomes(outcomes);
    bridge.attachDreamEngine(engine);
    bridge.activate();

    let executedData = null;
    bridge.on('bridge-executed', (data) => { executedData = data; });
    outcomes.emit('outcome-evaluated', { taskId: 'task-1' });

    await new Promise(resolve => setImmediate(resolve));
    assert.ok(executedData);
    assert.strictEqual(executedData.bridge, 'DreamOutcomes->DreamEngine');
  });

  it('should not bridge when DreamEngine is missing', () => {
    const bridge = new DreamBridge();
    const outcomes = new MockDreamOutcomes();
    bridge.attachDreamOutcomes(outcomes);
    bridge.activate();

    outcomes.emit('outcome-evaluated', { taskId: 'task-1' });
    assert.strictEqual(outcomes.syncToDreamEngineCalls, 0);
  });
});

describe('DreamBridge - DreamOutcomes -> SkillImprovementLoop bridge', () => {
  it('should bridge outcome-evaluated event to syncToSkillImprovementLoop', () => {
    const bridge = new DreamBridge();
    const outcomes = new MockDreamOutcomes();
    const loop = new MockSkillImprovementLoop();
    bridge.attachDreamOutcomes(outcomes);
    bridge.attachSkillImprovementLoop(loop);
    bridge.activate();

    outcomes.emit('outcome-evaluated', { taskId: 'task-1', achieved: false });

    assert.strictEqual(outcomes.syncToSkillImprovementLoopCalls, 1);
  });

  it('should emit bridge-executed event', () => {
    const bridge = new DreamBridge();
    const outcomes = new MockDreamOutcomes();
    const loop = new MockSkillImprovementLoop();
    bridge.attachDreamOutcomes(outcomes);
    bridge.attachSkillImprovementLoop(loop);
    bridge.activate();

    let executedData = null;
    bridge.on('bridge-executed', (data) => { executedData = data; });
    outcomes.emit('outcome-evaluated', { taskId: 'task-1' });

    assert.ok(executedData);
    assert.strictEqual(executedData.bridge, 'DreamOutcomes->SkillImprovementLoop');
  });

  it('should not bridge when SkillImprovementLoop is missing', () => {
    const bridge = new DreamBridge();
    const outcomes = new MockDreamOutcomes();
    bridge.attachDreamOutcomes(outcomes);
    bridge.activate();

    outcomes.emit('outcome-evaluated', { taskId: 'task-1' });
    assert.strictEqual(outcomes.syncToSkillImprovementLoopCalls, 0);
  });
});

describe('DreamBridge - DreamEngine -> LlmWiki bridge', () => {
  it('should bridge dream-complete event to LlmWiki for high confidence notes', () => {
    const bridge = new DreamBridge();
    const engine = new MockDreamEngine();
    const wiki = new MockLlmWiki();
    bridge.attachDreamEngine(engine);
    bridge.attachLlmWiki(wiki);
    bridge.activate();

    engine.emit('dream-complete', {
      notes: [
        { content: 'Use connection pooling for DB', confidence: 0.9, category: 'best-practice' },
        { content: 'Low confidence note', confidence: 0.5, category: 'error-avoidance' },
      ],
    });

    assert.strictEqual(wiki.createEntryCalls.length, 1);
    assert.strictEqual(wiki.createEntryCalls[0].category, 'patterns');
    assert.ok(wiki.createEntryCalls[0].title);
    assert.strictEqual(wiki.createEntryCalls[0].meta.confidence, 0.9);
    assert.strictEqual(wiki.createEntryCalls[0].meta.source, 'dream-bridge');
  });

  it('should map error-avoidance category to troubleshooting', () => {
    const bridge = new DreamBridge();
    const engine = new MockDreamEngine();
    const wiki = new MockLlmWiki();
    bridge.attachDreamEngine(engine);
    bridge.attachLlmWiki(wiki);
    bridge.activate();

    engine.emit('dream-complete', {
      notes: [
        { content: 'Avoid null pointer errors', confidence: 0.85, category: 'error-avoidance' },
      ],
    });

    assert.strictEqual(wiki.createEntryCalls.length, 1);
    assert.strictEqual(wiki.createEntryCalls[0].category, 'troubleshooting');
  });

  it('should skip notes with confidence below threshold', () => {
    const bridge = new DreamBridge();
    const engine = new MockDreamEngine();
    const wiki = new MockLlmWiki();
    bridge.attachDreamEngine(engine);
    bridge.attachLlmWiki(wiki);
    bridge.activate();

    engine.emit('dream-complete', {
      notes: [
        { content: 'Low confidence', confidence: 0.7, category: 'best-practice' },
      ],
    });

    assert.strictEqual(wiki.createEntryCalls.length, 0);
  });

  it('should skip notes with null confidence', () => {
    const bridge = new DreamBridge();
    const engine = new MockDreamEngine();
    const wiki = new MockLlmWiki();
    bridge.attachDreamEngine(engine);
    bridge.attachLlmWiki(wiki);
    bridge.activate();

    engine.emit('dream-complete', {
      notes: [
        { content: 'No confidence', category: 'best-practice' },
      ],
    });

    assert.strictEqual(wiki.createEntryCalls.length, 0);
  });

  it('should handle single note object with id', () => {
    const bridge = new DreamBridge();
    const engine = new MockDreamEngine();
    const wiki = new MockLlmWiki();
    bridge.attachDreamEngine(engine);
    bridge.attachLlmWiki(wiki);
    bridge.activate();

    engine.emit('dream-complete', {
      id: 'note-1',
      content: 'Important pattern discovered',
      confidence: 0.9,
      category: 'best-practice',
    });

    assert.strictEqual(wiki.createEntryCalls.length, 1);
  });

  it('should skip notes with empty title after cleaning', () => {
    const bridge = new DreamBridge();
    const engine = new MockDreamEngine();
    const wiki = new MockLlmWiki();
    bridge.attachDreamEngine(engine);
    bridge.attachLlmWiki(wiki);
    bridge.activate();

    engine.emit('dream-complete', {
      notes: [
        { content: '!!!???', confidence: 0.9, category: 'best-practice' },
      ],
    });

    assert.strictEqual(wiki.createEntryCalls.length, 0);
  });

  it('should handle null noteData', () => {
    const bridge = new DreamBridge();
    const engine = new MockDreamEngine();
    const wiki = new MockLlmWiki();
    bridge.attachDreamEngine(engine);
    bridge.attachLlmWiki(wiki);
    bridge.activate();

    engine.emit('dream-complete', null);

    assert.strictEqual(wiki.createEntryCalls.length, 0);
  });

  it('should also listen on dream-error event', () => {
    const bridge = new DreamBridge();
    const engine = new MockDreamEngine();
    const wiki = new MockLlmWiki();
    bridge.attachDreamEngine(engine);
    bridge.attachLlmWiki(wiki);
    bridge.activate();

    engine.emit('dream-error', {
      notes: [
        { content: 'Auto generated insight', confidence: 0.85, category: 'best-practice' },
      ],
    });

    assert.strictEqual(wiki.createEntryCalls.length, 1);
  });

  it('should emit bridge-executed event', () => {
    const bridge = new DreamBridge();
    const engine = new MockDreamEngine();
    const wiki = new MockLlmWiki();
    bridge.attachDreamEngine(engine);
    bridge.attachLlmWiki(wiki);
    bridge.activate();

    let executedData = null;
    bridge.on('bridge-executed', (data) => { executedData = data; });
    engine.emit('dream-complete', {
      notes: [{ content: 'Test note', confidence: 0.9, category: 'best-practice' }],
    });

    assert.ok(executedData);
    assert.strictEqual(executedData.bridge, 'DreamEngine->LlmWiki');
  });
});

describe('DreamBridge - isHealthy / getStats / shutdown', () => {
  it('should be healthy when active', () => {
    const bridge = new DreamBridge();
    bridge.activate();
    assert.strictEqual(bridge.isHealthy(), true);
  });

  it('should be healthy when inactive but not shut down', () => {
    const bridge = new DreamBridge();
    assert.strictEqual(bridge.isHealthy(), true);
  });

  it('should return bridge stats', () => {
    const bridge = new DreamBridge();
    const stats = bridge.getStats();
    assert.strictEqual(stats.active, false);
    assert.deepStrictEqual(stats.bridgesActivated, {});
    assert.deepStrictEqual(stats.bridgesFailed, {});
  });

  it('should return bridge stats with activated bridges', () => {
    const bridge = new DreamBridge();
    const scorer = new MockQualityScorer();
    const outcomes = new MockDreamOutcomes();
    bridge.attachQualityScorer(scorer);
    bridge.attachDreamOutcomes(outcomes);
    bridge.activate();

    scorer.emit('score-computed', { total: 0.9 });

    const stats = bridge.getStats();
    assert.strictEqual(stats.active, true);
    assert.ok(stats.bridgesActivated['QualityScorer->DreamOutcomes'] > 0);
  });

  it('should deactivate on shutdown', () => {
    const bridge = new DreamBridge();
    const scorer = new MockQualityScorer();
    const outcomes = new MockDreamOutcomes();
    bridge.attachQualityScorer(scorer);
    bridge.attachDreamOutcomes(outcomes);
    bridge.activate();

    assert.strictEqual(bridge.isActive(), true);
    bridge.shutdown();
    assert.strictEqual(bridge.isActive(), false);
    assert.strictEqual(bridge.isHealthy(), false);
  });

  it('should clear modules on shutdown', () => {
    const bridge = new DreamBridge();
    bridge.attachDreamEngine(new MockDreamEngine());
    bridge.attachDreamOutcomes(new MockDreamOutcomes());
    bridge.activate();

    bridge.shutdown();
    assert.deepStrictEqual(bridge._modules, {});
  });

  it('should clear bridge stats on shutdown', () => {
    const bridge = new DreamBridge();
    bridge.activate();
    bridge.shutdown();

    const stats = bridge.getStats();
    assert.deepStrictEqual(stats.bridgesActivated, {});
    assert.deepStrictEqual(stats.bridgesFailed, {});
  });

  it('should prevent activate after shutdown', () => {
    const bridge = new DreamBridge();
    bridge.shutdown();
    assert.throws(() => bridge.activate(), { code: 'SHUTDOWN' });
  });

  it('should remove event listeners on deactivate', () => {
    const bridge = new DreamBridge();
    const scorer = new MockQualityScorer();
    const outcomes = new MockDreamOutcomes();
    bridge.attachQualityScorer(scorer);
    bridge.attachDreamOutcomes(outcomes);
    bridge.activate();

    const listenerCountBefore = scorer.listenerCount('score-computed');
    assert.ok(listenerCountBefore > 0);

    bridge.deactivate();
    assert.strictEqual(scorer.listenerCount('score-computed'), 0);
  });
});
