'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('FeedbackCredibility', () => {
  const FeedbackCredibility = require(path.join(ROOT, 'src', 'runtime', 'quality', 'feedback-credibility'));

  it('should construct with default config', () => {
    const fc = new FeedbackCredibility();
    assert.strictEqual(fc._sourceTrust.size, 0);
    fc.shutdown();
  });

  it('should initialize source trust on first feedback', () => {
    const fc = new FeedbackCredibility();
    fc.recordFeedback('source-a', { predicted: true }, true);
    assert.strictEqual(fc._sourceTrust.size, 1);
    const trust = fc._sourceTrust.get('source-a');
    assert.strictEqual(trust.score, 1);
    assert.strictEqual(trust.samples, 1);
    fc.shutdown();
  });

  it('should track accuracy over multiple feedbacks', () => {
    const fc = new FeedbackCredibility();
    fc.recordFeedback('source-a', { predicted: true }, true);
    fc.recordFeedback('source-a', { predicted: false }, true);
    fc.recordFeedback('source-a', { predicted: true }, false);
    const trust = fc._sourceTrust.get('source-a');
    assert.strictEqual(trust.samples, 3);
    assert.strictEqual(trust.correctCount, 2);
    assert.ok(Math.abs(trust.score - 0.667) < 0.01);
    fc.shutdown();
  });

  it('should get trust score for unknown source', () => {
    const fc = new FeedbackCredibility();
    const score = fc.getTrustScore('unknown');
    assert.strictEqual(score, 0.5);
    fc.shutdown();
  });

  it('should get trust score for known source', () => {
    const fc = new FeedbackCredibility();
    fc.recordFeedback('source-a', { predicted: true }, true);
    fc.recordFeedback('source-a', { predicted: true }, true);
    const score = fc.getTrustScore('source-a');
    assert.strictEqual(score, 1.0);
    fc.shutdown();
  });

  it('should compute weighted feedback', () => {
    const fc = new FeedbackCredibility();
    fc.recordFeedback('trusted', { predicted: true }, true);
    fc.recordFeedback('trusted', { predicted: true }, true);
    fc.recordFeedback('untrusted', { predicted: true }, false);
    fc.recordFeedback('untrusted', { predicted: true }, false);
    const feedbacks = [
      { sourceId: 'trusted', value: 1.0 },
      { sourceId: 'untrusted', value: 0.5 },
    ];
    const weighted = fc.getWeightedFeedback(feedbacks);
    assert.ok(weighted > 0.7);
    fc.shutdown();
  });

  it('should return 0 for empty feedback array', () => {
    const fc = new FeedbackCredibility();
    const weighted = fc.getWeightedFeedback([]);
    assert.strictEqual(weighted, 0);
    fc.shutdown();
  });

  it('should decay trust over time', () => {
    const fc = new FeedbackCredibility({ decayFactor: 0.9 });
    fc.recordFeedback('source-a', { predicted: true }, true);
    fc.recordFeedback('source-a', { predicted: true }, true);
    const trust = fc._sourceTrust.get('source-a');
    trust.lastRecordedAt = Date.now() - 86400000 * 30;
    fc.decayTrustScores();
    assert.ok(trust.score < 1.0);
    fc.shutdown();
  });

  it('should shutdown cleanly', () => {
    const fc = new FeedbackCredibility();
    fc.recordFeedback('s1', { predicted: true }, true);
    fc.shutdown();
    assert.strictEqual(fc._sourceTrust.size, 0);
  });
});
