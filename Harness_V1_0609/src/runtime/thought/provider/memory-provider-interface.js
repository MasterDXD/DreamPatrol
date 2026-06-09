'use strict';

/**
 * @module runtime/thought/provider/memory-provider-interface
 * @classdesc 外部记忆提供商接口。connect/disconnect/healthCheck/recall/write等
 * MemoryProviderInterface — Unified abstraction layer for memory storage backends
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../../utils/shutdown-mixin');
const { debug } = require('../../../utils/debug-logger');

const PROVIDER_EVENTS = {
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  HEALTH_CHANGED: 'health-changed',
  ERROR: 'error',
};

/**
 * 记忆提供者接口。定义记忆存储后端的统一抽象层，
 * 提供连接管理、健康检查、CRUD操作和同步能力。
 *
 * @extends EventEmitter
 * @emits MemoryProviderInterface#connected 连接成功时触发
 * @emits MemoryProviderInterface#disconnected 断开连接时触发
 * @emits MemoryProviderInterface#health-changed 健康状态变更时触发
 * @emits MemoryProviderInterface#error 发生错误时触发
 */
class MemoryProviderInterface extends EventEmitter {
  /**
   * 创建MemoryProviderInterface实例。
   *
   * @param {Object} [config] - 提供者配置
   */
  constructor(config) {
    super();
    this._config = config ?? {};
    this._connected = false;
    this._healthy = false;
    this._lastHealthCheck = null;
    this._log = debug('MemoryProviderInterface');
  }

  /**
   * 连接到记忆提供者后端。设置连接和健康状态为true并触发connected事件。
   *
   * @returns {Promise<void>}
   */
  async connect() {
    this._connected = true;
    this._healthy = true;
    this.emit(PROVIDER_EVENTS.CONNECTED);
    this._log('connect', this.getName());
  }

  /**
   * 断开与记忆提供者后端的连接。重置连接和健康状态并触发disconnected事件。
   *
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._connected = false;
    this._healthy = false;
    this.emit(PROVIDER_EVENTS.DISCONNECTED);
    this._log('disconnect', this.getName());
  }

  /**
   * 执行健康检查。未连接时直接返回不健康状态，否则检测健康状态并触发health-changed事件。
   *
   * @returns {Promise<{healthy: boolean, latency: number, error: string|null}>} 健康检查结果
   */
  async healthCheck() {
    if (!this._connected) {
      return { healthy: false, latency: -1, error: 'not connected' };
    }
    const start = Date.now();
    try {
      this._healthy = true;
      this._lastHealthCheck = Date.now();
      const latency = Date.now() - start;
      this.emit(PROVIDER_EVENTS.HEALTH_CHANGED, { healthy: true, latency });
      return { healthy: true, latency, error: null };
    } catch (err) {
      this._healthy = false;
      const latency = Date.now() - start;
      const errorMsg = err && err.message ? err.message : String(err);
      this.emit(PROVIDER_EVENTS.HEALTH_CHANGED, { healthy: false, latency, error: errorMsg });
      this.emit(PROVIDER_EVENTS.ERROR, errorMsg);
      return { healthy: false, latency, error: errorMsg };
    }
  }

  /**
   * 从记忆提供者中召回匹配查询的记忆条目。基类返回空数组。
   *
   * @param {*} _query - 查询条件
   * @param {Object} [_options] - 查询选项
   * @returns {Promise<Array>} 匹配的记忆条目列表
   */
  async recall(_query, _options) {
    return [];
  }

  /**
   * 向记忆提供者写入一条记忆条目。基类返回失败结果。
   *
   * @param {*} _entry - 记忆条目
   * @returns {Promise<{success: boolean, id: null}>} 写入结果
   */
  async write(_entry) {
    return { success: false, id: null };
  }

  /**
   * 按过滤条件查询记忆条目。基类返回空数组。
   *
   * @param {*} _filter - 过滤条件
   * @returns {Promise<Array>} 查询结果列表
   */
  async query(_filter) {
    return [];
  }

  /**
   * 删除指定ID的记忆条目。基类返回false。
   *
   * @param {*} _id - 条目ID
   * @returns {Promise<boolean>} 删除成功返回true
   */
  async delete(_id) {
    return false;
  }

  /**
   * 与记忆提供者同步数据。基类返回零值结果。
   *
   * @param {Array} _entries - 待同步的条目列表
   * @param {string} _direction - 同步方向（'push'/'pull'/'bidirectional'）
   * @returns {Promise<{pushed: number, pulled: number}>} 同步结果
   */
  async sync(_entries, _direction) {
    return { pushed: 0, pulled: 0 };
  }

  /**
   * 获取提供者支持的能力列表。
   *
   * @returns {{recall: boolean, write: boolean, sync: boolean, semanticSearch: boolean, userIsolation: boolean}} 能力映射
   */
  getCapabilities() {
    return {
      recall: true,
      write: true,
      sync: false,
      semanticSearch: false,
      userIsolation: false,
    };
  }

  /**
   * 获取提供者名称。
   *
   * @returns {string} 提供者名称标识
   */
  getName() {
    return 'memory-provider-interface';
  }

  /**
   * 检查提供者是否已连接。
   *
   * @returns {boolean} 已连接返回true
   */
  isConnected() {
    return this._connected;
  }

  _onShutdown() {
    if (this._connected) {
      try { Promise.resolve(this.disconnect()).catch(function(_err) { debug('MemoryProviderInterface', 'disconnectReject', _err && _err.message ? _err.message : String(_err)); }); } catch (_e) { this._log('shutdown_disconnect', _e && _e.message ? _e.message : String(_e)); }
    }
    this._config = {};
    this.removeAllListeners();
  }
}

MemoryProviderInterface.PROVIDER_EVENTS = PROVIDER_EVENTS;

module.exports = withShutdown(MemoryProviderInterface);
