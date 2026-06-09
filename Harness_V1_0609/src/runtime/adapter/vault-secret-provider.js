'use strict';

/**
 * @module runtime/adapter/vault-secret-provider
 * VaultSecretProvider — Stores and retrieves secrets via CMA Vault API
 */

const ProviderAdapterBase = require('../thought/provider/provider-adapter-base');
const { debug } = require('../../utils/debug-logger');
const safeAssign = require('../../utils/safe-assign');
const { safeJsonParse } = require('../../utils/safe-parse');
const BoundedMap = require('../../utils/bounded-map');

const VAULT_EVENTS = {
  SECRET_WRITTEN: 'secret-written',
  SECRET_READ: 'secret-read',
  SECRET_DELETED: 'secret-deleted',
  VAULT_ERROR: 'vault-error',
};

const DEFAULT_VAULT_CONFIG = {
  apiKey: '',
  betaHeader: 'managed-agents-2026-04-01',
  baseUrl: 'https://api.anthropic.com/v1',
  vaultId: '',
  maxCacheSize: 200,
  cacheTtlMs: 300000,
  requestTimeoutMs: 15000,
};

/**
 * Vault密钥提供者，从外部密钥管理服务获取和缓存敏感凭证
 *
 * @classdesc Vault密钥提供者，从外部密钥管理服务获取和缓存敏感凭证
 * @extends ProviderAdapterBase
 */
class VaultSecretProvider extends ProviderAdapterBase {
  /**
   * @param {Object} config - 密钥提供者配置
   */
  constructor(config) {
    super(config);
    this._vaultConfig = safeAssign.mergeConfig(DEFAULT_VAULT_CONFIG, config ?? {});
    this._localCache = new BoundedMap(this._vaultConfig.maxCacheSize);
    this._cacheTimestamps = new BoundedMap(this._vaultConfig.maxCacheSize);
    this._stats = { writes: 0, reads: 0, cacheHits: 0, failures: 0 };
    this._log = debug('VaultSecretProvider');
  }

  get stats() { if (this._shutDown) return { cacheSize: 0, secretsLoaded: 0, lastRefresh: null }; return { ...this._stats }; }

  /**
   * 获取提供者名称
   * @returns {string} 提供者名称标识
   */
  getName() { return 'vault-secret-provider'; }

  /**
   * 获取提供者能力描述
   * @returns {{recall: boolean, write: boolean, sync: boolean, semanticSearch: boolean, userIsolation: boolean}} 能力映射
   */
  getCapabilities() {
    return { recall: true, write: true, sync: false, semanticSearch: false, userIsolation: true };
  }

  /**
   * 连接到 Vault 服务，无 API Key 时进入离线模式
   * @param {Object} [config] - 连接配置
   * @returns {Promise<void>}
   */
  async connect(config) {
    if (!this._vaultConfig.apiKey) {
      this._log('connect', 'No API key, vault provider in offline mode');
      this._connected = true;
      this._healthy = true;
      return;
    }
    await super.connect(config);
    this._log('connect', 'Vault secret provider connected');
  }

  /**
   * 写入密钥到 Vault，同时更新本地缓存
   * @param {Object} entry - 密钥条目
   * @param {string} entry.key - 密钥名称
   * @param {*} entry.value - 密钥值
   * @param {Object} [entry.metadata] - 附加元数据
   * @returns {Promise<{success: boolean, id: string|null}>} 写入结果，成功时 id 为密钥名称
   * @emits 'secret-written' 密钥写入成功时触发
   * @emits 'vault-error' 写入失败时触发
   */
  async write(entry) {
    if (this._shutDown) return { success: false, id: null };
    if (!entry || !entry.key) return { success: false, id: null };
    this._stats.writes++;
    this._localCache.set(entry.key, entry.value);
    this._cacheTimestamps.set(entry.key, Date.now());
    if (!this._vaultConfig.apiKey) return { success: true, id: entry.key };
    try {
      await this._vaultRequest('PUT', '/secrets/' + encodeURIComponent(entry.key), {
        value: entry.value, metadata: entry.metadata ?? {},
      });
      if (this._shutDown) return { success: false };
      this.emit(VAULT_EVENTS.SECRET_WRITTEN, { key: entry.key });
      return { success: true, id: entry.key };
    } catch (_err) {
      this._stats.failures++;
      const msg = _err && _err.message ? _err.message : String(_err);
      this._log('write', 'Failed: ' + msg);
      this.emit(VAULT_EVENTS.VAULT_ERROR, { operation: 'write', key: entry.key, error: msg });
      return { success: false, id: null };
    }
  }

  /**
   * 从 Vault 读取密钥，优先从本地缓存获取
   * @param {string|Object} query - 密钥名称或包含 key 字段的查询对象
   * @param {Object} [_options] - 查询选项（保留参数）
   * @returns {Promise<Array<{key: string, value: *}>>} 匹配的密钥列表，未找到时返回空数组
   * @emits 'secret-read' 密钥读取成功时触发
   * @emits 'vault-error' 读取失败时触发
   */
  async recall(query, _options) {
    if (this._shutDown) return [];
    this._stats.reads++;
    const key = typeof query === 'string' ? query : (query && query.key);
    if (!key) return [];
    const cached = this._getCached(key);
    if (cached !== undefined) {
      this._stats.cacheHits++;
      return [{ key, value: cached }];
    }
    if (!this._vaultConfig.apiKey) return [];
    try {
      const resp = await this._vaultRequest('GET', '/secrets/' + encodeURIComponent(key));
      if (this._shutDown) return [];
      const value = resp && resp.value !== undefined ? resp.value : null;
      this._localCache.set(key, value);
      this._cacheTimestamps.set(key, Date.now());
      this.emit(VAULT_EVENTS.SECRET_READ, { key });
      return [{ key, value }];
    } catch (_err) {
      this._stats.failures++;
      const msg = _err && _err.message ? _err.message : String(_err);
      this._log('recall', 'Failed: ' + msg);
      this.emit(VAULT_EVENTS.VAULT_ERROR, { operation: 'recall', key, error: msg });
      return [];
    }
  }

  /**
   * 从 Vault 删除指定密钥
   * @param {string} id - 需要删除的密钥名称
   * @returns {Promise<boolean>} 是否删除成功
   * @emits 'secret-deleted' 密钥删除成功时触发
   */
  async delete(id) {
    if (this._shutDown) return false;
    if (!this._vaultConfig.apiKey) {
      this._localCache.delete(id);
      this._cacheTimestamps.delete(id);
      return true;
    }
    try {
      await this._vaultRequest('DELETE', '/secrets/' + encodeURIComponent(id));
      if (this._shutDown) return false;
      this._localCache.delete(id);
      this._cacheTimestamps.delete(id);
      this.emit(VAULT_EVENTS.SECRET_DELETED, { key: id });
      return true;
    } catch (_err) {
      debug('VaultSecretProvider', 'delete', _err && _err.message ? _err.message : String(_err));
      this._stats.failures++;
      return false;
    }
  }

  _getCached(key) {
    const ts = this._cacheTimestamps.get(key);
    if (ts === undefined) return undefined;
    if (Date.now() - ts > this._vaultConfig.cacheTtlMs) {
      this._localCache.delete(key);
      this._cacheTimestamps.delete(key);
      return undefined;
    }
    return this._localCache.get(key);
  }

  async _vaultRequest(method, path, body) {
    const http = require('https');
    const self = this;
    let url;
    try {
      url = new URL(this._vaultConfig.baseUrl + path);
    } catch (err) {
      throw new Error('Invalid Vault URL: ' + this._vaultConfig.baseUrl + path + ' - ' + (err && err.message ? err.message : String(err)), { cause: err });
    }
    const headers = {
      'x-api-key': this._vaultConfig.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': this._vaultConfig.betaHeader,
      'content-type': 'application/json',
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      let resRef = null;
      const req = http.request({
        hostname: url.hostname, port: url.port || 443,
        path: url.pathname + url.search, method, headers,
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
            try { resolve(safeJsonParse(data, data)); } catch (_e) { debug('VaultSecretProvider', 'jsonParseFallback', _e && _e.message ? _e.message : String(_e)); resolve(data); }
          } else {
            reject(new Error('Vault API ' + res.statusCode + ': ' + data.slice(0, 200)));
          }
        });
      });
      req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
      req.setTimeout(self._vaultConfig.requestTimeoutMs, () => {
        if (!settled) { settled = true; req.destroy(); if (resRef && !resRef.destroyed) resRef.destroy(); reject(new Error('Request timeout')); }
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  _onShutdown() {
    this._shutDown = true;
    this._localCache.shutdown();
    this._cacheTimestamps.shutdown();
    this.removeAllListeners();
    super._onShutdown();
  }
}

VaultSecretProvider.EVENTS = VAULT_EVENTS;
VaultSecretProvider.DEFAULT_CONFIG = DEFAULT_VAULT_CONFIG;

module.exports = { VaultSecretProvider, VAULT_EVENTS, DEFAULT_VAULT_CONFIG };
