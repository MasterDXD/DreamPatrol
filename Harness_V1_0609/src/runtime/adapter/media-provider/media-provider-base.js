'use strict';

/**
 * @module runtime/adapter/media-provider/media-provider-base
 * MediaProviderBase — 媒体生成提供商适配器基类。
 * 在MediaProviderInterface基础上增加重试机制、请求超时、并发控制和指标追踪。
 */

const MediaProviderInterface = require('./media-provider-interface');
const { debug } = require('../../../utils/debug-logger');
const BoundedArray = require('../../../utils/bounded-array');
const { safeCall } = require('../../../utils/safe-execute');
const safeAssign = require('../../../utils/safe-assign');
const { mergeConfig } = safeAssign;

const ERROR_TYPES = {
  NETWORK: 'network',
  AUTH: 'auth',
  RATE_LIMIT: 'rate-limit',
  SERVER: 'server',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown',
};

const DEFAULT_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 1000,
  requestTimeoutMs: 300000,
  maxConcurrentTasks: 5,
  taskHistorySize: 100,
};

/**
 * 媒体生成提供商适配器基类。在MediaProviderInterface基础上增加重试机制、
 * 请求超时、并发控制和指标追踪等网络通信能力。
 *
 * @classdesc 媒体提供者基类，实现通用的连接管理、健康检查和超时控制逻辑
 * @extends MediaProviderInterface
 */
class MediaProviderBase extends MediaProviderInterface {
  /**
   * 创建MediaProviderBase实例。
   *
   * @param {Object} [config] - 适配器配置
   * @param {number} [config.maxRetries=3] - 最大重试次数
   * @param {number} [config.retryDelayMs=1000] - 重试基础延迟（毫秒）
   * @param {number} [config.requestTimeoutMs=300000] - 请求超时（毫秒，默认5分钟）
   * @param {number} [config.maxConcurrentTasks=5] - 最大并发任务数
   * @param {number} [config.taskHistorySize=100] - 任务历史记录大小
   */
  constructor(config) {
    super(config);
    this._providerConfig = mergeConfig(DEFAULT_CONFIG, config ?? {});
    this._activeTasks = new Map();
    this._taskHistory = new BoundedArray(this._providerConfig.taskHistorySize);
    this._retryTimers = new Set();
    this._stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalRetries: 0,
      byErrorType: {},
    };
    this._log = debug('MediaProviderBase');
  }

  /**
   * 根据错误码分类错误类型。
   *
   * @param {string} code - 错误码
   * @returns {string|null} 错误类型
   * @private
   */
  _classifyByCode(code) {
    const networkCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
    if (networkCodes.includes(code)) return ERROR_TYPES.NETWORK;
    return null;
  }

  /**
   * 根据HTTP状态码分类错误类型。
   *
   * @param {number} statusCode - HTTP状态码
   * @returns {string|null} 错误类型
   * @private
   */
  _classifyByStatus(statusCode) {
    if (statusCode === 401 || statusCode === 403) return ERROR_TYPES.AUTH;
    if (statusCode === 429) return ERROR_TYPES.RATE_LIMIT;
    if (statusCode >= 500) return ERROR_TYPES.SERVER;
    return null;
  }

  /**
   * 根据错误消息分类错误类型。
   *
   * @param {string} msg - 错误消息
   * @returns {string|null} 错误类型
   * @private
   */
  _classifyByMessage(msg) {
    if (msg.indexOf('network') >= 0 || msg.indexOf('timeout') >= 0 || msg.indexOf('ECONN') >= 0) return ERROR_TYPES.NETWORK;
    if (msg.indexOf('auth') >= 0 || msg.indexOf('unauthorized') >= 0 || msg.indexOf('forbidden') >= 0) return ERROR_TYPES.AUTH;
    if (msg.indexOf('rate') >= 0 || msg.indexOf('too many') >= 0 || msg.indexOf('429') >= 0) return ERROR_TYPES.RATE_LIMIT;
    return null;
  }

  /**
   * 综合分类错误类型。
   *
   * @param {Error} err - 错误对象
   * @returns {string} 错误类型
   * @private
   */
  _classifyError(err) {
    const code = (err && err.code) || '';
    const byCode = this._classifyByCode(code);
    if (byCode) return byCode;
    const statusCode = err && err.statusCode;
    if (statusCode) {
      const byStatus = this._classifyByStatus(statusCode);
      if (byStatus) return byStatus;
    }
    const msg = (err && err.message) || '';
    const byMsg = this._classifyByMessage(msg);
    if (byMsg) return byMsg;
    return ERROR_TYPES.UNKNOWN;
  }

  /**
   * 带重试的异步操作包装。指数退避重试，认证错误不重试。
   *
   * @param {Function} fn - 异步操作函数
   * @param {string} label - 操作标签（用于日志）
   * @returns {Promise<*>} 操作结果
   * @private
   */
  async _withRetry(fn, label) {
    let lastError = null;
    for (let attempt = 0; attempt <= this._providerConfig.maxRetries; attempt++) {
      try {
        this._stats.totalRequests++;
        return await fn();
      } catch (err) {
        lastError = err;
        const errorType = this._classifyError(err);
        this._stats.byErrorType[errorType] = (this._stats.byErrorType[errorType] ?? 0) + 1;
        if (errorType === ERROR_TYPES.AUTH) throw err;
        if (attempt < this._providerConfig.maxRetries) {
          this._stats.totalRetries++;
          const delay = this._providerConfig.retryDelayMs * Math.pow(2, attempt);
          this._log(label + ' retry', { attempt: attempt + 1, delay, errorType });
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              this._retryTimers.delete(timer);
              resolve();
            }, delay);
            if (timer && typeof timer.unref === 'function') timer.unref();
            this._retryTimers.add(timer);
          });
        }
      }
    }
    this._stats.failedRequests++;
    throw lastError;
  }

  /**
   * 带超时的异步操作包装。
   *
   * @param {Promise} promise - 异步操作Promise
   * @param {number} ms - 超时时间（毫秒）
   * @param {string} label - 操作标签（用于日志）
   * @returns {Promise<*>} 操作结果
   * @private
   */
  async _withTimeout(promise, ms, label) {
    let timer;
    promise.catch(function(err) { debug('MediaProviderBase', 'withTimeout:' + label + ':originalRejected', err && err.message ? err.message : String(err)); });
    try {
      const result = await Promise.race([
        promise,
        new Promise(function(_, reject) {
          timer = setTimeout(function() {
            reject(new Error(label + ' timed out after ' + ms + 'ms'));
          }, ms);
          if (timer && typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /**
   * 记录任务到历史和活跃任务表。
   *
   * @param {string} taskId - 任务ID
   * @param {string} status - 任务状态
   * @param {Object} [result] - 任务结果
   * @private
   */
  _recordTask(taskId, status, result) {
    const entry = { taskId: taskId, status: status, timestamp: Date.now() };
    if (result) entry.result = result;
    this._taskHistory.push(entry);
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this._activeTasks.delete(taskId);
      if (status === 'completed') this._stats.successfulRequests++;
    } else {
      this._activeTasks.set(taskId, entry);
    }
  }

  /**
   * 检查是否超过最大并发任务数。
   *
   * @returns {boolean} 超过返回true
   * @private
   */
  _isAtCapacity() {
    return this._activeTasks.size >= this._providerConfig.maxConcurrentTasks;
  }

  /**
   * 连接到Provider服务。带重试机制。
   *
   * @returns {Promise<{connected: boolean, provider: string}>}
   */
  async connect() {
    try {
      await this._withRetry(() => this._doConnect(), 'connect');
      this._connected = true;
      this._healthy = true;
      this.emit('connected');
      this._log('connect', this.name);
      return { connected: true, provider: this.name };
    } catch (err) {
      this._connected = false;
      this._healthy = false;
      this.emit('connection-error', err && err.message ? err.message : String(err));
      throw err;
    }
  }

  /**
   * 断开Provider连接。
   *
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      await this._doDisconnect();
    } catch (err) {
      this._log('disconnect', this.name, err && err.message ? err.message : String(err));
    }
    this._connected = false;
    this._healthy = false;
    this.emit('disconnected');
    this._log('disconnect', this.name);
  }

  /**
   * 健康检查。带请求超时。
   *
   * @returns {Promise<{healthy: boolean, latency: number, error: string|null}>}
   */
  async healthCheck() {
    const start = Date.now();
    try {
      await this._withTimeout(this._doHealthCheck(), this._providerConfig.requestTimeoutMs, 'healthCheck');
      this._healthy = true;
      this._lastHealthCheck = Date.now();
      const latency = Date.now() - start;
      this.emit('health-changed', { healthy: true, latency });
      return { healthy: true, latency: latency, error: null };
    } catch (err) {
      this._healthy = false;
      const latency = Date.now() - start;
      const errorMsg = err && err.message ? err.message : String(err);
      this.emit('health-changed', { healthy: false, latency, error: errorMsg });
      return { healthy: false, latency: latency, error: errorMsg };
    }
  }

  /**
   * 生成媒体内容。带重试、超时和并发控制。
   *
   * @param {Object} request - 生成请求
   * @param {string} request.prompt - 文本描述
   * @param {string} [request.mode] - 生成模式
   * @param {Object} [request.options] - Provider特定选项
   * @returns {Promise<{taskId: string, status: string, provider: string}>}
   */
  async generate(request) {
    this.guardShutdown();
    if (this._isAtCapacity()) {
      throw new Error('Provider at capacity: max concurrent tasks reached (' + this._providerConfig.maxConcurrentTasks + ')');
    }
    try {
      const result = await this._withRetry(
        () => this._withTimeout(this._doGenerate(request), this._providerConfig.requestTimeoutMs, 'generate'),
        'generate',
      );
      if (result && result.taskId) {
        this._recordTask(result.taskId, result.status || 'pending');
      }
      this.emit('task-created', { taskId: result && result.taskId, provider: this.name });
      return result;
    } catch (err) {
      this._log('generate', this.name, err && err.message ? err.message : String(err));
      throw err;
    }
  }

  /**
   * 查询任务状态。带超时。
   *
   * @param {string} taskId - 任务ID
   * @returns {Promise<{taskId: string, status: string, result?: Object, error?: string}>}
   */
  async getTaskStatus(taskId) {
    this.guardShutdown();
    try {
      const result = await this._withTimeout(
        this._doGetTaskStatus(taskId),
        this._providerConfig.requestTimeoutMs,
        'getTaskStatus',
      );
      if (result) {
        this._recordTask(taskId, result.status, result.result);
      }
      return result;
    } catch (err) {
      this._log('getTaskStatus', this.name, taskId, err && err.message ? err.message : String(err));
      throw err;
    }
  }

  /**
   * 取消任务。带超时。
   *
   * @param {string} taskId - 任务ID
   * @returns {Promise<{cancelled: boolean}>}
   */
  async cancelTask(taskId) {
    this.guardShutdown();
    try {
      const result = await this._withTimeout(
        this._doCancelTask(taskId),
        this._providerConfig.requestTimeoutMs,
        'cancelTask',
      );
      if (result && result.cancelled) {
        this._recordTask(taskId, 'cancelled');
      }
      return result;
    } catch (err) {
      this._log('cancelTask', this.name, taskId, err && err.message ? err.message : String(err));
      throw err;
    }
  }

  // 子类需覆盖的钩子方法
  async _doConnect() { throw new Error('_doConnect() must be implemented'); }
  async _doDisconnect() { /* 默认空实现 */ }
  async _doHealthCheck() { return { healthy: true }; }
  async _doGenerate(_request) { throw new Error('_doGenerate() must be implemented'); }
  async _doGetTaskStatus(_taskId) { throw new Error('_doGetTaskStatus() must be implemented'); }
  async _doCancelTask(_taskId) { throw new Error('_doCancelTask() must be implemented'); }

  /**
   * 获取适配器的请求度量统计。
   *
   * @returns {{totalRequests: number, successfulRequests: number, failedRequests: number, totalRetries: number, activeTasks: number, connected: boolean, provider: string, byErrorType: Object.<string, number>}}
   */
  getStats() {
    return {
      totalRequests: this._stats.totalRequests,
      successfulRequests: this._stats.successfulRequests,
      failedRequests: this._stats.failedRequests,
      totalRetries: this._stats.totalRetries,
      activeTasks: this._activeTasks.size,
      connected: this._connected,
      provider: this.name,
      byErrorType: safeAssign({}, this._stats.byErrorType),
    };
  }

  _onShutdown() {
    const disconnectPromise = this._connected && this.disconnect
      ? Promise.resolve(this.disconnect()).catch(function(_err) {
        debug('MediaProviderBase', 'disconnectReject', _err && _err.message ? _err.message : String(_err));
      })
      : Promise.resolve();
    safeCall(() => this._taskHistory.shutdown(), 'MediaProviderBase', 'shutdown-taskHistory');
    for (const t of this._retryTimers) clearTimeout(t);
    this._retryTimers.clear();
    this._activeTasks.clear();
    this._stats = { totalRequests: 0, successfulRequests: 0, failedRequests: 0, totalRetries: 0, byErrorType: {} };
    this.removeAllListeners();
    return disconnectPromise;
  }
}

MediaProviderBase.ERROR_TYPES = ERROR_TYPES;
MediaProviderBase.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = MediaProviderBase;
