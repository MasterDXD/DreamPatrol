'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');

const BUSINESS_REFLECTION_DIMENSIONS = [
  'business_impact',
  'customer_satisfaction',
  'cost_efficiency',
  'compliance',
  'feedback_quality',
];

const MAX_FEEDBACK_HISTORY = 500;
const FEEDBACK_TRIM_TO = 400;

/**
 * @module runtime/workflow/business-goal
 * @classdesc 业务目标管理器（BusinessGoal）。KPI追踪、目标分解、进度评估。
 * BusinessGoal — 业务目标管理器
 * 追踪业务KPI（目标值/当前值），管理反馈源及其可信度评分，
 * 计算目标达成率为已达标KPI占比，记录带来源归因的反馈，
 * 暴露五个业务反思维度（影响、满意度、效率、合规、反馈质量）供自评估集成使用。
 *
 * @extends EventEmitter
 * @emits BusinessGoal#kpi-defined
 * @emits BusinessGoal#kpi-updated
 * @emits BusinessGoal#feedback-recorded
 */
class BusinessGoal extends EventEmitter {
  /**
   * @param {Object} [config] - 配置选项
   */
  constructor(config) {
    super();
    this._businessKpis = new Map();
    this._feedbackSources = new Map();
    this._feedbackHistory = [];
    this._config = config ?? {};
    this._maxKpis = 100;
    this._maxFeedbackSources = 50;
  }

  /**
   * 定义业务KPI指标。
   * @param {string} kpiId - KPI唯一标识符
   * @param {string} name - KPI显示名称
   * @param {number} target - KPI目标值
   * @param {string} unit - KPI度量单位
   * @returns {void}
   * @fires BusinessGoal#kpi-defined
   */
  defineKpi(kpiId, name, target, unit) {
    if (!kpiId || typeof kpiId !== 'string') throw new Error('defineKpi: kpiId must be a non-empty string');
    if (typeof name !== 'string') throw new Error('defineKpi: name must be a string');
    if (typeof target !== 'number' || !isFinite(target)) throw new Error('defineKpi: target must be a finite number');
    this.guardShutdown();
    if (this._businessKpis.size >= this._maxKpis && !this._businessKpis.has(kpiId)) return;
    if (this._businessKpis.has(kpiId)) {
      const existing = this._businessKpis.get(kpiId);
      this._businessKpis.set(kpiId, { name, target, current: existing.current, unit });
      return;
    }
    this._businessKpis.set(kpiId, { name, target, current: null, unit });
    this.emit('kpi-defined', { kpiId, name, target, unit });
  }

  /**
   * 更新KPI当前值。
   * @param {string} kpiId - KPI唯一标识符
   * @param {number} currentValue - KPI当前值
   * @returns {void}
   * @fires BusinessGoal#kpi-updated
   */
  updateKpi(kpiId, currentValue) {
    if (!kpiId || typeof kpiId !== 'string') throw new Error('updateKpi: kpiId must be a non-empty string');
    if (typeof currentValue !== 'number' || !isFinite(currentValue)) throw new Error('updateKpi: currentValue must be a finite number');
    this.guardShutdown();
    const kpi = this._businessKpis.get(kpiId);
    if (!kpi) return;
    kpi.current = currentValue;
    this.emit('kpi-updated', { kpiId, current: currentValue, target: kpi.target });
  }

  /**
   * 计算目标达成率（已达标KPI数 / 总KPI数）。
   * 当current >= target时视为达标；目标为0或null的KPI不计入达标。
   * @returns {number} 达成率，0~1之间
   */
  measureGoalAchievement() {
    if (this._businessKpis.size === 0) return 0;
    const measurable = [...this._businessKpis.values()].filter(kpi => kpi.current !== null);
    const achieved = measurable.filter(kpi => Number.isFinite(kpi.current) && Number.isFinite(kpi.target) && kpi.current >= kpi.target).length;
    const total = measurable.length;
    return total > 0 ? achieved / total : 0;
  }

  /**
   * 注册反馈源及其元信息。
   * @param {string} sourceId - 反馈源唯一标识符
   * @param {Object} meta - 反馈源元信息
   * @param {string} [meta.type='unknown'] - 反馈源类型
   * @param {number} [meta.credibility=0.5] - 可信度评分（0~1）
   * @returns {void}
   */
  registerFeedbackSource(sourceId, meta) {
    this.guardShutdown();
    if (!meta || typeof meta !== 'object') return;
    if (this._feedbackSources.size >= this._maxFeedbackSources && !this._feedbackSources.has(sourceId)) return;
    this._feedbackSources.set(sourceId, {
      type: meta.type || 'unknown',
      credibility: meta.credibility !== undefined ? meta.credibility : 0.5,
      lastUpdate: null,
    });
  }

  /**
   * 记录来自指定反馈源的反馈。历史记录超过上限时自动裁剪。
   * @param {string} sourceId - 反馈源唯一标识符（必须已注册）
   * @param {*} feedback - 反馈内容
   * @returns {void}
   * @fires BusinessGoal#feedback-recorded
   */
  recordFeedback(sourceId, feedback) {
    this.guardShutdown();
    const source = this._feedbackSources.get(sourceId);
    if (!source) return;
    source.lastUpdate = Date.now();
    this._feedbackHistory.push({
      sourceId,
      feedback,
      credibility: source.credibility,
      recordedAt: Date.now(),
    });
    if (this._feedbackHistory.length > MAX_FEEDBACK_HISTORY) {
      this._feedbackHistory = this._feedbackHistory.slice(-FEEDBACK_TRIM_TO);
    }
    this.emit('feedback-recorded', { sourceId, feedback });
  }

  /**
   * 获取业务反思维度列表。
   * @returns {string[]} 反思维度名称数组
   */
  getBusinessDimensions() {
    return BUSINESS_REFLECTION_DIMENSIONS.slice();
  }

  /**
   * 获取所有KPI的摘要信息。
   * @returns {Object<string, {name: string, target: number, current: number|null, unit: string}>}
   */
  getKpiSummary() {
    const result = {};
    for (const [id, kpi] of this._businessKpis) {
      result[id] = { name: kpi.name, target: kpi.target, current: kpi.current, unit: kpi.unit };
    }
    return result;
  }

  /**
   * 获取最近的反馈历史记录。
   * @param {number} [limit=50] - 返回的最大记录数
   * @returns {Array} 反馈记录数组
   */
  getFeedbackHistory(limit) {
    const n = limit ?? 50;
    return this._feedbackHistory.slice(-n);
  }

  _onShutdown() {
    this._businessKpis.clear();
    this._feedbackSources.clear();
    this._feedbackHistory.length = 0;
    this.removeAllListeners();
  }
}

BusinessGoal.BUSINESS_REFLECTION_DIMENSIONS = BUSINESS_REFLECTION_DIMENSIONS;

module.exports = withShutdown(BusinessGoal);
