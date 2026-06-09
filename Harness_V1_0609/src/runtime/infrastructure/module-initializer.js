/**
 * @module runtime/infrastructure/module-initializer
 * @description 模块初始化器——负责按依赖顺序创建、装配和清理 Harness 运行时全部核心模块实例。
 * 提供同步（_initCoreModules）与异步（_initCoreModulesAsync）两条初始化路径，
 * 以及配套的同步/异步清理函数。初始化过程涵盖 Skill 路由、会话管理、权限执行、
 * TDD 门禁、Agent 运行时、深化推理、协作模式、思维子系统、存储层等二十余个子系统，
 * 并在关键节点进行启动耗时度量与失败回滚。
 */
'use strict';

const SkillRouter = require('../skill/skill-router');
const SessionManager = require('../session/session-manager');
const PhaseOrchestrator = require('../workflow/phase-orchestrator');
const EventBus = require('./event-bus');
const PluginManager = require('./plugin-manager');
const HealthChecker = require('./health-checker');
const MemoryStore = require('../thought/memory-store');
const AgentChannel = require('../agent/agent-channel');
const CheckpointManager = require('../session/checkpoint-manager');
const RetryEngine = require('./retry-engine');
const SkillImprover = require('../skill/skill-improver');
const ConcurrencyController = require('./concurrency-controller');
const AdversarialReview = require('../quality/adversarial-review');
const PlatformCoordinator = require('./platform-coordinator');
const WorkflowTemplate = require('../workflow/workflow-template');
const RBACEnforcer = require('../../permission/rbac-enforcer');
const PermissionGuard = require('../../permission/permission-guard');
const AuditLogger = require('../../permission/audit-logger');
const TDDGate = require('../../gate/tdd-gate');
const EvidenceVerifier = require('../../gate/evidence-verifier');
const FrameworkComplianceChecker = require('../../gate/framework-compliance-checker');
const DeviationApproval = require('../../gate/deviation-approval');
const CodeReviewFrameworkCheck = require('../../gate/code-review-framework-check');
const DesignSkillEngine = require('../../gate/design-skill-engine');
const StructuredLogger = require('../../utils/structured-logger');
const { setBridge: setDebugBridge, debug } = require('../../utils/debug-logger');
const { HarnessError } = require('../../errors');
const AgentRuntime = require('../agent/agent-runtime');
const AgentLifecycleController = require('../agent/agent-lifecycle-controller');
const AgentSandbox = require('../agent/agent-sandbox');
const AgentMonitor = require('../agent/agent-monitor');
const AgentDeployment = require('../agent/agent-deployment');
const AgentStateManager = require('../agent/agent-state-manager');
const AgentWorkflowIntegration = require('../agent/agent-workflow-integration');
const TokenManager = require('../model/token-manager');
const DeepeningModuleRegistry = require('../deepening/deepening-module-registry');
const { SkillReducer } = require('../skill/skill-reducer');
const GeneratorVerifier = require('../../gate/generator-verifier');
const IsolatedContextManager = require('../context/isolated-context-manager');
const PlanPersistence = require('../workflow/plan-persistence');
const CollaborationModeRouter = require('../collaboration/collaboration-mode-router');
const StructuredIntent = require('../user/structured-intent');
const SubagentExecutor = require('../agent/subagent-executor');
const PairChat = require('../collaboration/pair-chat');
const ChatChain = require('../collaboration/chat-chain');
const DevMetricsCollector = require('../collaboration/dev-metrics-collector');
const AutoVersionTracker = require('./auto-version-tracker');
const SqliteStore = require('./sqlite-store');
const ConversationContextStore = require('./conversation-context-store');
const ServiceFS = require('./service-fs');
const EvaluationCalibrator = require('../quality/evaluation-calibrator');
const HarnessMigrationEngine = require('../model/harness-migration-engine');
const TaskLifecycleOrchestrator = require('../workflow/task-lifecycle-orchestrator');
const SkillImprovementLoop = require('../skill/skill-improvement-loop');
const MemoryNudge = require('../thought/memory-nudge');
const SkillCreationEngine = require('../skill/skill-creation-engine');
const SkillCurator = require('../skill/skill-curator');
const UserModelManager = require('../user/user-model-manager');
const MCPClient = require('./mcp-client');
const CommandRouter = require('../workflow/command-router');
const ProgrammableHookExecutor = require('../workflow/programmable-hook-executor');
const ContextCompressionEngine = require('../context/context-compression-engine');
const AgentPackManager = require('../agent/agent-pack-manager');
const ThoughtExtractor = require('../thought/thought-extractor');
const ThoughtDeduplicator = require('../thought/thought-deduplicator');
const ThoughtMemoryStore = require('../thought/thought-memory-store');
const ThoughtRetrieverCycle = require('../thought/thought-retriever-cycle');
const EmbeddingService = require('../model/embedding-service');
const ModelSelector = require('../model/model-selector');
const RAGPipeline = require('../workflow/rag-pipeline');
const SelfReflection = require('../quality/self-reflection');
const AiCodeTrustScorer = require('../quality/ai-code-trust-scorer');
const ComprehensionDebtTracker = require('../quality/comprehension-debt-tracker');
const DeliveryEfficiencyMeter = require('../quality/delivery-efficiency-meter');
const LTIContextInjector = require('../context/lti-context-injector');
const ChangelogArchive = require('../../web/changelog-archive');
const PriorityQueue = require('./priority-queue');
const OptimizationLoop = require('../workflow/optimization-loop');
const MetaSkillOrchestrator = require('../skill/meta-skill-orchestrator');
const MetaSkillGenerator = require('../skill/meta-skill-generator');
const CostAwareRouter = require('../model/cost-aware-router');
const { MoeGatingRouter } = require('../collaboration/moe-gating-router');
const { DynamicHarnessGenerator } = require('../workflow/dynamic-harness-generator');
const ContextMapper = require('../../domain/context-mapper');
const { DEFAULT_MIN_HEARTBEAT_MS } = require('../../utils/constants');

const MODULE_INIT_TIMEOUT_MS = 30 * 1000;

/**
 * 自动版本追踪器的默认刷盘间隔（毫秒），继承自全局常量 DEFAULT_MIN_HEARTBEAT_MS。
 * @constant {number}
 */
const DEFAULT_FLUSH_INTERVAL_MS = DEFAULT_MIN_HEARTBEAT_MS;

/**
 * 自动版本追踪器的默认缓冲区最大容量，超过此阈值将触发刷盘。
 * @constant {number}
 */
const DEFAULT_MAX_BUFFER_SIZE = 10;

/**
 * 简单模块注册表——列出无需复杂依赖即可实例化的模块。
 * 每个条目包含：
 * - key {string} 实例在返回对象中的属性名
 * - Class {Function} 模块构造函数
 * - args {Array<string|*>} [可选] 构造参数规格，'projectRoot' 会被替换为实际路径
 * - postInit {string} [可选] 实例化后需调用的初始化方法名
 * @constant {Array<{key: string, Class: Function, args?: Array, postInit?: string}>}
 */
const SIMPLE_MODULES = [
  { key: 'orchestrator', Class: PhaseOrchestrator },
  { key: 'guard', Class: PermissionGuard, args: ['projectRoot'] },
  { key: 'logger', Class: AuditLogger, args: ['projectRoot', {}] },
  { key: 'tddGate', Class: TDDGate },
  { key: 'verifier', Class: EvidenceVerifier },
  { key: 'eventBus', Class: EventBus },
  { key: 'healthChecker', Class: HealthChecker },
  { key: 'structuredLog', Class: StructuredLogger, args: [{ level: 'info', module: 'harness' }] },
  { key: 'checkpointManager', Class: CheckpointManager, args: ['projectRoot'] },
  { key: 'retryEngine', Class: RetryEngine },
  { key: 'skillImprover', Class: SkillImprover, args: ['projectRoot'] },
  { key: 'concurrencyController', Class: ConcurrencyController },
  { key: 'adversarialReview', Class: AdversarialReview },
  { key: 'platformCoordinator', Class: PlatformCoordinator },
  { key: 'workflowTemplate', Class: WorkflowTemplate, args: ['projectRoot'] },
  { key: 'complianceChecker', Class: FrameworkComplianceChecker, args: ['projectRoot'] },
  { key: 'deviationApproval', Class: DeviationApproval, args: ['projectRoot'] },
  { key: 'codeReviewCheck', Class: CodeReviewFrameworkCheck, args: ['projectRoot'] },
  { key: 'designSkillEngine', Class: DesignSkillEngine, args: ['projectRoot'] },
  { key: 'tokenManager', Class: TokenManager },
  { key: 'skillReducer', Class: SkillReducer, args: ['projectRoot'] },
  { key: 'generatorVerifier', Class: GeneratorVerifier },
  { key: 'isolatedContextManager', Class: IsolatedContextManager },
  { key: 'planPersistence', Class: PlanPersistence, args: ['projectRoot'] },
  { key: 'agentPackManager', Class: AgentPackManager, args: ['projectRoot'], postInit: 'discover' },
  { key: 'archive', Class: ChangelogArchive, args: ['projectRoot'] },
  { key: 'selfReflection', Class: SelfReflection },
  { key: 'aiCodeTrustScorer', Class: AiCodeTrustScorer },
  { key: 'comprehensionDebtTracker', Class: ComprehensionDebtTracker },
  { key: 'deliveryEfficiencyMeter', Class: DeliveryEfficiencyMeter },
  { key: 'ltiInjector', Class: LTIContextInjector },
  { key: 'priorityQueue', Class: PriorityQueue },
  { key: 'optimizationLoop', Class: OptimizationLoop },
  { key: 'metaSkillOrchestrator', Class: MetaSkillOrchestrator },
  { key: 'metaSkillGenerator', Class: MetaSkillGenerator },
  { key: 'costAwareRouter', Class: CostAwareRouter },
  { key: 'devMetricsCollector', Class: DevMetricsCollector },
  { key: 'dynamicHarnessGenerator', Class: DynamicHarnessGenerator },
];

/**
 * 解析构造参数规格，将 'projectRoot' 占位符替换为上下文中的实际项目根路径。
 * @param {Array<string|*>} argSpec - 参数规格数组，其中字符串 'projectRoot' 会被替换
 * @param {{ projectRoot: string }} ctx - 包含项目根路径的上下文对象
 * @returns {Array<*>} 解析后的实际参数数组
 */
function _resolveArgs(argSpec, ctx) {
  return argSpec.map(a => (typeof a === 'string' && a === 'projectRoot') ? ctx.projectRoot : a);
}

function _getConfig(config, key, fallback) {
  return (config && config[key]) ?? fallback;
}

function _createModule(name, factory, created, startupTimings) {
  const inst = _measure(startupTimings, name, factory);
  created.push(inst);
  return inst;
}

/**
 * 将对象中所有非空值推入指定数组，用于批量收集已创建的模块实例。
 * @param {Array} arr - 目标数组，用于收集模块实例
 * @param {Object|null|undefined} obj - 包含模块实例的对象，其所有值为对象的属性会被推入数组
 */
function _pushModules(arr, obj) {
  if (!obj) return;
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && val !== null) arr.push(val);
  }
}

function _measure(startupTimings, name, fn) {
  const t0 = Date.now();
  const result = fn();
  startupTimings.push({ module: name, ms: Date.now() - t0 });
  return result;
}

async function _measureAsync(startupTimings, name, fn) {
  const t0 = Date.now();
  const result = await fn();
  startupTimings.push({ module: name, ms: Date.now() - t0 });
  return result;
}

function _initCriticalModule(name, factory, startupTimings, created, cleanupOnFail) {
  try {
    const result = _measure(startupTimings, name, factory);
    return result;
  } catch (err) {
    if (cleanupOnFail) _cleanup(created);
    const harnessErr = new HarnessError('INIT_FAILED', name + ' initialization failed: ' + (err && err.message ? err.message : String(err)), { cause: err });
    throw harnessErr;
  }
}

async function _initCriticalModuleAsync(name, factory, startupTimings, created, cleanupOnFail) {
  try {
    const result = await _measureAsync(startupTimings, name, factory);
    return result;
  } catch (err) {
    if (cleanupOnFail) { try { await _cleanupAsync(created); } catch (cleanupErr) { debug('Harness', '_cleanupAsync' + name, cleanupErr); } }
    const harnessErr = new HarnessError('INIT_FAILED', name + ' initialization failed: ' + (err && err.message ? err.message : String(err)), { cause: err });
    throw harnessErr;
  }
}

function _attachDeepeningOrchestrator(deepeningModules, instances, collabModules, thoughtModules) {
  if (deepeningModules.deepeningOrchestrator) {
    deepeningModules.deepeningOrchestrator
      .attachMetricsCollector(deepeningModules.deepeningMetricsCollector)
      .attachCache(deepeningModules.deepeningCache)
      .attachStrategyPlugin(deepeningModules.deepeningStrategyPlugin)
      .attachReportGenerator(deepeningModules.deepeningReportGenerator)
      .attachConvergenceDetector(deepeningModules.convergenceDetector)
      .attachQualityScorer(deepeningModules.qualityScorer)
      .attachEventStore(deepeningModules.deepeningEventStore)
      .attachOodaLoop(deepeningModules.oodaLoop)
      .attachGeneratorVerifier(instances.generatorVerifier)
      .attachSubagentExecutor(collabModules.subagentExecutor)
      .attachThoughtRetrieverCycle(thoughtModules.thoughtRetrieverCycle);
  }
}

function _initCriticalModulesSync(projectRoot, created, startupTimings) {
  let router;
  try {
    router = _measure(startupTimings, 'SkillRouter', function() {
      const r = new SkillRouter(projectRoot);
      r.discover();
      r.watchForChanges();
      created.push(r);
      return r;
    });
  } catch (err) {
    const harnessErr = new HarnessError('INIT_FAILED', 'SkillRouter initialization failed: ' + (err && err.message ? err.message : String(err)), { cause: err });
    throw harnessErr;
  }

  let session;
  try {
    session = _measure(startupTimings, 'SessionManager', function() {
      const s = new SessionManager(projectRoot);
      created.push(s);
      return s;
    });
  } catch (err) {
    _cleanup(created);
    const harnessErr = new HarnessError('INIT_FAILED', 'SessionManager initialization failed: ' + (err && err.message ? err.message : String(err)), { cause: err });
    throw harnessErr;
  }

  let enforcer;
  try {
    enforcer = _measure(startupTimings, 'RBACEnforcer', function() {
      const e = new RBACEnforcer(projectRoot);
      e.load();
      created.push(e);
      return e;
    });
  } catch (err) {
    _cleanup(created);
    const harnessErr = new HarnessError('INIT_FAILED', 'RBACEnforcer initialization failed: ' + (err && err.message ? err.message : String(err)), { cause: err });
    throw harnessErr;
  }

  return { router, session, enforcer };
}

async function _initCriticalModulesAsync(projectRoot, created, startupTimings) {
  let router;
  try {
    router = await _measureAsync(startupTimings, 'SkillRouter', async function() {
      const r = new SkillRouter(projectRoot);
      await r.discoverAsync();
      r.watchForChanges();
      created.push(r);
      return r;
    });
  } catch (err) {
    const harnessErr = new HarnessError('INIT_FAILED', 'SkillRouter initialization failed: ' + (err && err.message ? err.message : String(err)), { cause: err });
    throw harnessErr;
  }

  let session;
  try {
    session = _measure(startupTimings, 'SessionManager', function() {
      const s = new SessionManager(projectRoot);
      created.push(s);
      return s;
    });
  } catch (err) {
    try { await _cleanupAsync(created); } catch (cleanupErr) { debug('Harness', '_cleanupAsyncSession', cleanupErr); }
    const harnessErr = new HarnessError('INIT_FAILED', 'SessionManager initialization failed: ' + (err && err.message ? err.message : String(err)), { cause: err });
    throw harnessErr;
  }

  let enforcer;
  try {
    enforcer = await _measureAsync(startupTimings, 'RBACEnforcer', async function() {
      const e = new RBACEnforcer(projectRoot);
      await e.loadAsync();
      created.push(e);
      return e;
    });
  } catch (err) {
    try { await _cleanupAsync(created); } catch (cleanupErr) { debug('Harness', '_cleanupAsyncEnforcer', cleanupErr); }
    const harnessErr = new HarnessError('INIT_FAILED', 'RBACEnforcer initialization failed: ' + (err && err.message ? err.message : String(err)), { cause: err });
    throw harnessErr;
  }

  return { router, session, enforcer };
}

/**
 * 初始化后核心模块（同步），包括CommandRouter、ProgrammableHookExecutor和ContextCompressionEngine
 * @param {string} projectRoot - 项目根目录的绝对路径
 * @param {Object} validation - 配置验证结果对象，包含config属性
 * @param {Array} created - 已创建实例的收集数组
 * @param {Array<{module: string, ms: number}>} startupTimings - 启动耗时记录数组
 * @returns {{ commandRouter: CommandRouter, programmableHookExecutor: ProgrammableHookExecutor, contextCompressionEngine: ContextCompressionEngine }}
 */
function _initPostCoreModules(projectRoot, validation, created, startupTimings) {
  const commandRouter = _createModule('CommandRouter', function() {
    const cr = new CommandRouter(projectRoot);
    cr.discover();
    return cr;
  }, created, startupTimings);
  const programmableHookExecutor = _createModule('ProgrammableHookExecutor', function() {
    const pe = new ProgrammableHookExecutor(projectRoot);
    pe.loadFromConfig(validation.config);
    return pe;
  }, created, startupTimings);
  const contextCompressionEngine = _createModule('ContextCompressionEngine', function() {
    return new ContextCompressionEngine(_getConfig(validation.config, 'context_compression', {}));
  }, created, startupTimings);
  return { commandRouter, programmableHookExecutor, contextCompressionEngine };
}

async function _initPostCoreModulesAsync(projectRoot, validation, created, startupTimings) {
  const commandRouter = _createModule('CommandRouter', function() { return new CommandRouter(projectRoot); }, created, startupTimings);
  try {
    await commandRouter.discoverAsync();
  } catch (discoverErr) {
    debug('Harness', 'commandRouterDiscoverAsync', discoverErr);
    commandRouter._partialInit = true;
  }
  const programmableHookExecutor = _createModule('ProgrammableHookExecutor', function() {
    const pe = new ProgrammableHookExecutor(projectRoot);
    pe.loadFromConfig(validation.config);
    return pe;
  }, created, startupTimings);
  const contextCompressionEngine = _createModule('ContextCompressionEngine', function() {
    return new ContextCompressionEngine(_getConfig(validation.config, 'context_compression', {}));
  }, created, startupTimings);
  return { commandRouter, programmableHookExecutor, contextCompressionEngine };
}

function _initSubsystems(projectRoot, validation, router, eventBus, instances, created, startupTimings) {
  const thoughtModules = _initThoughtModules(projectRoot, validation);
  _pushModules(created, thoughtModules);
  instances.agentPackManager.discover();
  const storeModules = _initStoreModules(projectRoot, validation, router, eventBus);
  _pushModules(created, storeModules);
  const agentModules = _initAgentModules(projectRoot);
  _pushModules(created, agentModules);
  const deepeningRegistry = new DeepeningModuleRegistry(_getConfig(validation.config, 'deepening_config', {}));
  deepeningRegistry.loadCore();
  const deepeningModules = _extractDeepeningModules(deepeningRegistry);
  _pushModules(created, deepeningModules);
  instances.skillReducer.discover();
  router.attachSkillReducer(instances.skillReducer);
  const collabModules = _initCollaborationModules();
  _pushModules(created, collabModules);
  const ragPipeline = _createModule('RAGPipeline', function() {
    return new RAGPipeline(projectRoot, _getConfig(validation.config, 'rag', {}));
  }, created, startupTimings);
  return { thoughtModules, storeModules, agentModules, deepeningRegistry, deepeningModules, collabModules, ragPipeline };
}

/**
 * 初始化子系统（异步），与_initSubsystems功能等价，但Agent模块和发现操作使用异步API
 * @param {string} projectRoot - 项目根目录的绝对路径
 * @param {Object} validation - 配置验证结果对象
 * @param {SkillRouter} router - 已初始化的Skill路由器实例
 * @param {EventBus} eventBus - 已初始化的事件总线实例
 * @param {Object} instances - 已创建的核心模块实例映射
 * @param {Array} created - 已创建实例的收集数组
 * @param {Array<{module: string, ms: number}>} startupTimings - 启动耗时记录数组
 * @returns {Promise<{ thoughtModules: Object, storeModules: Object, agentModules: Object, deepeningRegistry: DeepeningModuleRegistry, deepeningModules: Object, collabModules: Object, ragPipeline: RAGPipeline }>}
 */
async function _initSubsystemsAsync(projectRoot, validation, router, eventBus, instances, created, startupTimings) {
  const thoughtModules = _initThoughtModules(projectRoot, validation);
  _pushModules(created, thoughtModules);
  try {
    await instances.agentPackManager.discoverAsync();
  } catch (discoverErr) {
    debug('Harness', 'agentPackManagerDiscoverAsync', discoverErr);
    instances.agentPackManager._partialInit = true;
  }
  const storeModules = _initStoreModules(projectRoot, validation, router, eventBus);
  _pushModules(created, storeModules);
  const agentModules = await _initAgentModulesAsync(projectRoot);
  _pushModules(created, agentModules);
  const deepeningRegistry = new DeepeningModuleRegistry(_getConfig(validation.config, 'deepening_config', {}));
  deepeningRegistry.loadCore();
  const deepeningModules = _extractDeepeningModules(deepeningRegistry);
  _pushModules(created, deepeningModules);
  try {
    await instances.skillReducer.discoverAsync();
  } catch (discoverErr) {
    debug('Harness', 'skillReducerDiscoverAsync', discoverErr);
    instances.skillReducer._partialInit = true;
  }
  router.attachSkillReducer(instances.skillReducer);
  const collabModules = _initCollaborationModules();
  _pushModules(created, collabModules);
  const ragPipeline = _createModule('RAGPipeline', function() {
    return new RAGPipeline(projectRoot, _getConfig(validation.config, 'rag', {}));
  }, created, startupTimings);
  return { thoughtModules, storeModules, agentModules, deepeningRegistry, deepeningModules, collabModules, ragPipeline };
}

function _wireDependencies(instances, thoughtModules, storeModules, deepeningModules, collabModules, projectRoot, eventBus, created) {
  _attachDeepeningOrchestrator(deepeningModules, instances, collabModules, thoughtModules);

  // PhaseOrchestrator strategic-level OODA integration
  if (instances.orchestrator && deepeningModules.oodaLoop) {
    instances.orchestrator.attachOodaLoop(deepeningModules.oodaLoop);
  }

  const autoVersionTracker = new AutoVersionTracker({
    archive: instances.archive,
    eventBus: eventBus,
    projectRoot: projectRoot,
    config: { enabled: true, flushInterval: DEFAULT_FLUSH_INTERVAL_MS, maxBufferSize: DEFAULT_MAX_BUFFER_SIZE },
  });
  created.push(autoVersionTracker);

  if (storeModules.sqliteStore && deepeningModules.affinityLearner) {
    deepeningModules.affinityLearner.attachSqliteStore(storeModules.sqliteStore);
  }

  return { autoVersionTracker };
}

/**
 * 同步初始化全部核心模块。按依赖顺序创建 SkillRouter、SessionManager、RBACEnforcer
 * 等关键模块，随后依次初始化简单模块、命令路由、钩子执行器、上下文压缩引擎、
 * 思维子系统、存储子系统、Agent 子系统、深化推理子系统、协作子系统及 RAG 管道，
 * 并在深化编排器上装配各子模块。关键模块初始化失败时自动回滚已创建实例。
 *
 * @param {string} projectRoot - 项目根目录的绝对路径
 * @param {Object} validation - 配置验证结果对象，包含 config 属性
 * @param {Array} created - 已创建实例的收集数组，用于失败时回滚清理
 * @returns {{ projectRoot: string, validation: Object, created: Array, startupTimings: Array<{module: string, ms: number}>, router: SkillRouter, session: SessionManager, orchestrator: PhaseOrchestrator, enforcer: RBACEnforcer, guard: PermissionGuard, logger: AuditLogger, tddGate: TDDGate, verifier: EvidenceVerifier, eventBus: EventBus, pluginManager: PluginManager, healthChecker: HealthChecker, structuredLog: StructuredLogger, memoryStore: MemoryStore, agentChannel: AgentChannel, checkpointManager: CheckpointManager, retryEngine: RetryEngine, skillImprover: SkillImprover, concurrencyController: ConcurrencyController, adversarialReview: AdversarialReview, platformCoordinator: PlatformCoordinator, workflowTemplate: WorkflowTemplate, complianceChecker: FrameworkComplianceChecker, deviationApproval: DeviationApproval, codeReviewCheck: CodeReviewFrameworkCheck, designSkillEngine: DesignSkillEngine, selfReflection: SelfReflection, ltiInjector: LTIContextInjector, commandRouter: CommandRouter, programmableHookExecutor: ProgrammableHookExecutor, contextCompressionEngine: ContextCompressionEngine, agentPackManager: AgentPackManager, tokenManager: TokenManager, deepeningRegistry: DeepeningModuleRegistry, skillReducer: SkillReducer, generatorVerifier: GeneratorVerifier, isolatedContextManager: IsolatedContextManager, planPersistence: PlanPersistence, archive: ChangelogArchive, autoVersionTracker: AutoVersionTracker, ragPipeline: RAGPipeline, [key: string]: * }} 包含全部已初始化模块实例的对象
 * @throws {HarnessError} 当 SkillRouter、SessionManager 或 RBACEnforcer 初始化失败时抛出 INIT_FAILED 错误
 */
function _initCoreModules(projectRoot, validation, created) {
  const startupTimings = [];
  const ctx = { projectRoot, validation, created };

  const critical = _initCriticalModulesSync(projectRoot, created, startupTimings);

  const eventBus = new EventBus();
  const pluginManager = new PluginManager(eventBus);
  ctx.eventBus = eventBus;

  const structuredLog = new StructuredLogger({ level: 'info', module: 'harness' });
  setDebugBridge(structuredLog);

  const memoryStore = _measure(startupTimings, 'MemoryStore', function() { return new MemoryStore(projectRoot); });
  const agentChannel = _measure(startupTimings, 'AgentChannel', function() { return new AgentChannel(); });

  const instances = { router: critical.router, session: critical.session, enforcer: critical.enforcer, eventBus, pluginManager, structuredLog, memoryStore, agentChannel };

  for (const mod of SIMPLE_MODULES) {
    if (instances[mod.key]) continue;
    const args = mod.args ? _resolveArgs(mod.args, ctx) : [];
    const inst = new mod.Class(...args);
    instances[mod.key] = inst;
    created.push(inst);
    if (mod.postInit && typeof inst[mod.postInit] === 'function') {
      inst[mod.postInit]();
    }
  }

  const contextMapper = new ContextMapper();
  if (validation.config && validation.config.bounded_contexts) {
    contextMapper.importFromConfig(validation.config.bounded_contexts);
  }
  instances.contextMapper = contextMapper;
  created.push(contextMapper);

  const moeGatingRouter = new MoeGatingRouter(validation.config && validation.config.moe_config || {});
  instances.moeGatingRouter = moeGatingRouter;
  created.push(moeGatingRouter);

  created.push(
    instances.eventBus, instances.pluginManager, instances.structuredLog,
    instances.memoryStore, instances.agentChannel,
  );

  const postCore = _initPostCoreModules(projectRoot, validation, created, startupTimings);

  const subsys = _initSubsystems(projectRoot, validation, critical.router, eventBus, instances, created, startupTimings);

  const wired = _wireDependencies(instances, subsys.thoughtModules, subsys.storeModules, subsys.deepeningModules, subsys.collabModules, projectRoot, eventBus, created);

  return {
    projectRoot, validation, created,
    startupTimings,
    router: critical.router, session: critical.session, orchestrator: instances.orchestrator, enforcer: critical.enforcer, guard: instances.guard,
    logger: instances.logger, tddGate: instances.tddGate, verifier: instances.verifier,
    eventBus, pluginManager: instances.pluginManager, healthChecker: instances.healthChecker, structuredLog,
    memoryStore, agentChannel, checkpointManager: instances.checkpointManager, retryEngine: instances.retryEngine,
    skillImprover: instances.skillImprover, concurrencyController: instances.concurrencyController,
    adversarialReview: instances.adversarialReview, platformCoordinator: instances.platformCoordinator,
    workflowTemplate: instances.workflowTemplate, complianceChecker: instances.complianceChecker,
    deviationApproval: instances.deviationApproval, codeReviewCheck: instances.codeReviewCheck,
    designSkillEngine: instances.designSkillEngine,
    optimizationLoop: instances.optimizationLoop,
    selfReflection: instances.selfReflection,
    ltiInjector: instances.ltiInjector,
    devMetricsCollector: instances.devMetricsCollector,
    commandRouter: postCore.commandRouter, programmableHookExecutor: postCore.programmableHookExecutor, contextCompressionEngine: postCore.contextCompressionEngine,
    agentPackManager: instances.agentPackManager,
    ...subsys.thoughtModules,
    tokenManager: instances.tokenManager, deepeningRegistry: subsys.deepeningRegistry, skillReducer: instances.skillReducer,
    generatorVerifier: instances.generatorVerifier,
    isolatedContextManager: instances.isolatedContextManager, planPersistence: instances.planPersistence,
    archive: instances.archive, autoVersionTracker: wired.autoVersionTracker,
    ...subsys.storeModules, ...subsys.agentModules, ...subsys.deepeningModules, ...subsys.collabModules,
    ragPipeline: subsys.ragPipeline,
    contextMapper: instances.contextMapper,
    moeGatingRouter: instances.moeGatingRouter,
  };
}

function _safeShutdown(instance, methodName, label) {
  if (instance && typeof instance[methodName] === 'function') {
    try { instance[methodName](); } catch (e) { debug('Harness', 'cleanup-' + label, e); }
  }
}

function _cleanupStoreModules(modules) {
  _safeShutdown(modules.serviceFS, 'shutdown', 'serviceFS');
  _safeShutdown(modules.mcpClient, 'shutdown', 'mcpClient');
  _safeShutdown(modules.userModelManager, 'shutdown', 'userModelManager');
  _safeShutdown(modules.skillCurator, 'shutdown', 'skillCurator');
  _safeShutdown(modules.skillCreationEngine, 'shutdown', 'skillCreationEngine');
  _safeShutdown(modules.skillImprovementLoop, 'shutdown', 'skillImprovementLoop');
  _safeShutdown(modules.memoryNudge, 'stopListening', 'memoryNudge');
  _safeShutdown(modules.sqliteStore, 'shutdown', 'sqliteStore');
}

/**
 * 初始化存储相关模块，包括 SqliteStore、SkillImprovementLoop、MemoryNudge、
 * SkillCreationEngine、SkillCurator、UserModelManager 和 MCPClient。
 * 若存储层初始化失败，所有已创建的存储模块实例将被安全清理并置为 null，
 * 以确保系统可在无持久化存储的情况下降级运行。
 *
 * @param {string} projectRoot - 项目根目录的绝对路径
 * @param {Object} validation - 配置验证结果对象，包含 config.mcp_servers 等配置
 * @param {SkillRouter} router - 已初始化的 Skill 路由器实例
 * @param {EventBus} eventBus - 已初始化的事件总线实例
 * @returns {{ sqliteStore: SqliteStore|null, skillImprovementLoop: SkillImprovementLoop|null, memoryNudge: MemoryNudge|null, skillCreationEngine: SkillCreationEngine|null, skillCurator: SkillCurator|null, userModelManager: UserModelManager|null, mcpClient: MCPClient|null }} 存储模块实例对象，失败时各字段为 null
 */
function _initStoreModules(projectRoot, validation, router, eventBus) {
  let sqliteStore = null;
  let skillImprovementLoop = null;
  let memoryNudge = null;
  let skillCreationEngine = null;
  let skillCurator = null;
  let userModelManager = null;
  let mcpClient = null;
  let conversationContextStore = null;
  let serviceFS = null;
  let evaluationCalibrator = null;
  let harnessMigrationEngine = null;
  let taskLifecycleOrchestrator = null;
  try {
    sqliteStore = new SqliteStore(projectRoot);
    sqliteStore.init();
    skillImprovementLoop = new SkillImprovementLoop({ sqliteStore, skillRouter: router, projectRoot });
    memoryNudge = new MemoryNudge({ sqliteStore, eventBus });
    memoryNudge.startListening();
    skillCreationEngine = new SkillCreationEngine({ projectRoot, skillRouter: router, sqliteStore });
    skillCurator = new SkillCurator({ projectRoot, skillRouter: router, sqliteStore });
    userModelManager = new UserModelManager({ sqliteStore, eventBus });
    mcpClient = new MCPClient({ servers: (validation.config && validation.config.mcp_servers) ?? {} });
    try {
      conversationContextStore = new ConversationContextStore({ sqliteStore });
    } catch (convErr) {
      debug('Harness', 'conversation-context-store-init', convErr);
    }
    try {
      serviceFS = new ServiceFS();
    } catch (fsErr) {
      debug('Harness', 'service-fs-init', fsErr);
    }
    try {
      evaluationCalibrator = new EvaluationCalibrator();
    } catch (calErr) {
      debug('Harness', 'evaluation-calibrator-init', calErr);
    }
    try {
      harnessMigrationEngine = new HarnessMigrationEngine();
    } catch (migErr) {
      debug('Harness', 'harness-migration-engine-init', migErr);
    }
    try {
      taskLifecycleOrchestrator = new TaskLifecycleOrchestrator();
    } catch (tloErr) {
      debug('Harness', 'task-lifecycle-orchestrator-init', tloErr);
    }
  } catch (storeErr) {
    debug('Harness', 'store-init', storeErr);
    _cleanupStoreModules({ mcpClient, userModelManager, skillCurator, skillCreationEngine, skillImprovementLoop, memoryNudge, sqliteStore });
    sqliteStore = null;
    skillImprovementLoop = null;
    memoryNudge = null;
    skillCreationEngine = null;
    skillCurator = null;
    userModelManager = null;
    mcpClient = null;
    conversationContextStore = null;
    serviceFS = null;
    evaluationCalibrator = null;
    harnessMigrationEngine = null;
    taskLifecycleOrchestrator = null;
  }
  return { sqliteStore, skillImprovementLoop, memoryNudge, skillCreationEngine, skillCurator, userModelManager, mcpClient, conversationContextStore, serviceFS, evaluationCalibrator, harnessMigrationEngine, taskLifecycleOrchestrator };
}

/**
 * 同步初始化 Agent 子系统模块，包括 AgentRuntime、AgentSandbox、AgentStateManager、
 * AgentMonitor、AgentDeployment、AgentWorkflowIntegration 和 AgentLifecycleController。
 * Agent 生命周期控制器将运行时、状态管理器和沙箱三者绑定。
 *
 * @param {string} projectRoot - 项目根目录的绝对路径
 * @returns {{ agentRuntime: AgentRuntime, agentSandbox: AgentSandbox, agentStateManager: AgentStateManager, agentMonitor: AgentMonitor, agentDeployment: AgentDeployment, agentWorkflowIntegration: AgentWorkflowIntegration, agentLifecycle: AgentLifecycleController }} Agent 子系统模块实例对象
 * @throws {HarnessError} 当 Agent 子系统初始化失败时抛出 INIT_FAILED 错误
 */
function _initAgentModules(projectRoot) {
  let agentRuntime, agentSandbox, agentStateManager, agentMonitor, agentDeployment, agentWorkflowIntegration, agentLifecycle;
  try {
    agentRuntime = new AgentRuntime(projectRoot);
    agentSandbox = new AgentSandbox(projectRoot);
    agentStateManager = new AgentStateManager(projectRoot);
    agentMonitor = new AgentMonitor(projectRoot);
    agentDeployment = new AgentDeployment(projectRoot);
    agentWorkflowIntegration = new AgentWorkflowIntegration(projectRoot);
    agentLifecycle = new AgentLifecycleController(agentRuntime, agentStateManager, agentSandbox);
  } catch (agentErr) {
    debug('Harness', 'agent-init', agentErr);
    const harnessErr = new HarnessError('INIT_FAILED', 'Agent system initialization failed: ' + (agentErr && agentErr.message ? agentErr.message : String(agentErr)), { cause: agentErr });
    throw harnessErr;
  }
  return { agentRuntime, agentSandbox, agentStateManager, agentMonitor, agentDeployment, agentWorkflowIntegration, agentLifecycle };
}

/**
 * 从深化推理模块注册表中提取指定名称的模块实例，并将 kebab-case 名称
 * 转换为 camelCase 作为返回对象的属性键。支持通过 aliases 映射为特定名称
 * 提供别名引用。
 *
 * @param {DeepeningModuleRegistry} registry - 已加载核心模块的深化推理注册表
 * @returns {Object<string, *>} 以 camelCase 属性键映射的深化推理模块实例对象
 */
function _extractDeepeningModules(registry) {
  const names = [
    'recurrent-deepening-scheduler', 'adaptive-depth-controller', 'multi-agent-router',
    'output-fusion', 'iterative-refinement', 'progressive-deepening', 'deepening-orchestrator',
    'quality-scorer', 'ai-code-trust-scorer', 'comprehension-debt-tracker', 'delivery-efficiency-meter', 'token-aware-deepening', 'affinity-learner', 'convergence-detector',
    'deepening-metrics-collector', 'deepening-cache', 'deepening-strategy-plugin',
    'deepening-report-generator', 'deepening-pipeline', 'deepening-health-monitor', 'deepening-event-store',
    'deepening-workflow-template', 'deepening-benchmark', 'lti-context-injector', 'ooda-loop',
  ];
  const aliases = {
    'recurrent-deepening-scheduler': 'recurrentDeepening',
    'adaptive-depth-controller': 'adaptiveDepth',
    'lti-context-injector': 'ltiInjector',
  };
  const result = {};
  for (const name of names) {
    const key = name.replace(/-([a-z])/g, function(_, c) { return c.toUpperCase(); });
    const instance = registry.get(name);
    result[key] = instance;
    if (aliases[name]) result[aliases[name]] = instance;
  }
  return result;
}

/**
 * 初始化思维子系统模块，包括 ThoughtExtractor、ThoughtDeduplicator、
 * EmbeddingService、ThoughtMemoryStore、ModelSelector 和 ThoughtRetrieverCycle。
 * ThoughtRetrieverCycle 使用混合检索模式（hybrid）整合提取、去重与嵌入服务。
 *
 * @param {string} projectRoot - 项目根目录的绝对路径
 * @param {Object} validation - 配置验证结果对象，包含 config.embedding 和 config.model_selector_config
 * @returns {{ thoughtExtractor: ThoughtExtractor, thoughtDeduplicator: ThoughtDeduplicator, thoughtMemoryStore: ThoughtMemoryStore, thoughtRetrieverCycle: ThoughtRetrieverCycle, embeddingService: EmbeddingService, modelSelector: ModelSelector }} 思维子系统模块实例对象
 */
function _initThoughtModules(projectRoot, validation) {
  const thoughtExtractor = new ThoughtExtractor();
  const thoughtDeduplicator = new ThoughtDeduplicator();
  const embeddingService = new EmbeddingService(
    (validation.config && validation.config.embedding) ?? {},
  );
  const thoughtMemoryStore = new ThoughtMemoryStore(projectRoot, { embeddingService });
  const modelSelector = new ModelSelector((validation.config && validation.config.model_selector_config) ?? {});
  const thoughtRetrieverCycle = new ThoughtRetrieverCycle({
    thoughtExtractor, thoughtDeduplicator, thoughtMemoryStore, embeddingService, retrievalMode: 'hybrid',
  });
  return { thoughtExtractor, thoughtDeduplicator, thoughtMemoryStore, thoughtRetrieverCycle, embeddingService, modelSelector };
}

/**
 * 初始化协作子系统模块，包括 CollaborationModeRouter、StructuredIntent、
 * SubagentExecutor、PairChat 和 ChatChain。协作模块是 Agent 间通信与
 * 协同工作的基础设施。
 *
 * @returns {{ collaborationModeRouter: CollaborationModeRouter, structuredIntent: StructuredIntent, subagentExecutor: SubagentExecutor, pairChat: PairChat, chatChain: ChatChain }} 协作子系统模块实例对象
 * @throws {HarnessError} 当协作子系统初始化失败时抛出 INIT_FAILED 错误
 */
function _initCollaborationModules() {
  let collaborationModeRouter, structuredIntent, subagentExecutor, pairChat, chatChain;
  try {
    collaborationModeRouter = new CollaborationModeRouter();
    structuredIntent = new StructuredIntent();
    subagentExecutor = new SubagentExecutor();
    pairChat = new PairChat();
    chatChain = new ChatChain();
  } catch (collabErr) {
    debug('Harness', 'collab-init', collabErr);
    const harnessErr = new HarnessError('INIT_FAILED', 'Collaboration system initialization failed: ' + (collabErr && collabErr.message ? collabErr.message : String(collabErr)), { cause: collabErr });
    throw harnessErr;
  }
  return { collaborationModeRouter, structuredIntent, subagentExecutor, pairChat, chatChain };
}

/**
 * 同步清理已创建的模块实例。按顺序尝试调用每个实例的 shutdown、destroy
 * 或 removeAllListeners 方法进行资源释放，单个实例清理失败不影响后续实例的清理。
 *
 * @param {Array} created - 已创建的模块实例数组
 */
function _cleanup(created) {
  for (const obj of created) {
    try {
      if (typeof obj.shutdown === 'function') { const _r = obj.shutdown(); if (_r && typeof _r.catch === 'function') _r.catch(function(_e) { debug('Harness', 'shutdown-error', _e && _e.message ? _e.message : String(_e)); }); }
      else if (typeof obj.destroy === 'function') obj.destroy();
      else if (typeof obj.removeAllListeners === 'function') obj.removeAllListeners();
    } catch (err) { debug('Harness', '_cleanup', err); }
  }
}

/**
 * 异步清理已创建的模块实例。按顺序尝试调用每个实例的 shutdownAsync、shutdown、
 * destroyAsync、destroy 或 removeAllListeners 方法进行资源释放，优先使用异步方法。
 * 单个实例清理失败不影响后续实例的清理。
 *
 * @param {Array} created - 已创建的模块实例数组
 * @returns {Promise<void>} 所有实例清理完成后 resolve
 */
async function _cleanupAsync(created) {
  for (const obj of created) {
    try {
      if (typeof obj.shutdownAsync === 'function') await obj.shutdownAsync();
      else if (typeof obj.shutdown === 'function') await obj.shutdown();
      else if (typeof obj.destroyAsync === 'function') await obj.destroyAsync();
      else if (typeof obj.destroy === 'function') obj.destroy();
      else if (typeof obj.removeAllListeners === 'function') obj.removeAllListeners();
    } catch (err) { debug('Harness', '_cleanupAsync', err); }
  }
}

/**
 * 异步初始化全部核心模块。与 _initCoreModules 功能等价，但使用异步 API
 * 进行 Skill 发现、RBAC 加载、命令路由发现、Agent 包管理器发现、技能精简器发现
 * 及 Agent 状态管理器初始化。关键模块初始化失败时自动异步回滚已创建实例。
 * 异步路径中 discoverAsync 失败的模块会标记 _partialInit 而非中断整个初始化流程。
 *
 * @param {string} projectRoot - 项目根目录的绝对路径
 * @param {Object} validation - 配置验证结果对象，包含 config 属性
 * @returns {Promise<{ projectRoot: string, validation: Object, created: Array, startupTimings: Array<{module: string, ms: number}>, router: SkillRouter, session: SessionManager, orchestrator: PhaseOrchestrator, enforcer: RBACEnforcer, guard: PermissionGuard, logger: AuditLogger, tddGate: TDDGate, verifier: EvidenceVerifier, eventBus: EventBus, pluginManager: PluginManager, healthChecker: HealthChecker, structuredLog: StructuredLogger, memoryStore: MemoryStore, agentChannel: AgentChannel, checkpointManager: CheckpointManager, retryEngine: RetryEngine, skillImprover: SkillImprover, concurrencyController: ConcurrencyController, adversarialReview: AdversarialReview, platformCoordinator: PlatformCoordinator, workflowTemplate: WorkflowTemplate, complianceChecker: FrameworkComplianceChecker, deviationApproval: DeviationApproval, codeReviewCheck: CodeReviewFrameworkCheck, designSkillEngine: DesignSkillEngine, selfReflection: SelfReflection, ltiInjector: LTIContextInjector, commandRouter: CommandRouter, programmableHookExecutor: ProgrammableHookExecutor, contextCompressionEngine: ContextCompressionEngine, agentPackManager: AgentPackManager, tokenManager: TokenManager, deepeningRegistry: DeepeningModuleRegistry, skillReducer: SkillReducer, generatorVerifier: GeneratorVerifier, isolatedContextManager: IsolatedContextManager, planPersistence: PlanPersistence, archive: ChangelogArchive, autoVersionTracker: AutoVersionTracker, ragPipeline: RAGPipeline, [key: string]: * }>} 包含全部已初始化模块实例的对象的 Promise
 * @throws {HarnessError} 当 SkillRouter、SessionManager、RBACEnforcer 或 Agent 子系统初始化失败时抛出 INIT_FAILED 错误
 */
async function _initCoreModulesAsync(projectRoot, validation) {
  const startupTimings = [];
  const created = [];
  const ctx = { projectRoot, validation, created };

  const critical = await _initCriticalModulesAsync(projectRoot, created, startupTimings);

  const eventBus = new EventBus();
  const pluginManager = new PluginManager(eventBus);
  ctx.eventBus = eventBus;

  const structuredLog = new StructuredLogger({ level: 'info', module: 'harness' });
  setDebugBridge(structuredLog);

  const memoryStore = _measure(startupTimings, 'MemoryStore', function() { return new MemoryStore(projectRoot); });
  const agentChannel = _measure(startupTimings, 'AgentChannel', function() { return new AgentChannel(); });

  const instances = { router: critical.router, session: critical.session, enforcer: critical.enforcer, eventBus, pluginManager, structuredLog, memoryStore, agentChannel };

  await _initSimpleModulesAsync(SIMPLE_MODULES, instances, ctx);

  const contextMapper = new ContextMapper();
  if (validation.config && validation.config.bounded_contexts) {
    contextMapper.importFromConfig(validation.config.bounded_contexts);
  }
  instances.contextMapper = contextMapper;
  created.push(contextMapper);

  const moeGatingRouter = new MoeGatingRouter(validation.config && validation.config.moe_config || {});
  instances.moeGatingRouter = moeGatingRouter;
  created.push(moeGatingRouter);

  created.push(
    instances.eventBus, instances.pluginManager, instances.structuredLog,
    instances.memoryStore, instances.agentChannel,
  );

  const postCore = await _initPostCoreModulesAsync(projectRoot, validation, created, startupTimings);

  const subsys = await _initSubsystemsAsync(projectRoot, validation, critical.router, eventBus, instances, created, startupTimings);

  const wired = _wireDependencies(instances, subsys.thoughtModules, subsys.storeModules, subsys.deepeningModules, subsys.collabModules, projectRoot, eventBus, created);

  return {
    projectRoot, validation, created,
    startupTimings,
    router: critical.router, session: critical.session, orchestrator: instances.orchestrator, enforcer: critical.enforcer, guard: instances.guard,
    logger: instances.logger, tddGate: instances.tddGate, verifier: instances.verifier,
    eventBus, pluginManager: instances.pluginManager, healthChecker: instances.healthChecker, structuredLog,
    memoryStore, agentChannel, checkpointManager: instances.checkpointManager, retryEngine: instances.retryEngine,
    skillImprover: instances.skillImprover, concurrencyController: instances.concurrencyController,
    adversarialReview: instances.adversarialReview, platformCoordinator: instances.platformCoordinator,
    workflowTemplate: instances.workflowTemplate, complianceChecker: instances.complianceChecker,
    deviationApproval: instances.deviationApproval, codeReviewCheck: instances.codeReviewCheck,
    designSkillEngine: instances.designSkillEngine,
    optimizationLoop: instances.optimizationLoop,
    selfReflection: instances.selfReflection,
    ltiInjector: instances.ltiInjector,
    devMetricsCollector: instances.devMetricsCollector,
    commandRouter: postCore.commandRouter, programmableHookExecutor: postCore.programmableHookExecutor, contextCompressionEngine: postCore.contextCompressionEngine,
    agentPackManager: instances.agentPackManager,
    ...subsys.thoughtModules,
    tokenManager: instances.tokenManager, deepeningRegistry: subsys.deepeningRegistry, skillReducer: instances.skillReducer,
    generatorVerifier: instances.generatorVerifier,
    isolatedContextManager: instances.isolatedContextManager, planPersistence: instances.planPersistence,
    archive: instances.archive, autoVersionTracker: wired.autoVersionTracker,
    ...subsys.storeModules, ...subsys.agentModules, ...subsys.deepeningModules, ...subsys.collabModules,
    ragPipeline: subsys.ragPipeline,
    contextMapper: instances.contextMapper,
    moeGatingRouter: instances.moeGatingRouter,
  };
}

/**
 * 异步初始化简单模块列表。遍历模块注册表，跳过已存在的实例，创建新实例并
 * 执行 postInit 后续初始化。若模块存在异步版本的 postInit 方法（如 discoverAsync），
 * 优先调用异步版本；异步 postInit 失败时仅记录日志，不中断整体流程。
 *
 * @param {Array<{key: string, Class: Function, args?: Array, postInit?: string}>} modules - 简单模块注册表
 * @param {Object<string, *>} instances - 已有实例的映射对象，新实例会写入此对象
 * @param {{ projectRoot: string }} ctx - 包含项目根路径的上下文对象
 * @returns {Promise<void>} 所有模块初始化完成后 resolve
 */
async function _initSimpleModulesAsync(modules, instances, ctx) {
  for (const mod of modules) {
    if (instances[mod.key]) continue;
    const args = mod.args ? _resolveArgs(mod.args, ctx) : [];
    const inst = new mod.Class(...args);
    instances[mod.key] = inst;
    ctx.created.push(inst);
    if (mod.postInit && typeof inst[mod.postInit] === 'function') {
      const asyncName = mod.postInit + 'Async';
      if (typeof inst[asyncName] === 'function') {
        try {
          await _withTimeout(inst[asyncName].bind(inst), MODULE_INIT_TIMEOUT_MS, mod.key + '.' + asyncName);
        } catch (postInitErr) {
          debug('Harness', 'postInitAsync', { key: mod.key, error: postInitErr.message });
        }
      } else {
        try {
          inst[mod.postInit]();
        } catch (postInitErr) {
          debug('Harness', 'postInitSync', { key: mod.key, error: postInitErr.message });
        }
      }
    }
  }
}

/**
 * 异步初始化 Agent 子系统模块。与 _initAgentModules 功能等价，但 AgentStateManager
 * 使用异步初始化（asyncInit: true + init()），以支持需要异步加载的 Agent 状态存储。
 *
 * @param {string} projectRoot - 项目根目录的绝对路径
 * @returns {Promise<{ agentRuntime: AgentRuntime, agentSandbox: AgentSandbox, agentStateManager: AgentStateManager, agentMonitor: AgentMonitor, agentDeployment: AgentDeployment, agentWorkflowIntegration: AgentWorkflowIntegration, agentLifecycle: AgentLifecycleController }>} Agent 子系统模块实例对象的 Promise
 * @throws {HarnessError} 当 Agent 子系统初始化失败时抛出 INIT_FAILED 错误
 */
async function _initAgentModulesAsync(projectRoot) {
  let agentRuntime, agentSandbox, agentStateManager, agentMonitor, agentDeployment, agentWorkflowIntegration, agentLifecycle;
  try {
    agentRuntime = new AgentRuntime(projectRoot);
    agentSandbox = new AgentSandbox(projectRoot);
    agentStateManager = new AgentStateManager(projectRoot, { asyncInit: true });
    await agentStateManager.init();
    agentMonitor = new AgentMonitor(projectRoot);
    agentDeployment = new AgentDeployment(projectRoot);
    agentWorkflowIntegration = new AgentWorkflowIntegration(projectRoot);
    agentLifecycle = new AgentLifecycleController(agentRuntime, agentStateManager, agentSandbox);
  } catch (agentErr) {
    debug('Harness', 'agent-init-async', agentErr);
    const harnessErr = new HarnessError('INIT_FAILED', 'Agent system initialization failed: ' + (agentErr && agentErr.message ? agentErr.message : String(agentErr)), { cause: agentErr });
    throw harnessErr;
  }
  return { agentRuntime, agentSandbox, agentStateManager, agentMonitor, agentDeployment, agentWorkflowIntegration, agentLifecycle };
}

function _withTimeout(fn, ms, label) {
  return new Promise(function(resolve, reject) {
    let settled = false;
    const timer = setTimeout(function() {
      if (!settled) {
        settled = true;
        reject(new HarnessError('INIT_TIMEOUT', label + ' timed out after ' + ms + 'ms'));
      }
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    fn().then(function(result) {
      if (!settled) { settled = true; clearTimeout(timer); resolve(result); }
    }).catch(function(err) {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });
  });
}

module.exports = { _initCoreModules, _initCoreModulesAsync, _cleanup, _cleanupAsync };
