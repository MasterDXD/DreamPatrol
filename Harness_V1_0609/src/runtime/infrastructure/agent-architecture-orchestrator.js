/**
 * @module runtime/infrastructure/agent-architecture-orchestrator
 * @description AI Agent 工程化架构编排器，统一六大架构设计：
 * 渐进式披露、架构约束、自验证循环、上下文隔离、熵治理、可拆卸性。
 * 通过 attach* 依赖注入方式编排现有模块，实现 Prompt 驱动 + 强约束的工程化框架。
 */

'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

/** @constant {Object} ARCHITECTURE_PILLAR - 六大架构支柱枚举 */
const ARCHITECTURE_PILLAR = Object.freeze({
  PROGRESSIVE_DISCLOSURE: 'progressive_disclosure',
  CONSTRAINT_ENFORCEMENT: 'constraint_enforcement',
  SELF_VALIDATION: 'self_validation',
  CONTEXT_ISOLATION: 'context_isolation',
  ENTROPY_GOVERNANCE: 'entropy_governance',
  DETACHABILITY: 'detachability',
});

/** @constant {Object} CONSTRAINT_TYPE - 约束类型枚举 */
const CONSTRAINT_TYPE = Object.freeze({
  PROMPT_SUGGESTION: 'prompt_suggestion',
  HARD_CODED: 'hard_coded',
  LINTER: 'linter',
});

/** @constant {Object} VALIDATION_PHASE - 验证阶段枚举 */
const VALIDATION_PHASE = Object.freeze({
  PRE_EXECUTION: 'pre_execution',
  POST_EXECUTION: 'post_execution',
  MULTI_FILE_REVIEW: 'multi_file_review',
});

/** @constant {Object} ENTROPY_LEVEL - 熵等级枚举 */
const ENTROPY_LEVEL = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

/** @constant {Object} DEFAULT_CONFIG - 默认配置 */
const DEFAULT_CONFIG = {
  contextLayers: 3,
  maxContextTokens: 8000,
  disclosureStrategy: 'priority',

  enablePromptSuggestions: true,
  enableHardConstraints: true,
  enableLinterValidation: true,

  enablePreValidation: true,
  enablePostValidation: true,
  maxValidationRetries: 3,
  requireMultiFileReview: true,

  enableMemoryIsolation: true,
  allowCrossAgentMemory: false,

  entropyCheckIntervalMs: 300000,
  entropyThresholds: { low: 0.3, medium: 0.6, high: 0.8, critical: 0.95 },
  autoCleanupEnabled: true,

  enableHotSwap: true,
  maxModules: 100,
};

/**
 * @classdesc AI Agent 工程化架构编排器，统一六大架构设计，
 * 通过 attach* 依赖注入方式编排现有模块。
 * @extends EventEmitter
 */
const MAX_NAMESPACES = 100;
const MAX_ACCESS_GRANTS = 100;
const MAX_CONTEXT_LAYERS = 50;

class AgentArchitectureOrchestrator extends EventEmitter {
  /**
   * 创建架构编排器实例
   * @param {Object} [config={}] - 配置选项，与 DEFAULT_CONFIG 合并
   */
  constructor(config = {}) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._status = 'idle';
    this._modules = new Map();
    this._agentNamespaces = new Map();
    this._constraintRegistry = new Map();
    this._validationHooks = new Map();
    this._entropyScore = 0;
    this._entropyHistory = [];
    this._lastEntropyCheck = 0;

    this._progressiveDisclosureController = null;
    this._constraintPromptCompiler = null;
    this._verificationLoopMiddleware = null;
    this._agentMemoryNamespace = null;
    this._entropyGovernanceOrchestrator = null;
    this._moduleContainer = null;

    // 依赖注入的外部模块
    this._attentionBudgetManager = null;
    this._contextCompressionEngine = null;
    this._ironRuleEngine = null;
    this._sddDocumentValidator = null;
    this._hookComposer = null;
    this._programmableHookExecutor = null;
    this._isolatedContextManager = null;
    this._dreamEngine = null;
    this._thoughtDeduplicator = null;
    this._docFreshnessGuard = null;
    this._pluginManager = null;
    this._eventBus = null;

    // 上下文层注册表
    this._contextLayers = new Map();

    // 跨Agent记忆访问授权表
    this._memoryAccessGrants = new Map();

    this._initializeSubControllers();
  }

  /**
   * 初始化六大子控制器，每个子控制器为轻量级普通对象
   * @private
   */
  _initializeSubControllers() {
    // 1. 渐进式披露控制器
    this._progressiveDisclosureController = {
      disclose: (taskId, agentId, currentPhase) => this._discloseContext(taskId, agentId, currentPhase),
      registerContext: (layer, data) => this._registerContextLayer(layer, data),
      getBudgetAllocation: () => this._getContextBudgetAllocation(),
    };

    // 2. 架构约束Prompt编译器
    this._constraintPromptCompiler = {
      compile: (constraintType) => this._compileConstraintsToPrompt(constraintType),
      registerConstraint: (name, type, content) => this._registerConstraint(name, type, content),
      getPromptSuggestions: () => this._getPromptSuggestions(),
    };

    // 3. 自验证循环中间件
    this._verificationLoopMiddleware = {
      preValidate: (task, agent) => this._preValidateExecution(task, agent),
      postValidate: (task, agent, result) => this._postValidateExecution(task, agent, result),
      executeWithValidation: (task, agent, executeFn) => this._executeWithValidation(task, agent, executeFn),
    };

    // 4. Agent记忆命名空间
    this._agentMemoryNamespace = {
      getNamespace: (agentId) => this.getAgentNamespaceCopy(agentId),
      store: (agentId, key, value) => this._storeAgentMemory(agentId, key, value),
      retrieve: (agentId, key) => this._retrieveAgentMemory(agentId, key),
      grantAccess: (fromAgent, toAgent, keys) => this._grantMemoryAccess(fromAgent, toAgent, keys),
    };

    // 5. 熵治理编排器
    this._entropyGovernanceOrchestrator = {
      measureEntropy: () => this._measureEntropy(),
      govern: () => this._governEntropy(),
      getEntropyReport: () => this._getEntropyReport(),
    };

    // 6. 模块容器
    this._moduleContainer = {
      register: (name, module, capabilities) => this._registerModule(name, module, capabilities),
      unregister: (name) => this._unregisterModule(name),
      get: (name) => this._getModule(name),
      list: () => this._listModules(),
    };
  }

  // ─── attach* 依赖注入方法 ─────────────────────────────────────

  /**
   * 注入注意力预算管理器，用于渐进式披露
   * @param {Object} abm - AttentionBudgetManager 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachAttentionBudgetManager(abm) {
    if (abm == null) throw new Error('AttentionBudgetManager must not be null');
    this._attentionBudgetManager = abm;
    return this;
  }

  /**
   * 注入上下文压缩引擎，用于渐进式披露
   * @param {Object} cce - ContextCompressionEngine 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachContextCompressionEngine(cce) {
    if (cce == null) throw new Error('ContextCompressionEngine must not be null');
    this._contextCompressionEngine = cce;
    return this;
  }

  /**
   * 注入铁律引擎，用于架构约束
   * @param {Object} ire - IronRuleEngine 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachIronRuleEngine(ire) {
    if (ire == null) throw new Error('IronRuleEngine must not be null');
    this._ironRuleEngine = ire;
    return this;
  }

  /**
   * 注入SDD文档验证器，用于架构约束
   * @param {Object} dv - SddDocumentValidator 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachSddDocumentValidator(dv) {
    if (dv == null) throw new Error('SddDocumentValidator must not be null');
    this._sddDocumentValidator = dv;
    return this;
  }

  /**
   * 注入Hook组合器，用于自验证循环
   * @param {Object} hc - HookComposer 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachHookComposer(hc) {
    if (hc == null) throw new Error('HookComposer must not be null');
    this._hookComposer = hc;
    return this;
  }

  /**
   * 注入可编程Hook执行器，用于自验证循环
   * @param {Object} phe - ProgrammableHookExecutor 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachProgrammableHookExecutor(phe) {
    if (phe == null) throw new Error('ProgrammableHookExecutor must not be null');
    this._programmableHookExecutor = phe;
    return this;
  }

  /**
   * 注入隔离上下文管理器，用于上下文隔离
   * @param {Object} icm - IsolatedContextManager 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachIsolatedContextManager(icm) {
    if (icm == null) throw new Error('IsolatedContextManager must not be null');
    this._isolatedContextManager = icm;
    return this;
  }

  /**
   * 注入梦境引擎，用于熵治理
   * @param {Object} de - DreamEngine 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachDreamEngine(de) {
    if (de == null) throw new Error('DreamEngine must not be null');
    this._dreamEngine = de;
    return this;
  }

  /**
   * 注入思维去重器，用于熵治理
   * @param {Object} td - ThoughtDeduplicator 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachThoughtDeduplicator(td) {
    if (td == null) throw new Error('ThoughtDeduplicator must not be null');
    this._thoughtDeduplicator = td;
    return this;
  }

  /**
   * 注入文档新鲜度守卫，用于熵治理
   * @param {Object} dfg - DocFreshnessGuard 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachDocFreshnessGuard(dfg) {
    if (dfg == null) throw new Error('DocFreshnessGuard must not be null');
    this._docFreshnessGuard = dfg;
    return this;
  }

  /**
   * 注入插件管理器，用于可拆卸性
   * @param {Object} pm - PluginManager 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachPluginManager(pm) {
    if (pm == null) throw new Error('PluginManager must not be null');
    this._pluginManager = pm;
    return this;
  }

  /**
   * 注入事件总线，用于可拆卸性
   * @param {Object} eb - EventBus 实例
   * @returns {AgentArchitectureOrchestrator} this，支持链式调用
   */
  attachEventBus(eb) {
    if (eb == null) throw new Error('EventBus must not be null');
    this._eventBus = eb;
    return this;
  }

  // ─── 核心编排方法 ─────────────────────────────────────────────

  /**
   * 核心编排方法，依次应用六大架构支柱执行任务
   * @param {string} task - 任务描述，必须为非空字符串
   * @param {Array<Object>} agents - Agent数组，至少包含一个Agent
   * @param {Object} [options={}] - 编排选项
   * @param {string} [options.phase] - 当前执行阶段
   * @param {Function} [options.executeFn] - 自定义执行函数
   * @returns {Promise<Object>} 编排结果，包含 success、result、pillars 等字段
   * @throws {Error} 任务或Agent参数无效时抛出
   */
  async orchestrate(task, agents, options = {}) {
    this.guardShutdown();
    if (!task || typeof task !== 'string') throw new Error('Task must be a non-empty string');
    if (!Array.isArray(agents) || agents.length === 0) throw new Error('At least one agent is required');

    this._status = 'orchestrating';
    this.emit('orchestration-started', { task, agentCount: agents.length, pillars: Object.values(ARCHITECTURE_PILLAR) });

    try {
      // 1. 渐进式披露 — 按优先级分层暴露上下文
      const disclosedContext = this._progressiveDisclosureController.disclose(task, agents[0].id, options.phase);

      // 2. 架构约束 — 编译约束到Prompt + 硬编码校验
      const constraintContext = this._constraintPromptCompiler.compile(CONSTRAINT_TYPE.PROMPT_SUGGESTION);
      const _hardConstraints = this._constraintPromptCompiler.compile(CONSTRAINT_TYPE.HARD_CODED);

      // 3. 自验证循环 — 执行前校验
      if (this._config.enablePreValidation) {
        const preCheck = await this._verificationLoopMiddleware.preValidate(task, agents[0]);
        if (!preCheck.valid) {
          this.emit('pre-validation-failed', { task, errors: preCheck.errors });
          return { success: false, reason: 'pre_validation_failed', errors: preCheck.errors };
        }
      }

      // 4. 上下文隔离 — 为每个Agent创建独立记忆命名空间
      const namespaces = {};
      if (this._config.enableMemoryIsolation) {
        for (const agent of agents) {
          namespaces[agent.id] = this._agentMemoryNamespace.getNamespace(agent.id);
        }
      }

      // 5. 执行（带验证循环）
      const result = await this._verificationLoopMiddleware.executeWithValidation(
        task, agents[0], options.executeFn || this._defaultExecuteFn.bind(this),
      );

      // 6. 熵治理 — 检查并清理
      if (this._config.autoCleanupEnabled) {
        const entropyResult = this._entropyGovernanceOrchestrator.govern();
        if (entropyResult.entropyLevel === ENTROPY_LEVEL.HIGH || entropyResult.entropyLevel === ENTROPY_LEVEL.CRITICAL) {
          this.emit('entropy-alert', entropyResult);
        }
      }

      this._status = 'completed';
      this.emit('orchestration-completed', { task, result });
      return { success: true, result, pillars: { disclosedContext, constraintContext, namespaces } };
    } catch (err) {
      this._status = 'failed';
      this.emit('orchestration-failed', { error: err && err.message ? err.message : String(err) });
      throw err;
    }
  }

  // ─── 渐进式披露方法 ─────────────────────────────────────────

  /**
   * 按优先级分层暴露上下文，使用注意力预算管理器评分分类，上下文压缩引擎压缩
   * @param {string} taskId - 任务标识
   * @param {string} agentId - Agent标识
   * @param {string} [currentPhase] - 当前执行阶段
   * @returns {Object} 分层上下文对象，包含各层上下文数据
   * @private
   */
  _discloseContext(taskId, agentId, currentPhase) {
    return safeExecute(() => {
      const layers = Math.max(1, Math.floor(this._config.contextLayers));
      const maxTokens = this._config.maxContextTokens;
      const strategy = this._config.disclosureStrategy;
      const budgetPerLayer = Math.floor(maxTokens / layers);

      const disclosed = { taskId, agentId, currentPhase, layers: [], totalBudget: maxTokens, strategy };

      for (let i = 0; i < layers; i++) {
        const layerData = this._contextLayers.get(i) ?? {};
        let contextContent = layerData;

        // 使用注意力预算管理器评分
        if (this._attentionBudgetManager && typeof this._attentionBudgetManager.score === 'function') {
          const scored = this._attentionBudgetManager.score(layerData, { layer: i, taskId, agentId });
          contextContent = scored || layerData;
        }

        // 使用上下文压缩引擎压缩
        if (this._contextCompressionEngine && typeof this._contextCompressionEngine.compress === 'function') {
          const compressed = this._contextCompressionEngine.compress(contextContent, { maxTokens: budgetPerLayer });
          contextContent = compressed || contextContent;
        }

        disclosed.layers.push({
          layer: i,
          priority: strategy === 'priority' ? (layers - i) : i,
          budget: budgetPerLayer,
          content: contextContent,
        });
      }

      debug('AgentArchOrch', 'discloseContext', 'Layers: ' + layers + ', Strategy: ' + strategy);
      return disclosed;
    }, 'AgentArchOrch', 'discloseContext', { taskId, agentId, layers: [] });
  }

  /**
   * 注册上下文层数据
   * @param {number} layer - 层级索引
   * @param {*} data - 上下文数据
   * @private
   */
  _registerContextLayer(layer, data) {
    safeExecute(() => {
      if (this._contextLayers.size >= MAX_CONTEXT_LAYERS) {
        const oldestKey = this._contextLayers.keys().next().value;
        this._contextLayers.delete(oldestKey);
      }
      this._contextLayers.set(layer, data);
      debug('AgentArchOrch', 'registerContextLayer', 'Layer: ' + layer);
    }, 'AgentArchOrch', 'registerContextLayer');
  }

  /**
   * 获取当前各层预算分配
   * @returns {Object} 预算分配信息
   * @private
   */
  _getContextBudgetAllocation() {
    const layers = Math.max(1, Math.floor(this._config.contextLayers));
    const maxTokens = this._config.maxContextTokens;
    const budgetPerLayer = Math.floor(maxTokens / layers);
    const allocation = { total: maxTokens, perLayer: budgetPerLayer, layers };
    if (this._attentionBudgetManager && typeof this._attentionBudgetManager.getAllocation === 'function') {
      const externalAllocation = this._attentionBudgetManager.getAllocation();
      if (externalAllocation) return externalAllocation;
    }
    return allocation;
  }

  // ─── 架构约束方法 ─────────────────────────────────────────────

  /**
   * 将注册的约束编译为指定类型的输出
   * @param {string} constraintType - 约束类型，来自 CONSTRAINT_TYPE 枚举
   * @returns {Object|string|Array} 编译后的约束内容
   * @private
   */
  _compileConstraintsToPrompt(constraintType) {
    return safeExecute(() => {
      const constraints = [];
      for (const [, entry] of this._constraintRegistry) {
        if (entry.type === constraintType) {
          constraints.push(entry);
        }
      }

      switch (constraintType) {
        case CONSTRAINT_TYPE.PROMPT_SUGGESTION: {
          // 编译为自然语言指导方针
          const lines = constraints.map((c, i) => (i + 1) + '. ' + c.content);
          const header = lines.length > 0
            ? '【架构约束指导方针】请遵循以下建议：\n'
            : '';
          return header + lines.join('\n');
        }
        case CONSTRAINT_TYPE.HARD_CODED: {
          // 返回验证函数列表
          return constraints.map(c => ({
            name: c.name,
            validate: typeof c.content === 'function' ? c.content : () => true,
          }));
        }
        case CONSTRAINT_TYPE.LINTER: {
          // 返回Linter规则列表
          return constraints.map(c => ({
            name: c.name,
            rules: c.content,
          }));
        }
        default:
          return constraints;
      }
    }, 'AgentArchOrch', 'compileConstraints', []);
  }

  /**
   * 注册一个约束
   * @param {string} name - 约束名称
   * @param {string} type - 约束类型，来自 CONSTRAINT_TYPE 枚举
   * @param {*} content - 约束内容
   * @private
   */
  _registerConstraint(name, type, content) {
    const result = safeExecute(() => {
      this._constraintRegistry.set(name, { name, type, content, registeredAt: Date.now() });
      debug('AgentArchOrch', 'registerConstraint', 'Name: ' + name + ', Type: ' + type);
      return true;
    }, 'AgentArchOrch', 'registerConstraint');
    if (!result) this.emit('constraint-registration-failed', { name, type });
  }

  /**
   * 获取所有Prompt柔性建议类型的约束，格式化为Prompt文本
   * @returns {string} 格式化的Prompt建议文本
   * @private
   */
  _getPromptSuggestions() {
    return this._compileConstraintsToPrompt(CONSTRAINT_TYPE.PROMPT_SUGGESTION);
  }

  // ─── 自验证循环方法 ─────────────────────────────────────────

  /**
   * 执行前校验，通过铁律引擎和Hook组合器检查
   * @param {string} task - 任务描述
   * @param {Object} agent - Agent对象
   * @returns {Promise<Object>} 校验结果 { valid: boolean, errors: string[] }
   * @private
   */
  async _preValidateExecution(task, agent) {
    const errors = [];

    // 铁律引擎校验
    if (this._ironRuleEngine && typeof this._ironRuleEngine.validate === 'function') {
      const ruleResult = await safeExecute(
        () => this._ironRuleEngine.validate(task, agent),
        'AgentArchOrch', 'preValidate-ironRule',
        { valid: true, errors: [] },
      );
      if (ruleResult && !ruleResult.valid) {
        errors.push(...(ruleResult.errors || ['Iron rule validation failed']));
      }
    }

    // SDD文档验证器校验
    if (this._sddDocumentValidator && typeof this._sddDocumentValidator.validate === 'function') {
      const docResult = await safeExecute(
        () => this._sddDocumentValidator.validate(task),
        'AgentArchOrch', 'preValidate-sddDoc',
        { valid: true, errors: [] },
      );
      if (docResult && !docResult.valid) {
        errors.push(...(docResult.errors || ['SDD document validation failed']));
      }
    }

    // Hook组合器校验
    if (this._hookComposer && typeof this._hookComposer.composePreHooks === 'function') {
      const hookResult = await safeExecute(
        () => this._hookComposer.composePreHooks(task, agent),
        'AgentArchOrch', 'preValidate-hooks',
        { valid: true, errors: [] },
      );
      if (hookResult && !hookResult.valid) {
        errors.push(...(hookResult.errors || ['Pre-hook validation failed']));
      }
    }

    // 硬编码约束校验
    const hardConstraints = this._compileConstraintsToPrompt(CONSTRAINT_TYPE.HARD_CODED);
    if (Array.isArray(hardConstraints)) {
      for (const constraint of hardConstraints) {
        if (typeof constraint.validate === 'function') {
          const valid = safeExecute(
            () => constraint.validate(task, agent),
            'AgentArchOrch', 'preValidate-hardConstraint:' + constraint.name,
            true,
          );
          if (!valid) {
            errors.push('Hard constraint violated: ' + constraint.name);
            this.emit('constraint-violation', { constraint: constraint.name, phase: VALIDATION_PHASE.PRE_EXECUTION });
          }
        }
      }
    }

    debug('AgentArchOrch', 'preValidate', 'Valid: ' + (errors.length === 0) + ', Errors: ' + errors.length);
    return { valid: errors.length === 0, errors };
  }

  /**
   * 执行后验证，检查结果格式和Linter校验
   * @param {string} task - 任务描述
   * @param {Object} agent - Agent对象
   * @param {*} result - 执行结果
   * @returns {Promise<Object>} 验证结果 { valid: boolean, errors: string[] }
   * @private
   */
  async _postValidateExecution(task, agent, result) {
    const errors = [];

    // 结果格式校验
    if (result == null) {
      errors.push('Execution result is null or undefined');
    } else if (typeof result === 'object' && result.success === false) {
      errors.push('Execution result indicates failure: ' + (result.reason || 'unknown'));
    }

    // Hook校验
    const hookErrors = await this._validatePostHooks(task, agent, result);
    errors.push(...hookErrors);

    // Linter校验
    const linterErrors = await this._validateLinterRules(result);
    errors.push(...linterErrors);

    // 多文件修改重审
    const reviewErrors = await this._validateMultiFileReview(task, agent, result);
    errors.push(...reviewErrors);

    if (errors.length > 0) {
      this.emit('post-validation-failed', { task, errors });
    }

    debug('AgentArchOrch', 'postValidate', 'Valid: ' + (errors.length === 0) + ', Errors: ' + errors.length);
    return { valid: errors.length === 0, errors };
  }

  /**
   * 校验Hook组合器后置校验和可编程Hook执行器
   * @param {string} task - 任务描述
   * @param {Object} agent - Agent对象
   * @param {*} result - 执行结果
   * @returns {Promise<string[]>} 错误数组
   * @private
   */
  async _validatePostHooks(task, agent, result) {
    const errors = [];

    // Hook组合器后置校验
    if (this._hookComposer && typeof this._hookComposer.composePostHooks === 'function') {
      const hookResult = await safeExecute(
        () => this._hookComposer.composePostHooks(task, agent, result),
        'AgentArchOrch', 'postValidate-hooks',
        { valid: true, errors: [] },
      );
      if (hookResult && !hookResult.valid) {
        errors.push(...(hookResult.errors || ['Post-hook validation failed']));
      }
    }

    // 可编程Hook执行器校验
    if (this._programmableHookExecutor && typeof this._programmableHookExecutor.execute === 'function') {
      const pheResult = await safeExecute(
        () => this._programmableHookExecutor.execute(VALIDATION_PHASE.POST_EXECUTION, { task, agent, result }),
        'AgentArchOrch', 'postValidate-phe',
        { valid: true, errors: [] },
      );
      if (pheResult && !pheResult.valid) {
        errors.push(...(pheResult.errors || ['Programmable hook execution failed']));
      }
    }

    return errors;
  }

  /**
   * 校验Linter规则
   * @param {*} result - 执行结果
   * @returns {Promise<string[]>} 错误数组
   * @private
   */
  async _validateLinterRules(result) {
    const errors = [];

    if (this._config.enableLinterValidation) {
      const linterRules = this._compileConstraintsToPrompt(CONSTRAINT_TYPE.LINTER);
      if (Array.isArray(linterRules)) {
        for (const rule of linterRules) {
          if (rule.rules && typeof rule.rules.validate === 'function') {
            const lintResult = safeExecute(
              () => rule.rules.validate(result),
              'AgentArchOrch', 'postValidate-linter:' + rule.name,
              { valid: true, errors: [] },
            );
            if (lintResult && !lintResult.valid) {
              errors.push(...(lintResult.errors || ['Linter rule failed: ' + rule.name]));
            }
          }
        }
      }
    }

    return errors;
  }

  /**
   * 多文件修改重审
   * @param {string} task - 任务描述
   * @param {Object} agent - Agent对象
   * @param {*} result - 执行结果
   * @returns {Promise<string[]>} 错误数组
   * @private
   */
  async _validateMultiFileReview(task, agent, result) {
    if (this._config.requireMultiFileReview && result && typeof result === 'object' && Array.isArray(result.modifiedFiles) && result.modifiedFiles.length > 1) {
      const reviewErrors = await safeExecute(
        () => this._multiFileReview(task, agent, result),
        'AgentArchOrch', 'postValidate-multiFileReview',
        [],
      );
      if (Array.isArray(reviewErrors) && reviewErrors.length > 0) {
        return reviewErrors;
      }
    }
    return [];
  }

  /**
   * 带验证循环的执行：前置校验 → 执行 → 后置验证 → 无效时重试（最多 maxValidationRetries 次）
   * @param {string} task - 任务描述
   * @param {Object} agent - Agent对象
   * @param {Function} executeFn - 执行函数
   * @returns {Promise<*>} 执行结果
   * @private
   */
  async _executeWithValidation(task, agent, executeFn) {
    let lastResult = null;
    let attempt = 0;
    const maxRetries = this._config.maxValidationRetries;

    while (attempt <= maxRetries) {
      // 前置校验（仅首次）
      if (attempt === 0 && this._config.enablePreValidation) {
        const preCheck = await this._preValidateExecution(task, agent);
        if (!preCheck.valid) {
          this.emit('pre-validation-failed', { task, errors: preCheck.errors, attempt });
          return { success: false, reason: 'pre_validation_failed', errors: preCheck.errors };
        }
      }

      // 执行
      lastResult = await safeExecute(
        () => executeFn(task, agent),
        'AgentArchOrch', 'executeWithValidation',
        { success: false, reason: 'execution_error' },
      );

      // 后置验证
      if (this._config.enablePostValidation) {
        const postCheck = await this._postValidateExecution(task, agent, lastResult);
        if (postCheck.valid) {
          return lastResult;
        }

        attempt++;
        if (attempt <= maxRetries) {
          this.emit('validation-retry', { task, attempt, maxRetries, errors: postCheck.errors });
          debug('AgentArchOrch', 'executeWithValidation', 'Retry: ' + attempt + '/' + maxRetries);
        } else {
          this.emit('post-validation-failed', { task, errors: postCheck.errors, exhausted: true });
          return { success: false, reason: 'post_validation_failed', errors: postCheck.errors, result: lastResult };
        }
      } else {
        return lastResult;
      }
    }

    return lastResult;
  }

  /**
   * 多文件修改重审
   * @param {string} task - 任务描述
   * @param {Object} agent - Agent对象
   * @param {Object} result - 执行结果
   * @returns {Promise<string[]>} 重审错误列表
   * @private
   */
  async _multiFileReview(task, agent, result) {
    const errors = [];
    if (this._hookComposer && typeof this._hookComposer.composeReviewHooks === 'function') {
      const reviewResult = await safeExecute(
        () => this._hookComposer.composeReviewHooks(task, agent, result),
        'AgentArchOrch', 'multiFileReview',
        { valid: true, errors: [] },
      );
      if (reviewResult && !reviewResult.valid) {
        errors.push(...(reviewResult.errors || ['Multi-file review failed']));
      }
    }
    return errors;
  }

  /**
   * 默认执行函数
   * @param {string} task - 任务描述
   * @param {Object} agent - Agent对象
   * @returns {Promise<Object>} 执行结果
   * @private
   */
  async _defaultExecuteFn(task, agent) {
    debug('AgentArchOrch', 'defaultExecuteFn', 'Task: ' + task);
    return { success: true, task, agentId: agent.id, timestamp: Date.now() };
  }

  // ─── 上下文隔离方法 ─────────────────────────────────────────

  /**
   * 获取或创建Agent的私有记忆命名空间
   * @param {string} agentId - Agent标识
   * @returns {Map} Agent的私有命名空间
   * @private
   */
  _getAgentNamespace(agentId) {
    return safeExecute(() => {
      if (!this._agentNamespaces.has(agentId)) {
        const namespace = new Map();
        if (this._agentNamespaces.size >= MAX_NAMESPACES) {
          const oldestKey = this._agentNamespaces.keys().next().value;
          this._agentNamespaces.delete(oldestKey);
        }
        this._agentNamespaces.set(agentId, namespace);
        if (this._memoryAccessGrants.size >= MAX_ACCESS_GRANTS) {
          const oldestKey = this._memoryAccessGrants.keys().next().value;
          this._memoryAccessGrants.delete(oldestKey);
        }
        this._memoryAccessGrants.set(agentId, new Set());
        debug('AgentArchOrch', 'getAgentNamespace', 'Created namespace for: ' + agentId);
      }
      return this._agentNamespaces.get(agentId);
    }, 'AgentArchOrch', 'getAgentNamespace', null);
  }

  /**
   * 获取Agent命名空间的防御性拷贝（公共接口）
   * @param {string} agentId - Agent标识
   * @returns {Map|null} 命名空间副本
   */
  getAgentNamespaceCopy(agentId) {
    const ns = this._getAgentNamespace(agentId);
    return ns ? new Map(ns) : null;
  }

  /**
   * 在Agent的私有命名空间中存储数据
   * @param {string} agentId - Agent标识
   * @param {string} key - 存储键
   * @param {*} value - 存储值
   * @private
   */
  _storeAgentMemory(agentId, key, value) {
    const ok = safeExecute(() => {
      const namespace = this._getAgentNamespace(agentId);
      namespace.set(key, value);
      debug('AgentArchOrch', 'storeAgentMemory', 'Agent: ' + agentId + ', Key: ' + key);
      return true;
    }, 'AgentArchOrch', 'storeAgentMemory');
    if (!ok) this.emit('memory-store-failed', { agentId, key });
  }

  /**
   * 从Agent的私有命名空间中检索数据
   * @param {string} agentId - Agent标识
   * @param {string} key - 检索键
   * @returns {*} 存储的值，不存在则返回 undefined
   * @private
   */
  _retrieveAgentMemory(agentId, key) {
    return safeExecute(() => {
      const namespace = this._getAgentNamespace(agentId);
      return namespace.get(key);
    }, 'AgentArchOrch', 'retrieveAgentMemory', undefined);
  }

  /**
   * 显式授予跨Agent记忆访问权限（默认禁止跨Agent记忆共享）
   * @param {string} fromAgent - 授权方Agent标识
   * @param {string} toAgent - 被授权方Agent标识
   * @param {string[]} keys - 授权访问的键列表
   * @private
   */
  _grantMemoryAccess(fromAgent, toAgent, keys) {
    if (!this._config.allowCrossAgentMemory) {
      debug('AgentArchOrch', 'grantMemoryAccess', 'Cross-agent memory access is disabled');
      return;
    }
    safeExecute(() => {
      if (!this._memoryAccessGrants.has(fromAgent)) {
        if (this._memoryAccessGrants.size >= MAX_ACCESS_GRANTS) {
          const oldestKey = this._memoryAccessGrants.keys().next().value;
          this._memoryAccessGrants.delete(oldestKey);
        }
        this._memoryAccessGrants.set(fromAgent, new Set());
      }
      const grants = this._memoryAccessGrants.get(fromAgent);
      for (const key of keys) {
        grants.add(toAgent + ':' + key);
      }
      debug('AgentArchOrch', 'grantMemoryAccess', 'From: ' + fromAgent + ', To: ' + toAgent + ', Keys: ' + keys.length);
    }, 'AgentArchOrch', 'grantMemoryAccess');
  }

  // ─── 熵治理方法 ─────────────────────────────────────────────

  /**
   * 计算熵值分数，基于重复计数、过期文档计数、内存溢出比率、规则冲突计数
   * @returns {number} 熵值分数，范围 0-1
   * @private
   */
  _measureEntropy() {
    return safeExecute(() => {
      const now = Date.now();
      this._lastEntropyCheck = now;

      let duplicateCount = 0;
      let staleDocCount = 0;
      let memoryOverflowRatio = 0;
      let ruleConflictCount = 0;

      // 思维去重器提供重复计数
      if (this._thoughtDeduplicator && typeof this._thoughtDeduplicator.getDuplicateCount === 'function') {
        duplicateCount = Number.isFinite(this._thoughtDeduplicator.getDuplicateCount()) ? this._thoughtDeduplicator.getDuplicateCount() : 0;
      }

      // 文档新鲜度守卫提供过期文档计数
      if (this._docFreshnessGuard && typeof this._docFreshnessGuard.getStaleCount === 'function') {
        staleDocCount = Number.isFinite(this._docFreshnessGuard.getStaleCount()) ? this._docFreshnessGuard.getStaleCount() : 0;
      }

      // 内存溢出比率
      const totalModules = this._modules.size || 1;
      const safeMaxModules = Math.max(1, this._config.maxModules);
      memoryOverflowRatio = totalModules / safeMaxModules;

      // 规则冲突计数
      const constraintNames = new Set();
      for (const [, entry] of this._constraintRegistry) {
        if (constraintNames.has(entry.name)) {
          ruleConflictCount++;
        }
        constraintNames.add(entry.name);
      }

      // 加权计算熵值
      const score = Math.min(1, (
        duplicateCount * 0.3 +
        staleDocCount * 0.2 +
        memoryOverflowRatio * 0.3 +
        ruleConflictCount * 0.2
      ) / 10);

      this._entropyScore = score;
      this._entropyHistory.push({ score, timestamp: now, dimensions: { duplicateCount, staleDocCount, memoryOverflowRatio, ruleConflictCount } });

      // 限制历史记录长度
      if (this._entropyHistory.length > 100) {
        this._entropyHistory = this._entropyHistory.slice(-50);
      }

      debug('AgentArchOrch', 'measureEntropy', 'Score: ' + score.toFixed(4));
      return score;
    }, 'AgentArchOrch', 'measureEntropy', 0);
  }

  /**
   * 执行熵治理：触发梦境引擎整合、思维去重、文档新鲜度验证
   * @returns {Object} 治理结果，包含 entropyLevel 和 actionsTaken
   * @private
   */
  _governEntropy() {
    return safeExecute(() => {
      const score = this._measureEntropy();
      const thresholds = this._config.entropyThresholds;

      let entropyLevel = ENTROPY_LEVEL.LOW;
      if (score >= thresholds.critical) entropyLevel = ENTROPY_LEVEL.CRITICAL;
      else if (score >= thresholds.high) entropyLevel = ENTROPY_LEVEL.HIGH;
      else if (score >= thresholds.medium) entropyLevel = ENTROPY_LEVEL.MEDIUM;

      const actionsTaken = [];

      // 梦境引擎整合
      if (this._dreamEngine && typeof this._dreamEngine.consolidate === 'function') {
        const dreamResult = safeExecute(
          () => this._dreamEngine.consolidate(),
          'AgentArchOrch', 'governEntropy-dreamEngine',
          null,
        );
        if (dreamResult) actionsTaken.push('dream_consolidation');
      }

      // 思维去重
      if (this._thoughtDeduplicator && typeof this._thoughtDeduplicator.deduplicate === 'function') {
        const dedupResult = safeExecute(
          () => this._thoughtDeduplicator.deduplicate(),
          'AgentArchOrch', 'governEntropy-deduplicate',
          null,
        );
        if (dedupResult) actionsTaken.push('thought_deduplication');
      }

      // 文档新鲜度验证
      if (this._docFreshnessGuard && typeof this._docFreshnessGuard.validate === 'function') {
        const freshnessResult = safeExecute(
          () => this._docFreshnessGuard.validate(),
          'AgentArchOrch', 'governEntropy-docFreshness',
          null,
        );
        if (freshnessResult) actionsTaken.push('doc_freshness_validation');
      }

      this.emit('entropy-governed', { score, entropyLevel, actionsTaken });
      debug('AgentArchOrch', 'governEntropy', 'Level: ' + entropyLevel + ', Actions: ' + actionsTaken.join(','));

      return { score, entropyLevel, actionsTaken };
    }, 'AgentArchOrch', 'governEntropy', { score: 0, entropyLevel: ENTROPY_LEVEL.LOW, actionsTaken: [] });
  }

  /**
   * 获取详细的熵值报告，包含各维度分数
   * @returns {Object} 熵值报告
   * @private
   */
  _getEntropyReport() {
    const score = this._entropyScore;
    const thresholds = this._config.entropyThresholds;
    let entropyLevel = ENTROPY_LEVEL.LOW;
    if (score >= thresholds.critical) entropyLevel = ENTROPY_LEVEL.CRITICAL;
    else if (score >= thresholds.high) entropyLevel = ENTROPY_LEVEL.HIGH;
    else if (score >= thresholds.medium) entropyLevel = ENTROPY_LEVEL.MEDIUM;

    const lastEntry = this._entropyHistory.length > 0
      ? this._entropyHistory[this._entropyHistory.length - 1]
      : null;

    return {
      currentScore: score,
      entropyLevel,
      lastCheck: this._lastEntropyCheck,
      dimensions: lastEntry ? Object.assign({}, lastEntry.dimensions) : {},
      history: this._entropyHistory.slice(-10).map(e => Object.assign({}, e, { dimensions: Object.assign({}, e.dimensions) })),
      thresholds: Object.assign({}, this._config.entropyThresholds),
    };
  }

  // ─── 模块容器方法 ─────────────────────────────────────────────

  /**
   * 注册模块及其能力声明
   * @param {string} name - 模块名称
   * @param {Object} module - 模块实例
   * @param {string[]} [capabilities=[]] - 模块能力声明
   * @private
   */
  _registerModule(name, module, capabilities) {
    safeExecute(() => {
      if (this._modules.size >= this._config.maxModules) {
        debug('AgentArchOrch', 'registerModule', 'Max modules reached: ' + this._config.maxModules);
        return;
      }
      this._modules.set(name, { module, capabilities: capabilities ?? [], registeredAt: Date.now() });
      this.emit('module-registered', { name, capabilities: capabilities ?? [] });
      debug('AgentArchOrch', 'registerModule', 'Name: ' + name);
    }, 'AgentArchOrch', 'registerModule');
  }

  /**
   * 注销并清理模块（拆卸）
   * @param {string} name - 模块名称
   * @private
   */
  _unregisterModule(name) {
    safeExecute(() => {
      const existed = this._modules.delete(name);
      if (existed) {
        this.emit('module-unregistered', { name });
        debug('AgentArchOrch', 'unregisterModule', 'Name: ' + name);
      }
    }, 'AgentArchOrch', 'unregisterModule');
  }

  /**
   * 获取已注册的模块
   * @param {string} name - 模块名称
   * @returns {Object|null} 模块实例，不存在则返回 null
   * @private
   */
  _getModule(name) {
    return safeExecute(() => {
      const entry = this._modules.get(name);
      return entry ? entry.module : null;
    }, 'AgentArchOrch', 'getModule', null);
  }

  /**
   * 列出所有已注册模块及其能力
   * @returns {Array<Object>} 模块列表
   * @private
   */
  _listModules() {
    const list = [];
    for (const [name, entry] of this._modules) {
      list.push({ name, capabilities: entry.capabilities, registeredAt: entry.registeredAt });
    }
    return list;
  }

  // ─── 查询方法 ─────────────────────────────────────────────────

  /**
   * 获取当前编排器状态
   * @returns {string} 当前状态
   */
  getStatus() {
    return this._status;
  }

  /**
   * 获取六大架构支柱的状态
   * @returns {Object} 各支柱状态信息
   */
  getArchitectureStatus() {
    return {
      [ARCHITECTURE_PILLAR.PROGRESSIVE_DISCLOSURE]: {
        enabled: true,
        layers: this._config.contextLayers,
        strategy: this._config.disclosureStrategy,
        hasAttentionBudgetManager: this._attentionBudgetManager !== null,
        hasContextCompressionEngine: this._contextCompressionEngine !== null,
      },
      [ARCHITECTURE_PILLAR.CONSTRAINT_ENFORCEMENT]: {
        enabled: this._config.enablePromptSuggestions || this._config.enableHardConstraints || this._config.enableLinterValidation,
        constraintCount: this._constraintRegistry.size,
        hasIronRuleEngine: this._ironRuleEngine !== null,
        hasSddDocumentValidator: this._sddDocumentValidator !== null,
      },
      [ARCHITECTURE_PILLAR.SELF_VALIDATION]: {
        enabled: this._config.enablePreValidation || this._config.enablePostValidation,
        maxRetries: this._config.maxValidationRetries,
        requireMultiFileReview: this._config.requireMultiFileReview,
        hasHookComposer: this._hookComposer !== null,
        hasProgrammableHookExecutor: this._programmableHookExecutor !== null,
      },
      [ARCHITECTURE_PILLAR.CONTEXT_ISOLATION]: {
        enabled: this._config.enableMemoryIsolation,
        allowCrossAgentMemory: this._config.allowCrossAgentMemory,
        namespaceCount: this._agentNamespaces.size,
        hasIsolatedContextManager: this._isolatedContextManager !== null,
      },
      [ARCHITECTURE_PILLAR.ENTROPY_GOVERNANCE]: {
        enabled: this._config.autoCleanupEnabled,
        currentScore: this._entropyScore,
        checkIntervalMs: this._config.entropyCheckIntervalMs,
        hasDreamEngine: this._dreamEngine !== null,
        hasThoughtDeduplicator: this._thoughtDeduplicator !== null,
        hasDocFreshnessGuard: this._docFreshnessGuard !== null,
      },
      [ARCHITECTURE_PILLAR.DETACHABILITY]: {
        enabled: this._config.enableHotSwap,
        moduleCount: this._modules.size,
        maxModules: this._config.maxModules,
        hasPluginManager: this._pluginManager !== null,
        hasEventBus: this._eventBus !== null,
      },
    };
  }

  /**
   * 获取约束注册表（防御性拷贝）
   * @returns {Map} 约束注册表的浅拷贝
   */
  getConstraintRegistry() {
    const copy = new Map();
    for (const [key, value] of this._constraintRegistry) {
      copy.set(key, value);
    }
    return copy;
  }

  /**
   * 获取当前熵值分数
   * @returns {number} 熵值分数
   */
  getEntropyScore() {
    return this._entropyScore;
  }

  /**
   * 获取模块注册表（防御性拷贝）
   * @returns {Map} 模块注册表的浅拷贝
   */
  getModuleRegistry() {
    const copy = new Map();
    for (const [key, value] of this._modules) {
      copy.set(key, value);
    }
    return copy;
  }

  // ─── 关闭清理 ─────────────────────────────────────────────────

  /**
   * 关闭时的清理逻辑，清理所有子控制器和命名空间
   * @private
   */
  _onShutdown() {
    debug('AgentArchOrch', 'onShutdown', 'Cleaning up orchestrator');

    // 清理Agent命名空间
    for (const [, namespace] of this._agentNamespaces) {
      if (namespace && typeof namespace.clear === 'function') {
        namespace.clear();
      }
    }
    this._agentNamespaces.clear();

    // 清理记忆访问授权
    for (const [, grants] of this._memoryAccessGrants) {
      if (grants && typeof grants.clear === 'function') {
        grants.clear();
      }
    }
    this._memoryAccessGrants.clear();

    // 清理约束注册表
    this._constraintRegistry.clear();

    // 清理验证钩子
    this._validationHooks.clear();

    // 清理上下文层
    this._contextLayers.clear();

    // 清理模块
    this._modules.clear();

    // 清理熵值历史
    this._entropyHistory = [];
    this._entropyScore = 0;

    // 清除外部模块引用
    this._attentionBudgetManager = null;
    this._contextCompressionEngine = null;
    this._ironRuleEngine = null;
    this._sddDocumentValidator = null;
    this._hookComposer = null;
    this._programmableHookExecutor = null;
    this._isolatedContextManager = null;
    this._dreamEngine = null;
    this._thoughtDeduplicator = null;
    this._docFreshnessGuard = null;
    this._pluginManager = null;
    this._eventBus = null;

    // 清除子控制器
    this._progressiveDisclosureController = null;
    this._constraintPromptCompiler = null;
    this._verificationLoopMiddleware = null;
    this._agentMemoryNamespace = null;
    this._entropyGovernanceOrchestrator = null;
    this._moduleContainer = null;

    this._status = 'shutdown';
  }
}

module.exports = withShutdown(AgentArchitectureOrchestrator);
module.exports.ARCHITECTURE_PILLAR = ARCHITECTURE_PILLAR;
module.exports.CONSTRAINT_TYPE = CONSTRAINT_TYPE;
module.exports.VALIDATION_PHASE = VALIDATION_PHASE;
module.exports.ENTROPY_LEVEL = ENTROPY_LEVEL;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
