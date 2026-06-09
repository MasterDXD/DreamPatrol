'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const RingBuffer = require('../../utils/ring-buffer');
const { roundTo } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');

const DIMENSIONS = {
  COMPLETENESS: 'completeness',
  CORRECTNESS: 'correctness',
  CONSISTENCY: 'consistency',
  COVERAGE: 'coverage',
  CLARITY: 'clarity',
};

const DIMENSION_WEIGHTS = {
  completeness: 0.25,
  correctness: 0.30,
  consistency: 0.15,
  coverage: 0.15,
  clarity: 0.15,
};

const RELEVANCE_SCORES = { BASE: 0.3, FULL_MATCH: 0.7, LONG_RESULT: 0.3, MEDIUM_RESULT: 0.15 };
const RELEVANCE_THRESHOLDS = { LONG: 100, MEDIUM: 30 };
const CORRECTNESS_SCORES = { BASE: 0.4, SUCCESS_BONUS: 0.2, ERROR_PENALTY: 0.2, ERRORS_PENALTY: 0.15, VALID_BONUS: 0.15, PASSED_BONUS: 0.15 };
const COMPLETENESS_SCORES = { BASE: 0.3, KEY_FACTOR: 0.05, KEY_CAP: 0.3, DEFINED_WEIGHT: 0.7, BASE_WEIGHT: 0.3, FALLBACK_WEIGHT: 0.8 };
const CLARITY_SCORES = { BASE: 0.4, MULTI_SENTENCE_BONUS: 0.2, LENGTH_BONUS: 0.2, CAPITAL_START_BONUS: 0.1, DESC_KEY_BONUS: 0.2, MSG_KEY_BONUS: 0.15, DESC_PROP_BONUS: 0.15 };
const CLARITY_THRESHOLDS = { MIN_LENGTH: 50, MAX_LENGTH: 5000, MIN_SENTENCES: 2 };

/**
 * @module runtime/quality/quality-scorer
 */
/**
 * QualityScorer — 多维度质量评分器
 * @classdesc 质量评分器。多维度质量评估、阈值判定
 * 对任务产出进行五维加权评估（完整性/正确性/一致性/覆盖率/清晰度），
 * 输出0-1总分与excellent/good/acceptable/poor/failing等级判定。
 * 使用RingBuffer保留最近300条评分历史，支持SignalPersistence持久化。
 * @extends EventEmitter
 * @emits QualityScorer#scored
 */
class QualityScorer extends EventEmitter {
  constructor(options) {
    super();
    this._weights = safeAssign({}, DIMENSION_WEIGHTS, (options && options.weights) ?? {});
    this._thresholds = safeAssign({
      excellent: 0.9,
      good: 0.75,
      acceptable: 0.6,
      poor: 0.4,
    }, (options && options.thresholds) ?? {});
    this._maxHistory = (options && options.maxHistory) ?? 300;
    this._history = new RingBuffer(this._maxHistory);
    this._signalPersistence = (options && options.signalPersistence) ?? null;
  }

  /**
   * 附加信号持久化实例，评分结果将自动持久化到信号存储
   * @param {object} sp - SignalPersistence实例
   * @returns {QualityScorer} 当前实例，支持链式调用
   */
  attachSignalPersistence(sp) {
    this._signalPersistence = sp;
    return this;
  }

  /**
   * 对任务产出进行五维加权质量评分
   * 评估维度：完整性(completeness)、正确性(correctness)、一致性(consistency)、覆盖率(coverage)、清晰度(clarity)
   * 评分结果记入历史并触发'scored'事件，若已附加SignalPersistence则自动持久化
   * @param {object|string} result - 待评估的任务产出，对象或字符串
   * @param {object} [task] - 关联的任务描述，含id、requirements、expectedOutput、scope等字段
   * @param {string} [task.id] - 任务标识
   * @param {Array<string>} [task.requirements] - 需求列表，用于完整性匹配
   * @param {object} [task.expectedOutput] - 期望输出，用于正确性精确匹配
   * @param {object} [task.scope] - 任务范围，覆盖率加分项
   * @returns {{total: number, dimensions: object, grade: string, taskId: string|undefined, timestamp: string}} 评分结果，total为0-1加权总分，grade为excellent/good/acceptable/poor/failing
   * @throws {TypeError} If task is null or undefined when a task object is expected
   * @throws {Error} When criteria array is empty or contains invalid entries
   * @example
   * const scorer = new QualityScorer();
   * const result = scorer.score({
   *   output: 'Implementation complete',
   *   criteria: ['correctness', 'completeness', 'clarity'],
   *   weights: { correctness: 0.5, completeness: 0.3, clarity: 0.2 }
   * });
   * console.log(result.overall, result.breakdown);
   */
  score(result, task) {
    this.guardShutdown();
    if (!result) {
      return this._buildScore(0, { completeness: 0, correctness: 0, consistency: 0, coverage: 0, clarity: 0 }, task);
    }
    if (typeof result === 'string') {
      const dimensions = {
        completeness: this._scoreCompleteness(result, task),
        correctness: 0.5,
        consistency: 0.5,
        coverage: this._scoreCoverage(result, task),
        clarity: this._scoreClarity(result, task),
      };
      let total = 0;
      for (const dim of Object.keys(this._weights)) {
        total += (Number.isFinite(dimensions[dim]) ? dimensions[dim] : 0) * (Number.isFinite(this._weights[dim]) ? this._weights[dim] : 0);
      }
      total = Math.min(Math.max(total, 0), 1);
      const score = this._buildScore(total, dimensions, task);
      this._history.push(score);
      this.emit('scored', score);
      if (this._signalPersistence) {
        try {
          this._signalPersistence.record('quality', {
            total: score.total,
            grade: score.grade,
            dimensions: score.dimensions,
            taskId: score.taskId,
            timestamp: score.timestamp,
          });
        } catch (_e) { debug('QualityScorer', 'score', 'Persistence failed: ' + (_e && _e.message ? _e.message : String(_e))); }
      }
      return score;
    }
    if (typeof result !== 'object') {
      return this._buildScore(0, { completeness: 0, correctness: 0, consistency: 0, coverage: 0, clarity: 0 }, task);
    }

    const dimensions = {
      completeness: this._scoreCompleteness(result, task),
      correctness: this._scoreCorrectness(result, task),
      consistency: this._scoreConsistency(result, task),
      coverage: this._scoreCoverage(result, task),
      clarity: this._scoreClarity(result, task),
    };

    let total = 0;
    for (const dim of Object.keys(this._weights)) {
      total += (Number.isFinite(dimensions[dim]) ? dimensions[dim] : 0) * (Number.isFinite(this._weights[dim]) ? this._weights[dim] : 0);
    }
    total = Math.min(Math.max(total, 0), 1);

    const score = this._buildScore(total, dimensions, task);
    this._history.push(score);

    this.emit('scored', score);

    if (this._signalPersistence) {
      try {
        this._signalPersistence.record('quality', {
          total: score.total,
          grade: score.grade,
          dimensions: score.dimensions,
          taskId: score.taskId,
          timestamp: score.timestamp,
        });
      } catch (_e) { debug('QualityScorer', 'score', 'Persistence failed: ' + (_e && _e.message ? _e.message : String(_e))); }
    }

    return score;
  }

  _buildScore(total, dimensions, task) {
    let grade;
    if (total >= this._thresholds.excellent) grade = 'excellent';
    else if (total >= this._thresholds.good) grade = 'good';
    else if (total >= this._thresholds.acceptable) grade = 'acceptable';
    else if (total >= this._thresholds.poor) grade = 'poor';
    else grade = 'failing';

    return {
      total: roundTo(total, 3),
      dimensions,
      grade,
      taskId: (task && task.id) ?? undefined,
      timestamp: new Date().toISOString(),
    };
  }

  _scoreCompleteness(result, task) {
    let score = COMPLETENESS_SCORES.BASE;
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      const keys = Object.keys(result);
      score += Math.min(keys.length * COMPLETENESS_SCORES.KEY_FACTOR, COMPLETENESS_SCORES.KEY_CAP);

      if (task && task.requirements) {
        const reqs = Array.isArray(task.requirements) ? task.requirements : [];
        let met = 0;
        let resultStr;
        try { resultStr = JSON.stringify(result ?? '').toLowerCase(); } catch (_) { debug('QualityScorer', '_scoreCompleteness:stringify', _ && _.message ? _.message : String(_)); resultStr = String(result ?? '').toLowerCase(); }
        for (const req of reqs) {
          const reqStr = String(req ?? '').toLowerCase();
          if (resultStr.includes(reqStr)) met++;
        }
        if (reqs.length > 0) {
          score = Math.max(score, RELEVANCE_SCORES.BASE + (met / reqs.length) * RELEVANCE_SCORES.FULL_MATCH);
        }
      }
    }
    if (typeof result === 'string') {
      score += result.length > RELEVANCE_THRESHOLDS.LONG ? RELEVANCE_SCORES.LONG_RESULT : result.length > RELEVANCE_THRESHOLDS.MEDIUM ? RELEVANCE_SCORES.MEDIUM_RESULT : 0;
    }
    return Math.min(score, 1.0);
  }

  _scoreCorrectness(result, task) {
    let score = CORRECTNESS_SCORES.BASE;
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      score = this._adjustObjectCorrectness(score, result);
    }
    if (task && task.expectedOutput && result) {
      score = this._scoreExpectedMatch(score, task.expectedOutput, result);
    }
    return Math.min(Math.max(score, 0), 1.0);
  }

  _adjustObjectCorrectness(score, result) {
    let s = score;
    if (result.success === true && !result.error && !result.errors && !result.failures) s += CORRECTNESS_SCORES.SUCCESS_BONUS;
    if (result.error) s -= CORRECTNESS_SCORES.ERROR_PENALTY;
    if (result.errors && result.errors.length > 0) s -= CORRECTNESS_SCORES.ERRORS_PENALTY;
    if (result.failures && result.failures.length > 0) s -= CORRECTNESS_SCORES.ERRORS_PENALTY;
    if (result.valid === true) s += CORRECTNESS_SCORES.VALID_BONUS;
    if (result.passed === true) s += CORRECTNESS_SCORES.PASSED_BONUS;
    return s;
  }

  _scoreExpectedMatch(score, expectedOutput, result) {
    let expected, actual;
    try { expected = JSON.stringify(expectedOutput); } catch (err) { debug('QualityScorer', '_scoreExpectedMatch', 'JSON.stringify expected failed: ' + (err && err.message ? err.message : String(err))); return score; }
    try { actual = JSON.stringify(result); } catch (err) { debug('QualityScorer', '_scoreExpectedMatch', 'JSON.stringify actual failed: ' + (err && err.message ? err.message : String(err))); return score; }
    if (expected === actual) return 1.0;
    const expectedWords = new Set(expected.toLowerCase().split(/\s+/));
    const actualWords = new Set(actual.toLowerCase().split(/\s+/));
    let overlap = 0;
    for (const w of expectedWords) {
      if (actualWords.has(w)) overlap++;
    }
    const similarity = expectedWords.size > 0 ? overlap / expectedWords.size : 0;
    return Math.max(score, similarity);
  }

  _scoreConsistency(result, _task) {
    let score = 0.5;
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      const values = Object.values(result);
      const types = new Set(values.map(v => typeof v));
      if (types.size <= 2) score += 0.2;
      if (result.status && typeof result.status === 'string') score += 0.15;
      if (result.metadata || result.context) score += 0.15;
    }
    return Math.min(score, 1.0);
  }

  _scoreCoverage(result, task) {
    let score = 0.3;
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      if (result.coverage !== undefined) {
        const cov = (result.coverage !== '' && Number.isFinite(Number(result.coverage))) ? Number(result.coverage) : null;
        score = cov !== null ? Math.min(Math.max(cov, 0), 1.0) : 0.3;
      } else if (result.tests) {
        const tests = Array.isArray(result.tests) ? result.tests : [];
        const passed = tests.filter(t => t && (t.passed || t.status === 'passed')).length;
        score = tests.length > 0 ? passed / tests.length : 0.3;
      } else {
        const keys = Object.keys(result);
        score += Math.min(keys.length * 0.03, 0.4);
      }
    }
    if (task && task.scope) {
      score += 0.1;
    }
    return Math.min(score, 1.0);
  }

  _scoreClarity(result, _task) {
    let score = CLARITY_SCORES.BASE;
    if (typeof result === 'string') {
      const sentences = result.split(/[.!?]+/).filter(s => s.trim().length > 0);
      if (sentences.length >= CLARITY_THRESHOLDS.MIN_SENTENCES) score += CLARITY_SCORES.MULTI_SENTENCE_BONUS;
      if (result.length > CLARITY_THRESHOLDS.MIN_LENGTH && result.length < CLARITY_THRESHOLDS.MAX_LENGTH) score += CLARITY_SCORES.LENGTH_BONUS;
      if (/[A-Z]/.test(result.charAt(0))) score += CLARITY_SCORES.CAPITAL_START_BONUS;
    }
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      if (result.description || result.summary) score += CLARITY_SCORES.DESC_KEY_BONUS;
      if (result.message && typeof result.message === 'string') score += CLARITY_SCORES.MSG_KEY_BONUS;
      const keys = Object.keys(result);
      const hasDescriptiveKeys = keys.some(k =>
        k.includes('description') || k.includes('name') || k.includes('label') || k.includes('summary'),
      );
      if (hasDescriptiveKeys) score += CLARITY_SCORES.DESC_PROP_BONUS;
    }
    return Math.min(score, 1.0);
  }

  /**
   * 获取评分历史记录
   * @param {number} [limit] - 返回的最大记录数，默认返回全部历史
   * @returns {Array<object>} 按时间排序的评分记录数组，每条含total/dimensions/grade/taskId/timestamp
   */
  getHistory(limit) {
    if (!this.isHealthy()) return [];
    const n = limit ?? this._history.size;
    if (n <= 0) return [];
    return this._history.toArray().slice(-n).map(s => ({ ...s, dimensions: { ...s.dimensions } }));
  }

  /**
   * 获取评分统计摘要
   * @returns {{totalScores: number, averageScore: number, gradeDistribution: object}} 统计信息，含总评分次数、平均分、等级分布
   */
  getStats() {
    this.guardShutdown();
    if (this._history.size === 0) {
      return { totalScores: 0, averageScore: 0, gradeDistribution: {} };
    }
    const gradeDistribution = {};
    let totalScore = 0;
    for (const entry of this._history) {
      gradeDistribution[entry.grade] = (gradeDistribution[entry.grade] ?? 0) + 1;
      totalScore += entry.total;
    }
    return {
      totalScores: this._history.size,
      averageScore: this._history.size > 0 ? Math.round((totalScore / this._history.size) * 1000) / 1000 : 0,
      gradeDistribution,
    };
  }

  _onShutdown() {
    this._weights = { ...DIMENSION_WEIGHTS };
    this._thresholds = { excellent: 0.9, good: 0.75, acceptable: 0.6, poor: 0.4 };
    this._maxHistory = 300;
    this._history = new RingBuffer(this._maxHistory);
    this._signalPersistence = null;
    this.removeAllListeners();
  }
}

QualityScorer.DIMENSIONS = DIMENSIONS;
QualityScorer.DIMENSION_WEIGHTS = DIMENSION_WEIGHTS;

module.exports = withShutdown(QualityScorer);
