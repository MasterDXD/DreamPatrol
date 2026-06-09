'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const BoundedArray = require('../../utils/bounded-array');

/**
 * 交付瓶颈等级
 * @readonly
 * @enum {string}
 */
const BOTTLENECK_LEVEL = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/**
 * 工作流模式
 * @readonly
 * @enum {string}
 */
const WORKFLOW_MODE = {
  STANDARD: 'standard',
  ARCHITECTURE_FIRST: 'architecture-first',
  AI_WRITE_TEST_FIX: 'ai-write-test-fix',
  HUMAN_REVIEW_DECIDE: 'human-review-decide',
};

/**
 * 瓶颈类型
 * @readonly
 * @enum {string}
 */
const BOTTLENECK_TYPE = {
  REVIEW_THROUGHPUT: 'review-throughput',
  ALMOST_CORRECT_CODE: 'almost-correct-code',
  UNDERSTANDING_DEBT: 'understanding-debt',
  CONTEXT_DRIFT: 'context-drift',
  ARCHITECTURE_MISMATCH: 'architecture-mismatch',
  PIPELINE_BLOCKAGE: 'pipeline-blockage',
};

/**
 * @module runtime/quality/delivery-acceleration-orchestrator
 * 交付加速编排器
 * @classdesc 交付加速编排器。6类瓶颈检测（审查吞吐失衡/似对非对代码/理解债务/上下文漂移/架构不匹配/管道阻塞），架构先行门禁，4种工作流模式，8个attach*()依赖注入，7个API端点。
 * 解决"AI只加速编码20%，交付瓶颈在其余80%"的核心问题。
 *
 * 融合现有8个模块的统一编排层：
 * - DeliveryEfficiencyMeter（效率度量）
 * - AiCodeTrustScorer（AI代码可信度）
 * - ComprehensionDebtTracker（理解债务）
 * - ContextDriftMonitor（上下文漂移）
 * - AgentDebugLoop（自调试闭环）
 * - CodeReviewFrameworkCheck（代码审查框架）
 * - PhaseOrchestrator（阶段编排）
 * - SddContractManager（SDD合约管理）
 *
 * 三大核心能力：
 * 1. 瓶颈诊断 — 自动检测6类交付瓶颈，量化严重度
 * 2. 架构先行 — 强制"先定架构再写码"，减少返工
 * 3. 工作流重构 — AI负责"写+测+修"，人聚焦"需求+架构+决策"
 *
 * @extends EventEmitter
 * @deprecated 孤立模块 - 未被任何文件引用，计划在下一版本移除
 */
class DeliveryAccelerationOrchestrator extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {boolean} [options.architectureFirst=true] - 启用架构先行模式
   * @param {boolean} [options.autoDetectBottleneck=true] - 自动检测瓶颈
   * @param {number} [options.bottleneckCheckIntervalMs=60000] - 瓶颈检测间隔
   * @param {number} [options.maxHistorySize=100] - 历史记录上限
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._architectureFirst = opts.architectureFirst !== false;
    this._autoDetectBottleneck = opts.autoDetectBottleneck !== false;
    this._bottleneckCheckIntervalMs = typeof opts.bottleneckCheckIntervalMs === 'number' && opts.bottleneckCheckIntervalMs > 0
      ? opts.bottleneckCheckIntervalMs : 60000;
    this._maxHistorySize = typeof opts.maxHistorySize === 'number' && opts.maxHistorySize > 0
      ? Math.min(opts.maxHistorySize, 500) : 100;

    // 依赖注入的模块引用
    this._deliveryMeter = null;
    this._trustScorer = null;
    this._debtTracker = null;
    this._driftMonitor = null;
    this._debugLoop = null;
    this._reviewCheck = null;
    this._phaseOrchestrator = null;
    this._sddContract = null;

    // 内部状态
    this._currentMode = WORKFLOW_MODE.STANDARD;
    this._bottleneckHistory = new BoundedArray(this._maxHistorySize);
    this._lastDiagnosis = null;
    this._checkTimer = null;
    this._stats = {
      totalDiagnoses: 0,
      bottlenecksDetected: 0,
      modeSwitches: 0,
      architectureFirstEnforcements: 0,
      autoDebugTriggers: 0,
      debtEscalations: 0,
    };
  }

  // ─── 依赖注入（8个attach点） ──────────────────────────────

  /** 附加交付效率度量器 */
  attachDeliveryEfficiencyMeter(meter) {
    if (meter && typeof meter.getReviewBottleneckScore === 'function') {
      this._deliveryMeter = meter;
    }
    return this;
  }

  /** 附加AI代码可信度评估器 */
  attachAiCodeTrustScorer(scorer) {
    if (scorer && typeof scorer.assess === 'function') {
      this._trustScorer = scorer;
    }
    return this;
  }

  /** 附加理解债务追踪器 */
  attachComprehensionDebtTracker(tracker) {
    if (tracker && typeof tracker.calculateDebtScore === 'function') {
      this._debtTracker = tracker;
    }
    return this;
  }

  /** 附加上下文漂移监控器 */
  attachContextDriftMonitor(monitor) {
    if (monitor && typeof monitor.checkDrift === 'function') {
      this._driftMonitor = monitor;
    }
    return this;
  }

  /** 附加Agent自调试闭环 */
  attachAgentDebugLoop(debugLoop) {
    if (debugLoop && typeof debugLoop.execute === 'function') {
      this._debugLoop = debugLoop;
    }
    return this;
  }

  /** 附加代码审查框架检查器 */
  attachCodeReviewFrameworkCheck(check) {
    if (check && typeof check.runChecklist === 'function') {
      this._reviewCheck = check;
    }
    return this;
  }

  /** 附加阶段编排器 */
  attachPhaseOrchestrator(orchestrator) {
    if (orchestrator && typeof orchestrator.setCurrentPhase === 'function') {
      this._phaseOrchestrator = orchestrator;
    }
    return this;
  }

  /** 附加SDD合约管理器 */
  attachSddContractManager(manager) {
    if (manager && typeof manager.advanceStage === 'function') {
      this._sddContract = manager;
    }
    return this;
  }

  // ─── 核心能力1：瓶颈诊断 ──────────────────────────────────

  /**
   * 执行全面的交付瓶颈诊断。检测6类瓶颈，量化严重度，推荐缓解策略。
   * @returns {{bottlenecks: Array, overallLevel: string, recommendations: Array, diagnosisTimeMs: number}}
   */
  diagnoseBottlenecks() {
    this.guardShutdown();
    const startTime = Date.now();
    const bottlenecks = [];

    // 检测1：审查吞吐失衡
    bottlenecks.push(this._detectReviewThroughputBottleneck());

    // 检测2："似对非对"代码
    bottlenecks.push(this._detectAlmostCorrectBottleneck());

    // 检测3：理解债务
    bottlenecks.push(this._detectUnderstandingDebtBottleneck());

    // 检测4：上下文漂移
    bottlenecks.push(this._detectContextDriftBottleneck());

    // 检测5：架构不匹配
    bottlenecks.push(this._detectArchitectureMismatchBottleneck());

    // 检测6：管道阻塞
    bottlenecks.push(this._detectPipelineBlockage());

    // 过滤有效瓶颈，计算总体等级
    const activeBottlenecks = bottlenecks.filter(function(b) { return b.level !== BOTTLENECK_LEVEL.NONE; });
    const overallLevel = this._calculateOverallLevel(activeBottlenecks);

    // 生成推荐策略
    const recommendations = this._generateRecommendations(activeBottlenecks);

    const diagnosis = {
      bottlenecks: activeBottlenecks,
      overallLevel: overallLevel,
      recommendations: recommendations,
      diagnosisTimeMs: Date.now() - startTime,
      diagnosedAt: new Date().toISOString(),
    };

    this._lastDiagnosis = diagnosis;
    this._bottleneckHistory.push(diagnosis);
    this._stats.totalDiagnoses++;
    this._stats.bottlenecksDetected += activeBottlenecks.length;

    this.emit('diagnosis-completed', diagnosis);
    return diagnosis;
  }

  // ─── 核心能力2：架构先行 ──────────────────────────────────

  /**
   * 检查是否满足架构先行条件。在architecture-first模式下，
   * 必须先完成架构阶段（SDD合约spec+design阶段）才能进入编码。
   * @returns {{allowed: boolean, reason: string, missingSpecs: Array, currentPhase: string|null}}
   */
  checkArchitectureFirstGate() {
    this.guardShutdown();
    if (!this._architectureFirst) {
      return { allowed: true, reason: 'Architecture-first mode disabled', missingSpecs: [], currentPhase: null };
    }

    const currentPhase = this._phaseOrchestrator ? this._phaseOrchestrator.getCurrentPhase() : null;

    // 如果还没到development阶段，允许通过
    if (!currentPhase || currentPhase === 'exploration' || currentPhase === 'analysis' || currentPhase === 'architecture') {
      return { allowed: true, reason: 'Pre-development phase', missingSpecs: [], currentPhase: currentPhase };
    }

    // development及以后阶段，检查SDD合约是否完成spec+design
    const missingSpecs = [];
    if (this._sddContract) {
      try {
        const contracts = this._sddContract.listContracts();
        if (!Array.isArray(contracts) || contracts.length === 0) {
          missingSpecs.push('No SDD contract exists');
        } else {
          const active = contracts.find(function(c) { return c && c.status === 'ACTIVE'; });
          if (!active) {
            missingSpecs.push('No active SDD contract');
          } else if (active.currentStage === 'propose') {
            missingSpecs.push('SDD contract stuck at propose stage');
          } else if (active.currentStage === 'spec') {
            missingSpecs.push('SDD contract spec stage not completed (design stage required)');
          }
        }
      } catch (_e) {
        missingSpecs.push('SDD contract check failed');
      }
    } else {
      missingSpecs.push('SddContractManager not attached');
    }

    const allowed = missingSpecs.length === 0;
    if (!allowed) {
      this._stats.architectureFirstEnforcements++;
      this.emit('architecture-first-blocked', { missingSpecs, currentPhase });
    }

    return { allowed: allowed, reason: allowed ? 'Architecture-first gate passed' : 'Architecture specs not completed', missingSpecs: missingSpecs, currentPhase: currentPhase };
  }

  // ─── 核心能力3：工作流重构 ──────────────────────────────────

  /**
   * 切换工作流模式
   * @param {string} mode - 目标模式（WORKFLOW_MODE枚举）
   * @returns {{switched: boolean, previousMode: string, currentMode: string}}
   */
  switchWorkflowMode(mode) {
    this.guardShutdown();
    if (!Object.values(WORKFLOW_MODE).includes(mode)) {
      return { switched: false, previousMode: this._currentMode, currentMode: this._currentMode };
    }
    const previousMode = this._currentMode;
    this._currentMode = mode;
    this._stats.modeSwitches++;
    this.emit('workflow-mode-changed', { previousMode: previousMode, currentMode: mode });
    return { switched: true, previousMode: previousMode, currentMode: mode };
  }

  /**
   * 获取当前工作流模式
   * @returns {string}
   */
  getWorkflowMode() {
    return this._currentMode;
  }

  /**
   * 根据瓶颈诊断自动推荐最佳工作流模式
   * @returns {{recommendedMode: string, reason: string}}
   */
  recommendWorkflowMode() {
    if (!this._lastDiagnosis) {
      return { recommendedMode: WORKFLOW_MODE.STANDARD, reason: 'No diagnosis available' };
    }

    const bottlenecks = this._lastDiagnosis.bottlenecks ?? [];
    const hasReviewBottleneck = bottlenecks.some(function(b) { return b.type === BOTTLENECK_TYPE.REVIEW_THROUGHPUT && b.level !== BOTTLENECK_LEVEL.NONE; });
    const hasAlmostCorrect = bottlenecks.some(function(b) { return b.type === BOTTLENECK_TYPE.ALMOST_CORRECT_CODE && b.level !== BOTTLENECK_LEVEL.NONE; });
    const hasArchMismatch = bottlenecks.some(function(b) { return b.type === BOTTLENECK_TYPE.ARCHITECTURE_MISMATCH && b.level !== BOTTLENECK_LEVEL.NONE; });

    if (hasArchMismatch) {
      return { recommendedMode: WORKFLOW_MODE.ARCHITECTURE_FIRST, reason: 'Architecture mismatch detected - enforce architecture-first workflow' };
    }
    if (hasReviewBottleneck || hasAlmostCorrect) {
      return { recommendedMode: WORKFLOW_MODE.AI_WRITE_TEST_FIX, reason: 'Review bottleneck or almost-correct code detected - AI handles write+test+fix cycle' };
    }
    return { recommendedMode: WORKFLOW_MODE.HUMAN_REVIEW_DECIDE, reason: 'No critical bottlenecks - human focuses on review and decisions' };
  }

  // ─── 自动瓶颈检测 ──────────────────────────────────────────

  /**
   * 启动自动瓶颈检测
   */
  startAutoDetection() {
    if (!this._autoDetectBottleneck || this._checkTimer) return;
    this._checkTimer = setInterval(function() {
      if (this._shutDown) return;
      try { this.diagnoseBottlenecks(); } catch (_e) {
        debug('DeliveryAcceleration', 'autoDetection', _e && _e.message ? _e.message : String(_e));
      }
    }.bind(this), this._bottleneckCheckIntervalMs);
    if (this._checkTimer && typeof this._checkTimer.unref === 'function') {
      this._checkTimer.unref();
    }
    this.emit('auto-detection-started');
  }

  /**
   * 停止自动瓶颈检测
   */
  stopAutoDetection() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
    this.emit('auto-detection-stopped');
  }

  // ─── 统计与状态 ────────────────────────────────────────────

  /**
   * 获取统计信息
   * @returns {object}
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { totalDiagnoses: 0, bottlenecksDetected: 0, modeSwitches: 0 };
    }
    return {
      totalDiagnoses: this._stats.totalDiagnoses,
      bottlenecksDetected: this._stats.bottlenecksDetected,
      modeSwitches: this._stats.modeSwitches,
      architectureFirstEnforcements: this._stats.architectureFirstEnforcements,
      autoDebugTriggers: this._stats.autoDebugTriggers,
      debtEscalations: this._stats.debtEscalations,
      currentMode: this._currentMode,
      architectureFirstEnabled: this._architectureFirst,
      autoDetectionRunning: !!this._checkTimer,
      attachedModules: {
        deliveryMeter: !!this._deliveryMeter,
        trustScorer: !!this._trustScorer,
        debtTracker: !!this._debtTracker,
        driftMonitor: !!this._driftMonitor,
        debugLoop: !!this._debugLoop,
        reviewCheck: !!this._reviewCheck,
        phaseOrchestrator: !!this._phaseOrchestrator,
        sddContract: !!this._sddContract,
      },
      lastDiagnosisAt: this._lastDiagnosis ? this._lastDiagnosis.diagnosedAt : null,
    };
  }

  /**
   * 获取最近一次诊断结果
   * @returns {object|null}
   */
  getLastDiagnosis() {
    return this._lastDiagnosis;
  }

  /**
   * 获取交付效率概览
   * @returns {object}
   */
  // eslint-disable-next-line complexity
  getDeliveryOverview() {
    const overview = {
      codingRatio: 0.2,
      aiAccelerationRatio: 0,
      reviewBottleneckScore: 0,
      debtScore: 0,
      driftLevel: BOTTLENECK_LEVEL.NONE,
      trustLevel: 'unknown',
      pipelineBottleneck: null,
    };

    if (this._deliveryMeter) {
      try {
        overview.codingRatio = this._deliveryMeter.getCodingRatio();
        overview.aiAccelerationRatio = this._deliveryMeter.getAiAccelerationRatio();
        overview.reviewBottleneckScore = this._deliveryMeter.getReviewBottleneckScore();
        const pb = this._deliveryMeter.getPipelineBottleneck();
        overview.pipelineBottleneck = pb && pb.hasBottleneck ? pb.primary : null;
      } catch (_e) { debug('DeliveryAccelerationOrchestrator', 'configLoad', _e && _e.message ? _e.message : String(_e)); }
    }

    if (this._debtTracker) {
      try {
        const ds = this._debtTracker.calculateDebtScore();
        overview.debtScore = ds ? ds.score : 0;
      } catch (_e) { debug('DeliveryAccelerationOrchestrator', 'configLoad', _e && _e.message ? _e.message : String(_e)); }
    }

    if (this._driftMonitor) {
      try {
        const stats = this._driftMonitor.getStats();
        const driftScore = stats && typeof stats.highestDriftScore === 'number' ? stats.highestDriftScore : 0;
        overview.driftLevel = driftScore > 0.7 ? 'high' : driftScore > 0.4 ? 'medium' : driftScore > 0.2 ? 'low' : BOTTLENECK_LEVEL.NONE;
      } catch (_e) { debug('DeliveryAccelerationOrchestrator', 'configLoad', _e && _e.message ? _e.message : String(_e)); }
    }

    if (this._trustScorer) {
      try {
        overview.trustLevel = this._trustScorer.getAverageScore() >= 0.8 ? 'high'
          : this._trustScorer.getAverageScore() >= 0.6 ? 'medium' : 'low';
      } catch (_e) { debug('DeliveryAccelerationOrchestrator', 'configLoad', _e && _e.message ? _e.message : String(_e)); }
    }

    return overview;
  }

  // ─── 内部方法 ───────────────────────────────────────────────

  _detectReviewThroughputBottleneck() {
    if (!this._deliveryMeter) {
      return { type: BOTTLENECK_TYPE.REVIEW_THROUGHPUT, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'DeliveryEfficiencyMeter not attached' };
    }
    try {
      const score = this._deliveryMeter.getReviewBottleneckScore();
      const imbalance = this._deliveryMeter.getReviewThroughputImbalance();
      const level = this._scoreToLevel(score);
      return {
        type: BOTTLENECK_TYPE.REVIEW_THROUGHPUT,
        level: level,
        score: score,
        detail: level !== BOTTLENECK_LEVEL.NONE
          ? 'Review throughput imbalance: ' + (imbalance ? imbalance.level : 'unknown') + ' (codeGen vs review rate)'
          : 'Review throughput balanced',
        mitigation: 'Switch to AI_WRITE_TEST_FIX mode; automate review checklist; batch review sessions',
      };
    } catch (_e) {
      return { type: BOTTLENECK_TYPE.REVIEW_THROUGHPUT, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'Detection failed: ' + (_e && _e.message ? _e.message : String(_e)) };
    }
  }

  _detectAlmostCorrectBottleneck() {
    if (!this._trustScorer) {
      return { type: BOTTLENECK_TYPE.ALMOST_CORRECT_CODE, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'AiCodeTrustScorer not attached' };
    }
    try {
      const dist = this._trustScorer.getRiskDistribution();
      const almostCorrectCount = dist && dist.ALMOST_CORRECT ? dist.ALMOST_CORRECT : 0;
      const score = Math.min(1, almostCorrectCount / 5);
      const level = this._scoreToLevel(score);
      return {
        type: BOTTLENECK_TYPE.ALMOST_CORRECT_CODE,
        level: level,
        score: score,
        detail: level !== BOTTLENECK_LEVEL.NONE
          ? 'ALMOST_CORRECT risk detected ' + almostCorrectCount + ' times - code looks right but has subtle bugs'
          : 'No almost-correct pattern detected',
        mitigation: 'Enable AgentDebugLoop for auto-verification; increase test coverage; use stricter review checklist',
      };
    } catch (_e) {
      return { type: BOTTLENECK_TYPE.ALMOST_CORRECT_CODE, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'Detection failed: ' + (_e && _e.message ? _e.message : String(_e)) };
    }
  }

  _detectUnderstandingDebtBottleneck() {
    if (!this._debtTracker) {
      return { type: BOTTLENECK_TYPE.UNDERSTANDING_DEBT, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'ComprehensionDebtTracker not attached' };
    }
    try {
      const debtScore = this._debtTracker.calculateDebtScore();
      const score = debtScore ? debtScore.score : 0;
      const level = this._scoreToLevel(score);
      return {
        type: BOTTLENECK_TYPE.UNDERSTANDING_DEBT,
        level: level,
        score: score,
        detail: level !== BOTTLENECK_LEVEL.NONE
          ? 'Understanding debt level: ' + (debtScore ? debtScore.level : 'unknown') + ' (' + (debtScore ? debtScore.openCount : 0) + ' open debts)'
          : 'Understanding debt manageable',
        mitigation: 'Escalate critical debts; clarify requirements before coding; use SDD contract for spec-first approach',
      };
    } catch (_e) {
      return { type: BOTTLENECK_TYPE.UNDERSTANDING_DEBT, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'Detection failed: ' + (_e && _e.message ? _e.message : String(_e)) };
    }
  }

  _detectContextDriftBottleneck() {
    if (!this._driftMonitor) {
      return { type: BOTTLENECK_TYPE.CONTEXT_DRIFT, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'ContextDriftMonitor not attached' };
    }
    try {
      const trend = this._driftMonitor.getDriftTrend();
      const stats = this._driftMonitor.getStats();
      const driftScore = stats && typeof stats.highestDriftScore === 'number' ? stats.highestDriftScore : 0;
      const level = this._scoreToLevel(driftScore);
      return {
        type: BOTTLENECK_TYPE.CONTEXT_DRIFT,
        level: level,
        score: driftScore,
        detail: level !== BOTTLENECK_LEVEL.NONE
          ? 'Context drift detected (trend: ' + (trend ? trend.trend : 'unknown') + ') - constraints being lost in long tasks'
          : 'Context drift within bounds',
        mitigation: 'Register constraints before tasks; check drift periodically; re-register lost constraints',
      };
    } catch (_e) {
      return { type: BOTTLENECK_TYPE.CONTEXT_DRIFT, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'Detection failed: ' + (_e && _e.message ? _e.message : String(_e)) };
    }
  }

  _detectArchitectureMismatchBottleneck() {
    if (!this._sddContract) {
      return { type: BOTTLENECK_TYPE.ARCHITECTURE_MISMATCH, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'SddContractManager not attached' };
    }
    try {
      const contracts = this._sddContract.listContracts();
      if (!Array.isArray(contracts) || contracts.length === 0) {
        return { type: BOTTLENECK_TYPE.ARCHITECTURE_MISMATCH, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'No contracts to evaluate' };
      }
      const active = contracts.find(function(c) { return c && c.status === 'ACTIVE'; });
      if (!active) {
        return { type: BOTTLENECK_TYPE.ARCHITECTURE_MISMATCH, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'No active contract' };
      }
      const coverage = this._sddContract.checkSpecCoverage(active.contractId);
      const coveragePercent = coverage && typeof coverage.coveragePercent === 'number' ? coverage.coveragePercent : 100;
      const score = Math.min(1, (100 - coveragePercent) / 100);
      const level = this._scoreToLevel(score);
      return {
        type: BOTTLENECK_TYPE.ARCHITECTURE_MISMATCH,
        level: level,
        score: score,
        detail: level !== BOTTLENECK_LEVEL.NONE
          ? 'Spec coverage only ' + coveragePercent.toFixed(1) + '% - AI code may not match architecture'
          : 'Spec coverage adequate (' + coveragePercent.toFixed(1) + '%)',
        mitigation: 'Enforce architecture-first mode; complete SDD spec+design before coding; use trace matrix for verification',
      };
    } catch (_e) {
      return { type: BOTTLENECK_TYPE.ARCHITECTURE_MISMATCH, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'Detection failed: ' + (_e && _e.message ? _e.message : String(_e)) };
    }
  }

  _detectPipelineBlockage() {
    if (!this._deliveryMeter) {
      return { type: BOTTLENECK_TYPE.PIPELINE_BLOCKAGE, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'DeliveryEfficiencyMeter not attached' };
    }
    try {
      const pb = this._deliveryMeter.getPipelineBottleneck();
      if (!pb || !pb.hasBottleneck) {
        return { type: BOTTLENECK_TYPE.PIPELINE_BLOCKAGE, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'No pipeline bottleneck' };
      }
      const score = Math.min(1, pb.bottleneckCount * 0.3);
      const level = this._scoreToLevel(score);
      return {
        type: BOTTLENECK_TYPE.PIPELINE_BLOCKAGE,
        level: level,
        score: score,
        detail: 'Pipeline bottleneck at: ' + (pb.primary || 'unknown') + ' (' + pb.bottleneckCount + ' bottleneck(s))',
        mitigation: 'Reallocate resources to bottleneck phase; automate downstream processes; shorten feedback loops',
      };
    } catch (_e) {
      return { type: BOTTLENECK_TYPE.PIPELINE_BLOCKAGE, level: BOTTLENECK_LEVEL.NONE, score: 0, detail: 'Detection failed: ' + (_e && _e.message ? _e.message : String(_e)) };
    }
  }

  _scoreToLevel(score) {
    if (typeof score !== 'number' || !Number.isFinite(score)) return BOTTLENECK_LEVEL.NONE;
    if (score >= 0.8) return BOTTLENECK_LEVEL.CRITICAL;
    if (score >= 0.6) return BOTTLENECK_LEVEL.HIGH;
    if (score >= 0.4) return BOTTLENECK_LEVEL.MEDIUM;
    if (score >= 0.2) return BOTTLENECK_LEVEL.LOW;
    return BOTTLENECK_LEVEL.NONE;
  }

  _calculateOverallLevel(activeBottlenecks) {
    if (activeBottlenecks.length === 0) return BOTTLENECK_LEVEL.NONE;
    const levels = activeBottlenecks.map(function(b) { return b.level; });
    if (levels.includes(BOTTLENECK_LEVEL.CRITICAL)) return BOTTLENECK_LEVEL.CRITICAL;
    if (levels.includes(BOTTLENECK_LEVEL.HIGH)) return BOTTLENECK_LEVEL.HIGH;
    if (levels.includes(BOTTLENECK_LEVEL.MEDIUM)) return BOTTLENECK_LEVEL.MEDIUM;
    return BOTTLENECK_LEVEL.LOW;
  }

  _generateRecommendations(activeBottlenecks) {
    const recommendations = [];
    const types = activeBottlenecks.map(function(b) { return b.type; });

    if (types.includes(BOTTLENECK_TYPE.REVIEW_THROUGHPUT)) {
      recommendations.push({ priority: 'high', action: 'Switch to AI_WRITE_TEST_FIX mode', detail: 'Let AI handle write+test+fix cycle, human focuses on review decisions' });
    }
    if (types.includes(BOTTLENECK_TYPE.ALMOST_CORRECT_CODE)) {
      recommendations.push({ priority: 'high', action: 'Enable AgentDebugLoop auto-verification', detail: 'Auto-detect and fix subtle bugs before human review' });
    }
    if (types.includes(BOTTLENECK_TYPE.UNDERSTANDING_DEBT)) {
      recommendations.push({ priority: 'medium', action: 'Escalate critical understanding debts', detail: 'Clarify requirements and domain knowledge before continuing coding' });
    }
    if (types.includes(BOTTLENECK_TYPE.CONTEXT_DRIFT)) {
      recommendations.push({ priority: 'medium', action: 'Re-register lost constraints', detail: 'Restore drifted constraints and shorten task duration' });
    }
    if (types.includes(BOTTLENECK_TYPE.ARCHITECTURE_MISMATCH)) {
      recommendations.push({ priority: 'high', action: 'Enforce architecture-first mode', detail: 'Complete SDD spec+design stages before allowing code generation' });
    }
    if (types.includes(BOTTLENECK_TYPE.PIPELINE_BLOCKAGE)) {
      recommendations.push({ priority: 'medium', action: 'Automate bottleneck phase', detail: 'Shorten feedback loops and automate downstream processes' });
    }

    return recommendations;
  }

  _onShutdown() {
    this.stopAutoDetection();
    safeCall(() => this._bottleneckHistory.shutdown(), 'DeliveryAccelerationOrchestrator', 'shutdown-bottleneckHistory');
    this._deliveryMeter = null;
    this._trustScorer = null;
    this._debtTracker = null;
    this._driftMonitor = null;
    this._debugLoop = null;
    this._reviewCheck = null;
    this._phaseOrchestrator = null;
    this._sddContract = null;
    this._lastDiagnosis = null;
    this._stats = { totalDiagnoses: 0, bottlenecksDetected: 0, modeSwitches: 0, architectureFirstEnforcements: 0, autoDebugTriggers: 0, debtEscalations: 0 };
    this.removeAllListeners();
  }
}

module.exports = withShutdown(DeliveryAccelerationOrchestrator);
module.exports.DeliveryAccelerationOrchestrator = DeliveryAccelerationOrchestrator;
module.exports.BOTTLENECK_LEVEL = BOTTLENECK_LEVEL;
module.exports.WORKFLOW_MODE = WORKFLOW_MODE;
module.exports.BOTTLENECK_TYPE = BOTTLENECK_TYPE;
