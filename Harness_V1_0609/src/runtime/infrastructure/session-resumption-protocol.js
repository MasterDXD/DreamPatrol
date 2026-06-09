'use strict';

/** @module runtime/infrastructure/session-resumption-protocol
 * @deprecated 孤立模块 - 未被任何文件引用，计划在下一版本移除
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

const MAX_RESUMPTION_TOKENS = 4000;
const MAX_PREVIOUS_SESSIONS = 3;
const CONTEXT_SOURCES = Object.freeze({
  CONVERSATION: 'conversation',
  MEMORY: 'memory',
  DREAM: 'dream',
  SESSION: 'session',
});

const SECTION_HEADERS = [
  'Previous Session Summary',
  'Active Tasks',
  'Key Decisions',
  'Relevant Knowledge',
  'Recent Errors',
  'User Preferences',
];

function _estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4 + nonAscii / 2);
}

function _truncateToTokens(text, maxTokens) {
  if (!text) return '';
  const currentTokens = _estimateTokens(text);
  if (currentTokens <= maxTokens) return text;
  const ratio = currentTokens > 0 ? maxTokens / currentTokens : 1;
  const targetLen = Math.floor(text.length * ratio * 0.9);
  return text.slice(0, targetLen) + '...[truncated]';
}

/**
 * @classdesc 会话恢复协议。多源上下文提取、跨会话状态续接
 */
class SessionResumptionProtocol extends EventEmitter {
  /**
   * 创建 SessionResumptionProtocol 实例。
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.conversationStore=null] - 对话上下文存储实例
   * @param {Object} [options.memoryStore=null] - 记忆存储实例
   * @param {Object} [options.brainMemory=null] - 脑记忆实例
   * @param {Object} [options.dreamEngine=null] - 做梦引擎实例
   * @param {Object} [options.sessionManager=null] - 会话管理器实例
   */
  constructor(options) {
    super();
    this._conversationStore = (options && options.conversationStore) ?? null;
    this._memoryStore = (options && options.memoryStore) ?? null;
    this._brainMemory = (options && options.brainMemory) ?? null;
    this._dreamEngine = (options && options.dreamEngine) ?? null;
    this._sessionManager = (options && options.sessionManager) ?? null;
    this._maxResumptionTokens = options?.maxResumptionTokens ?? MAX_RESUMPTION_TOKENS;
    this._maxPreviousSessions = options?.maxPreviousSessions ?? MAX_PREVIOUS_SESSIONS;
    this._stats = {
      totalResumptions: 0,
      totalTokensInjected: 0,
      avgTokensPerResumption: 0,
      sourcesUsed: { conversation: 0, memory: 0, dream: 0, session: 0 },
    };
    this._initShutdownState();
  }

  attachMemoryStore(store) {
    this.guardShutdown();
    this._memoryStore = store;
    return this;
  }

  attachBrainMemory(bm) {
    this.guardShutdown();
    this._brainMemory = bm;
    return this;
  }

  attachDreamEngine(de) {
    this.guardShutdown();
    this._dreamEngine = de;
    return this;
  }

  attachSessionManager(sm) {
    this.guardShutdown();
    this._sessionManager = sm;
    return this;
  }

  /**
   * 构建会话恢复上下文。从对话、会话、记忆、做梦等多个来源收集上下文信息，
   * 按优先级组装并截断到最大token限制内。
   * @param {Object} [options] - 构建选项
   * @param {string} [options.sessionId] - 会话ID，用于查找对应会话上下文
   * @param {string} [options.taskHint] - 任务提示，用于记忆和做梦引擎的关联检索
   * @returns {Promise<{context: string|null, tokenEstimate: number, sources: string[], warnings: string[], error?: string}>} 恢复上下文结果
   */
  async buildResumptionContext(options) {
    this.guardShutdown();
    const opts = options ?? {};
    const sessionId = opts.sessionId;
    const taskHint = opts.taskHint;

    const sources = [];
    const warnings = [];
    const sections = {};

    const convData = await this._gatherConversationContext(sessionId);
    if (this._shutDown) return { context: null, error: 'Shut down during context build' };
    if (convData.content) {
      sections['Previous Session Summary'] = convData.content;
      sources.push(CONTEXT_SOURCES.CONVERSATION);
      this._stats.sourcesUsed.conversation++;
    }

    const sessionData = await this._gatherSessionContext();
    if (this._shutDown) return { context: null, error: 'Shut down during context build' };
    if (sessionData.content) {
      sections['Active Tasks'] = sessionData.tasks || '';
      sections['Key Decisions'] = sessionData.decisions || '';
      if (!sources.includes(CONTEXT_SOURCES.SESSION)) {
        sources.push(CONTEXT_SOURCES.SESSION);
        this._stats.sourcesUsed.session++;
      }
    }

    const memoryData = await this._gatherMemoryContext(taskHint);
    if (this._shutDown) return { context: null, error: 'Shut down during context build' };
    if (memoryData.content) {
      sections['Relevant Knowledge'] = memoryData.content;
      sources.push(CONTEXT_SOURCES.MEMORY);
      this._stats.sourcesUsed.memory++;
    }

    const dreamData = await this._gatherDreamContext(taskHint);
    if (this._shutDown) return { context: null, error: 'Shut down during context build' };
    if (dreamData.content) {
      sections['User Preferences'] = dreamData.content;
      sources.push(CONTEXT_SOURCES.DREAM);
      this._stats.sourcesUsed.dream++;
    }

    const errorData = this._gatherErrorContext(sessionId);
    if (errorData) {
      sections['Recent Errors'] = errorData;
    }

    let context = this._formatContext(sections);
    let tokenEstimate = _estimateTokens(context);

    if (tokenEstimate > this._maxResumptionTokens) {
      warnings.push('Context exceeded max tokens (' + tokenEstimate + '>' + this._maxResumptionTokens + '), truncating');
      debug('buildResumptionContext', 'truncating from ' + tokenEstimate + ' to ' + this._maxResumptionTokens + ' tokens');
      context = this._prioritizeAndTruncate(sections, this._maxResumptionTokens);
      tokenEstimate = _estimateTokens(context);
    }

    this._stats.totalResumptions++;
    this._stats.totalTokensInjected += tokenEstimate;
    this._stats.avgTokensPerResumption = this._stats.totalResumptions > 0 ? Math.round(this._stats.totalTokensInjected / this._stats.totalResumptions) : 0;

    this.emit('context-built', {
      sessionId,
      tokenEstimate,
      sources,
      warnings,
      timestamp: Date.now(),
    });

    return { context, tokenEstimate, sources, warnings };
  }

  /**
   * 注入恢复上下文到指定会话。将上下文作为系统消息写入会话存储，
   * 并标记为会话恢复类型。
   * @param {string} sessionId - 目标会话ID
   * @param {string} context - 要注入的恢复上下文内容
   * @returns {Promise<{sessionId: string, injected: boolean, error?: string}>} 注入结果
   * @throws {Error} conversationStore未附加时抛出
   */
  async injectResumptionContext(sessionId, context) {
    this.guardShutdown();
    if (!this._conversationStore) {
      throw new Error('SessionResumptionProtocol: conversationStore not attached');
    }
    this._conversationStore.startSession(sessionId, { resumption: true, previousContext: context });
    if (this._shutDown) return { injected: false, error: 'Shut down during injection' };

    this._conversationStore.recordTurn({
      role: 'system',
      content: context,
      metadata: { type: 'session-resumption', timestamp: Date.now() },
    });
    if (this._shutDown) return { injected: false, error: 'Shut down during injection' };

    this.emit('context-injected', {
      sessionId,
      tokenEstimate: _estimateTokens(context),
      timestamp: Date.now(),
    });

    return { sessionId, injected: true };
  }

  /**
   * 恢复指定会话。先构建恢复上下文，再将其注入到目标会话中，
   * 完成完整的会话恢复流程。
   * @param {string} sessionId - 要恢复的会话ID
   * @param {Object} [options] - 恢复选项，同 buildResumptionContext 的 options 参数
   * @returns {Promise<{sessionId: string, context: string, tokenEstimate: number, sources: string[], warnings: string[], resumed?: boolean, error?: string}>} 恢复结果
   */
  async resumeSession(sessionId, options) {
    this.guardShutdown();
    const { context, tokenEstimate, sources, warnings } = await this.buildResumptionContext(options);
    if (this._shutDown) return { resumed: false, error: 'Shut down during resume' };
    await this.injectResumptionContext(sessionId, context);
    if (this._shutDown) return { resumed: false, error: 'Shut down during resume' };
    return { sessionId, context, tokenEstimate, sources, warnings };
  }

  getStats() {
    return {
      totalResumptions: this._stats.totalResumptions,
      totalTokensInjected: this._stats.totalTokensInjected,
      avgTokensPerResumption: this._stats.avgTokensPerResumption,
      sourcesUsed: { ...this._stats.sourcesUsed },
    };
  }

  isHealthy() {
    return !this._shutDown;
  }

  _onShutdown() {
    safeCall(() => {
      debug('SessionResumptionProtocol', 'shutdown', 'totalResumptions=' + this._stats.totalResumptions);
    }, 'SessionResumptionProtocol', 'shutdown-debug');
    this._conversationStore = null;
    this._memoryStore = null;
    this._brainMemory = null;
    this._dreamEngine = null;
    this._sessionManager = null;
    this._stats = {
      totalResumptions: 0,
      totalTokensInjected: 0,
      avgTokensPerResumption: 0,
      sourcesUsed: { conversation: 0, memory: 0, dream: 0, session: 0 },
    };
    this.removeAllListeners();
  }

  async _gatherConversationContext(sessionId) {
    if (!this._conversationStore) return { content: '' };
    return safeExecute(async () => {
      const sessions = [];
      const active = this._conversationStore.getActiveSession();
      if (active && active.sessionId && active.sessionId !== sessionId) {
        const ctx = this._conversationStore.getSessionContext(active.sessionId, { includeTurns: true, maxTurns: 20 });
        if (ctx) sessions.push(ctx);
      }

      if (sessions.length === 0 && sessionId) {
        const ctx = this._conversationStore.getSessionContext(sessionId, { includeTurns: true, maxTurns: 20 });
        if (ctx) sessions.push(ctx);
      }

      if (sessions.length === 0) return { content: '' };

      const session = sessions[0];
      const summary = session.summary || this._conversationStore.getSessionSummary(session.sessionId) || '';
      if (summary) return { content: summary };

      if (session.turns && session.turns.length > 0) {
        const recentTurns = session.turns.slice(-10);
        const parts = recentTurns
          .filter(t => t.role === 'user' || t.role === 'assistant')
          .map(t => t.role + ': ' + t.content.slice(0, 200));
        return { content: parts.join('\n') };
      }

      return { content: '' };
    }, 'SessionResumptionProtocol', 'gather-conversation', { content: '' });
  }

  async _gatherSessionContext() {
    if (!this._sessionManager) return { content: '', tasks: '', decisions: '' };
    return safeExecute(async () => {
      const prev = await this._sessionManager.getPreviousSessionContext();
      if (!prev) return { content: '', tasks: '', decisions: '' };

      const tasks = prev.lastPhase ? 'Last phase: ' + prev.lastPhase : '';
      const decisions = Array.isArray(prev.keyDecisions) && prev.keyDecisions.length > 0
        ? prev.keyDecisions.join('; ')
        : '';
      const content = [tasks, decisions].filter(Boolean).join('\n');

      return { content, tasks, decisions };
    }, 'SessionResumptionProtocol', 'gather-session', { content: '', tasks: '', decisions: '' });
  }

  async _gatherMemoryContext(taskHint) {
    const store = this._memoryStore || this._brainMemory;
    if (!store) return { content: '' };
    return safeExecute(async () => {
      let memories = [];
      if (typeof store.recall === 'function') {
        memories = await store.recall(taskHint || '', { limit: 5 });
      } else if (typeof store.search === 'function') {
        memories = await store.search(taskHint || '', { limit: 5 });
      } else if (typeof store.query === 'function') {
        memories = await store.query(taskHint || '', { limit: 5 });
      }
      if (!Array.isArray(memories) || memories.length === 0) return { content: '' };
      const content = memories.slice(0, 5).map(m => {
        if (typeof m === 'string') return m;
        return m.content || m.text || m.value || JSON.stringify(m);
      }).join('\n');
      return { content };
    }, 'SessionResumptionProtocol', 'gather-memory', { content: '' });
  }

  async _gatherDreamContext(taskHint) {
    if (!this._dreamEngine) return { content: '' };
    return safeExecute(async () => {
      let notes = [];
      if (typeof this._dreamEngine.getRecentNotes === 'function') {
        notes = await this._dreamEngine.getRecentNotes({ limit: 5, query: taskHint });
      } else if (typeof this._dreamEngine.recall === 'function') {
        notes = await this._dreamEngine.recall(taskHint || '', { limit: 5 });
      }
      if (!Array.isArray(notes) || notes.length === 0) return { content: '' };
      const content = notes.slice(0, 5).map(n => {
        if (typeof n === 'string') return n;
        return n.content || n.text || n.summary || JSON.stringify(n);
      }).join('\n');
      return { content };
    }, 'SessionResumptionProtocol', 'gather-dream', { content: '' });
  }

  _gatherErrorContext(sessionId) {
    if (!this._conversationStore || !sessionId) return '';
    return safeExecute(() => {
      const ctx = this._conversationStore.getSessionContext(sessionId, { includeTurns: true, maxTurns: 50 });
      if (!ctx || !ctx.turns) return '';
      const errors = ctx.turns
        .filter(t => t.role === 'tool' && t.metadata && t.metadata.type === 'error')
        .slice(-5)
        .map(t => t.content.slice(0, 200));
      return errors.length > 0 ? errors.join('\n') : '';
    }, 'SessionResumptionProtocol', 'gather-errors', '');
  }

  _formatContext(sections) {
    const parts = ['[Session Resumption Context]'];
    for (const header of SECTION_HEADERS) {
      if (sections[header]) {
        parts.push(header + ': ' + sections[header]);
      }
    }
    return parts.join('\n');
  }

  _prioritizeAndTruncate(sections, maxTokens) {
    const headerOverhead = '[Session Resumption Context]\n'.length;
    let remaining = maxTokens - Math.ceil(headerOverhead / 4);
    const priorityOrder = [
      'Previous Session Summary',
      'Active Tasks',
      'Key Decisions',
      'Recent Errors',
      'Relevant Knowledge',
      'User Preferences',
    ];

    const result = {};
    for (const key of priorityOrder) {
      if (!sections[key]) continue;
      const headerTokenCost = Math.ceil((key + ': ').length / 4);
      const available = remaining - headerTokenCost;
      if (available <= 0) break;
      const sectionTokens = _estimateTokens(sections[key]);
      if (sectionTokens <= available) {
        result[key] = sections[key];
        remaining -= sectionTokens + headerTokenCost;
      } else {
        result[key] = _truncateToTokens(sections[key], available);
        remaining = 0;
        break;
      }
    }

    return this._formatContext(result);
  }
}

module.exports = withShutdown(SessionResumptionProtocol);

Object.assign(module.exports, {
  MAX_RESUMPTION_TOKENS,
  MAX_PREVIOUS_SESSIONS,
  CONTEXT_SOURCES,
});
