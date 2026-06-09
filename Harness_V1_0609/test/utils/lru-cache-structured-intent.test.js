'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const LRUCache = require('../../src/utils/lru-cache');

describe('LRUCache', () => {
  it('should set and get values', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('b'), 2);
  });

  it('should return undefined for missing keys', () => {
    const cache = new LRUCache(3);
    assert.equal(cache.get('missing'), undefined);
  });

  it('should evict oldest entry when full', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);
    assert.equal(cache.has('a'), false);
    assert.equal(cache.get('d'), 4);
  });

  it('should promote accessed entry to end', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a');
    cache.set('d', 4);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.has('b'), false);
  });

  it('should update existing key and move to end', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('a', 10);
    cache.set('d', 4);
    assert.equal(cache.get('a'), 10);
    assert.equal(cache.has('b'), false);
  });

  it('should delete entries', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.delete('a');
    assert.equal(cache.has('a'), false);
    assert.equal(cache.size, 0);
  });

  it('should clear all entries', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.equal(cache.size, 0);
  });

  it('should iterate entries', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    const keys = Array.from(cache.keys());
    assert.deepEqual(keys, ['a', 'b']);
  });

  it('should support forEach', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    const entries = [];
    cache.forEach((v, k) => entries.push([k, v]));
    assert.deepEqual(entries, [['a', 1], ['b', 2]]);
  });

  it('should use default maxSize of 50', () => {
    const cache = new LRUCache();
    for (let i = 0; i < 60; i++) cache.set('k' + i, i);
    assert.equal(cache.size, 50);
  });
});

describe('StructuredIntent Cross-Turn Accumulation', () => {
  const StructuredIntent = require('../../src/runtime/user/structured-intent');

  it('should accumulate params across turns with same sessionId', () => {
    const si = new StructuredIntent();
    const r1 = si.parseIntent('target_module is auth-service', 'tdd-implement', { sessionId: 'sess-1' });
    assert.equal(r1.params.target_module, 'auth-service');
    assert.ok(r1.completeness < 1.0);

    const r2 = si.parseIntent('success_criteria is all tests pass', 'tdd-implement', { sessionId: 'sess-1' });
    assert.equal(r2.params.target_module, 'auth-service');
    assert.equal(r2.params.success_criteria, 'all tests pass');
    assert.equal(r2.completeness, 1.0);
    assert.equal(r2.paramsAccumulated, true);
  });

  it('should not accumulate params across different sessions', () => {
    const si = new StructuredIntent();
    si.parseIntent('target_module is auth-service', 'tdd-implement', { sessionId: 'sess-1' });
    const r2 = si.parseIntent('success_criteria is all tests pass', 'tdd-implement', { sessionId: 'sess-2' });
    assert.equal(r2.params.target_module, undefined);
    assert.equal(r2.params.success_criteria, 'all tests pass');
  });

  it('should not accumulate params without sessionId', () => {
    const si = new StructuredIntent();
    si.parseIntent('target_module is auth-service', 'tdd-implement');
    const r2 = si.parseIntent('success_criteria is all tests pass', 'tdd-implement');
    assert.equal(r2.params.target_module, undefined);
  });

  it('should clear session params', () => {
    const si = new StructuredIntent();
    si.parseIntent('target_module is auth-service', 'tdd-implement', { sessionId: 'sess-1' });
    si.clearSession('sess-1');
    const r2 = si.parseIntent('success_criteria is all tests pass', 'tdd-implement', { sessionId: 'sess-1' });
    assert.equal(r2.params.target_module, undefined);
  });

  it('should return session params via getSessionParams', () => {
    const si = new StructuredIntent();
    si.parseIntent('target_module is auth-service', 'tdd-implement', { sessionId: 'sess-1' });
    const params = si.getSessionParams('sess-1', 'tdd-implement');
    assert.equal(params.target_module, 'auth-service');
    assert.equal(si.getSessionParams('sess-1', 'unknown-skill'), null);
  });

  it('should handle invalid input gracefully', () => {
    const si = new StructuredIntent();
    const r = si.parseIntent('', 'tdd-implement');
    assert.equal(r.completeness, 0);
    assert.equal(r.clarificationNeeded, true);
  });

  it('should limit session params storage', () => {
    const si = new StructuredIntent({ maxSessions: 3 });
    si.parseIntent('target_module is a', 'tdd-implement', { sessionId: 's1' });
    si.parseIntent('target_module is b', 'tdd-implement', { sessionId: 's2' });
    si.parseIntent('target_module is c', 'tdd-implement', { sessionId: 's3' });
    si.parseIntent('target_module is d', 'tdd-implement', { sessionId: 's4' });
    assert.equal(si.getSessionParams('s1', 'tdd-implement'), null);
    assert.ok(si.getSessionParams('s4', 'tdd-implement'));
  });
});

describe('ContextCompressionEngine Enhanced Features', () => {
  const ContextCompressionEngine = require('../../src/runtime/context/context-compression-engine');

  it('should skip compression when state unchanged', () => {
    const engine = new ContextCompressionEngine();
    const context = {
      currentPhase: 'module-development',
      skills: [{ skill_id: 'tdd', phase: 'module-development', instruction: 'test', summary: 't' }],
      completedSkills: [],
    };
    engine.compress(context);
    engine.getStats();
    engine.compress(context);
    const stats2 = engine.getStats();
    assert.ok(stats2.incrementalSkips > 0);
  });

  it('should cache compression plans', () => {
    const engine = new ContextCompressionEngine();
    const context = {
      currentPhase: 'module-development',
      skills: [{ skill_id: 'tdd', phase: 'module-development', instruction: 'test', summary: 't' }],
      completedSkills: [],
    };
    engine.getCompressionPlan(context);
    engine.getCompressionPlan(context);
    assert.ok(engine.getStats().cacheHits > 0);
  });

  it('should apply discard strategy correctly', () => {
    const engine = new ContextCompressionEngine();
    engine.setStrategy('completed_phase', 'discard');
    const context = {
      currentPhase: 'module-development',
      skills: [{ skill_id: 'brainstorming', phase: 'brainstorming', instruction: 'Full instruction text', summary: 'Summary' }],
      completedSkills: ['brainstorming'],
    };
    const result = engine.compress(context);
    const compressed = result.compressedSkills.find(s => s.skill_id === 'brainstorming');
    assert.ok(compressed);
    assert.equal(compressed.compressedTokenEstimate, 0);
    assert.equal(compressed.reason, 'completed_phase_discarded');
  });

  it('should apply full strategy to completed phase', () => {
    const engine = new ContextCompressionEngine();
    engine.setStrategy('completed_phase', 'full');
    const context = {
      currentPhase: 'module-development',
      skills: [{ skill_id: 'brainstorming', phase: 'brainstorming', instruction: 'Full instruction text', summary: 'Summary' }],
      completedSkills: ['brainstorming'],
    };
    const result = engine.compress(context);
    const retained = result.retainedSkills.find(s => s.skill_id === 'brainstorming');
    assert.ok(retained);
    assert.equal(retained.reason, 'completed_phase');
    assert.equal(retained.strategy, 'full');
  });

  it('should estimate tokens with Chinese character awareness', () => {
    const engine = new ContextCompressionEngine();
    const shortChinese = engine._estimateTokens('你好');
    const longEnglish = engine._estimateTokens('hello world test data');
    assert.ok(shortChinese > 0);
    assert.ok(longEnglish > 0);
  });

  it('should reject invalid strategy changes', () => {
    const engine = new ContextCompressionEngine();
    assert.equal(engine.setStrategy('completed_phase', 'invalid'), false);
    assert.equal(engine.setStrategy('nonexistent', 'full'), false);
  });

  it('should clear incremental state on strategy change', () => {
    const engine = new ContextCompressionEngine();
    const context = {
      currentPhase: 'module-development',
      skills: [],
      completedSkills: [],
    };
    engine.compress(context);
    engine.setStrategy('completed_phase', 'discard');
    const stats = engine.getStats();
    assert.equal(stats.hasIncrementalState, false);
  });
});
