'use strict';

const path = require('path');

/**
 * 六阶段流程常量定义和YAML Frontmatter解析工具。
 * 提供阶段序列、转换规则、阶段Skill映射，以及轻量级Frontmatter解析器。
 *
 * @module utils/constants
 */

/**
 * 六阶段流程序列。
 * @type {string[]}
 */
const PHASES = [
  'brainstorming',
  'requirement-analysis',
  'architecture-design',
  'module-development',
  'integration-testing',
  'deployment',
];

/**
 * 阶段转换规则。key为源阶段，value为允许转换的目标阶段列表。
 * 支持向前推进和受控回退（需审批）。
 * @type {Object<string, string[]>}
 */
const PHASE_TRANSITIONS = {
  'brainstorming': ['requirement-analysis'],
  'requirement-analysis': ['architecture-design', 'brainstorming'],
  'architecture-design': ['module-development', 'requirement-analysis'],
  'module-development': ['integration-testing', 'architecture-design'],
  'integration-testing': ['deployment', 'module-development'],
  'deployment': ['integration-testing'],
};

/**
 * 每个阶段所需的Skill列表。
 * @type {Object<string, string[]>}
 */
const PHASE_SKILLS = {
  'brainstorming': ['brainstorming', 'idea-validation', 'ai-research', 'office-hours', 'plan-ceo-review'],
  'requirement-analysis': ['requirement-analysis'],
  'architecture-design': ['architecture-design', 'plan-eng-review'],
  'module-development': [
    'tdd-implement', 'module-development', 'dispatching-parallel',
    'code-review', 'verification-before-completion', 'systematic-debugging',
    'bug-fix', 'security-audit', 'performance-optimization', 'refactor-code',
    'iterative-deepening', 'multi-agent-fusion', 'mvp-builder',
    'optimization-loop',
    'pair-chat', 'self-reflection',
    'review-paranoid', 'cso-security',
  ],
  'integration-testing': ['integration-testing', 'browse-qa', 'qa-find-fix'],
  'deployment': ['deployment', 'documentation', 'auto-doc-generation', 'ai-native-scaling', 'ship-release', 'retro-sprint'],
};

/**
 * 解析Markdown文件中的YAML Frontmatter。
 * 支持简单键值对、行内数组（[a, b]）和YAML多行数组（- item）格式。
 *
 * @param {string} content - Markdown文件完整内容
 * @returns {Object<string, string|string[]>|null} 解析出的键值对象，无Frontmatter则返回null
 *
 * @example
 * parseFrontmatter('---\nname: test\nphase: dev\n---')
 * // => { name: 'test', phase: 'dev' }
 */
function _flushArrayState(result, currentKey, inArray, arrayValues, pendingObject) {
  if (pendingObject && inArray) {
    arrayValues.push(pendingObject);
  }
  if (inArray && currentKey) {
    result[currentKey] = arrayValues;
  }
  return { currentKey: null, inArray: false, arrayValues: [], pendingObject: null };
}

function _parseInlineArray(value) {
  if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
    const result = parseArray(value);
    return result.length > 0 ? result : null;
  }
  return null;
}

function _parseArrayItem(line) {
  const itemValue = line.trim().slice(2).trim().replace(/^['"]|['"]$/g, '');
  const objMatch = itemValue.match(/^(\w[\w-]*):\s*(.*)/);
  if (objMatch) {
    const obj = {};
    obj[objMatch[1]] = objMatch[2].trim().replace(/^['"]|['"]$/g, '');
    return { isObject: true, value: obj };
  }
  return { isObject: false, value: itemValue };
}

function _flushCurrentState(result, currentKey, inArray, arrayValues, pendingObject, inNestedObject, nestedObject) {
  if (pendingObject && inArray) {
    arrayValues.push(pendingObject);
    pendingObject = null;
  }
  if (inNestedObject && currentKey) {
    if (nestedObject && nestedObject._pendingArrayKey) {
      delete nestedObject._pendingArrayKey;
    }
    result[currentKey] = nestedObject;
    inNestedObject = false;
    nestedObject = null;
    inArray = false;
    arrayValues = [];
  } else if (inArray && currentKey) {
    result[currentKey] = arrayValues;
    inArray = false;
    arrayValues = [];
  }
  return { inArray, arrayValues, pendingObject, inNestedObject, nestedObject };
}

function _coerceYamlValue(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null') return null;
  if (/^-?\d+$/.test(val)) { const n = Number(val); return Number.isFinite(n) && Number.isSafeInteger(n) ? n : val; }
  if (/^-?\d+\.\d+$/.test(val)) { const n = parseFloat(val); return Number.isFinite(n) ? n : val; }
  return val;
}

function _handleIndentedLine(subMatch, pendingObject, inNestedObject, nestedObject) {
  if (!subMatch) return { pendingObject, inNestedObject, nestedObject };
  const rawVal = subMatch[2].trim().replace(/^['"]|['"]$/g, '');
  const inlineArray = _parseInlineArray(rawVal);
  const val = rawVal === '' ? rawVal : (inlineArray || _coerceYamlValue(rawVal));
  const targetObj = pendingObject || nestedObject;
  if (targetObj) {
    if (rawVal === '') {
      targetObj._pendingArrayKey = subMatch[1];
      targetObj[subMatch[1]] = [];
    } else {
      targetObj[subMatch[1]] = val;
    }
  } else if (!inNestedObject) {
    inNestedObject = true;
    nestedObject = {};
    if (rawVal === '') {
      nestedObject._pendingArrayKey = subMatch[1];
      nestedObject[subMatch[1]] = [];
    } else {
      nestedObject[subMatch[1]] = val;
    }
  }
  return { pendingObject, inNestedObject, nestedObject };
}

function _handleKeyValue(result, currentKey, value) {
  const inlineArray = _parseInlineArray(value);
  if (inlineArray) {
    result[currentKey] = inlineArray;
    return { inArray: false, nestedObject: null, inNestedObject: false };
  }
  if (value === '') {
    return { inArray: true, nestedObject: null, inNestedObject: false };
  }
  if (value === 'true') {
    result[currentKey] = true;
  } else if (value === 'false') {
    result[currentKey] = false;
  } else if (value === 'null') {
    result[currentKey] = null;
  } else if (/^-?\d+$/.test(value)) {
    const n = parseInt(value, 10);
    result[currentKey] = Number.isFinite(n) ? n : value;
  } else if (/^-?\d+\.\d+$/.test(value)) {
    const n = parseFloat(value);
    result[currentKey] = Number.isFinite(n) ? n : value;
  } else {
    result[currentKey] = value;
  }
  return { inArray: false, nestedObject: null, inNestedObject: false };
}

function _processArrayLine(line, pendingObject, inNestedObject, nestedObject, arrayValues) {
  if (pendingObject) {
    arrayValues.push(pendingObject);
    pendingObject = null;
  }
  const item = _parseArrayItem(line);
  const targetObj = nestedObject && inNestedObject ? nestedObject : null;
  if (targetObj && targetObj._pendingArrayKey) {
    targetObj[targetObj._pendingArrayKey].push(item.value);
  } else if (item.isObject) {
    pendingObject = item.value;
  } else {
    arrayValues.push(item.value);
  }
  return { pendingObject, arrayValues };
}

function parseFrontmatter(content) {
  let stripped = content;
  while (stripped.charCodeAt(0) === 0xFEFF) {
    stripped = stripped.slice(1);
  }
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  return _processFrontMatterBlock(match[1]);
}

/**
 * 处理frontmatter块内容。
 * @param {string} raw - 原始frontmatter文本
 * @returns {Object} 解析结果
 * @private
 */
function _processFrontMatterBlock(raw) {
  const result = {};
  const lines = raw.split(/\r?\n/);
  const state = {
    currentKey: null,
    inArray: false,
    arrayValues: [],
    pendingObject: null,
    nestedObject: null,
    inNestedObject: false,
    inBlockScalar: false,
    blockScalarKey: null,
    blockScalarLines: [],
    blockScalarType: null,
  };

  for (const line of lines) {
    _parseFrontMatterLine(line, result, state);
  }

  // Flush any remaining block scalar
  if (state.inBlockScalar && state.blockScalarKey) {
    const joined = state.blockScalarType === '>'
      ? state.blockScalarLines.join(' ').replace(/\s+/g, ' ').trim()
      : state.blockScalarLines.join('\n').trim();
    result[state.blockScalarKey] = joined;
  }

  if (state.inNestedObject && state.currentKey) {
    if (state.nestedObject && state.nestedObject._pendingArrayKey) {
      delete state.nestedObject._pendingArrayKey;
    }
    result[state.currentKey] = state.nestedObject;
  } else {
    _flushArrayState(result, state.currentKey, state.inArray, state.arrayValues, state.pendingObject);
  }

  for (const key of Object.keys(result)) {
    if (result[key] && typeof result[key] === 'object' && result[key]._pendingArrayKey) {
      delete result[key]._pendingArrayKey;
    }
  }

  return result;
}

/**
 * 解析单行frontmatter。
 * @param {string} line - 单行文本
 * @param {Object} result - 累积结果对象
 * @param {Object} state - 解析状态
 * @private
 */
function _parseFrontMatterLine(line, result, state) {
  // Handle YAML block scalar continuation (| or >)
  if (state.inBlockScalar) {
    if (_handleBlockScalarLine(line, result, state)) {
      return;
    }
  }

  const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
  if (kvMatch) {
    const flushState = _flushCurrentState(result, state.currentKey, state.inArray, state.arrayValues, state.pendingObject, state.inNestedObject, state.nestedObject);
    state.inArray = flushState.inArray; state.arrayValues = flushState.arrayValues; state.pendingObject = flushState.pendingObject; state.inNestedObject = flushState.inNestedObject; state.nestedObject = flushState.nestedObject;
    state.currentKey = kvMatch[1];
    const value = kvMatch[2].trim();
    // Detect YAML block scalar indicators: | (literal) or > (folded)
    if (value === '|' || value === '>' || value === '|+' || value === '|-' || value === '>+' || value === '>-') {
      state.inBlockScalar = true;
      state.blockScalarKey = state.currentKey;
      state.blockScalarLines = [];
      state.blockScalarType = value.charAt(0);
      return;
    }
    const kvState = _handleKeyValue(result, state.currentKey, value);
    if (kvState.inArray) {
      state.inArray = true;
      state.arrayValues = [];
    }
    state.inNestedObject = kvState.inNestedObject;
    state.nestedObject = kvState.nestedObject;
  } else if (state.inArray && line.trim().startsWith('- ')) {
    const aState = _processArrayLine(line, state.pendingObject, state.inNestedObject, state.nestedObject, state.arrayValues);
    state.pendingObject = aState.pendingObject;
    state.arrayValues = aState.arrayValues;
  } else if (state.inArray && line.match(/^\s+(\w[\w-]*):\s*(.*)/)) {
    const subMatch = line.match(/^\s+(\w[\w-]*):\s*(.*)/);
    const hState = _handleIndentedLine(subMatch, state.pendingObject, state.inNestedObject, state.nestedObject);
    state.pendingObject = hState.pendingObject; state.inNestedObject = hState.inNestedObject; state.nestedObject = hState.nestedObject;
  }
}

/**
 * 处理block scalar行。返回true表示已消费该行，false表示需要继续处理。
 * @param {string} line - 单行文本
 * @param {Object} result - 累积结果对象
 * @param {Object} state - 解析状态
 * @returns {boolean} 是否已消费该行
 * @private
 */
function _handleBlockScalarLine(line, result, state) {
  if (line.trim() === '' && state.blockScalarLines.length === 0) {
    return true;
  }
  if ((line.match(/^\s/) || line.trim() === '') && line.trim() !== '') {
    state.blockScalarLines.push(line.replace(/^\s{2}/, ''));
    return true;
  }
  // End of block scalar: line is not indented (or empty after content)
  const joined = state.blockScalarType === '>'
    ? state.blockScalarLines.join(' ').replace(/\s+/g, ' ').trim()
    : state.blockScalarLines.join('\n').trim();
  result[state.blockScalarKey] = joined;
  state.inBlockScalar = false;
  state.blockScalarKey = null;
  state.blockScalarLines = [];
  state.blockScalarType = null;
  return false;
}

/**
 * 将值规范化为数组。支持字符串、行内数组格式和已有数组。
 *
 * @param {string|string[]|undefined} value - 待转换的值
 * @returns {string[]} 规范化后的数组
 *
 * @example
 * parseArray('single')       // => ['single']
 * parseArray('[a, b, c]')    // => ['a', 'b', 'c']
 * parseArray(['x', 'y'])     // => ['x', 'y']
 * parseArray(undefined)      // => []
 */
function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    if (value.startsWith('[') && value.endsWith(']')) {
      return value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
    }
    return value ? [value] : [];
  }
  return [];
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateAgentId(agentId, className, ErrorClass) {
  if (!agentId || typeof agentId !== 'string') {
    const name = className || 'Module';
    const msg = name + ': agentId must be a non-empty string';
    if (ErrorClass) throw new ErrorClass('INVALID_INPUT', msg);
    return { valid: false, reason: msg };
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    const msg = 'agentId contains invalid characters: only alphanumeric, underscore and hyphen are allowed';
    if (ErrorClass) throw new ErrorClass('INVALID_INPUT', msg);
    return { valid: false, reason: msg };
  }
  return { valid: true };
}

const BUILTIN_MODULES = [
  'fs', 'path', 'crypto', 'events', 'http', 'https', 'net', 'url',
  'util', 'os', 'stream', 'buffer', 'process', 'child_process',
  'assert', 'node:test', 'node:assert', 'node:assert/strict',
  'node:fs', 'node:path', 'node:crypto', 'node:events', 'node:http',
  'node:util', 'node:os', 'node:stream', 'node:buffer', 'node:child_process',
  'zlib', 'querystring', 'string_decoder', 'timers', 'dns', 'tls',
];

const BUILTIN_MODULES_SET = new Set(BUILTIN_MODULES);

const DEFAULT_TOKEN_BUDGET = 1000000000;
const TOKEN_BUDGET_WARNING_RATIO = 0.8;
const TOKEN_BUDGET_DANGER_RATIO = 0.95;

function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  let cjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x3000 && code <= 0x303F) || (code >= 0xFF00 && code <= 0xFFEF) ||
        (code >= 0xAC00 && code <= 0xD7AF)) {
      cjkCount++;
    }
  }
  const nonCjkLen = text.length - cjkCount;
  return Math.ceil(nonCjkLen / 4 + cjkCount / 1.5);
}
const DEFAULT_CONFIDENCE = 0.5;
const DEFAULT_COVERAGE_THRESHOLD = 80;
const DEFAULT_ENFORCEMENT = 'recommended';
const DEFAULT_AGENT_NAME = 'unknown';
const FRONTMATTER_TRUE = 'true';
const SESSION_STATUS_ACTIVE = 'active';

const PHASE_TRANSITIONS_SET = {};
for (const _key of Object.keys(PHASE_TRANSITIONS)) {
  PHASE_TRANSITIONS_SET[_key] = new Set(PHASE_TRANSITIONS[_key]);
}

const PHASE_INDEX = {};
PHASES.forEach(function(phase, idx) { PHASE_INDEX[phase] = idx; });

function validateProjectRoot(projectRoot, className, ErrorClass) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    const name = className || 'Module';
    const msg = name + ': projectRoot must be a non-empty string';
    if (ErrorClass) throw new ErrorClass('INVALID_INPUT', msg);
    throw new TypeError(msg);
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validateString(value, fieldName) {
  if (value == null) return { valid: false, reason: (fieldName || 'value') + ' is required' };
  if (typeof value !== 'string') return { valid: false, reason: (fieldName || 'value') + ' must be a string' };
  return { valid: true };
}

function validateNonEmptyString(value, fieldName) {
  const strCheck = validateString(value, fieldName);
  if (!strCheck.valid) return strCheck;
  if (value.trim().length === 0) return { valid: false, reason: (fieldName || 'value') + ' must not be empty' };
  return { valid: true };
}

function validateNumber(value, fieldName, opts) {
  const o = opts ?? {};
  if (value == null) {
    if (o.required) return { valid: false, reason: (fieldName || 'value') + ' is required' };
    return { valid: true };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return { valid: false, reason: (fieldName || 'value') + ' must be a finite number' };
  if (o.min !== undefined && value < o.min) return { valid: false, reason: (fieldName || 'value') + ' must be >= ' + o.min };
  if (o.max !== undefined && value > o.max) return { valid: false, reason: (fieldName || 'value') + ' must be <= ' + o.max };
  if (o.integer && !Number.isInteger(value)) return { valid: false, reason: (fieldName || 'value') + ' must be an integer' };
  return { valid: true };
}

function validateObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: (fieldName || 'value') + ' must be a non-null object' };
  }
  return { valid: true };
}

function validateFunction(value, fieldName) {
  if (typeof value !== 'function') return { valid: false, reason: (fieldName || 'value') + ' must be a function' };
  return { valid: true };
}

function validateEnum(value, allowedValues, fieldName) {
  if (!allowedValues || !Array.isArray(allowedValues)) return { valid: false, reason: 'allowedValues must be an array' };
  if (!allowedValues.includes(value)) return { valid: false, reason: (fieldName || 'value') + ' must be one of: ' + allowedValues.join(', ') };
  return { valid: true };
}

function sanitizeString(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

const { generateId } = require('./unique-id');

const PRIORITY_LEVELS = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
  IDLE: 4,
};

const DANGEROUS_KEYS = new Set([
  '__proto__', 'constructor', 'prototype',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

const DANGEROUS_SHELL_PATTERNS = Object.freeze([
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)(\/|\~|[A-Z]:\\)/i,
  /\brmdir\s+\/[sq]\s+/i,
  /\bdel\s+\/[sq]\s+/i,
  /\bremove-item\s+.*-recurse.*-force/i,
  /\bformat\s+[a-zA-Z]:/i,
  /\bmkfs/i,
  /\bdd\s+.*of=\/dev\//i,
  />\s*\/dev\/sd/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\binit\s+[06]/i,
  /\bchmod\s+(-R\s+)?0?777/i,
  /\bchown\s+-R/i,
  /\bchgrp\s+/i,
  /\b:\(\)\{.*;\}\s*;/i,
  /\btruncate\s+-s\s+0/i,
  /\bshred\b/i,
  /\bmv\s+.*\/dev\/null/i,
  /\bcurl\b.*\|\s*(?:bash|sh|zsh|fish)\b/i,
  /\bwget\b.*\|\s*(?:bash|sh|zsh|fish)\b/i,
  /\binvoke-expression\b/i,
  /\biex\b/i,
  /\bnpm\s+install\s+-g\b/i,
  /\bpip\s+install\b/i,
  /\bnpm\s+run\b/i,
  /\bnpx\s+.*--yes\b/i,
  /\bnpx\s+.*-y\b/i,
  /\bdocker\s+run\s+.*--privileged/i,
  /\bkubectl\s+apply\b/i,
  /\bpowershell\s+.*-enc\b/i,
  /\bpowershell\s+.*-command\b/i,
  /\bbash\s+-c\b/i,
  /\bsh\s+-c\b/i,
  /\bzsh\s+-c\b/i,
  /\bpython\d?\s+-c\b/i,
  /\bperl\s+-e\b/i,
  /\bruby\s+-e\b/i,
  /\bnode\s+-e\b/i,
  /\bnode\s+--eval\b/i,
  /\bnode\s+--require\b/i,
  /\bnode\s+-r\b/i,
  /\bcmd\s+\/c\b/i,
  /\btaskkill\b/i,
  /\bnet\s+(user|localgroup|share)\b/i,
  /\breg\s+(add|delete|import)\b/i,
  /\bschtasks\s+\/create\b/i,
  /\bwmic\b.*call\b/i,
  /\bsudo\s+/i,
  /\bsu\s+/i,
  /\biptables\b/i,
  /\bsystemctl\s+(?:stop|disable|restart)\b/i,
  /\bkill\s+-9\s+1\b/i,
  /\bnc\s+-.*[lp]/i,
  /\/dev\/tcp\//i,
  /\bcacls\s+/i,
  /\bexec\s+\(/i,
]);

const MAX_JSON_FILE_SIZE = 10 * 1024 * 1024;
const MAX_AUDIT_LOG_FILE_SIZE = 50 * 1024 * 1024;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * MS_PER_MINUTE;
const MAX_LOCKS = 10000;
const HEALTH_MAX_LOCKS = 100;
const HEALTH_MAX_CONFIRMATIONS = 5000;
const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_FALLBACK_INTERVAL_MS = 30 * MS_PER_SECOND;
const DEFAULT_SESSION_TTL_MS = MS_PER_HOUR;
const DEFAULT_HOOK_TIMEOUT_MS = 30 * MS_PER_SECOND;
const DEFAULT_WATCH_INTERVAL_MS = 30 * MS_PER_SECOND;
const DEFAULT_FLUSH_INTERVAL_MS = 30 * MS_PER_SECOND;
const STALE_TMP_FILE_AGE_MS = MS_PER_HOUR;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * MS_PER_SECOND;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * MS_PER_SECOND;
const DEFAULT_CACHE_TTL_MS = 30 * MS_PER_SECOND;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30 * MS_PER_SECOND;
const DEFAULT_POLL_INTERVAL_MS = 10 * MS_PER_SECOND;
const DEFAULT_GRACEFUL_SHUTDOWN_MS = 10 * MS_PER_SECOND;
const DEFAULT_MIN_HEARTBEAT_MS = 5 * MS_PER_SECOND;
const DEFAULT_RETRY_MAX_DELAY_MS = 5 * MS_PER_SECOND;
const DEFAULT_FORCE_EXIT_MS = 5 * MS_PER_SECOND;
const DEFAULT_TTL_CACHE_MS = MS_PER_MINUTE;
const DEFAULT_ACQUIRE_TIMEOUT_MS = MS_PER_MINUTE;
const DEFAULT_MAX_BACKOFF_MS = MS_PER_MINUTE;
const DEFAULT_METRICS_FLUSH_MS = MS_PER_MINUTE;
const DEFAULT_SESSION_TTL_MIN_MS = MS_PER_MINUTE;
const DEFAULT_PIPELINE_TIMEOUT_MS = 5 * MS_PER_MINUTE;
const DEFAULT_SUBTASK_TIMEOUT_MS = 5 * MS_PER_MINUTE;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * MS_PER_MINUTE;
const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_MAX_QUEUE_SIZE = 10000;
const DEFAULT_CACHE_MAX = 50;
const DEFAULT_CACHE_TTL = 30 * MS_PER_MINUTE;
const SQLITE_BUSY_TIMEOUT_MS = 5 * MS_PER_SECOND;

const HARNESS_DIR = '.harness';
const CONFIG_FILENAME = 'config.json';
const UTF8_ENCODING = 'utf-8';
const JSON_EXT = '.json';
const MARKDOWN_EXT = '.md';

function getHarnessConfigPath(root) {
  return path.join(root, HARNESS_DIR, CONFIG_FILENAME);
}

function extractMarkdownBody(content, fallback) {
  const bodyStart = content.indexOf('---', content.indexOf('---') + 3);
  return bodyStart >= 0 ? content.slice(bodyStart + 3).trim() : (fallback !== undefined ? fallback : content);
}

/** Skill摘要的最大长度。 */
const DEFAULT_SUMMARY_MAX_LENGTH = 80;
/** Skill层级：核心层。 */
const SKILL_LAYER_CORE = 'core';
/** Skill层级：领域层。 */
const SKILL_LAYER_DOMAIN = 'domain';
/** Skill层级：基础设施层。 */
const SKILL_LAYER_INFRASTRUCTURE = 'infrastructure';
/** Skill检索默认返回的Top-K数量。 */
const DEFAULT_TOP_K = 3;
/** Skill过载阈值，超过此比例触发卸载策略。 */
const DEFAULT_OVERLOAD_THRESHOLD = 0.7;
/** 压缩后摘要的最大长度。 */
const DEFAULT_COMPRESSED_SUMMARY_MAX_LENGTH = 40;
/** Skill自动卸载延迟时间（毫秒）。 */
const DEFAULT_AUTO_UNLOAD_DELAY_MS = 5 * MS_PER_SECOND;
/**
 * Skill Reducer核心Skill ID集合。
 * 用于快速 has() 查找判断是否为核心Skill，无需序列化，因此使用 Set 而非数组。
 * @type {Set<string>}
 */
const SKILL_REDUCER_CORE_SKILL_IDS = new Set([
  'tdd-implement', 'module-development', 'code-review', 'verification-before-completion',
  'integration-testing', 'systematic-debugging', 'bug-fix', 'security-audit',
  'performance-optimization', 'refactor-code', 'architecture-design',
  'requirement-analysis', 'brainstorming', 'deployment', 'documentation',
  'office-hours', 'review-paranoid', 'ship-release', 'cso-security',
]);

const MAX_CATEGORY_LENGTH = 100;
const MAX_SOURCE_LENGTH = 100;
const MAX_DEBUG_PREVIEW_LENGTH = 100;
const MAX_CONTENT_PREVIEW_LENGTH = 60;
const MAX_MERGE_SUMMARY_LENGTH = 200;
const MAX_MERGE_CONTENT_LENGTH = 80;
const MAX_MERGE_SINGLE_LENGTH = 160;
const MAX_COMMENT_LENGTH = 1000;
const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_SUMMARY_LENGTH = 500;
const MAX_DASHBOARD_LIST_ITEMS = 8;
const MAX_DETAIL_LIST_ITEMS = 10;
const MAX_API_LIST_ITEMS = 50;
const MAX_IMPROVEMENT_ITEMS = 5;
const MAX_RETRIEVED_THOUGHTS = 10;

function generateSkillSummary(fm, content, maxLength) {
  const limit = maxLength ?? DEFAULT_SUMMARY_MAX_LENGTH;
  const parts = [];
  if (fm.name) parts.push(fm.name);
  if (fm.trigger) parts.push(fm.trigger);
  if (parts.length === 0) {
    const body = extractMarkdownBody(content);
    const firstLine = body.split('\n').find(function(l) { return l.trim().length > 0; }) || '';
    parts.push(firstLine.slice(0, limit));
  }
  const summary = parts.join(' — ');
  return summary.length > limit ? summary.slice(0, limit - 3) + '...' : summary;
}

module.exports = {
  PHASES,
  PHASE_TRANSITIONS,
  PHASE_TRANSITIONS_SET,
  PHASE_INDEX,
  PHASE_SKILLS,
  SESSION_ID_PATTERN,
  AGENT_ID_PATTERN,
  validateAgentId,
  validateProjectRoot,
  isNonEmptyString,
  validateString,
  validateNonEmptyString,
  validateNumber,
  validateObject,
  validateFunction,
  validateEnum,
  sanitizeString,
  generateId,
  BUILTIN_MODULES,
  BUILTIN_MODULES_SET,
  DEFAULT_TOKEN_BUDGET,
  TOKEN_BUDGET_WARNING_RATIO,
  TOKEN_BUDGET_DANGER_RATIO,
  estimateTokens,
  DEFAULT_CONFIDENCE,
  DEFAULT_COVERAGE_THRESHOLD,
  DEFAULT_ENFORCEMENT,
  DEFAULT_AGENT_NAME,
  FRONTMATTER_TRUE,
  SESSION_STATUS_ACTIVE,
  parseFrontmatter,
  parseArray,
  PRIORITY_LEVELS,
  DANGEROUS_KEYS,
  DANGEROUS_SHELL_PATTERNS,
  MAX_JSON_FILE_SIZE,
  MAX_AUDIT_LOG_FILE_SIZE,
  DEFAULT_LOCK_TIMEOUT_MS,
  MAX_LOCKS,
  HEALTH_MAX_LOCKS,
  HEALTH_MAX_CONFIRMATIONS,
  MS_PER_SECOND,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_PERSIST_DEBOUNCE_MS,
  DEFAULT_FALLBACK_INTERVAL_MS,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_WATCH_INTERVAL_MS,
  DEFAULT_FLUSH_INTERVAL_MS,
  STALE_TMP_FILE_AGE_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_GRACEFUL_SHUTDOWN_MS,
  DEFAULT_MIN_HEARTBEAT_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DEFAULT_FORCE_EXIT_MS,
  DEFAULT_TTL_CACHE_MS,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_METRICS_FLUSH_MS,
  DEFAULT_SESSION_TTL_MIN_MS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
  DEFAULT_SUBTASK_TIMEOUT_MS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_QUEUE_SIZE,
  DEFAULT_CACHE_MAX,
  DEFAULT_CACHE_TTL,
  DEFAULT_SUMMARY_MAX_LENGTH,
  SKILL_LAYER_CORE,
  SKILL_LAYER_DOMAIN,
  SKILL_LAYER_INFRASTRUCTURE,
  DEFAULT_TOP_K,
  DEFAULT_OVERLOAD_THRESHOLD,
  DEFAULT_COMPRESSED_SUMMARY_MAX_LENGTH,
  DEFAULT_AUTO_UNLOAD_DELAY_MS,
  SKILL_REDUCER_CORE_SKILL_IDS,
  MAX_CATEGORY_LENGTH,
  MAX_SOURCE_LENGTH,
  MAX_DEBUG_PREVIEW_LENGTH,
  MAX_CONTENT_PREVIEW_LENGTH,
  MAX_MERGE_SUMMARY_LENGTH,
  MAX_MERGE_CONTENT_LENGTH,
  MAX_MERGE_SINGLE_LENGTH,
  MAX_COMMENT_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_DASHBOARD_LIST_ITEMS,
  MAX_DETAIL_LIST_ITEMS,
  MAX_API_LIST_ITEMS,
  MAX_IMPROVEMENT_ITEMS,
  MAX_RETRIEVED_THOUGHTS,
  SQLITE_BUSY_TIMEOUT_MS,
  HARNESS_DIR,
  CONFIG_FILENAME,
  UTF8_ENCODING,
  JSON_EXT,
  MARKDOWN_EXT,
  getHarnessConfigPath,
  extractMarkdownBody,
  generateSkillSummary,
  DESIGN_PATTERNS: {
    PURE_BLACK: /(?:color|background|border-color|outline-color)\s*:\s*(?:#000000|#000|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)|black)\b/i,
    AI_GRADIENT: /background\s*:\s*(?:linear-gradient|conic-gradient)\s*\([^)]*(?:#667eea|#764ba2|#6366f1|#8b5cf6|#a855f7)[^)]*(?:#3b82f6|#06b6d4|#0ea5e9|#764ba2)?[^)]*\)/i,
    NEON_GLOW: /box-shadow\s*:[^;]*?(?:0\s+0\s+(?:\d+px)\s+(?:#|rgb|hsl)[^;]*(?:neon|electric|cyber|lime|hot\s*pink|fuchsia))/i,
    NEON_COLOR: /(?:color|background)\s*:\s*(?:#ff00ff|#00ff00|#ff0066|#00ffff|#ff6600)/i,
    HARDCODED_SHADOW: /box-shadow\s*:\s*(?!var\()0\s+\d+px\s+\d+px\s+rgba\(/,
    DEFAULT_LARGE_SHADOW: /box-shadow\s*:\s*0\s+0\s+(?:10|15|20|25)px\s+rgba\(/i,
    OVERSATURATED: /(?:hsl\([^)]*,\s*(?:9[5-9]|100)%|#[fF]{2}[0-9a-fA-F]{2}[0-9a-fA-F]{2})/i,
    SYSTEM_FONT: /font-family\s*:\s*['"]?(?:Arial|Times New Roman|Comic Sans MS)['"]?/i,
    HARDCODED_SPACING: /(?:margin|padding|gap)\s*:\s*(?!var\()(?:\d+px)(?!\s*(?:var\())/g,
    MISSING_ALT_TEXT: /<img(?![^>]*alt=)/i,
    ANIMATION_WITHOUT_REDUCED_MOTION: /(?:animation|transition)\s*:/im,
    REDUCED_MOTION_QUERY: /@media\s*\(\s*prefers-reduced-motion/,
  },
};
