'use strict';

/**
 * @module dashboard/routes/skill-routes
 * @description Dashboard技能API路由定义模块，注册技能层级、改进、创建、策展、文档新鲜度和反模式端点
 */

/**
 * 构建技能API路由映射表
 * @param {object} server - DashboardServer实例
 * @returns {Object<string, Function>} 路由路径到处理函数的映射
 */
function buildSkillRoutes(server) {
  return {
    '/api/skill-layers/stats': () => server._getSkillLayerStats(),
    '/api/skill-layers/dedup': () => server._getSkillDedupReport(),
    '/api/skill-layers/context': () => server._getSkillContextEstimate(),
    '/api/skill-improvement/pending': () => server._getSkillImprovementPending(),
    '/api/skill-improvement/stats': () => server._getSkillImprovementStats(),
    '/api/skill-creation/list': () => server._getSkillCreationList(),
    '/api/skill-creation/stats': () => server._getSkillCreationStats(),
    '/api/skill-curator/stats': () => server._getSkillCuratorStats(),
    '/api/nudge/stats': () => server._getNudgeStats(),
    '/api/doc-freshness/stats': () => server._getDocFreshnessStats(),
    '/api/doc-freshness/stale': () => server._getDocFreshnessStale(),
    '/api/doc-freshness/index': () => server._getDocFreshnessIndex(),
    '/api/doc-freshness/validate': () => server._validateDocFreshness(),
    '/api/antipattern/rules': () => server._getAntipatternRules(),
  };
}

module.exports = { buildSkillRoutes };
