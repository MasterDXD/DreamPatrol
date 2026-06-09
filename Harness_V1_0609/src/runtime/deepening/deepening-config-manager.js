'use strict';
const DeepeningBase = require('./deepening-base');
const RingBuffer = require('../../utils/ring-buffer');
const { debug } = require('../../utils/debug-logger');
const { safeJsonParse } = require('../../utils/safe-parse');
const deepClone = require('../../utils/deep-clone');
const { HarnessError, DeepeningError } = require('../../errors');
const { emitError } = require('../../utils/safe-execute');

/**
 * @module runtime/deepening/deepening-config-manager
 * 深化推理配置管理器。提供类型化配置定义、不可变性控制、自定义验证器、
 * 变更监听器、变更历史记录、批量更新、基于模式的验证及JSON导入导出。
 */

/**
 * @classdesc 深化推理配置管理器 — 深化管道的配置管理与验证监听。
 * 提供类型化配置定义与不可变性控制、自定义验证器、
 * 带取消回调的变更监听器、通过 RingBuffer 记录的变更历史、
 * 批量更新、基于模式的验证（type/min/max）以及带安全解析的 JSON 导入导出。
 *
 * @extends DeepeningBase
 * @emits 'defined' 当配置项定义时触发，附带 { key, value }
 * @emits 'changed' 当配置值变更时触发，附带 { key, oldValue, newValue }
 * @emits 'removed' 当配置项移除时触发，附带 { key }
 * @emits 'watcher-error' 当监听器回调抛出异常时触发
 */
class DeepeningConfigManager extends DeepeningBase {

  /**
   * 创建 DeepeningConfigManager 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxHistory=100] - 变更历史最大记录数
   */
  constructor(options) {
    super(options);
    this._config = new Map();
    this._definitions = new Map();
    this._watchers = new Map();
    this._maxWatchers = 200;
    this._maxDefinitions = 500;
    this._totalWatchers = 0;
    this._maxHistory = (options && options.maxHistory) ?? 100;
    this._history = new RingBuffer(this._maxHistory);
    this._totalChanges = 0;
    this._totalValidations = 0;
    this._totalValidationFailures = 0;
  }

  /**
   * 定义配置项。若键已存在则返回 false。自动推断值的类型。
   * @param {string} key - 配置键名
   * @param {*} value - 配置默认值
   * @param {Object} [options] - 配置项选项
   * @param {boolean} [options.mutable=true] - 是否允许修改
   * @param {Function} [options.validator] - 自定义验证函数，返回 true 或错误信息字符串
   * @param {string} [options.description] - 配置项描述
   * @param {string} [options.env] - 对应的环境变量名
   * @returns {boolean} 定义是否成功
   * @throws {DeepeningError} key 为空时抛出
   * @emits 'defined'
   */
  define(key, value, options) {
    this.guardShutdown();
    if (!key) throw new DeepeningError('MISSING_PARAMETER', 'Config key is required');
    if (this._definitions.has(key)) return false;
    if (this._definitions.size >= this._maxDefinitions) {
      const oldestKey = this._definitions.keys().next().value;
      this._config.delete(oldestKey);
      this._definitions.delete(oldestKey);
      this._watchers.delete(oldestKey);
    }
    const opts = options ?? {};
    const type = this._inferType(value);
    this._definitions.set(key, { key, value, defaultValue: value, mutable: opts.mutable !== false, validator: opts.validator, description: opts.description, env: opts.env, type });
    this._config.set(key, value);
    this.emit('defined', { key, value });
    return true;
  }

  /**
   * 推断值的类型字符串。
   * @param {*} value - 待推断的值
   * @returns {string} 类型名称（'undefined'|'array'|基础类型）
   * @private
   */
  _inferType(value) {
    if (value == null) return 'undefined';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  /**
   * 获取配置值。若键不存在则返回默认值。
   * @param {string} key - 配置键名
   * @param {*} [defaultValue] - 键不存在时的默认返回值
   * @returns {*} 配置值或默认值
   */
  get(key, defaultValue) {
    if (this._config.has(key)) return this._config.get(key);
    return defaultValue;
  }

  /**
   * 设置配置值。不可变配置项会抛出异常，验证失败也会抛出异常。
   * @param {string} key - 配置键名
   * @param {*} value - 新配置值
   * @returns {boolean} 设置是否成功
   * @throws {HarnessError} 配置项不可变时抛出
   * @throws {DeepeningError} 验证失败时抛出
   * @emits 'changed'
   */
  set(key, value) {
    this.guardShutdown();
    const def = this._definitions.get(key);
    if (def && !def.mutable) throw new HarnessError('CONFIG_INVALID', 'Config key ' + key + ' is immutable');
    if (def && def.validator) {
      this._totalValidations++;
      const result = def.validator(value);
      if (result !== true) {
        this._totalValidationFailures++;
        const msg = typeof result === 'string' ? result : 'Validation failed for key ' + key;
        throw new DeepeningError('INVALID_VALUE', msg);
      }
    }
    const old = this._config.get(key);
    this._config.set(key, value);
    this._history.push({ key, oldValue: old, newValue: value, timestamp: Date.now() });
    this._totalChanges++;
    this.emit('changed', { key, oldValue: old, newValue: value });
    const watchers = this._watchers.get(key);
    if (watchers) {
      for (const fn of watchers) {
        try { fn(value, old); } catch (wErr) { debug('DeepeningConfigManager', 'watcher:' + key, wErr); emitError(this, 'watcher-error', wErr, { key }); }
      }
    }
    return true;
  }

  /**
   * 删除配置项及其定义。
   * @param {string} key - 配置键名
   * @returns {boolean} 删除结果
   * @emits 'removed'
   */
  delete(key) {
    this.guardShutdown();
    this._config.delete(key);
    this._definitions.delete(key);
    this.emit('removed', { key });
    return true;
  }

  /**
   * 重置指定配置项为定义时的默认值。
   * @param {string} key - 配置键名
   * @returns {boolean} 重置结果
   * @emits 'changed'
   */
  reset(key) { this.guardShutdown(); const def = this._definitions.get(key); if (def) { const cloned = deepClone(def.value); this._config.set(key, cloned); this.emit('changed', { key, newValue: cloned }); } return true; }

  /**
   * 重置所有配置项为定义时的默认值。
   * @returns {boolean} 重置结果
   */
  resetAll() { this.guardShutdown(); for (const [key, def] of this._definitions) { this._config.set(key, deepClone(def.value)); } return true; }

  /**
   * 移除配置项及其定义。与 delete 功能相同。
   * @param {string} key - 配置键名
   * @returns {boolean} 是否成功移除
   * @emits 'removed'
   */
  remove(key) {
    this.guardShutdown();
    if (!this._definitions.has(key)) return false;
    this._config.delete(key);
    this._definitions.delete(key);
    this.emit('removed', { key });
    return true;
  }

  /**
   * 检查配置键是否存在。
   * @param {string} key - 配置键名
   * @returns {boolean} 是否存在
   */
  has(key) { return this._config.has(key); }

  /**
   * 注册配置变更监听器。返回取消监听的函数。
   * @param {string} key - 配置键名
   * @param {Function} callback - 变更回调函数，签名 (newValue, oldValue) => void
   * @returns {Function} 取消监听函数 unwatch()
   */
  watch(key, callback) {
    this.guardShutdown();
    if (!this._watchers.has(key)) {
      if (this._watchers.size >= this._maxWatchers) {
        const oldest = this._watchers.keys().next().value;
        this._watchers.delete(oldest);
      }
      this._watchers.set(key, new Set());
    }
    const watcherSet = this._watchers.get(key);
    if (watcherSet) watcherSet.add(callback);
    this._totalWatchers++;
    return function unwatch() { const w = this._watchers.get(key); if (w && w.delete(callback)) this._totalWatchers--; }.bind(this);
  }

  /**
   * 获取配置项定义信息。
   * @param {string} key - 配置键名
   * @returns {Object|null} 配置定义对象，包含 key、value、defaultValue、mutable、validator、description、env、type
   */
  getConfigInfo(key) {
    const def = this._definitions.get(key);
    return def ?? null;
  }

  /**
   * 获取所有配置键名。
   * @returns {string[]} 配置键名数组
   */
  getKeys() { return Array.from(this._config.keys()); }

  /**
   * 按类型获取配置键名列表。
   * @param {string} type - 类型名称
   * @returns {string[]} 匹配类型的配置键名数组
   */
  getByType(type) {
    const result = [];
    for (const [key, def] of this._definitions) {
      if (def.type === type) result.push(key);
    }
    return result;
  }

  /**
   * 获取所有配置键值对。
   * @returns {Object} 配置键值对对象
   */
  getAll() { const obj = {}; for (const [k, v] of this._config) obj[k] = v; return { ...obj }; }

  /**
   * 获取配置变更历史。
   * @param {Object} [filter] - 过滤条件
   * @param {string} [filter.key] - 按配置键名过滤
   * @returns {Object[]} 变更历史记录数组
   */
  getHistory(filter) {
    if (!filter) return this._history.toArray().slice();
    return this._history.filter(h => {
      if (filter.key && h.key !== filter.key) return false;
      return true;
    });
  }

  /**
   * 批量更新多个配置项。
   * @param {Object} obj - 键值对对象，每个键值对将调用 set 方法
   * @returns {boolean} 更新结果
   */
  batchUpdate(obj) { this.guardShutdown(); for (const [k, v] of Object.entries(obj)) this.set(k, v); return true; }

  /**
   * 基于模式验证配置值。
   * @param {string} _key - 配置键名（预留参数）
   * @param {*} value - 待验证的值
   * @param {Object} [schema] - 验证模式
   * @param {string} [schema.type] - 期望的类型
   * @param {number} [schema.min] - 最小值
   * @param {number} [schema.max] - 最大值
   * @returns {Object} 验证结果 { valid: boolean, reason?: string }
   */
  validate(_key, value, schema) {
    if (!schema) return { valid: true };
    if (schema.type && typeof value !== schema.type) return { valid: false, reason: 'type-mismatch' };
    if (schema.min !== undefined && value < schema.min) return { valid: false, reason: 'below-min' };
    if (schema.max !== undefined && value > schema.max) return { valid: false, reason: 'above-max' };
    return { valid: true };
  }

  /**
   * 带模式验证的配置设置。验证通过后才执行 set。
   * @param {string} key - 配置键名
   * @param {*} value - 新配置值
   * @param {Object} schema - 验证模式
   * @returns {boolean} 设置是否成功
   * @throws {DeepeningError} 验证失败时抛出
   */
  setWithValidation(key, value, schema) {
    const result = this.validate(key, value, schema);
    if (!result.valid) throw new DeepeningError('INVALID_VALUE', 'Validation failed for key ' + key + ': ' + (result.reason || 'invalid'));
    return this.set(key, value);
  }

  /**
   * 将所有配置导出为 JSON 字符串。
   * @returns {string} JSON 字符串
   */
  export() { try { return JSON.stringify(this.getAll()); } catch (_e) { debug('DeepeningConfigManager', 'export', _e && _e.message ? _e.message : String(_e)); return '{}'; } }

  /**
   * 从 JSON 字符串或对象导入配置。
   * @param {string|Object} json - JSON 字符串或配置对象
   * @returns {boolean} 导入是否成功
   */
  import(json) {
    this.guardShutdown();
    let data;
    if (typeof json === 'string') {
      data = safeJsonParse(json, false, 'DeepeningConfigManager');
      if (data === false) return false;
    } else {
      data = json;
    }
    if (data && typeof data === 'object' && data !== null) {
      for (const [k, v] of Object.entries(data)) {
        try { this.set(k, v); } catch (_e) { debug('DeepeningConfigManager', 'importData:skip-invalid-key', _e && _e.message ? _e.message : String(_e)); }
      }
    }
    return true;
  }

  /**
   * 导出配置为对象。等同于 getAll。
   * @returns {Object} 配置键值对对象
   */
  exportData() { return this.getAll(); }

  /**
   * 从对象导入配置。等同于 import。
   * @param {Object} json - 配置对象
   * @returns {boolean} 导入是否成功
   */
  importData(json) { return this.import(json); }

  /**
   * 获取配置管理器运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalConfigs - 配置项总数
   * @returns {number} return.totalDefinitions - 定义总数
   * @returns {number} return.totalWatchers - 监听器总数
   * @returns {number} return.historySize - 变更历史记录数
   * @returns {number} return.totalChanges - 变更总次数
   * @returns {number} return.totalValidations - 验证总次数
   * @returns {number} return.totalValidationFailures - 验证失败总次数
   */
  getStats() {
    return { totalConfigs: this._config.size, totalDefinitions: this._definitions.size, totalWatchers: this._totalWatchers, historySize: this._history.size, totalChanges: this._totalChanges, totalValidations: this._totalValidations, totalValidationFailures: this._totalValidationFailures, ...super.getStats() };
  }

  /**
   * 关闭时的清理回调。清空所有配置、定义和监听器。
   * @protected
   */
  _onShutdown() {
    this._config.clear();
    this._definitions.clear();
    this._watchers.clear();
    super._onShutdown();
  }
}

module.exports = DeepeningConfigManager;
