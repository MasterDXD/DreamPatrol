'use strict';

const { EventEmitter } = require('events');
const { generateId, DEFAULT_CONFIDENCE, DEFAULT_SUBAGENT_TIMEOUT_MS } = require('../../utils/constants');
const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { safeCall, errorMessage } = require('../../utils/safe-execute');
const { HarnessError, AgentError } = require('../../errors');
const AR = require('../context/autoregressive-context-schema');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { FOLD_STRATEGIES } = require('../context/context-fold-protocol');

const FALLBACK_MODEL = 'gpt-4o-mini';
const IsolatedContextManager = require('../context/isolated-context-manager');
const MAX_TASK_DESCRIPTION_LENGTH = 2048;
const MAX_SEARCH_QUERY_LENGTH = 1000;
const MAX_SERIALIZED_RESULT_SIZE = 65536;
const TRUNCATED_SUMMARY_LENGTH = 2048;

const SUBAGENT_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/**
 * Agent模式分类，融合自Claude Code的Subagent vs Agent team概念。
 *
 * WORKER('worker'): 临时工模式 - 单会话、隔离上下文、仅返回摘要。
 *   适用于独立研究、文件处理、代码搜索等辅助任务。
 *   特征：无状态、一次性、结果折叠、低上下文成本。
 *
 * TEAM('team'): 团队模式 - 多会话协作、共享上下文、持久化状态。
 *   适用于代码审查、架构评审、多角色协作等需要持续交互的任务。
 *   特征：有状态、多轮对话、上下文传递、高协作成本。
 *
 * 场景化建议（融合自Claude Code实战指南）：
 * - 若辅助任务输出刷爆对话窗口 → WORKER模式（隔离执行，仅返回摘要）
 * - 若需要多Agent持续协作完成复杂任务 → TEAM模式（共享上下文，多轮交互）
 */
const AGENT_MODE = {
  WORKER: 'worker',
  TEAM: 'team',
};

const DEFAULT_CONFIG = {
  maxConcurrent: 5,
  defaultTimeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
  maxSubagentsPerTask: 5,
  tokenBudgetPerSubagent: 50000,
  enableResultStreaming: true,
  enableAutoRetry: true,
  maxRetries: 1,
  enableWorktreeIsolation: false,
};

/**
 * @module runtime/agent/subagent-executor
 * @classdesc 子Agent执行器（SubagentExecutor）。生成、取消、重试管理，
 * 支持隔离上下文、Token预算追踪、并发限制、并行执行和验证重试。
 *
 * SubagentExecutor — Subagent lifecycle manager with isolated context and token budget tracking
 * Spawns subagents with isolated contexts, resolves models via RBAC/model-selector chain,
 * enforces concurrency limits and token budgets, supports parallel execution and verification-based
 * retry loops, caches search results, and tracks comprehensive execution statistics.
 * @extends EventEmitter
 * @emits subagent-spawned | subagent-completed | subagent-failed | subagent-cancelled | subagent-retry
 */
class SubagentExecutor extends EventEmitter {
  /**
   * 创建SubagentExecutor实例并初始化配置和统计。
   * @param {Object} [options] - 执行器配置
   * @param {number} [options.maxConcurrent=5] - 最大并发子Agent数
   * @param {number} [options.defaultTimeout] - 默认超时时间（毫秒）
   * @param {number} [options.maxSubagentsPerTask=5] - 单任务最大子Agent数
   * @param {number} [options.tokenBudgetPerSubagent=50000] - 每个子Agent的Token预算
   * @param {boolean} [options.enableResultStreaming=true] - 是否启用结果流式传输
   * @param {boolean} [options.enableAutoRetry=true] - 是否启用自动重试
   * @param {number} [options.maxRetries=1] - 最大重试次数
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._activeHandles = new Map();
    this._completedHandles = new Map();
    this._contextManager = null;
    this._ownsContextManager = false;
    this._sessionManager = null;
    this._modelSelector = null;
    this._rbacEnforcer = null;
    this._agentRuntime = null;
    this._worktreeManager = null;
    this._stats = {
      totalSpawned: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalCancelled: 0,
      totalRetries: 0,
      totalTokensUsed: 0,
      budgetExceeded: 0,
      modelSelections: 0,
      modelOverrides: 0,
    };
    this._maxCompletedHistory = 100;
    this._searchCache = new Map();
    this._searchCacheMaxSize = 100;
    this._searchCacheTtlMs = 5 * 60 * 1000;
  }

  /**
   * 附加会话管理器，用于Token预算追踪。
   * @param {Object} sessionManager - 会话管理器实例（需实现addTokenUsage方法）
   * @returns {SubagentExecutor} this（支持链式调用）
   */
  attachSessionManager(sessionManager) {
    if (sessionManager && typeof sessionManager.addTokenUsage === 'function') {
      this._sessionManager = sessionManager;
    }
    return this;
  }

  /**
   * 附加模型选择器，用于根据技能和上下文选择模型。
   * @param {Object} modelSelector - 模型选择器实例（需实现selectModel方法）
   * @returns {SubagentExecutor} this（支持链式调用）
   */
  attachModelSelector(modelSelector) {
    if (modelSelector && typeof modelSelector.selectModel === 'function') {
      this._modelSelector = modelSelector;
    }
    return this;
  }

  /**
   * 附加RBAC执行器，用于获取Agent定义的模型覆盖。
   * @param {Object} rbacEnforcer - RBAC执行器实例（需实现getAgentModel方法）
   * @returns {SubagentExecutor} this（支持链式调用）
   */
  attachRBACEnforcer(rbacEnforcer) {
    if (rbacEnforcer && typeof rbacEnforcer.getAgentModel === 'function') {
      this._rbacEnforcer = rbacEnforcer;
    }
    return this;
  }

  /**
   * 附加Agent运行时，用于注册子Agent到运行时管理。
   * @param {Object} agentRuntime - Agent运行时实例（需实现register方法）
   * @returns {SubagentExecutor} this（支持链式调用）
   */
  attachAgentRuntime(agentRuntime) {
    if (agentRuntime && typeof agentRuntime.register === 'function') {
      this._agentRuntime = agentRuntime;
    }
    return this;
  }

  /**
   * 附加工作树管理器，用于创建隔离Git工作树供子Agent并行工作。
   * @param {Object} worktreeManager - 工作树管理器实例，需实现create和remove方法
   * @returns {SubagentExecutor} 当前实例（支持链式调用）
   */
  attachWorktreeManager(worktreeManager) {
    if (worktreeManager && typeof worktreeManager.create === 'function' && typeof worktreeManager.remove === 'function') {
      this._worktreeManager = worktreeManager;
    }
    return this;
  }

  /**
   * 附加折叠协议，用于子Agent上下文的压缩和折叠策略。
   * @param {Object} foldProtocol - 折叠协议实例，定义上下文折叠策略
   */
  attachFoldProtocol(foldProtocol) {
    this._foldProtocol = foldProtocol;
  }

  /**
   * 附加上下文管理器，用于创建隔离上下文。传入后将不再自动创建内部管理器。
   * @param {Object} contextManager - 上下文管理器实例（需实现createIsolatedContext方法）
   * @returns {SubagentExecutor} this（支持链式调用）
   */
  attachContextManager(contextManager) {
    if (contextManager && typeof contextManager.createIsolatedContext === 'function') {
      this._contextManager = contextManager;
      this._ownsContextManager = false;
    }
    return this;
  }

  _ensureContextManager() {
    if (!this._contextManager) {
      this._contextManager = new IsolatedContextManager({
        maxContexts: this._config.maxConcurrent * 2,
      });
      this._ownsContextManager = true;
    }
    return this._contextManager;
  }

  _resolveModel(agentId, skillId, context) {
    if (this._rbacEnforcer) {
      const agentModel = this._rbacEnforcer.getAgentModel(agentId);
      if (agentModel) {
        this._stats.modelOverrides++;
        return { model: agentModel, source: 'agent-definition', tier: this._modelSelector ? (typeof this._modelSelector.getTier === 'function' ? this._modelSelector.getTier(agentModel) : 'standard') : 'standard' };
      }
    }

    if (this._modelSelector && skillId) {
      this._stats.modelSelections++;
      const selection = this._modelSelector.selectModel(skillId, context);
      if (selection && selection.model) {
        return { model: selection.model, source: selection.source, tier: selection.tier, reason: selection.reason };
      }
      debug('SubagentExecutor', 'resolveModel', 'selectModel returned invalid result, falling back to default');
    }

    return { model: this._config.defaultModel ?? FALLBACK_MODEL, source: 'default', tier: 'standard' };
  }

  _validateSpawn(task) {
    if (!task || typeof task !== 'object') return 'invalid_task';
    if (!task.description || typeof task.description !== 'string') {
      debug('SubagentExecutor', 'spawn', 'Task missing description');
      return 'missing_description';
    }
    if (task.description.length > MAX_TASK_DESCRIPTION_LENGTH) {
      debug('SubagentExecutor', 'spawn', 'Task description too long');
      return 'description_too_long';
    }
    if (this._activeHandles.size >= this._config.maxConcurrent) {
      this.emit('spawn-rejected', { reason: 'max_concurrent_reached', active: this._activeHandles.size });
      return 'max_concurrent';
    }
    if (this._sessionManager && task.sessionId) {
      const budget = this._sessionManager.checkBudget(task.sessionId);
      if (budget.exhausted) {
        this._stats.budgetExceeded++;
        this.emit('spawn-rejected', { reason: 'token_budget_exceeded', sessionId: task.sessionId });
        return 'budget_exceeded';
      }
    }
    return null;
  }

  /**
   * 生成子Agent并创建隔离上下文，返回操作句柄。
   * @param {Object} task - 任务描述对象（需包含description字段）
   * @param {Object} [agentConfig] - Agent配置
   * @param {string} [agentConfig.agentId='task-worker'] - Agent角色标识
   * @param {string} [agentConfig.skillId] - 技能标识
   * @param {number} [agentConfig.tokenBudget] - Token预算
   * @param {string[]} [agentConfig.constraints] - 约束条件
   * @param {string[]} [agentConfig.successCriteria] - 成功标准
   * @param {string} [agentConfig.mode='worker'] - Agent模式（worker=临时工, team=团队），融合自Claude Code
   * @returns {Promise<Object|null>} 子Agent操作句柄，验证失败时返回null
   */
  async spawn(task, agentConfig) {
    this.guardShutdown();
    const validationError = this._validateSpawn(task);
    if (validationError) return null;

    const handleId = generateId('sa-');
    const agentId = (agentConfig && agentConfig.agentId) || 'task-worker';
    const skillId = (agentConfig && agentConfig.skillId) ?? (task && task.skillId) ?? null;
    const modelInfo = this._resolveModel(agentId, skillId, { sessionId: task.sessionId });
    const context = this._createSubagentContext(task, agentConfig, agentId, handleId);
    if (!context || !context.contextId) return null;

    const handle = this._createHandle(handleId, context.contextId, agentId, task, agentConfig, modelInfo);
    try {
      if (this._config.enableWorktreeIsolation && this._worktreeManager) {
        const worktree = await this._worktreeManager.create(agentId);
        if (worktree) {
          handle._worktreeId = worktree.id;
        }
      }
    } catch (err) {
      safeCall(() => this._contextManager.releaseContext(context.contextId), 'SubagentExecutor', 'spawn:worktreeError');
      throw err;
    }
    this._activeHandles.set(handleId, handle);
    if (this._agentRuntime && this._agentRuntime.agents && !this._agentRuntime.agents.has(handleId)) {
      safeCall(() => {
        this._agentRuntime.register(handleId, {
          role: agentId,
          skills: skillId ? [skillId] : [],
          autoStart: false,
        });
      }, 'SubagentExecutor', 'spawn:registerAgent');
    }
    this._stats.totalSpawned++;
    this.emit('subagent-spawned', { handleId, agentId, taskDescription: handle.task.description || '', model: modelInfo.model, modelSource: modelInfo.source });

    return this._createHandleAPI(handle);
  }

  /**
   * 批量生成子Agent，受maxSubagentsPerTask限制。
   * @param {Object[]} tasks - 任务描述对象数组
   * @param {Object|Object[]} [agentConfigs] - 单个Agent配置或按任务索引的配置数组
   * @returns {Object[]} 成功生成的子Agent操作句柄数组
   */
  async spawnParallel(tasks, agentConfigs) {
    this.guardShutdown();
    if (!Array.isArray(tasks)) return [];
    const limit = Math.min(tasks.length, this._config.maxSubagentsPerTask);
    const handles = [];

    for (let i = 0; i < limit; i++) {
      const config = (agentConfigs && agentConfigs[i]) || (agentConfigs ? agentConfigs[0] : null);
      const handle = await this.spawn(tasks[i], config);
      if (handle) handles.push(handle);
    }

    return handles;
  }

  /**
   * 并行执行多个任务，等待所有子Agent完成并收集结果。
   * @param {Object[]} tasks - 任务描述对象数组
   * @param {Object|Object[]} [agentConfigs] - Agent配置
   * @param {Function} executeFn - 执行函数，接收(taskWithContext, handle)参数
   * @returns {Promise<Object>} 执行结果 {results, errors, allSettled}
   */
  async executeParallel(tasks, agentConfigs, executeFn) {
    this.guardShutdown();
    let handles;
    try {
      handles = await this.spawnParallel(tasks, agentConfigs);
    } catch (err) {
      debug('SubagentExecutor', 'executeParallel', err && err.message ? err.message : String(err));
      return { results: [], errors: [err], allSettled: [] };
    }
    if (handles.length === 0) return { results: [], errors: [], allSettled: [] };

    const promises = handles.map(handle =>
      this._executeHandle(handle, executeFn),
    );

    const settled = await Promise.allSettled(promises);

    const results = [];
    const errors = [];
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        results.push(entry.value);
      } else {
        errors.push(entry.reason);
      }
    }

    return { results, errors, allSettled: settled };
  }

  /**
   * 带验证的执行循环，执行后验证结果，失败时自动重试。
   * @param {Object} task - 任务描述对象
   * @param {Object} [agentConfig] - Agent配置
   * @param {Function} executeFn - 执行函数
   * @param {Function} [verifyFn] - 验证函数，接收(output, task)返回{passed, feedback}
   * @returns {Promise<Object>} 执行结果 {success, result?, verifyResult?, error?, iteration, reason?}
   */
  async executeWithVerification(task, agentConfig, executeFn, verifyFn) {
    this.guardShutdown();
    let currentOutput = null;
    let iteration = 0;
    const maxIterations = this._config.enableAutoRetry ? this._config.maxRetries + 1 : 1;

    while (iteration < maxIterations) {
      iteration++;
      let handle;
      try {
        handle = await this.spawn(task, agentConfig);
      } catch (spawnErr) {
        debug('SubagentExecutor', 'executeWithVerification', 'spawn failed: ' + (spawnErr && spawnErr.message ? spawnErr.message : String(spawnErr)));
        return { success: false, error: 'Failed to spawn subagent: ' + (spawnErr && spawnErr.message ? spawnErr.message : String(spawnErr)), iteration };
      }
      if (!handle) return { success: false, error: 'Failed to spawn subagent', iteration };

      let result;
      try {
        result = await this._executeHandle(handle, executeFn, currentOutput);
      } catch (err) {
        return { success: false, error: errorMessage(err), iteration };
      }
      if (!result.success) {
        return { success: false, error: result.error, iteration };
      }

      currentOutput = result.result;

      if (verifyFn) {
        const verifyResult = verifyFn(currentOutput, task);
        if (verifyResult.passed) {
          return { success: true, result: currentOutput, verifyResult, iteration };
        }
        if (iteration < maxIterations) {
          this._stats.totalRetries++;
          this.emit('subagent-retry', { handleId: handle.handleId, iteration, feedback: verifyResult.feedback });
        } else {
          return { success: false, result: currentOutput, verifyResult, iteration, reason: 'verification_failed' };
        }
      } else {
        return { success: true, result: currentOutput, iteration };
      }
    }

    return { success: false, error: 'Max iterations reached', iteration };
  }

  /**
   * 取消指定子Agent的执行，中止超时和AbortController。
   * @param {string} handleId - 子Agent句柄标识
   * @returns {boolean} 是否成功取消
   */
  cancel(handleId) {
    this.guardShutdown();
    const handle = this._activeHandles.get(handleId);
    if (!handle) return false;

    if (handle.status === SUBAGENT_STATUS.COMPLETED ||
        handle.status === SUBAGENT_STATUS.FAILED ||
        handle.status === SUBAGENT_STATUS.CANCELLED) {
      return false;
    }

    handle.status = SUBAGENT_STATUS.CANCELLED;
    handle.completedAt = Date.now();
    if (handle._timeoutId) {
      clearTimeout(handle._timeoutId);
      handle._timeoutId = null;
    }
    if (handle._abortController && !handle._abortController.signal.aborted) {
      safeCall(() => handle._abortController.abort(), 'SubagentExecutor', 'cancel:abort');
      handle._abortController = null;
    }
    if (handle._reject) {
      safeCall(() => handle._reject(new HarnessError('SHUTDOWN_IN_PROGRESS', 'Subagent cancelled')), 'SubagentExecutor', 'cancel:reject');
      handle._reject = null;
      handle._resolve = null;
    }

    this._moveToCompleted(handleId);
    this._stats.totalCancelled++;
    this.emit('subagent-cancelled', { handleId, agentId: handle.agentId });
    return true;
  }

  /**
   * 取消所有活跃的子Agent。
   * @returns {number} 成功取消的数量
   */
  cancelAll() {
    const ids = Array.from(this._activeHandles.keys());
    let cancelled = 0;
    for (const id of ids) {
      if (this.cancel(id)) cancelled++;
    }
    return cancelled;
  }

  /**
   * 以团队模式生成子Agent，融合自Claude Code的Agent team概念。
   * 团队模式的子Agent具有共享上下文、持久化状态和多轮交互能力。
   * 与临时工模式（默认spawn）的区别：
   * - 临时工：单会话、隔离上下文、仅返回摘要、低上下文成本
   * - 团队：多会话协作、共享上下文、持久化状态、高协作成本
   *
   * @param {Object} task - 任务描述对象（需包含description字段）
   * @param {Object} [agentConfig] - Agent配置（mode自动设为team）
   * @returns {Promise<Object|null>} 子Agent操作句柄，验证失败时返回null
   */
  async spawnTeam(task, agentConfig) {
    const teamConfig = mergeConfig(agentConfig ?? {}, { mode: AGENT_MODE.TEAM });
    return this.spawn(task, teamConfig);
  }

  /**
   * 按Agent模式获取句柄列表。融合自Claude Code的Subagent vs Agent team概念。
   * @param {string} mode - Agent模式（'worker' 或 'team'）
   * @returns {Array<Object>} 匹配模式的脱敏句柄列表
   */
  getHandlesByMode(mode) {
    const result = [];
    for (const [, handle] of this._activeHandles) {
      if (handle.mode === mode) {
        result.push(this._sanitizeHandle(handle));
      }
    }
    for (const [, handle] of this._completedHandles) {
      if (handle.mode === mode) {
        result.push(this._sanitizeHandle(handle));
      }
    }
    return result;
  }

  /**
   * 获取指定句柄的子Agent状态信息（脱敏后）。
   * @param {string} handleId - 子Agent句柄标识
   * @returns {Object|null} 句柄状态信息，不存在时返回null
   */
  getHandle(handleId) {
    const active = this._activeHandles.get(handleId);
    if (active) return this._sanitizeHandle(active);
    const completed = this._completedHandles.get(handleId);
    if (completed) return this._sanitizeHandle(completed);
    return null;
  }

  /**
   * 获取所有活跃子Agent的脱敏状态信息。
   * @returns {Object[]} 活跃句柄状态数组
   */
  getActiveHandles() {
    const handles = [];
    for (const [, h] of this._activeHandles) {
      handles.push(this._sanitizeHandle(h));
    }
    return handles;
  }

  _createSubagentContext(task, agentConfig, agentId) {
    try {
      const toolSet = (agentConfig && agentConfig.toolSet) ?? null;
      const constraints = (agentConfig && agentConfig.constraints) ?? [];
      const successCriteria = (agentConfig && agentConfig.successCriteria) ?? [];
      return this._ensureContextManager().createIsolatedContext({
        taskDescription: task.description || task.goal || 'Subagent task',
        agentId,
        toolSet,
        parentSessionId: task.sessionId ?? null,
        injectedContext: task.context || '',
        constraints,
        successCriteria,
      });
    } catch (err) {
      debug('SubagentExecutor', 'createContext', err);
      return { _error: err.message || String(err) };
    }
  }

  _createHandle(handleId, contextId, agentId, task, agentConfig, modelInfo) {
    const tokenBudget = (agentConfig && agentConfig.tokenBudget) ?? this._config.tokenBudgetPerSubagent;
    const mode = (agentConfig && agentConfig.mode === AGENT_MODE.TEAM) ? AGENT_MODE.TEAM : AGENT_MODE.WORKER;
    return {
      handleId,
      contextId,
      agentId,
      mode,
      task: mergeConfig(task, { _subagentHandleId: handleId }),
      status: SUBAGENT_STATUS.PENDING,
      result: null,
      error: null,
      tokenBudget,
      tokensUsed: 0,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      modelInfo: modelInfo || { model: FALLBACK_MODEL, source: 'default', tier: 'standard' },
      _timeoutId: null,
      _resolve: null,
      _reject: null,
    };
  }

  /**
   * 缓存搜索结果，支持TTL过期和容量淘汰。
   * @param {string} query - 搜索查询字符串
   * @param {*} result - 搜索结果
   * @returns {void}
   */
  cacheSearchResult(query, result) {
    if (!query || !result) return;
    if (typeof query !== 'string' || query.length > MAX_SEARCH_QUERY_LENGTH) return;
    this._evictExpiredSearchCache();
    if (this._searchCache.size >= this._searchCacheMaxSize) {
      const oldestKey = this._searchCache.keys().next().value;
      this._searchCache.delete(oldestKey);
    }
    this._searchCache.set(query, { result, cachedAt: Date.now() });
  }

  /**
   * 获取缓存的搜索结果，过期时自动清除。
   * @param {string} query - 搜索查询字符串
   * @returns {*|null} 缓存的搜索结果，不存在或已过期时返回null
   */
  getCachedSearchResult(query) {
    if (!query || typeof query !== 'string' || query.length > MAX_SEARCH_QUERY_LENGTH) return null;
    const entry = this._searchCache.get(query);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this._searchCacheTtlMs) {
      this._searchCache.delete(query);
      return null;
    }
    return entry.result;
  }

  _evictExpiredSearchCache() {
    const now = Date.now();
    const expiredKeys = [];
    for (const [key, entry] of this._searchCache) {
      if (now - entry.cachedAt > this._searchCacheTtlMs) {
        expiredKeys.push(key);
      }
    }
    for (const key of expiredKeys) {
      this._searchCache.delete(key);
    }
  }

  /**
   * 获取执行器的统计信息。
   * @returns {Object} 统计数据 {totalSpawned, totalCompleted, totalFailed, totalCancelled, totalRetries, totalTokensUsed, budgetExceeded, modelSelections, modelOverrides, activeHandles, completedHandles, maxConcurrent, tokenBudgetPerSubagent, successRate, avgTokensPerSubagent}
   */
  getStats() {
    return {
      totalSpawned: this._stats.totalSpawned,
      totalCompleted: this._stats.totalCompleted,
      totalFailed: this._stats.totalFailed,
      totalCancelled: this._stats.totalCancelled,
      totalRetries: this._stats.totalRetries,
      totalTokensUsed: this._stats.totalTokensUsed,
      budgetExceeded: this._stats.budgetExceeded,
      modelSelections: this._stats.modelSelections,
      modelOverrides: this._stats.modelOverrides,
      activeHandles: this._activeHandles.size,
      completedHandles: this._completedHandles.size,
      maxConcurrent: this._config.maxConcurrent,
      tokenBudgetPerSubagent: this._config.tokenBudgetPerSubagent,
      successRate: this._stats.totalSpawned > 0
        ? this._stats.totalCompleted / this._stats.totalSpawned : 0,
      avgTokensPerSubagent: this._stats.totalCompleted > 0
        ? Math.round(this._stats.totalTokensUsed / this._stats.totalCompleted) : 0,
    };
  }

  /**
   * 获取Token预算使用报告，包含每个活跃子Agent的预算详情。
   * @returns {Object} 预算报告 {totalTokensUsed, budgetExceeded, defaultBudgetPerSubagent, activeBudgets, activeTotalBudget, activeTotalUsed}
   */
  getTokenBudgetReport() {
    const activeBudgets = [];
    for (const [, handle] of this._activeHandles) {
      activeBudgets.push({
        handleId: handle.handleId,
        agentId: handle.agentId,
        budget: handle.tokenBudget,
        used: handle.tokensUsed,
        remaining: handle.tokenBudget - handle.tokensUsed,
        utilization: handle.tokenBudget > 0 ? handle.tokensUsed / handle.tokenBudget : 0,
      });
    }
    return {
      totalTokensUsed: this._stats.totalTokensUsed,
      budgetExceeded: this._stats.budgetExceeded,
      defaultBudgetPerSubagent: this._config.tokenBudgetPerSubagent,
      activeBudgets,
      activeTotalBudget: activeBudgets.reduce((sum, b) => sum + b.budget, 0),
      activeTotalUsed: activeBudgets.reduce((sum, b) => sum + b.used, 0),
    };
  }

  async _executeHandle(handleAPI, executeFn, previousOutput) {
    const handle = this._activeHandles.get(handleAPI.handleId);
    if (!handle) return { success: false, error: 'Handle not found' };

    handle.status = SUBAGENT_STATUS.RUNNING;
    handle.startedAt = Date.now();
    const abortController = new AbortController();
    handle._abortController = abortController;
    this.emit('subagent-started', { handleId: handle.handleId, agentId: handle.agentId });

    const timeout = (handle.task && handle.task.timeout) ?? this._config.defaultTimeout;
    let settled = false;

    const timeoutPromise = new Promise((_, reject) => {
      handle._timeoutId = setTimeout(() => {
        if (this._shutDown) return;
        if (settled) return;
        settled = true;
        handle.status = SUBAGENT_STATUS.FAILED;
        handle.error = 'Execution timeout';
        handle.completedAt = Date.now();
        if (!abortController.signal.aborted) abortController.abort();
        reject(new AgentError('AGENT_TIMEOUT', `Subagent ${handle.handleId} timeout after ${timeout}ms`));
      }, timeout);
      if (handle._timeoutId && typeof handle._timeoutId.unref === 'function') handle._timeoutId.unref();
    });

    timeoutPromise.catch(function(err) { debug('SubagentExecutor', 'timeoutPromise', err); });

    const executePromise = new Promise((resolve, reject) => {
      handle._resolve = resolve;
      handle._reject = reject;

      if (executeFn && typeof executeFn === 'function') {
        const taskWithContext = mergeConfig(handle.task, {
          _isolatedContextId: handle.contextId,
          _agentId: handle.agentId,
          _tokenBudget: handle.tokenBudget,
          _model: handle.modelInfo.model,
          _modelSource: handle.modelInfo.source,
          _modelTier: handle.modelInfo.tier,
          _signal: abortController.signal,
          _worktreeId: handle._worktreeId ?? null,
        });
        if (previousOutput != null) {
          AR.inject(taskWithContext, {
            [AR.FIELDS.PREVIOUS_OUTPUT]: previousOutput,
            [AR.FIELDS.SOURCE]: AR.SOURCE_IDS.REFINEMENT,
          });
        }

        try {
          const result = executeFn(taskWithContext, handle);
          if (result && typeof result.then === 'function') {
            result.then((r) => {
              if (settled) { resolve(r); return; }
              settled = true;
              resolve(r);
            }).catch((e) => {
              if (settled) { safeCall(() => reject(e), 'SubagentExecutor', 'lateReject'); return; }
              settled = true;
              safeCall(() => reject(e), 'SubagentExecutor', 'rejectError');
            });
          } else {
            if (!settled) {
              settled = true;
              resolve(result);
            }
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
      } else {
        settled = true;
        resolve({ output: null, summary: 'No execute function provided' });
      }
    });

    try {
      const result = await Promise.race([executePromise.catch(function(e) { return { _timeoutFallback: true, error: e }; }), timeoutPromise]);
      if (handle._timeoutId) { clearTimeout(handle._timeoutId); handle._timeoutId = null; }
      return this._handleSuccess(handle, result);
    } catch (err) {
      if (handle._timeoutId) { clearTimeout(handle._timeoutId); handle._timeoutId = null; }
      return this._handleFailure(handle, err);
    }
  }

  _reportTokenUsage(handle) {
    if (!this._sessionManager || !handle.task.sessionId) return;
    safeCall(function() {
      this._sessionManager.addTokenUsage(handle.task.sessionId, handle.tokensUsed);
    }.bind(this), 'SubagentExecutor', '_handleSuccess:tokenUsage');
  }

  _submitContextResult(handle, result) {
    if (!this._contextManager || !handle.contextId) return;
    safeCall(function() {
      this._contextManager.submitResult(handle.contextId, {
        output: result,
        confidence: (result && result.confidence !== undefined) ? result.confidence : DEFAULT_CONFIDENCE,
        evidence: (result && result.evidence) ?? [],
      });
    }.bind(this), 'SubagentExecutor', '_handleSuccess:submitResult');
  }

  _handleSuccess(handle, result) {
    if (handle._timeoutId) clearTimeout(handle._timeoutId);
    if (handle.status === SUBAGENT_STATUS.CANCELLED) {
      handle._resolve = null;
      handle._reject = null;
      return { success: false, error: 'Subagent already cancelled', handleId: handle.handleId };
    }
    // 如果result是catch转换的error对象，走failure路径
    if (result && result._timeoutFallback) {
      return this._handleFailure(handle, result.error);
    }
    handle._resolve = null;
    handle._reject = null;
    handle.status = SUBAGENT_STATUS.COMPLETED;
    handle.result = result;
    handle.completedAt = Date.now();
    handle.tokensUsed = (typeof (result && result.tokenUsage) === 'number' && Number.isFinite(result.tokenUsage)) ? result.tokenUsage : 0;
    this._stats.totalCompleted++;
    this._stats.totalTokensUsed += handle.tokensUsed;

    this._reportTokenUsage(handle);
    this._submitContextResult(handle, result);

    this._moveToCompleted(handle.handleId);
    this.emit('subagent-completed', {
      handleId: handle.handleId, agentId: handle.agentId,
      duration: handle.completedAt - handle.startedAt, tokensUsed: handle.tokensUsed,
      hadError: false, recovered: false,
      toolCalls: (typeof (result && result.toolCalls) === 'number' && Number.isFinite(result.toolCalls)) ? result.toolCalls : 0,
      performanceInsight: (result && result.performanceInsight) ?? false,
      summary: (result && result.summary) || '',
    });

    let foldedResult = result;
    if (this._foldProtocol && result) {
      const foldResult = this._foldProtocol.fold(result, FOLD_STRATEGIES.STRUCTURED_SUMMARY);
      if (foldResult.archiveId) {
        handle._archiveId = foldResult.archiveId;
      }
      foldedResult = foldResult.folded;
    }

    return { success: true, result: foldedResult, handleId: handle.handleId };
  }

  _handleFailure(handle, err) {
    if (handle._timeoutId) clearTimeout(handle._timeoutId);
    handle._resolve = null;
    handle._reject = null;
    if (handle.status !== SUBAGENT_STATUS.CANCELLED) {
      handle.status = SUBAGENT_STATUS.FAILED;
      handle.error = errorMessage(err);
      handle.completedAt = Date.now();
      this._stats.totalFailed++;

      if (this._contextManager && handle.contextId) {
        try {
          this._contextManager.submitResult(handle.contextId, {
            output: null, confidence: 0, evidence: [], error: handle.error,
          });
        } catch (_e) {
          debug('SubagentExecutor', '_handleFailure:submitResult', _e && _e.message ? _e.message : String(_e));
        }
      }

      this._moveToCompleted(handle.handleId);
      this.emit('subagent-failed', { handleId: handle.handleId, agentId: handle.agentId, error: handle.error });
    }
    return { success: false, error: handle.error, handleId: handle.handleId };
  }

  _createHandleAPI(handle) {
    const self = this;
    return {
      handleId: handle.handleId,
      contextId: handle.contextId,
      agentId: handle.agentId,
      mode: handle.mode,
      status: handle.status,
      get isPending() { return handle.status === SUBAGENT_STATUS.PENDING; },
      get isRunning() { return handle.status === SUBAGENT_STATUS.RUNNING; },
      get isCompleted() { return handle.status === SUBAGENT_STATUS.COMPLETED; },
      get isFailed() { return handle.status === SUBAGENT_STATUS.FAILED; },
      get isWorker() { return handle.mode === AGENT_MODE.WORKER; },
      get isTeam() { return handle.mode === AGENT_MODE.TEAM; },
      get result() { return handle.result; },
      get error() { return handle.error; },
      cancel() { return self.cancel(handle.handleId); },
      refresh() { return self.getHandle(handle.handleId); },
    };
  }

  _sanitizeHandle(handle) {
    return {
      handleId: handle.handleId,
      contextId: handle.contextId,
      agentId: handle.agentId,
      mode: handle.mode,
      status: handle.status,
      taskDescription: (handle.task && handle.task.description) || '',
      result: handle.result,
      error: handle.error,
      tokensUsed: handle.tokensUsed,
      createdAt: handle.createdAt,
      startedAt: handle.startedAt,
      completedAt: handle.completedAt,
      retryCount: handle.retryCount,
      model: handle.modelInfo ? handle.modelInfo.model : null,
      modelSource: handle.modelInfo ? handle.modelInfo.source : null,
      modelTier: handle.modelInfo ? handle.modelInfo.tier : null,
    };
  }

  _moveToCompleted(handleId) {
    const handle = this._activeHandles.get(handleId);
    if (!handle) return;

    this._activeHandles.delete(handleId);

    if (handle._worktreeId && this._worktreeManager) {
      safeCall(() => this._worktreeManager.remove(handle._worktreeId), 'SubagentExecutor', 'cleanupWorktree');
      handle._worktreeId = null;
    }

    if (handle.contextId && this._contextManager) {
      safeCall(() => this._contextManager.releaseContext(handle.contextId), 'SubagentExecutor', 'releaseContext');
      handle.contextId = null;
    }

    if (handle.result && typeof handle.result === 'object') {
      try {
        const serialized = JSON.stringify(handle.result);
        if (serialized.length > MAX_SERIALIZED_RESULT_SIZE) {
          handle.result = { _truncated: true, _summary: serialized.substring(0, TRUNCATED_SUMMARY_LENGTH), _originalSize: serialized.length };
        }
      } catch (e) { debug('SubagentExecutor', 'serializeResult', e); handle.result = { _truncated: true, _reason: 'serialization_failed' }; }
    }
    if (handle.task && handle.task.description && handle.task.description.length > MAX_TASK_DESCRIPTION_LENGTH) {
      handle.task = mergeConfig(handle.task, { description: handle.task.description.substring(0, MAX_TASK_DESCRIPTION_LENGTH) + '...[truncated]' });
    }

    this._completedHandles.set(handleId, handle);

    if (this._completedHandles.size > this._maxCompletedHistory) {
      const oldestKey = this._completedHandles.keys().next().value;
      this._completedHandles.delete(oldestKey);
    }
  }

  _onShutdown() {
    const ids = Array.from(this._activeHandles.keys());
    for (const id of ids) {
      const handle = this._activeHandles.get(id);
      if (handle) {
        handle.status = SUBAGENT_STATUS.CANCELLED;
        handle.completedAt = Date.now();
        if (handle._timeoutId) {
          clearTimeout(handle._timeoutId);
          handle._timeoutId = null;
        }
        if (handle._abortController && !handle._abortController.signal.aborted) {
          safeCall(() => handle._abortController.abort(), 'SubagentExecutor', 'shutdown:abort');
          handle._abortController = null;
        }
      }
    }

    for (const [_handleId, handle] of this._activeHandles) {
      if (handle._reject && handle.status !== 'completed' && handle.status !== 'failed') {
        try {
          handle._reject(new HarnessError('SHUTDOWN_IN_PROGRESS', 'Subagent cancelled during shutdown'));
        } catch (_e) { debug('SubagentExecutor', 'rejectAlreadySettled', _e && _e.message ? _e.message : String(_e)); }
      }
    }

    if (this._ownsContextManager && this._contextManager) {
      safeCall(() => this._contextManager.shutdown(), 'SubagentExecutor', 'shutdown');
    }

    this._activeHandles.clear();
    this._completedHandles.clear();
    this._searchCache.clear();
    this._sessionManager = null;
    this._modelSelector = null;
    this._rbacEnforcer = null;
    this._worktreeManager = null;
    this._agentRuntime = null;
    this.removeAllListeners();
  }

  /**
   * 检查执行器是否健康（活跃句柄数未达上限）。
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    return this._activeHandles.size < this._config.maxConcurrent;
  }
}

SubagentExecutor.STATUS = SUBAGENT_STATUS;
SubagentExecutor.DEFAULT_CONFIG = DEFAULT_CONFIG;
SubagentExecutor.AGENT_MODE = AGENT_MODE;

module.exports = withShutdown(SubagentExecutor);
