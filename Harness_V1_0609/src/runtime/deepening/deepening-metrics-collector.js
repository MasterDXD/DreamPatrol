'use strict';
const DeepeningBase = require('./deepening-base');
const safeAssign = require('../../utils/safe-assign');

/**
 * @module runtime/deepening/deepening-metrics-collector
 * 时序指标采集器。记录质量分数、收敛率、迭代时长、Agent性能和Token使用量，
 * 支持按类型的有界存储、标签过滤的时序查询、统计聚合、直方图生成及仪表盘摘要。
 */

/**
 * 时序指标采集器 — 为深化管道提供多类型指标记录与查询能力。
 * 记录质量分数、收敛率、迭代时长、Agent性能和Token使用量，
 * 支持按类型的有界存储、标签过滤的时序查询、统计聚合（min/max/avg）、
 * 直方图生成及仪表盘摘要（含运行时间和收敛率）。
 *
 * @classdesc 深化指标采集器。执行指标、质量指标、资源指标采集
 * @extends DeepeningBase
 * @emits 'flushed' 当指标数据刷新时触发，附带 {totalMetrics}
 */
class DeepeningMetricsCollector extends DeepeningBase {
  /**
   * 指标类型枚举。
   * @constant {Object}
   * @property {string} QUALITY_SCORE - 质量分数指标
   * @property {string} CONVERGENCE_RATE - 收敛率指标
   * @property {string} ITERATION_DURATION - 迭代时长指标
   * @property {string} AGENT_PERFORMANCE - Agent性能指标
   */
  static METRIC_TYPES = { QUALITY_SCORE: 'quality-score', CONVERGENCE_RATE: 'convergence-rate', ITERATION_DURATION: 'iteration-duration', AGENT_PERFORMANCE: 'agent-performance' };

  /**
   * 创建 DeepeningMetricsCollector 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxPointsPerType=1000] - 每种类型的最大数据点数
   */
  constructor(options) {
    super(options);
    this._metrics = new Map();
    this._maxPointsPerType = typeof (options && options.maxPointsPerType) === 'number' && Number.isFinite(options.maxPointsPerType) ? options.maxPointsPerType : 1000;
    this._startTime = Date.now();
  }

  /**
   * 记录一条指标数据。
   * @param {string} type - 指标类型
   * @param {number} value - 指标值
   * @param {Object} [tags] - 标签键值对
   * @returns {boolean} 记录成功返回 true，参数无效返回 false
   */
  record(type, value, tags) {
    this.guardShutdown();
    if (type == null || type === '' || !Number.isFinite(value)) return false;
    if (!this._metrics.has(type)) this._metrics.set(type, []);
    const arr = this._metrics.get(type);
    arr.push({ value, tags: tags ?? {}, timestamp: Date.now() });
    if (arr.length > this._maxPointsPerType) arr.splice(0, arr.length - this._maxPointsPerType);
    return true;
  }

  /**
   * 记录迭代相关指标（质量分数和迭代时长）。
   * @param {string} execId - 执行标识
   * @param {Object} data - 迭代数据
   * @param {number} [data.qualityScore] - 质量分数
   * @param {number} [data.duration] - 迭代时长
   * @param {number} [data.tokensUsed] - Token使用量
   */
  recordIteration(execId, data) {
    if (!data) return;
    this.record(DeepeningMetricsCollector.METRIC_TYPES.QUALITY_SCORE, typeof data.qualityScore === 'number' && Number.isFinite(data.qualityScore) ? data.qualityScore : 0, { executionId: execId });
    this.record(DeepeningMetricsCollector.METRIC_TYPES.ITERATION_DURATION, typeof data.duration === 'number' && Number.isFinite(data.duration) ? data.duration : 0, { executionId: execId });
    if (data.tokensUsed) this.record('tokens-used', data.tokensUsed, { executionId: execId });
  }

  /**
   * 记录收敛指标。
   * @param {string} execId - 执行标识
   * @param {Object} data - 收敛数据
   * @param {boolean} data.converged - 是否收敛
   */
  recordConvergence(execId, data) { if (!data) return; this.record(DeepeningMetricsCollector.METRIC_TYPES.CONVERGENCE_RATE, data.converged ? 1 : 0, { executionId: execId }); }

  /**
   * 记录Agent性能指标。
   * @param {string} agentId - Agent标识
   * @param {Object} data - 性能数据
   * @param {number} [data.score] - 性能分数
   */
  recordAgentPerformance(agentId, data) { if (!data) return; this.record(DeepeningMetricsCollector.METRIC_TYPES.AGENT_PERFORMANCE, typeof data.score === 'number' && Number.isFinite(data.score) ? data.score : 0, { agentId }); }

  /**
   * 获取指定类型的时序数据，支持标签过滤。
   * @param {string} type - 指标类型
   * @param {Object} [options] - 查询选项
   * @param {Object} [options.tags] - 标签过滤条件，键值对必须完全匹配
   * @returns {Array<Object>} 时序数据数组 [{value, tags, timestamp}]
   */
  getTimeSeries(type, options) {
    const pts = this._metrics.get(type) ?? [];
    if (options && options.tags) { return pts.filter(p => { for (const [k, v] of Object.entries(options.tags)) { if (p.tags[k] !== v) return false; } return true; }).map(p => ({ value: p.value, tags: safeAssign({}, p.tags), timestamp: p.timestamp })); }
    return pts.map(p => ({ value: p.value, tags: safeAssign({}, p.tags), timestamp: p.timestamp }));
  }

  /**
   * 获取指定类型的统计聚合信息。
   * @param {string} type - 指标类型
   * @returns {Object} 聚合统计 {count, min, max, average}
   */
  getAggregates(type) {
    const pts = this._metrics.get(type) ?? [];
    if (!pts.length) return { count: 0, min: 0, max: 0, average: 0 };
    const vals = pts.map(p => p.value).filter(v => typeof v === 'number' && Number.isFinite(v));
    if (vals.length === 0) return { count: 0, min: 0, max: 0, average: 0 };
    let min = vals[0];
    let max = vals[0];
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] < min) min = vals[i];
      if (vals[i] > max) max = vals[i];
    }
    return { count: vals.length, min: min, max: max, average: vals.reduce((a, b) => a + b, 0) / vals.length };
  }

  /**
   * 获取指定类型的直方图数据。
   * @param {string} type - 指标类型
   * @returns {Object} 直方图数据 {buckets: {p50, p95}}
   */
  getHistogram(type) {
    const agg = this.getAggregates(type);
    return { buckets: { p50: agg.average, p95: agg.max } };
  }

  /**
   * 获取仪表盘摘要，包含运行时间、指标总数和收敛率。
   * @returns {Object} 仪表盘数据 {uptime, totalMetrics, convergenceRate}
   */
  getDashboard() { return { uptime: Date.now() - this._startTime, totalMetrics: this._totalMetrics(), convergenceRate: this._convergenceRate() }; }

  /**
   * 计算所有类型的指标数据点总数。
   * @returns {number} 数据点总数
   * @private
   */
  _totalMetrics() { let c = 0; for (const v of this._metrics.values()) c += v.length; return c; }

  /**
   * 计算收敛率（收敛指标的平均值）。
   * @returns {number} 收敛率，0到1之间
   * @private
   */
  _convergenceRate() { const pts = this._metrics.get(DeepeningMetricsCollector.METRIC_TYPES.CONVERGENCE_RATE) ?? []; if (!pts.length) return 0; return pts.reduce((s, p) => s + p.value, 0) / pts.length; }

  /**
   * 重置所有指标数据。
   * @returns {void}
   */
  reset() { this._metrics.clear(); }

  /**
   * 刷新所有指标数据，返回快照并清空存储。
   * @returns {Map<string,Array>} 指标快照映射
   * @emits 'flushed' 刷新完成时触发，附带 {totalMetrics}
   */
  flush() {
    const snapshot = new Map();
    for (const [type, pts] of this._metrics) {
      snapshot.set(type, pts.slice());
    }
    const total = this._totalMetrics();
    this._metrics.clear();
    this.emit('flushed', { totalMetrics: total });
    return snapshot;
  }

  /**
   * 获取指标采集器的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalMetrics - 指标数据点总数
   */
  getStats() { return { totalMetrics: this._shutDown ? 0 : this._totalMetrics(), ...super.getStats() }; }

  /**
   * 关闭时的清理回调。刷新并清空指标数据。
   * @protected
   */
  _onShutdown() {
    this.flush();
    super._onShutdown();
  }
}
module.exports = DeepeningMetricsCollector;
