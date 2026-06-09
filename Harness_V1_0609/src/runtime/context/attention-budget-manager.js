'use strict';

const { mergeConfig, validateConfigSchema } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

const SIGNAL_LEVELS = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  NOISE: 'noise',
};

const SIGNAL_WEIGHTS = {
  [SIGNAL_LEVELS.CRITICAL]: 1.0,
  [SIGNAL_LEVELS.HIGH]: 0.8,
  [SIGNAL_LEVELS.MEDIUM]: 0.5,
  [SIGNAL_LEVELS.LOW]: 0.2,
  [SIGNAL_LEVELS.NOISE]: 0.05,
};

const DEFAULT_OPTIONS = {
  maxBudgetTokens: 80000,
  criticalReserveRatio: 0.2,
  highReserveRatio: 0.3,
  mediumReserveRatio: 0.3,
  lowReserveRatio: 0.15,
  noiseReserveRatio: 0.05,
  maxHistorySize: 1000,
  evictionStrategy: 'signal-weighted',
};

const OPTIONS_SCHEMA = {
  maxBudgetTokens: { type: 'number', min: 1 },
  criticalReserveRatio: { type: 'number', min: 0, max: 1 },
  highReserveRatio: { type: 'number', min: 0, max: 1 },
  mediumReserveRatio: { type: 'number', min: 0, max: 1 },
  lowReserveRatio: { type: 'number', min: 0, max: 1 },
  noiseReserveRatio: { type: 'number', min: 0, max: 1 },
  maxHistorySize: { type: 'number', min: 1, max: 10000 },
  evictionStrategy: { type: 'string', enum: ['signal-weighted', 'fifo', 'lru'] },
};

/**
 * @module runtime/context/attention-budget-manager
 * @classdesc 注意力预算管理器
 */
class AttentionBudgetManager {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    const validation = validateConfigSchema(this._options, OPTIONS_SCHEMA, 'AttentionBudgetManager');
    this._options = validation.config;
    this._entries = new BoundedMap(500);
    this._history = new BoundedArray(this._options.maxHistorySize);
    this._stats = {
      totalOptimizations: 0,
      totalTokensOptimized: 0,
      totalSignalPreserved: 0,
      evictions: { critical: 0, high: 0, medium: 0, low: 0, noise: 0 },
    };
  }

  /**
   * 计算条目的信号分数，综合评估时效性、相关性、重要性和效用性
   * @param {Object} entry - 上下文条目对象
   * @param {Object} [taskContext] - 当前任务上下文，用于计算相关性分数
   * @returns {number} 信号分数，范围 [0, 1]
   */
  computeSignalScore(entry, taskContext) {
    this.guardShutdown();
    if (!entry) return 0;
    let score = 0;
    const recency = this._computeRecencyScore(entry);
    score += recency * 0.2;
    const relevance = this._computeRelevanceScore(entry, taskContext);
    score += relevance * 0.4;
    const importance = this._computeImportanceScore(entry);
    score += importance * 0.3;
    const utility = this._computeUtilityScore(entry);
    score += utility * 0.1;
    return Math.min(1, Math.max(0, score));
  }

  /**
   * 根据信号分数将条目划分为信号等级
   * @param {number} signalScore - 信号分数，范围 [0, 1]
   * @returns {string} 信号等级（'critical'|'high'|'medium'|'low'|'noise'）
   */
  classifySignalLevel(signalScore) {
    this.guardShutdown();
    if (signalScore >= 0.85) return SIGNAL_LEVELS.CRITICAL;
    if (signalScore >= 0.65) return SIGNAL_LEVELS.HIGH;
    if (signalScore >= 0.4) return SIGNAL_LEVELS.MEDIUM;
    if (signalScore >= 0.2) return SIGNAL_LEVELS.LOW;
    return SIGNAL_LEVELS.NOISE;
  }

  /**
   * 注册上下文条目，自动计算其信号分数和信号等级
   * @param {string} entryId - 条目唯一标识
   * @param {Object} entry - 条目内容对象
   * @param {number} [tokenCount] - 条目的Token数量，未提供时自动估算
   * @param {Object} [taskContext] - 当前任务上下文，用于信号分数计算
   * @returns {{signalScore: number, signalLevel: string}} 信号分数和信号等级
   */
  registerEntry(entryId, entry, tokenCount, taskContext) {
    this.guardShutdown();
    const signalScore = this.computeSignalScore(entry, taskContext);
    const signalLevel = this.classifySignalLevel(signalScore);
    this._entries.set(entryId, {
      id: entryId,
      signalScore,
      signalLevel,
      tokenCount: tokenCount ?? this._estimateTokenCount(entry),
      registeredAt: Date.now(),
      accessCount: 1,
    });
    return { signalScore, signalLevel };
  }

  /**
   * 优化上下文，根据注意力预算和信号等级选择保留或驱逐条目
   * @param {Object} [taskContext] - 当前任务上下文，用于重新计算信号分数
   * @returns {{keep: string[], evict: string[], totalTokens: number, totalSignal: number, budgetUsed: number, signalDensity: number}} 优化结果
   */
  optimizeContext(taskContext) {
    this.guardShutdown();
    this._stats.totalOptimizations++;
    const entries = [];
    for (const [_id, entry] of this._entries) {
      const updatedScore = this.computeSignalScore(entry, taskContext);
      entry.signalScore = updatedScore;
      entry.signalLevel = this.classifySignalLevel(updatedScore);
      entries.push(entry);
    }
    const budget = this._allocateBudget();
    const result = this._selectEntries(entries, budget);
    const evicted = entries.filter(e => !result.selected.includes(e.id));
    for (const e of evicted) {
      this._stats.evictions[e.signalLevel] = (this._stats.evictions[e.signalLevel] ?? 0) + 1;
    }
    const totalTokens = result.selected.reduce((sum, id) => {
      const e = this._entries.get(id);
      return sum + (e ? e.tokenCount : 0);
    }, 0);
    const totalSignal = result.selected.reduce((sum, id) => {
      const e = this._entries.get(id);
      return sum + (e ? e.signalScore * e.tokenCount : 0);
    }, 0);
    this._stats.totalTokensOptimized += totalTokens;
    this._stats.totalSignalPreserved += totalSignal;
    this._history.push({
      selected: result.selected.length,
      evicted: evicted.length,
      totalTokens,
      totalSignal,
      timestamp: Date.now(),
    });
    return {
      keep: result.selected,
      evict: evicted.map(e => e.id),
      totalTokens,
      totalSignal,
      budgetUsed: this._options.maxBudgetTokens > 0 ? totalTokens / this._options.maxBudgetTokens : 0,
      signalDensity: totalTokens > 0 ? totalSignal / totalTokens : 0,
    };
  }

  _allocateBudget() {
    return {
      critical: Math.floor(this._options.maxBudgetTokens * this._options.criticalReserveRatio),
      high: Math.floor(this._options.maxBudgetTokens * this._options.highReserveRatio),
      medium: Math.floor(this._options.maxBudgetTokens * this._options.mediumReserveRatio),
      low: Math.floor(this._options.maxBudgetTokens * this._options.lowReserveRatio),
      noise: Math.floor(this._options.maxBudgetTokens * this._options.noiseReserveRatio),
    };
  }

  _selectEntries(entries, budget) {
    const selected = [];
    let remainingBudget = Object.values(budget).reduce((s, v) => s + v, 0);
    const byLevel = {
      [SIGNAL_LEVELS.CRITICAL]: [],
      [SIGNAL_LEVELS.HIGH]: [],
      [SIGNAL_LEVELS.MEDIUM]: [],
      [SIGNAL_LEVELS.LOW]: [],
      [SIGNAL_LEVELS.NOISE]: [],
    };
    for (const entry of entries) {
      const level = entry.signalLevel ?? SIGNAL_LEVELS.NOISE;
      if (byLevel[level]) byLevel[level].push(entry);
    }
    for (const level of [SIGNAL_LEVELS.CRITICAL, SIGNAL_LEVELS.HIGH, SIGNAL_LEVELS.MEDIUM, SIGNAL_LEVELS.LOW, SIGNAL_LEVELS.NOISE]) {
      const levelBudget = budget[level] ?? 0;
      let levelUsed = 0;
      const sorted = (byLevel[level] ?? []).sort((a, b) => b.signalScore - a.signalScore);
      for (const entry of sorted) {
        if (levelUsed + entry.tokenCount <= levelBudget && remainingBudget >= entry.tokenCount) {
          selected.push(entry.id);
          levelUsed += entry.tokenCount;
          remainingBudget -= entry.tokenCount;
        }
      }
    }
    if (remainingBudget > 0) {
      const unselected = entries.filter(e => !selected.includes(e.id));
      unselected.sort((a, b) => b.signalScore - a.signalScore);
      for (const entry of unselected) {
        if (remainingBudget >= entry.tokenCount) {
          selected.push(entry.id);
          remainingBudget -= entry.tokenCount;
        }
      }
    }
    return { selected };
  }

  _computeRecencyScore(entry) {
    const age = Date.now() - (entry.registeredAt ?? entry.timestamp ?? Date.now());
    const hours = age / (1000 * 60 * 60);
    if (hours < 1) return 1.0;
    if (hours < 6) return 0.8;
    if (hours < 24) return 0.6;
    if (hours < 72) return 0.4;
    return 0.2;
  }

  _computeRelevanceScore(entry, taskContext) {
    if (!taskContext) return 0.5;
    const entryText = this._extractText(entry).toLowerCase();
    const taskText = this._extractText(taskContext).toLowerCase();
    if (!entryText || !taskText) return 0.5;
    const taskTokens = taskText.split(/\s+/).filter(Boolean);
    if (taskTokens.length === 0) return 0.5;
    let matchCount = 0;
    for (const token of taskTokens) {
      if (entryText.includes(token)) matchCount++;
    }
    return Math.min(1, matchCount / taskTokens.length);
  }

  _computeImportanceScore(entry) {
    let score = 0.5;
    const level = entry.signalLevel;
    if (level === SIGNAL_LEVELS.CRITICAL) score = 0.9;
    else if (level === SIGNAL_LEVELS.HIGH) score = 0.7;
    else if (level === SIGNAL_LEVELS.MEDIUM) score = 0.5;
    else if (level === SIGNAL_LEVELS.LOW) score = 0.3;
    else if (level === SIGNAL_LEVELS.NOISE) score = 0.1;
    const accessCount = entry.accessCount ?? 0;
    score += Math.min(0.2, accessCount * 0.02);
    return Math.min(1, score);
  }

  _computeUtilityScore(entry) {
    const tokenCount = entry.tokenCount ?? 0;
    if (tokenCount === 0) return 0;
    const signalScore = (typeof entry.signalScore === 'number' && Number.isFinite(entry.signalScore)) ? entry.signalScore : 0;
    return signalScore / Math.sqrt(tokenCount);
  }

  _extractText(obj) {
    if (typeof obj === 'string') return obj;
    if (!obj || typeof obj !== 'object') return '';
    const parts = [];
    for (const key of ['content', 'text', 'description', 'name', 'summary', 'task', 'query']) {
      if (obj[key] != null) parts.push(String(obj[key]));
    }
    return parts.join(' ');
  }

  _estimateTokenCount(data) {
    let text;
    try { text = typeof data === 'string' ? data : JSON.stringify(data); } catch (_e) { debug('AttentionBudgetManager', 'estimateTokenCount', _e && _e.message ? _e.message : String(_e)); text = String(data); }
    return Math.ceil(text.length / 4);
  }

  /**
   * 获取注意力预算管理器的统计信息
   * @returns {{totalOptimizations: number, totalTokensOptimized: number, totalSignalPreserved: number, evictions: Object, entryCount: number}} 统计信息
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('AttentionBudgetManager', 'guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalOptimizations: 0, totalTokensOptimized: 0, totalSignalPreserved: 0, evictions: {}, entryCount: 0 }; }
    return {
      totalOptimizations: this._stats.totalOptimizations,
      totalTokensOptimized: this._stats.totalTokensOptimized,
      totalSignalPreserved: this._stats.totalSignalPreserved,
      evictions: Object.assign({}, this._stats.evictions),
      entryCount: this._entries.size,
    };
  }

  _onShutdown() {
    this._entries.shutdown();
    this._history.shutdown();
  }
}

module.exports = withShutdown(AttentionBudgetManager);
module.exports.SIGNAL_LEVELS = SIGNAL_LEVELS;
module.exports.SIGNAL_WEIGHTS = SIGNAL_WEIGHTS;
