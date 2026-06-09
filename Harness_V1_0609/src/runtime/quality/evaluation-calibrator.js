'use strict';

const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * @description 评估校准器——融合自Anthropic Harness设计理念中的Self-Evaluation偏差校正。
 * 追踪模型声称的置信度vs实际通过率，生成校准曲线，
 * 根据历史校准数据自动调整评估阈值，防止模型系统性地高估自身产出质量。
 *
 * 核心机制：
 * - 记录每次评估的置信度和实际结果
 * - 计算校准误差（calibration error）：声称置信度与实际通过率的偏差
 * - 当检测到系统性高估时，自动提高评估阈值
 * - 提供校准报告供Harness迁移性引擎参考
 */
class EvaluationCalibrator {
  /**
   * @param {object} [options]
   * @param {number} [options.windowSize=50] - 滑动窗口大小
   * @param {number} [options.overestimateThreshold=0.15] - 高估检测阈值（置信度-通过率>此值视为高估）
   * @param {number} [options.adjustmentFactor=0.05] - 阈值调整步长
   * @param {number} [options.maxThresholdAdjustment=0.3] - 最大阈值调整幅度
   */
  constructor(options) {
    const opts = options ?? {};
    this._windowSize = opts.windowSize ?? 50;
    this._overestimateThreshold = opts.overestimateThreshold ?? 0.15;
    this._adjustmentFactor = opts.adjustmentFactor ?? 0.05;
    this._maxThresholdAdjustment = opts.maxThresholdAdjustment ?? 0.3;

    this._records = []; // { confidence, passed, timestamp }
    this._thresholdAdjustment = 0;
    this._calibrationError = 0;
  }

  /**
   * 记录一次评估结果。
   * @param {number} confidence - 模型声称的置信度(0-1)
   * @param {boolean} passed - 实际是否通过
   */
  record(confidence, passed) {
    this.guardShutdown();
    this._records.push({ confidence, passed, timestamp: Date.now() });
    if (this._records.length > this._windowSize) {
      this._records.splice(0, this._records.length - this._windowSize);
    }
    this._recalibrate();
  }

  /**
   * 获取校准后的评估阈值。
   * @param {number} baseThreshold - 基础阈值
   * @returns {number} 校准后的阈值
   */
  getCalibratedThreshold(baseThreshold) {
    return Math.min(1, baseThreshold + this._thresholdAdjustment);
  }

  /**
   * 获取校准报告。
   * @returns {object}
   */
  getCalibrationReport() {
    this.guardShutdown();
    const total = this._records.length;
    if (total === 0) {
      return { sampleSize: 0, calibrationError: 0, thresholdAdjustment: 0, bias: 'unknown' };
    }

    const avgConfidence = this._records.reduce(function(s, r) { return s + r.confidence; }, 0) / total;
    const passRate = this._records.filter(function(r) { return r.passed; }).length / total;
    const bias = this._calibrationError > this._overestimateThreshold ? 'overestimate'
      : this._calibrationError < -this._overestimateThreshold ? 'underestimate'
      : 'calibrated';

    return {
      sampleSize: total,
      avgConfidence: Math.round(avgConfidence * 1000) / 1000,
      passRate: Math.round(passRate * 1000) / 1000,
      calibrationError: Math.round(this._calibrationError * 1000) / 1000,
      thresholdAdjustment: Math.round(this._thresholdAdjustment * 1000) / 1000,
      bias,
    };
  }

  _recalibrate() {
    const total = this._records.length;
    if (total < 5) return;

    const avgConfidence = this._records.reduce(function(s, r) { return s + r.confidence; }, 0) / total;
    const passRate = this._records.filter(function(r) { return r.passed; }).length / total;
    this._calibrationError = avgConfidence - passRate;

    // 检测系统性高估：置信度显著高于实际通过率
    if (this._calibrationError > this._overestimateThreshold) {
      this._thresholdAdjustment = Math.min(
        this._maxThresholdAdjustment,
        this._thresholdAdjustment + this._adjustmentFactor,
      );
    } else if (this._calibrationError < -this._overestimateThreshold) {
      // 低估时降低阈值
      this._thresholdAdjustment = Math.max(
        -this._maxThresholdAdjustment,
        this._thresholdAdjustment - this._adjustmentFactor,
      );
    } else {
      // 校准良好时缓慢回归
      this._thresholdAdjustment *= 0.95;
    }
  }

  _onShutdown() {
    this._records = [];
    this._thresholdAdjustment = 0;
    this._calibrationError = 0;
  }
}

module.exports = withShutdown(EvaluationCalibrator);
