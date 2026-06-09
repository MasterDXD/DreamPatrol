/**
 * 反馈可信度评估模块
 *
 * 基于反馈源的历史准确率，动态计算各反馈源的可信度评分，
 * 并提供加权聚合能力，使高可信度源的反馈在决策中占据更大权重。
 * 支持信任评分的时间衰减机制，确保长期未更新的反馈源评分逐步回归默认值。
 *
 * @module runtime/quality/feedback-credibility
 */

'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * 反馈可信度评估器
 * @classdesc 反馈可信度评估器。评估反馈来源可靠性、加权聚合
 *
 * 追踪各反馈源的历史准确率，动态维护可信度评分，并提供加权聚合接口。
 * 信任评分基于反馈源的正确率计算，支持时间衰减以防止过时评分影响决策。
 *
 * @extends EventEmitter
 * @emits {feedback-recorded} 当记录新的反馈时触发，载荷包含 sourceId、correct、score
 */
const MAX_SOURCES = 500;
const SEVEN_DAYS_MS = 7 * 86400000;

class FeedbackCredibility extends EventEmitter {
  /**
   * 创建 FeedbackCredibility 实例
   *
   * @param {Object} [config={}] - 配置对象
   * @param {number} [config.decayFactor=0.95] - 信任评分每日衰减因子，取值范围 (0, 1)，
   *   值越接近1衰减越慢，值越接近0衰减越快
   */
  constructor(config) {
    super();
    /** @private @type {Map<string, {score: number, samples: number, correctCount: number, lastRecordedAt: number}>} 反馈源信任数据映射 */
    this._sourceTrust = new Map();
    /** @private @type {Object} 配置对象 */
    this._config = config ?? {};
    /** @private @type {number} 每日衰减因子，默认0.95 */
    this._decayFactor = this._config.decayFactor ?? 0.95;
    /** @private @type {number} 默认信任评分，新反馈源及衰减回归的目标值 */
    this._defaultTrust = 0.5;
  }

  /**
   * 记录来自指定反馈源的反馈及其实际结果
   *
   * 根据反馈的实际结果更新该反馈源的可信度评分。
   * 若反馈源首次出现，则使用默认信任评分初始化。
   * 评分计算方式为正确次数除以总样本数。
   *
   * @param {string} sourceId - 反馈源唯一标识符
   * @param {*} feedback - 反馈内容（当前版本未直接参与评分计算，保留用于扩展）
   * @param {*} actualOutcome - 实际结果，真值表示反馈正确，假值表示反馈错误
   * @fires FeedbackCredibility#feedback-recorded
   */
  recordFeedback(sourceId, feedback, actualOutcome) {
    this.guardShutdown();
    if (!sourceId || typeof sourceId !== 'string') return;
    if (!this._sourceTrust.has(sourceId)) {
      if (this._sourceTrust.size >= MAX_SOURCES) {
        let oldestId = null;
        let oldestTime = Infinity;
        for (const [id, trust] of this._sourceTrust) {
          if (trust.lastRecordedAt < oldestTime) {
            oldestTime = trust.lastRecordedAt;
            oldestId = id;
          }
        }
        if (oldestId) this._sourceTrust.delete(oldestId);
      }
      this._sourceTrust.set(sourceId, {
        score: this._defaultTrust,
        samples: 0,
        correctCount: 0,
        lastRecordedAt: Date.now(),
      });
    }
    const trust = this._sourceTrust.get(sourceId);
    if (!trust) return;
    trust.samples++;
    const predictedCorrect = !!actualOutcome;
    if (predictedCorrect) trust.correctCount++;
    trust.score = (typeof trust.correctCount === 'number' && typeof trust.samples === 'number' && trust.samples > 0) ? trust.correctCount / trust.samples : this._defaultTrust;
    trust.lastRecordedAt = Date.now();
    this.emit('feedback-recorded', { sourceId, correct: predictedCorrect, score: trust.score });
  }

  /**
   * 获取指定反馈源的信任评分
   *
   * 若反馈源从未记录过反馈，则返回默认信任评分（0.5）。
   *
   * @param {string} sourceId - 反馈源唯一标识符
   * @returns {number} 信任评分，取值范围 [0, 1]
   */
  getTrustScore(sourceId) {
    this.guardShutdown();
    const trust = this._sourceTrust.get(sourceId);
    return trust ? trust.score : this._defaultTrust;
  }

  /**
   * 计算多条反馈的加权聚合值
   *
   * 以各反馈源的信任评分作为权重，对反馈值进行加权平均。
   * 未知的反馈源使用默认信任评分作为权重。
   * 当反馈列表为空或总权重为零时返回0。
   *
   * @param {Array<{sourceId: string, value: number}>} feedbacks - 反馈数组，
   *   每个元素包含反馈源标识和反馈值
   * @returns {number} 加权平均反馈值
   */
  getWeightedFeedback(feedbacks) {
    this.guardShutdown();
    if (!feedbacks || !Array.isArray(feedbacks)) return 0;
    if (feedbacks.length === 0) return 0;
    let weightedSum = 0;
    let weightSum = 0;
    for (const fb of feedbacks) {
      if (!fb || typeof fb.sourceId !== 'string' || typeof fb.value !== 'number' || !Number.isFinite(fb.value)) continue;
      const trust = this._sourceTrust.get(fb.sourceId);
      const weight = trust ? trust.score : this._defaultTrust;
      weightedSum += fb.value * weight;
      weightSum += weight;
    }
    return weightSum > 0 ? weightedSum / weightSum : 0;
  }

  /**
   * 对所有反馈源的信任评分执行时间衰减
   *
   * 根据距上次更新的天数，按指数衰减因子将信任评分向默认值回归。
   * 衰减公式：score = defaultTrust + (score - defaultTrust) * decayFactor^daysSinceUpdate。
   * 长期未更新的反馈源评分将逐步趋近默认信任评分。
   */
  decayTrustScores() {
    this.guardShutdown();
    const now = Date.now();
    const toDelete = [];
    for (const [sourceId, trust] of this._sourceTrust) {
      const daysSinceUpdate = (now - trust.lastRecordedAt) / 86400000;
      if (Number.isFinite(daysSinceUpdate) && daysSinceUpdate > 0) {
        const decay = Math.pow(Math.abs(this._decayFactor), daysSinceUpdate);
        trust.score = this._defaultTrust + (trust.score - this._defaultTrust) * decay;
      }
      if (Math.abs(trust.score - this._defaultTrust) < 0.01 && (now - trust.lastRecordedAt) > SEVEN_DAYS_MS) {
        toDelete.push(sourceId);
      }
    }
    for (const id of toDelete) {
      this._sourceTrust.delete(id);
    }
  }

  /**
   * 关闭反馈可信度评估器
   *
   * 清除所有反馈源信任数据，并移除所有事件监听器。
   * 调用后实例不可再使用，应丢弃引用。
   */
  _onShutdown() {
    this._sourceTrust.clear();
    this._config = {};
    this._decayFactor = 0.95;
    this._defaultTrust = 0.5;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(FeedbackCredibility);
