/**
 * @module stable-stringify
 * @description 稳定序列化工具模块，提供键排序的确定性JSON序列化功能。
 * 确保相同内容的对象始终生成相同的JSON字符串，支持循环引用检测。
 */

'use strict';

const { debug } = require('./debug-logger');

/**
 * 稳定序列化对象为JSON字符串，键按字母排序，循环引用输出"[Circular]"
 * @param {*} val - 待序列化的值
 * @param {Function} [replacer] - JSON替换函数（保留参数，当前未使用）
 * @param {string|number} [space] - 缩进空格数（保留参数，当前未使用）
 * @param {WeakSet} [_seenInternal] - 内部使用的循环引用检测集合
 * @returns {string} 稳定排序后的JSON字符串
 */
function stableStringify(val, replacer, space, _seenInternal) {
  if (val === null) return 'null';
  if (val === undefined) return 'null';
  if (typeof val !== 'object') return JSON.stringify(val);
  const seen = (_seenInternal instanceof WeakSet) ? _seenInternal : new WeakSet();
  if (seen.has(val)) return '"[Circular]"';
  seen.add(val);
  if (Array.isArray(val)) {
    const items = val.map(function(v) { return stableStringify(v, null, null, seen); });
    return '[' + items.join(',') + ']';
  }
  const keys = Object.keys(val).sort();
  return '{' + keys.map(function(k) { return JSON.stringify(k) + ':' + stableStringify(val[k], null, null, seen); }).join(',') + '}';
}

/**
 * 稳定序列化对象为格式化的JSON字符串（带缩进）
 * @param {*} val - 待序列化的值
 * @param {string|number} [space=2] - 缩进空格数或字符串
 * @returns {string} 格式化的稳定JSON字符串
 */
function stableStringifyPretty(val, space) {
  const compact = stableStringify(val);
  try {
    const parsed = JSON.parse(compact);
    return JSON.stringify(parsed, null, space ?? 2);
  } catch (_e) {
    debug('stable-stringify', 'stableStringifyPretty', _e && _e.message ? _e.message : String(_e));
    return compact;
  }
}

module.exports = stableStringify;
module.exports.stableStringifyPretty = stableStringifyPretty;
