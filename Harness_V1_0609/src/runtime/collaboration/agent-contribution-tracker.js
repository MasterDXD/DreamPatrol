'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedArray = require('../../utils/bounded-array');

/**
 * @module runtime/collaboration/agent-contribution-tracker
 * @classdesc Agent贡献度追踪器。权重/置信度记录，特征重要性输出，Top贡献者排名
 * AgentContributionTracker — Agent weight, confidence, and contribution metrics tracker
 * Records per-agent confidence and weight across ensemble modes (Bagging/Boosting/Stacking),
 * computes feature importance, top contributor rankings, and mode distribution statistics.
 * @extends EventEmitter
 */
class AgentContributionTracker extends EventEmitter {
  /**
   * 创建 AgentContributionTracker 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxRecords=1000] - 最大记录条数
   */
  constructor(options) {
    super();
    this._maxRecords = (options ?? {}).maxRecords ?? 1000;
    this._records = new BoundedArray(this._maxRecords, {
      onEvict: (evicted) => { if (evicted) this._decrementAgentStats(evicted); },
    });
    this._agentStats = new Map();
    this._globalModeCounts = new Map();
  }

  /**
   * 记录一条Agent贡献条目。当记录数超过上限时，自动移除最旧的记录并更新统计。
   * @param {string|object} agent - Agent标识符或Agent对象（取其id或name属性）
   * @param {string} mode - 集成模式（Bagging/Boosting/Stacking）
   * @param {number} agentConfidence - Agent自身置信度
   * @param {number} ensembleConfidence - 集成整体置信度
   * @param {number} [weight=1.0] - Agent在集成中的权重
   * @fires AgentContributionTracker#recorded
   */
  record(agent, mode, agentConfidence, ensembleConfidence, weight) {
    this.guardShutdown();
    const entry = {
      agent: typeof agent === 'string' ? agent : agent?.id ?? agent?.name ?? 'unknown',
      mode,
      agentConfidence: typeof agentConfidence === 'number' && Number.isFinite(agentConfidence) ? agentConfidence : 0,
      ensembleConfidence: typeof ensembleConfidence === 'number' && Number.isFinite(ensembleConfidence) ? ensembleConfidence : 0,
      weight: typeof weight === 'number' && Number.isFinite(weight) ? weight : 1.0,
      timestamp: Date.now(),
    };

    this._records.push(entry);
    this._updateAgentStats(entry);
    this._globalModeCounts.set(entry.mode, (this._globalModeCounts.get(entry.mode) ?? 0) + 1);
    this.emit('recorded', { agent: entry.agent, mode: entry.mode });
  }

  /**
   * 根据新增条目更新Agent统计数据，累加置信度、权重和参与次数。
   * @param {object} entry - 贡献条目对象
   * @param {string} entry.agent - Agent标识符
   * @param {string} entry.mode - 集成模式
   * @param {number} entry.agentConfidence - Agent置信度
   * @param {number} entry.weight - 权重值
   */
  _updateAgentStats(entry) {
    const key = entry.agent;
    if (!this._agentStats.has(key)) {
      this._agentStats.set(key, { totalConfidence: 0, count: 0, totalWeight: 0, modes: new Map() });
    }
    const stats = this._agentStats.get(key);
    stats.totalConfidence += entry.agentConfidence;
    stats.totalWeight += entry.weight;
    stats.count++;
    const modeCount = stats.modes.get(entry.mode) ?? 0;
    stats.modes.set(entry.mode, modeCount + 1);
  }

  /**
   * 根据移除的条目递减Agent统计数据，当参与次数归零时清除该Agent的统计记录。
   * @param {object} entry - 被移除的贡献条目对象
   * @param {string} entry.agent - Agent标识符
   * @param {string} entry.mode - 集成模式
   * @param {number} entry.agentConfidence - Agent置信度
   * @param {number} entry.weight - 权重值
   */
  _decrementAgentStats(entry) {
    const globalModeCount = this._globalModeCounts.get(entry.mode) ?? 0;
    if (globalModeCount <= 1) {
      this._globalModeCounts.delete(entry.mode);
    } else {
      this._globalModeCounts.set(entry.mode, globalModeCount - 1);
    }
    const stats = this._agentStats.get(entry.agent);
    if (!stats) return;
    stats.totalConfidence -= entry.agentConfidence;
    stats.totalWeight -= entry.weight;
    stats.count--;
    const modeCount = stats.modes.get(entry.mode) ?? 0;
    if (modeCount <= 1) {
      stats.modes.delete(entry.mode);
    } else {
      stats.modes.set(entry.mode, modeCount - 1);
    }
    if (stats.count <= 0) {
      this._agentStats.delete(entry.agent);
    }
  }

  /**
   * 获取指定Agent的重要性分数，即平均权重（总权重 / 参与次数）。
   * @param {string} agentId - Agent标识符
   * @returns {number} 重要性分数，若Agent不存在则返回0
   */
  getAgentImportance(agentId) {
    this.guardShutdown();
    const stats = this._agentStats.get(agentId);
    if (!stats || stats.count === 0) return 0;
    return stats.totalWeight / stats.count;
  }

  /**
   * 获取所有Agent的特征重要性映射表，包含平均权重、平均置信度、参与次数及模式分布。
   * @returns {Map<string, {averageWeight: number, averageConfidence: number, participationCount: number, modes: Object}>} 特征重要性映射表
   */
  getFeatureImportance() {
    this.guardShutdown();
    const importance = new Map();
    for (const [agentId, stats] of this._agentStats) {
      importance.set(agentId, {
        averageWeight: stats.count > 0 ? stats.totalWeight / stats.count : 0,
        averageConfidence: stats.count > 0 ? stats.totalConfidence / stats.count : 0,
        participationCount: stats.count,
        modes: Object.fromEntries(stats.modes),
      });
    }
    return importance;
  }

  /**
   * 获取贡献度排名前N的Agent列表，按平均权重降序排列。
   * @param {number} [n=5] - 返回的Agent数量上限
   * @returns {Array<{agentId: string, averageWeight: number, averageConfidence: number, participationCount: number, modes: Object}>} 排名前N的贡献者列表
   */
  getTopContributors(n) {
    this.guardShutdown();
    const count = n ?? 5;
    const importance = this.getFeatureImportance();
    return [...importance.entries()]
      .sort((a, b) => b[1].averageWeight - a[1].averageWeight)
      .slice(0, count)
      .map(([agentId, data]) => ({ agentId, ...data }));
  }

  /**
   * 按集成模式筛选贡献记录。
   * @param {string} mode - 集成模式（Bagging/Boosting/Stacking）
   * @returns {Array<object>} 匹配该模式的贡献记录列表
   */
  getRecordsByMode(mode) {
    this.guardShutdown();
    return this._records.filter(r => r.mode === mode);
  }

  /**
   * 获取指定Agent的全部贡献历史记录。
   * @param {string} agentId - Agent标识符
   * @returns {Array<object>} 该Agent的贡献记录列表
   */
  getAgentHistory(agentId) {
    this.guardShutdown();
    return this._records.filter(r => r.agent === agentId);
  }

  /**
   * 获取追踪器的汇总统计信息，包括总记录数、唯一Agent数量和模式分布。
   * @returns {{totalRecords: number, uniqueAgents: number, modeDistribution: Object}} 统计信息对象
   */
  getStats() {
    this.guardShutdown();
    return {
      totalRecords: this._records.length,
      uniqueAgents: this._agentStats.size,
      modeDistribution: this._computeModeDistribution(),
    };
  }

  /**
   * 计算各集成模式的记录数量分布。
   * @returns {Object.<string, number>} 模式名称到记录数量的映射对象
   */
  _computeModeDistribution() {
    return Object.fromEntries(this._globalModeCounts);
  }

  /**
   * 清除所有贡献记录和Agent统计数据，重置追踪器为初始状态。
   */
  clear() {
    this.guardShutdown();
    this._records.clear();
    this._agentStats.clear();
    this._globalModeCounts.clear();
  }

  /**
   * 关闭时清理所有记录和统计数据，释放内存资源。
   */
  _onShutdown() {
    this._records.clear();
    this._agentStats.clear();
    this._globalModeCounts.clear();
    this.removeAllListeners();
  }
}

module.exports = withShutdown(AgentContributionTracker);
module.exports.AgentContributionTracker = AgentContributionTracker;
