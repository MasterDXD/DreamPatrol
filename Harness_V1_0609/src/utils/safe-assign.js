'use strict';

/**
 * @module utils/safe-assign
 *
 * Prototype-pollution-safe alternative to Object.assign().
 * Skips dangerous keys (__proto__, constructor, prototype) during property copy.
 */

const { DANGEROUS_KEYS } = require('./constants');

/**
 * Copy own enumerable properties from source objects to target, skipping
 * prototype-polluting keys. Drop-in replacement for Object.assign().
 * @param {Object} target - Target object to copy properties to
 * @param {...Object} sources - Source objects to copy properties from
 * @returns {Object} The target object
 */
function safeAssign(target) {
  if (target === null || target === undefined) {
    target = {};
  }
  for (let i = 1; i < arguments.length; i++) {
    const src = arguments[i];
    if (!src || typeof src !== 'object') continue;
    const keys = Object.keys(src);
    for (let j = 0; j < keys.length; j++) {
      if (!DANGEROUS_KEYS.has(keys[j])) {
        target[keys[j]] = src[keys[j]];
      }
    }
  }
  return target;
}

/**
 * 合并默认配置与用户选项，跳过原型污染键
 * @param {Object} defaults - 默认配置对象
 * @param {Object} options - 用户选项对象
 * @returns {Object} 合并后的配置对象
 */
function mergeConfig(defaults, options) {
  if (defaults === null || defaults === undefined) {
    defaults = {};
  }
  return safeAssign({ ...defaults }, options);
}

/**
 * 验证缺失值：使用默认值或记录错误
 * @param {string} fullPath - 完整路径
 * @param {Object} rule - Schema规则
 * @param {string[]} errors - 错误收集数组
 * @returns {{ handled: boolean, defaultValue: * }}
 */
function _validateMissing(fullPath, rule, errors) {
  if (rule.default !== undefined) {
    return { handled: true, defaultValue: rule.default };
  }
  if (rule.required) {
    errors.push(fullPath + ' is required but missing');
  }
  return { handled: true, defaultValue: undefined };
}

/**
 * 验证类型：不匹配时使用默认值或记录错误
 * @param {string} fullPath - 完整路径
 * @param {*} value - 当前值
 * @param {Object} rule - Schema规则
 * @param {string[]} errors - 错误收集数组
 * @param {string[]} warnings - 警告收集数组
 * @returns {{ typeOk: boolean, corrected: *|undefined }}
 */
function _validateType(fullPath, value, rule, errors, warnings) {
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (actualType === rule.type) {
    return { typeOk: true };
  }
  if (rule.default !== undefined) {
    warnings.push(fullPath + ' expected ' + rule.type + ' but got ' + actualType + ', using default');
    return { typeOk: false, corrected: rule.default };
  }
  errors.push(fullPath + ' expected ' + rule.type + ' but got ' + actualType);
  return { typeOk: false };
}

/**
 * 验证数值范围和NaN
 * @param {string} fullPath - 完整路径
 * @param {number} value - 当前值
 * @param {Object} rule - Schema规则
 * @param {string[]} errors - 错误收集数组
 * @param {string[]} warnings - 警告收集数组
 * @returns {{ ok: boolean, clamped: number|undefined }}
 */
function _validateNumberRange(fullPath, value, rule, errors, warnings) {
  if (Number.isNaN(value)) {
    if (rule.default !== undefined) {
      warnings.push(fullPath + ' is NaN, using default');
      return { ok: false, clamped: rule.default };
    }
    errors.push(fullPath + ' is NaN');
    return { ok: false };
  }
  let clamped = value;
  if (rule.min !== undefined && value < rule.min) {
    warnings.push(fullPath + ' value ' + value + ' is below minimum ' + rule.min + ', clamped');
    clamped = rule.min;
  }
  if (rule.max !== undefined && value > rule.max) {
    warnings.push(fullPath + ' value ' + value + ' exceeds maximum ' + rule.max + ', clamped');
    clamped = rule.max;
  }
  return { ok: true, clamped: clamped };
}

/**
 * 验证枚举值
 * @param {string} fullPath - 完整路径
 * @param {*} value - 当前值
 * @param {Object} rule - Schema规则
 * @param {string[]} errors - 错误收集数组
 * @param {string[]} warnings - 警告收集数组
 * @returns {{ enumOk: boolean, corrected: *|undefined }}
 */
function _validateEnum(fullPath, value, rule, errors, warnings) {
  if (!rule.enum || rule.enum.includes(value)) {
    return { enumOk: true };
  }
  if (rule.default !== undefined) {
    warnings.push(fullPath + ' value "' + value + '" not in [' + rule.enum.join(', ') + '], using default');
    return { enumOk: false, corrected: rule.default };
  }
  errors.push(fullPath + ' value "' + value + '" not in [' + rule.enum.join(', ') + ']');
  return { enumOk: false };
}

/**
 * 验证配置值是否符合Schema定义。
 * Schema格式：{ key: { type: 'number'|'string'|'boolean'|'object'|'array', min?, max?, enum?, default? } }
 * @param {Object} config - 待验证的配置对象
 * @param {Object} schema - Schema定义对象
 * @param {string} [prefix=''] - 错误消息前缀（用于嵌套验证）
 * @returns {{ valid: boolean, config: Object, errors: string[], warnings: string[] }}
 */
function validateConfigSchema(config, schema, prefix) {
  prefix = prefix || '';
  const errors = [];
  const warnings = [];
  const result = { ...config };

  for (const key of Object.keys(schema)) {
    const rule = schema[key];
    const fullPath = prefix ? prefix + '.' + key : key;
    const value = result[key];

    if (value === undefined || value === null) {
      const missing = _validateMissing(fullPath, rule, errors);
      if (missing.defaultValue !== undefined) {
        result[key] = missing.defaultValue;
      }
      continue;
    }

    if (rule.type) {
      const typeResult = _validateType(fullPath, value, rule, errors, warnings);
      if (!typeResult.typeOk) {
        if (typeResult.corrected !== undefined) {
          result[key] = typeResult.corrected;
        }
        continue;
      }
    }

    if (rule.type === 'number' && typeof value === 'number') {
      const numResult = _validateNumberRange(fullPath, value, rule, errors, warnings);
      if (numResult.clamped !== undefined) {
        result[key] = numResult.clamped;
      }
      if (!numResult.ok) {
        continue;
      }
    }

    const enumResult = _validateEnum(fullPath, value, rule, errors, warnings);
    if (!enumResult.enumOk && enumResult.corrected !== undefined) {
      result[key] = enumResult.corrected;
    }
  }

  return { valid: errors.length === 0, config: result, errors, warnings };
}

module.exports = safeAssign;
module.exports.mergeConfig = mergeConfig;
module.exports.validateConfigSchema = validateConfigSchema;
