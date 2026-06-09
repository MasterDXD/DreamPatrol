'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');

describe('Hook Handlers - Miscellaneous', () => {
  describe('yagni_pre_check', () => {
    it('should pass when no new files or changes', () => {
      const result = BUILTIN_HANDLERS.yagni_pre_check({});
      assert.equal(result.passed, true);
    });

    it('should warn about many new files', () => {
      const result = BUILTIN_HANDLERS.yagni_pre_check({ new_files: ['a.js', 'b.js', 'c.js', 'd.js'] });
      assert.ok(result.details && result.details.warnings);
      assert.ok(result.details.warnings.some(w => w.includes('4 new files')));
    });
  });

  describe('phase_error_retry', () => {
    it('should recommend retry within limit', () => {
      const result = BUILTIN_HANDLERS.phase_error_retry({
        error: { attempt: 1, message: 'timeout' },
        phase: 'module-development',
      });
      assert.equal(result.passed, true);
      assert.ok(result.retry);
    });

    it('should escalate after max retries', () => {
      const result = BUILTIN_HANDLERS.phase_error_retry({
        error: { attempt: 3, message: 'persistent failure' },
        phase: 'module-development',
      });
      assert.equal(result.passed, false);
      assert.ok(result.escalate);
    });
  });
});
