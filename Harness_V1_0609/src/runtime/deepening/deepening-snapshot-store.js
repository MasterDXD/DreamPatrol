'use strict';

/**
 * @module runtime/deepening/deepening-snapshot-store
 * 深化推理版本化快照存储。使用深克隆捕获状态快照并追踪版本，
 * 支持按ID或按名称最新版本恢复、快照比较、容量限制和字节大小统计。
 */

const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');
const deepClone = require('../../utils/deep-clone');
const stableStringify = require('../../utils/stable-stringify');
const { requireString_ } = require('../../utils/param-validator');
const { counterId, ID_PREFIXES } = require('../../utils/unique-id');
const { compareStateObjects } = require('../../utils/state-compare');
const { HarnessError } = require('../../errors');
const { safeCall } = require('../../utils/safe-execute');

/**
 * 深化推理版本化快照存储。使用深克隆捕获状态快照并追踪版本，
 * 支持按ID或按名称最新版本恢复、快照比较和状态差异计算。
 * 强制执行总快照数和每名称版本数的容量限制，支持自动淘汰和字节大小统计。
 * @classdesc 深化快照存储。快照持久化、增量保存、压缩
 * @extends DeepeningBase
 */
class DeepeningSnapshotStore extends DeepeningBase {

  /**
   * 创建 DeepeningSnapshotStore 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxSnapshots=50] - 最大快照存储数量
   * @param {number} [options.maxVersions=10] - 每个名称的最大版本数
   */
  constructor(options) {
    super(options);
    const maxSnapshots = (options && options.maxSnapshots) ?? 50;
    this._snapshots = new BoundedMap(maxSnapshots, {
      onEvict: (key, value) => {
        if (value) {
          this._totalSizeBytes = Math.max(0, this._totalSizeBytes - (value._sizeBytes ?? 0));
          const versions = this._versions.get(value.name);
          if (versions) {
            const idx = versions.indexOf(key);
            if (idx !== -1) versions.splice(idx, 1);
            if (versions.length === 0) this._versions.delete(value.name);
          }
        }
      },
    });
    this._versions = new Map();
    this._maxVersionNames = 200;
    this._maxVersions = (options && options.maxVersions) ?? 10;
    this._totalCreated = 0;
    this._totalRestored = 0;
    this._totalSizeBytes = 0;
  }

  /**
   * 捕获状态快照。深克隆状态数据，追踪版本号和字节大小。
   * @param {string} name - 快照名称
   * @param {Object} state - 要捕获的状态对象
   * @param {Object} [metadata] - 快照元数据
   * @returns {string} 快照ID
   * @throws {HarnessError} state 为 null 或 undefined 时抛出异常
   * @emits 'captured' 当快照捕获成功时触发
   */
  capture(name, state, metadata) {
    this.guardShutdown();
    requireString_(name, 'Snapshot name');
    if (state == null) throw new HarnessError('SNAPSHOT_STORE_ERROR', 'State is required');
    const id = counterId(ID_PREFIXES.DEEPENING_SNAPSHOT_STORE);
    const version = (this._versions.get(name) ?? []).length + 1;
    const stateStr = stableStringify(state);
    const stateSize = stateStr.length;
    const clonedState = deepClone(state);
    const snapshot = { id, name, state: clonedState, metadata, version, timestamp: Date.now(), _sizeBytes: stateSize, _cachedSize: stateSize };
    this._snapshots.set(id, snapshot);
    this._totalSizeBytes += stateSize;
    if (!this._versions.has(name)) {
      if (this._versions.size >= this._maxVersionNames) {
        const oldest = this._versions.keys().next().value;
        this._versions.delete(oldest);
      }
      this._versions.set(name, []);
    }
    const versions = this._versions.get(name);
    versions.push(id);
    if (versions.length > this._maxVersions) { const oldId = versions.shift(); const old = this._snapshots.get(oldId); if (old) this._totalSizeBytes = Math.max(0, this._totalSizeBytes - (old._sizeBytes ?? 0)); this._snapshots.delete(oldId); }
    this._totalCreated++;
    this.emit('captured', { name, version });
    return id;
  }

  /**
   * 按ID恢复快照状态。返回深克隆的状态副本。
   * @param {string} id - 快照ID
   * @returns {Object|null} 深克隆的状态对象，未找到返回 null
   * @emits 'restored' 当快照恢复成功时触发
   */
  restore(id) {
    const snapshot = this._snapshots.get(id);
    if (!snapshot) return null;
    this._totalRestored++;
    this.emit('restored', { id, name: snapshot.name });
    return deepClone(snapshot.state);
  }

  /**
   * 按名称恢复最新版本的快照状态。
   * @param {string} name - 快照名称
   * @returns {Object|null} 深克隆的状态对象，未找到返回 null
   */
  restoreLatest(name) {
    const versions = this._versions.get(name);
    if (!versions || versions.length === 0) return null;
    const latestId = versions[versions.length - 1];
    return this.restore(latestId);
  }

  /**
   * 获取指定名称的所有版本信息。
   * @param {string} name - 快照名称
   * @returns {Object[]} 版本信息数组，每项包含 version 字段
   */
  getVersions(name) {
    const versions = this._versions.get(name);
    if (!versions) return [];
    return versions.map(id => {
      const s = this._snapshots.get(id);
      return s ? { version: s.version } : null;
    }).filter(Boolean);
  }

  /**
   * 获取所有快照名称列表。
   * @returns {string[]} 快照名称数组
   */
  getNames() { return Array.from(this._versions.keys()); }

  /**
   * 获取指定快照的摘要信息。
   * @param {string} id - 快照ID
   * @returns {Object|null} 快照摘要对象，包含 name、version、metadata、size；未找到返回 null
   */
  get(id) {
    const s = this._snapshots.get(id);
    if (!s) return null;
    const size = s._cachedSize !== undefined ? s._cachedSize : (function() { try { return stableStringify(s.state).length; } catch (_e) { debug('DeepeningSnapshotStore', 'sizeCalc', _e && _e.message ? _e.message : String(_e)); return 0; } })();
    return { name: s.name, version: s.version, metadata: s.metadata, size };
  }

  /**
   * 比较两个快照的状态差异。
   * @param {string} id1 - 第一个快照ID
   * @param {string} id2 - 第二个快照ID
   * @returns {Object|null} 比较结果对象；任一快照不存在返回 null
   */
  compare(id1, id2) {
    const s1 = this._snapshots.get(id1);
    const s2 = this._snapshots.get(id2);
    if (!s1 || !s2) return null;
    return compareStateObjects(s1.state, s2.state);
  }

  /**
   * 删除指定快照。更新字节大小统计和版本索引。
   * @param {string} id - 快照ID
   * @returns {boolean} 删除成功返回 true，快照不存在返回 false
   * @emits 'deleted' 当快照删除时触发
   */
  delete(id) {
    const snapshot = this._snapshots.get(id);
    if (!snapshot) return false;
    this._totalSizeBytes = Math.max(0, this._totalSizeBytes - (snapshot._sizeBytes ?? 0));
    this._snapshots.delete(id);
    const versions = this._versions.get(snapshot.name);
    if (versions) { const idx = versions.indexOf(id); if (idx >= 0) versions.splice(idx, 1); }
    this.emit('deleted', { id });
    return true;
  }

  /**
   * 按名称删除所有关联快照。
   * @param {string} name - 快照名称
   * @returns {number} 删除的快照数量
   * @emits 'deletedByName' 当按名称删除快照时触发
   */
  deleteByName(name) {
    const versions = this._versions.get(name);
    if (!versions || versions.length === 0) return 0;
    const count = versions.length;
    for (const id of versions) { const s = this._snapshots.get(id); if (s) this._totalSizeBytes = Math.max(0, this._totalSizeBytes - (s._sizeBytes ?? 0)); this._snapshots.delete(id); }
    this._versions.delete(name);
    this.emit('deletedByName', { name, count });
    return count;
  }

  /**
   * 清空所有快照和版本索引。
   * @returns {boolean} 始终返回 true
   * @emits 'cleared' 当清空完成时触发
   */
  clear() { this._snapshots.clear(); this._versions.clear(); this._totalSizeBytes = 0; this.emit('cleared'); return true; }

  /**
   * 获取快照存储统计信息。
   * @returns {Object} 统计对象，包含 totalSnapshots、totalNames、totalCreated、totalRestored、totalSizeBytes 等
   */
  getStats() {
    return { totalSnapshots: this._snapshots.size, totalNames: this._versions.size, totalCreated: this._totalCreated, totalRestored: this._totalRestored, totalSizeBytes: this._totalSizeBytes, maxSnapshots: this._snapshots.maxSize, maxVersions: this._maxVersions, ...super.getStats() };
  }

  /**
   * 关闭时清理所有快照和版本数据。
   * @protected
   */
  _onShutdown() {
    safeCall(() => this._snapshots.shutdown(), 'DeepeningSnapshotStore', 'shutdown-snapshots');
    this._versions.clear();
    super._onShutdown();
  }
}

module.exports = DeepeningSnapshotStore;
