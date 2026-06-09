'use strict';

/**
 * @module runtime/thought/memory-sync-coordinator
 * @classdesc 记忆同步协调器（MemorySyncCoordinator）—— 跨存储一致性协调。
 * 支持3种同步策略（事件驱动/周期性/手动）和3种冲突解决策略（最新胜/置信度合并/源优先级）。
 * 自动发现存储实例的sync/write/query方法（queryKnowledge/search/store/addKnowledge等），
 * 批量处理同步队列，关闭时自动刷写未处理队列。
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { safeCall, ensureArray } = require('../../utils/safe-execute');
const BoundedArray = require('../../utils/bounded-array');
const safeAssign = require('../../utils/safe-assign');
const { mergeConfig } = safeAssign;

const SYNC_POLICIES = {
  ON_EVENT: 'on-event',
  PERIODIC: 'periodic',
  MANUAL: 'manual',
};

const CONFLICT_STRATEGIES = {
  LATEST_WINS: 'latest-wins',
  CONFIDENCE_MERGE: 'confidence-merge',
  SOURCE_PRIORITY: 'source-priority',
};

const DEFAULT_SYNC_CONFIG = {
  maxSyncQueueSize: 100,
  syncIntervalMs: 300000,
  batchSize: 10,
  conflictStrategy: 'confidence-merge',
  enableAutoSync: true,
};

class MemorySyncCoordinator extends EventEmitter {
  /**
   * 创建MemorySyncCoordinator实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxSyncQueueSize=100] - 同步队列最大条目数
   * @param {number} [options.syncIntervalMs=300000] - 周期同步间隔（毫秒）
   * @param {number} [options.batchSize=10] - 每批处理的最大条目数
   * @param {string} [options.conflictStrategy='confidence-merge'] - 冲突解决策略（latest-wins/confidence-merge/source-priority）
   * @param {boolean} [options.enableAutoSync=true] - 是否启用自动同步
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_SYNC_CONFIG, options ?? {});
    this._stores = new Map();
    this._syncQueue = new BoundedArray(this._config.maxSyncQueueSize);
    this._syncTimer = null;
    this._processingQueue = false;
    this._stats = {
      totalSyncs: 0,
      conflictsResolved: 0,
      itemsSynced: 0,
      errors: 0,
      byStore: {},
    };
  }

  /**
   * 注册记忆存储实例。自动发现实例的sync/write/query方法。
   * @param {string} storeName - 存储名称
   * @param {Object} storeInstance - 存储实例（需实现queryKnowledge/search/store/addKnowledge等方法之一）
   * @param {Object} [options] - 注册选项
   * @param {Function} [options.syncFn] - 自定义同步函数
   * @param {Function} [options.writeFn] - 自定义写入函数
   * @param {Function} [options.queryFn] - 自定义查询函数
   * @param {number} [options.priority=1] - 存储优先级（用于source-priority冲突解决）
   * @returns {MemorySyncCoordinator} this（支持链式调用）
   */
  registerStore(storeName, storeInstance, options) {
    if (!storeName || typeof storeName !== 'string') return this;
    if (!storeInstance || typeof storeInstance !== 'object') return this;
    const opts = options ?? {};
    this._stores.set(storeName, {
      instance: storeInstance,
      syncFn: opts.syncFn ?? this.getDefaultSyncFn(storeName),
      priority: opts.priority ?? 1,
      writeFn: opts.writeFn ?? this.getDefaultWriteFn(storeName),
      queryFn: opts.queryFn ?? this.getDefaultQueryFn(storeName),
      enabled: true,
    });
    this._stats.byStore[storeName] = { syncs: 0, items: 0, errors: 0 };
    return this;
  }

  /**
   * 注销记忆存储实例。
   * @param {string} storeName - 存储名称
   * @returns {MemorySyncCoordinator} this（支持链式调用）
   */
  unregisterStore(storeName) {
    this._stores.delete(storeName);
    return this;
  }

  getDefaultSyncFn(storeName) {
    const self = this;
    return function(filter) {
      const store = self._stores.get(storeName);
      if (!store || !store.instance) return [];
      const inst = store.instance;
      if (typeof inst.queryKnowledge === 'function') return inst.queryKnowledge(filter);
      if (typeof inst.search === 'function') return inst.search(filter);
      if (typeof inst.getNotes === 'function') return inst.getNotes();
      if (typeof inst.retrieve === 'function') return inst.retrieve(filter);
      return [];
    };
  }

  getDefaultWriteFn(storeName) {
    const self = this;
    return function(entry) {
      const store = self._stores.get(storeName);
      if (!store || !store.instance) return null;
      const inst = store.instance;
      if (typeof inst.addKnowledge === 'function') return inst.addKnowledge(entry);
      if (typeof inst.store === 'function') return inst.store(entry.key, entry.content, entry.metadata);
      if (typeof inst.createEntry === 'function') return inst.createEntry(entry.category, entry.title, entry.content, entry.metadata);
      return null;
    };
  }

  _tryQueryMethod(inst, methodName, arg, label) {
    try {
      const r = inst[methodName](arg);
      if (Array.isArray(r)) return r.length > 0 ? r[0] : null;
      return r;
    } catch (_e) {
      debug('MemorySyncCoordinator', label, _e && _e.message ? _e.message : String(_e));
      return null;
    }
  }

  getDefaultQueryFn(storeName) {
    const self = this;
    return function(key) {
      const store = self._stores.get(storeName);
      if (!store || !store.instance) return null;
      const inst = store.instance;
      if (typeof inst.getKnowledge === 'function') return inst.getKnowledge(key);
      if (typeof inst.get === 'function') return inst.get(key);
      if (typeof inst.getById === 'function') return inst.getById(key);
      if (typeof inst.retrieve === 'function') return self._tryQueryMethod(inst, 'retrieve', { key: key }, 'retrieveFailed');
      if (typeof inst.queryKnowledge === 'function') return self._tryQueryMethod(inst, 'queryKnowledge', { key: key }, 'queryKnowledgeFailed');
      if (typeof inst.search === 'function') return self._tryQueryMethod(inst, 'search', { key: key }, 'searchFailed');
      return null;
    };
  }

  /**
   * 将同步项加入队列。若启用自动同步则立即处理。
   * @param {Object} syncItem - 同步项
   * @param {string} syncItem.source - 来源存储名称
   * @param {Object} syncItem.data - 待同步数据
   * @param {Array<string>} [syncItem.targetStores] - 目标存储名称列表（空则同步到所有其他存储）
   * @param {number} [syncItem.priority=0] - 优先级
   * @returns {MemorySyncCoordinator} this（支持链式调用）
   */
  enqueueSync(syncItem) {
    this.guardShutdown();
    const item = {
      source: syncItem.source,
      data: syncItem.data,
      targetStores: syncItem.targetStores ?? [],
      priority: syncItem.priority ?? 0,
      timestamp: syncItem.timestamp ?? Date.now(),
    };
    this._syncQueue.push(item);
    this.emit('sync-enqueued', { source: item.source, queueSize: this._syncQueue.length });
    if (this._config.enableAutoSync) {
      this._processSyncQueue().catch(e => { debug('MemorySyncCoordinator', 'autoSync', e && e.message ? e.message : String(e)); });
    }
    return this;
  }

  async _queryExisting(targetStore, item) {
    const itemKey = (item && (item.key ?? item.id ?? item.causalId)) ?? null;
    if (!itemKey || typeof targetStore.queryFn !== 'function') return null;
    try {
      return await Promise.resolve(targetStore.queryFn(itemKey));
    } catch (_qe) {
      debug('MemorySyncCoordinator', 'queryExisting', _qe && _qe.message ? _qe.message : String(_qe));
      return null;
    }
  }

  async _writeToTarget(targetStore, item, strategy) {
    const existingData = await this._queryExisting(targetStore, item);
    return this._resolveConflict(existingData, item, strategy);
  }

  async _syncItemsToTargets(sourceName, items, strategy) {
    let synced = 0;
    let errors = 0;
    let conflicts = 0;
    const conflictStrategy = strategy ?? this._config.conflictStrategy;
    for (const item of items) {
      for (const [targetName, targetStore] of this._stores) {
        if (targetName === sourceName) continue;
        if (!targetStore.enabled) continue;
        try {
          const resolved = await this._writeToTarget(targetStore, item, conflictStrategy);
          const result = await Promise.resolve(targetStore.writeFn(resolved));
          if (result != null) {
            synced++;
            const targetStat = this._stats.byStore[targetName];
            if (targetStat) targetStat.items++;
            if (resolved !== item) conflicts++;
          }
        } catch (err) {
          errors++;
          const targetStat = this._stats.byStore[targetName];
          if (targetStat) targetStat.errors++;
          debug('MemorySyncCoordinator', 'syncItemsToTargets', targetName, err && err.message ? err.message : String(err));
        }
      }
    }
    return { synced, errors, conflicts };
  }

  /**
   * 同步所有已注册存储的数据。遍历每个存储读取数据并写入其他存储。
   * @param {Object} [options] - 同步选项
   * @param {Object} [options.filter] - 数据过滤条件
   * @returns {Promise<{synced: number, conflicts: number, errors: number}>} 同步结果统计
   */
  async syncAll(options) {
    this.guardShutdown();
    const opts = options ?? {};
    let synced = 0;
    let conflicts = 0;
    let errors = 0;

    for (const [storeName, store] of this._stores) {
      if (!store.enabled) continue;
      const storeStat = this._stats.byStore[storeName];
      try {
        const data = await Promise.resolve(store.syncFn(opts.filter ?? {}));
        const items = ensureArray(data);
        if (storeStat) storeStat.syncs++;
        const result = await this._syncItemsToTargets(storeName, items);
        synced += result.synced;
        errors += result.errors;
        conflicts += result.conflicts;
      } catch (err) {
        errors++;
        if (storeStat) storeStat.errors++;
        debug('MemorySyncCoordinator', 'syncAll_read', storeName, err && err.message ? err.message : String(err));
      }
    }

    this._stats.totalSyncs++;
    this._stats.itemsSynced += synced;
    this._stats.errors += errors;
    this._stats.conflictsResolved += conflicts;
    this.emit('sync-completed', { synced, conflicts, errors });
    return { synced, conflicts, errors };
  }

  /**
   * 从指定源存储同步数据到其他存储。
   * @param {string} sourceName - 源存储名称
   * @param {Object|Array} data - 待同步数据（单条或数组）
   * @param {Object} [options] - 同步选项
   * @param {string} [options.conflictStrategy] - 冲突解决策略覆盖
   * @returns {Promise<{synced: number, conflicts: number, errors: number}>} 同步结果统计
   */
  async syncFromSource(sourceName, data, options) {
    this.guardShutdown();
    if (!sourceName || !data) return { synced: 0, conflicts: 0, errors: 0 };

    const opts = options ?? {};
    const strategy = opts.conflictStrategy ?? this._config.conflictStrategy;
    const items = Array.isArray(data) ? data : [data];
    const result = await this._syncItemsToTargets(sourceName, items, strategy);

    this._stats.itemsSynced += result.synced;
    this._stats.errors += result.errors;
    this._stats.conflictsResolved += result.conflicts;
    return result;
  }

  _mergeByConfidence(existingData, newData) {
    const existingConf = Number.isFinite(existingData.confidence) ? existingData.confidence : 0;
    const newConf = Number.isFinite(newData.confidence) ? newData.confidence : 0;
    const merged = {};
    const allKeys = new Set([...Object.keys(existingData ?? {}), ...Object.keys(newData ?? {})]);
    for (const key of allKeys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      merged[key] = newData[key] !== undefined ? newData[key] : existingData[key];
    }
    merged.confidence = Math.max(existingConf, newConf);
    const existingTags = Array.isArray(existingData.tags) ? existingData.tags : [];
    const newTags = Array.isArray(newData.tags) ? newData.tags : [];
    merged.tags = [...new Set([...existingTags, ...newTags])];
    return merged;
  }

  _resolveConflict(existingData, newData, strategy) {
    if (!existingData) return newData;
    if (!newData) return existingData;

    switch (strategy) {
      case CONFLICT_STRATEGIES.LATEST_WINS: {
        const existingTs = existingData.timestamp ?? 0;
        const newTs = newData.timestamp ?? 0;
        return newTs >= existingTs ? newData : existingData;
      }
      case CONFLICT_STRATEGIES.CONFIDENCE_MERGE:
        return this._mergeByConfidence(existingData, newData);
      case CONFLICT_STRATEGIES.SOURCE_PRIORITY: {
        const existingStore = this._stores.get(existingData.source);
        const newStore = this._stores.get(newData.source);
        const existingPriority = existingStore ? existingStore.priority : 0;
        const newPriority = newStore ? newStore.priority : 0;
        return newPriority >= existingPriority ? newData : existingData;
      }
      default:
        return newData;
    }
  }

  /**
   * 启动周期性同步定时器。
   */
  startPeriodicSync() {
    this.guardShutdown();
    if (this._syncTimer) return;
    const interval = typeof this._config.syncIntervalMs === 'number' && Number.isFinite(this._config.syncIntervalMs) ? this._config.syncIntervalMs : 60000;
    this._syncTimer = setInterval(() => {
      if (this._shutDown) return;
      Promise.resolve(this.syncAll()).catch(function(err) { debug('MemorySyncCoordinator', 'periodicSyncError', err && err.message ? err.message : String(err)); });
    }, interval);
    if (this._syncTimer && typeof this._syncTimer.unref === 'function') {
      this._syncTimer.unref();
    }
    this.emit('periodic-sync-started');
  }

  /**
   * 停止周期性同步定时器。
   */
  stopPeriodicSync() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    this.emit('periodic-sync-stopped');
  }

  async _processSyncQueue() {
    if (this._shutDown || this._processingQueue) return;
    this._processingQueue = true;
    try {
      const items = this._syncQueue.toArray();
      this._syncQueue.clear();
      let processed = 0;
      for (const item of items) {
        if (this._shutDown) break;
        if (processed >= this._config.batchSize) {
          this._syncQueue.push(item);
          continue;
        }
        await this._syncItem(item);
        processed++;
      }
      this._stats.totalSyncs += processed;
    } finally {
      this._processingQueue = false;
    }
  }

  async _syncItem(item) {
    try {
      const targetStores = item.targetStores && item.targetStores.length > 0
        ? item.targetStores
        : [...this._stores.keys()].filter(n => n !== item.source);
      for (const targetName of targetStores) {
        const targetStore = this._stores.get(targetName);
        if (!targetStore || !targetStore.enabled) continue;
        try {
          const resolved = await this._writeToTarget(targetStore, item.data, this._config.conflictStrategy);
          const writeResult = await Promise.resolve(targetStore.writeFn(resolved));
          if (writeResult != null) {
            this._stats.itemsSynced++;
            const targetStat = this._stats.byStore[targetName];
            if (targetStat) targetStat.items++;
            if (resolved !== item.data) this._stats.conflictsResolved++;
          }
        } catch (err) {
          this._stats.errors++;
          const targetStat = this._stats.byStore[targetName];
          if (targetStat) targetStat.errors++;
          debug('MemorySyncCoordinator', '_syncItem_write', targetName, err && err.message ? err.message : String(err));
        }
      }
    } catch (err) {
      this._stats.errors++;
      debug('MemorySyncCoordinator', '_syncItem', err && err.message ? err.message : String(err));
    }
  }

  /**
   * 获取统计信息。
   * @returns {{totalSyncs: number, conflictsResolved: number, itemsSynced: number, errors: number, byStore: Object, queueSize: number}} 统计数据
   */
  getStats() {
    return {
      totalSyncs: this._stats.totalSyncs,
      conflictsResolved: this._stats.conflictsResolved,
      itemsSynced: this._stats.itemsSynced,
      errors: this._stats.errors,
      byStore: safeAssign({}, this._stats.byStore),
      queueSize: this._syncQueue.length,
    };
  }

  isHealthy() {
    return !this._shutDown && this._stores.size > 0;
  }

  /**
   * 检查是否有已注册的存储
   * @returns {boolean} 是否有存储
   */
  hasStores() {
    return this._stores.size > 0;
  }

  _onShutdown() {
    this.stopPeriodicSync();
    if (this._syncQueue.length > 0) {
      const items = this._syncQueue.toArray();
      for (const item of items) {
        const targetStores = item.targetStores && item.targetStores.length > 0
          ? item.targetStores
          : [...this._stores.keys()].filter(n => n !== item.source);
        for (const targetName of targetStores) {
          const targetStore = this._stores.get(targetName);
          if (!targetStore || !targetStore.enabled) continue;
          if (targetStore.instance && typeof targetStore.instance._shutDown !== 'undefined' && targetStore.instance._shutDown) continue;
          if (targetStore.instance && typeof targetStore.instance.isHealthy === 'function' && !targetStore.instance.isHealthy()) continue;
          try {
            const writeResult = targetStore.writeFn(item.data);
            if (writeResult && typeof writeResult.then === 'function') {
              writeResult.catch(function(e) { debug('MemorySyncCoordinator', 'onShutdown_flushQueue', targetName, e && e.message ? e.message : String(e)); });
            }
          } catch (_e) {
            debug('MemorySyncCoordinator', 'onShutdown_flushQueue', targetName, _e && _e.message ? _e.message : String(_e));
          }
        }
      }
    }
    this._stores.clear();
    safeCall(() => this._syncQueue.shutdown(), 'MemorySyncCoordinator', 'shutdown-syncQueue');
    this._processingQueue = false;
    this._stats = { totalSyncs: 0, conflictsResolved: 0, itemsSynced: 0, errors: 0, byStore: {} };
    this.removeAllListeners();
  }
}

MemorySyncCoordinator.SYNC_POLICIES = SYNC_POLICIES;
MemorySyncCoordinator.CONFLICT_STRATEGIES = CONFLICT_STRATEGIES;
MemorySyncCoordinator.DEFAULT_SYNC_CONFIG = DEFAULT_SYNC_CONFIG;

module.exports = withShutdown(MemorySyncCoordinator);
