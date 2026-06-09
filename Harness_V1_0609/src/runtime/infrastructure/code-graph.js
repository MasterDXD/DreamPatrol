'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const safeAssign = require('../../utils/safe-assign');
const { mergeConfig } = safeAssign;

const DEFAULT_CONFIG = {
  maxDepth: 10,
  maxFiles: 500,
  ignorePatterns: ['node_modules', '.git', 'dist', '.harness'],
  fileExtensions: ['.js', '.json', '.md'],
};

const MAX_EDGES = 10000;
const MAX_FILES = 5000;

const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXPORTS_ASSIGN_RE = /module\.exports\s*=\s*([^;\n]+)/g;
const EXPORTS_PROP_RE = /exports\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g;
const MD_WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;
const MD_MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * @module runtime/infrastructure/code-graph
 * CodeGraph — 代码依赖图
 * 扫描项目源码构建文件依赖关系图。解析JS文件的require依赖和exports导出、
 * MD文件的Wiki链接和Markdown链接引用。提供依赖链查询、反向依赖查找、
 * 孤立文件检测、循环依赖发现和紧凑视图生成（节省Token）。
 * @classdesc 代码依赖图。依赖关系图构建、循环依赖发现、孤立文件检测
 * @extends EventEmitter
 */
class CodeGraph extends EventEmitter {
  /**
   * 创建 CodeGraph 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxDepth=10] - 目录扫描最大深度
   * @param {number} [options.maxFiles=500] - 最大扫描文件数
   * @param {string[]} [options.ignorePatterns] - 忽略的目录模式
   * @param {string[]} [options.fileExtensions] - 扫描的文件扩展名
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._nodes = new Map();
    this._edges = [];
    this._adjacency = new Map();
    this._reverseAdjacency = new Map();
    this._scanTime = null;
    this._rootDir = null;
  }

  scanDirectory(dirPath, options) {
    this.guardShutdown();
    if (!dirPath || typeof dirPath !== 'string') {
      throw new Error('dirPath is required and must be a string');
    }
    const resolvedRoot = path.resolve(dirPath);
    if (!fs.existsSync(resolvedRoot)) {
      this.emit('scan-error', { dirPath: resolvedRoot, error: 'Directory does not exist' });
      return { files: 0, edges: 0 };
    }
    const opts = mergeConfig(this._config, options);
    this._nodes.clear();
    this._edges = [];
    this._adjacency.clear();
    this._reverseAdjacency.clear();
    this._rootDir = resolvedRoot;
    let fileCount = 0;
    this._walkDir(resolvedRoot, opts, 0, (filePath) => {
      if (fileCount >= opts.maxFiles) return;
      fileCount++;
      this._processFile(filePath, resolvedRoot);
    });
    this._scanTime = Date.now();
    this.emit('scan-complete', { rootDir: resolvedRoot, files: this._nodes.size, edges: this._edges.length });
    return { files: this._nodes.size, edges: this._edges.length };
  }

  _walkDir(dirPath, opts, depth, visitor) {
    if (depth > opts.maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      debug('CodeGraph', 'walkDir', dirPath + ': ' + (err && err.message ? err.message : String(err)));
      return;
    }
    for (const entry of entries) {
      if (this._shouldIgnore(entry.name, opts.ignorePatterns)) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this._walkDir(fullPath, opts, depth + 1, visitor);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (opts.fileExtensions.includes(ext)) {
          visitor(fullPath);
        }
      }
    }
  }

  _shouldIgnore(name, ignorePatterns) {
    for (const pattern of ignorePatterns) {
      if (name === pattern) return true;
      if (pattern.startsWith('*') && name.endsWith(pattern.slice(1))) return true;
    }
    return false;
  }

  _processFile(filePath, rootDir) {
    if (this._adjacency.size >= MAX_FILES) return;
    const ext = path.extname(filePath);
    const relativePath = path.relative(rootDir, filePath).replace(/\\/g, '/');
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      debug('CodeGraph', 'processFile', filePath + ': ' + (err && err.message ? err.message : String(err)));
      return;
    }
    const node = {
      filePath: relativePath,
      absolutePath: filePath,
      extension: ext,
      dependencies: [],
      exports: [],
      references: [],
      usedNames: new Set(),
      size: content.length,
    };
    if (ext === '.js') {
      const jsResult = this._parseJsDependencies(relativePath, content);
      node.dependencies = jsResult.dependencies;
      node.exports = jsResult.exports;
      this._extractUsedNames(content, node.usedNames);
    } else if (ext === '.md') {
      const mdResult = this._parseMdReferences(relativePath, content);
      node.references = mdResult.references;
    }
    this._nodes.set(relativePath, node);
    for (const dep of node.dependencies) {
      this._addEdge(relativePath, dep, 'require');
    }
    for (const ref of node.references) {
      this._addEdge(relativePath, ref, 'reference');
    }
  }

  _addEdge(from, to, type) {
    if (this._edges.length >= MAX_EDGES) return;
    this._edges.push({ from, to, type });
    if (!this._adjacency.has(from)) {
      this._adjacency.set(from, []);
    }
    this._adjacency.get(from).push({ to, type });
    if (!this._reverseAdjacency.has(to)) {
      this._reverseAdjacency.set(to, []);
    }
    this._reverseAdjacency.get(to).push({ from, type });
  }

  _extractUsedNames(content, usedNames) {
    const DESTRUCTURE_RE = /require\([^)]+\)[\s\S]*?{\s*([^}]+)}/g;
    DESTRUCTURE_RE.lastIndex = 0;
    let match;
    while ((match = DESTRUCTURE_RE.exec(content)) !== null) {
      const names = match[1].split(',').map(function(s) {
        const parts = s.trim().split(/\s+as\s+/);
        return (parts[0] || '').trim().replace(/['"]/g, '');
      }).filter(Boolean);
      names.forEach(function(n) { usedNames.add(n); });
    }
  }

  _parseJsDependencies(filePath, content) {
    const dependencies = [];
    const exports = [];
    let match;
    REQUIRE_RE.lastIndex = 0;
    while ((match = REQUIRE_RE.exec(content)) !== null) {
      const reqPath = match[1];
      if (reqPath.startsWith('.') || reqPath.startsWith('/')) {
        const resolved = this._resolveModulePath(reqPath, filePath);
        if (resolved) dependencies.push(resolved);
      } else {
        dependencies.push(reqPath);
      }
    }
    EXPORTS_ASSIGN_RE.lastIndex = 0;
    while ((match = EXPORTS_ASSIGN_RE.exec(content)) !== null) {
      const exported = match[1].trim();
      if (exported.startsWith('{')) {
        const names = exported.slice(1, -1).split(',').map(s => {
          const parts = s.trim().split(/\s+as\s+/);
          return (parts[0] || '').trim().replace(/['"]/g, '');
        }).filter(Boolean);
        exports.push(...names);
      } else if (/^[a-zA-Z_$]/.test(exported)) {
        exports.push(exported);
      }
    }
    EXPORTS_PROP_RE.lastIndex = 0;
    while ((match = EXPORTS_PROP_RE.exec(content)) !== null) {
      exports.push(match[1]);
    }
    return { filePath, dependencies, exports };
  }

  _resolveModulePath(reqPath, fromFilePath) {
    if (!this._rootDir) return reqPath;
    const fromDir = path.dirname(path.join(this._rootDir, fromFilePath));
    const resolved = path.relative(this._rootDir, path.resolve(fromDir, reqPath)).replace(/\\/g, '/');
    if (this._nodes.has(resolved)) return resolved;
    for (const ext of Array.isArray(this._config.fileExtensions) ? this._config.fileExtensions : []) {
      const withExt = resolved + ext;
      if (this._nodes.has(withExt)) return withExt;
    }
    const indexPath = path.join(resolved, 'index.js');
    if (this._nodes.has(indexPath)) return indexPath;
    return resolved;
  }

  _parseMdReferences(filePath, content) {
    const references = [];
    let match;
    MD_WIKI_LINK_RE.lastIndex = 0;
    while ((match = MD_WIKI_LINK_RE.exec(content)) !== null) {
      references.push(match[1].trim());
    }
    MD_MARKDOWN_LINK_RE.lastIndex = 0;
    while ((match = MD_MARKDOWN_LINK_RE.exec(content)) !== null) {
      const url = match[2].trim();
      if (url.startsWith('#') || url.startsWith('http://') || url.startsWith('https://')) continue;
      references.push(url);
    }
    return { filePath, references };
  }

  getDependencyGraph(filePath, maxDepth) {
    this.guardShutdown();
    const depth = maxDepth ?? 3;
    const normalizedPath = this._normalizePath(filePath);
    const nodes = new Set();
    const edges = [];
    const queue = [{ path: normalizedPath, currentDepth: 0 }];
    const visited = new Set();
    visited.add(normalizedPath);
    while (queue.length > 0) {
      const { path: currentPath, currentDepth } = queue.shift();
      nodes.add(currentPath);
      if (currentDepth >= depth) continue;
      const neighbors = this._adjacency.get(currentPath) ?? [];
      for (const edge of neighbors) {
        edges.push({ from: currentPath, to: edge.to, type: edge.type });
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          queue.push({ path: edge.to, currentDepth: currentDepth + 1 });
        }
      }
    }
    return {
      nodes: Array.from(nodes, p => this._nodes.get(p) || { filePath: p }),
      edges,
    };
  }

  getReverseDependencies(filePath) {
    this.guardShutdown();
    const normalizedPath = this._normalizePath(filePath);
    const reverseDeps = this._reverseAdjacency.get(normalizedPath) ?? [];
    return reverseDeps.map(dep => ({
      filePath: dep.from,
      type: dep.type,
      node: this._nodes.get(dep.from) ?? null,
    }));
  }

  detectOrphans() {
    this.guardShutdown();
    const orphans = [];
    for (const [filePath, node] of this._nodes) {
      const hasOutEdges = (this._adjacency.get(filePath) ?? []).length > 0;
      const hasInEdges = (this._reverseAdjacency.get(filePath) ?? []).length > 0;
      if (!hasOutEdges && !hasInEdges) {
        orphans.push(node);
      }
    }
    return orphans;
  }

  /**
   * 检测未被任何其他文件引用的导出符号（符号级dead code检测）。
   * 遍历所有文件的exports列表，检查每个导出名称是否被其他文件的require/destructure引用。
   * @returns {Array<{filePath: string, unusedExports: string[]}>} 含未使用导出的文件列表
   */
  detectUnusedExports() {
    this.guardShutdown();
    const results = [];
    for (const [filePath, node] of this._nodes) {
      if (!Array.isArray(node.exports) || node.exports.length === 0) continue;
      const usedNames = new Set();
      const dependents = this._reverseAdjacency.get(filePath) ?? [];
      for (const dep of dependents) {
        const depNode = this._nodes.get(dep.from);
        if (!depNode || !depNode.usedNames) continue;
        depNode.usedNames.forEach(function(n) { usedNames.add(n); });
      }
      const unusedExports = node.exports.filter(function(exp) { return !usedNames.has(exp); });
      if (unusedExports.length > 0) {
        results.push({ filePath, unusedExports });
      }
    }
    return results;
  }

  getModuleStats() {
    this.guardShutdown();
    let totalDependencies = 0;
    const depCounts = [];
    for (const [, node] of this._nodes) {
      const depCount = (node.dependencies ?? []).length + (node.references ?? []).length;
      totalDependencies += depCount;
      depCounts.push({ filePath: node.filePath, count: depCount });
    }
    const circularDependencies = this._detectCycles();
    const orphanFiles = this.detectOrphans().map(n => n.filePath);
    depCounts.sort((a, b) => b.count - a.count);
    const largestModules = depCounts.slice(0, 10);
    return {
      totalFiles: this._nodes.size,
      totalDependencies,
      avgDependencies: this._nodes.size > 0 ? Math.round(totalDependencies / this._nodes.size * 100) / 100 : 0,
      circularDependencies,
      orphanFiles,
      largestModules,
    };
  }

  _detectCycles() {
    const cycles = [];
    const visited = new Set();
    const recursionStack = new Set();
    const currentPath = [];
    const adjacency = this._adjacency;
    function dfs(node) {
      visited.add(node);
      recursionStack.add(node);
      currentPath.push(node);
      const neighbors = adjacency.get(node) ?? [];
      for (const edge of neighbors) {
        if (!this._nodes.has(edge.to)) continue;
        if (!visited.has(edge.to)) {
          dfs.call(this, edge.to);
        } else if (recursionStack.has(edge.to)) {
          const cycleStart = currentPath.indexOf(edge.to);
          if (cycleStart !== -1) {
            const cycle = currentPath.slice(cycleStart).concat([edge.to]);
            cycles.push(cycle);
          }
        }
      }
      currentPath.pop();
      recursionStack.delete(node);
    }
    for (const [filePath] of this._nodes) {
      if (!visited.has(filePath)) {
        dfs.call(this, filePath);
      }
    }
    return cycles;
  }

  toCompactView() {
    this.guardShutdown();
    const lines = [];
    let fullSize = 0;
    let compactSize = 0;
    for (const [filePath, node] of this._nodes) {
      const deps = (node.dependencies ?? []).concat(node.references ?? []);
      const line = deps.length > 0 ? filePath + ' → ' + deps.join(', ') : filePath;
      lines.push(line);
      let nodeSize;
      try { nodeSize = JSON.stringify(node).length; } catch (_e) { nodeSize = JSON.stringify({ filePath: node.filePath, error: 'circular' }).length; }
      fullSize += nodeSize;
      compactSize += line.length;
    }
    const tokenSavings = Math.round((fullSize - compactSize) / 4);
    return {
      view: lines.join('\n'),
      lineCount: lines.length,
      estimatedFullTokens: Math.round(fullSize / 4),
      estimatedCompactTokens: Math.round(compactSize / 4),
      tokenSavings,
    };
  }

  getStats() {
    return {
      totalFiles: this._nodes.size,
      totalEdges: this._edges.length,
      rootDir: this._rootDir,
      scanTime: this._scanTime,
      config: safeAssign({}, this._config),
    };
  }

  _normalizePath(filePath) {
    if (this._nodes.has(filePath)) return filePath;
    const normalized = filePath.replace(/\\/g, '/');
    if (this._nodes.has(normalized)) return normalized;
    for (const ext of Array.isArray(this._config.fileExtensions) ? this._config.fileExtensions : []) {
      const withExt = normalized + ext;
      if (this._nodes.has(withExt)) return withExt;
    }
    return normalized;
  }

  _onShutdown() {
    this._nodes.clear();
    this._edges = [];
    this._adjacency.clear();
    this._reverseAdjacency.clear();
    this._rootDir = null;
    this._scanTime = null;
    this.removeAllListeners();
  }
}

CodeGraph = withShutdown(CodeGraph);

CodeGraph.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = CodeGraph;
