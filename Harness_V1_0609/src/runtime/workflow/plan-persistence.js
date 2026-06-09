'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { validateProjectRoot, isNonEmptyString , HARNESS_DIR, JSON_EXT, generateId} = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');
const { mergeConfig } = require('../../utils/safe-assign');
const { writeAtomic, writeAtomicAsync } = require('../../utils/debounced-persister');
const { ensureDirSync, ensureDirAsync, readJsonDirSync, loadJsonAsync } = require('../../utils/fs-utils');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_MAX_PLANS = 50;
const DEFAULT_MAX_VERSIONS = 10;
const MAX_PLAN_LOCKS = 200;
const SAFE_PLAN_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * @module runtime/workflow/plan-persistence
 * @classdesc 计划持久化（PlanPersistence）。执行计划保存、恢复、版本追踪。
 * PlanPersistence — Execution plan persistence with version tracking and anti-drift injection
 * Manages plan lifecycle (create, update, load) with versioned snapshots, task status updates,
 * anti-drift context injection for goal adherence, disk-backed storage under .harness/workspace/plans/,
 * and memory-bounded caching with oldest-plan eviction.
 * @extends EventEmitter
 * @emits plan-created | plan-updated | task-status-updated
 */
class PlanPersistence extends EventEmitter {
  /**
   * Create a PlanPersistence instance.
   * @param {string} projectRoot - Project root directory path
   * @param {Object} [options] - Configuration options
   * @param {number} [options.maxPlans=50] - Maximum number of plans in memory
   * @param {number} [options.maxVersions=10] - Maximum number of version snapshots per plan
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'PlanPersistence');
    this.root = projectRoot;
    this._maxPlans = (options && options.maxPlans) ?? DEFAULT_MAX_PLANS;
    this._maxVersions = (options && options.maxVersions) ?? DEFAULT_MAX_VERSIONS;
    this._plansDir = path.join(projectRoot, HARNESS_DIR, 'workspace', 'plans');
    this._memoryStore = new Map();
    this._planLocks = new Map();
    this._stats = {
      created: 0,
      updated: 0,
      loaded: 0,
      injected: 0,
    };
  }

  /**
   * 创建执行计划并持久化到磁盘。自动生成planId，规范化任务列表。
   * @param {string} sessionId - 关联的会话ID
   * @param {Object} plan - 计划定义
   * @param {string} [plan.objective] - 计划目标
   * @param {string} [plan.strategy] - 执行策略
   * @param {Array<Object|string>} [plan.tasks] - 任务列表
   * @param {Array<string>} [plan.constraints] - 约束条件
   * @param {Array<string>} [plan.successCriteria] - 成功标准
   * @param {string} [plan.currentPhase] - 当前阶段
   * @returns {Object|null} 创建的计划对象，参数无效时返回null
   * @fires PlanPersistence#plan-created
   */
  createPlan(sessionId, plan) {
    this.guardShutdown();
    if (!sessionId || !plan) return null;

    const planId = generateId('plan-');
    const planData = {
      planId,
      sessionId,
      objective: plan.objective || '',
      strategy: plan.strategy || '',
      tasks: Array.isArray(plan.tasks) ? plan.tasks.map(t => this._normalizeTask(t)) : [],
      constraints: plan.constraints ?? [],
      successCriteria: plan.successCriteria ?? [],
      currentPhase: plan.currentPhase || 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      status: 'active',
    };

    this._memoryStore.set(planId, planData);
    this._evictOldestIfNeeded();
    this._persistPlan(planId, planData);
    this._stats.created++;
    this.emit('plan-created', { planId, sessionId });
    return planData;
  }

  /**
   * 更新执行计划。支持更新策略、任务、约束、成功标准、阶段和状态。
   * 每次更新自动递增版本号。
   * @param {string} planId - 计划ID
   * @param {Object} updates - 更新内容
   * @param {string} [updates.strategy] - 新策略
   * @param {Array} [updates.tasks] - 新任务列表
   * @param {Array<string>} [updates.constraints] - 新约束条件
   * @param {Array<string>} [updates.successCriteria] - 新成功标准
   * @param {string} [updates.currentPhase] - 新当前阶段
   * @param {string} [updates.status] - 新状态
   * @returns {Object|null} 更新后的计划对象，计划不存在时返回null
   * @fires PlanPersistence#plan-updated
   */
  updatePlan(planId, updates) {
    this.guardShutdown();
    if (!this._acquireLock(planId)) {
      this.emit('concurrent-update-rejected', { planId, operation: 'updatePlan' });
      return null;
    }
    try {
      const existing = this._memoryStore.get(planId);
      if (!existing) return null;

      const updated = mergeConfig(existing, {
        updatedAt: Date.now(),
        version: existing.version + 1,
      });

      if (updates.strategy !== undefined) updated.strategy = updates.strategy;
      if (updates.tasks !== undefined) updated.tasks = updates.tasks.map(t => this._normalizeTask(t));
      if (updates.constraints !== undefined) updated.constraints = updates.constraints;
      if (updates.successCriteria !== undefined) updated.successCriteria = updates.successCriteria;
      if (updates.currentPhase !== undefined) updated.currentPhase = updates.currentPhase;
      if (updates.status !== undefined) updated.status = updates.status;

      this._memoryStore.set(planId, updated);
      this._persistPlan(planId, updated);
      this._stats.updated++;
      this.emit('plan-updated', { planId, version: updated.version, status: updated.status });
      return updated;
    } finally {
      this._releaseLock(planId);
    }
  }

  /**
   * 更新计划中指定任务的状态和结果。
   * @param {string} planId - 计划ID
   * @param {number} taskIndex - 任务索引
   * @param {string} status - 新状态
   * @param {*} [result] - 任务结果
   * @returns {Object|null} 更新后的计划对象，计划或任务不存在时返回null
   * @fires PlanPersistence#task-status-updated
   */
  updateTaskStatus(planId, taskIndex, status, result) {
    this.guardShutdown();
    if (!this._acquireLock(planId)) {
      this.emit('concurrent-update-rejected', { planId, operation: 'updateTaskStatus' });
      return null;
    }
    try {
      const plan = this._memoryStore.get(planId);
      if (!plan || !plan.tasks[taskIndex]) return null;

      plan.tasks[taskIndex].status = status;
      if (result) plan.tasks[taskIndex].result = result;
      plan.updatedAt = Date.now();
      plan.version++;

      this._memoryStore.set(planId, plan);
      this._persistPlan(planId, plan);
      this.emit('task-status-updated', { planId, taskIndex, status });
      return plan;
    } finally {
      this._releaseLock(planId);
    }
  }

  /**
   * 异步加载计划。优先从内存缓存读取，缓存未命中时从磁盘加载。
   * @param {string} planId - 计划ID
   * @returns {Promise<Object|null>} 计划对象，不存在时返回null
   */
  async loadPlan(planId) {
    this.guardShutdown();
    if (!isNonEmptyString(planId) || !SAFE_PLAN_ID_RE.test(planId)) return null;
    const cached = this._memoryStore.get(planId);
    if (cached) {
      this._stats.loaded++;
      return JSON.parse(JSON.stringify(cached));
    }

    const filePath = path.join(this._plansDir, `${planId}${JSON_EXT}`);
    try {
      const plan = await loadJsonAsync(filePath);
      if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
      delete plan.__proto__;
      delete plan.constructor;
      delete plan.prototype;
      if (!Array.isArray(plan.tasks)) plan.tasks = [];
      if (typeof plan.version !== 'number') plan.version = 1;
      this._memoryStore.set(planId, plan);
      this._stats.loaded++;
      return JSON.parse(JSON.stringify(plan));
    } catch (err) {
      debug('PlanPersistence', 'loadPlan', err);
      return { _error: err.message || String(err) };
    }
  }

  /**
   * 获取指定会话的活跃计划。先查内存缓存，再查磁盘文件。
   * @param {string} sessionId - 会话ID
   * @returns {Object|null} 活跃计划对象，不存在时返回null
   */
  getActivePlan(sessionId) {
    for (const [, plan] of this._memoryStore) {
      if (plan.sessionId === sessionId && plan.status === 'active') {
        return JSON.parse(JSON.stringify(plan));
      }
    }

    const entries = readJsonDirSync(this._plansDir, { logLabel: 'PlanPersistence' });
    for (const { data: plan } of entries) {
      if (plan.sessionId === sessionId && plan.status === 'active') {
        this._memoryStore.set(plan.planId, plan);
        return JSON.parse(JSON.stringify(plan));
      }
    }

    return null;
  }

  /**
   * 注入防漂移上下文。将当前计划的目标、策略、任务进度、约束和成功标准
   * 格式化为Markdown文本，拼接到当前上下文前面。
   * @param {string} sessionId - 会话ID
   * @param {string|Object} currentContext - 当前上下文内容
   * @returns {string} 注入防漂移上下文后的完整文本
   */
  injectContext(sessionId, currentContext) {
    this.guardShutdown();
    const plan = this.getActivePlan(sessionId);
    if (!plan) return currentContext;

    this._stats.injected++;
    const injection = [
      '## \u5f53\u524d\u8ba1\u5212\uff08\u9632\u6f02\u79fb\u6ce8\u5165\uff09',
      '',
      `目标: ${plan.objective}`,
      `策略: ${plan.strategy}`,
      `当前阶段: ${plan.currentPhase}`,
      '',
      '### 任务进度',
    ];

    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i];
      const statusIcon = task.status === 'completed' ? '\u2705' : task.status === 'in_progress' ? '\ud83d\udd04' : '\u2b1c';
      injection.push(`${statusIcon} [${i + 1}] ${task.description} (${task.status})`);
    }

    if (plan.constraints.length > 0) {
      injection.push('');
      injection.push('### 约束条件');
      for (const c of plan.constraints) {
        injection.push(`- ${c}`);
      }
    }

    if (plan.successCriteria.length > 0) {
      injection.push('');
      injection.push('### 成功标准');
      for (const sc of plan.successCriteria) {
        injection.push(`- ${sc}`);
      }
    }

    injection.push('');
    injection.push('---');
    injection.push('');

    const contextStr = typeof currentContext === 'string' ? currentContext : (function() { try { return JSON.stringify(currentContext || ''); } catch (_e) { debug('PlanPersistence', 'stringify', _e && _e.message ? _e.message : String(_e)); return String(currentContext || ''); } })();
    return injection.join('\n') + contextStr;
  }

  /**
   * 获取计划的版本历史摘要列表，按版本号排序，最多返回maxVersions条。
   * @param {string} planId - 计划ID
   * @returns {Array<{version: number, updatedAt: number, status: string}>} 版本摘要列表
   */
  getPlanVersions(planId) {
    const versionsDir = path.join(this._plansDir, 'versions');
    const entries = readJsonDirSync(versionsDir, {
      filter: (f) => f.startsWith(planId) && f.endsWith(JSON_EXT),
      logLabel: 'PlanPersistence-versions',
    });

    const sorted = entries
      .sort((a, b) => a.fileName.localeCompare(b.fileName, 'en'))
      .slice(-this._maxVersions);

    return sorted.map(({ data: plan }) => {
      if (plan && plan.version) {
        return { version: plan.version, updatedAt: plan.updatedAt, status: plan.status };
      }
      return null;
    }).filter(Boolean);
  }

  /**
   * 获取持久化管理器的统计信息。
   * @returns {{ plansInMemory: number, created: number, updated: number, loaded: number, injected: number, maxPlans: number, maxVersions: number }}
   */
  getStats() {
    return {
      plansInMemory: this._memoryStore.size,
      created: this._stats.created,
      updated: this._stats.updated,
      loaded: this._stats.loaded,
      injected: this._stats.injected,
      maxPlans: this._maxPlans,
      maxVersions: this._maxVersions,
    };
  }

  _normalizeTask(task) {
    if (typeof task === 'string') {
      return { description: task, status: 'pending', agentId: null, result: null };
    }
    return {
      description: task.description || '',
      status: task.status || 'pending',
      agentId: task.agentId ?? null,
      result: task.result ?? null,
    };
  }

  _persistPlan(planId, planData) {
    if (!isNonEmptyString(planId) || !SAFE_PLAN_ID_RE.test(planId)) return;
    try {
      ensureDirSync(this._plansDir);

      const filePath = path.join(this._plansDir, `${planId}${JSON_EXT}`);
      writeAtomic(filePath, planData);

      this._persistVersion(planId, planData).catch(function(err) { debug('PlanPersistence', '_persistVersion', err); });
    } catch (err) {
      debug('PlanPersistence', '_persistPlan', err);
    }
  }

  async _persistVersion(planId, planData) {
    try {
      const versionsDir = path.join(this._plansDir, 'versions');
      await ensureDirAsync(versionsDir);

      const versionFile = path.join(versionsDir, `${planId}-v${planData.version}${JSON_EXT}`);
      await writeAtomicAsync(versionFile, planData);

      const files = (await fs.promises.readdir(versionsDir))
        .filter(f => f.startsWith(planId) && f.endsWith(JSON_EXT))
        .sort((a, b) => {
          const va = parseInt(a.match(/-v(\d+)\./)?.[1] || '0', 10);
          const vb = parseInt(b.match(/-v(\d+)\./)?.[1] || '0', 10);
          return va - vb;
        });
      while (files.length > this._maxVersions) {
        await fs.promises.unlink(path.join(versionsDir, files.shift()));
      }
    } catch (err) {
      debug('PlanPersistence', '_persistVersion', err);
    }
  }

  _evictOldestIfNeeded() {
    if (this._memoryStore.size >= this._maxPlans) {
      const oldestKey = this._memoryStore.keys().next().value;
      if (oldestKey) this._memoryStore.delete(oldestKey);
    }
  }

  _acquireLock(planId) {
    if (this._planLocks.has(planId)) return false;
    if (this._planLocks.size >= MAX_PLAN_LOCKS) {
      this._evictStaleLocks();
    }
    this._planLocks.set(planId, Date.now());
    return true;
  }

  _releaseLock(planId) {
    this._planLocks.delete(planId);
  }

  _evictStaleLocks() {
    const staleThreshold = Date.now() - 5 * 60 * 1000;
    const stale = [];
    for (const [key, timestamp] of this._planLocks) {
      if (typeof timestamp === 'number' && timestamp < staleThreshold) {
        stale.push(key);
      }
    }
    for (const key of stale) this._planLocks.delete(key);
  }

  _onShutdown() {
    this._memoryStore.clear();
    this._planLocks.clear();
    this.removeAllListeners();
  }

}

PlanPersistence = withShutdown(PlanPersistence);

PlanPersistence.DEFAULT_MAX_PLANS = DEFAULT_MAX_PLANS;
PlanPersistence.DEFAULT_MAX_VERSIONS = DEFAULT_MAX_VERSIONS;

module.exports = PlanPersistence;
