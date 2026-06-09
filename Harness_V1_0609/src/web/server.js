'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const safeAssign = require('../utils/safe-assign');
const { mergeConfig } = safeAssign;
const { compressResponse } = require('./compression');
const StaticFileServer = require('./static-file-server');
const ChangelogArchive = require('./changelog-archive');
const WebSocketHandler = require('./websocket-handler');
const MemoryStore = require('../runtime/thought/memory-store');
const CheckpointManager = require('../runtime/session/checkpoint-manager');
const SkillImprover = require('../runtime/skill/skill-improver');
const WorkflowTemplate = require('../runtime/workflow/workflow-template');
const FrameworkComplianceChecker = require('../gate/framework-compliance-checker');
const DeviationApproval = require('../gate/deviation-approval');
const CodeReviewFrameworkCheck = require('../gate/code-review-framework-check');
const DesignSkillEngine = require('../gate/design-skill-engine');
const HumanApprovalGate = require('../runtime/workflow/human-approval-gate');
const { ORCHESTRATOR_STATUS, TERMINATION_REASON, CONTEXT_LAYER } = require('../runtime/agent/multi-agent-orchestrator');
const { ARCHITECTURE_PILLAR, CONSTRAINT_TYPE, ENTROPY_LEVEL } = require('../runtime/infrastructure/agent-architecture-orchestrator');
const { SANDBOX_STATUS, ISOLATION_LEVEL } = require('../runtime/infrastructure/container-sandbox-manager');
const { DECOMPOSITION_STRATEGY, SUBTASK_STATUS } = require('../runtime/workflow/task-decomposer');
const { AGGREGATION_STRATEGY } = require('../runtime/collaboration/result-aggregator');
const { parseFrontmatter, DEFAULT_FLUSH_INTERVAL_MS, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_FORCE_EXIT_MS, getHarnessConfigPath, UTF8_ENCODING, MAX_COMMENT_LENGTH, MAX_SUMMARY_LENGTH, MAX_API_LIST_ITEMS, MAX_DETAIL_LIST_ITEMS, DANGEROUS_KEYS } = require('../utils/constants');
const { HarnessError } = require('../errors');
const { t } = require('../utils/i18n');
const { debug } = require('../utils/debug-logger');
const { safeJsonParse } = require('../utils/safe-parse');
const { safeCall, safeExecuteAsync, safeStringify } = require('../utils/safe-execute');
const LRUCache = require('../utils/lru-cache');
const { secureId } = require('../utils/unique-id');
const C = require('./dashboard/constants');
const { ARCHITECTURE_DATA, FRAMEWORK_FEATURES_DATA, PANORAMA_METADATA } = require('./dashboard/constants/static-data');
const { _getPathname, _apiError, _wrapParams, _emptyParams, _sendError, _validateObjectDepth } = require('./dashboard/utils');
const { applyDeepeningMixin } = require('./dashboard/data-providers');
const { applyCoreQueryDataMixin } = require('./dashboard/data-providers/core-query-data');
const { getFrameworkStatus } = require('./dashboard/data-providers/framework-data');
const { getOverview, getAgents, getSkills, getSessions, getWorkflow } = require('./dashboard/data-providers/core-data');
const { getHealth, getLiveness, getReadiness, getPerformanceStats } = require('./dashboard/data-providers/health-data');
const { buildAllRoutes } = require('./dashboard/routes');
const Security = require('./dashboard/middleware/security');
const McpSecurity = require('./dashboard/middleware/mcp-security');
const ChangelogParser = require('./dashboard/changelog-parser');
const Validation = require('./dashboard/validation');
const eventRegistrar = require('../runtime/infrastructure/event-registrar');

const DEFAULT_DASHBOARD_PORT = C.DEFAULT_DASHBOARD_PORT;
const DEFAULT_DASHBOARD_HOST = C.DEFAULT_DASHBOARD_HOST;
const GRACEFUL_SHUTDOWN_TIMEOUT = C.GRACEFUL_SHUTDOWN_TIMEOUT;
const MAX_HTTP_CONNECTIONS = C.MAX_HTTP_CONNECTIONS;
const CACHE_TTL = C.CACHE_TTL;
const RATE_LIMIT_WINDOW = C.RATE_LIMIT_WINDOW;
const RATE_LIMIT_CLEANUP_INTERVAL = C.RATE_LIMIT_CLEANUP_INTERVAL;
const MAX_URL_LENGTH = C.MAX_URL_LENGTH;
const _MAX_PAGE_SIZE = C.MAX_PAGE_SIZE;
const MAX_CACHE_ENTRIES = C.MAX_CACHE_ENTRIES;
const LRU_FM_CACHE_SIZE = C.LRU_FM_CACHE_SIZE;
const LRU_FILE_CACHE_SIZE = C.LRU_FILE_CACHE_SIZE;
const LRU_DIR_CACHE_SIZE = C.LRU_DIR_CACHE_SIZE;
const MAX_ARGS_LENGTH = C.MAX_ARGS_LENGTH;
const REQUEST_TIMEOUT_MS = C.REQUEST_TIMEOUT_MS;
const _VALID_DEVIATION_STATUSES = C.VALID_DEVIATION_STATUSES;
const _VALID_REVIEW_STATUSES = C.VALID_REVIEW_STATUSES;
const JSON_CONTENT_TYPE = C.JSON_CONTENT_TYPE;
const RE_CHANGELOG_VERSION_SRC = C.RE_CHANGELOG_VERSION_SRC;
const RE_CHANGELOG_SECTION_SRC = C.RE_CHANGELOG_SECTION_SRC;
const _RE_CHANGELOG_VERSION = new RegExp(RE_CHANGELOG_VERSION_SRC, 'g');
const _RE_CHANGELOG_SECTION = new RegExp(RE_CHANGELOG_SECTION_SRC, 'g');
const MAX_LOCKS = C.MAX_LOCKS;
const HEALTH_MAX_LOCKS = C.HEALTH_MAX_LOCKS;
const HEALTH_MAX_CONFIRMATIONS = C.HEALTH_MAX_CONFIRMATIONS;
const _MAX_AGENT_HISTORY = C.MAX_AGENT_HISTORY;
const MAX_RESPONSE_TIME_SAMPLES = C.MAX_RESPONSE_TIME_SAMPLES;
const MAX_SKILL_ID_LENGTH = C.MAX_SKILL_ID_LENGTH;
const MAX_STRING_LENGTH = C.MAX_STRING_LENGTH;
const MAX_POST_CONTENT_LENGTH = C.MAX_POST_CONTENT_LENGTH;
const MAX_MCP_STDIO_BUFFER = C.MAX_MCP_STDIO_BUFFER;

const _sensitiveKeyPatterns = [
  /^(?:api[_-]?token|access[_-]?token|refresh[_-]?token|auth[_-]?token|csrf[_-]?token|session[_-]?token)$/i,
  /secret/i, /password/i, /api[_-]?key/i, /private[_-]?key/i,
  /auth/i, /credential/i, /connection[_-]?string/i, /database[_-]?url/i,
  /private/i, /db_url/i, /mongo/i, /redis/i, /jwt/i, /oauth/i,
  /s3/i, /aws/i, /gcs/i, /encryption/i, /ssh[_-]?key/i,
];

const _EVENT_STATE_KEY_MAP = {
  'subagent:spawned': 'subagentStats',
  'subagent:completed': 'subagentStats',
  'subagent:failed': 'subagentStats',
  'subagent:cancelled': 'subagentStats',
  'subagent:started': 'subagentStats',
  'subagent:retry': 'subagentStats',
  'session:created': 'sessions',
  'session:phase-change': 'sessions',
  'session:skill-complete': 'sessions',
  'session:budget-warning': 'sessions',
  'agent:state-change': 'agents',
  'agent:registered': 'agents',
  'agent:monitor-alert': 'agentMonitor',
  'agent:critical-alert': 'agentMonitor',
  'agent:created': 'agents',
  'agent:started': 'agents',
  'agent:stopped': 'agents',
  'agent:destroyed': 'agents',
  'agent:deployed': 'agents',
  'agent:deploy-failed': 'agents',
  'agent:task-submitted': 'agents',
  'agent:task-started': 'agents',
  'agent:task-failed': 'agents',
  'agent:resource-allocated': 'agents',
  'collaboration-mode:selected': 'collaborationMode',
  'structured-intent:parsed': 'structuredIntent',
  'skill-reducer:discovered': 'skillLayerStats',
  'skill-reducer:l2-loaded': 'skillLayerStats',
  'skill-reducer:l2-unloaded': 'skillLayerStats',
  'skill-reducer:l2-hit': 'skillLayerStats',
  'skill-reducer:l3-loaded': 'skillLayerStats',
  'skill-reducer:l3-unloaded': 'skillLayerStats',
  'skill-reducer:overload-detected': 'skillReducerStats',
  'skill-reducer:skills-activated': 'skillReducerStats',
  'skill-reducer:skills-deactivated': 'skillReducerStats',
  'generator-verifier:verification-complete': 'generatorVerifierStats',
  'isolated-context:created': 'isolatedContextStats',
  'isolated-context:result-submitted': 'isolatedContextStats',
  'plan-persistence:plan-created': 'planStats',
  'plan-persistence:plan-updated': 'planStats',
  'pair-chat:session-started': 'pairChatStats',
  'pair-chat:consensus-reached': 'pairChatStats',
  'pair-chat:consensus-failed': 'pairChatStats',
  'pair-chat:round-completed': 'pairChatStats',
  'pair-chat:session-destroyed': 'pairChatStats',
  'pair-chat:cross-validation-started': 'pairChatStats',
  'pair-chat:hallucination-detected': 'pairChatStats',
  'pair-chat:cross-validation-completed': 'pairChatStats',
  'chat-chain:chain-created': 'chatChainStats',
  'chat-chain:chain-completed': 'chatChainStats',
  'chat-chain:chain-failed': 'chatChainStats',
  'chat-chain:task-started': 'chatChainStats',
  'chat-chain:task-completed': 'chatChainStats',
  'chat-chain:task-failed': 'chatChainStats',
  'chat-chain:task-skipped': 'chatChainStats',
  'chat-chain:artifact-registered': 'chatChainStats',
  'chat-chain:artifact-versioned': 'chatChainStats',
  'dev-metrics:project-started': 'devMetricsStats',
  'dev-metrics:project-completed': 'devMetricsStats',
  'dev-metrics:phase-started': 'devMetricsStats',
  'dev-metrics:phase-completed': 'devMetricsStats',
  'dev-metrics:hallucination-corrected': 'devMetricsStats',
  'commands:discovered': 'commandRouterStats',
  'hook:registered': 'programmableHookStats',
  'hook:unregistered': 'programmableHookStats',
  'hook:executed': 'programmableHookStats',
  'hook:error': 'programmableHookStats',
  'compression:complete': 'contextCompressionStats',
};

const _DEEPENING_EVENT_RULES = [
  { suffix: 'pipeline-complete', key: 'deepeningPipeline' },
  { suffix: 'cache-hit', key: 'deepeningCache' },
  { suffix: 'cache-stored', key: 'deepeningCache' },
  { suffix: 'circuit-state-change', key: 'deepeningCircuitBreaker' },
  { suffix: 'rate-limited', key: 'deepeningCircuitBreaker' },
  { suffix: 'state-transition', key: 'deepeningStateManager' },
  { suffix: 'orchestrated', key: 'deepeningDashboard' },
  { suffix: 'convergence', key: 'deepeningConvergence' },
  { suffix: 'metric', key: 'deepeningMetricsAggregator' },
  { suffix: 'health-checked', key: 'deepeningHealthMonitor' },
  { suffix: 'event-recorded', key: 'deepeningEventReplay' },
  { suffix: 'snapshot-created', key: 'deepeningEventReplay' },
  { suffix: 'audit-recorded', key: 'deepeningEventReplay' },
  { suffix: 'template-registered', key: 'deepeningRegistryStats' },
  { suffix: 'config-changed', key: 'deepeningRegistryStats' },
];

async function _scanMarkdownDir(dirPath) {
  const result = await safeExecuteAsync(async () => {
    await fs.promises.access(dirPath);
    const files = await fs.promises.readdir(dirPath);
    return { exists: true, count: files.filter(function(f) { return f.endsWith('.md'); }).length };
  }, 'Dashboard', 'scanDirError', { exists: false, count: 0 });
  return result;
}

function _validateRequiredString(body, fieldName, maxLen) {
  const value = body[fieldName];
  if (!value || typeof value !== 'string') {
    return { _status: 400, _data: { error: fieldName + ' (string) required' } };
  }
  const limit = maxLen ?? MAX_STRING_LENGTH;
  if (value.length > limit) {
    return { _status: 400, _data: { error: fieldName + ' exceeds maximum length' } };
  }
  return null;
}

function _validateOptionalString(value, fieldName, maxLen) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    return { _status: 400, _data: { error: fieldName + ' must be a string' } };
  }
  const limit = maxLen ?? MAX_STRING_LENGTH;
  if (value.length > limit) {
    return { _status: 400, _data: { error: fieldName + ' exceeds maximum length' } };
  }
  return null;
}

function _validateGoalId(body) {
  if (!body.goalId || typeof body.goalId !== 'string' || !_VALID_GOAL_ID_RE.test(body.goalId)) {
    return { _status: 400, _data: { error: 'Invalid goalId format' } };
  }
  return null;
}

function _validatePathSafety(value, fieldName) {
  if (path.isAbsolute(value) || /\.\./.test(value) || value.includes('\0') || /[\\/]/.test(value)) {
    return { _status: 400, _data: { error: fieldName + ' contains invalid path traversal' } };
  }
  return null;
}

function _validateIdFormat(value, fieldName) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    return { _status: 400, _data: { error: fieldName + ' contains invalid characters' } };
  }
  return null;
}

function _validateNumberRange(value, fieldName, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { _status: 400, _data: { error: fieldName + ' must be a number' } };
  }
  if (value < min || value > max) {
    return { _status: 400, _data: { error: fieldName + ' must be between ' + min + ' and ' + max } };
  }
  return null;
}

function _requireModule(self, moduleName, displayName) {
  const mod = self._rt(moduleName);
  if (!mod) return { _mod: null, _err: self._moduleUnavailable(displayName + ' not available') };
  return { _mod: mod, _err: null };
}

const _VALID_GOAL_ID_RE = /^goal-[a-zA-Z0-9-]+$/;
const _VALID_WORKFLOW_MODES = new Set(['STANDARD', 'ARCHITECTURE_FIRST', 'AI_WRITE_TEST_FIX', 'HUMAN_REVIEW_DECIDE']);
const _VALID_MEDIA_MODES = new Set(['generate', 'imageToVideo', 'videoToVideo']);

const _HEALTH_PATHS = new Set(['/api/health', '/healthz', '/readyz']);

/**
 * @module web/server
 * 核心HTTP服务器。210+ API端点、CSP nonce、速率限制，
 * 集成WebSocket实时通信、静态文件服务、压缩响应和Dashboard后端模块。
 */

/**
 * Dashboard服务器。核心HTTP服务器，提供210+ API端点、CSP nonce安全头、速率限制，
 * 集成WebSocket实时通信、静态文件服务、HTTP压缩和Dashboard后端模块。
 * 支持动态路由、缓存管理、运行时事件桥接和优雅关闭。
 *
 * @example
 * const server = new DashboardServer('/path/to/project', 3210, runtimeInstance);
 * await server.start();
 * server.stop();
 */

/**
 * Dashboard HTTP服务器。250+ API端点、CSP nonce、速率限制、
 * Webhook端点(/api/webhook/*, HMAC签名验证)、静态文件服务、
 * WebSocket实时通信、压缩(brotli>gzip>deflate)。
 *
 * @classdesc Dashboard HTTP服务器核心。_handleApi(GET路由)/_handlePostApi(POST路由)/
 * _handleWebhook(HMAC签名验证)/_buildConversationRoutes(对话管理)/
 * _buildChatRoutes(聊天交互)/_buildTerminalRoutes(安全终端)/
 * _buildFileBrowserRoutes(文件浏览器)/_buildSkillRoutes(技能管理)等路由构建器。
 */
class DashboardServer {
  /**
   * 创建DashboardServer实例。
   * @param {string} projectRoot - 项目根目录路径
   * @param {number} [port] - 服务器端口号
   * @param {Object} [runtimeInstance] - 运行时实例，提供各模块的共享引用
   */
  constructor(projectRoot, port, runtimeInstance) {
    if (!projectRoot || typeof projectRoot !== 'string') {
      throw new HarnessError('INVALID_INPUT', 'projectRoot is required and must be a string');
    }
    this.root = projectRoot;
    this.port = (port != null) ? port : (function() {
      const envPort = parseInt(process.env.HARNESS_DASHBOARD_PORT, 10);
      return (Number.isFinite(envPort) && envPort > 0 && envPort <= 65535) ? envPort : DEFAULT_DASHBOARD_PORT;
    })();
    this.server = null;
    this._cache = new Map();
    this._staticRoutes = this._buildApiRoutes();
    this._dynamicRouteMap = this._buildDynamicRouteMap();
    this._dynamicRouteKeys = new Set(Object.keys(this._dynamicRouteMap));
    this._rateLimitMap = new Map();
    this._sensitiveRateMap = new Map();
    this._postRoutes = null;
    const rawToken = (process.env.HARNESS_API_TOKEN && process.env.HARNESS_API_TOKEN.trim()) || null;
    this._apiToken = rawToken;
    this._apiTokenHash = rawToken ? crypto.createHash('sha256').update(rawToken).digest('hex') : null;
    this._devMode = process.env.NODE_ENV === 'development';
    this._host = process.env.HARNESS_DASHBOARD_HOST || DEFAULT_DASHBOARD_HOST;
    this._allowDevBypass = false;
    this._archive = new ChangelogArchive(projectRoot);
    this._allowedOriginsSet = new Set(this._getAllowedOrigins());
    this._ws = new WebSocketHandler({ allowedOrigins: this._getAllowedOrigins(), authToken: rawToken });
    this._runtime = runtimeInstance ?? null;
    this._fmCache = new LRUCache(LRU_FM_CACHE_SIZE);
    this._fileCache = new LRUCache(LRU_FILE_CACHE_SIZE);
    this._dirCache = new LRUCache(LRU_DIR_CACHE_SIZE);
    this._fileCacheTTL = 2000;
    this._serverConfig = null;
    this._memoryStore = this._runtime ? this._runtime.memoryStore : new MemoryStore(projectRoot);
    this._checkpointManager = this._runtime ? this._runtime.checkpointManager : new CheckpointManager(projectRoot);
    this._skillImprover = this._runtime ? this._runtime.skillImprover : new SkillImprover(projectRoot);
    this._workflowTemplate = this._runtime ? this._runtime.workflowTemplate : new WorkflowTemplate(projectRoot);
    this._complianceChecker = this._runtime ? this._runtime.complianceChecker : new FrameworkComplianceChecker(projectRoot);
    this._deviationApproval = this._runtime ? this._runtime.deviationApproval : new DeviationApproval(projectRoot);
    this._codeReviewCheck = this._runtime ? this._runtime.codeReviewCheck : new CodeReviewFrameworkCheck(projectRoot);
    this._designEngine = new DesignSkillEngine(projectRoot);
    this._approvalGate = new HumanApprovalGate({ timeout: C.APPROVAL_GATE_TIMEOUT });
    this._rateLimitCleanupTimer = null;
    this._startTime = Date.now();
    this._cacheCleanupTimer = null;
    this._skillDistiller = null;
    this._skillEffectivenessOptimizer = null;
    this._mediaProviderRouter = null;
    this._dynamicWorkflowEngine = null;
    this._multiAgentOrchestrator = null;
    this._agentArchitectureOrchestrator = null;
    this._containerSandboxManager = null;
    this._taskDecomposer = null;
    this._resultAggregator = null;
  }

  _getAllowedOrigins() {
    const host = process.env.HARNESS_DASHBOARD_HOST || DEFAULT_DASHBOARD_HOST;
    const origins = [
      'http://' + host + ':' + this.port,
      'http://127.0.0.1:' + this.port,
    ];
    if (process.env.HARNESS_DASHBOARD_ORIGIN) {
      const envOrigin = process.env.HARNESS_DASHBOARD_ORIGIN;
      if (/^https?:\/\/[^\s]+$/.test(envOrigin)) {
        origins.push(envOrigin);
      } else {
        debug('Dashboard', 'invalidOrigin', 'HARNESS_DASHBOARD_ORIGIN must be a valid http(s) URL, got: ' + envOrigin);
      }
    }
    if (this.port === 443 || process.env.HARNESS_TLS_CERT) {
      origins.push('https://' + host + ':' + this.port);
      origins.push('https://' + host);
      origins.push('https://127.0.0.1:' + this.port);
    }
    return origins;
  }

  setSkillDistiller(distiller) {
    this._skillDistiller = distiller ?? null;
  }

  setSkillEffectivenessOptimizer(optimizer) {
    this._skillEffectivenessOptimizer = optimizer ?? null;
  }

  setOpportunityDiscoveryPipeline(pipeline) {
    this._opportunityDiscoveryPipeline = pipeline ?? null;
  }

  setAiDeveloperAnalytics(analytics) {
    this._aiDeveloperAnalytics = analytics ?? null;
  }

  setMediaProviderRouter(router) {
    this._mediaProviderRouter = router ?? null;
  }

  _getSkillDistillationStatus() {
    try {
      const distiller = this._skillDistiller;
      if (!distiller) return { available: false, initialized: false, message: 'SkillDistiller not initialized' };
      if (typeof distiller.getStats !== 'function') return { available: false, initialized: true, message: 'SkillDistiller missing getStats method' };
      const stats = distiller.getStats();
      return {
        available: true,
        initialized: true,
        traces: typeof stats.traces === 'number' && Number.isFinite(stats.traces) ? stats.traces : 0,
        distillations: typeof stats.distillations === 'number' && Number.isFinite(stats.distillations) ? stats.distillations : 0,
        stats: stats,
      };
    } catch (_err) {
      debug('Dashboard', '_getSkillDistillationStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, initialized: false, message: 'SkillDistillation status check failed' };
    }
  }

  _getSkillDistillationHistory() {
    try {
      const distiller = this._skillDistiller;
      if (!distiller) return { available: false, history: [], message: 'SkillDistiller not initialized' };
      if (typeof distiller.getDistillationHistory !== 'function') return { available: false, history: [], message: 'SkillDistiller missing getDistillationHistory method' };
      const history = distiller.getDistillationHistory();
      if (!Array.isArray(history)) return { available: true, history: [] };
      return { available: true, history: history.slice(0, 50) };
    } catch (_err) {
      debug('Dashboard', '_getSkillDistillationHistory', _err && _err.message ? _err.message : String(_err));
      return { available: false, history: [], message: 'SkillDistillation history check failed' };
    }
  }

  _getSkillDistillationTraces() {
    try {
      const distiller = this._skillDistiller;
      if (!distiller) return { available: false, traces: [], message: 'SkillDistiller not initialized' };
      if (typeof distiller.getRecentTraces !== 'function') return { available: false, traces: [], message: 'SkillDistiller missing getRecentTraces method' };
      const traces = distiller.getRecentTraces();
      if (!Array.isArray(traces)) return { available: true, traces: [] };
      return { available: true, traces: traces.slice(0, 100) };
    } catch (_err) {
      debug('Dashboard', '_getSkillDistillationTraces', _err && _err.message ? _err.message : String(_err));
      return { available: false, traces: [], message: 'SkillDistillation traces check failed' };
    }
  }

  _getSkillEffectivenessStatus() {
    try {
      const optimizer = this._skillEffectivenessOptimizer;
      if (!optimizer) return { available: false, initialized: false, message: 'SkillEffectivenessOptimizer not initialized' };
      if (typeof optimizer.getStats !== 'function') return { available: false, initialized: true, message: 'SkillEffectivenessOptimizer missing getStats method' };
      const stats = optimizer.getStats();
      return {
        available: true,
        initialized: true,
        maxActiveSkills: typeof stats.maxActiveSkills === 'number' && Number.isFinite(stats.maxActiveSkills) ? stats.maxActiveSkills : 12,
        currentActiveSkills: typeof stats.currentActiveSkills === 'number' && Number.isFinite(stats.currentActiveSkills) ? stats.currentActiveSkills : 0,
        adaptiveTopK: typeof stats.adaptiveTopK === 'boolean' ? stats.adaptiveTopK : true,
        currentTopK: typeof stats.currentTopK === 'number' && Number.isFinite(stats.currentTopK) ? stats.currentTopK : 5,
        stats: stats,
      };
    } catch (_err) {
      debug('Dashboard', '_getSkillEffectivenessStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, initialized: false, message: 'SkillEffectiveness status check failed' };
    }
  }

  _getSkillEffectivenessAccuracy() {
    try {
      const optimizer = this._skillEffectivenessOptimizer;
      if (!optimizer) return { available: false, message: 'SkillEffectivenessOptimizer not initialized' };
      if (typeof optimizer.getAccuracyMetrics !== 'function') return { available: false, message: 'SkillEffectivenessOptimizer missing getAccuracyMetrics method' };
      const metrics = optimizer.getAccuracyMetrics();
      return {
        available: true,
        precision: typeof metrics.precision === 'number' && Number.isFinite(metrics.precision) ? metrics.precision : 0,
        recall: typeof metrics.recall === 'number' && Number.isFinite(metrics.recall) ? metrics.recall : 0,
        f1: typeof metrics.f1 === 'number' && Number.isFinite(metrics.f1) ? metrics.f1 : 0,
        falsePositiveRate: typeof metrics.falsePositiveRate === 'number' && Number.isFinite(metrics.falsePositiveRate) ? metrics.falsePositiveRate : 0,
        totalInvocations: typeof metrics.totalInvocations === 'number' && Number.isFinite(metrics.totalInvocations) ? metrics.totalInvocations : 0,
        correctInvocations: typeof metrics.correctInvocations === 'number' && Number.isFinite(metrics.correctInvocations) ? metrics.correctInvocations : 0,
      };
    } catch (_err) {
      debug('Dashboard', '_getSkillEffectivenessAccuracy', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'SkillEffectiveness accuracy check failed' };
    }
  }

  _getSkillEffectivenessOverload() {
    try {
      const optimizer = this._skillEffectivenessOptimizer;
      if (!optimizer) return { available: false, message: 'SkillEffectivenessOptimizer not initialized' };
      if (typeof optimizer.getOverloadStatus !== 'function') return { available: false, message: 'SkillEffectivenessOptimizer missing getOverloadStatus method' };
      const overload = optimizer.getOverloadStatus();
      return {
        available: true,
        isOverloaded: typeof overload.isOverloaded === 'boolean' ? overload.isOverloaded : false,
        activeSkillCount: typeof overload.activeSkillCount === 'number' && Number.isFinite(overload.activeSkillCount) ? overload.activeSkillCount : 0,
        maxActiveSkills: typeof overload.maxActiveSkills === 'number' && Number.isFinite(overload.maxActiveSkills) ? overload.maxActiveSkills : 12,
        contextTokenUsage: typeof overload.contextTokenUsage === 'number' && Number.isFinite(overload.contextTokenUsage) ? overload.contextTokenUsage : 0,
        contextTokenBudget: typeof overload.contextTokenBudget === 'number' && Number.isFinite(overload.contextTokenBudget) ? overload.contextTokenBudget : 8000,
      };
    } catch (_err) {
      debug('Dashboard', '_getSkillEffectivenessOverload', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'SkillEffectiveness overload check failed' };
    }
  }

  _getOpportunityDiscoveryStatus() {
    try {
      const pipeline = this._opportunityDiscoveryPipeline;
      if (!pipeline) return { available: false, initialized: false, message: 'OpportunityDiscoveryPipeline not initialized' };
      if (typeof pipeline.getStats !== 'function') return { available: false, initialized: true, message: 'OpportunityDiscoveryPipeline missing getStats method' };
      const stats = pipeline.getStats();
      return {
        available: true,
        initialized: true,
        painPointsScanned: typeof stats.painPointsScanned === 'number' && Number.isFinite(stats.painPointsScanned) ? stats.painPointsScanned : 0,
        competitiveGapsAnalyzed: typeof stats.competitiveGapsAnalyzed === 'number' && Number.isFinite(stats.competitiveGapsAnalyzed) ? stats.competitiveGapsAnalyzed : 0,
        productLensValidated: typeof stats.productLensValidated === 'number' && Number.isFinite(stats.productLensValidated) ? stats.productLensValidated : 0,
        stats: stats,
      };
    } catch (_err) {
      debug('Dashboard', '_getOpportunityDiscoveryStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, initialized: false, message: 'OpportunityDiscovery status check failed' };
    }
  }

  _getOpportunityDiscoveryPainPoints() {
    try {
      const pipeline = this._opportunityDiscoveryPipeline;
      if (!pipeline) return { available: false, painPoints: [], message: 'OpportunityDiscoveryPipeline not initialized' };
      if (typeof pipeline.getPainPoints !== 'function') return { available: false, painPoints: [], message: 'OpportunityDiscoveryPipeline missing getPainPoints method' };
      const painPoints = pipeline.getPainPoints();
      if (!Array.isArray(painPoints)) return { available: true, painPoints: [] };
      return { available: true, painPoints: painPoints.slice(0, 100) };
    } catch (_err) {
      debug('Dashboard', '_getOpportunityDiscoveryPainPoints', _err && _err.message ? _err.message : String(_err));
      return { available: false, painPoints: [], message: 'OpportunityDiscovery pain points check failed' };
    }
  }

  _getOpportunityDiscoveryCompetitors() {
    try {
      const pipeline = this._opportunityDiscoveryPipeline;
      if (!pipeline) return { available: false, competitors: [], message: 'OpportunityDiscoveryPipeline not initialized' };
      if (typeof pipeline.getCompetitors !== 'function') return { available: false, competitors: [], message: 'OpportunityDiscoveryPipeline missing getCompetitors method' };
      const competitors = pipeline.getCompetitors();
      if (!Array.isArray(competitors)) return { available: true, competitors: [] };
      return { available: true, competitors: competitors.slice(0, 100) };
    } catch (_err) {
      debug('Dashboard', '_getOpportunityDiscoveryCompetitors', _err && _err.message ? _err.message : String(_err));
      return { available: false, competitors: [], message: 'OpportunityDiscovery competitors check failed' };
    }
  }

  _getOpportunityDiscoveryProductLens() {
    try {
      const pipeline = this._opportunityDiscoveryPipeline;
      if (!pipeline) return { available: false, validations: [], message: 'OpportunityDiscoveryPipeline not initialized' };
      if (typeof pipeline.getProductLensResults !== 'function') return { available: false, validations: [], message: 'OpportunityDiscoveryPipeline missing getProductLensResults method' };
      const validations = pipeline.getProductLensResults();
      if (!Array.isArray(validations)) return { available: true, validations: [] };
      return { available: true, validations: validations.slice(0, 100) };
    } catch (_err) {
      debug('Dashboard', '_getOpportunityDiscoveryProductLens', _err && _err.message ? _err.message : String(_err));
      return { available: false, validations: [], message: 'OpportunityDiscovery product lens check failed' };
    }
  }

  _getAnalyticsDashboard() {
    try {
      const analytics = this._aiDeveloperAnalytics;
      if (!analytics) return { available: false, initialized: false, message: 'AiDeveloperAnalytics not initialized' };
      if (typeof analytics.getDashboardData !== 'function') return { available: false, initialized: true, message: 'AiDeveloperAnalytics missing getDashboardData method' };
      const data = analytics.getDashboardData();
      return {
        available: true,
        initialized: true,
        metricsCollected: typeof data.metricsCollected === 'number' && Number.isFinite(data.metricsCollected) ? data.metricsCollected : 0,
        experimentsActive: typeof data.experimentsActive === 'number' && Number.isFinite(data.experimentsActive) ? data.experimentsActive : 0,
        bottlenecksDetected: typeof data.bottlenecksDetected === 'number' && Number.isFinite(data.bottlenecksDetected) ? data.bottlenecksDetected : 0,
        anomaliesDetected: typeof data.anomaliesDetected === 'number' && Number.isFinite(data.anomaliesDetected) ? data.anomaliesDetected : 0,
        data: data,
      };
    } catch (_err) {
      debug('Dashboard', '_getAnalyticsDashboard', _err && _err.message ? _err.message : String(_err));
      return { available: false, initialized: false, message: 'AiDeveloperAnalytics dashboard check failed' };
    }
  }

  _getAnalyticsExperiments() {
    try {
      const analytics = this._aiDeveloperAnalytics;
      if (!analytics) return { available: false, experiments: [], message: 'AiDeveloperAnalytics not initialized' };
      if (typeof analytics.getExperiments !== 'function') return { available: false, experiments: [], message: 'AiDeveloperAnalytics missing getExperiments method' };
      const experiments = analytics.getExperiments();
      if (!Array.isArray(experiments)) return { available: true, experiments: [] };
      return { available: true, experiments: experiments.slice(0, 100) };
    } catch (_err) {
      debug('Dashboard', '_getAnalyticsExperiments', _err && _err.message ? _err.message : String(_err));
      return { available: false, experiments: [], message: 'AiDeveloperAnalytics experiments check failed' };
    }
  }

  _getAnalyticsBottlenecks() {
    try {
      const analytics = this._aiDeveloperAnalytics;
      if (!analytics) return { available: false, bottlenecks: [], message: 'AiDeveloperAnalytics not initialized' };
      if (typeof analytics.getBottlenecks !== 'function') return { available: false, bottlenecks: [], message: 'AiDeveloperAnalytics missing getBottlenecks method' };
      const bottlenecks = analytics.getBottlenecks();
      if (!Array.isArray(bottlenecks)) return { available: true, bottlenecks: [] };
      return { available: true, bottlenecks: bottlenecks.slice(0, 100) };
    } catch (_err) {
      debug('Dashboard', '_getAnalyticsBottlenecks', _err && _err.message ? _err.message : String(_err));
      return { available: false, bottlenecks: [], message: 'AiDeveloperAnalytics bottlenecks check failed' };
    }
  }

  _getAnalyticsAnomalies() {
    try {
      const analytics = this._aiDeveloperAnalytics;
      if (!analytics) return { available: false, anomalies: [], message: 'AiDeveloperAnalytics not initialized' };
      if (typeof analytics.getAnomalies !== 'function') return { available: false, anomalies: [], message: 'AiDeveloperAnalytics missing getAnomalies method' };
      const anomalies = analytics.getAnomalies();
      if (!Array.isArray(anomalies)) return { available: true, anomalies: [] };
      return { available: true, anomalies: anomalies.slice(0, 100) };
    } catch (_err) {
      debug('Dashboard', '_getAnalyticsAnomalies', _err && _err.message ? _err.message : String(_err));
      return { available: false, anomalies: [], message: 'AiDeveloperAnalytics anomalies check failed' };
    }
  }

  _getMediaProvidersStatus() {
    try {
      const router = this._mediaProviderRouter;
      if (!router) return { available: false, message: 'MediaProviderRouter not initialized' };
      const stats = typeof router.getStats === 'function' ? router.getStats() : {};
      const providers = typeof router.getProviders === 'function' ? router.getProviders() : [];
      const providerStatuses = providers.map(function(p) {
        return {
          name: p.name || 'unknown',
          connected: typeof p.isConnected === 'function' ? p.isConnected() : false,
          capabilities: typeof p.getCapabilities === 'function' ? p.getCapabilities() : {},
        };
      });
      return {
        available: true,
        providerCount: providers.length,
        strategy: stats.strategy || 'unknown',
        totalRouted: typeof stats.totalRouted === 'number' ? stats.totalRouted : 0,
        fallbacks: typeof stats.fallbacks === 'number' ? stats.fallbacks : 0,
        providers: providerStatuses,
      };
    } catch (_err) {
      debug('Dashboard', '_getMediaProvidersStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'MediaProviders status check failed' };
    }
  }

  _getMediaProvidersList() {
    try {
      const router = this._mediaProviderRouter;
      if (!router) return { available: false, providers: [], message: 'MediaProviderRouter not initialized' };
      const providers = typeof router.getProviders === 'function' ? router.getProviders() : [];
      const list = providers.map(function(p) {
        const caps = typeof p.getCapabilities === 'function' ? p.getCapabilities() : {};
        return {
          name: p.name || 'unknown',
          connected: typeof p.isConnected === 'function' ? p.isConnected() : false,
          modes: Array.isArray(caps.modes) ? caps.modes : [],
          maxDuration: typeof caps.maxDuration === 'number' ? caps.maxDuration : 0,
          maxResolution: typeof caps.maxResolution === 'string' ? caps.maxResolution : '',
        };
      });
      return { available: true, providers: list };
    } catch (_err) {
      debug('Dashboard', '_getMediaProvidersList', _err && _err.message ? _err.message : String(_err));
      return { available: false, providers: [], message: 'MediaProviders list check failed' };
    }
  }

  async _getMediaProviderTaskStatus(taskId) {
    try {
      const router = this._mediaProviderRouter;
      if (!router) return { available: false, message: 'MediaProviderRouter not initialized' };
      const providers = typeof router.getProviders === 'function' ? router.getProviders() : [];
      for (const provider of providers) {
        if (typeof provider.getTaskStatus === 'function') {
          try {
            const status = await provider.getTaskStatus(taskId);
            if (status) return { available: true, taskId: taskId, status: status, provider: provider.name };
          } catch (_e) { debug('Server', 'checkProviderStatus', _e && _e.message ? _e.message : String(_e)); }
        }
      }
      return { available: true, taskId: taskId, status: null, message: 'Task not found in any provider' };
    } catch (_err) {
      debug('Dashboard', '_getMediaProviderTaskStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, taskId: taskId, message: 'MediaProvider task status check failed' };
    }
  }

  _buildMediaProviderRoutes(self, _validateStringLength) {
    return {
      '/api/media-providers/generate': (body) => {
        const router = self._mediaProviderRouter;
        if (!router) return { _status: 503, _data: { error: 'MediaProviderRouter not available' } };
        if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
          return { _status: 400, _data: { error: 'prompt is required and must be a non-empty string' } };
        }
        const promptErr = _validateStringLength(body.prompt, 'prompt');
        if (promptErr) return { _status: 400, _data: { error: promptErr } };
        const request = { prompt: body.prompt.trim() };
        if (typeof body.mode === 'string') {
          if (!_VALID_MEDIA_MODES.has(body.mode)) return { _status: 400, _data: { error: 'Invalid mode. Must be one of: ' + Array.from(_VALID_MEDIA_MODES).join(', ') } };
          request.mode = body.mode;
        }
        if (body.options && typeof body.options === 'object') request.options = body.options;
        return router.route(request);
      },
    };
  }


  /**
   * 启动HTTP服务器，创建WebSocket处理器，桥接运行时事件。
   * @param {Function} [callback] - 服务器启动完成后的回调函数
   * @returns {Promise<DashboardServer>} 服务器启动成功后返回自身实例
   */
  start(callback) {
    this._resetExistingServer();
    this._allowedOriginsSet = new Set(this._getAllowedOrigins());
    this._ws = new WebSocketHandler({ allowedOrigins: this._getAllowedOrigins(), authToken: this._apiToken });
    this._fmCache = new LRUCache(500);
    this._postRoutes = null;
    this._createHttpServer();
    this._setupConnectionTracking();
    this._setupWebSocketUpgrade();
    this._setupServerCloseEvents();
    return this._startServer(callback);
  }

  _resetExistingServer() {
    if (this._ws) {
      safeCall(() => this._ws.close(), 'Dashboard', 'wsClose');
    }
    if (this.server) {
      safeCall(() => this.server.close(), 'Dashboard', 'serverClose');
    }
  }

  _createHttpServer() {
    this.server = http.createServer((req, res) => {
      Promise.resolve().then(() => this._handle(req, res)).catch((err) => {
        debug('Dashboard', 'unhandledRejection', err);
        if (!res.headersSent) _sendError(res, 500, 'Internal server error', undefined, Security.getCorsOrigin(req, this._allowedOriginsSet));
        else if (!res.writableEnded) { safeCall(() => res.end(), 'Dashboard', 'endAfterReject'); }
      });
    });
    this.server.keepAliveTimeout = C.HTTP_KEEP_ALIVE_TIMEOUT;
    this.server.headersTimeout = C.HTTP_HEADERS_TIMEOUT;
    this.server.requestTimeout = C.HTTP_REQUEST_TIMEOUT;
  }

  _setupConnectionTracking() {
    this._connections = new Set();
    this.server.on('connection', (socket) => {
      if (this._connections.size >= MAX_HTTP_CONNECTIONS) {
        debug('Dashboard', 'maxConnections', 'Rejecting connection: max concurrent connections reached');
        socket.destroy();
        return;
      }
      this._connections.add(socket);
      socket.setTimeout(C.SOCKET_TIMEOUT);
      socket.on('timeout', () => { socket.destroy(); });
      socket.on('close', () => {
        this._connections.delete(socket);
      });
    });
  }

  _setupWebSocketUpgrade() {
    if (this._wsUpgradeByIp) {
      this._wsUpgradeByIp.clear();
    } else {
      this._wsUpgradeByIp = new Map();
    }
    if (this._wsUpgradeCleanupTimer) {
      clearInterval(this._wsUpgradeCleanupTimer);
      this._wsUpgradeCleanupTimer = null;
    }
    const _wsUpgradeByIp = this._wsUpgradeByIp;
    const WS_UPGRADE_LIMIT = 30;
    const WS_UPGRADE_WINDOW = 60000;
    const _wsUpgradeCleanup = setInterval(() => {
      const now = Date.now();
      const expiredIps = [];
      for (const [ip, bucket] of _wsUpgradeByIp) {
        if (now - bucket.windowStart > WS_UPGRADE_WINDOW * 2) expiredIps.push(ip);
      }
      for (const ip of expiredIps) _wsUpgradeByIp.delete(ip);
    }, WS_UPGRADE_WINDOW);
    if (typeof _wsUpgradeCleanup.unref === 'function') _wsUpgradeCleanup.unref();
    this._wsUpgradeCleanupTimer = _wsUpgradeCleanup;
    this.server.on('upgrade', (req, socket, head) => {
      const wsPath = _getPathname(req);
      if (wsPath === '/ws') {
        const ip = Security.getClientIp(req, this._serverConfig);
        const now = Date.now();
        let bucket = _wsUpgradeByIp.get(ip);
        if (!bucket || now - bucket.windowStart > WS_UPGRADE_WINDOW) {
          bucket = { count: 0, windowStart: now };
          if (_wsUpgradeByIp.size >= 10000) {
            const oldestIp = _wsUpgradeByIp.keys().next().value;
            if (oldestIp !== undefined) _wsUpgradeByIp.delete(oldestIp);
          }
          _wsUpgradeByIp.set(ip, bucket);
        }
        bucket.count++;
        if (bucket.count > WS_UPGRADE_LIMIT) {
          debug('Dashboard', 'wsUpgradeRateLimit', 'IP ' + ip + ' exceeded ' + WS_UPGRADE_LIMIT + ' upgrades/min');
          socket.write('HTTP/1.1 429 Too Many Requests\r\nX-Content-Type-Options: nosniff\r\n\r\n');
          socket.destroy();
          return;
        }
        if (!this._validateWsOrigin(req, socket)) return;
        this._ws.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
  }

  _validateWsOrigin(req, socket) {
    const wsOrigin = req.headers.origin;
    if (wsOrigin && this._allowedOriginsSet && this._allowedOriginsSet.size > 0 && !this._allowedOriginsSet.has(wsOrigin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n\r\n');
      socket.destroy();
      return false;
    }
    if (!wsOrigin) {
      const clientIp = req.socket && req.socket.remoteAddress;
      const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1' || clientIp === 'localhost';
      if (!isLocal) {
        socket.write('HTTP/1.1 403 Forbidden\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n\r\n');
        socket.destroy();
        return false;
      }
    }
    return true;
  }

  _validateWsAuth(req, socket) {
    if (!this._apiTokenHash) return true;
    const wsProtocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(function(s) { return s.trim(); });
    const bearerProto = wsProtocols.find(function(p) { return p.startsWith('bearer-'); });
    const wsProtocol = bearerProto ? bearerProto.slice('bearer-'.length) : '';
    if (!wsProtocol) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n\r\n');
      socket.destroy();
      return false;
    }
    const tokenHash = crypto.createHash('sha256').update(wsProtocol, UTF8_ENCODING).digest('hex');
    try {
      const a = Buffer.from(tokenHash, 'hex');
      const b = Buffer.from(this._apiTokenHash, 'hex');
      if (a.length !== b.length) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n\r\n');
        socket.destroy();
        return false;
      }
      if (!crypto.timingSafeEqual(a, b)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n\r\n');
        socket.destroy();
        return false;
      }
    } catch (_e) {
      debug('Dashboard', '_validateApiToken', 'Token validation error: ' + (_e && _e.message ? _e.message : String(_e)));
      socket.write('HTTP/1.1 401 Unauthorized\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n\r\n');
      socket.destroy();
      return false;
    }
    return true;
  }

  _setupServerCloseEvents() {
    this.server.on('close', () => {
      this._cache = new Map();
      this._fmCache = new LRUCache(500);
      this._fileCache = new LRUCache(200);
      this._dirCache = new LRUCache(200);
      this._rateLimitMap.clear();
      this._sensitiveRateMap.clear();
      this._stopCleanupTimers();
    });
  }

  _startServer(callback) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const host = process.env.HARNESS_BIND_ADDRESS || DEFAULT_DASHBOARD_HOST;
      this.server.listen(this.port, host, () => {
        (async () => {
          try {
            const addr = this.server.address();
            this.port = addr ? addr.port : this.port;
            this._serverConfig = await this._loadServerConfig();
            debug('Dashboard', 'start', '多Agent框架控制台: http://' + host + ':' + this.port);
            if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
              debug('Dashboard', 'SECURITY_WARNING', 'Server binding to non-localhost address: ' + host + '. Ensure authentication is properly configured.');
              Security.setServerBindingLocalhost(false);
            } else {
              Security.setServerBindingLocalhost(true);
            }

            this._applyDevBypassConfig();
            this._startCleanupTimers();
            this._bridgeRuntimeEvents();

            if (!settled) { settled = true; resolve(this); }

            if (typeof callback === 'function') callback();
          } catch (startErr) {
            debug('Dashboard', 'startError', startErr);
            try { this.server.close(); } catch (closeErr) { debug('Dashboard', 'startCloseError', closeErr); }
            if (this._wsUpgradeCleanupTimer) { clearInterval(this._wsUpgradeCleanupTimer); this._wsUpgradeCleanupTimer = null; }
            if (this._ws && typeof this._ws.close === 'function') {
              safeCall(() => this._ws.close(), 'Dashboard', 'startErrorWs');
            }
            if (!settled) { settled = true; reject(startErr); }
          }
        })();
      });

      this.server.on('error', (err) => {
        debug('Dashboard', 'startError', err);
        if (!settled) { settled = true; reject(err); }
      });
    });
  }

  _applyDevBypassConfig() {
    if (process.env.HARNESS_ALLOW_DEV_BYPASS === 'true' && process.env.NODE_ENV === 'development') {
      this._allowDevBypass = true;
      debug('Dashboard', 'SECURITY_WARNING', 'HARNESS_ALLOW_DEV_BYPASS is enabled in development - authentication bypass is ACTIVE. This should NOT be used in production.');
      if (this._auditLogger) {
        this._auditLogger.log({ agent: 'system', action: 'config_change', target: 'HARNESS_ALLOW_DEV_BYPASS', result: 'enabled', reason: 'dev_bypass_activated', details: 'Development authentication bypass enabled via environment variable' });
      }
    } else {
      this._allowDevBypass = false;
      if (process.env.HARNESS_ALLOW_DEV_BYPASS === 'true' && process.env.NODE_ENV !== 'development') {
        debug('Dashboard', 'SECURITY_VIOLATION', 'HARNESS_ALLOW_DEV_BYPASS is ignored in ' + (process.env.NODE_ENV || 'non-development') + ' environment for security');
      }
    }
  }

  _startCleanupTimers() {
    if (this._rateLimitCleanupTimer) clearInterval(this._rateLimitCleanupTimer);
    if (this._cacheCleanupTimer) clearInterval(this._cacheCleanupTimer);
    this._rateLimitCleanupTimer = setInterval(() => {
      const now = Date.now();
      const expiredRateIps = [];
      for (const [ip, record] of this._rateLimitMap) {
        if (now - record.windowStart > RATE_LIMIT_WINDOW) {
          expiredRateIps.push(ip);
        }
      }
      for (const ip of expiredRateIps) this._rateLimitMap.delete(ip);
      const expiredSensitiveIps = [];
      for (const [ip, record] of this._sensitiveRateMap) {
        if (now - record.windowStart > RATE_LIMIT_WINDOW) {
          expiredSensitiveIps.push(ip);
        }
      }
      for (const ip of expiredSensitiveIps) this._sensitiveRateMap.delete(ip);
    }, RATE_LIMIT_CLEANUP_INTERVAL);
    if (this._rateLimitCleanupTimer && typeof this._rateLimitCleanupTimer.unref === 'function') this._rateLimitCleanupTimer.unref();

    this._cacheCleanupTimer = setInterval(() => {
      try {
        const now = Date.now();
        if (this._fileCache && typeof this._fileCache.forEach === 'function') {
          const expiredFileKeys = [];
          this._fileCache.forEach((v, k) => { if (now - v.ts >= this._fileCacheTTL) expiredFileKeys.push(k); });
          expiredFileKeys.forEach(k => { this._fileCache.delete(k); });
        }
        if (this._dirCache && typeof this._dirCache.forEach === 'function') {
          const expiredDirKeys = [];
          this._dirCache.forEach((v, k) => { if (now - v.ts >= this._fileCacheTTL) expiredDirKeys.push(k); });
          expiredDirKeys.forEach(k => { this._dirCache.delete(k); });
        }
        if (this._fmCache.size > LRU_FM_CACHE_SIZE * 0.8) {
          this._fmCache = new LRUCache(LRU_FM_CACHE_SIZE);
        }
      } catch (err) { debug('Server', 'timerCleanup', err); }
    }, DEFAULT_FLUSH_INTERVAL_MS);
    if (this._cacheCleanupTimer && typeof this._cacheCleanupTimer.unref === 'function') this._cacheCleanupTimer.unref();
  }

  _bridgeRuntimeEvents() {
    if (this._wsBridgeCleanup) {
      this._wsBridgeCleanup.forEach(fn => fn());
      this._wsBridgeCleanup = null;
    }
    this._wsBridgeCleanup = [];

    const eventBus = this._rt('eventBus');
    if (!eventBus) return;

    this._bridgeStateEvents(eventBus);
    this._bridgeCacheInvalidation(eventBus);
    this._bridgeRouterEvents();
  }

  _bridgeStateEvents(eventBus) {
    const bridgeEvents = Object.keys(_EVENT_STATE_KEY_MAP);
    for (let ri = 0; ri < _DEEPENING_EVENT_RULES.length; ri++) {
      bridgeEvents.push('deepening:' + _DEEPENING_EVENT_RULES[ri].suffix);
    }
    for (const eventName of bridgeEvents) {
      const handler = (data) => {
        safeCall(() => this._ws.broadcast('data-update', { key: this._eventToStateKey(eventName), value: data, event: eventName }), 'Dashboard', 'broadcastError');
      };
      eventBus.on(eventName, handler);
      this._wsBridgeCleanup.push(() => {
        safeCall(() => eventBus.off(eventName, handler), 'Dashboard', 'eventBusOff');
      });
    }
  }

  _bridgeCacheInvalidation(eventBus) {
    const CACHE_INVALIDATION_MAP = {
      'session:created': ['sessions', 'overview'],
      'session:phase-change': ['sessions', 'workflow', 'overview'],
      'session:skill-complete': ['sessions', 'overview'],
      'session:budget-warning': ['sessions'],
      'agent:state-change': ['agents', 'overview'],
      'agent:registered': ['agents', 'overview'],
      'skills-reloaded': ['skills', 'overview'],
    };

    for (const [eventName, cacheKeys] of Object.entries(CACHE_INVALIDATION_MAP)) {
      const invalidateHandler = () => {
        cacheKeys.forEach(key => this._cache.delete(key));
      };
      eventBus.on(eventName, invalidateHandler);
      this._wsBridgeCleanup.push(() => {
        safeCall(() => eventBus.off(eventName, invalidateHandler), 'Dashboard', 'eventBusOff');
      });
    }
  }

  _bridgeRouterEvents() {
    const router = this._rt('router');
    if (router && typeof router.on === 'function') {
      const reloadHandler = (_data) => {
        safeCall(() => this._ws.broadcast('data-update', { key: 'skillLayerStats', value: { available: true, stats: router.getLayerStats() }, event: 'skills-reloaded' }), 'Dashboard', 'skillBroadcast');
        safeCall(() => this._ws.broadcast('data-update', { key: 'skillReducerStats', value: this._getSkillReducerStats(), event: 'skills-reloaded' }), 'Dashboard', 'skillReducerBroadcast');
      };
      router.on('skills-reloaded', reloadHandler);
      this._wsBridgeCleanup.push(() => {
        safeCall(() => router.off('skills-reloaded', reloadHandler), 'Dashboard', 'routerOff');
      });
    }
  }

  _eventToStateKey(eventName) {
    if (_EVENT_STATE_KEY_MAP[eventName]) return _EVENT_STATE_KEY_MAP[eventName];
    if (eventName.startsWith('deepening:')) {
      const suffix = eventName.slice(10);
      for (let i = 0; i < _DEEPENING_EVENT_RULES.length; i++) {
        if (_DEEPENING_EVENT_RULES[i].suffix === suffix) return _DEEPENING_EVENT_RULES[i].key;
      }
      return 'deepeningMetrics';
    }
    return eventName.replace(/[:.]/g, '_');
  }

  _stopCleanupTimers() {
    if (this._wsBridgeCleanup) {
      for (const fn of this._wsBridgeCleanup) fn();
      this._wsBridgeCleanup = null;
    }
    if (this._rateLimitCleanupTimer) {
      clearInterval(this._rateLimitCleanupTimer);
      this._rateLimitCleanupTimer = null;
    }
    if (this._cacheCleanupTimer) {
      clearInterval(this._cacheCleanupTimer);
      this._cacheCleanupTimer = null;
    }
    if (this._wsUpgradeCleanupTimer) {
      clearInterval(this._wsUpgradeCleanupTimer);
      this._wsUpgradeCleanupTimer = null;
    }
  }

  _stopRuntimeModules() {
    if (!this._runtime) return;
    const rt = this._runtime;
    const modules = [
      rt.auditLogger, rt.deviationApproval, rt.memoryStore,
      rt.sessionManager, rt.checkpointManager, rt.rbacEnforcer,
      rt.skillImprover, rt.codeReviewCheck,
    ];
    modules.forEach(mod => {
      if (mod && typeof mod.shutdown === 'function') {
        try {
          const result = mod.shutdown();
          if (result && typeof result.catch === 'function') {
            result.catch(function(err) { debug('DashboardServer', '_stopRuntimeModules', (err && err.message ? err.message : String(err))); });
          }
        } catch (err) {
          debug('DashboardServer', '_stopRuntimeModules', (err && err.message ? err.message : String(err)));
        }
      }
    });
    if (rt.rbacEnforcer && typeof rt.rbacEnforcer.stopWatching === 'function') {
      safeCall(() => rt.rbacEnforcer.stopWatching(), 'Server', 'rbacStopWatch');
    }
    safeCall(() => eventRegistrar.shutdown(), 'Server', 'eventRegistrarShutdown');
  }

  _stopConnections() {
    if (this._connections) {
      for (const socket of this._connections) {
        safeCall(() => socket.destroy(), 'Server', 'shutdown:socketDestroy');
      }
      this._connections.clear();
    }
  }

  _clearCaches() {
    this._cache = new Map();
    this._fmCache = new LRUCache(500);
    this._fileCache = new LRUCache(200);
    this._dirCache = new LRUCache(200);
    this._rateLimitMap.clear();
    this._sensitiveRateMap.clear();
    if (this._wsUpgradeByIp) this._wsUpgradeByIp.clear();
    this._responseTimes = null;
    this._rtIdx = 0;
    this._responseCount = 0;
  }

  /**
   * 停止HTTP服务器，关闭WebSocket连接，清理缓存和定时器。
   */
  stop() {
    this._shutDown = true;
    this._stopCleanupTimers();
    if (this._ws) {
      safeCall(() => this._ws.close(), 'Server', 'wsClose');
    }
    this._stopRuntimeModules();
    if (this._searchEngine && typeof this._searchEngine.shutdown === 'function') {
      safeCall(() => this._searchEngine.shutdown(), 'Server', 'searchEngineShutdown');
      this._searchEngine = null;
    }
    this._stopConnections();
    if (this.server) {
      safeCall(() => this.server.close(), 'Server', 'serverClose');
      this.server = null;
    }
    this._clearCaches();
    if (this._wsBridgeCleanup) {
      for (const fn of this._wsBridgeCleanup) { safeCall(fn, 'Dashboard', 'wsBridgeCleanup'); }
      this._wsBridgeCleanup = null;
    }
    if (typeof this._removeProcessListeners === 'function') {
      safeCall(this._removeProcessListeners, 'DashboardServer', 'removeProcessListeners');
    }
  }

  _checkRateLimit(req, res) {
    const pathname = _getPathname(req);
    if (_HEALTH_PATHS.has(pathname)) {
      return true;
    }
    // 额外保护：当rateLimitMap过大时淘汰过期条目
    if (this._rateLimitMap.size >= 5000) {
      const now = Date.now();
      for (const [ip, entry] of this._rateLimitMap) {
        if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
          this._rateLimitMap.delete(ip);
        }
      }
    }
    const result = Security.checkRateLimit(req, this._rateLimitMap, this._sensitiveRateMap, this._serverConfig);
    if (!result.allowed) {
      const corsOrigin = Security.getCorsOrigin(req, this._allowedOriginsSet);
      const headers = safeAssign({}, result.headers);
      if (corsOrigin) {
        headers['Access-Control-Allow-Origin'] = corsOrigin;
        headers['Access-Control-Allow-Credentials'] = 'true';
      }
      res.writeHead(result.status, headers);
      res.end(result.body);
      return false;
    }
    return true;
  }

  _setSecurityHeaders(res, req) {
    let nonce;
    try {
      nonce = Security.generateNonce();
    } catch (secErr) {
      debug('Dashboard', 'securityInit', secErr);
      const corsOrigin = Security.getCorsOrigin(req, this._allowedOriginsSet);
      _sendError(res, 503, 'Security initialization failed', undefined, corsOrigin);
      return false;
    }
    if (!res.locals) res.locals = {};
    res.locals.cspNonce = nonce;
    Security.setSecurityHeaders(res, req, this._host, this.port, this._serverConfig, nonce);
    return true;
  }

  async _handle(req, res) {
    const { recordTiming, origEnd } = this._setupResponseTracking(res);
    const _corsOrigin = Security.getCorsOrigin(req, this._allowedOriginsSet);

    try {
      if (!this._setSecurityHeaders(res, req)) return;

      const timeoutId = this._setupRequestTimeout(res, req);
      this._wrapResEnd(res, origEnd, recordTiming, timeoutId);

      if (req.url && req.url.length > MAX_URL_LENGTH) {
        _sendError(res, 414, t('server.error.url_too_long'), undefined, _corsOrigin);
        return;
      }

      if (req.method === 'OPTIONS') {
        this._handleOptions(req, res);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        _sendError(res, 405, t('server.error.method_not_allowed'), undefined, _corsOrigin);
        return;
      }

      if (!this._checkRateLimit(req, res)) return;

      let parsedUrl;
      try {
        parsedUrl = new URL(req.url, 'http://localhost:' + this.port);
      } catch (_parseErr) {
        debug('Dashboard', 'request', 'URL parse failed for: ' + (req.url ? req.url.substring(0, 100) : 'undefined'));
        _sendError(res, 400, t('server.error.url_invalid'), undefined, _corsOrigin);
        return;
      }

      const pathname = parsedUrl.pathname;

      // Webhook路径特殊处理：跳过标准API认证，使用签名验证
      if (pathname.startsWith('/api/webhook/')) {
        await this._handleWebhook(pathname, res, req);
        return;
      }

      if (pathname.startsWith('/api/')) {
        if (req.method === 'POST') {
          await this._handlePostApi(pathname, res, parsedUrl, req);
        } else {
          await this._handleApi(pathname, res, parsedUrl, req);
        }
        return;
      }

      StaticFileServer.handleStatic(this, pathname, req, res);
    } catch (err) {
      debug('Dashboard', 'unhandledException', err);
      if (!res.headersSent) {
        _sendError(res, 500, t('server.error.internal'), undefined, _corsOrigin);
      }
    }
  }

  _setupResponseTracking(res) {
    const startTime = Date.now();
    const originalWriteHead = res.writeHead.bind(res);
    let responseStatus = 200;
    res.writeHead = function(status) {
      responseStatus = status;
      return originalWriteHead.apply(res, arguments);
    };

    if (!this._responseTimes) { this._responseTimes = []; this._rtIdx = 0; this._responseCount = 0; }
    this._responseCount = (this._responseCount + 1) & 0x7FFFFFFF;

    const self = this;
    const recordTiming = function() {
      const elapsed = Date.now() - startTime;
      const entry = { ms: elapsed, status: responseStatus };
      if (self._responseTimes.length < MAX_RESPONSE_TIME_SAMPLES) {
        self._responseTimes.push(entry);
      } else {
        self._responseTimes[self._rtIdx] = entry;
        self._rtIdx = (self._rtIdx + 1) % MAX_RESPONSE_TIME_SAMPLES;
      }
      if (elapsed > C.SLOW_REQUEST_THRESHOLD_MS) {
        debug('Dashboard', 'slowResponse', elapsed + 'ms', 'status=' + responseStatus);
      }
    };
    const origEnd = res.end.bind(res);
    return { startTime, responseStatus, recordTiming, origEnd };
  }

  _setupRequestTimeout(res, req) {
    const self = this;
    const timeoutId = setTimeout(function() {
      if (!res.headersSent) {
        _sendError(res, 504, 'Request timeout', undefined, Security.getCorsOrigin(req, self._allowedOriginsSet));
      } else if (!res.writableEnded) {
        safeCall(() => res.destroy(), 'Dashboard', 'timeoutDestroy');
      }
    }, REQUEST_TIMEOUT_MS);
    if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
    return timeoutId;
  }

  _wrapResEnd(res, origEnd, recordTiming, timeoutId) {
    res.end = function() {
      safeCall(recordTiming, 'Dashboard', 'recordTiming');
      clearTimeout(timeoutId);
      return origEnd.apply(res, arguments);
    };
  }

  _handleOptions(req, res) {
    const corsOrigin = Security.getCorsOrigin(req, this._allowedOriginsSet);
    const headers = {
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (corsOrigin) {
      headers['Access-Control-Allow-Origin'] = corsOrigin;
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
    res.writeHead(204, headers);
    res.end();
  }

  _evictCacheEntry() {
    const keysIter = this._cache.keys();
    for (const k of keysIter) {
      const entry = this._cache.get(k);
      if (!entry || !entry._computing) {
        this._cache.delete(k);
        return true;
      }
    }
    return false;
  }

  async _getCached(key, ttl, computeFn) {
    const cached = this._cache.get(key);
    const now = Date.now();
    if (cached && (now - cached.ts) < ttl) {
      return cached.data;
    }
    if (cached && cached._computing) {
      try {
        return await cached._computing;
      } catch (_e) {
        debug('DashboardServer', '_getCached', 'Compute failed, returning stale data: ' + (_e && _e.message ? _e.message : String(_e)));
        return cached._staleData ?? {};
      }
    }
    let resolveCompute;
    const computePromise = new Promise(function(resolve) { resolveCompute = resolve; });
    if (cached) {
      this._cache.set(key, { data: cached.data, ts: cached.ts, _computing: computePromise, _staleData: cached.data });
    } else {
      this._cache.set(key, { data: null, ts: 0, _computing: computePromise, _staleData: null });
    }
    try {
      const data = await computeFn();
      this._cache.set(key, { data: data, ts: Date.now() });
      if (this._cache.size > MAX_CACHE_ENTRIES) {
        this._evictCacheEntry();
        if (this._cache.size > MAX_CACHE_ENTRIES + 10) {
          this._evictCacheEntry();
        }
      }
      resolveCompute(data);
      return data;
    } catch (_err) {
      debug('Dashboard', 'cacheCompute', _err && _err.message ? _err.message : String(_err));
      const staleData = cached ? cached.data : null;
      this._cache.set(key, { data: staleData, ts: cached ? cached.ts : 0 });
      resolveCompute(staleData);
      if (cached && cached.data !== undefined) {
        return cached.data;
      }
      return null;
    }
  }

  /**
   * 使指定缓存键失效。
   * @param {string} key - 缓存键名
   */
  invalidateCache(key) {
    if (key) {
      this._cache.delete(key);
    } else {
      this._cache.clear();
    }
  }

  _buildApiRoutes() {
    return buildAllRoutes(this, CACHE_TTL);
  }

  _sanitizeSearchParams(params) {
    if (!params || typeof params !== 'object') return _emptyParams();
    const sanitized = Object.create(null);
    const MAX_PARAM_LENGTH = 500;
    const MAX_PARAM_COUNT = 30;
    let count = 0;
    for (const [key, value] of params) {
      if (count >= MAX_PARAM_COUNT) break;
      if (typeof key !== 'string' || key.length > MAX_PARAM_LENGTH) continue;
      if (typeof value !== 'string' || value.length > MAX_PARAM_LENGTH) continue;
      if (/[<>"';&|\\\r\n\0]/.test(key) || /[<>"';&|\\\r\n\0]/.test(value)) continue;
      if (DANGEROUS_KEYS.has(key)) continue;
      sanitized[key] = value;
      count++;
    }
    return _wrapParams(sanitized);
  }

  _buildDynamicRouteMap() {
    const self = this;
    return {
      '/api/changelog/search': (sp) => self._searchChangelog(sp),
      '/api/changelog/archive': (_sp) => self._archive.search({ page: 1, pageSize: 50 }),
      '/api/changelog/stats': (_sp) => self._archive.getStats(),
      '/api/changelog/verify': (_sp) => self._archive.verifyIntegrity(),
      '/api/checkpoints': (sp) => self._getCheckpoints(sp),
      '/api/learnings': (sp) => self._getLearnings(sp),
      '/api/deviations': (sp) => self._getDeviations(sp),
      '/api/code-reviews': (sp) => self._getCodeReviews(sp),
      '/api/design/audit': (sp) => self._getDesignAudit(sp),
      '/api/design/presets': (sp) => self._getDesignPresets(sp),
      '/api/design/companies': (sp) => self._getDesignCompanies(sp),
      '/api/design/generate-md': (sp) => self._generateDesignMd(sp),
      '/api/design/contrast-check': (sp) => self._checkContrast(sp),
      '/api/design/accessibility-audit': (sp) => self._auditAccessibility(sp),
      '/api/design/generate-css': (sp) => self._generateDesignCSS(sp),
      '/api/design/section/tokens': (sp) => self._getSectionTokens(sp),
      '/api/design/section/css': (sp) => self._getSectionCSS(sp),
      '/api/design/section/variants': (_sp) => self._getSectionVariants(),
      '/api/design/section/validate': (sp) => self._validateSectionConfig(sp),
      '/api/design/section/presets': (sp) => self._getSectionPresets(sp),
      '/api/agent-lifecycle': (sp) => self._getAgentLifecycle(sp),
      '/api/agent-lifecycle/history': (sp) => self._getAgentLifecycleHistory(sp),
      '/api/agent-monitor/metrics': (sp) => self._getAgentMonitorMetrics(sp),
      '/api/agent-monitor/alerts': (sp) => self._getAgentMonitorAlerts(sp),
      '/api/agent-monitor/logs': (sp) => self._getAgentMonitorLogs(sp),
      '/api/agent-deployment/list': (sp) => self._getAgentDeploymentList(sp),
      '/api/agent-deployment/versions': (sp) => self._getAgentDeploymentVersions(sp),
      '/api/agent-state/info': (sp) => self._getAgentStateInfo(sp),
      '/api/agent-state/snapshots': (sp) => self._getAgentStateSnapshots(sp),
      '/api/agent-workflow/tasks': (sp) => self._getAgentWorkflowTasks(sp),
      '/api/agent-sandbox/access-log': (sp) => self._getAgentSandboxAccessLog(sp),
      '/api/pipeline/analyze': (sp) => self._getPipelineAnalyze(sp),
      '/api/rag/stats': (_sp) => self._getRAGStats(),
      '/api/rag/query': (sp) => self._ragQuery(sp),
      '/api/opencli/status': (_sp) => self._getOpenCLIStatus(),
      '/api/opencli/servers': (_sp) => self._getOpenCLIServers(),
      '/api/cli-anything/status': (_sp) => self._getCliAnythingStatus(),
      '/api/cli-anything/registry': (_sp) => self._getCliAnythingRegistry(),
      '/api/cli-anything/hub': (_sp) => self._getCliAnythingHubInfo(),
      '/api/browser-use/status': (_sp) => self._getBrowserUseStatus(),
      '/api/browser-use/cdp-status': (_sp) => self._getCdpStatus(),
      '/api/browser-use/screenshots': (_sp) => self._getBrowserUseScreenshots(),
      '/api/rl/status': (_sp) => self._getRlStatus(),
      '/api/rl/environments': (_sp) => self._getRlEnvironments(),
      '/api/rl/runs': (sp) => self._getRlRuns(sp),
      '/api/optimization/status': (_sp) => self._getOptimizationStatus(),
      '/api/optimization/progress': (_sp) => self._getOptimizationProgress(),
      '/api/optimization/journal': (_sp) => self._getOptimizationJournal(),
      '/api/ooda/status': (_sp) => self._getOodaStatus(),
      '/api/ooda/speed': (_sp) => self._getOodaSpeed(),
      '/api/ooda/history': (_sp) => self._getOodaHistory(),
      '/api/skill-distillation/status': (_sp) => self._getSkillDistillationStatus(),
      '/api/skill-distillation/history': (_sp) => self._getSkillDistillationHistory(),
      '/api/skill-distillation/traces': (_sp) => self._getSkillDistillationTraces(),
      '/api/skill-effectiveness/status': (_sp) => self._getSkillEffectivenessStatus(),
      '/api/skill-effectiveness/accuracy': (_sp) => self._getSkillEffectivenessAccuracy(),
      '/api/skill-effectiveness/overload': (_sp) => self._getSkillEffectivenessOverload(),
      '/api/opportunity-discovery/status': (_sp) => self._getOpportunityDiscoveryStatus(),
      '/api/opportunity-discovery/pain-points': (_sp) => self._getOpportunityDiscoveryPainPoints(),
      '/api/opportunity-discovery/competitors': (_sp) => self._getOpportunityDiscoveryCompetitors(),
      '/api/opportunity-discovery/product-lens': (_sp) => self._getOpportunityDiscoveryProductLens(),
      '/api/analytics/dashboard': (_sp) => self._getAnalyticsDashboard(),
      '/api/analytics/experiments': (_sp) => self._getAnalyticsExperiments(),
      '/api/analytics/bottlenecks': (_sp) => self._getAnalyticsBottlenecks(),
      '/api/analytics/anomalies': (_sp) => self._getAnalyticsAnomalies(),
      '/api/media-providers/status': (_sp) => self._getMediaProvidersStatus(),
      '/api/media-providers/list': (_sp) => self._getMediaProvidersList(),
      '/api/search/status': (_sp) => self._getSearchStatus(),
      '/api/search/clusters': (sp) => self._getSearchClusters(sp),
      '/api/search/history': (sp) => self._getSearchHistory(sp),
    };
  }

  _resolveDynamicRoute(pathname, parsedUrl) {
    const handler = this._dynamicRouteMap[pathname];
    if (handler) {
      const sp = this._sanitizeSearchParams(parsedUrl.searchParams);
      return () => handler(sp);
    }
    if (pathname.startsWith('/api/rl/runs/') && pathname.length > '/api/rl/runs/'.length) {
      const runId = pathname.slice('/api/rl/runs/'.length);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(runId)) {
        return () => ({ _status: 400, _data: { error: 'Invalid runId format' } });
      }
      const sp = this._sanitizeSearchParams(parsedUrl.searchParams);
      return () => this._getRlRunDetail(runId, sp);
    }
    if (pathname.startsWith('/api/media-providers/task/') && pathname.length > '/api/media-providers/task/'.length) {
      const taskId = pathname.slice('/api/media-providers/task/'.length);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) {
        return () => ({ _status: 400, _data: { error: 'Invalid taskId format' } });
      }
      return () => this._getMediaProviderTaskStatus(taskId);
    }
    return null;
  }

  _createSendFunction(req, res, corsOrigin, extraHeaders, startTime) {
    return function(data, status) {
      if (res.headersSent || res.writableEnded) return;
      if (typeof data === 'object' && data !== null && status >= 400) {
        if (!data.status) data.status = status;
        if (!data.timestamp) data.timestamp = new Date().toISOString();
      }
      let jsonStr;
      try {
        jsonStr = JSON.stringify(data);
      } catch (_e) {
        debug('server', '_sendJsonResponse', 'JSON.stringify failed:', _e && _e.message ? _e.message : String(_e));
        jsonStr = JSON.stringify({ error: 'Response serialization failed', status: status ?? 200, timestamp: new Date().toISOString() });
      }
      const headers = safeAssign({}, extraHeaders ?? {});
      headers['Content-Type'] = JSON_CONTENT_TYPE;
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Vary'] = 'Accept-Encoding, Origin';
      if (startTime) {
        headers['X-Response-Time'] = String(Date.now() - startTime) + 'ms';
      }
      if (corsOrigin) {
        headers['Access-Control-Allow-Origin'] = corsOrigin;
        headers['Access-Control-Allow-Credentials'] = 'true';
      }
      compressResponse(req, res, jsonStr, headers, status ?? 200, C.COMPRESS_TIMEOUT_MS);
    };
  }

  async _handleApi(pathname, res, parsedUrl, req) {
    if (!_HEALTH_PATHS.has(pathname) && !Security.verifyGetAuth(req, this._apiTokenHash, this._devMode, this._allowDevBypass, this._trustProxyActive())) {
      _sendError(res, 401, 'Authentication required', undefined, Security.getCorsOrigin(req, this._allowedOriginsSet));
      return;
    }

    const corsOrigin = Security.getCorsOrigin(req, this._allowedOriginsSet);
    const requestId = secureId('', 8);
    const startTime = Date.now();
    const send = this._createSendFunction(req, res, corsOrigin, {
      'X-Request-Id': requestId,
      'Access-Control-Expose-Headers': 'X-Request-Id',
    }, startTime);

    try {
      let handler = this._staticRoutes[pathname];
      if (!handler && this._dynamicRouteKeys.has(pathname)) {
        handler = this._resolveDynamicRoute(pathname, parsedUrl);
      }
      if (handler) {
        const result = await handler();
        if (result && result._status && result._data !== undefined) {
          send(result._data, result._status);
        } else {
          send(result);
        }
      } else {
        send({ error: t('server.error.not_found') }, 404);
      }
    } catch (err) {
      if (err && err._status && err._data !== undefined) {
        send(err._data, err._status);
      } else {
        debug('Dashboard', 'apiError', err);
        send({ error: t('server.error.internal') }, 500);
      }
    }
  }

  /**
   * 处理Webhook请求（跳过标准API认证，使用HMAC签名验证）
   * @param {string} pathname - 请求路径
   * @param {http.ServerResponse} res - 响应对象
   * @param {http.IncomingMessage} req - 请求对象
   */
  async _handleWebhook(pathname, res, req) {
    const self = this;
    const corsOrigin = Security.getCorsOrigin(req, this._allowedOriginsSet);
    const requestId = secureId('', 8);
    const startTime = Date.now();
    const send = this._createSendFunction(req, res, corsOrigin, {
      'X-Request-Id': requestId,
      'Access-Control-Expose-Headers': 'X-Request-Id',
    }, startTime);

    // 仅接受POST请求
    if (req.method !== 'POST') {
      send({ error: 'Method not allowed, use POST' }, 405);
      return;
    }

    // 读取请求体
    const bodyChunks = [];
    let bodyAborted = false;
    let bodyTimeout = false;
    let bodySize = 0;
    let bodyExceeded = false;
    let chunkCount = 0;

    const bodyReadTimer = setTimeout(function() {
      bodyTimeout = true;
      bodyChunks.length = 0;
      if (!res.headersSent) send({ error: 'Request body read timeout' }, 408);
      req.destroy();
    }, DEFAULT_REQUEST_TIMEOUT_MS);
    if (bodyReadTimer && typeof bodyReadTimer.unref === 'function') bodyReadTimer.unref();

    req.on('error', function(err) {
      bodyAborted = true;
      clearTimeout(bodyReadTimer);
      bodyChunks.length = 0;
      debug('Dashboard', 'webhookRequestError', { url: req.url, error: err && err.message ? err.message : String(err) });
    });
    req.on('aborted', function() { bodyAborted = true; clearTimeout(bodyReadTimer); bodyChunks.length = 0; });

    req.on('data', function(chunk) {
      if (bodyExceeded || bodyAborted || bodyTimeout) return;
      bodySize += chunk.length;
      chunkCount++;
      if (bodySize > MAX_POST_CONTENT_LENGTH) {
        bodyExceeded = true;
        clearTimeout(bodyReadTimer);
        send({ error: 'Request body too large (max 1MB)' }, 413);
        req.destroy();
        return;
      }
      if (chunkCount > 1024) {
        bodyExceeded = true;
        clearTimeout(bodyReadTimer);
        send({ error: 'Too many chunks' }, 413);
        req.destroy();
        return;
      }
      bodyChunks.push(chunk);
    });

    req.on('end', function() {
      (async function() {
        clearTimeout(bodyReadTimer);
        if (bodyExceeded || bodyAborted || bodyTimeout) return;

        try {
          // 解析请求体，保留原始字符串用于签名验证
          const raw = Buffer.concat(bodyChunks).toString(UTF8_ENCODING);
          bodyChunks.length = 0;
          let payload = null;
          if (raw) {
            const parsed = safeJsonParse(raw, null, 'WebhookHandler');
            if (parsed && typeof parsed === 'object' && parsed !== null) {
              payload = parsed;
            } else {
              send({ error: 'Invalid JSON payload' }, 400);
              return;
            }
          } else {
            send({ error: 'Empty request body' }, 400);
            return;
          }

          // 提取Webhook路径（去掉/api/webhook前缀），防止路径遍历
          const webhookPath = pathname.replace('/api/webhook', '') || '/';
          if (webhookPath.includes('..')) {
            send({ error: 'Invalid webhook path' }, 400);
            return;
          }

          // 提取签名
          const signature = req.headers['x-webhook-signature']
            || req.headers['x-hub-signature-256']
            || null;

          // 通过TriggerDispatcher分发，传递原始请求体用于签名验证
          const { _mod: td } = _requireModule(self, 'triggerDispatcher', 'TriggerDispatcher');
          if (!td) {
            send({ error: 'TriggerDispatcher not available' }, 503);
            return;
          }

          const result = await td.dispatchWebhook(webhookPath, payload, signature, raw);
          if (result.dispatched) {
            send({ received: true, agentId: result.agentId, timestamp: Date.now() }, 200);
          } else {
            const statusMap = { no_route: 404, no_host: 503, invalid_signature: 401, signature_required: 401 };
            send({ error: result.reason, path: result.path }, statusMap[result.reason] ?? 400);
          }
        } catch (err) {
          debug('Dashboard', 'webhookError', err);
          if (!res.headersSent) send({ error: 'Internal server error' }, 500);
        }
      })().catch(function(err) {
        debug('Dashboard', 'webhookUnhandled', err);
        try {
          if (!res.headersSent) send({ error: 'Internal server error' }, 500);
          else if (!res.writableEnded) safeCall(function() { res.end(); }, 'Dashboard', 'webhookEndFallback');
        } catch (_e) { debug('Dashboard', 'webhookFallbackError', _e); }
      });
    });
  }

  async _handlePostApi(pathname, res, parsedUrl, req) {
    if (!Security.verifyPostAuth(req, this._apiTokenHash, this._devMode, this._allowDevBypass, this._trustProxyActive())) {
      _sendError(res, 401, 'Authentication required', undefined, Security.getCorsOrigin(req, this._allowedOriginsSet));
      return;
    }

    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const _postCorsOrigin = Security.getCorsOrigin(req, this._allowedOriginsSet);
    if (!origin && !referer && this._apiTokenHash && !this._devMode) {
      _sendError(res, 403, 'Origin or Referer header required', undefined, _postCorsOrigin);
      return;
    }
    if (origin && this._allowedOriginsSet && this._allowedOriginsSet.size > 0 && !this._allowedOriginsSet.has(origin)) {
      _sendError(res, 403, 'Cross-origin request denied', undefined, _postCorsOrigin);
      return;
    }

    const self = this;
    const corsOrigin = Security.getCorsOrigin(req, this._allowedOriginsSet);
    const requestId = secureId('', 8);
    const startTime = Date.now();
    let bodySize = 0;
    let bodyExceeded = false;
    let chunkCount = 0;

    const send = this._createSendFunction(req, res, corsOrigin, {
      'X-Request-Id': requestId,
      'Access-Control-Expose-Headers': 'X-Request-Id',
    }, startTime);

    const contentType = (req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
    if (contentType !== 'application/json') {
      send({ error: 'Content-Type must be application/json' }, 415);
      req.destroy();
      return;
    }

    const bodyChunks = [];
    let bodyAborted = false;
    let bodyTimeout = false;
    const bodyReadTimer = setTimeout(function() {
      bodyTimeout = true;
      bodyChunks.length = 0;
      debug('Dashboard', 'bodyReadTimeout', { url: req.url });
      if (!res.headersSent) send({ error: 'Request body read timeout' }, 408);
      req.destroy();
    }, DEFAULT_REQUEST_TIMEOUT_MS);
    if (bodyReadTimer && typeof bodyReadTimer.unref === 'function') bodyReadTimer.unref();
    req.on('error', function(err) { bodyAborted = true; clearTimeout(bodyReadTimer); bodyChunks.length = 0; debug('Dashboard', 'requestError', { url: req.url, error: err && err.message ? err.message : String(err) }); });
    req.on('aborted', function() { bodyAborted = true; clearTimeout(bodyReadTimer); bodyChunks.length = 0; });
    req.on('data', (chunk) => {
      if (bodyExceeded || bodyAborted || bodyTimeout) return;
      bodySize += chunk.length;
      if (bodySize > MAX_POST_CONTENT_LENGTH) {
        bodyExceeded = true;
        clearTimeout(bodyReadTimer);
        send({ error: 'Request body too large (max 1MB)' }, 413);
        req.destroy();
        return;
      }
      chunkCount++;
      if (chunkCount > 1024) {
        bodyExceeded = true;
        clearTimeout(bodyReadTimer);
        send({ error: 'Too many chunks' }, 413);
        req.destroy();
        return;
      }
      bodyChunks.push(chunk);
    });
    req.on('end', () => {
      (async () => {
        clearTimeout(bodyReadTimer);
        if (bodyExceeded || bodyAborted || bodyTimeout) return;

        try {
          const parsed = self._parseBody(bodyChunks);
          bodyChunks.length = 0;
          if (parsed.error) {
            debug('Dashboard', 'jsonParseError', { url: req.url, ip: Security.getClientIp(req, self._serverConfig), error: parsed.error && parsed.error.message ? parsed.error.message : String(parsed.error) });
            if (!res.headersSent) send({ error: 'Invalid JSON in request body' }, 400);
            return;
          }

          const routes = self._postRoutes || (self._postRoutes = self._buildPostRoutes());
          const handler = routes[pathname];
          if (handler) {
            const result = await handler(parsed.body, req);
            if (result && result._status && result._data !== undefined) {
              send(result._data, result._status);
            } else {
              send(result);
            }
          } else {
            send({ error: 'POST endpoint not found' }, 404);
          }
        } catch (err) {
          debug('Dashboard', 'postApiError', err);
          try {
            if (!res.headersSent) {
              send({ error: 'Internal server error' }, 500);
            } else if (!res.writableEnded) {
              safeCall(() => res.end(), 'Dashboard', 'postApiEndAfterHeaders');
            }
          } catch (_sendErr) {
            debug('Dashboard', 'postApiErrorSend', _sendErr);
          }
        }
      })().catch(function(err) {
        debug('Dashboard', 'postEndUnhandled', err);
        try {
          if (!res.headersSent) send({ error: 'Internal server error' }, 500);
          else if (!res.writableEnded) safeCall(function() { res.end(); }, 'Dashboard', 'postEndFallback');
        } catch (_e) { debug('Dashboard', 'postEndFallbackError', _e); }
      });
    });
  }

  _parseBody(bodyChunks) {
    let body = {};
    let parseError = null;
    try {
      const raw = Buffer.concat(bodyChunks).toString(UTF8_ENCODING);
      if (raw) {
        const parsed = safeJsonParse(raw, null, 'DashboardServer');
        if (parsed && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          if (_validateObjectDepth(parsed, 10)) {
            body = parsed;
          } else {
            parseError = new Error('JSON nesting depth exceeds limit');
          }
        } else {
          parseError = new Error('Request body must be a JSON object');
        }
      }
    } catch (e) {
      debug('Dashboard', 'bodyParse', e && e.message ? e.message : String(e));
      parseError = e;
    }
    return parseError ? { body: {}, error: parseError } : { body, error: null };
  }

  _buildPostRoutes() {
    const self = this;
    const VALID_SKILL_ID_RE = /^[a-z][a-z0-9-]*$/;

    function _validateSkillId(skillId) {
      if (!skillId || typeof skillId !== 'string') return 'skillId must be a non-empty string';
      if (!VALID_SKILL_ID_RE.test(skillId)) return 'skillId contains invalid characters';
      if (skillId.length > MAX_SKILL_ID_LENGTH) return 'skillId exceeds maximum length';
      return null;
    }

    function _validateStringLength(value, name, maxLen) {
      if (typeof value === 'string' && value.length > (maxLen ?? MAX_STRING_LENGTH)) {
        return `${name} exceeds maximum length`;
      }
      return null;
    }

    return safeAssign(
      this._buildSkillRoutes(self, _validateSkillId, _validateStringLength),
      this._buildGoalRoutes(self),
      this._buildApprovalRoutes(self),
      this._buildAutoVersionRoutes(self, _validateStringLength),
      this._buildTokenRoutes(self),
      this._buildConversationRoutes(self),
      this._buildChatRoutes(self),
      this._buildTerminalRoutes(self),
      this._buildFileBrowserRoutes(self),
      this._buildThemeRoutes(),
      this._buildHarnessMigrationRoutes(self),
      this._buildMediaProviderRoutes(self, _validateStringLength),
      this._buildSearchRoutes(self),
      this._buildDynamicWorkflowRoutes(self),
      this._buildMultiAgentOrchestratorRoutes(self),
      this._buildArchitectureRoutes(self),
      this._buildDeerFlowRoutes(self),
    );
  }

  _buildSkillRoutes(self, _validateSkillId, _validateStringLength) {
    return safeAssign(
      this._buildCoreSkillRoutes(self, _validateSkillId, _validateStringLength),
      this._buildExtendedSkillRoutes(self, _validateStringLength),
    );
  }

  _buildCoreSkillRoutes(self, _validateSkillId, _validateStringLength) {
    return {
      '/api/skill-improvement/apply': (body) => {
        const { _mod: loop, _err: loopErr } = _requireModule(self, 'skillImprovementLoop', 'SkillImprovementLoop');
        if (loopErr) return loopErr;
        const skillErr = _validateSkillId(body.skillId);
        if (skillErr) return { _status: 400, _data: { error: skillErr } };
        return loop.applyPatch(body.skillId);
      },
      '/api/skill-improvement/reject': (body) => {
        const { _mod: loop, _err: loopErr } = _requireModule(self, 'skillImprovementLoop', 'SkillImprovementLoop');
        if (loopErr) return loopErr;
        const skillErr = _validateSkillId(body.skillId);
        if (skillErr) return { _status: 400, _data: { error: skillErr } };
        return { success: loop.rejectPatch(body.skillId) };
      },
      '/api/skill-improvement/record': (body) => {
        const { _mod: loop, _err: loopErr } = _requireModule(self, 'skillImprovementLoop', 'SkillImprovementLoop');
        if (loopErr) return loopErr;
        const skillErr = _validateSkillId(body.skillId);
        if (skillErr) return { _status: 400, _data: { error: skillErr } };
        const safeBody = { skillId: body.skillId };
        const allowedKeys = ['approach', 'whatWorked', 'whatFailed', 'tips', 'phase', 'context'];
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            if (typeof body[key] === 'string' && body[key].length <= MAX_STRING_LENGTH) {
              safeBody[key] = body[key];
            }
          }
        }
        return loop.recordLearning(safeBody);
      },
      '/api/skill-creation/create': (body) => {
        const { _mod: engine, _err: engineErr } = _requireModule(self, 'skillCreationEngine', 'SkillCreationEngine');
        if (engineErr) return engineErr;
        const scErr = _validateOptionalString(body.content, 'content');
        if (scErr) return scErr;
        const lenErr = _validateStringLength(body.content, 'content');
        if (lenErr) return { _status: 400, _data: { error: lenErr } };
        const evaluation = engine.evaluateTask(body);
        if (!evaluation.shouldCreate) return { created: false, reason: evaluation.reason };
        return engine.createSkill(evaluation, body.content || '');
      },
      '/api/skill-reducer/stats': () => self._getSkillReducerStats(),
      '/api/skill-reducer/layer-distribution': () => {
        const reducer = self._rt('skillReducer');
        if (!reducer || typeof reducer.getLayerDistribution !== 'function') return { available: false };
        return { available: true, distribution: reducer.getLayerDistribution() };
      },
      '/api/skill-reducer/active-tasks': () => {
        const reducer = self._rt('skillReducer');
        if (!reducer || typeof reducer.getActiveTaskSkills !== 'function') return { available: false };
        return { available: true, tasks: reducer.getActiveTaskSkills() };
      },
      '/api/skill-reducer/overload': (body) => {
        const reducer = self._rt('skillReducer');
        if (!reducer || typeof reducer.detectOverload !== 'function') return { available: false };
        const budget = (body && typeof body.tokenBudget === 'number' && body.tokenBudget > 0) ? body.tokenBudget : undefined;
        return { available: true, overload: reducer.detectOverload(budget) };
      },
      '/api/skill-reducer/compressed-context': () => {
        const reducer = self._rt('skillReducer');
        if (!reducer || typeof reducer.getCompressedContextEstimate !== 'function') return { available: false };
        return { available: true, estimate: reducer.getCompressedContextEstimate() };
      },
      '/api/dev-metrics/stats': () => {
        const mc = self._rt('devMetricsCollector');
        if (!mc || typeof mc.getGlobalStats !== 'function') return { available: false };
        return { available: true, stats: mc.getGlobalStats() };
      },
      '/api/dev-metrics/project': (body) => {
        const mc = self._rt('devMetricsCollector');
        if (!mc) return { available: false };
        if (!body || !body.projectId) return { _status: 400, _data: { error: 'projectId is required' } };
        if (typeof body.projectId !== 'string' || body.projectId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(body.projectId)) return { _status: 400, _data: { error: 'Invalid projectId format' } };
        const report = mc.generateReport(body.projectId);
        if (!report) return { _status: 404, _data: { error: 'Project not found' } };
        return { available: true, report };
      },
      '/api/dev-metrics/history': (body) => {
        const mc = self._rt('devMetricsCollector');
        if (!mc) return { available: false };
        const rawLimit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? body.limit : 10;
        const limit = Math.min(Math.max(rawLimit, 1), 100);
        return { available: true, history: mc.getHistory(limit) };
      },
      '/api/pair-chat/cross-validation-report': (body) => {
        const pc = self._rt('pairChat');
        if (!pc) return { available: false };
        if (!body || !body.sessionId) return { _status: 400, _data: { error: 'sessionId is required' } };
        if (typeof body.sessionId !== 'string' || body.sessionId.length > 256) return { _status: 400, _data: { error: 'Invalid sessionId format' } };
        const report = pc.getCrossValidationReport(body.sessionId);
        if (!report) return { _status: 404, _data: { error: 'Cross-validation session not found' } };
        return { available: true, report };
      },
      '/api/pair-chat/cross-validation-stats': () => {
        const pc = self._rt('pairChat');
        if (!pc) return { available: false };
        return { available: true, stats: pc.getCrossValidationStats() };
      },
      '/api/chat-chain/artifact-flow': (body) => {
        const cc = self._rt('chatChain');
        if (!cc) return { available: false };
        if (!body || !body.chainId) return { _status: 400, _data: { error: 'chainId is required' } };
        if (typeof body.chainId !== 'string' || body.chainId.length > 256) return { _status: 400, _data: { error: 'Invalid chainId format' } };
        const flow = cc.getArtifactFlow(body.chainId);
        if (!flow) return { _status: 404, _data: { error: 'Chain not found' } };
        return { available: true, flow };
      },
      '/api/chat-chain/phase-artifacts': (body) => {
        const cc = self._rt('chatChain');
        if (!cc) return { available: false };
        if (!body || !body.chainId || !body.phase) return { _status: 400, _data: { error: 'chainId and phase are required' } };
        if (typeof body.chainId !== 'string' || body.chainId.length > 256) return { _status: 400, _data: { error: 'Invalid chainId format' } };
        const artifacts = cc.getPhaseArtifacts(body.chainId, body.phase);
        if (!artifacts) return { _status: 404, _data: { error: 'Chain not found' } };
        return { available: true, artifacts };
      },
      '/api/user/profile': (body) => {
        const { _mod: um, _err: umErr } = _requireModule(self, 'userModelManager', 'UserModelManager');
        if (umErr) return umErr;
        if (body.learn) {
          const lenErr = _validateStringLength(body.learn, 'learn');
          if (lenErr) return { _status: 400, _data: { error: lenErr } };
          return { success: um.learnFromInteraction(body.learn) };
        }
        if (body.key && body.value !== undefined) {
          const keyErr = _validateOptionalString(body.key, 'key');
          if (keyErr) return keyErr;
          const valErr = _validateOptionalString(body.value, 'value');
          if (valErr) return valErr;
          return { success: um.setPreference(body.key, body.value) };
        }
        if (body.removeKey) {
          const rmErr = _validateOptionalString(body.removeKey, 'removeKey');
          if (rmErr) return rmErr;
          return { success: um.removePreference(body.removeKey) };
        }
        return { _status: 400, _data: { error: 'Provide key/value, learn, or removeKey' } };
      },
      '/api/nudge/evaluate': async (body) => {
        const { _mod: nudge, _err: nudgeErr } = _requireModule(self, 'memoryNudge', 'MemoryNudge');
        if (nudgeErr) return nudgeErr;
        if (!body || typeof body !== 'object') return { _status: 400, _data: { error: 'body must be an object' } };
        const safeBody = {};
        const allowedKeys = ['context', 'threshold', 'maxResults', 'category', 'tags'];
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            const val = body[key];
            if (typeof val === 'string' && val.length > MAX_STRING_LENGTH) {
              return { _status: 400, _data: { error: key + ' exceeds maximum length' } };
            }
            if (key === 'threshold') {
              const thErr = _validateNumberRange(val, 'threshold', 0, 1);
              if (thErr) return thErr;
            }
            if (key === 'maxResults') {
              const mrErr = _validateNumberRange(val, 'maxResults', 1, 100);
              if (mrErr) return mrErr;
            }
            if (key === 'tags' && !Array.isArray(val)) {
              return { _status: 400, _data: { error: 'tags must be an array' } };
            }
            safeBody[key] = val;
          }
        }
        const result = await nudge.evaluate(safeBody);
        return result || { triggered: false };
      },
    };
  }

  _buildExtendedSkillRoutes(self, _validateStringLength) {
    return safeAssign(
      this._buildMcpRoutes(self),
      this._buildKnowledgeRoutes(self),
      this._buildMemoryRoutes(self, _validateStringLength),
      this._buildDocFreshnessRoutes(self),
      this._buildAffinityRoutes(self),
      this._buildCodeWikiRoutes(self),
      this._buildDeliveryAccelerationRoutes(self),
    );
  }

  _buildMcpRoutes(self) {
    return {
      '/api/mcp/connect': (body) => {
        const { _mod: mcp, _err: mcpErr } = _requireModule(self, 'mcpClient', 'MCPClient');
        if (mcpErr) return mcpErr;
        if (!body.name || !(body.command || body.url)) {
          return { _status: 400, _data: { error: 'name and command or url required' } };
        }
        const nameErr = _validateRequiredString(body, 'name');
        if (nameErr) return nameErr;
        if (body.maxBuffer !== undefined) {
          const mb = Number(body.maxBuffer);
          if (!Number.isFinite(mb) || mb < 0 || mb > MAX_MCP_STDIO_BUFFER) {
            return { _status: 400, _data: { error: 'maxBuffer must be between 0 and ' + MAX_MCP_STDIO_BUFFER } };
          }
        }
        const cmdErr = McpSecurity.validateMcpCommand(body);
        if (cmdErr) return cmdErr;
        const urlErr = McpSecurity.validateMcpUrl(body);
        if (urlErr) return urlErr;
        mcp.addServer(body.name, body);
        return { added: true, name: body.name };
      },
      '/api/mcp/call-tool': (body) => {
        const { _mod: mcp, _err: mcpErr2 } = _requireModule(self, 'mcpClient', 'MCPClient');
        if (mcpErr2) return mcpErr2;
        const tnErr = _validateRequiredString(body, 'toolName');
        if (tnErr) return tnErr;
        const args = body.args ?? {};
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          return { _status: 400, _data: { error: 'args must be an object' } };
        }
        const argsStr = safeStringify(args);
        if (argsStr.length > MAX_ARGS_LENGTH) {
          return { _status: 400, _data: { error: 'args exceeds maximum size (64KB)' } };
        }
        return mcp.callTool(body.toolName, args);
      },
    };
  }

  _buildKnowledgeRoutes(self) {
    return {
      '/api/sqlite/knowledge': (body) => {
        const { _mod: store, _err: storeErr } = _requireModule(self, 'sqliteStore', 'SqliteStore');
        if (storeErr) return storeErr;
        if (body.action === 'add') return Validation.handleKnowledgeAdd(store, body);
        if (body.action === 'update') return Validation.handleKnowledgeUpdate(store, body);
        if (body.action === 'remove') return Validation.handleKnowledgeRemove(store, body);
        return { _status: 400, _data: { error: 'action (add/update/remove) required' } };
      },
    };
  }

  _buildMemoryRoutes(self, _validateStringLength) {
    return {
      '/api/memory/add': (body) => {
        const { _mod: store, _err: storeErr } = _requireModule(self, 'sqliteStore', 'SqliteStore');
        if (storeErr) return storeErr;
        const cErr = _validateRequiredString(body, 'content');
        if (cErr) return cErr;
        const lenErr = _validateStringLength(body.content, 'content');
        if (lenErr) return { _status: 400, _data: { error: lenErr } };
        const target = (body.target && typeof body.target === 'string') ? body.target : 'memory';
        if (target.length > MAX_STRING_LENGTH) return { _status: 400, _data: { error: 'target exceeds maximum length' } };
        const memResult = store.addMemory(target, body.content);
        if (memResult && typeof memResult === 'object' && memResult !== null && memResult.success === false) return { _status: 400, _data: { error: memResult.error || memResult.message || 'Operation failed', ...memResult } };
        return { success: true, id: memResult };
      },
      '/api/memory/remove': (body) => {
        const { _mod: store, _err: storeErr2 } = _requireModule(self, 'sqliteStore', 'SqliteStore');
        if (storeErr2) return storeErr2;
        const vErr = _validateRequiredString(body, 'id');
        if (vErr) return vErr;
        if (/[\/\\]/.test(body.id)) return { _status: 400, _data: { error: 'id contains invalid characters' } };
        const target = (body.target && typeof body.target === 'string') ? body.target : 'memory';
        if (target.length > MAX_STRING_LENGTH) return { _status: 400, _data: { error: 'target exceeds maximum length' } };
        return { success: store.removeMemory(target, body.id) };
      },
    };
  }

  _buildDocFreshnessRoutes(self) {
    return {
      '/api/doc-freshness/verify': (body) => {
        const { _mod: guard, _err: guardErr } = _requireModule(self, 'docFreshnessGuard', 'DocFreshnessGuard');
        if (guardErr) return guardErr;
        const dpErr = _validateRequiredString(body, 'docPath');
        if (dpErr) return dpErr;
        const ptErr = _validatePathSafety(body.docPath, 'docPath');
        if (ptErr) return ptErr;
        return { success: guard.markDocVerified(body.docPath) };
      },
      '/api/doc-freshness/code-change': (body) => {
        const { _mod: guard, _err: guardErr } = _requireModule(self, 'docFreshnessGuard', 'DocFreshnessGuard');
        if (guardErr) return guardErr;
        const fpErr = _validateRequiredString(body, 'filePath');
        if (fpErr) return fpErr;
        const ptErr = _validatePathSafety(body.filePath, 'filePath');
        if (ptErr) return ptErr;
        const changeType = (body.changeType && typeof body.changeType === 'string') ? body.changeType : 'modify';
        const staleDocs = guard.handleCodeChange(body.filePath, changeType);
        return { staleDocs: staleDocs.map(d => d.path) };
      },
    };
  }

  _buildCodeWikiRoutes(self) {
    return {
      '/api/code-wiki/compile': (body) => {
        const { _mod: wiki, _err: wikiErr } = _requireModule(self, 'codeWikiOrchestrator', 'CodeWikiOrchestrator');
        if (wikiErr) return wikiErr;
        const force = body && body.force === true;
        const changedFiles = Array.isArray(body && body.changedFiles) ? body.changedFiles : undefined;
        if (changedFiles) {
          for (let i = 0; i < changedFiles.length; i++) {
            const ptErr = _validatePathSafety(String(changedFiles[i]), 'changedFiles[' + i + ']');
            if (ptErr) return ptErr;
          }
        }
        return wiki.compile({ force, changedFiles });
      },
      '/api/code-wiki/query': (body) => {
        const { _mod: wiki, _err: wikiErr } = _requireModule(self, 'codeWikiOrchestrator', 'CodeWikiOrchestrator');
        if (wikiErr) return wikiErr;
        const qErr = _validateRequiredString(body, 'q');
        if (qErr) return qErr;
        const topK = (body && typeof body.top_k === 'number' && body.top_k > 0 && body.top_k <= 50) ? body.top_k : 5;
        const sources = Array.isArray(body && body.sources) ? body.sources : undefined;
        return wiki.query(body.q, { topK, sources });
      },
      '/api/code-wiki/chat': (body) => {
        const { _mod: wiki, _err: wikiErr } = _requireModule(self, 'codeWikiOrchestrator', 'CodeWikiOrchestrator');
        if (wikiErr) return wikiErr;
        const qErr = _validateRequiredString(body, 'question');
        if (qErr) return qErr;
        const topK = (body && typeof body.top_k === 'number' && body.top_k > 0 && body.top_k <= 50) ? body.top_k : 5;
        return wiki.chat(body.question, { topK });
      },
      '/api/code-wiki/dependency-diagram': (body) => {
        const { _mod: wiki, _err: wikiErr } = _requireModule(self, 'codeWikiOrchestrator', 'CodeWikiOrchestrator');
        if (wikiErr) return wikiErr;
        const fpErr = _validateRequiredString(body, 'filePath');
        if (fpErr) return fpErr;
        const ptErr = _validatePathSafety(body.filePath, 'filePath');
        if (ptErr) return ptErr;
        const maxDepth = (body && typeof body.maxDepth === 'number' && body.maxDepth > 0) ? body.maxDepth : 3;
        return wiki.generateDependencyDiagram(body.filePath, { maxDepth });
      },
      '/api/code-wiki/code-change': (body) => {
        const { _mod: wiki, _err: wikiErr } = _requireModule(self, 'codeWikiOrchestrator', 'CodeWikiOrchestrator');
        if (wikiErr) return wikiErr;
        const fpErr = _validateRequiredString(body, 'filePath');
        if (fpErr) return fpErr;
        const ptErr = _validatePathSafety(body.filePath, 'filePath');
        if (ptErr) return ptErr;
        const changeType = (body.changeType && typeof body.changeType === 'string') ? body.changeType : 'modify';
        return wiki.handleCodeChange(body.filePath, changeType);
      },
    };
  }

  _buildDeliveryAccelerationRoutes(self) {
    return {
      '/api/delivery-acceleration/diagnose': () => {
        const { _mod: dao, _err: daoErr } = _requireModule(self, 'deliveryAccelerationOrchestrator', 'DeliveryAccelerationOrchestrator');
        if (daoErr) return daoErr;
        return dao.diagnoseBottlenecks();
      },
      '/api/delivery-acceleration/check-architecture-gate': () => {
        const { _mod: dao, _err: daoErr } = _requireModule(self, 'deliveryAccelerationOrchestrator', 'DeliveryAccelerationOrchestrator');
        if (daoErr) return daoErr;
        return dao.checkArchitectureFirstGate();
      },
      '/api/delivery-acceleration/switch-mode': (body) => {
        const { _mod: dao, _err: daoErr } = _requireModule(self, 'deliveryAccelerationOrchestrator', 'DeliveryAccelerationOrchestrator');
        if (daoErr) return daoErr;
        if (!body || typeof body.mode !== 'string') return { _status: 400, _data: { error: 'mode is required' } };
        if (!_VALID_WORKFLOW_MODES.has(body.mode)) return { _status: 400, _data: { error: 'Invalid mode. Must be one of: ' + Array.from(_VALID_WORKFLOW_MODES).join(', ') } };
        return dao.switchWorkflowMode(body.mode);
      },
      '/api/delivery-acceleration/recommend-mode': () => {
        const { _mod: dao, _err: daoErr } = _requireModule(self, 'deliveryAccelerationOrchestrator', 'DeliveryAccelerationOrchestrator');
        if (daoErr) return daoErr;
        return dao.recommendWorkflowMode();
      },
    };
  }

  _buildAffinityRoutes(self) {
    return {
      '/api/affinity/record': (body) => {
        const { _mod: al, _err: alErr } = _requireModule(self, 'affinityLearner', 'AffinityLearner');
        if (alErr) return alErr;
        const agErr = _validateRequiredString(body, 'agentId');
        if (agErr) return agErr;
        const ttErr = _validateRequiredString(body, 'taskType');
        if (ttErr) return ttErr;
        if (typeof body.qualityScore !== 'number') return { _status: 400, _data: { error: 'qualityScore (number) required' } };
        if (!Number.isFinite(body.qualityScore) || body.qualityScore < 0 || body.qualityScore > 1) return { _status: 400, _data: { error: 'qualityScore must be between 0 and 1' } };
        if (body.duration !== undefined && typeof body.duration !== 'number') return { _status: 400, _data: { error: 'duration must be a number' } };
        if (body.duration !== undefined && (!Number.isFinite(body.duration) || body.duration < 0)) return { _status: 400, _data: { error: 'duration must be a non-negative finite number' } };
        al.recordExecution(body.agentId, body.taskType, body.qualityScore, body.duration);
        return { success: true };
      },
      '/api/affinity/recommendations': (body) => {
        const { _mod: al, _err: alErr } = _requireModule(self, 'affinityLearner', 'AffinityLearner');
        if (alErr) return alErr;
        const tt2Err = _validateRequiredString(body, 'taskType');
        if (tt2Err) return tt2Err;
        if (body.taskType.length > MAX_STRING_LENGTH) return { _status: 400, _data: { error: 'taskType exceeds maximum length' } };
        if (!Array.isArray(body.agentIds)) return { _status: 400, _data: { error: 'agentIds[] required' } };
        if (body.agentIds.some(function(id) { return typeof id !== 'string' || id.length > 128; })) return { _status: 400, _data: { error: 'Each agent ID must be a string (max 128 chars)' } };
        if (body.agentIds.length > 100) return { _status: 400, _data: { error: 'agentIds exceeds maximum length (100)' } };
        return { recommendations: al.getRecommendations(body.taskType, body.agentIds) };
      },
    };
  }

  _trustProxyActive() {
    return !!(this._serverConfig && this._serverConfig.trustProxy);
  }

  async _loadServerConfig() {
    let raw = null;
    try {
      const configPath = getHarnessConfigPath(this.root);
      const configContent = await fs.promises.readFile(configPath, UTF8_ENCODING);
      raw = safeJsonParse(configContent, null, 'DashboardServer');
    } catch (err) { debug('DashboardServer', 'loadServerConfig', err); }
    if (!raw || typeof raw !== 'object') return null;
    const cfg = {};
    if (raw.trustProxy === true || typeof raw.trustProxy === 'number') {
      cfg.trustProxy = raw.trustProxy;
    }
    if (raw.forceHttps === true) {
      cfg.forceHttps = true;
    }
    if (Array.isArray(raw.proxyWhitelist)) {
      cfg.proxyWhitelist = new Set(raw.proxyWhitelist.filter(function(ip) {
        return typeof ip === 'string' && ip.length < 64;
      }));
    }
    return Object.keys(cfg).length > 0 ? cfg : null;
  }

  _buildApprovalRoutes(self) {
    return {
      '/api/approval/request': (body) => {
        const agErr = _validateRequiredString(body, 'agentId', 128);
        if (agErr) return agErr;
        const opErr = _validateRequiredString(body, 'operation');
        if (opErr) return opErr;
        return { message: 'Use requestApproval() via runtime, then resolve via /api/approval/approve or /api/approval/reject' };
      },
      '/api/approval/approve': (body, req) => {
        const ridErr = _validateRequiredString(body, 'requestId', 256);
        if (ridErr) return ridErr;
        const ridFmtErr = _validateIdFormat(body.requestId, 'requestId');
        if (ridFmtErr) return ridFmtErr;
        const cmtErr = _validateOptionalString(body.comment, 'comment', 1000);
        if (cmtErr) return cmtErr;
        const resolver = Security.extractCallerId(req, self._serverConfig) ?? 'dashboard';
        const comment = typeof body.comment === 'string' ? body.comment.slice(0, MAX_COMMENT_LENGTH) : '';
        const resolved = self._approvalGate.approve(body.requestId, resolver, comment);
        if (!resolved) return { _status: 404, _data: { error: 'Approval request not found or already resolved' } };
        return { approved: true, requestId: body.requestId };
      },
      '/api/approval/reject': (body, req) => {
        const rid2Err = _validateRequiredString(body, 'requestId', 256);
        if (rid2Err) return rid2Err;
        const rid2FmtErr = _validateIdFormat(body.requestId, 'requestId');
        if (rid2FmtErr) return rid2FmtErr;
        const cmt2Err = _validateOptionalString(body.comment, 'comment', 1000);
        if (cmt2Err) return cmt2Err;
        const resolver = Security.extractCallerId(req, self._serverConfig) ?? 'dashboard';
        const comment = typeof body.comment === 'string' ? body.comment.slice(0, MAX_COMMENT_LENGTH) : '';
        const resolved = self._approvalGate.reject(body.requestId, resolver, comment);
        if (!resolved) return { _status: 404, _data: { error: 'Approval request not found or already resolved' } };
        return { approved: false, requestId: body.requestId };
      },
    };
  }

  _buildAutoVersionRoutes(self, _validateStringLength) {
    return {
      '/api/auto-version/record': (body) => {
        return self._recordAIModification(body, _validateStringLength);
      },
    };
  }

  _buildTokenRoutes(self) {
    return {
      '/api/token/record': (body) => {
        const session = self._rt('session');
        const tokenManager = self._rt('tokenManager');
        if (!session && !tokenManager) return self._moduleUnavailable('Token tracking not available');
        const validationErr = self._validateTokenRecordBody(body);
        if (validationErr) return validationErr;
        const tokens = Number(body.tokens);
        const result = { sessionId: body.sessionId, tokensRecorded: tokens };
        self._recordToSession(session, body.sessionId, tokens, result);
        self._recordToTokenManager(tokenManager, body, tokens, result);
        const logger = self._rt('logger');
        if (logger) {
          logger.log({ agent: 'system', action: 'token-record', target: body.sessionId, result: 'recorded', details: JSON.stringify({ tokens, inputTokens: body.inputTokens, outputTokens: body.outputTokens, toolCallTokens: body.toolCallTokens }) });
        }
        return result;
      },
    };
  }

  _buildConversationRoutes(self) {
    return {
      '/api/conversation/pin': (body) => {
        const store = self._rt('conversationContextStore');
        if (!store) return self._moduleUnavailable('Conversation store not available');
        if (!body || !body.sessionId || typeof body.sessionId !== 'string') {
          return { _status: 400, _data: { error: 'sessionId is required' } };
        }
        const pinned = body.pinned !== false;
        const ok = store.pinSession(body.sessionId, pinned);
        return { success: ok, sessionId: body.sessionId, pinned };
      },
      '/api/conversation/export': (body) => {
        const store = self._rt('conversationContextStore');
        if (!store) return self._moduleUnavailable('Conversation store not available');
        if (!body || !body.sessionId || typeof body.sessionId !== 'string') {
          return { _status: 400, _data: { error: 'sessionId is required' } };
        }
        const format = body.format === 'markdown' ? 'markdown' : 'json';
        const content = store.exportSession(body.sessionId, { format, includeMetadata: body.includeMetadata !== false });
        if (!content) return { _status: 404, _data: { error: 'Session not found' } };
        return { sessionId: body.sessionId, format, content };
      },
      '/api/conversation/search': (body) => {
        const store = self._rt('conversationContextStore');
        if (!store) return self._moduleUnavailable('Conversation store not available');
        if (!body || !body.query || typeof body.query !== 'string') {
          return { _status: 400, _data: { error: 'query is required' } };
        }
        const limit = Math.min(Math.max(Number.isFinite(body.limit) ? body.limit : 20, 1), 100);
        const offset = Math.max(Number.isFinite(body.offset) ? body.offset : 0, 0);
        const results = store.searchTurns(body.query, {
          limit,
          offset,
          role: body.role || null,
          sessionId: body.sessionId || null,
        });
        return { query: body.query, results, count: results.length };
      },
      '/api/conversation/pinned': () => {
        const store = self._rt('conversationContextStore');
        if (!store) return self._moduleUnavailable('Conversation store not available');
        return { pinnedSessions: store.getPinnedSessions() };
      },
    };
  }

  /**
   * 构建聊天交互API路由。融合自Hermes Desktop"一站式对话管理"功能，
   * 提供消息发送、会话历史、会话列表等交互式聊天端点。
   * 与ConversationContextStore深度集成，支持多会话管理和上下文切换。
   */
  _buildChatRoutes(self) {
    const CHAT_MAX_MESSAGE_LENGTH = 32000;
    const CHAT_MAX_SESSIONS_LIST = 100;

    return {
      '/api/chat/send': (body) => {
        const store = self._rt('conversationContextStore');
        if (!store) return self._moduleUnavailable('Conversation store not available');
        if (!body || !body.message || typeof body.message !== 'string') {
          return { _status: 400, _data: { error: 'message is required and must be a string' } };
        }
        const message = body.message.trim();
        if (message.length === 0) {
          return { _status: 400, _data: { error: 'message cannot be empty' } };
        }
        if (message.length > CHAT_MAX_MESSAGE_LENGTH) {
          return { _status: 400, _data: { error: 'message exceeds maximum length of ' + CHAT_MAX_MESSAGE_LENGTH } };
        }
        const sessionId = body.sessionId || store.getActiveSessionId();
        if (!sessionId) {
          return { _status: 400, _data: { error: 'No active session. Provide sessionId or start a session first.' } };
        }
        const session = store.getSessionContext(sessionId, { includeTurns: false });
        if (!session) {
          return { _status: 404, _data: { error: 'Session not found: ' + sessionId } };
        }
        const userTurn = store.recordTurn({
          role: 'user',
          content: message,
          metadata: { type: 'chat', source: 'dashboard' },
        }, sessionId);
        const agentRuntime = self._rt('agentRuntime');
        let agentResponse = null;
        let responseTurn = null;
        if (agentRuntime && typeof agentRuntime.buildPrompt === 'function') {
          agentResponse = self._buildChatAgentResponse(store, sessionId, message);
        } else {
          agentResponse = {
            type: 'echo',
            message: message,
            sessionId: sessionId,
            timestamp: Date.now(),
            note: 'Agent runtime not available. Message recorded but no AI processing performed.',
          };
        }
        if (agentResponse) {
          responseTurn = store.recordTurn({
            role: 'assistant',
            content: typeof agentResponse === 'string' ? agentResponse : JSON.stringify(agentResponse),
            metadata: { type: 'chat-response', source: 'dashboard' },
          }, sessionId);
        }
        return {
          success: true,
          sessionId: sessionId,
          userTurn: userTurn,
          response: agentResponse,
          responseTurn: responseTurn,
        };
      },
      '/api/chat/history': (body) => {
        const store = self._rt('conversationContextStore');
        if (!store) return self._moduleUnavailable('Conversation store not available');
        const sessionId = body && body.sessionId ? body.sessionId : store.getActiveSessionId();
        if (!sessionId) {
          return { _status: 400, _data: { error: 'sessionId is required or an active session must exist' } };
        }
        const limit = Math.min(Math.max((body && Number.isFinite(body.limit) ? body.limit : 50), 1), 200);
        const offset = Math.max(Number.isFinite(body && body.offset) ? body.offset : 0, 0);
        const context = store.getSessionContext(sessionId, { includeTurns: true, maxTurns: limit + offset, format: 'full' });
        if (!context) {
          return { _status: 404, _data: { error: 'Session not found' } };
        }
        const turns = (context.turns ?? []).slice(offset, offset + limit);
        return {
          sessionId: sessionId,
          turns: turns,
          totalTurns: context.turnCount,
          hasMore: context.turnCount > offset + limit,
        };
      },
      '/api/chat/sessions': () => {
        const store = self._rt('conversationContextStore');
        if (!store) return self._moduleUnavailable('Conversation store not available');
        const activeId = store.getActiveSessionId();
        const pinned = store.getPinnedSessions();
        const allSessions = store.listSessions ? store.listSessions() : [];
        const sessions = allSessions.slice(0, CHAT_MAX_SESSIONS_LIST).map(function(s) {
          return {
            sessionId: s.sessionId,
            startedAt: s.startedAt,
            lastActivityAt: s.lastActivityAt,
            turnCount: s.turnCount,
            summary: s.summary || null,
            ended: s.ended ?? false,
            pinned: pinned.some(function(p) { return p.sessionId === s.sessionId; }),
            active: s.sessionId === activeId,
          };
        });
        return { sessions: sessions, activeSessionId: activeId, total: allSessions.length };
      },
      '/api/chat/start': (body) => {
        const store = self._rt('conversationContextStore');
        if (!store) return self._moduleUnavailable('Conversation store not available');
        const sessionId = (body && body.sessionId) || ('chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
        if (body && body.sessionId) {
          const sidErr = _validateIdFormat(body.sessionId, 'sessionId');
          if (sidErr) return sidErr;
        }
        const metadata = (body && body.metadata) ?? {};
        metadata.source = 'dashboard';
        metadata.type = 'chat';
        try {
          const result = store.startSession(sessionId, metadata);
          return { success: true, sessionId: result.sessionId, restored: result.restored };
        } catch (err) {
          debug('Server', 'chatStart', err);
          return { _status: 400, _data: { error: 'Failed to start session' } };
        }
      },
      '/api/chat/end': (body) => {
        const store = self._rt('conversationContextStore');
        if (!store) return self._moduleUnavailable('Conversation store not available');
        const summary = body && body.summary ? (typeof body.summary === 'string' ? body.summary.slice(0, 2000) : String(body.summary).slice(0, 2000)) : undefined;
        const result = store.endSession(summary);
        if (!result) {
          return { _status: 400, _data: { error: 'No active session to end' } };
        }
        return { success: true, sessionId: result.sessionId, turnCount: result.turnCount, summary: result.summary };
      },
    };
  }

  /**
   * 构建聊天Agent响应。提取自_buildChatRoutes以降低圈复杂度。
   */
  _buildChatAgentResponse(store, sessionId, message) {
    try {
      const context = store.getSessionContext(sessionId, { includeTurns: true, maxTurns: 20, format: 'compact' });
      const recentMessages = (context.turns ?? []).map(function(turn) {
        return { role: turn.role, content: turn.content };
      });
      const skillRouter = this._rt('skillRouter');
      let matchedSkills = [];
      if (skillRouter && typeof skillRouter.match === 'function') {
        try {
          matchedSkills = skillRouter.match({ userMessage: message, completedSkills: [] }) ?? [];
        } catch (_e) { debug('Server', 'skillMatching', _e && _e.message ? _e.message : String(_e)); matchedSkills = []; this._skillMatchError = _e && _e.message ? _e.message : String(_e); }
      }
      return {
        type: 'acknowledgment',
        message: message,
        contextLength: recentMessages.length,
        matchedSkills: matchedSkills.slice(0, 5).map(function(s) { return s.id || s.name || String(s); }),
        sessionId: sessionId,
        timestamp: Date.now(),
      };
    } catch (agentErr) {
      debug('Server', 'chatAgentError', agentErr);
      return {
        type: 'error',
        message: 'Agent processing failed',
        sessionId: sessionId,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * 构建终端执行API路由。提供受限的命令执行能力，采用多层安全防护：
   * - 命令白名单（移除node/npm/npx/sed/awk等高危命令）
   * - 危险参数检测(-e/--eval/-c/--command/-i/--interactive/exec)
   * - Shell元字符拦截(;|&`$()${})
   * - 命令长度限制、执行超时、输出缓冲区限制
   * - shell:false禁止shell解释、最小化环境变量
   */
  _buildTerminalRoutes(self) {
    const TERMINAL_TIMEOUT_MS = 30000;
    const TERMINAL_MAX_BUFFER = 1024 * 1024;
    const TERMINAL_MAX_CMD_LENGTH = 4096;
    const TERMINAL_ALLOWED_COMMANDS = new Set([
      'git', 'echo', 'cat', 'ls', 'mkdir', 'cp', 'mv', 'test', 'true', 'false',
      'date', 'wc', 'head', 'tail', 'sort', 'uniq', 'diff', 'which', 'pwd', 'env',
      'grep', 'find', 'rg', 'ag', 'tr', 'cut', 'tee', 'touch',
    ]);
    const TERMINAL_DANGEROUS_ARGS = /\s+(-e|--eval|-c|--command|-i|--interactive|exec)\b/;
    const SHELL_META_RE = /[;|&`$]|(?:\$\(|\$\{)/;

    return {
      '/api/terminal/execute': async (body) => {
        const terminalEnabled = self._devMode || process.env.HARNESS_TERMINAL_ENABLED === 'true';
        if (!terminalEnabled) {
          return { _status: 403, _data: { error: 'Terminal API is disabled. Enable via HARNESS_TERMINAL_ENABLED=true or dev mode.' } };
        }
        if (!body || !body.command || typeof body.command !== 'string') {
          return { _status: 400, _data: { error: 'command is required and must be a string' } };
        }
        const cmd = body.command.trim();
        if (cmd.length === 0 || cmd.length > TERMINAL_MAX_CMD_LENGTH) {
          return { _status: 400, _data: { error: 'command must be 1-' + TERMINAL_MAX_CMD_LENGTH + ' characters' } };
        }
        if (SHELL_META_RE.test(cmd)) {
          return { _status: 400, _data: { error: 'Shell metacharacters (;|&`$()${}) are not allowed.' } };
        }
        if (TERMINAL_DANGEROUS_ARGS.test(cmd)) {
          return { _status: 400, _data: { error: 'Dangerous command arguments (-e/--eval/-c/--command/-i/--interactive/exec) are not allowed.' } };
        }
        const parts = cmd.split(/\s+/);
        const executable = parts[0];
        const args = parts.slice(1);
        if (!TERMINAL_ALLOWED_COMMANDS.has(executable)) {
          return { _status: 403, _data: { error: 'Command not in allowed list: ' + executable, allowedCommands: Array.from(TERMINAL_ALLOWED_COMMANDS).sort() } };
        }
        const execOptions = {
          cwd: self.root,
          timeout: TERMINAL_TIMEOUT_MS,
          maxBuffer: TERMINAL_MAX_BUFFER,
          shell: false,
          env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', USERPROFILE: process.env.USERPROFILE || '', LANG: process.env.LANG || '', TERM: 'dumb', NODE_ENV: process.env.NODE_ENV || 'production' },
        };
        return new Promise((resolve) => {
          execFile(executable, args, execOptions, (err, stdout, stderr) => {
            if (err) {
              return resolve({ success: false, output: (stderr || err.message || String(err)).slice(0, TERMINAL_MAX_BUFFER), command: cmd, exitCode: (typeof err.code === 'number') ? err.code : 1, timedOut: err.killed === true });
            }
            resolve({ success: true, output: (stdout || '').slice(0, TERMINAL_MAX_BUFFER), command: cmd, exitCode: 0, truncated: stdout ? stdout.length > TERMINAL_MAX_BUFFER : false });
          });
        });
      },
      '/api/terminal/allowed-commands': () => {
        return { commands: Array.from(TERMINAL_ALLOWED_COMMANDS).sort() };
      },
      '/api/terminal/commands': () => {
        const commandRouter = self._rt('commandRouter');
        if (!commandRouter) return self._moduleUnavailable('Command router not available');
        const commands = typeof commandRouter.listCommands === 'function' ? commandRouter.listCommands() : [];
        return { commands };
      },
    };
  }

  /**
   * 构建文件浏览器API路由。基于ServiceFS虚拟文件系统，提供统一的文件操作REST端点。
   * 融合自Hermes Desktop"内置文件管理"功能，支持目录浏览、文件读写、目录树生成等操作。
   * 安全措施：路径遍历防护（ServiceFS.resolve内建）、操作白名单、内容大小限制。
   */
  _buildFileBrowserRoutes(self) {
    const FB_MAX_PATH_LENGTH = 512;
    const FB_MAX_WRITE_SIZE = 1024 * 1024;
    const FB_MAX_TREE_DEPTH = 8;
    const FB_MAX_LIST_LIMIT = 200;

    return {
      '/api/fs/list': (body) => {
        const serviceFS = self._rt('serviceFS');
        if (!serviceFS) return self._moduleUnavailable('ServiceFS not available');
        if (!body || !body.path || typeof body.path !== 'string') {
          return { _status: 400, _data: { error: 'path is required and must be a string' } };
        }
        if (body.path.length > FB_MAX_PATH_LENGTH) {
          return { _status: 400, _data: { error: 'path exceeds maximum length (' + FB_MAX_PATH_LENGTH + ')' } };
        }
        try {
          const entries = serviceFS.ls(body.path);
          const limit = Math.min(Math.abs(body.limit ?? FB_MAX_LIST_LIMIT), FB_MAX_LIST_LIMIT);
          return { path: body.path, entries: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit };
        } catch (err) {
          if (err.code === 'RESOURCE_NOT_FOUND') return { _status: 404, _data: { error: err.message } };
          if (err.code === 'INVALID_INPUT') return { _status: 400, _data: { error: err.message } };
          return { _status: 500, _data: { error: 'Failed to list path' } };
        }
      },
      '/api/fs/read': (body) => {
        const serviceFS = self._rt('serviceFS');
        if (!serviceFS) return self._moduleUnavailable('ServiceFS not available');
        if (!body || !body.path || typeof body.path !== 'string') {
          return { _status: 400, _data: { error: 'path is required and must be a string' } };
        }
        if (body.path.length > FB_MAX_PATH_LENGTH) {
          return { _status: 400, _data: { error: 'path exceeds maximum length (' + FB_MAX_PATH_LENGTH + ')' } };
        }
        try {
          const content = serviceFS.cat(body.path);
          return { path: body.path, content: content, size: typeof content === 'string' ? content.length : 0 };
        } catch (err) {
          if (err.code === 'RESOURCE_NOT_FOUND') return { _status: 404, _data: { error: err.message } };
          if (err.code === 'INVALID_INPUT') return { _status: 400, _data: { error: err.message } };
          return { _status: 500, _data: { error: 'Failed to read file' } };
        }
      },
      '/api/fs/write': (body) => {
        const serviceFS = self._rt('serviceFS');
        if (!serviceFS) return self._moduleUnavailable('ServiceFS not available');
        if (!body || !body.path || typeof body.path !== 'string') {
          return { _status: 400, _data: { error: 'path is required and must be a string' } };
        }
        if (body.path.length > FB_MAX_PATH_LENGTH) {
          return { _status: 400, _data: { error: 'path exceeds maximum length (' + FB_MAX_PATH_LENGTH + ')' } };
        }
        if (body.content === undefined || body.content === null) {
          return { _status: 400, _data: { error: 'content is required' } };
        }
        if (typeof body.content !== 'string') {
          return { _status: 400, _data: { error: 'content must be a string' } };
        }
        const contentStr = body.content;
        if (contentStr.length > FB_MAX_WRITE_SIZE) {
          return { _status: 400, _data: { error: 'content exceeds maximum size (' + FB_MAX_WRITE_SIZE + ' bytes)' } };
        }
        try {
          const result = serviceFS.write(body.path, contentStr);
          return { success: !!result, path: body.path, size: contentStr.length };
        } catch (err) {
          if (err.code === 'RESOURCE_NOT_FOUND') return { _status: 404, _data: { error: err.message || String(err) } };
          if (err.code === 'INVALID_INPUT') return { _status: 400, _data: { error: err.message || String(err) } };
          return { _status: 500, _data: { error: 'Failed to write file' } };
        }
      },
      '/api/fs/remove': (body) => {
        const serviceFS = self._rt('serviceFS');
        if (!serviceFS) return self._moduleUnavailable('ServiceFS not available');
        if (!body || !body.path || typeof body.path !== 'string') {
          return { _status: 400, _data: { error: 'path is required and must be a string' } };
        }
        if (body.path.length > FB_MAX_PATH_LENGTH) {
          return { _status: 400, _data: { error: 'path exceeds maximum length (' + FB_MAX_PATH_LENGTH + ')' } };
        }
        try {
          const result = serviceFS.rm(body.path);
          return { success: !!result, path: body.path };
        } catch (err) {
          if (err.code === 'RESOURCE_NOT_FOUND') return { _status: 404, _data: { error: err.message } };
          if (err.code === 'INVALID_INPUT') return { _status: 400, _data: { error: err.message } };
          return { _status: 500, _data: { error: 'Failed to remove path' } };
        }
      },
      '/api/fs/exists': (body) => {
        const serviceFS = self._rt('serviceFS');
        if (!serviceFS) return self._moduleUnavailable('ServiceFS not available');
        if (!body || !body.path || typeof body.path !== 'string') {
          return { _status: 400, _data: { error: 'path is required and must be a string' } };
        }
        if (body.path.length > FB_MAX_PATH_LENGTH) {
          return { _status: 400, _data: { error: 'path exceeds maximum length (' + FB_MAX_PATH_LENGTH + ')' } };
        }
        try {
          const exists = serviceFS.exists(body.path);
          return { path: body.path, exists };
        } catch (err) {
          if (err.code === 'INVALID_INPUT') return { _status: 400, _data: { error: err.message || String(err) } };
          return { path: body.path, exists: false };
        }
      },
      '/api/fs/tree': (body) => {
        const serviceFS = self._rt('serviceFS');
        if (!serviceFS) return self._moduleUnavailable('ServiceFS not available');
        if (body && body.path && typeof body.path !== 'string') return { _status: 400, _data: { error: 'path must be a string' } };
        const depth = Math.min(Math.abs(body?.depth ?? FB_MAX_TREE_DEPTH), FB_MAX_TREE_DEPTH);
        try {
          const treeStr = serviceFS.tree(body?.path || null, depth);
          return { path: body?.path || '/', depth, tree: treeStr };
        } catch (err) {
          if (err.code === 'RESOURCE_NOT_FOUND') return { _status: 404, _data: { error: err.message } };
          if (err.code === 'INVALID_INPUT') return { _status: 400, _data: { error: err.message } };
          return { _status: 500, _data: { error: 'Failed to generate tree' } };
        }
      },
      '/api/fs/stats': () => {
        const serviceFS = self._rt('serviceFS');
        if (!serviceFS) return self._moduleUnavailable('ServiceFS not available');
        return serviceFS.getStats();
      },
    };
  }

  /**
   * 构建主题配置API路由。融合自Hermes Desktop"个性化主题"功能，
   * 返回系统支持的主题列表和当前配置。
   */
  _buildThemeRoutes() {
    const SUPPORTED_THEMES = [
      { id: 'dark', label: '暗色', description: '默认深色主题' },
      { id: 'light', label: '亮色', description: '浅色主题' },
      { id: 'ocean', label: '海洋', description: '深蓝绿色调主题' },
      { id: 'forest', label: '森林', description: '深绿色调主题' },
      { id: 'sunset', label: '日落', description: '暖琥珀玫瑰色调主题' },
    ];
    return {
      '/api/themes': () => ({ themes: SUPPORTED_THEMES, default: 'dark' }),
    };
  }

  /**
   * 构建Harness迁移性API路由。融合自Anthropic Harness设计理念，
   * 提供模型能力等级查询、组件承重调整、迁移报告等端点。
   */
  _buildHarnessMigrationRoutes(self) {
    return {
      '/api/harness/migration/report': () => {
        const engine = self._rt('harnessMigrationEngine');
        if (!engine) return { tier: 'unknown', activeComponents: [], inactiveComponents: [] };
        return engine.getMigrationReport();
      },
      '/api/harness/migration/tier': (body) => {
        const engine = self._rt('harnessMigrationEngine');
        if (!engine) return { _status: 503, _data: { error: 'HarnessMigrationEngine not available' } };
        if (!body || !body.tier || typeof body.tier !== 'string') {
          return { _status: 400, _data: { error: 'tier is required (weak/standard/strong/frontier)' } };
        }
        const validTiers = ['weak', 'standard', 'strong', 'frontier'];
        if (!validTiers.includes(body.tier)) {
          return { _status: 400, _data: { error: 'Invalid tier. Must be: weak/standard/strong/frontier' } };
        }
        return engine.updateTier(body.tier);
      },
      '/api/harness/calibration/report': () => {
        const calibrator = self._rt('evaluationCalibrator');
        if (!calibrator) return { sampleSize: 0, calibrationError: 0, bias: 'unknown' };
        return calibrator.getCalibrationReport();
      },
      '/api/harness/lifecycle/status': () => {
        const orchestrator = self._rt('taskLifecycleOrchestrator');
        if (!orchestrator) return { phase: 'unavailable', currentRound: 0, maxRounds: 0, contextMode: 'normal', evaluationThreshold: 0, evaluationCount: 0, hasSpec: false };
        return orchestrator.getStatus();
      },
    };
  }

  _validateTokenRecordBody(body) {
    const sidErr = _validateRequiredString(body, 'sessionId');
    if (sidErr) return sidErr;
    const sidFmtErr = _validateIdFormat(body.sessionId, 'sessionId');
    if (sidFmtErr) return sidFmtErr;
    const tokens = Number(body.tokens);
    if (!Number.isFinite(tokens) || tokens < 0) {
      return { _status: 400, _data: { error: 'tokens must be a non-negative number' } };
    }
    if (tokens > 1e9) {
      return { _status: 400, _data: { error: 'tokens exceeds maximum single record limit' } };
    }
    return null;
  }

  _recordToSession(session, sessionId, tokens, result) {
    if (!session || !session.sessions || !session.sessions[sessionId]) return;
    try {
      session.addTokenUsage(sessionId, tokens);
      const sess = session.sessions[sessionId];
      if (sess) result.sessionTokensUsed = sess.tokensUsed;
    } catch (recErr) {
      debug('Dashboard', 'sessionRecord', recErr);
      result.sessionError = 'session_recording_failed';
    }
  }

  _recordToTokenManager(tokenManager, body, tokens, result) {
    if (!tokenManager) return;
    try {
      tokenManager.store(body.sessionId, tokens);
      if (body.inputTokens) tokenManager.addBreakdown(body.sessionId, 'input', Number.isFinite(Number(body.inputTokens)) ? Number(body.inputTokens) : 0);
      if (body.outputTokens) tokenManager.addBreakdown(body.sessionId, 'output', Number.isFinite(Number(body.outputTokens)) ? Number(body.outputTokens) : 0);
      if (body.toolCallTokens) tokenManager.addBreakdown(body.sessionId, 'toolCall', Number.isFinite(Number(body.toolCallTokens)) ? Number(body.toolCallTokens) : 0);
      const validation = tokenManager.validate(body.sessionId);
      if (!validation || typeof validation !== 'object') {
        result.tokenManagerError = 'Token validation returned invalid result';
      } else {
        result.tokenManagerTotal = validation.tokensUsed;
        result.budgetStatus = {
          warning80: validation.warning80,
          warning95: validation.warning95,
          exhausted: validation.exhausted,
          ratio: validation.ratio,
        };
      }
    } catch (_e) {
      debug('DashboardServer', '_recordTokenUsage', _e && _e.message ? _e.message : String(_e));
      result.tokenManagerError = 'Token recording failed';
    }
  }

  _sanitizeStringField(value, maxLen, defaultVal) {
    return (typeof value === 'string') ? value.slice(0, maxLen) : defaultVal;
  }

  _sanitizeStringArray(arr, maxItems, maxItemLen) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, maxItems).filter(function(f) { return typeof f === 'string' && f.length <= maxItemLen; });
  }

  _recordAIModification(body, _validateStringLength) {
    const { _mod: avt, _err: avtErr } = _requireModule(this, 'autoVersionTracker', 'AutoVersionTracker');
    if (avtErr) return avtErr;

    if (!body || typeof body !== 'object') {
      return { _status: 400, _data: { error: 'Request body must be a JSON object' } };
    }

    const summary = body.summary;
    if (!summary || typeof summary !== 'string') {
      return { _status: 400, _data: { error: 'summary (string) is required' } };
    }
    const summaryErr = _validateStringLength(summary, 'summary', 500);
    if (summaryErr) return { _status: 400, _data: { error: summaryErr } };

    const validCategories = ['新增', '变更', '修复', '移除'];
    if (body.category && !validCategories.includes(body.category)) {
      return { _status: 400, _data: { error: 'category must be one of: ' + validCategories.join(', ') } };
    }

    const modification = {
      summary: summary.slice(0, MAX_SUMMARY_LENGTH),
      category: body.category ?? '变更',
      agent: this._sanitizeStringField(body.agent, 128, 'AI'),
      files: this._sanitizeStringArray(body.files, 50, 512),
      module: this._sanitizeStringField(body.module, 128, ''),
      method: this._sanitizeStringField(body.method, 128, ''),
      value: this._sanitizeStringField(body.value, 500, ''),
      details: this._sanitizeStringField(body.details, 2000, ''),
      subItems: this._sanitizeStringArray(body.subItems, 30, 500),
      sourceEvent: this._sanitizeStringField(body.sourceEvent, 128, 'ai:code-modified'),
      phase: this._sanitizeStringField(body.phase, 64, ''),
    };

    const result = avt.recordAIModification(modification);

    if (result.success) {
      this.invalidateCache('changelog');
      const ws = this._ws;
      if (ws && ws.broadcast) {
        ws.broadcast('version-update', {
          version: result.version, summary: result.summary, category: modification.category, agent: modification.agent,
        });
      }
    }

    return result;
  }

  _buildGoalRoutes(self) {
    function _validateGoalCreate(body) {
      const objErr = _validateRequiredString(body, 'objective', C.MAX_OBJECTIVE_LENGTH);
      if (objErr) return objErr;
      const arrErr = _validateGoalArrays(body);
      if (arrErr) return arrErr;
      const ctxErr = _validateGoalContext(body.context);
      if (ctxErr) return ctxErr;
      if (body.maxIterations !== undefined && (typeof body.maxIterations !== 'number' || body.maxIterations < 1 || body.maxIterations > 100)) return { _status: 400, _data: { error: 'maxIterations must be between 1 and 100' } };
      if (body.convergenceThreshold !== undefined && (typeof body.convergenceThreshold !== 'number' || body.convergenceThreshold < 0 || body.convergenceThreshold > 1)) return { _status: 400, _data: { error: 'convergenceThreshold must be between 0 and 1' } };
      return null;
    }
    function _validateGoalArrays(body) {
      if (body.successCriteria && !Array.isArray(body.successCriteria)) return { _status: 400, _data: { error: 'successCriteria must be an array' } };
      if (body.successCriteria && body.successCriteria.length > 50) return { _status: 400, _data: { error: 'successCriteria exceeds maximum items (50)' } };
      if (body.constraints && !Array.isArray(body.constraints)) return { _status: 400, _data: { error: 'constraints must be an array' } };
      if (body.constraints && body.constraints.length > 50) return { _status: 400, _data: { error: 'constraints exceeds maximum items (50)' } };
      return null;
    }
    function _validateGoalContext(ctx) {
      if (ctx === undefined) return null;
      if (typeof ctx !== 'object' || ctx === null || Array.isArray(ctx)) return { _status: 400, _data: { error: 'context must be an object' } };
      try { if (JSON.stringify(ctx).length > C.MAX_CONTEXT_SIZE) return { _status: 400, _data: { error: 'context exceeds maximum size' } }; } catch (ctxErr) { debug('Dashboard', 'contextValidate', ctxErr); return { _status: 400, _data: { error: 'context is not serializable' } }; }
      return null;
    }
    return {
      '/api/goal/create': (body) => {
        const { _mod: ge, _err: geErr } = _requireModule(self, 'goalExecutor', 'GoalExecutor');
        if (geErr) return geErr;
        const validationErr = _validateGoalCreate(body);
        if (validationErr) return validationErr;
        return ge.createGoal(body.objective, {
          successCriteria: body.successCriteria,
          constraints: body.constraints,
          context: body.context,
          maxIterations: body.maxIterations,
          convergenceThreshold: body.convergenceThreshold,
        });
      },
      '/api/goal/pause': (body) => {
        const { _mod: ge, _err: geErr } = _requireModule(self, 'goalExecutor', 'GoalExecutor');
        if (geErr) return geErr;
        const gidErr = _validateGoalId(body);
        if (gidErr) return gidErr;
        return ge.pause(body.goalId);
      },
      '/api/goal/resume': (body) => {
        const { _mod: ge, _err: geErr } = _requireModule(self, 'goalExecutor', 'GoalExecutor');
        if (geErr) return geErr;
        const gidErr2 = _validateGoalId(body);
        if (gidErr2) return gidErr2;
        return ge.resume(body.goalId);
      },
      '/api/goal/cancel': (body) => {
        const { _mod: ge, _err: geErr } = _requireModule(self, 'goalExecutor', 'GoalExecutor');
        if (geErr) return geErr;
        const gidErr3 = _validateGoalId(body);
        if (gidErr3) return gidErr3;
        return ge.cancel(body.goalId);
      },
      '/api/goal/progress': (body) => {
        const { _mod: ge, _err: geErr } = _requireModule(self, 'goalExecutor', 'GoalExecutor');
        if (geErr) return geErr;
        const gidErr4 = _validateGoalId(body);
        if (gidErr4) return gidErr4;
        const progress = ge.getProgress(body.goalId);
        if (!progress) return { _status: 404, _data: { error: 'Goal not found' } };
        return progress;
      },

      // --- Managed Agent API ---
      '/api/managed-agents/list': () => {
        const { _mod: mah } = _requireModule(self, 'managedAgentHost', 'ManagedAgentHost');
        if (!mah) return { agents: [], stats: {} };
        return { agents: mah.listAgents(), stats: mah.getStats() };
      },
      '/api/managed-agents/status': (body) => {
        const { _mod: mah } = _requireModule(self, 'managedAgentHost', 'ManagedAgentHost');
        if (!mah) return { _status: 404, _data: { error: 'ManagedAgentHost not available' } };
        const idErr = _validateRequiredString(body, 'agentId', 128);
        if (idErr) return idErr;
        const fmtErr = _validateIdFormat(body.agentId, 'agentId');
        if (fmtErr) return fmtErr;
        const status = mah.getAgentStatus(body.agentId);
        if (!status) return { _status: 404, _data: { error: 'Agent not found' } };
        return status;
      },
      '/api/managed-agents/start': (body) => {
        const { _mod: mah } = _requireModule(self, 'managedAgentHost', 'ManagedAgentHost');
        if (!mah) return { _status: 503, _data: { error: 'ManagedAgentHost not available' } };
        const idErr = _validateRequiredString(body, 'agentId', 128);
        if (idErr) return idErr;
        const fmtErr = _validateIdFormat(body.agentId, 'agentId');
        if (fmtErr) return fmtErr;
        const ok = mah.startAgent(body.agentId);
        return ok ? { started: true, agentId: body.agentId } : { _status: 400, _data: { error: 'Cannot start agent' } };
      },
      '/api/managed-agents/pause': (body) => {
        const { _mod: mah } = _requireModule(self, 'managedAgentHost', 'ManagedAgentHost');
        if (!mah) return { _status: 503, _data: { error: 'ManagedAgentHost not available' } };
        const idErr = _validateRequiredString(body, 'agentId', 128);
        if (idErr) return idErr;
        const fmtErr = _validateIdFormat(body.agentId, 'agentId');
        if (fmtErr) return fmtErr;
        const ok = mah.pauseAgent(body.agentId);
        return ok ? { paused: true, agentId: body.agentId } : { _status: 400, _data: { error: 'Cannot pause agent' } };
      },
      '/api/managed-agents/trigger': (body) => {
        const { _mod: mah } = _requireModule(self, 'managedAgentHost', 'ManagedAgentHost');
        if (!mah) return { _status: 503, _data: { error: 'ManagedAgentHost not available' } };
        const idErr = _validateRequiredString(body, 'agentId', 128);
        if (idErr) return idErr;
        const fmtErr = _validateIdFormat(body.agentId, 'agentId');
        if (fmtErr) return fmtErr;
        return mah.triggerExecution(body.agentId, { triggerSource: 'api', payload: body.payload });
      },
      '/api/managed-agents/history': (body) => {
        const { _mod: mah } = _requireModule(self, 'managedAgentHost', 'ManagedAgentHost');
        if (!mah) return { history: [] };
        const idErr = _validateRequiredString(body, 'agentId', 128);
        if (idErr) return idErr;
        const fmtErr = _validateIdFormat(body.agentId, 'agentId');
        if (fmtErr) return fmtErr;
        const limit = Math.min(Math.max(Number.isFinite(body.limit) ? body.limit : 20, 1), 100);
        return { history: mah.getExecutionHistory(body.agentId, limit) };
      },

      // --- Trigger Dispatcher API ---
      '/api/triggers/schedules': () => {
        const { _mod: td } = _requireModule(self, 'triggerDispatcher', 'TriggerDispatcher');
        if (!td) return { schedules: [], stats: {} };
        return { schedules: td.listSchedules(), stats: td.getStats() };
      },
      '/api/triggers/webhooks': () => {
        const { _mod: td } = _requireModule(self, 'triggerDispatcher', 'TriggerDispatcher');
        if (!td) return { routes: [] };
        return { routes: td.listWebhookRoutes() };
      },
      '/api/triggers/fire': (body) => {
        const { _mod: td } = _requireModule(self, 'triggerDispatcher', 'TriggerDispatcher');
        if (!td) return { _status: 503, _data: { error: 'TriggerDispatcher not available' } };
        const idErr = _validateRequiredString(body, 'agentId', 128);
        if (idErr) return idErr;
        const fmtErr = _validateIdFormat(body.agentId, 'agentId');
        if (fmtErr) return fmtErr;
        return td.dispatchFireAndForget(body.agentId, body.payload);
      },
    };
  }

  _rt(name) {
    return (this._runtime && this._runtime[name]) ? this._runtime[name] : null;
  }

  async _moduleStats(moduleName, statsKey, extra) {
    try {
      const mod = this._rt(moduleName);
      if (!mod) {
        const result = { available: false };
        if (statsKey) result[statsKey] = {};
        if (extra) safeAssign(result, extra);
        return result;
      }
      const result = { available: true };
      if (statsKey && typeof mod.getStats === 'function') result[statsKey] = await mod.getStats();
      else if (statsKey) result[statsKey] = {};
      if (extra) safeAssign(result, extra);
      return result;
    } catch (_err) {
      debug('Dashboard', 'moduleStats', (statsKey || 'unknown'), _err && _err.message ? _err.message : String(_err));
      const result = { available: false };
      if (statsKey) result[statsKey] = {};
      if (extra) safeAssign(result, extra);
      return result;
    }
  }

  _moduleUnavailable(message) {
    return { available: false, error: message };
  }

  _requireParam(params, name) { return Validation.requireParam(params, name); }

  _generateCspNonce() {
    try {
      return secureId('', 16);
    } catch (nonceErr) {
      debug('DashboardServer', 'security', 'crypto.randomBytes unavailable - CSP nonce generation failed: ' + (nonceErr && nonceErr.message ? nonceErr.message : String(nonceErr)));
      throw new HarnessError('SECURITY_VIOLATION', 'Secure nonce generation failed - cannot serve request safely', { cause: nonceErr });
    }
  }

  _optionalParam(params, name) { return Validation.optionalParam(params, name); }

  _parseIntParam(params, name, defaultValue) { return Validation.parseIntParam(params, name, defaultValue); }

  _validateAgentId(agentId) { return Validation.validateAgentId(agentId); }

  _validateEnum(value, allowedSet, paramName) { return Validation.validateEnum(value, allowedSet, paramName); }

  async _readFileCached(filePath) {
    const cached = this._fileCache.get(filePath);
    if (cached !== undefined && (Date.now() - cached.ts < this._fileCacheTTL)) return cached.data;
    return safeExecuteAsync(async () => {
      const data = await fs.promises.readFile(filePath, UTF8_ENCODING);
      this._fileCache.set(filePath, { data: data, ts: Date.now() });
      return data;
    }, 'Dashboard', 'fileReadError', null);
  }

  async _readDirCached(dirPath, ext) {
    if (!this._dirCache) this._dirCache = new LRUCache(LRU_DIR_CACHE_SIZE);
    const cacheKey = dirPath + ':' + ext;
    const cached = this._dirCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < this._fileCacheTTL)) return cached.data;
    try {
      try {
        await fs.promises.access(dirPath);
      } catch (_accessErr) { debug('DashboardServer', '_readDirSafe', 'Directory access failed: ' + dirPath); return []; }
      const entries = await fs.promises.readdir(dirPath);
      const data = entries.filter(function(f) { return f.endsWith(ext); });
      this._dirCache.set(cacheKey, { data: data, ts: Date.now() });
      return data;
    } catch (err) {
      debug('Dashboard', 'dirReadError', err);
      return [];
    }
  }

  async _getCachedFrontmatter(filePath) {
    const cached = this._fmCache.get(filePath);
    if (cached !== undefined) return cached;
    const content = await this._readFileCached(filePath);
    if (!content) return null;
    const fm = parseFrontmatter(content);
    if (fm) {
      this._fmCache.set(filePath, fm);
    }
    return fm;
  }

  async _getConfig() {
    const configPath = getHarnessConfigPath(this.root);
    const content = await this._readFileCached(configPath);
    if (!content) return {};
    try {
      const parsed = safeJsonParse(content, null, 'DashboardServer');
      if (!_validateObjectDepth(parsed, 10)) return {};
      return this._sanitizeConfig(parsed);
    } catch (err) {
      debug('Dashboard', 'jsonParseError', err);
      return { _error: err.message || String(err) };
    }
  }

  _sanitizeConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return cfg;
    const result = {};
    for (const key of Object.keys(cfg)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      const isSensitive = _sensitiveKeyPatterns.some(function(p) { return p.test(key); });
      if (isSensitive) {
        result[key] = '***';
      } else if (Array.isArray(cfg[key])) {
        result[key] = cfg[key].map(function(item) {
          if (Array.isArray(item)) return item.map(function(sub) { return (typeof sub === 'object' && sub !== null) ? this._sanitizeConfig(sub) : sub; }.bind(this));
          return (typeof item === 'object' && item !== null) ? this._sanitizeConfig(item) : item;
        }.bind(this));
      } else if (cfg[key] && typeof cfg[key] === 'object') {
        result[key] = this._sanitizeConfig(cfg[key]);
      } else {
        result[key] = cfg[key];
      }
    }
    return result;
  }

  async _getOverview() { return getOverview(this); }

  async _getAgents() { return getAgents(this); }

  async _getSkills() { return getSkills(this); }

  async _getSessions() { return getSessions(this); }

  async _getWorkflow() { return getWorkflow(this, CACHE_TTL); }

  // _getChangelog, _parseChangelogSections, _searchChangelog, _getAudit,
  // _getMemory, _getCheckpoints, _getLearnings, _getWorkflowTemplates,
  // _getCompliance, _getDeviations, _getCodeReviews
  // → 已提取到 dashboard/data-providers/core-query-data.js mixin

  _getHealth() { return getHealth(this); }

  _getLiveness() { return getLiveness(this); }

  _getReadiness() { return getReadiness(this); }

  _getPerformanceStats() { return getPerformanceStats(this); }

  _getThoughtsStats() {
    try {
      const store = this._rt('thoughtMemoryStore');
      if (!store) return { totalThoughts: 0, avgConfidence: 0, byType: {}, byDomain: {} };
      if (typeof store.getStats !== 'function') return { totalThoughts: 0, avgConfidence: 0, byType: {}, byDomain: {} };
      return store.getStats();
    } catch (_err) {
      debug('Dashboard', '_getThoughtsStats', _err && _err.message ? _err.message : String(_err));
      return { totalThoughts: 0, avgConfidence: 0, byType: {}, byDomain: {} };
    }
  }

  _getThoughtsList() {
    try {
      const store = this._rt('thoughtMemoryStore');
      if (!store) return [];
      if (typeof store.retrieveThoughts !== 'function') return [];
      return store.retrieveThoughts({ sortBy: 'recent', limit: 50 });
    } catch (_err) {
      debug('Dashboard', '_getThoughtsList', _err && _err.message ? _err.message : String(_err));
      return [];
    }
  }

  _getEmbeddingStats() {
    try {
      const service = this._rt('embeddingService');
      if (!service) return { totalEmbeddings: 0, provider: 'none', dimensions: 0 };
      if (typeof service.getStats !== 'function') return { totalEmbeddings: 0, provider: 'none', dimensions: 0 };
      return service.getStats();
    } catch (_err) {
      debug('Dashboard', '_getEmbeddingStats', _err && _err.message ? _err.message : String(_err));
      return { totalEmbeddings: 0, provider: 'none', dimensions: 0 };
    }
  }

  _getModelSelectorStats() {
    try {
      const selector = this._rt('modelSelector');
      if (!selector) return { available: false };
      if (typeof selector.getStats !== 'function') return { available: false };
      const stats = selector.getStats();
      return { available: true, stats: stats };
    } catch (_err) {
      debug('Dashboard', '_getModelSelectorStats', _err && _err.message ? _err.message : String(_err));
      return { available: false };
    }
  }

  _getThoughtRetrieverStats() {
    try {
      const cycle = this._rt('thoughtRetrieverCycle');
      if (!cycle) return { available: false };
      if (typeof cycle.getStats !== 'function') return { available: false };
      return { available: true, stats: cycle.getStats() };
    } catch (_err) {
      debug('Dashboard', '_getThoughtRetrieverStats', _err && _err.message ? _err.message : String(_err));
      return { available: false };
    }
  }


  async _getVersion() {
    const data = await this._getCached('version', 5000, async () => {
      let configVersion = '0.0.0';
      try {
        const configPath = getHarnessConfigPath(this.root);
        const configContent = await fs.promises.readFile(configPath, UTF8_ENCODING);
        const configParsed = safeJsonParse(configContent, null, 'DashboardServer');
        configVersion = configParsed ? configParsed.version || '0.0.0' : '0.0.0';
      } catch (err) { debug('DashboardServer', 'getVersionConfig', err); }

      let pkgVersion = '0.0.0';
      try {
        const pkgPath = path.join(this.root, 'package.json');
        const pkgContent = await fs.promises.readFile(pkgPath, UTF8_ENCODING);
        const pkg = safeJsonParse(pkgContent, null, 'DashboardServer');
        pkgVersion = pkg ? pkg.version || '0.0.0' : '0.0.0';
      } catch (err) { debug('DashboardServer', 'getVersionPkg', err); }

      return {
        packageVersion: pkgVersion,
        configVersion: configVersion,
        versionMatch: pkgVersion === configVersion,
        canonicalVersion: pkgVersion,
      };
    });
    return { ...data, timestamp: new Date().toISOString() };
  }

  async _getFrameworkStatus() {
    return getFrameworkStatus(
      this.root, this._rt.bind(this),
      this._getVersion.bind(this), this._getHealth.bind(this),
      this._runtime, _scanMarkdownDir,
    );
  }

  async _getFrameworkArchitecture() {
    const status = await this._getFrameworkStatus();
    const loadedModules = Array.isArray(status.modules.details) ? status.modules.details.filter(function(m) { return m.loaded; }).map(function(m) { return m.name; }) : [];
    const loadedSet = new Set(loadedModules);
    return {
      corePrinciples: ARCHITECTURE_DATA.corePrinciples,
      runtimeModules: ARCHITECTURE_DATA.runtimeModules.map(function(m) {
        return mergeConfig(m, { loaded: loadedSet.has(m.name) });
      }),
      permModules: ARCHITECTURE_DATA.permModules.map(function(m) {
        return mergeConfig(m, { loaded: loadedSet.has(m.name) });
      }),
      permSecurityCapabilities: ARCHITECTURE_DATA.permSecurityCapabilities,
      gateModules: ARCHITECTURE_DATA.gateModules.map(function(m) {
        return mergeConfig(m, { loaded: loadedSet.has(m.name) });
      }),
      initFlow: ARCHITECTURE_DATA.initFlow,
      eventFlow: ARCHITECTURE_DATA.eventFlow,
      apiDataFlow: ARCHITECTURE_DATA.apiDataFlow,
      persistenceMap: ARCHITECTURE_DATA.persistenceMap,
      metrics: {
        coreModuleCount: ARCHITECTURE_DATA.runtimeModules.length + ARCHITECTURE_DATA.permModules.length + ARCHITECTURE_DATA.gateModules.length,
        zeroDependencies: true,
        eventDriven: true,
        atomicWrite: true,
        loadedModules: loadedModules.length,
        totalModules: status.modules.total,
      },
    };
  }

  async _getFrameworkFeatures() {
    let config = {};
    try {
      const configPath = getHarnessConfigPath(this.root);
      const configContent = await fs.promises.readFile(configPath, UTF8_ENCODING);
      config = safeJsonParse(configContent, null, 'DashboardServer');
    } catch (err) { debug('DashboardServer', 'frameworkFeaturesConfig', err); }
    const tddConfig = (config.gate_config && config.gate_config.tdd_gate) ?? config.tdd_config ?? {};
    const rawThreshold = typeof tddConfig.test_coverage_threshold === 'number' && Number.isFinite(tddConfig.test_coverage_threshold) ? tddConfig.test_coverage_threshold : (typeof tddConfig.coverage_threshold === 'number' && Number.isFinite(tddConfig.coverage_threshold) ? tddConfig.coverage_threshold : 0);
    const coverageThreshold = rawThreshold > 0 && rawThreshold <= 1 ? Math.round(rawThreshold * 100) : rawThreshold;
    return {
      retry: { ...FRAMEWORK_FEATURES_DATA.retry, strategy: config.retry_backoff_strategy ?? 'exponential', maxRetries: typeof config.max_retry_times === 'number' && Number.isFinite(config.max_retry_times) ? config.max_retry_times : 3 },
      dag: FRAMEWORK_FEATURES_DATA.dag,
      security: FRAMEWORK_FEATURES_DATA.security,
      concurrency: FRAMEWORK_FEATURES_DATA.concurrency,
      tdd: { ...FRAMEWORK_FEATURES_DATA.tdd, enabled: tddConfig.enabled ?? false, coverageThreshold: coverageThreshold },
      checkpoint: FRAMEWORK_FEATURES_DATA.checkpoint,
      collaboration: FRAMEWORK_FEATURES_DATA.collaboration,
    };
  }

  _getPanoramaMetadata() {
    return PANORAMA_METADATA;
  }


  async _getSkillLayerStats() {
    const router = this._rt('router');
    if (!router || typeof router.getLayerStats !== 'function') {
      const skills = await this._getSkills();
      return { available: false, legacy: true, skillCount: skills.length };
    }
    try {
      return { available: true, stats: router.getLayerStats() };
    } catch (_err) {
      debug('Dashboard', '_getSkillLayerStats', _err && _err.message ? _err.message : String(_err));
      return { available: false };
    }
  }

  _getSkillDedupReport() {
    const router = this._rt('router');
    if (!router || typeof router.getDeduplicationReport !== 'function') return { available: false };
    try {
      return { available: true, report: router.getDeduplicationReport() };
    } catch (_err) {
      debug('Dashboard', '_getSkillDedupReport', _err && _err.message ? _err.message : String(_err));
      return { available: false };
    }
  }

  _getSkillContextEstimate() {
    const router = this._rt('router');
    if (!router || typeof router.getContextEstimate !== 'function') return { available: false };
    try {
      return { available: true, estimate: router.getContextEstimate() };
    } catch (_err) {
      debug('Dashboard', '_getSkillContextEstimate', _err && _err.message ? _err.message : String(_err));
      return { available: false };
    }
  }

  _getSkillReducerStats() {
    const reducer = this._rt('skillReducer');
    if (!reducer || typeof reducer.getStats !== 'function') return { available: false };
    try {
      return {
        available: true,
        stats: reducer.getStats(),
        layerDistribution: reducer.getLayerDistribution(),
        activeTaskSkills: reducer.getActiveTaskSkills(),
        overloadStatus: reducer.detectOverload(),
      };
    } catch (_err) {
      debug('Dashboard', '_getSkillReducerStats', _err && _err.message ? _err.message : String(_err));
      return { available: false };
    }
  }

  _getChannelStats() {
    try {
      const channel = this._rt('agentChannel');
      if (!channel) return { available: false, message: 'AgentChannel requires runtime instance' };
      const result = { available: true, sharedKeys: Object.keys(channel?._shared && typeof channel._shared === 'object' ? channel._shared : {}).length };
      if (channel?._mailboxes && typeof channel._mailboxes === 'object') {
        result.totalMailboxes = Object.keys(channel._mailboxes ?? {}).length;
        let totalMessages = 0;
        for (const msgs of Object.values(channel._mailboxes)) totalMessages += Array.isArray(msgs) ? msgs.length : 0;
        result.totalMessages = totalMessages;
      }
      if (channel?._proposals && typeof channel._proposals === 'object') {
        result.openProposals = Object.values(channel._proposals).reduce((c, p) => c + (p.status === 'open' ? 1 : 0), 0);
        result.totalProposals = Object.keys(channel._proposals ?? {}).length;
      }
      return result;
    } catch (_err) {
      debug('Dashboard', '_getAgentChannelStats', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'AgentChannel requires runtime instance' };
    }
  }


  _getCollaborationModes() {
    try {
      const modeRouter = this._rt('collaborationModeRouter');
      if (!modeRouter) return { available: false, modes: [] };
      if (typeof modeRouter.getAllModes !== 'function') return { available: false, modes: [] };
      return { available: true, modes: modeRouter.getAllModes() };
    } catch (_err) {
      debug('Dashboard', '_getCollaborationModes', _err && _err.message ? _err.message : String(_err));
      return { available: false, modes: [] };
    }
  }

  _getCollaborationStats() {
    try {
      const modeRouter = this._rt('collaborationModeRouter');
      if (!modeRouter) return { available: false, stats: {} };
      if (typeof modeRouter.getStats !== 'function') return { available: false, stats: {} };
      return { available: true, stats: modeRouter.getStats() };
    } catch (_err) {
      debug('Dashboard', '_getCollaborationStats', _err && _err.message ? _err.message : String(_err));
      return { available: false, stats: {} };
    }
  }

  _getCollaborationHistory() {
    try {
      const modeRouter = this._rt('collaborationModeRouter');
      if (!modeRouter) return { available: false, history: [] };
      if (typeof modeRouter.getHistory !== 'function') return { available: false, history: [] };
      return { available: true, history: modeRouter.getHistory(20) };
    } catch (_err) {
      debug('Dashboard', '_getCollaborationHistory', _err && _err.message ? _err.message : String(_err));
      return { available: false, history: [] };
    }
  }

  async _getPipelineAnalyze(params) {
    const message = params.get('message') ?? '';
    const agent = params.get('agent') ?? '';
    const validationError = this._validatePipelineParams(message, agent);
    if (validationError) return validationError;

    const intent = this._rt('structuredIntent');
    const router = this._rt('router');
    const modeRouter = this._rt('collaborationModeRouter');

    if (!intent || !router || !modeRouter) {
      return { available: false, message: 'Pipeline modules require runtime instance' };
    }

    const intentResult = intent.parseIntent(message);
    const matchedSkills = router.match({ userMessage: message, agent });
    if (matchedSkills.length > 0 && matchedSkills[0] && matchedSkills[0].skill_id) {
      await router.loadL2Async(matchedSkills[0].skill_id);
    }
    const modeResult = modeRouter.selectMode({
      taskDescription: message,
      availableAgents: 3,
    });

    return {
      available: true,
      intent: {
        completeness: intentResult && intentResult.completeness,
        clarificationNeeded: intentResult && intentResult.clarificationNeeded,
        params: intentResult && intentResult.params,
      },
      matchedSkills: matchedSkills.filter(s => s).map(s => ({ skill_id: s.skill_id, name: s.name, phase: s.phase })),
      mode: {
        selected: modeResult && modeResult.mode,
        confidence: modeResult && modeResult.confidence,
        reasoning: modeResult && modeResult.reasoning,
        allScores: modeResult && modeResult.allScores,
      },
    };
  }

  _validatePipelineParams(message, agent) {
    if (!message) return { available: false, message: 'Missing "message" query parameter' };
    if (message.length > 1000) return { _status: 400, _data: { error: 'Message too long (max 1000 characters)' } };
    if (agent && agent.length > 100) return { _status: 400, _data: { error: 'Agent parameter too long (max 100 characters)' } };
    if (agent && !/^[a-zA-Z0-9_-]{1,64}$/.test(agent)) return { _status: 400, _data: { error: 'Invalid agent format' } };
    return null;
  }

  _getRAGStats() {
    return this._moduleStats('ragPipeline', 'stats');
  }

  async _ragQuery(params) {
    const query = params.get('q') ?? '';
    const topK = Number.isFinite(Number(params.get('top_k'))) ? Number(params.get('top_k')) : 5;
    if (!query) return { available: false, message: 'Missing "q" query parameter' };
    if (query.length > 200) return { _status: 400, _data: { error: 'Query too long (max 200 characters)' } };
    if (topK < 1 || topK > 50) return { _status: 400, _data: { error: 'top_k must be between 1 and 50' } };
    const rag = this._rt('ragPipeline');
    if (!rag) return { available: false, message: 'RAG pipeline not available' };
    try {
      const result = await rag.query(query, { topK });
      return result;
    } catch (_err) {
      debug('Dashboard', '_getRAGPipelineStats', _err && _err.message ? _err.message : String(_err));
      return { available: false, error: 'RAG query failed' };
    }
  }

  _getOpenCLIStatus() {
    try {
      const mcpClient = this._rt('mcpClient');
      if (!mcpClient) return { available: false, message: 'MCP client not initialized' };
      if (typeof mcpClient.getServerStatus !== 'function') return { available: false, message: 'MCP client missing getServerStatus method' };
      const allStatus = mcpClient.getServerStatus();
      if (!allStatus || typeof allStatus !== 'object') return { available: false, message: 'MCP server status unavailable' };
      const opencli = allStatus.opencli;
      if (!opencli) return { available: false, connected: false, message: 'OpenCLI server not configured' };
      return {
        available: true,
        connected: !!opencli.connected,
        toolCount: typeof opencli.toolCount === 'number' && Number.isFinite(opencli.toolCount) ? opencli.toolCount : 0,
        serverName: 'opencli',
      };
    } catch (_err) {
      debug('Dashboard', '_getOpenCLIStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'OpenCLI status check failed' };
    }
  }

  _getOpenCLIServers() {
    try {
      const mcpClient = this._rt('mcpClient');
      if (!mcpClient) return { available: false, servers: {} };
      if (typeof mcpClient.getServerStatus !== 'function') return { available: false, servers: {} };
      const allStatus = mcpClient.getServerStatus();
      if (!allStatus || typeof allStatus !== 'object') return { available: false, servers: {} };
      const filtered = {};
      for (const [key, val] of Object.entries(allStatus)) {
        filtered[key] = { connected: !!val.connected, toolCount: typeof val.toolCount === 'number' && Number.isFinite(val.toolCount) ? val.toolCount : 0 };
      }
      return { available: true, servers: filtered };
    } catch (_err) {
      debug('Dashboard', '_getOpenCLIServers', _err && _err.message ? _err.message : String(_err));
      return { available: false, servers: {} };
    }
  }

  _getCliAnythingStatus() {
    try {
      const mcpClient = this._rt('mcpClient');
      if (!mcpClient) return { available: false, message: 'MCP client not initialized' };
      if (typeof mcpClient.getServerStatus !== 'function') return { available: false, message: 'MCP client missing getServerStatus method' };
      const allStatus = mcpClient.getServerStatus();
      if (!allStatus || typeof allStatus !== 'object') return { available: false, message: 'MCP server status unavailable' };
      const cliAnything = allStatus['cli-anything'];
      if (!cliAnything) return { available: false, connected: false, message: 'CLI-Anything server not configured' };
      return {
        available: true,
        connected: typeof cliAnything.connected === 'boolean' ? cliAnything.connected : !!cliAnything.connected,
        toolCount: typeof cliAnything.toolCount === 'number' && Number.isFinite(cliAnything.toolCount) ? cliAnything.toolCount : 0,
        serverName: 'cli-anything',
      };
    } catch (err) {
      debug('Dashboard', 'cliAnythingStatusError', err && err.message ? err.message : String(err));
      return { available: false, message: 'CLI-Anything status check failed' };
    }
  }

  _getCliAnythingRegistry() {
    try {
      const mcpClient = this._rt('mcpClient');
      if (!mcpClient) return { available: false, tools: [] };
      if (typeof mcpClient.getAvailableTools !== 'function') return { available: false, tools: [] };
      const allTools = mcpClient.getAvailableTools();
      if (!Array.isArray(allTools)) return { available: false, tools: [] };
      const cliTools = allTools.filter(function(tool) {
        return tool && tool.name && typeof tool.name === 'string' && tool.name.startsWith('mcp_cli-anything_');
      }).slice(0, 100).map(function(tool) {
        const name = tool.name.length > 256 ? tool.name.slice(0, 256) : tool.name;
        const desc = typeof tool.description === 'string' ? tool.description : '';
        return { name: name, description: desc.length > 1024 ? desc.slice(0, 1024) : desc };
      });
      const truncated = allTools.filter(function(tool) {
        return tool && tool.name && typeof tool.name === 'string' && tool.name.startsWith('mcp_cli-anything_');
      }).length > 100;
      return { available: true, toolCount: cliTools.length, tools: cliTools, truncated: truncated };
    } catch (err) {
      debug('Dashboard', 'cliAnythingRegistryError', err && err.message ? err.message : String(err));
      return { available: false, tools: [] };
    }
  }

  _getCliAnythingHubInfo() {
    const HUB_CATEGORIES = [
      { id: 'creative-media', name: '创意与媒体工具', tools: ['gimp', 'blender', 'inkscape', 'krita', 'obs-studio', 'kdenlive', 'shotcut', 'audacity', 'musecore', 'openshot'] },
      { id: 'office-enterprise', name: '办公与企业应用', tools: ['libreoffice', 'calibre', 'drawio', 'mermaid', 'obsidian', 'zotero', 'notebooklm'] },
      { id: 'ai-ml', name: 'AI与机器学习平台', tools: ['comfyui', 'ollama', 'chromadb', 'novita', 'minimax', 'dify-workflow'] },
      { id: 'devops', name: '开发与运维工具', tools: ['n8n', 'pm2', 'lldb', 'wiremock', 'adguardhome', 'iterm2', 'browser'] },
      { id: 'engineering', name: '工程与科学计算', tools: ['freecad', 'qgis', 'cloudcompare', 'renderdoc', 'nsight-graphics', '3mf', 'unimol-tools'] },
      { id: 'data-analytics', name: '数据与分析', tools: ['exa', 'cloudanalyzer', 'firefly-iii', 'mailchimp'] },
      { id: 'gaming', name: '游戏与娱乐', tools: ['godot', 'slay-the-spire-ii'] },
      { id: 'other', name: '其他专业工具', tools: ['sketch', 'safari', 'zoom', 'rekordbox', 'videocaptioner', 'anygen'] },
    ];
    let totalTools = 0;
    for (let ci = 0; ci < HUB_CATEGORIES.length; ci++) {
      totalTools += HUB_CATEGORIES[ci].tools.length;
    }
    try {
      const mcpClient = this._rt('mcpClient');
      let connected = false;
      let installedCount = 0;
      if (mcpClient && typeof mcpClient.getServerStatus === 'function') {
        const allStatus = mcpClient.getServerStatus();
        if (allStatus && allStatus['cli-anything']) {
          connected = typeof allStatus['cli-anything'].connected === 'boolean' ? allStatus['cli-anything'].connected : !!allStatus['cli-anything'].connected;
        }
      }
      if (mcpClient && typeof mcpClient.getAvailableTools === 'function') {
        const allTools = mcpClient.getAvailableTools();
        if (Array.isArray(allTools)) {
          installedCount = allTools.filter(function(tool) {
            return tool && tool.name && typeof tool.name === 'string' && tool.name.startsWith('mcp_cli-anything_');
          }).length;
        }
      }
      return {
        available: true,
        connected: connected,
        totalCatalogTools: totalTools,
        installedTools: installedCount,
        categories: HUB_CATEGORIES,
        hubInstallCommand: 'pip install cli-anything-hub',
        skillInstallCommand: 'npx skills add HKUDS/CLI-Anything --skill <name> -g -y',
      };
    } catch (err) {
      debug('Dashboard', 'cliAnythingHubError', err && err.message ? err.message : String(err));
      return {
        available: false,
        totalCatalogTools: totalTools,
        installedTools: 0,
        categories: HUB_CATEGORIES,
        hubInstallCommand: 'pip install cli-anything-hub',
      };
    }
  }

  _getBrowserUseStatus() {
    try {
      const mcpClient = this._rt('mcpClient');
      if (!mcpClient) return { available: false, message: 'MCP client not initialized' };
      if (typeof mcpClient.getServerStatus !== 'function') return { available: false, message: 'MCP client missing getServerStatus method' };
      const allStatus = mcpClient.getServerStatus();
      if (!allStatus || typeof allStatus !== 'object') return { available: false, message: 'MCP server status unavailable' };
      const browserUse = allStatus['browser-use'];
      if (!browserUse) return { available: false, connected: false, message: 'BrowserUse server not configured' };
      const adapter = this._rt('browserUseAdapter');
      const mode = adapter && typeof adapter.getMode === 'function' ? adapter.getMode() : 'mcp';
      const currentUrl = adapter && typeof adapter.getCurrentUrl === 'function' ? adapter.getCurrentUrl() : null;
      const stats = adapter && typeof adapter.getStats === 'function' ? adapter.getStats() : {};
      return {
        available: true,
        mode: mode,
        connected: !!browserUse.connected,
        currentUrl: typeof currentUrl === 'string' ? currentUrl : null,
        stats: stats != null && typeof stats === 'object' ? stats : {},
      };
    } catch (_err) {
      debug('Dashboard', '_getBrowserUseStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'BrowserUse status check failed' };
    }
  }

  _getCdpStatus() {
    try {
      const cdpClient = this._rt('cdpClient');
      if (!cdpClient) return { available: false, connected: false, message: 'CDP client not initialized' };
      const connected = typeof cdpClient.isConnected === 'function' ? cdpClient.isConnected() : false;
      let targetInfo = null;
      if (connected && typeof cdpClient.getTargetInfo === 'function') {
        const raw = cdpClient.getTargetInfo();
        if (raw && typeof raw === 'object') {
          targetInfo = {
            id: typeof raw.id === 'string' ? raw.id : null,
            url: typeof raw.url === 'string' ? raw.url : null,
            title: typeof raw.title === 'string' ? raw.title : null,
            type: typeof raw.type === 'string' ? raw.type : null,
          };
        }
      }
      return { available: true, connected: connected, targetInfo: targetInfo };
    } catch (_err) {
      debug('Dashboard', '_getCdpStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, connected: false, message: 'CDP status check failed' };
    }
  }

  _getBrowserUseScreenshots() {
    try {
      const adapter = this._rt('browserUseAdapter');
      if (!adapter) return { available: false, screenshots: [], message: 'BrowserUse adapter not initialized' };
      if (typeof adapter.getScreenshotCache !== 'function') return { available: false, screenshots: [], message: 'BrowserUse adapter missing getScreenshotCache method' };
      const cache = adapter.getScreenshotCache();
      if (!Array.isArray(cache)) return { available: true, screenshots: [] };
      const screenshots = cache.slice(0, 200).map(function(entry) {
        if (!entry || typeof entry !== 'object') return null;
        return {
          label: typeof entry.label === 'string' ? entry.label : 'unnamed',
          timestamp: typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) ? entry.timestamp : null,
        };
      }).filter(function(s) { return s !== null; });
      return { available: true, count: screenshots.length, screenshots: screenshots };
    } catch (_err) {
      debug('Dashboard', '_getBrowserUseScreenshots', _err && _err.message ? _err.message : String(_err));
      return { available: false, screenshots: [], message: 'BrowserUse screenshots check failed' };
    }
  }

  _getRlStatus() {
    try {
      const mcpClient = this._rt('mcpClient');
      if (!mcpClient) return { available: false, message: 'MCP client not initialized' };
      if (typeof mcpClient.getServerStatus !== 'function') return { available: false, message: 'MCP client missing getServerStatus method' };
      const allStatus = mcpClient.getServerStatus();
      if (!allStatus || typeof allStatus !== 'object') return { available: false, message: 'MCP server status unavailable' };
      const hermesRl = allStatus['hermes-rl'];
      if (!hermesRl) return { available: false, connected: false, message: 'Hermes RL server not configured' };
      const adapter = this._rt('rlTrainingPipeline');
      const adapterData = this._extractRlAdapterData(adapter);
      return {
        available: true,
        mode: adapterData.mode,
        connected: !!hermesRl.connected,
        activeRunId: adapterData.activeRunId,
        stats: adapterData.stats,
        environmentCount: adapterData.environmentCount,
        trajectoryCount: adapterData.trajectoryCount,
      };
    } catch (_err) {
      debug('Dashboard', '_getRlStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'RL status check failed' };
    }
  }

  _extractRlAdapterData(adapter) {
    if (!adapter) return { mode: 'mcp', activeRunId: null, stats: {}, environmentCount: 0, trajectoryCount: 0 };
    const mode = typeof adapter.getMode === 'function' ? adapter.getMode() : 'mcp';
    const activeRunId = typeof adapter.getActiveRunId === 'function' ? adapter.getActiveRunId() : null;
    const stats = typeof adapter.getStats === 'function' ? adapter.getStats() : {};
    const environmentCount = typeof adapter.getEnvironmentCount === 'function' ? adapter.getEnvironmentCount() : 0;
    const trajectoryCount = typeof adapter.getTrajectoryCount === 'function' ? adapter.getTrajectoryCount() : 0;
    return {
      mode: mode,
      activeRunId: typeof activeRunId === 'string' ? activeRunId : null,
      stats: stats && typeof stats === 'object' ? stats : {},
      environmentCount: typeof environmentCount === 'number' && Number.isFinite(environmentCount) ? environmentCount : 0,
      trajectoryCount: typeof trajectoryCount === 'number' && Number.isFinite(trajectoryCount) ? trajectoryCount : 0,
    };
  }

  _getRlEnvironments() {
    try {
      const adapter = this._rt('rlTrainingPipeline');
      if (!adapter) return { available: false, environments: [], message: 'RL Training Pipeline not initialized' };
      if (typeof adapter.getEnvironments !== 'function') return { available: false, environments: [], message: 'RL Training Pipeline missing getEnvironments method' };
      const envs = adapter.getEnvironments();
      if (!Array.isArray(envs)) return { available: true, environments: [] };
      const environments = envs.slice(0, 200).map(function(env) {
        if (!env || typeof env !== 'object') return null;
        return {
          id: typeof env.id === 'string' ? env.id : null,
          name: typeof env.name === 'string' ? env.name : 'unnamed',
          type: typeof env.type === 'string' ? env.type : null,
          description: typeof env.description === 'string' ? env.description : null,
        };
      }).filter(function(e) { return e !== null && e.id !== null; });
      return { available: true, count: environments.length, environments: environments };
    } catch (_err) {
      debug('Dashboard', '_getRlEnvironments', _err && _err.message ? _err.message : String(_err));
      return { available: false, environments: [], message: 'RL environments check failed' };
    }
  }

  _getRlRuns(sp) {
    try {
      const adapter = this._rt('rlTrainingPipeline');
      if (!adapter) return { available: false, runs: [], message: 'RL Training Pipeline not initialized' };
      if (typeof adapter.getRuns !== 'function') return { available: false, runs: [], message: 'RL Training Pipeline missing getRuns method' };
      const statusFilter = sp && typeof sp.status === 'string' ? sp.status : null;
      const limit = sp && typeof sp.limit === 'string' ? Math.min(Number.isFinite(parseInt(sp.limit, 10)) ? parseInt(sp.limit, 10) : 100, 100) : 100;
      const runs = adapter.getRuns({ status: statusFilter, limit: limit });
      if (!Array.isArray(runs)) return { available: true, runs: [] };
      const filtered = runs.slice(0, 100).map(function(run) {
        if (!run || typeof run !== 'object') return null;
        return {
          id: typeof run.id === 'string' ? run.id : null,
          status: typeof run.status === 'string' ? run.status : null,
          environment: typeof run.environment === 'string' ? run.environment : null,
          startedAt: typeof run.startedAt === 'string' ? run.startedAt : null,
          completedAt: typeof run.completedAt === 'string' ? run.completedAt : null,
          bestReward: typeof run.bestReward === 'number' && Number.isFinite(run.bestReward) ? run.bestReward : null,
        };
      }).filter(function(r) { return r !== null && r.id !== null; });
      return { available: true, count: filtered.length, runs: filtered };
    } catch (_err) {
      debug('Dashboard', '_getRlRuns', _err && _err.message ? _err.message : String(_err));
      return { available: false, runs: [], message: 'RL runs check failed' };
    }
  }

  _getRlRunDetail(runId, _sp) {
    try {
      if (typeof runId !== 'string' || runId.length === 0 || runId.length > 128) {
        return { available: false, message: 'Invalid run ID' };
      }
      const adapter = this._rt('rlTrainingPipeline');
      if (!adapter) return { available: false, message: 'RL Training Pipeline not initialized' };
      if (typeof adapter.getRunDetail !== 'function') return { available: false, message: 'RL Training Pipeline missing getRunDetail method' };
      const detail = adapter.getRunDetail(runId);
      if (!detail || typeof detail !== 'object') return { available: false, message: 'Run not found' };
      const metrics = detail.metrics && typeof detail.metrics === 'object' ? detail.metrics : {};
      return {
        available: true,
        id: typeof detail.id === 'string' ? detail.id : runId,
        status: typeof detail.status === 'string' ? detail.status : null,
        environment: typeof detail.environment === 'string' ? detail.environment : null,
        startedAt: typeof detail.startedAt === 'string' ? detail.startedAt : null,
        completedAt: typeof detail.completedAt === 'string' ? detail.completedAt : null,
        bestReward: typeof detail.bestReward === 'number' && Number.isFinite(detail.bestReward) ? detail.bestReward : null,
        metrics: metrics,
      };
    } catch (_err) {
      debug('Dashboard', '_getRlRunDetail', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'RL run detail check failed' };
    }
  }

  _getOptimizationStatus() {
    try {
      const loop = this._rt('optimizationLoop');
      if (!loop) return { available: false, message: 'OptimizationLoop not initialized' };
      if (typeof loop.getStats !== 'function') return { available: false, message: 'OptimizationLoop missing getStats method' };
      const stats = loop.getStats();
      if (!stats || typeof stats !== 'object') return { available: false, message: 'OptimizationLoop getStats returned invalid result' };
      return {
        available: true,
        status: stats.status,
        currentIteration: stats.currentIteration,
        bestScore: stats.bestScore,
        bestIteration: stats.bestIteration,
        stagnationCounter: stats.stagnationCounter,
        plateauCounter: stats.plateauCounter,
        strategyTrend: stats.strategyTrend,
        healthy: stats.healthy,
      };
    } catch (_err) {
      debug('Dashboard', '_getOptimizationStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'Optimization status check failed' };
    }
  }

  _getOptimizationProgress() {
    try {
      const loop = this._rt('optimizationLoop');
      if (!loop) return { available: false, message: 'OptimizationLoop not initialized' };
      if (typeof loop.getProgress !== 'function') return { available: false, message: 'OptimizationLoop missing getProgress method' };
      const progress = loop.getProgress();
      return { available: true, ...progress };
    } catch (_err) {
      debug('Dashboard', '_getOptimizationProgress', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'Optimization progress check failed' };
    }
  }

  _getOptimizationJournal() {
    try {
      const loop = this._rt('optimizationLoop');
      if (!loop) return { available: false, message: 'OptimizationLoop not initialized', journal: '' };
      if (typeof loop.getJournal !== 'function') return { available: false, message: 'OptimizationLoop missing getJournal method', journal: '' };
      const journal = loop.getJournal();
      return { available: true, journal: typeof journal === 'string' ? journal : '' };
    } catch (_err) {
      debug('Dashboard', '_getOptimizationJournal', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'Optimization journal check failed', journal: '' };
    }
  }

  _getOodaStatus() {
    try {
      const ooda = this._rt('oodaLoop');
      if (!ooda) return { available: false, message: 'OodaLoop not initialized' };
      if (typeof ooda.getStats !== 'function') return { available: false, message: 'OodaLoop missing getStats method' };
      const stats = ooda.getStats();
      if (!stats || typeof stats !== 'object') return { available: false, message: 'OodaLoop getStats returned invalid result' };
      return {
        available: true,
        cycleCount: stats.cycleCount,
        level: stats.level,
        healthy: stats.healthy,
        shutDown: stats.shutDown,
        goalDescription: stats.goalDescription,
        historySize: stats.historySize,
      };
    } catch (_err) {
      debug('Dashboard', '_getOodaStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'OODA status check failed' };
    }
  }

  _getOodaSpeed() {
    try {
      const ooda = this._rt('oodaLoop');
      if (!ooda) return { available: false, message: 'OodaLoop not initialized' };
      if (typeof ooda.getCycleSpeed !== 'function') return { available: false, message: 'OodaLoop missing getCycleSpeed method' };
      const speed = ooda.getCycleSpeed();
      return { available: true, ...speed };
    } catch (_err) {
      debug('Dashboard', '_getOodaSpeed', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'OODA speed check failed' };
    }
  }

  _getOodaHistory() {
    try {
      const ooda = this._rt('oodaLoop');
      if (!ooda) return { available: false, message: 'OodaLoop not initialized', history: {} };
      if (typeof ooda.getStats !== 'function') return { available: false, message: 'OodaLoop missing getStats method', history: {} };
      const stats = ooda.getStats();
      if (!stats || typeof stats !== 'object') return { available: false, message: 'OodaLoop getStats returned invalid result', history: {} };
      return { available: true, historySize: stats.historySize, config: stats.config };
    } catch (_err) {
      debug('Dashboard', '_getOodaHistory', _err && _err.message ? _err.message : String(_err));
      return { available: false, message: 'OODA history check failed', history: {} };
    }
  }

  _getIntentStats() {
    return this._moduleStats('structuredIntent', 'stats');
  }

  _getIntentSchemas() {
    try {
      const intent = this._rt('structuredIntent');
      if (!intent) return { available: false, schemas: {} };
      if (typeof intent.getSchema !== 'function') return { available: false, schemas: {} };
      const schemas = {};
      const schemaKeys = Object.keys((intent?.constructor?.INTENT_SCHEMAS || intent?._schemas) ?? {});
      for (const key of schemaKeys) {
        const schema = intent.getSchema(key);
        if (schema) schemas[key] = schema;
      }
      return { available: true, schemas, count: Object.keys(schemas).length };
    } catch (_err) {
      debug('Dashboard', '_getIntentSchemas', _err && _err.message ? _err.message : String(_err));
      return { available: false, schemas: {} };
    }
  }

  _getSqliteStats() {
    return this._moduleStats('sqliteStore', 'stats');
  }

  _getSqliteFts() {
    const store = this._rt('sqliteStore');
    if (!store) return { available: false, results: [] };
    return { available: true, tables: ['knowledge', 'sessions', 'skill_learnings', 'memory'] };
  }

  _getMemoryEntries() {
    try {
      const store = this._rt('sqliteStore');
      if (!store) return { available: false, entries: [] };
      if (typeof store.getMemories !== 'function') return { available: false, entries: [] };
      return { available: true, memory: store.getMemories('memory'), user: store.getMemories('user') };
    } catch (_err) {
      debug('Dashboard', '_getMemoryEntries', _err && _err.message ? _err.message : String(_err));
      return { available: false, entries: [] };
    }
  }

  _getMemoryUsage() {
    try {
      const store = this._rt('sqliteStore');
      if (!store) return { available: false };
      if (typeof store.getMemoryUsage !== 'function') return { available: false };
      return { available: true, memory: store.getMemoryUsage('memory'), user: store.getMemoryUsage('user') };
    } catch (_err) {
      debug('Dashboard', '_getMemoryUsage', _err && _err.message ? _err.message : String(_err));
      return { available: false };
    }
  }

  _getMemoryVerification() {
    const store = this._rt('sqliteStore');
    if (!store || typeof store.getMemoryVerificationStats !== 'function') return { available: false };
    return { available: true, stats: store.getMemoryVerificationStats() };
  }

  _getStaleMemories() {
    const store = this._rt('sqliteStore');
    if (!store || typeof store.getStaleMemories !== 'function') return { available: false, stale: [] };
    return { available: true, stale: store.getStaleMemories('memory') };
  }

  _getAntipatternRules() {
    const monitor = this._rt('agentMonitor');
    if (!monitor || typeof monitor.getAntipatternRules !== 'function') return { available: false, rules: [] };
    return { available: true, rules: monitor.getAntipatternRules() };
  }

  _detectAntipatterns(body) {
    const monitor = this._rt('agentMonitor');
    if (!monitor || typeof monitor.detectAntipatterns !== 'function') return { available: false, patterns: [] };
    const agentId = (body && body.agentId) ?? 'unknown';
    const behaviorContext = (body && body.behaviorContext) ?? {};
    if (agentId !== 'unknown') {
      if (typeof agentId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
        return { _status: 400, _data: { error: 'Invalid agentId format' } };
      }
    }
    if (behaviorContext !== null && typeof behaviorContext !== 'object') {
      return { _status: 400, _data: { error: 'behaviorContext must be an object' } };
    }
    return { available: true, agentId, patterns: monitor.detectAntipatterns(agentId, behaviorContext) };
  }

  _getUserProfile() {
    try {
      const um = this._rt('userModelManager');
      if (!um) return { available: false, preferences: {} };
      if (typeof um.getAllPreferences !== 'function' || typeof um.getSchema !== 'function') return { available: false, preferences: {} };
      return { available: true, preferences: um.getAllPreferences(), schema: um.getSchema() };
    } catch (_err) {
      debug('Dashboard', '_getUserProfile', _err && _err.message ? _err.message : String(_err));
      return { available: false, preferences: {} };
    }
  }

  _getSkillImprovementPending() {
    try {
      const loop = this._rt('skillImprovementLoop');
      if (!loop) return { available: false, patches: {} };
      if (typeof loop.getPendingPatches !== 'function') return { available: false, patches: {} };
      return { available: true, patches: loop.getPendingPatches() };
    } catch (_err) {
      debug('Dashboard', '_getSkillImprovementPending', _err && _err.message ? _err.message : String(_err));
      return { available: false, patches: {} };
    }
  }

  _getSkillImprovementStats() {
    return this._moduleStats('skillImprovementLoop', 'stats');
  }

  async _getSkillCreationList() {
    try {
      const engine = this._rt('skillCreationEngine');
      if (!engine) return { available: false, skills: [] };
      if (typeof engine.listAutoCreatedSkills !== 'function') return { available: false, skills: [] };
      return { available: true, skills: await engine.listAutoCreatedSkills() };
    } catch (_err) {
      debug('Dashboard', '_getSkillCreationList', _err && _err.message ? _err.message : String(_err));
      return { available: false, skills: [] };
    }
  }

  _getSkillCreationStats() {
    return this._moduleStats('skillCreationEngine', 'stats');
  }

  _getSkillCuratorStats() {
    try {
      const curator = this._rt('skillCurator');
      if (!curator) return { available: false, stats: {} };
      if (typeof curator.getAllStats !== 'function') return { available: false, stats: {} };
      return { available: true, stats: curator.getAllStats() };
    } catch (_err) {
      debug('Dashboard', '_getSkillCuratorStats', _err && _err.message ? _err.message : String(_err));
      return { available: false, stats: {} };
    }
  }

  _getNudgeStats() {
    return this._moduleStats('memoryNudge', 'stats');
  }

  _getDocFreshnessStats() {
    try {
      const guard = this._rt('docFreshnessGuard');
      if (!guard) return { available: false, stats: {} };
      if (typeof guard.getFreshnessStats !== 'function') return { available: false, stats: {} };
      return { available: true, stats: guard.getFreshnessStats() };
    } catch (_err) {
      debug('Dashboard', '_getDocFreshnessStats', _err && _err.message ? _err.message : String(_err));
      return { available: false, stats: {} };
    }
  }

  _getDocFreshnessStale() {
    try {
      const guard = this._rt('docFreshnessGuard');
      if (!guard) return { available: false, staleDocs: [] };
      if (typeof guard.getStaleDocs !== 'function') return { available: false, staleDocs: [] };
      return { available: true, staleDocs: guard.getStaleDocs() };
    } catch (_err) {
      debug('Dashboard', '_getDocFreshnessStale', _err && _err.message ? _err.message : String(_err));
      return { available: false, staleDocs: [] };
    }
  }

  _getDocFreshnessIndex() {
    try {
      const guard = this._rt('docFreshnessGuard');
      if (!guard) return { available: false, index: [] };
      if (typeof guard.getDocIndex !== 'function') return { available: false, index: [] };
      return { available: true, index: guard.getDocIndex() };
    } catch (_err) {
      debug('Dashboard', '_getDocFreshnessIndex', _err && _err.message ? _err.message : String(_err));
      return { available: false, index: [] };
    }
  }

  _validateDocFreshness() {
    try {
      const guard = this._rt('docFreshnessGuard');
      if (!guard) return { available: false, valid: false };
      if (typeof guard.validateFreshness !== 'function') return { available: false, valid: false };
      return { available: true, ...guard.validateFreshness() };
    } catch (_err) {
      debug('Dashboard', '_validateDocFreshness', _err && _err.message ? _err.message : String(_err));
      return { available: false, valid: false };
    }
  }

  _getMcpStatus() {
    try {
      const mcp = this._rt('mcpClient');
      if (!mcp) return { available: false, servers: {}, stats: {} };
      if (typeof mcp.getServerStatus !== 'function' || typeof mcp.getStats !== 'function') return { available: false, servers: {}, stats: {} };
      return { available: true, servers: mcp.getServerStatus(), stats: mcp.getStats() };
    } catch (_err) {
      debug('Dashboard', '_getMcpStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, servers: {}, stats: {} };
    }
  }

  // ─── Code Wiki 端点 ─────────────────────────────────────────

  _getCodeWikiStats() {
    try {
      const wiki = this._rt('codeWikiOrchestrator');
      if (!wiki) return { available: false, stats: {} };
      if (typeof wiki.getStats !== 'function') return { available: false, stats: {} };
      return { available: true, stats: wiki.getStats() };
    } catch (_err) {
      debug('Dashboard', '_getCodeWikiStats', _err && _err.message ? _err.message : String(_err));
      return { available: false, stats: {} };
    }
  }

  _getCodeWikiCompileStatus() {
    try {
      const wiki = this._rt('codeWikiOrchestrator');
      if (!wiki) return { available: false, status: 'unavailable' };
      if (typeof wiki.getCompileStatus !== 'function') return { available: false, status: 'unavailable' };
      return { available: true, status: wiki.getCompileStatus() };
    } catch (_err) {
      debug('Dashboard', '_getCodeWikiCompileStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, status: 'error' };
    }
  }

  _getCodeWikiStaleDocs() {
    try {
      const wiki = this._rt('codeWikiOrchestrator');
      if (!wiki) return { available: false, staleDocs: [] };
      if (typeof wiki.getStaleDocs !== 'function') return { available: false, staleDocs: [] };
      return { available: true, staleDocs: wiki.getStaleDocs() };
    } catch (_err) {
      debug('Dashboard', '_getCodeWikiStaleDocs', _err && _err.message ? _err.message : String(_err));
      return { available: false, staleDocs: [] };
    }
  }

  _getCodeWikiFreshness() {
    try {
      const wiki = this._rt('codeWikiOrchestrator');
      if (!wiki) return { available: false, valid: false };
      if (typeof wiki.validateFreshness !== 'function') return { available: false, valid: false };
      return { available: true, ...wiki.validateFreshness() };
    } catch (_err) {
      debug('Dashboard', '_getCodeWikiFreshness', _err && _err.message ? _err.message : String(_err));
      return { available: false, valid: false };
    }
  }

  _getCodeWikiChatHistory() {
    try {
      const wiki = this._rt('codeWikiOrchestrator');
      if (!wiki) return { available: false, history: [] };
      if (typeof wiki.getChatHistory !== 'function') return { available: false, history: [] };
      return { available: true, history: wiki.getChatHistory() };
    } catch (_err) {
      debug('Dashboard', '_getCodeWikiChatHistory', _err && _err.message ? _err.message : String(_err));
      return { available: false, history: [] };
    }
  }

  _getCodeWikiContextFile() {
    try {
      const wiki = this._rt('codeWikiOrchestrator');
      if (!wiki) return { available: false, content: '' };
      if (typeof wiki.getContextFile !== 'function') return { available: false, content: '' };
      return { available: true, content: wiki.getContextFile() };
    } catch (_err) {
      debug('Dashboard', '_getCodeWikiContextFile', _err && _err.message ? _err.message : String(_err));
      return { available: false, content: '' };
    }
  }

  _getCodeWikiArchitectureDiagram() {
    try {
      const wiki = this._rt('codeWikiOrchestrator');
      if (!wiki) return { available: false, diagram: '', nodeCount: 0, edgeCount: 0 };
      if (typeof wiki.generateArchitectureDiagram !== 'function') return { available: false, diagram: '', nodeCount: 0, edgeCount: 0 };
      return { available: true, ...wiki.generateArchitectureDiagram() };
    } catch (_err) {
      debug('Dashboard', '_getCodeWikiArchitectureDiagram', _err && _err.message ? _err.message : String(_err));
      return { available: false, diagram: '', nodeCount: 0, edgeCount: 0 };
    }
  }

  // ─── Delivery Acceleration 端点 ─────────────────────────────

  _getDeliveryAccelerationStats() {
    try {
      const dao = this._rt('deliveryAccelerationOrchestrator');
      if (!dao) return { available: false, stats: {} };
      if (typeof dao.getStats !== 'function') return { available: false, stats: {} };
      return { available: true, stats: dao.getStats() };
    } catch (_err) {
      debug('Dashboard', '_getDeliveryAccelerationStats', _err && _err.message ? _err.message : String(_err));
      return { available: false, stats: {} };
    }
  }

  _getDeliveryDiagnosis() {
    try {
      const dao = this._rt('deliveryAccelerationOrchestrator');
      if (!dao) return { available: false, diagnosis: null };
      if (typeof dao.diagnoseBottlenecks !== 'function') return { available: false, diagnosis: null };
      return { available: true, diagnosis: dao.diagnoseBottlenecks() };
    } catch (_err) {
      debug('Dashboard', '_getDeliveryDiagnosis', _err && _err.message ? _err.message : String(_err));
      return { available: false, diagnosis: null };
    }
  }

  _getDeliveryOverview() {
    try {
      const dao = this._rt('deliveryAccelerationOrchestrator');
      if (!dao) return { available: false, overview: {} };
      if (typeof dao.getDeliveryOverview !== 'function') return { available: false, overview: {} };
      return { available: true, overview: dao.getDeliveryOverview() };
    } catch (_err) {
      debug('Dashboard', '_getDeliveryOverview', _err && _err.message ? _err.message : String(_err));
      return { available: false, overview: {} };
    }
  }

  _getMcpTools() {
    try {
      const mcp = this._rt('mcpClient');
      if (!mcp) return { available: false, tools: [] };
      if (typeof mcp.getAvailableTools !== 'function') return { available: false, tools: [] };
      return { available: true, tools: mcp.getAvailableTools() };
    } catch (_err) {
      debug('Dashboard', '_getMcpTools', _err && _err.message ? _err.message : String(_err));
      return { available: false, tools: [] };
    }
  }

  _getAffinityLearnerStats() {
    return this._moduleStats('affinityLearner', 'stats');
  }

  _getAffinityRecords() {
    try {
      const store = this._rt('sqliteStore');
      if (!store) return { available: false, records: [] };
      if (typeof store.getAllAffinityRecords !== 'function') return { available: false, records: [] };
      return { available: true, records: store.getAllAffinityRecords() };
    } catch (_err) {
      debug('Dashboard', '_getAffinityRecords', _err && _err.message ? _err.message : String(_err));
      return { available: false, records: [] };
    }
  }

  _getPairChatStats() {
    return this._moduleStats('pairChat', 'stats');
  }

  _getPairChatSessions() {
    try {
      const pc = this._rt('pairChat');
      if (!pc) return { available: false, sessions: [] };
      if (typeof pc.getStats !== 'function') return { available: false, sessions: [] };
      const stats = pc.getStats();
      const sessions = (pc?._sessions instanceof Map) ? Array.from(pc._sessions.values()).slice(0, MAX_DETAIL_LIST_ITEMS) : [];
      return {
        available: true,
        activeSessions: typeof stats.activeSessions === 'number' && Number.isFinite(stats.activeSessions) ? stats.activeSessions : 0,
        totalSessions: typeof stats.totalSessions === 'number' && Number.isFinite(stats.totalSessions) ? stats.totalSessions : 0,
        sessions: sessions.map(function(s) {
          return {
            sessionId: s.sessionId ?? '—',
            proposer: s.proposer ?? '—',
            reviewer: s.reviewer ?? '—',
            artifactType: s.artifactType ?? 'code',
            status: s.status ?? 'unknown',
            totalRounds: Array.isArray(s.rounds) ? s.rounds.length : 0,
            maxRounds: s.config && typeof s.config.maxRounds === 'number' && Number.isFinite(s.config.maxRounds) ? s.config.maxRounds : 0,
            consensusRound: s.consensusRound ?? null,
            createdAt: s.createdAt || '',
          };
        }),
      };
    } catch (_err) {
      debug('Dashboard', '_getPairChatSessions', _err && _err.message ? _err.message : String(_err));
      return { available: false, sessions: [] };
    }
  }

  _getChatChainStats() {
    return this._moduleStats('chatChain', 'stats');
  }

  _getChatChainChains() {
    try {
      const cc = this._rt('chatChain');
      if (!cc) return { available: false, chains: [] };
      if (typeof cc.getStats !== 'function') return { available: false, chains: [] };
      const stats = cc.getStats();
      const chains = (cc?._chains instanceof Map) ? Array.from(cc._chains.values()).slice(0, MAX_DETAIL_LIST_ITEMS) : [];
      return {
        available: true,
        activeChains: typeof stats.activeChains === 'number' && Number.isFinite(stats.activeChains) ? stats.activeChains : 0,
        totalChains: typeof stats.totalChains === 'number' && Number.isFinite(stats.totalChains) ? stats.totalChains : 0,
        taskCompletionRate: stats.taskCompletionRate ?? '0',
        chainCompletionRate: stats.chainCompletionRate ?? '0',
        chains: chains.map(function(c) {
          let completedTasks = 0;
          let failedTasks = 0;
          let requiredTasks = 0;
          let requiredCompleted = 0;
          if (Array.isArray(c.tasks)) {
            for (let i = 0; i < c.tasks.length; i++) {
              const tk = c.tasks[i];
              if (tk.status === 'completed') completedTasks++;
              if (tk.status === 'failed') failedTasks++;
              if (tk.required) { requiredTasks++; if (tk.status === 'completed') requiredCompleted++; }
            }
          }
          return {
            chainId: c.chainId ?? '—',
            phase: c.phase ?? '—',
            status: c.status ?? 'unknown',
            totalTasks: Array.isArray(c.tasks) ? c.tasks.length : 0,
            completedTasks: completedTasks,
            failedTasks: failedTasks,
            requiredTasks: requiredTasks,
            requiredCompleted: requiredCompleted,
            progress: Array.isArray(c.tasks) && c.tasks.length > 0 ? (completedTasks / c.tasks.length * 100).toFixed(1) + '%' : '0%',
            createdAt: c.createdAt || '',
            completedAt: c.completedAt || '',
          };
        }),
      };
    } catch (_err) {
      debug('Dashboard', '_getChatChainChains', _err && _err.message ? _err.message : String(_err));
      return { available: false, chains: [] };
    }
  }

  _getOutputFusionStats() {
    try {
      const of = this._rt('outputFusion');
      if (!of) return { available: false, stats: {} };
      if (typeof of.getStats !== 'function') return { available: false, stats: {} };
      return { available: true, stats: of.getStats() };
    } catch (_err) {
      debug('Dashboard', '_getOutputFusionStats', _err && _err.message ? _err.message : String(_err));
      return { available: false, stats: {} };
    }
  }


  /**
   * 检查服务器健康状态。验证HTTP服务器运行状态、文件锁数量和确认数量是否在安全阈值内。
   * @returns {boolean} 服务器健康返回true
   */
  isHealthy() {
    if (!this.server) return false;
    if (this._shutDown || this._shuttingDown) return false;
    const pg = this._rt('permissionGuard');
    if (pg) {
      const lockCount = Object.keys(pg.locks ?? {}).length;
      const confirmCount = Object.keys(pg.confirmations ?? {}).length;
      if (lockCount > MAX_LOCKS) return false;
      if (lockCount > HEALTH_MAX_LOCKS || confirmCount > HEALTH_MAX_CONFIRMATIONS) return false;
    }
    return true;
  }

  _getSearchEngine() {
    if (this._searchEngine) return this._searchEngine;
    const EvolvingSearchEngine = require('../runtime/search/evolving-search-engine').EvolvingSearchEngine;
    const mcpClient = this._rt('mcpClient');
    this._searchEngine = new EvolvingSearchEngine({ mcpClient: mcpClient || undefined });
    return this._searchEngine;
  }

  _getSearchStatus() {
    try {
      const engine = this._getSearchEngine();
      if (!engine) return { available: false, stats: {} };
      return { available: true, stats: engine.getStats() };
    } catch (_err) {
      debug('Dashboard', '_getSearchStatus', _err && _err.message ? _err.message : String(_err));
      return { available: false, stats: {} };
    }
  }

  _getSearchClusters(sp) {
    try {
      const engine = this._getSearchEngine();
      if (!engine) return { available: false, clusters: [] };
      const category = sp.get('category') || undefined;
      const clusters = engine._clusterStore ? engine._clusterStore.getAllClusters(category) : [];
      return { available: true, clusters: clusters, count: clusters.length };
    } catch (_err) {
      debug('Dashboard', '_getSearchClusters', _err && _err.message ? _err.message : String(_err));
      return { available: false, clusters: [] };
    }
  }

  _getSearchHistory(sp) {
    try {
      const engine = this._getSearchEngine();
      if (!engine) return { available: false, history: [] };
      const limit = Math.min(Math.max(parseInt(sp.get('limit') || '20', 10), 1), MAX_API_LIST_ITEMS);
      const history = engine._sirchnunk ? engine._sirchnunk.getHistory(limit) : [];
      return { available: true, history: history, count: history.length };
    } catch (_err) {
      debug('Dashboard', '_getSearchHistory', _err && _err.message ? _err.message : String(_err));
      return { available: false, history: [] };
    }
  }

  _buildSearchRoutes(self) {
    return {
      '/api/search/query': async (body) => {
        if (!body || !body.query || typeof body.query !== 'string') {
          return { _status: 400, _data: { error: 'query is required and must be a non-empty string' } };
        }
        if (body.query.length > 1000) {
          return { _status: 400, _data: { error: 'query exceeds maximum length' } };
        }
        try {
          const engine = self._getSearchEngine();
          if (!engine) return self._moduleUnavailable('Search engine not available');
          const options = {};
          if (body.mode && typeof body.mode === 'string') options.mode = body.mode;
          if (Array.isArray(body.paths)) options.paths = body.paths;
          if (typeof body.topK === 'number') options.topK = body.topK;
          if (typeof body.maxDepth === 'number') options.maxDepth = body.maxDepth;
          if (typeof body.maxLoops === 'number') options.maxLoops = body.maxLoops;
          if (Array.isArray(body.includePatterns)) options.includePatterns = body.includePatterns;
          if (Array.isArray(body.excludePatterns)) options.excludePatterns = body.excludePatterns;
          const result = await engine.search(body.query, options);
          return result;
        } catch (err) {
          debug('Dashboard', 'searchQuery', err && err.message ? err.message : String(err));
          return { _status: 500, _data: { error: 'Search failed' } };
        }
      },
    };
  }

  _buildDynamicWorkflowRoutes(self) {
    return {
      '/api/workflow/compile': (body) => {
        if (!body || typeof body !== 'object') {
          return { _status: 400, _data: { error: 'DSL body is required' } };
        }
        const engine = self._dynamicWorkflowEngine;
        if (!engine) return self._moduleUnavailable('Dynamic Workflow Engine not available');
        try {
          const result = engine.compile(body);
          return result;
        } catch (err) {
          debug('Dashboard', 'workflowCompile', err && err.message ? err.message : String(err));
          return { _status: 500, _data: { error: 'Compile failed' } };
        }
      },
      '/api/workflow/execute': async (body) => {
        const engine = self._dynamicWorkflowEngine;
        if (!engine) return self._moduleUnavailable('Dynamic Workflow Engine not available');
        try {
          const context = {};
          if (body && body.executeFn) delete body.executeFn;
          if (body && body.verifyFn) delete body.verifyFn;
          const result = await engine.execute(context);
          return result;
        } catch (err) {
          debug('Dashboard', 'workflowExecute', err && err.message ? err.message : String(err));
          return { _status: 500, _data: { error: 'Execute failed' } };
        }
      },
      '/api/workflow/status': () => {
        const engine = self._dynamicWorkflowEngine;
        if (!engine) return self._moduleUnavailable('Dynamic Workflow Engine not available');
        return engine.getStatus();
      },
      '/api/workflow/pause': () => {
        const engine = self._dynamicWorkflowEngine;
        if (!engine) return self._moduleUnavailable('Dynamic Workflow Engine not available');
        return engine.pause();
      },
      '/api/workflow/checkpoints': () => {
        const engine = self._dynamicWorkflowEngine;
        if (!engine) return self._moduleUnavailable('Dynamic Workflow Engine not available');
        return engine.getCheckpoints();
      },
      '/api/workflow/rollback': (body) => {
        const engine = self._dynamicWorkflowEngine;
        if (!engine) return self._moduleUnavailable('Dynamic Workflow Engine not available');
        if (!body || !body.checkpointId) {
          return { _status: 400, _data: { error: 'checkpointId is required' } };
        }
        return engine.rollbackToCheckpoint(body.checkpointId);
      },
      '/api/workflow/conditions': () => {
        const DynamicWorkflowEngine = require('../runtime/workflow/dynamic-workflow-engine');
        return { conditions: DynamicWorkflowEngine.listBuiltinConditions() };
      },
      '/api/workflow/node-types': () => {
        const DynamicWorkflowEngine = require('../runtime/workflow/dynamic-workflow-engine');
        return { nodeTypes: DynamicWorkflowEngine.listNodeTypes() };
      },
      '/api/workflow/edge-types': () => {
        const DynamicWorkflowEngine = require('../runtime/workflow/dynamic-workflow-engine');
        return { edgeTypes: DynamicWorkflowEngine.listEdgeTypes() };
      },
    };
  }

  setDynamicWorkflowEngine(engine) {
    this._dynamicWorkflowEngine = engine;
    return this;
  }

  setDynamicHarnessGenerator(generator) {
    this._dynamicHarnessGenerator = generator;
    return this;
  }

  /** 设置多智能体协调控制器实例 */
  setMultiAgentOrchestrator(orchestrator) {
    this._multiAgentOrchestrator = orchestrator;
    return this;
  }

  /** 设置AI Agent工程化架构协调器实例 */
  setAgentArchitectureOrchestrator(orchestrator) {
    this._agentArchitectureOrchestrator = orchestrator;
    return this;
  }

  /** 设置容器沙箱管理器实例 */
  setContainerSandboxManager(manager) {
    this._containerSandboxManager = manager;
    return this;
  }

  /** 设置任务分解器实例 */
  setTaskDecomposer(decomposer) {
    this._taskDecomposer = decomposer;
    return this;
  }

  /** 设置结果聚合器实例 */
  setResultAggregator(aggregator) {
    this._resultAggregator = aggregator;
    return this;
  }

  _buildArchitectureRoutes(self) {
    // POST /api/architecture/orchestrate — 启动架构协调
    self._routes['POST /api/architecture/orchestrate'] = (body) => {
      const arch = self._agentArchitectureOrchestrator;
      if (!arch) return { _status: 503, _data: { error: 'AgentArchitectureOrchestrator not available' } };
      if (!body || !body.task) return { _status: 400, _data: { error: 'task is required' } };
      const agents = body.agents ?? [];
      const options = body.options ?? {};
      return arch.orchestrate(body.task, agents, options)
        .then(result => ({ _status: 200, _data: result }))
        .catch(_err => { debug('Dashboard', 'architectureOrchestrate', _err && _err.message ? _err.message : String(_err)); return { _status: 500, _data: { error: 'Architecture orchestration failed' } }; });
    };

    // GET /api/architecture/status — 获取架构状态
    self._routes['GET /api/architecture/status'] = () => {
      const arch = self._agentArchitectureOrchestrator;
      if (!arch) return { _status: 503, _data: { error: 'AgentArchitectureOrchestrator not available' } };
      return { _status: 200, _data: arch.getArchitectureStatus() };
    };

    // GET /api/architecture/entropy — 获取熵值报告
    self._routes['GET /api/architecture/entropy'] = () => {
      const arch = self._agentArchitectureOrchestrator;
      if (!arch) return { _status: 503, _data: { error: 'AgentArchitectureOrchestrator not available' } };
      return { _status: 200, _data: arch.getEntropyScore() };
    };

    // POST /api/architecture/entropy/govern — 执行熵治理
    self._routes['POST /api/architecture/entropy/govern'] = () => {
      const arch = self._agentArchitectureOrchestrator;
      if (!arch) return { _status: 503, _data: { error: 'AgentArchitectureOrchestrator not available' } };
      return { _status: 200, _data: arch._entropyGovernanceOrchestrator.govern() };
    };

    // GET /api/architecture/constraints — 获取约束注册表
    self._routes['GET /api/architecture/constraints'] = () => {
      const arch = self._agentArchitectureOrchestrator;
      if (!arch) return { _status: 503, _data: { error: 'AgentArchitectureOrchestrator not available' } };
      return { _status: 200, _data: arch.getConstraintRegistry() };
    };

    // GET /api/architecture/modules — 获取模块注册表
    self._routes['GET /api/architecture/modules'] = () => {
      const arch = self._agentArchitectureOrchestrator;
      if (!arch) return { _status: 503, _data: { error: 'AgentArchitectureOrchestrator not available' } };
      return { _status: 200, _data: arch.getModuleRegistry() };
    };

    // GET /api/architecture/constants — 获取常量定义
    self._routes['GET /api/architecture/constants'] = () => {
      return { _status: 200, _data: { ARCHITECTURE_PILLAR, CONSTRAINT_TYPE, ENTROPY_LEVEL } };
    };
  }

  /** DeerFlow 2.0 融合路由：容器沙箱 + 任务分解 + 结果聚合 */
  _buildDeerFlowRoutes(self) {
    // === 容器沙箱管理 ===

    // POST /api/sandbox/create — 创建沙箱
    self._routes['POST /api/sandbox/create'] = (body) => {
      const mgr = self._containerSandboxManager;
      if (!mgr) return { _status: 503, _data: { error: 'ContainerSandboxManager not available' } };
      if (!body || !body.taskId) return { _status: 400, _data: { error: 'taskId is required' } };
      try {
        const sandboxId = mgr.createSandbox(body.taskId, body.options ?? {});
        return { _status: 200, _data: { sandboxId } };
      } catch (err) {
        return { _status: 400, _data: { error: err.message || String(err) } };
      }
    };

    // POST /api/sandbox/execute — 在沙箱中执行命令
    self._routes['POST /api/sandbox/execute'] = (body) => {
      const mgr = self._containerSandboxManager;
      if (!mgr) return { _status: 503, _data: { error: 'ContainerSandboxManager not available' } };
      if (!body || !body.sandboxId || !body.command) return { _status: 400, _data: { error: 'sandboxId and command are required' } };
      return mgr.executeInSandbox(body.sandboxId, body.command, body.options ?? {})
        .then(result => ({ _status: 200, _data: result }))
        .catch(err => ({ _status: 400, _data: { error: err && err.message ? err.message : String(err) } }));
    };

    // POST /api/sandbox/stop — 停止沙箱
    self._routes['POST /api/sandbox/stop'] = (body) => {
      const mgr = self._containerSandboxManager;
      if (!mgr) return { _status: 503, _data: { error: 'ContainerSandboxManager not available' } };
      if (!body || !body.sandboxId) return { _status: 400, _data: { error: 'sandboxId is required' } };
      return mgr.stopSandbox(body.sandboxId)
        .then(result => ({ _status: 200, _data: result }))
        .catch(err => ({ _status: 400, _data: { error: err && err.message ? err.message : String(err) } }));
    };

    // GET /api/sandbox/list — 列出所有沙箱
    self._routes['GET /api/sandbox/list'] = () => {
      const mgr = self._containerSandboxManager;
      if (!mgr) return { _status: 503, _data: { error: 'ContainerSandboxManager not available' } };
      return { _status: 200, _data: mgr.listSandboxes() };
    };

    // === 任务分解 ===

    // POST /api/decompose — 分解任务
    self._routes['POST /api/decompose'] = (body) => {
      const decomp = self._taskDecomposer;
      if (!decomp) return { _status: 503, _data: { error: 'TaskDecomposer not available' } };
      if (!body || !body.task) return { _status: 400, _data: { error: 'task is required' } };
      try {
        const result = decomp.decompose(body.task, body.options ?? {});
        return { _status: 200, _data: result };
      } catch (err) {
        return { _status: 400, _data: { error: err.message } };
      }
    };

    // === 结果聚合 ===

    // POST /api/aggregate — 聚合多Agent结果
    self._routes['POST /api/aggregate'] = (body) => {
      const agg = self._resultAggregator;
      if (!agg) return { _status: 503, _data: { error: 'ResultAggregator not available' } };
      if (!body || !Array.isArray(body.results)) return { _status: 400, _data: { error: 'results array is required' } };
      try {
        const result = agg.aggregate(body.results, body.options ?? {});
        return { _status: 200, _data: result };
      } catch (err) {
        return { _status: 400, _data: { error: err.message } };
      }
    };

    // GET /api/deerflow/constants — 获取DeerFlow常量定义
    self._routes['GET /api/deerflow/constants'] = () => {
      return { _status: 200, _data: { SANDBOX_STATUS, ISOLATION_LEVEL, DECOMPOSITION_STRATEGY, SUBTASK_STATUS, AGGREGATION_STRATEGY } };
    };
  }

  _buildMultiAgentOrchestratorRoutes(self) {
    // POST /api/orchestrator/orchestrate — 启动多智能体协调
    self._routes['POST /api/orchestrator/orchestrate'] = (body) => {
      const orch = self._multiAgentOrchestrator;
      if (!orch) return { _status: 503, _data: { error: 'MultiAgentOrchestrator not available' } };
      if (!body || !body.task) return { _status: 400, _data: { error: 'task is required' } };
      const agents = body.agents ?? [];
      const options = body.options ?? {};
      return orch.orchestrate(body.task, agents, options)
        .then(result => ({ _status: 200, _data: result }))
        .catch(_err => ({ _status: 500, _data: { error: 'Orchestration failed' } }));
    };

    // GET /api/orchestrator/status — 获取协调器状态
    self._routes['GET /api/orchestrator/status'] = () => {
      const orch = self._multiAgentOrchestrator;
      if (!orch) return { _status: 503, _data: { error: 'MultiAgentOrchestrator not available' } };
      return { _status: 200, _data: orch.getStatus() };
    };

    // POST /api/orchestrator/pause — 暂停协调
    self._routes['POST /api/orchestrator/pause'] = () => {
      const orch = self._multiAgentOrchestrator;
      if (!orch) return { _status: 503, _data: { error: 'MultiAgentOrchestrator not available' } };
      orch.pause();
      return { _status: 200, _data: { paused: true } };
    };

    // POST /api/orchestrator/resume — 恢复协调
    self._routes['POST /api/orchestrator/resume'] = () => {
      const orch = self._multiAgentOrchestrator;
      if (!orch) return { _status: 503, _data: { error: 'MultiAgentOrchestrator not available' } };
      orch.resume();
      return { _status: 200, _data: { resumed: true } };
    };

    // GET /api/orchestrator/log — 获取执行日志
    self._routes['GET /api/orchestrator/log'] = () => {
      const orch = self._multiAgentOrchestrator;
      if (!orch) return { _status: 503, _data: { error: 'MultiAgentOrchestrator not available' } };
      return { _status: 200, _data: orch.getExecutionLog() };
    };

    // GET /api/orchestrator/context — 获取分层上下文
    self._routes['GET /api/orchestrator/context'] = () => {
      const orch = self._multiAgentOrchestrator;
      if (!orch) return { _status: 503, _data: { error: 'MultiAgentOrchestrator not available' } };
      return { _status: 200, _data: orch.getLayeredContext() };
    };

    // GET /api/orchestrator/termination-history — 获取终止历史
    self._routes['GET /api/orchestrator/termination-history'] = () => {
      const orch = self._multiAgentOrchestrator;
      if (!orch) return { _status: 503, _data: { error: 'MultiAgentOrchestrator not available' } };
      return { _status: 200, _data: orch.getTerminationHistory() };
    };

    // GET /api/orchestrator/circuit-breaker — 获取熔断器状态
    self._routes['GET /api/orchestrator/circuit-breaker'] = () => {
      const orch = self._multiAgentOrchestrator;
      if (!orch) return { _status: 503, _data: { error: 'MultiAgentOrchestrator not available' } };
      return { _status: 200, _data: orch.getCircuitBreakerStatus() };
    };

    // GET /api/orchestrator/constants — 获取常量定义
    self._routes['GET /api/orchestrator/constants'] = () => {
      return { _status: 200, _data: { ORCHESTRATOR_STATUS, TERMINATION_REASON, CONTEXT_LAYER } };
    };
  }
}

applyDeepeningMixin(DashboardServer);
applyCoreQueryDataMixin(DashboardServer, { ChangelogParser: ChangelogParser });

module.exports = DashboardServer;

if (require.main === module) {
  function findProjectRoot(startDir) {
    let dir = startDir;
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(getHarnessConfigPath(dir))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return startDir;
  }
  const root = process.argv[2] || findProjectRoot(process.cwd());
  const argvPort = parseInt(process.argv[3], 10);
  const port = (Number.isFinite(argvPort) && argvPort > 0 && argvPort <= 65535) ? argvPort : DEFAULT_DASHBOARD_PORT;
  const server = new DashboardServer(root, port);

  const lifecycle = new (require('events'))();

  server.start().catch(function(err) {
    debug('Dashboard', 'startError', err);
    lifecycle.emit('fatal', { code: 1, reason: 'server_start_error', error: err });
  });

  let isShuttingDown = false;
  let _forceExitTimer = null;
  function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    debug('Dashboard', 'shutdownSignal', new Error('Received ' + signal + ', shutting down gracefully...'));

    const forceTimeout = setTimeout(function() {
      debug('Dashboard', 'forcedShutdown', new Error('Forced shutdown after timeout'));
      lifecycle.emit('fatal', { code: 1, reason: 'forced_shutdown_timeout', signal: signal });
      process.exitCode = 1;
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT);
    if (forceTimeout && typeof forceTimeout.unref === 'function') forceTimeout.unref();

    try {
      server.stop();
      clearTimeout(forceTimeout);
      debug('Dashboard', 'shutdownComplete', new Error('Server stopped successfully'));
      lifecycle.emit('shutdown', { code: 0, reason: 'graceful_shutdown', signal: signal });
      _removeProcessListeners();
    } catch (_err) {
      clearTimeout(forceTimeout);
      debug('Dashboard', 'shutdownError', _err);
      lifecycle.emit('fatal', { code: 1, reason: 'shutdown_error', error: _err });
      _removeProcessListeners();
    }
  }

  function _onFatal(info) {
    process.exitCode = typeof info.code === 'number' && Number.isFinite(info.code) ? info.code : 1;
    debug('Dashboard', 'processExit', info);
  }

  function _onShutdown(info) {
    process.exitCode = typeof info.code === 'number' && Number.isFinite(info.code) ? info.code : 0;
    debug('Dashboard', 'processExit', info);
    if (_forceExitTimer) { clearTimeout(_forceExitTimer); _forceExitTimer = null; }
  }

  function _onSIGTERM() { gracefulShutdown('SIGTERM'); }
  function _onSIGINT() { gracefulShutdown('SIGINT'); }

  function _onUnhandledRejection(reason) {
    debug('Dashboard', 'unhandledRejection', reason);
    process.exitCode = 1;
  }

  function _onUncaughtException(err) {
    debug('Dashboard', 'uncaughtException', err);
    if (server && server._shuttingDown !== undefined) server._shuttingDown = true;
    process.exitCode = 1;
    _forceExitTimer = setTimeout(function() { process.exit(1); }, DEFAULT_FORCE_EXIT_MS);
    if (_forceExitTimer && typeof _forceExitTimer.unref === 'function') { _forceExitTimer.unref(); }
    try { gracefulShutdown('uncaughtException'); } catch (gsErr) { debug('Dashboard', 'gracefulShutdownFail', gsErr); }
  }

  function _removeProcessListeners() {
    lifecycle.off('fatal', _onFatal);
    lifecycle.off('shutdown', _onShutdown);
    process.removeListener('SIGTERM', _onSIGTERM);
    process.removeListener('SIGINT', _onSIGINT);
    process.removeListener('unhandledRejection', _onUnhandledRejection);
    process.removeListener('uncaughtException', _onUncaughtException);
  }

  server._removeProcessListeners = _removeProcessListeners;

  lifecycle.on('fatal', _onFatal);
  lifecycle.on('shutdown', _onShutdown);
  process.on('SIGTERM', _onSIGTERM);
  process.on('SIGINT', _onSIGINT);
  process.on('unhandledRejection', _onUnhandledRejection);
  process.on('uncaughtException', _onUncaughtException);
}
