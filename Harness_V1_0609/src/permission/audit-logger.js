'use strict';

/**
 * 审计日志记录器。提供链式哈希完整性验证、防抖持久化、查询过滤功能。
 * 每条日志条目包含时间戳、Agent、操作、目标、结果等字段，并计算SHA-256哈希
 * 形成链式结构，确保日志不可篡改。
 *
 * @module permission/audit-logger
 * @fires AuditLogger#persist-error
 * @fires AuditLogger#restore-error
 * @fires AuditLogger#integrity-violation
 * @fires AuditLogger#shutdown
 * @example
 * const logger = new AuditLogger(projectRoot, { maxEntries: 10000 });
 * logger.log({ agent: 'worker', action: 'file-write', target: '/src/foo.js', result: 'allowed' });
 * logger.verifyIntegrity(); // { total, tampered, valid }
 */

const path = require('path');
const { EventEmitter } = require('events');
const { DEFAULT_AGENT_NAME, DANGEROUS_KEYS, MAX_AUDIT_LOG_FILE_SIZE, DEFAULT_MAX_ENTRIES, HARNESS_DIR, DEFAULT_PERSIST_DEBOUNCE_MS } = require('../utils/constants');
const BoundedArray = require('../utils/bounded-array');
const { createPersister, writeAtomic } = require('../utils/debounced-persister');
const { debug } = require('../utils/debug-logger');
const { emitError, safeCall } = require('../utils/safe-execute');
const { sha256Hex } = require('../utils/fs-utils');
const JsonStoreRestorer = require('../utils/json-store-restorer');
const stableStringify = require('../utils/stable-stringify');
const { withShutdown } = require('../utils/shutdown-mixin');

/** @constant {number} 最大日志条目数 */
const MAX_LOG_ENTRIES = DEFAULT_MAX_ENTRIES;
const MAX_DETAIL_LENGTH = 10000;
const MAX_FIELD_LENGTH = 1000;

function _truncateField(value, maxLen, defaultVal) {
  if (typeof value !== 'string') return typeof defaultVal === 'string' ? defaultVal : '';
  if (value.length <= maxLen) return value;
  return value.substring(0, maxLen) + '...[truncated]';
}

/**
 * @classdesc 审计日志。链式哈希完整性验证、防抖持久化
 * 审计日志记录器。维护链式哈希的审计日志，支持持久化和完整性验证。
 * @extends EventEmitter
 * @param {string} [projectRoot] - 项目根目录，提供时启用持久化
 * @param {object} [options] - 配置选项
 * @param {number} [options.maxEntries=10000] - 最大日志条目数
 */
class AuditLogger extends EventEmitter {
  constructor(projectRoot, options) {
    super();
    const { maxEntries } = options ?? {};
    let entries = maxEntries;
    if (typeof entries === 'number') {
      if (!Number.isFinite(entries) || entries < 1) entries = MAX_LOG_ENTRIES;
    } else {
      entries = MAX_LOG_ENTRIES;
    }
    this._entries = new BoundedArray(entries);
    this.maxEntries = this._entries.maxSize;
    this.root = (typeof projectRoot === 'string' && projectRoot) ? projectRoot : null;
    this._persister = null;
    this._lastHash = '';
    this._logSequence = 0;
    if (this.root) {
      this._persister = createPersister({
        root: projectRoot,
        dir: 'audit',
        filename: 'audit-log.json',
        debounceMs: DEFAULT_PERSIST_DEBOUNCE_MS,
        serialize: () => this._entries.toArray(),
        onError: (err) => {
          debug('AuditLogger', '_persistNow', err);
          emitError(this, 'persist-error', err);
        },
      });
      this._restore();
    }
  }

  /**
   * 构建哈希数据字符串，用于链式哈希计算。
   * @param {Object} entry - 审计条目
   * @param {number} index - 条目序列号
   * @param {string} prevHash - 前一条目的哈希值
   * @returns {string} 编码后的哈希数据字符串
   * @private
   */
  _buildHashData(entry, index, prevHash) {
    const detailsStr = typeof entry.details === 'string' ? entry.details : stableStringify(entry.details || '');
    return [
      String(index),
      entry.timestamp,
      entry.agent,
      entry.action,
      entry.target,
      entry.result,
      entry.reason || '',
      detailsStr,
      entry.responsibility || '',
      prevHash,
    ].map(v => encodeURIComponent(String(v))).join('&');
  }

  /**
   * 计算条目的SHA-256哈希值。
   * @param {Object} entry - 审计条目
   * @param {number} index - 条目序列号
   * @returns {string} 哈希值
   * @private
   */
  _computeEntryHash(entry, index) {
    const data = this._buildHashData(entry, index, this._lastHash);
    return sha256Hex(data);
  }

  /**
   * 获取所有审计日志条目的副本。
   * @type {Object[]}
   */
  get entries() {
    return this._entries.toArray();
  }

  /**
   * 记录一条审计日志。自动计算链式哈希并安排持久化。
   * @param {Object} event - 审计事件
   * @param {string} [event.agent] - 执行Agent名称
   * @param {string} [event.action] - 操作类型
   * @param {string} [event.target] - 操作目标
   * @param {string} [event.result] - 操作结果
   * @param {string} [event.reason] - 操作原因
   * @param {string} [event.details] - 操作详情
   * @param {string} [event.responsibility] - 责任归属（默认'ai-autonomous'）
   */
  log(event) {
    this.guardShutdown();
    if (!this.isHealthy()) return;
    if (!event || typeof event !== 'object') {
      debug('AuditLogger', 'log', 'Invalid event: must be a non-null object');
      return;
    }
    const entry = {
      timestamp: new Date().toISOString(),
      agent: _truncateField(event.agent, MAX_FIELD_LENGTH, DEFAULT_AGENT_NAME),
      action: _truncateField(event.action, MAX_FIELD_LENGTH, 'unknown'),
      target: _truncateField(event.target, MAX_FIELD_LENGTH),
      result: _truncateField(event.result, MAX_FIELD_LENGTH, 'unknown'),
      reason: _truncateField(event.reason, MAX_FIELD_LENGTH),
      details: _truncateField(event.details, MAX_DETAIL_LENGTH),
      responsibility: _truncateField(event.responsibility, MAX_FIELD_LENGTH, 'ai-autonomous'),
    };
    entry._seq = this._logSequence++;
    entry._hash = this._computeEntryHash(entry, entry._seq);
    this._lastHash = entry._hash;
    this._entries.push(entry);
    this._schedulePersist();
  }

  /**
   * 验证审计日志的链式哈希完整性。检测被篡改的条目。
   * @returns {{ total: number, tampered: number, tamperedIndices: number[], valid: boolean }} 完整性验证结果
   */
  verifyIntegrity() {
    const entries = this._entries.toArray();
    let prevHash = '';
    let tampered = 0;
    const tamperedIndices = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const seq = entry._seq !== undefined ? entry._seq : i;
      const data = this._buildHashData(entry, seq, prevHash);
      const expected = sha256Hex(data);
      if (!entry._hash) {
        tampered++;
        tamperedIndices.push(i);
        prevHash = expected;
      } else if (entry._hash !== expected) {
        tampered++;
        tamperedIndices.push(i);
        prevHash = entry._hash;
      } else {
        prevHash = entry._hash;
      }
    }
    return { total: entries.length, tampered, tamperedIndices, valid: tampered === 0 };
  }

  /**
   * 查询审计日志，支持按Agent/操作/结果/目标/责任归属过滤。
   * @param {Object} [filter] - 过滤条件
   * @param {string} [filter.agent] - 按Agent过滤
   * @param {string} [filter.action] - 按操作类型过滤
   * @param {string} [filter.result] - 按结果过滤
   * @param {string} [filter.target] - 按目标过滤
   * @param {string} [filter.responsibility] - 按责任归属过滤
   * @returns {Object[]} 匹配的条目数组
   */
  query(filter) {
    if (!filter || typeof filter !== 'object') return this._entries.toArray();
    return this._entries.filter(entry => {
      if (filter.agent && entry.agent !== filter.agent) return false;
      if (filter.action && entry.action !== filter.action) return false;
      if (filter.result && entry.result !== filter.result) return false;
      if (filter.target && entry.target !== filter.target) return false;
      if (filter.responsibility && entry.responsibility !== filter.responsibility) return false;
      return true;
    });
  }

  /**
   * 获取最近N条审计日志。
   * @param {number} [count=10] - 获取条数
   * @returns {Object[]} 最近的条目数组
   */
  getRecent(count = 10) {
    if (typeof count !== 'number' || count <= 0) return [];
    return this._entries.slice(-count);
  }

  /**
   * 获取审计日志统计信息，包含总数、允许/拒绝计数、按Agent和责任归属的聚合。
   * @returns {Object} 统计对象，包含total、allowed、denied、byAgent、byResponsibility
   */
  getStats() {
    const stats = { total: this._entries.length, allowed: 0, denied: 0, byAgent: {}, byResponsibility: {} };
    this._entries.forEach(entry => {
      if (entry.result === 'allowed') stats.allowed++;
      if (entry.result === 'denied') stats.denied++;
      stats.byAgent[entry.agent] = (stats.byAgent[entry.agent] ?? 0) + 1;
      const resp = entry.responsibility || 'ai-autonomous';
      stats.byResponsibility[resp] = (stats.byResponsibility[resp] ?? 0) + 1;
    });
    return stats;
  }

  /**
   * 清空所有审计日志并立即持久化。
   * @returns {void}
   */
  clear(authorizedBy) {
    this.guardShutdown();
    if (!authorizedBy || typeof authorizedBy !== 'string') {
      throw new Error('Audit log clear requires authorization identity');
    }
    const previousCount = this._entries.length;
    this._entries.clear();
    this._entries.push({
      timestamp: new Date().toISOString(),
      agent: _truncateField(authorizedBy, MAX_FIELD_LENGTH, DEFAULT_AGENT_NAME),
      action: 'audit-clear',
      target: 'audit-log',
      result: 'cleared',
      meta: { previousCount },
      _seq: ++this._logSequence,
    });
    this._persistNow();
  }

  /**
   * 导出审计日志为格式化JSON字符串。
   * @returns {string} JSON格式字符串
   */
  export() {
    return JSON.stringify(this._entries.toArray(), null, 2);
  }

  /**
   * 刷新持久化缓冲区，确保所有日志写入磁盘。
   * @returns {void}
   */
  flush() {
    if (this._persister) this._persister.flush();
    else this._persistNow();
  }

  /**
   * 关闭时刷新持久化缓冲区。
   * @private
   */
  _onShutdown() {
    try { this.flush(); } catch (_e) { debug('AuditLogger', '_onShutdown:flush', _e && _e.message ? _e.message : String(_e)); }
    safeCall(() => this._entries.shutdown(), 'AuditLogger', 'shutdown-entries');
    this._lastHash = '';
    this._logSequence = 0;
    this.removeAllListeners();
  }

  _schedulePersist() {
    if (!this.root || !this.isHealthy()) return;
    if (this._persister) {
      this._persister.schedule();
    } else {
      this._persistNow();
    }
  }

  _persistNow() {
    if (!this.root) return;
    try {
      const filePath = path.join(this.root, HARNESS_DIR, 'audit', 'audit-log.json');
      writeAtomic(filePath, this._entries.toArray());
    } catch (err) {
      debug('AuditLogger', '_persistNow', err);
      emitError(this, 'persist-error', err);
    }
  }

  async _restoreWith(loader) {
    if (!this.root) return;
    try {
      const result = await loader();
      if (!result) return;
      this._restoreEntries(result.data);
      this._restoreIntegrity();
    } catch (err) {
      debug('AuditLogger', '_restore', err);
      emitError(this, 'restore-error', err);
    }
  }

  _restore() {
    return this._restoreWith(() => JsonStoreRestorer.loadSync(this.root, 'audit/audit-log.json', {
      maxSize: MAX_AUDIT_LOG_FILE_SIZE,
      expectedType: 'array',
      logLabel: 'AuditLogger',
    }));
  }

  async _restoreAsync() {
    return this._restoreWith(() => JsonStoreRestorer.loadAsync(this.root, 'audit/audit-log.json', {
      maxSize: MAX_AUDIT_LOG_FILE_SIZE,
      expectedType: 'array',
      logLabel: 'AuditLogger',
    }));
  }

  _restoreEntries(data) {
    const REQUIRED_KEYS_ARR = ['timestamp', 'agent', 'action', 'target', 'result', '_hash'];
    let maxSeq = -1;
    for (const entry of data) {
      if (!entry || typeof entry !== 'object') continue;
      const hasRequiredKeys = REQUIRED_KEYS_ARR.every(k => k in entry);
      if (!hasRequiredKeys) continue;
      const keys = Object.keys(entry);
      if (keys.some(k => DANGEROUS_KEYS.has(k))) continue;
      if (entry._hash && typeof entry._hash === 'string') {
        const seq = entry._seq !== undefined ? entry._seq : this._entries.length;
        const hashData = this._buildHashData(entry, seq, this._lastHash);
        const expected = sha256Hex(hashData);
        if (entry._hash !== expected) continue;
        this._lastHash = entry._hash;
      }
      if (entry._seq !== undefined && typeof entry._seq === 'number' && entry._seq > maxSeq) {
        maxSeq = entry._seq;
      }
      this._entries.push(entry);
    }
    if (maxSeq >= 0) {
      this._logSequence = maxSeq + 1;
    }
  }

  _restoreIntegrity() {
    const integrity = this.verifyIntegrity();
    if (integrity.tampered > 0) {
      this.emit('integrity-violation', integrity);
      debug('AuditLogger', '_restore', 'Integrity violation: ' + integrity.tampered + ' tampered entries');
      const tamperedSet = new Set(integrity.tamperedIndices);
      const kept = this._entries.filter(function(_, idx) { return !tamperedSet.has(idx); });
      this._entries.clear();
      for (const entry of kept) {
        this._entries.push(entry);
      }
      if (this._entries.length > 0) {
        const lastEntry = this._entries.get(this._entries.length - 1);
        this._lastHash = (lastEntry && lastEntry._hash) || '';
      } else {
        this._lastHash = '';
      }
    }
  }
}

/** @constant {number} 最大日志条目数 */
AuditLogger.MAX_LOG_ENTRIES = MAX_LOG_ENTRIES;

module.exports = withShutdown(AuditLogger);
