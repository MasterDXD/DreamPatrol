'use strict';

/** @module runtime/search/sirchnunk-mcp-adapter */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');

const SEARCH_MODES = {
  FILENAME_ONLY: 'FILENAME_ONLY',
  FAST: 'FAST',
  DEEP: 'DEEP',
};

const DEFAULT_CONFIG = {
  mcpServerName: 'sirchnunk',
  defaultMode: SEARCH_MODES.FAST,
  maxConcurrentSearches: 3,
  resultCacheSize: 50,
  searchHistorySize: 100,
  defaultTopK: 20,
  defaultMaxDepth: 10,
  defaultMaxLoops: 10,
};

/**
 * Sirchnunk MCP适配器，封装MCPClient调用Sirchnunk搜索引擎
 * @extends EventEmitter
 */
class SirchnunkMcpAdapter extends EventEmitter {
  /**
   * 创建SirchnunkMcpAdapter实例
   * @param {object} options
   * @param {object} [options.mcpClient] - MCPClient实例
   * @param {string} [options.mcpServerName] - MCP服务器名称
   * @param {string} [options.defaultMode] - 默认搜索模式
   */
  constructor(options) {
    super();
    this._config = { ...DEFAULT_CONFIG, ...(options ?? {}) };
    this._mcpClient = this._config.mcpClient ?? null;
    this._resultCache = new BoundedMap(this._config.resultCacheSize);
    this._searchHistory = new BoundedArray(this._config.searchHistorySize);
    this._stats = {
      totalSearches: 0,
      cacheHits: 0,
      byMode: { FILENAME_ONLY: 0, FAST: 0, DEEP: 0 },
      totalTokensUsed: 0,
      errors: 0,
    };
  }

  /**
   * 附加MCPClient实例
   * @param {object} client - MCPClient实例
   */
  attachMcpClient(client) {
    this.guardShutdown();
    this._mcpClient = client;
  }

  /**
   * 执行搜索
   * @param {string} query - 搜索查询
   * @param {object} [options] - 搜索选项
   * @param {string} [options.mode] - 搜索模式
   * @param {string[]} [options.paths] - 搜索路径
   * @param {number} [options.topK] - 返回结果数
   * @param {number} [options.maxDepth] - 最大深度
   * @param {number} [options.maxLoops] - 最大循环数
   * @param {string[]} [options.includePatterns] - 包含模式
   * @param {string[]} [options.excludePatterns] - 排除模式
   * @returns {Promise<object>} 搜索结果
   */
  async search(query, options) {
    this.guardShutdown();
    if (!query || typeof query !== 'string') throw new Error('query is required');
    if (!this._mcpClient) throw new Error('MCPClient not attached. Call attachMcpClient() first.');

    const { mode, paths, topK, maxDepth, maxLoops, includePatterns, excludePatterns } = this._extractSearchOptions(options);

    const cacheKey = query + ':' + mode + ':' + (paths ? paths.join(',') : '');
    const cached = this._resultCache.get(cacheKey);
    if (cached) {
      this._stats.cacheHits++;
      return cached;
    }

    this._stats.totalSearches++;
    this._stats.byMode[mode] = (this._stats.byMode[mode] ?? 0) + 1;

    const toolFullName = 'mcp_' + this._config.mcpServerName + '_search';

    try {
      const result = await this._mcpClient.callTool(toolFullName, {
        query: query,
        mode: mode,
        paths: paths,
        top_k_files: topK,
        max_depth: maxDepth,
        max_loops: maxLoops,
        include_patterns: includePatterns,
        exclude_patterns: excludePatterns,
      });

      const searchResult = this._buildSearchResult(query, mode, result);
      this._resultCache.set(cacheKey, searchResult);
      this._searchHistory.push(searchResult);
      this._stats.totalTokensUsed += searchResult.tokensUsed;
      this.emit('search-complete', searchResult);

      return searchResult;
    } catch (err) {
      this._stats.errors++;
      this.emit('search-error', { query: query, mode: mode, error: err && err.message ? err.message : String(err) });
      throw err;
    }
  }

  /**
   * 提取搜索选项
   * @param {object} options - 搜索选项
   * @returns {object} 标准化的搜索选项
   */
  _extractSearchOptions(options) {
    const opts = options ?? {};
    return {
      mode: opts.mode ?? this._config.defaultMode,
      paths: opts.paths ?? undefined,
      topK: opts.topK ?? this._config.defaultTopK,
      maxDepth: opts.maxDepth ?? this._config.defaultMaxDepth,
      maxLoops: opts.maxLoops ?? this._config.defaultMaxLoops,
      includePatterns: opts.includePatterns ?? undefined,
      excludePatterns: opts.excludePatterns ?? undefined,
    };
  }

  /**
   * 构建搜索结果对象
   * @param {string} query - 查询字符串
   * @param {string} mode - 搜索模式
   * @param {object} result - MCP调用结果
   * @returns {object} 标准化的搜索结果
   */
  _buildSearchResult(query, mode, result) {
    const resultObj = result?.result ?? result;
    return {
      query: query,
      mode: mode,
      answer: resultObj?.content ?? '',
      clusterId: resultObj?.clusterId ?? null,
      confidence: resultObj?.confidence ?? 0,
      evidenceUnits: resultObj?.evidenceUnits ?? [],
      tokensUsed: resultObj?.tokensUsed ?? 0,
      timestamp: Date.now(),
    };
  }

  /**
   * 获取搜索历史
   * @param {number} [limit] - 返回数量限制
   * @returns {Array} 搜索历史列表
   */
  getHistory(limit) {
    if (this._shutDown) return [];
    const n = limit || this._searchHistory.length;
    return this._searchHistory.toArray().slice(-n);
  }

  /**
   * 获取统计信息
   * @returns {object} 统计数据
   */
  getStats() {
    if (this._shutDown) return {};
    return {
      ...this._stats,
      cacheSize: this._resultCache.size,
      historySize: this._searchHistory.length,
      connected: !!this._mcpClient,
    };
  }

  /**
   * 清除结果缓存
   */
  clearCache() {
    this.guardShutdown();
    this._resultCache.clear();
  }

  _onShutdown() {
    safeCall(() => this._resultCache.shutdown(), 'SirchnunkMcpAdapter', 'shutdown-resultCache');
    safeCall(() => this._searchHistory.shutdown(), 'SirchnunkMcpAdapter', 'shutdown-searchHistory');
    this._stats = { totalSearches: 0, cacheHits: 0, byMode: {}, totalTokensUsed: 0, errors: 0 };
    this._mcpClient = null;
    this.removeAllListeners();
  }
}

module.exports = {
  SirchnunkMcpAdapter: withShutdown(SirchnunkMcpAdapter),
  SEARCH_MODES,
  DEFAULT_CONFIG,
};
