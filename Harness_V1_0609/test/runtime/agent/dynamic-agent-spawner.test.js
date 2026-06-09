'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  DynamicAgentSpawner,
  SPAWN_MODES,
  AGENT_TEMPLATES,
} = require('../../../src/runtime/agent/dynamic-agent-spawner');

const ORIGINAL_TEMPLATE_KEYS = new Set(Object.keys(AGENT_TEMPLATES));

function createSpawner(config) {
  return new DynamicAgentSpawner({}, config);
}

function cleanupCustomTemplates() {
  for (const key of Object.keys(AGENT_TEMPLATES)) {
    if (!ORIGINAL_TEMPLATE_KEYS.has(key)) {
      delete AGENT_TEMPLATES[key];
    }
  }
}

describe('DynamicAgentSpawner - constructor and spawnFromTask', () => {
  let spawner;

  beforeEach(() => {
    spawner = createSpawner();
  });

  afterEach(() => {
    try { spawner.shutdown(); } catch (_e) { /* best effort */ }
    cleanupCustomTemplates();
  });

  describe('constructor', () => {
    it('should create an instance with default config', () => {
      const s = createSpawner();
      assert.ok(s);
      assert.equal(typeof s.spawnFromTask, 'function');
      assert.equal(typeof s.completeAgent, 'function');
      assert.equal(typeof s.failAgent, 'function');
      assert.equal(typeof s.getSpawnedAgent, 'function');
      assert.equal(typeof s.listSpawnedAgents, 'function');
      assert.equal(typeof s.registerTemplate, 'function');
      assert.equal(typeof s.getStats, 'function');
      assert.equal(typeof s.shutdown, 'function');
      try { s.shutdown(); } catch (_e) { /* best effort */ }
    });

    it('should merge custom config with defaults', () => {
      const s = createSpawner({ maxSpawnedAgents: 5 });
      const stats = s.getStats();
      assert.equal(stats.activeAgents, 0);
      try { s.shutdown(); } catch (_e) { /* best effort */ }
    });

    it('should initialize stats to zero', () => {
      const stats = spawner.getStats();
      assert.equal(stats.totalSpawned, 0);
      assert.equal(stats.totalCompleted, 0);
      assert.equal(stats.totalFailed, 0);
      assert.equal(stats.activeAgents, 0);
    });
  });

  describe('spawnFromTask - basic', () => {
    it('should spawn an agent from a task description', () => {
      const info = spawner.spawnFromTask('review the code for security issues');
      assert.ok(info);
      assert.ok(info.agentId);
      assert.equal(info.status, 'spawned');
      assert.equal(info.templateKey, 'code_reviewer');
      assert.equal(info.role, 'code-reviewer');
      assert.equal(info.spawnMode, SPAWN_MODES.WORKER);
    });

    it('should throw if taskDescription is empty', () => {
      assert.throws(() => spawner.spawnFromTask(''), /non-empty string/);
    });

    it('should throw if taskDescription is not a string', () => {
      assert.throws(() => spawner.spawnFromTask(123), /non-empty string/);
      assert.throws(() => spawner.spawnFromTask(null), /non-empty string/);
      assert.throws(() => spawner.spawnFromTask(undefined), /non-empty string/);
    });

    it('should match test_runner template for test-related tasks', () => {
      const info = spawner.spawnFromTask('run the test suite and check coverage');
      assert.equal(info.templateKey, 'test_runner');
      assert.equal(info.role, 'test-runner');
    });

    it('should match doc_writer template for documentation tasks', () => {
      const info = spawner.spawnFromTask('write documentation for the API');
      assert.equal(info.templateKey, 'doc_writer');
      assert.equal(info.role, 'doc-writer');
    });

    it('should match debugger template for debug tasks', () => {
      const info = spawner.spawnFromTask('debug the crash in module X');
      assert.equal(info.templateKey, 'debugger');
      assert.equal(info.role, 'debugger');
    });

    it('should match researcher template for research tasks', () => {
      const info = spawner.spawnFromTask('research the best approach for caching');
      assert.equal(info.templateKey, 'researcher');
      assert.equal(info.role, 'researcher');
    });

    it('should match deployer template for deployment tasks', () => {
      const info = spawner.spawnFromTask('deploy to production');
      assert.equal(info.templateKey, 'deployer');
      assert.equal(info.role, 'deployer');
    });

    it('should fallback to researcher template for unknown task descriptions', () => {
      const info = spawner.spawnFromTask('something completely unrelated xyz');
      assert.equal(info.templateKey, 'researcher');
      assert.equal(info.role, 'researcher');
    });
  });

  describe('spawnFromTask - options and limits', () => {
    it('should use default spawn mode (worker) when no options provided', () => {
      const info = spawner.spawnFromTask('review code');
      assert.equal(info.spawnMode, SPAWN_MODES.WORKER);
    });

    it('should use team spawn mode when specified', () => {
      const info = spawner.spawnFromTask('review code', { spawnMode: SPAWN_MODES.TEAM });
      assert.equal(info.spawnMode, SPAWN_MODES.TEAM);
    });

    it('should use custom agentId when provided', () => {
      const info = spawner.spawnFromTask('review code', { agentId: 'my-custom-id' });
      assert.equal(info.agentId, 'my-custom-id');
    });

    it('should set worker mode config: isolatedContext and returnSummary', () => {
      const info = spawner.spawnFromTask('review code', { spawnMode: SPAWN_MODES.WORKER });
      assert.equal(info.config.isolatedContext, true);
      assert.equal(info.config.returnSummary, true);
      assert.equal(info.config.persistent, undefined);
    });

    it('should set team mode config: shared context and persistent', () => {
      const info = spawner.spawnFromTask('review code', { spawnMode: SPAWN_MODES.TEAM });
      assert.equal(info.config.isolatedContext, false);
      assert.equal(info.config.returnSummary, false);
      assert.equal(info.config.persistent, true);
    });

    it('should respect custom modelTier option', () => {
      const info = spawner.spawnFromTask('review code', { modelTier: 'large' });
      assert.equal(info.config.modelTier, 'large');
    });

    it('should respect custom maxTokens option', () => {
      const info = spawner.spawnFromTask('review code', { maxTokens: 99999 });
      assert.equal(info.config.maxTokens, 99999);
    });

    it('should respect custom timeout option', () => {
      const info = spawner.spawnFromTask('review code', { timeout: 60000 });
      assert.equal(info.config.timeout, 60000);
    });

    it('should throw when max spawned agents limit is reached', () => {
      const s = createSpawner({ maxSpawnedAgents: 2 });
      s.spawnFromTask('review code');
      s.spawnFromTask('run tests');
      assert.throws(() => s.spawnFromTask('deploy'), /Maximum spawned agents reached/);
      try { s.shutdown(); } catch (_e) { /* best effort */ }
    });

    it('should emit spawn-limit-reached event when limit is hit', () => {
      const s = createSpawner({ maxSpawnedAgents: 1 });
      s.spawnFromTask('review code');
      let eventFired = false;
      s.on('spawn-limit-reached', () => { eventFired = true; });
      assert.throws(() => s.spawnFromTask('run tests'));
      assert.equal(eventFired, true);
      try { s.shutdown(); } catch (_e) { /* best effort */ }
    });

    it('should increment stats on spawn', () => {
      spawner.spawnFromTask('review code');
      spawner.spawnFromTask('run tests');
      const stats = spawner.getStats();
      assert.equal(stats.totalSpawned, 2);
      assert.equal(stats.activeAgents, 2);
    });

    it('should track stats by mode', () => {
      spawner.spawnFromTask('review code', { spawnMode: SPAWN_MODES.WORKER });
      spawner.spawnFromTask('run tests', { spawnMode: SPAWN_MODES.TEAM });
      const stats = spawner.getStats();
      assert.equal(stats.byMode.worker, 1);
      assert.equal(stats.byMode.team, 1);
    });

    it('should track stats by template', () => {
      spawner.spawnFromTask('review code');
      spawner.spawnFromTask('review more code');
      spawner.spawnFromTask('run tests');
      const stats = spawner.getStats();
      assert.equal(stats.byTemplate.code_reviewer, 2);
      assert.equal(stats.byTemplate.test_runner, 1);
    });

    it('should truncate taskDescription in emitted event to 100 chars', () => {
      const longTask = 'a'.repeat(200);
      let emittedDesc = '';
      spawner.on('agent-spawned', (data) => { emittedDesc = data.taskDescription; });
      spawner.spawnFromTask(longTask);
      assert.equal(emittedDesc.length, 100);
      assert.equal(emittedDesc, 'a'.repeat(100));
    });
  });
});

describe('DynamicAgentSpawner - complete, fail, get, list', () => {
  let spawner;

  beforeEach(() => {
    spawner = createSpawner();
  });

  afterEach(() => {
    try { spawner.shutdown(); } catch (_e) { /* best effort */ }
    cleanupCustomTemplates();
  });

  describe('completeAgent', () => {
    it('should mark an agent as completed', () => {
      const info = spawner.spawnFromTask('review code');
      const result = spawner.completeAgent(info.agentId, { summary: 'LGTM' });
      assert.equal(result, true);
      const agent = spawner.getSpawnedAgent(info.agentId);
      assert.equal(agent.status, 'completed');
      assert.ok(agent.completedAt);
      assert.deepEqual(agent.result, { summary: 'LGTM' });
    });

    it('should return false for unknown agent', () => {
      const result = spawner.completeAgent('non-existent-id');
      assert.equal(result, false);
    });

    it('should increment totalCompleted stats', () => {
      const info = spawner.spawnFromTask('review code');
      spawner.completeAgent(info.agentId, 'done');
      const stats = spawner.getStats();
      assert.equal(stats.totalCompleted, 1);
    });

    it('should not increment totalCompleted for unknown agent', () => {
      spawner.completeAgent('non-existent-id');
      const stats = spawner.getStats();
      assert.equal(stats.totalCompleted, 0);
    });
  });

  describe('failAgent', () => {
    it('should mark an agent as failed', () => {
      const info = spawner.spawnFromTask('review code');
      const result = spawner.failAgent(info.agentId, new Error('timeout'));
      assert.equal(result, true);
      const agent = spawner.getSpawnedAgent(info.agentId);
      assert.equal(agent.status, 'failed');
      assert.ok(agent.failedAt);
      assert.ok(agent.error);
    });

    it('should return false for unknown agent', () => {
      const result = spawner.failAgent('non-existent-id', new Error('fail'));
      assert.equal(result, false);
    });

    it('should increment totalFailed stats', () => {
      const info = spawner.spawnFromTask('review code');
      spawner.failAgent(info.agentId, 'crash');
      const stats = spawner.getStats();
      assert.equal(stats.totalFailed, 1);
    });

    it('should not increment totalFailed for unknown agent', () => {
      spawner.failAgent('non-existent-id', 'crash');
      const stats = spawner.getStats();
      assert.equal(stats.totalFailed, 0);
    });
  });

  describe('getSpawnedAgent', () => {
    it('should return agent info for a spawned agent', () => {
      const info = spawner.spawnFromTask('review code');
      const retrieved = spawner.getSpawnedAgent(info.agentId);
      assert.ok(retrieved);
      assert.equal(retrieved.agentId, info.agentId);
      assert.equal(retrieved.role, info.role);
    });

    it('should return null for unknown agent', () => {
      assert.equal(spawner.getSpawnedAgent('non-existent'), null);
    });

    it('should return null after shutdown', () => {
      const info = spawner.spawnFromTask('review code');
      spawner.shutdown();
      assert.equal(spawner.getSpawnedAgent(info.agentId), null);
    });
  });

  describe('listSpawnedAgents', () => {
    it('should return empty array when no agents spawned', () => {
      const list = spawner.listSpawnedAgents();
      assert.deepEqual(list, []);
    });

    it('should list all spawned agents', () => {
      spawner.spawnFromTask('review code', { agentId: 'agent-1' });
      spawner.spawnFromTask('run tests', { agentId: 'agent-2' });
      const list = spawner.listSpawnedAgents();
      assert.equal(list.length, 2);
      const ids = list.map((a) => a.agentId);
      assert.ok(ids.includes('agent-1'));
      assert.ok(ids.includes('agent-2'));
    });

    it('should include role, spawnMode, status, and spawnedAt in listing', () => {
      spawner.spawnFromTask('review code', { agentId: 'agent-1' });
      const list = spawner.listSpawnedAgents();
      assert.equal(list[0].role, 'code-reviewer');
      assert.equal(list[0].spawnMode, SPAWN_MODES.WORKER);
      assert.equal(list[0].status, 'spawned');
      assert.ok(list[0].spawnedAt);
    });

    it('should return empty array after shutdown', () => {
      spawner.spawnFromTask('review code');
      spawner.shutdown();
      assert.deepEqual(spawner.listSpawnedAgents(), []);
    });
  });
});

describe('DynamicAgentSpawner - registerTemplate, stats, shutdown, events, constants', () => {
  let spawner;

  beforeEach(() => {
    spawner = createSpawner();
  });

  afterEach(() => {
    try { spawner.shutdown(); } catch (_e) { /* best effort */ }
    cleanupCustomTemplates();
  });

  describe('registerTemplate', () => {
    it('should register a custom template', () => {
      spawner.registerTemplate('custom_agent', {
        role: 'custom-role',
        capabilities: ['custom-cap'],
        modelTier: 'small',
        maxTokens: 20000,
      });
      assert.ok(AGENT_TEMPLATES.custom_agent);
      assert.equal(AGENT_TEMPLATES.custom_agent.role, 'custom-role');
    });

    it('should throw if templateKey is empty', () => {
      assert.throws(() => spawner.registerTemplate('', { role: 'x' }), /non-empty string/);
    });

    it('should throw if templateKey is not a string', () => {
      assert.throws(() => spawner.registerTemplate(123, { role: 'x' }), /non-empty string/);
    });

    it('should throw if template has no role', () => {
      assert.throws(() => spawner.registerTemplate('no_role', { capabilities: ['x'] }), /must have a role/);
    });

    it('should fill default values for missing template fields', () => {
      spawner.registerTemplate('minimal', { role: 'minimal-role' });
      const tpl = AGENT_TEMPLATES.minimal;
      assert.equal(tpl.role, 'minimal-role');
      assert.deepEqual(tpl.capabilities, []);
      assert.equal(tpl.modelTier, 'medium');
      assert.equal(tpl.maxTokens, 50000);
      assert.equal(tpl.triggerMode, 'fire_and_forget');
      assert.equal(tpl.description, '');
    });

    it('should allow overriding an existing template (duplicate registration)', () => {
      const originalRole = AGENT_TEMPLATES.code_reviewer.role;
      spawner.registerTemplate('code_reviewer', { role: 'overridden-reviewer' });
      assert.equal(AGENT_TEMPLATES.code_reviewer.role, 'overridden-reviewer');
      AGENT_TEMPLATES.code_reviewer.role = originalRole;
    });
  });

  describe('getStats', () => {
    it('should return stats with activeAgents count', () => {
      spawner.spawnFromTask('review code');
      spawner.spawnFromTask('run tests');
      const stats = spawner.getStats();
      assert.equal(stats.totalSpawned, 2);
      assert.equal(stats.activeAgents, 2);
    });

    it('should return zeroed stats after shutdown', () => {
      spawner.spawnFromTask('review code');
      spawner.shutdown();
      const stats = spawner.getStats();
      assert.equal(stats.totalSpawned, 0);
      assert.equal(stats.totalCompleted, 0);
      assert.equal(stats.totalFailed, 0);
      assert.deepEqual(stats.byTemplate, {});
      assert.deepEqual(stats.byMode, {});
    });
  });

  describe('shutdown', () => {
    it('should clear spawned agents on shutdown', () => {
      spawner.spawnFromTask('review code');
      spawner.spawnFromTask('run tests');
      spawner.shutdown();
      assert.deepEqual(spawner.listSpawnedAgents(), []);
    });

    it('should prevent spawning after shutdown', () => {
      spawner.shutdown();
      assert.throws(() => spawner.spawnFromTask('review code'), /shut down/);
    });

    it('should prevent completing agents after shutdown', () => {
      const info = spawner.spawnFromTask('review code');
      spawner.shutdown();
      assert.throws(() => spawner.completeAgent(info.agentId, 'done'), /shut down/);
    });

    it('should prevent failing agents after shutdown', () => {
      const info = spawner.spawnFromTask('review code');
      spawner.shutdown();
      assert.throws(() => spawner.failAgent(info.agentId, new Error('x')), /shut down/);
    });

    it('should prevent registering templates after shutdown', () => {
      spawner.shutdown();
      assert.throws(() => spawner.registerTemplate('x', { role: 'y' }), /shut down/);
    });

    it('should remove all listeners on shutdown', () => {
      spawner.on('test-event', () => {});
      spawner.shutdown();
      assert.equal(spawner.listenerCount('test-event'), 0);
    });

    it('should be safe to call shutdown multiple times', () => {
      spawner.shutdown();
      spawner.shutdown();
    });
  });

  describe('event emissions', () => {
    it('should emit agent-spawned event', () => {
      let eventData = null;
      spawner.on('agent-spawned', (data) => { eventData = data; });
      spawner.spawnFromTask('review code');
      assert.ok(eventData);
      assert.ok(eventData.agentId);
      assert.equal(eventData.role, 'code-reviewer');
      assert.equal(eventData.spawnMode, SPAWN_MODES.WORKER);
      assert.ok(eventData.taskDescription);
    });

    it('should emit agent-completed event', () => {
      let eventData = null;
      spawner.on('agent-completed', (data) => { eventData = data; });
      const info = spawner.spawnFromTask('review code');
      spawner.completeAgent(info.agentId, 'done');
      assert.ok(eventData);
      assert.equal(eventData.agentId, info.agentId);
      assert.equal(eventData.role, 'code-reviewer');
    });

    it('should emit agent-failed event', () => {
      let eventData = null;
      spawner.on('agent-failed', (data) => { eventData = data; });
      const info = spawner.spawnFromTask('review code');
      spawner.failAgent(info.agentId, new Error('crash'));
      assert.ok(eventData);
      assert.equal(eventData.agentId, info.agentId);
      assert.equal(eventData.role, 'code-reviewer');
      assert.ok(eventData.error);
    });

    it('should emit template-registered event', () => {
      let eventData = null;
      spawner.on('template-registered', (data) => { eventData = data; });
      spawner.registerTemplate('my_template', { role: 'my-role' });
      assert.ok(eventData);
      assert.equal(eventData.templateKey, 'my_template');
      assert.equal(eventData.role, 'my-role');
    });

    it('should not emit agent-completed for unknown agent', () => {
      let fired = false;
      spawner.on('agent-completed', () => { fired = true; });
      spawner.completeAgent('non-existent');
      assert.equal(fired, false);
    });

    it('should not emit agent-failed for unknown agent', () => {
      let fired = false;
      spawner.on('agent-failed', () => { fired = true; });
      spawner.failAgent('non-existent', 'err');
      assert.equal(fired, false);
    });
  });

  describe('exported constants', () => {
    it('should export SPAWN_MODES with WORKER and TEAM', () => {
      assert.ok(SPAWN_MODES);
      assert.equal(SPAWN_MODES.WORKER, 'worker');
      assert.equal(SPAWN_MODES.TEAM, 'team');
    });

    it('should export AGENT_TEMPLATES with built-in templates', () => {
      assert.ok(AGENT_TEMPLATES);
      assert.ok(AGENT_TEMPLATES.code_reviewer);
      assert.ok(AGENT_TEMPLATES.test_runner);
      assert.ok(AGENT_TEMPLATES.doc_writer);
      assert.ok(AGENT_TEMPLATES.debugger);
      assert.ok(AGENT_TEMPLATES.researcher);
      assert.ok(AGENT_TEMPLATES.deployer);
    });

    it('should have required fields in each built-in template', () => {
      const requiredFields = ['role', 'capabilities', 'modelTier', 'maxTokens', 'triggerMode', 'description'];
      for (const [key, tpl] of Object.entries(AGENT_TEMPLATES)) {
        if (!ORIGINAL_TEMPLATE_KEYS.has(key)) continue;
        for (const field of requiredFields) {
          assert.ok(tpl[field] !== undefined, 'Template ' + key + ' missing field ' + field);
        }
      }
    });
  });
});
