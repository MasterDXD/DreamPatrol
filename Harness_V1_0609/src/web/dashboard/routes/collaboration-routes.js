'use strict';

/**
 * @module dashboard/routes/collaboration-routes
 * @description Dashboard协作API路由定义模块，注册协作模式、通道、配对对话、链式对话、输出融合和意图解析端点
 */

/**
 * 构建协作API路由映射表
 * @param {object} server - DashboardServer实例
 * @returns {Object<string, Function>} 路由路径到处理函数的映射
 */
function buildCollaborationRoutes(server) {
  return {
    '/api/collaboration/modes': () => server._getCollaborationModes(),
    '/api/collaboration/stats': () => server._getCollaborationStats(),
    '/api/collaboration/history': () => server._getCollaborationHistory(),
    '/api/channel/stats': () => server._getChannelStats(),
    '/api/pair-chat/stats': () => server._getPairChatStats(),
    '/api/pair-chat/sessions': () => server._getPairChatSessions(),
    '/api/chat-chain/stats': () => server._getChatChainStats(),
    '/api/chat-chain/chains': () => server._getChatChainChains(),
    '/api/output-fusion/stats': () => server._getOutputFusionStats(),
    '/api/intent/stats': () => server._getIntentStats(),
    '/api/intent/schemas': () => server._getIntentSchemas(),
  };
}

module.exports = { buildCollaborationRoutes };
