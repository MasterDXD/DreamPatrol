'use strict';
const DeepeningBase = require('./deepening-base');

/**
 * @module runtime/deepening/convergence-detector
 * 收敛检测器。检测迭代深化过程的收敛状态，评估质量分数、改进率、
 * 稳定性方差、维度平衡和质量退化，决定是否继续深化或停止。
 */
/**
 * @classdesc 收敛检测器。通过评估质量分数、改进率、稳定性方差、维度平衡和质量退化
 * 来判断迭代深化过程是否已收敛。支持质量阈值判定、稳定性检测、
 * 质量退化检测和维度平衡检测，向编排器发出收敛信号和建议。
 *
 * @extends DeepeningBase
 * @emits 'convergence-checked' 当收敛检测完成时触发，附带信号对象
 */
class ConvergenceDetector extends DeepeningBase {
  /**
   * 信号类型枚举。
   * @static
   * @type {{QUALITY_SCORE: string, IMPROVEMENT_RATE: string, STABILITY: string}}
   */
  static SIGNAL_TYPES = { QUALITY_SCORE: 'quality-score', IMPROVEMENT_RATE: 'improvement-rate', STABILITY: 'stability' };

  /**
   * 默认配置项。
   * @static
   * @type {{qualityThreshold: number, maxIterations: number, minImprovementRate: number, stabilityVariance: number, stabilityWindow: number, coverageThreshold: number, dimensionBalanceThreshold: number, qualityDegradationThreshold: number}}
   */
  static DEFAULT_CONFIG = { qualityThreshold: 0.85, maxIterations: 10, minImprovementRate: 0.01, stabilityVariance: 0.01, stabilityWindow: 3, coverageThreshold: 0.8, dimensionBalanceThreshold: 0.3, qualityDegradationThreshold: 0.1 };

  /**
   * 构造函数。
   * @param {Object} [options] - 配置选项，与DEFAULT_CONFIG合并
   * @param {number} [options.qualityThreshold=0.85] - 质量收敛阈值
   * @param {number} [options.maxIterations=10] - 最大迭代次数
   * @param {number} [options.stabilityVariance=0.01] - 稳定性方差阈值
   * @param {number} [options.stabilityWindow=3] - 稳定性检测窗口大小
   * @param {number} [options.dimensionBalanceThreshold=0.3] - 维度平衡阈值
   * @param {number} [options.qualityDegradationThreshold=0.1] - 质量退化阈值
   * @param {number} [options.maxHistoryExecutions=100] - 最大历史执行记录数
   */
  constructor(options) { super(options); this._options = { ...ConvergenceDetector.DEFAULT_CONFIG, ...this._options };
    for (const key of Object.keys(this._options)) {
      if (this._options[key] === undefined) this._options[key] = ConvergenceDetector.DEFAULT_CONFIG[key];
    } this._history = new Map(); this._maxHistoryExecutions = typeof (options && options.maxHistoryExecutions) === 'number' && Number.isFinite(options.maxHistoryExecutions) ? options.maxHistoryExecutions : 100; }

  /**
   * 安全数值获取，非有限数时返回回退值。
   * @param {*} v - 待检查的值
   * @param {number} fallback - 回退值
   * @returns {number} 安全数值
   */
  _safeNum(v, fallback) { return (typeof v === 'number' && Number.isFinite(v)) ? v : fallback; }

  /**
   * 确保指定执行ID的历史记录存在，超出容量时淘汰最早记录。
   * @param {string} executionId - 执行ID
   * @returns {Array|null} 历史记录数组，无效时返回null
   */
  _ensureHistory(executionId) {
    if (!this._history.has(executionId)) {
      this._history.set(executionId, []);
      if (this._history.size > this._maxHistoryExecutions) {
        const oldest = this._history.keys().next().value;
        this._history.delete(oldest);
      }
    }
    const hist = this._history.get(executionId);
    if (!Array.isArray(hist)) { this._history.set(executionId, []); return null; }
    return hist;
  }

  /**
   * 构建收敛信号对象，包含质量分数信号和维度平衡信号。
   * @param {number} q - 质量分数
   * @param {Object} dims - 维度评分对象
   * @returns {{qualityScore: {value: number, passed: boolean}, dimensionBalance?: {value: number, passed: boolean}}} 信号对象
   */
  _buildSignals(q, dims) {
    const signals = { qualityScore: { value: q, passed: q >= this._options.qualityThreshold } };
    const dimKeys = Object.keys(dims);
    if (dimKeys.length >= 2) {
      const dimValues = dimKeys.map(k => this._safeNum(dims[k], 0));
      const maxDim = dimValues.filter(v => Number.isFinite(v)).reduce((a, b) => Math.max(a, b), -Infinity);
      const minDim = dimValues.filter(v => Number.isFinite(v)).reduce((a, b) => Math.min(a, b), Infinity);
      signals.dimensionBalance = { value: maxDim - minDim, passed: (maxDim - minDim) <= this._options.dimensionBalanceThreshold };
    }
    return signals;
  }

  /**
   * 检测稳定性。在最近窗口内计算质量分数方差，判断是否已稳定收敛或进入平台期。
   * @param {Array} hist - 历史记录数组
   * @param {Object} signals - 当前信号对象
   * @returns {{converged: boolean, reason: string, signals: Object, recommendation: string}|null} 稳定性检测结果，未达窗口大小返回null
   */
  _checkStability(hist, signals) {
    if (hist.length < this._options.stabilityWindow) return null;
    const recent = hist.slice(-this._options.stabilityWindow);
    const scores = recent.map(h => this._safeNum(h.qualityScore, 0));
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((s, v) => s + (v - avg) ** 2, 0) / scores.length;
    if (variance < this._options.stabilityVariance && avg >= this._options.qualityThreshold * 0.9) {
      return { converged: true, reason: 'stable-and-sufficient', signals, recommendation: 'sufficient' };
    }
    if (variance < this._options.stabilityVariance) {
      return { converged: true, reason: 'plateau-detected', signals, recommendation: 'increase-depth' };
    }
    return null;
  }

  /**
   * 检测质量退化。当最新质量分数相比上一次下降超过退化阈值时触发。
   * @param {Array} hist - 历史记录数组
   * @param {number} q - 当前质量分数
   * @param {Object} signals - 当前信号对象
   * @returns {{converged: boolean, reason: string, signals: Object, recommendation: string}|null} 退化检测结果，无退化返回null
   */
  _checkDegradation(hist, q, signals) {
    if (hist.length < 2) return null;
    const prev = this._safeNum(hist[hist.length - 2].qualityScore, 0);
    if (q < prev - this._options.qualityDegradationThreshold) {
      return { converged: true, reason: 'quality-degrading', signals, recommendation: 'decrease-depth' };
    }
    return null;
  }

  /**
   * 执行收敛检测。依次检查质量阈值、最大迭代次数、稳定性和质量退化，
   * 返回收敛状态和建议。
   * @param {string} executionId - 执行ID
   * @param {Object} data - 检测数据
   * @param {number} data.qualityScore - 当前质量分数
   * @param {Object} [data.dimensions] - 维度评分对象
   * @returns {{converged: boolean, reason: string, signals: Object, recommendation: string}} 收敛检测结果
   * @throws {Error} When quality history is not an array
   * @emits 'convergence-checked'
   */
  check(executionId, data) {
    this.guardShutdown();
    if (!executionId || !data) { this.emit('convergence-checked', { signals: {} }); return { converged: false, reason: 'missing-data', signals: {} }; }
    const hist = this._ensureHistory(executionId);
    if (!hist) return { converged: false, reason: 'invalid-history', signals: {} };
    if (typeof data.qualityScore !== 'number' || !Number.isFinite(data.qualityScore)) {
      this.emit('convergence-checked', { signals: {} });
      return { converged: false, reason: 'invalid-quality-score', signals: {} };
    }
    hist.push(data);
    if (hist.length > (typeof this._options.maxIterations === 'number' && Number.isFinite(this._options.maxIterations) ? this._options.maxIterations : 50)) hist.shift();
    const q = this._safeNum(data.qualityScore, 0);
    const dims = data.dimensions ?? {};
    const signals = this._buildSignals(q, dims);
    if (q >= this._options.qualityThreshold) {
      const r = { converged: true, reason: 'quality-threshold-met', signals, recommendation: 'sufficient' };
      this.emit('convergence-checked', { signals }); return r;
    }
    if (hist.length >= this._options.maxIterations) {
      const r = { converged: false, reason: 'max-iterations-reached', signals, recommendation: 'increase-depth-or-abort' };
      this.emit('convergence-checked', { signals }); return r;
    }
    const stability = this._checkStability(hist, signals);
    if (stability) { this.emit('convergence-checked', { signals }); return stability; }
    const degradation = this._checkDegradation(hist, q, signals);
    if (degradation) { this.emit('convergence-checked', { signals }); return degradation; }
    const r = { converged: false, reason: 'not-converged', signals, recommendation: 'increase-depth' };
    this.emit('convergence-checked', { signals }); return r;
  }
  /**
   * 重置指定执行ID的历史记录。
   * @param {string} executionId - 执行ID
   * @returns {boolean} 是否成功重置
   */
  reset(executionId) { this.guardShutdown(); this._history.delete(executionId); return true; }

  /**
   * 获取收敛检测器运行统计信息。
   * @returns {{activeExecutions: number, config: Object, healthy: boolean, shutDown: boolean}} 统计信息
   */
  getStats() { return { activeExecutions: this._shutDown ? 0 : this._history.size, config: { ...this._options }, ...super.getStats() }; }

  /**
   * 关闭时清空所有历史记录。
   * @protected
   */
  _onShutdown() {
    this._history.clear();
    super._onShutdown();
  }
}
module.exports = ConvergenceDetector;
