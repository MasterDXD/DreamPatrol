/**
 * @module runtime/agent/multi-agent-orchestrator
 * @description 多Agent编排器核心模块，统一三大控制机制（流程控制、Token控制、完成定义），
 * 通过attach*依赖注入方式封装现有模块，实现多Agent系统的编排、监控和终止控制。
 */

'use strict';

const _safeNum = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

const ORCHESTRATOR_STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CIRCUIT_OPEN: 'circuit_open',
  ESCALATED: 'escalated',
});

const TERMINATION_REASON = Object.freeze({
  DOD_MET: 'dod_met',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  NO_PROGRESS: 'no_progress',
  BOUNDARY_EXCEEDED: 'boundary_exceeded',
  MAX_ITERATIONS: 'max_iterations',
  CIRCUIT_OPEN: 'circuit_open',
  ERROR: 'error',
});

const CONTEXT_LAYER = Object.freeze({
  LONG_TERM: 'long_term',
  PHASE: 'phase',
  IMMEDIATE: 'immediate',
});

const DEFAULT_CONFIG = {
  maxIterations: 5,
  maxRollbacks: 3,
  budgetWarningRatio: 0.8,
  budgetExhaustedRatio: 0.95,
  noProgressWindow: 3,
  noProgressThreshold: 0.01,
  dodThreshold: 0.85,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 30000,
  summaryMaxTokens: 500,
  escalationEnabled: true,
};

const MAX_EXECUTION_LOG = 500;

const MAX_PHASE_CONTEXT_STACK = 3;

/**
 * @class MultiAgentOrchestrator
 * @classdesc 多Agent编排器，统一流程控制、Token控制和完成定义三大机制，
 * 通过attach*依赖注入封装TokenManager、ConvergenceDetector、CollaborationModeRouter、
 * SubagentExecutor、PairChat、EnsembleOrchestrator、CircuitBreaker、DynamicWorkflowEngine等模块。
 * @extends EventEmitter
 * @emits orchestration-started | orchestration-completed | orchestration-failed
 * @emits iteration-started | iteration-completed | iteration-failed
 * @emits budget-warning | circuit-opened | rollback-executed
 * @emits dod-met | no-progress-detected | boundary-exceeded | escalated
 */
class MultiAgentOrchestrator extends EventEmitter {
  /**
   * 创建MultiAgentOrchestrator实例并初始化配置和状态。
   * @param {Object} [config={}] - 编排器配置，与DEFAULT_CONFIG合并
   * @param {number} [config.maxIterations=5] - 单任务最多协作轮数
   * @param {number} [config.maxRollbacks=3] - 最大回退次数
   * @param {number} [config.budgetWarningRatio=0.8] - Token预算警告比例
   * @param {number} [config.budgetExhaustedRatio=0.95] - Token预算耗尽比例
   * @param {number} [config.noProgressWindow=3] - 连续无进展检测窗口
   * @param {number} [config.noProgressThreshold=0.01] - 无进展阈值
   * @param {number} [config.dodThreshold=0.85] - DoD达标阈值
   * @param {number} [config.circuitBreakerThreshold=5] - 熔断器失败次数阈值
   * @param {number} [config.circuitBreakerResetMs=30000] - 熔断器重置时间
   * @param {number} [config.summaryMaxTokens=500] - 结构化摘要最大Token数
   * @param {boolean} [config.escalationEnabled=true] - 是否启用转人工
   */
  constructor(config = {}) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._status = ORCHESTRATOR_STATUS.IDLE;
    this._iterations = 0;
    this._rollbacks = 0;
    this._consecutiveNoProgress = 0;
    this._lastQualityScore = 0;
    this._circuitFailures = 0;
    this._circuitOpen = false;
    this._circuitOpenAt = null;

    // 分层上下文
    this._layeredContext = new Map();
    this._initializeLayers();

    this._terminationHistory = [];
    this._executionLog = [];
    this._currentExecution = null;

    // 依赖注入模块（通过attach*方法设置）
    this._tokenManager = null;
    this._convergenceDetector = null;
    this._collaborationModeRouter = null;
    this._subagentExecutor = null;
    this._pairChat = null;
    this._ensembleOrchestrator = null;
    this._circuitBreaker = null;
    this._dynamicWorkflowEngine = null;

    // 阶段上下文回退栈
    this._phaseContextStack = [];
  }

  /**
   * 初始化三层上下文结构
   * @private
   */
  _initializeLayers() {
    const totalBudget = _safeNum(this._config.summaryMaxTokens, 500);
    this._layeredContext.set(CONTEXT_LAYER.LONG_TERM, {
      entries: [],
      maxTokens: Math.floor(totalBudget * 0.4),
    });
    this._layeredContext.set(CONTEXT_LAYER.PHASE, {
      entries: [],
      maxTokens: Math.floor(totalBudget * 0.35),
    });
    this._layeredContext.set(CONTEXT_LAYER.IMMEDIATE, {
      entries: [],
      maxTokens: Math.floor(totalBudget * 0.25),
    });
  }

  // ─── 依赖注入方法 ───────────────────────────────────────────────

  /**
   * 附加Token管理器，用于Token预算追踪
   * @param {Object} tm - TokenManager实例（需实现getUsage/getBudget方法）
   * @returns {MultiAgentOrchestrator} this（支持链式调用）
   */
  attachTokenManager(tm) {
    if (tm && (typeof tm.getUsage === 'function' || typeof tm.getBudget === 'function')) {
      this._tokenManager = tm;
    }
    return this;
  }

  /**
   * 附加收敛检测器，用于质量收敛检测
   * @param {Object} cd - ConvergenceDetector实例（需实现isConverged方法）
   * @returns {MultiAgentOrchestrator} this（支持链式调用）
   */
  attachConvergenceDetector(cd) {
    if (cd && typeof cd.isConverged === 'function') {
      this._convergenceDetector = cd;
    }
    return this;
  }

  /**
   * 附加协作模式路由器，用于模式选择
   * @param {Object} cmr - CollaborationModeRouter实例（需实现selectMode方法）
   * @returns {MultiAgentOrchestrator} this（支持链式调用）
   */
  attachCollaborationModeRouter(cmr) {
    if (cmr && typeof cmr.selectMode === 'function') {
      this._collaborationModeRouter = cmr;
    }
    return this;
  }

  /**
   * 附加子Agent执行器，用于子Agent生命周期管理
   * @param {Object} se - SubagentExecutor实例（需实现execute/executeParallel方法）
   * @returns {MultiAgentOrchestrator} this（支持链式调用）
   */
  attachSubagentExecutor(se) {
    if (se && typeof se.execute === 'function') {
      this._subagentExecutor = se;
    }
    return this;
  }

  /**
   * 附加配对对话模块，用于双Agent验证模式
   * @param {Object} pc - PairChat实例（需实现startCrossValidation等方法）
   * @returns {MultiAgentOrchestrator} this（支持链式调用）
   */
  attachPairChat(pc) {
    if (pc && typeof pc.startCrossValidation === 'function') {
      this._pairChat = pc;
    }
    return this;
  }

  /**
   * 附加集成编排器，用于集成执行模式
   * @param {Object} eo - EnsembleOrchestrator实例（需实现execute方法）
   * @returns {MultiAgentOrchestrator} this（支持链式调用）
   */
  attachEnsembleOrchestrator(eo) {
    if (eo && typeof eo.execute === 'function') {
      this._ensembleOrchestrator = eo;
    }
    return this;
  }

  /**
   * 附加熔断器，用于电路断路器模式
   * @param {Object} cb - CircuitBreaker实例（需实现isOpen/recordFailure方法）
   * @returns {MultiAgentOrchestrator} this（支持链式调用）
   */
  attachCircuitBreaker(cb) {
    if (cb && (typeof cb.isOpen === 'function' || typeof cb.recordFailure === 'function')) {
      this._circuitBreaker = cb;
    }
    return this;
  }

  /**
   * 附加动态工作流引擎，用于DAG工作流执行
   * @param {Object} dwe - DynamicWorkflowEngine实例（需实现execute方法）
   * @returns {MultiAgentOrchestrator} this（支持链式调用）
   */
  attachDynamicWorkflowEngine(dwe) {
    if (dwe && typeof dwe.execute === 'function') {
      this._dynamicWorkflowEngine = dwe;
    }
    return this;
  }

  // ─── 核心方法 ───────────────────────────────────────────────────

  /**
   * 多Agent任务编排主入口。执行流程控制、Token控制和完成定义三大机制，
   * 驱动迭代循环直至终止条件满足。
   * @param {string} task - 任务描述（非空字符串）
   * @param {Array<Object>} agents - Agent数组（至少一个）
   * @param {Object} [options={}] - 编排选项
   * @param {string} [options.mode] - 强制指定协作模式
   * @param {number} [options.maxIterations] - 覆盖最大迭代次数
   * @param {number} [options.maxRollbacks] - 覆盖最大回退次数
   * @param {Array} [options.constraints] - 任务约束列表
   * @returns {Promise<Object>} 编排结果，包含output/qualityScore/terminationReason等
   * @throws {Error} 编排器已在运行、任务为空或无Agent时抛出
   */
  async orchestrate(task, agents, options = {}) {
    this.guardShutdown();
    if (this._status === ORCHESTRATOR_STATUS.RUNNING) {
      throw new Error('Orchestrator already running');
    }
    // 状态检查与设置在同一同步帧完成，防止 await 恢复后竞态
    this._status = ORCHESTRATOR_STATUS.RUNNING;

    if (!task || typeof task !== 'string') {
      this._status = ORCHESTRATOR_STATUS.IDLE;
      throw new Error('Task must be a non-empty string');
    }
    if (!Array.isArray(agents) || agents.length === 0) {
      this._status = ORCHESTRATOR_STATUS.IDLE;
      throw new Error('At least one agent is required');
    }

    this._iterations = 0;
    this._rollbacks = 0;
    this._consecutiveNoProgress = 0;
    this._lastQualityScore = 0;
    this._circuitFailures = 0;
    this._circuitOpen = false;
    this._executionLog = [];

    // 设置长期上下文
    this._setLayerContext(CONTEXT_LAYER.LONG_TERM, {
      goal: task,
      constraints: options.constraints ?? [],
      agents: agents.map(a => a.id || a.name || 'unknown'),
      startTime: Date.now(),
    });

    this.emit('orchestration-started', { task, agentCount: agents.length });
    debug('MultiAgentOrchestrator', 'orchestrate-started', { task: task.slice(0, 100), agentCount: agents.length });

    try {
      const result = await this._executeOrchestrationLoop(task, agents, options);
      if (result.terminationReason === TERMINATION_REASON.BOUNDARY_EXCEEDED) {
        this._status = ORCHESTRATOR_STATUS.ESCALATED;
      } else if (result.terminationReason === TERMINATION_REASON.CIRCUIT_OPEN) {
        this._status = ORCHESTRATOR_STATUS.CIRCUIT_OPEN;
      } else {
        this._status = ORCHESTRATOR_STATUS.COMPLETED;
      }
      this.emit('orchestration-completed', result);
      debug('MultiAgentOrchestrator', 'orchestrate-completed', { reason: result.terminationReason });
      return result;
    } catch (err) {
      this._status = ORCHESTRATOR_STATUS.FAILED;
      this.emit('orchestration-failed', { error: err.message });
      debug('MultiAgentOrchestrator', 'orchestrate-failed', err);
      throw err;
    }
  }

  /**
   * 主编排循环，实现三大控制机制的迭代执行
   * @param {string} task - 任务描述
   * @param {Array<Object>} agents - Agent数组
   * @param {Object} options - 编排选项
   * @returns {Promise<Object>} 终止结果
   * @private
   */
  async _executeOrchestrationLoop(task, agents, options) {
    const maxIter = options.maxIterations ?? this._config.maxIterations;
    const maxRollback = options.maxRollbacks ?? this._config.maxRollbacks;
    let lastResult = null;
    let qualityScore = 0;

    while (this._iterations < maxIter) {
      if (this._status === ORCHESTRATOR_STATUS.PAUSED) {
        await this._waitForResume();
      }
      if (this._circuitOpen) {
        return this._terminate(TERMINATION_REASON.CIRCUIT_OPEN, lastResult);
      }
      const budgetCheck = this._checkTokenBudget();
      if (budgetCheck.exhausted) {
        return this._terminate(TERMINATION_REASON.BUDGET_EXHAUSTED, lastResult);
      }
      if (budgetCheck.warning) {
        this.emit('budget-warning', { ratio: budgetCheck.ratio, iteration: this._iterations });
      }
      this._iterations++;
      this.emit('iteration-started', { iteration: this._iterations, maxIterations: maxIter });
      const iterOutcome = await this._runSingleIteration(task, agents, options, lastResult, maxRollback, qualityScore);
      qualityScore = iterOutcome.qualityScore;
      lastResult = iterOutcome.lastResult;
      if (iterOutcome.terminated) {
        return iterOutcome.terminateResult;
      }
    }

    if (this._config.escalationEnabled && qualityScore < this._config.dodThreshold) {
      this.emit('boundary-exceeded', { qualityScore, threshold: this._config.dodThreshold });
      this.emit('escalated', { qualityScore, iteration: this._iterations });
      return this._terminate(TERMINATION_REASON.BOUNDARY_EXCEEDED, lastResult);
    }
    return this._terminate(TERMINATION_REASON.MAX_ITERATIONS, lastResult);
  }

  async _runSingleIteration(task, agents, options, lastResult, maxRollback, qualityScore) {
    try {
      const iterResult = await this._executeIteration(task, agents, options, lastResult);
      qualityScore = _safeNum(iterResult.qualityScore);
      this._updatePhaseContext(iterResult);
      if (this._checkDoD(qualityScore, iterResult)) {
        this.emit('dod-met', { qualityScore, iteration: this._iterations });
        return { qualityScore, lastResult: iterResult, terminated: true, terminateResult: this._terminate(TERMINATION_REASON.DOD_MET, iterResult) };
      }
      if (this._isNoProgress(qualityScore)) {
        this._consecutiveNoProgress++;
        if (this._consecutiveNoProgress >= this._config.noProgressWindow) {
          this.emit('no-progress-detected', { consecutiveNoProgress: this._consecutiveNoProgress, iteration: this._iterations });
          return { qualityScore, lastResult: iterResult, terminated: true, terminateResult: this._terminate(TERMINATION_REASON.NO_PROGRESS, iterResult) };
        }
      } else {
        this._consecutiveNoProgress = 0;
      }
      if (iterResult.rollbackNeeded && this._rollbacks < maxRollback) {
        this._rollbacks++;
        this.emit('rollback-executed', { iteration: this._iterations, rollbacks: this._rollbacks });
        this._rollbackPhaseContext();
      }
      this._lastQualityScore = qualityScore;
      lastResult = iterResult;
      this.emit('iteration-completed', {
        iteration: this._iterations,
        qualityScore,
        tokensUsed: _safeNum(iterResult.tokensUsed),
      });
    } catch (err) {
      this._circuitFailures++;
      if (this._circuitFailures >= this._config.circuitBreakerThreshold) {
        this._circuitOpen = true;
        this._circuitOpenAt = Date.now();
        this.emit('circuit-opened', { failures: this._circuitFailures });
        debug('MultiAgentOrchestrator', 'circuit-opened', { failures: this._circuitFailures });
      }
      this.emit('iteration-failed', { iteration: this._iterations, error: err && err.message ? err.message : String(err) });
      debug('MultiAgentOrchestrator', 'iteration-failed', err);
      lastResult = lastResult ?? { error: err && err.message ? err.message : String(err), qualityScore: 0 };
    }
    return { qualityScore, lastResult, terminated: false, terminateResult: null };
  }

  /**
   * 执行单次迭代，根据协作模式选择执行方式
   * @param {string} task - 任务描述
   * @param {Array<Object>} agents - Agent数组
   * @param {Object} options - 编排选项
   * @param {Object|null} previousResult - 上一次迭代结果
   * @returns {Promise<Object>} 迭代结果，包含output/qualityScore/tokensUsed/rollbackNeeded
   * @private
   */
  async _executeIteration(task, agents, options, previousResult) {
    // 选择协作模式
    let mode = options.mode;
    if (!mode && this._collaborationModeRouter) {
      const modeResult = safeExecute(
        () => this._collaborationModeRouter.selectMode(task, { agents }),
        'MultiAgentOrchestrator',
        'selectMode',
        { mode: 'solo' },
      );
      mode = modeResult.mode || 'solo';
    }
    mode = mode || 'solo';

    // 设置即时上下文
    this._setLayerContext(CONTEXT_LAYER.IMMEDIATE, {
      iteration: this._iterations,
      previousSummary: previousResult ? this._generateStructuredSummary(previousResult) : null,
      mode,
    });

    let result;
    switch (mode) {
      case 'generator-verifier':
        result = await this._executeWithVerification(task, agents, options);
        break;
      case 'parallel':
        result = await this._executeParallel(task, agents, options);
        break;
      case 'hierarchical':
        result = await this._executeHierarchical(task, agents, options);
        break;
      default:
        result = await this._executeSolo(task, agents, options);
    }

    // 记录执行日志
    if (this._executionLog.length >= MAX_EXECUTION_LOG) {
      this._executionLog.shift();
    }
    this._executionLog.push({
      iteration: this._iterations,
      mode,
      qualityScore: _safeNum(result.qualityScore),
      tokensUsed: _safeNum(result.tokensUsed),
      timestamp: Date.now(),
    });

    return result;
  }

  // ─── 协作模式执行方法 ───────────────────────────────────────────

  /**
   * 单Agent执行模式
   * @param {string} task - 任务描述
   * @param {Array<Object>} agents - Agent数组
   * @param {Object} options - 编排选项
   * @returns {Promise<Object>} 执行结果
   * @private
   */
  async _executeSolo(task, agents, options) {
    const context = this._getCompressedContext();
    const agent = agents[0];

    if (this._subagentExecutor) {
      let result;
      try {
        result = await this._subagentExecutor.execute(agent, task, { context, ...options });
      } catch (err) {
        debug('MultiAgentOrchestrator', 'executeSolo', err);
        throw err;
      }
      return {
        output: result.output || '',
        qualityScore: _safeNum(result.qualityScore),
        tokensUsed: _safeNum(result.tokensUsed),
        rollbackNeeded: result.rollbackNeeded ?? false,
      };
    }

    // 基本执行回退
    return {
      output: context.goal || task,
      qualityScore: 0,
      tokensUsed: 0,
      rollbackNeeded: false,
    };
  }

  /**
   * 生成器-验证器双Agent验证模式
   * @param {string} task - 任务描述
   * @param {Array<Object>} agents - Agent数组
   * @param {Object} options - 编排选项
   * @returns {Promise<Object>} 执行结果
   * @private
   */
  async _executeWithVerification(task, agents, options) {
    const context = this._getCompressedContext();

    if (this._pairChat && agents.length >= 2) {
      let result;
      try {
        result = await this._pairChat.startCrossValidation({
          agentA: agents[0],
          agentB: agents[1],
          artifact: task,
          artifactType: 'task',
          context,
          ...options,
        });
      } catch (err) {
        debug('MultiAgentOrchestrator', 'executeWithVerification', err);
        throw err;
      }
      return {
        output: result.output || '',
        qualityScore: _safeNum(result.qualityScore),
        tokensUsed: _safeNum(result.tokensUsed),
        rollbackNeeded: result.rollbackNeeded ?? false,
      };
    }

    // 回退到solo模式
    return this._executeSolo(task, agents, options);
  }

  /**
   * 并行执行模式
   * @param {string} task - 任务描述
   * @param {Array<Object>} agents - Agent数组
   * @param {Object} options - 编排选项
   * @returns {Promise<Object>} 执行结果
   * @private
   */
  async _executeParallel(task, agents, options) {
    const context = this._getCompressedContext();

    if (this._subagentExecutor && typeof this._subagentExecutor.executeParallel === 'function') {
      let result;
      try {
        result = await this._subagentExecutor.executeParallel(agents, task, { context, ...options });
      } catch (err) {
        debug('MultiAgentOrchestrator', 'executeParallel-subagent', err);
        throw err;
      }
      return {
        output: result.output || '',
        qualityScore: _safeNum(result.qualityScore),
        tokensUsed: _safeNum(result.tokensUsed),
        rollbackNeeded: result.rollbackNeeded ?? false,
      };
    }

    if (this._ensembleOrchestrator) {
      let result;
      try {
        result = await this._ensembleOrchestrator.execute(agents, task, { context, ...options });
      } catch (err) {
        debug('MultiAgentOrchestrator', 'executeParallel-ensemble', err);
        throw err;
      }
      return {
        output: result.output || '',
        qualityScore: _safeNum(result.qualityScore),
        tokensUsed: _safeNum(result.tokensUsed),
        rollbackNeeded: result.rollbackNeeded ?? false,
      };
    }

    // 回退到solo模式
    return this._executeSolo(task, agents, options);
  }

  /**
   * 层级DAG工作流执行模式
   * @param {string} task - 任务描述
   * @param {Array<Object>} agents - Agent数组
   * @param {Object} options - 编排选项
   * @returns {Promise<Object>} 执行结果
   * @private
   */
  async _executeHierarchical(task, agents, options) {
    const context = this._getCompressedContext();

    if (this._dynamicWorkflowEngine) {
      let result;
      try {
        result = await this._dynamicWorkflowEngine.execute(task, agents, { context, ...options });
      } catch (err) {
        debug('MultiAgentOrchestrator', 'executeHierarchical', err);
        throw err;
      }
      return {
        output: result.output || '',
        qualityScore: _safeNum(result.qualityScore),
        tokensUsed: _safeNum(result.tokensUsed),
        rollbackNeeded: result.rollbackNeeded ?? false,
      };
    }

    // 回退到solo模式
    return this._executeSolo(task, agents, options);
  }

  // ─── 上下文管理方法 ─────────────────────────────────────────────

  /**
   * 设置指定层的上下文数据
   * @param {string} layer - 上下文层（CONTEXT_LAYER枚举值）
   * @param {Object} data - 上下文数据
   * @private
   */
  _setLayerContext(layer, data) {
    const layerData = this._layeredContext.get(layer);
    if (!layerData) return;
    layerData.entries = Array.isArray(data) ? data : [data];
  }

  /**
   * 用迭代结果更新阶段上下文
   * @param {Object} iterResult - 迭代结果
   * @private
   */
  _updatePhaseContext(iterResult) {
    const phaseData = this._layeredContext.get(CONTEXT_LAYER.PHASE);
    if (!phaseData) return;

    // 保存当前阶段上下文到回退栈
    const snapshot = {
      entries: phaseData.entries.map(e => Object.assign({}, e)),
      maxTokens: phaseData.maxTokens,
    };
    this._phaseContextStack.push(snapshot);
    if (this._phaseContextStack.length > MAX_PHASE_CONTEXT_STACK) {
      this._phaseContextStack.shift();
    }

    // 更新阶段上下文
    const summary = this._generateStructuredSummary(iterResult);
    phaseData.entries = [summary];
  }

  /**
   * 回退阶段上下文到上一个状态
   * @private
   */
  _rollbackPhaseContext() {
    if (this._phaseContextStack.length === 0) return;
    const previous = this._phaseContextStack.pop();
    const phaseData = this._layeredContext.get(CONTEXT_LAYER.PHASE);
    if (!phaseData) return;
    phaseData.entries = previous.entries;
    phaseData.maxTokens = previous.maxTokens;
    debug('MultiAgentOrchestrator', 'rollbackPhaseContext', { stackSize: this._phaseContextStack.length });
  }

  /**
   * 获取三层压缩上下文的结构化摘要
   * @returns {Object} 压缩上下文，包含longTerm/phase/immediate三层
   * @private
   */
  _getCompressedContext() {
    const result = {};
    for (const [layer, data] of this._layeredContext) {
      result[layer] = data.entries.map(e => (typeof e === 'object' && e !== null ? { ...e } : e));
    }
    return result;
  }

  /**
   * 生成结构化摘要
   * @param {Object} result - 迭代结果
   * @returns {Object} 结构化摘要，包含confirmed/unresolved/nextSteps/qualityScore/tokensUsed
   * @private
   */
  _generateStructuredSummary(result) {
    if (!result) {
      return { confirmed: [], unresolved: [], nextSteps: [], qualityScore: 0, tokensUsed: 0 };
    }

    const output = result.output || '';
    const confirmed = [];
    const unresolved = [];
    const nextSteps = [];

    // 从输出中提取已确认和未解决项
    if (typeof output === 'string' && output.length > 0) {
      confirmed.push(output.slice(0, 200));
    }
    if (result.error) {
      unresolved.push(result.error);
    }
    if (result.rollbackNeeded) {
      nextSteps.push('rollback-required');
    }

    return {
      confirmed,
      unresolved,
      nextSteps,
      qualityScore: _safeNum(result.qualityScore),
      tokensUsed: _safeNum(result.tokensUsed),
    };
  }

  // ─── 控制方法 ───────────────────────────────────────────────────

  /**
   * 检查Token预算状态
   * @returns {Object} 预算状态，包含exhausted/warning/ratio/remaining
   * @private
   */
  _checkTokenBudget() {
    const result = { exhausted: false, warning: false, ratio: 0, remaining: Infinity };

    if (!this._tokenManager) return result;

    const usage = safeExecute(
      () => this._tokenManager.getUsage(),
      'MultiAgentOrchestrator',
      'checkTokenBudget-usage',
      -1,
    );
    const budget = safeExecute(
      () => this._tokenManager.getBudget(),
      'MultiAgentOrchestrator',
      'checkTokenBudget-budget',
      0,
    );
    // Token管理器异常时按预算耗尽处理（fail-closed）
    if (usage < 0 || budget <= 0) {
      result.exhausted = true;
      result.ratio = 1;
      return result;
    }

    const used = Number.isFinite(usage) ? usage : 0;
    const total = Number.isFinite(budget) ? budget : Infinity;

    if (total <= 0 || !Number.isFinite(total)) return result;

    result.ratio = used / total;
    result.remaining = total - used;

    if (result.ratio >= this._config.budgetExhaustedRatio) {
      result.exhausted = true;
    } else if (result.ratio >= this._config.budgetWarningRatio) {
      result.warning = true;
    }

    return result;
  }

  /**
   * 检查DoD（完成定义）是否达标
   * @param {number} qualityScore - 质量评分
   * @param {Object} result - 迭代结果
   * @returns {boolean} DoD是否达标
   * @private
   */
  _checkDoD(qualityScore, result) {
    // 质量评分必须达到阈值
    if (qualityScore < this._config.dodThreshold) return false;

    // 结果必须包含必要字段
    if (!result || !result.output) return false;

    // 若有收敛检测器，使用其判断
    if (this._convergenceDetector) {
      const converged = safeExecute(
        () => this._convergenceDetector.isConverged(qualityScore, result),
        'MultiAgentOrchestrator',
        'checkDoD-convergence',
        false,
      );
      if (!converged) return false;
    }

    return true;
  }

  /**
   * 检查质量提升是否低于无进展阈值
   * @param {number} qualityScore - 当前质量评分
   * @returns {boolean} 是否无进展
   * @private
   */
  _isNoProgress(qualityScore) {
    const improvement = qualityScore - this._lastQualityScore;
    return improvement >= 0 && improvement < this._config.noProgressThreshold;
  }

  /**
   * 终止编排，记录终止原因并返回最终结果
   * @param {string} reason - 终止原因（TERMINATION_REASON枚举值）
   * @param {Object|null} lastResult - 最后一次迭代结果
   * @returns {Object} 最终结果，包含output/qualityScore/terminationReason/iterations等
   * @private
   */
  _terminate(reason, lastResult) {
    const result = {
      output: (lastResult && lastResult.output) || '',
      qualityScore: _safeNum(lastResult && lastResult.qualityScore),
      tokensUsed: _safeNum(lastResult && lastResult.tokensUsed),
      terminationReason: reason,
      iterations: this._iterations,
      rollbacks: this._rollbacks,
      timestamp: Date.now(),
    };

    // 记录终止历史
    if (this._terminationHistory.length >= 100) {
      this._terminationHistory.shift();
    }
    this._terminationHistory.push({
      reason,
      iteration: this._iterations,
      qualityScore: result.qualityScore,
      timestamp: result.timestamp,
    });

    // 若为转人工终止，设置状态
    if (reason === TERMINATION_REASON.BOUNDARY_EXCEEDED) {
      this._status = ORCHESTRATOR_STATUS.ESCALATED;
    }

    debug('MultiAgentOrchestrator', 'terminate', { reason, iterations: this._iterations, qualityScore: result.qualityScore });

    return result;
  }

  // ─── 查询方法 ───────────────────────────────────────────────────

  /**
   * 获取当前编排器状态
   * @returns {string} 状态（ORCHESTRATOR_STATUS枚举值）
   */
  getStatus() {
    return this._status;
  }

  /**
   * 获取当前迭代次数
   * @returns {number} 迭代次数
   */
  getIterations() {
    return this._iterations;
  }

  /**
   * 获取执行日志的防御性副本
   * @returns {Array<Object>} 执行日志副本
   */
  getExecutionLog() {
    return this._executionLog.map(entry => Object.assign({}, entry));
  }

  /**
   * 获取分层上下文的防御性副本
   * @returns {Object} 分层上下文副本
   */
  getLayeredContext() {
    const result = {};
    for (const [layer, data] of this._layeredContext) {
      result[layer] = {
        entries: data.entries.map(e => (typeof e === 'object' && e !== null ? Object.assign({}, e) : e)),
        maxTokens: data.maxTokens,
      };
    }
    return result;
  }

  /**
   * 获取终止历史的防御性副本
   * @returns {Array<Object>} 终止历史副本
   */
  getTerminationHistory() {
    return this._terminationHistory.map(entry => Object.assign({}, entry));
  }

  /**
   * 获取熔断器状态
   * @returns {Object} 熔断器状态，包含open/failures/openAt
   */
  getCircuitBreakerStatus() {
    this.guardShutdown();
    // 检查熔断器重置时间
    if (this._circuitOpen && this._circuitOpenAt) {
      const elapsed = Date.now() - this._circuitOpenAt;
      if (elapsed >= this._config.circuitBreakerResetMs) {
        this._circuitOpen = false;
        this._circuitFailures = 0;
        this._circuitOpenAt = null;
      }
    }

    return {
      open: this._circuitOpen,
      failures: this._circuitFailures,
      openAt: this._circuitOpenAt,
    };
  }

  // ─── 暂停/恢复 ─────────────────────────────────────────────────

  /**
   * 暂停编排（仅当状态为RUNNING时生效）
   */
  pause() {
    this.guardShutdown();
    if (this._status === ORCHESTRATOR_STATUS.RUNNING) {
      this._status = ORCHESTRATOR_STATUS.PAUSED;
      this._pausePromise = new Promise(resolve => {
        this._resumeResolve = resolve;
      });
      debug('MultiAgentOrchestrator', 'paused', { iteration: this._iterations });
    }
  }

  /**
   * 从暂停恢复编排
   */
  resume() {
    this.guardShutdown();
    if (this._status === ORCHESTRATOR_STATUS.PAUSED) {
      this._status = ORCHESTRATOR_STATUS.RUNNING;
      if (this._resumeResolve) {
        this._resumeResolve();
        this._resumeResolve = null;
        this._pausePromise = null;
      }
      debug('MultiAgentOrchestrator', 'resumed', { iteration: this._iterations });
    }
  }

  /**
   * 等待恢复（内部方法）
   * @returns {Promise<void>}
   * @private
   */
  async _waitForResume() {
    if (this._pausePromise) {
      await this._pausePromise;
    }
  }

  // ─── 关闭 ───────────────────────────────────────────────────────

  /**
   * 关闭回调，清理资源
   * @private
   */
  _onShutdown() {
    safeCall(() => {
      this._status = ORCHESTRATOR_STATUS.IDLE;
      this._executionLog = [];
      this._phaseContextStack = [];
      this._layeredContext.clear();
      this._initializeLayers();
      if (this._resumeResolve) {
        this._resumeResolve();
        this._resumeResolve = null;
        this._pausePromise = null;
      }
    }, 'MultiAgentOrchestrator', 'onShutdown');
    debug('MultiAgentOrchestrator', 'shutdown', { iterations: this._iterations });
    this.removeAllListeners();
  }
}

module.exports = withShutdown(MultiAgentOrchestrator);
module.exports.ORCHESTRATOR_STATUS = ORCHESTRATOR_STATUS;
module.exports.TERMINATION_REASON = TERMINATION_REASON;
module.exports.CONTEXT_LAYER = CONTEXT_LAYER;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
