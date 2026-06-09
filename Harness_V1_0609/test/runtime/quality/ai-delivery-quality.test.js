'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('AiCodeTrustScorer', () => {
  const AiCodeTrustScorer = require(path.join(ROOT, 'src', 'runtime', 'quality', 'ai-code-trust-scorer'));

  it('should construct with default config', () => {
    const scorer = new AiCodeTrustScorer();
    assert.strictEqual(typeof scorer.assess, 'function');
    assert.strictEqual(typeof scorer.assessWithSource, 'function');
    scorer.shutdown();
  });

  it('should return unreliable for null/undefined input', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess(null);
    assert.strictEqual(result.level, 'unreliable');
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.recommendation, 'reject');
    scorer.shutdown();
  });

  it('should return high trust for clean code context', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: true,
      edgeCasesHandled: true,
      errorHandlingComplete: true,
      specCompliant: true,
    });
    assert.strictEqual(result.level, 'high');
    assert.strictEqual(result.score, 1);
    assert.strictEqual(result.recommendation, 'accept');
    assert.strictEqual(result.riskCount, 0);
    scorer.shutdown();
  });

  it('should detect missing tests risk', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: false,
      errorHandlingComplete: true,
      specCompliant: true,
    });
    assert.ok(result.risks.some(r => r.label === 'no-tests'));
    assert.ok(result.score < 1);
    scorer.shutdown();
  });

  it('should detect missing error handling risk', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: true,
      errorHandlingComplete: false,
    });
    assert.ok(result.risks.some(r => r.label === 'missing-error-handling'));
    scorer.shutdown();
  });

  it('should detect spec violation risk', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: true,
      specCompliant: false,
    });
    assert.ok(result.risks.some(r => r.label === 'spec-violation'));
    scorer.shutdown();
  });

  it('should detect context drift risk', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: true,
      contextDrift: true,
    });
    assert.ok(result.risks.some(r => r.label === 'context-drift'));
    scorer.shutdown();
  });

  it('should detect unhandled edge cases risk', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: true,
      edgeCasesHandled: false,
    });
    assert.ok(result.risks.some(r => r.label === 'unhandled-edge-cases'));
    scorer.shutdown();
  });

  it('should detect implicit dependencies risk', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: true,
      implicitDependencies: true,
    });
    assert.ok(result.risks.some(r => r.label === 'implicit-dependencies'));
    scorer.shutdown();
  });

  it('should detect magic values risk', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: true,
      magicValues: true,
    });
    assert.ok(result.risks.some(r => r.label === 'magic-values'));
    scorer.shutdown();
  });

  it('should return low or unreliable for multiple severe risks', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: false,
      errorHandlingComplete: false,
      specCompliant: false,
      edgeCasesHandled: false,
    });
    assert.ok(result.score < 0.5);
    assert.ok(result.level === 'low' || result.level === 'unreliable');
    scorer.shutdown();
  });

  it('should track source trust score', () => {
    const scorer = new AiCodeTrustScorer();
    scorer.assessWithSource('agent-a', { hasTests: true, errorHandlingComplete: true, specCompliant: true });
    scorer.assessWithSource('agent-a', { hasTests: true, errorHandlingComplete: true, specCompliant: true });
    const trustScore = scorer.getSourceTrustScore('agent-a');
    assert.ok(Math.abs(trustScore - 1.0) < 0.001, 'trust score should be close to 1.0, got ' + trustScore);
    scorer.shutdown();
  });

  it('should return 0.5 for unknown source', () => {
    const scorer = new AiCodeTrustScorer();
    const trustScore = scorer.getSourceTrustScore('unknown');
    assert.strictEqual(trustScore, 0.5);
    scorer.shutdown();
  });

  it('should emit assessed event', () => {
    const scorer = new AiCodeTrustScorer();
    let emitted = false;
    scorer.on('assessed', (result) => {
      emitted = true;
      assert.strictEqual(result.level, 'high');
    });
    scorer.assess({ hasTests: true, errorHandlingComplete: true, specCompliant: true });
    assert.strictEqual(emitted, true);
    scorer.shutdown();
  });

  it('should track history and average score', () => {
    const scorer = new AiCodeTrustScorer();
    scorer.assess({ hasTests: true, errorHandlingComplete: true, specCompliant: true });
    scorer.assess({ hasTests: false, errorHandlingComplete: false });
    const avg = scorer.getAverageScore();
    assert.ok(avg > 0);
    assert.ok(avg < 1);
    const history = scorer.getHistory();
    assert.strictEqual(history.length, 2);
    scorer.shutdown();
  });

  it('should compute risk distribution', () => {
    const scorer = new AiCodeTrustScorer();
    scorer.assess({ hasTests: false, errorHandlingComplete: false });
    scorer.assess({ hasTests: false, specCompliant: false });
    const dist = scorer.getRiskDistribution();
    assert.ok(dist['no-tests'] >= 2);
    scorer.shutdown();
  });

  it('should decay source scores over time', () => {
    const scorer = new AiCodeTrustScorer();
    scorer.assessWithSource('agent-a', { hasTests: true, errorHandlingComplete: true, specCompliant: true });
    const data = scorer._sourceScores.get('agent-a');
    data.lastAssessedAt = Date.now() - 10 * 86400000;
    scorer.decaySourceScores();
    const score = scorer.getSourceTrustScore('agent-a');
    assert.ok(score < 1.0);
    scorer.shutdown();
  });

  it('should expose static constants', () => {
    assert.strictEqual(AiCodeTrustScorer.TRUST_LEVELS.HIGH, 'high');
    assert.strictEqual(AiCodeTrustScorer.TRUST_LEVELS.UNRELIABLE, 'unreliable');
    assert.ok(AiCodeTrustScorer.RISK_INDICATORS.NO_TESTS.weight > 0);
  });
});

describe('AiCodeTrustScorer - ALMOST_CORRECT', () => {
  const AiCodeTrustScorer = require(path.join(ROOT, 'src', 'runtime', 'quality', 'ai-code-trust-scorer'));

  it('should detect almost-correct risk with explicit flag', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: true,
      almostCorrect: true,
    });
    assert.ok(result.risks.some(r => r.label === 'almost-correct'));
    scorer.shutdown();
  });

  it('should detect almost-correct risk with subtleBugCount', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: true,
      subtleBugCount: 3,
    });
    const almostCorrect = result.risks.find(r => r.label === 'almost-correct');
    assert.ok(almostCorrect);
    assert.strictEqual(almostCorrect.severity, 0.9);
    scorer.shutdown();
  });

  it('should detect almost-correct risk when passes basic tests but lacks edge/error handling', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: true,
      passesBasicTests: true,
      edgeCasesHandled: false,
      errorHandlingComplete: false,
    });
    assert.ok(result.risks.some(r => r.label === 'almost-correct'));
    scorer.shutdown();
  });

  it('should not trigger almost-correct when edge cases and error handling are present', () => {
    const scorer = new AiCodeTrustScorer();
    const result = scorer.assess({
      hasTests: true,
      passesBasicTests: true,
      edgeCasesHandled: true,
      errorHandlingComplete: true,
    });
    assert.ok(!result.risks.some(r => r.label === 'almost-correct'));
    scorer.shutdown();
  });
});

describe('ComprehensionDebtTracker', () => {
  const ComprehensionDebtTracker = require(path.join(ROOT, 'src', 'runtime', 'quality', 'comprehension-debt-tracker'));

  it('should construct with default config', () => {
    const tracker = new ComprehensionDebtTracker();
    assert.strictEqual(typeof tracker.recordDebt, 'function');
    tracker.shutdown();
  });

  it('should return null for invalid input', () => {
    const tracker = new ComprehensionDebtTracker();
    const result = tracker.recordDebt(null);
    assert.strictEqual(result, null);
    tracker.shutdown();
  });

  it('should record a debt and return it with id', () => {
    const tracker = new ComprehensionDebtTracker();
    const debt = tracker.recordDebt({
      type: 'requirement-ambiguity',
      severity: 'high',
      description: 'Ambiguous requirement for auth flow',
      source: 'agent-a',
    });
    assert.ok(debt.id);
    assert.strictEqual(debt.type, 'requirement-ambiguity');
    assert.strictEqual(debt.severity, 'high');
    assert.strictEqual(debt.resolutionState, 'open');
    tracker.shutdown();
  });

  it('should resolve a debt', () => {
    const tracker = new ComprehensionDebtTracker();
    const debt = tracker.recordDebt({ type: 'spec-gap', severity: 'medium' });
    const resolved = tracker.resolveDebt(debt.id, 'Clarified with product team');
    assert.strictEqual(resolved.resolutionState, 'resolved');
    assert.ok(resolved.resolvedAt);
    assert.strictEqual(resolved.resolutionNote, 'Clarified with product team');
    tracker.shutdown();
  });

  it('should escalate a debt', () => {
    const tracker = new ComprehensionDebtTracker();
    const debt = tracker.recordDebt({ type: 'domain-knowledge-gap', severity: 'critical' });
    const escalated = tracker.escalateDebt(debt.id, 'Requires domain expert review');
    assert.strictEqual(escalated.resolutionState, 'escalated');
    tracker.shutdown();
  });

  it('should return null for unknown debt id', () => {
    const tracker = new ComprehensionDebtTracker();
    assert.strictEqual(tracker.getDebt('nonexistent'), null);
    assert.strictEqual(tracker.resolveDebt('nonexistent', 'note'), null);
    tracker.shutdown();
  });

  it('should get open debts', () => {
    const tracker = new ComprehensionDebtTracker();
    tracker.recordDebt({ type: 'spec-gap', severity: 'medium' });
    tracker.recordDebt({ type: 'requirement-ambiguity', severity: 'high' });
    const resolved = tracker.recordDebt({ type: 'context-mismatch', severity: 'low' });
    tracker.resolveDebt(resolved.id, 'Fixed');
    const open = tracker.getOpenDebts();
    assert.strictEqual(open.length, 2);
    tracker.shutdown();
  });

  it('should get debts by type', () => {
    const tracker = new ComprehensionDebtTracker();
    tracker.recordDebt({ type: 'spec-gap', severity: 'medium' });
    tracker.recordDebt({ type: 'spec-gap', severity: 'high' });
    tracker.recordDebt({ type: 'requirement-ambiguity', severity: 'low' });
    const specGaps = tracker.getDebtsByType('spec-gap');
    assert.strictEqual(specGaps.length, 2);
    tracker.shutdown();
  });

  it('should get debts by task', () => {
    const tracker = new ComprehensionDebtTracker();
    tracker.recordDebt({ type: 'spec-gap', taskId: 'task-1' });
    tracker.recordDebt({ type: 'requirement-ambiguity', taskId: 'task-1' });
    tracker.recordDebt({ type: 'context-mismatch', taskId: 'task-2' });
    const task1Debts = tracker.getDebtsByTask('task-1');
    assert.strictEqual(task1Debts.length, 2);
    tracker.shutdown();
  });

  it('should calculate debt score', () => {
    const tracker = new ComprehensionDebtTracker();
    tracker.recordDebt({ type: 'spec-gap', severity: 'critical' });
    tracker.recordDebt({ type: 'requirement-ambiguity', severity: 'high' });
    const scoreResult = tracker.calculateDebtScore();
    assert.ok(scoreResult.score > 0);
    assert.strictEqual(scoreResult.openCount, 2);
    assert.ok(scoreResult.level === 'critical' || scoreResult.level === 'high');
    tracker.shutdown();
  });

  it('should return none level when no open debts', () => {
    const tracker = new ComprehensionDebtTracker();
    const scoreResult = tracker.calculateDebtScore();
    assert.strictEqual(scoreResult.score, 0);
    assert.strictEqual(scoreResult.level, 'none');
    tracker.shutdown();
  });

  it('should compute debt distribution', () => {
    const tracker = new ComprehensionDebtTracker();
    tracker.recordDebt({ type: 'spec-gap', severity: 'medium' });
    tracker.recordDebt({ type: 'spec-gap', severity: 'high' });
    tracker.recordDebt({ type: 'requirement-ambiguity', severity: 'low' });
    const dist = tracker.getDebtDistribution();
    assert.strictEqual(dist['spec-gap'], 2);
    assert.strictEqual(dist['requirement-ambiguity'], 1);
    tracker.shutdown();
  });

  it('should compute resolution rate', () => {
    const tracker = new ComprehensionDebtTracker();
    tracker.recordDebt({ type: 'spec-gap', severity: 'medium' });
    const debt2 = tracker.recordDebt({ type: 'requirement-ambiguity', severity: 'low' });
    tracker.resolveDebt(debt2.id, 'Fixed');
    const rate = tracker.getResolutionRate();
    assert.strictEqual(rate, 0.5);
    tracker.shutdown();
  });

  it('should emit debt-recorded event', () => {
    const tracker = new ComprehensionDebtTracker();
    let emitted = false;
    tracker.on('debt-recorded', (debt) => {
      emitted = true;
      assert.strictEqual(debt.type, 'spec-gap');
    });
    tracker.recordDebt({ type: 'spec-gap', severity: 'medium' });
    assert.strictEqual(emitted, true);
    tracker.shutdown();
  });

  it('should expose static constants', () => {
    assert.strictEqual(ComprehensionDebtTracker.DEBT_TYPES.REQUIREMENT_AMBIGUITY, 'requirement-ambiguity');
    assert.strictEqual(ComprehensionDebtTracker.DEBT_SEVERITY.CRITICAL, 'critical');
    assert.strictEqual(ComprehensionDebtTracker.RESOLUTION_STATES.OPEN, 'open');
  });
});

describe('DeliveryEfficiencyMeter', () => {
  const DeliveryEfficiencyMeter = require(path.join(ROOT, 'src', 'runtime', 'quality', 'delivery-efficiency-meter'));

  it('should construct with default config', () => {
    const meter = new DeliveryEfficiencyMeter();
    assert.strictEqual(typeof meter.startCycle, 'function');
    meter.shutdown();
  });

  it('should start and end a cycle', () => {
    const meter = new DeliveryEfficiencyMeter();
    const cycleId = meter.startCycle({ id: 'test-1' });
    assert.ok(cycleId);
    const cycle = meter.endCycle({ outcome: 'completed' });
    assert.strictEqual(cycle.outcome, 'completed');
    assert.strictEqual(cycle.id, 'test-1');
    meter.shutdown();
  });

  it('should auto-end previous cycle when starting new one', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'cycle-1' });
    meter.startCycle({ id: 'cycle-2' });
    const metrics = meter.getEfficiencyMetrics();
    assert.strictEqual(metrics.totalCycles, 1);
    meter.shutdown();
  });

  it('should record phase time', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordPhaseTime('development', 3600000, { aiAssisted: true });
    meter.recordPhaseTime('testing', 7200000);
    const cycle = meter.endCycle({ outcome: 'completed' });
    assert.ok(cycle.phases.development);
    assert.strictEqual(cycle.phases.development.durationMs, 3600000);
    assert.strictEqual(cycle.phases.development.aiAssisted, true);
    meter.shutdown();
  });

  it('should reject invalid phase', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    const result = meter.recordPhaseTime('invalid-phase', 1000);
    assert.strictEqual(result, null);
    meter.shutdown();
  });

  it('should return null when no active cycle', () => {
    const meter = new DeliveryEfficiencyMeter();
    const result = meter.recordPhaseTime('development', 1000);
    assert.strictEqual(result, null);
    meter.shutdown();
  });

  it('should record review cycles', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordReviewCycle();
    meter.recordReviewCycle();
    const cycle = meter.endCycle({ outcome: 'completed' });
    assert.strictEqual(cycle.reviewCycles, 2);
    meter.shutdown();
  });

  it('should track rework', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordPhaseTime('development', 3600000, { aiAssisted: true });
    meter.recordPhaseTime('testing', 7200000, { rework: true });
    const cycle = meter.endCycle({ outcome: 'completed' });
    assert.strictEqual(cycle.reworkCount, 1);
    meter.shutdown();
  });

  it('should compute time distribution', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordPhaseTime('development', 2000);
    meter.recordPhaseTime('testing', 8000);
    meter.endCycle({ outcome: 'completed' });
    const dist = meter.getTimeDistribution();
    assert.ok(Math.abs(dist.development - 0.2) < 0.01);
    assert.ok(Math.abs(dist.testing - 0.8) < 0.01);
    meter.shutdown();
  });

  it('should return expected distribution when no cycles', () => {
    const meter = new DeliveryEfficiencyMeter();
    const dist = meter.getTimeDistribution();
    assert.strictEqual(dist.development, 0.2);
    assert.strictEqual(dist.testing, 0.25);
    meter.shutdown();
  });

  it('should compute coding ratio', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordPhaseTime('development', 2000);
    meter.recordPhaseTime('testing', 8000);
    meter.endCycle({ outcome: 'completed' });
    const ratio = meter.getCodingRatio();
    assert.ok(Math.abs(ratio - 0.2) < 0.01);
    meter.shutdown();
  });

  it('should compute AI acceleration ratio', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordPhaseTime('development', 2000, { aiAssisted: true });
    meter.recordPhaseTime('testing', 8000);
    meter.endCycle({ outcome: 'completed' });
    const ratio = meter.getAiAccelerationRatio();
    assert.ok(Math.abs(ratio - 0.2) < 0.01);
    meter.shutdown();
  });

  it('should compute review bottleneck score', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordPhaseTime('development', 2000);
    meter.recordPhaseTime('testing', 8000, { rework: true });
    meter.recordReviewCycle();
    meter.recordReviewCycle();
    meter.recordReviewCycle();
    meter.endCycle({ outcome: 'completed' });
    const score = meter.getReviewBottleneckScore();
    assert.ok(score > 0);
    meter.shutdown();
  });

  it('should compute efficiency metrics', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordPhaseTime('development', 2000, { aiAssisted: true });
    meter.recordPhaseTime('testing', 8000);
    meter.endCycle({ outcome: 'completed' });
    const metrics = meter.getEfficiencyMetrics();
    assert.strictEqual(metrics.totalCycles, 1);
    assert.strictEqual(metrics.completedCycles, 1);
    assert.ok(metrics.avgCycleTimeMs >= 0);
    assert.ok(metrics.codingRatio > 0);
    meter.shutdown();
  });

  it('should compute phase breakdown', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordPhaseTime('development', 2000);
    meter.recordPhaseTime('testing', 8000);
    meter.endCycle({ outcome: 'completed' });
    const breakdown = meter.getPhaseBreakdown();
    assert.strictEqual(breakdown.length, 6);
    const devPhase = breakdown.find(p => p.phase === 'development');
    assert.ok(devPhase);
    assert.ok(devPhase.actualRatio > 0);
    meter.shutdown();
  });

  it('should emit cycle-started and cycle-ended events', () => {
    const meter = new DeliveryEfficiencyMeter();
    let started = false;
    let ended = false;
    meter.on('cycle-started', () => { started = true; });
    meter.on('cycle-ended', () => { ended = true; });
    meter.startCycle({ id: 'test-1' });
    meter.endCycle({ outcome: 'completed' });
    assert.strictEqual(started, true);
    assert.strictEqual(ended, true);
    meter.shutdown();
  });

  it('should expose static constants', () => {
    assert.strictEqual(DeliveryEfficiencyMeter.PHASES.DEVELOPMENT, 'development');
    assert.strictEqual(DeliveryEfficiencyMeter.PHASE_LABELS.development, '编码开发');
    assert.strictEqual(DeliveryEfficiencyMeter.DEFAULT_TIME_DISTRIBUTION.development, 0.2);
  });
});

describe('DeliveryEfficiencyMeter - AI Delivery Metrics', () => {
  const DeliveryEfficiencyMeter = require(path.join(ROOT, 'src', 'runtime', 'quality', 'delivery-efficiency-meter'));

  it('should expose new static constants', () => {
    assert.strictEqual(DeliveryEfficiencyMeter.THROUGHPUT_IMBALANCE_THRESHOLD, 2.0);
    assert.strictEqual(DeliveryEfficiencyMeter.PIPELINE_BOTTLENECK_THRESHOLD, 0.3);
  });

  it('should track code generation and review completion', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordCodeGeneration(5000, { aiAssisted: true });
    meter.recordCodeGeneration(3000);
    meter.recordReviewCompletion(10000);
    const cycle = meter.endCycle({ outcome: 'completed' });
    assert.strictEqual(cycle.codeGenerationCount, 2);
    assert.strictEqual(cycle.codeGenerationTimeMs, 8000);
    assert.strictEqual(cycle.reviewCount, 1);
    assert.strictEqual(cycle.reviewTimeMs, 10000);
    meter.shutdown();
  });

  it('should compute review throughput imbalance', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordCodeGeneration(1000);
    meter.recordCodeGeneration(1000);
    meter.recordCodeGeneration(1000);
    meter.recordReviewCompletion(10000);
    meter.endCycle({ outcome: 'completed' });
    const imbalance = meter.getReviewThroughputImbalance();
    assert.ok(imbalance.ratio > 0);
    assert.ok(typeof imbalance.level === 'string');
    assert.ok(typeof imbalance.codeGenRate === 'number');
    assert.ok(typeof imbalance.reviewRate === 'number');
    meter.shutdown();
  });

  it('should return none level for throughput imbalance with no cycles', () => {
    const meter = new DeliveryEfficiencyMeter();
    const imbalance = meter.getReviewThroughputImbalance();
    assert.strictEqual(imbalance.level, 'none');
    assert.strictEqual(imbalance.ratio, 0);
    meter.shutdown();
  });

  it('should detect pipeline bottleneck', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordPhaseTime('development', 2000);
    meter.recordPhaseTime('testing', 8000);
    meter.endCycle({ outcome: 'completed' });
    const bottleneck = meter.getPipelineBottleneck();
    assert.ok(typeof bottleneck.hasBottleneck === 'boolean');
    assert.ok(typeof bottleneck.bottleneckCount === 'number');
    if (bottleneck.hasBottleneck) {
      assert.ok(bottleneck.primary);
      assert.ok(bottleneck.primary.overrun > 0);
    }
    meter.shutdown();
  });

  it('should track feedback loop duration', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.startFeedbackLoop();
    meter.endFeedbackLoop();
    meter.startFeedbackLoop();
    meter.endFeedbackLoop();
    const loopDuration = meter.getFeedbackLoopDuration();
    assert.strictEqual(loopDuration.count, 2);
    assert.ok(loopDuration.avgMs >= 0);
    assert.ok(typeof loopDuration.trend === 'string');
    meter.shutdown();
  });

  it('should return none trend for feedback loop with insufficient data', () => {
    const meter = new DeliveryEfficiencyMeter();
    const loopDuration = meter.getFeedbackLoopDuration();
    assert.strictEqual(loopDuration.count, 0);
    assert.strictEqual(loopDuration.trend, 'none');
    meter.shutdown();
  });

  it('should include new metrics in efficiency metrics', () => {
    const meter = new DeliveryEfficiencyMeter();
    meter.startCycle({ id: 'test-1' });
    meter.recordPhaseTime('development', 2000, { aiAssisted: true });
    meter.endCycle({ outcome: 'completed' });
    const metrics = meter.getEfficiencyMetrics();
    assert.ok(metrics.reviewThroughputImbalance);
    assert.ok(metrics.pipelineBottleneck);
    assert.ok(metrics.feedbackLoopDuration);
    meter.shutdown();
  });
});

describe('ContextDriftMonitor', () => {
  const ContextDriftMonitor = require(path.join(ROOT, 'src', 'runtime', 'quality', 'context-drift-monitor'));

  it('should construct with default config', () => {
    const monitor = new ContextDriftMonitor();
    assert.strictEqual(typeof monitor.registerConstraint, 'function');
    assert.strictEqual(typeof monitor.startTask, 'function');
    assert.strictEqual(typeof monitor.checkDrift, 'function');
    monitor.shutdown();
  });

  it('should register and track constraints', () => {
    const monitor = new ContextDriftMonitor();
    const c = monitor.registerConstraint({ text: 'Must use CommonJS modules', category: 'architecture', priority: 'high' });
    assert.ok(c.id);
    assert.strictEqual(c.text, 'Must use CommonJS modules');
    assert.strictEqual(c.category, 'architecture');
    monitor.shutdown();
  });

  it('should register multiple constraints at once', () => {
    const monitor = new ContextDriftMonitor();
    const results = monitor.registerConstraints([
      { text: 'No React framework', category: 'architecture' },
      { text: 'Use better-sqlite3', category: 'data' },
    ]);
    assert.strictEqual(results.length, 2);
    monitor.shutdown();
  });

  it('should start and stop a task', () => {
    const monitor = new ContextDriftMonitor();
    const taskId = monitor.startTask('task-1', [
      { text: 'Must pass all tests', category: 'quality' },
    ]);
    assert.strictEqual(taskId, 'task-1');
    const stats = monitor.getStats();
    assert.strictEqual(stats.activeConstraints, 1);
    assert.strictEqual(stats.currentTaskId, 'task-1');
    monitor.stopTask();
    const statsAfter = monitor.getStats();
    assert.strictEqual(statsAfter.currentTaskId, null);
    monitor.shutdown();
  });

  it('should detect no drift when constraints are present in context', () => {
    const monitor = new ContextDriftMonitor();
    monitor.startTask('task-1', [
      { text: 'use CommonJS', category: 'architecture' },
    ]);
    const result = monitor.checkDrift('This module uses CommonJS require syntax');
    assert.strictEqual(result.level, 'none');
    assert.strictEqual(result.driftScore, 0);
    monitor.shutdown();
  });

  it('should detect drift when constraints are absent from context', () => {
    const monitor = new ContextDriftMonitor();
    monitor.startTask('task-1', [
      { text: 'must use CommonJS modules only', category: 'architecture', priority: 'high' },
      { text: 'no external frameworks', category: 'architecture', priority: 'critical' },
    ]);
    const result = monitor.checkDrift('We will use React and ES modules for this component');
    assert.ok(result.driftScore > 0);
    assert.ok(result.level !== 'none');
    assert.ok(result.violatedConstraints.length > 0);
    monitor.shutdown();
  });

  it('should track constraint violations over time', () => {
    const monitor = new ContextDriftMonitor();
    monitor.startTask('task-1', [
      { text: 'no React', category: 'architecture', priority: 'high' },
    ]);
    monitor.checkDrift('Using React components here');
    monitor.checkDrift('More React code');
    monitor.checkDrift('Still using React');
    const constraints = monitor.getActiveConstraints();
    const con = constraints.find(c => c.text === 'no React');
    assert.ok(con);
    assert.strictEqual(con.violationCount, 3);
    monitor.shutdown();
  });

  it('should emit drift-detected event', () => {
    const monitor = new ContextDriftMonitor();
    let emitted = false;
    monitor.on('drift-detected', (result) => {
      emitted = true;
      assert.ok(result.driftScore > 0);
    });
    monitor.startTask('task-1', [
      { text: 'must use CommonJS', category: 'architecture', priority: 'critical' },
    ]);
    monitor.checkDrift('Using ES modules import syntax');
    assert.strictEqual(emitted, true);
    monitor.shutdown();
  });

  it('should compute drift trend', () => {
    const monitor = new ContextDriftMonitor({ checkIntervalMs: 10 });
    monitor.startTask('task-1', [
      { text: 'no React', category: 'architecture', priority: 'high' },
    ]);
    monitor.checkDrift('Some code here');
    monitor.checkDrift('Using React');
    const trend = monitor.getDriftTrend();
    assert.ok(typeof trend.trend === 'string');
    monitor.shutdown();
  });

  it('should return stats', () => {
    const monitor = new ContextDriftMonitor();
    monitor.startTask('task-1', [
      { text: 'constraint 1', category: 'quality' },
    ]);
    const stats = monitor.getStats();
    assert.strictEqual(stats.activeConstraints, 1);
    assert.strictEqual(stats.currentTaskId, 'task-1');
    assert.ok(typeof stats.driftTrend === 'string');
    monitor.shutdown();
  });

  it('should expose static constants', () => {
    assert.strictEqual(ContextDriftMonitor.DRIFT_LEVELS.CRITICAL, 'critical');
    assert.strictEqual(ContextDriftMonitor.DRIFT_LEVELS.NONE, 'none');
    assert.strictEqual(typeof ContextDriftMonitor.MAX_SNAPSHOTS, 'number');
    assert.strictEqual(typeof ContextDriftMonitor.MAX_CONSTRAINTS, 'number');
  });

  it('should remove constraint', () => {
    const monitor = new ContextDriftMonitor();
    const c = monitor.registerConstraint({ text: 'temp constraint' });
    assert.strictEqual(monitor.removeConstraint(c.id), true);
    assert.strictEqual(monitor.removeConstraint(c.id), false);
    monitor.shutdown();
  });

  it('should return null for invalid constraint registration', () => {
    const monitor = new ContextDriftMonitor();
    assert.strictEqual(monitor.registerConstraint(null), null);
    monitor.shutdown();
  });

  it('should return empty array for registerConstraints with non-array', () => {
    const monitor = new ContextDriftMonitor();
    const results = monitor.registerConstraints('not an array');
    assert.strictEqual(results.length, 0);
    monitor.shutdown();
  });
});

describe('AgentGoldenTest', () => {
  const AgentGoldenTest = require(path.join(ROOT, 'src', 'runtime', 'quality', 'agent-golden-test'));

  it('should construct with default config', () => {
    const gt = new AgentGoldenTest();
    assert.strictEqual(typeof gt.registerCase, 'function');
    assert.strictEqual(typeof gt.runTest, 'function');
    gt.shutdown();
  });

  it('should register a test case', () => {
    const gt = new AgentGoldenTest();
    const tc = gt.registerCase('coder', {
      id: 'tc1',
      description: 'basic output test',
      input: { prompt: 'hello' },
      expectedOutput: { status: 'ok', code: 0 },
    });
    assert.ok(tc);
    assert.strictEqual(tc.agentId, 'coder');
    assert.strictEqual(tc.id, 'tc1');
    gt.shutdown();
  });

  it('should register multiple cases at once', () => {
    const gt = new AgentGoldenTest();
    const results = gt.registerCases('qa', [
      { id: 'qa1', expectedOutput: { pass: true } },
      { id: 'qa2', expectedOutput: { pass: false } },
    ]);
    assert.strictEqual(results.length, 2);
    gt.shutdown();
  });

  it('should reject invalid case registration', () => {
    const gt = new AgentGoldenTest();
    assert.strictEqual(gt.registerCase(null, null), null);
    assert.strictEqual(gt.registerCase('agent', {}), null);
    gt.shutdown();
  });

  it('should pass test when output matches expected', () => {
    const gt = new AgentGoldenTest();
    gt.registerCase('coder', { id: 'tc1', expectedOutput: { status: 'ok' } });
    const result = gt.runTest('coder', 'tc1', { status: 'ok' });
    assert.strictEqual(result.passed, true);
    gt.shutdown();
  });

  it('should fail test when output does not match', () => {
    const gt = new AgentGoldenTest();
    gt.registerCase('coder', { id: 'tc1', expectedOutput: { status: 'ok' } });
    const result = gt.runTest('coder', 'tc1', { status: 'error' });
    assert.strictEqual(result.passed, false);
    gt.shutdown();
  });

  it('should detect regression and emit event', () => {
    const gt = new AgentGoldenTest();
    let emitted = false;
    gt.on('regression-detected', () => { emitted = true; });
    gt.registerCase('coder', { id: 'tc1', expectedOutput: { val: 1 } });
    gt.runTest('coder', 'tc1', { val: 99 });
    assert.strictEqual(emitted, true);
    gt.shutdown();
  });

  it('should handle numeric tolerance', () => {
    const gt = new AgentGoldenTest();
    gt.registerCase('coder', { id: 'tc1', expectedOutput: { score: 0.85 }, tolerance: 0.05 });
    const result = gt.runTest('coder', 'tc1', { score: 0.87 });
    assert.strictEqual(result.passed, true);
    gt.shutdown();
  });

  it('should return test case not found for unknown case', () => {
    const gt = new AgentGoldenTest();
    const result = gt.runTest('coder', 'nonexistent', {});
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.error, 'Test case not found');
    gt.shutdown();
  });

  it('should get stats', () => {
    const gt = new AgentGoldenTest();
    gt.registerCase('coder', { id: 'tc1', expectedOutput: { x: 1 } });
    gt.runTest('coder', 'tc1', { x: 1 });
    const stats = gt.getStats();
    assert.strictEqual(stats.casesRegistered, 1);
    assert.strictEqual(stats.testsRun, 1);
    assert.strictEqual(stats.testsPassed, 1);
    gt.shutdown();
  });

  it('should get regressions', () => {
    const gt = new AgentGoldenTest();
    gt.registerCase('coder', { id: 'tc1', expectedOutput: { x: 1 } });
    gt.runTest('coder', 'tc1', { x: 99 });
    const reg = gt.getRegressions('coder');
    assert.strictEqual(reg.length, 1);
    gt.shutdown();
  });

  it('should remove case', () => {
    const gt = new AgentGoldenTest();
    gt.registerCase('coder', { id: 'tc1', expectedOutput: { x: 1 } });
    assert.strictEqual(gt.removeCase('coder', 'tc1'), true);
    assert.strictEqual(gt.removeCase('coder', 'tc1'), false);
    gt.shutdown();
  });

  it('should expose static constants', () => {
    assert.strictEqual(typeof AgentGoldenTest.MAX_CASES, 'number');
    assert.strictEqual(typeof AgentGoldenTest.MAX_HISTORY, 'number');
  });
});

describe('CollaborationModeRouter - shouldUseMultiAgent', () => {
  const CollaborationModeRouter = require(path.join(ROOT, 'src', 'runtime', 'collaboration', 'collaboration-mode-router'));

  it('should reject real-time tasks', () => {
    const router = new CollaborationModeRouter();
    const result = router.shouldUseMultiAgent({ task: '实时客服系统', latencyRequirement: 'realtime' });
    assert.strictEqual(result.shouldUse, false);
    assert.strictEqual(result.severity, 'critical');
    router.shutdown();
  });

  it('should reject deterministic tasks', () => {
    const router = new CollaborationModeRouter();
    const result = router.shouldUseMultiAgent({ task: '表单提取字段' });
    assert.strictEqual(result.shouldUse, false);
    assert.strictEqual(result.reason, 'deterministic_task');
    router.shutdown();
  });

  it('should reject zero fault tolerance without human', () => {
    const router = new CollaborationModeRouter();
    const result = router.shouldUseMultiAgent({ task: '医疗器械操控', faultTolerance: 'zero', hasHumanOversight: false });
    assert.strictEqual(result.shouldUse, false);
    assert.strictEqual(result.severity, 'critical');
    router.shutdown();
  });

  it('should allow zero fault tolerance with human oversight', () => {
    const router = new CollaborationModeRouter();
    const result = router.shouldUseMultiAgent({ task: '医疗诊断辅助', faultTolerance: 'zero', hasHumanOversight: true });
    assert.ok(result.shouldUse !== false || result.severity !== 'critical');
    router.shutdown();
  });

  it('should approve multi-role tasks', () => {
    const router = new CollaborationModeRouter();
    const result = router.shouldUseMultiAgent({ task: '多角色长链路协作开发', traits: ['decomposable', 'multi_role'] });
    assert.strictEqual(result.shouldUse, true);
    router.shutdown();
  });

  it('should approve adversarial review tasks', () => {
    const router = new CollaborationModeRouter();
    const result = router.shouldUseMultiAgent({ task: '红蓝对抗审查代码', traits: ['quality_critical'] });
    assert.strictEqual(result.shouldUse, true);
    router.shutdown();
  });

  it('should reject simple tasks', () => {
    const router = new CollaborationModeRouter();
    const result = router.shouldUseMultiAgent({ task: '简单的字符串替换' });
    assert.strictEqual(result.shouldUse, false);
    assert.ok(result.reason === 'insufficient_complexity' || result.reason === 'deterministic_task' || result.reason === 'insufficient_signals');
    router.shutdown();
  });
});
