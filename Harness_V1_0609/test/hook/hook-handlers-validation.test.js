'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');

describe('Hook Handlers - Validation', () => {
  describe('simplicity_check', () => {
    it('should pass when no diff provided', () => {
      const result = BUILTIN_HANDLERS.simplicity_check({});
      assert.equal(result.passed, true);
    });

    it('should warn about too many new files', () => {
      const diff = Array(5).fill('+new file mode 100644\n').join('');
      const result = BUILTIN_HANDLERS.simplicity_check({ diff, new_files: [] });
      assert.equal(result.passed, false);
      assert.ok(result.details.warnings.some(w => w.includes('5 new files')));
    });

    it('should warn about over-implementation', () => {
      const diff = Array(250).fill('+added line\n').join('');
      const result = BUILTIN_HANDLERS.simplicity_check({ diff });
      assert.equal(result.passed, false);
      assert.ok(result.details.warnings.some(w => w.includes('over-implementation')));
    });

    it('should warn about unnecessary abstractions', () => {
      const diff = 'class WidgetFactory { }\nclass WidgetBuilder { }';
      const result = BUILTIN_HANDLERS.simplicity_check({ diff });
      assert.equal(result.passed, false);
      assert.ok(result.details.warnings.some(w => w.includes('abstraction')));
    });

    it('should warn about interfaces without implementations', () => {
      const diff = 'interface IWidget { render(): void; }';
      const result = BUILTIN_HANDLERS.simplicity_check({ diff });
      assert.equal(result.passed, false);
      assert.ok(result.details.warnings.some(w => w.includes('interface')));
    });

    it('should pass for simple changes', () => {
      const diff = '+function add(a, b) { return a + b; }\n';
      const result = BUILTIN_HANDLERS.simplicity_check({ diff });
      assert.equal(result.passed, true);
    });

    it('should warn when line budget exceeded by 150%', () => {
      const diff = Array(200).fill('+line\n').join('');
      const result = BUILTIN_HANDLERS.simplicity_check({ diff, line_budget: 100 });
      assert.equal(result.passed, false);
      assert.ok(result.details.warnings.some(w => w.includes('exceeds budget')));
    });

    it('should pass when within line budget', () => {
      const diff = '+line1\n+line2\n';
      const result = BUILTIN_HANDLERS.simplicity_check({ diff, line_budget: 100 });
      assert.equal(result.passed, true);
    });
  });

  describe('surgical_change_check', () => {
    it('should pass when no diff provided', () => {
      const result = BUILTIN_HANDLERS.surgical_change_check({});
      assert.equal(result.passed, true);
    });

    it('should warn about too many modified files', () => {
      const diff = Array(12).fill('diff --git a/file b/file\n').join('');
      const result = BUILTIN_HANDLERS.surgical_change_check({ diff });
      assert.equal(result.passed, false);
      assert.ok(result.details.violations.some(v => v.includes('12 files')));
    });

    it('should pass for focused changes', () => {
      const diff = 'diff --git a/auth.js b/auth.js\n+function validate() {}\n';
      const result = BUILTIN_HANDLERS.surgical_change_check({ diff });
      assert.equal(result.passed, true);
    });
  });

  describe('parameter_validation', () => {
    it('should require description or goal for tdd-implement', () => {
      const result = BUILTIN_HANDLERS.parameter_validation({
        skill_id: 'tdd-implement',
        parameters: {},
      });
      assert.equal(result.passed, false);
      assert.ok(result.reason.includes('description'));
    });

    it('should pass when required parameters provided', () => {
      const result = BUILTIN_HANDLERS.parameter_validation({
        skill_id: 'tdd-implement',
        parameters: { description: 'Implement login' },
      });
      assert.equal(result.passed, true);
    });

    it('should skip validation when no skill context', () => {
      const result = BUILTIN_HANDLERS.parameter_validation({ parameters: {} });
      assert.equal(result.passed, true);
    });
  });

  describe('deliverable_completeness', () => {
    it('should block when required deliverables missing', () => {
      const result = BUILTIN_HANDLERS.deliverable_completeness({
        skill_id: 'tdd-implement',
        deliverables: {},
      });
      assert.equal(result.passed, false);
      assert.ok(result.reason.includes('missing'));
    });

    it('should pass when all deliverables present', () => {
      const result = BUILTIN_HANDLERS.deliverable_completeness({
        skill_id: 'tdd-implement',
        deliverables: { test_code: 'ok', implementation_code: 'ok', test_results: 'ok' },
      });
      assert.equal(result.passed, true);
    });
  });
});
