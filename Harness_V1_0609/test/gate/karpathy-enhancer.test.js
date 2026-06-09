'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const KEModule = require(path.join(ROOT, 'src', 'gate', 'karpathy-enhancer'));
const KarpathyEnhancer = KEModule.KarpathyEnhancer || KEModule;

describe('KarpathyEnhancer - Constructor', () => {
  it('should create instance with default config', () => {
    const ke = new KarpathyEnhancer();
    assert.ok(ke);
    assert.strictEqual(ke._config.diffHygieneThreshold, 0.8);
    assert.strictEqual(ke._config.maxReworkCount, 3);
    assert.strictEqual(ke._config.minClarificationRate, 0.5);
    assert.strictEqual(ke._config.maxOrphanRate, 0.05);
  });

  it('should merge custom options with defaults', () => {
    const ke = new KarpathyEnhancer({ diffHygieneThreshold: 0.9 });
    assert.strictEqual(ke._config.diffHygieneThreshold, 0.9);
    assert.strictEqual(ke._config.maxReworkCount, 3);
  });

  it('should initialize counters to zero', () => {
    const ke = new KarpathyEnhancer();
    assert.strictEqual(ke._enhanceCount, 0);
    assert.strictEqual(ke._measureCount, 0);
    assert.strictEqual(ke._reworkTracker.size, 0);
  });

  it('should expose DEFAULT_CONFIG and ENHANCEMENT_RULES', () => {
    assert.ok(KEModule.DEFAULT_CONFIG);
    assert.ok(KEModule.ENHANCEMENT_RULES);
    assert.strictEqual(KEModule.ENHANCEMENT_RULES.DIFF_HYGIENE.id, 'diff-hygiene');
    assert.strictEqual(KEModule.ENHANCEMENT_RULES.REWORK_RATE.id, 'rework-rate');
    assert.strictEqual(KEModule.ENHANCEMENT_RULES.CLARIFICATION_FIRST.id, 'clarification-first');
    assert.strictEqual(KEModule.ENHANCEMENT_RULES.ORPHAN_CODE_RATE.id, 'orphan-code-rate');
    assert.strictEqual(KEModule.ENHANCEMENT_RULES.THINKING_QUALITY.id, 'thinking-quality');
    assert.strictEqual(KEModule.ENHANCEMENT_RULES.STRONG_CRITERIA_RATIO.id, 'strong-criteria-ratio');
  });
});

describe('KarpathyEnhancer - enhance', () => {
  it('should enhance existing rules with Karpathy rules', () => {
    const ke = new KarpathyEnhancer();
    const rules = ke.enhance({ existingRule: { level: 'info' } });
    assert.ok(rules['existingRule']);
    assert.ok(rules['diff-hygiene']);
    assert.ok(rules['rework-rate']);
    assert.ok(rules['clarification-first']);
    assert.ok(rules['orphan-code-rate']);
  });

  it('should enhance with no existing rules', () => {
    const ke = new KarpathyEnhancer();
    const rules = ke.enhance(null);
    assert.ok(rules['diff-hygiene']);
    assert.strictEqual(Object.keys(rules).length, 6);
  });

  it('should enhance with empty object', () => {
    const ke = new KarpathyEnhancer();
    const rules = ke.enhance({});
    assert.ok(rules['diff-hygiene']);
  });

  it('should include check functions in rules', () => {
    const ke = new KarpathyEnhancer();
    const rules = ke.enhance({});
    assert.strictEqual(typeof rules['diff-hygiene'].check, 'function');
    assert.strictEqual(typeof rules['rework-rate'].check, 'function');
    assert.strictEqual(typeof rules['clarification-first'].check, 'function');
    assert.strictEqual(typeof rules['orphan-code-rate'].check, 'function');
  });

  it('should emit rules-enhanced event', () => {
    const ke = new KarpathyEnhancer();
    let emitted = false;
    ke.on('rules-enhanced', () => { emitted = true; });
    ke.enhance({});
    assert.strictEqual(emitted, true);
  });

  it('should increment enhance count', () => {
    const ke = new KarpathyEnhancer();
    ke.enhance({});
    ke.enhance({});
    assert.strictEqual(ke._enhanceCount, 2);
  });
});

describe('KarpathyEnhancer - diff-hygiene rule', () => {
  it('should trigger when diff hygiene is below threshold', () => {
    const ke = new KarpathyEnhancer({ diffHygieneThreshold: 0.8 });
    const rules = ke.enhance({});
    const triggered = rules['diff-hygiene'].check({ totalDiffs: 10, cleanDiffs: 5 });
    assert.strictEqual(triggered, true);
  });

  it('should not trigger when diff hygiene is above threshold', () => {
    const ke = new KarpathyEnhancer({ diffHygieneThreshold: 0.8 });
    const rules = ke.enhance({});
    const triggered = rules['diff-hygiene'].check({ totalDiffs: 10, cleanDiffs: 9 });
    assert.strictEqual(triggered, false);
  });

  it('should not trigger when no diffs', () => {
    const ke = new KarpathyEnhancer();
    const rules = ke.enhance({});
    const triggered = rules['diff-hygiene'].check({ totalDiffs: 0 });
    assert.strictEqual(triggered, false);
  });
});

describe('KarpathyEnhancer - rework-rate rule', () => {
  it('should trigger when rework count exceeds threshold', () => {
    const ke = new KarpathyEnhancer({ maxReworkCount: 3 });
    const rules = ke.enhance({});
    const triggered = rules['rework-rate'].check({
      reworkAreas: [{ name: 'auth', count: 5 }],
    });
    assert.strictEqual(triggered, true);
  });

  it('should not trigger when rework count is within threshold', () => {
    const ke = new KarpathyEnhancer({ maxReworkCount: 3 });
    const rules = ke.enhance({});
    const triggered = rules['rework-rate'].check({
      reworkAreas: [{ name: 'auth', count: 2 }],
    });
    assert.strictEqual(triggered, false);
  });
});

describe('KarpathyEnhancer - clarification-first rule', () => {
  it('should trigger when clarification rate is below minimum', () => {
    const ke = new KarpathyEnhancer({ minClarificationRate: 0.5 });
    const rules = ke.enhance({});
    const triggered = rules['clarification-first'].check({ totalTasks: 10, clarificationsBefore: 2 });
    assert.strictEqual(triggered, true);
  });

  it('should not trigger when clarification rate is sufficient', () => {
    const ke = new KarpathyEnhancer({ minClarificationRate: 0.5 });
    const rules = ke.enhance({});
    const triggered = rules['clarification-first'].check({ totalTasks: 10, clarificationsBefore: 6 });
    assert.strictEqual(triggered, false);
  });
});

describe('KarpathyEnhancer - orphan-code-rate rule', () => {
  it('should trigger when orphan rate exceeds maximum', () => {
    const ke = new KarpathyEnhancer({ maxOrphanRate: 0.05 });
    const rules = ke.enhance({});
    const triggered = rules['orphan-code-rate'].check({ totalLines: 1000, orphanCodeLines: 100 });
    assert.strictEqual(triggered, true);
  });

  it('should not trigger when orphan rate is within limit', () => {
    const ke = new KarpathyEnhancer({ maxOrphanRate: 0.05 });
    const rules = ke.enhance({});
    const triggered = rules['orphan-code-rate'].check({ totalLines: 1000, orphanCodeLines: 30 });
    assert.strictEqual(triggered, false);
  });
});

describe('KarpathyEnhancer - measureEffectiveness', () => {
  it('should measure effectiveness of good metrics', () => {
    const ke = new KarpathyEnhancer();
    const result = ke.measureEffectiveness({
      totalDiffs: 10,
      cleanDiffs: 9,
      reworkAreas: [],
      clarificationsBefore: 8,
      totalTasks: 10,
      orphanCodeLines: 10,
      totalLines: 1000,
    });
    assert.strictEqual(typeof result.diffHygiene, 'number');
    assert.strictEqual(typeof result.reworkRate, 'number');
    assert.strictEqual(typeof result.clarificationRate, 'number');
    assert.strictEqual(typeof result.orphanRate, 'number');
    assert.strictEqual(typeof result.overallScore, 'number');
    assert.ok(result.overallScore > 0);
    assert.ok(result.overallScore <= 1);
  });

  it('should measure effectiveness of poor metrics', () => {
    const ke = new KarpathyEnhancer();
    const result = ke.measureEffectiveness({
      totalDiffs: 10,
      cleanDiffs: 2,
      reworkAreas: [{ name: 'auth', count: 5 }],
      clarificationsBefore: 1,
      totalTasks: 10,
      orphanCodeLines: 500,
      totalLines: 1000,
    });
    assert.ok(result.diffHygiene < 0.5);
    assert.ok(result.reworkRate > 0);
    assert.ok(result.clarificationRate < 0.5);
    assert.ok(result.orphanRate > 0);
  });

  it('should throw for invalid metrics', () => {
    const ke = new KarpathyEnhancer();
    assert.throws(() => ke.measureEffectiveness(null), /object/);
    assert.throws(() => ke.measureEffectiveness('string'), /object/);
  });

  it('should handle empty metrics', () => {
    const ke = new KarpathyEnhancer();
    const result = ke.measureEffectiveness({});
    assert.strictEqual(result.diffHygiene, 1);
    assert.strictEqual(result.reworkRate, 0);
    assert.strictEqual(result.clarificationRate, 0);
    assert.strictEqual(result.orphanRate, 0);
  });

  it('should emit effectiveness-measured event', () => {
    const ke = new KarpathyEnhancer();
    let emitted = false;
    ke.on('effectiveness-measured', () => { emitted = true; });
    ke.measureEffectiveness({});
    assert.strictEqual(emitted, true);
  });

  it('should track rework areas', () => {
    const ke = new KarpathyEnhancer();
    ke.measureEffectiveness({ reworkAreas: [{ name: 'auth', count: 5 }] });
    assert.strictEqual(ke._reworkTracker.has('auth'), true);
    assert.strictEqual(ke._reworkTracker.get('auth'), 5);
  });

  it('should increment measure count', () => {
    const ke = new KarpathyEnhancer();
    ke.measureEffectiveness({});
    ke.measureEffectiveness({});
    assert.strictEqual(ke._measureCount, 2);
  });
});

describe('KarpathyEnhancer - getStats', () => {
  it('should return stats object', () => {
    const ke = new KarpathyEnhancer();
    const stats = ke.getStats();
    assert.strictEqual(stats.enhanceCount, 0);
    assert.strictEqual(stats.measureCount, 0);
    assert.strictEqual(stats.trackedAreas, 0);
    assert.ok(stats.config);
  });

  it('should reflect activity', () => {
    const ke = new KarpathyEnhancer();
    ke.enhance({});
    ke.measureEffectiveness({ reworkAreas: [{ name: 'auth', count: 3 }] });
    const stats = ke.getStats();
    assert.strictEqual(stats.enhanceCount, 1);
    assert.strictEqual(stats.measureCount, 1);
    assert.strictEqual(stats.trackedAreas, 1);
  });
});

describe('KarpathyEnhancer - shutdown', () => {
  it('should reset counters on shutdown', () => {
    const ke = new KarpathyEnhancer();
    ke.enhance({});
    ke.measureEffectiveness({});
    ke.shutdown();
    assert.strictEqual(ke._enhanceCount, 0);
    assert.strictEqual(ke._measureCount, 0);
    assert.strictEqual(ke._reworkTracker.size, 0);
    assert.strictEqual(ke._shutDown, true);
  });

  it('should prevent operations after shutdown', () => {
    const ke = new KarpathyEnhancer();
    ke.shutdown();
    assert.throws(() => ke.enhance({}), /shut down/i);
  });
});
