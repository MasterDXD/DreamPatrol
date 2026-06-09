'use strict';

/**
 * @module dashboard/validation
 * @description Dashboard请求参数验证与知识库操作处理模块，提供参数校验、字符串消毒、Token记录验证等功能
 */

const C = require('./constants');
/** @constant {number} 最大字符串长度限制 */
const MAX_STRING_LENGTH = C.MAX_STRING_LENGTH;
/** @constant {string[]} 知识库允许的字段列表 */
const KNOWLEDGE_ALLOWED_FIELDS = C.KNOWLEDGE_ALLOWED_FIELDS;
/** @constant {number} 请求体最大字节数 */
const MAX_BODY_SIZE = C.MAX_BODY_SIZE;
/** @constant {number} 对象最大嵌套深度 */
const MAX_OBJECT_DEPTH = 10;
const { _apiError } = require('./utils');
const { debug } = require('../../utils/debug-logger');

/**
 * 递归验证对象嵌套深度是否超过限制
 * @param {*} obj - 待验证的对象
 * @param {number} maxDepth - 允许的最大嵌套深度
 * @param {number} [currentDepth=0] - 当前嵌套深度
 * @returns {boolean} 深度是否在允许范围内
 */
function validateObjectDepth(obj, maxDepth, currentDepth) {
  if (currentDepth == null) currentDepth = 0;
  if (currentDepth > maxDepth) return false;
  if (obj === null || typeof obj !== 'object') return true;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (!validateObjectDepth(obj[i], maxDepth, currentDepth + 1)) return false;
    }
    return true;
  }
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    if (!validateObjectDepth(obj[keys[i]], maxDepth, currentDepth + 1)) return false;
  }
  return true;
}

/**
 * 获取必填参数，缺失时抛出400错误
 * @param {URLSearchParams} params - 查询参数对象
 * @param {string} name - 参数名
 * @returns {string} 参数值
 * @throws {{_status: number, _data: object}} 参数缺失时抛出API错误
 */
function requireParam(params, name) {
  const val = params.get(name);
  if (val === null || val === '') throw _apiError('Missing required parameter: ' + name, 400);
  return val;
}

/**
 * 获取可选参数，缺失时返回空字符串
 * @param {URLSearchParams} params - 查询参数对象
 * @param {string} name - 参数名
 * @returns {string} 参数值或空字符串
 */
function optionalParam(params, name) {
  return params.get(name) ?? '';
}

/**
 * 解析整数参数，无效时抛出400错误
 * @param {URLSearchParams} params - 查询参数对象
 * @param {string} name - 参数名
 * @param {number} defaultValue - 默认值
 * @returns {number} 解析后的整数值
 * @throws {{_status: number, _data: object}} 参数非数字时抛出API错误
 */
function parseIntParam(params, name, defaultValue) {
  const raw = params.get(name);
  if (raw === null || raw === '') return defaultValue;
  const val = parseInt(raw, 10);
  if (!Number.isFinite(val)) throw _apiError('Invalid parameter: ' + name + ' must be a number', 400);
  return val;
}

/**
 * 验证Agent ID格式，仅允许字母数字、下划线和连字符
 * @param {string} agentId - Agent标识符
 * @returns {string} 验证通过的agentId
 * @throws {{_status: number, _data: object}} 格式无效时抛出API错误
 */
function validateAgentId(agentId) {
  if (agentId != null && !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    throw _apiError('Invalid agentId format: only alphanumeric, underscore and hyphen are allowed', 400);
  }
  return agentId;
}

/**
 * 验证枚举值是否在允许集合内
 * @param {string} value - 待验证的值
 * @param {Set<string>} allowedSet - 允许值集合
 * @param {string} paramName - 参数名称（用于错误消息）
 * @returns {string} 验证通过的值
 * @throws {{_status: number, _data: object}} 值不在允许集合时抛出API错误
 */
function validateEnum(value, allowedSet, paramName) {
  if (value != null && !allowedSet.has(value)) {
    throw _apiError('Invalid ' + paramName + ': must be one of ' + Array.from(allowedSet).join(','), 400);
  }
  return value;
}

/**
 * 消毒字符串字段，截断超长部分
 * @param {*} value - 待消毒的值
 * @param {number} [maxLen] - 最大长度限制
 * @param {string} [defaultVal=''] - 非字符串时的默认值
 * @returns {string} 消毒后的字符串
 */
function sanitizeStringField(value, maxLen, defaultVal) {
  if (typeof value !== 'string') return defaultVal ?? '';
  let s = value;
  if (s.length > (maxLen ?? MAX_STRING_LENGTH)) s = s.slice(0, maxLen ?? MAX_STRING_LENGTH);
  return s;
}

/**
 * 消毒字符串数组，截断超长项和超长数组
 * @param {*} arr - 待消毒的数组
 * @param {number} [maxItems=50] - 最大数组项数
 * @param {number} [maxItemLen] - 每项最大字符串长度
 * @returns {string[]} 消毒后的字符串数组
 */
function sanitizeStringArray(arr, maxItems, maxItemLen) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, maxItems ?? 50).map(function(item) {
    return sanitizeStringField(item, maxItemLen ?? MAX_STRING_LENGTH, '');
  });
}

/**
 * 消毒搜索参数，提取并验证关键词、日期范围和分页参数
 * @param {URLSearchParams} params - 查询参数对象
 * @returns {{keyword: string, startDate: string, endDate: string, page: number, pageSize: number}} 消毒后的搜索参数
 */
function sanitizeSearchParams(params) {
  return {
    keyword: sanitizeStringField(params.get('keyword') ?? '', 200, ''),
    startDate: sanitizeStringField(params.get('startDate') ?? '', 30, ''),
    endDate: sanitizeStringField(params.get('endDate') ?? '', 30, ''),
    page: Math.max(parseIntParam(params, 'page', 1), 1),
    pageSize: Math.min(parseIntParam(params, 'pageSize', 20), 100),
  };
}

/**
 * 处理知识库添加请求，验证字段白名单和内容长度
 * @param {object} store - 知识库存储实例
 * @param {object} body - 请求体，包含entry或content
 * @returns {{_status?: number, _data?: object}|*} 操作结果或错误对象
 */
function _validateKnowledgeFields(safeEntry) {
  const stringFields = { title: 200, source: 200 };
  for (const [name, maxLen] of Object.entries(stringFields)) {
    if (safeEntry[name] !== undefined) {
      if (typeof safeEntry[name] !== 'string') return { _status: 400, _data: { error: name + ' must be a string' } };
      if (safeEntry[name].length > maxLen) return { _status: 400, _data: { error: name + ' must be at most ' + maxLen + ' characters' } };
    }
  }
  if (safeEntry.tags !== undefined) {
    if (!Array.isArray(safeEntry.tags)) return { _status: 400, _data: { error: 'tags must be an array' } };
    if (safeEntry.tags.length > 50) return { _status: 400, _data: { error: 'tags must have at most 50 items' } };
  }
  // Confidence must be a finite number in [0, 1] to prevent out-of-range scores
  // that could skew quality metrics or bypass threshold-based decisions.
  if (safeEntry.confidence !== undefined) {
    if (typeof safeEntry.confidence !== 'number' || !Number.isFinite(safeEntry.confidence)) return { _status: 400, _data: { error: 'confidence must be a number' } };
    if (safeEntry.confidence < 0 || safeEntry.confidence > 1) return { _status: 400, _data: { error: 'confidence must be between 0 and 1' } };
  }
  return null;
}

function handleKnowledgeAdd(store, body) {
  if (!body.entry && !body.content) return { _status: 400, _data: { error: 'entry or content required for add' } };
  if (!validateObjectDepth(body, MAX_OBJECT_DEPTH)) return { _status: 400, _data: { error: 'Request body exceeds maximum nesting depth' } };
  const entry = body.entry ?? {};
  const safeEntry = {};
  for (let i = 0; i < KNOWLEDGE_ALLOWED_FIELDS.length; i++) {
    const field = KNOWLEDGE_ALLOWED_FIELDS[i];
    if (entry[field] !== undefined) safeEntry[field] = entry[field];
  }
  const fieldErr = _validateKnowledgeFields(safeEntry);
  if (fieldErr) return fieldErr;
  if (!safeEntry.content && body.content) {
    if (typeof body.content !== 'string' || body.content.length > MAX_BODY_SIZE) {
      return { _status: 400, _data: { error: 'content must be a string (max 1MB)' } };
    }
    safeEntry.content = body.content;
  }
  try {
    return store.addKnowledge(safeEntry);
  } catch (_err) {
    debug('handleKnowledgeAdd', 'addKnowledge', _err && _err.message ? _err.message : String(_err));
    return { _status: 500, _data: { error: 'Failed to add knowledge' } };
  }
}

/**
 * 处理知识库更新请求，验证ID和更新字段白名单
 * @param {object} store - 知识库存储实例
 * @param {object} body - 请求体，包含id和updates
 * @returns {{_status?: number, _data?: object}|*} 操作结果或错误对象
 */
function handleKnowledgeUpdate(store, body) {
  if (!body.id || typeof body.id !== 'string') return { _status: 400, _data: { error: 'id (string) required for update' } };
  if (body.id.length > MAX_STRING_LENGTH) return { _status: 400, _data: { error: 'id exceeds maximum length' } };
  if (!body.updates || typeof body.updates !== 'object') return { _status: 400, _data: { error: 'updates (object) required for update' } };
  if (!validateObjectDepth(body, MAX_OBJECT_DEPTH)) return { _status: 400, _data: { error: 'Request body exceeds maximum nesting depth' } };
  const safeUpdates = {};
  for (let i = 0; i < KNOWLEDGE_ALLOWED_FIELDS.length; i++) {
    const field = KNOWLEDGE_ALLOWED_FIELDS[i];
    if (field === 'id') continue;
    if (body.updates[field] !== undefined) {
      if (field === 'tags' && !Array.isArray(body.updates[field])) continue;
      if (field === 'confidence' && typeof body.updates[field] !== 'number') continue;
      if ((field === 'content' || field === 'title' || field === 'source') && typeof body.updates[field] !== 'string') continue;
      safeUpdates[field] = body.updates[field];
    }
  }
  if (Object.keys(safeUpdates).length === 0) {
    return { _status: 400, _data: { error: 'No valid fields to update' } };
  }
  try {
    return store.updateKnowledge(body.id, safeUpdates);
  } catch (err) {
    debug('Dashboard', 'knowledgeUpdateError', err);
    return { _status: 500, _data: { error: 'Failed to update knowledge' } };
  }
}

/**
 * 处理知识库删除请求，验证ID格式
 * @param {object} store - 知识库存储实例
 * @param {object} body - 请求体，包含id
 * @returns {{_status?: number, _data?: object}|*} 操作结果或错误对象
 */
function handleKnowledgeRemove(store, body) {
  if (!body.id || typeof body.id !== 'string') return { _status: 400, _data: { error: 'id (string) required for remove' } };
  if (body.id.length > MAX_STRING_LENGTH) return { _status: 400, _data: { error: 'id exceeds maximum length' } };
  try {
    return store.removeKnowledge(body.id);
  } catch (_err) {
    debug('handleKnowledgeRemove', 'removeKnowledge', _err && _err.message ? _err.message : String(_err));
    return { _status: 500, _data: { error: 'Failed to remove knowledge' } };
  }
}

/**
 * 验证非负数字段
 * @param {*} value - 待验证的值
 * @param {string} fieldName - 字段名称
 * @returns {{_status: number, _data: object}|null} 错误对象或null
 * @private
 */
function _validateNonNegativeNumber(value, fieldName) {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    return { _status: 400, _data: { error: fieldName + ' must be a non-negative number' } };
  }
  return null;
}

/**
 * 验证Token记录请求体，校验sessionId、tokens及各分项字段
 * @param {object} body - 请求体
 * @returns {{_status: number, _data: object}|null} 错误对象或null（验证通过）
 */
function validateTokenRecordBody(body) {
  if (!body || typeof body !== 'object') return { _status: 400, _data: { error: 'Request body required' } };
  if (!validateObjectDepth(body, MAX_OBJECT_DEPTH)) return { _status: 400, _data: { error: 'Request body exceeds maximum nesting depth' } };
  if (!body.sessionId || typeof body.sessionId !== 'string') return { _status: 400, _data: { error: 'sessionId required' } };
  if (body.sessionId.length > MAX_STRING_LENGTH) return { _status: 400, _data: { error: 'sessionId too long' } };
  if (typeof body.tokens !== 'number' || !Number.isFinite(body.tokens) || body.tokens < 0) return { _status: 400, _data: { error: 'tokens (non-negative number) required' } };
  let fieldErr;
  fieldErr = _validateNonNegativeNumber(body.inputTokens, 'inputTokens'); if (fieldErr) return fieldErr;
  fieldErr = _validateNonNegativeNumber(body.outputTokens, 'outputTokens'); if (fieldErr) return fieldErr;
  fieldErr = _validateNonNegativeNumber(body.toolCallTokens, 'toolCallTokens'); if (fieldErr) return fieldErr;
  return null;
}

/**
 * 将Token使用量记录到会话管理器
 * @param {object} session - 会话管理器实例
 * @param {string} sessionId - 会话ID
 * @param {number} tokens - Token使用量
 * @param {object} result - 结果对象（会被修改）
 */
function recordToSession(session, sessionId, tokens, result) {
  if (!session) return;
  try {
    if (typeof session.addTokenUsage === 'function') {
      session.addTokenUsage(sessionId, tokens);
      if (session.sessions && session.sessions[sessionId]) {
        result.sessionTokensUsed = session.sessions[sessionId].tokensUsed;
      }
    }
  } catch (_err) {
    debug('Dashboard', 'tokenRecordSession', _err);
    result.sessionError = 'session_recording_failed';
  }
}

/**
 * 将Token使用量记录到Token管理器
 * @param {object} tokenManager - Token管理器实例
 * @param {object} body - 请求体
 * @param {number} tokens - Token使用量
 * @param {object} result - 结果对象
 */
function recordToTokenManager(tokenManager, body, tokens, result) {
  if (!tokenManager) return;
  try {
    tokenManager.recordUsage({
      sessionId: body.sessionId,
      tokens: tokens,
      inputTokens: typeof body.inputTokens === 'number' && Number.isFinite(body.inputTokens) ? body.inputTokens : 0,
      outputTokens: typeof body.outputTokens === 'number' && Number.isFinite(body.outputTokens) ? body.outputTokens : 0,
      toolCallTokens: typeof body.toolCallTokens === 'number' && Number.isFinite(body.toolCallTokens) ? body.toolCallTokens : 0,
      result: result,
    });
  } catch (_err) {
    debug('Dashboard', 'tokenRecordManager', _err);
  }
}

module.exports = {
  requireParam,
  optionalParam,
  parseIntParam,
  validateAgentId,
  validateEnum,
  sanitizeStringField,
  sanitizeStringArray,
  sanitizeSearchParams,
  handleKnowledgeAdd,
  handleKnowledgeUpdate,
  handleKnowledgeRemove,
  validateTokenRecordBody,
  validateObjectDepth,
  recordToSession,
  recordToTokenManager,
};
