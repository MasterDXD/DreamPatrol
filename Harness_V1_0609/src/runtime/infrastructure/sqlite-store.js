'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { DeepeningError } = require('../../errors');
const { debug } = require('../../utils/debug-logger');
const { sanitize: sanitizeData } = require('../../utils/debounced-persister');
const { ensureDirSync, loadJsonSync } = require('../../utils/fs-utils');
const { SqliteConnection } = require('./sqlite-connection');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeStringify } = require('../../utils/safe-parse');
const { SQLITE_BUSY_TIMEOUT_MS , HARNESS_DIR} = require('../../utils/constants');
const SQLITE_BUSY_RETRY_MAX = 3;
const DEFAULT_KNOWLEDGE_MAX_AGE_SECONDS = 7 * 24 * 3600;

function _escapeLike(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

const FTS_TABLE_MAP = {
  knowledge: 'knowledge_fts',
  sessions: 'session_fts',
  skill_learnings: 'skill_learnings_fts',
  memory: 'memory_fts',
};

function unixNow() { return Math.floor(Date.now() / 1000); }

const _instanceRegistry = new Map();

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL DEFAULT '',
    completed_skills TEXT NOT NULL DEFAULT '',
    key_decisions TEXT NOT NULL DEFAULT '',
    lessons_learned TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS skill_learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT '',
    approach TEXT NOT NULL DEFAULT '',
    what_worked TEXT NOT NULL DEFAULT '',
    what_failed TEXT NOT NULL DEFAULT '',
    tips TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS user_profile (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS affinity_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0.5,
    samples INTEGER NOT NULL DEFAULT 0,
    total_score REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS memory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL DEFAULT 'memory',
    content TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    verified_at INTEGER NOT NULL DEFAULT 0,
    tier TEXT DEFAULT 'episodic',
    importance REAL DEFAULT 0.5,
    half_life_days INTEGER DEFAULT 30,
    access_count INTEGER DEFAULT 0,
    promoted_at INTEGER DEFAULT NULL,
    demoted_at INTEGER DEFAULT NULL,
    last_accessed_at INTEGER DEFAULT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_affinity_agent_task ON affinity_records(agent_id, task_type)',
  `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    title, content, tags, category, source
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
    session_id, phase, key_decisions, lessons_learned
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS skill_learnings_fts USING fts5(
    skill_id, approach, what_worked, what_failed, tips
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content
  )`,
  'CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(source)',
  'CREATE INDEX IF NOT EXISTS idx_skill_learnings_skill_id ON skill_learnings(skill_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_target ON memory_entries(target)',
  'CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory_entries(tier)',
  `CREATE TABLE IF NOT EXISTS causal_chain (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL DEFAULT '',
    skill_id TEXT NOT NULL,
    causal_id TEXT NOT NULL UNIQUE,
    parent_causal_id TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL DEFAULT '{}',
    interface_version INTEGER NOT NULL DEFAULT 0,
    wal_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_causal_chain_skill_id ON causal_chain(skill_id)',
  'CREATE INDEX IF NOT EXISTS idx_causal_chain_execution_id ON causal_chain(execution_id)',
  'CREATE INDEX IF NOT EXISTS idx_causal_chain_created_at ON causal_chain(created_at)',
  `CREATE TABLE IF NOT EXISTS shared_learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    tips TEXT NOT NULL DEFAULT '',
    avoidances TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_shared_learnings_skill_id ON shared_learnings(skill_id)',
  'CREATE INDEX IF NOT EXISTS idx_shared_learnings_agent_id ON shared_learnings(agent_id)',
];

const MEMORY_CHAR_LIMIT = 2200;
const USER_CHAR_LIMIT = 1375;
const MAX_KNOWLEDGE = 500;
const MAX_SKILL_LEARNINGS = 200;
const MAX_SHARED_LEARNINGS = 200;
const MAX_CAUSAL_CHAIN = 2000;
const MAX_SINGLE_CONTENT_LENGTH = 50000;

/**
 * @module runtime/infrastructure/sqlite-store
 * @classdesc SQLite存储。键值存储、事务支持、WAL模式
 * SQLite存储。键值存储、事务支持、WAL模式，
 * 支持全文检索（FTS5）和知识/会话/技能学习/记忆多表管理。
 */
class SqliteStore extends EventEmitter {
  /**
   * 创建 SqliteStore 实例。
   * @param {string} projectRoot - 项目根目录路径
   * @param {Object} [options] - 配置选项
   */
  constructor(projectRoot, options) {
    super();
    if (!projectRoot || typeof projectRoot !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'projectRoot is required and must be a string');
    }
    this._root = projectRoot;
    this._dataDir = path.join(this._root, HARNESS_DIR, 'data');
    this._options = options ?? {};
    this._db = null;
    this._stmts = {};
  }

  /**
   * 获取或创建SqliteStore单例实例。按projectRoot路径注册，已关闭的实例自动清理。
   * @param {string} projectRoot - 项目根目录路径
   * @param {Object} [options] - 初始化选项
   * @returns {SqliteStore} 单例实例
   */
  static getInstance(projectRoot, options) {
    const key = path.resolve(projectRoot);
    if (_instanceRegistry.has(key)) {
      const existing = _instanceRegistry.get(key);
      if (!existing._shutDown && existing._db) {
        return existing;
      }
      _instanceRegistry.delete(key);
    }
    const instance = new SqliteStore(projectRoot, options);
    _instanceRegistry.set(key, instance);
    try {
      instance.init();
    } catch (err) {
      _instanceRegistry.delete(key);
      if (instance._db) {
        try { instance._db.close(); } catch (_e) { debug('SqliteStore', 'closeAfterInitError', _e && _e.message ? _e.message : String(_e)); }
        instance._db = null;
      }
      throw err;
    }
    return instance;
  }

  _executeWithRetry(fn) {
    let lastErr = null;
    for (let attempt = 0; attempt <= SQLITE_BUSY_RETRY_MAX; attempt++) {
      try {
        return fn();
      } catch (err) {
        lastErr = err;
        if (err && err.code === 'SQLITE_BUSY') {
          if (attempt < SQLITE_BUSY_RETRY_MAX) {
            continue;
          }
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(lastErr && lastErr.message ? lastErr.message : String(lastErr), { cause: lastErr });
  }

  /**
   * 初始化数据库连接、创建表、准备语句、执行迁移。
   * @returns {SqliteStore} this（链式调用）
   */
  init() {
    if (!SqliteConnection.isAvailable()) {
      throw new Error('better-sqlite3 native module not available. Install it with: npm install better-sqlite3');
    }
    if (this._db) return this;
    const dir = this._dataDir;
    ensureDirSync(dir);
    const dbPath = path.join(dir, 'harness.db');
    try {
      this._db = new SqliteConnection(dbPath);
    } catch (err) {
      const key = path.resolve(this._root);
      _instanceRegistry.delete(key);
      throw err;
    }
    try {
      this._db.pragma('journal_mode = WAL');
      this._db.pragma('synchronous = NORMAL');
      this._db.pragma('foreign_keys = ON');
      this._db.pragma('busy_timeout = ' + SQLITE_BUSY_TIMEOUT_MS);
      for (const sql of CREATE_TABLES) {
        this._db.exec(sql);
      }
      this._runSchemaMigrations();
      this._prepareStatements();
      this._migrateFromJson();
    } catch (err) {
      try { this._db.close(); } catch (_) { debug('SqliteStore', 'closeOnError', _ && _.message ? _.message : String(_)); }
      this._db = null;
      const key = path.resolve(this._root);
      _instanceRegistry.delete(key);
      throw err;
    }
    this.emit('initialized');
    return this;
  }

  _prepareStatements() {
    this._stmts = {
      addKnowledge: this._db.prepare(
        'INSERT INTO knowledge (category, title, content, tags, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      getKnowledge: this._db.prepare('SELECT * FROM knowledge WHERE id = ?'),
      queryKnowledge: this._db.prepare(
        'SELECT * FROM knowledge WHERE category LIKE ? OR tags LIKE ? OR title LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT ?',
      ),
      ftsKnowledge: this._db.prepare(
        'SELECT k.* FROM knowledge k JOIN knowledge_fts f ON k.id = f.rowid WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT ?',
      ),
      updateKnowledge: this._db.prepare(
        'UPDATE knowledge SET category=?, title=?, content=?, tags=?, source=?, updated_at=? WHERE id=?',
      ),
      deleteKnowledge: this._db.prepare('DELETE FROM knowledge WHERE id = ?'),
      countKnowledge: this._db.prepare('SELECT COUNT(*) as cnt FROM knowledge'),
      evictKnowledge: this._db.prepare('DELETE FROM knowledge WHERE id IN (SELECT id FROM knowledge ORDER BY updated_at ASC LIMIT ?)'),

      saveSessionSummary: this._db.prepare(
        'INSERT OR REPLACE INTO session_summaries (session_id, phase, completed_skills, key_decisions, lessons_learned, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      getSessionSummary: this._db.prepare('SELECT * FROM session_summaries WHERE session_id = ?'),
      querySummaries: this._db.prepare(
        'SELECT * FROM session_summaries WHERE phase LIKE ? OR key_decisions LIKE ? OR lessons_learned LIKE ? ORDER BY updated_at DESC LIMIT ?',
      ),
      ftsSessions: this._db.prepare(
        'SELECT s.* FROM session_summaries s JOIN session_fts f ON s.id = f.rowid WHERE session_fts MATCH ? ORDER BY rank LIMIT ?',
      ),

      addSkillLearning: this._db.prepare(
        'INSERT INTO skill_learnings (skill_id, phase, approach, what_worked, what_failed, tips, context) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      getSkillLearnings: this._db.prepare('SELECT * FROM skill_learnings WHERE skill_id = ? ORDER BY created_at DESC'),
      getSkillTips: this._db.prepare("SELECT DISTINCT tips FROM skill_learnings WHERE skill_id = ? AND tips != ''"),
      getSkillAvoidances: this._db.prepare("SELECT DISTINCT what_failed FROM skill_learnings WHERE skill_id = ? AND what_failed != ''"),
      countSkillLearnings: this._db.prepare('SELECT COUNT(*) as cnt FROM skill_learnings WHERE skill_id = ?'),
      ftsSkillLearnings: this._db.prepare(
        'SELECT sl.* FROM skill_learnings sl JOIN skill_learnings_fts f ON sl.id = f.rowid WHERE skill_learnings_fts MATCH ? ORDER BY rank LIMIT ?',
      ),
      evictSkillLearnings: this._db.prepare('DELETE FROM skill_learnings WHERE id IN (SELECT id FROM skill_learnings ORDER BY created_at ASC LIMIT ?)'),

      addMemory: this._db.prepare('INSERT INTO memory_entries (target, content, tier, importance, half_life_days, last_accessed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      getMemories: this._db.prepare('SELECT * FROM memory_entries WHERE target = ? ORDER BY created_at DESC'),
      removeMemory: this._db.prepare('DELETE FROM memory_entries WHERE target = ? AND id = ?'),
      ftsMemory: this._db.prepare(
        'SELECT m.* FROM memory_entries m JOIN memory_fts f ON m.id = f.rowid WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?',
      ),
      memoryCharCount: this._db.prepare('SELECT COALESCE(SUM(LENGTH(content)), 0) as total FROM memory_entries WHERE target = ?'),
      verifyMemory: this._db.prepare('UPDATE memory_entries SET verified_at = ? WHERE id = ?'),
      getStaleMemories: this._db.prepare('SELECT * FROM memory_entries WHERE target = ? AND (verified_at = 0 OR verified_at < ?) ORDER BY updated_at ASC LIMIT ?'),
      markMemoriesStale: this._db.prepare('UPDATE memory_entries SET verified_at = 0 WHERE content LIKE ?'),

      setUserKey: this._db.prepare(
        'INSERT OR REPLACE INTO user_profile (key, value, updated_at) VALUES (?, ?, ?)',
      ),
      getUserKey: this._db.prepare('SELECT value FROM user_profile WHERE key = ?'),
      getAllUserProfile: this._db.prepare('SELECT key, value FROM user_profile'),
      deleteUserKey: this._db.prepare('DELETE FROM user_profile WHERE key = ?'),

      upsertAffinity: this._db.prepare(
        'INSERT OR REPLACE INTO affinity_records (agent_id, task_type, score, samples, total_score, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      getAllAffinities: this._db.prepare('SELECT * FROM affinity_records ORDER BY updated_at DESC'),
      countAffinities: this._db.prepare('SELECT COUNT(*) as cnt FROM affinity_records'),

      countAllSkillLearnings: this._db.prepare('SELECT COUNT(*) as cnt FROM skill_learnings'),
      countCausalChain: this._db.prepare('SELECT COUNT(*) as cnt FROM causal_chain'),
      getKnowledgeEvictionIds: this._db.prepare('SELECT id FROM knowledge ORDER BY updated_at ASC LIMIT ?'),
      getSkillLearningsEvictionIds: this._db.prepare('SELECT id FROM skill_learnings ORDER BY created_at ASC LIMIT ?'),
      evictSharedLearnings: this._db.prepare('DELETE FROM shared_learnings WHERE id IN (SELECT id FROM shared_learnings ORDER BY created_at ASC LIMIT ?)'),

      addCausalEntry: this._db.prepare(
        'INSERT INTO causal_chain (execution_id, skill_id, causal_id, parent_causal_id, data_json, interface_version, wal_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      evictCausalChain: this._db.prepare('DELETE FROM causal_chain WHERE id IN (SELECT id FROM causal_chain ORDER BY created_at ASC LIMIT ?)'),
      addSharedSkillLearning: this._db.prepare(
        'INSERT INTO shared_learnings (skill_id, agent_id, tips, avoidances, context, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      getSharedSkillLearnings: this._db.prepare('SELECT * FROM shared_learnings WHERE skill_id = ? ORDER BY id DESC'),
      countSharedLearnings: this._db.prepare('SELECT COUNT(*) as cnt FROM shared_learnings'),
    };
  }

  _runSchemaMigrations() {
    const migrations = [
      { column: 'updated_at', table: 'knowledge', type: 'INTEGER NOT NULL DEFAULT 0' },
      { column: 'updated_at', table: 'session_summaries', type: 'INTEGER NOT NULL DEFAULT 0' },
      { column: 'updated_at', table: 'user_profile', type: 'INTEGER NOT NULL DEFAULT 0' },
      { column: 'updated_at', table: 'affinity_records', type: 'INTEGER NOT NULL DEFAULT 0' },
      { column: 'updated_at', table: 'memory_entries', type: 'INTEGER NOT NULL DEFAULT 0' },
      { column: 'verified_at', table: 'memory_entries', type: 'INTEGER NOT NULL DEFAULT 0' },
    ];
    const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    const SAFE_TYPE_RE = /^[A-Za-z0-9_ ]+$/;
    for (const m of migrations) {
      try {
        if (!IDENTIFIER_RE.test(m.table) || !IDENTIFIER_RE.test(m.column)) {
          debug('SqliteStore', 'migration', 'Invalid identifier in migration: ' + m.table + '.' + m.column);
          continue;
        }
        if (!SAFE_TYPE_RE.test(m.type)) {
          debug('SqliteStore', 'migration', 'Invalid type in migration: ' + m.type);
          continue;
        }
        const cols = this._db.pragma('table_info(' + m.table + ')');
        const hasCol = cols.some(function(c) { return c.name === m.column; });
        if (!hasCol) {
          this._db.exec('ALTER TABLE ' + m.table + ' ADD COLUMN ' + m.column + ' ' + m.type);
          debug('SqliteStore', 'migration', 'Added column ' + m.column + ' to ' + m.table);
        }
      } catch (e) {
        debug('SqliteStore', 'migration', e && e.message ? e.message : String(e));
      }
    }
  }

  _migrateFromJson() {
    if (!this._db || !this._stmts) return;
    const knowledgePath = path.join(this._root, HARNESS_DIR, 'knowledge', 'knowledge.json');
    const knowledgeData = loadJsonSync(knowledgePath, sanitizeData);
    if (knowledgeData) {
      try {
        const entries = Array.isArray(knowledgeData) ? knowledgeData : (knowledgeData.entries ?? []);
        const count = this._stmts.countKnowledge.get()?.cnt ?? 0;
        if (count === 0 && entries.length > 0) {
          const insert = this._db.prepare(
            'INSERT INTO knowledge (category, title, content, tags, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          );
          this._db.transaction(() => {
            for (const e of entries.slice(0, MAX_KNOWLEDGE)) {
              insert.run(
                e.category || '', e.title || '', e.content || '',
                Array.isArray(e.tags) ? e.tags.join(',') : (e.tags || ''),
                e.source || '', e.createdAt ?? Date.now(), e.updatedAt ?? Date.now(),
              );
            }
          })();
          this.emit('migrated', { source: 'knowledge.json', count: entries.length });
        }
      } catch (err) { debug('SqliteStore', '', err); }
    }

    const learningsPath = path.join(this._root, HARNESS_DIR, 'skills-learned', 'learnings.json');
    const learningsData = loadJsonSync(learningsPath, sanitizeData);
    if (learningsData) {
      try {
        const entries = Array.isArray(learningsData) ? learningsData : (learningsData.entries ?? []);
        const count = this._db.prepare('SELECT COUNT(*) as cnt FROM skill_learnings').get()?.cnt ?? 0;
        if (count === 0 && entries.length > 0) {
          this._db.transaction(() => {
            for (const e of entries.slice(0, MAX_SKILL_LEARNINGS)) {
              this._stmts.addSkillLearning.run(
                e.skillId || '', e.phase || '', e.approach || '',
                e.whatWorked || '', e.whatFailed || '', e.tips || '', e.context || '',
              );
            }
          })();
          this.emit('migrated', { source: 'learnings.json', count: entries.length });
        }
      } catch (err) { debug('SqliteStore', '', err); }
    }
  }

  _insertWithFts(mainStmt, mainParams, ftsSql, ftsParams, eventName, eventPayload) {
    const r = this._executeWithRetry(() => {
      return this._db.transaction(() => {
        const res = mainStmt.run(...mainParams);
        this._db.prepare(ftsSql).run(res.lastInsertRowid, ...ftsParams);
        return res;
      })();
    });
    this.emit(eventName, { id: r.lastInsertRowid, ...eventPayload });
    return { success: true, id: r.lastInsertRowid, ...eventPayload };
  }

  _updateWithFts(id, mainStmt, mainParams, deleteFtsSql, insertFtsSql, insertFtsParams, eventName) {
    this._executeWithRetry(() => {
      this._db.transaction(() => {
        mainStmt.run(...mainParams);
        this._db.prepare(deleteFtsSql).run(id);
        this._db.prepare(insertFtsSql).run(id, ...insertFtsParams);
      })();
    });
    this.emit(eventName, { id });
    return true;
  }

  /**
   * 添加知识条目到知识库。自动维护FTS5索引和容量限制。
   * @param {Object} entry - 知识条目
   * @param {string} entry.category - 分类
   * @param {string} entry.title - 标题
   * @param {string} entry.content - 内容
   * @param {string|string[]} [entry.tags] - 标签
   * @param {string} [entry.source] - 来源
   * @returns {{ success: boolean, id: number, entry: Object }} 插入结果
   */
  addKnowledge(entry) {
    if (!entry || typeof entry !== 'object') {
      return { success: false, error: 'entry must be a non-null object' };
    }
    this._ensureActive();
    this._evictIfNeeded('knowledge', MAX_KNOWLEDGE);
    const now = unixNow();
    const tags = Array.isArray(entry.tags) ? entry.tags.join(',') : (entry.tags || '');
    return this._insertWithFts(
      this._stmts.addKnowledge,
      [entry.category || '', entry.title || '', entry.content || '', tags, entry.source || '', now, now],
      'INSERT INTO knowledge_fts(rowid, title, content, tags, category, source) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.title || '', entry.content || '', tags, entry.category || '', entry.source || ''],
      'knowledge-added', { entry },
    );
  }

  /**
   * 查询知识库。支持全文检索和模糊匹配，按filter.query决定检索方式。
   * @param {Object} [filter] - 查询过滤条件
   * @param {string} [filter.query] - 搜索关键词（优先FTS5全文检索，失败回退LIKE）
   * @param {string} [filter.category] - 分类前缀过滤
   * @param {string} [filter.tag] - 标签模糊匹配
   * @param {string} [filter.source] - 来源前缀过滤
   * @param {number} [filter.limit=50] - 返回条数上限
   * @returns {Object[]} 知识条目数组
   */
  queryKnowledge(filter) {
    if (!this._db) return [];
    const f = filter ?? {};
    if (f.query) {
      try {
        return this.ftsSearch('knowledge', f.query, f.limit ?? 50);
      } catch (err) {
        debug('SqliteStore', 'ftsSearch fallback', err);
        const escaped = _escapeLike(f.query);
        return this._stmts.queryKnowledge.all(
          `%${escaped}%`, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`, f.limit ?? 50,
        );
      }
    }
    const cat = f.category ? `${f.category}%` : '%';
    const tag = f.tag ? `%${f.tag}%` : '%';
    const src = f.source ? `${f.source}%` : '%';
    return this._stmts.queryKnowledge.all(cat, tag, src, '%', f.limit ?? 50);
  }

  /**
   * 全文检索。基于FTS5对指定表执行全文搜索，自动转义FTS操作符。
   * @param {string} table - 目标表名（knowledge/sessions/skill_learnings/memory）
   * @param {string} query - 搜索关键词
   * @param {number} [limit=20] - 返回条数上限
   * @returns {Object[]} 匹配的行数组
   */
  ftsSearch(table, query, limit) {
    const lim = limit ?? 20;
    const sanitized = query.replace(/[^\w\s\u4e00-\u9fff]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!sanitized) return [];
    const ftsOperators = /\b(AND|OR|NOT|NEAR)\b/gi;
    const escaped = sanitized.replace(ftsOperators, function(match) {
      return match.charAt(0).toLowerCase() + match.slice(1).toLowerCase();
    });
    const q = '"' + escaped + '"*';
    try {
      const ftsTable = FTS_TABLE_MAP[table];
      if (!ftsTable) return [];
      return this._db.prepare('SELECT * FROM ' + ftsTable + ' WHERE ' + ftsTable + ' MATCH ? LIMIT ?').all(q, lim);
    } catch (err) { debug('SqliteStore', '', err); return []; }
  }

  /**
   * 更新知识条目。同步更新FTS5索引，未提供的字段保留原值。
   * @param {number} id - 知识条目ID
   * @param {Object} updates - 更新字段
   * @param {string} [updates.title] - 新标题
   * @param {string} [updates.content] - 新内容
   * @param {string} [updates.tags] - 新标签
   * @param {string} [updates.category] - 新分类
   * @param {string} [updates.source] - 新来源
   * @returns {Object|null} 更新后的条目对象，ID不存在时返回null
   */
  updateKnowledge(id, updates) {
    if (!this._db) return null;
    const existing = this._stmts.getKnowledge.get(id);
    if (!existing) return null;
    const now = unixNow();
    const title = updates.title ?? existing.title;
    const content = updates.content ?? existing.content;
    const tags = updates.tags ?? existing.tags;
    const category = updates.category ?? existing.category;
    const source = updates.source ?? existing.source;
    this._updateWithFts(id,
      this._stmts.updateKnowledge, [category, title, content, tags, source, now, id],
      'DELETE FROM knowledge_fts WHERE rowid = ?',
      'INSERT INTO knowledge_fts(rowid, title, content, tags, category, source) VALUES (?, ?, ?, ?, ?, ?)',
      [title, content, tags, category, source],
      'knowledge-updated',
    );
    return { id, ...updates };
  }

  /**
   * 删除知识条目。同时清理FTS5索引。
   * @param {number} id - 知识条目ID
   * @returns {boolean} 是否成功删除
   */
  removeKnowledge(id) {
    if (!this._db) return false;
    this._db.transaction(() => {
      this._db.prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(id);
      this._stmts.deleteKnowledge.run(id);
    })();
    this.emit('knowledge-removed', { id });
    return true;
  }

  /**
   * 保存会话摘要。使用INSERT OR REPLACE语义，同步维护FTS5索引。
   * @param {string} sessionId - 会话ID
   * @param {Object} summary - 会话摘要
   * @param {string} [summary.phase] - 当前阶段
   * @param {string|string[]} [summary.completedSkills] - 已完成技能列表
   * @param {string} [summary.keyDecisions] - 关键决策
   * @param {string} [summary.lessonsLearned] - 经验教训
   * @returns {boolean} 是否保存成功
   */
  saveSessionSummary(sessionId, summary) {
    if (!this._db) return false;
    const now = unixNow();
    this._db.transaction(() => {
      this._stmts.saveSessionSummary.run(
        sessionId,
        summary.phase || '',
        Array.isArray(summary.completedSkills) ? summary.completedSkills.join(',') : (summary.completedSkills || ''),
        summary.keyDecisions || '',
        summary.lessonsLearned || '',
        now,
      );
      const row = this._stmts.getSessionSummary.get(sessionId);
      if (row) {
        this._db.prepare('DELETE FROM session_fts WHERE rowid = ?').run(row.id);
        this._db.prepare('INSERT INTO session_fts(rowid, session_id, phase, key_decisions, lessons_learned) VALUES (?, ?, ?, ?, ?)').run(
          row.id, sessionId, summary.phase || '', summary.keyDecisions || '', summary.lessonsLearned || '',
        );
      }
    })();
    this.emit('session-summary-saved', { sessionId });
    return true;
  }

  /**
   * 获取会话摘要。
   * @param {string} sessionId - 会话ID
   * @returns {Object|null} 会话摘要对象，不存在时返回null
   */
  getSessionSummary(sessionId) {
    if (!this._db) return null;
    return this._stmts.getSessionSummary.get(sessionId);
  }

  /**
   * 查询会话摘要。支持全文检索和模糊匹配。
   * @param {Object} [filter] - 查询过滤条件
   * @param {string} [filter.query] - 搜索关键词（优先FTS5全文检索，失败回退LIKE）
   * @param {number} [filter.limit=50] - 返回条数上限
   * @returns {Object[]} 会话摘要数组
   */
  querySummaries(filter) {
    if (!this._db) return [];
    const f = filter ?? {};
    if (f.query) {
      try {
        return this.ftsSearch('sessions', f.query, f.limit ?? 50);
      } catch (err) {
        debug('SqliteStore', 'querySummaries ftsSearch fallback', err);
        const escaped = _escapeLike(f.query);
        return this._stmts.querySummaries.all(
          `%${escaped}%`, `%${escaped}%`, `%${escaped}%`, f.limit ?? 50,
        );
      }
    }
    return this._stmts.querySummaries.all('%', '%', '%', f.limit ?? 50);
  }

  /**
   * 添加技能学习记录。自动维护FTS5索引和容量限制。
   * @param {Object} entry - 技能学习条目
   * @param {string} entry.skillId - 技能ID
   * @param {string} [entry.phase] - 执行阶段
   * @param {string} [entry.approach] - 采用方法
   * @param {string} [entry.whatWorked] - 有效做法
   * @param {string} [entry.whatFailed] - 失败做法
   * @param {string} [entry.tips] - 提示
   * @param {string} [entry.context] - 上下文
   * @returns {{ success: boolean, id: number, skillId: string }} 插入结果
   */
  addSkillLearning(entry) {
    if (!entry || typeof entry !== 'object') {
      return { success: false, id: 0, error: 'entry must be a non-null object' };
    }
    this._ensureActive();
    this._evictIfNeeded('skill_learnings', MAX_SKILL_LEARNINGS);
    return this._insertWithFts(
      this._stmts.addSkillLearning,
      [entry.skillId || '', entry.phase || '', entry.approach || '', entry.whatWorked || '', entry.whatFailed || '', entry.tips || '', entry.context || ''],
      'INSERT INTO skill_learnings_fts(rowid, skill_id, approach, what_worked, what_failed, tips) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.skillId || '', entry.approach || '', entry.whatWorked || '', entry.whatFailed || '', entry.tips || ''],
      'skill-learning-added', { skillId: entry.skillId },
    );
  }

  /**
   * 获取指定技能的学习记录，按创建时间倒序排列。
   * @param {string} skillId - 技能ID
   * @returns {Object[]} 学习记录数组
   */
  getSkillLearnings(skillId) {
    if (!this._db) return [];
    return this._stmts.getSkillLearnings.all(skillId);
  }

  /**
   * 获取指定技能的去重提示列表。
   * @param {string} skillId - 技能ID
   * @returns {string[]} 提示文本数组
   */
  getSkillTips(skillId) {
    if (!this._db) return [];
    return this._stmts.getSkillTips.all(skillId).map(r => r.tips);
  }

  /**
   * 获取指定技能的去重避坑记录列表。
   * @param {string} skillId - 技能ID
   * @returns {string[]} 失败做法文本数组
   */
  getSkillAvoidances(skillId) {
    if (!this._db) return [];
    return this._stmts.getSkillAvoidances.all(skillId).map(r => r.what_failed);
  }

  /**
   * 获取指定技能的学习记录数。
   * @param {string} skillId - 技能ID
   * @returns {number} 记录数量
   */
  getSkillLearningCount(skillId) {
    if (!this._db) return 0;
    const row = this._stmts.countSkillLearnings.get(skillId);
    return row ? row.cnt : 0;
  }

  /**
   * 添加共享技能学习记录。自动维护容量限制。
   * @param {Object} entry - 共享学习条目
   * @param {string} entry.skillId - 技能ID（必填）
   * @param {string} [entry.agentId] - Agent ID
   * @param {string} [entry.tips] - 提示
   * @param {string} [entry.avoidances] - 避坑记录
   * @param {string} [entry.context] - 上下文
   * @param {number} [entry.createdAt] - 创建时间戳
   * @returns {{ id: number, skillId: string }} 插入结果
   */
  addSharedSkillLearning(entry) {
    if (!entry || typeof entry !== 'object' || !entry.skillId) {
      return { success: false, id: 0, error: 'entry.skillId is required' };
    }
    this._evictIfNeeded('shared_learnings', MAX_SHARED_LEARNINGS);
    const r = this._executeWithRetry(() => this._stmts.addSharedSkillLearning.run(
      entry.skillId,
      entry.agentId || '',
      entry.tips || '',
      entry.avoidances || '',
      entry.context || '',
      entry.createdAt || unixNow(),
    ));
    this.emit('shared-learning-added', { id: r.lastInsertRowid, skillId: entry.skillId });
    return { id: r.lastInsertRowid, skillId: entry.skillId };
  }

  /**
   * 获取指定技能的共享学习记录，按ID倒序排列。
   * @param {string} skillId - 技能ID
   * @returns {Object[]} 共享学习记录数组
   */
  getSharedSkillLearnings(skillId) {
    return this._stmts.getSharedSkillLearnings.all(skillId);
  }

  /**
   * 添加记忆条目。自动维护FTS5索引和字符容量限制。
   * @param {string} [target='memory'] - 记忆目标（'memory'或'user'）
   * @param {string} content - 记忆内容
   * @param {Object} [options] - 可选参数
   * @param {string} [options.tier='episodic'] - 记忆层级（working/episodic/semantic）
   * @param {number} [options.importance=0.5] - 重要性评分
   * @param {number} [options.half_life_days=30] - 半衰期天数
   * @returns {{ success: boolean, id: number, target: string, content: string }} 插入结果
   */
  addMemory(target, content, options) {
    target = target ?? 'memory';
    if (!content || typeof content !== 'string') {
      return { success: false, error: 'content must be a non-empty string' };
    }
    this._ensureActive();
    if (content.length > MAX_SINGLE_CONTENT_LENGTH) {
      return { success: false, error: `Single content exceeds max length of ${MAX_SINGLE_CONTENT_LENGTH}` };
    }
    const limit = target === 'user' ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
    const charRow = this._stmts.memoryCharCount.get(target);
    const current = charRow ? charRow.total : 0;
    if (current + content.length > limit) {
      return { success: false, error: `${target} at ${current}/${limit} chars. Adding ${content.length} would exceed limit.`, current, limit };
    }
    const opts = options ?? {};
    const tier = opts.tier ?? 'episodic';
    const importance = Number.isFinite(opts.importance) ? opts.importance : 0.5;
    const halfLifeDays = Number.isFinite(opts.half_life_days) ? opts.half_life_days : 30;
    const now = Date.now();
    const r = this._insertWithFts(
      this._stmts.addMemory, [target, content, tier, importance, halfLifeDays, now, now, now],
      'INSERT INTO memory_fts(rowid, content) VALUES (?, ?)', [content],
      'memory-added', { target, content },
    );
    return r;
  }

  /**
   * 按ID获取记忆条目，同时递增访问计数和更新最后访问时间。
   * @param {number} id - 记忆条目ID
   * @returns {Object|null} 记忆条目对象，不存在时返回null
   */
  getMemoryById(id) {
    if (!this._db) return null;
    const row = this._db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id);
    if (!row) return null;
    this._db.prepare('UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?').run(Date.now(), id);
    return row;
  }

  /**
   * 提升记忆层级。仅允许从低层级向高层级提升（working→episodic→semantic）。
   * @param {number} id - 记忆条目ID
   * @param {string} toTier - 目标层级（working/episodic/semantic）
   * @returns {boolean} 是否提升成功
   */
  promoteMemory(id, toTier) {
    if (!this._db) return false;
    const entry = this._db.prepare('SELECT tier FROM memory_entries WHERE id = ?').get(id);
    if (!entry) return false;
    const tierOrder = ['working', 'episodic', 'semantic'];
    const fromIdx = tierOrder.indexOf(entry.tier);
    const toIdx = tierOrder.indexOf(toTier);
    if (toIdx <= fromIdx) return false;
    this._db.prepare('UPDATE memory_entries SET tier = ?, promoted_at = ? WHERE id = ?').run(toTier, Date.now(), id);
    return true;
  }

  /**
   * 降级记忆层级。仅允许从高层级向低层级降级（semantic→episodic→working）。
   * @param {number} id - 记忆条目ID
   * @param {string} toTier - 目标层级（working/episodic/semantic）
   * @returns {boolean} 是否降级成功
   */
  demoteMemory(id, toTier) {
    if (!this._db) return false;
    const entry = this._db.prepare('SELECT tier FROM memory_entries WHERE id = ?').get(id);
    if (!entry) return false;
    const tierOrder = ['working', 'episodic', 'semantic'];
    const fromIdx = tierOrder.indexOf(entry.tier);
    const toIdx = tierOrder.indexOf(toTier);
    if (toIdx >= fromIdx) return false;
    this._db.prepare('UPDATE memory_entries SET tier = ?, demoted_at = ? WHERE id = ?').run(toTier, Date.now(), id);
    return true;
  }

  /**
   * 过期记忆清理。删除指定层级中超过最大年龄的记忆条目。
   * @param {string} tier - 记忆层级
   * @param {number} maxAgeDays - 最大保留天数
   * @returns {number} 删除的记录数
   * @throws {Error} If the database operation fails
   */
  expireMemories(tier, maxAgeDays) {
    if (!this._db) return 0;
    if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) return 0;
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const result = this._db.prepare('DELETE FROM memory_entries WHERE tier = ? AND created_at < ?').run(tier, cutoff);
    return result.changes;
  }

  /**
   * 删除单条记忆。
   * @param {number} id - 记忆条目ID
   * @returns {boolean} 是否成功删除
   */
  forgetMemory(id) {
    if (!this._db) return false;
    const result = this._db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * 按层级获取记忆条目，按重要性降序、创建时间降序排列。
   * @param {string} tier - 记忆层级（working/episodic/semantic）
   * @returns {Object[]} 记忆条目数组
   */
  getMemoriesByTier(tier) {
    if (!this._db) return [];
    return this._db.prepare('SELECT * FROM memory_entries WHERE tier = ? ORDER BY importance DESC, created_at DESC').all(tier);
  }

  /**
   * 衰减记忆重要性。基于半衰期公式按时间衰减所有记忆条目的importance值，最低不低于0.01。
   * @returns {void}
   */
  decayMemoryImportance() {
    if (!this._db) return;
    try {
      this._db.exec(
        'UPDATE memory_entries SET importance = MAX(importance * pow(0.5, ' +
        '((strftime(\'%s\',\'now\') * 1000 - COALESCE(last_accessed_at, created_at, ' + Date.now() + ')) / 86400000.0) / ' +
        'COALESCE(half_life_days, 30)), 0.01)',
      );
    } catch (err) {
      debug('SqliteStore', 'decayMemoryError', err);
    }
  }

  /**
   * 获取目标记忆列表，按创建时间倒序排列。
   * @param {string} [target='memory'] - 记忆目标（'memory'或'user'）
   * @returns {Object[]} 记忆条目数组
   */
  getMemories(target) {
    if (!this._db) return [];
    return this._stmts.getMemories.all(target ?? 'memory');
  }

  /**
   * 删除记忆条目。同时清理FTS5索引。
   * @param {string} [target='memory'] - 记忆目标（'memory'或'user'）
   * @param {number} id - 记忆条目ID
   * @returns {boolean} 是否成功删除
   */
  removeMemory(target, id) {
    target = target ?? 'memory';
    if (!this._db) return false;
    this._db.transaction(() => {
      this._db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(id);
      this._stmts.removeMemory.run(target, id);
    })();
    this.emit('memory-removed', { target, id });
    return true;
  }

  /**
   * 搜索记忆。优先使用FTS5全文检索，失败回退到内容包含匹配。
   * @param {string} query - 搜索关键词
   * @param {number} [limit=20] - 返回条数上限
   * @returns {Object[]} 匹配的记忆条目数组
   */
  searchMemories(query, limit) {
    if (!this._db) return [];
    try {
      return this.ftsSearch('memory', query, limit ?? 20);
    } catch (err) {
      debug('SqliteStore', 'searchMemories fallback', err);
      return this.getMemories('memory').filter(m => m.content.includes(query));
    }
  }

  /**
   * 验证记忆条目。更新verified_at为当前时间戳。
   * @param {number} id - 记忆条目ID
   * @returns {boolean} 是否验证成功
   */
  verifyMemoryEntry(id) {
    if (!this._db) return false;
    const now = Date.now();
    this._stmts.verifyMemory.run(now, id);
    this.emit('memory-verified', { id, verifiedAt: now });
    return true;
  }

  /**
   * 获取过期记忆。返回验证时间早于截止时间或未验证的记忆条目。
   * @param {string} [target='memory'] - 记忆目标
   * @param {number} [maxAgeSeconds] - 最大验证年龄（秒），默认7天
   * @param {number} [limit=50] - 返回条数上限
   * @returns {Object[]} 过期记忆条目数组
   */
  getStaleMemories(target, maxAgeSeconds, limit) {
    const age = maxAgeSeconds ?? DEFAULT_KNOWLEDGE_MAX_AGE_SECONDS;
    const cutoff = Date.now() - age * 1000;
    return this._stmts.getStaleMemories.all(target ?? 'memory', cutoff, limit ?? 50);
  }

  /**
   * 按模式使记忆失效。将内容匹配LIKE模式的记忆条目的verified_at重置为0。
   * @param {string} pattern - 匹配模式（SQL LIKE语法，自动转义特殊字符）
   * @returns {number} 受影响的记录数
   */
  invalidateMemoriesByPattern(pattern) {
    const escaped = String(pattern).replace(/[%_\\]/g, '\\$&');
    const likePattern = `%${escaped}%`;
    const result = this._stmts.markMemoriesStale.run(likePattern);
    this.emit('memories-invalidated', { pattern, changes: result.changes });
    return result.changes;
  }

  /**
   * 获取记忆验证统计。返回总数、已验证数、过期数和验证率。
   * @returns {{ total: number, verified: number, stale: number, verificationRate: number }} 验证统计
   */
  getMemoryVerificationStats() {
    if (!this._db) return { total: 0, verified: 0, stale: 0, verificationRate: 100 };
    const total = this._db.prepare('SELECT COUNT(*) as cnt FROM memory_entries').get()?.cnt ?? 0;
    const staleCutoff = Date.now() - DEFAULT_KNOWLEDGE_MAX_AGE_SECONDS * 1000;
    const staleRow = this._db.prepare('SELECT COUNT(*) as cnt FROM memory_entries WHERE verified_at = 0 OR verified_at < ?').get(staleCutoff);
    const stale = staleRow ? staleRow.cnt : 0;
    const verified = total - stale;
    return { total, verified, stale, verificationRate: total > 0 ? Math.round(verified / total * 100) : 100 };
  }

  /**
   * 获取记忆使用量。返回字符总量、上限、使用百分比和条目数。
   * @param {string} [target='memory'] - 记忆目标（'memory'或'user'）
   * @returns {{ total: number, limit: number, percentage: number, entries: number }} 使用量统计
   */
  getMemoryUsage(target) {
    const rows = this._stmts.getMemories.all(target ?? 'memory');
    const total = rows.reduce((sum, r) => sum + r.content.length, 0);
    const limit = target === 'user' ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
    return { total, limit, percentage: limit > 0 ? Math.round(total / limit * 100) : 0, entries: rows.length };
  }

  /**
   * 设置用户偏好。非字符串值自动JSON序列化存储。
   * @param {string} key - 偏好键名
   * @param {string|*} value - 偏好值
   * @returns {boolean} 是否设置成功
   */
  setUserPreference(key, value) {
    if (!this._db) return false;
    const now = unixNow();
    this._stmts.setUserKey.run(key, typeof value === 'string' ? value : safeStringify(value), now);
    this.emit('user-preference-set', { key });
    return true;
  }

  /**
   * 获取用户偏好值。
   * @param {string} key - 偏好键名
   * @returns {string|null} 偏好值字符串，不存在时返回null
   */
  getUserPreference(key) {
    if (!this._db) return null;
    const r = this._stmts.getUserKey.get(key);
    return r ? r.value : null;
  }

  /**
   * 获取所有用户偏好键值对。
   * @returns {Array<{key: string, value: string}>} 偏好键值对数组
   */
  getAllUserPreferences() {
    if (!this._db) return [];
    return this._stmts.getAllUserProfile.all();
  }

  /**
   * 删除用户偏好。
   * @param {string} key - 偏好键名
   * @returns {boolean} 是否删除成功
   */
  removeUserPreference(key) {
    if (!this._db) return false;
    this._stmts.deleteUserKey.run(key);
    return true;
  }

  /**
   * 更新或插入亲和力记录。按agent_id+task_type唯一键UPSERT。
   * @param {string} agentId - Agent ID
   * @param {string} taskType - 任务类型
   * @param {Object} data - 亲和力数据
   * @param {number} [data.score=0.5] - 亲和力评分
   * @param {number} [data.samples=0] - 样本数
   * @param {number} [data.totalScore=0] - 总评分
   * @returns {boolean} 是否操作成功
   */
  upsertAffinity(agentId, taskType, data) {
    if (!this._db) return false;
    const now = unixNow();
    this._stmts.upsertAffinity.run(
      agentId, taskType, Number.isFinite(data.score) ? data.score : 0.5, Number.isFinite(data.samples) ? data.samples : 0, Number.isFinite(data.totalScore) ? data.totalScore : 0, now,
    );
    this.emit('affinity-upserted', { agentId, taskType });
    return true;
  }

  /**
   * 获取所有亲和力记录，按更新时间倒序排列。
   * @returns {Object[]} 亲和力记录数组
   */
  getAllAffinityRecords() {
    if (!this._db) return [];
    return this._stmts.getAllAffinities.all();
  }

  _evictIfNeeded(table, max) {
    this._db.transaction(() => {
      let count;
      if (table === 'knowledge') count = this._stmts.countKnowledge.get()?.cnt ?? 0;
      else if (table === 'skill_learnings') {
        count = this._stmts.countAllSkillLearnings.get()?.cnt ?? 0;
      } else if (table === 'causal_chain') {
        count = this._stmts.countCausalChain.get()?.cnt ?? 0;
      } else if (table === 'shared_learnings') {
        count = this._stmts.countSharedLearnings.get()?.cnt ?? 0;
      } else return;

      if (count >= max) {
        const evict = Math.floor(max * 0.1);
        if (table === 'knowledge') {
          const ids = this._stmts.getKnowledgeEvictionId.all(evict).map(r => r.id);
          for (const id of ids) {
            this._db.prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(id);
          }
          this._stmts.evictKnowledge.run(evict);
        } else if (table === 'skill_learnings') {
          const ids = this._stmts.getSkillLearningsEvictionIds.all(evict).map(r => r.id);
          for (const id of ids) {
            this._db.prepare('DELETE FROM skill_learnings_fts WHERE rowid = ?').run(id);
          }
          this._stmts.evictSkillLearnings.run(evict);
        } else if (table === 'causal_chain') {
          this._stmts.evictCausalChain.run(evict);
        } else if (table === 'shared_learnings') {
          this._stmts.evictSharedLearnings.run(evict);
        }
        this.emit('evicted', { table, count, evicted: evict });
      }
    })();
  }

  /**
   * 获取存储统计。返回各表记录数和记忆使用量。
   * @returns {{ knowledge: number, sessionSummaries: number, skillLearnings: number, sharedLearnings: number, memoryEntries: number, userProfileKeys: number, affinityRecords: number, memoryUsage: Object, userUsage: Object }} 存储统计
   */
  getStats() {
    if (!this._db) {
      return {
        knowledge: 0, sessionSummaries: 0, skillLearnings: 0,
        sharedLearnings: 0, memoryEntries: 0, userProfileKeys: 0,
        affinityRecords: 0, memoryUsage: { total: 0, limit: 0, percentage: 0, entries: 0 },
        userUsage: { total: 0, limit: 0, percentage: 0, entries: 0 },
      };
    }
    return {
      knowledge: this._stmts.countKnowledge.get()?.cnt ?? 0,
      sessionSummaries: this._db.prepare('SELECT COUNT(*) as cnt FROM session_summaries').get()?.cnt ?? 0,
      skillLearnings: this._db.prepare('SELECT COUNT(*) as cnt FROM skill_learnings').get()?.cnt ?? 0,
      sharedLearnings: this._stmts.countSharedLearnings.get()?.cnt ?? 0,
      memoryEntries: this._db.prepare('SELECT COUNT(*) as cnt FROM memory_entries').get()?.cnt ?? 0,
      userProfileKeys: this._db.prepare('SELECT COUNT(*) as cnt FROM user_profile').get()?.cnt ?? 0,
      affinityRecords: this._stmts.countAffinities.get()?.cnt ?? 0,
      memoryUsage: this.getMemoryUsage('memory'),
      userUsage: this.getMemoryUsage('user'),
    };
  }

  /**
   * 健康检查。判断数据库连接是否存活。
   * @returns {boolean} 数据库是否健康
   */
  isHealthy() {
    return this._db !== null;
  }

  _withDb(defaultReturn, fn) {
    if (!this._db) return defaultReturn;
    return fn();
  }

  /**
   * 获取原始数据库连接对象。
   * ⚠️ 警告：直接使用数据库连接可能绕过安全检查和容量限制，
   * 仅在需要执行自定义SQL或高级操作时使用，常规操作应使用SqliteStore提供的方法。
   * @returns {import('better-sqlite3').Database|null} 数据库连接对象，数据库未初始化或已关闭时返回null
   */
  getDb() {
    if (!this._db) return null;
    return this._db.getNative();
  }

  _ensureActive() {
    if (!this._db) {
      throw new DeepeningError('STORE_SHUTDOWN', 'SqliteStore has been shut down');
    }
  }

  /**
   * 持久化因果链条目。自动维护容量限制，失败时静默返回false。
   * @param {Object} entry - 因果链条目
   * @param {string} [entry.executionId] - 执行ID
   * @param {string} entry.skillId - 技能ID
   * @param {string} [entry.causalId] - 因果ID
   * @param {string} [entry.parentCausalId] - 父因果ID
   * @param {Object} [entry.data] - 因果数据
   * @param {number} [entry.interfaceVersion] - 接口版本
   * @param {number} [entry.walSeq] - WAL序列号
   * @param {number} [entry.timestamp] - 时间戳
   * @returns {boolean} 是否持久化成功
   */
  persistCausalEntry(entry) {
    return this._withDb(false, () => {
      try {
        this._evictIfNeeded('causal_chain', MAX_CAUSAL_CHAIN);
        this._executeWithRetry(() => {
          this._stmts.addCausalEntry.run(
            entry.executionId || '',
            entry.skillId || '',
            entry.causalId || '',
            entry.parentCausalId || '',
            JSON.stringify(entry.data ?? {}),
            entry.interfaceVersion ?? 0,
            entry.walSeq ?? 0,
            entry.timestamp ?? Date.now(),
          );
        });
        return true;
      } catch (err) {
        debug('SqliteStore', 'persistCausalEntry', err);
        return false;
      }
    });
  }

  _onShutdown() {
    if (this._db) {
      try { this._db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { debug('SqliteStore', 'walCheckpoint', e); }
      try {
        this._db.close();
      } catch (e) {
        debug('SqliteStore', 'closeOnError', e);
      }
      this._db = null;
    }
    this._stmts = {};
    for (const [key, instance] of _instanceRegistry) {
      if (instance === this) {
        _instanceRegistry.delete(key);
        break;
      }
    }
    this.removeAllListeners();
  }
}

/**
 * 清理已关闭或数据库连接已断开的孤立SqliteStore实例。遍历全局实例注册表，
 * 移除所有标记为已关闭或数据库连接为空的实例条目。
 * @returns {void}
 */
function cleanupOrphanedInstances() {
  const toDelete = [];
  for (const [key, instance] of _instanceRegistry) {
    if (instance._shutDown || !instance._db) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    _instanceRegistry.delete(key);
  }
}

const SqliteStoreWithShutdown = withShutdown(SqliteStore);
SqliteStoreWithShutdown.cleanupOrphanedInstances = cleanupOrphanedInstances;

module.exports = SqliteStoreWithShutdown;
