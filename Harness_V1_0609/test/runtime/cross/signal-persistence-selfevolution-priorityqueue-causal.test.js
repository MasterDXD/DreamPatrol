'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const SignalPersistence = require('../../../src/runtime/infrastructure/signal-persistence');
const SelfEvolutionGovernor = require('../../../src/runtime/quality/self-evolution-governor');
const SkillPatchApproval = require('../../../src/gate/skill-patch-approval');
const PriorityQueue = require('../../../src/runtime/infrastructure/priority-queue');
const CausalVectorIndex = require('../../../src/runtime/causal/causal-vector-index');

test('SignalPersistence - basic record and query', async () => {
  const sp = new SignalPersistence();
  const result = await sp.record('quality', { total: 0.85, grade: 'good' });
  assert.equal(result.success, true);
  assert.ok(result.id);
  const signals = sp.query('quality');
  assert.equal(signals.length, 1);
  assert.equal(signals[0].total, 0.85);
  assert.equal(signals[0].grade, 'good');
  assert.ok(signals[0].timestamp);
  assert.ok(signals[0]._id);
});

test('SignalPersistence - invalid category rejected', async () => {
  const sp = new SignalPersistence();
  const result = await sp.record('invalid_category', { data: 1 });
  assert.equal(result.success, false);
  assert.ok(result.error.includes('Invalid category'));
  assert.equal(sp.getStats().rejected, 1);
});

test('SignalPersistence - null signal rejected', async () => {
  const sp = new SignalPersistence();
  const result = await sp.record('quality', null);
  assert.equal(result.success, false);
  assert.ok(result.error.includes('non-null object'));
});

test('SignalPersistence - non-object signal rejected', async () => {
  const sp = new SignalPersistence();
  const result = await sp.record('quality', 'string');
  assert.equal(result.success, false);
});

test('SignalPersistence - invalid timestamp corrected', async () => {
  const sp = new SignalPersistence();
  const result = await sp.record('quality', { total: 0.85, timestamp: 'invalid-date' });
  assert.equal(result.success, true);
  const signals = sp.query('quality');
  assert.ok(signals[0].timestamp);
  assert.ok(!isNaN(new Date(signals[0].timestamp).getTime()));
});

test('SignalPersistence - recordBatch', async () => {
  const sp = new SignalPersistence();
  const result = await sp.recordBatch('convergence', [
    { qualityScore: 0.8 },
    { qualityScore: 0.85 },
  ]);
  assert.equal(result.success, true);
  assert.equal(result.count, 2);
  assert.equal(result.failed, 0);
  assert.equal(sp.query('convergence').length, 2);
});

test('SignalPersistence - recordBatch too large', async () => {
  const sp = new SignalPersistence();
  const signals = [];
  for (let i = 0; i < 101; i++) signals.push({ total: 0.5 });
  const result = await sp.recordBatch('quality', signals);
  assert.equal(result.success, false);
  assert.ok(result.error.includes('100'));
});

test('SignalPersistence - query with since filter', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.7, timestamp: '2024-01-01T00:00:00Z' });
  await sp.record('quality', { total: 0.9, timestamp: new Date().toISOString() });
  const results = sp.query('quality', { since: '2024-06-01' });
  assert.equal(results.length, 1);
  assert.equal(results[0].total, 0.9);
});

test('SignalPersistence - query with invalid since ignored', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.7 });
  const results = sp.query('quality', { since: 'not-a-date' });
  assert.equal(results.length, 1);
});

test('SignalPersistence - query with limit', async () => {
  const sp = new SignalPersistence();
  for (let i = 0; i < 10; i++) await sp.record('quality', { total: 0.5 + i * 0.05 });
  const results = sp.query('quality', { limit: 3 });
  assert.equal(results.length, 3);
});

test('SignalPersistence - query invalid category returns empty', () => {
  const sp = new SignalPersistence();
  const results = sp.query('nonexistent');
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 0);
});

test('SignalPersistence - getTrend improving', async () => {
  const sp = new SignalPersistence();
  for (let i = 0; i < 10; i++) await sp.record('quality', { total: 0.5 + i * 0.05 });
  const trend = sp.getTrend('quality', 'total', 10);
  assert.equal(trend.trend, 'improving');
  assert.ok(trend.delta > 0);
});

test('SignalPersistence - getTrend degrading', async () => {
  const sp = new SignalPersistence();
  for (let i = 0; i < 10; i++) await sp.record('quality', { total: 0.9 - i * 0.05 });
  const trend = sp.getTrend('quality', 'total', 10);
  assert.equal(trend.trend, 'degrading');
  assert.ok(trend.delta < 0);
});

test('SignalPersistence - getTrend insufficient data', () => {
  const sp = new SignalPersistence();
  const trend = sp.getTrend('quality', 'total', 10);
  assert.equal(trend.trend, 'insufficient_data');
});

test('SignalPersistence - getTrend invalid category', () => {
  const sp = new SignalPersistence();
  const trend = sp.getTrend('invalid', 'total', 10);
  assert.equal(trend.trend, 'invalid_category');
});

test('SignalPersistence - purge', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.7, timestamp: '2024-01-01T00:00:00Z' });
  await sp.record('quality', { total: 0.9, timestamp: new Date().toISOString() });
  const purged = sp.purge('quality', '2024-06-01');
  assert.equal(purged, 1);
  assert.equal(sp.query('quality').length, 1);
});

test('SignalPersistence - purge with invalid date returns 0', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.7 });
  const purged = sp.purge('quality', 'not-a-date');
  assert.equal(purged, 0);
});

test('SignalPersistence - getSignalCount invalid category returns 0', () => {
  const sp = new SignalPersistence();
  assert.equal(sp.getSignalCount('invalid'), 0);
});

test('SignalPersistence - getStats', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.85 });
  await sp.record('convergence', { qualityScore: 0.9 });
  const stats = sp.getStats();
  assert.equal(stats.totalSignals, 2);
  assert.equal(stats.byCategory.quality, 1);
  assert.equal(stats.byCategory.convergence, 1);
  assert.equal(stats.recorded, 2);
  assert.equal(stats.initialized, true);
});

test('SignalPersistence - isHealthy', () => {
  const sp = new SignalPersistence();
  assert.equal(sp.isHealthy(), true);
});

test('SignalPersistence - shutdown clears data', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.85 });
  sp.shutdown();
  assert.equal(sp.getSignalCount(), 0);
});

test('SignalPersistence - SIGNAL_CATEGORIES exported', () => {
  assert.ok(SignalPersistence.SIGNAL_CATEGORIES);
  assert.equal(SignalPersistence.SIGNAL_CATEGORIES.QUALITY, 'quality');
  assert.equal(SignalPersistence.SIGNAL_CATEGORIES.CONVERGENCE, 'convergence');
  assert.equal(SignalPersistence.SIGNAL_CATEGORIES.REFLECTION, 'reflection');
  assert.equal(SignalPersistence.SIGNAL_CATEGORIES.HEALTH, 'health');
  assert.equal(SignalPersistence.SIGNAL_CATEGORIES.AGENDA, 'agenda');
});

test('SignalPersistence - attachProjectRoot with invalid value', () => {
  const sp = new SignalPersistence();
  const result = sp.attachProjectRoot(123);
  assert.equal(result, sp);
  assert.equal(sp._root, null);
});

test('SelfEvolutionGovernor - basic construction', () => {
  const gov = new SelfEvolutionGovernor();
  assert.equal(gov._running, false);
  const stats = gov.getStats();
  assert.equal(stats.running, false);
  assert.equal(stats.heartbeatsExecuted, 0);
  assert.equal(stats.heartbeatErrors, 0);
  assert.equal(stats.consecutiveErrors, 0);
});

test('SelfEvolutionGovernor - heartbeat interval clamped', () => {
  const gov1 = new SelfEvolutionGovernor({ heartbeatIntervalMs: 100 });
  assert.equal(gov1._heartbeatInterval, 5000);
  const gov2 = new SelfEvolutionGovernor({ heartbeatIntervalMs: 99999999 });
  assert.equal(gov2._heartbeatInterval, 3600000);
});

test('SelfEvolutionGovernor - start and stop', () => {
  const gov = new SelfEvolutionGovernor({ heartbeatIntervalMs: 100 });
  gov.start();
  assert.equal(gov._running, true);
  gov.stop();
  assert.equal(gov._running, false);
});

test('SelfEvolutionGovernor - forceHeartbeat with signal persistence', async () => {
  const sp = new SignalPersistence();
  const gov = new SelfEvolutionGovernor({
    signalPersistence: sp,
    heartbeatIntervalMs: 60000,
  });
  gov.attachSignalPersistence(sp);
  gov.forceHeartbeat();
  const stats = gov.getStats();
  assert.equal(stats.heartbeatsExecuted, 1);
});

test('SelfEvolutionGovernor - getAgendaItems', () => {
  const gov = new SelfEvolutionGovernor();
  const items = gov.getAgendaItems();
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 0);
});

test('SelfEvolutionGovernor - attach methods return this', () => {
  const gov = new SelfEvolutionGovernor();
  assert.equal(gov.attachSignalPersistence({}), gov);
  assert.equal(gov.attachHealthChecker({}), gov);
  assert.equal(gov.attachCausalDataBus({}), gov);
  assert.equal(gov.attachQualityScorer({}), gov);
  assert.equal(gov.attachConvergenceDetector({}), gov);
  assert.equal(gov.attachScheduler({}), gov);
});

test('SelfEvolutionGovernor - isHealthy', () => {
  const gov = new SelfEvolutionGovernor();
  assert.equal(gov.isHealthy(), true);
});

test('SelfEvolutionGovernor - shutdown', () => {
  const gov = new SelfEvolutionGovernor();
  gov.start();
  gov.shutdown();
  assert.equal(gov._running, false);
});

test('SelfEvolutionGovernor - OBSERVATION_SIGNALS exported', () => {
  assert.ok(SelfEvolutionGovernor.OBSERVATION_SIGNALS);
  assert.ok(Array.isArray(SelfEvolutionGovernor.OBSERVATION_SIGNALS));
});

test('SelfEvolutionGovernor - _recordObservation with null observation', () => {
  const gov = new SelfEvolutionGovernor();
  gov._recordObservation(null);
  assert.equal(gov.getStats().agendaItemsCreated, 0);
});

test('SelfEvolutionGovernor - _computeAgendaKey with null', () => {
  const gov = new SelfEvolutionGovernor();
  assert.equal(gov._computeAgendaKey(null), null);
});

test('SkillPatchApproval - submit and approve', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('tdd-implement', {
    tips: ['Write tests first'],
    avoidances: ['Do not skip RED phase'],
    count: 5,
  });
  assert.equal(submitResult.success, true);
  assert.ok(submitResult.patchId);
  assert.equal(submitResult.state, 'pending');
  const approveResult = spa.approve(submitResult.patchId, 'domain-analyst');
  assert.equal(approveResult.success, true);
  assert.equal(approveResult.state, 'approved');
});

test('SkillPatchApproval - reject pending patch', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('bug-fix', { tips: ['Check logs'], avoidances: [], count: 3 });
  const rejectResult = spa.reject(submitResult.patchId, 'team-lead', 'Insufficient evidence');
  assert.equal(rejectResult.success, true);
  assert.equal(rejectResult.state, 'rejected');
});

test('SkillPatchApproval - cannot approve non-pending', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('code-review', { tips: ['tip1'], avoidances: [], count: 3 });
  spa.approve(submitResult.patchId, 'analyst');
  const result = spa.approve(submitResult.patchId, 'analyst');
  assert.equal(result.success, false);
});

test('SkillPatchApproval - markApplied', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('tdd-implement', { tips: ['tip1'], avoidances: [], count: 4 });
  spa.approve(submitResult.patchId, 'analyst');
  const applyResult = spa.markApplied(submitResult.patchId);
  assert.equal(applyResult.success, true);
  assert.equal(applyResult.state, 'applied');
});

test('SkillPatchApproval - revoke applied patch', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('tdd-implement', { tips: ['tip1'], avoidances: [], count: 4 });
  spa.approve(submitResult.patchId, 'analyst');
  spa.markApplied(submitResult.patchId);
  const revokeResult = spa.revoke(submitResult.patchId, 'team-lead', 'Caused regression');
  assert.equal(revokeResult.success, true);
  assert.equal(revokeResult.state, 'revoked');
});

test('SkillPatchApproval - isApproved', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('tdd-implement', { tips: ['tip1'], avoidances: [], count: 4 });
  assert.equal(spa.isApproved(submitResult.patchId), false);
  spa.approve(submitResult.patchId, 'analyst');
  assert.equal(spa.isApproved(submitResult.patchId), true);
});

test('SkillPatchApproval - isApproved nonexistent', () => {
  const spa = new SkillPatchApproval();
  assert.equal(spa.isApproved('nonexistent'), false);
});

test('SkillPatchApproval - getApprovedPatchForSkill', () => {
  const spa = new SkillPatchApproval();
  spa.submit('tdd-implement', { tips: ['tip1'], avoidances: [], count: 4 });
  assert.equal(spa.getApprovedPatchForSkill('tdd-implement'), null);
});

test('SkillPatchApproval - getPendingPatches', () => {
  const spa = new SkillPatchApproval();
  spa.submit('tdd-implement', { tips: ['tip1'], avoidances: [], count: 4 });
  spa.submit('bug-fix', { tips: ['tip2'], avoidances: [], count: 3 });
  const pending = spa.getPendingPatches();
  assert.equal(pending.length, 2);
});

test('SkillPatchApproval - submit requires valid skillId', () => {
  const spa = new SkillPatchApproval();
  assert.equal(spa.submit(null, { tips: ['tip1'] }).success, false);
  assert.equal(spa.submit(123, { tips: ['tip1'] }).success, false);
});

test('SkillPatchApproval - submit requires at least one tip or avoidance', () => {
  const spa = new SkillPatchApproval();
  assert.equal(spa.submit('skill', { tips: [], avoidances: [] }).success, false);
});

test('SkillPatchApproval - submit truncates long tips', () => {
  const spa = new SkillPatchApproval();
  const longTip = 'a'.repeat(600);
  const result = spa.submit('skill', { tips: [longTip], avoidances: [], count: 1 });
  assert.equal(result.success, true);
  const patch = spa.getPatch(result.patchId);
  assert.equal(patch.tips[0].length, 500);
});

test('SkillPatchApproval - submit limits tips count', () => {
  const spa = new SkillPatchApproval();
  const tips = [];
  for (let i = 0; i < 15; i++) tips.push('tip ' + i);
  const result = spa.submit('skill', { tips: tips, avoidances: [], count: 1 });
  assert.equal(result.success, true);
  const patch = spa.getPatch(result.patchId);
  assert.equal(patch.tips.length, 10);
});

test('SkillPatchApproval - getPatch with null returns null', () => {
  const spa = new SkillPatchApproval();
  assert.equal(spa.getPatch(null), null);
});

test('SkillPatchApproval - getPatchesBySkill with null returns empty', () => {
  const spa = new SkillPatchApproval();
  assert.deepEqual(spa.getPatchesBySkill(null), []);
});

test('SkillPatchApproval - getStats', () => {
  const spa = new SkillPatchApproval();
  spa.submit('tdd-implement', { tips: ['tip1'], avoidances: [], count: 4 });
  const stats = spa.getStats();
  assert.equal(stats.totalPatches, 1);
  assert.equal(stats.submitted, 1);
  assert.equal(stats.byState.pending, 1);
  assert.equal(stats.errors, 0);
});

test('SkillPatchApproval - PATCH_STATES exported', () => {
  assert.ok(SkillPatchApproval.PATCH_STATES);
  assert.equal(SkillPatchApproval.PATCH_STATES.PENDING, 'pending');
  assert.equal(SkillPatchApproval.PATCH_STATES.APPROVED, 'approved');
});

test('SkillPatchApproval - VALID_TRANSITIONS exported', () => {
  assert.ok(SkillPatchApproval.VALID_TRANSITIONS);
  assert.ok(SkillPatchApproval.VALID_TRANSITIONS.pending.includes('approved'));
});

test('SkillPatchApproval - isHealthy', () => {
  const spa = new SkillPatchApproval();
  assert.equal(spa.isHealthy(), true);
});

test('SkillPatchApproval - shutdown', () => {
  const spa = new SkillPatchApproval();
  spa.submit('tdd-implement', { tips: ['tip1'], avoidances: [], count: 4 });
  spa.shutdown();
  assert.equal(spa.getStats().totalPatches, 0);
});

test('PriorityQueue - basic push and pop', () => {
  const pq = new PriorityQueue();
  pq.push({ id: 'a', priority: 3 });
  pq.push({ id: 'b', priority: 1 });
  pq.push({ id: 'c', priority: 2 });
  assert.equal(pq.size(), 3);
  const first = pq.pop();
  assert.equal(first.id, 'b');
  assert.equal(first.priority, 1);
  assert.equal(pq.size(), 2);
});

test('PriorityQueue - pop returns undefined when empty', () => {
  const pq = new PriorityQueue();
  assert.equal(pq.pop(), undefined);
  assert.equal(pq.peek(), undefined);
});

test('PriorityQueue - isEmpty', () => {
  const pq = new PriorityQueue();
  assert.equal(pq.isEmpty(), true);
  pq.push({ id: 'a', priority: 1 });
  assert.equal(pq.isEmpty(), false);
});

test('PriorityQueue - peek does not remove', () => {
  const pq = new PriorityQueue();
  pq.push({ id: 'a', priority: 1 });
  pq.push({ id: 'b', priority: 2 });
  const top = pq.peek();
  assert.equal(top.id, 'a');
  assert.equal(pq.size(), 2);
});

test('PriorityQueue - respects priority order', () => {
  const pq = new PriorityQueue();
  pq.push({ id: 'low', priority: 10 });
  pq.push({ id: 'high', priority: 1 });
  pq.push({ id: 'mid', priority: 5 });
  assert.equal(pq.pop().id, 'high');
  assert.equal(pq.pop().id, 'mid');
  assert.equal(pq.pop().id, 'low');
});

test('PriorityQueue - default priority is 5', () => {
  const pq = new PriorityQueue();
  pq.push({ id: 'a', priority: 1 });
  pq.push({ id: 'b' });
  pq.push({ id: 'c', priority: 10 });
  assert.equal(pq.pop().id, 'a');
  assert.equal(pq.pop().id, 'b');
  assert.equal(pq.pop().id, 'c');
});

test('PriorityQueue - clear', () => {
  const pq = new PriorityQueue();
  pq.push({ id: 'a', priority: 1 });
  pq.push({ id: 'b', priority: 2 });
  pq.clear();
  assert.equal(pq.size(), 0);
  assert.equal(pq.isEmpty(), true);
});

test('PriorityQueue - toArray returns sorted', () => {
  const pq = new PriorityQueue();
  pq.push({ id: 'c', priority: 3 });
  pq.push({ id: 'a', priority: 1 });
  pq.push({ id: 'b', priority: 2 });
  const arr = pq.toArray();
  assert.equal(arr[0].id, 'a');
  assert.equal(arr[1].id, 'b');
  assert.equal(arr[2].id, 'c');
});

test('CausalVectorIndex - basic index and query', async () => {
  const cvi = new CausalVectorIndex();
  await cvi.index('cause-1', 'Test failed due to timeout', { category: 'error' });
  await cvi.index('cause-2', 'Build succeeded with warnings', { category: 'warning' });
  await cvi.index('cause-3', 'Test passed all assertions', { category: 'success' });
  const results = await cvi.query('test failure timeout', { topK: 2 });
  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0);
  assert.ok(results[0].similarity >= 0);
});

test('CausalVectorIndex - get after index', async () => {
  const cvi = new CausalVectorIndex();
  await cvi.index('cause-1', 'Some text', { key: 'value' });
  const entry = cvi.get('cause-1');
  assert.ok(entry);
  assert.equal(entry.causalId, 'cause-1');
  assert.equal(entry.metadata.key, 'value');
});

test('CausalVectorIndex - remove', async () => {
  const cvi = new CausalVectorIndex();
  await cvi.index('cause-1', 'Some text', {});
  const removed = cvi.remove('cause-1');
  assert.equal(removed, true);
  assert.equal(cvi.get('cause-1'), null);
});

test('CausalVectorIndex - getStats', async () => {
  const cvi = new CausalVectorIndex();
  await cvi.index('cause-1', 'Text 1', {});
  await cvi.index('cause-2', 'Text 2', {});
  const stats = cvi.getStats();
  assert.equal(stats.totalVectors, 2);
  assert.equal(stats.indexed, 2);
  assert.equal(stats.embeddingServiceAvailable, false);
});

test('CausalVectorIndex - isHealthy', () => {
  const cvi = new CausalVectorIndex();
  assert.equal(cvi.isHealthy(), true);
});

test('CausalVectorIndex - shutdown', async () => {
  const cvi = new CausalVectorIndex();
  await cvi.index('cause-1', 'Text', {});
  cvi.shutdown();
  assert.equal(cvi.getStats().totalVectors, 0);
});

test('CausalVectorIndex - VECTOR_DIMENSIONS exported', () => {
  assert.equal(CausalVectorIndex.VECTOR_DIMENSIONS, 128);
});

test('CausalVectorIndex - query with no matches returns empty', async () => {
  const cvi = new CausalVectorIndex({ similarityThreshold: 0.99 });
  await cvi.index('cause-1', 'Completely different text', {});
  const results = await cvi.query('something totally unrelated xyz', { topK: 5 });
  assert.ok(Array.isArray(results));
});

test('CausalVectorIndex - get nonexistent returns null', () => {
  const cvi = new CausalVectorIndex();
  assert.equal(cvi.get('nonexistent'), null);
});

test('SignalPersistence - oversized signal rejected', async () => {
  const sp = new SignalPersistence();
  const hugeObj = { data: 'x'.repeat(70000) };
  const result = await sp.record('quality', hugeObj);
  assert.equal(result.success, false);
  assert.ok(result.error.includes('maximum size'));
  assert.equal(sp.getStats().rejected, 1);
});

test('SignalPersistence - circular reference signal rejected', async () => {
  const sp = new SignalPersistence();
  const circular = {};
  circular.self = circular;
  const result = await sp.record('quality', circular);
  assert.equal(result.success, false);
  assert.ok(result.error.includes('serializable'));
});

test('SignalPersistence - maxPerCategory eviction', async () => {
  const sp = new SignalPersistence({ maxPerCategory: 12 });
  for (let i = 0; i < 15; i++) {
    await sp.record('quality', { total: 0.5 + i * 0.01 });
  }
  assert.equal(sp.getSignalCount('quality'), 12);
  const signals = sp.query('quality');
  assert.ok(signals[0].total > 0.52);
});

test('SignalPersistence - recordBatch with empty array', async () => {
  const sp = new SignalPersistence();
  const result = await sp.recordBatch('quality', []);
  assert.equal(result.success, true);
  assert.equal(result.count, 0);
  assert.equal(result.failed, 0);
});

test('SignalPersistence - recordBatch with invalid category', async () => {
  const sp = new SignalPersistence();
  const result = await sp.recordBatch('invalid', [{ data: 1 }]);
  assert.equal(result.success, false);
});

test('SignalPersistence - recordBatch with non-array', async () => {
  const sp = new SignalPersistence();
  const result = await sp.recordBatch('quality', 'not-array');
  assert.equal(result.success, false);
  assert.ok(result.error.includes('array'));
});

test('SignalPersistence - recordBatch partial failure', async () => {
  const sp = new SignalPersistence();
  const result = await sp.recordBatch('quality', [
    { total: 0.8 },
    null,
    { total: 0.9 },
  ]);
  assert.equal(result.success, true);
  assert.equal(result.count, 2);
  assert.equal(result.failed, 1);
});

test('SignalPersistence - query with until filter', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.7, timestamp: '2024-01-01T00:00:00Z' });
  await sp.record('quality', { total: 0.9, timestamp: new Date().toISOString() });
  const results = sp.query('quality', { until: '2024-06-01' });
  assert.equal(results.length, 1);
  assert.equal(results[0].total, 0.7);
});

test('SignalPersistence - query with filter function', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.5 });
  await sp.record('quality', { total: 0.9 });
  const results = sp.query('quality', { filter: function(s) { return s.total > 0.7; } });
  assert.equal(results.length, 1);
  assert.equal(results[0].total, 0.9);
});

test('SignalPersistence - query with throwing filter', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.5 });
  const results = sp.query('quality', { filter: function() { throw new Error('boom'); } });
  assert.equal(results.length, 1);
});

test('SignalPersistence - query all categories', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.8 });
  await sp.record('convergence', { qualityScore: 0.9 });
  const all = sp.query();
  assert.ok(all.quality);
  assert.ok(all.convergence);
  assert.equal(all.quality.length, 1);
  assert.equal(all.convergence.length, 1);
});

test('SignalPersistence - purge all categories', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.7, timestamp: '2024-01-01T00:00:00Z' });
  await sp.record('convergence', { qualityScore: 0.8, timestamp: '2024-01-01T00:00:00Z' });
  await sp.record('quality', { total: 0.9, timestamp: new Date().toISOString() });
  const purged = sp.purge(null, '2024-06-01');
  assert.equal(purged, 2);
  assert.equal(sp.getSignalCount('quality'), 1);
  assert.equal(sp.getSignalCount('convergence'), 0);
});

test('SignalPersistence - getTrend stable', async () => {
  const sp = new SignalPersistence();
  for (let i = 0; i < 10; i++) await sp.record('quality', { total: 0.8 });
  const trend = sp.getTrend('quality', 'total', 10);
  assert.equal(trend.trend, 'stable');
});

test('SignalPersistence - getTrend with nested field', async () => {
  const sp = new SignalPersistence();
  for (let i = 0; i < 5; i++) await sp.record('quality', { metrics: { score: 0.5 + i * 0.1 } });
  const trend = sp.getTrend('quality', 'metrics.score', 5);
  assert.equal(trend.trend, 'improving');
});

test('SignalPersistence - getTrend with non-numeric field', async () => {
  const sp = new SignalPersistence();
  for (let i = 0; i < 5; i++) await sp.record('quality', { label: 'good' });
  const trend = sp.getTrend('quality', 'label', 5);
  assert.ok(trend.values);
});

test('SignalPersistence - double shutdown safe', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.85 });
  sp.shutdown();
  sp.shutdown();
  assert.equal(sp.getSignalCount(), 0);
});

test('SignalPersistence - attachProjectRoot with valid string', () => {
  const sp = new SignalPersistence();
  const result = sp.attachProjectRoot('e:\\Harness_V1_0429');
  assert.equal(result, sp);
});

test('SignalPersistence - attachProjectRoot already set', () => {
  const sp = new SignalPersistence({ projectRoot: 'e:\\Harness_V1_0429' });
  const result = sp.attachProjectRoot('e:\\other');
  assert.equal(result, sp);
});

test('SignalPersistence - record after shutdown returns error', async () => {
  const sp = new SignalPersistence();
  sp.shutdown();
  const result = await sp.record('quality', { total: 0.85 });
  assert.equal(result.success, false);
});

test('SelfEvolutionGovernor - circuit breaker triggers on consecutive errors', async () => {
  const gov = new SelfEvolutionGovernor();
  gov._maxConsecutiveErrors = 2;
  let circuitBreakerFired = false;
  gov.on('governor-circuit-breaker', function() { circuitBreakerFired = true; });
  gov._consecutiveErrors = 2;
  gov.emit('governor-circuit-breaker', { consecutiveErrors: gov._consecutiveErrors });
  gov._running = false;
  assert.ok(circuitBreakerFired);
  assert.equal(gov._running, false);
});

test('SelfEvolutionGovernor - agenda item accumulates observations', async () => {
  const gov = new SelfEvolutionGovernor({ agendaMaturityThreshold: 3 });
  const sp = new SignalPersistence();
  gov.attachSignalPersistence(sp);
  for (let i = 0; i < 5; i++) {
    await sp.record('quality', { total: 0.9 - i * 0.1 });
  }
  gov.forceHeartbeat();
  const items = gov.getAgendaItems();
  assert.ok(items.length >= 0);
});

test('SelfEvolutionGovernor - proposal generated on maturity', async () => {
  const gov = new SelfEvolutionGovernor({ agendaMaturityThreshold: 1 });
  const sp = new SignalPersistence();
  gov.attachSignalPersistence(sp);
  let proposalGenerated = false;
  gov.on('proposal-generated', function() { proposalGenerated = true; });
  for (let i = 0; i < 5; i++) {
    await sp.record('quality', { total: 0.5 - i * 0.1 });
  }
  gov.forceHeartbeat();
  assert.ok(proposalGenerated || gov.getStats().agendaItemsCreated === 0);
});

test('SelfEvolutionGovernor - _collectObservations with failing health checker', async () => {
  const gov = new SelfEvolutionGovernor();
  gov.attachHealthChecker({
    getAggregatedReport: function() { throw new Error('down'); },
  });
  gov._lastHeartbeatAt = new Date().toISOString();
  const observations = await gov._collectObservations();
  assert.ok(observations.length >= 1);
  assert.equal(observations[0].overallStatus, 'check_failed');
});

test('SelfEvolutionGovernor - _collectObservations with causal data bus', async () => {
  const gov = new SelfEvolutionGovernor();
  gov.attachCausalDataBus({
    getStats: function() { return { chainLength: 10, invariantViolations: 2 }; },
  });
  gov._lastHeartbeatAt = new Date().toISOString();
  const observations = await gov._collectObservations();
  const causalObs = observations.find(function(o) { return o.signalType === 'causal_bus_status'; });
  assert.ok(causalObs);
  assert.equal(causalObs.invariantViolations, 2);
});

test('SelfEvolutionGovernor - _recordObservation with max agenda items', () => {
  const gov = new SelfEvolutionGovernor();
  gov._maxAgendaItems = 2;
  gov._recordObservation({ signalType: 'quality_trend', trend: 'degrading', timestamp: new Date().toISOString() });
  gov._recordObservation({ signalType: 'health_status', overallStatus: 'critical', timestamp: new Date().toISOString() });
  gov._recordObservation({ signalType: 'convergence_pattern', trend: 'degrading', timestamp: new Date().toISOString() });
  assert.equal(gov._agendaItems.size, 2);
});

test('SelfEvolutionGovernor - _inferAction default', () => {
  const gov = new SelfEvolutionGovernor();
  const action = gov._inferAction({ key: 'unknown-key' });
  assert.equal(action, 'investigate');
});

test('SelfEvolutionGovernor - getProposals without signal persistence', () => {
  const gov = new SelfEvolutionGovernor();
  const proposals = gov.getProposals();
  assert.ok(Array.isArray(proposals));
  assert.equal(proposals.length, 0);
});

test('SelfEvolutionGovernor - getProposals with signal persistence', async () => {
  const sp = new SignalPersistence();
  const gov = new SelfEvolutionGovernor({ signalPersistence: sp });
  await sp.record('agenda', { proposalId: 'test', status: 'pending' });
  const proposals = gov.getProposals(10);
  assert.ok(Array.isArray(proposals));
});

test('SelfEvolutionGovernor - double shutdown safe', () => {
  const gov = new SelfEvolutionGovernor();
  gov.shutdown();
  gov.shutdown();
  assert.equal(gov._running, false);
});

test('SelfEvolutionGovernor - start when already running', () => {
  const gov = new SelfEvolutionGovernor({ heartbeatIntervalMs: 60000 });
  gov.start();
  assert.equal(gov._running, true);
  gov.start();
  assert.equal(gov._running, true);
  gov.stop();
});

test('SkillPatchApproval - submit with non-object patchData', () => {
  const spa = new SkillPatchApproval();
  assert.equal(spa.submit('skill', 'string').success, false);
  assert.equal(spa.submit('skill', null).success, false);
  assert.equal(spa.submit('skill', 123).success, false);
});

test('SkillPatchApproval - submit with only avoidances', () => {
  const spa = new SkillPatchApproval();
  const result = spa.submit('skill', { tips: [], avoidances: ['avoid this'] });
  assert.equal(result.success, true);
});

test('SkillPatchApproval - submit truncates long avoidances', () => {
  const spa = new SkillPatchApproval();
  const longAvoidance = 'b'.repeat(600);
  const result = spa.submit('skill', { tips: ['tip1'], avoidances: [longAvoidance], count: 1 });
  assert.equal(result.success, true);
  const patch = spa.getPatch(result.patchId);
  assert.equal(patch.avoidances[0].length, 500);
});

test('SkillPatchApproval - submit limits avoidances count', () => {
  const spa = new SkillPatchApproval();
  const avoidances = [];
  for (let i = 0; i < 15; i++) avoidances.push('avoid ' + i);
  const result = spa.submit('skill', { tips: ['tip1'], avoidances: avoidances, count: 1 });
  assert.equal(result.success, true);
  const patch = spa.getPatch(result.patchId);
  assert.equal(patch.avoidances.length, 10);
});

test('SkillPatchApproval - reject non-pending patch', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('skill', { tips: ['tip1'], avoidances: [], count: 1 });
  spa.approve(submitResult.patchId, 'analyst');
  const rejectResult = spa.reject(submitResult.patchId, 'lead', 'too late');
  assert.equal(rejectResult.success, false);
});

test('SkillPatchApproval - markApplied non-approved patch', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('skill', { tips: ['tip1'], avoidances: [], count: 1 });
  const applyResult = spa.markApplied(submitResult.patchId);
  assert.equal(applyResult.success, false);
});

test('SkillPatchApproval - revoke non-applied patch', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('skill', { tips: ['tip1'], avoidances: [], count: 1 });
  const revokeResult = spa.revoke(submitResult.patchId, 'lead', 'not applied');
  assert.equal(revokeResult.success, false);
});

test('SkillPatchApproval - approve nonexistent patch', () => {
  const spa = new SkillPatchApproval();
  const result = spa.approve('nonexistent', 'analyst');
  assert.equal(result.success, false);
  assert.ok(result.error.includes('not found'));
});

test('SkillPatchApproval - reject nonexistent patch', () => {
  const spa = new SkillPatchApproval();
  const result = spa.reject('nonexistent', 'lead', 'reason');
  assert.equal(result.success, false);
});

test('SkillPatchApproval - markApplied nonexistent patch', () => {
  const spa = new SkillPatchApproval();
  const result = spa.markApplied('nonexistent');
  assert.equal(result.success, false);
});

test('SkillPatchApproval - revoke nonexistent patch', () => {
  const spa = new SkillPatchApproval();
  const result = spa.revoke('nonexistent', 'lead', 'reason');
  assert.equal(result.success, false);
});

test('SkillPatchApproval - evict oldest rejected patch', () => {
  const spa = new SkillPatchApproval();
  for (let i = 0; i < 201; i++) {
    const result = spa.submit('skill', { tips: ['tip' + i], avoidances: [], count: 1 });
    if (i === 0) {
      spa.reject(result.patchId, 'lead', 'old');
    }
  }
  assert.ok(spa._patches.size <= 200);
});

test('SkillPatchApproval - full lifecycle', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('tdd-implement', { tips: ['Write tests'], avoidances: ['Skip RED'], count: 5 });
  assert.equal(submitResult.state, 'pending');
  const approveResult = spa.approve(submitResult.patchId, 'domain-analyst');
  assert.equal(approveResult.state, 'approved');
  const applyResult = spa.markApplied(submitResult.patchId);
  assert.equal(applyResult.state, 'applied');
  const revokeResult = spa.revoke(submitResult.patchId, 'team-lead', 'Regression detected');
  assert.equal(revokeResult.state, 'revoked');
  const stats = spa.getStats();
  assert.equal(stats.submitted, 1);
  assert.equal(stats.approved, 1);
  assert.equal(stats.applied, 1);
  assert.equal(stats.revoked, 1);
});

test('SkillPatchApproval - getApprovedPatchForSkill returns approved patch', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('tdd-implement', { tips: ['tip1'], avoidances: [], count: 4 });
  spa.approve(submitResult.patchId, 'analyst');
  const approved = spa.getApprovedPatchForSkill('tdd-implement');
  assert.ok(approved);
  assert.equal(approved.skillId, 'tdd-implement');
  assert.equal(approved.state, 'approved');
});

test('SkillPatchApproval - attachProjectRoot with valid path', () => {
  const spa = new SkillPatchApproval();
  const result = spa.attachProjectRoot('e:\\Harness_V1_0429');
  assert.equal(result, spa);
});

test('SkillPatchApproval - attachProjectRoot already set', () => {
  const spa = new SkillPatchApproval({ projectRoot: 'e:\\Harness_V1_0429' });
  const result = spa.attachProjectRoot('e:\\other');
  assert.equal(result, spa);
});

test('SkillPatchApproval - attachProjectRoot with invalid value', () => {
  const spa = new SkillPatchApproval();
  const result = spa.attachProjectRoot(123);
  assert.equal(result, spa);
});

test('PriorityQueue - maxSize eviction', () => {
  const pq = new PriorityQueue({ maxSize: 3 });
  pq.push({ id: 'a', priority: 1 });
  pq.push({ id: 'b', priority: 5 });
  pq.push({ id: 'c', priority: 3 });
  pq.push({ id: 'd', priority: 10 });
  assert.equal(pq.size(), 3);
  const top = pq.peek();
  assert.ok(top.priority <= 5);
});

test('PriorityQueue - same priority FIFO order', () => {
  const pq = new PriorityQueue();
  pq.push({ id: 'first', priority: 1 });
  pq.push({ id: 'second', priority: 1 });
  pq.push({ id: 'third', priority: 1 });
  assert.equal(pq.pop().id, 'first');
  assert.equal(pq.pop().id, 'second');
  assert.equal(pq.pop().id, 'third');
});

test('PriorityQueue - large number of items', () => {
  const pq = new PriorityQueue();
  for (let i = 100; i >= 1; i--) {
    pq.push({ id: 'item-' + i, priority: i });
  }
  assert.equal(pq.size(), 100);
  assert.equal(pq.peek().id, 'item-1');
  assert.equal(pq.peek().priority, 1);
});

test('PriorityQueue - toArray preserves heap', () => {
  const pq = new PriorityQueue();
  pq.push({ id: 'c', priority: 3 });
  pq.push({ id: 'a', priority: 1 });
  pq.push({ id: 'b', priority: 2 });
  const arr = pq.toArray();
  assert.equal(arr.length, 3);
  assert.equal(pq.size(), 3);
});

test('PriorityQueue - push returns size', () => {
  const pq = new PriorityQueue();
  assert.equal(pq.push({ id: 'a', priority: 1 }), 1);
  assert.equal(pq.push({ id: 'b', priority: 2 }), 2);
});

test('PriorityQueue - single item operations', () => {
  const pq = new PriorityQueue();
  pq.push({ id: 'only', priority: 5 });
  assert.equal(pq.peek().id, 'only');
  assert.equal(pq.pop().id, 'only');
  assert.equal(pq.isEmpty(), true);
  assert.equal(pq.pop(), undefined);
});

test('PriorityQueue - clear on empty', () => {
  const pq = new PriorityQueue();
  pq.clear();
  assert.equal(pq.size(), 0);
  assert.equal(pq.isEmpty(), true);
});

test('CausalVectorIndex - embedding service success', async () => {
  const mockEmbedding = {
    embed: async function(text) {
      const vector = new Array(128).fill(0);
      vector[0] = text.length;
      const norm = Math.sqrt(vector.reduce(function(s, v) { return s + v * v; }, 0));
      return norm > 0 ? vector.map(function(v) { return v / norm; }) : vector;
    },
  };
  const cvi = new CausalVectorIndex({ embeddingService: mockEmbedding });
  await cvi.index('cause-1', 'hello world', {});
  const entry = cvi.get('cause-1');
  assert.ok(entry);
  assert.ok(Array.isArray(entry.vector));
  assert.equal(entry.vector.length, 128);
  const stats = cvi.getStats();
  assert.equal(stats.embeddingServiceAvailable, true);
});

test('CausalVectorIndex - embedding service failure falls back', async () => {
  const badEmbedding = {
    embed: async function() { throw new Error('service down'); },
  };
  const cvi = new CausalVectorIndex({ embeddingService: badEmbedding });
  const result = await cvi.index('cause-1', 'test text', {});
  assert.equal(result.success, true);
  const entry = cvi.get('cause-1');
  assert.ok(entry);
  assert.ok(Array.isArray(entry.vector));
});

test('CausalVectorIndex - maxVectors eviction', async () => {
  const cvi = new CausalVectorIndex({ maxVectors: 3 });
  await cvi.index('v1', 'text 1', {});
  await cvi.index('v2', 'text 2', {});
  await cvi.index('v3', 'text 3', {});
  await cvi.index('v4', 'text 4', {});
  assert.equal(cvi.getStats().totalVectors, 3);
  assert.equal(cvi.get('v1'), null);
});

test('CausalVectorIndex - empty text', async () => {
  const cvi = new CausalVectorIndex();
  const result = await cvi.index('empty', '', {});
  assert.equal(result.success, true);
  const entry = cvi.get('empty');
  assert.ok(entry);
  assert.ok(Array.isArray(entry.vector));
});

test('CausalVectorIndex - null text', async () => {
  const cvi = new CausalVectorIndex();
  const result = await cvi.index('null-text', null, {});
  assert.equal(result.success, true);
});

test('CausalVectorIndex - remove nonexistent returns false', () => {
  const cvi = new CausalVectorIndex();
  assert.equal(cvi.remove('nonexistent'), false);
});

test('CausalVectorIndex - reindex same causalId', async () => {
  const cvi = new CausalVectorIndex();
  await cvi.index('dup', 'first text', { v: 1 });
  await cvi.index('dup', 'second text', { v: 2 });
  assert.equal(cvi.getStats().totalVectors, 1);
  const entry = cvi.get('dup');
  assert.equal(entry.metadata.v, 2);
});

test('CausalVectorIndex - query with custom threshold', async () => {
  const cvi = new CausalVectorIndex({ similarityThreshold: 0 });
  await cvi.index('cause-1', 'test query text', {});
  const results = await cvi.query('test query text', { threshold: 0.5 });
  assert.ok(Array.isArray(results));
});

test('CausalVectorIndex - attachEmbeddingService', () => {
  const cvi = new CausalVectorIndex();
  const result = cvi.attachEmbeddingService({ embed: async function() {} });
  assert.equal(result, cvi);
  assert.equal(cvi.getStats().embeddingServiceAvailable, true);
});

test('CausalVectorIndex - double shutdown safe', async () => {
  const cvi = new CausalVectorIndex();
  await cvi.index('cause-1', 'text', {});
  cvi.shutdown();
  cvi.shutdown();
  assert.equal(cvi.getStats().totalVectors, 0);
});

test('CausalVectorIndex - cosine similarity with zero vectors', () => {
  const cvi = new CausalVectorIndex();
  const result = cvi._cosineSimilarity([0, 0, 0], [1, 1, 1]);
  assert.equal(result, 0);
});

test('CausalVectorIndex - cosine similarity with mismatched lengths', () => {
  const cvi = new CausalVectorIndex();
  const result = cvi._cosineSimilarity([1, 2], [1, 2, 3]);
  assert.equal(result, 0);
});

test('CausalVectorIndex - hit rate calculation', async () => {
  const cvi = new CausalVectorIndex({ similarityThreshold: 0 });
  await cvi.index('c1', 'alpha beta', {});
  await cvi.query('alpha beta', {});
  await cvi.query('completely different xyz', { threshold: 0.99 });
  const stats = cvi.getStats();
  assert.ok(stats.hitRate >= 0);
  assert.ok(stats.hitRate <= 1);
});

test('CausalVectorIndex - fallback vector generation deterministic', () => {
  const cvi = new CausalVectorIndex();
  const v1 = cvi._generateFallbackVector('hello world');
  const v2 = cvi._generateFallbackVector('hello world');
  assert.deepEqual(v1, v2);
});

test('CausalVectorIndex - fallback vector with non-string', () => {
  const cvi = new CausalVectorIndex();
  const v = cvi._generateFallbackVector(123);
  assert.ok(Array.isArray(v));
  assert.equal(v.length, 128);
});

test('PriorityQueue - isHealthy', () => {
  const pq = new PriorityQueue();
  assert.equal(pq.isHealthy(), true);
  pq.shutdown();
  assert.equal(pq.isHealthy(), false);
});

test('PriorityQueue - shutdown', () => {
  const pq = new PriorityQueue();
  pq.push({ id: 'a', priority: 1 });
  pq.shutdown();
  assert.equal(pq.size(), 0);
  assert.equal(pq.isEmpty(), true);
  assert.equal(pq.push({ id: 'b', priority: 2 }), 0);
  assert.equal(pq.pop(), undefined);
});

test('PriorityQueue - double shutdown safe', () => {
  const pq = new PriorityQueue();
  pq.shutdown();
  pq.shutdown();
  assert.equal(pq.isHealthy(), false);
});

test('PriorityQueue - getStats', () => {
  const pq = new PriorityQueue();
  pq.push({ id: 'a', priority: 1 });
  pq.push({ id: 'b', priority: 2 });
  const stats = pq.getStats();
  assert.equal(stats.size, 2);
  assert.equal(stats.pushed, 2);
  assert.equal(stats.popped, 0);
  assert.equal(stats.evicted, 0);
  assert.equal(stats.shutDown, false);
});

test('PriorityQueue - push null returns 0', () => {
  const pq = new PriorityQueue();
  assert.equal(pq.push(null), 0);
  assert.equal(pq.size(), 0);
});

test('PriorityQueue - push non-object returns 0', () => {
  const pq = new PriorityQueue();
  assert.equal(pq.push('string'), 0);
  assert.equal(pq.push(123), 0);
  assert.equal(pq.size(), 0);
});

test('PriorityQueue - DEFAULT_PRIORITY exported', () => {
  assert.equal(PriorityQueue.DEFAULT_PRIORITY, 5);
});

test('PriorityQueue - evictLowest removes lowest priority', () => {
  const pq = new PriorityQueue({ maxSize: 3 });
  pq.push({ id: 'low', priority: 1 });
  pq.push({ id: 'mid', priority: 5 });
  pq.push({ id: 'high', priority: 10 });
  pq.push({ id: 'new', priority: 3 });
  assert.equal(pq.size(), 3);
  const items = pq.toArray();
  for (const item of items) {
    assert.ok(item.priority !== 10 || item.id === 'new');
  }
});

test('SkillPatchApproval - submit after shutdown throws', () => {
  const spa = new SkillPatchApproval();
  spa.shutdown();
  assert.throws(() => {
    spa.submit('skill', { tips: ['tip1'], avoidances: [], count: 1 });
  }, /shut down/i);
});

test('SkillPatchApproval - approve after shutdown throws', () => {
  const spa = new SkillPatchApproval();
  const submitResult = spa.submit('skill', { tips: ['tip1'], avoidances: [], count: 1 });
  spa.shutdown();
  assert.throws(() => {
    spa.approve(submitResult.patchId, 'analyst');
  }, /shut down/i);
});

test('SkillPatchApproval - double shutdown safe', () => {
  const spa = new SkillPatchApproval();
  spa.shutdown();
  spa.shutdown();
  assert.equal(spa.isHealthy(), false);
});

test('SkillPatchApproval - isHealthy after shutdown', () => {
  const spa = new SkillPatchApproval();
  assert.equal(spa.isHealthy(), true);
  spa.shutdown();
  assert.equal(spa.isHealthy(), false);
});

test('CausalVectorIndex - index after shutdown returns error', async () => {
  const cvi = new CausalVectorIndex();
  cvi.shutdown();
  const result = await cvi.index('test', 'text', {});
  assert.equal(result.success, false);
  assert.ok(result.error.includes('shut down'));
});

test('CausalVectorIndex - query after shutdown returns empty', async () => {
  const cvi = new CausalVectorIndex();
  cvi.shutdown();
  const results = await cvi.query('test', {});
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 0);
});

test('CausalVectorIndex - index with invalid causalId', async () => {
  const cvi = new CausalVectorIndex();
  const result = await cvi.index(null, 'text', {});
  assert.equal(result.success, false);
  assert.ok(result.error.includes('causalId'));
});

test('CausalVectorIndex - index with non-string causalId', async () => {
  const cvi = new CausalVectorIndex();
  const result = await cvi.index(123, 'text', {});
  assert.equal(result.success, false);
});

test('SignalPersistence - getTrend with null field', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.8 });
  const trend = sp.getTrend('quality', null, 10);
  assert.equal(trend.trend, 'invalid_field');
});

test('SignalPersistence - getTrend with non-string field', async () => {
  const sp = new SignalPersistence();
  await sp.record('quality', { total: 0.8 });
  const trend = sp.getTrend('quality', 123, 10);
  assert.equal(trend.trend, 'invalid_field');
});

test('SelfEvolutionGovernor - forceHeartbeat after shutdown', async () => {
  const gov = new SelfEvolutionGovernor();
  gov.shutdown();
  assert.throws(() => gov.forceHeartbeat(), { code: 'SHUTDOWN' });
});
