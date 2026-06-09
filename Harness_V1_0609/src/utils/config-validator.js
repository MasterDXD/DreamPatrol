'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter, DEFAULT_SESSION_TTL_MIN_MS, getHarnessConfigPath, UTF8_ENCODING, HARNESS_DIR, MARKDOWN_EXT, DANGEROUS_KEYS } = require('./constants');
const { debug } = require('./debug-logger');
const { sanitize: sanitizeData } = require('./debounced-persister');
const { loadJsonSync, scanMarkdownDirSync } = require('./fs-utils');

/** @constant {string[]} REQUIRED_TOP_LEVEL - 必需的顶层配置字段 */
const REQUIRED_TOP_LEVEL = ['version'];
/** @constant {string[]} VALID_VERSIONS_ARRAY - 支持的配置版本列表 */
const VALID_VERSIONS_ARRAY = ['1.0.0', '2.0.0', '2.1.0', '2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0', '2.7.1', '2.7.2', '2.7.100', '2.7.101', '2.7.102', '2.7.103', '2.7.104', '2.7.105', '2.7.106', '2.7.107', '2.7.108', '2.7.109', '2.7.110', '2.7.111', '2.7.112', '2.7.113', '2.7.114', '2.7.115', '2.7.116', '2.7.117', '2.7.118', '2.7.119', '2.7.120', '2.7.121', '2.7.122', '2.7.123', '2.7.124', '2.7.125', '2.7.126', '2.7.127', '2.7.128', '2.7.129', '2.7.130', '2.7.131', '2.7.132', '2.7.133', '2.7.134', '2.7.135', '2.7.136', '2.7.137', '2.7.138', '2.7.139', '2.7.140', '2.7.141', '2.7.142', '2.7.143', '2.7.144', '2.7.145', '2.7.146', '2.7.147', '2.7.148', '2.7.149', '2.7.150', '2.7.151', '2.7.152', '2.7.153', '2.7.154', '2.7.155', '2.7.156', '2.7.157', '2.7.158', '2.7.159', '2.7.160', '2.7.161', '2.7.162', '2.7.163', '2.7.164', '2.7.165', '2.7.166', '2.7.167', '2.7.168', '2.7.169', '2.7.170', '2.7.180', '2.7.190', '2.8.0', '2.8.1', '2.8.2', '2.8.3', '2.8.4', '2.8.5', '2.9.0', '2.10.0', '2.10.1', '2.10.2', '2.10.3', '2.10.4', '2.10.5', '2.10.6', '2.10.7', '2.10.8', '2.11.0', '2.11.1', '2.11.2', '2.11.3', '2.11.4', '2.11.5', '2.11.6', '2.11.7', '2.11.8', '2.11.9', '2.12.0', '2.12.1', '2.12.2', '2.12.3', '2.12.4', '2.12.5', '2.13.0', '2.14.0', '2.15.0', '2.16.0', '2.17.0', '2.18.0', '2.19.0', '2.20.0', '2.21.0', '2.22.0', '2.23.0', '2.24.0', '2.25.0', '2.26.0', '2.27.0', '2.28.0', '2.29.0', '2.30.0', '2.31.0', '2.32.0', '2.33.0', '2.34.0', '2.35.0', '2.36.0', '2.37.0', '2.72.0', '2.73.0', '2.73.6'];
/** @constant {Set<string>} VALID_VERSIONS - 支持的配置版本集合 */
const VALID_VERSIONS = new Set(VALID_VERSIONS_ARRAY);
/** @constant {Set<string>} VALID_ENFORCEMENTS - 有效的执行级别集合 */
const VALID_ENFORCEMENTS = new Set(['strict', 'recommended', 'optional', 'always']);

/** @constant {RegExp[]} SENSITIVE_KEY_PATTERNS - 敏感键名匹配模式列表 */
const SENSITIVE_KEY_PATTERNS = [
  /password/i, /secret/i, /token/i, /api[_-]?key/i, /private[_-]?key/i,
  /access[_-]?key/i, /auth[_-]?token/i, /^credential$/i, /connection[_-]?string/i,
];

/** @constant {RegExp[]} SENSITIVE_VALUE_PATTERNS - 敏感值匹配模式列表 */
const SENSITIVE_VALUE_PATTERNS = [
  /^sk[_-]/i,
  /^AKIA/i,
  /^(?:sk_|ak_|pk_|key_|token_)[a-zA-Z0-9]{64,}$/,
  /^[a-zA-Z0-9]{128,}$/,
  /^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
];

/**
 * @module utils/config-validator
 * 检查键名是否匹配敏感模式
 * @param {string} key - 待检查的键名
 * @returns {boolean} 是否为敏感键
 * @private
 */
function _isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(key));
}

/**
 * 检查值是否匹配敏感模式
 * @param {*} value - 待检查的值
 * @returns {boolean} 是否为敏感值
 * @private
 */
function _isSensitiveValue(value) {
  if (typeof value !== 'string') return false;
  return SENSITIVE_VALUE_PATTERNS.some(pattern => pattern.test(value.trim()));
}

/**
 * 对敏感值进行脱敏掩码处理
 * @param {string} value - 待掩码的值
 * @returns {string} 掩码后的值
 * @private
 */
function _maskSensitiveValue(value) {
  if (typeof value !== 'string' || value.length < 8) return '***';
  return value.slice(0, 3) + '***' + value.slice(-3);
}

/**
 * 递归扫描对象中的敏感值
 * @param {Object} obj - 待扫描的对象
 * @param {string} parentPath - 父路径
 * @param {Array} findings - 发现结果数组
 * @param {number} [depth] - 当前递归深度
 * @private
 */
function _scanForSensitiveValues(obj, parentPath, findings, depth = 0) {
  if (!obj || typeof obj !== 'object') return;
  if (depth > 10) return;
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = parentPath ? parentPath + '.' + key : key;
    if (typeof value === 'string') {
      if (_isSensitiveKey(key)) {
        findings.push({ path: currentPath, type: 'sensitive_key', key, valuePreview: _maskSensitiveValue(value) });
      } else if (_isSensitiveValue(value)) {
        findings.push({ path: currentPath, type: 'sensitive_value', key, valuePreview: _maskSensitiveValue(value) });
      }
    } else if (typeof value === 'object' && value !== null) {
      _scanForSensitiveValues(value, currentPath, findings, depth + 1);
    }
  }
}

/**
 * Load enforcement metadata from all skill files in .harness/skills/.
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {Object<string, { enforcement: string, priority: number, phase: string }>} Map of skillId to enforcement info
 * @private
 */
function _loadSkillEnforcements(projectRoot) {
  const result = {};
  const skillsDir = path.join(projectRoot, HARNESS_DIR, 'skills');
  if (!fs.existsSync(skillsDir)) return result;

  try {
    const files = scanMarkdownDirSync(skillsDir);
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(skillsDir, file), UTF8_ENCODING);
        const fm = parseFrontmatter(content);
        if (!fm || fm.component_id !== undefined) continue;
        const skillId = file.replace(MARKDOWN_EXT, '');
        result[skillId] = {
          enforcement: fm.enforcement || 'recommended',
          priority: Number.isFinite(parseInt(fm.priority, 10)) ? parseInt(fm.priority, 10) : 0,
          phase: fm.phase || '',
        };
      } catch (err) { debug('ConfigValidator', 'loadSkillFile', err); }
    }
  } catch (err) { debug('ConfigValidator', 'loadSkillDir', err); }
  return result;
}

/**
 * Validate the project's config.json and skill enforcement settings.
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {{ valid: boolean, errors: string[], warnings: string[], securityFindings: Object[], skillEnforcements: Object, config: Object }} Validation result
 */
function validateConfig(projectRoot) {
  const configPath = getHarnessConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) {
    return { valid: false, errors: ['config.json not found'], warnings: [], securityFindings: [], skillEnforcements: {}, config: null };
  }

  const config = loadJsonSync(configPath, sanitizeData);
  if (!config) {
    return { valid: false, errors: ['config.json parse error'], warnings: [], securityFindings: [], skillEnforcements: {}, config: null };
  }

  const errors = [];
  const warnings = [];
  const securityFindings = [];
  const skillEnforcements = _loadSkillEnforcements(projectRoot);

  _validateTopLevel(config, errors, warnings);
  _validateSkillRegistry(config, skillEnforcements, errors, warnings);
  _validateSkillEnforcementValues(skillEnforcements, errors);
  _validateRuntimeConfig(config, warnings);
  _scanForSensitiveValues(config, '', securityFindings);

  if (securityFindings.length > 0) {
    warnings.push(`Found ${securityFindings.length} potentially sensitive value(s) in config. Consider using environment variables instead.`);
  }

  return { valid: errors.length === 0, errors, warnings, skillEnforcements, config, securityFindings };
}

/**
 * 验证顶层必需字段和版本号
 * @param {Object} config - 配置对象
 * @param {string[]} errors - 错误收集数组
 * @param {string[]} _warnings - 警告收集数组（未使用）
 * @private
 */
function _validateTopLevel(config, errors, _warnings) {
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in config)) errors.push(`Missing required field: ${key}`);
  }
  if (config.version && !VALID_VERSIONS.has(config.version)) {
    errors.push(`Unknown version: ${config.version}. Expected one of: ${VALID_VERSIONS_ARRAY.join(', ')}`);
  }
}

/**
 * 验证技能注册表中的执行级别设置
 * @param {Object} config - 配置对象
 * @param {Object} skillEnforcements - 技能文件中的执行级别映射
 * @param {string[]} errors - 错误收集数组
 * @param {string[]} warnings - 警告收集数组
 * @private
 */
function _validateSkillRegistry(config, skillEnforcements, errors, warnings) {
  if (!config.skill_registry || !config.skill_registry.skills) return;
  for (const [id, skill] of Object.entries(config.skill_registry.skills ?? {})) {
    if (skill.enforcement && !VALID_ENFORCEMENTS.has(skill.enforcement)) {
      errors.push(`Skill '${id}' has invalid enforcement: ${skill.enforcement}`);
    }
    if (skillEnforcements[id] && skill.enforcement && skill.enforcement !== skillEnforcements[id].enforcement) {
      warnings.push(`Skill '${id}' enforcement mismatch: config.json says '${skill.enforcement}', skill file says '${skillEnforcements[id].enforcement}'. Skill file takes precedence.`);
    }
  }
}

/**
 * 验证技能文件中的执行级别值是否合法
 * @param {Object} skillEnforcements - 技能执行级别映射
 * @param {string[]} errors - 错误收集数组
 * @private
 */
function _validateSkillEnforcementValues(skillEnforcements, errors) {
  for (const [id, info] of Object.entries(skillEnforcements)) {
    if (!VALID_ENFORCEMENTS.has(info.enforcement)) {
      errors.push(`Skill '${id}' has invalid enforcement in skill file: ${info.enforcement}`);
    }
  }
}

/**
 * 验证运行时配置参数的合理性
 * @param {Object} config - 配置对象
 * @param {string[]} warnings - 警告收集数组
 * @private
 */
function _validateRuntimeConfig(config, warnings) {
  if (!config.runtime_config) return;
  const rc = config.runtime_config;
  if (rc.token_budget != null && (!Number.isFinite(rc.token_budget) || rc.token_budget <= 0)) {
    warnings.push('runtime_config.token_budget should be a positive number');
  }
  if (rc.session_ttl_ms != null && !Number.isFinite(rc.session_ttl_ms)) {
    warnings.push('runtime_config.session_ttl_ms should be a number');
  }
  if (rc.session_ttl_ms != null && typeof rc.session_ttl_ms === 'number' && rc.session_ttl_ms < DEFAULT_SESSION_TTL_MIN_MS) {
    warnings.push('runtime_config.session_ttl_ms is less than 1 minute, sessions may expire too quickly');
  }
  if (rc.max_concurrent != null && rc.max_concurrent < 1) {
    warnings.push('runtime_config.max_concurrent should be at least 1');
  }
  if (rc.max_concurrent != null && rc.max_concurrent > 1000) {
    warnings.push('runtime_config.max_concurrent exceeds 1000, this may cause resource exhaustion');
  }
  if (rc.default_timeout_ms != null && !Number.isFinite(rc.default_timeout_ms)) {
    warnings.push('runtime_config.default_timeout_ms should be a number');
  }
  if (rc.default_timeout_ms != null && typeof rc.default_timeout_ms === 'number' && rc.default_timeout_ms < 1000) {
    warnings.push('runtime_config.default_timeout_ms is less than 1 second, operations may timeout too quickly');
  }
}

/**
 * 对配置对象进行脱敏处理，用于安全日志输出
 * @param {Object} config - 待脱敏的配置对象
 * @param {number} [depth] - 当前递归深度
 * @returns {Object} 脱敏后的配置对象
 */
function maskConfigForLogging(config, depth = 0) {
  if (!config || typeof config !== 'object') return config;
  if (depth > 10) return '***MAX_DEPTH***';
  const masked = Array.isArray(config) ? [] : {};
  for (const [key, value] of Object.entries(config)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (_isSensitiveKey(key)) {
      masked[key] = typeof value === 'string' ? _maskSensitiveValue(value) : '***';
    } else if (typeof value === 'object' && value !== null) {
      masked[key] = maskConfigForLogging(value, depth + 1);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

module.exports = {
  validateConfig,
  maskConfigForLogging,
  VALID_VERSIONS,
  VALID_ENFORCEMENTS,
  _isSensitiveKey,
  _maskSensitiveValue,
};
