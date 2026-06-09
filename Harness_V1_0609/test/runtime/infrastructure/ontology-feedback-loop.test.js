'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  OntologyFeedbackLoop,
  FEEDBACK_STATUS,
  ADJUSTMENT_TYPES,
} = require('../../../src/runtime/infrastructure/ontology-feedback-loop');
const BusinessOntologyModel = require('../../../src/runtime/infrastructure/business-ontology-model');

// ─── Mock OntologyModel ─────────────────────────────────────────

function createMockModel() {
  const model = new BusinessOntologyModel();
  model.defineEntityType('Order', {
    properties: { amount: { type: 'number' }, status: { type: 'string' } },
    required: ['amount'],
  });
  model.addBusinessRule('order-amount-threshold', {
    entityType: 'Order',
    ruleType: 'threshold',
    condition: 'amount > 100',
    action: 'flag-for-review',
  });
  model.addBusinessRule('order-status-check', {
    entityType: 'Order',
    ruleType: 'validation',
    condition: 'status:exists',
    action: 'reject-missing-status',
  });
  return model;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('OntologyFeedbackLoop', () => {

  it('should create instance with default config', () => {
    const loop = new OntologyFeedbackLoop();
    assert.ok(loop);
    assert.strictEqual(loop.getStats().feedbackReceived, 0);
    loop.shutdown();
  });

  it('should attach ontology model', () => {
    const loop = new OntologyFeedbackLoop();
    const model = createMockModel();
    loop.attachOntologyModel(model);
    assert.strictEqual(loop.getStats().rulesTracked, 0);
    loop.shutdown();
  });

  it('should reject invalid ontology model', () => {
    const loop = new OntologyFeedbackLoop();
    assert.throws(() => loop.attachOntologyModel({}), /evaluateRules method/);
    loop.shutdown();
  });

  it('should submit feedback and track rule effects', () => {
    const loop = new OntologyFeedbackLoop();
    const result = loop.submitFeedback({
      ruleId: 'rule-1',
      status: FEEDBACK_STATUS.SUCCESS,
    });

    assert.strictEqual(result.recorded, true);
    assert.strictEqual(loop.getStats().feedbackReceived, 1);

    const effect = loop.getRuleEffect('rule-1');
    assert.ok(effect);
    assert.strictEqual(effect.triggers, 1);
    assert.strictEqual(effect.successes, 1);
    loop.shutdown();
  });

  it('should track multiple feedback entries', () => {
    const loop = new OntologyFeedbackLoop();

    loop.submitFeedback({ ruleId: 'rule-1', status: FEEDBACK_STATUS.SUCCESS });
    loop.submitFeedback({ ruleId: 'rule-1', status: FEEDBACK_STATUS.FAILURE });
    loop.submitFeedback({ ruleId: 'rule-1', status: FEEDBACK_STATUS.SUCCESS });

    const effect = loop.getRuleEffect('rule-1');
    assert.strictEqual(effect.triggers, 3);
    assert.strictEqual(effect.successes, 2);
    assert.strictEqual(effect.failures, 1);
    loop.shutdown();
  });

  it('should submit feedback batch', () => {
    const loop = new OntologyFeedbackLoop();

    const result = loop.submitFeedbackBatch([
      { ruleId: 'rule-1', status: FEEDBACK_STATUS.SUCCESS },
      { ruleId: 'rule-2', status: FEEDBACK_STATUS.FAILURE },
      { ruleId: 'rule-1', status: FEEDBACK_STATUS.PARTIAL },
    ]);

    assert.strictEqual(result.total, 3);
    assert.strictEqual(loop.getStats().feedbackReceived, 3);
    loop.shutdown();
  });

  it('should get rule effect overview', () => {
    const loop = new OntologyFeedbackLoop();

    loop.submitFeedback({ ruleId: 'rule-1', status: FEEDBACK_STATUS.SUCCESS });
    loop.submitFeedback({ ruleId: 'rule-1', status: FEEDBACK_STATUS.FAILURE });

    const overview = loop.getRuleEffectOverview();
    assert.strictEqual(overview.length, 1);
    assert.strictEqual(overview[0].ruleId, 'rule-1');
    assert.strictEqual(overview[0].totalTriggers, 2);
    loop.shutdown();
  });

  it('should get feedback history with filter', () => {
    const loop = new OntologyFeedbackLoop();

    loop.submitFeedback({ ruleId: 'rule-1', status: FEEDBACK_STATUS.SUCCESS });
    loop.submitFeedback({ ruleId: 'rule-2', status: FEEDBACK_STATUS.FAILURE });
    loop.submitFeedback({ ruleId: 'rule-1', status: FEEDBACK_STATUS.FAILURE });

    const all = loop.getHistory();
    assert.strictEqual(all.length, 3);

    const rule1History = loop.getHistory({ ruleId: 'rule-1' });
    assert.strictEqual(rule1History.length, 2);

    const failures = loop.getHistory({ status: FEEDBACK_STATUS.FAILURE });
    assert.strictEqual(failures.length, 2);
    loop.shutdown();
  });
});

describe('OntologyFeedbackLoop - Adjustments & Events', () => {

  it('should manually disable a rule', () => {
    const loop = new OntologyFeedbackLoop();
    const model = createMockModel();
    loop.attachOntologyModel(model);

    const result = loop.adjustRule('order-status-check', ADJUSTMENT_TYPES.RULE_DISABLE);
    assert.strictEqual(result.success, true);

    const rule = model.getBusinessRule('order-status-check');
    assert.strictEqual(rule.enabled, false);
    loop.shutdown();
  });

  it('should manually enable a rule', () => {
    const loop = new OntologyFeedbackLoop();
    const model = createMockModel();
    loop.attachOntologyModel(model);

    model.toggleBusinessRule('order-status-check', false);
    const result = loop.adjustRule('order-status-check', ADJUSTMENT_TYPES.RULE_ENABLE);
    assert.strictEqual(result.success, true);

    const rule = model.getBusinessRule('order-status-check');
    assert.strictEqual(rule.enabled, true);
    loop.shutdown();
  });

  it('should loosen threshold on high failure rate', () => {
    const loop = new OntologyFeedbackLoop({
      autoAdjustEnabled: true,
      autoAdjustFailureRate: 0.6,
      slidingWindowSize: 10,
    });
    const model = createMockModel();
    loop.attachOntologyModel(model);

    // Submit enough failures to trigger auto-adjust
    for (let i = 0; i < 8; i++) {
      loop.submitFeedback({ ruleId: 'order-amount-threshold', status: FEEDBACK_STATUS.FAILURE });
    }
    for (let i = 0; i < 2; i++) {
      loop.submitFeedback({ ruleId: 'order-amount-threshold', status: FEEDBACK_STATUS.SUCCESS });
    }

    // Check that threshold was loosened (amount > 100 → amount > lower value)
    const rule = model.getBusinessRule('order-amount-threshold');
    const conditionMatch = rule.condition.match(/amount\s*>\s*(\d+)/);
    assert.ok(conditionMatch);
    const threshold = parseFloat(conditionMatch[1]);
    assert.ok(threshold < 100, 'Threshold should be loosened below 100, got ' + threshold);
    loop.shutdown();
  });

  it('should tighten threshold on high success rate', () => {
    const loop = new OntologyFeedbackLoop({
      autoAdjustEnabled: true,
      autoAdjustSuccessRate: 0.9,
      slidingWindowSize: 10,
    });
    const model = createMockModel();
    loop.attachOntologyModel(model);

    // Submit enough successes to trigger auto-adjust
    for (let i = 0; i < 10; i++) {
      loop.submitFeedback({ ruleId: 'order-amount-threshold', status: FEEDBACK_STATUS.SUCCESS });
    }

    // Check that threshold was tightened (amount > 100 → amount > higher value)
    const rule = model.getBusinessRule('order-amount-threshold');
    const conditionMatch = rule.condition.match(/amount\s*>\s*(\d+)/);
    assert.ok(conditionMatch);
    const threshold = parseFloat(conditionMatch[1]);
    assert.ok(threshold > 100, 'Threshold should be tightened above 100, got ' + threshold);
    loop.shutdown();
  });

  it('should emit feedback-received event', () => {
    const loop = new OntologyFeedbackLoop();
    let received = null;
    loop.on('feedback-received', (data) => {
      received = data;
    });
    loop.submitFeedback({ ruleId: 'rule-1', status: FEEDBACK_STATUS.SUCCESS });
    assert.ok(received);
    assert.strictEqual(received.ruleId, 'rule-1');
    assert.strictEqual(received.status, FEEDBACK_STATUS.SUCCESS);
    loop.shutdown();
  });

  it('should emit rule-adjusted event', () => {
    const loop = new OntologyFeedbackLoop();
    const model = createMockModel();
    loop.attachOntologyModel(model);

    let adjusted = null;
    loop.on('rule-adjusted', (data) => {
      adjusted = data;
    });

    loop.adjustRule('order-status-check', ADJUSTMENT_TYPES.RULE_DISABLE);
    assert.ok(adjusted);
    assert.strictEqual(adjusted.ruleId, 'order-status-check');
    assert.strictEqual(adjusted.adjustmentType, ADJUSTMENT_TYPES.RULE_DISABLE);
    loop.shutdown();
  });

  it('should throw on invalid feedback', () => {
    const loop = new OntologyFeedbackLoop();
    assert.throws(() => loop.submitFeedback({}), /ruleId is required/);
    assert.throws(() => loop.submitFeedback({ ruleId: 'r1', status: 'invalid' }), /success, failure, or partial/);
    loop.shutdown();
  });

  it('should throw on invalid batch', () => {
    const loop = new OntologyFeedbackLoop();
    assert.throws(() => loop.submitFeedbackBatch('not-array'), /must be an array/);
    loop.shutdown();
  });

  it('should return failure when no ontology model for adjustRule', () => {
    const loop = new OntologyFeedbackLoop();
    const result = loop.adjustRule('rule-1', ADJUSTMENT_TYPES.RULE_DISABLE);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'no-ontology-model');
    loop.shutdown();
  });

  it('should return failure for unknown rule', () => {
    const loop = new OntologyFeedbackLoop();
    const model = createMockModel();
    loop.attachOntologyModel(model);

    const result = loop.adjustRule('nonexistent', ADJUSTMENT_TYPES.RULE_DISABLE);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'rule-not-found');
    loop.shutdown();
  });

  it('should return failure for unknown adjustment type', () => {
    const loop = new OntologyFeedbackLoop();
    const model = createMockModel();
    loop.attachOntologyModel(model);

    const result = loop.adjustRule('order-amount-threshold', 'unknown-type');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'unknown-adjustment-type');
    loop.shutdown();
  });

  it('should update condition via adjustRule', () => {
    const loop = new OntologyFeedbackLoop();
    const model = createMockModel();
    loop.attachOntologyModel(model);

    const result = loop.adjustRule('order-amount-threshold', ADJUSTMENT_TYPES.CONDITION_UPDATE, {
      newCondition: 'amount > 200',
    });

    assert.strictEqual(result.success, true);
    const rule = model.getBusinessRule('order-amount-threshold');
    assert.strictEqual(rule.condition, 'amount > 200');
    loop.shutdown();
  });

  it('should shutdown cleanly', () => {
    const loop = new OntologyFeedbackLoop();
    loop.shutdown();
    assert.throws(() => loop.submitFeedback({ ruleId: 'r1', status: FEEDBACK_STATUS.SUCCESS }), /shut down/);
  });

  it('should expose FEEDBACK_STATUS constants', () => {
    assert.strictEqual(FEEDBACK_STATUS.SUCCESS, 'success');
    assert.strictEqual(FEEDBACK_STATUS.FAILURE, 'failure');
    assert.strictEqual(FEEDBACK_STATUS.PARTIAL, 'partial');
  });

  it('should expose ADJUSTMENT_TYPES constants', () => {
    assert.strictEqual(ADJUSTMENT_TYPES.THRESHOLD_TIGHTEN, 'threshold-tighten');
    assert.strictEqual(ADJUSTMENT_TYPES.THRESHOLD_LOOSEN, 'threshold-loosen');
    assert.strictEqual(ADJUSTMENT_TYPES.RULE_DISABLE, 'rule-disable');
    assert.strictEqual(ADJUSTMENT_TYPES.RULE_ENABLE, 'rule-enable');
    assert.strictEqual(ADJUSTMENT_TYPES.CONDITION_UPDATE, 'condition-update');
  });
});

// ─── BusinessOntologyModel 升级后的条件评估测试 ──────────────────

describe('BusinessOntologyModel - Enhanced Condition Evaluation', () => {

  it('should evaluate simple comparison', () => {
    const model = new BusinessOntologyModel();
    model.defineEntityType('Test', { properties: { value: { type: 'number' } } });
    model.addBusinessRule('simple', { entityType: 'Test', ruleType: 'threshold', condition: 'value > 10', action: 'alert' });

    const result = model.evaluateRules('Test', { value: 15 });
    assert.strictEqual(result.passed.length, 1);
    assert.strictEqual(result.failed.length, 0);
    model.shutdown();
  });

  it('should evaluate AND compound condition', () => {
    const model = new BusinessOntologyModel();
    model.defineEntityType('Test', { properties: { a: { type: 'number' }, b: { type: 'number' } } });
    model.addBusinessRule('compound-and', { entityType: 'Test', ruleType: 'threshold', condition: 'a > 10 AND b < 100', action: 'alert' });

    const pass = model.evaluateRules('Test', { a: 15, b: 50 });
    assert.strictEqual(pass.passed.length, 1);

    const fail = model.evaluateRules('Test', { a: 15, b: 150 });
    assert.strictEqual(fail.failed.length, 1);
    model.shutdown();
  });

  it('should evaluate OR compound condition', () => {
    const model = new BusinessOntologyModel();
    model.defineEntityType('Test', { properties: { a: { type: 'number' }, b: { type: 'number' } } });
    model.addBusinessRule('compound-or', { entityType: 'Test', ruleType: 'threshold', condition: 'a > 100 OR b < 10', action: 'alert' });

    const pass1 = model.evaluateRules('Test', { a: 150, b: 50 });
    assert.strictEqual(pass1.passed.length, 1);

    const pass2 = model.evaluateRules('Test', { a: 50, b: 5 });
    assert.strictEqual(pass2.passed.length, 1);

    const fail = model.evaluateRules('Test', { a: 50, b: 50 });
    assert.strictEqual(fail.failed.length, 1);
    model.shutdown();
  });

  it('should evaluate NOT condition', () => {
    const model = new BusinessOntologyModel();
    model.defineEntityType('Test', { properties: { active: { type: 'boolean' } } });
    model.addBusinessRule('not-rule', { entityType: 'Test', ruleType: 'validation', condition: "NOT active == 'true'", action: 'warn' });

    const result = model.evaluateRules('Test', { active: 'false' });
    assert.strictEqual(result.passed.length, 1);
    model.shutdown();
  });

  it('should evaluate nested parentheses', () => {
    const model = new BusinessOntologyModel();
    model.defineEntityType('Test', { properties: { a: { type: 'number' }, b: { type: 'number' }, c: { type: 'string' } } });
    model.addBusinessRule('nested', { entityType: 'Test', ruleType: 'threshold', condition: "(a > 10 OR b < 5) AND c == 'active'", action: 'alert' });

    const pass = model.evaluateRules('Test', { a: 15, b: 50, c: 'active' });
    assert.strictEqual(pass.passed.length, 1);

    const fail = model.evaluateRules('Test', { a: 15, b: 50, c: 'inactive' });
    assert.strictEqual(fail.failed.length, 1);
    model.shutdown();
  });

  it('should evaluate time window condition', () => {
    const model = new BusinessOntologyModel();
    model.defineEntityType('Test', { properties: { createdAt: { type: 'string' } } });
    model.addBusinessRule('time-window', { entityType: 'Test', ruleType: 'validation', condition: 'createdAt:within(30d)', action: 'process' });

    const recent = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
    const pass = model.evaluateRules('Test', { createdAt: recent });
    assert.strictEqual(pass.passed.length, 1);

    const old = new Date(Date.now() - 100 * 86400000).toISOString(); // 100 days ago
    const fail = model.evaluateRules('Test', { createdAt: old });
    assert.strictEqual(fail.failed.length, 1);
    model.shutdown();
  });

  it('should evaluate exists/empty conditions', () => {
    const model = new BusinessOntologyModel();
    model.defineEntityType('Test', { properties: { name: { type: 'string' } } });
    model.addBusinessRule('exists-rule', { entityType: 'Test', ruleType: 'validation', condition: 'name:exists', action: 'ok' });

    const pass = model.evaluateRules('Test', { name: 'hello' });
    assert.strictEqual(pass.passed.length, 1);

    const fail = model.evaluateRules('Test', { name: null });
    assert.strictEqual(fail.failed.length, 1);
    model.shutdown();
  });

  it('should evaluate contains condition', () => {
    const model = new BusinessOntologyModel();
    model.defineEntityType('Test', { properties: { desc: { type: 'string' } } });
    model.addBusinessRule('contains-rule', { entityType: 'Test', ruleType: 'validation', condition: "desc:contains('error')", action: 'flag' });

    const pass = model.evaluateRules('Test', { desc: 'found an error in log' });
    assert.strictEqual(pass.passed.length, 1);

    const fail = model.evaluateRules('Test', { desc: 'all good' });
    assert.strictEqual(fail.failed.length, 1);
    model.shutdown();
  });

  it('should evaluate between condition', () => {
    const model = new BusinessOntologyModel();
    model.defineEntityType('Test', { properties: { score: { type: 'number' } } });
    model.addBusinessRule('between-rule', { entityType: 'Test', ruleType: 'threshold', condition: 'score:between(0, 100)', action: 'ok' });

    const pass = model.evaluateRules('Test', { score: 50 });
    assert.strictEqual(pass.passed.length, 1);

    const fail = model.evaluateRules('Test', { score: 150 });
    assert.strictEqual(fail.failed.length, 1);
    model.shutdown();
  });

  it('should evaluate aggregation conditions', () => {
    const model = new BusinessOntologyModel();
    model.defineEntityType('Test', { properties: { items: { type: 'array' }, orders: { type: 'array' } } });
    model.addBusinessRule('count-rule', { entityType: 'Test', ruleType: 'threshold', condition: 'count(items) > 2', action: 'alert' });
    model.addBusinessRule('sum-rule', { entityType: 'Test', ruleType: 'threshold', condition: 'sum(orders.amount) >= 1000', action: 'flag' });
    model.addBusinessRule('avg-rule', { entityType: 'Test', ruleType: 'threshold', condition: 'avg(orders.amount) >= 80', action: 'ok' });

    const result = model.evaluateRules('Test', {
      items: [1, 2, 3],
      orders: [
        { amount: 100 },
        { amount: 500 },
        { amount: 600 },
      ],
    });

    assert.strictEqual(result.passed.length, 3);
    model.shutdown();
  });
});
