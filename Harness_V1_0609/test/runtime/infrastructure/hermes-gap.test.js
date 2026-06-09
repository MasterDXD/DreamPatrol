'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..', '..');

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  fs.mkdirSync(path.join(dir, '.harness', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'data'), { recursive: true });
  return dir;
}

describe('SqliteStore', () => {
  it('should init and create tables', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const store = new SqliteStore(tmpDir);
    store.init();
    const stats = store.getStats();
    assert.equal(stats.knowledge, 0);
    assert.equal(stats.sessionSummaries, 0);
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should add and query knowledge', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const store = new SqliteStore(tmpDir);
    store.init();
    store.addKnowledge({ category: 'test', title: 'Hello World', content: 'Test content about Node.js', tags: 'nodejs,test', source: 'unit-test' });
    const results = store.queryKnowledge({ category: 'test' });
    assert.ok(results.length >= 1);
    assert.equal(results[0].title, 'Hello World');
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should FTS search knowledge', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const store = new SqliteStore(tmpDir);
    store.init();
    store.addKnowledge({ category: 'tech', title: 'Node.js Guide', content: 'How to use Node.js for backend development', tags: 'nodejs', source: 'docs' });
    store.addKnowledge({ category: 'tech', title: 'Python Guide', content: 'How to use Python for data science', tags: 'python', source: 'docs' });
    const results = store.ftsSearch('knowledge', 'Node.js');
    assert.ok(results.length >= 1);
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should save and get session summary', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const store = new SqliteStore(tmpDir);
    store.init();
    store.saveSessionSummary('sess-1', { phase: 'module-development', completedSkills: 'tdd-implement', keyDecisions: 'Use TDD', lessonsLearned: 'Write tests first' });
    const summary = store.getSessionSummary('sess-1');
    assert.ok(summary);
    assert.equal(summary.phase, 'module-development');
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should add and get skill learnings', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const store = new SqliteStore(tmpDir);
    store.init();
    store.addSkillLearning({ skillId: 'tdd-implement', phase: 'RED', approach: 'Write failing test', whatWorked: 'Red-Green cycle', whatFailed: 'Skipped test', tips: 'Always run tests', context: 'Unit test' });
    const learnings = store.getSkillLearnings('tdd-implement');
    assert.ok(learnings.length >= 1);
    const tips = store.getSkillTips('tdd-implement');
    assert.ok(tips.includes('Always run tests'));
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should manage memory entries', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const store = new SqliteStore(tmpDir);
    store.init();
    const r1 = store.addMemory('memory', 'User prefers TypeScript over JavaScript');
    assert.ok(r1);
    const memories = store.getMemories('memory');
    assert.ok(memories.length >= 1);
    const usage = store.getMemoryUsage('memory');
    assert.ok(usage.percentage > 0);
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should manage user preferences', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const store = new SqliteStore(tmpDir);
    store.init();
    store.setUserPreference('language', 'TypeScript');
    store.setUserPreference('commStyle', 'concise');
    assert.equal(store.getUserPreference('language'), 'TypeScript');
    const all = store.getAllUserPreferences();
    assert.ok(all.length >= 2);
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should enforce memory char limit', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const store = new SqliteStore(tmpDir);
    store.init();
    const longContent = 'x'.repeat(3000);
    const r = store.addMemory('memory', longContent);
    assert.ok(r.success === false);
    assert.ok(r.error.includes('exceed'));
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should search memories with FTS', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const store = new SqliteStore(tmpDir);
    store.init();
    store.addMemory('memory', 'Project uses React with TypeScript');
    store.addMemory('memory', 'Server runs on port 3210');
    const results = store.searchMemories('React');
    assert.ok(results.length >= 1);
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('SkillImprovementLoop', () => {
  it('should record learning', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const SkillImprovementLoop = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-improvement-loop'));
    const store = new SqliteStore(tmpDir); store.init();
    const loop = new SkillImprovementLoop({ sqliteStore: store });
    const r = loop.recordLearning({ skillId: 'test-skill', whatWorked: 'Good approach', tips: 'Use this method' });
    assert.ok(r.id > 0);
    loop.shutdown(); store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should get tips for context', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const SkillImprovementLoop = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-improvement-loop'));
    const store = new SqliteStore(tmpDir); store.init();
    const loop = new SkillImprovementLoop({ sqliteStore: store });
    loop.recordLearning({ skillId: 'ctx-skill', tips: 'Tip one' });
    loop.recordLearning({ skillId: 'ctx-skill', tips: 'Tip two' });
    const ctx = loop.getTipsForContext('ctx-skill');
    assert.ok(ctx.includes('Tip one'));
    loop.shutdown(); store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should suggest improvement after threshold', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const SkillImprovementLoop = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-improvement-loop'));
    const store = new SqliteStore(tmpDir); store.init();
    const loop = new SkillImprovementLoop({ sqliteStore: store, skillRouter: null });
    for (let i = 0; i < 4; i++) {
      loop.recordLearning({ skillId: 'auto-improve', tips: 'Tip ' + i, whatFailed: 'Fail ' + i });
    }
    const patches = loop.getPendingPatches();
    assert.ok(patches['auto-improve']);
    loop.shutdown(); store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should reject patch', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const SkillImprovementLoop = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-improvement-loop'));
    const store = new SqliteStore(tmpDir); store.init();
    const loop = new SkillImprovementLoop({ sqliteStore: store, skillRouter: null });
    for (let i = 0; i < 4; i++) {
      loop.recordLearning({ skillId: 'reject-skill', tips: 'Tip ' + i });
    }
    loop.rejectPatch('reject-skill');
    const patches = loop.getPendingPatches();
    assert.ok(!patches['reject-skill']);
    loop.shutdown(); store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('MemoryNudge', () => {
  it('should trigger on complex task', async () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const MemoryNudge = require(path.join(ROOT, 'src', 'runtime', 'thought', 'memory-nudge'));
    const store = new SqliteStore(tmpDir); store.init();
    const nudge = new MemoryNudge({ sqliteStore: store });
    const result = await nudge.evaluate({ toolCalls: 6, type: 'skill-complete', skillId: 'complex-task' });
    assert.ok(result);
    assert.equal(result.rule.id, 'complex-task');
    assert.ok(result.saved);
    nudge.shutdown(); store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should trigger on error recovery', async () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const MemoryNudge = require(path.join(ROOT, 'src', 'runtime', 'thought', 'memory-nudge'));
    const store = new SqliteStore(tmpDir); store.init();
    const nudge = new MemoryNudge({ sqliteStore: store });
    const result = await nudge.evaluate({ hadError: true, recovered: true, type: 'skill-complete' });
    assert.ok(result);
    assert.equal(result.rule.id, 'error-recovery');
    nudge.shutdown(); store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should skip simple tasks', async () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const MemoryNudge = require(path.join(ROOT, 'src', 'runtime', 'thought', 'memory-nudge'));
    const store = new SqliteStore(tmpDir); store.init();
    const nudge = new MemoryNudge({ sqliteStore: store });
    const result = await nudge.evaluate({ toolCalls: 2, type: 'skill-complete' });
    assert.equal(result, null);
    nudge.shutdown(); store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return stats', () => {
    const MemoryNudge = require(path.join(ROOT, 'src', 'runtime', 'thought', 'memory-nudge'));
    const nudge = new MemoryNudge();
    const stats = nudge.getStats();
    assert.ok(typeof stats.rules === 'number');
    assert.ok(stats.rules >= 6);
    nudge.shutdown();
  });
});

describe('SkillCreationEngine', () => {
  it('should evaluate complex task as creatable', () => {
    const tmpDir = createTempDir();
    const SkillCreationEngine = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-creation-engine'));
    const engine = new SkillCreationEngine({ projectRoot: tmpDir });
    const result = engine.evaluateTask({ toolCalls: 6, description: 'Deploy to Kubernetes' });
    assert.ok(result.shouldCreate);
    engine.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should reject simple tasks', () => {
    const tmpDir = createTempDir();
    const SkillCreationEngine = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-creation-engine'));
    const engine = new SkillCreationEngine({ projectRoot: tmpDir });
    const result = engine.evaluateTask({ toolCalls: 2, description: 'Simple task' });
    assert.ok(!result.shouldCreate);
    engine.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create skill file', async () => {
    const tmpDir = createTempDir();
    const SkillCreationEngine = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-creation-engine'));
    const engine = new SkillCreationEngine({ projectRoot: tmpDir });
    const evaluation = engine.evaluateTask({ toolCalls: 6, description: 'Setup CI pipeline', steps: ['Create config', 'Add workflow'] });
    const result = await engine.createSkill(evaluation);
    assert.ok(result.success);
    assert.ok(fs.existsSync(result.skillPath));
    engine.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should list and delete auto-created skills', async () => {
    const tmpDir = createTempDir();
    const SkillCreationEngine = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-creation-engine'));
    const engine = new SkillCreationEngine({ projectRoot: tmpDir });
    const evaluation = engine.evaluateTask({ toolCalls: 6, description: 'Build Docker image' });
    const created = await engine.createSkill(evaluation);
    const list = await engine.listAutoCreatedSkills();
    assert.ok(list.length >= 1);
    const deleted = await engine.deleteAutoCreatedSkill(created.skillName);
    assert.ok(deleted);
    engine.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('SkillCurator', () => {
  it('should record usage', () => {
    const SkillCurator = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-curator'));
    const curator = new SkillCurator();
    curator.recordUsage('test-skill', { success: true, duration: 100 });
    curator.recordUsage('test-skill', { success: false, duration: 200 });
    const stats = curator.getSkillStats('test-skill');
    assert.ok(stats);
    assert.equal(stats.calls, 2);
    assert.equal(stats.successes, 1);
    curator.shutdown();
  });

  it('should return all stats', () => {
    const SkillCurator = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-curator'));
    const curator = new SkillCurator();
    curator.recordUsage('skill-a', { success: true });
    const stats = curator.getAllStats();
    assert.ok(stats.skillStats['skill-a']);
    curator.shutdown();
  });
});

describe('UserModelManager', () => {
  it('should set and get preferences', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const UserModelManager = require(path.join(ROOT, 'src', 'runtime', 'user', 'user-model-manager'));
    const store = new SqliteStore(tmpDir); store.init();
    const um = new UserModelManager({ sqliteStore: store });
    um.setPreference('language', 'TypeScript');
    assert.equal(um.getPreference('language'), 'TypeScript');
    um.shutdown(); store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should learn from interaction', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const UserModelManager = require(path.join(ROOT, 'src', 'runtime', 'user', 'user-model-manager'));
    const store = new SqliteStore(tmpDir); store.init();
    const um = new UserModelManager({ sqliteStore: store });
    um.learnFromInteraction({ correction: 'Do not use var', languageChoice: 'TypeScript', commStyle: 'concise' });
    const prefs = um.getAllPreferences();
    assert.ok(prefs.petPeeves.includes('Do not use var'));
    um.shutdown(); store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should build injection prompt', () => {
    const tmpDir = createTempDir();
    const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));
    const UserModelManager = require(path.join(ROOT, 'src', 'runtime', 'user', 'user-model-manager'));
    const store = new SqliteStore(tmpDir); store.init();
    const um = new UserModelManager({ sqliteStore: store });
    um.setPreference('name', 'Alice');
    const prompt = um.buildInjectionPrompt();
    assert.ok(prompt.includes('Alice'));
    assert.ok(prompt.includes('USER PROFILE'));
    um.shutdown(); store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('MCPClient', () => {
  it('should create instance', () => {
    const MCPClient = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-client'));
    const client = new MCPClient();
    assert.ok(client);
    client.shutdown();
  });

  it('should add and remove servers', () => {
    const MCPClient = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-client'));
    const client = new MCPClient();
    client.addServer('test', { command: 'npm', args: ['--version'] });
    client.removeServer('test');
    client.shutdown();
  });

  it('should return empty tools when not connected', () => {
    const MCPClient = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-client'));
    const client = new MCPClient();
    const tools = client.getAvailableTools();
    assert.ok(Array.isArray(tools));
    assert.equal(tools.length, 0);
    client.shutdown();
  });

  it('should return stats', () => {
    const MCPClient = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-client'));
    const client = new MCPClient();
    const stats = client.getStats();
    assert.equal(stats.serverCount, 0);
    client.shutdown();
  });
});
