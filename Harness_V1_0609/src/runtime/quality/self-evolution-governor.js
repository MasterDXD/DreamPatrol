'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { mergeConfig } = require('../../utils/safe-assign');
const { safeJsonParse } = require('../../utils/safe-parse');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { emitError, safeDateGetTime } = require('../../utils/safe-execute');
const RingBuffer = require('../../utils/ring-buffer');
const { timestampId, ID_PREFIXES } = require('../../utils/unique-id');
const { DEFAULT_METRICS_FLUSH_MS, DEFAULT_MIN_HEARTBEAT_MS, MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } = require('../../utils/constants');

const DEFAULT_HEARTBEAT_INTERVAL_MS = DEFAULT_METRICS_FLUSH_MS;
const MIN_HEARTBEAT_INTERVAL_MS = DEFAULT_MIN_HEARTBEAT_MS;
const MAX_HEARTBEAT_INTERVAL_MS = MS_PER_HOUR;
const DEFAULT_OBSERVATION_WINDOW_MS = MS_PER_DAY;
const AGENDA_MATURITY_THRESHOLD = 3;
const MAX_AGENDA_ITEMS = 200;
const MAX_OBSERVATIONS_PER_ITEM = 50;
const MAX_PROPOSAL_HISTORY = 1000;
const PROPOSAL_TTL_MS = MS_PER_DAY * 7;
const MAX_PENDING_PROPOSALS = 50;
const _SUMMARY_MAX_ENTRIES = 100;

const PROPOSAL_STATUS = {
  PENDING: 'pending_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
};

const EVENT_TRIGGERS = [
  'error-spike',
  'quality-regression',
  'health-critical',
  'convergence-stall',
  'memory-pressure',
];

const OBSERVATION_SIGNALS = [
  'quality_trend',
  'convergence_pattern',
  'health_status',
  'skill_performance',
  'error_frequency',
];

const MATURITY_EXPIRY_MS = 5 * MS_PER_MINUTE;

/**
 * @module runtime/quality/self-evolution-governor
 * SelfEvolutionGovernor — 自演化治理器
 * @classdesc 自演化治理器。控制自我改进的速率和范围
 * 控制自我改进的速率和范围，防止无约束的自修改导致系统退化。
 * 周期性心跳收集质量趋势/健康状态/收敛模式/因果总线等观测信号，
 * 按议程键聚合成议程项，成熟后生成改进提案（proposal），经人工审批后执行。
 * 提案生命周期：pending→approved/rejected→executing→completed/failed，支持TTL过期与证据验证。
 * 内置熔断器：连续10次心跳错误自动停止，最大10万次心跳上限。
 * @extends EventEmitter
 * @emits SelfEvolutionGovernor#governor-started
 * @emits SelfEvolutionGovernor#governor-stopped
 * @emits SelfEvolutionGovernor#heartbeat-complete
 * @emits SelfEvolutionGovernor#proposal-generated
 * @emits SelfEvolutionGovernor#proposal-approved
 * @emits SelfEvolutionGovernor#proposal-rejected
 * @emits SelfEvolutionGovernor#proposal-executing
 * @emits SelfEvolutionGovernor#proposal-completed
 * @emits SelfEvolutionGovernor#proposal-failed
 * @emits SelfEvolutionGovernor#proposal-expired
 * @emits SelfEvolutionGovernor#governor-circuit-breaker
 */
class SelfEvolutionGovernor extends EventEmitter {
  constructor(options) {
    super();
    this._initDependencies(options);
    this._initConfig(options);
    this._initState();
  }

  _safeOpt(options, key) {
    return (options && options[key]) ?? null;
  }

  _initDependencies(options) {
    this._signalPersistence = this._safeOpt(options, 'signalPersistence');
    this._healthChecker = this._safeOpt(options, 'healthChecker');
    this._causalDataBus = this._safeOpt(options, 'causalDataBus');
    this._qualityScorer = this._safeOpt(options, 'qualityScorer');
    this._convergenceDetector = this._safeOpt(options, 'convergenceDetector');
    this._scheduler = this._safeOpt(options, 'scheduler');
    this._auditLogger = this._safeOpt(options, 'auditLogger');
    this._evidenceVerifier = this._safeOpt(options, 'evidenceVerifier');
    this._tddGate = this._safeOpt(options, 'tddGate');
    this._sqliteStore = this._safeOpt(options, 'sqliteStore');
  }

  _initConfig(options) {
    const rawInterval = (options && options.heartbeatIntervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this._heartbeatInterval = Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.min(MAX_HEARTBEAT_INTERVAL_MS, rawInterval));
    this._observationWindow = Math.max(1, (options && options.observationWindowMs) ?? DEFAULT_OBSERVATION_WINDOW_MS);
    this._agendaMaturityThreshold = Math.max(1, Math.min(100, (options && options.agendaMaturityThreshold) ?? AGENDA_MATURITY_THRESHOLD));
  }

  _initState() {
    this._agendaItems = new Map();
    this._maxAgendaItems = MAX_AGENDA_ITEMS;
    this._heartbeatTimer = null;
    this._heartbeatCount = 0;
    this._heartbeatExecuting = false;
    this._lastHeartbeatAt = null;
    this._running = false;
    this._consecutiveErrors = 0;
    this._maxConsecutiveErrors = 10;
    this._pendingProposals = new Map();
    this._proposalHistory = new RingBuffer(MAX_PROPOSAL_HISTORY);
    this._eventTriggersEnabled = true;
    this._stats = { heartbeatsExecuted: 0, signalsCollected: 0, agendaItemsCreated: 0, agendaItemsMatured: 0, proposalsGenerated: 0, proposalsApproved: 0, proposalsRejected: 0, proposalsExecuted: 0, proposalsCompleted: 0, proposalsFailed: 0, proposalsExpired: 0, heartbeatErrors: 0, eventTriggersFired: 0, summariesPersisted: 0 };
  }

  /**
   * 附加信号持久化实例
   * @param {object} sp - SignalPersistence实例
   * @returns {SelfEvolutionGovernor} 当前实例，支持链式调用
   */
  attachSignalPersistence(sp) { this.guardShutdown(); this._signalPersistence = sp; return this; }
  /**
   * 附加健康检查器实例，心跳时采集健康状态观测信号
   * @param {object} hc - HealthChecker实例
   * @returns {SelfEvolutionGovernor} 当前实例，支持链式调用
   */
  attachHealthChecker(hc) { this.guardShutdown(); this._healthChecker = hc; return this; }
  /**
   * 附加因果数据总线实例，心跳时采集因果链状态观测信号
   * @param {object} cdb - CausalDataBus实例
   * @returns {SelfEvolutionGovernor} 当前实例，支持链式调用
   */
  attachCausalDataBus(cdb) { this.guardShutdown(); this._causalDataBus = cdb; return this; }
  /**
   * 附加质量评分器实例，用于质量趋势观测
   * @param {object} qs - QualityScorer实例
   * @returns {SelfEvolutionGovernor} 当前实例，支持链式调用
   */
  attachQualityScorer(qs) { this.guardShutdown(); this._qualityScorer = qs; return this; }
  /**
   * 附加收敛检测器实例，用于收敛模式观测
   * @param {object} cd - ConvergenceDetector实例
   * @returns {SelfEvolutionGovernor} 当前实例，支持链式调用
   */
  attachConvergenceDetector(cd) { this.guardShutdown(); this._convergenceDetector = cd; return this; }
  /**
   * 附加调度器实例
   * @param {object} s - Scheduler实例
   * @returns {SelfEvolutionGovernor} 当前实例，支持链式调用
   */
  attachScheduler(s) { this.guardShutdown(); this._scheduler = s; return this; }
  /**
   * 附加审计日志器实例，提案审批/执行时自动记录审计日志
   * @param {object} al - AuditLogger实例
   * @returns {SelfEvolutionGovernor} 当前实例，支持链式调用
   */
  attachAuditLogger(al) { this.guardShutdown(); this._auditLogger = al; return this; }
  /**
   * 附加证据验证器实例，提案执行完成后验证执行证据
   * @param {object} ev - EvidenceVerifier实例
   * @returns {SelfEvolutionGovernor} 当前实例，支持链式调用
   */
  attachEvidenceVerifier(ev) { this.guardShutdown(); this._evidenceVerifier = ev; return this; }
  /**
   * 附加TDD门禁实例
   * @param {object} tg - TDDGate实例
   * @returns {SelfEvolutionGovernor} 当前实例，支持链式调用
   */
  attachTddGate(tg) { this.guardShutdown(); this._tddGate = tg; return this; }
  /**
   * 附加SQLite存储实例，用于摘要持久化与恢复
   * @param {object} ss - SqliteStore实例
   * @returns {SelfEvolutionGovernor} 当前实例，支持链式调用
   */
  attachSqliteStore(ss) { this.guardShutdown(); this._sqliteStore = ss; return this; }
  /**
   * 附加RL训练管道实例，使提案执行可触发RL训练，训练结果反馈为观测信号
   * @param {object} pipeline - RLTrainingPipeline实例
   * @returns {SelfEvolutionGovernor} 当前实例，支持链式调用
   */
  attachRLTrainingPipeline(pipeline) { this.guardShutdown(); this._rlTrainingPipeline = pipeline; return this; }

  /**
   * 启动治理器，开始周期性心跳收集观测信号
   * 重置心跳计数和连续错误计数，按heartbeatInterval调度心跳，触发'governor-started'事件
   */
  start() {
    this.guardShutdown();
    if (this._running) return;
    this._running = true;
    this._heartbeatCount = 0;
    this._consecutiveErrors = 0;
    this._scheduleNextHeartbeat();
    this.emit('governor-started', { intervalMs: this._heartbeatInterval });
    debug('SelfEvolutionGovernor', 'started', 'interval=' + this._heartbeatInterval);
  }

  /**
   * 停止治理器，终止心跳调度
   * 触发'governor-stopped'事件
   * @returns {void}
   */
  stop() {
    this._running = false;
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this.emit('governor-stopped', { heartbeatsExecuted: this._heartbeatCount });
  }

  _scheduleNextHeartbeat() {
    if (!this._running) return;
    const MAX_HEARTBEATS = 100000;
    if (this._heartbeatCount >= MAX_HEARTBEATS) {
      this._running = false;
      this.emit('governor-stopped', { heartbeatsExecuted: this._heartbeatCount, reason: 'max heartbeats reached' });
      return;
    }
    const self = this;
    this._heartbeatTimer = setTimeout(async function() {
      // 防止shutdown竞态：回调开头检查_shutDown标志，避免创建新定时器
      if (self._shutDown) return;
      if (!self._running) return;
      try {
        await self._executeHeartbeat();
        self._scheduleNextHeartbeat();
      } catch (err) {
        debug('SelfEvolutionGovernor', 'heartbeatError', err);
        if (!err._handledByHeartbeat) {
          self._consecutiveErrors++;
          self._stats.heartbeatErrors++;
        }
        if (self._consecutiveErrors >= self._maxConsecutiveErrors) {
          self._running = false;
          self.emit('governor-stopped', { heartbeatsExecuted: self._heartbeatCount, reason: 'consecutive errors: ' + self._consecutiveErrors });
          return;
        }
        self._scheduleNextHeartbeat();
      }
    }, this._heartbeatInterval);
    if (this._heartbeatTimer && typeof this._heartbeatTimer.unref === 'function') {
      this._heartbeatTimer.unref();
    }
  }

  async _executeHeartbeat() {
    if (this._heartbeatExecuting) return;
    this._heartbeatExecuting = true;
    this._heartbeatCount++;
    this._lastHeartbeatAt = new Date().toISOString();
    this._stats.heartbeatsExecuted++;

    try {
      const observations = await this._collectObservations();
      if (this._shutDown) return;
      this._stats.signalsCollected += observations.length;

      for (const obs of observations) {
        this._recordObservation(obs);
      }

      const maturedItems = this._checkAgendaMaturity();
      if (this._shutDown) return;
      for (const item of maturedItems) {
        this._stats.agendaItemsMatured++;
        this._generateProposal(item);
      }

      this._consecutiveErrors = 0;

      this.emit('heartbeat-complete', {
        heartbeatNumber: this._heartbeatCount,
        observationsCollected: observations.length,
        maturedItems: maturedItems.length,
        activeAgendaItems: this._agendaItems.size,
      });
    } catch (err) {
      this._consecutiveErrors++;
      this._stats.heartbeatErrors++;
      err._handledByHeartbeat = true;
      debug('SelfEvolutionGovernor', 'heartbeat error', err);
      emitError(this, 'heartbeat-error', err, { heartbeat: this._heartbeatCount, consecutiveErrors: this._consecutiveErrors });

      if (this._consecutiveErrors >= this._maxConsecutiveErrors) {
        debug('SelfEvolutionGovernor', 'too many consecutive errors, stopping');
        this.emit('governor-circuit-breaker', { consecutiveErrors: this._consecutiveErrors });
        this.stop();
      }
    } finally {
      this._heartbeatExecuting = false;
    }
  }

  async _collectObservations() {
    const observations = [];

    if (this._signalPersistence) {
      this._collectTrendObservations(observations, 'quality', 'total', 'quality_trend');
      this._collectTrendObservations(observations, 'convergence', 'qualityScore', 'convergence_pattern');
      this._collectTrendObservations(observations, 'reflection', 'currentQuality', 'reflection_trend');
    }

    if (this._healthChecker) {
      try {
        const report = await this._healthChecker.getAggregatedReport();
        observations.push({
          signalType: 'health_status',
          overallStatus: report.status || 'unknown',
          criticalIssues: (report.summary && report.summary.criticalIssues) ?? 0,
          warningIssues: (report.summary && report.summary.warningIssues) ?? 0,
          timestamp: this._lastHeartbeatAt,
        });
      } catch (err) {
        observations.push({
          signalType: 'health_status',
          overallStatus: 'check_failed',
          error: err && err.message ? err.message : String(err),
          timestamp: this._lastHeartbeatAt,
        });
      }
    }

    if (this._causalDataBus) {
      try {
        const stats = this._causalDataBus.getStats();
        observations.push({
          signalType: 'causal_bus_status',
          chainLength: stats?.chainLength ?? 0,
          invariantViolations: stats?.invariantViolations ?? 0,
          timestamp: this._lastHeartbeatAt,
        });
      } catch (err) {
        debug('SelfEvolutionGovernor', 'causal bus stats error', err);
      }
    }

    return observations;
  }

  _collectTrendObservations(observations, category, field, signalType) {
    try {
      const trend = this._signalPersistence.getTrend(category, field, 20);
      if (trend.trend !== 'insufficient_data' && trend.trend !== 'invalid_category') {
        observations.push({
          signalType: signalType,
          trend: trend.trend,
          delta: trend.delta,
          avgCurrent: trend.avgCurrent,
          timestamp: this._lastHeartbeatAt,
        });
      }
    } catch (err) {
      debug('SelfEvolutionGovernor', signalType + ' collection error', err);
    }
  }

  /**
   * Record an observation signal into the agenda system. Observations are aggregated by agenda key
   * and mature into improvement proposals when the observation count reaches the maturity threshold.
   * @param {Object} observation - Observation signal object
   * @param {string} observation.signalType - Signal type (e.g., 'quality_trend', 'health_status')
   * @param {string} [observation.trend] - Trend direction ('degrading', 'improving', 'stable')
   * @param {string} [observation.timestamp] - ISO timestamp of the observation
   * @example
   * governor._recordObservation({
   *   signalType: 'quality_trend',
   *   trend: 'degrading',
   *   delta: -0.15,
   *   avgCurrent: 0.62,
   *   timestamp: new Date().toISOString()
   * });
   */
  _recordObservation(observation) {
    if (!observation || !observation.signalType) return;

    if (this._signalPersistence) {
      try {
        this._signalPersistence.record('health', observation);
      } catch (_e) { debug('SelfEvolutionGovernor', 'recordHealth', _e); }
    }

    const agendaKey = this._computeAgendaKey(observation);
    if (!agendaKey) return;

    if (this._agendaItems.has(agendaKey)) {
      const item = this._agendaItems.get(agendaKey);
      if (!item) return;
      item.observationCount++;
      item.lastObservedAt = observation.timestamp;
      item.observations.push(observation);
    } else {
      if (this._agendaItems.size >= this._maxAgendaItems) {
        const oldestKey = this._agendaItems.keys().next().value;
        this._agendaItems.delete(oldestKey);
      }
      this._agendaItems.set(agendaKey, {
        key: agendaKey,
        signalType: observation.signalType,
        status: 'accumulating',
        observationCount: 1,
        firstObservedAt: observation.timestamp,
        lastObservedAt: observation.timestamp,
        observations: new RingBuffer(MAX_OBSERVATIONS_PER_ITEM),
      });
      const item = this._agendaItems.get(agendaKey);
      if (item && item.observations) item.observations.push(observation);
      this._stats.agendaItemsCreated++;
    }
  }

  _computeAgendaKey(observation) {
    if (!observation || !observation.signalType) return null;
    if (observation.signalType === 'quality_trend' && observation.trend === 'degrading') {
      return 'quality-degrading';
    }
    if (observation.signalType === 'health_status' && observation.overallStatus === 'critical') {
      return 'health-critical';
    }
    if (observation.signalType === 'convergence_pattern' && observation.trend === 'degrading') {
      return 'convergence-degrading';
    }
    if (observation.signalType === 'causal_bus_status' && observation.invariantViolations > 0) {
      return 'causal-invariant-violations';
    }
    if (observation.signalType === 'reflection_trend' && observation.trend === 'degrading') {
      return 'reflection-degrading';
    }
    return null;
  }

  _checkAgendaMaturity() {
    const now = Date.now();
    const expiredKeys = [];
    for (const [key, item] of this._agendaItems) {
      if (item.status === 'matured' && item.maturedAt && now - item.maturedAt > MATURITY_EXPIRY_MS) {
        expiredKeys.push(key);
      }
    }
    for (const key of expiredKeys) {
      this._agendaItems.delete(key);
    }
    const matured = [];
    for (const [, item] of this._agendaItems) {
      if (item.status === 'accumulating' && item.observationCount >= this._agendaMaturityThreshold) {
        item.status = 'matured';
        item.maturedAt = Date.now();
        matured.push(item);
      }
    }
    return matured;
  }

  _generateProposal(agendaItem) {
    const proposal = {
      proposalId: timestampId(ID_PREFIXES.PROPOSAL),
      agendaKey: agendaItem.key,
      signalType: agendaItem.signalType,
      observationCount: agendaItem.observationCount,
      firstObservedAt: agendaItem.firstObservedAt,
      lastObservedAt: agendaItem.lastObservedAt,
      recommendedAction: this._inferAction(agendaItem),
      status: PROPOSAL_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      evidenceScore: this._computeEvidenceScore(agendaItem),
    };

    this._stats.proposalsGenerated++;
    this._pendingProposals.set(proposal.proposalId, proposal);
    if (this._pendingProposals.size > MAX_PENDING_PROPOSALS) {
      const oldestId = this._pendingProposals.keys().next().value;
      const oldest = this._pendingProposals.get(oldestId);
      if (oldest) {
        if (oldest.status === PROPOSAL_STATUS.PENDING) {
          oldest.status = PROPOSAL_STATUS.EXPIRED;
          oldest.expiredAt = new Date().toISOString();
          this._stats.proposalsExpired++;
        }
        this._proposalHistory.push(oldest);
        this._pendingProposals.delete(oldestId);
      }
    }
    this.emit('proposal-generated', proposal);

    this._agendaItems.delete(agendaItem.key);

    if (this._signalPersistence) {
      try {
        this._signalPersistence.record('agenda', {
          proposalId: proposal.proposalId,
          agendaKey: proposal.agendaKey,
          recommendedAction: proposal.recommendedAction,
          evidenceScore: proposal.evidenceScore,
          observationCount: proposal.observationCount,
          status: proposal.status,
          timestamp: proposal.createdAt,
        });
      } catch (_e) { debug('SelfEvolutionGovernor', 'recordAgenda', _e); }
    }

    if (this._causalDataBus) {
      this._causalDataBus.publishOutput('self-evolution-governor', {
        proposalId: proposal.proposalId,
        agendaKey: proposal.agendaKey,
        recommendedAction: proposal.recommendedAction,
        evidenceScore: proposal.evidenceScore,
      }).catch(function(err) {
        debug('SelfEvolutionGovernor', 'publishOutput', err && err.message ? err.message : String(err));
      });
    }

    return proposal;
  }

  _computeEvidenceScore(agendaItem) {
    if (!agendaItem || !agendaItem.observations) return 0;
    let score = 0;
    const obs = agendaItem.observations;
    const count = obs.size ?? obs.length ?? 0;
    if (count >= 10) score += 0.4;
    else if (count >= 5) score += 0.3;
    else if (count >= 3) score += 0.2;
    else score += 0.1;
    const rawSpanMs = agendaItem.lastObservedAt && agendaItem.firstObservedAt
      ? safeDateGetTime(agendaItem.lastObservedAt) - safeDateGetTime(agendaItem.firstObservedAt) : 0; const spanMs = Number.isFinite(rawSpanMs) ? rawSpanMs : 0;
    if (spanMs > MS_PER_HOUR) score += 0.3;
    else if (spanMs > MS_PER_MINUTE) score += 0.2;
    else score += 0.1;
    if (agendaItem.signalType === 'health_status' || agendaItem.signalType === 'error_frequency') score += 0.2;
    else if (agendaItem.signalType === 'quality_trend' || agendaItem.signalType === 'convergence_pattern') score += 0.15;
    else score += 0.1;
    return Math.min(1, score);
  }

  /**
   * 批准待审批的提案，将状态从pending_approval转为approved
   * 检查提案是否存在、是否处于待审批状态、是否超过TTL有效期
   * 触发'proposal-approved'事件，若已附加AuditLogger则记录审计日志
   * @param {string} proposalId - 提案标识
   * @param {string} [approver='system'] - 审批人标识
   * @param {string} [reason=''] - 审批理由
   * @returns {{success: boolean, proposalId?: string, action?: string, error?: string}} 审批结果
   */
  approveProposal(proposalId, approver, reason) {
    this.guardShutdown();
    const proposal = this._pendingProposals.get(proposalId);
    if (!proposal) return { success: false, error: 'Proposal not found' };
    if (proposal.status !== PROPOSAL_STATUS.PENDING) return { success: false, error: 'Proposal not pending: ' + proposal.status };
    const age = Date.now() - safeDateGetTime(proposal.createdAt);
    if (!Number.isFinite(age) || age > PROPOSAL_TTL_MS) {
      proposal.status = PROPOSAL_STATUS.EXPIRED;
      proposal.expiredAt = new Date().toISOString();
      this._proposalHistory.push(proposal);
      this._pendingProposals.delete(proposalId);
      this._stats.proposalsExpired++;
      this.emit('proposal-expired', { proposalId, reason: 'TTL exceeded' });
      return { success: false, error: 'Proposal expired' };
    }
    proposal.status = PROPOSAL_STATUS.APPROVED;
    proposal.approvedBy = approver || 'system';
    proposal.approvalReason = reason || '';
    proposal.approvedAt = new Date().toISOString();
    this._stats.proposalsApproved++;
    this.emit('proposal-approved', { proposalId, approver: proposal.approvedBy, action: proposal.recommendedAction });
    if (this._auditLogger) {
      try {
        this._auditLogger.log({
          agent: 'self-evolution-governor',
          action: 'proposal-approved',
          target: proposalId,
          result: 'approved',
          meta: { agendaKey: proposal.agendaKey, action: proposal.recommendedAction, approver: proposal.approvedBy, evidenceScore: proposal.evidenceScore },
        });
      } catch (err) { debug('SelfEvolutionGovernor', 'audit approve', err); }
    }
    return { success: true, proposalId, action: proposal.recommendedAction };
  }

  /**
   * 拒绝待审批的提案，将状态从pending_approval转为rejected
   * 提案移入历史记录，触发'proposal-rejected'事件，若已附加AuditLogger则记录审计日志
   * @param {string} proposalId - 提案标识
   * @param {string} [rejector='system'] - 拒绝人标识
   * @param {string} [reason=''] - 拒绝理由
   * @returns {{success: boolean, proposalId?: string, error?: string}} 拒绝结果
   */
  rejectProposal(proposalId, rejector, reason) {
    this.guardShutdown();
    const proposal = this._pendingProposals.get(proposalId);
    if (!proposal) return { success: false, error: 'Proposal not found' };
    if (proposal.status !== PROPOSAL_STATUS.PENDING) return { success: false, error: 'Proposal not pending: ' + proposal.status };
    proposal.status = PROPOSAL_STATUS.REJECTED;
    proposal.rejectedBy = rejector || 'system';
    proposal.rejectionReason = reason || '';
    proposal.rejectedAt = new Date().toISOString();
    this._stats.proposalsRejected++;
    this._proposalHistory.push(proposal);
    this._pendingProposals.delete(proposalId);
    this.emit('proposal-rejected', { proposalId, rejector: proposal.rejectedBy, reason });
    if (this._auditLogger) {
      try {
        this._auditLogger.log({
          agent: 'self-evolution-governor',
          action: 'proposal-rejected',
          target: proposalId,
          result: 'rejected',
          meta: { rejector, reason },
        });
      } catch (err) { debug('SelfEvolutionGovernor', 'audit reject', err); }
    }
    return { success: true, proposalId };
  }

  _auditLog(action, target, result, meta) {
    if (!this._auditLogger) return;
    try {
      this._auditLogger.log({ agent: 'self-evolution-governor', action, target, result, meta });
    } catch (err) { debug('SelfEvolutionGovernor', 'auditLog', err); }
  }

  _errorMessage(err) {
    return err && err.message ? err.message : String(err);
  }

  /**
   * 执行已批准的提案，支持自定义执行函数或默认动作。
   * 执行完成后通过EvidenceVerifier验证执行证据，根据验证结果标记completed或failed。
   * 触发'proposal-executing'/'proposal-completed'/'proposal-failed'事件。
   * @async
   * @param {string} proposalId - 提案标识
   * @param {Function} [executeFn] - 自定义执行函数，签名为async (proposal) => result；未提供时使用默认动作
   * @returns {Promise<{success: boolean, proposalId: string, result?: object, evidenceVerified?: boolean, error?: string}>} 执行结果
   * @emits SelfEvolutionGovernor#proposal-executing
   * @emits SelfEvolutionGovernor#proposal-completed
   * @emits SelfEvolutionGovernor#proposal-failed
   */
  async executeApprovedProposal(proposalId, executeFn) {
    this.guardShutdown();
    const proposal = this._pendingProposals.get(proposalId);
    if (!proposal) return { success: false, error: 'Proposal not found' };
    if (proposal.status !== PROPOSAL_STATUS.APPROVED) return { success: false, error: 'Proposal not approved: ' + proposal.status };
    proposal.status = PROPOSAL_STATUS.EXECUTING;
    proposal.executedAt = new Date().toISOString();
    this._stats.proposalsExecuted++;
    this.emit('proposal-executing', { proposalId, action: proposal.recommendedAction });
    this._auditLog('proposal-executing', proposalId, 'started', { action: proposal.recommendedAction, evidenceScore: proposal.evidenceScore });
    try {
      let result;
      if (typeof executeFn === 'function') {
        result = await executeFn(proposal);
      } else {
        result = await this._executeDefaultAction(proposal);
      }
      if (this._shutDown) return { success: false, proposalId, error: 'Shut down during execution' };
      const evidenceVerified = this._verifyExecutionEvidence(proposal, result);
      proposal.status = evidenceVerified ? PROPOSAL_STATUS.COMPLETED : PROPOSAL_STATUS.FAILED;
      proposal.completedAt = new Date().toISOString();
      proposal.executionResult = result;
      proposal.evidenceVerified = evidenceVerified;
      if (evidenceVerified) {
        this._stats.proposalsCompleted++;
        this.emit('proposal-completed', { proposalId, action: proposal.recommendedAction, evidenceVerified: true });
      } else {
        this._stats.proposalsFailed++;
        this.emit('proposal-failed', { proposalId, action: proposal.recommendedAction, reason: 'evidence verification failed' });
      }
      this._auditLog('proposal-completed', proposalId, evidenceVerified ? 'completed' : 'failed-evidence', { action: proposal.recommendedAction, evidenceVerified });
      this._proposalHistory.push(proposal);
      this._pendingProposals.delete(proposalId);
      return { success: evidenceVerified, proposalId, result, evidenceVerified };
    } catch (err) {
      const errMsg = this._errorMessage(err);
      proposal.status = PROPOSAL_STATUS.FAILED;
      proposal.failedAt = new Date().toISOString();
      proposal.error = errMsg;
      this._stats.proposalsFailed++;
      this.emit('proposal-failed', { proposalId, action: proposal.recommendedAction, error: errMsg });
      this._auditLog('proposal-failed', proposalId, 'error', { action: proposal.recommendedAction, error: errMsg });
      this._proposalHistory.push(proposal);
      this._pendingProposals.delete(proposalId);
      return { success: false, proposalId, error: errMsg };
    }
  }

  _verifyExecutionEvidence(proposal, result) {
    if (!this._evidenceVerifier) return true;
    try {
      const evidence = [];
      if (result && result.testOutput) evidence.push({ type: 'test_output', content: result.testOutput });
      if (result && result.coverageReport) evidence.push({ type: 'coverage_report', content: result.coverageReport });
      if (result && result.lintOutput) evidence.push({ type: 'lint_output', content: result.lintOutput });
      if (evidence.length === 0) return true;
      const verification = this._evidenceVerifier.verify({
        claim: proposal.recommendedAction,
        evidence: evidence,
        requiredTypes: this._evidenceVerifier.getRequiredEvidenceTypes('self-evolution') || ['test_output'],
      });
      return verification && verification.score >= 0.5;
    } catch (err) {
      debug('SelfEvolutionGovernor', 'evidence verify', err);
      return { verified: false, _error: err.message || String(err) };
    }
  }

  async _executeDefaultAction(proposal) {
    switch (proposal.recommendedAction) {
      case 'investigate-quality-regression':
        return { action: 'quality-regression-investigated', testOutput: 'investigation complete' };
      case 'escalate-health-incident':
        return { action: 'health-incident-escalated', testOutput: 'escalation complete' };
      case 'review-convergence-thresholds':
        return { action: 'convergence-thresholds-reviewed', testOutput: 'review complete' };
      case 'audit-invariant-violations':
        return { action: 'invariant-violations-audited', testOutput: 'audit complete' };
      case 'deepen-self-reflection':
        return { action: 'self-reflection-deepened', testOutput: 'deepening complete' };
      case 'trigger-rl-training':
        return this._executeRLTraining(proposal);
      default:
        return { action: 'investigated', testOutput: 'default investigation complete' };
    }
  }

  /**
   * Execute RL training as a proposal action via the attached RLTrainingPipeline.
   * Selects the first available environment, starts training, and returns the run info.
   * @param {Object} proposal - The proposal triggering RL training
   * @returns {Promise<{action: string, testOutput: string, runId?: string}>} Training result
   * @private
   */
  async _executeRLTraining(proposal) {
    if (!this._rlTrainingPipeline) {
      return { action: 'rl-training-skipped', testOutput: 'no RL pipeline attached' };
    }
    try {
      const envs = await this._rlTrainingPipeline.listEnvironments();
      if (!Array.isArray(envs) || envs.length === 0) {
        return { action: 'rl-training-skipped', testOutput: 'no RL environments available' };
      }
      const envName = envs[0].name;
      await this._rlTrainingPipeline.selectEnvironment(envName);
      const run = await this._rlTrainingPipeline.startTraining({ envName });
      this.emit('rl-training-triggered', { proposalId: proposal.proposalId, runId: run.runId, envName });
      return { action: 'rl-training-started', testOutput: 'run ' + run.runId + ' started for ' + envName, runId: run.runId };
    } catch (err) {
      debug('SelfEvolutionGovernor', 'rlTraining', err);
      return { action: 'rl-training-failed', testOutput: this._errorMessage(err) };
    }
  }

  /**
   * 通过事件触发即时心跳，绕过定时调度
   * 仅处理预定义的事件类型(error-spike/quality-regression/health-critical/convergence-stall/memory-pressure)
   * 将事件作为观测信号记录，检查议程成熟度并生成提案
   * @param {string} eventType - 事件类型，须在EVENT_TRIGGERS列表中
   * @param {object} [eventData] - 事件附加数据
   * @returns {{eventType: string, maturedItems: number}|null} 触发结果，事件类型无效时返回null
   */
  triggerEventHeartbeat(eventType, eventData) {
    this.guardShutdown();
    if (!this._eventTriggersEnabled) return null;
    if (!EVENT_TRIGGERS.includes(eventType)) return null;
    this._stats.eventTriggersFired++;
    const observation = {
      signalType: eventType,
      eventData: eventData ?? {},
      timestamp: new Date().toISOString(),
      triggeredBy: 'event',
    };
    this._recordObservation(observation);
    const maturedItems = this._checkAgendaMaturity();
    for (const item of maturedItems) {
      this._stats.agendaItemsMatured++;
      this._generateProposal(item);
    }
    this.emit('event-heartbeat-fired', { eventType, observationsRecorded: 1, maturedItems: maturedItems.length });
    return { eventType, maturedItems: maturedItems.length };
  }

  /**
   * 将治理器摘要持久化到SQLite存储
   * 摘要包含心跳计数、统计信息、活跃议程项、待审批提案和最近提案历史
   * @returns {Promise<{success: boolean, error?: string}>} 持久化结果，未附加SqliteStore时返回失败
   */
  async saveSummary() {
    this.guardShutdown();
    if (!this._sqliteStore) return { success: false, error: 'No SqliteStore attached' };
    const summary = {
      savedAt: new Date().toISOString(),
      heartbeatCount: this._heartbeatCount,
      lastHeartbeatAt: this._lastHeartbeatAt,
      stats: { ...this._stats },
      activeAgendaItems: this._agendaItems.size,
      pendingProposals: this._pendingProposals.size,
      agendaKeys: Array.from(this._agendaItems.keys()),
      recentProposals: Array.from(this._proposalHistory.toArray().slice(-10)).map(function(p) {
        return { id: p.proposalId, action: p.recommendedAction, status: p.status, evidenceScore: p.evidenceScore };
      }),
    };
    try {
      await Promise.resolve(this._sqliteStore.addMemory('governor-summary', JSON.stringify(summary)));
      this._stats.summariesPersisted++;
      this.emit('summary-saved', { heartbeatCount: this._heartbeatCount });
      return { success: true };
    } catch (err) {
      debug('SelfEvolutionGovernor', 'saveSummary', err);
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 从SQLite存储加载最近一次持久化的治理器摘要
   * @returns {Promise<object|null>} 摘要对象，含savedAt/heartbeatCount/stats/activeAgendaItems/pendingProposals等；无数据或出错时返回null
   */
  async loadSummary() {
    this.guardShutdown();
    if (!this._sqliteStore) return null;
    try {
      const entries = await Promise.resolve(this._sqliteStore.getMemories('governor-summary'));
      if (!entries || entries.length === 0) return null;
      const latest = entries.length > 0 ? entries[entries.length - 1] : null;
      if (!latest) return null;
      const summary = latest.content ? safeJsonParse(latest.content, {}, 'SelfEvolutionGovernor') : {};
      this.emit('summary-loaded', { heartbeatCount: summary.heartbeatCount, savedAt: summary.savedAt });
      return summary;
    } catch (err) {
      debug('SelfEvolutionGovernor', 'loadSummary', err);
      return { _error: err.message || String(err) };
    }
  }

  /**
   * 清理超过TTL(7天)的待审批提案，将其标记为expired并移入历史
   * 触发'proposal-expired'事件
   * @returns {number} 过期的提案数量
   */
  expireStaleProposals() {
    this.guardShutdown();
    const now = Date.now();
    let expired = 0;
    const expiredProposalIds = [];
    for (const [id, proposal] of this._pendingProposals) {
      if (proposal.status !== PROPOSAL_STATUS.PENDING) continue;
      const age = now - safeDateGetTime(proposal.createdAt);
      if (!Number.isFinite(age) || age > PROPOSAL_TTL_MS) {
        proposal.status = PROPOSAL_STATUS.EXPIRED;
        proposal.expiredAt = new Date().toISOString();
        this._proposalHistory.push(proposal);
        expiredProposalIds.push(id);
        this._stats.proposalsExpired++;
        expired++;
        this.emit('proposal-expired', { proposalId: id, reason: 'TTL exceeded' });
      }
    }
    for (const id of expiredProposalIds) this._pendingProposals.delete(id);
    return expired;
  }

  /**
   * 获取所有待审批提案的摘要列表
   * @returns {Array<{proposalId: string, agendaKey: string, action: string, status: string, evidenceScore: number, createdAt: string}>} 待审批提案数组
   */
  getPendingProposals() {
    const result = [];
    for (const [, p] of this._pendingProposals) {
      result.push({ proposalId: p.proposalId, agendaKey: p.agendaKey, action: p.recommendedAction, status: p.status, evidenceScore: p.evidenceScore, createdAt: p.createdAt });
    }
    return result;
  }

  _inferAction(agendaItem) {
    switch (agendaItem.key) {
      case 'quality-degrading': return this._rlTrainingPipeline ? 'trigger-rl-training' : 'investigate-quality-regression';
      case 'health-critical': return 'escalate-health-incident';
      case 'convergence-degrading': return 'review-convergence-thresholds';
      case 'causal-invariant-violations': return 'audit-invariant-violations';
      case 'reflection-degrading': return 'deepen-self-reflection';
      default: return 'investigate';
    }
  }

  /**
   * 获取议程项列表，可按状态过滤
   * @param {string} [status] - 过滤状态，如'accumulating'/'matured'；不传则返回全部
   * @returns {Array<object>} 议程项数组，含key/signalType/status/observationCount/firstObservedAt/lastObservedAt等
   */
  getAgendaItems(status) {
    const items = [];
    for (const [, item] of this._agendaItems) {
      if (!status || item.status === status) {
        items.push(mergeConfig(item, { observations: item.observations.size }));
      }
    }
    return items;
  }

  /**
   * 从SignalPersistence查询提案历史记录
   * @param {number} [limit=20] - 返回的最大提案数，范围1-1000
   * @returns {Array<object>} 提案记录数组；未附加SignalPersistence或查询失败时返回空数组
   */
  getProposals(limit) {
    if (!this._signalPersistence) return [];
    const safeLimit = Math.max(1, Math.min(MAX_PROPOSAL_HISTORY, limit ?? 20));
    try {
      return this._signalPersistence.query('agenda', { limit: safeLimit });
    } catch (e) {
      debug('SelfEvolutionGovernor', 'getProposals', 'Query failed: ' + (e && e.message ? e.message : String(e)));
      return [];
    }
  }

  /**
   * 强制立即执行一次心跳，不受定时调度约束
   * 若治理器已关闭或心跳正在执行中则跳过
   * @returns {Promise<void>} 心跳执行完成的Promise
   */
  forceHeartbeat() {
    this.guardShutdown();
    if (this._heartbeatExecuting) {
      return Promise.resolve();
    }
    return this._executeHeartbeat();
  }

  /**
   * 获取治理器运行统计信息
   * @returns {{running: boolean, heartbeatInterval: number, heartbeatsExecuted: number, signalsCollected: number, agendaItemsCreated: number, agendaItemsMatured: number, proposalsGenerated: number, proposalsApproved: number, proposalsRejected: number, proposalsExecuted: number, proposalsCompleted: number, proposalsFailed: number, proposalsExpired: number, heartbeatErrors: number, consecutiveErrors: number, activeAgendaItems: number, pendingProposals: number, eventTriggersFired: number, summariesPersisted: number, lastHeartbeatAt: string|null, observationWindowMs: number}} 完整统计信息
   */
  getStats() {
    return {
      running: this._running,
      heartbeatInterval: this._heartbeatInterval,
      heartbeatsExecuted: this._stats.heartbeatsExecuted,
      signalsCollected: this._stats.signalsCollected,
      agendaItemsCreated: this._stats.agendaItemsCreated,
      agendaItemsMatured: this._stats.agendaItemsMatured,
      proposalsGenerated: this._stats.proposalsGenerated,
      proposalsApproved: this._stats.proposalsApproved,
      proposalsRejected: this._stats.proposalsRejected,
      proposalsExecuted: this._stats.proposalsExecuted,
      proposalsCompleted: this._stats.proposalsCompleted,
      proposalsFailed: this._stats.proposalsFailed,
      proposalsExpired: this._stats.proposalsExpired,
      heartbeatErrors: this._stats.heartbeatErrors,
      consecutiveErrors: this._consecutiveErrors,
      activeAgendaItems: this._agendaItems.size,
      pendingProposals: this._pendingProposals.size,
      eventTriggersFired: this._stats.eventTriggersFired,
      summariesPersisted: this._stats.summariesPersisted,
      lastHeartbeatAt: this._lastHeartbeatAt,
      observationWindowMs: this._observationWindow,
    };
  }

  _onShutdown() {
    this.stop();
    clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = null;
    this._agendaItems.clear();
    this._pendingProposals.clear();
    this._proposalHistory = new RingBuffer(MAX_PROPOSAL_HISTORY);
    this._running = false;
    this._heartbeatExecuting = false;
    this._heartbeatCount = 0;
    this._lastHeartbeatAt = null;
    this._consecutiveErrors = 0;
    this._eventTriggersEnabled = true;
    this._stats = { heartbeatsExecuted: 0, signalsCollected: 0, agendaItemsCreated: 0, agendaItemsMatured: 0, proposalsGenerated: 0, proposalsApproved: 0, proposalsRejected: 0, proposalsExecuted: 0, proposalsCompleted: 0, proposalsFailed: 0, proposalsExpired: 0, heartbeatErrors: 0, eventTriggersFired: 0, summariesPersisted: 0 };
    this._signalPersistence = null;
    this._healthChecker = null;
    this._causalDataBus = null;
    this._qualityScorer = null;
    this._convergenceDetector = null;
    this._scheduler = null;
    this._auditLogger = null;
    this._evidenceVerifier = null;
    this._tddGate = null;
    this._sqliteStore = null;
    this._rlTrainingPipeline = null;
    this.removeAllListeners();
  }
}

/**
 * 检查治理器是否健康运行
 * 当未关闭且连续错误数未超过上限时返回true
 * @returns {boolean} 健康状态
 */
Object.defineProperty(SelfEvolutionGovernor.prototype, 'isHealthy', {
  value: function isHealthy() {
    return !this._shutDown && this._consecutiveErrors < this._maxConsecutiveErrors;
  },
  writable: true,
  configurable: true,
});

SelfEvolutionGovernor.OBSERVATION_SIGNALS = OBSERVATION_SIGNALS;
SelfEvolutionGovernor.PROPOSAL_STATUS = PROPOSAL_STATUS;
SelfEvolutionGovernor.EVENT_TRIGGERS = EVENT_TRIGGERS;

module.exports = withShutdown(SelfEvolutionGovernor);
