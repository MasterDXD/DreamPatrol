'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const DatabaseAdapter = require('../../../src/runtime/doc-parser/database-adapter');

// ─── buildCountSql 正则（与源码 query 方法中一致） ──────────
const COUNT_SQL_RE = /SELECT\s+\*/g;

describe('DatabaseAdapter — constructor & connect', () => {
  let adapter;

  beforeEach(() => {
    adapter = new DatabaseAdapter();
  });

  afterEach(async () => {
    if (adapter && adapter.isHealthy()) {
      await adapter.shutdown();
    }
  });

  // ─── 构造函数 ────────────────────────────────────────

  describe('constructor', () => {
    it('should create instance with default options', () => {
      const inst = new DatabaseAdapter();
      assert.ok(inst);
      assert.equal(inst._defaultType, 'sqlite');
      assert.equal(inst._connections.size, 0);
      assert.equal(inst._sqliteStore, null);
      assert.equal(inst._initialized, false);
    });

    it('should create instance with custom defaultType', () => {
      const inst = new DatabaseAdapter({ defaultType: 'mysql' });
      assert.equal(inst._defaultType, 'mysql');
    });

    it('should create instance with sqliteStore option', () => {
      const mockStore = { getDb: () => null };
      const inst = new DatabaseAdapter({ sqliteStore: mockStore });
      assert.strictEqual(inst._sqliteStore, mockStore);
    });

    it('should initialize stats with zeros', () => {
      const stats = adapter.getStats();
      assert.equal(stats.inserts, 0);
      assert.equal(stats.queries, 0);
      assert.equal(stats.tablesCreated, 0);
      assert.equal(stats.errors, 0);
      assert.equal(stats.connectionCount, 0);
    });

    it('should accept initial connections map', () => {
      const connections = new Map([
        ['main', { type: 'sqlite', filePath: ':memory:' }],
      ]);
      const inst = new DatabaseAdapter({ connections });
      assert.ok(inst._connections.has('main'));
      assert.equal(inst._connections.get('main').connected, true);
    });
  });

  // ─── connect（addConnection） ─────────────────────────

  describe('connect (addConnection)', () => {
    it('should connect to in-memory sqlite', () => {
      const result = adapter.addConnection('mem', {
        type: 'sqlite',
        filePath: ':memory:',
      });
      assert.equal(result.connected, true);
      assert.equal(result.name, 'mem');
    });

    it('should reuse sqliteStore connection when available', () => {
      // 创建一个真实的 better-sqlite3 实例作为 mock store
      const Database = require('better-sqlite3');
      const realDb = new Database(':memory:');
      const mockStore = { getDb: () => realDb };

      const inst = new DatabaseAdapter({ sqliteStore: mockStore });
      const result = inst.addConnection('reused', { type: 'sqlite' });
      assert.equal(result.connected, true);

      // 验证复用的是同一个 db 实例
      const conn = inst._connections.get('reused');
      assert.strictEqual(conn.db, realDb);

      realDb.close();
    });

    it('should fall back to new connection when sqliteStore returns null', () => {
      const mockStore = { getDb: () => null };
      const inst = new DatabaseAdapter({ sqliteStore: mockStore });
      const result = inst.addConnection('fallback', { type: 'sqlite', filePath: ':memory:' });
      assert.equal(result.connected, true);
    });

    it('should emit connection-added event', () => {
      let emitted = null;
      adapter.on('connection-added', (evt) => { emitted = evt; });

      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      assert.ok(emitted);
      assert.equal(emitted.name, 'main');
      assert.equal(emitted.type, 'sqlite');
      assert.equal(emitted.connected, true);
    });

    it('should throw on empty connection name', () => {
      assert.throws(
        () => adapter.addConnection('', { type: 'sqlite' }),
        /Connection name must be a non-empty string/,
      );
    });

    it('should throw on non-string connection name', () => {
      assert.throws(
        () => adapter.addConnection(123, { type: 'sqlite' }),
        /Connection name must be a non-empty string/,
      );
    });

    it('should throw on null config', () => {
      assert.throws(
        () => adapter.addConnection('x', null),
        /Connection config must be a non-null object/,
      );
    });

    it('should throw on unsupported database type', () => {
      assert.throws(
        () => adapter.addConnection('x', { type: 'oracle' }),
        /Unsupported database type/,
      );
    });

    it('should throw on mysql type (no driver)', () => {
      assert.throws(
        () => adapter.addConnection('mysql', { type: 'mysql', host: 'localhost' }),
        /MySQL driver not available/,
      );
    });

    it('should throw on postgresql type (no driver)', () => {
      assert.throws(
        () => adapter.addConnection('pg', { type: 'postgresql', host: 'localhost' }),
        /PostgreSQL driver not available/,
      );
    });
  });
});

describe('DatabaseAdapter — disconnect & query', () => {
  let adapter;

  beforeEach(() => {
    adapter = new DatabaseAdapter();
  });

  afterEach(async () => {
    if (adapter && adapter.isHealthy()) {
      await adapter.shutdown();
    }
  });

  // ─── disconnect（shutdown） ───────────────────────────

  describe('disconnect (shutdown)', () => {
    it('should close all connections on shutdown', async () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      adapter.addConnection('aux', { type: 'sqlite', filePath: ':memory:' });

      assert.equal(adapter._connections.size, 2);
      await adapter.shutdown();

      assert.equal(adapter._connections.size, 0);
      assert.equal(adapter._initialized, false);
    });

    it('should mark isHealthy as false after shutdown', async () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      assert.equal(adapter.isHealthy(), true);

      await adapter.shutdown();
      assert.equal(adapter.isHealthy(), false);
    });

    it('should not close db owned by sqliteStore', async () => {
      const Database = require('better-sqlite3');
      const realDb = new Database(':memory:');
      const mockStore = { getDb: () => realDb };

      const inst = new DatabaseAdapter({ sqliteStore: mockStore });
      inst.addConnection('shared', { type: 'sqlite' });

      await inst.shutdown();

      // sqliteStore 拥有的 db 不应被 close，仍然可用
      const stmt = realDb.prepare('SELECT 1 as val');
      assert.equal(stmt.get().val, 1);

      realDb.close();
    });

    it('should remove all listeners on shutdown', async () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      adapter.on('test-event', () => {});

      await adapter.shutdown();
      assert.equal(adapter.listenerCount('test-event'), 0);
    });
  });

  // ─── query ───────────────────────────────────────────

  describe('query', () => {
    beforeEach(() => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
    });

    it('should query all rows', () => {
      adapter.insert('people', { name: 'Alice', age: 30 }, 'main');
      adapter.insert('people', { name: 'Bob', age: 25 }, 'main');

      const result = adapter.query('people', {}, 'main');
      assert.equal(result.rows.length, 2);
      assert.equal(result.total, 2);
    });

    it('should query with where conditions', () => {
      adapter.insert('people', { name: 'Alice', age: 30 }, 'main');
      adapter.insert('people', { name: 'Bob', age: 25 }, 'main');

      const result = adapter.query('people', { where: { name: 'Alice' } }, 'main');
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].name, 'Alice');
      assert.equal(result.total, 1);
    });

    it('should query with limit', () => {
      adapter.insert('people', { name: 'Alice', age: 30 }, 'main');
      adapter.insert('people', { name: 'Bob', age: 25 }, 'main');
      adapter.insert('people', { name: 'Charlie', age: 35 }, 'main');

      const result = adapter.query('people', { limit: 2 }, 'main');
      assert.equal(result.rows.length, 2);
      assert.equal(result.total, 3); // total 不受 limit 影响
    });

    it('should query with offset', () => {
      adapter.insert('people', { name: 'Alice', age: 30 }, 'main');
      adapter.insert('people', { name: 'Bob', age: 25 }, 'main');

      const result = adapter.query('people', { limit: 1, offset: 1 }, 'main');
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].name, 'Bob');
    });

    it('should query with orderBy', () => {
      adapter.insert('people', { name: 'Charlie', age: 35 }, 'main');
      adapter.insert('people', { name: 'Alice', age: 30 }, 'main');

      const result = adapter.query('people', { orderBy: 'name ASC' }, 'main');
      assert.equal(result.rows[0].name, 'Alice');
    });

    it('should return empty result without connection', () => {
      const noConnAdapter = new DatabaseAdapter();
      const result = noConnAdapter.query('people');
      assert.equal(result.rows.length, 0);
      assert.equal(result.total, 0);
    });

    it('should increment queries stat', () => {
      adapter.insert('people', { name: 'Alice', age: 30 }, 'main');
      adapter.query('people', {}, 'main');
      adapter.query('people', {}, 'main');

      const stats = adapter.getStats();
      assert.equal(stats.queries, 2);
    });
  });
});

describe('DatabaseAdapter — buildCountSql & error handling', () => {
  let adapter;

  beforeEach(() => {
    adapter = new DatabaseAdapter();
  });

  afterEach(async () => {
    if (adapter && adapter.isHealthy()) {
      await adapter.shutdown();
    }
  });

  // ─── buildCountSql — 正则全局替换验证（R55修复） ──────

  describe('buildCountSql (regex global replacement)', () => {
    it('should replace SELECT * in simple SQL', () => {
      const sql = 'SELECT * FROM table';
      const countSql = sql.replace(COUNT_SQL_RE, 'SELECT COUNT(*) as total');
      assert.equal(countSql, 'SELECT COUNT(*) as total FROM table');
    });

    it('should replace ALL SELECT * occurrences in SQL with subquery', () => {
      const sql = 'SELECT * FROM (SELECT * FROM subtable)';
      const countSql = sql.replace(COUNT_SQL_RE, 'SELECT COUNT(*) as total');
      assert.equal(
        countSql,
        'SELECT COUNT(*) as total FROM (SELECT COUNT(*) as total FROM subtable)',
      );
    });

    it('should replace SELECT * with varying whitespace', () => {
      const sql = 'SELECT  * FROM table';
      const countSql = sql.replace(COUNT_SQL_RE, 'SELECT COUNT(*) as total');
      assert.equal(countSql, 'SELECT COUNT(*) as total FROM table');
    });

    it('should replace multiple SELECT * with mixed case', () => {
      const sql = 'SELECT * FROM (select  * FROM subtable)';
      const countSql = sql.replace(COUNT_SQL_RE, 'SELECT COUNT(*) as total');
      // 正则 /SELECT\s+\*/g 不匹配小写 select，只匹配大写 SELECT
      assert.equal(
        countSql,
        'SELECT COUNT(*) as total FROM (select  * FROM subtable)',
      );
    });

    it('should not replace SELECT col without asterisk', () => {
      const sql = 'SELECT id, name FROM table';
      const countSql = sql.replace(COUNT_SQL_RE, 'SELECT COUNT(*) as total');
      assert.equal(countSql, 'SELECT id, name FROM table');
    });

    it('should handle deeply nested subqueries', () => {
      const sql = 'SELECT * FROM (SELECT * FROM (SELECT * FROM deep))';
      const countSql = sql.replace(COUNT_SQL_RE, 'SELECT COUNT(*) as total');
      assert.equal(
        countSql,
        'SELECT COUNT(*) as total FROM (SELECT COUNT(*) as total FROM (SELECT COUNT(*) as total FROM deep))',
      );
    });

    it('should verify count SQL works end-to-end via query method', () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });

      // 创建表并插入数据
      adapter.insert('items', { name: 'A', value: 1 }, 'main');
      adapter.insert('items', { name: 'B', value: 2 }, 'main');

      // query 方法内部使用 countSql，验证 total 正确
      const result = adapter.query('items', {}, 'main');
      assert.equal(result.total, 2);
      assert.equal(result.rows.length, 2);
    });

    it('should verify count total is correct with where filter', () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });

      adapter.insert('items', { name: 'A', value: 1 }, 'main');
      adapter.insert('items', { name: 'B', value: 2 }, 'main');
      adapter.insert('items', { name: 'C', value: 3 }, 'main');

      const result = adapter.query('items', { where: { name: 'A' } }, 'main');
      assert.equal(result.total, 1);
      assert.equal(result.rows.length, 1);
    });
  });

  // ─── 错误处理 ────────────────────────────────────────

  describe('error handling', () => {
    it('should return 0 inserted when no connection', () => {
      const result = adapter.insert('people', { name: 'Alice' });
      assert.equal(result.inserted, 0);
      assert.equal(result.tableName, 'people');
    });

    it('should return empty query result when no connection', () => {
      const result = adapter.query('people');
      assert.equal(result.rows.length, 0);
      assert.equal(result.total, 0);
    });

    it('should return false for createTableFromSchema without connection', () => {
      const result = adapter.createTableFromSchema('test', { fields: { name: { type: 'string' } } });
      assert.equal(result, false);
    });

    it('should return false for createTableFromSchema with invalid schema', () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      assert.equal(adapter.createTableFromSchema('test', null, 'main'), false);
      assert.equal(adapter.createTableFromSchema('test', {}, 'main'), false);
      assert.equal(adapter.createTableFromSchema('test', { fields: null }, 'main'), false);
    });

    it('should return 0 for batchInsert without connection', () => {
      const result = adapter.batchInsert('people', [{ name: 'A' }]);
      assert.equal(result.inserted, 0);
    });

    it('should handle empty data array in insert', () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      const result = adapter.insert('people', [], 'main');
      assert.equal(result.inserted, 0);
    });

    it('should handle empty records in batchInsert', () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      const result = adapter.batchInsert('people', [], 'main');
      assert.equal(result.inserted, 0);
      assert.equal(result.errors, 0);
    });

    it('should increment errors stat on failed operations', () => {
      // 无连接时操作失败会增加 errors
      adapter.insert('people', { name: 'Alice' });
      adapter.query('people');
      adapter.createTableFromSchema('test', { fields: { name: { type: 'string' } } });

      const stats = adapter.getStats();
      assert.ok(stats.errors >= 3);
    });

    it('should emit insert-error event on failed insert', () => {
      let emitted = null;
      adapter.on('insert-error', (evt) => { emitted = evt; });

      // 无连接时插入
      adapter.insert('people', { name: 'Alice' });
      assert.ok(emitted);
      assert.equal(emitted.tableName, 'people');
    });

    it('should handle invalid SQL identifier in table name gracefully', () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      // insert 内部 try-catch 捕获异常，返回 inserted: 0
      const result = adapter.insert('bad table name!', { name: 'A' }, 'main');
      assert.equal(result.inserted, 0);
    });

    it('should handle invalid SQL identifier in column name gracefully', () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      // insert 内部 try-catch 捕获异常，返回 inserted: 0
      const result = adapter.insert('people', { 'bad column!': 'A' }, 'main');
      assert.equal(result.inserted, 0);
    });

    it('should handle invalid orderBy column gracefully', () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      adapter.insert('people', { name: 'Alice' }, 'main');

      // query 内部 try-catch 捕获异常，返回空结果
      const result = adapter.query('people', { orderBy: 'bad;col' }, 'main');
      assert.equal(result.rows.length, 0);
      assert.equal(result.total, 0);
    });
  });
});

describe('DatabaseAdapter — getConnections & getStats', () => {
  let adapter;

  beforeEach(() => {
    adapter = new DatabaseAdapter();
  });

  afterEach(async () => {
    if (adapter && adapter.isHealthy()) {
      await adapter.shutdown();
    }
  });

  describe('getConnections / getStats', () => {
    it('should return defensive copy from getConnections', () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });

      const copy1 = adapter.getConnections();
      const copy2 = adapter.getConnections();
      assert.notStrictEqual(copy1, copy2);
      assert.ok(copy1.has('main'));
      assert.equal(copy1.get('main').type, 'sqlite');
      assert.equal(typeof copy1.get('main').connected, 'boolean');
    });

    it('should return stats with connectionCount', () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      adapter.addConnection('aux', { type: 'sqlite', filePath: ':memory:' });

      const stats = adapter.getStats();
      assert.equal(stats.connectionCount, 2);
    });

    it('should update stats after operations', () => {
      adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
      adapter.insert('people', { name: 'Alice' }, 'main');
      adapter.query('people', {}, 'main');

      const stats = adapter.getStats();
      assert.ok(stats.inserts >= 1);
      assert.ok(stats.queries >= 1);
      assert.ok(stats.tablesCreated >= 1);
      assert.equal(stats.connectionCount, 1);
    });
  });
});
