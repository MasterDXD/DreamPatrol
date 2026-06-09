'use strict';

/**
 * @module dashboard/routes/core-routes
 * @description Dashboard核心API路由定义模块，注册概览、Agent、技能、会话、工作流、配置等核心端点
 */

/**
 * 构建核心API路由映射表
 * @param {object} server - DashboardServer实例
 * @param {object} CACHE_TTL - 缓存TTL配置对象
 * @returns {Object<string, Function>} 路由路径到处理函数的映射
 */
function buildCoreRoutes(server, CACHE_TTL) {
  return {
    '/api/overview': () => server._getCached('overview', CACHE_TTL.overview, () => server._getOverview()),
    '/api/agents': () => server._getCached('agents', CACHE_TTL.agents, () => server._getAgents()),
    '/api/skills': () => server._getCached('skills', CACHE_TTL.skills, () => server._getSkills()),
    '/api/sessions': () => server._getCached('sessions', CACHE_TTL.sessions, () => server._getSessions()),
    '/api/workflow': () => server._getCached('workflow', CACHE_TTL.workflow, () => server._getWorkflow()),
    '/api/config': () => server._getCached('config', CACHE_TTL.config, () => server._getConfig()),
    '/api/changelog': () => server._getCached('changelog', CACHE_TTL.changelog, () => server._getChangelog()),
    '/api/audit': () => server._getCached('audit', CACHE_TTL.audit, () => server._getAudit()),
    '/api/memory': () => server._getMemory(),
    '/api/workflow-templates': () => server._getWorkflowTemplates(),
    '/api/compliance': () => server._getCompliance(),
    '/api/health': () => server._getHealth(),
    '/healthz': () => server._getLiveness(),
    '/readyz': () => server._getReadiness(),
    '/api/version': () => server._getVersion(),
    '/api/framework/status': () => server._getCached('frameworkStatus', 30000, () => server._getFrameworkStatus()),
    '/api/framework/architecture': () => server._getCached('frameworkArchitecture', 30000, () => server._getFrameworkArchitecture()),
    '/api/framework/features': () => server._getCached('frameworkFeatures', 30000, () => server._getFrameworkFeatures()),
    '/api/panorama/metadata': () => server._getPanoramaMetadata(),
    '/api/performance': () => server._getPerformanceStats(),
  };
}

module.exports = { buildCoreRoutes };
