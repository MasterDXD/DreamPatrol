'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');

describe('Hook Handlers - Quality', () => {
  describe('verification_before_completion', () => {
    it('should block when tests are failing', () => {
      const result = BUILTIN_HANDLERS.verification_before_completion({
        skill_id: 'tdd-implement',
        test_results: { total: 10, failed: 3 },
        lint_results: { errors: 0 },
      });
      assert.equal(result.passed, false);
      assert.ok(result.reason.includes('3 tests failing'));
    });

    it('should block when lint errors exist', () => {
      const result = BUILTIN_HANDLERS.verification_before_completion({
        skill_id: 'tdd-implement',
        test_results: { total: 10, failed: 0 },
        lint_results: { errors: 5 },
      });
      assert.equal(result.passed, false);
      assert.ok(result.reason.includes('5 lint errors'));
    });

    it('should pass for non-strict skills', () => {
      const result = BUILTIN_HANDLERS.verification_before_completion({
        skill_id: 'brainstorming',
      });
      assert.equal(result.passed, true);
    });
  });

  describe('quality_standards', () => {
    it('should block console.log statements', () => {
      const result = BUILTIN_HANDLERS.quality_standards({
        content: 'console.log("debug");',
        file_path: 'app.js',
      });
      assert.equal(result.passed, false);
      assert.ok(result.reason.includes('console.log'));
    });

    it('should block debugger statements', () => {
      const result = BUILTIN_HANDLERS.quality_standards({
        content: 'debugger;',
        file_path: 'app.js',
      });
      assert.equal(result.passed, false);
      assert.ok(result.reason.includes('debugger'));
    });

    it('should pass for clean code', () => {
      const result = BUILTIN_HANDLERS.quality_standards({
        content: 'function add(a, b) { return a + b; }',
        file_path: 'math.js',
      });
      assert.equal(result.passed, true);
    });
  });

  describe('output_format_check', () => {
    it('should block emoji characters', () => {
      const result = BUILTIN_HANDLERS.output_format_check({
        output: 'Hello 🎉 World',
      });
      assert.equal(result.passed, false);
      assert.ok(result.reason.includes('emoji'));
    });

    it('should pass for professional output', () => {
      const result = BUILTIN_HANDLERS.output_format_check({
        output: 'Implementation complete. All tests passing.',
      });
      assert.equal(result.passed, true);
    });
  });
});
