/**
 * @module runtime/infrastructure/shared-infrastructure
 * @description 共享基础设施模块，提供连接池、负载均衡、服务注册和特性标志四大核心基础设施组件。
 * 这些组件为运行时引擎提供底层支撑能力，包括连接资源管理、流量分发、服务发现与注册、
 * 以及功能开关控制。所有类均通过 withShutdown 混入支持优雅关闭。
 */
'use strict';

const { isBlockedHost } = require('../../utils/network-utils');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { sanitizeObject } = require('../../utils/sanitizer');
const RingBuffer = require('../../utils/ring-buffer');

/** @constant {number} 连接池默认最大连接数 */
const DEFAULT_MAX_CONNECTIONS = 10;
/** @constant {number} 负载均衡器默认最大服务数 */
const DEFAULT_LB_MAX_SERVICES = 100;
/** @constant {number} 服务注册中心默认最大服务数 */
const DEFAULT_REGISTRY_MAX_SERVICES = 200;
/** @constant {number} 特性标志默认最大变更历史记录数 */
const DEFAULT_MAX_FLAG_HISTORY = 100;
/** @constant {number} 特性标志默认最大标志数 */
const DEFAULT_MAX_FLAGS = 200;

/**
 * @classdesc 共享基础设施。连接池/负载均衡/服务注册/特性标志
 * 共享连接池，管理有限数量的连接资源，支持连接获取、释放和优雅关闭。
 * 通过 withShutdown 混入支持关闭时自动清理所有活跃连接。
 * @extends EventEmitter（通过 withShutdown 混入关闭能力）
 */
class SharedConnectionPool {
  /**
   * 创建共享连接池实例。
   * @param {Object} [options] - 连接池配置选项
   * @param {number} [options.maxConnections=10] - 最大并发连接数，必须为正整数
   * @param {Function} [options.onConnectionClose] - 连接关闭回调函数，关闭时对每个活跃连接ID调用
   */
  constructor(options) {
    const rawMax = (options && options.maxConnections);
    this._maxConnections = (typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0) ? rawMax : DEFAULT_MAX_CONNECTIONS;
    this._activeCount = 0;
    this._totalAcquired = 0;
    this._totalReleased = 0;
    this._connections = new Set();
    this._onConnectionClose = (options && typeof options.onConnectionClose === 'function') ? options.onConnectionClose : null;
  }

  /**
   * 从连接池获取一个连接。若池已关闭或连接数已满则返回错误对象。
   * @param {string} _id - 连接标识符
   * @param {Function} [factory] - 连接工厂函数，用于自定义创建连接对象；若未提供则创建默认连接对象
   * @returns {{ connection: Object|null, error: Error|null }} 连接对象与错误信息，成功时 error 为 null
   */
  acquire(_id, factory) {
    if (!this.isHealthy()) {
      const err = new Error('Connection pool is shut down');
      err.code = 'POOL_SHUTDOWN';
      return { connection: null, error: err };
    }
    if (this._activeCount >= this._maxConnections) {
      const err = new Error('Connection pool exhausted (max: ' + this._maxConnections + ')');
      err.code = 'POOL_EXHAUSTED';
      return { connection: null, error: err };
    }
    this._activeCount++;
    this._totalAcquired++;
    let conn;
    try {
      conn = factory ? factory() : { id: _id, createdAt: Date.now() };
    } catch (_err) {
      debug('SharedInfrastructure', 'acquire', _err && _err.message ? _err.message : String(_err));
      this._activeCount--;
      this._totalAcquired--;
      if (_err != null && typeof _err === 'object') _err.code = 'FACTORY_ERROR';
      return { connection: null, error: _err };
    }
    this._connections.add(_id);
    return { connection: conn, error: null };
  }

  /**
   * 释放一个连接，将其归还到连接池。减少活跃连接计数并从活跃集合中移除。
   * @param {string} _id - 要释放的连接标识符
   * @returns {boolean} 释放成功返回 true，无活跃连接可释放时返回 false
   */
  release(_id) {
    if (this._connections.has(_id)) {
      this._activeCount--;
      this._totalReleased++;
      this._connections.delete(_id);
      return true;
    }
    return false;
  }

  /**
   * 获取连接池的运行统计数据。
   * @returns {{ active: number, maxConnections: number, totalAcquired: number, totalReleased: number }}
   *   包含当前活跃连接数、最大连接数、累计获取次数和累计释放次数的统计对象
   */
  getStats() {
    return {
      active: this._activeCount,
      maxConnections: this._maxConnections,
      totalAcquired: this._totalAcquired,
      totalReleased: this._totalReleased,
    };
  }

  /**
   * 关闭时的清理回调，对所有活跃连接调用 onConnectionClose 回调，然后清空连接集合和计数器。
   * @protected
   */
  _onShutdown() {
    if (typeof this._onConnectionClose === 'function') {
      for (const id of this._connections) {
        try { this._onConnectionClose(id); } catch (_err) { debug('SharedInfrastructure', 'shutdownClose', _err && _err.message ? _err.message : String(_err)); }
      }
    }
    this._activeCount = 0;
    this._connections.clear();
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
  }
}
SharedConnectionPool = withShutdown(SharedConnectionPool);

/**
 * @classdesc 共享基础设施。连接池/负载均衡/服务注册/特性标志
 * 共享负载均衡器，支持多种负载均衡策略（轮询、随机、最少连接），
 * 并对注册的端点进行安全校验，阻止内网地址和被封锁的主机。
 * @extends EventEmitter（通过 withShutdown 混入关闭能力）
 */
class SharedLoadBalancer {
  /**
   * 创建共享负载均衡器实例。
   * @param {Object} [options] - 负载均衡器配置选项
   * @param {string} [options.strategy='round_robin'] - 负载均衡策略，可选值：'round_robin'（轮询）、'random'（随机）、'least_connections'（最少连接）
   * @param {number} [options.maxServices=100] - 最大可注册服务数量，必须为正数
   */
  constructor(options) {
    const VALID_STRATEGIES = new Set(['round_robin', 'random', 'least_connections']);
    this._strategy = (options && options.strategy && VALID_STRATEGIES.has(options.strategy)) ? options.strategy : 'round_robin';
    this._services = new Map();
    this._indices = new Map();
    this._maxServices = (typeof (options && options.maxServices) === 'number' && options.maxServices > 0) ? options.maxServices : DEFAULT_LB_MAX_SERVICES;
  }

  /**
   * 注册一个服务的端点列表。对端点进行安全校验，过滤掉内网地址、被封锁主机和不安全协议。
   * 若服务已存在则覆盖，若达到最大服务数则忽略新服务。
   * @param {string} serviceName - 服务名称，不能为空字符串
   * @param {string[]} endpoints - 端点地址数组，每个端点为字符串形式的URL或主机地址
   */
  register(serviceName, endpoints) {
    this.guardShutdown();
    if (!serviceName || typeof serviceName !== 'string') return;
    if (!Array.isArray(endpoints) || endpoints.length === 0) return;
    if (!this._services.has(serviceName) && this._services.size >= this._maxServices) return;
    const validated = endpoints.filter(function(ep) {
      if (ep == null) return false;
      if (typeof ep === 'string') {
        if (ep.includes('://')) {
          try {
            const url = new URL(ep);
            if (isBlockedHost(url.hostname)) return false;
            if (!['http:', 'https:'].includes(url.protocol)) return false;
          } catch (e) { debug('SharedInfrastructure', '_isValidEndpoint', e); return false; }
        }
        if (/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/.test(ep)) return false;
        if (/^\[?::1\]?$/i.test(ep)) return false;
        if (/^\[?f[cd][0-9a-f]{2}:/i.test(ep)) return false;
        if (/^\[?fe[89ab][0-9a-f]:/i.test(ep)) return false;
        return true;
      }
      return false;
    });
    if (validated.length === 0) return;
    this._services.set(serviceName, validated);
    this._indices.set(serviceName, 0);
  }

  /**
   * 根据负载均衡策略选择一个服务端点。当前仅实现轮询策略。
   * @param {string} serviceName - 要选择端点的服务名称
   * @returns {string|null} 选中的端点地址，若服务不存在或无可用端点则返回 null
   */
  select(serviceName) {
    const endpoints = this._services.get(serviceName);
    if (!endpoints || endpoints.length === 0) return null;
    const idx = this._indices.get(serviceName) ?? 0;
    const selected = endpoints[idx % endpoints.length];
    this._indices.set(serviceName, idx + 1);
    return selected;
  }

  /**
   * 关闭时的清理回调，清空所有已注册的服务和轮询索引。
   * @protected
   */
  _onShutdown() {
    this._services.clear();
    this._indices.clear();
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
  }
}
SharedLoadBalancer = withShutdown(SharedLoadBalancer);

/**
 * @classdesc 共享基础设施。连接池/负载均衡/服务注册/特性标志
 * 共享服务注册中心，提供服务实例的注册、查询和列表功能。
 * 注册时自动对元数据进行消毒处理（XSS/注入防护），并记录注册时间。
 * @extends EventEmitter（通过 withShutdown 混入关闭能力）
 */
class SharedServiceRegistry {
  /**
   * 创建共享服务注册中心实例。
   * @param {Object} [options] - 注册中心配置选项
   * @param {number} [options.maxServices=200] - 最大可注册服务数量
   */
  constructor(options) {
    this._services = new Map();
    this._maxServices = Number.isFinite(options && options.maxServices) ? options.maxServices : DEFAULT_REGISTRY_MAX_SERVICES;
  }

  /**
   * 注册一个服务实例。若服务名已存在则覆盖，若达到最大服务数则忽略新服务。
   * 元数据会经过 sanitizeObject 消毒处理以防止XSS和注入攻击。
   * @param {string} name - 服务名称，不能为空字符串
   * @param {Object} [metadata] - 服务元数据，将经过消毒处理
   */
  register(name, metadata) {
    this.guardShutdown();
    if (!name || typeof name !== 'string') return;
    if (!this._services.has(name) && this._services.size >= this._maxServices) return;
    const safeMetadata = metadata !== null && typeof metadata === 'object' ? sanitizeObject(metadata) : metadata;
    this._services.set(name, { name, metadata: safeMetadata, registeredAt: new Date().toISOString() });
  }

  /**
   * 根据名称查询已注册的服务。
   * @param {string} name - 要查询的服务名称
   * @returns {{ name: string, metadata: Object, registeredAt: string }|null}
   *   服务信息对象（含名称、元数据和注册时间），未找到时返回 null
   */
  getService(name) {
    return this._services.get(name) ?? null;
  }

  /**
   * 获取所有已注册服务的列表。
   * @returns {Array<{ name: string, metadata: Object, registeredAt: string }>}
   *   所有已注册服务信息对象的数组
   */
  listServices() {
    return Array.from(this._services.values());
  }

  /**
   * 关闭时的清理回调，清空所有已注册的服务。
   * @protected
   */
  _onShutdown() {
    this._services.clear();
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
  }
}
SharedServiceRegistry = withShutdown(SharedServiceRegistry);

/**
 * @classdesc 共享基础设施。连接池/负载均衡/服务注册/特性标志
 * 共享特性标志管理器，支持功能开关的设置、查询和变更历史追踪。
 * 使用 RingBuffer 存储变更历史，支持最大标志数限制和启用计数统计。
 * @extends EventEmitter（通过 withShutdown 混入关闭能力）
 */
class SharedFeatureFlags {
  /**
   * 创建共享特性标志管理器实例。
   * @param {Object} [options] - 特性标志配置选项
   * @param {number} [options.maxHistory=100] - 变更历史最大记录数
   * @param {number} [options.maxFlags=200] - 最大特性标志数量
   */
  constructor(options) {
    this._flags = new Map();
    this._enabledCount = 0;
    this._maxHistory = Number.isFinite(options && options.maxHistory) ? options.maxHistory : DEFAULT_MAX_FLAG_HISTORY;
    this._history = new RingBuffer(this._maxHistory);
    this._maxFlags = Number.isFinite(options && options.maxFlags) ? options.maxFlags : DEFAULT_MAX_FLAGS;
  }

  /**
   * 设置特性标志的启用状态。若标志不存在则创建，若已存在则更新。
   * 每次变更都会记录到历史缓冲区中，并自动维护启用计数。
   * @param {string} name - 特性标志名称
   * @param {boolean} enabled - 是否启用该特性
   * @param {string} [reason=''] - 变更原因说明
   */
  set(name, enabled, reason) {
    this.guardShutdown();
    const previous = this._flags.get(name);
    const wasEnabled = previous ? previous.enabled : false;
    const isEnabled = !!enabled;
    if (this._flags.size >= this._maxFlags && !this._flags.has(name)) {
      const oldestKey = this._flags.keys().next().value;
      this._flags.delete(oldestKey);
    }
    this._flags.set(name, { name, enabled: isEnabled, reason: reason || '', updatedAt: new Date().toISOString() });
    if (!previous) {
      if (isEnabled) this._enabledCount++;
    } else {
      if (!wasEnabled && isEnabled) this._enabledCount++;
      else if (wasEnabled && !isEnabled) this._enabledCount--;
    }
    this._history.push({ name, enabled: isEnabled, previous: wasEnabled, timestamp: new Date().toISOString() });
  }

  /**
   * 查询特性标志是否启用。若标志不存在，则返回默认值。
   * @param {string} name - 特性标志名称
   * @param {boolean} [defaultValue=false] - 标志不存在时的默认返回值
   * @returns {boolean} 标志的启用状态，不存在时返回 defaultValue
   */
  isEnabled(name, defaultValue) {
    const flag = this._flags.get(name);
    if (!flag) return defaultValue !== undefined ? defaultValue : false;
    return flag.enabled;
  }

  /**
   * 获取特性标志的运行统计数据。
   * @returns {{ totalFlags: number, enabledCount: number, disabledCount: number, historySize: number }}
   *   包含总标志数、已启用数、已禁用数和历史记录数的统计对象
   */
  getStats() {
    return {
      totalFlags: this._flags.size,
      enabledCount: this._enabledCount,
      disabledCount: this._flags.size - this._enabledCount,
      historySize: this._history.size,
    };
  }

  /**
   * 关闭时的清理回调，清空所有标志、重置启用计数并清空历史记录。
   * @protected
   */
  _onShutdown() {
    this._flags.clear();
    this._enabledCount = 0;
    this._history.clear();
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
  }
}
SharedFeatureFlags = withShutdown(SharedFeatureFlags);

module.exports = { SharedConnectionPool, SharedLoadBalancer, SharedServiceRegistry, SharedFeatureFlags };
