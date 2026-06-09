'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const MAX_RISK_RULES = 100;

/**
 * @module runtime/workflow/risk-approval-gate
 * @classdesc 风险审批门（RiskBasedApprovalGate）。高风险操作审批、影响评估、回滚预案。
 * RiskBasedApprovalGate — 风险审批门
 * Risk-level based approval gate that maps operations to risk levels (low, medium, high, critical)
 * and determines whether an action requires human approval based on a configurable auto-approve
 * threshold. Unknown operations default to requiring approval. Supports dynamic risk rule definition
 * and runtime threshold adjustment.
 * @extends EventEmitter
 * @emits risk-defined | risk-assessed
 */
class RiskBasedApprovalGate extends EventEmitter {
  /**
   * @param {Object} [config] - 配置选项
   * @param {string} [config.autoApproveThreshold='low'] - 自动审批阈值（low/medium/high/critical）
   */
  constructor(config) {
    super();
    this._riskRules = new Map();
    this._config = config ?? {};
    this._autoApproveThreshold = this._config.autoApproveThreshold ?? 'low';
  }

  /**
   * 定义操作的风险等级和原因。
   *
   * @param {string} operation - 操作标识
   * @param {string} riskLevel - 风险等级（low/medium/high/critical）
   * @param {string} [reason] - 风险定义原因
   * @returns {void}
   */
  defineRiskLevel(operation, riskLevel, reason) {
    this.guardShutdown();
    if (this._riskRules.size >= MAX_RISK_RULES && !this._riskRules.has(operation)) return;
    if (!RISK_LEVELS.includes(riskLevel)) { debug('RiskApprovalGate', 'defineRiskLevel', 'Invalid riskLevel: ' + riskLevel); return; }
    this._riskRules.set(operation, { riskLevel, reason });
    this.emit('risk-defined', { operation, riskLevel, reason });
  }

  /**
   * 判断指定操作是否需要人工审批。critical级别始终需要审批，
   * 其他级别根据autoApproveThreshold判断。未知操作默认需要审批。
   *
   * @param {Object} action - 操作对象，需包含operation或tool字段
   * @param {string} [action.operation] - 操作标识
   * @param {string} [action.tool] - 工具名称
   * @returns {boolean} 是否需要审批
   * @example
   * const gate = new RiskBasedApprovalGate({ autoApproveThreshold: 'low' });
   * gate.defineRiskLevel('deploy:production', 'critical', 'Production deployments are high-risk');
   * gate.requiresApproval({ operation: 'deploy:production' }); // true
   * gate.requiresApproval({ operation: 'deploy:staging' }); // true (unknown operation)
   */
  requiresApproval(action) {
    if (!action || typeof action !== 'object') return true;
    const operation = action.operation || action.tool;
    const rule = this._riskRules.get(operation);
    if (!rule) {
      this.emit('risk-assessed', { operation, riskLevel: 'unknown', requiresApproval: true });
      return true;
    }
    const actionLevel = RISK_LEVELS.indexOf(rule.riskLevel);
    if (actionLevel === -1) return true; // unknown risk level requires approval
    const thresholdLevel = RISK_LEVELS.indexOf(this._autoApproveThreshold);
    const required = rule.riskLevel === 'critical' || actionLevel > thresholdLevel;
    this.emit('risk-assessed', { operation, riskLevel: rule.riskLevel, requiresApproval: required });
    return required;
  }

  /**
   * 列出所有已定义的风险规则。
   *
   * @returns {Array<{operation: string, riskLevel: string, reason: string}>} 风险规则列表
   */
  listRiskRules() {
    const rules = [];
    for (const [operation, rule] of this._riskRules) {
      rules.push({ operation, riskLevel: rule.riskLevel, reason: rule.reason });
    }
    return rules;
  }

  _onShutdown() {
    this._riskRules.clear();
    this._config = {};
    this._autoApproveThreshold = 'low';
    this.removeAllListeners();
  }
}

RiskBasedApprovalGate.RISK_LEVELS = RISK_LEVELS;

module.exports = withShutdown(RiskBasedApprovalGate);
