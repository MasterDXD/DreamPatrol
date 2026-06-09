'use strict';

/**
 * @module dashboard/routes
 * @description Dashboard路由聚合模块，合并所有子路由模块为统一路由映射表
 */

const { buildCoreRoutes } = require('./core-routes');
const { buildAgentRoutes } = require('./agent-routes');
const { buildDeepeningRoutes } = require('./deepening-routes');
const { buildSkillRoutes } = require('./skill-routes');
const { buildCollaborationRoutes } = require('./collaboration-routes');
const { buildStorageRoutes } = require('./storage-routes');
const { buildInfrastructureRoutes } = require('./infrastructure-routes');
const { buildCodeWikiRoutes } = require('./code-wiki-routes');
const { buildDeliveryAccelerationRoutes } = require('./delivery-acceleration-routes');

/**
 * 构建所有API路由映射表，合并核心、Agent、深化、技能、协作、存储和基础设施路由
 * @param {object} server - DashboardServer实例
 * @param {object} CACHE_TTL - 缓存TTL配置对象
 * @returns {Object<string, Function>} 完整路由路径到处理函数的映射
 */
function buildAllRoutes(server, CACHE_TTL) {
  return {
    ...buildCoreRoutes(server, CACHE_TTL),
    ...buildAgentRoutes(server),
    ...buildDeepeningRoutes(server),
    ...buildSkillRoutes(server),
    ...buildCollaborationRoutes(server),
    ...buildStorageRoutes(server),
    ...buildInfrastructureRoutes(server),
    ...buildCodeWikiRoutes(server),
    ...buildDeliveryAccelerationRoutes(server),
  };
}

module.exports = {
  buildAllRoutes,
  buildCoreRoutes,
  buildAgentRoutes,
  buildDeepeningRoutes,
  buildSkillRoutes,
  buildCollaborationRoutes,
  buildStorageRoutes,
  buildInfrastructureRoutes,
  buildCodeWikiRoutes,
  buildDeliveryAccelerationRoutes,
};
