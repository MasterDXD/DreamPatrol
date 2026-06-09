'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { generateId, validateProjectRoot, isNonEmptyString, HARNESS_DIR, JSON_EXT } = require('../../utils/constants');
const { writeAtomic, writeAtomicAsync } = require('../../utils/debounced-persister');
const { debug } = require('../../utils/debug-logger');
const { ensureDirSync, ensureDirAsync, readJsonDirSync, readJsonDirAsync } = require('../../utils/fs-utils');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { mergeConfig } = require('../../utils/safe-assign');
const { safeDateGetTime } = require('../../utils/safe-execute');

const MAX_CHECKPOINTS = 50;
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * @module runtime/session/checkpoint-manager
 * CheckpointManager — Session checkpoint persistence with causal WAL rollback coordination
 * Creates, restores, and deletes session checkpoints with monotonic timestamp enforcement,
 * tracks causal WAL sequence numbers for coordinated rollback via CausalDataBus,
 * and persists to .harness/checkpoints/ with both sync and async I/O modes.
 * @classdesc 检查点管理器。定期快照、恢复点创建、增量保存
 */
class CheckpointManager extends EventEmitter {
  constructor(projectRoot) {
    super();
    validateProjectRoot(projectRoot, 'CheckpointManager');
    this.root = projectRoot;
    this._checkpointsDir = path.join(projectRoot, HARNESS_DIR, 'checkpoints');
    this._checkpoints = new Map();
    this._lastTimestamp = 0;
    this._createLock = false;
    this._restore();
  }

  /**
   * 同步创建检查点，保存会话当前状态快照
   * @param {string} sessionId - 会话ID，需匹配SAFE_ID_RE且不超过128字符
   * @param {Object} data - 检查点数据
   * @param {string} [data.phase] - 当前阶段
   * @param {string[]} [data.completedSkills] - 已完成技能列表
   * @param {number} [data.tokensUsed] - 已使用Token数
   * @param {Array} [data.agentHistory] - Agent操作历史
   * @param {number} [data.causalWalSequence] - 因果WAL序列号
   * @param {Object} [data.metadata] - 自定义元数据
   * @returns {Object|null} 创建的检查点对象，参数无效时返回null
   * @throws {Error} When checkpoint name is not a valid string
   * @example
   * const cm = new CheckpointManager(projectRoot);
   * const checkpoint = cm.create('session-42', {
   *   phase: 'development',
   *   completedSkills: ['tdd-implement', 'code-review'],
   *   tokensUsed: 15000,
   *   metadata: { description: 'State before auth module refactoring' }
   * });
   * console.log(checkpoint.id, checkpoint.createdAt);
   */
  create(sessionId, data) {
    this.guardShutdown();
    if (this._createLock) return null;
    if (!sessionId || !data) return null;
    if (!isNonEmptyString(sessionId) || !SAFE_ID_RE.test(sessionId)) return null;
    if (sessionId.length > 128) return null;

    const id = generateId('cp-');
    let timestamp = new Date().getTime();
    if (timestamp <= this._lastTimestamp) {
      timestamp = this._lastTimestamp + 1;
    }
    this._lastTimestamp = timestamp;
    const checkpoint = {
      id,
      sessionId,
      phase: data.phase || '',
      completedSkills: data.completedSkills ?? [],
      tokensUsed: data.tokensUsed ?? 0,
      agentHistory: data.agentHistory ?? [],
      causalWalSequence: data.causalWalSequence ?? 0,
      metadata: data.metadata ?? {},
      createdAt: (function() { const d = new Date(timestamp); return !isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString(); })(),
    };

    this._checkpoints.set(id, checkpoint);
    if (this._checkpoints.size > MAX_CHECKPOINTS) {
      const oldest = this._findOldest();
      if (oldest) this._checkpoints.delete(oldest);
    }
    process.nextTick(() => {
      if (this._shutDown) return;
      this._persist();
    });
    return checkpoint;
  }

  /**
   * 异步创建检查点，保存会话当前状态快照
   * @param {string} sessionId - 会话ID，需匹配SAFE_ID_RE且不超过128字符
   * @param {Object} data - 检查点数据，同create方法的data参数
   * @returns {Promise<Object|null>} 创建的检查点对象，参数无效时返回null
   */
  async createAsync(sessionId, data) {
    this.guardShutdown();
    if (this._createLock) return null;
    this._createLock = true;
    try {
      if (!sessionId || !data) return null;
      if (!isNonEmptyString(sessionId) || !SAFE_ID_RE.test(sessionId)) return null;
      if (sessionId.length > 128) return null;

      const id = generateId('cp-');
      let timestamp = new Date().getTime();
      if (timestamp <= this._lastTimestamp) {
        timestamp = this._lastTimestamp + 1;
      }
      this._lastTimestamp = timestamp;
      const checkpoint = {
        id,
        sessionId,
        phase: data.phase || '',
        completedSkills: data.completedSkills ?? [],
        tokensUsed: data.tokensUsed ?? 0,
        agentHistory: data.agentHistory ?? [],
        causalWalSequence: data.causalWalSequence ?? 0,
        metadata: data.metadata ?? {},
        createdAt: (function() { const d = new Date(timestamp); return !isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString(); })(),
      };

      this._checkpoints.set(id, checkpoint);
      if (this._checkpoints.size > MAX_CHECKPOINTS) {
        const oldest = this._findOldest();
        if (oldest) this._checkpoints.delete(oldest);
      }
      await this._persistAsync();
      return checkpoint;
    } finally {
      this._createLock = false;
    }
  }

  /**
   * 获取指定检查点的快照数据
   * @param {string} checkpointId - 检查点ID
   * @returns {Object|null} 检查点快照对象，不存在时返回null
   */
  get(checkpointId) {
    this.guardShutdown();
    const cp = this._checkpoints.get(checkpointId);
    if (!cp) return null;
    return {
      id: cp.id,
      sessionId: cp.sessionId,
      phase: cp.phase,
      completedSkills: cp.completedSkills.slice(),
      tokensUsed: cp.tokensUsed,
      agentHistory: cp.agentHistory.slice(),
      causalWalSequence: cp.causalWalSequence ?? 0,
      metadata: mergeConfig({}, cp.metadata),
      createdAt: cp.createdAt,
    };
  }

  /**
   * 列出检查点，可按会话ID过滤，按创建时间降序排列
   * @param {string} [sessionId] - 可选的会话ID过滤条件
   * @returns {Object[]} 检查点快照数组
   */
  list(sessionId) {
    this.guardShutdown();
    const results = [];
    for (const [, cp] of this._checkpoints) {
      if (!sessionId || cp.sessionId === sessionId) {
        results.push({
          id: cp.id,
          sessionId: cp.sessionId,
          phase: cp.phase,
          completedSkills: cp.completedSkills.slice(),
          tokensUsed: cp.tokensUsed,
          agentHistory: cp.agentHistory.slice(),
          causalWalSequence: cp.causalWalSequence ?? 0,
          metadata: mergeConfig({}, cp.metadata),
          createdAt: cp.createdAt,
        });
      }
    }
    return results.sort((a, b) => {
      const da = safeDateGetTime(b.createdAt);
      const db = safeDateGetTime(a.createdAt);
      return (Number.isFinite(da) ? da : 0) - (Number.isFinite(db) ? db : 0);
    });
  }

  /**
   * 从指定检查点恢复会话状态，返回可恢复的状态快照
   * @param {string} checkpointId - 检查点ID
   * @returns {Object|null} 恢复的状态对象，包含phase、completedSkills、tokensUsed等字段；检查点不存在时返回null
   */
  restore(checkpointId) {
    this.guardShutdown();
    const checkpoint = this._checkpoints.get(checkpointId);
    if (!checkpoint) return null;
    return {
      phase: checkpoint.phase,
      completedSkills: Array.isArray(checkpoint.completedSkills) ? [...checkpoint.completedSkills] : [],
      tokensUsed: checkpoint.tokensUsed,
      agentHistory: Array.isArray(checkpoint.agentHistory) ? [...checkpoint.agentHistory] : [],
      causalWalSequence: checkpoint.causalWalSequence ?? 0,
      metadata: { ...checkpoint.metadata },
      restoredFrom: checkpoint.id,
      restoredAt: new Date().toISOString(),
    };
  }

  /**
   * 从指定检查点恢复会话状态，并协调因果数据总线的WAL回滚
   * @param {string} checkpointId - 检查点ID
   * @param {Object} [causalDataBus] - 因果数据总线实例，需实现rollbackToSequence方法
   * @returns {Object|null} 恢复的状态对象（含causalRollback字段）；检查点不存在时返回null
   */
  restoreWithCausalRollback(checkpointId, causalDataBus) {
    this.guardShutdown();
    const restored = this.restore(checkpointId);
    if (!restored) return null;
    if (causalDataBus && typeof causalDataBus.rollbackToSequence === 'function' && restored.causalWalSequence > 0) {
      try {
        const rollbackResult = causalDataBus.rollbackToSequence(restored.causalWalSequence);
        restored.causalRollback = rollbackResult;
      } catch (err) {
        debug('CheckpointManager', 'causalRollback', err);
        restored.causalRollback = { success: false, error: err && err.message ? err.message : String(err) };
      }
    }
    return restored;
  }

  /**
   * 删除指定检查点
   * @param {string} checkpointId - 检查点ID
   * @returns {boolean} 是否成功删除
   */
  remove(checkpointId) {
    this.guardShutdown();
    const existed = this._checkpoints.delete(checkpointId);
    if (existed) this._persist();
    return existed;
  }

  /**
   * 获取指定会话的最新检查点
   * @param {string} [sessionId] - 可选的会话ID过滤条件
   * @returns {Object|null} 最新的检查点快照，无检查点时返回null
   */
  getLatest(sessionId) {
    this.guardShutdown();
    const checkpoints = this.list(sessionId);
    return checkpoints.length > 0 ? checkpoints[0] : null;
  }

  _findOldest() {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, cp] of this._checkpoints) {
      const time = safeDateGetTime(cp.createdAt);
      if (Number.isFinite(time) && time < oldestTime) {
        oldestTime = time;
        oldestId = id;
      }
    }
    return oldestId;
  }

  _restore() {
    const entries = readJsonDirSync(this._checkpointsDir, { logLabel: 'CheckpointManager' });
    for (const { data: cp } of entries) {
      if (!cp || !cp.id || typeof cp.id !== 'string') continue;
      cp.completedSkills = Array.isArray(cp.completedSkills) ? cp.completedSkills : [];
      cp.agentHistory = Array.isArray(cp.agentHistory) ? cp.agentHistory : [];
      cp.tokensUsed = typeof cp.tokensUsed === 'number' && Number.isFinite(cp.tokensUsed) ? cp.tokensUsed : 0;
      cp.phase = typeof cp.phase === 'string' ? cp.phase : '';
      cp.causalWalSequence = typeof cp.causalWalSequence === 'number' ? cp.causalWalSequence : 0;
      cp.metadata = (cp.metadata && typeof cp.metadata === 'object' && !Array.isArray(cp.metadata)) ? cp.metadata : {};
      this._checkpoints.set(cp.id, cp);
    }
  }

  async _restoreAsync() {
    try {
      const entries = await readJsonDirAsync(this._checkpointsDir, { logLabel: 'CheckpointManager' });
      for (const { data: cp } of entries) {
        if (cp.id) this._checkpoints.set(cp.id, cp);
      }
    } catch (err) {
      debug('CheckpointManager', '_restoreAsync', err);
    }
  }

  _persist() {
    try {
      ensureDirSync(this._checkpointsDir);
      const currentIds = new Set();
      for (const [, cp] of this._checkpoints) {
        currentIds.add(cp.id);
        if (!SAFE_ID_RE.test(cp.id)) continue;
        writeAtomic(path.join(this._checkpointsDir, `${cp.id}.json`), cp);
      }
      const existing = fs.readdirSync(this._checkpointsDir).filter(f => f.endsWith(JSON_EXT));
      for (const f of existing) {
        const id = f.replace(JSON_EXT, '');
        if (!currentIds.has(id)) {
          fs.unlinkSync(path.join(this._checkpointsDir, f));
        }
      }
      return true;
    } catch (err) {
      debug('CheckpointManager', '_persist', err);
      return false;
    }
  }

  async _persistAsync() {
    try {
      await ensureDirAsync(this._checkpointsDir);
      const currentIds = new Set();
      const writePromises = [];
      for (const [, cp] of this._checkpoints) {
        currentIds.add(cp.id);
        if (!SAFE_ID_RE.test(cp.id)) continue;
        writePromises.push(
          writeAtomicAsync(path.join(this._checkpointsDir, `${cp.id}.json`), cp).catch(function(err) {
            debug('CheckpointManager', '_persistAsync:write', err);
          }),
        );
      }
      await Promise.allSettled(writePromises);
      const existing = (await fs.promises.readdir(this._checkpointsDir)).filter(f => f.endsWith(JSON_EXT));
      const deletePromises = [];
      for (const f of existing) {
        const id = f.replace(JSON_EXT, '');
        if (!currentIds.has(id)) {
          deletePromises.push(
            fs.promises.unlink(path.join(this._checkpointsDir, f)).catch(function(err) {
              debug('CheckpointManager', '_persistAsync:unlink', err);
            }),
          );
        }
      }
      await Promise.allSettled(deletePromises);
    } catch (err) {
      debug('CheckpointManager', '_persistAsync', err);
    }
  }

  _onShutdown() {
    if (this._shutdownStarted) return;
    this._shutdownStarted = true;
    try {
      this._persist();
    } catch (err) {
      debug('CheckpointManager', '_onShutdown', err);
    }
    this._checkpoints.clear();
  }
}

CheckpointManager.MAX_CHECKPOINTS = MAX_CHECKPOINTS;

module.exports = withShutdown(CheckpointManager);
