/**
 * @module capacity-config
 * @description 容量配置管理模块，提供系统资源限制和配额的加载、验证与缓存功能。
 * 支持从配置文件加载容量参数，自动校验类型和范围，并提供TTL缓存机制。
 */

'use strict';

const { debug } = require('./debug-logger');
const { loadJsonSync } = require('./fs-utils');
const { getHarnessConfigPath, MS_PER_MINUTE } = require('./constants');

/** @constant {number} CACHE_TTL_MS - 配置缓存有效期（5分钟） */
const CACHE_TTL_MS = 5 * MS_PER_MINUTE;

/** @constant {Object} DEFAULTS - 容量配置默认值 */
const DEFAULTS = {
  causal_memory_max: 500,
  causal_memory_ttl_days: 30,
  causal_chain_max: 200,
  pending_outputs_max: 50,
  skill_interfaces_max: 100,
  conflict_resolvers_max: 20,
  execution_history_max: 100,
  deduplication_index_max: 200,
  module_instances_max: 200,
  goals_max: 100,
  sandboxes_max: 50,
  custom_policies_max: 100,
  handlers_max: 50,
  similarity_threshold: 0.3,
  conflict_similarity_threshold: 0.7,
  decay_factor_per_day: 0.98,
};

/** @constant {Object} VALIDATION - 容量配置校验规则，定义每个键的类型和取值范围 */
const VALIDATION = {
  causal_memory_max: { type: 'number', min: 1, max: 10000 },
  causal_memory_ttl_days: { type: 'number', min: 1, max: 365 },
  causal_chain_max: { type: 'number', min: 1, max: 5000 },
  pending_outputs_max: { type: 'number', min: 1, max: 1000 },
  skill_interfaces_max: { type: 'number', min: 1, max: 1000 },
  conflict_resolvers_max: { type: 'number', min: 1, max: 500 },
  execution_history_max: { type: 'number', min: 1, max: 10000 },
  deduplication_index_max: { type: 'number', min: 1, max: 5000 },
  module_instances_max: { type: 'number', min: 1, max: 5000 },
  goals_max: { type: 'number', min: 1, max: 1000 },
  sandboxes_max: { type: 'number', min: 1, max: 500 },
  custom_policies_max: { type: 'number', min: 1, max: 1000 },
  handlers_max: { type: 'number', min: 1, max: 500 },
  similarity_threshold: { type: 'number', min: 0, max: 1 },
  conflict_similarity_threshold: { type: 'number', min: 0, max: 1 },
  decay_factor_per_day: { type: 'number', min: 0, max: 1 },
};

/**
 * 验证单个配置值的类型和范围
 * @param {string} key - 配置键名
 * @param {*} value - 待验证的值
 * @returns {*} 验证通过的值，不合法时返回默认值
 * @private
 */
function _validateConfigValue(key, value) {
  const rule = VALIDATION[key];
  if (!rule) return value;
  if (typeof value !== rule.type || !Number.isFinite(value)) {
    debug('capacity-config', 'validate', 'Invalid type for ' + key + ': expected ' + rule.type + ', got ' + typeof value);
    return DEFAULTS[key];
  }
  if (value < rule.min || value > rule.max) {
    debug('capacity-config', 'validate', 'Out of range for ' + key + ': ' + value + ' not in [' + rule.min + ', ' + rule.max + ']');
    return DEFAULTS[key];
  }
  return value;
}
/** @private */
let _cachedConfig = null;
/** @private */
let _configPath = null;
/** @private */
let _cacheTimestamp = 0;

/**
 * 加载容量配置，支持TTL缓存
 * @param {string} projectRoot - 项目根目录路径
 * @returns {Object} 冻结的容量配置对象
 */
function loadCapacityConfig(projectRoot) {
  if (_cachedConfig && _configPath === projectRoot && (Date.now() - _cacheTimestamp) < CACHE_TTL_MS) {
    return _cachedConfig;
  }
  const configPath = getHarnessConfigPath(projectRoot);
  let fileConfig = {};
  try {
    const parsed = loadJsonSync(configPath);
    fileConfig = (parsed && parsed.runtime_config && parsed.runtime_config.capacity_config) ?? {};
  } catch (e) {
    debug('capacity-config', 'load', e && e.message ? e.message : String(e));
  }
  _cachedConfig = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (fileConfig[key] !== undefined) {
      _cachedConfig[key] = _validateConfigValue(key, fileConfig[key]);
    }
  }
  _configPath = projectRoot;
  _cacheTimestamp = Date.now();
  return Object.freeze({ ..._cachedConfig });
}

/**
 * 获取指定容量配置项的值
 * @param {string} key - 配置键名
 * @param {string} [projectRoot] - 项目根目录路径，默认为当前工作目录
 * @returns {*} 配置值
 */
function getCapacity(key, projectRoot) {
  const config = loadCapacityConfig(projectRoot ?? process.cwd());
  return config[key] !== undefined ? config[key] : DEFAULTS[key];
}

/**
 * 清除配置缓存
 */
function clearCache() {
  _cachedConfig = null;
  _configPath = null;
  _cacheTimestamp = 0;
}

module.exports = { loadCapacityConfig, getCapacity, clearCache, DEFAULTS };
