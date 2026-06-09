'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..', '..');
const SkillEvolver = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-evolver'));

const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  }
});

function createTempProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-test-'));
  fs.mkdirSync(path.join(dir, '.harness', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'skills', '.backups'), { recursive: true });
  const skillContent = '---\nname: test-skill\nphase: module-development\n---\n# Test Skill\n\nOriginal body.\n';
  fs.writeFileSync(path.join(dir, '.harness', 'skills', 'test-skill.md'), skillContent);
  TEMP_DIRS.push(dir);
  return dir;
}

function createMockLlmClient(responses) {
  const calls = [];
  const resp = responses || [
    { content: JSON.stringify({ patterns: ['success-pattern'], failures: ['failure-pattern'] }) },
    { content: JSON.stringify({ invariants: ['keep-structure'], modificationTargets: ['improve-logging'] }) },
    { content: JSON.stringify({ refinedBody: 'Refined skill body content', newSkills: [] }) },
  ];
  let idx = 0;
  return {
    calls,
    chat: async (prompt) => {
      calls.push(prompt);
      const r = resp[idx % resp.length];
      idx++;
      return r;
    },
  };
}

function createMockTokenManager(remaining, total) {
  return {
    getBudgetStatus: () => ({ remaining: remaining ?? 1000000, used: 100000, total: total ?? 1100000 }),
  };
}

function createMockSkillRouter(projectRoot) {
  const skillPath = path.join(projectRoot, '.harness', 'skills', 'test-skill.md');
  return {
    registry: {
      'test-skill': { _filePath: skillPath, skill_id: 'test-skill', name: 'test-skill' },
    },
    discoverAsync: async () => {},
  };
}

function createMockPatchApproval() {
  const submitted = [];
  return {
    submitted,
    submit: (skillId, data) => {
      submitted.push({ skillId, data });
      return { success: true, patchId: 'patch-' + skillId };
    },
    getApprovedPatchForSkill: () => null,
    getPendingPatches: () => [],
    markApplied: () => {},
  };
}

describe('SkillEvolver constructor', () => {
  it('should create instance with default options', () => {
    const evolver = new SkillEvolver({});
    assert.ok(evolver);
    assert.equal(evolver._llmClient, null);
    assert.equal(evolver._tokenManager, null);
    assert.equal(evolver._patchApproval, null);
    assert.equal(evolver._sqliteStore, null);
    assert.equal(evolver._skillRouter, null);
    assert.equal(evolver._projectRoot, '');
  });

  it('should accept options', () => {
    const llm = createMockLlmClient();
    const tm = createMockTokenManager();
    const pa = createMockPatchApproval();
    const store = {};
    const router = {};
    const evolver = new SkillEvolver({
      llmClient: llm,
      tokenManager: tm,
      patchApproval: pa,
      sqliteStore: store,
      skillRouter: router,
      projectRoot: '/tmp/test',
    });
    assert.equal(evolver._llmClient, llm);
    assert.equal(evolver._tokenManager, tm);
    assert.equal(evolver._patchApproval, pa);
    assert.equal(evolver._sqliteStore, store);
    assert.equal(evolver._skillRouter, router);
    assert.equal(evolver._projectRoot, '/tmp/test');
  });
});

describe('SkillEvolver attachLlmClient', () => {
  it('should attach LLM client', () => {
    const evolver = new SkillEvolver({});
    const llm = createMockLlmClient();
    evolver.attachLlmClient(llm);
    assert.equal(evolver._llmClient, llm);
  });
});

describe('SkillEvolver attachTokenManager', () => {
  it('should attach token manager', () => {
    const evolver = new SkillEvolver({});
    const tm = createMockTokenManager();
    evolver.attachTokenManager(tm);
    assert.equal(evolver._tokenManager, tm);
  });
});

describe('SkillEvolver evolve guards', () => {
  it('should return error when shut down', async () => {
    const evolver = new SkillEvolver({});
    evolver.shutdown();
    const result = await evolver.evolve('test-skill', []);
    assert.equal(result.success, false);
    assert.ok(result.error.includes('shut down'));
  });

  it('should return error when no LLM client attached', async () => {
    const evolver = new SkillEvolver({});
    const result = await evolver.evolve('test-skill', []);
    assert.equal(result.success, false);
    assert.ok(result.error.includes('LLM'));
  });

  it('should return error when no skillRouter attached', async () => {
    const evolver = new SkillEvolver({});
    evolver.attachLlmClient(createMockLlmClient());
    const result = await evolver.evolve('test-skill', []);
    assert.equal(result.success, false);
    assert.ok(result.error.includes('skillRouter'));
  });

  it('should skip when token budget insufficient', async () => {
    const evolver = new SkillEvolver({});
    evolver.attachLlmClient(createMockLlmClient());
    evolver.attachSkillRouter(createMockSkillRouter(createTempProjectRoot()));
    evolver.attachTokenManager(createMockTokenManager(100, 1000000));
    const result = await evolver.evolve('test-skill', []);
    assert.equal(result.success, false);
    assert.ok(result.skipped);
  });
});

describe('SkillEvolver evolve success', () => {
  it('should call _summarize, _aggregate, _execute in sequence', async () => {
    const projectRoot = createTempProjectRoot();
    const llm = createMockLlmClient();
    const router = createMockSkillRouter(projectRoot);
    const evolver = new SkillEvolver({ projectRoot });
    evolver.attachLlmClient(llm);
    evolver.attachSkillRouter(router);
    const result = await evolver.evolve('test-skill', [{ action: 'test', outcome: 'pass' }]);
    assert.equal(result.success, true);
    assert.equal(llm.calls.length, 3);
  });

  it('should emit evolution-completed event on success', async () => {
    const projectRoot = createTempProjectRoot();
    const llm = createMockLlmClient();
    const router = createMockSkillRouter(projectRoot);
    const evolver = new SkillEvolver({ projectRoot });
    evolver.attachLlmClient(llm);
    evolver.attachSkillRouter(router);
    let emitted = null;
    evolver.on('evolution-completed', (data) => { emitted = data; });
    await evolver.evolve('test-skill', [{ action: 'test' }]);
    assert.ok(emitted);
    assert.equal(emitted.skillId, 'test-skill');
  });

  it('should submit patch to patchApproval when available', async () => {
    const projectRoot = createTempProjectRoot();
    const llm = createMockLlmClient();
    const router = createMockSkillRouter(projectRoot);
    const pa = createMockPatchApproval();
    const evolver = new SkillEvolver({ projectRoot, patchApproval: pa });
    evolver.attachLlmClient(llm);
    evolver.attachSkillRouter(router);
    await evolver.evolve('test-skill', [{ action: 'test' }]);
    assert.equal(pa.submitted.length, 1);
    assert.equal(pa.submitted[0].skillId, 'test-skill');
  });

  it('should store patch in _pendingEvolvedPatches when no patchApproval', async () => {
    const projectRoot = createTempProjectRoot();
    const llm = createMockLlmClient();
    const router = createMockSkillRouter(projectRoot);
    const evolver = new SkillEvolver({ projectRoot });
    evolver.attachLlmClient(llm);
    evolver.attachSkillRouter(router);
    await evolver.evolve('test-skill', [{ action: 'test' }]);
    const pending = evolver.getPendingEvolvedPatches();
    assert.ok(pending['test-skill']);
  });
});

describe('SkillEvolver _summarize', () => {
  it('should call LLM with session traces and return structured summary', async () => {
    const projectRoot = createTempProjectRoot();
    const llm = createMockLlmClient();
    const router = createMockSkillRouter(projectRoot);
    const evolver = new SkillEvolver({ projectRoot });
    evolver.attachLlmClient(llm);
    evolver.attachSkillRouter(router);
    const traces = [{ action: 'step1', outcome: 'success' }, { action: 'step2', outcome: 'failure' }];
    const summary = await evolver._summarize('test-skill', traces);
    assert.ok(summary);
    assert.equal(llm.calls.length, 1);
    assert.ok(llm.calls[0].includes('test-skill'));
  });
});

describe('SkillEvolver _aggregate', () => {
  it('should call LLM with summaries and return invariants + modification targets', async () => {
    const projectRoot = createTempProjectRoot();
    const llm = createMockLlmClient();
    const router = createMockSkillRouter(projectRoot);
    const evolver = new SkillEvolver({ projectRoot });
    evolver.attachLlmClient(llm);
    evolver.attachSkillRouter(router);
    const summary = { patterns: ['p1'], failures: ['f1'] };
    const aggregation = await evolver._aggregate('test-skill', summary);
    assert.ok(aggregation);
    assert.equal(llm.calls.length, 1);
  });
});

describe('SkillEvolver _execute', () => {
  it('should call LLM with aggregation and return refined skill body', async () => {
    const projectRoot = createTempProjectRoot();
    const llm = createMockLlmClient();
    const router = createMockSkillRouter(projectRoot);
    const evolver = new SkillEvolver({ projectRoot });
    evolver.attachLlmClient(llm);
    evolver.attachSkillRouter(router);
    const aggregation = { invariants: ['keep-structure'], modificationTargets: ['improve-logging'] };
    const result = await evolver._execute('test-skill', aggregation);
    assert.ok(result);
    assert.equal(llm.calls.length, 1);
  });
});

describe('SkillEvolver applyEvolvedPatch', () => {
  it('should apply approved patch to skill file', async () => {
    const projectRoot = createTempProjectRoot();
    const llm = createMockLlmClient();
    const router = createMockSkillRouter(projectRoot);
    const evolver = new SkillEvolver({ projectRoot });
    evolver.attachLlmClient(llm);
    evolver.attachSkillRouter(router);
    await evolver.evolve('test-skill', [{ action: 'test' }]);
    const result = await evolver.applyEvolvedPatch('test-skill', { skipApproval: true });
    assert.equal(result.success, true);
    const skillPath = path.join(projectRoot, '.harness', 'skills', 'test-skill.md');
    const content = fs.readFileSync(skillPath, 'utf-8');
    assert.ok(content.includes('<!-- evolution-section -->'));
  });
});

describe('SkillEvolver getPendingEvolvedPatches', () => {
  it('should return pending patches', async () => {
    const projectRoot = createTempProjectRoot();
    const llm = createMockLlmClient();
    const router = createMockSkillRouter(projectRoot);
    const evolver = new SkillEvolver({ projectRoot });
    evolver.attachLlmClient(llm);
    evolver.attachSkillRouter(router);
    await evolver.evolve('test-skill', [{ action: 'test' }]);
    const pending = evolver.getPendingEvolvedPatches();
    assert.ok(pending['test-skill']);
  });
});

describe('SkillEvolver getStats', () => {
  it('should return evolution statistics', async () => {
    const projectRoot = createTempProjectRoot();
    const llm = createMockLlmClient();
    const router = createMockSkillRouter(projectRoot);
    const evolver = new SkillEvolver({ projectRoot });
    evolver.attachLlmClient(llm);
    evolver.attachSkillRouter(router);
    await evolver.evolve('test-skill', [{ action: 'test' }]);
    const stats = evolver.getStats();
    assert.equal(stats.evolutions, 1);
    assert.ok(typeof stats.pendingPatches === 'number');
  });
});

describe('SkillEvolver isHealthy', () => {
  it('should return true when evolution count < 10000', () => {
    const evolver = new SkillEvolver({});
    assert.equal(evolver.isHealthy(), true);
  });

  it('should return false when evolution count >= 10000', () => {
    const evolver = new SkillEvolver({});
    evolver._stats.evolutions = 10000;
    assert.equal(evolver.isHealthy(), false);
  });
});

describe('SkillEvolver _onShutdown', () => {
  it('should clear pending patches', async () => {
    const projectRoot = createTempProjectRoot();
    const llm = createMockLlmClient();
    const router = createMockSkillRouter(projectRoot);
    const evolver = new SkillEvolver({ projectRoot });
    evolver.attachLlmClient(llm);
    evolver.attachSkillRouter(router);
    await evolver.evolve('test-skill', [{ action: 'test' }]);
    assert.ok(Object.keys(evolver._pendingEvolvedPatches).length > 0);
    evolver.shutdown();
    assert.equal(Object.keys(evolver._pendingEvolvedPatches).length, 0);
  });
});
