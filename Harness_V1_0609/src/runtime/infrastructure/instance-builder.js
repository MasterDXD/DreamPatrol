/**
 * @module runtime/infrastructure/instance-builder
 * @description 实例构建器模块，负责从运行时上下文中构建框架实例对象。
 * 提供属性映射、分组API构建、实例销毁等核心能力，将分散的运行时组件
 * 聚合为统一的实例接口，支持管道执行和优雅关闭。
 */
'use strict';

const { safeCall } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const eventRegistrar = require('./event-registrar');
const { debug } = require('../../utils/debug-logger');

/** @constant {number} 框架关闭超时时间（毫秒），超过此时间将强制终止关闭流程 */
const SHUTDOWN_TIMEOUT_MS = 15000;
/** @constant {number} 单个组件异步关闭结果等待时间（毫秒），超时后跳过该组件 */
const GRACEFUL_RESULT_WAIT_MS = 2000;

/**
 * 从运行时上下文中构建扁平属性映射表。
 * 将上下文中所有运行时组件（路由器、会话、编排器、权限执行器、TDD门禁、
 * 深化推理管道、Agent子系统、因果子系统等）提取为键值对映射，
 * 供实例对象直接通过属性名访问各组件。
 *
 * @param {Object} ctx - 运行时上下文对象，包含所有已初始化的组件实例
 * @param {Object} ctx.router - Skill路由器
 * @param {Object} ctx.session - 会话管理器
 * @param {Object} ctx.orchestrator - 阶段编排器
 * @param {Object} ctx.enforcer - RBAC权限执行器
 * @param {Object} ctx.guard - 权限守卫
 * @param {Object} ctx.logger - 调试日志器
 * @param {Object} ctx.tddGate - TDD门禁
 * @param {Object} ctx.verifier - 证据验证器
 * @param {Object} ctx.eventBus - 事件总线
 * @param {Object} ctx.deepeningOrchestrator - 深化推理编排器
 * @param {Object} ctx.agentRuntime - Agent运行时
 * @param {returns {Object.<string, Object>} 包含所有运行时组件的扁平属性映射表
 */
function _buildPropertyMap(ctx) {
  return {
    router: ctx.router,
    session: ctx.session,
    orchestrator: ctx.orchestrator,
    enforcer: ctx.enforcer,
    guard: ctx.guard,
    logger: ctx.logger,
    tddGate: ctx.tddGate,
    verifier: ctx.verifier,
    validation: ctx.validation,
    eventBus: ctx.eventBus,
    pluginManager: ctx.pluginManager,
    healthChecker: ctx.healthChecker,
    priorityQueue: ctx.priorityQueue,
    structuredLog: ctx.structuredLog,
    memoryStore: ctx.memoryStore,
    agentChannel: ctx.agentChannel,
    checkpointManager: ctx.checkpointManager,
    retryEngine: ctx.retryEngine,
    skillImprover: ctx.skillImprover,
    concurrencyController: ctx.concurrencyController,
    adversarialReview: ctx.adversarialReview,
    platformCoordinator: ctx.platformCoordinator,
    workflowTemplate: ctx.workflowTemplate,
    complianceChecker: ctx.complianceChecker,
    deviationApproval: ctx.deviationApproval,
    codeReviewCheck: ctx.codeReviewCheck,
    designSkillEngine: ctx.designSkillEngine,
    agentRuntime: ctx.agentRuntime,
    agentLifecycle: ctx.agentLifecycle,
    agentSandbox: ctx.agentSandbox,
    agentMonitor: ctx.agentMonitor,
    agentDeployment: ctx.agentDeployment,
    agentStateManager: ctx.agentStateManager,
    agentWorkflowIntegration: ctx.agentWorkflowIntegration,
    tokenManager: ctx.tokenManager,
    deepeningRegistry: ctx.deepeningRegistry,
    recurrentDeepening: ctx.recurrentDeepening,
    adaptiveDepth: ctx.adaptiveDepth,
    ltiInjector: ctx.ltiInjector,
    multiAgentRouter: ctx.multiAgentRouter,
    outputFusion: ctx.outputFusion,
    iterativeRefinement: ctx.iterativeRefinement,
    progressiveDeepening: ctx.progressiveDeepening,
    deepeningOrchestrator: ctx.deepeningOrchestrator,
    qualityScorer: ctx.qualityScorer,
    tokenAwareDeepening: ctx.tokenAwareDeepening,
    affinityLearner: ctx.affinityLearner,
    convergenceDetector: ctx.convergenceDetector,
    deepeningMetricsCollector: ctx.deepeningMetricsCollector,
    deepeningCache: ctx.deepeningCache,
    deepeningStrategyPlugin: ctx.deepeningStrategyPlugin,
    deepeningReportGenerator: ctx.deepeningReportGenerator,
    deepeningPipeline: ctx.deepeningPipeline,
    deepeningHealthMonitor: ctx.deepeningHealthMonitor,
    deepeningEventStore: ctx.deepeningEventStore,
    deepeningWorkflowTemplate: ctx.deepeningWorkflowTemplate,
    deepeningBenchmark: ctx.deepeningBenchmark,
    skillReducer: ctx.skillReducer,
    generatorVerifier: ctx.generatorVerifier,
    isolatedContextManager: ctx.isolatedContextManager,
    planPersistence: ctx.planPersistence,
    collaborationModeRouter: ctx.collaborationModeRouter,
    structuredIntent: ctx.structuredIntent,
    subagentExecutor: ctx.subagentExecutor,
    pairChat: ctx.pairChat,
    chatChain: ctx.chatChain,
    sqliteStore: ctx.sqliteStore,
    skillImprovementLoop: ctx.skillImprovementLoop,
    memoryNudge: ctx.memoryNudge,
    skillCreationEngine: ctx.skillCreationEngine,
    skillCurator: ctx.skillCurator,
    userModelManager: ctx.userModelManager,
    mcpClient: ctx.mcpClient,
    autoVersionTracker: ctx.autoVersionTracker,
    commandRouter: ctx.commandRouter,
    programmableHookExecutor: ctx.programmableHookExecutor,
    contextCompressionEngine: ctx.contextCompressionEngine,
    agentPackManager: ctx.agentPackManager,
    startupTimings: ctx.startupTimings,
    thoughtExtractor: ctx.thoughtExtractor,
    thoughtDeduplicator: ctx.thoughtDeduplicator,
    thoughtMemoryStore: ctx.thoughtMemoryStore,
    thoughtRetrieverCycle: ctx.thoughtRetrieverCycle,
    embeddingService: ctx.embeddingService,
    modelSelector: ctx.modelSelector,
    projectRoot: ctx.projectRoot,
    goalExecutor: ctx.goalExecutor,
    phaseContextInjector: ctx.phaseContextInjector,
    causalDataBus: ctx.causalDataBus,
    causalMemoryStore: ctx.causalMemoryStore,
    configCausalValidator: ctx.configCausalValidator,
    signalPersistence: ctx.signalPersistence,
    selfEvolutionGovernor: ctx.selfEvolutionGovernor,
    skillPatchApproval: ctx.skillPatchApproval,
    causalVectorIndex: ctx.causalVectorIndex,
    archive: ctx.archive,
    causalBufferManager: ctx.causalBufferManager,
    docFreshnessGuard: ctx.docFreshnessGuard,
    humanApprovalGate: ctx.humanApprovalGate,
    ragPipeline: ctx.ragPipeline,
    oodaLoop: ctx.oodaLoop,
  };
}

/**
 * 从运行时上下文中构建分组API映射表。
 * 将组件按功能域划分为五个分组：core（核心）、agents（Agent子系统）、
 * gate（门禁子系统）、collaboration（协作子系统）、store（存储子系统），
 * 便于消费者按领域访问相关组件集合。
 *
 * @param {Object} ctx - 运行时上下文对象，包含所有已初始化的组件实例
 * @returns {{core: Object, agents: Object, gate: Object, collaboration: Object, store: Object}}
 *   按功能域分组的组件映射表
 * @property {Object} core - 核心组件（路由器、会话、编排器、权限、日志、事件总线等）
 * @property {Object} agents - Agent子系统组件（运行时、生命周期、沙箱、监控、部署等）
 * @property {Object} gate - 门禁子系统组件（TDD门禁、验证器、合规检查、偏差审批等）
 * @property {Object} collaboration - 协作子系统组件（模式路由、意图解析、子Agent执行器、配对对话等）
 * @property {Object} store - 存储子系统组件（SQLite、内存存储、技能改进循环、MCP客户端等）
 */
function _buildGroupedAPI(ctx) {
  return {
    core: {
      router: ctx.router,
      session: ctx.session,
      orchestrator: ctx.orchestrator,
      enforcer: ctx.enforcer,
      guard: ctx.guard,
      logger: ctx.logger,
      tddGate: ctx.tddGate,
      verifier: ctx.verifier,
      eventBus: ctx.eventBus,
      healthChecker: ctx.healthChecker,
      priorityQueue: ctx.priorityQueue,
      tokenManager: ctx.tokenManager,
      commandRouter: ctx.commandRouter,
      programmableHookExecutor: ctx.programmableHookExecutor,
      contextCompressionEngine: ctx.contextCompressionEngine,
    },
    agents: {
      runtime: ctx.agentRuntime,
      lifecycle: ctx.agentLifecycle,
      sandbox: ctx.agentSandbox,
      monitor: ctx.agentMonitor,
      deployment: ctx.agentDeployment,
      stateManager: ctx.agentStateManager,
      workflowIntegration: ctx.agentWorkflowIntegration,
      packManager: ctx.agentPackManager,
    },
    gate: {
      tddGate: ctx.tddGate,
      verifier: ctx.verifier,
      complianceChecker: ctx.complianceChecker,
      deviationApproval: ctx.deviationApproval,
      codeReviewCheck: ctx.codeReviewCheck,
      designSkillEngine: ctx.designSkillEngine,
      generatorVerifier: ctx.generatorVerifier,
    },
    collaboration: {
      modeRouter: ctx.collaborationModeRouter,
      structuredIntent: ctx.structuredIntent,
      subagentExecutor: ctx.subagentExecutor,
      pairChat: ctx.pairChat,
      chatChain: ctx.chatChain,
    },
    store: {
      sqlite: ctx.sqliteStore,
      memory: ctx.memoryStore,
      improvementLoop: ctx.skillImprovementLoop,
      nudge: ctx.memoryNudge,
      creationEngine: ctx.skillCreationEngine,
      curator: ctx.skillCurator,
      userModelManager: ctx.userModelManager,
      mcpClient: ctx.mcpClient,
    },
  };
}

/**
 * 安全调用对象上的指定方法，若对象为空或方法不存在则静默跳过。
 * 内部委托给 safeCall 工具函数，确保异常不会向上传播。
 *
 * @param {Object|null|undefined} obj - 目标对象
 * @param {string} method - 待调用的方法名
 */
function _safeCall(obj, method) {
  safeCall(() => { if (obj && typeof obj[method] === 'function') obj[method](); }, 'Harness', '_safeCall');
}

/**
 * 异步销毁框架实例，执行优雅关闭流程。
 * 按照预定义的关闭顺序依次对各组件执行 flush → shutdown → removeAllListeners，
 * 每个组件的异步 shutdown 最多等待 GRACEFUL_RESULT_WAIT_MS 毫秒，
 * 整体关闭流程最多等待 SHUTDOWN_TIMEOUT_MS 毫秒。
 * 关闭完成后移除全局异常处理器，并通过事件总线和结构化日志记录关闭结果。
 * 使用 _destroying 标志防止重复调用。
 *
 * @param {Object} ctx - 运行时上下文对象
 * @param {boolean} ctx._destroying - 是否正在销毁中（防重入标志）
 * @param {Object} [ctx.structuredLog] - 结构化日志器，用于记录关闭进度
 * @param {Object} [ctx.eventBus] - 事件总线，用于发布 shutdown:started 和 shutdown:completed 事件
 * @param {Object} [ctx.deepeningRegistry] - 深化推理注册表，需优先关闭
 * @param {Object} [ctx.concurrencyController] - 并发控制器，关闭后执行 clear
 * @param {Object} [ctx.agentChannel] - Agent通信通道，关闭后执行 clear
 * @param {Function} [ctx._uncaughtHandler] - 全局未捕获异常处理器，关闭后移除
 * @param {Function} [ctx._rejectionHandler] - 全局未处理拒绝处理器，关闭后移除
 * @returns {Promise<void>} 关闭流程完成后的 Promise
 */
async function _destroyInstance(ctx) {
  if (ctx._destroying) return;
  ctx._destroying = true;
  const shutdownStart = Date.now();

  if (ctx.structuredLog) ctx.structuredLog.info('Framework shutdown initiated');
  if (ctx.eventBus) ctx.eventBus.emit('shutdown:started', { timestamp: Date.now() });

  if (ctx.deepeningRegistry) ctx.deepeningRegistry.shutdown();
  const shutdownOrder = [
    ctx.router, ctx.orchestrator, ctx.enforcer, ctx.guard, ctx.tddGate, ctx.verifier, ctx.healthChecker,
    ctx.complianceChecker, ctx.designSkillEngine, ctx.retryEngine,
    ctx.adversarialReview, ctx.platformCoordinator,
    ctx.agentRuntime, ctx.agentMonitor, ctx.agentLifecycle, ctx.agentDeployment,
    ctx.agentWorkflowIntegration, ctx.agentSandbox, ctx.agentStateManager,
    ctx.session, ctx.memoryStore, ctx.logger, ctx.deviationApproval, ctx.codeReviewCheck,
    ctx.pluginManager, ctx.eventBus, ctx.concurrencyController, ctx.agentChannel,
    ctx.checkpointManager, ctx.skillImprover, ctx.tokenManager,
    ctx.skillReducer, ctx.generatorVerifier, ctx.isolatedContextManager, ctx.planPersistence,
    ctx.collaborationModeRouter, ctx.structuredIntent, ctx.subagentExecutor,
    ctx.pairChat, ctx.chatChain, ctx.memoryNudge, ctx.skillImprovementLoop,
    ctx.skillCurator, ctx.skillCreationEngine, ctx.userModelManager, ctx.mcpClient,
    ctx.commandRouter, ctx.programmableHookExecutor, ctx.contextCompressionEngine,
    ctx.agentPackManager, ctx.sqliteStore, ctx.autoVersionTracker,
    ctx.thoughtDeduplicator, ctx.thoughtExtractor, ctx.thoughtMemoryStore,
    ctx.thoughtRetrieverCycle,
    ctx.embeddingService,
    ctx.modelSelector,
    ctx.goalExecutor,
    ctx.selfEvolutionGovernor,
    ctx.skillPatchApproval,
    ctx.causalVectorIndex,
    ctx.signalPersistence,
    ctx.docFreshnessGuard,
    ctx.causalMemoryStore,
    ctx.configCausalValidator,
    ctx.phaseContextInjector,
    ctx.humanApprovalGate,
    ctx.causalBufferManager,
    ctx.causalDataBus,
    ctx.archive,
    ctx.workflowTemplate,
  ].filter(Boolean);

  const completedShutdowns = [];
  const failedShutdowns = [];

  const shutdownPromise = (async function() {
    for (const obj of shutdownOrder) {
      _safeCall(obj, 'flush');
      if (obj.shutdown && typeof obj.shutdown === 'function') {
        try {
          const result = obj.shutdown();
          if (result && typeof result.then === 'function') {
            result.catch(function(err) { debug('InstanceBuilder', 'raceTimeout', err && err.message ? err.message : String(err)); });
            let raceTimer;
            await Promise.race([result, new Promise(function(r) {
              raceTimer = setTimeout(r, GRACEFUL_RESULT_WAIT_MS);
              if (raceTimer && typeof raceTimer.unref === 'function') raceTimer.unref();
            })]);
            if (raceTimer) clearTimeout(raceTimer);
          }
          completedShutdowns.push(true);
        } catch (err) {
          failedShutdowns.push(err && err.message ? err.message : String(err));
        }
      }
      _safeCall(obj, 'removeAllListeners');
    }
  })();

  try {
    shutdownPromise.catch(function(err) { debug('InstanceBuilder', 'shutdownTimeout', err && err.message ? err.message : String(err)); });
    let outerTimer;
    await Promise.race([
      shutdownPromise,
      new Promise(function(r) {
        outerTimer = setTimeout(r, SHUTDOWN_TIMEOUT_MS);
        if (outerTimer && typeof outerTimer.unref === 'function') outerTimer.unref();
      }),
    ]);
    if (outerTimer) clearTimeout(outerTimer);
  } catch (raceErr) {
    debug('InstanceBuilder', '_destroyInstanceRaceError', { error: raceErr && raceErr.message ? raceErr.message : String(raceErr) });
    ctx._state = 'error';
  }

  _safeCall(ctx.concurrencyController, 'clear');
  _safeCall(ctx.agentChannel, 'clear');

  const shutdownDuration = Date.now() - shutdownStart;
  if (ctx.structuredLog) {
    ctx.structuredLog.info('Harness framework destroyed', {
      durationMs: shutdownDuration,
      completed: completedShutdowns.length,
      failed: failedShutdowns.length,
    });
  }
  if (ctx.eventBus) {
    ctx.eventBus.emit('shutdown:completed', {
      durationMs: shutdownDuration,
      completed: completedShutdowns.length,
      failed: failedShutdowns.length,
      timestamp: Date.now(),
    });
  }

  if (ctx._uncaughtHandler) {
    process.removeListener('uncaughtException', ctx._uncaughtHandler);
    ctx._uncaughtHandler = null;
  }
  if (ctx._rejectionHandler) {
    process.removeListener('unhandledRejection', ctx._rejectionHandler);
    ctx._rejectionHandler = null;
  }
  eventRegistrar.shutdown();
  const _errorHandlersKey = Symbol.for('harness:errorHandlers');
  global[_errorHandlersKey] = false;
}

/**
 * 构建框架实例对象，将扁平属性映射、分组API、管道执行和销毁方法合并为统一实例。
 * 实例对象同时具备所有组件的直接属性访问、按功能域分组的API访问、
 * 管道执行（executePipeline）和优雅销毁（destroy）能力。
 *
 * @param {Object} ctx - 运行时上下文对象，包含所有已初始化的组件实例
 * @param {Function} executePipeline - 管道执行函数，签名为 (ctx, userMessage, options) => Promise<*>
 *   接收上下文、用户消息和选项，返回管道执行结果
 * @returns {Object} 框架实例对象，包含以下能力：
 *   - 所有 _buildPropertyMap 产出的扁平属性
 *   - 所有 _buildGroupedAPI 产出的分组API（core/agents/gate/collaboration/store）
 *   - executePipeline(userMessage, options) 异步方法：执行消息处理管道
 *   - destroy() 异步方法：优雅销毁框架实例
 */
function buildInstance(ctx, executePipeline) {
  const props = _buildPropertyMap(ctx);
  const groups = _buildGroupedAPI(ctx);

  const instance = mergeConfig(mergeConfig(props, groups), {
    async executePipeline(userMessage, options) {
      return executePipeline(ctx, userMessage, options);
    },

    async destroy() {
      try {
        await _destroyInstance(ctx);
      } catch (destroyErr) {
        debug('InstanceBuilder', 'destroyError', { error: destroyErr && destroyErr.message ? destroyErr.message : String(destroyErr) });
      }
    },
  });

  return instance;
}

module.exports = { buildInstance, _destroyInstance, _buildPropertyMap, _buildGroupedAPI };
