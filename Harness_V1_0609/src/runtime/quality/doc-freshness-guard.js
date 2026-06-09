'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { writeAtomic } = require('../../utils/debounced-persister');
const { safeJsonParse } = require('../../utils/safe-parse');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { UTF8_ENCODING, HARNESS_DIR, DEFAULT_PERSIST_DEBOUNCE_MS } = require('../../utils/constants');

const STALE_THRESHOLD_MS = 7 * 24 * 3600 * 1000;
const SPEC_STALE_THRESHOLD_MS = 3 * 24 * 3600 * 1000;
const MAX_INDEX_ENTRIES = 500;
const MAX_DOC_FILE_SIZE = 512 * 1024;
const MAX_PENDING_CHANGES = 1000;
const MAX_DIRECTORY_DEPTH = 20;
const MAX_REFERENCES_PER_DOC = 100;
const MAX_PERSISTED_INDEX_SIZE = 5 * 1024 * 1024;
const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
]);
const DOC_EXTENSIONS = new Set([
  '.md', '.markdown', '.rst', '.txt', '.adoc',
]);

/**
 * @module runtime/quality/doc-freshness-guard
 * DocFreshnessGuard — 文档新鲜度守卫
 * @classdesc 文档新鲜度守卫。检测过时文档、提醒更新
 * 检测过时文档并提醒更新。异步构建文档索引，提取代码引用，监听源码变更自动标记关联文档为stale。
 * 区分普通文档（7天阈值）与规格文档（3天阈值），规格文档采用active活跃策略并支持再验证队列。
 * 支持文件系统监听、防抖变更处理、索引持久化与SHA-256完整性校验。
 * @extends EventEmitter
 * @emits DocFreshnessGuard#index-built
 * @emits DocFreshnessGuard#docs-staled
 * @emits DocFreshnessGuard#docs-staled-by-threshold
 * @emits DocFreshnessGuard#spec-stale
 * @emits DocFreshnessGuard#doc-verified
 * @emits DocFreshnessGuard#spec-reverification-triggered
 * @emits DocFreshnessGuard#watching-started
 */
class DocFreshnessGuard extends EventEmitter {
  constructor(options) {
    super();
    this._root = (options && options.projectRoot) ?? null;
    this._eventBus = (options && options.eventBus) ?? null;
    this._indexPath = this._root ? path.join(this._root, HARNESS_DIR, 'doc-index.json') : null;
    this._docIndex = new Map();
    this._staleDocs = new Map();
    this._maxStaleDocs = 500;
    this._watcher = null;
    this._debounceTimer = null;
    this._pendingChanges = [];
    this._specReverificationQueue = [];
    this._indexReady = false;
    if (this._root) {
      this._readyPromise = this._buildIndexAsync().catch(err => { debug('DocFreshnessGuard', 'initError', err); });
    } else {
      this._readyPromise = Promise.resolve();
    }
  }

  /**
   * 获取索引构建就绪的Promise，异步索引构建完成后resolve
   * @returns {Promise<void>} 索引构建完成的Promise
   */
  get ready() {
    return this._readyPromise;
  }

  /**
   * 延迟附加项目根目录，触发异步文档索引构建
   * 仅在构造时未提供projectRoot时生效，已设置时忽略
   * @param {string} projectRoot - 项目根目录的绝对路径
   * @returns {DocFreshnessGuard} 当前实例，支持链式调用
   */
  attachProjectRoot(projectRoot) {
    this.guardShutdown();
    if (this._root) return this;
    this._root = projectRoot;
    this._readyPromise = this._buildIndexAsync().catch(err => { debug('DocFreshnessGuard', 'initError', err); });
    return this;
  }

  /**
   * 附加事件总线实例，用于发射文件变更事件
   * @param {object} bus - 事件总线实例
   * @returns {DocFreshnessGuard} 当前实例，支持链式调用
   */
  attachEventBus(bus) {
    this.guardShutdown();
    this._eventBus = bus;
    return this;
  }

  async _buildIndexAsync() {
    if (this._buildingIndex) return;
    this._buildingIndex = true;
    try {
      await this._buildIndexAsyncInternal();
      this._indexReady = true;
      this.emit('index-built', { entries: this._docIndex.size });
    } catch (err) {
      debug('DocFreshnessGuard', '_buildIndexAsync', err);
      if (this.listenerCount('error') > 0) {
        try { this.emit('error', { source: '_buildIndexAsync', error: err }); } catch (emitErr) { debug('DocFreshnessGuard', 'emitError', emitErr); }
      }
    } finally {
      this._buildingIndex = false;
    }
  }

  async _buildIndexAsyncInternal() {
    if (!this._root) return;
    this._docIndex.clear();
    const docsDir = path.join(this._root, 'docs');
    try {
      await fs.promises.access(docsDir);
      if (this._shutDown) return;
      await this._indexDirectoryAsync(docsDir);
      if (this._shutDown) return;
    } catch (e) { debug('DocFreshnessGuard', 'indexDocs', e && e.message ? e.message : String(e)); }
    const harnessDir = path.join(this._root, HARNESS_DIR);
    try {
      await fs.promises.access(harnessDir);
      if (this._shutDown) return;
      await this._indexDirectoryAsync(harnessDir, '.md');
      if (this._shutDown) return;
    } catch (e) { debug('DocFreshnessGuard', 'indexHarness', e && e.message ? e.message : String(e)); }
    await this._loadPersistedIndexAsync();
  }

  async _indexDirectoryAsync(dirPath, forceExt, depth) {
    if ((depth ?? 0) >= MAX_DIRECTORY_DEPTH) return;
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          await this._indexDirectoryAsync(fullPath, forceExt, (depth ?? 0) + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (forceExt && ext !== forceExt) continue;
          if (DOC_EXTENSIONS.has(ext)) {
            await this._indexDocFileAsync(fullPath);
          }
        }
      }
    } catch (err) {
      debug('DocFreshnessGuard', '_indexDirectoryAsync', err);
    }
  }

  async _indexDocFileAsync(docPath) {
    if (this._docIndex.size >= MAX_INDEX_ENTRIES) return;
    try {
      const stat = await fs.promises.stat(docPath);
      if (stat.size > MAX_DOC_FILE_SIZE) return;
      const content = await fs.promises.readFile(docPath, UTF8_ENCODING);
      const isSpec = this._isSpecificationDoc(content, docPath);
      const specType = isSpec ? this._detectSpecType(content) : null;
      const livenessPolicy = isSpec ? 'active' : 'passive';
      const references = this._extractCodeReferences(content);
      const relativePath = path.relative(this._root, docPath).replace(/\\/g, '/');
      this._docIndex.set(relativePath, {
        path: relativePath,
        references,
        lastVerifiedAt: Date.now(),
        stale: false,
        staleReason: null,
        specificationType: specType,
        livenessPolicy: livenessPolicy,
        reverificationAttempts: 0,
        lastReverificationAt: null,
      });
    } catch (err) {
      debug('DocFreshnessGuard', '_indexDocFileAsync', err);
    }
  }

  async _loadPersistedIndexAsync() {
    if (!this._root) return;
    try {
      const indexPath = this._indexPath;
      const stat = await fs.promises.stat(indexPath);
      if (stat.size > MAX_PERSISTED_INDEX_SIZE) return;
      const content = await fs.promises.readFile(indexPath, UTF8_ENCODING);
      const data = safeJsonParse(content, null, 'DocFreshnessGuard');
      if (Array.isArray(data) && data.length <= MAX_INDEX_ENTRIES * 2) {
        data.forEach(entry => {
          if (entry.path) {
            const existing = this._docIndex.get(entry.path);
            if (existing) {
              existing.lastVerifiedAt = entry.lastVerifiedAt ?? existing.lastVerifiedAt;
              existing.stale = entry.stale ?? false;
              existing.staleReason = entry.staleReason ?? null;
            }
          }
        });
      }
    } catch (err) {
      debug('DocFreshnessGuard', '_loadPersistedIndexAsync', 'no persisted index', err && err.message ? err.message : String(err));
    }
  }

  _extractCodeReferences(content) {
    const references = new Set();
    const patterns = [
      /src\/[\w./-]+\.(js|ts|jsx|tsx|py|go|rs|java)/g,
      /\[([^\]]{1,200})\]\([^)]{1,500}\.md[^)]*\)/g,
      /`([\w/-]+\.(js|ts|jsx|tsx|py|go|rs|java))`/g,
      /(?:require|import)\s*\(?['"]\.?\.?\/([\w./-]+)['"]\)?/g,
      /(?:file|模块|文件)[：:]\s*`?([\w./-]+\.\w+)`?/g,
    ];
    const MAX_LINE_LENGTH = 2000;
    const lines = (content ?? '').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.length > MAX_LINE_LENGTH ? rawLine.substring(0, MAX_LINE_LENGTH) : rawLine;
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        let matchCount = 0;
        while ((match = pattern.exec(line)) !== null && matchCount < MAX_REFERENCES_PER_DOC) {
          matchCount++;
          const ref = (match[1] || match[0]).replace(/\\/g, '/');
          if (ref && !ref.startsWith('http')) {
            references.add(ref);
          }
        }
      }
    }
    return Array.from(references).slice(0, MAX_REFERENCES_PER_DOC);
  }

  _persistIndex() {
    if (!this._root) return;
    try {
      const indexPath = this._indexPath;
      const data = Array.from(this._docIndex.values()).map(e => ({
        path: e.path,
        references: e.references,
        lastVerifiedAt: e.lastVerifiedAt,
        stale: e.stale,
        staleReason: e.staleReason,
      }));
      writeAtomic(indexPath, data);
    } catch (err) {
      debug('DocFreshnessGuard', '_persistIndex', err);
    }
  }

  /**
   * 启动源码目录文件监听，当源码文件变更时自动标记关联文档为stale
   * 监听项目src/目录下的代码文件(.js/.ts/.py/.go/.rs/.java等)，触发'watching-started'事件
   */
  startWatching() {
    this.guardShutdown();
    if (!this._root || this._watcher) return;
    const srcDir = path.join(this._root, 'src');
    try {
      this._watcher = fs.watch(srcDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const ext = path.extname(filename).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          this._onCodeChange(path.join(srcDir, filename), eventType);
        }
      });
      if (this._watcher) {
        this._watcher.on('error', (err) => {
          debug('DocFreshnessGuard', 'watcherError', err);
          const oldWatcher = this._watcher;
          this._watcher = null;
          try {
            if (oldWatcher && typeof oldWatcher.removeAllListeners === 'function') oldWatcher.removeAllListeners();
            if (oldWatcher && typeof oldWatcher.close === 'function') oldWatcher.close();
          } catch (closeErr) { debug('DocFreshnessGuard', 'watcherCloseError', closeErr); }
        });
        if (typeof this._watcher.unref === 'function') {
          this._watcher.unref();
        }
      }
      this.emit('watching-started', { directory: srcDir });
    } catch (err) {
      debug('DocFreshnessGuard', 'startWatching', err);
    }
  }

  /**
   * 停止源码目录文件监听，清理防抖定时器
   */
  stopWatching() {
    if (this._watcher) {
      if (typeof this._watcher.removeAllListeners === 'function') {
        this._watcher.removeAllListeners();
      }
      this._watcher.close();
      this._watcher = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  _onCodeChange(filePath, eventType) {
    if (this._pendingChanges.length >= MAX_PENDING_CHANGES) {
      this._pendingChanges.splice(0, Math.max(0, this._pendingChanges.length - MAX_PENDING_CHANGES + 100));
    }
    this._pendingChanges.push({ filePath, eventType, timestamp: Date.now() });
    if (this._eventBus && typeof this._eventBus.emit === 'function') {
      this._eventBus.emit('file:changed', { filePath, changeType: eventType });
    }
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      try {
        this._processPendingChanges();
      } catch (err) {
        debug('DocFreshnessGuard', '_processPendingChanges', err);
      }
      this._debounceTimer = null;
    }, DEFAULT_PERSIST_DEBOUNCE_MS);
    if (this._debounceTimer && typeof this._debounceTimer.unref === 'function') {
      this._debounceTimer.unref();
    }
  }

  _processPendingChanges() {
    if (this._shutDown) return;
    const changes = this._pendingChanges.splice(0);
    if (changes.length === 0) return;
    const affectedModules = new Set();
    changes.forEach(change => {
      const relativePath = path.relative(this._root, change.filePath).replace(/\\/g, '/');
      const moduleName = this._extractModuleName(relativePath);
      if (moduleName) {
        affectedModules.add(moduleName);
      }
      affectedModules.add(relativePath);
    });
    const staleDocs = this._markStaleDocs(affectedModules);
    if (staleDocs.length > 0) {
      this._persistIndex();
      this.emit('docs-staled', {
        changedFiles: changes.map(c => path.relative(this._root, c.filePath).replace(/\\/g, '/')),
        staleDocs: staleDocs.map(d => d.path),
        affectedModules: Array.from(affectedModules),
      });
    }
  }

  _extractModuleName(relativePath) {
    const parts = (relativePath ?? '').split('/');
    if (parts.length >= 2) {
      return parts.slice(0, 2).join('/');
    }
    if (parts.length === 1) {
      return parts[0].replace(/\.\w+$/, '');
    }
    return null;
  }

  _markStaleDocs(affectedModules) {
    const staleDocs = [];
    for (const [docPath, entry] of this._docIndex) {
      let isStale = false;
      let staleReason = null;
      for (const ref of (entry.references ?? [])) {
        for (const module of affectedModules) {
          if (ref === module || ref.startsWith(module + '/') || module.startsWith(ref.replace(/\.\w+$/, '') + '/')) {
            isStale = true;
            staleReason = `code_changed:${module}`;
            break;
          }
        }
        if (isStale) break;
      }
      if (isStale && !entry.stale) {
        entry.stale = true;
        entry.staleReason = staleReason;
        if (this._staleDocs.size >= this._maxStaleDocs) {
          const oldest = this._staleDocs.keys().next().value;
          this._staleDocs.delete(oldest);
        }
        this._staleDocs.set(docPath, entry);
        staleDocs.push(entry);
        if (entry.specificationType) {
          this.emit('spec-stale', { path: docPath, specType: entry.specificationType, staleReason: staleReason, reverificationNeeded: true });
        }
      }
    }
    return staleDocs;
  }

  /**
   * 手动处理代码变更事件，标记引用该代码模块的文档为stale
   * 根据变更文件路径提取模块名，匹配文档索引中的代码引用，触发'docs-staled'事件
   * @param {string} filePath - 变更文件的绝对路径
   * @param {string} [changeType] - 变更类型（如'update'/'rename'等）
   * @returns {Array<object>|undefined} 被标记为stale的文档条目数组，每条含path/reason/lastVerifiedAt/references
   */
  handleCodeChange(filePath, changeType) {
    this.guardShutdown();
    if (!filePath || typeof filePath !== 'string') return [];
    if (!this._root) return [];
    if (!this._indexReady) return [];
    if (this._eventBus && typeof this._eventBus.emit === 'function') {
      this._eventBus.emit('file:changed', { filePath, changeType: changeType || 'modify' });
    }
    const relativePath = path.relative(this._root, filePath).replace(/\\/g, '/');
    const moduleName = this._extractModuleName(relativePath);
    const affectedModules = new Set([relativePath]);
    if (moduleName) affectedModules.add(moduleName);
    const staleDocs = this._markStaleDocs(affectedModules);
    if (staleDocs.length > 0) {
      this._persistIndex();
      this.emit('docs-staled', {
        changedFiles: [relativePath],
        staleDocs: staleDocs.map(d => d.path),
        changeType,
      });
    }
    return staleDocs;
  }

  /**
   * 获取所有已标记为stale的文档列表
   * 仅在索引构建完成后返回结果，否则返回空数组
   * @returns {Array<{path: string, reason: string, lastVerifiedAt: number, references: Array<string>}>} stale文档列表
   */
  getStaleDocs() {
    if (!this._indexReady) return [];
    return Array.from(this._docIndex.values())
      .filter(entry => entry.stale)
      .map(entry => ({
        path: entry.path,
        reason: entry.staleReason,
        lastVerifiedAt: entry.lastVerifiedAt,
        references: entry.references.slice(),
      }));
  }

  /**
   * 将指定文档标记为已验证，清除stale状态并持久化索引
   * 触发'doc-verified'事件
   * @param {string} docPath - 文档路径（支持正斜杠和反斜杠）
   * @returns {boolean} 标记成功返回true，文档不在索引中返回false
   */
  markDocVerified(docPath) {
    this.guardShutdown();
    if (!docPath || typeof docPath !== 'string') return false;
    if (!this._indexReady) return false;
    const relativePath = docPath.replace(/\\/g, '/');
    const entry = this._docIndex.get(relativePath);
    if (!entry) return false;
    entry.stale = false;
    entry.staleReason = null;
    entry.lastVerifiedAt = Date.now();
    this._staleDocs.delete(relativePath);
    this._persistIndex();
    this.emit('doc-verified', { path: relativePath });
    return true;
  }

  /**
   * 获取完整的文档索引摘要列表
   * @returns {Array<{path: string, referenceCount: number, stale: boolean, staleReason: string|null, lastVerifiedAt: number}>} 文档索引条目数组
   */
  getDocIndex() {
    return Array.from(this._docIndex.values()).map(e => ({
      path: e.path,
      referenceCount: e.references.length,
      stale: e.stale,
      staleReason: e.staleReason,
      lastVerifiedAt: e.lastVerifiedAt,
    }));
  }

  /**
   * 获取文档新鲜度统计信息
   * @returns {{totalDocs: number, staleDocs: number, freshDocs: number, totalReferences: number, freshnessRate: number, watching: boolean}} 统计摘要，含总文档数、stale数、新鲜数、引用总数、新鲜率、是否正在监听
   */
  getFreshnessStats() {
    let staleDocs = 0;
    let totalReferences = 0;
    let totalDocs = 0;
    for (const e of this._docIndex.values()) {
      totalDocs++;
      if (e.stale) staleDocs++;
      totalReferences += e.references.length;
    }
    return {
      totalDocs,
      staleDocs,
      freshDocs: totalDocs - staleDocs,
      totalReferences,
      freshnessRate: totalDocs > 0 ? (totalDocs - staleDocs) / totalDocs : 1,
      watching: !!this._watcher,
    };
  }

  /**
   * 验证所有文档的新鲜度，将超过阈值的文档标记为stale
   * 普通文档阈值7天，规格文档阈值3天；规格文档自动加入再验证队列
   * 触发'docs-staled-by-threshold'事件
   * @returns {{valid: boolean, newlyStale: number, totalStale: number}} 验证结果，valid表示是否全部新鲜，newlyStale为本轮新标记数，totalStale为总stale数
   */
  validateFreshness() {
    this.guardShutdown();
    if (!this._indexReady) return { valid: true, newlyStale: 0, totalStale: 0 };
    const now = Date.now();
    const newlyStale = [];
    for (const [docPath, entry] of this._docIndex) {
      const threshold = entry.specificationType ? SPEC_STALE_THRESHOLD_MS : STALE_THRESHOLD_MS;
      if (!entry.stale && (now - entry.lastVerifiedAt) > threshold) {
        entry.stale = true;
        entry.staleReason = 'exceeded_stale_threshold';
        if (this._staleDocs.size >= this._maxStaleDocs) {
          const oldest = this._staleDocs.keys().next().value;
          this._staleDocs.delete(oldest);
        }
        this._staleDocs.set(docPath, entry);
        newlyStale.push(entry);
        if (entry.livenessPolicy === 'active') {
          if (this._specReverificationQueue.length < 200) {
            this._specReverificationQueue.push({ path: docPath, entry: entry, stalenessAge: now - entry.lastVerifiedAt });
          }
        }
      }
    }
    if (newlyStale.length > 0) {
      this._persistIndex();
      this.emit('docs-staled-by-threshold', {
        staleDocs: newlyStale.map(d => d.path),
        thresholdMs: STALE_THRESHOLD_MS,
      });
    }
    return {
      valid: newlyStale.length === 0 && this._staleDocs.size === 0,
      newlyStale: newlyStale.length,
      totalStale: this._staleDocs.size,
    };
  }

  /**
   * 获取规格文档再验证队列的副本
   * @returns {Array<{path: string, entry: object, stalenessAge: number}>} 再验证队列数组
   */
  getReverificationQueue() {
    return this._specReverificationQueue.slice();
  }

  /**
   * 手动触发规格文档的再验证流程
   * 每个规格文档最多允许5次再验证尝试，触发'spec-reverification-triggered'事件
   * @param {string} docPath - 规格文档路径
   * @returns {{triggered: boolean, specType?: string, attempt?: number, reason?: string, attempts?: number}} 触发结果，含是否成功、规格类型、当前尝试次数或失败原因
   */
  triggerReverification(docPath) {
    this.guardShutdown();
    const entry = this._docIndex.get(docPath);
    if (!entry) return { triggered: false, reason: 'not_indexed' };
    if (!entry.specificationType) return { triggered: false, reason: 'not_specification' };
    const MAX_REVERIFICATION_ATTEMPTS = 5;
    if ((entry.reverificationAttempts ?? 0) >= MAX_REVERIFICATION_ATTEMPTS) {
      return { triggered: false, reason: 'max_attempts_exceeded', attempts: entry.reverificationAttempts };
    }
    entry.reverificationAttempts = (entry.reverificationAttempts ?? 0) + 1;
    entry.lastReverificationAt = Date.now();
    this._persistIndex();
    this.emit('spec-reverification-triggered', { path: docPath, specType: entry.specificationType, attempt: entry.reverificationAttempts });
    return { triggered: true, specType: entry.specificationType, attempt: entry.reverificationAttempts };
  }

  _isSpecificationDoc(content, docPath) {
    const specPathPatterns = /\b(spec[-_]|specification|requirement[-_]|architecture[-_]|interface[-_]|design[-_]doc|design[-_]spec)\b/i;
    if (specPathPatterns.test(docPath)) return true;
    const specContentMarkers = /##\s*(Specification|规格|需求规格|接口定义|Interface)/i;
    return specContentMarkers.test(content.substring(0, 2000));
  }

  _detectSpecType(content) {
    const prefix = content.substring(0, 3000);
    const scores = {
      requirement: (prefix.match(/需求|requirement/gi) ?? []).length,
      architecture: (prefix.match(/架构|architecture/gi) ?? []).length,
      interface: (prefix.match(/接口|interface/gi) ?? []).length,
      behavior: (prefix.match(/行为|behavior/gi) ?? []).length,
    };
    const entries = Object.entries(scores);
    let maxEntry = ['general', 0];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i][1] > maxEntry[1]) maxEntry = entries[i];
    }
    return maxEntry[1] > 0 ? maxEntry[0] : 'general';
  }

  _onShutdown() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this.stopWatching();
    try {
      this._persistIndex();
    } catch (_e) {
      debug('DocFreshnessGuard', 'persistOnShutdown', _e && _e.message ? _e.message : String(_e));
    }
    this._docIndex.clear();
    this._staleDocs.clear();
    this._specReverificationQueue.length = 0;
    this._indexReady = false;
    this._root = null;
    this._indexPath = null;
    this._eventBus = null;
    this._buildingIndex = false;
    this.removeAllListeners();
  }
}

DocFreshnessGuard.STALE_THRESHOLD_MS = STALE_THRESHOLD_MS;
DocFreshnessGuard.SPEC_STALE_THRESHOLD_MS = SPEC_STALE_THRESHOLD_MS;
DocFreshnessGuard.CODE_EXTENSIONS = CODE_EXTENSIONS;
DocFreshnessGuard.DOC_EXTENSIONS = DOC_EXTENSIONS;

/**
 * 清空并返回规格文档再验证队列中的所有条目
 * @returns {Array<{path: string, entry: object, stalenessAge: number}>} 被清空的再验证队列条目数组
 */
DocFreshnessGuard.prototype.drainReverificationQueue = function drainReverificationQueue() {
  this.guardShutdown();
  return this._specReverificationQueue.splice(0);
};

module.exports = withShutdown(DocFreshnessGuard);
