'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { safeCall, clamp01 } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const { generateId } = require('../../utils/constants');
const BoundedMap = require('../../utils/bounded-map');

/**
 * 推理步骤类型枚举
 * @enum {string}
 */
const STEP_TYPES = {
  OBSERVE: 'observe',
  ANALYZE: 'analyze',
  HYPOTHESIZE: 'hypothesize',
  VERIFY: 'verify',
  CONCLUDE: 'conclude',
  REFLECT: 'reflect',
};

/**
 * 推理深度级别映射
 * @enum {Object}
 */
const DEPTH_LEVELS = {
  quick: { maxSteps: 3, description: '快速推理' },
  standard: { maxSteps: 5, description: '标准推理' },
  deep: { maxSteps: 8, description: '深度推理' },
  intensive: { maxSteps: 12, description: '强化推理' },
};

/**
 * 默认配置
 * @type {Object}
 */
const DEFAULT_CONFIG = {
  maxSteps: 20,
  maxHistoryChains: 500,
  defaultDepth: 'standard',
  convergenceThreshold: 0.85,
  enableSelfReflection: true,
  enableBacktracking: true,
  maxBacktrackSteps: 3,
};

/** 步骤类型中文标签映射 */
const STEP_TYPE_LABELS = {
  [STEP_TYPES.OBSERVE]: '观察',
  [STEP_TYPES.ANALYZE]: '分析',
  [STEP_TYPES.HYPOTHESIZE]: '假设',
  [STEP_TYPES.VERIFY]: '验证',
  [STEP_TYPES.CONCLUDE]: '结论',
  [STEP_TYPES.REFLECT]: '反思',
};

/** 有效步骤类型集合 */
const VALID_STEP_TYPES = new Set(Object.values(STEP_TYPES));

/**
 * @module runtime/thought/chain-of-thought
 * @classdesc 思维链引擎
 * ChainOfThoughtEngine — 结构化思维链推理引擎
 *
 * 融合Vibe Coding的"Superpowers"和"SequentialThinking"技能核心能力，
 * 提供显式步骤化输出的结构化Chain-of-Thought推理。桥接Harness现有
 * DeepeningOrchestrator（迭代精化）与Vibe Coding可见推理链之间的能力缺口。
 *
 * @extends EventEmitter
 * @emits ChainOfThoughtEngine#chain-started
 * @emits ChainOfThoughtEngine#step-added
 * @emits ChainOfThoughtEngine#chain-backtracked
 * @emits ChainOfThoughtEngine#chain-completed
 *
 * @example
 * const engine = new ChainOfThoughtEngine({ defaultDepth: 'deep' });
 * engine.attachQualityScorer(qualityScorer);
 * engine.attachConvergenceDetector(convergenceDetector);
 * engine.attachMemoryStore(memoryStore);
 *
 * const { chainId } = await engine.startChain('分析系统瓶颈', { depth: 'deep' });
 * await engine.addStep(chainId, { type: 'observe', content: 'CPU使用率95%', confidence: 0.9 });
 * await engine.addStep(chainId, { type: 'analyze', content: '热点在数据库查询', reasoning: '...' });
 * await engine.addStep(chainId, { type: 'hypothesize', content: '缺少索引导致全表扫描', confidence: 0.75 });
 * await engine.addStep(chainId, { type: 'verify', content: 'EXPLAIN确认全表扫描', evidence: ['...'] });
 * const result = await engine.concludeChain(chainId, '添加复合索引解决瓶颈');
 * console.log(engine.formatChainAsMarkdown(chainId));
 */
class ChainOfThoughtEngine extends EventEmitter {
  /**
   * 创建思维链引擎实例
   * @param {Object} [options={}] - 配置选项，与DEFAULT_CONFIG合并
   */
  constructor(options = {}) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._chains = new BoundedMap(this._config.maxHistoryChains);
    this._activeChain = null;
    this._stepCounter = 0;
    this._stats = {
      chainsCreated: 0,
      stepsExecuted: 0,
      backtracksUsed: 0,
      avgConvergenceScore: 0,
    };
    // 依赖注入追踪
    this._attached = {
      qualityScorer: false,
      convergenceDetector: false,
      memoryStore: false,
    };
    this._qs = null;
    this._cd = null;
    this._ms = null;
    // 收敛评分累计，用于计算平均值
    this._convergenceSum = 0;
    this._convergenceCount = 0;
  }

  /**
   * 附加质量评分器，用于步骤质量评估
   * @param {Object} scorer - 质量评分器实例，需实现score方法
   * @returns {ChainOfThoughtEngine} this以支持链式调用
   * @throws {TypeError} scorer缺少score方法时抛出
   */
  attachQualityScorer(scorer) {
    this.guardShutdown();
    if (scorer && typeof scorer.score === 'function') {
      this._qs = scorer;
      this._attached.qualityScorer = true;
      debug('ChainOfThought', 'attachQualityScorer', '已附加质量评分器');
    } else {
      throw new TypeError('QualityScorer必须实现score方法');
    }
    return this;
  }

  /**
   * 附加收敛检测器，用于推理链收敛性判断
   * @param {Object} detector - 收敛检测器实例，需实现check方法
   * @returns {ChainOfThoughtEngine} this以支持链式调用
   * @throws {TypeError} detector缺少check方法时抛出
   */
  attachConvergenceDetector(detector) {
    this.guardShutdown();
    if (detector && typeof detector.check === 'function') {
      this._cd = detector;
      this._attached.convergenceDetector = true;
      debug('ChainOfThought', 'attachConvergenceDetector', '已附加收敛检测器');
    } else {
      throw new TypeError('ConvergenceDetector必须实现check方法');
    }
    return this;
  }

  /**
   * 附加记忆存储，用于推理经验持久化
   * @param {Object} store - 记忆存储实例，需实现storeExperience方法
   * @returns {ChainOfThoughtEngine} this以支持链式调用
   * @throws {TypeError} store缺少storeExperience方法时抛出
   */
  attachMemoryStore(store) {
    this.guardShutdown();
    if (store && typeof store.storeExperience === 'function') {
      this._ms = store;
      this._attached.memoryStore = true;
      debug('ChainOfThought', 'attachMemoryStore', '已附加记忆存储');
    } else {
      throw new TypeError('MemoryStore必须实现storeExperience方法');
    }
    return this;
  }

  /**
   * 启动新的推理链
   * @param {string} task - 推理任务描述
   * @param {Object} [options={}] - 启动选项
   * @param {string} [options.depth] - 推理深度级别(quick/standard/deep/intensive)
   * @param {Object} [options.metadata] - 链元数据
   * @returns {Promise<{chainId: string, depth: string, maxSteps: number}>} 链信息
   * @fires ChainOfThoughtEngine#chain-started
   */
  async startChain(task, options = {}) {
    this.guardShutdown();
    if (!task || typeof task !== 'string') {
      throw new TypeError('task必须为非空字符串');
    }

    const chainId = generateId('cot');
    const depth = options.depth ?? this._config.defaultDepth;
    const depthConfig = DEPTH_LEVELS[depth] || DEPTH_LEVELS.standard;
    const maxSteps = Math.min(depthConfig.maxSteps, this._config.maxSteps);

    // 创建推理链对象
    const chain = {
      id: chainId,
      task,
      depth,
      maxSteps,
      steps: [],
      status: 'active',
      createdAt: Date.now(),
      metadata: options.metadata ?? {},
    };

    this._chains.set(chainId, chain);
    this._activeChain = chainId;
    this._stats.chainsCreated++;

    debug('ChainOfThought', 'startChain', '启动推理链: ' + chainId + ' 深度: ' + depth);

    /**
     * @event ChainOfThoughtEngine#chain-started
     * @type {Object}
     * @property {string} chainId - 推理链ID
     * @property {string} task - 任务描述
     * @property {string} depth - 推理深度
     */
    this.emit('chain-started', { chainId, task, depth });

    return { chainId, depth, maxSteps };
  }

  /**
   * 向推理链添加一个步骤
   * @param {string} chainId - 推理链ID
   * @param {Object} stepData - 步骤数据
   * @param {string} stepData.type - 步骤类型(STEP_TYPES枚举值)
   * @param {string} stepData.content - 步骤内容
   * @param {string} [stepData.reasoning] - 推理过程
   * @param {Array} [stepData.evidence] - 支撑证据
   * @param {number} [stepData.confidence] - 置信度[0,1]
   * @returns {Promise<Object>} 创建的步骤对象
   * @fires ChainOfThoughtEngine#step-added
   */
  async addStep(chainId, stepData) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) {
      throw new Error('推理链不存在: ' + chainId);
    }
    if (chain.status !== 'active') {
      throw new Error('推理链已结束，无法添加步骤: ' + chainId);
    }
    if (chain.steps.length >= chain.maxSteps) {
      throw new Error('推理链已达最大步骤数(' + chain.maxSteps + '): ' + chainId);
    }

    // 验证步骤类型
    const type = stepData.type;
    if (!VALID_STEP_TYPES.has(type)) {
      throw new TypeError('无效步骤类型: ' + type + '，有效值: ' + Object.values(STEP_TYPES).join('/'));
    }

    // 构建步骤对象
    const step = {
      id: ++this._stepCounter,
      type,
      content: stepData.content || '',
      reasoning: stepData.reasoning || '',
      evidence: Array.isArray(stepData.evidence) ? stepData.evidence : [],
      confidence: typeof stepData.confidence === 'number' ? clamp01(stepData.confidence) : null,
      timestamp: Date.now(),
    };

    chain.steps.push(step);
    this._stats.stepsExecuted++;

    // 自反思：结论步骤触发反思
    if (this._config.enableSelfReflection && type === STEP_TYPES.CONCLUDE) {
      safeCall(
        () => this._runSelfReflection(chain, step),
        'ChainOfThought', 'self-reflection',
      );
    }

    debug('ChainOfThought', 'addStep', '链' + chainId + ' 添加步骤#' + step.id + ' 类型:' + type);

    /**
     * @event ChainOfThoughtEngine#step-added
     * @type {Object}
     * @property {string} chainId - 推理链ID
     * @property {Object} step - 步骤对象
     */
    this.emit('step-added', { chainId, step });

    return step;
  }

  /**
   * 回溯到指定步骤，移除后续步骤（Superpowers能力）
   * @param {string} chainId - 推理链ID
   * @param {number} toStepIndex - 回溯目标步骤索引(0-based)
   * @returns {Promise<{backtrackedTo: number, removedCount: number}>} 回溯结果
   * @fires ChainOfThoughtEngine#chain-backtracked
   */
  async backtrack(chainId, toStepIndex) {
    this.guardShutdown();

    if (!this._config.enableBacktracking) {
      throw new Error('回溯功能已禁用');
    }

    const chain = this._chains.get(chainId);
    if (!chain) {
      throw new Error('推理链不存在: ' + chainId);
    }
    if (chain.status !== 'active') {
      throw new Error('推理链已结束，无法回溯: ' + chainId);
    }
    if (typeof toStepIndex !== 'number' || toStepIndex < 0 || toStepIndex >= chain.steps.length) {
      throw new RangeError('无效回溯索引: ' + toStepIndex + '，有效范围: 0-' + (chain.steps.length - 1));
    }

    // 检查回溯步数限制
    const removedCount = chain.steps.length - toStepIndex - 1;
    if (removedCount > this._config.maxBacktrackSteps) {
      throw new Error('回溯步数(' + removedCount + ')超过最大限制(' + this._config.maxBacktrackSteps + ')');
    }

    // 移除目标索引之后的步骤
    chain.steps.splice(toStepIndex + 1);
    this._stats.backtracksUsed++;

    debug('ChainOfThought', 'backtrack', '链' + chainId + ' 回溯到步骤#' + toStepIndex + ' 移除' + removedCount + '步');

    /**
     * @event ChainOfThoughtEngine#chain-backtracked
     * @type {Object}
     * @property {string} chainId - 推理链ID
     * @property {number} toStepIndex - 回溯目标索引
     * @property {number} removedCount - 移除步骤数
     */
    this.emit('chain-backtracked', { chainId, toStepIndex, removedCount });

    return { backtrackedTo: toStepIndex, removedCount };
  }

  /**
   * 结束推理链，计算收敛评分并持久化经验
   * @param {string} chainId - 推理链ID
   * @param {string} conclusion - 最终结论
   * @returns {Promise<{chainId: string, convergenceScore: number, steps: number, conclusion: string}>} 结论结果
   * @fires ChainOfThoughtEngine#chain-completed
   */
  async concludeChain(chainId, conclusion) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) {
      throw new Error('推理链不存在: ' + chainId);
    }
    if (chain.status !== 'active') {
      throw new Error('推理链已结束: ' + chainId);
    }

    // 添加最终结论步骤
    const concludeStep = {
      id: ++this._stepCounter,
      type: STEP_TYPES.CONCLUDE,
      content: conclusion || '',
      reasoning: '',
      evidence: [],
      confidence: null,
      timestamp: Date.now(),
    };
    chain.steps.push(concludeStep);
    this._stats.stepsExecuted++;

    // 计算收敛评分
    const convergenceScore = this._calculateConvergence(chain);

    // 更新链状态
    chain.status = 'completed';
    chain.convergenceScore = convergenceScore;
    chain.completedAt = Date.now();

    // 更新统计
    this._convergenceSum += convergenceScore;
    this._convergenceCount++;
    this._stats.avgConvergenceScore = this._convergenceSum / this._convergenceCount;

    // 清除活跃链引用
    if (this._activeChain === chainId) {
      this._activeChain = null;
    }

    // 持久化经验到记忆存储
    if (this._attached.memoryStore && this._ms) {
      safeCall(
        () => this._ms.storeExperience({
          type: 'chain-of-thought',
          chainId,
          task: chain.task,
          depth: chain.depth,
          stepCount: chain.steps.length,
          convergenceScore,
          conclusion,
        }),
        'ChainOfThought', 'store-experience',
      );
    }

    debug('ChainOfThought', 'concludeChain', '链' + chainId + ' 完成 收敛:' + convergenceScore.toFixed(2));

    /**
     * @event ChainOfThoughtEngine#chain-completed
     * @type {Object}
     * @property {string} chainId - 推理链ID
     * @property {number} convergenceScore - 收敛评分
     * @property {number} stepCount - 总步骤数
     */
    this.emit('chain-completed', { chainId, convergenceScore, stepCount: chain.steps.length });

    return {
      chainId,
      convergenceScore,
      steps: chain.steps.length,
      conclusion,
    };
  }

  /**
   * 根据ID获取推理链
   * @param {string} chainId - 推理链ID
   * @returns {Object|null} 推理链对象，不存在返回null
   */
  getChain(chainId) {
    return this._chains.get(chainId) ?? null;
  }

  /**
   * 获取当前活跃的推理链
   * @returns {Object|null} 活跃推理链对象，无活跃链返回null
   */
  getActiveChain() {
    if (!this._activeChain) return null;
    return this._chains.get(this._activeChain) ?? null;
  }

  /**
   * 获取推理链的所有步骤
   * @param {string} chainId - 推理链ID
   * @returns {Array<Object>} 步骤数组，链不存在返回空数组
   */
  getChainSteps(chainId) {
    const chain = this._chains.get(chainId);
    if (!chain) return [];
    return chain.steps.slice();
  }

  /**
   * 将推理链格式化为可读Markdown（核心特性：可见推理）
   * @param {string} chainId - 推理链ID
   * @returns {string} Markdown格式的推理链文档，链不存在返回空字符串
   */
  formatChainAsMarkdown(chainId) {
    const chain = this._chains.get(chainId);
    if (!chain) return '';

    const lines = [];
    lines.push('# 思维链: ' + chain.task);
    lines.push('');

    // 逐步骤输出
    for (let i = 0; i < chain.steps.length; i++) {
      const step = chain.steps[i];
      const typeLabel = STEP_TYPE_LABELS[step.type] || step.type;
      lines.push('## 步骤 ' + (i + 1) + ': ' + typeLabel);
      lines.push('**内容**: ' + step.content);

      if (step.reasoning) {
        lines.push('**推理**: ' + step.reasoning);
      }

      if (step.evidence && step.evidence.length > 0) {
        lines.push('**证据**: ' + step.evidence.join('; '));
      }

      if (step.confidence !== null) {
        lines.push('**置信度**: ' + Math.round(step.confidence * 100) + '%');
      }

      lines.push('');
    }

    // 结论摘要
    const concludeSteps = chain.steps.filter(s => s.type === STEP_TYPES.CONCLUDE);
    if (concludeSteps.length > 0) {
      lines.push('## 结论');
      lines.push(concludeSteps.map(s => s.content).join('；'));
      lines.push('');
    }

    // 元信息
    lines.push('**收敛评分**: ' + (typeof chain.convergenceScore === 'number' ? chain.convergenceScore.toFixed(2) : 'N/A'));
    lines.push('**总步骤**: ' + chain.steps.length);
    lines.push('**推理深度**: ' + (DEPTH_LEVELS[chain.depth] ? DEPTH_LEVELS[chain.depth].description : chain.depth));

    return lines.join('\n');
  }

  /**
   * 内部收敛评分计算
   * 评分 = 有结论(0.3) + 平均置信度(0.4) + 类型覆盖率(0.3)
   * @param {Object} chain - 推理链对象
   * @returns {number} 收敛评分[0,1]
   * @private
   */
  _calculateConvergence(chain) {
    // 优先使用附加的收敛检测器
    if (this._attached.convergenceDetector && this._cd) {
      const result = this._cd.check(chain);
      if (typeof result === 'number') return clamp01(result);
      if (result && typeof result.score === 'number') return clamp01(result.score);
    }

    const steps = chain.steps;
    if (steps.length === 0) return 0;

    // 维度1：是否有结论步骤(权重0.3)
    const hasConclude = steps.some(s => s.type === STEP_TYPES.CONCLUDE) ? 1 : 0;
    const concludeScore = hasConclude * 0.3;

    // 维度2：步骤平均置信度(权重0.4)
    const confidentSteps = steps.filter(s => s.confidence !== null);
    let avgConfidence = 0;
    if (confidentSteps.length > 0) {
      avgConfidence = confidentSteps.reduce((sum, s) => sum + s.confidence, 0) / confidentSteps.length;
    }
    const confidenceScore = avgConfidence * 0.4;

    // 维度3：步骤类型覆盖率(权重0.3)
    const usedTypes = new Set(steps.map(s => s.type));
    const totalTypes = Object.keys(STEP_TYPES).length;
    const typeCoverage = usedTypes.size / totalTypes;
    const coverageScore = typeCoverage * 0.3;

    return clamp01(concludeScore + confidenceScore + coverageScore);
  }

  /**
   * 自反思处理：对结论步骤进行反思评估
   * @param {Object} chain - 推理链对象
   * @param {Object} step - 结论步骤
   * @private
   */
  _runSelfReflection(chain, step) {
    // 如果附加了质量评分器，进行质量评估
    if (this._attached.qualityScorer && this._qs) {
      const score = this._qs.score({
        task: chain.task,
        steps: chain.steps,
        conclusion: step.content,
      });
      if (typeof score === 'number') {
        step.reflectionScore = clamp01(score);
        debug('ChainOfThought', 'selfReflection', '反思评分: ' + score.toFixed(2));
      }
    }
  }

  /**
   * 获取引擎统计信息
   * @returns {Object} 统计对象
   */
  getStats() {
    return {
      chainsCreated: this._stats.chainsCreated,
      stepsExecuted: this._stats.stepsExecuted,
      backtracksUsed: this._stats.backtracksUsed,
      avgConvergenceScore: this._stats.avgConvergenceScore,
      activeChains: this._countActiveChains(),
      attached: { ...this._attached },
    };
  }

  /**
   * 统计活跃推理链数量
   * @returns {number} 活跃链数量
   * @private
   */
  _countActiveChains() {
    let count = 0;
    this._chains.forEach(chain => {
      if (chain.status === 'active') count++;
    });
    return count;
  }

  /**
   * 关闭引擎，清除所有状态
   * @private
   */
  _onShutdown() {
    safeCall(() => this._chains.shutdown(), 'ChainOfThought', 'shutdown-chains');
    this._activeChain = null;
    this._stepCounter = 0;
    this._qs = null;
    this._cd = null;
    this._ms = null;
    this._attached = { qualityScorer: false, convergenceDetector: false, memoryStore: false };
    this._convergenceSum = 0;
    this._convergenceCount = 0;
    this.removeAllListeners();
    debug('ChainOfThought', 'shutdown', '引擎已关闭');
  }
}

// 静态属性导出
ChainOfThoughtEngine.STEP_TYPES = STEP_TYPES;
ChainOfThoughtEngine.DEPTH_LEVELS = DEPTH_LEVELS;
ChainOfThoughtEngine.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(ChainOfThoughtEngine);
