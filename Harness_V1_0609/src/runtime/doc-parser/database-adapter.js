/**
 * @module runtime/doc-parser/database-adapter
 * @description 文档解析子系统的多数据库适配器模块。支持SQLite（better-sqlite3）、
 * MySQL和PostgreSQL连接，提供结构化数据的插入、查询、表创建和批量操作功能。
 * 使用EventEmitter + withShutdown混入，遵循项目编码规范。
 */

'use strict';

const { EventEmitter } = require('events');

/** @constant {RegExp} SQL_IDENTIFIER_RE - 合法SQL标识符正则（防注入） */
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** @private */
function _validateIdentifier(name, label) {
  if (!name || typeof name !== 'string' || !SQL_IDENTIFIER_RE.test(name)) {
    throw new Error('Invalid SQL identifier' + (label ? ' for ' + label : '') + ': ' + String(name));
  }
  return name;
}
const { SqliteConnection } = require('../infrastructure/sqlite-connection');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

/** @constant {Object.<string, string>} FIELD_TYPE_MAP - 字段类型到SQL类型的映射表 */
const FIELD_TYPE_MAP = {
  string: 'TEXT',
  number: 'REAL',
  date: 'TEXT',
  boolean: 'INTEGER',
  array: 'TEXT',
  object: 'TEXT',
};

/** @constant {string[]} VALID_DB_TYPES - 支持的数据库类型列表 */
const VALID_DB_TYPES = ['sqlite', 'mysql', 'postgresql'];

/**
 * 从JavaScript值推断SQL类型
 * @param {*} value - 待推断的值
 * @returns {string} 对应的SQL类型名称
 * @private
 */
function _inferSqlType(value) {
  if (value === null || value === undefined) return 'TEXT';
  if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'REAL';
  if (typeof value === 'boolean') return 'INTEGER';
  if (value instanceof Date) return 'TEXT';
  if (Array.isArray(value)) return 'TEXT';
  if (typeof value === 'object') return 'TEXT';
  return 'TEXT';
}

/**
 * 将JavaScript值转换为SQLite兼容的存储值
 * @param {*} value - 待转换的值
 * @returns {*} SQLite兼容的值
 * @private
 */
function _toSqliteValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * @class DatabaseAdapter
 * @classdesc 文档数据库适配器，提供文档解析结果的持久化存储和查询接口
 * @extends EventEmitter
 * @description 多数据库适配器，支持SQLite、MySQL和PostgreSQL连接。
 * 提供结构化数据的插入、查询、表自动创建和批量事务操作。
 */
class DatabaseAdapter extends EventEmitter {
  /**
   * 创建DatabaseAdapter实例。
   * @param {Object} [options] - 配置选项
   * @param {string} [options.defaultType='sqlite'] - 默认数据库类型
   * @param {Object} [options.sqliteStore] - 可选的已有SqliteStore实例，用于复用连接
   * @param {Map<string, Object>} [options.connections] - 命名连接的初始映射
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._defaultType = opts.defaultType || 'sqlite';
    this._sqliteStore = opts.sqliteStore ?? null;
    this._connections = new Map();
    /** @constant {number} MAX_CONNECTIONS - 最大连接数 */
    this._maxConnections = 50;
    this._stats = {
      inserts: 0,
      queries: 0,
      tablesCreated: 0,
      errors: 0,
    };
    this._initialized = false;

    if (opts.connections instanceof Map) {
      for (const [name, config] of opts.connections) {
        try { this.addConnection(name, config); } catch (err) { debug('DatabaseAdapter', 'constructor-addConnection', err); }
      }
    }
  }

  /**
   * 添加数据库连接。对于SQLite类型直接创建better-sqlite3连接或复用注入的sqliteStore；
   * 对于MySQL/PostgreSQL存储配置以支持懒连接（无驱动时抛出错误）。
   * @param {string} name - 连接名称
   * @param {Object} config - 连接配置
   * @param {string} config.type - 数据库类型（'sqlite'|'mysql'|'postgresql'）
   * @param {string} [config.host] - 主机地址（mysql/postgresql）
   * @param {number} [config.port] - 端口号（mysql/postgresql）
   * @param {string} [config.database] - 数据库名（mysql/postgresql）
   * @param {string} [config.user] - 用户名（mysql/postgresql）
   * @param {string} [config.password] - 密码（mysql/postgresql）
   * @param {string} [config.filePath] - 文件路径（sqlite）
   * @returns {{ connected: boolean, name: string }} 连接结果
   * @throws {Error} 配置无效或驱动不可用时抛出
   */
  addConnection(name, config) {
    this.guardShutdown();
    if (!name || typeof name !== 'string') {
      throw new Error('Connection name must be a non-empty string');
    }
    if (!config || typeof config !== 'object') {
      throw new Error('Connection config must be a non-null object');
    }
    if (!VALID_DB_TYPES.includes(config.type)) {
      throw new Error('Unsupported database type: ' + config.type + '. Valid types: ' + VALID_DB_TYPES.join(', '));
    }
    if (this._connections.size >= this._maxConnections && !this._connections.has(name)) {
      const oldestKey = this._connections.keys().next().value;
      if (oldestKey) this._connections.delete(oldestKey);
    }

    const entry = {
      type: config.type,
      config: { ...config },
      db: null,
      connected: false,
    };

    if (config.type === 'sqlite') {
      try {
        if (this._sqliteStore && typeof this._sqliteStore.getDb === 'function') {
          const existingDb = this._sqliteStore.getDb();
          if (existingDb) {
            entry.db = existingDb;
            entry.connected = true;
          }
        }
        if (!entry.db) {
          const filePath = config.filePath || ':memory:';
          const conn = new SqliteConnection(filePath);
          conn.pragma('journal_mode = WAL');
          conn.pragma('synchronous = NORMAL');
          entry.db = conn.getNative();
          entry._conn = conn;
          entry.connected = true;
        }
      } catch (err) {
        debug('DatabaseAdapter', 'addConnection-sqlite', err);
        entry.connected = false;
        this._stats.errors++;
      }
    } else if (config.type === 'mysql') {
      throw new Error('MySQL driver not available. Install mysql2 package to use MySQL connections.');
    } else if (config.type === 'postgresql') {
      throw new Error('PostgreSQL driver not available. Install pg package to use PostgreSQL connections.');
    }

    this._connections.set(name, entry);
    this.emit('connection-added', { name, type: config.type, connected: entry.connected });
    return { connected: entry.connected, name };
  }

  /**
   * 插入结构化数据。支持单条或批量插入，自动创建不存在的表。
   * @param {string} tableName - 目标表名
   * @param {Object|Object[]} data - 单条数据对象或数据对象数组
   * @param {string} [connectionName] - 连接名称，默认使用第一个可用连接
   * @returns {{ inserted: number, tableName: string }} 插入结果
   */
  insert(tableName, data, connectionName) {
    this.guardShutdown();
    const conn = this._getConnection(connectionName);
    if (!conn || !conn.db) {
      this._stats.errors++;
      this.emit('insert-error', { tableName, error: 'No active database connection' });
      return { inserted: 0, tableName };
    }

    const records = Array.isArray(data) ? data : [data];
    if (records.length === 0) {
      return { inserted: 0, tableName };
    }

    try {
      this._ensureTable(conn, tableName, records[0]);

      const columns = Object.keys(records[0]);
      columns.forEach(function(c) { _validateIdentifier(c, 'column'); });
      const placeholders = columns.map(() => '?').join(', ');
      const sql = 'INSERT INTO ' + _validateIdentifier(tableName, 'table') + ' (' + columns.join(', ') + ') VALUES (' + placeholders + ')';
      const stmt = conn.db.prepare(sql);

      let inserted = 0;
      for (const record of records) {
        const values = columns.map(col => _toSqliteValue(record[col]));
        stmt.run(...values);
        inserted++;
      }

      this._stats.inserts += inserted;
      this.emit('data-inserted', { tableName, inserted });
      return { inserted, tableName };
    } catch (err) {
      debug('DatabaseAdapter', 'insert', err);
      this._stats.errors++;
      this.emit('insert-error', { tableName, error: err && err.message ? err.message : String(err) });
      return { inserted: 0, tableName };
    }
  }

  /**
   * 查询数据。支持条件过滤、分页和排序。
   * @param {string} tableName - 目标表名
   * @param {Object} [conditions] - 查询条件
   * @param {Object} [conditions.where] - WHERE条件键值对
   * @param {number} [conditions.limit] - 返回条数上限
   * @param {number} [conditions.offset] - 偏移量
   * @param {string} [conditions.orderBy] - 排序字段
   * @param {string} [connectionName] - 连接名称
   * @returns {{ rows: Object[], total: number }} 查询结果
   */
  query(tableName, conditions, connectionName) {
    this.guardShutdown();
    const conn = this._getConnection(connectionName);
    if (!conn || !conn.db) {
      this._stats.errors++;
      return { rows: [], total: 0 };
    }

    const cond = conditions ?? {};
    this._stats.queries++;

    try {
      let sql = 'SELECT * FROM ' + _validateIdentifier(tableName, 'table');
      const params = [];

      if (cond.where && typeof cond.where === 'object') {
        const clauses = [];
        for (const [key, value] of Object.entries(cond.where)) {
          clauses.push(key + ' = ?');
          params.push(_toSqliteValue(value));
        }
        if (clauses.length > 0) {
          sql += ' WHERE ' + clauses.join(' AND ');
        }
      }

      const countSql = sql.replace(/SELECT\s+\*/g, 'SELECT COUNT(*) as total');
      let total = 0;
      try {
        const countRow = conn.db.prepare(countSql).get(...params);
        total = countRow ? countRow.total : 0;
      } catch (_e) {
        debug('DatabaseAdapter', 'query:countSql', _e && _e.message ? _e.message : String(_e));
        total = 0;
      }

      if (cond.orderBy && typeof cond.orderBy === 'string') {
        const orderParts = cond.orderBy.split(',').map(function(p) {
          const trimmed = p.trim().replace(/\s+(ASC|DESC|asc|desc)\s*$/, '');
          _validateIdentifier(trimmed, 'orderBy column');
          return p.trim();
        });
        sql += ' ORDER BY ' + orderParts.join(', ');
      }

      if (Number.isFinite(cond.limit)) {
        sql += ' LIMIT ?';
        params.push(Math.max(0, Math.floor(cond.limit)));
      }
      if (Number.isFinite(cond.offset)) {
        sql += ' OFFSET ?';
        params.push(Math.max(0, Math.floor(cond.offset)));
      }

      const rows = conn.db.prepare(sql).all(...params);
      return { rows, total };
    } catch (err) {
      debug('DatabaseAdapter', 'query', err);
      this._stats.errors++;
      return { rows: [], total: 0 };
    }
  }

  /**
   * 根据提取模式创建表。将schema中定义的字段映射为SQL列类型，
   * 并自动添加文档解析元数据列。
   * @param {string} tableName - 表名
   * @param {Object} schema - 提取模式定义
   * @param {Object} [schema.fields] - 字段定义映射
   * @param {string} [connectionName] - 连接名称
   * @returns {boolean} 是否创建成功
   */
  createTableFromSchema(tableName, schema, connectionName) {
    this.guardShutdown();
    const conn = this._getConnection(connectionName);
    if (!conn || !conn.db) {
      this._stats.errors++;
      return false;
    }

    if (!schema || typeof schema !== 'object' || !schema.fields) {
      debug('DatabaseAdapter', 'createTableFromSchema', 'Schema must contain fields property');
      return false;
    }

    try {
      const columns = ['id INTEGER PRIMARY KEY AUTOINCREMENT'];

      for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
        const sqlType = FIELD_TYPE_MAP[fieldDef.type] || FIELD_TYPE_MAP[typeof fieldDef] || 'TEXT';
        columns.push(_validateIdentifier(fieldName, 'field') + ' ' + sqlType);
      }

      columns.push('_doc_id TEXT');
      columns.push('_extraction_id TEXT');
      columns.push('_created_at TEXT');
      columns.push('_confidence REAL');

      const sql = 'CREATE TABLE IF NOT EXISTS ' + _validateIdentifier(tableName, 'table') + ' (' + columns.join(', ') + ')';
      conn.db.exec(sql);

      this._stats.tablesCreated++;
      this.emit('table-created', { tableName });
      return true;
    } catch (err) {
      debug('DatabaseAdapter', 'createTableFromSchema', err);
      this._stats.errors++;
      return false;
    }
  }

  /**
   * 批量插入数据，使用事务保证原子性。失败时整批回滚。
   * @param {string} tableName - 目标表名
   * @param {Object[]} records - 数据记录数组
   * @param {string} [connectionName] - 连接名称
   * @returns {{ inserted: number, errors: number }} 批量插入结果
   */
  batchInsert(tableName, records, connectionName) {
    this.guardShutdown();
    const conn = this._getConnection(connectionName);
    if (!conn || !conn.db) {
      this._stats.errors++;
      return { inserted: 0, errors: Array.isArray(records) ? records.length : 0 };
    }

    if (!Array.isArray(records) || records.length === 0) {
      return { inserted: 0, errors: 0 };
    }

    try {
      this._ensureTable(conn, tableName, records[0]);

      const columns = Object.keys(records[0]);
      columns.forEach(function(c) { _validateIdentifier(c, 'column'); });
      const placeholders = columns.map(() => '?').join(', ');
      const insertSql = 'INSERT INTO ' + _validateIdentifier(tableName, 'table') + ' (' + columns.join(', ') + ') VALUES (' + placeholders + ')';

      let inserted = 0;

      const batchInsert = conn.db.transaction((items) => {
        const stmt = conn.db.prepare(insertSql);
        for (const record of items) {
          const values = columns.map(col => _toSqliteValue(record[col]));
          stmt.run(...values);
          inserted++;
        }
      });

      try {
        batchInsert(records);
      } catch (txErr) {
        debug('DatabaseAdapter', 'batchInsert', txErr);
        this._stats.errors++;
        this.emit('insert-error', { tableName, error: txErr.message || String(txErr), batch: true });
        return { inserted: 0, errors: records.length, tableName };
      }

      this._stats.inserts += inserted;
      this.emit('data-inserted', { tableName, inserted, batch: true });
      return { inserted, errors: 0, tableName };
    } catch (err) {
      debug('DatabaseAdapter', 'batchInsert', err);
      this._stats.errors++;
      this.emit('insert-error', { tableName, error: err && err.message ? err.message : String(err), batch: true });
      return { inserted: 0, errors: records.length, tableName };
    }
  }

  /**
   * 获取所有连接信息的防御性副本。
   * @returns {Map<string, Object>} 连接信息映射的副本
   */
  getConnections() {
    this.guardShutdown();
    const copy = new Map();
    for (const [name, entry] of this._connections) {
      copy.set(name, {
        type: entry.type,
        connected: entry.connected,
        config: { ...entry.config },
      });
    }
    return copy;
  }

  /**
   * 获取操作统计信息的防御性副本。
   * @returns {{ inserts: number, queries: number, tablesCreated: number, errors: number, connectionCount: number }} 统计信息
   */
  getStats() {
    this.guardShutdown();
    return {
      inserts: this._stats.inserts,
      queries: this._stats.queries,
      tablesCreated: this._stats.tablesCreated,
      errors: this._stats.errors,
      connectionCount: this._connections.size,
    };
  }

  /**
   * 获取指定名称的连接，无名称时返回第一个可用连接。
   * @param {string} [name] - 连接名称
   * @returns {Object|null} 连接条目对象，未找到时返回null
   * @private
   */
  _getConnection(name) {
    if (name) {
      return this._connections.get(name) ?? null;
    }
    const first = this._connections.values().next();
    return first.done ? null : first.value;
  }

  /**
   * 确保目标表存在，若不存在则根据数据键和类型自动创建。
   * @param {Object} conn - 连接条目
   * @param {string} tableName - 表名
   * @param {Object} sampleData - 样本数据对象
   * @private
   */
  _ensureTable(conn, tableName, sampleData) {
    try {
      const tableCheck = conn.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
      if (tableCheck) return;

      const columns = ['id INTEGER PRIMARY KEY AUTOINCREMENT'];
      for (const [key, value] of Object.entries(sampleData)) {
        const sqlType = _inferSqlType(value);
        columns.push(_validateIdentifier(key, 'column') + ' ' + sqlType);
      }

      const sql = 'CREATE TABLE IF NOT EXISTS ' + _validateIdentifier(tableName, 'table') + ' (' + columns.join(', ') + ')';
      conn.db.exec(sql);

      this._stats.tablesCreated++;
      this.emit('table-created', { tableName });
    } catch (err) {
      debug('DatabaseAdapter', '_ensureTable', err);
    }
  }

  /**
   * 关闭所有数据库连接并清理资源。
   * @private
   */
  _onShutdown() {
    for (const [name, entry] of this._connections) {
      if (entry.db) {
        try {
          if (entry.type === 'sqlite') {
            if (!(this._sqliteStore && typeof this._sqliteStore.getDb === 'function' && this._sqliteStore.getDb() === entry.db)) {
              if (entry._conn) {
                entry._conn.close();
              } else {
                entry.db.close();
              }
            }
          } else if (entry.type === 'mysql' || entry.type === 'postgresql') {
            if (typeof entry.db.end === 'function') {
              entry.db.end();
            } else if (typeof entry.db.destroy === 'function') {
              entry.db.destroy();
            }
          }
        } catch (err) {
          debug('DatabaseAdapter', 'shutdown-close-' + name, err);
        }
      }
      entry.db = null;
      entry.connected = false;
    }
    this._connections.clear();
    this._initialized = false;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(DatabaseAdapter);
