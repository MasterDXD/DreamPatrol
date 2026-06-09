'use strict';

const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * 预测编码过滤器 — 基于 Mnemosyne Surprisal Gate 的 Node.js 原生实现
 *
 * 核心原理：大脑只永久编码预测误差（prediction error），忽略已预期的内容。
 * 在 AI 记忆系统中，低信息量输入不应写入长期记忆，高信息量输入应优先写入。
 *
 * 计算方法：
 * - 对每个输入，基于历史记忆生成"预测"（最近N条记忆的关键词集合）
 * - 计算输入与预测之间的"惊讶度"（surprisal）= 1 - Jaccard相似度
 * - 惊讶度超过阈值（默认0.3）的输入才被允许写入
 */
class SurprisalGate {
  /**
   * @param {object} options - 配置选项
   * @param {number} [options.threshold=0.3] - 惊讶度阈值，低于此值的输入被过滤
   * @param {number} [options.historySize=20] - 用于生成预测的历史记忆条数
   * @param {number} [options.cooldownMs=60000] - 相似输入的冷却时间（毫秒）
   */
  constructor(options = {}) {
    this._threshold = Math.max(0, Math.min(1, options.threshold ?? 0.3));
    this._historySize = Math.max(1, options.historySize ?? 20);
    this._cooldownMs = Math.max(0, options.cooldownMs ?? 60000);
    this._recentKeys = []; // 最近写入的记忆关键词集合
    this._cooldownMap = new Map(); // key -> timestamp
  }

  /**
   * 计算输入的惊讶度并决定是否允许写入
   * @param {string} content - 待写入的记忆内容
   * @param {object} [metadata] - 记忆元数据
   * @returns {{allowed: boolean, surprisal: number, reason: string}}
   */
  evaluate(content, _metadata = {}) {
    if (!content || typeof content !== 'string') {
      return { allowed: false, surprisal: 0, reason: 'empty content' };
    }

    // 检查冷却期
    const contentKey = this._extractKey(content);
    const lastSeen = this._cooldownMap.get(contentKey);
    if (lastSeen && Date.now() - lastSeen < this._cooldownMs) {
      return { allowed: false, surprisal: 0, reason: 'cooldown' };
    }

    // 如果没有历史，允许所有写入
    if (this._recentKeys.length === 0) {
      this._addToHistory(contentKey);
      return { allowed: true, surprisal: 1.0, reason: 'no history' };
    }

    // 计算与历史预测的 Jaccard 距离
    const inputTokens = this._tokenize(content);
    const predictionTokens = this._buildPrediction();
    const surprisal = this._jaccardDistance(inputTokens, predictionTokens);

    const allowed = surprisal >= this._threshold;
    if (allowed) {
      this._addToHistory(contentKey);
      this._cooldownMap.set(contentKey, Date.now());
    }

    // 清理过期的冷却记录
    this._cleanCooldown();

    return {
      allowed,
      surprisal: Math.round(surprisal * 1000) / 1000,
      reason: allowed ? 'above threshold' : 'below threshold',
    };
  }

  /**
   * 更新阈值（用于自适应调整）
   * @param {number} newThreshold - 新阈值
   */
  setThreshold(newThreshold) {
    this._threshold = Math.max(0, Math.min(1, newThreshold));
  }

  /**
   * 获取统计信息
   * @returns {{threshold: number, historySize: number, cooldownEntries: number}}
   */
  getStats() {
    return {
      threshold: this._threshold,
      historySize: this._recentKeys.length,
      cooldownEntries: this._cooldownMap.size,
    };
  }

  /** @private 提取内容的关键标识 */
  _extractKey(content) {
    return content.toLowerCase().trim().slice(0, 100);
  }

  /** @private 将内容分词为 token 集合 */
  _tokenize(content) {
    const tokens = new Set();
    const words = content.toLowerCase().split(/[\s,.;:!?()[\]{}'"\/\\]+/);
    for (const w of words) {
      if (w.length >= 2) tokens.add(w);
    }
    return tokens;
  }

  /** @private 构建预测 token 集合（合并最近历史） */
  _buildPrediction() {
    const tokens = new Set();
    for (const key of this._recentKeys) {
      const words = key.split(/[\s,.;:!?()[\]{}'"\/\\]+/);
      for (const w of words) {
        if (w.length >= 2) tokens.add(w);
      }
    }
    return tokens;
  }

  /** @private 计算 Jaccard 距离 = 1 - Jaccard 相似度 */
  _jaccardDistance(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 0;
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : 1 - intersection / union;
  }

  /** @private 添加到历史 */
  _addToHistory(key) {
    this._recentKeys.push(key);
    if (this._recentKeys.length > this._historySize) {
      this._recentKeys.shift();
    }
  }

  /** @private 清理过期的冷却记录 */
  _cleanCooldown() {
    const now = Date.now();
    for (const [key, ts] of this._cooldownMap) {
      if (now - ts > this._cooldownMs * 2) {
        this._cooldownMap.delete(key);
      }
    }
  }
}

module.exports = { SurprisalGate, SurprisalGateEnhanced: withShutdown(SurprisalGate) };
