'use strict';

/**
 * @module runtime/agent/achievement-system
 * 成就/徽章系统，融合自"游戏化Agent成长系统"概念。
 *
 * 核心洞察：成就体系是游戏化的灵魂。没有成就反馈的Agent成长
 * 只是冷冰冰的数据变化，有了成就解锁的"叮"一声，
 * 用户才能感受到"培养Agent"的乐趣和目标感。
 *
 * 融合映射：
 * - 成就定义 ← Badge UI组件 + QualityLevel + stability/verified标签
 * - 成就触发 ← RLRewardBridge奖励信号 + AgentContributionTracker贡献记录
 * - 成就展示 ← Dashboard Badge组件
 * - 成就持久化 ← AgentStateManager快照机制
 *
 * 本模块实现完整的成就生命周期：定义→检查→解锁→展示→统计。
 */

const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedArray = require('../../utils/bounded-array');
const EventEmitter = require('events');

/**
 * 成就稀有度
 */
const RARITY = {
  COMMON: 'common',
  UNCOMMON: 'uncommon',
  RARE: 'rare',
  EPIC: 'epic',
  LEGENDARY: 'legendary',
};

/**
 * 成就类别
 */
const ACHIEVEMENT_CATEGORY = {
  SKILL: 'skill',
  GROWTH: 'growth',
  COLLABORATION: 'collaboration',
  QUALITY: 'quality',
  MILESTONE: 'milestone',
  SPECIAL: 'special',
};

/**
 * 内置成就定义，融合自游戏化Agent成长系统的成就体系
 */
const BUILTIN_ACHIEVEMENTS = [
  // 技能类
  { id: 'first-skill', name: '初出茅庐', description: '解锁第一个技能', category: ACHIEVEMENT_CATEGORY.SKILL, rarity: RARITY.COMMON, condition: { type: 'skill-unlock', count: 1 } },
  { id: 'skill-collector', name: '技能收藏家', description: '解锁10个技能', category: ACHIEVEMENT_CATEGORY.SKILL, rarity: RARITY.UNCOMMON, condition: { type: 'skill-unlock', count: 10 } },
  { id: 'skill-master', name: '技能大师', description: '精通5个技能', category: ACHIEVEMENT_CATEGORY.SKILL, rarity: RARITY.RARE, condition: { type: 'skill-master', count: 5 } },
  { id: 'skill-grandmaster', name: '技能宗师', description: '精通20个技能', category: ACHIEVEMENT_CATEGORY.SKILL, rarity: RARITY.LEGENDARY, condition: { type: 'skill-master', count: 20 } },
  // 成长类
  { id: 'first-level-up', name: '初露锋芒', description: '首次升级', category: ACHIEVEMENT_CATEGORY.GROWTH, rarity: RARITY.COMMON, condition: { type: 'level-up', count: 1 } },
  { id: 'level-5', name: '中流砥柱', description: '达到5级', category: ACHIEVEMENT_CATEGORY.GROWTH, rarity: RARITY.RARE, condition: { type: 'level-reach', level: 5 } },
  { id: 'level-7', name: '登峰造极', description: '达到7级(满级)', category: ACHIEVEMENT_CATEGORY.GROWTH, rarity: RARITY.LEGENDARY, condition: { type: 'level-reach', level: 7 } },
  // 协作类
  { id: 'team-player', name: '团队协作者', description: '参与3次协作任务', category: ACHIEVEMENT_CATEGORY.COLLABORATION, rarity: RARITY.UNCOMMON, condition: { type: 'collaboration', count: 3 } },
  { id: 'top-contributor', name: '核心贡献者', description: '成为Top-3贡献者', category: ACHIEVEMENT_CATEGORY.COLLABORATION, rarity: RARITY.EPIC, condition: { type: 'top-contributor', rank: 3 } },
  // 质量类
  { id: 'quality-excellent', name: '品质卓越', description: '技能质量达到EXCELLENT', category: ACHIEVEMENT_CATEGORY.QUALITY, rarity: RARITY.RARE, condition: { type: 'quality-level', level: 'excellent' } },
  { id: 'zero-errors', name: '零失误', description: '连续10次任务无错误', category: ACHIEVEMENT_CATEGORY.QUALITY, rarity: RARITY.EPIC, condition: { type: 'consecutive-success', count: 10 } },
  // 里程碑类
  { id: 'first-task', name: '第一步', description: '完成第一个任务', category: ACHIEVEMENT_CATEGORY.MILESTONE, rarity: RARITY.COMMON, condition: { type: 'task-complete', count: 1 } },
  { id: 'centurion', name: '百战老兵', description: '完成100个任务', category: ACHIEVEMENT_CATEGORY.MILESTONE, rarity: RARITY.EPIC, condition: { type: 'task-complete', count: 100 } },
  { id: 'xp-1000', name: '千锤百炼', description: '累积1000经验值', category: ACHIEVEMENT_CATEGORY.MILESTONE, rarity: RARITY.RARE, condition: { type: 'xp-total', amount: 1000 } },
];

const DEFAULT_OPTIONS = {
  maxUnlockHistory: 200,
  enableBuiltinAchievements: true,
};

/**
 * 成就/徽章系统，融合自"游戏化Agent成长系统"概念。
 *
 * 核心原则：
 * - 成就定义与触发条件分离，支持动态注册自定义成就
 * - 成就解锁是事件驱动的，由Agent成长引擎/奖励桥等模块触发
 * - 成就稀有度从COMMON到LEGENDARY，对应不同获取难度
 * - 成就解锁历史完整记录，支持回溯分析
 *
 * @classdesc 成就/徽章系统。成就定义、触发检查、解锁通知的完整闭环。
 * @extends EventEmitter
 */
class AchievementSystem extends EventEmitter {

  /**
   * 创建AchievementSystem实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxUnlockHistory=200] - 最大解锁历史数
   * @param {boolean} [options.enableBuiltinAchievements=true] - 是否启用内置成就
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._achievements = new Map();
    this._agentAchievements = new Map();
    /** @constant {number} MAX_AGENT_ACHIEVEMENTS - Agent成就注册表最大条目数 */
    this._maxAgentAchievements = this._options.maxAgentAchievements ?? 500;
    this._stats = { achievementsDefined: 0, unlocks: 0, checksRun: 0 };

    if (this._options.enableBuiltinAchievements) {
      for (const ach of BUILTIN_ACHIEVEMENTS) {
        this._achievements.set(ach.id, ach);
      }
      this._stats.achievementsDefined = this._achievements.size;
    }
  }

  /**
   * 注册自定义成就。
   * @param {Object} achievement - 成就定义
   * @param {string} achievement.id - 成就ID
   * @param {string} achievement.name - 成就名称
   * @param {string} achievement.description - 成就描述
   * @param {string} achievement.category - 成就类别
   * @param {string} achievement.rarity - 成就稀有度
   * @param {Object} achievement.condition - 触发条件
   * @returns {{ id: string, registered: boolean }} 注册结果
   */
  defineAchievement(achievement) {
    this.guardShutdown();
    if (!achievement || !achievement.id) return { id: null, registered: false };
    this._achievements.set(achievement.id, achievement);
    this._stats.achievementsDefined++;
    return { id: achievement.id, registered: true };
  }

  /**
   * 检查并解锁成就，融合自游戏化"成就触发"概念。
   * 由外部模块（AgentGrowthEngine/RLRewardBridge等）调用。
   * @param {string} agentId - Agent标识
   * @param {Object} progress - 当前进度
   * @param {number} [progress.skillsUnlocked=0] - 已解锁技能数
   * @param {number} [progress.skillsMastered=0] - 已精通技能数
   * @param {number} [progress.currentLevel=1] - 当前等级
   * @param {number} [progress.totalXp=0] - 总经验值
   * @param {number} [progress.tasksCompleted=0] - 已完成任务数
   * @param {number} [progress.collaborations=0] - 协作次数
   * @param {number} [progress.consecutiveSuccess=0] - 连续成功次数
   * @param {string} [progress.qualityLevel=''] - 质量等级
   * @param {number} [progress.contributorRank=0] - 贡献者排名
   * @returns {Array<Object>} 新解锁的成就列表
   */
  checkAndUnlock(agentId, progress) {
    this.guardShutdown();
    if (!agentId) return [];

    if (!this._agentAchievements.has(agentId)) {
      if (this._agentAchievements.size >= this._maxAgentAchievements) {
        const oldestKey = this._agentAchievements.keys().next().value;
        if (oldestKey) this._agentAchievements.delete(oldestKey);
      }
      this._agentAchievements.set(agentId, {
        unlocked: new Set(),
        history: new BoundedArray(this._options.maxUnlockHistory),
      });
    }

    const agentData = this._agentAchievements.get(agentId);
    const newlyUnlocked = [];

    for (const [achId, ach] of this._achievements) {
      if (agentData.unlocked.has(achId)) continue;
      this._stats.checksRun++;

      if (this._evaluateCondition(ach.condition, progress ?? {})) {
        agentData.unlocked.add(achId);
        const unlockRecord = {
          achievementId: achId,
          name: ach.name,
          rarity: ach.rarity,
          category: ach.category,
          unlockedAt: Date.now(),
        };
        agentData.history.push(unlockRecord);
        newlyUnlocked.push(unlockRecord);
        this._stats.unlocks++;
        this.emit('achievement-unlocked', { agentId, achievement: unlockRecord });
      }
    }

    return newlyUnlocked;
  }

  /**
   * 获取Agent已解锁的成就列表。
   * @param {string} agentId - Agent标识
   * @returns {Array<Object>} 已解锁成就列表
   */
  getUnlockedAchievements(agentId) {
    const agentData = this._agentAchievements.get(agentId);
    if (!agentData) return [];
    const result = [];
    for (const achId of agentData.unlocked) {
      const ach = this._achievements.get(achId);
      if (ach) {
        result.push({ id: ach.id, name: ach.name, description: ach.description, rarity: ach.rarity, category: ach.category });
      }
    }
    return result;
  }

  /**
   * 获取Agent成就解锁历史。
   * @param {string} agentId - Agent标识
   * @param {number} [limit=50] - 最大返回条数
   * @returns {Array<Object>} 解锁历史
   */
  getUnlockHistory(agentId, limit) {
    const agentData = this._agentAchievements.get(agentId);
    if (!agentData) return [];
    return agentData.history.toArray().slice(0, limit || 50);
  }

  /**
   * 获取所有可用成就定义。
   * @returns {Array<Object>} 成就定义列表
   */
  getAllAchievements() {
    const result = [];
    for (const [, ach] of this._achievements) {
      result.push({ id: ach.id, name: ach.name, description: ach.description, category: ach.category, rarity: ach.rarity });
    }
    return result;
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      achievementsDefined: this._stats.achievementsDefined,
      totalUnlocks: this._stats.unlocks,
      checksRun: this._stats.checksRun,
      agentsWithAchievements: this._agentAchievements.size,
    };
  }

  /**
   * 评估成就条件。
   * @param {Object} condition - 成就条件
   * @param {Object} progress - 当前进度
   * @returns {boolean} 是否满足条件
   * @private
   */
  _evaluateCondition(condition, progress) {
    if (!condition || !condition.type) return false;
    const evaluators = {
      'skill-unlock': function(c, p) { return (p.skillsUnlocked ?? 0) >= (c.count || 1); },
      'skill-master': function(c, p) { return (p.skillsMastered ?? 0) >= (c.count || 1); },
      'level-up': function(_c, p) { return (p.currentLevel || 1) > 1; },
      'level-reach': function(c, p) { return (p.currentLevel || 1) >= (c.level || 999); },
      'task-complete': function(c, p) { return (p.tasksCompleted ?? 0) >= (c.count || 1); },
      'xp-total': function(c, p) { return (p.totalXp ?? 0) >= (c.amount || 999999); },
      'collaboration': function(c, p) { return (p.collaborations ?? 0) >= (c.count || 1); },
      'quality-level': function(c, p) { return (p.qualityLevel || '') === (c.level || ''); },
      'consecutive-success': function(c, p) { return (p.consecutiveSuccess ?? 0) >= (c.count || 1); },
      'top-contributor': function(c, p) { return (p.contributorRank || 999) <= (c.rank || 3); },
    };
    const fn = evaluators[condition.type];
    return fn ? fn(condition, progress) : false;
  }

  _onShutdown() {
    this._achievements.clear();
    this._agentAchievements.clear();
    this.removeAllListeners();
  }
}

AchievementSystem.RARITY = RARITY;
AchievementSystem.ACHIEVEMENT_CATEGORY = ACHIEVEMENT_CATEGORY;
AchievementSystem.BUILTIN_ACHIEVEMENTS = BUILTIN_ACHIEVEMENTS;

module.exports = withShutdown(AchievementSystem);
