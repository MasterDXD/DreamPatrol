'use strict';

/**
 * @module runtime/agent/agent-growth-engine
 * Agent成长引擎，融合自"游戏化Agent成长系统"概念。
 *
 * 核心洞察：AI Agent不应只是被动工具，而应像RPG角色一样
 * 通过完成任务获得经验、提升等级、解锁新技能。
 * 这不仅增加用户粘性，更重要的是让Agent的能力成长可量化、可追踪、可激励。
 *
 * 融合映射：
 * - 等级(LV) ← SkillTreeDAG.level + SkillQualityIndex.compositeScore
 * - 经验值(XP) ← RLRewardBridge.cumulativeReward + AgentContributionTracker.participationCount
 * - 技能解锁 ← SkillRouter.checkDependencies + SkillTreeDAG.computeLearningPath
 * - 成长轨迹 ← SkillEvolver演化历史 + RLRewardBridge.rewardHistory
 *
 * 本模块将这些分散的能力统一为"Agent成长引擎"，
 * 提供等级计算、经验累积、技能解锁判定、成长轨迹查询的完整闭环。
 */

const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedArray = require('../../utils/bounded-array');
const EventEmitter = require('events');

/**
 * Agent等级定义，融合自游戏化RPG等级体系
 */
const AGENT_LEVELS = [
  { level: 1, title: 'Novice', xpRequired: 0, skillSlots: 3, description: '初始Agent，仅具备基础能力' },
  { level: 2, title: 'Apprentice', xpRequired: 100, skillSlots: 5, description: '学徒Agent，解锁更多技能槽位' },
  { level: 3, title: 'Journeyman', xpRequired: 300, skillSlots: 8, description: '熟练Agent，可执行中等复杂度任务' },
  { level: 4, title: 'Adept', xpRequired: 600, skillSlots: 12, description: '专家Agent，解锁高级技能树分支' },
  { level: 5, title: 'Expert', xpRequired: 1000, skillSlots: 16, description: '资深Agent，可自主优化工作流' },
  { level: 6, title: 'Master', xpRequired: 1500, skillSlots: 20, description: '大师Agent，解锁全部技能树' },
  { level: 7, title: 'Grandmaster', xpRequired: 2200, skillSlots: 25, description: '宗师Agent，可创造新技能并传授' },
];

/**
 * 经验值来源类型
 */
const XP_SOURCE = {
  TASK_COMPLETED: 'task-completed',
  TASK_FAILED: 'task-failed',
  SKILL_MASTERED: 'skill-mastered',
  SKILL_EVOLVED: 'skill-evolved',
  QUALITY_IMPROVED: 'quality-improved',
  COLLABORATION: 'collaboration',
  MILESTONE: 'milestone',
  ACHIEVEMENT: 'achievement',
};

/**
 * 技能解锁状态
 */
const UNLOCK_STATUS = {
  LOCKED: 'locked',
  AVAILABLE: 'available',
  UNLOCKED: 'unlocked',
  MASTERED: 'mastered',
};

const DEFAULT_OPTIONS = {
  maxHistorySize: 500,
  xpDecayFactor: 0.98,
  masteryThreshold: 5,
};

const MAX_AGENTS = 100;

/**
 * Agent成长引擎，融合自"游戏化Agent成长系统"概念。
 *
 * 核心原则：
 * - Agent等级由累积经验值决定，经验值来自任务执行和技能掌握
 * - 技能解锁由等级+前置技能共同决定
 * - 成长轨迹完整记录，支持回溯分析
 * - 与现有RLRewardBridge/SkillTreeDAG/SkillQualityIndex无缝集成
 *
 * @classdesc Agent成长引擎。等级/XP/技能解锁的统一管理。
 * @extends EventEmitter
 */
class AgentGrowthEngine extends EventEmitter {

  /**
   * 创建AgentGrowthEngine实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxHistorySize=500] - 最大历史记录数
   * @param {number} [options.xpDecayFactor=0.98] - 经验值衰减因子
   * @param {number} [options.masteryThreshold=5] - 技能精通阈值（成功使用次数）
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._agents = new Map();
    this._stats = { xpAwarded: 0, levelUps: 0, skillsUnlocked: 0, skillsMastered: 0 };
  }

  /**
   * 注册Agent到成长引擎。
   * @param {string} agentId - Agent标识
   * @param {Object} [initialState] - 初始状态
   * @param {number} [initialState.xp=0] - 初始经验值
   * @param {string[]} [initialState.unlockedSkills=[]] - 已解锁技能列表
   * @returns {{ agentId: string, level: number, xp: number }} 注册结果
   */
  registerAgent(agentId, initialState) {
    this.guardShutdown();
    if (!agentId) return { agentId: null, level: 0, xp: 0 };

    const state = {
      xp: (initialState && initialState.xp) ?? 0,
      unlockedSkills: new Set(initialState && initialState.unlockedSkills ? initialState.unlockedSkills : []),
      masteredSkills: new Set(),
      skillUsageCount: new Map(),
      xpHistory: new BoundedArray(this._options.maxHistorySize),
      levelHistory: new BoundedArray(50),
      registeredAt: Date.now(),
    };

    const level = this._computeLevel(state.xp);
    state.currentLevel = level;

    if (this._agents.size >= MAX_AGENTS) {
      const oldestKey = this._agents.keys().next().value;
      this._agents.delete(oldestKey);
    }
    this._agents.set(agentId, state);
    this.emit('agent-registered', { agentId, level, xp: state.xp });

    return { agentId, level, xp: state.xp };
  }

  /**
   * 授予经验值，融合自游戏化"任务完成获得经验"概念。
   * @param {string} agentId - Agent标识
   * @param {number} xpAmount - 经验值数量
   * @param {Object} [context] - 经验来源上下文
   * @param {string} [context.source] - 来源类型
   * @param {string} [context.taskId] - 关联任务ID
   * @param {string} [context.skillId] - 关联技能ID
   * @returns {{ agentId: string, xpGained: number, totalXp: number, levelUp: boolean, newLevel: number }} 授予结果
   */
  awardXP(agentId, xpAmount, context) {
    this.guardShutdown();
    const state = this._agents.get(agentId);
    if (!state || typeof xpAmount !== 'number') {
      return { agentId: agentId || null, xpGained: 0, totalXp: 0, levelUp: false, newLevel: 0 };
    }

    const clampedXp = Math.max(0, xpAmount);
    const oldLevel = state.currentLevel;
    state.xp += clampedXp;

    // 记录经验历史
    state.xpHistory.push({
      xp: clampedXp,
      source: (context && context.source) || XP_SOURCE.TASK_COMPLETED,
      taskId: (context && context.taskId) || null,
      skillId: (context && context.skillId) || null,
      timestamp: Date.now(),
    });

    // 计算新等级
    const newLevel = this._computeLevel(state.xp);
    const levelUp = newLevel > oldLevel;

    if (levelUp) {
      state.currentLevel = newLevel;
      state.levelHistory.push({ from: oldLevel, to: newLevel, xp: state.xp, timestamp: Date.now() });
      this._stats.levelUps++;
      this.emit('level-up', { agentId, from: oldLevel, to: newLevel, xp: state.xp });
    }

    this._stats.xpAwarded += clampedXp;
    this.emit('xp-awarded', { agentId, xp: clampedXp, totalXp: state.xp, source: (context && context.source) || XP_SOURCE.TASK_COMPLETED });

    return { agentId, xpGained: clampedXp, totalXp: state.xp, levelUp, newLevel };
  }

  /**
   * 记录技能使用，融合自游戏化"技能熟练度"概念。
   * 使用次数达到阈值后自动标记为精通。
   * @param {string} agentId - Agent标识
   * @param {string} skillId - 技能标识
   * @param {boolean} [success=true] - 是否成功使用
   * @returns {{ agentId: string, skillId: string, usageCount: number, mastered: boolean }} 使用记录结果
   */
  recordSkillUsage(agentId, skillId, success) {
    this.guardShutdown();
    const state = this._agents.get(agentId);
    if (!state || !skillId) return { agentId: agentId || null, skillId: skillId || null, usageCount: 0, mastered: false };

    const count = (state.skillUsageCount.get(skillId) ?? 0) + (success !== false ? 1 : 0);
    state.skillUsageCount.set(skillId, count);

    // 精通判定
    const wasMastered = state.masteredSkills.has(skillId);
    const isMastered = count >= this._options.masteryThreshold;

    if (isMastered && !wasMastered) {
      state.masteredSkills.add(skillId);
      this._stats.skillsMastered++;
      this.emit('skill-mastered', { agentId, skillId, usageCount: count });
    }

    return { agentId, skillId, usageCount: count, mastered: isMastered };
  }

  /**
   * 解锁技能，融合自游戏化"等级解锁新技能"概念。
   * @param {string} agentId - Agent标识
   * @param {string} skillId - 技能标识
   * @returns {{ agentId: string, skillId: string, unlocked: boolean, reason: string }} 解锁结果
   */
  unlockSkill(agentId, skillId) {
    this.guardShutdown();
    const state = this._agents.get(agentId);
    if (!state || !skillId) return { agentId: agentId || null, skillId: skillId || null, unlocked: false, reason: 'Agent not registered' };

    if (state.unlockedSkills.has(skillId)) {
      return { agentId, skillId, unlocked: false, reason: 'Already unlocked' };
    }

    state.unlockedSkills.add(skillId);
    this._stats.skillsUnlocked++;
    this.emit('skill-unlocked', { agentId, skillId, level: state.currentLevel });

    return { agentId, skillId, unlocked: true, reason: 'Skill unlocked' };
  }

  /**
   * 检查技能解锁状态。
   * @param {string} agentId - Agent标识
   * @param {string} skillId - 技能标识
   * @param {Object} [dependencies] - 依赖信息
   * @param {string[]} [dependencies.prerequisites=[]] - 前置技能列表
   * @param {number} [dependencies.requiredLevel=1] - 所需等级
   * @returns {{ agentId: string, skillId: string, status: string, reason: string }} 解锁状态
   */
  checkUnlockStatus(agentId, skillId, dependencies) {
    this.guardShutdown();
    const state = this._agents.get(agentId);
    if (!state) return { agentId: agentId || null, skillId: skillId || null, status: UNLOCK_STATUS.LOCKED, reason: 'Agent not registered' };

    // 已精通
    if (state.masteredSkills.has(skillId)) {
      return { agentId, skillId, status: UNLOCK_STATUS.MASTERED, reason: 'Skill mastered' };
    }
    // 已解锁
    if (state.unlockedSkills.has(skillId)) {
      return { agentId, skillId, status: UNLOCK_STATUS.UNLOCKED, reason: 'Skill unlocked' };
    }

    // 检查等级要求
    const requiredLevel = (dependencies && dependencies.requiredLevel) || 1;
    if (state.currentLevel < requiredLevel) {
      return { agentId, skillId, status: UNLOCK_STATUS.LOCKED, reason: 'Level ' + requiredLevel + ' required, current: ' + state.currentLevel };
    }

    // 检查前置技能
    const prerequisites = (dependencies && dependencies.prerequisites) ?? [];
    const missing = prerequisites.filter(function(p) { return !state.unlockedSkills.has(p); });
    if (missing.length > 0) {
      return { agentId, skillId, status: UNLOCK_STATUS.LOCKED, reason: 'Missing prerequisites: ' + missing.join(', ') };
    }

    return { agentId, skillId, status: UNLOCK_STATUS.AVAILABLE, reason: 'All requirements met' };
  }

  /**
   * 获取Agent成长概况。
   * @param {string} agentId - Agent标识
   * @returns {Object} 成长概况
   */
  getGrowthProfile(agentId) {
    this.guardShutdown();
    const state = this._agents.get(agentId);
    if (!state) return null;

    const levelInfo = AGENT_LEVELS[state.currentLevel - 1] || AGENT_LEVELS[0];
    const nextLevel = AGENT_LEVELS[state.currentLevel] ?? null;

    return {
      agentId,
      level: state.currentLevel,
      title: levelInfo.title,
      description: levelInfo.description,
      xp: state.xp,
      xpForNextLevel: nextLevel ? nextLevel.xpRequired : null,
      xpProgress: nextLevel ? (state.xp - levelInfo.xpRequired) / (nextLevel.xpRequired - levelInfo.xpRequired) : 1,
      skillSlots: levelInfo.skillSlots,
      unlockedSkills: Array.from(state.unlockedSkills),
      masteredSkills: Array.from(state.masteredSkills),
      skillUsageSummary: this._buildSkillUsageSummary(state),
      registeredAt: state.registeredAt,
    };
  }

  /**
   * 获取Agent成长历史。
   * @param {string} agentId - Agent标识
   * @param {number} [limit=50] - 最大返回条数
   * @returns {Array<Object>} 成长历史
   */
  getGrowthHistory(agentId, limit) {
    const state = this._agents.get(agentId);
    if (!state) return [];
    const xpItems = state.xpHistory.toArray();
    const levelItems = state.levelHistory.toArray();
    const all = []
      .concat(xpItems.map(function(e) { return { type: 'xp', data: e }; }))
      .concat(levelItems.map(function(e) { return { type: 'level-up', data: e }; }))
      .sort(function(a, b) { return (b.data.timestamp ?? 0) - (a.data.timestamp ?? 0); });
    return all.slice(0, limit || 50);
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      registeredAgents: this._agents.size,
      xpAwarded: this._stats.xpAwarded,
      levelUps: this._stats.levelUps,
      skillsUnlocked: this._stats.skillsUnlocked,
      skillsMastered: this._stats.skillsMastered,
    };
  }

  /**
   * 根据经验值计算等级。
   * @param {number} xp - 经验值
   * @returns {number} 等级
   * @private
   */
  _computeLevel(xp) {
    for (let i = AGENT_LEVELS.length - 1; i >= 0; i--) {
      if (xp >= AGENT_LEVELS[i].xpRequired) return AGENT_LEVELS[i].level;
    }
    return 1;
  }

  /**
   * 构建技能使用摘要。
   * @param {Object} state - Agent状态
   * @returns {Object} 使用摘要
   * @private
   */
  _buildSkillUsageSummary(state) {
    const summary = { total: 0, mastered: 0, inProgress: 0 };
    for (const [skillId, count] of state.skillUsageCount) {
      summary.total++;
      if (state.masteredSkills.has(skillId)) summary.mastered++;
      else if (count > 0) summary.inProgress++;
    }
    return summary;
  }

  _onShutdown() {
    this._agents.clear();
    this.removeAllListeners();
  }
}

AgentGrowthEngine.AGENT_LEVELS = AGENT_LEVELS;
AgentGrowthEngine.XP_SOURCE = XP_SOURCE;
AgentGrowthEngine.UNLOCK_STATUS = UNLOCK_STATUS;

module.exports = withShutdown(AgentGrowthEngine);
