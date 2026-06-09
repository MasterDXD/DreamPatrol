'use strict';
const DeepeningBase = require('./deepening-base');

/**
 * @module runtime/deepening/deepening-report-generator
 * 深化管道报告生成器。生成六种类型的结构化报告：执行摘要、质量趋势、
 * 收敛分析、Agent性能、Token效率和完整综合报告。维护有界报告历史，
 * 每次生成时发出事件。
 */

/**
 * 深化管道报告生成器 — 为深化子系统提供多类型结构化报告生成能力。
 * 生成六种类型的结构化报告：执行摘要、质量趋势、收敛分析、
 * Agent性能、Token效率和完整综合报告。维护有界报告历史，
 * 每次生成时发出事件。
 *
 * @classdesc 深化报告生成器。执行报告、质量报告、趋势报告。
 * @extends DeepeningBase
 * @emits 'report-generated' 当报告生成时触发，附带报告对象
 */
class DeepeningReportGenerator extends DeepeningBase {
  /**
   * 报告类型枚举。
   * @constant {Object}
   * @property {string} EXECUTION_SUMMARY - 执行摘要报告
   * @property {string} QUALITY_TREND - 质量趋势报告
   * @property {string} CONVERGENCE_ANALYSIS - 收敛分析报告
   * @property {string} AGENT_PERFORMANCE - Agent性能报告
   * @property {string} TOKEN_EFFICIENCY - Token效率报告
   * @property {string} FULL_REPORT - 完整综合报告
   */
  static REPORT_TYPES = { EXECUTION_SUMMARY: 'execution-summary', QUALITY_TREND: 'quality-trend', CONVERGENCE_ANALYSIS: 'convergence-analysis', AGENT_PERFORMANCE: 'agent-performance', TOKEN_EFFICIENCY: 'token-efficiency', FULL_REPORT: 'full-report' };

  /**
   * 创建 DeepeningReportGenerator 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxHistory=100] - 最大报告历史记录数
   */
  constructor() {
    super();
    this._maxHistory = 100;
    this._history = [];
    this._generators = new Map([
      [DeepeningReportGenerator.REPORT_TYPES.EXECUTION_SUMMARY, (d) => this._executionSummary(d)],
      [DeepeningReportGenerator.REPORT_TYPES.QUALITY_TREND, (d) => this._qualityTrend(d)],
      [DeepeningReportGenerator.REPORT_TYPES.CONVERGENCE_ANALYSIS, (d) => this._convergenceAnalysis(d)],
      [DeepeningReportGenerator.REPORT_TYPES.AGENT_PERFORMANCE, (d) => this._agentPerformance(d)],
      [DeepeningReportGenerator.REPORT_TYPES.TOKEN_EFFICIENCY, (d) => this._tokenEfficiency(d)],
      [DeepeningReportGenerator.REPORT_TYPES.FULL_REPORT, (d) => this._fullReport(d)],
    ]);
  }

  /**
   * 生成指定类型的结构化报告。
   * @param {string} reportType - 报告类型（REPORT_TYPES 枚举值）
   * @param {Object} [data] - 报告数据
   * @returns {Object|null} 生成的报告对象，类型无效返回 null
   * @emits 'report-generated' 报告生成时触发，附带报告对象
   */
  generate(reportType, data) {
    this.guardShutdown();
    if (!reportType) return null;
    const gen = this._generators.get(reportType);
    if (!gen) return null;
    const safeData = data ?? {};
    const report = gen(safeData);
    this._history.push(report);
    if (this._history.length > this._maxHistory) this._history.splice(0, this._history.length - this._maxHistory);
    this.emit('report-generated', report);
    return report;
  }

  /**
   * 生成执行摘要报告。
   * @param {Object} data - 报告数据
   * @param {Array<Object>} [data.executions] - 执行记录数组
   * @param {boolean} [data.executions[].success] - 是否成功
   * @param {number} [data.executions[].bestScore] - 最佳分数
   * @returns {Object} 执行摘要报告 {type, totalExecutions, successfulExecutions, averageScore, data, generatedAt}
   * @private
   */
  _executionSummary(data) {
    const executions = data.executions ?? [];
    let successfulCount = 0;
    let totalScore = 0;
    for (const e of executions) {
      if (e.success) {
        successfulCount++;
        const s = e.bestScore ?? 0;
        totalScore += (typeof s === 'number' && Number.isFinite(s)) ? s : 0;
      }
    }
    return {
      type: DeepeningReportGenerator.REPORT_TYPES.EXECUTION_SUMMARY,
      totalExecutions: executions.length,
      successfulExecutions: successfulCount,
      averageScore: successfulCount ? totalScore / successfulCount : 0,
      data,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 生成质量趋势报告。
   * @param {Object} data - 报告数据
   * @param {Array<number>} [data.qualityScores] - 质量分数数组
   * @returns {Object} 质量趋势报告 {type, dataPoints, improvement, peakScore, data, generatedAt}
   * @private
   */
  _qualityTrend(data) {
    const rawScores = data.qualityScores ?? [];
    const scores = rawScores.map(s => (typeof s === 'number' && Number.isFinite(s)) ? s : 0);
    return {
      type: DeepeningReportGenerator.REPORT_TYPES.QUALITY_TREND,
      dataPoints: scores.length,
      improvement: scores.length >= 2 ? scores[scores.length - 1] - scores[0] : 0,
      peakScore: scores.length ? scores.reduce(function(a, b) { return a > b ? a : b; }, -Infinity) : 0,
      data,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 生成收敛分析报告。
   * @param {Object} data - 报告数据
   * @param {Array<Object>} [data.convergenceResults] - 收敛结果数组
   * @param {boolean} [data.convergenceResults[].converged] - 是否收敛
   * @returns {Object} 收敛分析报告 {type, totalChecks, convergedCount, convergenceRate, data, generatedAt}
   * @private
   */
  _convergenceAnalysis(data) {
    const results = data.convergenceResults ?? [];
    const converged = results.filter(r => r.converged);
    return {
      type: DeepeningReportGenerator.REPORT_TYPES.CONVERGENCE_ANALYSIS,
      totalChecks: results.length,
      convergedCount: converged.length,
      convergenceRate: results.length ? converged.length / results.length : 0,
      data,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 生成Agent性能报告。
   * @param {Object} data - 报告数据
   * @param {Array<Object>} [data.agentResults] - Agent结果数组
   * @param {string} [data.agentResults[].agentId] - Agent标识
   * @param {number} [data.agentResults[].score] - 性能分数
   * @param {number} [data.agentResults[].duration] - 执行时长
   * @returns {Object} Agent性能报告 {type, agentCount, agents, data, generatedAt}
   * @private
   */
  _agentPerformance(data) {
    const results = data.agentResults ?? [];
    const agentMap = {};
    for (const r of results) {
      if (!agentMap[r.agentId]) agentMap[r.agentId] = { scores: [], totalDuration: 0, count: 0 };
      agentMap[r.agentId].scores.push(Number.isFinite(r.score) ? r.score : 0);
      agentMap[r.agentId].totalDuration += Number.isFinite(r.duration) ? r.duration : 0;
      agentMap[r.agentId].count++;
    }
    const agents = {};
    for (const [id, info] of Object.entries(agentMap)) {
      agents[id] = { averageScore: info.scores.length ? info.scores.reduce((a, b) => a + b, 0) / info.scores.length : 0, totalDuration: info.totalDuration, executionCount: info.count };
    }
    return {
      type: DeepeningReportGenerator.REPORT_TYPES.AGENT_PERFORMANCE,
      agentCount: Object.keys(agentMap).length,
      agents,
      data,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 生成Token效率报告。
   * @param {Object} data - 报告数据
   * @param {Array<Object>} [data.tokenUsages] - Token使用记录数组
   * @param {number} [data.tokenUsages[].tokensUsed] - Token使用量
   * @param {number} [data.totalBudget=1] - Token总预算
   * @returns {Object} Token效率报告 {type, totalTokensUsed, budgetUtilization, data, generatedAt}
   * @private
   */
  _tokenEfficiency(data) {
    const usages = data.tokenUsages ?? [];
    const totalUsed = usages.reduce((s, u) => s + (Number.isFinite(u.tokensUsed) ? u.tokensUsed : 0), 0);
    const budget = data.totalBudget ?? 1;
    return {
      type: DeepeningReportGenerator.REPORT_TYPES.TOKEN_EFFICIENCY,
      totalTokensUsed: totalUsed,
      budgetUtilization: budget > 0 ? totalUsed / budget : 0,
      data,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 生成完整综合报告（包含所有子报告）。
   * @param {Object} data - 报告数据
   * @returns {Object} 完整综合报告 {type, executionSummary, qualityTrend, convergenceAnalysis, agentPerformance, tokenEfficiency, data, generatedAt}
   * @private
   */
  _fullReport(data) {
    return {
      type: DeepeningReportGenerator.REPORT_TYPES.FULL_REPORT,
      executionSummary: this._executionSummary(data),
      qualityTrend: this._qualityTrend(data),
      convergenceAnalysis: this._convergenceAnalysis(data),
      agentPerformance: this._agentPerformance(data),
      tokenEfficiency: this._tokenEfficiency(data),
      data,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 获取报告历史记录。
   * @returns {Array<Object>} 报告历史数组
   */
  getReportHistory() { return this._history.map(r => ({ ...r })); }

  /**
   * 获取报告生成器的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalReports - 累计生成报告数
   */
  getStats() {
    return {
      totalReports: this._history.length,
      ...super.getStats(),
    };
  }
}

module.exports = DeepeningReportGenerator;
