'use strict';

/**
 * @module gate/output-conciseness-guard
 * 输出精简度守卫。五维度输出质量守卫：Token数、行数、重复率、填充词率、代码注释率，
 * 计算综合精简度评分，追踪历史评分趋势，提供可操作的精简建议。
 */

/**
 * @classdesc 输出精简度守卫。Token/行数/重复率五维检测
 * 输出精简度守卫。五维度输出质量守卫（Token数、行数、重复率、填充词率、代码注释率），
 * 计算综合精简度评分，支持可配置阈值和惩罚机制，追踪历史评分趋势。
 */
class OutputConcisenessGuard {
  /**
   * 创建OutputConcisenessGuard实例。
   * @param {object} [options] - 配置选项
   * @param {number} [options.maxTokens=2000] - 最大Token数
   * @param {number} [options.maxLines=100] - 最大行数
   * @param {number} [options.maxRepetitionRatio=0.3] - 最大重复率
   * @param {number} [options.penaltyThreshold=0.7] - 惩罚阈值
   */
  constructor(options) {
    const opts = options ?? {};
    this._initConfig(opts);
    this._history = [];
    this._maxHistory = 50;
  }

  _initConfig(opts) {
    this._maxTokens = this._safeNumber(opts.maxTokens, 2000);
    this._maxLines = this._safeNumber(opts.maxLines, 100);
    this._maxRepetitionRatio = this._safeNumber(opts.maxRepetitionRatio, 0.3);
    this._penaltyThreshold = this._safeNumber(opts.penaltyThreshold, 0.7);
  }

  _safeNumber(value, defaultValue) {
    return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
  }

  /**
   * 检查输出文本的精简度，计算五维度指标和综合评分。
   * @param {string} output - 待检查的输出文本
   * @returns {{concise: boolean, score: number, violations: Array, suggestions: Array, metrics: object}} 精简度检查结果
   * @throws {Error} When output is not a string
   */
  check(output) {
    if (!output || typeof output !== 'string') {
      return { concise: true, score: 1.0, violations: [], suggestions: [] };
    }

    const violations = [];
    const suggestions = [];
    const metrics = this._computeMetrics(output);
    const score = this._computeScore(metrics);

    if (metrics.tokenEstimate > this._maxTokens) {
      violations.push({ type: 'token_limit', value: metrics.tokenEstimate, limit: this._maxTokens });
      suggestions.push('Reduce output length. Focus on essential information only.');
    }

    if (metrics.lineCount > this._maxLines) {
      violations.push({ type: 'line_limit', value: metrics.lineCount, limit: this._maxLines });
      suggestions.push('Consolidate multi-line explanations into concise summaries.');
    }

    if (metrics.repetitionRatio > this._maxRepetitionRatio) {
      violations.push({ type: 'repetition', value: Math.round(metrics.repetitionRatio * 100), limit: Math.round(this._maxRepetitionRatio * 100) });
      suggestions.push('Remove repeated phrases or patterns. Say it once clearly.');
    }

    if (metrics.fillerRatio > 0.1) {
      violations.push({ type: 'filler_words', value: Math.round(metrics.fillerRatio * 100) });
      suggestions.push('Remove filler phrases like "It\'s worth noting", "As mentioned", "In summary".');
    }

    if (metrics.codeCommentRatio > 0.5 && metrics.codeLineCount > 10) {
      violations.push({ type: 'excessive_comments', value: Math.round(metrics.codeCommentRatio * 100) });
      suggestions.push('Reduce comments. Code should be self-documenting.');
    }

    const concise = score >= this._penaltyThreshold;

    this._history.push({ score, violationCount: violations.length, timestamp: Date.now() });
    if (this._history.length > this._maxHistory) this._history.shift();

    return { concise, score: Math.round(score * 100) / 100, violations, suggestions, metrics };
  }

  _computeMetrics(output) {
    if (typeof output !== 'string') return { tokens: 0, lines: 0, uniqueWords: new Set(), totalWords: 0, repetitionRatio: 0 };
    const lines = output.split('\n');
    const lineCount = lines.length;
    const charCount = output.length;
    const tokenEstimate = Math.ceil(charCount / 4);

    const words = output.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    const repetitionRatio = this._computeRepetition(words);

    const fillerPatterns = /\b(it's worth noting|as mentioned|in summary|it should be noted|needless to say|it goes without saying|importantly|basically|essentially|fundamentally)\b/gi;
    const fillerMatches = (output.match(fillerPatterns) ?? []).length;
    const fillerRatio = wordCount > 0 ? fillerMatches / wordCount : 0;

    const commentLineRegex = /^\s*(\/\/|\/\*|\*\/|\*\s|\*\/)/;
    const codeLines = lines.filter(l => commentLineRegex.test(l));
    const totalCodeLines = lines.filter(l => l.trim().length > 0 && !commentLineRegex.test(l));
    let codeCommentRatio;
    if (totalCodeLines.length === 0 && codeLines.length > 0) {
      codeCommentRatio = 1.0;
    } else if (totalCodeLines.length > 0) {
      codeCommentRatio = codeLines.length / totalCodeLines.length;
    } else {
      codeCommentRatio = 0;
    }
    const codeLineCount = totalCodeLines.length;

    return { lineCount, charCount, tokenEstimate, wordCount, repetitionRatio, fillerRatio, codeCommentRatio, codeLineCount };
  }

  _computeRepetition(words) {
    if (words.length < 4) return 0;
    const trigrams = new Map();
    for (let i = 0; i <= words.length - 3; i++) {
      const tri = words.slice(i, i + 3).join(' ').toLowerCase();
      trigrams.set(tri, (trigrams.get(tri) ?? 0) + 1);
    }
    let repeated = 0;
    for (const count of trigrams.values()) {
      if (count > 1) repeated += count - 1;
    }
    return repeated / Math.max(trigrams.size, 1);
  }

  _computeScore(metrics) {
    let score = 1.0;
    if (metrics.tokenEstimate > this._maxTokens) score -= 0.3;
    if (metrics.lineCount > this._maxLines) score -= 0.2;
    if (metrics.repetitionRatio > this._maxRepetitionRatio) score -= 0.25;
    if (metrics.fillerRatio > 0.1) score -= 0.15;
    if (metrics.codeCommentRatio > 0.5 && metrics.codeLineCount > 10) score -= 0.1;
    return Math.max(0, score);
  }

  /**
   * 获取历史评分记录的副本。
   * @returns {Array<object>} 历史评分列表
   */
  getHistory() { return this._history.slice(); }

  /**
   * 获取历史平均评分。
   * @returns {number} 平均评分（0-1），无历史记录时返回1.0
   */
  getAverageScore() {
    if (this._history.length === 0) return 1.0;
    return Math.round(this._history.reduce((s, h) => s + (typeof h.score === 'number' && Number.isFinite(h.score) ? h.score : 0), 0) / this._history.length * 100) / 100;
  }
}

module.exports = { OutputConcisenessGuard };
