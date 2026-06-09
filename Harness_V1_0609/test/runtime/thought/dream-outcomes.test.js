'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const DreamOutcomes = require(path.join(ROOT, 'src', 'runtime', 'thought', 'dream-outcomes'));

describe('DreamOutcomes - Constructor', () => {
  it('should create instance with default values', () => {
    const outcomes = new DreamOutcomes();
    assert.ok(outcomes);
    assert.strictEqual(outcomes._outcomes.size, 0);
    assert.strictEqual(outcomes._evaluations.length, 0);
    assert.strictEqual(outcomes._noteUsage.size, 0);
    assert.deepStrictEqual(outcomes._syncCounters, { toDreamEngine: 0, toImprovementLoop: 0 });
    assert.strictEqual(outcomes._dreamEngine, null);
    assert.strictEqual(outcomes._skillImprovementLoop, null);
    assert.strictEqual(outcomes._qualityScorer, null);
  });
});

describe('DreamOutcomes - defineOutcome / getOutcome / listOutcomes / removeOutcome', () => {
  it('should define and retrieve an outcome', () => {
    const outcomes = new DreamOutcomes();
    const entry = outcomes.defineOutcome('task-1', {
      description: 'Test task',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    assert.ok(entry);
    assert.strictEqual(entry.taskId, 'task-1');
    assert.strictEqual(entry.criteria.description, 'Test task');
    assert.strictEqual(entry.category, 'task');
    assert.ok(entry.definedAt);

    const retrieved = outcomes.getOutcome('task-1');
    assert.strictEqual(retrieved.taskId, 'task-1');
    assert.strictEqual(retrieved.criteria.description, 'Test task');
  });

  it('should emit outcome-defined event', () => {
    const outcomes = new DreamOutcomes();
    let eventData = null;
    outcomes.on('outcome-defined', (data) => { eventData = data; });
    outcomes.defineOutcome('task-1', { description: 'Test', metrics: [] });
    assert.ok(eventData);
    assert.strictEqual(eventData.taskId, 'task-1');
    assert.strictEqual(eventData.category, 'task');
  });

  it('should list outcomes filtered by category', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', { description: 'T1', metrics: [], category: 'task' });
    outcomes.defineOutcome('sess-1', { description: 'S1', metrics: [], category: 'session' });
    outcomes.defineOutcome('skill-1', { description: 'Sk1', metrics: [], category: 'skill' });

    const all = outcomes.listOutcomes();
    assert.strictEqual(all.length, 3);

    const tasks = outcomes.listOutcomes('task');
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].taskId, 'task-1');

    const sessions = outcomes.listOutcomes('session');
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].taskId, 'sess-1');

    const skills = outcomes.listOutcomes('skill');
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].taskId, 'skill-1');
  });

  it('should remove an outcome', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', { description: 'Test', metrics: [] });
    assert.ok(outcomes.getOutcome('task-1'));
    const removed = outcomes.removeOutcome('task-1');
    assert.strictEqual(removed, true);
    assert.strictEqual(outcomes.getOutcome('task-1'), null);
  });

  it('should return null for unknown outcome', () => {
    const outcomes = new DreamOutcomes();
    assert.strictEqual(outcomes.getOutcome('unknown'), null);
  });

  it('should return null for invalid taskId', () => {
    const outcomes = new DreamOutcomes();
    assert.strictEqual(outcomes.defineOutcome('', { description: 'Test', metrics: [] }), null);
    assert.strictEqual(outcomes.defineOutcome(null, { description: 'Test', metrics: [] }), null);
    assert.strictEqual(outcomes.defineOutcome(123, { description: 'Test', metrics: [] }), null);
  });

  it('should return null for invalid criteria', () => {
    const outcomes = new DreamOutcomes();
    assert.strictEqual(outcomes.defineOutcome('task-1', null), null);
    assert.strictEqual(outcomes.defineOutcome('task-1', 'invalid'), null);
  });

  it('should default category to task for unrecognized category', () => {
    const outcomes = new DreamOutcomes();
    const entry = outcomes.defineOutcome('task-1', { description: 'Test', metrics: [], category: 'invalid' });
    assert.strictEqual(entry.category, 'task');
    assert.strictEqual(entry.criteria.category, 'task');
  });

  it('should default metric fields when missing', () => {
    const outcomes = new DreamOutcomes();
    const entry = outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'a' }],
    });
    assert.strictEqual(entry.criteria.metrics[0].name, 'a');
    assert.strictEqual(entry.criteria.metrics[0].target, 0);
    assert.strictEqual(entry.criteria.metrics[0].weight, 1);
  });
});

describe('DreamOutcomes - evaluateOutcome', () => {
  it('should evaluate outcome as achieved when score >= 0.8', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    const result = outcomes.evaluateOutcome('task-1', {
      metrics: [{ name: 'coverage', actual: 0.9 }],
    });
    assert.ok(result);
    assert.strictEqual(result.achieved, true);
    assert.strictEqual(result.score, 1);
    assert.strictEqual(result.taskId, 'task-1');
  });

  it('should evaluate outcome as missed when score < 0.8', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    const result = outcomes.evaluateOutcome('task-1', {
      metrics: [{ name: 'coverage', actual: 0.4 }],
    });
    assert.ok(result);
    assert.strictEqual(result.achieved, false);
    assert.strictEqual(result.score, 0.5);
  });

  it('should emit outcome-achieved/outcome-missed events', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.defineOutcome('task-2', {
      description: 'Test2',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });

    let achievedData = null;
    let missedData = null;
    outcomes.on('outcome-achieved', (data) => { achievedData = data; });
    outcomes.on('outcome-missed', (data) => { missedData = data; });

    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });
    assert.ok(achievedData);
    assert.strictEqual(achievedData.achieved, true);

    outcomes.evaluateOutcome('task-2', { metrics: [{ name: 'coverage', actual: 0.4 }] });
    assert.ok(missedData);
    assert.strictEqual(missedData.achieved, false);
  });

  it('should emit outcome-evaluated event', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    let evalData = null;
    outcomes.on('outcome-evaluated', (data) => { evalData = data; });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });
    assert.ok(evalData);
    assert.strictEqual(evalData.taskId, 'task-1');
    assert.strictEqual(evalData.achieved, true);
  });

  it('should calculate weighted score correctly', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [
        { name: 'a', target: 10, weight: 3 },
        { name: 'b', target: 10, weight: 1 },
      ],
    });
    const result = outcomes.evaluateOutcome('task-1', {
      metrics: [{ name: 'a', actual: 10 }, { name: 'b', actual: 5 }],
    });
    assert.ok(result);
    assert.strictEqual(result.score, 0.875);
    assert.strictEqual(result.achieved, true);
    assert.strictEqual(result.details.length, 2);
    assert.strictEqual(result.details[0].achieved, true);
    assert.strictEqual(result.details[1].achieved, false);
  });

  it('should return null for unknown task', () => {
    const outcomes = new DreamOutcomes();
    const result = outcomes.evaluateOutcome('unknown', { metrics: [] });
    assert.strictEqual(result, null);
  });

  it('should return null for invalid actualResults', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', { description: 'Test', metrics: [] });
    assert.strictEqual(outcomes.evaluateOutcome('task-1', null), null);
    assert.strictEqual(outcomes.evaluateOutcome('task-1', 'invalid'), null);
  });

  it('should store evaluation result', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });
    assert.strictEqual(outcomes._evaluations.length, 1);
    assert.strictEqual(outcomes._evaluations[0].taskId, 'task-1');
  });

  it('should handle metrics with target 0', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'errors', target: 0, weight: 1 }],
    });
    const result = outcomes.evaluateOutcome('task-1', {
      metrics: [{ name: 'errors', actual: 0 }],
    });
    assert.ok(result);
    assert.strictEqual(result.score, 1);
    assert.strictEqual(result.achieved, true);
  });

  it('should handle missing actual metrics gracefully', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    const result = outcomes.evaluateOutcome('task-1', { metrics: [] });
    assert.ok(result);
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.achieved, false);
  });
});

describe('DreamOutcomes - getEvaluation / getRecentEvaluations', () => {
  it('should retrieve evaluation by taskId', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });
    const evaluation = outcomes.getEvaluation('task-1');
    assert.ok(evaluation);
    assert.strictEqual(evaluation.taskId, 'task-1');
    assert.strictEqual(evaluation.achieved, true);
  });

  it('should return null for unknown taskId', () => {
    const outcomes = new DreamOutcomes();
    assert.strictEqual(outcomes.getEvaluation('unknown'), null);
  });

  it('should retrieve the most recent evaluation for a taskId', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.4 }] });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });
    const evaluation = outcomes.getEvaluation('task-1');
    assert.ok(evaluation);
    assert.strictEqual(evaluation.achieved, true);
  });

  it('should retrieve recent evaluations with limit', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.5 }] });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.7 }] });

    const recent = outcomes.getRecentEvaluations(2);
    assert.strictEqual(recent.length, 2);
  });

  it('should default limit to 10', () => {
    const outcomes = new DreamOutcomes();
    const recent = outcomes.getRecentEvaluations();
    assert.ok(Array.isArray(recent));
    assert.strictEqual(recent.length, 0);
  });

  it('should return recent evaluations in reverse order', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.5 }] });

    const recent = outcomes.getRecentEvaluations(10);
    assert.strictEqual(recent[0].achieved, false);
    assert.strictEqual(recent[1].achieved, true);
  });
});

describe('DreamOutcomes - Note Effectiveness', () => {
  it('should record note usage', () => {
    const outcomes = new DreamOutcomes();
    outcomes.recordNoteUsage('note-1', 'debugging');
    const effectiveness = outcomes.getNoteEffectiveness('note-1');
    assert.ok(effectiveness);
    assert.strictEqual(effectiveness.uses, 1);
    assert.ok(effectiveness.lastUsedAt);
  });

  it('should record note outcome (effective/ineffective)', () => {
    const outcomes = new DreamOutcomes();
    outcomes.recordNoteUsage('note-1', 'debugging');
    outcomes.recordNoteOutcome('note-1', true);
    outcomes.recordNoteOutcome('note-1', false);
    const effectiveness = outcomes.getNoteEffectiveness('note-1');
    assert.ok(effectiveness);
    assert.strictEqual(effectiveness.effective, 1);
    assert.strictEqual(effectiveness.ineffective, 1);
    assert.strictEqual(effectiveness.effectivenessRate, 0.5);
  });

  it('should calculate note effectiveness', () => {
    const outcomes = new DreamOutcomes();
    outcomes.recordNoteUsage('note-1');
    outcomes.recordNoteOutcome('note-1', true);
    outcomes.recordNoteOutcome('note-1', true);
    outcomes.recordNoteOutcome('note-1', false);
    const effectiveness = outcomes.getNoteEffectiveness('note-1');
    assert.ok(effectiveness);
    assert.strictEqual(effectiveness.effective, 2);
    assert.strictEqual(effectiveness.ineffective, 1);
    assert.strictEqual(effectiveness.effectivenessRate, roundTo(2 / 3, 4));
  });

  it('should identify low effectiveness notes', () => {
    const outcomes = new DreamOutcomes();
    outcomes.recordNoteUsage('note-good');
    outcomes.recordNoteOutcome('note-good', true);
    outcomes.recordNoteOutcome('note-good', true);

    outcomes.recordNoteUsage('note-bad');
    outcomes.recordNoteOutcome('note-bad', false);
    outcomes.recordNoteOutcome('note-bad', false);

    const low = outcomes.getLowEffectivenessNotes(0.5);
    assert.strictEqual(low.length, 1);
    assert.strictEqual(low[0].noteId, 'note-bad');
    assert.strictEqual(low[0].effectivenessRate, 0);
  });

  it('should return null for unknown note effectiveness', () => {
    const outcomes = new DreamOutcomes();
    assert.strictEqual(outcomes.getNoteEffectiveness('unknown'), null);
  });

  it('should emit note-usage-recorded and note-outcome-recorded events', () => {
    const outcomes = new DreamOutcomes();
    let usageData = null;
    let outcomeData = null;
    outcomes.on('note-usage-recorded', (data) => { usageData = data; });
    outcomes.on('note-outcome-recorded', (data) => { outcomeData = data; });

    outcomes.recordNoteUsage('note-1', 'context');
    assert.ok(usageData);
    assert.strictEqual(usageData.noteId, 'note-1');
    assert.strictEqual(usageData.context, 'context');
    assert.strictEqual(usageData.uses, 1);

    outcomes.recordNoteOutcome('note-1', true);
    assert.ok(outcomeData);
    assert.strictEqual(outcomeData.noteId, 'note-1');
    assert.strictEqual(outcomeData.effective, true);
  });

  it('should ignore invalid noteId for recordNoteUsage', () => {
    const outcomes = new DreamOutcomes();
    outcomes.recordNoteUsage('', 'ctx');
    outcomes.recordNoteUsage(null, 'ctx');
    outcomes.recordNoteUsage(123, 'ctx');
    assert.strictEqual(outcomes._noteUsage.size, 0);
  });

  it('should ignore invalid noteId for recordNoteOutcome', () => {
    const outcomes = new DreamOutcomes();
    outcomes.recordNoteOutcome('', true);
    outcomes.recordNoteOutcome(null, true);
    assert.strictEqual(outcomes._noteUsage.size, 0);
  });

  it('should create entry when recordNoteOutcome called without prior usage', () => {
    const outcomes = new DreamOutcomes();
    outcomes.recordNoteOutcome('note-1', true);
    const effectiveness = outcomes.getNoteEffectiveness('note-1');
    assert.ok(effectiveness);
    assert.strictEqual(effectiveness.effective, 1);
    assert.strictEqual(effectiveness.uses, 0);
  });

  it('should default threshold to 0.3 for getLowEffectivenessNotes', () => {
    const outcomes = new DreamOutcomes();
    outcomes.recordNoteOutcome('note-1', false);
    outcomes.recordNoteOutcome('note-1', false);
    outcomes.recordNoteOutcome('note-1', false);
    const low = outcomes.getLowEffectivenessNotes();
    assert.strictEqual(low.length, 1);
    assert.strictEqual(low[0].noteId, 'note-1');
  });

  it('should skip notes with zero total outcomes in getLowEffectivenessNotes', () => {
    const outcomes = new DreamOutcomes();
    outcomes.recordNoteUsage('note-1');
    const low = outcomes.getLowEffectivenessNotes();
    assert.strictEqual(low.length, 0);
  });
});

describe('DreamOutcomes - syncToDreamEngine / syncToSkillImprovementLoop', () => {
  it('should sync evaluations to DreamEngine', async () => {
    const outcomes = new DreamOutcomes();
    let dreamingCalled = false;
    let dreamingSessions = null;
    outcomes.attachDreamEngine({
      startDreaming(sessions) {
        dreamingCalled = true;
        dreamingSessions = sessions;
        return true;
      },
    });
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });

    const result = await outcomes.syncToDreamEngine();
    assert.strictEqual(result.synced, 1);
    assert.strictEqual(result.errors, 0);
    assert.strictEqual(dreamingCalled, true);
    assert.ok(dreamingSessions);
    assert.strictEqual(dreamingSessions.length, 1);
    assert.strictEqual(dreamingSessions[0].sessionId, 'task-1');
  });

  it('should sync evaluations to SkillImprovementLoop', () => {
    const outcomes = new DreamOutcomes();
    const learnings = [];
    outcomes.attachSkillImprovementLoop({
      recordLearning(entry) {
        learnings.push(entry);
        return { success: true };
      },
    });
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });

    const result = outcomes.syncToSkillImprovementLoop();
    assert.strictEqual(result.synced, 1);
    assert.strictEqual(result.errors, 0);
    assert.strictEqual(learnings.length, 1);
    assert.strictEqual(learnings[0].skillId, 'task-1');
    assert.strictEqual(learnings[0].score, 1);
  });

  it('should emit synced events', async () => {
    const outcomes = new DreamOutcomes();
    outcomes.attachDreamEngine({ startDreaming: () => true });
    outcomes.attachSkillImprovementLoop({ recordLearning: () => ({ success: true }) });
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });

    let dreamSyncData = null;
    let loopSyncData = null;
    outcomes.on('synced-to-dream-engine', (data) => { dreamSyncData = data; });
    outcomes.on('synced-to-improvement-loop', (data) => { loopSyncData = data; });

    await outcomes.syncToDreamEngine();
    assert.ok(dreamSyncData);
    assert.strictEqual(dreamSyncData.synced, 1);

    outcomes.syncToSkillImprovementLoop();
    assert.ok(loopSyncData);
    assert.strictEqual(loopSyncData.synced, 1);
  });

  it('should handle missing modules gracefully', async () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });

    const dreamResult = await outcomes.syncToDreamEngine();
    assert.deepStrictEqual(dreamResult, { synced: 0, errors: 0 });

    const loopResult = outcomes.syncToSkillImprovementLoop();
    assert.deepStrictEqual(loopResult, { synced: 0, errors: 0 });
  });

  it('should handle missing startDreaming method gracefully', async () => {
    const outcomes = new DreamOutcomes();
    outcomes.attachDreamEngine({});
    const result = await outcomes.syncToDreamEngine();
    assert.deepStrictEqual(result, { synced: 0, errors: 0 });
  });

  it('should handle missing recordLearning method gracefully', () => {
    const outcomes = new DreamOutcomes();
    outcomes.attachSkillImprovementLoop({});
    const result = outcomes.syncToSkillImprovementLoop();
    assert.deepStrictEqual(result, { synced: 0, errors: 0 });
  });

  it('should increment sync counters', async () => {
    const outcomes = new DreamOutcomes();
    outcomes.attachDreamEngine({ startDreaming: () => true });
    outcomes.attachSkillImprovementLoop({ recordLearning: () => ({ success: true }) });
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });

    await outcomes.syncToDreamEngine();
    await outcomes.syncToDreamEngine();
    outcomes.syncToSkillImprovementLoop();

    assert.strictEqual(outcomes._syncCounters.toDreamEngine, 2);
    assert.strictEqual(outcomes._syncCounters.toImprovementLoop, 1);
  });

  it('should count errors when recordLearning returns error', () => {
    const outcomes = new DreamOutcomes();
    outcomes.attachSkillImprovementLoop({
      recordLearning: () => ({ error: 'failed' }),
    });
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });

    const result = outcomes.syncToSkillImprovementLoop();
    assert.strictEqual(result.synced, 0);
    assert.strictEqual(result.errors, 1);
  });

  it('should count errors when startDreaming returns falsy', async () => {
    const outcomes = new DreamOutcomes();
    outcomes.attachDreamEngine({ startDreaming: () => false });
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });

    const result = await outcomes.syncToDreamEngine();
    assert.strictEqual(result.synced, 0);
    assert.strictEqual(result.errors, 1);
  });
});

describe('DreamOutcomes - isHealthy / getStats / shutdown', () => {
  it('should be healthy with few evaluations', () => {
    const outcomes = new DreamOutcomes();
    assert.strictEqual(outcomes.isHealthy(), true);
  });

  it('should return correct stats', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });
    outcomes.recordNoteUsage('note-1');

    const stats = outcomes.getStats();
    assert.strictEqual(stats.outcomesDefined, 1);
    assert.strictEqual(stats.evaluationsTotal, 1);
    assert.strictEqual(stats.evaluationsAchieved, 1);
    assert.strictEqual(stats.achievementRate, 1);
    assert.strictEqual(stats.noteEffectivenessTracked, 1);
    assert.strictEqual(stats.syncedToDreamEngine, 0);
    assert.strictEqual(stats.syncedToImprovementLoop, 0);
  });

  it('should calculate achievementRate correctly', () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.9 }] });
    outcomes.evaluateOutcome('task-1', { metrics: [{ name: 'coverage', actual: 0.4 }] });

    const stats = outcomes.getStats();
    assert.strictEqual(stats.evaluationsTotal, 2);
    assert.strictEqual(stats.evaluationsAchieved, 1);
    assert.strictEqual(stats.achievementRate, 0.5);
  });

  it('should prevent operations after shutdown', async () => {
    const outcomes = new DreamOutcomes();
    outcomes.defineOutcome('task-1', {
      description: 'Test',
      metrics: [{ name: 'coverage', target: 0.8, weight: 1 }],
    });
    outcomes.shutdown();

    assert.strictEqual(outcomes.isHealthy(), false);
    assert.strictEqual(outcomes.getOutcome('task-1'), null);
    assert.strictEqual(outcomes._outcomes.size, 0);
    assert.strictEqual(outcomes._evaluations.length, 0);
    assert.strictEqual(outcomes._noteUsage.size, 0);

    assert.throws(() => outcomes.defineOutcome('task-2', { description: 'Test', metrics: [] }), { code: 'SHUTDOWN' });
    assert.throws(() => outcomes.evaluateOutcome('task-1', { metrics: [] }), { code: 'SHUTDOWN' });
    assert.throws(() => outcomes.recordNoteUsage('note-1'), { code: 'SHUTDOWN' });
    assert.throws(() => outcomes.recordNoteOutcome('note-1', true), { code: 'SHUTDOWN' });
    await assert.rejects(() => outcomes.syncToDreamEngine(), { code: 'SHUTDOWN' });
    assert.throws(() => outcomes.syncToSkillImprovementLoop(), { code: 'SHUTDOWN' });
  });

  it('should clear attached modules on shutdown', () => {
    const outcomes = new DreamOutcomes();
    outcomes.attachDreamEngine({ startDreaming: () => true });
    outcomes.attachSkillImprovementLoop({ recordLearning: () => ({}) });
    outcomes.attachQualityScorer({});
    outcomes.shutdown();

    assert.strictEqual(outcomes._dreamEngine, null);
    assert.strictEqual(outcomes._skillImprovementLoop, null);
    assert.strictEqual(outcomes._qualityScorer, null);
  });
});

function roundTo(value, decimals) {
  if (!Number.isFinite(value)) return value;
  const shift = Math.pow(10, decimals);
  const shifted = value * shift;
  const rounded = Math.round(shifted);
  if (Math.abs(shifted - rounded) < 1e-10) {
    return rounded / shift;
  }
  return Number((value).toFixed(decimals));
}
