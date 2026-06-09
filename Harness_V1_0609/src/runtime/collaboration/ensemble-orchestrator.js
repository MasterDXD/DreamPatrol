'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * @module runtime/collaboration/ensemble-orchestrator
 * @classdesc 集成编排器。Bagging（并行求稳）、Boosting（串行纠错）、Stacking（元学习）三种集成模式
 * EnsembleOrchestrator — 集成编排器
 * 实现三种集成学习模式：Bagging（并行求稳，Bootstrap采样+多数投票融合）、
 * Boosting（串行纠错，迭代关注前轮错误样本）、Stacking（元学习，训练元模型组合基础输出）。
 * 根据任务特征自动选择集成模式，支持早停策略和质量阈值收敛检测。
 *
 * @extends EventEmitter
 */
class EnsembleOrchestrator extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxRounds=5] - 最大迭代轮数
   * @param {number} [options.earlyStopPatience=2] - 早停耐心轮数
   * @param {number} [options.qualityThreshold=0.95] - 质量收敛阈值
   * @param {number} [options.bootstrapRatio=0.7] - Bagging采样比例
   * @param {number} [options.featureSampleRatio=0.7] - 特征采样比例
   * @param {number} [options.learningRate=0.5] - Boosting学习率
   */
  constructor(options) {
    super();
    this._maxRounds = (options ?? {}).maxRounds ?? 5;
    this._earlyStopPatience = (options ?? {}).earlyStopPatience ?? 2;
    this._qualityThreshold = (options ?? {}).qualityThreshold ?? 0.95;
    this._bootstrapRatio = (options ?? {}).bootstrapRatio ?? 0.7;
    this._featureSampleRatio = (options ?? {}).featureSampleRatio ?? 0.7;
    this._learningRate = (options ?? {}).learningRate ?? 0.5;
    this._contributionTracker = null;
    this._boostingHistory = [];
    this._baggingResults = [];
    this._stackingMetaLearner = null;
  }

  /**
   * 设置贡献度追踪器，用于记录各Agent在集成过程中的贡献权重。
   * @param {AgentContributionTracker} tracker - 贡献度追踪器实例
   * @returns {void}
   */
  setContributionTracker(tracker) {
    this.guardShutdown();
    this._contributionTracker = tracker;
  }

  /**
   * 执行集成编排。根据Agent数量和任务特征自动选择集成模式
   *（bagging/boosting/stacking），单Agent时退化为solo模式。
   * @param {Object} task - 待执行的任务对象
   * @param {Array} agents - 参与集成的Agent列表
   * @param {Function} executeFn - Agent执行函数，签名为 async (agent, task) => result
   * @param {Object} [options] - 执行选项
   * @param {string} [options.mode] - 强制指定集成模式（bagging/boosting/stacking）
   * @returns {Promise<{ output: *, confidence: number, mode: string, rounds: number, agentContributions?: Array }>}
   * @throws {Error} 当实例已关闭时抛出异常
   * @throws {Error} When agents array is empty or mode is unsupported
   */
  async execute(task, agents, executeFn, options) {
    this.guardShutdown();
    if (!task || typeof task !== 'object') return { output: null, confidence: 0, mode: 'none', rounds: 0 };
    if (typeof executeFn !== 'function') return { output: null, confidence: 0, mode: 'none', rounds: 0 };
    if (!agents || agents.length === 0) {
      return { output: null, confidence: 0, mode: 'none', rounds: 0 };
    }
    if (agents.length === 1) return this._executeSolo(task, agents[0], executeFn);

    try {
      const mode = (options ?? {}).mode ?? this._selectMode(task, agents);
      switch (mode) {
        case 'bagging': return await this._executeBagging(task, agents, executeFn, options);
        case 'boosting': return await this._executeBoosting(task, agents, executeFn, options);
        case 'stacking': return await this._executeStacking(task, agents, executeFn, options);
        default: return await this._executeBagging(task, agents, executeFn, options);
      }
    } catch (err) {
      debug('EnsembleOrchestrator', 'execute', err && err.message ? err.message : String(err));
      return { output: null, confidence: 0, mode: 'error', rounds: 0, error: err && err.message ? err.message : String(err) };
    }
  }

  async _executeSolo(task, agent, executeFn) {
    let result;
    try {
      result = await executeFn(agent, task);
    } catch (e) {
      debug('EnsembleOrchestrator', 'solo', 'Agent execution failed: ' + (e && e.message ? e.message : String(e)));
      result = { output: null, confidence: 0, error: e && e.message ? e.message : String(e) };
    }
    return { output: result?.output ?? result, confidence: this._sanitizeConfidence(result?.confidence, 0.5), mode: 'solo', rounds: 1, agentContributions: [{ agent, weight: 1.0 }] };
  }

  /**
   * 根据任务类型和Agent数量自动选择集成模式。
   * 选择策略：稳定性/审查/共识类任务选bagging，精确/优化/修复类任务选boosting，
   * Agent数量≥4时选stacking，其余默认bagging。
   * @param {Object} task - 任务对象，通过task.type判断任务类型
   * @param {Array} agents - 参与集成的Agent列表，通过长度判断可用Agent数量
   * @returns {'bagging'|'boosting'|'stacking'} 选定的集成模式
   */
  _selectMode(task, agents) {
    const t = task ?? {};
    if (t.type === 'stability' || t.type === 'review' || t.type === 'consensus') return 'bagging';
    if (t.type === 'precision' || t.type === 'optimize' || t.type === 'fix') return 'boosting';
    if (agents.length >= 4) return 'stacking';
    return 'bagging';
  }

  /**
   * 执行Bagging集成模式。对每个Agent生成Bootstrap采样变体任务后并行执行，
   * 通过多数投票或加权平均融合各Agent输出，适用于追求稳定性和共识的场景。
   * @param {Object} task - 待执行的任务对象
   * @param {Array} agents - 参与集成的Agent列表
   * @param {Function} executeFn - Agent执行函数，签名为 async (agent, task) => result
   * @param {Object} [options] - 执行选项
   * @param {number} [options.maxAgents=10] - 参与执行的最大Agent数量
   * @returns {Promise<{ output: *, confidence: number, mode: 'bagging', rounds: 1, agentContributions: Array, individualResults: Array }>}
   */
  async _executeBagging(task, agents, executeFn, options) {
    this.guardShutdown();
    const maxAgents = Math.min(agents.length, (options ?? {}).maxAgents ?? 10);
    const selectedAgents = agents.slice(0, maxAgents);
    const taskVariants = selectedAgents.map((_, i) => this._bootstrapSample(task, i, selectedAgents.length));

    const promises = selectedAgents.map((agent, i) => executeFn(agent, taskVariants[i]));
    const results = await Promise.allSettled(promises);
    this.guardShutdown();

    const validResults = results.map((r, i) => ({
      agent: selectedAgents[i],
      output: r.status === 'fulfilled' ? r.value?.output ?? r.value : null,
      confidence: r.status === 'fulfilled' ? this._sanitizeConfidence(r.value?.confidence, 0.5) : 0,
      error: r.status === 'rejected' ? r.reason : null,
      taskVariant: taskVariants[i],
    })).filter(r => r.output !== null);

    const fused = this._fuseBagging(validResults);

    if (this._contributionTracker) {
      validResults.forEach(r => {
        try {
          this._contributionTracker.record(r.agent, 'bagging', r.confidence, fused.confidence);
        } catch (err) {
          debug('EnsembleOrchestrator', 'contributionTracker', err && err.message ? err.message : String(err));
        }
      });
    }

    return {
      ...fused,
      mode: 'bagging',
      rounds: 1,
      agentContributions: validResults.length > 0
        ? validResults.map(r => ({ agent: r.agent, weight: 1.0 / validResults.length, confidence: r.confidence }))
        : [],
      individualResults: validResults,
    };
  }

  /**
   * 执行Boosting集成模式。逐轮迭代执行Agent，每轮根据前轮结果调整方面权重，
   * 提取残差上下文指导后续Agent关注薄弱环节，适用于需要逐步纠错和精确优化的场景。
   * @param {Object} task - 待执行的任务对象
   * @param {Array} agents - 参与集成的Agent列表，按轮次轮流使用
   * @param {Function} executeFn - Agent执行函数，签名为 async (agent, task) => result
   * @param {Object} [_options] - 执行选项（当前未使用，预留扩展）
   * @returns {Promise<{ output: *, confidence: number, mode: 'boosting', rounds: number, agentContributions: Array, roundResults: Array, finalAspectWeights: Object }>}
   */
  async _executeBoosting(task, agents, executeFn, _options) {
    this.guardShutdown();
    if (!agents || agents.length === 0) {
      return { output: null, confidence: 0, mode: 'boosting', rounds: 0, agentContributions: [], roundResults: [], finalAspectWeights: {} };
    }
    const maxRounds = this._maxRounds;
    let aspectWeights = this._initAspectWeights(task);
    const agentWeights = new Map();
    const roundResults = [];
    let bestResult = null;
    let noImprovementCount = 0;

    for (let round = 0; round < maxRounds; round++) {
      if (this._shutDown) break;
      const agent = agents[round % agents.length];
      const boostedTask = this._applyAspectWeights(task, aspectWeights);
      const residualContext = round > 0 ? this._extractResidual(roundResults[roundResults.length - 1]) : null;
      const fullTask = residualContext ? { ...boostedTask, _residualFocus: residualContext } : boostedTask;

      let result;
      try {
        result = await executeFn(agent, fullTask);
      } catch (e) {
        debug('EnsembleOrchestrator', 'boosting', 'Agent execution failed: ' + (e && e.message ? e.message : String(e)));
        result = { output: null, confidence: 0, error: e && e.message ? e.message : String(e) };
      }

      const sanitizedConfidence = this._sanitizeConfidence(result?.confidence, 0);
      const errorRate = 1 - sanitizedConfidence;
      const agentWeight = this._computeAgentWeight(errorRate);
      agentWeights.set(round, agentWeight);

      aspectWeights = this._updateAspectWeights(aspectWeights, result, task);

      const roundResult = {
        round,
        agent,
        output: result?.output ?? result,
        confidence: sanitizedConfidence,
        agentWeight,
        aspectWeights: { ...aspectWeights },
        residual: residualContext,
      };
      roundResults.push(roundResult);

      if (!bestResult || sanitizedConfidence > bestResult.confidence) {
        bestResult = roundResult;
        noImprovementCount = 0;
      } else {
        noImprovementCount++;
      }

      if (this._shouldEarlyStop(roundResults, { noImprovementCount })) break;
    }

    const fused = this._fuseBoosting(roundResults, agentWeights);
    this.guardShutdown();

    if (this._contributionTracker) {
      roundResults.forEach(r => {
        try {
          this._contributionTracker.record(r.agent, 'boosting', r.confidence, fused.confidence, r.agentWeight);
        } catch (err) {
          debug('EnsembleOrchestrator', 'contributionTracker', err && err.message ? err.message : String(err));
        }
      });
    }

    return {
      ...fused,
      mode: 'boosting',
      rounds: roundResults.length,
      agentContributions: roundResults.map(r => ({ agent: r.agent, weight: r.agentWeight, confidence: r.confidence, round: r.round })),
      roundResults,
      finalAspectWeights: aspectWeights,
    };
  }

  /**
   * 执行Stacking集成模式。将前N-1个Agent作为基础层并行执行，最后一个Agent作为元层，
   * 元层Agent接收所有基础层输出并组合为最终结果，适用于Agent数量充足且需要元学习组合的场景。
   * @param {Object} task - 待执行的任务对象
   * @param {Array} agents - 参与集成的Agent列表，最后一个作为元Agent
   * @param {Function} executeFn - Agent执行函数，签名为 async (agent, task) => result
   * @param {Object} [_options] - 执行选项（当前未使用，预留扩展）
   * @returns {Promise<{ output: *, confidence: number, mode: 'stacking', rounds: 2, agentContributions: Array, baseResults: Array, metaResult: * }>}
   */
  async _executeStacking(task, agents, executeFn, _options) {
    this.guardShutdown();
    if (!Array.isArray(agents) || agents.length === 0) throw new Error('At least one agent required for stacking');
    const baseAgents = agents.slice(0, -1);
    if (baseAgents.length < 2) {
      return this._executeBagging(task, agents, executeFn, _options);
    }
    const metaAgent = agents[agents.length - 1];

    const basePromises = baseAgents.map(agent => executeFn(agent, task));
    const baseSettled = await Promise.allSettled(basePromises);
    const baseResults = baseSettled.map((r, i) => ({
      agent: baseAgents[i],
      output: r.status === 'fulfilled' ? r.value?.output ?? r.value : null,
      confidence: r.status === 'fulfilled' ? this._sanitizeConfidence(r.value?.confidence, 0.5) : 0,
    })).filter(r => r.output !== null);

    const metaTask = {
      ...task,
      _baseOutputs: baseResults.map(r => ({ output: r.output, confidence: r.confidence })),
      _metaInstruction: 'Combine the above base outputs into an optimal final result. Weight higher-confidence outputs more.',
    };

    let metaResult;
    try {
      metaResult = await executeFn(metaAgent, metaTask);
    } catch (e) {
      debug('EnsembleOrchestrator', 'stacking', 'Meta-agent execution failed: ' + (e && e.message ? e.message : String(e)));
      metaResult = { output: null, confidence: 0 };
    }

    const fused = this._fuseStacking(baseResults, metaResult);
    this.guardShutdown();

    if (this._contributionTracker) {
      baseResults.forEach(r => {
        try {
          this._contributionTracker.record(r.agent, 'stacking_base', r.confidence, fused.confidence);
        } catch (err) {
          debug('EnsembleOrchestrator', 'contributionTracker', err && err.message ? err.message : String(err));
        }
      });
      try {
        this._contributionTracker.record(metaAgent, 'stacking_meta', this._sanitizeConfidence(metaResult?.confidence, 0.5), fused.confidence);
      } catch (err) {
        debug('EnsembleOrchestrator', 'contributionTracker', err && err.message ? err.message : String(err));
      }
    }

    const totalBaseConfidence = baseResults.reduce((s, b) => s + b.confidence, 0);
    const baseWeight = totalBaseConfidence > 0 ? (r) => r.confidence / totalBaseConfidence : () => baseResults.length > 0 ? 1 / baseResults.length : 0;

    return {
      ...fused,
      mode: 'stacking',
      rounds: 2,
      agentContributions: [
        ...baseResults.map(r => ({ agent: r.agent, weight: baseWeight(r), confidence: r.confidence, layer: 'base' })),
        { agent: metaAgent, weight: 1.0, confidence: this._sanitizeConfidence(metaResult?.confidence, 0.5), layer: 'meta' },
      ],
      baseResults,
      metaResult,
    };
  }

  /**
   * 创建Bootstrap采样变体任务。根据特征采样比例从原始任务中随机选取特征子集，
   * 附加Bootstrap元信息（索引、总数、采样特征列表），用于Bagging模式中为各Agent生成差异化输入。
   * @param {Object} task - 原始任务对象
   * @param {number} agentIndex - 当前Agent的索引，用于生成采样种子
   * @param {number} totalAgents - 参与采样的Agent总数
   * @returns {Object} 包含采样特征子集和Bootstrap元信息的任务变体
   */
  _bootstrapSample(task, agentIndex, totalAgents) {
    const taskKeys = Object.keys(task ?? {}).filter(k => !k.startsWith('_'));
    if (taskKeys.length === 0) return { ...task, _bootstrapIndex: agentIndex, _bootstrapTotal: totalAgents, _sampledFeatures: [] };
    const featureCount = Math.max(1, Math.ceil(taskKeys.length * this._featureSampleRatio));
    const seed = agentIndex * 1000 + Date.now() % 10000;
    const selectedKeys = this._sampleWithReplacement(taskKeys, featureCount, seed);

    const variant = {};
    for (const key of selectedKeys) {
      variant[key] = task[key];
    }
    variant._bootstrapIndex = agentIndex;
    variant._bootstrapTotal = totalAgents;
    variant._sampledFeatures = selectedKeys;
    return variant;
  }

  /**
   * 使用线性同余生成器（LCG）从数组中有放回地随机采样。
   * 采用确定性伪随机算法保证相同种子产生相同采样结果，便于结果复现。
   * @param {Array} array - 待采样的源数组
   * @param {number} count - 采样数量
   * @param {number} seed - 随机种子，决定采样结果
   * @returns {Array} 采样结果数组，长度为count，元素可能有重复
   */
  _sampleWithReplacement(array, count, seed) {
    if (!Array.isArray(array) || array.length === 0) return [];
    const result = [];
    let rng = seed;
    for (let i = 0; i < count; i++) {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      const idx = rng % array.length;
      result.push(array[idx]);
    }
    return result;
  }

  /**
   * 初始化方面权重。为任务对象中所有非内部属性（不以_开头的键）设置初始权重1.0，
   * 用于Boosting模式中追踪各任务方面的关注度。
   * @param {Object} task - 任务对象，从中提取需要追踪权重的方面键
   * @returns {Object} 方面权重映射，键为任务属性名，值为初始权重1.0
   */
  _initAspectWeights(task) {
    const keys = Object.keys(task ?? {}).filter(k => !k.startsWith('_'));
    const weights = {};
    for (const key of keys) {
      weights[key] = 1.0;
    }
    return weights;
  }

  /**
   * 将方面权重应用到任务对象上。在任务中附加_aspectWeights属性，
   * 使执行Agent能够感知各任务方面的重要性权重。
   * @param {Object} task - 原始任务对象
   * @param {Object} weights - 方面权重映射
   * @returns {Object} 附加了_aspectWeights属性的任务对象副本
   */
  _applyAspectWeights(task, weights) {
    const weighted = { ...task };
    weighted._aspectWeights = weights;
    return weighted;
  }

  /**
   * 根据执行结果更新方面权重。对比输出与原始任务的匹配度，
   * 匹配度低的方面权重增加（提升关注度），匹配度高的方面权重降低（减少冗余关注），
   * 权重范围限制在[0.1, 3.0]之间。
   * @param {Object} weights - 当前方面权重映射
   * @param {Object} result - Agent执行结果，包含output属性
   * @param {Object} originalTask - 原始任务对象，用于与输出对比计算匹配度
   * @returns {Object} 更新后的方面权重映射
   */
  _updateAspectWeights(weights, result, originalTask) {
    const updated = { ...weights };
    const output = result?.output;
    if (!output || typeof output !== 'object') return updated;

    for (const key of Object.keys(updated)) {
      if (output[key] !== undefined) {
        const match = this._computeAspectMatch(output[key], originalTask[key]);
        if (match < 0.5) {
          updated[key] = updated[key] * (1 + this._learningRate);
        } else {
          updated[key] = updated[key] * (1 - this._learningRate * 0.5);
        }
        updated[key] = Math.max(0.1, Math.min(3.0, updated[key]));
      }
    }
    return updated;
  }

  /**
   * 计算输出值与期望值之间的匹配度。字符串类型精确匹配返回1.0或0.0，
   * 数值类型根据相对差异返回[0,1]区间的匹配度，其他类型默认返回0.5。
   * @param {*} output - 实际输出值
   * @param {*} expected - 期望值，为null/undefined时默认完全匹配
   * @returns {number} 匹配度，范围[0,1]，1表示完全匹配，0表示完全不匹配
   */
  _computeAspectMatch(output, expected) {
    if (expected == null) return 1.0;
    if (typeof output === 'string' && typeof expected === 'string') return output === expected ? 1.0 : 0.0;
    if (typeof output === 'number' && typeof expected === 'number' && Number.isFinite(output) && Number.isFinite(expected)) {
      const diff = Math.abs(output - expected);
      return Math.max(0, 1 - diff / Math.max(Math.abs(expected), 1));
    }
    return 0.5;
  }

  /**
   * 根据错误率计算Agent权重，采用AdaBoost权重公式：α = 0.5 * ln((1-ε)/ε)。
   * 错误率越低权重越高，错误率接近0.5时权重趋近0，错误率高于0.5时权重为负。
   * 使用ε=1e-10防止除零错误和对数溢出。
   * @param {number} errorRate - Agent的错误率，范围[0,1]
   * @returns {number} Agent权重，正值表示优于随机，负值表示劣于随机
   */
  _computeAgentWeight(errorRate) {
    if (!Number.isFinite(errorRate)) return 0;
    const eps = 1e-10;
    const safeError = Math.max(eps, Math.min(1 - eps, errorRate));
    return 0.5 * Math.log((1 - safeError) / safeError);
  }

  _sanitizeConfidence(confidence, fallback) {
    return (typeof confidence === 'number' && Number.isFinite(confidence)) ? confidence : (fallback ?? 0.5);
  }

  /**
   * 从前一轮执行结果中提取残差上下文。识别输出中的薄弱方面（值为null/undefined/空字符串的属性），
   * 并根据置信度生成改进建议，用于指导后续Agent聚焦于前轮未解决的问题。
   * @param {Object} [previousResult] - 前一轮执行结果，包含output和confidence属性
   * @returns {Object|null} 残差上下文对象，包含weakAspects、confidence和suggestions；无前轮结果时返回null
   */
  _extractResidual(previousResult) {
    if (!previousResult) return null;
    const output = previousResult.output;
    const confidence = previousResult.confidence ?? 0;

    const residual = {
      weakAspects: [],
      confidence,
      suggestions: [],
    };

    if (output !== null && typeof output === 'object') {
      for (const [key, value] of Object.entries(output)) {
        if (value == null || value === '') {
          residual.weakAspects.push(key);
        }
      }
    }

    if (confidence < 0.5) {
      residual.suggestions.push('Previous agent had low confidence. Focus on improving overall quality.');
    }
    if (confidence < 0.3) {
      residual.suggestions.push('Previous agent largely failed. Consider a completely different approach.');
    }

    return residual;
  }

  /**
   * 多数投票。统计各值出现的频次，返回出现次数最多的值，
   * 用于Bagging模式中字符串类型输出的融合决策。
   * @param {Array} values - 待投票的值数组
   * @returns {*} 出现次数最多的值
   */
  _majorityVote(values) {
    if (!values || values.length === 0) return undefined;
    const voteCounts = new Map();
    for (const v of values) voteCounts.set(v, (voteCounts.get(v) ?? 0) + 1);
    let best = values[0];
    let bestCount = 0;
    for (const [v, c] of voteCounts) { if (c > bestCount) { best = v; bestCount = c; } }
    return best;
  }

  /**
   * 融合对象类型输出。收集所有输出对象的键，对数值类型取平均值，
   * 对字符串类型使用多数投票，其他类型取首个非undefined值。
   * 用于Bagging模式中对象类型输出的合并。
   * @param {Array<Object>} outputs - 待融合的对象输出数组
   * @returns {Object} 融合后的对象，键为所有输出键的并集
   */
  _fuseObjectOutputs(outputs) {
    const merged = {};
    const allKeys = new Set();
    for (const output of outputs) {
      if (output !== null && typeof output === 'object') {
        for (const key of Object.keys(output)) allKeys.add(key);
      }
    }

    for (const key of allKeys) {
      const values = outputs.map(o => o?.[key]).filter(v => v !== undefined);
      if (values.length === 0) continue;

      if (typeof values[0] === 'number') {
        merged[key] = values.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0) / values.length;
      } else if (typeof values[0] === 'string') {
        merged[key] = this._majorityVote(values);
      } else {
        merged[key] = values[0];
      }
    }

    return merged;
  }

  /**
   * 融合Bagging结果。根据输出类型采用不同融合策略：
   * 字符串类型使用多数投票，置信度为投票占比；数值类型取平均值；
   * 对象类型合并属性并取一致性与平均置信度的较大值；其他类型取首个输出。
   * @param {Array<{ output: *, confidence: number }>} results - 各Agent的有效执行结果
   * @returns {{ output: *, confidence: number }} 融合后的输出和置信度
   */
  _fuseBagging(results) {
    if (results.length === 0) return { output: null, confidence: 0 };

    const outputs = results.map(r => r.output);
    const firstOutput = outputs[0];

    if (typeof firstOutput === 'string') {
      const bestVote = this._majorityVote(outputs.map(String));
      const voteCounts = new Map();
      for (const o of outputs) voteCounts.set(String(o), (voteCounts.get(String(o)) ?? 0) + 1);
      return { output: bestVote, confidence: (voteCounts.get(bestVote) ?? 0) / outputs.length };
    }

    if (typeof firstOutput === 'number' && Number.isFinite(firstOutput)) {
      const avg = outputs.length > 0 ? outputs.reduce((s, o) => { const n = Number(o); return s + (Number.isFinite(n) ? n : 0); }, 0) / outputs.length : 0;
      return { output: avg, confidence: results.length > 0 ? results.reduce((s, r) => s + r.confidence, 0) / results.length : 0 };
    }

    if (firstOutput !== null && typeof firstOutput === 'object' && !Array.isArray(firstOutput)) {
      const merged = this._fuseObjectOutputs(outputs);
      const agreement = this._computeAgreement(outputs);
      const avgConfidence = results.reduce((s, r) => s + r.confidence, 0) / results.length;
      return { output: merged, confidence: Math.max(agreement, avgConfidence) };
    }

    return { output: firstOutput, confidence: results.reduce((s, r) => s + r.confidence, 0) / results.length };
  }

  /**
   * 融合Boosting结果。使用指数加权置信度融合各轮结果，
   * 对象类型输出优先取最佳轮次结果并附加精化轮次信息，
   * 非对象类型在最佳轮次与加权置信度之间选择更优者。
   * @param {Array<{ output: *, confidence: number, agentWeight: number, round: number }>} roundResults - 各轮执行结果
   * @param {Map} [_agentWeights] - Agent权重映射（当前未直接使用，权重已在roundResults中）
   * @returns {{ output: *, confidence: number }} 融合后的输出和置信度
   */
  _fuseBoosting(roundResults, _agentWeights) {
    if (roundResults.length === 0) return { output: null, confidence: 0 };

    const totalWeight = roundResults.reduce((s, r) => s + Math.exp(Math.max(-10, Math.min(10, r.agentWeight))), 0);
    if (totalWeight === 0) {
      const bestRound = roundResults.reduce((best, r) => (r && r.confidence > best.confidence) ? r : best, roundResults[0] != null ? roundResults[0] : { confidence: 0 });
      return { output: bestRound ? bestRound.output : null, confidence: 0 };
    }
    const weightedConfidence = roundResults.reduce((s, r) => s + r.confidence * Math.exp(Math.max(-10, Math.min(10, r.agentWeight))) / totalWeight, 0);

    const bestRound = roundResults.reduce((best, r) => (r && r.confidence > best.confidence) ? r : best, roundResults[0] != null ? roundResults[0] : { confidence: 0 });

    const lastResult = roundResults[roundResults.length - 1] ?? {};
    const lastOutput = lastResult.output;
    const bestOutput = bestRound ? bestRound.output : null;

    const output = lastOutput !== null && typeof lastOutput === 'object'
      ? Array.isArray(bestOutput)
        ? [...bestOutput, { _boostingRefinements: roundResults.length - 1 }]
        : { ...bestOutput, _boostingRefinements: roundResults.length - 1 }
      : bestRound.confidence > weightedConfidence ? bestOutput : lastOutput;

    return { output, confidence: Math.max(weightedConfidence ?? 0, bestRound.confidence ?? 0) };
  }

  /**
   * 融合Stacking结果。元Agent输出有效时直接采用元Agent结果；
   * 元Agent输出无效时退化为Boosting融合策略，基于基础层结果的置信度加权合并。
   * @param {Array<{ output: *, confidence: number }>} baseResults - 基础层Agent执行结果
   * @param {Object} metaResult - 元Agent执行结果，包含output和confidence属性
   * @returns {{ output: *, confidence: number }} 融合后的输出和置信度
   */
  _fuseStacking(baseResults, metaResult) {
    if (metaResult?.output != null) {
      return {
        output: metaResult.output,
        confidence: metaResult.confidence ?? 0.7,
      };
    }
    return this._fuseBoosting(
      baseResults.map((r, i) => {
        const c = Math.max(0, Math.min(1, Number.isFinite(r.confidence) ? r.confidence : 0.5));
        return { ...r, agentWeight: Math.max(-5, Math.min(5, Math.log((c / (1 - c + 1e-10))))), round: i };
      }),
      null,
    );
  }

  /**
   * 早停检查。当连续无改善轮数达到耐心阈值，或最新轮次置信度达到质量阈值时触发早停，
   * 避免Boosting模式中不必要的后续迭代。
   * @param {Array<{ confidence: number }>} roundResults - 已完成的各轮执行结果
   * @param {Object} [options] - 早停判断选项
   * @param {number} [options.noImprovementCount] - 连续无改善的轮数
   * @returns {boolean} 是否应触发早停，true表示应停止后续迭代
   */
  _shouldEarlyStop(roundResults, options) {
    if (roundResults.length < 2) return false;
    const noImprovement = (options ?? {}).noImprovementCount ?? 0;
    if (noImprovement > 0 && noImprovement >= this._earlyStopPatience) return true;
    const lastConfidence = roundResults[roundResults.length - 1]?.confidence ?? 0;
    if (lastConfidence >= this._qualityThreshold) return true;
    return false;
  }

  /**
   * 计算多个输出之间的一致性。非对象类型直接比较相等性；
   * 对象类型逐键统计值的一致比例，最终取所有键一致比例的平均值。
   * 用于Bagging模式中评估对象输出的融合置信度。
   * @param {Array} outputs - 待比较的输出数组
   * @returns {number} 一致性分数，范围[0,1]，1表示完全一致
   */
  _computeAgreement(outputs) {
    if (outputs.length <= 1) return 1.0;
    const first = outputs[0];
    if (typeof first !== 'object' || first === null) {
      const same = outputs.filter(o => o === first).length;
      return same / outputs.length;
    }
    const allKeys = new Set();
    for (const o of outputs) { if (typeof o === 'object' && o !== null && !Array.isArray(o)) for (const k of Object.keys(o)) allKeys.add(k); }
    if (allKeys.size === 0) return 1.0;
    let totalAgreement = 0;
    for (const key of allKeys) {
      const values = outputs.map(o => o?.[key]).filter(v => v !== undefined);
      if (values.length <= 1) { totalAgreement += 1; continue; }
      const counts = new Map();
      for (const v of values) {
        const k = (function() { try { return JSON.stringify(v); } catch (_e) { debug('EnsembleOrchestrator', 'stringify', _e && _e.message ? _e.message : String(_e)); return String(v); } })();
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const maxCount = [...counts.values()].filter(v => Number.isFinite(v)).reduce((a, b) => Math.max(a, b), 0);
      totalAgreement += maxCount / values.length;
    }
    return totalAgreement / allKeys.size;
  }

  /**
   * 关闭清理回调。释放贡献度追踪器引用，防止实例关闭后仍持有外部资源。
   * @returns {void}
   */
  _onShutdown() {
    this._contributionTracker = null;
    this._boostingHistory = [];
    this._baggingResults = [];
    this._stackingMetaLearner = null;
    this.removeAllListeners();
  }
}

module.exports = { EnsembleOrchestrator: withShutdown(EnsembleOrchestrator) };
