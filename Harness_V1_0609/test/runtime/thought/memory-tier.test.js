'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SqliteStore = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'sqlite-store'));

describe('Memory Tier System', () => {
  let store;
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `tier-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = new SqliteStore(tmpDir);
    store.init();
  });

  afterEach(() => {
    if (store) store.shutdown();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should add memory with tier', () => {
    const result = store.addMemory('test-target', 'working memory content', { tier: 'working' });
    assert.ok(result.success);
    const entry = store.getMemoryById(result.id);
    assert.ok(entry);
    assert.strictEqual(entry.tier, 'working');
  });

  it('should default tier to episodic', () => {
    const result = store.addMemory('test-target', 'default tier content');
    const entry = store.getMemoryById(result.id);
    assert.strictEqual(entry.tier, 'episodic');
  });

  it('should promote memory from working to episodic', () => {
    const result = store.addMemory('test-target', 'promote me', { tier: 'working' });
    const promoted = store.promoteMemory(result.id, 'episodic');
    assert.strictEqual(promoted, true);
    const entry = store.getMemoryById(result.id);
    assert.strictEqual(entry.tier, 'episodic');
    assert.ok(entry.promoted_at > 0);
  });

  it('should promote memory from episodic to semantic', () => {
    const result = store.addMemory('test-target', 'promote to semantic', { tier: 'episodic' });
    const promoted = store.promoteMemory(result.id, 'semantic');
    assert.strictEqual(promoted, true);
    const entry = store.getMemoryById(result.id);
    assert.strictEqual(entry.tier, 'semantic');
  });

  it('should demote memory from semantic to episodic', () => {
    const result = store.addMemory('test-target', 'demote me', { tier: 'semantic' });
    const demoted = store.demoteMemory(result.id, 'episodic');
    assert.strictEqual(demoted, true);
    const entry = store.getMemoryById(result.id);
    assert.strictEqual(entry.tier, 'episodic');
    assert.ok(entry.demoted_at > 0);
  });

  it('should return false for invalid promote direction', () => {
    const result = store.addMemory('test-target', 'wrong direction', { tier: 'semantic' });
    const promoted = store.promoteMemory(result.id, 'working');
    assert.strictEqual(promoted, false);
  });

  it('should expire memories older than max age for tier', () => {
    const result = store.addMemory('test-target', 'old memory', { tier: 'working' });
    store._db.prepare('UPDATE memory_entries SET created_at = ? WHERE id = ?').run(Date.now() - 86400000 * 8, result.id);
    const expired = store.expireMemories('working', 7);
    assert.strictEqual(expired, 1);
    const entry = store.getMemoryById(result.id);
    assert.strictEqual(entry, null);
  });

  it('should not expire memories within max age', () => {
    const result = store.addMemory('test-target', 'fresh memory', { tier: 'working' });
    const expired = store.expireMemories('working', 7);
    assert.strictEqual(expired, 0);
    const entry = store.getMemoryById(result.id);
    assert.ok(entry);
  });

  it('should forget memory by ID', () => {
    const result = store.addMemory('test-target', 'forget me', { tier: 'episodic' });
    const forgotten = store.forgetMemory(result.id);
    assert.strictEqual(forgotten, true);
    const entry = store.getMemoryById(result.id);
    assert.strictEqual(entry, null);
  });

  it('should return false when forgetting non-existent memory', () => {
    const forgotten = store.forgetMemory(99999);
    assert.strictEqual(forgotten, false);
  });

  it('should get memories by tier', () => {
    store.addMemory('t1', 'working content', { tier: 'working' });
    store.addMemory('t2', 'episodic content', { tier: 'episodic' });
    store.addMemory('t3', 'semantic content', { tier: 'semantic' });
    const working = store.getMemoriesByTier('working');
    const episodic = store.getMemoriesByTier('episodic');
    const semantic = store.getMemoriesByTier('semantic');
    assert.strictEqual(working.length, 1);
    assert.strictEqual(episodic.length, 1);
    assert.strictEqual(semantic.length, 1);
  });

  it('should decay memory importance over time', () => {
    const result = store.addMemory('test-target', 'decay me', { tier: 'episodic', importance: 1.0 });
    store._db.prepare('UPDATE memory_entries SET last_accessed_at = ? WHERE id = ?').run(Date.now() - 86400000 * 30, result.id);
    store.decayMemoryImportance();
    const entry = store.getMemoryById(result.id);
    assert.ok(entry.importance < 1.0);
    assert.ok(entry.importance > 0);
  });

  it('should update access count on read', () => {
    const result = store.addMemory('test-target', 'access me', { tier: 'episodic' });
    store.getMemoryById(result.id);
    store.getMemoryById(result.id);
    const entry = store.getMemoryById(result.id);
    assert.ok(entry.access_count >= 2);
  });
});
