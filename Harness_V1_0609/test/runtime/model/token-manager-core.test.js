'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const TokenManager = require(path.join(__dirname, '..', '..', '..', 'src', 'runtime', 'model', 'token-manager'));

describe('TokenManager - Core', () => {
  let tm;

  beforeEach(() => {
    tm = new TokenManager({ defaultBudget: 1000000000 });
  });

  afterEach(() => {
    if (tm) tm.shutdown();
  });

  describe('store()', () => {
    it('should store tokens for a session', () => {
      const result = tm.store('session-1', 1000);
      assert.equal(result, 1000);
      assert.equal(tm.get('session-1'), 1000);
    });

    it('should accumulate tokens on repeated store', () => {
      tm.store('session-1', 1000);
      const result = tm.store('session-1', 500);
      assert.equal(result, 1500);
    });

    it('should throw on invalid sessionId', () => {
      for (const id of ['', null, undefined]) {
        try { tm.store(id, 100); assert.fail('should throw'); } catch (e) { assert.equal(e.code, 'INVALID_SESSION_ID'); }
      }
    });

    it('should throw on invalid amount', () => {
      for (const amt of [-100, NaN, Infinity]) {
        try { tm.store('s1', amt); assert.fail('should throw'); } catch (e) { assert.equal(e.code, 'INVALID_TOKEN_AMOUNT'); }
      }
    });

    it('should handle formatted token strings', () => {
      const tokens1M = tm.parseFormatted('1M');
      tm.store('s1', tokens1M);
      assert.equal(tm.get('s1'), 1000000);

      const tokens500K = tm.parseFormatted('500K');
      tm.store('s1', tokens500K);
      assert.equal(tm.get('s1'), 1500000);
    });
  });

  describe('get()', () => {
    it('should return 0 for non-existent session', () => {
      assert.equal(tm.get('non-existent'), 0);
    });

    it('should throw on invalid sessionId', () => {
      try { tm.get(''); assert.fail('should throw'); } catch (e) { assert.equal(e.code, 'INVALID_SESSION_ID'); }
    });
  });

  describe('set()', () => {
    it('should set exact token amount', () => {
      tm.store('session-1', 1000);
      tm.set('session-1', 2000);
      assert.equal(tm.get('session-1'), 2000);
    });

    it('should throw on invalid sessionId', () => {
      try { tm.set('', 100); assert.fail('should throw'); } catch (e) { assert.equal(e.code, 'INVALID_SESSION_ID'); }
    });

    it('should emit token-warning-80 when set() exceeds 80% budget', () => {
      let warningEvent = null;
      tm.on('token-warning-80', (evt) => { warningEvent = evt; });
      tm.set('s1', 800000000);
      assert.ok(warningEvent);
      assert.equal(warningEvent.sessionId, 's1');
      assert.equal(warningEvent.tokensUsed, 800000000);
    });

    it('should emit token-warning-95 when set() exceeds 95% budget', () => {
      let warningEvent = null;
      tm.on('token-warning-95', (evt) => { warningEvent = evt; });
      tm.set('s1', 950000000);
      assert.ok(warningEvent);
      assert.equal(warningEvent.sessionId, 's1');
    });

    it('should emit token-exhausted when set() reaches 100% budget', () => {
      let exhaustedEvent = null;
      tm.on('token-exhausted', (evt) => { exhaustedEvent = evt; });
      tm.set('s1', 1000000000);
      assert.ok(exhaustedEvent);
      assert.equal(exhaustedEvent.sessionId, 's1');
    });

    it('should not emit budget events when set() is below 80%', () => {
      const events = [];
      tm.on('token-warning-80', () => { events.push('w80'); });
      tm.on('token-warning-95', () => { events.push('w95'); });
      tm.on('token-exhausted', () => { events.push('ex'); });
      tm.set('s1', 100);
      assert.equal(events.length, 0);
    });
  });

  describe('validate()', () => {
    it('should return warning80 at 80% budget', () => {
      tm.set('s1', 800000000);
      const result = tm.validate('s1');
      assert.equal(result.warning80, true);
      assert.equal(result.warning95, false);
      assert.equal(result.exhausted, false);
    });

    it('should return warning95 at 95% budget', () => {
      tm.set('s1', 950000000);
      const result = tm.validate('s1');
      assert.equal(result.warning80, true);
      assert.equal(result.warning95, true);
      assert.equal(result.exhausted, false);
    });

    it('should return exhausted at 100% budget', () => {
      tm.set('s1', 1000000000);
      const result = tm.validate('s1');
      assert.equal(result.warning80, true);
      assert.equal(result.warning95, true);
      assert.equal(result.exhausted, true);
    });

    it('should support custom budget', () => {
      tm.set('s1', 800000);
      const result = tm.validate('s1', 1000000);
      assert.equal(result.warning80, true);
      assert.equal(result.ratio, 0.8);
    });

    it('should throw on invalid sessionId', () => {
      try { tm.validate('', 100); assert.fail('should throw'); } catch (e) { assert.equal(e.code, 'INVALID_SESSION_ID'); }
    });
  });

  describe('clear()', () => {
    it('should clear tokens for a session', () => {
      tm.store('s1', 1000);
      tm.clear('s1');
      assert.equal(tm.get('s1'), 0);
    });

    it('should clear both tokens and breakdown', () => {
      tm.store('s1', 1000);
      tm.addBreakdown('s1', '需求分析', 500);
      tm.clear('s1');
      assert.deepEqual(tm.getBreakdown('s1'), {});
    });

    it('should throw on invalid sessionId', () => {
      try { tm.clear(''); assert.fail('should throw'); } catch (e) { assert.equal(e.code, 'INVALID_SESSION_ID'); }
    });
  });

  describe('clearAll()', () => {
    it('should clear all sessions', () => {
      tm.store('s1', 1000);
      tm.store('s2', 2000);
      tm.clearAll();
      assert.equal(tm.get('s1'), 0);
      assert.equal(tm.get('s2'), 0);
    });
  });
});
