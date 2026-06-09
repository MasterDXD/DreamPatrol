'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SessionManager = require('../../../src/runtime/session/session-manager');
const CheckpointManager = require('../../../src/runtime/session/checkpoint-manager');

const tempDirs = [];

function createTempDir(prefix) {
  const dir = path.join(os.tmpdir(), prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { _e; }
}

function ensureHarnessDir(dir) {
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'checkpoints'), { recursive: true });
}

afterEach(() => {
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
  tempDirs.length = 0;
});

describe('SessionManager - lifecycle', () => {
  it('constructor should initialize with valid projectRoot', () => {
    const tempRoot = createTempDir('sm-ctor');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    assert.ok(mgr);
    assert.strictEqual(mgr.root, tempRoot);
    mgr.shutdown();
  });

  it('constructor should throw on invalid projectRoot', () => {
    assert.throws(() => new SessionManager(''), /projectRoot/i);
    assert.throws(() => new SessionManager(null), /projectRoot/i);
  });

  it('create should return a new session with correct defaults', () => {
    const tempRoot = createTempDir('sm-create');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    const session = mgr.create('create-test-1');
    assert.strictEqual(session.id, 'create-test-1');
    assert.strictEqual(session.currentPhase, 'brainstorming');
    assert.strictEqual(session.tokensUsed, 0);
    assert.strictEqual(session.status, 'active');
    assert.ok(Array.isArray(session.completedSkills));
    assert.strictEqual(session.completedSkills.length, 0);
    assert.ok(session.createdAt);
    assert.ok(session.lastActivityAt);
    mgr.shutdown();
  });

  it('create should throw on duplicate sessionId', () => {
    const tempRoot = createTempDir('sm-dup');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    mgr.create('create-dup-1');
    assert.throws(() => mgr.create('create-dup-1'), /already exists/i);
    mgr.shutdown();
  });

  it('create should throw on invalid sessionId format', () => {
    const tempRoot = createTempDir('sm-invalid');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    assert.throws(() => mgr.create('invalid id!'), /Invalid sessionId/i);
    mgr.shutdown();
  });

  it('advancePhase should transition to a valid next phase', () => {
    const tempRoot = createTempDir('sm-adv');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    mgr.create('advance-test-1');
    const session = mgr.advancePhase('advance-test-1', 'requirement-analysis');
    assert.strictEqual(session.currentPhase, 'requirement-analysis');
    mgr.shutdown();
  });

  it('advancePhase should throw on invalid phase transition', () => {
    const tempRoot = createTempDir('sm-invadv');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    mgr.create('advance-inv-1');
    assert.throws(() => mgr.advancePhase('advance-inv-1', 'deployment'), /Invalid phase transition/i);
    mgr.shutdown();
  });

  it('advancePhase should throw on non-existent session', () => {
    const tempRoot = createTempDir('sm-advnone');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    assert.throws(() => mgr.advancePhase('no-such-session', 'requirement-analysis'), /not found/i);
    mgr.shutdown();
  });

  it('advancePhase should return same session when phase unchanged', () => {
    const tempRoot = createTempDir('sm-samephase');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    mgr.create('same-phase-1');
    const session = mgr.advancePhase('same-phase-1', 'brainstorming');
    assert.strictEqual(session.currentPhase, 'brainstorming');
    mgr.shutdown();
  });

  it('completeSkill should add skill to completedSkills', () => {
    const tempRoot = createTempDir('sm-skill');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    mgr.create('skill-test-1');
    const session = mgr.completeSkill('skill-test-1', 'brainstorming');
    assert.ok(session.completedSkills.includes('brainstorming'));
    mgr.shutdown();
  });

  it('completeSkill should not add duplicate skill', () => {
    const tempRoot = createTempDir('sm-skilldup');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    mgr.create('skill-dup-1');
    mgr.completeSkill('skill-dup-1', 'brainstorming');
    mgr.completeSkill('skill-dup-1', 'brainstorming');
    const session = mgr.get('skill-dup-1');
    assert.strictEqual(session.completedSkills.filter(s => s === 'brainstorming').length, 1);
    mgr.shutdown();
  });

  it('completeSkill should throw on empty skillId', () => {
    const tempRoot = createTempDir('sm-skillempty');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    mgr.create('skill-empty-1');
    assert.throws(() => mgr.completeSkill('skill-empty-1', ''), /non-empty string/i);
    mgr.shutdown();
  });

  it('completeSkill should throw on non-existent session', () => {
    const tempRoot = createTempDir('sm-skillnone');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    assert.throws(() => mgr.completeSkill('no-such-session', 'brainstorming'), /not found/i);
    mgr.shutdown();
  });
});

describe('SessionManager - stats and events', () => {
  it('getStats should return session statistics', () => {
    const tempRoot = createTempDir('sm-stats');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    mgr.create('stats-test-1');
    mgr.addTokenUsage('stats-test-1', 100);
    const stats = mgr.getStats();
    assert.strictEqual(stats.activeSessions, 1);
    assert.strictEqual(stats.totalTokensUsed, 100);
    assert.ok(stats.phases);
    assert.strictEqual(stats.phases['brainstorming'], 1);
    mgr.shutdown();
  });

  it('getStats should return zero stats when no sessions', () => {
    const tempRoot = createTempDir('sm-nostats');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    const stats = mgr.getStats();
    assert.strictEqual(stats.activeSessions, 0);
    assert.strictEqual(stats.totalTokensUsed, 0);
    mgr.shutdown();
  });

  it('getPreviousSessionContext should return null when no sessions on disk', async () => {
    const tempRoot = createTempDir('sm-prevnull');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    const ctx = await mgr.getPreviousSessionContext();
    assert.strictEqual(ctx, null);
    mgr.shutdown();
  });

  it('getPreviousSessionContext should return context after session is persisted', async () => {
    const tempRoot = createTempDir('sm-prevctx');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    mgr.create('prev-ctx-1');
    mgr.completeSkill('prev-ctx-1', 'brainstorming');
    mgr.flush();
    const ctx = await mgr.getPreviousSessionContext();
    assert.ok(ctx);
    assert.strictEqual(ctx.sessionId, 'prev-ctx-1');
    assert.strictEqual(ctx.lastPhase, 'brainstorming');
    assert.ok(Array.isArray(ctx.completedSkills));
    assert.strictEqual(typeof ctx.tokensUsed, 'number');
    mgr.shutdown();
  });

  it('shutdown should clean up resources', () => {
    const tempRoot = createTempDir('sm-shut');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    mgr.create('shut-test-1');
    mgr.shutdown();
    assert.strictEqual(mgr._shutDown, true);
  });

  it('shutdown should prevent further operations', () => {
    const tempRoot = createTempDir('sm-shutblock');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    mgr.shutdown();
    assert.throws(() => mgr.create('after-shutdown'), /shut down/i);
  });

  it('should emit session-created event on create', () => {
    const tempRoot = createTempDir('sm-emit');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    let emitted = null;
    mgr.on('session-created', (evt) => { emitted = evt; });
    mgr.create('emit-test-1');
    assert.ok(emitted);
    assert.strictEqual(emitted.sessionId, 'emit-test-1');
    mgr.shutdown();
  });

  it('should emit phase-change event on advancePhase', () => {
    const tempRoot = createTempDir('sm-phaseemit');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    let emitted = null;
    mgr.on('phase-change', (evt) => { emitted = evt; });
    mgr.create('phase-emit-1');
    mgr.advancePhase('phase-emit-1', 'requirement-analysis');
    assert.ok(emitted);
    assert.strictEqual(emitted.from, 'brainstorming');
    assert.strictEqual(emitted.to, 'requirement-analysis');
    mgr.shutdown();
  });

  it('should emit skill-complete event on completeSkill', () => {
    const tempRoot = createTempDir('sm-skillemit');
    ensureHarnessDir(tempRoot);
    const mgr = new SessionManager(tempRoot);
    let emitted = null;
    mgr.on('skill-complete', (evt) => { emitted = evt; });
    mgr.create('skill-emit-1');
    mgr.completeSkill('skill-emit-1', 'brainstorming');
    assert.ok(emitted);
    assert.strictEqual(emitted.skillId, 'brainstorming');
    mgr.shutdown();
  });
});

describe('CheckpointManager', () => {
  it('constructor should initialize with valid projectRoot', () => {
    const tempRoot = createTempDir('cp-ctor');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    assert.ok(mgr);
    assert.strictEqual(mgr.root, tempRoot);
    mgr.shutdown();
  });

  it('constructor should throw on invalid projectRoot', () => {
    assert.throws(() => new CheckpointManager(''), /projectRoot/i);
    assert.throws(() => new CheckpointManager(null), /projectRoot/i);
  });

  it('create should return a checkpoint with correct fields', () => {
    const tempRoot = createTempDir('cp-create');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    const cp = mgr.create('sess-1', {
      phase: 'brainstorming',
      completedSkills: ['brainstorming'],
      tokensUsed: 50,
    });
    assert.ok(cp);
    assert.ok(cp.id);
    assert.ok(cp.id.startsWith('cp-'));
    assert.strictEqual(cp.sessionId, 'sess-1');
    assert.strictEqual(cp.phase, 'brainstorming');
    assert.deepStrictEqual(cp.completedSkills, ['brainstorming']);
    assert.strictEqual(cp.tokensUsed, 50);
    assert.ok(cp.createdAt);
    mgr.shutdown();
  });

  it('create should return null for invalid sessionId', () => {
    const tempRoot = createTempDir('cp-invsess');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    assert.strictEqual(mgr.create('', { phase: 'brainstorming' }), null);
    assert.strictEqual(mgr.create(null, { phase: 'brainstorming' }), null);
    mgr.shutdown();
  });

  it('create should return null for missing data', () => {
    const tempRoot = createTempDir('cp-nodata');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    assert.strictEqual(mgr.create('sess-1', null), null);
    assert.strictEqual(mgr.create('sess-1', undefined), null);
    mgr.shutdown();
  });

  it('create should return null for sessionId with invalid characters', () => {
    const tempRoot = createTempDir('cp-badid');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    assert.strictEqual(mgr.create('bad id!', { phase: 'brainstorming' }), null);
    mgr.shutdown();
  });

  it('list should return all checkpoints sorted by createdAt desc', () => {
    const tempRoot = createTempDir('cp-list');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    mgr.create('list-sess-1', { phase: 'brainstorming' });
    mgr.create('list-sess-1', { phase: 'requirement-analysis' });
    const list = mgr.list();
    assert.strictEqual(list.length, 2);
    assert.ok(new Date(list[0].createdAt) >= new Date(list[1].createdAt));
    mgr.shutdown();
  });

  it('list should filter by sessionId', () => {
    const tempRoot = createTempDir('cp-filter');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    mgr.create('filter-a', { phase: 'brainstorming' });
    mgr.create('filter-b', { phase: 'requirement-analysis' });
    const list = mgr.list('filter-a');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].sessionId, 'filter-a');
    mgr.shutdown();
  });

  it('list should return empty array when no checkpoints', () => {
    const tempRoot = createTempDir('cp-empty');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    const list = mgr.list();
    assert.strictEqual(list.length, 0);
    mgr.shutdown();
  });

  it('restore should return restored checkpoint data', () => {
    const tempRoot = createTempDir('cp-restore');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    const cp = mgr.create('restore-sess', {
      phase: 'module-development',
      completedSkills: ['brainstorming', 'requirement-analysis'],
      tokensUsed: 200,
      agentHistory: [{ agentId: 'worker', action: 'code' }],
      causalWalSequence: 5,
      metadata: { key: 'value' },
    });
    const restored = mgr.restore(cp.id);
    assert.ok(restored);
    assert.strictEqual(restored.phase, 'module-development');
    assert.deepStrictEqual(restored.completedSkills, ['brainstorming', 'requirement-analysis']);
    assert.strictEqual(restored.tokensUsed, 200);
    assert.strictEqual(restored.causalWalSequence, 5);
    assert.strictEqual(restored.restoredFrom, cp.id);
    assert.ok(restored.restoredAt);
    assert.deepStrictEqual(restored.metadata, { key: 'value' });
    mgr.shutdown();
  });

  it('restore should return null for non-existent checkpoint', () => {
    const tempRoot = createTempDir('cp-restorenone');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    assert.strictEqual(mgr.restore('no-such-cp'), null);
    mgr.shutdown();
  });

  it('restore should return copies of arrays not references', () => {
    const tempRoot = createTempDir('cp-restorecopy');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    const cp = mgr.create('copy-sess', {
      phase: 'brainstorming',
      completedSkills: ['brainstorming'],
      agentHistory: [{ agentId: 'lead', action: 'plan' }],
    });
    const restored = mgr.restore(cp.id);
    restored.completedSkills.push('extra');
    restored.agentHistory.push({ agentId: 'extra', action: 'x' });
    const restored2 = mgr.restore(cp.id);
    assert.strictEqual(restored2.completedSkills.length, 1);
    assert.strictEqual(restored2.agentHistory.length, 1);
    mgr.shutdown();
  });

  it('shutdown should clear checkpoints', () => {
    const tempRoot = createTempDir('cp-shut');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    mgr.create('shut-sess', { phase: 'brainstorming' });
    mgr.shutdown();
    assert.strictEqual(mgr._checkpoints.size, 0);
  });

  it('should persist and restore checkpoints across instances', () => {
    const tempRoot = createTempDir('cp-persist');
    ensureHarnessDir(tempRoot);
    const mgr1 = new CheckpointManager(tempRoot);
    const _cp = mgr1.create('persist-sess', { phase: 'brainstorming', tokensUsed: 42 });
    mgr1.shutdown();

    const mgr2 = new CheckpointManager(tempRoot);
    const list = mgr2.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].sessionId, 'persist-sess');
    assert.strictEqual(list[0].tokensUsed, 42);
    mgr2.shutdown();
  });

  it('should enforce MAX_CHECKPOINTS limit', () => {
    const tempRoot = createTempDir('cp-max');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    for (let i = 0; i < CheckpointManager.MAX_CHECKPOINTS + 5; i++) {
      mgr.create('max-sess-' + i, { phase: 'brainstorming', tokensUsed: i });
    }
    const list = mgr.list();
    assert.ok(list.length <= CheckpointManager.MAX_CHECKPOINTS);
    mgr.shutdown();
  });
});

describe('CheckpointManager - corrupted data handling', () => {
  it('restore should handle corrupted checkpoint with null completedSkills', () => {
    const tempRoot = createTempDir('cp-corrupt');
    ensureHarnessDir(tempRoot);
    const mgr = new CheckpointManager(tempRoot);
    const cp = mgr.create('corrupt-sess', { phase: 'brainstorming', tokensUsed: 100 });
    const internal = mgr._checkpoints.get(cp.id);
    internal.completedSkills = null;
    internal.agentHistory = null;
    internal.metadata = null;
    const restored = mgr.restore(cp.id);
    assert.ok(restored);
    assert.deepStrictEqual(restored.completedSkills, []);
    assert.deepStrictEqual(restored.agentHistory, []);
    assert.deepStrictEqual(restored.metadata, {});
    mgr.shutdown();
  });

  it('should sanitize corrupted checkpoint data loaded from disk', () => {
    const tempRoot = createTempDir('cp-diskcorrupt');
    ensureHarnessDir(tempRoot);
    const mgr1 = new CheckpointManager(tempRoot);
    mgr1.create('disk-sess', { phase: 'brainstorming', tokensUsed: 42 });
    const cpId = mgr1.list('disk-sess')[0].id;
    const cp = mgr1._checkpoints.get(cpId);
    cp.completedSkills = null;
    cp.agentHistory = 'not-an-array';
    cp.tokensUsed = 'not-a-number';
    cp.phase = 123;
    cp.metadata = null;
    mgr1._persist();
    mgr1.shutdown();
    const mgr2 = new CheckpointManager(tempRoot);
    const restored = mgr2.restore(cpId);
    assert.ok(restored);
    assert.deepStrictEqual(restored.completedSkills, []);
    assert.deepStrictEqual(restored.agentHistory, []);
    assert.strictEqual(restored.tokensUsed, 0);
    assert.strictEqual(restored.phase, '');
    assert.deepStrictEqual(restored.metadata, {});
    mgr2.shutdown();
  });
});

describe('SessionManager - entropy tracking', () => {
  it('should initialize entropyState as unknown for new sessions', () => {
    const tempRoot = createTempDir('sm-entropy1');
    ensureHarnessDir(tempRoot);
    const sm = new SessionManager(tempRoot);
    sm.create('entropy-test-1');
    const data = sm.get('entropy-test-1');
    assert.ok(data.entropyState);
    assert.strictEqual(data.entropyState.currentLevel, 'unknown');
    assert.strictEqual(data.entropyState.firstMessageRichness, null);
    assert.strictEqual(data.entropyState.convergenceTurns, 0);
    sm.shutdown();
  });

  it('should update entropyState on first message with high-entropy', () => {
    const tempRoot = createTempDir('sm-entropy2');
    ensureHarnessDir(tempRoot);
    const sm = new SessionManager(tempRoot);
    sm.create('entropy-test-2');
    sm.updateEntropyState('entropy-test-2', { score: 0.5, level: 'high-entropy', signals: [] });
    const data = sm.get('entropy-test-2');
    assert.strictEqual(data.entropyState.currentLevel, 'high-entropy');
    assert.strictEqual(data.entropyState.firstMessageRichness.level, 'high-entropy');
    sm.shutdown();
  });

  it('should update entropyState on first message with low-entropy', () => {
    const tempRoot = createTempDir('sm-entropy3');
    ensureHarnessDir(tempRoot);
    const sm = new SessionManager(tempRoot);
    sm.create('entropy-test-3');
    sm.updateEntropyState('entropy-test-3', { score: 4.5, level: 'low-entropy', signals: ['scenario-detail', 'role-identity'] });
    const data = sm.get('entropy-test-3');
    assert.strictEqual(data.entropyState.currentLevel, 'low-entropy');
    assert.strictEqual(data.entropyState.firstMessageRichness.level, 'low-entropy');
    sm.shutdown();
  });

  it('should track convergence from high-entropy to low-entropy', () => {
    const tempRoot = createTempDir('sm-entropy4');
    ensureHarnessDir(tempRoot);
    const sm = new SessionManager(tempRoot);
    sm.create('entropy-test-4');
    sm.updateEntropyState('entropy-test-4', { score: 0.5, level: 'high-entropy', signals: [] });
    sm.updateEntropyState('entropy-test-4', { score: 1.5, level: 'medium-entropy', signals: ['scenario-detail'] });
    sm.updateEntropyState('entropy-test-4', { score: 4.0, level: 'low-entropy', signals: ['scenario-detail', 'role-identity'] });
    const data = sm.get('entropy-test-4');
    assert.strictEqual(data.entropyState.currentLevel, 'low-entropy');
    assert.strictEqual(data.entropyState.convergenceTurns, 1);
    sm.shutdown();
  });

  it('should not increment convergence when already low-entropy', () => {
    const tempRoot = createTempDir('sm-entropy5');
    ensureHarnessDir(tempRoot);
    const sm = new SessionManager(tempRoot);
    sm.create('entropy-test-5');
    sm.updateEntropyState('entropy-test-5', { score: 4.0, level: 'low-entropy', signals: [] });
    sm.updateEntropyState('entropy-test-5', { score: 4.5, level: 'low-entropy', signals: [] });
    const data = sm.get('entropy-test-5');
    assert.strictEqual(data.entropyState.convergenceTurns, 0);
    sm.shutdown();
  });

  it('should handle updateEntropyState for non-existent session gracefully', () => {
    const tempRoot = createTempDir('sm-entropy6');
    ensureHarnessDir(tempRoot);
    const sm = new SessionManager(tempRoot);
    assert.doesNotThrow(() => {
      sm.updateEntropyState('no-such-session', { score: 1, level: 'medium-entropy', signals: [] });
    });
    sm.shutdown();
  });

  it('should persist entropyState across session save/restore', () => {
    const tempRoot = createTempDir('sm-entropy7');
    ensureHarnessDir(tempRoot);
    const sm = new SessionManager(tempRoot);
    sm.create('entropy-test-6');
    sm.updateEntropyState('entropy-test-6', { score: 3.0, level: 'medium-entropy', signals: ['scenario-detail'] });
    const data = sm.get('entropy-test-6');
    assert.strictEqual(data.entropyState.currentLevel, 'medium-entropy');
    assert.strictEqual(data.entropyState.firstMessageRichness.level, 'medium-entropy');
    sm.shutdown();
  });
});
