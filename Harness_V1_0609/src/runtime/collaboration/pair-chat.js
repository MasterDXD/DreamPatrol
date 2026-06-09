'use strict';

const { EventEmitter } = require('events');
const { generateId, DEFAULT_TTL_CACHE_MS } = require('../../utils/constants');
const safeAssign = require('../../utils/safe-assign');
const { mergeConfig } = safeAssign;
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeDateGetTime } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

const CHAT_ROLES = {
  PROPOSER: 'proposer',
  REVIEWER: 'reviewer',
};

const CONSENSUS_STATES = {
  REACHED: 'reached',
  PENDING: 'pending',
  FAILED: 'failed',
};

const CROSS_VALIDATION_MODES = {
  UNIDIRECTIONAL: 'unidirectional',
  BIDIRECTIONAL: 'bidirectional',
};

const HALLUCINATION_SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/**
 * 团队会话组模式，融合自Claude Code的Agent team多会话协作概念。
 * Agent team是"多会话协作的团队"，与Subagent的"单会话临时工"形成对比。
 *
 * TEAM_GROUP: 团队组模式 - 多个PairChat会话和ChatChain链关联为一个团队，
 *   共享状态和上下文，支持跨会话状态传递和团队级统计聚合。
 *
 * 使用场景：
 * - 代码审查需要多轮proposer-reviewer对话 + 交叉验证 → 创建团队组关联所有会话
 * - 架构评审需要多角色持续协作 → 团队组管理共享上下文
 */
const TEAM_GROUP_STATUS = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  DISBANDED: 'disbanded',
};

const DEFAULT_CONFIG = {
  maxRounds: 5,
  consensusThreshold: 0.8,
  roundTimeoutMs: DEFAULT_TTL_CACHE_MS,
  requireApproval: true,
  trackCorrections: true,
};

/**
 * @module runtime/collaboration/pair-chat
 * @classdesc 配对对话。双Agent实时协作、交叉验证、幻觉检测与追踪
 * PairChat — 配对对话协作器
 * 实现双Agent（提议者-审查者）实时协作对话，通过多轮提议-审查-修正循环达成共识。
 * 支持共识阈值判定、轮次超时检测、修正统计追踪和会话生命周期管理。
 * 融合ChatDev交叉验证协议：支持双向验证、幻觉纠正追踪、验证标准检查。
 * 用于代码审查、架构评审等需要双角色对抗性协作的场景。
 * @extends EventEmitter
 * @emits PairChat#session-started
 * @emits PairChat#round-completed
 * @emits PairChat#consensus-reached
 * @emits PairChat#session-timeout
 * @emits PairChat#cross-validation-started
 * @emits PairChat#hallucination-detected
 * @emits PairChat#cross-validation-completed
 */
const MAX_SESSIONS_PER_GROUP = 50;
const MAX_CHAINS_PER_GROUP = 50;

class PairChat extends EventEmitter {
  /**
   * 创建 PairChat 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxRounds=5] - 每个会话的最大轮次数
   * @param {number} [options.consensusThreshold=0.8] - 共识达成阈值（0-1之间）
   * @param {number} [options.roundTimeoutMs] - 轮次超时时间（毫秒），默认使用 DEFAULT_TTL_CACHE_MS
   * @param {boolean} [options.requireApproval=true] - 是否需要审批确认
   * @param {boolean} [options.trackCorrections=true] - 是否追踪修正统计
   * @param {number} [options.maxSessions=200] - 最大并发会话数
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._sessions = new Map();
    this._correctionStats = { totalCorrections: 0, totalRounds: 0, totalSessions: 0, timedOutSessions: 0 };
    this._crossValidationStats = {
      totalCrossValidations: 0,
      totalHallucinationCorrections: 0,
      totalValidationCriteriaPassed: 0,
      totalValidationCriteriaFailed: 0,
      avgHallucinationCorrectionsPerSession: 0,
      _hallucinationSum: 0,
    };
    this._maxSessions = Math.max(1, (options && options.maxSessions) || 200);
    this._teamGroups = new Map();
    this._maxTeamGroups = 50;
    this._cleanupInterval = setInterval(() => { if (this._shutDown) return; try { this._cleanupTimedOutSessions(); } catch (_e) { debug('PairChat', 'cleanupInterval', _e && _e.message ? _e.message : String(_e)); } }, 60000);
    if (this._cleanupInterval && typeof this._cleanupInterval.unref === 'function') { this._cleanupInterval.unref(); }
  }

  _cleanupTimedOutSessions() {
    const timeoutMs = this._config.roundTimeoutMs ?? DEFAULT_TTL_CACHE_MS;
    for (const [id, session] of this._sessions) {
      if (session.status === CONSENSUS_STATES.PENDING) {
        let lastActivity;
        if (session.rounds.length > 0) {
          const lastRound = session.rounds[session.rounds.length - 1];
          const ts = lastRound && lastRound.timestamp ? safeDateGetTime(lastRound.timestamp) : NaN;
          lastActivity = Number.isFinite(ts) ? ts : safeDateGetTime(session.createdAt);
        } else {
          lastActivity = safeDateGetTime(session.createdAt);
        }
        if (!Number.isFinite(lastActivity)) lastActivity = Date.now();
        if (Date.now() - lastActivity > timeoutMs) {
          session.status = CONSENSUS_STATES.FAILED;
          this._correctionStats.timedOutSessions++;
          this.emit('session-timeout', { sessionId: id });
        }
      }
    }
  }

  /**
   * 启动配对对话会话，创建提议者-审查者协作上下文
   * 超出最大会话数时淘汰已完成或已失败的会话
   * @param {object} config - 会话配置
   * @param {string} config.proposer - 提议者Agent ID
   * @param {string} config.reviewer - 审查者Agent ID
   * @param {string} config.artifact - 待讨论的制品（代码、文档等）
   * @param {string} [config.artifactType='code'] - 制品类型
   * @param {object} [config.options] - 会话级配置覆盖
   * @returns {{ sessionId: string|null, status: string, error?: string }} 会话创建结果
   * @example
   * const pairChat = new PairChat();
   * const { sessionId } = pairChat.startSession({
   *   proposer: 'programmer',
   *   reviewer: 'reviewer',
   *   artifact: 'Code review for auth module'
   * });
   * pairChat.addRound(sessionId, {
   *   from: 'programmer',
   *   to: 'reviewer',
   *   content: 'I implemented JWT authentication'
   * });
   */
  startSession(config) {
    this.guardShutdown();
    if (!config || !config.proposer || !config.reviewer) {
      return { sessionId: null, error: 'proposer and reviewer are required' };
    }
    if (!config.artifact) {
      return { sessionId: null, error: 'artifact (topic/content to discuss) is required' };
    }

    const sessionId = generateId('pair-');
    const session = {
      sessionId,
      proposer: config.proposer,
      reviewer: config.reviewer,
      artifact: config.artifact,
      artifactType: config.artifactType ?? 'code',
      rounds: [],
      status: CONSENSUS_STATES.PENDING,
      createdAt: new Date().toISOString(),
      config: safeAssign({}, this._config, config.options),
    };

    if (this._sessions.size >= this._maxSessions) {
      let evictKey = null;
      for (const [k, s] of this._sessions) {
        if (s.status === CONSENSUS_STATES.REACHED || s.status === CONSENSUS_STATES.FAILED) {
          evictKey = k;
          break;
        }
      }
      if (!evictKey && this._sessions.size > 0) {
        evictKey = this._sessions.keys().next().value;
      }
      if (evictKey) this._sessions.delete(evictKey);
    }
    this._sessions.set(sessionId, session);
    this.emit('session-started', { sessionId, proposer: config.proposer, reviewer: config.reviewer });

    return { sessionId, status: session.status };
  }

  /**
   * 向指定会话添加一轮对话，包含提议者输出、审查者反馈和修正列表
   * 自动评估共识状态：审查通过、修正趋势递减或达到最大轮次时触发状态转换
   * @param {string} sessionId - 会话ID
   * @param {object} roundData - 轮次数据
   * @param {*} [roundData.proposerOutput] - 提议者本轮输出
   * @param {*} [roundData.reviewerFeedback] - 审查者本轮反馈
   * @param {Array} [roundData.corrections=[]] - 本轮修正项列表
   * @param {boolean} [roundData.approved=false] - 审查者是否批准
   * @returns {{ round: object, consensus: string, correctionsCount: number, sessionStatus: string, nextAction: string } | { error: string, round: null }} 轮次结果
   */
  addRound(sessionId, roundData) {
    this.guardShutdown();
    const session = this._sessions.get(sessionId);
    if (!session) {
      return { error: 'Session not found', round: null };
    }

    if (session.status !== CONSENSUS_STATES.PENDING) {
      return { error: 'Session is not pending', round: null, sessionStatus: session.status };
    }

    const roundTimeoutMs = session.config.roundTimeoutMs ?? DEFAULT_TTL_CACHE_MS;
    let lastActivity;
    const lastRound = session.rounds.length > 0 ? session.rounds[session.rounds.length - 1] : null;
    if (lastRound) {
      const ts = lastRound.timestamp;
      lastActivity = ts ? safeDateGetTime(ts) : NaN;
      if (!Number.isFinite(lastActivity)) lastActivity = safeDateGetTime(session.createdAt);
    } else {
      lastActivity = safeDateGetTime(session.createdAt);
    }
    if (!Number.isFinite(lastActivity)) lastActivity = Date.now();
    if (Date.now() - lastActivity > roundTimeoutMs) {
      session.status = CONSENSUS_STATES.FAILED;
      this.emit('round-timeout', { sessionId, elapsed: Date.now() - lastActivity, timeout: roundTimeoutMs });
      return { error: 'Round timed out', round: null, sessionStatus: CONSENSUS_STATES.FAILED };
    }

    const roundNumber = session.rounds.length + 1;
    const round = {
      round: roundNumber,
      proposerOutput: roundData.proposerOutput ?? null,
      reviewerFeedback: roundData.reviewerFeedback ?? null,
      corrections: roundData.corrections ?? [],
      approved: roundData.approved === true,
      timestamp: new Date().toISOString(),
    };

    session.rounds.push(round);

    if (this._config.trackCorrections && round.corrections.length > 0) {
      this._correctionStats.totalCorrections += round.corrections.length;
    }
    this._correctionStats.totalRounds++;

    const consensus = this._evaluateConsensus(session, round);

    if (consensus.state === CONSENSUS_STATES.REACHED) {
      session.status = CONSENSUS_STATES.REACHED;
      session.consensusRound = roundNumber;
      session.finalArtifact = roundData.proposerOutput ?? session.artifact;
      this._correctionStats.totalSessions++;
      this.emit('consensus-reached', { sessionId, round: roundNumber, corrections: this._countCorrections(session) });
    } else if (roundNumber >= session.config.maxRounds) {
      session.status = CONSENSUS_STATES.FAILED;
      session.finalArtifact = roundData.proposerOutput ?? session.artifact;
      this._correctionStats.totalSessions++;
      this.emit('consensus-failed', { sessionId, rounds: roundNumber, reason: 'max-rounds-exceeded' });
    }

    this.emit('round-completed', { sessionId, round: roundNumber, approved: round.approved, corrections: round.corrections.length });

    return {
      round,
      consensus: consensus.state,
      correctionsCount: round.corrections.length,
      sessionStatus: session.status,
      nextAction: this._getNextAction(session, round),
    };
  }

  /**
   * 获取指定会话的完整数据对象
   * @param {string} sessionId - 会话ID
   * @returns {object|null} 会话对象，不存在时返回null
   */
  getSession(sessionId) {
    this.guardShutdown();
    const session = this._sessions.get(sessionId);
    return session ? { ...session, rounds: session.rounds.slice() } : null;
  }

  /**
   * 获取指定会话的摘要信息，包含轮次统计和共识状态
   * @param {string} sessionId - 会话ID
   * @returns {{ sessionId: string, proposer: string, reviewer: string, artifactType: string, status: string, totalRounds: number, totalCorrections: number, consensusRound: number|null, finalApproved: boolean, createdAt: string } | null} 会话摘要，不存在时返回null
   */
  getSessionSummary(sessionId) {
    this.guardShutdown();
    const session = this._sessions.get(sessionId);
    if (!session) return null;

    const totalCorrections = this._countCorrections(session);
    const lastRound = session.rounds.length > 0 ? session.rounds[session.rounds.length - 1] : null;

    return {
      sessionId: session.sessionId,
      proposer: session.proposer,
      reviewer: session.reviewer,
      artifactType: session.artifactType,
      status: session.status,
      totalRounds: session.rounds.length,
      totalCorrections,
      consensusRound: session.consensusRound ?? null,
      finalApproved: lastRound ? lastRound.approved : false,
      createdAt: session.createdAt,
    };
  }

  /**
   * 获取配对对话协作器的运行统计信息
   * @returns {{ activeSessions: number, totalSessions: number, totalRounds: number, totalCorrections: number, avgCorrectionsPerSession: string|number, avgRoundsPerSession: string|number }} 统计数据
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('PairChat', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { activeSessions: 0, totalSessions: 0, timedOutSessions: 0, totalRounds: 0, totalCorrections: 0, avgCorrectionsPerSession: 0, avgRoundsPerSession: 0, crossValidation: { totalCrossValidations: 0, totalHallucinationCorrections: 0, avgHallucinationCorrectionsPerSession: 0 } }; }
    return {
      activeSessions: this._sessions.size,
      totalSessions: this._correctionStats.totalSessions,
      timedOutSessions: this._correctionStats.timedOutSessions,
      totalRounds: this._correctionStats.totalRounds,
      totalCorrections: this._correctionStats.totalCorrections,
      avgCorrectionsPerSession: this._correctionStats.totalSessions > 0
        ? Math.round(this._correctionStats.totalCorrections / this._correctionStats.totalSessions * 100) / 100
        : 0,
      avgRoundsPerSession: this._correctionStats.totalSessions > 0
        ? Math.round(this._correctionStats.totalRounds / this._correctionStats.totalSessions * 100) / 100
        : 0,
      crossValidation: this.getCrossValidationStats(),
    };
  }

  /**
   * 销毁指定会话并释放资源
   * @param {string} sessionId - 会话ID
   * @returns {boolean} 会话是否存在且已被成功销毁
   */
  destroySession(sessionId) {
    this.guardShutdown();
    const session = this._sessions.get(sessionId);
    if (session) {
      this._sessions.delete(sessionId);
      this.emit('session-destroyed', { sessionId });
      return true;
    }
    return false;
  }

  /**
   * 启动交叉验证会话，创建双向/单向验证协作上下文
   * 融合ChatDev"两两对话+交叉验证"方法论，支持幻觉检测追踪与验证标准检查
   * @param {object} config - 验证配置
   * @param {string} config.agentA - Agent A ID
   * @param {string} config.agentB - Agent B ID
   * @param {string} config.artifact - 待验证的制品
   * @param {string} [config.artifactType='code'] - 制品类型
   * @param {string} [config.mode='bidirectional'] - 验证模式（unidirectional/bidirectional）
   * @param {Array<{id: string, description: string, required: boolean}>} [config.validationCriteria=[]] - 验证标准列表
   * @param {object} [config.options] - 会话级配置覆盖
   * @returns {{ sessionId: string|null, status: string, mode: string, criteriaCount: number, error?: string }} 会话创建结果
   * @example
   * const { sessionId } = pairChat.startCrossValidation({
   *   agentA: 'programmer',
   *   agentB: 'reviewer',
   *   artifact: 'src/auth.js',
   *   artifactType: 'code',
   *   mode: PairChat.CROSS_VALIDATION_MODES.BIDIRECTIONAL,
   *   validationCriteria: [
   *     { id: 'logic', description: 'Logical correctness', required: true },
   *     { id: 'security', description: 'Security compliance', required: true }
   *   ]
   * });
   */
  startCrossValidation(config) {
    this.guardShutdown();
    if (!config || !config.agentA || !config.agentB) {
      return { sessionId: null, error: 'agentA and agentB are required' };
    }
    if (!config.artifact) {
      return { sessionId: null, error: 'artifact is required' };
    }

    const sessionId = generateId('xval-');
    const mode = config.mode ?? CROSS_VALIDATION_MODES.BIDIRECTIONAL;
    const validationCriteria = config.validationCriteria ?? [];
    const session = {
      sessionId,
      proposer: config.agentA,
      reviewer: config.agentB,
      agentA: config.agentA,
      agentB: config.agentB,
      artifact: config.artifact,
      artifactType: config.artifactType ?? 'code',
      rounds: [],
      status: CONSENSUS_STATES.PENDING,
      createdAt: new Date().toISOString(),
      config: safeAssign({}, this._config, config.options),
      crossValidation: {
        mode,
        validationCriteria: validationCriteria.map(function(c, i) {
          return {
            id: c.id || ('criteria-' + (i + 1)),
            description: c.description || '',
            required: c.required !== false,
            passed: null,
            checkedBy: null,
          };
        }),
        hallucinationCorrections: [],
        directionARounds: 0,
        directionBRounds: 0,
        bidirectionalResults: null,
      },
    };

    this._evictSessionIfNeeded();
    this._sessions.set(sessionId, session);
    this._crossValidationStats.totalCrossValidations++;
    this.emit('cross-validation-started', { sessionId, agentA: config.agentA, agentB: config.agentB, mode });

    return { sessionId, status: session.status, mode, criteriaCount: (session.crossValidation?.validationCriteria ?? []).length };
  }

  /**
   * 向交叉验证会话添加一轮验证，追踪幻觉纠正与标准检查结果
   * 自动评估共识状态，双向模式下追踪A→B和B→A方向的验证统计
   * @param {string} sessionId - 会话ID
   * @param {object} roundData - 轮次数据
   * @param {*} [roundData.proposerOutput] - 提议者本轮输出
   * @param {*} [roundData.reviewerFeedback] - 审查者本轮反馈
   * @param {Array} [roundData.corrections=[]] - 本轮修正项列表（isHallucination:true标记幻觉纠正）
   * @param {boolean} [roundData.approved=false] - 审查者是否批准
   * @param {string} [roundData.direction='A-to-B'] - 验证方向（A-to-B/A->B/B-to-A/B->A）
   * @param {object} [roundData.criteriaResults] - 验证标准结果，键为标准ID，值为{passed,checkedBy}
   * @returns {{ round: object, consensus: string, correctionsCount: number, hallucinationCorrectionsCount: number, sessionStatus: string, nextAction: string } | { error: string, round: null }} 轮次结果
   */
  addCrossValidationRound(sessionId, roundData) {
    this.guardShutdown();
    const session = this._sessions.get(sessionId);
    if (!session) return { error: 'Session not found', round: null };
    if (!session.crossValidation) return { error: 'Not a cross-validation session', round: null };
    if (session.status !== CONSENSUS_STATES.PENDING) return { error: 'Session is not pending', round: null, sessionStatus: session.status };
    if (!roundData || typeof roundData !== 'object') return { error: 'roundData is required', round: null };

    const timeoutResult = this._checkRoundTimeout(session, sessionId);
    if (timeoutResult) return timeoutResult;

    const roundNumber = session.rounds.length + 1;
    const direction = roundData.direction || 'A-to-B';
    const rawCorrections = roundData.corrections;
    const corrections = Array.isArray(rawCorrections) ? rawCorrections : [];
    const hallucinationItems = corrections.filter(function(c) {
      return c && c.isHallucination === true;
    });

    const round = {
      round: roundNumber,
      proposerOutput: roundData.proposerOutput ?? null,
      reviewerFeedback: roundData.reviewerFeedback ?? null,
      corrections: corrections,
      hallucinationCorrections: hallucinationItems,
      approved: roundData.approved === true,
      direction,
      criteriaResults: roundData.criteriaResults ?? null,
      timestamp: new Date().toISOString(),
    };

    session.rounds.push(round);
    this._updateDirectionRounds(session, direction);
    this._processHallucinationItems(session, round, roundNumber, direction, hallucinationItems);
    this._processCriteriaResults(session, roundData.criteriaResults, direction);

    if (this._config.trackCorrections && round.corrections.length > 0) {
      this._correctionStats.totalCorrections += round.corrections.length;
    }
    this._correctionStats.totalRounds++;

    this._finalizeRound(session, round, roundNumber, roundData);

    this.emit('round-completed', { sessionId, round: roundNumber, approved: round.approved, corrections: round.corrections.length });

    return {
      round,
      consensus: this._evaluateConsensus(session, round).state,
      correctionsCount: round.corrections.length,
      hallucinationCorrectionsCount: hallucinationItems.length,
      sessionStatus: session.status,
      nextAction: this._getNextAction(session, round),
    };
  }

  _checkRoundTimeout(session, sessionId) {
    const roundTimeoutMs = session.config.roundTimeoutMs ?? DEFAULT_TTL_CACHE_MS;
    let lastActivity;
    const lastRound = session.rounds.length > 0 ? session.rounds[session.rounds.length - 1] : null;
    if (lastRound) {
      const ts = lastRound.timestamp;
      lastActivity = ts ? safeDateGetTime(ts) : NaN;
      if (!Number.isFinite(lastActivity)) lastActivity = safeDateGetTime(session.createdAt);
    } else {
      lastActivity = safeDateGetTime(session.createdAt);
    }
    if (!Number.isFinite(lastActivity)) lastActivity = Date.now();
    if (Date.now() - lastActivity > roundTimeoutMs) {
      session.status = CONSENSUS_STATES.FAILED;
      this.emit('round-timeout', { sessionId, elapsed: Date.now() - lastActivity, timeout: roundTimeoutMs });
      return { error: 'Round timed out', round: null, sessionStatus: CONSENSUS_STATES.FAILED };
    }
    return null;
  }

  _updateDirectionRounds(session, direction) {
    if (direction === 'A-to-B' || direction === 'A->B') {
      session.crossValidation.directionARounds++;
    } else {
      session.crossValidation.directionBRounds++;
    }
  }

  _processHallucinationItems(session, round, roundNumber, direction, hallucinationItems) {
    for (const hc of hallucinationItems) {
      session.crossValidation.hallucinationCorrections.push({
        round: roundNumber,
        direction,
        description: hc.description || '',
        severity: hc.severity || HALLUCINATION_SEVERITY.MEDIUM,
        correctedBy: direction === 'A-to-B' || direction === 'A->B' ? session.agentB : session.agentA,
        timestamp: round.timestamp,
      });
      this._crossValidationStats.totalHallucinationCorrections++;
      this.emit('hallucination-detected', {
        sessionId: session.sessionId,
        round: roundNumber,
        severity: hc.severity || HALLUCINATION_SEVERITY.MEDIUM,
        description: hc.description || '',
      });
    }
  }

  _processCriteriaResults(session, criteriaResults, direction) {
    if (criteriaResults != null && typeof criteriaResults === 'object') {
      for (const criteria of session.crossValidation.validationCriteria) {
        const result = criteriaResults[criteria.id];
        if (result !== undefined) {
          criteria.passed = result.passed === true;
          criteria.checkedBy = result.checkedBy || direction;
          if (criteria.passed) {
            this._crossValidationStats.totalValidationCriteriaPassed++;
          } else {
            this._crossValidationStats.totalValidationCriteriaFailed++;
          }
        }
      }
    }
  }

  _finalizeRound(session, round, roundNumber, roundData) {
    const consensus = this._evaluateConsensus(session, round);

    if (consensus.state === CONSENSUS_STATES.REACHED) {
      session.status = CONSENSUS_STATES.REACHED;
      session.consensusRound = roundNumber;
      session.finalArtifact = roundData.proposerOutput ?? session.artifact;
      this._correctionStats.totalSessions++;
      this._updateCrossValidationBidirectionalResults(session);
      this._crossValidationStats._hallucinationSum += (session.crossValidation?.hallucinationCorrections ?? []).length;
      this._crossValidationStats.avgHallucinationCorrectionsPerSession =
        this._crossValidationStats.totalCrossValidations > 0
          ? this._crossValidationStats._hallucinationSum / this._crossValidationStats.totalCrossValidations
          : 0;
      this.emit('cross-validation-completed', {
        sessionId: session.sessionId,
        round: roundNumber,
        hallucinationCorrections: (session.crossValidation?.hallucinationCorrections ?? []).length,
        criteriaTotal: (session.crossValidation?.validationCriteria ?? []).length,
        criteriaPassed: (session.crossValidation?.validationCriteria ?? []).filter(function(c) { return c.passed === true; }).length,
      });
      this.emit('consensus-reached', { sessionId: session.sessionId, round: roundNumber, corrections: this._countCorrections(session) });
    } else if (roundNumber >= session.config.maxRounds) {
      session.status = CONSENSUS_STATES.FAILED;
      session.finalArtifact = roundData.proposerOutput ?? session.artifact;
      this._correctionStats.totalSessions++;
      this._updateCrossValidationBidirectionalResults(session);
      this._crossValidationStats._hallucinationSum += (session.crossValidation?.hallucinationCorrections ?? []).length;
      this._crossValidationStats.avgHallucinationCorrectionsPerSession =
        this._crossValidationStats.totalCrossValidations > 0
          ? this._crossValidationStats._hallucinationSum / this._crossValidationStats.totalCrossValidations
          : 0;
      this.emit('consensus-failed', { sessionId: session.sessionId, rounds: roundNumber, reason: 'max-rounds-exceeded' });
    }
  }

  /**
   * 获取交叉验证会话的完整报告，包含幻觉严重度分布、标准摘要、双向结果
   * @param {string} sessionId - 会话ID
   * @returns {object|null} 交叉验证报告，不存在或非交叉验证会话时返回null
   */
  getCrossValidationReport(sessionId) {
    this.guardShutdown();
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    if (!session.crossValidation) return null;

    const cv = session.crossValidation;
    const totalCorrections = this._countCorrections(session);
    const hallucinationBySeverity = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const hc of cv.hallucinationCorrections) {
      const sev = hc.severity || HALLUCINATION_SEVERITY.MEDIUM;
      if (hallucinationBySeverity[sev] !== undefined) hallucinationBySeverity[sev]++;
    }

    const criteriaSummary = {
      total: cv.validationCriteria.length,
      passed: cv.validationCriteria.filter(function(c) { return c.passed === true; }).length,
      failed: cv.validationCriteria.filter(function(c) { return c.passed === false; }).length,
      unchecked: cv.validationCriteria.filter(function(c) { return c.passed === null; }).length,
    };

    return {
      sessionId,
      mode: cv.mode,
      status: session.status,
      agentA: session.agentA,
      agentB: session.agentB,
      artifactType: session.artifactType,
      totalRounds: session.rounds.length,
      directionARounds: cv.directionARounds,
      directionBRounds: cv.directionBRounds,
      totalCorrections,
      hallucinationCorrections: cv.hallucinationCorrections.length,
      hallucinationBySeverity,
      criteriaSummary,
      validationCriteria: cv.validationCriteria.map(function(c) {
        return { id: c.id, description: c.description, required: c.required, passed: c.passed, checkedBy: c.checkedBy };
      }),
      bidirectionalResults: (function() { try { return JSON.parse(JSON.stringify(cv.bidirectionalResults)); } catch (_e) { debug('PairChat', 'deepCopy', _e && _e.message ? _e.message : String(_e)); return cv.bidirectionalResults; } })(),
      createdAt: session.createdAt,
    };
  }

  /**
   * 获取交叉验证全局统计信息
   * @returns {{ totalCrossValidations: number, totalHallucinationCorrections: number, totalValidationCriteriaPassed: number, totalValidationCriteriaFailed: number, avgHallucinationCorrectionsPerSession: number }} 统计数据
   */
  getCrossValidationStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { totalCrossValidations: 0, totalHallucinationCorrections: 0, totalValidationCriteriaPassed: 0, totalValidationCriteriaFailed: 0, avgHallucinationCorrectionsPerSession: 0 };
    }
    return {
      totalCrossValidations: this._crossValidationStats.totalCrossValidations,
      totalHallucinationCorrections: this._crossValidationStats.totalHallucinationCorrections,
      totalValidationCriteriaPassed: this._crossValidationStats.totalValidationCriteriaPassed,
      totalValidationCriteriaFailed: this._crossValidationStats.totalValidationCriteriaFailed,
      avgHallucinationCorrectionsPerSession: this._crossValidationStats.totalCrossValidations > 0
        ? Number((this._crossValidationStats.totalHallucinationCorrections / this._crossValidationStats.totalCrossValidations).toFixed(2))
        : 0,
    };
  }

  _evictSessionIfNeeded() {
    if (this._sessions.size < this._maxSessions) return;
    let evictKey = null;
    for (const [k, s] of this._sessions) {
      if (s.status === CONSENSUS_STATES.REACHED || s.status === CONSENSUS_STATES.FAILED) {
        evictKey = k;
        break;
      }
    }
    if (!evictKey && this._sessions.size > 0) {
      evictKey = this._sessions.keys().next().value;
    }
    if (evictKey) this._sessions.delete(evictKey);
  }

  _updateCrossValidationBidirectionalResults(session) {
    const cv = session.crossValidation;
    if (cv.mode !== CROSS_VALIDATION_MODES.BIDIRECTIONAL) {
      cv.bidirectionalResults = null;
      return;
    }
    const aToBRounds = session.rounds.filter(function(r) { return r.direction === 'A-to-B' || r.direction === 'A->B'; });
    const bToARounds = session.rounds.filter(function(r) { return r.direction === 'B-to-A' || r.direction === 'B->A'; });
    cv.bidirectionalResults = {
      directionA: {
        rounds: aToBRounds.length,
        corrections: aToBRounds.reduce(function(s, r) { return s + r.corrections.length; }, 0),
        hallucinations: aToBRounds.reduce(function(s, r) { return s + r.hallucinationCorrections.length; }, 0),
        approved: aToBRounds.length > 0 && aToBRounds[aToBRounds.length - 1].approved,
      },
      directionB: {
        rounds: bToARounds.length,
        corrections: bToARounds.reduce(function(s, r) { return s + r.corrections.length; }, 0),
        hallucinations: bToARounds.reduce(function(s, r) { return s + r.hallucinationCorrections.length; }, 0),
        approved: bToARounds.length > 0 && bToARounds[bToARounds.length - 1].approved,
      },
    };
  }

  _evaluateConsensus(session, latestRound) {
    if (latestRound.approved) {
      return { state: CONSENSUS_STATES.REACHED, confidence: 1.0 };
    }

    if (session.config.requireApproval) {
      return { state: CONSENSUS_STATES.PENDING, confidence: 0 };
    }

    const recentRounds = session.rounds.slice(-3);
    if (recentRounds.length >= 2) {
      const approvalRate = recentRounds.filter(r => r.approved).length / recentRounds.length;
      if (approvalRate >= session.config.consensusThreshold) {
        return { state: CONSENSUS_STATES.REACHED, confidence: approvalRate };
      }
    }

    const correctionTrend = recentRounds.map(r => r.corrections.length);
    if (correctionTrend.length >= 2) {
      const isDecreasing = correctionTrend.every((val, idx) => idx === 0 || val <= correctionTrend[idx - 1]);
      const lastCorrections = correctionTrend.length > 0 ? correctionTrend[correctionTrend.length - 1] : 0;
      if (isDecreasing && lastCorrections === 0) {
        return { state: CONSENSUS_STATES.REACHED, confidence: 0.85 };
      }
    }

    return { state: CONSENSUS_STATES.PENDING, confidence: 0 };
  }

  _getNextAction(session, latestRound) {
    if (session.status !== CONSENSUS_STATES.PENDING) {
      return 'complete';
    }
    if (latestRound.approved) {
      return 'complete';
    }
    if (latestRound.corrections.length > 0) {
      return 'proposer-revise';
    }
    return 'reviewer-review';
  }

  _countCorrections(session) {
    return session.rounds.reduce((sum, r) => sum + (r.corrections ? r.corrections.length : 0), 0);
  }

  /**
   * 创建团队会话组，融合自Claude Code的Agent team多会话协作概念。
   * 团队组将多个PairChat会话和ChatChain链关联为一个协作单元，
   * 支持共享上下文、跨会话状态传递和团队级统计聚合。
   * @param {Object} config - 团队组配置
   * @param {string} config.name - 团队组名称
   * @param {string[]} [config.memberAgents=[]] - 初始成员Agent ID列表
   * @param {Object} [config.sharedContext={}] - 团队共享上下文
   * @returns {{ groupId: string, name: string, status: string, memberAgents: string[], sessionCount: number }} 创建结果
   */
  createTeamGroup(config) {
    this.guardShutdown();
    if (!config || !config.name) {
      return { groupId: null, error: 'name is required' };
    }
    const groupId = generateId('team-');
    const group = {
      groupId,
      name: config.name,
      status: TEAM_GROUP_STATUS.ACTIVE,
      memberAgents: config.memberAgents ?? [],
      sharedContext: config.sharedContext ?? {},
      sessions: [],
      chains: [],
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    if (this._teamGroups.size >= this._maxTeamGroups) {
      let evictKey = null;
      for (const [k, g] of this._teamGroups) {
        if (g.status !== TEAM_GROUP_STATUS.ACTIVE) { evictKey = k; break; }
      }
      if (evictKey) this._teamGroups.delete(evictKey);
    }
    this._teamGroups.set(groupId, group);
    return { groupId, name: group.name, status: group.status, memberAgents: group.memberAgents, sessionCount: 0 };
  }

  /**
   * 向团队组添加会话，实现跨会话关联。
   * @param {string} groupId - 团队组ID
   * @param {string} sessionId - 会话ID
   * @returns {{ groupId: string, sessionId: string, sessionCount: number } | { error: string }} 添加结果
   */
  addSessionToTeamGroup(groupId, sessionId) {
    this.guardShutdown();
    const group = this._teamGroups.get(groupId);
    if (!group) return { error: 'Team group not found' };
    if (group.status !== TEAM_GROUP_STATUS.ACTIVE) return { error: 'Team group is not active' };
    if (!this._sessions.has(sessionId)) return { error: 'Session not found' };
    if (!group.sessions.includes(sessionId)) {
      if (group.sessions.length >= MAX_SESSIONS_PER_GROUP) group.sessions.shift();
      group.sessions.push(sessionId);
    }
    return { groupId, sessionId, sessionCount: group.sessions.length };
  }

  /**
   * 向团队组添加链引用，实现跨链关联。
   * @param {string} groupId - 团队组ID
   * @param {string} chainId - 链ID
   * @returns {{ groupId: string, chainId: string, chainCount: number } | { error: string }} 添加结果
   */
  addChainToTeamGroup(groupId, chainId) {
    this.guardShutdown();
    const group = this._teamGroups.get(groupId);
    if (!group) return { error: 'Team group not found' };
    if (group.status !== TEAM_GROUP_STATUS.ACTIVE) return { error: 'Team group is not active' };
    if (!group.chains.includes(chainId)) {
      if (group.chains.length >= MAX_CHAINS_PER_GROUP) group.chains.shift();
      group.chains.push(chainId);
    }
    return { groupId, chainId, chainCount: group.chains.length };
  }

  /**
   * 更新团队组共享上下文，所有成员会话可读取。
   * @param {string} groupId - 团队组ID
   * @param {Object} contextUpdate - 上下文更新键值对
   * @returns {{ groupId: string, sharedContext: Object } | { error: string }} 更新结果
   */
  updateTeamGroupContext(groupId, contextUpdate) {
    this.guardShutdown();
    const group = this._teamGroups.get(groupId);
    if (!group) return { error: 'Team group not found' };
    if (group.status !== TEAM_GROUP_STATUS.ACTIVE) return { error: 'Team group is not active' };
    if (!contextUpdate || typeof contextUpdate !== 'object') return { error: 'contextUpdate must be an object' };
    const safeUpdate = Object.keys(contextUpdate).reduce(function(acc, key) {
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
        acc[key] = contextUpdate[key];
      }
      return acc;
    }, {});
    Object.assign(group.sharedContext, safeUpdate);
    return { groupId, sharedContext: group.sharedContext };
  }

  /**
   * 获取团队组信息，包含聚合统计。
   * @param {string} groupId - 团队组ID
   * @returns {Object|null} 团队组信息，不存在时返回null
   */
  getTeamGroup(groupId) {
    this.guardShutdown();
    const group = this._teamGroups.get(groupId);
    if (!group) return null;
    const totalCorrections = group.sessions.reduce(function(sum, sid) {
      const session = this._sessions.get(sid);
      return sum + (session ? session.rounds.reduce(function(s, r) { return s + (r.corrections ? r.corrections.length : 0); }, 0) : 0);
    }.bind(this), 0);
    const activeSessions = group.sessions.filter(function(sid) {
      const session = this._sessions.get(sid);
      return session && session.status === CONSENSUS_STATES.PENDING;
    }.bind(this)).length;
    return {
      groupId: group.groupId,
      name: group.name,
      status: group.status,
      memberAgents: group.memberAgents,
      sharedContext: group.sharedContext,
      sessionCount: group.sessions.length,
      chainCount: group.chains.length,
      activeSessions: activeSessions,
      totalCorrections: totalCorrections,
      createdAt: group.createdAt,
      completedAt: group.completedAt,
    };
  }

  /**
   * 解散团队组，将状态标记为disbanded。
   * @param {string} groupId - 团队组ID
   * @returns {{ groupId: string, status: string } | { error: string }} 解散结果
   */
  disbandTeamGroup(groupId) {
    this.guardShutdown();
    const group = this._teamGroups.get(groupId);
    if (!group) return { error: 'Team group not found' };
    group.status = TEAM_GROUP_STATUS.DISBANDED;
    group.completedAt = new Date().toISOString();
    return { groupId, status: group.status };
  }

  _onShutdown() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this._sessions.clear();
    this._teamGroups.clear();
    this._correctionStats = { totalCorrections: 0, totalRounds: 0, totalSessions: 0, timedOutSessions: 0 };
    this._crossValidationStats = {
      totalCrossValidations: 0,
      totalHallucinationCorrections: 0,
      totalValidationCriteriaPassed: 0,
      totalValidationCriteriaFailed: 0,
      avgHallucinationCorrectionsPerSession: 0,
      _hallucinationSum: 0,
    };
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
  }
}

PairChat = withShutdown(PairChat);

PairChat.CHAT_ROLES = CHAT_ROLES;
PairChat.CONSENSUS_STATES = CONSENSUS_STATES;
PairChat.CROSS_VALIDATION_MODES = CROSS_VALIDATION_MODES;
PairChat.HALLUCINATION_SEVERITY = HALLUCINATION_SEVERITY;
PairChat.TEAM_GROUP_STATUS = TEAM_GROUP_STATUS;

module.exports = PairChat;
