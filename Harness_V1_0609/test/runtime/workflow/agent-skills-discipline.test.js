'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const ASDModule = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'agent-skills-discipline'));
const AgentSkillsDiscipline = ASDModule.AgentSkillsDiscipline || ASDModule;

describe('AgentSkillsDiscipline - Constructor', () => {
  it('should create instance with default config', () => {
    const asd = new AgentSkillsDiscipline();
    assert.ok(asd);
    assert.strictEqual(asd._config.strictOrder, true);
    assert.strictEqual(asd._config.allowRollback, true);
    assert.strictEqual(asd._config.requireCompletion, true);
  });

  it('should merge custom config with defaults', () => {
    const asd = new AgentSkillsDiscipline({ strictOrder: false });
    assert.strictEqual(asd._config.strictOrder, false);
    assert.strictEqual(asd._config.allowRollback, true);
  });

  it('should initialize with no current stage', () => {
    const asd = new AgentSkillsDiscipline();
    assert.strictEqual(asd._currentStage, null);
    assert.strictEqual(asd._completedStages.size, 0);
  });

  it('should expose STAGES and STAGE_COMMANDS', () => {
    assert.ok(AgentSkillsDiscipline.STAGES);
    assert.ok(AgentSkillsDiscipline.STAGE_COMMANDS);
    assert.strictEqual(AgentSkillsDiscipline.STAGES[0], 'spec');
    assert.strictEqual(AgentSkillsDiscipline.STAGE_COMMANDS.spec, '/spec');
  });
});

describe('AgentSkillsDiscipline - execute', () => {
  it('should execute spec stage as first stage', () => {
    const asd = new AgentSkillsDiscipline();
    const result = asd.execute('/spec', { requirements: ['test req'] });
    assert.strictEqual(result.stage, 'spec');
    assert.strictEqual(result.status, 'completed');
    assert.ok(result.output);
  });

  it('should reject non-spec as first stage', () => {
    const asd = new AgentSkillsDiscipline();
    const result = asd.execute('/plan', { spec: 'test' });
    assert.strictEqual(result.status, 'rejected');
  });

  it('should reject unknown command', () => {
    const asd = new AgentSkillsDiscipline();
    const result = asd.execute('/unknown', {});
    assert.strictEqual(result.stage, null);
    assert.strictEqual(result.status, 'rejected');
  });

  it('should advance through stages sequentially', () => {
    const asd = new AgentSkillsDiscipline();
    asd.execute('/spec', { requirements: ['r1'] });
    asd.execute('/plan', { spec: 's1' });
    asd.execute('/design', { plan: 'p1' });
    assert.strictEqual(asd._currentStage, 'design');
    assert.strictEqual(asd._completedStages.size, 3);
  });

  it('should accept stage name as command', () => {
    const asd = new AgentSkillsDiscipline();
    const result = asd.execute('spec', { requirements: ['r1'] });
    assert.strictEqual(result.stage, 'spec');
    assert.strictEqual(result.status, 'completed');
  });

  it('should reject skipping stages in strict mode', () => {
    const asd = new AgentSkillsDiscipline({ strictOrder: true, requireCompletion: true });
    asd.execute('/spec', { requirements: ['r1'] });
    const result = asd.execute('/design', { plan: 'p1' });
    assert.strictEqual(result.status, 'rejected');
  });

  it('should emit stage-completed event', () => {
    const asd = new AgentSkillsDiscipline();
    let emitted = false;
    asd.on('stage-completed', () => { emitted = true; });
    asd.execute('/spec', { requirements: ['r1'] });
    assert.strictEqual(emitted, true);
  });

  it('should return nextStage in result', () => {
    const asd = new AgentSkillsDiscipline();
    const result = asd.execute('/spec', { requirements: ['r1'] });
    assert.strictEqual(result.nextStage, 'plan');
  });

  it('should return null nextStage for last stage', () => {
    const asd = new AgentSkillsDiscipline();
    asd.execute('/spec', { requirements: ['r1'] });
    asd.execute('/plan', { spec: 's1' });
    asd.execute('/design', { plan: 'p1' });
    asd.execute('/build', { design: 'd1' });
    asd.execute('/test', { build: 'b1' });
    asd.execute('/review', { code: 'c1' });
    const result = asd.execute('/ship', { reviewPassed: true });
    assert.strictEqual(result.nextStage, null);
  });
});

describe('AgentSkillsDiscipline - rollback', () => {
  it('should allow rollback from review to build', () => {
    const asd = new AgentSkillsDiscipline();
    asd.execute('/spec', { requirements: ['r1'] });
    asd.execute('/plan', { spec: 's1' });
    asd.execute('/design', { plan: 'p1' });
    asd.execute('/build', { design: 'd1' });
    asd.execute('/test', { build: 'b1' });
    asd.execute('/review', { code: 'c1' });
    const result = asd.execute('/build', { design: 'd1' });
    assert.strictEqual(result.status, 'completed');
  });

  it('should reject rollback when not allowed', () => {
    const asd = new AgentSkillsDiscipline({ allowRollback: false });
    asd.execute('/spec', { requirements: ['r1'] });
    asd.execute('/plan', { spec: 's1' });
    const result = asd.execute('/spec', { requirements: ['r1'] });
    assert.strictEqual(result.status, 'rejected');
  });

  it('should reject rollback to non-allowed stage', () => {
    const asd = new AgentSkillsDiscipline();
    asd.execute('/spec', { requirements: ['r1'] });
    asd.execute('/plan', { spec: 's1' });
    asd.execute('/design', { plan: 'p1' });
    const result = asd.execute('/spec', { requirements: ['r1'] });
    assert.strictEqual(result.status, 'rejected');
  });
});

describe('AgentSkillsDiscipline - stage validation', () => {
  it('should complete spec with null output when validation fails', () => {
    const asd = new AgentSkillsDiscipline();
    const result = asd.execute('/spec', {});
    assert.strictEqual(result.stage, 'spec');
    assert.strictEqual(result.output, null);
  });

  it('should complete plan with null output without spec reference', () => {
    const asd = new AgentSkillsDiscipline();
    asd.execute('/spec', { requirements: ['r1'] });
    const result = asd.execute('/plan', {});
    assert.strictEqual(result.output, null);
  });

  it('should emit stage-validation-failed event', () => {
    const asd = new AgentSkillsDiscipline();
    let emitted = false;
    asd.on('stage-validation-failed', () => { emitted = true; });
    asd.execute('/spec', {});
    assert.strictEqual(emitted, true);
  });
});

describe('AgentSkillsDiscipline - canAdvanceTo', () => {
  it('should return true for spec as first stage', () => {
    const asd = new AgentSkillsDiscipline();
    assert.strictEqual(asd.canAdvanceTo('spec'), true);
  });

  it('should return false for non-first stage initially', () => {
    const asd = new AgentSkillsDiscipline();
    assert.strictEqual(asd.canAdvanceTo('plan'), false);
  });

  it('should return false for invalid stage', () => {
    const asd = new AgentSkillsDiscipline();
    assert.strictEqual(asd.canAdvanceTo('invalid'), false);
  });

  it('should return false for null stage', () => {
    const asd = new AgentSkillsDiscipline();
    assert.strictEqual(asd.canAdvanceTo(null), false);
  });
});

describe('AgentSkillsDiscipline - getState', () => {
  it('should return current state', () => {
    const asd = new AgentSkillsDiscipline();
    asd.execute('/spec', { requirements: ['r1'] });
    const state = asd.getState();
    assert.strictEqual(state.currentStage, 'spec');
    assert.deepStrictEqual(state.completedStages, ['spec']);
    assert.ok(state.stageResults);
    assert.ok(state.transitionLog);
    assert.ok(state.config);
  });
});

describe('AgentSkillsDiscipline - reset', () => {
  it('should reset all state', () => {
    const asd = new AgentSkillsDiscipline();
    asd.execute('/spec', { requirements: ['r1'] });
    asd.reset();
    assert.strictEqual(asd._currentStage, null);
    assert.strictEqual(asd._completedStages.size, 0);
    assert.strictEqual(asd._stageResults.size, 0);
  });

  it('should emit discipline-reset event', () => {
    const asd = new AgentSkillsDiscipline();
    let emitted = false;
    asd.on('discipline-reset', () => { emitted = true; });
    asd.reset();
    assert.strictEqual(emitted, true);
  });
});

describe('AgentSkillsDiscipline - getStats', () => {
  it('should return stats object', () => {
    const asd = new AgentSkillsDiscipline();
    const stats = asd.getStats();
    assert.strictEqual(stats.totalStages, 7);
    assert.strictEqual(stats.completedStages, 0);
    assert.strictEqual(stats.currentStage, null);
    assert.strictEqual(stats.progress, 0);
    assert.ok(stats.config);
  });

  it('should reflect progress', () => {
    const asd = new AgentSkillsDiscipline();
    asd.execute('/spec', { requirements: ['r1'] });
    const stats = asd.getStats();
    assert.strictEqual(stats.completedStages, 1);
    assert.strictEqual(stats.currentStage, 'spec');
    assert.ok(stats.progress > 0);
  });
});

describe('AgentSkillsDiscipline - shutdown', () => {
  it('should clear all state on shutdown', () => {
    const asd = new AgentSkillsDiscipline();
    asd.execute('/spec', { requirements: ['r1'] });
    asd.shutdown();
    assert.strictEqual(asd._currentStage, null);
    assert.strictEqual(asd._completedStages.size, 0);
    assert.strictEqual(asd._shutDown, true);
  });

  it('should prevent operations after shutdown', () => {
    const asd = new AgentSkillsDiscipline();
    asd.shutdown();
    assert.throws(() => asd.execute('/spec', { requirements: ['r1'] }), /shut down/i);
  });
});
