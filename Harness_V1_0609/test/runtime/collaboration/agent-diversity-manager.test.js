'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AgentDiversityManager } = require('../../../src/runtime/collaboration/agent-diversity-manager');

describe('AgentDiversityManager', () => {
  it('should register agent profiles', () => {
    const mgr = new AgentDiversityManager();
    mgr.registerAgent('a1', { role: 'analyst', capabilities: ['code', 'review'], perspective: 'technical' });
    const profile = mgr.getAgentProfile('a1');
    assert.equal(profile.role, 'analyst');
    assert.equal(profile.weight, 1.0);
  });

  it('should record outcomes and update weights', () => {
    const mgr = new AgentDiversityManager();
    mgr.registerAgent('a1', { role: 'worker' });
    mgr.recordOutcome('a1', { success: true, task: 't1' });
    mgr.recordOutcome('a1', { success: true, task: 't2' });
    mgr.recordOutcome('a1', { success: false, task: 't3' });
    assert.ok(mgr.getAgentWeight('a1') > 0.5);
  });

  it('should compute role diversity', () => {
    const mgr = new AgentDiversityManager();
    mgr.registerAgent('a1', { role: 'analyst' });
    mgr.registerAgent('a2', { role: 'worker' });
    mgr.registerAgent('a3', { role: 'analyst' });
    const div = mgr.computeDiversity(['a1', 'a2', 'a3']);
    assert.ok(div.metrics.role_diversity > 0);
    assert.ok(div.score > 0);
  });

  it('should detect low diversity', () => {
    const mgr = new AgentDiversityManager({ diversityThreshold: 0.5 });
    mgr.registerAgent('a1', { role: 'worker', capabilities: ['code'], perspective: 'same' });
    mgr.registerAgent('a2', { role: 'worker', capabilities: ['code'], perspective: 'same' });
    const div = mgr.computeDiversity(['a1', 'a2']);
    assert.equal(div.diverse, false);
  });

  it('should recommend boosting for low diversity', () => {
    const mgr = new AgentDiversityManager();
    mgr.registerAgent('a1', { role: 'worker', capabilities: ['code'] });
    mgr.registerAgent('a2', { role: 'worker', capabilities: ['code'] });
    const rec = mgr.getEnsembleRecommendation({ type: 'task' });
    assert.equal(rec.mode, 'boosting');
  });

  it('should recommend bagging for high diversity high performers', () => {
    const mgr = new AgentDiversityManager();
    mgr.registerAgent('a1', { role: 'analyst', capabilities: ['review'], perspective: 'tech' });
    mgr.registerAgent('a2', { role: 'worker', capabilities: ['code'], perspective: 'product' });
    mgr.registerAgent('a3', { role: 'qa', capabilities: ['test'], perspective: 'quality' });
    mgr.registerAgent('a4', { role: 'devops', capabilities: ['deploy'], perspective: 'ops' });
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      mgr.recordOutcome(id, { success: true, task: 't1' });
      mgr.recordOutcome(id, { success: true, task: 't2' });
    }
    const rec = mgr.getEnsembleRecommendation({ type: 'task' });
    assert.equal(rec.mode, 'bagging');
  });

  it('should handle single agent', () => {
    const mgr = new AgentDiversityManager();
    mgr.registerAgent('a1', { role: 'worker' });
    const div = mgr.computeDiversity(['a1']);
    assert.equal(div.score, 0);
  });

  it('should return null for unknown agent', () => {
    const mgr = new AgentDiversityManager();
    assert.equal(mgr.getAgentProfile('unknown'), null);
    assert.equal(mgr.getAgentWeight('unknown'), 1.0);
  });

  it('should track history', () => {
    const mgr = new AgentDiversityManager({ maxHistory: 2 });
    mgr.registerAgent('a1', { role: 'analyst' });
    mgr.registerAgent('a2', { role: 'worker' });
    mgr.computeDiversity(['a1', 'a2']);
    mgr.computeDiversity(['a1', 'a2']);
    mgr.computeDiversity(['a1', 'a2']);
    assert.equal(mgr.getHistory().length, 2);
  });
});
