'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

const { randomBytes } = require('crypto');

const TEST_DIR = path.join(os.tmpdir(), 'harness-karpathy-v2-test-' + Date.now() + '-' + randomBytes(4).toString('hex'));

describe('Karpathy Principles - v2.7.100 Enhancements', () => {
  describe('Orphan Code Detection in surgical_change_check', () => {
    it('should warn when new imports added but no orphaned imports removed', () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      const diff = [
        '+const foo = require("foo");',
        '-function oldFn() { return 1; }',
        '-function oldFn2() { return 2; }',
        '-function oldFn3() { return 3; }',
        '-function oldFn4() { return 4; }',
        '+function newFn() { return foo(); }',
      ].join('\n');
      const result = BUILTIN_HANDLERS.surgical_change_check({ diff, task_type: 'bug-fix' });
      if (!result.passed) {
        const orphanWarning = result.details.violations.find(v => v.includes('orphaned imports'));
        assert.ok(orphanWarning, 'Should warn about orphaned imports not being cleaned up');
      }
    });

    it('should warn when removing pre-existing dead code in non-refactor task', () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      const diff = [
        '-// TODO: implement this later',
        '-// FIXME: broken code',
        '-// TODO: add error handling',
        '-// FIXME: another issue',
        '+function fix() { return true; }',
      ].join('\n');
      const result = BUILTIN_HANDLERS.surgical_change_check({ diff, task_type: 'bug-fix' });
      if (!result.passed) {
        const deadCodeWarning = result.details.violations.find(v => v.includes('pre-existing dead code'));
        assert.ok(deadCodeWarning, 'Should warn about removing pre-existing dead code');
      }
    });

    it('should pass for clean surgical changes', () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      const diff = [
        '+function fix() { return true; }',
        '-function bug() { return false; }',
      ].join('\n');
      const result = BUILTIN_HANDLERS.surgical_change_check({ diff, task_type: 'bug-fix' });
      assert.equal(result.passed, true);
    });
  });

  describe('Criteria Strength Classification', () => {
    it('should classify weak criteria correctly', () => {
      const EvidenceVerifier = require('../../src/gate/evidence-verifier');
      const verifier = new EvidenceVerifier();
      assert.equal(verifier.classifyCriteriaStrength('make it work'), 'weak');
      assert.equal(verifier.classifyCriteriaStrength('looks good'), 'weak');
      assert.equal(verifier.classifyCriteriaStrength('应该可以了'), 'weak');
    });

    it('should classify strong criteria correctly', () => {
      const EvidenceVerifier = require('../../src/gate/evidence-verifier');
      const verifier = new EvidenceVerifier();
      assert.equal(verifier.classifyCriteriaStrength('test passes'), 'strong');
      assert.equal(verifier.classifyCriteriaStrength('coverage >= 80%'), 'strong');
      assert.equal(verifier.classifyCriteriaStrength('测试通过'), 'strong');
    });

    it('should default to weak for null/empty criteria', () => {
      const EvidenceVerifier = require('../../src/gate/evidence-verifier');
      const verifier = new EvidenceVerifier();
      assert.equal(verifier.classifyCriteriaStrength(null), 'weak');
      assert.equal(verifier.classifyCriteriaStrength(''), 'weak');
    });

    it('should include criteriaStrength and requiresHumanConfirmation in verify result', () => {
      const EvidenceVerifier = require('../../src/gate/evidence-verifier');
      const verifier = new EvidenceVerifier();
      const result = verifier.verify({
        claim: 'make it work',
        evidence: [{ type: 'test_output', content: 'All tests passed' }],
        requiredTypes: ['test_output'],
      });
      assert.ok(result.criteriaStrength !== undefined, 'criteriaStrength should be present');
      assert.ok(result.requiresHumanConfirmation !== undefined, 'requiresHumanConfirmation should be present');
    });
  });
});

describe('Karpathy Principles - Framework Compliance', () => {
  describe('Orphan Cleanup Check in FrameworkComplianceChecker', () => {
    it('should detect unused imports marked but not cleaned', () => {
      const FrameworkComplianceChecker = require('../../src/gate/framework-compliance-checker');
      const checker = new FrameworkComplianceChecker(TEST_DIR);
      const content = [
        "'use strict';",
        'const unused = require("unused-module"); // unused',
        'const used = require("used-module");',
        'module.exports = used;',
      ].join('\n');
      const violations = [];
      checker._checkOrphanCleanup(content, 'test-file.js', violations);
      assert.ok(violations.length > 0, 'Should detect unused import not cleaned up');
      assert.equal(violations[0].ruleId, 'no-orphan-cleanup');
    });

    it('should warn about excessive console.log calls', () => {
      const FrameworkComplianceChecker = require('../../src/gate/framework-compliance-checker');
      const checker = new FrameworkComplianceChecker(TEST_DIR);
      const content = [
        "'use strict';",
        'console.log("a");',
        'console.log("b");',
        'console.log("c");',
        'console.log("d");',
        'console.log("e");',
        'console.log("f");',
        'module.exports = {};',
      ].join('\n');
      const violations = [];
      checker._checkOrphanCleanup(content, 'test-file.js', violations);
      assert.ok(violations.length > 0, 'Should warn about excessive console.log');
      assert.equal(violations[0].ruleId, 'no-orphan-cleanup');
    });

    it('should not warn for clean code', () => {
      const FrameworkComplianceChecker = require('../../src/gate/framework-compliance-checker');
      const checker = new FrameworkComplianceChecker(TEST_DIR);
      const content = [
        "'use strict';",
        'const used = require("used-module");',
        'module.exports = used;',
      ].join('\n');
      const violations = [];
      checker._checkOrphanCleanup(content, 'test-file.js', violations);
      assert.equal(violations.length, 0, 'Should not warn for clean code');
    });

    it('should handle non-string content gracefully', () => {
      const FrameworkComplianceChecker = require('../../src/gate/framework-compliance-checker');
      const checker = new FrameworkComplianceChecker(TEST_DIR);
      const violations = [];
      checker._checkOrphanCleanup(null, 'test-file.js', violations);
      assert.equal(violations.length, 0, 'Should not crash on null content');
      checker._checkOrphanCleanup(undefined, 'test-file.js', violations);
      assert.equal(violations.length, 0, 'Should not crash on undefined content');
      checker._checkOrphanCleanup(123, 'test-file.js', violations);
      assert.equal(violations.length, 0, 'Should not crash on number content');
    });
  });
});

describe('Karpathy Principles - Edge Cases', () => {
  describe('Edge Cases and Boundary Conditions', () => {
    it('should handle non-string diff in surgical_change_check', () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      const result1 = BUILTIN_HANDLERS.surgical_change_check({ diff: null, task_type: 'bug-fix' });
      assert.equal(result1.passed, true, 'Should pass with null diff');
      const result2 = BUILTIN_HANDLERS.surgical_change_check({ diff: undefined, task_type: 'bug-fix' });
      assert.equal(result2.passed, true, 'Should pass with undefined diff');
      const result3 = BUILTIN_HANDLERS.surgical_change_check({ diff: 123, task_type: 'bug-fix' });
      assert.equal(result3.passed, true, 'Should pass with number diff');
    });

    it('should handle empty diff in surgical_change_check', () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      const result = BUILTIN_HANDLERS.surgical_change_check({ diff: '', task_type: 'bug-fix' });
      assert.equal(result.passed, true, 'Should pass with empty diff');
    });

    it('should include criteriaStrength in invalid context verify result', () => {
      const EvidenceVerifier = require('../../src/gate/evidence-verifier');
      const verifier = new EvidenceVerifier();
      const result = verifier.verify(null);
      assert.equal(result.criteriaStrength, 'strong', 'Invalid context should default to strong (safe default)');
      assert.equal(result.requiresHumanConfirmation, false, 'Invalid context should not require human confirmation');
    });

    it('should classify numeric criteria as weak', () => {
      const EvidenceVerifier = require('../../src/gate/evidence-verifier');
      const verifier = new EvidenceVerifier();
      assert.equal(verifier.classifyCriteriaStrength(42), 'weak');
      assert.equal(verifier.classifyCriteriaStrength(true), 'weak');
    });

    it('should handle non-string criteria types', () => {
      const EvidenceVerifier = require('../../src/gate/evidence-verifier');
      const verifier = new EvidenceVerifier();
      assert.equal(verifier.classifyCriteriaStrength({}), 'weak');
      assert.equal(verifier.classifyCriteriaStrength([]), 'weak');
    });
  });
});
