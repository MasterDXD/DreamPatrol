'use strict';

const { EventEmitter } = require('events');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

const COMPLEXITY_FACTORS = {
  reasoning_depth: { weight: 0.3, signals: ['architecture', 'design', 'brainstorm', 'debug', 'analyze'] },
  output_length: { weight: 0.2, signals: ['document', 'implement', 'develop', 'refactor'] },
  error_sensitivity: { weight: 0.25, signals: ['security', 'deploy', 'production', 'critical'] },
  pattern_complexity: { weight: 0.25, signals: ['test', 'format', 'lint', 'review'] },
};

const DEFAULT_SKILL_MODEL_MAP = {
  'brainstorming': { model: 'gpt-4o', reason: '创意探索需要发散思维' },
  'requirement-analysis': { model: 'gpt-4o-mini', reason: '需求分析模式较固定' },
  'architecture-design': { model: 'gpt-4o', reason: '架构决策影响全局，需要顶级推理' },
  'tdd-implement': { model: 'gpt-4o-mini', reason: 'TDD模式固定，中等推理即可' },
  'module-development': { model: 'gpt-4o-mini', reason: '编码需要理解但不需要顶级推理' },
  'code-review': { model: 'gpt-4o-mini', reason: '审查需要理解但模式较固定' },
  'verification-before-completion': { model: 'gpt-4o-mini', reason: '验证检查模式固定' },
  'bug-fix': { model: 'gpt-4o', reason: '调试需要深度推理' },
  'systematic-debugging': { model: 'gpt-4o', reason: '复杂调试需要深度推理' },
  'security-audit': { model: 'gpt-4o', reason: '安全审计需要深度推理' },
  'performance-optimization': { model: 'gpt-4o', reason: '性能优化需要深度分析' },
  'integration-testing': { model: 'gpt-3.5-turbo', reason: '测试执行模式固定' },
  'deployment': { model: 'gpt-3.5-turbo', reason: '部署脚本模式固定' },
  'documentation': { model: 'gpt-3.5-turbo', reason: '文档生成不需要强推理' },
  'refactor-code': { model: 'gpt-4o-mini', reason: '重构需要理解但模式较固定' },
  'iterative-deepening': { model: 'gpt-4o', reason: '深化推理需要顶级推理' },
  'multi-agent-fusion': { model: 'gpt-4o', reason: '多Agent融合需要顶级推理' },
  'pair-chat': { model: 'gpt-4o-mini', reason: '对话审查中等推理即可' },
  'self-reflection': { model: 'gpt-4o-mini', reason: '自反思中等推理即可' },
  'auto-doc-generation': { model: 'gpt-3.5-turbo', reason: '自动文档生成模式固定' },
  'dispatching-parallel': { model: 'gpt-4o-mini', reason: '任务调度模式固定' },
  'writing-skills': { model: 'gpt-3.5-turbo', reason: '技能编写模式固定' },
};

const DEFAULT_MODEL_TIERS = {
  premium: { models: ['gpt-4o', 'claude-3-opus', 'deepseek-v3', 'iris-alpha', 'beacon-alpha', 'deepseek-coder-pro'], costMultiplier: 1.0 },
  standard: { models: ['gpt-4o-mini', 'claude-3-sonnet', 'ember-alpha', 'deepseek-coder'], costMultiplier: 0.15 },
  economy: { models: ['gpt-3.5-turbo', 'deepseek-chat', 'deepseek-coder-lite'], costMultiplier: 0.02 },
};

const DEFAULT_CONFIG = {
  defaultModel: 'gpt-4o',
  fallbackChain: ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'],
  enableAutoDowngrade: true,
  costBudgetPerSession: null,
  complexityThreshold: { premium: 0.7, standard: 0.3 },
};

/**
 * 模型能力注册表。包含上下文窗口、能力标签、定价、推理模式等元数据。
 * 融合来源：GPT-5.6 (iris-alpha) 150万Token + DeepSeek CodeGPT X 中文编码优化
 */
const MODEL_REGISTRY = {
  'gpt-4o': {
    tier: 'premium', contextWindowSize: 128000,
    capabilities: ['code-generation', 'reasoning', 'vision', 'function-calling'],
    pricing: { inputPer1k: 0.005, outputPer1k: 0.015 },
    costMultiplier: 1.0, reasoningModes: ['standard'],
  },
  'claude-3-opus': {
    tier: 'premium', contextWindowSize: 200000,
    capabilities: ['code-generation', 'reasoning', 'analysis', 'function-calling'],
    pricing: { inputPer1k: 0.015, outputPer1k: 0.075 },
    costMultiplier: 1.5, reasoningModes: ['standard'],
  },
  'deepseek-v3': {
    tier: 'premium', contextWindowSize: 128000,
    capabilities: ['code-generation', 'reasoning', 'math'],
    pricing: { inputPer1k: 0.0027, outputPer1k: 0.0108 },
    costMultiplier: 0.54, reasoningModes: ['standard'],
  },
  'iris-alpha': {
    tier: 'premium', contextWindowSize: 1500000,
    capabilities: ['code-generation', 'reasoning', 'vision', 'function-calling', 'long-context', 'sparse-attention', 'layered-memory', 'commercial-grade-ui'],
    pricing: { inputPer1k: 0.008, outputPer1k: 0.024 },
    costMultiplier: 1.2, reasoningModes: ['fast', 'xhigh'],
    description: 'GPT-5.6 标准版：150万Token上下文，商用级代码生成',
  },
  'beacon-alpha': {
    tier: 'premium', contextWindowSize: 1500000,
    capabilities: ['code-generation', 'reasoning', 'vision', 'function-calling', 'long-context', 'agent-orchestration', 'multi-agent', 'complex-reasoning'],
    pricing: { inputPer1k: 0.012, outputPer1k: 0.036 },
    costMultiplier: 1.8, reasoningModes: ['fast', 'xhigh'],
    description: 'GPT-5.6 Pro版：150万Token，强化Agent与长链路推理',
  },
  'deepseek-coder-pro': {
    tier: 'premium', contextWindowSize: 128000,
    capabilities: ['code-generation', 'reasoning', 'function-calling', 'chinese-optimized', 'full-stack', 'team-collaboration', 'code-review', 'debugging'],
    pricing: { inputPer1k: 0.003, outputPer1k: 0.012 },
    costMultiplier: 0.6, reasoningModes: ['fast', 'xhigh'],
    description: 'DeepSeek CodeGPT X 旗舰版：中文指令98%+准确率，全栈编码+团队协作+私有化部署',
  },
  'gpt-4o-mini': {
    tier: 'standard', contextWindowSize: 128000,
    capabilities: ['code-generation', 'reasoning', 'function-calling'],
    pricing: { inputPer1k: 0.00015, outputPer1k: 0.0006 },
    costMultiplier: 0.03, reasoningModes: ['standard'],
  },
  'claude-3-sonnet': {
    tier: 'standard', contextWindowSize: 200000,
    capabilities: ['code-generation', 'reasoning', 'analysis'],
    pricing: { inputPer1k: 0.003, outputPer1k: 0.015 },
    costMultiplier: 0.3, reasoningModes: ['standard'],
  },
  'ember-alpha': {
    tier: 'standard', contextWindowSize: 800000,
    capabilities: ['code-generation', 'reasoning', 'function-calling', 'low-latency', 'tool-calling'],
    pricing: { inputPer1k: 0.001, outputPer1k: 0.004 },
    costMultiplier: 0.12, reasoningModes: ['fast'],
    description: 'GPT-5.6 轻量版：80万Token，低延迟低成本',
  },
  'deepseek-coder': {
    tier: 'standard', contextWindowSize: 64000,
    capabilities: ['code-generation', 'reasoning', 'chinese-optimized', 'full-stack', 'code-review', 'debugging'],
    pricing: { inputPer1k: 0.0007, outputPer1k: 0.0028 },
    costMultiplier: 0.14, reasoningModes: ['fast'],
    description: 'DeepSeek CodeGPT X 企业版：中文优先全栈编码，团队协作+私有化部署',
  },
  'gpt-3.5-turbo': {
    tier: 'economy', contextWindowSize: 16385,
    capabilities: ['code-generation', 'reasoning'],
    pricing: { inputPer1k: 0.0005, outputPer1k: 0.0015 },
    costMultiplier: 0.05, reasoningModes: ['standard'],
  },
  'deepseek-chat': {
    tier: 'economy', contextWindowSize: 64000,
    capabilities: ['code-generation', 'reasoning'],
    pricing: { inputPer1k: 0.00014, outputPer1k: 0.00028 },
    costMultiplier: 0.014, reasoningModes: ['standard'],
  },
  'deepseek-coder-lite': {
    tier: 'economy', contextWindowSize: 32000,
    capabilities: ['code-generation', 'reasoning', 'chinese-optimized', 'single-file-debug'],
    pricing: { inputPer1k: 0.0001, outputPer1k: 0.0002 },
    costMultiplier: 0.01, reasoningModes: ['fast'],
    description: 'DeepSeek CodeGPT X 社区版：中文指令理解，单文件调试，个人开发者免费',
  },
};

/**
 * @module runtime/model/model-selector
 * 模型选择器。任务匹配、成本优化、降级策略，
 * 根据Skill类型和任务复杂度自动选择最优模型。
 */

/**
 * 模型选择器。根据Skill类型和任务复杂度自动选择最优模型，
 * 支持Skill映射、复杂度评分、预算降级和成本追踪。
 * @classdesc 模型选择器。任务匹配、成本优化、降级策略
 * @extends EventEmitter
 */
class ModelSelector extends EventEmitter {
  /**
   * 创建ModelSelector实例。
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.skillModelMap] - Skill到模型的映射表
   * @param {Object} [options.modelTiers] - 模型层级定义（small/medium/large）
   * @param {Object} [options.config] - 通用配置
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._skillModelMap = mergeConfig(DEFAULT_SKILL_MODEL_MAP, (options && options.skillModelMap) ?? {});
    this._modelTiers = mergeConfig(DEFAULT_MODEL_TIERS, (options && options.modelTiers) ?? {});
    this._modelTierSets = {};
    for (const [tier, info] of Object.entries(this._modelTiers)) {
      if (info.models && Array.isArray(info.models)) this._modelTierSets[tier] = new Set(info.models);
    }
    this._modelRegistry = mergeConfig(MODEL_REGISTRY, (options && options.modelRegistry) ?? {});
    this._usageStats = new Map();
    this._costTracker = { totalCost: 0, sessionCosts: new Map() };
    this._maxUsageStats = 500;
    this._budgetConstrained = false;
    this._budgetCritical = false;
    this._budgetExhausted = false;
    this._tokenManager = null;
  }

  /**
   * 根据Skill标识和上下文自动选择最优模型，支持Skill映射、复杂度评分和预算降级
   * @param {string} skillId - Skill标识
   * @param {Object} [context] - 选择上下文，提供额外决策依据
   * @param {number} [context.complexityScore] - 任务复杂度评分
   * @param {boolean} [context.isRetry] - 是否为重试请求
   * @param {boolean} [context.isSimpleTask] - 是否为简单任务
   * @param {string} [context.sessionId] - 会话标识，用于会话级成本追踪
   * @returns {{ model: string, reason: string, tier: string, source: string }} 模型选择结果，包含模型名、选择原因、层级和来源
   * @emits ModelSelector#model-downgraded
   */
  selectModel(skillId, context) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') {
      return {
        model: this._config.defaultModel,
        reason: 'Invalid skillId, using default',
        tier: this._getTier(this._config.defaultModel),
        source: 'default',
      };
    }

    const mapping = this._skillModelMap[skillId];
    if (mapping) {
      const result = {
        model: mapping.model,
        reason: mapping.reason,
        tier: this._getTier(mapping.model),
        source: 'skill-mapping',
      };

      if (this._config.enableAutoDowngrade && context) {
        const adjusted = this._applyContextAdjustments(result, context);
        if (adjusted.model !== result.model) {
          this.emit('model-downgraded', { skillId, from: result.model, to: adjusted.model, reason: adjusted.reason });
          return adjusted;
        }
      }

      return result;
    }

    if (context && context.complexityScore !== undefined) {
      return this._selectByComplexity(skillId, context.complexityScore);
    }

    return {
      model: this._config.defaultModel,
      reason: 'No mapping found, using default',
      tier: this._getTier(this._config.defaultModel),
      source: 'default',
    };
  }

  /**
   * 记录模型使用情况，用于成本追踪和统计
   * @param {string} skillId - Skill标识
   * @param {string} model - 使用的模型名称
   * @param {number} [tokens] - 消耗的Token数量
   * @param {number} [cost] - 产生的成本
   * @param {string} [sessionId] - 会话标识，用于按会话追踪成本
   * @emits ModelSelector#usage-recorded
   */
  recordUsage(skillId, model, tokens, cost, sessionId) {
    this.guardShutdown();
    const key = skillId + ':' + model;
    const existing = this._usageStats.get(key) ?? { count: 0, totalTokens: 0, totalCost: 0 };
    existing.count++;
    existing.totalTokens += (Number.isFinite(tokens) ? tokens : 0);
    existing.totalCost += (Number.isFinite(cost) ? cost : 0);

    const keyExists = this._usageStats.has(key);
    if (!keyExists && this._usageStats.size >= this._maxUsageStats) {
      const oldest = this._usageStats.keys().next().value;
      this._usageStats.delete(oldest);
    }
    this._usageStats.delete(key);
    this._usageStats.set(key, existing);

    this._costTracker.totalCost += (Number.isFinite(cost) ? cost : 0);
    if (sessionId) {
      if (this._costTracker.sessionCosts.size >= 1000) {
        const oldestSession = this._costTracker.sessionCosts.keys().next().value;
        this._costTracker.sessionCosts.delete(oldestSession);
      }
      const prev = this._costTracker.sessionCosts.get(sessionId) ?? 0;
      this._costTracker.sessionCosts.set(sessionId, prev + (Number.isFinite(cost) ? cost : 0));
    }
    this.emit('usage-recorded', { skillId, model, tokens, cost });
  }

  /**
   * 绑定TokenManager实例，监听预算预警事件并自动调整模型选择策略
   * @param {TokenManager} tokenManager - Token管理器实例
   * @emits ModelSelector#budget-recovered
   */
  attachTokenManager(tokenManager) {
    this.guardShutdown();
    if (!tokenManager || typeof tokenManager.on !== 'function') return { attached: false, reason: 'Invalid TokenManager' };
    if (this._tokenManager) {
      this._tokenManager.removeListener('token-warning-80', this._onBudgetConstrained);
      this._tokenManager.removeListener('token-warning-95', this._onBudgetCritical);
      this._tokenManager.removeListener('token-exhausted', this._onBudgetExhausted);
      this._tokenManager.removeListener('token-reset', this._onTokenReset);
    }
    this._tokenManager = tokenManager;
    this._onBudgetConstrained = () => { this._budgetConstrained = true; };
    this._onBudgetCritical = () => { this._budgetCritical = true; };
    this._onBudgetExhausted = () => { this._budgetExhausted = true; };
    this._onTokenReset = (data) => {
      if (data && data.sessionId && !data.clearAll) {
        return;
      }
      const wasConstrained = this._budgetConstrained;
      const wasCritical = this._budgetCritical;
      const wasExhausted = this._budgetExhausted;
      this._budgetConstrained = false;
      this._budgetCritical = false;
      this._budgetExhausted = false;
      if (wasConstrained || wasCritical || wasExhausted) {
        this.emit('budget-recovered', { wasConstrained, wasCritical, wasExhausted });
      }
    };
    tokenManager.on('token-warning-80', this._onBudgetConstrained);
    tokenManager.on('token-warning-95', this._onBudgetCritical);
    tokenManager.on('token-exhausted', this._onBudgetExhausted);
    tokenManager.on('token-reset', this._onTokenReset);
  }

  /**
   * 重置所有预算约束标志（constrained、critical、exhausted）
   */
  resetBudgetFlags() {
    this.guardShutdown();
    this._budgetConstrained = false;
    this._budgetCritical = false;
    this._budgetExhausted = false;
  }

  /**
   * 获取指定Skill的预估成本信息
   * @param {string} skillId - Skill标识
   * @returns {{ model: string, tier: string, costMultiplier: number, estimatedCostPer1kTokens: number } | { estimatedCost: number, tier: string }} 成本估算结果，包含模型、层级、成本乘数和每千Token预估成本
   */
  getCostEstimate(skillId) {
    this.guardShutdown();
    const mapping = this._skillModelMap[skillId];
    if (!mapping) return { estimatedCost: 0, tier: 'unknown' };

    const tier = this._getTier(mapping.model);
    const tierInfo = this._modelTiers[tier];
    const baseCostPer1kTokens = 0.01;

    return {
      model: mapping.model,
      tier,
      costMultiplier: tierInfo ? tierInfo.costMultiplier : 1,
      estimatedCostPer1kTokens: baseCostPer1kTokens * (tierInfo ? tierInfo.costMultiplier : 1),
    };
  }

  /**
   * 获取模型选择器运行统计信息，包含总Token消耗、总成本、按模型分类统计和相对全Premium的节省百分比
   * @returns {{ totalTokens: number, totalCost: number, byModel: Object, savingsVsAllPremium: number }} 统计数据
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('ModelSelector', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalTokens: 0, totalCost: 0, byModel: {}, savingsVsAllPremium: 0 }; }
    let totalTokens = 0;
    let totalCost = 0;
    const byModel = {};

    for (const [key, stats] of this._usageStats) {
      totalTokens += stats.totalTokens;
      totalCost += stats.totalCost;
      const model = key.split(':')[1] ?? 'unknown';
      if (!byModel[model]) byModel[model] = { count: 0, tokens: 0, cost: 0 };
      byModel[model].count += stats.count;
      byModel[model].tokens += stats.totalTokens;
      byModel[model].cost += stats.totalCost;
    }

    return {
      totalTokens,
      totalCost,
      byModel,
      savingsVsAllPremium: this._calculateSavings(),
    };
  }

  _selectByComplexity(skillId, complexityScore) {
    let model;
    let tier;
    const fallbackChain = this._config.fallbackChain ?? [];

    const threshold = this._config.complexityThreshold ?? {};
    if (complexityScore >= (Number.isFinite(threshold.premium) ? threshold.premium : 0.7)) {
      model = fallbackChain.length > 0 ? fallbackChain[0] : undefined;
      tier = 'premium';
    } else if (complexityScore >= (Number.isFinite(threshold.standard) ? threshold.standard : 0.4)) {
      model = fallbackChain.length > 1 ? fallbackChain[1] : (fallbackChain.length > 0 ? fallbackChain[0] : undefined);
      tier = 'standard';
    } else {
      model = fallbackChain.length > 2 ? fallbackChain[2] : (fallbackChain.length > 1 ? fallbackChain[1] : (fallbackChain.length > 0 ? fallbackChain[0] : undefined));
      tier = 'economy';
    }

    if (!model) model = this._config.defaultModel;

    return {
      model,
      reason: 'Selected by complexity score: ' + complexityScore.toFixed(2),
      tier,
      source: 'complexity-based',
    };
  }

  _applyBudgetAdjustments(result) {
    const fallbackChain = this._config.fallbackChain ?? [];
    const economyModel = fallbackChain.length > 2 ? fallbackChain[2] : (fallbackChain.length > 1 ? fallbackChain[1] : (fallbackChain.length > 0 ? fallbackChain[0] : undefined));

    if (this._budgetExhausted) {
      return {
        model: economyModel,
        tier: this._getTier(economyModel),
        reason: 'Budget exhausted: forced economy model',
        source: 'budget-exhausted',
      };
    }

    if (this._budgetCritical) {
      if (result.tier === 'premium') {
        const downgraded = fallbackChain[1] || result.model;
        return {
          model: downgraded,
          tier: this._getTier(downgraded),
          reason: 'Budget critical (95%): premium downgraded to standard',
          source: 'budget-critical',
        };
      }
      if (result.tier === 'standard') {
        return {
          model: economyModel,
          tier: this._getTier(economyModel),
          reason: 'Budget critical (95%): standard downgraded to economy',
          source: 'budget-critical',
        };
      }
    }

    if (this._budgetConstrained && result.tier === 'premium') {
      const downgraded = fallbackChain[1] || result.model;
      return {
        model: downgraded,
        tier: this._getTier(downgraded),
        reason: 'Budget constrained (80%): premium downgraded to standard',
        source: 'budget-constrained',
      };
    }

    return null;
  }

  _applyContextAdjustments(result, context) {
    const budgetAdjustment = this._applyBudgetAdjustments(result);
    if (budgetAdjustment) return budgetAdjustment;

    const adjusted = mergeConfig(result);
    const fallbackChain = this._config.fallbackChain ?? [];

    if (context.isRetry) {
      if (result.tier === 'economy') {
        adjusted.model = fallbackChain[1] || fallbackChain[0] || adjusted.model;
        adjusted.tier = this._getTier(adjusted.model);
        adjusted.reason = 'Upgraded for retry (economy failed)';
        adjusted.source = 'retry-upgrade';
      }
      return adjusted;
    }

    if (context.isSimpleTask === true && result.tier === 'premium') {
      adjusted.model = fallbackChain[1] || adjusted.model;
      adjusted.tier = this._getTier(adjusted.model);
      adjusted.reason = 'Downgraded: simple task detected';
      adjusted.source = 'context-downgrade';
      return adjusted;
    }

    if (this._config.costBudgetPerSession) {
      const sessionCost = this._costTracker.sessionCosts.get(context.sessionId);
      const effectiveSessionCost = Number.isFinite(sessionCost) ? sessionCost : 0;
      if (effectiveSessionCost > this._config.costBudgetPerSession * 0.8 && result.tier === 'premium') {
        adjusted.model = fallbackChain[1] || adjusted.model;
        adjusted.tier = this._getTier(adjusted.model);
        adjusted.reason = 'Downgraded: session cost budget approaching limit';
        adjusted.source = 'budget-downgrade';
      }
    }

    return adjusted;
  }

  /**
   * 查询指定模型所属的层级（premium/standard/economy）
   * @param {string} model - 模型名称
   * @returns {string} 模型层级，未匹配时默认返回'standard'
   */
  getTier(model) {
    this.guardShutdown();
    for (const [tier, modelSet] of Object.entries(this._modelTierSets)) {
      if (modelSet.has(model)) return tier;
    }
    return 'standard';
  }

  _getTier(model) {
    return this.getTier(model);
  }

  /**
   * 查询指定模型的能力元数据
   * @param {string} model - 模型名称
   * @returns {Object|null} 模型能力元数据
   */
  getModelCapabilities(model) {
    if (!model || typeof model !== 'string') return null;
    const entry = this._modelRegistry[model]; return entry ? JSON.parse(JSON.stringify(entry)) : null;
  }

  /**
   * 根据所需能力标签查找满足条件的模型列表
   * @param {string[]} requiredCapabilities - 必需的能力标签
   * @param {Object} [options] - 查询选项
   * @param {number} [options.minContextWindowSize] - 最小上下文窗口
   * @param {string} [options.preferredTier] - 偏好层级
   * @param {string} [options.reasoningMode] - 所需推理模式
   * @returns {Array<{model: string, tier: string, capabilities: string[], contextWindowSize: number, matchScore: number}>}
   */
  findModelsByCapabilities(requiredCapabilities, options) {
    this.guardShutdown();
    if (!Array.isArray(requiredCapabilities) || requiredCapabilities.length === 0) return [];
    const opts = options ?? {};
    const results = [];
    for (const [model, info] of Object.entries(this._modelRegistry)) {
      if (opts.minContextWindowSize && (info.contextWindowSize ?? 0) < opts.minContextWindowSize) continue;
      if (opts.preferredTier && info.tier !== opts.preferredTier) continue;
      if (opts.reasoningMode && Array.isArray(info.reasoningModes) && !info.reasoningModes.includes(opts.reasoningMode)) continue;
      const modelCaps = info.capabilities ?? [];
      const matchedCount = requiredCapabilities.filter(function(c) { return modelCaps.includes(c); }).length;
      if (matchedCount === 0) continue;
      results.push({ model, tier: info.tier, capabilities: modelCaps, contextWindowSize: info.contextWindowSize ?? 0, matchScore: matchedCount / requiredCapabilities.length });
    }
    results.sort(function(a, b) { return b.matchScore - a.matchScore; });
    return results;
  }

  /**
   * 根据上下文窗口需求选择最优模型
   * @param {number} requiredTokens - 最小上下文Token数
   * @param {Object} [options] - 选项
   * @param {boolean} [options.preferLowCost=true] - 优先低成本
   * @returns {{model: string, tier: string, contextWindowSize: number, reason: string}|null}
   */
  selectModelByContextWindow(requiredTokens, options) {
    this.guardShutdown();
    if (!Number.isFinite(requiredTokens) || requiredTokens <= 0) return null;
    const opts = options ?? {};
    const preferLowCost = opts.preferLowCost !== false;
    const candidates = [];
    for (const [model, info] of Object.entries(this._modelRegistry)) {
      if ((info.contextWindowSize ?? 0) >= requiredTokens) {
        candidates.push({ model, tier: info.tier, contextWindowSize: info.contextWindowSize, costMultiplier: info.costMultiplier || 1 });
      }
    }
    if (candidates.length === 0) return null;
    if (preferLowCost) candidates.sort(function(a, b) { return a.costMultiplier - b.costMultiplier; });
    const selected = candidates[0];
    return { model: selected.model, tier: selected.tier, contextWindowSize: selected.contextWindowSize, reason: 'Selected for context window >= ' + requiredTokens + ' tokens' };
  }

  _calculateSavings() {
    let actualCost = 0;
    let premiumCost = 0;

    for (const [, stats] of this._usageStats) {
      actualCost += stats.totalCost;
      premiumCost += (stats.totalTokens / 1000) * 0.01;
    }

    if (premiumCost === 0) return 0;
    return Math.round(((premiumCost - actualCost) / premiumCost * 1000)) / 10;
  }

  /**
   * 检查模型选择器健康状态，当使用统计条目数未超过上限时为健康
   * @returns {boolean} 健康状态，true表示正常
   */
  isHealthy() {
    return !this._shutDown;
  }

  _onShutdown() {
    if (this._tokenManager) {
      this._tokenManager.removeListener('token-warning-80', this._onBudgetConstrained);
      this._tokenManager.removeListener('token-warning-95', this._onBudgetCritical);
      this._tokenManager.removeListener('token-exhausted', this._onBudgetExhausted);
      this._tokenManager.removeListener('token-reset', this._onTokenReset);
      this._tokenManager = null;
    }
    this._usageStats.clear();
    this._costTracker.sessionCosts.clear();
    this._costTracker.totalCost = 0;
    this.removeAllListeners();
  }
}

ModelSelector.DEFAULT_SKILL_MODEL_MAP = DEFAULT_SKILL_MODEL_MAP;
ModelSelector.DEFAULT_MODEL_TIERS = DEFAULT_MODEL_TIERS;
ModelSelector.MODEL_REGISTRY = MODEL_REGISTRY;
ModelSelector.COMPLEXITY_FACTORS = COMPLEXITY_FACTORS;

module.exports = withShutdown(ModelSelector);
