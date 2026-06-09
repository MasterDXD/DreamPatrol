'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

// ─── 常量 ──────────────────────────────────────────────────────────────────────

/** 熔断器状态 */
const CIRCUIT_STATE = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open',
};

/** 终止原因 */
const TERMINATION_REASON = {
  DOD_MET: 'dod-met',
  BUDGET_EXHAUSTED: 'budget-exhausted',
  NO_PROGRESS: 'no-progress',
  BOUNDARY_EXCEEDED: 'boundary-exceeded',
};

/** 上下文层级 */
const CONTEXT_LAYER = {
  LONG_TERM: 'long-term',
  PHASE: 'phase',
  IMMEDIATE: 'immediate',
};

// ─── IterationGuard ────────────────────────────────────────────────────────────

/**
 * @classdesc 统一迭代限制+熔断器框架 — 为多Agent系统提供迭代计数、回滚计数和熔断器保护。
 * 每个组件独立注册，拥有独立的迭代/回滚限制和熔断器状态机。
 * 熔断器状态转换：closed → open → half-open → closed。
 *
 * @extends EventEmitter
 * @emits 'iteration-exceeded' 迭代次数超限时触发
 * @emits 'rollback-exceeded' 回滚次数超限时触发
 * @emits 'circuit-open' 熔断器打开时触发
 * @emits 'circuit-half-open' 熔断器进入半开状态时触发
 * @emits 'circuit-closed' 熔断器关闭时触发
 */
class IterationGuard extends EventEmitter {
  /**
   * 创建 IterationGuard 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.defaultMaxIterations=10] - 默认最大迭代次数
   * @param {number} [options.defaultMaxRollbacks=3] - 默认最大回滚次数
   * @param {number} [options.circuitBreakerThreshold=5] - 熔断器触发阈值（连续失败次数）
   * @param {number} [options.circuitBreakerResetTimeout=30000] - 熔断器重置超时（毫秒）
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._defaultMaxIterations = typeof opts.defaultMaxIterations === 'number' && Number.isFinite(opts.defaultMaxIterations) && opts.defaultMaxIterations > 0
      ? opts.defaultMaxIterations
      : 10;
    this._defaultMaxRollbacks = typeof opts.defaultMaxRollbacks === 'number' && Number.isFinite(opts.defaultMaxRollbacks) && opts.defaultMaxRollbacks > 0
      ? opts.defaultMaxRollbacks
      : 3;
    this._circuitBreakerThreshold = typeof opts.circuitBreakerThreshold === 'number' && Number.isFinite(opts.circuitBreakerThreshold) && opts.circuitBreakerThreshold > 0
      ? opts.circuitBreakerThreshold
      : 5;
    this._circuitBreakerResetTimeout = typeof opts.circuitBreakerResetTimeout === 'number' && Number.isFinite(opts.circuitBreakerResetTimeout) && opts.circuitBreakerResetTimeout > 0
      ? opts.circuitBreakerResetTimeout
      : 30000;
    /** @type {Map<string, Object>} 组件注册表 */
    this._components = new Map();
  }

  /**
   * 注册组件，返回守卫句柄。
   * @param {string} componentId - 组件标识符
   * @param {Object} [config] - 组件配置
   * @param {number} [config.maxIterations] - 该组件最大迭代次数覆盖
   * @param {number} [config.maxRollbacks] - 该组件最大回滚次数覆盖
   * @returns {Object} 守卫句柄，包含 componentId 和 guard 引用
   * @throws {TypeError} componentId 非非空字符串时抛出
   */
  registerComponent(componentId, config) {
    if (typeof componentId !== 'string' || !componentId) {
      throw new TypeError('componentId 必须是非空字符串');
    }
    const cfg = config ?? {};
    const state = {
      maxIterations: typeof cfg.maxIterations === 'number' && Number.isFinite(cfg.maxIterations) && cfg.maxIterations > 0
        ? cfg.maxIterations
        : this._defaultMaxIterations,
      maxRollbacks: typeof cfg.maxRollbacks === 'number' && Number.isFinite(cfg.maxRollbacks) && cfg.maxRollbacks > 0
        ? cfg.maxRollbacks
        : this._defaultMaxRollbacks,
      iterations: 0,
      rollbacks: 0,
      circuitState: CIRCUIT_STATE.CLOSED,
      consecutiveFailures: 0,
      circuitOpenedAt: null,
    };
    this._components.set(componentId, state);
    return { componentId, guard: this };
  }

  /**
   * 检查迭代是否允许，递增迭代计数器。
   * @param {string} componentId - 组件标识符
   * @returns {{ allowed: boolean, current: number, max: number }} 迭代检查结果
   */
  checkIteration(componentId) {
    const state = this._components.get(componentId);
    if (!state) {
      return { allowed: false, current: 0, max: 0 };
    }
    state.iterations += 1;
    const allowed = state.iterations <= state.maxIterations;
    if (!allowed) {
      this.emit('iteration-exceeded', { componentId, current: state.iterations, max: state.maxIterations });
    }
    return { allowed, current: state.iterations, max: state.maxIterations };
  }

  /**
   * 检查回滚是否允许，递增回滚计数器。
   * @param {string} componentId - 组件标识符
   * @returns {{ allowed: boolean, current: number, max: number }} 回滚检查结果
   */
  checkRollback(componentId) {
    const state = this._components.get(componentId);
    if (!state) {
      return { allowed: false, current: 0, max: 0 };
    }
    state.rollbacks += 1;
    const allowed = state.rollbacks <= state.maxRollbacks;
    if (!allowed) {
      this.emit('rollback-exceeded', { componentId, current: state.rollbacks, max: state.maxRollbacks });
    }
    return { allowed, current: state.rollbacks, max: state.maxRollbacks };
  }

  /**
   * 报告失败，用于熔断器跟踪。
   * @param {string} componentId - 组件标识符
   * @param {Error} [error] - 失败原因
   */
  reportFailure(componentId, error) {
    const state = this._components.get(componentId);
    if (!state) return;
    state.consecutiveFailures += 1;

    if (state.circuitState === CIRCUIT_STATE.HALF_OPEN) {
      // 半开状态下再次失败，立即回到开路
      state.circuitState = CIRCUIT_STATE.OPEN;
      state.circuitOpenedAt = Date.now();
      this.emit('circuit-open', { componentId, consecutiveFailures: state.consecutiveFailures });
    } else if (state.circuitState === CIRCUIT_STATE.CLOSED && state.consecutiveFailures >= this._circuitBreakerThreshold) {
      // 闭路状态下连续失败达到阈值，打开熔断器
      state.circuitState = CIRCUIT_STATE.OPEN;
      state.circuitOpenedAt = Date.now();
      this.emit('circuit-open', { componentId, consecutiveFailures: state.consecutiveFailures });
    }

    debug('IterationGuard', `reportFailure:${componentId}`, {
      consecutiveFailures: state.consecutiveFailures,
      circuitState: state.circuitState,
      error: error ? (error.message || String(error)) : undefined,
    });
  }

  /**
   * 报告成功，重置失败计数器。
   * @param {string} componentId - 组件标识符
   */
  reportSuccess(componentId) {
    const state = this._components.get(componentId);
    if (!state) return;

    if (state.circuitState === CIRCUIT_STATE.HALF_OPEN) {
      // 半开状态下成功，关闭熔断器
      state.circuitState = CIRCUIT_STATE.CLOSED;
      state.consecutiveFailures = 0;
      state.circuitOpenedAt = null;
      this.emit('circuit-closed', { componentId });
    } else if (state.circuitState === CIRCUIT_STATE.CLOSED) {
      state.consecutiveFailures = 0;
    }
  }

  /**
   * 检查熔断器是否处于开路状态。
   * @param {string} componentId - 组件标识符
   * @returns {boolean} 熔断器是否开路
   */
  isCircuitOpen(componentId) {
    const state = this._components.get(componentId);
    if (!state) return false;

    // 检查是否应从开路转为半开
    this._tryTransitionToHalfOpen(componentId, state);
    return state.circuitState === CIRCUIT_STATE.OPEN;
  }

  /**
   * 获取熔断器当前状态。
   * @param {string} componentId - 组件标识符
   * @returns {'closed'|'open'|'half-open'} 熔断器状态
   */
  getCircuitState(componentId) {
    const state = this._components.get(componentId);
    if (!state) return CIRCUIT_STATE.CLOSED;
    this._tryTransitionToHalfOpen(componentId, state);
    return state.circuitState;
  }

  /**
   * 手动重置熔断器。
   * @param {string} componentId - 组件标识符
   */
  resetCircuit(componentId) {
    const state = this._components.get(componentId);
    if (!state) return;
    const previousState = state.circuitState;
    state.circuitState = CIRCUIT_STATE.CLOSED;
    state.consecutiveFailures = 0;
    state.circuitOpenedAt = null;
    if (previousState !== CIRCUIT_STATE.CLOSED) {
      this.emit('circuit-closed', { componentId, previousState });
    }
  }

  /**
   * 获取组件统计信息。
   * @param {string} componentId - 组件标识符
   * @returns {{ iterations: number, maxIterations: number, rollbacks: number, maxRollbacks: number, circuitState: string, consecutiveFailures: number }}
   */
  getStats(componentId) {
    const state = this._components.get(componentId);
    if (!state) {
      return {
        iterations: 0,
        maxIterations: 0,
        rollbacks: 0,
        maxRollbacks: 0,
        circuitState: CIRCUIT_STATE.CLOSED,
        consecutiveFailures: 0,
      };
    }
    this._tryTransitionToHalfOpen(componentId, state);
    return {
      iterations: state.iterations,
      maxIterations: state.maxIterations,
      rollbacks: state.rollbacks,
      maxRollbacks: state.maxRollbacks,
      circuitState: state.circuitState,
      consecutiveFailures: state.consecutiveFailures,
    };
  }

  /**
   * 重置组件所有计数器。
   * @param {string} componentId - 组件标识符
   */
  reset(componentId) {
    const state = this._components.get(componentId);
    if (!state) return;
    state.iterations = 0;
    state.rollbacks = 0;
    state.circuitState = CIRCUIT_STATE.CLOSED;
    state.consecutiveFailures = 0;
    state.circuitOpenedAt = null;
  }

  /**
   * 尝试将熔断器从开路状态转换为半开状态。
   * @param {string} componentId - 组件标识符
   * @param {Object} state - 组件内部状态
   * @private
   */
  _tryTransitionToHalfOpen(componentId, state) {
    if (state.circuitState !== CIRCUIT_STATE.OPEN) return;
    if (!state.circuitOpenedAt) return;
    const elapsed = Date.now() - state.circuitOpenedAt;
    if (elapsed >= this._circuitBreakerResetTimeout) {
      state.circuitState = CIRCUIT_STATE.HALF_OPEN;
      this.emit('circuit-half-open', { componentId, elapsed });
    }
  }
}

// ─── ContextPipeline ───────────────────────────────────────────────────────────

/**
 * @classdesc Agent间上下文压缩管道 — 统一管理多Agent之间上下文传输的压缩策略。
 * 将完整上下文按长期/阶段/即时三层分层压缩，支持结构化摘要生成和令牌估算。
 *
 * @extends EventEmitter
 * @emits 'context-compressed' 上下文压缩完成时触发
 * @emits 'summary-generated' 摘要生成完成时触发
 */
class ContextPipeline extends EventEmitter {
  /**
   * 创建 ContextPipeline 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxContextTokens=4000] - 最大上下文令牌数
   * @param {number} [options.summaryMaxTokens=500] - 摘要最大令牌数
   * @param {Object} [options.layers] - 各层令牌分配比例
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._maxContextTokens = typeof opts.maxContextTokens === 'number' && Number.isFinite(opts.maxContextTokens) && opts.maxContextTokens > 0
      ? opts.maxContextTokens
      : 4000;
    this._summaryMaxTokens = typeof opts.summaryMaxTokens === 'number' && Number.isFinite(opts.summaryMaxTokens) && opts.summaryMaxTokens > 0
      ? opts.summaryMaxTokens
      : 500;
    this._layers = {
      [CONTEXT_LAYER.LONG_TERM]: 0.40,
      [CONTEXT_LAYER.PHASE]: 0.35,
      [CONTEXT_LAYER.IMMEDIATE]: 0.25,
    };
    if (opts.layers && typeof opts.layers === 'object') {
      for (const layer of Object.values(CONTEXT_LAYER)) {
        if (typeof opts.layers[layer] === 'number' && Number.isFinite(opts.layers[layer]) && opts.layers[layer] > 0) {
          this._layers[layer] = opts.layers[layer];
        }
      }
    }
    /** @type {Array<Object>} 压缩历史（有界，最大100条） */
    this._compressionHistory = [];
    /** @type {Object} 压缩统计 */
    this._stats = {
      totalCompressions: 0,
      averageRatio: 0,
      tokensSaved: 0,
    };
  }

  /**
   * 压缩上下文以传输给目标Agent。
   * @param {Object} context - 原始上下文对象
   * @param {string} targetAgentId - 目标Agent标识符
   * @returns {Object} 压缩后的上下文，包含 longTermSummary、phaseSummary、immediateContext、metadata
   */
  compressForTransfer(context, targetAgentId) {
    const fullContext = context ?? {};
    const originalTokens = this.estimateTokens(JSON.stringify(fullContext));

    const layered = this.buildLayeredContext(fullContext, fullContext.currentPhase);

    const longTermTokens = Math.floor(this._maxContextTokens * this._layers[CONTEXT_LAYER.LONG_TERM]);
    const phaseTokens = Math.floor(this._maxContextTokens * this._layers[CONTEXT_LAYER.PHASE]);
    const immediateTokens = Math.floor(this._maxContextTokens * this._layers[CONTEXT_LAYER.IMMEDIATE]);

    const longTermSummary = this._truncateToTokens(layered.longTerm, longTermTokens);
    const phaseSummary = this._truncateToTokens(layered.phase, phaseTokens);
    const immediateContext = this._truncateToTokens(layered.immediate, immediateTokens);

    const compressedTokens = this.estimateTokens(
      JSON.stringify({ longTermSummary, phaseSummary, immediateContext }),
    );
    const compressionRatio = originalTokens > 0 ? compressedTokens / originalTokens : 0;

    const result = {
      longTermSummary,
      phaseSummary,
      immediateContext,
      metadata: {
        originalTokens,
        compressedTokens,
        compressionRatio,
        targetAgentId,
        timestamp: Date.now(),
      },
    };

    this._recordCompression(originalTokens, compressedTokens, compressionRatio);
    this.emit('context-compressed', result);
    return result;
  }

  /**
   * 构建分层上下文（长期40%/阶段35%/即时25%）。
   * @param {Object} fullContext - 完整上下文
   * @param {string} [currentPhase] - 当前阶段
   * @returns {{ longTerm: Object, phase: Object, immediate: Object }} 分层上下文
   */
  buildLayeredContext(fullContext, currentPhase) {
    const ctx = fullContext ?? {};
    return {
      longTerm: {
        confirmedFacts: Array.isArray(ctx.confirmedFacts) ? ctx.confirmedFacts : [],
        architecture: ctx.architecture ?? null,
        constraints: Array.isArray(ctx.constraints) ? ctx.constraints : [],
        goals: Array.isArray(ctx.goals) ? ctx.goals : [],
      },
      phase: {
        currentPhase: currentPhase ?? ctx.currentPhase ?? null,
        phaseProgress: ctx.phaseProgress ?? null,
        phaseDecisions: Array.isArray(ctx.phaseDecisions) ? ctx.phaseDecisions : [],
        phaseErrors: Array.isArray(ctx.phaseErrors) ? ctx.phaseErrors.slice(-5) : [],
      },
      immediate: {
        currentTask: ctx.currentTask ?? null,
        recentActions: Array.isArray(ctx.recentActions) ? ctx.recentActions.slice(-3) : [],
        pendingItems: Array.isArray(ctx.pendingItems) ? ctx.pendingItems : [],
        lastResult: ctx.lastResult ?? null,
      },
    };
  }

  /**
   * 生成结构化摘要。
   * @param {Array<Object>} executionLog - 执行日志
   * @returns {{ confirmedFacts: Array, unresolvedIssues: Array, nextSteps: Array, metrics: Object }} 结构化摘要
   */
  generateStructuredSummary(executionLog) {
    const log = Array.isArray(executionLog) ? executionLog : [];

    const confirmedFacts = [];
    const unresolvedIssues = [];
    const nextSteps = [];
    let totalIterations = 0;
    let totalErrors = 0;
    let totalTokensUsed = 0;

    for (const entry of log) {
      if (!entry || typeof entry !== 'object') continue;
      totalIterations += 1;
      if (entry.error) totalErrors += 1;
      if (typeof entry.tokensUsed === 'number') totalTokensUsed += entry.tokensUsed;

      if (Array.isArray(entry.confirmedFacts)) {
        for (const fact of entry.confirmedFacts) {
          if (fact && !confirmedFacts.includes(fact)) confirmedFacts.push(fact);
        }
      }
      if (Array.isArray(entry.unresolvedIssues)) {
        for (const issue of entry.unresolvedIssues) {
          if (issue && !unresolvedIssues.includes(issue)) unresolvedIssues.push(issue);
        }
      }
      if (Array.isArray(entry.nextSteps)) {
        for (const step of entry.nextSteps) {
          if (step && !nextSteps.includes(step)) nextSteps.push(step);
        }
      }
    }

    const summary = {
      confirmedFacts,
      unresolvedIssues,
      nextSteps,
      metrics: {
        totalIterations,
        totalErrors,
        errorRate: totalIterations > 0 ? totalErrors / totalIterations : 0,
        totalTokensUsed,
      },
    };

    this.emit('summary-generated', summary);
    return summary;
  }

  /**
   * 估算文本令牌数（CJK: 2字符/token，其他: 4字符/token）。
   * @param {string} text - 待估算文本
   * @returns {number} 估算令牌数
   */
  estimateTokens(text) {
    if (typeof text !== 'string') return 0;
    let cjkCount = 0;
    let otherCount = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (
        (code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x3000 && code <= 0x303F) ||
        (code >= 0xFF00 && code <= 0xFFEF) ||
        (code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0x3040 && code <= 0x309F) ||
        (code >= 0x30A0 && code <= 0x30FF)
      ) {
        cjkCount += 1;
      } else {
        otherCount += 1;
      }
    }
    return Math.ceil(cjkCount / 2) + Math.ceil(otherCount / 4);
  }

  /**
   * 获取压缩统计信息。
   * @returns {{ totalCompressions: number, averageRatio: number, tokensSaved: number }}
   */
  getCompressionStats() {
    return {
      totalCompressions: this._stats.totalCompressions,
      averageRatio: this._stats.averageRatio,
      tokensSaved: this._stats.tokensSaved,
    };
  }

  /**
   * 将内容截断到指定令牌数以内。
   * @param {*} content - 待截断内容
   * @param {number} maxTokens - 最大令牌数
   * @returns {*} 截断后的内容
   * @private
   */
  _truncateToTokens(content, maxTokens) {
    if (content == null) return content;
    if (typeof content === 'string') {
      if (this.estimateTokens(content) <= maxTokens) return content;
      // 按比例估算字符数上限
      const estimatedCharsPerToken = content.length / Math.max(1, this.estimateTokens(content));
      const maxChars = Math.floor(maxTokens * estimatedCharsPerToken);
      return content.slice(0, maxChars);
    }
    const serialized = JSON.stringify(content);
    if (this.estimateTokens(serialized) <= maxTokens) return content;
    // 序列化后超限，尝试简化
    if (Array.isArray(content)) {
      const result = [];
      let usedTokens = 0;
      for (const item of content) {
        const itemStr = JSON.stringify(item);
        const itemTokens = this.estimateTokens(itemStr);
        if (usedTokens + itemTokens > maxTokens) break;
        result.push(item);
        usedTokens += itemTokens;
      }
      return result;
    }
    if (typeof content === 'object') {
      const result = {};
      let usedTokens = 0;
      for (const [key, value] of Object.entries(content)) {
        const entryStr = JSON.stringify({ [key]: value });
        const entryTokens = this.estimateTokens(entryStr);
        if (usedTokens + entryTokens > maxTokens) break;
        result[key] = value;
        usedTokens += entryTokens;
      }
      return result;
    }
    return content;
  }

  /**
   * 记录压缩历史。
   * @param {number} originalTokens - 原始令牌数
   * @param {number} compressedTokens - 压缩后令牌数
   * @param {number} ratio - 压缩比
   * @private
   */
  _recordCompression(originalTokens, compressedTokens, ratio) {
    const record = { originalTokens, compressedTokens, ratio, timestamp: Date.now() };
    this._compressionHistory.push(record);
    if (this._compressionHistory.length > 100) {
      this._compressionHistory.shift();
    }

    this._stats.totalCompressions += 1;
    this._stats.tokensSaved += Math.max(0, originalTokens - compressedTokens);
    // 增量计算平均压缩比
    const prevAvg = this._stats.averageRatio;
    const n = this._stats.totalCompressions;
    this._stats.averageRatio = prevAvg + (ratio - prevAvg) / n;
  }
}

// ─── DefinitionOfDone ──────────────────────────────────────────────────────────

/**
 * @classdesc 量化完成标准+4类终止条件 — 为多Agent任务定义结构化完成标准，
 * 并在每次迭代后检查4类终止条件：(1) DoD满足 (2) 预算耗尽 (3) 无进展 (4) 边界越限。
 *
 * @extends EventEmitter
 * @emits 'dod-met' DoD满足时触发
 * @emits 'dod-evaluated' DoD评估完成时触发
 * @emits 'termination-check' 终止条件检查完成时触发
 * @emits 'budget-warning' 预算接近耗尽时触发
 */
class DefinitionOfDone extends EventEmitter {
  /**
   * 创建 DefinitionOfDone 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.defaultThreshold=0.85] - 默认通过阈值
   * @param {number} [options.stagnationWindow=5] - 停滞检测窗口大小
   * @param {number} [options.stagnationThreshold=0.01] - 停滞检测阈值
   * @param {number} [options.budgetWarningRatio=0.9] - 预算警告比例
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._defaultThreshold = typeof opts.defaultThreshold === 'number' && Number.isFinite(opts.defaultThreshold) && opts.defaultThreshold > 0 && opts.defaultThreshold <= 1
      ? opts.defaultThreshold
      : 0.85;
    this._stagnationWindow = typeof opts.stagnationWindow === 'number' && Number.isFinite(opts.stagnationWindow) && opts.stagnationWindow > 0
      ? opts.stagnationWindow
      : 5;
    this._stagnationThreshold = typeof opts.stagnationThreshold === 'number' && Number.isFinite(opts.stagnationThreshold) && opts.stagnationThreshold >= 0
      ? opts.stagnationThreshold
      : 0.01;
    this._budgetWarningRatio = typeof opts.budgetWarningRatio === 'number' && Number.isFinite(opts.budgetWarningRatio) && opts.budgetWarningRatio > 0 && opts.budgetWarningRatio < 1
      ? opts.budgetWarningRatio
      : 0.9;
    /** @type {Map<string, Object>} DoD定义注册表 */
    this._dods = new Map();
    /** @type {Map<string, Array<Object>>} 进度历史（有界，每任务最多50条） */
    this._progressHistory = new Map();
    /** @type {Array<Object>} 终止原因历史（有界，最多500条） */
    this._terminationHistory = [];
  }

  /**
   * 定义任务的完成标准。
   * @param {string} taskId - 任务标识符
   * @param {Object} criteria - 完成标准定义
   * @param {Array<{metric: string, target: number, tolerance?: number, weight?: number}>} criteria.criteria - 指标列表
   * @param {number} [criteria.timeBudget] - 时间预算（毫秒）
   * @param {number} [criteria.costBudget] - 成本预算
   * @param {number} [criteria.tokenBudget] - 令牌预算
   * @param {number} [criteria.threshold] - 通过阈值覆盖
   * @throws {TypeError} taskId 非非空字符串或 criteria 非对象时抛出
   */
  defineDoD(taskId, criteria) {
    if (typeof taskId !== 'string' || !taskId) {
      throw new TypeError('taskId 必须是非空字符串');
    }
    if (!criteria || typeof criteria !== 'object') {
      throw new TypeError('criteria 必须是对象');
    }

    const items = Array.isArray(criteria.criteria) ? criteria.criteria.map((c) => ({
      metric: c.metric || 'unknown',
      target: typeof c.target === 'number' ? c.target : 0,
      tolerance: typeof c.tolerance === 'number' ? c.tolerance : 0.05,
      weight: typeof c.weight === 'number' && c.weight > 0 ? c.weight : 1,
    })) : [];

    const dod = {
      criteria: items,
      threshold: typeof criteria.threshold === 'number' && Number.isFinite(criteria.threshold) && criteria.threshold > 0 && criteria.threshold <= 1
        ? criteria.threshold
        : this._defaultThreshold,
      timeBudget: typeof criteria.timeBudget === 'number' && Number.isFinite(criteria.timeBudget) && criteria.timeBudget > 0
        ? criteria.timeBudget
        : null,
      costBudget: typeof criteria.costBudget === 'number' && Number.isFinite(criteria.costBudget) && criteria.costBudget > 0
        ? criteria.costBudget
        : null,
      tokenBudget: typeof criteria.tokenBudget === 'number' && Number.isFinite(criteria.tokenBudget) && criteria.tokenBudget > 0
        ? criteria.tokenBudget
        : null,
      createdAt: Date.now(),
    };

    this._dods.set(taskId, dod);
    this._progressHistory.set(taskId, []);
  }

  /**
   * 评估当前指标是否满足DoD。
   * @param {string} taskId - 任务标识符
   * @param {Object} currentMetrics - 当前指标值映射
   * @returns {{ met: boolean, score: number, details: Array, overallScore: number }} 评估结果
   */
  evaluateDoD(taskId, currentMetrics) {
    const dod = this._dods.get(taskId);
    if (!dod) {
      return { met: false, score: 0, details: [], overallScore: 0 };
    }

    const metrics = currentMetrics ?? {};
    const details = [];
    let totalWeight = 0;
    let weightedScore = 0;

    for (const criterion of dod.criteria) {
      const actual = typeof metrics[criterion.metric] === 'number' ? metrics[criterion.metric] : 0;
      const gap = Math.max(0, criterion.target - actual);
      const tolerance = criterion.target * criterion.tolerance;
      const passed = actual >= (criterion.target - tolerance);
      const itemScore = criterion.target > 0 ? Math.min(1, actual / criterion.target) : (passed ? 1 : 0);

      details.push({
        metric: criterion.metric,
        target: criterion.target,
        actual,
        passed,
        gap,
      });

      totalWeight += criterion.weight;
      weightedScore += itemScore * criterion.weight;
    }

    const overallScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
    const met = overallScore >= dod.threshold;

    const result = { met, score: overallScore, details, overallScore };
    this.emit('dod-evaluated', { taskId, ...result });

    if (met) {
      this.emit('dod-met', { taskId, overallScore });
    }

    return result;
  }

  /**
   * 检查所有4类终止条件。
   * @param {string} taskId - 任务标识符
   * @param {Object} context - 检查上下文
   * @param {Object} [context.currentMetrics] - 当前指标
   * @param {number} [context.elapsedTime] - 已用时间（毫秒）
   * @param {number} [context.costUsed] - 已用成本
   * @param {number} [context.tokensUsed] - 已用令牌数
   * @param {number} [context.iteration] - 当前迭代次数
   * @param {number} [context.maxIterations] - 最大迭代次数
   * @returns {{ shouldTerminate: boolean, reason: string|null, details: Object }} 终止检查结果
   */
  checkTermination(taskId, context) {
    const ctx = context ?? {};
    const dod = this._dods.get(taskId);

    // 条件1: DoD满足
    const dodResult = this._checkDoDMet(taskId, dod, ctx);
    if (dodResult) return dodResult;

    // 条件2: 预算耗尽
    const budgetResult = this._checkBudgetExhausted(taskId, dod, ctx);
    if (budgetResult) return budgetResult;

    // 条件3: 无进展（停滞检测）
    const stagnationResult = this._checkStagnation(taskId, ctx);
    if (stagnationResult) return stagnationResult;

    // 条件4: 边界越限（迭代次数超限）
    const boundaryResult = this._checkBoundaryExceeded(taskId, ctx);
    if (boundaryResult) return boundaryResult;

    const result = { shouldTerminate: false, reason: null, details: {} };
    this.emit('termination-check', { taskId, ...result });
    return result;
  }

  /** @private 检查DoD是否满足 */
  _checkDoDMet(taskId, dod, ctx) {
    if (!dod || !ctx.currentMetrics) return null;
    const evaluation = this.evaluateDoD(taskId, ctx.currentMetrics);
    if (!evaluation.met) return null;
    const result = { shouldTerminate: true, reason: TERMINATION_REASON.DOD_MET, details: { evaluation } };
    this._recordTermination(taskId, result);
    this.emit('termination-check', { taskId, ...result });
    return result;
  }

  /** @private 检查预算是否耗尽 */
  _checkBudgetExhausted(taskId, dod, ctx) {
    if (!dod) return null;
    const budgetDetails = {};
    let budgetExhausted = false;
    const budgetChecks = [
      { budget: dod.timeBudget, used: ctx.elapsedTime, key: 'time' },
      { budget: dod.costBudget, used: ctx.costUsed, key: 'cost' },
      { budget: dod.tokenBudget, used: ctx.tokensUsed, key: 'token' },
    ];
    for (const { budget, used, key } of budgetChecks) {
      const checkResult = this._checkSingleBudget(taskId, budget, used, key);
      if (checkResult.exhausted) budgetExhausted = true;
      Object.assign(budgetDetails, checkResult.details);
    }
    if (!budgetExhausted) return null;
    const result = { shouldTerminate: true, reason: TERMINATION_REASON.BUDGET_EXHAUSTED, details: budgetDetails };
    this._recordTermination(taskId, result);
    this.emit('termination-check', { taskId, ...result });
    return result;
  }

  _checkSingleBudget(taskId, budget, used, key) {
    const details = {};
    if (budget == null || typeof used !== 'number') return { exhausted: false, details };
    details[`${key}Used`] = used;
    details[`${key}Budget`] = budget;
    const ratio = used / budget;
    details[`${key}Ratio`] = ratio;
    if (ratio >= this._budgetWarningRatio) {
      this.emit('budget-warning', { taskId, type: key, ratio });
    }
    return { exhausted: used >= budget, details };
  }

  /** @private 检查是否停滞 */
  _checkStagnation(taskId) {
    const history = this._progressHistory.get(taskId);
    if (!history || history.length < this._stagnationWindow) return null;
    const recentScores = history.slice(-this._stagnationWindow).map((h) => h.score);
    const range = Math.max(...recentScores) - Math.min(...recentScores);
    if (range > this._stagnationThreshold) return null;
    const result = {
      shouldTerminate: true,
      reason: TERMINATION_REASON.NO_PROGRESS,
      details: { stagnationWindow: this._stagnationWindow, scoreRange: range, recentScores },
    };
    this._recordTermination(taskId, result);
    this.emit('termination-check', { taskId, ...result });
    return result;
  }

  /** @private 检查边界是否越限 */
  _checkBoundaryExceeded(taskId, ctx) {
    if (typeof ctx.iteration !== 'number' || typeof ctx.maxIterations !== 'number') return null;
    if (ctx.iteration < ctx.maxIterations) return null;
    const result = {
      shouldTerminate: true,
      reason: TERMINATION_REASON.BOUNDARY_EXCEEDED,
      details: { iteration: ctx.iteration, maxIterations: ctx.maxIterations },
    };
    this._recordTermination(taskId, result);
    this.emit('termination-check', { taskId, ...result });
    return result;
  }

  /**
   * 记录进度，用于停滞检测。
   * @param {string} taskId - 任务标识符
   * @param {Object} metrics - 进度指标
   * @param {number} metrics.score - 当前分数
   */
  recordProgress(taskId, metrics) {
    if (!this._progressHistory.has(taskId)) {
      this._progressHistory.set(taskId, []);
    }
    const history = this._progressHistory.get(taskId);
    const score = metrics && typeof metrics.score === 'number' ? metrics.score : 0;
    history.push({ score, timestamp: Date.now(), ...metrics });
    if (history.length > 50) {
      history.shift();
    }
  }

  /**
   * 获取DoD定义。
   * @param {string} taskId - 任务标识符
   * @returns {Object|null} DoD定义
   */
  getDoD(taskId) {
    return this._dods.get(taskId) ?? null;
  }

  /**
   * 获取终止原因历史。
   * @param {string} taskId - 任务标识符
   * @returns {Array<Object>} 终止原因记录列表
   */
  getTerminationHistory(taskId) {
    return this._terminationHistory.filter((h) => h.taskId === taskId);
  }

  /**
   * 记录终止事件。
   * @param {string} taskId - 任务标识符
   * @param {Object} result - 终止结果
   * @private
   */
  _recordTermination(taskId, result) {
    this._terminationHistory.push({ taskId, ...result, timestamp: Date.now() });
    if (this._terminationHistory.length > 500) {
      this._terminationHistory.shift();
    }
  }
}

// ─── OnionModelCoordinator ─────────────────────────────────────────────────────

/**
 * @classdesc 洋葱模型协调器 — 显式DoD→过程控制→人工回退链。
 * 三层保护结构：核心层（DoD检查）、中间层（迭代限制+熔断器）、外层（人工审批升级）。
 *
 * @extends EventEmitter
 * @emits 'layer-transition' 层级转换时触发
 * @emits 'escalation-triggered' 升级触发时触发
 * @emits 'onion-complete' 洋葱模型执行完成时触发
 */
class OnionModelCoordinator extends EventEmitter {
  /**
   * 创建 OnionModelCoordinator 实例。
   * @param {Object} [options] - 配置选项
   * @param {IterationGuard} [options.iterationGuard] - 迭代守卫实例
   * @param {DefinitionOfDone} [options.definitionOfDone] - DoD实例
   * @param {Object} [options.humanApprovalGate] - 人工审批门实例
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._iterationGuard = opts.iterationGuard ?? null;
    this._definitionOfDone = opts.definitionOfDone ?? null;
    this._humanApprovalGate = opts.humanApprovalGate ?? null;
    /** @type {Map<string, Object>} 任务状态 */
    this._taskStates = new Map();
    /** @type {Array<Object>} 升级历史（有界，最多200条） */
    this._escalationHistory = [];
  }

  /**
   * 使用洋葱模型保护执行任务。
   * 核心层：执行任务，每次迭代后检查DoD
   * 中间层：DoD未满足时，检查迭代限制/回滚限制/熔断器
   * 外层：中间层触发边界时，自动升级到人工审批
   *
   * @param {string} taskId - 任务标识符
   * @param {Function} executionFn - 任务执行函数，签名为 (iteration) => Promise<{metrics, result}>
   * @param {Object} [options] - 执行选项
   * @param {number} [options.maxIterations] - 最大迭代次数
   * @param {string} [options.componentId] - 用于迭代守卫的组件ID
   * @returns {Promise<{result: *, terminationReason: string|null, iterationsUsed: number, circuitState: string}>} 执行结果
   */
  async executeWithOnionModel(taskId, executionFn, options) {
    const opts = options ?? {};
    const maxIterations = typeof opts.maxIterations === 'number' && opts.maxIterations > 0
      ? opts.maxIterations
      : 10;
    const componentId = opts.componentId ?? taskId;
    const taskState = {
      core: { dodScore: 0 },
      middle: { iterations: 0, rollbacks: 0, circuitState: CIRCUIT_STATE.CLOSED },
      outer: { escalationCount: 0, lastEscalationReason: null },
    };
    this._taskStates.set(taskId, taskState);
    let lastResult = null;
    let terminationReason = null;
    let iterationsUsed = 0;
    try {
      const loopResult = await this._runOnionIterations(taskId, executionFn, maxIterations, componentId, taskState);
      lastResult = loopResult.lastResult;
      terminationReason = loopResult.terminationReason;
      iterationsUsed = loopResult.iterationsUsed;
      if (!terminationReason) {
        terminationReason = TERMINATION_REASON.BOUNDARY_EXCEEDED;
      }
    } catch (err) {
      debug('OnionModelCoordinator', `executeWithOnionModel:${taskId}`, err);
      terminationReason = TERMINATION_REASON.BOUNDARY_EXCEEDED;
    }
    const circuitState = this._iterationGuard
      ? this._iterationGuard.getCircuitState(componentId)
      : CIRCUIT_STATE.CLOSED;
    const result = {
      result: lastResult,
      terminationReason,
      iterationsUsed,
      circuitState,
    };
    this.emit('onion-complete', { taskId, ...result });
    return result;
  }

  async _runOnionIterations(taskId, executionFn, maxIterations, componentId, taskState) {
    let lastResult = null;
    let terminationReason = null;
    let iterationsUsed = 0;
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      iterationsUsed = iteration;
      const execResult = await this._executeCoreLayer(taskId, executionFn, iteration, componentId, taskState);
      if (execResult === null) continue;
      lastResult = execResult.result;
      const currentMetrics = execResult.metrics;
      const dodTerminated = this._checkCoreDoD(taskId, currentMetrics, taskState);
      if (dodTerminated) { terminationReason = dodTerminated; break; }
      const middleTerminated = await this._checkMiddleLayer(taskId, componentId, taskState);
      if (middleTerminated) { terminationReason = middleTerminated; break; }
      const termTerminated = this._checkTerminationInLoop(taskId, currentMetrics, iteration, maxIterations, taskState);
      if (termTerminated) { terminationReason = termTerminated; break; }
    }
    return { lastResult, terminationReason, iterationsUsed };
  }

  /** @private 核心层：执行任务 */
  async _executeCoreLayer(taskId, executionFn, iteration, componentId, taskState) {
    try {
      const execResult = await executionFn(iteration);
      const result = execResult && execResult.result !== undefined ? execResult.result : execResult;
      const metrics = execResult && execResult.metrics ? execResult.metrics : {};
      return { result, metrics };
    } catch (err) {
      debug('OnionModelCoordinator', `executeWithOnionModel:execution:${taskId}`, err);
      if (this._iterationGuard) {
        this._iterationGuard.reportFailure(componentId, err);
      }
      taskState.middle.circuitState = this._iterationGuard
        ? this._iterationGuard.getCircuitState(componentId)
        : CIRCUIT_STATE.CLOSED;
      return null;
    }
  }

  /** @private 核心层：检查DoD */
  _checkCoreDoD(taskId, currentMetrics, taskState) {
    if (!this._definitionOfDone) return null;
    const evaluation = this._definitionOfDone.evaluateDoD(taskId, currentMetrics);
    taskState.core.dodScore = evaluation.overallScore;
    if (!evaluation.met) return null;
    this.emit('layer-transition', { taskId, from: 'core', to: 'complete', reason: 'dod-met', score: evaluation.overallScore });
    return TERMINATION_REASON.DOD_MET;
  }

  /** @private 中间层：检查迭代限制+熔断器 */
  async _checkMiddleLayer(taskId, componentId, taskState) {
    if (!this._iterationGuard) return null;

    const iterCheck = this._iterationGuard.checkIteration(componentId);
    taskState.middle.iterations = iterCheck.current;
    taskState.middle.circuitState = this._iterationGuard.getCircuitState(componentId);

    if (!iterCheck.allowed) {
      this.emit('layer-transition', { taskId, from: 'middle', to: 'outer', reason: 'iteration-exceeded' });
      const escalated = await this._tryEscalate(taskId, 'iteration-exceeded', { iterations: iterCheck.current, max: iterCheck.max });
      if (!escalated) return TERMINATION_REASON.BOUNDARY_EXCEEDED;
      this._iterationGuard.reset(componentId);
      this._iterationGuard.registerComponent(componentId, { maxIterations: iterCheck.max });
      return null; // 继续迭代
    }

    if (this._iterationGuard.isCircuitOpen(componentId)) {
      this.emit('layer-transition', { taskId, from: 'middle', to: 'outer', reason: 'circuit-open' });
      const escalated = await this._tryEscalate(taskId, 'circuit-open', { circuitState: taskState.middle.circuitState });
      if (!escalated) return TERMINATION_REASON.BOUNDARY_EXCEEDED;
      this._iterationGuard.resetCircuit(componentId);
      taskState.middle.circuitState = CIRCUIT_STATE.CLOSED;
      return null; // 继续迭代
    }

    this._iterationGuard.reportSuccess(componentId);
    return null;
  }

  /** @private 检查终止条件（循环内） */
  _checkTerminationInLoop(taskId, currentMetrics, iteration, maxIterations, taskState) {
    if (!this._definitionOfDone) return null;
    const termCheck = this._definitionOfDone.checkTermination(taskId, {
      currentMetrics,
      iteration,
      maxIterations,
    });
    if (termCheck.shouldTerminate) return termCheck.reason;
    this._definitionOfDone.recordProgress(taskId, { score: taskState.core.dodScore });
    return null;
  }

  /**
   * 配置升级规则。
   * @param {string} taskId - 任务标识符
   * @param {Object} config - 升级配置
   * @param {number} [config.tightenAfterEscalations] - 经历多少次升级后收紧迭代限制
   * @param {number} [config.tightenedMaxIterations] - 收紧后的最大迭代次数
   * @param {boolean} [config.autoEscalateOnCircuitOpen] - 熔断器打开时是否自动升级
   */
  configureEscalation(taskId, config) {
    const state = this._taskStates.get(taskId);
    if (!state) return;
    state.escalationConfig = {
      tightenAfterEscalations: typeof config.tightenAfterEscalations === 'number' ? config.tightenAfterEscalations : 3,
      tightenedMaxIterations: typeof config.tightenedMaxIterations === 'number' ? config.tightenedMaxIterations : 3,
      autoEscalateOnCircuitOpen: config.autoEscalateOnCircuitOpen !== false,
    };
  }

  /**
   * 获取洋葱模型当前层级状态。
   * @param {string} taskId - 任务标识符
   * @returns {{ core: Object, middle: Object, outer: Object }} 层级状态
   */
  getOnionStatus(taskId) {
    const state = this._taskStates.get(taskId);
    if (!state) {
      return {
        core: { dodScore: 0 },
        middle: { iterations: 0, rollbacks: 0, circuitState: CIRCUIT_STATE.CLOSED },
        outer: { escalationCount: 0, lastEscalationReason: null },
      };
    }
    return {
      core: { dodScore: state.core.dodScore },
      middle: { ...state.middle },
      outer: { ...state.outer },
    };
  }

  /**
   * 尝试升级到人工审批。
   * @param {string} taskId - 任务标识符
   * @param {string} reason - 升级原因
   * @param {Object} details - 升级详情
   * @returns {Promise<boolean>} 是否获得人工批准
   * @private
   */
  async _tryEscalate(taskId, reason, details) {
    const state = this._taskStates.get(taskId);
    if (state) {
      state.outer.escalationCount += 1;
      state.outer.lastEscalationReason = reason;
    }

    this._escalationHistory.push({ taskId, reason, details, timestamp: Date.now() });
    if (this._escalationHistory.length > 200) {
      this._escalationHistory.shift();
    }

    this.emit('escalation-triggered', { taskId, reason, details });

    if (this._humanApprovalGate && typeof this._humanApprovalGate.requestApproval === 'function') {
      try {
        const approval = await this._humanApprovalGate.requestApproval({
          taskId,
          reason,
          details,
        });
        return approval && approval.approved === true;
      } catch (err) {
        debug('OnionModelCoordinator', `_tryEscalate:${taskId}`, err);
        return false;
      }
    }

    // 无人工审批门，默认拒绝
    return false;
  }
}

// ─── MultiAgentControl ─────────────────────────────────────────────────────────

/**
 * @classdesc 多Agent系统工程控制机制 — 组合迭代守卫、上下文压缩管道、完成标准和洋葱模型协调器，
 * 为多Agent协作提供统一的工程控制框架。
 *
 * @extends EventEmitter
 * @emits 'iteration-exceeded' 迭代超限（转发自IterationGuard）
 * @emits 'rollback-exceeded' 回滚超限（转发自IterationGuard）
 * @emits 'circuit-open' 熔断器打开（转发自IterationGuard）
 * @emits 'circuit-half-open' 熔断器半开（转发自IterationGuard）
 * @emits 'circuit-closed' 熔断器关闭（转发自IterationGuard）
 * @emits 'context-compressed' 上下文压缩完成（转发自ContextPipeline）
 * @emits 'summary-generated' 摘要生成完成（转发自ContextPipeline）
 * @emits 'dod-met' DoD满足（转发自DefinitionOfDone）
 * @emits 'dod-evaluated' DoD评估完成（转发自DefinitionOfDone）
 * @emits 'termination-check' 终止条件检查（转发自DefinitionOfDone）
 * @emits 'budget-warning' 预算警告（转发自DefinitionOfDone）
 * @emits 'layer-transition' 层级转换（转发自OnionModelCoordinator）
 * @emits 'escalation-triggered' 升级触发（转发自OnionModelCoordinator）
 * @emits 'onion-complete' 洋葱模型执行完成（转发自OnionModelCoordinator）
 */
class MultiAgentControl extends EventEmitter {
  /**
   * 创建 MultiAgentControl 实例。
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.iterationGuard] - IterationGuard配置
   * @param {Object} [options.contextPipeline] - ContextPipeline配置
   * @param {Object} [options.definitionOfDone] - DefinitionOfDone配置
   * @param {Object} [options.onionModelCoordinator] - OnionModelCoordinator配置
   * @param {Object} [options.humanApprovalGate] - 人工审批门实例
   */
  constructor(options) {
    super();
    const opts = options ?? {};

    /** @type {IterationGuard} 迭代守卫 */
    this._iterationGuard = new IterationGuard(opts.iterationGuard);
    /** @type {ContextPipeline} 上下文压缩管道 */
    this._contextPipeline = new ContextPipeline(opts.contextPipeline);
    /** @type {DefinitionOfDone} 完成标准 */
    this._definitionOfDone = new DefinitionOfDone(opts.definitionOfDone);
    /** @type {OnionModelCoordinator} 洋葱模型协调器 */
    this._onionModelCoordinator = new OnionModelCoordinator({
      iterationGuard: this._iterationGuard,
      definitionOfDone: this._definitionOfDone,
      humanApprovalGate: opts.humanApprovalGate ?? null,
      ...opts.onionModelCoordinator,
    });

    this._forwardEvents();
  }

  /**
   * 获取迭代守卫实例。
   * @type {IterationGuard}
   */
  get iterationGuard() {
    return this._iterationGuard;
  }

  /**
   * 获取上下文压缩管道实例。
   * @type {ContextPipeline}
   */
  get contextPipeline() {
    return this._contextPipeline;
  }

  /**
   * 获取完成标准实例。
   * @type {DefinitionOfDone}
   */
  get definitionOfDone() {
    return this._definitionOfDone;
  }

  /**
   * 获取洋葱模型协调器实例。
   * @type {OnionModelCoordinator}
   */
  get onionModelCoordinator() {
    return this._onionModelCoordinator;
  }

  /**
   * 使用洋葱模型保护执行任务（便捷方法，委托给OnionModelCoordinator）。
   * @param {string} taskId - 任务标识符
   * @param {Function} executionFn - 任务执行函数
   * @param {Object} [options] - 执行选项
   * @returns {Promise<Object>} 执行结果
   */
  async executeWithOnionModel(taskId, executionFn, options) {
    return this._onionModelCoordinator.executeWithOnionModel(taskId, executionFn, options);
  }

  /**
   * 压缩上下文以传输给目标Agent（便捷方法，委托给ContextPipeline）。
   * @param {Object} context - 原始上下文
   * @param {string} targetAgentId - 目标Agent标识符
   * @returns {Object} 压缩后的上下文
   */
  compressForTransfer(context, targetAgentId) {
    return this._contextPipeline.compressForTransfer(context, targetAgentId);
  }

  /**
   * 注册组件到迭代守卫（便捷方法，委托给IterationGuard）。
   * @param {string} componentId - 组件标识符
   * @param {Object} [config] - 组件配置
   * @returns {Object} 守卫句柄
   */
  registerComponent(componentId, config) {
    return this._iterationGuard.registerComponent(componentId, config);
  }

  /**
   * 定义任务完成标准（便捷方法，委托给DefinitionOfDone）。
   * @param {string} taskId - 任务标识符
   * @param {Object} criteria - 完成标准
   */
  defineDoD(taskId, criteria) {
    return this._definitionOfDone.defineDoD(taskId, criteria);
  }

  // ── 内部方法 ───────────────────────────────────────────────────────────────

  /**
   * 转发子组件事件到主实例。
   * @private
   */
  _forwardEvents() {
    const forward = (emitter, events) => {
      for (const event of events) {
        emitter.on(event, (...args) => {
          safeCall(() => this.emit(event, ...args), 'MultiAgentControl', `forward:${event}`);
        });
      }
    };

    forward(this._iterationGuard, [
      'iteration-exceeded', 'rollback-exceeded',
      'circuit-open', 'circuit-half-open', 'circuit-closed',
    ]);
    forward(this._contextPipeline, ['context-compressed', 'summary-generated']);
    forward(this._definitionOfDone, ['dod-met', 'dod-evaluated', 'termination-check', 'budget-warning']);
    forward(this._onionModelCoordinator, ['layer-transition', 'escalation-triggered', 'onion-complete']);
  }

  /**
   * 优雅关闭回调，由withShutdown混入在关闭时自动调用。
   * @private
   */
  _onShutdown() {
    this._iterationGuard.removeAllListeners();
    this._contextPipeline.removeAllListeners();
    this._definitionOfDone.removeAllListeners();
    this._onionModelCoordinator.removeAllListeners();
    this.removeAllListeners();
  }
}

// ─── 静态属性 ──────────────────────────────────────────────────────────────────

MultiAgentControl.IterationGuard = IterationGuard;
MultiAgentControl.ContextPipeline = ContextPipeline;
MultiAgentControl.DefinitionOfDone = DefinitionOfDone;
MultiAgentControl.OnionModelCoordinator = OnionModelCoordinator;

MultiAgentControl.CIRCUIT_STATE = CIRCUIT_STATE;
MultiAgentControl.TERMINATION_REASON = TERMINATION_REASON;
MultiAgentControl.CONTEXT_LAYER = CONTEXT_LAYER;

module.exports = withShutdown(MultiAgentControl);
