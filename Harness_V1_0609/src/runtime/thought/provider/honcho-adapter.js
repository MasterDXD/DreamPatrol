'use strict';

/**
 * @module runtime/thought/provider/honcho-adapter
 * @classdesc Honcho适配器。AI原生记忆平台、用户级/会话级记忆管理
 * HonchoAdapter — Honcho memory provider adapter with user-based memory and session management
 */

const http = require('http');
const https = require('https');
const ProviderAdapterBase = require('./provider-adapter-base');
const { safeJsonParse } = require('../../../utils/safe-parse');
const { debug } = require('../../../utils/debug-logger');
const { mergeConfig } = require('../../../utils/safe-assign');

const DEFAULT_HONCHO_CONFIG = {
  endpoint: 'https://api.honcho.ai',
  apiKey: '',
  userId: '',
};

/**
 * Honcho记忆提供者适配器。连接Honcho API实现基于用户的记忆管理，
 * 支持会话创建和列表查询。
 *
 * @extends ProviderAdapterBase
 */
class HonchoAdapter extends ProviderAdapterBase {
  /**
   * 创建HonchoAdapter实例。
   *
   * @param {Object} [config] - Honcho配置
   * @param {string} [config.endpoint='https://api.honcho.ai'] - API端点
   * @param {string} [config.apiKey=''] - API密钥
   * @param {string} [config.userId=''] - 用户ID
   */
  constructor(config) {
    super(config);
    this._honchoConfig = mergeConfig(DEFAULT_HONCHO_CONFIG, config ?? {});
    this._log = debug('HonchoAdapter');
  }

  /**
   * 获取提供者名称。
   *
   * @returns {string} 名称标识'honcho'
   */
  getName() {
    return 'honcho';
  }

  /**
   * 获取Honcho提供者支持的能力列表。
   *
   * @returns {{recall: boolean, write: boolean, sync: boolean, semanticSearch: boolean, userIsolation: boolean}} 能力映射
   */
  getCapabilities() {
    return {
      recall: true,
      write: true,
      sync: false,
      semanticSearch: true,
      userIsolation: true,
    };
  }

  _buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (this._honchoConfig.apiKey) {
      headers['Authorization'] = 'Bearer ' + this._honchoConfig.apiKey;
    }
    return headers;
  }

  _makeRequest(method, path, body) {
    const self = this;
    return new Promise(function(resolve, reject) {
      let settled = false;
      const safeResolve = (val) => { if (!settled) { settled = true; resolve(val); } };
      const safeReject = (err) => { if (!settled) { settled = true; reject(err); } };
      const urlStr = self._honchoConfig.endpoint + path;
      let parsed;
      try {
        parsed = new URL(urlStr);
      } catch (err) {
        safeReject(new Error('Invalid URL: ' + urlStr + ' - ' + (err && err.message ? err.message : String(err))));
        return;
      }
      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;
      const payload = body ? JSON.stringify(body) : null;
      const headers = self._buildHeaders();
      if (payload) {
        headers['Content-Length'] = String(Buffer.byteLength(payload));
      }
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: method,
        headers: headers,
      };
      const req = transport.request(options, function(res) {
        const chunks = [];
        res.on('data', function(chunk) { chunks.push(chunk); });
        res.on('error', function(err) { safeReject(err); });
        res.on('end', function() {
          const rawData = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = safeJsonParse(rawData, rawData, 'HonchoAdapter'); } catch (_e) { data = rawData; }
          if (res.statusCode >= 400) {
            const err = new Error('honcho API error: ' + String(res.statusCode));
            err.statusCode = res.statusCode;
            err.body = data;
            safeReject(err);
            return;
          }
          safeResolve(data);
        });
      });
      req.on('error', function(err) { safeReject(err); });
      req.setTimeout(self._adapterConfig.requestTimeoutMs, function() {
        req.destroy();
        safeReject(new Error('request timeout'));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  _userPath() {
    return '/users/' + encodeURIComponent(String(this._honchoConfig.userId));
  }

  async _doConnect() {
    if (!this._honchoConfig.userId) return;
    await this._makeRequest('GET', this._userPath() + '/memories?limit=1');
  }

  async _doDisconnect() {
    this._connected = false;
  }

  async _doHealthCheck() {
    if (!this._honchoConfig.userId) return { healthy: true };
    return this._makeRequest('GET', this._userPath() + '/memories?limit=1');
  }

  async _doRecall(query, options) {
    const opts = options ?? {};
    const searchQuery = typeof query === 'string' ? query : String(query);
    const params = new URLSearchParams({ q: searchQuery });
    if (opts.limit != null) params.set('limit', String(opts.limit));
    const data = await this._makeRequest('GET', this._userPath() + '/memories?' + params.toString());
    const results = Array.isArray(data) ? data : (data && Array.isArray(data.results) ? data.results : []);
    return results.map(function(item) {
      return {
        data: item,
        confidence: item.score ?? item.relevance ?? 0.5,
        source: 'honcho',
        timestamp: item.created_at ?? Date.now(),
      };
    });
  }

  async _doWrite(entry) {
    const body = {
      content: entry.content ?? String(entry),
    };
    if (entry.metadata) body.metadata = entry.metadata;
    const data = await this._makeRequest('POST', this._userPath() + '/memories', body);
    return {
      success: true,
      id: data ? (data.id ?? data.memory_id) : null,
    };
  }

  async _doQuery(filter) {
    const params = new URLSearchParams();
    if (filter && filter.query) params.set('q', filter.query);
    if (filter && filter.limit) params.set('limit', String(filter.limit));
    const data = await this._makeRequest('GET', this._userPath() + '/memories?' + params.toString());
    return Array.isArray(data) ? data : (data && Array.isArray(data.results) ? data.results : []);
  }

  async _doDelete(id) {
    await this._makeRequest('DELETE', this._userPath() + '/memories/' + String(id));
    return true;
  }

  async _doSync(entries, direction) {
    let pushed = 0;
    let pulled = 0;
    if (direction === 'push' || direction === 'bidirectional') {
      const items = Array.isArray(entries) ? entries : [];
      for (const entry of items) {
        try {
          await this._doWrite(entry);
          pushed++;
        } catch (err) {
          this._log('sync_push', err && err.message ? err.message : String(err));
        }
      }
    }
    if (direction === 'pull' || direction === 'bidirectional') {
      try {
        const data = await this._makeRequest('GET', this._userPath() + '/memories');
        pulled = Array.isArray(data) ? data.length : 0;
      } catch (err) {
        this._log('sync_pull', err && err.message ? err.message : String(err));
      }
    }
    return { pushed, pulled };
  }

  /**
   * 创建新的Honcho会话。
   *
   * @param {Object} [sessionData] - 会话数据
   * @returns {Promise<*>} 创建的会话对象
   */
  async createSession(sessionData) {
    this.guardShutdown();
    const body = sessionData ?? {};
    return this._makeRequest('POST', this._userPath() + '/sessions', body);
  }

  /**
   * 列出当前用户的所有Honcho会话。
   *
   * @returns {Promise<*>} 会话列表
   */
  async listSessions() {
    this.guardShutdown();
    return this._makeRequest('GET', this._userPath() + '/sessions');
  }
}

HonchoAdapter.DEFAULT_HONCHO_CONFIG = DEFAULT_HONCHO_CONFIG;

module.exports = HonchoAdapter;
