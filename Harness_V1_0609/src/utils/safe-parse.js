/**
 * @module safe-parse
 * @description 安全JSON解析模块，提供带长度限制和XSS消毒的JSON解析功能。
 * 防止解析超长字符串导致的内存问题，并自动对解析结果进行原型污染消毒。
 */

'use strict';

const { sanitizeObject } = require('./sanitizer');
const { debug } = require('./debug-logger');

/** @constant {number} MAX_JSON_PARSE_LENGTH - JSON解析允许的最大字符串长度（50MB） */
const MAX_JSON_PARSE_LENGTH = 50 * 1024 * 1024;

/**
 * 安全解析JSON字符串，超长或解析失败返回null，对象结果自动消毒
 * @param {string} content - 待解析的JSON字符串
 * @returns {*|null} 解析后的数据，失败或超长返回null
 */
function safeParse(content) {
  if (typeof content !== 'string') {
    return { parsed: null, raw: content, error: 'Input is not a string' };
  }
  if (typeof content === 'string' && content.length > MAX_JSON_PARSE_LENGTH) {
    return null;
  }
  let data;
  try { data = JSON.parse(content); } catch (_e) { debug('safeParse', 'parse', _e && _e.message ? _e.message : String(_e)); return null; }
  if (!data || typeof data !== 'object') return data;
  return sanitizeObject(data);
}

/**
 * 安全解析JSON字符串，支持自定义回退值和调试日志
 * @param {string} raw - 待解析的JSON字符串
 * @param {*} [fallback] - 解析失败时的回退值
 * @param {string} [logLabel] - 调试日志标签
 * @returns {*} 解析后的数据，失败时返回fallback或null
 */
function safeJsonParse(raw, fallback, logLabel) {
  if (typeof raw !== 'string') {
    return fallback !== undefined ? fallback : null;
  }
  if (typeof raw === 'string' && raw.length > MAX_JSON_PARSE_LENGTH) {
    if (logLabel) {
      debug(logLabel, 'safeJsonParse', 'Input exceeds maximum parse length (' + raw.length + ')');
    }
    return arguments.length >= 2 ? fallback : null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed !== null) {
      return sanitizeObject(parsed);
    }
    return parsed;
  } catch (err) {
    if (logLabel) {
      debug(logLabel, 'safeJsonParse', err);
    }
    return arguments.length >= 2 ? fallback : null;
  }
}

module.exports = safeParse;
module.exports.safeJsonParse = safeJsonParse;
module.exports.safeStringify = safeStringify;
module.exports.MAX_JSON_PARSE_LENGTH = MAX_JSON_PARSE_LENGTH;

/**
 * 安全序列化对象为JSON字符串，自动处理循环引用和不可序列化值
 * @param {*} value - 待序列化的值
 * @param {string|number[]|function} [replacer] - JSON.stringify replacer
 * @param {string|number} [space] - 缩进
 * @param {*} [fallback] - 序列化失败时的回退值，默认返回 '{}'
 * @returns {string} JSON字符串，失败时返回fallback或'{}'
 */
function safeStringify(value, replacer, space, fallback) {
  try {
    const seen = new WeakSet();
    const safeReplacer = typeof replacer === 'function' ? replacer : function (_key, val) {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'function') return '[Function]';
      if (typeof val === 'symbol') return '[Symbol]';
      if (typeof val === 'bigint') return '[BigInt]';
      if (val instanceof Error) return { name: val.name, message: val.message };
      return val;
    };
    return JSON.stringify(value, safeReplacer, space);
  } catch (_err) {
    return arguments.length >= 4 ? fallback : '{}';
  }
}
