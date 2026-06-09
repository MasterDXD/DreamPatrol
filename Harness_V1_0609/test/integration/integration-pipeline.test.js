'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-integ-test-'));

describe('CommandRouter + Pipeline Integration', () => {
  let harness;

  before(async () => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace', 'staging'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace', 'shared'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace', 'locks'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'causal-wal'), { recursive: true });

    const config = {
      project_name: 'integration-test',
      version: '2.0.0',
      token_budget: 1000000,
      skill_registry: { auto_trigger_enabled: true, skills: [] },
      agent_permissions: {
        'team-lead': { allowed_tools: ['read_file', 'write_file', 'search_files', 'run_command', 'web_search'], restricted_operations: ['file_delete', 'system_command', 'modify_harness_config'], requires_confirmation: [] },
        'domain-analyst': { allowed_tools: ['read_file', 'write_file', 'search_files', 'run_command', 'web_search'], restricted_operations: ['file_delete', 'system_command', 'modify_harness_config'], requires_confirmation: [] },
        'task-worker': { allowed_tools: ['read_file', 'write_file', 'search_files', 'run_command'], restricted_operations: ['file_delete', 'modify_harness_config'], requires_confirmation: ['system_command'] },
        'quality-assurance': { allowed_tools: ['read_file', 'write_file', 'search_files', 'run_command', 'web_search'], restricted_operations: ['file_delete', 'system_command', 'modify_harness_config'], requires_confirmation: [] },
        'devops-engineer': { allowed_tools: ['read_file', 'write_file', 'search_files', 'run_command'], restricted_operations: ['file_delete', 'modify_harness_config'], requires_confirmation: ['system_command'] },
        'technical-writer': { allowed_tools: ['read_file', 'write_file', 'search_files'], restricted_operations: ['file_delete', 'system_command', 'modify_harness_config'], requires_confirmation: [] },
        'code-reviewer': { allowed_tools: ['read_file', 'search_files', 'run_command', 'web_search'], restricted_operations: ['write_file', 'file_delete', 'system_command', 'modify_harness_config'], requires_confirmation: [] },
        'security-reviewer': { allowed_tools: ['read_file', 'search_files', 'run_command', 'web_search'], restricted_operations: ['write_file', 'file_delete', 'system_command', 'modify_harness_config'], requires_confirmation: [] },
        'build-error-solver': { allowed_tools: ['read_file', 'write_file', 'search_files', 'run_command'], restricted_operations: ['file_delete', 'modify_harness_config'], requires_confirmation: ['system_command'] },
        'planner': { allowed_tools: ['read_file', 'write_file', 'search_files', 'web_search'], restricted_operations: ['file_delete', 'system_command', 'modify_harness_config'], requires_confirmation: [] },
        'test-writer': { allowed_tools: ['read_file', 'write_file', 'search_files', 'run_command'], restricted_operations: ['file_delete', 'modify_harness_config'], requires_confirmation: ['system_command'] },
      },
      hooks: {},
    };
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'config.json'), JSON.stringify(config, null, 2));

    const planCmd = `---
command_id: /plan
name: 实现规划
description: 规划项目实现方案
skills: [brainstorming, requirement-analysis, architecture-design]
agent: team-lead
phase: brainstorming
aliases: [/规划]
enforcement: recommended
---
# /plan`;
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'plan.md'), planCmd);

    const harnessModule = require('../../src/index');
    harness = harnessModule.create(TEST_DIR);
  });

  after(async () => {
    if (harness && harness.destroy) {
      try { await harness.destroy(); } catch (_) { /* ignore shutdown errors */ }
    }
    await new Promise(r => setTimeout(r, 500));
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) { /* ignore cleanup errors */ }
  });

  describe('CommandRouter in Pipeline', () => {
    it('should detect command in pipeline input', async () => {
      const result = await harness.executePipeline('/plan');
      assert.ok(result);
      assert.ok(result.command);
      assert.equal(result.command.commandId, '/plan');
      assert.equal(result.command.name, '实现规划');
    });

    it('should route command skills through pipeline', async () => {
      const result = await harness.executePipeline('/plan');
      assert.ok(result.matchedSkills !== undefined);
      assert.ok(Array.isArray(result.matchedSkills));
    });

    it('should not set command for non-command input', async () => {
      const result = await harness.executePipeline('帮我实现一个功能');
      assert.ok(result);
      assert.equal(result.command, null);
    });
  });

  describe('ProgrammableHookExecutor integration', () => {
    it('should be accessible from harness instance', () => {
      assert.ok(harness.programmableHookExecutor);
      assert.ok(typeof harness.programmableHookExecutor.register === 'function');
      assert.ok(typeof harness.programmableHookExecutor.execute === 'function');
    });

    it('should register and execute custom hooks', async () => {
      let hookCalled = false;
      harness.programmableHookExecutor.register('pre_file_write', {
        id: 'integ-test-hook',
        type: 'function',
        handler: () => {
          hookCalled = true;
          return { passed: true, message: 'Integration test hook' };
        },
      });

      const results = await harness.programmableHookExecutor.execute('pre_file_write', {
        file_path: path.join(TEST_DIR, 'test.js'),
      });

      assert.ok(hookCalled);
      assert.ok(results.some(r => r.id === 'integ-test-hook' && r.passed));

      harness.programmableHookExecutor.unregister('pre_file_write', 'integ-test-hook');
    });
  });

  describe('ContextCompressionEngine integration', () => {
    it('should be accessible from harness instance', () => {
      assert.ok(harness.contextCompressionEngine);
      assert.ok(typeof harness.contextCompressionEngine.compress === 'function');
      assert.ok(typeof harness.contextCompressionEngine.shouldCompress === 'function');
    });

    it('should compress context and return structured result', () => {
      const result = harness.contextCompressionEngine.compress({
        currentPhase: 'module-development',
        skills: [
          { skill_id: 'tdd', phase: 'module-development', instruction: 'x'.repeat(1000), summary: 'TDD' },
          { skill_id: 'brain', phase: 'brainstorming', instruction: 'y'.repeat(1000), summary: 'Brain' },
        ],
        completedSkills: ['brainstorming'],
        keyDecisions: ['Use microservices'],
        sessionState: {},
      });

      assert.ok(result);
      assert.ok(result.retainedSkills !== undefined);
      assert.ok(result.compressedSkills !== undefined);
      assert.ok(result.keyDecisions);
      assert.deepEqual(result.keyDecisions, ['Use microservices']);
    });
  });

  describe('SkillRouter verified skills', () => {
    it('should expose verified skills', () => {
      const verified = harness.router.getVerifiedSkills();
      assert.ok(Array.isArray(verified));
    });

    it('should expose skills by stability', () => {
      const stable = harness.router.getSkillsByStability('stable');
      assert.ok(Array.isArray(stable));
    });
  });
});
