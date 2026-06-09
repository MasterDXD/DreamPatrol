'use strict';

/**
 * 产品定义门禁 — 确保项目在开工前完成标准化产品定义，杜绝盲目开发。
 * 三大检查维度：
 * 1. Proposal标准化 — Goals/Non-Goals/视觉Vibe/业务约束/成功指标
 * 2. MVP边界锁定 — 最小可用版本范围确认，防止Scope蔓延
 * 3. 技术可行性评审 — 模型算力成本/存储上限/兼容性/多租户隔离
 *
 * @module gate/product-definition-gate
 * @example
 * const gate = new ProductDefinitionGate();
 * const result = gate.checkProposal({ goals: '...', nonGoals: '...', successMetrics: ['...'], constraints: {} });
 * // { passed: true, missingFields: [], warnings: [], proposalId: 'proposal-...' }
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../utils/shutdown-mixin');
const { debug } = require('../utils/debug-logger');
const BoundedArray = require('../utils/bounded-array');

/**
 * @classdesc 产品定义门禁。Proposal标准化、MVP边界锁定、技术可行性评审
 * 产品定义门禁执行器。确保项目在开工前完成标准化产品定义，
 * 包含Proposal标准化检查、MVP边界锁定检查、技术可行性评审三大维度。
 * @extends EventEmitter
 * @emits proposal-checked
 * @emits mvp-checked
 * @emits feasibility-checked
 */
class ProductDefinitionGate extends EventEmitter {
  /**
   * 创建产品定义门禁实例。
   * @param {object} [options] - 配置选项
   * @param {boolean} [options.strictMode=true] - 严格模式(缺字段则拒绝)
   * @param {Array<string>} [options.requiredProposalFields] - proposal必需字段
   * @param {Array<string>} [options.requiredMvpFields] - MVP必需字段
   * @param {Array<string>} [options.requiredFeasibilityFields] - 可行性评审必需字段
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._strictMode = opts.strictMode !== false;
    this._requiredProposalFields = opts.requiredProposalFields || ['goals', 'nonGoals', 'successMetrics', 'constraints'];
    this._requiredMvpFields = opts.requiredMvpFields || ['coreCapabilities', 'excludedCapabilities', 'scopeBoundary'];
    this._requiredFeasibilityFields = opts.requiredFeasibilityFields || ['modelCostEstimate', 'storageEstimate', 'compatibility', 'isolation'];

    this._proposals = new Map();
    /** 提案Map最大容量，防止内存泄漏 */
    this._maxProposals = 200;
    this._maxReviews = 200;
    this._reviews = new BoundedArray(this._maxReviews);
  }

  /**
   * 检查Non-Goals深度合规性。
   * @param {object} proposal - 产品提案
   * @param {string[]} warnings - 警告收集器
   * @private
   */
  _checkNonGoals(proposal, warnings) {
    if (proposal.nonGoals && typeof proposal.nonGoals === 'string') {
      const nonGoalCount = proposal.nonGoals.split(/[;；\n]/).filter(function(s) { return s.trim(); }).length;
      if (nonGoalCount < 2) {
        warnings.push('nonGoals should have at least 2 items to effectively prevent scope creep');
      }
    } else if (!proposal.nonGoals) {
      warnings.push('nonGoals is missing — scope creep risk is HIGH');
    }
  }

  /**
   * 检查Goals与Non-Goals重叠。
   * @param {object} proposal - 产品提案
   * @param {string[]} warnings - 警告收集器
   * @private
   */
  _checkGoalsOverlap(proposal, warnings) {
    if (!proposal.goals || !proposal.nonGoals) return;
    const goalWords = new Set(proposal.goals.toLowerCase().split(/\s+/));
    const nonGoalWords = new Set(proposal.nonGoals.toLowerCase().split(/\s+/));
    const overlap = [];
    for (const w of goalWords) {
      if (w.length > 3 && nonGoalWords.has(w)) {
        overlap.push(w);
      }
    }
    if (overlap.length > 2) {
      warnings.push('goals and nonGoals have significant overlap: ' + overlap.join(', '));
    }
  }

  /**
   * 检查成功指标可量化性。
   * @param {object} proposal - 产品提案
   * @param {string[]} warnings - 警告收集器
   * @private
   */
  _checkMetricsQuantifiable(proposal, warnings) {
    if (proposal.successMetrics && Array.isArray(proposal.successMetrics)) {
      const quantifiable = proposal.successMetrics.filter(function(m) { return /\d/.test(String(m)); });
      if (quantifiable.length === 0) {
        warnings.push('successMetrics should include quantifiable metrics');
      }
    }
  }

  /**
   * 验证产品提案(proposal)是否满足标准化要求。
   * @param {object} proposal - 产品提案
   * @param {string} proposal.goals - 核心目标
   * @param {string} proposal.nonGoals - 首期绝对不做的功能
   * @param {Array<string>} proposal.successMetrics - 成功指标
   * @param {object} [proposal.constraints] - 业务约束
   * @param {string} [proposal.visualVibe] - 视觉风格定义
   * @param {string} [proposal.projectName] - 项目名称
   * @returns {{ passed: boolean, missingFields: string[], warnings: string[], proposalId: string|null }}
   */
  checkProposal(proposal) {
    this.guardShutdown();
    if (!proposal || typeof proposal !== 'object') {
      return { passed: false, missingFields: this._requiredProposalFields.slice(), warnings: ['proposal is required'], proposalId: null };
    }

    const missingFields = [];
    const warnings = [];

    for (const field of this._requiredProposalFields) {
      if (!proposal[field]) {
        missingFields.push(field);
      }
    }

    this._checkNonGoals(proposal, warnings);
    this._checkGoalsOverlap(proposal, warnings);
    this._checkMetricsQuantifiable(proposal, warnings);

    const passed = this._strictMode ? missingFields.length === 0 : missingFields.length < this._requiredProposalFields.length;
    const proposalId = 'proposal-' + Date.now();

    if (passed) {
      if (this._proposals.size >= this._maxProposals) {
        const oldestKey = this._proposals.keys().next().value;
        this._proposals.delete(oldestKey);
      }
      const safeKeys = Object.keys(proposal).filter(function(k) { return k !== '__proto__' && k !== 'constructor' && k !== 'prototype'; });
      const safeProposal = {};
      for (const k of safeKeys) { safeProposal[k] = proposal[k]; }
      this._proposals.set(proposalId, Object.assign({}, safeProposal, { validatedAt: Date.now() }));
    }

    debug('ProductDefinitionGate', 'checkProposal', 'passed=' + passed + ' missing=' + missingFields.length);

    const result = { passed: passed, missingFields: missingFields, warnings: warnings, proposalId: passed ? proposalId : null };
    this.emit('proposal-checked', result);
    return result;
  }

  /**
   * 验证MVP定义是否满足边界锁定要求。
   * @param {object} mvp - MVP定义
   * @param {Array<string>} mvp.coreCapabilities - 核心能力列表(1-3个)
   * @param {Array<string>} mvp.excludedCapabilities - 明确排除的能力
   * @param {string} mvp.scopeBoundary - 范围边界描述
   * @param {string} [mvp.proposalId] - 关联的proposal ID
   * @returns {{ passed: boolean, violations: string[], mvpId: string|null }}
   */
  checkMvp(mvp) {
    this.guardShutdown();
    if (!mvp || typeof mvp !== 'object') {
      return { passed: false, violations: ['MVP definition is required'], mvpId: null };
    }

    const violations = [];

    // 检查必需字段
    for (const field of this._requiredMvpFields) {
      if (!mvp[field]) {
        violations.push('missing required field: ' + field);
      }
    }

    // 核心能力数量检查(MVP应限制1-3个核心能力)
    if (mvp.coreCapabilities && Array.isArray(mvp.coreCapabilities)) {
      if (mvp.coreCapabilities.length > 3) {
        violations.push('MVP core capabilities should be 1-3, got ' + mvp.coreCapabilities.length + ' — scope creep risk');
      }
      if (mvp.coreCapabilities.length === 0) {
        violations.push('MVP must have at least 1 core capability');
      }
    }

    // 排除能力检查
    if (mvp.excludedCapabilities && Array.isArray(mvp.excludedCapabilities)) {
      if (mvp.excludedCapabilities.length < 1) {
        violations.push('MVP should explicitly exclude at least 1 capability to prevent scope creep');
      }
    }

    // 关联proposal检查
    if (mvp.proposalId && !this._proposals.has(mvp.proposalId)) {
      violations.push('referenced proposalId not found — proposal must be validated first');
    }

    const passed = violations.length === 0;
    const mvpId = 'mvp-' + Date.now();

    debug('ProductDefinitionGate', 'checkMvp', 'passed=' + passed + ' violations=' + violations.length);

    const result = { passed: passed, violations: violations, mvpId: passed ? mvpId : null };
    this.emit('mvp-checked', result);
    return result;
  }

  /**
   * 评估模型成本风险。
   * @param {object} est - 模型成本估算数据
   * @param {Array<object>} risks - 风险收集器
   * @private
   */
  _assessModelCostRisk(est, risks) {
    if (est.monthlyBudget && est.estimatedMonthlyCost && est.estimatedMonthlyCost > est.monthlyBudget) {
      risks.push({
        category: 'model-cost',
        severity: 'critical',
        description: 'estimated cost exceeds budget by ' + Math.round((est.estimatedMonthlyCost / est.monthlyBudget - 1) * 100) + '%',
      });
    }
    if (est.tokenLimitPerRequest && est.tokenLimitPerRequest < 4000) {
      risks.push({ category: 'model-cost', severity: 'medium', description: 'token limit per request is very low, may impact output quality' });
    }
  }

  /**
   * 评估存储风险。
   * @param {object} est - 存储估算数据
   * @param {Array<object>} risks - 风险收集器
   * @private
   */
  _assessStorageRisk(est, risks) {
    if (est.vectorDbLimit && est.estimatedVectorCount && est.estimatedVectorCount > est.vectorDbLimit * 0.8) {
      risks.push({ category: 'storage', severity: 'high', description: 'estimated vector count approaching database limit' });
    }
  }

  /**
   * 评估兼容性风险。
   * @param {object} compat - 兼容性评估数据
   * @param {Array<object>} risks - 风险收集器
   * @private
   */
  _assessCompatibilityRisk(compat, risks) {
    if (compat.desktopRequired && !compat.desktopTested) {
      risks.push({ category: 'compatibility', severity: 'medium', description: 'desktop support required but not tested' });
    }
  }

  /**
   * 评估隔离风险。
   * @param {object} iso - 隔离需求数据
   * @param {Array<object>} risks - 风险收集器
   * @private
   */
  _assessIsolationRisk(iso, risks) {
    if (iso.multiTenant && !iso.isolationStrategy) {
      risks.push({ category: 'isolation', severity: 'high', description: 'multi-tenant mode requires isolation strategy' });
    }
  }

  /**
   * 执行技术可行性评审。
   * @param {object} feasibility - 可行性评审数据
   * @param {object} feasibility.modelCostEstimate - 模型算力成本估算
   * @param {object} feasibility.storageEstimate - 存储上限估算
   * @param {object} feasibility.compatibility - 兼容性评估
   * @param {object} feasibility.isolation - 多租户隔离需求
   * @param {string} [feasibility.proposalId] - 关联的proposal ID
   * @returns {{ passed: boolean, risks: Array<{category: string, severity: string, description: string}>, reviewId: string|null }}
   */
  checkFeasibility(feasibility) {
    this.guardShutdown();
    if (!feasibility || typeof feasibility !== 'object') {
      return {
        passed: false,
        risks: [{ category: 'general', severity: 'critical', description: 'feasibility review data is required' }],
        reviewId: null,
      };
    }

    const risks = [];

    // 检查必需字段
    for (const field of this._requiredFeasibilityFields) {
      if (!feasibility[field]) {
        risks.push({ category: field, severity: 'high', description: 'missing required field: ' + field });
      }
    }

    if (feasibility.modelCostEstimate != null) this._assessModelCostRisk(feasibility.modelCostEstimate, risks);
    if (feasibility.storageEstimate != null) this._assessStorageRisk(feasibility.storageEstimate, risks);
    if (feasibility.compatibility != null) this._assessCompatibilityRisk(feasibility.compatibility, risks);
    if (feasibility.isolation != null) this._assessIsolationRisk(feasibility.isolation, risks);

    const criticalRisks = risks.filter(function(r) { return r.severity === 'critical'; });
    const passed = criticalRisks.length === 0;
    const reviewId = 'review-' + Date.now();

    debug('ProductDefinitionGate', 'checkFeasibility', 'passed=' + passed + ' risks=' + risks.length);

    const result = { passed: passed, risks: risks, reviewId: passed ? reviewId : null };
    this._reviews.push(result);
    this.emit('feasibility-checked', result);
    return result;
  }

  /**
   * 获取已验证的提案列表。
   * @returns {Array<{proposalId: string, goals: string, validatedAt: number}>}
   */
  getValidatedProposals() {
    this.guardShutdown();
    const result = [];
    this._proposals.forEach(function(p, id) {
      result.push({ proposalId: id, goals: p.goals, validatedAt: p.validatedAt });
    });
    return result;
  }

  /**
   * 获取评审历史。
   * @returns {Array<object>}
   */
  getReviewHistory() {
    this.guardShutdown();
    return this._reviews.toArray();
  }

  /**
   * 获取门禁统计。
   * @returns {{ proposalsValidated: number, mvpChecks: number, feasibilityReviews: number, blockedCount: number }}
   */
  getStats() {
    this.guardShutdown();
    const reviews = this._reviews.toArray();
    return {
      proposalsValidated: this._proposals.size,
      mvpChecks: reviews.filter(function(r) { return r.reviewId && r.reviewId.startsWith('mvp'); }).length,
      feasibilityReviews: reviews.length,
      blockedCount: reviews.filter(function(r) { return !r.passed; }).length,
    };
  }

  /**
   * 关闭时清理资源。
   */
  _onShutdown() {
    this._proposals.clear();
    this._reviews.clear();
    this.removeAllListeners();
  }
}

module.exports = withShutdown(ProductDefinitionGate);
