'use strict';

/**
 * @module runtime/deepening/deepening-validator
 * 深化推理基于模式的数据验证器。支持三种验证级别（strict/moderate/permissive）
 * 控制边界违规产生错误或警告，验证必填字段、类型、枚举、字符串模式（带编译正则缓存）、
 * 数值范围、自定义规则和额外属性限制。追踪验证历史和统计。
 */

const DeepeningBase = require('./deepening-base');
const { DeepeningError } = require('../../errors');
const RingBuffer = require('../../utils/ring-buffer');
const BoundedMap = require('../../utils/bounded-map');
const { debug } = require('../../utils/debug-logger');
const { safeCall } = require('../../utils/safe-execute');

/**
 * 有效验证级别集合
 * @constant {Set<string>}
 */
const VALID_LEVELS = new Set(['strict', 'moderate', 'permissive']);

/**
 * 编译正则表达式并缓存。编译失败时返回 null。
 * @param {BoundedMap} cache - 正则编译缓存
 * @param {string} pattern - 正则表达式字符串
 * @returns {RegExp|null} 编译后的正则对象，失败返回 null
 * @private
 */
const REDOS_DANGEROUS_RE = /(?:\([^)]*[+*][^)]*\))[+*{]|(?:\([^)]+\)[+*]){2,}|\(\?:[^)]*\)[+*]{2,}/;
const MAX_PATTERN_LENGTH = 200;

function _getCompiledPattern(cache, pattern) {
  const cached = cache.get(pattern);
  if (cached) return cached;
  if (pattern.length > MAX_PATTERN_LENGTH) {
    debug('DeepeningValidator', 'pattern rejected: exceeds max length', pattern.length);
    return null;
  }
  if (REDOS_DANGEROUS_RE.test(pattern)) {
    debug('DeepeningValidator', 'pattern rejected: dangerous quantifier nesting', pattern);
    return null;
  }
  try {
    const re = new RegExp(pattern);
    cache.set(pattern, re);
    return re;
  } catch (err) {
    debug('DeepeningValidator', 'pattern compile failed', pattern, err && err.message ? err.message : String(err));
    return null;
  }
}

/**
 * 深化推理基于模式的数据验证器。支持三种验证级别（strict/moderate/permissive）
 * 控制边界违规产生错误或警告，验证必填字段、类型、枚举、字符串模式（带编译正则缓存）、
 * 数值范围、自定义规则和额外属性限制。追踪验证历史和统计。
 *
 * @classdesc 深化验证器。输入验证、输出验证、模式验证。
 * @extends DeepeningBase
 */
class DeepeningValidator extends DeepeningBase {
  /** @constant {Object} 验证级别枚举 */
  static VALIDATION_LEVELS = { STRICT: 'strict', MODERATE: 'moderate', PERMISSIVE: 'permissive' };

  /**
   * 创建 DeepeningValidator 实例。
   * @param {Object} [options] - 配置选项
   * @param {string} [options.level='moderate'] - 验证级别（strict/moderate/permissive）
   * @param {number} [options.historySize=100] - 验证历史记录容量
   */
  constructor(options) {
    super(options);
    this._schemas = new Map();
    this._maxSchemas = 100;
    this._level = (options && options.level) ?? 'moderate';
    this._historySize = (options && options.historySize) ?? 100;
    this._history = new RingBuffer(this._historySize);
    this._totalValidations = 0;
    this._validCount = 0;
    this._invalidCount = 0;
    this._lastSchemaName = null;
    this._patternCache = new BoundedMap(200);
  }

  /**
   * 注册验证模式。
   * @param {string} name - 模式名称
   * @param {Object} schema - 模式定义对象
   * @returns {boolean} 注册成功返回 true
   * @throws {DeepeningError} 名称或模式缺失时抛出异常
   */
  registerSchema(name, schema) {
    this.guardShutdown();
    if (!name || !schema) throw new DeepeningError('MISSING_PARAMETER', 'Name and schema are required');
    if (this._schemas.size >= this._maxSchemas && !this._schemas.has(name)) {
      const oldest = this._schemas.keys().next().value;
      this._schemas.delete(oldest);
    }
    this._schemas.set(name, schema);
    return true;
  }

  /**
   * 注销验证模式。
   * @param {string} name - 模式名称
   * @returns {boolean} 注销成功返回 true，不存在返回 false
   */
  unregisterSchema(name) { this.guardShutdown(); return this._schemas.delete(name); }

  /**
   * 获取指定验证模式。
   * @param {string} name - 模式名称
   * @returns {Object|null} 模式定义对象，不存在返回 null
   */
  getSchema(_name) { return this._schemas.get(_name) ?? null; }

  /**
   * 获取所有已注册模式名称列表。
   * @returns {string[]} 模式名称数组
   */
  getSchemas() { return Array.from(this._schemas.keys()); }

  /**
   * 设置验证级别。
   * @param {string} level - 验证级别（strict/moderate/permissive）
   * @returns {boolean} 设置成功返回 true
   * @throws {DeepeningError} 级别无效时抛出异常
   */
  setLevel(level) {
    this.guardShutdown();
    if (!VALID_LEVELS.has(level)) throw new DeepeningError('INVALID_VALUE', 'Invalid level: ' + level);
    this._level = level;
    return true;
  }

  /**
   * 使用已注册模式验证数据。
   * @param {Object} data - 要验证的数据
   * @param {string} schemaName - 模式名称
   * @returns {Object} 验证结果，包含 valid、errors、warnings
   * @throws {Error} When output is null or undefined
   * @emits 'validation' 当验证完成时触发
   */
  validate(data, schemaName) {
    const schema = this._schemas.get(schemaName);
    if (!schema) {
      const result = { valid: false, errors: [{ path: null, message: 'Schema not found: ' + schemaName }], warnings: [] };
      this._recordResult(result, schemaName);
      return result;
    }
    this._lastSchemaName = schemaName;
    const result = this.validateWithSchema(data, schema);
    this.emit('validation', { ...result, schema: schemaName });
    return result;
  }

  /**
   * 使用指定模式对象验证数据。不依赖已注册模式。
   * @param {Object} data - 要验证的数据
   * @param {Object} schema - 模式定义对象
   * @param {string} [schemaName] - 模式名称（用于事件记录）
   * @returns {Object} 验证结果，包含 valid、errors、warnings
   */
  validateWithSchema(data, schema, schemaName) {
    const errors = [];
    const warnings = [];
    this._validateRequired(data, schema, errors);
    this._validateProperties(data, schema, errors, warnings);
    this._validateAdditionalProperties(data, schema, errors, warnings);
    const result = { valid: errors.length === 0, errors, warnings };
    this._recordResult(result, schemaName || this._lastSchemaName);
    return result;
  }

  /**
   * 记录验证结果到历史和统计。
   * @param {Object} result - 验证结果
   * @param {string} schemaName - 模式名称
   * @emits 'validation' 当首次记录且无 lastSchemaName 时触发
   * @private
   */
  _recordResult(result, schemaName) {
    this._totalValidations++;
    if (result.valid) { this._validCount++; } else { this._invalidCount++; }
    this._history.push(result);
    if (!this._lastSchemaName) {
      this.emit('validation', { ...result, schema: schemaName });
    }
  }

  /**
   * 验证必填字段。
   * @param {Object} data - 要验证的数据
   * @param {Object} schema - 模式定义
   * @param {Object[]} errors - 错误收集数组
   * @private
   */
  _validateRequired(data, schema, errors) {
    if (!schema.required) return;
    for (const field of schema.required) {
      if (data == null || data[field] === undefined) {
        errors.push({ path: field, message: 'Missing required field: ' + field });
      }
    }
  }

  /**
   * 验证属性规则。
   * @param {Object} data - 要验证的数据
   * @param {Object} schema - 模式定义
   * @param {Object[]} errors - 错误收集数组
   * @param {Object[]} warnings - 警告收集数组
   * @private
   */
  _validateProperties(data, schema, errors, warnings) {
    if (!schema.properties) return;
    for (const [key, rules] of Object.entries(schema.properties)) {
      if (!data || data[key] === undefined) continue;
      this._validatePropertyRules(key, data[key], rules, errors, warnings);
    }
  }

  /**
   * 验证单个属性的规则。包括类型、枚举、字符串、数值和自定义规则。
   * @param {string} key - 属性名
   * @param {*} value - 属性值
   * @param {Object} rules - 验证规则
   * @param {Object[]} errors - 错误收集数组
   * @param {Object[]} warnings - 警告收集数组
   * @private
   */
  _validatePropertyRules(key, value, rules, errors, warnings) {
    if (rules.type && typeof value !== rules.type) {
      errors.push({ path: key, message: 'Field ' + key + ' must be ' + rules.type });
    }
    if (rules.enum && !rules.enum.includes(value)) {
      errors.push({ path: key, message: 'Field ' + key + ' must be one of: ' + rules.enum.join(', ') });
    }
    if (typeof value === 'string') this._validateStringRules(key, value, rules, errors);
    if (typeof value === 'number' && Number.isFinite(value)) this._validateNumberRules(key, value, rules, errors, warnings);
    if (rules.custom && typeof rules.custom === 'function') this._validateCustomRule(key, value, rules.custom, errors);
  }

  /**
   * 验证字符串规则（minLength、maxLength、pattern）。
   * @param {string} key - 属性名
   * @param {string} value - 字符串值
   * @param {Object} rules - 验证规则
   * @param {Object[]} errors - 错误收集数组
   * @private
   */
  _validateStringRules(key, value, rules, errors) {
    if (rules.minLength && value.length < rules.minLength) {
      errors.push({ path: key, message: 'Field ' + key + ' must be at least ' + rules.minLength + ' characters' });
    }
    if (rules.maxLength && value.length > rules.maxLength) {
      errors.push({ path: key, message: 'Field ' + key + ' must be at most ' + rules.maxLength + ' characters' });
    }
    if (rules.pattern) {
      const re = _getCompiledPattern(this._patternCache, rules.pattern);
      if (re && !re.test(value)) errors.push({ path: key, message: 'Field ' + key + ' does not match pattern' });
    }
  }

  /**
   * 验证数值规则（minimum、maximum）。strict 级别产生错误，其他级别产生警告。
   * @param {string} key - 属性名
   * @param {number} value - 数值
   * @param {Object} rules - 验证规则
   * @param {Object[]} errors - 错误收集数组
   * @param {Object[]} warnings - 警告收集数组
   * @private
   */
  _validateNumberRules(key, value, rules, errors, warnings) {
    if (rules.minimum !== undefined && value < rules.minimum) {
      if (this._level === 'strict') {
        errors.push({ path: key, message: 'Field ' + key + ' must be at least ' + rules.minimum });
      } else {
        warnings.push({ path: key, message: 'Field ' + key + ' is below minimum ' + rules.minimum });
      }
    }
    if (rules.maximum !== undefined && value > rules.maximum) {
      if (this._level === 'strict') {
        errors.push({ path: key, message: 'Field ' + key + ' must be at most ' + rules.maximum });
      } else {
        warnings.push({ path: key, message: 'Field ' + key + ' exceeds maximum ' + rules.maximum });
      }
    }
  }

  /**
   * 验证自定义规则。规则函数返回 true 表示通过，返回字符串作为错误消息。
   * @param {string} key - 属性名
   * @param {*} value - 属性值
   * @param {Function} customFn - 自定义验证函数
   * @param {Object[]} errors - 错误收集数组
   * @private
   */
  _validateCustomRule(key, value, customFn, errors) {
    try {
      const customResult = customFn(value);
      if (customResult !== true) {
        const msg = typeof customResult === 'string' ? customResult : 'Custom validation failed for ' + key;
        errors.push({ path: key, message: msg });
      }
    } catch (e) {
      errors.push({ path: key, message: 'Custom validation error for ' + key + ': ' + (e && e.message ? e.message : String(e)) });
    }
  }

  /**
   * 验证额外属性限制。strict 级别产生错误，其他级别产生警告。
   * @param {Object} data - 要验证的数据
   * @param {Object} schema - 模式定义
   * @param {Object[]} errors - 错误收集数组
   * @param {Object[]} warnings - 警告收集数组
   * @private
   */
  _validateAdditionalProperties(data, schema, errors, warnings) {
    if (schema.additionalProperties !== false || !data) return;
    const allowed = schema.properties ? new Set(Object.keys(schema.properties)) : new Set();
    for (const key of Object.keys(data)) {
      if (!allowed.has(key)) {
        if (this._level === 'strict') {
          errors.push({ path: key, message: 'Additional property not allowed: ' + key });
        } else {
          warnings.push({ path: key, message: 'Additional property not allowed: ' + key });
        }
      }
    }
  }

  /**
   * 获取验证历史记录。
   * @param {number} [limit] - 返回的最大记录数
   * @returns {Object[]} 验证结果历史数组
   */
  getHistory(limit) { const n = limit ?? this._historySize; return n > 0 ? this._history.slice(-n) : []; }

  /**
   * 获取验证器统计信息。
   * @returns {Object} 统计对象，包含 schemasRegistered、totalValidations、validCount、invalidCount、level、historySize
   */
  getStats() {
    return {
      ...super.getStats(),
      schemasRegistered: this._schemas.size,
      totalValidations: this._totalValidations,
      validCount: this._validCount,
      invalidCount: this._invalidCount,
      level: this._level,
      historySize: this._history.size,
    };
  }

  /**
   * 关闭时清理所有模式。
   * @protected
   */
  _onShutdown() {
    this._schemas.clear();
    safeCall(() => this._patternCache.shutdown(), 'DeepeningValidator', 'shutdown-patternCache');
    super._onShutdown();
  }
}

module.exports = DeepeningValidator;
