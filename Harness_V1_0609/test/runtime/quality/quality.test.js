'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const QualityScorer = require('../../../src/runtime/quality/quality-scorer');
const SelfReflection = require('../../../src/runtime/quality/self-reflection');
const AdversarialReview = require('../../../src/runtime/quality/adversarial-review');
const DocFreshnessGuard = require('../../../src/runtime/quality/doc-freshness-guard');
const SelfEvolutionGovernor = require('../../../src/runtime/quality/self-evolution-governor');

const tempDirs = [];

function createTempDir(prefix) {
  const dir = path.join(os.tmpdir(), prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { void e; }
}

afterEach(() => {
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
  tempDirs.length = 0;
});

function createMockSignalPersistence() {
  const records = new Map();
  const mock = {
    record(category, data) {
      if (!records.has(category)) records.set(category, []);
      records.get(category).push(data);
    },
    getTrend(category, field, limit) {
      const entries = records.get(category) ?? [];
      if (entries.length < 2) return { trend: 'insufficient_data' };
      const recent = entries.slice(-limit);
      const half = Math.floor(recent.length / 2);
      const firstHalf = recent.slice(0, half);
      const secondHalf = recent.slice(half);
      const avgFirst = firstHalf.reduce((s, e) => s + (e[field] ?? 0), 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s, e) => s + (e[field] ?? 0), 0) / secondHalf.length;
      const delta = avgSecond - avgFirst;
      return {
        trend: delta > 0.05 ? 'improving' : delta < -0.05 ? 'degrading' : 'stable',
        delta,
        avgCurrent: avgSecond,
      };
    },
    query(category, options) {
      return (records.get(category) ?? []).slice(-(options && options.limit) ?? 20);
    },
    _records: records,
  };
  return mock;
}

function createMockHealthChecker() {
  return {
    async getAggregatedReport() {
      return { status: 'healthy', summary: { criticalIssues: 0, warningIssues: 0 } };
    },
  };
}

function createMockCausalDataBus() {
  return {
    getStats() {
      return { chainLength: 5, invariantViolations: 0 };
    },
    publishOutput() {},
  };
}

describe('QualityScorer', () => {
  it('constructor should initialize with default weights and thresholds', () => {
    const scorer = new QualityScorer();
    assert.ok(scorer);
    assert.strictEqual(scorer._weights.completeness, 0.25);
    assert.strictEqual(scorer._weights.correctness, 0.30);
    assert.strictEqual(scorer._thresholds.excellent, 0.9);
    scorer.shutdown();
  });

  it('constructor should accept custom weights and thresholds', () => {
    const scorer = new QualityScorer({
      weights: { completeness: 0.5 },
      thresholds: { excellent: 0.95 },
      maxHistory: 100,
    });
    assert.strictEqual(scorer._weights.completeness, 0.5);
    assert.strictEqual(scorer._thresholds.excellent, 0.95);
    assert.strictEqual(scorer._maxHistory, 100);
    scorer.shutdown();
  });

  it('score should return zero score for null result', () => {
    const scorer = new QualityScorer();
    const result = scorer.score(null);
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.grade, 'failing');
    assert.strictEqual(result.dimensions.completeness, 0);
    scorer.shutdown();
  });

  it('score should return zero score for non-object result', () => {
    const scorer = new QualityScorer();
    const result = scorer.score(42);
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.grade, 'failing');
    scorer.shutdown();
  });

  it('score should return score with dimensions for object result', () => {
    const scorer = new QualityScorer();
    const result = scorer.score({ success: true, data: 'test' });
    assert.ok(result.total > 0);
    assert.ok(result.total <= 1);
    assert.ok(result.dimensions.completeness >= 0);
    assert.ok(result.dimensions.correctness >= 0);
    assert.ok(result.dimensions.consistency >= 0);
    assert.ok(result.dimensions.coverage >= 0);
    assert.ok(result.dimensions.clarity >= 0);
    assert.ok(result.timestamp);
    scorer.shutdown();
  });

  it('score should assign good grade for high score', () => {
    const scorer = new QualityScorer();
    const result = scorer.score({
      success: true,
      valid: true,
      passed: true,
      coverage: 1.0,
      status: 'ok',
      metadata: {},
      description: 'test',
      message: 'all good',
    });
    assert.ok(result.total >= 0.75);
    assert.ok(result.grade === 'excellent' || result.grade === 'good');
    scorer.shutdown();
  });

  it('score should assign failing grade for low score', () => {
    const scorer = new QualityScorer();
    const result = scorer.score({ error: 'fail', errors: ['e1'], failures: ['f1'] });
    assert.ok(result.total < 0.4);
    assert.strictEqual(result.grade, 'failing');
    scorer.shutdown();
  });

  it('score should include taskId from task', () => {
    const scorer = new QualityScorer();
    const result = scorer.score({ data: 1 }, { id: 'task-1' });
    assert.strictEqual(result.taskId, 'task-1');
    scorer.shutdown();
  });

  it('score should emit scored event', () => {
    const scorer = new QualityScorer();
    let emitted = null;
    scorer.on('scored', (evt) => { emitted = evt; });
    scorer.score({ success: true });
    assert.ok(emitted);
    assert.ok(emitted.total >= 0);
    scorer.shutdown();
  });

  it('score should record to signalPersistence when attached', () => {
    const sp = createMockSignalPersistence();
    const scorer = new QualityScorer({ signalPersistence: sp });
    scorer.score({ success: true });
    const records = sp._records.get('quality');
    assert.ok(records);
    assert.strictEqual(records.length, 1);
    scorer.shutdown();
  });

  it('attachSignalPersistence should return this', () => {
    const scorer = new QualityScorer();
    const sp = createMockSignalPersistence();
    const result = scorer.attachSignalPersistence(sp);
    assert.strictEqual(result, scorer);
    scorer.shutdown();
  });

  it('score should return non-zero score for string result', () => {
    const scorer = new QualityScorer();
    const result = scorer.score('This is a test result with some length to it.');
    assert.ok(result.total > 0, 'String result should have non-zero score');
    assert.ok(result.dimensions.completeness > 0, 'Completeness should be > 0');
    assert.ok(result.dimensions.coverage > 0, 'Coverage should be > 0');
    assert.ok(result.dimensions.clarity > 0, 'Clarity should be > 0');
    scorer.shutdown();
  });

  it('score should match expected output for correctness', () => {
    const scorer = new QualityScorer();
    const expected = { status: 'ok' };
    const result = scorer.score({ status: 'ok' }, { expectedOutput: expected });
    assert.strictEqual(result.dimensions.correctness, 1.0);
    scorer.shutdown();
  });

  it('score should handle coverage from result', () => {
    const scorer = new QualityScorer();
    const result = scorer.score({ coverage: 0.85 });
    assert.strictEqual(result.dimensions.coverage, 0.85);
    scorer.shutdown();
  });

  it('score should handle tests array for coverage', () => {
    const scorer = new QualityScorer();
    const result = scorer.score({
      tests: [
        { passed: true },
        { status: 'passed' },
        { passed: false },
      ],
    });
    assert.ok(result.dimensions.coverage > 0);
    scorer.shutdown();
  });

  it('score should add scope bonus for coverage', () => {
    const scorer = new QualityScorer();
    const withoutScope = scorer.score({ data: 1 });
    const withScope = scorer.score({ data: 1 }, { scope: 'module' });
    assert.ok(withScope.dimensions.coverage > withoutScope.dimensions.coverage);
    scorer.shutdown();
  });

  it('score should handle requirements for completeness', () => {
    const scorer = new QualityScorer();
    const result = scorer.score(
      { description: 'auth module with login' },
      { requirements: ['auth', 'login'] },
    );
    assert.ok(result.dimensions.completeness > 0);
    scorer.shutdown();
  });

  it('getHistory should return scored entries', () => {
    const scorer = new QualityScorer();
    scorer.score({ success: true });
    scorer.score({ error: 'fail' });
    const history = scorer.getHistory();
    assert.strictEqual(history.length, 2);
    scorer.shutdown();
  });

  it('getHistory should respect limit', () => {
    const scorer = new QualityScorer();
    scorer.score({ success: true });
    scorer.score({ error: 'fail' });
    scorer.score({ data: 1 });
    const history = scorer.getHistory(2);
    assert.strictEqual(history.length, 2);
    scorer.shutdown();
  });

  it('getStats should return empty stats when no scores', () => {
    const scorer = new QualityScorer();
    const stats = scorer.getStats();
    assert.strictEqual(stats.totalScores, 0);
    assert.strictEqual(stats.averageScore, 0);
    assert.deepStrictEqual(stats.gradeDistribution, {});
    scorer.shutdown();
  });

  it('getStats should return correct stats after scoring', () => {
    const scorer = new QualityScorer();
    scorer.score({ success: true, valid: true, passed: true, coverage: 1.0, status: 'ok', metadata: {}, description: 'test', message: 'ok' });
    scorer.score({ error: 'fail', errors: ['e1'], failures: ['f1'] });
    const stats = scorer.getStats();
    assert.strictEqual(stats.totalScores, 2);
    assert.ok(stats.averageScore > 0);
    assert.ok(stats.gradeDistribution.excellent || stats.gradeDistribution.failing);
    scorer.shutdown();
  });

  it('shutdown should clear history', () => {
    const scorer = new QualityScorer();
    scorer.score({ success: true });
    scorer.shutdown();
    assert.strictEqual(scorer.getHistory().length, 0);
  });

  it('should expose DIMENSIONS and DIMENSION_WEIGHTS statics', () => {
    assert.ok(QualityScorer.DIMENSIONS);
    assert.ok(QualityScorer.DIMENSIONS.COMPLETENESS);
    assert.ok(QualityScorer.DIMENSION_WEIGHTS);
    assert.strictEqual(typeof QualityScorer.DIMENSION_WEIGHTS.completeness, 'number');
  });
});

describe('SelfReflection - core', () => {
  it('constructor should initialize with default config', () => {
    const sr = new SelfReflection();
    assert.ok(sr);
    assert.strictEqual(sr._config.maxReflections, 3);
    assert.strictEqual(sr._config.improvementThreshold, 0.05);
    scorer_shutdown(sr);
  });

  it('constructor should accept custom options', () => {
    const sr = new SelfReflection({
      maxReflections: 5,
      improvementThreshold: 0.1,
      maxHistory: 100,
    });
    assert.strictEqual(sr._config.maxReflections, 5);
    assert.strictEqual(sr._config.improvementThreshold, 0.1);
    assert.strictEqual(sr._maxHistory, 100);
    scorer_shutdown(sr);
  });

  it('reflect should return error without agentId', () => {
    const sr = new SelfReflection();
    const result = sr.reflect({ skillId: 'test' });
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    scorer_shutdown(sr);
  });

  it('reflect should return error without skillId', () => {
    const sr = new SelfReflection();
    const result = sr.reflect({ agentId: 'agent-1' });
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    scorer_shutdown(sr);
  });

  it('reflect should return reflection with questions and dimensions', () => {
    const sr = new SelfReflection();
    const result = sr.reflect({ agentId: 'agent-1', skillId: 'tdd-implement' });
    assert.ok(result.reflectionId);
    assert.ok(result.questions);
    assert.ok(result.questions.length > 0);
    assert.ok(result.dimensions);
    assert.ok(result.selfCheckPrompt);
    assert.strictEqual(result.qualityTrend, 'initial');
    assert.strictEqual(result.recommendedAction, 'proceed-with-caution');
    scorer_shutdown(sr);
  });

  it('reflect should detect improving quality trend', () => {
    const sr = new SelfReflection();
    const result = sr.reflect({
      agentId: 'agent-1',
      skillId: 'tdd-implement',
      previousQuality: 0.5,
      currentQuality: 0.8,
    });
    assert.strictEqual(result.qualityTrend, 'improving');
    assert.strictEqual(result.recommendedAction, 'continue');
    scorer_shutdown(sr);
  });

  it('reflect should detect degrading quality trend', () => {
    const sr = new SelfReflection();
    const result = sr.reflect({
      agentId: 'agent-1',
      skillId: 'tdd-implement',
      previousQuality: 0.8,
      currentQuality: 0.5,
    });
    assert.strictEqual(result.qualityTrend, 'degrading');
    assert.strictEqual(result.recommendedAction, 'rollback-and-revise');
    scorer_shutdown(sr);
  });

  it('reflect should detect stable quality trend', () => {
    const sr = new SelfReflection();
    const result = sr.reflect({
      agentId: 'agent-1',
      skillId: 'tdd-implement',
      previousQuality: 0.7,
      currentQuality: 0.71,
    });
    assert.strictEqual(result.qualityTrend, 'stable');
    assert.strictEqual(result.recommendedAction, 'deepen-analysis');
    scorer_shutdown(sr);
  });

  it('reflect should use artifactType to select template', () => {
    const sr = new SelfReflection();
    const codeResult = sr.reflect({ agentId: 'a', skillId: 's', artifactType: 'code' });
    const designResult = sr.reflect({ agentId: 'a', skillId: 's', artifactType: 'design' });
    assert.notDeepStrictEqual(codeResult.questions, designResult.questions);
    scorer_shutdown(sr);
  });

  it('reflect should emit reflection-created event', () => {
    const sr = new SelfReflection();
    let emitted = null;
    sr.on('reflection-created', (evt) => { emitted = evt; });
    sr.reflect({ agentId: 'agent-1', skillId: 'tdd-implement' });
    assert.ok(emitted);
    assert.strictEqual(emitted.agentId, 'agent-1');
    assert.ok(emitted.qualityTrend);
    scorer_shutdown(sr);
  });

  it('reflect should record to signalPersistence when attached', () => {
    const sp = createMockSignalPersistence();
    const sr = new SelfReflection({ signalPersistence: sp });
    sr.reflect({ agentId: 'agent-1', skillId: 'tdd-implement' });
    const records = sp._records.get('reflection');
    assert.ok(records);
    assert.strictEqual(records.length, 1);
    scorer_shutdown(sr);
  });

  it('attachSignalPersistence should return this', () => {
    const sr = new SelfReflection();
    const sp = createMockSignalPersistence();
    const result = sr.attachSignalPersistence(sp);
    assert.strictEqual(result, sr);
    scorer_shutdown(sr);
  });
});

describe('SelfReflection - improvements and queries', () => {
  it('recordImprovement should return error for unknown reflection', () => {
    const sr = new SelfReflection();
    const result = sr.recordImprovement('nonexistent', { dimension: 'test' });
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    scorer_shutdown(sr);
  });

  it('recordImprovement should return error for invalid improvement', () => {
    const sr = new SelfReflection();
    const refl = sr.reflect({ agentId: 'a', skillId: 's' });
    const result = sr.recordImprovement(refl.reflectionId, null);
    assert.strictEqual(result.success, false);
    scorer_shutdown(sr);
  });

  it('recordImprovement should record improvement and emit event', () => {
    const sr = new SelfReflection();
    let emitted = null;
    sr.on('improvement-recorded', (evt) => { emitted = evt; });
    const refl = sr.reflect({ agentId: 'a', skillId: 's' });
    const result = sr.recordImprovement(refl.reflectionId, {
      dimension: 'completeness',
      description: 'Added missing validation',
      beforeScore: 0.5,
      afterScore: 0.8,
    });
    assert.strictEqual(result.recorded, true);
    assert.strictEqual(result.improvement.dimension, 'completeness');
    assert.strictEqual(result.improvement.beforeScore, 0.5);
    assert.strictEqual(result.improvement.afterScore, 0.8);
    assert.ok(emitted);
    assert.strictEqual(emitted.dimension, 'completeness');
    scorer_shutdown(sr);
  });

  it('getReflection should return stored reflection', () => {
    const sr = new SelfReflection();
    const refl = sr.reflect({ agentId: 'a', skillId: 's' });
    const stored = sr.getReflection(refl.reflectionId);
    assert.ok(stored);
    assert.strictEqual(stored.agentId, 'a');
    scorer_shutdown(sr);
  });

  it('getReflection should return null for unknown id', () => {
    const sr = new SelfReflection();
    assert.strictEqual(sr.getReflection('nonexistent'), null);
    scorer_shutdown(sr);
  });

  it('getAgentReflections should return reflections sorted by timestamp', () => {
    const sr = new SelfReflection();
    sr.reflect({ agentId: 'a', skillId: 's1' });
    sr.reflect({ agentId: 'a', skillId: 's2' });
    sr.reflect({ agentId: 'b', skillId: 's3' });
    const reflections = sr.getAgentReflections('a');
    assert.strictEqual(reflections.length, 2);
    scorer_shutdown(sr);
  });

  it('getStats should return correct statistics', () => {
    const sr = new SelfReflection();
    sr.reflect({ agentId: 'a', skillId: 's' });
    const stats = sr.getStats();
    assert.strictEqual(stats.totalReflections, 1);
    assert.strictEqual(stats.activeReflections, 1);
    assert.strictEqual(stats.totalImprovements, 0);
    scorer_shutdown(sr);
  });

  it('shouldTriggerReflection should return true on quality drop', () => {
    const sr = new SelfReflection();
    assert.strictEqual(sr.shouldTriggerReflection({ currentQuality: 0.5, previousQuality: 0.8 }), true);
    scorer_shutdown(sr);
  });

  it('shouldTriggerReflection should return true on low evidence completeness', () => {
    const sr = new SelfReflection();
    assert.strictEqual(sr.shouldTriggerReflection({ evidenceCompleteness: 0.5 }), true);
    scorer_shutdown(sr);
  });

  it('shouldTriggerReflection should return true on multiple iterations', () => {
    const sr = new SelfReflection();
    assert.strictEqual(sr.shouldTriggerReflection({ iterationCount: 3 }), true);
    scorer_shutdown(sr);
  });

  it('shouldTriggerReflection should return false for good context', () => {
    const sr = new SelfReflection();
    assert.strictEqual(sr.shouldTriggerReflection({ currentQuality: 0.8, previousQuality: 0.7, evidenceCompleteness: 0.9, iterationCount: 1 }), false);
    scorer_shutdown(sr);
  });

  it('shouldTriggerReflection should return false for null context', () => {
    const sr = new SelfReflection();
    assert.strictEqual(sr.shouldTriggerReflection(null), false);
    scorer_shutdown(sr);
  });

  it('reflect should respect maxHistory limit', () => {
    const sr = new SelfReflection({ maxHistory: 2 });
    sr.reflect({ agentId: 'a', skillId: 's1' });
    sr.reflect({ agentId: 'a', skillId: 's2' });
    sr.reflect({ agentId: 'a', skillId: 's3' });
    assert.strictEqual(sr._history.size, 2);
    scorer_shutdown(sr);
  });

  it('should expose REFLECTION_DIMENSIONS and REFLECTION_TEMPLATES statics', () => {
    assert.ok(Array.isArray(SelfReflection.REFLECTION_DIMENSIONS));
    assert.ok(SelfReflection.REFLECTION_TEMPLATES);
    assert.ok(SelfReflection.REFLECTION_TEMPLATES.code);
    assert.ok(SelfReflection.REFLECTION_TEMPLATES.design);
    assert.ok(SelfReflection.REFLECTION_TEMPLATES.test);
    assert.ok(SelfReflection.REFLECTION_TEMPLATES.documentation);
  });

  it('shutdown should clear history', () => {
    const sr = new SelfReflection();
    sr.reflect({ agentId: 'a', skillId: 's' });
    sr.shutdown();
    assert.strictEqual(sr._history.size, 0);
  });
});

describe('AdversarialReview', () => {
  it('constructor should initialize with default maxRounds', () => {
    const ar = new AdversarialReview();
    assert.strictEqual(ar._maxRounds, 3);
    ar.shutdown();
  });

  it('constructor should accept custom maxRounds', () => {
    const ar = new AdversarialReview({ maxRounds: 5 });
    assert.strictEqual(ar._maxRounds, 5);
    ar.shutdown();
  });

  it('review should return error for missing arguments', async () => {
    const ar = new AdversarialReview();
    const result = await ar.review(null, async () => ({}), async () => ({}));
    assert.strictEqual(result.consensus, false);
    assert.strictEqual(result.rounds, 0);
    assert.ok(result.error);
    ar.shutdown();
  });

  it('review should reach consensus when both approve', async () => {
    const ar = new AdversarialReview();
    const reviewerA = async () => ({ approved: true, feedback: '' });
    const reviewerB = async () => ({ approved: true, feedback: '' });
    const result = await ar.review({ code: 'test' }, reviewerA, reviewerB);
    assert.strictEqual(result.consensus, true);
    assert.strictEqual(result.rounds, 1);
    ar.shutdown();
  });

  it('review should continue rounds when not both approve', async () => {
    const ar = new AdversarialReview({ maxRounds: 2 });
    let callCount = 0;
    const reviewerA = async () => {
      callCount++;
      return { approved: callCount > 1, feedback: 'needs work' };
    };
    const reviewerB = async () => ({ approved: true, feedback: '' });
    const result = await ar.review({ code: 'test' }, reviewerA, reviewerB);
    assert.strictEqual(result.consensus, true);
    assert.ok(result.rounds >= 1);
    ar.shutdown();
  });

  it('review should return no consensus after max rounds', async () => {
    const ar = new AdversarialReview({ maxRounds: 2 });
    const reviewerA = async () => ({ approved: false, feedback: 'reject' });
    const reviewerB = async () => ({ approved: false, feedback: 'reject' });
    const result = await ar.review({ code: 'test' }, reviewerA, reviewerB);
    assert.strictEqual(result.consensus, false);
    assert.strictEqual(result.rounds, 2);
    assert.ok(result.finalFeedback);
    ar.shutdown();
  });

  it('review should emit round-complete event', async () => {
    const ar = new AdversarialReview();
    let emitted = null;
    ar.on('round-complete', (evt) => { emitted = evt; });
    const reviewerA = async () => ({ approved: true, feedback: '' });
    const reviewerB = async () => ({ approved: true, feedback: '' });
    await ar.review({ code: 'test' }, reviewerA, reviewerB);
    assert.ok(emitted);
    assert.strictEqual(emitted.round, 1);
    ar.shutdown();
  });

  it('review should emit review-complete event', async () => {
    const ar = new AdversarialReview();
    let emitted = null;
    ar.on('review-complete', (evt) => { emitted = evt; });
    const reviewerA = async () => ({ approved: true, feedback: '' });
    const reviewerB = async () => ({ approved: true, feedback: '' });
    await ar.review({ code: 'test' }, reviewerA, reviewerB);
    assert.ok(emitted);
    assert.strictEqual(emitted.consensus, true);
    ar.shutdown();
  });

  it('review should handle reviewer errors gracefully', async () => {
    const ar = new AdversarialReview();
    const reviewerA = async () => { throw new Error('Reviewer A failed'); };
    const reviewerB = async () => ({ approved: true, feedback: '' });
    const result = await ar.review({ code: 'test' }, reviewerA, reviewerB);
    assert.strictEqual(result.consensus, false);
    assert.ok(result.details[0].reviewerA.error);
    assert.strictEqual(result.details[0].reviewerA.approved, false);
    ar.shutdown();
  });

  it('review should merge feedback from both reviewers', async () => {
    const ar = new AdversarialReview({ maxRounds: 1 });
    const reviewerA = async () => ({ approved: false, feedback: 'A feedback' });
    const reviewerB = async () => ({ approved: false, feedback: 'B feedback' });
    const result = await ar.review({ code: 'test' }, reviewerA, reviewerB);
    assert.ok(result.finalFeedback.includes('A feedback'));
    assert.ok(result.finalFeedback.includes('B feedback'));
    ar.shutdown();
  });

  it('should expose DEFAULT_MAX_ROUNDS static', () => {
    assert.strictEqual(AdversarialReview.DEFAULT_MAX_ROUNDS, 3);
  });
});

describe('DocFreshnessGuard', () => {
  it('constructor should initialize without projectRoot', () => {
    const guard = new DocFreshnessGuard();
    assert.ok(guard);
    assert.strictEqual(guard._root, null);
    guard.shutdown();
  });

  it('constructor should build index with projectRoot', async () => {
    const tmpDir = createTempDir('dfg');
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\nRefer to src/runtime/test.js');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir });
    await guard.ready;
    const index = guard.getDocIndex();
    assert.ok(index.length >= 1);
    guard.shutdown();
  });

  it('attachProjectRoot should set root and build index', async () => {
    const tmpDir = createTempDir('dfg');
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'api.md'), '# API\n');
    const guard = new DocFreshnessGuard();
    guard.attachProjectRoot(tmpDir);
    await guard.ready;
    const index = guard.getDocIndex();
    assert.ok(index.length >= 1);
    guard.shutdown();
  });

  it('attachProjectRoot should not override existing root', async () => {
    const tmpDir1 = createTempDir('dfg1');
    const tmpDir2 = createTempDir('dfg2');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir1 });
    await guard.ready;
    const result = guard.attachProjectRoot(tmpDir2);
    assert.strictEqual(result, guard);
    assert.strictEqual(guard._root, tmpDir1);
    guard.shutdown();
  });

  it('getStaleDocs should return empty array when no stale docs', async () => {
    const tmpDir = createTempDir('dfg');
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir });
    await guard.ready;
    const stale = guard.getStaleDocs();
    assert.strictEqual(stale.length, 0);
    guard.shutdown();
  });

  it('handleCodeChange should mark related docs as stale', async () => {
    const tmpDir = createTempDir('dfg');
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n`src/runtime/test.js`\n');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir });
    await guard.ready;
    const staleDocs = guard.handleCodeChange(path.join(tmpDir, 'src', 'runtime', 'test.js'), 'change');
    assert.ok(staleDocs.length >= 1);
    const stale = guard.getStaleDocs();
    assert.ok(stale.length >= 1);
    guard.shutdown();
  });

  it('handleCodeChange should emit docs-staled event', async () => {
    const tmpDir = createTempDir('dfg');
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n`src/runtime/test.js`\n');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir });
    await guard.ready;
    let emitted = null;
    guard.on('docs-staled', (evt) => { emitted = evt; });
    guard.handleCodeChange(path.join(tmpDir, 'src', 'runtime', 'test.js'), 'change');
    assert.ok(emitted);
    assert.ok(emitted.staleDocs.length >= 1);
    guard.shutdown();
  });

  it('markDocVerified should mark doc as fresh', async () => {
    const tmpDir = createTempDir('dfg');
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n`src/runtime/test.js`\n');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir });
    await guard.ready;
    guard.handleCodeChange(path.join(tmpDir, 'src', 'runtime', 'test.js'), 'change');
    const result = guard.markDocVerified('docs/guide.md');
    assert.strictEqual(result, true);
    const stale = guard.getStaleDocs();
    assert.strictEqual(stale.length, 0);
    guard.shutdown();
  });

  it('markDocVerified should return false for unknown doc', async () => {
    const tmpDir = createTempDir('dfg');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir });
    await guard.ready;
    assert.strictEqual(guard.markDocVerified('nonexistent.md'), false);
    guard.shutdown();
  });

  it('markDocVerified should emit doc-verified event', async () => {
    const tmpDir = createTempDir('dfg');
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n`src/runtime/test.js`\n');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir });
    await guard.ready;
    guard.handleCodeChange(path.join(tmpDir, 'src', 'runtime', 'test.js'), 'change');
    let emitted = null;
    guard.on('doc-verified', (evt) => { emitted = evt; });
    guard.markDocVerified('docs/guide.md');
    assert.ok(emitted);
    assert.strictEqual(emitted.path, 'docs/guide.md');
    guard.shutdown();
  });

  it('getFreshnessStats should return correct stats', async () => {
    const tmpDir = createTempDir('dfg');
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir });
    await guard.ready;
    const stats = guard.getFreshnessStats();
    assert.strictEqual(stats.totalDocs, 1);
    assert.strictEqual(stats.staleDocs, 0);
    assert.strictEqual(stats.freshDocs, 1);
    assert.strictEqual(stats.freshnessRate, 1);
    assert.strictEqual(stats.watching, false);
    guard.shutdown();
  });

  it('validateFreshness should detect stale docs by threshold', async () => {
    const tmpDir = createTempDir('dfg');
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir });
    await guard.ready;
    const index = guard.getDocIndex();
    const entry = guard._docIndex.get(index[0].path);
    entry.lastVerifiedAt = Date.now() - DocFreshnessGuard.STALE_THRESHOLD_MS - 1000;
    const result = await guard.validateFreshness();
    assert.strictEqual(result.valid, false);
    assert.ok(result.newlyStale >= 1);
    guard.shutdown();
  });

  it('validateFreshness should return valid when all docs fresh', async () => {
    const tmpDir = createTempDir('dfg');
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir });
    await guard.ready;
    const result = await guard.validateFreshness();
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.newlyStale, 0);
    guard.shutdown();
  });

  it('_extractCodeReferences should find code references', () => {
    const guard = new DocFreshnessGuard();
    const refs = guard._extractCodeReferences('See src/runtime/test.js and require(\'./utils/helper\')');
    assert.ok(refs.length >= 1);
    guard.shutdown();
  });

  it('should expose STALE_THRESHOLD_MS, CODE_EXTENSIONS, DOC_EXTENSIONS statics', () => {
    assert.strictEqual(typeof DocFreshnessGuard.STALE_THRESHOLD_MS, 'number');
    assert.ok(DocFreshnessGuard.CODE_EXTENSIONS instanceof Set);
    assert.ok(DocFreshnessGuard.DOC_EXTENSIONS instanceof Set);
  });

  it('shutdown should clear indices and stop watching', async () => {
    const tmpDir = createTempDir('dfg');
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n');
    const guard = new DocFreshnessGuard({ projectRoot: tmpDir });
    await guard.ready;
    guard.shutdown();
    assert.strictEqual(guard._docIndex.size, 0);
    assert.strictEqual(guard._staleDocs.size, 0);
  });
});

describe('SelfEvolutionGovernor - core', () => {
  it('constructor should initialize with default values', () => {
    const gov = new SelfEvolutionGovernor();
    assert.ok(gov);
    assert.strictEqual(gov._running, false);
    assert.strictEqual(gov._consecutiveErrors, 0);
    const stats = gov.getStats();
    assert.strictEqual(stats.heartbeatsExecuted, 0);
    assert.strictEqual(stats.signalsCollected, 0);
    gov.shutdown();
  });

  it('constructor should accept custom options', () => {
    const gov = new SelfEvolutionGovernor({
      heartbeatIntervalMs: 5000,
      observationWindowMs: 3600000,
      agendaMaturityThreshold: 5,
    });
    assert.strictEqual(gov._heartbeatInterval, 5000);
    assert.strictEqual(gov._observationWindow, 3600000);
    assert.strictEqual(gov._agendaMaturityThreshold, 5);
    gov.shutdown();
  });

  it('constructor should clamp heartbeatInterval to valid range', () => {
    const govLow = new SelfEvolutionGovernor({ heartbeatIntervalMs: 1 });
    assert.strictEqual(govLow._heartbeatInterval, 5000);
    govLow.shutdown();
    const govHigh = new SelfEvolutionGovernor({ heartbeatIntervalMs: 999999999 });
    assert.strictEqual(govHigh._heartbeatInterval, 3600000);
    govHigh.shutdown();
  });

  it('start should set running and emit event', () => {
    const gov = new SelfEvolutionGovernor();
    let emitted = null;
    gov.on('governor-started', (evt) => { emitted = evt; });
    gov.start();
    assert.strictEqual(gov._running, true);
    assert.ok(emitted);
    assert.ok(emitted.intervalMs);
    gov.shutdown();
  });

  it('start should be idempotent', () => {
    const gov = new SelfEvolutionGovernor();
    gov.start();
    gov.start();
    assert.strictEqual(gov._running, true);
    gov.shutdown();
  });

  it('stop should clear running and emit event', () => {
    const gov = new SelfEvolutionGovernor();
    gov.start();
    let emitted = null;
    gov.on('governor-stopped', (evt) => { emitted = evt; });
    gov.stop();
    assert.strictEqual(gov._running, false);
    assert.ok(emitted);
    gov.shutdown();
  });

  it('attachSignalPersistence should return this', () => {
    const gov = new SelfEvolutionGovernor();
    const sp = createMockSignalPersistence();
    const result = gov.attachSignalPersistence(sp);
    assert.strictEqual(result, gov);
    gov.shutdown();
  });

  it('attachHealthChecker should return this', () => {
    const gov = new SelfEvolutionGovernor();
    const hc = createMockHealthChecker();
    const result = gov.attachHealthChecker(hc);
    assert.strictEqual(result, gov);
    gov.shutdown();
  });

  it('attachCausalDataBus should return this', () => {
    const gov = new SelfEvolutionGovernor();
    const cdb = createMockCausalDataBus();
    const result = gov.attachCausalDataBus(cdb);
    assert.strictEqual(result, gov);
    gov.shutdown();
  });

  it('attachQualityScorer should return this', () => {
    const gov = new SelfEvolutionGovernor();
    const qs = new QualityScorer();
    const result = gov.attachQualityScorer(qs);
    assert.strictEqual(result, gov);
    qs.shutdown();
    gov.shutdown();
  });

  it('attachConvergenceDetector should return this', () => {
    const gov = new SelfEvolutionGovernor();
    const result = gov.attachConvergenceDetector({ isConverged: () => true });
    assert.strictEqual(result, gov);
    gov.shutdown();
  });

  it('attachScheduler should return this', () => {
    const gov = new SelfEvolutionGovernor();
    const result = gov.attachScheduler({ schedule: () => {} });
    assert.strictEqual(result, gov);
    gov.shutdown();
  });
});

describe('SelfEvolutionGovernor - heartbeat and agenda', () => {
  it('forceHeartbeat should execute heartbeat and emit event', async () => {
    const gov = new SelfEvolutionGovernor();
    let emitted = null;
    gov.on('heartbeat-complete', (evt) => { emitted = evt; });
    await gov.forceHeartbeat();
    assert.ok(emitted);
    assert.strictEqual(emitted.heartbeatNumber, 1);
    const stats = gov.getStats();
    assert.strictEqual(stats.heartbeatsExecuted, 1);
    gov.shutdown();
  });

  it('forceHeartbeat should collect observations from healthChecker', async () => {
    const gov = new SelfEvolutionGovernor();
    gov.attachHealthChecker(createMockHealthChecker());
    let emitted = null;
    gov.on('heartbeat-complete', (evt) => { emitted = evt; });
    await gov.forceHeartbeat();
    assert.ok(emitted);
    assert.ok(emitted.observationsCollected >= 1);
    gov.shutdown();
  });

  it('forceHeartbeat should collect observations from causalDataBus', async () => {
    const gov = new SelfEvolutionGovernor();
    gov.attachCausalDataBus(createMockCausalDataBus());
    let emitted = null;
    gov.on('heartbeat-complete', (evt) => { emitted = evt; });
    await gov.forceHeartbeat();
    assert.ok(emitted);
    assert.ok(emitted.observationsCollected >= 1);
    gov.shutdown();
  });

  it('forceHeartbeat should collect trend observations from signalPersistence', async () => {
    const sp = createMockSignalPersistence();
    sp.record('quality', { total: 0.5 });
    sp.record('quality', { total: 0.3 });
    sp.record('quality', { total: 0.2 });
    const gov = new SelfEvolutionGovernor();
    gov.attachSignalPersistence(sp);
    let emitted = null;
    gov.on('heartbeat-complete', (evt) => { emitted = evt; });
    await gov.forceHeartbeat();
    assert.ok(emitted);
    assert.ok(emitted.observationsCollected >= 1);
    gov.shutdown();
  });

  it('forceHeartbeat should record degrading quality to agenda', async () => {
    const sp = createMockSignalPersistence();
    sp.record('quality', { total: 0.8 });
    sp.record('quality', { total: 0.5 });
    sp.record('quality', { total: 0.2 });
    const gov = new SelfEvolutionGovernor();
    gov.attachSignalPersistence(sp);
    await gov.forceHeartbeat();
    const items = gov.getAgendaItems();
    const degrading = items.find(i => i.key === 'quality-degrading');
    assert.ok(degrading);
    gov.shutdown();
  });

  it('forceHeartbeat should mature agenda items after threshold', async () => {
    const sp = createMockSignalPersistence();
    sp.record('quality', { total: 0.8 });
    sp.record('quality', { total: 0.5 });
    sp.record('quality', { total: 0.2 });
    const gov = new SelfEvolutionGovernor({ agendaMaturityThreshold: 1 });
    gov.attachSignalPersistence(sp);
    let proposalEmitted = null;
    gov.on('proposal-generated', (evt) => { proposalEmitted = evt; });
    await gov.forceHeartbeat();
    assert.ok(proposalEmitted);
    assert.strictEqual(proposalEmitted.recommendedAction, 'investigate-quality-regression');
    gov.shutdown();
  });

  it('getAgendaItems should filter by status', async () => {
    const sp = createMockSignalPersistence();
    sp.record('quality', { total: 0.8 });
    sp.record('quality', { total: 0.5 });
    sp.record('quality', { total: 0.2 });
    const gov = new SelfEvolutionGovernor();
    gov.attachSignalPersistence(sp);
    await gov.forceHeartbeat();
    const accumulating = gov.getAgendaItems('accumulating');
    const matured = gov.getAgendaItems('matured');
    assert.ok(accumulating.length + matured.length > 0);
    gov.shutdown();
  });

  it('getAgendaItems should return all items without status filter', async () => {
    const sp = createMockSignalPersistence();
    sp.record('quality', { total: 0.8 });
    sp.record('quality', { total: 0.5 });
    sp.record('quality', { total: 0.2 });
    const gov = new SelfEvolutionGovernor();
    gov.attachSignalPersistence(sp);
    await gov.forceHeartbeat();
    const all = gov.getAgendaItems();
    assert.ok(all.length > 0);
    gov.shutdown();
  });

  it('getProposals should return empty array without signalPersistence', () => {
    const gov = new SelfEvolutionGovernor();
    const proposals = gov.getProposals();
    assert.deepStrictEqual(proposals, []);
    gov.shutdown();
  });

  it('getStats should return correct statistics', async () => {
    const gov = new SelfEvolutionGovernor();
    await gov.forceHeartbeat();
    const stats = gov.getStats();
    assert.strictEqual(stats.heartbeatsExecuted, 1);
    assert.strictEqual(stats.running, false);
    assert.ok(typeof stats.heartbeatInterval === 'number');
    assert.ok(typeof stats.activeAgendaItems === 'number');
    gov.shutdown();
  });

  it('isHealthy should return true when active', () => {
    const gov = new SelfEvolutionGovernor();
    assert.strictEqual(gov.isHealthy(), true);
    gov.shutdown();
  });

  it('isHealthy should return false after shutdown', () => {
    const gov = new SelfEvolutionGovernor();
    gov.shutdown();
    assert.strictEqual(gov.isHealthy(), false);
  });

  it('should expose OBSERVATION_SIGNALS static', () => {
    assert.ok(Array.isArray(SelfEvolutionGovernor.OBSERVATION_SIGNALS));
    assert.ok(SelfEvolutionGovernor.OBSERVATION_SIGNALS.includes('quality_trend'));
  });

  it('shutdown should stop and clear agenda', () => {
    const gov = new SelfEvolutionGovernor();
    gov.start();
    gov.shutdown();
    assert.strictEqual(gov._running, false);
    assert.strictEqual(gov._agendaItems.size, 0);
  });

  it('_inferAction should return correct action for each agenda key', () => {
    const gov = new SelfEvolutionGovernor();
    assert.strictEqual(gov._inferAction({ key: 'quality-degrading' }), 'investigate-quality-regression');
    assert.strictEqual(gov._inferAction({ key: 'health-critical' }), 'escalate-health-incident');
    assert.strictEqual(gov._inferAction({ key: 'convergence-degrading' }), 'review-convergence-thresholds');
    assert.strictEqual(gov._inferAction({ key: 'causal-invariant-violations' }), 'audit-invariant-violations');
    assert.strictEqual(gov._inferAction({ key: 'reflection-degrading' }), 'deepen-self-reflection');
    assert.strictEqual(gov._inferAction({ key: 'unknown' }), 'investigate');
    gov.shutdown();
  });

  it('forceHeartbeat should handle healthChecker errors gracefully', async () => {
    const gov = new SelfEvolutionGovernor();
    gov.attachHealthChecker({
      async getAggregatedReport() { throw new Error('health check failed'); },
    });
    let emitted = null;
    gov.on('heartbeat-complete', (evt) => { emitted = evt; });
    await gov.forceHeartbeat();
    assert.ok(emitted);
    gov.shutdown();
  });

  it('forceHeartbeat should not execute after shutdown', async () => {
    const gov = new SelfEvolutionGovernor();
    gov.shutdown();
    assert.throws(() => gov.forceHeartbeat(), { code: 'SHUTDOWN' });
  });

  it('agenda should respect maxAgendaItems limit via _recordObservation', async () => {
    const gov = new SelfEvolutionGovernor({ agendaMaturityThreshold: 100 });
    for (let i = 0; i < 250; i++) {
      gov._recordObservation({ signalType: 'quality_trend', trend: 'degrading', timestamp: new Date().toISOString() });
    }
    assert.strictEqual(gov._agendaItems.size, 1);
    gov.shutdown();
  });
});

function scorer_shutdown(instance) {
  if (instance && typeof instance.shutdown === 'function') {
    instance.shutdown();
  }
}
