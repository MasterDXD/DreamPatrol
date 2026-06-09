'use strict';

/**
 * @module dashboard/routes/delivery-acceleration-routes
 * @description Dashboard交付加速API路由定义模块，注册瓶颈诊断、架构先行检查、工作流模式等端点
 */

/**
 * 构建交付加速API路由映射表
 * @param {object} server - DashboardServer实例
 * @returns {Object<string, Function>} 路由路径到处理函数的映射
 */
function buildDeliveryAccelerationRoutes(server) {
  return {
    '/api/delivery-acceleration/stats': () => server._getDeliveryAccelerationStats(),
    '/api/delivery-acceleration/diagnosis': () => server._getDeliveryDiagnosis(),
    '/api/delivery-acceleration/overview': () => server._getDeliveryOverview(),
  };
}

module.exports = { buildDeliveryAccelerationRoutes };
