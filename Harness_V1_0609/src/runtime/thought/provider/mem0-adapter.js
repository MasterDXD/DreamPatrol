'use strict';

/**
 * @module runtime/thought/provider/mem0-adapter
 * @classdesc mem0适配器。云端/自托管记忆服务REST API集成
 * Mem0Adapter — Mem0 memory provider adapter with semantic search and bidirectional sync
 */

const http = require('http');
const https = require('https');
const ProviderAdapterBase = require('./provider-adapter-base');
const { safeJsonParse } = require('../../../utils/safe-parse');
const { debug } = require('../../../utils/debug-logger');
const { mergeConfig } = require('../../../utils/safe-assign');

const DEFAULT_MEM0_CONFIG = {
  endpoint: 'https://api.mem0.ai',
  apiKey: '',
  userId: '',
  projectId: '',
};

/**
 * Mem0记忆提供者适配器。连接Mem0 API实现基于用户和项目的记忆管理，
 * 支持语义搜索和双向同步。
 *
 * @extends ProviderAdapterBase
 */
class Mem0Adapter extends ProviderAdapterBase {
  /**
   * 创建Mem0Adapter实例。
   *
   * @param {Object} [config] - Mem0配置
   * @param {string} [config.endpoint='https://api.mem0.ai'] - API端点
   * @param {string} [config.apiKey=''] - API密钥
   * @param {string} [config.userId=''] - 用户ID
   * @param {string} [config.projectId=''] - 项目ID
   */
  constructor(config) {
    super(config);
    this._mem0Config = mergeConfig(DEFAULT_MEM0_CONFIG, config ?? {});
    this._log = debug('Mem0Adapter');
  }

  /**
   * 获取提供者名称。
   *
   * @returns {string} 名称标识'mem0'
   */
  getName() {
    return 'mem0';
  }

  /**
   * 获取Mem0提供者支持的能力列表。
   *
   * @returns {{recall: boolean, write: boolean, sync: boolean, semanticSearch: boolean, userIsolation: boolean}} 能力映射
   */
  getCapabilities() {
    return {
      recall: true,
      write: true,
      sync: true,
      semanticSearch: true,
      userIsolation: true,
    };
  }

  _buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (this._mem0Config.apiKey) {
      headers['Authorization'] = 'Token ' + this._mem0Config.apiKey;
    }
    return headers;
  }

  _makeRequest(method, path, body) {
    const self = this;
    return new Promise(function(resolve, reject) {
      let settled = false;
      const safeResolve = (val) => { if (!settled) { settled = true; resolve(val); } };
      const safeReject = (err) => { if (!settled) { settled = true; reject(err); } };
      const urlStr = self._mem0Config.endpoint + path;
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
          try { data = safeJsonParse(rawData, rawData, 'Mem0Adapter'); } catch (_e) { data = rawData; }
          if (res.statusCode >= 400) {
            const err = new Error('mem0 API error: ' + String(res.statusCode));
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

  async _doConnect() {
    await this._makeRequest('GET', '/v1/memories/?limit=1');
  }

  async _doDisconnect() {
    this._connected = false;
  }

  async _doHealthCheck() {
    return this._makeRequest('GET', '/v1/memories/?limit=1');
  }

  async _doRecall(query, options) {
    const opts = options ?? {};
    const searchQuery = typeof query === 'string' ? query : String(query);
    const params = new URLSearchParams({ q: searchQuery });
    if (this._mem0Config.userId) params.set('user_id', this._mem0Config.userId);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    const data = await this._makeRequest('GET', '/v1/memories/?' + params.toString());
    const results = Array.isArray(data) ? data : (data && Array.isArray(data.results) ? data.results : []);
    return results.map(function(item) {
      return {
        data: item,
        confidence: item.score ?? 0.5,
        source: 'mem0',
        timestamp: item.created_at ?? Date.now(),
      };
    });
  }

  async _doWrite(entry) {
    const body = {
      messages: entry.messages ?? [{ role: 'user', content: entry.content ?? String(entry) }],
    };
    if (this._mem0Config.userId) body.user_id = this._mem0Config.userId;
    if (entry.metadata) body.metadata = entry.metadata;
    const data = await this._makeRequest('POST', '/v1/memories/', body);
    return {
      success: true,
      id: data ? (data.id ?? data.memory_id) : null,
    };
  }

  async _doQuery(filter) {
    const params = new URLSearchParams();
    if (this._mem0Config.userId) params.set('user_id', this._mem0Config.userId);
    if (filter && filter.query) params.set('q', filter.query);
    if (filter && filter.limit) params.set('limit', String(filter.limit));
    const data = await this._makeRequest('GET', '/v1/memories/?' + params.toString());
    return Array.isArray(data) ? data : (data && Array.isArray(data.results) ? data.results : []);
  }

  async _doDelete(id) {
    await this._makeRequest('DELETE', '/v1/memories/' + encodeURIComponent(String(id)) + '/');
    return true;
  }

  async _doSync(entries, direction) {
    let pulled = 0;
    if (direction === 'pull' || direction === 'bidirectional') {
      const params = new URLSearchParams();
      if (this._mem0Config.userId) params.set('user_id', this._mem0Config.userId);
      const data = await this._makeRequest('GET', '/v1/memories/?' + params.toString());
      pulled = Array.isArray(data) ? data.length : 0;
      if (direction === 'pull') return { pushed: 0, pulled };
    }
    let pushed = 0;
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
    return { pushed, pulled };
  }
}

Mem0Adapter.DEFAULT_MEM0_CONFIG = DEFAULT_MEM0_CONFIG;

module.exports = Mem0Adapter;
