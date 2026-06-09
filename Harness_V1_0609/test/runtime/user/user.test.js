'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const UserModelManager = require('../../../src/runtime/user/user-model-manager');
const AffinityLearner = require('../../../src/runtime/user/affinity-learner');
const StructuredIntent = require('../../../src/runtime/user/structured-intent');

function createMockStore() {
  const prefs = new Map();
  return {
    setUserPreference(key, value) { prefs.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value)); },
    getUserPreference(key) { return prefs.get(key) ?? null; },
    getAllUserPreferences() { return Array.from(prefs.entries()).map(([key, value]) => ({ key, value })); },
    removeUserPreference(key) { prefs.delete(key); },
    isHealthy() { return true; },
  };
}

function createMockAffinityStore() {
  const records = [];
  return {
    getAllAffinityRecords() { return records; },
    upsertAffinity(agentId, taskType, data) {
      const idx = records.findIndex(r => r.agent_id === agentId && r.task_type === taskType);
      if (idx >= 0) {
        records[idx] = { agent_id: agentId, task_type: taskType, score: data.score, samples: data.samples, total_score: data.totalScore };
      } else {
        records.push({ agent_id: agentId, task_type: taskType, score: data.score, samples: data.samples, total_score: data.totalScore });
      }
    },
    isHealthy() { return true; },
  };
}

describe('UserModelManager - basic operations', () => {
  it('constructor should initialize with default stats', () => {
    const mgr = new UserModelManager();
    assert.ok(mgr);
    const stats = mgr.getStats();
    assert.strictEqual(stats.preferencesSet, 0);
    assert.strictEqual(stats.preferencesGet, 0);
    assert.strictEqual(stats.profilesInjected, 0);
    assert.strictEqual(stats.interactionsLearned, 0);
    assert.strictEqual(stats.hasStore, false);
    mgr.shutdown();
  });

  it('constructor should accept sqliteStore option', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    const stats = mgr.getStats();
    assert.strictEqual(stats.hasStore, true);
    mgr.shutdown();
  });

  it('attachSqliteStore should attach store and return this', () => {
    const mgr = new UserModelManager();
    const store = createMockStore();
    const result = mgr.attachSqliteStore(store);
    assert.strictEqual(result, mgr);
    assert.strictEqual(mgr.getStats().hasStore, true);
    mgr.shutdown();
  });

  it('setPreference should return false without store', () => {
    const mgr = new UserModelManager();
    assert.strictEqual(mgr.setPreference('name', 'test'), false);
    mgr.shutdown();
  });

  it('setPreference should store value and emit event with store', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    let emitted = null;
    mgr.on('preference-set', (evt) => { emitted = evt; });
    const result = mgr.setPreference('name', 'Alice');
    assert.strictEqual(result, true);
    assert.strictEqual(store.getUserPreference('name'), 'Alice');
    assert.ok(emitted);
    assert.strictEqual(emitted.key, 'name');
    assert.strictEqual(emitted.value, 'Alice');
    assert.strictEqual(mgr.getStats().preferencesSet, 1);
    mgr.shutdown();
  });

  it('getPreference should return null without store', () => {
    const mgr = new UserModelManager();
    assert.strictEqual(mgr.getPreference('name'), null);
    mgr.shutdown();
  });

  it('getPreference should retrieve stored value', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    mgr.setPreference('name', 'Bob');
    const val = mgr.getPreference('name');
    assert.strictEqual(val, 'Bob');
    assert.strictEqual(mgr.getStats().preferencesGet, 1);
    mgr.shutdown();
  });

  it('getPreference should return null for missing key', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    assert.strictEqual(mgr.getPreference('nonexistent'), null);
    mgr.shutdown();
  });

  it('getAllPreferences should return empty object without store', () => {
    const mgr = new UserModelManager();
    assert.deepStrictEqual(mgr.getAllPreferences(), {});
    mgr.shutdown();
  });

  it('getAllPreferences should return all stored preferences', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    mgr.setPreference('name', 'Alice');
    mgr.setPreference('timezone', 'UTC');
    const all = mgr.getAllPreferences();
    assert.strictEqual(all.name, 'Alice');
    assert.strictEqual(all.timezone, 'UTC');
    mgr.shutdown();
  });

  it('removePreference should return false without store', () => {
    const mgr = new UserModelManager();
    assert.strictEqual(mgr.removePreference('name'), false);
    mgr.shutdown();
  });

  it('removePreference should delete preference and emit event', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    mgr.setPreference('name', 'Alice');
    let emitted = null;
    mgr.on('preference-removed', (evt) => { emitted = evt; });
    const result = mgr.removePreference('name');
    assert.strictEqual(result, true);
    assert.strictEqual(mgr.getPreference('name'), null);
    assert.ok(emitted);
    assert.strictEqual(emitted.key, 'name');
    mgr.shutdown();
  });
});

describe('UserModelManager - learning and injection', () => {
  it('learnFromInteraction should return false without store', () => {
    const mgr = new UserModelManager();
    assert.strictEqual(mgr.learnFromInteraction({ correction: 'no verbose output' }), false);
    mgr.shutdown();
  });

  it('learnFromInteraction should add correction to petPeeves', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    mgr.learnFromInteraction({ correction: 'no verbose output' });
    const peeves = mgr.getPreference('petPeeves');
    assert.ok(Array.isArray(peeves));
    assert.ok(peeves.includes('no verbose output'));
    mgr.shutdown();
  });

  it('learnFromInteraction should not duplicate petPeeves', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    mgr.learnFromInteraction({ correction: 'no verbose output' });
    mgr.learnFromInteraction({ correction: 'no verbose output' });
    const peeves = mgr.getPreference('petPeeves');
    assert.strictEqual(peeves.filter(p => p === 'no verbose output').length, 1);
    mgr.shutdown();
  });

  it('learnFromInteraction should set preferredLanguage', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    mgr.learnFromInteraction({ languageChoice: 'zh-CN' });
    assert.strictEqual(mgr.getPreference('preferredLanguage'), 'zh-CN');
    mgr.shutdown();
  });

  it('learnFromInteraction should set commStyle', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    mgr.learnFromInteraction({ commStyle: 'concise' });
    assert.strictEqual(mgr.getPreference('commStyle'), 'concise');
    mgr.shutdown();
  });

  it('learnFromInteraction should accumulate techStack', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    mgr.learnFromInteraction({ techStack: ['Node.js', 'SQLite'] });
    mgr.learnFromInteraction({ techStack: ['Node.js', 'React'] });
    const stack = mgr.getPreference('techStack');
    assert.ok(stack.includes('Node.js'));
    assert.ok(stack.includes('SQLite'));
    assert.ok(stack.includes('React'));
    assert.strictEqual(stack.filter(t => t === 'Node.js').length, 1);
    mgr.shutdown();
  });

  it('learnFromInteraction should emit interaction-learned event', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    let emitted = null;
    mgr.on('interaction-learned', (evt) => { emitted = evt; });
    mgr.learnFromInteraction({ languageChoice: 'en' });
    assert.ok(emitted);
    assert.strictEqual(mgr.getStats().interactionsLearned, 1);
    mgr.shutdown();
  });

  it('buildInjectionPrompt should return empty string without store', () => {
    const mgr = new UserModelManager();
    assert.strictEqual(mgr.buildInjectionPrompt(), '');
    mgr.shutdown();
  });

  it('buildInjectionPrompt should return empty string with no preferences', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    assert.strictEqual(mgr.buildInjectionPrompt(), '');
    mgr.shutdown();
  });

  it('buildInjectionPrompt should format preferences into prompt', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    mgr.setPreference('name', 'Alice');
    mgr.setPreference('timezone', 'Asia/Shanghai');
    const prompt = mgr.buildInjectionPrompt();
    assert.ok(prompt.includes('Alice'));
    assert.ok(prompt.includes('Asia/Shanghai'));
    assert.ok(prompt.includes('用户画像'));
    assert.strictEqual(mgr.getStats().profilesInjected, 1);
    mgr.shutdown();
  });

  it('buildInjectionPrompt should emit profile-injected event', () => {
    const store = createMockStore();
    const mgr = new UserModelManager({ sqliteStore: store });
    mgr.setPreference('name', 'Alice');
    let emitted = null;
    mgr.on('profile-injected', (evt) => { emitted = evt; });
    mgr.buildInjectionPrompt();
    assert.ok(emitted);
    assert.strictEqual(emitted.keyCount, 1);
    mgr.shutdown();
  });

  it('getSchema should return user schema copy', () => {
    const mgr = new UserModelManager();
    const schema = mgr.getSchema();
    assert.ok(schema.name);
    assert.ok(schema.role);
    assert.ok(schema.timezone);
    assert.ok(schema.codingPrefs);
    assert.ok(schema.commStyle);
    assert.ok(schema.petPeeves);
    assert.ok(schema.projectContext);
    assert.ok(schema.techStack);
    mgr.shutdown();
  });

  it('isHealthy should return true without store', () => {
    const mgr = new UserModelManager();
    assert.strictEqual(mgr.isHealthy(), true);
    mgr.shutdown();
  });

  it('isHealthy should return false after shutdown', () => {
    const mgr = new UserModelManager();
    mgr.shutdown();
    assert.strictEqual(mgr.isHealthy(), false);
  });
});

describe('AffinityLearner', () => {
  it('constructor should initialize with default values', () => {
    const learner = new AffinityLearner();
    assert.ok(learner);
    assert.strictEqual(learner._learningRate, AffinityLearner.LEARNING_RATE);
    assert.strictEqual(learner._decayFactor, AffinityLearner.DECAY_FACTOR);
    assert.strictEqual(learner._minSamples, AffinityLearner.MIN_SAMPLES);
    learner.shutdown();
  });

  it('constructor should accept custom options', () => {
    const learner = new AffinityLearner({ learningRate: 0.2, decayFactor: 0.99, minSamples: 5, maxRecords: 50 });
    assert.strictEqual(learner._learningRate, 0.2);
    assert.strictEqual(learner._decayFactor, 0.99);
    assert.strictEqual(learner._minSamples, 5);
    assert.strictEqual(learner._maxRecords, 50);
    learner.shutdown();
  });

  it('recordExecution should ignore invalid inputs', () => {
    const learner = new AffinityLearner();
    learner.recordExecution(null, 'task', 0.8);
    learner.recordExecution('agent', null, 0.8);
    learner.recordExecution('agent', 'task', 'bad');
    assert.strictEqual(learner.getStats().totalAffinities, 0);
    learner.shutdown();
  });

  it('recordExecution should update affinity and emit event', () => {
    const learner = new AffinityLearner();
    let emitted = null;
    learner.on('execution-recorded', (evt) => { emitted = evt; });
    learner.recordExecution('agent-1', 'tdd', 0.9);
    assert.ok(emitted);
    assert.strictEqual(emitted.agentId, 'agent-1');
    assert.strictEqual(emitted.taskType, 'tdd');
    assert.strictEqual(emitted.qualityScore, 0.9);
    assert.strictEqual(learner.getStats().totalAffinities, 1);
    learner.shutdown();
  });

  it('recordExecution should update affinity score using learning rate', () => {
    const learner = new AffinityLearner({ learningRate: 0.5, minSamples: 1 });
    learner.recordExecution('agent-1', 'tdd', 1.0);
    const affinity = learner.getAffinity('agent-1', 'tdd');
    assert.strictEqual(affinity.score, 0.75);
    assert.strictEqual(affinity.samples, 1);
    learner.shutdown();
  });

  it('getAffinity should return default for unknown agent', () => {
    const learner = new AffinityLearner();
    const affinity = learner.getAffinity('unknown', 'task');
    assert.strictEqual(affinity.score, 0.5);
    assert.strictEqual(affinity.confidence, 'low');
    assert.strictEqual(affinity.samples, 0);
    learner.shutdown();
  });

  it('getAffinity should return low confidence below minSamples', () => {
    const learner = new AffinityLearner({ minSamples: 5 });
    learner.recordExecution('agent-1', 'tdd', 0.9);
    learner.recordExecution('agent-1', 'tdd', 0.8);
    const affinity = learner.getAffinity('agent-1', 'tdd');
    assert.strictEqual(affinity.confidence, 'low');
    learner.shutdown();
  });

  it('getAffinity should return medium confidence at 5-9 samples', () => {
    const learner = new AffinityLearner({ minSamples: 3 });
    for (let i = 0; i < 6; i++) {
      learner.recordExecution('agent-1', 'tdd', 0.8);
    }
    const affinity = learner.getAffinity('agent-1', 'tdd');
    assert.strictEqual(affinity.confidence, 'medium');
    learner.shutdown();
  });

  it('getAffinity should return high confidence at 10+ samples', () => {
    const learner = new AffinityLearner({ minSamples: 3 });
    for (let i = 0; i < 10; i++) {
      learner.recordExecution('agent-1', 'tdd', 0.8);
    }
    const affinity = learner.getAffinity('agent-1', 'tdd');
    assert.strictEqual(affinity.confidence, 'high');
    learner.shutdown();
  });

  it('getRecommendations should sort agents by score descending', () => {
    const learner = new AffinityLearner({ minSamples: 1 });
    for (let i = 0; i < 5; i++) learner.recordExecution('agent-a', 'tdd', 0.9);
    for (let i = 0; i < 5; i++) learner.recordExecution('agent-b', 'tdd', 0.5);
    for (let i = 0; i < 5; i++) learner.recordExecution('agent-c', 'tdd', 0.7);
    const recs = learner.getRecommendations('tdd', ['agent-a', 'agent-b', 'agent-c']);
    assert.strictEqual(recs[0].agentId, 'agent-a');
    assert.strictEqual(recs[1].agentId, 'agent-c');
    assert.strictEqual(recs[2].agentId, 'agent-b');
    learner.shutdown();
  });

  it('decay should reduce affinity scores', () => {
    const learner = new AffinityLearner({ decayFactor: 0.9 });
    for (let i = 0; i < 5; i++) learner.recordExecution('agent-1', 'tdd', 1.0);
    const before = learner.getAffinity('agent-1', 'tdd').score;
    learner.decay();
    const after = learner.getAffinity('agent-1', 'tdd').score;
    assert.ok(after < before);
    assert.ok(after >= 0.1);
    learner.shutdown();
  });

  it('decay should emit affinities-decayed event', () => {
    const learner = new AffinityLearner();
    learner.recordExecution('agent-1', 'tdd', 0.8);
    let emitted = false;
    learner.on('affinities-decayed', () => { emitted = true; });
    learner.decay();
    assert.strictEqual(emitted, true);
    learner.shutdown();
  });

  it('getAgentPerformance should return performance for specific agent', () => {
    const learner = new AffinityLearner({ minSamples: 1 });
    learner.recordExecution('agent-1', 'tdd', 0.9);
    learner.recordExecution('agent-1', 'review', 0.7);
    learner.recordExecution('agent-2', 'tdd', 0.5);
    const perf = learner.getAgentPerformance('agent-1');
    assert.ok(perf.tdd);
    assert.ok(perf.review);
    assert.strictEqual(typeof perf.tdd.score, 'number');
    assert.strictEqual(typeof perf.tdd.averageScore, 'number');
    assert.ok(!perf.tdd || !learner.getAgentPerformance('agent-2').review);
    learner.shutdown();
  });

  it('getStats should return correct statistics', () => {
    const learner = new AffinityLearner();
    learner.recordExecution('agent-1', 'tdd', 0.9);
    learner.recordExecution('agent-1', 'review', 0.7);
    const stats = learner.getStats();
    assert.strictEqual(stats.totalAffinities, 2);
    assert.strictEqual(stats.totalRecords, 2);
    assert.strictEqual(stats.knownAgents, 1);
    assert.strictEqual(stats.knownTaskTypes, 2);
    assert.strictEqual(stats.learningRate, learner._learningRate);
    assert.strictEqual(stats.decayFactor, learner._decayFactor);
    assert.strictEqual(stats.hasPersistentStore, false);
    learner.shutdown();
  });

  it('attachSqliteStore should load records and emit event', () => {
    const store = createMockAffinityStore();
    store.upsertAffinity('agent-1', 'tdd', { score: 0.8, samples: 5, totalScore: 4.0 });
    const learner = new AffinityLearner();
    let emitted = null;
    learner.on('loaded-from-store', (evt) => { emitted = evt; });
    learner.attachSqliteStore(store);
    assert.ok(emitted);
    assert.strictEqual(emitted.count, 1);
    const affinity = learner.getAffinity('agent-1', 'tdd');
    assert.strictEqual(affinity.score, 0.8);
    assert.strictEqual(affinity.samples, 5);
    learner.shutdown();
  });

  it('isHealthy should return true when active', () => {
    const learner = new AffinityLearner();
    assert.strictEqual(learner.isHealthy(), true);
    learner.shutdown();
  });

  it('shutdown should clear records and affinities', () => {
    const learner = new AffinityLearner();
    learner.recordExecution('agent-1', 'tdd', 0.9);
    learner.shutdown();
    assert.strictEqual(learner._records.size, 0);
    assert.strictEqual(learner._affinities.size, 0);
  });
});

describe('StructuredIntent - parsing', () => {
  it('constructor should initialize with default schemas', () => {
    const si = new StructuredIntent();
    assert.ok(si);
    assert.ok(si.getSchema('tdd-implement'));
    assert.ok(si.getSchema('code-review'));
    assert.ok(si.getSchema('bug-fix'));
    si.shutdown();
  });

  it('constructor should accept custom options', () => {
    const si = new StructuredIntent({
      maxHistory: 50,
      completenessThreshold: 0.8,
      maxSessions: 10,
    });
    assert.strictEqual(si._maxHistory, 50);
    assert.strictEqual(si._completenessThreshold, 0.8);
    assert.strictEqual(si._maxSessions, 10);
    si.shutdown();
  });

  it('parseIntent should return clarification for empty message', () => {
    const si = new StructuredIntent();
    const result = si.parseIntent('', 'tdd-implement');
    assert.strictEqual(result.skillId, 'tdd-implement');
    assert.strictEqual(result.completeness, 0);
    assert.strictEqual(result.clarificationNeeded, true);
    assert.ok(result.clarificationPrompt);
    si.shutdown();
  });

  it('parseIntent should return clarification for null message', () => {
    const si = new StructuredIntent();
    const result = si.parseIntent(null, 'tdd-implement');
    assert.strictEqual(result.completeness, 0);
    assert.strictEqual(result.clarificationNeeded, true);
    si.shutdown();
  });

  it('parseIntent should extract params from message for known schema', () => {
    const si = new StructuredIntent();
    const result = si.parseIntent('target_module: auth success_criteria: 90% coverage', 'tdd-implement');
    assert.strictEqual(result.skillId, 'tdd-implement');
    assert.ok(result.params.target_module);
    assert.ok(result.params.success_criteria);
    assert.strictEqual(result.completeness, 1.0);
    assert.strictEqual(result.clarificationNeeded, false);
    si.shutdown();
  });

  it('parseIntent should return completeness 1.0 for unknown skill', () => {
    const si = new StructuredIntent();
    const result = si.parseIntent('do something', 'unknown-skill');
    assert.strictEqual(result.skillId, 'unknown-skill');
    assert.strictEqual(result.completeness, 1.0);
    assert.strictEqual(result.clarificationNeeded, false);
    assert.strictEqual(result.params.description, 'do something');
    si.shutdown();
  });

  it('parseIntent should track missing required params', () => {
    const si = new StructuredIntent();
    const result = si.parseIntent('target_module: auth', 'tdd-implement');
    assert.ok(result.missingParams.length > 0);
    assert.ok(result.missingParams.some(p => p.name === 'success_criteria'));
    assert.ok(result.completeness < 1.0);
    si.shutdown();
  });

  it('parseIntent should accumulate params across session', () => {
    const si = new StructuredIntent();
    si.parseIntent('target_module: auth', 'tdd-implement', { sessionId: 'sess-1' });
    const result = si.parseIntent('success_criteria: 90%', 'tdd-implement', { sessionId: 'sess-1' });
    assert.ok(result.params.target_module);
    assert.ok(result.params.success_criteria);
    assert.strictEqual(result.paramsAccumulated, true);
    si.shutdown();
  });

  it('parseIntent should emit intent-parsed event', () => {
    const si = new StructuredIntent();
    let emitted = null;
    si.on('intent-parsed', (evt) => { emitted = evt; });
    si.parseIntent('target_module: auth', 'tdd-implement');
    assert.ok(emitted);
    assert.strictEqual(emitted.skillId, 'tdd-implement');
    si.shutdown();
  });
});

describe('StructuredIntent - schema and validation', () => {
  it('getSchema should return null for unknown skill', () => {
    const si = new StructuredIntent();
    assert.strictEqual(si.getSchema('nonexistent'), null);
    si.shutdown();
  });

  it('registerSchema should add new schema', () => {
    const si = new StructuredIntent();
    const result = si.registerSchema('custom-skill', {
      requiredParams: [{ name: 'param1', type: 'string', description: 'test param' }],
      optionalParams: [],
    });
    assert.strictEqual(result, true);
    assert.ok(si.getSchema('custom-skill'));
    si.shutdown();
  });

  it('registerSchema should reject duplicate skillId', () => {
    const si = new StructuredIntent();
    const result = si.registerSchema('tdd-implement', {
      requiredParams: [{ name: 'x', type: 'string', description: 'x' }],
    });
    assert.strictEqual(result, false);
    si.shutdown();
  });

  it('registerSchema should reject invalid inputs', () => {
    const si = new StructuredIntent();
    assert.strictEqual(si.registerSchema('', { requiredParams: [] }), false);
    assert.strictEqual(si.registerSchema(null, { requiredParams: [] }), false);
    assert.strictEqual(si.registerSchema('x'.repeat(129), { requiredParams: [] }), false);
    assert.strictEqual(si.registerSchema('valid-id', null), false);
    assert.strictEqual(si.registerSchema('valid-id', { requiredParams: 'not-array' }), false);
    si.shutdown();
  });

  it('registerSchema should emit schema-registered event', () => {
    const si = new StructuredIntent();
    let emitted = null;
    si.on('schema-registered', (evt) => { emitted = evt; });
    si.registerSchema('new-skill', {
      requiredParams: [{ name: 'p1', type: 'string', description: 'd1' }],
    });
    assert.ok(emitted);
    assert.strictEqual(emitted.skillId, 'new-skill');
    si.shutdown();
  });

  it('validateIntent should return invalid for missing skillId', () => {
    const si = new StructuredIntent();
    const result = si.validateIntent({});
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
    si.shutdown();
  });

  it('validateIntent should return valid for unknown skill with warning', () => {
    const si = new StructuredIntent();
    const result = si.validateIntent({ skillId: 'unknown-skill', params: {} });
    assert.strictEqual(result.valid, true);
    assert.ok(result.warnings.length > 0);
    si.shutdown();
  });

  it('validateIntent should detect missing required params', () => {
    const si = new StructuredIntent();
    const result = si.validateIntent({ skillId: 'tdd-implement', params: {} });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('target_module')));
    si.shutdown();
  });

  it('validateIntent should return valid when all required params present', () => {
    const si = new StructuredIntent();
    const result = si.validateIntent({
      skillId: 'tdd-implement',
      params: { target_module: 'auth', success_criteria: '90%' },
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
    si.shutdown();
  });

  it('enhancePrompt should return original message when complete and low-entropy', () => {
    const si = new StructuredIntent();
    const msg = '作为后端开发者，在Node.js项目中使用Express框架实现REST API，target_module: auth success_criteria: 90%';
    const enhanced = si.enhancePrompt(msg, 'tdd-implement');
    assert.strictEqual(enhanced, msg);
    si.shutdown();
  });

  it('enhancePrompt should append clarification when incomplete', () => {
    const si = new StructuredIntent();
    const msg = 'target_module: auth';
    const enhanced = si.enhancePrompt(msg, 'tdd-implement');
    assert.ok(enhanced.length > msg.length);
    assert.ok(enhanced.includes('结构化意图补充'));
    si.shutdown();
  });

  it('getStats should return correct statistics', () => {
    const si = new StructuredIntent();
    si.parseIntent('target_module: auth', 'tdd-implement');
    si.parseIntent('do something', 'code-review');
    const stats = si.getStats();
    assert.strictEqual(stats.totalParsed, 2);
    assert.strictEqual(stats.registeredSchemas, Object.keys(StructuredIntent.INTENT_SCHEMAS).length);
    assert.ok(typeof stats.clarificationRate === 'number');
    assert.ok(typeof stats.averageCompleteness === 'number');
    si.shutdown();
  });

  it('clearSession should remove session params', () => {
    const si = new StructuredIntent();
    si.parseIntent('target_module: auth', 'tdd-implement', { sessionId: 'sess-1' });
    si.clearSession('sess-1');
    assert.strictEqual(si.getSessionParams('sess-1', 'tdd-implement'), null);
    si.shutdown();
  });

  it('getSessionParams should return null for unknown session', () => {
    const si = new StructuredIntent();
    assert.strictEqual(si.getSessionParams('no-such-session', 'tdd-implement'), null);
    si.shutdown();
  });

  it('shutdown should clear history and session params', () => {
    const si = new StructuredIntent();
    si.parseIntent('target_module: auth', 'tdd-implement', { sessionId: 'sess-1' });
    si.shutdown();
    assert.strictEqual(si._history.size, 0);
    assert.strictEqual(si._sessionParams.size, 0);
  });
});

describe('StructuredIntent - prior richness assessment', () => {
  it('assessPriorRichness should return high-entropy for empty input', () => {
    const si = new StructuredIntent();
    const result = si.assessPriorRichness('');
    assert.strictEqual(result.level, 'high-entropy');
    assert.strictEqual(result.score, 0);
    si.shutdown();
  });

  it('assessPriorRichness should return high-entropy for null input', () => {
    const si = new StructuredIntent();
    const result = si.assessPriorRichness(null);
    assert.strictEqual(result.level, 'high-entropy');
    si.shutdown();
  });

  it('assessPriorRichness should return high-entropy for vague short question', () => {
    const si = new StructuredIntent();
    const result = si.assessPriorRichness('如何优化性能');
    assert.strictEqual(result.level, 'high-entropy');
    assert.ok(result.score < 2);
    si.shutdown();
  });

  it('assessPriorRichness should return medium-entropy for moderate detail', () => {
    const si = new StructuredIntent();
    const result = si.assessPriorRichness('在Node.js项目中使用Express框架实现REST API，要求使用CommonJS模块系统');
    assert.ok(result.level === 'medium-entropy' || result.level === 'low-entropy');
    assert.ok(result.score >= 2);
    si.shutdown();
  });

  it('assessPriorRichness should return low-entropy for rich detailed question', () => {
    const si = new StructuredIntent();
    const result = si.assessPriorRichness('作为Node.js后端开发者，在v20的HTTP服务器中，当并发连接超过1000时响应时间从50ms升到500ms，如何优化事件循环？必须不引入新依赖，需要深入分析底层原理');
    assert.strictEqual(result.level, 'low-entropy');
    assert.ok(result.score >= 4);
    assert.ok(result.signals.length >= 3);
    si.shutdown();
  });

  it('assessPriorRichness should detect scenario detail signals', () => {
    const si = new StructuredIntent();
    const result = si.assessPriorRichness('在微服务架构场景中使用gRPC框架v1.58实现服务间通信');
    assert.ok(result.signals.includes('scenario-detail'));
    si.shutdown();
  });

  it('assessPriorRichness should detect role identity signals', () => {
    const si = new StructuredIntent();
    const result = si.assessPriorRichness('作为资深架构师，我负责设计分布式系统');
    assert.ok(result.signals.includes('role-identity'));
    si.shutdown();
  });

  it('assessPriorRichness should detect explicit constraint signals', () => {
    const si = new StructuredIntent();
    const result = si.assessPriorRichness('必须使用原生HTTP模块，不能引入Express');
    assert.ok(result.signals.includes('explicit-constraint'));
    si.shutdown();
  });

  it('assessPriorRichness should detect depth expectation signals', () => {
    const si = new StructuredIntent();
    const result = si.assessPriorRichness('请深入分析V8引擎的垃圾回收原理，对比不同算法的权衡');
    assert.ok(result.signals.includes('depth-expectation'));
    si.shutdown();
  });

  it('assessPriorRichness should detect technical specificity signals', () => {
    const si = new StructuredIntent();
    const result = si.assessPriorRichness('使用SQL ORM和REST API实现CRUD SDK的HTTP接口');
    assert.ok(result.signals.includes('technical-specificity'));
    si.shutdown();
  });

  it('assessPriorRichness should give length bonus for long messages', () => {
    const si = new StructuredIntent();
    const short = si.assessPriorRichness('优化代码');
    const long = si.assessPriorRichness('在当前的Node.js CommonJS项目中，使用原生http模块实现一个支持CORS和JWT认证的REST API端点，需要处理预检请求和Token过期刷新逻辑');
    assert.ok(long.score > short.score);
    si.shutdown();
  });

  it('enhancePrompt should include prior richness hint for high-entropy input', () => {
    const si = new StructuredIntent();
    const enhanced = si.enhancePrompt('优化性能', 'bug-fix');
    assert.ok(enhanced.includes('先验信息不足') || enhanced.includes('高熵') || enhanced.includes('场景细节'));
    si.shutdown();
  });

  it('enhancePrompt should not add richness hint for low-entropy input', () => {
    const si = new StructuredIntent();
    const enhanced = si.enhancePrompt('作为后端开发者，在Node.js v20中使用原生http模块实现REST API，必须支持CORS和JWT认证，需要深入分析错误处理机制', 'tdd-implement');
    assert.ok(!enhanced.includes('先验信息不足') && !enhanced.includes('高熵'));
    si.shutdown();
  });

  it('assessPriorRichness should cap score at 6', () => {
    const si = new StructuredIntent();
    const result = si.assessPriorRichness('作为资深Node.js架构师，在微服务架构场景中使用gRPC v1.58和Protocol Buffers实现服务间通信，必须不引入新依赖，需要深入分析底层序列化原理和对比gRPC与REST的权衡，要求提供源码级实现细节');
    assert.ok(result.score <= 6);
    si.shutdown();
  });
});

describe('StructuredIntent - quality report', () => {
  it('generateQualityReport should return report with prior richness', () => {
    const si = new StructuredIntent();
    const report = si.generateQualityReport('作为后端开发者，在Node.js中使用原生http模块实现REST API', 'tdd-implement');
    assert.ok(report.priorRichness);
    assert.ok(report.priorRichness.level);
    assert.ok(typeof report.priorRichness.score === 'number');
    assert.ok(report.intent);
    assert.ok(report.suggestions);
    si.shutdown();
  });

  it('generateQualityReport should suggest improvements for high-entropy input', () => {
    const si = new StructuredIntent();
    const report = si.generateQualityReport('优化性能', 'bug-fix');
    assert.strictEqual(report.priorRichness.level, 'high-entropy');
    assert.ok(report.suggestions.length > 0);
    si.shutdown();
  });

  it('generateQualityReport should have empty suggestions for low-entropy input', () => {
    const si = new StructuredIntent();
    const report = si.generateQualityReport('作为资深Node.js架构师，在微服务场景中使用gRPC v1.58实现服务间通信，必须不引入新依赖，需要深入分析底层序列化原理', 'architecture-design');
    assert.ok(report.priorRichness.level === 'low-entropy' || report.priorRichness.level === 'medium-entropy');
    if (report.priorRichness.level === 'low-entropy') {
      assert.strictEqual(report.suggestions.length, 0);
    }
    si.shutdown();
  });

  it('generateQualityReport should include firstMessageVibe field', () => {
    const si = new StructuredIntent();
    const report = si.generateQualityReport('优化性能', 'bug-fix');
    assert.ok(report.firstMessageVibe);
    si.shutdown();
  });

  it('generateQualityReport should handle null input', () => {
    const si = new StructuredIntent();
    const report = si.generateQualityReport(null, 'bug-fix');
    assert.strictEqual(report.priorRichness.level, 'high-entropy');
    assert.ok(report.suggestions.length > 0);
    si.shutdown();
  });
});
