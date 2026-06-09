'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { AgentError } = require('../../errors');
const { validateAgentId, validateProjectRoot, HARNESS_DIR } = require('../../utils/constants');
const { safeExecute } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const { sanitize: sanitizeData, writeAtomic, writeAtomicAsync } = require('../../utils/debounced-persister');
const { readJsonDirSync } = require('../../utils/fs-utils');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const deepClone = require('../../utils/deep-clone');

const MAX_STATE_SIZE = 1024 * 1024;
const MAX_SNAPSHOTS_PER_AGENT = 50;
const MAX_STATES = 500;
const STATE_DIR = 'agent-states';
const SNAPSHOT_DIR = 'agent-snapshots';
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @module runtime/agent/agent-state-manager
 * @classdesc Agent状态管理器（AgentStateManager）。持久化、恢复、快照，
 * 支持校验和验证、异步周期性持久化、状态同步/合并、有界快照历史。
 *
 * AgentStateManager — Agent state persistence with snapshot and restore capabilities
 * Manages per-agent state with checksum verification, snapshot creation/restore, periodic async
 * persistence to .harness/agent-states/, state sync/merge for distributed coordination,
 * and bounded snapshot history per agent.
 * @extends EventEmitter
 * @emits state-saved | state-deleted | snapshot-created | state-synced
 */
class AgentStateManager extends EventEmitter {
  /**
   * 创建AgentStateManager实例并从磁盘加载已有状态。
   * @param {string} projectRoot - 项目根目录路径
   * @param {Object} [options] - 配置选项
   * @param {number} [options.persistInterval=5000] - 异步持久化间隔（毫秒）
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'AgentStateManager', AgentError);
    this.root = projectRoot;
    this._stateDir = path.join(this.root, HARNESS_DIR, STATE_DIR);
    this._snapDir = path.join(this.root, HARNESS_DIR, SNAPSHOT_DIR);
    this.options = mergeConfig({ persistInterval: 5000 }, options ?? {});
    this._states = new Map();
    this._snapshots = new Map();
    this._persistTimer = null;
    this._pendingPersist = false;
    this._loadFromDisk();
    this._startPersistLoop();
  }

  _loadFromDisk() {
    const stateDir = this._stateDir;
    const entries = safeExecute(() => readJsonDirSync(stateDir), 'AgentStateManager', 'loadFromDisk', []);
    if (Array.isArray(entries)) {
      entries.forEach(entry => {
        const data = entry && entry.data ? entry.data : entry;
        if (data && data.agentId) {
          this._states.set(data.agentId, data);
        }
      });
    }
    const snapDir = this._snapDir;
    const snapEntries = safeExecute(() => readJsonDirSync(snapDir), 'AgentStateManager', 'loadSnapshots', []);
    if (Array.isArray(snapEntries)) {
      snapEntries.forEach(entry => {
        const data = entry && entry.data ? entry.data : entry;
        if (data && data.agentId && data.id) {
          if (!this._snapshots.has(data.agentId)) this._snapshots.set(data.agentId, []);
          const arr = this._snapshots.get(data.agentId);
          arr.push(data);
          if (arr.length > MAX_SNAPSHOTS_PER_AGENT) arr.splice(0, arr.length - MAX_SNAPSHOTS_PER_AGENT);
        }
      });
    }
  }

  _startPersistLoop() {
    if (this._persistTimer) clearInterval(this._persistTimer);
    const interval = typeof this.options.persistInterval === 'number' && Number.isFinite(this.options.persistInterval) ? this.options.persistInterval : 30000;
    if (interval > 0) {
      this._persistFailCount = 0;
      this._persistTimer = setInterval(() => {
        if (this._shutDown) return;
        this._persistAsync().then(() => {
          this._persistFailCount = 0;
        }).catch(e => {
          this._persistFailCount++;
          debug('AgentStateManager', 'persistAsync', e && e.message ? e.message : String(e));
          this.emit('persist-error', { failCount: this._persistFailCount, error: e });
          if (this._persistFailCount >= 5) {
            this.emit('persist-critical', { failCount: this._persistFailCount, message: 'Agent state persistence has failed 5 consecutive times' });
          }
        });
      }, interval);
      if (this._persistTimer && typeof this._persistTimer.unref === 'function') { this._persistTimer.unref(); }
    }
  }

  _persist() {
    if (!this.isHealthy()) return;
    this._forcePersist();
  }

  _forcePersist() {
    const stateDir = this._stateDir;
    safeExecute(() => {
      fs.mkdirSync(stateDir, { recursive: true });
      for (const [agentId, data] of this._states) {
        try {
          const filePath = path.join(stateDir, agentId + '.json');
          let jsonStr;
          try {
            jsonStr = JSON.stringify(sanitizeData(data));
          } catch (_e) {
            jsonStr = '{}';
          }
          writeAtomic(filePath, jsonStr);
        } catch (writeErr) {
          debug('AgentStateManager', 'persist', 'Failed to write state for ' + agentId + ': ' + (writeErr && writeErr.message ? writeErr.message : String(writeErr)));
        }
      }
    }, 'AgentStateManager', 'persist', null);
  }

  async _persistAsync() {
    if (!this.isHealthy()) return;
    if (this._pendingPersist) return;
    this._pendingPersist = true;
    try {
      const stateDir = this._stateDir;
      await fs.promises.mkdir(stateDir, { recursive: true });
      for (const [agentId, data] of this._states) {
        try {
          const filePath = path.join(stateDir, agentId + '.json');
          await writeAtomicAsync(filePath, deepClone(sanitizeData(data)));
        } catch (writeErr) {
          debug('AgentStateManager', 'persistAsync', 'Failed to write state for ' + agentId + ': ' + (writeErr && writeErr.message ? writeErr.message : String(writeErr)));
        }
      }
    } finally {
      this._pendingPersist = false;
    }
  }

  _persistSnapshot(agentId, snapshot) {
    const snapDir = this._snapDir;
    safeExecute(() => {
      fs.mkdirSync(snapDir, { recursive: true });
      const filePath = path.join(snapDir, agentId + '_' + snapshot.id + '.json');
      let jsonStr;
      try {
        jsonStr = JSON.stringify(sanitizeData(snapshot));
      } catch (_e) {
        jsonStr = '{}';
      }
      writeAtomic(filePath, jsonStr);
    }, 'AgentStateManager', 'persistSnapshot', null);
  }

  /**
   * 保存Agent状态数据，生成校验和并触发持久化。
   * @param {string} agentId - Agent标识
   * @param {Object} stateData - 状态数据对象
   * @param {Object} [options] - 保存选项
   * @param {boolean} [options.immediate=false] - 是否立即同步持久化
   * @returns {Object} 保存的状态条目 {agentId, data, checksum, updatedAt, createdAt, size}
   */
  saveState(agentId, stateData, options) {
    this.guardShutdown();
    validateAgentId(agentId, AgentError);
    if (!stateData || typeof stateData !== 'object') {
      throw new AgentError('INVALID_STATE', 'stateData must be a non-null object');
    }
    let serialized;
    try {
      serialized = JSON.stringify(stateData);
    } catch (err) {
      throw new AgentError('INVALID_STATE', 'State data contains circular references or non-serializable values: ' + (err && err.message ? err.message : String(err)), { cause: err });
    }
    if (serialized.length > MAX_STATE_SIZE) {
      throw new AgentError('STATE_TOO_LARGE', 'State data exceeds maximum size of ' + MAX_STATE_SIZE + ' bytes');
    }
    const checksum = crypto.createHash('sha256').update(serialized).digest('hex');
    const existing = this._states.get(agentId);
    const entry = {
      agentId,
      data: stateData,
      checksum,
      updatedAt: new Date().toISOString(),
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      size: serialized.length,
    };
    this._states.set(agentId, entry);
    if (this._states.size > MAX_STATES) {
      const oldestKey = this._states.keys().next().value;
      if (oldestKey) this._states.delete(oldestKey);
    }
    if (options && options.immediate) process.nextTick(() => this._persist());
    this.emit('state-saved', { agentId, checksum });
    return entry;
  }

  /**
   * 加载指定Agent的状态数据。
   * @param {string} agentId - Agent标识
   * @returns {Object|null} 状态数据，不存在时返回null
   */
  loadState(agentId) {
    this.guardShutdown();
    validateAgentId(agentId, AgentError);
    const entry = this._states.get(agentId);
    return entry ? entry.data : null;
  }

  /**
   * 删除指定Agent的状态数据及其所有快照。
   * @param {string} agentId - Agent标识
   * @returns {boolean} 是否成功删除
   */
  deleteState(agentId) {
    this.guardShutdown();
    validateAgentId(agentId, AgentError);
    const deleted = this._states.delete(agentId);
    if (deleted) {
      const agentSnaps = this._snapshots.has(agentId) ? (this._snapshots.get(agentId) ?? []) : [];
      this._snapshots.delete(agentId);
      safeExecute(() => {
        const filePath = path.join(this._stateDir, agentId + '.json');
        try { fs.unlinkSync(filePath); } catch (_e) { debug('AgentStateManager', 'unlinkStateFile', _e && _e.message ? _e.message : String(_e)); }
        const snapDir = this._snapDir;
        agentSnaps.forEach(s => {
          try { fs.unlinkSync(path.join(snapDir, agentId + '_' + s.id + '.json')); } catch (_e) { debug('AgentStateManager', 'unlinkSnapshotFile', _e && _e.message ? _e.message : String(_e)); }
        });
      }, 'AgentStateManager', 'deleteStateFiles', null);
      this.emit('state-deleted', { agentId });
    }
    return deleted;
  }

  /**
   * 检查指定Agent是否存在已保存的状态。
   * @param {string} agentId - Agent标识
   * @returns {boolean} 状态是否存在
   */
  hasState(agentId) {
    validateAgentId(agentId, AgentError);
    return this._states.has(agentId);
  }

  /**
   * 为指定Agent创建状态快照，深拷贝当前状态数据。
   * @param {string} agentId - Agent标识
   * @param {string} [label=''] - 快照标签
   * @returns {Object} 快照对象 {id, agentId, label, data, checksum, createdAt}
   */
  createSnapshot(agentId, label) {
    this.guardShutdown();
    validateAgentId(agentId, AgentError);
    const entry = this._states.get(agentId);
    if (!entry) throw new AgentError('STATE_NOT_FOUND', 'No state found for agent: ' + agentId);
    if (!this._snapshots.has(agentId)) this._snapshots.set(agentId, []);
    const snapshots = this._snapshots.get(agentId);
    if (snapshots.length >= MAX_SNAPSHOTS_PER_AGENT) {
      const removed = snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS_PER_AGENT + 1);
      removed.forEach(s => {
        safeExecute(() => {
          const filePath = path.join(this._snapDir, agentId + '_' + s.id + '.json');
          try { fs.unlinkSync(filePath); } catch (_e) { debug('AgentStateManager', 'unlinkOldSnapshot', _e && _e.message ? _e.message : String(_e)); }
        }, 'AgentStateManager', 'unlinkOldSnapshot', null);
      });
    }
    const snapshot = {
      id: crypto.randomBytes(8).toString('hex'),
      agentId,
      label: label || '',
      data: deepClone(entry.data),
      checksum: entry.checksum,
      createdAt: new Date().toISOString(),
    };
    snapshots.push(snapshot);
    this._persistSnapshot(agentId, snapshot);
    this.emit('snapshot-created', { agentId, snapshotId: snapshot.id });
    return snapshot;
  }

  /**
   * 从快照恢复Agent状态，覆盖当前状态数据。
   * @param {string} agentId - Agent标识
   * @param {string} snapshotId - 快照标识
   * @returns {Object} 恢复后的状态数据
   */
  restoreSnapshot(agentId, snapshotId) {
    this.guardShutdown();
    validateAgentId(agentId, AgentError);
    const snapshots = this._snapshots.get(agentId);
    if (!snapshots) throw new AgentError('SNAPSHOT_NOT_FOUND', 'No snapshots for agent: ' + agentId);
    const snapshot = snapshots.find(s => s.id === snapshotId);
    if (!snapshot) throw new AgentError('SNAPSHOT_NOT_FOUND', 'Snapshot not found: ' + snapshotId);
    return this.saveState(agentId, snapshot.data, { immediate: true }).data;
  }

  /**
   * 列出指定Agent的所有快照摘要信息。
   * @param {string} agentId - Agent标识
   * @returns {Object[]} 快照摘要数组 [{id, label, createdAt, checksum}]
   */
  listSnapshots(agentId) {
    validateAgentId(agentId, AgentError);
    return (this._snapshots.get(agentId) ?? []).map(s => ({
      id: s.id,
      label: s.label,
      createdAt: s.createdAt,
      checksum: s.checksum,
    }));
  }

  /**
   * 删除指定Agent的某个快照。
   * @param {string} agentId - Agent标识
   * @param {string} snapshotId - 快照标识
   * @returns {boolean} 是否成功删除
   */
  deleteSnapshot(agentId, snapshotId) {
    this.guardShutdown();
    validateAgentId(agentId, AgentError);
    const snapshots = this._snapshots.get(agentId);
    if (!snapshots) return false;
    const idx = snapshots.findIndex(s => s.id === snapshotId);
    if (idx === -1) return false;
    snapshots.splice(idx, 1);
    safeExecute(() => {
      const filePath = path.join(this.root, HARNESS_DIR, SNAPSHOT_DIR, agentId + '_' + snapshotId + '.json');
      try { fs.unlinkSync(filePath); } catch (_e) { debug('AgentStateManager', 'unlinkSnapshot', _e && _e.message ? _e.message : String(_e)); }
    }, 'AgentStateManager', 'deleteSnapshotFile', null);
    return true;
  }

  /**
   * 同步远程状态数据到本地，合并后立即持久化。
   * @param {string} agentId - Agent标识
   * @param {Object} remoteData - 远程状态数据
   * @returns {Object} 合并后的状态条目
   */
  syncState(agentId, remoteData) {
    this.guardShutdown();
    validateAgentId(agentId, AgentError);
    if (!remoteData || typeof remoteData !== 'object') {
      throw new AgentError('INVALID_STATE', 'remoteData must be a non-null object');
    }
    const local = this._states.get(agentId);
    const localData = (local && local.data && typeof local.data === 'object') ? local.data : {};
    const merged = {};
    for (const key of Object.keys(localData)) {
      if (!DANGEROUS_KEYS.has(key)) merged[key] = localData[key];
    }
    for (const key of Object.keys(remoteData)) {
      if (!DANGEROUS_KEYS.has(key)) merged[key] = remoteData[key];
    }
    const result = this.saveState(agentId, merged, { immediate: true });
    this.emit('state-synced', { agentId });
    return result;
  }

  /**
   * 列出所有已保存状态的Agent标识。
   * @returns {string[]} Agent标识数组
   */
  listAgents() {
    return Array.from(this._states.keys());
  }

  /**
   * 获取指定Agent的状态元信息（不含数据本身）。
   * @param {string} agentId - Agent标识
   * @returns {Object|null} 状态元信息 {agentId, checksum, updatedAt, createdAt, size, snapshotCount}
   */
  getStateInfo(agentId) {
    validateAgentId(agentId, AgentError);
    const entry = this._states.get(agentId);
    if (!entry) return null;
    return {
      agentId: entry.agentId,
      checksum: entry.checksum,
      updatedAt: entry.updatedAt,
      createdAt: entry.createdAt,
      size: entry.size,
      snapshotCount: (this._snapshots.get(agentId) ?? []).length,
    };
  }

  /**
   * 获取状态管理器的统计信息。
   * @returns {Object} 统计数据 {totalAgents, totalDataSize, totalSnapshots, averageDataSize}
   */
  getStats() {
    let totalDataSize = 0;
    let totalSnapshots = 0;
    for (const entry of this._states.values()) {
      totalDataSize += (typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0);
    }
    for (const snaps of this._snapshots.values()) {
      totalSnapshots += snaps.length;
    }
    const totalAgents = this._states.size;
    return {
      totalAgents,
      totalDataSize,
      totalSnapshots,
      averageDataSize: totalAgents > 0 ? Math.round(totalDataSize / totalAgents) : 0,
    };
  }

  /**
   * 立即将所有内存中的状态同步持久化到磁盘。
   * @returns {void}
   */
  flush() {
    this._forcePersist();
  }

  _onShutdown() {
    if (this._persistTimer) {
      clearInterval(this._persistTimer);
      this._persistTimer = null;
    }
    this._forcePersist();
    this._states.clear();
    this._snapshots.clear();
    this.removeAllListeners();
  }
}

module.exports = withShutdown(AgentStateManager);
