/**
 * @module safe-execute
 * @description 安全执行工具模块，提供函数安全调用、错误发射、数值裁剪等通用安全操作。
 * 自动捕获同步和异步异常，支持回退值和调试日志记录。
 */

'use strict';

const debug = require('./debug-logger');

/**
 * 安全执行函数，自动捕获同步和异步异常
 * @param {Function} fn - 待执行的函数
 * @param {string} moduleLabel - 模块标签，用于调试日志
 * @param {string} actionLabel - 操作标签，用于调试日志
 * @param {*} [fallback] - 异常时的回退值，若为函数则调用获取回退值
 * @returns {*} 函数执行结果或回退值
 */
function safeExecute(fn, moduleLabel, actionLabel, fallback) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.catch(function(err) {
        debug(moduleLabel, actionLabel + ':async', err);
        return typeof fallback === 'function' ? fallback(err) : fallback;
      });
    }
    return result;
  } catch (err) {
    debug(moduleLabel, actionLabel, err);
    return typeof fallback === 'function' ? fallback(err) : fallback;
  }
}

/**
 * 安全调用函数，忽略异常，无返回值
 * @param {Function} fn - 待调用的函数
 * @param {string} moduleLabel - 模块标签
 * @param {string} actionLabel - 操作标签
 */
function safeCall(fn, moduleLabel, actionLabel) {
  try { fn(); } catch (err) { debug(moduleLabel, actionLabel, err); }
}

/**
 * 异步安全调用函数，忽略异常，无返回值
 * @param {Function} fn - 待调用的异步函数
 * @param {string} moduleLabel - 模块标签
 * @param {string} actionLabel - 操作标签
 * @returns {Promise<void>}
 */
async function safeCallAsync(fn, moduleLabel, actionLabel) {
  try { await fn(); } catch (err) { debug(moduleLabel, actionLabel, err); }
}

/**
 * 异步安全执行函数，自动捕获异常并返回回退值
 * @param {Function} fn - 待执行的异步函数
 * @param {string} moduleLabel - 模块标签
 * @param {string} actionLabel - 操作标签
 * @param {*} [fallback] - 异常时的回退值，若为函数则调用获取回退值
 * @returns {Promise<*>} 函数执行结果或回退值
 */
async function safeExecuteAsync(fn, moduleLabel, actionLabel, fallback) {
  try {
    return await fn();
  } catch (err) {
    debug(moduleLabel, actionLabel, err);
    return typeof fallback === 'function' ? fallback(err) : fallback;
  }
}

/**
 * 通过事件发射器安全发射错误事件，无error监听器时降级为safe-error事件
 * @param {EventEmitter} emitter - 事件发射器
 * @param {string} eventName - 事件名称
 * @param {Error} err - 错误对象
 * @param {Object} [extraContext] - 额外上下文信息
 */
function emitError(emitter, eventName, err, extraContext) {
  const payload = { ...extraContext, error: errorMessage(err) };
  if (eventName === 'error') {
    try {
      emitter.emit('error', payload);
    } catch (_emitErr) {
      emitter.emit('safe-error', payload);
    }
    return;
  }
  emitter.emit(eventName, payload);
}

/**
 * 从错误对象中提取错误消息字符串
 * @param {Error|*} err - 错误对象
 * @returns {string} 错误消息字符串
 */
function errorMessage(err) {
  return (err && err.message) || String(err);
}

/**
 * 将数值四舍五入到指定小数位数
 * @param {number} value - 待舍入的数值
 * @param {number} decimals - 小数位数
 * @returns {number} 舍入后的数值
 */
function roundTo(value, decimals) {
  if (!Number.isFinite(value)) return value;
  const shift = Math.pow(10, decimals);
  const shifted = value * shift;
  const rounded = Math.round(shifted);
  if (Math.abs(shifted - rounded) < 1e-10) {
    return rounded / shift;
  }
  return Number((value).toFixed(decimals));
}

/**
 * 将数值限制在[0, 1]区间内
 * @param {number} value - 待限制的数值
 * @returns {number} 限制后的数值
 */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/**
 * 确保返回值为数组，非数组值返回空数组。
 * @param {*} val - 待检查的值
 * @returns {Array<*>} 原数组或空数组
 */
function ensureArray(val) {
  return Array.isArray(val) ? val : [];
}

/**
 * 安全的 JSON 序列化，自动处理循环引用和序列化异常。
 * 循环引用替换为 '[Circular]'，序列化失败时降级为 String()。
 * @param {*} obj - 待序列化的对象
 * @param {Function} [replacer] - JSON.stringify 的替换函数
 * @param {string|number} [space] - JSON.stringify 的缩进参数
 * @returns {string} 序列化后的字符串
 */
function safeStringify(obj, replacer, space) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(obj, function(key, value) {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return typeof replacer === 'function' ? replacer(key, value) : value;
    }, space);
  } catch (_e) {
    return String(obj);
  }
}

/**
 * 安全获取 ISO 日期字符串，无效值降级为当前时间。
 * @param {*} value - 传入 Date 构造函数的值，null/undefined 返回当前时间
 * @returns {string} ISO 格式日期字符串
 */
function safeIsoDate(value) {
  if (value == null) return new Date().toISOString();
  const d = new Date(value);
  return !isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

/**
 * 安全获取Date的时间戳，防止RangeError和NaN传播
 * 当new Date()构造函数收到极端值时可能抛出RangeError，此函数统一防护
 * @param {*} value - 传入Date构造函数的值
 * @returns {number} 时间戳（毫秒），无效值返回NaN
 */
function safeDateGetTime(value) {
  try {
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : NaN;
  } catch (_e) {
    return NaN;
  }
}

module.exports = { safeExecute, safeCall, safeCallAsync, safeExecuteAsync, emitError, errorMessage, roundTo, clamp01, ensureArray, safeStringify, safeIsoDate, safeDateGetTime };
