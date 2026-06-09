'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeExecuteAsync } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');

const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/gm;
const DECISION_PATTERN = /(?:决策|决定|decision|DECISION)[:：]\s*(.+)/gi;
const RULE_PATTERN = /(?:规则|rule|RULE)[:：]\s*(.+)/gi;
const BUSINESS_PATTERN = /(?:业务|business|BUSINESS)[:：]\s*(.+)/gi;
const TODO_PATTERN = /(?:TODO|FIXME|HACK|XXX)[:：]?\s*(.+)/gi;

const DEFAULT_CONFIG = {
  maxCacheSize: 200,
  maxConcurrency: 4,
  maxBatchSize: 30,
  maxContentLength: 50000,
  llmClient: null,
};

/**
 * @module runtime/graphify/semantic-extractor
 * @classdesc 语义提取器。LLM语义提取、并行批处理、Token成本追踪
 */
class SemanticExtractor extends EventEmitter {
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._llmClient = this._config.llmClient;
    this._cache = new BoundedMap(this._config.maxCacheSize);
    this._costTracker = { totalTokens: 0, totalCalls: 0, stages: {} };
    this._activeExtractions = 0;
  }

  /**
   * 从文件内容中提取语义信息，根据文件类型选择不同的提取策略
   * @param {string} filePath - 文件路径
   * @param {string} content - 文件内容
   * @param {string} [type] - 文件类型（markdown/text/pdf/image/audio/json/yaml/toml）
   * @returns {{ filePath: string, semantics: Array<Object>, parser: string }} 语义提取结果
   */
  async extractSemantic(filePath, content, type) {
    this.guardShutdown();
    if (!filePath || typeof filePath !== 'string') return { filePath, semantics: [], parser: 'none' };
    if (content == null || typeof content !== 'string') content = '';

    const cacheKey = filePath + ':' + content.length + ':' + (type || '');
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const truncatedContent = content.length > this._config.maxContentLength
      ? content.substring(0, this._config.maxContentLength)
      : content;

    let result;
    if (type === 'markdown' || type === 'text') {
      result = this._extractFromText(filePath, truncatedContent);
    } else if (type === 'pdf' || type === 'image' || type === 'audio') {
      result = await this._extractFromMultimodal(filePath, truncatedContent, type);
    } else if (type === 'json') {
      result = this._extractFromStructured(filePath, truncatedContent, type);
    } else if (type === 'yaml' || type === 'toml') {
      result = this._extractFromText(filePath, truncatedContent);
    } else {
      result = this._extractFromText(filePath, truncatedContent);
    }

    if (typeof result === 'object' && result !== null) {
      result.filePath = filePath;
      this._cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * 批量提取多个文件的语义信息，支持并行处理和并发控制
   * @param {Array<{ filePath: string, content?: string, type?: string }>} files - 待提取的文件列表
   * @returns {Map<string, { filePath: string, semantics: Array<Object>, parser: string }>} 文件路径到提取结果的映射
   */
  async extractBatch(files) {
    this.guardShutdown();
    if (!Array.isArray(files)) return new Map();

    const results = new Map();
    const batch = files.slice(0, this._config.maxBatchSize);
    const concurrency = this._config.maxConcurrency ?? 4;

    for (let i = 0; i < batch.length; i += concurrency) {
      const chunk = batch.slice(i, i + concurrency);
      const promises = chunk.map(item => {
        if (!item || !item.filePath) return Promise.resolve(null);
        return safeExecuteAsync(
          () => this.extractSemantic(item.filePath, item.content || '', item.type),
          'SemanticExtractor', 'extractBatch-item',
          () => ({ filePath: item.filePath, semantics: [], parser: 'none' }),
        );
      });
      const chunkSettled = await Promise.allSettled(promises);
      const chunkResults = chunkSettled.filter(r => r.status === 'fulfilled').map(r => r.value);
      for (let j = 0; j < chunkResults.length; j++) {
        const r = chunkResults[j];
        if (r && r.filePath) results.set(r.filePath, r);
      }
    }

    return results;
  }

  _extractFromText(filePath, content) {
    const semantics = [];

    let match;
    const headingRegex = new RegExp(HEADING_PATTERN.source, HEADING_PATTERN.flags);
    while ((match = headingRegex.exec(content)) !== null) {
      semantics.push({
        type: 'heading',
        level: match[1].length,
        text: match[2].trim(),
        category: 'structure',
      });
    }

    const decisionRegex = new RegExp(DECISION_PATTERN.source, DECISION_PATTERN.flags);
    while ((match = decisionRegex.exec(content)) !== null) {
      semantics.push({
        type: 'decision',
        text: match[1].trim(),
        category: 'logic',
      });
    }

    const ruleRegex = new RegExp(RULE_PATTERN.source, RULE_PATTERN.flags);
    while ((match = ruleRegex.exec(content)) !== null) {
      semantics.push({
        type: 'rule',
        text: match[1].trim(),
        category: 'logic',
      });
    }

    const businessRegex = new RegExp(BUSINESS_PATTERN.source, BUSINESS_PATTERN.flags);
    while ((match = businessRegex.exec(content)) !== null) {
      semantics.push({
        type: 'business',
        text: match[1].trim(),
        category: 'domain',
      });
    }

    const todoRegex = new RegExp(TODO_PATTERN.source, TODO_PATTERN.flags);
    while ((match = todoRegex.exec(content)) !== null) {
      semantics.push({
        type: 'todo',
        text: match[1].trim(),
        category: 'meta',
      });
    }

    return { semantics, parser: 'regex-text' };
  }

  async _extractFromMultimodal(filePath, content, type) {
    if (!this._llmClient) {
      return { semantics: [], parser: 'no-llm', multimodalType: type };
    }

    this._activeExtractions++;
    try {
      const result = await safeExecuteAsync(
        () => this._llmClient.extract({ filePath, content, type }),
        'SemanticExtractor', 'llm-extract',
        () => ({ semantics: [], parser: 'llm-fallback', _error: true }), // _error 标记LLM提取失败，供调用方识别降级结果
      );

      this._costTracker.totalCalls++;
      this._costTracker.totalTokens += Math.ceil((content || '').length / 4);

      return { ...result, parser: 'llm', multimodalType: type };
    } finally {
      this._activeExtractions--;
    }
  }

  _extractFromStructured(filePath, content, type) {
    const semantics = [];

    const result = safeExecute(
      () => JSON.parse(content),
      'SemanticExtractor', 'parse-structured',
      null,
    );

    if (result === null) {
      debug('SemanticExtractor', 'parse-structured', 'JSON parse failed');
      // JSON解析失败时返回parse-failed标记，供调用方识别格式错误的结构化数据
      return { semantics: [], parser: 'parse-failed' };
    }

    if (result && typeof result === 'object') {
      semantics.push({
        type: 'structured-data',
        keys: typeof result === 'object' && result !== null ? Object.keys(result).slice(0, 20) : [],
        category: 'data',
        format: type,
      });
    }

    return { semantics, parser: 'structured' };
  }

  /**
   * 获取Token消耗成本报告
   * @returns {{ totalTokens: number, totalCalls: number, stages: Object, activeExtractions: number }} 成本报告
   */
  getCostReport() {
    this.guardShutdown();
    return {
      totalTokens: this._costTracker.totalTokens,
      totalCalls: this._costTracker.totalCalls,
      stages: { ...this._costTracker.stages },
      activeExtractions: this._activeExtractions,
    };
  }

  /**
   * 清空语义提取缓存
   */
  clearCache() {
    this.guardShutdown();
    this._cache.clear();
  }

  _onShutdown() {
    this._cache.clear();
    this._llmClient = null;
    this._costTracker = { totalTokens: 0, totalCalls: 0, stages: {} };
    this._activeExtractions = 0;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(SemanticExtractor);
