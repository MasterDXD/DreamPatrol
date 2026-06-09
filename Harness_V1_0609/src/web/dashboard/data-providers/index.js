'use strict';

/**
 * @module dashboard/data-providers
 * @description Dashboard数据提供者聚合模块，合并深化、Agent、设计和基础设施数据混入到DashboardServer
 */

const { DEEPENING_API_REGISTRY, DEEPENING_PROXY_METHODS, getDeepeningModuleData, getDeepeningStats, getQualityStats, getTokenBudgetStats, getAffinityStats, getDeepeningDashboard, getDeepeningMetrics } = require('./deepening-data');
const { applyAgentMixin } = require('./agent-data');
const { applyDesignMixin } = require('./design-data');
const { applyInfraMixin } = require('./infra-data');

/**
 * 将深化推理数据访问方法混入DashboardServer原型，并级联混入Agent、设计和基础设施数据
 * @param {Function} DashboardServer - DashboardServer类
 */
function applyDeepeningMixin(DashboardServer) {
  DashboardServer._DEEPENING_API_REGISTRY = DEEPENING_API_REGISTRY;

  DashboardServer.prototype._getDeepeningModuleData = function(moduleName) {
    return getDeepeningModuleData(this._rt.bind(this), moduleName);
  };

  DashboardServer.prototype._getDeepeningStats = function() {
    return getDeepeningStats(this._rt.bind(this));
  };

  DashboardServer.prototype._getQualityStats = function() {
    return getQualityStats(this._rt.bind(this));
  };

  DashboardServer.prototype._getTokenBudgetStats = function() {
    return getTokenBudgetStats(this._rt.bind(this));
  };

  DashboardServer.prototype._getAffinityStats = function() {
    return getAffinityStats(this._rt.bind(this));
  };

  DashboardServer.prototype._getDeepeningDashboard = function() {
    return getDeepeningDashboard(this._rt.bind(this));
  };

  DashboardServer.prototype._getDeepeningMetrics = function() {
    return getDeepeningMetrics(this._rt.bind(this));
  };

  for (const [methodName, moduleName] of Object.entries(DEEPENING_PROXY_METHODS)) {
    DashboardServer.prototype['_get' + methodName.charAt(0).toUpperCase() + methodName.slice(1)] = function() {
      return this._getDeepeningModuleData(moduleName);
    };
  }

  applyAgentMixin(DashboardServer);
  applyDesignMixin(DashboardServer);
  applyInfraMixin(DashboardServer);
}

module.exports = { applyDeepeningMixin, DEEPENING_API_REGISTRY, applyAgentMixin, applyDesignMixin, applyInfraMixin };
