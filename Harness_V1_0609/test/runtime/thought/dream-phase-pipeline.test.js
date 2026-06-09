'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const DreamPhasePipelineModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'dream-phase-pipeline'));
const DreamPhasePipeline = DreamPhasePipelineModule.DreamPhasePipeline || DreamPhasePipelineModule;

const DreamEngineModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'dream-engine'));
const DreamEngine = DreamEngineModule.DreamEngine || DreamEngineModule;

/** 构建简单会话历史辅助函数 */
function makeSession(overrides) {
  return Object.assign({
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 8),
    errors: [],
    lessonsLearned: [],
    keyDecisions: [],
    completedSkills: [],
    output: '',
    artifacts: [],
  }, overrides);
}

describe('DreamPhasePipeline - 常量与枚举', () => {
  it('should expose DREAM_PHASES enum', () => {
    assert.strictEqual(DreamPhasePipelineModule.DREAM_PHASES.LIGHT, 'light');
    assert.strictEqual(DreamPhasePipelineModule.DREAM_PHASES.DEEP, 'deep');
    assert.strictEqual(DreamPhasePipelineModule.DREAM_PHASES.REM, 'rem');
  });

  it('should expose CANDIDATE_CATEGORIES enum', () => {
    const cats = DreamPhasePipelineModule.CANDIDATE_CATEGORIES;
    assert.strictEqual(cats.PREFERENCE, 'preference');
    assert.strictEqual(cats.FACT, 'fact');
    assert.strictEqual(cats.CORRECTION, 'correction');
    assert.strictEqual(cats.WORKFLOW, 'workflow');
    assert.strictEqual(cats.DECISION, 'decision');
    assert.strictEqual(cats.NOISE, 'noise');
  });

  it('should expose SCORING_WEIGHTS with 6 dimensions', () => {
    const w = DreamPhasePipelineModule.SCORING_WEIGHTS;
    assert.ok(w);
    const keys = Object.keys(w);
    assert.strictEqual(keys.length, 6);
    assert.ok(w.frequency > 0);
    assert.ok(w.relevance > 0);
    assert.ok(w.queryDiversity > 0);
    assert.ok(w.recency > 0);
    assert.ok(w.consolidation > 0);
    assert.ok(w.conceptualRichness > 0);
    const total = keys.reduce((s, k) => s + w[k], 0);
    assert.ok(Math.abs(total - 1.0) < 0.01, 'weights should sum to ~1.0, got ' + total);
  });

  it('should expose DEFAULT_GATE_CONFIG with 3 thresholds', () => {
    const g = DreamPhasePipelineModule.DEFAULT_GATE_CONFIG;
    assert.ok(g);
    assert.strictEqual(typeof g.minScore, 'number');
    assert.strictEqual(typeof g.minRecallCount, 'number');
    assert.strictEqual(typeof g.minUniqueQueries, 'number');
  });
});

describe('DreamPhasePipeline - 构造函数', () => {
  it('should create instance with default config', () => {
    const pipeline = new DreamPhasePipeline();
    assert.ok(pipeline);
    assert.ok(pipeline.isHealthy());
  });

  it('should accept custom options', () => {
    const pipeline = new DreamPhasePipeline({
      gateConfig: { minScore: 0.8, minRecallCount: 3, minUniqueQueries: 2 },
    });
    assert.ok(pipeline);
    assert.strictEqual(pipeline._gateConfig.minScore, 0.8);
    assert.strictEqual(pipeline._gateConfig.minRecallCount, 3);
    assert.strictEqual(pipeline._gateConfig.minUniqueQueries, 2);
  });
});

describe('DreamPhasePipeline - Light阶段', () => {
  it('should classify candidates from session history', () => {
    const pipeline = new DreamPhasePipeline();
    const sessions = [
      makeSession({
        errors: ['error: database connection failed'],
        lessonsLearned: ['prefer using connection pooling for stability'],
        keyDecisions: ['decided to use PostgreSQL over MySQL'],
        output: 'step 1: initialize\nstep 2: connect\nworkflow: deploy pipeline',
      }),
    ];
    const result = pipeline.executeLightPhase(sessions);
    assert.ok(result);
    assert.strictEqual(result.phase, 'light');
    assert.ok(result.timestamp);
    assert.ok(Array.isArray(result.candidates));
    assert.ok(result.candidates.length > 0, 'should produce at least one candidate');
  });

  it('should categorize preference candidates', () => {
    const pipeline = new DreamPhasePipeline();
    const sessions = [
      makeSession({
        lessonsLearned: ['prefer using TypeScript over JavaScript'],
        output: 'I prefer dark mode for the editor',
      }),
    ];
    const result = pipeline.executeLightPhase(sessions);
    const prefs = result.candidates.filter(c => c.category === 'preference');
    assert.ok(prefs.length > 0, 'should find preference candidates');
  });

  it('should categorize fact candidates', () => {
    const pipeline = new DreamPhasePipeline();
    const sessions = [
      makeSession({
        output: 'the project uses Node.js 18 runtime and better-sqlite3 for storage',
      }),
    ];
    const result = pipeline.executeLightPhase(sessions);
    const facts = result.candidates.filter(c => c.category === 'fact');
    assert.ok(facts.length > 0, 'should find fact candidates');
  });

  it('should categorize correction candidates', () => {
    const pipeline = new DreamPhasePipeline();
    const sessions = [
      makeSession({
        errors: ['error: null pointer in auth module'],
        output: 'fixed the null check bug in authentication',
      }),
    ];
    const result = pipeline.executeLightPhase(sessions);
    const corrections = result.candidates.filter(c => c.category === 'correction');
    assert.ok(corrections.length > 0, 'should find correction candidates');
  });

  it('should categorize workflow candidates', () => {
    const pipeline = new DreamPhasePipeline();
    const sessions = [
      makeSession({
        output: 'step 1: build\nstep 2: test\nstep 3: deploy\nworkflow: CI/CD pipeline',
      }),
    ];
    const result = pipeline.executeLightPhase(sessions);
    const workflows = result.candidates.filter(c => c.category === 'workflow');
    assert.ok(workflows.length > 0, 'should find workflow candidates');
  });

  it('should categorize decision candidates', () => {
    const pipeline = new DreamPhasePipeline();
    const sessions = [
      makeSession({
        keyDecisions: ['decided to use microservices architecture for scalability'],
      }),
    ];
    const result = pipeline.executeLightPhase(sessions);
    const decisions = result.candidates.filter(c => c.category === 'decision');
    assert.ok(decisions.length > 0, 'should find decision candidates');
  });

  it('should categorize noise candidates', () => {
    const pipeline = new DreamPhasePipeline();
    const sessions = [
      makeSession({
        output: 'hello world this is a random message without meaningful content',
      }),
    ];
    const result = pipeline.executeLightPhase(sessions);
    const noise = result.candidates.filter(c => c.category === 'noise');
    assert.ok(noise.length > 0, 'should find noise candidates');
  });

  it('should return empty candidates for empty session history', () => {
    const pipeline = new DreamPhasePipeline();
    const result = pipeline.executeLightPhase([]);
    assert.ok(result);
    assert.strictEqual(result.candidates.length, 0);
  });

  it('should assign initial signals to each candidate', () => {
    const pipeline = new DreamPhasePipeline();
    const sessions = [
      makeSession({
        lessonsLearned: ['prefer using connection pooling'],
        keyDecisions: ['decided to use Redis for caching'],
      }),
    ];
    const result = pipeline.executeLightPhase(sessions);
    for (const c of result.candidates) {
      assert.ok(c.signals, 'candidate should have signals');
      assert.strictEqual(typeof c.signals.frequency, 'number');
      assert.strictEqual(typeof c.signals.relevance, 'number');
      assert.strictEqual(typeof c.signals.queryDiversity, 'number');
      assert.strictEqual(typeof c.signals.recency, 'number');
      assert.strictEqual(typeof c.signals.consolidation, 'number');
      assert.strictEqual(typeof c.signals.conceptualRichness, 'number');
    }
  });
});

describe('DreamPhasePipeline - Deep阶段', () => {
  it('should compute weighted score and filter by gate controls', () => {
    const pipeline = new DreamPhasePipeline({
      gateConfig: { minScore: 0.3, minRecallCount: 1, minUniqueQueries: 1 },
    });
    const candidates = [
      {
        id: 'c1',
        category: 'preference',
        content: 'prefer using connection pooling',
        signals: { frequency: 3, relevance: 0.8, queryDiversity: 2, recency: 0.9, consolidation: 0.5, conceptualRichness: 0.3 },
        sourceSessions: ['s1', 's2'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'c2',
        category: 'noise',
        content: 'random text without meaning',
        signals: { frequency: 1, relevance: 0.1, queryDiversity: 0, recency: 0.2, consolidation: 0, conceptualRichness: 0 },
        sourceSessions: ['s1'],
        createdAt: new Date().toISOString(),
      },
    ];
    const result = pipeline.executeDeepPhase(candidates, []);
    assert.ok(result);
    assert.strictEqual(result.phase, 'deep');
    assert.ok(result.timestamp);
    assert.ok(Array.isArray(result.promoted));
    assert.ok(Array.isArray(result.rejected));
    assert.ok(result.promoted.length > 0, 'should promote at least one candidate');
  });

  it('should reject noise category candidates', () => {
    const pipeline = new DreamPhasePipeline({
      gateConfig: { minScore: 0.0, minRecallCount: 0, minUniqueQueries: 0 },
    });
    const candidates = [
      {
        id: 'c1',
        category: 'noise',
        content: 'random text',
        signals: { frequency: 5, relevance: 0.9, queryDiversity: 3, recency: 0.9, consolidation: 0.8, conceptualRichness: 0.5 },
        sourceSessions: ['s1'],
        createdAt: new Date().toISOString(),
      },
    ];
    const result = pipeline.executeDeepPhase(candidates, []);
    assert.strictEqual(result.promoted.length, 0, 'noise should never be promoted');
    assert.strictEqual(result.rejected.length, 1);
  });

  it('should reject candidates below minScore gate', () => {
    const pipeline = new DreamPhasePipeline({
      gateConfig: { minScore: 0.9, minRecallCount: 0, minUniqueQueries: 0 },
    });
    const candidates = [
      {
        id: 'c1',
        category: 'fact',
        content: 'project uses Node.js',
        signals: { frequency: 1, relevance: 0.3, queryDiversity: 1, recency: 0.5, consolidation: 0.1, conceptualRichness: 0.1 },
        sourceSessions: ['s1'],
        createdAt: new Date().toISOString(),
      },
    ];
    const result = pipeline.executeDeepPhase(candidates, []);
    assert.strictEqual(result.promoted.length, 0, 'should reject low score candidate');
  });

  it('should detect conflicts with existing notes', () => {
    const pipeline = new DreamPhasePipeline({
      gateConfig: { minScore: 0.0, minRecallCount: 0, minUniqueQueries: 0 },
    });
    const candidates = [
      {
        id: 'c1',
        category: 'fact',
        content: 'project uses Node.js runtime for backend server',
        signals: { frequency: 2, relevance: 0.7, queryDiversity: 1, recency: 0.8, consolidation: 0.3, conceptualRichness: 0.2 },
        sourceSessions: ['s1', 's2'],
        createdAt: new Date().toISOString(),
      },
    ];
    const existingNotes = [
      { id: 'n1', category: 'fact', content: 'project uses Node.js runtime for the backend server', confidence: 0.8 },
    ];
    const result = pipeline.executeDeepPhase(candidates, existingNotes);
    assert.ok(result.updated.length > 0, 'conflicting note should be updated');
  });

  it('should handle empty candidates', () => {
    const pipeline = new DreamPhasePipeline();
    const result = pipeline.executeDeepPhase([], []);
    assert.strictEqual(result.promoted.length, 0);
    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.updated.length, 0);
  });
});

describe('DreamPhasePipeline - REM阶段', () => {
  it('should extract themes from promoted notes', () => {
    const pipeline = new DreamPhasePipeline();
    const promoted = [
      { id: 'n1', category: 'preference', content: 'prefer using connection pooling for database stability' },
      { id: 'n2', category: 'correction', content: 'fixed database connection timeout error' },
      { id: 'n3', category: 'workflow', content: 'deploy pipeline step by step process' },
    ];
    const allNotes = [...promoted];
    const result = pipeline.executeRemPhase(promoted, allNotes);
    assert.ok(result);
    assert.strictEqual(result.phase, 'rem');
    assert.ok(result.timestamp);
    assert.ok(Array.isArray(result.themes));
    assert.ok(Array.isArray(result.reflections));
  });

  it('should return empty themes for empty notes', () => {
    const pipeline = new DreamPhasePipeline();
    const result = pipeline.executeRemPhase([], []);
    assert.strictEqual(result.themes.length, 0);
    assert.strictEqual(result.reflections.length, 0);
  });

  it('should generate reflections from promoted notes', () => {
    const pipeline = new DreamPhasePipeline();
    const promoted = [
      { id: 'n1', category: 'preference', content: 'prefer using TypeScript for type safety in database queries' },
      { id: 'n2', category: 'decision', content: 'decided to adopt TypeScript for database query modules' },
      { id: 'n3', category: 'correction', content: 'fixed TypeScript type error in database connection' },
    ];
    const result = pipeline.executeRemPhase(promoted, promoted);
    assert.ok(result.reflections.length > 0, 'should generate reflections from related notes');
  });
});

describe('DreamPhasePipeline - 完整流水线', () => {
  it('should execute full pipeline Light -> Deep -> REM', () => {
    const pipeline = new DreamPhasePipeline({
      gateConfig: { minScore: 0.2, minRecallCount: 1, minUniqueQueries: 1 },
    });
    const sessions = [
      makeSession({
        errors: ['error: database connection failed', 'error: timeout exceeded'],
        lessonsLearned: ['prefer using connection pooling', 'success: retry with backoff'],
        keyDecisions: ['decided to use PostgreSQL over MySQL'],
        output: 'step 1: initialize database\nstep 2: run migrations\nworkflow: deployment pipeline',
      }),
      makeSession({
        errors: ['error: database connection failed'],
        lessonsLearned: ['prefer using connection pooling'],
        keyDecisions: ['decided to add retry logic'],
      }),
    ];
    const result = pipeline.executePipeline(sessions, []);
    assert.ok(result);
    assert.ok(result.light);
    assert.ok(result.deep);
    assert.ok(result.rem);
    assert.strictEqual(result.light.phase, 'light');
    assert.strictEqual(result.deep.phase, 'deep');
    assert.strictEqual(result.rem.phase, 'rem');
  });

  it('should emit phase-complete events', () => {
    const pipeline = new DreamPhasePipeline({
      gateConfig: { minScore: 0.2, minRecallCount: 1, minUniqueQueries: 1 },
    });
    const events = [];
    pipeline.on('phase-complete', (e) => events.push(e));
    const sessions = [
      makeSession({
        lessonsLearned: ['prefer using connection pooling'],
      }),
    ];
    pipeline.executePipeline(sessions, []);
    assert.ok(events.length >= 2, 'should emit at least 2 phase-complete events');
  });

  it('should emit pipeline-complete event', () => {
    const pipeline = new DreamPhasePipeline({
      gateConfig: { minScore: 0.2, minRecallCount: 1, minUniqueQueries: 1 },
    });
    let pipelineComplete = false;
    pipeline.on('pipeline-complete', () => { pipelineComplete = true; });
    const sessions = [
      makeSession({
        lessonsLearned: ['prefer using connection pooling'],
      }),
    ];
    pipeline.executePipeline(sessions, []);
    assert.ok(pipelineComplete, 'should emit pipeline-complete event');
  });

  it('should handle empty session history gracefully', () => {
    const pipeline = new DreamPhasePipeline();
    const result = pipeline.executePipeline([], []);
    assert.ok(result);
    assert.strictEqual(result.light.candidates.length, 0);
    assert.strictEqual(result.deep.promoted.length, 0);
  });
});

describe('DreamPhasePipeline - 辅助方法', () => {
  it('_computeWeightedScore should return weighted sum', () => {
    const pipeline = new DreamPhasePipeline();
    const signals = { frequency: 0.8, relevance: 0.7, queryDiversity: 0.5, recency: 0.6, consolidation: 0.4, conceptualRichness: 0.3 };
    const score = pipeline._computeWeightedScore(signals);
    assert.strictEqual(typeof score, 'number');
    assert.ok(score > 0);
    assert.ok(score <= 1);
  });

  it('_passesGateControls should check all 3 gates', () => {
    const pipeline = new DreamPhasePipeline({
      gateConfig: { minScore: 0.5, minRecallCount: 2, minUniqueQueries: 1 },
    });
    const passing = {
      signals: { frequency: 3, relevance: 0.8, queryDiversity: 2, recency: 0.9, consolidation: 0.5, conceptualRichness: 0.3 },
      sourceSessions: ['s1', 's2'],
    };
    const score = pipeline._computeWeightedScore(passing.signals);
    assert.ok(pipeline._passesGateControls(score, passing));
    const failing = {
      signals: { frequency: 0.5, relevance: 0.2, queryDiversity: 0, recency: 0.1, consolidation: 0, conceptualRichness: 0 },
      sourceSessions: ['s1'],
    };
    const lowScore = pipeline._computeWeightedScore(failing.signals);
    assert.ok(!pipeline._passesGateControls(lowScore, failing));
  });

  it('_computeRecencyScore should decay over time with 7-day half-life', () => {
    const pipeline = new DreamPhasePipeline();
    const now = new Date();
    const recentScore = pipeline._computeRecencyScore(now.toISOString());
    assert.ok(recentScore > 0.9, 'recent items should have high recency score');
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const halfScore = pipeline._computeRecencyScore(sevenDaysAgo);
    assert.ok(Math.abs(halfScore - 0.5) < 0.1, '7-day old items should have ~0.5 recency, got ' + halfScore);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const oldScore = pipeline._computeRecencyScore(thirtyDaysAgo);
    assert.ok(oldScore < 0.2, '30-day old items should have low recency');
  });

  it('_extractConceptTags should extract meaningful tags', () => {
    const pipeline = new DreamPhasePipeline();
    const tags = pipeline._extractConceptTags('prefer using connection pooling for database stability');
    assert.ok(Array.isArray(tags));
    assert.ok(tags.length > 0, 'should extract at least one concept tag');
  });

  it('_findConflicts should detect similar content in existing notes', () => {
    const pipeline = new DreamPhasePipeline();
    const candidate = {
      category: 'fact',
      content: 'project uses Node.js runtime for backend',
    };
    const existingNotes = [
      { id: 'n1', category: 'fact', content: 'project uses Node.js runtime for the server' },
      { id: 'n2', category: 'preference', content: 'prefer dark mode' },
    ];
    const conflicts = pipeline._findConflicts(candidate, existingNotes);
    assert.ok(Array.isArray(conflicts));
    assert.ok(conflicts.length > 0, 'should find conflict with similar note');
  });

  it('_extractThemes should find keyword co-occurrence themes', () => {
    const pipeline = new DreamPhasePipeline();
    const notes = [
      { id: 'n1', content: 'database connection pooling improves performance' },
      { id: 'n2', content: 'database query optimization for performance' },
      { id: 'n3', content: 'caching strategy for API performance' },
    ];
    const themes = pipeline._extractThemes(notes);
    assert.ok(Array.isArray(themes));
  });
});

describe('DreamPhasePipeline - 边界条件', () => {
  it('should handle all-noise input (no promotions)', () => {
    const pipeline = new DreamPhasePipeline();
    const sessions = [
      makeSession({ output: 'hello world random text without meaningful content' }),
    ];
    const result = pipeline.executePipeline(sessions, []);
    assert.strictEqual(result.deep.promoted.length, 0, 'noise should not be promoted');
  });

  it('should handle all-promotion scenario', () => {
    const pipeline = new DreamPhasePipeline({
      gateConfig: { minScore: 0.0, minRecallCount: 0, minUniqueQueries: 0 },
    });
    const sessions = [
      makeSession({
        lessonsLearned: ['prefer using TypeScript for type safety'],
        keyDecisions: ['decided to adopt microservices architecture'],
        errors: ['error: null pointer in auth module'],
      }),
      makeSession({
        lessonsLearned: ['prefer using TypeScript for type safety'],
        keyDecisions: ['decided to adopt microservices architecture'],
      }),
    ];
    const result = pipeline.executePipeline(sessions, []);
    assert.ok(result.deep.promoted.length > 0, 'should promote non-noise candidates');
  });

  it('should guard shutdown on public methods', () => {
    const pipeline = new DreamPhasePipeline();
    pipeline.shutdown();
    assert.throws(() => pipeline.executeLightPhase([]), /shut down/i);
    assert.throws(() => pipeline.executeDeepPhase([], []), /shut down/i);
    assert.throws(() => pipeline.executeRemPhase([], []), /shut down/i);
    assert.throws(() => pipeline.executePipeline([], []), /shut down/i);
  });

  it('should handle null/undefined session entries gracefully', () => {
    const pipeline = new DreamPhasePipeline();
    const sessions = [null, undefined, makeSession({ lessonsLearned: ['prefer using TypeScript'] })];
    const result = pipeline.executeLightPhase(sessions);
    assert.ok(result.candidates.length > 0, 'should handle null entries gracefully');
  });
});

describe('DreamEngine - 三阶段流水线集成', () => {
  it('should have startDreamingWithPhases method', () => {
    const engine = new DreamEngine();
    assert.strictEqual(typeof engine.startDreamingWithPhases, 'function');
  });

  it('should have attachPhasePipeline method', () => {
    const engine = new DreamEngine();
    assert.strictEqual(typeof engine.attachPhasePipeline, 'function');
  });

  it('startDreamingWithPhases should return pipeline result', async () => {
    const engine = new DreamEngine({ minPatternFrequency: 1, minConfidence: 0.3 });
    const sessions = [
      makeSession({
        errors: ['error: database connection failed'],
        lessonsLearned: ['prefer using connection pooling'],
        keyDecisions: ['decided to use PostgreSQL'],
      }),
      makeSession({
        errors: ['error: database connection failed'],
        lessonsLearned: ['prefer using connection pooling'],
      }),
    ];
    const result = await engine.startDreamingWithPhases(sessions);
    assert.ok(result);
    assert.ok(result.light);
    assert.ok(result.deep);
    assert.ok(result.rem);
  });

  it('startDreamingWithPhases should return null for empty input', async () => {
    const engine = new DreamEngine();
    const result = await engine.startDreamingWithPhases([]);
    assert.strictEqual(result, null);
  });

  it('startDreamingWithPhases should emit dream-with-phases-complete event', async () => {
    const engine = new DreamEngine({ minPatternFrequency: 1, minConfidence: 0.3 });
    let eventFired = false;
    engine.on('dream-with-phases-complete', () => { eventFired = true; });
    const sessions = [
      makeSession({ lessonsLearned: ['prefer using TypeScript'] }),
      makeSession({ lessonsLearned: ['prefer using TypeScript'] }),
    ];
    await engine.startDreamingWithPhases(sessions);
    assert.ok(eventFired, 'should emit dream-with-phases-complete');
  });

  it('attachPhasePipeline should accept custom pipeline', () => {
    const engine = new DreamEngine();
    const customPipeline = new DreamPhasePipeline({
      gateConfig: { minScore: 0.9, minRecallCount: 5, minUniqueQueries: 3 },
    });
    engine.attachPhasePipeline(customPipeline);
    assert.strictEqual(engine._phasePipeline, customPipeline);
  });

  it('getStats should include phasePipelineStats', () => {
    const engine = new DreamEngine();
    const stats = engine.getStats();
    assert.ok(stats.phasePipelineStats !== undefined, 'should include phasePipelineStats');
  });

  it('original startDreaming should still work (backward compatibility)', async () => {
    const engine = new DreamEngine({ minPatternFrequency: 1, minConfidence: 0.3 });
    const sessions = [
      makeSession({
        errors: ['error: database connection failed', 'error: timeout exceeded'],
        lessonsLearned: ['success: use connection pooling'],
      }),
      makeSession({
        errors: ['error: database connection failed'],
        lessonsLearned: ['success: use connection pooling'],
      }),
    ];
    const result = await engine.startDreaming(sessions);
    assert.ok(result);
    assert.ok(result.dreamId);
  });
});
