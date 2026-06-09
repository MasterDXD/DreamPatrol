'use strict';

/**
 * @module dashboard/routes/code-wiki-routes
 * @description Dashboard Code Wiki API路由定义模块，注册代码理解、文档生成、
 * 图谱查询、AI聊天和上下文文件等Code Wiki核心端点
 */

/**
 * 构建Code Wiki API路由映射表
 * @param {object} server - DashboardServer实例
 * @returns {Object<string, Function>} 路由路径到处理函数的映射
 */
function buildCodeWikiRoutes(server) {
  return {
    '/api/code-wiki/stats': () => server._getCodeWikiStats(),
    '/api/code-wiki/compile-status': () => server._getCodeWikiCompileStatus(),
    '/api/code-wiki/stale-docs': () => server._getCodeWikiStaleDocs(),
    '/api/code-wiki/freshness': () => server._getCodeWikiFreshness(),
    '/api/code-wiki/chat-history': () => server._getCodeWikiChatHistory(),
    '/api/code-wiki/context-file': () => server._getCodeWikiContextFile(),
    '/api/code-wiki/architecture-diagram': () => server._getCodeWikiArchitectureDiagram(),
  };
}

module.exports = { buildCodeWikiRoutes };
