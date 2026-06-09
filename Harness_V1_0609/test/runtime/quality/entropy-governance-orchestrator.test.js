'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  EntropyGovernanceOrchestrator,
} = require('../../../src/runtime/quality/entropy-governance-orchestrator');
const { EventEmitter } = require('events');

// ─── Mock 指标源 ────────────────────────────────────────────────

function createMockContextDriftMonitor(score, level) {
  const m = new EventEmitter();
  m.getStats = () => ({ driftTrend: 'stable', snapshotsTaken: 1, driftsDetected: 0, constraintsRegistered: 5, constraintsLost: 0, highestDriftScore: score, activeConstraints: 5, currentTaskId: 't1', snapshotCount: 1 });
  m.checkDrift = () => ({ driftScore: score, level: level, violatedConstraints: 0, lostConstraints: 0, totalConstraints: 5, taskId: 't1' });
  return m;
}

function createMockDebtTracker(score, level, openCount) {
  const m = new EventEmitter();
  m.calculateDebtScore = () => ({ score: score, level: level, openCount: openCount });
  m.getDebtDistribution = () => ({ 'requirement-ambiguity': openCount });
  m.getResolutionRate = () => 0.5;
  return m;
}

function createMockCodeDriftDetector(drifting, trend, alertCount) {
  const m = new EventEmitter();
  m.detectDrift = () => ({ drifting: drifting, trend: trend, alerts: new Array(alertCount).fill({ type: 'violation_growth' }), reason: drifting ? 'drift_detected' : 'stable' });
  return m;
}

function createMockSkillReducer(overloadLevel, l2Cached, l1Count) {
  const m = new EventEmitter();
  m.getStats = () => ({ l2Cached: l2Cached, l1Count: l1Count, overloadDetections: 0, contextEstimate: { totalTokens: 1000 } });
  m.detectOverload = () => ({ level: overloadLevel });
  m.unloadAllL2 = () => l2Cached;
  return m;
}

function createMockTrustScorer(avgScore) {
  const m = new EventEmitter();
  m.getAverageScore = () => avgScore;
  m.getRiskDistribution = () => ({ 'no-tests': 2 });
  return m;
}

function createMockEfficiencyMeter(deviation, bottleneck) {
  const m = new EventEmitter();
  m.getEfficiencyMetrics = () => ({
    distributionDeviation: deviation,
    reviewBottleneckScore: bottleneck,
    aiAccelerationRatio: 0.8,
    codingRatio: 0.3,
  });
  return m;
}

// ─── 测试 ───────────────────────────────────────────────────────

describe('EntropyGovernanceOrchestrator - Construction & Assessment', () => {

  it('should create instance with default config', () => {
    const ego = new EntropyGovernanceOrchestrator();
    assert.ok(ego);
    assert.strictEqual(ego.getCurrentScore().score, 0);
    assert.strictEqual(ego.getCurrentScore().level, 'none');
    ego.shutdown();
  });

  it('should create instance with all metric sources', () => {
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.1, 'low'),
      comprehensionDebtTracker: createMockDebtTracker(0.2, 'manageable', 2),
      codeDriftDetector: createMockCodeDriftDetector(false, 'stable', 0),
      skillReducer: createMockSkillReducer('normal', 5, 20),
      aiCodeTrustScorer: createMockTrustScorer(0.8),
      deliveryEfficiencyMeter: createMockEfficiencyMeter(0.1, 0.2),
    });
    const stats = ego.getStats();
    assert.strictEqual(stats.sources.contextDriftMonitor, true);
    assert.strictEqual(stats.sources.comprehensionDebtTracker, true);
    assert.strictEqual(stats.sources.codeDriftDetector, true);
    assert.strictEqual(stats.sources.skillReducer, true);
    assert.strictEqual(stats.sources.aiCodeTrustScorer, true);
    assert.strictEqual(stats.sources.deliveryEfficiencyMeter, true);
    ego.shutdown();
  });

  it('should assess with low entropy when all metrics are healthy', () => {
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.05, 'none'),
      comprehensionDebtTracker: createMockDebtTracker(0.1, 'none', 0),
      codeDriftDetector: createMockCodeDriftDetector(false, 'stable', 0),
      skillReducer: createMockSkillReducer('normal', 3, 15),
      aiCodeTrustScorer: createMockTrustScorer(0.9),
      deliveryEfficiencyMeter: createMockEfficiencyMeter(0.05, 0.1),
    });
    const result = ego.assess();
    assert.ok(result.score < 0.3, 'Score should be low: ' + result.score);
    assert.ok(result.level === 'none' || result.level === 'low');
    ego.shutdown();
  });

  it('should assess with high entropy when metrics are unhealthy', () => {
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.9, 'critical'),
      comprehensionDebtTracker: createMockDebtTracker(0.8, 'critical', 10),
      codeDriftDetector: createMockCodeDriftDetector(true, 'increasing', 5),
      skillReducer: createMockSkillReducer('overloaded', 50, 100),
      aiCodeTrustScorer: createMockTrustScorer(0.2),
      deliveryEfficiencyMeter: createMockEfficiencyMeter(0.8, 0.9),
    });
    const result = ego.assess();
    assert.ok(result.score >= 0.5, 'Score should be high: ' + result.score);
    assert.ok(result.level === 'high' || result.level === 'critical');
    ego.shutdown();
  });

  it('should generate recommendations for high entropy', () => {
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.7, 'high'),
      comprehensionDebtTracker: createMockDebtTracker(0.8, 'critical', 8),
      codeDriftDetector: createMockCodeDriftDetector(true, 'increasing', 3),
      skillReducer: createMockSkillReducer('overloaded', 40, 80),
      aiCodeTrustScorer: createMockTrustScorer(0.3),
      deliveryEfficiencyMeter: createMockEfficiencyMeter(0.6, 0.7),
    });
    const result = ego.assess();
    assert.ok(result.recommendations.length >= 3, 'Should have multiple recommendations');
    const types = result.recommendations.map(r => r.type);
    assert.ok(types.includes('context-drift'));
    assert.ok(types.includes('comprehension-debt'));
    ego.shutdown();
  });

  it('should track history', () => {
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.2, 'low'),
    });
    ego.assess();
    ego.assess();
    ego.assess();
    const history = ego.getHistory();
    assert.strictEqual(history.length, 3);
    ego.shutdown();
  });

  it('should limit history with parameter', () => {
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.2, 'low'),
    });
    for (let i = 0; i < 5; i++) ego.assess();
    const limited = ego.getHistory(2);
    assert.strictEqual(limited.length, 2);
    ego.shutdown();
  });

  it('should calculate trend as stable with consistent scores', () => {
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.2, 'low'),
    });
    for (let i = 0; i < 5; i++) ego.assess();
    const trend = ego.getTrend();
    assert.strictEqual(trend.trend, 'stable');
    ego.shutdown();
  });

  it('should return insufficient-data trend with <2 samples', () => {
    const ego = new EntropyGovernanceOrchestrator();
    const trend = ego.getTrend();
    assert.strictEqual(trend.trend, 'insufficient-data');
    ego.shutdown();
  });

  it('should handle missing metric sources gracefully', () => {
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.1, 'low'),
      // 其他源缺失
    });
    const result = ego.assess();
    assert.ok(result.score >= 0);
    assert.ok(result.score <= 1);
    ego.shutdown();
  });

  it('should handle metric source errors gracefully', () => {
    const brokenMonitor = new EventEmitter();
    brokenMonitor.getStats = () => { throw new Error('broken'); };
    brokenMonitor.checkDrift = () => { throw new Error('broken'); };
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: brokenMonitor,
    });
    const result = ego.assess();
    assert.ok(result.metrics.contextDrift.error);
    ego.shutdown();
  });

  it('should determine correct entropy levels', () => {
    assert.strictEqual(new EntropyGovernanceOrchestrator({})._determineLevel(0.05), 'none');
    assert.strictEqual(new EntropyGovernanceOrchestrator({})._determineLevel(0.3), 'low');
    assert.strictEqual(new EntropyGovernanceOrchestrator({})._determineLevel(0.5), 'medium');
    assert.strictEqual(new EntropyGovernanceOrchestrator({})._determineLevel(0.7), 'high');
    assert.strictEqual(new EntropyGovernanceOrchestrator({})._determineLevel(0.9), 'critical');
  });
});

describe('EntropyGovernanceOrchestrator - Events & Actions', () => {

  it('should emit entropy-assessed event', () => {
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.3, 'medium'),
    });
    let emitted = null;
    ego.on('entropy-assessed', (r) => { emitted = r; });
    ego.assess();
    assert.ok(emitted);
    assert.strictEqual(typeof emitted.score, 'number');
    assert.ok(emitted.level);
    ego.shutdown();
  });

  it('should trigger auto-simplify when score exceeds threshold', () => {
    const mockReducer = createMockSkillReducer('overloaded', 30, 60);
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.9, 'critical'),
      comprehensionDebtTracker: createMockDebtTracker(0.8, 'critical', 10),
      skillReducer: mockReducer,
      autoSimplifyThreshold: 0.6,
    });
    let simplifyTriggered = false;
    ego.on('auto-simplify-triggered', () => { simplifyTriggered = true; });
    const result = ego.assess();
    if (result.score >= 0.6) {
      assert.ok(simplifyTriggered, 'Auto-simplify should be triggered');
      assert.strictEqual(ego.getStats().simplifyTriggerCount, 1);
    }
    ego.shutdown();
  });

  it('should trigger constraint reinforcement when score exceeds threshold', () => {
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.9, 'critical'),
      comprehensionDebtTracker: createMockDebtTracker(0.8, 'critical', 10),
      constraintReinforceThreshold: 0.5,
    });
    let reinforceTriggered = false;
    ego.on('constraint-reinforce-triggered', () => { reinforceTriggered = true; });
    const result = ego.assess();
    if (result.score >= 0.5) {
      assert.ok(reinforceTriggered, 'Constraint reinforcement should be triggered');
      assert.strictEqual(ego.getStats().reinforceTriggerCount, 1);
    }
    ego.shutdown();
  });

  it('should react to drift-detected event from monitor', () => {
    const mockMonitor = createMockContextDriftMonitor(0.5, 'medium');
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: mockMonitor,
    });
    let assessed = false;
    ego.on('entropy-assessed', () => { assessed = true; });
    mockMonitor.emit('drift-detected', { driftScore: 0.5, level: 'medium' });
    assert.ok(assessed, 'Should assess on drift-detected event');
    ego.shutdown();
  });

  it('should react to critical debt-recorded event', () => {
    const mockTracker = createMockDebtTracker(0.7, 'high', 5);
    const ego = new EntropyGovernanceOrchestrator({
      comprehensionDebtTracker: mockTracker,
    });
    let assessed = false;
    ego.on('entropy-assessed', () => { assessed = true; });
    mockTracker.emit('debt-recorded', { severity: 'critical', description: 'test' });
    assert.ok(assessed, 'Should assess on critical debt-recorded event');
    ego.shutdown();
  });

  it('should get stats with all fields', () => {
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: createMockContextDriftMonitor(0.2, 'low'),
    });
    ego.assess();
    const stats = ego.getStats();
    assert.strictEqual(typeof stats.currentScore, 'number');
    assert.ok(stats.currentLevel);
    assert.strictEqual(stats.assessmentCount, 1);
    assert.strictEqual(stats.historySize, 1);
    assert.strictEqual(typeof stats.avgScore, 'number');
    assert.strictEqual(typeof stats.maxScore, 'number');
    assert.strictEqual(typeof stats.minScore, 'number');
    assert.ok(stats.trend);
    assert.ok(stats.sources);
    assert.ok(stats.weights);
    ego.shutdown();
  });

  it('should shutdown cleanly', () => {
    const mockMonitor = createMockContextDriftMonitor(0.2, 'low');
    const ego = new EntropyGovernanceOrchestrator({
      contextDriftMonitor: mockMonitor,
    });
    ego.assess();
    ego.shutdown();
    assert.throws(() => ego.assess(), /shut down/);
  });

  it('should manually trigger simplify', () => {
    const mockReducer = createMockSkillReducer('overloaded', 20, 50);
    const ego = new EntropyGovernanceOrchestrator({
      skillReducer: mockReducer,
    });
    let triggered = false;
    ego.on('auto-simplify-triggered', () => { triggered = true; });
    ego.triggerSimplify();
    assert.ok(triggered);
    ego.shutdown();
  });
});
