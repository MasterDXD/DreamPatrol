'use strict';

/**
 * @module runtime/adapter/media-provider/media-provider-interface
 * MediaProviderInterface — 媒体生成提供商统一接口。
 * 借鉴OpenClaw 4.5的Provider统一接口设计，支持视频/音乐/图像生成。
 * 所有媒体Provider适配器必须实现此接口。
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../../utils/shutdown-mixin');
const { debug } = require('../../../utils/debug-logger');

const PROVIDER_EVENTS = {
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  HEALTH_CHANGED: 'health-changed',
  ERROR: 'error',
  TASK_CREATED: 'task-created',
  TASK_COMPLETED: 'task-completed',
  TASK_FAILED: 'task-failed',
};

/**
 * 媒体生成提供商统一接口。定义媒体生成后端的统一抽象层，
 * 提供连接管理、健康检查、任务生成/查询/取消和能力查询。
 *
 * @classdesc 媒体提供者接口定义，规范媒体生成和查询的标准协议
 * @extends EventEmitter
 * @emits MediaProviderInterface#connected 连接成功时触发
 * @emits MediaProviderInterface#disconnected 断开连接时触发
 * @emits MediaProviderInterface#health-changed 健康状态变更时触发
 * @emits MediaProviderInterface#error 发生错误时触发
 * @emits MediaProviderInterface#task-created 任务创建时触发
 * @emits MediaProviderInterface#task-completed 任务完成时触发
 * @emits MediaProviderInterface#task-failed 任务失败时触发
 */
class MediaProviderInterface extends EventEmitter {
  /**
   * 创建MediaProviderInterface实例。
   *
   * @param {Object} [config] - 提供者配置
   */
  constructor(config) {
    super();
    this._config = config ?? {};
    this._connected = false;
    this._healthy = false;
    this._lastHealthCheck = null;
    this._log = debug('MediaProviderInterface');
  }

  /**
   * 连接到Provider服务。基类设置连接和健康状态为true并触发connected事件。
   *
   * @returns {Promise<{connected: boolean, provider: string}>}
   */
  async connect() {
    this._connected = true;
    this._healthy = true;
    this.emit(PROVIDER_EVENTS.CONNECTED);
    this._log('connect', this.name);
    return { connected: true, provider: this.name };
  }

  /**
   * 断开Provider连接。基类重置连接和健康状态并触发disconnected事件。
   *
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._connected = false;
    this._healthy = false;
    this.emit(PROVIDER_EVENTS.DISCONNECTED);
    this._log('disconnect', this.name);
  }

  /**
   * 健康检查。基类返回健康状态和延迟。
   *
   * @returns {Promise<{healthy: boolean, latency: number}>}
   */
  async healthCheck() {
    const start = Date.now();
    this._lastHealthCheck = Date.now();
    const latency = Date.now() - start;
    this.emit(PROVIDER_EVENTS.HEALTH_CHANGED, { healthy: this._healthy, latency });
    return { healthy: this._healthy, latency };
  }

  /**
   * 生成媒体内容。基类抛出错误，子类必须实现。
   *
   * @param {Object} request - 生成请求
   * @param {string} request.prompt - 文本描述
   * @param {string} [request.mode] - 生成模式：'generate'|'imageToVideo'|'videoToVideo'
   * @param {Object} [request.options] - Provider特定选项
   * @returns {Promise<{taskId: string, status: string, provider: string}>}
   */
  async generate(_request) {
    throw new Error('generate() must be implemented');
  }

  /**
   * 查询任务状态。基类抛出错误，子类必须实现。
   *
   * @param {string} taskId - 任务ID
   * @returns {Promise<{taskId: string, status: string, result?: Object, error?: string}>}
   */
  async getTaskStatus(_taskId) {
    throw new Error('getTaskStatus() must be implemented');
  }

  /**
   * 取消任务。基类抛出错误，子类必须实现。
   *
   * @param {string} taskId - 任务ID
   * @returns {Promise<{cancelled: boolean}>}
   */
  async cancelTask(_taskId) {
    throw new Error('cancelTask() must be implemented');
  }

  /**
   * 获取Provider支持的模式和能力。基类返回默认能力。
   *
   * @returns {{modes: string[], maxDuration: number, maxResolution: string, provider: string}}
   */
  getCapabilities() {
    return {
      modes: ['generate'],
      maxDuration: 0,
      maxResolution: '',
      provider: this.name,
    };
  }

  /**
   * Provider名称。基类返回默认名称，子类应覆盖。
   *
   * @type {string}
   */
  get name() {
    return 'media-provider-interface';
  }

  /**
   * 检查Provider是否已连接。
   *
   * @returns {boolean} 已连接返回true
   */
  isConnected() {
    return this._connected;
  }

  _onShutdown() {
    const disconnectPromise = this._connected && this.disconnect
      ? Promise.resolve(this.disconnect()).catch(function(_err) {
        debug('MediaProviderInterface', 'disconnectReject', _err && _err.message ? _err.message : String(_err));
      })
      : Promise.resolve();
    this._config = {};
    this.removeAllListeners();
    return disconnectPromise;
  }
}

MediaProviderInterface.PROVIDER_EVENTS = PROVIDER_EVENTS;

module.exports = withShutdown(MediaProviderInterface);
