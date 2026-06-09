'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..', '..');
const CodeGraph = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'code-graph'));

const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  }
});

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}

describe('CodeGraph - Constructor', () => {
  it('should create instance with default config', () => {
    const cg = new CodeGraph();
    assert.ok(cg);
    assert.strictEqual(cg._config.maxDepth, 10);
    assert.strictEqual(cg._config.maxFiles, 500);
    assert.deepStrictEqual(cg._config.ignorePatterns, ['node_modules', '.git', 'dist', '.harness']);
    assert.deepStrictEqual(cg._config.fileExtensions, ['.js', '.json', '.md']);
  });

  it('should merge custom config with defaults', () => {
    const cg = new CodeGraph({ maxDepth: 5, maxFiles: 100 });
    assert.strictEqual(cg._config.maxDepth, 5);
    assert.strictEqual(cg._config.maxFiles, 100);
    assert.strictEqual(cg._config.ignorePatterns.length, 4);
  });

  it('should initialize empty data structures', () => {
    const cg = new CodeGraph();
    assert.strictEqual(cg._nodes.size, 0);
    assert.strictEqual(cg._edges.length, 0);
  });

  it('should expose DEFAULT_CONFIG', () => {
    assert.ok(CodeGraph.DEFAULT_CONFIG);
    assert.strictEqual(CodeGraph.DEFAULT_CONFIG.maxDepth, 10);
  });
});

describe('CodeGraph - scanDirectory', () => {
  it('should scan a directory and find files', () => {
    const tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const a = require("./b");');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'module.exports = { a: 1 };');

    const cg = new CodeGraph();
    const result = cg.scanDirectory(tmpDir);
    assert.ok(result.files >= 2);
    assert.ok(result.edges >= 0);
  });

  it('should throw for invalid dirPath', () => {
    const cg = new CodeGraph();
    assert.throws(() => cg.scanDirectory(''), /required/);
    assert.throws(() => cg.scanDirectory(null), /required/);
  });

  it('should return empty for non-existent directory', () => {
    const cg = new CodeGraph();
    const result = cg.scanDirectory(path.join(os.tmpdir(), 'nonexistent-dir-12345'));
    assert.strictEqual(result.files, 0);
    assert.strictEqual(result.edges, 0);
  });

  it('should emit scan-complete event', () => {
    const tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const x = 1;');
    const cg = new CodeGraph();
    let emitted = false;
    cg.on('scan-complete', () => { emitted = true; });
    cg.scanDirectory(tmpDir);
    assert.strictEqual(emitted, true);
  });

  it('should ignore configured patterns', () => {
    const tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), 'const x = 1;');
    fs.writeFileSync(path.join(tmpDir, 'main.js'), 'const x = 1;');

    const cg = new CodeGraph();
    const result = cg.scanDirectory(tmpDir);
    assert.strictEqual(result.files, 1);
  });

  it('should respect maxFiles limit', () => {
    const tmpDir = createTempDir();
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, 'file' + i + '.js'), 'const x = ' + i + ';');
    }
    const cg = new CodeGraph({ maxFiles: 2 });
    const result = cg.scanDirectory(tmpDir);
    assert.strictEqual(result.files, 2);
  });
});

describe('CodeGraph - getDependencyGraph', () => {
  it('should return dependency graph for a file', () => {
    const tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'const b = require("./b");');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'module.exports = 1;');

    const cg = new CodeGraph();
    cg.scanDirectory(tmpDir);
    const graph = cg.getDependencyGraph('a.js', 3);
    assert.ok(Array.isArray(graph.nodes));
    assert.ok(Array.isArray(graph.edges));
  });

  it('should return empty graph for unknown file', () => {
    const cg = new CodeGraph();
    const graph = cg.getDependencyGraph('nonexistent.js');
    assert.ok(Array.isArray(graph.nodes));
  });
});

describe('CodeGraph - getReverseDependencies', () => {
  it('should return reverse dependencies', () => {
    const tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'const b = require("./b");');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'module.exports = 1;');

    const cg = new CodeGraph();
    cg.scanDirectory(tmpDir);
    const reverseDeps = cg.getReverseDependencies('b.js');
    assert.ok(Array.isArray(reverseDeps));
  });
});

describe('CodeGraph - detectOrphans', () => {
  it('should detect orphan files', () => {
    const tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'orphan.js'), 'const x = 1;');
    fs.writeFileSync(path.join(tmpDir, 'main.js'), 'const y = 2;');

    const cg = new CodeGraph();
    cg.scanDirectory(tmpDir);
    const orphans = cg.detectOrphans();
    assert.ok(Array.isArray(orphans));
  });
});

describe('CodeGraph - getModuleStats', () => {
  it('should return module statistics', () => {
    const tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'const b = require("./b");');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'module.exports = 1;');

    const cg = new CodeGraph();
    cg.scanDirectory(tmpDir);
    const stats = cg.getModuleStats();
    assert.strictEqual(stats.totalFiles, 2);
    assert.ok(stats.totalDependencies >= 0);
    assert.ok(Array.isArray(stats.circularDependencies));
    assert.ok(Array.isArray(stats.orphanFiles));
    assert.ok(Array.isArray(stats.largestModules));
  });
});

describe('CodeGraph - toCompactView', () => {
  it('should return compact view of graph', () => {
    const tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'const b = require("./b");');

    const cg = new CodeGraph();
    cg.scanDirectory(tmpDir);
    const view = cg.toCompactView();
    assert.ok(typeof view.view === 'string');
    assert.ok(view.lineCount >= 0);
    assert.ok(typeof view.estimatedFullTokens === 'number');
    assert.ok(typeof view.estimatedCompactTokens === 'number');
  });
});

describe('CodeGraph - getStats', () => {
  it('should return stats object', () => {
    const cg = new CodeGraph();
    const stats = cg.getStats();
    assert.strictEqual(stats.totalFiles, 0);
    assert.strictEqual(stats.totalEdges, 0);
    assert.strictEqual(stats.rootDir, null);
    assert.ok(stats.config);
  });

  it('should reflect scanned files', () => {
    const tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'const x = 1;');
    const cg = new CodeGraph();
    cg.scanDirectory(tmpDir);
    const stats = cg.getStats();
    assert.strictEqual(stats.totalFiles, 1);
    assert.ok(stats.scanTime);
  });
});

describe('CodeGraph - shutdown', () => {
  it('should clear all data on shutdown', () => {
    const tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'const x = 1;');
    const cg = new CodeGraph();
    cg.scanDirectory(tmpDir);
    cg.shutdown();
    assert.strictEqual(cg._nodes.size, 0);
    assert.strictEqual(cg._edges.length, 0);
    assert.strictEqual(cg._rootDir, null);
  });

  it('should prevent operations after shutdown', () => {
    const cg = new CodeGraph();
    cg.shutdown();
    assert.throws(() => cg.scanDirectory('/tmp'), /shut down/i);
  });
});
