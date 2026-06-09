'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const TriAttentionModule = require(path.join(ROOT, 'src', 'runtime', 'model', 'tri-attention'));
const TriAttention = TriAttentionModule.TriAttention || TriAttentionModule;

describe('TriAttention - Constructor', () => {
  it('should create instance with default config', () => {
    const ta = new TriAttention();
    assert.ok(ta);
    assert.strictEqual(ta._config.attentionThreshold, 0.3);
    assert.strictEqual(ta._config.maxContextEntries, 500);
    assert.strictEqual(ta._config.recencyDecay, 0.95);
    assert.strictEqual(ta._config.enablePreRopeScoring, false);
    assert.strictEqual(ta._config.calibrationCenter, null);
    assert.strictEqual(ta._config.magnitudeWeight, 0.5);
    assert.strictEqual(ta._config.concentrationThreshold, 0.8);
  });

  it('should merge custom options with defaults', () => {
    const ta = new TriAttention({ attentionThreshold: 0.5 });
    assert.strictEqual(ta._config.attentionThreshold, 0.5);
    assert.strictEqual(ta._config.maxContextEntries, 500);
  });

  it('should initialize counters to zero', () => {
    const ta = new TriAttention();
    assert.strictEqual(ta._optimizeCount, 0);
    assert.strictEqual(ta._totalPruned, 0);
    assert.strictEqual(ta._totalTokensSaved, 0);
  });

  it('should expose DEFAULT_CONFIG', () => {
    assert.ok(TriAttentionModule.DEFAULT_CONFIG);
    assert.strictEqual(TriAttentionModule.DEFAULT_CONFIG.attentionThreshold, 0.3);
  });

  it('should initialize calibration state to null', () => {
    const ta = new TriAttention();
    assert.strictEqual(ta._qCenter, null);
    assert.strictEqual(ta._kCenter, null);
    assert.strictEqual(ta._qConcentration, 0);
    assert.strictEqual(ta._kConcentration, 0);
  });

  it('should accept calibrationCenter in config', () => {
    const ta = new TriAttention({
      calibrationCenter: { qCenter: [1, 0], kCenter: [0, 1] },
    });
    assert.deepStrictEqual(ta._qCenter, [1, 0]);
    assert.deepStrictEqual(ta._kCenter, [0, 1]);
  });
});

describe('TriAttention - optimize', () => {
  it('should optimize context window with entries', () => {
    const ta = new TriAttention();
    const contextWindow = {
      entries: [
        { content: 'important task context', importance: 0.9, recency: 0.9 },
        { content: 'less relevant info', importance: 0.1, recency: 0.1 },
        { content: 'moderate info', importance: 0.5, recency: 0.5 },
      ],
    };
    const budget = { maxTokens: 1000, reservedTokens: 0 };
    const result = ta.optimize(contextWindow, budget);
    assert.ok(result.optimized);
    assert.ok(result.pruned);
    assert.strictEqual(typeof result.tokensSaved, 'number');
    assert.strictEqual(typeof result.compressionRatio, 'number');
  });

  it('should handle empty entries', () => {
    const ta = new TriAttention();
    const result = ta.optimize({ entries: [] }, { maxTokens: 1000 });
    assert.deepStrictEqual(result.optimized, []);
    assert.deepStrictEqual(result.pruned, []);
    assert.strictEqual(result.tokensSaved, 0);
    assert.strictEqual(result.compressionRatio, 1);
  });

  it('should throw for invalid contextWindow', () => {
    const ta = new TriAttention();
    assert.throws(() => ta.optimize(null, { maxTokens: 1000 }), /contextWindow/);
    assert.throws(() => ta.optimize('string', { maxTokens: 1000 }), /contextWindow/);
  });

  it('should throw for invalid budget', () => {
    const ta = new TriAttention();
    assert.throws(() => ta.optimize({ entries: [] }, null), /budget/);
    assert.throws(() => ta.optimize({ entries: [] }, 'string'), /budget/);
  });

  it('should keep high-attention entries with infinite budget', () => {
    const ta = new TriAttention({ attentionThreshold: 0.1 });
    const contextWindow = {
      entries: [
        { content: 'first', importance: 1.0, recency: 1.0 },
        { content: 'second', importance: 1.0, recency: 1.0 },
        { content: 'third', importance: 1.0, recency: 1.0 },
      ],
    };
    const result = ta.optimize(contextWindow, {});
    assert.ok(result.optimized.length >= 1);
    assert.ok(result.pruned.length < 3);
  });

  it('should prune low-attention entries when budget is tight', () => {
    const ta = new TriAttention({ attentionThreshold: 0.5 });
    const contextWindow = {
      entries: [
        { content: 'high attention', importance: 1.0, recency: 1.0 },
        { content: 'low attention', importance: 0.1, recency: 0.1 },
      ],
    };
    const budget = { maxTokens: 5, reservedTokens: 0 };
    const result = ta.optimize(contextWindow, budget);
    assert.ok(result.pruned.length > 0);
  });

  it('should emit optimized event', () => {
    const ta = new TriAttention();
    let emitted = false;
    ta.on('optimized', () => { emitted = true; });
    ta.optimize({ entries: [] }, { maxTokens: 1000 });
    assert.strictEqual(emitted, true);
  });

  it('should increment optimize count', () => {
    const ta = new TriAttention();
    ta.optimize({ entries: [] }, { maxTokens: 1000 });
    ta.optimize({ entries: [] }, { maxTokens: 1000 });
    assert.strictEqual(ta._optimizeCount, 2);
  });
});

describe('TriAttention - estimateAttention', () => {
  it('should return 0 for null entry', () => {
    const ta = new TriAttention();
    assert.strictEqual(ta.estimateAttention(null, 0, 1), 0);
  });

  it('should return 0 for non-object entry', () => {
    const ta = new TriAttention();
    assert.strictEqual(ta.estimateAttention('string', 0, 1), 0);
  });

  it('should compute attention based on importance and recency', () => {
    const ta = new TriAttention();
    const attention = ta.estimateAttention({ importance: 1.0, recency: 1.0 }, 0, 1);
    assert.ok(attention >= 0);
    assert.ok(attention <= 1);
  });

  it('should return 0 for zero importance', () => {
    const ta = new TriAttention();
    const attention = ta.estimateAttention({ importance: 0, recency: 1.0 }, 0, 10);
    assert.strictEqual(attention, 0);
  });

  it('should return 0 for zero recency', () => {
    const ta = new TriAttention();
    const attention = ta.estimateAttention({ importance: 1.0, recency: 0 }, 0, 10);
    assert.strictEqual(attention, 0);
  });

  it('should use defaults for missing properties', () => {
    const ta = new TriAttention();
    const attention = ta.estimateAttention({}, 0, 10);
    assert.strictEqual(attention, 0);
  });
});

describe('TriAttention - getStats', () => {
  it('should return stats object', () => {
    const ta = new TriAttention();
    const stats = ta.getStats();
    assert.strictEqual(stats.optimizeCount, 0);
    assert.strictEqual(stats.totalPruned, 0);
    assert.strictEqual(stats.totalTokensSaved, 0);
    assert.ok(stats.config);
  });

  it('should reflect optimization activity', () => {
    const ta = new TriAttention();
    ta.optimize({ entries: [] }, { maxTokens: 1000 });
    const stats = ta.getStats();
    assert.strictEqual(stats.optimizeCount, 1);
  });
});

describe('TriAttention - shutdown', () => {
  it('should reset counters on shutdown', () => {
    const ta = new TriAttention();
    ta.optimize({ entries: [] }, { maxTokens: 1000 });
    ta.shutdown();
    assert.strictEqual(ta._optimizeCount, 0);
    assert.strictEqual(ta._totalPruned, 0);
    assert.strictEqual(ta._totalTokensSaved, 0);
    assert.strictEqual(ta._shutDown, true);
  });

  it('should prevent operations after shutdown', () => {
    const ta = new TriAttention();
    ta.shutdown();
    assert.throws(() => ta.optimize({ entries: [] }, { maxTokens: 1000 }), /shut down/i);
  });

  it('should reset calibration state on shutdown', () => {
    const ta = new TriAttention();
    ta.calibrate([[1, 0], [0, 1]], [[1, 0], [0, 1]]);
    ta.shutdown();
    assert.strictEqual(ta._qCenter, null);
    assert.strictEqual(ta._kCenter, null);
    assert.strictEqual(ta._qConcentration, 0);
    assert.strictEqual(ta._kConcentration, 0);
  });
});

describe('TriAttention - calibrate', () => {
  it('should compute centers from Q and K vectors', () => {
    const ta = new TriAttention();
    const result = ta.calibrate([[1, 0], [3, 0]], [[0, 2], [0, 4]]);
    assert.deepStrictEqual(result.qCenter, [2, 0]);
    assert.deepStrictEqual(result.kCenter, [0, 3]);
  });

  it('should compute concentration values', () => {
    const ta = new TriAttention();
    const result = ta.calibrate([[1, 0], [1.01, 0], [0.99, 0]], [[0, 1], [0, 1.01], [0, 0.99]]);
    assert.ok(result.qConcentration >= 0);
    assert.ok(result.qConcentration <= 1);
    assert.ok(result.kConcentration >= 0);
    assert.ok(result.kConcentration <= 1);
  });

  it('should return concentration 1 for single vector', () => {
    const ta = new TriAttention();
    const result = ta.calibrate([[1, 2]], [[3, 4]]);
    assert.strictEqual(result.qConcentration, 1);
    assert.strictEqual(result.kConcentration, 1);
  });

  it('should throw for empty qVectors', () => {
    const ta = new TriAttention();
    assert.throws(() => ta.calibrate([], [[1, 0]]), /qVectors/);
  });

  it('should throw for non-array qVectors', () => {
    const ta = new TriAttention();
    assert.throws(() => ta.calibrate('bad', [[1, 0]]), /qVectors/);
  });

  it('should throw for empty kVectors', () => {
    const ta = new TriAttention();
    assert.throws(() => ta.calibrate([[1, 0]], []), /kVectors/);
  });

  it('should throw for non-array kVectors', () => {
    const ta = new TriAttention();
    assert.throws(() => ta.calibrate([[1, 0]], null), /kVectors/);
  });

  it('should handle non-numeric values in vectors gracefully', () => {
    const ta = new TriAttention();
    const result = ta.calibrate([[1, 'bad'], [3, NaN]], [[0, 2], [0, 4]]);
    assert.ok(Number.isFinite(result.qCenter[0]));
    assert.strictEqual(result.qCenter[1], 0);
  });

  it('should store calibration state internally', () => {
    const ta = new TriAttention();
    ta.calibrate([[1, 0], [0, 1]], [[1, 0], [0, 1]]);
    assert.ok(ta._qCenter != null);
    assert.ok(ta._kCenter != null);
    assert.ok(ta._qConcentration > 0 || ta._qConcentration === 0);
    assert.ok(ta._kConcentration > 0 || ta._kConcentration === 0);
  });
});

describe('TriAttention - _computePreRopeScore', () => {
  it('should return score in [0, 1] range', () => {
    const ta = new TriAttention({ enablePreRopeScoring: true });
    ta.calibrate([[1, 0], [0, 1]], [[1, 0], [0, 1]]);
    const score = ta._computePreRopeScore({ importance: 0.8, recency: 0.8, vector: [0.5, 0.5] }, 0, 10);
    assert.ok(score >= 0);
    assert.ok(score <= 1);
  });

  it('should use distance preference via trigonometric series', () => {
    const ta = new TriAttention({ enablePreRopeScoring: true, magnitudeWeight: 0 });
    ta.calibrate([[1, 0], [0, 1]], [[1, 0], [0, 1]]);
    const scoreMiddle = ta._computePreRopeScore({ importance: 1, recency: 1, vector: [1, 0] }, 5, 10);
    const scoreEdge = ta._computePreRopeScore({ importance: 1, recency: 1, vector: [1, 0] }, 0, 10);
    assert.ok(scoreMiddle >= scoreEdge);
  });

  it('should use magnitude score from vector norm vs center distance', () => {
    const ta = new TriAttention({ enablePreRopeScoring: true, magnitudeWeight: 1 });
    ta.calibrate([[1, 0], [1, 0]], [[1, 0], [1, 0]]);
    const scoreNear = ta._computePreRopeScore({ importance: 1, recency: 1, vector: [1, 0] }, 0, 10);
    const scoreFar = ta._computePreRopeScore({ importance: 1, recency: 1, vector: [0, 10] }, 0, 10);
    assert.ok(scoreNear >= scoreFar);
  });

  it('should handle entry without vector', () => {
    const ta = new TriAttention({ enablePreRopeScoring: true });
    ta.calibrate([[1, 0], [0, 1]], [[1, 0], [0, 1]]);
    const score = ta._computePreRopeScore({ importance: 1, recency: 1 }, 0, 10);
    assert.ok(score >= 0);
    assert.ok(score <= 1);
  });

  it('should adjust weights based on concentration', () => {
    const ta = new TriAttention({ enablePreRopeScoring: true, magnitudeWeight: 0.5, concentrationThreshold: 0.5 });
    ta.calibrate([[1, 0], [1.01, 0], [0.99, 0]], [[0, 1], [0, 1.01], [0, 0.99]]);
    const score = ta._computePreRopeScore({ importance: 1, recency: 1, vector: [1, 0] }, 5, 10);
    assert.ok(score >= 0);
    assert.ok(score <= 1);
  });

  it('should default importance and recency to 0.5 in pre-rope mode', () => {
    const ta = new TriAttention({ enablePreRopeScoring: true });
    ta.calibrate([[1, 0], [0, 1]], [[1, 0], [0, 1]]);
    const scoreNoProps = ta._computePreRopeScore({ vector: [1, 0] }, 5, 10);
    const scoreFullProps = ta._computePreRopeScore({ importance: 0.5, recency: 0.5, vector: [1, 0] }, 5, 10);
    assert.ok(Math.abs(scoreNoProps - scoreFullProps) < 0.001);
  });

  it('should return 1.0 for single position', () => {
    const ta = new TriAttention({ enablePreRopeScoring: true, magnitudeWeight: 0 });
    ta.calibrate([[1, 0]], [[0, 1]]);
    const score = ta._computePreRopeScore({ importance: 1, recency: 1, vector: [1, 0] }, 0, 1);
    assert.strictEqual(score, 1);
  });
});

describe('TriAttention - estimateAttention with enablePreRopeScoring', () => {
  it('should use _computePreRopeScore when enabled and calibrated', () => {
    const ta = new TriAttention({ enablePreRopeScoring: true });
    ta.calibrate([[1, 0], [0, 1]], [[1, 0], [0, 1]]);
    const score = ta.estimateAttention({ importance: 0.8, recency: 0.8, vector: [0.5, 0.5] }, 5, 10);
    assert.ok(score >= 0);
    assert.ok(score <= 1);
  });

  it('should fall back to original logic when not enabled', () => {
    const ta = new TriAttention({ enablePreRopeScoring: false });
    ta.calibrate([[1, 0], [0, 1]], [[1, 0], [0, 1]]);
    const score = ta.estimateAttention({ importance: 1.0, recency: 1.0 }, 0, 1);
    assert.strictEqual(score, 1);
  });

  it('should fall back to original logic when enabled but not calibrated', () => {
    const ta = new TriAttention({ enablePreRopeScoring: true });
    const score = ta.estimateAttention({ importance: 1.0, recency: 1.0 }, 0, 1);
    assert.strictEqual(score, 1);
  });
});

describe('TriAttention - getCalibrationStats', () => {
  it('should return uncalibrated state initially', () => {
    const ta = new TriAttention();
    const stats = ta.getCalibrationStats();
    assert.strictEqual(stats.qCenter, null);
    assert.strictEqual(stats.kCenter, null);
    assert.strictEqual(stats.qConcentration, 0);
    assert.strictEqual(stats.kConcentration, 0);
    assert.strictEqual(stats.isCalibrated, false);
  });

  it('should return calibrated state after calibrate', () => {
    const ta = new TriAttention();
    ta.calibrate([[1, 0], [0, 1]], [[1, 0], [0, 1]]);
    const stats = ta.getCalibrationStats();
    assert.ok(stats.qCenter != null);
    assert.ok(stats.kCenter != null);
    assert.strictEqual(stats.isCalibrated, true);
  });

  it('should reflect calibration values', () => {
    const ta = new TriAttention();
    const result = ta.calibrate([[1, 0], [3, 0]], [[0, 2], [0, 4]]);
    const stats = ta.getCalibrationStats();
    assert.deepStrictEqual(stats.qCenter, result.qCenter);
    assert.deepStrictEqual(stats.kCenter, result.kCenter);
    assert.strictEqual(stats.qConcentration, result.qConcentration);
    assert.strictEqual(stats.kConcentration, result.kConcentration);
  });
});
