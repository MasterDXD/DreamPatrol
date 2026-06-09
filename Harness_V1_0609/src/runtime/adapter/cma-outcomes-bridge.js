'use strict';

/**
 * @module runtime/adapter/cma-outcomes-bridge
 * CMAOutcomesBridge — Bidirectional sync between Harness DreamOutcomes and CMA Outcomes
 */

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const safeAssign = require('../../utils/safe-assign');
const { safeJsonParse } = require('../../utils/safe-parse');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');

const BRIDGE_EVENTS = {
  SYNC_TO_CMA: 'sync-to-cma',
  SYNC_FROM_CMA: 'sync-from-cma',
  SYNC_ERROR: 'sync-error',
};

const MAX_PENDING_OUTCOMES = 1000;

const DEFAULT_BRIDGE_CONFIG = {
  apiKey: '',
  betaHeader: 'managed-agents-2026-04-01',
  baseUrl: 'https://api.anthropic.com/v1',
  syncIntervalMs: 60000,
  maxHistorySize: 100,
  requestTimeoutMs: 15000,
};

/**
 * CMA结果桥接器，将CMA模型输出转换为Harness工作流可消费的结构化结果
 *
 * @classdesc CMA结果桥接器，将CMA模型输出转换为Harness工作流可消费的结构化结果
 * @extends EventEmitter
 */
class CMAOutcomesBridge extends EventEmitter {
  /**
   * @param {Object} config - 桥接器配置
   */
  constructor(config) {
    super();
    this._config = safeAssign.mergeConfig(DEFAULT_BRIDGE_CONFIG, config ?? {});
    this._syncHistory = new BoundedArray(this._config.maxHistorySize);
    this._pendingOutcomes = new BoundedArray(MAX_PENDING_OUTCOMES);
    this._syncTimer = null;
    this._dreamOutcomes = null;
    this._skillImprovementLoop = null;
    this._stats = { pushed: 0, pulled: 0, failures: 0 };
    this._log = debug('CMAOutcomesBridge');
  }

  get stats() { if (this._shutDown) return { outcomesProcessed: 0, bridgeActive: false, historySize: 0 }; return { ...this._stats }; }

  /**
   * 绑定 DreamOutcomes 实例，用于后续同步
   * @param {Object} dreamOutcomes - DreamOutcomes 实例
   * @returns {CMAOutcomesBridge} 当前实例（支持链式调用）
   */
  attachDreamOutcomes(dreamOutcomes) {
    this.guardShutdown();
    this._dreamOutcomes = dreamOutcomes;
    this._log('attachDreamOutcomes', 'attached');
    return this;
  }

  /**
   * 绑定技能改进循环实例，用于接收远程拉取的成果
   * @param {Object} loop - SkillImprovementLoop 实例
   * @returns {CMAOutcomesBridge} 当前实例（支持链式调用）
   */
  attachSkillImprovementLoop(loop) {
    this.guardShutdown();
    this._skillImprovementLoop = loop;
    this._log('attachSkillImprovementLoop', 'attached');
    return this;
  }

  /**
   * 初始化成果桥接适配器，检查 API Key 是否可用
   * @returns {Promise<boolean>} 是否初始化成功（无 API Key 时返回 false，进入离线模式）
   */
  async initialize() {
    if (!this._config.apiKey) {
      this._log('initialize', 'No API key, outcomes bridge in offline mode');
      return false;
    }
    this._log('initialize', 'Outcomes bridge ready');
    return true;
  }

  /**
   * 启动定时自动同步，按配置的 syncIntervalMs 间隔执行 syncPending
   */
  startAutoSync() {
    this.guardShutdown();
    if (this._syncTimer) return;
    this._syncTimer = setInterval(() => {
      if (this._shutDown) return;
      this.syncPending().catch((err) => {
        this._log('autoSync', 'Sync failed: ' + (err && err.message ? err.message : String(err)));
      });
    }, this._config.syncIntervalMs);
    if (this._syncTimer && typeof this._syncTimer.unref === 'function') this._syncTimer.unref();
  }

  /**
   * 停止定时自动同步
   */
  stopAutoSync() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  }

  /**
   * 将成果推入待同步队列，等待下次同步时上传到 CMA
   * @param {Object} outcome - 成果对象，必须包含 id 字段
   * @param {string} outcome.id - 成果唯一标识
   * @returns {boolean} 是否成功加入队列（已关闭或成果无效时返回 false）
   */
  pushOutcome(outcome) {
    if (this._shutDown) return false;
    if (!outcome || !outcome.id) return false;
    this._pendingOutcomes.push(outcome);
    this._log('pushOutcome', outcome.id);
    return true;
  }

  /**
   * 同步所有待推送成果到 CMA，并拉取远程成果到本地
   * @returns {Promise<{pushed: number, pulled: number}>} 推送和拉取的成果数量
   * @emits 'sync-to-cma' 推送成果到 CMA 成功时触发
   * @emits 'sync-from-cma' 从 CMA 拉取成果成功时触发
   * @emits 'sync-error' 同步过程中发生错误时触发
   */
  async syncPending() {
    if (this._shutDown) return { pushed: 0, pulled: 0 };
    if (!this._config.apiKey || this._pendingOutcomes.length === 0) {
      return { pushed: 0, pulled: 0 };
    }
    const toPush = this._pendingOutcomes.toArray();
    this._pendingOutcomes.clear();
    let pushed = 0;
    for (const outcome of toPush) {
      try {
        const sent = await this._sendOutcome(outcome);
        if (sent === null) continue;
        pushed++;
        this._stats.pushed++;
        this._syncHistory.push({ direction: 'push', outcomeId: outcome.id, ts: Date.now() });
      } catch (err) {
        this._stats.failures++;
        const msg = err && err.message ? err.message : String(err);
        this._log('syncPending', 'Push failed: ' + msg);
        this.emit(BRIDGE_EVENTS.SYNC_ERROR, { direction: 'push', outcomeId: outcome.id, error: msg });
      }
    }
    let pulled = 0;
    try {
      const remoteOutcomes = await this._fetchOutcomes();
      for (const ro of remoteOutcomes) {
        if (this._skillImprovementLoop && typeof this._skillImprovementLoop.recordOutcome === 'function') {
          this._skillImprovementLoop.recordOutcome(ro);
        }
        pulled++;
        this._stats.pulled++;
        this._syncHistory.push({ direction: 'pull', outcomeId: ro.id, ts: Date.now() });
      }
      if (pulled > 0) this.emit(BRIDGE_EVENTS.SYNC_FROM_CMA, { count: pulled });
    } catch (err) {
      this._stats.failures++;
      const msg = err && err.message ? err.message : String(err);
      this._log('syncPending', 'Pull failed: ' + msg);
      this.emit(BRIDGE_EVENTS.SYNC_ERROR, { direction: 'pull', error: msg });
    }
    if (pushed > 0) this.emit(BRIDGE_EVENTS.SYNC_TO_CMA, { count: pushed });
    return { pushed, pulled };
  }

  /**
   * 从 CMA 拉取远程成果列表
   * @returns {Promise<Object[]>} 远程成果数组，失败或已关闭时返回空数组
   */
  async pullOutcomes() {
    if (this._shutDown) return [];
    if (!this._config.apiKey) return [];
    try {
      return await this._fetchOutcomes();
    } catch (_err) {
      debug('CmaOutcomesBridge', 'fetchOutcomes', _err && _err.message ? _err.message : String(_err));
      this._stats.failures++;
      return [];
    }
  }

  async _sendOutcome(outcome) {
    try {
      const url = this._config.baseUrl + '/sessions/' + encodeURIComponent(outcome.sessionId || 'default') + '/events';
      await this._request('POST', url, JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: JSON.stringify({ action: 'outcome', data: outcome }) }] }],
      }));
    } catch (err) {
      this._log('_sendOutcome', err.message || String(err));
      return null;
    }
  }

  async _fetchOutcomes() {
    const url = this._config.baseUrl + '/sessions?filter=outcome&limit=50';
    const resp = await this._request('GET', url);
    const sessions = Array.isArray(resp) ? resp : (resp.data ?? []);
    const outcomes = [];
    for (const s of sessions) {
      if (s.outcomes) outcomes.push(...s.outcomes);
    }
    return outcomes;
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
        hostname: parsedUrl.hostname, port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search, method, headers,
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
            try { resolve(safeJsonParse(data, data)); } catch (_e) { debug('CMAOutcomesBridge', 'jsonParseFallback', _e && _e.message ? _e.message : String(_e)); resolve(data); }
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
    this.stopAutoSync();
    this._pendingOutcomes.shutdown();
    this._syncHistory.shutdown();
    this.removeAllListeners();
  }
}

CMAOutcomesBridge.EVENTS = BRIDGE_EVENTS;
CMAOutcomesBridge.DEFAULT_CONFIG = DEFAULT_BRIDGE_CONFIG;

module.exports = { CMAOutcomesBridge: withShutdown(CMAOutcomesBridge), BRIDGE_EVENTS, DEFAULT_BRIDGE_CONFIG };
