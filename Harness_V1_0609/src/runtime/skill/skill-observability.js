'use strict';

const { EventEmitter } = require('events');
const debug = require('../../utils/debug-logger')('SkillObservability');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const { shortId } = require('../../utils/unique-id');

const MAX_ACTIVE_TRACES = 200;
const MAX_COMPLETED_TRACES = 500;
const MAX_ALERT_RULES = 100;
const VALID_MODULE_NAMES = new Set([
  'router', 'curator', 'improver', 'evolver',
  'creationEngine', 'improvementLoop', 'graph', 'canary', 'reducer',
  'devMetricsCollector',
]);

/**
 * @module runtime/skill/skill-observability
 * SkillObservability — 技能统一可观察性模块
 * 聚合SkillRouter/SkillCurator/SkillImprover等子系统的指标，提供执行追踪、
 * 健康仪表盘和告警规则引擎。支持从挂载模块收集getStats()数据，记录技能执行
 * 端到端链路，评估告警规则并发出事件通知。
 * @classdesc 技能统一可观察性。跨模块指标聚合、执行链路追踪、健康仪表盘、告警规则引擎。
 * @extends EventEmitter
 * @emits SkillObservability#metrics-collected
 * @emits SkillObservability#trace-started
 * @emits SkillObservability#trace-completed
 * @emits SkillObservability#alert-triggered
 * @emits SkillObservability#alert-cleared
 */
class SkillObservability extends EventEmitter {
  constructor() {
    super();
    this._modules = Object.create(null);
    this._traces = new Map();
    this._completedTraces = [];
    this._alertRules = new Map();
    this._activeAlerts = [];
    this._lastCollection = null;
  }

  /**
   * 挂载技能子系统模块，用于后续指标收集
   * @param {string} name - 模块名称，必须为router/curator/improver/evolver/creationEngine/improvementLoop/graph/canary之一
   * @param {Object} module - 模块实例，需提供getStats()方法
   * @returns {SkillObservability} 当前实例，支持链式调用
   */
  attachModule(name, module) {
    if (!VALID_MODULE_NAMES.has(name)) return this;
    if (!module || typeof module.getStats !== 'function') return this;
    this._modules[name] = module;
    return this;
  }

  /**
   * 从所有挂载模块收集getStats()数据
   * @returns {Object.<string, Object>} 按模块名称索引的指标快照
   */
  collectMetrics() {
    this.guardShutdown();
    const snapshot = Object.create(null);
    const names = Object.keys(this._modules);
    for (const name of names) {
      snapshot[name] = safeExecute(
        () => this._modules[name].getStats(),
        'SkillObservability',
        'collectMetrics:' + name,
        null,
      );
    }
    this._lastCollection = snapshot;
    this.emit('metrics-collected', { snapshot, moduleCount: names.length });
    return snapshot;
  }

  /**
   * 获取聚合后的指标快照（上次收集结果）
   * @returns {Object.<string, Object>|null} 聚合指标快照，未收集过时返回null
   */
  getAggregatedMetrics() {
    return this._lastCollection ? { ...this._lastCollection } : null;
  }

  /**
   * 开始追踪技能执行，返回traceId
   * @param {string} skillId - 技能ID
   * @param {Object} [context] - 执行上下文信息
   * @returns {string} 追踪ID
   */
  startTrace(skillId, context) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return '';
    if (this._traces.size >= MAX_ACTIVE_TRACES) {
      const oldestKey = this._traces.keys().next().value;
      const oldest = this._traces.get(oldestKey);
      this._traces.delete(oldestKey);
      this._pushCompleted(oldest);
    }
    const traceId = shortId('trc-', 16);
    const trace = {
      traceId,
      skillId,
      context: context ?? {},
      startTime: Date.now(),
    };
    this._traces.set(traceId, trace);
    this.emit('trace-started', { traceId, skillId });
    return traceId;
  }

  /**
   * 结束追踪，记录执行结果
   * @param {string} traceId - 追踪ID
   * @param {Object} [result] - 执行结果
   * @returns {void}
   */
  endTrace(traceId, result) {
    if (!traceId || !this._traces.has(traceId)) return;
    const trace = this._traces.get(traceId);
    trace.endTime = Date.now();
    trace.duration = typeof trace.endTime === 'number' && typeof trace.startTime === 'number' && Number.isFinite(trace.endTime) && Number.isFinite(trace.startTime) ? trace.endTime - trace.startTime : 0;
    trace.result = result ?? null;
    this._traces.delete(traceId);
    this._pushCompleted(trace);
    this.emit('trace-completed', {
      traceId: trace.traceId,
      skillId: trace.skillId,
      duration: trace.duration,
    });
  }

  /**
   * 获取单条追踪记录
   * @param {string} traceId - 追踪ID
   * @returns {Object|null} 追踪记录，不存在时返回null
   */
  getTrace(traceId) {
    if (this._traces.has(traceId)) return this._traces.get(traceId);
    for (let i = this._completedTraces.length - 1; i >= 0; i--) {
      if (this._completedTraces[i].traceId === traceId) {
        return this._completedTraces[i];
      }
    }
    return null;
  }

  /**
   * 获取所有活跃追踪
   * @returns {Object[]} 活跃追踪记录数组
   */
  getActiveTraces() {
    return Array.from(this._traces.values()).map(t => ({ ...t, context: t.context ? { ...t.context } : {} }));
  }

  /**
   * 获取最近完成的追踪
   * @param {number} [limit=50] - 返回数量上限
   * @returns {Object[]} 最近完成的追踪记录数组
   */
  getRecentTraces(limit) {
    const n = limit ?? 50;
    return this._completedTraces.slice(-n).map(t => ({ ...t, context: t.context ? { ...t.context } : {} }));
  }

  /**
   * 返回综合健康仪表盘数据
   * @returns {Object} 健康仪表盘数据，包含模块健康状态、技能统计、缓存命中率、飞轮统计、金丝雀状态和最近错误
   */
  getHealthDashboard() {
    this.guardShutdown();
    const moduleHealth = this._collectModuleHealth();
    const stats = this._collectDashboardStats();
    const recentErrors = this._collectRecentErrors();

    return {
      healthy: this.isHealthy(),
      moduleHealth,
      skills: { total: stats.skillTotal, active: stats.skillActive, stale: stats.skillStale },
      cacheHitRate: stats.cacheHitRate,
      flywheel: stats.flywheel,
      canary: stats.canary,
      recentErrors,
      activeTraces: this._traces.size,
      completedTraces: this._completedTraces.length,
      alertRules: this._alertRules.size,
      activeAlerts: this._activeAlerts.length,
    };
  }

  _collectModuleHealth() {
    const moduleHealth = Object.create(null);
    const names = Object.keys(this._modules);
    for (const name of names) {
      moduleHealth[name] = safeExecute(
        () => typeof this._modules[name].isHealthy === 'function'
          ? this._modules[name].isHealthy()
          : true,
        'SkillObservability',
        'healthCheck:' + name,
        true,
      );
    }
    return moduleHealth;
  }

  _collectDashboardStats() {
    let skillTotal = 0;
    let skillActive = 0;
    let skillStale = 0;
    let cacheHitRate = 0;
    const flywheel = Object.create(null);
    const canary = Object.create(null);

    if (this._lastCollection) {
      if (this._lastCollection.router) {
        const r = this._lastCollection.router;
        skillTotal = typeof r.skillCount === 'number' && Number.isFinite(r.skillCount) ? r.skillCount : (typeof r.totalSkills === 'number' && Number.isFinite(r.totalSkills) ? r.totalSkills : 0);
        cacheHitRate = r.l2HitRate ?? r.cacheHitRate ?? 0;
      }
      if (this._lastCollection.curator) {
        const c = this._lastCollection.curator;
        skillStale = c.staleCount ?? 0;
        skillActive = skillTotal - skillStale;
      }
      if (this._lastCollection.improvementLoop) {
        const il = this._lastCollection.improvementLoop;
        flywheel.patches = il.pendingPatches ?? 0;
        flywheel.learnings = il.totalLearnings ?? 0;
        if (il.flywheel) safeAssign(flywheel, il.flywheel);
      }
      if (this._lastCollection.canary) {
        safeAssign(canary, this._lastCollection.canary);
      }
    }

    return { skillTotal, skillActive, skillStale, cacheHitRate, flywheel, canary };
  }

  _collectRecentErrors() {
    const recentErrors = [];
    for (let i = this._completedTraces.length - 1; i >= 0 && recentErrors.length < 10; i--) {
      const t = this._completedTraces[i];
      if (t.result && t.result.error) {
        recentErrors.push({
          traceId: t.traceId,
          skillId: t.skillId,
          error: t.result.error,
          duration: t.duration,
        });
      }
    }
    return recentErrors;
  }

  /**
   * 添加告警规则
   * @param {Object} rule - 告警规则
   * @param {string} rule.name - 规则名称（唯一标识）
   * @param {Function} rule.condition - 条件函数，接收metrics参数，返回boolean
   * @param {string} rule.severity - 严重级别，'warning'或'critical'
   * @returns {void}
   */
  addAlertRule(rule) {
    if (!rule || !rule.name || typeof rule.condition !== 'function') return;
    if (rule.severity !== 'warning' && rule.severity !== 'critical') return;
    if (this._alertRules.size >= MAX_ALERT_RULES && !this._alertRules.has(rule.name)) return;
    this._alertRules.set(rule.name, {
      name: rule.name,
      condition: rule.condition,
      severity: rule.severity,
    });
  }

  /**
   * 移除告警规则
   * @param {string} name - 规则名称
   * @returns {void}
   */
  removeAlertRule(name) {
    if (!name) return;
    this._alertRules.delete(name);
    const prevLen = this._activeAlerts.length;
    this._activeAlerts = this._activeAlerts.filter(a => a.name !== name);
    if (this._activeAlerts.length < prevLen) {
      this.emit('alert-cleared', { name });
    }
  }

  /**
   * 评估所有告警规则，基于当前指标快照
   * @returns {Object[]} 当前活跃告警列表
   */
  evaluateAlerts() {
    this.guardShutdown();
    const metrics = this._lastCollection || Object.create(null);
    const newActive = [];
    const triggeredNames = new Set();

    for (const [name, rule] of this._alertRules) {
      const triggered = safeExecute(
        () => rule.condition(metrics),
        'SkillObservability',
        'evaluateAlert:' + name,
        false,
      );
      if (triggered) {
        triggeredNames.add(name);
        newActive.push({ name: rule.name, severity: rule.severity });
      }
    }

    const prevNames = new Set(this._activeAlerts.map(a => a.name));
    for (const n of triggeredNames) {
      if (!prevNames.has(n)) {
        const rule = this._alertRules.get(n);
        this.emit('alert-triggered', { name: n, severity: rule.severity });
      }
    }
    for (const n of prevNames) {
      if (!triggeredNames.has(n)) {
        this.emit('alert-cleared', { name: n });
      }
    }

    this._activeAlerts = newActive;
    return this._activeAlerts.slice();
  }

  /**
   * 获取当前活跃告警
   * @returns {Object[]} 活跃告警列表
   */
  getActiveAlerts() {
    return this._activeAlerts.slice();
  }

  /**
   * 检查实例是否健康（未关闭且活跃追踪数未超限）
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    return !this._shutDown && this._traces.size < MAX_ACTIVE_TRACES;
  }

  /**
   * 获取可观察性模块统计信息
   * @returns {{ modulesAttached: number, activeTraces: number, completedTraces: number, alertRules: number, activeAlerts: number }} 统计数据
   */
  getStats() {
    return {
      modulesAttached: Object.keys(this._modules).length,
      activeTraces: this._traces.size,
      completedTraces: this._completedTraces.length,
      alertRules: this._alertRules.size,
      activeAlerts: this._activeAlerts.length,
    };
  }

  /**
   * Assess skill scope: too broad, too narrow, or appropriate
   * @param {string} skillId - Skill identifier
   * @returns {{assessment: string, score: number, details: object}}
   */
  assessSkillScope(skillId) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return { assessment: 'unknown', score: 0, details: { reason: 'Invalid skillId' } };
    const skill = this._modules.router?.getSkill(skillId);
    if (!skill) return { assessment: 'unknown', score: 0, details: { reason: 'Skill not found' } };

    // Scope indicators from skill metadata
    const stepCount = skill.steps ? skill.steps.length : 0;
    const phaseCount = skill.phases ? skill.phases.length : 0;
    const depCount = skill.dependencies ? skill.dependencies.length : 0;
    const tags = skill.tags || [skillId];
    const contextTokens = this._modules.router?.getContextEstimate(tags);

    // Scoring: 0-10, 5 = ideal scope
    let score = 5;
    const details = {};

    // Too broad: many steps, many phases, many dependencies, high context
    if (stepCount > 15) { score -= 2; details.tooManySteps = stepCount; }
    if (phaseCount > 4) { score -= 1; details.tooManyPhases = phaseCount; }
    if (depCount > 5) { score -= 1; details.tooManyDependencies = depCount; }
    if (contextTokens && contextTokens.l3Tokens > 8000) { score -= 1; details.highContextL3 = contextTokens.l3Tokens; }

    // Too narrow: single step, single phase, no dependencies
    if (stepCount <= 1 && phaseCount <= 1) { score -= 2; details.tooNarrow = true; }

    score = Math.max(0, Math.min(10, score));
    let assessment;
    if (score >= 7) assessment = 'appropriate';
    else if (score >= 4) assessment = 'needs-review';
    else assessment = 'mis-scoped';

    return { assessment, score, details };
  }

  /**
   * Assess skill portability: can it be extracted and reused in another project?
   * @param {string} skillId - Skill identifier
   * @returns {{portability: string, score: number, details: object}}
   */
  assessSkillPortability(skillId) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return { portability: 'unknown', score: 0, details: { reason: 'Invalid skillId' } };
    const skill = this._modules.router?.getSkill(skillId);
    if (!skill) return { portability: 'unknown', score: 0, details: { reason: 'Skill not found' } };

    let score = 10; // Start fully portable, deduct for project-specific ties
    const details = {};

    // Check for project-specific references in skill content
    let content;
    try { content = JSON.stringify(skill); } catch (_e) { content = String(skill); }
    const projectSpecificPatterns = [
      { pattern: /harness/gi, deduct: 1, name: 'harness-reference' },
      { pattern: /\.harness\//g, deduct: 2, name: 'harness-path' },
      { pattern: /localhost:\d+/g, deduct: 1, name: 'localhost-reference' },
      { pattern: /process\.env\./g, deduct: 1, name: 'env-dependency' },
      { pattern: /require\(['"]\.+/g, deduct: 1, name: 'local-require' },
    ];

    for (const { pattern, deduct, name } of projectSpecificPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        score -= deduct * Math.min(matches.length, 3); // Cap deduction
        details[name] = matches.length;
      }
    }

    // Check for project-agnostic indicators
    if (skill.portable === true) score += 2;
    if (skill.dependencies && skill.dependencies.length === 0) score += 1;

    score = Math.max(0, Math.min(10, score));
    let portability;
    if (score >= 7) portability = 'high';
    else if (score >= 4) portability = 'medium';
    else portability = 'low';

    return { portability, score, details };
  }

  /**
   * Find overlapping skills and suggest consolidation
   * @returns {Array<{group: string[], overlapScore: number, suggestedName: string, reason: string}>}
   */
  findConsolidationCandidates() {
    this.guardShutdown();
    const dedupReport = this._modules.router?.getDeduplicationReport();
    if (!dedupReport || !dedupReport.details) return [];

    const candidates = [];
    for (const detail of dedupReport.details) {
      if (detail.sharedBy && detail.sharedBy.length >= 2) {
        candidates.push({
          group: detail.sharedBy,
          overlapScore: detail.sharedBy.length / 10,
          suggestedName: this._suggestConsolidatedName(detail.sharedBy[0], detail.sharedBy[1]),
          reason: `Skills share common content: "${(detail.contentPreview || '').substring(0, 80)}"`,
        });
      }
    }

    return candidates.sort((a, b) => b.overlapScore - a.overlapScore);
  }

  /**
   * Suggest a name for a consolidated skill
   * @private
   */
  _suggestConsolidatedName(skillA, skillB) {
    // Use the shorter name as base, or combine key concepts
    const a = skillA.replace(/^(skill-|harness-)/, '') || skillA;
    const b = skillB.replace(/^(skill-|harness-)/, '') || skillB;
    if (a.length <= b.length) return `consolidated-${a}`;
    return `consolidated-${b}`;
  }

  /**
   * Generate a teaching-level explanation of a skill
   * @param {string} skillId - Skill identifier
   * @returns {{explanation: string, keyConcepts: string[], usagePattern: string, commonPitfalls: string[]}}
   */
  appreciateSkill(skillId) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return { explanation: 'Invalid skillId', keyConcepts: [], usagePattern: '', commonPitfalls: [] };
    const skill = this._modules.router?.getSkill(skillId);
    if (!skill) return { explanation: 'Skill not found', keyConcepts: [], usagePattern: '', commonPitfalls: [] };

    const _sanitize = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Build teaching explanation from skill metadata
    const keyConcepts = [];
    const commonPitfalls = [];

    // Extract key concepts from phases
    if (skill.phases) {
      for (const phase of skill.phases) {
        if (phase.name) keyConcepts.push(phase.name);
      }
    }

    // Extract pitfalls from enforcement levels
    if (skill.enforcement === 'strict') {
      commonPitfalls.push('This skill has strict enforcement - deviations will cause errors');
    }

    // Build usage pattern
    const usagePattern = skill.steps
      ? skill.steps.slice(0, 5).map((s, i) => `${i + 1}. ${_sanitize(s.description || s)}`).join('\n')
      : 'No steps defined';

    // Generate natural explanation
    const purpose = _sanitize(skill.description || skill.summary || 'No description available');
    const phaseInfo = skill.phases ? ` during the ${_sanitize(skill.phases[0]?.name || 'execution')} phase` : '';
    const explanation = `${_sanitize(skill.name || skillId)} is designed to ${purpose}${phaseInfo}. ` +
      `It operates at ${_sanitize(String(skill.priority ?? 'default'))} priority and uses ${_sanitize(skill.enforcement || 'recommended')} enforcement. ` +
      `The skill involves ${keyConcepts.length} key concept${keyConcepts.length !== 1 ? 's' : ''}: ${keyConcepts.map(_sanitize).join(', ') || 'general execution'}.`;

    return { explanation, keyConcepts, usagePattern, commonPitfalls };
  }

  _pushCompleted(trace) {
    this._completedTraces.push(trace);
    while (this._completedTraces.length > MAX_COMPLETED_TRACES) {
      this._completedTraces.shift();
    }
  }

  _onShutdown() {
    for (const [_traceId, trace] of this._traces) {
      trace.endTime = Date.now();
      trace.duration = trace.endTime - trace.startTime;
      this._pushCompleted(trace);
    }
    this._traces.clear();
    this._modules = Object.create(null);
    this._alertRules.clear();
    this._activeAlerts = [];
    this._lastCollection = null;
    debug('shutdown', 'traces flushed');
    this.removeAllListeners();
  }
}

module.exports = withShutdown(SkillObservability);
