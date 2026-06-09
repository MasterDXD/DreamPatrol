'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EvaluationCalibrator = require('../../../src/runtime/quality/evaluation-calibrator');

describe('EvaluationCalibrator', () => {
  it('should use default options', () => {
    const cal = new EvaluationCalibrator();
    const report = cal.getCalibrationReport();
    assert.equal(report.sampleSize, 0);
    assert.equal(report.bias, 'unknown');
  });

  it('should accept custom options', () => {
    const cal = new EvaluationCalibrator({ windowSize: 10, overestimateThreshold: 0.2 });
    assert.ok(cal);
  });

  it('should record evaluations and recalculate', () => {
    const cal = new EvaluationCalibrator({ windowSize: 50 });
    cal.record(0.8, true);
    cal.record(0.9, false);
    cal.record(0.7, true);
    cal.record(0.6, true);
    cal.record(0.8, false);
    const report = cal.getCalibrationReport();
    assert.equal(report.sampleSize, 5);
    assert.ok(typeof report.avgConfidence === 'number');
    assert.ok(typeof report.passRate === 'number');
  });

  it('should detect overestimate bias', () => {
    const cal = new EvaluationCalibrator({ windowSize: 50, overestimateThreshold: 0.1 });
    // 高置信度但低通过率
    for (let i = 0; i < 10; i++) cal.record(0.9, false);
    const report = cal.getCalibrationReport();
    assert.equal(report.bias, 'overestimate');
    assert.ok(report.thresholdAdjustment > 0);
  });

  it('should detect underestimate bias', () => {
    const cal = new EvaluationCalibrator({ windowSize: 50, overestimateThreshold: 0.1 });
    // 低置信度但高通过率
    for (let i = 0; i < 10; i++) cal.record(0.3, true);
    const report = cal.getCalibrationReport();
    assert.equal(report.bias, 'underestimate');
    assert.ok(report.thresholdAdjustment < 0);
  });

  it('should calibrate threshold', () => {
    const cal = new EvaluationCalibrator();
    const base = 0.7;
    const calibrated = cal.getCalibratedThreshold(base);
    assert.ok(typeof calibrated === 'number');
    assert.ok(calibrated >= 0 && calibrated <= 1);
  });

  it('should trim records beyond windowSize', () => {
    const cal = new EvaluationCalibrator({ windowSize: 5 });
    for (let i = 0; i < 10; i++) cal.record(0.5, true);
    const report = cal.getCalibrationReport();
    assert.equal(report.sampleSize, 5);
  });

  it('should not recalibrate with fewer than 5 records', () => {
    const cal = new EvaluationCalibrator();
    cal.record(0.9, false);
    cal.record(0.9, false);
    const report = cal.getCalibrationReport();
    // With < 5 records, no recalibration happens
    assert.equal(report.thresholdAdjustment, 0);
  });

  it('should shutdown cleanly', () => {
    const cal = new EvaluationCalibrator();
    cal.record(0.5, true);
    cal.shutdown();
    assert.throws(() => cal.getCalibrationReport(), /shut down/i);
  });
});
