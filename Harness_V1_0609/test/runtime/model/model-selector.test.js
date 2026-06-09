'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

class MockTokenManager extends EventEmitter {
  constructor() {
    super();
  }
}

describe('ModelSelector - Token Budget Integration', () => {
  const ModelSelector = require('../../../src/runtime/model/model-selector');

  it('should attach TokenManager and listen to budget events', () => {
    const selector = new ModelSelector();
    const tm = new MockTokenManager();
    selector.attachTokenManager(tm);
    assert.equal(selector._tokenManager, tm);
  });

  it('should set budgetConstrained on token-warning-80', () => {
    const selector = new ModelSelector();
    const tm = new MockTokenManager();
    selector.attachTokenManager(tm);
    assert.equal(selector._budgetConstrained, false);
    tm.emit('token-warning-80');
    assert.equal(selector._budgetConstrained, true);
  });

  it('should set budgetCritical on token-warning-95', () => {
    const selector = new ModelSelector();
    const tm = new MockTokenManager();
    selector.attachTokenManager(tm);
    assert.equal(selector._budgetCritical, false);
    tm.emit('token-warning-95');
    assert.equal(selector._budgetCritical, true);
  });

  it('should set budgetExhausted on token-exhausted', () => {
    const selector = new ModelSelector();
    const tm = new MockTokenManager();
    selector.attachTokenManager(tm);
    assert.equal(selector._budgetExhausted, false);
    tm.emit('token-exhausted');
    assert.equal(selector._budgetExhausted, true);
  });

  it('should downgrade premium to standard when budget constrained', () => {
    const selector = new ModelSelector();
    const tm = new MockTokenManager();
    selector.attachTokenManager(tm);
    tm.emit('token-warning-80');
    const result = selector.selectModel('architecture-design', {});
    assert.ok(result.tier !== 'premium' || result.source === 'budget-constrained');
  });

  it('should force economy model when budget exhausted', () => {
    const selector = new ModelSelector();
    const tm = new MockTokenManager();
    selector.attachTokenManager(tm);
    tm.emit('token-exhausted');
    const result = selector.selectModel('architecture-design', {});
    assert.equal(result.tier, 'economy');
    assert.equal(result.source, 'budget-exhausted');
  });

  it('should downgrade two tiers when budget critical', () => {
    const selector = new ModelSelector();
    const tm = new MockTokenManager();
    selector.attachTokenManager(tm);
    tm.emit('token-warning-95');
    const result = selector.selectModel('architecture-design', {});
    assert.ok(result.tier === 'economy' || result.source === 'budget-critical');
  });

  it('should reset budget flags', () => {
    const selector = new ModelSelector();
    const tm = new MockTokenManager();
    selector.attachTokenManager(tm);
    tm.emit('token-warning-80');
    tm.emit('token-warning-95');
    tm.emit('token-exhausted');
    selector.resetBudgetFlags();
    assert.equal(selector._budgetConstrained, false);
    assert.equal(selector._budgetCritical, false);
    assert.equal(selector._budgetExhausted, false);
  });

  it('should remove previous listeners when reattaching TokenManager', () => {
    const selector = new ModelSelector();
    const tm1 = new MockTokenManager();
    const tm2 = new MockTokenManager();
    selector.attachTokenManager(tm1);
    selector.attachTokenManager(tm2);
    tm1.emit('token-warning-80');
    assert.equal(selector._budgetConstrained, false);
    tm2.emit('token-warning-80');
    assert.equal(selector._budgetConstrained, true);
  });

  it('should clean up all 4 listeners including token-reset when reattaching TokenManager', () => {
    const selector = new ModelSelector();
    const tm1 = new MockTokenManager();
    selector.attachTokenManager(tm1);
    const initialCount = tm1.listenerCount('token-reset');
    assert.equal(initialCount, 1);
    const tm2 = new MockTokenManager();
    selector.attachTokenManager(tm2);
    assert.equal(tm1.listenerCount('token-warning-80'), 0, 'token-warning-80 should be removed from tm1');
    assert.equal(tm1.listenerCount('token-warning-95'), 0, 'token-warning-95 should be removed from tm1');
    assert.equal(tm1.listenerCount('token-exhausted'), 0, 'token-exhausted should be removed from tm1');
    assert.equal(tm1.listenerCount('token-reset'), 0, 'token-reset should be removed from tm1');
    assert.equal(tm2.listenerCount('token-reset'), 1, 'token-reset should be on tm2');
  });

  it('should reset budget flags on token-reset event', () => {
    const selector = new ModelSelector();
    const tm = new MockTokenManager();
    selector.attachTokenManager(tm);
    tm.emit('token-warning-80');
    tm.emit('token-warning-95');
    tm.emit('token-exhausted');
    assert.equal(selector._budgetConstrained, true);
    assert.equal(selector._budgetCritical, true);
    assert.equal(selector._budgetExhausted, true);
    tm.emit('token-reset');
    assert.equal(selector._budgetConstrained, false);
    assert.equal(selector._budgetCritical, false);
    assert.equal(selector._budgetExhausted, false);
  });

  it('should clean up TokenManager on shutdown', () => {
    const selector = new ModelSelector();
    const tm = new MockTokenManager();
    selector.attachTokenManager(tm);
    selector.shutdown();
    assert.equal(selector._tokenManager, null);
  });

  it('should fallback to defaultModel when fallbackChain is empty', () => {
    const selector = new ModelSelector({ fallbackChain: [], defaultModel: 'my-default' });
    const result = selector._selectByComplexity('test-skill', 0.8);
    assert.equal(result.model, 'my-default');
  });

  it('should select model by complexity score', () => {
    const selector = new ModelSelector();
    const premium = selector._selectByComplexity('test', 0.9);
    assert.equal(premium.tier, 'premium');
    const economy = selector._selectByComplexity('test', 0.1);
    assert.equal(economy.tier, 'economy');
    const standard = selector._selectByComplexity('test', 0.5);
    assert.equal(standard.tier, 'standard');
  });
});
