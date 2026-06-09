'use strict';
const DeepeningBase = require('./deepening-base');
const { DeepeningError } = require('../../errors');
const { DEFAULT_PIPELINE_TIMEOUT_MS, DEFAULT_MIN_HEARTBEAT_MS } = require('../../utils/constants');
const { ensurePositiveNumber } = require('../../utils/param-validator');

/**
 * @module runtime/deepening/deepening-lock-manager
 * 可重入资源锁管理器。提供基于所有者的可重入锁获取/释放语义、
 * 可配置的逐锁超时、自动过期锁回收及强制释放能力，
 * 强制执行最大锁数量以防止资源耗尽。
 */

/**
 * 可重入资源锁管理器 — 为深化子系统提供带TTL过期的可重入资源锁管理。
 * 提供基于所有者的可重入锁获取/释放语义、可配置的逐锁超时、
 * 自动过期锁回收及强制释放能力。强制执行最大锁数量以防止资源耗尽。
 *
 * @classdesc 深化锁管理器。读写锁、分布式锁、死锁检测
 * @extends DeepeningBase
 * @emits 'acquired' 当锁获取成功时触发，附带 {resourceId, ownerId, reentrant?}
 * @emits 'denied' 当锁获取被拒绝时触发，附带 {resourceId, ownerId}
 * @emits 'released' 当锁释放时触发，附带 {resourceId, ownerId, forced?}
 * @emits 'expired' 当锁因超时过期被回收时触发，附带 {resourceId}
 */
class DeepeningLockManager extends DeepeningBase {

  /**
   * 创建 DeepeningLockManager 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.defaultTimeout] - 默认锁超时时间（毫秒），默认 DEFAULT_PIPELINE_TIMEOUT_MS
   * @param {number} [options.maxLocks=1000] - 最大锁数量
   */
  constructor(options) {
    super(options);
    this._locks = new Map();
    this._totalRefCount = 0;
    this._defaultTimeout = ensurePositiveNumber((options && options.defaultTimeout), DEFAULT_PIPELINE_TIMEOUT_MS);
    this._maxLocks = (options && options.maxLocks) ?? 1000;
    this._expiryInterval = setInterval(() => { if (this._shutDown) return; this.releaseExpiredLocks(); }, Math.min(this._defaultTimeout / 2, DEFAULT_MIN_HEARTBEAT_MS));
    if (this._expiryInterval && this._expiryInterval.unref) this._expiryInterval.unref();
  }

  /**
   * 获取资源锁。支持同一所有者可重入获取，引用计数递增。
   * @param {string} resourceId - 资源标识
   * @param {string} ownerId - 所有者标识
   * @param {Object} [options] - 锁选项
   * @param {number} [options.timeout] - 该锁的超时时间（毫秒），覆盖默认超时
   * @returns {boolean} 获取成功返回 true，锁被占用或达到最大锁数量返回 false
   * @throws {DeepeningError} 当 resourceId 或 ownerId 缺失时抛出 MISSING_PARAMETER 异常
   * @emits 'acquired' 锁获取成功时触发，附带 {resourceId, ownerId, reentrant?}
   * @emits 'denied' 锁被其他所有者持有时触发，附带 {resourceId, ownerId}
   */
  acquire(resourceId, ownerId, options) {
    this.guardShutdown();
    if (!resourceId || !ownerId) throw new DeepeningError('MISSING_PARAMETER', 'resourceId and ownerId are required');
    const opts = options ?? {};
    const existing = this._locks.get(resourceId);
    if (existing) {
      if (Date.now() - existing.acquiredAt > existing.timeout) {
        this._totalRefCount -= (existing.refCount ?? 1);
        this._locks.delete(resourceId);
        this.emit('expired', { resourceId });
      } else {
        if (existing.ownerId === ownerId) { existing.refCount = (existing.refCount ?? 1) + 1; this._totalRefCount++; this.emit('acquired', { resourceId, ownerId, reentrant: true }); return true; }
        this.emit('denied', { resourceId, ownerId });
        return false;
      }
    }
    if (this._locks.size >= this._maxLocks) return false;
    this._locks.set(resourceId, { resourceId, ownerId, refCount: 1, acquiredAt: Date.now(), timeout: opts.timeout ?? this._defaultTimeout });
    this._totalRefCount++;
    this.emit('acquired', { resourceId, ownerId });
    return true;
  }

  /**
   * 释放资源锁。同一所有者可重入释放，引用计数递减，归零时删除锁。
   * @param {string} resourceId - 资源标识
   * @param {string} ownerId - 所有者标识
   * @returns {boolean} 释放成功返回 true，锁不存在或所有者不匹配返回 false
   * @emits 'released' 锁引用归零被删除时触发，附带 {resourceId, ownerId}
   */
  release(resourceId, ownerId) {
    this.guardShutdown();
    const lock = this._locks.get(resourceId);
    if (!lock) return false;
    if (lock.ownerId !== ownerId) return false;
    lock.refCount--;
    this._totalRefCount--;
    if (lock.refCount <= 0) { this._locks.delete(resourceId); this.emit('released', { resourceId, ownerId }); }
    return true;
  }

  /**
   * 强制释放资源锁，忽略所有者检查。
   * @param {string} resourceId - 资源标识
   * @returns {boolean} 强制释放成功返回 true，锁不存在返回 false
   * @emits 'released' 锁被强制释放时触发，附带 {resourceId, forced: true}
   */
  forceRelease(resourceId) {
    this.guardShutdown();
    if (!this._locks.has(resourceId)) return false;
    const lock = this._locks.get(resourceId);
    this._totalRefCount -= (lock.refCount ?? 1);
    this._locks.delete(resourceId);
    this.emit('released', { resourceId, forced: true });
    return true;
  }

  /**
   * 检查资源是否被锁定（未超时）。
   * @param {string} resourceId - 资源标识
   * @returns {boolean} 被锁定且未超时返回 true，否则返回 false
   */
  isLocked(resourceId) {
    const lock = this._locks.get(resourceId);
    if (!lock) return false;
    if (Date.now() - lock.acquiredAt > lock.timeout) {
      this._locks.delete(resourceId);
      this._totalRefCount = Math.max(0, this._totalRefCount - lock.refCount);
      return false;
    }
    return true;
  }

  /**
   * 获取指定资源的锁信息。
   * @param {string} resourceId - 资源标识
   * @returns {Object|null} 锁信息 {resourceId, ownerId, refCount, elapsed}，锁不存在返回 null
   */
  getLock(resourceId) { const l = this._locks.get(resourceId); if (!l) return null; return { resourceId: l.resourceId, ownerId: l.ownerId, refCount: l.refCount, elapsed: Date.now() - l.acquiredAt }; }

  /**
   * 获取指定所有者持有的所有锁信息。
   * @param {string} ownerId - 所有者标识
   * @returns {Array<Object>} 锁信息数组 [{resourceId, ownerId, refCount, elapsed}]
   */
  getLocksByOwner(ownerId) {
    const result = [];
    for (const l of this._locks.values()) { if (l.ownerId === ownerId) result.push({ resourceId: l.resourceId, ownerId: l.ownerId, refCount: l.refCount, elapsed: Date.now() - l.acquiredAt }); }
    return result;
  }

  /**
   * 获取所有已过期的锁列表。
   * @returns {Array<Object>} 过期锁信息数组 [{resourceId, ownerId, refCount, elapsed}]
   */
  getExpiredLocks() {
    const now = Date.now();
    const result = [];
    for (const l of this._locks.values()) { if (now - l.acquiredAt > l.timeout) result.push({ resourceId: l.resourceId, ownerId: l.ownerId, refCount: l.refCount, elapsed: now - l.acquiredAt }); }
    return result;
  }

  /**
   * 释放所有已过期的锁。
   * @returns {Array<Object>} 被释放的过期锁列表
   * @emits 'expired' 每个过期锁被回收时触发，附带 {resourceId}
   */
  releaseExpiredLocks() {
    const now = Date.now();
    const expired = this.getExpiredLocks();
    const released = [];
    for (const l of expired) {
      const current = this._locks.get(l.resourceId);
      if (!current || now - current.acquiredAt <= current.timeout) continue;
      this._locks.delete(l.resourceId);
      this._totalRefCount -= (current.refCount ?? 1);
      this.emit('expired', { resourceId: l.resourceId });
      released.push(l);
    }
    return released;
  }

  /**
   * 获取锁管理器的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalLocks - 锁总数
   * @returns {number} return.activeLocks - 活跃锁数
   * @returns {number} return.maxLocks - 最大锁数量
   * @returns {number} return.totalRefCount - 总引用计数
   * @returns {number} return.defaultTimeout - 默认超时时间（毫秒）
   */
  getStats() {
    return { totalLocks: this._locks.size, activeLocks: this._locks.size, maxLocks: this._maxLocks, totalRefCount: this._totalRefCount, defaultTimeout: this._defaultTimeout, ...super.getStats() };
  }

  /**
   * 关闭时的清理回调。清除过期检查定时器并清空所有锁。
   * @protected
   */
  _onShutdown() {
    if (this._expiryInterval) clearInterval(this._expiryInterval);
    this._expiryInterval = null;
    this._locks.clear();
    this._totalRefCount = 0;
    super._onShutdown();
  }
}

module.exports = DeepeningLockManager;
