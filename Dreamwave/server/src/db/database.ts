import initSqlJs, { Database as SqlJsDatabase, Statement } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { runMigrations } from './migrations';

const DB_PATH = path.join(__dirname, '../../data/dreamwave.db');
const DATA_DIR = path.join(__dirname, '../../data');

let db: SqlJsDatabase | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// 查询缓存：对频繁读取的查询结果缓存100ms，最大500条
interface CacheEntry {
  result: any[];
  expireAt: number;
}
const MAX_CACHE_SIZE = 500;
const queryCache = new Map<string, CacheEntry>();
const CACHE_TTL = 100; // 100ms缓存

export async function getDatabase(): Promise<SqlJsDatabase> {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    await runMigrations(db);
    saveDatabaseSync();
  }
  return db;
}

function saveDatabaseSync(): void {
  if (db) {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (err) {
      console.error('[DB] saveDatabaseSync error:', err);
    }
  }
}

export function saveDatabase(): void {
  if (saveTimer) clearTimeout(saveTimer);
  // 写入时清除查询缓存，保证数据一致性
  queryCache.clear();
  saveTimer = setTimeout(() => {
    try {
      saveDatabaseSync();
    } catch (err) {
      console.error('[DB] saveDatabase error:', err);
    }
    saveTimer = null;
  }, 300);
}

/** 立即同步保存数据库到磁盘（用于关键操作如注册、创建梦境） */
export function saveDatabaseImmediate(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  queryCache.clear();
  saveDatabaseSync();
}

/** 在事务中执行多个数据库操作，失败时自动回滚 */
export function runInTransaction(fn: () => void): void {
  if (!db) throw new Error('Database not initialized');
  try {
    db.run('BEGIN TRANSACTION');
    fn();
    db.run('COMMIT');
    saveDatabase();
  } catch (err) {
    try { db.run('ROLLBACK'); } catch {}
    console.error('[DB] runInTransaction error, rolled back:', err);
    throw err;
  }
}

export function closeDatabase(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (db) {
    try {
      saveDatabaseSync();
      db.close();
    } catch (err) {
      console.error('[DB] closeDatabase error:', err);
    }
    db = null;
  }
  queryCache.clear();
}

// 生成缓存键
function cacheKey(sql: string, params: any[]): string {
  return sql + '::' + JSON.stringify(params);
}

export function queryAll(sql: string, params: any[] = []): any[] {
  if (!db) throw new Error('Database not initialized');

  // 检查缓存
  const key = cacheKey(sql, params);
  const now = Date.now();
  const cached = queryCache.get(key);
  if (cached && cached.expireAt > now) {
    return cached.result;
  }

  let stmt: Statement | null = null;
  try {
    stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }

    // 写入缓存（LRU 淘汰）
    if (queryCache.size >= MAX_CACHE_SIZE) {
      const firstKey = queryCache.keys().next().value;
      if (firstKey) queryCache.delete(firstKey);
    }
    queryCache.set(key, { result: rows, expireAt: now + CACHE_TTL });

    return rows;
  } catch (err) {
    console.error('[DB] queryAll error:', sql, err);
    throw err;
  } finally {
    if (stmt) stmt.free();
  }
}

export function queryOne(sql: string, params: any[] = []): any | undefined {
  const rows = queryAll(sql, params);
  return rows[0];
}

export function run(sql: string, params: any[] = []): void {
  if (!db) throw new Error('Database not initialized');
  try {
    db.run(sql, params);
    saveDatabase();
  } catch (err) {
    console.error('[DB] run error:', sql, err);
    throw err;
  }
}
