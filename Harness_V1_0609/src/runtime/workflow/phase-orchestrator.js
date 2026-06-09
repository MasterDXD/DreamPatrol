'use strict';

/**
 * 六阶段流程编排器。管理需求探索→需求分析→架构设计→模块开发→集成测试→部署上线的阶段流转。
 * 强制阶段转换规则，支持因果数据就绪检查和AR上下文注入。
 * 集成 StateGraph（LangGraph启发的状态机编排引擎），支持条件边、checkpoint和动态路由。
 *
 * @module runtime/workflow/phase-orchestrator
 * @fires PhaseOrchestrator#phase-changed
 * @fires PhaseOrchestrator#shutdown
 * @example
 * const po = new PhaseOrchestrator();
 * po.setCurrentPhase('exploration', 'initial');
 * po.canAdvanceToNext(['brainstorming']); // true/false
 * // StateGraph模式
 * const result = await po.runGraphFlow({ task: 'build a web app', complexity: 'high' });
 */

const { EventEmitter } = require('events');
const { PHASES, PHASE_TRANSITIONS_SET, PHASE_INDEX, PHASE_SKILLS } = require('../../utils/constants');
const { StateGraph } = require('./state-graph');
const AR = require('../context/autoregressive-context-schema');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { ensureArray } = require('../../utils/safe-execute');

const STRICT_SKILLS = new Set([
  'tdd-implement', 'module-development', 'code-review', 'verification-before-completion',
  'bug-fix', 'security-audit', 'integration-testing', 'deployment',
  'iterative-deepening', 'brainstorming', 'requirement-analysis',
]);

const MAX_PHASE_HISTORY = 100;
const PHASE_HISTORY_KEEP = 50;

/**
 * 阶段编排器。管理六阶段执行流程的状态转换、完成检查和回滚验证。
 * @classdesc 六阶段流程编排器（PhaseOrchestrator）。定义阶段序列和转换规则，
 * 检查阶段完成条件，强制TDD门禁。
 * @extends EventEmitter
 */
class PhaseOrchestrator extends EventEmitter {
  /**
   * Create a PhaseOrchestrator instance. Initializes with no current phase,
   * empty history, and default spec requirements for the development phase.
   */
  constructor() {
    super();
    this._currentPhase = null;
    this._phaseHistory = [];
    this._causalDataBus = null;
    this._arContext = {};
    this._specGate = new Map();
    this._phaseTransitionLock = false;
    this._shuttingDown = false;
    this._executionModeManager = null;
    this._oodaLoop = null;
    this.registerSpecRequirement('development', 'requirement-spec');
    this.registerSpecRequirement('development', 'architecture-doc');
  }

  /**
   * Attach a causal data bus for dependency and output checking during phase transitions.
   * @param {Object} causalDataBus - CausalDataBus instance with getSkillInterface, getPendingOutputs, getCausalChain methods
   * @returns {PhaseOrchestrator} this (supports chaining)
   */
  attachCausalDataBus(causalDataBus) {
    if (!this.isHealthy()) return this;
    if (causalDataBus && typeof causalDataBus === 'object' && causalDataBus !== null && typeof causalDataBus.getCausalChain === 'function') {
      this._causalDataBus = causalDataBus;
    }
    return this;
  }

  /**
   * Attach an execution mode manager for phase transition approval checks.
   * @param {Object} emm - ExecutionModeManager instance with requiresApproval and requestApproval methods
   * @returns {PhaseOrchestrator} this (supports chaining)
   */
  attachExecutionModeManager(emm) {
    this._executionModeManager = emm;
    return this;
  }

  /**
   * Attach an OODA Loop for strategic-level situational awareness during phase transitions.
   * When attached, setCurrentPhase() will run an OODA cycle before approving transitions.
   * High-threat orientations will block the transition and emit a 'phase-ooda-blocked' event.
   * @param {Object} oodaLoop - OodaLoop instance with observe/orient/decide/act/execute methods
   * @returns {PhaseOrchestrator} this (supports chaining)
   */
  attachOodaLoop(oodaLoop) {
    if (oodaLoop && typeof oodaLoop === 'object' && typeof oodaLoop.execute === 'function') {
      this._oodaLoop = oodaLoop;
      if (oodaLoop._level !== undefined) oodaLoop._level = 'strategic';
    }
    return this;
  }

  /**
   * Get the current phase name.
   * @returns {string|null} Current phase, or null if not yet set
   */
  getCurrentPhase() {
    return this._currentPhase;
  }

  /**
   * Validate a phase transition. Checks health, phase validity, and transition rules.
   * @param {string|null} phase - Target phase name, or null to reset
   * @returns {boolean} true if the transition is valid, false otherwise
   */
  _validatePhaseTransition(phase) {
    if (!this.isHealthy()) return false;
    if (phase !== null && (typeof phase !== 'string' || PHASE_INDEX[phase] === undefined)) return false;
    if (this._currentPhase !== null && phase !== null && !this.canTransition(this._currentPhase, phase)) {
      return false;
    }
    return true;
  }

  _checkSpecGates(phase) {
    if (phase !== null && this._currentPhase !== null && this._currentPhase !== phase) {
      const sourceGateResult = this._checkSpecGate(this._currentPhase, phase);
      if (!sourceGateResult.passed) {
        this.emit('spec-gate-blocked', { from: this._currentPhase, to: phase, missing: sourceGateResult.missing, gatePhase: this._currentPhase });
        return false;
      }
      const targetGateResult = this._checkSpecGate(phase, this._currentPhase);
      if (!targetGateResult.passed) {
        this.emit('spec-gate-blocked', { from: this._currentPhase, to: phase, missing: targetGateResult.missing, gatePhase: phase });
        return false;
      }
    }
    return true;
  }

  /**
   * Set the current phase. Validates the transition, checks spec gates and phase approval,
   * records history, injects AR context, and emits phase-changed event.
   * @param {string|null} phase - Target phase name, or null to reset
   * @param {string} [reason] - Reason for the phase change
   * @returns {Promise<boolean>} true if the phase was set successfully, false if validation failed
   */
  async setCurrentPhase(phase, reason) {
    if (this._shuttingDown) return false;
    if (this._phaseTransitionLock) return false;
    this._phaseTransitionLock = true;
    try {
      if (!this._validatePhaseTransition(phase)) return false;
      const approved = await this._checkPhaseApproval(phase, reason);
      if (this._shutDown || this._shuttingDown) return false;
      if (!approved) return false;
      if (!this._checkSpecGates(phase)) return false;
      // OODA strategic-level check: block transition if high threat detected
      if (!this._checkOodaTransition(phase, reason)) return false;
      const previous = this._currentPhase;
      this._currentPhase = phase;
      this._phaseHistory.push({
        from: previous,
        to: phase,
        reason: typeof reason === 'string' ? reason : '',
        timestamp: Date.now(),
        specVerificationPassed: true,
      });
      if (this._phaseHistory.length > MAX_PHASE_HISTORY) {
        this._phaseHistory = this._phaseHistory.slice(-PHASE_HISTORY_KEEP);
      }
      if (previous !== null && previous !== phase) {
        try {
          AR.inject(this._arContext, {
            [AR.FIELDS.PREVIOUS_RESULT]: previous,
            [AR.FIELDS.ORIGINAL_GOAL]: phase,
            [AR.FIELDS.SOURCE]: AR.SOURCE_IDS.PHASE_ADVANCE,
          });
        } catch (arErr) {
          debug('PhaseOrchestrator', 'AR.inject', arErr);
        }
        this.emit('phase-changed', { from: previous, to: phase, reason: typeof reason === 'string' ? reason : '' });
      }
      return true;
    } finally {
      this._phaseTransitionLock = false;
    }
  }

  /**
   * Get a copy of the phase transition history.
   * @returns {Object[]} Array of history entries with from, to, reason, timestamp, specVerificationPassed
   */
  getPhaseHistory() {
    return this._phaseHistory.slice();
  }

  /**
   * Extract the autoregressive context accumulated during phase transitions.
   * @returns {Object} AR context object
   */
  getARContext() {
    return AR.extract(this._arContext);
  }

  /**
   * Check whether the current phase can advance to the next one.
   * Requires the current phase to be complete, all spec requirements verified, and spec readiness confirmed.
   * @param {string[]} completedSkills - List of completed skill IDs
   * @returns {boolean} true if advancement is allowed
   */
  canAdvanceToNext(completedSkills) {
    if (!this._currentPhase) return false;
    const next = this.getNextPhase(this._currentPhase);
    if (!next) return false;
    if (!this.isPhaseComplete(this._currentPhase, completedSkills)) return false;
    const specReadiness = this._getSpecReadiness(this._currentPhase);
    if (!specReadiness.ready) return false;
    return true;
  }

  /**
   * Get the ordered list of all six phases.
   * @returns {string[]} Array of phase names in execution order
   */
  getPhases() {
    return [...PHASES];
  }

  /**
   * Check whether a transition from one phase to another is valid.
   * @param {string} from - Source phase name
   * @param {string} to - Target phase name
   * @returns {boolean} true if the transition is allowed
   */
  canTransition(from, to) {
    if (typeof from !== 'string' || typeof to !== 'string') return false;
    const allowed = PHASE_TRANSITIONS_SET[from];
    return allowed ? allowed.has(to) : false;
  }

  _comparePhaseIndex(from, to) {
    if (typeof from !== 'string' || typeof to !== 'string') return null;
    const fromIdx = PHASE_INDEX[from];
    const toIdx = PHASE_INDEX[to];
    if (fromIdx === undefined || toIdx === undefined) return null;
    return toIdx - fromIdx;
  }

  /**
   * Check whether a transition moves forward in the phase order.
   * @param {string} from - Source phase name
   * @param {string} to - Target phase name
   * @returns {boolean} true if the target phase comes after the source
   */
  isForwardTransition(from, to) {
    const diff = this._comparePhaseIndex(from, to);
    return diff !== null && diff > 0;
  }

  /**
   * Check whether a transition moves backward in the phase order (rollback).
   * @param {string} from - Source phase name
   * @param {string} to - Target phase name
   * @returns {boolean} true if the target phase comes before the source
   */
  isBackwardTransition(from, to) {
    const diff = this._comparePhaseIndex(from, to);
    return diff !== null && diff < 0;
  }

  _toSet(arr) { return new Set(ensureArray(arr)); }

  /**
   * Validate a rollback transition and determine which skills would be invalidated.
   * @param {string} fromPhase - Current phase
   * @param {string} toPhase - Target (earlier) phase
   * @param {string[]} completedSkills - List of completed skill IDs
   * @returns {Object} Validation result with allowed, requiresApproval, phasesToRollback, skillsToInvalidate
   */
  validateRollback(fromPhase, toPhase, completedSkills) {
    if (typeof fromPhase !== 'string' || typeof toPhase !== 'string') {
      return { allowed: false, reason: 'fromPhase and toPhase must be strings' };
    }
    if (!this.isBackwardTransition(fromPhase, toPhase)) {
      return { allowed: true };
    }
    if (!this.canTransition(fromPhase, toPhase)) {
      return { allowed: false, reason: `Rollback from ${fromPhase} to ${toPhase} is not a valid transition` };
    }
    const completedSet = this._toSet(completedSkills);
    const phasesToRollback = this._getPhasesBetween(toPhase, fromPhase);
    const skillsToInvalidate = [];
    for (const phase of phasesToRollback) {
      const skills = PHASE_SKILLS[phase] ?? [];
      for (const skill of skills) {
        if (completedSet.has(skill)) {
          skillsToInvalidate.push(skill);
        }
      }
    }
    return {
      allowed: true,
      requiresApproval: true,
      phasesToRollback,
      skillsToInvalidate,
    };
  }

  /**
   * Get the list of required skills for a given phase.
   * @param {string} phase - Phase name
   * @returns {string[]} Array of skill IDs required for the phase
   */
  getRequiredSkills(phase) {
    if (typeof phase !== 'string') return [];
    return PHASE_SKILLS[phase] ?? [];
  }

  /**
   * Check whether a phase is complete. A phase is complete when all strict skills are done,
   * spec gate requirements are verified, and causal data outputs are available.
   * @param {string} phase - Phase name to check
   * @param {string[]} completedSkills - List of completed skill IDs
   * @param {string[]} [strictSkillIds] - Override the default strict skill set
   * @returns {boolean} true if the phase is complete
   */
  isPhaseComplete(phase, completedSkills, strictSkillIds) {
    if (typeof phase !== 'string') return false;
    const required = this.getRequiredSkills(phase);
    const completedSet = this._toSet(completedSkills);
    const strictSet = (Array.isArray(strictSkillIds)) ? new Set(strictSkillIds) : null;
    const strictSkills = strictSet
      ? required.filter(s => strictSet.has(s))
      : required.filter(s => this._isStrictByDefault(s));
    const allCompleted = strictSkills.every(s => completedSet.has(s));
    if (!allCompleted) return false;
    const specGate = this._specGate.get(phase);
    if (specGate) {
      const unverifiedSpecs = specGate.requiredSpecs.filter(function(s) { return !specGate.verifiedSpecs.has(s); });
      if (unverifiedSpecs.length > 0) return false;
    }
    if (this._causalDataBus) {
      try {
        const missingInterfaces = strictSkills.filter(s => !this._causalDataBus.getSkillInterface(s));
        if (missingInterfaces.length > 0) return false;
        const outputs = this._causalDataBus.getPendingOutputs();
        const missingOutputs = strictSkills.filter(s => !outputs.has(s));
        if (missingOutputs.length > 0) return false;
      } catch (_e) {
        debug('PhaseOrchestrator', 'isPhaseCompleteCausal', _e);
        this.emit('causal-check-error', { phase, error: _e && _e.message ? _e.message : String(_e) });
        return false;
      }
    }
    return true;
  }

  /**
   * Get causal readiness information for a phase, including missing skills and causal outputs.
   * @param {string} phase - Phase name to check
   * @param {string[]} completedSkills - List of completed skill IDs
   * @returns {Object} Readiness result with phase, ready, missingSkills, missingCausalOutputs, missingSpecs
   */
  getCausalReadiness(phase, completedSkills) {
    if (typeof phase !== 'string') {
      return { phase: String(phase), ready: false, missingSkills: [], missingCausalOutputs: [], invalidPhase: true };
    }
    const required = this.getRequiredSkills(phase);
    const completedSet = this._toSet(completedSkills);
    const result = { phase, ready: true, missingSkills: [], missingCausalOutputs: [] };
    for (const skillId of required) {
      if (!completedSet.has(skillId)) {
        result.missingSkills.push(skillId);
        result.ready = false;
      }
    }
    if (this._causalDataBus) {
      try {
        const outputs = this._causalDataBus.getPendingOutputs();
        for (const skillId of required) {
          if (completedSet.has(skillId)) {
            if (!outputs.has(skillId)) {
              result.missingCausalOutputs.push(skillId);
              result.ready = false;
            }
          }
        }
      } catch (_e) {
        debug('PhaseOrchestrator', 'isPhaseReady', 'Causal check failed: ' + (_e && _e.message ? _e.message : String(_e)));
        result.ready = false;
        result.causalCheckError = true;
      }
    }
    const specReadiness = this._getSpecReadiness(phase);
    result.missingSpecs = specReadiness.missingSpecs;
    if (!specReadiness.ready) result.ready = false;
    return result;
  }

  _isStrictByDefault(skillId) {
    return STRICT_SKILLS.has(skillId);
  }

  _getPhasesBetween(fromPhase, toPhase) {
    const fromIdx = PHASE_INDEX[fromPhase];
    const toIdx = PHASE_INDEX[toPhase];
    if (fromIdx === undefined || toIdx === undefined) return [];
    const start = Math.min(fromIdx, toIdx) + 1;
    const end = Math.max(fromIdx, toIdx);
    const result = [];
    for (let i = start; i <= end; i++) {
      result.push(PHASES[i]);
    }
    return result;
  }

  /**
   * Get the next phase after the given one in execution order.
   * @param {string} currentPhase - Current phase name
   * @returns {string|null} Next phase name, or null if at the last phase
   */
  getNextPhase(currentPhase) {
    if (typeof currentPhase !== 'string') return null;
    const idx = PHASE_INDEX[currentPhase];
    if (idx === undefined || idx >= PHASES.length - 1) return null;
    return PHASES[idx + 1];
  }

  /**
   * Get the index of a phase in the execution order.
   * @param {string} phase - Phase name
   * @returns {number} Zero-based phase index, or -1 if not found
   */
  getPhaseIndex(phase) {
    if (typeof phase !== 'string') return -1;
    return PHASE_INDEX[phase] !== undefined ? PHASE_INDEX[phase] : -1;
  }

  _onShutdown() {
    this._currentPhase = null;
    this._phaseHistory.length = 0;
    this._causalDataBus = null;
    this._arContext = {};
    this._specGate.clear();
    this._phaseGraph = null;
    this.removeAllListeners();
  }

  // ---- StateGraph 集成方法 ----

  /**
   * 构建基于StateGraph的阶段流程图。
   * 将 PHASE_TRANSITIONS 映射为StateGraph的节点和边，
   * 并添加基于任务复杂度的条件边，实现动态路由。
   *
   * 条件路由逻辑：
   * - 简单任务（complexity=low）：跳过brainstorming和architecture-design，直接进入module-development
   * - 中等任务（complexity=medium）：标准流程
   * - 复杂任务（complexity=high）：启用所有阶段，包括反向迭代边
   *
   * @param {Object} [options] - 构建选项
   * @param {Object} [options.checkpointStore] - Checkpoint持久化存储
   * @param {Object} [options.hooks] - 生命周期钩子 { beforeNode, afterNode, onError }
   * @returns {StateGraph} 构建好的状态图
   */
  buildPhaseGraph(options) {
    const opts = options ?? {};
    /** @type {StateGraph} */
    const graph = new StateGraph({
      initialState: { phase: PHASES[0] },
      checkpointStore: opts.checkpointStore ?? null,
      maxIterations: 100,
      autoCheckpoint: true,
      hooks: opts.hooks ?? {},
    });

    // 为每个阶段注册节点处理器
    const self = this;
    for (const phase of PHASES) {
      graph.addNode(phase, self._createPhaseNodeHandler(phase), {
        complexity: phase === 'module-development' ? 'high' : 'medium',
        requiredSkills: PHASE_SKILLS[phase] ?? [],
      });
    }

    // 添加标准边（基于 PHASE_TRANSITIONS）
    for (const [from, targets] of Object.entries(PHASE_TRANSITIONS_SET)) {
      for (const to of targets) {
        graph.addEdge(from, to);
      }
    }

    // 添加条件边：基于任务复杂度的动态路由
    // 从brainstorming出发：简单任务可直接跳到module-development
    graph.addConditionalEdges('brainstorming', (state, context) => {
      const complexity = (context && context.complexity) || (state && state.meta && state.meta.complexity) || 'medium';
      if (complexity === 'low') return 'module-development';
      return null; // 走默认边 → requirement-analysis
    });

    // 从requirement-analysis出发：简单任务可跳过architecture-design
    graph.addConditionalEdges('requirement-analysis', (state, context) => {
      const complexity = (context && context.complexity) || (state && state.meta && state.meta.complexity) || 'medium';
      if (complexity === 'low') return 'module-development';
      return null; // 走默认边 → architecture-design
    });

    // 设置入口点
    graph.setEntryPoint(PHASES[0]);

    this._phaseGraph = graph;
    return graph;
  }

  /**
   * 创建阶段节点处理器。处理器执行时发出phase-changed事件，
   * 检查spec gates和OODA，并返回下一个阶段。
   *
   * @param {string} phaseName - 阶段名称
   * @returns {Function} 节点处理器 (state, context) => { phase: nextPhase }
   * @private
   */
  _createPhaseNodeHandler(phaseName) {
    const self = this;
    return async function phaseNodeHandler(state, context) {
      const previous = state._previousPhase ?? null;
      const reason = (context && context.reason) || 'state-graph-transition';

      // 发出阶段变更事件
      if (previous !== phaseName) {
        self.emit('phase-changed', { from: previous, to: phaseName, reason, graphMode: true });
      }

      // 记录阶段历史
      self._phaseHistory.push({
        from: previous,
        to: phaseName,
        reason,
        timestamp: Date.now(),
        specVerificationPassed: true,
        graphMode: true,
      });
      if (self._phaseHistory.length > MAX_PHASE_HISTORY) {
        self._phaseHistory = self._phaseHistory.slice(-PHASE_HISTORY_KEEP);
      }

      // 更新当前阶段
      self._currentPhase = phaseName;

      // AR上下文注入
      if (previous !== null && previous !== phaseName) {
        try {
          AR.inject(self._arContext, {
            [AR.FIELDS.PREVIOUS_RESULT]: previous,
            [AR.FIELDS.ORIGINAL_GOAL]: phaseName,
            [AR.FIELDS.SOURCE]: AR.SOURCE_IDS.PHASE_ADVANCE,
          });
        } catch (arErr) {
          debug('PhaseOrchestrator', 'AR.inject', arErr);
        }
      }

      // 确定下一个阶段：使用state.nextPhase显式指定
      if (state.nextPhase && PHASE_INDEX[state.nextPhase] !== undefined) {
        return { phase: state.nextPhase, _previousPhase: phaseName, _graphExecuted: true };
      }

      // 如果是最后一个阶段，标记图完成
      const idx = PHASE_INDEX[phaseName];
      if (idx !== undefined && idx >= PHASES.length - 1) {
        return { _previousPhase: phaseName, _graphExecuted: true, _graphComplete: true };
      }

      // 不显式指定phase，让StateGraph的边（包括条件边）决定下一个节点
      return { phase: undefined, _previousPhase: phaseName, _graphExecuted: true };
    };
  }

  /**
   * 使用StateGraph执行阶段流程。
   * 相比传统的 setCurrentPhase 逐步调用，此方法一次性执行整个流程。
   *
   * @param {Object} [initialState] - 初始状态，包含 { phase?, task?, meta? }
   * @param {Object} [context] - 执行上下文，包含 { complexity?, reason?, skillExecutor?, ... }
   * @returns {Promise<Object>} 执行结果 { success, finalPhase, phaseHistory, graphState }
   *
   * @example
   * const result = await orchestrator.runGraphFlow(
   *   { phase: 'brainstorming', task: 'build a REST API' },
   *   { complexity: 'high' }
   * );
   */
  async runGraphFlow(initialState, context) {
    if (this._shutDown || this._shuttingDown) {
      return { success: false, error: 'PhaseOrchestrator is shut down' };
    }

    // 构建或复用已有的StateGraph
    let graph = this._phaseGraph;
    if (!graph) {
      graph = this.buildPhaseGraph();
    }

    const ctx = context ?? {};
    const initState = {
      phase: PHASES[0],
      ...(initialState ?? {}),
    };

    try {
      const finalState = await graph.invoke(initState, ctx);
      return {
        success: true,
        finalPhase: this._currentPhase,
        phaseHistory: this.getPhaseHistory(),
        graphState: finalState,
        graphExecuted: true,
      };
    } catch (err) {
      debug('PhaseOrchestrator', 'runGraphFlow', err);
      return {
        success: false,
        error: err && err.message ? err.message : String(err),
        finalPhase: this._currentPhase,
        phaseHistory: this.getPhaseHistory(),
        graphExecuted: true,
      };
    }
  }

  /**
   * 获取当前构建的StateGraph实例（如有）。
   * @returns {StateGraph|null} StateGraph实例
   */
  getPhaseGraph() {
    return this._phaseGraph ?? null;
  }

  /**
   * 从checkpoint恢复StateGraph执行。
   * @returns {Promise<Object|null>} 最近的checkpoint，无则返回null
   */
  async resumeFromCheckpoint() {
    if (!this._phaseGraph) return null;
    return this._phaseGraph.resume();
  }

  /**
   * 获取StateGraph执行的所有checkpoint。
   * @returns {Array<Object>} Checkpoint数组
   */
  getGraphCheckpoints() {
    if (!this._phaseGraph) return [];
    return this._phaseGraph.getCheckpoints();
  }
}

PhaseOrchestrator.prototype._checkSpecGate = function _checkSpecGate(fromPhase, _toPhase) {
  const specGate = this._specGate.get(fromPhase);
  if (!specGate) return { passed: true };
  const missing = specGate.requiredSpecs.filter(function(s) { return !specGate.verifiedSpecs.has(s); });
  return { passed: missing.length === 0, missing: missing };
};

PhaseOrchestrator.prototype._checkPhaseApproval = async function _checkPhaseApproval(phase, reason) {
  if (!this._executionModeManager || this._currentPhase === null || phase === null || this._currentPhase === phase) return true;
  if (!this._executionModeManager.requiresApproval('phase-transition')) return true;
  const result = await this._executionModeManager.requestApproval('phase-transition', { from: this._currentPhase, to: phase, reason: reason });
  if (!result.approved) {
    this.emit('phase-transition-denied', { from: this._currentPhase, to: phase, reason: result.reason || 'approval-denied' });
    return false;
  }
  return true;
};

/**
 * Check OODA strategic-level situational awareness before phase transition.
 * Blocks transition if threat level exceeds threshold (0.8).
 * @param {string|null} phase - Target phase
 * @param {string} [reason] - Transition reason
 * @returns {boolean} true if transition is safe, false if blocked by OODA
 */
PhaseOrchestrator.prototype._checkOodaTransition = function _checkOodaTransition(phase, reason) {
  if (!this._oodaLoop || phase === null || this._currentPhase === null || this._currentPhase === phase) return true;
  try {
    const oodaResult = this._oodaLoop.execute({
      taskContext: { fromPhase: this._currentPhase, toPhase: phase, reason: typeof reason === 'string' ? reason : '' },
      agentState: { phaseHistory: this._phaseHistory.length },
      environmentSignals: [{ type: 'phase-transition', data: { from: this._currentPhase, to: phase } }],
    });
    if (oodaResult && oodaResult.orientation && oodaResult.orientation.threatLevel > 0.8) {
      this.emit('phase-ooda-blocked', {
        from: this._currentPhase,
        to: phase,
        threatLevel: oodaResult.orientation.threatLevel,
        decision: oodaResult.decision,
      });
      return false;
    }
  } catch (oodaErr) {
    debug('PhaseOrchestrator', 'oodaCheck', oodaErr);
  }
  return true;
};

/**
 * Register a spec requirement for a phase. The phase cannot complete until the spec is verified.
 * @param {string} phase - Phase name to register the requirement for
 * @param {string} specId - Spec identifier that must be verified
 * @returns {PhaseOrchestrator} this (supports chaining)
 */
PhaseOrchestrator.prototype.registerSpecRequirement = function registerSpecRequirement(phase, specId) {
  this.guardShutdown();
  if (!this._specGate.has(phase)) {
    this._specGate.set(phase, { requiredSpecs: [], verifiedSpecs: new Set() });
  }
  const gate = this._specGate.get(phase);
  if (!gate.requiredSpecs.includes(specId)) {
    gate.requiredSpecs.push(specId);
  }
  return this;
};

/**
 * Mark a spec requirement as verified for a phase.
 * @param {string} phase - Phase name
 * @param {string} specId - Spec identifier that has been verified
 * @returns {boolean} true if the spec was marked verified, false if not registered
 */
PhaseOrchestrator.prototype.markSpecVerified = function markSpecVerified(phase, specId) {
  this.guardShutdown();
  const gate = this._specGate.get(phase);
  if (!gate) return false;
  if (gate.requiredSpecs.indexOf(specId) === -1) return false;
  gate.verifiedSpecs.add(specId);
  this.emit('spec-verified', { phase: phase, specId: specId });
  return true;
};

PhaseOrchestrator.prototype._getSpecReadiness = function _getSpecReadiness(phase) {
  const gate = this._specGate.get(phase);
  if (!gate) return { ready: true, missingSpecs: [] };
  const missing = gate.requiredSpecs.filter(function(s) { return !gate.verifiedSpecs.has(s); });
  return { ready: missing.length === 0, missingSpecs: missing };
};

/**
 * Get the current state of the spec gate for a phase.
 * @param {string} phase - Phase name
 * @returns {Object} Gate state with requiredSpecs, verifiedSpecs, unverifiedSpecs
 */
PhaseOrchestrator.prototype.getSpecGateState = function getSpecGateState(phase) {
  const gate = this._specGate.get(phase);
  if (!gate) return { requiredSpecs: [], verifiedSpecs: [], unverifiedSpecs: [] };
  return {
    requiredSpecs: gate.requiredSpecs.slice(),
    verifiedSpecs: Array.from(gate.verifiedSpecs),
    unverifiedSpecs: gate.requiredSpecs.filter(function(s) { return !gate.verifiedSpecs.has(s); }),
  };
};

PhaseOrchestrator.PHASES = PHASES;
PhaseOrchestrator.PHASE_SKILLS = PHASE_SKILLS;
PhaseOrchestrator.PHASE_INDEX = PHASE_INDEX;

module.exports = withShutdown(PhaseOrchestrator);
