'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../utils/debug-logger');
const { withShutdown } = require('../utils/shutdown-mixin');

/** @constant {number} DEFAULT_MIN_CONFIDENCE - 默认最低置信度阈值 */
const DEFAULT_MIN_CONFIDENCE = 0.5;
/** @constant {number} DEFAULT_MAX_HISTORY - 默认最大警告历史记录数 */
const DEFAULT_MAX_HISTORY = 100;
/** @constant {number} MAX_PATTERNS - 最大错误模式注册数 */
const MAX_PATTERNS = 500;
/** @constant {number} MAX_REFLECTION_ENTRIES - 最大反思记录数 */
const MAX_REFLECTION_ENTRIES = 200;
/** @constant {string[]} REFLECTION_CATEGORIES - 反思分类列表 */
const REFLECTION_CATEGORIES = ['bugfix', 'codegen', 'refactor', 'test', 'deploy', 'config', 'general'];
const { timestampId } = require('../utils/unique-id');

/**
 * @module gate/error-prevention-guard
 * 错误预防守卫。维护历史错误模式注册表，在任务执行前注入警告，
 * 支持模糊模式匹配、DreamEngine集成和Reflexion式持久化失败模式记录。
 */

/**
 * @classdesc 错误预防守卫。全局错误模式注册表、执行前自动检查
 * 错误预防守卫。主动预防重复错误，维护历史错误模式注册表并在任务执行前注入警告。
 * 支持模糊模式匹配、DreamEngine集成加载错误规避笔记、Reflexion式持久化失败模式记录与上下文注入。
 * @extends EventEmitter
 * @emits warnings-injected | reflection-recorded
 */
class ErrorPreventionGuard extends EventEmitter {
  /**
   * 创建ErrorPreventionGuard实例。
   * @param {object} [options] - 配置选项
   * @param {object} [options.dreamEngine] - DreamEngine实例，用于加载错误规避笔记
   * @param {number} [options.minConfidence=0.5] - 最低置信度阈值
   * @param {number} [options.maxHistory=100] - 最大警告历史记录数
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._dreamEngine = opts.dreamEngine ?? null;
    this._minConfidence = typeof opts.minConfidence === 'number' && Number.isFinite(opts.minConfidence) ? opts.minConfidence : DEFAULT_MIN_CONFIDENCE;
    this._maxHistory = Math.max(1, opts.maxHistory ?? DEFAULT_MAX_HISTORY);
    this._patterns = new Map();
    this._warningHistory = [];
    this._reflections = [];
    this._stats = { checksPerformed: 0, warningsInjected: 0, patternsRegistered: 0, errors: 0, reflectionsRecorded: 0 };
  }

  /**
   * 注册错误模式到模式注册表。
   * @param {object} patternData - 错误模式数据
   * @param {string} patternData.pattern - 模式文本
   * @param {string} [patternData.description] - 模式描述
   * @param {string} [patternData.solution] - 解决方案
   * @param {number} [patternData.confidence=1.0] - 置信度（0-1），应为有限数值
   * @returns {{id: string|null}} 注册结果，包含模式ID
   */
  registerErrorPattern(patternData) {
    this.guardShutdown();
    if (!patternData || !patternData.pattern) return { id: null };
    if (this._patterns.size >= MAX_PATTERNS) {
      const oldestKey = this._patterns.keys().next().value;
      if (oldestKey) this._patterns.delete(oldestKey);
    }
    const id = timestampId('epg-');
    const entry = {
      id: id,
      pattern: patternData.pattern,
      description: patternData.description || '',
      solution: patternData.solution || '',
      confidence: Number.isFinite(patternData.confidence) ? patternData.confidence : 1.0,
      registeredAt: Date.now(),
    };
    this._patterns.set(id, entry);
    this._stats.patternsRegistered++;
    return entry;
  }

  /**
   * 获取已注册的错误模式数量。
   * @returns {number} 模式数量
   */
  getPatternCount() {
    return this._patterns.size;
  }

  /**
   * 检查任务上下文是否存在匹配的历史错误模式，并注入警告。
   * @param {object} [context] - 任务上下文
   * @param {string} [context.task] - 任务描述文本
   * @returns {{safe: boolean, warnings: Array<object>}} 检查结果，safe为true表示无警告
   * @emits ErrorPreventionGuard#warnings-injected
   */
  check(context) {
    this.guardShutdown();
    this._stats.checksPerformed++;
    const ctx = context ?? {};
    const taskText = (ctx.task || '').toLowerCase();
    const warnings = [];

    for (const [, pattern] of this._patterns) {
      if (pattern.confidence < this._minConfidence) continue;
      const patternText = pattern.pattern.toLowerCase();
      if (taskText.includes(patternText) || this._fuzzyMatch(patternText, taskText)) {
        warnings.push({
          patternId: pattern.id,
          pattern: pattern.pattern,
          description: pattern.description,
          solution: pattern.solution,
          confidence: pattern.confidence,
        });
      }
    }

    if (warnings.length > 0) {
      this._stats.warningsInjected += warnings.length;
      this._warningHistory.push({ timestamp: Date.now(), warnings: warnings.slice() });
      if (this._warningHistory.length > this._maxHistory) {
        this._warningHistory.shift();
      }
      this.emit('warnings-injected', { warnings, context: ctx });
    }

    return { safe: warnings.length === 0, warnings };
  }

  _fuzzyMatch(pattern, text) {
    if (typeof pattern !== 'string') return false;
    const words = pattern.split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) return false;
    let matchCount = 0;
    for (const word of words) {
      if (text.includes(word)) matchCount++;
    }
    return matchCount / words.length >= 0.5;
  }

  /**
   * 从DreamEngine加载错误规避笔记到模式注册表。
   * @returns {number} 成功加载的模式数量
   */
  loadFromDreamEngine() {
    this.guardShutdown();
    if (!this._dreamEngine || typeof this._dreamEngine.getNotesByCategory !== 'function') return 0;
    try {
      const notes = this._dreamEngine.getNotesByCategory('error-avoidance');
      if (!Array.isArray(notes)) return 0;
      let loaded = 0;
      const seenPatterns = new Set();
      for (const note of notes) {
        const patternText = (note.content || note.title || '').toLowerCase();
        if (seenPatterns.has(patternText)) continue;
        seenPatterns.add(patternText);
        const entry = this.registerErrorPattern({
          pattern: note.content || note.title || '',
          description: note.title || '',
          solution: note.solution || '',
          confidence: Number.isFinite(note.confidence) ? note.confidence : 0.5,
        });
        if (entry.id) loaded++;
      }
      return loaded;
    } catch (err) {
      debug('ErrorPreventionGuard', 'loadFromDreamEngine', err && err.message ? err.message : String(err));
      this._stats.errors++;
      return 0;
    }
  }

  /**
   * 移除指定ID的错误模式。
   * @param {string} id - 模式ID
   * @returns {boolean} 是否成功移除
   */
  removePattern(id) {
    return this._patterns.delete(id);
  }

  /**
   * 获取警告历史的副本。
   * @returns {Array<object>} 警告历史列表
   */
  getWarningHistory() {
    return this._warningHistory.slice();
  }

  /**
   * 获取统计信息。
   * @returns {{checksPerformed: number, warningsInjected: number, patternsRegistered: number, errors: number, reflectionsRecorded: number, totalPatterns: number, totalReflections: number}} 统计信息
   */
  getStats() {
    return { ...this._stats, totalPatterns: this._patterns.size, totalReflections: this._reflections.length };
  }

  /**
   * 记录反思条目，同时自动注册为错误模式。
   * @param {object} entry - 反思条目
   * @param {string} [entry.category] - 分类（bugfix/codegen/refactor/test/deploy/config/general）
   * @param {string} [entry.pattern] - 失败模式描述
   * @param {string} [entry.rootCause] - 根本原因
   * @param {string} [entry.solution] - 解决方案
   * @param {string} [entry.context] - 上下文描述
   * @returns {object|null} 记录的反思条目，输入无效时返回null
   * @emits ErrorPreventionGuard#reflection-recorded
   */
  recordReflection(entry) {
    this.guardShutdown();
    if (!entry || typeof entry !== 'object') return null;
    const category = REFLECTION_CATEGORIES.includes(entry.category) ? entry.category : 'general';
    const reflection = {
      id: timestampId('ref-'),
      category: category,
      pattern: entry.pattern || '',
      rootCause: entry.rootCause || '',
      solution: entry.solution || '',
      context: entry.context || '',
      recordedAt: Date.now(),
    };
    if (this._reflections.length >= MAX_REFLECTION_ENTRIES) {
      this._reflections.shift();
    }
    this._reflections.push(reflection);
    this._stats.reflectionsRecorded++;
    this.registerErrorPattern({
      pattern: reflection.pattern,
      description: reflection.rootCause,
      solution: reflection.solution,
      confidence: 0.8,
    });
    this.emit('reflection-recorded', reflection);
    return reflection;
  }

  /**
   * 获取反思记录列表。
   * @param {string} [category] - 按分类过滤
   * @returns {Array<object>} 反思记录列表
   */
  getReflections(category) {
    if (category) {
      return this._reflections.filter(function(r) { return r.category === category; });
    }
    return this._reflections.slice();
  }

  /**
   * 将与任务相关的反思记录格式化为上下文文本，用于注入到后续任务中。
   * @param {string} [taskDescription] - 任务描述
   * @returns {string} 格式化的历史失败模式提醒文本，无相关记录时返回空字符串
   */
  getReflectionsAsContext(taskDescription) {
    if (this._reflections.length === 0) return '';
    const taskLower = (taskDescription || '').toLowerCase();
    const relevant = this._reflections.filter(function(r) {
      return taskLower.includes(r.pattern.toLowerCase()) || taskLower.includes(r.category);
    });
    if (relevant.length === 0) return '';
    let ctx = '## 历史失败模式提醒\n';
    for (const r of relevant.slice(0, 5)) {
      ctx += `- [${r.category}] ${r.pattern} → 根因: ${r.rootCause}; 解决: ${r.solution}\n`;
    }
    return ctx;
  }

  /**
   * 检查守卫是否健康（错误数小于100）。
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    return !this._shutDown && this._stats.errors < 100;
  }

  /**
   * 从自反思结果自动注册错误模式。KEPA自学习闭环的一部分，
   * 将反思结果中的改进建议、质量下降趋势和需关注维度转化为错误预防模式。
   * @param {Object} reflectionResult - 自反思结果对象
   * @param {Array<{description: string, dimension: string, recommendation: string}>} [reflectionResult.improvements] - 改进建议列表
   * @param {string} [reflectionResult.qualityTrend] - 质量趋势（'degrading'时注册质量下降模式）
   * @param {string} [reflectionResult.recommendedAction] - 推荐行动
   * @param {Object} [reflectionResult.dimensions] - 各维度评分，值为{needsAttention: boolean, score: number}
   * @returns {{ registered: number }} 注册结果，包含成功注册的模式数量
   */
  autoRegisterFromReflection(reflectionResult) {
    this.guardShutdown();
    if (!reflectionResult || typeof reflectionResult !== 'object') {
      return { registered: 0 };
    }

    let registered = 0;
    registered += this._registerImprovementsFromReflection(reflectionResult);
    registered += this._registerQualityTrendFromReflection(reflectionResult);
    registered += this._registerDimensionsFromReflection(reflectionResult);

    if (registered > 0) {
      this.emit('auto-registered-from-reflection', { count: registered });
    }

    return { registered: registered };
  }

  _registerImprovementsFromReflection(reflectionResult) {
    if (!reflectionResult.improvements || !Array.isArray(reflectionResult.improvements)) return 0;
    let registered = 0;
    for (const imp of reflectionResult.improvements) {
      const pattern = imp.description || imp.dimension || '';
      if (!pattern) continue;
      const result = this.registerErrorPattern({
        pattern: pattern,
        description: 'From reflection: ' + (imp.dimension || 'unknown'),
        solution: imp.recommendation || imp.description || '',
        confidence: 0.7,
      });
      if (result && result.id) registered++;
    }
    return registered;
  }

  _registerQualityTrendFromReflection(reflectionResult) {
    if (reflectionResult.qualityTrend !== 'degrading') return 0;
    const result = this.registerErrorPattern({
      pattern: 'quality-degradation',
      description: 'Quality trend is degrading',
      solution: reflectionResult.recommendedAction || 'Review and revise',
      confidence: 0.8,
    });
    return (result && result.id) ? 1 : 0;
  }

  _registerDimensionsFromReflection(reflectionResult) {
    if (!reflectionResult.dimensions || typeof reflectionResult.dimensions !== 'object') return 0;
    let registered = 0;
    for (const [dimName, dimValue] of Object.entries(reflectionResult.dimensions)) {
      if (dimValue && dimValue.needsAttention) {
        const result = this.registerErrorPattern({
          pattern: dimName + '-needs-attention',
          description: 'Dimension ' + dimName + ' needs attention (score: ' + (dimValue.score ?? 'unknown') + ')',
          solution: 'Focus improvement on ' + dimName,
          confidence: 0.7,
        });
        if (result && result.id) registered++;
      }
    }
    return registered;
  }

  _onShutdown() {
    this._patterns.clear();
    this._warningHistory = [];
    this._reflections = [];
    this.removeAllListeners();
  }
}

module.exports = { ErrorPreventionGuard: withShutdown(ErrorPreventionGuard) };
