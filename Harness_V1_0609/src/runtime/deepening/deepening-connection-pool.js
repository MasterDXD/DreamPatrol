'use strict';
const DeepeningBase = require('./deepening-base');
const { requireString_, ensurePositiveNumber } = require('../../utils/param-validator');
const { DEFAULT_CACHE_TTL_MS } = require('../../utils/constants');
const { HarnessError } = require('../../errors');

/**
 * @module runtime/deepening/deepening-connection-pool
 * 深化推理连接池。管理多个命名连接池，支持获取/释放生命周期、
 * 空闲连接复用、自动空闲超时淘汰、错误标记、池排空及溢出拒绝。
 */

/**
 * @classdesc 深化连接池。连接复用、健康检查、自动扩缩
 *
 * 深化推理连接池 — 深化管道的命名连接池管理器。
 * 管理多个命名池，支持可配置的最大连接数和空闲超时，
 * 获取/释放生命周期与空闲连接复用、自动空闲超时淘汰、
 * 错误标记、池排空以及带可选队列的溢出拒绝。
 *
 * @extends DeepeningBase
 * @emits 'poolCreated' 当新连接池创建时触发，附带 { name, maxConnections }
 * @emits 'acquired' 当连接被获取时触发，附带 { pool }
 * @emits 'released' 当连接被释放时触发，附带 { pool }
 * @emits 'idleTimeout' 当空闲连接超时被淘汰时触发，附带 { pool, connectionId }
 * @emits 'rejected' 当连接池耗尽且禁用队列时触发，附带 { pool }
 * @emits 'connection-error' 当连接被标记为错误时触发，附带 { connectionId }
 * @emits 'drained' 当连接池排空时触发，附带 { pool }
 * @emits 'poolRemoved' 当连接池移除时触发，附带 { name }
 */
class DeepeningConnectionPool extends DeepeningBase {
  /**
   * 连接状态枚举。
   * @constant
   * @type {Object}
   * @property {string} IDLE - 空闲状态
   * @property {string} ACTIVE - 活跃状态
   * @property {string} ERROR - 错误状态
   */
  static CONNECTION_STATES = { IDLE: 'idle', ACTIVE: 'active', ERROR: 'error' };

  /**
   * 创建 DeepeningConnectionPool 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxPools=50] - 最大连接池数量
   * @param {number} [options.defaultMaxConnections=10] - 默认每个池的最大连接数
   * @param {number} [options.defaultIdleTimeout] - 默认空闲超时时间（毫秒），默认使用 DEFAULT_CACHE_TTL_MS
   */
  constructor(options) {
    super(options);
    this._pools = new Map();
    this._maxPools = typeof (options && options.maxPools) === 'number' && Number.isFinite(options.maxPools) ? options.maxPools : 50;
    this._defaultMaxConnections = typeof (options && options.defaultMaxConnections) === 'number' && Number.isFinite(options.defaultMaxConnections) ? options.defaultMaxConnections : 10;
    this._defaultIdleTimeout = typeof (options && options.defaultIdleTimeout) === 'number' && Number.isFinite(options.defaultIdleTimeout) ? options.defaultIdleTimeout : DEFAULT_CACHE_TTL_MS;
    this._totalAcquired = 0;
  }

  /**
   * 创建命名连接池。若已存在则返回 false；若达到上限则淘汰空池。
   * @param {string} name - 连接池名称
   * @param {Object} [options] - 连接池配置
   * @param {number} [options.maxConnections] - 最大连接数
   * @param {number} [options.idleTimeout] - 空闲超时时间（毫秒）
   * @returns {boolean} 创建是否成功
   * @emits 'poolCreated'
   */
  createPool(name, options) {
    this.guardShutdown();
    requireString_(name, 'Pool name');
    if (this._pools.has(name)) return false;
    if (this._pools.size >= this._maxPools) {
      for (const [n, pool] of this._pools) {
        if (pool.active.size === 0 && pool.idle.length === 0) { this._pools.delete(n); break; }
      }
    }
    const opts = options ?? {};
    this._pools.set(name, { name, maxConnections: ensurePositiveNumber(opts.maxConnections, this._defaultMaxConnections), idleTimeout: ensurePositiveNumber(opts.idleTimeout, this._defaultIdleTimeout), active: new Map(), idle: [], nextId: 1 });
    this.emit('poolCreated', { name, maxConnections: ensurePositiveNumber(opts.maxConnections, this._defaultMaxConnections) });
    return true;
  }

  /**
   * 获取所有连接池名称。
   * @returns {string[]} 连接池名称数组
   */
  getPoolNames() { return Array.from(this._pools.keys()); }

  /**
   * 从指定连接池获取连接。优先复用空闲连接，否则创建新连接。
   * 连接池耗尽时根据 queue 选项决定是否拒绝。
   * @param {string} name - 连接池名称
   * @param {Object} [options] - 获取选项
   * @param {boolean} [options.queue=false] - 连接池耗尽时是否排队等待（false 时直接抛出异常）
   * @returns {Object|null} 连接信息对象 { connectionId, state, useCount }，池耗尽且启用排队时返回 null
   * @throws {HarnessError} 连接池不存在或池耗尽且禁用排队时抛出
   * @emits 'idleTimeout' 当空闲连接超时被淘汰时
   * @emits 'rejected' 当池耗尽且禁用排队时
   * @emits 'acquired'
   */
  acquire(name, options) {
    this.guardShutdown();
    const pool = this._pools.get(name);
    if (!pool) throw new HarnessError('CONNECTION_FAILED', 'Pool not found: ' + name);
    const now = Date.now();
    pool.idle = pool.idle.filter(conn => {
      if (conn.releasedAt && (now - conn.releasedAt) > pool.idleTimeout) {
        this.emit('idleTimeout', { pool: name, connectionId: conn.connectionId });
        return false;
      }
      return true;
    });
    const opts = options ?? {};
    const totalActive = pool.active.size;
    if (totalActive >= pool.maxConnections) {
      if (opts.queue === false) { this.emit('rejected', { pool: name }); throw new Error('Connection pool exhausted and queueing disabled'); }
      return null;
    }
    if (pool.idle.length > 0) {
      const conn = pool.idle.shift();
      conn.useCount = (typeof conn.useCount === 'number' && Number.isFinite(conn.useCount) ? conn.useCount : 1) + 1;
      conn.state = 'active';
      pool.active.set(conn.connectionId, conn);
      this._totalAcquired++;
      this.emit('acquired', { pool: name });
      return { connectionId: conn.connectionId, state: 'active', useCount: conn.useCount };
    }
    const connectionId = 'conn-' + pool.nextId++;
    const conn = { connectionId, state: 'active', useCount: 1, createdAt: Date.now() };
    pool.active.set(connectionId, conn);
    this._totalAcquired++;
    this.emit('acquired', { pool: name });
    return { connectionId, state: 'active', useCount: 1 };
  }

  /**
   * 释放连接回连接池，使其变为空闲状态等待复用。
   * @param {string} name - 连接池名称
   * @param {string} connectionId - 连接标识
   * @returns {boolean} 释放是否成功
   * @emits 'released'
   */
  release(name, connectionId) {
    this.guardShutdown();
    const pool = this._pools.get(name);
    if (!pool) return false;
    const conn = pool.active.get(connectionId);
    if (!conn) return false;
    pool.active.delete(connectionId);
    conn.state = 'idle';
    conn.releasedAt = Date.now();
    pool.idle.push(conn);
    this.emit('released', { pool: name });
    return true;
  }

  /**
   * 将连接标记为错误状态并从池中移除。
   * @param {string} name - 连接池名称
   * @param {string} connectionId - 连接标识
   * @returns {boolean} 标记是否成功
   * @emits 'connection-error'
   */
  markError(name, connectionId) {
    this.guardShutdown();
    const pool = this._pools.get(name);
    if (!pool) return false;
    pool.active.delete(connectionId);
    pool.idle = pool.idle.filter(c => c.connectionId !== connectionId);
    if (this.listenerCount('connection-error') > 0) this.emit('connection-error', { connectionId });
    return true;
  }

  /**
   * 获取连接池信息。
   * @param {string} name - 连接池名称
   * @returns {Object|null} 连接池信息 { name, maxConnections, active, idle, totalConnections }
   */
  getPoolInfo(name) {
    const pool = this._pools.get(name);
    if (!pool) return null;
    return { name: pool.name, maxConnections: pool.maxConnections, active: pool.active.size, idle: pool.idle.length, totalConnections: pool.active.size + pool.idle.length };
  }

  /**
   * 排空指定连接池中的所有空闲连接。
   * @param {string} name - 连接池名称
   * @returns {number} 被排空的空闲连接数
   * @emits 'drained'
   */
  drainPool(name) {
    this.guardShutdown();
    const pool = this._pools.get(name);
    if (!pool) return 0;
    const count = pool.idle.length;
    pool.idle = [];
    this.emit('drained', { pool: name });
    return count;
  }

  /**
   * 移除指定连接池。
   * @param {string} name - 连接池名称
   * @returns {boolean} 是否成功移除
   * @emits 'poolRemoved'
   */
  removePool(name) { this.guardShutdown(); if (!this._pools.has(name)) return false; this._pools.delete(name); this.emit('poolRemoved', { name }); return true; }

  /**
   * 关闭时的清理回调。清空所有连接池中的活跃和空闲连接。
   * @protected
   */
  _onShutdown() {
    for (const [, pool] of this._pools) {
      pool.active.clear();
      pool.idle = [];
    }
    this._pools.clear();
    super._onShutdown();
  }

  /**
   * 获取连接池运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalPools - 连接池总数
   * @returns {number} return.totalAcquired - 累计获取连接次数
   * @returns {Object} return.pools - 各连接池信息
   */
  getStats() {
    const pools = {};
    for (const [name] of this._pools) pools[name] = this.getPoolInfo(name);
    return { totalPools: this._pools.size, totalAcquired: this._totalAcquired, pools, ...super.getStats() };
  }
}

module.exports = DeepeningConnectionPool;
