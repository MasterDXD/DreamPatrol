'use strict';

const { DANGEROUS_KEYS } = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');

const AR_CONTEXT_KEY = '_ar';
const VERSION = 1;
const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_LENGTH = 100;
const MAX_PREVIOUS_SCORE = 1.0;

const FIELDS = {
  PREVIOUS_RESULT: 'previousResult', PREVIOUS_SCORE: 'previousScore',
  QUALITY_HISTORY: 'qualityHistory', FEEDBACK: 'feedback',
  PREVIOUS_OUTPUT: 'previousOutput', FOCUS_AREAS: 'focusAreas',
  ORIGINAL_GOAL: 'originalGoal', ITERATION: 'iteration',
  MAX_ITERATIONS: 'maxIterations', ITERATION_SUMMARY: 'iterationSummary',
  SOURCE: 'source',
};

const VERSION_FIELD_MAP = { 0: [], 1: Object.values(FIELDS) };

const SOURCE_IDS = {
  ORCHESTRATOR: 'deepening-orchestrator', REFINEMENT: 'iterative-refinement',
  RECURRENT: 'recurrent-deepening-scheduler', SKILL_COMPLETE: 'skill-complete',
  PHASE_ADVANCE: 'phase-advance',
};

const MAX_FIELD_LENGTH = MAX_STRING_LENGTH;
const MAX_AR_FIELDS = 20;
const STRING_FIELDS = ['previousResult', 'previousOutput', 'originalGoal', 'feedback', 'iterationSummary', 'source'];
const ARRAY_FIELDS = ['qualityHistory', 'focusAreas'];

/**
 * @module runtime/context/autoregressive-context-schema
 * 向目标对象注入自回归上下文字段。过滤危险键，截断超长字符串和大数组，
 * 限制最大字段数，并自动添加版本号和更新时间戳。
 * @param {Object} target - 目标对象，将在此对象上设置_ar属性
 * @param {Object} fields - 待注入的字段键值对
 * @returns {Object} 注入后的目标对象
 */
function inject(target, fields) {
  if (!target || typeof target !== 'object') return null;
  if (!fields || typeof fields !== 'object') return target;
  const keys = Object.keys(fields);
  const knownFields = new Set(Object.values(FIELDS));
  target[AR_CONTEXT_KEY] = target[AR_CONTEXT_KEY] ?? {};
  let fieldCount = Object.keys(target[AR_CONTEXT_KEY]).filter(k => k !== '_version' && k !== 'updatedAt').length;
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (!knownFields.has(key)) {
      debug('AutoregressiveContextSchema', 'inject', 'Unknown field rejected: ' + key);
      continue;
    }
    if (fieldCount >= MAX_AR_FIELDS && !(key in target[AR_CONTEXT_KEY])) {
      debug('AutoregressiveContextSchema', 'inject', 'Max fields exceeded, skipping: ' + key);
      continue;
    }
    let value = fields[key];
    if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH) {
      value = value.substring(0, MAX_FIELD_LENGTH);
    }
    if (Array.isArray(value) && value.length > MAX_ARRAY_LENGTH) {
      value = value.slice(0, MAX_ARRAY_LENGTH);
    }
    if (!(key in target[AR_CONTEXT_KEY])) fieldCount++;
    target[AR_CONTEXT_KEY][key] = value;
  }
  target[AR_CONTEXT_KEY]._version = VERSION;
  target[AR_CONTEXT_KEY].updatedAt = Date.now();
  return target;
}

/**
 * 从目标对象中提取自回归上下文数据，排除版本号和更新时间戳等元数据字段。
 * @param {Object} target - 目标对象
 * @returns {Object|null} 上下文数据，目标无_ar属性时返回null
 */
function extract(target) {
  if (!target || !target[AR_CONTEXT_KEY]) return null;
  const raw = target[AR_CONTEXT_KEY];
  const ctx = {};
  for (const k of Object.keys(raw)) {
    if (k !== '_version' && k !== 'updatedAt') ctx[k] = raw[k];
  }
  return ctx;
}

/**
 * 合并自回归上下文：提取现有上下文，与覆盖字段合并后重新注入目标对象。
 * @param {Object} target - 目标对象
 * @param {Object} overrides - 需覆盖或新增的字段键值对
 * @returns {Object} 合并后的目标对象
 */
function merge(target, overrides) {
  return inject(target, { ...(extract(target) ?? {}), ...overrides });
}

function _validateType(ctx, fields, type, warnings) {
  const check = type === 'array' ? Array.isArray : v => typeof v === type;
  const label = type === 'array' ? 'an array' : `a ${type}`;
  for (const f of fields) {
    if (ctx[f] !== undefined && !check(ctx[f])) warnings.push(`${f} must be ${label}`);
  }
}

/**
 * 验证目标对象的自回归上下文数据。检查数值范围（previousScore、iteration、maxIterations）、
 * 数组类型字段（qualityHistory、focusAreas）和字符串类型字段的合法性。
 * @param {Object} target - 目标对象
 * @returns {{ valid: boolean, warnings: Array<string> }} 验证结果，valid为true表示无警告
 */
function validate(target) {
  const ctx = target?.[AR_CONTEXT_KEY];
  if (!ctx) return { valid: true, warnings: [] };
  const warnings = [];
  for (const [field, min, max] of [['previousScore', 0, MAX_PREVIOUS_SCORE], ['iteration', 0, null], ['maxIterations', 1, 100]]) {
    if (ctx[field] !== undefined && (typeof ctx[field] !== 'number' || ctx[field] < min || (max !== null && ctx[field] > max))) {
      warnings.push(`${field} must be a number${max !== null ? ` between ${min} and ${max}` : ` >= ${min}`}`);
    }
  }
  _validateType(ctx, ARRAY_FIELDS, 'array', warnings);
  _validateType(ctx, STRING_FIELDS, 'string', warnings);
  return { valid: warnings.length === 0, warnings };
}

/**
 * 检查目标对象的自回归上下文与所需版本的兼容性。比较上下文版本与所需版本，
 * 旧版本检查字段缺失，新版本返回不兼容警告。
 * @param {Object} target - 目标对象
 * @param {number} [requiredVersion] - 所需版本号，默认为当前VERSION
 * @returns {{ compatible: boolean, reason: string, contextVersion?: number, requiredVersion?: number, missingFields?: Array<string>, warning?: string }} 兼容性检查结果
 */
function compatibilityCheck(target, requiredVersion) {
  if (!target || !target[AR_CONTEXT_KEY]) return { compatible: true, reason: 'no_ar_context' };
  const ctxV = target[AR_CONTEXT_KEY]._version ?? 0;
  const reqV = requiredVersion ?? VERSION;
  if (ctxV === reqV) return { compatible: true, reason: 'version_match', contextVersion: ctxV, requiredVersion: reqV };
  if (ctxV > reqV) return { compatible: false, reason: 'newer_version_not_guaranteed_compatible', contextVersion: ctxV, requiredVersion: reqV, warning: 'Newer version may contain breaking changes; explicit opt-in required' };
  const supported = VERSION_FIELD_MAP[ctxV] ?? [];
  const required = VERSION_FIELD_MAP[reqV] ?? [];
  const missing = required.filter(f => !supported.includes(f));
  return { compatible: missing.length === 0, reason: missing.length ? 'missing_fields_in_older_version' : 'older_version_compatible', contextVersion: ctxV, requiredVersion: reqV, missingFields: missing };
}

/**
 * 从目标对象中移除自回归上下文属性（_ar），返回原对象引用。
 * @param {Object} target - 目标对象
 * @returns {Object} 移除_ar属性后的目标对象
 */
function strip(target) {
  if (!target || typeof target !== 'object') return target;
  delete target[AR_CONTEXT_KEY];
  return target;
}

module.exports = { AR_CONTEXT_KEY, VERSION, FIELDS, VERSION_FIELD_MAP, SOURCE_IDS, inject, extract, merge, validate, compatibilityCheck, strip };
