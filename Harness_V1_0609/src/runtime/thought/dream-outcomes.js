'use strict';

const { EventEmitter } = require('events');
const debug = require('../../utils/debug-logger')('DreamOutcomes');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, roundTo, safeDateGetTime } = require('../../utils/safe-execute');

const MAX_EVALUATIONS = 2000;
const MAX_NOTE_USAGE = 500;
const MAX_OUTCOMES = 500;
const MAX_GRADER_AGENTS = 20;

/**
 * @module runtime/thought/dream-outcomes
 * @classdesc 做梦结果闭环。成功标准定义、加权评分评估、反馈闭环
 * DreamOutcomes — Dreaming的Outcomes闭环模块
 * 为任务/会话定义成功标准、评估结果、反馈闭环至DreamEngine和SkillImprovementLoop，
 * 并追踪DreamEngine笔记的实际使用效果。
 * @extends EventEmitter
 * @emits DreamOutcomes#outcome-defined
 * @emits DreamOutcomes#outcome-evaluated
 * @emits DreamOutcomes#outcome-achieved
 * @emits DreamOutcomes#outcome-missed
 * @emits DreamOutcomes#note-usage-recorded
 * @emits DreamOutcomes#note-outcome-recorded
 * @emits DreamOutcomes#synced-to-dream-engine
 * @emits DreamOutcomes#synced-to-improvement-loop
 * @emits DreamOutcomes#grader-registered
 * @emits DreamOutcomes#grader-evaluated
 */
class DreamOutcomes extends EventEmitter {
  constructor() {
    super();
    this._outcomes = new Map();
    this._evaluations = [];
    this._noteUsage = new Map();
    this._syncCounters = { toDreamEngine: 0, toImprovementLoop: 0 };
    this._dreamEngine = null;
    this._skillImprovementLoop = null;
    this._qualityScorer = null;
    this._graderAgents = new Map();
  }

  /**
   * 为任务定义成功标准
   * @param {string} taskId - 任务标识
   * @param {object} criteria - 成功标准对象
   * @param {string} criteria.description - 成功标准描述
   * @param {Array<{name: string, target: number, weight: number}>} criteria.metrics - 度量指标数组
   * @param {string} [criteria.category='task'] - 类别，可选值为'task'、'session'、'skill'
   * @returns {{taskId: string, criteria: object, category: string, definedAt: string}} 定义后的Outcome对象
   * @fires DreamOutcomes#outcome-defined
   */
  defineOutcome(taskId, criteria) {
    this.guardShutdown();
    if (!taskId || typeof taskId !== 'string') {
      debug('defineOutcome', 'invalid taskId');
      return null;
    }
    if (!criteria || typeof criteria !== 'object') {
      debug('defineOutcome', 'invalid criteria');
      return null;
    }
    const category = criteria.category === 'session' || criteria.category === 'skill'
      ? criteria.category
      : 'task';
    const entry = {
      taskId,
      criteria: {
        description: criteria.description || '',
        metrics: Array.isArray(criteria.metrics) ? criteria.metrics.map(m => ({
          name: m.name ?? '',
          target: typeof m.target === 'number' ? m.target : 0,
          weight: typeof m.weight === 'number' ? m.weight : 1,
        })) : [],
        category,
      },
      category,
      definedAt: new Date().toISOString(),
    };
    if (!this._outcomes.has(taskId) && this._outcomes.size >= MAX_OUTCOMES) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [id, e] of this._outcomes) {
        if (e.definedAt) {
          const t = safeDateGetTime(e.definedAt);
          if (Number.isFinite(t) && t < oldestTime) {
            oldestTime = t;
            oldestKey = id;
          }
        }
      }
      if (oldestKey) this._outcomes.delete(oldestKey);
    }
    this._outcomes.set(taskId, entry);
    this.emit('outcome-defined', { taskId, category });
    return entry;
  }

  /**
   * 获取任务的成功标准
   * @param {string} taskId - 任务标识
   * @returns {object|null} Outcome定义对象，不存在时返回null
   */
  getOutcome(taskId) {
    return this._outcomes.get(taskId) ?? null;
  }

  /**
   * 列出所有定义的Outcomes，可按类别过滤
   * @param {string} [category] - 类别过滤，可选值为'task'、'session'、'skill'
   * @returns {Array<object>} Outcome定义数组
   */
  listOutcomes(category) {
    const results = [];
    for (const entry of this._outcomes.values()) {
      if (category && entry.category !== category) continue;
      results.push({ ...entry, criteria: entry.criteria ? { ...entry.criteria, metrics: [...(entry.criteria.metrics ?? [])] } : entry.criteria });
    }
    return results;
  }

  /**
   * 移除Outcome定义
   * @param {string} taskId - 任务标识
   * @returns {boolean} 是否成功移除
   */
  removeOutcome(taskId) {
    this.guardShutdown();
    return this._outcomes.delete(taskId);
  }

  /**
   * 评估任务结果是否达成了Outcomes
   * @param {string} taskId - 任务标识
   * @param {object} actualResults - 实际结果对象
   * @param {Array<{name: string, actual: number}>} actualResults.metrics - 实际度量值数组
   * @param {number} [actualResults.duration] - 执行时长
   * @param {string} [actualResults.agentId] - 执行Agent标识
   * @returns {{taskId: string, achieved: boolean, score: number, details: Array, evaluatedAt: string}|null} 评估结果，无Outcome定义时返回null
   * @fires DreamOutcomes#outcome-evaluated
   * @fires DreamOutcomes#outcome-achieved
   * @fires DreamOutcomes#outcome-missed
   */
  evaluateOutcome(taskId, actualResults) {
    this.guardShutdown();
    const outcome = this._outcomes.get(taskId);
    if (!outcome) {
      debug('evaluateOutcome', 'no outcome defined for ' + taskId);
      return null;
    }
    if (!actualResults || typeof actualResults !== 'object') {
      debug('evaluateOutcome', 'invalid actualResults');
      return null;
    }

    const actualMetrics = Array.isArray(actualResults.metrics) ? actualResults.metrics : [];
    const details = [];
    let totalWeight = 0;
    let weightedScore = 0;

    for (const metric of outcome.criteria.metrics) {
      const actual = actualMetrics.find(m => m.name === metric.name);
      const actualValue = actual && typeof actual.actual === 'number' && Number.isFinite(actual.actual) ? actual.actual : 0;
      const isMinimize = metric.direction === 'minimize';
      let achieved;
      let ratio;
      if (Number.isFinite(metric.target) && metric.target !== 0) {
        achieved = isMinimize ? actualValue <= metric.target : actualValue >= metric.target;
        ratio = isMinimize
          ? (actualValue !== 0 ? Math.min(metric.target / actualValue, 1) : 1)
          : Math.min(actualValue / metric.target, 1);
      } else {
        achieved = actualValue === 0;
        ratio = achieved ? 1 : 0;
      }
      details.push({
        name: metric.name,
        target: metric.target,
        actual: actualValue,
        achieved,
        weight: metric.weight,
      });
      totalWeight += metric.weight;
      weightedScore += ratio * metric.weight;
    }

    const score = totalWeight > 0 ? roundTo(weightedScore / totalWeight, 4) : 0;
    const achieved = score >= 0.8;

    const evaluation = {
      taskId,
      achieved,
      score,
      details,
      evaluatedAt: new Date().toISOString(),
    };

    this._evaluations.push(evaluation);
    if (this._evaluations.length > MAX_EVALUATIONS) {
      this._evaluations.shift();
    }

    this.emit('outcome-evaluated', evaluation);
    if (achieved) {
      this.emit('outcome-achieved', evaluation);
    } else {
      this.emit('outcome-missed', evaluation);
    }

    return evaluation;
  }

  /**
   * 获取评估结果
   * @param {string} taskId - 任务标识
   * @returns {object|null} 最近的评估结果，不存在时返回null
   */
  getEvaluation(taskId) {
    for (let i = this._evaluations.length - 1; i >= 0; i--) {
      if (this._evaluations[i].taskId === taskId) {
        return this._evaluations[i];
      }
    }
    return null;
  }

  /**
   * 获取最近评估
   * @param {number} [limit=10] - 返回数量上限
   * @returns {Array<object>} 最近的评估结果数组，按评估时间降序
   */
  getRecentEvaluations(limit) {
    const n = typeof limit === 'number' && limit > 0 ? limit : 10;
    return this._evaluations.slice(-n).reverse();
  }

  /**
   * 挂载DreamEngine实例
   * @param {object} dreamEngine - DreamEngine实例，需提供startDreaming方法
   * @returns {void}
   */
  attachDreamEngine(dreamEngine) {
    this.guardShutdown();
    this._dreamEngine = dreamEngine ?? null;
  }

  /**
   * 挂载SkillImprovementLoop实例
   * @param {object} loop - SkillImprovementLoop实例，需提供recordLearning方法
   * @returns {void}
   */
  attachSkillImprovementLoop(loop) {
    this.guardShutdown();
    this._skillImprovementLoop = loop ?? null;
  }

  /**
   * 挂载QualityScorer实例
   * @param {object} scorer - QualityScorer实例
   * @returns {void}
   */
  attachQualityScorer(scorer) {
    this.guardShutdown();
    this._qualityScorer = scorer ?? null;
  }

  /**
   * 注册独立Grader代理。Grader代理是独立于执行代理的评估实体，
   * 用于对任务结果进行独立、客观的评估，避免执行者自我评估的偏差。
   * 融合自 "AI Agent Dreaming" 的 Outcomes 核心概念：用 grader 代理独立评估。
   * @param {string} graderId - Grader代理标识
   * @param {object} graderConfig - Grader配置
   * @param {Function} graderConfig.evaluate - 评估函数，签名：(taskId, actualResults, criteria) => {score, details, reasoning}
   * @param {string[]} [graderConfig.specialties=[]] - Grader专业领域标签
   * @param {number} [graderConfig.weight=1.0] - Grader在多Grader共识评估中的权重
   * @returns {boolean} 是否注册成功
   * @fires DreamOutcomes#grader-registered
   */
  registerGraderAgent(graderId, graderConfig) {
    this.guardShutdown();
    if (!graderId || typeof graderId !== 'string') return false;
    if (!graderConfig || typeof graderConfig.evaluate !== 'function') return false;
    if (this._graderAgents.size >= MAX_GRADER_AGENTS && !this._graderAgents.has(graderId)) {
      const oldestKey = this._graderAgents.keys().next().value;
      this._graderAgents.delete(oldestKey);
    }
    this._graderAgents.set(graderId, {
      id: graderId,
      evaluate: graderConfig.evaluate,
      specialties: Array.isArray(graderConfig.specialties) ? graderConfig.specialties : [],
      weight: typeof graderConfig.weight === 'number' && graderConfig.weight > 0 ? graderConfig.weight : 1.0,
      evaluations: 0,
      registeredAt: new Date().toISOString(),
    });
    this.emit('grader-registered', { graderId, specialties: graderConfig.specialties ?? [] });
    return true;
  }

  /**
   * 注销Grader代理
   * @param {string} graderId - Grader代理标识
   * @returns {boolean} 是否注销成功
   */
  unregisterGraderAgent(graderId) {
    this.guardShutdown();
    return this._graderAgents.delete(graderId);
  }

  /**
   * 使用独立Grader代理评估任务结果。支持单Grader和多Grader共识评估。
   * 多Grader时采用加权平均计算最终评分，并检测评估分歧。
   * @param {string} taskId - 任务标识
   * @param {object} actualResults - 实际结果对象
   * @param {object} [options={}] - 评估选项
   * @param {string} [options.graderId] - 指定使用的Grader ID，不指定时使用所有已注册Grader
   * @param {boolean} [options.consensus=false] - 是否要求多Grader共识（所有Grader评分差异<0.2）
   * @returns {Promise<{taskId: string, graderScores: Array, consensusScore: number, consensusReached: boolean, divergence: number, evaluatedAt: string}|null>} Grader评估结果
   * @fires DreamOutcomes#grader-evaluated
   */
  async evaluateWithGrader(taskId, actualResults, options) {
    this.guardShutdown();
    const opts = Object.assign({ consensus: false }, options);
    const outcome = this._outcomes.get(taskId);
    if (!outcome) {
      debug('evaluateWithGrader', 'no outcome defined for ' + taskId);
      return null;
    }
    if (this._graderAgents.size === 0) {
      debug('evaluateWithGrader', 'no grader agents registered');
      return null;
    }

    const graders = opts.graderId
      ? [[opts.graderId, this._graderAgents.get(opts.graderId)]].filter(function(g) { return g[1]; })
      : Array.from(this._graderAgents.entries());

    if (graders.length === 0) {
      debug('evaluateWithGrader', 'no matching grader agents');
      return null;
    }

    const graderScores = [];
    for (const [graderId, grader] of graders) {
      try {
        const result = await grader.evaluate(taskId, actualResults, outcome.criteria);
        if (result && typeof result.score === 'number' && Number.isFinite(result.score)) {
          graderScores.push({
            graderId,
            score: Math.min(Math.max(result.score, 0), 1),
            details: result.details ?? [],
            reasoning: result.reasoning || '',
            weight: grader.weight,
          });
          grader.evaluations++;
        }
      } catch (_err) {
        debug('evaluateWithGrader', 'grader ' + graderId + ' failed: ' + (_err && _err.message ? _err.message : String(_err)));
        graderScores.push({
          graderId,
          score: 0,
          details: [],
          reasoning: 'Grader evaluation failed: ' + (_err && _err.message ? _err.message : String(_err)),
          weight: grader.weight,
          failed: true,
        });
      }
    }

    const totalWeight = graderScores.reduce(function(sum, g) { return sum + g.weight; }, 0);
    const consensusScore = totalWeight > 0
      ? roundTo(graderScores.reduce(function(sum, g) { return sum + g.score * g.weight; }, 0) / totalWeight, 4)
      : 0;

    const scores = graderScores.map(function(g) { return g.score; });
    const maxScore = Math.max.apply(null, scores);
    const minScore = Math.min.apply(null, scores);
    const divergence = roundTo(maxScore - minScore, 4);
    const consensusReached = !opts.consensus || divergence < 0.2;

    const result = {
      taskId,
      graderScores,
      consensusScore,
      consensusReached,
      divergence,
      evaluatedAt: new Date().toISOString(),
    };

    this.emit('grader-evaluated', result);
    return result;
  }

  /**
   * 获取已注册的Grader代理列表
   * @returns {Array<{id: string, specialties: string[], weight: number, evaluations: number}>} Grader代理信息数组
   */
  listGraderAgents() {
    const results = [];
    for (const [id, g] of this._graderAgents) {
      results.push({ id: id, specialties: g.specialties, weight: g.weight, evaluations: g.evaluations });
    }
    return results;
  }

  /**
   * 将评估结果同步到DreamEngine，成功/失败模式作为新输入
   * @returns {{ synced: number, errors: number }} 同步结果
   * @fires DreamOutcomes#synced-to-dream-engine
   */
  async syncToDreamEngine() {
    this.guardShutdown();
    if (!this._dreamEngine || typeof this._dreamEngine.startDreaming !== 'function') {
      debug('syncToDreamEngine', 'no dream engine attached');
      return { synced: 0, errors: 0 };
    }

    const sessions = [];
    for (const evaluation of this._evaluations) {
      const outcome = this._outcomes.get(evaluation.taskId);
      sessions.push({
        sessionId: evaluation.taskId,
        errors: evaluation.achieved ? [] : [{ message: 'Outcome missed: score=' + evaluation.score }],
        lessonsLearned: evaluation.achieved
          ? [{ content: 'Outcome achieved: score=' + evaluation.score, strategy: outcome ? outcome.criteria.description : '' }]
          : [],
        keyDecisions: evaluation.details.map(d => ({
          content: d.name + ': target=' + d.target + ' actual=' + d.actual,
        })),
      });
    }

    let synced = 0;
    let errors = 0;

    if (sessions.length > 0) {
      try {
        const result = await this._dreamEngine.startDreaming(sessions);
        if (result) synced++;
        else errors++;
      } catch (_err) {
        debug('DreamOutcomes', 'syncToDreamEngine:dreamFailed', _err && _err.message ? _err.message : String(_err));
        errors++;
      }
    }

    this._syncCounters.toDreamEngine++;
    this.emit('synced-to-dream-engine', { synced, errors, evaluationsCount: sessions.length });
    return { synced, errors };
  }

  /**
   * 将评估结果同步到技能改进飞轮，作为learning记录
   * @returns {{ synced: number, errors: number }} 同步结果
   * @fires DreamOutcomes#synced-to-improvement-loop
   */
  syncToSkillImprovementLoop() {
    this.guardShutdown();
    if (!this._skillImprovementLoop || typeof this._skillImprovementLoop.recordLearning !== 'function') {
      debug('syncToSkillImprovementLoop', 'no skill improvement loop attached');
      return { synced: 0, errors: 0 };
    }

    let synced = 0;
    let errors = 0;

    for (const evaluation of this._evaluations) {
      const outcome = this._outcomes.get(evaluation.taskId);
      const category = outcome ? outcome.category : 'task';
      const entry = {
        skillId: evaluation.taskId,
        agentId: '',
        whatWorked: evaluation.achieved
          ? evaluation.details.filter(d => d.achieved).map(d => d.name + ' met target ' + d.target)
          : [],
        whatFailed: !evaluation.achieved
          ? evaluation.details.filter(d => !d.achieved).map(d => d.name + ' missed target ' + d.target + ' (actual: ' + d.actual + ')')
          : [],
        category,
        score: evaluation.score,
      };

      const result = safeExecute(
        () => this._skillImprovementLoop.recordLearning(entry),
        'DreamOutcomes',
        'syncToSkillImprovementLoop',
        null,
      );

      if (result && !result.error) {
        synced++;
      } else {
        errors++;
      }
    }

    this._syncCounters.toImprovementLoop++;
    this.emit('synced-to-improvement-loop', { synced, errors, evaluationsCount: this._evaluations.length });
    return { synced, errors };
  }

  /**
   * 记录笔记被使用
   * @param {string} noteId - 笔记标识
   * @param {string} [context] - 使用上下文描述
   * @returns {void}
   * @fires DreamOutcomes#note-usage-recorded
   */
  recordNoteUsage(noteId, context) {
    this.guardShutdown();
    if (!noteId || typeof noteId !== 'string') return;

    const entry = this._ensureNoteUsageEntry(noteId);
    entry.uses++;
    entry.lastUsedAt = new Date().toISOString();
    this.emit('note-usage-recorded', { noteId, context: context ?? '', uses: entry.uses });
  }

  /**
   * 记录笔记使用后的效果
   * @param {string} noteId - 笔记标识
   * @param {boolean} effective - 是否有效
   * @returns {void}
   * @fires DreamOutcomes#note-outcome-recorded
   */
  recordNoteOutcome(noteId, effective) {
    this.guardShutdown();
    if (!noteId || typeof noteId !== 'string') return;

    const entry = this._ensureNoteUsageEntry(noteId);
    if (effective) {
      entry.effective++;
    } else {
      entry.ineffective++;
    }
    this.emit('note-outcome-recorded', { noteId, effective });
  }

  /**
   * 获取笔记效果统计
   * @param {string} noteId - 笔记标识
   * @returns {{uses: number, effective: number, ineffective: number, effectivenessRate: number, lastUsedAt: string}|null} 效果统计，不存在时返回null
   */
  getNoteEffectiveness(noteId) {
    const entry = this._noteUsage.get(noteId);
    if (!entry) return null;
    const total = entry.effective + entry.ineffective;
    return {
      uses: entry.uses,
      effective: entry.effective,
      ineffective: entry.ineffective,
      effectivenessRate: total > 0 ? roundTo(entry.effective / total, 4) : 0,
      lastUsedAt: entry.lastUsedAt,
    };
  }

  /**
   * 获取低效果笔记列表，用于清理
   * @param {number} [threshold=0.3] - 效果率阈值，低于此值的笔记将被返回
   * @returns {Array<{noteId: string, effectivenessRate: number, uses: number}>} 低效果笔记数组
   */
  getLowEffectivenessNotes(threshold) {
    const t = typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : 0.3;
    const results = [];
    for (const [noteId, entry] of this._noteUsage) {
      const total = entry.effective + entry.ineffective;
      if (total === 0) continue;
      const rate = entry.effective / total;
      if (rate < t) {
        results.push({
          noteId,
          effectivenessRate: roundTo(rate, 4),
          uses: entry.uses,
        });
      }
    }
    results.sort((a, b) => a.effectivenessRate - b.effectivenessRate);
    return results;
  }

  /**
   * 获取统计信息
   * @returns {{outcomesDefined: number, evaluationsTotal: number, evaluationsAchieved: number, achievementRate: number, noteEffectivenessTracked: number, syncedToDreamEngine: number, syncedToImprovementLoop: number}} 统计对象
   */
  getStats() {
    const evaluationsTotal = this._evaluations.length;
    let evaluationsAchieved = 0;
    for (const e of this._evaluations) {
      if (e.achieved) evaluationsAchieved++;
    }
    let totalGraderEvaluations = 0;
    for (const g of this._graderAgents.values()) {
      totalGraderEvaluations += g.evaluations;
    }
    return {
      outcomesDefined: this._outcomes.size,
      evaluationsTotal,
      evaluationsAchieved,
      achievementRate: evaluationsTotal > 0 ? roundTo(evaluationsAchieved / evaluationsTotal, 4) : 0,
      noteEffectivenessTracked: this._noteUsage.size,
      syncedToDreamEngine: this._syncCounters.toDreamEngine,
      syncedToImprovementLoop: this._syncCounters.toImprovementLoop,
      gradersRegistered: this._graderAgents.size,
      totalGraderEvaluations,
    };
  }

  /**
   * 检查实例是否健康（未关闭）
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown;
  }

  /**
   * 检查实例是否还有容量（评估总数未达上限）
   * @returns {boolean} 是否有容量
   */
  hasCapacity() {
    return this._evaluations.length < 10000;
  }

  _ensureNoteUsageEntry(noteId) {
    let entry = this._noteUsage.get(noteId);
    if (!entry) {
      if (this._noteUsage.size >= MAX_NOTE_USAGE) {
        const oldest = this._findOldestNoteUsage();
        if (oldest) this._noteUsage.delete(oldest);
      }
      entry = { uses: 0, effective: 0, ineffective: 0, lastUsedAt: '' };
      this._noteUsage.set(noteId, entry);
    }
    return entry;
  }

  _findOldestNoteUsage() {
    let oldest = null;
    let oldestTime = Infinity;
    for (const [noteId, entry] of this._noteUsage) {
      const t = safeDateGetTime(entry.lastUsedAt);
      if (Number.isFinite(t) && t < oldestTime) {
        oldestTime = t;
        oldest = noteId;
      }
    }
    return oldest;
  }

  _onShutdown() {
    this._outcomes.clear();
    this._evaluations = [];
    this._noteUsage.clear();
    this._graderAgents.clear();
    this._dreamEngine = null;
    this._skillImprovementLoop = null;
    this._qualityScorer = null;
    this.removeAllListeners();
  }
}

DreamOutcomes.MAX_EVALUATIONS = MAX_EVALUATIONS;
DreamOutcomes.MAX_NOTE_USAGE = MAX_NOTE_USAGE;
DreamOutcomes.MAX_OUTCOMES = MAX_OUTCOMES;

module.exports = withShutdown(DreamOutcomes);
