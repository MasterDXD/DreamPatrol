'use strict';

/**
 * @module runtime/thought/provider/provider-adapter-base
 * @classdesc 适配器基类。重试/超时/限流/错误分类/指标追踪
 * ProviderAdapterBase — Base class for memory provider adapters with retry, rate-limit, and error classification
 */

const MemoryProviderInterface = require('./memory-provider-interface');
const { safeCall } = require('../../../utils/safe-execute');
const { debug } = require('../../../utils/debug-logger');
const BoundedMap = require('../../../utils/bounded-map');
const safeAssign = require('../../../utils/safe-assign');
const { mergeConfig } = safeAssign;

const ERROR_TYPES = {
  NETWORK: 'network',
  AUTH: 'auth',
  RATE_LIMIT: 'rate-limit',
  SERVER: 'server',
  UNKNOWN: 'unknown',
};

const DEFAULT_ADAPTER_CONFIG = {
  maxRetries: 3,
  retryBaseDelayMs: 1000,
  requestTimeoutMs: 10000,
  maxRequestsPerMinute: 100,
  fallbackToLocal: true,
};

/**
 * 提供者适配器基类。在MemoryProviderInterface基础上增加重试机制、
 * 速率限制、请求超时和错误分类等网络通信能力。
 *
 * @extends MemoryProviderInterface
 */
class ProviderAdapterBase extends MemoryProviderInterface {
  /**
   * 创建ProviderAdapterBase实例。
   *
   * @param {Object} [config] - 适配器配置
   * @param {number} [config.maxRetries=3] - 最大重试次数
   * @param {number} [config.retryBaseDelayMs=1000] - 重试基础延迟（毫秒）
   * @param {number} [config.requestTimeoutMs=10000] - 请求超时（毫秒）
   * @param {number} [config.maxRequestsPerMinute=100] - 每分钟最大请求数
   * @param {boolean} [config.fallbackToLocal=true] - 失败时是否回退到本地
   */
  constructor(config) {
    super(config);
    this._adapterConfig = mergeConfig(DEFAULT_ADAPTER_CONFIG, config ?? {});
    this._requestTimestamps = new BoundedMap(1000);
    this._retryTimers = new Set();
    this._metrics = {
      requestCount: 0,
      errorCount: 0,
      totalLatency: 0,
      byErrorType: {},
    };
    this._log = debug('ProviderAdapterBase');
  }

  _classifyByCode(code) {
    const networkCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
    if (networkCodes.includes(code)) return ERROR_TYPES.NETWORK;
    return null;
  }

  _classifyByStatus(statusCode) {
    if (statusCode === 401 || statusCode === 403) return ERROR_TYPES.AUTH;
    if (statusCode === 429) return ERROR_TYPES.RATE_LIMIT;
    if (statusCode >= 500) return ERROR_TYPES.SERVER;
    return null;
  }

  _classifyByMessage(msg) {
    if (msg.indexOf('network') >= 0 || msg.indexOf('timeout') >= 0 || msg.indexOf('ECONN') >= 0) return ERROR_TYPES.NETWORK;
    if (msg.indexOf('auth') >= 0 || msg.indexOf('unauthorized') >= 0 || msg.indexOf('forbidden') >= 0) return ERROR_TYPES.AUTH;
    if (msg.indexOf('rate') >= 0 || msg.indexOf('too many') >= 0 || msg.indexOf('429') >= 0) return ERROR_TYPES.RATE_LIMIT;
    return null;
  }

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

  _isRateLimited() {
    const now = Date.now();
    const windowMs = 60000;
    let count = 0;
    this._requestTimestamps.forEach((entry) => {
      if (entry && typeof entry === 'number' && Number.isFinite(entry) && now - entry < windowMs) count++;
    });
    return count >= this._adapterConfig.maxRequestsPerMinute;
  }

  _recordRequest() {
    const now = Date.now();
    this._requestTimestamps.set(String(now) + '-' + String(this._metrics.requestCount), now);
    this._metrics.requestCount++;
  }

  _recordError(errorType) {
    this._metrics.errorCount++;
    this._metrics.byErrorType[errorType] = (this._metrics.byErrorType[errorType] ?? 0) + 1;
  }

  _recordLatency(latency) {
    this._metrics.totalLatency += latency;
  }

  async _withRetry(fn, _label) {
    if (this._isRateLimited()) {
      const err = new Error('rate limit exceeded');
      err.statusCode = 429;
      throw err;
    }
    let lastError = null;
    for (let attempt = 0; attempt <= this._adapterConfig.maxRetries; attempt++) {
      try {
        this._recordRequest();
        const start = Date.now();
        const result = await fn();
        this._recordLatency(Date.now() - start);
        return result;
      } catch (err) {
        lastError = err;
        const errorType = this._classifyError(err);
        this._recordError(errorType);
        if (errorType === ERROR_TYPES.AUTH) throw err;
        if (attempt < this._adapterConfig.maxRetries) {
          const delay = this._adapterConfig.retryBaseDelayMs * Math.pow(2, attempt);
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
    throw lastError;
  }

  async _requestWithTimeout(fn, timeoutMs) {
    const timeout = timeoutMs ?? this._adapterConfig.requestTimeoutMs;
    let timer;
    const abortController = new AbortController();
    try {
      const fnPromise = fn(abortController.signal);
      fnPromise.catch(function(err) { debug('ProviderAdapterBase', 'requestFailed', err && err.message ? err.message : String(err)); });
      const result = await Promise.race([
        fnPromise,
        new Promise(function(_, reject) {
          timer = setTimeout(function() { abortController.abort(); reject(new Error('request timeout')); }, timeout);
          if (timer && typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 连接到远程提供者。通过_doConnect实现实际连接，带重试机制。
   *
   * @returns {Promise<void>}
   * @throws {Error} 连接失败时抛出错误
   */
  async connect() {
    this.guardShutdown();
    try {
      await this._withRetry(() => this._doConnect(), 'connect');
      this._connected = true;
      this._healthy = true;
      this.emit('connected');
      this._log('connect', this.getName());
    } catch (err) {
      this._connected = false;
      this._healthy = false;
      this.emit('connection-error', err && err.message ? err.message : String(err));
      throw err;
    }
  }

  /**
   * 断开与远程提供者的连接。调用_doDisconnect并重置状态。
   *
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      await this._doDisconnect();
    } catch (err) {
      this._log('disconnect', this.getName(), err && err.message ? err.message : String(err));
    }
    this._connected = false;
    this._healthy = false;
    this.emit('disconnected');
    this._log('disconnect', this.getName());
  }

  /**
   * 执行健康检查。通过_doHealthCheck实现实际检查，带请求超时。
   *
   * @returns {Promise<{healthy: boolean, latency: number, error: string|null}>} 健康检查结果
   */
  async healthCheck() {
    const start = Date.now();
    try {
      const _result = await this._requestWithTimeout(() => this._doHealthCheck());
      this._healthy = true;
      this._lastHealthCheck = Date.now();
      const latency = Date.now() - start;
      this.emit('health-changed', { healthy: true, latency });
      return { healthy: true, latency, error: null };
    } catch (err) {
      this._healthy = false;
      const latency = Date.now() - start;
      const errorMsg = err && err.message ? err.message : String(err);
      this.emit('health-changed', { healthy: false, latency, error: errorMsg });
      return { healthy: false, latency, error: errorMsg };
    }
  }

  async _doHealthCheck() {
    return { healthy: true };
  }

  /**
   * 从远程提供者召回记忆条目。带重试和超时机制，失败时可回退到本地。
   *
   * @param {*} query - 查询条件
   * @param {Object} [options] - 查询选项
   * @returns {Promise<Array>} 匹配的记忆条目列表
   */
  async recall(query, options) {
    this.guardShutdown();
    try {
      return await this._withRetry(() => this._requestWithTimeout(() => this._doRecall(query, options)), 'recall');
    } catch (err) {
      this._log('recall', this.getName(), err && err.message ? err.message : String(err));
      if (this._adapterConfig.fallbackToLocal) return [];
      throw err;
    }
  }

  /**
   * 向远程提供者写入记忆条目。带重试和超时机制，失败时可回退到本地。
   *
   * @param {*} entry - 记忆条目
   * @returns {Promise<{success: boolean, id: *}>} 写入结果
   */
  async write(entry) {
    try {
      return await this._withRetry(() => this._requestWithTimeout(() => this._doWrite(entry)), 'write');
    } catch (err) {
      this._log('write', this.getName(), err && err.message ? err.message : String(err));
      if (this._adapterConfig.fallbackToLocal) return { success: false, id: null };
      throw err;
    }
  }

  /**
   * 按过滤条件查询远程提供者。带重试和超时机制，失败时可回退到本地。
   *
   * @param {*} filter - 过滤条件
   * @returns {Promise<Array>} 查询结果列表
   */
  async query(filter) {
    try {
      return await this._withRetry(() => this._requestWithTimeout(() => this._doQuery(filter)), 'query');
    } catch (err) {
      this._log('query', this.getName(), err && err.message ? err.message : String(err));
      if (this._adapterConfig.fallbackToLocal) return [];
      throw err;
    }
  }

  /**
   * 从远程提供者删除指定ID的记忆条目。带重试和超时机制，失败时可回退到本地。
   *
   * @param {*} id - 条目ID
   * @returns {Promise<boolean>} 删除成功返回true
   */
  async delete(id) {
    try {
      return await this._withRetry(() => this._requestWithTimeout(() => this._doDelete(id)), 'delete');
    } catch (err) {
      this._log('delete', this.getName(), err && err.message ? err.message : String(err));
      if (this._adapterConfig.fallbackToLocal) return false;
      throw err;
    }
  }

  /**
   * 与远程提供者同步数据。带重试和超时机制，失败时可回退到本地。
   *
   * @param {Array} entries - 待同步的条目列表
   * @param {string} direction - 同步方向（'push'/'pull'/'bidirectional'）
   * @returns {Promise<{pushed: number, pulled: number}>} 同步结果
   */
  async sync(entries, direction) {
    this.guardShutdown();
    try {
      return await this._withRetry(() => this._requestWithTimeout(() => this._doSync(entries, direction)), 'sync');
    } catch (err) {
      this._log('sync', this.getName(), err && err.message ? err.message : String(err));
      if (this._adapterConfig.fallbackToLocal) return { pushed: 0, pulled: 0 };
      throw err;
    }
  }

  async _doConnect() { throw new Error('_doConnect not implemented'); }
  async _doDisconnect() { throw new Error('_doDisconnect not implemented'); }
  async _doRecall() { return []; }
  async _doWrite() { return { success: false, id: null }; }
  async _doQuery() { return []; }
  async _doDelete() { return false; }
  async _doSync() { return { pushed: 0, pulled: 0 }; }

  /**
   * 获取适配器的请求度量统计。
   *
   * @returns {{requestCount: number, errorCount: number, avgLatency: number, byErrorType: Object.<string, number>}} 度量统计
   */
  getMetrics() {
    const avgLatency = this._metrics.requestCount > 0
      ? Math.round(this._metrics.totalLatency / this._metrics.requestCount)
      : 0;
    return {
      requestCount: this._metrics.requestCount,
      errorCount: this._metrics.errorCount,
      avgLatency,
      byErrorType: safeAssign({}, this._metrics.byErrorType),
    };
  }

  _onShutdown() {
    if (this._connected) {
      try { Promise.resolve(this.disconnect()).catch(function(_err) { debug('ProviderAdapterBase', 'disconnectReject', _err && _err.message ? _err.message : String(_err)); }); } catch (_e) { this._log('shutdown_disconnect', _e && _e.message ? _e.message : String(_e)); }
    }
    safeCall(() => this._requestTimestamps.shutdown(), 'ProviderAdapterBase', 'shutdown-requestTimestamps');
    for (const t of this._retryTimers) clearTimeout(t);
    this._retryTimers.clear();
    this._metrics = { requestCount: 0, errorCount: 0, totalLatency: 0, byErrorType: {} };
    this.removeAllListeners();
  }
}

ProviderAdapterBase.ERROR_TYPES = ERROR_TYPES;
ProviderAdapterBase.DEFAULT_ADAPTER_CONFIG = DEFAULT_ADAPTER_CONFIG;

module.exports = ProviderAdapterBase;
