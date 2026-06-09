'use strict';

/**
 * TDD循环追踪器。监控RED→GREEN→REFACTOR状态转换，记录每次循环的详细数据，
 * 提供循环效率分析和质量趋势统计。
 *
 * @module gate/tdd-cycle-tracker
 * @example
 * const tracker = new TddCycleTracker();
 * tracker.startCycle('login-feature');
 * tracker.transition('GREEN'); // RED→GREEN
 * tracker.transition('REFACTOR'); // GREEN→REFACTOR
 * tracker.completeCycle();
 * const stats = tracker.getStats();
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../utils/shutdown-mixin');
const { timestampId } = require('../utils/unique-id');

/**
 * TDD循环阶段常量。
 * @enum {string}
 */
const TDD_PHASES = {
  RED: 'RED',
  GREEN: 'GREEN',
  REFACTOR: 'REFACTOR',
};

/**
 * 有效阶段转换映射。
 */
const VALID_TRANSITIONS = {
  [TDD_PHASES.RED]: [TDD_PHASES.GREEN],
  [TDD_PHASES.GREEN]: [TDD_PHASES.REFACTOR, TDD_PHASES.RED],
  [TDD_PHASES.REFACTOR]: [TDD_PHASES.RED, TDD_PHASES.GREEN],
};

/**
 * @classdesc TDD循环追踪器。管理RED-GREEN-REFACTOR循环的状态转换、耗时记录和统计分析。
 * @extends EventEmitter
 */
class TddCycleTracker extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxCycles=100] - 最大记录循环数
   * @param {number} [options.redPhaseWarningMs=300000] - RED阶段警告阈值（毫秒）
   */
  constructor(options = {}) {
    super();
    this._options = Object.assign({}, {
      maxCycles: 100,
      redPhaseWarningMs: 300000,
    }, options);
    this._activeCycle = null;
    this._cycleHistory = [];
    this._stats = {
      totalCycles: 0,
      successfulCycles: 0,
      failedCycles: 0,
      totalRedDuration: 0,
      totalGreenDuration: 0,
      totalRefactorDuration: 0,
      totalTestCount: 0,
      totalCoverageSum: 0,
    };
    this._shutDown = false;
  }

  /**
   * 开始新的TDD循环。
   * @param {string} featureName - 功能名称
   * @param {Object} [metadata] - 附加元数据
   * @returns {{ cycleId: string, phase: string, startedAt: number }}
   */
  startCycle(featureName, metadata = {}) {
    this.guardShutdown();
    if (this._activeCycle) {
      this._completeCycleInternal(false, 'interrupted');
    }
    const cycleId = timestampId();
    this._activeCycle = {
      cycleId,
      featureName,
      phase: TDD_PHASES.RED,
      startedAt: Date.now(),
      phaseStartedAt: Date.now(),
      phaseDurations: { RED: 0, GREEN: 0, REFACTOR: 0 },
      transitions: [{ from: 'START', to: TDD_PHASES.RED, at: Date.now() }],
      testCount: 0,
      coverage: 0,
      metadata,
    };
    this.emit('cycleStarted', { cycleId, featureName });
    return { cycleId, phase: TDD_PHASES.RED, startedAt: this._activeCycle.startedAt };
  }

  /**
   * 阶段转换。从当前阶段转换到目标阶段，验证转换合法性。
   * @param {string} targetPhase - 目标阶段（RED/GREEN/REFACTOR）
   * @param {Object} [data] - 转换附带数据
   * @param {number} [data.testCount] - 当前测试数量
   * @param {number} [data.coverage] - 当前覆盖率
   * @returns {{ success: boolean, from: string, to: string }}
   * @throws {Error} 当无活动循环或转换非法时
   */
  transition(targetPhase, data = {}) {
    this.guardShutdown();
    if (!this._activeCycle) {
      throw new Error('No active TDD cycle. Call startCycle() first.');
    }
    const currentPhase = this._activeCycle.phase;
    const validTargets = VALID_TRANSITIONS[currentPhase] ?? [];
    if (!validTargets.includes(targetPhase)) {
      throw new Error(
        `Invalid TDD transition: ${currentPhase} → ${targetPhase}. ` +
        `Valid transitions from ${currentPhase}: ${validTargets.join(', ')}`,
      );
    }

    const now = Date.now();
    const phaseDuration = now - this._activeCycle.phaseStartedAt;
    this._activeCycle.phaseDurations[currentPhase] += phaseDuration;

    this._activeCycle.transitions.push({
      from: currentPhase,
      to: targetPhase,
      at: now,
      duration: phaseDuration,
    });

    this._activeCycle.phase = targetPhase;
    this._activeCycle.phaseStartedAt = now;

    if (typeof data.testCount === 'number') {
      this._activeCycle.testCount = data.testCount;
    }
    if (typeof data.coverage === 'number') {
      this._activeCycle.coverage = data.coverage;
    }

    this.emit('phaseTransitioned', {
      cycleId: this._activeCycle.cycleId,
      from: currentPhase,
      to: targetPhase,
      duration: phaseDuration,
    });

    return { success: true, from: currentPhase, to: targetPhase };
  }

  /**
   * 完成当前TDD循环。
   * @param {Object} [data] - 完成数据
   * @param {boolean} [data.success=true] - 是否成功完成
   * @param {number} [data.finalCoverage] - 最终覆盖率
   * @returns {{ success: boolean, cycleId: string, summary: Object }}
   */
  completeCycle(data = {}) {
    this.guardShutdown();
    if (!this._activeCycle) {
      return { success: false, reason: 'no_active_cycle' };
    }
    const result = this._completeCycleInternal(data.success !== false, data.reason || 'completed');
    if (typeof data.finalCoverage === 'number') {
      result.coverage = data.finalCoverage;
    }
    return { success: true, cycleId: result.cycleId, summary: result };
  }

  /**
   * 内部完成循环逻辑。
   * @private
   * @param {boolean} success - 是否成功
   * @param {string} reason - 完成原因
   * @returns {Object}
   */
  _completeCycleInternal(success, reason) {
    const cycle = this._activeCycle;
    const now = Date.now();
    const phaseDuration = now - cycle.phaseStartedAt;
    cycle.phaseDurations[cycle.phase] += phaseDuration;
    cycle.completedAt = now;
    cycle.totalDuration = now - cycle.startedAt;
    cycle.success = success;
    cycle.completionReason = reason;

    this._cycleHistory.push(cycle);
    if (this._cycleHistory.length > this._options.maxCycles) {
      this._cycleHistory.shift();
    }

    this._stats.totalCycles++;
    if (success) {
      this._stats.successfulCycles++;
    } else {
      this._stats.failedCycles++;
    }
    this._stats.totalRedDuration += cycle.phaseDurations.RED;
    this._stats.totalGreenDuration += cycle.phaseDurations.GREEN;
    this._stats.totalRefactorDuration += cycle.phaseDurations.REFACTOR;
    this._stats.totalTestCount += cycle.testCount;
    this._stats.totalCoverageSum += cycle.coverage;

    this._activeCycle = null;
    this.emit('cycleCompleted', { cycleId: cycle.cycleId, success, duration: cycle.totalDuration });

    return cycle;
  }

  /**
   * 中止当前循环。
   * @param {string} [reason='aborted'] - 中止原因
   * @returns {boolean}
   */
  abortCycle(reason = 'aborted') {
    this.guardShutdown();
    if (!this._activeCycle) return false;
    this._completeCycleInternal(false, reason);
    return true;
  }

  /**
   * 获取当前循环状态。
   * @returns {Object|null}
   */
  getCurrentCycle() {
    if (!this._activeCycle) return null;
    return {
      cycleId: this._activeCycle.cycleId,
      featureName: this._activeCycle.featureName,
      phase: this._activeCycle.phase,
      startedAt: this._activeCycle.startedAt,
      phaseDurations: Object.assign({}, this._activeCycle.phaseDurations),
      transitions: this._activeCycle.transitions.slice(),
    };
  }

  /**
   * 获取循环历史记录。
   * @param {number} [limit] - 返回最近N条
   * @returns {Object[]}
   */
  getHistory(limit) {
    const history = this._cycleHistory.slice();
    if (limit != null) return history.slice(-limit);
    return history;
  }

  /**
   * 获取统计信息。
   * @returns {Object}
   */
  getStats() {
    const avgCoverage = this._stats.totalCycles > 0
      ? Math.round((this._stats.totalCoverageSum / this._stats.totalCycles) * 100) / 100
      : 0;
    const successRate = this._stats.totalCycles > 0
      ? Math.round((this._stats.successfulCycles / this._stats.totalCycles) * 100) / 100
      : 0;
    const avgRedDuration = this._stats.totalCycles > 0
      ? Math.round(this._stats.totalRedDuration / this._stats.totalCycles)
      : 0;
    const avgGreenDuration = this._stats.totalCycles > 0
      ? Math.round(this._stats.totalGreenDuration / this._stats.totalCycles)
      : 0;
    const avgRefactorDuration = this._stats.totalCycles > 0
      ? Math.round(this._stats.totalRefactorDuration / this._stats.totalCycles)
      : 0;

    return {
      totalCycles: this._stats.totalCycles,
      successfulCycles: this._stats.successfulCycles,
      failedCycles: this._stats.failedCycles,
      successRate,
      avgCoverage,
      avgRedDuration,
      avgGreenDuration,
      avgRefactorDuration,
      hasActiveCycle: !!this._activeCycle,
    };
  }

  /**
   * 关闭时清理资源。
   */
  _onShutdown() {
    if (this._activeCycle) {
      this._completeCycleInternal(false, 'shutdown');
    }
    this._cycleHistory = [];
    this.removeAllListeners();
  }
}

TddCycleTracker.TDD_PHASES = TDD_PHASES;

module.exports = withShutdown(TddCycleTracker);
