'use strict';

const fs = require('fs');
const path = require('path');
const { debug } = require('./debug-logger');
const { MAX_JSON_FILE_SIZE, UTF8_ENCODING , HARNESS_DIR} = require('./constants');
const { sanitize: sanitizeData } = require('./debounced-persister');
const { safeJsonParse } = require('./safe-parse');

/**
 * @module utils/json-store-restorer
 * JsonStoreRestorer — JSON存储恢复器
 * 从文件加载JSON数据并提供消毒、类型验证和大小限制保护。
 * 支持同步/异步加载、文件大小上限检查、数据消毒（移除危险键）、
 * 期望类型验证（array/object/string/number/boolean）和静态便捷方法。
 * @classdesc JSON存储恢复。损坏检测、自动修复
 */
class JsonStoreRestorer {
  /**
   * 创建JSON存储恢复器实例
   * @param {Object} options - 配置选项
   * @param {string} options.root - 项目根目录
   * @param {string} options.subPath - 相对于.harness的子路径
   * @param {number} [options.maxSize] - 文件大小上限（字节）
   * @param {Function|boolean} [options.sanitize] - 消毒函数，传入false跳过消毒
   * @param {string} [options.expectedType] - 期望的数据类型
   * @param {string} [options.logLabel] - 调试日志标签
   */
  constructor(options) {
    const opts = options ?? {};
    this._root = opts.root ?? null;
    this._subPath = opts.subPath ?? null;
    this._maxSize = opts.maxSize ?? MAX_JSON_FILE_SIZE;
    this._sanitize = opts.sanitize !== undefined ? opts.sanitize : sanitizeData;
    this._expectedType = opts.expectedType ?? null;
    this._logLabel = opts.logLabel ?? 'JsonStoreRestorer';
  }

  /**
   * 解析文件完整路径
   * @returns {string} 文件完整路径
   * @private
   */
  _resolveFilePath() {
    return path.join(this._root, HARNESS_DIR, this._subPath);
  }

  /**
   * 同步加载JSON文件，支持大小检查、损坏恢复、消毒和类型验证
   * @returns {{data: *, filePath: string}|null} 加载结果，失败返回null
   */
  loadSync() {
    const filePath = this._resolveFilePath();
    try {
      if (!fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      if (stat.size > this._maxSize) {
        debug(this._logLabel, 'loadSync', 'File too large (' + stat.size + ' bytes), skipping');
        return null;
      }
      const raw = fs.readFileSync(filePath, UTF8_ENCODING);
      let parsed = safeJsonParse(raw);
      if (parsed === null && raw) {
        const restored = this._restore(raw);
        if (restored) {
          debug(this._logLabel, 'loadSync', 'Partially restored corrupted JSON (' + Object.keys(restored).length + ' keys)');
          parsed = restored;
        }
      }
      const data = this._sanitize ? this._sanitize(parsed) : parsed;
      if (!this._validateType(data)) return null;
      return { data, filePath };
    } catch (err) {
      debug(this._logLabel, 'loadSync', err);
      return null;
    }
  }

  /**
   * 异步加载JSON文件，支持大小检查、损坏恢复、消毒和类型验证
   * @returns {Promise<{data: *, filePath: string}|null>} 加载结果，失败返回null
   */
  async loadAsync() {
    const filePath = this._resolveFilePath();
    try {
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (e) {
        debug(this._logLabel, 'loadAsync:stat', e && e.message ? e.message : String(e));
        return null;
      }
      if (stat.size > this._maxSize) {
        debug(this._logLabel, 'loadAsync', 'File too large (' + stat.size + ' bytes), skipping');
        return null;
      }
      const raw = await fs.promises.readFile(filePath, UTF8_ENCODING);
      let parsed = safeJsonParse(raw);
      if (parsed === null && raw) {
        const restored = this._restore(raw);
        if (restored) {
          debug(this._logLabel, 'loadAsync', 'Partially restored corrupted JSON (' + Object.keys(restored).length + ' keys)');
          parsed = restored;
        }
      }
      const data = this._sanitize ? this._sanitize(parsed) : parsed;
      if (!this._validateType(data)) return null;
      return { data, filePath };
    } catch (err) {
      debug(this._logLabel, 'loadAsync', err);
      return null;
    }
  }

  /**
   * 验证数据是否符合期望类型
   * @param {*} data - 待验证的数据
   * @returns {boolean} 是否符合期望类型
   * @private
   */
  _validateType(data) {
    if (!this._expectedType) return true;
    if (data == null) return false;
    if (this._expectedType === 'array') return Array.isArray(data);
    if (this._expectedType === 'object') return data !== null && typeof data === 'object' && !Array.isArray(data);
    if (this._expectedType === 'string') return typeof data === 'string';
    if (this._expectedType === 'number') return typeof data === 'number' && Number.isFinite(data);
    if (this._expectedType === 'boolean') return typeof data === 'boolean';
    return typeof data === this._expectedType;
  }

  /**
   * 尝试从损坏的JSON字符串中恢复键值对
   * @param {string} raw - 损坏的JSON字符串
   * @returns {Object|null} 恢复的对象，无法恢复时返回null
   * @private
   */
  _restore(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return null;
    const recovered = {};
    let count = 0;
    const keyRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/g;
    let match;
    while ((match = keyRegex.exec(trimmed)) !== null) {
      const key = match[1];
      const valueStart = match.index + match[0].length;
      const valueStr = trimmed.slice(valueStart).trimStart();
      try {
        const parsed = JSON.parse(valueStr.split(/[,\}]/)[0]);
        recovered[key] = parsed;
        count++;
      } catch (err) {
        debug(this._logLabel, 'parseValue', 'Skipping malformed value at line ' + (match.index ?? 0) + ': ' + (err && err.message ? err.message : String(err)));
        continue;
      }
    }
    return count > 0 ? recovered : null;
  }

  /**
   * 静态同步加载JSON文件的便捷方法
   * @param {string} root - 项目根目录
   * @param {string} subPath - 相对于.harness的子路径
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxSize] - 文件大小上限
   * @param {Function|boolean} [options.sanitize] - 消毒函数
   * @param {string} [options.expectedType] - 期望数据类型
   * @param {string} [options.logLabel] - 日志标签
   * @returns {{data: *, filePath: string}|null} 加载结果
   * @static
   */
  static loadSync(root, subPath, options) {
    const opts = options ?? {};
    const restorer = new JsonStoreRestorer({
      root,
      subPath,
      maxSize: opts.maxSize,
      sanitize: opts.sanitize,
      expectedType: opts.expectedType,
      logLabel: opts.logLabel,
    });
    return restorer.loadSync();
  }

  /**
   * 静态异步加载JSON文件的便捷方法
   * @param {string} root - 项目根目录
   * @param {string} subPath - 相对于.harness的子路径
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxSize] - 文件大小上限
   * @param {Function|boolean} [options.sanitize] - 消毒函数
   * @param {string} [options.expectedType] - 期望数据类型
   * @param {string} [options.logLabel] - 日志标签
   * @returns {Promise<{data: *, filePath: string}|null>} 加载结果
   * @static
   */
  static loadAsync(root, subPath, options) {
    const opts = options ?? {};
    const restorer = new JsonStoreRestorer({
      root,
      subPath,
      maxSize: opts.maxSize,
      sanitize: opts.sanitize,
      expectedType: opts.expectedType,
      logLabel: opts.logLabel,
    });
    return restorer.loadAsync();
  }
}

module.exports = JsonStoreRestorer;
