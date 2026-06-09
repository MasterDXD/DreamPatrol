'use strict';

/**
 * 统一唯一ID生成模块。提供多种ID生成策略，替代代码库中散落的ID生成模式。
 *
 * 策略选择指南：
 * - `uuid()` — 需要标准UUID格式时使用（如外部接口ID）
 * - `shortId()` — 需要紧凑但唯一的ID（如内部对象标识）
 * - `timestampId()` — 需要时间排序性的ID（如事件ID、提案ID）
 * - `counterId()` — 需要严格递增的短ID（如内部队列元素、订阅ID）
 * - `secureId()` — 需要密码学安全的随机ID（如请求ID、审批ID、CSP nonce）
 * - `generateId()` — 向后兼容，委托给uuid/timestampId
 *
 * @module utils/unique-id
 * @example
 * const { uuid, shortId, timestampId, counterId, secureId } = require('./unique-id');
 * uuid('sess-');        // 'sess-550e8400-e29b-41d4-a716-446655440000'
 * shortId('snap-', 12); // 'snap-a1b2c3d4e5f6'
 * timestampId('prop-'); // 'prop-m1abc123_def45678'
 * counterId('tq-');     // 'tq-1', 'tq-2', ...
 * secureId('approval-'); // 'approval-a1b2c3d4e5f6g7h8'
 */

const crypto = require('crypto');

const ID_PREFIXES = Object.freeze({
  AGENT_CHANNEL: 'ch-',
  AGENT_DEPLOYMENT: 'deploy-',
  AGENT_ROUTING: 'mar-',
  AGENT_SNAPSHOT: 'snap-',
  AGENT_SUBAGENT: 'sa-',
  AGENT_TASK: 'task-',
  APPROVAL: 'approval-',
  AUDIT: 'audit-',
  CAUSAL_MEMORY: 'cm-',
  CHECKPOINT: 'cp-',
  CHAIN: 'chain-',
  CODE_REVIEW: 'rev-',
  DEEPENING_ALLOC: 'alloc-',
  DEEPENING_NOTIF: 'notif-',
  DEEPENING_PIPE: 'pipe-',
  DEEPENING_PQ: 'pq-',
  DEEPENING_REPLAY: 'replay-',
  DEEPENING_SCHED: 'sched-',
  DEEPENING_SNAPSHOT: 'snap-',
  DEEPENING_SNAPSHOT_STORE: 'ss-',
  DEEPENING_SUB: 'sub-',
  DEEPENING_TIMEOUT: 'to-',
  DEEPENING_TQ: 'tq-',
  DEVIATION: 'dev-',
  ERROR: 'err-',
  GOAL: 'goal-',
  HOOK: 'hook-',
  MEMORY: 'mem-',
  PAIR: 'pair-',
  PATCH: 'patch-',
  PIPELINE: 'pipe-',
  PROPOSAL: 'prop-',
  REFLECTION: 'refl-',
  RETRY: 're-',
  SESSION: 'sess-',
  SIGNAL: 'sig-',
  SKILL: 'skill-',
  SUBTASK: 'sub-',
  THOUGHT: 'tht-',
  CONTEXT: 'ictx-',
});

const _counterRegistry = new Map();

/**
 * 生成标准UUID v4字符串，可选附加前缀。
 * @param {string} [prefix] - ID前缀，用于标识ID类型
 * @returns {string} UUID字符串，格式如 `prefixxxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`
 */
function uuid(prefix) {
  const id = crypto.randomUUID();
  return prefix ? prefix + id : id;
}

/**
 * 生成紧凑的随机ID，基于UUID去除连字符后截取。
 * @param {string} [prefix=''] - ID前缀
 * @param {number} [length=12] - 随机部分长度（最大32）
 * @returns {string} 紧凑随机ID
 */
function shortId(prefix, length) {
  const safeLen = (typeof length === 'number' && Number.isFinite(length) && length > 0) ? Math.min(length, 32) : 12;
  const raw = crypto.randomUUID().replace(/-/g, '');
  const id = raw.slice(0, safeLen);
  return prefix ? prefix + id : id;
}

/**
 * 生成基于时间戳的ID，包含base36时间戳和8位随机后缀。
 * 时间排序性保证：同一毫秒内生成的ID按随机后缀区分。
 * @param {string} [prefix=''] - ID前缀
 * @returns {string} 格式为 `prefix<base36ts>_<8位hex>` 的ID
 */
function timestampId(prefix) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const id = ts + '_' + rand;
  return prefix ? prefix + id : id;
}

/**
 * 生成基于自增计数器的ID。每个前缀/作用域维护独立计数器。
 * 适用于内部元素标识（队列项、订阅等），不适用于需要不可预测性的场景。
 * @param {string} [prefix=''] - ID前缀
 * @param {string} [scope] - 计数器作用域，默认使用prefix作为作用域
 * @returns {string} 格式为 `prefix<N>` 的递增ID
 */
function counterId(prefix, scope) {
  const key = scope || prefix || '_global';
  let counter = _counterRegistry.get(key);
  if (counter === undefined) {
    counter = 0;
    _counterRegistry.set(key, counter);
  }
  counter++;
  _counterRegistry.set(key, counter);
  return prefix ? prefix + counter : String(counter);
}

/**
 * 生成密码学安全的随机ID，基于crypto.randomBytes。
 * 适用于请求ID、审批ID、CSP nonce等安全敏感场景。
 * @param {string} [prefix=''] - ID前缀
 * @param {number} [bytes=8] - 随机字节数，输出为2倍长度的hex字符串
 * @returns {string} 格式为 `prefix<hex>` 的安全随机ID
 */
function secureId(prefix, bytes) {
  const safeBytes = (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 && bytes <= 256) ? bytes : 8;
  const id = crypto.randomBytes(safeBytes).toString('hex');
  return prefix ? prefix + id : id;
}

/**
 * 重置计数器。用于测试隔离或重置特定作用域的计数器。
 * @param {string} [scope] - 要重置的作用域，省略则重置所有计数器
 */
function resetCounter(scope) {
  if (scope) {
    _counterRegistry.delete(scope);
  } else {
    _counterRegistry.clear();
  }
}

/**
 * 获取指定作用域的计数器当前值
 * @param {string} [scope] - 计数器作用域，省略使用全局作用域
 * @returns {number} 当前计数值
 */
function getCounterValue(scope) {
  const key = scope || '_global';
  return _counterRegistry.get(key) ?? 0;
}

/**
 * 获取所有计数器作用域名称列表
 * @returns {string[]} 作用域名称数组
 */
function getCounterScopes() {
  return Array.from(_counterRegistry.keys());
}

/**
 * 向后兼容的ID生成函数。有前缀时生成UUID，无前缀时生成时间戳+随机ID。
 * @param {string} [prefix] - ID前缀
 * @returns {string} 生成的ID
 * @deprecated 新代码应使用 uuid()、shortId() 或 timestampId() 替代
 */
function generateId(prefix) {
  if (prefix) return prefix + crypto.randomUUID();
  return Date.now().toString(36) + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

module.exports = {
  ID_PREFIXES,
  uuid,
  shortId,
  timestampId,
  counterId,
  secureId,
  generateId,
  resetCounter,
  getCounterValue,
  getCounterScopes,
};
