'use strict';

/** @module runtime/infrastructure/conversation-context-store
 * @description 对话上下文存储——多会话对话轮次持久化、自动压缩、摘要生成、FTS5全文搜索
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeCall, safeDateGetTime } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const { safeJsonParse, safeStringify } = require('../../utils/safe-parse');
const debug = require('../../utils/debug-logger')('ConversationContextStore');
const { generateId } = require('../../utils/unique-id');
const { ensureDirSync } = require('../../utils/fs-utils');
const { UTF8_ENCODING } = require('../../utils/constants');
const fs = require('fs');
const path = require('path');

const TURN_ROLES = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
  SYSTEM: 'system',
});

const MAX_TURNS_PER_SESSION = 500;
const MAX_SESSIONS = 100;
const MAX_SUMMARY_LENGTH = 2200;
const COMPRESSION_THRESHOLD = 200;

const VALID_ROLES = new Set(Object.values(TURN_ROLES));

const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_.-]{1,128}$/;

const CREATE_CONVERSATION_TABLES = [
  `CREATE TABLE IF NOT EXISTS conversation_turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    timestamp INTEGER NOT NULL DEFAULT 0,
    sequence INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_sessions (
    session_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER NOT NULL DEFAULT 0,
    turn_count INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    ended INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
    content,
    content='conversation_turns',
    content_rowid='rowid'
  )`,
  'CREATE INDEX IF NOT EXISTS idx_conv_turns_session ON conversation_turns(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_conv_turns_sequence ON conversation_turns(session_id, sequence)',
  'CREATE INDEX IF NOT EXISTS idx_conv_sessions_last_activity ON conversation_sessions(last_activity_at)',
];

const TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS conv_turns_ai AFTER INSERT ON conversation_turns BEGIN
    INSERT INTO conversation_turns_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS conv_turns_ad AFTER DELETE ON conversation_turns BEGIN
    INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS conv_turns_au AFTER UPDATE ON conversation_turns BEGIN
    INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
    INSERT INTO conversation_turns_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
  END`,
];

/**
 * @classdesc 对话上下文存储。多会话对话轮次持久化、自动压缩
 */
class ConversationContextStore extends EventEmitter {
  /**
   * 创建 ConversationContextStore 实例。
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.sqliteStore=null] - SQLite存储实例
   * @param {number} [options.maxTurnsPerSession] - 每个会话最大轮次数
   * @param {number} [options.maxSessions] - 最大会话数
   */
  constructor(options) {
    super();
    this._sqliteStore = (options && options.sqliteStore) ?? null;
    this._maxTurnsPerSession = (options && options.maxTurnsPerSession) ?? MAX_TURNS_PER_SESSION;
    this._maxSessions = (options && options.maxSessions) ?? MAX_SESSIONS;
    this._maxSummaryLength = (options && options.maxSummaryLength) ?? MAX_SUMMARY_LENGTH;
    this._compressionThreshold = (options && options.compressionThreshold) ?? COMPRESSION_THRESHOLD;
    this._persistencePath = (options && options.persistencePath) ?? '.harness/conversations/';
    this._sessions = new Map();
    this._activeSessionId = null;
    this._pinnedSessions = new Set();
    this._stats = {
      totalTurnsRecorded: 0,
      totalSessions: 0,
      totalSummariesGenerated: 0,
      totalTokensSaved: 0,
      compressionRatio: 0,
    };
    this._tablesInitialized = false;
    this._stmts = null;
    this._stmtCache = new Map();
    this._initShutdownState();
    if (this._sqliteStore) {
      const result = safeExecute(() => this._ensureTables(), 'ConversationContextStore', 'init-tables');
      if (result instanceof Promise) {
        result.catch(err => {
          debug('ConversationContextStore', 'init-tables-async', err && err.message ? err.message : String(err));
          this.emit('init-error', { phase: 'tables', error: err });
        });
      }
    }
  }

  /**
   * 附加SQLite存储实例。初始化数据库表并恢复历史会话数据。
   * @param {Object} store - SQLite存储实例，必须为非null对象
   * @throws {TypeError} store为null或非对象时抛出
   */
  attachSqliteStore(store) {
    this.guardShutdown();
    if (!store || typeof store !== 'object') {
      throw new TypeError('ConversationContextStore: store must be a non-null object');
    }
    this._sqliteStore = store;
    this._tablesInitialized = false;
    safeCall(() => this._ensureTables(), 'ConversationContextStore', 'attach-ensure-tables');
    this.emit('sqlite-attached', { timestamp: Date.now() });
  }

  /**
   * 启动或恢复会话。若会话已存在则恢复并更新元数据，否则创建新会话。
   * @param {string} sessionId - 会话ID，仅允许字母、数字、下划线、点、连字符
   * @param {Object} [metadata] - 会话元数据，将与已有元数据合并
   * @returns {{ sessionId: string, restored: boolean }} 会话信息，restored为true表示恢复已有会话
   * @throws {TypeError} sessionId为空或包含非法字符时抛出
   */
  startSession(sessionId, metadata) {
    this.guardShutdown();
    if (!sessionId || typeof sessionId !== 'string') {
      throw new TypeError('ConversationContextStore: sessionId must be a non-empty string');
    }
    if (!SAFE_SESSION_ID_RE.test(sessionId)) {
      throw new TypeError('ConversationContextStore: sessionId contains invalid characters');
    }
    const existing = this._sessions.get(sessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      if (metadata && typeof metadata === 'object') {
        safeAssign(existing.metadata, metadata);
      }
      this._activeSessionId = sessionId;
      this.emit('session-restored', { sessionId, timestamp: Date.now() });
      return { sessionId, restored: true };
    }
    const now = Date.now();
    const session = {
      turns: [],
      summary: null,
      startedAt: now,
      lastActivityAt: now,
      turnCount: 0,
      metadata: (metadata && typeof metadata === 'object') ? safeAssign({}, metadata) : {},
      ended: false,
    };
    this._sessions.set(sessionId, session);
    this._activeSessionId = sessionId;
    this._stats.totalSessions++;
    this._persistSessionMeta(sessionId, session);
    this.emit('session-started', { sessionId, timestamp: now });
    return { sessionId, restored: false };
  }

  /**
   * 记录对话轮次。将轮次添加到指定或当前活跃会话，超出上限时自动淘汰最早轮次。
   * @param {Object} turn - 对话轮次数据
   * @param {string} turn.role - 角色（user/assistant/tool/system）
   * @param {string} turn.content - 内容文本
   * @param {string} [turn.turnId] - 轮次ID，未提供时自动生成
   * @param {Object} [turn.metadata] - 轮次元数据
   * @param {string} [turn.type] - 轮次类型，将写入metadata.type
   * @param {string} [sessionId] - 目标会话ID，未提供时使用当前活跃会话
   * @returns {Object} 记录的轮次对象，包含turnId、role、content、timestamp、sequence、metadata
   * @throws {TypeError} turn格式无效或role不在合法范围内时抛出
   * @throws {Error} 无活跃会话或会话不存在时抛出
   */
  recordTurn(turn, sessionId) {
    this.guardShutdown();
    if (!turn || typeof turn !== 'object') {
      throw new TypeError('ConversationContextStore: turn must be a non-null object');
    }
    if (!turn.role || !VALID_ROLES.has(turn.role)) {
      throw new TypeError('ConversationContextStore: turn.role must be one of: ' + Array.from(VALID_ROLES).join(', '));
    }
    if (typeof turn.content !== 'string') {
      throw new TypeError('ConversationContextStore: turn.content must be a string');
    }
    const targetSessionId = sessionId || this._activeSessionId;
    if (!targetSessionId) {
      throw new Error('ConversationContextStore: no active session. Call startSession() first.');
    }
    const session = this._sessions.get(targetSessionId);
    if (!session) {
      throw new Error('ConversationContextStore: active session not found in store');
    }
    const now = Date.now();
    const turnRecord = {
      turnId: turn.turnId || generateId('turn-'),
      role: turn.role,
      content: turn.content,
      timestamp: now,
      sequence: session.turnCount + 1,
      metadata: (turn.metadata && typeof turn.metadata === 'object') ? safeAssign({}, turn.metadata) : {},
    };
    if (turn.type) {
      turnRecord.metadata.type = turn.type;
    }
    session.turns.push(turnRecord);
    session.turnCount++;
    session.lastActivityAt = now;
    this._evictOverflowTurns(session);
    this._persistTurn(targetSessionId, turnRecord);
    this._stats.totalTurnsRecorded++;
    if (session.turnCount >= this._compressionThreshold) {
      this.emit('compression-needed', {
        sessionId: targetSessionId,
        turnCount: session.turnCount,
        threshold: this._compressionThreshold,
      });
    }
    this.emit('turn-recorded', {
      sessionId: targetSessionId,
      turnId: turnRecord.turnId,
      role: turnRecord.role,
      sequence: turnRecord.sequence,
      timestamp: now,
    });
    return turnRecord;
  }

  _evictOverflowTurns(session) {
    while (session.turns.length > this._maxTurnsPerSession) {
      const removed = session.turns.shift();
      if (removed && removed.turnId && this._sqliteStore && this._sqliteStore._db) {
        try {
          const stmt = this._getOrPrepare('DELETE FROM conversation_turns WHERE turn_id = ?');
          if (stmt) stmt.run(removed.turnId);
        } catch (delErr) {
          debug('ConversationContextStore', 'deleteEvictedTurn', delErr && delErr.message ? delErr.message : String(delErr));
        }
      }
    }
  }

  /**
   * 记录工具调用。将工具名称、参数、结果和耗时封装为tool角色的轮次记录。
   * 参数超过1000字符、结果超过2000字符时自动截断。
   * @param {string} toolName - 工具名称
   * @param {string|*} params - 工具调用参数
   * @param {string|*} result - 工具调用结果
   * @param {number} [durationMs] - 调用耗时（毫秒）
   * @returns {Object} 记录的轮次对象
   * @throws {TypeError} toolName为空或非字符串时抛出
   */
  recordToolCall(toolName, params, result, durationMs) {
    this.guardShutdown();
    if (!toolName || typeof toolName !== 'string') {
      throw new TypeError('ConversationContextStore: toolName must be a non-empty string');
    }
    const truncatedParams = typeof params === 'string'
      ? (params.length > 1000 ? params.slice(0, 1000) + '...[truncated]' : params)
      : (params != null ? String(params).slice(0, 1000) : '');
    const truncatedResult = typeof result === 'string'
      ? (result.length > 2000 ? result.slice(0, 2000) + '...[truncated]' : result)
      : (result != null ? String(result).slice(0, 2000) : '');
    const content = JSON.stringify({
      toolName,
      params: truncatedParams,
      result: truncatedResult,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    });
    return this.recordTurn({
      role: TURN_ROLES.TOOL,
      content,
      metadata: { type: 'tool-call', toolName },
    });
  }

  /**
   * 结束当前活跃会话。设置会话为已结束状态，可选设置摘要，并清理超出上限的旧会话。
   * @param {string} [summary] - 会话摘要，超过最大长度时自动截断
   * @returns {{ sessionId: string, turnCount: number, summary: string }|null} 结束的会话信息，无活跃会话时返回null
   */
  endSession(summary) {
    this.guardShutdown();
    if (!this._activeSessionId) {
      return null;
    }
    const sessionId = this._activeSessionId;
    const session = this._sessions.get(sessionId);
    if (!session) {
      this._activeSessionId = null;
      return null;
    }
    session.ended = true;
    session.lastActivityAt = Date.now();
    if (summary && typeof summary === 'string') {
      session.summary = summary.length > this._maxSummaryLength
        ? summary.slice(0, this._maxSummaryLength)
        : summary;
    }
    this._persistSessionMeta(sessionId, session);
    this._activeSessionId = null;
    this._enforceMaxSessions();
    this.emit('session-ended', {
      sessionId,
      summary: session.summary,
      turnCount: session.turnCount,
      timestamp: Date.now(),
    });
    return { sessionId, turnCount: session.turnCount, summary: session.summary };
  }

  /**
   * 获取会话上下文。优先从内存中查找，未命中时从持久化存储加载。
   * @param {string} sessionId - 会话ID
   * @param {Object} [options] - 获取选项
   * @param {boolean} [options.includeTurns=true] - 是否包含轮次数据
   * @param {boolean} [options.includeSummary=true] - 是否包含摘要
   * @param {number} [options.maxTurns=50] - 返回的最大轮次数
   * @param {string} [options.format='compact'] - 轮次格式（'compact'或'full'）
   * @returns {Object|null} 会话上下文对象，包含sessionId、turnCount、startedAt、lastActivityAt等，会话不存在时返回null
   */
  getSessionContext(sessionId, options) {
    this.guardShutdown();
    if (!sessionId || typeof sessionId !== 'string') {
      return null;
    }
    if (!SAFE_SESSION_ID_RE.test(sessionId)) {
      return null;
    }
    const session = this._sessions.get(sessionId);
    if (!session) {
      return this._loadSessionFromStore(sessionId, options);
    }
    const opts = options ?? {};
    const includeTurns = opts.includeTurns !== false;
    const includeSummary = opts.includeSummary !== false;
    const maxTurns = opts.maxTurns ?? 50;
    const format = opts.format || 'compact';
    let turns = [];
    if (includeTurns) {
      if (format === 'full') {
        turns = session.turns.slice(-maxTurns);
      } else {
        const recentCount = Math.min(maxTurns, session.turns.length);
        turns = session.turns.slice(-recentCount);
      }
    }
    const result = {
      sessionId,
      turnCount: session.turnCount,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
    };
    if (includeSummary) {
      result.summary = session.summary;
    }
    if (includeTurns) {
      result.turns = turns;
    }
    return result;
  }

  /**
   * 获取会话摘要。若已有摘要则直接返回，否则根据轮次内容自动生成。
   * @param {string} sessionId - 会话ID
   * @returns {string|null} 会话摘要文本，会话不存在时返回null
   */
  getSessionSummary(sessionId) {
    this.guardShutdown();
    if (!sessionId || typeof sessionId !== 'string') {
      return null;
    }
    const session = this._sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (session.summary) {
      return session.summary;
    }
    return this._generateSummary(session);
  }

  /**
   * 搜索对话轮次。优先使用FTS5全文检索，无SQLite时回退到内存模糊匹配。
   * @param {string} query - 搜索关键词
   * @param {Object} [options] - 搜索选项
   * @param {number} [options.limit=20] - 返回条数上限
   * @param {number} [options.offset=0] - 偏移量
   * @param {string} [options.role] - 按角色过滤（user/assistant/tool/system）
   * @param {string} [options.sessionId] - 按会话ID过滤
   * @returns {Object[]} 匹配的轮次记录数组
   */
  searchTurns(query, options) {
    this.guardShutdown();
    if (!query || typeof query !== 'string') {
      return [];
    }
    const opts = options ?? {};
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const roleFilter = opts.role ?? null;
    const sessionIdFilter = opts.sessionId ?? null;
    if (this._sqliteStore && this._sqliteStore._db) {
      return this._searchTurnsSqlite(query, limit, offset, roleFilter, sessionIdFilter);
    }
    return this._searchTurnsMemory(query, limit, offset, roleFilter, sessionIdFilter);
  }

  /**
   * 置顶/取消置顶会话
   * @param {string} sessionId - 会话ID
   * @param {boolean} [pinned=true] - 是否置顶
   * @returns {boolean} 操作是否成功
   */
  pinSession(sessionId, pinned) {
    this.guardShutdown();
    if (!sessionId || typeof sessionId !== 'string') return false;
    const shouldPin = pinned !== false;
    if (shouldPin) {
      this._pinnedSessions.add(sessionId);
    } else {
      this._pinnedSessions.delete(sessionId);
    }
    this.emit('session-pinned', { sessionId, pinned: shouldPin });
    return true;
  }

  /**
   * 获取所有置顶会话ID
   * @returns {string[]}
   */
  getPinnedSessions() {
    this.guardShutdown();
    return Array.from(this._pinnedSessions);
  }

  /**
   * 检查会话是否已置顶
   * @param {string} sessionId
   * @returns {boolean}
   */
  isSessionPinned(sessionId) {
    return this._pinnedSessions.has(sessionId);
  }

  /**
   * 导出会话为指定格式
   * @param {string} sessionId - 会话ID
   * @param {Object} [options] - 导出选项
   * @param {string} [options.format='json'] - 导出格式：json/markdown
   * @param {boolean} [options.includeMetadata=true] - 是否包含元数据
   * @returns {string|null} 导出内容字符串，失败返回null
   */
  exportSession(sessionId, options) {
    this.guardShutdown();
    if (!sessionId || typeof sessionId !== 'string') return null;
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    const opts = options ?? {};
    const format = opts.format || 'json';
    const includeMetadata = opts.includeMetadata !== false;

    if (format === 'markdown') {
      return this._exportMarkdown(session, includeMetadata);
    }
    return this._exportJSON(session, includeMetadata);
  }

  _exportJSON(session, includeMetadata) {
    const data = {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      turnCount: session.turnCount,
    };
    if (includeMetadata) {
      data.metadata = session.metadata;
      data.summary = session.summary;
    }
    data.turns = session.turns.map(t => ({
      role: t.role,
      content: t.content,
      timestamp: t.timestamp,
    }));
    return safeStringify(data, null, 2);
  }

  _exportMarkdown(session, includeMetadata) {
    const lines = [];
    lines.push('# Conversation Export');
    lines.push('');
    lines.push('**Session ID**: ' + (session.sessionId || 'unknown'));
    lines.push('**Started**: ' + new Date(session.startedAt).toISOString());
    lines.push('**Last Activity**: ' + new Date(session.lastActivityAt).toISOString());
    lines.push('**Turns**: ' + session.turnCount);
    if (includeMetadata && session.summary) {
      lines.push('');
      lines.push('## Summary');
      lines.push(session.summary);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const turn of session.turns) {
      const ts = turn.timestamp ? new Date(safeDateGetTime(turn.timestamp) ?? Date.now()).toISOString() : '';
      lines.push('### ' + turn.role.toUpperCase() + (ts ? ' (' + ts + ')' : ''));
      lines.push('');
      lines.push(turn.content || '');
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * 压缩会话历史。将较早轮次合并为摘要，仅保留最近半数轮次，以节省Token消耗。
   * @param {string} sessionId - 会话ID
   * @returns {{ turnsRemoved: number, turnsKept: number, summaryLength: number, compressionRatio: number, tokensSaved: number }|null} 压缩结果，会话不存在或无轮次时返回null
   */
  compressSession(sessionId) {
    this.guardShutdown();
    if (!sessionId || typeof sessionId !== 'string') {
      return null;
    }
    const session = this._sessions.get(sessionId);
    if (!session || session.turns.length === 0) {
      return null;
    }
    const keepCount = Math.max(1, Math.floor(this._compressionThreshold / 2));
    if (session.turns.length <= keepCount) {
      return { turnsRemoved: 0, turnsKept: session.turns.length, summaryLength: 0, compressionRatio: 1 };
    }
    const olderTurns = session.turns.slice(0, session.turns.length - keepCount);
    const recentTurns = session.turns.slice(-keepCount);
    const summary = this._generateSummaryFromTurns(olderTurns);
    const truncatedSummary = summary.length > this._maxSummaryLength
      ? summary.slice(0, this._maxSummaryLength)
      : summary;
    const compressionTurn = {
      turnId: generateId('comp-'),
      role: TURN_ROLES.SYSTEM,
      content: truncatedSummary,
      timestamp: Date.now(),
      sequence: olderTurns[olderTurns.length - 1].sequence,
      metadata: { type: 'compression-summary', turnsCompressed: olderTurns.length },
    };
    const turnsRemoved = olderTurns.length;
    const originalTokenEstimate = olderTurns.reduce((sum, t) => sum + Math.ceil(t.content.length / 4), 0);
    const summaryTokenEstimate = Math.ceil(truncatedSummary.length / 4);
    const tokensSaved = Math.max(0, originalTokenEstimate - summaryTokenEstimate);
    this._stats.totalTokensSaved += tokensSaved;
    this._stats.totalSummariesGenerated++;
    const totalOriginal = this._stats.totalTurnsRecorded;
    const totalCompressed = this._stats.totalSummariesGenerated;
    this._stats.compressionRatio = totalOriginal > 0
      ? Number((totalCompressed / totalOriginal).toFixed(4))
      : 0;
    session.turns = [compressionTurn, ...recentTurns];
    session.summary = truncatedSummary;
    session.lastActivityAt = Date.now();
    this._deleteTurnsFromStore(sessionId, olderTurns);
    this._persistTurn(sessionId, compressionTurn);
    this._persistSessionMeta(sessionId, session);
    this.emit('session-compressed', {
      sessionId,
      turnsRemoved,
      turnsKept: recentTurns.length,
      summaryLength: truncatedSummary.length,
      compressionRatio: this._stats.compressionRatio,
      tokensSaved,
      timestamp: Date.now(),
    });
    return {
      turnsRemoved,
      turnsKept: recentTurns.length,
      summaryLength: truncatedSummary.length,
      compressionRatio: this._stats.compressionRatio,
      tokensSaved,
    };
  }

  /**
   * 获取活跃会话信息。返回当前活跃会话的摘要数据。
   * @returns {{ sessionId: string, turnCount: number, startedAt: number, lastActivityAt: number, summary: string|null, ended: boolean }|null} 活跃会话信息，无活跃会话时返回null
   */
  getActiveSession() {
    if (!this._activeSessionId) return null;
    const session = this._sessions.get(this._activeSessionId);
    if (!session) return null;
    return {
      sessionId: this._activeSessionId,
      turnCount: session.turnCount,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      summary: session.summary,
      ended: session.ended,
    };
  }

  /**
   * 获取活跃会话ID。
   * @returns {string|null} 当前活跃会话ID，无活跃会话时返回null
   */
  getActiveSessionId() {
    return this._activeSessionId ?? null;
  }

  /**
   * 列出所有会话。按最后活动时间倒序排列。
   * @returns {Array<{ sessionId: string, turnCount: number, startedAt: number, lastActivityAt: number, summary: string|null, ended: boolean }>} 会话信息数组
   */
  listSessions() {
    this.guardShutdown();
    const result = [];
    for (const [sessionId, session] of this._sessions) {
      result.push({
        sessionId,
        turnCount: session.turnCount,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        summary: session.summary || null,
        ended: session.ended ?? false,
      });
    }
    result.sort(function(a, b) { return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0); });
    return result;
  }

  /**
   * 获取统计信息。包含总轮次数、总会话数、摘要生成数、Token节省数和压缩比。
   * @returns {{ totalTurnsRecorded: number, totalSessions: number, totalSummariesGenerated: number, totalTokensSaved: number, compressionRatio: number }} 统计信息
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * 健康检查。判断实例是否未关闭。
   * @returns {boolean} 实例是否健康（未关闭）
   */
  isHealthy() {
    return !this._shutDown;
  }

  _onShutdown() {
    safeCall(() => this._persistAllSessions(), 'ConversationContextStore', 'shutdown-persist');
    if (this._stmts) {
      for (const key of Object.keys(this._stmts)) {
        try { this._stmts[key].finalize(); } catch (_e) { debug('finalize-stmt', _e && _e.message ? _e.message : String(_e)); }
      }
      this._stmts = null;
    }
    if (this._stmtCache) {
      for (const stmt of this._stmtCache.values()) {
        try { stmt.finalize(); } catch (_e) { debug('finalize-cache-stmt', _e && _e.message ? _e.message : String(_e)); }
      }
      this._stmtCache.clear();
    }
    if (this._sqliteStore && typeof this._sqliteStore.shutdown === 'function') {
      safeCall(() => this._sqliteStore.shutdown(), 'ConversationContextStore', 'shutdown-sqlite-store');
    }
    this._sessions.clear();
    this._activeSessionId = null;
    this._stats = {
      totalTurnsRecorded: 0,
      totalSessions: 0,
      totalSummariesGenerated: 0,
      totalTokensSaved: 0,
      compressionRatio: 0,
    };
    this._sqliteStore = null;
    this.removeAllListeners();
  }

  _ensureTables() {
    if (this._tablesInitialized) return;
    if (!this._sqliteStore || !this._sqliteStore._db) return;
    const db = this._sqliteStore._db;
    try {
      db.transaction(() => {
        for (const sql of CREATE_CONVERSATION_TABLES) {
          db.exec(sql);
        }
        for (const sql of TRIGGERS) {
          try { db.exec(sql); } catch (e) { debug('ensure-tables-trigger', e); }
        }
      })();
      this._tablesInitialized = true;
      this._prepareStatements(db);
      this._restoreFromSqlite();
    } catch (err) {
      debug('ensureTables', err);
    }
  }

  _prepareStatements(db) {
    this._stmts = {
      insertTurn: db.prepare('INSERT OR REPLACE INTO conversation_turns (turn_id, session_id, role, content, timestamp, sequence, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      insertSession: db.prepare('INSERT OR REPLACE INTO conversation_sessions (session_id, summary, started_at, last_activity_at, turn_count, metadata, ended) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      deleteTurn: db.prepare('DELETE FROM conversation_turns WHERE turn_id = ?'),
      deleteTurnsBySession: db.prepare('DELETE FROM conversation_turns WHERE session_id = ?'),
      deleteSession: db.prepare('DELETE FROM conversation_sessions WHERE session_id = ?'),
      selectSessions: db.prepare('SELECT * FROM conversation_sessions ORDER BY last_activity_at DESC LIMIT ?'),
      selectTurnsBySession: db.prepare('SELECT * FROM conversation_turns WHERE session_id = ? ORDER BY sequence ASC'),
      selectSessionById: db.prepare('SELECT * FROM conversation_sessions WHERE session_id = ?'),
      selectTurnsBySessionDesc: db.prepare('SELECT * FROM conversation_turns WHERE session_id = ? ORDER BY sequence DESC LIMIT ?'),
    };
  }

  /**
   * 获取或创建缓存的预处理语句。按SQL字符串缓存，避免重复编译。
   * @param {string} sql - SQL语句字符串
   * @returns {import('better-sqlite3').Statement} 缓存的预处理语句
   */
  _getOrPrepare(sql) {
    if (!this._sqliteStore || !this._sqliteStore._db) return null;
    const db = this._sqliteStore._db;
    let stmt = this._stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      this._stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  _persistTurn(sessionId, turn) {
    safeCall(() => {
      if (this._stmts) {
        this._stmts.insertTurn.run(
          turn.turnId,
          sessionId,
          turn.role,
          turn.content,
          turn.timestamp,
          turn.sequence,
          JSON.stringify(turn.metadata),
        );
      } else if (this._sqliteStore && this._sqliteStore._db) {
        const stmt = this._getOrPrepare('INSERT OR REPLACE INTO conversation_turns (turn_id, session_id, role, content, timestamp, sequence, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)');
        if (stmt) {
          stmt.run(
            turn.turnId,
            sessionId,
            turn.role,
            turn.content,
            turn.timestamp,
            turn.sequence,
            JSON.stringify(turn.metadata),
          );
        }
      } else {
        this._persistSessionToJson(sessionId);
      }
    }, 'ConversationContextStore', 'persist-turn');
  }

  _persistSessionMeta(sessionId, session) {
    safeCall(() => {
      if (this._stmts) {
        this._stmts.insertSession.run(
          sessionId,
          session.summary || '',
          session.startedAt,
          session.lastActivityAt,
          session.turnCount,
          safeStringify(session.metadata),
          session.ended ? 1 : 0,
        );
      } else if (this._sqliteStore && this._sqliteStore._db) {
        const stmt = this._getOrPrepare('INSERT OR REPLACE INTO conversation_sessions (session_id, summary, started_at, last_activity_at, turn_count, metadata, ended) VALUES (?, ?, ?, ?, ?, ?, ?)');
        if (stmt) {
          stmt.run(
            sessionId,
            session.summary || '',
            session.startedAt,
            session.lastActivityAt,
            session.turnCount,
            JSON.stringify(session.metadata),
            session.ended ? 1 : 0,
          );
        }
      } else {
        this._persistSessionToJson(sessionId);
      }
    }, 'ConversationContextStore', 'persist-session-meta');
  }

  _deleteTurnsFromStore(sessionId, turns) {
    safeCall(() => {
      if (!this._sqliteStore || !this._sqliteStore._db) return;
      if (this._stmts) {
        const db = this._sqliteStore._db;
        db.transaction(() => {
          for (const turn of turns) {
            this._stmts.deleteTurn.run(turn.turnId);
          }
        })();
      } else if (this._sqliteStore && this._sqliteStore._db) {
        const db = this._sqliteStore._db;
        const stmt = this._getOrPrepare('DELETE FROM conversation_turns WHERE turn_id = ?');
        db.transaction(() => {
          for (const turn of turns) {
            stmt.run(turn.turnId);
          }
        })();
      }
    }, 'ConversationContextStore', 'delete-turns');
  }

  _persistAllSessions() {
    for (const [sessionId, session] of this._sessions) {
      if (this._sqliteStore && this._sqliteStore._db) {
        this._persistSessionMeta(sessionId, session);
      } else {
        this._persistSessionToJson(sessionId);
      }
    }
  }

  _persistSessionToJson(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    const dir = path.resolve(this._persistencePath);
    ensureDirSync(dir);
    const filePath = path.join(dir, sessionId + '.json');
    try {
      const data = {
        sessionId,
        turns: session.turns,
        summary: session.summary,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        turnCount: session.turnCount,
        metadata: session.metadata,
        ended: session.ended,
      };
      try {
        const jsonStr = JSON.stringify(data);
        fs.writeFileSync(filePath, jsonStr, UTF8_ENCODING);
      } catch (_e) {
        debug('ConversationContextStore', 'persistSessionToJson', _e && _e.message ? _e.message : String(_e));
        this.emit('persist-error', { sessionId, error: _e });
      }
    } catch (err) {
      debug('persistSessionToJson', err);
    }
  }

  _restoreFromSqlite() {
    if (!this._sqliteStore || !this._sqliteStore._db) return;
    safeCall(() => {
      const _db = this._sqliteStore._db;
      const sessions = (this._stmts ? this._stmts.selectSessions : this._getOrPrepare('SELECT * FROM conversation_sessions ORDER BY last_activity_at DESC LIMIT ?')).all(this._maxSessions);
      for (const row of sessions) {
        if (this._sessions.has(row.session_id)) continue;
        const turns = (this._stmts ? this._stmts.selectTurnsBySession : this._getOrPrepare('SELECT * FROM conversation_turns WHERE session_id = ? ORDER BY sequence ASC')).all(row.session_id);
        const session = {
          turns: turns.map(t => ({
            turnId: t.turn_id,
            role: t.role,
            content: t.content,
            timestamp: t.timestamp,
            sequence: t.sequence,
            metadata: safeExecute(() => JSON.parse(t.metadata), 'ConversationContextStore', 'parse-turn-metadata', {}),
          })),
          summary: row.summary ?? null,
          startedAt: row.started_at,
          lastActivityAt: row.last_activity_at,
          turnCount: row.turn_count,
          metadata: safeExecute(() => JSON.parse(row.metadata), 'ConversationContextStore', 'parse-session-metadata', {}),
          ended: row.ended === 1,
        };
        this._sessions.set(row.session_id, session);
      }
    }, 'ConversationContextStore', 'restore-from-sqlite');
  }

  _loadSessionFromStore(sessionId, options) {
    if (this._sqliteStore && this._sqliteStore._db) {
      return safeExecute(() => {
        const _db = this._sqliteStore._db;
        const row = (this._stmts ? this._stmts.selectSessionById : this._getOrPrepare('SELECT * FROM conversation_sessions WHERE session_id = ?')).get(sessionId);
        if (!row) return null;
        const opts = options ?? {};
        const maxTurns = opts.maxTurns ?? 50;
        const includeTurns = opts.includeTurns !== false;
        const includeSummary = opts.includeSummary !== false;
        let turns = [];
        if (includeTurns) {
          turns = (this._stmts ? this._stmts.selectTurnsBySessionDesc : this._getOrPrepare('SELECT * FROM conversation_turns WHERE session_id = ? ORDER BY sequence DESC LIMIT ?')).all(sessionId, maxTurns);
          turns.reverse();
          turns = turns.map(t => ({
            turnId: t.turn_id,
            role: t.role,
            content: t.content,
            timestamp: t.timestamp,
            sequence: t.sequence,
            metadata: safeExecute(() => JSON.parse(t.metadata), 'ConversationContextStore', 'parse-turn-metadata', {}),
          }));
        }
        const result = {
          sessionId,
          turnCount: row.turn_count,
          startedAt: row.started_at,
          lastActivityAt: row.last_activity_at,
        };
        if (includeSummary) result.summary = row.summary ?? null;
        if (includeTurns) result.turns = turns;
        return result;
      }, 'ConversationContextStore', 'load-session-from-store', null);
    }
    return this._loadSessionFromJson(sessionId, options);
  }

  _loadSessionFromJson(sessionId, options) {
    if (!sessionId || typeof sessionId !== 'string' || !SAFE_SESSION_ID_RE.test(sessionId)) {
      return null;
    }
    const dir = path.resolve(this._persistencePath);
    const filePath = path.join(dir, sessionId + '.json');
    return safeExecute(() => {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, UTF8_ENCODING);
      const data = safeJsonParse(raw);
      const opts = options ?? {};
      const maxTurns = opts.maxTurns ?? 50;
      const includeTurns = opts.includeTurns !== false;
      const includeSummary = opts.includeSummary !== false;
      const result = {
        sessionId: data.sessionId,
        turnCount: data.turnCount,
        startedAt: data.startedAt,
        lastActivityAt: data.lastActivityAt,
      };
      if (includeSummary) result.summary = data.summary ?? null;
      if (includeTurns && data.turns) {
        result.turns = data.turns.slice(-maxTurns);
      }
      return result;
    }, 'ConversationContextStore', 'load-session-from-json', null);
  }

  _searchTurnsSqlite(query, limit, offset, roleFilter, sessionIdFilter) {
    return safeExecute(() => {
      const _db = this._sqliteStore._db;
      const sanitized = query.replace(/[^\w\s\u4e00-\u9fff]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!sanitized) return [];
      const ftsQuery = '"' + sanitized.replace(/\b(AND|OR|NOT|NEAR)\b/gi, m => m.charAt(0).toLowerCase() + m.slice(1)) + '"*';
      let sql = 'SELECT ct.* FROM conversation_turns ct JOIN conversation_turns_fts f ON ct.rowid = f.rowid WHERE conversation_turns_fts MATCH ?';
      const params = [ftsQuery];
      if (sessionIdFilter) {
        sql += ' AND ct.session_id = ?';
        params.push(sessionIdFilter);
      }
      if (roleFilter) {
        sql += ' AND ct.role = ?';
        params.push(roleFilter);
      }
      sql += ' ORDER BY ct.timestamp DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      const stmt = this._getOrPrepare(sql); const rows = stmt ? stmt.all(...params) : [];
      return rows.map(r => ({
        turnId: r.turn_id,
        sessionId: r.session_id,
        role: r.role,
        content: r.content,
        timestamp: r.timestamp,
        sequence: r.sequence,
        metadata: safeExecute(() => JSON.parse(r.metadata), 'ConversationContextStore', 'parse-search-metadata', {}),
      }));
    }, 'ConversationContextStore', 'search-turns-sqlite', []);
  }

  _searchTurnsMemory(query, limit, offset, roleFilter, sessionIdFilter) {
    const results = [];
    const lowerQuery = query.toLowerCase();
    for (const [sessionId, session] of this._sessions) {
      if (sessionIdFilter && sessionId !== sessionIdFilter) continue;
      for (const turn of session.turns) {
        if (roleFilter && turn.role !== roleFilter) continue;
        if ((turn.content || '').toLowerCase().includes(lowerQuery)) {
          results.push({ ...turn, sessionId });
        }
      }
    }
    results.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return results.slice(offset, offset + limit);
  }

  _generateSummary(session) {
    if (!session || session.turns.length === 0) return null;
    return this._generateSummaryFromTurns(session.turns);
  }

  _generateSummaryFromTurns(turns) {
    const topics = new Set();
    const decisions = [];
    const errors = [];
    const completed = [];
    const userPrefs = [];
    for (const turn of turns) {
      this._extractTopics(turn, topics, userPrefs);
      if (turn.role === TURN_ROLES.ASSISTANT) {
        this._extractAssistantContent(turn, decisions, completed);
      } else if (turn.role === TURN_ROLES.TOOL) {
        this._extractToolErrors(turn, errors);
      }
    }
    return this._assembleSummary(topics, decisions, errors, completed, userPrefs, turns.length);
  }

  _extractTopics(turn, topics, userPrefs) {
    if (turn.role !== TURN_ROLES.USER) return;
    const content = typeof turn.content === 'string' ? turn.content : '';
    if (!content) return;
    const words = content.split(/\s+/).filter(w => w.length > 4);
    for (const word of words.slice(0, 3)) {
      topics.add(word.toLowerCase());
    }
    if (content.toLowerCase().includes('prefer') || content.toLowerCase().includes('want')) {
      userPrefs.push(content.slice(0, 100));
    }
  }

  _extractAssistantContent(turn, decisions, completed) {
    const content = turn.content;
    if (content.toLowerCase().includes('decided') || content.toLowerCase().includes('decision')) {
      decisions.push(content.slice(0, 120));
    }
    if (content.toLowerCase().includes('completed') || content.toLowerCase().includes('done') || content.toLowerCase().includes('finished')) {
      completed.push(content.slice(0, 100));
    }
  }

  _extractToolErrors(turn, errors) {
    try {
      const parsed = safeJsonParse(turn.content);
      if (parsed.result && String(parsed.result).toLowerCase().includes('error')) {
        errors.push(parsed.toolName + ': ' + String(parsed.result).slice(0, 80));
      }
    } catch (_e) {
      if ((turn.content || '').toLowerCase().includes('error')) {
        errors.push((turn.content || '').slice(0, 100));
      }
    }
  }

  _assembleSummary(topics, decisions, errors, completed, userPrefs, totalTurns) {
    const parts = [];
    if (topics.size > 0) {
      parts.push('Topics: ' + Array.from(topics).slice(0, 10).join(', '));
    }
    if (decisions.length > 0) {
      parts.push('Decisions: ' + decisions.slice(0, 5).join('; '));
    }
    if (errors.length > 0) {
      parts.push('Errors: ' + errors.slice(0, 5).join('; '));
    }
    if (completed.length > 0) {
      parts.push('Completed: ' + completed.slice(0, 5).join('; '));
    }
    if (userPrefs.length > 0) {
      parts.push('Preferences: ' + userPrefs.slice(0, 3).join('; '));
    }
    const summary = parts.join('\n') || 'Session with ' + totalTurns + ' turns';
    return summary.length > this._maxSummaryLength
      ? summary.slice(0, this._maxSummaryLength)
      : summary;
  }

  _enforceMaxSessions() {
    if (this._sessions.size <= this._maxSessions) return;
    const endedSessions = [];
    for (const [id, session] of this._sessions) {
      if (session.ended && id !== this._activeSessionId) {
        endedSessions.push({ id, lastActivityAt: session.lastActivityAt });
      }
    }
    endedSessions.sort((a, b) => (a.lastActivityAt ?? 0) - (b.lastActivityAt ?? 0));
    const toEvict = this._sessions.size - this._maxSessions;
    for (let i = 0; i < Math.min(toEvict, endedSessions.length); i++) {
      const sessionId = endedSessions[i].id;
      this._sessions.delete(sessionId);
      this._deleteSessionFromStore(sessionId);
      this.emit('session-evicted', { sessionId, reason: 'max-sessions' });
    }
  }

  _deleteSessionFromStore(sessionId) {
    safeCall(() => {
      if (this._stmts) {
        const db = this._sqliteStore._db;
        db.transaction(() => {
          this._stmts.deleteTurnsBySession.run(sessionId);
          this._stmts.deleteSession.run(sessionId);
        })();
      } else if (this._sqliteStore && this._sqliteStore._db) {
        const db = this._sqliteStore._db;
        db.transaction(() => {
          const delTurnsStmt = this._getOrPrepare('DELETE FROM conversation_turns WHERE session_id = ?');
          const delSessionStmt = this._getOrPrepare('DELETE FROM conversation_sessions WHERE session_id = ?');
          if (delTurnsStmt) delTurnsStmt.run(sessionId);
          if (delSessionStmt) delSessionStmt.run(sessionId);
        })();
      } else {
        const dir = path.resolve(this._persistencePath);
        const filePath = path.join(dir, sessionId + '.json');
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (err) { debug('deleteSessionJson', err); }
      }
    }, 'ConversationContextStore', 'delete-session-from-store');
  }
}

const ConversationContextStoreWithShutdown = withShutdown(ConversationContextStore);

Object.assign(ConversationContextStoreWithShutdown, {
  TURN_ROLES,
  MAX_TURNS_PER_SESSION,
  MAX_SESSIONS,
  MAX_SUMMARY_LENGTH,
  COMPRESSION_THRESHOLD,
});

module.exports = ConversationContextStoreWithShutdown;
