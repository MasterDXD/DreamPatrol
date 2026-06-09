'use strict';

/**
 * @module dashboard/routes/agent-routes
 * @description Dashboard Agent API路由定义模块，注册Agent生命周期、运行时、监控、部署、状态、沙箱、审批和子Agent端点
 */

/**
 * 构建Agent API路由映射表
 * @param {object} server - DashboardServer实例
 * @returns {Object<string, Function>} 路由路径到处理函数的映射
 */
function buildAgentRoutes(server) {
  return {
    '/api/agent-lifecycle/list': () => server._getAgentLifecycleList(),
    '/api/agent-runtime/stats': () => server._getAgentRuntimeStats(),
    '/api/agent-runtime/resource-pool': () => server._getAgentResourcePool(),
    '/api/agent-monitor/dashboard': () => server._getAgentMonitorDashboard(),
    '/api/agent-deployment/environments': () => server._getAgentDeploymentEnvironments(),
    '/api/agent-state/list': () => server._getAgentStateList(),
    '/api/agent-workflow/stats': () => server._getAgentWorkflowStats(),
    '/api/agent-sandbox/list': () => server._getAgentSandboxList(),
    '/api/agent-packs/list': () => server._getAgentPacksList(),
    '/api/agent-packs/installed': () => server._getAgentPacksInstalled(),
    '/api/agent-packs/stats': () => server._getAgentPacksStats(),
    '/api/approval/pending': () => {
      const gate = server._approvalGate;
      if (!gate) return { pending: [], count: 0 };
      return { pending: gate.getPending(), count: gate.getPendingCount() };
    },
    '/api/approval/history': () => {
      const gate = server._approvalGate;
      if (!gate) return { history: [] };
      return { history: gate.getHistory(50) };
    },
    '/api/approval/stats': () => {
      const gate = server._approvalGate;
      if (!gate) return {};
      return gate.getStats();
    },
    '/api/subagent/stats': () => server._getSubagentStats(),
    '/api/subagent/active': () => server._getSubagentActive(),
    '/api/subagent/budget': () => server._getSubagentBudgetReport(),
    '/api/subagent/model-stats': () => server._getSubagentModelStats(),
  };
}

module.exports = { buildAgentRoutes };
