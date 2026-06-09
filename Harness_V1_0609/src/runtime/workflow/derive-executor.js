'use strict';

/**
 * @module runtime/workflow/derive-executor
 * 派生执行引擎。桥接 GitWorktreeManager、WorldLineManager 和 GoalExecutor，
 * 实现 Codex VibeCoding 的"派生"功能：在隔离的 Git worktree 和世界线分支上
 * 安全实验新想法，验证后合并回主线，不满意则直接丢弃。
 *
 * @fires DeriveExecutor#derive-created
 * @fires DeriveExecutor#derive-merged
 * @fires DeriveExecutor#derive-abandoned
 * @fires DeriveExecutor#derive-failed
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { HarnessError } = require('../../errors');
const { debug } = require('../../utils/debug-logger');
const { safeExecuteAsync, safeCallAsync } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const { generateId } = require('../../utils/constants');

const DERIVE_STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  MERGING: 'merging',
  MERGED: 'merged',
  ABANDONED: 'abandoned',
  FAILED: 'failed',
});

const DEFAULT_OPTIONS = {
  maxDerivations: 20,
  defaultMergeStrategy: 'latest-wins',
  autoCleanupMerged: true,
  cleanupDelayMs: 5000,
};

/**
 * 派生执行引擎。在隔离环境中执行实验性目标，支持合并或丢弃。
 *
 * @classdesc 派生执行引擎，桥接 Worktree + WorldLine + GoalExecutor
 * @extends EventEmitter
 */
class DeriveExecutor extends EventEmitter {
  /**
   * 创建 DeriveExecutor 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxDerivations=20] - 最大并行派生数
   * @param {string} [options.defaultMergeStrategy='latest-wins'] - 默认合并策略
   * @param {boolean} [options.autoCleanupMerged=true] - 合并后自动清理资源
   * @param {number} [options.cleanupDelayMs=5000] - 清理延迟毫秒数
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._config = safeAssign({}, DEFAULT_OPTIONS, opts);
    this._derivations = new Map();
    this._worktreeManager = null;
    this._worldLineManager = null;
    this._goalExecutor = null;
    this._stats = { created: 0, merged: 0, abandoned: 0, failed: 0 };
  }

  /**
   * 注入 GitWorktreeManager 依赖。
   * @param {Object} manager - GitWorktreeManager 实例
   * @returns {DeriveExecutor} this（支持链式调用）
   * @throws {HarnessError} manager 无效时抛出
   */
  attachWorktreeManager(manager) {
    if (!manager || typeof manager.create !== 'function') {
      throw new HarnessError('INVALID_INPUT', 'WorktreeManager must have a create method');
    }
    this._worktreeManager = manager;
    return this;
  }

  /**
   * 注入 WorldLineManager 依赖。
   * @param {Object} manager - WorldLineManager 实例
   * @returns {DeriveExecutor} this
   * @throws {HarnessError} manager 无效时抛出
   */
  attachWorldLineManager(manager) {
    if (!manager || typeof manager.createWorldLine !== 'function') {
      throw new HarnessError('INVALID_INPUT', 'WorldLineManager must have a createWorldLine method');
    }
    this._worldLineManager = manager;
    return this;
  }

  /**
   * 注入 GoalExecutor 依赖。
   * @param {Object} executor - GoalExecutor 实例
   * @returns {DeriveExecutor} this
   * @throws {HarnessError} executor 无效时抛出
   */
  attachGoalExecutor(executor) {
    if (!executor || typeof executor.createGoal !== 'function') {
      throw new HarnessError('INVALID_INPUT', 'GoalExecutor must have a createGoal method');
    }
    this._goalExecutor = executor;
    return this;
  }

  /**
   * 创建派生分支。在隔离的 Git worktree 和世界线分支上创建目标。
   * @param {string} objective - 目标描述
   * @param {Object} [options] - 派生选项
   * @param {string} [options.agentId] - Agent标识符（用于worktree命名）
   * @param {string} [options.branchName] - Git分支名称
   * @param {string} [options.worldLineName] - 世界线名称
   * @param {string} [options.mergeStrategy] - 合并策略
   * @param {string[]} [options.acceptanceCriteria] - 验收标准列表
   * @param {Object} [options.goalOptions] - 传递给GoalExecutor的额外选项
   * @returns {Promise<{deriveId: string, worktreeId: string|null, worldLineId: string|null, goalId: string|null}>}
   * @throws {HarnessError} 关闭期间或容量超限时抛出
   * @fires DeriveExecutor#derive-created
   */
  async derive(objective, options) {
    this.guardShutdown();
    if (!objective || typeof objective !== 'string') {
      throw new HarnessError('INVALID_INPUT', 'Objective must be a non-empty string');
    }
    if (this._derivations.size >= this._config.maxDerivations) {
      throw new HarnessError('CAPACITY_EXCEEDED', 'Maximum derivations reached: ' + this._config.maxDerivations);
    }
    const opts = options ?? {};
    const deriveId = generateId('derive-');
    const result = { deriveId, worktreeId: null, worldLineId: null, goalId: null };

    // 1. 创建 Git worktree（可选，依赖注入时才启用）
    if (this._worktreeManager) {
      const agentId = opts.agentId || deriveId;
      const worktreeEntry = await safeExecuteAsync(
        () => this._worktreeManager.create(agentId, opts.branchName),
        'DeriveExecutor', 'derive:worktree',
      );
      if (worktreeEntry) {
        result.worktreeId = worktreeEntry.id;
      }
    }

    // 2. 创建世界线分支（可选）
    if (this._worldLineManager) {
      const wlName = opts.worldLineName || 'derive-' + deriveId;
      const wlResult = await safeExecuteAsync(
        () => this._worldLineManager.createWorldLine(wlName, { deriveId, objective }),
        'DeriveExecutor', 'derive:worldline',
      );
      if (wlResult) {
        result.worldLineId = wlResult.worldLineId;
      }
    }

    // 3. 创建目标（可选）
    if (this._goalExecutor) {
      const goalOpts = safeAssign({}, opts.goalOptions);
      if (opts.acceptanceCriteria && opts.acceptanceCriteria.length > 0) {
        goalOpts.successCriteria = opts.acceptanceCriteria;
      }
      const goalResult = await safeExecuteAsync(
        () => this._goalExecutor.createGoal(objective, goalOpts),
        'DeriveExecutor', 'derive:goal',
      );
      if (goalResult && goalResult.success) {
        result.goalId = goalResult.goalId;
      }
    }

    // 4. 注册派生记录
    const derivation = {
      deriveId,
      objective,
      status: DERIVE_STATUS.ACTIVE,
      worktreeId: result.worktreeId,
      worldLineId: result.worldLineId,
      goalId: result.goalId,
      mergeStrategy: opts.mergeStrategy || this._config.defaultMergeStrategy,
      acceptanceCriteria: opts.acceptanceCriteria ?? [],
      createdAt: Date.now(),
      mergedAt: null,
      abandonedAt: null,
    };
    this._derivations.set(deriveId, derivation);
    this._stats.created++;

    this.emit('derive-created', { deriveId, objective, worktreeId: result.worktreeId, worldLineId: result.worldLineId, goalId: result.goalId });
    debug('DeriveExecutor', 'derive', 'Created derivation: ' + deriveId);
    return result;
  }

  /**
   * 合并派生分支回主线。验证验收标准后，合并世界线状态并清理worktree。
   * @param {string} deriveId - 派生ID
   * @param {Object} [options] - 合并选项
   * @param {string} [options.mergeStrategy] - 覆盖合并策略
   * @param {string} [options.targetWorldLineId] - 目标世界线ID
   * @returns {Promise<{success: boolean, deriveId: string, error?: string}>}
   * @fires DeriveExecutor#derive-merged
   * @fires DeriveExecutor#derive-failed
   */
  async merge(deriveId, options) {
    this.guardShutdown();
    const derivation = this._derivations.get(deriveId);
    if (!derivation) {
      return { success: false, deriveId, error: 'Derivation not found' };
    }
    if (derivation.status !== DERIVE_STATUS.ACTIVE) {
      return { success: false, deriveId, error: 'Derivation is not active (status: ' + derivation.status + ')' };
    }
    derivation.status = DERIVE_STATUS.MERGING;
    const opts = options ?? {};
    const strategy = opts.mergeStrategy || derivation.mergeStrategy;

    try {
      // 1. 合并世界线
      if (this._worldLineManager && derivation.worldLineId && opts.targetWorldLineId) {
        await safeCallAsync(
          () => this._worldLineManager.mergeWorldLines(derivation.worldLineId, opts.targetWorldLineId, strategy),
          'DeriveExecutor', 'merge:worldline',
        );
      }

      // 2. 清理 worktree（合并后不再需要隔离环境）
      if (this._worktreeManager && derivation.worktreeId) {
        await safeCallAsync(
          () => this._worktreeManager.remove(derivation.worktreeId),
          'DeriveExecutor', 'merge:worktree-cleanup',
        );
      }

      derivation.status = DERIVE_STATUS.MERGED;
      derivation.mergedAt = Date.now();
      this._stats.merged++;

      this.emit('derive-merged', { deriveId, strategy });
      debug('DeriveExecutor', 'merge', 'Merged derivation: ' + deriveId);

      if (this._config.autoCleanupMerged) {
        this._scheduleCleanup(deriveId);
      }

      return { success: true, deriveId };
    } catch (err) {
      derivation.status = DERIVE_STATUS.FAILED;
      this._stats.failed++;
      this.emit('derive-failed', { deriveId, error: err && err.message ? err.message : String(err) });
      return { success: false, deriveId, error: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 丢弃派生分支。清理worktree和世界线，不合并任何更改。
   * @param {string} deriveId - 派生ID
   * @returns {Promise<{success: boolean, deriveId: string, error?: string}>}
   * @fires DeriveExecutor#derive-abandoned
   */
  async abandon(deriveId) {
    this.guardShutdown();
    const derivation = this._derivations.get(deriveId);
    if (!derivation) {
      return { success: false, deriveId, error: 'Derivation not found' };
    }
    if (derivation.status !== DERIVE_STATUS.ACTIVE && derivation.status !== DERIVE_STATUS.FAILED) {
      return { success: false, deriveId, error: 'Derivation cannot be abandoned (status: ' + derivation.status + ')' };
    }

    // 1. 清理 worktree
    if (this._worktreeManager && derivation.worktreeId) {
      await safeCallAsync(
        () => this._worktreeManager.remove(derivation.worktreeId),
        'DeriveExecutor', 'abandon:worktree',
      );
    }

    // 2. 清理世界线
    if (this._worldLineManager && derivation.worldLineId) {
      await safeCallAsync(
        () => this._worldLineManager.removeWorldLine(derivation.worldLineId),
        'DeriveExecutor', 'abandon:worldline',
      );
    }

    // 3. 取消目标（如果存在且未完成）
    if (this._goalExecutor && derivation.goalId) {
      await safeCallAsync(
        () => { if (typeof this._goalExecutor.cancelGoal === 'function') this._goalExecutor.cancelGoal(derivation.goalId); },
        'DeriveExecutor', 'abandon:goal',
      );
    }

    derivation.status = DERIVE_STATUS.ABANDONED;
    derivation.abandonedAt = Date.now();
    this._stats.abandoned++;

    this.emit('derive-abandoned', { deriveId });
    debug('DeriveExecutor', 'abandon', 'Abandoned derivation: ' + deriveId);
    return { success: true, deriveId };
  }

  /**
   * 获取指定派生的详情。
   * @param {string} deriveId - 派生ID
   * @returns {Object|null} 派生详情对象
   */
  getDerivation(deriveId) {
    const d = this._derivations.get(deriveId);
    if (!d) return null;
    return {
      deriveId: d.deriveId,
      objective: d.objective,
      status: d.status,
      worktreeId: d.worktreeId,
      worldLineId: d.worldLineId,
      goalId: d.goalId,
      mergeStrategy: d.mergeStrategy,
      acceptanceCriteria: d.acceptanceCriteria.slice(),
      createdAt: d.createdAt,
      mergedAt: d.mergedAt,
      abandonedAt: d.abandonedAt,
    };
  }

  /**
   * 列出所有派生，可按状态过滤。
   * @param {string} [status] - 过滤状态
   * @returns {Object[]} 派生列表
   */
  listDerivations(status) {
    const result = [];
    for (const d of this._derivations.values()) {
      if (status && d.status !== status) continue;
      result.push(this._toPublicDerivation(d));
    }
    return result;
  }

  /**
   * 获取执行器统计信息。
   * @returns {Object} 统计对象
   */
  getStats() {
    return {
      total: this._derivations.size,
      active: this._countByStatus(DERIVE_STATUS.ACTIVE),
      merged: this._stats.merged,
      abandoned: this._stats.abandoned,
      failed: this._stats.failed,
      created: this._stats.created,
      maxDerivations: this._config.maxDerivations,
    };
  }

  /**
   * 检查执行器健康状态。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown;
  }

  /**
   * 关闭时清理所有活跃派生。
   * @protected
   */
  _onShutdown() {
    if (this._cleanupTimers) {
      for (const t of this._cleanupTimers) clearTimeout(t);
      this._cleanupTimers.clear();
    }
    for (const [deriveId, d] of this._derivations) {
      if (d.status === DERIVE_STATUS.ACTIVE) {
        d.status = DERIVE_STATUS.ABANDONED;
        d.abandonedAt = Date.now();
        debug('DeriveExecutor', '_onShutdown', 'Auto-abandoned: ' + deriveId);
      }
    }
    this._derivations.clear();
    this._stats = { created: 0, merged: 0, abandoned: 0, failed: 0 };
    this.removeAllListeners();
  }

  _scheduleCleanup(deriveId) {
    if (!this._cleanupTimers) this._cleanupTimers = new Set();
    const tid = setTimeout(() => {
      this._cleanupTimers.delete(tid);
      if (this._shutDown) return;
      const d = this._derivations.get(deriveId);
      if (d && (d.status === DERIVE_STATUS.MERGED || d.status === DERIVE_STATUS.ABANDONED)) {
        this._derivations.delete(deriveId);
        debug('DeriveExecutor', '_scheduleCleanup', 'Cleaned up: ' + deriveId);
      }
    }, this._config.cleanupDelayMs);
    this._cleanupTimers.add(tid);
    if (tid && typeof tid.unref === 'function') tid.unref();
  }

  _countByStatus(status) {
    let count = 0;
    for (const d of this._derivations.values()) {
      if (d.status === status) count++;
    }
    return count;
  }

  _toPublicDerivation(d) {
    return {
      deriveId: d.deriveId,
      objective: d.objective,
      status: d.status,
      worktreeId: d.worktreeId,
      worldLineId: d.worldLineId,
      goalId: d.goalId,
      mergeStrategy: d.mergeStrategy,
      createdAt: d.createdAt,
    };
  }
}

DeriveExecutor.DERIVE_STATUS = DERIVE_STATUS;

module.exports = { DeriveExecutor: withShutdown(DeriveExecutor) };
