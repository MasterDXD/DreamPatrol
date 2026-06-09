'use strict';

/**
 * 统一参数验证器。提供流畅API和静态抛出助手，替代代码库中散落的重复校验逻辑。
 *
 * 两种使用模式：
 * 1. 流畅API — 链式调用收集错误，最后统一处理
 * 2. 静态抛出助手 — 单参数快速验证，失败即抛出
 *
 * @module utils/param-validator
 * @example
 * // 流畅API模式
 * const { valid, errors } = ParamValidator.create()
 *   .requireNonEmptyString(name, 'name')
 *   .requireNumber(age, 'age')
 *   .returnResult();
 *
 * // 静态抛出模式
 * ParamValidator.requireString_(id, 'id'); // 无效时抛出Error
 */

const {
  validateString: _validateString,
  validateNonEmptyString,
  validateNumber,
  validateObject,
  validateFunction,
  validateEnum,
} = require('./constants');
const { HarnessError } = require('../errors');

const DEFAULT_MAX_DEPTH = 10;

function _measureDepth(value, current, limit) {
  if (current > limit) return current;
  if (value == null || typeof value !== 'object') return current;
  if (Array.isArray(value)) {
    let max = current;
    for (let i = 0; i < value.length; i++) {
      const d = _measureDepth(value[i], current + 1, limit);
      if (d > max) max = d;
      if (max > limit) return max;
    }
    return max;
  }
  let max = current;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const d = _measureDepth(value[keys[i]], current + 1, limit);
    if (d > max) max = d;
    if (max > limit) return max;
  }
  return max;
}

/**
 * @classdesc 参数校验器
 * 参数验证器类。支持链式调用收集多个验证错误。
 */
class ParamValidator {
  constructor() {
    this._errors = [];
  }

  /**
   * 工厂方法，创建新的验证器实例。
   * @returns {ParamValidator}
   */
  static create() {
    return new ParamValidator();
  }

  /** 重置已收集的错误。@returns {ParamValidator} this */
  reset() {
    this._errors = [];
    return this;
  }

  /** 已收集的错误列表（浅拷贝）。@type {string[]} */
  get errors() {
    return this._errors.slice();
  }

  /** 是否存在验证错误。@type {boolean} */
  get hasErrors() {
    return this._errors.length > 0;
  }

  /** 第一个错误消息，无错误时返回null。@type {string|null} */
  get firstError() {
    return this._errors.length > 0 ? this._errors[0] : null;
  }

  /**
   * 验证字符串值。
   * @param {*} value - 要验证的值
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requireString(value, fieldName) {
    const result = _validateString(value, fieldName);
    if (!result.valid) this._errors.push(result.reason);
    return this;
  }

  /**
   * 验证非空字符串。
   * @param {*} value - 要验证的值
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requireNonEmptyString(value, fieldName) {
    const result = validateNonEmptyString(value, fieldName);
    if (!result.valid) this._errors.push(result.reason);
    return this;
  }

  /**
   * 验证数字值，支持范围检查。
   * @param {*} value - 要验证的值
   * @param {string} [fieldName='value'] - 字段名
   * @param {Object} [opts] - 选项 {min, max}
   * @returns {ParamValidator} this
   */
  requireNumber(value, fieldName, opts) {
    const result = validateNumber(value, fieldName, opts);
    if (!result.valid) this._errors.push(result.reason);
    return this;
  }

  /**
   * 验证对象值（非null非数组）。
   * @param {*} value - 要验证的值
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requireObject(value, fieldName) {
    const result = validateObject(value, fieldName);
    if (!result.valid) this._errors.push(result.reason);
    return this;
  }

  requireMaxDepth(value, maxDepth, fieldName) {
    const name = fieldName || 'value';
    if (maxDepth == null || maxDepth < 0) {
      this._errors.push(name + ' maxDepth must be a non-negative number');
      return this;
    }
    const actual = _measureDepth(value, 0, maxDepth + 1);
    if (actual > maxDepth) {
      this._errors.push(name + ' exceeds maximum nesting depth of ' + maxDepth + ' (actual: ' + actual + ')');
    }
    return this;
  }

  /**
   * 验证函数值。
   * @param {*} value - 要验证的值
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requireFunction(value, fieldName) {
    const result = validateFunction(value, fieldName);
    if (!result.valid) this._errors.push(result.reason);
    return this;
  }

  /**
   * 验证枚举值。
   * @param {*} value - 要验证的值
   * @param {Array} allowedValues - 允许的值列表
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requireEnum(value, allowedValues, fieldName) {
    const result = validateEnum(value, allowedValues, fieldName);
    if (!result.valid) this._errors.push(result.reason);
    return this;
  }

  /**
   * 验证数组值。
   * @param {*} value - 要验证的值
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requireArray(value, fieldName) {
    if (!Array.isArray(value)) {
      this._errors.push((fieldName || 'value') + ' must be an array');
    }
    return this;
  }

  /**
   * 验证非空数组。
   * @param {*} value - 要验证的值
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requireNonEmptyArray(value, fieldName) {
    if (!Array.isArray(value) || value.length === 0) {
      this._errors.push((fieldName || 'value') + ' must be a non-empty array');
    }
    return this;
  }

  /**
   * 验证布尔值。
   * @param {*} value - 要验证的值
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requireBoolean(value, fieldName) {
    if (typeof value !== 'boolean') {
      this._errors.push((fieldName || 'value') + ' must be a boolean');
    }
    return this;
  }

  /**
   * 验证真值（非falsy）。
   * @param {*} value - 要验证的值
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requireTruthy(value, fieldName) {
    if (!value) {
      this._errors.push((fieldName || 'value') + ' is required');
    }
    return this;
  }

  /**
   * 验证字符串匹配正则模式。
   * @param {*} value - 要验证的值
   * @param {RegExp} pattern - 正则模式
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requirePattern(value, pattern, fieldName) {
    if (!(pattern instanceof RegExp)) {
      this._errors.push((fieldName || 'value') + ' has invalid pattern');
      return this;
    }
    if (typeof value !== 'string' || !pattern.test(value)) {
      this._errors.push((fieldName || 'value') + ' does not match required pattern');
    }
    return this;
  }

  /**
   * 验证字符串最大长度。
   * @param {*} value - 要验证的值
   * @param {number} maxLength - 最大长度
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requireStringLength(value, maxLength, fieldName) {
    if (typeof value !== 'string') {
      this._errors.push((fieldName || 'value') + ' must be a string');
    } else if (maxLength !== undefined && value.length > maxLength) {
      this._errors.push((fieldName || 'value') + ' exceeds maximum length of ' + maxLength);
    }
    return this;
  }

  /**
   * 验证数字范围。
   * @param {*} value - 要验证的值
   * @param {number} min - 最小值
   * @param {number} max - 最大值
   * @param {string} [fieldName='value'] - 字段名
   * @returns {ParamValidator} this
   */
  requireNumberRange(value, min, max, fieldName) {
    const result = validateNumber(value, fieldName, { min, max });
    if (!result.valid) this._errors.push(result.reason);
    return this;
  }

  /**
   * 自定义验证条件。
   * @param {boolean} condition - 验证条件，false表示失败
   * @param {string} [message='Custom validation failed'] - 失败消息
   * @returns {ParamValidator} this
   */
  custom(condition, message) {
    if (!condition) {
      this._errors.push(message || 'Custom validation failed');
    }
    return this;
  }

  /**
   * 有错误时抛出异常。
   * @param {Function} [ErrorClass=Error] - 错误类
   * @param {string} [code] - 错误代码
   * @throws {Error} 存在验证错误时抛出
   * @returns {ParamValidator} this
   */
  throwIfInvalid(ErrorClass, code) {
    if (this._errors.length > 0) {
      const Ctor = ErrorClass || Error;
      const msg = this._errors.join('; ');
      if (code && Ctor === Error) {
        throw new Ctor('[' + code + '] ' + msg);
      }
      if (code) {
        throw new Ctor(code, msg);
      }
      throw new Ctor(msg);
    }
    return this;
  }

  /**
   * 返回验证结果对象。
   * @returns {{valid: boolean, errors: string[]}}
   */
  returnResult() {
    if (this._errors.length > 0) {
      return { valid: false, errors: this._errors.slice() };
    }
    return { valid: true, errors: [] };
  }

  /**
   * 返回布尔值（无错误返回true）。
   * @returns {boolean}
   */
  toReturnFalse() {
    return this._errors.length === 0;
  }

  /**
   * 返回结果对象（success + error字段）。
   * @param {string} [errorKey='error'] - 错误消息的键名
   * @returns {{success: boolean, [errorKey]: string}}
   */
  toReturnObject(errorKey) {
    if (this._errors.length > 0) {
      const result = { success: false };
      result[errorKey || 'error'] = this._errors.join('; ');
      return result;
    }
    return { success: true };
  }
}

ParamValidator.validateString = _validateString;
ParamValidator.validateNonEmptyString = validateNonEmptyString;
ParamValidator.validateNumber = validateNumber;
ParamValidator.validateObject = validateObject;
ParamValidator.validateFunction = validateFunction;
ParamValidator.validateEnum = validateEnum;

/**
 * 静态抛出助手：验证字符串，无效时抛出Error。
 * @param {*} value - 要验证的值
 * @param {string} [fieldName='value'] - 字段名
 * @throws {Error}
 */
ParamValidator.requireString_ = function requireString_(value, fieldName) {
  if (!value || typeof value !== 'string') throw new HarnessError('INVALID_INPUT', (fieldName || 'value') + ' is required and must be a string');
};

/**
 * 静态抛出助手：验证函数，无效时抛出Error。
 * @param {*} value - 要验证的值
 * @param {string} [fieldName='value'] - 字段名
 * @throws {Error}
 */
ParamValidator.requireFunction_ = function requireFunction_(value, fieldName) {
  if (typeof value !== 'function') throw new HarnessError('INVALID_INPUT', (fieldName || 'value') + ' must be a function');
};

/**
 * 静态抛出助手：验证对象，无效时抛出Error。
 * @param {*} value - 要验证的值
 * @param {string} [fieldName='value'] - 字段名
 * @throws {Error}
 */
ParamValidator.requireObject_ = function requireObject_(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessError('INVALID_INPUT', (fieldName || 'value') + ' must be a non-null object');
};

/**
 * 静态抛出助手：验证数组，无效时抛出Error。
 * @param {*} value - 要验证的值
 * @param {string} [fieldName='value'] - 字段名
 * @throws {Error}
 */
ParamValidator.requireArray_ = function requireArray_(value, fieldName) {
  if (!Array.isArray(value)) throw new HarnessError('INVALID_INPUT', (fieldName || 'value') + ' must be an array');
};

/**
 * 静态抛出助手：验证有限数字，无效时抛出Error。
 * @param {*} value - 要验证的值
 * @param {string} [fieldName='value'] - 字段名
 * @throws {Error}
 */
ParamValidator.requireNumber_ = function requireNumber_(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HarnessError('INVALID_INPUT', (fieldName || 'value') + ' must be a finite number');
};

ParamValidator.ensurePositiveNumber = function ensurePositiveNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return typeof fallback === 'number' && fallback > 0 ? fallback : 1;
};

ParamValidator.ensurePositiveInt = function ensurePositiveInt(value, fallback) {
  let n = parseInt(value, 10);
  if (Number.isFinite(n) && n > 0) return n;
  n = parseInt(fallback, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

/**
 * 确保值是安全的定时器延迟（1 ~ 2^31-1），防止整数溢出导致定时器立即执行。
 * JavaScript的setTimeout/setInterval将延迟值转为32位有符号整数，超过2147483647会立即触发。
 * @param {*} value - 输入值
 * @param {number} [fallback=60000] - 回退值（毫秒）
 * @returns {number} 钳位到[1, 2147483647]的安全延迟值
 */
ParamValidator.ensureSafeTimeout = function ensureSafeTimeout(value, fallback) {
  const MAX_SAFE_TIMEOUT = 2147483647; // 2^31 - 1
  let ms = (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : 0;
  if (ms <= 0) {
    ms = (typeof fallback === 'number' && fallback > 0) ? fallback : 60000;
  }
  return Math.min(ms, MAX_SAFE_TIMEOUT);
};

/**
 * 静态抛出助手：验证真值，falsy时抛出Error。
 * @param {*} value - 要验证的值
 * @param {string} [fieldName='value'] - 字段名
 * @throws {Error}
 */
ParamValidator.requireTruthy_ = function requireTruthy_(value, fieldName) {
  if (!value) throw new HarnessError('INVALID_INPUT', (fieldName || 'value') + ' is required');
};

ParamValidator.requireMaxDepth_ = function requireMaxDepth_(value, maxDepth, fieldName) {
  const name = fieldName || 'value';
  const limit = typeof maxDepth === 'number' && maxDepth >= 0 ? maxDepth : DEFAULT_MAX_DEPTH;
  const actual = _measureDepth(value, 0, limit + 1);
  if (actual > limit) {
    throw new HarnessError('INVALID_INPUT', name + ' exceeds maximum nesting depth of ' + limit + ' (actual: ' + actual + ')');
  }
};

ParamValidator.DEFAULT_MAX_DEPTH = DEFAULT_MAX_DEPTH;

module.exports = ParamValidator;
