'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../utils/shutdown-mixin');

/**
 * @module gate/code-drift-detector
 * 代码漂移检测器。跨时间追踪架构偏离，比较违规快照检测趋势，
 * 监控违规增长率、模块耦合度和趋势方向。
 */

/** @constant {object} DRIFT_SEVERITY - 漂移严重度枚举 */
const DRIFT_SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/** @constant {object} DRIFT_TYPES - 漂移类型枚举 */
const DRIFT_TYPES = {
  ARCHITECTURE_VIOLATION: 'architecture_violation',
  DEPENDENCY_DRIFT: 'dependency_drift',
  PATTERN_DRIFT: 'pattern_drift',
  NAMING_DRIFT: 'naming_drift',
  STRUCTURE_DRIFT: 'structure_drift',
};

/**
 * @classdesc 代码漂移检测器。跨时间架构偏离追踪
 * 代码漂移检测器。跨时间追踪架构偏离，比较违规快照检测趋势，
 * 监控违规增长率、模块耦合度，并计算趋势方向（递增、递减、稳定）。
 * @extends EventEmitter
 */
class CodeDriftDetector extends EventEmitter {
  /**
   * 创建CodeDriftDetector实例。
   * @param {object} [options] - 配置选项
   * @param {number} [options.maxHistory=10] - 最大历史快照数
   * @param {number} [options.violationGrowthRate=0.5] - 违规增长率阈值
   * @param {number} [options.moduleCouplingScore=0.5] - 模块耦合度阈值
   */
  constructor(options) {
    super();
    this._history = [];
    this._maxHistory = typeof (options ?? {}).maxHistory === 'number' && Number.isFinite((options ?? {}).maxHistory) ? (options ?? {}).maxHistory : 10;
    this._violationGrowthRate = typeof (options ?? {}).violationGrowthRate === 'number' && Number.isFinite((options ?? {}).violationGrowthRate) ? (options ?? {}).violationGrowthRate : 0.5;
    this._moduleCouplingScore = typeof (options ?? {}).moduleCouplingScore === 'number' && Number.isFinite((options ?? {}).moduleCouplingScore) ? (options ?? {}).moduleCouplingScore : 0.5;
    this._baseline = null;
  }

  /**
   * 记录违规快照到历史记录。
   * @param {Array} [violations] - 当前违规列表
   * @param {object} [moduleStats] - 模块统计信息
   * @param {object} [couplingStats] - 耦合度统计信息
   */
  snapshot(violations, moduleStats, couplingStats) {
    this.guardShutdown();
    this._history.push({
      violations: violations ?? [],
      moduleStats: moduleStats ?? {},
      couplingStats: couplingStats ?? {},
      timestamp: Date.now(),
    });
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }
  }

  /**
   * 检测代码漂移，分析违规增长率和模块耦合度。
   * @returns {{drifting: boolean, trend: string, alerts: Array, reason: string}} 漂移检测结果
   * @throws {Error} When source code cannot be parsed
   */
  detectDrift() {
    this.guardShutdown();
    if (this._history.length < 2) {
      return { drifting: false, reason: 'insufficient_history', trend: 'stable', alerts: [] };
    }

    const alerts = [];
    let drifting = false;

    const prevEntry = this._history[this._history.length - 2];
    const currEntry = this._history[this._history.length - 1];
    const prevCount = prevEntry.violations.length;
    const currCount = currEntry.violations.length;

    if (prevCount === 0 && currCount > 0) {
      alerts.push({ type: 'violation_growth', from: prevCount, to: currCount });
      drifting = true;
    } else if (prevCount > 0 && currCount > prevCount) {
      const growthRate = (currCount - prevCount) / prevCount;
      if (growthRate > this._violationGrowthRate) {
        alerts.push({ type: 'violation_growth', growthRate: growthRate });
        drifting = true;
      }
    }

    const couplingKeys = Object.keys(currEntry.couplingStats);
    for (let i = 0; i < couplingKeys.length; i++) {
      const val = currEntry.couplingStats[couplingKeys[i]];
      if (typeof val === 'number' && Number.isFinite(val) && val > this._moduleCouplingScore) {
        alerts.push({ type: 'high_coupling', module: couplingKeys[i], score: val });
        drifting = true;
        break;
      }
    }

    const trend = this._computeTrend();

    return { drifting: drifting, trend: trend, alerts: alerts, reason: drifting ? 'drift_detected' : 'stable' };
  }

  _computeTrend() {
    if (this._history.length < 3) return 'stable';
    const counts = [];
    for (let i = 0; i < this._history.length; i++) {
      counts.push(this._history[i].violations.length);
    }
    const first = counts[0];
    const mid = counts[Math.floor(counts.length / 2)];
    const last = counts[counts.length - 1];
    if (last > mid && mid > first) return 'increasing';
    if (last < mid && mid < first) return 'decreasing';
    return 'stable';
  }

  /**
   * 获取历史快照列表的副本。
   * @returns {Array<object>} 历史快照列表
   */
  getHistory() {
    return this._history.slice();
  }

  /**
   * 设置基线快照，用于衡量偏离程度。
   * @param {object} baseline - 基线快照数据
   */
  setBaseline(baseline) {
    this.guardShutdown();
    this._baseline = baseline;
  }

  /**
   * 获取基线快照。
   * @returns {object|null} 基线快照数据
   */
  getBaseline() {
    return this._baseline;
  }

  /**
   * 获取当前阈值配置。
   * @returns {{violationGrowthRate: number, moduleCouplingScore: number}} 阈值配置
   */
  getThresholds() {
    return {
      violationGrowthRate: this._violationGrowthRate,
      moduleCouplingScore: this._moduleCouplingScore,
    };
  }

  _onShutdown() {
    this._history = [];
    this._baseline = null;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(CodeDriftDetector);
Object.assign(module.exports, { CodeDriftDetector, DRIFT_SEVERITY, DRIFT_TYPES });
