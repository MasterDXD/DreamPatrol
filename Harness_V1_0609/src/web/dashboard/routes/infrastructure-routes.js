'use strict';

/**
 * @module dashboard/routes/infrastructure-routes
 * @description Dashboard基础设施API路由定义模块，注册命令路由、钩子执行器、上下文压缩、目标执行器等端点
 */

/**
 * 构建基础设施API路由映射表
 * @param {object} server - DashboardServer实例
 * @returns {Object<string, Function>} 路由路径到处理函数的映射
 */
function buildInfrastructureRoutes(server) {
  return {
    '/api/command-router/stats': () => server._getCommandRouterStats(),
    '/api/command-router/commands': () => server._getCommandRouterCommands(),
    '/api/programmable-hook/stats': () => server._getProgrammableHookStats(),
    '/api/programmable-hook/hooks': () => server._getProgrammableHooks(),
    '/api/programmable-hook/monitor': () => server._getHookMonitorData(),
    '/api/programmable-hook/slow': () => server._getSlowHooks(),
    '/api/programmable-hook/success-rates': () => server._getHookSuccessRates(),
    '/api/context-compression/stats': () => server._getContextCompressionStats(),
    '/api/context-compression/strategies': () => server._getContextCompressionStrategies(),
    '/api/auto-version/stats': () => server._getAutoVersionStats(),
    '/api/auto-version/recent': () => server._getAutoVersionRecent(),
    '/api/session/previous-context': () => server._getPreviousSessionContext(),
    '/api/goal/list': () => {
      const ge = server._rt('goalExecutor');
      if (!ge) return { _status: 503, _data: { error: 'GoalExecutor not available', available: false } };
      return { goals: ge.listGoals() };
    },
    '/api/goal/stats': () => {
      const ge = server._rt('goalExecutor');
      if (!ge) return { _status: 503, _data: { error: 'GoalExecutor not available', available: false } };
      return ge.getStats();
    },
    '/api/generator-verifier/stats': () => server._getGeneratorVerifierStats(),
    '/api/generator-verifier/history': () => server._getGeneratorVerifierHistory(),
    '/api/isolated-context/stats': () => server._getIsolatedContextStats(),
    '/api/isolated-context/active': () => server._getIsolatedContextActive(),
    '/api/plan/stats': () => server._getPlanStats(),
    '/api/plan/active': () => server._getPlanActive(),
    '/api/user/profile': () => server._getUserProfile(),
    '/api/design/stats': () => server._getDesignStats(),
    '/api/infrastructure/health-checker': () => server._getInfrastructureHealthCheckerDetails(),
    '/api/infrastructure/priority-queue': () => server._getInfrastructurePriorityQueueDetails(),
    '/api/infrastructure/event-bus': () => server._getInfrastructureEventBusStats(),
  };
}

module.exports = { buildInfrastructureRoutes };
