'use strict';

const fs = require('fs');
const { DANGEROUS_KEYS, DEFAULT_DEBOUNCE_MS, STALE_TMP_FILE_AGE_MS, UTF8_ENCODING , HARNESS_DIR} = require('../utils/constants');
const path = require('path');
const { debug } = require('./debug-logger');
const { withShutdown } = require('./shutdown-mixin');
const deepClone = require('./deep-clone');
const { counterId, secureId } = require('./unique-id');
const { ensureDirSync } = require('./fs-utils');
const { safeJsonParse } = require('./safe-parse');
const { safeCall, safeCallAsync } = require('./safe-execute');
const { HarnessError } = require('../errors');
const { stableStringifyPretty } = require('./stable-stringify');

/**
 * 生成临时文件后缀
 * @returns {string} 临时文件后缀字符串
 * @private
 */
function _generateTmpSuffix() {
  return '-' + process.pid + '-' + counterId('', 'tmp-suffix') + '-' + secureId('', 3);
}

/**
 * @module utils/debounced-persister
 * DebouncedPersister — 防抖原子持久化器
 * 提供防抖延迟写入和原子文件持久化能力。写入时先写临时文件再重命名，
 * 确保崩溃安全；支持跨设备回退（EXDEV/EPERM）、重试机制、过期临时文件清理、
 * 数据消毒（移除危险键）和JSON安全读取。同时提供静态方法供外部直接使用。
 * @classdesc 防抖持久化。批量写入、防抖间隔、崩溃恢复
 */
class DebouncedPersister {
  /**
   * 创建防抖持久化器实例
   * @param {Object} options - 配置选项
   * @param {string} options.root - 项目根目录
   * @param {string} options.dir - 相对于.harness的子目录
   * @param {string} options.filename - 文件名
   * @param {number} [options.debounceMs] - 防抖延迟毫秒数
   * @param {Function} options.serialize - 数据序列化函数
   * @param {Function} [options.onError] - 错误回调函数
   * @param {number} [options.maxRetries=3] - 最大重试次数
   */
  constructor(options) {
    const opts = options ?? {};
    this._root = opts.root ?? null;
    this._dir = opts.dir ?? null;
    this._fullDir = this._root ? path.join(this._root, HARNESS_DIR, this._dir) : null;
    this._filename = opts.filename ?? null;
    this._debounceMs = typeof opts.debounceMs === 'number' && Number.isFinite(opts.debounceMs) && opts.debounceMs > 0 ? opts.debounceMs : DEFAULT_DEBOUNCE_MS;
    this._serialize = typeof opts.serialize === 'function' ? opts.serialize : null;
    this._onError = typeof opts.onError === 'function' ? opts.onError : null;
    this._timer = null;
    this._dirty = false;
    this._persisting = false;
    this._needsRepersist = false;
    this._writeVersion = 0;
    this._persistFailCount = 0;
    this._maxRetries = opts.maxRetries ?? 3;
    this._retryCount = 0;
  }

  /**
   * 调度防抖持久化写入
   * @example
   * const persister = new DebouncedPersister({
   *   root: '/project', dir: 'state', filename: 'data.json',
   *   serialize: () => ({ count: 42 }),
   * });
   * persister.schedule(); // writes after debounce delay
   */
  schedule() {
    this.guardShutdown();
    this._dirty = true;
    if (!this._timer && !this._persisting) {
      const self = this;
      this._timer = setTimeout(() => {
        self._timer = null;
        if (self._dirty) {
          (async () => {
            try {
              await self.persistNowAsync();
              self._retryCount = 0;
            } catch (err) {
              // persistNowAsync already calls _onError internally, only handle retry logic here
              self._persistFailCount++;
              if (self._retryCount < self._maxRetries) {
                self._retryCount++;
                self.schedule();
              } else {
                self._retryCount = 0;
                debug('DebouncedPersister', 'schedule:retriesExhausted', err);
              }
            }
          })().catch(err => {
            debug('DebouncedPersister', 'schedule:unhandled', err);
          });
        }
      }, this._debounceMs);
      if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    }
  }

  /**
   * 原子写入数据到文件（同步），先写临时文件再重命名
   * @param {string} filePath - 目标文件路径
   * @param {*} data - 待写入的数据
   * @static
   * @private
   */
  static _atomicWrite(filePath, data) {
    const tmpPath = filePath + '.tmp' + _generateTmpSuffix();
    const fd = fs.openSync(tmpPath, 'w');
    let closed = false;
    try {
      fs.writeFileSync(fd, stableStringifyPretty(data, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      closed = true;
    } catch (writeErr) {
      if (!closed) { safeCall(() => fs.closeSync(fd), 'DebouncedPersister', 'closeOnWriteErr'); }
      safeCall(() => fs.unlinkSync(tmpPath), 'DebouncedPersister', 'cleanupOnWriteErr');
      throw writeErr;
    }
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (renameErr) {
      if (renameErr.code === 'EXDEV' || renameErr.code === 'EPERM') {
        try {
          fs.copyFileSync(tmpPath, filePath);
          fs.unlinkSync(tmpPath);
        } catch (copyErr) {
          safeCall(() => fs.unlinkSync(tmpPath), 'DebouncedPersister', 'cleanupAfterCopy');
          throw copyErr;
        }
      } else {
        safeCall(() => fs.unlinkSync(tmpPath), 'DebouncedPersister', 'cleanupAfterRename');
        throw renameErr;
      }
    }
  }

  /**
   * 清理目录中的过期临时文件
   * @param {string} dirPath - 目录路径
   * @static
   */
  static cleanupStaleTmp(dirPath) {
    try {
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        const tmpIdx = entry.indexOf('.tmp');
        if (tmpIdx !== -1) {
          const tmpPath = path.join(dirPath, entry);
          try {
            const stat = fs.statSync(tmpPath);
            if (Date.now() - stat.mtimeMs > STALE_TMP_FILE_AGE_MS) {
              fs.unlinkSync(tmpPath);
              debug('DebouncedPersister', 'cleanupStaleTmp', 'Removed stale tmp file: ' + tmpPath);
            }
          } catch (e) { debug('DebouncedPersister', 'cleanupStaleFile', e); }
        }
      }
    } catch (e) { debug('DebouncedPersister', 'cleanupStaleDir', e); }
  }

  /**
   * 立即同步持久化数据到文件
   * @throws {Error} 原子写入失败（磁盘满、权限不足等）时通过onError回调报告，不直接抛出
   */
  persistNow() {
    this.guardShutdown();
    try {
      const dir = this._fullDir;
      ensureDirSync(dir);
      const data = typeof this._serialize === 'function' ? this._serialize() : null;
      if (data == null) return;
      const filePath = path.join(dir, this._filename);
      DebouncedPersister._atomicWrite(filePath, data);
      this._dirty = false;
      this._retryCount = 0;
    } catch (err) {
      this._persistFailCount++;
      if (this._onError) {
        this._onError(err);
      } else {
        debug('DebouncedPersister', 'persistNow', err);
      }
    }
  }

  /**
   * 立即异步持久化数据到文件
   * @returns {Promise<void>}
   */
  async persistNowAsync() {
    if (this._shutDown) return;
    if (this._persisting) {
      this._needsRepersist = true;
      return;
    }
    this._persisting = true;
    try {
      const writeVersion = ++this._writeVersion;
      const dir = this._fullDir;
      await fs.promises.mkdir(dir, { recursive: true });
      const data = this._serialize();
      const filePath = path.join(dir, this._filename);
      await DebouncedPersister.writeAtomicAsync(filePath, data);
      if (this._writeVersion === writeVersion) {
        this._dirty = false;
        this._retryCount = 0;
      }
    } catch (err) {
      this._persistFailCount++;
      if (this._onError) {
        this._onError(err);
      } else {
        debug('DebouncedPersister', 'persistNowAsync', err);
      }
      throw err;
    } finally {
      this._persisting = false;
      if (this._needsRepersist) {
        this._needsRepersist = false;
        this.schedule();
      } else if (this._dirty && !this._timer && this._retryCount < this._maxRetries) {
        this.schedule();
      }
    }
  }

  /**
   * 静态原子写入JSON数据到指定文件路径（同步）
   * @param {string} filePath - 目标文件路径
   * @param {*} data - 待写入的数据
   * @static
   */
  static writeAtomic(filePath, data) {
    try {
      const resolvedPath = path.resolve(filePath);
      const dir = path.dirname(resolvedPath);
      ensureDirSync(dir);
      DebouncedPersister._atomicWrite(resolvedPath, data);
    } catch (err) {
      debug('DebouncedPersister', 'writeAtomic', err);
      throw err;
    }
  }

  /**
   * 静态原子写入文本内容到指定文件路径（同步）
   * @param {string} filePath - 目标文件路径
   * @param {string} content - 文本内容
   * @param {string} [encoding] - 文本编码
   * @static
   */
  static writeAtomicText(filePath, content, encoding) {
    try {
      const resolvedPath = path.resolve(filePath);
      const dir = path.dirname(resolvedPath);
      ensureDirSync(dir);
      DebouncedPersister._atomicWriteRaw(resolvedPath, content, encoding);
    } catch (err) {
      debug('DebouncedPersister', 'writeAtomicText', err);
      throw err;
    }
  }

  /**
   * 静态原子写入JSON数据到指定文件路径（异步）
   * @param {string} filePath - 目标文件路径
   * @param {*} data - 待写入的数据
   * @returns {Promise<void>}
   * @static
   */
  static async writeAtomicAsync(filePath, data) {
    try {
      const resolvedPath = path.resolve(filePath);
      const dir = path.dirname(resolvedPath);
      await fs.promises.mkdir(dir, { recursive: true });
      await DebouncedPersister._atomicWriteAsync(resolvedPath, data);
    } catch (err) {
      debug('DebouncedPersister', 'writeAtomicAsync', err);
      throw err;
    }
  }

  /**
   * 静态原子写入文本内容到指定文件路径（异步）
   * @param {string} filePath - 目标文件路径
   * @param {string} content - 文本内容
   * @param {string} [encoding] - 文本编码
   * @returns {Promise<void>}
   * @static
   */
  static async writeAtomicTextAsync(filePath, content, encoding) {
    try {
      const resolvedPath = path.resolve(filePath);
      const dir = path.dirname(resolvedPath);
      await fs.promises.mkdir(dir, { recursive: true });
      await DebouncedPersister._atomicWriteRawAsync(resolvedPath, content, encoding);
    } catch (err) {
      debug('DebouncedPersister', 'writeAtomicTextAsync', err);
      throw err;
    }
  }

  /**
   * 原子写入原始文本内容（同步），先写临时文件再重命名
   * @param {string} filePath - 目标文件路径
   * @param {string} content - 文本内容
   * @param {string} [encoding] - 文本编码
   * @static
   * @private
   */
  static _atomicWriteRaw(filePath, content, encoding) {
    const tmpPath = filePath + '.tmp' + _generateTmpSuffix();
    const fd = fs.openSync(tmpPath, 'w');
    let closed = false;
    try {
      fs.writeFileSync(fd, content, encoding ?? UTF8_ENCODING);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      closed = true;
    } catch (writeErr) {
      if (!closed) { safeCall(() => fs.closeSync(fd), 'DebouncedPersister', 'rawCloseOnWriteErr'); }
      safeCall(() => fs.unlinkSync(tmpPath), 'DebouncedPersister', 'rawCleanupOnWriteErr');
      throw writeErr;
    }
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (renameErr) {
      if (renameErr.code === 'EXDEV' || renameErr.code === 'EPERM') {
        try {
          fs.copyFileSync(tmpPath, filePath);
          fs.unlinkSync(tmpPath);
        } catch (copyErr) {
          safeCall(() => fs.unlinkSync(tmpPath), 'DebouncedPersister', 'rawCleanupAfterCopy');
          throw copyErr;
        }
      } else {
        safeCall(() => fs.unlinkSync(tmpPath), 'DebouncedPersister', 'rawCleanupAfterRename');
        throw renameErr;
      }
    }
  }

  /**
   * 原子写入原始文本内容（异步），先写临时文件再重命名
   * @param {string} filePath - 目标文件路径
   * @param {string} content - 文本内容
   * @param {string} [encoding] - 文本编码
   * @returns {Promise<void>}
   * @static
   * @private
   */
  static async _atomicWriteRawAsync(filePath, content, encoding) {
    const tmpPath = filePath + '.tmp' + _generateTmpSuffix();
    let fd = null;
    try {
      fd = await fs.promises.open(tmpPath, 'w');
      await fd.writeFile(content, encoding ?? UTF8_ENCODING);
      await fd.sync();
      await fd.close();
      fd = null;
    } catch (writeErr) {
      if (fd) { await safeCallAsync(() => fd.close(), 'DebouncedPersister', 'rawAsyncCloseOnWriteErr'); }
      await safeCallAsync(() => fs.promises.unlink(tmpPath), 'DebouncedPersister', 'rawAsyncCleanupOnWriteErr');
      throw writeErr;
    }
    try {
      await fs.promises.rename(tmpPath, filePath);
    } catch (renameErr) {
      if (renameErr.code === 'EXDEV' || renameErr.code === 'EPERM') {
        try {
          await fs.promises.copyFile(tmpPath, filePath);
          await fs.promises.unlink(tmpPath);
        } catch (copyErr) {
          await safeCallAsync(() => fs.promises.unlink(tmpPath), 'DebouncedPersister', 'rawAsyncCleanupAfterCopy');
          throw copyErr;
        }
      } else {
        await safeCallAsync(() => fs.promises.unlink(tmpPath), 'DebouncedPersister', 'rawAsyncCleanupAfterRename');
        throw renameErr;
      }
    }
  }

  /**
   * 原子写入JSON数据（异步），先写临时文件再重命名
   * @param {string} filePath - 目标文件路径
   * @param {*} data - 待写入的数据
   * @returns {Promise<void>}
   * @static
   * @private
   */
  static async _atomicWriteAsync(filePath, data) {
    const tmpPath = filePath + '.tmp' + _generateTmpSuffix();
    let fd = null;
    try {
      fd = await fs.promises.open(tmpPath, 'w');
      await fd.writeFile(stableStringifyPretty(data, 2));
      await fd.sync();
      await fd.close();
      fd = null;
    } catch (writeErr) {
      if (fd) { await safeCallAsync(() => fd.close(), 'DebouncedPersister', 'asyncCloseOnWriteErr'); }
      await safeCallAsync(() => fs.promises.unlink(tmpPath), 'DebouncedPersister', 'asyncCleanupOnWriteErr');
      throw writeErr;
    }
    try {
      await fs.promises.rename(tmpPath, filePath);
    } catch (renameErr) {
      if (renameErr.code === 'EXDEV' || renameErr.code === 'EPERM') {
        try {
          await fs.promises.copyFile(tmpPath, filePath);
          await fs.promises.unlink(tmpPath);
        } catch (copyErr) {
          await safeCallAsync(() => fs.promises.unlink(tmpPath), 'DebouncedPersister', 'asyncCleanupAfterCopy');
          throw copyErr;
        }
      } else {
        await safeCallAsync(() => fs.promises.unlink(tmpPath), 'DebouncedPersister', 'asyncCleanupAfterRename');
        throw renameErr;
      }
    }
  }

  /**
   * 数据消毒，移除危险键（如__proto__、constructor、prototype）
   * @param {*} data - 待消毒的数据
   * @param {number} [depth=0] - 当前递归深度
   * @returns {*} 消毒后的数据
   * @static
   * @private
   */
  static _sanitize(data, depth = 0) {
    if (depth >= 10 || !data || typeof data !== 'object') return data;
    if (Array.isArray(data)) return data.map(function(item) { return DebouncedPersister._sanitize(item, depth + 1); });
    try {
      const clone = deepClone(data);
      for (const key of Object.keys(clone)) {
        if (DANGEROUS_KEYS.has(key)) {
          delete clone[key];
        } else if (clone[key] && typeof clone[key] === 'object') {
          clone[key] = DebouncedPersister._sanitize(clone[key], depth + 1);
        }
      }
      return clone;
    } catch (_e) {
      debug('DebouncedPersister', '_sanitize', 'Deep clone failed, using fallback: ' + (_e && _e.message ? _e.message : String(_e)));
      const safe = {};
      const keys = Object.keys(data);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!DANGEROUS_KEYS.has(k)) {
          try {
            const val = data[k];
            JSON.stringify(val);
            safe[k] = (val !== null && typeof val === 'object') ? DebouncedPersister._sanitize(val, depth + 1) : val;
          } catch (_ve) { debug('DebouncedPersister', 'sanitizeSkip', _ve); }
        }
      }
      return safe;
    }
  }

  /**
   * 安全读取JSON文件，自动消毒数据
   * @param {string} filePath - 文件路径
   * @returns {*|null} 解析并消毒后的数据，文件不存在或损坏时抛出错误
   * @static
   * @throws {HarnessError} 文件损坏时抛出STORAGE_ERROR
   */
  static readJson(filePath) {
    try {
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) return null;
      return DebouncedPersister._sanitize(safeJsonParse(fs.readFileSync(resolvedPath, UTF8_ENCODING)));
    } catch (err) {
      debug('DebouncedPersister', 'readJson', err);
      throw new HarnessError('STORAGE_ERROR', 'Corrupted data file: ' + filePath + ': ' + (err && err.message ? err.message : String(err)), { cause: err });
    }
  }

  /**
   * 异步冲刷待写入数据到文件
   * @returns {Promise<void>}
   */
  async flushAsync() {
    if (this._shutDown) return;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._dirty) {
      try {
        await this.persistNowAsync();
      } catch (err) {
        if (this._onError) {
          this._onError(err);
        } else {
          debug('DebouncedPersister', 'flushAsync', err);
        }
      }
    }
  }

  /**
   * 同步冲刷待写入数据到文件
   */
  flush() {
    if (this._shutDown) return;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._dirty) {
      try {
        this.persistNow();
      } catch (err) {
        if (this._onError) {
          this._onError(err);
        } else {
          debug('DebouncedPersister', 'flush', err);
        }
      }
      if (this._dirty) {
        const err = new Error('flush failed: data still dirty after persistNow');
        if (this._onError) {
          this._onError(err);
        } else {
          debug('DebouncedPersister', 'flush', err);
        }
      }
    }
  }

  /**
   * 异步销毁持久化器，冲刷数据并释放资源
   * @returns {Promise<void>}
   */
  async destroyAsync() {
    let flushOk = true;
    try {
      await this.flushAsync();
    } catch (err) {
      debug('DebouncedPersister', 'destroyAsync', err);
      flushOk = false;
      if (this._dirty && typeof this._onError === 'function') {
        try { this._onError(new Error('Data loss: flush failed during destroy: ' + (err && err.message ? err.message : String(err)))); } catch (_e) { debug('DebouncedPersister', 'shutdownCleanup', _e && _e.message ? _e.message : String(_e)); }
      }
    }
    this._serialize = null;
    this._onError = null;
    if (!flushOk && this._dirty) {
      debug('DebouncedPersister', 'destroyAsync', 'WARNING: dirty data lost during destroy');
    }
  }

  /**
   * 同步销毁持久化器，冲刷数据并释放资源
   */
  destroy() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.flush();
    if (this._dirty) {
      try {
        this.persistNow();
      } catch (e) {
        debug('DebouncedPersister', 'destroy:finalAttempt', e);
      }
    }
    if (this._dirty) {
      const warnMsg = 'DebouncedPersister: data loss warning — dirty data could not be persisted after destroy';
      debug('DebouncedPersister', 'destroy', warnMsg);
      if (this._onError) {
        this._onError(new Error(warnMsg));
      }
    }
    this._serialize = null;
    this._onError = null;
  }

  /**
   * 获取持久化失败次数
   * @returns {number} 失败次数
   */
  get persistFailCount() {
    return this._persistFailCount;
  }

  /**
   * 获取数据是否有未持久化的变更
   * @returns {boolean} 是否有脏数据
   */
  get isDirty() {
    return this._dirty;
  }
}

/**
 * 创建防抖持久化器实例的工厂函数
 * @param {Object} options - 配置选项，同DebouncedPersister构造函数
 * @returns {DebouncedPersister} 持久化器实例
 */
function createPersister(options) {
  return new DebouncedPersister(options);
}

DebouncedPersister.prototype._onShutdown = function _onShutdown() {
  if (this._timer) {
    clearTimeout(this._timer);
    this._timer = null;
  }
  if (this._dirty) {
    try {
      const dir = this._fullDir;
      ensureDirSync(dir);
      const data = typeof this._serialize === 'function' ? this._serialize() : null;
      if (data != null) {
        const filePath = path.join(dir, this._filename);
        DebouncedPersister._atomicWrite(filePath, data);
        this._dirty = false;
      }
    } catch (err) {
      if (this._onError) {
        this._onError(err);
      } else {
        debug('DebouncedPersister', '_onShutdown', err);
      }
    }
  }
  this._serialize = null;
  this._onError = null;
};

module.exports = withShutdown(DebouncedPersister);
module.exports.sanitize = DebouncedPersister._sanitize;
module.exports.writeAtomic = DebouncedPersister.writeAtomic;
module.exports.writeAtomicText = DebouncedPersister.writeAtomicText;
module.exports.writeAtomicAsync = DebouncedPersister.writeAtomicAsync;
module.exports.writeAtomicTextAsync = DebouncedPersister.writeAtomicTextAsync;
module.exports.readJson = DebouncedPersister.readJson;
module.exports.createPersister = createPersister;
