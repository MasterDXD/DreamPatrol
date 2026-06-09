'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');

const LOOP_STATES = {
  IDLE: 'idle',
  RUNNING: 'running',
  ANALYZING: 'analyzing',
  FIXING: 'fixing',
  VERIFYING: 'verifying',
  REGRESSION: 'regression',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PACKAGING: 'packaging',
};
const _MAX_HISTORY_ENTRIES = 200;

/**
 * @module runtime/agent/agent-debug-loop
 * @classdesc Agent自调试闭环（AgentDebugLoop）。自主运行测试→分析失败→修复代码→回归测试→技能封装，
 * 集成DeepeningOrchestrator进行复杂根因分析，强制超时保护，追踪完整迭代历史。
 * 融合OpenSpace自进化机制：调试成功后自动将修复经验封装为标准化技能模块，存入技能库（错题本），
 * 实现"越用越省、越用越聪明"的自进化闭环。
 * @extends EventEmitter
 * @emits loop:start | loop:complete | loop:failed | iteration:start | iteration:end | deepening:applied | fix:packaged | fix:packaging-failed
 */
class AgentDebugLoop extends EventEmitter {
  /**
   * Create an AgentDebugLoop instance.
   * @param {Object} [options] - Loop configuration options
   * @param {number} [options.maxIterations=5] - Maximum debug iterations
   * @param {number} [options.timeoutMs=300000] - Total loop timeout in milliseconds
   * @param {Function} [options.testRunner] - Test runner function
   * @param {Function} [options.codeFixer] - Code fixer function
   * @param {Function} [options.analyzer] - Failure analyzer function
   * @param {Function} [options.regressionRunner] - Regression test runner function
   * @param {Object} [options.deepeningOrchestrator] - DeepeningOrchestrator instance
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._maxIterations = opts.maxIterations ?? 5;
    this._timeoutMs = opts.timeoutMs ?? 300000;
    this._testRunner = opts.testRunner ?? null;
    this._codeFixer = opts.codeFixer ?? null;
    this._analyzer = opts.analyzer ?? null;
    this._regressionRunner = opts.regressionRunner ?? null;
    this._deepeningOrchestrator = opts.deepeningOrchestrator ?? null;
    this._skillCreationEngine = opts.skillCreationEngine ?? null;
    this._skillMemoryStore = opts.skillMemoryStore ?? null;
    this._autoPackageFix = opts.autoPackageFix ?? true;
    this._state = LOOP_STATES.IDLE;
    this._iteration = 0;
    this._history = [];
    this._startTime = null;
    this._packagedFixes = 0;
  }

  /**
   * Attach a DeepeningOrchestrator for complex root-cause analysis on persistent failures.
   * @param {Object} orchestrator - DeepeningOrchestrator instance (must implement deepen method)
   * @returns {AgentDebugLoop} this (supports chaining)
   */
  attachDeepeningOrchestrator(orchestrator) {
    if (orchestrator && typeof orchestrator.deepen === 'function') {
      this._deepeningOrchestrator = orchestrator;
    }
    return this;
  }

  /**
   * 挂载技能创建引擎，用于将修复经验封装为标准化技能模块。
   * 融合OpenSpace自进化机制：调试成功后自动创建技能，存入技能库（错题本）。
   * @param {Object} engine - SkillCreationEngine实例，需实现createSkill方法
   * @returns {AgentDebugLoop} 当前实例，支持链式调用
   */
  attachSkillCreationEngine(engine) {
    if (engine && typeof engine.createSkill === 'function') {
      this._skillCreationEngine = engine;
    }
    return this;
  }

  /**
   * 挂载技能记忆存储，用于记录避坑经验（avoidance）到错题本。
   * @param {Object} store - SkillMemoryStore实例，需实现storeExperience方法
   * @returns {AgentDebugLoop} 当前实例，支持链式调用
   */
  attachSkillMemoryStore(store) {
    if (store && typeof store.storeExperience === 'function') {
      this._skillMemoryStore = store;
    }
    return this;
  }

  /** 获取当前调试循环状态 @type {string} */
  get state() { return this._state; }
  /** 获取当前迭代次数 @type {number} */
  get iteration() { return this._iteration; }
  /** 获取迭代历史记录的副本 @type {Array<Object>} */
  get history() { return this._history.slice(); }

  /**
   * Execute the debug loop for a given task. Runs test→analyze→fix→verify→regression cycle
   * until tests pass or max iterations or timeout is reached.
   * @param {Object} task - Task description object
   * @returns {Promise<Object>} Result with success, iterations, reason/history/testResult
   */
  async execute(task) {
    this.guardShutdown();
    if (this._resetting) {
      return { success: false, iterations: 0, reason: 'debug_loop_resetting', history: [] };
    }
    if (this._state !== LOOP_STATES.IDLE) {
      return { success: false, iterations: 0, reason: 'debug_loop_already_running', history: [] };
    }

    this._state = LOOP_STATES.RUNNING;
    this._startTime = Date.now();
    this._history = [];
    this._iteration = 0;
    this._aborted = false;

    this.emit('loop:start', { task, timestamp: this._startTime });

    let timeoutId;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve({ timedOut: true }), this._timeoutMs);
      if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
    });
    this._currentTimeoutId = timeoutId;

    const runPromise = this._runLoop(task);

    let result;
    try {
      result = await Promise.race([runPromise, timeoutPromise]);
    } catch (err) {
      clearTimeout(timeoutId);
      this._state = LOOP_STATES.FAILED;
      this.emit('loop:failed', { iteration: this._iteration, reason: 'unhandled_error', error: err && err.message ? err.message : String(err) });
      return { success: false, iterations: this._iteration, reason: 'unhandled_error', error: err && err.message ? err.message : String(err), history: this._history };
    }
    clearTimeout(timeoutId);
    this._currentTimeoutId = null;

    if (result && result.timedOut) {
      this._aborted = true;
      this._state = LOOP_STATES.FAILED;
      this.emit('loop:failed', { iteration: this._iteration, reason: 'timeout_exceeded', timeoutMs: this._timeoutMs });
      return { success: false, iterations: this._iteration, reason: 'timeout_exceeded', history: this._history };
    }

    return result;
  }

  /** 检查是否被中止或重置，若是则恢复IDLE状态并返回中止结果 */
  _checkAborted(phase) {
    if (this._aborted || this._resetting) {
      this._state = LOOP_STATES.IDLE;
      return { aborted: true, result: { success: false, error: 'Loop aborted during ' + phase } };
    }
    return { aborted: false };
  }

  /** 尝试深化分析，若条件满足则调用deepeningOrchestrator */
  async _tryDeepenAnalysis(analysis, task, testResult) {
    if (!this._deepeningOrchestrator || this._iteration < 2 || analysis.rootCause !== 'unknown') {
      return analysis;
    }
    try {
      const deepened = await this._deepeningOrchestrator.deepen({
        task, testResult, previousAnalysis: analysis, iteration: this._iteration,
      });
      if (deepened && deepened.analysis) {
        this.emit('deepening:applied', { iteration: this._iteration });
        return deepened.analysis;
      }
    } catch (deepenErr) {
      this.emit('deepening:failed', { iteration: this._iteration, error: deepenErr && deepenErr.message ? deepenErr.message : String(deepenErr) });
    }
    return analysis;
  }

  /** 运行回归测试，返回结果或null（无regressionRunner时） */
  async _tryRunRegression(task) {
    if (!this._regressionRunner) return null;
    this._state = LOOP_STATES.REGRESSION;
    const regressionResult = await this._runRegression(task);
    this._history.push({ iteration: this._iteration, phase: 'regression', result: regressionResult });
    return regressionResult;
  }

  async _runLoop(task) {
    while (this._iteration < this._maxIterations) {
      if (this._aborted) break;
      this._iteration++;
      this.emit('iteration:start', { iteration: this._iteration, task });

      const testResult = await this._runTests(task);
      const testAbort = this._checkAborted('test phase');
      if (testAbort.aborted) return testAbort.result;
      this._history.push({ iteration: this._iteration, phase: 'test', result: testResult });

      if (testResult.passed) {
        this._state = LOOP_STATES.COMPLETED;
        this.emit('loop:complete', { iteration: this._iteration, testResult });
        return { success: true, iterations: this._iteration, testResult, history: this._history, packagedFixes: this._packagedFixes };
      }

      this._state = LOOP_STATES.ANALYZING;
      let analysis = await this._analyzeFailure(testResult, task);
      const analysisAbort = this._checkAborted('analysis phase');
      if (analysisAbort.aborted) return analysisAbort.result;

      analysis = await this._tryDeepenAnalysis(analysis, task, testResult);

      this._history.push({ iteration: this._iteration, phase: 'analysis', result: analysis });

      this._state = LOOP_STATES.FIXING;
      const fixResult = await this._applyFix(analysis, task);
      const fixAbort = this._checkAborted('fix phase');
      if (fixAbort.aborted) return fixAbort.result;
      this._history.push({ iteration: this._iteration, phase: 'fix', result: fixResult });

      if (!fixResult.applied) {
        this._state = LOOP_STATES.FAILED;
        this.emit('loop:failed', { iteration: this._iteration, reason: 'fix_not_applied' });
        return { success: false, iterations: this._iteration, reason: 'fix_not_applied', history: this._history };
      }

      this._state = LOOP_STATES.VERIFYING;
      this.emit('iteration:end', { iteration: this._iteration, fixResult });

      const regressionResult = await this._tryRunRegression(task);
      if (regressionResult && !regressionResult.passed) {
        this._state = LOOP_STATES.FAILED;
        this.emit('loop:failed', { iteration: this._iteration, reason: 'regression_failed', regressionFailures: regressionResult.failures });
        return { success: false, iterations: this._iteration, reason: 'regression_failed', regressionFailures: regressionResult.failures, history: this._history };
      }

      // 融合OpenSpace自进化机制：修复成功后自动封装为技能模块（错题本）
      if (this._autoPackageFix && (this._skillCreationEngine || this._skillMemoryStore)) {
        await this._packageFixAsSkill(analysis, fixResult, task);
      }

      if (this._history.length > _MAX_HISTORY_ENTRIES) {
        this._history.splice(0, this._history.length - _MAX_HISTORY_ENTRIES);
      }
    }

    this._state = LOOP_STATES.FAILED;
    this.emit('loop:failed', { iteration: this._iteration, reason: 'max_iterations_reached' });
    return { success: false, iterations: this._iteration, reason: 'max_iterations_reached', history: this._history };
  }

  async _runTests(task) {
    if (this._testRunner) {
      try {
        return await this._testRunner(task);
      } catch (err) {
        return { passed: false, error: err && err.message ? err.message : String(err), type: 'runner_error' };
      }
    }
    return { passed: true, type: 'no_runner' };
  }

  async _analyzeFailure(testResult, task) {
    if (this._analyzer) {
      try {
        return await this._analyzer(testResult, task);
      } catch (err) {
        return { rootCause: 'unknown', error: err && err.message ? err.message : String(err), suggestions: [] };
      }
    }
    return { rootCause: testResult.error ?? 'unknown', suggestions: [] };
  }

  async _applyFix(analysis, task) {
    if (this._codeFixer) {
      try {
        return await this._codeFixer(analysis, task);
      } catch (err) {
        return { applied: false, error: err && err.message ? err.message : String(err) };
      }
    }
    return { applied: false, reason: 'no_fixer' };
  }

  async _runRegression(task) {
    if (this._regressionRunner) {
      try {
        return await this._regressionRunner(task);
      } catch (err) {
        return { passed: false, error: err && err.message ? err.message : String(err), type: 'regression_error' };
      }
    }
    return { passed: true, type: 'no_regression_runner' };
  }

  /**
   * 将修复经验封装为标准化技能模块，存入技能库（错题本）。
   * 融合OpenSpace自进化机制：错误→修复→技能封装→Token节省闭环。
   * @param {Object} analysis - 失败分析结果
   * @param {Object} fixResult - 修复结果
   * @param {Object} task - 原始任务描述
   * @returns {Promise<void>}
   * @fires AgentDebugLoop#fix:packaged
   * @fires AgentDebugLoop#fix:packaging-failed
   */
  async _packageFixAsSkill(analysis, fixResult, task) {
    this._state = LOOP_STATES.PACKAGING;
    try {
      const errorPattern = analysis.rootCause || 'unknown';
      const fixDescription = fixResult.description || fixResult.fix || '';
      const taskType = task.type || task.name || 'general';

      // 1. 记录避坑经验到技能记忆存储（错题本）
      if (this._skillMemoryStore) {
        const avoidanceResult = this._skillMemoryStore.storeExperience(
          'debug-loop-' + taskType,
          {
            type: 'avoidance',
            content: 'Error: ' + errorPattern + ' | Fix: ' + fixDescription,
            confidence: 0.8,
            context: { taskType: taskType, iteration: this._iteration, rootCause: errorPattern },
          },
        );
        debug('AgentDebugLoop', '_packageFixAsSkill:avoidance', avoidanceResult.id ? 'stored' : 'failed');
      }

      // 2. 封装为标准化技能模块（如果修复经验足够成熟）
      if (this._skillCreationEngine && fixDescription) {
        const skillDefinition = {
          name: 'auto-fix-' + taskType + '-' + Date.now(),
          description: 'Auto-generated skill from debug loop: ' + errorPattern + ' → ' + fixDescription,
          category: 'auto-fix',
          trigger: { errorPattern: errorPattern, taskType: taskType },
          steps: [
            { action: 'detect', description: 'Detect error: ' + errorPattern },
            { action: 'analyze', description: 'Root cause: ' + errorPattern },
            { action: 'fix', description: 'Apply fix: ' + fixDescription },
          ],
          metadata: {
            source: 'agent-debug-loop',
            iteration: this._iteration,
            createdAt: new Date().toISOString(),
            autoGenerated: true,
          },
        };
        const created = await this._skillCreationEngine.createSkill(skillDefinition);
        if (created) {
          this._packagedFixes++;
          this.emit('fix:packaged', {
            skillName: skillDefinition.name,
            errorPattern: errorPattern,
            iteration: this._iteration,
          });
          debug('AgentDebugLoop', '_packageFixAsSkill:skill', skillDefinition.name);
        }
      }
    } catch (err) {
      this.emit('fix:packaging-failed', {
        iteration: this._iteration,
        error: err && err.message ? err.message : String(err),
      });
      debug('AgentDebugLoop', '_packageFixAsSkill:error', err && err.message ? err.message : String(err));
    }
  }

  /**
   * Reset the debug loop to idle state, clearing iteration history.
   * @returns {void}
   */
  reset() {
    this._aborted = true;
    this._resetting = true;
    if (this._currentTimeoutId) {
      clearTimeout(this._currentTimeoutId);
      this._currentTimeoutId = null;
    }
    this._state = LOOP_STATES.IDLE;
    this._iteration = 0;
    this._history = [];
    this._startTime = null;
    this._resetting = false;
  }

  /**
   * Get debug loop statistics.
   * @returns {Object} Stats with state, iteration, maxIterations, historyLength, elapsedMs, hasRegressionRunner
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('AgentDebugLoop', 'getStats', _e && _e.message ? _e.message : String(_e)); return { state: 'shutdown', iteration: 0, maxIterations: this._maxIterations, historyLength: 0, elapsedMs: 0, hasRegressionRunner: false }; }
    return {
      state: this._state,
      iteration: this._iteration,
      maxIterations: this._maxIterations,
      historyLength: this._history.length,
      elapsedMs: this._startTime ? Date.now() - this._startTime : 0,
      hasRegressionRunner: this._regressionRunner !== null,
      hasSkillPackaging: this._skillCreationEngine !== null || this._skillMemoryStore !== null,
      packagedFixes: this._packagedFixes,
    };
  }

  _onShutdown() {
    this._aborted = true;
    if (this._currentTimeoutId) {
      clearTimeout(this._currentTimeoutId);
      this._currentTimeoutId = null;
    }
    this._history = [];
    this._deepeningOrchestrator = null;
    this._skillCreationEngine = null;
    this._skillMemoryStore = null;
    this._testRunner = null;
    this._codeFixer = null;
    this._analyzer = null;
    this._regressionRunner = null;
    this._state = LOOP_STATES.IDLE;
    this._iteration = 0;
    this._startTime = null;
    this._packagedFixes = 0;
    this.removeAllListeners();
  }
}

module.exports = { AgentDebugLoop: withShutdown(AgentDebugLoop), LOOP_STATES };
