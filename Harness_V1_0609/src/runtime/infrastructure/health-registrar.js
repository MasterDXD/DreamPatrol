/**
 * @module runtime/infrastructure/health-registrar
 * @description 健康检查注册器模块。负责将系统中所有核心组件、可选模块和深化推理子系统的
 * 健康检查项自动注册到 HealthChecker 实例中，实现统一的状态监控与异常检测。
 * 涵盖标准健康检查（SessionManager、SkillRouter、RBAC等）、统计型健康检查
 * （AgentMonitor、AuditLogger等）、深化推理子系统检查以及可选模块检查。
 */
'use strict';

/**
 * 记忆验证率的健康阈值百分比。当记忆验证率低于此值时，
 * memory-verification 健康检查项将报告为不健康状态。
 * @constant {number}
 */
const MEMORY_VERIFICATION_RATE_THRESHOLD = 80;

/**
 * 标准健康检查项配置列表。每项定义了核心组件的健康检查规则，
 * 包含检查名称、上下文中对应的模块属性名、严重级别及检查函数。
 * 所有检查项均为 critical 级别，表示这些组件对系统运行至关重要。
 * @constant {Array<{name: string, src: string, level: string, fn: function(Object): {healthy: boolean, message: string, details: Object}}>}
 */
const HEALTH_CHECK_STANDARD = [
  { name: 'session-manager', src: 'session', level: 'critical', fn: function(m) { return ({
    healthy: m.isHealthy(),
    message: m.isHealthy() ? 'SessionManager is running' : 'SessionManager is shut down',
    details: { sessionCount: Object.keys(m.sessions ?? {}).length },
  }); }},
  { name: 'skill-router', src: 'router', level: 'critical', fn: function(m) { return ({
    healthy: m.skills.length > 0,
    message: m.skills.length + ' skills discovered',
    details: { skillCount: m.skills.length },
  }); }},
  { name: 'rbac-enforcer', src: 'enforcer', level: 'critical', fn: function(m) { return ({
    healthy: Object.keys(m.agents ?? {}).length > 0,
    message: Object.keys(m.agents ?? {}).length + ' agents loaded',
    details: { agentCount: Object.keys(m.agents ?? {}).length },
  }); }},
  { name: 'concurrency-controller', src: 'concurrencyController', level: 'critical', fn: function(m) {
    const stats = m.getStats();
    return { healthy: stats.runningCount <= stats.maxConcurrent, message: stats.runningCount + '/' + stats.maxConcurrent + ' slots in use', details: stats };
  }},
  { name: 'agent-runtime', src: 'agentRuntime', level: 'critical', fn: function(m) {
    const stats = m.getStats();
    return { healthy: m.isHealthy(), message: stats.totalAgents + ' agents registered', details: stats };
  }},
  { name: 'token-manager', src: 'tokenManager', level: 'critical', fn: function(m) {
    const stats = m.getStats();
    return { healthy: m.isHealthy(), message: stats.totalSessions + ' sessions tracked, ' + m.formatTokens(stats.total) + ' total consumed', details: stats };
  }},
  { name: 'tdd-gate', src: 'tddGate', level: 'critical', fn: function(m) { return ({
    healthy: m.isHealthy(), message: 'TDD gate active', details: { taskCount: Object.keys(m.cycles ?? {}).length },
  }); }},
  { name: 'evidence-verifier', src: 'verifier', level: 'critical', fn: function(m) { return ({
    healthy: m.isHealthy(), message: 'Evidence verifier active', details: { skillTypes: Object.keys(m.constructor.EVIDENCE_REQUIREMENTS ?? {}).length },
  }); }},
  { name: 'permission-guard', src: 'guard', level: 'critical', fn: function(m) { return ({
    healthy: m.isHealthy(), message: 'Permission guard active, ' + Object.keys(m.locks ?? {}).length + ' active locks, ' + Object.keys(m.confirmations ?? {}).length + ' confirmations', details: { activeLocks: Object.keys(m.locks ?? {}).length, activeConfirmations: Object.keys(m.confirmations ?? {}).length, confirmationExpiryMs: m._confirmationExpiryMs },
  }); }},
  { name: 'checkpoint-manager', src: 'checkpointManager', level: 'critical', fn: function(m) { return ({
    healthy: m.isHealthy(), message: 'Checkpoint manager active', details: {},
  }); }},
  { name: 'subagent-executor', src: 'subagentExecutor', level: 'critical', fn: function(m) { return ({
    healthy: m.isHealthy(), message: 'Subagent executor active', details: m.getStats(),
  }); }},
];

/**
 * 统计型健康检查项配置列表。与标准检查不同，这些检查项通过 getStats() 方法
 * 获取模块统计信息，支持多种检查模式：始终健康（alwaysHealthy）、
 * 统计获取（useGetStats）、条目计数（entryCount）和默认统计模式。
 * 严重级别包括 warning 和 info。
 * @constant {Array<{name: string, src?: string, level: string, label?: string, entryCount?: boolean, alwaysHealthy?: boolean, message?: string, useGetStats?: boolean}>}
 */
const HEALTH_CHECK_WITH_STATS = [
  { name: 'agent-monitor', src: 'agentMonitor', level: 'warning', label: 'agents monitored' },
  { name: 'agent-state-manager', src: 'agentStateManager', level: 'warning', label: 'agent states managed' },
  { name: 'audit-logger', src: 'logger', level: 'warning', label: 'entries', entryCount: true },
  { name: 'compliance-checker', level: 'warning', alwaysHealthy: true, message: 'Framework compliance checker active' },
  { name: 'design-engine', src: 'designSkillEngine', level: 'info', label: 'Design skill engine active', useGetStats: true },
  { name: 'skill-reducer', src: 'skillReducer', level: 'info', useGetStats: true },
  { name: 'plan-persistence', src: 'planPersistence', level: 'info', useGetStats: true },
  { name: 'collaboration-mode-router', src: 'collaborationModeRouter', level: 'warning', useGetStats: true },
  { name: 'structured-intent', src: 'structuredIntent', level: 'warning', useGetStats: true },
  { name: 'pair-chat', src: 'pairChat', level: 'warning', useGetStats: true },
  { name: 'chat-chain', src: 'chatChain', level: 'warning', useGetStats: true },
  { name: 'generator-verifier', src: 'generatorVerifier', level: 'warning', useGetStats: true },
  { name: 'isolated-context-manager', src: 'isolatedContextManager', level: 'warning', useGetStats: true },
  { name: 'command-router', src: 'commandRouter', level: 'info', useGetStats: true },
  { name: 'programmable-hook-executor', src: 'programmableHookExecutor', level: 'info', useGetStats: true },
  { name: 'context-compression-engine', src: 'contextCompressionEngine', level: 'info', useGetStats: true },
  { name: 'model-selector', src: 'modelSelector', level: 'info', useGetStats: true },
  { name: 'thought-retriever-cycle', src: 'thoughtRetrieverCycle', level: 'info', useGetStats: true },
  { name: 'thought-memory-store', src: 'thoughtMemoryStore', level: 'info', useGetStats: true },
  { name: 'embedding-service', src: 'embeddingService', level: 'info', useGetStats: true },
];

/**
 * 深化推理子系统中各模块的健康检查名称到上下文属性名的映射表。
 * 键为健康检查注册时使用的名称，值为运行时上下文中对应模块的属性名。
 * 仅当上下文中存在对应模块时才注册健康检查。
 * @constant {Object<string, string>}
 */
const DEEPENING_HEALTH_KEY_MAP = {
  'recurrent-deepening': 'recurrentDeepening',
  'adaptive-depth': 'adaptiveDepth',
  'lti-injector': 'ltiInjector',
  'multi-agent-router': 'multiAgentRouter',
  'output-fusion': 'outputFusion',
  'iterative-refinement': 'iterativeRefinement',
  'progressive-deepening': 'progressiveDeepening',
  'deepening-orchestrator': 'deepeningOrchestrator',
  'quality-scorer': 'qualityScorer',
  'token-aware-deepening': 'tokenAwareDeepening',
  'affinity-learner': 'affinityLearner',
  'convergence-detector': 'convergenceDetector',
  'deepening-metrics-collector': 'deepeningMetricsCollector',
  'deepening-cache': 'deepeningCache',
  'deepening-strategy-plugin': 'deepeningStrategyPlugin',
  'deepening-report-generator': 'deepeningReportGenerator',
  'deepening-pipeline': 'deepeningPipeline',
  'deepening-health-monitor': 'deepeningHealthMonitor',
  'deepening-event-store': 'deepeningEventStore',
  'deepening-workflow-template': 'deepeningWorkflowTemplate',
  'deepening-benchmark': 'deepeningBenchmark',
};

/**
 * 向 HealthChecker 注册所有健康检查项。按以下顺序依次注册：
 * 1. 标准健康检查（HEALTH_CHECK_STANDARD）— 核心组件的 critical 级别检查
 * 2. 存储层检查 — SQLite 或 JSON 降级存储的状态检查
 * 3. 统计型健康检查（HEALTH_CHECK_WITH_STATS）— 支持多种统计获取模式
 * 4. 深化推理子系统模块检查（DEEPENING_HEALTH_KEY_MAP）
 * 5. 深化推理子系统整体检查
 * 6. 自动版本追踪器检查
 * 7. 条件性可选模块检查（信号持久化、自演化治理器等）
 * 8. 可选模块列表检查（SQLite存储、技能改进循环等）
 * 9. 反模式检测检查
 * 10. 记忆验证检查
 * @param {Object} ctx - 运行时上下文对象，包含所有待监控的模块实例及 healthChecker
 * @param {import('../infrastructure/health-checker')} ctx.healthChecker - 健康检查器实例
 */
function _registerHealthChecks(ctx) {
  for (const check of HEALTH_CHECK_STANDARD) {
    const mod = ctx[check.src];
    ctx.healthChecker.register(check.name, function() { return check.fn(mod); }, check.level);
  }

  ctx.healthChecker.register('memory-store', function() {
    if (ctx.sqliteStore) {
      const stats = ctx.sqliteStore.getStats();
      return {
        healthy: true,
        message: 'SQLite: ' + stats.knowledge + ' knowledge, ' + stats.sessionSummaries + ' summaries, ' + stats.skillLearnings + ' learnings, ' + stats.affinityRecords + ' affinities',
        details: stats,
      };
    }
    const stats = ctx.memoryStore.getStats();
    return {
      healthy: true,
      message: stats.knowledgeCount + ' knowledge entries, ' + stats.summaryCount + ' summaries (JSON fallback)',
      details: stats,
    };
  }, 'warning');

  for (const check of HEALTH_CHECK_WITH_STATS) {
    const mod = check.src ? ctx[check.src] : null;
    if (check.alwaysHealthy) {
      ctx.healthChecker.register(check.name, function() { return { healthy: true, message: check.message, details: {} }; }, check.level);
    } else if (!mod) {
      ctx.healthChecker.register(check.name, function() { return { healthy: false, message: (check.label || check.name) + ' not initialized', details: {} }; }, check.level);
    } else if (check.useGetStats) {
      ctx.healthChecker.register(check.name, function() { return ({
        healthy: mod.isHealthy(),
        message: (check.label || check.name) + ' active',
        details: mod.getStats(),
      }); }, check.level);
    } else if (check.entryCount) {
      ctx.healthChecker.register(check.name, function() {
        const entryCount = (mod._entries && typeof mod._entries.length === 'number') ? mod._entries.length : 0;
        return {
          healthy: mod.isHealthy(),
          message: check.label + ' active, ' + entryCount + ' entries',
          details: { entryCount: entryCount },
        };
      }, check.level);
    } else {
      const label = check.label || check.name;
      ctx.healthChecker.register(check.name, function() {
        const liveStats = mod.getStats();
        return {
          healthy: mod.isHealthy(),
          message: (liveStats.totalAgents || (liveStats.monitoredAgents ?? 0)) + ' ' + label,
          details: liveStats,
        };
      }, check.level);
    }
  }

  for (const [name, key] of Object.entries(DEEPENING_HEALTH_KEY_MAP)) {
    const mod = ctx[key];
    if (mod) {
      ctx.healthChecker.register(name, function() { return ({
        healthy: mod.isHealthy(),
        message: name + ' active',
        details: mod.getStats(),
      }); }, 'warning');
    }
  }

  ctx.healthChecker.register('deepening-subsystem', function() { return _checkDeepeningSubsystem(ctx.deepeningRegistry); }, 'warning');

  ctx.healthChecker.register('auto-version-tracker', function() { return ({
    healthy: ctx.autoVersionTracker?.isHealthy() ?? false,
    message: 'Auto version tracker ' + (ctx.autoVersionTracker?.isHealthy() ? 'active' : 'inactive'),
    details: ctx.autoVersionTracker?.getStats() ?? {},
  }); }, 'info');

  if (ctx.signalPersistence) {
    ctx.healthChecker.register('signal-persistence', function() { return ({
      healthy: ctx.signalPersistence?.isHealthy() ?? false,
      message: 'Signal persistence active',
      details: ctx.signalPersistence?.getStats() ?? {},
    }); }, 'warning');
  }

  if (ctx.selfEvolutionGovernor) {
    ctx.healthChecker.register('self-evolution-governor', function() { return ({
      healthy: ctx.selfEvolutionGovernor?.isHealthy() ?? false,
      message: 'Self-evolution governor ' + (ctx.selfEvolutionGovernor._running ? 'running' : 'stopped'),
      details: ctx.selfEvolutionGovernor?.getStats() ?? {},
    }); }, 'info');
  }

  if (ctx.skillPatchApproval) {
    ctx.healthChecker.register('skill-patch-approval', function() { return ({
      healthy: ctx.skillPatchApproval?.isHealthy() ?? false,
      message: 'Skill patch approval active',
      details: ctx.skillPatchApproval?.getStats() ?? {},
    }); }, 'info');
  }

  if (ctx.causalVectorIndex) {
    ctx.healthChecker.register('causal-vector-index', function() { return ({
      healthy: ctx.causalVectorIndex?.isHealthy() ?? false,
      message: 'Causal vector index active',
      details: ctx.causalVectorIndex?.getStats() ?? {},
    }); }, 'info');
  }

  const optionalModules = [
    { name: 'sqlite-store', src: 'sqliteStore', level: 'warning' },
    { name: 'skill-improvement-loop', src: 'skillImprovementLoop', level: 'info' },
    { name: 'memory-nudge', src: 'memoryNudge', level: 'info' },
    { name: 'user-model-manager', src: 'userModelManager', level: 'info' },
    { name: 'mcp-client', src: 'mcpClient', level: 'info' },
    { name: 'skill-creation-engine', src: 'skillCreationEngine', level: 'info' },
    { name: 'skill-curator', src: 'skillCurator', level: 'info' },
    { name: 'goal-executor', src: 'goalExecutor', level: 'info' },
  ];
  for (const opt of optionalModules) {
    const mod = ctx[opt.src];
    if (mod) {
      const statsFn = opt.src === 'skillCurator' ? 'getAllStats' : 'getStats';
      ctx.healthChecker.register(opt.name, function() {
        try {
          return {
            healthy: true,
            message: opt.name + ' active',
            details: typeof mod[statsFn] === 'function' ? mod[statsFn]() : {},
          };
        } catch (err) {
          return {
            healthy: false,
            message: opt.name + ' error: ' + (err && err.message ? err.message : String(err)),
            details: {},
          };
        }
      }, opt.level);
    }
  }

  if (ctx.agentMonitor) {
    ctx.healthChecker.register('antipattern-detection', function() {
      const rules = ctx.agentMonitor.getAntipatternRules();
      const alerts = ctx.agentMonitor.getAlerts();
      const antipatternAlerts = alerts.filter(function(a) { return a.metricName && a.metricName.startsWith('antipattern:'); });
      return {
        healthy: antipatternAlerts.length === 0,
        message: rules.length + ' antipattern rules active, ' + antipatternAlerts.length + ' detections',
        details: { rules: rules.length, detections: antipatternAlerts.length, recentAlerts: antipatternAlerts.slice(-5) },
      };
    }, 'warning');
  }

  if (ctx.sqliteStore) {
    ctx.healthChecker.register('memory-verification', function() {
      const stats = ctx.sqliteStore.getMemoryVerificationStats();
      return {
        healthy: stats.verificationRate >= MEMORY_VERIFICATION_RATE_THRESHOLD,
        message: 'Memory verification rate: ' + stats.verificationRate + '% (' + stats.verified + '/' + stats.total + ' verified, ' + stats.stale + ' stale)',
        details: stats,
      };
    }, 'info');
  }
}

/**
 * 向深化推理子系统内部的 HealthMonitor 注册核心模块的健康检查。
 * 仅注册深化推理管道中的关键组件：编排器、质量评分器、收敛检测器、
 * 指标采集器、缓存和注册表。仅当模块实例存在时才注册。
 * @param {Object} ctx - 运行时上下文对象，包含深化推理子系统的各模块实例
 * @param {Object} ctx.deepeningHealthMonitor - 深化推理子系统内部健康监控器
 */
function _registerDeepeningInternalHealth(ctx) {
  const srcMap = {
    'deepening-orchestrator': ctx.deepeningOrchestrator,
    'quality-scorer': ctx.qualityScorer,
    'convergence-detector': ctx.convergenceDetector,
    'metrics-collector': ctx.deepeningMetricsCollector,
    'cache': ctx.deepeningCache,
    'registry': ctx.deepeningRegistry,
  };
  for (const entry of Object.entries(srcMap)) {
    if (entry[1]) {
      ctx.deepeningHealthMonitor.register(entry[0], function() { return ({
        healthy: typeof entry[1].isHealthy === 'function' ? entry[1].isHealthy() : true,
        message: entry[0] + ' running',
        details: typeof entry[1].getStats === 'function' ? entry[1].getStats() : {},
      }); });
    }
  }
}

/**
 * 检查深化推理子系统的整体健康状况。遍历注册表中所有已加载模块，
 * 逐一调用 isHealthy() 方法检测不健康的模块，并汇总注册表的统计信息。
 * @param {Object} registry - 深化推理模块注册表实例
 * @param {function} registry.getStats - 获取注册表统计信息的方法
 * @param {function} registry.listLoaded - 获取已加载模块名称列表的方法
 * @param {function} registry.get - 根据名称获取模块实例的方法
 * @returns {{healthy: boolean, message: string, details: {totalDefined: number, totalLoaded: number, currentDepthLevel: number, loadedByTier: Object, lazyLoads: number, unhealthyModules: string[]}}}
 * 健康检查结果对象，包含健康状态、描述消息和详细统计信息
 */
function _checkDeepeningSubsystem(registry) {
  const stats = registry.getStats();
  const loadedModules = registry.listLoaded();
  const unhealthy = [];
  for (const name of loadedModules) {
    const instance = registry.get(name);
    if (instance && typeof instance.isHealthy === 'function' && !instance.isHealthy()) {
      unhealthy.push(name);
    }
  }
  return {
    healthy: unhealthy.length === 0,
    message: unhealthy.length === 0
      ? 'Deepening subsystem healthy (' + loadedModules.length + ' modules loaded)'
      : 'Unhealthy modules: ' + unhealthy.join(', '),
    details: {
      totalDefined: stats.totalDefined,
      totalLoaded: stats.totalLoaded,
      currentDepthLevel: stats.currentDepthLevel,
      loadedByTier: stats.loadedByTier,
      lazyLoads: stats.lazyLoads,
      unhealthyModules: unhealthy,
    },
  };
}

/**
 * @exports runtime/infrastructure/health-registrar
 * 导出健康检查注册器的常量配置和注册函数，供运行时初始化流程调用。
 * @property {Array} HEALTH_CHECK_STANDARD - 标准健康检查项配置列表
 * @property {Array} HEALTH_CHECK_WITH_STATS - 统计型健康检查项配置列表
 * @property {Object} DEEPENING_HEALTH_KEY_MAP - 深化推理模块名称映射表
 * @property {function} _registerHealthChecks - 全量健康检查注册函数
 * @property {function} _registerDeepeningInternalHealth - 深化推理子系统内部健康检查注册函数
 * @property {function} _checkDeepeningSubsystem - 深化推理子系统整体健康检查函数
 */
module.exports = {
  HEALTH_CHECK_STANDARD,
  HEALTH_CHECK_WITH_STATS,
  DEEPENING_HEALTH_KEY_MAP,
  _registerHealthChecks,
  _registerDeepeningInternalHealth,
  _checkDeepeningSubsystem,
};
