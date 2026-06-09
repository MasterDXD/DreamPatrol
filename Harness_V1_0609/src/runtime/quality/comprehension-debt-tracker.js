'use strict';

/**
 * @module runtime/quality/comprehension-debt-tracker
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug: _debug } = require('../../utils/debug-logger');

const DEBT_TYPES = {
  REQUIREMENT_AMBIGUITY: 'requirement-ambiguity',
  CONTEXT_MISMATCH: 'context-mismatch',
  IMPLICIT_ASSUMPTION: 'implicit-assumption',
  SPEC_GAP: 'spec-gap',
  DOMAIN_KNOWLEDGE_GAP: 'domain-knowledge-gap',
};

const DEBT_SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

const SEVERITY_SCORES = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
};

const RESOLUTION_STATES = {
  OPEN: 'open',
  IN_PROGRESS: 'in-progress',
  RESOLVED: 'resolved',
  ESCALATED: 'escalated',
};

const MAX_DEBTS = 1000;
const CRITICAL_THRESHOLD = 0.7;
const HIGH_THRESHOLD = 0.5;

/**
 * 理解债务追踪器
 * @classdesc 理解债务追踪器。5种债务类型×4级严重度×4种解决状态
 * 追踪5种债务类型×4级严重度×4种解决状态，
 * 提供债务评分、分布和解决率度量。
 *
 * @extends EventEmitter
 * @emits ComprehensionDebtTracker#debt-recorded 新债务记录时触发
 * @emits ComprehensionDebtTracker#debt-resolved 债务解决时触发
 * @emits ComprehensionDebtTracker#debt-escalated 债务升级时触发
 */
class ComprehensionDebtTracker extends EventEmitter {
  /**
   * 创建ComprehensionDebtTracker实例
   *
   * @param {Object} [options] - 配置选项
   * @param {number} [options.criticalThreshold=0.7] - 债务评分的critical级别阈值
   * @param {number} [options.highThreshold=0.5] - 债务评分的high级别阈值
   */
  constructor(options) {
    super();
    this._options = options ?? {};
    this._debts = new Map();
    this._criticalThreshold = this._options.criticalThreshold ?? CRITICAL_THRESHOLD;
    this._highThreshold = this._options.highThreshold ?? HIGH_THRESHOLD;
    this._nextId = 1;
  }

  /**
   * 记录新的理解债务。超过上限时优先淘汰已解决的旧债务。
   *
   * @param {Object} debtInfo - 债务信息
   * @param {string} [debtInfo.type='implicit-assumption'] - 债务类型
   * @param {string} [debtInfo.severity='medium'] - 严重度（critical/high/medium/low）
   * @param {string} [debtInfo.description=''] - 债务描述
   * @param {string} [debtInfo.source='unknown'] - 债务来源
   * @param {string} [debtInfo.taskId] - 关联任务ID
   * @param {string} [debtInfo.agentId] - 关联Agent ID
   * @param {Array} [debtInfo.evidence=[]] - 证据列表
   * @returns {Object|null} 创建的债务对象，参数无效时返回null
   */
  recordDebt(debtInfo) {
    this.guardShutdown();
    if (!debtInfo || typeof debtInfo !== 'object') {
      return null;
    }

    const id = 'debt-' + this._nextId++;
    const severity = debtInfo.severity ?? DEBT_SEVERITY.MEDIUM;
    const type = debtInfo.type ?? DEBT_TYPES.IMPLICIT_ASSUMPTION;
    if (!Object.values(DEBT_SEVERITY).includes(severity) || !Object.values(DEBT_TYPES).includes(type)) return null;
    const debt = {
      id,
      type,
      severity,
      severityScore: SEVERITY_SCORES[severity] ?? 0.5,
      description: debtInfo.description ?? '',
      source: debtInfo.source ?? 'unknown',
      taskId: debtInfo.taskId ?? null,
      agentId: debtInfo.agentId ?? null,
      evidence: debtInfo.evidence ?? [],
      resolutionState: RESOLUTION_STATES.OPEN,
      createdAt: Date.now(),
      resolvedAt: null,
      resolutionNote: null,
    };

    if (this._debts.size >= MAX_DEBTS) {
      this._evictOldestDebt();
    }

    this._debts.set(id, debt);
    this.emit('debt-recorded', debt);
    return debt;
  }

  /**
   * 将指定债务标记为已解决。
   *
   * @param {string} debtId - 债务ID
   * @param {string} [resolutionNote=''] - 解决说明
   * @returns {Object|null} 更新后的债务对象，不存在时返回null
   */
  resolveDebt(debtId, resolutionNote) {
    this.guardShutdown();
    const debt = this._debts.get(debtId);
    if (!debt) return null;
    debt.resolutionState = RESOLUTION_STATES.RESOLVED;
    debt.resolvedAt = Date.now();
    debt.resolutionNote = resolutionNote ?? '';
    this.emit('debt-resolved', { id: debtId, resolutionNote: debt.resolutionNote });
    return debt;
  }

  /**
   * 将指定债务升级为escalated状态。
   *
   * @param {string} debtId - 债务ID
   * @param {string} [reason=''] - 升级原因
   * @returns {Object|null} 更新后的债务对象，不存在时返回null
   */
  escalateDebt(debtId, reason) {
    this.guardShutdown();
    const debt = this._debts.get(debtId);
    if (!debt) return null;
    debt.resolutionState = RESOLUTION_STATES.ESCALATED;
    debt.resolutionNote = reason ?? '';
    this.emit('debt-escalated', { id: debtId, reason: debt.resolutionNote });
    return debt;
  }

  /**
   * 获取指定ID的债务对象。
   *
   * @param {string} debtId - 债务ID
   * @returns {Object|null} 债务对象，不存在时返回null
   */
  getDebt(debtId) {
    const debt = this._debts.get(debtId);
    return debt ? { ...debt, evidence: debt.evidence.slice() } : null;
  }

  /**
   * 获取所有未解决的债务（open和in-progress状态）。
   *
   * @returns {Array<Object>} 未解决债务数组
   */
  getOpenDebts() {
    const result = [];
    for (const debt of this._debts.values()) {
      if (debt.resolutionState === RESOLUTION_STATES.OPEN || debt.resolutionState === RESOLUTION_STATES.IN_PROGRESS) {
        result.push({ ...debt, evidence: debt.evidence.slice() });
      }
    }
    return result;
  }

  /**
   * 按债务类型筛选债务。
   *
   * @param {string} type - 债务类型
   * @returns {Array<Object>} 匹配的债务数组
   */
  getDebtsByType(type) {
    const result = [];
    for (const debt of this._debts.values()) {
      if (debt.type === type) result.push({ ...debt, evidence: debt.evidence.slice() });
    }
    return result;
  }

  /**
   * 按关联任务ID筛选债务。
   *
   * @param {string} taskId - 任务ID
   * @returns {Array<Object>} 匹配的债务数组
   */
  getDebtsByTask(taskId) {
    const result = [];
    for (const debt of this._debts.values()) {
      if (debt.taskId === taskId) result.push({ ...debt, evidence: debt.evidence.slice() });
    }
    return result;
  }

  /**
   * 计算债务评分。基于未解决债务的严重度加权平均，
   * 返回评分、等级和未解决数量。
   *
   * @returns {{score: number, level: string, openCount: number}} 债务评分结果
   */
  calculateDebtScore() {
    let totalWeight = 0;
    let openCount = 0;
    for (const debt of this._debts.values()) {
      if (debt.resolutionState !== RESOLUTION_STATES.RESOLVED) {
        totalWeight += debt.severityScore;
        openCount++;
      }
    }
    if (openCount === 0) return { score: 0, level: 'none', openCount: 0 };
    const score = Math.min(1, totalWeight / Math.max(1, openCount));
    let level;
    if (score >= this._criticalThreshold) level = 'critical';
    else if (score >= this._highThreshold) level = 'high';
    else level = 'manageable';
    return { score: Math.round(score * 1000) / 1000, level, openCount };
  }

  /**
   * 获取未解决债务的类型分布。
   *
   * @returns {Object<string, number>} 债务类型到数量的映射
   */
  getDebtDistribution() {
    const dist = {};
    for (const debt of this._debts.values()) {
      if (debt.resolutionState !== RESOLUTION_STATES.RESOLVED) {
        dist[debt.type] = (dist[debt.type] ?? 0) + 1;
      }
    }
    return dist;
  }

  /**
   * 计算债务解决率（已解决数/总数）。
   *
   * @returns {number} 解决率（0-1），无债务时返回1
   */
  getResolutionRate() {
    let total = 0;
    let resolved = 0;
    for (const debt of this._debts.values()) {
      total++;
      if (debt.resolutionState === RESOLUTION_STATES.RESOLVED) resolved++;
    }
    return total > 0 ? resolved / total : 1;
  }

  /**
   * 计算已解决债务的平均解决时间（毫秒）。
   *
   * @returns {number} 平均解决时间，无已解决债务时返回0
   */
  getAverageResolutionTimeMs() {
    let totalMs = 0;
    let count = 0;
    for (const debt of this._debts.values()) {
      if (debt.resolutionState === RESOLUTION_STATES.RESOLVED && debt.resolvedAt) {
        totalMs += debt.resolvedAt - debt.createdAt;
        count++;
      }
    }
    return count > 0 ? totalMs / count : 0;
  }

  _evictOldestDebt() {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [debtId, d] of this._debts) {
      if (d.resolutionState === RESOLUTION_STATES.RESOLVED && d.createdAt < oldestTime) {
        oldestTime = d.createdAt;
        oldestId = debtId;
      }
    }
    if (oldestId) {
      this._debts.delete(oldestId);
      return;
    }
    let oldestOpenId = null;
    let oldestOpenTime = Infinity;
    for (const [debtId, d] of this._debts) {
      if (d.createdAt < oldestOpenTime) {
        oldestOpenTime = d.createdAt;
        oldestOpenId = debtId;
      }
    }
    if (oldestOpenId) this._debts.delete(oldestOpenId);
  }

  _onShutdown() {
    this._debts.clear();
    this._nextId = 1;
    this._options = {};
    this._criticalThreshold = CRITICAL_THRESHOLD;
    this._highThreshold = HIGH_THRESHOLD;
    this.removeAllListeners();
  }
}

ComprehensionDebtTracker.DEBT_TYPES = DEBT_TYPES;
ComprehensionDebtTracker.DEBT_SEVERITY = DEBT_SEVERITY;
ComprehensionDebtTracker.RESOLUTION_STATES = RESOLUTION_STATES;

module.exports = withShutdown(ComprehensionDebtTracker);
