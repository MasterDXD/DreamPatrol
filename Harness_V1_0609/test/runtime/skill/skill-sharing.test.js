'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..', '..', '..');
const SkillImprovementLoop = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-improvement-loop'));
const SkillCreationEngine = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-creation-engine'));
const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));

const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  }
});

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sharing-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function createCausalBus() {
  const bus = new EventEmitter();
  bus.published = [];
  bus.publish = function(event, data) {
    bus.published.push({ event, data });
    bus.emit(event, data);
  };
  return bus;
}

function createMockSqliteStore() {
  const tmpDir = createTempDir();
  const store = new SqliteStore(tmpDir);
  store.init();
  return store;
}

function createAgentRuntime() {
  return new EventEmitter();
}

describe('SkillImprovementLoop with causalBus', () => {
  it('should publish learning-recorded event to causalBus', () => {
    const bus = createCausalBus();
    const store = createMockSqliteStore();
    const loop = new SkillImprovementLoop({ sqliteStore: store, causalBus: bus });
    const entry = {
      skillId: 'test-skill',
      agentId: 'agent-1',
      whatWorked: 'use caching',
      whatFailed: 'skip validation',
      phase: 'dev',
      approach: 'tdd',
      tips: '',
      context: '',
    };
    loop.recordLearning(entry);
    assert.equal(bus.published.length, 1);
    assert.equal(bus.published[0].event, 'skill:learning-recorded');
    assert.equal(bus.published[0].data.skillId, 'test-skill');
    assert.equal(bus.published[0].data.agentId, 'agent-1');
    assert.equal(bus.published[0].data.tips, 'use caching');
    assert.equal(bus.published[0].data.avoidances, 'skip validation');
    loop.shutdown();
    store.shutdown();
  });

  it('should not publish to causalBus when not attached', () => {
    const store = createMockSqliteStore();
    const loop = new SkillImprovementLoop({ sqliteStore: store });
    const entry = {
      skillId: 'test-skill',
      agentId: 'agent-1',
      whatWorked: 'tip',
      whatFailed: 'fail',
      phase: 'dev',
      approach: '',
      tips: '',
      context: '',
    };
    loop.recordLearning(entry);
    loop.shutdown();
    store.shutdown();
  });

  it('should attach causalBus via attachCausalBus method', () => {
    const bus = createCausalBus();
    const store = createMockSqliteStore();
    const loop = new SkillImprovementLoop({ sqliteStore: store });
    const result = loop.attachCausalBus(bus);
    assert.equal(result, loop);
    const entry = {
      skillId: 'attach-skill',
      agentId: 'agent-2',
      whatWorked: 'works',
      whatFailed: 'fails',
      phase: 'dev',
      approach: '',
      tips: '',
      context: '',
    };
    loop.recordLearning(entry);
    assert.equal(bus.published.length, 1);
    loop.shutdown();
    store.shutdown();
  });
});

describe('SkillImprovementLoop.getSharedLearnings', () => {
  it('should return shared learnings from sqliteStore', () => {
    const store = createMockSqliteStore();
    store.addSharedSkillLearning({
      skillId: 'shared-skill',
      agentId: 'agent-x',
      tips: 'shared tip',
      avoidances: 'shared avoidance',
      context: 'ctx',
    });
    const loop = new SkillImprovementLoop({ sqliteStore: store });
    const result = loop.getSharedLearnings('shared-skill');
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].tips, 'shared tip');
    assert.equal(result[0].avoidances, 'shared avoidance');
    loop.shutdown();
    store.shutdown();
  });

  it('should return empty array when no sqliteStore', () => {
    const loop = new SkillImprovementLoop({});
    const result = loop.getSharedLearnings('any-skill');
    assert.deepEqual(result, []);
    loop.shutdown();
  });
});

describe('SkillImprovementLoop.getSharedTipsForContext', () => {
  it('should combine local and shared tips', () => {
    const store = createMockSqliteStore();
    store.addSkillLearning({
      skillId: 'combo-skill',
      phase: 'dev',
      approach: '',
      whatWorked: '',
      whatFailed: 'local fail',
      tips: 'local tip',
      context: '',
    });
    store.addSharedSkillLearning({
      skillId: 'combo-skill',
      agentId: 'other-agent',
      tips: 'shared tip',
      avoidances: 'shared avoidance',
      context: '',
    });
    const loop = new SkillImprovementLoop({ sqliteStore: store });
    const ctx = loop.getSharedTipsForContext('combo-skill');
    assert.ok(ctx.includes('local tip'));
    assert.ok(ctx.includes('shared tip'));
    assert.ok(ctx.includes('local fail'));
    assert.ok(ctx.includes('shared avoidance'));
    loop.shutdown();
    store.shutdown();
  });

  it('should return empty string when no tips or avoidances', () => {
    const store = createMockSqliteStore();
    const loop = new SkillImprovementLoop({ sqliteStore: store });
    const ctx = loop.getSharedTipsForContext('empty-skill');
    assert.equal(ctx, '');
    loop.shutdown();
    store.shutdown();
  });
});

describe('SkillImprovementLoop.getStats with sharedLearnings', () => {
  it('should include sharedLearnings count', () => {
    const store = createMockSqliteStore();
    store.addSharedSkillLearning({
      skillId: 'stat-skill',
      agentId: 'agent-a',
      tips: 'tip',
      avoidances: 'avoid',
      context: '',
    });
    const loop = new SkillImprovementLoop({ sqliteStore: store });
    const stats = loop.getStats();
    assert.equal(stats.sharedLearnings, 1);
    loop.shutdown();
    store.shutdown();
  });

  it('should return 0 sharedLearnings when no sqliteStore', () => {
    const loop = new SkillImprovementLoop({});
    const stats = loop.getStats();
    assert.equal(stats.sharedLearnings, 0);
    loop.shutdown();
  });
});

describe('SkillCreationEngine.attachToAgentRuntime', () => {
  it('should subscribe to task:completed and task:failed events', () => {
    const engine = new SkillCreationEngine({ projectRoot: '' });
    const runtime = createAgentRuntime();
    const result = engine.attachToAgentRuntime(runtime);
    assert.equal(result, engine);
    assert.ok(runtime.listeners('task:completed').length > 0);
    assert.ok(runtime.listeners('task:failed').length > 0);
    engine.detachFromAgentRuntime();
  });
});

describe('SkillCreationEngine._onTaskCompleted', () => {
  it('should evaluate and emit auto-skill-evaluation', () => {
    const engine = new SkillCreationEngine({ projectRoot: '' });
    const runtime = createAgentRuntime();
    engine.attachToAgentRuntime(runtime);
    let emitted = null;
    engine.on('auto-skill-evaluation', (result) => { emitted = result; });
    runtime.emit('task:completed', {
      toolCalls: 6,
      recovered: false,
      userCorrection: false,
      steps: ['step1', 'step2'],
      description: 'complex deployment task',
    });
    assert.ok(emitted !== null);
    assert.equal(emitted.shouldCreate, true);
    assert.equal(emitted.complexity, 6);
    engine.detachFromAgentRuntime();
  });

  it('should not emit when task is not complex enough', () => {
    const engine = new SkillCreationEngine({ projectRoot: '' });
    const runtime = createAgentRuntime();
    engine.attachToAgentRuntime(runtime);
    let emitted = null;
    engine.on('auto-skill-evaluation', (result) => { emitted = result; });
    runtime.emit('task:completed', {
      toolCalls: 1,
      recovered: false,
      userCorrection: false,
      steps: [],
      description: 'simple task',
    });
    assert.equal(emitted, null);
    engine.detachFromAgentRuntime();
  });
});

describe('SkillCreationEngine._onTaskFailed', () => {
  it('should evaluate with hadError=true and emit auto-skill-evaluation', () => {
    const engine = new SkillCreationEngine({ projectRoot: '' });
    const runtime = createAgentRuntime();
    engine.attachToAgentRuntime(runtime);
    let emitted = null;
    engine.on('auto-skill-evaluation', (result) => { emitted = result; });
    runtime.emit('task:failed', {
      toolCalls: 2,
      recovered: true,
      userCorrection: false,
      steps: ['step1'],
      description: 'failed deployment task',
    });
    assert.ok(emitted !== null);
    assert.equal(emitted.shouldCreate, true);
    assert.ok(emitted.triggers.hasRecovery);
    engine.detachFromAgentRuntime();
  });
});

describe('SkillCreationEngine.detachFromAgentRuntime', () => {
  it('should remove listeners from runtime', () => {
    const engine = new SkillCreationEngine({ projectRoot: '' });
    const runtime = createAgentRuntime();
    engine.attachToAgentRuntime(runtime);
    assert.ok(runtime.listeners('task:completed').length > 0);
    assert.ok(runtime.listeners('task:failed').length > 0);
    engine.detachFromAgentRuntime();
    assert.equal(runtime.listeners('task:completed').length, 0);
    assert.equal(runtime.listeners('task:failed').length, 0);
  });

  it('should be safe to call when no runtime attached', () => {
    const engine = new SkillCreationEngine({ projectRoot: '' });
    engine.detachFromAgentRuntime();
  });
});

describe('SqliteStore shared_learnings', () => {
  it('should add and retrieve shared skill learnings', () => {
    const store = createMockSqliteStore();
    const result = store.addSharedSkillLearning({
      skillId: 'store-skill',
      agentId: 'agent-1',
      tips: 'use batching',
      avoidances: 'avoid sync calls',
      context: 'production',
    });
    assert.ok(result.id > 0);
    assert.equal(result.skillId, 'store-skill');
    const learnings = store.getSharedSkillLearnings('store-skill');
    assert.equal(learnings.length, 1);
    assert.equal(learnings[0].skill_id, 'store-skill');
    assert.equal(learnings[0].agent_id, 'agent-1');
    assert.equal(learnings[0].tips, 'use batching');
    assert.equal(learnings[0].avoidances, 'avoid sync calls');
    store.shutdown();
  });

  it('should include sharedLearnings in getStats', () => {
    const store = createMockSqliteStore();
    store.addSharedSkillLearning({
      skillId: 'stat-skill',
      agentId: 'agent-1',
      tips: 'tip',
      avoidances: 'avoid',
      context: '',
    });
    const stats = store.getStats();
    assert.equal(stats.sharedLearnings, 1);
    store.shutdown();
  });

  it('should return empty array for non-existent skill', () => {
    const store = createMockSqliteStore();
    const learnings = store.getSharedSkillLearnings('nonexistent');
    assert.deepEqual(learnings, []);
    store.shutdown();
  });

  it('should reject entry without skillId', () => {
    const store = createMockSqliteStore();
    const result = store.addSharedSkillLearning({});
    assert.equal(result.id, 0);
    assert.ok(result.error);
    store.shutdown();
  });
});
