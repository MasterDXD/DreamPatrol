'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EnsembleOrchestrator } = require('../../../src/runtime/collaboration/ensemble-orchestrator');
const { AgentContributionTracker } = require('../../../src/runtime/collaboration/agent-contribution-tracker');

const makeExecuteFn = (results) => async (agent, _task) => {
  const idx = typeof agent === 'number' ? agent : 0;
  return results[idx] ?? { output: 'default', confidence: 0.5 };
};

describe('EnsembleOrchestrator', () => {
  it('should execute bagging with bootstrap sampling', async () => {
    const orchestrator = new EnsembleOrchestrator();
    const agents = [0, 1, 2];
    const results = [
      { output: { x: 1, y: 'a' }, confidence: 0.8 },
      { output: { x: 1, y: 'b' }, confidence: 0.7 },
      { output: { x: 2, y: 'a' }, confidence: 0.9 },
    ];
    const result = await orchestrator.execute({ x: 1, y: 'a' }, agents, makeExecuteFn(results), { mode: 'bagging' });
    assert.equal(result.mode, 'bagging');
    assert.ok(result.confidence > 0);
    assert.ok(result.output);
    assert.equal(result.agentContributions.length, 3);
  });

  it('should execute boosting with weight updates and early stopping', async () => {
    const orchestrator = new EnsembleOrchestrator({ maxRounds: 3, earlyStopPatience: 1 });
    const agents = [0, 1, 2];
    const results = [
      { output: { x: 1 }, confidence: 0.3 },
      { output: { x: 1 }, confidence: 0.6 },
      { output: { x: 1 }, confidence: 0.9 },
    ];
    const result = await orchestrator.execute({ x: 1 }, agents, makeExecuteFn(results), { mode: 'boosting' });
    assert.equal(result.mode, 'boosting');
    assert.ok(result.rounds >= 1);
    assert.ok(result.confidence > 0);
    assert.ok(result.roundResults);
    assert.ok(result.finalAspectWeights);
  });

  it('should execute stacking with meta-learner', async () => {
    const orchestrator = new EnsembleOrchestrator();
    const agents = [0, 1, 2, 3];
    const results = [
      { output: { x: 1 }, confidence: 0.7 },
      { output: { x: 2 }, confidence: 0.8 },
      { output: { x: 1 }, confidence: 0.6 },
      { output: { x: 1.5 }, confidence: 0.9 },
    ];
    const result = await orchestrator.execute({ x: 1 }, agents, makeExecuteFn(results), { mode: 'stacking' });
    assert.equal(result.mode, 'stacking');
    assert.ok(result.output);
    assert.ok(result.baseResults);
    assert.equal(result.agentContributions.filter(c => c.layer === 'base').length, 3);
    assert.ok(result.agentContributions.some(c => c.layer === 'meta'));
  });

  it('should auto-select mode based on task', async () => {
    const orchestrator = new EnsembleOrchestrator();
    const agents = [0, 1];
    const results = [{ output: 'a', confidence: 0.8 }, { output: 'b', confidence: 0.7 }];
    const result = await orchestrator.execute({ stability: true }, agents, makeExecuteFn(results));
    assert.equal(result.mode, 'bagging');
  });

  it('should handle solo agent', async () => {
    const orchestrator = new EnsembleOrchestrator();
    const result = await orchestrator.execute({ x: 1 }, [0], makeExecuteFn([{ output: 'a', confidence: 0.8 }]));
    assert.equal(result.mode, 'solo');
    assert.equal(result.confidence, 0.8);
  });

  it('should compute agent weights via AdaBoost formula', async () => {
    const orchestrator = new EnsembleOrchestrator();
    const w1 = orchestrator._computeAgentWeight(0.1);
    const w2 = orchestrator._computeAgentWeight(0.5);
    assert.ok(w1 > w2, 'Lower error rate should have higher weight');
  });

  it('should extract residual from previous result', async () => {
    const orchestrator = new EnsembleOrchestrator();
    const residual = orchestrator._extractResidual({ output: { a: null, b: 'ok' }, confidence: 0.4 });
    assert.ok(residual);
    assert.ok(residual.weakAspects.includes('a'));
    assert.ok(residual.suggestions.length > 0);
  });

  it('should perform bootstrap sampling with feature subsampling', async () => {
    const orchestrator = new EnsembleOrchestrator({ featureSampleRatio: 0.7 });
    const task = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    const sample = orchestrator._bootstrapSample(task, 0, 3);
    assert.ok(sample._bootstrapIndex === 0);
    assert.ok(sample._sampledFeatures.length > 0);
  });

  it('should early stop when quality threshold reached', async () => {
    const orchestrator = new EnsembleOrchestrator({ qualityThreshold: 0.95, maxRounds: 5 });
    const agents = [0, 1, 2, 3, 4];
    const results = [
      { output: { x: 1 }, confidence: 0.6 },
      { output: { x: 1 }, confidence: 0.8 },
      { output: { x: 1 }, confidence: 0.97 },
      { output: { x: 1 }, confidence: 0.99 },
      { output: { x: 1 }, confidence: 0.99 },
    ];
    const result = await orchestrator.execute({ x: 1 }, agents, makeExecuteFn(results), { mode: 'boosting' });
    assert.ok(result.rounds < 5, 'Should stop early when quality threshold reached');
  });

  it('should integrate with contribution tracker', async () => {
    const tracker = new AgentContributionTracker();
    const orchestrator = new EnsembleOrchestrator();
    orchestrator.setContributionTracker(tracker);
    const agents = [0, 1];
    const results = [{ output: 'a', confidence: 0.8 }, { output: 'b', confidence: 0.7 }];
    await orchestrator.execute({ x: 1 }, agents, makeExecuteFn(results), { mode: 'bagging' });
    const stats = tracker.getStats();
    assert.ok(stats.totalRecords > 0);
  });
});

describe('AgentContributionTracker', () => {
  it('should record and retrieve agent contributions', () => {
    const tracker = new AgentContributionTracker();
    tracker.record('agent-a', 'bagging', 0.8, 0.85, 1.0);
    tracker.record('agent-b', 'boosting', 0.6, 0.75, 0.5);
    assert.ok(tracker.getAgentImportance('agent-a') > 0);
    assert.ok(tracker.getAgentImportance('agent-b') > 0);
  });

  it('should compute feature importance', () => {
    const tracker = new AgentContributionTracker();
    tracker.record('agent-a', 'bagging', 0.9, 0.9, 2.0);
    tracker.record('agent-b', 'bagging', 0.5, 0.7, 0.5);
    const importance = tracker.getFeatureImportance();
    assert.ok(importance.get('agent-a').averageWeight > importance.get('agent-b').averageWeight);
  });

  it('should return top contributors', () => {
    const tracker = new AgentContributionTracker();
    tracker.record('a', 'bagging', 0.9, 0.9, 2.0);
    tracker.record('b', 'bagging', 0.5, 0.7, 0.5);
    tracker.record('c', 'boosting', 0.7, 0.8, 1.0);
    const top = tracker.getTopContributors(2);
    assert.equal(top.length, 2);
    assert.equal(top[0].agentId, 'a');
  });

  it('should filter records by mode', () => {
    const tracker = new AgentContributionTracker();
    tracker.record('a', 'bagging', 0.8, 0.85, 1.0);
    tracker.record('b', 'boosting', 0.6, 0.75, 0.5);
    assert.equal(tracker.getRecordsByMode('bagging').length, 1);
    assert.equal(tracker.getRecordsByMode('boosting').length, 1);
  });

  it('should clear all records', () => {
    const tracker = new AgentContributionTracker();
    tracker.record('a', 'bagging', 0.8, 0.85, 1.0);
    tracker.clear();
    assert.equal(tracker.getStats().totalRecords, 0);
  });
});

describe('EnsembleOrchestrator regression: NaN confidence', () => {
  it('should not corrupt weights when agent returns NaN confidence in bagging', async () => {
    const orchestrator = new EnsembleOrchestrator();
    const agents = [0, 1];
    const executeFn = async (agent) => {
      if (agent === 0) return { output: 'a', confidence: NaN };
      return { output: 'b', confidence: 0.8 };
    };
    const result = await orchestrator.execute({ x: 1 }, agents, executeFn, { mode: 'bagging' });
    assert.ok(Number.isFinite(result.confidence));
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  });

  it('should not corrupt weights when agent returns NaN confidence in boosting', async () => {
    const orchestrator = new EnsembleOrchestrator({ maxRounds: 2 });
    const agents = [0, 1];
    const executeFn = async (agent) => {
      if (agent === 0) return { output: { x: 1 }, confidence: NaN };
      return { output: { x: 1 }, confidence: 0.8 };
    };
    const result = await orchestrator.execute({ x: 1 }, agents, executeFn, { mode: 'boosting' });
    assert.ok(Number.isFinite(result.confidence));
  });
});
