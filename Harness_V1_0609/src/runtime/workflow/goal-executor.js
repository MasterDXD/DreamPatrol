'use strict';

/**
 * 目标执行器。管理目标的创建、分解、迭代执行和收敛检测。
 * 支持自动分解子任务、并行执行、质量评分、停滞检测和因果数据发布。
 *
 * @module runtime/workflow/goal-executor
 * @classdesc 目标执行器（GoalExecutor）。自主迭代收敛，自动分解子任务。
 * @fires GoalExecutor#goal-created
 * @fires GoalExecutor#goal-executing
 * @fires GoalExecutor#goal-decomposing
 * @fires GoalExecutor#goal-decomposed
 * @fires GoalExecutor#goal-iteration-start
 * @fires GoalExecutor#goal-iteration-complete
 * @fires GoalExecutor#goal-completed
 * @fires GoalExecutor#goal-failed
 * @fires GoalExecutor#goal-paused
 * @fires GoalExecutor#goal-resumed
 * @fires GoalExecutor#goal-cancelled
 * @fires GoalExecutor#circular-dependency-detected
 * @fires GoalExecutor#persist-error
 * @fires GoalExecutor#shutdown
 * @example
 * const executor = new GoalExecutor({ projectRoot: '/project' });
 * const { goalId } = executor.createGoal('Implement user auth');
 * const result = await executor.execute(goalId, async (ctx) => { /* ... *\/ });
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { generateId, DEFAULT_SUBTASK_TIMEOUT_MS, DEFAULT_METRICS_FLUSH_MS, MS_PER_DAY, DEFAULT_FORCE_EXIT_MS, DEFAULT_REQUEST_TIMEOUT_MS, HARNESS_DIR, JSON_EXT, MAX_DEBUG_PREVIEW_LENGTH } = require('../../utils/constants');
const { mergeConfig } = require('../../utils/safe-assign');
const { ensureDirSync, loadJsonAsync } = require('../../utils/fs-utils');
const { sanitizeObject } = require('../../utils/sanitizer');
const { HarnessError } = require('../../errors');
const { debug } = require('../../utils/debug-logger');
const { safeCall, safeCallAsync, roundTo, errorMessage, emitError, clamp01 } = require('../../utils/safe-execute');
const { writeAtomic, writeAtomicAsync } = require('../../utils/debounced-persister');
const deepClone = require('../../utils/deep-clone');
const BoundedMap = require('../../utils/bounded-map');
const { withShutdown } = require('../../utils/shutdown-mixin');

const ATTACH_DEFS = [
  { method: 'attachSessionManager', prop: '_sessionManager', validate: 'create' },
  { method: 'attachPlanPersistence', prop: '_planPersistence', validate: 'createPlan' },
  { method: 'attachDeepeningOrchestrator', prop: '_deepeningOrchestrator', validate: 'execute' },
  { method: 'attachSubagentExecutor', prop: '_subagentExecutor', validate: 'spawn' },
  { method: 'attachThoughtRetrieverCycle', prop: '_thoughtRetrieverCycle', validate: 'execute' },
  { method: 'attachCausalDataBus', prop: '_causalDataBus', validate: 'publishOutput' },
  { method: 'attachOodaLoop', prop: '_oodaLoop', validate: 'execute' },
];

const GOAL_STATUS = {
  PENDING: 'pending',
  DECOMPOSING: 'decomposing',
  EXECUTING: 'executing',
  ITERATING: 'iterating',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked',
  ERROR: 'error',
};

const VALID_GOAL_STATUSES = new Set(Object.values(GOAL_STATUS));

const SUBTASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  BLOCKED: 'blocked',
};

const DEFAULT_CONFIG = {
  maxIterations: 10,
  convergenceThreshold: 0.85,
  maxSubtasks: 20,
  iterationTimeout: DEFAULT_SUBTASK_TIMEOUT_MS,
  persistInterval: DEFAULT_METRICS_FLUSH_MS,
  goalTTL: 7 * MS_PER_DAY,
  maxConcurrentGoals: 5,
  autoDecompose: true,
  autoIterate: true,
  persistPath: HARNESS_DIR + '/goals/',
};

const VALID_GOAL_ID_RE = /^goal-[a-zA-Z0-9-]+$/;

const MAX_GOALS = 100;
const MAX_OBJECTIVE_LENGTH = 10000;
const MAX_QUALITY_HISTORY = 50;
const DEFAULT_SCORE_NO_SUBTASKS = 0.3;
const SUCCESS_SCORE = 0.8;
const FAILURE_SCORE = 0.2;
const DEFAULT_SUBTASK_SCORE = 0.1;
const BASE_WEIGHT = 0.5;
const CRITERIA_WEIGHT = 0.5;
const _INTERNAL_CONVERGENCE_THRESHOLD = 0.7;
const MIN_IMPROVEMENT = 0.005;
const STAGNATION_RATIO = 0.02;
const PROGRESS_SUBTASK_WEIGHT = 0.7;
const PROGRESS_ITERATION_WEIGHT = 0.3;
const SHUTDOWN_WAIT_TIMEOUT_MS = DEFAULT_FORCE_EXIT_MS;
const SHUTDOWN_POLL_INTERVAL_MS = 100;
const MAX_PERSIST_FAIL_COUNTS = 500;
const MAX_PERSIST_RETRIES = 5;
const MAX_PERSIST_LOCKS = 1000;
const MAX_LOOP_PROMISES = 100;
const DEFAULT_ITERATION_TIMEOUT_MS = 300000;

function _createTimeoutCancelPromises(timeoutMs, cancelSignal, timeoutMessage) {
  let timeoutId;
  let abortHandler = null;
  const timeoutPromise = new Promise(function(_, reject) {
    timeoutId = setTimeout(function() {
      reject(new HarnessError('TIMEOUT', timeoutMessage));
    }, timeoutMs);
    if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
  });
  const cancelPromise = new Promise(function(_, reject) {
    if (cancelSignal && cancelSignal.aborted) {
      reject(new HarnessError('CANCELLED', 'Goal cancelled'));
      return;
    }
    if (cancelSignal) {
      abortHandler = function() { reject(new HarnessError('CANCELLED', 'Goal cancelled')); };
      cancelSignal.addEventListener('abort', abortHandler, { once: true });
    }
  });
  function cleanup() {
    clearTimeout(timeoutId);
    if (abortHandler && cancelSignal) cancelSignal.removeEventListener('abort', abortHandler);
  }
  return { timeoutPromise, cancelPromise, cleanup };
}

/**
 * 目标执行器。管理目标生命周期：创建→分解→迭代执行→收敛/停滞→完成/失败。
 * @classdesc 目标执行器，管理目标的创建、分解、执行和收敛检测全生命周期
 * @extends EventEmitter
 * @param {Object} [options] - 配置选项
 * @param {string} [options.projectRoot] - 项目根目录
 * @param {number} [options.maxIterations=10] - 最大迭代次数
 * @param {number} [options.convergenceThreshold=0.85] - 收敛阈值
 * @param {number} [options.maxSubtasks=20] - 最大子任务数
 * @param {number} [options.maxConcurrentGoals=5] - 最大并发目标数
 * @param {boolean} [options.autoDecompose=true] - 自动分解子任务
 * @param {boolean} [options.autoIterate=true] - 自动迭代
 */
class GoalExecutor extends EventEmitter {
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this.root = (options && (options.projectRoot || options.root)) || null;
    this._validatePersistPath();
    this._goals = new Map();
    this._executingGoals = new Set();
    this._persistLocks = new Map();
    this._cancelSignals = new Map();
    this._loopPromises = new Map();
    this._sessionManager = null;
    this._planPersistence = null;
    this._deepeningOrchestrator = null;
    this._subagentExecutor = null;
    this._thoughtRetrieverCycle = null;
    this._oodaLoop = null;
    this._lastOodaOrientation = null;
    this._persistTimer = null;
    this._shuttingDown = false;
    this._initialized = !this.root;
    this._persistDir = path.join(this.root || process.cwd(), this._config.persistPath);
    this._stats = {
      totalGoalsCreated: 0,
      totalGoalsCompleted: 0,
      totalGoalsFailed: 0,
      totalIterations: 0,
      totalSubtasksExecuted: 0,
    };
    this._restorePromise = this._restoreGoals().then(() => {
      this._initialized = true;
    }).catch((err) => {
      debug('GoalExecutor', 'restoreGoalsInit', err);
      emitError(this, 'init-error', err, { phase: 'init' });
      this._initError = err;
    });
    this._startPersistTimer();
  }

  _buildGoalObject(goalId, objective, options) {
    return {
      goalId,
      objective: objective.trim(),
      status: GOAL_STATUS.PENDING,
      subtasks: [],
      successCriteria: Array.isArray(options && options.successCriteria) ? options.successCriteria : [],
      constraints: Array.isArray(options && options.constraints) ? options.constraints : [],
      context: (options && options.context && typeof options.context === 'object' && !Array.isArray(options.context)) ? options.context : {},
      currentIteration: 0,
      maxIterations: Math.max(1, Math.min(100, typeof (options && options.maxIterations) === 'number' && Number.isFinite(options.maxIterations) ? Math.trunc(options.maxIterations) : (Number.isFinite(parseInt(options && options.maxIterations, 10)) ? parseInt(options && options.maxIterations, 10) : this._config.maxIterations))),
      convergenceThreshold: (function() { const p = parseFloat(options && options.convergenceThreshold !== undefined ? options.convergenceThreshold : this._config.convergenceThreshold); return Number.isFinite(p) ? clamp01(p) : clamp01(this._config.convergenceThreshold); }).call(this),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      pausedAt: null,
      lastActivityResult: null,
      qualityHistory: [],
      metadata: (options && options.metadata) ?? {},
    };
  }

  /**
   * 创建新目标。
   * @param {string} objective - 目标描述
   * @param {Object} [options] - 目标选项
   * @param {string} [options.goalId] - 自定义目标ID
   * @param {number} [options.maxIterations] - 最大迭代次数
   * @param {number} [options.convergenceThreshold] - 收敛阈值
   * @param {boolean} [options.autoDecompose] - 是否自动分解子任务
   * @param {Function} [options.executeFn] - 自定义执行函数
   * @returns {{success: boolean, goalId?: string, error?: string}}
   * @throws {TypeError} If objective is not a non-empty string or options is invalid
   * @fires GoalExecutor#goal-created
   */
  createGoal(objective, options) {
    this.guardShutdown();
    if (!this._initialized) {
      if (this._initError) {
        return { success: false, error: 'GoalExecutor initialization failed: ' + (this._initError && this._initError.message ? this._initError.message : String(this._initError)) };
      }
      return { success: false, error: 'GoalExecutor not yet initialized' };
    }
    if (!objective || typeof objective !== 'string' || objective.trim().length === 0) {
      return { success: false, error: 'Objective must be a non-empty string' };
    }
    if (objective.length > MAX_OBJECTIVE_LENGTH) {
      return { success: false, error: 'Objective exceeds maximum length (10000 chars)' };
    }
    const activeGoalCount = this._countActiveGoals();
    if (activeGoalCount >= this._config.maxConcurrentGoals) {
      return { success: false, error: 'Maximum concurrent goals reached' };
    }

    const goalId = generateId('goal-');
    const goal = this._buildGoalObject(goalId, objective, options);

    this._goals.set(goalId, goal);
    this._stats.totalGoalsCreated++;
    if (this._goals.size > MAX_GOALS) {
      let evictKey = null;
      for (const [k, g] of this._goals) {
        if (g.status === GOAL_STATUS.COMPLETED || g.status === GOAL_STATUS.CANCELLED || g.status === GOAL_STATUS.FAILED) {
          evictKey = k;
          break;
        }
      }
      if (evictKey) {
        this._goals.delete(evictKey);
      } else {
        this._goals.delete(goalId);
        return { success: false, error: 'Maximum goals limit reached, no completed goals to evict' };
      }
    }
    this._persistGoal(goalId);
    this.emit('goal-created', { goalId, objective: goal.objective });
    debug('GoalExecutor', 'createGoal', { goalId, objective: objective.substring(0, MAX_DEBUG_PREVIEW_LENGTH) });

    return { success: true, goalId, status: goal.status };
  }

  _validateExecution(goalId, executeFn) {
    const goal = this._goals.get(goalId);
    if (!goal) return { error: 'Goal not found', goal: null };
    if (goal.status === GOAL_STATUS.COMPLETED || goal.status === GOAL_STATUS.CANCELLED) {
      return { error: `Goal already ${goal.status}`, goal };
    }
    if (goal.status === GOAL_STATUS.EXECUTING || goal.status === GOAL_STATUS.ITERATING || goal.status === GOAL_STATUS.DECOMPOSING) {
      return { error: 'Goal is already executing', goal };
    }
    if (this._executingGoals.size >= this._config.maxConcurrentGoals) {
      return { error: 'Maximum concurrent executing goals reached', goal };
    }
    if (!executeFn || typeof executeFn !== 'function') {
      return { error: 'executeFn must be a function', goal };
    }
    return { error: null, goal };
  }

  _publishCausalOutput(goal) {
    if (!this._causalDataBus) return;
    this._causalDataBus.publishOutput('goal-executor', {
      goalId: goal.goalId, objective: goal.objective, iterations: goal.currentIteration,
      qualityHistory: goal.qualityHistory, duration: (goal.completedAt && goal.startedAt) ? goal.completedAt - goal.startedAt : 0,
    }).catch(function(err) {
      debug('GoalExecutor', 'causalPublish', err && err.message ? err.message : String(err));
    });
  }

  _buildSuccessResult(goal, result) {
    return {
      success: true,
      goalId: goal.goalId,
      result: result,
      iterations: goal.currentIteration,
      qualityHistory: goal.qualityHistory,
      duration: (goal.completedAt && goal.startedAt) ? goal.completedAt - goal.startedAt : 0,
    };
  }

  /**
   * 执行目标。自动分解子任务（如启用），迭代执行直到收敛或停滞。
   * @param {string} goalId - 目标ID
   * @param {Function} executeFn - 执行函数，接收(iterationContext, executionOptions)参数
   * @param {Object} [options] - 执行选项
   * @returns {Promise<{success: boolean, goalId?: string, result?: *, iterations?: number, qualityHistory?: Array, duration?: number, error?: string, status?: string}>}
   * @fires GoalExecutor#goal-executing
   * @fires GoalExecutor#goal-completed
   * @fires GoalExecutor#goal-failed
   */
  async execute(goalId, executeFn, options) {
    this.guardShutdown();
    if (!this._initialized) {
      return { success: false, error: 'GoalExecutor not initialized' };
    }
    if (this._executingGoals.has(goalId)) {
      return { success: false, error: 'Goal is already executing', goalId };
    }
    this._executingGoals.add(goalId);
    try {
      const validation = this._validateExecution(goalId, executeFn);
      if (validation.error) {
        this._executingGoals.delete(goalId);
        return { success: false, error: validation.error };
      }
      const goal = validation.goal;

      goal.status = GOAL_STATUS.EXECUTING;
      goal.startedAt = goal.startedAt ?? Date.now();
      goal.updatedAt = Date.now();

      const abortController = new AbortController();
      this._cancelSignals.set(goalId, abortController);

      this._persistGoal(goalId);
      this.emit('goal-executing', { goalId, objective: goal.objective });

      try {
        if (this._config.autoDecompose && goal.subtasks.length === 0) {
          goal.status = GOAL_STATUS.DECOMPOSING;
          this.emit('goal-decomposing', { goalId });
          await this._decomposeGoal(goal, executeFn, options);
          if (this._shuttingDown) { goal.status = GOAL_STATUS.PAUSED; return { success: false, error: 'shutdown', goalId }; }
          if (goal.status === GOAL_STATUS.CANCELLED || goal.status === GOAL_STATUS.PAUSED) {
            return { success: false, error: `Goal ${goal.status}`, goalId, status: goal.status };
          }
        }

        goal.status = GOAL_STATUS.ITERATING;
        const result = await this._runGoalLoop(goal, executeFn, options);

        if (this._shuttingDown) { return { success: false, error: 'shutdown', goalId, status: goal.status }; }

        if (goal.status === GOAL_STATUS.CANCELLED || goal.status === GOAL_STATUS.PAUSED) {
          return { success: false, error: `Goal ${goal.status}`, goalId, status: goal.status };
        }

        goal.status = GOAL_STATUS.COMPLETED;
        goal.completedAt = Date.now();
        goal.updatedAt = Date.now();
        this._stats.totalGoalsCompleted++;
        this._persistGoal(goalId);
        this.emit('goal-completed', { goalId, objective: goal.objective, iterations: goal.currentIteration, duration: goal.completedAt - goal.startedAt });
        this._publishCausalOutput(goal);
        debug('GoalExecutor', 'goalCompleted', { goalId, iterations: goal.currentIteration });

        return this._buildSuccessResult(goal, result);
      } catch (err) {
        if (goal.status === GOAL_STATUS.PAUSED || goal.status === GOAL_STATUS.CANCELLED) {
          debug('GoalExecutor', 'goalInterrupted', { goalId, status: goal.status });
        } else {
          goal.status = GOAL_STATUS.FAILED;
          goal.updatedAt = Date.now();
          this._stats.totalGoalsFailed++;
          this._persistGoal(goalId);
          emitError(this, 'goal-failed', err, { goalId });
          debug('GoalExecutor', 'goalFailed', { goalId, error: errorMessage(err) });
        }

        return { success: false, error: errorMessage(err), goalId, iterations: goal.currentIteration };
      } finally {
        this._executingGoals.delete(goalId);
        this._cancelSignals.delete(goalId);
      }
    } catch (outerErr) {
      this._executingGoals.delete(goalId);
      this._cancelSignals.delete(goalId);
      return { success: false, error: errorMessage(outerErr), goalId };
    }
  }

  async _decomposeGoal(goal, executeFn, _options) {
    const decompositionPrompt = {
      objective: goal.objective,
      constraints: goal.constraints,
      successCriteria: goal.successCriteria,
      context: goal.context,
      _task: 'decompose',
      _maxSubtasks: this._config.maxSubtasks,
    };

    try {
      const decomposeResult = await executeFn(decompositionPrompt, {
        goalId: goal.goalId,
        phase: 'decompose',
        maxSubtasks: this._config.maxSubtasks,
      });

      if (this._shuttingDown) return;

      if (decomposeResult && Array.isArray(decomposeResult.subtasks)) {
        goal.subtasks = decomposeResult.subtasks.map((st, idx) => ({
          subtaskId: st.id || generateId('sub-'),
          index: idx,
          description: typeof st === 'string' ? st : st.description || st.name || '',
          status: SUBTASK_STATUS.PENDING,
          dependencies: st.dependencies ?? [],
          priority: st.priority ?? idx,
          result: null,
          startedAt: null,
          completedAt: null,
        }));
        this._detectCircularDependencies(goal.subtasks);
      } else if (decomposeResult && typeof decomposeResult === 'string') {
        goal.subtasks = decomposeResult.split('\n').filter(l => l.trim()).map((line, idx) => ({
          subtaskId: generateId('sub-'),
          index: idx,
          description: line.replace(/^[\d\.\-\*]+\s*/, '').trim(),
          status: SUBTASK_STATUS.PENDING,
          dependencies: [],
          priority: idx,
          result: null,
          startedAt: null,
          completedAt: null,
        }));
      }

      goal.updatedAt = Date.now();
      this._persistGoal(goal.goalId);
      this.emit('goal-decomposed', { goalId: goal.goalId, subtaskCount: goal.subtasks.length });
    } catch (err) {
      debug('GoalExecutor', 'decomposeError', { goalId: goal.goalId, error: err && err.message ? err.message : String(err) });
      goal.decompositionFailed = true;
      goal.subtasks = [{
        subtaskId: generateId('sub-'),
        index: 0,
        description: goal.objective,
        status: SUBTASK_STATUS.PENDING,
        dependencies: [],
        priority: 0,
        result: null,
        startedAt: null,
        completedAt: null,
      }];
    }
  }

  async _runGoalLoop(goal, executeFn, options) {
    let bestResult = goal.lastActivityResult ?? null;
    let bestScore = goal.bestScore ?? 0;
    const startIteration = goal.currentIteration ?? 0;

    for (let iteration = startIteration; iteration < goal.maxIterations; iteration++) {
      if (this._shuttingDown) break;
      if (goal.status === GOAL_STATUS.CANCELLED || goal.status === GOAL_STATUS.PAUSED) break;

      goal.currentIteration = iteration + 1;
      goal.updatedAt = Date.now();
      this.emit('goal-iteration-start', { goalId: goal.goalId, iteration: goal.currentIteration, maxIterations: goal.maxIterations });

      this._runOodaCycle(goal);

      const iterationContext = this._buildIterationContext(goal, iteration, bestResult, bestScore);

      const iterationResult = await this._executeIterationStep(goal, executeFn, iterationContext, options);

      if (this._shuttingDown) break;
      if (goal.status === GOAL_STATUS.CANCELLED || goal.status === GOAL_STATUS.PAUSED) break;

      bestResult = this._updateIterationResult(goal, iterationResult, bestResult);
      bestScore = goal.bestScore;

      this._stats.totalIterations++;
      this._persistGoal(goal.goalId);
      this.emit('goal-iteration-complete', { goalId: goal.goalId, iteration: goal.currentIteration, score: goal.qualityHistory.length > 0 ? goal.qualityHistory[goal.qualityHistory.length - 1].score : 0, bestScore });

      if (this._shouldStopLoop(goal, bestScore)) break;
    }

    return bestResult;
  }

  _updateIterationResult(goal, iterationResult, currentBestResult) {
    const qualityScore = this._evaluateIteration(iterationResult, goal);
    goal.qualityHistory.push({ iteration: goal.currentIteration, score: qualityScore, timestamp: Date.now() });
    if (goal.qualityHistory.length > MAX_QUALITY_HISTORY) {
      goal.qualityHistory = goal.qualityHistory.slice(-MAX_QUALITY_HISTORY);
    }
    goal.lastActivityResult = iterationResult;

    if (qualityScore > (goal.bestScore ?? 0)) {
      goal.bestScore = qualityScore;
      return iterationResult;
    }
    return currentBestResult;
  }

  _shouldStopLoop(goal, bestScore) {
    if (bestScore >= goal.convergenceThreshold) {
      debug('GoalExecutor', 'converged', { goalId: goal.goalId, score: bestScore, iteration: goal.currentIteration });
      return true;
    }
    if (this._isStagnant(goal.qualityHistory)) {
      debug('GoalExecutor', 'stagnant', { goalId: goal.goalId, iteration: goal.currentIteration });
      return true;
    }
    return false;
  }

  _runOodaCycle(goal) {
    if (!this._oodaLoop) return;
    try {
      const oodaResult = this._oodaLoop.execute({
        taskContext: { goalId: goal.goalId, objective: goal.objective, iteration: goal.currentIteration },
        agentState: { status: goal.status, qualityScore: goal.bestScore ?? 0 },
        environmentSignals: [{ type: 'goal-progress', data: { progress: goal.progress ?? 0, subtaskCount: goal.subtasks ? goal.subtasks.length : 0 } }],
      });
      if (oodaResult && oodaResult.orientation) {
        this._lastOodaOrientation = oodaResult.orientation;
      }
    } catch (oodaErr) {
      debug('GoalExecutor', 'oodaCycleError', { goalId: goal.goalId, error: oodaErr && oodaErr.message ? oodaErr.message : String(oodaErr) });
    }
  }

  async _executeIterationStep(goal, executeFn, iterationContext, options) {
    try {
      if (goal.subtasks.length > 0) {
        return await this._executeSubtasks(goal, executeFn, iterationContext, options);
      }
      return await this._executeSingle(goal, executeFn, iterationContext, options);
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      debug('GoalExecutor', 'iterationError', { goalId: goal.goalId, iteration: goal.currentIteration, error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  _buildIterationContext(goal, iteration, previousBest, previousScore) {
    const ctx = {
      objective: goal.objective,
      constraints: goal.constraints,
      successCriteria: goal.successCriteria,
      context: goal.context,
      _goalIteration: iteration + 1,
      _goalMaxIterations: goal.maxIterations,
      _previousBestResult: previousBest,
      _previousBestScore: previousScore,
      _qualityHistory: goal.qualityHistory.slice(),
      _goalId: goal.goalId,
    };

    if (this._planPersistence) {
      try {
        const injected = this._planPersistence.injectContext(goal.goalId, '');
        if (injected) ctx._antiDriftContext = injected;
      } catch (err) {
        debug('GoalExecutor', 'injectAntiDrift', err);
        // 反漂移注入失败不阻塞迭代，仅发出事件通知上层监控
        this.emit('anti-drift-inject-failed', { goalId: goal.goalId, error: err && err.message ? err.message : String(err) });
      }
    }

    return ctx;
  }

  async _executeSubtasks(goal, executeFn, iterationContext, _options) {
    const results = [];
    const pendingSubtasks = goal.subtasks.filter(
      st => st.status === SUBTASK_STATUS.PENDING || st.status === SUBTASK_STATUS.FAILED || st.status === SUBTASK_STATUS.BLOCKED,
    );

    const subtaskById = new Map();
    const subtaskByIndex = new Map();
    goal.subtasks.forEach(s => {
      if (s.subtaskId != null) subtaskById.set(String(s.subtaskId), s);
      if (s.index != null && Number.isFinite(Number(s.index))) subtaskByIndex.set(Number(s.index), s);
    });

    function _findDep(depId) {
      const byId = subtaskById.get(String(depId));
      if (byId) return byId;
      const numDepId = Number(depId);
      return Number.isFinite(numDepId) ? subtaskByIndex.get(numDepId) : undefined;
    }

    function _hasUnmetDeps(subtask) {
      const deps = subtask.dependencies ?? [];
      for (const depId of deps) {
        const dep = _findDep(depId);
        if (dep && dep.status !== SUBTASK_STATUS.COMPLETED) return true;
      }
      return false;
    }

    const independent = [];
    const dependent = [];
    for (const subtask of pendingSubtasks) {
      if (_hasUnmetDeps(subtask)) {
        subtask.status = SUBTASK_STATUS.BLOCKED;
        dependent.push(subtask);
      } else {
        independent.push(subtask);
      }
    }

    if (independent.length > 1) {
      const parallelResults = await this._executeSubtasksParallel(goal, independent, executeFn, iterationContext);
      if (this._shuttingDown) return results;
      results.push(...parallelResults);
    } else {
      for (const subtask of independent) {
        if (goal.status === GOAL_STATUS.CANCELLED || goal.status === GOAL_STATUS.PAUSED) break;
        const r = await this._executeOneSubtask(goal, subtask, executeFn, iterationContext);
        if (this._shuttingDown) break;
        results.push(r);
      }
    }

    for (const subtask of dependent) {
      if (goal.status === GOAL_STATUS.CANCELLED || goal.status === GOAL_STATUS.PAUSED) break;
      if (_hasUnmetDeps(subtask)) {
        subtask.status = SUBTASK_STATUS.PENDING;
        continue;
      }
      subtask.status = SUBTASK_STATUS.PENDING;
      const r = await this._executeOneSubtask(goal, subtask, executeFn, iterationContext);
      if (this._shuttingDown) break;
      results.push(r);
    }

    const completedCount = goal.subtasks.reduce((c, st) => c + (st.status === SUBTASK_STATUS.COMPLETED ? 1 : 0), 0);
    const totalCount = goal.subtasks.length;
    return {
      subtaskResults: results,
      progress: totalCount > 0 ? completedCount / totalCount : 1,
      completedSubtasks: completedCount,
      totalSubtasks: totalCount,
    };
  }

  async _executeSubtasksParallel(goal, subtasks, executeFn, iterationContext) {
    const cancelSignal = this._cancelSignals.get(goal.goalId);
    const subtaskTimeout = this._config.iterationTimeout ?? DEFAULT_ITERATION_TIMEOUT_MS;
    const promises = subtasks.map(subtask => {
      subtask.status = SUBTASK_STATUS.RUNNING;
      subtask.startedAt = Date.now();
      this._stats.totalSubtasksExecuted++;

      const subtaskContext = mergeConfig(iterationContext, {
        _subtaskId: subtask.subtaskId,
        _subtaskDescription: subtask.description,
        _subtaskIndex: subtask.index,
        _task: 'execute-subtask',
      });

      const { timeoutPromise, cancelPromise, cleanup } = _createTimeoutCancelPromises(
        subtaskTimeout, cancelSignal, 'Subtask ' + subtask.subtaskId + ' timed out',
      );

      const execPromise = executeFn(subtaskContext, { goalId: goal.goalId, subtaskId: subtask.subtaskId, phase: 'execute', timeout: subtaskTimeout, signal: cancelSignal });
      execPromise.catch(function(err) { /* prevent unhandled rejection if timeout/cancel resolves first */ const msg = err && err.message ? err.message : String(err); debug('GoalExecutor', 'subtask-exec-suppressed', msg); });

      return Promise.race([
        execPromise,
        timeoutPromise,
        cancelPromise,
      ]).then(result => {
        cleanup();
        subtask.status = SUBTASK_STATUS.COMPLETED;
        subtask.result = result;
        subtask.completedAt = Date.now();
        return { subtaskId: subtask.subtaskId, success: true, result };
      }).catch(err => {
        cleanup();
        subtask.status = SUBTASK_STATUS.FAILED;
        subtask.result = { error: errorMessage(err) };
        subtask.completedAt = Date.now();
        return { subtaskId: subtask.subtaskId, success: false, error: errorMessage(err) };
      });
    });

    const settled = await Promise.allSettled(promises);
    if (this._shuttingDown) return settled.map(r => r.status === 'fulfilled' ? r.value : { subtaskId: 'unknown', success: false });
    goal.updatedAt = Date.now();
    this._persistGoal(goal.goalId);
    return settled.map(r => r.status === 'fulfilled' ? r.value : { subtaskId: 'unknown', success: false, error: String(r.reason) });
  }

  async _executeOneSubtask(goal, subtask, executeFn, iterationContext) {
    if (goal.status === GOAL_STATUS.CANCELLED || goal.status === GOAL_STATUS.PAUSED) {
      return { subtaskId: subtask.subtaskId, success: false, error: 'Goal paused or cancelled' };
    }

    subtask.status = SUBTASK_STATUS.RUNNING;
    subtask.startedAt = Date.now();
    this._stats.totalSubtasksExecuted++;

    const cancelSignal = this._cancelSignals.get(goal.goalId);
    let cleanup = function() {};
    try {
      const subtaskContext = mergeConfig(iterationContext, {
        _subtaskId: subtask.subtaskId,
        _subtaskDescription: subtask.description,
        _subtaskIndex: subtask.index,
        _task: 'execute-subtask',
      });

      const subtaskTimeout = this._config.iterationTimeout ?? DEFAULT_SUBTASK_TIMEOUT_MS;
      const tc = _createTimeoutCancelPromises(
        subtaskTimeout, cancelSignal, 'Subtask ' + subtask.subtaskId + ' timed out after ' + subtaskTimeout + 'ms',
      );
      cleanup = tc.cleanup;

      const execPromise = executeFn(subtaskContext, {
        goalId: goal.goalId,
        subtaskId: subtask.subtaskId,
        phase: 'execute',
        timeout: subtaskTimeout,
        signal: cancelSignal,
      });
      execPromise.catch(function(err) { /* prevent unhandled rejection if timeout/cancel resolves first */ const msg = err && err.message ? err.message : String(err); debug('GoalExecutor', 'exec-suppressed', msg); });

      const result = await Promise.race([
        execPromise,
        tc.timeoutPromise,
        tc.cancelPromise,
      ]);
      cleanup();

      if (this._shuttingDown) { return { subtaskId: subtask.subtaskId, success: false, error: 'shutdown' }; }

      subtask.status = SUBTASK_STATUS.COMPLETED;
      subtask.result = result;
      subtask.completedAt = Date.now();
      goal.updatedAt = Date.now();
      this._persistGoal(goal.goalId);
      return { subtaskId: subtask.subtaskId, success: true, result };
    } catch (err) {
      cleanup();
      subtask.status = SUBTASK_STATUS.FAILED;
      subtask.result = { error: errorMessage(err) };
      subtask.completedAt = Date.now();
      goal.updatedAt = Date.now();
      this._persistGoal(goal.goalId);
      return { subtaskId: subtask.subtaskId, success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async _executeSingle(goal, executeFn, iterationContext, _options) {
    const timeout = this._config.iterationTimeout ?? DEFAULT_ITERATION_TIMEOUT_MS;
    const cancelSignal = this._cancelSignals.get(goal.goalId);
    const { timeoutPromise, cancelPromise, cleanup } = _createTimeoutCancelPromises(
      timeout, cancelSignal, 'Goal iteration timeout after ' + timeout + 'ms',
    );
    try {
      const execResultPromise = executeFn(iterationContext, {
        goalId: goal.goalId,
        phase: 'execute',
        timeout: timeout,
      });
      execResultPromise.catch(function(err) { debug('GoalExecutor', 'executeFailed', err && err.message ? err.message : String(err)); });
      const result = await Promise.race([
        execResultPromise,
        timeoutPromise,
        cancelPromise,
      ]);
      if (this._shuttingDown) return { success: false, error: 'shutdown' };
      return result;
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      this.emit('goal-iteration-error', { goalId: goal.goalId, iteration: goal.currentIteration, error: errMsg });
      return { success: false, error: errMsg, timedOut: errMsg.includes('timeout') };
    } finally {
      cleanup();
    }
  }

  _evaluateIteration(result, goal) {
    if (!result) return 0;
    let score = this._computeBaseScore(result);
    score = this._applyCriteriaScore(result, goal, score);
    return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
  }

  _computeBaseScore(result) {
    if (result.subtaskResults) {
      const total = result.totalSubtasks ?? 1;
      const completed = result.completedSubtasks ?? 0;
      if (total <= 0) return DEFAULT_SCORE_NO_SUBTASKS;
      return completed / total;
    }
    if (result.qualityScore !== undefined) {
      return typeof result.qualityScore === 'number' ? result.qualityScore : 0;
    }
    if (result.success === true) return SUCCESS_SCORE;
    if (result.success === false) return FAILURE_SCORE;
    return DEFAULT_SUBTASK_SCORE;
  }

  _applyCriteriaScore(result, goal, baseScore) {
    if (!goal.successCriteria || goal.successCriteria.length === 0) return baseScore;
    let criteriaMet = 0;
    const verification = result.verification || (result.goalVerification ?? {});
    for (const criterion of goal.successCriteria) {
      const key = String(criterion);
      if (verification[key] === true || verification[key] === 'passed' ||
          (typeof verification[key] === 'object' && verification[key] !== null && verification[key].passed === true)) {
        criteriaMet++;
      }
    }
    const criteriaScore = goal.successCriteria.length > 0 ? criteriaMet / goal.successCriteria.length : 0;
    return baseScore * BASE_WEIGHT + criteriaScore * CRITERIA_WEIGHT;
  }

  _isStagnant(qualityHistory) {
    if (qualityHistory.length < 5) return false;
    const recent = qualityHistory.slice(-5);
    const scores = recent.map(r => typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : 0);
    const improvement = scores.length > 1 ? scores[scores.length - 1] - scores[0] : 0;
    const lastScore = scores.length > 0 ? scores[scores.length - 1] : 0;
    if (lastScore >= _INTERNAL_CONVERGENCE_THRESHOLD) return improvement < MIN_IMPROVEMENT;
    return improvement < STAGNATION_RATIO;
  }

  _detectCircularDependencies(subtasks) {
    const graph = new Map();
    subtasks.forEach(st => {
      const id = st.subtaskId || st.index;
      graph.set(id, (st.dependencies ?? []).map(d => d.subtaskId || d));
    });
    const visited = new Set();
    const inStack = new Set();
    const cycles = [];
    const parentMap = new Map();

    for (const [startNode] of graph) {
      if (visited.has(startNode)) continue;
      const stack = [{ node: startNode, neighborIdx: 0 }];
      parentMap.set(startNode, null);
      inStack.add(startNode);
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (!frame) break;
        const neighbors = graph.get(frame.node) ?? [];
        if (frame.neighborIdx >= neighbors.length) {
          inStack.delete(frame.node);
          visited.add(frame.node);
          stack.pop();
          continue;
        }
        const neighbor = neighbors[frame.neighborIdx];
        frame.neighborIdx++;
        if (inStack.has(neighbor)) {
          const cycle = [];
          let cur = frame.node;
          while (cur != null && cur !== neighbor) {
            cycle.push(cur);
            cur = parentMap.get(cur);
          }
          if (cur === neighbor) {
            cycle.push(neighbor);
            cycle.reverse();
            cycles.push(cycle);
          }
        } else if (!visited.has(neighbor)) {
          inStack.add(neighbor);
          parentMap.set(neighbor, frame.node);
          stack.push({ node: neighbor, neighborIdx: 0 });
        }
      }
    }

    if (cycles.length > 0) {
      const subtaskMap = new Map();
      for (const st of subtasks) {
        subtaskMap.set(st.subtaskId || st.index, st);
      }
      for (const cycle of cycles) {
        for (const nodeId of cycle) {
          const st = subtaskMap.get(nodeId);
          if (st && st.status === SUBTASK_STATUS.PENDING) {
            st.status = SUBTASK_STATUS.BLOCKED;
            st._circularDependency = true;
          }
        }
      }
      this.emit('circular-dependency-detected', { cycles, blockedCount: cycles.flat().length });
    }
    return cycles;
  }

  /**
   * 暂停目标执行。
   * @param {string} goalId - 目标ID
   * @returns {{success: boolean, error?: string}}
   * @fires GoalExecutor#goal-paused
   */
  pause(goalId) {
    this.guardShutdown();
    if (!goalId || typeof goalId !== 'string') return { success: false, error: 'goalId must be a non-empty string' };
    const goal = this._goals.get(goalId);
    if (!goal) return { success: false, error: 'Goal not found' };
    if (goal.status !== GOAL_STATUS.EXECUTING && goal.status !== GOAL_STATUS.ITERATING && goal.status !== GOAL_STATUS.DECOMPOSING) {
      return { success: false, error: `Cannot pause goal in ${goal.status} state` };
    }

    goal.status = GOAL_STATUS.PAUSED;
    goal.pausedAt = Date.now();
    goal.updatedAt = Date.now();
    const signal = this._cancelSignals.get(goalId);
    if (signal && !signal.aborted) {
      safeCall(() => signal.abort(), 'GoalExecutor', 'cancelAbort');
    }
    this._executingGoals.delete(goalId);
    this._persistGoal(goalId);
    this.emit('goal-paused', { goalId, iteration: goal.currentIteration });
    return { success: true, goalId, status: goal.status };
  }

  /**
   * 恢复暂停的目标执行。
   * @param {string} goalId - 目标ID
   * @param {Function} executeFn - 执行函数
   * @param {Object} [options] - 恢复选项
   * @returns {Promise<{success: boolean, error?: string}>}
   * @fires GoalExecutor#goal-resumed
   */
  resume(goalId, executeFn, options) {
    this.guardShutdown();
    if (!this._initialized) {
      if (this._restorePromise) {
        debug('GoalExecutor', 'resume', 'Waiting for restore to complete before resuming goal: ' + goalId);
        return this._restorePromise.then(() => this.resume(goalId)).catch((err) => { debug('GoalExecutor', 'resumeAfterRestore', err && err.message ? err.message : String(err)); throw err; });
      }
      return { success: false, error: 'GoalExecutor not initialized' };
    }
    if (!goalId || typeof goalId !== 'string') return { success: false, error: 'goalId must be a non-empty string' };
    const goal = this._goals.get(goalId);
    if (!goal) return { success: false, error: 'Goal not found' };
    if (goal.status !== GOAL_STATUS.PAUSED) {
      return { success: false, error: `Cannot resume goal in ${goal.status} state` };
    }
    if (this._executingGoals.has(goalId)) {
      return { success: false, error: 'Goal is already resuming/executing' };
    }

    if (this._executingGoals.size >= this._config.maxConcurrentGoals) {
      return { success: false, error: 'Maximum concurrent executing goals reached' };
    }

    const _previousStatus = goal.status;
    goal.status = GOAL_STATUS.ITERATING;
    goal.pausedAt = null;
    goal.updatedAt = Date.now();
    this._executingGoals.add(goalId);

    const controller = new AbortController();
    this._cancelSignals.set(goalId, controller);

    this._persistGoal(goalId);
    this.emit('goal-resumed', { goalId, iteration: goal.currentIteration });

    if (typeof executeFn === 'function') {
      const opts = mergeConfig(options, { signal: controller.signal });
      const iterationBefore = goal.currentIteration;
      const loopPromise = this._runGoalLoop(goal, executeFn, opts).then(() => {
        try {
          if (goal.status === GOAL_STATUS.PAUSED || goal.status === GOAL_STATUS.CANCELLED) {
            this._persistGoal(goalId);
            return;
          }
          if (goal.status === GOAL_STATUS.ITERATING || goal.status === GOAL_STATUS.EXECUTING) {
            if (goal.currentIteration === iterationBefore) {
              goal.status = GOAL_STATUS.PAUSED;
              goal.pausedAt = Date.now();
              goal.updatedAt = Date.now();
              this.emit('goal-paused', { goalId, reason: 'no-iterations-executed' });
            } else if (goal.bestScore !== undefined && goal.bestScore < goal.convergenceThreshold) {
              goal.status = GOAL_STATUS.PAUSED;
              goal.updatedAt = Date.now();
              this.emit('goal-paused', { goalId, reason: 'not-converged', bestScore: goal.bestScore });
            } else {
              goal.status = GOAL_STATUS.COMPLETED;
              goal.completedAt = Date.now();
              goal.updatedAt = Date.now();
              this._stats.totalGoalsCompleted++;
              this.emit('goal-completed', { goalId });
            }
          }
          this._persistGoal(goalId);
        } catch (cleanupErr) {
          debug('GoalExecutor', 'resumeCleanupError', { goalId, error: (cleanupErr && cleanupErr.message) || String(cleanupErr) });
        }
      }).catch((err) => {
        try {
          debug('GoalExecutor', 'resumeLoopError', { goalId, error: errorMessage(err) });
          goal.status = GOAL_STATUS.ERROR;
          this._stats.totalGoalsFailed++;
          goal.updatedAt = Date.now();
          this._persistGoal(goalId);
          emitError(this, 'goal-failed', err, { goalId });
        } catch (innerErr) {
          debug('GoalExecutor', 'resumeLoopErrorHandlerError', { goalId, error: errorMessage(innerErr) });
        }
      }).finally(() => {
        this._executingGoals.delete(goalId);
        this._cancelSignals.delete(goalId);
        this._loopPromises.delete(goalId);
      });
      this._loopPromises.set(goalId, loopPromise);
      if (this._loopPromises.size > MAX_LOOP_PROMISES) {
        const toDelete = [];
        const entries = Array.from(this._loopPromises.entries());
        for (const [key, val] of entries) {
          if (!val || typeof val.then !== 'function') {
            toDelete.push(key);
          }
        }
        for (const key of toDelete) {
          this._loopPromises.delete(key);
        }
        while (this._loopPromises.size > MAX_LOOP_PROMISES) {
          const oldestKey = this._loopPromises.keys().next().value;
          if (oldestKey) {
            const oldest = this._loopPromises.get(oldestKey);
            if (oldest && typeof oldest.then === 'function') {
              oldest.catch(function(err) {
                debug('GoalExecutor', 'loopPromiseEvicted', err && err.message ? err.message : String(err));
              });
            }
            this._loopPromises.delete(oldestKey);
          } else {
            break;
          }
        }
      }
    } else {
      debug('GoalExecutor', 'resumeGoalNoExecuteFn', { goalId });
      goal.status = GOAL_STATUS.PAUSED;
      goal.updatedAt = Date.now();
      this._executingGoals.delete(goalId);
      this._cancelSignals.delete(goalId);
      this._persistGoal(goalId);
      this.emit('goal-paused', { goalId, reason: 'no-execute-fn' });
    }

    return { success: true, goalId, status: goal.status };
  }

  /**
   * 取消目标执行。
   * @param {string} goalId - 目标ID
   * @returns {{success: boolean, error?: string}}
   * @fires GoalExecutor#goal-cancelled
   */
  cancel(goalId) {
    this.guardShutdown();
    if (!goalId || typeof goalId !== 'string') return { success: false, error: 'goalId must be a non-empty string' };
    const goal = this._goals.get(goalId);
    if (!goal) return { success: false, error: 'Goal not found' };
    if (goal.status === GOAL_STATUS.COMPLETED || goal.status === GOAL_STATUS.CANCELLED) {
      return { success: false, error: `Cannot cancel goal in ${goal.status} state` };
    }

    const signal = this._cancelSignals.get(goalId);
    if (signal) {
      safeCall(() => signal.abort(), 'GoalExecutor', 'signalAbort');
      this._cancelSignals.delete(goalId);
    }

    goal.status = GOAL_STATUS.CANCELLED;
    goal.updatedAt = Date.now();
    goal.completedAt = Date.now();
    this._executingGoals.delete(goalId);
    this._persistGoal(goalId);
    this.emit('goal-cancelled', { goalId, iteration: goal.currentIteration });
    return { success: true, goalId, status: goal.status };
  }

  /**
   * 获取目标信息。
   * @param {string} goalId - 目标ID
   * @returns {Object|null} 目标对象，不存在返回null
   */
  getGoal(goalId) {
    const goal = this._goals.get(goalId);
    if (!goal) return null;
    return this._sanitizeGoal(goal);
  }

  /**
   * 列出所有目标，可按状态过滤。
   * @param {string} [statusFilter] - 状态过滤（pending/executing/completed/failed/paused/cancelled）
   * @returns {Object[]} 目标对象数组
   */
  listGoals(statusFilter) {
    const goals = Array.from(this._goals.values())
      .filter(goal => !statusFilter || goal.status === statusFilter)
      .map(goal => this._sanitizeGoal(goal));
    return goals;
  }

  /**
   * 获取目标执行进度，包含子任务进度、迭代进度、质量评分和耗时。
   * @param {string} goalId - 目标ID
   * @returns {Object|null} 进度对象，目标不存在时返回null
   */
  getProgress(goalId) {
    const goal = this._goals.get(goalId);
    if (!goal) return null;

    const totalSubtasks = goal.subtasks.length;
    let completedSubtasks = 0;
    let failedSubtasks = 0;
    for (const st of goal.subtasks) {
      if (st.status === SUBTASK_STATUS.COMPLETED) completedSubtasks++;
      else if (st.status === SUBTASK_STATUS.FAILED) failedSubtasks++;
    }
    const subtaskProgress = totalSubtasks > 0 ? completedSubtasks / totalSubtasks : 0;
    const iterationProgress = goal.maxIterations > 0 ? goal.currentIteration / goal.maxIterations : 0;
    const overallProgress = totalSubtasks > 0 ? subtaskProgress * PROGRESS_SUBTASK_WEIGHT + iterationProgress * PROGRESS_ITERATION_WEIGHT : iterationProgress;
    const lastScore = goal.qualityHistory.length > 0 ? goal.qualityHistory[goal.qualityHistory.length - 1].score : 0;
    const elapsed = goal.startedAt ? Date.now() - goal.startedAt : 0;

    return {
      goalId,
      objective: goal.objective,
      status: goal.status,
      currentIteration: goal.currentIteration,
      maxIterations: goal.maxIterations,
      subtaskProgress: roundTo(subtaskProgress, 2),
      iterationProgress: roundTo(iterationProgress, 2),
      overallProgress: roundTo(overallProgress, 2),
      completedSubtasks,
      totalSubtasks,
      failedSubtasks,
      lastQualityScore: lastScore,
      convergenceThreshold: goal.convergenceThreshold,
      elapsed,
      qualityHistory: goal.qualityHistory.slice(-5),
    };
  }

  _sanitizeGoal(goal) {
    return {
      goalId: goal.goalId,
      objective: goal.objective,
      status: goal.status,
      subtaskCount: goal.subtasks.length,
      completedSubtasks: goal.subtasks.reduce((c, st) => c + (st.status === SUBTASK_STATUS.COMPLETED ? 1 : 0), 0),
      currentIteration: goal.currentIteration,
      maxIterations: goal.maxIterations,
      convergenceThreshold: goal.convergenceThreshold,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      startedAt: goal.startedAt,
      completedAt: goal.completedAt,
      pausedAt: goal.pausedAt,
      lastQualityScore: goal.qualityHistory.length > 0 ? goal.qualityHistory[goal.qualityHistory.length - 1].score : null,
      successCriteria: goal.successCriteria,
      constraints: goal.constraints,
    };
  }

  _countActiveGoals() {
    const activeStatuses = new Set([GOAL_STATUS.PENDING, GOAL_STATUS.EXECUTING, GOAL_STATUS.DECOMPOSING, GOAL_STATUS.ITERATING, GOAL_STATUS.PAUSED]);
    return [...this._goals.values()].filter(g => activeStatuses.has(g.status)).length;
  }

  _validatePersistPath() {
    const root = this.root ?? process.cwd();
    const resolved = path.resolve(root, this._config.persistPath);
    const rootResolved = path.resolve(root);
    if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
      this._config.persistPath = HARNESS_DIR + '/goals/';
      debug('GoalExecutor', 'persistPathTraversal', { original: this._config.persistPath, fallback: HARNESS_DIR + '/goals/' });
    }
  }

  _persistGoal(goalId) {
    try {
      const goal = this._goals.get(goalId);
      if (!goal) return;
      if (!VALID_GOAL_ID_RE.test(goalId)) {
        debug('GoalExecutor', 'persistInvalidGoalId', { goalId });
        return;
      }

      if (!this._persistFailCounts) this._persistFailCounts = new BoundedMap(100);
      const failCount = this._persistFailCounts.get(goalId) ?? 0;
      if (failCount >= MAX_PERSIST_RETRIES) {
        debug('GoalExecutor', 'persistSkipped', { goalId, reason: 'too many consecutive failures' });
        return;
      }

      const PERSIST_LOCK_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;
      const restoreReady = this._restorePromise || Promise.resolve();
      const prev = this._persistLocks.get(goalId) || Promise.resolve();
      const snapshot = deepClone(goal);
      let lockBypassed = false;
      const lockTimeout = new Promise((resolve) => { const t = setTimeout(() => { lockBypassed = true; resolve(); }, PERSIST_LOCK_TIMEOUT_MS); if (t && typeof t.unref === 'function') t.unref(); });
      const next = restoreReady.then(() => Promise.race([prev, lockTimeout])).then(() => {
        if (lockBypassed) {
          debug('GoalExecutor', 'persistLockBypassed', { goalId, timeoutMs: PERSIST_LOCK_TIMEOUT_MS });
          this.emit('persist-lock-timeout', { goalId, timeoutMs: PERSIST_LOCK_TIMEOUT_MS });
        }
        return this._persistGoalAsync(goalId, snapshot).then(() => {
          this._persistFailCounts.delete(goalId);
        }).catch((err) => {
          const currentFails = (this._persistFailCounts.get(goalId) ?? 0) + 1;
          this._persistFailCounts.set(goalId, currentFails);
          debug('GoalExecutor', 'persistError', { goalId, error: err && err.message ? err.message : String(err), consecutiveFails: currentFails });
          emitError(this, 'persist-error', err, { goalId });
        });
      }).catch((err) => {
        debug('GoalExecutor', 'persistLockError', { goalId, error: err && err.message ? err.message : String(err) });
      }).finally(() => {
        if (this._persistLocks.get(goalId) === next) {
          this._persistLocks.delete(goalId);
        }
        if (this._persistFailCounts && this._persistFailCounts.size > MAX_PERSIST_FAIL_COUNTS) {
          const keysToDelete = [];
          this._persistFailCounts.forEach((v, k) => {
            if (v >= MAX_PERSIST_RETRIES) keysToDelete.push(k);
          });
          keysToDelete.forEach((k) => { this._persistFailCounts.delete(k); });
        }
      });
      this._persistLocks.set(goalId, next);
      if (this._persistLocks.size > MAX_PERSIST_LOCKS) {
        const oldestKey = this._persistLocks.keys().next().value;
        if (oldestKey !== goalId) this._persistLocks.delete(oldestKey);
      }
    } catch (outerErr) {
      debug('GoalExecutor', 'persistUnexpectedError', { goalId, error: outerErr && outerErr.message ? outerErr.message : String(outerErr) });
    }
  }

  async _persistGoalAsync(goalId, goal) {
    const dir = this._persistDir;
    const filePath = path.join(dir, goalId + JSON_EXT);
    try {
      await writeAtomicAsync(filePath, goal);
    } catch (writeErr) {
      debug('GoalExecutor', 'persistWriteError', { goalId, error: writeErr && writeErr.message ? writeErr.message : String(writeErr) });
      emitError(this, 'persist-error', writeErr, { goalId, phase: 'write' });
    }
  }

  _persistGoalSync(goalId) {
    const goal = this._goals.get(goalId);
    if (!goal) return;
    try {
      const dir = this._persistDir;
      ensureDirSync(dir);
      const filePath = path.join(dir, goalId + JSON_EXT);
      writeAtomic(filePath, goal);
    } catch (err) {
      debug('GoalExecutor', 'persistGoalSyncError', { goalId, error: err && err.message ? err.message : String(err) });
    }
  }

  async _restoreGoals() {
    try {
      const fsp = fs.promises;
      const dir = this._persistDir;
      try { await fsp.access(dir); } catch (e) { debug('GoalExecutor', 'restoreDirNotFound', e); return; }
      const files = await fsp.readdir(dir);
      const jsonFiles = files.filter(f => f.endsWith(JSON_EXT));
      const now = Date.now();
      for (const file of jsonFiles) {
        await this._restoreSingleGoal(dir, file, now);
      }
    } catch (e) {
      debug('GoalExecutor', 'restoreGoalsError', e);
      if (typeof this.emit === 'function') {
        this.emit('restore-error', { error: e && e.message ? e.message : String(e), operation: 'restoreGoals' });
      }
    }
  }

  async _restoreSingleGoal(dir, file, now) {
    try {
      const raw = await loadJsonAsync(path.join(dir, file));
      if (!raw) return;
      const goal = this._sanitizePrototype(raw);
      if (!goal.goalId || typeof goal.goalId !== 'string') return;
      if (!goal.objective || typeof goal.objective !== 'string') return;
      if (!VALID_GOAL_STATUSES.has(goal.status)) return;
      this._sanitizeRestoredGoal(goal);
      const age = now - (goal.updatedAt ?? (goal.createdAt ?? 0));
      if (age > this._config.goalTTL) {
        await safeCallAsync(() => fs.promises.unlink(path.join(dir, file)), 'GoalExecutor', 'cleanupExpired');
        return;
      }
      if (goal.status === GOAL_STATUS.EXECUTING || goal.status === GOAL_STATUS.ITERATING || goal.status === GOAL_STATUS.DECOMPOSING) {
        goal.status = GOAL_STATUS.PAUSED;
        goal.pausedAt = goal.pausedAt ?? Date.now();
      }
      this._goals.set(goal.goalId, goal);
    } catch (e) { debug('GoalExecutor', 'restoreSingleError', e); }
  }

  _sanitizePrototype(obj) {
    return sanitizeObject(obj);
  }

  _sanitizeRestoredGoal(goal) {
    goal.maxIterations = Math.max(1, Math.min(100, Number.isFinite(goal.maxIterations) ? Math.trunc(goal.maxIterations) : (Number.isFinite(parseInt(goal.maxIterations, 10)) ? parseInt(goal.maxIterations, 10) : this._config.maxIterations)));
    const _ct = parseFloat(goal.convergenceThreshold !== undefined ? goal.convergenceThreshold : this._config.convergenceThreshold);
    goal.convergenceThreshold = Number.isFinite(_ct) ? clamp01(_ct) : clamp01(this._config.convergenceThreshold);
    goal.subtasks = Array.isArray(goal.subtasks) ? goal.subtasks.slice(0, this._config.maxSubtasks) : [];
    goal.successCriteria = Array.isArray(goal.successCriteria) ? goal.successCriteria : [];
    goal.constraints = Array.isArray(goal.constraints) ? goal.constraints : [];
    goal.qualityHistory = Array.isArray(goal.qualityHistory) ? goal.qualityHistory.slice(-20) : [];
  }

  _startPersistTimer() {
    if (this._persistTimer) clearInterval(this._persistTimer);
    this._persistTimer = setInterval(() => {
      if (this._shutDown || !this._initialized) return;
      for (const goalId of this._goals.keys()) {
        this._persistGoal(goalId);
      }
    }, this._config.persistInterval);
    if (this._persistTimer && typeof this._persistTimer.unref === 'function') this._persistTimer.unref();
  }

  /**
   * 获取执行器统计信息，包括创建/完成/失败目标数、活跃/执行中/暂停目标数。
   * @returns {{ totalGoalsCreated: number, totalGoalsCompleted: number, totalGoalsFailed: number, totalIterations: number, totalSubtasksExecuted: number, activeGoals: number, executingGoals: number, pausedGoals: number }}
   */
  getStats() {
    return mergeConfig(this._stats, {
      activeGoals: this._countActiveGoals(),
      executingGoals: this._executingGoals.size,
      pausedGoals: Array.from(this._goals.values()).reduce((c, g) => c + (g.status === GOAL_STATUS.PAUSED ? 1 : 0), 0),
    });
  }

  _getCompletedGoalIds() {
    const maxCompletedAge = MS_PER_DAY;
    const now = Date.now();
    return Array.from(this._goals.entries())
      .filter(([, goal]) =>
        (goal.status === GOAL_STATUS.COMPLETED || goal.status === GOAL_STATUS.CANCELLED || goal.status === GOAL_STATUS.FAILED) &&
        goal.updatedAt && (now - goal.updatedAt) > maxCompletedAge,
      )
      .map(([goalId]) => goalId);
  }

  _removeGoalFromMemory(goalId) {
    this._goals.delete(goalId);
    this._executingGoals.delete(goalId);
  }

  _getGoalFilePath(goalId) {
    return path.join(this._persistDir, goalId + JSON_EXT);
  }

  async _cleanupCompletedGoalsWith(removeFn) {
    const ids = this._getCompletedGoalIds();
    for (const goalId of ids) {
      this._removeGoalFromMemory(goalId);
      try {
        await removeFn(goalId);
      } catch (err) {
        debug('GoalExecutor', 'cleanupRemoveError', { goalId, error: err && err.message ? err.message : String(err) });
      }
    }
  }

  async _cleanupCompletedGoals() {
    return this._cleanupCompletedGoalsWith(goalId =>
      safeCallAsync(() => fs.promises.unlink(this._getGoalFilePath(goalId)), 'GoalExecutor', 'cleanupFile'),
    );
  }

  _cleanupCompletedGoalsSync() {
    return this._cleanupCompletedGoalsWith(goalId =>
      safeCall(() => fs.unlinkSync(this._getGoalFilePath(goalId)), 'GoalExecutor', 'cleanupFileSync'),
    );
  }

  /**
   * 检查执行器是否健康。关闭中或并发执行目标数达到上限时返回false。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    if (this._shutDown || this._shuttingDown) return false;
    return this._executingGoals.size < this._config.maxConcurrentGoals;
  }

  _onShutdown() {
    if (this._persistTimer) {
      clearInterval(this._persistTimer);
      this._persistTimer = null;
    }
    this._cancelSignals.forEach(sig => {
      safeCall(() => sig.abort(), 'GoalExecutor', 'shutdownAbort');
    });
    this._cancelSignals.clear();
    this._persistLocks.clear();
    if (this._persistFailCounts) safeCall(() => this._persistFailCounts.shutdown(), 'GoalExecutor', 'shutdown-persistFailCounts');
    if (this._restorePromise) {
      this._restorePromise = null;
    }
    for (const [goalId, goal] of this._goals) {
      if (goal.status === GOAL_STATUS.EXECUTING || goal.status === GOAL_STATUS.ITERATING || goal.status === GOAL_STATUS.DECOMPOSING) {
        goal.status = GOAL_STATUS.PAUSED;
        goal.pausedAt = Date.now();
        goal.updatedAt = Date.now();
        this._persistGoalSync(goalId);
      }
    }
    const completedIds = this._getCompletedGoalIds();
    for (const goalId of completedIds) {
      this._removeGoalFromMemory(goalId);
      safeCall(() => fs.unlinkSync(this._getGoalFilePath(goalId)), 'GoalExecutor', 'cleanupFileSync');
    }
    this._executingGoals.clear();
    this._goals.clear();
    this.removeAllListeners();
  }

};

GoalExecutor.GOAL_STATUS = GOAL_STATUS;
GoalExecutor.SUBTASK_STATUS = SUBTASK_STATUS;
GoalExecutor.DEFAULT_CONFIG = DEFAULT_CONFIG;
GoalExecutor.ATTACH_DEFS = ATTACH_DEFS;

Object.defineProperty(GoalExecutor.prototype, 'ready', {
  get() { return this._restorePromise || Promise.resolve(); },
  configurable: true,
});

/**
 * Attach a SessionManager instance.
 * @param {Object} dep - SessionManager instance (must implement create method)
 * @returns {GoalExecutor} this (supports chaining)
 */
GoalExecutor.prototype.attachSessionManager = function(dep) {
  if (dep && typeof dep.create === 'function') this._sessionManager = dep;
  return this;
};

/**
 * Attach a PlanPersistence instance.
 * @param {Object} dep - PlanPersistence instance (must implement createPlan method)
 * @returns {GoalExecutor} this (supports chaining)
 */
GoalExecutor.prototype.attachPlanPersistence = function(dep) {
  if (dep && typeof dep.createPlan === 'function') this._planPersistence = dep;
  return this;
};

/**
 * Attach a DeepeningOrchestrator instance.
 * @param {Object} dep - DeepeningOrchestrator instance (must implement execute method)
 * @returns {GoalExecutor} this (supports chaining)
 */
GoalExecutor.prototype.attachDeepeningOrchestrator = function(dep) {
  if (dep && typeof dep.execute === 'function') this._deepeningOrchestrator = dep;
  return this;
};

/**
 * Attach a SubagentExecutor instance.
 * @param {Object} dep - SubagentExecutor instance (must implement spawn method)
 * @returns {GoalExecutor} this (supports chaining)
 */
GoalExecutor.prototype.attachSubagentExecutor = function(dep) {
  if (dep && typeof dep.spawn === 'function') this._subagentExecutor = dep;
  return this;
};

/**
 * Attach a ThoughtRetrieverCycle instance.
 * @param {Object} dep - ThoughtRetrieverCycle instance (must implement execute method)
 * @returns {GoalExecutor} this (supports chaining)
 */
GoalExecutor.prototype.attachThoughtRetrieverCycle = function(dep) {
  if (dep && typeof dep.execute === 'function') this._thoughtRetrieverCycle = dep;
  return this;
};

/**
 * Attach a CausalDataBus instance.
 * @param {Object} dep - CausalDataBus instance (must implement publishOutput method)
 * @returns {GoalExecutor} this (supports chaining)
 */
GoalExecutor.prototype.attachCausalDataBus = function(dep) {
  if (dep && typeof dep.publishOutput === 'function') this._causalDataBus = dep;
  return this;
};

/**
 * 挂载OODA决策闭环实例，用于目标执行过程中的态势感知和自适应决策
 * @param {Object} dep - OODA Loop实例，需提供execute方法
 * @returns {GoalExecutor} 当前实例，支持链式调用
 */
GoalExecutor.prototype.attachOodaLoop = function(dep) {
  if (dep && typeof dep.execute === 'function') {
    this._oodaLoop = dep;
    if (dep._level !== 'operational') {
      dep._level = 'operational';
    }
  }
  return this;
};

module.exports = withShutdown(GoalExecutor);

const _mixinShutdown = GoalExecutor.prototype.shutdown;
/**
 * 覆盖withShutdown混入的shutdown方法，添加循环Promise排空和执行中目标等待逻辑。
 * @param {string} [signal] - 关闭信号
 */
GoalExecutor.prototype.shutdown = function shutdown(signal) {
  this._shuttingDown = true;
  const loopDrain = this._loopPromises.size > 0
    ? Promise.allSettled(Array.from(this._loopPromises.values()))
    : Promise.resolve();
  return loopDrain
    .then(() => {
      if (this._executingGoals.size > 0) {
        const deadline = Date.now() + SHUTDOWN_WAIT_TIMEOUT_MS;
        return new Promise((resolve) => {
          const check = () => {
            if (this._executingGoals.size === 0 || Date.now() >= deadline) {
              resolve();
            } else {
              const t = setTimeout(check, SHUTDOWN_POLL_INTERVAL_MS);
              if (t && typeof t.unref === 'function') t.unref();
            }
          };
          check();
        });
      }
    })
    .then(() => {
      this._loopPromises.clear();
      _mixinShutdown.call(this, signal);
    })
    .catch((err) => {
      debug('GoalExecutor', 'shutdownError', err && err.message ? err.message : String(err));
      this._loopPromises.clear();
      _mixinShutdown.call(this, signal);
    });
};
