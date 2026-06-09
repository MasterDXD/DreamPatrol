'use strict';

/**
 * 平台集成模块入口。聚合多平台接入网关、业务Agent注册中心和优先级调度器。
 * 实现了用户提出架构中"主Agent调度层 + 业务Agent执行层 + 主管理员接入层"的三层架构融合。
 *
 * @module runtime/platform
 */

const { PlatformGateway, WebChatAdapter, AppAdapter, FeishuAdapter, EmailAdapter, PLATFORM_TYPES, PLATFORM_PRIORITY } = require('./platform-gateway');
const { BusinessAgentRegistry, BUSINESS_AGENT_TYPES, BUSINESS_AGENT_TEMPLATES, BUSINESS_PRIORITY } = require('./business-agent-registry');
const { PriorityScheduler, TASK_PRIORITY, TASK_STATUS } = require('./priority-scheduler');

module.exports = {
  PlatformGateway,
  WebChatAdapter,
  AppAdapter,
  FeishuAdapter,
  EmailAdapter,
  PLATFORM_TYPES,
  PLATFORM_PRIORITY,
  BusinessAgentRegistry,
  BUSINESS_AGENT_TYPES,
  BUSINESS_AGENT_TEMPLATES,
  BUSINESS_PRIORITY,
  PriorityScheduler,
  TASK_PRIORITY,
  TASK_STATUS,
};
