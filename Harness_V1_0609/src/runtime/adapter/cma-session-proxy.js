'use strict';

/**
 * @module runtime/adapter/cma-session-proxy
 * CMASessionProxy — Proxies remote Agent execution through Claude Managed Agents
 *
 * Allows Harness to delegate task execution to CMA cloud-hosted agents,
 * providing remote compute capabilities without local resource consumption.
 */

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const safeAssign = require('../../utils/safe-assign');
const { safeJsonParse } = require('../../utils/safe-parse');
const BoundedMap = require('../../utils/bounded-map');
const { withShutdown } = require('../../utils/shutdown-mixin');

const PROXY_EVENTS = {
  SESSION_CREATED: 'session-created',
  SESSION_COMPLETED: 'session-completed',
  SESSION_FAILED: 'session-failed',
  SESSION_CANCELLED: 'session-cancelled',
};

const PROXY_SESSION_STATES = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const DEFAULT_PROXY_CONFIG = {
  apiKey: '',
  betaHeader: 'managed-agents-2026-04-01',
  baseUrl: 'https://api.anthropic.com/v1',
  agentId: '',
  environmentId: '',
  defaultModel: 'claude-sonnet-4-6',
  requestTimeoutMs: 120000,
  maxActiveSessions: 10,
};

/**
 * CMA会话代理，管理CMA模型服务的会话生命周期和请求代理
 *
 * @classdesc CMA会话代理，管理CMA模型服务的会话生命周期和请求代理
 * @extends EventEmitter
 */
class CMASessionProxy extends EventEmitter {
  /**
   * @param {Object} config - 会话代理配置
   */
  constructor(config) {
    super();
    this._config = safeAssign.mergeConfig(DEFAULT_PROXY_CONFIG, config ?? {});
    this._activeSessions = new BoundedMap(this._config.maxActiveSessions);
    this._stats = { created: 0, completed: 0, failed: 0, cancelled: 0 };
    this._log = debug('CMASessionProxy');
  }

  get activeCount() { return this._activeSessions.size; }
  get stats() { if (this._shutDown) return { activeSessions: 0, totalRequests: 0, avgLatency: 0 }; return { ...this._stats }; }

  /**
   * 初始化会话代理，检查 API Key 是否可用
   * @returns {boolean} 是否初始化成功（无 API Key 时返回 false）
   */
  initialize() {
    if (!this._config.apiKey) {
      this._log('initialize', 'No API key, session proxy disabled');
      return false;
    }
    this._log('initialize', 'Session proxy ready');
    return true;
  }

  /**
   * 通过 CMA 远程代理执行任务
   * @param {string} task - 待执行的任务描述
   * @param {Object} [options] - 执行选项
   * @param {string} [options.model] - 使用的模型名称，默认使用配置中的 defaultModel
   * @returns {Promise<{success: boolean, sessionId?: string, result?: Object, reason?: string}>} 执行结果
   * @emits 'session-created' 会话创建成功时触发
   * @emits 'session-completed' 会话执行完成时触发
   * @emits 'session-failed' 会话执行失败时触发
   */
  async execute(task, options) {
    if (this._shutDown) return { success: false, reason: 'shutting down' };
    if (!this._config.apiKey) {
      this._log('execute', 'No API key, cannot execute');
      return { success: false, reason: 'no-api-key' };
    }

    const opts = options ?? {};
    const model = opts.model || this._config.defaultModel;

    try {
      const cmaSession = await this._createCMASession(task, model);
      const handle = {
        id: cmaSession.id,
        task,
        model,
        state: PROXY_SESSION_STATES.RUNNING,
        createdAt: Date.now(),
        completedAt: null,
        result: null,
      };
      this._activeSessions.set(cmaSession.id, handle);
      this._stats.created++;
      this.emit(PROXY_EVENTS.SESSION_CREATED, { sessionId: cmaSession.id, task });

      const result = await this._waitForCompletion(cmaSession.id);
      handle.state = PROXY_SESSION_STATES.COMPLETED;
      handle.completedAt = Date.now();
      handle.result = result;
      this._stats.completed++;
      this.emit(PROXY_EVENTS.SESSION_COMPLETED, { sessionId: cmaSession.id, result });
      this._activeSessions.delete(cmaSession.id);

      return { success: true, sessionId: cmaSession.id, result };
    } catch (err) {
      this._stats.failed++;
      const msg = err && err.message ? err.message : String(err);
      this._log('execute', 'Failed: ' + msg);
      this.emit(PROXY_EVENTS.SESSION_FAILED, { task, error: msg });
      return { success: false, reason: msg };
    }
  }

  /**
   * 取消正在执行的远程会话
   * @param {string} sessionId - 需要取消的会话标识
   * @returns {boolean} 是否成功取消（会话不存在时返回 false）
   * @emits 'session-cancelled' 会话被取消时触发
   */
  cancel(sessionId) {
    this.guardShutdown();
    const handle = this._activeSessions.get(sessionId);
    if (!handle) return false;
    handle.state = PROXY_SESSION_STATES.CANCELLED;
    handle.completedAt = Date.now();
    this._stats.cancelled++;
    this.emit(PROXY_EVENTS.SESSION_CANCELLED, { sessionId });
    this._activeSessions.delete(sessionId);
    return true;
  }

  /**
   * 获取指定会话的当前状态
   * @param {string} sessionId - 会话标识
   * @returns {{id: string, task: string, state: string, createdAt: number, completedAt: number|null}|null} 会话状态信息，会话不存在时返回 null
   */
  getSessionState(sessionId) {
    const handle = this._activeSessions.get(sessionId);
    if (!handle) return null;
    return {
      id: handle.id,
      task: handle.task,
      state: handle.state,
      createdAt: handle.createdAt,
      completedAt: handle.completedAt,
    };
  }

  async _createCMASession(task, model) {
    const url = this._config.baseUrl + '/sessions';
    const body = JSON.stringify({
      agent: this._config.agentId,
      environment_id: this._config.environmentId,
      model,
      title: 'harness-proxy-' + Date.now(),
      initial_message: task,
    });
    return this._request('POST', url, body);
  }

  async _waitForCompletion(sessionId) {
    const url = this._config.baseUrl + '/sessions/' + encodeURIComponent(sessionId);
    const startTime = Date.now();
    const timeout = this._config.requestTimeoutMs;
    const pollInterval = 2000;

    while (Date.now() - startTime < timeout) {
      if (this._shutDown) throw new Error('Shutdown during execution');
      const resp = await this._request('GET', url);
      if (resp.status === 'completed' || resp.status === 'succeeded') {
        return resp;
      }
      if (resp.status === 'failed') {
        throw new Error('CMA session failed: ' + (resp.error || 'unknown'));
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    throw new Error('CMA session timed out after ' + timeout + 'ms');
  }

  async _request(method, url, body) {
    const http = require('https');
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (err) {
      throw new Error('Invalid URL: ' + url + ' - ' + (err && err.message ? err.message : String(err)), { cause: err });
    }
    const self = this;
    const headers = {
      'x-api-key': this._config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': this._config.betaHeader,
      'content-type': 'application/json',
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      let resRef = null;
      const req = http.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
      }, (res) => {
        resRef = res;
        let data = '';
        let responseSize = 0;
        const maxResponseSize = 10 * 1024 * 1024;
        res.on('data', (chunk) => {
          responseSize += chunk.length;
          if (responseSize > maxResponseSize) {
            res.destroy(new Error('Response too large'));
            if (!settled) { settled = true; reject(new Error('Response too large')); }
            return;
          }
          data += chunk;
        });
        res.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(safeJsonParse(data, data)); } catch (_e) { debug('CMASessionProxy', 'jsonParseFallback', _e && _e.message ? _e.message : String(_e)); resolve(data); }
          } else {
            reject(new Error('CMA API ' + res.statusCode + ': ' + data.slice(0, 200)));
          }
        });
      });
      req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
      req.setTimeout(self._config.requestTimeoutMs, () => {
        if (!settled) { settled = true; req.destroy(); if (resRef && !resRef.destroyed) resRef.destroy(); reject(new Error('Request timeout')); }
      });
      if (body) req.write(body);
      req.end();
    });
  }

  _onShutdown() {
    this._shutDown = true;
    for (const [, handle] of this._activeSessions) {
      if (handle.state === PROXY_SESSION_STATES.RUNNING) {
        handle.state = PROXY_SESSION_STATES.CANCELLED;
        handle.completedAt = Date.now();
      }
    }
    this._activeSessions.shutdown();
    this.removeAllListeners();
  }
}

CMASessionProxy.EVENTS = PROXY_EVENTS;
CMASessionProxy.STATES = PROXY_SESSION_STATES;
CMASessionProxy.DEFAULT_CONFIG = DEFAULT_PROXY_CONFIG;

module.exports = { CMASessionProxy: withShutdown(CMASessionProxy), PROXY_EVENTS, PROXY_SESSION_STATES, DEFAULT_PROXY_CONFIG };
