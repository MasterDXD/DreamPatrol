'use strict';

/**
 * @module runtime/workflow/optimization-loop
 * @classdesc 优化循环求解器（OptimizationLoop）—— 无限循环迭代优化引擎。
 * 支持可量化指标追踪、收敛检测、策略自动切换（improving/plateau/degrading）、
 * 快照回滚、资源预算控制、MD优化日志。内置6种度量类型（loss/roi/precision/recall/f1/custom），
 * 集成ConvergenceDetector实现自动收敛判定和停滞检测。
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { HARNESS_DIR } = require('../../utils/constants');
const { mergeConfig } = require('../../utils/safe-assign');
const { ensureDirSync } = require('../../utils/fs-utils');
const { debug } = require('../../utils/debug-logger');
const { safeCall, errorMessage, roundTo, clamp01 } = require('../../utils/safe-execute');
const deepClone = require('../../utils/deep-clone');
const { withShutdown } = require('../../utils/shutdown-mixin');
const ConvergenceDetector = require('../deepening/convergence-detector');

const LOOP_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  CONVERGED: 'converged',
  EXHAUSTED: 'exhausted',
  FAILED: 'failed',
};

const METRIC_DIRECTIONS = new Set(['minimize', 'maximize']);

const MAX_JOURNAL_CONTENT_LENGTH = 500000;

const BUILTIN_METRIC_TYPES = new Set(['loss', 'roi', 'precision', 'recall', 'f1', 'custom']);

const DEFAULT_METRIC_DIRECTION = {
  loss: 'minimize',
  roi: 'maximize',
  precision: 'maximize',
  recall: 'maximize',
  f1: 'maximize',
  custom: 'maximize',
};

const DEFAULT_CONFIG = {
  maxIterations: Infinity,
  convergenceThreshold: 0.85,
  iterationIntervalMs: 0,
  metricsTypes: [],
  journalPath: '',
  gitTracking: false,
  stagnationWindow: 5,
  resourceBudget: null,
  shepherdInterval: 10,
  perturbationEnabled: false,
  perturbationStrength: 0.1,
  humanApprovalGate: null,
};

const MAX_SNAPSHOTS = 100;
const MAX_METRICS_HISTORY = 200;
const MAX_JOURNAL_ENTRY_LENGTH = 5000;
const STRATEGY_PLATEAU_THRESHOLD = 3;
const DEGRADATION_THRESHOLD = 0.05;
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_ROLLBACKS = 3;

class OptimizationLoop extends EventEmitter {
  /**
   * 创建OptimizationLoop实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxIterations=Infinity] - 最大迭代次数
   * @param {number} [options.convergenceThreshold=0.85] - 收敛阈值（0-1）
   * @param {number} [options.iterationIntervalMs=0] - 迭代间隔（毫秒）
   * @param {string} [options.journalPath] - 优化日志文件路径
   * @param {number} [options.stagnationWindow=5] - 停滞检测窗口大小
   * @param {number} [options.resourceBudget] - 资源预算上限
   */
  constructor(options) {
    super();
    // 防止无监听器时 error 事件导致进程崩溃
    this.on('error', function(_err) {
      // 仅记录，不传播 — 外部可通过 on('error') 覆盖此行为
    });
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._status = LOOP_STATUS.IDLE;
    this._objective = null;
    this._constraints = [];
    this._metricsDefs = new Map();
    this._currentIteration = 0;
    this._bestResult = null;
    this._bestScore = -Infinity;
    this._bestIteration = -1;
    this._lastScore = null;
    this._metricsHistory = [];
    this._snapshots = new Map();
    this._strategyTrend = [];
    this._stagnationCounter = 0;
    this._plateauCounter = 0;
    this._resourceUsed = 0;
    this._loopPromise = null;
    this._nextIterationTimer = null;
    this._executeFn = null;
    this._loopOptions = null;
    this._convergenceDetector = new ConvergenceDetector({
      qualityThreshold: this._config.convergenceThreshold,
      maxIterations: Number.isFinite(this._config.maxIterations) ? this._config.maxIterations : 1000,
      stabilityWindow: this._config.stagnationWindow,
    });
    this._metricsCollector = null;
    this._journalPath = this._config.journalPath ?? path.join(process.cwd(), HARNESS_DIR, 'optimization-journal.md');
    this._journalInitialized = false;
    this._startedAt = null;
    this._stoppedAt = null;
    this._pendingDelayResolve = null;
    this._consecutiveFailures = 0;
    this._rollbackCount = 0;
    this._humanApprovalGate = null;
    this._shepherdCounter = 0;
    this._journalContent = '';
    this._journalBuffer = [];
    /** 最大日志缓冲条目数，超出时自动裁剪 */
    this._maxJournalBuffer = 500;
  }

  /**
   * 注入外部度量采集器。
   * @param {Object} collector - 度量采集器实例，需实现record()方法
   * @returns {OptimizationLoop} this（支持链式调用）
   */
  attachMetricsCollector(collector) {
    this.guardShutdown();
    if (collector && typeof collector.record === 'function') {
      this._metricsCollector = collector;
    }
    return this;
  }

  /**
   * 注入自定义收敛检测器。
   * @param {Object} detector - 收敛检测器实例，需实现check()方法
   * @returns {OptimizationLoop} this（支持链式调用）
   */
  attachConvergenceDetector(detector) {
    this.guardShutdown();
    if (detector && typeof detector.check === 'function') {
      this._convergenceDetector = detector;
    }
    return this;
  }

  /**
   * 定义优化目标和约束条件。必须在start()之前调用。
   * @param {string} objective - 优化目标描述
   * @param {Array<Object>} [constraints] - 约束条件数组
   * @param {Array<{name: string, direction?: string, type?: string, target?: number, weight?: number}>} [metrics] - 度量定义数组
   * @param {Object} [options] - 目标选项（convergenceThreshold/stagnationWindow/resourceBudget）
   * @returns {{success: boolean, objective?: string, metricCount?: number, error?: string}} 定义结果
   */
  defineObjective(objective, constraints, metrics, options) {
    this.guardShutdown();
    if (this._status === LOOP_STATUS.RUNNING) {
      return { success: false, error: 'Cannot redefine objective while loop is running' };
    }
    if (!objective || typeof objective !== 'string' || objective.trim().length === 0) {
      return { success: false, error: 'Objective must be a non-empty string' };
    }
    this._objective = objective.trim();
    this._constraints = Array.isArray(constraints) ? constraints.slice() : [];
    this._metricsDefs.clear();
    this._registerMetrics(metrics);
    this._applyObjectiveOptions(options);
    this._resetState();
    return { success: true, objective: this._objective, metricCount: this._metricsDefs.size };
  }

  _registerMetrics(metrics) {
    if (!Array.isArray(metrics)) return;
    for (const m of metrics) {
      if (!m || typeof m.name !== 'string' || m.name.trim().length === 0) continue;
      const direction = METRIC_DIRECTIONS.has(m.direction) ? m.direction : (DEFAULT_METRIC_DIRECTION[m.type] || 'maximize');
      this._metricsDefs.set(m.name, {
        name: m.name,
        type: m.type ?? 'custom',
        direction,
        value: null,
        target: Number.isFinite(m.target) ? m.target : (direction === 'maximize' ? 1 : 0),
        weight: typeof m.weight === 'number' && m.weight > 0 ? m.weight : 1,
      });
    }
  }

  _applyObjectiveOptions(options) {
    if (!options || typeof options !== 'object') return;
    if (typeof options.convergenceThreshold === 'number') {
      this._config.convergenceThreshold = clamp01(options.convergenceThreshold);
    }
    if (typeof options.stagnationWindow === 'number' && options.stagnationWindow > 0) {
      this._config.stagnationWindow = options.stagnationWindow;
    }
    if (typeof options.resourceBudget === 'number' && options.resourceBudget > 0) {
      this._config.resourceBudget = options.resourceBudget;
    }
  }

  /**
   * 启动优化循环。循环将持续执行直到收敛、耗尽迭代次数或手动停止。
   * @param {Function} executeFn - 迭代执行函数，签名：(iteration, context) => Object
   * @param {Object} [options] - 运行选项
   * @returns {Promise<{success: boolean, status?: string, error?: string}>} 启动结果
   */
  async start(executeFn, options) {
    this.guardShutdown();
    if (!this._objective) {
      return { success: false, error: 'Objective not defined. Call defineObjective() first.' };
    }
    if (this._status === LOOP_STATUS.RUNNING) {
      return { success: false, error: 'Loop is already running' };
    }
    if (!executeFn || typeof executeFn !== 'function') {
      return { success: false, error: 'executeFn must be a function' };
    }
    this._executeFn = executeFn;
    this._loopOptions = options ?? {};
    this._status = LOOP_STATUS.RUNNING;
    this._startedAt = this._startedAt ?? Date.now();
    this._stoppedAt = null;
    this._loopPromise = this._runLoop().catch(err => {
      debug('OptimizationLoop', 'runLoop-error', err?.message || err);
      if (this._status === LOOP_STATUS.RUNNING) {
        this._status = LOOP_STATUS.STOPPED;
        try { this.emit('error', { error: err, iteration: this._currentIteration }); } catch (_emitErr) { this.emit('safe-error', { error: err, iteration: this._currentIteration }); }
      }
    });
    return { success: true, status: this._status };
  }

  /**
   * 暂停优化循环。可通过resume()恢复。
   * @returns {{success: boolean, status?: string, iteration?: number, error?: string}} 暂停结果
   */
  pause() {
    this.guardShutdown();
    if (this._status !== LOOP_STATUS.RUNNING) {
      return { success: false, error: 'Loop is not running' };
    }
    this._status = LOOP_STATUS.PAUSED;
    if (this._nextIterationTimer) {
      clearTimeout(this._nextIterationTimer);
      this._nextIterationTimer = null;
    }
    if (this._pendingDelayResolve) {
      this._pendingDelayResolve('paused');
      this._pendingDelayResolve = null;
    }
    this.emit('paused', { iteration: this._currentIteration, bestScore: this._bestScore });
    debug('OptimizationLoop', 'paused', { iteration: this._currentIteration });
    return { success: true, status: this._status, iteration: this._currentIteration };
  }

  /**
   * 恢复已暂停的优化循环。
   * @returns {{success: boolean, status?: string, error?: string}} 恢复结果
   */
  resume() {
    this.guardShutdown();
    if (this._status !== LOOP_STATUS.PAUSED) {
      return { success: false, error: 'Loop is not paused' };
    }
    this._status = LOOP_STATUS.RUNNING;
    this.emit('resumed', { iteration: this._currentIteration });
    debug('OptimizationLoop', 'resumed', { iteration: this._currentIteration });
    if (this._config.iterationIntervalMs === 0) {
      this._loopPromise = this._runLoop().catch(err => {
        debug('OptimizationLoop', 'runLoop-resume-error', err?.message || err);
        if (this._status === LOOP_STATUS.RUNNING) {
          this._status = LOOP_STATUS.STOPPED;
          try { this.emit('error', { error: err, iteration: this._currentIteration }); } catch (_emitErr) { this.emit('safe-error', { error: err, iteration: this._currentIteration }); }
        }
      });
    } else {
      this._scheduleNextIteration();
    }
    return { success: true, status: this._status };
  }

  /**
   * 停止优化循环并刷写日志。
   * @returns {{success: boolean, status?: string, iteration?: number, bestScore?: number, error?: string}} 停止结果
   */
  stop() {
    this.guardShutdown();
    if (this._status !== LOOP_STATUS.RUNNING && this._status !== LOOP_STATUS.PAUSED) {
      return { success: false, error: 'Loop is not running or paused' };
    }
    this._status = LOOP_STATUS.STOPPED;
    this._stoppedAt = Date.now();
    if (this._nextIterationTimer) {
      clearTimeout(this._nextIterationTimer);
      this._nextIterationTimer = null;
    }
    if (this._pendingDelayResolve) {
      this._pendingDelayResolve('stopped');
      this._pendingDelayResolve = null;
    }
    this._flushJournalSync();
    this.emit('stopped', { iteration: this._currentIteration, bestScore: this._bestScore });
    debug('OptimizationLoop', 'stopped', { iteration: this._currentIteration, bestScore: this._bestScore });
    return { success: true, status: this._status, iteration: this._currentIteration, bestScore: this._bestScore };
  }

  /**
   * 获取当前优化进度。
   * @returns {{status: string, currentIteration: number, bestScore: number|null, bestIteration: number|null, lastScore: number|null, convergenceStatus: Object, metricsHistory: Array, stagnationCounter: number, resourceUsed: number, resourceBudget: number|null, elapsed: number, objective: string|null}} 进度信息
   */
  getProgress() {
    this.guardShutdown();
    const convergenceStatus = this._getConvergenceStatus();
    return {
      status: this._status,
      currentIteration: this._currentIteration,
      bestScore: this._bestScore === -Infinity ? null : this._bestScore,
      bestIteration: this._bestIteration === -1 ? null : this._bestIteration,
      lastScore: this._lastScore,
      convergenceStatus,
      metricsHistory: this._metricsHistory.slice(-10),
      stagnationCounter: this._stagnationCounter,
      resourceUsed: this._resourceUsed,
      resourceBudget: this._config.resourceBudget,
      elapsed: this._startedAt ? (this._stoppedAt ?? Date.now()) - this._startedAt : 0,
      objective: this._objective,
    };
  }

  /**
   * 回滚到指定迭代的快照状态。
   * @param {number} iteration - 目标迭代编号
   * @returns {{success: boolean, iteration?: number, context?: Object, metrics?: Object, error?: string}} 回滚结果
   */
  rollbackTo(iteration) {
    this.guardShutdown();
    if (typeof iteration !== 'number' || iteration < 0) {
      return { success: false, error: 'Iteration must be a non-negative number' };
    }
    const snapshot = this._snapshots.get(iteration);
    if (!snapshot) {
      return { success: false, error: 'No snapshot found for iteration ' + iteration };
    }
    this._currentIteration = snapshot.iteration;
    this._lastScore = snapshot.metrics.compositeScore;
    this._bestScore = snapshot.metrics.compositeScore;
    this._bestIteration = snapshot.iteration;
    this._strategyTrend = [];
    this._metricsHistory = this._metricsHistory.filter(h => h.iteration <= iteration);
    this._stagnationCounter = 0;
    this._plateauCounter = 0;
    debug('OptimizationLoop', 'rollbackTo', { iteration, score: snapshot.metrics.compositeScore });
    return { success: true, iteration, context: deepClone(snapshot.context), metrics: deepClone(snapshot.metrics) };
  }

  /**
   * 获取优化日志内容。
   * @returns {string} 日志Markdown内容
   */
  getJournal() {
    if (this._journalContent) return this._journalContent;
    try {
      if (!fs.existsSync(this._journalPath)) return '';
      return fs.readFileSync(this._journalPath, 'utf-8');
    } catch (err) {
      debug('OptimizationLoop', 'getJournal', errorMessage(err));
      return '';
    }
  }

  /**
   * 从优化日志恢复循环状态（重启恢复）。
   * 解析journal MD文件，提取最佳分数、最佳迭代、总迭代数等状态。
   * @param {string} [journalPath] - 日志文件路径（默认使用配置路径）
   * @returns {{success: boolean, restored?: {bestScore: number|null, bestIteration: number|null, totalIterations: number, convergenceStatus: string}, error?: string}} 恢复结果
   */
  _parseJournalField(content, pattern, parser) {
    const match = content.match(pattern);
    if (!match) return { value: null, raw: null };
    const raw = match[1].trim();
    if (raw === 'N/A') return { value: null, raw };
    const parsed = parser(raw);
    return { value: parsed, raw };
  }

  _restoreStateFromParsed(bestScore, bestIteration, totalIterations, _convergenceStatus) {
    if (bestScore !== null && Number.isFinite(bestScore)) {
      this._bestScore = bestScore;
    }
    if (bestIteration !== null && Number.isFinite(bestIteration)) {
      this._bestIteration = bestIteration;
    }
    this._currentIteration = totalIterations;
  }

  restoreFromJournal(journalPath) {
    this.guardShutdown();
    if (this._status === LOOP_STATUS.RUNNING) {
      return { success: false, error: 'Cannot restore while loop is running' };
    }
    const filePath = journalPath ?? this._journalPath;
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Journal file not found: ' + filePath };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content || content.length === 0) {
        return { success: false, error: 'Journal file is empty' };
      }
      const bestScoreResult = this._parseJournalField(content, /\| Best Score \| ([^|]+) \|/, v => parseFloat(v));
      if (bestScoreResult.value !== null && !isFinite(bestScoreResult.value)) { debug('OptimizationLoop', 'parseBestScore', 'NaN fallback'); return { success: false, error: 'Invalid best score in journal' }; }
      const bestIterResult = this._parseJournalField(content, /\| Best Iteration \| ([^|]+) \|/, v => parseInt(v, 10));
      if (bestIterResult.value !== null && !isFinite(bestIterResult.value)) { debug('OptimizationLoop', 'parseBestIteration', 'NaN fallback'); return { success: false, error: 'Invalid best iteration in journal' }; }
      const totalIterResult = this._parseJournalField(content, /\| Total Iterations \| (\d+) \|/, v => parseInt(v, 10));
      if (totalIterResult.value !== null && !isFinite(totalIterResult.value)) { debug('OptimizationLoop', 'parseTotalIterations', 'NaN fallback'); return { success: false, error: 'Invalid total iterations in journal' }; }
      const convergenceResult = this._parseJournalField(content, /\| Convergence Status \| ([^|]+) \|/, v => v);
      const bestScore = bestScoreResult.value;
      const bestIteration = bestIterResult.value;
      const totalIterations = totalIterResult.value ?? 0;
      const convergenceStatus = convergenceResult.value ?? 'unknown';
      const objectiveMatch = content.match(/## Objective\s*\n\s*\n(.+)/);
      if (objectiveMatch && !this._objective) {
        this._objective = objectiveMatch[1].trim();
      }
      this._restoreStateFromParsed(bestScore, bestIteration, totalIterations, convergenceStatus);
      this._journalContent = content;
      this._journalInitialized = true;
      this.emit('restored-from-journal', { bestScore, bestIteration, totalIterations, convergenceStatus });
      debug('OptimizationLoop', 'restoredFromJournal', { bestScore, bestIteration, totalIterations, convergenceStatus });
      return {
        success: true,
        restored: { bestScore, bestIteration, totalIterations, convergenceStatus },
      };
    } catch (err) {
      debug('OptimizationLoop', 'restoreFromJournal', errorMessage(err));
      return { success: false, error: errorMessage(err) };
    }
  }

  /**
   * 从标准化环境配置文件加载优化环境（.harness/optimization.env.js或.env.json）。
   * 支持API密钥、工具权限、场景定制等配置。
   * @param {string} [envPath] - 环境配置文件路径
   * @returns {{success: boolean, config?: Object, error?: string}} 加载结果
   */
  loadEnvironmentConfig(envPath) {
    this.guardShutdown();
    const defaultPath = path.join(process.cwd(), HARNESS_DIR, 'optimization.env');
    const filePath = envPath ?? defaultPath;
    try {
      // Try .js first, then .json
      let config = null;
      const jsPath = filePath.endsWith('.js') ? filePath : filePath + '.js';
      const jsonPath = filePath.endsWith('.json') ? filePath : filePath + '.json';
      if (fs.existsSync(jsPath)) {
        config = require(jsPath);
      } else if (fs.existsSync(jsonPath)) {
        const content = fs.readFileSync(jsonPath, 'utf-8');
        try { config = JSON.parse(content); } catch (_e) { debug('OptimizationLoop', 'loadConfig', 'Invalid JSON in ' + jsonPath + ': ' + (_e && _e.message ? _e.message : String(_e))); config = {}; }
      } else {
        return { success: false, error: 'Environment config not found: ' + filePath + '(.js/.json)' };
      }
      if (!config || typeof config !== 'object') {
        return { success: false, error: 'Invalid environment config format' };
      }
      // Apply config to loop
      if (config.objective && !this._objective) {
        this._objective = config.objective;
      }
      if (Array.isArray(config.constraints) && !this._constraints.length) {
        this._constraints = config.constraints;
      }
      if (Array.isArray(config.metrics)) {
        this._registerMetrics(config.metrics);
      }
      if (config.options && typeof config.options === 'object') {
        this._applyObjectiveOptions(config.options);
      }
      this.emit('env-config-loaded', { path: filePath, hasObjective: !!config.objective, hasConstraints: !!config.constraints, hasMetrics: !!config.metrics });
      debug('OptimizationLoop', 'envConfigLoaded', { path: filePath });
      return { success: true, config };
    } catch (err) {
      debug('OptimizationLoop', 'loadEnvironmentConfig', errorMessage(err));
      return { success: false, error: errorMessage(err) };
    }
  }

  async _runLoop() {
    while (this._status === LOOP_STATUS.RUNNING) {
      if (this._shutDown) break;
      if (await this._checkMaxIterations()) break;

      this._currentIteration++;
      this.emit('iteration-start', { iteration: this._currentIteration, maxIterations: this._config.maxIterations });
      debug('OptimizationLoop', 'iterationStart', { iteration: this._currentIteration });

      const iterationResult = await this._executeIteration();
      this._updateConsecutiveFailures(iterationResult);

      if (this._status !== LOOP_STATUS.RUNNING) break;
      const { metrics, compositeScore, strategy } = await this._processIterationMetrics(iterationResult);
      if (this._shutDown) break;

      this._emitIterationComplete(compositeScore, metrics, strategy);

      if (await this._handleConvergence(compositeScore, metrics)) break;
      this._emitStagnationIfNeeded();
      this._emitShepherdIfNeeded();
      this._handleStrategyAutoSwitch(strategy);

      if (await this._checkTerminalConditions()) break;

      if (this._config.iterationIntervalMs > 0 && this._status === LOOP_STATUS.RUNNING) {
        const delayResult = await this._scheduleDelay(this._config.iterationIntervalMs);
        if (delayResult === 'paused' || delayResult === 'stopped') break;
      }
    }
  }

  /** @returns {Promise<boolean>} true if loop should break */
  async _checkMaxIterations() {
    const bounded = Number.isFinite(this._config.maxIterations);
    if (bounded && this._currentIteration >= this._config.maxIterations) {
      this._status = LOOP_STATUS.EXHAUSTED;
      this._stoppedAt = Date.now();
      await this._flushJournal();
      if (this._shutDown) return true;
      this.emit('exhausted', { iteration: this._currentIteration, bestScore: this._bestScore });
      debug('OptimizationLoop', 'maxIterationsReached', { iteration: this._currentIteration });
      return true;
    }
    return false;
  }

  _updateConsecutiveFailures(iterationResult) {
    if (iterationResult && iterationResult.success === false && iterationResult.error) {
      this._consecutiveFailures++;
    } else {
      this._consecutiveFailures = 0;
    }
  }

  async _processIterationMetrics(iterationResult) {
    const metrics = this._collectMetrics(iterationResult);
    const constraintViolations = this._checkConstraintViolations(iterationResult);
    if (constraintViolations.length > 0) {
      this.emit('constraint-violation', { iteration: this._currentIteration, violations: constraintViolations });
      debug('OptimizationLoop', 'constraintViolation', { iteration: this._currentIteration, violations: constraintViolations.length });
    }
    const compositeScore = this._computeCompositeScore(metrics);
    this._lastScore = compositeScore;
    this._metricsHistory.push({ iteration: this._currentIteration, compositeScore, metrics: deepClone(metrics), timestamp: Date.now() });
    if (this._metricsHistory.length > MAX_METRICS_HISTORY) {
      this._metricsHistory = this._metricsHistory.slice(-MAX_METRICS_HISTORY);
    }
    if (compositeScore > this._bestScore || this._bestIteration === -1) {
      this._bestScore = compositeScore;
      this._bestResult = deepClone(iterationResult);
      this._bestIteration = this._currentIteration;
      this._stagnationCounter = 0;
    } else {
      this._stagnationCounter++;
    }
    const strategy = this._detectStrategyTrend(compositeScore);
    this._saveSnapshot(this._currentIteration, metrics, strategy, iterationResult);
    this._recordToMetricsCollector(metrics, compositeScore);
    this._appendJournalEntry(this._currentIteration, metrics, strategy, iterationResult);
    await this._flushJournal();
    return { metrics, compositeScore, strategy };
  }

  _emitIterationComplete(compositeScore, metrics, strategy) {
    this.emit('iteration-complete', {
      iteration: this._currentIteration, compositeScore,
      bestScore: this._bestScore, bestIteration: this._bestIteration,
      metrics, strategy,
    });
    debug('OptimizationLoop', 'iterationComplete', {
      iteration: this._currentIteration,
      compositeScore: roundTo(compositeScore, 4),
      bestScore: roundTo(this._bestScore, 4),
    });
  }

  /** @returns {Promise<boolean>} true if loop should break (converged) */
  async _handleConvergence(compositeScore, metrics) {
    const convergenceResult = this._checkConvergence(compositeScore, metrics);
    if (!convergenceResult.converged) return false;

    this._status = LOOP_STATUS.CONVERGED;
    this._stoppedAt = Date.now();
    await this._flushJournal();
    if (this._shutDown) return true;
    this.emit('convergence-detected', { iteration: this._currentIteration, score: compositeScore, bestScore: this._bestScore, reason: convergenceResult.reason });
    debug('OptimizationLoop', 'converged', { iteration: this._currentIteration, score: compositeScore, reason: convergenceResult.reason });

    if (this._humanApprovalGate) {
      try {
        const approval = await this._humanApprovalGate.requestApproval({
          type: 'convergence-checkpoint', iteration: this._currentIteration,
          score: compositeScore, bestScore: this._bestScore, reason: convergenceResult.reason,
        });
        if (!approval.approved) {
          this._status = LOOP_STATUS.RUNNING;
          this._stoppedAt = null;
          debug('OptimizationLoop', 'humanRejectedConvergence', { iteration: this._currentIteration });
          return false;
        }
      } catch (_err) {
        debug('OptimizationLoop', 'humanApprovalError', errorMessage(_err));
      }
    }
    return this._status === LOOP_STATUS.CONVERGED;
  }

  _emitStagnationIfNeeded() {
    if (this._checkStagnation()) {
      this.emit('stagnation-detected', { iteration: this._currentIteration, stagnationCounter: this._stagnationCounter, bestScore: this._bestScore });
      debug('OptimizationLoop', 'stagnationDetected', { iteration: this._currentIteration, stagnationCounter: this._stagnationCounter });
    }
  }

  _emitShepherdIfNeeded() {
    if (this._config.shepherdInterval > 0 && this._currentIteration > 0 && this._currentIteration % this._config.shepherdInterval === 0) {
      this.emit('shepherd-reinject', {
        iteration: this._currentIteration, objective: this._objective,
        constraints: this._constraints.slice(), bestScore: this._bestScore,
        stagnationCounter: this._stagnationCounter,
      });
      debug('OptimizationLoop', 'shepherdReinject', { iteration: this._currentIteration });
    }
  }

  /** @returns {Promise<boolean>} true if loop should break (resource exhausted or failed) */
  async _checkTerminalConditions() {
    if (this._checkResourceBudget()) {
      this._status = LOOP_STATUS.EXHAUSTED;
      this._stoppedAt = Date.now();
      await this._flushJournal();
      if (this._shutDown) return true;
      this.emit('resource-exhausted', { iteration: this._currentIteration, resourceUsed: this._resourceUsed, budget: this._config.resourceBudget });
      debug('OptimizationLoop', 'resourceExhausted', { iteration: this._currentIteration, resourceUsed: this._resourceUsed });
      return true;
    }
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this._status = LOOP_STATUS.FAILED;
      this._stoppedAt = Date.now();
      this._flushJournalSync();
      this.emit('loop-failed', { iteration: this._currentIteration, consecutiveFailures: this._consecutiveFailures });
      debug('OptimizationLoop', 'loopFailed', { iteration: this._currentIteration, consecutiveFailures: this._consecutiveFailures });
      return true;
    }
    return false;
  }

  async _executeIteration() {
    const ctx = this._buildIterationContext();
    if (typeof this._executeFn !== 'function') {
      debug('OptimizationLoop', 'executeIterationError', { iteration: this._currentIteration, error: 'No execute function' });
      return { success: false, error: 'No execute function configured' };
    }
    try {
      const result = await this._executeFn(ctx, {
        iteration: this._currentIteration,
        objective: this._objective,
        constraints: this._constraints,
      });
      if (this._shutDown) return { success: false, error: 'shutdown' };
      if (result && typeof result.resourceUsed === 'number') {
        this._resourceUsed += result.resourceUsed;
      }
      return result;
    } catch (err) {
      debug('OptimizationLoop', 'executeIterationError', { iteration: this._currentIteration, error: errorMessage(err) });
      return { success: false, error: errorMessage(err) };
    }
  }

  _buildIterationContext() {
    const ctx = {
      objective: this._objective,
      constraints: this._constraints,
      iteration: this._currentIteration,
      maxIterations: this._config.maxIterations,
      _previousBestResult: this._bestResult ? deepClone(this._bestResult) : null,
      _previousBestScore: this._bestScore === -Infinity ? null : this._bestScore,
      _metricsHistory: this._metricsHistory.slice(-5),
      _stagnationCounter: this._stagnationCounter,
    };
    if (this._metricsDefs.size > 0) {
      ctx._metricDefs = Array.from(this._metricsDefs.values()).map(m => ({
        name: m.name,
        type: m.type,
        direction: m.direction,
        target: m.target,
        weight: m.weight,
      }));
    }
    // Shepherd loop: periodic goal re-injection to prevent drift
    if (this._config.shepherdInterval > 0 && this._currentIteration > 0 && this._currentIteration % this._config.shepherdInterval === 0) {
      ctx._shepherdReinject = true;
      ctx._originalObjective = this._objective;
      ctx._originalConstraints = this._constraints.slice();
    }
    const perturbation = this._generatePerturbation();
    if (perturbation) {
      ctx._perturbation = perturbation;
    }
    return ctx;
  }

  _checkConstraintViolations(result) {
    if (!this._constraints.length || !result || typeof result !== 'object') return [];
    const violations = [];
    for (const constraint of this._constraints) {
      if (typeof constraint !== 'object' || !constraint.name) continue;
      const value = result.metrics?.[constraint.name] ?? result[constraint.name];
      const v = this._checkSingleConstraint(constraint, result, value);
      if (v) violations.push(v);
    }
    return violations;
  }

  _checkSingleConstraint(constraint, result, value) {
    if (typeof constraint.check === 'function') {
      try {
        if (!constraint.check(result)) return { name: constraint.name, type: 'custom-check' };
      } catch (_err) {
        debug('OptimizationLoop', '_checkSingleConstraint', 'Custom constraint check error for ' + constraint.name + ': ' + (_err && _err.message ? _err.message : String(_err)));
        return { name: constraint.name, type: 'check-error' };
      }
    } else if (typeof constraint.max === 'number' && typeof value === 'number' && value > constraint.max) {
      return { name: constraint.name, type: 'max-exceeded', value, max: constraint.max };
    } else if (typeof constraint.min === 'number' && typeof value === 'number' && value < constraint.min) {
      return { name: constraint.name, type: 'min-violated', value, min: constraint.min };
    }
    return null;
  }

  _generatePerturbation() {
    if (!this._config.perturbationEnabled) return null;
    if (this._plateauCounter < STRATEGY_PLATEAU_THRESHOLD) return null;
    const perturbation = {
      type: 'random-restart',
      strength: this._config.perturbationStrength,
      iteration: this._currentIteration,
      hint: 'Plateau detected — inject perturbation to escape local optimum',
    };
    debug('OptimizationLoop', 'perturbation', { iteration: this._currentIteration, strength: perturbation.strength });
    return perturbation;
  }

  /**
   * 注入人工审批门控实例，在关键里程碑（收敛检测、策略切换）时触发人工审批。
   * @param {Object} gate - HumanApprovalGate实例，需实现requestApproval()方法
   * @returns {OptimizationLoop} this（支持链式调用）
   */
  attachHumanApprovalGate(gate) {
    this.guardShutdown();
    if (gate && typeof gate.requestApproval === 'function') {
      this._humanApprovalGate = gate;
    }
    return this;
  }

  _collectMetrics(result) {
    const collected = {};
    if (!result || typeof result !== 'object') return collected;
    for (const [name, def] of this._metricsDefs) {
      if (result.metrics && typeof result.metrics[name] === 'number') {
        def.value = result.metrics[name];
        collected[name] = { value: def.value, direction: def.direction, target: def.target, weight: def.weight };
      } else if (typeof result[name] === 'number' && BUILTIN_METRIC_TYPES.has(def.type)) {
        def.value = result[name];
        collected[name] = { value: def.value, direction: def.direction, target: def.target, weight: def.weight };
      } else {
        collected[name] = { value: def.value, direction: def.direction, target: def.target, weight: def.weight };
      }
    }
    if (typeof result.qualityScore === 'number') {
      collected._qualityScore = { value: result.qualityScore, direction: 'maximize', target: 1, weight: 0 };
    }
    return collected;
  }

  _computeCompositeScore(metrics) {
    const entries = Object.entries(metrics).filter(([, m]) => m.weight > 0);
    if (entries.length === 0) {
      if (this._lastScore !== null) return this._lastScore;
      return 0;
    }
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [, m] of entries) {
      const normalized = this._normalizeMetric(m.value, m.target, m.direction);
      weightedSum += normalized * m.weight;
      totalWeight += m.weight;
    }
    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  _normalizeMetric(value, target, direction) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    if (typeof target !== 'number' || target === 0) {
      return direction === 'maximize' ? clamp01(value) : clamp01(1 - value);
    }
    if (direction === 'maximize') {
      return clamp01(value / Math.abs(target));
    }
    const ratio = value / Math.abs(target);
    return clamp01(1 - ratio);
  }

  _checkConvergence(compositeScore, metrics) {
    const dimensions = {};
    for (const [name, m] of Object.entries(metrics)) {
      if (m.weight > 0) {
        dimensions[name] = this._normalizeMetric(m.value, m.target, m.direction);
      }
    }
    const result = this._convergenceDetector.check('optimization-loop', {
      qualityScore: compositeScore,
      dimensions,
    });
    if (compositeScore >= this._config.convergenceThreshold) {
      return { converged: true, reason: 'threshold-met' };
    }
    if (result.converged) {
      return { converged: true, reason: result.reason };
    }
    return { converged: false, reason: result.reason ?? 'not-converged' };
  }

  _checkStagnation() {
    return this._stagnationCounter >= this._config.stagnationWindow;
  }

  _checkResourceBudget() {
    if (this._config.resourceBudget == null) return false;
    return this._resourceUsed >= this._config.resourceBudget;
  }

  _detectStrategyTrend(compositeScore) {
    if (this._metricsHistory.length < 2) return 'improving';
    const prevScore = this._metricsHistory[this._metricsHistory.length - 2].compositeScore;
    const diff = compositeScore - prevScore;
    if (diff > 0.001) {
      this._strategyTrend.push('improving');
      this._plateauCounter = 0;
    } else if (diff >= -0.001) {
      this._strategyTrend.push('plateau');
      this._plateauCounter++;
    } else {
      this._strategyTrend.push('degrading');
      this._plateauCounter = 0;
    }
    if (this._strategyTrend.length > 20) this._strategyTrend = this._strategyTrend.slice(-20);
    return this._strategyTrend[this._strategyTrend.length - 1];
  }

  _handleStrategyAutoSwitch(strategy) {
    if (this._plateauCounter >= STRATEGY_PLATEAU_THRESHOLD) {
      this.emit('strategy-suggestion', {
        iteration: this._currentIteration,
        trend: 'plateau',
        plateauCount: this._plateauCounter,
        suggestion: 'Consider changing optimization strategy — plateau detected for ' + this._plateauCounter + ' iterations',
      });
      debug('OptimizationLoop', 'strategySuggestion', { iteration: this._currentIteration, plateauCount: this._plateauCounter });
    }
    if (strategy === 'degrading' && this._bestIteration >= 0 && this._currentIteration > 1 && this._rollbackCount < MAX_ROLLBACKS) {
      const prevScore = this._metricsHistory.length >= 2 ? this._metricsHistory[this._metricsHistory.length - 2].compositeScore : null;
      if (prevScore !== null && this._lastScore !== null && (prevScore - this._lastScore) > DEGRADATION_THRESHOLD) {
        const snapshot = this._snapshots.get(this._bestIteration);
        if (snapshot) {
          this._rollbackCount++;
          const rollbackResult = this.rollbackTo(this._bestIteration);
          this.emit('auto-rollback', {
            iteration: this._currentIteration,
            bestIteration: this._bestIteration,
            bestScore: this._bestScore,
            currentScore: this._lastScore,
            reason: 'Quality degrading — auto-rollback to best iteration',
            rollbackSuccess: rollbackResult.success,
            rollbackCount: this._rollbackCount,
          });
          debug('OptimizationLoop', 'autoRollback', {
            from: this._currentIteration,
            to: this._bestIteration,
            currentScore: this._lastScore,
            bestScore: this._bestScore,
            rollbackSuccess: rollbackResult.success,
            rollbackCount: this._rollbackCount,
          });
        }
      }
    }
  }

  _saveSnapshot(iteration, metrics, strategy, result) {
    const snapshot = {
      iteration,
      timestamp: Date.now(),
      metrics: { compositeScore: this._computeCompositeScore(metrics), ...deepClone(metrics) },
      strategy,
      result: deepClone(result),
      context: this._buildIterationContext(),
    };
    this._snapshots.set(iteration, snapshot);
    if (this._snapshots.size > MAX_SNAPSHOTS) {
      const oldestKey = this._snapshots.keys().next().value;
      if (oldestKey !== iteration) this._snapshots.delete(oldestKey);
    }
  }

  _recordToMetricsCollector(metrics, compositeScore) {
    if (!this._metricsCollector) return;
    try {
      this._metricsCollector.recordIteration('optimization-loop', {
        qualityScore: compositeScore,
        duration: 0,
      });
      for (const [name, m] of Object.entries(metrics)) {
        if (m.weight > 0) {
          this._metricsCollector.record('optimization-' + name, m.value, { direction: m.direction });
        }
      }
    } catch (err) {
      debug('OptimizationLoop', 'recordMetrics', err);
      // 外部度量采集器异常不中断优化循环，仅发出事件通知上层
      this.emit('metrics-recording-failed', { error: err && err.message ? err.message : String(err) });
    }
  }

  _appendJournalEntry(iteration, metrics, strategy, result) {
    try {
      if (!this._journalInitialized) {
        this._initJournal();
      }
      const entry = this._formatJournalEntry(iteration, metrics, strategy, result);
      this._journalContent += entry;
      if (this._journalContent.length > MAX_JOURNAL_CONTENT_LENGTH) {
        const headerEnd = this._journalContent.indexOf('## Iterations');
        if (headerEnd !== -1) {
          const header = this._journalContent.substring(0, headerEnd);
          const tail = this._journalContent.slice(-Math.floor(MAX_JOURNAL_CONTENT_LENGTH * 0.8));
          const iterStart = tail.indexOf('### Iteration');
          this._journalContent = header + '\n## Iterations\n\n' + (iterStart !== -1 ? tail.substring(iterStart) : tail);
        } else {
          this._journalContent = this._journalContent.slice(-Math.floor(MAX_JOURNAL_CONTENT_LENGTH * 0.8));
        }
      }
      this._updateJournalSummaryInMemory();
      this._journalBuffer.push(entry);
      if (this._journalBuffer.length > this._maxJournalBuffer) {
        this._journalBuffer = this._journalBuffer.slice(-this._maxJournalBuffer);
      }
      this.emit('journal-updated', { iteration, path: this._journalPath });
    } catch (err) {
      debug('OptimizationLoop', 'appendJournal', errorMessage(err));
    }
  }

  _initJournal() {
    try {
      const dir = path.dirname(this._journalPath);
      ensureDirSync(dir);
      this._journalContent = this._formatJournalHeader();
      this._journalInitialized = true;
    } catch (err) {
      debug('OptimizationLoop', 'initJournal', errorMessage(err));
    }
  }

  _formatJournalHeader() {
    const lines = [
      '# Optimization Journal',
      '',
      '## Summary',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Best Score | N/A |',
      '| Best Iteration | N/A |',
      '| Total Iterations | 0 |',
      '| Convergence Status | not-converged |',
      '',
      '## Objective',
      '',
      this._objective,
      '',
    ];
    if (this._constraints.length > 0) {
      lines.push('## Constraints', '');
      for (const c of this._constraints) {
        lines.push('- ' + String(c));
      }
      lines.push('');
    }
    if (this._metricsDefs.size > 0) {
      lines.push('## Metrics', '');
      lines.push('| Name | Type | Direction | Target | Weight |');
      lines.push('|------|------|-----------|--------|--------|');
      for (const [, m] of this._metricsDefs) {
        lines.push('| ' + m.name + ' | ' + m.type + ' | ' + m.direction + ' | ' + m.target + ' | ' + m.weight + ' |');
      }
      lines.push('');
    }
    lines.push('## Iterations', '');
    return lines.join('\n');
  }

  _formatJournalEntry(iteration, metrics, strategy, result) {
    const ts = new Date().toISOString();
    const lines = [
      '### Iteration ' + iteration,
      '',
      '- **Timestamp**: ' + ts,
      '- **Strategy**: ' + (strategy ?? 'unknown'),
      '- **Composite Score**: ' + roundTo(this._computeCompositeScore(metrics), 4),
    ];
    const metricEntries = Object.entries(metrics).filter(([k]) => !k.startsWith('_'));
    if (metricEntries.length > 0) {
      lines.push('- **Metrics**:');
      for (const [name, m] of metricEntries) {
        lines.push('  - ' + name + ': ' + roundTo(m.value ?? 0, 4) + ' (' + m.direction + ')');
      }
    }
    if (result != null && typeof result === 'object') {
      const changes = result.changes || result.summary || '';
      if (changes && typeof changes === 'string') {
        const truncated = changes.length > MAX_JOURNAL_ENTRY_LENGTH ? changes.slice(0, MAX_JOURNAL_ENTRY_LENGTH) + '...[truncated]' : changes;
        lines.push('- **Changes**: ' + truncated);
      }
    }
    lines.push('');
    return lines.join('\n');
  }

  _updateJournalSummaryInMemory() {
    const convergenceStatus = this._getConvergenceStatus().status;
    this._journalContent = this._journalContent
      .replace(/\| Best Score \| .* \|/, '| Best Score | ' + (this._bestScore === -Infinity ? 'N/A' : roundTo(this._bestScore, 4)) + ' |')
      .replace(/\| Best Iteration \| .* \|/, '| Best Iteration | ' + (this._bestIteration === -1 ? 'N/A' : this._bestIteration) + ' |')
      .replace(/\| Total Iterations \| .* \|/, '| Total Iterations | ' + this._currentIteration + ' |')
      .replace(/\| Convergence Status \| .* \|/, '| Convergence Status | ' + convergenceStatus + ' |');
  }

  async _flushJournal() {
    if (!this._journalContent) return;
    try {
      const dir = path.dirname(this._journalPath);
      ensureDirSync(dir);
      await fs.promises.writeFile(this._journalPath, this._journalContent, 'utf-8');
      this._journalBuffer = [];
    } catch (err) {
      debug('OptimizationLoop', 'flushJournal', errorMessage(err));
    }
  }

  _flushJournalSync() {
    if (!this._journalContent) return;
    try {
      const dir = path.dirname(this._journalPath);
      ensureDirSync(dir);
      fs.writeFileSync(this._journalPath, this._journalContent, 'utf-8');
      this._journalBuffer = [];
    } catch (err) {
      debug('OptimizationLoop', 'flushJournalSync', errorMessage(err));
    }
  }

  _getConvergenceStatus() {
    if (this._status === LOOP_STATUS.CONVERGED) return { status: 'converged', threshold: this._config.convergenceThreshold };
    if (this._bestScore >= this._config.convergenceThreshold) return { status: 'converged', threshold: this._config.convergenceThreshold };
    if (this._checkStagnation()) return { status: 'stagnant', threshold: this._config.convergenceThreshold };
    if (this._status === LOOP_STATUS.EXHAUSTED) return { status: 'exhausted', threshold: this._config.convergenceThreshold };
    return { status: 'not-converged', threshold: this._config.convergenceThreshold };
  }

  _scheduleNextIteration() {
    if (this._config.iterationIntervalMs > 0) {
      this._nextIterationTimer = setTimeout(() => {
        this._nextIterationTimer = null;
        // 防止shutdown竞态：回调开头检查_shutDown标志，避免创建新定时器
        if (this._shutDown) return;
        if (this._status === LOOP_STATUS.RUNNING) {
          this._runLoop().catch(err => {
            debug('OptimizationLoop', 'loopError', errorMessage(err));
            this._status = LOOP_STATUS.FAILED;
            this.emit('loop-failed', { error: errorMessage(err), iteration: this._currentIteration });
          });
        }
      }, this._config.iterationIntervalMs);
      if (this._nextIterationTimer && typeof this._nextIterationTimer.unref === 'function') {
        this._nextIterationTimer.unref();
      }
    }
  }

  _scheduleDelay(ms) {
    return new Promise(resolve => {
      this._pendingDelayResolve = resolve;
      this._nextIterationTimer = setTimeout(() => {
        this._nextIterationTimer = null;
        this._pendingDelayResolve = null;
        // 防止shutdown竞态：回调开头检查_shutDown标志，避免创建新定时器
        if (this._shutDown) return;
        resolve();
      }, ms);
      if (this._nextIterationTimer && typeof this._nextIterationTimer.unref === 'function') {
        this._nextIterationTimer.unref();
      }
    });
  }

  _resetState() {
    this._currentIteration = 0;
    this._bestResult = null;
    this._bestScore = -Infinity;
    this._bestIteration = -1;
    this._lastScore = null;
    this._metricsHistory = [];
    this._snapshots.clear();
    this._strategyTrend = [];
    this._stagnationCounter = 0;
    this._plateauCounter = 0;
    this._resourceUsed = 0;
    this._journalInitialized = false;
    this._journalContent = '';
    this._journalBuffer = [];
    this._consecutiveFailures = 0;
    this._rollbackCount = 0;
    this._shepherdCounter = 0;
    this._startedAt = null;
    this._stoppedAt = null;
  }

  isHealthy() {
    if (this._shutDown) return false;
    return this._status !== LOOP_STATUS.FAILED;
  }

  /**
   * 获取统计信息。
   * @returns {{status: string, currentIteration: number, bestScore: number|null, bestIteration: number|null, totalSnapshots: number, metricsHistoryLength: number, stagnationCounter: number, plateauCounter: number, resourceUsed: number, strategyTrend: Array, healthy: boolean, shutDown: boolean}} 统计数据
   */
  getStats() {
    this.guardShutdown();
    return {
      status: this._status,
      currentIteration: this._currentIteration,
      bestScore: this._bestScore === -Infinity ? null : this._bestScore,
      bestIteration: this._bestIteration === -1 ? null : this._bestIteration,
      totalSnapshots: this._snapshots.size,
      metricsHistoryLength: this._metricsHistory.length,
      stagnationCounter: this._stagnationCounter,
      plateauCounter: this._plateauCounter,
      resourceUsed: this._resourceUsed,
      strategyTrend: this._strategyTrend.slice(-5),
      shepherdInterval: this._config.shepherdInterval,
      perturbationEnabled: this._config.perturbationEnabled,
      humanGateAttached: !!this._humanApprovalGate,
      healthy: this.isHealthy(),
      shutDown: !!this._shutDown,
    };
  }

  _onShutdown() {
    if (this._nextIterationTimer) {
      clearTimeout(this._nextIterationTimer);
      this._nextIterationTimer = null;
    }
    if (this._pendingDelayResolve) {
      this._pendingDelayResolve('stopped');
      this._pendingDelayResolve = null;
    }
    if (this._status === LOOP_STATUS.RUNNING) {
      this._status = LOOP_STATUS.STOPPED;
      this._stoppedAt = Date.now();
    }
    this._flushJournalSync();
    this._humanApprovalGate = null;
    this._snapshots.clear();
    this._metricsHistory = [];
    this._strategyTrend = [];
    safeCall(() => {
      if (this._convergenceDetector && typeof this._convergenceDetector.shutdown === 'function') {
        this._convergenceDetector.shutdown();
      }
    }, 'OptimizationLoop', 'shutdownConvergenceDetector');
    this._metricsDefs.clear();
    this._journalBuffer = [];
    this._journalContent = '';
    this._executeFn = null;
    this._loopOptions = null;
    this._bestResult = null;
    this._constraints = [];
    this._objective = null;
    this.removeAllListeners();
    return this._loopPromise;
  }
}

OptimizationLoop.LOOP_STATUS = LOOP_STATUS;
OptimizationLoop.DEFAULT_CONFIG = DEFAULT_CONFIG;
OptimizationLoop.MAX_SNAPSHOTS = MAX_SNAPSHOTS;
OptimizationLoop.BUILTIN_METRIC_TYPES = BUILTIN_METRIC_TYPES;

module.exports = withShutdown(OptimizationLoop);
