/** @module index */
'use strict';

const SkillRouter = require('./runtime/skill/skill-router');
const SessionManager = require('./runtime/session/session-manager');
const PhaseOrchestrator = require('./runtime/workflow/phase-orchestrator');
const EventBus = require('./runtime/infrastructure/event-bus');
const PluginManager = require('./runtime/infrastructure/plugin-manager');
const HealthChecker = require('./runtime/infrastructure/health-checker');
const MemoryStore = require('./runtime/thought/memory-store');
const AgentChannel = require('./runtime/agent/agent-channel');
const WorkflowDAG = require('./runtime/workflow/workflow-dag');
const CheckpointManager = require('./runtime/session/checkpoint-manager');
const RetryEngine = require('./runtime/infrastructure/retry-engine');
const SkillImprover = require('./runtime/skill/skill-improver');
const ConcurrencyController = require('./runtime/infrastructure/concurrency-controller');
const AgenticPatterns = require('./runtime/patterns/agentic-patterns');
const HarnessEngineering = require('./runtime/patterns/harness-engineering');
const PlanExecuteEnhancer = require('./runtime/patterns/plan-execute-enhancer');
const MultiAgentControl = require('./runtime/patterns/multi-agent-control');
const AdversarialReview = require('./runtime/quality/adversarial-review');
const PlatformCoordinator = require('./runtime/infrastructure/platform-coordinator');
const WorkflowTemplate = require('./runtime/workflow/workflow-template');
const RBACEnforcer = require('./permission/rbac-enforcer');
const PermissionGuard = require('./permission/permission-guard');
const AuditLogger = require('./permission/audit-logger');
const TDDGate = require('./gate/tdd-gate');
const EvidenceVerifier = require('./gate/evidence-verifier');
const FrameworkComplianceChecker = require('./gate/framework-compliance-checker');
const DeviationApproval = require('./gate/deviation-approval');
const CodeReviewFrameworkCheck = require('./gate/code-review-framework-check');
const DesignSkillEngine = require('./gate/design-skill-engine');
const StructuredLogger = require('./utils/structured-logger');
const { debug } = require('./utils/debug-logger');
const BoundedArray = require('./utils/bounded-array');
const safeParse = require('./utils/safe-parse');
const { t, setLocale, getLocale, getSupportedLocales } = require('./utils/i18n');
const { validateAgentId } = require('./utils/constants');
const WebSocketHandler = require('./web/websocket-handler');
const DashboardServer = require('./web/server');
const ChangelogArchive = require('./web/changelog-archive');
const { HarnessError, SessionError, PermissionError, TDDGateError, AgentError, DeepeningError, CausalViolationError, PipelineError, HookError, ERROR_CODES, ERROR_SEVERITY, HTTP_STATUS_MAP } = require('./errors');
const { validateConfig, maskConfigForLogging } = require('./utils/config-validator');
const { mergeConfig } = require('./utils/safe-assign');
const AgentRuntime = require('./runtime/agent/agent-runtime');
const AgentLifecycleController = require('./runtime/agent/agent-lifecycle-controller');
const AgentSandbox = require('./runtime/agent/agent-sandbox');
const AgentMonitor = require('./runtime/agent/agent-monitor');
const AgentDeployment = require('./runtime/agent/agent-deployment');
const AgentStateManager = require('./runtime/agent/agent-state-manager');
const AgentWorkflowIntegration = require('./runtime/agent/agent-workflow-integration');
const TokenManager = require('./runtime/model/token-manager');
const DeepeningModuleRegistry = require('./runtime/deepening/deepening-module-registry');
const SkillReducer = require('./runtime/skill/skill-reducer');
const GeneratorVerifier = require('./gate/generator-verifier');
const IsolatedContextManager = require('./runtime/context/isolated-context-manager');
const PlanPersistence = require('./runtime/workflow/plan-persistence');
const CollaborationModeRouter = require('./runtime/collaboration/collaboration-mode-router');
const StructuredIntent = require('./runtime/user/structured-intent');
const SubagentExecutor = require('./runtime/agent/subagent-executor');
const PairChat = require('./runtime/collaboration/pair-chat');
const ChatChain = require('./runtime/collaboration/chat-chain');
const AutoVersionTracker = require('./runtime/infrastructure/auto-version-tracker');
const SqliteStore = require('./runtime/infrastructure/sqlite-store');
const SkillImprovementLoop = require('./runtime/skill/skill-improvement-loop');
const MemoryNudge = require('./runtime/thought/memory-nudge');
const SkillCreationEngine = require('./runtime/skill/skill-creation-engine');
const SkillCurator = require('./runtime/skill/skill-curator');
const SkillEvolver = require('./runtime/skill/skill-evolver');
const MetaSkillOrchestrator = require('./runtime/skill/meta-skill-orchestrator');
const MetaSkillGenerator = require('./runtime/skill/meta-skill-generator');
const UserModelManager = require('./runtime/user/user-model-manager');
const MCPClient = require('./runtime/infrastructure/mcp-client');
const CommandRouter = require('./runtime/workflow/command-router');
const ProgrammableHookExecutor = require('./runtime/workflow/programmable-hook-executor');
const ContextCompressionEngine = require('./runtime/context/context-compression-engine');
const ThoughtExtractor = require('./runtime/thought/thought-extractor');
const ThoughtDeduplicator = require('./runtime/thought/thought-deduplicator');
const ThoughtMemoryStore = require('./runtime/thought/thought-memory-store');
const ThoughtRetrieverCycle = require('./runtime/thought/thought-retriever-cycle');
const EmbeddingService = require('./runtime/model/embedding-service');
const ModelSelector = require('./runtime/model/model-selector');
const CostAwareRouter = require('./runtime/model/cost-aware-router');
const GoalExecutor = require('./runtime/workflow/goal-executor');
const BusinessGoal = require('./runtime/workflow/business-goal');
const SignalPersistence = require('./runtime/infrastructure/signal-persistence');
const ConversationContextStore = require('./runtime/infrastructure/conversation-context-store');
const SelfEvolutionGovernor = require('./runtime/quality/self-evolution-governor');
const SkillPatchApproval = require('./gate/skill-patch-approval');
const PriorityQueue = require('./runtime/infrastructure/priority-queue');
const CausalVectorIndex = require('./runtime/causal/causal-vector-index');
const CausalBufferManager = require('./runtime/causal/causal-buffer-manager');
const HumanApprovalGate = require('./runtime/workflow/human-approval-gate');
const RiskBasedApprovalGate = require('./runtime/workflow/risk-approval-gate');
const RAGPipeline = require('./runtime/workflow/rag-pipeline');
const SelfReflection = require('./runtime/quality/self-reflection');
const FeedbackCredibility = require('./runtime/quality/feedback-credibility');
const AiCodeTrustScorer = require('./runtime/quality/ai-code-trust-scorer');
const ComprehensionDebtTracker = require('./runtime/quality/comprehension-debt-tracker');
const DeliveryEfficiencyMeter = require('./runtime/quality/delivery-efficiency-meter');
const AgentPackManager = require('./runtime/agent/agent-pack-manager');
const AgentDebugLoop = require('./runtime/agent/agent-debug-loop').AgentDebugLoop;
const LayerBoundaryGuard = require('./gate/layer-boundary-guard').LayerBoundaryGuard;
const ArchitectureBoundaryEnforcer = require('./gate/architecture-boundary-enforcer').ArchitectureBoundaryEnforcer;
const CodeDriftDetector = require('./gate/code-drift-detector').CodeDriftDetector;
const ModelLayer = require('./runtime/agent/model-layer');
const HarnessLayer = require('./runtime/agent/harness-layer');
const AgentDiversityManager = require('./runtime/collaboration/agent-diversity-manager').AgentDiversityManager;
const EnsembleOrchestrator = require('./runtime/collaboration/ensemble-orchestrator').EnsembleOrchestrator;
const AgentContributionTracker = require('./runtime/collaboration/agent-contribution-tracker').AgentContributionTracker;
const DreamScheduler = require('./runtime/thought/dream-scheduler').DreamScheduler;
const ErrorPreventionGuard = require('./gate/error-prevention-guard').ErrorPreventionGuard;
const OutputConcisenessGuard = require('./gate/output-conciseness-guard').OutputConcisenessGuard;
const PlaybookGenerator = require('./runtime/skill/playbook-generator').PlaybookGenerator;
const SkillTreeDAG = require('./runtime/skill/skill-tree-dag').SkillTreeDAG;
const InferenceCache = require('./runtime/model/inference-cache').InferenceCache;
const { ExecutionModeManager, EXECUTION_MODES } = require('./runtime/workflow/execution-mode-manager');
const { DynamicHarnessGenerator, HARNESS_STATUS, TRIGGER_KEYWORDS } = require('./runtime/workflow/dynamic-harness-generator');
const { SprintCycle, SPRINT_PHASES } = require('./runtime/workflow/sprint-cycle');
const { ToolAdapter, TOOL_TYPES } = require('./runtime/workflow/tool-adapter');
const OptimizationLoop = require('./runtime/workflow/optimization-loop');
const KarpathyEnhancer = require('./gate/karpathy-enhancer');
const DesignTokens = require('./gate/design-tokens');
const SharedRuleHelpers = require('./gate/shared-rule-helpers');
const TUIOrchestrator = require('./runtime/tui/tui-orchestrator');
const REPLEngine = require('./runtime/tui/repl-engine');
const TUIApp = require('./runtime/tui/tui-app');
const PersonaManager = require('./runtime/tui/persona-manager');
const QuickCommandRegistry = require('./runtime/tui/quick-command-registry');
const { MoeGatingRouter } = require('./runtime/collaboration/moe-gating-router');
const { DevMetricsCollector } = require('./runtime/collaboration/dev-metrics-collector');
const ContextMapper = require('./domain/context-mapper');
const _EvaluationCalibrator = require('./runtime/quality/evaluation-calibrator');
const _HarnessMigrationEngine = require('./runtime/model/harness-migration-engine');
const _TaskLifecycleOrchestrator = require('./runtime/workflow/task-lifecycle-orchestrator');
const EvaluationCalibrator = _EvaluationCalibrator;
const HarnessMigrationEngine = _HarnessMigrationEngine;
const TaskLifecycleOrchestrator = _TaskLifecycleOrchestrator;

const eventRegistrar = require('./runtime/infrastructure/event-registrar');
const healthRegistrar = require('./runtime/infrastructure/health-registrar');
const moduleInitializer = require('./runtime/infrastructure/module-initializer');
const { executePipeline } = require('./runtime/workflow/pipeline-executor');
const { buildInstance } = require('./runtime/infrastructure/instance-builder');

const _errorHandlersKey = Symbol.for('harness:errorHandlers');

function _lazy(modulePath) {
  let cached = null;
  return function() {
    if (cached === null) {
      cached = require(modulePath);
    }
    return cached;
  };
}

const lazyExports = {
  RecurrentDeepeningScheduler: _lazy('./runtime/deepening/recurrent-deepening-scheduler'),
  AdaptiveDepthController: _lazy('./runtime/deepening/adaptive-depth-controller'),
  LTIContextInjector: _lazy('./runtime/context/lti-context-injector'),
  MultiAgentRouter: _lazy('./runtime/agent/multi-agent-router'),
  OutputFusion: _lazy('./runtime/collaboration/output-fusion'),
  IterativeRefinement: _lazy('./runtime/deepening/iterative-refinement'),
  ProgressiveDeepening: _lazy('./runtime/deepening/progressive-deepening'),
  DeepeningOrchestrator: _lazy('./runtime/deepening/deepening-orchestrator'),
  QualityScorer: _lazy('./runtime/quality/quality-scorer'),
  TokenAwareDeepening: _lazy('./runtime/deepening/token-aware-deepening'),
  AffinityLearner: _lazy('./runtime/user/affinity-learner'),
  ConvergenceDetector: _lazy('./runtime/deepening/convergence-detector'),
  DeepeningMetricsCollector: _lazy('./runtime/deepening/deepening-metrics-collector'),
  DeepeningCache: _lazy('./runtime/deepening/deepening-cache'),
  DeepeningStrategyPlugin: _lazy('./runtime/deepening/deepening-strategy-plugin'),
  DeepeningReportGenerator: _lazy('./runtime/deepening/deepening-report-generator'),
  DeepeningPipeline: _lazy('./runtime/deepening/deepening-pipeline'),
  DeepeningHealthMonitor: _lazy('./runtime/deepening/deepening-health-monitor'),
  DeepeningEventStore: _lazy('./runtime/deepening/deepening-event-store'),
  DeepeningWorkflowTemplate: _lazy('./runtime/deepening/deepening-workflow-template'),
  DeepeningBenchmark: _lazy('./runtime/deepening/deepening-benchmark'),
  PhaseContextInjector: _lazy('./runtime/context/phase-context-injector'),
  CausalDataBus: _lazy('./runtime/causal/causal-data-bus'),
  CausalMemoryStore: _lazy('./runtime/causal/causal-memory-store'),
  ConfigCausalValidator: _lazy('./runtime/causal/causal-config-validator'),
  DocFreshnessGuard: _lazy('./runtime/quality/doc-freshness-guard'),
  SharedInfrastructure: _lazy('./runtime/infrastructure/shared-infrastructure'),
  CausalConsistencyChecker: _lazy('./runtime/causal/causal-consistency-checker'),
  DeepeningGracefulShutdown: _lazy('./runtime/deepening/deepening-graceful-shutdown'),
  DeepeningTaskScheduler: _lazy('./runtime/deepening/deepening-task-scheduler'),
  DeepeningPluginSystem: _lazy('./runtime/deepening/deepening-plugin-system'),
  DeepeningServiceRegistry: _lazy('./runtime/deepening/deepening-service-registry'),
  DeepeningRateLimiter: _lazy('./runtime/deepening/deepening-rate-limiter'),
  DeepeningSecurityGuard: _lazy('./runtime/deepening/deepening-security-guard'),
  DeepeningResourceManager: _lazy('./runtime/deepening/deepening-resource-manager'),
  DeepeningCircuitBreaker: _lazy('./runtime/deepening/deepening-circuit-breaker'),
  DeepeningSnapshot: _lazy('./runtime/deepening/deepening-snapshot'),
  DeepeningStateManager: _lazy('./runtime/deepening/deepening-state-manager'),
  DeepeningBase: _lazy('./runtime/deepening/deepening-base'),
  DeepeningConfigManager: _lazy('./runtime/deepening/deepening-config-manager'),
  DeepeningEventBus: _lazy('./runtime/deepening/deepening-event-bus'),
  DeepeningValidator: _lazy('./runtime/deepening/deepening-validator'),
  DeepeningNotifier: _lazy('./runtime/deepening/deepening-notifier'),
  DeepeningLockManager: _lazy('./runtime/deepening/deepening-lock-manager'),
  DeepeningConnectionPool: _lazy('./runtime/deepening/deepening-connection-pool'),
  DeepeningFeatureFlags: _lazy('./runtime/deepening/deepening-feature-flags'),
  DeepeningPriorityQueue: _lazy('./runtime/deepening/deepening-priority-queue'),
  DeepeningThrottle: _lazy('./runtime/deepening/deepening-throttle'),
  DeepeningLoadBalancer: _lazy('./runtime/deepening/deepening-load-balancer'),
  DeepeningRetryPolicy: _lazy('./runtime/deepening/deepening-retry-policy'),
  DeepeningTaskQueue: _lazy('./runtime/deepening/deepening-task-queue'),
  DeepeningSnapshotStore: _lazy('./runtime/deepening/deepening-snapshot-store'),
  DeepeningDataPipeline: _lazy('./runtime/deepening/deepening-data-pipeline'),
  DeepeningDependencyResolver: _lazy('./runtime/deepening/deepening-dependency-resolver'),
  DeepeningDeployment: _lazy('./runtime/deepening/deepening-deployment'),
  DeepeningErrorHandler: _lazy('./runtime/deepening/deepening-error-handler'),
  DeepeningEventReplay: _lazy('./runtime/deepening/deepening-event-replay'),
  DeepeningMetricsAggregator: _lazy('./runtime/deepening/deepening-metrics-aggregator'),
  DeepeningStateMachine: _lazy('./runtime/deepening/deepening-state-machine'),
  DeepeningTimeoutManager: _lazy('./runtime/deepening/deepening-timeout-manager'),
  DeepeningVisualizer: _lazy('./runtime/deepening/deepening-visualizer'),
  DeepeningAuditTrail: _lazy('./runtime/deepening/deepening-audit-trail'),
  DeepeningBackpressureManager: _lazy('./runtime/deepening/deepening-backpressure-manager'),
  SkillWrapper: _lazy('./runtime/agent/skill-wrapper'),
  AutoregressiveContextSchema: _lazy('./runtime/context/autoregressive-context-schema'),
  OodaLoop: _lazy('./runtime/deepening/ooda-loop'),
  CodeGraph: _lazy('./runtime/infrastructure/code-graph'),
  ServiceFs: _lazy('./runtime/infrastructure/service-fs'),
  TriAttention: _lazy('./runtime/model/tri-attention'),
  SkillDiscoverUtils: _lazy('./runtime/skill/skill-discover-utils'),
  SkillGraph: _lazy('./runtime/skill/skill-graph'),
  BrainMemory: _lazy('./runtime/thought/brain-memory'),
  DreamEngine: _lazy('./runtime/thought/dream-engine'),
  LlmWiki: _lazy('./runtime/thought/llm-wiki'),
  MemoryPipeline: _lazy('./runtime/thought/memory-pipeline'),
  MemoryPrefetcher: _lazy('./runtime/thought/memory-prefetcher'),
  MemorySyncCoordinator: _lazy('./runtime/thought/memory-sync-coordinator'),
  UnifiedMemoryRecaller: _lazy('./runtime/thought/unified-memory-recaller'),
  AgentSkillsDiscipline: _lazy('./runtime/workflow/agent-skills-discipline'),
  GraphRag: _lazy('./runtime/workflow/graph-rag'),
  HookHandlers: _lazy('./runtime/workflow/hook-handlers'),
  SkillCanary: _lazy('./runtime/skill/skill-canary'),
  SkillObservability: _lazy('./runtime/skill/skill-observability'),
  SkillAuditTrail: _lazy('./runtime/skill/skill-audit-trail'),
  KVCacheManager: _lazy('./runtime/model/kv-cache-manager'),
  DreamOutcomes: _lazy('./runtime/thought/dream-outcomes'),
  DreamBridge: _lazy('./runtime/thought/dream-bridge'),
  CrossGraphBridge: _lazy('./runtime/thought/cross-graph-bridge'),
  UnifiedVectorIndexService: _lazy('./runtime/thought/unified-vector-index-service'),
  CausalMemoryBridge: _lazy('./runtime/thought/causal-memory-bridge'),
  CodeWikiOrchestrator: _lazy('./runtime/skill/code-wiki-orchestrator'),
  SkillSemanticSearcher: _lazy('./runtime/skill/skill-semantic-searcher'),
  SkillComparisonRecommender: _lazy('./runtime/skill/skill-comparison-recommender'),
};

/**
 * 创建 Harness 框架实例
 * @param {string} projectRoot - 项目根目录的绝对路径
 * @param {{ strictValidation?: boolean }} [options] - 创建选项
 * @param {boolean} [options.strictValidation=false] - 是否启用严格配置验证
 * @returns {Object} Harness 实例，包含 router/session/orchestrator 等属性和 executePipeline/destroy 方法
 * @throws {HarnessError} 当 strictValidation 为 true 且配置验证失败时
 */
function create(projectRoot, options) {
  const validation = validateConfig(projectRoot);
  if (!validation.valid && options && options.strictValidation) {
    throw new HarnessError('CONFIG_INVALID', 'Config validation failed: ' + validation.errors.join('; '));
  }
  if (validation.warnings.length > 0) {
    validation.warnings.forEach(w => debug('Config', 'warning', w));
  }

  const created = [];

  try {
    const ctx = moduleInitializer._initCoreModules(projectRoot, validation, created);
    eventRegistrar._registerEventForwarding(ctx);
    eventRegistrar._registerSessionEvents(ctx);
    eventRegistrar._registerAuditMiddleware(ctx);
    eventRegistrar._registerStructuredLogListeners(ctx);
    healthRegistrar._registerHealthChecks(ctx);
    healthRegistrar._registerDeepeningInternalHealth(ctx);

    ctx.structuredLog.info('Harness framework initialized', {
      skills: ctx.router.skills.length,
      agents: Object.keys(ctx.enforcer.agents).length,
      commands: ctx.commandRouter.commands.length,
      validationValid: validation.valid,
      startupTimings: ctx.startupTimings,
    });

    if (ctx.selfEvolutionGovernor) {
      try {
        ctx.selfEvolutionGovernor.start();
        ctx.structuredLog.info('Self-evolution governor started', { intervalMs: ctx.selfEvolutionGovernor._heartbeatInterval });
      } catch (govStartErr) {
        debug('Harness', 'governorStartError', govStartErr);
        ctx.structuredLog.warn('Self-evolution governor failed to start', { error: govStartErr && govStartErr.message ? govStartErr.message : String(govStartErr) });
      }
    }

    const instance = buildInstance(ctx, executePipeline);

    if (!global[_errorHandlersKey]) {
      const uncaughtHandler = function(err) {
        ctx.structuredLog.error('Uncaught exception - exiting', { error: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : undefined });
        process.exitCode = 1;
        const forceExit = setTimeout(function() { process.exit(1); }, 3000);
        if (forceExit.unref) forceExit.unref();
        try {
          const hc = ctx.healthChecker;
          if (hc && typeof hc.shutdown === 'function') {
            const result = hc.shutdown();
            if (result && typeof result.then === 'function') {
              result.then(function() { clearTimeout(forceExit); }).catch(function() { /* already exiting */ });
            }
          }
        } catch (sErr) { debug('Harness', 'uncaughtException', 'HealthChecker shutdown failed: ' + (sErr && sErr.message ? sErr.message : String(sErr))); }
      };
      const rejectionHandler = function(reason) {
        ctx.structuredLog.error('Unhandled rejection', { reason: String(reason) });
        process.exitCode = 1;
      };
      process.on('uncaughtException', uncaughtHandler);
      process.on('unhandledRejection', rejectionHandler);
      ctx._uncaughtHandler = uncaughtHandler;
      ctx._rejectionHandler = rejectionHandler;
      global[_errorHandlersKey] = true;
    }

    return instance;

  } catch (err) {
    moduleInitializer._cleanup(created);
    if (err instanceof HarnessError) throw err;
    throw new HarnessError('INIT_FAILED', 'Framework initialization failed: ' + (err && err.message ? err.message : String(err)), { cause: err });
  }
}

/**
 * 模块分组定义
 *
 * 稳定性标记：
 * @stable - 核心API，保证向后兼容
 * @experimental - 实验性API，可能变更
 *
 * stable: runtime, gate, permission, infrastructure, errors, utils, constants, i18n
 * experimental: collaboration, agent, web, tui, quality
 */
const MODULE_GROUPS = {
  runtime: ['SkillRouter','SessionManager','PhaseOrchestrator','EventBus','MemoryStore','AgentChannel','WorkflowDAG','CheckpointManager','RetryEngine','SkillImprover','AdversarialReview','WorkflowTemplate','TokenManager','DeepeningModuleRegistry','SkillReducer','IsolatedContextManager','PlanPersistence','StructuredIntent','SubagentExecutor','SkillImprovementLoop','MemoryNudge','SkillCreationEngine','SkillCurator','SkillEvolver','MetaSkillOrchestrator','MetaSkillGenerator','UserModelManager','CommandRouter','ProgrammableHookExecutor','ContextCompressionEngine','GoalExecutor','BusinessGoal','SelfEvolutionGovernor','CausalVectorIndex','CausalBufferManager','HumanApprovalGate','RiskBasedApprovalGate','RAGPipeline','ThoughtExtractor','ThoughtDeduplicator','ThoughtMemoryStore','ThoughtRetrieverCycle','EmbeddingService','ModelSelector','CostAwareRouter','SelfReflection','FeedbackCredibility','AiCodeTrustScorer','ComprehensionDebtTracker','DeliveryEfficiencyMeter','DreamScheduler','PlaybookGenerator','SkillTreeDAG','InferenceCache','ExecutionModeManager','SprintCycle','ToolAdapter','EXECUTION_MODES','SPRINT_PHASES','TOOL_TYPES','OptimizationLoop','AutoregressiveContextSchema','OodaLoop','TriAttention','KVCacheManager','SkillDiscoverUtils','SkillGraph','BrainMemory','DreamEngine','LlmWiki','MemoryPipeline','MemoryPrefetcher','MemorySyncCoordinator','UnifiedMemoryRecaller','AgentSkillsDiscipline','GraphRag','HookHandlers','SkillCanary','SkillObservability','SkillAuditTrail','DeepeningSecurityGuard','DeepeningSnapshotStore','DeepeningStateMachine','DeepeningValidator','DreamOutcomes','DreamBridge','CrossGraphBridge','UnifiedVectorIndexService','CausalMemoryBridge','CodeWikiOrchestrator','SkillSemanticSearcher','SkillComparisonRecommender'],
  agent: ['AgentRuntime','AgentLifecycleController','AgentSandbox','AgentMonitor','AgentDeployment','AgentStateManager','AgentWorkflowIntegration','AgentPackManager','ModelLayer','HarnessLayer','AgentDebugLoop','SkillWrapper'],
  gate: ['TDDGate','EvidenceVerifier','FrameworkComplianceChecker','DeviationApproval','CodeReviewFrameworkCheck','DesignSkillEngine','GeneratorVerifier','SkillPatchApproval','ErrorPreventionGuard','OutputConcisenessGuard','LayerBoundaryGuard','ArchitectureBoundaryEnforcer','CodeDriftDetector','KarpathyEnhancer','DesignTokens','SharedRuleHelpers'],
  permission: ['RBACEnforcer','PermissionGuard','AuditLogger'],
  infrastructure: ['PluginManager','HealthChecker','ConcurrencyController','PlatformCoordinator','StructuredLogger','BoundedArray','PriorityQueue','SignalPersistence','MCPClient','AutoVersionTracker','SqliteStore','ConversationContextStore','CodeGraph','ServiceFs','AgenticPatterns','HarnessEngineering','PlanExecuteEnhancer','MultiAgentControl','ContextMapper'],
  web: ['DashboardServer','ChangelogArchive','WebSocketHandler'],
  errors: ['HarnessError','SessionError','PermissionError','TDDGateError','AgentError','DeepeningError','CausalViolationError','PipelineError','HookError','ERROR_CODES','ERROR_SEVERITY','HTTP_STATUS_MAP'],
  i18n: ['t','setLocale','getLocale','getSupportedLocales'],
  utils: ['validateConfig','validateAgentId','maskConfigForLogging','safeParse','debug'],
  collaboration: ['CollaborationModeRouter','PairChat','ChatChain','OutputFusion','AgentDiversityManager','EnsembleOrchestrator','AgentContributionTracker','MoeGatingRouter','DevMetricsCollector'],
  tui: ['TUIOrchestrator','REPLEngine','TUIApp','PersonaManager','QuickCommandRegistry'],
  quality: ['EvaluationCalibrator'],
  model: ['HarnessMigrationEngine'],
  workflow: ['TaskLifecycleOrchestrator','DynamicHarnessGenerator'],
  core: ['create'],
  constants: ['HARNESS_STATUS','TRIGGER_KEYWORDS'],
};

const staticExports = {
  SkillRouter, SessionManager, PhaseOrchestrator, EventBus, PluginManager, HealthChecker,
  MemoryStore, AgentChannel, WorkflowDAG, CheckpointManager, RetryEngine, SkillImprover,
  ConcurrencyController, AgenticPatterns, HarnessEngineering, PlanExecuteEnhancer, MultiAgentControl, AdversarialReview, PlatformCoordinator, WorkflowTemplate,
  RBACEnforcer, PermissionGuard, AuditLogger, TDDGate, EvidenceVerifier,
  FrameworkComplianceChecker, DeviationApproval, CodeReviewFrameworkCheck,
  DesignSkillEngine, StructuredLogger, BoundedArray, safeParse, DashboardServer, ChangelogArchive,
  t, setLocale, getLocale, getSupportedLocales, WebSocketHandler,
  HarnessError, SessionError, PermissionError, TDDGateError, AgentError,
  DeepeningError, CausalViolationError, PipelineError, HookError, ERROR_CODES,
  ERROR_SEVERITY, HTTP_STATUS_MAP,
  validateConfig, validateAgentId, maskConfigForLogging, debug,
  AgentRuntime, AgentLifecycleController, AgentSandbox, AgentMonitor,
  AgentDeployment, AgentStateManager, AgentWorkflowIntegration,
  TokenManager, DeepeningModuleRegistry, SkillReducer, GeneratorVerifier,
  IsolatedContextManager, PlanPersistence, CollaborationModeRouter,
  StructuredIntent, SubagentExecutor, PairChat, ChatChain, SqliteStore,
  SkillImprovementLoop, MemoryNudge, SkillCreationEngine, SkillCurator, SkillEvolver,
  MetaSkillOrchestrator, MetaSkillGenerator,
  UserModelManager, MCPClient, CommandRouter, ProgrammableHookExecutor,
  ContextCompressionEngine, AutoVersionTracker, GoalExecutor, SignalPersistence, ConversationContextStore,
  SelfEvolutionGovernor, SkillPatchApproval, PriorityQueue, CausalVectorIndex,
  CausalBufferManager, HumanApprovalGate, RiskBasedApprovalGate, RAGPipeline,
  ThoughtExtractor, ThoughtDeduplicator, ThoughtMemoryStore, ThoughtRetrieverCycle,
  EmbeddingService, ModelSelector, CostAwareRouter, SelfReflection, FeedbackCredibility, AiCodeTrustScorer, ComprehensionDebtTracker, DeliveryEfficiencyMeter, AgentPackManager, ModelLayer, HarnessLayer, BusinessGoal,
  AgentDebugLoop, LayerBoundaryGuard, ArchitectureBoundaryEnforcer, CodeDriftDetector, AgentDiversityManager, EnsembleOrchestrator, AgentContributionTracker, DreamScheduler, ErrorPreventionGuard, OutputConcisenessGuard, PlaybookGenerator, SkillTreeDAG, InferenceCache,
  KarpathyEnhancer, DesignTokens, SharedRuleHelpers,
  ExecutionModeManager, EXECUTION_MODES, SprintCycle, SPRINT_PHASES, ToolAdapter, TOOL_TYPES, OptimizationLoop, create,
  TUIOrchestrator, REPLEngine, TUIApp, PersonaManager, QuickCommandRegistry,
  EvaluationCalibrator, HarnessMigrationEngine, TaskLifecycleOrchestrator,
  DynamicHarnessGenerator, HARNESS_STATUS, TRIGGER_KEYWORDS,
  MoeGatingRouter, DevMetricsCollector, ContextMapper,
};

const allExports = mergeConfig(staticExports, lazyExports);

// 在lazyExports合并后构建分组，确保lazyExports中的模块也可通过分组访问
for (const [group, keys] of Object.entries(MODULE_GROUPS)) {
  allExports[group] = {};
  keys.forEach(key => {
    if (allExports[key] !== undefined) allExports[group][key] = allExports[key];
  });
}

module.exports = allExports;
