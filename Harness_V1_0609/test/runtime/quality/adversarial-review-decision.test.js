'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const AdversarialReview = require('../../../src/runtime/quality/adversarial-review');

describe('AdversarialReview Decision Mode', () => {
  it('should perform decision adversarial review', async () => {
    const reviewer = new AdversarialReview();
    const result = await reviewer.decisionAdversarial('Enter Southeast Asian market', {
      roles: ['cfo', 'investor', 'veteran'],
    });
    assert.equal(result.type, 'decision_adversarial');
    assert.equal(result.attacks.length, 3);
    assert.ok(result.antiSycophancyCheck);
  });

  it('should use default roles when not specified', async () => {
    const reviewer = new AdversarialReview();
    const result = await reviewer.decisionAdversarial('Test proposal');
    assert.equal(result.attacks.length, 3);
    assert.equal(result.attacks[0].role, 'cfo');
  });

  it('should include engineer and ux_fanatic roles', async () => {
    const reviewer = new AdversarialReview();
    const result = await reviewer.decisionAdversarial('Test', {
      roles: ['engineer', 'ux_fanatic'],
    });
    assert.equal(result.attacks.length, 2);
    assert.equal(result.attacks[0].role, 'engineer');
    assert.equal(result.attacks[1].role, 'ux_fanatic');
  });

  it('should perform falsification check', () => {
    const reviewer = new AdversarialReview();
    const result = reviewer.falsificationCheck('This feature will increase retention', {
      metric: 'retention_rate',
      target: 0.2,
    });
    assert.equal(result.conclusion, 'This feature will increase retention');
    assert.equal(result.confidenceLevel, 'unverified');
    assert.ok(result.whyItMightNotWork);
    assert.ok(result.falsificationSignals);
  });

  it('should handle empty proposal', async () => {
    const reviewer = new AdversarialReview();
    const result = await reviewer.decisionAdversarial('');
    assert.equal(result.type, 'decision_adversarial');
    assert.equal(result.proposal, '');
  });

  it('should handle unknown role gracefully', async () => {
    const reviewer = new AdversarialReview();
    const result = await reviewer.decisionAdversarial('Test', {
      roles: ['unknown_role'],
    });
    assert.equal(result.attacks.length, 1);
    assert.equal(result.attacks[0].role, 'unknown_role');
  });
});
