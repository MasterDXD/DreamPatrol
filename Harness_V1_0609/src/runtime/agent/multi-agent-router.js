'use strict';

const { EventEmitter } = require('events');
const { generateId } = require('../../utils/constants');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall, clamp01 } = require('../../utils/safe-execute');

const DEFAULT_TOP_K = 2;
const DEFAULT_MIN_AFFINITY = 0.3;
const MAX_AGENT_LOAD_ENTRIES = 200;
const MAX_DYNAMIC_CAPABILITIES = 200;

const AGENT_CAPABILITIES = {
  'team-lead': { strengths: ['coordination', 'planning', 'dispatching'], scope: 'project', tier: 'ceo', modelTier: 'high' },
  'domain-analyst': { strengths: ['analysis', 'design', 'review', 'architecture'], scope: 'domain', tier: 'specialist', modelTier: 'high' },
  'task-worker': { strengths: ['implementation', 'coding', 'debugging', 'testing'], scope: 'task', tier: 'worker', modelTier: 'medium' },
  'quality-assurance': { strengths: ['testing', 'review', 'security', 'verification'], scope: 'quality', tier: 'specialist', modelTier: 'medium' },
  'devops-engineer': { strengths: ['deployment', 'infrastructure', 'monitoring'], scope: 'operations', tier: 'specialist', modelTier: 'medium' },
  'technical-writer': { strengths: ['documentation', 'knowledge', 'communication'], scope: 'docs', tier: 'specialist', modelTier: 'low' },
  'code-reviewer': { strengths: ['review', 'quality', 'standards'], scope: 'quality', tier: 'specialist', modelTier: 'medium' },
  'security-reviewer': { strengths: ['security', 'audit', 'compliance'], scope: 'security', tier: 'specialist', modelTier: 'medium' },
  'build-error-solver': { strengths: ['debugging', 'build', 'dependency'], scope: 'operations', tier: 'worker', modelTier: 'low' },
  'planner': { strengths: ['planning', 'decomposition', 'estimation'], scope: 'project', tier: 'specialist', modelTier: 'medium' },
  'test-writer': { strengths: ['testing', 'tdd', 'coverage'], scope: 'quality', tier: 'worker', modelTier: 'low' },
  'typescript-reviewer': { strengths: ['review', 'typescript', 'type-safety'], scope: 'quality', tier: 'specialist', modelTier: 'low' },
  'python-reviewer': { strengths: ['review', 'python', 'idiomatic'], scope: 'quality', tier: 'specialist', modelTier: 'low' },
  'go-reviewer': { strengths: ['review', 'go', 'concurrency'], scope: 'quality', tier: 'specialist', modelTier: 'low' },
  'rust-reviewer': { strengths: ['review', 'rust', 'safety'], scope: 'security', tier: 'specialist', modelTier: 'low' },
  'java-reviewer': { strengths: ['review', 'java', 'enterprise'], scope: 'quality', tier: 'specialist', modelTier: 'low' },
  'data-analyst': { strengths: ['analysis', 'statistics', 'visualization', 'pattern-recognition'], scope: 'data', tier: 'specialist', modelTier: 'medium' },
  'product-manager': { strengths: ['planning', 'analysis', 'communication', 'prioritization'], scope: 'product', tier: 'specialist', modelTier: 'medium' },
  'ux-designer': { strengths: ['design', 'empathy', 'creativity', 'usability'], scope: 'design', tier: 'specialist', modelTier: 'medium' },
  'seo-specialist': { strengths: ['analysis', 'optimization', 'research', 'strategy'], scope: 'marketing', tier: 'specialist', modelTier: 'low' },
  'marketing-strategist': { strengths: ['strategy', 'creativity', 'analysis', 'communication'], scope: 'marketing', tier: 'specialist', modelTier: 'medium' },
  'frontend-engineer': { strengths: ['implementation', 'design', 'performance', 'testing'], scope: 'task', tier: 'worker', modelTier: 'medium' },
  'backend-engineer': { strengths: ['architecture', 'implementation', 'performance', 'security'], scope: 'task', tier: 'worker', modelTier: 'medium' },
  'research-specialist': { strengths: ['research', 'analysis', 'synthesis', 'critical-thinking'], scope: 'research', tier: 'specialist', modelTier: 'medium' },
};
const AGENT_STRENGTH_SETS_DEFAULT = {};
for (const [agentId, caps] of Object.entries(AGENT_CAPABILITIES)) {
  AGENT_STRENGTH_SETS_DEFAULT[agentId] = new Set(caps.strengths);
}

function _cloneStrengthSets() {
  const clone = {};
  for (const [agentId, strengths] of Object.entries(AGENT_STRENGTH_SETS_DEFAULT)) {
    clone[agentId] = new Set(strengths);
  }
  return clone;
}

const TASK_TYPE_SIGNALS = {
  'coordination': ['协调', '分配', '管理', 'coordinate', 'manage', 'dispatch'],
  'analysis': ['分析', '设计', '评估', 'analyze', 'design', 'evaluate'],
  'implementation': ['实现', '编码', '开发', 'implement', 'code', 'develop'],
  'testing': ['测试', '验证', 'test', 'verify', 'validate'],
  'review': ['审查', '审核', 'review', 'inspect', 'audit'],
  'deployment': ['部署', '上线', 'deploy', 'release', 'ship'],
  'documentation': ['文档', '说明', 'document', 'describe'],
  'security': ['安全', '漏洞', 'security', 'vulnerability'],
  'debugging': ['调试', '修复', 'debug', 'fix', 'troubleshoot'],
  'architecture': ['架构', '模块', 'architecture', 'module', 'structure'],
  'statistics': ['统计', '数据', '图表', 'statistics', 'data', 'chart', 'visualization'],
  'prioritization': ['优先级', '产品', '需求', 'prioritize', 'product', 'requirement'],
  'design': ['设计', '交互', '原型', 'ux', 'ui', 'wireframe', 'usability'],
  'optimization': ['优化', 'seo', '排名', 'optimize', 'seo', 'ranking'],
  'strategy': ['策略', '营销', '增长', 'strategy', 'marketing', 'growth'],
  'research': ['调研', '文献', '趋势', 'research', 'literature', 'trend'],
};

/**
 * @module runtime/agent/multi-agent-router
 * @classdesc 多Agent路由器（MultiAgentRouter）。负载均衡、亲和性调度、故障转移，
 * 支持基于能力的亲和度评分、学习型亲和度更新、负载调整选择和协作模式推荐。
 *
 * MultiAgentRouter — Task-to-agent routing engine with capability affinity and load awareness
 * Matches tasks to agents via strength-based affinity scoring, learned affinity updates, and
 * load-adjusted selection. Suggests collaboration modes (solo, hierarchical, pipeline, parallel,
 * generator-verifier) and selects model tiers based on agent capabilities and task complexity.
 * @extends EventEmitter
 * @emits routed | agent-registered | agent-unregistered
 */
class MultiAgentRouter extends EventEmitter {
  /**
   * 创建MultiAgentRouter实例并初始化路由配置。
   * @param {Object} [options] - 路由配置选项
   * @param {number} [options.topK=2] - 路由返回的Top-K Agent数量
   * @param {number} [options.minAffinity=0.3] - 最低亲和度阈值
   * @param {number} [options.maxHistory=500] - 路由历史记录上限
   */
  constructor(options) {
    super();
    this._topK = (options && options.topK) ?? DEFAULT_TOP_K;
    this._minAffinity = (options && options.minAffinity) ?? DEFAULT_MIN_AFFINITY;
    this._agentAffinities = new Map();
    this._maxHistory = (options && options.maxHistory) ?? 500;
    this._routingHistory = new BoundedArray(1000);
    this._agentLoad = new Map();
    this._dynamicCapabilities = new Map();
    this._agentStrengths = _cloneStrengthSets();
  }

  /**
   * 注册动态Agent及其能力定义。
   * @param {string} agentId - Agent标识
   * @param {Object} capabilities - 能力定义
   * @param {string[]} capabilities.strengths - 能力标签数组
   * @param {string} [capabilities.scope='task'] - 作用域
   * @param {string} [capabilities.tier='worker'] - 层级（ceo/specialist/worker）
   * @param {string} [capabilities.modelTier='medium'] - 模型层级
   * @returns {boolean} 是否注册成功
   */
  registerAgent(agentId, capabilities) {
    if (!agentId || !capabilities || !Array.isArray(capabilities.strengths)) return false;
    if (this._dynamicCapabilities.size >= MAX_DYNAMIC_CAPABILITIES && !this._dynamicCapabilities.has(agentId)) {
      const oldestKey = this._dynamicCapabilities.keys().next().value;
      this._dynamicCapabilities.delete(oldestKey);
    }
    this._dynamicCapabilities.set(agentId, {
      strengths: capabilities.strengths,
      scope: capabilities.scope ?? 'task',
      tier: capabilities.tier ?? 'worker',
      modelTier: capabilities.modelTier ?? 'medium',
    });
    this._agentStrengths[agentId] = new Set(capabilities.strengths);
    this.emit('agent-registered', { agentId, capabilities });
    return true;
  }

  /**
   * 注销动态Agent，移除其能力定义。
   * @param {string} agentId - Agent标识
   * @returns {boolean} Agent是否存在并被注销
   */
  unregisterAgent(agentId) {
    if (!agentId) return false;
    const existed = this._dynamicCapabilities.delete(agentId);
    if (existed) {
      delete this._agentStrengths[agentId];
      this.emit('agent-unregistered', { agentId });
    }
    return existed;
  }

  /**
   * 获取指定Agent的能力定义。
   * @param {string} agentId - Agent标识
   * @returns {Object|null} 能力定义 {strengths, scope, tier, modelTier}，不存在时返回null
   */
  getCapabilitiesForAgent(agentId) {
    return AGENT_CAPABILITIES[agentId] || (this._dynamicCapabilities.get(agentId) ?? null);
  }

  /**
   * 根据任务和可用Agent推荐协作模式。
   * @param {Object} task - 任务描述对象
   * @param {string[]} [availableAgents] - 可用Agent标识数组
   * @returns {string} 协作模式（solo/hierarchical/pipeline/parallel/generator-verifier）
   */
  suggestCollaborationMode(task, availableAgents) {
    const agents = availableAgents || Object.keys(AGENT_CAPABILITIES);
    const routed = this.route(task, agents);
    const selectedAgents = routed.agents;
    if (selectedAgents.length <= 1) return 'solo';

    const tiers = selectedAgents.map(a => {
      const caps = this.getCapabilitiesForAgent(a.agentId);
      return caps ? caps.tier : 'worker';
    });
    const hasCeo = tiers.includes('ceo');
    const hasSpecialist = tiers.includes('specialist');
    const hasWorker = tiers.includes('worker');

    if (hasCeo && (hasSpecialist || hasWorker)) return 'hierarchical';
    if (hasSpecialist && hasWorker) return 'pipeline';
    if (selectedAgents.length >= 3) return 'parallel';

    const taskTypes = routed.taskTypes;
    if (taskTypes.includes('review') || taskTypes.includes('security')) return 'generator-verifier';
    return 'pipeline';
  }

  /**
   * 根据Agent能力和任务复杂度选择模型层级。
   * @param {string} agentId - Agent标识
   * @param {number} [taskComplexity=0.5] - 任务复杂度（0-1）
   * @returns {string} 模型层级（high/medium/low/default）
   */
  selectModelForTask(agentId, taskComplexity) {
    const caps = this.getCapabilitiesForAgent(agentId);
    if (!caps) return 'default';
    const modelTier = caps.modelTier ?? 'medium';
    const complexity = typeof taskComplexity === 'number' && Number.isFinite(taskComplexity) ? taskComplexity : 0.5;
    if (modelTier === 'high' || complexity > 0.8) return 'high';
    if (modelTier === 'medium' && complexity > 0.5) return 'medium';
    if (modelTier === 'low' && complexity <= 0.3) return 'low';
    return modelTier;
  }

  /**
   * 记录Agent当前负载，用于路由时的负载均衡调整。
   * @param {string} agentId - Agent标识
   * @param {number} activeTaskCount - 当前活跃任务数
   * @returns {void}
   */
  recordAgentLoad(agentId, activeTaskCount) {
    this.guardShutdown();
    if (!agentId) return;
    if (this._agentLoad.size >= MAX_AGENT_LOAD_ENTRIES && !this._agentLoad.has(agentId)) {
      const oldestKey = this._agentLoad.keys().next().value;
      this._agentLoad.delete(oldestKey);
    }
    this._agentLoad.set(agentId, Math.max(0, typeof activeTaskCount === 'number' && Number.isFinite(activeTaskCount) ? activeTaskCount : 0));
  }

  _getAgentLoad(agentId) {
    return this._agentLoad.get(agentId) ?? 0;
  }

  /**
   * 将任务路由到最合适的Agent，基于亲和度评分和负载均衡选择Top-K。
   * @param {Object} task - 任务描述对象（需包含description/goal/message等字段）
   * @param {string[]} [availableAgents] - 可用Agent标识数组
   * @returns {Object} 路由结果 {agents, affinities, taskTypes, routingId, timestamp}
   */
  route(task, availableAgents) {
    this.guardShutdown();
    if (!task || typeof task !== 'object') {
      return { agents: [], affinities: {}, taskTypes: [] };
    }

    const agents = availableAgents || Object.keys(AGENT_CAPABILITIES);
    const taskTypes = this._identifyTaskTypes(task);
    const affinities = this._computeAffinities(taskTypes, agents);

    const sorted = Object.entries(affinities)
      .filter(([, score]) => score >= this._minAffinity)
      .sort((a, b) => {
        const loadA = this._getAgentLoad(a[0]);
        const loadB = this._getAgentLoad(b[0]);
        const scoreA = a[1] * (1 / (1 + loadA));
        const scoreB = b[1] * (1 / (1 + loadB));
        return scoreB - scoreA;
      });

    const topAgents = sorted.slice(0, this._topK).map(([agentId, score]) => ({
      agentId,
      score,
      capabilities: AGENT_CAPABILITIES[agentId] ?? { strengths: [], scope: 'unknown' },
    }));

    const routing = {
      agents: topAgents,
      affinities,
      taskTypes,
      routingId: generateId('mar-'),
      timestamp: new Date().toISOString(),
    };

    this._routingHistory.push(routing);
    this.emit('routed', routing);
    return routing;
  }

  /**
   * 更新Agent对特定任务类型的学习亲和度。
   * @param {string} agentId - Agent标识
   * @param {string} taskType - 任务类型
   * @param {number} delta - 亲和度变化量
   * @returns {void}
   */
  updateAffinity(agentId, taskType, delta) {
    this.guardShutdown();
    if (!agentId || !taskType) return;
    if (this._agentAffinities.size >= 200) {
      const oldestKey = this._agentAffinities.keys().next().value;
      this._agentAffinities.delete(oldestKey);
    }
    const safeDelta = typeof delta === 'number' && Number.isFinite(delta) ? delta : 0;
    if (!this._agentAffinities.has(agentId)) {
      this._agentAffinities.set(agentId, {});
    }
    const affinities = this._agentAffinities.get(agentId);
    affinities[taskType] = clamp01((affinities[taskType] ?? 0.5) + safeDelta);
  }

  /**
   * 获取Agent对特定任务类型的学习亲和度。
   * @param {string} agentId - Agent标识
   * @param {string} taskType - 任务类型
   * @returns {number} 亲和度值（0-1），默认0.5
   */
  getAffinity(agentId, taskType) {
    const affinities = this._agentAffinities.get(agentId);
    if (!affinities) return 0.5;
    return affinities[taskType] ?? 0.5;
  }

  _identifyTaskTypes(task) {
    const description = this._extractDescription(task);
    const types = [];

    for (const [type, signals] of Object.entries(TASK_TYPE_SIGNALS)) {
      for (const signal of signals) {
        if (description.includes(signal.toLowerCase())) {
          types.push(type);
          break;
        }
      }
    }

    if (types.length === 0) {
      types.push('implementation');
    }

    return types;
  }

  _computeAffinities(taskTypes, agents) {
    const affinities = {};

    for (const agentId of agents) {
      const capabilities = AGENT_CAPABILITIES[agentId] || this._dynamicCapabilities.get(agentId);
      if (!capabilities) {
        affinities[agentId] = 0.1;
        continue;
      }

      const strengthSet = this._agentStrengths[agentId];
      let baseScore = 0;
      for (const type of taskTypes) {
        if (strengthSet && strengthSet.has(type)) {
          baseScore += 0.3;
        }
      }

      baseScore = Math.min(baseScore, 1.0);

      const learnedAffinity = this._agentAffinities.get(agentId);
      if (learnedAffinity) {
        let learnedBonus = 0;
        for (const type of taskTypes) {
          if (learnedAffinity[type] !== undefined) {
            learnedBonus += (learnedAffinity[type] - 0.5) * 0.2;
          }
        }
        baseScore = clamp01(baseScore + learnedBonus);
      }

      affinities[agentId] = baseScore;
    }

    return affinities;
  }

  _extractDescription(task) {
    const parts = [];
    if (task.description) parts.push(task.description);
    if (task.goal) parts.push(task.goal);
    if (task.message) parts.push(task.message);
    if (task.userMessage) parts.push(task.userMessage);
    return parts.join(' ').toLowerCase();
  }

  /**
   * 获取路由历史记录。
   * @param {number} [limit] - 返回记录数上限，默认为全部
   * @returns {Object[]} 路由历史数组
   */
  getRoutingHistory(limit) {
    const n = limit ?? this._routingHistory.length;
    return this._routingHistory.toArray().slice(-n);
  }

  /**
   * 获取路由器的统计信息。
   * @returns {Object} 统计数据 {totalRoutings, topK, minAffinity, knownAgents, dynamicAgents, learnedAffinities}
   */
  getStats() {
    return {
      totalRoutings: this._routingHistory.length,
      topK: this._topK,
      minAffinity: this._minAffinity,
      knownAgents: Object.keys(AGENT_CAPABILITIES).length,
      dynamicAgents: this._dynamicCapabilities.size,
      learnedAffinities: this._agentAffinities.size,
    };
  }

  _onShutdown() {
    this._agentAffinities.clear();
    safeCall(() => this._routingHistory.shutdown(), 'MultiAgentRouter', 'shutdown-routingHistory');
    this._dynamicCapabilities.clear();
    this._agentLoad.clear();
    this._agentStrengths = {};
    this.removeAllListeners();
  }
}

MultiAgentRouter.DEFAULT_TOP_K = DEFAULT_TOP_K;
MultiAgentRouter.DEFAULT_MIN_AFFINITY = DEFAULT_MIN_AFFINITY;
MultiAgentRouter.AGENT_CAPABILITIES = AGENT_CAPABILITIES;
MultiAgentRouter.TASK_TYPE_SIGNALS = TASK_TYPE_SIGNALS;
MultiAgentRouter.AGENT_TIERS = { CEO: 'ceo', SPECIALIST: 'specialist', WORKER: 'worker' };
MultiAgentRouter.MODEL_TIERS = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

module.exports = withShutdown(MultiAgentRouter);
