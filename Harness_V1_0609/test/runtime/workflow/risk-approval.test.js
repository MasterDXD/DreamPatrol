'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('RiskBasedApprovalGate', () => {
  const RiskBasedApprovalGate = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'risk-approval-gate'));

  it('should construct with default config', () => {
    const gate = new RiskBasedApprovalGate();
    assert.strictEqual(gate._riskRules.size, 0);
    assert.strictEqual(gate._autoApproveThreshold, 'low');
    gate.shutdown();
  });

  it('should define risk level for operation', () => {
    const gate = new RiskBasedApprovalGate();
    gate.defineRiskLevel('file-write', 'medium', 'File modifications may affect project state');
    assert.strictEqual(gate._riskRules.size, 1);
    const rule = gate._riskRules.get('file-write');
    assert.strictEqual(rule.riskLevel, 'medium');
    gate.shutdown();
  });

  it('should require approval for unknown operations', () => {
    const gate = new RiskBasedApprovalGate();
    const required = gate.requiresApproval({ operation: 'unknown-op' });
    assert.strictEqual(required, true);
    gate.shutdown();
  });

  it('should auto-approve low risk operations', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'low' });
    gate.defineRiskLevel('read-file', 'low', 'Read-only operation');
    const required = gate.requiresApproval({ operation: 'read-file' });
    assert.strictEqual(required, false);
    gate.shutdown();
  });

  it('should require approval for medium risk when threshold is low', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'low' });
    gate.defineRiskLevel('file-write', 'medium', 'File write');
    const required = gate.requiresApproval({ operation: 'file-write' });
    assert.strictEqual(required, true);
    gate.shutdown();
  });

  it('should auto-approve medium risk when threshold is medium', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'medium' });
    gate.defineRiskLevel('file-write', 'medium', 'File write');
    const required = gate.requiresApproval({ operation: 'file-write' });
    assert.strictEqual(required, false);
    gate.shutdown();
  });

  it('should always require approval for critical risk', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'critical' });
    gate.defineRiskLevel('delete-database', 'critical', 'Database deletion');
    const required = gate.requiresApproval({ operation: 'delete-database' });
    assert.strictEqual(required, true);
    gate.shutdown();
  });

  it('should list risk rules', () => {
    const gate = new RiskBasedApprovalGate();
    gate.defineRiskLevel('op-a', 'low', 'Low risk');
    gate.defineRiskLevel('op-b', 'high', 'High risk');
    const rules = gate.listRiskRules();
    assert.strictEqual(rules.length, 2);
    gate.shutdown();
  });

  it('should emit risk-assessed event', () => {
    const gate = new RiskBasedApprovalGate();
    gate.defineRiskLevel('test-op', 'medium', 'Test');
    let emitted = false;
    gate.on('risk-assessed', () => { emitted = true; });
    gate.requiresApproval({ operation: 'test-op' });
    assert.ok(emitted);
    gate.shutdown();
  });

  it('should shutdown cleanly', () => {
    const gate = new RiskBasedApprovalGate();
    gate.defineRiskLevel('op', 'low', 'Test');
    gate.shutdown();
    assert.strictEqual(gate._riskRules.size, 0);
  });
});
