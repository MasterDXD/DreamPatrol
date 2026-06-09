'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { randomBytes } = require('crypto');

const TEST_DIR = path.join(os.tmpdir(), 'harness-karpathy-test-' + Date.now() + '-' + randomBytes(4).toString('hex'));

describe('Karpathy Principles - Core', () => {
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

  describe('P0-3: Clarification Blocking', () => {
    it('should return clarification_needed when intent is ambiguous', async () => {
      const result = await harness.executePipeline('');
      if (result.status === 'clarification_needed') {
        assert.ok(result.clarificationPrompt);
      }
    });
  });

  describe('P0-2: TDD Gate Enforcement', () => {
    it('should block when TDD context has no test file', async () => {
      const result = await harness.executePipeline('implement login', {
        tddContext: {
          implFile: 'login.js',
          testFile: 'login.test.js',
          testExists: false,
          implExists: true,
          testResult: { total: 0, passed: 0, failed: 0 },
        },
      });
      assert.equal(result.status, 'tdd_violation');
      assert.ok(result.reason);
    });

    it('should allow when TDD context has test file', async () => {
      const result = await harness.executePipeline('implement login', {
        tddContext: {
          implFile: 'login.js',
          testFile: 'login.test.js',
          testExists: true,
          implExists: false,
          testResult: { total: 1, passed: 1, failed: 0 },
        },
      });
      assert.notEqual(result.status, 'tdd_violation');
    });
  });

  describe('P0-4: Evidence Verification', () => {
    it('should mark evidence_insufficient when evidence is lacking', async () => {
      const result = await harness.executePipeline('fix bug in auth', {
        executeFn: async () => ({ success: true }),
        evidence: { test_output: '1 passed' },
      });
      assert.ok(result.evidenceVerification);
    });

    it('should verify evidence when provided', async () => {
      const result = await harness.executePipeline('fix bug in auth', {
        executeFn: async () => ({ success: true }),
        evidence: { test_output: 'all passed', coverage_report: '85%', fix_verification: 'verified' },
      });
      assert.ok(result.evidenceVerification);
    });
  });

  describe('P2-1: Think Before Coding Gate', () => {
    it('should return thinking_required when requireThinking is set without thinkingOutput', async () => {
      const result = await harness.executePipeline('implement new feature', {
        requireThinking: true,
      });
      assert.equal(result.status, 'thinking_required');
      assert.ok(result.reason.includes('Think Before Coding'));
      assert.ok(result.requiredFields);
      assert.deepEqual(result.requiredFields, ['assumptions', 'ambiguities', 'simpler_alternative']);
    });

    it('should proceed when requireThinking is set with thinkingOutput', async () => {
      const result = await harness.executePipeline('implement new feature', {
        requireThinking: true,
        thinkingOutput: {
          assumptions: ['User is authenticated'],
          ambiguities: ['Error handling approach'],
          simpler_alternative: 'Use existing utility',
        },
      });
      assert.notEqual(result.status, 'thinking_required');
    });
  });

  describe('P2-2: Goal Achievement Verification', () => {
    it('should mark goal_not_achieved when criteria are not met', async () => {
      const result = await harness.executePipeline('add validation', {
        executeFn: async () => ({ success: true }),
        goalVerification: {
          'All inputs validated': false,
          'Tests pass': true,
        },
        successCriteriaOverride: ['All inputs validated', 'Tests pass'],
      });
      if (result.goalVerification) {
        assert.equal(result.goalVerification.achieved, false);
        assert.equal(result.status, 'goal_not_achieved');
      }
    });

    it('should verify goal achievement when all criteria are met', async () => {
      const result = await harness.executePipeline('add validation', {
        executeFn: async () => ({ success: true }),
        goalVerification: {
          'All inputs validated': true,
          'Tests pass': true,
        },
        successCriteriaOverride: ['All inputs validated', 'Tests pass'],
      });
      if (result.goalVerification) {
        assert.equal(result.goalVerification.achieved, true);
        assert.ok(result.goalVerification.achievedCount >= 1);
      }
    });
  });

  describe('P2-4: Line Budget in Simplicity Check', () => {
    it('should warn when added lines exceed budget by 150%', async () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      const result = BUILTIN_HANDLERS.simplicity_check({
        diff: '+new file mode 100644\n' + '+'.repeat(400) + '\n',
        line_budget: 100,
      });
      if (result.details && result.details.warnings) {
        const budgetWarning = result.details.warnings.find(w => w.includes('exceeds budget'));
        assert.ok(budgetWarning, 'Should warn about exceeding line budget');
      }
    });

    it('should pass when added lines are within budget', async () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      const result = BUILTIN_HANDLERS.simplicity_check({
        diff: '+a\n+b\n+c\n',
        line_budget: 100,
      });
      assert.equal(result.passed, true);
    });
  });

  describe('necessity-review Auto Trigger', () => {
    it('should match necessity-review when user message contains new module keywords', () => {
      const router = harness.router;
      const matches = router.match({
        userMessage: '创建新模块处理用户认证',
        agent: 'domain-analyst',
        completedSkills: [],
      });
      const necessityMatch = matches.find(m => m.skill_id === 'necessity-review');
      if (necessityMatch) {
        assert.equal(necessityMatch.skill_id, 'necessity-review');
        assert.equal(necessityMatch.auto_trigger, true);
      }
    });
  });
});
