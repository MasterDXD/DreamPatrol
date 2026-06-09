'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');

/**
 * NLDataQueryBridge - 自然语言到数据查询的桥接层
 *
 * Translates natural language queries into structured data queries
 * against the BusinessOntologyModel, enabling non-technical users
 * to query business data using natural language.
 */
class NLDataQueryBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this._maxQueryCache = options.maxQueryCache ?? 200;
    this._maxQueryHistory = options.maxQueryHistory ?? 500;
    this._ontologyModel = options.ontologyModel || null;
    this._ragPipeline = options.ragPipeline || null;
    this._queryCache = new BoundedMap(this._maxQueryCache);
    this._queryHistory = new BoundedArray(this._maxQueryHistory);
    this._customPatterns = new BoundedMap(100);
    this._registerDefaultPatterns();
  }

  /**
   * Register default NL query patterns
   * @private
   */
  _registerDefaultPatterns() {
    const patterns = [
      {
        name: 'count-query',
        pattern: /(?:查询|查|统计|多少|count\s+)(?:\s*(.+?))?\s*(?:的数量|数量|总数|个数|count)/i,
        template: { type: 'count', entityType: '$1', filters: [] },
      },
      {
        name: 'ratio-query',
        pattern: /(?:查询|查|统计|ratio|占比)\s*(.+?)\s*(?:的?占比|比例|比率|百分比|ratio)/i,
        template: { type: 'ratio', numerator: '$1', denominator: null, filters: [] },
      },
      {
        name: 'filter-query',
        pattern: /(?:查询|查|find|get)\s*([^\s,，]+?)\s*(?:中|里|其中|where)?\s*([^\s,，]+?)\s*(?:的|的?)([^\s,，]+)/i,
        template: { type: 'filter', entityType: '$1', conditions: '$2', projection: '$3' },
      },
      {
        name: 'trend-query',
        pattern: /(?:趋势|变化|增长|下降|trend)\s*(.+?)(?:的|的?)(.+?)/i,
        template: { type: 'trend', metric: '$1', dimension: '$2', timeRange: null },
      },
      {
        name: 'top-n-query',
        pattern: /(?:前|top\s*)(\d+)\s*(.+?)(?:的|的?)(.+?)/i,
        template: { type: 'topN', n: '$1', entityType: '$2', metric: '$3' },
      },
    ];

    for (const p of patterns) {
      this._customPatterns.set(p.name, p);
    }
  }

  /**
   * Translate a natural language query to a structured query
   * @param {string} nlQuery - Natural language query
   * @param {object} context - {userId, sessionId, entityType}
   * @returns {{structuredQuery: object, confidence: number, pattern: string|null}}
   */
  translate(nlQuery, context = {}) {
    this.guardShutdown();
    if (!nlQuery || typeof nlQuery !== 'string') {
      throw new Error('NLDataQueryBridge: nlQuery must be a non-empty string');
    }

    // Check cache first
    const normalized = nlQuery.trim().toLowerCase();
    const cacheKey = normalized.length > 500 ? normalized.substring(0, 500) : normalized;
    const cached = this._queryCache.get(cacheKey);
    if (cached) {
      this._audit('query:cache-hit', { nlQuery: nlQuery.substring(0, 100) });
      return { ...cached, fromCache: true };
    }

    // Try pattern matching
    let bestMatch = null;
    let bestConfidence = 0;

    for (const [, pattern] of this._customPatterns) {
      const match = nlQuery.match(pattern.pattern);
      if (match) {
        const confidence = match[0].length / nlQuery.length;
        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestMatch = { pattern: pattern.name, match, template: pattern.template };
        }
      }
    }

    let structuredQuery;
    let patternName = null;

    if (bestMatch && bestConfidence >= 0.3) {
      structuredQuery = this._buildStructuredQuery(bestMatch.template, bestMatch.match, context);
      patternName = bestMatch.pattern;
    } else {
      // Fallback: generic query structure
      structuredQuery = this._buildGenericQuery(nlQuery, context);
      patternName = null;
      bestConfidence = 0.1;
    }

    // Resolve entity type from ontology if available
    if (this._ontologyModel && structuredQuery.entityType) {
      const entityType = this._ontologyModel.getEntityType(structuredQuery.entityType);
      if (entityType) {
        structuredQuery.resolvedSchema = entityType.schema;
      }
    }

    const result = { structuredQuery, confidence: bestConfidence, pattern: patternName };

    // Cache the result
    this._queryCache.set(cacheKey, result);

    this._audit('query:translated', {
      nlQuery: nlQuery.substring(0, 100),
      queryType: structuredQuery.type,
      confidence: bestConfidence,
    });
    this.emit('query:translated', { queryType: structuredQuery.type, confidence: bestConfidence });

    return result;
  }

  /**
   * Execute a structured query against the ontology model
   * @param {object} structuredQuery - Structured query from translate()
   * @param {object} options - {timeout}
   * @returns {Promise<{results: Array, metadata: object}>}
   */
  async execute(structuredQuery, _options = {}) {
    this.guardShutdown();
    if (!structuredQuery || typeof structuredQuery !== 'object') {
      throw new Error('NLDataQueryBridge: structuredQuery must be an object');
    }

    const startTime = Date.now();

    // If RAG pipeline is available, use it for data retrieval
    let results = [];
    if (this._ragPipeline && typeof this._ragPipeline.query === 'function') {
      try {
        const ragResults = await this._ragPipeline.query(structuredQuery.rawQuery || JSON.stringify(structuredQuery));
        if (this._shutDown) return { results: [], metadata: { interrupted: true } };
        results = Array.isArray(ragResults) ? ragResults : [ragResults];
      } catch (_e) {
        results = [];
      }
    }

    // If ontology model is available, evaluate business rules
    let ruleResults = null;
    if (this._ontologyModel && structuredQuery.entityType) {
      ruleResults = this._ontologyModel.evaluateRules(structuredQuery.entityType, structuredQuery);
    }

    const metadata = {
      queryType: structuredQuery.type,
      resultCount: results.length,
      durationMs: Date.now() - startTime,
      ruleResults: ruleResults ? {
        passed: ruleResults.passed.length,
        failed: ruleResults.failed.length,
      } : null,
    };

    this._audit('query:executed', { queryType: structuredQuery.type, resultCount: results.length });
    this.emit('query:executed', { queryType: structuredQuery.type, resultCount: results.length });

    return { results, metadata };
  }

  /**
   * Register a custom NL query pattern
   * @param {string} name - Pattern name
   * @param {RegExp} pattern - Regex pattern
   * @param {object} template - Query template with $1, $2 placeholders
   * @returns {{name: string, registered: boolean}}
   */
  registerPattern(name, pattern, template) {
    this.guardShutdown();
    if (!name || typeof name !== 'string') {
      throw new Error('NLDataQueryBridge: name must be a non-empty string');
    }
    if (!(pattern instanceof RegExp)) {
      throw new Error('NLDataQueryBridge: pattern must be a RegExp');
    }
    if (!template || typeof template !== 'object') {
      throw new Error('NLDataQueryBridge: template must be an object');
    }

    this._customPatterns.set(name, { name, pattern, template });
    this.emit('query:pattern-registered', { name });
    return { name, registered: true };
  }

  /**
   * Get query history
   * @param {object} filter - {queryType, limit}
   * @returns {Array<object>}
   */
  getQueryHistory(filter = {}) {
    this.guardShutdown();
    const entries = [];
    const limit = filter.limit ?? 50;
    for (const entry of this._queryHistory) {
      if (filter.queryType && entry.queryType !== filter.queryType) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
    return entries;
  }

  /**
   * Get statistics
   * @returns {object}
   */
  getStats() {
    this.guardShutdown();
    return {
      cacheSize: this._queryCache.size,
      historySize: this._queryHistory.size,
      patternCount: this._customPatterns.size,
      hasOntologyModel: !!this._ontologyModel,
      hasRagPipeline: !!this._ragPipeline,
    };
  }

  // --- Private methods ---

  _buildStructuredQuery(template, match, context) {
    const query = { ...template };
    // Replace $1, $2, etc. with match groups
    for (const key of Object.keys(query)) {
      if (typeof query[key] === 'string' && query[key].startsWith('$')) {
        const groupIndex = parseInt(query[key].substring(1), 10);
        if (groupIndex >= 1 && groupIndex < match.length) {
          query[key] = match[groupIndex];
        } else {
          query[key] = null;
        }
      }
    }
    query.context = context;
    query.translatedAt = new Date().toISOString();
    return query;
  }

  _buildGenericQuery(nlQuery, context) {
    return {
      type: 'generic',
      rawQuery: nlQuery,
      filters: [],
      context,
      translatedAt: new Date().toISOString(),
    };
  }

  _audit(action, details) {
    this._queryHistory.push({
      action,
      details,
      timestamp: new Date().toISOString(),
    });
  }

  _onShutdown() {
    this.removeAllListeners();
    try { this._queryCache.shutdown(); } catch (_e) { debug('NLDataQueryBridge', '_onShutdown:queryCache', _e && _e.message ? _e.message : String(_e)); }
    try { this._queryHistory.shutdown(); } catch (_e) { debug('NLDataQueryBridge', '_onShutdown:queryHistory', _e && _e.message ? _e.message : String(_e)); }
    try { this._customPatterns.shutdown(); } catch (_e) { debug('NLDataQueryBridge', '_onShutdown:customPatterns', _e && _e.message ? _e.message : String(_e)); }
    this._queryCache = null;
    this._queryHistory = null;
    this._customPatterns = null;
    this._ontologyModel = null;
    this._ragPipeline = null;
  }
}

module.exports = withShutdown(NLDataQueryBridge);
