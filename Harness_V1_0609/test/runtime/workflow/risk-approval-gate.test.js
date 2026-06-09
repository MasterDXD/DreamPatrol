'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('RiskBasedApprovalGate (comprehensive)', () => {
  const RiskBasedApprovalGate = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'risk-approval-gate'));

  it('should expose RISK_LEVELS constant', () => {
    assert.deepStrictEqual(RiskBasedApprovalGate.RISK_LEVELS, ['low', 'medium', 'high', 'critical']);
  });

  it('should construct with default config', () => {
    const gate = new RiskBasedApprovalGate();
    assert.strictEqual(gate._riskRules.size, 0);
    assert.strictEqual(gate._autoApproveThreshold, 'low');
    gate.shutdown();
  });

  it('should construct with custom autoApproveThreshold', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'medium' });
    assert.strictEqual(gate._autoApproveThreshold, 'medium');
    gate.shutdown();
  });

  it('should construct with null config', () => {
    const gate = new RiskBasedApprovalGate(null);
    assert.strictEqual(gate._autoApproveThreshold, 'low');
    gate.shutdown();
  });

  it('should define risk level for operation', () => {
    const gate = new RiskBasedApprovalGate();
    gate.defineRiskLevel('file-write', 'medium', 'File modifications');
    assert.strictEqual(gate._riskRules.size, 1);
    const rule = gate._riskRules.get('file-write');
    assert.strictEqual(rule.riskLevel, 'medium');
    assert.strictEqual(rule.reason, 'File modifications');
    gate.shutdown();
  });

  it('should overwrite existing risk level definition', () => {
    const gate = new RiskBasedApprovalGate();
    gate.defineRiskLevel('op', 'low', 'First');
    gate.defineRiskLevel('op', 'high', 'Second');
    const rule = gate._riskRules.get('op');
    assert.strictEqual(rule.riskLevel, 'high');
    assert.strictEqual(rule.reason, 'Second');
    gate.shutdown();
  });

  it('should enforce MAX_RISK_RULES limit', () => {
    const gate = new RiskBasedApprovalGate();
    for (let i = 0; i < 100; i++) {
      gate.defineRiskLevel('op-' + i, 'low', 'Rule ' + i);
    }
    assert.strictEqual(gate._riskRules.size, 100);
    gate.defineRiskLevel('extra', 'low', 'Extra rule');
    assert.strictEqual(gate._riskRules.size, 100);
    gate.shutdown();
  });

  it('should allow overwriting within limit', () => {
    const gate = new RiskBasedApprovalGate();
    for (let i = 0; i < 100; i++) {
      gate.defineRiskLevel('op-' + i, 'low', 'Rule ' + i);
    }
    gate.defineRiskLevel('op-0', 'high', 'Updated');
    assert.strictEqual(gate._riskRules.size, 100);
    assert.strictEqual(gate._riskRules.get('op-0').riskLevel, 'high');
    gate.shutdown();
  });

  it('should require approval for null action', () => {
    const gate = new RiskBasedApprovalGate();
    assert.strictEqual(gate.requiresApproval(null), true);
    gate.shutdown();
  });

  it('should require approval for undefined action', () => {
    const gate = new RiskBasedApprovalGate();
    assert.strictEqual(gate.requiresApproval(undefined), true);
    gate.shutdown();
  });

  it('should require approval for non-object action', () => {
    const gate = new RiskBasedApprovalGate();
    assert.strictEqual(gate.requiresApproval('string'), true);
    assert.strictEqual(gate.requiresApproval(123), true);
    gate.shutdown();
  });

  it('should require approval for unknown operations', () => {
    const gate = new RiskBasedApprovalGate();
    assert.strictEqual(gate.requiresApproval({ operation: 'unknown-op' }), true);
    gate.shutdown();
  });

  it('should auto-approve low risk when threshold is low', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'low' });
    gate.defineRiskLevel('read', 'low', 'Read-only');
    assert.strictEqual(gate.requiresApproval({ operation: 'read' }), false);
    gate.shutdown();
  });

  it('should require approval for medium risk when threshold is low', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'low' });
    gate.defineRiskLevel('write', 'medium', 'Write');
    assert.strictEqual(gate.requiresApproval({ operation: 'write' }), true);
    gate.shutdown();
  });

  it('should auto-approve low and medium when threshold is medium', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'medium' });
    gate.defineRiskLevel('read', 'low', 'Read');
    gate.defineRiskLevel('write', 'medium', 'Write');
    assert.strictEqual(gate.requiresApproval({ operation: 'read' }), false);
    assert.strictEqual(gate.requiresApproval({ operation: 'write' }), false);
    gate.shutdown();
  });

  it('should require approval for high risk when threshold is medium', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'medium' });
    gate.defineRiskLevel('deploy', 'high', 'Deploy');
    assert.strictEqual(gate.requiresApproval({ operation: 'deploy' }), true);
    gate.shutdown();
  });

  it('should always require approval for critical risk', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'critical' });
    gate.defineRiskLevel('delete-all', 'critical', 'Delete everything');
    assert.strictEqual(gate.requiresApproval({ operation: 'delete-all' }), true);
    gate.shutdown();
  });

  it('should auto-approve high risk when threshold is high', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'high' });
    gate.defineRiskLevel('deploy', 'high', 'Deploy');
    assert.strictEqual(gate.requiresApproval({ operation: 'deploy' }), false);
    gate.shutdown();
  });

  it('should use tool field as fallback for operation', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'low' });
    gate.defineRiskLevel('my-tool', 'low', 'Tool op');
    assert.strictEqual(gate.requiresApproval({ tool: 'my-tool' }), false);
    gate.shutdown();
  });

  it('should prefer operation field over tool field', () => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'low' });
    gate.defineRiskLevel('op-a', 'low', 'Op A');
    gate.defineRiskLevel('tool-b', 'high', 'Tool B');
    assert.strictEqual(gate.requiresApproval({ operation: 'op-a', tool: 'tool-b' }), false);
    gate.shutdown();
  });

  it('should list risk rules', () => {
    const gate = new RiskBasedApprovalGate();
    gate.defineRiskLevel('op-a', 'low', 'A');
    gate.defineRiskLevel('op-b', 'high', 'B');
    const rules = gate.listRiskRules();
    assert.strictEqual(rules.length, 2);
    const opA = rules.find(r => r.operation === 'op-a');
    assert.strictEqual(opA.riskLevel, 'low');
    assert.strictEqual(opA.reason, 'A');
    gate.shutdown();
  });

  it('should emit risk-defined event', (t, done) => {
    const gate = new RiskBasedApprovalGate();
    gate.on('risk-defined', (data) => {
      assert.strictEqual(data.operation, 'test-op');
      assert.strictEqual(data.riskLevel, 'medium');
      assert.strictEqual(data.reason, 'Test reason');
      gate.shutdown();
      done();
    });
    gate.defineRiskLevel('test-op', 'medium', 'Test reason');
  });

  it('should emit risk-assessed event for known operation', (t, done) => {
    const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'low' });
    gate.defineRiskLevel('known-op', 'low', 'Known');
    gate.on('risk-assessed', (data) => {
      assert.strictEqual(data.operation, 'known-op');
      assert.strictEqual(data.riskLevel, 'low');
      assert.strictEqual(data.requiresApproval, false);
      gate.shutdown();
      done();
    });
    gate.requiresApproval({ operation: 'known-op' });
  });

  it('should emit risk-assessed event for unknown operation', (t, done) => {
    const gate = new RiskBasedApprovalGate();
    gate.on('risk-assessed', (data) => {
      assert.strictEqual(data.operation, 'unknown-op');
      assert.strictEqual(data.riskLevel, 'unknown');
      assert.strictEqual(data.requiresApproval, true);
      gate.shutdown();
      done();
    });
    gate.requiresApproval({ operation: 'unknown-op' });
  });

  it('should shutdown cleanly', () => {
    const gate = new RiskBasedApprovalGate();
    gate.defineRiskLevel('op', 'low', 'Test');
    gate.shutdown();
    assert.strictEqual(gate._riskRules.size, 0);
    assert.strictEqual(gate._autoApproveThreshold, 'low');
  });
});
