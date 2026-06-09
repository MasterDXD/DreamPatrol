'use strict';

const { EventEmitter } = require('events');
const { DANGEROUS_KEYS, MAX_JSON_FILE_SIZE, MS_PER_DAY, DEFAULT_DEBOUNCE_MS , HARNESS_DIR} = require('../utils/constants');
const { ensureDirSync, ensureDirAsync } = require('../utils/fs-utils');
const { createPersister } = require('../utils/debounced-persister');
const JsonStoreRestorer = require('../utils/json-store-restorer');
const { debug } = require('../utils/debug-logger');
const path = require('path');
const { timestampId } = require('../utils/unique-id');
const { withShutdown } = require('../utils/shutdown-mixin');
const { emitError, safeDateGetTime } = require('../utils/safe-execute');

/**
 * @module gate/skill-patch-approval
 * 技能补丁审批管理器。管理技能补丁的完整生命周期（pending→approved→applied→revoked），
 * 支持TTL过期、状态机验证、容量限制和防抖持久化。
 */

/** @constant {object} PATCH_STATES - 补丁状态枚举 */
const PATCH_STATES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  APPLIED: 'applied',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
};

/** @constant {object} VALID_TRANSITIONS - 有效状态转换映射 */
const VALID_TRANSITIONS = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['applied', 'expired'],
  rejected: [],
  applied: ['revoked'],
  revoked: [],
  expired: [],
};

/** @constant {number} DEFAULT_PENDING_TTL_DAYS - 待审批默认TTL天数 */
const DEFAULT_PENDING_TTL_DAYS = 7;
/** @constant {number} DEFAULT_APPROVED_TTL_DAYS - 已批准默认TTL天数 */
const DEFAULT_APPROVED_TTL_DAYS = 30;
/** @constant {number} MAX_PATCHES - 最大补丁记录数 */
const MAX_PATCHES = 200;
/** @constant {number} MAX_TIPS_PER_PATCH - 每个补丁最大提示数 */
const MAX_TIPS_PER_PATCH = 10;
/** @constant {Set<string>} EVICTABLE_STATES - 可驱逐的状态集合 */
const EVICTABLE_STATES = new Set([PATCH_STATES.REJECTED, PATCH_STATES.EXPIRED, PATCH_STATES.REVOKED]);
/** @constant {number} MAX_AVOIDANCES_PER_PATCH - 每个补丁最大规避数 */
const MAX_AVOIDANCES_PER_PATCH = 10;
/** @constant {number} MAX_TIP_LENGTH - 提示文本最大长度 */
const MAX_TIP_LENGTH = 500;
/** @constant {string} PERSIST_DIR_NAME - 持久化目录名 */
const PERSIST_DIR_NAME = 'skill-patches';
/** @constant {number} PERSIST_DEBOUNCE_MS - 持久化防抖间隔（毫秒） */
const PERSIST_DEBOUNCE_MS = DEFAULT_DEBOUNCE_MS;

/**
 * @classdesc 技能补丁审批。技能修改审批流程、影响评估
 * 技能补丁审批管理器。管理技能补丁的完整生命周期（pending→approved→applied→revoked），
 * 支持TTL过期、状态机验证、容量限制、防抖持久化和DreamEngine集成。
 * @extends EventEmitter
 * @emits patch-submitted | patch-approved | patch-rejected | patch-applied | patch-revoked | persist-error
 */
class SkillPatchApproval extends EventEmitter {
  /**
   * 创建SkillPatchApproval实例。
   * @param {object} [options] - 配置选项
   * @param {string} [options.projectRoot] - 项目根目录路径
   * @param {number} [options.pendingTTLDays=7] - 待审批TTL天数
   * @param {number} [options.approvedTTLDays=30] - 已批准TTL天数
   */
  constructor(options) {
    super();
    this._root = (options && options.projectRoot) ?? null;
    this._persistDir = this._root ? path.join(this._root, HARNESS_DIR, PERSIST_DIR_NAME) : null;
    this._pendingTTLDays = Math.max(1, (options && options.pendingTTLDays) ?? DEFAULT_PENDING_TTL_DAYS);
    this._approvedTTLDays = Math.max(1, (options && options.approvedTTLDays) ?? DEFAULT_APPROVED_TTL_DAYS);
    this._patches = new Map();
    this._persister = null;
    this._stats = { submitted: 0, approved: 0, rejected: 0, applied: 0, revoked: 0, expired: 0, errors: 0 };
    if (this._root) {
      this._initPersistence();
    }
  }

  _initPersistence() {
    try {
      const dir = this._persistDir;
      ensureDirSync(dir);
      this._restore();
      this._persister = createPersister({
        root: this._root,
        dir: PERSIST_DIR_NAME,
        filename: 'patches.json',
        debounceMs: PERSIST_DEBOUNCE_MS,
        serialize: () => this._serializeState(),
        onError: (err) => {
          debug('SkillPatchApproval', 'persist error', err);
          this._stats.errors++;
          emitError(this, 'persist-error', err);
        },
      });
    } catch (err) {
      debug('SkillPatchApproval', '_initPersistence', err);
      this._stats.errors++;
    }
  }

  async _initPersistenceAsync() {
    try {
      const dir = this._persistDir;
      await ensureDirAsync(dir);
      await this._restoreAsync();
      this._persister = createPersister({
        root: this._root,
        dir: PERSIST_DIR_NAME,
        filename: 'patches.json',
        debounceMs: PERSIST_DEBOUNCE_MS,
        serialize: () => this._serializeState(),
        onError: (err) => {
          debug('SkillPatchApproval', 'persist error', err);
          this._stats.errors++;
          emitError(this, 'persist-error', err);
        },
      });
    } catch (err) {
      debug('SkillPatchApproval', '_initPersistenceAsync', err);
      this._stats.errors++;
    }
  }

  _serializeState() {
    const patches = [];
    for (const [, p] of this._patches) {
      patches.push(p);
    }
    return { patches: patches, savedAt: new Date().toISOString(), version: 1 };
  }

  async _restoreWith(loader) {
    try {
      const result = await loader();
      if (!result) return;
      const data = result.data;
      if (!Array.isArray(data.patches)) return;
      const now = Date.now();
      for (const p of data.patches) {
        if (!p || !p.patchId || typeof p.patchId !== 'string' || !p.state) continue;
        if (Object.keys(p).some(k => DANGEROUS_KEYS.has(k))) continue;
        if (p.state === PATCH_STATES.PENDING) {
          const submittedTime = safeDateGetTime(p.submittedAt);
          if (!Number.isFinite(submittedTime)) { p.state = PATCH_STATES.EXPIRED; this._stats.expired++; }
          else if (now - submittedTime > this._pendingTTLDays * MS_PER_DAY) {
            p.state = PATCH_STATES.EXPIRED;
            this._stats.expired++;
          }
        }
        if (p.state === PATCH_STATES.APPROVED) {
          const approvedTime = safeDateGetTime(p.approvedAt);
          if (!Number.isFinite(approvedTime)) { p.state = PATCH_STATES.EXPIRED; this._stats.expired++; }
          else if (now - approvedTime > this._approvedTTLDays * MS_PER_DAY) {
            p.state = PATCH_STATES.EXPIRED;
            this._stats.expired++;
          }
        }
        this._patches.set(p.patchId, p);
      }
    } catch (err) {
      debug('SkillPatchApproval', '_restore', err);
      this._stats.errors++;
    }
  }

  _restore() {
    try {
      const result = JsonStoreRestorer.loadSync(this._root, PERSIST_DIR_NAME + '/patches.json', {
        maxSize: MAX_JSON_FILE_SIZE,
        expectedType: 'object',
        logLabel: 'SkillPatchApproval',
      });
      if (!result) return;
      const data = result.data;
      if (!Array.isArray(data.patches)) return;
      const now = Date.now();
      for (const p of data.patches) {
        if (!p || !p.patchId || typeof p.patchId !== 'string' || !p.state) continue;
        if (Object.keys(p).some(k => DANGEROUS_KEYS.has(k))) continue;
        if (p.state === PATCH_STATES.PENDING) {
          const submittedTime = safeDateGetTime(p.submittedAt);
          if (!Number.isFinite(submittedTime)) { p.state = PATCH_STATES.EXPIRED; this._stats.expired++; }
          else if (now - submittedTime > this._pendingTTLDays * MS_PER_DAY) {
            p.state = PATCH_STATES.EXPIRED;
            this._stats.expired++;
          }
        }
        if (p.state === PATCH_STATES.APPROVED) {
          const approvedTime = safeDateGetTime(p.approvedAt);
          if (!Number.isFinite(approvedTime)) { p.state = PATCH_STATES.EXPIRED; this._stats.expired++; }
          else if (now - approvedTime > this._approvedTTLDays * MS_PER_DAY) {
            p.state = PATCH_STATES.EXPIRED;
            this._stats.expired++;
          }
        }
        this._patches.set(p.patchId, p);
      }
    } catch (err) {
      debug('SkillPatchApproval', '_restore', err);
      this._stats.errors++;
    }
  }

  async _restoreAsync() {
    return this._restoreWith(() => JsonStoreRestorer.loadAsync(this._root, PERSIST_DIR_NAME + '/patches.json', {
      maxSize: MAX_JSON_FILE_SIZE,
      expectedType: 'object',
      logLabel: 'SkillPatchApproval',
    }));
  }

  /**
   * 延迟绑定项目根目录并初始化持久化。
   * @param {string} projectRoot - 项目根目录路径
   * @returns {SkillPatchApproval} 当前实例（支持链式调用）
   */
  attachProjectRoot(projectRoot) {
    if (this._root) return this;
    if (!projectRoot || typeof projectRoot !== 'string') return this;
    this._root = projectRoot;
    this._initPersistence();
    return this;
  }

  /**
   * 提交技能补丁。
   * @param {string} skillId - 技能ID
   * @param {object} patchData - 补丁数据
   * @param {string[]} [patchData.tips] - 提示列表
   * @param {string[]} [patchData.avoidances] - 规避列表
   * @param {number} [patchData.count] - 学习次数
   * @param {string} [patchData.submittedBy='system'] - 提交人
   * @returns {{success: boolean, patchId?: string, state?: string, error?: string}} 提交结果
   * @emits SkillPatchApproval#patch-submitted
   */
  submit(skillId, patchData) {
    this.guardShutdown();
    if (!this.isHealthy()) {
      return { success: false, error: 'SkillPatchApproval is shut down' };
    }
    if (!skillId || typeof skillId !== 'string') {
      return { success: false, error: 'skillId is required and must be a string' };
    }
    if (!patchData || typeof patchData !== 'object') {
      return { success: false, error: 'patchData is required and must be an object' };
    }
    const tips = Array.isArray(patchData.tips)
      ? patchData.tips.slice(0, MAX_TIPS_PER_PATCH).map(function(t) { return String(t).substring(0, MAX_TIP_LENGTH); })
      : [];
    const avoidances = Array.isArray(patchData.avoidances)
      ? patchData.avoidances.slice(0, MAX_AVOIDANCES_PER_PATCH).map(function(a) { return String(a).substring(0, MAX_TIP_LENGTH); })
      : [];
    if (tips.length === 0 && avoidances.length === 0) {
      return { success: false, error: 'At least one tip or avoidance is required' };
    }
    const patchId = timestampId('patch-');
    const patch = {
      patchId: patchId,
      skillId: skillId,
      state: PATCH_STATES.PENDING,
      tips: tips,
      avoidances: avoidances,
      learningCount: Math.max(0, Number.isFinite(Number(patchData.count)) ? Number(patchData.count) : 0),
      submittedAt: new Date().toISOString(),
      submittedBy: patchData.submittedBy || 'system',
      approvedAt: null,
      approvedBy: null,
      appliedAt: null,
      revokedAt: null,
      rejectionReason: null,
    };
    if (this._patches.size >= MAX_PATCHES) {
      this._evictOldest();
    }
    this._patches.set(patchId, patch);
    this._stats.submitted++;
    this._schedulePersist();
    this.emit('patch-submitted', { patchId: patchId, skillId: skillId });
    return { success: true, patchId: patchId, state: patch.state };
  }

  _validateTransition(patch, newState) {
    const allowed = VALID_TRANSITIONS[patch.state];
    if (!allowed || !allowed.includes(newState)) {
      return false;
    }
    return true;
  }

  /**
   * 批准补丁。
   * @param {string} patchId - 补丁ID
   * @param {string} [reviewer] - 审批人
   * @returns {{success: boolean, patchId?: string, state?: string, error?: string}} 审批结果
   * @emits SkillPatchApproval#patch-approved
   */
  approve(patchId, reviewer) {
    this.guardShutdown();
    if (!this.isHealthy()) {
      return { success: false, error: 'SkillPatchApproval is shut down' };
    }
    const patch = this._patches.get(patchId);
    if (!patch) return { success: false, error: 'Patch not found' };
    if (!this._validateTransition(patch, PATCH_STATES.APPROVED)) {
      return { success: false, error: 'Invalid transition: ' + patch.state + ' -> ' + PATCH_STATES.APPROVED };
    }
    patch.state = PATCH_STATES.APPROVED;
    patch.approvedAt = new Date().toISOString();
    patch.approvedBy = reviewer ?? 'unknown';
    this._stats.approved++;
    this._schedulePersist();
    this.emit('patch-approved', { patchId: patchId, skillId: patch.skillId, approvedBy: reviewer });
    return { success: true, patchId: patchId, state: patch.state };
  }

  /**
   * 拒绝补丁。
   * @param {string} patchId - 补丁ID
   * @param {string} [reviewer] - 审批人
   * @param {string} [reason] - 拒绝原因
   * @returns {{success: boolean, patchId?: string, state?: string, error?: string}} 拒绝结果
   * @emits SkillPatchApproval#patch-rejected
   */
  reject(patchId, reviewer, reason) {
    this.guardShutdown();
    if (!this.isHealthy()) {
      return { success: false, error: 'SkillPatchApproval is shut down' };
    }
    const patch = this._patches.get(patchId);
    if (!patch) return { success: false, error: 'Patch not found' };
    if (!this._validateTransition(patch, PATCH_STATES.REJECTED)) {
      return { success: false, error: 'Invalid transition: ' + patch.state + ' -> ' + PATCH_STATES.REJECTED };
    }
    patch.state = PATCH_STATES.REJECTED;
    patch.rejectionReason = reason || '';
    this._stats.rejected++;
    this._schedulePersist();
    this.emit('patch-rejected', { patchId: patchId, skillId: patch.skillId, reason: reason });
    return { success: true, patchId: patchId, state: patch.state };
  }

  /**
   * 标记补丁为已应用。
   * @param {string} patchId - 补丁ID
   * @returns {{success: boolean, patchId?: string, state?: string, error?: string}} 操作结果
   * @emits SkillPatchApproval#patch-applied
   */
  markApplied(patchId) {
    this.guardShutdown();
    if (!this.isHealthy()) {
      return { success: false, error: 'SkillPatchApproval is shut down' };
    }
    const patch = this._patches.get(patchId);
    if (!patch) return { success: false, error: 'Patch not found' };
    if (!this._validateTransition(patch, PATCH_STATES.APPLIED)) {
      return { success: false, error: 'Invalid transition: ' + patch.state + ' -> ' + PATCH_STATES.APPLIED };
    }
    patch.state = PATCH_STATES.APPLIED;
    patch.appliedAt = new Date().toISOString();
    this._stats.applied++;
    this._schedulePersist();
    this.emit('patch-applied', { patchId: patchId, skillId: patch.skillId });
    return { success: true, patchId: patchId, state: patch.state };
  }

  /**
   * 撤销已应用的补丁。
   * @param {string} patchId - 补丁ID
   * @param {string} [revoker] - 撤销人
   * @param {string} [reason] - 撤销原因
   * @returns {{success: boolean, patchId?: string, state?: string, error?: string}} 撤销结果
   * @emits SkillPatchApproval#patch-revoked
   */
  revoke(patchId, revoker, reason) {
    this.guardShutdown();
    if (!this.isHealthy()) {
      return { success: false, error: 'SkillPatchApproval is shut down' };
    }
    const patch = this._patches.get(patchId);
    if (!patch) return { success: false, error: 'Patch not found' };
    if (!this._validateTransition(patch, PATCH_STATES.REVOKED)) {
      return { success: false, error: 'Invalid transition: ' + patch.state + ' -> ' + PATCH_STATES.REVOKED };
    }
    patch.state = PATCH_STATES.REVOKED;
    patch.revokedAt = new Date().toISOString();
    patch.revocationReason = reason || '';
    this._stats.revoked++;
    this._schedulePersist();
    this.emit('patch-revoked', { patchId: patchId, skillId: patch.skillId, reason: reason });
    return { success: true, patchId: patchId, state: patch.state };
  }

  /**
   * 检查补丁是否已批准且未过期。
   * @param {string} patchId - 补丁ID
   * @returns {boolean} 是否为有效已批准状态
   */
  isApproved(patchId) {
    this.guardShutdown();
    const patch = this._patches.get(patchId);
    if (!patch) return false;
    if (patch.state === PATCH_STATES.APPROVED) {
      if (!patch.approvedAt) return false;
      const approvedTime = safeDateGetTime(patch.approvedAt);
      if (!Number.isFinite(approvedTime)) return false;
      const age = Date.now() - approvedTime;
      if (age > this._approvedTTLDays * MS_PER_DAY) {
        this._expirePatch(patch);
        return false;
      }
      return true;
    }
    return false;
  }

  _expirePatch(patch) {
    if (!this._validateTransition(patch, PATCH_STATES.EXPIRED)) {
      return false;
    }
    patch.state = PATCH_STATES.EXPIRED;
    this._stats.expired++;
    this._schedulePersist();
    return true;
  }

  /**
   * 获取指定技能的已批准补丁。
   * @param {string} skillId - 技能ID
   * @returns {object|null} 已批准的补丁记录，未找到时返回null
   */
  getApprovedPatchForSkill(skillId) {
    this.guardShutdown();
    for (const [, patch] of this._patches) {
      if (patch.skillId === skillId && patch.state === PATCH_STATES.APPROVED) {
        if (!patch.approvedAt) continue;
        const approvedTime = safeDateGetTime(patch.approvedAt);
        if (!Number.isFinite(approvedTime)) continue;
        const age = Date.now() - approvedTime;
        if (age > this._approvedTTLDays * MS_PER_DAY) {
          this._expirePatch(patch);
          continue;
        }
        return patch;
      }
    }
    return null;
  }

  /**
   * 获取所有待审批补丁列表。
   * @returns {Array<object>} 按提交时间排序的待审批补丁列表
   */
  getPendingPatches() {
    const results = [];
    for (const [, patch] of this._patches) {
      if (patch.state === PATCH_STATES.PENDING) {
        results.push(patch);
      }
    }
    return results.sort(function(a, b) { return a.submittedAt.localeCompare(b.submittedAt, 'en'); });
  }

  /**
   * 获取指定补丁记录。
   * @param {string} patchId - 补丁ID
   * @returns {object|null} 补丁记录，未找到时返回null
   */
  getPatch(patchId) {
    if (!patchId) return null;
    return this._patches.get(patchId) ?? null;
  }

  /**
   * 按技能ID获取补丁列表。
   * @param {string} skillId - 技能ID
   * @returns {Array<object>} 匹配的补丁列表
   */
  getPatchesBySkill(skillId) {
    if (!skillId) return [];
    const results = [];
    for (const [, patch] of this._patches) {
      if (patch.skillId === skillId) {
        results.push(patch);
      }
    }
    return results;
  }

  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, patch] of this._patches) {
      if (EVICTABLE_STATES.has(patch.state)) {
        const t = safeDateGetTime(patch.submittedAt);
        if (!Number.isFinite(t) || t < oldestTime) {
          oldestTime = Number.isFinite(t) ? t : -Infinity;
          oldestKey = key;
        }
      }
    }
    if (oldestKey) {
      this._patches.delete(oldestKey);
      return;
    }
    let oldestPending = null;
    let oldestPendingTime = Infinity;
    for (const [key, patch] of this._patches) {
      if (patch.state === PATCH_STATES.PENDING) {
        const t = safeDateGetTime(patch.submittedAt);
        if (Number.isFinite(t) && t < oldestPendingTime) {
          oldestPendingTime = t;
          oldestPending = key;
        }
      }
    }
    if (oldestPending) {
      this._patches.delete(oldestPending);
    }
  }

  _schedulePersist() {
    if (this._persister) {
      this._persister.schedule();
    }
  }

  /**
   * 立即持久化补丁数据到磁盘。
   */
  flush() {
    if (this._persister) {
      this._persister.persistNow();
    }
  }

  /**
   * 获取补丁管理器统计信息。
   * @returns {{totalPatches: number, byState: object, submitted: number, approved: number, rejected: number, applied: number, revoked: number, expired: number, errors: number, persistenceEnabled: boolean}} 统计信息
   */
  getStats() {
    const byState = {};
    for (const state of Object.values(PATCH_STATES)) {
      byState[state] = 0;
    }
    for (const [, patch] of this._patches) {
      byState[patch.state] = (byState[patch.state] ?? 0) + 1;
    }
    return {
      totalPatches: this._patches.size,
      byState: byState,
      submitted: this._stats.submitted,
      approved: this._stats.approved,
      rejected: this._stats.rejected,
      applied: this._stats.applied,
      revoked: this._stats.revoked,
      expired: this._stats.expired,
      errors: this._stats.errors,
      persistenceEnabled: !!this._persister,
    };
  }

  /**
   * 检查管理器是否健康（未关闭且错误数小于100）。
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    return !this._shutDown && this._stats.errors < 100;
  }

  _onShutdown() {
    if (this._persister) {
      this._persister.flush();
      this._persister = null;
    }
    this._patches.clear();
    this.removeAllListeners();
  }
}

SkillPatchApproval.PATCH_STATES = PATCH_STATES;
SkillPatchApproval.VALID_TRANSITIONS = VALID_TRANSITIONS;

module.exports = withShutdown(SkillPatchApproval);
