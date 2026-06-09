'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-test-'));

describe('ProgrammableHookExecutor - Injection', () => {
  let ProgrammableHookExecutor;
  const _cleanup = [];

  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness'), { recursive: true });
    ProgrammableHookExecutor = require('../../src/runtime/workflow/programmable-hook-executor');
  });

  afterEach(() => {
    for (const obj of _cleanup) {
      try { obj.shutdown(); } catch (_) { /* ignore */ }
    }
    _cleanup.length = 0;
  });

  after(() => {
    for (const obj of _cleanup) {
      try { obj.shutdown(); } catch (_) { /* ignore */ }
    }
    _cleanup.length = 0;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('builtin inject_core_identity', () => {
    it('should inject core identity with framework info', async () => {
      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      executor.register('session_start', { type: 'builtin', name: 'inject_core_identity' });

      const results = await executor.execute('session_start', { project_root: TEST_DIR });
      assert.ok(results.length >= 1);
      assert.ok(results[0].passed);
      assert.ok(results[0].injection);
      assert.equal(results[0].injection.type, 'core_identity');
      assert.ok(results[0].injection.identity);
      assert.ok(Array.isArray(results[0].injection.identity.principles));
      assert.ok(results[0].injection.identity.principles.length >= 6);
      assert.ok(Array.isArray(results[0].injection.identity.agentRoles));
      assert.ok(Array.isArray(results[0].injection.identity.phases));
    });

    it('should read project name from config', async () => {
      const configPath = path.join(TEST_DIR, '.harness', 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ project_name: 'TestProject', project_version: '1.0.0' }));

      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      executor.register('session_start', { type: 'builtin', name: 'inject_core_identity' });

      const results = await executor.execute('session_start', { project_root: TEST_DIR });
      assert.ok(results[0].injection.project.name === 'TestProject');
      assert.ok(results[0].injection.project.version === '1.0.0');

      fs.unlinkSync(configPath);
    });
  });

  describe('builtin inject_skill_router', () => {
    it('should inject skill router with discovered skills', async () => {
      const skillsDir = path.join(TEST_DIR, '.harness', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'test-skill.md'), [
        '---',
        'skill_id: test-skill',
        'name: Test Skill',
        'phase: module-development',
        'trigger: test',
        'auto_trigger: true',
        '---',
        '# Test Skill Content',
      ].join('\n'));

      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      executor.register('session_start', { type: 'builtin', name: 'inject_skill_router' });

      const results = await executor.execute('session_start', { project_root: TEST_DIR });
      assert.ok(results[0].passed);
      assert.ok(results[0].injection);
      assert.equal(results[0].injection.type, 'skill_router');
      assert.ok(Array.isArray(results[0].injection.skills));
      assert.ok(results[0].injection.skills.some(s => s.id === 'test-skill'));
      assert.ok(results[0].injection.routing);
      assert.ok(results[0].injection.routing.slashCommands);

      fs.rmSync(skillsDir, { recursive: true, force: true });
    });

    it('should handle missing skills directory gracefully', async () => {
      const emptyDir = path.join(os.tmpdir(), 'harness-hook-empty-' + Date.now());
      fs.mkdirSync(emptyDir, { recursive: true });

      const executor = new ProgrammableHookExecutor(emptyDir);
      _cleanup.push(executor);
      executor.register('session_start', { type: 'builtin', name: 'inject_skill_router' });

      const results = await executor.execute('session_start', { project_root: emptyDir });
      assert.ok(results[0].passed);
      assert.equal(results[0].injection.skills.length, 0);

      fs.rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe('builtin load_current_phase_context', () => {
    it('should load phase context from session files', async () => {
      const sessionsDir = path.join(TEST_DIR, '.harness', 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, 'test-session.json'), JSON.stringify({
        id: 'test-session',
        currentPhase: 'architecture-design',
        completedSkills: ['brainstorming', 'requirement-analysis'],
        tokensUsed: 5000,
        status: 'active',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        agentHistory: [{ agent: 'domain-analyst', action: 'design', timestamp: new Date().toISOString() }],
      }));

      const configPath = path.join(TEST_DIR, '.harness', 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ project_name: 'CtxTest', token_budget: 100000 }));

      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      executor.register('session_start', { type: 'builtin', name: 'load_current_phase_context' });

      const results = await executor.execute('session_start', { project_root: TEST_DIR });
      assert.ok(results[0].passed);
      assert.ok(results[0].injection);
      assert.equal(results[0].injection.type, 'phase_context');
      assert.equal(results[0].injection.context.currentPhase, 'architecture-design');
      assert.deepEqual(results[0].injection.context.completedSkills, ['brainstorming', 'requirement-analysis']);
      assert.equal(results[0].injection.context.activeAgent, 'domain-analyst');
      assert.equal(results[0].injection.context.tokenUsage.used, 5000);

      fs.rmSync(sessionsDir, { recursive: true, force: true });
      fs.unlinkSync(configPath);
    });

    it('should use defaults when no session exists', async () => {
      const emptyDir = path.join(os.tmpdir(), 'harness-phase-empty-' + Date.now());
      fs.mkdirSync(path.join(emptyDir, '.harness'), { recursive: true });

      const executor = new ProgrammableHookExecutor(emptyDir);
      _cleanup.push(executor);
      executor.register('session_start', { type: 'builtin', name: 'load_current_phase_context' });

      const results = await executor.execute('session_start', { project_root: emptyDir });
      assert.ok(results[0].passed);
      assert.equal(results[0].injection.context.currentPhase, 'brainstorming');
      assert.equal(results[0].injection.context.completedSkills.length, 0);

      fs.rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe('loadFromConfig() with session_start hooks', () => {
    it('should register session_start builtin hooks from config', async () => {
      const configPath = path.join(TEST_DIR, '.harness', 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        hooks: {
          session_start: {
            enabled: true,
            actions: ['inject_core_identity', 'inject_skill_router', 'load_current_phase_context'],
          },
        },
      }));

      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      executor.loadFromConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')));

      const hooks = executor.getRegisteredHooks('session_start');
      assert.equal(hooks.length, 3);
      assert.ok(hooks.every(h => h.type === 'builtin'));

      fs.unlinkSync(configPath);
    });
  });
});
