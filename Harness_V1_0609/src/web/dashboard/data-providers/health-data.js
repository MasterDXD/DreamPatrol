'use strict';

const { debug } = require('../../../utils/debug-logger');
const safeAssign = require('../../../utils/safe-assign');

let VERSION;
try { VERSION = require('../../../package.json').version; } catch (_e) { VERSION = 'unknown'; }

/**
 * @module dashboard/data-providers/health-data
 * @description Dashboard健康检查数据提供模块，提供系统健康状态、存活探针、就绪探针和性能统计数据
 */

/**
 * 获取系统健康状态，检查所有运行时模块的isHealthy状态
 * @param {object} server - DashboardServer实例
 * @returns {{status: string, uptime: number, memory: object, dependencies: Object<string, boolean>, timestamp: string}} 健康状态
 */
function _extractTokenInfo(tokenManager) {
  try {
    const usage = typeof tokenManager.getUsage === 'function' ? tokenManager.getUsage() : (typeof tokenManager.usage === 'number' && Number.isFinite(tokenManager.usage) ? tokenManager.usage : (typeof tokenManager.totalUsed === 'number' && Number.isFinite(tokenManager.totalUsed) ? tokenManager.totalUsed : 0));
    const budget = typeof tokenManager.getBudget === 'function' ? tokenManager.getBudget() : (typeof tokenManager.budget === 'number' && Number.isFinite(tokenManager.budget) ? tokenManager.budget : (typeof tokenManager.totalBudget === 'number' && Number.isFinite(tokenManager.totalBudget) ? tokenManager.totalBudget : 1000000000));
    return { tokenUsage: typeof usage === 'number' && Number.isFinite(usage) ? usage : 0, tokenBudget: typeof budget === 'number' && Number.isFinite(budget) ? budget : 1000000000 };
  } catch (_e) {
    debug('health-data', 'extractTokenInfo', _e && _e.message ? _e.message : String(_e));
    return { tokenUsage: 0, tokenBudget: 0 };
  }
}

function _checkModuleHealth(mod) {
  try {
    return !!(mod && typeof mod.isHealthy === 'function' ? mod.isHealthy() : mod);
  } catch (_e) {
    debug('health-data', 'checkModuleHealth', _e && _e.message ? _e.message : String(_e));
    return false;
  }
}

function _collectDependencies(rt) {
  const deps = {};
  if (!rt) return deps;
  // 属性名映射：health-data 使用的名称 → 实际 runtime 实例上的属性名
  const _NAME_MAP = {
    sessionManager: 'session',
    skillRouter: 'router',
    rbacEnforcer: 'enforcer',
    hookExecutor: 'programmableHookExecutor',
    causalConfigValidator: 'configCausalValidator',
    agentLifecycleController: 'agentLifecycle',
  };
  const checks = [
    ['sessionManager', rt.sessionManager || rt[_NAME_MAP.sessionManager]],
    ['skillRouter', rt.skillRouter || rt[_NAME_MAP.skillRouter]],
    ['rbacEnforcer', rt.rbacEnforcer || rt[_NAME_MAP.rbacEnforcer]],
    ['permissionGuard', rt.permissionGuard || rt.guard],
    ['auditLogger', rt.auditLogger || rt.logger],
    ['checkpointManager', rt.checkpointManager],
    ['tokenManager', rt.tokenManager],
    ['agentRuntime', rt.agentRuntime],
    ['agentMonitor', rt.agentMonitor],
    ['agentDeployment', rt.agentDeployment],
    ['agentLifecycleController', rt.agentLifecycleController || rt[_NAME_MAP.agentLifecycleController]],
    ['agentPackManager', rt.agentPackManager],
    ['agentStateManager', rt.agentStateManager],
    ['skillImprovementLoop', rt.skillImprovementLoop],
    ['skillReducer', rt.skillReducer],
    ['goalExecutor', rt.goalExecutor],
    ['humanApprovalGate', rt.humanApprovalGate],
    ['commandRouter', rt.commandRouter],
    ['hookExecutor', rt.hookExecutor || rt[_NAME_MAP.hookExecutor]],
    ['contextCompressionEngine', rt.contextCompressionEngine],
    ['thoughtExtractor', rt.thoughtExtractor],
    ['thoughtDeduplicator', rt.thoughtDeduplicator],
    ['thoughtMemoryStore', rt.thoughtMemoryStore],
    ['thoughtRetrieverCycle', rt.thoughtRetrieverCycle],
    ['embeddingService', rt.embeddingService],
    ['modelSelector', rt.modelSelector],
    ['affinityLearner', rt.affinityLearner],
    ['docFreshnessGuard', rt.docFreshnessGuard],
    ['causalDataBus', rt.causalDataBus],
    ['causalConfigValidator', rt.causalConfigValidator || rt[_NAME_MAP.causalConfigValidator]],
    ['concurrencyController', rt.concurrencyController],
    ['sqliteStore', rt.sqliteStore],
    ['signalPersistence', rt.signalPersistence],
    ['deepeningOrchestrator', rt.deepeningOrchestrator],
    ['deepeningPipeline', rt.deepeningPipeline],
    ['deepeningNotifier', rt.deepeningNotifier],
    ['deepeningEventStore', rt.deepeningEventStore],
    ['deepeningStateMachine', rt.deepeningStateMachine],
    ['deepeningMetricsAggregator', rt.deepeningMetricsAggregator],
    ['deepeningEventReplay', rt.deepeningEventReplay],
    ['deepeningErrorHandler', rt.deepeningErrorHandler],
    ['deepeningBackpressureManager', rt.deepeningBackpressureManager],
    ['deepeningAuditTrail', rt.deepeningAuditTrail],
    ['deepeningThrottle', rt.deepeningThrottle],
    ['deepeningTaskQueue', rt.deepeningTaskQueue],
    ['deepeningSnapshotStore', rt.deepeningSnapshotStore],
    ['deepeningRetryPolicy', rt.deepeningRetryPolicy],
    ['deepeningLoadBalancer', rt.deepeningLoadBalancer],
    ['deepeningDeployment', rt.deepeningDeployment],
    ['deepeningDependencyResolver', rt.deepeningDependencyResolver],
    ['deepeningDataPipeline', rt.deepeningDataPipeline],
    ['deepeningValidator', rt.deepeningValidator],
    ['deepeningStateManager', rt.deepeningStateManager],
    ['deepeningSnapshot', rt.deepeningSnapshot],
    ['deepeningPriorityQueue', rt.deepeningPriorityQueue],
    ['deepeningLockManager', rt.deepeningLockManager],
    ['deepeningFeatureFlags', rt.deepeningFeatureFlags],
    ['deepeningEventBus', rt.deepeningEventBus],
    ['deepeningConnectionPool', rt.deepeningConnectionPool],
    ['deepeningConfigManager', rt.deepeningConfigManager],
    ['deepeningWorkflowTemplate', rt.deepeningWorkflowTemplate],
    ['deepeningTaskScheduler', rt.deepeningTaskScheduler],
    ['deepeningServiceRegistry', rt.deepeningServiceRegistry],
    ['deepeningSecurityGuard', rt.deepeningSecurityGuard],
    ['deepeningResourceManager', rt.deepeningResourceManager],
    ['deepeningRateLimiter', rt.deepeningRateLimiter],
    ['deepeningPluginSystem', rt.deepeningPluginSystem],
    ['deepeningGracefulShutdown', rt.deepeningGracefulShutdown],
    ['deepeningCircuitBreaker', rt.deepeningCircuitBreaker],
    ['deepeningBenchmark', rt.deepeningBenchmark],
  ];
  // 从 DeepeningModuleRegistry 补充懒加载模块的健康状态
  const registry = rt.deepeningRegistry;
  // 驼峰转连字符：deepeningCircuitBreaker → deepening-circuit-breaker
  function _camelToHyphen(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  }
  for (const [name, mod] of checks) {
    if (mod) {
      deps[name] = _checkModuleHealth(mod);
    } else if (registry) {
      const hyphenName = _camelToHyphen(name);
      if (registry.isDefined(hyphenName)) {
        deps[name] = 'lazy';
      } else {
        deps[name] = false;
      }
    } else {
      deps[name] = false;
    }
  }
  return deps;
}

function getHealth(server) {
  const mem = process.memoryUsage();
  const rt = server._runtime;
  const deps = _collectDependencies(rt);
  // 只统计已加载模块的健康状态，未加载的懒加载模块不影响整体状态
  const registry = rt ? rt.deepeningRegistry : null;
  const loadedDeps = {};
  for (const [name, healthy] of Object.entries(deps)) {
    // 如果模块未加载但在 registry 中可用，视为正常（懒加载特性）
    if (healthy === false && registry && registry.isDefined(name)) {
      loadedDeps[name] = 'lazy';
    } else {
      loadedDeps[name] = healthy;
    }
  }
  const allHealthy = Object.entries(loadedDeps).every(([name, v]) => {
    // 可选依赖：缺失不影响整体健康状态
    if (v === false && (name === 'sqliteStore' || name === 'skillImprovementLoop')) return true;
    return v === true || v === 'lazy';
  });
  const result = { status: allHealthy ? 'healthy' : 'degraded', uptime: process.uptime(), memory: mem, dependencies: loadedDeps, timestamp: new Date().toISOString() };
  if (rt) {
    if (rt.phaseOrchestrator && typeof rt.phaseOrchestrator.getCurrentPhase === 'function') {
      result.phase = rt.phaseOrchestrator.getCurrentPhase();
      result.currentPhase = result.phase;
    }
    if (rt.tokenManager) {
      safeAssign(result, _extractTokenInfo(rt.tokenManager));
    }
  }
  result.version = VERSION;
  return result;
}

/**
 * 获取存活探针数据，返回进程基本存活信息
 * @param {object} _server - DashboardServer实例（未使用）
 * @returns {{status: string, uptime: number, pid: number, timestamp: string}} 存活状态
 */
function getLiveness(_server) {
  return { status: 'alive', uptime: process.uptime(), pid: process.pid, timestamp: new Date().toISOString() };
}

/**
 * 获取就绪探针数据，基于健康状态判断服务是否就绪
 * @param {object} server - DashboardServer实例
 * @returns {{status: string, checks: Object<string, boolean>, timestamp: string}} 就绪状态
 */
function getReadiness(server) {
  const health = getHealth(server);
  return { status: health.status === 'healthy' ? 'ready' : 'not_ready', checks: health.dependencies, timestamp: new Date().toISOString() };
}

/**
 * 获取性能统计数据，返回内存、运行时间和CPU使用情况
 * @param {object} _server - DashboardServer实例（未使用）
 * @returns {{memory: object, uptime: number, cpuUsage: object, timestamp: string}} 性能统计
 */
function getPerformanceStats(_server) {
  const mem = process.memoryUsage();
  return {
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    uptime: process.uptime(),
    cpuUsage: process.cpuUsage(),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getHealth, getLiveness, getReadiness, getPerformanceStats };
