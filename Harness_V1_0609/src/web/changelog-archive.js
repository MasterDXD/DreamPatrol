'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { debug } = require('../utils/debug-logger');
const { isPathWithinDir } = require('../utils/path-utils');
const { sanitize: sanitizeData, writeAtomic } = require('../utils/debounced-persister');
const { ensureDirSync, sha256Hex, loadJsonSync } = require('../utils/fs-utils');
const { DeepeningError } = require('../errors');
const { timestampId } = require('../utils/unique-id');
const { DEFAULT_CACHE_TTL_MS, HARNESS_DIR, JSON_EXT } = require('../utils/constants');

/** @constant {RegExp} 记录ID格式校验正则 */
const RECORD_ID_PATTERN = /^v_[a-z0-9]+_[a-z0-9]+$/;
/** @constant {number} 最大分页大小 */
const MAX_PAGE_SIZE = 100;

/** @constant {Set<string>} 有效的变更分类集合 */
const VALID_CATEGORIES = new Set(['新增', '变更', '修复', '移除']);

/**
 * @module web/changelog-archive
 * 更新日志归档。版本化变更记录管理，支持分类索引、SHA-256完整性校验和分页查询。
 */
/**
 * ChangelogArchive — 更新日志归档
 * 版本化变更记录管理，支持分类索引（新增/变更/修复/移除）、SHA-256完整性校验和分页查询。
 * 每条记录写入独立JSON文件，索引文件维护全局版本列表与哈希校验。
 * 记录创建后不可变（immutable），重复版本号拒绝写入。
 * 支持关键词/分类/日期范围/Agent维度的搜索，以及全量完整性验证。
 * @classdesc 变更日志归档服务，管理变更日志的存储、检索和版本化归档
 * @emits ChangelogArchive#record-created
 */
class ChangelogArchive {
  /**
   * 创建ChangelogArchive实例。
   * @param {string} projectRoot - 项目根目录路径
   * @throws {DeepeningError} projectRoot无效时抛出
   */
  constructor(projectRoot) {
    if (!projectRoot || typeof projectRoot !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'projectRoot is required and must be a string');
    }
    this.root = projectRoot;
    this.archiveDir = path.join(projectRoot, HARNESS_DIR, 'archive');
    this.indexFile = path.join(this.archiveDir, 'index.json');
    this._indexCacheTtl = DEFAULT_CACHE_TTL_MS;
    this._indexCacheTime = 0;
    this._ensureDir();
  }

  /**
   * 确保归档目录和索引文件存在。
   * @private
   */
  _ensureDir() {
    try {
      ensureDirSync(this.archiveDir);
      if (!fs.existsSync(this.indexFile)) {
        writeAtomic(this.indexFile, { versions: [], hash: '' });
      }
      this._dirReady = true;
    } catch (err) {
      debug('ChangelogArchive', '_ensureDir', err);
      this._dirReady = false;
    }
  }

  /**
   * 计算数据的SHA-256哈希值（键排序后取前32位）。
   * @param {*} data - 待计算哈希的数据
   * @returns {string} 哈希值字符串
   * @private
   */
  _computeHash(data) {
    const canonical = JSON.stringify(data, function(key, val) {
      if (val && typeof val === 'object' && val !== null && !Array.isArray(val)) {
        const sorted = {};
        for (const k of Object.keys(val).sort()) { sorted[k] = val[k]; }
        return sorted;
      }
      return val;
    });
    return sha256Hex(canonical).slice(0, 32);
  }

  /**
   * 验证条目格式合法性。
   * @param {Object} entry - 待验证的条目
   * @returns {string|null} 错误信息，验证通过返回null
   * @private
   */
  _validateEntry(entry) {
    if (!entry || !entry.version || !entry.changes) {
      return 'Missing required fields: version, changes';
    }
    if (typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+/.test(entry.version)) {
      return 'Invalid version format: must be semver (e.g. 1.0.0)';
    }
    if (!Array.isArray(entry.changes) && typeof entry.changes !== 'object') {
      return 'Invalid changes: must be an array or object';
    }
    if (entry.category && !VALID_CATEGORIES.has(entry.category)) {
      return 'Invalid category: must be one of 新增,变更,修复,移除';
    }
    return null;
  }

  /**
   * 记录一条变更日志条目。写入独立JSON文件并更新索引。
   * 记录创建后不可变（immutable），重复版本号拒绝写入。
   * @param {Object} entry - 变更条目
   * @param {string} entry.version - 语义化版本号
   * @param {Array|Object} entry.changes - 变更内容
   * @param {string} [entry.summary] - 变更摘要
   * @param {string} [entry.category='变更'] - 变更分类（新增/变更/修复/移除）
   * @param {string[]} [entry.files] - 涉及文件列表
   * @param {string} [entry.agent='未知'] - 执行Agent
   * @returns {{ success: boolean, error?: string, id?: string, hash?: string }} 操作结果
   */
  record(entry) {
    if (!this._dirReady) return { success: false, error: 'archive directory not ready' };
    const validationError = this._validateEntry(entry);
    if (validationError) {
      return { success: false, error: validationError };
    }

    const now = new Date();
    const timestamp = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0') + '.' +
      String(now.getMilliseconds()).padStart(3, '0');

    const record = {
      id: 'v_' + timestampId(),
      version: entry.version,
      date: entry.date ?? timestamp.split(/[T ]/)[0],
      timestamp: timestamp,
      changes: entry.changes,
      summary: entry.summary ?? '',
      category: entry.category ?? '变更',
      files: entry.files ?? [],
      agent: entry.agent ?? '未知',
      phase: entry.phase ?? '',
      beforeSnapshot: entry.beforeSnapshot ?? null,
      afterSnapshot: entry.afterSnapshot ?? null,
      immutable: true,
    };

    record.hash = this._computeHash(record);

    const index = this._readIndex();

    const existing = index.versions.findIndex(v => v.version === record.version);
    if (existing >= 0) {
      return { success: false, error: 'Version already exists and cannot be modified (immutable)' };
    }

    const indexEntry = {
      id: record.id,
      version: record.version,
      date: record.date,
      timestamp: record.timestamp,
      hash: record.hash,
      summary: record.summary,
      category: record.category,
      agent: record.agent,
    };

    try {
      if (!RECORD_ID_PATTERN.test(record.id)) {
        return { success: false, error: 'Invalid record id format' };
      }
      const recordFile = path.join(this.archiveDir, record.id + JSON_EXT);
      if (!isPathWithinDir(recordFile, this.archiveDir)) {
        return { success: false, error: 'Invalid record id: path traversal detected' };
      }
      writeAtomic(recordFile, record);
    } catch (err) {
      debug('ChangelogArchive', 'record', err);
      return { success: false, error: 'Failed to write record file' };
    }

    index.versions.push(indexEntry);
    index.hash = this._computeHash(index.versions);
    const indexWritten = this._writeIndex(index);
    if (!indexWritten) {
      return { success: false, error: 'Failed to write index file' };
    }

    return { success: true, id: record.id, hash: record.hash };
  }

  /**
   * 根据记录ID获取单条记录。验证哈希完整性，篡改时返回带tampered标记的对象。
   * @param {string} recordId - 记录ID
   * @returns {Object|null} 记录对象，未找到或ID格式无效返回null
   * @example
   * const archive = new ChangelogArchive('/path/to/project');
   * archive.record({ version: '1.0.0', changes: ['initial release'] });
   * const rec = archive.getRecord('v_abc123_def456');
   * if (rec && !rec.tampered) console.log(rec.version, rec.changes);
   */
  getRecord(recordId) {
    if (!this._dirReady) return null;
    if (!RECORD_ID_PATTERN.test(recordId)) return null;
    const recordFile = path.join(this.archiveDir, recordId + JSON_EXT);
    if (!isPathWithinDir(recordFile, this.archiveDir)) return null;
    if (!fs.existsSync(recordFile)) return null;

    try {
      const raw = loadJsonSync(recordFile);
      if (!raw) return null;
      if (!this._verifyRecord(raw)) {
        return { tampered: true, id: raw.id || recordId };
      }
      return sanitizeData(raw);
    } catch (_err) {
      debug('ChangelogArchive', 'getRecord', _err);
      return { _error: _err.message || String(_err) };
    }
  }

  /**
   * 验证单条记录的哈希完整性（使用timingSafeEqual防时序攻击）。
   * @param {Object} record - 待验证的记录
   * @returns {boolean} 完整性验证通过返回true
   * @private
   */
  _verifyRecord(record) {
    if (!record || !record.hash) return false;
    const copy = { ...record };
    delete copy.hash;
    const computed = this._computeHash(copy);
    try {
      const a = Buffer.from(computed, 'hex');
      const b = Buffer.from(record.hash, 'hex');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch (_e) {
      debug('ChangelogArchive', '_verifyRecord', _e && _e.message ? _e.message : String(_e));
      return false;
    }
  }

  /**
   * 验证全部记录的完整性。检查索引哈希和每条记录的哈希。
   * @returns {Object} 完整性验证结果，包含indexValid、recordsValid、recordsTampered、recordsMissing、details
   */
  verifyIntegrity() {
    const index = this._readIndex();
    const results = { indexValid: true, recordsValid: 0, recordsTampered: 0, recordsMissing: 0, details: [] };

    const indexHash = this._computeHash(index.versions);
    if (indexHash !== index.hash) {
      results.indexValid = false;
    }

    for (const entry of index.versions) {
      const record = this.getRecord(entry.id);
      if (!record) {
        results.details.push({ id: entry.id, status: 'missing' });
        results.recordsMissing++;
      } else if (record.tampered) {
        results.details.push({ id: entry.id, status: 'tampered' });
        results.recordsTampered++;
      } else {
        results.recordsValid++;
      }
    }

    results.total = index.versions.length;
    return results;
  }

  /**
   * 搜索变更日志记录，支持关键词/分类/日期范围/Agent维度过滤和分页。
   * @param {Object} [query] - 查询条件
   * @param {string} [query.keyword] - 关键词搜索（匹配summary、version、agent）
   * @param {string} [query.category] - 按分类过滤
   * @param {string} [query.since] - 起始日期过滤
   * @param {string} [query.until] - 截止日期过滤
   * @param {string} [query.agent] - 按Agent过滤
   * @param {number} [query.page=1] - 页码
   * @param {number} [query.pageSize=10] - 每页大小
   * @returns {Object} 分页结果，包含total、page、pageSize、totalPages、items
   */
  search(query) {
    if (!this._dirReady) return { total: 0, page: 1, pageSize: 10, totalPages: 0, items: [] };
    if (!query || typeof query !== 'object') return { total: 0, page: 1, pageSize: 10, totalPages: 0, items: [] };
    const index = this._readIndex();
    let results = index.versions;

    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      results = results.filter(v =>
        (v.summary || '').toLowerCase().includes(kw) ||
        (v.version || '').toLowerCase().includes(kw) ||
        (v.agent || '').toLowerCase().includes(kw),
      );
    }

    if (query.category) {
      results = results.filter(v => v.category === query.category);
    }

    if (query.since) {
      results = results.filter(v => v.date >= query.since);
    }

    if (query.until) {
      results = results.filter(v => v.date <= query.until);
    }

    if (query.agent) {
      results = results.filter(v => (v.agent || '').includes(query.agent));
    }

    const total = results.length;
    const rawPage = typeof query.page === 'number' ? query.page : parseInt(query.page, 10);
    const rawPageSize = typeof query.pageSize === 'number' ? query.pageSize : parseInt(query.pageSize, 10);
    const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(rawPageSize) ? rawPageSize : 10));
    const start = (page - 1) * pageSize;
    const paged = results.slice(start, start + pageSize);

    const safePageSize = (typeof pageSize === 'number' && Number.isFinite(pageSize) && pageSize > 0) ? pageSize : 20;
    const totalPages = Math.ceil(total / safePageSize);

    return {
      total: total,
      page: page,
      pageSize: pageSize,
      totalPages: totalPages,
      items: paged.map(v => ({ ...v })),
    };
  }

  /**
   * 获取完整记录（getRecord的别名）。
   * @param {string} recordId - 记录ID
   * @returns {Object|null} 完整记录对象
   */
  getFullRecord(recordId) {
    return this.getRecord(recordId);
  }

  /**
   * 获取变更日志统计信息，按分类、Agent和月份聚合。
   * @returns {Object} 统计对象，包含total、byCategory、byAgent、byMonth
   */
  getStats() {
    const index = this._readIndex();
    const stats = {
      total: index.versions.length,
      byCategory: {},
      byAgent: {},
      byMonth: {},
    };

    index.versions.forEach(v => {
      stats.byCategory[v.category || '未知'] = (stats.byCategory[v.category || '未知'] ?? 0) + 1;
      stats.byAgent[v.agent || '未知'] = (stats.byAgent[v.agent || '未知'] ?? 0) + 1;
      const month = (v.date || '').slice(0, 7);
      if (month) stats.byMonth[month] = (stats.byMonth[month] ?? 0) + 1;
    });

    return stats;
  }

  /**
   * 读取索引文件，支持TTL缓存。
   * @returns {Object} 索引对象
   * @private
   */
  _readIndex() {
    const now = Date.now();
    if (this._indexCache && (now - this._indexCacheTime) < this._indexCacheTtl) return this._indexCache;
    try {
      this._indexCache = loadJsonSync(this.indexFile, sanitizeData) || { versions: [], hash: '' };
      this._indexCacheTime = now;
      return this._indexCache;
    } catch (_err) {
      debug('ChangelogArchive', 'readIndex', _err);
      throw _err;
    }
  }

  /**
   * 写入索引文件并更新缓存。
   * @param {Object} index - 索引对象
   * @private
   */
  _writeIndex(index) {
    try {
      writeAtomic(this.indexFile, index);
      this._indexCache = index;
      this._indexCacheTime = Date.now();
      return true;
    } catch (err) {
      debug('ChangelogArchive', '_writeIndex', err);
      return { _error: err.message || String(err) };
    }
  }


  /**
   * 检查归档是否健康（目录和索引文件是否存在）。
   * @returns {boolean} 健康返回true
   */
  isHealthy() {
    try {
      if (!fs.existsSync(this.archiveDir)) return false;
      if (!fs.existsSync(this.indexFile)) return false;
      return true;
    } catch (_e) {
      debug('ChangelogArchive', 'isArchiveReady', _e);
      return { _error: _e.message || String(_e) };
    }
  }
}

module.exports = ChangelogArchive;
