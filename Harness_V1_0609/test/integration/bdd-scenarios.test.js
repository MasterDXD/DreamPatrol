'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function scenario(name, fn) {
  describe('Scenario: ' + name, fn);
}

function given(description, setupFn) {
  let setupResult;
  beforeEach(async () => {
    if (typeof setupFn === 'function') {
      setupResult = await setupFn();
    }
  });
  it('Given ' + description, () => {
    assert.ok(true, 'Given: ' + description);
  });
  return setupResult;
}

function when(description, actionFn) {
  it('When ' + description, () => {
    if (typeof actionFn === 'function') {
      actionFn();
    }
  });
}

function then(description, assertionFn) {
  it('Then ' + description, () => {
    if (typeof assertionFn === 'function') {
      assertionFn();
    }
  });
}

const CausalDataBus = require('../../src/runtime/causal/causal-data-bus');
const GeneratorVerifier = require('../../src/gate/generator-verifier');
const AR = require('../../src/runtime/context/autoregressive-context-schema');

describe('BDD Scenario Engine', () => {
  scenario('SkillInterface with Given-When-Then scenarios', () => {
    let bus;

    given('a CausalDataBus with a skill interface that has scenarios', async () => {
      bus = new CausalDataBus();
      await bus.defineSkillInterface('tdd-implement', {
        causalInputs: ['description', 'goal'],
        causalOutputs: ['test_code', 'implementation_code'],
        invariants: ['tests_must_pass'],
        scenarios: [
          {
            name: 'RED phase - test written first',
            given: { description: 'exists', goal: 'defined' },
            when: 'write-test-first',
            then: { test_code: 'exists', tests_must_pass: false },
          },
          {
            name: 'GREEN phase - implementation makes test pass',
            given: { test_code: 'exists', implementation_code: 'not_exists' },
            when: 'implement-feature',
            then: { implementation_code: 'exists', tests_must_pass: true },
          },
        ],
      });
    });

    when('defining a skill interface with scenarios', () => {});

    then('the interface should contain the scenarios', () => {
      const iface = bus.getSkillInterface('tdd-implement');
      assert.strictEqual(iface.scenarios.length, 2);
      assert.strictEqual(iface.scenarios[0].name, 'RED phase - test written first');
      assert.strictEqual(iface.scenarios[1].name, 'GREEN phase - implementation makes test pass');
    });

    then('stats should include totalScenarios', () => {
      const stats = bus.getStats();
      assert.strictEqual(stats.totalScenarios, 2);
    });
  });

  scenario('Scenario validation with Given-When-Then', () => {
    let bus;

    given('a skill interface with scenarios', async () => {
      bus = new CausalDataBus();
      await bus.defineSkillInterface('code-review', {
        causalInputs: ['source_code'],
        causalOutputs: ['review_result'],
        scenarios: [
          {
            name: 'approve clean code',
            given: { source_code: 'exists' },
            when: 'review-code',
            then: { review_result: 'exists' },
          },
          {
            name: 'reject code with issues',
            given: { source_code: 'exists' },
            when: 'review-code-with-issues',
            then: { review_result: 'exists' },
          },
        ],
      });
    });

    when('validating a scenario with matching context', () => {});

    then('validation should pass for matching given conditions', () => {
      const result = bus.validateScenario('code-review', 'approve clean code', {
        source_code: 'function add(a,b) { return a+b; }',
        review_result: 'approved',
      });
      assert.strictEqual(result.valid, true);
    });

    then('validation should fail for missing given conditions', () => {
      const result = bus.validateScenario('code-review', 'approve clean code', {});
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.issues.length > 0, true);
    });

    then('validation should return not found for unknown scenario', () => {
      const result = bus.validateScenario('code-review', 'unknown scenario', {});
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, 'scenario_not_found');
    });
  });

  scenario('Scenario coverage checking', () => {
    let bus;

    given('a skill with 3 scenarios', async () => {
      bus = new CausalDataBus();
      await bus.defineSkillInterface('deployment', {
        causalInputs: ['build_artifact'],
        causalOutputs: ['deployment_result'],
        scenarios: [
          { name: 'deploy to staging', given: {}, when: 'deploy', then: {} },
          { name: 'deploy to production', given: {}, when: 'deploy', then: {} },
          { name: 'rollback deployment', given: {}, when: 'rollback', then: {} },
        ],
      });
    });

    when('checking scenario coverage', () => {});

    then('full coverage when all scenarios tested', () => {
      const result = bus.checkScenarioCoverage('deployment', [
        'deploy to staging',
        'deploy to production',
        'rollback deployment',
      ]);
      assert.strictEqual(result.coverage, 100);
      assert.strictEqual(result.untested.length, 0);
    });

    then('partial coverage when some scenarios untested', () => {
      const result = bus.checkScenarioCoverage('deployment', [
        'deploy to staging',
      ]);
      assert.ok(Math.abs(result.coverage - 33.33333333333333) < 0.01);
      assert.strictEqual(result.untested.length, 2);
    });

    then('zero coverage when no scenarios tested', () => {
      const result = bus.checkScenarioCoverage('deployment', []);
      assert.strictEqual(result.coverage, 0);
      assert.strictEqual(result.untested.length, 3);
    });
  });
});

describe('GeneratorVerifier Scenario Coverage Dimension', () => {
  scenario('GeneratorVerifier includes scenario_coverage dimension', () => {
    let verifier;

    given('a GeneratorVerifier instance', () => {
      verifier = new GeneratorVerifier();
    });

    when('verifying output with scenario coverage', () => {});

    then('should include scenario_coverage in dimensions', () => {
      const result = verifier.verifyCorrectness({
        skillId: 'tdd-implement',
        output: 'Given a user, When they login, Then they see dashboard',
        requirements: ['user authentication'],
        evidence: [{ type: 'test_output', content: 'passed' }, { type: 'coverage_report', content: '85%' }],
      });
      assert.strictEqual(typeof result.dimensions.scenario_coverage, 'object');
      assert.strictEqual(result.dimensions.scenario_coverage.weight, 0.15);
    });

    then('should penalize output without scenario signals when requirements exist', () => {
      const result = verifier.verifyCorrectness({
        skillId: 'tdd-implement',
        output: 'Implemented the feature with basic logic.',
        requirements: ['user authentication', 'session management'],
        evidence: [{ type: 'test_output', content: 'passed' }],
      });
      assert.strictEqual(result.dimensions.scenario_coverage.score < 1, true);
    });
  });
});

describe('AR Protocol Version Negotiation', () => {
  scenario('AR context with version tracking', () => {
    when('injecting AR context into a target', () => {});

    then('should include version in the AR context', () => {
      const target = {};
      AR.inject(target, { previousResult: 'test', previousScore: 0.9 });
      assert.strictEqual(target._ar._version, AR.VERSION);
    });

    then('extract should not include _version in returned context', () => {
      const target = {};
      AR.inject(target, { previousResult: 'test' });
      const ctx = AR.extract(target);
      assert.strictEqual(ctx._version, undefined);
      assert.strictEqual(ctx.previousResult, 'test');
    });

    then('compatibilityCheck should pass for same version', () => {
      const target = {};
      AR.inject(target, { previousResult: 'test' });
      const check = AR.compatibilityCheck(target, AR.VERSION);
      assert.strictEqual(check.compatible, true);
      assert.strictEqual(check.reason, 'version_match');
    });

    then('compatibilityCheck should pass for no AR context', () => {
      const target = {};
      const check = AR.compatibilityCheck(target);
      assert.strictEqual(check.compatible, true);
      assert.strictEqual(check.reason, 'no_ar_context');
    });
  });
});

describe('Causal Hard Constraint Enforcement', () => {
  scenario('enforcePublishOutput with valid data', () => {
    let bus;

    given('a CausalDataBus with a skill interface', async () => {
      bus = new CausalDataBus();
      await bus.defineSkillInterface('tdd-implement', {
        causalInputs: ['description'],
        causalOutputs: ['test_code', 'implementation_code'],
        invariants: ['tests_must_pass'],
      });
    });

    when('enforcePublishOutput with all outputs and invariants satisfied', () => {});

    then('should succeed and publish the output', async () => {
      const result = await bus.enforcePublishOutput('tdd-implement', {
        test_code: 'assert(true)',
        implementation_code: 'function add(a,b) { return a+b; }',
        tests_must_pass: true,
      }, {
        description: 'test feature',
        goal: 'implement feature',
      });
      assert.strictEqual(result, true);
    });
  });

  scenario('enforcePublishOutput with missing outputs', () => {
    let bus;

    given('a CausalDataBus with a skill interface', async () => {
      bus = new CausalDataBus();
      await bus.defineSkillInterface('tdd-implement', {
        causalInputs: ['description'],
        causalOutputs: ['test_code', 'implementation_code'],
        invariants: ['tests_must_pass'],
      });
    });

    when('enforcePublishOutput with missing required outputs', () => {});

    then('should throw CausalViolationError for missing outputs', async () => {
      await assert.rejects(async () => bus.enforcePublishOutput('tdd-implement', {
        test_code: 'assert(true)',
      }, {
        description: 'test',
      }), { name: 'CausalViolationError' });
    });
  });

  scenario('enforcePublishOutput with violated invariants', () => {
    let bus;

    given('a CausalDataBus with a skill interface', async () => {
      bus = new CausalDataBus();
      await bus.defineSkillInterface('tdd-implement', {
        causalInputs: ['description'],
        causalOutputs: ['test_code', 'implementation_code'],
        invariants: ['tests_must_pass'],
      });
    });

    when('enforcePublishOutput with invariant violation', () => {});

    then('should throw CausalViolationError for invariant violation', async () => {
      await assert.rejects(async () => bus.enforcePublishOutput('tdd-implement', {
        test_code: 'assert(true)',
        implementation_code: 'function add(a,b) { return a+b; }',
        tests_must_pass: false,
      }, {
        description: 'test',
      }), { name: 'CausalViolationError' });
    });
  });

  scenario('enforceValidateInputs', () => {
    let bus;

    given('a CausalDataBus with a skill interface', async () => {
      bus = new CausalDataBus();
      await bus.defineSkillInterface('code-review', {
        causalInputs: ['source_code', 'reviewer'],
        causalOutputs: ['review_result'],
      });
    });

    when('enforceValidateInputs with missing inputs', () => {});

    then('should throw CausalViolationError for missing inputs', () => {
      assert.throws(() => bus.enforceValidateInputs('code-review', {
        source_code: 'code',
      }), { name: 'CausalViolationError' });
    });

    then('should pass when all inputs present', () => {
      const result = bus.enforceValidateInputs('code-review', {
        source_code: 'code',
        reviewer: 'analyst',
      });
      assert.strictEqual(result.valid, true);
    });
  });
});
