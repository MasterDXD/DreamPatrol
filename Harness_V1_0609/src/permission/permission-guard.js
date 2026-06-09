'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { validateProjectRoot, isNonEmptyString, SESSION_ID_PATTERN, MAX_JSON_FILE_SIZE, DEFAULT_LOCK_TIMEOUT_MS, MAX_LOCKS, HEALTH_MAX_LOCKS, HEALTH_MAX_CONFIRMATIONS, MS_PER_DAY, DEFAULT_MIN_HEARTBEAT_MS , HARNESS_DIR, CONFIG_FILENAME, DANGEROUS_SHELL_PATTERNS } = require('../utils/constants');
const { sanitizeProto, sanitizeObject } = require('../utils/sanitizer');
const { debug } = require('../utils/debug-logger');
const { emitError } = require('../utils/safe-execute');
const { PermissionError } = require('../errors');
const { writeAtomic, writeAtomicAsync } = require('../utils/debounced-persister');
const { withShutdown } = require('../utils/shutdown-mixin');
const { ensureDirAsync, ensureDirSync } = require('../utils/fs-utils');
const JsonStoreRestorer = require('../utils/json-store-restorer');

/** @constant {Set<string>} 系统文件集合（只读） */
const SYSTEM_FILES = new Set([
  CONFIG_FILENAME,
  'agents',
  'skills',
  'rules',
  'workspace',
]);

/** @constant {Set<string>} 允许修改的目录集合 */
const ALLOWED_MUTABLE_DIRS = new Set([
  'sessions',
  'checkpoints',
]);

/** @constant {number} 最大确认记录数 */
const MAX_CONFIRMATIONS = 5000;
/** @constant {number} 最大确认过期时间（毫秒） */
const MAX_CONFIRMATION_EXPIRY_MS = MS_PER_DAY;
/** @constant {number} 最大锁续期次数 */
const MAX_LOCK_RENEWALS = 10;
/** @constant {number} 持久化轮询间隔（毫秒） */
const PERSIST_POLL_MS = DEFAULT_MIN_HEARTBEAT_MS;

/**
 * 文件操作权限守卫。阻止项目外文件操作，保护.harness系统文件，
 * 实现文件级锁防止并发冲突，检测危险命令，防护路径遍历攻击。
 *
 * @example
 * const guard = new PermissionGuard('/path/to/project');
 * const result = guard.checkFileWrite('/path/to/project/src/main.py', 'task-worker');
 * if (!result.allowed) { throw new Error(result.reason); }
 */
/** @constant {number} 默认确认过期时间（毫秒） */
const DEFAULT_CONFIRMATION_EXPIRY_MS = 5 * 60 * 1000;

/**
 * @module permission/permission-guard
 * 文件操作权限守卫。路径遍历防护，文件级锁，危险命令检测，确认过期机制，
 * 阻止项目外文件操作和保护.harness系统文件。
 */

/**
 * 命令检查结果对象
 * @typedef {{ allowed: boolean, reason: string, requiresConfirmation: boolean }} PermissionResult
 */

/**
 * @classdesc 文件操作权限守卫。路径遍历防护、文件级锁、危险命令检测
 */
class PermissionGuard extends EventEmitter {
  /**
   * 创建PermissionGuard实例。
   * @param {string} projectRoot - 项目根目录路径
   */
  constructor(projectRoot) {
    super();
    validateProjectRoot(projectRoot, 'PermissionGuard');
    /** @private */
    this.root = path.resolve(projectRoot);
    try { this.root = fs.realpathSync(this.root); } catch (e) { debug('PermissionGuard', 'realpathSync failed, using resolved path: %s', e && e.message ? e.message : String(e)); }
    this._permissionDir = path.join(this.root, HARNESS_DIR, 'permission');
    /** @type {Object<string, {agent: string, acquiredAt: number}>} */
    this.locks = {};
    /** @type {Object<string, {confirmedAt: number, agentId: string, action: string, target: string}>} */
    this.confirmations = {};
    this._confirmationExpiryMs = DEFAULT_CONFIRMATION_EXPIRY_MS;
    this._persistTimer = null;
    this._dirty = false;
    this._persistRetryCount = 0;
    this._maxPersistRetries = 5;
    this._restore();
  }

  /**
   * 设置确认过期时间。
   * @param {number} ms - 过期时间（毫秒），不超过MAX_CONFIRMATION_EXPIRY_MS
   * @returns {PermissionGuard} 当前实例（支持链式调用）
   */
  setConfirmationExpiry(ms) {
    if (typeof ms === 'number' && ms > 0 && ms <= MAX_CONFIRMATION_EXPIRY_MS) {
      this._confirmationExpiryMs = ms;
    }
    return this;
  }

  /**
   * 记录操作确认。超过最大确认数时自动清理过期和最旧记录。
   * @param {string} agentId - Agent ID
   * @param {string} action - 操作类型
   * @param {string} target - 操作目标
   * @returns {boolean} 记录成功返回true，参数无效返回false
   * @emits PermissionGuard#confirmation-recorded
   */
  recordConfirmation(agentId, action, target) {
    this.guardShutdown();
    if (!isNonEmptyString(agentId)) return false;
    if (!isNonEmptyString(action)) return false;
    if (!isNonEmptyString(target)) return false;
    const keys = Object.keys(this.confirmations);
    if (keys.length > MAX_CONFIRMATIONS) {
      const now = Date.now();
      const expired = [];
      for (const k of keys) {
        if (now - this.confirmations[k].confirmedAt > this._confirmationExpiryMs) {
          expired.push(k);
        }
      }
      expired.forEach(k => { delete this.confirmations[k]; });
      if (Object.keys(this.confirmations).length > MAX_CONFIRMATIONS) {
        keys.sort(function(a, b) {
          const aEntry = this.confirmations[a];
          const bEntry = this.confirmations[b];
          if (!aEntry || !bEntry) return 0;
          return (aEntry.confirmedAt ?? 0) - (bEntry.confirmedAt ?? 0);
        }.bind(this));
        const toDelete = keys.slice(0, keys.length - MAX_CONFIRMATIONS + 1);
        for (const k of toDelete) {
          delete this.confirmations[k];
        }
      }
    }
    const safeAgentId = String(agentId).replace(/\0/g, '');
    const safeAction = String(action).replace(/\0/g, '');
    const safeTarget = String(target).replace(/\0/g, '');
    const key = safeAgentId + '\0' + safeAction + '\0' + safeTarget;
    this.confirmations[key] = {
      confirmedAt: Date.now(),
      agentId: safeAgentId,
      action: safeAction,
      target: safeTarget,
    };
    this.emit('confirmation-recorded', { agentId, action, target, confirmedAt: this.confirmations[key].confirmedAt });
    this._markDirty();
    return true;
  }

  /**
   * 检查操作确认是否有效（未过期）。
   * @param {string} agentId - Agent ID
   * @param {string} action - 操作类型
   * @param {string} target - 操作目标
   * @returns {boolean} 确认有效返回true
   */
  isConfirmationValid(agentId, action, target) {
    if (!isNonEmptyString(agentId)) return false;
    if (!isNonEmptyString(action)) return false;
    if (!isNonEmptyString(target)) return false;
    const safeAgentId = String(agentId).replace(/\0/g, '');
    const safeAction = String(action).replace(/\0/g, '');
    const safeTarget = String(target).replace(/\0/g, '');
    const key = safeAgentId + '\0' + safeAction + '\0' + safeTarget;
    const entry = this.confirmations[key];
    if (!entry) return false;
    if (Date.now() - entry.confirmedAt > this._confirmationExpiryMs) {
      delete this.confirmations[key];
      return false;
    }
    return true;
  }

  /**
   * 检查路径是否在项目根目录内（防路径遍历）。
   * @private
   * @param {string} resolved - 已解析的绝对路径
   * @returns {boolean}
   */
  _isWithinProject(resolved) {
    if (typeof resolved !== 'string' || resolved.indexOf('\0') !== -1) return false;
    const normalizedRoot = this.root.replace(/\\/g, '/').toLowerCase();
    const normalizedPath = resolved.replace(/\\/g, '/').toLowerCase();
    if (!normalizedPath.startsWith(normalizedRoot)) return false;
    if (process.platform !== 'win32' && this.root !== this.root.toLowerCase()) {
      if (normalizedPath.startsWith(normalizedRoot) && !resolved.replace(/\\/g, '/').startsWith(this.root.replace(/\\/g, '/'))) return false;
    }

    try {
      const realPath = fs.realpathSync(resolved).replace(/\\/g, '/').toLowerCase();
      if (!realPath.startsWith(normalizedRoot)) return false;
    } catch (err) {
      const errCode = err && err.code;
      if (errCode === 'ENOENT' || errCode === 'ENOTDIR') {
        try {
          const parentDir = path.dirname(resolved);
          const realParent = fs.realpathSync(parentDir).replace(/\\/g, '/').toLowerCase();
          if (!realParent.startsWith(normalizedRoot)) return false;
          const verifiedPath = path.join(realParent, path.basename(resolved));
          const relative = path.relative(this.root, verifiedPath);
          if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
          return true;
        } catch (parentErr) {
          debug('PermissionGuard', '_isWithinProject:realpath', parentErr);
          return false;
        }
      } else if (errCode === 'EACCES') {
        debug('PermissionGuard', '_isWithinProject', 'Permission denied for path: ' + resolved);
        return false;
      } else {
        debug('PermissionGuard', '_isWithinProject', err);
        return false;
      }
    }

    const relative = path.relative(this.root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;

    return true;
  }

  /**
   * 检查路径是否为系统文件（.harness下的只读目录）。
   * @param {string} resolved - 已解析的绝对路径
   * @returns {boolean} 是系统文件返回true
   * @private
   */
  _isSystemFile(resolved) {
    const relative = path.relative(this.root, resolved);
    const parts = relative.split(path.sep);
    if (parts[0] === HARNESS_DIR && parts.length >= 2) {
      if (SYSTEM_FILES.has(parts[1]) && !ALLOWED_MUTABLE_DIRS.has(parts[1])) {
        return true;
      }
    }
    return false;
  }

  /**
   * 验证路径合法性（非空字符串、在项目根目录内）。
   * @param {string} filePath - 待验证的文件路径
   * @returns {Object} 验证结果，包含valid、reason、resolved、withinProject
   * @private
   */
  _validatePath(filePath) {
    if (!isNonEmptyString(filePath)) {
      return { valid: false, reason: 'Invalid filePath: must be a non-empty string', resolved: null, withinProject: false };
    }
    const resolved = path.resolve(filePath);
    const withinProject = this._isWithinProject(resolved);
    if (!withinProject) {
      return { valid: false, reason: 'File path is outside project root', resolved, withinProject: false };
    }
    return { valid: true, reason: null, resolved, withinProject: true };
  }

  /**
   * 检查文件写入权限。验证路径合法性、系统文件保护、文件锁冲突。
   * @param {string} filePath - 目标文件路径
   * @param {string} agentId - 请求写入的Agent ID
   * @returns {{ allowed: boolean, reason?: string }} 权限检查结果
   */
  checkFileWrite(filePath, agentId) {
    this.guardShutdown();
    const pathCheck = this._validatePath(filePath);
    if (!pathCheck.valid) return { allowed: false, reason: pathCheck.reason };
    const { resolved } = pathCheck;

    if (!isNonEmptyString(agentId)) {
      return { allowed: false, reason: 'Invalid agentId: must be a non-empty string' };
    }

    const relative = path.relative(this.root, resolved);
    const parts = relative.split(path.sep);

    if (parts[0] === HARNESS_DIR && parts.length >= 2) {
      if (SYSTEM_FILES.has(parts[1]) && !ALLOWED_MUTABLE_DIRS.has(parts[1])) {
        return { allowed: false, reason: 'System file is read-only for agents' };
      }
    }

    const lockInfo = this.locks[resolved];
    if (lockInfo && lockInfo.agent !== agentId) {
      if (Date.now() - lockInfo.acquiredAt > DEFAULT_LOCK_TIMEOUT_MS) {
        delete this.locks[resolved];
      } else {
        return { allowed: false, reason: 'File is currently locked by another agent' };
      }
    }

    return { allowed: true };
  }

  /**
   * 检查文件删除权限。系统文件禁止删除，其他文件需要确认。
   * @param {string} filePath - 目标文件路径
   * @param {string} [_agentId] - 请求删除的Agent ID（用于确认验证）
   * @returns {{ allowed: boolean, reason?: string, requiresConfirmation?: boolean }} 权限检查结果
   */
  checkFileDelete(filePath, _agentId) {
    this.guardShutdown();
    const pathCheck = this._validatePath(filePath);
    if (!pathCheck.valid) return { allowed: false, reason: pathCheck.reason };
    const { resolved } = pathCheck;

    if (this._isSystemFile(resolved)) {
      return { allowed: false, reason: 'Cannot delete .harness system files' };
    }

    const alreadyConfirmed = _agentId && this.isConfirmationValid(_agentId, 'file_delete', resolved);
    if (alreadyConfirmed) {
      return { allowed: true, requiresConfirmation: false, reason: 'Previously confirmed (within expiry window)' };
    }

    return { allowed: true, requiresConfirmation: true };
  }

  /**
   * 检查文件读取权限。.harness/data目录需要Agent ID。
   * @param {string} filePath - 目标文件路径
   * @param {string} [agentId] - 请求读取的Agent ID
   * @returns {{ allowed: boolean, reason?: string }} 权限检查结果
   */
  checkFileRead(filePath, agentId) {
    this.guardShutdown();
    const pathCheck = this._validatePath(filePath);
    if (!pathCheck.valid) return { allowed: false, reason: pathCheck.reason };
    const relative = path.relative(this.root, pathCheck.resolved);
    const parts = relative.split(path.sep);
    if (parts[0] === HARNESS_DIR && parts[1] === 'data') {
      if (!agentId) return { allowed: false, reason: 'Agent ID required for data access' };
    }
    return { allowed: true };
  }

  /**
   * 获取文件锁。若文件已被其他Agent锁定则失败，同一Agent可重入。
   * @param {string} filePath - 目标文件路径
   * @param {string} agentId - 请求锁的Agent ID
   * @returns {boolean} 是否成功获取锁
   */
  acquireLock(filePath, agentId) {
    this.guardShutdown();
    if (!isNonEmptyString(agentId)) return false;
    if (!isNonEmptyString(filePath)) return false;
    const resolved = path.resolve(filePath);
    const lockKeys = Object.keys(this.locks);
    if (lockKeys.length >= MAX_LOCKS && !this.locks[resolved]) {
      this._evictExpiredLocks();
      if (Object.keys(this.locks).length >= MAX_LOCKS) {
        return false;
      }
    }
    const current = this.locks[resolved];
    if (current && current.agent !== agentId) {
      if (Date.now() - current.acquiredAt <= DEFAULT_LOCK_TIMEOUT_MS) {
        return false;
      }
    }
    if (current && current.agent === agentId && current.renewals >= MAX_LOCK_RENEWALS) {
      return false;
    }
    this.locks[resolved] = {
      agent: agentId,
      acquiredAt: Date.now(),
      renewals: current && current.agent === agentId ? (current.renewals ?? 0) + 1 : 0,
    };
    return true;
  }

  _evictExpiredLocks() {
    const now = Date.now();
    for (const k of Object.keys(this.locks)) {
      if (now - this.locks[k].acquiredAt > DEFAULT_LOCK_TIMEOUT_MS) {
        delete this.locks[k];
      }
    }
  }

  /**
   * 释放文件锁。仅锁持有者可释放。
   * @param {string} filePath - 目标文件路径
   * @param {string} agentId - 请求释放锁的Agent ID
   * @returns {boolean} 释放成功返回true
   */
  releaseLock(filePath, agentId) {
    this.guardShutdown();
    if (!isNonEmptyString(agentId)) return false;
    if (!isNonEmptyString(filePath)) return false;
    const resolved = path.resolve(filePath);
    const current = this.locks[resolved];
    if (current && current.agent === agentId) {
      delete this.locks[resolved];
      return true;
    }
    return false;
  }

  /**
   * 获取文件锁持有者。锁超时时自动释放并返回null。
   * @param {string} filePath - 目标文件路径
   * @returns {string|null} 锁持有者Agent ID，无锁或锁超时返回null
   */
  getLockHolder(filePath) {
    if (!isNonEmptyString(filePath)) return null;
    const resolved = path.resolve(filePath);
    const current = this.locks[resolved];
    if (!current) return null;
    if (Date.now() - current.acquiredAt > DEFAULT_LOCK_TIMEOUT_MS) {
      delete this.locks[resolved];
      return null;
    }
    return current.agent;
  }

  /**
   * 检查命令是否安全（检测危险命令模式）。
   * @param {string} command - 要执行的命令
   * @param {string} _agentId - 请求执行的Agent ID（保留参数）
   * @returns {PermissionResult}
   */
  checkCommand(command, _agentId) {
    this.guardShutdown();
    if (typeof command !== 'string' || command.trim().length === 0) {
      return { allowed: false, reason: 'Empty or invalid command', requiresConfirmation: false };
    }

    const SAFE_CMD_RE = /^(?:ls|pwd|echo|cat|head|tail|wc|git\s+status|git\s+log|git\s+diff|git\s+branch)\b/;
    const SHELL_META_RE = /[;|&`$]|(?:\$\(|\$\{)/;
    const trimmed = command.trim();
    if (SAFE_CMD_RE.test(trimmed) && !SHELL_META_RE.test(trimmed)) {
      return { allowed: true, requiresConfirmation: false };
    }

    for (const pattern of DANGEROUS_SHELL_PATTERNS) {
      if (pattern.test(command)) {
        return { allowed: false, reason: 'Dangerous command pattern detected', requiresConfirmation: false };
      }
    }

    return { allowed: true, requiresConfirmation: true };
  }

  /**
   * 验证Session ID格式合法性（防路径注入）。
   * 仅允许[a-zA-Z0-9_-]，最长64字符。
   * @param {string} sessionId - 待验证的Session ID
   * @returns {boolean} 是否合法
   */
  static validateSessionId(sessionId) {
    return SESSION_ID_PATTERN.test(sessionId);
  }

  /**
   * 强制执行文件写入权限检查。若不允许则抛出PermissionError。
   * @param {string} filePath - 目标文件路径
   * @param {string} agentId - 请求写入的Agent ID
   * @throws {PermissionError} 无权限时抛出
   * @returns {true} 有权限时返回true
   */
  enforceFileWrite(filePath, agentId) {
    this.guardShutdown();
    const result = this.checkFileWrite(filePath, agentId);
    if (!result.allowed) {
      const reason = result.reason ?? 'Permission denied';
      const code = reason.includes('outside project')
        ? 'FILE_OUTSIDE_PROJECT'
        : reason.includes('read-only')
          ? 'SYSTEM_FILE_READONLY'
          : 'LOCK_CONFLICT';
      throw new PermissionError(code, reason);
    }
    return true;
  }

  /**
   * 强制执行命令安全检查。若检测到危险命令则抛出PermissionError。
   * @param {string} command - 要执行的命令
   * @param {string} agentId - 请求执行的Agent ID
   * @throws {PermissionError} 检测到危险命令时抛出
   * @returns {true} 命令安全时返回true
   */
  enforceCommand(command, agentId) {
    this.guardShutdown();
    const result = this.checkCommand(command, agentId);
    if (!result.allowed) {
      throw new PermissionError('DANGEROUS_COMMAND', result.reason);
    }
    return true;
  }

  _onShutdown() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    try {
      try { this._persistNow(); } catch (_e) { debug('PermissionGuard', '_onShutdown:persistNow', _e && _e.message ? _e.message : String(_e)); }
      this.locks = {};
      this.confirmations = {};
      this._confirmationExpiryMs = DEFAULT_CONFIRMATION_EXPIRY_MS;
      this.removeAllListeners();
    } finally {
      this._dirty = false;
    }
  }

  _markDirty() {
    if (!this.isHealthy()) return;
    this._dirty = true;
    if (!this._persistTimer) {
      const self = this;
      function scheduleNext() {
        self._persistTimer = setTimeout(function() {
          if (self._shutDown) { self._persistTimer = null; return; }
          if (self._dirty) {
            self._persistNowAsync().catch(function(e) { debug('PermissionGuard', 'persistTimer', e); }).then(function() { if (!self._shutDown) scheduleNext(); }).catch(function(e) { debug('PermissionGuard', 'scheduleNext', e); });
          } else {
            self._persistTimer = null;
          }
        }, PERSIST_POLL_MS);
        if (self._persistTimer && typeof self._persistTimer.unref === 'function') { self._persistTimer.unref(); }
      }
      scheduleNext();
    }
  }

  _persistNow() {
    try {
      const dir = this._permissionDir;
      ensureDirSync(dir);
      const data = { locks: this.locks, confirmations: this.confirmations, savedAt: Date.now() };
      const finalPath = path.join(dir, 'guard-state.json');
      writeAtomic(finalPath, data);
      this._dirty = false;
    } catch (e) {
      debug('PermissionGuard', '_persistNow', e);
      emitError(this, 'persist-error', e);
    }
  }

  async _persistNowAsync() {
    try {
      const dir = this._permissionDir;
      await ensureDirAsync(dir);
      const data = { locks: this.locks, confirmations: this.confirmations, savedAt: Date.now() };
      const finalPath = path.join(dir, 'guard-state.json');
      await writeAtomicAsync(finalPath, data);
      this._dirty = false;
      this._persistRetryCount = 0;
    } catch (e) {
      this._persistRetryCount = (typeof this._persistRetryCount === 'number' && Number.isFinite(this._persistRetryCount) ? this._persistRetryCount : 0) + 1;
      if (this._persistRetryCount >= this._maxPersistRetries) {
        this._dirty = false;
        this._persistRetryCount = 0;
        debug('PermissionGuard', '_persistNowAsync', 'Max persist retries reached, giving up');
      } else {
        this._dirty = true;
      }
      debug('PermissionGuard', '_persistNowAsync', e);
      emitError(this, 'persist-error', e);
    }
  }

  _restore() {
    try {
      const result = JsonStoreRestorer.loadSync(this.root, 'permission/guard-state.json', {
        maxSize: MAX_JSON_FILE_SIZE,
        expectedType: 'object',
        logLabel: 'PermissionGuard',
        sanitize: null,
      });
      if (!result) return;
      const safeData = this._createSafeObject(result.data);
      if (safeData.locks && typeof safeData.locks === 'object') this._sanitizeProto(safeData.locks);
      if (safeData.confirmations && typeof safeData.confirmations === 'object') this._sanitizeProto(safeData.confirmations);
      this._restoreLocks(safeData);
      this._restoreConfirmations(safeData);
    } catch (e) {
      debug('PermissionGuard', '_restore', e);
      emitError(this, 'restore-error', e);
    }
  }

  _sanitizeProto(obj, depth) {
    return sanitizeProto(obj, depth);
  }

  _createSafeObject(obj, depth) {
    return sanitizeObject(obj, depth);
  }

  _restoreLocks(data) {
    if (!data.locks || typeof data.locks !== 'object') return;
    const now = Date.now();
    for (const [k, v] of Object.entries(data.locks)) {
      if (v && v.agent && typeof v.acquiredAt === 'number' && now - v.acquiredAt < DEFAULT_LOCK_TIMEOUT_MS) {
        this.locks[k] = v;
      }
    }
  }

  _restoreConfirmations(data) {
    if (!data.confirmations || typeof data.confirmations !== 'object') return;
    const now = Date.now();
    for (const [k, v] of Object.entries(data.confirmations)) {
      if (v && v.agentId && typeof v.confirmedAt === 'number' && now - v.confirmedAt < this._confirmationExpiryMs) {
        this.confirmations[k] = v;
      }
    }
  }

  /**
   * 检查PermissionGuard健康状态（锁数量和确认数量是否在安全阈值内）。
   * @returns {boolean} 健康返回true
   */
  isHealthy() { return !this._shutDown && Object.keys(this.locks).length < HEALTH_MAX_LOCKS && Object.keys(this.confirmations).length < HEALTH_MAX_CONFIRMATIONS; }
}

PermissionGuard.SESSION_ID_PATTERN = SESSION_ID_PATTERN;

module.exports = withShutdown(PermissionGuard);
