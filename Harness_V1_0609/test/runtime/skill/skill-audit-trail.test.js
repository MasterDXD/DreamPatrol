'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..', '..');
const SkillAuditTrail = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-audit-trail'));

const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  }
});

function createTempProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-trail-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}

describe('SkillAuditTrail - Constructor', () => {
  it('should create instance with default values', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    assert.ok(trail);
    assert.strictEqual(trail._entries.length, 0);
    assert.strictEqual(trail._graph, null);
    assert.strictEqual(trail._router, null);
    assert.strictEqual(trail._maxEntries, 5000);
  });

  it('should accept custom maxEntries', () => {
    const trail = new SkillAuditTrail({ projectRoot: '', maxEntries: 100 });
    assert.strictEqual(trail._maxEntries, 100);
  });

  it('should initialize persister when projectRoot is provided', () => {
    const projectRoot = createTempProjectRoot();
    const trail = new SkillAuditTrail({ projectRoot });
    assert.ok(trail._persister);
  });

  it('should not initialize persister when projectRoot is empty', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    assert.strictEqual(trail._persister, null);
  });
});

describe('SkillAuditTrail - recordChange', () => {
  it('should record a change entry', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    const record = trail.recordChange({
      skillId: 'brainstorming',
      action: 'created',
      actor: 'system',
      details: 'Initial creation',
    });
    assert.ok(record);
    assert.ok(record.id.startsWith('audit-'));
    assert.strictEqual(record.skillId, 'brainstorming');
    assert.strictEqual(record.action, 'created');
    assert.strictEqual(record.actor, 'system');
    assert.strictEqual(record.details, 'Initial creation');
    assert.strictEqual(typeof record.timestamp, 'number');
  });

  it('should emit change-recorded event', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    let emitted = null;
    trail.on('change-recorded', (data) => { emitted = data; });
    trail.recordChange({
      skillId: 'tdd-implement',
      action: 'modified',
      actor: 'agent',
    });
    assert.ok(emitted);
    assert.strictEqual(emitted.skillId, 'tdd-implement');
    assert.strictEqual(emitted.action, 'modified');
  });

  it('should reject invalid action', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    const result = trail.recordChange({
      skillId: 'test',
      action: 'invalid-action',
      actor: 'system',
    });
    assert.strictEqual(result, null);
    assert.strictEqual(trail._entries.length, 0);
  });

  it('should reject invalid actor', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    const result = trail.recordChange({
      skillId: 'test',
      action: 'created',
      actor: 'invalid-actor',
    });
    assert.strictEqual(result, null);
    assert.strictEqual(trail._entries.length, 0);
  });

  it('should reject null entry', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    assert.strictEqual(trail.recordChange(null), null);
  });

  it('should reject entry without skillId', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    assert.strictEqual(trail.recordChange({ action: 'created', actor: 'system' }), null);
  });

  it('should reject entry with non-string skillId', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    assert.strictEqual(trail.recordChange({ skillId: 123, action: 'created', actor: 'system' }), null);
  });

  it('should auto-generate id and timestamp', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    const before = Date.now();
    const record = trail.recordChange({
      skillId: 'test',
      action: 'created',
      actor: 'user',
    });
    const afterTs = Date.now();
    assert.ok(record.id);
    assert.ok(record.timestamp >= before);
    assert.ok(record.timestamp <= afterTs);
  });

  it('should store before and after values', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    const record = trail.recordChange({
      skillId: 'test',
      action: 'modified',
      actor: 'agent',
      before: { version: 1 },
      after: { version: 2 },
    });
    assert.deepStrictEqual(record.before, { version: 1 });
    assert.deepStrictEqual(record.after, { version: 2 });
  });

  it('should default before and after to null', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    const record = trail.recordChange({
      skillId: 'test',
      action: 'created',
      actor: 'system',
    });
    assert.strictEqual(record.before, null);
    assert.strictEqual(record.after, null);
  });

  it('should respect maxEntries limit', () => {
    const trail = new SkillAuditTrail({ projectRoot: '', maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      trail.recordChange({
        skillId: 'skill-' + i,
        action: 'created',
        actor: 'system',
      });
    }
    assert.strictEqual(trail._entries.length, 3);
    assert.strictEqual(trail._entries[0].skillId, 'skill-2');
  });
});

describe('SkillAuditTrail - getHistory', () => {
  it('should return history for a skill', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-b', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-a', action: 'modified', actor: 'agent' });
    const history = trail.getHistory('skill-a');
    assert.strictEqual(history.length, 2);
  });

  it('should filter by action', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-a', action: 'modified', actor: 'agent' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'user' });
    const history = trail.getHistory('skill-a', { action: 'created' });
    assert.strictEqual(history.length, 2);
  });

  it('should filter by actor', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-a', action: 'modified', actor: 'agent' });
    const history = trail.getHistory('skill-a', { actor: 'agent' });
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].actor, 'agent');
  });

  it('should filter by time range (since/until)', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail._entries[0].timestamp = 1000;
    trail.recordChange({ skillId: 'skill-a', action: 'modified', actor: 'agent' });
    trail._entries[1].timestamp = 2000;
    const history = trail.getHistory('skill-a', { since: 1500 });
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].action, 'modified');
  });

  it('should respect limit', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    for (let i = 0; i < 10; i++) {
      trail.recordChange({ skillId: 'skill-a', action: 'modified', actor: 'agent' });
    }
    const history = trail.getHistory('skill-a', { limit: 3 });
    assert.strictEqual(history.length, 3);
  });

  it('should return empty array for unknown skillId', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    const history = trail.getHistory('unknown');
    assert.deepStrictEqual(history, []);
  });

  it('should return empty array for invalid skillId', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    assert.deepStrictEqual(trail.getHistory(''), []);
    assert.deepStrictEqual(trail.getHistory(null), []);
  });

  it('should return results in reverse chronological order', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-a', action: 'modified', actor: 'agent' });
    const history = trail.getHistory('skill-a');
    assert.strictEqual(history[0].action, 'modified');
    assert.strictEqual(history[1].action, 'created');
  });
});

describe('SkillAuditTrail - getRecentChanges / getChangesByActor / getChangesByAction', () => {
  it('should return recent changes', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-b', action: 'modified', actor: 'agent' });
    trail.recordChange({ skillId: 'skill-c', action: 'deleted', actor: 'user' });
    const recent = trail.getRecentChanges(2);
    assert.strictEqual(recent.length, 2);
    assert.strictEqual(recent[0].skillId, 'skill-c');
  });

  it('should return default 50 recent changes', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    for (let i = 0; i < 60; i++) {
      trail.recordChange({ skillId: 'skill-' + i, action: 'created', actor: 'system' });
    }
    const recent = trail.getRecentChanges();
    assert.strictEqual(recent.length, 50);
  });

  it('should filter by actor', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-b', action: 'modified', actor: 'agent' });
    trail.recordChange({ skillId: 'skill-c', action: 'deleted', actor: 'agent' });
    const changes = trail.getChangesByActor('agent');
    assert.strictEqual(changes.length, 2);
  });

  it('should return empty for invalid actor', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    assert.deepStrictEqual(trail.getChangesByActor('invalid'), []);
    assert.deepStrictEqual(trail.getChangesByActor(''), []);
    assert.deepStrictEqual(trail.getChangesByActor(null), []);
  });

  it('should filter by action', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-b', action: 'modified', actor: 'agent' });
    trail.recordChange({ skillId: 'skill-c', action: 'created', actor: 'user' });
    const changes = trail.getChangesByAction('created');
    assert.strictEqual(changes.length, 2);
  });

  it('should return empty for invalid action', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    assert.deepStrictEqual(trail.getChangesByAction('invalid'), []);
    assert.deepStrictEqual(trail.getChangesByAction(''), []);
    assert.deepStrictEqual(trail.getChangesByAction(null), []);
  });

  it('should respect limit in getChangesByActor', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    for (let i = 0; i < 10; i++) {
      trail.recordChange({ skillId: 'skill-' + i, action: 'created', actor: 'agent' });
    }
    const changes = trail.getChangesByActor('agent', 3);
    assert.strictEqual(changes.length, 3);
  });

  it('should respect limit in getChangesByAction', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    for (let i = 0; i < 10; i++) {
      trail.recordChange({ skillId: 'skill-' + i, action: 'modified', actor: 'system' });
    }
    const changes = trail.getChangesByAction('modified', 3);
    assert.strictEqual(changes.length, 3);
  });
});

describe('SkillAuditTrail - getChangeCount', () => {
  it('should return total count', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-b', action: 'modified', actor: 'agent' });
    assert.strictEqual(trail.getChangeCount(), 2);
  });

  it('should return count for specific skill', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-a', action: 'modified', actor: 'agent' });
    trail.recordChange({ skillId: 'skill-b', action: 'created', actor: 'system' });
    assert.strictEqual(trail.getChangeCount('skill-a'), 2);
    assert.strictEqual(trail.getChangeCount('skill-b'), 1);
  });

  it('should return 0 for unknown skill', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    assert.strictEqual(trail.getChangeCount('unknown'), 0);
  });
});

describe('SkillAuditTrail - getImpactAnalysis', () => {
  it('should return low risk for rarely changed skill', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'stable-skill', action: 'created', actor: 'system' });
    const analysis = trail.getImpactAnalysis('stable-skill');
    assert.strictEqual(analysis.skillId, 'stable-skill');
    assert.strictEqual(analysis.changeCount, 1);
    assert.strictEqual(analysis.riskLevel, 'low');
    assert.ok(analysis.lastChange);
    assert.deepStrictEqual(analysis.dependents, []);
  });

  it('should return medium risk for moderately changed skill', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    for (let i = 0; i < 7; i++) {
      trail.recordChange({ skillId: 'moderate-skill', action: 'modified', actor: 'agent' });
    }
    const analysis = trail.getImpactAnalysis('moderate-skill');
    assert.strictEqual(analysis.riskLevel, 'medium');
  });

  it('should return high risk for frequently changed skill', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    for (let i = 0; i < 12; i++) {
      trail.recordChange({ skillId: 'volatile-skill', action: 'modified', actor: 'agent' });
    }
    const analysis = trail.getImpactAnalysis('volatile-skill');
    assert.strictEqual(analysis.riskLevel, 'high');
  });

  it('should return low risk for skill with no changes', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    const analysis = trail.getImpactAnalysis('no-changes');
    assert.strictEqual(analysis.changeCount, 0);
    assert.strictEqual(analysis.riskLevel, 'low');
    assert.strictEqual(analysis.lastChange, null);
  });

  it('should include dependents from graph', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.attachSkillGraph({
      getDependents: (_skillId) => ['dep-a', 'dep-b'],
    });
    trail.recordChange({ skillId: 'test-skill', action: 'created', actor: 'system' });
    const analysis = trail.getImpactAnalysis('test-skill');
    assert.deepStrictEqual(analysis.dependents, ['dep-a', 'dep-b']);
  });

  it('should handle graph getDependents failure gracefully', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.attachSkillGraph({
      getDependents: () => { throw new Error('graph error'); },
    });
    trail.recordChange({ skillId: 'test-skill', action: 'created', actor: 'system' });
    const analysis = trail.getImpactAnalysis('test-skill');
    assert.deepStrictEqual(analysis.dependents, []);
  });

  it('should return medium risk for core skill with any changes', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.attachSkillRouter({
      skills: [{ skill_id: 'core-skill', phase: 'brainstorming' }],
    });
    trail.recordChange({ skillId: 'core-skill', action: 'modified', actor: 'agent' });
    const analysis = trail.getImpactAnalysis('core-skill');
    assert.strictEqual(analysis.riskLevel, 'medium');
  });

  it('should return high risk for core skill with moderate changes', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.attachSkillRouter({
      skills: [{ skill_id: 'core-skill', phase: 'requirement-analysis' }],
    });
    for (let i = 0; i < 7; i++) {
      trail.recordChange({ skillId: 'core-skill', action: 'modified', actor: 'agent' });
    }
    const analysis = trail.getImpactAnalysis('core-skill');
    assert.strictEqual(analysis.riskLevel, 'high');
  });

  it('should handle invalid skillId', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    const analysis = trail.getImpactAnalysis('');
    assert.strictEqual(analysis.skillId, '');
    assert.strictEqual(analysis.changeCount, 0);
    assert.strictEqual(analysis.riskLevel, 'low');
  });
});

describe('SkillAuditTrail - generateAuditReport', () => {
  it('should generate report with correct structure', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-b', action: 'modified', actor: 'agent' });
    trail.recordChange({ skillId: 'skill-a', action: 'modified', actor: 'user' });
    const report = trail.generateAuditReport();
    assert.ok(report.period);
    assert.strictEqual(report.period.since, null);
    assert.strictEqual(report.period.until, null);
    assert.strictEqual(report.totalChanges, 3);
    assert.strictEqual(report.byAction.created, 1);
    assert.strictEqual(report.byAction.modified, 2);
    assert.strictEqual(report.byActor.system, 1);
    assert.strictEqual(report.byActor.agent, 1);
    assert.strictEqual(report.byActor.user, 1);
    assert.ok(report.topChangedSkills);
    assert.strictEqual(report.topChangedSkills[0].skillId, 'skill-a');
    assert.strictEqual(report.topChangedSkills[0].changeCount, 2);
    assert.deepStrictEqual(report.highRiskSkills, []);
    assert.deepStrictEqual(report.impactSummaries, []);
  });

  it('should include impact analysis when requested', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    for (let i = 0; i < 12; i++) {
      trail.recordChange({ skillId: 'volatile-skill', action: 'modified', actor: 'agent' });
    }
    const report = trail.generateAuditReport({ includeImpact: true });
    assert.strictEqual(report.impactSummaries.length, 1);
    assert.strictEqual(report.impactSummaries[0].skillId, 'volatile-skill');
    assert.strictEqual(report.highRiskSkills.length, 1);
    assert.strictEqual(report.highRiskSkills[0].riskLevel, 'high');
  });

  it('should filter by time range', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail._entries[0].timestamp = 1000;
    trail.recordChange({ skillId: 'skill-b', action: 'modified', actor: 'agent' });
    trail._entries[1].timestamp = 2000;
    const report = trail.generateAuditReport({ since: 1500 });
    assert.strictEqual(report.totalChanges, 1);
    assert.strictEqual(report.period.since, 1500);
  });

  it('should emit audit-report-generated event', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    let emitted = null;
    trail.on('audit-report-generated', (data) => { emitted = data; });
    trail.generateAuditReport();
    assert.ok(emitted);
    assert.strictEqual(emitted.totalChanges, 1);
  });

  it('should limit topChangedSkills to 10', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    for (let i = 0; i < 15; i++) {
      trail.recordChange({ skillId: 'skill-' + i, action: 'created', actor: 'system' });
    }
    const report = trail.generateAuditReport();
    assert.strictEqual(report.topChangedSkills.length, 10);
  });
});

describe('SkillAuditTrail - attachSkillGraph / attachSkillRouter', () => {
  it('should attach modules for chaining', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    const graph = { getDependents: () => [] };
    const router = { skills: [] };
    const result1 = trail.attachSkillGraph(graph);
    assert.strictEqual(result1, trail);
    assert.strictEqual(trail._graph, graph);
    const result2 = trail.attachSkillRouter(router);
    assert.strictEqual(result2, trail);
    assert.strictEqual(trail._router, router);
  });
});

describe('SkillAuditTrail - isHealthy / getStats / shutdown', () => {
  it('should be healthy with few entries', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    assert.strictEqual(trail.isHealthy(), true);
  });

  it('should return correct stats', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.recordChange({ skillId: 'skill-a', action: 'modified', actor: 'agent' });
    trail.recordChange({ skillId: 'skill-b', action: 'created', actor: 'user' });
    const stats = trail.getStats();
    assert.strictEqual(stats.totalEntries, 3);
    assert.strictEqual(stats.byAction.created, 2);
    assert.strictEqual(stats.byAction.modified, 1);
    assert.strictEqual(stats.byActor.system, 1);
    assert.strictEqual(stats.byActor.agent, 1);
    assert.strictEqual(stats.byActor.user, 1);
    assert.strictEqual(typeof stats.oldestEntry, 'number');
    assert.strictEqual(typeof stats.newestEntry, 'number');
  });

  it('should return null timestamps for empty entries', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    const stats = trail.getStats();
    assert.strictEqual(stats.totalEntries, 0);
    assert.strictEqual(stats.oldestEntry, null);
    assert.strictEqual(stats.newestEntry, null);
  });

  it('should flush on shutdown', () => {
    const projectRoot = createTempProjectRoot();
    const trail = new SkillAuditTrail({ projectRoot });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.shutdown();
    assert.strictEqual(trail._entries.length, 0);
    assert.strictEqual(trail._graph, null);
    assert.strictEqual(trail._router, null);
    assert.strictEqual(trail._persister, null);
  });

  it('should be unhealthy after shutdown', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.shutdown();
    assert.strictEqual(trail.isHealthy(), false);
  });

  it('should handle shutdown without persister', () => {
    const trail = new SkillAuditTrail({ projectRoot: '' });
    trail.recordChange({ skillId: 'skill-a', action: 'created', actor: 'system' });
    trail.shutdown();
    assert.strictEqual(trail._entries.length, 0);
  });
});
