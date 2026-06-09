'use strict';

const { EventEmitter } = require('events');
const { PHASE_INDEX, TOKEN_BUDGET_WARNING_RATIO, DEFAULT_PIPELINE_TIMEOUT_MS, MS_PER_MINUTE } = require('../../utils/constants');
const { mergeConfig } = require('../../utils/safe-assign');
const deepClone = require('../../utils/deep-clone');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { roundTo } = require('../../utils/safe-execute');

const DEFAULT_OPTIONS = {
  threshold: TOKEN_BUDGET_WARNING_RATIO,
  retainCurrentPhase: true,
  retainKeyDecisions: true,
  tokenCharsRatio: 4,
  retainSessionState: true,
  maxSummaryLength: 200,
  strategies: {
    completed_phase: 'summary',
    future_phase: 'summary',
    current_phase: 'full',
    unclassified: 'full',
    specification_asset: 'full',
  },
};

const VALID_STRATEGIES = new Set(['full', 'summary', 'discard']);

/**
 * 跨扩展上下文成本排名，融合自Claude Code的上下文成本层级概念。
 * 成本从高到低：Rules > Skills > MCP > Subagents > Hooks
 * 压缩时优先压缩低成本扩展（Hooks），最后压缩高成本扩展（Rules）。
 *
 * 使用场景：当Token预算不足时，按此排名决定压缩顺序。
 * - Rules（规则/约定）：成本最高，每个会话自动加载，占用大量静态前缀
 * - Skills（技能）：成本较高，按需加载但指令内容丰富
 * - MCP（外部服务连接）：成本中等，工具定义+连接元数据
 * - Subagents（子Agent）：成本较低，仅返回摘要
 * - Hooks（钩子）：成本最低，纯规则执行无LLM上下文
 */
const EXTENSION_COST_RANK = {
  RULES: { rank: 5, label: 'rules', compressPriority: 5 },
  SKILLS: { rank: 4, label: 'skills', compressPriority: 4 },
  MCP: { rank: 3, label: 'mcp', compressPriority: 3 },
  SUBAGENTS: { rank: 2, label: 'subagents', compressPriority: 2 },
  HOOKS: { rank: 1, label: 'hooks', compressPriority: 1 },
};

const EXTENSION_COMPRESS_ORDER = [
  EXTENSION_COST_RANK.HOOKS,
  EXTENSION_COST_RANK.SUBAGENTS,
  EXTENSION_COST_RANK.MCP,
  EXTENSION_COST_RANK.SKILLS,
  EXTENSION_COST_RANK.RULES,
];

/**
 * 默认扩展类型预算分配比例，融合自Claude Code的上下文成本层级概念。
 * 成本越高的扩展分配越多预算，确保高价值内容不被过早压缩。
 * Rules(5): 35% - 规则/约定成本最高，每个会话自动加载
 * Skills(4): 25% - 技能按需加载但指令内容丰富
 * MCP(3): 20% - 工具定义+连接元数据
 * Subagents(2): 15% - 仅返回摘要
 * Hooks(1): 5% - 纯规则执行无LLM上下文
 */
const DEFAULT_EXTENSION_BUDGET_RATIOS = {
  rules: 0.35,
  skills: 0.25,
  mcp: 0.20,
  subagents: 0.15,
  hooks: 0.05,
};

/**
 * @module runtime/context/context-compression-engine
 * @classdesc 上下文压缩引擎（ContextCompressionEngine）—— 智能分类（keep/summarize/discard）、Token估算、压缩计划。
 * 在Token预算达到阈值时自动触发上下文压缩，支持增量压缩和规格资产保留。
 */
class ContextCompressionEngine extends EventEmitter {
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_OPTIONS, options);
    this._config.strategies = mergeConfig(DEFAULT_OPTIONS.strategies, options && options.strategies);
    this._stats = {
      totalCompressions: 0,
      totalTokensSaved: 0,
      avgCompressionRatio: 0,
      cacheHits: 0,
      incrementalSkips: 0,
      specificationAssetsRetained: 0,
    };
    this._lastStateHash = null;
    this._lastResult = null;
    this._planCache = new Map();
    this._planCacheMaxSize = 50;
    this._causalValidator = null;
    this._causalBufferManager = null;
    this._causalUpstreamCache = null;
    this._currentSkillId = null;
    this._attentionBudgetManager = null;
  }

  /**
   * 压缩上下文，根据当前阶段和技能分类策略对技能列表进行智能压缩。
   * 支持增量跳过（状态哈希未变时复用上次结果）、因果覆盖策略和规格资产保留。
   * @param {Object} context - 待压缩的上下文对象
   * @param {string} context.currentPhase - 当前执行阶段名称
   * @param {Array<Object>} [context.skills] - 技能列表
   * @param {Array<string>} [context.completedSkills] - 已完成技能ID列表
   * @param {Array<Object>} [context.keyDecisions] - 关键决策列表
   * @param {Object} [context.sessionState] - 会话状态
   * @param {Array<Object>} [context.specificationAssets] - 规格资产列表
   * @returns {{ retainedSkills: Array, compressedSkills: Array, keyDecisions: Array, tokenSavings: number, compressionRatio: number, originalTokenEstimate: number, compressedTokenEstimate: number, sessionState: Object, retainedSpecAssets: Array|undefined }} 压缩结果
   * @throws {Error} When called after the engine has been shut down
   */
  compress(context) {
    this.guardShutdown();
    if (!context || typeof context !== 'object') {
      return { retainedSkills: [], compressedSkills: [], keyDecisions: [], tokenSavings: 0, compressionRatio: 0, originalTokenEstimate: 0, compressedTokenEstimate: 0, sessionState: {} };
    }

    const stateHash = this._computeStateHash(context);
    const cached = this._tryGetCachedResult(stateHash, context);
    if (cached) return cached;

    const currentPhase = context.currentPhase || '';
    const currentPhaseIdx = PHASE_INDEX[currentPhase];
    if (currentPhase && currentPhaseIdx === undefined) {
      this.emit('invalid-phase', { currentPhase });
    }
    const skills = context.skills ?? [];
    const completedSkills = new Set(context.completedSkills ?? []);
    const keyDecisions = context.keyDecisions ?? [];
    const sessionState = context.sessionState ?? {};

    const { retainedSkills, compressedSkills, originalTokens, compressedTokens } = this._processSkills(skills, currentPhase, currentPhaseIdx, completedSkills);

    const tokenSavings = Math.max(0, originalTokens - compressedTokens);
    const compressionRatio = originalTokens > 0 ? tokenSavings / originalTokens : 0;

    this._updateCompressionStats(originalTokens, tokenSavings);

    const contextClassification = this._classifyContext(keyDecisions, sessionState, context.specificationAssets);

    const result = this._buildCompressionResult(retainedSkills, compressedSkills, tokenSavings, compressionRatio, originalTokens, compressedTokens, contextClassification);

    this._finalizeCompression(result, stateHash, context);
    return result;
  }

  _buildCompressionResult(retainedSkills, compressedSkills, tokenSavings, compressionRatio, originalTokens, compressedTokens, contextClassification) {
    return {
      retainedSkills,
      compressedSkills,
      tokenSavings,
      compressionRatio: roundTo(compressionRatio, 2),
      originalTokenEstimate: originalTokens,
      compressedTokenEstimate: compressedTokens,
      ...contextClassification,
    };
  }

  _finalizeCompression(result, stateHash, context) {
    this._lastStateHash = stateHash;
    this._lastResult = deepClone(result);

    const currentCacheKey = this._computePlanCacheKey(context);
    this._planCache.delete(currentCacheKey);

    this.emit('compression-complete', result);
  }

  _tryGetCachedResult(stateHash, context) {
    if (stateHash !== this._lastStateHash || !this._lastResult) return null;
    this._stats.incrementalSkips++;
    try {
      return deepClone(this._lastResult);
    } catch (_e) {
      debug('ContextCompressionEngine', 'deepCloneFallback', _e && _e.message ? _e.message : String(_e));
      try {
        return JSON.parse(JSON.stringify(this._lastResult));
      } catch (__e) {
        debug('ContextCompressionEngine', 'jsonCloneFallback', __e && __e.message ? __e.message : String(__e));
        this._lastStateHash = null;
        this._lastResult = null;
        const depth = (context._depth ?? 0) + 1;
        if (depth > 3) {
          debug('ContextCompressionEngine', 'compress', 'Max clone retry depth exceeded');
          return { retainedSkills: [], compressedSkills: [], keyDecisions: [], tokenSavings: 0, compressionRatio: 0, originalTokenEstimate: 0, compressedTokenEstimate: 0, sessionState: {} };
        }
        return this.compress(Object.assign({}, context, { _depth: depth }));
      }
    }
  }

  _processSkills(skills, currentPhase, currentPhaseIdx, completedSkills) {
    const retainedSkills = [];
    const compressedSkills = [];
    let originalTokens = 0;
    let compressedTokens = 0;

    for (const skill of skills) {
      if (!skill || typeof skill !== 'object') continue;
      const { instructionTokens, summaryTokens } = this._estimateSkillTokens(skill);
      originalTokens += instructionTokens;

      const classification = this._classifySkill(skill, currentPhase, currentPhaseIdx, completedSkills, instructionTokens, summaryTokens);
      if (classification.compress) {
        compressedSkills.push(classification.entry);
        compressedTokens += classification.entry.compressedTokenEstimate ?? summaryTokens;
      } else {
        retainedSkills.push(classification.entry);
        compressedTokens += instructionTokens;
      }
    }

    return { retainedSkills, compressedSkills, originalTokens, compressedTokens };
  }

  _updateCompressionStats(originalTokens, tokenSavings) {
    this._stats.totalCompressions++;
    this._stats.totalTokensSaved += tokenSavings;
    this._stats.totalOriginalTokens = (this._stats.totalOriginalTokens ?? 0) + originalTokens;
    this._stats.avgCompressionRatio = this._stats.totalOriginalTokens > 0
      ? this._stats.totalTokensSaved / this._stats.totalOriginalTokens
      : 0;
  }

  _classifyContext(keyDecisions, sessionState, specAssets) {
    const assets = specAssets ?? [];
    const classified = {
      keyDecisions: this._config.retainKeyDecisions ? keyDecisions : [],
      sessionState: this._config.retainSessionState ? sessionState : {},
    };
    const validAssets = assets.filter(function(asset) { return asset && (asset.assetId || asset.assetType); });
    if (validAssets.length > 0) {
      classified.retainedSpecAssets = validAssets.map(function(asset) {
        return { asset_id: asset.assetId || 'unknown', asset_type: asset.assetType || 'unknown', retained: true, reason: 'specification_asset', strategy: 'full' };
      });
      this._stats.specificationAssetsRetained += classified.retainedSpecAssets.length;
    }
    return classified;
  }

  /**
   * 判断当前上下文是否需要压缩。当已用Token占预算比例达到阈值时返回true。
   * @param {Object} context - 上下文对象
   * @param {number} context.tokensUsed - 已使用的Token数量
   * @param {number} context.tokenBudget - Token预算总量
   * @returns {boolean} 是否需要压缩
   */
  shouldCompress(context) {
    if (!context) return false;
    if (this._shutDown) return false;
    const rawTokens = context.tokensUsed;
    const tokensUsed = (typeof rawTokens === 'number' && Number.isFinite(rawTokens) && rawTokens >= 0) ? rawTokens : 0;
    const tokenBudget = context.tokenBudget;
    if (!tokenBudget || tokenBudget <= 0) return false;
    const ratio = tokensUsed / tokenBudget;
    return ratio >= this._config.threshold;
  }

  _estimateSkillTokens(skill) {
    const instruction = skill.instruction ?? '';
    const summary = skill.summary || '';
    const instructionTokens = this._estimateTokens(instruction);
    const summaryTokens = this._estimateTokens(summary);
    return { instructionTokens, summaryTokens };
  }

  _estimateTokens(text) {
    if (!text) return 0;
    if (typeof text !== 'string') {
      text = String(text);
    }
    const nonAscii = (text.match(/[\x80-\uFFFF]/g) ?? []).length;
    const ascii = text.length - nonAscii;
    const ratio = this._config.tokenCharsRatio ?? 4;
    return Math.ceil((ascii + nonAscii * 2) / ratio);
  }

  _determineSkillCategory(skill, currentPhase, currentPhaseIdx, completedSkills) {
    const isCurrentPhase = skill.phase === currentPhase;
    const isFuturePhase = currentPhaseIdx !== undefined && PHASE_INDEX[skill.phase] !== undefined
      && PHASE_INDEX[skill.phase] > currentPhaseIdx;
    const isCompleted = completedSkills.has(skill.skill_id);

    let category = 'unclassified';
    const causalOverride = this._matchSkillPattern(skill, isCompleted, currentPhase);

    if (!causalOverride) {
      if (isCurrentPhase) category = 'current_phase';
      else if (isCompleted) category = 'completed_phase';
      else if (isFuturePhase) category = 'future_phase';
    }

    if (this._hasSpecificationOutput(skill)) {
      return { category: 'specification_asset', causalOverride: causalOverride, isCurrentPhase, isCompleted, isFuturePhase };
    }

    return { category, causalOverride, isCurrentPhase, isCompleted, isFuturePhase };
  }

  _matchSkillPattern(skill, isCompleted, currentPhase) {
    if (this._causalBufferManager && isCompleted && this._currentSkillId) {
      const causalStrategy = this._causalBufferManager.getCompressionStrategy(skill.skill_id, this._currentSkillId);
      if (causalStrategy === 'full') return { category: 'causal_relevance_high', strategy: 'full' };
      if (causalStrategy === 'summary') return { category: 'causal_relevance_medium', strategy: 'summary' };
      return { category: 'causal_relevance_low', strategy: 'discard' };
    }
    if (this._causalValidator && isCompleted) {
      const isCausalUpstream = this._isCausalUpstream(skill.skill_id, currentPhase);
      if (isCausalUpstream) return { category: 'causal_upstream', strategy: 'full' };
    }
    return null;
  }

  _hasSpecificationOutput(skill) {
    if (!skill.causal_outputs || !Array.isArray(skill.causal_outputs)) return false;
    for (let ci = 0; ci < skill.causal_outputs.length; ci++) {
      const output = skill.causal_outputs[ci];
      const outputName = (typeof output === 'object' && output !== null && output.name) ? output.name : output;
      if (outputName === 'specification') return true;
    }
    return false;
  }

  _classifySkill(skill, currentPhase, currentPhaseIdx, completedSkills, instructionTokens, summaryTokens) {
    const { category, causalOverride } = this._determineSkillCategory(skill, currentPhase, currentPhaseIdx, completedSkills);
    const strategies = this._config.strategies;

    if (category === 'specification_asset') {
      return this._applyStrategy(skill, 'full', 'specification_asset', instructionTokens, summaryTokens);
    }

    if (causalOverride) {
      return this._applyStrategy(skill, causalOverride.strategy, causalOverride.category, instructionTokens, summaryTokens);
    }

    const strategyKey = category === 'unclassified' ? 'unclassified' : category;
    let decision = strategies[strategyKey] || 'full';

    if (this._attentionBudgetManager) {
      const entryId = skill.skill_id || 'unknown';
      const { signalScore, signalLevel } = this._attentionBudgetManager.registerEntry(
        entryId, skill, instructionTokens, { currentPhase },
      );
      skill._signalScore = signalScore;
      skill._signalLevel = signalLevel;
      if (signalLevel === 'critical' || signalLevel === 'high') {
        decision = 'full';
      } else if (signalLevel === 'noise') {
        decision = 'discard';
      }
    }

    return this._applyStrategy(skill, decision, category, instructionTokens, summaryTokens);
  }

  /**
   * 设置当前正在执行的技能ID，用于因果缓冲管理器判断技能间压缩策略。
   * @param {string} skillId - 当前技能ID
   * @returns {ContextCompressionEngine} 当前实例（支持链式调用）
   */
  setCurrentSkillId(skillId) {
    this.guardShutdown();
    this._currentSkillId = skillId;
    return this;
  }

  _isCausalUpstream(skillId, currentPhase) {
    if (!this._causalValidator) return false;
    try {
      const graph = this._causalValidator.getDependencyGraph();
      if (!graph || !graph.skills) return false;
      if (this._causalUpstreamCache) {
        const cached = this._causalUpstreamCache.get(skillId + ':' + currentPhase);
        if (cached !== undefined && (Date.now() - cached.ts < DEFAULT_PIPELINE_TIMEOUT_MS)) return cached.value;
        if (cached !== undefined) this._causalUpstreamCache.delete(skillId + ':' + currentPhase);
      }
      const result = this._checkDependencyInGraph(graph, skillId, currentPhase);
      this._manageCausalCache(skillId, currentPhase, result);
      return result;
    } catch (_err) {
      debug('ContextCompressionEngine', '_checkCausalUpstream', _err);
      return { value: false, _error: _err.message || String(_err) };
    }
  }

  _checkDependencyInGraph(graph, skillId, currentPhase) {
    const currentPhaseSkills = Object.entries(graph.skills)
      .flatMap(([id, s]) => (s && s.phase === currentPhase) ? [id] : []);
    for (const currentSkillId of currentPhaseSkills) {
      const currentSkill = graph.skills[currentSkillId];
      if (currentSkill && currentSkill.dependsOnSet && currentSkill.dependsOnSet.has(skillId)) {
        return true;
      }
    }
    return false;
  }

  _manageCausalCache(skillId, currentPhase, value) {
    if (!this._causalUpstreamCache) this._causalUpstreamCache = new Map();
    if (this._causalUpstreamCache.size >= 500) {
      const now = Date.now();
      const toDelete = [];
      for (const [k, v] of this._causalUpstreamCache) {
        if (now - v.ts >= 5 * MS_PER_MINUTE) toDelete.push(k);
      }
      for (const k of toDelete) {
        this._causalUpstreamCache.delete(k);
      }
      if (this._causalUpstreamCache.size >= 500) {
        const oldestKey = this._causalUpstreamCache.keys().next().value;
        if (oldestKey) this._causalUpstreamCache.delete(oldestKey);
      }
    }
    this._causalUpstreamCache.set(skillId + ':' + currentPhase, { value: value, ts: Date.now() });
  }

  _applyStrategy(skill, strategy, reasonPrefix, instructionTokens, summaryTokens) {
    if (strategy === 'full') {
      return { compress: false, entry: { skill_id: skill.skill_id, phase: skill.phase, instruction: skill.instruction, summary: skill.summary, retained: true, reason: reasonPrefix, strategy } };
    }
    if (strategy === 'summary') {
      if (summaryTokens >= instructionTokens) {
        return { compress: false, entry: { skill_id: skill.skill_id, phase: skill.phase, instruction: skill.instruction, summary: skill.summary, retained: true, reason: reasonPrefix, strategy: 'full' } };
      }
      const labelMap = { current_phase: ' (current)', completed_phase: ' completed', future_phase: ' (upcoming)', unclassified: '' };
      const label = labelMap[reasonPrefix] || '';
      return { compress: true, entry: { skill_id: skill.skill_id, phase: skill.phase, summary: skill.summary || `${skill.skill_id}${label}`, compressed: true, originalTokenEstimate: instructionTokens, compressedTokenEstimate: summaryTokens, reason: reasonPrefix, strategy } };
    }
    return { compress: true, entry: { skill_id: skill.skill_id, phase: skill.phase, compressed: true, originalTokenEstimate: instructionTokens, compressedTokenEstimate: 0, reason: `${reasonPrefix}_discarded`, strategy } };
  }

  /**
   * 获取压缩计划，列出哪些技能应保留、哪些应压缩及预估节省Token数。
   * 结果按上下文状态缓存，相同输入直接命中缓存。
   * @param {Object} context - 上下文对象
   * @param {string} context.currentPhase - 当前执行阶段
   * @param {Array<Object>} [context.skills] - 技能列表
   * @param {Array<string>} [context.completedSkills] - 已完成技能ID列表
   * @returns {{ retain: Array<{skill_id: string, reason: string, strategy: string}>, compress: Array<{skill_id: string, reason: string, strategy: string, savings: number}>, estimatedSavings: number }} 压缩计划
   */
  getCompressionPlan(context) {
    this.guardShutdown();
    if (!context) return { retain: [], compress: [], estimatedSavings: 0 };

    const cacheKey = this._computePlanCacheKey(context);
    const cached = this._planCache.get(cacheKey);
    if (cached) {
      this._stats.cacheHits++;
      return cached;
    }

    const currentPhase = context.currentPhase || '';
    const currentPhaseIdx = PHASE_INDEX[currentPhase];
    const skills = context.skills ?? [];
    const completedSkills = new Set(context.completedSkills ?? []);
    const strategies = this._config.strategies;

    const retain = [];
    const compress = [];
    let estimatedSavings = 0;

    for (const skill of skills) {
      const result = this._classifySkillForPlan(skill, currentPhase, currentPhaseIdx, completedSkills, strategies);
      if (result.action === 'retain') {
        retain.push(result.entry);
      } else {
        compress.push(result.entry);
        estimatedSavings += result.savings;
      }
    }

    const plan = { retain, compress, estimatedSavings };

    if (this._planCache.size >= this._planCacheMaxSize) {
      const firstKey = this._planCache.keys().next().value;
      this._planCache.delete(firstKey);
    }
    this._planCache.set(cacheKey, plan);

    return plan;
  }

  _classifySkillForPlan(skill, currentPhase, currentPhaseIdx, completedSkills, strategies) {
    const { instructionTokens, summaryTokens } = this._estimateSkillTokens(skill);
    const { category, causalOverride } = this._determineSkillCategory(skill, currentPhase, currentPhaseIdx, completedSkills);

    if (category === 'specification_asset') {
      return { action: 'retain', entry: { skill_id: skill.skill_id, reason: 'specification_asset_full', strategy: 'full' }, savings: 0 };
    }

    if (causalOverride) {
      if (causalOverride.strategy === 'full') {
        return { action: 'retain', entry: { skill_id: skill.skill_id, reason: causalOverride.category, strategy: 'full' }, savings: 0 };
      }
      if (causalOverride.strategy === 'summary') {
        const savings = Math.max(0, instructionTokens - summaryTokens);
        return { action: 'compress', entry: { skill_id: skill.skill_id, reason: causalOverride.category, strategy: 'summary', savings }, savings };
      }
      return { action: 'compress', entry: { skill_id: skill.skill_id, reason: causalOverride.category + '_discard', strategy: 'discard', savings: instructionTokens }, savings: instructionTokens };
    }

    const strategy = strategies[category] || 'full';
    if (strategy === 'full') {
      return { action: 'retain', entry: { skill_id: skill.skill_id, reason: category + '_full', strategy }, savings: 0 };
    } else if (strategy === 'summary') {
      const savings = Math.max(0, instructionTokens - summaryTokens);
      return { action: 'compress', entry: { skill_id: skill.skill_id, reason: category, strategy, savings }, savings };
    }
    return { action: 'compress', entry: { skill_id: skill.skill_id, reason: category + '_discard', strategy, savings: instructionTokens }, savings: instructionTokens };
  }

  _computeStateHash(context) {
    const skills = context.skills ?? [];
    const completedSkills = Array.isArray(context.completedSkills) ? context.completedSkills : [];
    const phase = context.currentPhase || '';
    const skillIds = skills.flatMap(function(s) { return (s && s.skill_id) ? [s.skill_id + ':' + (s.phase || '')] : []; }).sort((a, b) => a.localeCompare(b)).join(',');
    const completed = completedSkills.slice().sort((a, b) => a.localeCompare(b)).join(',');
    let hashInput = phase + '|' + skillIds + '|' + completed;
    const specAssetIds = (context.specificationAssets ?? []).map(function(a) { return a.assetId; }).sort((a, b) => a.localeCompare(b)).join(',');
    hashInput = hashInput + '|' + specAssetIds;
    const decisions = (context.keyDecisions ?? []).join(',');
    hashInput = hashInput + '|' + decisions;
    const sessionKeys = context.sessionState ? Object.keys(context.sessionState).sort((a, b) => a.localeCompare(b)).join(',') : '';
    hashInput = hashInput + '|' + sessionKeys;
    let h = 0;
    for (let i = 0; i < hashInput.length; i++) {
      h = ((h << 5) - h + hashInput.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  _computePlanCacheKey(context) {
    const phase = context.currentPhase || '';
    const skillIds = (context.skills ?? []).map(function(s) { return s.skill_id || ''; }).sort((a, b) => a.localeCompare(b)).join(',');
    const completedIds = (context.completedSkills ?? []).slice().sort((a, b) => a.localeCompare(b)).join(',');
    return phase + ':' + skillIds + ':' + completedIds;
  }

  _invalidatePlanCache() {
    this._planCache.clear();
  }

  /**
   * 获取压缩引擎的统计信息，包括压缩次数、节省Token数、平均压缩比、缓存命中数等。
   * @returns {{ totalCompressions: number, totalTokensSaved: number, avgCompressionRatio: number, cacheHits: number, incrementalSkips: number, specificationAssetsRetained: number, planCacheSize: number, hasIncrementalState: boolean }} 统计信息
   */
  getStats() {
    this.guardShutdown();
    return mergeConfig(this._stats, {
      planCacheSize: this._planCache.size,
      hasIncrementalState: this._lastStateHash !== null,
    });
  }

  /**
   * 获取当前压缩引擎的配置副本。
   * @returns {Object} 配置对象
   */
  getConfig() {
    this.guardShutdown();
    return mergeConfig(this._config);
  }

  /**
   * 动态设置某个技能类别的压缩策略。设置后自动清除缓存和增量状态。
   * specification_asset类别仅允许'full'策略。
   * @param {string} category - 技能类别（completed_phase/future_phase/current_phase/unclassified/specification_asset）
   * @param {string} strategy - 压缩策略（full/summary/discard）
   * @returns {boolean} 设置是否成功
   */
  setStrategy(category, strategy) {
    this.guardShutdown();
    const validCategories = Object.keys(this._config.strategies);
    if (!validCategories.includes(category)) return false;
    if (!VALID_STRATEGIES.has(strategy)) return false;
    if (category === 'specification_asset' && strategy !== 'full') return false;
    this._config.strategies[category] = strategy;
    this._lastStateHash = null;
    this._lastResult = null;
    this._invalidatePlanCache();
    this.emit('strategy-changed', { category, strategy });
    return true;
  }

  /**
   * 获取当前所有类别的压缩策略副本。
   * @returns {Object} 策略映射（类别→策略名）
   */
  getStrategies() {
    return mergeConfig(this._config.strategies);
  }

  /**
   * 附加因果验证器，用于判断已完成技能是否为当前阶段技能的因果上游。
   * 附加后自动清除缓存和增量状态。
   * @param {Object} validator - 因果验证器，需实现getDependencyGraph方法
   * @returns {ContextCompressionEngine} 当前实例（支持链式调用）
   */
  attachConfigCausalValidator(validator) {
    if (!validator) return this;
    if (typeof validator.getDependencyGraph !== 'function') return this;
    this._causalValidator = validator;
    this._lastStateHash = null;
    this._lastResult = null;
    this._invalidatePlanCache();
    return this;
  }

  /**
   * 附加因果缓冲管理器，用于根据技能间因果关联获取压缩策略。
   * 附加后自动清除缓存和增量状态。
   * @param {Object} manager - 因果缓冲管理器，需实现getCompressionStrategy方法
   * @returns {ContextCompressionEngine} 当前实例（支持链式调用）
   */
  attachCausalBufferManager(manager) {
    if (!manager) return this;
    if (typeof manager.getCompressionStrategy !== 'function') return this;
    this._causalBufferManager = manager;
    this._lastStateHash = null;
    this._lastResult = null;
    this._invalidatePlanCache();
    return this;
  }

  /**
   * 附加注意力预算管理器，用于在技能分类时根据信号等级调整压缩策略
   * @param {Object} manager - 注意力预算管理器实例，需实现registerEntry方法
   * @returns {ContextCompressionEngine} 当前实例（支持链式调用）
   */
  attachAttentionBudgetManager(manager) {
    this._attentionBudgetManager = manager;
    return this;
  }

  /**
   * 压缩文本输出内容。去除填充词、冗余注释，超长内容截断保留关键信息。
   * 支持保留代码块结构、按句子截断和最大长度限制。
   * @param {string} output - 待压缩的文本输出
   * @param {Object} [options] - 压缩选项
   * @param {number} [options.maxLength=2000] - 最大输出字符数
   * @param {boolean} [options.preserveCodeBlocks=true] - 是否保留代码块
   * @param {boolean} [options.preserveStructure=true] - 是否保留结构
   * @param {boolean} [options.stripRedundant=true] - 是否去除冗余注释
   * @param {boolean} [options.stripFiller=true] - 是否去除填充词
   * @returns {string} 压缩后的文本
   */
  compressOutput(output, options) {
    if (!output || typeof output !== 'string') return output;
    const opts = mergeConfig({
      maxLength: 2000,
      preserveCodeBlocks: true,
      preserveStructure: true,
      stripRedundant: true,
      stripFiller: true,
    }, options);

    let result = output;

    if (opts.stripFiller) {
      result = result.replace(/^(Sure[,.]?\s*|Great\s+question[!.]?\s*|Let\s+me\s+(explain|help|analyze|think\s+about)\s+.*?[.]\s*|I('ll| will)\s+(help|explain|analyze|walk you through)\s+.*?[.]\s*|Here('s| is)\s+(the|my|a)\s+.*?[.:]\s*)/gim, '');
      result = result.replace(/^(In\s+summary[,.]?\s*|To\s+summarize[,.]?\s*|In\s+conclusion[,.]?\s*)/gim, '');
    }

    if (opts.stripRedundant) {
      result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const trimmed = code.trim();
        const lines = trimmed.split('\n');
        if (lines.length <= 3) return match;
        const first = lines[0];
        const last = lines[lines.length - 1];
        const middle = lines.slice(1, -1);
        const filtered = middle.filter(l => !/^\s*(\/\/.*|\/\*[\s\S]*?\*\/|\s*)$/.test(l) || /^\s*\/\/\s*(TODO|FIXME|HACK|NOTE|IMPORTANT)/.test(l));
        if (filtered.length < middle.length * 0.5) {
          const kept = [first, ...filtered, last].join('\n');
          return '```' + lang + '\n' + kept + '\n```';
        }
        return match;
      });
    }

    if (result.length > opts.maxLength) {
      const codeBlocks = [];
      let textOnly = result.replace(/```[\s\S]*?```/g, (match) => {
        codeBlocks.push(match);
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
      });

      const sentences = textOnly.split(/(?<=[.!?])\s+/);
      const kept = [];
      let charCount = 0;
      for (const s of sentences) {
        if (charCount + s.length > opts.maxLength * 0.6 && codeBlocks.length > 0) break;
        kept.push(s);
        charCount += s.length;
      }
      textOnly = kept.join(' ');

      for (let i = 0; i < codeBlocks.length; i++) {
        textOnly = textOnly.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
      }
      result = textOnly;

      if (result.length > opts.maxLength) {
        result = result.substring(0, opts.maxLength - 3) + '...';
      }
    }

    if (result !== output) {
      this._stats.outputCompressions = (this._stats.outputCompressions ?? 0) + 1;
      this._stats.outputTokensSaved = (this._stats.outputTokensSaved ?? 0) + Math.max(0, this._estimateTokens(output) - this._estimateTokens(result));
    }

    return result;
  }

  /**
   * 压缩工具调用输出。支持字符串行压缩（去重、过滤、截断）和对象输出压缩。
   * 对象类型自动截断长字符串和大数组，保留指定键。
   * @param {string|Object} output - 工具调用输出
   * @param {Object} [options] - 压缩选项
   * @param {number} [options.maxLines=50] - 字符串输出最大行数
   * @param {number} [options.groupThreshold=3] - 重复行合并阈值
   * @param {Array<string>} [options.filterPatterns=[]] - 过滤正则模式列表
   * @param {Array<string>} [options.preserveKeys=[]] - 对象输出中需保留的键
   * @returns {string|Object} 压缩后的输出
   */
  compressToolOutput(output, options) {
    if (!output) return output;
    const opts = mergeConfig({
      maxLines: 50,
      groupThreshold: 3,
      filterPatterns: [],
      preserveKeys: [],
    }, options);

    if (output !== null && typeof output === 'object') {
      return this._compressObjectOutput(output, opts);
    }

    if (typeof output !== 'string') return output;

    let lines = output.split('\n');

    const REDOS_DANGEROUS_RE = /(?:\([^)]*[+*][^)]*\))[+*{]|(?:\([^)]+\)[+*]){2,}|\(\?:[^)]*\)[+*]{2,}/;
    const MAX_QUANTIFIER_DENSITY = 8;
    for (const pattern of opts.filterPatterns) {
      try {
        if (typeof pattern !== 'string' || pattern.length > 200 || REDOS_DANGEROUS_RE.test(pattern)) {
          debug('ContextCompressionEngine', 'filterPatternRejected', 'Pattern rejected: ' + (typeof pattern !== 'string' ? 'not a string' : pattern.length > 200 ? 'exceeds max length' : 'dangerous quantifier nesting'));
          continue;
        }
        const quantifierCount = (pattern.match(/[+*{]/g) ?? []).length;
        if (quantifierCount > MAX_QUANTIFIER_DENSITY) {
          debug('ContextCompressionEngine', 'filterPatternRejected', 'Pattern rejected: too many quantifiers (' + quantifierCount + ')');
          continue;
        }
        const regex = (function() { try { return new RegExp(pattern); } catch (_e) { debug('ContextCompressionEngine', 'compileRegex', _e && _e.message ? _e.message : String(_e)); return /^$/; } })();
        lines = lines.filter(l => {
          try { return !regex.test(l); } catch (_e) { debug('ContextCompressionEngine', 'testRegex', _e && _e.message ? _e.message : String(_e)); return true; }
        });
      } catch (_e) { debug('ContextCompressionEngine', 'filterPatternInvalid', _e && _e.message ? _e.message : String(_e)); }
    }

    const grouped = this._groupRepeatingLines(lines, opts.groupThreshold);
    lines = grouped;

    if (lines.length > opts.maxLines) {
      const head = lines.slice(0, Math.ceil(opts.maxLines * 0.6));
      const tail = lines.slice(-Math.ceil(opts.maxLines * 0.3));
      const skipped = lines.length - head.length - tail.length;
      lines = [...head, `... (${skipped} lines omitted) ...`, ...tail];
    }

    const result = lines.join('\n');
    if (result !== output) {
      this._stats.toolOutputCompressions = (this._stats.toolOutputCompressions ?? 0) + 1;
    }
    return result;
  }

  _compressObjectOutput(obj, opts) {
    if (Array.isArray(obj)) {
      if (obj.length <= 5) return obj;
      return [...obj.slice(0, 3), `... (${obj.length - 5} items omitted)`, ...obj.slice(-2)];
    }
    if (typeof obj === 'object' && obj !== null) {
      const keys = Object.keys(obj);
      const result = {};
      for (const key of keys) {
        if (opts.preserveKeys.includes(key)) {
          result[key] = obj[key];
        } else {
          const val = obj[key];
          if (typeof val === 'string' && val.length > 500) {
            result[key] = val.substring(0, 200) + `... (${val.length - 200} chars omitted)`;
          } else if (Array.isArray(val) && val.length > 10) {
            result[key] = [...val.slice(0, 5), `... (${val.length - 5} items omitted)`, ...val.slice(-2)];
          } else {
            result[key] = val;
          }
        }
      }
      return result;
    }
    return obj;
  }

  _groupRepeatingLines(lines, threshold) {
    if (threshold < 2 || lines.length < threshold) return lines;
    const result = [];
    let i = 0;
    while (i < lines.length) {
      let count = 1;
      while (i + count < lines.length && lines[i + count] === lines[i]) {
        count++;
      }
      if (count >= threshold) {
        result.push(`${lines[i]} (x${count})`);
        i += count;
      } else {
        result.push(lines[i]);
        i++;
      }
    }
    return result;
  }

  _onShutdown() {
    this._planCache.clear();
    this._lastStateHash = null;
    this._lastResult = null;
    this._causalValidator = null;
    this._causalBufferManager = null;
    this._causalUpstreamCache = null;
    this._attentionBudgetManager = null;
    this.removeAllListeners();
  }

  /**
   * 根据跨扩展上下文成本排名获取压缩建议。融合自Claude Code的上下文成本层级。
   * 当Token预算不足时，按此方法返回的顺序决定压缩优先级：
   * 先压缩低成本扩展（Hooks），后压缩高成本扩展（Rules）。
   *
   * @param {Object} tokenUsage - 各扩展类型的Token使用量
   * @param {number} [tokenUsage.rules=0] - 规则/约定占用Token
   * @param {number} [tokenUsage.skills=0] - 技能占用Token
   * @param {number} [tokenUsage.mcp=0] - MCP占用Token
   * @param {number} [tokenUsage.subagents=0] - 子Agent占用Token
   * @param {number} [tokenUsage.hooks=0] - 钩子占用Token
   * @param {number} budget - 可用Token预算
   * @returns {{ compressOrder: Array<{label: string, rank: number, tokens: number, suggestedAction: string}>, totalUsed: number, overBudget: number }}
   */
  getExtensionCompressionPlan(tokenUsage, budget) {
    const usage = tokenUsage ?? {};
    const totalUsed = (usage.rules ?? 0) + (usage.skills ?? 0) + (usage.mcp ?? 0) + (usage.subagents ?? 0) + (usage.hooks ?? 0);
    const overBudget = Math.max(0, totalUsed - (budget ?? 0));
    const compressOrder = EXTENSION_COMPRESS_ORDER.map(function(ext) {
      const tokens = usage[ext.label] ?? 0;
      let suggestedAction = 'keep';
      if (overBudget > 0 && tokens > 0) {
        if (ext.rank <= 2) suggestedAction = 'discard';
        else if (ext.rank <= 3) suggestedAction = 'summary';
        else suggestedAction = 'keep';
      }
      return { label: ext.label, rank: ext.rank, tokens: tokens, suggestedAction: suggestedAction };
    }).filter(function(item) { return item.tokens > 0; });
    return { compressOrder: compressOrder, totalUsed: totalUsed, overBudget: overBudget };
  }

  /**
   * 按扩展类型分配全局Token预算。融合自Claude Code的上下文成本层级概念。
   * 根据各扩展类型的成本排名和默认比例，将总预算分配到各类型。
   * 当某类型实际用量为0时，其预算按比例重新分配给其他活跃类型。
   *
   * @param {number} totalBudget - 全局Token预算总量
   * @param {Object} [customRatios] - 自定义分配比例（覆盖默认值）
   * @param {number} [customRatios.rules] - 规则分配比例
   * @param {number} [customRatios.skills] - 技能分配比例
   * @param {number} [customRatios.mcp] - MCP分配比例
   * @param {number} [customRatios.subagents] - 子Agent分配比例
   * @param {number} [customRatios.hooks] - 钩子分配比例
   * @param {Object} [currentUsage] - 当前各类型实际使用量
   * @returns {{ allocations: Array<{label: string, rank: number, budget: number, ratio: number, usage: number, utilization: number, overBudget: boolean}>, totalBudget: number, allocatedTotal: number, unallocated: number }}
   */
  allocateBudgetByExtension(totalBudget, customRatios, currentUsage) {
    if (!totalBudget || totalBudget <= 0) {
      return { allocations: [], totalBudget: 0, allocatedTotal: 0, unallocated: 0 };
    }
    const ratios = mergeConfig(DEFAULT_EXTENSION_BUDGET_RATIOS, customRatios ?? {});
    const usage = currentUsage ?? {};

    // 计算活跃类型（有实际用量的类型）
    const activeLabels = Object.keys(ratios).filter(function(label) {
      return (usage[label] ?? 0) > 0 || ratios[label] > 0;
    });

    // 归一化比例（确保总和为1）
    const ratioSum = activeLabels.reduce(function(sum, label) { return sum + (ratios[label] ?? 0); }, 0);
    if (ratioSum <= 0) {
      return { allocations: [], totalBudget: totalBudget, allocatedTotal: 0, unallocated: totalBudget };
    }

    const allocations = activeLabels.map(function(label) {
      const normalizedRatio = (ratios[label] ?? 0) / ratioSum;
      const budget = Math.floor(totalBudget * normalizedRatio);
      const extUsage = usage[label] ?? 0;
      const rankEntry = Object.values(EXTENSION_COST_RANK).find(function(e) { return e.label === label; });
      return {
        label: label,
        rank: rankEntry ? rankEntry.rank : 0,
        budget: budget,
        ratio: roundTo(normalizedRatio, 4),
        usage: extUsage,
        utilization: budget > 0 ? roundTo(extUsage / budget, 4) : 0,
        overBudget: extUsage > budget,
      };
    });

    const allocatedTotal = allocations.reduce(function(sum, a) { return sum + a.budget; }, 0);
    return {
      allocations: allocations,
      totalBudget: totalBudget,
      allocatedTotal: allocatedTotal,
      unallocated: totalBudget - allocatedTotal,
    };
  }
}

ContextCompressionEngine.EXTENSION_COST_RANK = EXTENSION_COST_RANK;
ContextCompressionEngine.EXTENSION_COMPRESS_ORDER = EXTENSION_COMPRESS_ORDER;
ContextCompressionEngine.DEFAULT_EXTENSION_BUDGET_RATIOS = DEFAULT_EXTENSION_BUDGET_RATIOS;

module.exports = withShutdown(ContextCompressionEngine);
