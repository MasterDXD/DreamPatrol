'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { errorMessage, safeCall } = require('../../utils/safe-execute');
const { MS_PER_HOUR, DEFAULT_PIPELINE_TIMEOUT_MS } = require('../../utils/constants');
const { mergeConfig } = require('../../utils/safe-assign');

const MAX_MODE_OVERRIDES = 100;

const MODE_SCORING_WEIGHTS = {
  COMPLEXITY_HIGH: 0.2,
  MULTI_AGENT_BONUS: 0.3,
  DEEPENING_BONUS: 0.15,
  SINGLE_AGENT_PENALTY: -0.2,
  HISTORY_BONUS: 0.1,
  DEEPENING_HISTORY_BONUS: 0.15,
};

const COLLABORATION_MODES = {
  SOLO: 'solo',
  GENERATOR_VERIFIER: 'generator-verifier',
  ORCHESTRATOR_SUBAGENT: 'orchestrator-subagent',
  AGENT_TEAMS: 'agent-teams',
  MESSAGE_BUS: 'message-bus',
  SHARED_STATE: 'shared-state',
};
const COLLABORATION_MODES_SET = new Set(Object.values(COLLABORATION_MODES));

const MODE_SELECTION_RULES = [
  {
    mode: COLLABORATION_MODES.GENERATOR_VERIFIER,
    signals: ['审查', '验证', '校验', 'review', 'verify', 'validate', 'audit', '质量'],
    taskTraits: ['quality_critical', 'needs_independent_verification'],
    minAgents: 2,
    maxAgents: 3,
    description: '生成-验证者模式：一个Agent生成输出，另一个独立验证',
    bestFor: '质量优先场景：代码审查、报告撰写、数据校验',
  },
  {
    mode: COLLABORATION_MODES.ORCHESTRATOR_SUBAGENT,
    signals: ['拆解', '并行', '分配', 'decompose', 'parallel', 'dispatch', '子任务'],
    taskTraits: ['decomposable', 'parallelizable', 'research'],
    minAgents: 3,
    maxAgents: 5,
    description: '调度-子智能体模式：Lead Agent分解任务，Subagents并行执行',
    bestFor: '任务可拆解场景：多模块并行开发、大规模研究',
  },
  {
    mode: COLLABORATION_MODES.AGENT_TEAMS,
    signals: ['协调', '沟通', '团队', 'coordinate', 'team', 'collaborate', '重构'],
    taskTraits: ['coordination_heavy', 'cross_cutting', 'refactoring'],
    minAgents: 3,
    maxAgents: 5,
    description: '智能体团队模式：Agent间直接通信，维护持久状态',
    bestFor: '成员需沟通场景：复杂重构、跨模块协调',
  },
  {
    mode: COLLABORATION_MODES.MESSAGE_BUS,
    signals: ['事件', '订阅', '通知', 'event', 'subscribe', 'notify', '异步'],
    taskTraits: ['event_driven', 'extensible', 'dynamic'],
    minAgents: 2,
    maxAgents: 10,
    description: '消息总线模式：Agent通过共享消息总线通信',
    bestFor: '事件驱动扩展场景：微服务编排、动态能力接入',
  },
  {
    mode: COLLABORATION_MODES.SHARED_STATE,
    signals: ['同步', '共享', '实时', 'sync', 'shared', 'realtime', '协作'],
    taskTraits: ['realtime_sync', 'multi_source', 'shared_data'],
    minAgents: 2,
    maxAgents: 8,
    description: '共享状态模式：多Agent通过共享存储实时协作',
    bestFor: '多源实时协作场景：实时文档编辑、多数据源同步',
  },
];

/**
 * @module runtime/collaboration/collaboration-mode-router
 * @classdesc 协作模式路由。solo/generator-verifier/orchestrator-subagent/agent-teams/message-bus/shared-state六种模式
 * 协作模式路由。solo/pair/chain/ensemble/deepening五种模式，
 * 根据任务复杂度和Agent配置自动选择最优协作模式。
 *
 * @extends EventEmitter
 *
 * @fires CollaborationModeRouter#mode-selected
 * @fires CollaborationModeRouter#mode-overridden
 * @fires CollaborationModeRouter#mode-degraded
 * @fires CollaborationModeRouter#execution-error
 * @fires CollaborationModeRouter#team-proposal-failed
 */
class CollaborationModeRouter extends EventEmitter {
  /**
   * 创建 CollaborationModeRouter 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.diversityThreshold] - 多样性阈值
   * @param {number} [options.maxAgents] - 最大Agent数量
   * @param {number} [options.maxHistory=200] - 历史记录最大条数
   * @param {Array} [options.customRules] - 自定义模式选择规则
   */
  constructor(options) {
    super();
    this.on('error', (err) => {
      debug('CollaborationModeRouter', 'unhandledError', err);
    });
    this._rules = (options && options.customRules) || MODE_SELECTION_RULES;
    this._ruleTraitSets = this._rules.map(r => new Set(r.taskTraits ?? []));
    this._history = new BoundedArray((options && options.maxHistory) ?? 200);
    this._maxHistory = this._history.maxSize;
    this._modeOverrides = new Map();
    this._overrideTTL = MS_PER_HOUR;
    this._subagentExecutor = null;
    this._agentChannel = null;
    this._cleanupTimer = null;
  }

  /**
   * 多Agent适用性门禁判断。根据任务特征评估是否应使用多Agent协作。
   * 实现Multi-Agent决策指南中的适用性门禁规则（3反模式+5正向信号+阈值推荐）。
   * @param {Object} context - 任务上下文
   * @param {string} context.task - 任务描述
   * @param {string} [context.faultTolerance] - 容错级别 ('zero'|'low'|'medium'|'high')
   * @param {boolean} [context.hasHumanOversight] - 是否有人类监督
   * @param {string[]} [context.traits] - 任务特征标签
   * @param {string} [context.latencyRequirement] - 延迟要求
   * @returns {{ shouldUse: boolean, severity?: string, reason?: string }} 判断结果
   */
  shouldUseMultiAgent(context) {
    this.guardShutdown();
    if (!context || typeof context !== 'object' || !context.task) {
      return { shouldUse: false, reason: 'invalid_context', severity: 'medium' };
    }

    const task = String(context.task);
    const traits = new Set(context.traits ?? []);

    if (context.latencyRequirement === 'realtime') {
      return { shouldUse: false, reason: 'realtime_anti_pattern', severity: 'critical' };
    }

    if (context.faultTolerance === 'zero' && !context.hasHumanOversight) {
      return { shouldUse: false, severity: 'critical', reason: 'zero_fault_tolerance_no_oversight' };
    }

    const signalCount = this._countPositiveSignals(task, traits);
    if (signalCount >= 2 || traits.has('quality_critical')) {
      return { shouldUse: true, reason: 'positive_signals_met', signalCount };
    }

    if (this._isDeterministicTask(task, traits)) {
      return { shouldUse: false, reason: 'deterministic_task', severity: 'low' };
    }

    if (traits.size === 0 && task.length < 20 && !/[,，；;、]/.test(task)) {
      return { shouldUse: false, reason: 'insufficient_complexity', severity: 'low' };
    }

    return { shouldUse: false, reason: 'insufficient_signals', signalCount, severity: 'low' };
  }

  _countPositiveSignals(task, traits) {
    const POSITIVE_SIGNALS = ['decomposable', 'multi_role', 'quality_critical', 'parallelizable',
      'requires_validation', 'creative', 'ambiguous_requirements', 'exploratory'];
    let signalCount = 0;
    for (const sig of POSITIVE_SIGNALS) {
      if (traits.has(sig)) signalCount++;
    }
    if (task.length > 50) signalCount++;
    if (/[,，]/.test(task)) signalCount++;
    return signalCount;
  }

  _isDeterministicTask(task, traits) {
    if (task.length < 8) return true;
    if (/^[A-Za-z\u4e00-\u9fa5\s]+$/.test(task) && !traits.has('decomposable') && !/[,，；;、]/.test(task)) return true;
    return false;
  }

  /**
   * 附加子Agent执行器，用于调度-子智能体模式和生成-验证者模式的任务执行
   * @param {object} executor - 子Agent执行器实例，须实现 spawn 方法
   * @returns {CollaborationModeRouter} 当前实例，支持链式调用
   */
  attachSubagentExecutor(executor) {
    this.guardShutdown();
    if (executor && typeof executor.spawn === 'function') {
      this._subagentExecutor = executor;
    }
    return this;
  }

  /**
   * 附加Agent通信通道，用于智能体团队模式、消息总线模式和共享状态模式的通信
   * @param {object} channel - Agent通信通道实例，须实现 send 方法
   * @returns {CollaborationModeRouter} 当前实例，支持链式调用
   */
  attachAgentChannel(channel) {
    this.guardShutdown();
    if (channel && typeof channel.send === 'function') {
      this._agentChannel = channel;
    }
    return this;
  }

  /**
   * 根据任务上下文自动选择最优协作模式
   * 综合任务描述信号、任务特征和可用Agent数量对每种模式评分，选择得分最高的模式。
   * 若存在手动覆盖且未过期，则直接返回覆盖模式。
   * @param {object} context - 任务上下文
   * @param {string} [context.taskDescription] - 任务描述文本
   * @param {string} [context.userMessage] - 用户消息
   * @param {string} [context.goal] - 任务目标
   * @param {string[]} [context.taskTraits] - 任务特征标签列表
   * @param {number} [context.availableAgents=3] - 可用Agent数量
   * @param {string} [context.sessionId] - 会话ID，用于查找手动覆盖
   * @returns {{ mode: string, confidence: number, reasoning: string, allScores: object, taskTraits: string[], availableAgents: number, overridden?: boolean }} 模式选择结果
   */
  selectMode(context) {
    this.guardShutdown();
    if (!context || typeof context !== 'object') {
      return {
        mode: COLLABORATION_MODES.ORCHESTRATOR_SUBAGENT,
        confidence: 0,
        reasoning: 'Default mode for invalid context',
      };
    }

    const override = this._modeOverrides.get(context.sessionId);
    if (override) {
      if (Date.now() - override.setAt > this._overrideTTL) {
        this._modeOverrides.delete(context.sessionId);
      } else {
        return {
          mode: override.mode,
          confidence: 1.0,
          reasoning: 'Manual mode override',
          overridden: true,
        };
      }
    }

    const taskDescription = this._extractDescription(context);
    const taskTraits = context.taskTraits ?? this._inferTraits(taskDescription);
    const availableAgents = context.availableAgents ?? 3;

    const scores = {};
    for (let ri = 0; ri < this._rules.length; ri++) {
      const rule = this._rules[ri];
      const traitSet = this._ruleTraitSets[ri];
      let score = 0;

      for (const signal of rule.signals) {
        if (taskDescription.toLowerCase().includes(signal.toLowerCase())) {
          score += MODE_SCORING_WEIGHTS.COMPLEXITY_HIGH;
        }
      }

      for (const trait of taskTraits) {
        if (traitSet.has(trait)) {
          score += MODE_SCORING_WEIGHTS.MULTI_AGENT_BONUS;
        }
      }

      if (availableAgents >= rule.minAgents && availableAgents <= rule.maxAgents) {
        score += MODE_SCORING_WEIGHTS.DEEPENING_BONUS;
      } else if (availableAgents < rule.minAgents) {
        score += MODE_SCORING_WEIGHTS.SINGLE_AGENT_PENALTY;
      }

      scores[rule.mode] = Math.min(score, 1.0);
    }

    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const bestMode = sorted[0] ? sorted[0][0] : COLLABORATION_MODES.ORCHESTRATOR_SUBAGENT;
    const bestScore = sorted[0] ? sorted[0][1] : 0;

    const result = {
      mode: bestMode,
      confidence: bestScore,
      reasoning: this._buildReasoning(bestMode, bestScore, taskTraits, availableAgents),
      allScores: scores,
      taskTraits,
      availableAgents,
    };

    this._history.push({
      mode: bestMode,
      confidence: bestScore,
      taskTraits,
      timestamp: Date.now(),
    });

    this.emit('mode-selected', result);
    return result;
  }

  /**
   * 手动覆盖指定会话的协作模式，覆盖在TTL过期后自动失效
   * @param {string} sessionId - 会话ID
   * @param {string} mode - 目标协作模式，须为合法模式值
   * @returns {boolean} 覆盖是否成功设置
   */
  overrideMode(sessionId, mode) {
    this.guardShutdown();
    if (!sessionId || typeof sessionId !== 'string') return false;
    if (!COLLABORATION_MODES_SET.has(mode)) return false;
    if (this._modeOverrides.size >= MAX_MODE_OVERRIDES) {
      const oldest = this._modeOverrides.keys().next().value;
      this._modeOverrides.delete(oldest);
    }
    this._modeOverrides.set(sessionId, { mode: mode, setAt: Date.now() });
    this._ensureCleanupTimer();
    this.emit('mode-overridden', { sessionId, mode });
    return true;
  }

  /**
   * 清除指定会话的协作模式手动覆盖
   * @param {string} sessionId - 会话ID
   * @returns {boolean} 覆盖是否存在且已被成功删除
   */
  clearOverride(sessionId) {
    this.guardShutdown();
    return this._modeOverrides.delete(sessionId);
  }

  /**
   * 根据自动选择的协作模式执行任务，若所需执行器未附加则降级为solo模式
   * @param {object} task - 任务对象
   * @param {string} [task.description] - 任务描述
   * @param {string} [task.goal] - 任务目标
   * @param {string[]} [task.traits] - 任务特征标签
   * @param {number} [task.availableAgents] - 可用Agent数量
   * @param {Function} executeFn - 任务执行函数，接收task作为参数
   * @param {Function} [verifyFn] - 验证函数，用于生成-验证者模式的结果校验
   * @returns {Promise<object>} 执行结果，包含 mode、result/errors、modeResult 等字段
   */
  async executeWithMode(task, executeFn, verifyFn) {
    this.guardShutdown();
    try {
      const modeResult = this.selectMode({
        taskDescription: task.description || task.goal || '',
        taskTraits: task.traits ?? [],
        availableAgents: task.availableAgents ?? 3,
      });

      if (this._shutDown) { this.guardShutdown(); }

      const mode = modeResult.mode;

      if (mode === COLLABORATION_MODES.ORCHESTRATOR_SUBAGENT && this._subagentExecutor) {
        return this._executeOrchestratorSubagent(task, executeFn, verifyFn);
      }

      if (mode === COLLABORATION_MODES.GENERATOR_VERIFIER && this._subagentExecutor) {
        return this._executeGeneratorVerifier(task, executeFn, verifyFn);
      }

      if (mode === COLLABORATION_MODES.AGENT_TEAMS && this._agentChannel) {
        return this._executeAgentTeams(task, executeFn);
      }

      if (mode === COLLABORATION_MODES.MESSAGE_BUS && this._agentChannel) {
        return this._executeMessageBus(task, executeFn);
      }

      if (mode === COLLABORATION_MODES.SHARED_STATE && this._agentChannel) {
        return this._executeSharedState(task, executeFn);
      }

      if (mode !== COLLABORATION_MODES.SOLO) {
        this.emit('mode-degraded', { requestedMode: mode, fallbackMode: 'solo', reason: 'Required executor not attached' });
      }
      return { mode, result: executeFn ? await Promise.resolve(executeFn(task)) : null, modeResult, degraded: mode !== COLLABORATION_MODES.SOLO };
    } catch (err) {
      const errMsg = errorMessage(err);
      this.emit('execution-error', { mode: 'unknown', error: errMsg, degraded: true });
      return { mode: 'solo', result: null, error: errMsg, degraded: true };
    }
  }

  async _executeOrchestratorSubagent(task, executeFn, _verifyFn) {
    if (!this._subagentExecutor) return { mode: 'orchestrator-subagent', result: null, error: 'No SubagentExecutor' };

    try {
      const subtasks = task.subtasks || [task];
      const agentConfigs = task.agentConfigs ?? null;
      const { results, errors } = await this._subagentExecutor.executeParallel(subtasks, agentConfigs, executeFn);
      if (this._shutDown) { this.guardShutdown(); }

      return {
        mode: 'orchestrator-subagent',
        results,
        errors,
        totalResults: results.length,
        totalErrors: errors.length,
      };
    } catch (err) {
      const errMsg = errorMessage(err);
      this.emit('execution-error', { mode: 'orchestrator-subagent', error: errMsg });
      return { mode: 'orchestrator-subagent', result: null, error: errMsg };
    }
  }

  async _executeGeneratorVerifier(task, executeFn, verifyFn) {
    if (!this._subagentExecutor) return { mode: 'generator-verifier', result: null, error: 'No SubagentExecutor' };

    try {
      const result = await this._subagentExecutor.executeWithVerification(
        task, null, executeFn, verifyFn,
      );
      if (this._shutDown) { this.guardShutdown(); }

      return {
        mode: 'generator-verifier',
        success: result && result.success,
        result: result && result.result,
        iteration: result && result.iteration,
        verifyResult: result && result.verifyResult,
      };
    } catch (err) {
      return { mode: 'generator-verifier', result: null, error: err && err.message ? err.message : String(err) };
    }
  }

  async _executeAgentTeams(task, executeFn) {
    if (!this._agentChannel) return { mode: 'agent-teams', result: null, error: 'No AgentChannel' };

    const agents = task.agents || ['task-worker', 'domain-analyst'];
    let proposalId = null;
    try {
      proposalId = this._agentChannel.propose('coordinator', task.description ?? 'task', agents);
    } catch (err) {
      debug('CollaborationModeRouter', 'proposeError', err);
    }

    if (!proposalId) {
      this.emit('team-proposal-failed', { task: task.id, reason: 'proposal-creation-failed' });
      return { success: false, mode: 'team', error: 'Failed to create team proposal', degraded: true };
    }

    const promises = agents.map(agent => {
      return (async () => {
        const result = executeFn ? await Promise.resolve(executeFn(mergeConfig(task, { _agentId: agent }))) : null;
        return { agent, result };
      })().catch(err => { debug('CollaborationModeRouter', 'route', err && err.message ? err.message : String(err)); return { agent, error: err && err.message ? err.message : String(err) }; });
    });
    const results = await Promise.allSettled(promises);
    if (this._shutDown) { this.guardShutdown(); }
    const settled = results.map(r => r.status === 'fulfilled' ? r.value : { agent: 'unknown', error: String(r.reason) });

    if (proposalId) {
      try {
        for (let i = 0; i < agents.length; i++) {
          const settledResult = settled[i];
          const vote = settledResult && !settledResult.error ? 'approve' : 'reject';
          this._agentChannel.vote(proposalId, agents[i], vote);
        }
        this._agentChannel.closeProposal(proposalId);
      } catch (err) {
        debug('CollaborationModeRouter', 'channelVoteError', err);
      }
    }

    return {
      mode: 'agent-teams',
      results: settled,
      proposalId,
      agentCount: agents.length,
    };
  }

  async _executeMessageBus(task, executeFn) {
    if (!this._agentChannel) return { mode: 'message-bus', result: null, error: 'No AgentChannel' };

    try {
      const agents = task.agents || ['team-lead', 'task-worker'];
      const coordinator = agents[0] ?? 'coordinator';

      try {
        this._agentChannel.broadcast(coordinator, {
          type: 'task-assignment',
          task: (task.description || task.goal) ?? 'task',
          agents,
        });
      } catch (broadcastErr) {
        debug('CollaborationModeRouter', '_executeMessageBus', 'broadcast failed: ' + (broadcastErr && broadcastErr.message ? broadcastErr.message : String(broadcastErr)));
      }

      const promises = agents.map(agent => {
        return (async () => {
          const result = executeFn ? await Promise.resolve(executeFn(mergeConfig(task, { _agentId: agent }))) : null;
          try {
            this._agentChannel.send(agent, coordinator, { type: 'task-result', result });
          } catch (sendErr) {
            debug('CollaborationModeRouter', '_executeMessageBus', 'send result failed: ' + (sendErr && sendErr.message ? sendErr.message : String(sendErr)));
          }
          return { agent, result };
        })().catch(err => {
          const errMsg = err && err.message ? err.message : String(err);
          debug('CollaborationModeRouter', 'route', errMsg);
          try {
            this._agentChannel.send(agent, coordinator, { type: 'task-error', error: errMsg });
          } catch (sendErr) {
            debug('CollaborationModeRouter', '_executeMessageBus', 'send error failed: ' + (sendErr && sendErr.message ? sendErr.message : String(sendErr)));
          }
          return { agent, error: errMsg };
        });
      });
      const results = await Promise.allSettled(promises);
      if (this._shutDown) { this.guardShutdown(); }
      const settled = results.map(r => r.status === 'fulfilled' ? r.value : { agent: 'unknown', error: String(r.reason) });

      return {
        mode: 'message-bus',
        results: settled,
        agentCount: agents.length,
        messagesExchanged: settled.length,
      };
    } catch (err) {
      const errMsg = errorMessage(err);
      this.emit('execution-error', { mode: 'message-bus', error: errMsg });
      return { mode: 'message-bus', result: null, error: errMsg };
    }
  }

  async _executeSharedState(task, executeFn) {
    if (!this._agentChannel) return { mode: 'shared-state', result: null, error: 'No AgentChannel' };

    try {
      const agents = task.agents || ['task-worker', 'domain-analyst'];
      const sharedKey = 'task:' + (task.id ?? Date.now());

      try {
        this._agentChannel.setShared(sharedKey, {
          task: task.description || (task.goal ?? 'task'),
          status: 'in-progress',
          agents,
        }, agents[0] ?? 'coordinator');
      } catch (sharedErr) {
        debug('CollaborationModeRouter', '_executeSharedState', 'setShared in-progress failed: ' + (sharedErr && sharedErr.message ? sharedErr.message : String(sharedErr)));
      }

      const promises = agents.map(agent => {
        return (async () => {
          const rawResult = executeFn ? await Promise.resolve(executeFn(mergeConfig(task, { _agentId: agent, _sharedKey: sharedKey }))) : null;
          const result = rawResult !== undefined ? rawResult : null;
          const resultKey = sharedKey + ':' + agent + ':result';
          try {
            const setRes = this._agentChannel.setSharedWithVersion
              ? await this._agentChannel.setSharedWithVersion(resultKey, result, agent)
              : await this._agentChannel.setShared(resultKey, result, agent);
            if (setRes && !setRes.success) {
              debug('CollaborationModeRouter', '_executeSharedState', 'Conflict writing result for ' + agent + ': ' + (setRes.reason ?? 'unknown'));
            }
          } catch (setErr) {
            debug('CollaborationModeRouter', '_executeSharedState', 'setShared result failed: ' + (setErr && setErr.message ? setErr.message : String(setErr)));
          }
          return { agent, result };
        })().catch(err => { debug('CollaborationModeRouter', 'route', err && err.message ? err.message : String(err)); return { agent, error: err && err.message ? err.message : String(err) }; });
      });
      const results = await Promise.allSettled(promises);
      if (this._shutDown) { this.guardShutdown(); }
      const settled = results.map(r => r.status === 'fulfilled' ? r.value : { agent: 'unknown', error: String(r.reason) });

      try {
        this._agentChannel.setShared(sharedKey, {
          task: (task.description || task.goal) ?? 'task',
          status: 'completed',
          agents,
          resultCount: settled.length,
        }, agents[0] ?? 'coordinator');
      } catch (sharedErr) {
        debug('CollaborationModeRouter', '_executeSharedState', 'setShared completed failed: ' + (sharedErr && sharedErr.message ? sharedErr.message : String(sharedErr)));
      }

      return {
        mode: 'shared-state',
        results: settled,
        sharedKey,
        agentCount: agents.length,
        sharedKeysUsed: 1,
      };
    } catch (err) {
      const errMsg = errorMessage(err);
      this.emit('execution-error', { mode: 'shared-state', error: errMsg });
      return { mode: 'shared-state', result: null, error: errMsg };
    }
  }

  /**
   * 获取指定协作模式的配置信息
   * @param {string} mode - 协作模式名称
   * @returns {{ mode: string, description: string, bestFor: string, minAgents: number, maxAgents: number, signals: string[], taskTraits: string[] } | null} 模式配置，模式不存在时返回null
   */
  getModeConfig(mode) {
    this.guardShutdown();
    const rule = this._rules.find(r => r.mode === mode);
    if (!rule) return null;
    return {
      mode: rule.mode,
      description: rule.description,
      bestFor: rule.bestFor,
      minAgents: rule.minAgents,
      maxAgents: rule.maxAgents,
      signals: rule.signals.slice(),
      taskTraits: rule.taskTraits.slice(),
    };
  }

  /**
   * 获取所有可用协作模式的摘要列表
   * @returns {Array<{ mode: string, description: string, bestFor: string, minAgents: number, maxAgents: number }>} 模式摘要数组
   */
  getAllModes() {
    this.guardShutdown();
    return this._rules.map(r => ({
      mode: r.mode,
      description: r.description,
      bestFor: r.bestFor,
      minAgents: r.minAgents,
      maxAgents: r.maxAgents,
    }));
  }

  /**
   * 获取模式选择历史记录
   * @param {number} [limit=10] - 返回记录的最大条数
   * @returns {Array<{ mode: string, confidence: number, taskTraits: string[], timestamp: number }>} 最近的模式选择记录
   */
  getHistory(limit) {
    try { this.guardShutdown(); } catch (_e) { debug('CollaborationModeRouter', 'getHistory:guardShutdown', _e && _e.message ? _e.message : String(_e)); return []; }
    const n = limit ?? 10; return n > 0 ? this._history.slice(-n) : [];
  }

  /**
   * 获取路由器运行统计信息
   * @returns {{ totalSelections: number, modeCounts: object, activeOverrides: number, availableModes: number }} 统计数据
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('CollaborationModeRouter', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalSelections: 0, modeCounts: {}, activeOverrides: 0, availableModes: 0 }; }
    const modeCounts = {};
    for (const entry of this._history) {
      modeCounts[entry.mode] = (modeCounts[entry.mode] ?? 0) + 1;
    }
    return {
      totalSelections: this._history.length,
      modeCounts,
      activeOverrides: this._modeOverrides.size,
      availableModes: this._rules.length,
    };
  }

  _extractDescription(context) {
    const parts = [];
    if (context.taskDescription) parts.push(context.taskDescription);
    if (context.userMessage) parts.push(context.userMessage);
    if (context.goal) parts.push(context.goal);
    return parts.join(' ').toLowerCase();
  }

  _inferTraits(description) {
    const traits = [];
    const descLower = description.toLowerCase();

    if (/审查|验证|校验|review|verify|audit/.test(descLower)) traits.push('quality_critical');
    if (/拆解|并行|子任务|decompose|parallel|dispatch/.test(descLower)) traits.push('decomposable');
    if (/研究|调研|research|investigate/.test(descLower)) traits.push('research');
    if (/协调|沟通|团队|coordinate|team|collaborate/.test(descLower)) traits.push('coordination_heavy');
    if (/重构|refactor|restructure/.test(descLower)) traits.push('refactoring');
    if (/事件|订阅|event|subscribe|async/.test(descLower)) traits.push('event_driven');
    if (/扩展|插件|extend|plugin|dynamic/.test(descLower)) traits.push('extensible');
    if (/同步|共享|实时|sync|shared|realtime/.test(descLower)) traits.push('realtime_sync');
    if (/多源|multi.?source|aggregate/.test(descLower)) traits.push('multi_source');

    if (traits.length === 0) traits.push('decomposable');
    return traits;
  }

  _buildReasoning(mode, score, traits, agentCount) {
    const rule = this._rules.find(r => r.mode === mode);
    if (!rule) return 'Default selection';

    const lines = [];
    lines.push(`选择 ${mode} 模式 (置信度: ${(score * 100).toFixed(0)}%)`);
    lines.push(`适用场景: ${rule.bestFor}`);
    if (traits.length > 0) lines.push(`匹配特征: ${traits.join(', ')}`);
    lines.push(`Agent数量: ${agentCount} (推荐${rule.minAgents}-${rule.maxAgents})`);
    return lines.join('\n');
  }

  /**
   * 延迟创建过期覆盖清理定时器。仅在首次添加覆盖时启动，
   * 避免构造函数中无条件创建定时器导致资源泄漏。
   * @private
   */
  _ensureCleanupTimer() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      if (this._shutDown) return;
      try {
        const now = Date.now();
        const toDelete = [];
        for (const [key, override] of this._modeOverrides) {
          if (now - override.setAt > this._overrideTTL) {
            toDelete.push(key);
          }
        }
        for (const key of toDelete) {
          this._modeOverrides.delete(key);
        }
      } catch (err) {
        debug('CollaborationModeRouter', 'cleanupTimer', err);
      }
    }, DEFAULT_PIPELINE_TIMEOUT_MS);
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') {
      this._cleanupTimer.unref();
    }
  }

  _onShutdown() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._modeOverrides.clear();
    safeCall(() => this._history.shutdown(), 'CollaborationModeRouter', 'shutdown-history');
    this._subagentExecutor = null;
    this._agentChannel = null;
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
  }
}

CollaborationModeRouter = withShutdown(CollaborationModeRouter);

CollaborationModeRouter.MODES = COLLABORATION_MODES;
CollaborationModeRouter.SELECTION_RULES = MODE_SELECTION_RULES;

module.exports = CollaborationModeRouter;
