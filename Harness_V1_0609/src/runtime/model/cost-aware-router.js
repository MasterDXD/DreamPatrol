'use strict';

/**
 * @module runtime/model/cost-aware-router
 * @description 成本感知技能路由引擎 — 基于 OpenSquilla SquillaRouter 设计理念，
 * 通过多层信号分析（消息长度、代码块、关键词、复杂度评分）将请求路由到最经济的模型层级，
 * 同时追踪每个技能执行的 Token 消耗与成本。
 *
 * 融合 OpenSquilla 三大核心能力：
 * 1. 智能模型路由：简单任务→小模型，复杂任务→大模型，节省 60-90% Token
 * 2. 按技能成本追踪：每个技能执行后记录 Token 使用量与预估成本
 * 3. 上下文缓存感知：标记可缓存技能，跨轮次复用上下文
 *
 * @extends EventEmitter
 * @emits CostAwareRouter#routing-decision
 * @emits CostAwareRouter#token-usage
 * @emits CostAwareRouter#cost-threshold
 */

const { EventEmitter } = require('events');
const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * 模型层级定义及成本系数。
 * @readonly
 * @enum {Object}
 */
const MODEL_TIERS = {
  SMALL: { name: 'small', costMultiplier: 0.02, description: '轻量级任务：格式化、简单查询、文档生成' },
  MEDIUM: { name: 'medium', costMultiplier: 0.15, description: '中等任务：编码实现、代码审查、测试执行' },
  LARGE: { name: 'large', costMultiplier: 1.0, description: '复杂任务：架构设计、安全审计、深度推理' },
};

/**
 * 技能复杂度信号权重配置。
 * @constant {Object}
 */
const COMPLEXITY_SIGNALS = {
  CODE_BLOCKS: { weight: 0.15, threshold: 3 },
  MESSAGE_LENGTH: { weight: 0.2, shortThreshold: 200, longThreshold: 2000 },
  KEYWORD_DENSITY: { weight: 0.25 },
  ERROR_RECOVERY: { weight: 0.2 },
  MULTI_STEP: { weight: 0.2 },
};

/**
 * 高复杂度关键词（匹配到则提升复杂度评分）。
 * @constant {Array<string>}
 */
const HIGH_COMPLEXITY_KEYWORDS = [
  'architecture', '架构', 'design', '设计', 'security', '安全',
  'debug', '调试', 'performance', '性能', 'optimize', '优化',
  'refactor', '重构', 'deep', '深化', 'analyze', '分析',
  'vulnerability', '漏洞', 'audit', '审计', 'deploy', '部署',
];

/**
 * 低复杂度关键词（匹配到则降低复杂度评分）。
 * @constant {Array<string>}
 */
const LOW_COMPLEXITY_KEYWORDS = [
  'format', '格式化', 'lint', 'lint', 'document', '文档',
  'comment', '注释', 'test', '测试', 'simple', '简单',
  'quick', '快速', 'check', '检查', 'list', '列表',
];

/**
 * 可缓存技能集合（上下文可跨轮次复用，无需每次重新加载）。
 * @constant {Set<string>}
 */
const CACHEABLE_SKILLS = new Set([
  'code-review', 'verification-before-completion', 'integration-testing',
  'documentation', 'auto-doc-generation', 'tdd-implement',
  'module-development', 'refactor-code',
]);

/**
 * Token 单价（美元/1K tokens），各模型层级的平均成本。
 * @constant {Object}
 */
const TOKEN_PRICES = {
  small: { input: 0.00015, output: 0.0006 },
  medium: { input: 0.001, output: 0.004 },
  large: { input: 0.01, output: 0.03 },
};

/**
 * 默认配置。
 * @constant {Object}
 */
const DEFAULT_OPTIONS = {
  maxHistory: 500,
  costBudgetPerSession: null,
  costWarningThreshold: 0.8,
  costCriticalThreshold: 0.95,
  enableCache: true,
  enableAutoDowngrade: true,
};

/**
 * 成本感知技能路由引擎。
 *
 * 核心功能：
 * - 分析请求复杂度，选择最优模型层级
 * - 追踪每个技能执行的 Token 消耗与成本
 * - 标记可缓存技能，支持上下文复用
 * - 预算预警与自动降级
 *
 * @class CostAwareRouter
 * @extends EventEmitter
 */
class CostAwareRouter extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxHistory=500] - 最大历史记录数
   * @param {number|null} [options.costBudgetPerSession=null] - 会话成本预算（美元）
   * @param {number} [options.costWarningThreshold=0.8] - 成本预警阈值
   * @param {number} [options.costCriticalThreshold=0.95] - 成本严重阈值
   * @param {boolean} [options.enableCache=true] - 是否启用上下文缓存
   * @param {boolean} [options.enableAutoDowngrade=true] - 是否启用自动降级
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._usageHistory = new Map();
    this._skillCosts = new Map();
    this._cacheHits = 0;
    this._cacheMisses = 0;
    this._totalCost = 0;
    this._sessionCost = 0;
    this._routingDecisions = 0;
    this._costSaved = 0;
    this._downgrades = 0;
  }

  /**
   * 分析请求复杂度并返回推荐的模型层级。
   *
   * @param {Object} request - 请求信息
   * @param {string} request.message - 用户消息内容
   * @param {string} [request.skillId] - 关联的技能ID
   * @param {Array<string>} [request.toolCalls] - 工具调用列表
   * @param {Object} [request.metadata] - 附加元数据
   * @returns {{ tier: string, complexityScore: number, factors: Object, estimatedCost: number, cacheable: boolean }}
   */
  analyzeComplexity(request) {
    this.guardShutdown();
    const message = (request && request.message) || '';
    const skillId = (request && request.skillId) ?? null;
    const toolCalls = (request && request.toolCalls) ?? [];

    const factors = {
      codeBlocks: 0,
      messageLength: 0,
      keywordDensity: 0,
      errorRecovery: 0,
      multiStep: 0,
    };

    // 1. 代码块数量评分
    const codeBlockMatches = (message.match(/```/g) ?? []).length;
    factors.codeBlocks = Math.min(codeBlockMatches / 2, COMPLEXITY_SIGNALS.CODE_BLOCKS.threshold)
      / COMPLEXITY_SIGNALS.CODE_BLOCKS.threshold;

    // 2. 消息长度评分
    if (message.length <= COMPLEXITY_SIGNALS.MESSAGE_LENGTH.shortThreshold) {
      factors.messageLength = 0;
    } else if (message.length >= COMPLEXITY_SIGNALS.MESSAGE_LENGTH.longThreshold) {
      factors.messageLength = 1;
    } else {
      const msgRange = COMPLEXITY_SIGNALS.MESSAGE_LENGTH.longThreshold - COMPLEXITY_SIGNALS.MESSAGE_LENGTH.shortThreshold;
      factors.messageLength = msgRange > 0
        ? (message.length - COMPLEXITY_SIGNALS.MESSAGE_LENGTH.shortThreshold) / msgRange
        : 0;
    }

    // 3. 关键词密度评分
    const msgLower = message.toLowerCase();
    let highHits = 0;
    let lowHits = 0;
    for (const kw of HIGH_COMPLEXITY_KEYWORDS) {
      if (msgLower.includes(kw)) highHits++;
    }
    for (const kw of LOW_COMPLEXITY_KEYWORDS) {
      if (msgLower.includes(kw)) lowHits++;
    }
    factors.keywordDensity = Math.min(highHits * 0.25, 1) - Math.min(lowHits * 0.15, 0.5);
    factors.keywordDensity = Math.max(0, Math.min(1, factors.keywordDensity));

    // 4. 错误恢复需求评分（工具调用越多越复杂）
    factors.errorRecovery = Math.min(toolCalls.length / 5, 1);

    // 5. 多步骤复杂度评分
    const multiStepIndicators = ['first', 'then', 'next', 'finally', '步骤', '然后', '最后', '首先'];
    let multiStepCount = 0;
    for (const indicator of multiStepIndicators) {
      if (msgLower.includes(indicator)) multiStepCount++;
    }
    factors.multiStep = Math.min(multiStepCount / 4, 1);

    // 计算加权总分
    const complexityScore =
      factors.codeBlocks * COMPLEXITY_SIGNALS.CODE_BLOCKS.weight +
      factors.messageLength * COMPLEXITY_SIGNALS.MESSAGE_LENGTH.weight +
      factors.keywordDensity * COMPLEXITY_SIGNALS.KEYWORD_DENSITY.weight +
      factors.errorRecovery * COMPLEXITY_SIGNALS.ERROR_RECOVERY.weight +
      factors.multiStep * COMPLEXITY_SIGNALS.MULTI_STEP.weight;

    const tier = this._routeByInferenceMode(complexityScore);

    // 缓存判断
    const cacheable = !!(skillId && CACHEABLE_SKILLS.has(skillId) && this._options.enableCache);

    // 预估成本
    const estimatedTokens = message.length * 0.4 + 500;
    const estimatedCost = (estimatedTokens / 1000) * (TOKEN_PRICES[tier.name].input + TOKEN_PRICES[tier.name].output);

    const result = {
      tier: tier.name,
      complexityScore: Math.round(complexityScore * 1000) / 1000,
      factors,
      estimatedCost: Math.round(estimatedCost * 10000) / 10000,
      cacheable,
    };

    this._routingDecisions++;
    this.emit('routing-decision', {
      skillId,
      tier: tier.name,
      complexityScore: result.complexityScore,
      estimatedCost: result.estimatedCost,
      cacheable: result.cacheable,
      timestamp: Date.now(),
    });

    return result;
  }

  _routeByInferenceMode(complexityScore) {
    if (complexityScore >= 0.7) {
      return MODEL_TIERS.LARGE;
    } else if (complexityScore >= 0.3) {
      return MODEL_TIERS.MEDIUM;
    }
    return MODEL_TIERS.SMALL;
  }

  /**
   * 记录技能执行的 Token 消耗。
   *
   * @param {string} skillId - 技能ID
   * @param {Object} usage - Token 使用量
   * @param {number} usage.inputTokens - 输入Token数
   * @param {number} usage.outputTokens - 输出Token数
   * @param {string} [usage.modelTier='medium'] - 使用的模型层级
   * @param {boolean} [usage.cacheHit=false] - 是否命中缓存
   * @returns {Object} 本次消耗记录
   */
  recordUsage(skillId, usage) {
    this.guardShutdown();
    if (!skillId || !usage) return null;

    const inputTokens = (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) ? usage.inputTokens : 0;
    const outputTokens = (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) ? usage.outputTokens : 0;
    const modelTier = usage.modelTier || 'medium';
    const cacheHit = !!(usage.cacheHit);

    const prices = TOKEN_PRICES[modelTier] || TOKEN_PRICES.medium;
    const cost = (inputTokens / 1000) * prices.input + (outputTokens / 1000) * prices.output;
    const costRounded = Math.round(cost * 10000) / 10000;

    const record = {
      skillId,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      modelTier,
      cost: costRounded,
      cacheHit,
      timestamp: Date.now(),
    };

    // 更新技能成本统计
    if (!this._skillCosts.has(skillId)) {
      this._skillCosts.set(skillId, {
        totalCalls: 0,
        totalTokens: 0,
        totalCost: 0,
        cacheHits: 0,
      });
    }
    const stats = this._skillCosts.get(skillId);
    stats.totalCalls++;
    stats.totalTokens += record.totalTokens;
    stats.totalCost += costRounded;
    if (cacheHit) stats.cacheHits++;

    // 更新会话成本
    this._sessionCost += costRounded;
    this._totalCost += costRounded;

    // 缓存统计
    if (cacheHit) {
      this._cacheHits++;
      this._costSaved += costRounded;
    } else {
      this._cacheMisses++;
    }

    // 维护使用历史
    const historyKey = skillId + '_' + Date.now();
    this._usageHistory.set(historyKey, record);
    if (this._usageHistory.size > this._options.maxHistory) {
      const oldest = this._usageHistory.keys().next().value;
      this._usageHistory.delete(oldest);
    }

    // 预算检查
    if (this._options.costBudgetPerSession) {
      this._checkBudget();
    }

    this.emit('token-usage', record);
    return record;
  }

  /**
   * 获取技能成本统计。
   *
   * @param {string} skillId - 技能ID
   * @returns {Object|null} 成本统计，不存在返回 null
   */
  getSkillCosts(skillId) {
    this.guardShutdown();
    return this._skillCosts.get(skillId) ?? null;
  }

  /**
   * 获取所有技能的成本统计摘要。
   *
   * @returns {Array<Object>} 按总成本降序排列的技能成本摘要
   */
  getCostSummary() {
    this.guardShutdown();
    const summary = [];
    for (const [skillId, stats] of this._skillCosts) {
      summary.push({
        skillId,
        totalCalls: stats.totalCalls,
        totalTokens: stats.totalTokens,
        totalCost: Math.round(stats.totalCost * 10000) / 10000,
        avgCostPerCall: Math.round((stats.totalCost / Math.max(1, stats.totalCalls)) * 10000) / 10000,
        cacheHitRate: Math.round((stats.cacheHits / Math.max(1, stats.totalCalls)) * 100) / 100,
      });
    }
    summary.sort((a, b) => b.totalCost - a.totalCost);
    return summary;
  }

  /**
   * 获取全局成本统计。
   *
   * @returns {Object} 全局成本统计
   */
  getStats() {
    this.guardShutdown();
    const totalCalls = this._cacheHits + this._cacheMisses;
    return {
      totalCost: Math.round(this._totalCost * 10000) / 10000,
      sessionCost: Math.round(this._sessionCost * 10000) / 10000,
      costSaved: Math.round(this._costSaved * 10000) / 10000,
      totalCalls,
      cacheHits: this._cacheHits,
      cacheMisses: this._cacheMisses,
      cacheHitRate: totalCalls > 0 ? Math.round((this._cacheHits / totalCalls) * 100) / 100 : 0,
      routingDecisions: this._routingDecisions,
      downgrades: this._downgrades,
      skillCount: this._skillCosts.size,
      estimatedSavingsPercent: (this._totalCost + this._costSaved) > 0
        ? Math.round((this._costSaved / (this._totalCost + this._costSaved)) * 100)
        : 0,
    };
  }

  /**
   * 重置会话成本（保留历史统计）。
   */
  resetSessionCost() {
    this.guardShutdown();
    this._sessionCost = 0;
  }

  /**
   * 检查是否接近或超过预算阈值。
   * @returns {Object} 预算状态
   * @private
   */
  _checkBudget() {
    const budget = this._options.costBudgetPerSession;
    if (!budget || budget <= 0) return { status: 'ok', remaining: Infinity };

    const ratio = this._sessionCost / budget;
    let status = 'ok';

    if (ratio >= this._options.costCriticalThreshold) {
      status = 'critical';
      this.emit('cost-threshold', { level: 'critical', ratio, cost: this._sessionCost, budget });
    } else if (ratio >= this._options.costWarningThreshold) {
      status = 'warning';
      this.emit('cost-threshold', { level: 'warning', ratio, cost: this._sessionCost, budget });
    }

    return {
      status,
      cost: Math.round(this._sessionCost * 10000) / 10000,
      budget,
      remaining: Math.round((budget - this._sessionCost) * 10000) / 10000,
      ratio: Math.round(ratio * 100) / 100,
    };
  }

  /**
   * 判断技能是否可缓存（上下文可跨轮次复用）。
   *
   * @param {string} skillId - 技能ID
   * @returns {boolean} 是否可缓存
   */
  isCacheable(skillId) {
    return this._options.enableCache && CACHEABLE_SKILLS.has(skillId);
  }

  /**
   * 记录缓存命中。
   *
   * @param {string} skillId - 技能ID
   * @param {number} tokensSaved - 节省的 Token 数
   */
  recordCacheHit(skillId, tokensSaved) {
    this.guardShutdown();
    this._cacheHits++;
    const estimatedCost = (tokensSaved / 1000) * TOKEN_PRICES.medium.input;
    this._costSaved += estimatedCost;
    debug('CostAwareRouter', 'cacheHit', 'skill=' + skillId + ' tokens=' + tokensSaved + ' saved=$' + estimatedCost.toFixed(4));
  }

  /**
   * 关机清理。释放所有追踪数据。
   * @protected
   */
  _onShutdown() {
    this._usageHistory.clear();
    this._skillCosts.clear();
    this._cacheHits = 0;
    this._cacheMisses = 0;
    this._totalCost = 0;
    this._sessionCost = 0;
    this._costSaved = 0;
    this._routingDecisions = 0;
    this._downgrades = 0;
    this.removeAllListeners();
  }
}

CostAwareRouter.MODEL_TIERS = MODEL_TIERS;
CostAwareRouter.TOKEN_PRICES = TOKEN_PRICES;
CostAwareRouter.CACHEABLE_SKILLS = CACHEABLE_SKILLS;
CostAwareRouter.COMPLEXITY_SIGNALS = COMPLEXITY_SIGNALS;
CostAwareRouter.HIGH_COMPLEXITY_KEYWORDS = HIGH_COMPLEXITY_KEYWORDS;
CostAwareRouter.LOW_COMPLEXITY_KEYWORDS = LOW_COMPLEXITY_KEYWORDS;

module.exports = withShutdown(CostAwareRouter);
