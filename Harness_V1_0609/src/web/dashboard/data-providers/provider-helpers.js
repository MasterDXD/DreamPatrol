'use strict';

/**
 * @module dashboard/data-providers/provider-helpers
 * @description Dashboard数据提供者辅助函数模块，提供统计访问器、通用访问器、模块访问器和可用性访问器的注册工具
 */

const { _apiError } = require('../utils');

/**
 * 注册统计访问器方法到类原型，自动获取运行时模块的getStats结果
 * @param {Function} Klass - 目标类
 * @param {string} methodName - 原型方法名
 * @param {string} rtKey - 运行时模块键名
 * @param {string} [methodKey='getStats'] - 模块方法名
 */
function _registerStatsAccessor(Klass, methodName, rtKey, methodKey) {
  Klass.prototype[methodName] = function() {
    const mod = this._rt(rtKey);
    if (!mod) return { available: false, stats: {} };
    const fn = mod[methodKey || 'getStats'];
    if (!fn) return { available: false, stats: {} };
    return { available: true, stats: fn.call(mod) };
  };
}

/**
 * 注册通用访问器方法到类原型，获取运行时模块指定方法的结果
 * @param {Function} Klass - 目标类
 * @param {string} methodName - 原型方法名
 * @param {string} rtKey - 运行时模块键名
 * @param {string} accessorKey - 模块方法名
 * @param {object} [unavailableResult] - 模块不可用时的返回值
 */
function _registerAccessor(Klass, methodName, rtKey, accessorKey, unavailableResult) {
  Klass.prototype[methodName] = function() {
    const mod = this._rt(rtKey);
    if (!mod) return unavailableResult || { available: false };
    const fn = mod[accessorKey];
    if (!fn) return unavailableResult || { available: false };
    return { available: true, data: fn.call(mod) };
  };
}

/**
 * 注册模块访问器方法到类原型，直接返回模块方法调用结果（无available包装）
 * @param {Function} Klass - 目标类
 * @param {string} methodName - 原型方法名
 * @param {string} rtKey - 运行时模块键名
 * @param {string} [accessorKey='getStats'] - 模块方法名
 * @param {*} [fallbackResult] - 模块不可用时的返回值
 */
function _registerModuleAccessor(Klass, methodName, rtKey, accessorKey, fallbackResult) {
  Klass.prototype[methodName] = function() {
    const mod = this._rt(rtKey);
    if (!mod) return fallbackResult;
    const fn = mod[accessorKey || 'getStats'];
    if (typeof fn !== 'function') return fallbackResult;
    return fn.call(mod);
  };
}

/**
 * 注册可用性访问器方法到类原型，返回包含available标志和指定结果键的对象
 * @param {Function} Klass - 目标类
 * @param {string} methodName - 原型方法名
 * @param {string} rtKey - 运行时模块键名
 * @param {string} accessorKey - 模块方法名
 * @param {string} resultKey - 结果对象中的键名
 * @param {*} [fallbackValue] - 模块不可用时的回退值
 */
function _registerAvailableAccessor(Klass, methodName, rtKey, accessorKey, resultKey, fallbackValue) {
  Klass.prototype[methodName] = function() {
    const mod = this._rt(rtKey);
    if (!mod) return { available: false, [resultKey]: fallbackValue };
    const fn = mod[accessorKey];
    if (typeof fn !== 'function') return { available: false, [resultKey]: fallbackValue };
    return { available: true, [resultKey]: fn.call(mod) };
  };
}

module.exports = { _apiError, _registerStatsAccessor, _registerAccessor, _registerModuleAccessor, _registerAvailableAccessor };
