'use strict';

/**
 * @module infrastructure/sqlite-connection
 * @description SQLite数据库连接抽象层。
 * 封装better-sqlite3原生API，提供统一的数据库操作接口。
 * 未来可替换底层实现（如sql.js、better-sqlite3-wasm等）而不影响业务代码。
 */

const { debug } = require('../../utils/debug-logger');

let NativeDatabase;
try {
  NativeDatabase = require('better-sqlite3');
} catch (_e) {
  NativeDatabase = null;
}

/**
 * SQLite连接抽象类。
 * 封装原生数据库连接，提供prepare/exec/pragma/transaction/close等标准接口。
 */
class SqliteConnection {
  /**
   * 创建SQLite连接
   * @param {string} dbPath - 数据库文件路径
   * @param {Object} [options] - 连接选项
   * @param {boolean} [options.readonly=false] - 只读模式
   * @param {boolean} [options.memory=false] - 内存数据库
   * @param {number} [options.busyTimeout=5000] - SQLITE_BUSY超时(ms)
   * @throws {Error} 当better-sqlite3不可用时抛出
   */
  constructor(dbPath, options) {
    options = options || {};
    if (!NativeDatabase) {
      throw new Error('better-sqlite3 is not available. Install it with: npm install better-sqlite3');
    }

    const nativeOptions = {};
    if (options.readonly) nativeOptions.readonly = true;

    this._db = new NativeDatabase(dbPath, Object.keys(nativeOptions).length > 0 ? nativeOptions : undefined);
    this._path = dbPath;
    this._closed = false;
  }

  /**
   * 获取原生数据库实例（用于需要直接访问的场景，如事务包裹）
   * @returns {Object} 原生better-sqlite3数据库实例
   */
  getNative() {
    return this._db;
  }

  /**
   * 执行PRAGMA语句
   * @param {string} pragma - PRAGMA语句（不含PRAGMA关键字）
   * @returns {*} PRAGMA结果
   */
  pragma(pragma) {
    this._assertOpen();
    return this._db.pragma(pragma);
  }

  /**
   * 执行SQL语句（无参数）
   * @param {string} sql - SQL语句
   */
  exec(sql) {
    this._assertOpen();
    this._db.exec(sql);
  }

  /**
   * 预编译SQL语句
   * @param {string} sql - SQL语句
   * @returns {SqliteStatement} 预编译语句对象
   */
  prepare(sql) {
    this._assertOpen();
    const nativeStmt = this._db.prepare(sql);
    return new SqliteStatement(nativeStmt);
  }

  /**
   * 创建事务函数
   * @param {Function} fn - 事务体函数
   * @returns {Function} 可调用的事务函数
   */
  transaction(fn) {
    this._assertOpen();
    return this._db.transaction(fn);
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this._db.close();
    } catch (err) {
      debug('SqliteConnection', 'close', err && err.message ? err.message : String(err));
    }
  }

  /**
   * 检查连接是否已关闭
   * @returns {boolean}
   */
  get closed() {
    return this._closed;
  }

  /**
   * 获取数据库文件路径
   * @returns {string}
   */
  get path() {
    return this._path;
  }

  /**
   * 检查better-sqlite3是否可用
   * @returns {boolean}
   */
  static isAvailable() {
    return NativeDatabase !== null;
  }

  _assertOpen() {
    if (this._closed) {
      throw new Error('SqliteConnection is closed');
    }
  }
}

/**
 * SQLite预编译语句抽象类。
 * 封装原生Statement对象，提供run/get/all/bind等标准接口。
 */
class SqliteStatement {
  /**
   * @param {Object} nativeStmt - 原生better-sqlite3 Statement对象
   */
  constructor(nativeStmt) {
    this._stmt = nativeStmt;
  }

  /**
   * 执行语句并返回变化信息
   * @param {...*} params - 参数
   * @returns {{ changes: number, lastInsertRowid: number|null }}
   */
  run() {
    const params = Array.prototype.slice.call(arguments);
    return this._stmt.run.apply(this._stmt, params);
  }

  /**
   * 查询单行结果
   * @param {...*} params - 参数
   * @returns {Object|undefined}
   */
  get() {
    const params = Array.prototype.slice.call(arguments);
    return this._stmt.get.apply(this._stmt, params);
  }

  /**
   * 查询所有结果
   * @param {...*} params - 参数
   * @returns {Array<Object>}
   */
  all() {
    const params = Array.prototype.slice.call(arguments);
    return this._stmt.all.apply(this._stmt, params);
  }

  /**
   * 绑定参数并返回可迭代对象
   * @param {...*} params - 参数
   * @returns {Object} 可迭代对象
   */
  iterate() {
    const params = Array.prototype.slice.call(arguments);
    return this._stmt.iterate.apply(this._stmt, params);
  }

  /**
   * 获取原生Statement对象
   * @returns {Object}
   */
  getNative() {
    return this._stmt;
  }
}

module.exports = { SqliteConnection, SqliteStatement };
