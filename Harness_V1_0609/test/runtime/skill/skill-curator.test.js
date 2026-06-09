'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..', '..');
const SkillCurator = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-curator'));

const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  }
});

function createTempProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-test-'));
  fs.mkdirSync(path.join(dir, '.harness', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'skills', '.backups'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'skills', '.snapshots'), { recursive: true });
  TEMP_DIRS.push(dir);
  return dir;
}

function createMockSkillRouter(skills) {
  const skillList = skills || [
    { skill_id: 'brainstorming', name: 'Brainstorming', phase: 'requirement-analysis' },
    { skill_id: 'tdd-implement', name: 'TDD Implement', phase: 'module-development' },
    { skill_id: 'code-review', name: 'Code Review', phase: 'module-development' },
  ];
  return {
    skills: skillList,
    registry: {},
  };
}

describe('SkillCurator constructor', () => {
  it('should create instance with default options', () => {
    const curator = new SkillCurator({});
    assert.ok(curator);
    assert.equal(curator._projectRoot, '');
    assert.equal(curator._skillRouter, null);
    assert.equal(curator._sqliteStore, null);
  });

  it('should accept options', () => {
    const router = createMockSkillRouter();
    const curator = new SkillCurator({ projectRoot: '/tmp/test', skillRouter: router });
    assert.equal(curator._projectRoot, '/tmp/test');
    assert.equal(curator._skillRouter, router);
  });
});

describe('SkillCurator source classification', () => {
  it('should classify a skill source', () => {
    const curator = new SkillCurator({});
    curator.classifySkill('brainstorming', 'builtin');
    assert.equal(curator.getClassification('brainstorming'), 'builtin');
  });

  it('should return unknown for unclassified skill', () => {
    const curator = new SkillCurator({});
    assert.equal(curator.getClassification('unknown-skill'), 'unknown');
  });

  it('should reject invalid source types', () => {
    const curator = new SkillCurator({});
    assert.throws(() => curator.classifySkill('test', 'invalid'), /Invalid source/);
  });

  it('should list all classifications', () => {
    const curator = new SkillCurator({});
    curator.classifySkill('a', 'builtin');
    curator.classifySkill('b', 'user');
    curator.classifySkill('c', 'evolved');
    const classifications = curator.listClassifications();
    assert.equal(classifications.builtin.length, 1);
    assert.equal(classifications.user.length, 1);
    assert.equal(classifications.evolved.length, 1);
    assert.equal(classifications.generated.length, 0);
  });

  it('should reclassify a skill', () => {
    const curator = new SkillCurator({});
    curator.classifySkill('test', 'builtin');
    curator.classifySkill('test', 'user');
    assert.equal(curator.getClassification('test'), 'user');
  });
});

describe('SkillCurator pin protection', () => {
  it('should pin a skill', () => {
    const curator = new SkillCurator({});
    curator.pinSkill('brainstorming', 'Core skill - never archive');
    assert.equal(curator.isPinned('brainstorming'), true);
  });

  it('should unpin a skill', () => {
    const curator = new SkillCurator({});
    curator.pinSkill('brainstorming', 'Core skill');
    curator.unpinSkill('brainstorming');
    assert.equal(curator.isPinned('brainstorming'), false);
  });

  it('should return false for unpinned skill', () => {
    const curator = new SkillCurator({});
    assert.equal(curator.isPinned('unknown'), false);
  });

  it('should list all pinned skills', () => {
    const curator = new SkillCurator({});
    curator.pinSkill('a', 'reason a');
    curator.pinSkill('b', 'reason b');
    const pinned = curator.listPinned();
    assert.equal(pinned.length, 2);
    assert.ok(pinned.some(p => p.skillId === 'a'));
    assert.ok(pinned.some(p => p.skillId === 'b'));
  });

  it('should include reason in pin info', () => {
    const curator = new SkillCurator({});
    curator.pinSkill('test', 'Critical skill');
    const pinned = curator.listPinned();
    assert.equal(pinned[0].reason, 'Critical skill');
  });

  it('should skip pinned skills during curation', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'pinned-skill', name: 'Pinned' },
      { skill_id: 'unpinned-skill', name: 'Unpinned' },
    ]);
    curator.attachSkillRouter(router);
    curator.pinSkill('pinned-skill', 'Protected');

    curator.recordUsage('pinned-skill', { success: false, duration: 100 });
    curator.recordUsage('pinned-skill', { success: false, duration: 100 });
    curator.recordUsage('pinned-skill', { success: false, duration: 100 });
    curator.recordUsage('pinned-skill', { success: false, duration: 100 });
    curator.recordUsage('pinned-skill', { success: false, duration: 100 });

    curator.recordUsage('unpinned-skill', { success: false, duration: 100 });
    curator.recordUsage('unpinned-skill', { success: false, duration: 100 });
    curator.recordUsage('unpinned-skill', { success: false, duration: 100 });
    curator.recordUsage('unpinned-skill', { success: false, duration: 100 });
    curator.recordUsage('unpinned-skill', { success: false, duration: 100 });

    const lowQualityEvents = [];
    curator.on('skill-low-quality', (data) => lowQualityEvents.push(data));
    curator.runCuration();

    assert.equal(lowQualityEvents.length, 1);
    assert.equal(lowQualityEvents[0].skillId, 'unpinned-skill');
  });
});

describe('SkillCurator classification-aware curation', () => {
  it('should be more lenient with builtin skills', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'builtin-skill', name: 'Builtin' },
      { skill_id: 'user-skill', name: 'User' },
    ]);
    curator.attachSkillRouter(router);
    curator.classifySkill('builtin-skill', 'builtin');
    curator.classifySkill('user-skill', 'user');

    curator.recordUsage('builtin-skill', { success: true, duration: 100 });
    for (let i = 0; i < 4; i++) {
      curator.recordUsage('builtin-skill', { success: false, duration: 100 });
    }

    curator.recordUsage('user-skill', { success: true, duration: 100 });
    for (let i = 0; i < 4; i++) {
      curator.recordUsage('user-skill', { success: false, duration: 100 });
    }

    const lowQualityEvents = [];
    curator.on('skill-low-quality', (data) => lowQualityEvents.push(data));
    curator.runCuration();

    assert.equal(lowQualityEvents.length, 1);
    assert.equal(lowQualityEvents[0].skillId, 'user-skill');
  });

  it('should flag generated skills at normal threshold', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'gen-skill', name: 'Generated' },
    ]);
    curator.attachSkillRouter(router);
    curator.classifySkill('gen-skill', 'generated');

    for (let i = 0; i < 5; i++) {
      curator.recordUsage('gen-skill', { success: false, duration: 100 });
    }

    const lowQualityEvents = [];
    curator.on('skill-low-quality', (data) => lowQualityEvents.push(data));
    curator.runCuration();

    assert.equal(lowQualityEvents.length, 1);
  });
});

describe('SkillCurator idle detection', () => {
  it('should attach idle detector', () => {
    const curator = new SkillCurator({});
    const detector = { isIdle: () => true };
    curator.attachIdleDetector(detector);
    assert.equal(curator._idleDetector, detector);
  });

  it('should start smart curation', () => {
    const curator = new SkillCurator({});
    const detector = { isIdle: () => true };
    curator.attachIdleDetector(detector);
    curator.startSmartCuration({ interval: 100 });
    assert.ok(curator._smartTimer);
    curator.stopSmartCuration();
  });

  it('should stop smart curation', () => {
    const curator = new SkillCurator({});
    const detector = { isIdle: () => true };
    curator.attachIdleDetector(detector);
    curator.startSmartCuration({ interval: 100 });
    curator.stopSmartCuration();
    assert.equal(curator._smartTimer, null);
  });

  it('should only run curation when idle', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'test-skill', name: 'Test' },
    ]);
    curator.attachSkillRouter(router);
    let isIdleCalled = false;
    const detector = {
      isIdle: () => {
        isIdleCalled = true;
        return false;
      },
    };
    curator.attachIdleDetector(detector);

    curator.recordUsage('test-skill', { success: true, duration: 50 });
    const result = curator._smartCurationCheck();
    assert.ok(isIdleCalled);
    assert.equal(result, null);
  });

  it('should run curation when idle returns true', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'test-skill', name: 'Test' },
    ]);
    curator.attachSkillRouter(router);
    const detector = { isIdle: () => true };
    curator.attachIdleDetector(detector);

    curator.recordUsage('test-skill', { success: true, duration: 50 });
    const result = curator._smartCurationCheck();
    assert.ok(result);
    assert.equal(result.reviewed, 1);
  });
});

describe('SkillCurator dry-run mode', () => {
  it('should simulate curation without emitting events', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'low-quality', name: 'Low Quality' },
    ]);
    curator.attachSkillRouter(router);

    for (let i = 0; i < 5; i++) {
      curator.recordUsage('low-quality', { success: false, duration: 100 });
    }

    const events = [];
    curator.on('skill-low-quality', (data) => events.push(data));

    const result = curator.dryRunCuration();
    assert.ok(result);
    assert.equal(result.wouldFlag.length, 1);
    assert.equal(result.wouldFlag[0].skillId, 'low-quality');
    assert.equal(result.wouldFlag[0].reason, 'low-quality');
    assert.equal(events.length, 0);
  });

  it('should identify stale skills in dry-run', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'stale-skill', name: 'Stale' },
    ]);
    curator.attachSkillRouter(router);

    curator.recordUsage('stale-skill', { success: true, duration: 50 });
    const tracker = curator._usageTracker.get('stale-skill');
    tracker.lastUsed = Date.now() - 31 * 86400000;

    const result = curator.dryRunCuration();
    assert.equal(result.wouldFlag.length, 1);
    assert.equal(result.wouldFlag[0].reason, 'stale');
  });

  it('should skip pinned skills in dry-run', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'pinned-skill', name: 'Pinned' },
    ]);
    curator.attachSkillRouter(router);
    curator.pinSkill('pinned-skill', 'Protected');

    for (let i = 0; i < 5; i++) {
      curator.recordUsage('pinned-skill', { success: false, duration: 100 });
    }

    const result = curator.dryRunCuration();
    assert.equal(result.wouldFlag.length, 0);
    assert.equal(result.skippedPinned, 1);
  });

  it('should not update stats in dry-run', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'test-skill', name: 'Test' },
    ]);
    curator.attachSkillRouter(router);
    curator.recordUsage('test-skill', { success: true, duration: 50 });

    const statsBefore = curator.getAllStats().curatorStats.curated;
    curator.dryRunCuration();
    const statsAfter = curator.getAllStats().curatorStats.curated;
    assert.equal(statsBefore, statsAfter);
  });
});

describe('SkillCurator snapshot and rollback', () => {
  it('should create a snapshot', () => {
    const projectRoot = createTempProjectRoot();
    const curator = new SkillCurator({ projectRoot });
    curator.recordUsage('skill-a', { success: true, duration: 50 });
    curator.recordUsage('skill-b', { success: false, duration: 100 });
    curator.classifySkill('skill-a', 'builtin');
    curator.pinSkill('skill-a', 'Core');

    const snapshot = curator.createSnapshot();
    assert.ok(snapshot);
    assert.ok(snapshot.id);
    assert.ok(snapshot.timestamp);
    assert.equal(snapshot.usageEntries, 2);
    assert.equal(snapshot.pinnedCount, 1);
    assert.equal(snapshot.classificationCount, 1);
  });

  it('should list snapshots', () => {
    const projectRoot = createTempProjectRoot();
    const curator = new SkillCurator({ projectRoot });
    curator.createSnapshot();
    curator.createSnapshot();

    const snapshots = curator.listSnapshots();
    assert.ok(snapshots.length >= 2);
  });

  it('should rollback to a snapshot', () => {
    const projectRoot = createTempProjectRoot();
    const curator = new SkillCurator({ projectRoot });
    curator.recordUsage('skill-a', { success: true, duration: 50 });
    curator.classifySkill('skill-a', 'builtin');
    curator.pinSkill('skill-a', 'Core');

    const snapshot = curator.createSnapshot();

    curator.recordUsage('skill-b', { success: false, duration: 100 });
    curator.classifySkill('skill-b', 'generated');
    curator.unpinSkill('skill-a');

    assert.equal(curator.isPinned('skill-a'), false);
    assert.ok(curator._usageTracker.get('skill-b'));

    const result = curator.rollbackToSnapshot(snapshot.id);
    assert.equal(result.success, true);

    assert.equal(curator.isPinned('skill-a'), true);
    assert.equal(curator.getClassification('skill-a'), 'builtin');
    assert.ok(curator._usageTracker.get('skill-a'));
    assert.ok(!curator._usageTracker.get('skill-b'));
  });

  it('should return error for non-existent snapshot', () => {
    const projectRoot = createTempProjectRoot();
    const curator = new SkillCurator({ projectRoot });
    const result = curator.rollbackToSnapshot('nonexistent');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('not found'));
  });

  it('should persist snapshots to disk', async () => {
    const projectRoot = createTempProjectRoot();
    const curator = new SkillCurator({ projectRoot });
    curator.recordUsage('test', { success: true, duration: 50 });
    curator.createSnapshot();

    await new Promise(resolve => setTimeout(resolve, 100));

    const snapshotDir = path.join(projectRoot, '.harness', 'skills', '.snapshots');
    assert.ok(fs.existsSync(snapshotDir));

    const files = fs.readdirSync(snapshotDir).filter(f => f.endsWith('.json'));
    assert.ok(files.length > 0);
  });

  it('should limit snapshot count', () => {
    const projectRoot = createTempProjectRoot();
    const curator = new SkillCurator({ projectRoot, maxSnapshots: 3 });
    for (let i = 0; i < 5; i++) {
      curator.createSnapshot();
    }
    const snapshots = curator.listSnapshots();
    assert.ok(snapshots.length <= 3);
  });
});

describe('SkillCurator recordUsage', () => {
  it('should track usage statistics', () => {
    const curator = new SkillCurator({});
    curator.recordUsage('test-skill', { success: true, duration: 50 });
    curator.recordUsage('test-skill', { success: false, duration: 100 });
    const stats = curator.getSkillStats('test-skill');
    assert.equal(stats.calls, 2);
    assert.equal(stats.successes, 1);
    assert.equal(stats.failures, 1);
    assert.equal(stats.totalDuration, 150);
  });

  it('should ignore invalid skillId', () => {
    const curator = new SkillCurator({});
    curator.recordUsage('', { success: true });
    curator.recordUsage(null, { success: true });
    curator.recordUsage(123, { success: true });
    assert.equal(Object.keys(curator._usageTracker).length, 0);
  });
});

describe('SkillCurator runCuration', () => {
  it('should detect low-quality skills', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'bad-skill', name: 'Bad' },
    ]);
    curator.attachSkillRouter(router);

    for (let i = 0; i < 5; i++) {
      curator.recordUsage('bad-skill', { success: false, duration: 100 });
    }

    const events = [];
    curator.on('skill-low-quality', (data) => events.push(data));
    curator.runCuration();

    assert.equal(events.length, 1);
    assert.equal(events[0].skillId, 'bad-skill');
    assert.ok(events[0].successRate < 0.3);
  });

  it('should detect stale skills', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'old-skill', name: 'Old' },
    ]);
    curator.attachSkillRouter(router);

    curator.recordUsage('old-skill', { success: true, duration: 50 });
    const tracker = curator._usageTracker.get('old-skill');
    tracker.lastUsed = Date.now() - 31 * 86400000;

    const events = [];
    curator.on('skill-stale', (data) => events.push(data));
    curator.runCuration();

    assert.equal(events.length, 1);
    assert.equal(events[0].skillId, 'old-skill');
  });

  it('should return empty result without router', () => {
    const curator = new SkillCurator({});
    const result = curator.runCuration();
    assert.equal(result.archived, 0);
    assert.equal(result.stale, 0);
    assert.equal(result.reviewed, 0);
  });
});

describe('SkillCurator getAllStats', () => {
  it('should include pin and classification info', () => {
    const curator = new SkillCurator({});
    curator.classifySkill('a', 'builtin');
    curator.pinSkill('a', 'Core');
    curator.recordUsage('a', { success: true, duration: 50 });

    const stats = curator.getAllStats();
    assert.ok(stats.curatorStats);
    assert.equal(stats.pinnedCount, 1);
    assert.equal(stats.classificationCount, 1);
  });
});

describe('SkillCurator shutdown', () => {
  it('should clean up on shutdown', () => {
    const curator = new SkillCurator({});
    curator.recordUsage('test', { success: true, duration: 50 });
    curator.classifySkill('test', 'builtin');
    curator.pinSkill('test', 'Core');
    curator.startAutoCuration(1000);

    curator.shutdown();

    assert.equal(Object.keys(curator._usageTracker).length, 0);
    assert.equal(curator._timer, null);
  });

  it('should stop smart curation on shutdown', () => {
    const curator = new SkillCurator({});
    const detector = { isIdle: () => true };
    curator.attachIdleDetector(detector);
    curator.startSmartCuration({ interval: 100 });

    curator.shutdown();
    assert.equal(curator._smartTimer, null);
  });
});

describe('SkillCurator regression: division by zero', () => {
  it('should handle calls=0 gracefully in runCuration after snapshot restore', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'zero-calls', name: 'Zero Calls' },
    ]);
    curator.attachSkillRouter(router);
    curator._usageTracker.set('zero-calls', { calls: 0, successes: 0, failures: 0, lastUsed: 0, totalDuration: 0 });
    const result = curator.runCuration();
    assert.ok(Number.isFinite(result.archived));
    assert.ok(Number.isFinite(result.stale));
    assert.ok(Number.isFinite(result.reviewed));
  });

  it('should handle calls=0 gracefully in dryRunCuration', () => {
    const curator = new SkillCurator({});
    const router = createMockSkillRouter([
      { skill_id: 'zero-calls', name: 'Zero Calls' },
    ]);
    curator.attachSkillRouter(router);
    curator._usageTracker.set('zero-calls', { calls: 0, successes: 0, failures: 0, lastUsed: 0, totalDuration: 0 });
    const result = curator.dryRunCuration();
    assert.ok(Number.isFinite(result.reviewed));
    for (const flag of result.wouldFlag) {
      assert.ok(Number.isFinite(flag.successRate));
    }
  });
});
