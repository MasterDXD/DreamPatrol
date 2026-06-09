'use strict';

/**
 * PlanExecuteOrchestrator — 规划-执行编排器
 *
 * 融合 "AI 先规划后执行" 范式的核心编排器。
 * 实现完整的 "规划 → 执行 → 验证 → 重新规划" 闭环：
 * - 规划层：目标分解为可执行步骤，支持动态调整
 * - 执行层：步骤式执行，前置校验 + 后置验证
 * - 失败驱动重新规划：执行失败自动回溯到规划层，生成新步骤
 * - 容错机制：重试 → 重新规划 → 分解，三级升级策略
 *
 * @module runtime/workflow/plan-execute-orchestrator
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedArray = require('../../utils/bounded-array');
const { debug } = require('../../utils/debug-logger');

// ─── 常量 ───────────────────────────────────────────────────────

const STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  REPLANNED: 'replanned',
};

const PLAN_STATUS = {
  PLANNING: 'planning',
  EXECUTING: 'executing',
  VERIFYING: 'verifying',
  REPLANNING: 'replanning',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const ESCALATION_LEVELS = {
  RETRY: 'retry',
  REPLAN: 'replan',
  DECOMPOSE: 'decompose',
};

const DEFAULT_CONFIG = {
  /** 单步骤最大重试次数 */
  maxStepRetries: 2,
  /** 最大重新规划次数 */
  maxReplanCount: 3,
  /** 最大分解深度 */
  maxDecomposeDepth: 2,
  /** 验证失败是否触发重新规划 */
  verifyFailureTriggersReplan: true,
  /** 步骤执行超时（毫秒），0=不限 */
  stepTimeoutMs: 0,
  /** 历史记录容量 */
  historySize: 100,
};

// ─── 类定义 ─────────────────────────────────────────────────────

class PlanExecuteOrchestrator extends EventEmitter {
  /**
   * @param {Object} [config]
   * @param {number} [config.maxStepRetries]   步骤最大重试次数
   * @param {number} [config.maxReplanCount]   最大重新规划次数
   * @param {number} [config.maxDecomposeDepth] 最大分解深度
   * @param {boolean} [config.verifyFailureTriggersReplan] 验证失败是否触发重新规划
   * @param {number} [config.stepTimeoutMs]    步骤超时
   * @param {number} [config.historySize]      历史容量
   */
  constructor(config) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config ?? {});

    // 当前计划
    this._currentPlan = null;
    this._planStatus = null;
    this._steps = [];
    this._stepIndex = 0;
    this._replanCount = 0;
    this._decomposeDepth = 0;

    // 历史
    this._history = new BoundedArray(this._config.historySize);

    // 统计
    this._stats = {
      plansCreated: 0,
      stepsExecuted: 0,
      stepsCompleted: 0,
      stepsFailed: 0,
      replansTriggered: 0,
      decomposesTriggered: 0,
      escalations: { retry: 0, replan: 0, decompose: 0 },
    };
  }

  // ─── 公共 API ────────────────────────────────────────────────

  /**
   * 执行完整的规划-执行循环。
   * @param {string} objective - 目标描述
   * @param {Object} fns - 回调函数集合
   * @param {Function} fns.planFn - 规划函数：(objective, context) => steps[]
   * @param {Function} fns.executeFn - 执行函数：(step, context) => result
   * @param {Function} [fns.verifyFn] - 验证函数：(step, result, context) => { passed, reason }
   * @param {Function} [fns.replanFn] - 重新规划函数：(objective, failedStep, failureReason, context) => steps[]
   * @param {Function} [fns.decomposeFn] - 分解函数：(objective, context) => steps[]
   * @param {Object} [context] - 执行上下文
   * @returns {Object} 执行结果
   */
  async execute(objective, fns, context) {
    this.guardShutdown();

    if (!objective || typeof objective !== 'string') {
      throw new Error('objective must be a non-empty string');
    }
    if (!fns || typeof fns.planFn !== 'function') {
      throw new Error('planFn is required');
    }
    if (typeof fns.executeFn !== 'function') {
      throw new Error('executeFn is required');
    }

    this._replanCount = 0;
    this._decomposeDepth = 0;
    this._stats.plansCreated++;

    // Phase 1: 规划
    this._setPlanStatus(PLAN_STATUS.PLANNING);
    this.emit('plan-started', { objective });

    let steps;
    try {
      steps = await fns.planFn(objective, context ?? {});
    } catch (err) {
      this._setPlanStatus(PLAN_STATUS.FAILED);
      this.emit('plan-failed', { objective, error: err && err.message ? err.message : String(err) });
      return { success: false, reason: 'planning-failed', error: err && err.message ? err.message : String(err) };
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      this._setPlanStatus(PLAN_STATUS.FAILED);
      return { success: false, reason: 'empty-plan' };
    }

    this._steps = this._normalizeSteps(steps);
    this._stepIndex = 0;
    this._currentPlan = { objective, steps: this._steps, createdAt: Date.now() };

    this.emit('plan-created', { objective, stepCount: this._steps.length });
    this._setPlanStatus(PLAN_STATUS.EXECUTING);

    // Phase 2: 执行循环
    const result = await this._executeLoop(objective, fns, context ?? {});

    // 记录历史
    this._history.push({
      objective,
      stepCount: this._steps.length,
      success: result.success,
      replanCount: this._replanCount,
      completedAt: Date.now(),
    });

    return result;
  }

  /**
   * 获取当前计划状态。
   * @returns {Object}
   */
  getStatus() {
    return {
      planStatus: this._planStatus,
      stepIndex: this._stepIndex,
      totalSteps: this._steps.length,
      replanCount: this._replanCount,
      decomposeDepth: this._decomposeDepth,
      currentPlan: this._currentPlan ? {
        objective: this._currentPlan.objective,
        stepCount: this._currentPlan.steps.length,
      } : null,
      steps: this._steps.map(function(s) {
        return { id: s.id, description: s.description, status: s.status, retryCount: s.retryCount };
      }),
    };
  }

  /**
   * 获取统计信息。
   * @returns {Object}
   */
  getStats() {
    return Object.assign({}, this._stats, {
      historySize: this._history ? this._history.toArray().length : 0,
    });
  }

  /**
   * 获取执行历史。
   * @param {number} [limit]
   * @returns {Array}
   */
  getHistory(limit) {
    if (!this._history) return [];
    const arr = this._history.toArray();
    if (limit && limit > 0) return arr.slice(-limit);
    return arr;
  }

  // ─── 执行循环 ────────────────────────────────────────────────

  /**
   * 核心执行循环：按步骤执行，失败时触发升级策略。
   * @private
   */
  async _executeLoop(objective, fns, context) {
    while (this._stepIndex < this._steps.length) {
      if (this._shutDown) {
        return { success: false, reason: 'shutdown' };
      }

      const step = this._steps[this._stepIndex];
      if (step.status === STEP_STATUS.COMPLETED || step.status === STEP_STATUS.SKIPPED) {
        this._stepIndex++;
        continue;
      }

      // 执行步骤
      const stepResult = await this._executeStep(step, fns, context);

      if (stepResult.success) {
        // 验证步骤结果
        if (fns.verifyFn) {
          this._setPlanStatus(PLAN_STATUS.VERIFYING);
          const verification = await this._verifyStep(step, stepResult, fns, context);

          if (!verification.passed) {
            // 验证失败也计入重试次数
            step.retryCount = (step.retryCount ?? 0) + 1;
            // 验证失败 → 升级策略
            const escalation = await this._escalateOnFailure(
              objective, step, verification.reason, fns, context,
            );
            if (!escalation.continue) {
              return escalation.result;
            }
            continue;
          }
        }

        step.status = STEP_STATUS.COMPLETED;
        this._stats.stepsCompleted++;
        this.emit('step-completed', { stepId: step.id, result: stepResult.result });
        this._stepIndex++;
        this._setPlanStatus(PLAN_STATUS.EXECUTING);
      } else {
        // 执行失败 → 升级策略
        const escalation = await this._escalateOnFailure(
          objective, step, stepResult.error, fns, context,
        );
        if (!escalation.continue) {
          return escalation.result;
        }
        continue;
      }
    }

    // 所有步骤完成
    this._setPlanStatus(PLAN_STATUS.COMPLETED);
    this.emit('plan-completed', { objective, stepCount: this._steps.length });
    return { success: true, steps: this._steps.length, replanCount: this._replanCount };
  }

  /**
   * 执行单个步骤。
   * @private
   */
  async _executeStep(step, fns, context) {
    step.status = STEP_STATUS.RUNNING;
    this._stats.stepsExecuted++;
    this.emit('step-started', { stepId: step.id, description: step.description });

    try {
      const result = await fns.executeFn(step, context);
      return { success: true, result: result };
    } catch (err) {
      this._stats.stepsFailed++;
      step.retryCount = (step.retryCount ?? 0) + 1;
      const errMsg = err && err.message ? err.message : String(err);
      this.emit('step-failed', { stepId: step.id, error: errMsg, retryCount: step.retryCount });
      return { success: false, error: errMsg };
    }
  }

  /**
   * 验证步骤结果。
   * @private
   */
  async _verifyStep(step, stepResult, fns, context) {
    try {
      const verification = await fns.verifyFn(step, stepResult.result, context);
      if (verification && verification.passed === false) {
        this.emit('step-verification-failed', {
          stepId: step.id,
          reason: verification.reason || 'unspecified',
        });
        return { passed: false, reason: verification.reason || 'verification-failed' };
      }
      return { passed: true };
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      this.emit('step-verification-error', { stepId: step.id, error: errMsg });
      return { passed: false, reason: 'verification-error: ' + errMsg };
    }
  }

  /**
   * 失败升级策略：retry → replan → decompose。
   * @private
   */
  async _escalateOnFailure(objective, step, failureReason, fns, context) {
    const retryCount = step.retryCount ?? 0;

    // Level 1: 重试
    if (retryCount <= this._config.maxStepRetries) {
      this._stats.escalations.retry++;
      debug('PlanExecuteOrchestrator', 'escalate-retry', step.id, 'attempt=' + retryCount);
      step.status = STEP_STATUS.PENDING;
      return { continue: true };
    }

    // Level 2: 重新规划
    if (this._replanCount < this._config.maxReplanCount && typeof fns.replanFn === 'function') {
      this._stats.escalations.replan++;
      this._replanCount++;
      this._stats.replansTriggered++;
      step.status = STEP_STATUS.REPLANNED;

      this._setPlanStatus(PLAN_STATUS.REPLANNING);
      this.emit('replan-triggered', {
        objective: objective,
        failedStepId: step.id,
        failureReason: failureReason,
        replanCount: this._replanCount,
      });

      try {
        const newSteps = await fns.replanFn(objective, step, failureReason, context);
        if (Array.isArray(newSteps) && newSteps.length > 0) {
          const normalizedNew = this._normalizeSteps(newSteps);
          // 在当前步骤位置插入新步骤（替换失败步骤）
          this._steps.splice.apply(this._steps, [this._stepIndex, 1].concat(normalizedNew));
          this.emit('replan-completed', {
            newStepCount: normalizedNew.length,
            replanCount: this._replanCount,
          });
          this._setPlanStatus(PLAN_STATUS.EXECUTING);
          return { continue: true };
        }
      } catch (err) {
        debug('PlanExecuteOrchestrator', 'replan-failed', err && err.message ? err.message : String(err));
      }

      // 重新规划失败，继续尝试分解
    }

    // Level 3: 分解
    if (this._decomposeDepth < this._config.maxDecomposeDepth && typeof fns.decomposeFn === 'function') {
      this._stats.escalations.decompose++;
      this._decomposeDepth++;
      this._stats.decomposesTriggered++;

      this.emit('decompose-triggered', {
        objective: objective,
        failedStepId: step.id,
        failureReason: failureReason,
        decomposeDepth: this._decomposeDepth,
      });

      try {
        const subSteps = await fns.decomposeFn(objective, context);
        if (Array.isArray(subSteps) && subSteps.length > 0) {
          const normalizedSub = this._normalizeSteps(subSteps);
          this._steps.splice.apply(this._steps, [this._stepIndex, 1].concat(normalizedSub));
          this.emit('decompose-completed', {
            subStepCount: normalizedSub.length,
            decomposeDepth: this._decomposeDepth,
          });
          this._setPlanStatus(PLAN_STATUS.EXECUTING);
          return { continue: true };
        }
      } catch (err) {
        debug('PlanExecuteOrchestrator', 'decompose-failed', err && err.message ? err.message : String(err));
      }
    }

    // 所有升级策略耗尽
    step.status = STEP_STATUS.FAILED;
    this._setPlanStatus(PLAN_STATUS.FAILED);
    this.emit('plan-failed', {
      objective: objective,
      failedStepId: step.id,
      failureReason: failureReason,
      replanCount: this._replanCount,
    });

    return {
      continue: false,
      result: {
        success: false,
        reason: 'escalation-exhausted',
        failedStepId: step.id,
        failureReason: failureReason,
        replanCount: this._replanCount,
      },
    };
  }

  // ─── 辅助方法 ────────────────────────────────────────────────

  /**
   * 规范化步骤列表。
   * @private
   */
  _normalizeSteps(steps) {
    return steps.map(function(step, index) {
      if (typeof step === 'string') {
        return {
          id: 'step-' + (index + 1),
          description: step,
          status: STEP_STATUS.PENDING,
          retryCount: 0,
        };
      }
      return Object.assign({
        id: step.id || 'step-' + (index + 1),
        description: step.description || '',
        status: STEP_STATUS.PENDING,
        retryCount: 0,
      }, step);
    });
  }

  /**
   * 设置计划状态并发出事件。
   * @private
   */
  _setPlanStatus(status) {
    this._planStatus = status;
    this.emit('plan-status-changed', { status: status });
  }

  // ─── 生命周期 ────────────────────────────────────────────────

  _onShutdown() {
    this._currentPlan = null;
    this._steps = [];
    if (this._history) {
      this._history.shutdown();
      this._history = null;
    }
    this.removeAllListeners();
  }
}

// ─── 导出 ───────────────────────────────────────────────────────

module.exports = {
  PlanExecuteOrchestrator: withShutdown(PlanExecuteOrchestrator),
  STEP_STATUS: STEP_STATUS,
  PLAN_STATUS: PLAN_STATUS,
  ESCALATION_LEVELS: ESCALATION_LEVELS,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
};
