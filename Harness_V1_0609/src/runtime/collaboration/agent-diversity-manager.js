'use strict';

const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const BoundedArray = require('../../utils/bounded-array');

const DIVERSITY_METRICS = {
  role_diversity: 'role_diversity',
  approach_diversity: 'approach_diversity',
  error_diversity: 'error_diversity',
  perspective_diversity: 'perspective_diversity',
};

const MAX_CAPABILITIES = 100;

/**
 * @module runtime/collaboration/agent-diversity-manager
 * @classdesc Agent多样性管理器。角色/方法/错误/视角四维多样性评估，集成学习模式推荐
 * AgentDiversityManager — Agent多样性管理器
 * 从角色、方法、错误和视角四个维度评估Agent团队多样性，推荐集成学习模式（Bagging/Boosting）。
 * 维护Agent档案（角色、能力、历史错误/成功、视角权重），基于成功率动态调整Agent权重，
 * 检测团队同质化风险并提供多样性改进建议。
 */
class AgentDiversityManager {
  /**
   * 创建 AgentDiversityManager 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.diversityThreshold=0.3] - 多样性阈值
   * @param {number} [options.maxAgents=50] - 最大Agent数量
   * @param {number} [options.maxHistory=50] - 历史记录最大条数
   */
  constructor(options) {
    this._metrics = safeAssign({}, DIVERSITY_METRICS);
    this._agentProfiles = new Map();
    this._diversityThreshold = (options ?? {}).diversityThreshold ?? 0.3;
    this._maxAgents = (options ?? {}).maxAgents ?? 50;
    this._maxHistory = (options ?? {}).maxHistory ?? 50;
    this._history = new BoundedArray(this._maxHistory);
  }

  /**
   * 注册Agent并创建其多样性档案，超出容量时淘汰最早注册的Agent
   * @param {string} agentId - Agent唯一标识
   * @param {object} [profile] - Agent档案信息
   * @param {string} [profile.role='unknown'] - Agent角色
   * @param {string[]} [profile.capabilities=[]] - Agent能力列表
   * @param {string} [profile.perspective='neutral'] - Agent视角标签
   * @returns {{ agentId: string, role: string, capabilities: string[], pastErrors: Array, pastSuccesses: Array, perspective: string, weight: number, registeredAt: number }} 创建的Agent档案
   */
  registerAgent(agentId, profile) {
    this.guardShutdown();
    if (!agentId || typeof agentId !== 'string') return null;
    const rawCapabilities = (profile ?? {}).capabilities;
    const capabilities = Array.isArray(rawCapabilities)
      ? (rawCapabilities.length > MAX_CAPABILITIES ? rawCapabilities.slice(0, MAX_CAPABILITIES) : rawCapabilities)
      : [];
    const entry = {
      agentId,
      role: (profile ?? {}).role ?? 'unknown',
      capabilities,
      pastErrors: new BoundedArray(100),
      pastSuccesses: new BoundedArray(100),
      perspective: (profile ?? {}).perspective ?? 'neutral',
      weight: 1.0,
      registeredAt: Date.now(),
    };
    const existing = this._agentProfiles.get(agentId);
    if (existing) {
      existing.role = entry.role;
      existing.capabilities = entry.capabilities;
      existing.perspective = entry.perspective;
    } else {
      this._agentProfiles.set(agentId, entry);
    }
    if (this._agentProfiles.size > this._maxAgents) {
      const oldestKey = this._agentProfiles.keys().next().value;
      this._agentProfiles.delete(oldestKey);
    }
    return this._agentProfiles.get(agentId);
  }

  /**
   * 记录Agent的任务执行结果，并基于成功率动态更新Agent权重
   * 成功记录和错误记录各保留最近100条
   * @param {string} agentId - Agent唯一标识
   * @param {object} outcome - 执行结果
   * @param {boolean} outcome.success - 是否成功
   * @param {string} [outcome.task] - 任务描述
   * @param {string} [outcome.error] - 失败原因（失败时）
   * @returns {object|null} 更新后的Agent档案，Agent不存在时返回null
   */
  recordOutcome(agentId, outcome) {
    this.guardShutdown();
    if (!outcome || typeof outcome !== 'object') return null;
    const profile = this._agentProfiles.get(agentId);
    if (!profile) return null;
    if (outcome.success) {
      profile.pastSuccesses.push({ task: outcome.task ?? '', timestamp: Date.now() });
    } else {
      profile.pastErrors.push({ task: outcome.task ?? '', error: outcome.error ?? '', timestamp: Date.now() });
    }
    this._updateWeight(agentId);
    return profile;
  }

  _updateWeight(agentId) {
    const profile = this._agentProfiles.get(agentId);
    if (!profile) return;
    const total = profile.pastSuccesses.length + profile.pastErrors.length;
    if (total === 0) { profile.weight = 1.0; return; }
    const successRate = profile.pastSuccesses.length / total;
    profile.weight = 0.5 + successRate * 0.5;
  }

  /**
   * 计算指定Agent集合的四维多样性评分（角色、方法、错误、视角）
   * 综合得分为四维度的算术平均值，达到阈值时标记为多样化
   * @param {string[]} agentIds - 待评估的Agent ID列表
   * @returns {{ score: number, metrics: { role_diversity: number, approach_diversity: number, error_diversity: number, perspective_diversity: number }, diverse: boolean }} 多样性评估结果
   */
  computeDiversity(agentIds) {
    this.guardShutdown();
    if (!agentIds || !Array.isArray(agentIds) || agentIds.length <= 1) {
      return { score: 0, metrics: {}, diverse: false };
    }
    const profiles = agentIds.map(id => this._agentProfiles.get(id)).filter(Boolean);
    if (profiles.length <= 1) return { score: 0, metrics: {}, diverse: false };

    const roleDiv = this._computeRoleDiversity(profiles);
    const approachDiv = this._computeApproachDiversity(profiles);
    const errorDiv = this._computeErrorDiversity(profiles);
    const perspectiveDiv = this._computePerspectiveDiversity(profiles);

    const score = (roleDiv + approachDiv + errorDiv + perspectiveDiv) / 4;
    const result = {
      score,
      metrics: {
        role_diversity: roleDiv,
        approach_diversity: approachDiv,
        error_diversity: errorDiv,
        perspective_diversity: perspectiveDiv,
      },
      diverse: score >= this._diversityThreshold,
    };

    this._history.push({ agentIds, result, timestamp: Date.now() });
    return result;
  }

  _computeRoleDiversity(profiles) {
    if (!profiles || profiles.length === 0) return 0;
    const roles = new Set(profiles.map(p => p.role));
    return Math.min(roles.size / profiles.length, 1.0);
  }

  _computeApproachDiversity(profiles) {
    const allCaps = profiles.map(p => new Set(p.capabilities ?? []));
    let overlap = 0;
    let total = 0;
    for (let i = 0; i < allCaps.length; i++) {
      for (let j = i + 1; j < allCaps.length; j++) {
        const intersection = [...allCaps[i]].filter(c => allCaps[j].has(c)).length;
        const union = new Set([...allCaps[i], ...allCaps[j]]).size;
        overlap += union > 0 ? intersection / union : 0;
        total++;
      }
    }
    return total > 0 ? 1 - (overlap / total) : 0;
  }

  _computeErrorDiversity(profiles) {
    const errorSets = profiles.map(p => new Set((p.pastErrors ?? []).map(e => e.error).filter(e => e !== '')));
    let overlap = 0;
    let total = 0;
    for (let i = 0; i < errorSets.length; i++) {
      for (let j = i + 1; j < errorSets.length; j++) {
        const intersection = [...errorSets[i]].filter(e => errorSets[j].has(e)).length;
        const union = new Set([...errorSets[i], ...errorSets[j]]).size;
        if (union === 0) {
          continue;
        }
        overlap += intersection / union;
        total++;
      }
    }
    return total > 0 ? 1 - (overlap / total) : 0;
  }

  _computePerspectiveDiversity(profiles) {
    if (!profiles || profiles.length === 0) return 0;
    const perspectives = new Set(profiles.map(p => p.perspective));
    return Math.min(perspectives.size / profiles.length, 1.0);
  }

  /**
   * 根据当前团队多样性推荐集成学习模式
   * 低多样性推荐Boosting（串行纠错），高多样性+高绩效推荐Bagging（并行求稳），混合情况推荐Boosting
   * @param {object} _task - 任务上下文（预留参数，当前未使用）
   * @returns {{ mode: string, agents: string[], reason: string, diversityScore: number }} 集成模式推荐结果
   */
  getEnsembleRecommendation(_task) {
    this.guardShutdown();
    const agents = Array.from(this._agentProfiles.values());
    if (agents.length === 0) return { mode: 'none', agents: [], reason: 'no_agents_registered' };

    const diversity = this.computeDiversity(agents.map(a => a.agentId));
    if (!diversity.diverse) {
      return {
        mode: 'boosting',
        agents: agents.sort((a, b) => b.weight - a.weight).slice(0, 3).map(a => a.agentId),
        reason: 'low_diversity_boosting_recommended',
        diversityScore: diversity.score,
      };
    }

    const highPerformers = agents.filter(a => a.weight >= 0.7);
    if (highPerformers.length >= 3) {
      return {
        mode: 'bagging',
        agents: highPerformers.slice(0, 5).map(a => a.agentId),
        reason: 'high_diversity_high_performers_bagging',
        diversityScore: diversity.score,
      };
    }

    return {
      mode: 'boosting',
      agents: agents.sort((a, b) => b.weight - a.weight).slice(0, 3).map(a => a.agentId),
      reason: 'mixed_diversity_boosting_safe',
      diversityScore: diversity.score,
    };
  }

  /**
   * 获取指定Agent的多样性档案
   * @param {string} agentId - Agent唯一标识
   * @returns {object|null} Agent档案，不存在时返回null
   */
  getAgentProfile(agentId) { this.guardShutdown(); const profile = this._agentProfiles.get(agentId); return profile ? { ...profile, pastErrors: profile.pastErrors.slice(), pastSuccesses: profile.pastSuccesses.slice(), capabilities: profile.capabilities.slice() } : null; }
  /**
   * 获取指定Agent的当前权重（基于历史成功率的0.5-1.0动态值）
   * @param {string} agentId - Agent唯一标识
   * @returns {number} Agent权重，不存在时返回默认值1.0
   */
  getAgentWeight(agentId) { this.guardShutdown(); const profile = this._agentProfiles.get(agentId); return (profile && profile.weight) ?? 1.0; }
  /**
   * 获取多样性评估历史记录的浅拷贝
   * @returns {Array<{ agentIds: string[], result: object, timestamp: number }>} 历史记录数组
   */
  getHistory() { this.guardShutdown(); return this._history.slice(); }
  /**
   * 获取当前多样性阈值配置
   * @returns {number} 多样性阈值（0-1之间，默认0.3）
   */
  getDiversityThreshold() { this.guardShutdown(); return this._diversityThreshold; }

  _onShutdown() {
    for (const profile of this._agentProfiles.values()) {
      safeCall(() => profile.pastErrors.shutdown(), 'AgentDiversityManager', 'shutdown-pastErrors');
      safeCall(() => profile.pastSuccesses.shutdown(), 'AgentDiversityManager', 'shutdown-pastSuccesses');
    }
    this._agentProfiles.clear();
    safeCall(() => this._history.shutdown(), 'AgentDiversityManager', 'shutdown-history');
    this._diversityThreshold = 0.3;
  }
}

module.exports = { AgentDiversityManager: withShutdown(AgentDiversityManager), DIVERSITY_METRICS };
