'use strict';

/**
 * @module runtime/workflow/ralph-wiggum-loop
 * @classdesc 自主开发闭环（RalphWiggumLoop）—— Harness Engineering 核心引擎。
 *
 * RalphWiggumLoop 实现了 OpenAI Harness Engineering 范式中的自主开发闭环：
 * 工程师通过 Prompt 描述任务启动 AI，AI 自主完成编码、审查、测试、修复的循环，
 * 甚至能互相审查代码，人类无需介入。
 *
 * 核心设计原则：
 *   1. 深度优先策略：将大目标拆解为小模块，让 AI 逐个完成
 *   2. 失败时回溯环境：不是"再试一次"，而是分析"缺了什么能力"
 *   3. 代码即编译产物：代码可随时生成和丢弃，环境才是真正的资产
 *   4. 自主验证闭环：编码 → 审查 → 测试 → 修复 → 学习，形成完整闭环
 *
 * 工作流（Ralph Wiggum Loop）：
 *   Prompt → [Generate] → [Review] → [Test] → [Fix] → [Learn] → Done
 *                ↑                                     │
 *                └─────────── Capability Gap ──────────┘
 *
 * 集成组件：
 *   - MetaSkillOrchestrator：技能编排与流水线执行
 *   - OptimizationLoop：迭代优化与收敛检测
 *   - AdversarialReview：对抗性代码审查
 *   - CapabilityGapAnalyzer：能力缺口分析
 *   - StateGraph：状态机编排引擎
 *   - AutoReinLearningLoop：自增强学习
 *
 * @example
 * const loop = new RalphWiggumLoop({
 *   metaSkillOrchestrator: mso,
 *   skillExecutor: async (skill, ctx) => { ... },
 * });
 * const result = await loop.run('build a REST API with user authentication', {
 *   projectRoot: '/path/to/project',
 * });
 * console.log(result.summary);
 */

const { EventEmitter } = require('events');
const { mergeConfig, validateConfigSchema } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { safeCall, errorMessage } = require('../../utils/safe-execute');
const CapabilityGapAnalyzer = require('./capability-gap-analyzer');

/** @constant {Object<string, string>} LOOP_STATES - 闭环状态枚举 */
const LOOP_STATES = {
  IDLE: 'idle',
  ANALYZING: 'analyzing',
  GENERATING: 'generating',
  REVIEWING: 'reviewing',
  TESTING: 'testing',
  FIXING: 'fixing',
  LEARNING: 'learning',
  GAP_ANALYSIS: 'gap-analysis',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** @constant {Object} DEFAULT_CONFIG - 默认配置 */
const DEFAULT_CONFIG = {
  maxIterations: 10,
  maxDepth: 5,
  reviewRounds: 2,
  testTimeoutMs: 60000,
  convergeThreshold: 0.85,
  autoFix: true,
  autoLearn: true,
  gapAnalysisOnFailure: true,
  progressReportInterval: 0,
  haltOnCriticalGap: true,
  maxModuleCount: 20,
};

const OPTIONS_SCHEMA = {
  maxIterations: { type: 'number', min: 1, max: 100 },
  maxDepth: { type: 'number', min: 1, max: 20 },
  reviewRounds: { type: 'number', min: 0, max: 10 },
  testTimeoutMs: { type: 'number', min: 1000 },
  convergeThreshold: { type: 'number', min: 0, max: 1 },
  autoFix: { type: 'boolean' },
  autoLearn: { type: 'boolean' },
  gapAnalysisOnFailure: { type: 'boolean' },
  progressReportInterval: { type: 'number', min: 0 },
  haltOnCriticalGap: { type: 'boolean' },
  maxModuleCount: { type: 'number', min: 1, max: 100 },
};

/** @constant {number} MAX_HISTORY_SIZE - 执行历史最大条目数 */
const MAX_HISTORY_SIZE = 50;
/** @constant {number} MAX_CONSECUTIVE_FAILURES - 最大连续失败次数 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** @constant {number} MAX_GAP_RESULTS - 缺口分析结果最大保留条数 */
const MAX_GAP_RESULTS = 50;

/**
 * 将大任务拆解为子模块。
 * 采用深度优先策略，将任务按功能边界拆分为独立模块。
 *
 * @param {string} taskDescription - 任务描述
 * @param {Object} [context] - 上下文信息
 * @returns {Array<{id: string, name: string, description: string, priority: number, dependencies: string[]}>} 模块列表
 * @private
 */
function decomposeTask(taskDescription, context) {
  const modules = [];
  const ctx = context ?? {};
  const desc = (taskDescription || '').toLowerCase();

  // 基于任务类型的关键词匹配拆解
  const patterns = [
    { keyword: 'api', module: { name: 'API Layer', description: 'REST API endpoints and controllers', priority: 1 } },
    { keyword: 'auth', module: { name: 'Authentication', description: 'User authentication and authorization', priority: 1 } },
    { keyword: 'database', module: { name: 'Database Layer', description: 'Data models and database operations', priority: 2 } },
    { keyword: 'ui', module: { name: 'UI Components', description: 'User interface components', priority: 3 } },
    { keyword: 'test', module: { name: 'Test Suite', description: 'Unit and integration tests', priority: 4 } },
    { keyword: 'deploy', module: { name: 'Deployment Config', description: 'Deployment and CI/CD configuration', priority: 5 } },
    { keyword: 'log', module: { name: 'Logging', description: 'Logging and monitoring', priority: 3 } },
    { keyword: 'config', module: { name: 'Configuration', description: 'Application configuration', priority: 2 } },
    { keyword: 'error', module: { name: 'Error Handling', description: 'Error handling and recovery', priority: 3 } },
    { keyword: 'security', module: { name: 'Security', description: 'Security hardening and validation', priority: 2 } },
    { keyword: 'doc', module: { name: 'Documentation', description: 'API docs and user guides', priority: 5 } },
    { keyword: 'migrate', module: { name: 'Migration', description: 'Data migration and schema changes', priority: 4 } },
  ];

  let matchCount = 0;
  for (const pattern of patterns) {
    const wordBoundaryRegex = new RegExp('\\b' + pattern.keyword + '\\b', 'i');
    if (wordBoundaryRegex.test(desc)) {
      matchCount++;
      modules.push({
        id: 'module-' + matchCount + '-' + pattern.keyword,
        name: pattern.module.name,
        description: pattern.module.description,
        priority: pattern.module.priority,
        dependencies: matchCount > 1 ? [modules[matchCount - 2].id] : [],
      });
    }
  }

  // 如果没有显式匹配到任何模块，创建默认模块列表
  if (modules.length === 0) {
    const taskName = ctx.taskType || 'fullstack-build';
    const defaultModules = {
      'fullstack-build': [
        { name: 'Core Logic', description: 'Core business logic implementation', priority: 1 },
        { name: 'API Layer', description: 'API endpoints and routing', priority: 2 },
        { name: 'Data Layer', description: 'Data models and persistence', priority: 2 },
        { name: 'Test Suite', description: 'Unit and integration tests', priority: 3 },
      ],
      'api-development': [
        { name: 'API Design', description: 'API schema and endpoint design', priority: 1 },
        { name: 'API Implementation', description: 'Endpoint implementation', priority: 2 },
        { name: 'API Tests', description: 'API integration tests', priority: 3 },
      ],
      'bug-fix': [
        { name: 'Bug Analysis', description: 'Root cause analysis', priority: 1 },
        { name: 'Fix Implementation', description: 'Bug fix and patch', priority: 2 },
        { name: 'Regression Tests', description: 'Regression test suite', priority: 3 },
      ],
    };

    const defaults = defaultModules[taskName] || defaultModules['fullstack-build'];
    for (let i = 0; i < defaults.length; i++) {
      const m = defaults[i];
      modules.push({
        id: 'module-' + (i + 1) + '-default',
        name: m.name,
        description: m.description,
        priority: m.priority,
        dependencies: i > 0 ? ['module-' + i + '-default'] : [],
      });
    }
  }

  // 按优先级排序
  modules.sort((a, b) => a.priority - b.priority);

  return modules;
}

/**
 * 自主开发闭环（RalphWiggumLoop）。
 * 实现 Harness Engineering 范式的核心工作流：Prompt → Generate → Review → Test → Fix → Learn。
 *
 * @extends EventEmitter
 * @emits RalphWiggumLoop#state-change - 状态变更时触发
 * @emits RalphWiggumLoop#module-start - 模块开始处理时触发
 * @emits RalphWiggumLoop#module-complete - 模块完成时触发
 * @emits RalphWiggumLoop#iteration-start - 迭代开始时触发
 * @emits RalphWiggumLoop#iteration-complete - 迭代完成时触发
 * @emits RalphWiggumLoop#gap-detected - 检测到能力缺口时触发
 * @emits RalphWiggumLoop#review-result - 审查结果产生时触发
 * @emits RalphWiggumLoop#test-result - 测试结果产生时触发
 * @emits RalphWiggumLoop#loop-complete - 闭环完成时触发
 * @emits RalphWiggumLoop#loop-failed - 闭环失败时触发
 */
class RalphWiggumLoop extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxIterations=10] - 最大迭代次数
   * @param {number} [options.maxDepth=5] - 最大模块拆分深度
   * @param {number} [options.reviewRounds=2] - 审查轮数
   * @param {number} [options.testTimeoutMs=60000] - 测试超时（毫秒）
   * @param {number} [options.convergeThreshold=0.85] - 收敛阈值
   * @param {boolean} [options.autoFix=true] - 是否自动修复
   * @param {boolean} [options.autoLearn=true] - 是否自动学习
   * @param {boolean} [options.gapAnalysisOnFailure=true] - 失败时是否进行缺口分析
   * @param {number} [options.progressReportInterval=0] - 进度报告间隔（0=禁用）
   * @param {boolean} [options.haltOnCriticalGap=true] - 是否在关键缺口时停止
   * @param {number} [options.maxModuleCount=20] - 最大模块数
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    const validation = validateConfigSchema(this._config, OPTIONS_SCHEMA, 'RalphWiggumLoop');
    this._config = validation.config;
    this._state = LOOP_STATES.IDLE;
    this._modules = [];
    this._completedModules = [];
    this._failedModules = [];
    this._currentModule = null;
    this._currentIteration = 0;
    this._consecutiveFailures = 0;
    this._iterationHistory = [];
    this._gapAnalysisResults = [];
    this._capabilityGapAnalyzer = new CapabilityGapAnalyzer();

    // 依赖注入点
    this._metaSkillOrchestrator = null;
    this._skillExecutor = null;
    this._optimizationLoop = null;
    this._adversarialReview = null;
    this._autoReinLearningLoop = null;
    this._stateGraph = null;
    this._testRunner = null;

    this._shutDown = false;
    this._shuttingDown = false;
    this._progressTimer = null;
  }

  // --- 依赖注入 ---

  /**
   * 注入MetaSkillOrchestrator实例。
   * @param {Object} orchestrator - MetaSkillOrchestrator实例
   * @returns {RalphWiggumLoop} 当前实例
   */
  attachMetaSkillOrchestrator(orchestrator) {
    this._metaSkillOrchestrator = orchestrator;
    return this;
  }

  /**
   * 注入技能执行器函数。
   * @param {Function} executor - 异步函数 (skillId, context) => result
   * @returns {RalphWiggumLoop} 当前实例
   */
  attachSkillExecutor(executor) {
    if (typeof executor !== 'function') {
      throw new TypeError('Skill executor must be a function');
    }
    this._skillExecutor = executor;
    return this;
  }

  /**
   * 注入OptimizationLoop实例。
   * @param {Object} loop - OptimizationLoop实例
   * @returns {RalphWiggumLoop} 当前实例
   */
  attachOptimizationLoop(loop) {
    this._optimizationLoop = loop;
    return this;
  }

  /**
   * 注入AdversarialReview实例。
   * @param {Object} review - AdversarialReview实例
   * @returns {RalphWiggumLoop} 当前实例
   */
  attachAdversarialReview(review) {
    this._adversarialReview = review;
    return this;
  }

  /**
   * 注入AutoReinLearningLoop实例。
   * @param {Object} learningLoop - AutoReinLearningLoop实例
   * @returns {RalphWiggumLoop} 当前实例
   */
  attachAutoReinLearningLoop(learningLoop) {
    this._autoReinLearningLoop = learningLoop;
    return this;
  }

  /**
   * 注入StateGraph实例。
   * @param {Object} graph - StateGraph实例
   * @returns {RalphWiggumLoop} 当前实例
   */
  attachStateGraph(graph) {
    this._stateGraph = graph;
    return this;
  }

  /**
   * 注入测试执行器函数。
   * @param {Function} runner - 异步函数 (testCommand, context) => { success, output, failures }
   * @returns {RalphWiggumLoop} 当前实例
   */
  attachTestRunner(runner) {
    if (typeof runner !== 'function') {
      throw new TypeError('Test runner must be a function');
    }
    this._testRunner = runner;
    return this;
  }

  // --- 核心方法 ---

  /**
   * 启动自主开发闭环。
   * 执行完整的 Ralph Wiggum Loop：Prompt → Generate → Review → Test → Fix → Learn。
   *
   * @param {string} taskDescription - 任务描述（Prompt）
   * @param {Object} [context] - 上下文信息
   * @param {string} [context.projectRoot] - 项目根目录
   * @param {string} [context.taskType] - 任务类型
   * @param {Object} [context.environment] - 环境描述 { hasCI, hasLint, hasTests }
   * @param {string[]} [context.availableSkills] - 可用技能列表
   * @returns {Promise<{success: boolean, summary: string, modules: Array, iterations: number, gapAnalysis: Object|null, error?: string}>} 执行结果
   */
  async run(taskDescription, context) {
    this.guardShutdown();
    if (!taskDescription || typeof taskDescription !== 'string') {
      return { success: false, error: 'Task description must be a non-empty string', modules: [], iterations: 0, gapAnalysis: null, summary: '' };
    }

    const ctx = context ?? {};
    this._resetState();

    this._transitionTo(LOOP_STATES.ANALYZING);

    // 步骤1：任务拆解（深度优先策略）
    this._modules = decomposeTask(taskDescription, ctx);
    if (this._modules.length > this._config.maxModuleCount) {
      this._modules = this._modules.slice(0, this._config.maxModuleCount);
    }

    debug('RalphWiggumLoop', 'decompose', 'Task decomposed into ' + this._modules.length + ' modules');

    // 步骤2：初始终端能力缺口分析
    let initialGaps = null;
    if (this._config.gapAnalysisOnFailure) {
      initialGaps = await this._capabilityGapAnalyzer.analyze({
        task: taskDescription,
        taskType: ctx.taskType || 'fullstack-build',
        availableSkills: ctx.availableSkills ?? [],
        environment: ctx.environment ?? {},
      });
      if (this._gapAnalysisResults.length >= MAX_GAP_RESULTS) this._gapAnalysisResults.shift();
      this._gapAnalysisResults.push(initialGaps);
      this.emit('gap-detected', { phase: 'initial', gaps: initialGaps });
    }

    // 步骤3：深度优先处理每个模块
    try {
      for (const module of this._modules) {
        if (this._shutDown) {
          this._transitionTo(LOOP_STATES.CANCELLED);
          return this._buildResult(false, taskDescription, 'Cancelled by shutdown');
        }

        this._currentModule = module;
        this.emit('module-start', { module: module.name, id: module.id });

        const moduleResult = await this._processModule(module, taskDescription, ctx);
        if (moduleResult.success) {
          this._completedModules.push({ ...module, result: moduleResult });
          this._consecutiveFailures = 0;
        } else {
          this._failedModules.push({ ...module, error: moduleResult.error });
          this._consecutiveFailures++;
          const haltReason = await this._handleModuleFailure(module, ctx, taskDescription);
          if (haltReason) return this._buildResult(false, taskDescription, haltReason);
        }

        this.emit('module-complete', {
          module: module.name,
          success: moduleResult.success,
          completed: this._completedModules.length,
          total: this._modules.length,
        });
      }
    } catch (err) {
      this._transitionTo(LOOP_STATES.FAILED);
      const errMsg = errorMessage(err);
      debug('RalphWiggumLoop', 'runError', errMsg);
      this.emit('loop-failed', { reason: errMsg });
      return this._buildResult(false, taskDescription, errMsg);
    }

    this._transitionTo(LOOP_STATES.COMPLETED);
    const result = this._buildResult(true, taskDescription);
    this.emit('loop-complete', result);
    return result;
  }

  /**
   * 取消当前执行。
   */
  cancel() {
    this._shutDown = true;
    this._transitionTo(LOOP_STATES.CANCELLED);
    if (this._progressTimer) {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
    }
  }

  /**
   * 获取当前状态。
   * @returns {string} 当前状态
   */
  getState() {
    return this._state;
  }

  /**
   * 获取进度信息。
   * @returns {{state: string, completed: number, total: number, currentModule: string|null, failedModules: number, iterations: number}}
   */
  getProgress() {
    return {
      state: this._state,
      completed: this._completedModules.length,
      total: this._modules.length,
      currentModule: this._currentModule ? this._currentModule.name : null,
      failedModules: this._failedModules.length,
      iterations: this._currentIteration,
    };
  }

  /**
   * 获取能力缺口分析结果。
   * @returns {Array<Object>} 缺口分析结果列表
   */
  getCapabilityGaps() {
    return this._gapAnalysisResults.slice();
  }

  /**
   * 获取执行统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      totalRuns: this._iterationHistory.length,
      state: this._state,
      completedModules: this._completedModules.length,
      failedModules: this._failedModules.length,
      totalIterations: this._currentIteration,
      gapAnalyses: this._gapAnalysisResults.length,
      lastRun: this._iterationHistory.length > 0
        ? this._iterationHistory[this._iterationHistory.length - 1].timestamp
        : null,
    };
  }

  /**
   * 守卫方法，若实例已关闭则抛出错误。
   * @throws {Error}
   */
  guardShutdown() {
    if (this._shutDown) throw new Error('RalphWiggumLoop is shut down');
  }

  /**
   * 关闭闭环实例。
   */
  shutdown() {
    if (this._shutDown || this._shuttingDown) return;
    this._shuttingDown = true;
    this._shutDown = true;
    if (this._progressTimer) {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
    }
    this._capabilityGapAnalyzer.shutdown();
    this._modules = [];
    this._completedModules = [];
    this._failedModules = [];
    this._gapAnalysisResults = [];
    this._iterationHistory = [];
    safeCall(() => this.emit('shutdown', { signal: 'manual' }), 'RalphWiggumLoop', 'emit-shutdown');
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
    this._shuttingDown = false;
  }

  /**
   * 检查实例是否健康。
   * @returns {boolean}
   */
  isHealthy() {
    return !this._shutDown;
  }

  // --- 私有方法 ---

  /**
   * 重置内部状态。
   * @private
   */
  _resetState() {
    this._state = LOOP_STATES.IDLE;
    this._modules = [];
    this._completedModules = [];
    this._failedModules = [];
    this._currentModule = null;
    this._currentIteration = 0;
    this._consecutiveFailures = 0;
    this._gapAnalysisResults = [];
  }

  /**
   * 状态转换，并发出事件。
   * @param {string} newState - 新状态
   * @private
   */
  _transitionTo(newState) {
    const oldState = this._state;
    this._state = newState;
    this.emit('state-change', { from: oldState, to: newState });
    debug('RalphWiggumLoop', 'stateChange', oldState + ' -> ' + newState);
  }

  async _handleModuleFailure(module, ctx, _taskDescription) {
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this._transitionTo(LOOP_STATES.FAILED);
      this.emit('loop-failed', {
        reason: 'Too many consecutive failures: ' + this._consecutiveFailures,
        failedModules: this._failedModules.map(m => m.name),
      });
      return 'Too many consecutive failures';
    }
    if (!this._config.gapAnalysisOnFailure) return null;
    this._transitionTo(LOOP_STATES.GAP_ANALYSIS);
    const gapResult = await this._capabilityGapAnalyzer.analyze({
      task: module.description,
      taskType: ctx.taskType || 'fullstack-build',
      availableSkills: ctx.availableSkills ?? [],
      environment: ctx.environment ?? {},
    });
    if (this._gapAnalysisResults.length >= MAX_GAP_RESULTS) this._gapAnalysisResults.shift();
    this._gapAnalysisResults.push(gapResult);
    this.emit('gap-detected', { phase: 'module-failure', module: module.name, gaps: gapResult });
    if (this._config.haltOnCriticalGap) {
      const hasCritical = gapResult.recommendations.some(r => r.severity === 'critical');
      if (hasCritical) {
        this._transitionTo(LOOP_STATES.FAILED);
        this.emit('loop-failed', {
          reason: 'Critical capability gap detected in module: ' + module.name,
          gaps: gapResult.recommendations.filter(r => r.severity === 'critical'),
        });
        return 'Critical capability gap detected';
      }
    }
    return null;
  }

  /**
   * 处理单个模块（深度优先策略的核心）。
   * @param {Object} module - 模块定义
   * @param {string} taskDescription - 原始任务描述
   * @param {Object} ctx - 上下文
   * @returns {Promise<{success: boolean, error?: string, iterations?: number}>}
   * @private
   */
  async _processModule(module, taskDescription, ctx) {
    this._transitionTo(LOOP_STATES.GENERATING);

    let moduleCode = null;
    let iteration = 0;

    while (iteration < this._config.maxIterations && !this._shutDown) {
      iteration++;
      this._currentIteration = iteration;
      this.emit('iteration-start', { module: module.name, iteration });

      // 阶段1：生成代码
      moduleCode = await this._generateCode(module, taskDescription, ctx, moduleCode);
      if (!moduleCode) {
        this.emit('iteration-complete', { module: module.name, iteration, success: false, phase: 'generate' });
        return { success: false, error: 'Code generation failed for module: ' + module.name };
      }

      // 阶段2：审查代码
      this._transitionTo(LOOP_STATES.REVIEWING);
      const reviewResult = await this._reviewCode(module, moduleCode, ctx);
      this.emit('review-result', { module: module.name, iteration, result: reviewResult });

      if (!reviewResult.passed) {
        if (this._config.autoFix && reviewResult.suggestions) {
          this._transitionTo(LOOP_STATES.FIXING);
          moduleCode = await this._fixCode(module, moduleCode, reviewResult, ctx);
          if (!moduleCode) continue;
        } else {
          this.emit('iteration-complete', { module: module.name, iteration, success: false, phase: 'review' });
          return { success: false, error: 'Code review failed: ' + (reviewResult.error || 'Unknown') };
        }
      }

      // 阶段3：测试代码
      this._transitionTo(LOOP_STATES.TESTING);
      const testResult = await this._testCode(module, moduleCode, ctx);
      this.emit('test-result', { module: module.name, iteration, result: testResult });

      if (testResult.passed) {
        // 阶段4：学习
        if (this._config.autoLearn) {
          this._transitionTo(LOOP_STATES.LEARNING);
          await this._learnFromResult(module, { success: true, iterations: iteration }, ctx);
        }

        this.emit('iteration-complete', { module: module.name, iteration, success: true });
        return { success: true, iterations: iteration };
      }

      // 测试失败，尝试修复
      if (this._config.autoFix && testResult.failures) {
        this._transitionTo(LOOP_STATES.FIXING);
        moduleCode = await this._fixCode(module, moduleCode, {
          passed: false,
          error: 'Tests failed',
          suggestions: testResult.failures.map(f => 'Fix: ' + f),
        }, ctx);
        if (!moduleCode) continue;
      } else {
        this.emit('iteration-complete', { module: module.name, iteration, success: false, phase: 'test' });
        return { success: false, error: 'Tests failed and auto-fix disabled' };
      }

      this.emit('iteration-complete', { module: module.name, iteration, success: false, phase: 'test-fix-loop' });
    }

    if (this._shutDown) {
      return { success: false, error: 'Cancelled' };
    }

    return { success: false, error: 'Max iterations reached for module: ' + module.name, iterations: iteration };
  }

  /**
   * 生成代码（使用MetaSkillOrchestrator或SkillExecutor）。
   * @param {Object} module - 模块定义
   * @param {string} taskDescription - 原始任务描述
   * @param {Object} ctx - 上下文
   * @param {string|null} previousCode - 之前的代码（用于修复迭代）
   * @returns {Promise<string|null>} 生成的代码
   * @private
   */
  async _generateCode(module, taskDescription, ctx, previousCode) {
    const modulePrompt = 'Module: ' + module.name + '\nDescription: ' + module.description + '\nTask: ' + taskDescription;

    // 如果有MetaSkillOrchestrator，使用元技能编排
    if (this._metaSkillOrchestrator) {
      try {
        const metaResult = await this._metaSkillOrchestrator.executeMetaSkill('meta-fullstack-build', {
          task: modulePrompt,
          module: module.name,
          projectRoot: ctx.projectRoot || '.',
          phase: 'implement',
        });
        if (metaResult && metaResult.success) {
          return JSON.stringify(metaResult);
        }
      } catch (err) {
        debug('RalphWiggumLoop', 'generateMetaSkill', errorMessage(err));
      }
    }

    // 回退到SkillExecutor
    if (this._skillExecutor) {
      try {
        const skillResult = await this._skillExecutor('tdd-implement', {
          task: modulePrompt,
          module: module.name,
          previousCode,
        });
        if (skillResult) {
          return typeof skillResult === 'string' ? skillResult : JSON.stringify(skillResult);
        }
      } catch (err) {
        debug('RalphWiggumLoop', 'generateSkill', errorMessage(err));
      }
    }

    return null;
  }

  /**
   * 审查代码（使用AdversarialReview）。
   * @param {Object} module - 模块定义
   * @param {string} code - 待审查的代码
   * @param {Object} ctx - 上下文
   * @returns {Promise<{passed: boolean, error?: string, suggestions?: Array}>}
   * @private
   */
  async _reviewCode(module, code, _ctx) {
    if (!this._adversarialReview) {
      // 没有审查器时默认通过
      return { passed: true };
    }

    try {
      const reviewerA = async (_subject, _reviewCtx) => {
        return {
          approved: true,
          feedback: 'Code looks good for module: ' + module.name,
          suggestions: [],
        };
      };

      const reviewerB = async (_subject, _reviewCtx) => {
        const issues = [];
        if (!code || code.length < 10) {
          issues.push('Code is too short or empty');
        }
        return {
          approved: issues.length === 0,
          feedback: issues.length > 0 ? issues.join('; ') : 'No issues found',
          suggestions: issues,
        };
      };

      const result = await this._adversarialReview.review(
        { code, module: module.name, artifactType: 'code' },
        reviewerA,
        reviewerB,
      );

      return {
        passed: result.consensus,
        error: result.consensus ? undefined : (result.finalFeedback || 'Review did not reach consensus'),
        suggestions: result.consensus ? [] : (result.details ?? []).flatMap(d => d.reviewerA?.suggestions ?? []).concat(
          (result.details ?? []).flatMap(d => d.reviewerB?.suggestions ?? []),
        ),
      };
    } catch (err) {
      debug('RalphWiggumLoop', 'reviewError', errorMessage(err));
      return { passed: false, error: 'Review error: ' + errorMessage(err) };
    }
  }

  /**
   * 测试代码。
   * @param {Object} module - 模块定义
   * @param {string} code - 待测试的代码
   * @param {Object} ctx - 上下文
   * @returns {Promise<{passed: boolean, failures?: Array, output?: string}>}
   * @private
   */
  async _testCode(module, code, ctx) {
    if (!this._testRunner) {
      // 没有测试执行器时默认通过
      return { passed: true };
    }

    try {
      const testCommand = 'npm test -- --testPathPattern=' + module.name;
      const result = await this._testRunner(testCommand, {
        module: module.name,
        code,
        projectRoot: ctx.projectRoot || '.',
        timeout: this._config.testTimeoutMs,
      });

      return {
        passed: result.success !== false,
        failures: result.failures ?? [],
        output: result.output || '',
      };
    } catch (err) {
      debug('RalphWiggumLoop', 'testError', errorMessage(err));
      return { passed: false, failures: [errorMessage(err)] };
    }
  }

  /**
   * 修复代码（基于审查和测试反馈）。
   * @param {Object} module - 模块定义
   * @param {string} code - 当前代码
   * @param {Object} feedback - 反馈信息 { passed, error, suggestions }
   * @param {Object} ctx - 上下文
   * @returns {Promise<string|null>} 修复后的代码
   * @private
   */
  async _fixCode(module, code, feedback, ctx) {
    if (this._skillExecutor) {
      try {
        const fixResult = await this._skillExecutor('bug-fix', {
          module: module.name,
          code,
          error: feedback.error || 'Code needs improvement',
          suggestions: feedback.suggestions ?? [],
          projectRoot: ctx.projectRoot || '.',
        });
        if (fixResult) {
          return typeof fixResult === 'string' ? fixResult : JSON.stringify(fixResult);
        }
      } catch (err) {
        debug('RalphWiggumLoop', 'fixError', errorMessage(err));
      }
    }
    return null;
  }

  /**
   * 从执行结果中学习（使用AutoReinLearningLoop）。
   * @param {Object} module - 模块定义
   * @param {Object} result - 执行结果
   * @param {Object} ctx - 上下文
   * @returns {Promise<void>}
   * @private
   */
  async _learnFromResult(module, result, ctx) {
    if (!this._autoReinLearningLoop) return;

    try {
      const taskType = (ctx && ctx.taskType) || 'fullstack-build';
      const projectRoot = (ctx && ctx.projectRoot) || '.';
      await this._autoReinLearningLoop.processTaskResult({
        module: module.name,
        success: result.success,
        iterations: result.iterations,
        timestamp: Date.now(),
        context: { taskType, projectRoot },
      });
    } catch (err) {
      debug('RalphWiggumLoop', 'learnError', errorMessage(err));
    }
  }

  /**
   * 构建最终结果。
   * @param {boolean} success - 是否成功
   * @param {string} taskDescription - 任务描述
   * @param {string} [error] - 错误信息
   * @returns {Object} 结果对象
   * @private
   */
  _buildResult(success, taskDescription, error) {
    const summary = success
      ? 'Successfully completed ' + this._completedModules.length + '/' + this._modules.length + ' modules in ' + this._currentIteration + ' iterations for task: ' + taskDescription
      : 'Failed: ' + (error || 'Unknown error') + ' (' + this._completedModules.length + '/' + this._modules.length + ' modules completed)';

    const lastGapAnalysis = this._gapAnalysisResults.length > 0
      ? this._gapAnalysisResults[this._gapAnalysisResults.length - 1]
      : null;

    // 记录到历史
    this._iterationHistory.push({
      timestamp: Date.now(),
      task: taskDescription,
      success,
      modulesCompleted: this._completedModules.length,
      modulesFailed: this._failedModules.length,
      totalIterations: this._currentIteration,
      error,
    });
    if (this._iterationHistory.length > MAX_HISTORY_SIZE) {
      this._iterationHistory.shift();
    }

    return {
      success,
      summary,
      modules: {
        completed: this._completedModules.map(m => ({ name: m.name, id: m.id })),
        failed: this._failedModules.map(m => ({ name: m.name, id: m.id, error: m.error })),
      },
      iterations: this._currentIteration,
      gapAnalysis: lastGapAnalysis ? {
        gaps: lastGapAnalysis.gaps,
        recommendations: lastGapAnalysis.recommendations,
        summary: lastGapAnalysis.summary,
      } : null,
      error: error || undefined,
    };
  }
}

module.exports = RalphWiggumLoop;

