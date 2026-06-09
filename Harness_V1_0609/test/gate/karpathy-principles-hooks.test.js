'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { randomBytes } = require('crypto');

const TEST_DIR = path.join(os.tmpdir(), 'harness-karpathy-hooks-test-' + Date.now() + '-' + randomBytes(4).toString('hex'));

describe('Karpathy Principles - Hooks', () => {
  let harness;

  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace', 'staging'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace', 'shared'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'workspace', 'locks'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'knowledge'), { recursive: true });

    const config = {
      project_name: 'karpathy-test',
      version: '2.0.0',
      token_budget: 1000000,
      skill_registry: { auto_trigger_enabled: true, skills: [] },
      agent_permissions: {
        'team-lead': { allowed_tools: ['read_file', 'write_file', 'search_files', 'run_command'], restricted_operations: ['file_delete'], requires_confirmation: [] },
        'task-worker': { allowed_tools: ['read_file', 'write_file', 'search_files', 'run_command'], restricted_operations: ['file_delete'], requires_confirmation: [] },
        'code-reviewer': { allowed_tools: ['read_file', 'search_files'], restricted_operations: ['write_file', 'file_delete'], requires_confirmation: [] },
      },
      hooks: {
        pre_tool_call: { enabled: true, checks: ['permission_check'] },
        post_task_complete: { enabled: true, checks: ['audit_log_record'] },
        post_file_write: { enabled: true, checks: ['simplicity_check', 'surgical_change_check', 'audit_log_record'] },
      },
      tdd_config: { enabled: true, block_implementation_without_test: true, coverage_threshold: 80 },
    };
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'config.json'), JSON.stringify(config, null, 2));

    const harnessModule = require('../../src/index');
    harness = harnessModule.create(TEST_DIR);
  });

  after(async () => {
    if (harness && harness.destroy) {
      await harness.destroy();
    }
    await new Promise(r => setTimeout(r, 100));
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('P0-1: Hook Execution Chain', () => {
    it('should execute pre_tool_call hooks during pipeline', async () => {
      const result = await harness.executePipeline('implement feature X');
      assert.ok(result);
      assert.ok(result.preToolChecks !== undefined, 'preToolChecks should be present');
      assert.ok(Array.isArray(result.preToolChecks), 'preToolChecks should be an array');
    });

    it('should block pipeline when pre_tool_call hook fails', async () => {
      harness.programmableHookExecutor.register('pre_tool_call', {
        id: 'blocking-test-hook',
        type: 'function',
        handler: () => ({ passed: false, reason: 'Test blocking reason' }),
      });

      const result = await harness.executePipeline('implement feature Y');
      assert.equal(result.status, 'blocked');
      assert.equal(result.reason, 'Test blocking reason');

      harness.programmableHookExecutor.unregister('pre_tool_call', 'blocking-test-hook');
    });

    it('should execute post_task_complete hooks after execution', async () => {
      const result = await harness.executePipeline('implement feature Z', {
        executeFn: async () => ({ success: true }),
      });
      assert.ok(result.executed);
      assert.ok(result.postTaskChecks !== undefined, 'postTaskChecks should be present after execution');
    });
  });

  describe('post_file_write Hook Integration', () => {
    it('should trigger post_file_write hooks when diff is provided', async () => {
      const result = await harness.executePipeline('fix bug in auth', {
        executeFn: async () => ({ success: true, files: ['auth.js'] }),
        diff: '+function validate() { return true; }\n',
      });
      assert.ok(result.executed);
      assert.ok(result.fileWriteChecks !== undefined, 'fileWriteChecks should be present when diff provided');
    });

    it('should trigger post_file_write hooks when changes are provided', async () => {
      const result = await harness.executePipeline('update config', {
        executeFn: async () => ({ success: true }),
        changes: 'modified 3 files',
      });
      assert.ok(result.executed);
      assert.ok(result.fileWriteChecks !== undefined, 'fileWriteChecks should be present when changes provided');
    });

    it('should not trigger post_file_write when no diff or changes', async () => {
      const result = await harness.executePipeline('simple task', {
        executeFn: async () => ({ success: true }),
      });
      assert.ok(result.executed);
      assert.ok(result.fileWriteChecks === undefined, 'fileWriteChecks should not be present without diff/changes');
    });
  });
});
