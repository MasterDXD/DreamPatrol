'use strict';

const { EventEmitter } = require('events');
const { generateId, DEFAULT_MAX_BACKOFF_MS } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { errorMessage } = require('../../utils/safe-execute');

const ESCALATION_LEVELS = {
  RETRY: 'retry',
  REPLAN: 'replan',
  DECOMPOSE: 'decompose',
};

const DEFAULT_MAX_RETRIES = 3;
const ABSOLUTE_MAX_RETRIES = 100;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const MAX_BACKOFF_MS = DEFAULT_MAX_BACKOFF_MS;
const MAX_DECOMPOSE_DEPTH = 3;
const SHUTDOWN_CHECK_INTERVAL_MS = 500;

/**
 * @module runtime/infrastructure/retry-engine
 * RetryEngine — 重试引擎
 * 提供带指数退避的任务重试和三级升级策略（retry→replan→decompose）。
 * 重试耗尽后自动升级：先尝试重新规划任务，再尝试分解为子任务递归执行。
 * 支持关闭检测中断休眠、任务尝试追踪和事件通知。
 * @classdesc 重试引擎。指数退避、抖动、最大重试次数
 * @extends EventEmitter
 */
class RetryEngine extends EventEmitter {
  /**
   * 创建 RetryEngine 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxRetries=3] - 最大重试次数，上限为100
   * @param {number} [options.backoffBaseMs=1000] - 退避基础时间（毫秒），实际退避为 backoffBaseMs * 2^(attempt-1)
   */
  constructor(options) {
    super();
    this._maxRetries = Math.min(
      (options && options.maxRetries) ?? DEFAULT_MAX_RETRIES,
      ABSOLUTE_MAX_RETRIES,
    );
    if (!Number.isFinite(this._maxRetries) || this._maxRetries < 1) {
      this._maxRetries = DEFAULT_MAX_RETRIES;
    }
    this._backoffBase = (options && options.backoffBaseMs) ?? DEFAULT_BACKOFF_BASE_MS;
    this._attempts = new Map();
    this._maxAttemptsEntries = 1000;
    /** 活跃休眠定时器集合，关闭时批量清理 */
    this._sleepTimers = new Set();
    /** 活跃关闭检查间隔集合，关闭时批量清理 */
    this._checkIntervals = new Set();
  }

  /**
   * 执行带重试和升级策略的任务。重试耗尽后依次尝试重新规划（replan）和分解（decompose）。
   * 每次重试间使用指数退避，关闭时自动中断休眠。
   * @param {Object} task - 任务对象，须包含 execute 方法
   * @param {Function} task.execute - 任务执行函数，签名为 (context: Object) => Promise<*>
   * @param {string} [task.id] - 任务标识符
   * @param {Function} [task.replan] - 重新规划函数，签名为 (errors: Array) => Promise<Object|null>
   * @param {Function} [task.decompose] - 分解函数，签名为 (errors: Array) => Promise<Object[]>
   * @param {number} [_depth=0] - 当前递归深度，超过 MAX_DECOMPOSE_DEPTH 时终止
   * @returns {Promise<{success: boolean, result?: *, attempts: number, escalatedTo?: string, errors?: Array, partialResults?: Array}>} 执行结果
   */
  async execute(task, _depth) {
    this.guardShutdown();
    if (!task || typeof task.execute !== 'function') {
      return { success: false, error: 'task must have an execute function', attempts: 0 };
    }
    const depth = _depth ?? 0;
    if (depth > MAX_DECOMPOSE_DEPTH) {
      return { success: false, error: 'Maximum decompose depth exceeded', attempts: 0 };
    }
    const taskId = task.id || generateId('re-');
    const context = {
      taskId,
      level: ESCALATION_LEVELS.RETRY,
      attempt: 0,
      maxRetries: this._maxRetries,
      errors: [],
    };

    if (this._attempts.size >= this._maxAttemptsEntries) {
      const oldestKey = this._attempts.keys().next().value;
      this._attempts.delete(oldestKey);
    }
    this._attempts.set(taskId, context);

    while (context.attempt < this._maxRetries) {
      context.attempt++;
      try {
        const result = await task.execute(context);
        context.result = result;
        context.completedAt = new Date().toISOString();
        this.emit('task-completed', { taskId, attempt: context.attempt, result });
        this._attempts.delete(taskId);
        return { success: true, result, attempts: context.attempt };
      } catch (err) {
        context.errors.push({
          attempt: context.attempt,
          error: errorMessage(err),
          timestamp: new Date().toISOString(),
        });
        this.emit('task-retry', { taskId, attempt: context.attempt, error: err && err.message ? err.message : String(err) });

        if (context.attempt >= this._maxRetries) {
          break;
        }

        const backoff = Math.min(this._backoffBase * Math.pow(2, context.attempt - 1), MAX_BACKOFF_MS);
        try {
          await _sleep(backoff, () => this._shutDown, this._sleepTimers, this._checkIntervals);
        } catch (sleepErr) {
          context.errors.push({
            attempt: context.attempt,
            error: errorMessage(sleepErr),
            timestamp: new Date().toISOString(),
          });
          break;
        }
      }
    }

    this.emit('retry-exhausted', { taskId, errors: context.errors });
    return this._escalate(task, context, depth);
  }

  async _escalate(task, context, depth) {
    const replanResult = await this._escalateReplan(task, context);
    if (replanResult) return replanResult;

    const decomposeResult = await this._escalateDecompose(task, context, depth);
    if (decomposeResult) return decomposeResult;

    this._attempts.delete(context.taskId);
    return {
      success: false,
      error: 'All escalation levels exhausted',
      attempts: context.attempt,
      errors: context.errors,
      escalatedTo: context.level,
    };
  }

  async _escalateReplan(task, context) {
    if (!task.replan || typeof task.replan !== 'function') return null;
    context.level = ESCALATION_LEVELS.REPLAN;
    this.emit('escalation', { taskId: context.taskId, level: ESCALATION_LEVELS.REPLAN });

    try {
      const replannedTask = await task.replan(context.errors);
      if (replannedTask) {
        context.attempt = 0;
        for (let i = 0; i < this._maxRetries; i++) {
          context.attempt++;
          try {
            const result = await replannedTask.execute(context);
            this.emit('task-completed', { taskId: context.taskId, attempt: context.attempt, level: ESCALATION_LEVELS.REPLAN });
            this._attempts.delete(context.taskId);
            return { success: true, result, attempts: context.attempt, escalatedTo: ESCALATION_LEVELS.REPLAN };
          } catch (err) {
            context.errors.push({
              attempt: context.attempt,
              error: errorMessage(err),
              level: ESCALATION_LEVELS.REPLAN,
              timestamp: new Date().toISOString(),
            });
            const backoff = Math.min(this._backoffBase * Math.pow(2, context.attempt - 1), MAX_BACKOFF_MS);
            try {
              await _sleep(backoff, () => this._shutDown, this._sleepTimers, this._checkIntervals);
            } catch (sleepErr) {
              context.errors.push({ attempt: context.attempt, error: errorMessage(sleepErr), phase: 'replan-sleep', timestamp: new Date().toISOString() });
              break;
            }
          }
        }
      }
    } catch (err) {
      if (this._shutDown) {
        this._attempts.delete(context.taskId);
        return { success: false, error: 'Shut down during replan', attempts: context.attempt };
      }
      context.errors.push({
        attempt: 0,
        error: `Replan failed: ${err && err.message ? err.message : String(err)}`,
        level: ESCALATION_LEVELS.REPLAN,
        timestamp: new Date().toISOString(),
      });
    }
    return null;
  }

  async _escalateDecompose(task, context, depth) {
    if (!task.decompose || typeof task.decompose !== 'function') return null;
    context.level = ESCALATION_LEVELS.DECOMPOSE;
    this.emit('escalation', { taskId: context.taskId, level: ESCALATION_LEVELS.DECOMPOSE });

    try {
      const subtasks = await task.decompose(context.errors);
      if (Array.isArray(subtasks) && subtasks.length > 0) {
        const results = [];
        for (const subtask of subtasks) {
          let subResult;
          try {
            subResult = await this.execute(subtask, depth + 1);
          } catch (subErr) {
            results.push({ success: false, error: errorMessage(subErr), attempts: 0 });
            continue;
          }
          results.push(subResult);
          if (!subResult.success) {
            this._attempts.delete(context.taskId);
            return {
              success: false,
              error: 'Subtask failed after full escalation',
              attempts: context.attempt,
              escalatedTo: ESCALATION_LEVELS.DECOMPOSE,
              partialResults: results,
            };
          }
        }
        this.emit('task-completed', { taskId: context.taskId, level: ESCALATION_LEVELS.DECOMPOSE });
        this._attempts.delete(context.taskId);
        return {
          success: true,
          result: results,
          attempts: context.attempt,
          escalatedTo: ESCALATION_LEVELS.DECOMPOSE,
        };
      }
    } catch (err) {
      context.errors.push({
        attempt: 0,
        error: `Decompose failed: ${err && err.message ? err.message : String(err)}`,
        level: ESCALATION_LEVELS.DECOMPOSE,
        timestamp: new Date().toISOString(),
      });
    }
    return null;
  }

  /**
   * 获取指定任务的尝试上下文信息。
   * @param {string} taskId - 任务标识符
   * @returns {Object|null} 任务尝试上下文，包含 taskId、level、attempt、maxRetries、errors 等字段，不存在时返回 null
   */
  getAttempt(taskId) {
    return this._attempts.get(taskId) ?? null;
  }

  _onShutdown() {
    this._attempts.clear();
    for (const t of this._sleepTimers) {
      clearTimeout(t);
    }
    this._sleepTimers.clear();
    for (const ci of this._checkIntervals) {
      clearInterval(ci);
    }
    this._checkIntervals.clear();
    this.removeAllListeners();
  }

}

RetryEngine = withShutdown(RetryEngine);

/**
 * 带关闭检测的休眠函数。创建定时器并在完成或关闭时自动清理。
 * @param {number} ms - 休眠时间（毫秒）
 * @param {Function} [shutdownGetter] - 获取关闭状态的函数，返回 boolean
 * @param {Set} [timersSet] - 用于跟踪活跃定时器的 Set，支持关闭时批量清理
 * @param {Set} [intervalsSet] - 用于跟踪活跃检查间隔的 Set，支持关闭时批量清理
 * @returns {Promise<void>}
 */
function _sleep(ms, shutdownGetter, timersSet, intervalsSet) {
  return new Promise(function(resolve, reject) {
    let settled = false;
    let check = null;
    const timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      if (check) { clearInterval(check); if (intervalsSet) intervalsSet.delete(check); }
      if (timersSet) timersSet.delete(timer);
      resolve();
    }, ms);
    if (timersSet) timersSet.add(timer);
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (typeof shutdownGetter === 'function') {
      check = setInterval(function() {
        if (shutdownGetter()) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(check);
          if (timersSet) timersSet.delete(timer);
          if (intervalsSet) intervalsSet.delete(check);
          reject(new Error('Aborted: shutdown detected'));
        }
      }, SHUTDOWN_CHECK_INTERVAL_MS);
      if (check && typeof check.unref === 'function') check.unref();
      if (intervalsSet) intervalsSet.add(check);
    }
  });
}

RetryEngine.ESCALATION_LEVELS = ESCALATION_LEVELS;
RetryEngine.DEFAULT_MAX_RETRIES = DEFAULT_MAX_RETRIES;
RetryEngine.ABSOLUTE_MAX_RETRIES = ABSOLUTE_MAX_RETRIES;

module.exports = RetryEngine;
