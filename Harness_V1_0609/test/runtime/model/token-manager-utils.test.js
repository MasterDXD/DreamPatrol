'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const TokenManager = require(path.join(__dirname, '..', '..', '..', 'src', 'runtime', 'model', 'token-manager'));

describe('TokenManager - Utilities', () => {
  let tm;

  beforeEach(() => {
    tm = new TokenManager({ defaultBudget: 1000000000 });
  });

  afterEach(() => {
    if (tm) tm.shutdown();
  });

  describe('addBreakdown() and getBreakdown()', () => {
    it('should add and retrieve breakdown', () => {
      tm.addBreakdown('s1', '需求分析', 500);
      tm.addBreakdown('s1', '架构设计', 1000);
      const breakdown = tm.getBreakdown('s1');
      assert.equal(breakdown['需求分析'], 500);
      assert.equal(breakdown['架构设计'], 1000);
    });

    it('should accumulate breakdown values', () => {
      tm.addBreakdown('s1', '模块开发', 1000);
      tm.addBreakdown('s1', '模块开发', 500);
      assert.equal(tm.getBreakdown('s1')['模块开发'], 1500);
    });

    it('should return empty object for non-existent session', () => {
      assert.deepEqual(tm.getBreakdown('non-existent'), {});
    });

    it('should throw on invalid category', () => {
      try { tm.addBreakdown('s1', '', 100); assert.fail('should throw'); } catch (e) { assert.equal(e.code, 'INVALID_BREAKDOWN_CATEGORY'); }
    });
  });

  describe('getAllBreakdowns()', () => {
    it('should return all breakdowns', () => {
      tm.addBreakdown('s1', 'A', 100);
      tm.addBreakdown('s2', 'B', 200);
      const all = tm.getAllBreakdowns();
      assert.equal(all['s1']['A'], 100);
      assert.equal(all['s2']['B'], 200);
    });
  });

  describe('formatTokens()', () => {
    it('should format thousands as K', () => {
      assert.equal(tm.formatTokens(1500), '2K');
    });

    it('should format millions as M', () => {
      assert.equal(tm.formatTokens(1500000), '1.5M');
    });

    it('should format billions as B', () => {
      assert.equal(tm.formatTokens(2500000000), '2.50B');
    });

    it('should format small numbers as-is', () => {
      assert.equal(tm.formatTokens(500), '500');
    });

    it('should handle zero and negative', () => {
      assert.equal(tm.formatTokens(0), '0');
      assert.equal(tm.formatTokens(-100), '0');
      assert.equal(tm.formatTokens(NaN), '0');
    });
  });

  describe('parseFormatted()', () => {
    it('should parse K suffix', () => {
      assert.equal(tm.parseFormatted('1K'), 1000);
    });

    it('should parse M suffix', () => {
      assert.equal(tm.parseFormatted('1.5M'), 1500000);
    });

    it('should parse B suffix', () => {
      assert.equal(tm.parseFormatted('2.5B'), 2500000000);
    });

    it('should parse plain numbers', () => {
      assert.equal(tm.parseFormatted('1234'), 1234);
    });

    it('should return 0 for invalid format', () => {
      assert.equal(tm.parseFormatted('invalid'), 0);
      assert.equal(tm.parseFormatted(''), 0);
    });
  });

  describe('getGlobalBudget() and setGlobalBudget()', () => {
    it('should return default budget', () => {
      assert.equal(tm.getGlobalBudget(), 1000000000);
    });

    it('should set custom budget', () => {
      tm.setGlobalBudget(5000000000);
      assert.equal(tm.getGlobalBudget(), 5000000000);
    });

    it('should throw on invalid budget', () => {
      for (const b of [-100, 0, NaN]) {
        try { tm.setGlobalBudget(b); assert.fail('should throw'); } catch (e) { assert.equal(e.code, 'INVALID_BUDGET'); }
      }
    });
  });

  describe('listSessions()', () => {
    it('should list all session IDs', () => {
      tm.store('s1', 100);
      tm.store('s2', 200);
      const sessions = tm.listSessions();
      assert.ok(sessions.includes('s1'));
      assert.ok(sessions.includes('s2'));
    });
  });

  describe('getStats()', () => {
    it('should return aggregated stats', () => {
      tm.store('s1', 1000);
      tm.store('s2', 2000);
      const stats = tm.getStats();
      assert.equal(stats.total, 3000);
      assert.equal(stats.activeSessions, 2);
      assert.equal(stats.totalSessions, 2);
      assert.equal(stats.maxSession, 2000);
    });
  });

  describe('getTotal()', () => {
    it('should return total tokens and ratio', () => {
      tm.store('s1', 500);
      tm.store('s2', 500);
      const result = tm.getTotal();
      assert.equal(result.total, 1000);
      assert.equal(result.ratio, 0.000001);
    });
  });

  describe('shutdown()', () => {
    it('should clear all data on shutdown', () => {
      tm.store('s1', 1000);
      tm.addBreakdown('s1', 'A', 100);
      tm.shutdown();
      assert.equal(tm.get('s1'), 0);
      assert.equal(tm.isHealthy(), false);
    });

    it('should not accept operations after shutdown', () => {
      tm.shutdown();
      let threw = false;
      try { tm.store('s1', 100); } catch (_e) { threw = true; }
      assert.equal(threw, true);
    });
  });

  describe('EventEmitter integration', () => {
    it('should emit shutdown event', () => {
      return new Promise((resolve) => {
        const newTm = new TokenManager();
        newTm.on('shutdown', function handler() {
          newTm.removeListener('shutdown', handler);
          resolve();
        });
        newTm.shutdown();
      });
    });
  });
});
