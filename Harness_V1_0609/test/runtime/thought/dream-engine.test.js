'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const DreamEngineModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'dream-engine'));
const DreamEngine = DreamEngineModule.DreamEngine || DreamEngineModule;

describe('DreamEngine - Constructor', () => {
  it('should create instance with default config', () => {
    const engine = new DreamEngine();
    assert.ok(engine);
    assert.strictEqual(engine._config.maxNotes, 500);
    assert.strictEqual(engine._config.maxSessionsPerDream, 20);
    assert.strictEqual(engine._config.similarityThreshold, 0.75);
    assert.strictEqual(engine._config.minPatternFrequency, 2);
    assert.strictEqual(engine._config.minConfidence, 0.6);
  });

  it('should merge custom options with defaults', () => {
    const engine = new DreamEngine({ maxNotes: 100, minConfidence: 0.8 });
    assert.strictEqual(engine._config.maxNotes, 100);
    assert.strictEqual(engine._config.minConfidence, 0.8);
    assert.strictEqual(engine._config.maxSessionsPerDream, 20);
  });

  it('should initialize empty notes and stats', () => {
    const engine = new DreamEngine();
    assert.strictEqual(engine._notes.size, 0);
    assert.strictEqual(engine._dreaming, false);
    assert.strictEqual(engine._dreamCount, 0);
    assert.strictEqual(engine._stats.totalDreams, 0);
  });

  it('should expose DEFAULT_CONFIG and NOTE_CATEGORIES', () => {
    assert.ok(DreamEngineModule.DEFAULT_CONFIG);
    assert.ok(DreamEngineModule.NOTE_CATEGORIES);
    assert.strictEqual(DreamEngineModule.NOTE_CATEGORIES.ERROR_AVOIDANCE, 'error-avoidance');
    assert.strictEqual(DreamEngineModule.NOTE_CATEGORIES.BEST_PRACTICE, 'best-practice');
    assert.strictEqual(DreamEngineModule.NOTE_CATEGORIES.WORKFLOW_OPTIMIZATION, 'workflow-optimization');
  });
});

describe('DreamEngine - startDreaming', () => {
  it('should analyze session history and return dream result', async () => {
    const engine = new DreamEngine({ minPatternFrequency: 1, minConfidence: 0.3 });
    const sessions = [
      {
        sessionId: 's1',
        errors: ['error: database connection failed', 'error: timeout exceeded'],
        lessonsLearned: ['success: use connection pooling'],
      },
      {
        sessionId: 's2',
        errors: ['error: database connection failed'],
        lessonsLearned: ['success: use connection pooling'],
      },
    ];
    const result = await engine.startDreaming(sessions);
    assert.ok(result);
    assert.ok(result.dreamId);
    assert.strictEqual(result.sessionsAnalyzed, 2);
    assert.ok(result.patternsFound);
  });

  it('should return null for empty session history', async () => {
    const engine = new DreamEngine();
    const result = await engine.startDreaming([]);
    assert.strictEqual(result, null);
  });

  it('should return null for non-array input', async () => {
    const engine = new DreamEngine();
    const result = await engine.startDreaming('not-array');
    assert.strictEqual(result, null);
  });

  it('should prevent concurrent dreaming', async () => {
    const engine = new DreamEngine();
    engine._dreaming = true;
    const result = await engine.startDreaming([{ sessionId: 's1' }]);
    assert.strictEqual(result, null);
  });

  it('should emit dream-complete event', async () => {
    const engine = new DreamEngine({ minPatternFrequency: 1, minConfidence: 0.3 });
    let emitted = false;
    engine.on('dream-complete', () => { emitted = true; });
    await engine.startDreaming([
      { sessionId: 's1', errors: ['error: test failed'] },
      { sessionId: 's2', errors: ['error: test failed'] },
    ]);
    assert.strictEqual(emitted, true);
  });
});

describe('DreamEngine - getNotes', () => {
  it('should return notes filtered by category', async () => {
    const engine = new DreamEngine({ minPatternFrequency: 1, minConfidence: 0.3 });
    await engine.startDreaming([
      { sessionId: 's1', errors: ['error: test failed'] },
      { sessionId: 's2', errors: ['error: test failed'] },
    ]);
    const notes = engine.getNotes('error-avoidance');
    assert.ok(Array.isArray(notes));
  });

  it('should return notes filtered by minConfidence', async () => {
    const engine = new DreamEngine({ minPatternFrequency: 1, minConfidence: 0.3 });
    await engine.startDreaming([
      { sessionId: 's1', errors: ['error: test failed'] },
      { sessionId: 's2', errors: ['error: test failed'] },
    ]);
    const notes = engine.getNotes(null, 0.9);
    assert.ok(Array.isArray(notes));
  });

  it('should return all notes when no filter', async () => {
    const engine = new DreamEngine({ minPatternFrequency: 1, minConfidence: 0.3 });
    await engine.startDreaming([
      { sessionId: 's1', errors: ['error: test failed'] },
      { sessionId: 's2', errors: ['error: test failed'] },
    ]);
    const notes = engine.getNotes();
    assert.ok(notes.length > 0);
  });
});

describe('DreamEngine - getRelevantNotes', () => {
  it('should return relevant notes for a context', async () => {
    const engine = new DreamEngine({ minPatternFrequency: 1, minConfidence: 0.3 });
    await engine.startDreaming([
      { sessionId: 's1', errors: ['error: database connection failed'] },
      { sessionId: 's2', errors: ['error: database connection failed'] },
    ]);
    const notes = engine.getRelevantNotes('database connection');
    assert.ok(Array.isArray(notes));
  });

  it('should return empty for null context', async () => {
    const engine = new DreamEngine();
    const notes = engine.getRelevantNotes(null);
    assert.deepStrictEqual(notes, []);
  });

  it('should return empty for non-string context', async () => {
    const engine = new DreamEngine();
    const notes = engine.getRelevantNotes(123);
    assert.deepStrictEqual(notes, []);
  });
});

describe('DreamEngine - getStats', () => {
  it('should return stats object', () => {
    const engine = new DreamEngine();
    const stats = engine.getStats();
    assert.strictEqual(stats.totalDreams, 0);
    assert.strictEqual(stats.totalNotes, 0);
    assert.strictEqual(stats.dreaming, false);
    assert.ok(stats.byCategory);
  });

  it('should reflect dream activity', async () => {
    const engine = new DreamEngine({ minPatternFrequency: 1, minConfidence: 0.3 });
    await engine.startDreaming([
      { sessionId: 's1', errors: ['error: test failed'] },
      { sessionId: 's2', errors: ['error: test failed'] },
    ]);
    const stats = engine.getStats();
    assert.strictEqual(stats.totalDreams, 1);
    assert.ok(stats.totalNotes > 0);
  });
});

describe('DreamEngine - attach methods', () => {
  it('should attach sqlite store', () => {
    const engine = new DreamEngine();
    const mockStore = { query: () => [] };
    engine.attachSqliteStore(mockStore);
    assert.strictEqual(engine._sqliteStore, mockStore);
  });

  it('should attach thought memory store', () => {
    const engine = new DreamEngine();
    const mockStore = {};
    engine.attachThoughtMemoryStore(mockStore);
    assert.strictEqual(engine._thoughtMemoryStore, mockStore);
  });

  it('should attach embedding service', () => {
    const engine = new DreamEngine();
    const mockService = {};
    engine.attachEmbeddingService(mockService);
    assert.strictEqual(engine._embeddingService, mockService);
  });

  it('should set to null when called with null', () => {
    const engine = new DreamEngine();
    engine.attachSqliteStore(null);
    assert.strictEqual(engine._sqliteStore, null);
  });
});

describe('DreamEngine - isHealthy', () => {
  it('should return true when not shut down and few errors', () => {
    const engine = new DreamEngine();
    assert.strictEqual(engine.isHealthy(), true);
  });

  it('should return false when shut down', () => {
    const engine = new DreamEngine();
    engine.shutdown();
    assert.strictEqual(engine.isHealthy(), false);
  });
});

describe('DreamEngine - shutdown', () => {
  it('should clear notes on shutdown', async () => {
    const engine = new DreamEngine({ minPatternFrequency: 1, minConfidence: 0.3 });
    await engine.startDreaming([
      { sessionId: 's1', errors: ['error: test failed'] },
      { sessionId: 's2', errors: ['error: test failed'] },
    ]);
    engine.shutdown();
    assert.strictEqual(engine._notes.size, 0);
    assert.strictEqual(engine._shutDown, true);
  });

  it('should prevent startDreaming after shutdown', async () => {
    const engine = new DreamEngine();
    engine.shutdown();
    await assert.rejects(() => engine.startDreaming([{ sessionId: 's1' }]), { code: 'SHUTDOWN' });
  });
});
