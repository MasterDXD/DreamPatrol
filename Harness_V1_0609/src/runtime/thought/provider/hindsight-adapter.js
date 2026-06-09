'use strict';

/**
 * @module runtime/thought/provider/hindsight-adapter
 * @classdesc Hindsight适配器。本地部署记忆服务、记忆蒸馏
 * HindsightAdapter — Hindsight memory provider adapter for recall, write, query, delete, sync, and distill
 */

const http = require('http');
const https = require('https');
const ProviderAdapterBase = require('./provider-adapter-base');
const { safeJsonParse } = require('../../../utils/safe-parse');
const { debug } = require('../../../utils/debug-logger');
const { mergeConfig } = require('../../../utils/safe-assign');

const DEFAULT_HINDSIGHT_CONFIG = {
  endpoint: 'http://localhost:8100',
  apiKey: '',
  dataDir: '',
};

/**
 * Hindsight记忆提供者适配器。连接Hindsight API实现记忆的召回、写入、
 * 查询、删除、同步和蒸馏操作。
 *
 * @extends ProviderAdapterBase
 */
class HindsightAdapter extends ProviderAdapterBase {
  /**
   * 创建HindsightAdapter实例。
   *
   * @param {Object} [config] - Hindsight配置
   * @param {string} [config.endpoint='http://localhost:8100'] - API端点
   * @param {string} [config.apiKey=''] - API密钥
   * @param {string} [config.dataDir=''] - 数据目录
   */
  constructor(config) {
    super(config);
    this._hindsightConfig = mergeConfig(DEFAULT_HINDSIGHT_CONFIG, config ?? {});
    this._log = debug('HindsightAdapter');
  }

  /**
   * 获取提供者名称。
   *
   * @returns {string} 名称标识'hindsight'
   */
  getName() {
    return 'hindsight';
  }

  /**
   * 获取Hindsight提供者支持的能力列表。
   *
   * @returns {{recall: boolean, write: boolean, sync: boolean, semanticSearch: boolean, userIsolation: boolean}} 能力映射
   */
  getCapabilities() {
    return {
      recall: true,
      write: true,
      sync: true,
      semanticSearch: true,
      userIsolation: false,
    };
  }

  _buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (this._hindsightConfig.apiKey) {
      headers['Authorization'] = 'Bearer ' + this._hindsightConfig.apiKey;
    }
    return headers;
  }

  _makeRequest(method, path, body) {
    const self = this;
    return new Promise(function(resolve, reject) {
      let settled = false;
      const safeResolve = (val) => { if (!settled) { settled = true; resolve(val); } };
      const safeReject = (err) => { if (!settled) { settled = true; reject(err); } };
      const urlStr = self._hindsightConfig.endpoint + path;
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
          try { data = safeJsonParse(rawData, rawData, 'HindsightAdapter'); } catch (_e) { data = rawData; }
          if (res.statusCode >= 400) {
            const err = new Error('hindsight API error: ' + String(res.statusCode));
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
    await this._makeRequest('GET', '/api/v1/health');
  }

  async _doDisconnect() {
    this._connected = false;
  }

  async _doHealthCheck() {
    return this._makeRequest('GET', '/api/v1/health');
  }

  async _doRecall(query, options) {
    const opts = options ?? {};
    const searchQuery = typeof query === 'string' ? query : String(query);
    const body = { query: searchQuery };
    if (opts.limit != null) body.limit = opts.limit;
    if (opts.threshold != null) body.threshold = opts.threshold;
    const data = await this._makeRequest('POST', '/api/v1/memories/search', body);
    const results = Array.isArray(data) ? data : (data && Array.isArray(data.results) ? data.results : []);
    return results.map(function(item) {
      return {
        data: item,
        confidence: item.score ?? item.relevance ?? 0.5,
        source: 'hindsight',
        timestamp: item.created_at ?? item.timestamp ?? Date.now(),
      };
    });
  }

  async _doWrite(entry) {
    const body = {
      content: entry.content ?? String(entry),
    };
    if (entry.metadata) body.metadata = entry.metadata;
    if (entry.tags) body.tags = entry.tags;
    const data = await this._makeRequest('POST', '/api/v1/memories', body);
    return {
      success: true,
      id: data ? (data.id ?? data.memory_id) : null,
    };
  }

  async _doQuery(filter) {
    const params = new URLSearchParams();
    if (filter && filter.limit) params.set('limit', String(filter.limit));
    if (filter && filter.offset) params.set('offset', String(filter.offset));
    const data = await this._makeRequest('GET', '/api/v1/memories?' + params.toString());
    return Array.isArray(data) ? data : (data && Array.isArray(data.results) ? data.results : []);
  }

  async _doDelete(id) {
    await this._makeRequest('DELETE', '/api/v1/memories/' + encodeURIComponent(String(id)));
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
        const data = await this._makeRequest('GET', '/api/v1/memories');
        pulled = Array.isArray(data) ? data.length : (data && Array.isArray(data.results) ? data.results.length : 0);
      } catch (err) {
        this._log('sync_pull', err && err.message ? err.message : String(err));
      }
    }
    return { pushed, pulled };
  }

  /**
   * 调用Hindsight蒸馏API，对记忆进行提炼和压缩。
   *
   * @param {Object} [options] - 蒸馏选项
   * @returns {Promise<*>} 蒸馏结果
   */
  async distill(options) {
    this.guardShutdown();
    const body = options ?? {};
    return this._makeRequest('POST', '/api/v1/memories/distill', body);
  }
}

HindsightAdapter.DEFAULT_HINDSIGHT_CONFIG = DEFAULT_HINDSIGHT_CONFIG;

module.exports = HindsightAdapter;
