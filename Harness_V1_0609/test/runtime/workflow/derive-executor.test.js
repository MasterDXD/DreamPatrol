'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const { DeriveExecutor } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'derive-executor'));

/**
 * 创建模拟的 WorktreeManager
 */
function createMockWorktreeManager() {
  const worktrees = new Map();
  return {
    create: async (agentId, branchName) => {
      const id = 'wt-' + agentId;
      const entry = { id, agentId, branch: branchName || id, status: 'active', createdAt: Date.now() };
      worktrees.set(id, entry);
      return entry;
    },
    remove: async (worktreeId) => {
      return worktrees.delete(worktreeId);
    },
    _worktrees: worktrees,
  };
}

/**
 * 创建模拟的 WorldLineManager
 */
function createMockWorldLineManager() {
  const lines = new Map();
  return {
    createWorldLine: (name, initialState) => {
      const worldLineId = 'wl-' + name;
      lines.set(worldLineId, { worldLineId, name, initialState, status: 'active' });
      return { worldLineId, name, initialState, parentLineId: null, currentState: initialState, depth: 0, status: 'active', createdAt: Date.now() };
    },
    mergeWorldLines: (sourceId, targetId, strategy) => {
      const source = lines.get(sourceId);
      const target = lines.get(targetId);
      if (source && target) {
        source.status = 'merged';
        return { merged: true, strategy };
      }
      return null;
    },
    removeWorldLine: (worldLineId) => {
      return lines.delete(worldLineId);
    },
    _lines: lines,
  };
}

/**
 * 创建模拟的 GoalExecutor
 */
function createMockGoalExecutor() {
  const goals = new Map();
  return {
    createGoal: (objective, options) => {
      const goalId = 'goal-' + Date.now();
      goals.set(goalId, { goalId, objective, options, status: 'pending' });
      return { success: true, goalId, status: 'pending' };
    },
    cancelGoal: (goalId) => {
      const g = goals.get(goalId);
      if (g) { g.status = 'cancelled'; return true; }
      return false;
    },
    _goals: goals,
  };
}

describe('DeriveExecutor - constructor', () => {
  it('should create instance with default config', () => {
    const exec = new DeriveExecutor();
    assert.ok(exec);
    assert.strictEqual(exec._config.maxDerivations, 20);
    exec.shutdown();
  });

  it('should merge custom options', () => {
    const exec = new DeriveExecutor({ maxDerivations: 5, defaultMergeStrategy: 'union' });
    assert.strictEqual(exec._config.maxDerivations, 5);
    assert.strictEqual(exec._config.defaultMergeStrategy, 'union');
    exec.shutdown();
  });
});

describe('DeriveExecutor - attach', () => {
  it('should attach worktree manager', () => {
    const exec = new DeriveExecutor();
    const mock = createMockWorktreeManager();
    const result = exec.attachWorktreeManager(mock);
    assert.strictEqual(result, exec);
    exec.shutdown();
  });

  it('should reject invalid worktree manager', () => {
    const exec = new DeriveExecutor();
    assert.throws(() => exec.attachWorktreeManager({}), /INVALID_INPUT/);
    exec.shutdown();
  });

  it('should attach world line manager', () => {
    const exec = new DeriveExecutor();
    const mock = createMockWorldLineManager();
    const result = exec.attachWorldLineManager(mock);
    assert.strictEqual(result, exec);
    exec.shutdown();
  });

  it('should reject invalid world line manager', () => {
    const exec = new DeriveExecutor();
    assert.throws(() => exec.attachWorldLineManager({}), /INVALID_INPUT/);
    exec.shutdown();
  });

  it('should attach goal executor', () => {
    const exec = new DeriveExecutor();
    const mock = createMockGoalExecutor();
    const result = exec.attachGoalExecutor(mock);
    assert.strictEqual(result, exec);
    exec.shutdown();
  });

  it('should reject invalid goal executor', () => {
    const exec = new DeriveExecutor();
    assert.throws(() => exec.attachGoalExecutor({}), /INVALID_INPUT/);
    exec.shutdown();
  });
});

describe('DeriveExecutor - derive', () => {
  it('should create derivation without dependencies', async () => {
    const exec = new DeriveExecutor();
    const result = await exec.derive('Test objective');
    assert.ok(result.deriveId);
    assert.strictEqual(result.worktreeId, null);
    assert.strictEqual(result.worldLineId, null);
    assert.strictEqual(result.goalId, null);
    exec.shutdown();
  });

  it('should create derivation with all dependencies', async () => {
    const exec = new DeriveExecutor();
    exec.attachWorktreeManager(createMockWorktreeManager());
    exec.attachWorldLineManager(createMockWorldLineManager());
    exec.attachGoalExecutor(createMockGoalExecutor());

    const result = await exec.derive('Full derivation test', {
      agentId: 'agent-1',
      branchName: 'feature-1',
      worldLineName: 'test-branch',
      acceptanceCriteria: ['Test passes', 'No regressions'],
    });

    assert.ok(result.deriveId);
    assert.ok(result.worktreeId);
    assert.ok(result.worldLineId);
    assert.ok(result.goalId);
    exec.shutdown();
  });

  it('should emit derive-created event', async () => {
    const exec = new DeriveExecutor();
    let eventFired = false;
    exec.on('derive-created', () => { eventFired = true; });
    await exec.derive('Event test');
    assert.strictEqual(eventFired, true);
    exec.shutdown();
  });

  it('should throw on empty objective', async () => {
    const exec = new DeriveExecutor();
    await assert.rejects(() => exec.derive(''), /INVALID_INPUT/);
    exec.shutdown();
  });

  it('should throw on capacity exceeded', async () => {
    const exec = new DeriveExecutor({ maxDerivations: 1 });
    await exec.derive('First');
    await assert.rejects(() => exec.derive('Second'), /CAPACITY_EXCEEDED/);
    exec.shutdown();
  });

  it('should throw on derive during shutdown', async () => {
    const exec = new DeriveExecutor();
    exec.shutdown();
    await assert.rejects(() => exec.derive('After shutdown'), /\[SHUTDOWN\]/);
  });
});

describe('DeriveExecutor - merge', () => {
  it('should merge an active derivation', async () => {
    const exec = new DeriveExecutor({ autoCleanupMerged: false });
    const wlm = createMockWorldLineManager();
    const wtm = createMockWorktreeManager();
    exec.attachWorldLineManager(wlm);
    exec.attachWorktreeManager(wtm);

    const { deriveId, worldLineId: _worldLineId, worktreeId: _worktreeId } = await exec.derive('Merge test', { agentId: 'merge-1' });
    const targetWl = wlm.createWorldLine('main-line', {});

    const result = await exec.merge(deriveId, { targetWorldLineId: targetWl.worldLineId });
    assert.strictEqual(result.success, true);

    const d = exec.getDerivation(deriveId);
    assert.strictEqual(d.status, 'merged');
    exec.shutdown();
  });

  it('should emit derive-merged event', async () => {
    const exec = new DeriveExecutor({ autoCleanupMerged: false });
    let eventFired = false;
    exec.on('derive-merged', () => { eventFired = true; });

    const { deriveId } = await exec.derive('Merge event test');
    await exec.merge(deriveId);
    assert.strictEqual(eventFired, true);
    exec.shutdown();
  });

  it('should return error for non-existent derivation', async () => {
    const exec = new DeriveExecutor();
    const result = await exec.merge('nonexistent');
    assert.strictEqual(result.success, false);
    exec.shutdown();
  });

  it('should return error for non-active derivation', async () => {
    const exec = new DeriveExecutor({ autoCleanupMerged: false });
    const { deriveId } = await exec.derive('Test');
    await exec.merge(deriveId);
    const result = await exec.merge(deriveId);
    assert.strictEqual(result.success, false);
    exec.shutdown();
  });
});

describe('DeriveExecutor - abandon', () => {
  it('should abandon an active derivation', async () => {
    const exec = new DeriveExecutor();
    const { deriveId } = await exec.derive('Abandon test');
    const result = await exec.abandon(deriveId);
    assert.strictEqual(result.success, true);

    const d = exec.getDerivation(deriveId);
    assert.strictEqual(d.status, 'abandoned');
    exec.shutdown();
  });

  it('should emit derive-abandoned event', async () => {
    const exec = new DeriveExecutor();
    let eventFired = false;
    exec.on('derive-abandoned', () => { eventFired = true; });

    const { deriveId } = await exec.derive('Abandon event test');
    await exec.abandon(deriveId);
    assert.strictEqual(eventFired, true);
    exec.shutdown();
  });

  it('should cleanup worktree on abandon', async () => {
    const exec = new DeriveExecutor();
    const wtm = createMockWorktreeManager();
    exec.attachWorktreeManager(wtm);

    const { deriveId, worktreeId } = await exec.derive('Cleanup test', { agentId: 'cleanup-1' });
    assert.ok(wtm._worktrees.has(worktreeId));

    await exec.abandon(deriveId);
    assert.strictEqual(wtm._worktrees.has(worktreeId), false);
    exec.shutdown();
  });

  it('should return error for non-existent derivation', async () => {
    const exec = new DeriveExecutor();
    const result = await exec.abandon('nonexistent');
    assert.strictEqual(result.success, false);
    exec.shutdown();
  });
});

describe('DeriveExecutor - query', () => {
  it('should get derivation details', async () => {
    const exec = new DeriveExecutor();
    const { deriveId } = await exec.derive('Query test', { acceptanceCriteria: ['A', 'B'] });
    const d = exec.getDerivation(deriveId);
    assert.strictEqual(d.deriveId, deriveId);
    assert.strictEqual(d.objective, 'Query test');
    assert.strictEqual(d.status, 'active');
    assert.deepStrictEqual(d.acceptanceCriteria, ['A', 'B']);
    exec.shutdown();
  });

  it('should return null for non-existent derivation', () => {
    const exec = new DeriveExecutor();
    const d = exec.getDerivation('nonexistent');
    assert.strictEqual(d, null);
    exec.shutdown();
  });

  it('should list derivations', async () => {
    const exec = new DeriveExecutor({ maxDerivations: 10 });
    await exec.derive('First');
    await exec.derive('Second');
    const list = exec.listDerivations();
    assert.strictEqual(list.length, 2);
    exec.shutdown();
  });

  it('should list derivations by status', async () => {
    const exec = new DeriveExecutor({ maxDerivations: 10, autoCleanupMerged: false });
    await exec.derive('Active');
    const { deriveId } = await exec.derive('To merge');
    await exec.merge(deriveId);

    const active = exec.listDerivations('active');
    const merged = exec.listDerivations('merged');
    assert.strictEqual(active.length, 1);
    assert.strictEqual(merged.length, 1);
    exec.shutdown();
  });

  it('should get stats', async () => {
    const exec = new DeriveExecutor({ maxDerivations: 10, autoCleanupMerged: false });
    await exec.derive('Stat 1');
    const { deriveId } = await exec.derive('Stat 2');
    await exec.abandon(deriveId);

    const stats = exec.getStats();
    assert.strictEqual(stats.created, 2);
    assert.strictEqual(stats.abandoned, 1);
    assert.strictEqual(stats.active, 1);
    exec.shutdown();
  });
});

describe('DeriveExecutor - shutdown', () => {
  it('should auto-abandon active derivations on shutdown', async () => {
    const exec = new DeriveExecutor();
    await exec.derive('Will be abandoned');
    exec.shutdown();
    const stats = exec.getStats();
    assert.strictEqual(stats.total, 0);
  });

  it('should throw on derive after shutdown', async () => {
    const exec = new DeriveExecutor();
    exec.shutdown();
    await assert.rejects(() => exec.derive('After shutdown'), /\[SHUTDOWN\]/);
  });
});
