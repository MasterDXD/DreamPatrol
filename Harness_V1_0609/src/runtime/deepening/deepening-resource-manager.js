'use strict';
const DeepeningBase = require('./deepening-base');
const safeAssign = require('../../utils/safe-assign');
const { counterId, ID_PREFIXES } = require('../../utils/unique-id');
const { requireString_ } = require('../../utils/param-validator');
const { HarnessError, DeepeningError } = require('../../errors');

/**
 * @constant {number} MAX_ALLOCATIONS - 最大分配记录数
 */
const MAX_ALLOCATIONS = 200;
const MAX_ALLOC_MAP_SIZE = 500;
const MAX_WAITING_PER_POOL = 200;

/**
 * @module runtime/deepening/deepening-resource-manager
 * 资源池与分配管理器。提供命名资源池的工厂/验证/销毁生命周期管理、
 * 带等待队列和可配置超时的获取/释放、基于容量的分配与释放追踪、
 * 资源预留，以及内存、CPU、Token和并发槽的利用率指标。
 */

/**
 * 资源池与分配管理器 — 为深化子系统提供资源池化与容量分配能力。
 * 提供命名资源池的工厂/验证/销毁生命周期管理、带等待队列和可配置超时的获取/释放、
 * 基于容量的分配与释放追踪、资源预留，以及内存、CPU、Token和并发槽的利用率指标。
 *
 * @classdesc 深化资源管理器。资源分配、配额管理、回收。
 * @extends DeepeningBase
 * @emits 'poolCreated' 当资源池创建时触发，附带 {name, maxSize, minSize}
 * @emits 'poolRemoved' 当资源池移除时触发，附带 {name}
 * @emits 'acquired' 当资源获取时触发，附带 {pool, resource}
 * @emits 'released' 当资源释放时触发，附带 {pool, resource}
 * @emits 'destroyed' 当资源销毁时触发，附带 {pool, resource}
 * @emits 'drained' 当资源池排空时触发，附带 {name}
 * @emits 'resource-allocated' 当资源分配时触发，附带 {pool?, resource?, resource?, amount?, allocId?}
 * @emits 'resource-released' 当资源分配释放时触发，附带 {allocId, resource, amount}
 * @emits 'resource-reserved' 当资源预留时触发，附带 {resource, amount}
 * @emits 'resource-unreserved' 当资源取消预留时触发，附带 {resource, amount}
 */
class DeepeningResourceManager extends DeepeningBase {

  /**
   * 创建 DeepeningResourceManager 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.memoryCapacity] - 内存资源总容量（字节）
   * @param {number} [options.cpuCapacity] - CPU资源总容量（百分比）
   * @param {number} [options.tokenCapacity] - Token资源总容量
   * @param {number} [options.concurrentCapacity] - 并发槽总容量
   */
  constructor(options) {
    super(options);
    this._pools = new Map();
    this._maxPools = 50;
    this._resources = new Map();
    this._maxResources = 500;
    this._allocations = [];
    this._reservations = new Map();
    this._maxReservations = 1000;
    this._allocMap = new Map();
    this._allocatedByResource = new Map();
    this._totalAcquired = 0;
    this._totalAllocations = 0;
    this._activeAllocations = 0;
    if (options) {
      if (options.memoryCapacity != null) this.registerResource('memory', { totalCapacity: options.memoryCapacity, unit: 'bytes' });
      if (options.cpuCapacity != null) this.registerResource('cpu', { totalCapacity: options.cpuCapacity, unit: 'percent' });
      if (options.tokenCapacity != null) this.registerResource('tokens', { totalCapacity: options.tokenCapacity, unit: 'tokens' });
      if (options.concurrentCapacity != null) this.registerResource('concurrent', { totalCapacity: options.concurrentCapacity, unit: 'slots' });
    }
  }

  /**
   * 创建命名资源池。
   * @param {string} name - 池名称
   * @param {Object} [options] - 池配置选项
   * @param {number} [options.maxSize=10] - 池最大资源数
   * @param {number} [options.minSize=0] - 池最小资源数（预创建）
   * @param {Function} [options.factory] - 资源工厂函数
   * @param {Function} [options.validate] - 资源验证函数
   * @param {Function} [options.destroy] - 资源销毁函数
   * @param {number} [options.acquireTimeout=0] - 获取超时时间（毫秒），0表示不超时
   * @returns {boolean} 创建成功返回 true，池已存在返回 false
   * @emits 'poolCreated' 池创建成功时触发，附带 {name, maxSize, minSize}
   */
  createPool(name, options) {
    this.guardShutdown();
    requireString_(name, 'Pool name');
    if (this._pools.has(name)) return false;
    if (this._pools.size >= this._maxPools) {
      const oldest = this._pools.keys().next().value;
      this._pools.delete(oldest);
    }
    const opts = options ?? {};
    const pool = {
      name,
      maxSize: opts.maxSize ?? 10,
      minSize: opts.minSize ?? 0,
      factory: opts.factory ?? null,
      validate: opts.validate ?? null,
      destroy: opts.destroy ?? null,
      acquireTimeout: opts.acquireTimeout ?? 0,
      inUse: new Map(),
      available: [],
      waiting: [],
      totalCreated: 0,
      totalAcquired: 0,
      totalReleased: 0,
      totalDestroyed: 0,
      totalValidationFailures: 0,
    };
    for (let i = 0; i < pool.minSize; i++) {
      const resource = pool.factory ? pool.factory() : {};
      if (resource == null) continue;
      pool.available.push(resource);
      pool.totalCreated++;
    }
    this._pools.set(name, pool);
    this.emit('poolCreated', { name, maxSize: pool.maxSize, minSize: pool.minSize });
    return true;
  }

  /**
   * 移除命名资源池。
   * @param {string} name - 池名称
   * @returns {boolean} 移除成功返回 true，池不存在返回 false
   * @emits 'poolRemoved' 池移除时触发，附带 {name}
   */
  removePool(name) {
    this.guardShutdown();
    if (!this._pools.has(name)) return false;
    this._pools.delete(name);
    this.emit('poolRemoved', { name });
    return true;
  }

  /**
   * 获取所有资源池名称。
   * @returns {Array<string>} 池名称数组
   */
  getPoolNames() { return Array.from(this._pools.keys()); }

  /**
   * 获取指定资源池的信息摘要。
   * @param {string} name - 池名称
   * @returns {Object|null} 池信息 {name, maxSize, minSize, inUse, available, totalCreated, totalAcquired, totalReleased, totalDestroyed, totalValidationFailures}，池不存在返回 null
   */
  getPoolInfo(name) {
    const pool = this._pools.get(name);
    if (!pool) return null;
    return {
      name: pool.name,
      maxSize: pool.maxSize,
      minSize: pool.minSize,
      inUse: pool.inUse.size,
      available: pool.available.length,
      totalCreated: pool.totalCreated,
      totalAcquired: pool.totalAcquired,
      totalReleased: pool.totalReleased,
      totalDestroyed: pool.totalDestroyed,
      totalValidationFailures: pool.totalValidationFailures,
    };
  }

  /**
   * 从指定池获取资源。池满时进入等待队列，超时后拒绝。
   * @param {string} name - 池名称
   * @returns {Promise<Object>} 资源对象
   * @throws {DeepeningError} 当池不存在时抛出 RESOURCE_NOT_FOUND 异常
   * @throws {DeepeningError} 当获取超时时抛出 TIMEOUT 异常
   * @emits 'acquired' 资源获取成功时触发，附带 {pool, resource}
   * @emits 'resource-allocated' 资源分配时触发，附带 {pool, resource}
   */
  acquire(name) {
    this.guardShutdown();
    const pool = this._pools.get(name);
    if (!pool) return Promise.reject(new DeepeningError('RESOURCE_NOT_FOUND', 'Pool not found: ' + name));
    if (pool.available.length > 0) {
      let resource = pool.available.shift();
      if (pool.validate) {
        if (!pool.validate(resource)) {
          pool.totalValidationFailures++;
          if (pool.destroy) pool.destroy(resource);
          pool.totalDestroyed++;
          resource = pool.factory ? pool.factory() : {};
          pool.totalCreated++;
        }
      }
      pool.inUse.set(resource, true);
      pool.totalAcquired++;
      this._totalAcquired++;
      this.emit('acquired', { pool: name, resource });
      this.emit('resource-allocated', { pool: name, resource });
      return Promise.resolve(resource);
    }
    if (pool.inUse.size < pool.maxSize) {
      const resource = pool.factory ? pool.factory() : {};
      pool.totalCreated++;
      pool.inUse.set(resource, true);
      pool.totalAcquired++;
      this._totalAcquired++;
      this.emit('acquired', { pool: name, resource });
      this.emit('resource-allocated', { pool: name, resource });
      return Promise.resolve(resource);
    }
    if (pool.inUse.size >= pool.maxSize) {
      if (pool.waiting.length >= MAX_WAITING_PER_POOL) {
        return Promise.reject(new DeepeningError('POOL_FULL', 'Pool ' + name + ' waiting queue full'));
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = pool.acquireTimeout > 0 ? setTimeout(() => {
          if (settled) return;
          settled = true;
          const idx = pool.waiting.indexOf(waiter);
          if (idx >= 0) pool.waiting.splice(idx, 1);
          reject(new DeepeningError('TIMEOUT', 'Acquire timeout for pool: ' + name));
        }, pool.acquireTimeout) : null;
        if (timer && typeof timer.unref === 'function') timer.unref();
        const waiter = {
          resolve: (val) => { if (!settled) { settled = true; resolve(val); } },
          reject: (err) => { if (!settled) { settled = true; reject(err); } },
          timer,
        };
        pool.waiting.push(waiter);
      });
    }
  }

  /**
   * 释放资源到指定池。若有等待者则直接转交。
   * @param {string} name - 池名称或分配ID（以'alloc-'开头时调用 releaseAlloc）
   * @param {Object} [resource] - 要释放的资源对象
   * @returns {boolean} 释放成功返回 true，池或资源不存在返回 false
   * @emits 'released' 资源释放时触发，附带 {pool, resource}
   */
  release(name, resource) {
    this.guardShutdown();
    if (typeof name === 'string' && name.startsWith('alloc-')) {
      return this.releaseAlloc(name);
    }
    const pool = this._pools.get(name);
    if (!pool) return false;
    if (!pool.inUse.has(resource)) return false;
    pool.inUse.delete(resource);
    pool.totalReleased++;
    if (pool.waiting.length > 0) {
      const waiter = pool.waiting.shift();
      if (this._shutDown) { waiter.reject(new Error('Pool shutting down')); return true; }
      clearTimeout(waiter.timer);
      pool.inUse.set(resource, true);
      pool.totalAcquired++;
      this._totalAcquired++;
      this.emit('acquired', { pool: name, resource });
      waiter.resolve(resource);
    } else {
      pool.available.push(resource);
    }
    this.emit('released', { pool: name, resource });
    return true;
  }

  /**
   * 销毁指定池中的资源实例。
   * @param {string} name - 池名称
   * @param {Object} resource - 要销毁的资源对象
   * @returns {boolean} 销毁成功返回 true
   * @emits 'destroyed' 资源销毁时触发，附带 {pool, resource}
   */
  destroy(name, resource) {
    const pool = this._pools.get(name);
    if (!pool) return false;
    pool.inUse.delete(resource);
    const availIdx = pool.available.indexOf(resource);
    if (availIdx >= 0) pool.available.splice(availIdx, 1);
    if (pool.destroy) pool.destroy(resource);
    pool.totalDestroyed++;
    this.emit('destroyed', { pool: name, resource });
    return true;
  }

  /**
   * 排空指定池中的可用资源（不销毁）。
   * @param {string} name - 池名称
   * @returns {boolean} 排空成功返回 true
   * @emits 'drained' 池排空时触发，附带 {name}
   */
  drainPool(name) {
    const pool = this._pools.get(name);
    if (pool) pool.available = [];
    this.emit('drained', { name });
    return true;
  }

  /**
   * 分配指定资源的容量。容量不足时抛出异常。
   * @param {string} resource - 资源名称
   * @param {number} amount - 分配数量
   * @returns {string} 分配ID
   * @throws {HarnessError} 当资源容量不足时抛出 RESOURCE_EXHAUSTED 异常
   * @emits 'resource-allocated' 资源分配时触发，附带 {resource, amount, allocId}
   */
  allocate(resource, amount) {
    this.guardShutdown();
    const config = this._resources.get(resource);
    if (config && config.totalCapacity !== undefined) {
      const available = this.getAvailable(resource);
      if (amount > available) throw new HarnessError('RESOURCE_EXHAUSTED', 'Insufficient ' + resource + ': available=' + available + ', requested=' + amount);
    }
    const allocId = counterId(ID_PREFIXES.DEEPENING_ALLOC);
    const entry = { id: allocId, resource: resource, amount: amount, time: Date.now(), released: false };
    this._allocations.push(entry);
    if (this._allocations.length > MAX_ALLOCATIONS) {
      this._allocations.splice(0, this._allocations.length - MAX_ALLOCATIONS);
    }
    this._allocMap.set(allocId, entry);
    if (this._allocMap.size > MAX_ALLOC_MAP_SIZE) {
      const released = [];
      for (const [key, val] of this._allocMap) {
        if (val.released) released.push(key);
        if (this._allocMap.size - released.length <= MAX_ALLOC_MAP_SIZE * 0.8) break;
      }
      for (const key of released) this._allocMap.delete(key);
    }
    this._totalAllocations++;
    this._activeAllocations++;
    const currentAlloc = this._allocatedByResource.get(resource) ?? 0;
    this._allocatedByResource.set(resource, currentAlloc + amount);
    this.emit('resource-allocated', { resource: resource, amount: amount, allocId: allocId });
    return allocId;
  }

  /**
   * 释放指定分配ID的资源容量。
   * @param {string} allocId - 分配ID
   * @returns {boolean} 释放成功返回 true，分配不存在返回 false
   * @emits 'resource-released' 资源分配释放时触发，附带 {allocId, resource, amount}
   */
  releaseAlloc(allocId) {
    const entry = this._allocMap.get(allocId);
    if (!entry) return false;
    if (entry.released) return false;
    entry.released = true;
    this._allocMap.delete(allocId);
    this._activeAllocations--;
    const currentAlloc = this._allocatedByResource.get(entry.resource) ?? 0;
    this._allocatedByResource.set(entry.resource, Math.max(0, currentAlloc - entry.amount));
    this._allocations.push({ id: 'release-' + allocId, resource: entry.resource, amount: -entry.amount, time: Date.now(), released: true, releaseOf: allocId });
    if (this._allocations.length > MAX_ALLOCATIONS) {
      this._allocations.splice(0, this._allocations.length - MAX_ALLOCATIONS);
    }
    this.emit('resource-released', { allocId: allocId, resource: entry.resource, amount: entry.amount });
    return true;
  }

  /**
   * 获取指定资源的可用容量。
   * @param {string} resource - 资源名称
   * @returns {number} 可用容量（未注册资源默认返回100）
   */
  getAvailable(resource) {
    const config = this._resources.get(resource);
    if (!config || config.totalCapacity === undefined) return 100;
    const reserved = this._reservations.get(resource) ?? 0;
    const allocated = this._allocatedByResource.get(resource) ?? 0;
    return Math.max(0, config.totalCapacity - reserved - allocated);
  }

  /**
   * 获取指定资源的利用率。
   * @param {string} resource - 资源名称
   * @returns {number} 利用率（0到1之间），未注册资源返回0
   */
  getUtilization(resource) {
    const config = this._resources.get(resource);
    if (!config || config.totalCapacity === undefined) return 0;
    const allocated = this._allocatedByResource.get(resource) ?? 0;
    return config.totalCapacity > 0 ? allocated / config.totalCapacity : 0;
  }

  /**
   * 预留指定资源的容量。
   * @param {string} resource - 资源名称
   * @param {number} amount - 预留数量
   * @returns {boolean} 预留成功返回 true
   * @emits 'resource-reserved' 资源预留时触发，附带 {resource, amount}
   */
  reserve(resource, amount) {
    this.guardShutdown();
    if (this._reservations.size >= this._maxReservations && !this._reservations.has(resource)) {
      const oldest = this._reservations.keys().next().value;
      this._reservations.delete(oldest);
    }
    const current = this._reservations.get(resource) ?? 0;
    const resInfo = this._resources.get(resource);
    if (resInfo && typeof resInfo.totalCapacity === 'number' && current + amount > resInfo.totalCapacity) return false;
    this._reservations.set(resource, current + amount);
    this.emit('resource-reserved', { resource: resource, amount: amount });
    return true;
  }

  /**
   * 取消预留指定资源的容量。
   * @param {string} resource - 资源名称
   * @param {number} amount - 取消预留数量
   * @returns {boolean} 取消成功返回 true
   * @emits 'resource-unreserved' 资源取消预留时触发，附带 {resource, amount}
   */
  unreserve(resource, amount) {
    this.guardShutdown();
    const current = this._reservations.get(resource) ?? 0;
    this._reservations.set(resource, Math.max(0, current - amount));
    this.emit('resource-unreserved', { resource: resource, amount: amount });
    return true;
  }

  /**
   * 注册命名资源及其容量配置。
   * @param {string} name - 资源名称
   * @param {Object} [config] - 资源配置
   * @param {number} [config.totalCapacity=100] - 总容量
   * @returns {boolean} 注册成功返回 true
   */
  registerResource(name, config) {
    this.guardShutdown();
    const cfg = config ?? {};
    if (cfg.totalCapacity === undefined) cfg.totalCapacity = 100;
    if (this._resources.size >= this._maxResources && !this._resources.has(name)) {
      const oldest = this._resources.keys().next().value;
      this._resources.delete(oldest);
    }
    this._resources.set(name, cfg);
    return true;
  }

  /**
   * 获取指定资源的配置信息。
   * @param {string} name - 资源名称
   * @returns {Object|null} 资源配置副本，资源不存在返回 null
   */
  getResourceInfo(name) {
    const info = this._resources.get(name);
    if (!info) return null;
    return safeAssign({}, info);
  }

  /**
   * 获取分配历史记录。
   * @param {Object} [_filter] - 过滤条件（保留参数）
   * @returns {Array<Object>} 分配记录数组副本
   */
  getAllocationHistory(_filter) { return this._allocations.map(a => ({ ...a })); }

  /**
   * 关闭时的清理回调。拒绝所有等待者，清空池、资源和分配数据。
   * @protected
   */
  _onShutdown() {
    for (const [, pool] of this._pools) {
      for (const waiter of pool.waiting) {
        clearTimeout(waiter.timer);
        waiter.reject(new DeepeningError('SHUTDOWN', 'Pool shutting down'));
      }
      pool.waiting = [];
      pool.inUse.clear();
      pool.available = [];
    }
    this._pools.clear();
    this._resources.clear();
    this._allocations = [];
    this._reservations.clear();
    this._allocMap.clear();
    this._allocatedByResource.clear();
    super._onShutdown();
  }

  /**
   * 获取资源管理器的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalPools - 资源池总数
   * @returns {number} return.totalResources - 已注册资源数
   * @returns {number} return.totalAllocations - 累计分配次数
   * @returns {number} return.activeAllocations - 活跃分配数
   * @returns {number} return.totalReservations - 预留资源数
   * @returns {number} return.totalAcquired - 累计获取次数
   */
  getStats() {
    return {
      ...super.getStats(),
      totalPools: this._pools.size,
      totalResources: this._resources.size,
      totalAllocations: this._totalAllocations,
      activeAllocations: this._activeAllocations,
      totalReservations: this._reservations.size,
      totalAcquired: this._totalAcquired,
    };
  }
}

module.exports = DeepeningResourceManager;
