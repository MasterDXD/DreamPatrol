/**
 * @module runtime/infrastructure/event-registrar
 * @description 事件注册器——负责统一注册、转发和连接 Harness 运行时中各子系统的事件监听器。
 * 核心职责包括：
 * 1. 将各子模块（Agent、深化推理、协作、因果、演化等）的事件统一转发到全局事件总线；
 * 2. 初始化因果子系统（CausalDataBus、CausalBufferManager 等）并完成模块间依赖注入；
 * 3. 初始化自演化子系统（SignalPersistence、SelfEvolutionGovernor 等）并连接质量反馈闭环；
 * 4. 注册会话生命周期事件（创建、阶段转换、技能完成、预算告警、关闭）；
 * 5. 挂载审计中间件，对关键前缀事件自动记录审计日志；
 * 6. 提供 shutdown 方法，安全移除所有已注册的监听器，防止内存泄漏。
 */
'use strict';

const { debug } = require('../../utils/debug-logger');
const { safeCall, safeExecute } = require('../../utils/safe-execute');
const { SESSION_STATUS_ACTIVE, DEFAULT_MIN_HEARTBEAT_MS, DEFAULT_PIPELINE_TIMEOUT_MS } = require('../../utils/constants');
const GoalExecutor = require('../workflow/goal-executor');
const PhaseContextInjector = require('../context/phase-context-injector');
const CausalDataBus = require('../causal/causal-data-bus');
const CausalBufferManager = require('../causal/causal-buffer-manager');
const CausalMemoryStore = require('../causal/causal-memory-store');
const ConfigCausalValidator = require('../causal/causal-config-validator');
const DocFreshnessGuard = require('../quality/doc-freshness-guard');
const HumanApprovalGate = require('../workflow/human-approval-gate');
const SignalPersistence = require('./signal-persistence');
const SelfEvolutionGovernor = require('../quality/self-evolution-governor');
const SkillPatchApproval = require('../../gate/skill-patch-approval');
const CausalVectorIndex = require('../causal/causal-vector-index');

/**
 * 事件转发映射表——定义各子模块源事件到全局事件总线命名空间的转发规则。
 * 每个条目包含 src（上下文中对应的模块属性名）和 events（[源事件名, 目标事件名] 对数组）。
 * @type {Array<{src: string, events: Array<[string, string]>}>}
 */
const EVENT_FORWARD_MAP = [
  { src: 'agentRuntime', events: [
    ['agent-state-change', 'agent:state-change'],
    ['agent-registered', 'agent:registered'],
    ['resource-allocated', 'agent:resource-allocated'],
  ]},
  { src: 'agentMonitor', events: [
    ['alert', 'agent:monitor-alert'],
    ['critical-alert', 'agent:critical-alert'],
    ['antipattern-detected', 'agent:antipattern-detected'],
  ]},
  { src: 'agentLifecycle', events: [
    ['agent-created', 'agent:created'],
    ['agent-started', 'agent:started'],
    ['agent-stopped', 'agent:stopped'],
    ['agent-destroyed', 'agent:destroyed'],
  ]},
  { src: 'agentDeployment', events: [
    ['deployment-completed', 'agent:deployed'],
    ['deployment-failed', 'agent:deploy-failed'],
  ]},
  { src: 'agentWorkflowIntegration', events: [
    ['task-submitted', 'agent:task-submitted'],
    ['task-started', 'agent:task-started'],
    ['task-failed', 'agent:task-failed'],
  ]},
  { src: 'recurrentDeepening', events: [
    ['iteration-complete', 'deepening:iteration'],
    ['converged', 'deepening:converged'],
  ]},
  { src: 'adaptiveDepth', events: [
    ['complexity-assessed', 'deepening:complexity'],
  ]},
  { src: 'multiAgentRouter', events: [
    ['routed', 'deepening:routed'],
  ]},
  { src: 'outputFusion', events: [
    ['fusion-complete', 'deepening:fused'],
  ]},
  { src: 'iterativeRefinement', events: [
    ['refinement-round', 'deepening:refinement'],
  ]},
  { src: 'progressiveDeepening', events: [
    ['execution-complete', 'deepening:progressive'],
  ]},
  { src: 'qualityScorer', events: [
    ['scored', 'deepening:scored'],
  ]},
  { src: 'tokenAwareDeepening', events: [
    ['iteration-cost-recorded', 'deepening:token-cost'],
  ]},
  { src: 'affinityLearner', events: [
    ['execution-recorded', 'deepening:affinity-learned'],
  ]},
  { src: 'convergenceDetector', events: [
    ['convergence-checked', 'deepening:convergence'],
  ]},
  { src: 'deepeningMetricsCollector', events: [
    ['metric-recorded', 'deepening:metric'],
  ]},
  { src: 'deepeningCache', events: [
    ['cache-hit', 'deepening:cache-hit'],
    ['cache-stored', 'deepening:cache-stored'],
  ]},
  { src: 'deepeningHealthMonitor', events: [
    ['health-checked', 'deepening:health-checked'],
  ]},
  { src: 'deepeningEventStore', events: [
    ['event-recorded', 'deepening:event-recorded'],
  ]},
  { src: 'skillReducer', events: [
    ['discovered', 'skill-reducer:discovered'],
    ['l2-loaded', 'skill-reducer:l2-loaded'],
    ['l2-unloaded', 'skill-reducer:l2-unloaded'],
    ['l2-hit', 'skill-reducer:l2-hit'],
    ['l3-loaded', 'skill-reducer:l3-loaded'],
    ['l3-unloaded', 'skill-reducer:l3-unloaded'],
    ['overload-detected', 'skill-reducer:overload-detected'],
    ['skills-activated', 'skill-reducer:skills-activated'],
    ['skills-deactivated', 'skill-reducer:skills-deactivated'],
  ]},
  { src: 'generatorVerifier', events: [
    ['verification-complete', 'generator-verifier:verification-complete'],
  ]},
  { src: 'isolatedContextManager', events: [
    ['context-created', 'isolated-context:created'],
    ['result-submitted', 'isolated-context:result-submitted'],
  ]},
  { src: 'planPersistence', events: [
    ['plan-created', 'plan-persistence:plan-created'],
    ['plan-updated', 'plan-persistence:plan-updated'],
  ]},
  { src: 'collaborationModeRouter', events: [
    ['mode-selected', 'collaboration-mode:selected'],
  ]},
  { src: 'structuredIntent', events: [
    ['intent-parsed', 'structured-intent:parsed'],
  ]},
  { src: 'subagentExecutor', events: [
    ['subagent-spawned', 'subagent:spawned'],
    ['subagent-failed', 'subagent:failed'],
    ['subagent-cancelled', 'subagent:cancelled'],
    ['subagent-started', 'subagent:started'],
    ['subagent-retry', 'subagent:retry'],
    ['subagent-completed', 'subagent:completed'],
  ]},
  { src: 'pairChat', events: [
    ['session-started', 'pair-chat:session-started'],
    ['consensus-reached', 'pair-chat:consensus-reached'],
    ['consensus-failed', 'pair-chat:consensus-failed'],
    ['round-completed', 'pair-chat:round-completed'],
    ['session-destroyed', 'pair-chat:session-destroyed'],
    ['round-timeout', 'pair-chat:round-timeout'],
    ['cross-validation-started', 'pair-chat:cross-validation-started'],
    ['hallucination-detected', 'pair-chat:hallucination-detected'],
    ['cross-validation-completed', 'pair-chat:cross-validation-completed'],
  ]},
  { src: 'chatChain', events: [
    ['chain-created', 'chat-chain:chain-created'],
    ['chain-completed', 'chat-chain:chain-completed'],
    ['chain-failed', 'chat-chain:chain-failed'],
    ['chain-task-retry', 'chat-chain:chain-task-retry'],
    ['artifact-registered', 'chat-chain:artifact-registered'],
    ['artifact-versioned', 'chat-chain:artifact-versioned'],
  ]},
  { src: 'devMetricsCollector', events: [
    ['project-started', 'dev-metrics:project-started'],
    ['project-completed', 'dev-metrics:project-completed'],
    ['phase-started', 'dev-metrics:phase-started'],
    ['phase-completed', 'dev-metrics:phase-completed'],
    ['hallucination-corrected', 'dev-metrics:hallucination-corrected'],
  ]},
  { src: 'guard', events: [
    ['confirmation-recorded', 'permission:confirmation-recorded'],
  ]},
  { src: 'memoryNudge', events: [
    ['memories-invalidated-by-code-change', 'memory:invalidated-by-code-change'],
    ['memories-invalidated', 'memory:invalidated'],
    ['memory-verified', 'memory:verified'],
  ]},
  { src: 'thoughtRetrieverCycle', events: [
    ['cycle-complete', 'thought-retriever:cycle-complete'],
    ['step-complete', 'thought-retriever:step-complete'],
  ]},
  { src: 'modelSelector', events: [
    ['model-downgraded', 'model-selector:downgraded'],
    ['usage-recorded', 'model-selector:usage-recorded'],
  ]},
];

/**
 * 条件性事件转发映射表——仅当对应子模块在上下文中存在时才注册转发。
 * 用于深化推理编排器和管道等可能延迟初始化的模块。
 * @type {Array<{src: string, events: Array<[string, string]>}>}
 */
const CONDITIONAL_EVENT_FORWARD_MAP = [
  { src: 'deepeningOrchestrator', events: [
    ['execution-complete', 'deepening:orchestrated'],
    ['execution-start', 'deepening:execution-start'],
    ['depth-assessed', 'deepening:depth-assessed'],
    ['agents-selected', 'deepening:agents-selected'],
    ['iteration-complete', 'deepening:iteration-complete'],
    ['converged', 'deepening:converged'],
  ]},
  { src: 'deepeningPipeline', events: [['pipeline-complete', 'deepening:pipeline-complete']] },
];

/**
 * 懒加载深化推理事件映射表——通过 deepeningRegistry 按需加载子模块实例后注册事件转发。
 * 键为注册表中的模块标识符，值包含 event（源事件名）和 emit（目标事件名）。
 * @type {Object<string, {event: string, emit: string}>}
 */
const LAZY_DEEPENING_EVENT_MAP = {
  'deepening-workflow-template': { event: 'template-registered', emit: 'deepening:template-registered' },
  'deepening-benchmark': { event: 'benchmark-complete', emit: 'deepening:benchmark-complete' },
  'deepening-state-machine': { event: 'state-transition', emit: 'deepening:state-transition' },
  'deepening-error-handler': { event: 'error-occurred', emit: 'deepening:error-occurred' },
  'deepening-rate-limiter': { event: 'rate-limited', emit: 'deepening:rate-limited' },
  'deepening-snapshot': { event: 'snapshot-created', emit: 'deepening:snapshot-created' },
  'deepening-notifier': { event: 'notification-sent', emit: 'deepening:notification-sent' },
  'deepening-circuit-breaker': { event: 'circuit-state-change', emit: 'deepening:circuit-state-change' },
  'deepening-task-queue': { event: 'task-completed', emit: 'deepening:task-completed' },
  'deepening-resource-manager': { event: 'resource-allocated', emit: 'deepening:resource-allocated' },
  'deepening-audit-trail': { event: 'audit-recorded', emit: 'deepening:audit-recorded' },
  'deepening-config-manager': { event: 'config-changed', emit: 'deepening:config-changed' },
};

/**
 * 审计日志事件前缀列表——以这些前缀开头的事件将自动被审计中间件记录。
 * 涵盖 Agent、会话、权限、协作、子代理、技能、因果、记忆、思维检索、模型选择等命名空间。
 * @type {string[]}
 */
const AUDIT_PREFIXES = [
  'agent:', 'session:', 'permission:', 'collaboration-mode:', 'structured-intent:',
  'subagent:', 'pair-chat:', 'chat-chain:', 'dev-metrics:', 'skill-reducer:', 'generator-verifier:',
  'isolated-context:', 'plan-persistence:', 'deepening:', 'memory:',
  'thought-retriever:', 'model-selector:',
];

/** 因果不变量通过时的置信度阈值 */
const INVARIANT_PASSED_CONFIDENCE = 0.85;
/** 因果不变量未通过时的置信度阈值 */
const INVARIANT_FAILED_CONFIDENCE = 0.5;
/** 因果蒸馏时提取原因字段的最大数量 */
const MAX_CAUSE_KEYS = 3;
/** 因果蒸馏时提取结果字段的最大数量 */
const MAX_EFFECT_KEYS = 5;
/** 子代理执行出错时的质量评分 */
const ERROR_QUALITY_SCORE = 0.2;
/** 子代理执行正常时的基础质量评分 */
const BASE_QUALITY_SCORE = 0.5;
/** 基于执行时长的质量加分上限 */
const DURATION_QUALITY_BONUS_CAP = 0.5;
/** 质量加分参考时长（毫秒），低于此时长获得更高加分 */
const DURATION_QUALITY_REF_MS = DEFAULT_MIN_HEARTBEAT_MS;
/** 技能改进学习记录摘要的最大字符长度 */
const SUMMARY_MAX_LENGTH = 100;

/**
 * 已注册监听器列表——记录所有通过 _registerListener 注册的事件监听器，
 * 用于 shutdown 时批量移除，防止内存泄漏。
 * @type {Array<{emitter: Object, event: string, handler: Function}>}
 * @private
 */
let _registeredListeners = [];

/**
 * 注册事件监听器并记录到内部列表，以便后续 shutdown 时统一移除。
 * @param {Object} emitter - 事件发射器实例（需实现 on 方法）
 * @param {string} event - 事件名称
 * @param {Function} handler - 事件处理函数
 * @private
 */
function _registerListener(emitter, event, handler) {
  emitter.on(event, handler);
  _registeredListeners.push({ emitter, event, handler });
}

/**
 * 根据映射表批量转发事件：遍历映射表中每个分组，将源模块的事件转发到事件总线的目标事件名。
 * 源模块不存在时静默跳过。转发过程通过 safeCall 包裹，确保单次转发异常不影响后续事件。
 * @param {Object} ctx - 运行时上下文，包含各子模块实例和 eventBus
 * @param {Array<{src: string, events: Array<[string, string]>}>} map - 事件转发映射表
 * @private
 */
function _forwardMappedEvents(ctx, map) {
  for (const group of map) {
    const src = ctx[group.src];
    if (!src) continue;
    for (const pair of group.events) {
      const handler = function(e) { safeCall(() => ctx.eventBus.emit(pair[1], e), 'Harness', 'forwardEvent'); };
      _registerListener(src, pair[0], handler);
    }
  }
}

/**
 * 注册所有事件转发规则的总入口。依次完成：
 * 1. 基于 EVENT_FORWARD_MAP 和 CONDITIONAL_EVENT_FORWARD_MAP 的批量事件转发；
 * 2. 懒加载深化推理模块的事件转发；
 * 3. 协作模式路由器与子代理执行器的双向关联；
 * 4. GoalExecutor 的初始化与依赖注入；
 * 5. 因果子系统的初始化、连接和蒸馏；
 * 6. 配置因果验证器与上下文压缩引擎的关联；
 * 7. 自演化模块的初始化；
 * 8. 模块级事件转发、子代理完成处理、链式对话事件注册。
 * @param {Object} ctx - 运行时上下文，包含所有子模块实例和配置
 * @private
 */
/**
 * Register all event forwarding rules. This is the main entry point that orchestrates:
 * 1. Batch event forwarding based on EVENT_FORWARD_MAP and CONDITIONAL_EVENT_FORWARD_MAP;
 * 2. Lazy-loaded deepening module event forwarding;
 * 3. Collaboration mode router and subagent executor wiring;
 * 4. GoalExecutor initialization and dependency injection;
 * 5. Causal subsystem initialization, connection, and distillation;
 * 6. Config causal validator and context compression engine wiring;
 * 7. Self-evolution module initialization;
 * 8. Module-level event forwarding, subagent completion handlers, and chat chain events.
 * @param {Object} ctx - Runtime context containing all submodule instances and configuration
 * @example
 * const ctx = {
 *   eventBus, agentRuntime, agentMonitor, session, subagentExecutor,
 *   collaborationModeRouter, agentChannel, modelSelector, enforcer,
 *   isolatedContextManager, planPersistence, deepeningOrchestrator,
 *   deepeningRegistry, projectRoot, structuredLog, router, orchestrator,
 *   healthChecker, qualityScorer, convergenceDetector, selfReflection,
 *   skillImprovementLoop, deepeningTaskScheduler, embeddingService,
 *   chatChain, skillCreationEngine, memoryStore, logger, sqliteStore,
 *   checkpointManager, affinityLearner, thoughtRetrieverCycle
 * };
 * _registerEventForwarding(ctx);
 */
function _registerEventForwarding(ctx) {
  _forwardMappedEvents(ctx, EVENT_FORWARD_MAP);
  _forwardMappedEvents(ctx, CONDITIONAL_EVENT_FORWARD_MAP);

  _wireLazyDeepeningEvents(ctx.deepeningRegistry, ctx.eventBus);

  ctx.collaborationModeRouter.attachSubagentExecutor(ctx.subagentExecutor);
  ctx.collaborationModeRouter.attachAgentChannel(ctx.agentChannel);
  ctx.subagentExecutor.attachSessionManager(ctx.session);
  ctx.subagentExecutor.attachModelSelector(ctx.modelSelector);
  ctx.subagentExecutor.attachRBACEnforcer(ctx.enforcer);
  ctx.subagentExecutor.attachContextManager(ctx.isolatedContextManager);

  try {
    ctx.goalExecutor = new GoalExecutor({ projectRoot: ctx.projectRoot });
    ctx.goalExecutor.attachSessionManager(ctx.session);
    ctx.goalExecutor.attachPlanPersistence(ctx.planPersistence);
    ctx.goalExecutor.attachDeepeningOrchestrator(ctx.deepeningOrchestrator);
    ctx.goalExecutor.attachSubagentExecutor(ctx.subagentExecutor);
    ctx.goalExecutor.attachThoughtRetrieverCycle(ctx.thoughtRetrieverCycle);
  } catch (goalErr) {
    debug('Harness', 'goalExecutorInitError', goalErr);
    if (ctx.structuredLog) ctx.structuredLog.error('GoalExecutor initialization failed', { error: goalErr && goalErr.message ? goalErr.message : String(goalErr) });
  }

  _initCausalModules(ctx);
  _wireCausalAttachments(ctx);
  _wireCausalDistillation(ctx);

  if (ctx.configCausalValidator && ctx.contextCompressionEngine) {
    ctx.configCausalValidator.buildDependencyGraph();
    ctx.contextCompressionEngine.attachConfigCausalValidator(ctx.configCausalValidator);
    if (ctx.causalBufferManager) {
      ctx.contextCompressionEngine.attachCausalBufferManager(ctx.causalBufferManager);
    }
  }

  _initEvolutionModules(ctx);
  _forwardModuleEvents(ctx);
  _wireSubagentCompletionHandlers(ctx);
  _wireChatChainEvents(ctx);
}

/**
 * 初始化因果子系统模块：阶段上下文注入器、因果数据总线、因果缓冲管理器、
 * 因果内存存储、因果配置验证器、文档新鲜度守卫、人工审批门。
 * 初始化失败时记录错误日志但不中断整体流程。
 * @param {Object} ctx - 运行时上下文，初始化后的模块实例将挂载到 ctx 上
 * @private
 */
function _initCausalModules(ctx) {
  try {
    ctx.phaseContextInjector = new PhaseContextInjector(ctx.projectRoot);
    ctx.causalDataBus = CausalDataBus.fromConfig(ctx.projectRoot);
    ctx.causalBufferManager = new CausalBufferManager();
    ctx.causalBufferManager.attachCausalDataBus(ctx.causalDataBus);
    ctx.causalMemoryStore = new CausalMemoryStore(ctx.sqliteStore);
    ctx.configCausalValidator = new ConfigCausalValidator(ctx.projectRoot);
    ctx.docFreshnessGuard = new DocFreshnessGuard({ projectRoot: ctx.projectRoot, eventBus: ctx.eventBus });
    ctx.humanApprovalGate = new HumanApprovalGate({ timeout: DEFAULT_PIPELINE_TIMEOUT_MS });
    if (ctx.sqliteStore) {
      ctx.causalDataBus.attachSqliteStore(ctx.sqliteStore);
    }
  } catch (cabErr) {
    debug('Harness', 'cabInitError', cabErr);
    if (ctx.structuredLog) ctx.structuredLog.error('Causal module initialization failed', { error: cabErr && cabErr.message ? cabErr.message : String(cabErr) });
  }
}

/**
 * 连接因果子系统与其它模块的依赖关系：
 * - 会话管理器 ← 阶段上下文注入器、因果数据总线；
 * - 因果缓冲管理器 ← 技能路由器；
 * - 目标执行器 ← 因果数据总线；
 * - 流程编排器 ← 因果数据总线；
 * - 深化推理编排器 ← 因果数据总线。
 * @param {Object} ctx - 运行时上下文，包含已初始化的各模块实例
 * @private
 */
function _wireCausalAttachments(ctx) {
  if (ctx.phaseContextInjector && ctx.session) {
    ctx.session.attachPhaseContextInjector(ctx.phaseContextInjector);
  }
  if (ctx.causalDataBus && ctx.session) {
    ctx.session.attachCausalDataBus(ctx.causalDataBus);
  }
  if (ctx.causalBufferManager && ctx.router) {
    ctx.causalBufferManager.attachSkillRouter(ctx.router);
  }
  if (ctx.causalDataBus && ctx.goalExecutor) {
    ctx.goalExecutor.attachCausalDataBus(ctx.causalDataBus);
  }
  if (ctx.causalDataBus && ctx.orchestrator) {
    ctx.orchestrator.attachCausalDataBus(ctx.causalDataBus);
  }
  if (ctx.causalDataBus && ctx.deepeningOrchestrator) {
    ctx.deepeningOrchestrator.attachCausalDataBus(ctx.causalDataBus);
  }
}

/**
 * 监听因果数据总线的 output-published 事件，将因果链中通过不变量验证的条目
 * 蒸馏为因果记忆并存入 CausalMemoryStore。蒸馏过程提取原因和结果的关键字段，
 * 根据不变量是否通过赋予不同置信度。未通过不变量的条目将被跳过。
 * @param {Object} ctx - 运行时上下文，需包含 causalDataBus 和 causalMemoryStore
 * @private
 */
function _wireCausalDistillation(ctx) {
  if (!ctx.causalDataBus || !ctx.causalMemoryStore) return;
  const handler = function(e) {
    try {
      const chainEntry = ctx.causalDataBus.getCausalChainForSkill(e.skillId)
        .find(function(entry) { return entry.causalId === e.causalId; });
      if (!chainEntry) return;
      if (chainEntry.invariantPassed === false) return;
      const data = chainEntry.data ?? {};
      const causeKeys = Object.keys(data).slice(0, MAX_CAUSE_KEYS);
      const cause = causeKeys.length > 0
        ? e.skillId + ' received: ' + causeKeys.join(', ')
        : e.skillId + ' execution';
      const effectKeys = Object.keys(data).slice(0, MAX_EFFECT_KEYS);
      const effect = effectKeys.length > 0
        ? e.skillId + ' produced: ' + effectKeys.join(', ')
        : e.skillId + ' completed';
      try {
        const causalResult = ctx.causalMemoryStore.addCausalMemory({
          cause: cause,
          effect: effect,
          context: 'causal-bus-distillation',
          confidence: chainEntry.invariantPassed === true ? INVARIANT_PASSED_CONFIDENCE : INVARIANT_FAILED_CONFIDENCE,
          category: e.skillId,
          source: 'causal-bus-auto',
        });
        Promise.resolve(causalResult).catch(function(err) { debug('Harness', 'causalDistillPersistError', err && err.message ? err.message : String(err)); });
      } catch (_syncErr) {
        debug('Harness', 'causalDistillSyncError', _syncErr && _syncErr.message ? _syncErr.message : String(_syncErr));
      }
    } catch (_distillErr) {
      debug('Harness', 'causalDistillError', _distillErr);
    }
  };
  _registerListener(ctx.causalDataBus, 'output-published', handler);
}

/**
 * 初始化自演化子系统模块：信号持久化器、自演化治理器、技能补丁审批器、因果向量索引。
 * 并将信号持久化器连接到收敛检测器、质量评分器、自反思模块；
 * 将技能补丁审批器连接到技能改进循环；
 * 将因果数据总线连接到健康检查器；
 * 将质量评分器、收敛检测器、调度器连接到自演化治理器；
 * 将因果向量索引连接到因果内存存储。
 * 初始化失败时记录错误日志但不中断整体流程。
 * @param {Object} ctx - 运行时上下文，初始化后的模块实例将挂载到 ctx 上
 * @private
 */
function _initEvolutionModules(ctx) {
  try {
    ctx.signalPersistence = new SignalPersistence({ projectRoot: ctx.projectRoot });
    ctx.selfEvolutionGovernor = new SelfEvolutionGovernor({
      signalPersistence: ctx.signalPersistence,
      healthChecker: ctx.healthChecker,
      causalDataBus: ctx.causalDataBus,
    });
    ctx.skillPatchApproval = new SkillPatchApproval({ projectRoot: ctx.projectRoot });
    ctx.causalVectorIndex = new CausalVectorIndex({
      embeddingService: ctx.embeddingService,
    });

    if (ctx.convergenceDetector) {
      ctx.convergenceDetector.attachSignalPersistence(ctx.signalPersistence);
    }
    if (ctx.qualityScorer) {
      ctx.qualityScorer.attachSignalPersistence(ctx.signalPersistence);
    }
    if (ctx.selfReflection) {
      ctx.selfReflection.attachSignalPersistence(ctx.signalPersistence);
    }
    if (ctx.skillImprovementLoop) {
      ctx.skillImprovementLoop.attachPatchApproval(ctx.skillPatchApproval);
    }
    if (ctx.healthChecker && ctx.causalDataBus) {
      ctx.healthChecker.attachCausalDataBus(ctx.causalDataBus);
    }

    if (ctx.selfEvolutionGovernor) {
      ctx.selfEvolutionGovernor.attachQualityScorer(ctx.qualityScorer);
      ctx.selfEvolutionGovernor.attachConvergenceDetector(ctx.convergenceDetector);
      if (ctx.deepeningTaskScheduler) {
        ctx.selfEvolutionGovernor.attachScheduler(ctx.deepeningTaskScheduler);
      }
    }

    if (ctx.causalVectorIndex && ctx.causalMemoryStore) {
      if (typeof ctx.causalMemoryStore.attachVectorIndex === 'function') {
        ctx.causalMemoryStore.attachVectorIndex(ctx.causalVectorIndex);
      }
    }
  } catch (newModErr) {
    debug('Harness', 'newModulesInitError', newModErr);
    if (ctx.structuredLog) ctx.structuredLog.error('Evolution module initialization failed', { error: newModErr && newModErr.message ? newModErr.message : String(newModErr) });
  }
}

/**
 * 转发各独立模块的事件到全局事件总线，涵盖：
 * - 自演化治理器（proposal-generated、heartbeat-complete 等）；
 * - 技能补丁审批器（patch-submitted、patch-approved 等）；
 * - 信号持久化器（signal-recorded）；
 * - 目标执行器（goal-created、goal-completed 等）；
 * - 技能创建引擎（skill-created、skill-deleted）。
 * @param {Object} ctx - 运行时上下文，包含各模块实例和 eventBus
 * @private
 */
function _forwardModuleEvents(ctx) {
  if (ctx.selfEvolutionGovernor) {
    const govEventMap = {
      'proposal-generated': 'governor:proposal-generated',
      'heartbeat-complete': 'governor:heartbeat-complete',
      'heartbeat-error': 'governor:heartbeat-error',
      'governor-circuit-breaker': 'governor:circuit-breaker',
    };
    for (const entry of Object.entries(govEventMap)) {
      const handler = function(e) { safeCall(() => ctx.eventBus.emit(entry[1], e), 'Harness', 'forwardGovEvent'); };
      _registerListener(ctx.selfEvolutionGovernor, entry[0], handler);
    }
  }

  if (ctx.skillPatchApproval) {
    const spaEventMap = {
      'patch-submitted': 'patch:submitted',
      'patch-approved': 'patch:approved',
      'patch-rejected': 'patch:rejected',
      'patch-applied': 'patch:applied',
      'patch-revoked': 'patch:revoked',
    };
    for (const entry of Object.entries(spaEventMap)) {
      const handler = function(e) { safeCall(() => ctx.eventBus.emit(entry[1], e), 'Harness', 'forwardPatchEvent'); };
      _registerListener(ctx.skillPatchApproval, entry[0], handler);
    }
  }

  if (ctx.signalPersistence) {
    const handler = function(e) { safeCall(() => ctx.eventBus.emit('signal:recorded', e), 'Harness', 'forwardSignalEvent'); };
    _registerListener(ctx.signalPersistence, 'signal-recorded', handler);
  }

  if (ctx.goalExecutor) {
    const goalEventMap = {
      'goal-created': 'goal:created', 'goal-completed': 'goal:completed',
      'goal-failed': 'goal:failed', 'goal-paused': 'goal:paused',
      'goal-resumed': 'goal:resumed', 'goal-cancelled': 'goal:cancelled',
      'goal-decomposing': 'goal:decomposing', 'goal-decomposed': 'goal:decomposed',
      'goal-iteration-start': 'goal:iteration-start', 'goal-iteration-complete': 'goal:iteration-complete',
    };
    for (const entry of Object.entries(goalEventMap)) {
      const handler = function(e) { safeCall(() => ctx.eventBus.emit(entry[1], e), 'Harness', 'forwardEvent'); };
      _registerListener(ctx.goalExecutor, entry[0], handler);
    }
  }

  if (ctx.skillCreationEngine) {
    const h1 = function(e) { safeCall(() => ctx.eventBus.emit('skill:created', e), 'Harness', 'forwardSkillEvent'); };
    const h2 = function(e) { safeCall(() => ctx.eventBus.emit('skill:deleted', e), 'Harness', 'forwardSkillEvent'); };
    _registerListener(ctx.skillCreationEngine, 'skill-created', h1);
    _registerListener(ctx.skillCreationEngine, 'skill-deleted', h2);
  }
}

/**
 * 通过深化推理注册表懒加载子模块实例，并注册其事件到全局事件总线。
 * 遍历 LAZY_DEEPENING_EVENT_MAP，对每个条目尝试从注册表获取或加载模块实例，
 * 若实例支持 on 方法则注册事件转发。
 * @param {Object} registry - 深化推理模块注册表（需实现 getOrLoad 方法）
 * @param {Object} eventBus - 全局事件总线
 * @private
 */
function _wireLazyDeepeningEvents(registry, eventBus) {
  for (const entry of Object.entries(LAZY_DEEPENING_EVENT_MAP)) {
    const instance = registry.getOrLoad(entry[0]);
    if (instance && typeof instance.on === 'function') {
      const handler = function(e) { eventBus.emit(entry[1].emit, e); };
      instance.on(entry[1].event, handler);
      _registeredListeners.push({ emitter: instance, event: entry[1].event, handler: handler });
    }
  }
}

/**
 * 注册会话生命周期事件监听器，包括：
 * - session-created：转发为 session:created；
 * - phase-change：转发为 session:phase-change，并自动创建检查点；
 * - skill-complete：转发为 session:skill-complete，并获取技能改进建议；
 * - budget-warning：转发为 session:budget-warning；
 * - shutdown：转发为 session:shutdown，并持久化所有活跃会话的摘要到 SQLite 和内存存储；
 * - logger shutdown：转发为 audit:shutdown。
 * @param {Object} ctx - 运行时上下文，需包含 session、eventBus、checkpointManager 等实例
 * @private
 */
function _registerSessionEvents(ctx) {
  const h1 = function(e) { ctx.eventBus.emit('session:created', e); };
  _registerListener(ctx.session, 'session-created', h1);

  const h2 = function(e) {
    ctx.eventBus.emit('session:phase-change', e);
    try {
      const _sessData = ctx.session.get(e.sessionId) ?? {};
      ctx.checkpointManager.create(e.sessionId, {
        phase: e.to,
        completedSkills: Array.isArray(_sessData.completedSkills) ? _sessData.completedSkills : [],
        tokensUsed: Number.isFinite(_sessData.tokensUsed) ? _sessData.tokensUsed : 0,
      });
    } catch (ckptErr) { ctx.structuredLog.warn('Checkpoint creation failed', { error: ckptErr && ckptErr.message ? ckptErr.message : String(ckptErr) }); }
  };
  _registerListener(ctx.session, 'phase-change', h2);

  const h3 = function(e) {
    ctx.eventBus.emit('session:skill-complete', e);
    const tips = (ctx.skillImprovementLoop || ctx.skillImprover)
      ? (ctx.skillImprovementLoop || ctx.skillImprover).getTips(e.skillId)
      : [];
    if (tips.length > 0) {
      ctx.structuredLog.info('Skill improvement tips available', { skillId: e.skillId, tipCount: tips.length });
    }
  };
  _registerListener(ctx.session, 'skill-complete', h3);

  const h4 = function(e) { ctx.eventBus.emit('session:budget-warning', e); };
  _registerListener(ctx.session, 'budget-warning', h4);

  const h5 = function(e) {
    ctx.eventBus.emit('session:shutdown', e);
    for (const pair of Object.entries(ctx.session.sessions)) {
      if (pair[1]?.status === SESSION_STATUS_ACTIVE) {
        const summary = {
          phase: pair[1].currentPhase,
          completedSkills: Array.isArray(pair[1].completedSkills) ? pair[1].completedSkills : [],
          tokensUsed: Number.isFinite(pair[1].tokensUsed) ? pair[1].tokensUsed : 0,
        };
        if (ctx.sqliteStore) {
          const sqliteResult = safeExecute(() => ctx.sqliteStore.saveSessionSummary(pair[1].id, summary), 'EventRegistrar', 'sqliteSave', false);
          if (sqliteResult === false) debug('EventRegistrar', 'sqliteSave', 'saveSessionSummary returned false for ' + pair[1].id);
        }
        const memResult = safeExecute(() => ctx.memoryStore.saveSessionSummary(pair[1].id, summary), 'EventRegistrar', 'memorySave', false);
        if (memResult === false) debug('EventRegistrar', 'memorySave', 'saveSessionSummary returned false for ' + pair[1].id);
      }
    }
  };
  _registerListener(ctx.session, 'shutdown', h5);

  const h6 = function(e) { ctx.eventBus.emit('audit:shutdown', e); };
  _registerListener(ctx.logger, 'shutdown', h6);
}

/**
 * 注册审计中间件到事件总线。中间件检查每个事件名是否以 AUDIT_PREFIXES 中的前缀开头，
 * 匹配则自动记录审计日志，包含 agent、action、target、result 等字段。
 * @param {Object} ctx - 运行时上下文，需包含 eventBus 和 logger
 * @private
 */
function _registerAuditMiddleware(ctx) {
  ctx.eventBus.use(function auditMiddleware(event, data) {
    const shouldLog = AUDIT_PREFIXES.some(function(prefix) { return event.startsWith(prefix); });
    if (shouldLog) {
      ctx.logger.log({
        agent: (data && data.agentId) || (data && data.agent) || 'system',
        action: event,
        target: (data && data.target) || (data && data.skillId) || (data && data.sessionId) || '',
        result: (data && data.result) || 'emitted',
        details: '',
      });
    }
  });
}

/**
 * 注册结构化日志监听器，将关键事件转发到结构化日志系统：
 * - session:phase-change → info 级别记录阶段转换；
 * - session:budget-warning → warn 级别记录 Token 预算告警；
 * - agent:critical-alert → error 级别记录 Agent 严重告警。
 * @param {Object} ctx - 运行时上下文，需包含 eventBus 和 structuredLog
 * @private
 */
function _registerStructuredLogListeners(ctx) {
  const h1 = function(e) {
    ctx.structuredLog.info('Phase transition', { from: e.from, to: e.to, sessionId: e.sessionId });
  };
  _registerListener(ctx.eventBus, 'session:phase-change', h1);

  const h2 = function(e) {
    ctx.structuredLog.warn('Token budget warning', { sessionId: e.sessionId, ratio: e.budget && e.budget.ratio });
  };
  _registerListener(ctx.eventBus, 'session:budget-warning', h2);

  const h3 = function(e) {
    ctx.structuredLog.error('Agent critical alert', { agent: e.agentId, alert: e.alert });
  };
  _registerListener(ctx.eventBus, 'agent:critical-alert', h3);
}

/**
 * 监听子代理完成事件（subagent-completed），执行两项后续处理：
 * 1. 若亲和力学习器可用，根据执行结果计算质量评分并记录（出错时低分，快速完成时加分）；
 * 2. 若技能改进循环可用，将执行摘要记录为学习条目，区分成功与失败经验。
 * @param {Object} ctx - 运行时上下文，需包含 subagentExecutor，可选 affinityLearner 和 skillImprovementLoop
 * @private
 */
function _wireSubagentCompletionHandlers(ctx) {
  const handler = function(e) {
    if (ctx.affinityLearner && e.agentId) {
      const qualityScore = e.hadError ? ERROR_QUALITY_SCORE : Math.min(1, BASE_QUALITY_SCORE + (Number.isFinite(e.duration) && e.duration > 0 ? Math.min(DURATION_QUALITY_BONUS_CAP, DURATION_QUALITY_REF_MS / e.duration) : 0));
      ctx.affinityLearner.recordExecution(e.agentId, 'subagent-task', qualityScore, e.duration);
    }
    if (ctx.skillImprovementLoop && e.summary) {
      ctx.skillImprovementLoop.recordLearning({
        skillId: 'subagent-execution',
        phase: 'execution',
        approach: e.summary.substring(0, SUMMARY_MAX_LENGTH),
        whatWorked: e.hadError ? '' : e.summary.substring(0, SUMMARY_MAX_LENGTH),
        whatFailed: e.hadError ? e.summary.substring(0, SUMMARY_MAX_LENGTH) : '',
        tips: '',
        context: 'agent:' + (e.agentId || 'unknown'),
      });
    }
  };
  _registerListener(ctx.subagentExecutor, 'subagent-completed', handler);
}

/**
 * 注册链式对话（ChatChain）的直接事件转发，将 task-started、task-completed、
 * task-failed、task-skipped 四个事件转发为 chat-chain: 前缀的对应事件。
 * @param {Object} ctx - 运行时上下文，需包含 chatChain 和 eventBus
 * @private
 */
function _wireChatChainEvents(ctx) {
  const chatChainDirectEvents = ['task-started', 'task-completed', 'task-failed', 'task-skipped'];
  for (const evt of chatChainDirectEvents) {
    const emitName = 'chat-chain:' + evt;
    const handler = function(e) { ctx.eventBus.emit(emitName, e); };
    _registerListener(ctx.chatChain, evt, handler);
  }
}

/**
 * 安全关闭事件注册器——移除所有已注册的事件监听器并清空内部列表。
 * 遍历 _registeredListeners 中每条记录，调用 emitter.removeListener 移除对应监听器，
 * 每次移除通过 safeCall 包裹以防止异常中断后续清理。完成后清空列表。
 * 应在系统关闭时调用，确保不遗留悬空监听器导致内存泄漏。
 */
function shutdown() {
  for (const entry of _registeredListeners) {
    safeCall(() => entry.emitter.removeListener(entry.event, entry.handler), 'EventRegistrar', 'shutdown');
  }
  _registeredListeners = [];
}

module.exports = {
  EVENT_FORWARD_MAP,
  CONDITIONAL_EVENT_FORWARD_MAP,
  LAZY_DEEPENING_EVENT_MAP,
  AUDIT_PREFIXES,
  _forwardMappedEvents,
  _registerEventForwarding,
  _initCausalModules,
  _wireCausalAttachments,
  _wireCausalDistillation,
  _initEvolutionModules,
  _forwardModuleEvents,
  _wireLazyDeepeningEvents,
  _registerSessionEvents,
  _registerAuditMiddleware,
  _registerStructuredLogListeners,
  _wireSubagentCompletionHandlers,
  _wireChatChainEvents,
  shutdown,
};
