'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PHASES, PHASE_TRANSITIONS_SET, SESSION_ID_PATTERN, DEFAULT_TOKEN_BUDGET, TOKEN_BUDGET_WARNING_RATIO, TOKEN_BUDGET_DANGER_RATIO, SESSION_STATUS_ACTIVE, validateProjectRoot, DEFAULT_DEBOUNCE_MS, MS_PER_DAY, DEFAULT_SESSION_TTL_MIN_MS, getHarnessConfigPath, HARNESS_DIR, JSON_EXT } = require('../../utils/constants');
const { sanitizeObject } = require('../../utils/sanitizer');
const { SessionError } = require('../../errors');
const { sanitize: sanitizeData, writeAtomic } = require('../../utils/debounced-persister');
const { loadJsonSync, loadJsonAsync, readJsonDirSync, readJsonDirAsync } = require('../../utils/fs-utils');
const { debug } = require('../../utils/debug-logger');
const { mergeConfig } = require('../../utils/safe-assign');
const deepClone = require('../../utils/deep-clone');
const AR = require('../context/autoregressive-context-schema');
const { shortId } = require('../../utils/unique-id');
const { withShutdown } = require('../../utils/shutdown-mixin');
const KeyedDebouncer = require('../../utils/keyed-debouncer');
const { roundTo, emitError, safeCall } = require('../../utils/safe-execute');

const MAX_SESSIONS = 100;
const SESSION_TTL_MS = MS_PER_DAY;
const MAX_COMPLETED_SKILLS = 500;
const COMPLETED_SKILLS_TRIM_TO = 400;
const TTL_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const WATCHER_BASE_DELAY_MS = 5000;
const WATCHER_MAX_DELAY_MS = 120000;
function _cloneDeepeningState() { return { totalIterations: 0, totalDeepeningExecutions: 0, bestQualityScore: 0, convergenceHistory: [], agentAffinities: {} }; }

/**
 * @module runtime/session/session-manager
 * 会话状态管理器。跟踪当前阶段、已完成Skill、Token用量，
 * 持久化到.harness/sessions/，验证阶段转换合法性。
 * 继承EventEmitter，支持事件监听：phase-change、skill-complete、budget-warning、session-created。
 * 支持会话恢复（进程重启后从磁盘加载）和会话TTL过期。
 * @classdesc 会话状态管理。防抖持久化、TTL过期、阶段转换验证
 *
 * @example
 * const mgr = new SessionManager('/path/to/project');
 * mgr.on('phase-change', (evt) => { void evt; });
 * const session = mgr.create('my-session');
 * mgr.completeSkill('my-session', 'brainstorming');
 * mgr.advancePhase('my-session', 'architecture-design');
 */
class SessionManager extends EventEmitter {
  /**
   * @param {string} projectRoot - 项目根目录的绝对路径
   */
  constructor(projectRoot) {
    super();
    validateProjectRoot(projectRoot, 'SessionManager', SessionError);
    this.root = projectRoot;
    this._sessionsDir = path.join(this.root, HARNESS_DIR, 'sessions');
    /** @type {Object<string, Session>} */
    this.sessions = {};
    /** @private */
    this.config = this._loadConfig();
    /** @private */
    this._persistDebouncer = new KeyedDebouncer({ debounceMs: DEFAULT_DEBOUNCE_MS, label: 'SessionManager' });
    /** @private */
    this._evictInProgress = false;
    this._configWatcher = null;
    this._watcherRetryCount = 0;
    this._phaseContextInjector = null;
    this._causalDataBus = null;
    this._ttlCleanupTimer = setInterval(() => {
      try {
        if (!this.isHealthy()) return;
        const now = Date.now();
        for (const [id, session] of Object.entries(this.sessions)) {
          if (session && session.lastActivityAt) {
            const activityTime = new Date(session.lastActivityAt).getTime();
            if (!Number.isFinite(activityTime)) {
              delete this.sessions[id];
              this.emit('session-expired', { sessionId: id, age: NaN });
              continue;
            }
            const age = now - activityTime;
            if (age > (this.config.session_ttl_ms ?? SESSION_TTL_MS)) {
              this._persistDebouncer.delete(id);
              delete this.sessions[id];
              const filePath = path.join(this._sessionsDir, id + '.json');
              fs.promises.unlink(filePath).catch(function(err) {
                debug('SessionManager', 'ttlUnlink', 'Failed to delete session file: ' + id + ' - ' + (err && err.message ? err.message : String(err)));
              });
              this.emit('session-expired', { sessionId: id, age });
            }
          }
        }
      } catch (err) {
        debug('SessionManager', 'ttl-cleanup', 'Error: ' + err.message);
      }
    }, TTL_CLEANUP_INTERVAL_MS);
    if (this._ttlCleanupTimer && typeof this._ttlCleanupTimer.unref === 'function') this._ttlCleanupTimer.unref();
    this._watchConfig();
    this._restoreSessionsSync();
    this._readyPromise = Promise.resolve();
  }

  /**
   * 获取会话管理器初始化就绪的Promise
   * @returns {Promise<void>} 就绪Promise，resolve后表示异步恢复完成
   */
  get ready() {
    return this._readyPromise;
  }

  _restoreSessionsSync() {
    try {
      const entries = readJsonDirSync(this._sessionsDir, { logLabel: 'SessionManager' });
      for (const { data: session } of entries) {
        if (session && session.id && this._isValidRestorableSession(session)) {
          this.sessions[session.id] = session;
        }
      }
      const keys = Object.keys(this.sessions);
      if (keys.length > MAX_SESSIONS) {
        keys.sort((a, b) => {
          const ta = new Date(this.sessions[a].lastActivityAt || this.sessions[a].createdAt).getTime();
          const tb = new Date(this.sessions[b].lastActivityAt || this.sessions[b].createdAt).getTime();
          return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
        });
        const toRemove = keys.slice(0, keys.length - MAX_SESSIONS);
        for (const id of toRemove) {
          delete this.sessions[id];
        }
      }
      this.emit('sessions-restored', { count: Object.keys(this.sessions).length });
    } catch (err) {
      debug('SessionManager', '_restoreSessionsSync', err && err.message ? err.message : String(err));
    }
  }

  async _restoreSessionsAsync() {
    try {
      const sessionsDir = this._sessionsDir;
      await fs.promises.access(sessionsDir);
      const files = await fs.promises.readdir(sessionsDir);
      const jsonFiles = files.filter(f => f.endsWith(JSON_EXT));
      for (const file of jsonFiles) {
        try {
          const session = await loadJsonAsync(path.join(sessionsDir, file), sanitizeData);
          if (session && session.id) {
            const activityTime = new Date(session.lastActivityAt).getTime();
            if (Number.isFinite(activityTime) && (Date.now() - activityTime) <= SESSION_TTL_MS) {
              this._ensureSessionFieldTypes(session);
              this.sessions[session.id] = session;
            }
          }
        } catch (err) { debug('SessionManager', '_restoreSessionsAsync: skip', file, err && err.message ? err.message : String(err)); }
      }
      this.emit('sessions-restored', { count: Object.keys(this.sessions).length });
    } catch (err) {
      debug('SessionManager', '_restoreSessionsAsync: no sessions dir', err && err.message ? err.message : String(err));
    }
  }

  /**
   * 挂载阶段上下文注入器。注入器需实现injectForPhase方法，
   * 在阶段转换时自动注入与当前阶段相关的上下文信息。
   * @param {Object} injector - 阶段上下文注入器实例，需实现injectForPhase(phase, session)方法
   * @returns {SessionManager} this（链式调用）
   */
  attachPhaseContextInjector(injector) {
    this.guardShutdown();
    if (injector && typeof injector === 'object' && injector !== null && typeof injector.injectForPhase === 'function') {
      this._phaseContextInjector = injector;
    }
    return this;
  }

  /**
   * 挂载因果数据总线实例，用于Skill完成时发布因果输出事件
   * @param {Object} causalDataBus - 因果数据总线实例，需实现publishOutput方法
   * @returns {SessionManager} this（链式调用）
   */
  attachCausalDataBus(causalDataBus) {
    this.guardShutdown();
    if (causalDataBus && typeof causalDataBus.publishOutput === 'function') {
      this._causalDataBus = causalDataBus;
    }
    return this;
  }

  _watchConfig() {
    this._watcherRetryCount = 0;
    try {
      const configPath = getHarnessConfigPath(this.root);
      if (!fs.existsSync(configPath)) return;
      this._configDebounceTimer = null;
      this._configReloading = false;
      this._configWatcher = fs.watch(configPath, { persistent: false }, (eventType) => {
        if (eventType === 'change' || eventType === 'rename') {
          if (this._configDebounceTimer) clearTimeout(this._configDebounceTimer);
          this._configDebounceTimer = setTimeout(async () => {
            this._configDebounceTimer = null;
            if (this._configReloading) return;
            this._configReloading = true;
            try {
              try {
                await fs.promises.access(configPath);
              } catch (e) {
                debug('SessionManager', '_watchConfig:access', e && e.message ? e.message : String(e));
                return;
              }
              try {
                const newConfig = await this._loadConfigAsync();
                if (!newConfig || typeof newConfig !== 'object') return;
                if (typeof newConfig.token_budget === 'number' && newConfig.token_budget < 0) return;
                const oldPhaseBudget = JSON.stringify((this.config && this.config.phase_budget_allocation) ?? {});
                const newPhaseBudget = JSON.stringify(newConfig.phase_budget_allocation ?? {});
                this.config = newConfig;
                this.emit('config-reloaded', { config: newConfig });
                if (oldPhaseBudget !== newPhaseBudget) {
                  this.emit('budget-config-changed', { config: newConfig });
                }
              } catch (configErr) {
                debug('SessionManager', '_watchConfig:reload', configErr && configErr.message ? configErr.message : String(configErr));
              }
            } catch (err) {
              debug('SessionManager', '_watchConfig:unexpected', err && err.message ? err.message : String(err));
            } finally {
              this._configReloading = false;
            }
          }, 500);
          if (this._configDebounceTimer && typeof this._configDebounceTimer.unref === 'function') this._configDebounceTimer.unref();
        }
      });
      this._configWatcher.on('error', (err) => {
        debug('SessionManager', 'configWatcher', 'Watcher error: ' + (err && err.message ? err.message : String(err)));
        const oldWatcher = this._configWatcher;
        this._configWatcher = null;
        try { if (oldWatcher && typeof oldWatcher.close === 'function') oldWatcher.close(); } catch (closeErr) { debug('SessionManager', 'configWatcher', 'Close error: ' + (closeErr && closeErr.message ? closeErr.message : String(closeErr))); }
        this._watcherRetryCount = (this._watcherRetryCount ?? 0) + 1;
        if (this._watcherRetryCount > 10) {
          debug('SessionManager', 'configWatcher', 'Max watcher retry count reached, giving up');
          return;
        }
        const delay = Math.min(WATCHER_BASE_DELAY_MS * Math.pow(2, this._watcherRetryCount - 1), WATCHER_MAX_DELAY_MS);
        if (this._watcherRetryTimer) { clearTimeout(this._watcherRetryTimer); this._watcherRetryTimer = null; }
        this._watcherRetryTimer = setTimeout(() => {
          if (this.isHealthy() && !this._configWatcher) {
            this._watchConfig();
          }
        }, delay);
        if (this._watcherRetryTimer && typeof this._watcherRetryTimer.unref === 'function') this._watcherRetryTimer.unref();
      });
    } catch (e) { debug('SessionManager', 'constructor', 'Config watcher setup failed: ' + (e && e.message ? e.message : String(e))); }
  }

  /**
   * 创建新会话。
   * @param {string} sessionId - 会话ID，仅允许[a-zA-Z0-9_-]，最长64字符
   * @param {Object} [options] - 可选配置
   * @param {string} [options.agent] - 初始Agent角色ID
   * @returns {Session} 新创建的会话对象
   * @throws {Error} sessionId格式不合法时抛出
   * @example
   * const sm = new SessionManager(projectRoot);
   * const session = sm.create({
   *   agent: 'domain-analyst',
   *   task: 'Analyze requirements for auth module',
   *   budget: { maxTokens: 50000 }
   * });
   * console.log(session.id, session.status);
   */
  create(sessionId, options) {
    this.guardShutdown();
    const id = sessionId || SessionManager.generateSessionId();
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new SessionError('INVALID_SESSION_ID', `Invalid sessionId: must match ${SESSION_ID_PATTERN.source}`);
    }
    if (this.sessions[id]) {
      if (this.sessions[id]._restored) {
        debug('SessionManager', 'create', 'Replacing restored session: ' + id);
        delete this.sessions[id];
      } else {
        throw new SessionError('SESSION_EXISTS', `Session ${id} already exists`);
      }
    }

    const sessionKeys = Object.keys(this.sessions);
    if (sessionKeys.length >= MAX_SESSIONS) {
      if (this._evictInProgress) {
        throw new SessionError('EVICT_IN_PROGRESS', 'Session eviction in progress, retry later');
      }
      this._evictInProgress = true;
      try { this._evictOldest(); } finally { this._evictInProgress = false; }
    }

    const agent = (options && options.agent && typeof options.agent === 'string') ? options.agent : null;
    const session = {
      id: id,
      currentPhase: PHASES[0],
      completedSkills: [],
      tokensUsed: 0,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      agentHistory: agent ? [{ agentId: agent, action: 'session-created', timestamp: new Date().toISOString() }] : [],
      deepeningState: _cloneDeepeningState(),
      entropyState: { currentLevel: 'unknown', firstMessageRichness: null, convergenceTurns: 0 },
    };
    this.sessions[id] = session;
    this._persist(session, true);
    this.emit('session-created', { sessionId: id, session });
    return this.get(id);
  }

  /**
   * 获取指定会话。
   * @param {string} sessionId - 会话ID
   * @returns {Session|null} 会话对象，不存在则返回null
   */
  get(sessionId) {
    this.guardShutdown();
    const session = this.sessions[sessionId];
    if (!session) return null;
    return {
      id: session.id,
      currentPhase: session.currentPhase,
      completedSkills: session.completedSkills.slice(),
      tokensUsed: session.tokensUsed,
      status: session.status,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      agentHistory: session.agentHistory.slice(),
      metadata: mergeConfig(session.metadata),
      deepeningState: session.deepeningState ? deepClone(session.deepeningState) : null,
      entropyState: session.entropyState ? deepClone(session.entropyState) : null,
    };
  }

  /**
   * 记录Agent操作到会话历史。操作记录超过500条时自动裁剪至400条。
   * @param {string} sessionId - 会话ID
   * @param {string} agentId - 执行操作的Agent ID
   * @param {string} action - 操作描述
   * @returns {void}
   */
  recordAgentAction(sessionId, agentId, action) {
    this.guardShutdown();
    const session = this.sessions[sessionId];
    if (!session) return;
    session.agentHistory.push({ agentId, action, timestamp: new Date().toISOString() });
    if (session.agentHistory.length > 500) {
      session.agentHistory = session.agentHistory.slice(-400);
    }
    session.lastActivityAt = new Date().toISOString();
    this._persist(session);
  }

  /**
   * 更新会话熵状态。记录先验丰富度信息并触发entropy-updated事件。
   * @param {string} sessionId - 会话ID
   * @param {Object} priorRichness - 先验丰富度信息
   * @param {number} [priorRichness.score] - 丰富度评分
   * @param {string} [priorRichness.level] - 丰富度等级
   * @param {Array} [priorRichness.signals] - 信号列表
   * @returns {void}
   */
  updateEntropyState(sessionId, priorRichness) {
    this.guardShutdown();
    const session = this.sessions[sessionId];
    if (!session) return;

    if (!session.entropyState) {
      session.entropyState = { currentLevel: 'unknown', firstMessageRichness: null, convergenceTurns: 0 };
    }

    if (session.entropyState.firstMessageRichness === null && priorRichness && typeof priorRichness === 'object') {
      session.entropyState.firstMessageRichness = {
        score: priorRichness.score,
        level: priorRichness.level,
        signals: priorRichness.signals ? priorRichness.signals.slice() : [],
      };
      session.entropyState.currentLevel = priorRichness.level ?? 'unknown';
    } else if (session.entropyState.currentLevel !== 'low-entropy' && priorRichness && priorRichness.level === 'low-entropy') {
      session.entropyState.convergenceTurns++;
      session.entropyState.currentLevel = 'low-entropy';
    } else if (priorRichness && priorRichness.level) {
      session.entropyState.currentLevel = priorRichness.level;
    }

    this._persist(session, false);
    this.emit('entropy-updated', { sessionId, level: session.entropyState.currentLevel });
  }

  /**
   * 记录深化推理迭代信息。更新迭代计数、最佳质量分数和收敛历史。
   * @param {string} sessionId - 会话ID
   * @param {Object} [data] - 迭代数据
   * @param {number} [data.qualityScore] - 当前迭代的质量分数
   * @returns {Object|null} 更新后的Session快照，会话不存在时返回null
   */
  recordDeepeningIteration(sessionId, data) {
    this.guardShutdown();
    const session = this.sessions[sessionId];
    if (!session) return null;
    if (!session.deepeningState) {
      session.deepeningState = _cloneDeepeningState();
    }
    session.deepeningState.totalIterations++;
    session.deepeningState.totalDeepeningExecutions++;
    if (data && typeof data.qualityScore === 'number' && Number.isFinite(data.qualityScore)) {
      session.deepeningState.bestQualityScore = Math.max(session.deepeningState.bestQualityScore, data.qualityScore);
      if (Array.isArray(session.deepeningState.convergenceHistory)) {
        session.deepeningState.convergenceHistory.push({ qualityScore: data.qualityScore, timestamp: new Date().toISOString() });
        if (session.deepeningState.convergenceHistory.length > 200) {
          session.deepeningState.convergenceHistory = session.deepeningState.convergenceHistory.slice(-150);
        }
      }
    }
    session.lastActivityAt = new Date().toISOString();
    this._persist(session);
    return this.get(sessionId);
  }

  /**
   * 获取指定会话的深化推理状态快照
   * @param {string} sessionId - 会话ID
   * @returns {Object|null} 深化状态对象的浅拷贝，会话不存在或无深化状态时返回null
   */
  getDeepeningState(sessionId) {
    this.guardShutdown();
    const session = this.sessions[sessionId];
    if (!session || !session.deepeningState) return null;
    return deepClone(session.deepeningState);
  }

  /**
   * 记录深化推理收敛事件，更新最佳质量分数和收敛历史
   * @param {string} sessionId - 会话ID
   * @param {Object} [data] - 收敛数据
   * @param {boolean} [data.converged] - 是否已收敛
   * @param {string} [data.reason] - 收敛/未收敛原因
   * @param {number} [data.qualityScore] - 当前质量分数
   * @param {number} [data.iterations] - 迭代次数
   * @returns {void}
   */
  recordDeepeningConvergence(sessionId, data) {
    this.guardShutdown();
    const session = this.sessions[sessionId];
    if (!session) return;
    if (!session.deepeningState) {
      session.deepeningState = _cloneDeepeningState();
    }
    session.deepeningState.totalDeepeningExecutions++;
    if (data && data.qualityScore !== undefined && Number.isFinite(data.qualityScore)) {
      session.deepeningState.bestQualityScore = Math.max(session.deepeningState.bestQualityScore, data.qualityScore);
    }
    if (Array.isArray(session.deepeningState.convergenceHistory)) {
      session.deepeningState.convergenceHistory.push({
        converged: data && data.converged,
        reason: data && data.reason,
        qualityScore: data && data.qualityScore,
        iterations: data && data.iterations,
        timestamp: new Date().toISOString(),
      });
      if (session.deepeningState.convergenceHistory.length > 200) {
        session.deepeningState.convergenceHistory = session.deepeningState.convergenceHistory.slice(-150);
      }
    }
    session.lastActivityAt = new Date().toISOString();
    this._persist(session);
  }

  /**
   * 推进会话到新阶段。仅允许合法的阶段转换。
   * @param {string} sessionId - 会话ID
   * @param {string} newPhase - 目标阶段
   * @returns {Session} 更新后的会话对象
   * @throws {SessionError} 会话不存在或阶段转换不合法时抛出
   */
  advancePhase(sessionId, newPhase) {
    this.guardShutdown();
    const session = this.sessions[sessionId];
    if (!session) throw new SessionError('SESSION_NOT_FOUND', `Session ${sessionId} not found`);

    if (newPhase === session.currentPhase) {
      return this.get(sessionId);
    }

    const allowed = PHASE_TRANSITIONS_SET[session.currentPhase];
    if (!allowed || !allowed.has(newPhase)) {
      throw new SessionError('INVALID_PHASE_TRANSITION', `Invalid phase transition: ${session.currentPhase} → ${newPhase}`);
    }

    const oldPhase = session.currentPhase;
    session.currentPhase = newPhase;
    session.lastActivityAt = new Date().toISOString();
    this._persist(session, true);
    this.emit('phase-change', { sessionId, from: oldPhase, to: newPhase });

    safeCall(() => {
      if (!session._arContext) session._arContext = {};
      AR.inject(session._arContext, {
        [AR.FIELDS.PREVIOUS_RESULT]: oldPhase,
        [AR.FIELDS.ITERATION]: session.completedSkills ? session.completedSkills.length : 0,
        [AR.FIELDS.SOURCE]: 'phase-change',
      });
    }, 'SessionManager', 'phaseChangeAR');

    if (this._phaseContextInjector && oldPhase !== newPhase) {
      safeCall(() => this._phaseContextInjector.injectForPhase(newPhase), 'SessionManager', 'phaseContextInject');
    }
    return this.get(sessionId);
  }

  /**
   * 记录已完成的Skill。
   * @param {string} sessionId - 会话ID
   * @param {string} skillId - 已完成的Skill ID
   * @returns {Session} 更新后的会话对象
   * @throws {Error} 会话不存在时抛出
   */
  completeSkill(sessionId, skillId) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') {
      throw new SessionError('INVALID_INPUT', 'skillId must be a non-empty string');
    }
    const session = this.sessions[sessionId];
    if (!session) throw new SessionError('SESSION_NOT_FOUND', `Session ${sessionId} not found`);

    if (!session.completedSkills.includes(skillId)) {
      session.completedSkills.push(skillId);
      if (session.completedSkills.length > MAX_COMPLETED_SKILLS) {
        session.completedSkills = session.completedSkills.slice(-COMPLETED_SKILLS_TRIM_TO);
      }
    }
    session.lastActivityAt = new Date().toISOString();
    this._persist(session, true);
    this.emit('skill-complete', { sessionId, skillId });
    this._injectSkillCompleteAR(session, skillId);
    this._publishCausalOutput(skillId, session);
    return this.get(sessionId);
  }

  _publishCausalOutput(skillId, session) {
    if (!this.isHealthy()) return;
    if (!this._causalDataBus) return;
    this._causalDataBus.publishOutput(skillId, {
      sessionId: session.id,
      phase: session.currentPhase,
      completedAt: new Date().toISOString(),
      totalCompletedSkills: session.completedSkills.length,
    }).catch(function(err) {
      debug('SessionManager', 'causalPublish', err && err.message ? err.message : String(err));
    });
  }

  _injectSkillCompleteAR(session, skillId) {
    safeCall(() => {
      if (!session._arContext) session._arContext = {};
      AR.inject(session._arContext, {
        [AR.FIELDS.PREVIOUS_RESULT]: skillId,
        [AR.FIELDS.ITERATION]: session.completedSkills.length,
        [AR.FIELDS.SOURCE]: AR.SOURCE_IDS.SKILL_COMPLETE,
      });
    }, 'SessionManager', 'arInject');
  }

  /**
   * 增加Token使用量。
   * @param {string} sessionId - 会话ID
   * @param {number} tokens - 增加的Token数量（必须为非负有限数）
   * @throws {Error} 会话不存在或tokens无效时抛出
   */
  addTokenUsage(sessionId, tokens) {
    this.guardShutdown();
    const session = this.sessions[sessionId];
    if (!session) throw new SessionError('SESSION_NOT_FOUND', `Session ${sessionId} not found`);

    const numTokens = Number(tokens);
    if (!Number.isFinite(numTokens) || numTokens < 0) {
      throw new SessionError('INVALID_TOKEN_USAGE', 'tokens must be a non-negative finite number');
    }

    session.tokensUsed += numTokens;
    session.lastActivityAt = new Date().toISOString();
    this._persist(session);

    const budget = this.checkBudget(sessionId);
    if (budget.warning80 || budget.warning95 || budget.exhausted) {
      this.emit('budget-warning', { sessionId, tokensUsed: session.tokensUsed, budget });
    }
  }

  /**
   * 检查Token预算使用情况。
   * @param {string} sessionId - 会话ID
   * @returns {BudgetStatus} 预算状态
   */
  checkBudget(sessionId) {
    this.guardShutdown();
    const session = this.sessions[sessionId];
    if (!session) {
      return { warning80: false, warning95: false, exhausted: false, ratio: 0, sessionNotFound: true };
    }

    const budget = this.config.token_budget ?? DEFAULT_TOKEN_BUDGET;
    const ratio = budget > 0 ? session.tokensUsed / budget : 0;

    return {
      warning80: ratio >= TOKEN_BUDGET_WARNING_RATIO,
      warning95: ratio >= TOKEN_BUDGET_DANGER_RATIO,
      exhausted: ratio >= 1.0,
      ratio: roundTo(ratio, 2),
    };
  }

  /** @private */
  async _loadConfigWith(loader) {
    try {
      const configPath = getHarnessConfigPath(this.root);
      const raw = await loader(configPath, sanitizeData);
      if (raw) {
        if (raw.token_budget !== undefined) {
          raw.token_budget = Number.isFinite(Number(raw.token_budget)) ? Math.max(0, Math.floor(Number(raw.token_budget))) : 0;
        }
        if (raw.max_sessions !== undefined) {
          raw.max_sessions = (raw.max_sessions !== '' && Number.isFinite(Number(raw.max_sessions))) ? Math.max(1, Math.min(1000, Math.floor(Number(raw.max_sessions)))) : 100;
        }
        if (raw.session_ttl_ms !== undefined) {
          raw.session_ttl_ms = Number.isFinite(Number(raw.session_ttl_ms)) ? Math.max(DEFAULT_SESSION_TTL_MIN_MS, Math.floor(Number(raw.session_ttl_ms))) : SESSION_TTL_MS;
        }
        return raw;
      }
    } catch (err) {
      debug('SessionManager', '_loadConfig', err);
    }
    return {};
  }

  _loadConfig() {
    try {
      const configPath = getHarnessConfigPath(this.root);
      const raw = loadJsonSync(configPath, sanitizeData);
      if (raw) {
        if (raw.token_budget !== undefined) {
          raw.token_budget = Number.isFinite(Number(raw.token_budget)) ? Math.max(0, Math.floor(Number(raw.token_budget))) : 0;
        }
        if (raw.max_sessions !== undefined) {
          raw.max_sessions = (raw.max_sessions !== '' && Number.isFinite(Number(raw.max_sessions))) ? Math.max(1, Math.min(1000, Math.floor(Number(raw.max_sessions)))) : 100;
        }
        if (raw.session_ttl_ms !== undefined) {
          raw.session_ttl_ms = Number.isFinite(Number(raw.session_ttl_ms)) ? Math.max(DEFAULT_SESSION_TTL_MIN_MS, Math.floor(Number(raw.session_ttl_ms))) : SESSION_TTL_MS;
        }
        return raw;
      }
    } catch (err) {
      debug('SessionManager', '_loadConfig', err);
    }
    return {};
  }

  async _loadConfigAsync() {
    return this._loadConfigWith(loadJsonAsync);
  }

  /** @private */
  _sanitizeSession(session, depth) {
    return sanitizeObject(session, depth);
  }

  _isValidRestorableSession(session) {
    if (!session.id || session.status !== SESSION_STATUS_ACTIVE) return false;
    if (this._isTestSessionId(session.id)) return false;
    const timestamp = session.lastActivityAt || session.createdAt;
    if (!timestamp) return false;
    const parsedTime = new Date(timestamp).getTime();
    if (!Number.isFinite(parsedTime)) return false;
    const age = Date.now() - parsedTime;
    if (age >= SESSION_TTL_MS) return false;
    this._ensureSessionFieldTypes(session);
    session._restored = true;
    return true;
  }

  _ensureSessionFieldTypes(session) {
    session.tokensUsed = (typeof session.tokensUsed === 'number' && Number.isFinite(session.tokensUsed)) ? session.tokensUsed : 0;
    session.completedSkills = Array.isArray(session.completedSkills) ? session.completedSkills : [];
    session.currentPhase = (typeof session.currentPhase === 'string') ? session.currentPhase : PHASES[0];
    session.agentHistory = Array.isArray(session.agentHistory) ? session.agentHistory : [];
    session.status = (typeof session.status === 'string') ? session.status : SESSION_STATUS_ACTIVE;
    if (!session.deepeningState || typeof session.deepeningState !== 'object') {
      session.deepeningState = _cloneDeepeningState();
    } else {
      if (!Array.isArray(session.deepeningState.convergenceHistory)) session.deepeningState.convergenceHistory = [];
      if (typeof session.deepeningState.totalIterations !== 'number' || !Number.isFinite(session.deepeningState.totalIterations)) session.deepeningState.totalIterations = 0;
      if (typeof session.deepeningState.bestQualityScore !== 'number' || !Number.isFinite(session.deepeningState.bestQualityScore)) session.deepeningState.bestQualityScore = 0;
    }
    if (!session.entropyState || typeof session.entropyState !== 'object') {
      session.entropyState = { currentLevel: 'unknown', firstMessageRichness: null, convergenceTurns: 0 };
    }
  }

  static _TEST_PREFIXES = [
    'test-', 'sess-', 'deepening-test-', 'phase-', 'token-', 'budget-',
    'flush-', 'dir-', 'readonly-', 'emit-', 'debounce-', 'immediate-',
    'bus-bridge-', 'e2e-', 'valid-session', 'phase-bus-', 'restore-',
    'advance-', 'complete-', 'create-', 'get-', 'update-', 'delete-',
    'list-', 'search-', 'skill-', 'agent-', 'hook-', 'config-',
    'entropy-test-',
  ];

  _isTestSessionId(id) {
    return SessionManager._TEST_PREFIXES.some(p => id.startsWith(p));
  }

  /** @private */
  _evictOldest() {
    const entries = Object.entries(this.sessions);
    if (entries.length === 0) return;
    const oldest = entries.reduce((acc, [id, session]) => {
      const time = new Date(session.lastActivityAt || session.createdAt).getTime();
      if (!Number.isFinite(time)) return acc;
      return time < acc.time ? { id, time } : acc;
    }, { id: null, time: Infinity });
    let oldestId = oldest.id;
    if (!oldestId && entries.length > 0) {
      oldestId = entries[0][0];
    }
    if (oldestId) {
      this._persistDebouncer.delete(oldestId);
      delete this.sessions[oldestId];
      const filePath = path.join(this.root, HARNESS_DIR, 'sessions', oldestId + '.json');
      fs.promises.unlink(filePath).catch(function(err) {
        if (err && err.code !== 'ENOENT') {
          debug('SessionManager', 'diskCleanup', err);
        }
      });
      this.emit('session-evicted', { sessionId: oldestId, reason: 'capacity' });
    }
  }

  /**
   * 防抖持久化：在DEBOUNCE_MS内合并多次写入为一次。
   * 立即更新内存中的session对象，延迟写磁盘。
   * @private
   * @param {Session} session - 要持久化的会话对象
   * @param {boolean} [immediate=false] - 是否立即写入（用于create等关键操作）
   */
  _persist(session, immediate = false) {
    if (this._shutDown) return;
    const sessionId = session.id;
    this._persistDebouncer.schedule(sessionId, () => {
      if (this.sessions[sessionId] === session) {
        this._writeToDisk(session);
      }
    }, immediate);
  }

  /**
   * 将会话数据写入磁盘。
   * @private
   * @param {Session} session - 要写入的会话对象
   */
  _writeToDisk(session) {
    try {
      const filePath = path.join(this.root, HARNESS_DIR, 'sessions', `${session.id}.json`);
      const persistable = mergeConfig(session);
      delete persistable._arContext;
      writeAtomic(filePath, persistable);
    } catch (err) {
      debug('SessionManager', '_writeToDisk', err);
      emitError(this, 'persist-error', err, { sessionId: session.id });
    }
  }

  /**
   * 强制刷新所有待写入的会话到磁盘。在进程退出前调用。
   */
  flush() {
    this._persistDebouncer.flush((sessionId) => {
      const session = this.sessions[sessionId];
      return session ? () => this._writeToDisk(session) : null;
    });
  }

  /**
   * 优雅关机：刷新所有待写入会话到磁盘，并移除信号监听器。
   * 可手动调用，也可作为SIGINT/SIGTERM处理器自动触发。
   * @param {string} [signal] - 触发关机的信号名称
   */
  _onShutdown() {
    this._shutdownSignal = this._shutdownSignal || 'manual';
    this.flush();
    this._persistDebouncer.shutdown();
    if (this._ttlCleanupTimer) {
      clearInterval(this._ttlCleanupTimer);
      this._ttlCleanupTimer = null;
    }
    if (this._configWatcher) {
      if (typeof this._configWatcher.removeAllListeners === 'function') {
        this._configWatcher.removeAllListeners();
      }
      try { this._configWatcher.close(); } catch (_e) { debug('SessionManager', 'shutdown:watcher', _e && _e.message ? _e.message : String(_e)); }
      this._configWatcher = null;
    }
    if (this._configDebounceTimer) {
      clearTimeout(this._configDebounceTimer);
      this._configDebounceTimer = null;
    }
    if (this._watcherRetryTimer) {
      clearTimeout(this._watcherRetryTimer);
      this._watcherRetryTimer = null;
    }
    this._configReloading = false;
    this._causalDataBus = null;
    this._phaseContextInjector = null;
    Object.values(this.sessions).forEach(session => {
      if (session && session._arContext) {
        session._arContext = null;
      }
    });
    if (this._signalHandler) {
      process.removeListener('SIGINT', this._signalHandler);
      process.removeListener('SIGTERM', this._signalHandler);
      this._signalHandler = null;
    }
    this.sessions = {};
    this.removeAllListeners();
  }

  /**
   * 获取会话管理器统计信息，包含活跃会话数、总Token用量和阶段分布
   * @returns {{ activeSessions: number, totalTokensUsed: number, phases: Object<string, number> }} 统计快照
   */
  getStats() {
    this.guardShutdown();
    const now = Date.now();
    if (this._statsCache && this._statsCacheAt && (now - this._statsCacheAt < 1000)) {
      return this._statsCache;
    }
    this._statsCache = {
      activeSessions: Object.keys(this.sessions).length,
      totalTokensUsed: Object.values(this.sessions).reduce((sum, s) => sum + (s.tokensUsed ?? 0), 0),
      phases: Object.values(this.sessions).reduce((acc, s) => { acc[s.currentPhase] = (acc[s.currentPhase] ?? 0) + 1; return acc; }, {}),
    };
    this._statsCacheAt = now;
    return this._statsCache;
  }

  /**
   * 获取最近一次会话的上下文摘要，用于会话恢复场景
   * @returns {Promise<Object|null>} 最近会话上下文对象，包含sessionId、lastPhase、completedSkills、tokensUsed等字段；无历史会话时返回null
   */
  async getPreviousSessionContext() {
    this.guardShutdown();
    const sessionsDir = this._sessionsDir;
    let entries;
    try { entries = await readJsonDirAsync(sessionsDir, { logLabel: 'SessionManager' }); } catch (err) { debug('SessionManager', 'getPreviousSessionContext', err && err.message ? err.message : String(err)); return null; }
    if (!entries || entries.length === 0) return null;

    const mostRecent = entries.reduce((acc, { data: session }) => {
      const time = new Date(session.lastActivityAt || session.createdAt).getTime();
      if (Number.isFinite(time) && time > acc.time && session.id) {
        return { session, time };
      }
      return acc;
    }, { session: null, time: 0 });

    if (!mostRecent.session) return null;

    return {
      sessionId: mostRecent.session.id,
      lastPhase: mostRecent.session.currentPhase,
      completedSkills: (mostRecent.session.completedSkills ?? []).slice(-5),
      tokensUsed: mostRecent.session.tokensUsed ?? 0,
      lastActivityAt: mostRecent.session.lastActivityAt || mostRecent.session.createdAt,
      keyDecisions: (mostRecent.session.keyDecisions ?? []).slice(-5),
      agentHistory: (mostRecent.session.agentHistory ?? []).slice(-3),
      summary: mostRecent.session.summary || '',
    };
  }

  /**
   * 注册SIGINT/SIGTERM信号处理器，实现进程退出前自动刷盘。
   * @returns {SessionManager} this（支持链式调用）
   */
  registerShutdownHooks() {
    if (this._signalHandler) {
      process.removeListener('SIGINT', this._signalHandler);
      process.removeListener('SIGTERM', this._signalHandler);
    }
    this._signalHandler = (sig) => {
      this._shutdownSignal = sig;
      try {
        this.shutdown();
      } catch (shutdownErr) {
        debug('SessionManager', 'signalShutdown', shutdownErr && shutdownErr.message ? shutdownErr.message : String(shutdownErr));
      }
      if (typeof this.waitForShutdown === 'function') {
        this.waitForShutdown().then(function() {
          process.exit(0);
        }).catch(function() {
          process.exit(1);
        });
      }
    };
    process.on('SIGINT', this._signalHandler);
    process.on('SIGTERM', this._signalHandler);
    return this;
  }
}

/**
 * @typedef {Object} Session
 * @property {string} id - 会话ID
 * @property {string} currentPhase - 当前阶段
 * @property {string[]} completedSkills - 已完成的Skill列表
 * @property {number} tokensUsed - 已使用的Token数量
 * @property {'active'|'completed'|'expired'} status - 会话状态
 * @property {string} createdAt - 创建时间（ISO格式）
 * @property {string} lastActivityAt - 最后活动时间（ISO格式）
 * @property {AgentAction[]} agentHistory - Agent操作历史
 */

/**
 * @typedef {Object} AgentAction
 * @property {string} agent - Agent角色ID
 * @property {string} action - 操作描述
 * @property {string} timestamp - 时间戳（ISO格式）
 */

/**
 * @typedef {Object} BudgetStatus
 * @property {boolean} warning80 - 是否达到80%预警
 * @property {boolean} warning95 - 是否达到95%预警
 * @property {boolean} exhausted - 预算是否耗尽
 * @property {number} ratio - 使用比例（0-1）
 */

SessionManager.VALID_PHASES = PHASES;
SessionManager.SESSION_ID_PATTERN = SESSION_ID_PATTERN;
SessionManager.MAX_SESSIONS = MAX_SESSIONS;
SessionManager.SESSION_TTL_MS = SESSION_TTL_MS;
SessionManager.DEBOUNCE_MS = DEFAULT_DEBOUNCE_MS;
/**
 * 生成随机会话ID，格式为 `session-` + 16位短ID。
 * @returns {string} 随机会话ID
 */
SessionManager.generateSessionId = function() {
  return 'session-' + shortId('', 16);
};

module.exports = withShutdown(SessionManager);
