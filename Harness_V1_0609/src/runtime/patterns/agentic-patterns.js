'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

// ─── 常量 ──────────────────────────────────────────────────────────────────────

const DEFAULT_QUALITY_THRESHOLD = 0.7;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_CONCURRENCY = 5;
const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_CONVERGENCE_THRESHOLD = 0.85;
const BASE_RETRY_DELAY_MS = 500;

const CLARIFICATION_TEMPLATE = `未能找到与查询匹配的技能。请尝试以下方式：
1. 使用更具体的关键词重新描述您的需求
2. 检查是否有拼写错误
3. 列出您希望完成的具体任务`;

// ─── ValidationGate ────────────────────────────────────────────────────────────

/**
 * @classdesc 验证门禁 — 链式步骤之间的中间质量验证。
 * 在链式执行流程中插入质量检查点，对每一步输出进行评分，
 * 未达阈值的输出将触发重试，确保整体链路质量可控。
 *
 * @extends EventEmitter
 * @emits 'validation-passed' 验证通过时触发
 * @emits 'validation-failed' 验证失败时触发
 * @emits 'validation-retried' 验证重试时触发
 */
class ValidationGate extends EventEmitter {
  /**
   * 创建 ValidationGate 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.qualityThreshold=0.7] - 质量通过阈值，低于此值视为不通过
   * @param {number} [options.maxRetries=2] - 单步最大重试次数
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._qualityThreshold = typeof opts.qualityThreshold === 'number' && Number.isFinite(opts.qualityThreshold)
      ? opts.qualityThreshold
      : DEFAULT_QUALITY_THRESHOLD;
    this._maxRetries = typeof opts.maxRetries === 'number' && Number.isFinite(opts.maxRetries)
      ? opts.maxRetries
      : DEFAULT_MAX_RETRIES;
    /** @type {Map<string, Function>} 步骤名→自定义验证函数映射 */
    this._validators = new Map();
  }

  /**
   * 获取质量阈值。
   * @type {number}
   */
  get qualityThreshold() {
    return this._qualityThreshold;
  }

  /**
   * 获取最大重试次数。
   * @type {number}
   */
  get maxRetries() {
    return this._maxRetries;
  }

  /**
   * 注册自定义步骤验证函数。
   * @param {string} stepName - 步骤名称
   * @param {Function} validatorFn - 验证函数，签名为 (output) => { passed, score, reason }
   * @throws {TypeError} stepName 非字符串或 validatorFn 非函数时抛出
   */
  registerValidator(stepName, validatorFn) {
    if (typeof stepName !== 'string' || !stepName) {
      throw new TypeError('stepName 必须是非空字符串');
    }
    if (typeof validatorFn !== 'function') {
      throw new TypeError('validatorFn 必须是函数');
    }
    this._validators.set(stepName, validatorFn);
  }

  /**
   * 验证步骤输出质量。
   * 优先使用步骤自定义验证函数，否则使用默认评分逻辑。
   * @param {*} output - 步骤输出内容
   * @param {string} stepName - 步骤名称
   * @returns {{ passed: boolean, score: number, reason: string }} 验证结果
   */
  validate(output, stepName) {
    try {
      const customValidator = this._validators.get(stepName);
      if (customValidator) {
        const result = customValidator(output);
        const score = typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : 0;
        const passed = result.passed !== undefined ? result.passed : score >= this._qualityThreshold;
        const reason = result.reason || (passed ? '自定义验证通过' : '自定义验证未通过');
        this.emit(passed ? 'validation-passed' : 'validation-failed', { stepName, score, reason });
        return { passed, score, reason };
      }

      const score = this._defaultScore(output);
      const passed = score >= this._qualityThreshold;
      const reason = passed
        ? `质量评分 ${score.toFixed(2)} 达到阈值 ${this._qualityThreshold}`
        : `质量评分 ${score.toFixed(2)} 低于阈值 ${this._qualityThreshold}`;
      this.emit(passed ? 'validation-passed' : 'validation-failed', { stepName, score, reason });
      return { passed, score, reason };
    } catch (err) {
      debug('ValidationGate', 'validate', err);
      this.emit('validation-failed', { stepName, score: 0, reason: `验证异常: ${err.message}` });
      return { passed: false, score: 0, reason: `验证异常: ${err.message}` };
    }
  }

  /**
   * 默认质量评分逻辑。
   * 基于输出完整性、非空性和基本结构进行启发式评分。
   * @param {*} output - 待评分输出
   * @returns {number} 0~1之间的质量评分
   * @private
   */
  _defaultScore(output) {
    if (output == null) return 0;
    if (typeof output === 'string') {
      if (output.length === 0) return 0;
      if (output.length < 10) return 0.3;
      if (output.length < 50) return 0.5;
      return 0.75;
    }
    if (typeof output === 'object') {
      const keys = Object.keys(output);
      if (keys.length === 0) return 0.2;
      const filledCount = keys.filter(k => output[k] != null && output[k] !== '').length;
      return Math.min(1, 0.4 + (filledCount / keys.length) * 0.6);
    }
    return 0.5;
  }
}

// ─── FallbackRouter ────────────────────────────────────────────────────────────

/**
 * @classdesc 回退路由器 — 当无技能匹配时的回退路由策略。
 * 按优先级依次尝试：宽松匹配 → 回退处理器 → 澄清请求，
 * 确保用户查询始终能获得有意义的响应而非静默失败。
 *
 * @extends EventEmitter
 * @emits 'fallback-triggered' 回退策略触发时触发
 * @emits 'fallback-resolved' 回退策略成功解决时触发
 */
class FallbackRouter extends EventEmitter {
  /**
   * 创建 FallbackRouter 实例。
   * @param {Object} [options] - 配置选项
   * @param {Function|null} [options.fallbackHandler=null] - 默认回退处理函数
   * @param {string} [options.clarificationPrompt] - 澄清提示模板
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._fallbackHandler = typeof opts.fallbackHandler === 'function' ? opts.fallbackHandler : null;
    this._clarificationPrompt = typeof opts.clarificationPrompt === 'string' && opts.clarificationPrompt
      ? opts.clarificationPrompt
      : CLARIFICATION_TEMPLATE;
    /** @type {Array<Function>} 注册的回退处理器列表 */
    this._registeredFallbacks = [];
  }

  /**
   * 获取澄清提示模板。
   * @type {string}
   */
  get clarificationPrompt() {
    return this._clarificationPrompt;
  }

  /**
   * 注册回退处理函数。
   * @param {Function} handlerFn - 回退处理函数，签名为 (query, candidates) => result|null
   * @throws {TypeError} handlerFn 非函数时抛出
   */
  registerFallback(handlerFn) {
    if (typeof handlerFn !== 'function') {
      throw new TypeError('handlerFn 必须是函数');
    }
    this._registeredFallbacks.push(handlerFn);
  }

  /**
   * 处理无匹配情况，按优先级尝试回退策略。
   * 策略顺序：(a) 宽松匹配 (b) 回退处理器 (c) 澄清请求
   * @param {string} query - 用户查询
   * @param {Array<{name: string, keywords: string[]}>} candidates - 候选技能列表
   * @returns {{ resolved: boolean, strategy: string, result: * }} 回退处理结果
   */
  handleNoMatch(query, candidates) {
    try {
      this.emit('fallback-triggered', { query, candidateCount: candidates ? candidates.length : 0 });

      // 策略 (a): 宽松匹配 — 对查询和候选关键词进行模糊匹配
      const relaxedResult = this._relaxedMatch(query, candidates);
      if (relaxedResult) {
        this.emit('fallback-resolved', { query, strategy: 'relaxed-match', result: relaxedResult });
        return { resolved: true, strategy: 'relaxed-match', result: relaxedResult };
      }

      // 策略 (b): 注册的回退处理器
      for (const handler of this._registeredFallbacks) {
        try {
          const handlerResult = handler(query, candidates);
          if (handlerResult != null) {
            this.emit('fallback-resolved', { query, strategy: 'registered-handler', result: handlerResult });
            return { resolved: true, strategy: 'registered-handler', result: handlerResult };
          }
        } catch (handlerErr) {
          debug('FallbackRouter', 'handleNoMatch:handler', handlerErr);
        }
      }

      // 策略 (b) 补充: 构造函数中传入的默认回退处理器
      if (this._fallbackHandler) {
        try {
          const fallbackResult = this._fallbackHandler(query, candidates);
          if (fallbackResult != null) {
            this.emit('fallback-resolved', { query, strategy: 'fallback-handler', result: fallbackResult });
            return { resolved: true, strategy: 'fallback-handler', result: fallbackResult };
          }
        } catch (fallbackErr) {
          debug('FallbackRouter', 'handleNoMatch:fallback', fallbackErr);
        }
      }

      // 策略 (c): 澄清请求
      const clarification = this._buildClarification(query, candidates);
      this.emit('fallback-resolved', { query, strategy: 'clarification', result: clarification });
      return { resolved: false, strategy: 'clarification', result: clarification };
    } catch (err) {
      debug('FallbackRouter', 'handleNoMatch', err);
      this.emit('fallback-resolved', { query, strategy: 'error', result: null });
      return { resolved: false, strategy: 'error', result: null };
    }
  }

  /**
   * 宽松匹配 — 对查询进行大小写不敏感的子串匹配。
   * @param {string} query - 用户查询
   * @param {Array<{name: string, keywords: string[]}>} candidates - 候选列表
   * @returns {*|null} 匹配到的候选或null
   * @private
   */
  _relaxedMatch(query, candidates) {
    if (!query || !Array.isArray(candidates) || candidates.length === 0) return null;
    const lowerQuery = query.toLowerCase();
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.name !== 'string') continue;
      if (lowerQuery.includes(candidate.name.toLowerCase())) return candidate;
      const keywords = candidate.keywords;
      if (Array.isArray(keywords)) {
        for (const kw of keywords) {
          if (typeof kw === 'string' && lowerQuery.includes(kw.toLowerCase())) return candidate;
        }
      }
    }
    return null;
  }

  /**
   * 构建澄清请求消息。
   * @param {string} query - 用户查询
   * @param {Array} candidates - 候选列表
   * @returns {string} 澄清提示
   * @private
   */
  _buildClarification(query, candidates) {
    const candidateNames = Array.isArray(candidates)
      ? candidates.slice(0, 5).map(c => (c && c.name) || '未知').join('、')
      : '无';
    return `${this._clarificationPrompt}\n\n您的查询: "${query}"\n可用技能: ${candidateNames}`;
  }
}

// ─── ConcurrencyController ─────────────────────────────────────────────────────

/**
 * @classdesc 并发控制器 — 带并发限制的并行执行器。
 * 使用信号量模式控制并发任务数，失败任务支持指数退避重试，
 * 适用于批量I/O操作、模型推理等需要限流并行的场景。
 *
 * @extends EventEmitter
 * @emits 'task-started' 任务开始执行时触发
 * @emits 'task-completed' 任务成功完成时触发
 * @emits 'task-failed' 任务最终失败时触发
 * @emits 'task-retried' 任务重试时触发
 */
class ConcurrencyController extends EventEmitter {
  /**
   * 创建 ConcurrencyController 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxConcurrency=5] - 最大并发数
   * @param {boolean} [options.retryOnFailure=true] - 失败时是否重试
   * @param {number} [options.maxRetries=2] - 单任务最大重试次数
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._maxConcurrency = typeof opts.maxConcurrency === 'number' && Number.isFinite(opts.maxConcurrency) && opts.maxConcurrency > 0
      ? opts.maxConcurrency
      : DEFAULT_MAX_CONCURRENCY;
    this._retryOnFailure = opts.retryOnFailure !== false;
    this._maxRetries = typeof opts.maxRetries === 'number' && Number.isFinite(opts.maxRetries)
      ? opts.maxRetries
      : DEFAULT_MAX_RETRIES;
    /** @type {number} 当前运行中的任务数（信号量计数） */
    this._running = 0;
    /** @type {Array<Function>} 等待获取信号量的任务队列 */
    this._queue = [];
  }

  /**
   * 获取最大并发数。
   * @type {number}
   */
  get maxConcurrency() {
    return this._maxConcurrency;
  }

  /**
   * 获取当前运行中的任务数。
   * @type {number}
   */
  get runningCount() {
    return this._running;
  }

  /**
   * 获取等待队列长度。
   * @type {number}
   */
  get queuedCount() {
    return this._queue.length;
  }

  /**
   * 并发执行所有任务，返回全部结果。
   * @param {Array<*>} tasks - 任务列表，每个元素将传给 executeFn
   * @param {Function} executeFn - 任务执行函数，签名为 (task) => Promise<result>
   * @returns {Promise<Array<{task: *, result: *, error: Error|null, retries: number}>>} 全部任务结果
   */
  async executeAll(tasks, executeFn) {
    if (!Array.isArray(tasks)) return [];
    if (typeof executeFn !== 'function') {
      throw new TypeError('executeFn 必须是函数');
    }

    const results = [];
    const promises = tasks.map((task, index) => this._executeWithConcurrency(task, index, executeFn, results));
    await Promise.all(promises);
    return results;
  }

  /**
   * 获取信号量许可，超过并发限制时排队等待。
   * @returns {Promise<void>}
   * @private
   */
  _acquire() {
    return new Promise((resolve) => {
      if (this._running < this._maxConcurrency) {
        this._running++;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  /**
   * 释放信号量许可，唤醒队列中的下一个任务。
   * @private
   */
  _release() {
    this._running--;
    if (this._queue.length > 0) {
      this._running++;
      const next = this._queue.shift();
      next();
    }
  }

  /**
   * 带并发控制和重试的单任务执行。
   * @param {*} task - 任务数据
   * @param {number} index - 任务索引
   * @param {Function} executeFn - 执行函数
   * @param {Array} results - 结果收集数组
   * @private
   */
  async _executeWithConcurrency(task, index, executeFn, results) {
    await this._acquire();
    let retries = 0;
    let lastError = null;
    try {
      let result = null;
      let success = false;
      const maxAttempts = this._retryOnFailure ? this._maxRetries + 1 : 1;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          if (attempt === 0) {
            this.emit('task-started', { task, index });
          }
          result = await executeFn(task);
          success = true;
          this.emit('task-completed', { task, index, result, retries });
          break;
        } catch (err) {
          lastError = err;
          retries = attempt;
          if (attempt < maxAttempts - 1 && this._retryOnFailure) {
            this.emit('task-retried', { task, index, attempt, error: err });
            const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
            await this._delay(delay);
          }
        }
      }

      if (!success) {
        this.emit('task-failed', { task, index, error: lastError, retries });
      }

      results[index] = { task, result: success ? result : null, error: success ? null : lastError, retries };
    } catch (outerErr) {
      debug('ConcurrencyController', '_executeWithConcurrency', outerErr);
      this.emit('task-failed', { task, index, error: outerErr, retries });
      results[index] = { task, result: null, error: outerErr, retries };
    } finally {
      this._release();
    }
  }

  /**
   * 延迟工具函数。
   * @param {number} ms - 延迟毫秒数
   * @returns {Promise<void>}
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ─── ReflectionLoop ────────────────────────────────────────────────────────────

/**
 * @classdesc 反思循环 — 通过自我反思驱动修订和重新规划。
 * 迭代执行"反思→修订"循环，直到输出质量收敛或达到最大迭代次数。
 * 当反思结果建议回滚修订时，可触发可选的重新规划函数。
 *
 * @extends EventEmitter
 * @emits 'reflection-iteration' 每次反思迭代完成时触发
 * @emits 'convergence-detected' 检测到收敛时触发
 * @emits 'replan-triggered' 触发重新规划时触发
 */
class ReflectionLoop extends EventEmitter {
  /**
   * 创建 ReflectionLoop 实例。
   * @param {Object} options - 配置选项
   * @param {number} [options.maxIterations=5] - 最大反思迭代次数
   * @param {number} [options.convergenceThreshold=0.85] - 收敛质量阈值
   * @param {Function} options.reflectionFn - 反思函数，签名为 (output) => Promise<{score, feedback, recommendedAction}>
   * @param {Function} options.revisionFn - 修订函数，签名为 (output, feedback) => Promise<revisedOutput>
   * @param {Function} [options.replanFn] - 重新规划函数，签名为 (output, feedback) => Promise<newOutput>
   * @throws {TypeError} reflectionFn 或 revisionFn 缺失或非函数时抛出
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._maxIterations = typeof opts.maxIterations === 'number' && Number.isFinite(opts.maxIterations) && opts.maxIterations > 0
      ? opts.maxIterations
      : DEFAULT_MAX_ITERATIONS;
    this._convergenceThreshold = typeof opts.convergenceThreshold === 'number' && Number.isFinite(opts.convergenceThreshold)
      ? opts.convergenceThreshold
      : DEFAULT_CONVERGENCE_THRESHOLD;

    if (typeof opts.reflectionFn !== 'function') {
      throw new TypeError('reflectionFn 必须是函数');
    }
    if (typeof opts.revisionFn !== 'function') {
      throw new TypeError('revisionFn 必须是函数');
    }

    this._reflectionFn = opts.reflectionFn;
    this._revisionFn = opts.revisionFn;
    this._replanFn = typeof opts.replanFn === 'function' ? opts.replanFn : null;
  }

  /**
   * 获取最大迭代次数。
   * @type {number}
   */
  get maxIterations() {
    return this._maxIterations;
  }

  /**
   * 获取收敛阈值。
   * @type {number}
   */
  get convergenceThreshold() {
    return this._convergenceThreshold;
  }

  /**
   * 执行反思-修订循环，直到收敛或达到最大迭代次数。
   * @param {*} initialOutput - 初始输出
   * @returns {Promise<{finalOutput: *, iterations: number, converged: boolean, qualityHistory: Array<number>}>} 循环结果
   */
  async execute(initialOutput) {
    let currentOutput = initialOutput;
    let iterations = 0;
    let converged = false;
    const qualityHistory = [];

    for (let i = 0; i < this._maxIterations; i++) {
      try {
        const reflection = await this._reflectionFn(currentOutput);
        const score = typeof reflection.score === 'number' && Number.isFinite(reflection.score)
          ? reflection.score
          : 0;
        qualityHistory.push(score);
        iterations++;

        this.emit('reflection-iteration', {
          iteration: i + 1,
          score,
          feedback: reflection.feedback,
          recommendedAction: reflection.recommendedAction,
        });

        // 收敛检测
        if (score >= this._convergenceThreshold) {
          converged = true;
          this.emit('convergence-detected', { iteration: i + 1, score, qualityHistory });
          break;
        }

        // 重新规划检测
        if (reflection.recommendedAction === 'rollback-and-revise' && this._replanFn) {
          this.emit('replan-triggered', { iteration: i + 1, score, feedback: reflection.feedback });
          try {
            currentOutput = await this._replanFn(currentOutput, reflection.feedback);
          } catch (replanErr) {
            debug('ReflectionLoop', 'execute:replan', replanErr);
          }
          continue;
        }

        // 常规修订
        try {
          currentOutput = await this._revisionFn(currentOutput, reflection.feedback);
        } catch (revisionErr) {
          debug('ReflectionLoop', 'execute:revision', revisionErr);
          break;
        }
      } catch (reflectionErr) {
        debug('ReflectionLoop', 'execute:reflection', reflectionErr);
        break;
      }
    }

    return { finalOutput: currentOutput, iterations, converged, qualityHistory };
  }
}

// ─── AgenticPatterns ───────────────────────────────────────────────────────────

/**
 * @module runtime/patterns/agentic-patterns
 * 智能体设计模式集合 — 融合自Agentic Design Patterns分析中的4个最高优先级增强。
 * 组合验证门禁、回退路由、并发控制和反思循环四大子组件，
 * 为智能体工作流提供质量保障、容错路由、并行加速和自我改进能力。
 */

/**
 * @classdesc 智能体设计模式集合。组合四大子组件提供完整的智能体增强能力：
 * - ValidationGate: 链式步骤中间质量验证
 * - FallbackRouter: 无匹配时的回退路由策略
 * - ConcurrencyController: 带并发限制的并行执行
 * - ReflectionLoop: 自我反思驱动的修订循环
 *
 * @extends EventEmitter
 * @mixin withShutdown
 * @emits 'validation-passed' 委托自 ValidationGate
 * @emits 'validation-failed' 委托自 ValidationGate
 * @emits 'validation-retried' 委托自 ValidationGate
 * @emits 'fallback-triggered' 委托自 FallbackRouter
 * @emits 'fallback-resolved' 委托自 FallbackRouter
 * @emits 'task-started' 委托自 ConcurrencyController
 * @emits 'task-completed' 委托自 ConcurrencyController
 * @emits 'task-failed' 委托自 ConcurrencyController
 * @emits 'task-retried' 委托自 ConcurrencyController
 * @emits 'reflection-iteration' 委托自 ReflectionLoop
 * @emits 'convergence-detected' 委托自 ReflectionLoop
 * @emits 'replan-triggered' 委托自 ReflectionLoop
 */
class AgenticPatterns extends EventEmitter {
  /**
   * 创建 AgenticPatterns 实例。
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.validationGate] - ValidationGate 配置
   * @param {Object} [options.fallbackRouter] - FallbackRouter 配置
   * @param {Object} [options.concurrencyController] - ConcurrencyController 配置
   * @param {Object} [options.reflectionLoop] - ReflectionLoop 配置
   */
  constructor(options) {
    super();
    const opts = options ?? {};

    this._validationGate = new ValidationGate(opts.validationGate);
    this._fallbackRouter = new FallbackRouter(opts.fallbackRouter);
    this._concurrencyController = new ConcurrencyController(opts.concurrencyController);

    // ReflectionLoop 需要 reflectionFn 和 revisionFn，延迟创建或使用占位
    this._reflectionLoopOptions = opts.reflectionLoop ?? {};
    this._reflectionLoop = null;

    this._forwardEvents();
  }

  /**
   * 获取验证门禁实例。
   * @type {ValidationGate}
   */
  get validationGate() {
    return this._validationGate;
  }

  /**
   * 获取回退路由器实例。
   * @type {FallbackRouter}
   */
  get fallbackRouter() {
    return this._fallbackRouter;
  }

  /**
   * 获取并发控制器实例。
   * @type {ConcurrencyController}
   */
  get concurrencyController() {
    return this._concurrencyController;
  }

  /**
   * 获取反思循环实例。
   * @type {ReflectionLoop|null}
   */
  get reflectionLoop() {
    return this._reflectionLoop;
  }

  /**
   * 初始化反思循环（因需要必需的 reflectionFn 和 revisionFn 参数）。
   * @param {Object} options - ReflectionLoop 配置选项
   * @param {Function} options.reflectionFn - 反思函数
   * @param {Function} options.revisionFn - 修订函数
   * @param {Function} [options.replanFn] - 重新规划函数
   * @param {number} [options.maxIterations] - 最大迭代次数
   * @param {number} [options.convergenceThreshold] - 收敛阈值
   * @throws {TypeError} reflectionFn 或 revisionFn 缺失时抛出
   */
  initReflectionLoop(options) {
    const mergedOptions = { ...this._reflectionLoopOptions, ...(options ?? {}) };
    this._reflectionLoop = new ReflectionLoop(mergedOptions);
    this._forwardReflectionEvents();
  }

  /**
   * 便捷方法：验证步骤输出质量。
   * @param {*} output - 步骤输出
   * @param {string} stepName - 步骤名称
   * @returns {{ passed: boolean, score: number, reason: string }} 验证结果
   */
  validate(output, stepName) {
    return this._validationGate.validate(output, stepName);
  }

  /**
   * 便捷方法：注册步骤验证函数。
   * @param {string} stepName - 步骤名称
   * @param {Function} validatorFn - 验证函数
   */
  registerValidator(stepName, validatorFn) {
    this._validationGate.registerValidator(stepName, validatorFn);
  }

  /**
   * 便捷方法：处理无匹配的查询。
   * @param {string} query - 用户查询
   * @param {Array} candidates - 候选技能列表
   * @returns {{ resolved: boolean, strategy: string, result: * }} 回退处理结果
   */
  handleNoMatch(query, candidates) {
    return this._fallbackRouter.handleNoMatch(query, candidates);
  }

  /**
   * 便捷方法：注册回退处理器。
   * @param {Function} handlerFn - 回退处理函数
   */
  registerFallback(handlerFn) {
    this._fallbackRouter.registerFallback(handlerFn);
  }

  /**
   * 便捷方法：并发执行任务。
   * @param {Array<*>} tasks - 任务列表
   * @param {Function} executeFn - 执行函数
   * @returns {Promise<Array>} 全部任务结果
   */
  async executeAll(tasks, executeFn) {
    return this._concurrencyController.executeAll(tasks, executeFn);
  }

  /**
   * 便捷方法：执行反思循环。
   * @param {*} initialOutput - 初始输出
   * @returns {Promise<{finalOutput: *, iterations: number, converged: boolean, qualityHistory: Array<number>}>} 循环结果
   * @throws {Error} 反思循环未初始化时抛出
   */
  async reflect(initialOutput) {
    if (!this._reflectionLoop) {
      throw new Error('反思循环未初始化，请先调用 initReflectionLoop()');
    }
    return this._reflectionLoop.execute(initialOutput);
  }

  /**
   * 转发子组件事件到主实例。
   * @private
   */
  _forwardEvents() {
    const forward = (emitter, events) => {
      for (const event of events) {
        emitter.on(event, (...args) => {
          safeCall(() => this.emit(event, ...args), 'AgenticPatterns', `forward:${event}`);
        });
      }
    };

    forward(this._validationGate, ['validation-passed', 'validation-failed', 'validation-retried']);
    forward(this._fallbackRouter, ['fallback-triggered', 'fallback-resolved']);
    forward(this._concurrencyController, ['task-started', 'task-completed', 'task-failed', 'task-retried']);
  }

  /**
   * 转发反思循环事件。
   * @private
   */
  _forwardReflectionEvents() {
    if (!this._reflectionLoop) return;
    const events = ['reflection-iteration', 'convergence-detected', 'replan-triggered'];
    for (const event of events) {
      this._reflectionLoop.on(event, (...args) => {
        safeCall(() => this.emit(event, ...args), 'AgenticPatterns', `forward:${event}`);
      });
    }
  }

  /**
   * 优雅关闭回调，由withShutdown混入在关闭时自动调用。
   * @private
   */
  _onShutdown() {
    this._validationGate.removeAllListeners();
    this._fallbackRouter.removeAllListeners();
    this._concurrencyController.removeAllListeners();
    if (this._reflectionLoop) {
      this._reflectionLoop.removeAllListeners();
    }
    this._reflectionLoop = null;
    this._reflectionLoopOptions = {};
    this.removeAllListeners();
  }
}

AgenticPatterns.ValidationGate = ValidationGate;
AgenticPatterns.FallbackRouter = FallbackRouter;
AgenticPatterns.ConcurrencyController = ConcurrencyController;
AgenticPatterns.ReflectionLoop = ReflectionLoop;

AgenticPatterns.DEFAULT_QUALITY_THRESHOLD = DEFAULT_QUALITY_THRESHOLD;
AgenticPatterns.DEFAULT_MAX_RETRIES = DEFAULT_MAX_RETRIES;
AgenticPatterns.DEFAULT_MAX_CONCURRENCY = DEFAULT_MAX_CONCURRENCY;
AgenticPatterns.DEFAULT_MAX_ITERATIONS = DEFAULT_MAX_ITERATIONS;
AgenticPatterns.DEFAULT_CONVERGENCE_THRESHOLD = DEFAULT_CONVERGENCE_THRESHOLD;

module.exports = withShutdown(AgenticPatterns);
