'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

describe('TDDGate', () => {
  const TDDGate = require(path.join(ROOT, 'src', 'gate', 'tdd-gate'));

  it('should block implementation without test file', () => {
    const gate = new TDDGate();
    const result = gate.check({
      implFile: 'src/main.py',
      testFile: 'test/test_main.py',
      testExists: false,
      implExists: true,
    });
    assert.ok(!result.passed);
    assert.ok(result.reason.includes('test first'));
  });

  it('should allow implementation when test exists', () => {
    const gate = new TDDGate();
    const result = gate.check({
      implFile: 'src/main.py',
      testFile: 'test/test_main.py',
      testExists: true,
      implExists: true,
      testResult: 'pass',
    });
    assert.ok(result.passed);
  });

  it('should detect RED phase (test fails)', () => {
    const gate = new TDDGate();
    const result = gate.check({
      implFile: 'src/main.py',
      testFile: 'test/test_main.py',
      testExists: true,
      implExists: false,
      testResult: 'fail',
    });
    assert.equal(result.phase, 'RED');
    assert.ok(result.passed);
  });

  it('should detect GREEN phase (test passes)', () => {
    const gate = new TDDGate();
    const result = gate.check({
      implFile: 'src/main.py',
      testFile: 'test/test_main.py',
      testExists: true,
      implExists: true,
      testResult: 'pass',
    });
    assert.equal(result.phase, 'GREEN');
    assert.ok(result.passed);
  });

  it('should enforce coverage threshold', () => {
    const gate = new TDDGate();
    const result = gate.checkCoverage({
      coverage: 75,
      threshold: 80,
    });
    assert.ok(!result.passed);
    assert.ok(result.reason.includes('80'));
  });

  it('should pass coverage check when threshold met', () => {
    const gate = new TDDGate();
    const result = gate.checkCoverage({
      coverage: 85,
      threshold: 80,
    });
    assert.ok(result.passed);
  });

  it('enforceCoverage should throw INVALID_COVERAGE_VALUE for null coverage', () => {
    const gate = new TDDGate();
    try { gate.enforceCoverage({ coverage: null, threshold: 80 }); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, 'INVALID_COVERAGE_VALUE'); }
  });

  it('enforceCoverage should throw COVERAGE_OUT_OF_RANGE for out-of-range coverage', () => {
    const gate = new TDDGate();
    try { gate.enforceCoverage({ coverage: -5, threshold: 80 }); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, 'COVERAGE_OUT_OF_RANGE'); }
  });

  it('enforceCoverage should throw COVERAGE_BELOW_THRESHOLD for below threshold', () => {
    const gate = new TDDGate();
    try { gate.enforceCoverage({ coverage: 50, threshold: 80 }); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, 'COVERAGE_BELOW_THRESHOLD'); }
  });
});

describe('EvidenceVerifier', () => {
  const EvidenceVerifier = require(path.join(ROOT, 'src', 'gate', 'evidence-verifier'));

  it('should reject claim without evidence', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Feature X is implemented',
      evidence: [],
    });
    assert.ok(!result.verified);
    assert.ok(result.missing.length > 0);
  });

  it('should accept claim with sufficient evidence', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Feature X is implemented',
      evidence: [
        { type: 'test_output', content: 'All 5 tests passed' },
        { type: 'coverage_report', content: 'Coverage: 85%' },
        { type: 'lint_output', content: '0 errors, 0 warnings' },
      ],
    });
    assert.ok(result.verified);
  });

  it('should require specific evidence types for strict skills', () => {
    const verifier = new EvidenceVerifier();
    const requiredTypes = verifier.getRequiredEvidenceTypes('tdd-implement');
    assert.ok(requiredTypes.includes('test_output'));
    assert.ok(requiredTypes.includes('coverage_report'));
  });

  it('should generate verification report', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Feature X is implemented',
      evidence: [
        { type: 'test_output', content: 'All tests passed' },
      ],
      requiredTypes: ['test_output', 'coverage_report', 'lint_output'],
    });
    assert.ok(result.report);
    assert.ok(result.report.includes('test_output'));
    assert.ok(result.missing.includes('coverage_report'));
  });
});
