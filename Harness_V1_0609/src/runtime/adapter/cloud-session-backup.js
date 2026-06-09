'use strict';

/**
 * @module runtime/adapter/cloud-session-backup
 * CloudSessionBackup — Backs up Harness session snapshots to Claude Managed Agents
 */

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { safeJsonParse, safeStringify } = require('../../utils/safe-parse');
const safeAssign = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const { withShutdown } = require('../../utils/shutdown-mixin');

const MAX_BACKUP_SESSIONS = 50;

const BACKUP_EVENTS = {
  BACKUP_SUCCESS: 'backup-success',
  BACKUP_FAILED: 'backup-failed',
  RESTORE_SUCCESS: 'restore-success',
  RESTORE_FAILED: 'restore-failed',
};

const DEFAULT_BACKUP_CONFIG = {
  apiKey: '',
  betaHeader: 'managed-agents-2026-04-01',
  baseUrl: 'https://api.anthropic.com/v1',
  agentId: '',
  environmentId: '',
  autoBackupIntervalMs: 300000,
  maxBackupHistory: 50,
  requestTimeoutMs: 30000,
};

/**
 * 云端会话备份服务，支持会话状态的远程持久化和恢复
 *
 * @classdesc 云端会话备份服务，支持会话状态的远程持久化和恢复
 * @extends EventEmitter
 */
class CloudSessionBackup extends EventEmitter {
  /**
   * @param {Object} config - 备份服务配置
   */
  constructor(config) {
    super();
    this._config = safeAssign.mergeConfig(DEFAULT_BACKUP_CONFIG, config ?? {});
    this._cmaSessionMap = new BoundedMap(this._config.maxBackupHistory, {
      onEvict: (key) => { this.stopAutoBackup(key); },
    });
    this._backupTimers = new Map();
    this._stats = { backups: 0, restores: 0, failures: 0 };
    this._log = debug('CloudSessionBackup');
  }

  get stats() { if (this._shutDown) return { backups: 0, lastBackup: null, totalSize: 0 }; return { ...this._stats }; }

  /**
   * 初始化云会话备份适配器，检查 API Key 是否可用
   * @returns {boolean} 是否初始化成功（无 API Key 时返回 false）
   */
  initialize() {
    if (!this._config.apiKey) {
      this._log('initialize', 'No API key, cloud backup disabled');
      return false;
    }
    this._log('initialize', 'Cloud session backup ready');
    return true;
  }

  /**
   * 将会话数据备份到 CMA 云端
   * @param {string} sessionId - Harness 会话标识
   * @param {Object} sessionData - 需要备份的会话数据
   * @returns {Promise<{success: boolean, cmaSessionId?: string, reason?: string}>} 备份结果
   * @emits 'backup-success' 备份成功时触发
   * @emits 'backup-failed' 备份失败时触发
   */
  async backup(sessionId, sessionData) {
    if (this._shutDown) return { success: false, reason: 'shutting down' };
    if (!this._config.apiKey) {
      this._log('backup', 'No API key, skipping backup');
      return { success: false, reason: 'no-api-key' };
    }
    try {
      let cmaSessionId = this._cmaSessionMap.get(sessionId);
      if (!cmaSessionId) {
        cmaSessionId = await this._createCMASession(sessionId);
        this._cmaSessionMap.set(sessionId, cmaSessionId);
      }
      await this._sendEvent(cmaSessionId, {
        type: 'user.message',
        content: [{ type: 'text', text: safeStringify({ action: 'backup', sessionId, data: sessionData, ts: Date.now() }) }],
      });
      this._stats.backups++;
      this.emit(BACKUP_EVENTS.BACKUP_SUCCESS, { sessionId, cmaSessionId });
      return { success: true, cmaSessionId };
    } catch (err) {
      this._stats.failures++;
      const msg = err && err.message ? err.message : String(err);
      this._log('backup', 'Failed: ' + msg);
      this.emit(BACKUP_EVENTS.BACKUP_FAILED, { sessionId, error: msg });
      return { success: false, reason: msg };
    }
  }

  /**
   * 从 CMA 云端恢复会话数据
   * @param {string} sessionId - 需要恢复的会话标识
   * @returns {Promise<{success: boolean, data?: Object, reason?: string}>} 恢复结果，成功时 data 为最新备份数据
   * @emits 'restore-success' 恢复成功时触发
   * @emits 'restore-failed' 恢复失败时触发
   */
  async restore(sessionId) {
    if (this._shutDown) return { success: false, reason: 'shutting down' };
    if (!this._config.apiKey) {
      this._log('restore', 'No API key, cannot restore');
      return { success: false, reason: 'no-api-key' };
    }
    try {
      const cmaSessionId = this._cmaSessionMap.get(sessionId);
      if (!cmaSessionId) {
        return { success: false, reason: 'no-cma-session' };
      }
      const events = await this._fetchEvents(cmaSessionId);
      let lastBackup = null;
      for (const evt of events) {
        if (evt.type === 'user.message' && evt.content) {
          try {
            let contentStr = evt.content;
            if (Array.isArray(evt.content)) {
              const textBlock = evt.content.find(function(b) { return b && b.type === 'text'; });
              contentStr = textBlock ? textBlock.text : null;
            }
            const parsed = contentStr ? safeJsonParse(contentStr) : null;
            if (parsed && parsed.action === 'backup' && parsed.sessionId === sessionId) {
              lastBackup = parsed.data;
            }
          } catch (_e) { debug('CloudSessionBackup', 'restore:parseEvent', _e && _e.message ? _e.message : String(_e)); }
        }
      }
      if (!lastBackup) {
        return { success: false, reason: 'no-backup-found' };
      }
      this._stats.restores++;
      this.emit(BACKUP_EVENTS.RESTORE_SUCCESS, { sessionId, cmaSessionId });
      return { success: true, data: lastBackup };
    } catch (err) {
      this._stats.failures++;
      const msg = err && err.message ? err.message : String(err);
      this._log('restore', 'Failed: ' + msg);
      this.emit(BACKUP_EVENTS.RESTORE_FAILED, { sessionId, error: msg });
      return { success: false, reason: msg };
    }
  }

  /**
   * 启动指定会话的定时自动备份
   * @param {string} sessionId - 会话标识
   * @param {Function} getSessionData - 获取当前会话数据的回调函数
   */
  startAutoBackup(sessionId, getSessionData) {
    this.guardShutdown();
    if (this._backupTimers.has(sessionId)) return;
    if (this._backupTimers.size >= MAX_BACKUP_SESSIONS) return;
    const timer = setInterval(() => {
      if (this._shutDown) return;
      let data;
      try { data = getSessionData(); } catch (_err) { debug('CloudSessionBackup', 'autoBackup', 'getSessionData failed'); return; }
      if (data != null) {
        this.backup(sessionId, data).catch((err) => {
          this._log('autoBackup', 'Backup failed: ' + (err && err.message ? err.message : String(err)));
        });
      }
    }, this._config.autoBackupIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this._backupTimers.set(sessionId, timer);
  }

  /**
   * 停止指定会话的定时自动备份
   * @param {string} sessionId - 会话标识
   */
  stopAutoBackup(sessionId) {
    const timer = this._backupTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this._backupTimers.delete(sessionId);
    }
  }

  async _createCMASession(harnessSessionId) {
    const url = this._config.baseUrl + '/sessions';
    const body = JSON.stringify({
      agent: this._config.agentId,
      environment_id: this._config.environmentId,
      title: 'harness-backup-' + harnessSessionId,
    });
    const resp = await this._request('POST', url, body);
    if (!resp || !resp.id) throw new Error('Failed to create CMA session: invalid response');
    return resp.id;
  }

  async _sendEvent(cmaSessionId, event) {
    const url = this._config.baseUrl + '/sessions/' + encodeURIComponent(cmaSessionId) + '/events';
    await this._request('POST', url, JSON.stringify({ events: [event] }));
  }

  async _fetchEvents(cmaSessionId) {
    const url = this._config.baseUrl + '/sessions/' + encodeURIComponent(cmaSessionId) + '/events';
    const resp = await this._request('GET', url);
    return Array.isArray(resp) ? resp : (resp.data ?? []);
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
            try { resolve(safeJsonParse(data, data)); } catch (_e) { debug('CloudSessionBackup', 'jsonParseFallback', _e && _e.message ? _e.message : String(_e)); resolve(data); }
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
    for (const [, timer] of this._backupTimers) {
      clearInterval(timer);
    }
    this._backupTimers.clear();
    this._cmaSessionMap.shutdown();
    this.removeAllListeners();
  }
}

CloudSessionBackup.EVENTS = BACKUP_EVENTS;
CloudSessionBackup.DEFAULT_CONFIG = DEFAULT_BACKUP_CONFIG;

module.exports = { CloudSessionBackup: withShutdown(CloudSessionBackup), BACKUP_EVENTS, DEFAULT_BACKUP_CONFIG };
