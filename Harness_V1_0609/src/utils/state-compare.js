/**
 * @module state-compare
 * @description 状态比较工具模块，提供深度相等比较和状态对象差异检测功能。
 * 可识别新增、移除、变更和未变更的键，支持NaN相等判断。
 */

'use strict';

/**
 * 深度相等比较，支持NaN判断
 * @param {*} a - 第一个值
 * @param {*} b - 第二个值
 * @returns {boolean} 是否深度相等
 * @private
 */
function _deepEqual(a, b) {
  if (a === b) return true;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!_deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!_deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * 比较两个状态对象的差异，返回新增、移除、变更和未变更的键列表
 * @param {Object} state1 - 旧状态对象
 * @param {Object} state2 - 新状态对象
 * @returns {{added: string[], removed: string[], changed: string[], unchanged: string[]}} 差异结果
 */
function compareStateObjects(state1, state2) {
  const s1 = state1 ?? {};
  const s2 = state2 ?? {};
  const keys1 = Object.keys(s1);
  const keys2 = Object.keys(s2);
  const keySet1 = new Set(keys1);
  const keySet2 = new Set(keys2);
  const added = keys2.filter(function(k) { return !keySet1.has(k); });
  const removed = keys1.filter(function(k) { return !keySet2.has(k); });
  const changed = [];
  const unchanged = [];
  for (const k of keys1) {
    if (!keySet2.has(k)) continue;
    const v1 = s1[k];
    const v2 = s2[k];
    if (!_deepEqual(v1, v2)) {
      changed.push(k);
    } else {
      unchanged.push(k);
    }
  }
  return { added: added, removed: removed, changed: changed, unchanged: unchanged };
}

module.exports = { compareStateObjects };
