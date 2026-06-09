'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const BoundedMap = require('../../utils/bounded-map');

const PHASE_ORDER = {
  brainstorming: 0,
  'requirement-analysis': 1,
  'architecture-design': 2,
  'module-development': 3,
  'integration-testing': 4,
  deployment: 5,
};

const MULTI_PHASE_INDICATORS = /\b(and|also|then|after that|additionally|furthermore|moreover|as well as|along with|接着|然后|同时|此外|另外|并且|以及)\b/i;

const DOMAIN_KEYWORDS = {
  frontend: ['ui', 'css', 'html', 'component', 'style', 'layout', 'design', 'responsive', 'animation'],
  backend: ['api', 'server', 'database', 'endpoint', 'route', 'middleware', 'auth', 'session'],
  devops: ['deploy', 'ci', 'cd', 'pipeline', 'docker', 'kubernetes', 'monitoring', 'infrastructure'],
  testing: ['test', 'spec', 'coverage', 'unit', 'integration', 'e2e', 'mock', 'stub'],
  security: ['security', 'vulnerability', 'audit', 'encrypt', 'auth', 'permission', 'xss', 'injection'],
  architecture: ['architecture', 'design', 'pattern', 'module', 'interface', 'dependency', 'layer'],
};

const VALID_PLACEMENT_STRATEGIES = new Set(['relevance-first', 'phase-ordered', 'attention-weighted']);

class SkillEffectivenessOptimizer extends EventEmitter {
  /**
   * 创建 SkillEffectivenessOptimizer 实例。
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.skillRouter=null] - SkillRouter实例
   * @param {Object} [options.skillReducer=null] - SkillReducer实例
   * @param {Object} [options.skillCurator=null] - SkillCurator实例
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._skillRouter = opts.skillRouter ?? null;
    this._skillReducer = opts.skillReducer ?? null;
    this._skillCurator = opts.skillCurator ?? null;
    this._skillObservability = opts.skillObservability ?? null;
    this._maxActiveSkills = typeof opts.maxActiveSkills === 'number' && opts.maxActiveSkills > 0
      ? opts.maxActiveSkills
      : SkillEffectivenessOptimizer.MAX_ACTIVE_SKILLS;
    this._adaptiveTopK = opts.adaptiveTopK !== undefined
      ? !!opts.adaptiveTopK
      : SkillEffectivenessOptimizer.ADAPTIVE_TOP_K;
    this._minTopK = typeof opts.minTopK === 'number' && opts.minTopK > 0
      ? opts.minTopK
      : SkillEffectivenessOptimizer.MIN_TOP_K;
    this._maxTopK = typeof opts.maxTopK === 'number' && opts.maxTopK > 0
      ? opts.maxTopK
      : SkillEffectivenessOptimizer.MAX_TOP_K;
    this._relevanceDecayFactor = typeof opts.relevanceDecayFactor === 'number' && opts.relevanceDecayFactor > 0 && opts.relevanceDecayFactor < 1
      ? opts.relevanceDecayFactor
      : SkillEffectivenessOptimizer.RELEVANCE_DECAY_FACTOR;
    this._placementStrategy = VALID_PLACEMENT_STRATEGIES.has(opts.placementStrategy)
      ? opts.placementStrategy
      : SkillEffectivenessOptimizer.PLACEMENT_STRATEGY;
    this._invocationLog = new BoundedMap(SkillEffectivenessOptimizer.MAX_INVOCATION_LOG);
    this._taskComplexityHistory = new BoundedMap(SkillEffectivenessOptimizer.MAX_COMPLEXITY_HISTORY);
    this._skillRelevanceScores = new BoundedMap(SkillEffectivenessOptimizer.MAX_RELEVANCE_SCORES);
    this._stats = {
      totalOptimizations: 0,
      totalSkillMatches: 0,
      totalSkillInvocations: 0,
      totalRelevantInvocations: 0,
      avgPrecision: 0,
      avgRecall: 0,
      overloadDetections: 0,
      adaptiveTopKAdjustments: 0,
    };
    this._initialized = false;
  }

  attachSkillRouter(router) {
    this.guardShutdown();
    this._skillRouter = router;
    return this;
  }

  attachSkillReducer(reducer) {
    this.guardShutdown();
    this._skillReducer = reducer;
    return this;
  }

  attachSkillCurator(curator) {
    this.guardShutdown();
    this._skillCurator = curator;
    return this;
  }

  attachSkillObservability(observability) {
    this.guardShutdown();
    this._skillObservability = observability;
    return this;
  }

  /**
   * 初始化SkillEffectivenessOptimizer，标记为已初始化状态。
   * @async
   * @returns {Promise<void>}
   * @emits SkillEffectivenessOptimizer#initialized
   */
  async initialize() {
    this.guardShutdown();
    this._initialized = true;
    this.emit('initialized');
  }

  optimizeSkillSelection(matchedSkills, context) {
    this.guardShutdown();
    if (!Array.isArray(matchedSkills)) {
      return { selectedSkills: [], truncated: false, originalCount: 0, scores: {} };
    }
    const originalCount = matchedSkills.length;
    this._stats.totalSkillMatches += originalCount;
    if (originalCount <= this._maxActiveSkills) {
      this._stats.totalOptimizations++;
      const scores = {};
      for (const skill of matchedSkills) {
        scores[skill.skill_id || skill.id || ''] = 1.0;
      }
      this.emit('skills-optimized', { selectedCount: originalCount, truncated: false, originalCount });
      return { selectedSkills: matchedSkills.slice(), truncated: false, originalCount, scores };
    }

    const scored = matchedSkills.map(skill => {
      const id = skill.skill_id || skill.id || '';
      const score = this._computeRelevanceScore(skill, context);
      return { skill, score, id };
    });

    scored.sort((a, b) => b.score - a.score);

    const selected = scored.slice(0, this._maxActiveSkills);
    const selectedSkills = selected.map(s => s.skill);
    const scores = {};
    for (const s of scored) {
      scores[s.id] = s.score;
    }

    this._stats.totalOptimizations++;
    this.emit('skills-optimized', { selectedCount: selectedSkills.length, truncated: true, originalCount });
    return { selectedSkills, truncated: true, originalCount, scores };
  }

  _computeRelevanceScore(skill, context) {
    let score = 0;
    const ctx = context ?? {};
    const currentPhase = ctx.phase || '';

    if (currentPhase && skill.phase === currentPhase) {
      score += SkillEffectivenessOptimizer.PHASE_RELEVANCE_WEIGHT;
    }

    const usageData = this._getSkillUsageData(skill.skill_id || skill.id || '');
    if (usageData && usageData.calls > 0) {
      const maxCalls = this._getMaxUsageCalls();
      const normalized = maxCalls > 0 ? usageData.calls / maxCalls : 0;
      score += Math.min(normalized, 1) * SkillEffectivenessOptimizer.USAGE_FREQUENCY_WEIGHT;
    }

    const lastUsed = this._getLastInvocationTime(skill.skill_id || skill.id || '');
    if (lastUsed > 0) {
      const elapsed = Date.now() - lastUsed;
      const decayed = Math.pow(this._relevanceDecayFactor, elapsed / 3600000);
      score += decayed * SkillEffectivenessOptimizer.RECENCY_WEIGHT;
    }

    if (skill.depends_on && Array.isArray(skill.depends_on)) {
      const completedDeps = skill.depends_on.filter(dep => this._isSkillCompleted(dep));
      if (skill.depends_on.length > 0) {
        score += (completedDeps.length / skill.depends_on.length) * SkillEffectivenessOptimizer.DEPENDENCY_WEIGHT;
      }
    }

    const semanticScore = this._computeSemanticMatch(skill, ctx);
    score += semanticScore * SkillEffectivenessOptimizer.SEMANTIC_MATCH_WEIGHT;

    return score;
  }

  _getSkillUsageData(skillId) {
    if (this._skillCurator && typeof this._skillCurator.getSkillStats === 'function') {
      return safeExecute(
        () => this._skillCurator.getSkillStats(skillId),
        'SkillEffectivenessOptimizer',
        'getSkillUsageData',
        null,
      );
    }
    return null;
  }

  _getMaxUsageCalls() {
    if (this._skillCurator && typeof this._skillCurator.getAllStats === 'function') {
      const allStats = safeExecute(
        () => this._skillCurator.getAllStats(),
        'SkillEffectivenessOptimizer',
        'getMaxUsageCalls',
        null,
      );
      if (allStats && allStats.skillStats) {
        let max = 0;
        for (const data of Object.values(allStats.skillStats)) {
          if (data.calls > max) max = data.calls;
        }
        return max;
      }
    }
    return 1;
  }

  _getLastInvocationTime(skillId) {
    const entry = this._invocationLog.get(skillId);
    if (entry && typeof entry.timestamp === 'number') {
      return entry.timestamp;
    }
    return 0;
  }

  _isSkillCompleted(skillId) {
    const entry = this._invocationLog.get(skillId);
    return entry ? !!entry.relevant : false;
  }

  _computeSemanticMatch(skill, context) {
    const userMessage = (context.userMessage || context.message || '').toLowerCase();
    if (!userMessage) return 0;

    const keywords = [];
    if (skill.trigger_keywords && Array.isArray(skill.trigger_keywords)) {
      keywords.push(...skill.trigger_keywords);
    }
    if (skill.name) {
      keywords.push(skill.name);
    }
    if (skill.summary) {
      const words = skill.summary.toLowerCase().split(/\s+/);
      keywords.push(...words.filter(w => w.length >= 3));
    }

    if (keywords.length === 0) return 0;

    let matchCount = 0;
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (kwLower.length >= 2 && userMessage.includes(kwLower)) {
        matchCount++;
      }
    }

    return Math.min(matchCount / Math.max(keywords.length, 1), 1);
  }

  computeAdaptiveTopK(context) {
    this.guardShutdown();
    const ctx = context ?? {};
    const userMessage = (ctx.userMessage || ctx.message || '').toLowerCase();
    const taskSignature = ctx.taskSignature || userMessage.slice(0, 100);

    const cached = taskSignature ? this._taskComplexityHistory.get(taskSignature) : null;
    if (cached) {
      this._stats.adaptiveTopKAdjustments++;
      return cached;
    }

    const signals = this._analyzeComplexitySignals(userMessage);
    const { complexity } = this._computeComplexityLevel(signals);
    const topK = this._topKForComplexity(complexity);
    const result = { topK, complexity, signals };

    if (taskSignature) {
      this._taskComplexityHistory.set(taskSignature, result);
    }

    this._stats.adaptiveTopKAdjustments++;
    return result;
  }

  _analyzeComplexitySignals(userMessage) {
    const signals = {
      topicCount: 0,
      hasMultiPhase: false,
      constraintCount: 0,
      domainCount: 0,
    };

    const uniqueTopics = new Set();
    const words = userMessage.split(/\s+/).filter(w => w.length >= 3);
    for (const word of words) {
      uniqueTopics.add(word);
    }
    signals.topicCount = uniqueTopics.size;

    signals.hasMultiPhase = MULTI_PHASE_INDICATORS.test(userMessage);

    const constraintPatterns = /\b(must|should|need|require|ensure|guarantee|constraint|limit|boundary|必须|应该|需要|确保|限制|约束)\b/gi;
    const constraintMatches = userMessage.match(constraintPatterns);
    signals.constraintCount = constraintMatches ? constraintMatches.length : 0;

    const matchedDomains = new Set();
    for (const [, kws] of Object.entries(DOMAIN_KEYWORDS)) {
      for (const kw of kws) {
        if (userMessage.includes(kw.toLowerCase())) {
          matchedDomains.add(kw);
          break;
        }
      }
    }
    signals.domainCount = matchedDomains.size;

    return signals;
  }

  _computeComplexityLevel(signals) {
    let complexityScore = 0;

    if (signals.topicCount > 5) complexityScore += 2;
    else if (signals.topicCount > 2) complexityScore += 1;

    if (signals.hasMultiPhase) complexityScore += 2;

    if (signals.constraintCount > 3) complexityScore += 2;
    else if (signals.constraintCount > 1) complexityScore += 1;

    if (signals.domainCount > 2) complexityScore += 2;
    else if (signals.domainCount > 1) complexityScore += 1;

    let complexity = 'simple';
    if (complexityScore >= 5) complexity = 'high';
    else if (complexityScore >= 2) complexity = 'medium';

    return { complexity, complexityScore };
  }

  _topKForComplexity(complexity) {
    let topK;
    if (complexity === 'high') topK = this._maxTopK;
    else if (complexity === 'medium') topK = Math.round((this._minTopK + this._maxTopK) / 2);
    else topK = this._minTopK;
    return Math.min(topK, this._maxActiveSkills);
  }

  optimizePlacement(skills, context) {
    this.guardShutdown();
    if (!Array.isArray(skills) || skills.length === 0) {
      return { orderedSkills: [], strategy: this._placementStrategy };
    }

    let orderedSkills;

    switch (this._placementStrategy) {
      case 'relevance-first':
        orderedSkills = this._placeRelevanceFirst(skills, context);
        break;
      case 'phase-ordered':
        orderedSkills = this._placePhaseOrdered(skills, context);
        break;
      case 'attention-weighted':
        orderedSkills = this._placeAttentionWeighted(skills, context);
        break;
      default:
        orderedSkills = skills.slice();
    }

    return { orderedSkills, strategy: this._placementStrategy };
  }

  _placeRelevanceFirst(skills, context) {
    const scored = skills.map(skill => ({
      skill,
      score: this._computeRelevanceScore(skill, context),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.skill);
  }

  _placePhaseOrdered(skills, context) {
    const currentPhase = (context && context.phase) || '';
    const currentOrder = PHASE_ORDER[currentPhase] !== undefined ? PHASE_ORDER[currentPhase] : 99;

    const scored = skills.map(skill => {
      const skillPhase = skill.phase || '';
      const skillOrder = PHASE_ORDER[skillPhase] !== undefined ? PHASE_ORDER[skillPhase] : 99;
      const distance = Math.abs(skillOrder - currentOrder);
      return { skill, distance, skillOrder };
    });

    scored.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.skillOrder - b.skillOrder;
    });

    return scored.map(s => s.skill);
  }

  _placeAttentionWeighted(skills, _context) {
    if (skills.length <= 2) return skills.slice();

    const scored = skills.map(skill => ({
      skill,
      score: this._computeRelevanceScore(skill, _context),
    }));
    scored.sort((a, b) => b.score - a.score);

    const result = new Array(scored.length);
    let front = 0;
    let back = scored.length - 1;

    for (let i = 0; i < scored.length; i++) {
      if (i % 2 === 0) {
        result[front] = scored[i].skill;
        front++;
      } else {
        result[back] = scored[i].skill;
        back--;
      }
    }

    return result;
  }

  generateExplicitGuidance(selectedSkills, _context) {
    this.guardShutdown();
    if (!Array.isArray(selectedSkills) || selectedSkills.length === 0) {
      return { guidance: '', skillCount: 0, skills: [] };
    }

    const parts = [];
    const skillSummaries = [];

    for (let i = 0; i < selectedSkills.length; i++) {
      const skill = selectedSkills[i];
      const id = skill.skill_id || skill.id || 'unknown';
      const name = skill.name || id;
      const purpose = skill.summary || skill.description || 'task execution';
      parts.push((i + 1) + ') ' + name + ' for ' + purpose);
      skillSummaries.push({ id, name, purpose });
    }

    const guidance = 'For this task, you should use these skills in order: '
      + parts.join(', ')
      + '. Do NOT attempt this task without following these skills.';

    return { guidance, skillCount: selectedSkills.length, skills: skillSummaries };
  }

  recordInvocation(skillId, invoked, relevant) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') {
      return { precision: 0, recall: 0, totalInvocations: this._stats.totalSkillInvocations };
    }

    const entry = {
      skillId,
      matched: true,
      invoked: !!invoked,
      relevant: !!relevant,
      timestamp: Date.now(),
    };

    this._invocationLog.set(skillId, entry);

    if (invoked) {
      this._stats.totalSkillInvocations++;
    }
    if (invoked && relevant) {
      this._stats.totalRelevantInvocations++;
    }

    const currentScore = this._skillRelevanceScores.get(skillId);
    if (currentScore != null && Number.isFinite(currentScore)) {
      const newScore = relevant
        ? currentScore * 0.8 + 1.0 * 0.2
        : currentScore * 0.8 + 0.0 * 0.2;
      this._skillRelevanceScores.set(skillId, newScore);
    } else {
      this._skillRelevanceScores.set(skillId, relevant ? 1.0 : 0.0);
    }

    this._recalculateAccuracy();

    this.emit('invocation-recorded', { skillId, invoked, relevant });

    return {
      precision: this._stats.avgPrecision,
      recall: this._stats.avgRecall,
      totalInvocations: this._stats.totalSkillInvocations,
    };
  }

  _recalculateAccuracy() {
    let totalInvoked = 0;
    let totalInvokedAndRelevant = 0;
    let totalMatchedAndRelevant = 0;

    this._invocationLog.forEach(entry => {
      if (entry.invoked) {
        totalInvoked++;
        if (entry.relevant) {
          totalInvokedAndRelevant++;
        }
      }
      if (entry.matched && entry.relevant) {
        totalMatchedAndRelevant++;
      }
    });

    this._stats.avgPrecision = totalInvoked > 0
      ? totalInvokedAndRelevant / totalInvoked
      : 0;
    this._stats.avgRecall = totalMatchedAndRelevant > 0
      ? totalInvokedAndRelevant / totalMatchedAndRelevant
      : 0;
  }

  getAccuracyMetrics() {
    this.guardShutdown();

    let totalInvoked = 0;
    let totalInvokedAndRelevant = 0;
    let totalInvokedAndNotRelevant = 0;
    let totalMatchedAndRelevant = 0;
    let sampleSize = 0;

    this._invocationLog.forEach(entry => {
      sampleSize++;
      if (entry.invoked) {
        totalInvoked++;
        if (entry.relevant) {
          totalInvokedAndRelevant++;
        } else {
          totalInvokedAndNotRelevant++;
        }
      }
      if (entry.matched && entry.relevant) {
        totalMatchedAndRelevant++;
      }
    });

    const precision = totalInvoked > 0
      ? totalInvokedAndRelevant / totalInvoked
      : 0;
    const recall = totalMatchedAndRelevant > 0
      ? totalInvokedAndRelevant / totalMatchedAndRelevant
      : 0;
    const f1 = (precision + recall) > 0
      ? 2 * precision * recall / (precision + recall)
      : 0;
    const falsePositiveRate = totalInvoked > 0
      ? totalInvokedAndNotRelevant / totalInvoked
      : 0;

    return {
      precision,
      recall,
      f1,
      falsePositiveRate,
      totalInvocations: totalInvoked,
      totalRelevant: totalMatchedAndRelevant,
      sampleSize,
    };
  }

  detectOverload(activeSkillCount, contextTokenEstimate) {
    this.guardShutdown();

    if (activeSkillCount > this._maxActiveSkills) {
      this._stats.overloadDetections++;
      return {
        overloaded: true,
        level: 'critical',
        recommendation: 'Reduce active skills to ' + this._maxActiveSkills,
        activeSkillCount,
      };
    }

    if (activeSkillCount > this._maxActiveSkills * 0.8) {
      this._stats.overloadDetections++;
      return {
        overloaded: true,
        level: 'warning',
        recommendation: 'Approaching skill limit',
        activeSkillCount,
      };
    }

    if (typeof contextTokenEstimate === 'number' && contextTokenEstimate > 0
      && contextTokenEstimate > SkillEffectivenessOptimizer.CONTEXT_TOKEN_BUDGET) {
      this._stats.overloadDetections++;
      return {
        overloaded: true,
        level: 'warning',
        recommendation: 'Skill context exceeds token budget',
        activeSkillCount,
        contextTokenEstimate,
      };
    }

    return {
      overloaded: false,
      level: 'none',
      activeSkillCount,
    };
  }

  /**
   * 完整优化流水线，依次执行自适应TopK计算、技能选择、排序、引导生成和过载检测。
   * @async
   * @param {Array<object>} matchedSkills - 匹配到的技能列表
   * @param {object} [context] - 上下文信息，用于技能匹配和评分
   * @returns {Promise<object>} 优化结果，包含selectedSkills、orderedSkills、guidance、topK、overload、metrics
   */
  async fullOptimizationPipeline(matchedSkills, context) {
    this.guardShutdown();

    if (!Array.isArray(matchedSkills)) {
      matchedSkills = [];
    }

    const adaptiveResult = this.computeAdaptiveTopK(context ?? {});
    const topK = adaptiveResult.topK;

    let skills = matchedSkills;
    if (this._skillRouter && typeof this._skillRouter.match === 'function' && context) {
      const reMatched = safeExecute(
        () => this._skillRouter.match(context),
        'SkillEffectivenessOptimizer',
        'fullPipeline:reMatch',
        [],
      );
      if (Array.isArray(reMatched) && reMatched.length > 0) {
        skills = reMatched.slice(0, topK);
      }
    }

    const selectionResult = this.optimizeSkillSelection(skills, context ?? {});
    const selectedSkills = selectionResult.selectedSkills;

    const placementResult = this.optimizePlacement(selectedSkills, context ?? {});
    const orderedSkills = placementResult.orderedSkills;

    const guidanceResult = this.generateExplicitGuidance(orderedSkills, context ?? {});

    let estimatedTokens = 0;
    for (const skill of orderedSkills) {
      const summary = skill.summary || skill.instruction || '';
      estimatedTokens += Math.ceil(summary.length / 4);
    }
    const overloadResult = this.detectOverload(orderedSkills.length, estimatedTokens);

    return {
      selectedSkills,
      orderedSkills,
      guidance: guidanceResult.guidance,
      topK,
      overload: overloadResult,
      metrics: this.getAccuracyMetrics(),
    };
  }

  getStats() {
    return {
      totalOptimizations: this._stats.totalOptimizations,
      totalSkillMatches: this._stats.totalSkillMatches,
      totalSkillInvocations: this._stats.totalSkillInvocations,
      totalRelevantInvocations: this._stats.totalRelevantInvocations,
      avgPrecision: this._stats.avgPrecision,
      avgRecall: this._stats.avgRecall,
      overloadDetections: this._stats.overloadDetections,
      adaptiveTopKAdjustments: this._stats.adaptiveTopKAdjustments,
      invocationLogSize: this._invocationLog.size,
      complexityHistorySize: this._taskComplexityHistory.size,
      relevanceScoresSize: this._skillRelevanceScores.size,
      maxActiveSkills: this._maxActiveSkills,
      adaptiveTopK: this._adaptiveTopK,
      minTopK: this._minTopK,
      maxTopK: this._maxTopK,
      placementStrategy: this._placementStrategy,
    };
  }

  isHealthy() {
    return !this._shutDown;
  }

  isReady() {
    return !this._shutDown && this._initialized;
  }

  _onShutdown() {
    this._initialized = false;
    this._skillRouter = null;
    this._skillReducer = null;
    this._skillCurator = null;
    this._skillObservability = null;
    this._stats = {
      totalOptimizations: 0,
      totalSkillMatches: 0,
      totalSkillInvocations: 0,
      totalRelevantInvocations: 0,
      avgPrecision: 0,
      avgRecall: 0,
      overloadDetections: 0,
      adaptiveTopKAdjustments: 0,
    };
    this._invocationLog.clear();
    this._taskComplexityHistory.clear();
    this._skillRelevanceScores.clear();
    this.removeAllListeners();
  }
}

SkillEffectivenessOptimizer.MAX_ACTIVE_SKILLS = 12;
SkillEffectivenessOptimizer.ADAPTIVE_TOP_K = true;
SkillEffectivenessOptimizer.MIN_TOP_K = 3;
SkillEffectivenessOptimizer.MAX_TOP_K = 8;
SkillEffectivenessOptimizer.RELEVANCE_DECAY_FACTOR = 0.9;
SkillEffectivenessOptimizer.PLACEMENT_STRATEGY = 'attention-weighted';
SkillEffectivenessOptimizer.MAX_INVOCATION_LOG = 500;
SkillEffectivenessOptimizer.MAX_COMPLEXITY_HISTORY = 200;
SkillEffectivenessOptimizer.MAX_RELEVANCE_SCORES = 200;
SkillEffectivenessOptimizer.PHASE_RELEVANCE_WEIGHT = 0.3;
SkillEffectivenessOptimizer.USAGE_FREQUENCY_WEIGHT = 0.2;
SkillEffectivenessOptimizer.RECENCY_WEIGHT = 0.2;
SkillEffectivenessOptimizer.DEPENDENCY_WEIGHT = 0.15;
SkillEffectivenessOptimizer.SEMANTIC_MATCH_WEIGHT = 0.15;
SkillEffectivenessOptimizer.CONTEXT_TOKEN_BUDGET = 8000;

module.exports = withShutdown(SkillEffectivenessOptimizer);
Object.assign(module.exports, {
  MAX_ACTIVE_SKILLS: 12,
  ADAPTIVE_TOP_K: true,
  MIN_TOP_K: 3,
  MAX_TOP_K: 8,
  RELEVANCE_DECAY_FACTOR: 0.9,
  PLACEMENT_STRATEGY: 'attention-weighted',
  MAX_INVOCATION_LOG: 500,
  MAX_COMPLEXITY_HISTORY: 200,
  MAX_RELEVANCE_SCORES: 200,
  PHASE_RELEVANCE_WEIGHT: 0.3,
  USAGE_FREQUENCY_WEIGHT: 0.2,
  RECENCY_WEIGHT: 0.2,
  DEPENDENCY_WEIGHT: 0.15,
  SEMANTIC_MATCH_WEIGHT: 0.15,
  CONTEXT_TOKEN_BUDGET: 8000,
});
