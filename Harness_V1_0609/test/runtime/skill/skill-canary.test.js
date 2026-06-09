'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SkillCanary = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-canary'));

describe('SkillCanary - Constructor', () => {
  it('should create instance with default config', () => {
    const canary = new SkillCanary();
    assert.ok(canary);
    assert.strictEqual(canary._canaries.size, 0);
    assert.strictEqual(canary._autoEvalIntervalId, null);
  });

  it('should merge custom config', () => {
    const canary = new SkillCanary();
    canary.enableCanary('test-skill', {
      trafficPercent: 50,
      minSamples: 10,
      successRateThreshold: 0.9,
      latencyMultiplier: 2.0,
      warmupSamples: 5,
      baseline: { successRate: 0.95, avgLatency: 100 },
    });
    const status = canary.getCanaryStatus('test-skill');
    assert.strictEqual(status.trafficPercent, 50);

    const internal = canary._canaries.get('test-skill');
    assert.strictEqual(internal.config.minSamples, 10);
    assert.strictEqual(internal.config.successRateThreshold, 0.9);
    assert.strictEqual(internal.config.latencyMultiplier, 2.0);
    assert.strictEqual(internal.config.warmupSamples, 5);
    assert.strictEqual(internal.baseline.successRate, 0.95);
    assert.strictEqual(internal.baseline.avgLatency, 100);
  });
});

describe('SkillCanary - enableCanary / disableCanary', () => {
  it('should enable canary for a skill', () => {
    const canary = new SkillCanary();
    const result = canary.enableCanary('skill-a');
    assert.strictEqual(result, true);
    assert.strictEqual(canary.isCanaryEnabled('skill-a'), true);
  });

  it('should emit canary-enabled event', () => {
    const canary = new SkillCanary();
    let eventData = null;
    canary.on('canary-enabled', (data) => { eventData = data; });
    canary.enableCanary('skill-a', { trafficPercent: 25 });
    assert.ok(eventData);
    assert.strictEqual(eventData.skillId, 'skill-a');
    assert.strictEqual(eventData.trafficPercent, 25);
  });

  it('should return false for empty skillId', () => {
    const canary = new SkillCanary();
    assert.strictEqual(canary.enableCanary(''), false);
    assert.strictEqual(canary.enableCanary(null), false);
    assert.strictEqual(canary.enableCanary(undefined), false);
    assert.strictEqual(canary.enableCanary(123), false);
  });

  it('should disable canary and emit canary-disabled event', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    let eventData = null;
    canary.on('canary-disabled', (data) => { eventData = data; });
    const result = canary.disableCanary('skill-a');
    assert.strictEqual(result, true);
    assert.strictEqual(canary.isCanaryEnabled('skill-a'), false);
    assert.ok(eventData);
    assert.strictEqual(eventData.skillId, 'skill-a');
  });

  it('should return false for disabling unknown skill', () => {
    const canary = new SkillCanary();
    assert.strictEqual(canary.disableCanary('unknown'), false);
    assert.strictEqual(canary.disableCanary(''), false);
  });
});

describe('SkillCanary - shouldActivate', () => {
  it('should return false when canary not enabled', () => {
    const canary = new SkillCanary();
    assert.strictEqual(canary.shouldActivate('unknown'), false);
  });

  it('should return boolean based on traffic percent (test with 100% and 0%)', () => {
    const canary = new SkillCanary();
    canary.enableCanary('full-traffic', { trafficPercent: 100 });
    assert.strictEqual(canary.shouldActivate('full-traffic'), true);

    const canary2 = new SkillCanary();
    canary2.enableCanary('zero-traffic', { trafficPercent: 0 });
    assert.strictEqual(canary2.shouldActivate('zero-traffic'), false);
  });

  it('should emit canary-activated event when activated', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a', { trafficPercent: 100 });
    let eventData = null;
    canary.on('canary-activated', (data) => { eventData = data; });
    canary.shouldActivate('skill-a');
    assert.ok(eventData);
    assert.strictEqual(eventData.skillId, 'skill-a');
    assert.strictEqual(eventData.activated, true);
  });
});

describe('SkillCanary - recordResult / getCanaryMetrics', () => {
  it('should record success and failure results', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    canary.recordResult('skill-a', { success: true, latency: 10 });
    canary.recordResult('skill-a', { success: false, latency: 20 });
    const metrics = canary.getCanaryMetrics('skill-a');
    assert.strictEqual(metrics.sampleCount, 2);
    assert.strictEqual(metrics.successRate, 0.5);
  });

  it('should calculate success rate correctly', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    canary.recordResult('skill-a', { success: true, latency: 10 });
    canary.recordResult('skill-a', { success: true, latency: 10 });
    canary.recordResult('skill-a', { success: true, latency: 10 });
    canary.recordResult('skill-a', { success: false, latency: 10 });
    const metrics = canary.getCanaryMetrics('skill-a');
    assert.strictEqual(metrics.successRate, 0.75);
  });

  it('should calculate average latency', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    canary.recordResult('skill-a', { success: true, latency: 10 });
    canary.recordResult('skill-a', { success: true, latency: 20 });
    canary.recordResult('skill-a', { success: true, latency: 30 });
    const metrics = canary.getCanaryMetrics('skill-a');
    assert.strictEqual(metrics.avgLatency, 20);
  });

  it('should calculate P50 and P95 latency', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const lat of latencies) {
      canary.recordResult('skill-a', { success: true, latency: lat });
    }
    const metrics = canary.getCanaryMetrics('skill-a');
    assert.strictEqual(metrics.p50Latency, 50);
    assert.strictEqual(metrics.p95Latency, 100);
  });

  it('should advance phase from initializing to warming to evaluating', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a', { warmupSamples: 3, minSamples: 5 });

    assert.strictEqual(canary.getCanaryStatus('skill-a').phase, 'initializing');

    for (let i = 0; i < 3; i++) {
      canary.recordResult('skill-a', { success: true, latency: 10 });
    }
    assert.strictEqual(canary.getCanaryStatus('skill-a').phase, 'warming');

    for (let i = 0; i < 2; i++) {
      canary.recordResult('skill-a', { success: true, latency: 10 });
    }
    assert.strictEqual(canary.getCanaryStatus('skill-a').phase, 'evaluating');
  });
});

describe('SkillCanary - evaluateCanary', () => {
  it('should pass evaluation when success rate and latency meet thresholds', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a', {
      minSamples: 5,
      warmupSamples: 3,
      successRateThreshold: 0.8,
      baseline: { avgLatency: 100 },
    });
    for (let i = 0; i < 5; i++) {
      canary.recordResult('skill-a', { success: true, latency: 50 });
    }
    const result = canary.evaluateCanary('skill-a');
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.reason, 'All criteria met');
  });

  it('should fail evaluation when success rate below threshold', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a', {
      minSamples: 5,
      warmupSamples: 3,
      successRateThreshold: 0.8,
    });
    for (let i = 0; i < 5; i++) {
      canary.recordResult('skill-a', { success: false, latency: 10 });
    }
    const result = canary.evaluateCanary('skill-a');
    assert.strictEqual(result.passed, false);
  });

  it('should emit canary-evaluation-passed/failed events', () => {
    const canary = new SkillCanary();
    canary.enableCanary('pass-skill', { minSamples: 5, warmupSamples: 3 });
    for (let i = 0; i < 5; i++) {
      canary.recordResult('pass-skill', { success: true, latency: 10 });
    }
    let passedEvent = null;
    canary.on('canary-evaluation-passed', (data) => { passedEvent = data; });
    canary.evaluateCanary('pass-skill');
    assert.ok(passedEvent);
    assert.strictEqual(passedEvent.skillId, 'pass-skill');

    const canary2 = new SkillCanary();
    canary2.enableCanary('fail-skill', {
      minSamples: 5,
      warmupSamples: 3,
      successRateThreshold: 0.8,
    });
    for (let i = 0; i < 5; i++) {
      canary2.recordResult('fail-skill', { success: false, latency: 10 });
    }
    let failedEvent = null;
    canary2.on('canary-evaluation-failed', (data) => { failedEvent = data; });
    canary2.evaluateCanary('fail-skill');
    assert.ok(failedEvent);
    assert.strictEqual(failedEvent.skillId, 'fail-skill');
    assert.ok(failedEvent.reasons.length > 0);
  });
});

describe('SkillCanary - promote / rollback', () => {
  it('should promote canary and emit canary-promoted', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    let eventData = null;
    canary.on('canary-promoted', (data) => { eventData = data; });
    const result = canary.promote('skill-a');
    assert.strictEqual(result, true);
    assert.strictEqual(canary.getCanaryStatus('skill-a').phase, 'promoted');
    assert.strictEqual(canary.getCanaryStatus('skill-a').enabled, false);
    assert.ok(eventData);
    assert.strictEqual(eventData.skillId, 'skill-a');
  });

  it('should rollback canary and emit canary-rolled-back', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    let eventData = null;
    canary.on('canary-rolled-back', (data) => { eventData = data; });
    const result = canary.rollback('skill-a');
    assert.strictEqual(result, true);
    assert.strictEqual(canary.getCanaryStatus('skill-a').phase, 'rolled_back');
    assert.strictEqual(canary.getCanaryStatus('skill-a').enabled, false);
    assert.ok(eventData);
    assert.strictEqual(eventData.skillId, 'skill-a');
  });

  it('should return false for unknown skill', () => {
    const canary = new SkillCanary();
    assert.strictEqual(canary.promote('unknown'), false);
    assert.strictEqual(canary.rollback('unknown'), false);
  });
});

describe('SkillCanary - auto evaluation', () => {
  it('should start and stop auto evaluation', () => {
    const canary = new SkillCanary();
    canary.startAutoEvaluation(100);
    assert.ok(canary._autoEvalIntervalId !== null);
    canary.stopAutoEvaluation();
    assert.strictEqual(canary._autoEvalIntervalId, null);
  });

  it('should auto-promote passing canaries', async () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a', {
      minSamples: 5,
      warmupSamples: 3,
      successRateThreshold: 0.8,
    });
    for (let i = 0; i < 5; i++) {
      canary.recordResult('skill-a', { success: true, latency: 10 });
    }
    assert.strictEqual(canary.getCanaryStatus('skill-a').phase, 'evaluating');

    const promoted = new Promise((resolve) => {
      canary.on('canary-promoted', resolve);
    });

    canary.startAutoEvaluation(30);

    const event = await Promise.race([
      promoted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);

    assert.strictEqual(event.skillId, 'skill-a');
    canary.stopAutoEvaluation();
    canary.shutdown();
  });

  it('should auto-rollback failing canaries (3 consecutive failures)', async () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a', {
      minSamples: 5,
      warmupSamples: 3,
      successRateThreshold: 0.8,
    });
    for (let i = 0; i < 5; i++) {
      canary.recordResult('skill-a', { success: false, latency: 10 });
    }
    assert.strictEqual(canary.getCanaryStatus('skill-a').phase, 'evaluating');

    const rolledBack = new Promise((resolve) => {
      canary.on('canary-rolled-back', resolve);
    });

    canary.startAutoEvaluation(30);

    const event = await Promise.race([
      rolledBack,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);

    assert.strictEqual(event.skillId, 'skill-a');
    canary.stopAutoEvaluation();
    canary.shutdown();
  });
});

describe('SkillCanary - limits', () => {
  it('should enforce max canaries limit (50)', () => {
    const canary = new SkillCanary();
    for (let i = 0; i < 50; i++) {
      canary.enableCanary('skill-' + i);
    }
    assert.strictEqual(canary._canaries.size, 50);

    const result = canary.enableCanary('skill-50');
    assert.strictEqual(result, true);
    assert.strictEqual(canary._canaries.size, 50);
    assert.strictEqual(canary.isCanaryEnabled('skill-50'), true);
  });

  it('should enforce max latencies limit (100)', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    for (let i = 0; i < 110; i++) {
      canary.recordResult('skill-a', { success: true, latency: i });
    }
    const internal = canary._canaries.get('skill-a');
    assert.strictEqual(internal.metrics.latencies.length, 100);
  });
});

describe('SkillCanary - isHealthy / getStats', () => {
  it('should be healthy when no failing canaries', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    assert.strictEqual(canary.isHealthy(), true);
  });

  it('should be unhealthy when canary has 3+ eval failures', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a', {
      minSamples: 5,
      warmupSamples: 3,
      successRateThreshold: 0.8,
    });
    for (let i = 0; i < 5; i++) {
      canary.recordResult('skill-a', { success: false, latency: 10 });
    }
    canary.evaluateCanary('skill-a');
    canary.evaluateCanary('skill-a');
    canary.evaluateCanary('skill-a');
    assert.strictEqual(canary.isHealthy(), false);
  });

  it('should return correct stats', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    canary.enableCanary('skill-b');
    assert.strictEqual(canary._canaries.size, 2);
    assert.strictEqual(SkillCanary.MAX_CANARIES, 50);
    assert.strictEqual(SkillCanary.MAX_LATENCIES, 100);
    assert.strictEqual(SkillCanary.PHASE_INITIALIZING, 'initializing');
    assert.strictEqual(SkillCanary.PHASE_WARMING, 'warming');
    assert.strictEqual(SkillCanary.PHASE_EVALUATING, 'evaluating');
    assert.strictEqual(SkillCanary.PHASE_PROMOTED, 'promoted');
    assert.strictEqual(SkillCanary.PHASE_ROLLED_BACK, 'rolled_back');
  });
});

describe('SkillCanary - shutdown', () => {
  it('should stop auto evaluation on shutdown', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    canary.startAutoEvaluation(100);
    assert.ok(canary._autoEvalIntervalId !== null);
    canary.shutdown();
    assert.strictEqual(canary._autoEvalIntervalId, null);
  });

  it('should prevent operations after shutdown', () => {
    const canary = new SkillCanary();
    canary.enableCanary('skill-a');
    canary.shutdown();
    assert.strictEqual(canary.isHealthy(), false);
    assert.strictEqual(canary.getCanaryMetrics('skill-a'), null);
    assert.strictEqual(canary.isCanaryEnabled('skill-a'), false);
  });
});
