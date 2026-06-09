'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { HarnessError } = require('../errors');
const { DANGEROUS_KEYS, validateProjectRoot, MAX_JSON_FILE_SIZE, MS_PER_DAY, DEFAULT_DEBOUNCE_MS } = require('../utils/constants');
const { sanitizePath, isPathWithinDir } = require('../utils/path-utils');
const { createPersister } = require('../utils/debounced-persister');
const JsonStoreRestorer = require('../utils/json-store-restorer');
const { debug } = require('../utils/debug-logger');
const { withShutdown } = require('../utils/shutdown-mixin');
const { emitError, safeDateGetTime } = require('../utils/safe-execute');
const { uuid, ID_PREFIXES } = require('../utils/unique-id');

/** @constant {object} DEVIATION_STATUS - 偏差状态枚举 */
const DEVIATION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
};

/** @constant {object} DEVIATION_SEVERITY - 偏差严重度枚举 */
const DEVIATION_SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

/** @constant {Set<string>} DEVIATION_SEVERITY_SET - 偏差严重度集合 */
const DEVIATION_SEVERITY_SET = new Set(Object.values(DEVIATION_SEVERITY));

/** @constant {number} MAX_DEVIATIONS - 最大偏差记录数 */
const MAX_DEVIATIONS = 200;
/** @constant {number} DEFAULT_TTL_DAYS - 默认TTL天数 */
const DEFAULT_TTL_DAYS = 14;
/** @constant {number} PENDING_TTL_DAYS - 待审批TTL天数 */
const PENDING_TTL_DAYS = 7;

/**
 * @module gate/deviation-approval
 * 偏差审批。请求/批准/拒绝/撤销生命周期，TTL过期，
 * 支持多级严重度（low/medium/high）和防抖持久化。
 */
/**
 * @classdesc 偏差审批。请求/批准/拒绝/撤销生命周期
 * 偏差审批管理器。支持请求/批准/拒绝/撤销生命周期，TTL过期，
 * 多级严重度（low/medium/high）和防抖持久化。
 * @extends EventEmitter
 * @emits deviation-requested | deviation-approved | deviation-rejected | deviation-revoked | deviation-expired | persist-error
 */
class DeviationApproval extends EventEmitter {
  /**
   * 创建DeviationApproval实例。
   * @param {string} projectRoot - 项目根目录路径
   * @param {object} [options] - 配置选项
   * @param {number} [options.maxDeviations=200] - 最大偏差记录数
   * @param {number} [options.defaultTtlDays=14] - 默认TTL天数
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'DeviationApproval');
    this.root = projectRoot;
    this._maxDeviations = (options && options.maxDeviations !== undefined) ? options.maxDeviations : MAX_DEVIATIONS;
    this._defaultTtlDays = (options && options.defaultTtlDays !== undefined) ? options.defaultTtlDays : DEFAULT_TTL_DAYS;
    this._deviations = new Map();
    this._stats = { requested: 0, approved: 0, rejected: 0, revoked: 0, expired: 0, errors: 0 };
    this._persister = createPersister({
      root: projectRoot,
      dir: 'deviations',
      filename: 'deviations.json',
      debounceMs: DEFAULT_DEBOUNCE_MS,
      serialize: () => {
        const data = [];
        for (const [, d] of this._deviations) data.push(d);
        return data;
      },
      onError: (err) => {
        debug('DeviationApproval', 'persist', err);
        emitError(this, 'persist-error', err);
      },
    });
    this._restore();
  }

  /**
   * 提交偏差审批请求。
   * @param {object} data - 偏差请求数据
   * @param {string} data.ruleId - 违反的规则ID
   * @param {string} data.file - 违规文件路径
   * @param {string} data.reason - 偏差原因
   * @param {string} [data.proposedAlternative] - 建议的替代方案
   * @param {'low'|'medium'|'high'} [data.severity='medium'] - 严重度
   * @param {string} [data.requestedBy='unknown'] - 请求人
   * @param {number} [data.ttlDays] - TTL天数
   * @returns {object} 偏差记录
   * @throws {HarnessError} 缺少必填字段或文件路径不安全时抛出
   * @emits DeviationApproval#deviation-requested
   */
  request(data) {
    this.guardShutdown();
    if (!data || !data.ruleId || !data.file || !data.reason) {
      throw new HarnessError('MISSING_FIELDS', 'Deviation request requires ruleId, file, and reason');
    }
    if (!this._isSafeFilePath(data.file)) {
      throw new HarnessError('INVALID_INPUT', 'Deviation file path must be a safe relative path without traversal sequences');
    }

    const existing = this._findByRuleAndFile(data.ruleId, data.file);
    if (existing && existing.status === DEVIATION_STATUS.APPROVED) {
      return existing;
    }

    const id = uuid(ID_PREFIXES.DEVIATION);
    let ttlDays = typeof data.ttlDays === 'number' && Number.isFinite(data.ttlDays) ? data.ttlDays : this._defaultTtlDays;
    if (ttlDays > 36500) ttlDays = this._defaultTtlDays;
    const expiresAt = new Date(Date.now() + ttlDays * MS_PER_DAY).toISOString();

    const deviation = {
      id,
      ruleId: data.ruleId,
      file: data.file,
      reason: data.reason,
      proposedAlternative: data.proposedAlternative || '',
      severity: data.severity && DEVIATION_SEVERITY_SET.has(data.severity) ? data.severity : DEVIATION_SEVERITY.MEDIUM,
      status: DEVIATION_STATUS.PENDING,
      requestedBy: data.requestedBy ?? 'unknown',
      requestedAt: new Date().toISOString(),
      expiresAt,
      reviewedBy: null,
      reviewedAt: null,
      reviewComment: null,
    };

    if (this._deviations.size >= this._maxDeviations) {
      this._evictOldest();
    }

    this._deviations.set(id, deviation);
    this._schedulePersist();
    this.emit('deviation-requested', deviation);
    return deviation;
  }

  /**
   * 批准偏差请求。
   * @param {string} deviationId - 偏差ID
   * @param {string} [reviewer] - 审批人
   * @param {string} [comment] - 审批意见
   * @returns {object|null} 更新后的偏差记录，未找到或状态不符时返回null
   * @emits DeviationApproval#deviation-approved
   */
  approve(deviationId, reviewer, comment) {
    this.guardShutdown();
    const deviation = this._deviations.get(deviationId);
    if (!deviation) return null;
    if (deviation.status !== DEVIATION_STATUS.PENDING) return null;

    deviation.status = DEVIATION_STATUS.APPROVED;
    deviation.reviewedBy = reviewer ?? 'unknown';
    deviation.reviewedAt = new Date().toISOString();
    deviation.reviewComment = comment || '';

    this._schedulePersist();
    this.emit('deviation-approved', deviation);
    return deviation;
  }

  /**
   * 拒绝偏差请求。
   * @param {string} deviationId - 偏差ID
   * @param {string} [reviewer] - 审批人
   * @param {string} [comment] - 拒绝原因
   * @returns {object|null} 更新后的偏差记录，未找到或状态不符时返回null
   * @emits DeviationApproval#deviation-rejected
   */
  reject(deviationId, reviewer, comment) {
    this.guardShutdown();
    const deviation = this._deviations.get(deviationId);
    if (!deviation) return null;
    if (deviation.status !== DEVIATION_STATUS.PENDING) return null;

    deviation.status = DEVIATION_STATUS.REJECTED;
    deviation.reviewedBy = reviewer ?? 'unknown';
    deviation.reviewedAt = new Date().toISOString();
    deviation.reviewComment = comment || '';

    this._schedulePersist();
    this.emit('deviation-rejected', deviation);
    return deviation;
  }

  /**
   * 撤销已批准的偏差。
   * @param {string} deviationId - 偏差ID
   * @param {string} [revoker] - 撤销人
   * @param {string} [reason] - 撤销原因
   * @returns {object|null} 更新后的偏差记录，未找到或状态不符时返回null
   * @emits DeviationApproval#deviation-revoked
   */
  revoke(deviationId, revoker, reason) {
    this.guardShutdown();
    const deviation = this._deviations.get(deviationId);
    if (!deviation) return null;
    if (deviation.status !== DEVIATION_STATUS.APPROVED) return null;

    deviation.status = DEVIATION_STATUS.REVOKED;
    deviation.revokedBy = revoker ?? 'unknown';
    deviation.revokedAt = new Date().toISOString();
    deviation.revokeReason = reason || '';

    this._schedulePersist();
    this.emit('deviation-revoked', deviation);
    return deviation;
  }

  /**
   * 检查指定规则和文件是否有有效的已批准偏差。
   * @param {string} ruleId - 规则ID
   * @param {string} filePath - 文件路径
   * @returns {boolean} 是否有有效的已批准偏差
   */
  isApproved(ruleId, filePath) {
    this.guardShutdown();
    const deviation = this._findByRuleAndFile(ruleId, filePath);
    if (!deviation) return false;
    if (deviation.status !== DEVIATION_STATUS.APPROVED) return false;
    if (!deviation.expiresAt) return false;
    const expiresTime = safeDateGetTime(deviation.expiresAt);
    if (!Number.isFinite(expiresTime)) return false;
    if (expiresTime < Date.now()) {
      return false;
    }
    return true;
  }

  /**
   * 检查并过期已失效的已批准偏差。
   * @param {string} ruleId - 规则ID
   * @param {string} filePath - 文件路径
   * @returns {boolean} 是否成功过期
   */
  expireIfStale(ruleId, filePath) {
    this.guardShutdown();
    const deviation = this._findByRuleAndFile(ruleId, filePath);
    if (!deviation) return false;
    if (deviation.status !== DEVIATION_STATUS.APPROVED) return false;
    if (!deviation.expiresAt) return false;
    const expiresTime = safeDateGetTime(deviation.expiresAt);
    if (!Number.isFinite(expiresTime)) return false;
    if (expiresTime < Date.now()) {
      this._markExpired(deviation);
      return true;
    }
    return false;
  }

  _markExpired(deviation) {
    deviation.status = DEVIATION_STATUS.EXPIRED;
    this._schedulePersist();
    this.emit('deviation-expired', deviation);
  }

  /**
   * 获取所有待审批的偏差列表。
   * @returns {Array<object>} 待审批偏差列表
   */
  getPending() {
    this.guardShutdown();
    this._expireStalePending();
    return this._filterByStatus(DEVIATION_STATUS.PENDING);
  }

  /**
   * 获取所有已批准的偏差列表。
   * @returns {Array<object>} 已批准偏差列表
   */
  getApproved() {
    this.guardShutdown();
    this._expireStaleApproved();
    return this._filterByStatus(DEVIATION_STATUS.APPROVED);
  }

  /**
   * 获取所有已拒绝的偏差列表。
   * @returns {Array<object>} 已拒绝偏差列表
   */
  getRejected() {
    return this._filterByStatus(DEVIATION_STATUS.REJECTED);
  }

  /**
   * 按规则ID获取偏差列表。
   * @param {string} ruleId - 规则ID
   * @returns {Array<object>} 匹配的偏差列表
   */
  getByRule(ruleId) {
    const results = [];
    for (const [, d] of this._deviations) {
      if (d.ruleId === ruleId) results.push(d);
    }
    return results;
  }

  /**
   * 按文件路径获取偏差列表。
   * @param {string} filePath - 文件路径
   * @returns {Array<object>} 匹配的偏差列表
   */
  getByFile(filePath) {
    const results = [];
    for (const [, d] of this._deviations) {
      if (d.file === filePath) results.push(d);
    }
    return results;
  }

  /**
   * 获取偏差统计信息。
   * @returns {{total: number, byStatus: object, bySeverity: object}} 统计信息
   */
  getStats() {
    const stats = { total: this._deviations.size, byStatus: {}, bySeverity: {} };
    for (const status of Object.values(DEVIATION_STATUS)) {
      stats.byStatus[status] = 0;
    }
    for (const sev of Object.values(DEVIATION_SEVERITY)) {
      stats.bySeverity[sev] = 0;
    }
    for (const [, d] of this._deviations) {
      stats.byStatus[d.status] = (stats.byStatus[d.status] ?? 0) + 1;
      stats.bySeverity[d.severity] = (stats.bySeverity[d.severity] ?? 0) + 1;
    }
    return stats;
  }

  /**
   * 立即持久化当前状态到磁盘。
   * @returns {void}
   */
  flush() {
    this._persister.flush();
  }

  _onShutdown() {
    this.flush();
    this._deviations.clear();
    this.removeAllListeners();
  }

  _isSafeFilePath(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) return false;
    if (path.isAbsolute(filePath)) return false;
    const sanitized = sanitizePath(filePath);
    return isPathWithinDir(path.resolve(this.root, sanitized), this.root);
  }

  _findByRuleAndFile(ruleId, filePath) {
    for (const [, d] of this._deviations) {
      if (d.ruleId === ruleId && d.file === filePath) return d;
    }
    return null;
  }

  _filterByStatus(status) {
    const results = [];
    for (const [, d] of this._deviations) {
      if (d.status === status) results.push(d);
    }
    return results;
  }

  _expireStalePending() {
    const cutoff = Date.now() - PENDING_TTL_DAYS * MS_PER_DAY;
    let dirty = false;
    for (const [, d] of this._deviations) {
      if (d.status === DEVIATION_STATUS.PENDING) {
        const ts = safeDateGetTime(d.requestedAt);
        if (!Number.isFinite(ts) || ts < cutoff) {
          this._markExpired(d);
          dirty = true;
        }
      }
    }
    if (dirty) this._schedulePersist();
  }

  _expireStaleApproved() {
    const now = Date.now();
    let dirty = false;
    for (const [, d] of this._deviations) {
      if (d.status === DEVIATION_STATUS.APPROVED && d.expiresAt) {
        const ts = safeDateGetTime(d.expiresAt);
        if (Number.isFinite(ts) && ts < now) {
          this._markExpired(d);
          dirty = true;
        }
      }
    }
    if (dirty) this._schedulePersist();
  }

  _evictOldest() {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, d] of this._deviations) {
      if (d.status === DEVIATION_STATUS.REJECTED || d.status === DEVIATION_STATUS.EXPIRED) {
        const ts = safeDateGetTime(d.requestedAt);
        if (Number.isFinite(ts) && ts < oldestTime) {
          oldestTime = ts;
          oldestId = id;
        }
      }
    }
    if (oldestId) {
      this._deviations.delete(oldestId);
    } else {
      let oldestPendingId = null;
      let oldestPendingTime = Infinity;
      for (const [id, d] of this._deviations) {
        if (d.status === DEVIATION_STATUS.PENDING) {
          const ts = safeDateGetTime(d.requestedAt);
          if (Number.isFinite(ts) && ts < oldestPendingTime) {
            oldestPendingTime = ts;
            oldestPendingId = id;
          }
        }
      }
      if (oldestPendingId) {
        this._deviations.delete(oldestPendingId);
      }
    }
  }

  _schedulePersist() {
    if (!this.isHealthy()) return;
    this._persister.schedule();
  }

  async _restoreWith(loader) {
    try {
      const result = await loader();
      if (!result) return;
      this._restoreEntries(result.data);
      this._expireStalePending();
      this._restoreExpireApproved();
    } catch (_err) {
      debug('DeviationApproval', 'restore', _err);
    }
  }

  _restore() {
    try {
      const result = JsonStoreRestorer.loadSync(this.root, 'deviations/deviations.json', {
        maxSize: MAX_JSON_FILE_SIZE,
        expectedType: 'array',
        logLabel: 'DeviationApproval',
      });
      if (!result) return;
      this._restoreEntries(result.data);
      this._expireStalePending();
      this._restoreExpireApproved();
    } catch (_err) {
      debug('DeviationApproval', 'restore-sync', _err);
      this._stats.errors++;
      try { this.emit('restore-error', { source: 'deviations', error: _err && _err.message ? _err.message : String(_err) }); } catch (_e) { debug('DeviationApproval', 'restore-emit', _e && _e.message ? _e.message : String(_e)); }
    }
  }

  async _restoreAsync() {
    return this._restoreWith(() => JsonStoreRestorer.loadAsync(this.root, 'deviations/deviations.json', {
      maxSize: MAX_JSON_FILE_SIZE,
      expectedType: 'array',
      logLabel: 'DeviationApproval',
    }));
  }

  _restoreEntries(data) {
    const VALID_STATUSES = new Set(Object.values(DEVIATION_STATUS));
    for (const d of data) {
      if (!d || !d.id || typeof d.id !== 'string') continue;
      if (!d.ruleId || !d.file || !d.status) continue;
      if (!VALID_STATUSES.has(d.status)) continue;
      const keys = Object.keys(d);
      if (keys.some(k => DANGEROUS_KEYS.has(k))) continue;
      if (!this._isSafeFilePath(d.file)) continue;
      this._deviations.set(d.id, d);
    }
  }

  _restoreExpireApproved() {
    const now = new Date();
    for (const [, d] of this._deviations) {
      if (d.status === DEVIATION_STATUS.APPROVED && d.expiresAt) {
        const expiresMs = safeDateGetTime(d.expiresAt);
        if (!Number.isFinite(expiresMs) || expiresMs < now.getTime()) {
          this._markExpired(d);
        }
      }
    }
  }
}

DeviationApproval.DEVIATION_STATUS = DEVIATION_STATUS;
DeviationApproval.DEVIATION_SEVERITY = DEVIATION_SEVERITY;
DeviationApproval.MAX_DEVIATIONS = MAX_DEVIATIONS;
DeviationApproval.DEFAULT_TTL_DAYS = DEFAULT_TTL_DAYS;

module.exports = withShutdown(DeviationApproval);
