/**
 * @module runtime/workflow/task-decomposer
 * @description 任务分解器模块，自动将复杂任务分解为子任务以支持多代理执行。
 * 支持顺序、并行、混合和管道四种分解策略，通过关键词检测推断执行模式，
 * 构建子任务依赖图，并为每个子任务估算Token消耗。
 * @extends EventEmitter
 * @emits TaskDecomposer#decomposed 任务分解完成事件
 */

'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

/** @constant {Object} DECOMPOSITION_STRATEGY - 分解策略枚举 */
const DECOMPOSITION_STRATEGY = Object.freeze({
  SEQUENTIAL: 'sequential',     // 顺序执行
  PARALLEL: 'parallel',         // 并行执行
  MIXED: 'mixed',              // 混合执行
  PIPELINE: 'pipeline',        // 管道执行
});

/** @constant {Object} SUBTASK_STATUS - 子任务状态枚举 */
const SUBTASK_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

/** @constant {Object} DEFAULT_CONFIG - 默认配置 */
const DEFAULT_CONFIG = {
  maxSubtasks: 10,
  maxDecompositionDepth: 3,
  minSubtaskGranularity: 'step',  // step | phase | module
  requireEstimates: true,
};

/** @constant {Array<string>} SEQUENTIAL_KEYWORDS - 顺序执行关键词 */
const SEQUENTIAL_KEYWORDS = ['然后', '接着', '之后', '随后', '再', '第一步', '第二步', '第三步', 'first', 'then', 'after', 'next', 'finally'];

/** @constant {Array<string>} PARALLEL_KEYWORDS - 并行执行关键词 */
const PARALLEL_KEYWORDS = ['同时', '并行', '分别', '各自', '同步', 'parallel', 'simultaneously', 'concurrently', 'meanwhile'];

/** @constant {number} BASE_TOKEN_ESTIMATE - 单个子任务基础Token估算值 */
const BASE_TOKEN_ESTIMATE = 500;

/** @constant {number} MAX_DECOMPOSITIONS - 分解结果最大保留条数 */
const MAX_DECOMPOSITIONS = 100;

/**
 * @class TaskDecomposer
 * @classdesc 任务分解器，将复杂任务自动分解为子任务以支持多代理执行。
 * 通过关键词检测推断执行策略，构建子任务依赖图，估算Token消耗。
 * @extends EventEmitter
 */
class TaskDecomposer extends EventEmitter {
  /**
   * 创建TaskDecomposer实例
   * @param {Object} [config={}] - 配置选项
   * @param {number} [config.maxSubtasks=10] - 最大子任务数量
   * @param {number} [config.maxDecompositionDepth=3] - 最大分解深度
   * @param {string} [config.minSubtaskGranularity='step'] - 最小子任务粒度 (step | phase | module)
   * @param {boolean} [config.requireEstimates=true] - 是否需要Token估算
   */
  constructor(config = {}) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._decompositions = new Map();
    this._llmClient = null;
  }

  /**
   * 将复杂任务分解为子任务
   * @param {string} task - 待分解的任务描述，必须为非空字符串
   * @param {Object} [options={}] - 分解选项
   * @param {string} [options.strategy] - 指定分解策略，未指定时自动推断
   * @returns {{ id: string, task: string, strategy: string, subtasks: Array<Object>, estimatedTokens: number, createdAt: number }} 分解结果
   * @throws {Error} 任务为空或非字符串时抛出
   * @emits TaskDecomposer#decomposed
   */
  decompose(task, options = {}) {
    this.guardShutdown();
    if (!task || typeof task !== 'string') throw new Error('Task must be a non-empty string');

    const decompositionId = 'decomp-' + Date.now();
    const strategy = options.strategy || this._inferStrategy(task);

    // Parse task into sub-tasks using structured analysis
    const subtasks = this._analyzeAndSplit(task, strategy, options);

    // Validate decomposition
    if (subtasks.length === 0) {
      return { id: decompositionId, task, strategy, subtasks: [], estimatedTokens: 0 };
    }
    if (subtasks.length > this._config.maxSubtasks) {
      subtasks.length = this._config.maxSubtasks;
    }

    // Build dependency graph
    const dependencies = this._buildDependencies(subtasks, strategy);

    const result = {
      id: decompositionId,
      task,
      strategy,
      subtasks: subtasks.map((st, i) => ({
        id: decompositionId + '-sub-' + i,
        index: i,
        description: st.description,
        type: st.type || 'execution',
        status: SUBTASK_STATUS.PENDING,
        dependencies: dependencies[i] ?? [],
        estimatedTokens: Number.isFinite(st.estimatedTokens) ? st.estimatedTokens : 0,
        assignedAgent: st.assignedAgent || null,
      })),
      estimatedTokens: subtasks.reduce((sum, st) => sum + (Number.isFinite(st.estimatedTokens) ? st.estimatedTokens : 0), 0),
      createdAt: Date.now(),
    };

    if (this._decompositions.size >= MAX_DECOMPOSITIONS) {
      const oldestKey = this._decompositions.keys().next().value;
      this._decompositions.delete(oldestKey);
    }
    this._decompositions.set(decompositionId, result);
    this.emit('decomposed', result);
    return result;
  }

  /**
   * 分析任务并拆分为子任务
   * 使用关键词检测识别分解点，顺序关键词（"然后"/"接着"/"之后"）标记顺序分解，
   * 并行关键词（"同时"/"并行"/"分别"）标记并行分解。
   * @param {string} task - 任务描述
   * @param {string} strategy - 分解策略
   * @param {Object} options - 分解选项
   * @returns {Array<{description: string, type: string, estimatedTokens: number, assignedAgent: *}>} 子任务列表
   * @private
   */
  _analyzeAndSplit(task, strategy, _options) {
    const result = safeExecute(() => {
      // Try LLM-based decomposition if client is attached
      if (this._llmClient && typeof this._llmClient.decompose === 'function') {
        const llmResult = this._llmClient.decompose(task, strategy);
        if (Array.isArray(llmResult) && llmResult.length > 0) {
          return llmResult;
        }
      }

      // Keyword-based splitting
      const segments = this._splitByKeywords(task);
      if (segments.length <= 1) {
        // Single task — return as one subtask
        return [{
          description: task.trim(),
          type: 'execution',
          estimatedTokens: this._estimateTokens(task),
          assignedAgent: null,
        }];
      }

      return segments.map((segment, i) => ({
        description: segment.trim(),
        type: this._inferSubtaskType(segment, i, strategy),
        estimatedTokens: this._estimateTokens(segment),
        assignedAgent: null,
      }));
    }, 'TaskDecomposer', 'analyzeAndSplit', []);

    if (result.length === 0 && task.length > 10) {
      this.emit('decomposition-error', { task: task.substring(0, 100) });
    }

    return result;
  }

  /**
   * 根据关键词拆分任务描述
   * @param {string} task - 任务描述
   * @returns {Array<string>} 拆分后的任务片段
   * @private
   */
  _splitByKeywords(task) {
    const allKeywords = [...SEQUENTIAL_KEYWORDS, ...PARALLEL_KEYWORDS];
    const pattern = allKeywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const regex = new RegExp('(' + pattern + ')', 'gi');
    const parts = task.split(regex).filter(p => p.trim().length > 0);

    // Merge keyword with following segment
    const segments = [];
    let i = 0;
    while (i < parts.length) {
      const part = parts[i].trim();
      if (!part) { i++; continue; }

      const isKeyword = allKeywords.some(kw => part.toLowerCase() === kw.toLowerCase());
      if (isKeyword && i + 1 < parts.length) {
        // Attach keyword to the following segment as context
        segments.push(parts[i + 1].trim());
        i += 2;
      } else if (isKeyword) {
        i++;
      } else {
        segments.push(part);
        i++;
      }
    }

    return segments;
  }

  /**
   * 推断子任务类型
   * @param {string} segment - 任务片段
   * @param {number} index - 子任务索引
   * @param {string} strategy - 分解策略
   * @returns {string} 子任务类型
   * @private
   */
  _inferSubtaskType(segment, index, strategy) {
    if (strategy === DECOMPOSITION_STRATEGY.PIPELINE) return 'pipeline-stage';
    if (strategy === DECOMPOSITION_STRATEGY.PARALLEL) return 'parallel-branch';
    if (index === 0) return 'initiation';
    return 'execution';
  }

  /**
   * 从任务描述推断分解策略
   * @param {string} task - 任务描述
   * @returns {string} 推断的分解策略
   * @private
   */
  _inferStrategy(task) {
    return safeExecute(() => {
      const lower = task.toLowerCase();
      let seqCount = 0;
      let parCount = 0;

      for (const kw of SEQUENTIAL_KEYWORDS) {
        if (lower.includes(kw.toLowerCase())) seqCount++;
      }
      for (const kw of PARALLEL_KEYWORDS) {
        if (lower.includes(kw.toLowerCase())) parCount++;
      }

      if (seqCount > 0 && parCount > 0) return DECOMPOSITION_STRATEGY.MIXED;
      if (parCount > 0) return DECOMPOSITION_STRATEGY.PARALLEL;
      if (seqCount > 0) return DECOMPOSITION_STRATEGY.SEQUENTIAL;

      // Check for pipeline pattern (e.g., "输入...处理...输出")
      if (lower.includes('输入') && lower.includes('输出')) return DECOMPOSITION_STRATEGY.PIPELINE;
      if (lower.includes('input') && lower.includes('output')) return DECOMPOSITION_STRATEGY.PIPELINE;

      return DECOMPOSITION_STRATEGY.SEQUENTIAL;
    }, 'TaskDecomposer', 'inferStrategy', DECOMPOSITION_STRATEGY.SEQUENTIAL);
  }

  /**
   * 根据策略构建子任务依赖图
   * @param {Array<Object>} subtasks - 子任务列表
   * @param {string} strategy - 分解策略
   * @returns {Object<number, Array<number>>} 依赖关系映射，键为子任务索引，值为依赖的子任务索引数组
   * @private
   */
  _buildDependencies(subtasks, strategy) {
    return safeExecute(() => {
      const deps = {};

      switch (strategy) {
        case DECOMPOSITION_STRATEGY.SEQUENTIAL:
          // Each subtask depends on the previous one
          for (let i = 0; i < subtasks.length; i++) {
            deps[i] = i > 0 ? [i - 1] : [];
          }
          break;

        case DECOMPOSITION_STRATEGY.PARALLEL:
          // No dependencies between subtasks
          for (let i = 0; i < subtasks.length; i++) {
            deps[i] = [];
          }
          break;

        case DECOMPOSITION_STRATEGY.PIPELINE:
          // Linear chain like sequential, but with pipeline semantics
          for (let i = 0; i < subtasks.length; i++) {
            deps[i] = i > 0 ? [i - 1] : [];
          }
          break;

        case DECOMPOSITION_STRATEGY.MIXED:
          // First task has no deps, rest depend on previous
          // Parallel segments detected by keywords have no mutual deps
          for (let i = 0; i < subtasks.length; i++) {
            const desc = (subtasks[i].description || '').toLowerCase();
            const isParallelStart = PARALLEL_KEYWORDS.some(kw => desc.startsWith(kw.toLowerCase()));
            if (i === 0) {
              deps[i] = [];
            } else if (isParallelStart && i >= 2) {
              // Parallel branch: depends on the task before the parallel keyword
              deps[i] = [i - 2];
            } else {
              deps[i] = [i - 1];
            }
          }
          break;

        default:
          for (let i = 0; i < subtasks.length; i++) {
            deps[i] = i > 0 ? [i - 1] : [];
          }
      }

      return deps;
    }, 'TaskDecomposer', 'buildDependencies', {});
  }

  /**
   * 估算任务描述的Token消耗
   * @param {string} text - 任务描述文本
   * @returns {number} 估算的Token数量
   * @private
   */
  _estimateTokens(text) {
    if (!this._config.requireEstimates) return 0;
    if (!text || typeof text !== 'string') return 0;
    // Rough estimation: Chinese characters ~1.5 tokens, English words ~1 token
    const charCount = text.length;
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length;
    const nonCjkCount = charCount - cjkCount;
    return Math.ceil(cjkCount * 1.5 + nonCjkCount * 0.25) + BASE_TOKEN_ESTIMATE;
  }

  /**
   * 获取指定分解结果（防御性拷贝）
   * @param {string} id - 分解结果ID
   * @returns {Object|null} 分解结果的防御性拷贝，不存在时返回null
   */
  getDecomposition(id) {
    this.guardShutdown();
    const result = this._decompositions.get(id);
    if (!result) return null;
    return {
      ...result,
      subtasks: result.subtasks.map(st => ({ ...st, dependencies: [...st.dependencies] })),
    };
  }

  /**
   * 获取分解策略枚举
   * @returns {Object} 分解策略枚举的防御性拷贝
   */
  getStrategy() {
    return { ...DECOMPOSITION_STRATEGY };
  }

  /**
   * 附加LLM客户端，用于基于LLM的任务分解（可选）
   * @param {Object} client - LLM客户端实例，需提供decompose方法
   * @returns {TaskDecomposer} 当前实例，支持链式调用
   */
  attachLlmClient(client) {
    this.guardShutdown();
    this._llmClient = client || null;
    debug('TaskDecomposer', 'attachLlmClient', 'LLM client attached');
    return this;
  }

  /**
   * 关闭时的清理操作
   * @private
   */
  _onShutdown() {
    this._decompositions.clear();
    this._llmClient = null;
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
  }
}

TaskDecomposer.DECOMPOSITION_STRATEGY = DECOMPOSITION_STRATEGY;
TaskDecomposer.SUBTASK_STATUS = SUBTASK_STATUS;

module.exports = withShutdown(TaskDecomposer);
