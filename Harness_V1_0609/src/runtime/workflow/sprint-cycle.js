'use strict';

const { EventEmitter } = require('events');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { HarnessError } = require('../../errors');
const { debug } = require('../../utils/debug-logger');

const SPRINT_PHASES = Object.freeze({
  CODE: 'code',
  TEST: 'test',
  REVIEW: 'review',
  INTEGRATE: 'integrate',
});

const SPRINT_PHASE_ORDER = [SPRINT_PHASES.CODE, SPRINT_PHASES.TEST, SPRINT_PHASES.REVIEW, SPRINT_PHASES.INTEGRATE];

const SPRINT_STATES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const DEFAULT_CONFIG = {
  maxSprints: 10,
  qualityThreshold: 0.85,
  failFastOnTest: true,
  requireReviewPass: true,
  autoAdvance: true,
  sprintTimeoutMs: 300000,
};

/**
 * @module runtime/workflow/sprint-cycle
 * @classdesc 冲刺周期管理器（SprintCycle）。迭代管理、回顾总结、速率追踪。
 * SprintCycle — 冲刺周期管理器
 * Iterative sprint execution with four phases (code, test, review, integrate) per sprint.
 * Supports configurable quality thresholds, fail-fast on test failures, review pass requirements,
 * auto-advance between sprints, and manual pause/resume/abort controls. Continues sprinting
 * until quality threshold is met or max sprints are reached.
 * @extends EventEmitter
 * @emits sprint-start | sprint-end | phase-start | phase-end | phase-error | cycle-completed | cycle-paused | cycle-resumed | cycle-aborted | sprint-paused
 */
class SprintCycle {

  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxSprints=10] - 最大冲刺次数
   * @param {number} [options.qualityThreshold=0.85] - 质量达标阈值
   * @param {boolean} [options.failFastOnTest=true] - 测试失败时是否快速终止
   * @param {boolean} [options.requireReviewPass=true] - 是否要求审查通过
   * @param {boolean} [options.autoAdvance=true] - 是否自动推进到下一冲刺
   * @param {number} [options.sprintTimeoutMs=300000] - 单次冲刺超时时间（毫秒）
   */
  constructor(options) {
    EventEmitter.call(this);
    const opts = mergeConfig(DEFAULT_CONFIG, options);
    this._config = opts;
    this._state = SPRINT_STATES.IDLE;
    this._currentSprint = 0;
    this._currentPhaseIndex = 0;
    this._sprintHistory = [];
    this._phaseResults = new Map();
    this._aborted = false;
  }

  static get PHASES() { return SPRINT_PHASES; }
  static get STATES() { return SPRINT_STATES; }

  get state() { return this._state; }
  get currentSprint() { return this._currentSprint; }
  get currentPhase() { return SPRINT_PHASE_ORDER[this._currentPhaseIndex] ?? null; }

  /**
   * 运行冲刺周期。迭代执行code→test→review→integrate四阶段冲刺，
   * 直到质量达标或达到最大冲刺次数。
   *
   * @param {Function} executePhaseFn - 阶段执行函数，接收(phase, context)参数
   * @param {Object} [context] - 传递给每个冲刺的上下文信息
   * @returns {Promise<{completed: boolean, sprints?: number, quality?: number, reason?: string, history: Array}>} 周期执行结果
   */
  async run(executePhaseFn, context) {
    this.guardShutdown();
    if (this._running || this._state === SPRINT_STATES.RUNNING) {
      throw new HarnessError('SPRINT_ALREADY_RUNNING', 'A sprint cycle is already in progress');
    }
    // 状态检查与设置在同一同步帧完成，防止 await 恢复后竞态
    this._running = true;
    this._state = SPRINT_STATES.RUNNING;
    this._aborted = false;
    this._currentSprint = 0;

    try {
      while (this._currentSprint < this._config.maxSprints) {
        if (this._aborted) break;
        if (this._state === SPRINT_STATES.PAUSED) {
          this.emit('sprint-paused', { sprint: this._currentSprint });
          return { completed: false, reason: 'manual-pause', sprint: this._currentSprint, history: this._sprintHistory };
        }
        this._currentSprint++;
        this._currentPhaseIndex = 0;
        this._phaseResults.clear();
        this.emit('sprint-start', { sprint: this._currentSprint, context: context });

        const sprintResult = await this._runSprintPhases(executePhaseFn, context);
        if (this._shutDown) throw new Error('Shut down during sprint');

        this._sprintHistory.push({
          sprint: this._currentSprint,
          phases: Object.fromEntries(this._phaseResults),
          result: sprintResult,
          timestamp: Date.now(),
        });
        if (this._sprintHistory.length > 50) {
          this._sprintHistory = this._sprintHistory.slice(-25);
        }

        this.emit('sprint-end', { sprint: this._currentSprint, result: sprintResult });

        if (sprintResult.quality >= this._config.qualityThreshold) {
          this._state = SPRINT_STATES.COMPLETED;
          this.emit('cycle-completed', { sprints: this._currentSprint, quality: sprintResult.quality });
          return { completed: true, sprints: this._currentSprint, quality: sprintResult.quality, history: this._sprintHistory };
        }

        if (sprintResult.failed && this._config.failFastOnTest) {
          this._state = SPRINT_STATES.FAILED;
          return { completed: false, reason: 'sprint-failed', sprint: this._currentSprint, history: this._sprintHistory };
        }

        if (!this._config.autoAdvance) {
          this._state = SPRINT_STATES.PAUSED;
          this.emit('sprint-paused', { sprint: this._currentSprint });
          return { completed: false, reason: 'manual-pause', sprint: this._currentSprint, history: this._sprintHistory };
        }
      }

      this._state = SPRINT_STATES.FAILED;
      return { completed: false, reason: 'max-sprints-reached', sprint: this._currentSprint, history: this._sprintHistory };
    } catch (err) {
      this._state = SPRINT_STATES.FAILED;
      debug('SprintCycle', 'run-error', err && err.message ? err.message : String(err));
      return { completed: false, reason: 'execution_error', error: err && err.message ? err.message : String(err), sprintsCompleted: this._currentSprint, aborted: this._aborted };
    } finally {
      this._running = false;
    }
  }

  async _runSprintPhases(executePhaseFn, context) {
    let quality = 0;
    let failed = false;

    for (let i = 0; i < SPRINT_PHASE_ORDER.length; i++) {
      if (this._aborted) break;

      this._currentPhaseIndex = i;
      const phase = SPRINT_PHASE_ORDER[i];
      this.emit('phase-start', { sprint: this._currentSprint, phase: phase });

      try {
        const phaseResult = await executePhaseFn(phase, {
          sprint: this._currentSprint,
          phase: phase,
          previousResults: Object.fromEntries(this._phaseResults),
          context: context,
        });

        this._phaseResults.set(phase, phaseResult);
        this.emit('phase-end', { sprint: this._currentSprint, phase: phase, result: phaseResult });

        const check = this._checkPhaseResult(phase, phaseResult);
        if (check.failed) {
          failed = true;
          quality = check.quality;
          break;
        }
        if (check.quality !== null) {
          quality = check.quality;
        }
      } catch (err) {
        const errMsg = err && err.message ? err.message : String(err);
        this._phaseResults.set(phase, { error: errMsg, failed: true });
        this.emit('phase-error', { sprint: this._currentSprint, phase: phase, error: errMsg });
        failed = true;
        break;
      }
    }

    return { quality, failed, sprint: this._currentSprint };
  }

  _checkPhaseResult(phase, phaseResult) {
    if (phase === SPRINT_PHASES.TEST && phaseResult && phaseResult.failed) {
      if (this._config.failFastOnTest) {
        return {
          failed: true,
          quality: typeof phaseResult.passRate === 'number' && Number.isFinite(phaseResult.passRate) ? phaseResult.passRate : 0,
        };
      }
    }
    if (phase === SPRINT_PHASES.REVIEW && phaseResult) {
      if (this._config.requireReviewPass && phaseResult.rejected) {
        return {
          failed: true,
          quality: typeof phaseResult.score === 'number' && Number.isFinite(phaseResult.score) ? phaseResult.score : 0,
        };
      }
    }
    if (phase === SPRINT_PHASES.INTEGRATE && phaseResult) {
      return {
        failed: false,
        quality: typeof phaseResult.quality === 'number' && Number.isFinite(phaseResult.quality) ? phaseResult.quality : null,
      };
    }
    return { failed: false, quality: null };
  }

  /**
   * 暂停当前冲刺周期。下次run迭代时将检测到暂停状态并退出。
   *
   * @returns {void}
   */
  pause() {
    this.guardShutdown();
    if (this._state === SPRINT_STATES.RUNNING) {
      this._state = SPRINT_STATES.PAUSED;
      this.emit('cycle-paused', { sprint: this._currentSprint });
    }
  }

  /**
   * 恢复已暂停的冲刺周期。
   *
   * @returns {void}
   */
  resume() {
    this.guardShutdown();
    if (this._state === SPRINT_STATES.PAUSED) {
      this._state = SPRINT_STATES.RUNNING;
      this.emit('cycle-resumed', { sprint: this._currentSprint });
    }
  }

  /**
   * 中止当前冲刺周期，将状态设为failed。
   *
   * @returns {void}
   */
  abort() {
    this.guardShutdown();
    this._aborted = true;
    this._state = SPRINT_STATES.FAILED;
    this.emit('cycle-aborted', { sprint: this._currentSprint });
  }

  /**
   * 获取冲刺历史记录的副本。
   *
   * @returns {Array<Object>} 冲刺历史数组
   */
  getHistory() {
    return this._sprintHistory.slice();
  }

  /**
   * 获取冲刺周期统计信息。
   *
   * @returns {Object} 统计快照，包含state、currentSprint、currentPhase、maxSprints、qualityThreshold、historyLength
   */
  getStats() {
    return {
      state: this._state,
      currentSprint: this._currentSprint,
      currentPhase: this.currentPhase,
      maxSprints: this._config.maxSprints,
      qualityThreshold: this._config.qualityThreshold,
      historyLength: this._sprintHistory.length,
    };
  }

  _onShutdown() {
    this._aborted = true;
    this._sprintHistory.length = 0;
    this._phaseResults.clear();
    this.removeAllListeners();
  }
}

Object.assign(SprintCycle.prototype, EventEmitter.prototype);
SprintCycle.prototype.constructor = SprintCycle;

module.exports = { SprintCycle: withShutdown(SprintCycle), SPRINT_PHASES, SPRINT_STATES, SPRINT_PHASE_ORDER };
