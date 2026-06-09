'use strict';

/**
 * @module dashboard/data-providers/agent-data
 * @description Dashboard Agent数据提供模块，混入Agent生命周期、监控、部署、状态、沙箱和子Agent等数据访问方法
 */

const { _apiError, _registerModuleAccessor } = require('./provider-helpers');
const AgentDeployment = require('../../../runtime/agent/agent-deployment');
const AgentWorkflowIntegration = require('../../../runtime/agent/agent-workflow-integration');
/** @constant {Set<string>} 有效告警级别集合 */
const VALID_ALERT_LEVELS = new Set(['info', 'warning', 'critical']);
/** @constant {Set<string>} 有效日志级别集合 */
const VALID_LOG_LEVELS = new Set(['info', 'warn', 'error']);
/** @constant {Set<string>} 有效部署环境集合 */
const VALID_DEPLOYMENT_ENVS = new Set(Object.values(AgentDeployment.ENVIRONMENTS));
/** @constant {Set<string>} 有效部署状态集合 */
const VALID_DEPLOYMENT_STATES = new Set(Object.values(AgentDeployment.STATES));
/** @constant {Set<string>} 有效工作流任务状态集合 */
const VALID_WORKFLOW_TASK_STATES = new Set(Object.values(AgentWorkflowIntegration.TASK_STATES));
/** @constant {Set<string>} 有效工作流触发类型集合 */
const VALID_WORKFLOW_TRIGGER_TYPES = new Set(Object.values(AgentWorkflowIntegration.TRIGGER_TYPES));
/** @constant {Set<string>} 有效沙箱资源类型集合 */
const VALID_SANDBOX_RESOURCES = new Set(['filesystem', 'network', 'child_process', 'env', 'module']);

/**
 * 将Agent数据访问方法混入DashboardServer原型
 * @param {Function} Klass - DashboardServer类
 */
function applyAgentMixin(Klass) {
  Klass.prototype._getAgentLifecycle = function(params) {
    const agentId = this._validateAgentId(this._requireParam(params, 'agentId'));
    if (!this._rt('agentLifecycle')) {
      return _apiError('Agent lifecycle module not available', 503);
    }
    return this._rt('agentLifecycle').getStatus(agentId) || _apiError('Agent not found', 404);
  };

  Klass.prototype._getAgentLifecycleList = function() {
    if (!this._rt('agentRuntime')) return { agents: [], total: 0 };
    const agents = this._rt('agentRuntime').listAgents();
    return {
      total: agents.length,
      agents: agents.map(function(a) {
        return {
          id: a.id, state: a.state, version: a.version,
          startedAt: a.startedAt, taskCount: a.taskCount, lastActivityAt: a.lastActivityAt,
        };
      }),
    };
  };

  Klass.prototype._getAgentLifecycleHistory = function(params) {
    const agentId = this._validateAgentId(this._optionalParam(params, 'agentId'));
    const limit = this._parseIntParam(params, 'limit', 50);
    if (!this._rt('agentLifecycle')) return { history: [] };
    return { history: this._rt('agentLifecycle').getOperationHistory(agentId ?? null, limit) };
  };

  _registerModuleAccessor(Klass, '_getAgentRuntimeStats', 'agentRuntime', 'getStats', { totalAgents: 0, stateCounts: {} });
  _registerModuleAccessor(Klass, '_getAgentResourcePool', 'agentRuntime', 'getResourcePool', { totalMemoryMB: 0, usedMemoryMB: 0 });
  _registerModuleAccessor(Klass, '_getAgentMonitorDashboard', 'agentMonitor', 'getDashboardData', { agents: [], recentAlerts: [] });
  _registerModuleAccessor(Klass, '_getAgentWorkflowStats', 'agentWorkflowIntegration', 'getStats', { totalAdapters: 0, totalTasks: 0 });
  _registerModuleAccessor(Klass, '_getAgentSandboxList', 'agentSandbox', 'getStats', { sandboxes: [], stats: {} });

  Klass.prototype._getAgentMonitorMetrics = function(params) {
    const agentId = this._validateAgentId(this._requireParam(params, 'agentId'));
    const includeHistory = params.get('history') === 'true';
    const historyLimit = this._parseIntParam(params, 'historyLimit', 100);
    if (!this._rt('agentMonitor')) return _apiError('Agent monitor module not available', 503);
    return this._rt('agentMonitor').getMetrics(agentId, { includeHistory, historyLimit }) || _apiError('Agent not monitored', 404);
  };

  Klass.prototype._getAgentMonitorAlerts = function(params) {
    const agentId = this._validateAgentId(this._optionalParam(params, 'agentId'));
    const level = this._validateEnum(this._optionalParam(params, 'level'), VALID_ALERT_LEVELS, 'level');
    const limit = this._parseIntParam(params, 'limit', 50);
    if (!this._rt('agentMonitor')) return { alerts: [] };
    return { alerts: this._rt('agentMonitor').getAlerts({ agentId: agentId || undefined, level: level || undefined, limit }) };
  };

  Klass.prototype._getAgentMonitorLogs = function(params) {
    const agentId = this._validateAgentId(this._requireParam(params, 'agentId'));
    const level = this._validateEnum(this._optionalParam(params, 'level'), VALID_LOG_LEVELS, 'level');
    const limit = this._parseIntParam(params, 'limit', 50);
    if (!this._rt('agentMonitor')) return _apiError('Agent monitor module not available', 503);
    return { logs: this._rt('agentMonitor').getLogs(agentId, { level: level || undefined, limit }) };
  };

  Klass.prototype._getAgentDeploymentList = function(params) {
    const agentId = this._validateAgentId(this._optionalParam(params, 'agentId'));
    const targetEnv = this._validateEnum(this._optionalParam(params, 'env'), VALID_DEPLOYMENT_ENVS, 'env');
    const state = this._validateEnum(this._optionalParam(params, 'state'), VALID_DEPLOYMENT_STATES, 'state');
    if (!this._rt('agentDeployment')) return { deployments: [] };
    return { deployments: this._rt('agentDeployment').listDeployments({ agentId: agentId || undefined, targetEnv: targetEnv || undefined, state: state || undefined }) };
  };

  Klass.prototype._getAgentDeploymentEnvironments = function() {
    const deployment = this._rt('agentDeployment');
    if (!deployment) return { environments: [] };
    const envs = Object.values(AgentDeployment.ENVIRONMENTS);
    return { environments: envs.map(function(env) { return deployment.getEnvironmentState(env); }).filter(Boolean) };
  };

  Klass.prototype._getAgentDeploymentVersions = function(params) {
    const agentId = this._validateAgentId(this._requireParam(params, 'agentId'));
    if (!this._rt('agentDeployment')) return { versions: [] };
    return { versions: this._rt('agentDeployment').getVersionHistory(agentId) };
  };

  Klass.prototype._getAgentStateList = function() {
    const mgr = this._rt('agentStateManager');
    if (!mgr) return { agents: [] };
    return { agents: mgr.listAgents().map(function(id) { return mgr.getStateInfo(id) || { agentId: id }; }) };
  };

  Klass.prototype._getAgentStateInfo = function(params) {
    const agentId = this._validateAgentId(this._requireParam(params, 'agentId'));
    if (!this._rt('agentStateManager')) return _apiError('Agent state module not available', 503);
    return this._rt('agentStateManager').getStateInfo(agentId) || _apiError('State not found', 404);
  };

  Klass.prototype._getAgentStateSnapshots = function(params) {
    const agentId = this._validateAgentId(this._requireParam(params, 'agentId'));
    if (!this._rt('agentStateManager')) return { snapshots: [] };
    return { snapshots: this._rt('agentStateManager').listSnapshots(agentId) };
  };

  Klass.prototype._getAgentWorkflowTasks = function(params) {
    const agentId = this._validateAgentId(this._optionalParam(params, 'agentId'));
    const state = this._validateEnum(this._optionalParam(params, 'state'), VALID_WORKFLOW_TASK_STATES, 'state');
    const type = this._validateEnum(this._optionalParam(params, 'type'), VALID_WORKFLOW_TRIGGER_TYPES, 'type');
    if (!this._rt('agentWorkflowIntegration')) return { tasks: [] };
    return { tasks: this._rt('agentWorkflowIntegration').listTasks({ agentId: agentId || undefined, state: state || undefined, type: type || undefined }) };
  };

  Klass.prototype._getAgentSandboxAccessLog = function(params) {
    const agentId = this._validateAgentId(this._optionalParam(params, 'agentId'));
    const resource = this._validateEnum(this._optionalParam(params, 'resource'), VALID_SANDBOX_RESOURCES, 'resource');
    const deniedOnly = params.get('deniedOnly') === 'true';
    const limit = this._parseIntParam(params, 'limit', 50);
    if (!this._rt('agentSandbox')) return { logs: [] };
    return { logs: this._rt('agentSandbox').getAccessLog(agentId || undefined, { resource: resource || undefined, deniedOnly, limit }) };
  };

  _registerModuleAccessor(Klass, '_getSubagentStats', 'subagentExecutor', 'getStats', { available: false, message: 'SubagentExecutor requires runtime instance' });
  _registerModuleAccessor(Klass, '_getSubagentActive', 'subagentExecutor', 'getActiveHandles', { available: false, handles: [] });
  _registerModuleAccessor(Klass, '_getSubagentBudgetReport', 'subagentExecutor', 'getBudgetReport', { available: false, budget: {} });
  _registerModuleAccessor(Klass, '_getSubagentModelStats', 'subagentExecutor', 'getModelStats', { available: false, models: {} });
}

module.exports = { applyAgentMixin };
