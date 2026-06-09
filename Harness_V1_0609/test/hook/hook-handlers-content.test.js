'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');

describe('Hook Handlers - Content', () => {
  describe('permission_check', () => {
    it('should block read-only agents from writing', () => {
      const result = BUILTIN_HANDLERS.permission_check({
        agent_id: 'code-reviewer',
        action: 'write_file',
      });
      assert.equal(result.passed, false);
      assert.ok(result.reason.includes('read-only'));
    });

    it('should allow task-worker to write', () => {
      const result = BUILTIN_HANDLERS.permission_check({
        agent_id: 'task-worker',
        action: 'write_file',
      });
      assert.equal(result.passed, true);
    });

    it('should skip check when no agent context', () => {
      const result = BUILTIN_HANDLERS.permission_check({});
      assert.equal(result.passed, true);
    });
  });

  describe('content_safety', () => {
    it('should block content with API keys', () => {
      const result = BUILTIN_HANDLERS.content_safety({
        content: 'const apiKey = "sk-1234567890abcdefghijklmnop";',
      });
      assert.equal(result.passed, false);
      assert.ok(result.reason.includes('secrets'));
    });

    it('should allow safe content', () => {
      const result = BUILTIN_HANDLERS.content_safety({
        content: 'function add(a, b) { return a + b; }',
      });
      assert.equal(result.passed, true);
    });

    it('should pass when no content', () => {
      const result = BUILTIN_HANDLERS.content_safety({});
      assert.equal(result.passed, true);
    });
  });

  describe('token_budget_check', () => {
    it('should pass when budget is sufficient', () => {
      const result = BUILTIN_HANDLERS.token_budget_check({
        token_usage: 100,
        token_budget: 1000000,
      });
      assert.equal(result.passed, true);
    });

    it('should fail when budget is exhausted', () => {
      const result = BUILTIN_HANDLERS.token_budget_check({
        token_usage: 1000001,
        token_budget: 1000000,
      });
      assert.equal(result.passed, false);
      assert.ok(result.reason.includes('exhausted'));
    });

    it('should warn at 80% usage', () => {
      const result = BUILTIN_HANDLERS.token_budget_check({
        token_usage: 800000,
        token_budget: 1000000,
      });
      assert.equal(result.passed, true);
      assert.ok(result.warning);
    });
  });

  describe('rate_limit_check', () => {
    it('should allow requests within limit', () => {
      const result = BUILTIN_HANDLERS.rate_limit_check({ agent_id: 'test-agent' });
      assert.equal(result.passed, true);
    });
  });
});
