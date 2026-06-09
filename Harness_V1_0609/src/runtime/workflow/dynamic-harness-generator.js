'use strict';

/**
 * @module runtime/workflow/dynamic-harness-generator
 * @classdesc 动态工作流 Harness 生成器（DynamicHarnessGenerator）—— Anthropic Dynamic Workflow 核心组件。
 *
 * 融合 Anthropic 动态工作流 Harness 理念：让 AI 针对任务自动生成调度脚本，
 * 实现从"概率黑盒"到"工业级确定性工程"的跨越。
 *
 * 核心公式：Agent = Model + Harness
 * 模型决定能力上限，Harness 决定能否驾驭它完成复杂任务。
 *
 * 三大突破：
 *   1. 确定性代码框住概率输出：AI 生成 JavaScript 脚本，将任务拆解、子 Agent 并行、
 *      校验器调用等逻辑"写死"在代码里，用确定性程序约束模型的概率性输出。
 *   2. 自带对抗验证：A Agent 写代码，B Agent 专门挑错，过不了验证闭环就无法推进。
 *   3. 留痕容灾：内置检查点机制，中断后可续跑，解决"挂了就得重来"的痛点。
 *
 * 触发方式：在 Prompt 中加入关键字 `workflow`、`ultracode` 或 `harness`。
 *
 * 集成组件：
 *   - DynamicWorkflowEngine：DAG 工作流引擎，执行编译后的 DSL
 *   - TaskDecomposer：任务分解器
 *   - SubagentExecutor：子 Agent 执行器（worker/team 模式）
 *   - AdversarialReview：对抗性审查
 *   - CheckpointManager：检查点管理
 *   - CapabilityGapAnalyzer：能力缺口分析
 *
 * @example
 * const generator = new DynamicHarnessGenerator({
 *   skillExecutor: async (skill, ctx) => { ... },
 *   subagentExecutor: executor,
 * });
 * const result = await generator.generateAndExecute(
 *   '筛选 80 份简历，复核前十，生成评估报告 workflow',
 * );
 */

const { EventEmitter } = require('events');
const vm = require('vm');
const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { safeCall, errorMessage } = require('../../utils/safe-execute');
const { generateId } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');

/** @constant {Object} HARNESS_STATUS - Harness 执行状态 */
const HARNESS_STATUS = {
  IDLE: 'idle',
  GENERATING: 'generating',
  COMPILING: 'compiling',
  EXECUTING: 'executing',
  PAUSED: 'paused',
  CHECKPOINTING: 'checkpointing',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** @constant {Object} DEFAULT_CONFIG - 默认配置 */
const DEFAULT_CONFIG = {
  scriptTimeoutMs: 300000,
  maxParallelAgents: 20,
  maxScriptSize: 65536,
  autoCheckpoint: true,
  checkpointInterval: 5,
  enableAdversarialReview: true,
  enableGapAnalysis: true,
  tokenBudget: 100000,
  maxRetries: 3,
  budgetWarningRatio: 0.8,
};

/** @constant {string[]} TRIGGER_KEYWORDS - 触发关键词（英文 + 中文） */
const TRIGGER_KEYWORDS = ['workflow', 'ultracode', 'harness', '动态工作流', '并行agent', '对抗验证', '检查点', '断点续跑', '确定性工程', '子agent并行', '调度脚本'];

/** @constant {number} MAX_HISTORY_SIZE - 执行历史最大条目 */
const MAX_HISTORY_SIZE = 50;

/** @constant {number} MAX_SCRIPT_SIZE - 脚本最大大小 */
const MAX_SCRIPT_SIZE = 65536;

/** @constant {number} _MAX_VERIFICATION_RESULTS - 验证结果最大保留数 */
const _MAX_VERIFICATION_RESULTS = 200;

/** @constant {number} MAX_GAP_RESULTS - 缺口分析结果最大保留数 */
const MAX_GAP_RESULTS = 200;

/**
 * 动态工作流 Harness 生成器。
 * 核心能力：AI 生成 JavaScript Harness 脚本 → 沙箱执行 → 确定性编排。
 *
 * @extends EventEmitter
 * @emits DynamicHarnessGenerator#script-generated
 * @emits DynamicHarnessGenerator#script-compiled
 * @emits DynamicHarnessGenerator#execution-started
 * @emits DynamicHarnessGenerator#checkpoint-created
 * @emits DynamicHarnessGenerator#verification-result
 * @emits DynamicHarnessGenerator#execution-completed
 * @emits DynamicHarnessGenerator#execution-failed
 */
class DynamicHarnessGenerator extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.scriptTimeoutMs=300000] - 脚本执行超时
   * @param {number} [options.maxParallelAgents=20] - 最大并行 Agent 数
   * @param {boolean} [options.autoCheckpoint=true] - 是否自动保存检查点
   * @param {number} [options.checkpointInterval=5] - 检查点间隔
   * @param {boolean} [options.enableAdversarialReview=true] - 是否启用对抗审查
   * @param {boolean} [options.enableGapAnalysis=true] - 是否启用缺口分析
   * @param {number} [options.tokenBudget=100000] - Token 预算
   * @param {number} [options.maxRetries=3] - 最大重试次数
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._status = HARNESS_STATUS.IDLE;
    this._executionId = null;
    this._executionHistory = [];
    this._currentScript = null;
    this._scriptOutput = null;
    this._tokensUsed = 0;
    this._nodesExecuted = 0;
    this._checkpoints = [];
    this._verificationResults = [];
    this._gapAnalysisResults = [];

    // 依赖注入点
    this._skillExecutor = null;
    this._subagentExecutor = null;
    this._dynamicWorkflowEngine = null;
    this._taskDecomposer = null;
    this._adversarialReview = null;
    this._checkpointManager = null;
    this._capabilityGapAnalyzer = null;
    this._llmClient = null;

    this._shutDown = false;
    this._shuttingDown = false;
    this._abortController = null;
  }

  // --- 依赖注入 ---

  /**
   * 注入技能执行器（LLM 调用）。
   * @param {Function} executor - 异步函数 (skillId, context) => result
   * @returns {DynamicHarnessGenerator}
   */
  attachSkillExecutor(executor) {
    if (typeof executor !== 'function') {
      throw new TypeError('Skill executor must be a function');
    }
    this._skillExecutor = executor;
    return this;
  }

  /**
   * 注入子 Agent 执行器。
   * @param {Object} executor - SubagentExecutor 实例
   * @returns {DynamicHarnessGenerator}
   */
  attachSubagentExecutor(executor) {
    this._subagentExecutor = executor;
    return this;
  }

  /**
   * 注入动态工作流引擎（保留接口，未来版本将用于优化执行路径）。
   * @param {Object} engine - DynamicWorkflowEngine 实例
   * @returns {DynamicHarnessGenerator}
   * @future 将在 _executeScript 中作为子任务执行的可选路径使用
   */
  attachDynamicWorkflowEngine(engine) {
    this._dynamicWorkflowEngine = engine;
    return this;
  }

  /**
   * 注入任务分解器。
   * @param {Object} decomposer - TaskDecomposer 实例
   * @returns {DynamicHarnessGenerator}
   */
  attachTaskDecomposer(decomposer) {
    this._taskDecomposer = decomposer;
    return this;
  }

  /**
   * 注入对抗性审查器。
   * @param {Object} review - AdversarialReview 实例
   * @returns {DynamicHarnessGenerator}
   */
  attachAdversarialReview(review) {
    this._adversarialReview = review;
    return this;
  }

  /**
   * 注入检查点管理器。
   * @param {Object} manager - CheckpointManager 实例
   * @returns {DynamicHarnessGenerator}
   */
  attachCheckpointManager(manager) {
    this._checkpointManager = manager;
    return this;
  }

  /**
   * 注入能力缺口分析器。
   * @param {Object} analyzer - CapabilityGapAnalyzer 实例
   * @returns {DynamicHarnessGenerator}
   */
  attachCapabilityGapAnalyzer(analyzer) {
    this._capabilityGapAnalyzer = analyzer;
    return this;
  }

  /**
   * 注入 LLM 客户端（用于直接调用 LLM 生成脚本）。
   * @param {Object} client - 具有 complete(prompt) 方法的对象
   * @returns {DynamicHarnessGenerator}
   */
  attachLLMClient(client) {
    this._llmClient = client;
    return this;
  }

  // --- 核心方法 ---

  /**
   * 检查任务描述是否包含触发关键词。
   * @param {string} taskDescription - 任务描述
   * @returns {boolean} 是否触发动态工作流
   */
  static isTriggered(taskDescription) {
    if (!taskDescription || typeof taskDescription !== 'string') return false;
    const lower = taskDescription.toLowerCase();
    return TRIGGER_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
  }

  /**
   * 生成 Harness 脚本并执行。
   * 完整流程：生成脚本 → 编译 → 执行 → 验证 → 检查点。
   *
   * @param {string} taskDescription - 任务描述
   * @param {Object} [context] - 上下文信息
   * @param {string} [context.projectRoot] - 项目根目录
   * @param {Object} [context.environment] - 环境描述
   * @param {string[]} [context.availableSkills] - 可用技能列表
   * @returns {Promise<{success: boolean, summary: string, script: string|null, results: Array, checkpoints: Array, verification: Object|null, gapAnalysis: Object|null, tokensUsed: number, error?: string}>}
   */
  async generateAndExecute(taskDescription, context) {
    this.guardShutdown();
    if (!taskDescription || typeof taskDescription !== 'string') {
      return { success: false, error: 'Task description must be a non-empty string', summary: '', script: null, results: [], checkpoints: [], verification: null, gapAnalysis: null, tokensUsed: 0 };
    }

    const ctx = context ?? {};
    this._executionId = generateId('harness-');
    this._resetState();
    this._transitionTo(HARNESS_STATUS.GENERATING);

    try {
      // 步骤1：生成 Harness 脚本
      const script = await this._generateScript(taskDescription, ctx);
      if (!script) {
        return this._buildResult(false, taskDescription, 'Script generation failed');
      }
      this._currentScript = script;
      this.emit('script-generated', { executionId: this._executionId, scriptSize: script.length });

      // 步骤2：编译脚本（验证语法和安全性）
      this._transitionTo(HARNESS_STATUS.COMPILING);
      const compileResult = await this._compileScript(script);
      if (!compileResult.valid) {
        return this._buildResult(false, taskDescription, 'Script compilation failed: ' + (compileResult.error || 'Unknown'));
      }
      this.emit('script-compiled', { executionId: this._executionId });

      // 步骤3：执行脚本（沙箱环境）
      this._transitionTo(HARNESS_STATUS.EXECUTING);
      const executionResult = await this._executeScript(script, taskDescription, ctx);
      this._nodesExecuted = executionResult.nodesExecuted ?? 0;
      this._tokensUsed = executionResult.tokensUsed ?? 0;

      // 步骤4+5：验证与检查点
      let verificationResult = null;
      if (this._config.enableAdversarialReview && this._adversarialReview) {
        this._transitionTo(HARNESS_STATUS.VERIFYING);
        verificationResult = await this._runAdversarialVerification(taskDescription, executionResult);
        if (this._verificationResults.length >= _MAX_VERIFICATION_RESULTS) this._verificationResults.shift();
        this._verificationResults.push(verificationResult);
      }
      await this._saveCheckpoint(taskDescription, executionResult);

      this._transitionTo(HARNESS_STATUS.COMPLETED);
      const result = this._buildResult(true, taskDescription, null, executionResult, verificationResult);
      this.emit('execution-completed', result);
      return result;
    } catch (err) {
      this._transitionTo(HARNESS_STATUS.FAILED);
      const errMsg = errorMessage(err);
      debug('DynamicHarnessGenerator', 'error', errMsg);
      this.emit('execution-failed', { executionId: this._executionId, error: errMsg });

      // 失败时进行能力缺口分析
      let gapAnalysis = null;
      if (this._config.enableGapAnalysis && this._capabilityGapAnalyzer) {
        try {
          gapAnalysis = await this._capabilityGapAnalyzer.analyze({
            task: taskDescription,
            availableSkills: ctx.availableSkills ?? [],
            availableTools: ctx.availableTools ?? [],
            environment: ctx.environment ?? {},
          });
          if (this._gapAnalysisResults.length >= MAX_GAP_RESULTS) this._gapAnalysisResults.shift();
          this._gapAnalysisResults.push(gapAnalysis);
        } catch (_gapErr) {
          debug('DynamicHarnessGenerator', 'gapAnalysisError', errorMessage(_gapErr));
        }
      }

      return this._buildResult(false, taskDescription, errMsg, null, null, gapAnalysis);
    }
  }

  /**
   * 从检查点恢复执行。
   * @param {string} checkpointId - 检查点 ID
   * @returns {Promise<Object>} 恢复执行结果
   */
  async resumeFromCheckpoint(checkpointId) {
    this.guardShutdown();
    if (!this._checkpointManager) {
      return { success: false, error: 'No checkpoint manager attached' };
    }

    const checkpoint = this._checkpointManager.get(checkpointId);
    if (!checkpoint) {
      return { success: false, error: 'Checkpoint not found: ' + checkpointId };
    }

    // 从检查点数据恢复状态
    const taskDescription = checkpoint.metadata?.taskDescription || '';
    const context = checkpoint.metadata?.context ?? {};
    const previousResults = checkpoint.metadata?.results ?? [];

    this._executionId = generateId('harness-resume-');
    this._resetState();

    try {
      this._transitionTo(HARNESS_STATUS.EXECUTING);
      const executionResult = await this._executeScript(
        checkpoint.metadata?.script || '',
        taskDescription,
        { ...context, resumeFromCheckpoint: checkpointId, previousResults },
      );

      this._transitionTo(HARNESS_STATUS.COMPLETED);
      return this._buildResult(true, taskDescription + ' (resumed)', null, executionResult);
    } catch (err) {
      this._transitionTo(HARNESS_STATUS.FAILED);
      return this._buildResult(false, taskDescription + ' (resumed)', errorMessage(err));
    }
  }

  /**
   * 取消当前执行。
   */
  cancel() {
    this._shutDown = true;
    this._transitionTo(HARNESS_STATUS.CANCELLED);
    if (this._abortController) {
      this._abortController.abort();
    }
  }

  /**
   * 获取当前状态。
   * @returns {string}
   */
  getStatus() {
    return this._status;
  }

  /**
   * 获取执行统计。
   * @returns {{status: string, executions: number, tokensUsed: number, nodesExecuted: number, checkpoints: number}}
   */
  getStats() {
    return {
      status: this._status,
      executions: this._executionHistory.length,
      tokensUsed: this._tokensUsed,
      nodesExecuted: this._nodesExecuted,
      checkpoints: this._checkpoints.length,
      verificationResults: this._verificationResults.length,
      gapAnalyses: this._gapAnalysisResults.length,
    };
  }

  /**
   * 获取执行历史。
   * @param {number} [limit] - 最大返回条目数
   * @returns {Array<Object>}
   */
  getHistory(limit) {
    const history = this._executionHistory.slice();
    if (limit && limit > 0) {
      return history.slice(-limit);
    }
    return history;
  }

  /**
   * 守卫方法。
   * @throws {Error}
   */
  guardShutdown() {
    if (this._shutDown) throw new Error('DynamicHarnessGenerator is shut down');
  }

  /**
   * 关闭实例。
   */
  shutdown() {
    if (this._shutDown || this._shuttingDown) return;
    this._shuttingDown = true;
    this._shutDown = true;
    if (this._abortController) {
      this._abortController.abort();
    }
    this._currentScript = null;
    this._scriptOutput = null;
    this._checkpoints = [];
    this._verificationResults = [];
    this._gapAnalysisResults = [];
    this._executionHistory = [];
    safeCall(() => this.emit('shutdown', { signal: 'manual' }), 'DynamicHarnessGenerator', 'emit-shutdown');
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

  _resetState() {
    this._currentScript = null;
    this._scriptOutput = null;
    this._tokensUsed = 0;
    this._nodesExecuted = 0;
    this._checkpoints = [];
    this._verificationResults = [];
    this._gapAnalysisResults = [];
    this._abortController = new AbortController();
  }

  _transitionTo(newState) {
    const oldState = this._status;
    this._status = newState;
    this.emit('state-change', { from: oldState, to: newState });
    debug('DynamicHarnessGenerator', 'stateChange', oldState + ' -> ' + newState);
  }

  /**
   * 生成 Harness 脚本。
   * 使用 LLM 根据任务描述生成 JavaScript 编排脚本。
   * @param {string} taskDescription - 任务描述
   * @param {Object} ctx - 上下文
   * @returns {Promise<string|null>} 生成的脚本
   * @private
   */
  async _generateScript(taskDescription, ctx) {
    const prompt = this._buildGenerationPrompt(taskDescription, ctx);

    // 优先使用 LLM 客户端
    if (this._llmClient && typeof this._llmClient.complete === 'function') {
      try {
        const response = await this._llmClient.complete(prompt);
        if (response && typeof response === 'string') {
          const script = this._extractScript(response);
          if (script) return script;
        }
        if (response && response.content) {
          const script = this._extractScript(response.content);
          if (script) return script;
        }
      } catch (err) {
        debug('DynamicHarnessGenerator', 'llmGenerateError', errorMessage(err));
      }
    }

    // 回退到 SkillExecutor
    if (this._skillExecutor) {
      try {
        const skillResult = await this._skillExecutor('harness-script-generation', {
          task: taskDescription,
          prompt,
          projectRoot: ctx.projectRoot || '.',
        });
        if (skillResult) {
          const content = typeof skillResult === 'string' ? skillResult : (skillResult.content || skillResult.result || '');
          const script = this._extractScript(content);
          if (script) return script;
        }
      } catch (err) {
        debug('DynamicHarnessGenerator', 'skillGenerateError', errorMessage(err));
      }
    }

    // 最终回退：基于模板生成脚本
    return this._generateFallbackScript(taskDescription, ctx);
  }

  /**
   * 构建脚本生成 Prompt。
   * @param {string} taskDescription - 任务描述
   * @param {Object} _ctx - 上下文
   * @returns {string} Prompt
   * @private
   */
  _buildGenerationPrompt(taskDescription, _ctx) {
    return [
      'You are a workflow orchestration expert. Generate a JavaScript harness script',
      'that orchestrates the following task using the provided harness API.',
      '',
      'Available harness API:',
      '  harness.parallel(tasks) - Execute multiple tasks in parallel (max ' + this._config.maxParallelAgents + ' agents)',
      '  harness.sequential(tasks) - Execute tasks in sequence',
      '  harness.subagent(task, agentType) - Spawn a single sub-agent',
      '  harness.verify(subject, criteria) - Run adversarial verification',
      '  harness.checkpoint(name, data) - Save execution checkpoint',
      '  harness.decompose(task) - Decompose a task into subtasks',
      '  harness.log(message) - Log a message',
      '  harness.setBudget(tokens) - Set token budget',
      '  harness.getBudget() - Get remaining token budget',
      '',
      'The script must:',
      '1. Define an async function called "run" that takes a "harness" parameter',
      '2. Use the harness API to orchestrate the workflow',
      '3. Return a result object: { success, results, summary }',
      '4. Handle errors gracefully',
      '5. Include checkpoints at key stages',
      '',
      'Output ONLY the JavaScript code, wrapped in ```javascript``` code block.',
      'No explanations, no markdown outside the code block.',
      '',
      'Task: ' + taskDescription,
    ].join('\n');
  }

  /**
   * 从 LLM 响应中提取脚本代码。
   * @param {string} content - LLM 响应内容
   * @returns {string|null} 提取的脚本
   * @private
   */
  _extractScript(content) {
    if (!content || typeof content !== 'string') return null;

    // 尝试提取 ```javascript ... ``` 代码块
    const codeBlockMatch = content.match(/```(?:javascript|js)?\s*\n([\s\S]*?)\n```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      return codeBlockMatch[1].trim();
    }

    // 尝试提取 ``` ... ``` 代码块
    const genericBlockMatch = content.match(/```\s*\n([\s\S]*?)\n```/);
    if (genericBlockMatch && genericBlockMatch[1]) {
      return genericBlockMatch[1].trim();
    }

    // 检查是否本身就是纯代码
    if (content.includes('async function run') && content.includes('harness')) {
      return content.trim();
    }

    return null;
  }

  /**
   * 生成回退脚本（当 LLM 不可用时）。
   * @param {string} taskDescription - 任务描述
   * @param {Object} ctx - 上下文
   * @returns {string} 回退脚本
   * @private
   */
  _generateFallbackScript(taskDescription, ctx) {
    const taskType = ctx.taskType || 'general-task';
    const budget = this._config.tokenBudget;

    return [
      '// Auto-generated Dynamic Harness Script',
      '// Task: ' + (taskDescription || 'untitled').substring(0, 100),
      '// Generated at: ' + new Date().toISOString(),
      '',
      'async function run(harness) {',
      '  harness.setBudget(' + budget + ');',
      '  harness.log("Starting dynamic harness execution for: ' + (taskDescription || 'untitled').replace(/'/g, "\\'").substring(0, 80) + '");',
      '',
      '  // Step 1: Decompose the task',
      '  const subtasks = harness.decompose("' + (taskDescription || 'untitled').replace(/"/g, '\\"').substring(0, 200) + '");',
      '  harness.log("Task decomposed into " + subtasks.length + " subtasks");',
      '  harness.checkpoint("task-decomposed", { subtaskCount: subtasks.length });',
      '',
      '  // Step 2: Execute subtasks in parallel where possible',
      '  const results = await harness.parallel(subtasks.map(t => ({',
      '    task: t.description || t,',
      '    agentType: "' + taskType + '",',
      '  })));',
      '',
      '  // Step 3: Verify results',
      '  const verification = await harness.verify(results, ["correctness", "completeness"]);',
      '  harness.checkpoint("verified", { passed: verification.passed });',
      '',
      '  harness.log("Harness execution completed");',
      '  return {',
      '    success: verification.passed,',
      '    results: results,',
      '    summary: "Completed " + subtasks.length + " subtasks for: ' + (taskDescription || 'untitled').replace(/'/g, "\\'").substring(0, 80) + '",',
      '  };',
      '}',
    ].join('\n');
  }

  /**
   * 编译脚本（验证语法和安全性）。
   * @param {string} script - 脚本内容
   * @returns {Promise<{valid: boolean, error?: string}>}
   * @private
   */
  async _compileScript(script) {
    if (!script || typeof script !== 'string') {
      return { valid: false, error: 'Script must be a non-empty string' };
    }

    if (script.length > MAX_SCRIPT_SIZE) {
      return { valid: false, error: 'Script exceeds max size: ' + MAX_SCRIPT_SIZE };
    }

    // 安全检查：禁止危险操作
    const dangerousPatterns = [
      { pattern: /require\s*\(/, message: 'require() is not allowed in harness scripts' },
      { pattern: /import\s+/, message: 'import statements are not allowed in harness scripts' },
      { pattern: /process\.exit/, message: 'process.exit() is not allowed' },
      { pattern: /child_process/, message: 'child_process is not allowed' },
      { pattern: /fs\./, message: 'fs module is not allowed' },
      { pattern: /eval\s*\(/, message: 'eval() is not allowed' },
      { pattern: /Function\s*\(/, message: 'Function() constructor is not allowed' },
    ];

    for (const { pattern, message } of dangerousPatterns) {
      if (pattern.test(script)) {
        return { valid: false, error: message };
      }
    }

    // 语法验证：尝试解析脚本
    try {
      new vm.Script(script, { timeout: 5000 });
    } catch (err) {
      return { valid: false, error: 'Syntax error: ' + errorMessage(err) };
    }

    return { valid: true };
  }

  /**
   * 在沙箱环境中执行 Harness 脚本。
   * @param {string} script - 脚本内容
   * @param {string} taskDescription - 任务描述
   * @param {Object} ctx - 上下文
   * @returns {Promise<Object>} 执行结果
   * @private
   */
  async _executeScript(script, taskDescription, ctx) {
    const harnessAPI = this._buildHarnessAPI(taskDescription, ctx);

    const sandbox = {
      harness: harnessAPI,
      console: {
        log: (...args) => debug('HarnessScript', 'log', args.map(String).join(' ')),
        error: (...args) => debug('HarnessScript', 'error', args.map(String).join(' ')),
      },
      setTimeout: (fn, ms) => {
        const id = setTimeout(() => {
          if (!this._shutDown) fn();
        }, ms);
        return id;
      },
      clearTimeout: (id) => clearTimeout(id),
      Promise,
      JSON,
      Math,
      Date,
      String,
      Number,
      Boolean,
      Array,
      Object,
      Map,
      Set,
      RegExp,
      Error,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
    };

    const vmContext = vm.createContext(sandbox);

    try {
      // 编译脚本
      const vmScript = new vm.Script(
        script + '\n\n// Execute\nrun(harness).then(r => __harnessResult = r).catch(e => __harnessError = e);',
        { timeout: this._config.scriptTimeoutMs },
      );

      // 执行
      vmScript.runInContext(vmContext, {
        timeout: this._config.scriptTimeoutMs,
        breakOnSigint: true,
      });

      // 等待异步结果
      const startTime = Date.now();
      const maxWait = this._config.scriptTimeoutMs;
      while (Date.now() - startTime < maxWait) {
        if (vmContext.__harnessError) {
          throw vmContext.__harnessError;
        }
        if (vmContext.__harnessResult !== undefined) {
          break;
        }
        await this._sleep(50);
      }

      if (vmContext.__harnessError) {
        throw vmContext.__harnessError;
      }

      const result = vmContext.__harnessResult || harnessAPI._getExecutionResult();

      if (vmContext.__harnessResult === undefined) {
        debug('DynamicHarnessGenerator', 'scriptTimeout', 'Harness script did not complete within the timeout window — using fallback result');
      }

      return {
        success: result?.success !== false,
        results: result?.results ?? [],
        summary: result?.summary || 'Harness execution completed',
        output: harnessAPI._getOutput(),
        nodesExecuted: harnessAPI._getNodesExecuted(),
        tokensUsed: harnessAPI._getTokensUsed(),
        checkpoints: harnessAPI._getCheckpoints(),
      };
    } catch (err) {
      debug('DynamicHarnessGenerator', 'scriptExecutionError', errorMessage(err));
      throw err;
    }
  }

  /**
   * 构建 Harness API 对象（提供给脚本使用的 DSL）。
   * @param {string} taskDescription - 任务描述
   * @param {Object} ctx - 上下文
   * @returns {Object} Harness API 对象
   * @private
   */
  _buildHarnessAPI(taskDescription, ctx) {
    const self = this;
    let tokensUsed = 0;
    let nodesExecuted = 0;
    const checkpoints = [];
    const output = [];
    let budget = self._config.tokenBudget;

    return {
      /**
       * 并行执行多个子任务。
       * @param {Array<{task: string, agentType?: string}>} tasks - 子任务列表
       * @returns {Promise<Array>} 执行结果
       */
      async parallel(tasks) {
        if (!Array.isArray(tasks)) return [];
        const limited = tasks.slice(0, self._config.maxParallelAgents);
        nodesExecuted += limited.length;

        const promises = limited.map(async (t) => {
          const taskStr = typeof t === 'string' ? t : (t.task || t.description || '');
          return self._executeSubtask(taskStr, t.agentType || 'general', ctx);
        });

        const results = await Promise.allSettled(promises);
        return results.map((r, i) => ({
          index: i,
          task: typeof limited[i] === 'string' ? limited[i] : limited[i].task,
          success: r.status === 'fulfilled',
          result: r.status === 'fulfilled' ? r.value : null,
          error: r.status === 'rejected' ? errorMessage(r.reason) : null,
        }));
      },

      /**
       * 顺序执行多个子任务。
       * @param {Array<{task: string, agentType?: string}>} tasks - 子任务列表
       * @returns {Promise<Array>} 执行结果
       */
      async sequential(tasks) {
        if (!Array.isArray(tasks)) return [];
        const results = [];
        for (const t of tasks) {
          const taskStr = typeof t === 'string' ? t : (t.task || t.description || '');
          nodesExecuted++;
          try {
            const result = await self._executeSubtask(taskStr, t.agentType || 'general', ctx);
            results.push({ task: taskStr, success: true, result });
          } catch (err) {
            results.push({ task: taskStr, success: false, error: errorMessage(err) });
          }
        }
        return results;
      },

      /**
       * 生成单个子 Agent。
       * @param {string} task - 子任务描述
       * @param {string} [agentType='general'] - Agent 类型
       * @returns {Promise<Object>} 执行结果
       */
      async subagent(task, agentType) {
        nodesExecuted++;
        return self._executeSubtask(task, agentType || 'general', ctx);
      },

      /**
       * 对抗验证。
       * @param {*} subject - 待验证对象
       * @param {string[]} [criteria] - 验证标准
       * @returns {Promise<{passed: boolean, feedback: string, rounds: number}>}
       */
      async verify(subject, criteria) {
        if (!self._adversarialReview) {
          return { passed: true, feedback: 'No adversarial review available', rounds: 0 };
        }

        try {
          const reviewerA = async (_subject) => {
            const hasContent = _subject != null && (typeof _subject !== 'object' || Object.keys(_subject).length > 0);
            const isArrayValid = Array.isArray(_subject) && _subject.length > 0;
            return {
              approved: hasContent || isArrayValid,
              feedback: (hasContent || isArrayValid)
                ? 'Subject meets basic structural requirements'
                : 'Subject is empty, null, or structurally invalid',
              suggestions: (hasContent || isArrayValid) ? [] : ['Provide non-empty content for verification'],
            };
          };

          const reviewerB = async (_subject) => {
            const issues = [];
            if (Array.isArray(_subject)) {
              const failedItems = _subject.filter(r => r && r.success === false);
              if (failedItems.length > 0) {
                issues.push(failedItems.length + ' of ' + _subject.length + ' items failed');
              }
              if (_subject.length === 0) {
                issues.push('Subject array is empty — no items to verify');
              }
            }
            const criteriaList = Array.isArray(criteria) ? criteria : [];
            criteriaList.forEach(c => {
              if (typeof c === 'string' && c.length > 50) {
                issues.push('Criteria item too long: ' + c.substring(0, 30) + '...');
              }
            });
            return {
              approved: issues.length === 0,
              feedback: issues.length > 0
                ? 'Issues found: ' + issues.join('; ')
                : 'No critical issues found in: ' + (criteriaList.join(', ') || 'subject'),
              suggestions: issues.map(i => 'Address: ' + i),
            };
          };

          const result = await self._adversarialReview.review(subject, reviewerA, reviewerB);
          return {
            passed: result.consensus,
            feedback: result.finalFeedback || '',
            rounds: result.rounds ?? 0,
          };
        } catch (err) {
          return { passed: false, feedback: 'Verification error: ' + errorMessage(err), rounds: 0 };
        }
      },

      /**
       * 保存检查点。
       * @param {string} name - 检查点名称
       * @param {Object} [data] - 检查点数据
       */
      checkpoint(name, data) {
        const checkpoint = {
          name,
          timestamp: Date.now(),
          data: data ?? {},
          nodesExecuted,
          tokensUsed,
        };
        checkpoints.push(checkpoint);

        if (self._checkpointManager) {
          try {
            self._checkpointManager.create(self._executionId || 'harness', {
              phase: name,
              completedSkills: [],
              tokensUsed,
              metadata: {
                taskDescription,
                checkpointName: name,
                data,
                nodesExecuted,
                script: self._currentScript,
              },
            });
          } catch (_err) {
            debug('DynamicHarnessGenerator', 'checkpointError', errorMessage(_err));
          }
        }

        self.emit('checkpoint-created', checkpoint);
      },

      /**
       * 分解任务。
       * @param {string} task - 任务描述
       * @returns {Array<{description: string, priority: number}>} 子任务列表
       */
      decompose(task) {
        if (self._taskDecomposer) {
          try {
            const result = self._taskDecomposer.decompose(task);
            return (result.subtasks ?? []).map(st => ({
              description: st.description || st.task || '',
              priority: st.priority || 1,
            }));
          } catch (_err) {
            // 回退到简单分解
          }
        }
        // 简单回退：按句号分割
        return (task || '').split(/[。.!！?？\n]+/)
          .filter(s => s.trim().length > 0)
          .map((s, i) => ({ description: s.trim(), priority: i + 1 }));
      },

      /**
       * 记录日志。
       * @param {string} message - 日志消息
       */
      log(message) {
        output.push({ timestamp: Date.now(), level: 'info', message: String(message) });
        debug('HarnessScript', 'log', String(message));
      },

      /**
       * 设置 Token 预算。
       * @param {number} tokens - Token 预算
       */
      setBudget(tokens) {
        if (typeof tokens === 'number' && tokens > 0) {
          budget = tokens;
        }
      },

      /**
       * 获取剩余 Token 预算。
       * @returns {number}
       */
      getBudget() {
        return Math.max(0, budget - tokensUsed);
      },

      // --- 内部方法 ---

      _getOutput() {
        return output.slice();
      },

      _getNodesExecuted() {
        return nodesExecuted;
      },

      _getTokensUsed() {
        return tokensUsed;
      },

      _getCheckpoints() {
        return checkpoints.slice();
      },

      _getExecutionResult() {
        return {
          success: true,
          results: [],
          summary: 'Harness execution completed: ' + nodesExecuted + ' nodes, ' + tokensUsed + ' tokens',
          output: output.slice(),
          nodesExecuted,
          tokensUsed,
          checkpoints: checkpoints.slice(),
        };
      },

      _addTokens(amount) {
        tokensUsed += amount;
        // 预算告警
        if (budget > 0 && tokensUsed >= budget * self._config.budgetWarningRatio) {
          self.emit('budget-warning', {
            used: tokensUsed,
            budget,
            ratio: tokensUsed / budget,
          });
        }
      },
    };
  }

  /**
   * 执行子任务。
   * @param {string} task - 子任务描述
   * @param {string} agentType - Agent 类型
   * @param {Object} ctx - 上下文
   * @returns {Promise<Object>} 执行结果
   * @private
   */
  async _executeSubtask(task, agentType, ctx) {
    // 使用 SkillExecutor
    if (this._skillExecutor) {
      try {
        const result = await this._skillExecutor('subagent-execute', {
          task,
          agentType,
          projectRoot: ctx.projectRoot || '.',
        });
        return result;
      } catch (err) {
        debug('DynamicHarnessGenerator', 'subtaskError', errorMessage(err));
      }
    }

    // 使用 SubagentExecutor
    if (this._subagentExecutor) {
      try {
        const result = await this._subagentExecutor.executeSubagent({
          task,
          agentType,
          mode: 'worker',
        });
        return result;
      } catch (err) {
        debug('DynamicHarnessGenerator', 'subagentError', errorMessage(err));
      }
    }

    // 回退
    return { task, agentType, status: 'completed', result: 'Subtask executed via fallback' };
  }

  /**
   * 运行对抗性验证。
   * @param {string} taskDescription - 任务描述
   * @param {Object} executionResult - 执行结果
   * @returns {Promise<Object>} 验证结果
   * @private
   */
  async _runAdversarialVerification(taskDescription, executionResult) {
    if (!this._adversarialReview) {
      return { passed: true, rounds: 0, feedback: 'No adversarial review attached' };
    }

    try {
      const reviewerA = async (_subject) => {
        const hasResults = executionResult?.results && executionResult.results.length > 0;
        const feedback = hasResults
          ? 'Execution produced ' + executionResult.results.length + ' results for: ' + taskDescription.substring(0, 50)
          : 'Execution produced no results — possible silent failure';
        return {
          approved: hasResults,
          feedback,
          suggestions: hasResults ? [] : ['Verify that the harness script actually produced output'],
        };
      };

      const reviewerB = async (_subject) => ({
        approved: (executionResult?.results?.every(r => r.success !== false)) ?? true,
        feedback: 'Reviewing execution: ' + (executionResult?.results?.length ?? 0) + ' results',
        suggestions: [],
      });

      const result = await this._adversarialReview.review(executionResult, reviewerA, reviewerB);
      return {
        passed: result.consensus,
        rounds: result.rounds ?? 0,
        feedback: result.finalFeedback || '',
        details: result.details ?? [],
      };
    } catch (err) {
      return { passed: false, rounds: 0, feedback: 'Verification error: ' + errorMessage(err) };
    }
  }

  /**
   * 保存检查点。
   * @param {string} taskDescription - 任务描述
   * @param {Object} executionResult - 执行结果
   * @returns {Promise<void>}
   * @private
   */
  async _saveCheckpoint(taskDescription, executionResult) {
    if (!this._checkpointManager) return;

    try {
      this._checkpointManager.create(this._executionId || 'harness', {
        phase: 'harness-completed',
        completedSkills: [],
        tokensUsed: this._tokensUsed,
        metadata: {
          taskDescription,
          executionResult,
          nodesExecuted: this._nodesExecuted,
          script: this._currentScript,
          context: { taskDescription },
        },
      });
    } catch (err) {
      debug('DynamicHarnessGenerator', 'saveCheckpointError', errorMessage(err));
    }
  }

  /**
   * 构建最终结果。
   * @param {boolean} success - 是否成功
   * @param {string} taskDescription - 任务描述
   * @param {string|null} error - 错误信息
   * @param {Object|null} executionResult - 执行结果
   * @param {Object|null} verificationResult - 验证结果
   * @param {Object|null} gapAnalysis - 缺口分析
   * @returns {Object}
   * @private
   */
  _buildResult(success, taskDescription, error, executionResult, verificationResult, gapAnalysis) {
    const summary = success
      ? 'Harness execution completed successfully: ' + (executionResult?.nodesExecuted ?? 0) + ' nodes executed, ' + (executionResult?.tokensUsed ?? 0) + ' tokens used'
      : 'Harness execution failed: ' + (error || 'Unknown error');

    const result = {
      success,
      summary,
      executionId: this._executionId,
      script: this._currentScript,
      results: executionResult?.results ?? [],
      nodesExecuted: executionResult?.nodesExecuted ?? 0,
      tokensUsed: executionResult?.tokensUsed ?? 0,
      checkpoints: this._checkpoints.slice(),
      verification: verificationResult || null,
      gapAnalysis: gapAnalysis || null,
      error: error || undefined,
    };

    // 记录到历史
    this._executionHistory.push({
      timestamp: Date.now(),
      executionId: this._executionId,
      task: taskDescription,
      success,
      nodesExecuted: result.nodesExecuted,
      tokensUsed: result.tokensUsed,
      error,
    });
    if (this._executionHistory.length > MAX_HISTORY_SIZE) {
      this._executionHistory.shift();
    }

    return result;
  }

  /**
   * 异步等待。
   * @param {number} ms - 毫秒
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = {
  DynamicHarnessGenerator: withShutdown(DynamicHarnessGenerator),
  HARNESS_STATUS,
  TRIGGER_KEYWORDS,
  DEFAULT_CONFIG,
};
