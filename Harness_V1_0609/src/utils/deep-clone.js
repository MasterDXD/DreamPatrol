/**
 * @module deep-clone
 * @description 深度克隆工具模块，提供对象深拷贝功能。优先使用原生structuredClone API，
 * 不可用时回退到JSON序列化方式，并过滤原型污染危险键。
 */

'use strict';

const { debug } = require('./debug-logger');

/** @constant {boolean} _hasStructuredClone - 运行时是否支持原生structuredClone API */
const _hasStructuredClone = typeof structuredClone === 'function';

/**
 * 深度克隆对象，优先使用structuredClone，失败时回退到JSON克隆
 * @param {*} obj - 待克隆的值
 * @returns {*} 深拷贝后的值，原始类型直接返回
 */
function deepClone(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (_hasStructuredClone) {
    try {
      return _stripDangerousKeys(structuredClone(obj));
    } catch (e) {
      if ((e && e.name === 'DataCloneError') || (typeof DOMException === 'function' && e instanceof DOMException && e.name === 'DataCloneError')) {
        return _jsonClone(obj);
      }
      throw e;
    }
  }
  return _jsonClone(obj);
}

/** @constant {Set<string>} DANGEROUS_KEYS_SET - 原型污染危险键集合，克隆时跳过这些键 */
const DANGEROUS_KEYS_SET = new Set(['__proto__', 'constructor', 'prototype']);

function _stripDangerousKeys(obj, depth) {
  if (depth == null) depth = 0;
  if (depth > 10 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(function(item) { return _stripDangerousKeys(item, depth + 1); });
  }
  const result = {};
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS_SET.has(key)) continue;
    const val = obj[key];
    if (val !== null && typeof val === 'object') {
      result[key] = _stripDangerousKeys(val, depth + 1);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function _safeShallowCopy(obj) {
  const copy = {};
  for (const k of Object.keys(obj)) {
    if (!DANGEROUS_KEYS_SET.has(k)) copy[k] = obj[k];
  }
  return copy;
}

/**
 * 使用JSON序列化方式进行深拷贝，失败时递归处理
 * @description JSON深拷贝，循环引用/BigInt时安全降级返回空对象/数组
 * @param {*} obj - 待克隆的对象
 * @returns {*} 深拷贝后的对象
 * @private
 */
function _jsonClone(obj) {
  try {
    try {
      return _stripDangerousKeys(JSON.parse(JSON.stringify(obj)));
    } catch (_e) {
      debug('deepClone', 'jsonClone:stringify', _e && _e.message ? _e.message : String(_e));
      return Array.isArray(obj) ? [] : {};
    }
  } catch (_e) {
    debug('deepClone', 'jsonClone:recursive', _e && _e.message ? _e.message : String(_e));
    if (Array.isArray(obj)) return obj.map(function(item) { return deepClone(item); });
    const result = {};
    for (const key of Object.keys(obj)) {
      if (DANGEROUS_KEYS_SET.has(key)) continue;
      const val = obj[key];
      if (val !== undefined) {
        try { result[key] = deepClone(val); } catch (_e2) { debug('deepClone', 'jsonClone:key', _e2 && _e2.message ? _e2.message : String(_e2)); result[key] = Array.isArray(val) ? [...val] : (val !== null && typeof val === 'object' ? _safeShallowCopy(val) : val); }
      }
    }
    return result;
  }
}

module.exports = deepClone;
