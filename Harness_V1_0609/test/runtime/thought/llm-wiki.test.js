'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..', '..');
const LLMWikiModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'llm-wiki'));
const LLMWiki = LLMWikiModule.LLMWiki || LLMWikiModule;

const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  }
});

function createTempWikiRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}

describe('LLMWiki - Constructor', () => {
  it('should create instance with default config', () => {
    const wiki = new LLMWiki();
    assert.ok(wiki);
    assert.deepStrictEqual(wiki._config.categories, ['concepts', 'decisions', 'patterns', 'api', 'troubleshooting']);
    assert.strictEqual(wiki._config.maxEntriesPerCategory, 200);
    assert.strictEqual(wiki._config.autoIndex, true);
  });

  it('should merge custom options with defaults', () => {
    const wiki = new LLMWiki({ maxEntriesPerCategory: 50 });
    assert.strictEqual(wiki._config.maxEntriesPerCategory, 50);
    assert.strictEqual(wiki._config.autoIndex, true);
  });

  it('should initialize with no wiki root', () => {
    const wiki = new LLMWiki();
    assert.strictEqual(wiki._wikiRoot, null);
    assert.strictEqual(wiki._initialized, false);
  });

  it('should expose DEFAULT_CONFIG and VALID_CATEGORIES', () => {
    assert.ok(LLMWikiModule.DEFAULT_CONFIG);
    assert.ok(LLMWikiModule.VALID_CATEGORIES);
  });
});

describe('LLMWiki - initialize', () => {
  it('should initialize wiki root directory', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    const result = wiki.initialize(wikiRoot);
    assert.strictEqual(result, wiki);
    assert.strictEqual(wiki._initialized, true);
    assert.ok(fs.existsSync(wikiRoot));
  });

  it('should create category directories', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    for (const cat of wiki._config.categories) {
      assert.ok(fs.existsSync(path.join(wikiRoot, cat)));
    }
  });

  it('should not re-initialize if already initialized', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    const result = wiki.initialize('/another/path');
    assert.strictEqual(result, wiki);
    assert.strictEqual(wiki._wikiRoot, path.resolve(wikiRoot));
  });

  it('should emit initialized event', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    let emitted = false;
    wiki.on('initialized', () => { emitted = true; });
    wiki.initialize(wikiRoot);
    assert.strictEqual(emitted, true);
  });
});

describe('LLMWiki - createEntry', () => {
  it('should create an entry in a category', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    const entry = wiki.createEntry('concepts', 'Test Concept', 'This is a test concept.');
    assert.ok(entry);
    assert.strictEqual(entry.category, 'concepts');
    assert.strictEqual(entry.title, 'Test Concept');
    assert.strictEqual(entry.content, 'This is a test concept.');
  });

  it('should return null for invalid category', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    const entry = wiki.createEntry('invalid-category', 'Test', 'Content');
    assert.strictEqual(entry, null);
  });

  it('should return null when not initialized', () => {
    const wiki = new LLMWiki();
    const entry = wiki.createEntry('concepts', 'Test', 'Content');
    assert.strictEqual(entry, null);
  });

  it('should return null for duplicate entry', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    wiki.createEntry('concepts', 'Test', 'Content1');
    const entry = wiki.createEntry('concepts', 'Test', 'Content2');
    assert.strictEqual(entry, null);
  });

  it('should emit entry-created event', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    let emitted = false;
    wiki.on('entry-created', () => { emitted = true; });
    wiki.createEntry('concepts', 'My Entry', 'Content');
    assert.strictEqual(emitted, true);
  });
});

describe('LLMWiki - getEntry', () => {
  it('should retrieve an existing entry', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    wiki.createEntry('concepts', 'My Concept', 'Content here');
    const entry = wiki.getEntry('concepts', 'my-concept');
    assert.ok(entry);
    assert.strictEqual(entry.title, 'My Concept');
  });

  it('should return null for non-existent entry', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    const entry = wiki.getEntry('concepts', 'nonexistent');
    assert.strictEqual(entry, null);
  });

  it('should return null when not initialized', () => {
    const wiki = new LLMWiki();
    const entry = wiki.getEntry('concepts', 'test');
    assert.strictEqual(entry, null);
  });
});

describe('LLMWiki - updateEntry', () => {
  it('should update an existing entry', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    wiki.createEntry('concepts', 'My Concept', 'Original content');
    const updated = wiki.updateEntry('concepts', 'my-concept', { content: 'Updated content' });
    assert.ok(updated);
    assert.strictEqual(updated.content, 'Updated content');
  });

  it('should return null for non-existent entry', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    const result = wiki.updateEntry('concepts', 'nonexistent', { content: 'x' });
    assert.strictEqual(result, null);
  });

  it('should return null when not initialized', () => {
    const wiki = new LLMWiki();
    const result = wiki.updateEntry('concepts', 'test', { content: 'x' });
    assert.strictEqual(result, null);
  });
});

describe('LLMWiki - deleteEntry', () => {
  it('should delete an existing entry', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    wiki.createEntry('concepts', 'My Concept', 'Content');
    const result = wiki.deleteEntry('concepts', 'my-concept');
    assert.strictEqual(result, true);
    assert.strictEqual(wiki.getEntry('concepts', 'my-concept'), null);
  });

  it('should return false for non-existent entry', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    const result = wiki.deleteEntry('concepts', 'nonexistent');
    assert.strictEqual(result, false);
  });

  it('should return false when not initialized', () => {
    const wiki = new LLMWiki();
    const result = wiki.deleteEntry('concepts', 'test');
    assert.strictEqual(result, false);
  });
});

describe('LLMWiki - search', () => {
  it('should search entries by query', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    wiki.createEntry('concepts', 'Database', 'A database stores data persistently');
    wiki.createEntry('concepts', 'Cache', 'A cache stores data temporarily');
    const results = wiki.search('database');
    assert.ok(results.length > 0);
  });

  it('should return empty when not initialized', () => {
    const wiki = new LLMWiki();
    const results = wiki.search('test');
    assert.deepStrictEqual(results, []);
  });

  it('should return empty for null query', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    const results = wiki.search(null);
    assert.deepStrictEqual(results, []);
  });
});

describe('LLMWiki - listEntries', () => {
  it('should list all entries', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    wiki.createEntry('concepts', 'Alpha', 'Content A');
    wiki.createEntry('concepts', 'Beta', 'Content B');
    const entries = wiki.listEntries();
    assert.strictEqual(entries.length, 2);
  });

  it('should list entries by category', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    wiki.createEntry('concepts', 'Alpha', 'Content A');
    wiki.createEntry('decisions', 'Decision1', 'Decision content');
    const entries = wiki.listEntries('concepts');
    assert.strictEqual(entries.length, 1);
  });

  it('should return empty when not initialized', () => {
    const wiki = new LLMWiki();
    const entries = wiki.listEntries();
    assert.deepStrictEqual(entries, []);
  });
});

describe('LLMWiki - getBacklinks', () => {
  it('should return backlinks for an entry', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    wiki.createEntry('concepts', 'Alpha', 'See also [[concepts/Beta]]');
    wiki.createEntry('concepts', 'Beta', 'Content B');
    const backlinks = wiki.getBacklinks('concepts', 'beta');
    assert.ok(Array.isArray(backlinks));
  });

  it('should return empty when not initialized', () => {
    const wiki = new LLMWiki();
    const backlinks = wiki.getBacklinks('concepts', 'test');
    assert.deepStrictEqual(backlinks, []);
  });
});

describe('LLMWiki - suggestUpdates', () => {
  it('should suggest updates for stale entries', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    wiki.createEntry('concepts', 'Alpha', 'Content A', { confidence: 0.5 });
    const suggestions = wiki.suggestUpdates('Alpha');
    assert.ok(Array.isArray(suggestions));
  });

  it('should return empty when not initialized', () => {
    const wiki = new LLMWiki();
    const suggestions = wiki.suggestUpdates('test');
    assert.deepStrictEqual(suggestions, []);
  });

  it('should return empty for null context', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    const suggestions = wiki.suggestUpdates(null);
    assert.deepStrictEqual(suggestions, []);
  });
});

describe('LLMWiki - getStats', () => {
  it('should return uninitiated stats', () => {
    const wiki = new LLMWiki();
    const stats = wiki.getStats();
    assert.strictEqual(stats.totalEntries, 0);
    assert.strictEqual(stats.initialized, false);
  });

  it('should return stats after initialization', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    wiki.createEntry('concepts', 'Alpha', 'Content A');
    const stats = wiki.getStats();
    assert.strictEqual(stats.totalEntries, 1);
    assert.strictEqual(stats.initialized, true);
    assert.ok(stats.byCategory);
    assert.strictEqual(typeof stats.backlinkCount, 'number');
  });
});

describe('LLMWiki - shutdown', () => {
  it('should clear all data on shutdown', () => {
    const wikiRoot = createTempWikiRoot();
    const wiki = new LLMWiki();
    wiki.initialize(wikiRoot);
    wiki.createEntry('concepts', 'Alpha', 'Content A');
    wiki.shutdown();
    assert.strictEqual(wiki._entries.size, 0);
    assert.strictEqual(wiki._backlinkIndex.size, 0);
    assert.strictEqual(wiki._initialized, false);
    assert.strictEqual(wiki._shutDown, true);
  });
});
