'use strict';

/**
 * @module dashboard/data-providers/infra-data
 * @description Dashboard基础设施数据提供模块，注册基础设施模块统计访问器并提供健康检查、事件总线和优先级队列详情
 */

const { _registerStatsAccessor, _registerAvailableAccessor } = require('./provider-helpers');
const { MAX_DETAIL_LIST_ITEMS } = require('../../../utils/constants');

/**
 * 将基础设施数据访问方法混入DashboardServer原型
 * @param {Function} Klass - DashboardServer类
 */
function applyInfraMixin(Klass) {
  _registerStatsAccessor(Klass, '_getGeneratorVerifierStats', 'generatorVerifier');
  _registerStatsAccessor(Klass, '_getIsolatedContextStats', 'isolatedContextManager');
  _registerStatsAccessor(Klass, '_getPlanStats', 'planPersistence');
  _registerStatsAccessor(Klass, '_getDeepeningRegistryStats', 'deepeningModuleRegistry');
  _registerStatsAccessor(Klass, '_getAutoVersionStats', 'autoVersionTracker');
  _registerStatsAccessor(Klass, '_getCommandRouterStats', 'commandRouter');
  _registerStatsAccessor(Klass, '_getProgrammableHookStats', 'programmableHookExecutor');
  _registerStatsAccessor(Klass, '_getContextCompressionStats', 'contextCompressionEngine');
  _registerStatsAccessor(Klass, '_getAgentPacksStats', 'agentPackManager');
  _registerStatsAccessor(Klass, '_getInfrastructureHealthCheckerStats', 'healthChecker');
  _registerStatsAccessor(Klass, '_getInfrastructurePriorityQueueStats', 'priorityQueue');

  Klass.prototype._getInfrastructureHealthCheckerDetails = function() {
    const hc = this._rt('healthChecker');
    if (!hc) return { available: false, stats: {}, checks: [], report: {} };
    const stats = hc.getStats();
    const checks = typeof hc.listChecks === 'function' ? hc.listChecks() : [];
    return { available: true, stats, checks };
  };

  Klass.prototype._getInfrastructureEventBusStats = function() {
    const eb = this._rt('eventBus');
    if (!eb) return { available: false, stats: {}, history: [] };
    const history = typeof eb.getHistory === 'function' ? eb.getHistory().slice(-20) : [];
    const eventNames = typeof eb.eventNames === 'function' ? eb.eventNames() : [];
    return {
      available: true,
      stats: {
        totalListeners: typeof eb.listenerCount === 'function' ? eb.eventNames().reduce(function(sum, evt) { return sum + eb.listenerCount(evt); }, 0) : 0,
        eventCount: eventNames.length,
        historySize: history.length,
        healthy: typeof eb.isHealthy === 'function' ? eb.isHealthy() : false,
        shutDown: eb._shutDown ?? false,
      },
      history,
    };
  };

  Klass.prototype._getInfrastructurePriorityQueueDetails = function() {
    const pq = this._rt('priorityQueue');
    if (!pq) return { available: false, stats: {}, items: [] };
    const stats = typeof pq.getStats === 'function' ? pq.getStats() : {};
    const items = typeof pq.toArray === 'function' ? pq.toArray().slice(0, MAX_DETAIL_LIST_ITEMS) : [];
    return { available: true, stats, items };
  };

  Klass.prototype._getGeneratorVerifierHistory = function() {
    const gv = this._rt('generatorVerifier');
    if (!gv) return { available: false, history: [] };
    const stats = gv.getStats();
    return {
      available: true,
      totalVerifications: stats.totalVerifications ?? 0,
      passRate: stats.passRate ?? 0,
      dimensionAverages: stats.dimensionAverages ?? {},
      recentVerifications: (stats.recentVerifications ?? []).slice(0, MAX_DETAIL_LIST_ITEMS),
    };
  };

  Klass.prototype._getIsolatedContextActive = function() {
    const icm = this._rt('isolatedContextManager');
    if (!icm) return { available: false, contexts: [] };
    return {
      available: true,
      activeContexts: icm.getActiveContexts ? icm.getActiveContexts() : [],
      totalTokenEstimate: icm.getTotalTokenEstimate ? icm.getTotalTokenEstimate() : 0,
    };
  };

  Klass.prototype._getPlanActive = function() {
    const pp = this._rt('planPersistence');
    if (!pp) return { available: false, plans: [] };
    const stats = pp.getStats();
    return {
      available: true,
      activePlans: stats.activePlans ?? 0,
      totalPlans: stats.totalPlans ?? 0,
      recentPlans: (stats.recentPlans ?? []).slice(0, 10),
    };
  };

  Klass.prototype._getAutoVersionRecent = function() {
    const avt = this._rt('autoVersionTracker');
    if (!avt) return { available: false, records: [] };
    return { available: true, records: avt.getRecentRecords(20) };
  };

  _registerAvailableAccessor(Klass, '_getCommandRouterCommands', 'commandRouter', 'listCommands', 'commands', []);
  _registerAvailableAccessor(Klass, '_getProgrammableHooks', 'programmableHookExecutor', 'getRegisteredHooks', 'hooks', {});
  _registerAvailableAccessor(Klass, '_getHookMonitorData', 'programmableHookExecutor', 'getHookMonitorData', 'data', {});
  _registerAvailableAccessor(Klass, '_getHookSuccessRates', 'programmableHookExecutor', 'getHookSuccessRates', 'rates', {});
  _registerAvailableAccessor(Klass, '_getAgentPacksList', 'agentPackManager', 'list', 'packs', []);
  _registerAvailableAccessor(Klass, '_getAgentPacksInstalled', 'agentPackManager', 'listInstalled', 'packs', []);
  _registerAvailableAccessor(Klass, '_getUserProfile', 'userModelManager', 'getProfile', 'profile', {});

  Klass.prototype._getContextCompressionStrategies = function() {
    const cc = this._rt('contextCompressionEngine');
    if (!cc) return { available: false, strategies: {}, config: {} };
    return { available: true, strategies: cc.getStrategies(), config: cc.getConfig() };
  };

  Klass.prototype._getPreviousSessionContext = async function() {
    const sm = this._rt('sessionManager');
    if (!sm || !sm.getPreviousSessionContext) return { available: false, context: {} };
    try {
      const ctx = await sm.getPreviousSessionContext();
      return { available: !!ctx, context: ctx ?? {} };
    } catch (_e) {
      return { available: false, context: {} };
    }
  };

  Klass.prototype._getSlowHooks = function() {
    const ph = this._rt('programmableHookExecutor');
    if (!ph || !ph.getSlowHooks) return { available: false, hooks: [] };
    return { available: true, hooks: ph.getSlowHooks(30) };
  };
}

module.exports = { applyInfraMixin };
