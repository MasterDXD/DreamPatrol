'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const AutoVersionTracker = require('../../../src/runtime/infrastructure/auto-version-tracker');
const EventBus = require('../../../src/runtime/infrastructure/event-bus');
const ChangelogArchive = require('../../../src/web/changelog-archive');

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-avt-test-'));
}

function createMockArchive(tmpDir) {
  return new ChangelogArchive(tmpDir);
}

describe('AutoVersionTracker', () => {
  let tmpDir;
  let archive;
  let eventBus;

  beforeEach(() => {
    tmpDir = createTmpDir();
    archive = createMockArchive(tmpDir);
    eventBus = new EventBus();
  });

  afterEach(() => {
    if (eventBus) eventBus.shutdown();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should initialize with default config', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir });
    const stats = avt.getStats();
    assert.equal(stats.enabled, true);
    assert.equal(stats.recorded, 0);
    assert.equal(stats.skipped, 0);
    assert.equal(stats.errors, 0);
    assert.equal(stats.pendingCount, 0);
    assert.ok(Array.isArray(stats.trackedEvents));
    assert.ok(stats.trackedEvents.length > 0);
    avt.shutdown();
  });

  it('should initialize disabled when config.enabled is false', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { enabled: false } });
    const stats = avt.getStats();
    assert.equal(stats.enabled, false);
    avt.shutdown();
  });

  it('should track session:skill-complete event', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('session:skill-complete', { skillId: 'tdd-implement', sessionId: 'sess-001' });
    const stats = avt.getStats();
    assert.ok(stats.recorded >= 1);
    avt.shutdown();
  });

  it('should track session:phase-change event', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('session:phase-change', { from: 'exploration', to: 'analysis', sessionId: 'sess-002' });
    const stats = avt.getStats();
    assert.ok(stats.recorded >= 1);
    avt.shutdown();
  });

  it('should track pair-chat:consensus-reached event', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('pair-chat:consensus-reached', { agentId: 'analyst', sessionId: 'sess-003' });
    const stats = avt.getStats();
    assert.ok(stats.recorded >= 1);
    avt.shutdown();
  });

  it('should track deepening:converged event', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('deepening:converged', { agentId: 'worker', result: 'converged' });
    const stats = avt.getStats();
    assert.ok(stats.recorded >= 1);
    avt.shutdown();
  });

  it('should ignore untracked events', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 10 } });
    eventBus.emit('untracked:event', { data: 'test' });
    const stats = avt.getStats();
    assert.equal(stats.recorded, 0);
    assert.equal(stats.pendingCount, 0);
    avt.shutdown();
  });

  it('should flush when buffer reaches maxBufferSize', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 60000, maxBufferSize: 2 } });
    eventBus.emit('session:skill-complete', { skillId: 'skill-1' });
    eventBus.emit('session:skill-complete', { skillId: 'skill-2' });
    const stats = avt.getStats();
    assert.equal(stats.recorded, 2);
    assert.equal(stats.pendingCount, 0);
    avt.shutdown();
  });

  it('should flush on shutdown', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 60000, maxBufferSize: 100 } });
    eventBus.emit('session:skill-complete', { skillId: 'skill-1' });
    assert.equal(avt.getStats().pendingCount, 1);
    avt.shutdown();
    const recent = avt.getRecentRecords(10);
    assert.ok(recent.length >= 1);
  });

  it('should increment version counter for each recorded event', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('session:skill-complete', { skillId: 'skill-1' });
    eventBus.emit('session:phase-change', { to: 'analysis', sessionId: 's1' });
    eventBus.emit('agent:deployed', { agentId: 'agent-1' });
    const stats = avt.getStats();
    assert.ok(stats.recorded >= 3);
    assert.ok(stats.lastRecordedVersion);
    assert.ok(stats.versionCounter >= 3);
    avt.shutdown();
  });

  it('should use custom version prefix', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1, versionPrefix: '1.2.' } });
    eventBus.emit('session:skill-complete', { skillId: 'skill-1' });
    const recent = avt.getRecentRecords(1);
    assert.ok(recent.length >= 1);
    assert.ok(recent[0].version.startsWith('1.2.'));
    avt.shutdown();
  });

  it('should return recent records', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('session:skill-complete', { skillId: 'skill-a' });
    eventBus.emit('session:skill-complete', { skillId: 'skill-b' });
    eventBus.emit('session:skill-complete', { skillId: 'skill-c' });
    const recent = avt.getRecentRecords(2);
    assert.ok(recent.length <= 2);
    avt.shutdown();
  });
});

describe('AutoVersionTracker - Events and Persistence', () => {
  let tmpDir;
  let archive;
  let eventBus;

  beforeEach(() => {
    tmpDir = createTmpDir();
    archive = createMockArchive(tmpDir);
    eventBus = new EventBus();
  });

  afterEach(() => {
    if (eventBus) eventBus.shutdown();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return empty recent records when no archive', () => {
    const avt = new AutoVersionTracker({ archive: null, eventBus, projectRoot: tmpDir, config: { enabled: false } });
    const recent = avt.getRecentRecords(10);
    assert.deepEqual(recent, []);
    avt.shutdown();
  });

  it('should not record when disabled', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { enabled: false } });
    eventBus.emit('session:skill-complete', { skillId: 'skill-1' });
    const stats = avt.getStats();
    assert.equal(stats.recorded, 0);
    avt.shutdown();
  });

  it('should categorize events correctly', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('agent:deployed', { agentId: 'agent-1' });
    const recent = avt.getRecentRecords(1);
    assert.ok(recent.length >= 1);
    assert.equal(recent[0].category, '新增');
    avt.shutdown();
  });

  it('should categorize failure events as 修复', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('subagent:failed', { agentId: 'agent-1' });
    const recent = avt.getRecentRecords(1);
    assert.ok(recent.length >= 1);
    assert.equal(recent[0].category, '修复');
    avt.shutdown();
  });

  it('should expose EVENT_CATEGORY_MAP as static property', () => {
    assert.ok(AutoVersionTracker.EVENT_CATEGORY_MAP);
    assert.ok(typeof AutoVersionTracker.EVENT_CATEGORY_MAP === 'object');
    assert.ok(AutoVersionTracker.EVENT_CATEGORY_MAP['session:skill-complete']);
  });

  it('should load last version from archive on init', () => {
    archive.record({ version: '0.0.5', changes: [{ title: 'test' }], category: '变更', summary: 'init' });
    archive._indexCache = null;
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('session:skill-complete', { skillId: 'skill-1' });
    const recent = avt.getRecentRecords(1);
    assert.ok(recent.length >= 1);
    assert.ok(recent[0].version.match(/^0\.0\.\d+$/));
    const counter = parseInt(recent[0].version.split('.')[2], 10);
    assert.ok(counter > 5, 'Version counter should be greater than 5 after loading from archive');
    avt.shutdown();
  });

  it('should handle archive record failure gracefully', () => {
    const badArchive = {
      _readIndex: () => ({ versions: [] }),
      record: () => ({ success: false, error: 'test error' }),
    };
    const avt = new AutoVersionTracker({ archive: badArchive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('session:skill-complete', { skillId: 'skill-1' });
    const stats = avt.getStats();
    assert.equal(stats.recorded, 0);
    assert.ok(stats.skipped >= 1);
    avt.shutdown();
  });

  it('should handle archive exception gracefully', () => {
    const crashArchive = {
      _readIndex: () => ({ versions: [] }),
      record: () => { throw new Error('crash'); },
    };
    const avt = new AutoVersionTracker({ archive: crashArchive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('session:skill-complete', { skillId: 'skill-1' });
    const stats = avt.getStats();
    assert.equal(stats.recorded, 0);
    assert.ok(stats.errors >= 1);
    avt.shutdown();
  });

  it('should work without eventBus', () => {
    const avt = new AutoVersionTracker({ archive, eventBus: null, projectRoot: tmpDir, config: { enabled: true } });
    const stats = avt.getStats();
    assert.equal(stats.enabled, true);
    avt.shutdown();
  });

  it('should work without archive', () => {
    const avt = new AutoVersionTracker({ archive: null, eventBus, projectRoot: tmpDir, config: { enabled: true } });
    eventBus.emit('session:skill-complete', { skillId: 'skill-1' });
    const stats = avt.getStats();
    assert.equal(stats.recorded, 0);
    avt.shutdown();
  });

  it('should write to CHANGELOG.md on auto event flush', async () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('session:skill-complete', { skillId: 'tdd-implement', sessionId: 'sess-cl' });
    await avt.waitForPendingWrites();
    const changelogPath = path.join(tmpDir, 'CHANGELOG.md');
    const content = fs.readFileSync(changelogPath, 'utf-8');
    assert.ok(content.includes('tdd-implement'), 'CHANGELOG.md should contain skill id');
    assert.ok(content.includes('技能完成'), 'CHANGELOG.md should contain event label');
    avt.shutdown();
  });

  it('should emit version-recorded event on flush', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    let emitted = null;
    avt.on('version-recorded', (data) => { emitted = data; });
    eventBus.emit('session:skill-complete', { skillId: 'tdd-implement', sessionId: 'sess-emit' });
    assert.ok(emitted, 'version-recorded event should be emitted');
    assert.ok(emitted.version, 'emitted data should have version');
    assert.ok(emitted.summary, 'emitted data should have summary');
    assert.equal(emitted.category, '变更');
    avt.shutdown();
  });

  it('should track new AI modification events', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('ai:config-changed', { agentId: 'AI', files: ['config.json'] });
    const recent = avt.getRecentRecords(1);
    assert.ok(recent.length >= 1);
    assert.equal(recent[0].category, '变更');
    avt.shutdown();
  });

  it('should track goal:completed event', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('goal:completed', { goalId: 'goal-1', objective: 'test' });
    const recent = avt.getRecentRecords(1);
    assert.ok(recent.length >= 1);
    assert.equal(recent[0].category, '变更');
    avt.shutdown();
  });

  it('should track skill:created event as 新增', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('skill:created', { skillName: 'new-skill' });
    const recent = avt.getRecentRecords(1);
    assert.ok(recent.length >= 1);
    assert.equal(recent[0].category, '新增');
    avt.shutdown();
  });

  it('should track file:changed event', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('file:changed', { filePath: 'src/test.js', changeType: 'modify' });
    const recent = avt.getRecentRecords(1);
    assert.ok(recent.length >= 1);
    assert.equal(recent[0].category, '变更');
    avt.shutdown();
  });

  it('should track ai:removed event as 移除', () => {
    const avt = new AutoVersionTracker({ archive, eventBus, projectRoot: tmpDir, config: { flushInterval: 100, maxBufferSize: 1 } });
    eventBus.emit('ai:removed', { agentId: 'AI', files: ['old-module.js'] });
    const recent = avt.getRecentRecords(1);
    assert.ok(recent.length >= 1);
    assert.equal(recent[0].category, '移除');
    avt.shutdown();
  });
});
