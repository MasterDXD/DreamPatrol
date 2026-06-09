'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const ProductDefinitionGate = require('../../src/gate/product-definition-gate');

describe('ProductDefinitionGate', () => {
  it('should create instance with default options', () => {
    const gate = new ProductDefinitionGate();
    assert.ok(gate);
    const stats = gate.getStats();
    assert.strictEqual(stats.proposalsValidated, 0);
  });

  it('should create instance with custom options', () => {
    const gate = new ProductDefinitionGate({ strictMode: false });
    assert.ok(gate);
  });

  it('should pass valid proposal', () => {
    const gate = new ProductDefinitionGate();
    const result = gate.checkProposal({
      goals: 'Build AI coding assistant',
      nonGoals: 'No multi-agent; No private deployment; No mobile support',
      successMetrics: ['90% code accuracy', '<5s response time'],
      constraints: { budget: 5000 },
    });
    assert.strictEqual(result.passed, true);
    assert.ok(result.proposalId);
    assert.strictEqual(result.missingFields.length, 0);
  });

  it('should reject proposal missing required fields', () => {
    const gate = new ProductDefinitionGate();
    const result = gate.checkProposal({
      goals: 'Build something',
    });
    assert.strictEqual(result.passed, false);
    assert.ok(result.missingFields.length > 0);
    assert.ok(result.missingFields.includes('nonGoals'));
  });

  it('should reject null proposal', () => {
    const gate = new ProductDefinitionGate();
    const result = gate.checkProposal(null);
    assert.strictEqual(result.passed, false);
  });

  it('should warn about insufficient nonGoals', () => {
    const gate = new ProductDefinitionGate();
    const result = gate.checkProposal({
      goals: 'Build AI assistant',
      nonGoals: 'No mobile',
      successMetrics: ['accuracy'],
      constraints: {},
    });
    assert.ok(result.warnings.some(w => w.includes('nonGoals')));
  });

  it('should warn about goals/nonGoals overlap', () => {
    const gate = new ProductDefinitionGate();
    const result = gate.checkProposal({
      goals: 'Build AI assistant with multi-agent collaboration support features',
      nonGoals: 'No multi-agent collaboration support',
      successMetrics: ['accuracy'],
      constraints: {},
    });
    assert.ok(result.warnings.some(w => w.includes('overlap')));
  });

  it('should warn about non-quantifiable metrics', () => {
    const gate = new ProductDefinitionGate();
    const result = gate.checkProposal({
      goals: 'Build AI assistant',
      nonGoals: 'No mobile; No desktop; No API',
      successMetrics: ['good quality', 'fast response'],
      constraints: {},
    });
    assert.ok(result.warnings.some(w => w.includes('quantifiable')));
  });

  it('should pass valid MVP', () => {
    const gate = new ProductDefinitionGate();
    const proposalResult = gate.checkProposal({
      goals: 'Build AI assistant',
      nonGoals: 'No multi-agent; No private deploy',
      successMetrics: ['90% accuracy'],
      constraints: {},
    });

    const mvpResult = gate.checkMvp({
      coreCapabilities: ['code generation'],
      excludedCapabilities: ['multi-agent', 'private deployment'],
      scopeBoundary: 'Single agent code generation only',
      proposalId: proposalResult.proposalId,
    });
    assert.strictEqual(mvpResult.passed, true);
    assert.ok(mvpResult.mvpId);
  });

  it('should reject MVP with too many core capabilities', () => {
    const gate = new ProductDefinitionGate();
    const result = gate.checkMvp({
      coreCapabilities: ['code gen', 'debug', 'refactor', 'test', 'deploy'],
      excludedCapabilities: ['mobile'],
      scopeBoundary: 'All features',
    });
    assert.strictEqual(result.passed, false);
    assert.ok(result.violations.some(v => v.includes('scope creep')));
  });

  it('should reject MVP without excluded capabilities', () => {
    const gate = new ProductDefinitionGate();
    const result = gate.checkMvp({
      coreCapabilities: ['code gen'],
      excludedCapabilities: [],
      scopeBoundary: 'Code generation',
    });
    assert.strictEqual(result.passed, false);
  });

  it('should pass valid feasibility review', () => {
    const gate = new ProductDefinitionGate();
    const result = gate.checkFeasibility({
      modelCostEstimate: { monthlyBudget: 5000, estimatedMonthlyCost: 3000 },
      storageEstimate: { vectorDbLimit: 1000000, estimatedVectorCount: 500000 },
      compatibility: { desktopRequired: true, desktopTested: true },
      isolation: { multiTenant: true, isolationStrategy: 'namespace' },
    });
    assert.strictEqual(result.passed, true);
    assert.ok(result.reviewId);
  });

  it('should detect cost overrun in feasibility', () => {
    const gate = new ProductDefinitionGate();
    const result = gate.checkFeasibility({
      modelCostEstimate: { monthlyBudget: 1000, estimatedMonthlyCost: 5000 },
      storageEstimate: { vectorDbLimit: 1000000, estimatedVectorCount: 500000 },
      compatibility: { desktopRequired: true, desktopTested: true },
      isolation: { multiTenant: false },
    });
    assert.strictEqual(result.passed, false);
    assert.ok(result.risks.some(r => r.category === 'model-cost' && r.severity === 'critical'));
  });

  it('should detect missing isolation strategy', () => {
    const gate = new ProductDefinitionGate();
    const result = gate.checkFeasibility({
      modelCostEstimate: { monthlyBudget: 5000, estimatedMonthlyCost: 3000 },
      storageEstimate: { vectorDbLimit: 1000000, estimatedVectorCount: 500000 },
      compatibility: { desktopRequired: true, desktopTested: true },
      isolation: { multiTenant: true },
    });
    assert.ok(result.risks.some(r => r.category === 'isolation'));
  });

  it('should get validated proposals', () => {
    const gate = new ProductDefinitionGate();
    gate.checkProposal({
      goals: 'Test',
      nonGoals: 'No X; No Y',
      successMetrics: ['90% accuracy'],
      constraints: {},
    });
    const proposals = gate.getValidatedProposals();
    assert.strictEqual(proposals.length, 1);
  });

  it('should get review history', () => {
    const gate = new ProductDefinitionGate();
    gate.checkFeasibility({
      modelCostEstimate: { monthlyBudget: 5000, estimatedMonthlyCost: 3000 },
      storageEstimate: {},
      compatibility: {},
      isolation: {},
    });
    const history = gate.getReviewHistory();
    assert.strictEqual(history.length, 1);
  });

  it('should shutdown cleanly', () => {
    const gate = new ProductDefinitionGate();
    gate.shutdown();
    // shutdown后getStats()应抛出异常
    assert.throws(() => gate.getStats(), { code: 'SHUTDOWN' });
  });
});
