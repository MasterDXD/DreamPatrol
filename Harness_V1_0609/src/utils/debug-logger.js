/**
 * @module debug-logger
 * @description 调试日志模块，提供轻量级调试输出功能。支持模块化日志标签、
 * 消息长度限制、敏感信息过滤，以及与结构化日志器的桥接。
 */

'use strict';

const { sanitizeLogMsg } = require('./sanitizer');
/** @constant {boolean} DEBUG - 是否启用调试模式，由环境变量HARNESS_DEBUG控制 */
const DEBUG = process.env.HARNESS_DEBUG === '1' || process.env.HARNESS_DEBUG === 'true';
/** @constant {number} MAX_DEBUG_MSG_LENGTH - 调试消息最大长度 */
const MAX_DEBUG_MSG_LENGTH = 2000;
/** @constant {RegExp} LABEL_PATTERN - 标签中需要过滤的非法字符正则 */
const LABEL_PATTERN = /[\r\n\0]/g;

/**
 * 清理日志标签中的非法字符
 * @param {string} label - 待清理的标签
 * @returns {string} 清理后的标签
 * @private
 */
function _sanitizeLabel(label) {
  return String(label).replace(LABEL_PATTERN, '');
}

/** @private */
let _bridge = null;

/**
 * 输出调试日志，支持模块化标签和结构化日志桥接。
 * 若只传入module参数，则返回该模块的专用日志函数。
 * @param {string} moduleName - 模块名称
 * @param {string} [action] - 操作名称
 * @param {Error|*} [error] - 错误对象或消息
 * @returns {Function|void} 仅传入moduleName时返回模块专用日志函数
 */
function debug(module, action, error) {
  if (action === undefined) {
    return createModuleLogger(module);
  }
  if (!DEBUG && !_bridge) return;
  let msg = error instanceof Error ? error.message + ' (' + (error.code || error.name) + ')' : String(error);
  msg = sanitizeLogMsg(msg);
  if (msg.length > MAX_DEBUG_MSG_LENGTH) {
    msg = msg.slice(0, MAX_DEBUG_MSG_LENGTH) + '...[truncated]';
  }
  if (DEBUG) {
    process.stderr.write('[Harness:' + _sanitizeLabel(module) + ':' + _sanitizeLabel(action) + '] ' + msg + '\n');
  }
  if (_bridge) {
    try { _bridge.warn('[' + _sanitizeLabel(module) + ':' + _sanitizeLabel(action) + '] ' + msg); } catch (e) { process.stderr.write('[Harness:bridge] ' + (e && e.message ? e.message : String(e)) + '\n'); }
  }
}

/**
 * 设置结构化日志桥接器
 * @param {Object|null} structuredLogger - 结构化日志器实例，需提供warn方法
 */
function setBridge(structuredLogger) {
  _bridge = structuredLogger ?? null;
}

/**
 * 创建模块专用的日志函数
 * @param {string} moduleName - 模块名称
 * @returns {Function} 模块专用日志函数，签名为(action, error)
 */
function createModuleLogger(moduleName) {
  return function(action, error) {
    debug(moduleName, action, error);
  };
}

module.exports = debug;
module.exports.debug = debug;
module.exports.setBridge = setBridge;
module.exports.createModuleLogger = createModuleLogger;
