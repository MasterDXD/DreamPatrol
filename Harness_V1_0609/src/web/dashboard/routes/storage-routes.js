'use strict';

/**
 * @module dashboard/routes/storage-routes
 * @description Dashboard存储API路由定义模块，注册SQLite、内存、思维、嵌入、MCP等存储端点
 */

/**
 * 构建存储API路由映射表
 * @param {object} server - DashboardServer实例
 * @returns {Object<string, Function>} 路由路径到处理函数的映射
 */
function buildStorageRoutes(server) {
  return {
    '/api/sqlite/stats': () => server._getSqliteStats(),
    '/api/sqlite/fts': () => server._getSqliteFts(),
    '/api/memory/entries': () => server._getMemoryEntries(),
    '/api/memory/usage': () => server._getMemoryUsage(),
    '/api/memory/verification': () => server._getMemoryVerification(),
    '/api/memory/stale': () => server._getStaleMemories(),
    '/api/affinity/stats': () => server._getAffinityLearnerStats(),
    '/api/affinity/records': () => server._getAffinityRecords(),
    '/api/thoughts/stats': () => server._getThoughtsStats(),
    '/api/thoughts/list': () => server._getThoughtsList(),
    '/api/embedding/stats': () => server._getEmbeddingStats(),
    '/api/thought-retriever/stats': () => server._getThoughtRetrieverStats(),
    '/api/model-selector/stats': () => server._getModelSelectorStats(),
    '/api/mcp/status': () => server._getMcpStatus(),
    '/api/mcp/tools': () => server._getMcpTools(),
  };
}

module.exports = { buildStorageRoutes };
