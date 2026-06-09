'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const ChangelogArchive = require(path.join(ROOT, 'src', 'web', 'changelog-archive'));

describe('ChangelogArchive', () => {
  let tmpDir;
  let archive;

  before(() => {
    tmpDir = path.join(os.tmpdir(), `archive-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    archive = new ChangelogArchive(tmpDir);
  });

  after(() => {
    try {
      const archiveDir = path.join(tmpDir, '.harness', 'archive');
      if (fs.existsSync(archiveDir)) {
        fs.rmSync(archiveDir, { recursive: true, force: true });
      }
    } catch (_err) { /* ignore */ }
  });

  it('should record a version entry', () => {
    const result = archive.record({
      version: '1.0.0',
      changes: { '新增': ['Initial release'] },
      summary: '首次发布',
      category: '新增',
      agent: '团队负责人',
    });
    assert.ok(result.success);
    assert.ok(result.id);
    assert.ok(result.hash);
  });

  it('should reject duplicate version', () => {
    const result = archive.record({
      version: '1.0.0',
      changes: { '变更': ['Update'] },
    });
    assert.ok(!result.success);
    assert.ok(result.error.includes('already exists'));
  });

  it('should reject missing required fields', () => {
    const result = archive.record({});
    assert.ok(!result.success);
    assert.ok(result.error.includes('Missing'));
  });

  it('should retrieve a recorded entry', () => {
    archive.record({
      version: '2.0.0',
      changes: { '新增': ['Major update'] },
      summary: '重大更新',
    });
    const index = archive.search({ page: 1, pageSize: 10 });
    const v2Entry = index.items.find(v => v.version === '2.0.0');
    assert.ok(v2Entry);

    const full = archive.getFullRecord(v2Entry.id);
    assert.ok(full);
    assert.equal(full.version, '2.0.0');
    assert.equal(full.summary, '重大更新');
  });

  it('should search by keyword', () => {
    archive.record({
      version: '3.0.0',
      changes: { '新增': ['Plugin system'] },
      summary: '插件系统',
    });
    const results = archive.search({ keyword: '插件', page: 1, pageSize: 10 });
    assert.ok(results.items.length >= 1);
    assert.ok(results.items.some(v => v.version === '3.0.0'));
  });

  it('should search by category', () => {
    const results = archive.search({ category: '新增', page: 1, pageSize: 10 });
    assert.ok(results.items.length >= 1);
  });

  it('should paginate results', () => {
    const results = archive.search({ page: 1, pageSize: 2 });
    assert.ok(results.pageSize === 2);
    assert.ok(results.items.length <= 2);
    assert.ok(results.totalPages >= 1);
  });

  it('should verify integrity', () => {
    const result = archive.verifyIntegrity();
    assert.ok(result.indexValid);
    assert.ok(result.recordsValid >= 2);
    assert.equal(result.recordsTampered, 0);
  });

  it('should get stats', () => {
    const stats = archive.getStats();
    assert.ok(stats.total >= 2);
    assert.ok(stats.byCategory);
    assert.ok(stats.byAgent);
  });

  it('should return null for nonexistent record', () => {
    const result = archive.getFullRecord('nonexistent_id');
    assert.equal(result, null);
  });
});
