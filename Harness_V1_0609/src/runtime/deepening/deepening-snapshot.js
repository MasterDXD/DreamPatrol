'use strict';

/**
 * @module runtime/deepening/deepening-snapshot
 * 深化推理执行状态快照管理器。创建、恢复和比较执行状态快照，
 * 使用 BoundedMap 限制存储容量，支持按执行ID列出快照、深度比较状态差异和时间差追踪。
 */

const DeepeningBase = require('./deepening-base');
const BoundedMap = require('../../utils/bounded-map');
const { counterId, ID_PREFIXES } = require('../../utils/unique-id');
const { compareStateObjects } = require('../../utils/state-compare');
const deepClone = require('../../utils/deep-clone');
const { safeCall } = require('../../utils/safe-execute');

/**
 * 深化推理执行状态快照管理器。创建、恢复和比较执行状态快照，
 * 使用 BoundedMap 限制存储容量，支持按执行ID列出快照、深度比较状态差异和时间差追踪，
 * 用于检查点和恢复工作流。
 * @classdesc 深化快照。状态快照创建、比较、回滚
 * @extends DeepeningBase
 */
class DeepeningSnapshot extends DeepeningBase {

  /**
   * 创建 DeepeningSnapshot 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxSnapshots=100] - 最大快照存储数量
   */
  constructor(options) {
    super(options);
    this._snapshots = new BoundedMap((options && options.maxSnapshots) ?? 100);
  }

  /**
   * 创建执行状态快照。
   * @param {string} executionId - 执行标识
   * @param {Object} state - 要快照的状态对象
   * @returns {Object} 创建的快照对象，包含 snapshotId、executionId、state、createdAt
   */
  create(executionId, state) {
    this.guardShutdown();
    const snapshotId = counterId(ID_PREFIXES.DEEPENING_SNAPSHOT);
    const snapshot = { snapshotId, executionId, state: deepClone(state), createdAt: Date.now() };
    this._snapshots.set(snapshotId, snapshot);
    return snapshot;
  }

  /**
   * 恢复指定快照。
   * @param {string} snapshotId - 快照标识
   * @returns {Object|null} 快照对象，未找到返回 null
   */
  restore(snapshotId) {
    const snapshot = this._snapshots.get(snapshotId);
    if (!snapshot) return null;
    return { ...snapshot, state: deepClone(snapshot.state) };
  }

  /**
   * 按执行ID列出所有关联快照。
   * @param {string} executionId - 执行标识
   * @returns {Object[]} 该执行的所有快照对象数组
   */
  listByExecution(executionId) {
    const result = [];
    for (const s of this._snapshots.values()) { if (s.executionId === executionId) result.push(s); }
    return result;
  }

  /**
   * 比较两个快照的状态差异。使用深度比较计算变更和新增字段，并追踪时间差。
   * @param {string} snapshotId1 - 第一个快照标识
   * @param {string} snapshotId2 - 第二个快照标识
   * @returns {Object|null} 比较结果对象，包含 diff 和 timeDiff；任一快照不存在返回 null
   */
  compare(snapshotId1, snapshotId2) {
    const s1 = this._snapshots.get(snapshotId1);
    const s2 = this._snapshots.get(snapshotId2);
    if (!s1 || !s2) return null;
    const result = compareStateObjects(s1.state, s2.state);
    if (!result) return null;
    result.diff = [...(Array.isArray(result.changed) ? result.changed : []), ...(Array.isArray(result.added) ? result.added : [])];
    result.timeDiff = s2.createdAt - s1.createdAt;
    return result;
  }

  /**
   * 删除指定快照。
   * @param {string} snapshotId - 快照标识
   * @returns {boolean} 删除成功返回 true
   */
  delete(snapshotId) { this.guardShutdown(); return this._snapshots.delete(snapshotId); }

  /**
   * 获取指定快照。
   * @param {string} snapshotId - 快照标识
   * @returns {Object|null} 快照对象，未找到返回 null
   */
  get(snapshotId) {
    const snapshot = this._snapshots.get(snapshotId);
    if (!snapshot) return null;
    return { ...snapshot, state: deepClone(snapshot.state) };
  }

  /**
   * 获取快照管理器统计信息。
   * @returns {Object} 统计对象，包含 totalSnapshots、maxSnapshots 等
   */
  getStats() {
    if (this._shutDown || !this._snapshots) return { totalSnapshots: 0, maxSnapshots: 0, ...super.getStats() };
    return { totalSnapshots: this._snapshots.size, maxSnapshots: this._snapshots.maxSize, ...super.getStats() };
  }

  _onShutdown() {
    safeCall(() => this._snapshots.shutdown(), 'DeepeningSnapshot', 'shutdown-snapshots');
    this._snapshots = null;
    super._onShutdown();
  }
}

module.exports = DeepeningSnapshot;
