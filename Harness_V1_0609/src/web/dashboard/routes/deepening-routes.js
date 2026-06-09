'use strict';

/**
 * @module dashboard/routes/deepening-routes
 * @description Dashboard深化推理API路由定义模块，注册深化统计、质量、缓存、熔断器等端点，支持废弃路由标记
 */

const safeAssign = require('../../../utils/safe-assign');

/** @constant {Object<string, {replacement: string, message: string}>} 废弃路由映射表 */
const DEPRECATED_ROUTES = {
  '/api/deepening/health-monitor': { replacement: '/api/infrastructure/health-checker', message: 'Use /api/infrastructure/health-checker instead' },
  '/api/deepening/priority-queue': { replacement: '/api/infrastructure/priority-queue', message: 'Use /api/infrastructure/priority-queue instead' },
  '/api/deepening/event-bus': { replacement: '/api/infrastructure/event-bus', message: 'Use /api/infrastructure/event-bus instead' },
};

/**
 * 为废弃路由的响应数据添加废弃标记和替代路由信息
 * @param {*} data - 原始响应数据
 * @param {string} route - 路由路径
 * @returns {object} 添加废弃标记后的数据
 * @private
 */
function _withDeprecation(data, route) {
  const dep = DEPRECATED_ROUTES[route];
  if (!dep) return data;
  if (Array.isArray(data)) data = { data };
  if (!data || typeof data !== 'object') data = { data };
  return safeAssign({ _deprecated: true, _replacement: dep.replacement, _deprecationMessage: dep.message }, data);
}

/**
 * 构建深化推理API路由映射表
 * @param {object} server - DashboardServer实例
 * @returns {Object<string, Function>} 路由路径到处理函数的映射
 */
function buildDeepeningRoutes(server) {
  return {
    '/api/deepening/stats': () => server._getDeepeningStats(),
    '/api/deepening/quality': () => server._getQualityStats(),
    '/api/deepening/token-budget': () => server._getTokenBudgetStats(),
    '/api/deepening/affinities': () => server._getAffinityStats(),
    '/api/deepening/dashboard': () => server._getDeepeningDashboard(),
    '/api/deepening/metrics': () => server._getDeepeningMetrics(),
    '/api/deepening/cache': () => server._getDeepeningCacheStats(),
    '/api/deepening/convergence': () => server._getDeepeningConvergence(),
    '/api/deepening/report': () => server._getDeepeningReport(),
    '/api/deepening/pipeline': () => server._getDeepeningPipeline(),
    '/api/deepening/health': () => server._getDeepeningHealth(),
    '/api/deepening/events': () => server._getDeepeningEvents(),
    '/api/deepening/templates': () => server._getDeepeningTemplates(),
    '/api/deepening/benchmark': () => server._getDeepeningBenchmarkStats(),
    '/api/deepening/state-machine': () => server._getDeepeningStateMachine(),
    '/api/deepening/errors': () => server._getDeepeningErrors(),
    '/api/deepening/snapshots': () => server._getDeepeningSnapshots(),
    '/api/deepening/notifications': () => server._getDeepeningNotifications(),
    '/api/deepening/circuit-breaker': () => server._getDeepeningCircuitBreaker(),
    '/api/deepening/task-queue': () => server._getDeepeningTaskQueue(),
    '/api/deepening/resources': () => server._getDeepeningResources(),
    '/api/deepening/audit': () => server._getDeepeningAudit(),
    '/api/deepening/config': () => server._getDeepeningConfig(),
    '/api/deepening/health-monitor': () => _withDeprecation(server._getDeepeningHealthMonitor(), '/api/deepening/health-monitor'),
    '/api/deepening/dependencies': () => server._getDeepeningDependencies(),
    '/api/deepening/throttle': () => server._getDeepeningThrottle(),
    '/api/deepening/validator': () => server._getDeepeningValidator(),
    '/api/deepening/locks': () => server._getDeepeningLocks(),
    '/api/deepening/event-replay': () => server._getDeepeningEventReplay(),
    '/api/deepening/priority-queue': () => _withDeprecation(server._getDeepeningPriorityQueue(), '/api/deepening/priority-queue'),
    '/api/deepening/metrics-aggregator': () => server._getDeepeningMetricsAggregator(),
    '/api/deepening/rate-limiter': () => server._getDeepeningRateLimiter(),
    '/api/deepening/snapshot-store': () => server._getDeepeningSnapshotStore(),
    '/api/deepening/backpressure': () => server._getDeepeningBackpressure(),
    '/api/deepening/connection-pool': () => server._getDeepeningConnectionPool(),
    '/api/deepening/retry-policy': () => server._getDeepeningRetryPolicy(),
    '/api/deepening/service-registry': () => server._getDeepeningServiceRegistry(),
    '/api/deepening/load-balancer': () => server._getDeepeningLoadBalancer(),
    '/api/deepening/timeout-manager': () => server._getDeepeningTimeoutManager(),
    '/api/deepening/graceful-shutdown': () => server._getDeepeningGracefulShutdown(),
    '/api/deepening/feature-flags': () => server._getDeepeningFeatureFlags(),
    '/api/deepening/task-scheduler': () => server._getDeepeningTaskScheduler(),
    '/api/deepening/data-pipeline': () => server._getDeepeningDataPipeline(),
    '/api/deepening/state-manager': () => server._getDeepeningStateManager(),
    '/api/deepening/event-bus': () => _withDeprecation(server._getDeepeningEventBus(), '/api/deepening/event-bus'),
    '/api/deepening/config-manager': () => server._getDeepeningConfigManager(),
    '/api/deepening/resource-manager': () => server._getDeepeningResourceManager(),
    '/api/deepening/audit-trail': () => server._getDeepeningAuditTrail(),
    '/api/deepening-registry/stats': () => server._getDeepeningRegistryStats(),
  };
}

module.exports = { buildDeepeningRoutes, DEPRECATED_ROUTES };
