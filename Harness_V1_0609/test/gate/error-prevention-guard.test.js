'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ErrorPreventionGuard } = require('../../src/gate/error-prevention-guard');

describe('ErrorPreventionGuard', () => {
  it('should register error patterns', () => {
    const guard = new ErrorPreventionGuard();
    guard.registerErrorPattern({ pattern: 'database connection timeout', description: 'DB timeout', solution: 'Add retry logic' });
    assert.equal(guard.getPatternCount(), 1);
  });

  it('should detect matching patterns in context', () => {
    const guard = new ErrorPreventionGuard();
    guard.registerErrorPattern({ pattern: 'database connection timeout', description: 'DB timeout', solution: 'Add retry', confidence: 0.8 });
    const result = guard.check({ task: 'setup database connection pool' });
    assert.equal(result.safe, false);
    assert.ok(result.warnings.length > 0);
    assert.equal(result.warnings[0].solution, 'Add retry');
  });

  it('should return safe when no patterns match', () => {
    const guard = new ErrorPreventionGuard();
    guard.registerErrorPattern({ pattern: 'websocket handshake failure', confidence: 0.8 });
    const result = guard.check({ task: 'write unit tests' });
    assert.equal(result.safe, true);
  });

  it('should filter low confidence patterns', () => {
    const guard = new ErrorPreventionGuard({ minConfidence: 0.7 });
    guard.registerErrorPattern({ pattern: 'test error', confidence: 0.3 });
    const result = guard.check({ task: 'test error handling' });
    assert.equal(result.safe, true);
  });

  it('should load from dream engine', () => {
    const mockEngine = {
      getNotesByCategory: (cat) => {
        if (cat === 'error-avoidance') return [{ content: 'memory leak pattern', title: 'Memory Leak', solution: 'Use WeakRef', confidence: 0.8, frequency: 3 }];
        return [];
      },
    };
    const guard = new ErrorPreventionGuard({ dreamEngine: mockEngine });
    const loaded = guard.loadFromDreamEngine();
    assert.equal(loaded, 1);
    assert.equal(guard.getPatternCount(), 1);
  });

  it('should deduplicate similar patterns', () => {
    const mockEngine = {
      getNotesByCategory: (cat) => {
        if (cat === 'error-avoidance') {
          return [
            { content: 'memory leak pattern', confidence: 0.7, frequency: 2 },
            { content: 'memory leak pattern', confidence: 0.9, frequency: 5 },
          ];
        }
        return [];
      },
    };
    const guard = new ErrorPreventionGuard({ dreamEngine: mockEngine });
    guard.loadFromDreamEngine();
    assert.equal(guard.getPatternCount(), 1);
  });

  it('should remove patterns', () => {
    const guard = new ErrorPreventionGuard();
    const p = guard.registerErrorPattern({ pattern: 'test' });
    assert.equal(guard.getPatternCount(), 1);
    guard.removePattern(p.id);
    assert.equal(guard.getPatternCount(), 0);
  });

  it('should track warning history', () => {
    const guard = new ErrorPreventionGuard({ maxHistory: 2 });
    guard.registerErrorPattern({ pattern: 'test error', confidence: 0.9 });
    guard.check({ task: 'test error' });
    guard.check({ task: 'test error' });
    guard.check({ task: 'test error' });
    assert.equal(guard.getWarningHistory().length, 2);
  });
});
