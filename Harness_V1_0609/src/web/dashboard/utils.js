'use strict';

/**
 * @module dashboard/utils
 * @description Dashboard内部工具函数模块，提供URI解码、路径提取、错误构造、参数包装和对象深度验证等基础能力
 */

const { JSON_CONTENT_TYPE } = require('./constants/index');
const { debug } = require('../../utils/debug-logger');
const safeAssign = require('../../utils/safe-assign');

/**
 * 安全解码URI组件，解码失败时返回原始字符串
 * @param {string} source - 待解码的URI字符串
 * @returns {string} 解码后的字符串或原始字符串
 */
function _safeDecodeURI(source) {
  try { return decodeURIComponent(source); } catch (_e) { debug('dashboard/utils', '_safeDecodeURI', _e && _e.message ? _e.message : String(_e)); return source; }
}

/**
 * 从HTTP请求中提取路径名（不含查询字符串）
 * @param {http.IncomingMessage} req - HTTP请求对象
 * @returns {string} 请求路径名
 */
function _getPathname(req) {
  return (req.url || '/').split('?')[0];
}

/**
 * 构造API错误对象，包含状态码、错误消息和时间戳
 * @param {string} message - 错误消息
 * @param {number} [status=400] - HTTP状态码
 * @returns {{_status: number, _data: {error: string, timestamp: string}}} API错误对象
 */
function _apiError(message, status) {
  return { _status: status ?? 400, _data: { error: message, timestamp: new Date().toISOString() } };
}

/**
 * 将普通对象包装为类URLSearchParams接口的对象
 * @param {object|null} obj - 待包装的对象
 * @returns {{get: Function, has: Function, toString: Function, _raw: object}} 参数包装对象
 */
function _wrapParams(obj) {
  if (!obj || typeof obj !== 'object') return _emptyParams();
  return {
    get(key) { const v = obj[key]; return (v != null) ? String(v) : null; },
    has(key) { return key in obj && obj[key] != null; },
    toString() { return JSON.stringify(obj); },
    _raw: obj,
  };
}

/**
 * 创建空的参数包装对象，所有get返回null、has返回false
 * @returns {{get: Function, has: Function, toString: Function, _raw: object}} 空参数对象
 */
function _emptyParams() {
  return {
    get() { return null; },
    has() { return false; },
    toString() { return '{}'; },
    _raw: {},
  };
}

/**
 * 发送HTTP错误响应，包含安全头和JSON错误体
 * @param {http.ServerResponse} res - HTTP响应对象
 * @param {number} status - HTTP状态码
 * @param {string} message - 错误消息
 * @param {object} [extraHeaders] - 额外响应头
 */
function _sendError(res, status, message, extraHeaders, corsOrigin) {
  if (res.headersSent || res.writableEnded) return;
  const headers = safeAssign({}, extraHeaders);
  headers['Content-Type'] = JSON_CONTENT_TYPE;
  headers['Cache-Control'] = 'no-cache';
  headers['X-Content-Type-Options'] = 'nosniff';
  headers['X-Frame-Options'] = 'DENY';
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  res.writeHead(status, headers);
  try {
    res.end(JSON.stringify({ error: message, status: status, timestamp: new Date().toISOString() }));
  } catch (_e) {
    debug('dashboard/utils', '_sendError', _e && _e.message ? _e.message : String(_e));
    res.end(JSON.stringify({ error: 'Internal error', status: status }));
  }
}

/**
 * 验证对象嵌套深度和单层键数量是否在安全范围内
 * @param {*} obj - 待验证的对象
 * @param {number} maxDepth - 允许的最大嵌套深度
 * @param {number} [currentDepth=0] - 当前嵌套深度
 * @returns {boolean} 对象是否在安全范围内
 */
function _validateObjectDepth(obj, maxDepth, currentDepth) {
  if (typeof maxDepth !== 'number' || !Number.isFinite(maxDepth) || maxDepth < 1) {
    maxDepth = 10;
  }
  if (currentDepth == null) currentDepth = 0;
  if (currentDepth > maxDepth) return false;
  if (obj !== null && typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length > 1000) return false;
    for (let i = 0; i < keys.length; i++) {
      if (!_validateObjectDepth(obj[keys[i]], maxDepth, currentDepth + 1)) return false;
    }
  }
  return true;
}

module.exports = {
  _safeDecodeURI,
  _getPathname,
  _apiError,
  _wrapParams,
  _emptyParams,
  _sendError,
  _validateObjectDepth,
};
