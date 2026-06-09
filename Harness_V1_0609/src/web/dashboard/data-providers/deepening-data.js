'use strict';

/**
 * @module dashboard/data-providers/deepening-data
 * @description Dashboard深化推理数据提供模块，提供深化模块数据获取、统计聚合和代理方法注册
 */

/** @constant {Object<string, {replacement: string, message: string}>} 废弃模块映射表 */
const DEPRECATED_MODULES = {
  deepeningHealthMonitor: { replacement: 'healthChecker', message: 'Use HealthChecker instead' },
  deepeningPriorityQueue: { replacement: 'priorityQueue', message: 'Use PriorityQueue instead' },
  deepeningEventBus: { replacement: 'eventBus', message: 'Use EventBus instead' },
  deepeningWorkflowTemplate: { replacement: 'workflowTemplate', message: 'Use WorkflowTemplate instead' },
  deepeningPluginSystem: { replacement: 'pluginManager', message: 'Use PluginManager instead' },
};

/** @constant {Object<string, {details?: Array}>} 深化API注册表，定义各模块的详情获取方式 */
const DEEPENING_API_REGISTRY = {
  'deepeningCircuitBreaker': { details: [] },
  'deepeningTaskQueue': { details: [{ key: 'completed', method: 'getCompletedTasks', args: [10] }] },
  'deepeningResourceManager': { details: [{ key: 'pools', method: 'getPoolNames', enumerate: 'getPoolInfo' }] },
  'deepeningAuditTrail': { details: [{ key: 'recentEntries', method: 'query', args: [{ limit: 20 }] }, { key: 'severityCounts', method: 'getSeverityCounts' }, { key: 'actionCounts', method: 'getActionCounts' }] },
  'deepeningConfigManager': { details: [{ key: 'configs', method: 'getKeys', enumerate: 'getConfigInfo' }] },
  'deepeningHealthMonitor': { details: [{ key: 'results', method: '_results', transform: (v) => { const r = {}; if (v) v.forEach(function(val, k) { r[k] = val; }); return r; } }, { key: 'history', method: 'getHistory', args: [10] }] },
  'deepeningDependencyResolver': { details: [{ key: 'nodes', method: '_nodes', transform: (v) => { const r = []; if (v) v.forEach(function(n) { r.push({ id: n.id, data: n.data, dependencies: n.dependencies, dependents: n.dependents }); }); return r; } }] },
  'deepeningThrottle': {},
  'deepeningValidator': { details: [{ key: 'schemas', method: 'getSchemas' }] },
  'deepeningLockManager': { details: [{ key: 'locks', method: '_locks', transform: (v) => { const r = []; if (v) v.forEach(function(l) { r.push({ resourceId: l.resourceId, ownerId: l.ownerId, acquiredAt: l.acquiredAt, refCount: l.refCount, timeout: l.timeout, elapsed: Date.now() - l.acquiredAt }); }); return r; } }, { key: 'expiredLocks', method: 'getExpiredLocks' }] },
  'deepeningEventReplay': { details: [{ key: 'recentEvents', method: 'getEvents', args: [{ limit: 20 }] }, { key: 'eventTypes', method: 'getEventTypes' }] },
  'deepeningPriorityQueue': { details: [{ key: 'completed', method: 'getCompleted', args: [10] }] },
  'deepeningMetricsAggregator': { details: [{ key: 'dashboard', method: 'getDashboard' }, { key: 'names', method: 'getNames' }] },
  'deepeningRateLimiter': { details: [{ key: 'buckets', method: 'getBucketNames', enumerate: 'getBucket' }] },
  'deepeningSnapshotStore': { details: [{ key: 'names', method: 'getNames' }] },
  'deepeningBackpressureManager': { details: [{ key: 'streams', method: 'getStreamNames', enumerate: 'getPressure' }] },
  'deepeningConnectionPool': { details: [{ key: 'pools', method: 'getPoolNames', enumerate: 'getPoolInfo' }] },
  'deepeningRetryPolicy': { details: [{ key: 'policyNames', method: 'getPolicyNames' }] },
  'deepeningServiceRegistry': { details: [{ key: 'services', method: 'getServiceNames', enumerate: 'getService' }] },
  'deepeningLoadBalancer': { details: [{ key: 'poolNames', method: 'getPoolNames' }] },
  'deepeningTimeoutManager': { details: [{ key: 'active', method: 'getActive' }] },
  'deepeningGracefulShutdown': { details: [{ key: 'progress', method: 'getProgress' }, { key: 'steps', method: 'getSteps' }] },
  'deepeningFeatureFlags': { details: [{ key: 'flagNames', method: 'getFlagNames' }, { key: 'flags', method: 'getFlagNames', enumerate: 'getFlag' }] },
  'deepeningTaskScheduler': { details: [{ key: 'pending', method: 'getPending' }, { key: 'running', method: 'getRunning' }] },
  'deepeningDataPipeline': { details: [{ key: 'pipelines', method: 'getPipelineNames', enumerate: 'getPipelineInfo' }] },
  'deepeningStateManager': { details: [{ key: 'machines', method: 'getMachineNames', enumerate: 'getMachineInfo' }] },
  'deepeningEventBus': { details: [{ key: 'topics', method: 'getTopicNames' }] },
  'deepeningSnapshot': { details: [{ key: 'snapshots', method: 'listAll' }] },
  'deepeningNotifier': { details: [{ key: 'notifications', method: 'getNotificationLog', args: [{ limit: 20 }] }] },
  'deepeningErrorHandler': { details: [{ key: 'errors', method: 'getErrorLog', args: [{ limit: 20 }] }] },
  'deepeningStateMachine': { details: [{ key: 'executions', method: 'getAllExecutions' }] },
  'deepeningBenchmark': { details: [{ key: 'results', method: 'getResults', args: [5] }] },
  'deepeningWorkflowTemplate': { details: [{ key: 'templates', method: 'list' }] },
  'deepeningEventStore': { details: [{ key: 'events', method: 'query', args: [{ limit: 20 }] }, { key: 'dashboard', method: 'getDashboard' }] },
  'deepeningCache': { details: [{ key: 'entries', method: 'getEntries', args: [20] }] },
  'convergenceDetector': { details: [] },
  'deepeningReportGenerator': { details: [{ key: 'history', method: 'getReportHistory', args: [10] }] },
  'deepeningPipeline': { details: [] },
};

/**
 * 获取深化模块数据，根据API注册表规范调用模块方法获取统计和详情
 * @param {Function} rt - 运行时模块获取函数
 * @param {string} moduleName - 模块名称
 * @returns {object} 模块数据，包含stats和各详情键
 */
function getDeepeningModuleData(rt, moduleName) {
  const spec = DEEPENING_API_REGISTRY[moduleName];
  const mod = rt(moduleName);
  if (!mod) {
    const defaults = spec && spec.details ? spec.details.reduce((acc, d) => { acc[d.key] = d.enumerate ? {} : []; return acc; }, {}) : {};
    return { stats: {}, ...defaults };
  }
  let stats = {};
  try { stats = mod.getStats(); } catch (_e) { stats = {}; }
  const result = { stats };
  if (spec && spec.details) {
    for (const d of spec.details) {
      try {
        if (d.enumerate) {
          const names = typeof mod[d.method] === 'function' ? mod[d.method]() : [];
          const obj = {};
          names.forEach(function(name) { obj[name] = mod[d.enumerate](name); });
          result[d.key] = obj;
        } else if (d.transform) {
          const val = mod[d.method];
          result[d.key] = d.transform(val);
        } else if (typeof mod[d.method] === 'function') {
          result[d.key] = d.args ? mod[d.method](...d.args) : mod[d.method]();
        }
      } catch (_e) {
        result[d.key] = d.enumerate ? {} : [];
      }
    }
  }
  return result;
}

/**
 * 获取深化推理统计，聚合多个核心模块的getStats结果
 * @param {Function} rt - 运行时模块获取函数
 * @returns {{modules: Object<string, object>}} 深化统计
 */
function getDeepeningStats(rt) {
  const moduleNames = ['recurrentDeepening', 'adaptiveDepth', 'ltiInjector', 'multiAgentRouter', 'outputFusion', 'iterativeRefinement', 'progressiveDeepening', 'deepeningOrchestrator'];
  const modules = {};
  for (const name of moduleNames) {
    const mod = rt(name);
    if (mod) {
      try { modules[name] = mod.getStats(); }
      catch (_e) { modules[name] = {}; }
    }
  }
  return { modules };
}

/**
 * 获取质量评分统计和历史
 * @param {Function} rt - 运行时模块获取函数
 * @returns {{stats: object, history: Array}} 质量统计
 */
function getQualityStats(rt) {
  if (!rt('qualityScorer')) return { stats: {}, history: [] };
  return { stats: rt('qualityScorer').getStats(), history: rt('qualityScorer').getHistory(20) };
}

/**
 * 获取Token预算统计和效率报告
 * @param {Function} rt - 运行时模块获取函数
 * @returns {{stats: object, efficiency: object}} Token预算统计
 */
function getTokenBudgetStats(rt) {
  if (!rt('tokenAwareDeepening')) return { stats: {}, efficiency: {} };
  return { stats: rt('tokenAwareDeepening').getStats(), efficiency: rt('tokenAwareDeepening').getEfficiencyReport() };
}

/**
 * 获取亲和度学习器统计
 * @param {Function} rt - 运行时模块获取函数
 * @returns {{stats: object, recommendations?: Array}} 亲和度统计
 */
function getAffinityStats(rt) {
  if (!rt('affinityLearner')) return { stats: {}, recommendations: [] };
  return { stats: rt('affinityLearner').getStats() };
}

/**
 * 获取深化推理仪表盘数据，聚合编排器、质量评分、收敛检测和缓存统计
 * @param {Function} rt - 运行时模块获取函数
 * @returns {{modules: object, metrics: object, cache: object, convergence: object}} 仪表盘数据
 */
function getDeepeningDashboard(rt) {
  const dashboard = { modules: {}, metrics: {}, cache: {}, convergence: {} };
  if (rt('deepeningOrchestrator')) dashboard.modules.orchestrator = rt('deepeningOrchestrator').getStats();
  if (rt('qualityScorer')) dashboard.modules.qualityScorer = rt('qualityScorer').getStats();
  if (rt('convergenceDetector')) dashboard.modules.convergenceDetector = rt('convergenceDetector').getStats();
  if (rt('deepeningMetricsCollector')) dashboard.metrics = rt('deepeningMetricsCollector').getDashboard();
  if (rt('deepeningCache')) dashboard.cache = rt('deepeningCache').getStats();
  return dashboard;
}

/**
 * 获取深化指标采集器的统计和仪表盘数据
 * @param {Function} rt - 运行时模块获取函数
 * @returns {{stats: object, dashboard: object}} 指标数据
 */
function getDeepeningMetrics(rt) {
  if (!rt('deepeningMetricsCollector')) return { stats: {}, dashboard: {} };
  return { stats: rt('deepeningMetricsCollector').getStats(), dashboard: rt('deepeningMetricsCollector').getDashboard() };
}

/** @constant {Object<string, string>} 深化代理方法映射表，方法名到模块名的映射 */
const DEEPENING_PROXY_METHODS = {
  deepeningCacheStats: 'deepeningCache',
  deepeningConvergence: 'convergenceDetector',
  deepeningReport: 'deepeningReportGenerator',
  deepeningPipeline: 'deepeningPipeline',
  deepeningHealth: 'deepeningHealthMonitor',
  deepeningEvents: 'deepeningEventStore',
  deepeningTemplates: 'deepeningWorkflowTemplate',
  deepeningBenchmarkStats: 'deepeningBenchmark',
  deepeningStateMachine: 'deepeningStateMachine',
  deepeningErrors: 'deepeningErrorHandler',
  deepeningSnapshots: 'deepeningSnapshot',
  deepeningNotifications: 'deepeningNotifier',
  deepeningCircuitBreaker: 'deepeningCircuitBreaker',
  deepeningTaskQueue: 'deepeningTaskQueue',
  deepeningResources: 'deepeningResourceManager',
  deepeningAudit: 'deepeningAuditTrail',
  deepeningConfig: 'deepeningConfigManager',
  deepeningHealthMonitor: 'deepeningHealthMonitor',
  deepeningDependencies: 'deepeningDependencyResolver',
  deepeningThrottle: 'deepeningThrottle',
  deepeningValidator: 'deepeningValidator',
  deepeningLocks: 'deepeningLockManager',
  deepeningEventReplay: 'deepeningEventReplay',
  deepeningPriorityQueue: 'deepeningPriorityQueue',
  deepeningMetricsAggregator: 'deepeningMetricsAggregator',
  deepeningRateLimiter: 'deepeningRateLimiter',
  deepeningSnapshotStore: 'deepeningSnapshotStore',
  deepeningBackpressure: 'deepeningBackpressureManager',
  deepeningConnectionPool: 'deepeningConnectionPool',
  deepeningRetryPolicy: 'deepeningRetryPolicy',
  deepeningServiceRegistry: 'deepeningServiceRegistry',
  deepeningLoadBalancer: 'deepeningLoadBalancer',
  deepeningTimeoutManager: 'deepeningTimeoutManager',
  deepeningGracefulShutdown: 'deepeningGracefulShutdown',
  deepeningFeatureFlags: 'deepeningFeatureFlags',
  deepeningTaskScheduler: 'deepeningTaskScheduler',
  deepeningDataPipeline: 'deepeningDataPipeline',
  deepeningStateManager: 'deepeningStateManager',
  deepeningEventBus: 'deepeningEventBus',
  deepeningConfigManager: 'deepeningConfigManager',
  deepeningResourceManager: 'deepeningResourceManager',
  deepeningAuditTrail: 'deepeningAuditTrail',
};

module.exports = {
  DEPRECATED_MODULES,
  DEEPENING_API_REGISTRY,
  DEEPENING_PROXY_METHODS,
  getDeepeningModuleData,
  getDeepeningStats,
  getQualityStats,
  getTokenBudgetStats,
  getAffinityStats,
  getDeepeningDashboard,
  getDeepeningMetrics,
};
