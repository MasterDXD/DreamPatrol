'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ResultAggregator = require(
  path.join(ROOT, 'src', 'runtime', 'collaboration', 'result-aggregator'),
);
const AGGREGATION_STRATEGY = ResultAggregator.AGGREGATION_STRATEGY;

const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}

describe('ResultAggregator', () => {
  afterEach(async () => { await _cleanAll(); });

  it('should construct with default config', () => {
    const ra = _track(new ResultAggregator());
    assert.ok(ra);
    assert.strictEqual(ra._config.defaultStrategy, AGGREGATION_STRATEGY.FUSION);
    assert.strictEqual(ra._config.qualityThreshold, 0.7);
    assert.strictEqual(ra._config.maxRetries, 2);
    assert.strictEqual(ra.isHealthy(), true);
  });

  it('should aggregate with FUSION strategy', () => {
    const ra = _track(new ResultAggregator());
    const results = [
      { content: { name: 'Alice', score: 90 } },
      { content: { name: 'Bob', grade: 'A' } },
    ];
    const result = ra.aggregate(results, { strategy: AGGREGATION_STRATEGY.FUSION });
    assert.strictEqual(result.strategy, AGGREGATION_STRATEGY.FUSION);
    assert.ok(result.aggregated);
    assert.strictEqual(result.aggregated.content.name, 'Alice');
    assert.strictEqual(result.aggregated.content.grade, 'A');
    assert.strictEqual(typeof result.qualityScore, 'number');
    assert.strictEqual(result.sourceCount, 2);
  });

  it('should aggregate with VOTE strategy', () => {
    const ra = _track(new ResultAggregator());
    const results = [
      { decision: 'approve' },
      { decision: 'approve' },
      { decision: 'reject' },
    ];
    const result = ra.aggregate(results, { strategy: AGGREGATION_STRATEGY.VOTE });
    assert.strictEqual(result.strategy, AGGREGATION_STRATEGY.VOTE);
    assert.strictEqual(result.aggregated.winner, 'approve');
    assert.strictEqual(result.aggregated.votes.approve, 2);
    assert.strictEqual(result.aggregated.votes.reject, 1);
    assert.ok(result.aggregated.confidence > 0);
  });

  it('should aggregate with BEST_OF strategy', () => {
    const ra = _track(new ResultAggregator());
    const results = [
      { content: 'low quality', qualityScore: 0.3 },
      { content: 'high quality', qualityScore: 0.9 },
      { content: 'mid quality', qualityScore: 0.6 },
    ];
    const result = ra.aggregate(results, { strategy: AGGREGATION_STRATEGY.BEST_OF });
    assert.strictEqual(result.strategy, AGGREGATION_STRATEGY.BEST_OF);
    assert.strictEqual(result.aggregated.bestIndex, 1);
    assert.strictEqual(result.aggregated.best, 'high quality');
    assert.deepStrictEqual(result.aggregated.scores, [0.3, 0.9, 0.6]);
  });

  it('should aggregate with SUMMARY strategy', () => {
    const ra = _track(new ResultAggregator());
    const results = [
      { content: '第一段内容' },
      { content: '第二段内容' },
    ];
    const result = ra.aggregate(results, { strategy: AGGREGATION_STRATEGY.SUMMARY });
    assert.strictEqual(result.strategy, AGGREGATION_STRATEGY.SUMMARY);
    assert.ok(result.aggregated.summary);
    assert.strictEqual(result.aggregated.sourceCount, 2);
    assert.ok(Array.isArray(result.aggregated.keyPoints));
  });

  it('should aggregate with HIERARCHICAL strategy', () => {
    const ra = _track(new ResultAggregator());
    const results = [
      { content: { a: 1 } },
      { content: { b: 2 } },
      { content: { c: 3 } },
      { content: { d: 4 } },
    ];
    const result = ra.aggregate(results, { strategy: AGGREGATION_STRATEGY.HIERARCHICAL });
    assert.strictEqual(result.strategy, AGGREGATION_STRATEGY.HIERARCHICAL);
    assert.ok(result.aggregated.layers);
    assert.ok(result.aggregated.depth >= 1);
    assert.ok(result.aggregated.topLevel != null);
  });

  it('should return no_results for empty array', () => {
    const ra = _track(new ResultAggregator());
    const result = ra.aggregate([]);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'no_results');
    assert.strictEqual(result.aggregated, null);
  });

  it('should _assessQuality return score between 0 and 1', () => {
    const ra = _track(new ResultAggregator());
    const results = [{ content: 'test' }];
    const score = ra._assessQuality({ merged: 'data' }, results);
    assert.ok(typeof score === 'number');
    assert.ok(score >= 0 && score <= 1);
  });

  it('should attachLlmClient return this', () => {
    const ra = _track(new ResultAggregator());
    const returned = ra.attachLlmClient({ summarize: () => {} });
    assert.strictEqual(returned, ra);
  });

  it('should prevent operations after shutdown', () => {
    const ra = _track(new ResultAggregator());
    ra.shutdown();
    assert.throws(() => ra.aggregate([{ content: 'test' }]), /shut down/);
  });
});
