'use strict';

const { EventEmitter } = require('events');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { safeCall, clamp01, roundTo } = require('../../utils/safe-execute');
const { timestampId } = require('../../utils/unique-id');
const { HarnessError, ERROR_CODES } = require('../../errors');

/** @constant {string} MODULE_LABEL - 模块标签，用于调试日志 */
const MODULE_LABEL = 'ExtractionAgent';

/** @constant {string[]} VALID_FIELD_TYPES - 合法的字段类型列表 */
const VALID_FIELD_TYPES = ['string', 'number', 'date', 'boolean', 'array', 'object'];

/** @constant {number} DEFAULT_MAX_RETRIES - 默认最大重试次数 */
const DEFAULT_MAX_RETRIES = 3;

/** @constant {number} DEFAULT_CONFIDENCE_THRESHOLD - 默认置信度阈值 */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/** @constant {number} EXTRACTION_CAPACITY - 提取结果缓存容量 */
const EXTRACTION_CAPACITY = 1000;

/** @constant {number} HISTORY_CAPACITY - 历史记录容量 */
const HISTORY_CAPACITY = 200;

/**
 * @module runtime/doc-parser/extraction-agent
 * ExtractionAgent — 双Agent智能提取引擎
 * 实现"双Agent大模型架构"，通过Extractor Agent和Verifier Agent
 * 协同完成语义理解和字段提取，支持置信度评分和交叉验证。
 *
 * @classdesc 双Agent智能提取引擎。Extractor Agent负责语义分析和字段提取，
 * Verifier Agent负责交叉验证和置信度计算。
 *
 * @fires extraction-completed - 提取完成事件，payload: { extractionId, docId, schemaName, overallConfidence }
 * @fires verification-failed - 验证失败事件，payload: { extractionId, docId, reason }
 * @fires schema-registered - 模式注册事件，payload: { schemaName, version }
 */
class ExtractionAgent extends EventEmitter {
  /**
   * 创建双Agent提取引擎实例
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.llmClient] - 注入的LLM客户端，用于实际大模型调用
   * @param {number} [options.maxRetries=3] - 最大重试次数
   * @param {number} [options.confidenceThreshold=0.7] - 置信度阈值（0-1）
   * @throws {TypeError} confidenceThreshold不是0-1之间的数值时抛出
   */
  constructor(options) {
    super();
    const opts = options ?? {};

    if (opts.confidenceThreshold !== undefined) {
      if (typeof opts.confidenceThreshold !== 'number' || !Number.isFinite(opts.confidenceThreshold) ||
          opts.confidenceThreshold < 0 || opts.confidenceThreshold > 1) {
        throw new TypeError('confidenceThreshold must be a number between 0 and 1');
      }
    }

    this._llmClient = opts.llmClient ?? null;
    this._maxRetries = typeof opts.maxRetries === 'number' && Number.isFinite(opts.maxRetries)
      ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    this._confidenceThreshold = opts.confidenceThreshold !== undefined
      ? opts.confidenceThreshold : DEFAULT_CONFIDENCE_THRESHOLD;

    /** @private @type {BoundedMap} 提取结果缓存 */
    this._extractions = new BoundedMap(EXTRACTION_CAPACITY, {
      onEvict: (_key, _value) => {
        debug(MODULE_LABEL, 'extraction-evicted', 'extraction evicted from cache');
      },
    });

    /** @private @type {Map} 已注册的提取模式 */
    this._schemas = new Map();
    /** Schema注册表最大容量，防止内存泄漏 */
    this._maxSchemas = 100;

    /** @private @type {BoundedArray} 提取历史记录 */
    this._history = new BoundedArray(HISTORY_CAPACITY);

    /** @private @type {Object} 统计信息 */
    this._stats = {
      totalExtractions: 0,
      successfulExtractions: 0,
      failedExtractions: 0,
      totalVerifications: 0,
      verificationFailures: 0,
      avgConfidence: 0,
      _confidenceSum: 0,
    };

    this._initShutdownState();
  }

  /**
   * 注册提取模式
   * @param {string} schemaName - 模式名称
   * @param {Object} schema - 模式定义
   * @param {string} schema.name - 模式名称
   * @param {string} [schema.version] - 模式版本
   * @param {Array<Object>} schema.fields - 字段定义列表
   * @param {string} schema.fields[].name - 字段名称
   * @param {string} schema.fields[].type - 字段类型（string/number/date/boolean/array/object）
   * @param {string} [schema.fields[].description] - 字段描述
   * @param {boolean} [schema.fields[].required] - 是否必填
   * @param {Array} [schema.fields[].examples] - 示例值列表
   * @returns {boolean} 是否注册成功
   * @throws {TypeError} schemaName或schema无效时抛出
   * @fires schema-registered
   */
  registerSchema(schemaName, schema) {
    this.guardShutdown();

    if (typeof schemaName !== 'string' || !schemaName) {
      throw new TypeError('schemaName must be a non-empty string');
    }
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new TypeError('schema must be a non-null object');
    }
    if (!schema.name || typeof schema.name !== 'string') {
      throw new TypeError('schema.name must be a non-empty string');
    }
    if (!Array.isArray(schema.fields) || schema.fields.length === 0) {
      throw new TypeError('schema.fields must be a non-empty array');
    }

    // 验证字段定义
    for (let i = 0; i < schema.fields.length; i++) {
      const field = schema.fields[i];
      if (!field.name || typeof field.name !== 'string') {
        throw new TypeError('schema.fields[' + i + '].name must be a non-empty string');
      }
      if (!VALID_FIELD_TYPES.includes(field.type)) {
        throw new TypeError('schema.fields[' + i + '].type must be one of: ' + VALID_FIELD_TYPES.join(', '));
      }
    }

    const version = schema.version || '1.0.0';
    const normalizedSchema = {
      name: schema.name,
      version: version,
      fields: schema.fields.map(function(f) {
        return {
          name: f.name,
          type: f.type,
          description: f.description || '',
          required: !!f.required,
          examples: Array.isArray(f.examples) ? f.examples.slice() : [],
        };
      }),
    };

    if (this._schemas.size >= this._maxSchemas) {
      const oldestKey = this._schemas.keys().next().value;
      this._schemas.delete(oldestKey);
    }
    this._schemas.set(schemaName, normalizedSchema);

    this.emit('schema-registered', { schemaName: schemaName, version: version });
    debug(MODULE_LABEL, 'schema-registered', schemaName + '@' + version);

    return true;
  }

  /**
   * 执行双Agent提取流程
   * Phase 1（Extractor Agent）：分析解析内容，识别相关段落，按模式提取字段
   * Phase 2（Verifier Agent）：交叉验证提取字段，计算置信度，标记不一致
   *
   * @param {string} docId - 文档ID
   * @param {Object} parsedContent - 解析后的文档内容
   * @param {string} schemaName - 提取模式名称
   * @param {Object} [options] - 提取选项
   * @param {number} [options.retries] - 覆盖重试次数
   * @returns {Object} 提取结果
   * @returns {string} returns.docId - 文档ID
   * @returns {string} returns.schemaName - 模式名称
   * @returns {Array<Object>} returns.fields - 提取的字段列表
   * @returns {number} returns.overallConfidence - 总体置信度（0-1）
   * @returns {number} returns.extractionTime - 提取耗时（毫秒）
   * @throws {HarnessError} 模式未注册或提取失败时抛出
   * @fires extraction-completed
   * @fires verification-failed
   */
  extract(docId, parsedContent, schemaName, options) {
    this.guardShutdown();

    if (typeof docId !== 'string' || !docId) {
      throw new HarnessError(ERROR_CODES.INVALID_INPUT, 'docId must be a non-empty string');
    }
    if (!parsedContent || typeof parsedContent !== 'object') {
      throw new HarnessError(ERROR_CODES.INVALID_INPUT, 'parsedContent must be a non-null object');
    }
    if (typeof schemaName !== 'string' || !schemaName) {
      throw new HarnessError(ERROR_CODES.INVALID_INPUT, 'schemaName must be a non-empty string');
    }

    const schema = this._schemas.get(schemaName);
    if (!schema) {
      throw new HarnessError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Schema not found: ' + schemaName);
    }

    const opts = options ?? {};
    const maxRetries = typeof opts.retries === 'number' && Number.isFinite(opts.retries)
      ? Math.min(opts.retries, this._maxRetries) : this._maxRetries;

    const extractionId = timestampId('ext-');
    const startTime = Date.now();
    let lastError = null;

    // 带重试的提取流程
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Phase 1: Extractor Agent — 语义分析和字段提取
        const rawResults = this._runExtractorAgent(parsedContent, schema);

        // Phase 2: Verifier Agent — 交叉验证和置信度计算
        const verifiedResults = this._runVerifierAgent(rawResults, parsedContent);

        // 计算总体置信度
        const overallConfidence = this._computeOverallConfidence(verifiedResults.fields);
        const extractionTime = Date.now() - startTime;

        const result = {
          extractionId: extractionId,
          docId: docId,
          schemaName: schemaName,
          fields: verifiedResults.fields,
          overallConfidence: roundTo(overallConfidence, 4),
          extractionTime: extractionTime,
          warnings: verifiedResults.warnings ?? [],
          timestamp: new Date().toISOString(),
        };

        // 缓存提取结果
        this._extractions.set(extractionId, result);
        this._history.push({
          extractionId: extractionId,
          docId: docId,
          schemaName: schemaName,
          overallConfidence: result.overallConfidence,
          extractionTime: extractionTime,
          timestamp: result.timestamp,
        });

        // 更新统计
        this._stats.totalExtractions++;
        this._stats.successfulExtractions++;
        this._stats._confidenceSum += result.overallConfidence;
        this._stats.avgConfidence = roundTo(this._stats._confidenceSum / this._stats.successfulExtractions, 4);

        // 置信度低于阈值时发出验证失败事件
        if (result.overallConfidence < this._confidenceThreshold) {
          this.emit('verification-failed', {
            extractionId: extractionId,
            docId: docId,
            reason: 'Overall confidence ' + result.overallConfidence + ' below threshold ' + this._confidenceThreshold,
          });
          debug(MODULE_LABEL, 'verification-failed', 'extraction ' + extractionId + ' confidence below threshold');
        }

        this.emit('extraction-completed', {
          extractionId: extractionId,
          docId: docId,
          schemaName: schemaName,
          overallConfidence: result.overallConfidence,
        });

        debug(MODULE_LABEL, 'extraction-completed', extractionId + ' confidence=' + result.overallConfidence);

        return result;
      } catch (err) {
        lastError = err;
        debug(MODULE_LABEL, 'extraction-retry', 'attempt ' + (attempt + 1) + ' failed: ' + (err && err.message));
      }
    }

    // 所有重试均失败
    this._stats.totalExtractions++;
    this._stats.failedExtractions++;

    const failureResult = {
      extractionId: extractionId,
      docId: docId,
      schemaName: schemaName,
      fields: [],
      overallConfidence: 0,
      extractionTime: Date.now() - startTime,
      warnings: ['Extraction failed after ' + (maxRetries + 1) + ' attempts: ' + (lastError && lastError.message ? lastError.message : String(lastError))],
      timestamp: new Date().toISOString(),
    };

    this._extractions.set(extractionId, failureResult);

    throw new HarnessError(ERROR_CODES.PIPELINE_EXECUTION_ERROR,
      'Extraction failed for doc ' + docId + ' after ' + (maxRetries + 1) + ' attempts', {
        cause: lastError,
        extractionId: extractionId,
      });
  }

  /**
   * 重新验证已有提取结果
   * 重新运行Verifier Agent，更新置信度评分
   *
   * @param {string} extractionId - 提取结果ID
   * @returns {Object|null} 更新后的提取结果，不存在时返回null
   * @fires verification-failed
   */
  verifyExtraction(extractionId) {
    this.guardShutdown();

    if (typeof extractionId !== 'string' || !extractionId) {
      return null;
    }

    const existing = this._extractions.get(extractionId);
    if (!existing) {
      return null;
    }

    this._stats.totalVerifications++;

    // 重新运行Verifier Agent
    try {
      const rawFields = existing.fields.map(function(f) {
        return {
          name: f.name,
          value: f.value,
          confidence: f.confidence,
          source: f.source,
        };
      });

      const verifiedResults = this._runVerifierAgent({ fields: rawFields }, null);
      const overallConfidence = this._computeOverallConfidence(verifiedResults.fields);

      // 更新提取结果
      existing.fields = verifiedResults.fields;
      existing.overallConfidence = roundTo(overallConfidence, 4);
      existing.warnings = verifiedResults.warnings ?? [];
      existing.timestamp = new Date().toISOString();

      // 更新缓存
      this._extractions.set(extractionId, existing);

      // 置信度低于阈值时发出验证失败事件
      if (existing.overallConfidence < this._confidenceThreshold) {
        this.emit('verification-failed', {
          extractionId: extractionId,
          docId: existing.docId,
          reason: 'Re-verification confidence ' + existing.overallConfidence + ' below threshold',
        });
      }

      debug(MODULE_LABEL, 'verify-extraction', extractionId + ' re-verified confidence=' + existing.overallConfidence);

      return this._defensiveCopy(existing);
    } catch (err) {
      this._stats.verificationFailures++;
      debug(MODULE_LABEL, 'verify-extraction-failed', (err && err.message) || String(err));
      return this._defensiveCopy(existing);
    }
  }

  /**
   * 获取提取结果（防御性拷贝）
   * @param {string} extractionId - 提取结果ID
   * @returns {Object|null} 提取结果的防御性拷贝，不存在时返回null
   */
  getExtraction(extractionId) {
    this.guardShutdown();

    if (typeof extractionId !== 'string' || !extractionId) {
      return null;
    }

    const result = this._extractions.get(extractionId);
    return result ? this._defensiveCopy(result) : null;
  }

  /**
   * 获取指定文档的所有提取结果
   * @param {string} docId - 文档ID
   * @returns {Array<Object>} 提取结果列表
   */
  getExtractionsByDoc(docId) {
    this.guardShutdown();

    if (typeof docId !== 'string' || !docId) {
      return [];
    }

    const results = [];
    this._extractions.forEach(function(value) {
      if (value && value.docId === docId) {
        results.push(value);
      }
    });

    return results.map(this._defensiveCopy);
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计信息对象
   */
  getStats() {
    this.guardShutdown();

    return {
      totalExtractions: this._stats.totalExtractions,
      successfulExtractions: this._stats.successfulExtractions,
      failedExtractions: this._stats.failedExtractions,
      totalVerifications: this._stats.totalVerifications,
      verificationFailures: this._stats.verificationFailures,
      avgConfidence: this._stats.avgConfidence,
      registeredSchemas: this._schemas.size,
      cachedExtractions: this._extractions.size,
      historySize: this._history.length,
    };
  }

  // ─── 内部方法 ─────────────────────────────────────────

  /**
   * Extractor Agent — 语义分析和字段提取
   * 模拟LLM驱动的提取过程，分析解析内容并按模式提取字段
   *
   * @param {Object} content - 解析后的文档内容
   * @param {Object} schema - 提取模式定义
   * @returns {Object} 原始提取结果 { fields: [...] }
   * @private
   */
  _runExtractorAgent(content, schema) {
    debug(MODULE_LABEL, 'extractor-agent', 'analyzing content with schema ' + schema.name);

    const fields = [];
    const contentText = this._flattenContent(content);

    for (let i = 0; i < schema.fields.length; i++) {
      const fieldDef = schema.fields[i];
      const extraction = this._extractField(contentText, content, fieldDef);
      fields.push({
        name: fieldDef.name,
        value: extraction.value,
        confidence: extraction.confidence,
        source: extraction.source,
        verified: false,
      });
    }

    return { fields: fields };
  }

  /**
   * Verifier Agent — 交叉验证和置信度计算
   * 验证提取结果的正确性，调整置信度，标记不一致
   *
   * @param {Object} rawResults - 原始提取结果 { fields: [...] }
   * @param {Object|null} _content - 原始解析内容（用于交叉验证，当前未使用）
   * @returns {Object} 验证后的结果 { fields: [...], warnings: [...] }
   * @private
   */
  _runVerifierAgent(rawResults, _content) {
    debug(MODULE_LABEL, 'verifier-agent', 'cross-validating ' + (rawResults.fields ? rawResults.fields.length : 0) + ' fields');

    const warnings = [];
    const fields = (rawResults.fields ?? []).map(function(field) {
      let confidence = clamp01(field.confidence ?? 0);
      let verified = false;

      // 验证规则1：空值必填字段降低置信度
      if (field.value === null || field.value === undefined || field.value === '') {
        confidence = confidence * 0.3;
        warnings.push('Field "' + field.name + '" is empty');
      } else {
        // 非空值标记为已验证
        verified = true;
      }

      // 验证规则2：置信度极低字段标记警告
      if (confidence < 0.3) {
        warnings.push('Field "' + field.name + '" has very low confidence: ' + roundTo(confidence, 4));
      }

      // 验证规则3：有来源引用的字段提升置信度
      if (field.source && typeof field.source === 'string' && field.source.length > 0) {
        confidence = Math.min(1, confidence * 1.1);
      }

      return {
        name: field.name,
        value: field.value,
        confidence: roundTo(clamp01(confidence), 4),
        source: field.source || '',
        verified: verified,
      };
    });

    return { fields: fields, warnings: warnings };
  }

  /**
   * 从内容中提取单个字段
   * 模拟LLM驱动的字段提取逻辑
   *
   * @param {string} contentText - 扁平化的文本内容
   * @param {Object} content - 原始结构化内容
   * @param {Object} fieldDef - 字段定义
   * @returns {Object} 提取结果 { value, confidence, source }
   * @private
   */
  _extractField(contentText, content, fieldDef) {
    // 尝试从结构化内容中直接提取
    const directValue = this._tryDirectExtraction(content, fieldDef);
    if (directValue.found) {
      return {
        value: directValue.value,
        confidence: 0.85,
        source: directValue.source,
      };
    }

    // 尝试从文本中基于描述和示例提取
    const textValue = this._tryTextExtraction(contentText, fieldDef);
    if (textValue.found) {
      return {
        value: textValue.value,
        confidence: 0.6,
        source: textValue.source,
      };
    }

    // 未找到值
    return {
      value: fieldDef.required ? null : undefined,
      confidence: 0.1,
      source: '',
    };
  }

  /**
   * 尝试从结构化内容中直接提取字段
   * @param {Object} content - 结构化内容
   * @param {Object} fieldDef - 字段定义
   * @returns {Object} 提取结果 { found, value, source }
   * @private
   */
  _tryDirectExtraction(content, fieldDef) {
    if (!content || typeof content !== 'object') {
      return { found: false, value: null, source: '' };
    }

    // 在内容中递归查找匹配字段名的值
    const result = this._findValueInObject(content, fieldDef.name);
    if (result.found) {
      const coerced = this._coerceType(result.value, fieldDef.type);
      return {
        found: true,
        value: coerced,
        source: result.path,
      };
    }

    return { found: false, value: null, source: '' };
  }

  /**
   * 尝试从文本内容中提取字段
   * @param {string} contentText - 扁平化文本
   * @param {Object} fieldDef - 字段定义
   * @returns {Object} 提取结果 { found, value, source }
   * @private
   */
  _tryTextExtraction(contentText, fieldDef) {
    if (typeof contentText !== 'string' || !contentText) {
      return { found: false, value: null, source: '' };
    }

    // 基于字段描述和示例进行简单模式匹配
    const patterns = [];
    if (fieldDef.description) {
      patterns.push(fieldDef.name);
      // 提取描述中的关键词
      const keywords = fieldDef.description.split(/[,，、;；\s]+/).filter(function(w) {
        return w.length > 1;
      });
      patterns.push.apply(patterns, keywords.slice(0, 3));
    }

    if (Array.isArray(fieldDef.examples) && fieldDef.examples.length > 0) {
      for (let i = 0; i < fieldDef.examples.length; i++) {
        const ex = fieldDef.examples[i];
        if (typeof ex === 'string' && ex.length > 0 && ex.length < 100) {
          patterns.push(ex);
        }
      }
    }

    for (let p = 0; p < patterns.length; p++) {
      const pattern = patterns[p];
      const idx = contentText.indexOf(pattern);
      if (idx >= 0) {
        // 提取匹配位置附近的文本作为值
        const start = Math.max(0, idx - 20);
        const end = Math.min(contentText.length, idx + pattern.length + 80);
        const snippet = contentText.substring(start, end).trim();

        return {
          found: true,
          value: this._coerceType(snippet, fieldDef.type),
          source: 'text:' + idx,
        };
      }
    }

    return { found: false, value: null, source: '' };
  }

  /**
   * 在对象中递归查找指定键名的值
   * @param {Object} obj - 待搜索的对象
   * @param {string} key - 目标键名（不区分大小写）
   * @param {string} [path] - 当前路径
   * @returns {Object} 查找结果 { found, value, path }
   * @private
   */
  _findValueInObject(obj, key, path) {
    if (!obj || typeof obj !== 'object') {
      return { found: false, value: null, path: '' };
    }

    const currentPath = path || '';
    const keyLower = key.toLowerCase();

    // 直接匹配
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.toLowerCase() === keyLower) {
        return {
          found: true,
          value: obj[k],
          path: currentPath ? currentPath + '.' + k : k,
        };
      }
    }

    // 递归搜索（限制深度）
    if (currentPath.split('.').length < 5) {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const val = obj[k];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const nested = this._findValueInObject(val, key, currentPath ? currentPath + '.' + k : k);
          if (nested.found) {
            return nested;
          }
        }
      }
    }

    return { found: false, value: null, path: '' };
  }

  /**
   * 布尔值转换辅助
   * @param {*} value - 原始值
   * @returns {boolean|*} 转换后的布尔值，无法转换时返回原值
   * @private
   */
  _coerceBoolean(value) {
    if (typeof value === 'boolean') return value;
    const str = String(value).toLowerCase().trim();
    if (str === 'true' || str === '1' || str === 'yes') return true;
    if (str === 'false' || str === '0' || str === 'no') return false;
    return value;
  }

  /**
   * 将值强制转换为目标类型
   * @param {*} value - 原始值
   * @param {string} type - 目标类型
   * @returns {*} 转换后的值
   * @private
   */
  _coerceType(value, type) {
    if (value === null || value === undefined) {
      return value;
    }

    switch (type) {
      case 'number': {
        if (value === '' || value === null || value === undefined) return value;
        const num = Number(value);
        return Number.isFinite(num) ? num : value;
      }
      case 'boolean':
        return this._coerceBoolean(value);
      case 'date': {
        const d = new Date(value);
        return !isNaN(d.getTime()) ? d.toISOString() : String(value);
      }
      case 'array':
        return Array.isArray(value) ? value : [value];
      case 'object':
        return (typeof value === 'object' && value !== null && !Array.isArray(value)) ? value : { value: value };
      case 'string':
      default:
        return String(value);
    }
  }

  /**
   * 将结构化内容扁平化为文本
   * @param {Object} content - 结构化内容
   * @returns {string} 扁平化文本
   * @private
   */
  _flattenContent(content) {
    if (!content || typeof content !== 'object') {
      return String(content || '');
    }

    const parts = [];

    const MAX_FLATTEN_DEPTH = 20;

    function walk(obj, prefix, depth) {
      if (depth > MAX_FLATTEN_DEPTH) return;
      if (!obj || typeof obj !== 'object') {
        parts.push(prefix + ': ' + String(obj));
        return;
      }
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          walk(obj[i], prefix + '[' + i + ']', depth + 1);
        }
        return;
      }
      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const val = obj[k];
        const path = prefix ? prefix + '.' + k : k;
        if (typeof val === 'string') {
          parts.push(path + ': ' + val);
        } else if (typeof val === 'number' || typeof val === 'boolean') {
          parts.push(path + ': ' + String(val));
        } else {
          walk(val, path, depth + 1);
        }
      }
    }

    walk(content, '', 0);
    return parts.join('\n');
  }

  /**
   * 计算总体置信度（所有字段置信度的平均值）
   * @param {Array<Object>} fields - 字段列表
   * @returns {number} 总体置信度（0-1）
   * @private
   */
  _computeOverallConfidence(fields) {
    if (!Array.isArray(fields) || fields.length === 0) {
      return 0;
    }

    let sum = 0;
    for (let i = 0; i < fields.length; i++) {
      sum += fields[i].confidence ?? 0;
    }

    return sum / fields.length;
  }

  /**
   * 创建对象的防御性深拷贝
   * @param {*} obj - 待拷贝的对象
   * @returns {*} 深拷贝结果
   * @private
   */
  _defensiveCopy(obj) {
    if (obj === null || obj === undefined) {
      return obj;
    }
    if (typeof obj !== 'object') {
      return obj;
    }
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (_e) {
      debug(MODULE_LABEL, '_defensiveCopy', _e && _e.message ? _e.message : String(_e));
      return obj;
    }
  }

  /**
   * 关闭时的资源清理
   * @private
   */
  _onShutdown() {
    debug(MODULE_LABEL, 'shutdown', 'cleaning up extraction agent resources');

    safeCall(function() {
      if (this._extractions) this._extractions.shutdown();
    }.bind(this), MODULE_LABEL, 'shutdown-extractions');

    safeCall(function() {
      if (this._history) this._history.shutdown();
    }.bind(this), MODULE_LABEL, 'shutdown-history');

    this._schemas.clear();
    this._llmClient = null;
    this.removeAllListeners();
  }
}

// 混入Shutdown功能
withShutdown(ExtractionAgent);

/** @constant {string[]} ExtractionAgent.VALID_FIELD_TYPES - 合法的字段类型列表 */
ExtractionAgent.VALID_FIELD_TYPES = VALID_FIELD_TYPES;

/** @constant {number} ExtractionAgent.DEFAULT_MAX_RETRIES - 默认最大重试次数 */
ExtractionAgent.DEFAULT_MAX_RETRIES = DEFAULT_MAX_RETRIES;

/** @constant {number} ExtractionAgent.DEFAULT_CONFIDENCE_THRESHOLD - 默认置信度阈值 */
ExtractionAgent.DEFAULT_CONFIDENCE_THRESHOLD = DEFAULT_CONFIDENCE_THRESHOLD;

module.exports = ExtractionAgent;
