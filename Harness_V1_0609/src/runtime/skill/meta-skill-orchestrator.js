'use strict';

const { EventEmitter } = require('events');
const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { safeExecute, safeCall } = require('../../utils/safe-execute');
const { estimateTokens } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * 每个Meta Skill阶段中单个技能的最大数量。
 * @constant {number}
 */
const MAX_SKILLS_PER_PHASE = 5;

/**
 * 每个Meta Skill的最大阶段数。
 * @constant {number}
 */
const MAX_PHASES = 10;

/**
 * 每个技能执行的默认超时时间（毫秒），5分钟。
 * @constant {number}
 */
const DEFAULT_TIMEOUT_PER_SKILL = 300000;

/**
 * Meta Skill执行的最大总超时时间（毫秒），30分钟。
 * @constant {number}
 */
const MAX_TOTAL_TIMEOUT = 1800000;

/**
 * 已注册的Meta Skill最大数量。
 * @constant {number}
 */
const MAX_META_SKILLS = 100;

/**
 * 技能失败时的处理策略。
 * @readonly
 * @enum {string}
 */
const FAILURE_STRATEGIES = {
  /** 立即停止整个Meta Skill执行 */
  STOP: 'stop',
  /** 跳过当前技能，继续执行后续技能 */
  SKIP: 'skip',
  /** 重试当前技能一次 */
  RETRY: 'retry',
};

/**
 * 模型层级常量。
 * @readonly
 * @enum {string}
 */
const MODEL_TIERS = {
  SMALL: 'small',
  MEDIUM: 'medium',
  LARGE: 'large',
};

/**
 * 默认模型层级（当技能未指定modelTier时使用）。
 * @constant {string}
 */
const DEFAULT_MODEL_TIER = MODEL_TIERS.MEDIUM;

/**
 * Isomorphic timeout helper — 兼容 Node.js 和浏览器环境。
 * @param {number} ms - 超时时间（毫秒）
 * @returns {Promise<never>} 在指定毫秒后reject的Promise
 * @private
 */
function _timeoutPromise(ms) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('MetaSkill execution timed out after ' + ms + 'ms'));
    }, ms);
    if (typeof timer === 'object' && timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

/**
 * 预置的5个高阶Meta Skill定义。
 * 参考OpenSquilla Meta Skill功能，将多个原子技能组合为单一可调用单元。
 * @constant {Object<string, Object>}
 * @readonly
 */
const PRESETS = {
  'meta-fullstack-build': {
    id: 'meta-fullstack-build',
    name: '全栈构建',
    description: '从需求分析到部署上线的完整开发流水线',
    phases: [
      { phase: 'analyze', skills: ['requirement-analysis'], onFailure: 'stop' },
      { phase: 'design', skills: ['architecture-design'], onFailure: 'stop' },
      { phase: 'implement', skills: ['tdd-implement', 'module-development'], onFailure: 'retry' },
      { phase: 'test', skills: ['integration-testing'], onFailure: 'retry' },
      { phase: 'deploy', skills: ['deployment'], onFailure: 'stop' },
    ],
    estimatedTokens: 50000,
  },
  'meta-code-quality': {
    id: 'meta-code-quality',
    name: '代码质量审查',
    description: '全面的代码质量审查流水线：审查→安全审计→重构→性能优化',
    phases: [
      { phase: 'review', skills: ['code-review'], onFailure: 'skip' },
      { phase: 'audit', skills: ['security-audit'], onFailure: 'skip' },
      { phase: 'refactor', skills: ['refactor-code'], onFailure: 'skip' },
      { phase: 'optimize', skills: ['performance-optimization'], onFailure: 'skip' },
    ],
    estimatedTokens: 30000,
  },
  'meta-debug-fix': {
    id: 'meta-debug-fix',
    name: '调试修复',
    description: '系统化调试→缺陷修复→完成验证的完整调试流水线',
    phases: [
      { phase: 'debug', skills: ['systematic-debugging'], onFailure: 'stop' },
      { phase: 'fix', skills: ['bug-fix'], onFailure: 'retry' },
      { phase: 'verify', skills: ['verification-before-completion'], onFailure: 'stop' },
    ],
    estimatedTokens: 20000,
  },
  'meta-documentation': {
    id: 'meta-documentation',
    name: '文档生成',
    description: '文档编写→自动文档生成→代码审查的文档化流水线',
    phases: [
      { phase: 'write', skills: ['documentation'], onFailure: 'retry' },
      { phase: 'generate', skills: ['auto-doc-generation'], onFailure: 'skip' },
    ],
    estimatedTokens: 15000,
  },
  'meta-research-build': {
    id: 'meta-research-build',
    name: '调研构建',
    description: '头脑风暴→AI调研→需求分析→架构设计的研究驱动开发流水线',
    phases: [
      { phase: 'explore', skills: ['brainstorming'], onFailure: 'stop' },
      { phase: 'research', skills: ['ai-research'], onFailure: 'skip' },
      { phase: 'analyze', skills: ['requirement-analysis'], onFailure: 'stop' },
      { phase: 'design', skills: ['architecture-design'], onFailure: 'stop' },
    ],
    estimatedTokens: 40000,
  },
};

/**
 * 默认配置选项。
 * @constant {Object}
 * @private
 */
const DEFAULT_OPTIONS = {
  timeoutPerSkill: DEFAULT_TIMEOUT_PER_SKILL,
  maxTotalTimeout: MAX_TOTAL_TIMEOUT,
  maxPhases: MAX_PHASES,
  maxSkillsPerPhase: MAX_SKILLS_PER_PHASE,
  includePresets: true,
};

/**
 * 有效的onFailure策略值集合。
 * @constant {Set<string>}
 * @private
 */
const VALID_FAILURE_STRATEGIES = new Set(Object.values(FAILURE_STRATEGIES));

/**
 * 有效的模型层级值集合。
 * @constant {Set<string>}
 * @private
 */
const VALID_MODEL_TIERS = new Set(Object.values(MODEL_TIERS));

/**
 * @module runtime/skill/meta-skill-orchestrator
 * @class MetaSkillOrchestrator
 * @extends EventEmitter
 *
 * Meta Skill编排系统——将多个原子技能组合为单一可调用单元。
 * 参考OpenSquilla的Meta Skill功能，支持多阶段流水线编排、
 * 模型路由决策、Token使用追踪和失败策略处理。
 *
 * 核心能力：
 * 1. 注册和管理Meta Skill定义
 * 2. 按阶段顺序编排多个原子技能的执行
 * 3. 模型路由：根据技能层级分配small/medium/large模型
 * 4. 失败策略：stop/skip/retry三种处理策略
 * 5. Token使用量估算和追踪
 * 6. 5个预置Meta Skill（全栈构建/代码质量/调试修复/文档生成/调研构建）
 * 7. 自动生成Meta Skill（通过LLM集成）
 *
 * @emits meta-skill-started      当Meta Skill开始执行时，载荷 { metaSkillId, context }
 * @emits phase-started           当某个阶段开始时，载荷 { metaSkillId, phase, skills }
 * @emits skill-executed          当单个技能执行完成时，载荷 { metaSkillId, phase, skillId, success, result, tokensUsed, duration }
 * @emits phase-completed         当某个阶段完成时，载荷 { metaSkillId, phase, skills }
 * @emits meta-skill-completed    当Meta Skill完成时，载荷 { metaSkillId, phases, totalTokens, totalDuration }
 * @emits meta-skill-failed       当Meta Skill失败时，载荷 { metaSkillId, phase, skillId, error }
 * @emits model-routing-decision  当模型路由决策时，载荷 { skillId, modelTier, estimatedCost }
 * @emits token-usage             当追踪Token使用时，载荷 { metaSkillId, skillId, tokensUsed }
 * @emits meta-skill-generated    当自动生成Meta Skill时，载荷 { metaSkillId, definition }
 */
class MetaSkillOrchestrator extends EventEmitter {
  /**
   * 创建MetaSkillOrchestrator实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.timeoutPerSkill=300000] - 每个技能执行的超时时间（毫秒）
   * @param {number} [options.maxTotalTimeout=1800000] - 最大总超时时间（毫秒）
   * @param {number} [options.maxPhases=10] - 最大阶段数
   * @param {number} [options.maxSkillsPerPhase=5] - 每个阶段最大技能数
   * @param {boolean} [options.includePresets=true] - 是否自动注册预置Meta Skill
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});

    /** @type {Map<string, Object>} 已注册的Meta Skill定义，key为metaSkillId */
    this._metaSkills = new Map();

    /** @type {Map<string, Object>} 正在执行的Meta Skill，key为executionId */
    this._runningExecutions = new Map();

    /** @type {Object} 执行统计信息 */
    this._stats = {
      registered: 0,
      executions: 0,
      completions: 0,
      failures: 0,
      totalTokensUsed: 0,
      totalDurationMs: 0,
    };

    // 自动注册预置Meta Skill
    if (this._options.includePresets !== false) {
      for (const [id, definition] of Object.entries(PRESETS)) {
        try {
          this._registerInternal(id, definition);
        } catch (err) {
          debug('MetaSkillOrchestrator', 'preset-register', err);
        }
      }
    }
  }

  /**
   * 内部注册方法，跳过guardShutdown检查（供构造函数使用）。
   * @param {string} metaSkillId - Meta Skill ID
   * @param {Object} definition - Meta Skill定义
   * @throws {TypeError} 当定义无效时抛出
   * @private
   */
  _registerInternal(metaSkillId, definition) {
    this._validateDefinition(definition);
    if (this._metaSkills.has(metaSkillId)) {
      debug('MetaSkillOrchestrator', 'overwrite', 'MetaSkill "' + metaSkillId + '" is being overwritten');
    }
    if (this._metaSkills.size >= MAX_META_SKILLS && !this._metaSkills.has(metaSkillId)) {
      const oldestKey = this._metaSkills.keys().next().value;
      this._metaSkills.delete(oldestKey);
    }
    this._metaSkills.set(metaSkillId, this._normalizeDefinition(definition));
    this._stats.registered = this._metaSkills.size;
  }

  /**
   * 注册一个新的Meta Skill定义。
   * @param {Object} definition - Meta Skill定义对象
   * @param {string} definition.id - 唯一标识符
   * @param {string} definition.name - 人类可读名称
   * @param {string} definition.description - 功能描述
   * @param {Array<Object>} definition.phases - 阶段数组，每个阶段包含phase/skills/onFailure/condition
   * @param {Object} [definition.modelPreference] - 可选的模型路由偏好
   * @param {number} [definition.estimatedTokens] - 估算的Token消耗
   * @returns {MetaSkillOrchestrator} 当前实例，支持链式调用
   * @throws {TypeError} 当定义无效时抛出
   */
  registerMetaSkill(definition) {
    this.guardShutdown();
    if (!definition || typeof definition !== 'object') {
      throw new TypeError('MetaSkillOrchestrator.registerMetaSkill: definition must be a non-null object');
    }
    const metaSkillId = definition.id;
    if (!metaSkillId || typeof metaSkillId !== 'string') {
      throw new TypeError('MetaSkillOrchestrator.registerMetaSkill: definition.id must be a non-empty string');
    }
    this._validateDefinition(definition);
    if (this._metaSkills.has(metaSkillId)) {
      debug('MetaSkillOrchestrator', 'overwrite', 'MetaSkill "' + metaSkillId + '" is being overwritten');
    }
    if (this._metaSkills.size >= MAX_META_SKILLS && !this._metaSkills.has(metaSkillId)) {
      const oldestKey = this._metaSkills.keys().next().value;
      this._metaSkills.delete(oldestKey);
    }
    this._metaSkills.set(metaSkillId, this._normalizeDefinition(definition));
    this._stats.registered = this._metaSkills.size;
    return this;
  }

  /**
   * 执行一个已注册的Meta Skill。
   *
   * 按阶段顺序执行所有技能，支持失败策略（stop/skip/retry）、
   * 模型路由决策、Token使用追踪和超时控制。
   *
   * @param {string} metaSkillId - 要执行的Meta Skill ID
   * @param {Object} [context] - 执行上下文，会传递给每个技能执行器
   * @param {Object} [context.skillExecutor] - 技能执行器函数，签名为 (skillId, context) => Promise<{success, result, tokensUsed}>
   * @param {Object} [context.modelRouter] - 模型路由器函数，签名为 (skillId, modelTier) => { tier, estimatedCost }
   * @param {Object} [context.tokenTracker] - Token追踪器，签名为 (skillId, tokensUsed) => void
   * @param {Object} [context.variables] - 可在阶段间传递的共享变量
   * @returns {Promise<Object>} 执行结果，包含 success, phases, totalTokens, totalDuration, modelRouting
   * @throws {Error} 当Meta Skill未注册或执行器未提供时抛出
   */
  async executeMetaSkill(metaSkillId, context) {
    this.guardShutdown();
    if (!metaSkillId || typeof metaSkillId !== 'string') {
      throw new TypeError('MetaSkillOrchestrator.executeMetaSkill: metaSkillId must be a non-empty string');
    }
    const definition = this._metaSkills.get(metaSkillId);
    if (!definition) {
      throw new Error('MetaSkillOrchestrator.executeMetaSkill: MetaSkill "' + metaSkillId + '" is not registered');
    }
    const ctx = context ?? {};

    const executionId = 'exec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const executionRecord = this._initExecutionRecord(executionId, metaSkillId);
    const state = { phaseResults: [], totalTokens: 0, allSuccess: true, aborted: false };
    const startTime = Date.now();

    this.emit('meta-skill-started', { metaSkillId, context: ctx });

    try {
      let totalTimer;
      const totalTimeoutPromise = new Promise((_, reject) => {
        totalTimer = setTimeout(() => {
          reject(new Error('MetaSkill execution timed out after ' + this._options.maxTotalTimeout + 'ms'));
        }, this._options.maxTotalTimeout);
        if (totalTimer && typeof totalTimer.unref === 'function') totalTimer.unref();
      });

      await Promise.race([
        this._runPhases(definition, ctx, executionRecord, state, startTime),
        totalTimeoutPromise,
      ]);
      if (totalTimer) clearTimeout(totalTimer);
    } catch (err) {
      state.allSuccess = false;
      this.emit('meta-skill-failed', {
        metaSkillId,
        phase: null,
        skillId: null,
        error: err && err.message ? err.message : String(err),
      });
      this._stats.failures++;
      this._runningExecutions.delete(executionId);
      return this._buildFailureResult(state, err && err.message ? err.message : String(err), startTime, executionRecord);
    }

    return this._finalizeExecution(metaSkillId, executionId, state, executionRecord, startTime);
  }

  /**
   * 按阶段顺序执行所有阶段。
   * @param {Object} definition - Meta Skill定义
   * @param {Object} ctx - 执行上下文
   * @param {Object} executionRecord - 执行记录
   * @param {Object} state - 执行状态
   * @param {number} startTime - 开始时间戳
   * @returns {Promise<Object|null>} 失败时返回失败结果，成功时返回null
   * @private
   */
  async _runPhases(definition, ctx, executionRecord, state, startTime) {
    for (let i = 0; i < definition.phases.length; i++) {
      if (this._shutDown) {
        state.aborted = true;
        break;
      }
      const phaseDef = definition.phases[i];
      const phaseName = phaseDef.phase;

      if (phaseDef.condition) {
        const shouldRun = this._evaluateCondition(phaseDef.condition, ctx);
        if (!shouldRun) {
          debug('MetaSkillOrchestrator', 'phase-skipped', 'Phase "' + phaseName + '" skipped due to condition');
          state.phaseResults.push({ phase: phaseName, skills: [], skipped: true, reason: 'condition-not-met' });
          continue;
        }
      }

      this.emit('phase-started', { metaSkillId: definition.id, phase: phaseName, skills: phaseDef.skills });

      const skillResult = await this._executePhaseSkills(
        phaseDef, ctx, executionRecord, state, definition, startTime,
      );
      if (skillResult !== null) return skillResult; // 失败且策略为STOP

      if (state.aborted) break;

      this.emit('phase-completed', { metaSkillId: definition.id, phase: phaseName, skills: state._lastPhaseSkills });
    }

    if (state.aborted) state.allSuccess = false;
    return null;
  }

  /**
   * 执行单个阶段内的所有技能。
   * @param {Object} phaseDef - 阶段定义
   * @param {Object} ctx - 执行上下文
   * @param {Object} executionRecord - 执行记录
   * @param {Object} state - 执行状态
   * @param {Object} definition - Meta Skill定义
   * @param {number} startTime - 开始时间戳
   * @returns {Promise<Object|null>} 失败且STOP时返回失败结果，否则返回null
   * @private
   */
  async _executePhaseSkills(phaseDef, ctx, executionRecord, state, definition, startTime) {
    const phaseSkillResults = [];
    const phaseName = phaseDef.phase;

    for (const skillId of phaseDef.skills) {
      if (this._shutDown) {
        state.aborted = true;
        break;
      }

      this._emitModelRouting(skillId, definition, ctx, executionRecord);

      const skillEntry = await this._executeSingleSkill(skillId, phaseDef, ctx, state);
      phaseSkillResults.push(skillEntry);
      executionRecord.totalTokens += skillEntry.tokensUsed;
      state.totalTokens += skillEntry.tokensUsed;

      this._emitSkillEvents(definition.id, phaseName, skillId, skillEntry, ctx);

      if (!skillEntry.success) {
        const failureStrategy = phaseDef.onFailure || FAILURE_STRATEGIES.STOP;
        if (failureStrategy === FAILURE_STRATEGIES.STOP) {
          return this._handleSkillStop(definition.id, executionRecord, state, phaseName, skillId, skillEntry, phaseSkillResults, startTime);
        }
        debug('MetaSkillOrchestrator', 'skill-failed-skip', 'Skill "' + skillId + '" failed but phase continues');
      }
    }

    state._lastPhaseSkills = phaseSkillResults;
    state.phaseResults.push({ phase: phaseName, skills: phaseSkillResults, duration: 0 });
    return null;
  }

  /**
   * 执行单个技能（带超时和重试）。
   * @param {string} skillId - 技能ID
   * @param {Object} phaseDef - 阶段定义
   * @param {Object} ctx - 执行上下文
   * @param {Object} state - 执行状态
   * @returns {Promise<Object>} 技能执行条目
   * @private
   */
  async _executeSingleSkill(skillId, phaseDef, ctx, state) {
    const skillStartTime = Date.now();
    let skillResult = null;
    let skillError = null;
    let retries = 0;
    let shouldRetry = true;

    while (shouldRetry) {
      try {
        const skillPromise = ctx.skillExecutor
          ? Promise.resolve(ctx.skillExecutor(skillId, {
            ...ctx,
            phase: phaseDef.phase,
            metaSkillId: ctx.metaSkillId,
            phaseResults: state.phaseResults.slice(),
            skillResults: (state._lastPhaseSkills ?? []).slice(),
          }))
          : Promise.reject(new Error('No skillExecutor provided in context'));

        let skillTimer;
        const skillTimeoutPromise = new Promise((_, reject) => {
          skillTimer = setTimeout(() => {
            reject(new Error('Skill execution timed out after ' + this._options.timeoutPerSkill + 'ms'));
          }, this._options.timeoutPerSkill);
          if (skillTimer && typeof skillTimer.unref === 'function') skillTimer.unref();
        });

        skillResult = await Promise.race([
          skillPromise,
          skillTimeoutPromise,
        ]);
        if (skillTimer) clearTimeout(skillTimer);
        skillError = null;
      } catch (err) {
        skillError = err;
        skillResult = null;
        debug('MetaSkillOrchestrator', 'skill-error', err);
      }

      if (skillError && phaseDef.onFailure === FAILURE_STRATEGIES.RETRY && retries < 1) {
        retries++;
        debug('MetaSkillOrchestrator', 'skill-retry', 'Retrying skill "' + skillId + '" (attempt ' + (retries + 1) + ')');
        continue;
      }
      shouldRetry = false;
    }

    const skillDuration = Date.now() - skillStartTime;
    const skillSuccess = skillResult && skillResult.success !== false;
    const skillTokens = (skillResult && Number.isFinite(skillResult.tokensUsed))
      ? skillResult.tokensUsed
      : (skillResult && skillResult.result ? estimateTokens(String(skillResult.result)) : 0);

    return {
      skillId,
      success: skillSuccess,
      result: skillResult ? skillResult.result : null,
      error: skillError ? (skillError.message || String(skillError)) : null,
      tokensUsed: skillTokens,
      duration: skillDuration,
      retries,
    };
  }

  /**
   * 初始化执行记录。
   * @param {string} executionId - 执行ID
   * @param {string} metaSkillId - Meta Skill ID
   * @returns {Object} 执行记录
   * @private
   */
  _initExecutionRecord(executionId, metaSkillId) {
    const record = {
      executionId,
      metaSkillId,
      startedAt: Date.now(),
      phases: [],
      totalTokens: 0,
      modelRouting: [],
    };
    this._runningExecutions.set(executionId, record);
    this._stats.executions++;
    return record;
  }

  /**
   * 发出模型路由事件。
   * @param {string} skillId - 技能ID
   * @param {Object} definition - Meta Skill定义
   * @param {Object} ctx - 执行上下文
   * @param {Object} executionRecord - 执行记录
   * @private
   */
  _emitModelRouting(skillId, definition, ctx, executionRecord) {
    const modelTier = this._resolveModelTier(skillId, definition);
    const routingDecision = {
      skillId,
      modelTier,
      estimatedCost: ctx.modelRouter ? (
        safeExecute(() => ctx.modelRouter(skillId, modelTier), 'MetaSkillOrchestrator', 'modelRouter') ?? null
      ) : null,
    };
    executionRecord.modelRouting.push(routingDecision);
    this.emit('model-routing-decision', routingDecision);
  }

  /**
   * 发出技能执行相关事件。
   * @param {string} metaSkillId - Meta Skill ID
   * @param {string} phaseName - 阶段名称
   * @param {string} skillId - 技能ID
   * @param {Object} skillEntry - 技能执行条目
   * @param {Object} ctx - 执行上下文
   * @private
   */
  _emitSkillEvents(metaSkillId, phaseName, skillId, skillEntry, ctx) {
    this.emit('skill-executed', {
      metaSkillId,
      phase: phaseName,
      skillId,
      success: skillEntry.success,
      result: skillEntry.result,
      tokensUsed: skillEntry.tokensUsed,
      duration: skillEntry.duration,
    });
    this.emit('token-usage', { metaSkillId, skillId, tokensUsed: skillEntry.tokensUsed });
    if (ctx.tokenTracker) {
      safeCall(() => ctx.tokenTracker(skillId, skillEntry.tokensUsed), 'MetaSkillOrchestrator', 'tokenTracker');
    }
  }

  /**
   * 处理技能失败且策略为STOP的情况。
   * @param {string} metaSkillId - Meta Skill ID
   * @param {Object} executionRecord - 执行记录
   * @param {Object} state - 执行状态
   * @param {string} phaseName - 阶段名称
   * @param {string} skillId - 技能ID
   * @param {Object} skillEntry - 技能执行条目
   * @param {Array} phaseSkillResults - 当前阶段技能结果
   * @param {number} startTime - 开始时间戳
   * @returns {Object} 失败结果
   * @private
   */
  _handleSkillStop(metaSkillId, executionRecord, state, phaseName, skillId, skillEntry, phaseSkillResults, startTime) {
    state.allSuccess = false;
    this.emit('meta-skill-failed', { metaSkillId, phase: phaseName, skillId, error: skillEntry.error });
    this._stats.failures++;
    this._runningExecutions.delete(executionRecord.executionId);
    return {
      success: false,
      phases: state.phaseResults.concat([{ phase: phaseName, skills: phaseSkillResults }]),
      failedPhase: phaseName,
      failedSkill: skillId,
      error: skillEntry.error,
      totalTokens: state.totalTokens,
      totalDuration: Date.now() - startTime,
      modelRouting: executionRecord.modelRouting,
    };
  }

  /**
   * 构建失败结果。
   * @param {Object} state - 执行状态
   * @param {string} error - 错误消息
   * @param {number} startTime - 开始时间戳
   * @param {Object} executionRecord - 执行记录
   * @returns {Object} 失败结果
   * @private
   */
  _buildFailureResult(state, error, startTime, executionRecord) {
    return {
      success: false,
      phases: state.phaseResults,
      error,
      totalTokens: state.totalTokens,
      totalDuration: Date.now() - startTime,
      modelRouting: executionRecord.modelRouting,
    };
  }

  /**
   * 完成执行并返回结果。
   * @param {string} metaSkillId - Meta Skill ID
   * @param {string} executionId - 执行ID
   * @param {Object} state - 执行状态
   * @param {Object} executionRecord - 执行记录
   * @param {number} startTime - 开始时间戳
   * @returns {Object} 执行结果
   * @private
   */
  _finalizeExecution(metaSkillId, executionId, state, executionRecord, startTime) {
    const totalDuration = Date.now() - startTime;
    executionRecord.phases = state.phaseResults;
    this._stats.completions++;
    this._stats.totalTokensUsed += state.totalTokens;
    this._stats.totalDurationMs += totalDuration;

    this.emit('meta-skill-completed', {
      metaSkillId,
      phases: state.phaseResults,
      totalTokens: state.totalTokens,
      totalDuration,
    });

    this._runningExecutions.delete(executionId);

    return {
      success: state.allSuccess,
      phases: state.phaseResults,
      totalTokens: state.totalTokens,
      totalDuration,
      modelRouting: executionRecord.modelRouting,
    };
  }

  /**
   * 获取指定Meta Skill的定义。
   * @param {string} metaSkillId - Meta Skill ID
   * @returns {Object|null} Meta Skill定义对象，未注册时返回null
   */
  getMetaSkill(metaSkillId) {
    this.guardShutdown();
    if (!metaSkillId || typeof metaSkillId !== 'string') return null;
    const definition = this._metaSkills.get(metaSkillId);
    return definition ? this._cloneDefinition(definition) : null;
  }

  /**
   * 列出所有已注册的Meta Skill。
   * @returns {Array<Object>} Meta Skill定义摘要数组，每个元素包含id/name/description/estimatedTokens
   */
  listMetaSkills() {
    this.guardShutdown();
    const result = [];
    for (const [_id, def] of this._metaSkills) {
      result.push({
        id: def.id,
        name: def.name,
        description: def.description,
        phaseCount: def.phases ? def.phases.length : 0,
        skillCount: def.phases ? def.phases.reduce((sum, p) => sum + (p.skills ? p.skills.length : 0), 0) : 0,
        estimatedTokens: def.estimatedTokens ?? 0,
      });
    }
    return result;
  }

  /**
   * 估算指定Meta Skill的Token消耗。
   * @param {string} metaSkillId - Meta Skill ID
   * @returns {number} 估算的Token消耗，未注册时返回0
   */
  estimateTokens(metaSkillId) {
    this.guardShutdown();
    if (!metaSkillId || typeof metaSkillId !== 'string') return 0;
    const definition = this._metaSkills.get(metaSkillId);
    if (!definition) return 0;
    if (typeof definition.estimatedTokens === 'number' && definition.estimatedTokens > 0) {
      return definition.estimatedTokens;
    }
    let total = 0;
    if (definition.phases) {
      for (const phase of definition.phases) {
        if (phase.skills) {
          total += phase.skills.length * 5000;
        }
      }
    }
    return total;
  }

  /**
   * 从任务描述自动生成Meta Skill定义。
   *
   * 这是一个占位方法——实际生成依赖外部LLM集成。
   * 该方法会验证availableSkills，构建prompt，然后发出 meta-skill-generate-request 事件
   * 供外部LLM处理器使用。
   *
   * @param {string} taskDescription - 任务描述，用于指导生成
   * @param {Array<string>} availableSkills - 可用的技能ID列表
   * @returns {Object} 生成请求的元数据，包含 { requestId, taskDescription, availableSkills, prompt }
   */
  generateMetaSkill(taskDescription, availableSkills) {
    this.guardShutdown();
    if (!taskDescription || typeof taskDescription !== 'string') {
      throw new TypeError('MetaSkillOrchestrator.generateMetaSkill: taskDescription must be a non-empty string');
    }
    if (!Array.isArray(availableSkills)) {
      throw new TypeError('MetaSkillOrchestrator.generateMetaSkill: availableSkills must be an array');
    }

    const requestId = 'gen-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const prompt = this._buildGenerationPrompt(taskDescription, availableSkills);

    const request = {
      requestId,
      taskDescription,
      availableSkills: availableSkills.slice(),
      prompt,
      createdAt: new Date().toISOString(),
    };

    this.emit('meta-skill-generate-request', request);
    return request;
  }

  /**
   * 异步版本：通过LLM处理器生成Meta Skill定义。
   *
   * @param {string} taskDescription - 任务描述
   * @param {Array<string>} availableSkills - 可用技能ID列表
   * @param {Function} llmHandler - LLM调用函数，签名为 async (prompt: string) => string|object
   * @returns {Promise<Object>} 生成结果 { success, definition?, requestId, error? }
   */
  async generateMetaSkillAsync(taskDescription, availableSkills, llmHandler) {
    this.guardShutdown();
    if (!taskDescription || typeof taskDescription !== 'string') {
      throw new TypeError('MetaSkillOrchestrator.generateMetaSkillAsync: taskDescription must be a non-empty string');
    }
    if (!Array.isArray(availableSkills)) {
      throw new TypeError('MetaSkillOrchestrator.generateMetaSkillAsync: availableSkills must be an array');
    }
    if (typeof llmHandler !== 'function') {
      throw new TypeError('MetaSkillOrchestrator.generateMetaSkillAsync: llmHandler must be a function');
    }

    const requestId = 'gen-async-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const prompt = this._buildGenerationPrompt(taskDescription, availableSkills);

    try {
      const rawResponse = await llmHandler(prompt);
      let definition;

      if (typeof rawResponse === 'string') {
        // Try to extract JSON from the response
        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          definition = JSON.parse(jsonMatch[0]);
        } else {
          return { success: false, error: 'No JSON found in LLM response', requestId };
        }
      } else if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
        definition = rawResponse;
      } else {
        return { success: false, error: 'LLM response must be a JSON string or object', requestId };
      }

      const validation = this.validateMetaSkill(definition);
      if (!validation.valid) {
        return { success: false, error: 'Generated definition is invalid: ' + validation.errors.join('; '), requestId };
      }

      this.emit('meta-skill-generated', { definition, requestId });
      return { success: true, definition, requestId };
    } catch (err) {
      return { success: false, error: 'LLM generation failed: ' + (err && err.message ? err.message : String(err)), requestId };
    }
  }

  /**
   * 从预定义模板生成Meta Skill定义。
   *
   * @param {string} templateName - 模板名称
   * @param {Object} params - 模板参数 { name?, availableSkills }
   * @returns {Object} 生成结果 { success, definition?, error? }
   */
  generateFromTemplate(templateName, params) {
    this.guardShutdown();
    if (!templateName || typeof templateName !== 'string') {
      return { success: false, error: 'Template name is required' };
    }

    const template = MetaSkillOrchestrator.TEMPLATES[templateName];
    if (!template) {
      return { success: false, error: 'Unknown template: ' + templateName };
    }

    const availableSkills = (params && Array.isArray(params.availableSkills)) ? params.availableSkills : [];
    const name = (params && params.name) || template.name;

    const definition = {
      id: template.id || 'meta-' + templateName,
      name,
      description: template.description || '',
      phases: [],
    };

    for (const phaseTemplate of template.phases) {
      const phase = {
        phase: phaseTemplate.phase,
        onFailure: phaseTemplate.onFailure || 'stop',
        skills: [],
      };

      for (const preferredSkill of phaseTemplate.skills) {
        if (availableSkills.includes(preferredSkill)) {
          phase.skills.push(preferredSkill);
        }
      }

      // If no skills matched, include all available skills as fallback
      if (phase.skills.length === 0 && availableSkills.length > 0) {
        phase.skills = availableSkills.slice(0, 3);
      }

      definition.phases.push(phase);
    }

    if (definition.phases.length === 0) {
      // Fallback: single phase with all available skills
      definition.phases.push({
        phase: 'execute',
        skills: availableSkills.length > 0 ? availableSkills.slice(0, 3) : [],
        onFailure: 'stop',
      });
    }

    this.emit('meta-skill-generated', { definition, templateName });
    return { success: true, definition };
  }

  /**
   * 自动注册生成后的Meta Skill定义。
   *
   * @param {Object} definition - 待注册的Meta Skill定义
   * @returns {Object} 注册结果 { success, metaSkillId?, error? }
   */
  autoRegisterGenerated(definition) {
    this.guardShutdown();
    if (!definition || typeof definition !== 'object') {
      return { success: false, error: 'Definition must be a non-null object' };
    }

    const validation = this.validateMetaSkill(definition);
    if (!validation.valid) {
      return { success: false, error: 'Generated definition is invalid: ' + validation.errors.join('; ') };
    }

    const metaSkillId = definition.id || definition.name;
    this.registerMetaSkill(definition);
    return { success: true, metaSkillId };
  }

  /**
   * 获取所有可用的模板名称列表。
   *
   * @returns {Array<string>} 模板名称数组
   */
  getAvailableTemplates() {
    return Object.keys(MetaSkillOrchestrator.TEMPLATES);
  }

  /**
   * 验证Meta Skill定义的合法性。
   *
   * 检查项：
   * - 必填字段（id/name/phases）
   * - 阶段数不超过最大值
   * - 每个阶段的技能数不超过最大值
   * - onFailure策略值有效
   * - 所有引用的技能ID格式有效
   *
   * @param {Object} definition - 待验证的Meta Skill定义
   * @returns {Object} 验证结果 { valid: boolean, errors: Array<string>, warnings: Array<string> }
   */
  validateMetaSkill(definition) {
    this.guardShutdown();
    const errors = [];
    const warnings = [];

    if (!definition || typeof definition !== 'object') {
      return { valid: false, errors: ['Definition must be a non-null object'], warnings: [] };
    }

    this._validateRequiredFields(definition, errors);
    if (!Array.isArray(definition.phases)) {
      return { valid: false, errors, warnings };
    }

    this._validatePhases(definition, errors, warnings);
    this._validateModelPreference(definition, errors);
    this._validateEstimatedTokens(definition, errors);

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * 验证必填字段。
   * @param {Object} definition - Meta Skill定义
   * @param {Array<string>} errors - 错误列表
   * @private
   */
  _validateRequiredFields(definition, errors) {
    if (!definition.id || typeof definition.id !== 'string') {
      errors.push('Missing required field: id (must be a non-empty string)');
    }
    if (!definition.name || typeof definition.name !== 'string') {
      errors.push('Missing required field: name (must be a non-empty string)');
    }
    if (!Array.isArray(definition.phases)) {
      errors.push('Missing required field: phases (must be an array)');
    }
  }

  /**
   * 验证阶段数组。
   * @param {Object} definition - Meta Skill定义
   * @param {Array<string>} errors - 错误列表
   * @param {Array<string>} warnings - 警告列表
   * @private
   */
  _validatePhases(definition, errors, warnings) {
    if (definition.phases.length === 0) {
      errors.push('phases must contain at least one phase');
    }
    if (definition.phases.length > this._options.maxPhases) {
      errors.push('phases exceeds maximum of ' + this._options.maxPhases + ' (got ' + definition.phases.length + ')');
    }

    const phaseNames = new Set();
    for (let i = 0; i < definition.phases.length; i++) {
      this._validateSinglePhase(definition.phases[i], i, phaseNames, errors, warnings);
    }
  }

  /**
   * 验证单个阶段。
   * @param {Object} phase - 阶段定义
   * @param {number} index - 阶段索引
   * @param {Set<string>} phaseNames - 已出现的阶段名称集合
   * @param {Array<string>} errors - 错误列表
   * @param {Array<string>} warnings - 警告列表
   * @private
   */
  _validateSinglePhase(phase, index, phaseNames, errors, warnings) {
    if (!phase || typeof phase !== 'object') {
      errors.push('phases[' + index + ']: must be a non-null object');
      return;
    }
    if (!phase.phase || typeof phase.phase !== 'string') {
      errors.push('phases[' + index + ']: missing required field "phase" (phase name)');
    } else {
      if (phaseNames.has(phase.phase)) {
        errors.push('phases[' + index + ']: duplicate phase name "' + phase.phase + '"');
      }
      phaseNames.add(phase.phase);
    }
    if (!Array.isArray(phase.skills)) {
      errors.push('phases[' + index + ']: missing required field "skills" (must be an array)');
    } else {
      this._validatePhaseSkills(phase, index, errors, warnings);
    }
    if (phase.onFailure && !VALID_FAILURE_STRATEGIES.has(phase.onFailure)) {
      errors.push('phases[' + index + '] ("' + (phase.phase || 'unknown') + '"): invalid onFailure "' + phase.onFailure + '", must be one of: ' + Object.values(FAILURE_STRATEGIES).join(', '));
    }
    if (phase.condition !== undefined && phase.condition !== null) {
      if (typeof phase.condition !== 'function' && typeof phase.condition !== 'string') {
        errors.push('phases[' + index + '] ("' + (phase.phase || 'unknown') + '"): condition must be a function or string');
      }
    }
  }

  /**
   * 验证阶段内的技能列表。
   * @param {Object} phase - 阶段定义
   * @param {number} phaseIndex - 阶段索引
   * @param {Array<string>} errors - 错误列表
   * @param {Array<string>} warnings - 警告列表
   * @private
   */
  _validatePhaseSkills(phase, phaseIndex, errors, warnings) {
    if (phase.skills.length === 0) {
      warnings.push('phases[' + phaseIndex + '] ("' + (phase.phase || 'unknown') + '"): skills array is empty');
    }
    if (phase.skills.length > this._options.maxSkillsPerPhase) {
      errors.push('phases[' + phaseIndex + '] ("' + (phase.phase || 'unknown') + '"): skills exceeds maximum of ' + this._options.maxSkillsPerPhase + ' (got ' + phase.skills.length + ')');
    }
    for (let j = 0; j < phase.skills.length; j++) {
      if (typeof phase.skills[j] !== 'string' || !phase.skills[j]) {
        errors.push('phases[' + phaseIndex + '].skills[' + j + ']: must be a non-empty string');
      }
    }
  }

  /**
   * 验证模型偏好配置。
   * @param {Object} definition - Meta Skill定义
   * @param {Array<string>} errors - 错误列表
   * @private
   */
  _validateModelPreference(definition, errors) {
    if (!definition.modelPreference) return;
    if (typeof definition.modelPreference !== 'object') {
      errors.push('modelPreference must be an object mapping skillId to modelTier');
      return;
    }
    for (const [skillId, tier] of Object.entries(definition.modelPreference)) {
      if (!VALID_MODEL_TIERS.has(tier)) {
        errors.push('modelPreference["' + skillId + '"]: invalid modelTier "' + tier + '", must be one of: ' + Object.values(MODEL_TIERS).join(', '));
      }
    }
  }

  /**
   * 验证estimatedTokens字段。
   * @param {Object} definition - Meta Skill定义
   * @param {Array<string>} errors - 错误列表
   * @private
   */
  _validateEstimatedTokens(definition, errors) {
    if (definition.estimatedTokens !== undefined && definition.estimatedTokens !== null) {
      if (typeof definition.estimatedTokens !== 'number' || definition.estimatedTokens < 0 || !Number.isFinite(definition.estimatedTokens)) {
        errors.push('estimatedTokens must be a non-negative finite number');
      }
    }
  }

  /**
   * 获取当前执行统计信息。
   * @returns {Object} 统计信息 { registered, executions, completions, failures, totalTokensUsed, totalDurationMs }
   */
  getStats() {
    this.guardShutdown();
    return { ...this._stats };
  }

  /**
   * 取消正在进行的Meta Skill执行。
   * @param {string} executionId - 执行ID
   * @returns {boolean} 是否成功取消
   */
  cancelExecution(executionId) {
    this.guardShutdown();
    if (!executionId || !this._runningExecutions.has(executionId)) return false;
    this._runningExecutions.delete(executionId);
    debug('MetaSkillOrchestrator', 'cancel', 'Execution "' + executionId + '" cancelled');
    return true;
  }

  /**
   * 获取正在进行的执行列表。
   * @returns {Array<Object>} 执行记录数组
   */
  getRunningExecutions() {
    this.guardShutdown();
    const result = [];
    for (const [, record] of this._runningExecutions) {
      result.push({
        executionId: record.executionId,
        metaSkillId: record.metaSkillId,
        startedAt: record.startedAt,
        elapsed: Date.now() - record.startedAt,
        totalTokens: record.totalTokens,
      });
    }
    return result;
  }

  // ---- 私有方法 ----

  /**
   * 验证并抛出Meta Skill定义错误。
   * @param {Object} definition - 原始定义
   * @throws {TypeError} 当定义无效时抛出
   * @private
   */
  _validateDefinition(definition) {
    const validation = this.validateMetaSkill(definition);
    if (!validation.valid) {
      throw new TypeError('MetaSkillOrchestrator: invalid definition - ' + validation.errors.join('; '));
    }
  }

  /**
   * 规范化Meta Skill定义，补充默认值。
   * @param {Object} definition - 原始定义
   * @returns {Object} 规范化后的定义
   * @private
   */
  _normalizeDefinition(definition) {
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description || '',
      phases: (definition.phases ?? []).map(phase => ({
        phase: phase.phase,
        skills: Array.isArray(phase.skills) ? phase.skills.slice() : [],
        onFailure: phase.onFailure && VALID_FAILURE_STRATEGIES.has(phase.onFailure)
          ? phase.onFailure
          : FAILURE_STRATEGIES.STOP,
        condition: phase.condition ?? null,
      })),
      modelPreference: definition.modelPreference ?? {},
      estimatedTokens: (typeof definition.estimatedTokens === 'number' && definition.estimatedTokens >= 0)
        ? definition.estimatedTokens
        : 0,
    };
  }

  /**
   * 深拷贝Meta Skill定义（避免外部修改内部状态）。
   * @param {Object} definition - 原始定义
   * @returns {Object} 拷贝后的定义
   * @private
   */
  _cloneDefinition(definition) {
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      phases: (definition.phases ?? []).map(phase => ({
        phase: phase.phase,
        skills: Array.isArray(phase.skills) ? phase.skills.slice() : [],
        onFailure: phase.onFailure,
        condition: phase.condition,
      })),
      modelPreference: definition.modelPreference ? { ...definition.modelPreference } : {},
      estimatedTokens: definition.estimatedTokens,
    };
  }

  /**
   * 解析技能对应的模型层级。
   * 优先使用Meta Skill定义中的modelPreference，否则回退到默认层级。
   * @param {string} skillId - 技能ID
   * @param {Object} definition - Meta Skill定义
   * @returns {string} 模型层级（small/medium/large）
   * @private
   */
  _resolveModelTier(skillId, definition) {
    if (definition.modelPreference && definition.modelPreference[skillId]) {
      return definition.modelPreference[skillId];
    }
    return DEFAULT_MODEL_TIER;
  }

  /**
   * 评估阶段条件。
   * 支持函数类型（传入context）和字符串类型（简单真值检查）。
   * @param {Function|string} condition - 条件函数或字符串
   * @param {Object} context - 执行上下文
   * @returns {boolean} 条件是否满足
   * @private
   */
  _evaluateCondition(condition, context) {
    if (typeof condition === 'function') {
      try {
        return Boolean(condition(context));
      } catch (err) {
        debug('MetaSkillOrchestrator', 'condition-error', err);
        return false;
      }
    }
    if (typeof condition === 'string') {
      return condition.length > 0;
    }
    return true;
  }

  /**
   * 构建用于LLM生成Meta Skill的提示词。
   * @param {string} taskDescription - 任务描述
   * @param {Array<string>} availableSkills - 可用技能列表
   * @returns {string} 生成的提示词
   * @private
   */
  _buildGenerationPrompt(taskDescription, availableSkills) {
    const skillsList = availableSkills.map(s => '- ' + s).join('\n');
    return [
      'You are a Meta Skill composer. Given a task description and a list of available atomic skills,',
      'create a Meta Skill definition that orchestrates multiple skills into a coherent pipeline.',
      '',
      'Task Description: ' + taskDescription,
      '',
      'Available Skills:',
      skillsList,
      '',
      'Output a Meta Skill definition in JSON format with the following structure:',
      '{',
      '  "id": "meta-<descriptive-name>",',
      '  "name": "<Human-readable name>",',
      '  "description": "<What this Meta Skill does>",',
      '  "phases": [',
      '    { "phase": "<phase-name>", "skills": ["<skill-id>", ...], "onFailure": "stop|skip|retry" },',
      '    ...',
      '  ],',
      '  "modelPreference": { "<skill-id>": "small|medium|large", ... },',
      '  "estimatedTokens": <number>',
      '}',
      '',
      'Rules:',
      '- Maximum ' + this._options.maxPhases + ' phases',
      '- Maximum ' + this._options.maxSkillsPerPhase + ' skills per phase',
      '- onFailure must be one of: stop, skip, retry',
      '- Only use skills from the Available Skills list',
      '- Order phases logically (analysis → design → implementation → testing → deployment)',
    ].join('\n');
  }

  /**
   * 关闭时清理所有已注册的Meta Skill和运行中的执行。
   * @private
   */
  _onShutdown() {
    this._metaSkills.clear();
    this._runningExecutions.clear();
    this._stats = {
      registered: 0,
      executions: 0,
      completions: 0,
      failures: 0,
      totalTokensUsed: 0,
      totalDurationMs: 0,
    };
    this.removeAllListeners();
  }
}

// 静态属性
MetaSkillOrchestrator.PRESETS = PRESETS;
MetaSkillOrchestrator.MAX_PHASES = MAX_PHASES;
MetaSkillOrchestrator.MAX_SKILLS_PER_PHASE = MAX_SKILLS_PER_PHASE;
MetaSkillOrchestrator.DEFAULT_TIMEOUT_PER_SKILL = DEFAULT_TIMEOUT_PER_SKILL;
MetaSkillOrchestrator.MAX_TOTAL_TIMEOUT = MAX_TOTAL_TIMEOUT;

// 模板定义
MetaSkillOrchestrator.TEMPLATES = {
  'standard-pipeline': {
    id: 'meta-standard-pipeline',
    name: 'Standard Pipeline',
    description: '标准开发流水线：需求分析 → 架构设计 → TDD实现 → 集成测试 → 部署',
    phases: [
      { phase: 'analyze', skills: ['requirement-analysis', 'brainstorming'], onFailure: 'stop' },
      { phase: 'design', skills: ['architecture-design', 'document-parsing'], onFailure: 'stop' },
      { phase: 'implement', skills: ['tdd-implement', 'module-development'], onFailure: 'retry' },
      { phase: 'test', skills: ['integration-testing', 'systematic-debugging'], onFailure: 'retry' },
      { phase: 'deploy', skills: ['deployment'], onFailure: 'stop' },
    ],
  },
  'quality-assurance': {
    id: 'meta-quality-assurance',
    name: 'Quality Assurance',
    description: '质量保证流水线：代码审查 → 安全审计 → 调试 → 修复 → 验证',
    phases: [
      { phase: 'review', skills: ['code-review', 'code-review', 'refactor-code'], onFailure: 'skip' },
      { phase: 'audit', skills: ['security-audit'], onFailure: 'stop' },
      { phase: 'debug', skills: ['systematic-debugging'], onFailure: 'retry' },
      { phase: 'fix', skills: ['bug-fix'], onFailure: 'retry' },
      { phase: 'verify', skills: ['verification-before-completion'], onFailure: 'stop' },
    ],
  },
  'research-driven': {
    id: 'meta-research-driven',
    name: 'Research Driven',
    description: '研究驱动开发流水线：头脑风暴 → AI研究 → 需求分析 → 架构设计',
    phases: [
      { phase: 'ideate', skills: ['brainstorming'], onFailure: 'skip' },
      { phase: 'research', skills: ['ai-research'], onFailure: 'skip' },
      { phase: 'define', skills: ['requirement-analysis'], onFailure: 'stop' },
      { phase: 'architect', skills: ['architecture-design'], onFailure: 'stop' },
    ],
  },
};

MetaSkillOrchestrator.AVAILABLE_TEMPLATES = Object.keys(MetaSkillOrchestrator.TEMPLATES);
MetaSkillOrchestrator.FAILURE_STRATEGIES = FAILURE_STRATEGIES;
MetaSkillOrchestrator.MODEL_TIERS = MODEL_TIERS;

module.exports = withShutdown(MetaSkillOrchestrator);
