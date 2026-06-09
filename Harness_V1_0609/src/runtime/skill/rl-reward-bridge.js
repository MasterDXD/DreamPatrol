'use strict';

/**
 * @module runtime/skill/rl-reward-bridge
 * RL奖励反馈桥接器，融合自SkillOS自进化Agent框架的核心概念。
 *
 * SkillOS核心洞察：Skill Curator通过RL训练自动决定技能的Insert/Update/Delete操作，
 * 奖励机制是"长期任务收益反馈"（当下新增技能的价值在后续数十个任务兑现），
 * 区别于固定规则硬编码。
 *
 * 本模块填补Harness的关键差距：RLTrainingPipeline的奖励信号
 * 未驱动技能生命周期决策（Insert/Update/Delete）。
 * RLRewardBridge实现"奖励计算→策略更新→技能操作"的闭环。
 *
 * 闭环链路：
 * 任务执行→RLTrainingPipeline.computeReward()→RLRewardBridge.submitReward()
 * →evaluateImpact()→recommendAction()→EvolutionTriggerOrchestrator执行决策
 */

const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedArray = require('../../utils/bounded-array');
const EventEmitter = require('events');

/**
 * 技能操作类型，对应SkillOS Curator的Insert/Update/Delete
 */
const CURATOR_ACTION = {
  INSERT: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
  KEEP: 'keep',
};

/**
 * 奖励信号来源
 */
const REWARD_SOURCE = {
  TASK_SUCCESS: 'task-success',
  TASK_FAILURE: 'task-failure',
  QUALITY_IMPROVEMENT: 'quality-improvement',
  QUALITY_DEGRADATION: 'quality-degradation',
  EFFICIENCY_GAIN: 'efficiency-gain',
  EFFICIENCY_LOSS: 'efficiency-loss',
  CROSS_TASK_TRANSFER: 'cross-task-transfer',
};

/**
 * 决策置信度级别
 */
const CONFIDENCE_LEVEL = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

const MAX_SKILL_SCORES = 500;

const DEFAULT_OPTIONS = {
  maxRewardHistory: 1000,
  rewardDecayFactor: 0.95,
  insertThreshold: 0.7,
  updateThreshold: 0.4,
  deleteThreshold: -0.3,
  minSamplesForDecision: 5,
  longTermWindow: 20,
};

/**
 * RL奖励反馈桥接器，融合自SkillOS的"RL驱动技能生命周期决策"概念。
 *
 * 核心原则（融合自SkillOS实战洞察）：
 * - 奖励机制是长期任务收益反馈，不是即时奖励
 * - 当下新增技能的价值在后续数十个任务兑现
 * - 区别于固定规则硬编码，用RL策略自动决定Insert/Update/Delete
 * - 跨模型迁移：只用小模型训练Curator，可无缝对接大模型执行器
 *
 * @classdesc RL奖励反馈桥接器。奖励信号驱动技能生命周期决策。
 * @extends EventEmitter
 */
class RLRewardBridge extends EventEmitter {

  /**
   * 创建RLRewardBridge实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxRewardHistory=1000] - 最大奖励历史数
   * @param {number} [options.rewardDecayFactor=0.95] - 奖励衰减因子
   * @param {number} [options.insertThreshold=0.7] - Insert决策阈值
   * @param {number} [options.updateThreshold=0.4] - Update决策阈值
   * @param {number} [options.deleteThreshold=-0.3] - Delete决策阈值
   * @param {number} [options.minSamplesForDecision=5] - 最小决策样本数
   * @param {number} [options.longTermWindow=20] - 长期奖励窗口大小
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._rewardHistory = new Map();
    this._skillScores = new Map();
    this._pendingActions = new Map();
    this._stats = { rewardsReceived: 0, actionsRecommended: 0, inserts: 0, updates: 0, deletes: 0, keeps: 0 };
  }

  /**
   * 提交奖励信号，融合自SkillOS的"长期任务收益反馈"概念。
   * 奖励不是即时的，而是在后续任务中逐步兑现。
   * @param {string} skillId - 技能ID
   * @param {number} reward - 奖励值（-1到1之间）
   * @param {Object} [context] - 奖励上下文
   * @param {string} [context.source] - 奖励来源
   * @param {string} [context.taskId] - 关联任务ID
   * @param {string} [context.modelId] - 执行模型ID
   * @returns {{ accepted: boolean, skillId: string, cumulativeReward: number }} 提交结果
   */
  submitReward(skillId, reward, context) {
    this.guardShutdown();
    if (!skillId || typeof reward !== 'number' || !Number.isFinite(reward)) {
      return { accepted: false, skillId: skillId ?? null, cumulativeReward: 0 };
    }

    // 初始化技能奖励历史
    if (!this._rewardHistory.has(skillId)) {
      this._rewardHistory.set(skillId, new BoundedArray(this._options.maxRewardHistory));
    }

    // 记录奖励
    const clampedReward = Math.max(-1, Math.min(1, reward));
    const entry = {
      reward: clampedReward,
      source: (context && context.source) || REWARD_SOURCE.TASK_SUCCESS,
      taskId: (context && context.taskId) ?? null,
      modelId: (context && context.modelId) ?? null,
      timestamp: Date.now(),
    };
    const history = this._rewardHistory.get(skillId);
    if (history) history.push(entry);
    this._stats.rewardsReceived++;

    // 计算累积奖励（带衰减）
    const cumulativeReward = this._computeCumulativeReward(skillId);

    // 更新技能评分
    if (!this._skillScores.has(skillId) && this._skillScores.size >= MAX_SKILL_SCORES) {
      const oldestKey = this._skillScores.keys().next().value;
      this._skillScores.delete(oldestKey);
      this._rewardHistory.delete(oldestKey);
    }
    this._skillScores.set(skillId, {
      cumulativeReward,
      sampleCount: history ? history.length : 0,
      lastRewardAt: Date.now(),
    });

    this.emit('reward-received', { skillId, reward: clampedReward, cumulativeReward, source: entry.source });

    return { accepted: true, skillId, cumulativeReward };
  }

  /**
   * 评估技能影响，融合自SkillOS的"Curator观察Executor执行结果"概念。
   * 基于累积奖励和趋势判断技能是否需要Insert/Update/Delete。
   * @param {string} skillId - 技能ID
   * @returns {Object} 影响评估结果
   */
  evaluateImpact(skillId) {
    this.guardShutdown();
    const history = this._rewardHistory.get(skillId);
    if (!history || history.length === 0) {
      return { skillId, hasData: false, cumulativeReward: 0, trend: 'unknown', sampleCount: 0 };
    }

    const items = history.toArray();
    const cumulativeReward = this._computeCumulativeReward(skillId);
    const recentRewards = items.slice(-this._options.longTermWindow).map(function(e) { return e.reward; });
    const avgRecent = recentRewards.length > 0 ? recentRewards.reduce(function(a, b) { return a + b; }, 0) / recentRewards.length : 0;

    // 趋势判断：最近5个奖励 vs 之前5个奖励
    let trend = 'stable';
    if (recentRewards.length >= 6) {
      const firstHalf = recentRewards.slice(0, Math.floor(recentRewards.length / 2));
      const secondHalf = recentRewards.slice(Math.floor(recentRewards.length / 2));
      const avgFirst = firstHalf.reduce(function(a, b) { return a + b; }, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce(function(a, b) { return a + b; }, 0) / secondHalf.length;
      if (avgSecond - avgFirst > 0.1) trend = 'improving';
      else if (avgFirst - avgSecond > 0.1) trend = 'degrading';
    }

    return {
      skillId,
      hasData: true,
      cumulativeReward,
      averageRecentReward: avgRecent,
      trend,
      sampleCount: items.length,
      lastRewardAt: items.length > 0 ? items[items.length - 1].timestamp : Date.now(),
    };
  }

  /**
   * 推荐技能操作，融合自SkillOS的"Curator自主对技能库做Insert/Update/Delete"概念。
   * 基于累积奖励和趋势自动推荐操作类型。
   * @param {string} skillId - 技能ID
   * @returns {{ skillId: string, action: string, confidence: string, reason: string }} 推荐结果
   */
  recommendAction(skillId) {
    this.guardShutdown();
    const impact = this.evaluateImpact(skillId);
    if (!impact.hasData) {
      return { skillId, action: CURATOR_ACTION.KEEP, confidence: CONFIDENCE_LEVEL.LOW, reason: 'Insufficient data' };
    }

    if (impact.sampleCount < this._options.minSamplesForDecision) {
      return { skillId, action: CURATOR_ACTION.KEEP, confidence: CONFIDENCE_LEVEL.LOW, reason: 'Sample count below threshold: ' + impact.sampleCount };
    }

    const cumulativeReward = impact.cumulativeReward;
    const trend = impact.trend;
    let action = CURATOR_ACTION.KEEP;
    let confidence = CONFIDENCE_LEVEL.MEDIUM;
    let reason = '';

    // Insert：高奖励且趋势改善 → 新技能有价值，应保留并推广
    if (cumulativeReward >= this._options.insertThreshold && trend === 'improving') {
      action = CURATOR_ACTION.INSERT;
      confidence = CONFIDENCE_LEVEL.HIGH;
      reason = 'High cumulative reward with improving trend';
    }
    // Update：中等奖励或趋势不稳定 → 技能需要优化
    else if (cumulativeReward >= this._options.updateThreshold && cumulativeReward < this._options.insertThreshold) {
      action = CURATOR_ACTION.UPDATE;
      confidence = CONFIDENCE_LEVEL.MEDIUM;
      reason = 'Moderate reward, optimization recommended';
    }
    // Update：高奖励但趋势下降 → 技能可能在退化
    else if (cumulativeReward >= this._options.insertThreshold && trend === 'degrading') {
      action = CURATOR_ACTION.UPDATE;
      confidence = CONFIDENCE_LEVEL.HIGH;
      reason = 'High reward but degrading trend, needs attention';
    }
    // Delete：负奖励且趋势下降 → 技能失效
    else if (cumulativeReward <= this._options.deleteThreshold && trend === 'degrading') {
      action = CURATOR_ACTION.DELETE;
      confidence = CONFIDENCE_LEVEL.HIGH;
      reason = 'Negative reward with degrading trend';
    }
    // Delete：负奖励且样本充足 → 技能持续无效
    else if (cumulativeReward <= this._options.deleteThreshold && impact.sampleCount >= this._options.minSamplesForDecision * 2) {
      action = CURATOR_ACTION.DELETE;
      confidence = CONFIDENCE_LEVEL.MEDIUM;
      reason = 'Consistently negative reward over many samples';
    }
    // Keep：其他情况
    else {
      action = CURATOR_ACTION.KEEP;
      confidence = CONFIDENCE_LEVEL.MEDIUM;
      reason = 'Reward within acceptable range';
    }

    if (this._pendingActions.size >= 200) {
      const oldestKey = this._pendingActions.keys().next().value;
      if (oldestKey !== undefined) this._pendingActions.delete(oldestKey);
    }
    this._pendingActions.set(skillId, { action, confidence, reason, timestamp: Date.now() });
    this._stats.actionsRecommended++;
    if (action === CURATOR_ACTION.INSERT) this._stats.inserts++;
    else if (action === CURATOR_ACTION.UPDATE) this._stats.updates++;
    else if (action === CURATOR_ACTION.DELETE) this._stats.deletes++;
    else this._stats.keeps++;

    this.emit('action-recommended', { skillId, action, confidence, reason });

    return { skillId, action, confidence, reason };
  }

  /**
   * 批量评估所有技能的操作推荐。
   * @returns {Array<Object>} 所有技能的操作推荐列表
   */
  recommendAllActions() {
    this.guardShutdown();
    const recommendations = [];
    for (const skillId of this._rewardHistory.keys()) {
      recommendations.push(this.recommendAction(skillId));
    }
    return recommendations;
  }

  /**
   * 获取技能的奖励历史。
   * @param {string} skillId - 技能ID
   * @param {number} [limit=50] - 最大返回条数
   * @returns {Array<Object>} 奖励历史
   */
  getRewardHistory(skillId, limit) {
    this.guardShutdown();
    const history = this._rewardHistory.get(skillId);
    if (!history) return [];
    const items = history.toArray();
    return items.slice(-(limit || 50)).map(e => ({ ...e }));
  }

  /**
   * 获取待执行的操作列表。
   * @returns {Array<Object>} 待执行操作列表
   */
  getPendingActions() {
    this.guardShutdown();
    const actions = [];
    for (const [skillId, action] of this._pendingActions) {
      actions.push({ skillId, action: action.action, confidence: action.confidence, reason: action.reason, timestamp: action.timestamp });
    }
    return actions;
  }

  /**
   * 清除已执行的待处理操作。
   * @param {string} skillId - 技能ID
   * @returns {boolean} 是否清除成功
   */
  clearPendingAction(skillId) {
    return this._pendingActions.delete(skillId);
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    this.guardShutdown();
    return {
      rewardsReceived: this._stats.rewardsReceived,
      actionsRecommended: this._stats.actionsRecommended,
      inserts: this._stats.inserts,
      updates: this._stats.updates,
      deletes: this._stats.deletes,
      keeps: this._stats.keeps,
      trackedSkills: this._rewardHistory.size,
      pendingActions: this._pendingActions.size,
    };
  }

  /**
   * 计算累积奖励（带衰减），融合自SkillOS的"长期任务收益反馈"概念。
   * 越近期的奖励权重越高，远期奖励按衰减因子递减。
   * @param {string} skillId - 技能ID
   * @returns {number} 累积奖励值
   * @private
   */
  _computeCumulativeReward(skillId) {
    const history = this._rewardHistory.get(skillId);
    if (!history || history.length === 0) return 0;

    const items = history.toArray();
    let cumulative = 0;
    let weight = 1;
    const decay = this._options.rewardDecayFactor;

    for (let i = items.length - 1; i >= 0; i--) {
      cumulative += items[i].reward * weight;
      weight *= decay;
    }

    // 归一化：除以权重总和使结果在[-1, 1]范围内
    let weightSum;
    if (decay === 1) {
      weightSum = items.length;
    } else {
      weightSum = (1 - Math.pow(decay, items.length)) / (1 - decay);
    }
    return weightSum > 0 ? cumulative / weightSum : 0;
  }

  _onShutdown() {
    this._rewardHistory.clear();
    this._skillScores.clear();
    this._pendingActions.clear();
    this.removeAllListeners();
  }
}

RLRewardBridge.CURATOR_ACTION = CURATOR_ACTION;
RLRewardBridge.REWARD_SOURCE = REWARD_SOURCE;
RLRewardBridge.CONFIDENCE_LEVEL = CONFIDENCE_LEVEL;

module.exports = withShutdown(RLRewardBridge);
