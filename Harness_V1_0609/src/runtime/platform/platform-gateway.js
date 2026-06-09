'use strict';

/**
 * 多平台接入网关（PlatformGateway）。统一消息格式、平台适配、路由分发。
 * 实现了用户提出架构中"主管理员（接入层）"的核心能力：
 * - 统一消息格式转换（用户ID + 平台类型 + 任务内容 + 历史上下文摘要）
 * - 多平台适配（WebChat、APP、小程序、邮件、飞书等）
 * - 跨平台用户记忆绑定与合并
 * - 请求路由分发到对应业务Agent
 *
 * @module runtime/platform/platform-gateway
 * @extends EventEmitter
 * @fires PlatformGateway#message-received
 * @fires PlatformGateway#platform-bound
 * @fires PlatformGateway#route-dispatched
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const BoundedArray = require('../../utils/bounded-array');

/** 支持的平台类型 */
const PLATFORM_TYPES = {
  WEBCHAT: 'webchat',
  APP: 'app',
  MINIPROGRAM: 'miniprogram',
  EMAIL: 'email',
  FEISHU: 'feishu',
  DINGTALK: 'dingtalk',
  WECHAT: 'wechat',
  API: 'api',
};

/** 平台优先级（数值越小优先级越高） */
const PLATFORM_PRIORITY = {
  [PLATFORM_TYPES.WEBCHAT]: 1,
  [PLATFORM_TYPES.APP]: 2,
  [PLATFORM_TYPES.MINIPROGRAM]: 3,
  [PLATFORM_TYPES.FEISHU]: 4,
  [PLATFORM_TYPES.DINGTALK]: 5,
  [PLATFORM_TYPES.WECHAT]: 6,
  [PLATFORM_TYPES.EMAIL]: 7,
  [PLATFORM_TYPES.API]: 8,
};

const MAX_HISTORY_PER_USER = 50;
const MAX_USER_BINDINGS = 1000;

/**
 * 统一消息格式
 * @typedef {Object} UnifiedMessage
 * @property {string} userId - 用户唯一标识
 * @property {string} platformType - 平台类型（webchat/app/miniprogram/email/feishu等）
 * @property {string} taskContent - 任务内容/用户输入
 * @property {string} [sessionId] - 会话ID
 * @property {Object} [contextSummary] - 历史上下文摘要
 * @property {number} [timestamp] - 消息时间戳
 * @property {number} [priority] - 优先级（1-10，1最高）
 * @property {Object} [metadata] - 平台特定元数据
 */

/**
 * 多平台接入网关
 */
class PlatformGateway extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.platformAdapters] - 平台适配器映射
   * @param {Object} [options.businessAgentRouter] - 业务Agent路由器
   * @param {number} [options.maxHistoryPerUser=50] - 每用户最大历史记录数
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._platformAdapters = new Map();
    this._businessAgentRouter = opts.businessAgentRouter ?? null;
    this._maxHistoryPerUser = opts.maxHistoryPerUser ?? MAX_HISTORY_PER_USER;

    // 用户多平台绑定: unifiedUserId -> { platforms: Map<platformType, platformUserId>, mergedAt, lastActive }
    this._userBindings = new Map();

    // 用户会话历史: unifiedUserId -> BoundedArray<UnifiedMessage>
    this._userHistory = new Map();

    // 平台适配器注册
    if (opts.platformAdapters) {
      for (const [type, adapter] of Object.entries(opts.platformAdapters)) {
        this.registerPlatformAdapter(type, adapter);
      }
    }
  }

  /**
   * 注册平台适配器
   * @param {string} platformType - 平台类型
   * @param {Object} adapter - 适配器实例，需实现 normalize(platformMessage) => UnifiedMessage
   * @returns {PlatformGateway} this
   */
  registerPlatformAdapter(platformType, adapter) {
    this.guardShutdown();
    if (!platformType || !adapter) return this;
    if (typeof adapter.normalize !== 'function') {
      debug('PlatformGateway', 'adapter-no-normalize', platformType);
      return this;
    }
    this._platformAdapters.set(platformType, adapter);
    debug('PlatformGateway', 'adapter-registered', platformType);
    return this;
  }

  /**
   * 设置业务Agent路由器
   * @param {Object} router - 路由器实例，需实现 route(UnifiedMessage) => { agentId, agentType, priority }
   */
  setBusinessAgentRouter(router) {
    this.guardShutdown();
    this._businessAgentRouter = router;
  }

  /**
   * 接收并处理来自任意平台的原始消息
   * @param {string} platformType - 平台类型
   * @param {Object} rawMessage - 平台原始消息
   * @returns {Promise<{ success: boolean, message?: UnifiedMessage, route?: Object, error?: string }>}
   */
  async receive(platformType, rawMessage) {
    this.guardShutdown();
    if (!platformType || !rawMessage) {
      return { success: false, error: 'Missing platformType or rawMessage' };
    }

    // 1. 平台消息格式标准化
    const normalized = this._normalizeMessage(platformType, rawMessage);
    if (!normalized) {
      return { success: false, error: `No adapter for platform: ${platformType}` };
    }

    // 2. 跨平台用户绑定
    const unifiedUserId = this._bindUser(platformType, normalized.userId);
    normalized.userId = unifiedUserId;
    normalized.platformType = platformType;

    // 3. 注入历史上下文摘要
    normalized.contextSummary = this._getContextSummary(unifiedUserId, platformType);

    // 4. 记录历史
    this._recordHistory(unifiedUserId, normalized);

    this.emit('message-received', { platformType, unifiedUserId, message: normalized });

    // 5. 路由到业务Agent
    const route = this._routeToAgent(normalized);

    this.emit('route-dispatched', { unifiedUserId, route });

    return { success: true, message: normalized, route };
  }

  /**
   * 绑定用户多平台身份
   * @param {string} platformType - 平台类型
   * @param {string} platformUserId - 平台用户ID
   * @returns {string} 统一用户ID
   */
  bindUser(platformType, platformUserId) {
    this.guardShutdown();
    return this._bindUser(platformType, platformUserId);
  }

  /**
   * 获取用户的历史上下文摘要
   * @param {string} unifiedUserId - 统一用户ID
   * @param {string} [currentPlatform] - 当前平台（用于过滤相关上下文）
   * @returns {Object} 上下文摘要
   */
  getContextSummary(unifiedUserId, currentPlatform) {
    return this._getContextSummary(unifiedUserId, currentPlatform);
  }

  /**
   * 获取用户跨平台绑定信息
   * @param {string} unifiedUserId - 统一用户ID
   * @returns {Object|null} 绑定信息
   */
  getUserBindings(unifiedUserId) {
    return this._userBindings.get(unifiedUserId) ?? null;
  }

  // ---- 内部方法 ----

  /**
   * 标准化平台消息为统一格式
   * @private
   */
  _normalizeMessage(platformType, rawMessage) {
    const adapter = this._platformAdapters.get(platformType);
    if (!adapter) {
      return null;
    }
    try {
      return adapter.normalize(rawMessage);
    } catch (err) {
      debug('PlatformGateway', 'normalize-error', platformType, err && err.message ? err.message : String(err));
      return null;
    }
  }

  /**
   * 绑定用户多平台身份
   * @private
   */
  _bindUser(platformType, platformUserId) {
    // 查找已有的绑定
    for (const [unifiedId, binding] of this._userBindings) {
      if (binding.platforms.has(platformType) && binding.platforms.get(platformType) === platformUserId) {
        binding.lastActive = Date.now();
        return unifiedId;
      }
    }

    // 新建绑定
    const unifiedId = `user-${platformType}-${platformUserId}`;
    const existing = this._userBindings.get(unifiedId);
    if (existing) {
      existing.platforms.set(platformType, platformUserId);
      existing.lastActive = Date.now();
    } else {
      this._userBindings.set(unifiedId, {
        platforms: new Map([[platformType, platformUserId]]),
        mergedAt: Date.now(),
        lastActive: Date.now(),
      });
    }

    // 容量控制
    if (this._userBindings.size > MAX_USER_BINDINGS) {
      // 删除最久未活跃的绑定
      let oldest = null;
      let oldestTime = Infinity;
      for (const [id, b] of this._userBindings) {
        if (b.lastActive < oldestTime) {
          oldestTime = b.lastActive;
          oldest = id;
        }
      }
      if (oldest) this._userBindings.delete(oldest);
    }

    this.emit('platform-bound', { platformType, platformUserId, unifiedId });
    return unifiedId;
  }

  /**
   * 获取用户历史上下文摘要
   * @private
   */
  _getContextSummary(unifiedUserId, currentPlatform) {
    const history = this._userHistory.get(unifiedUserId);
    if (!history || history.length === 0) {
      return { recentTopics: [], previousAgent: null, sessionCount: 0 };
    }

    const recent = history.slice(-10);
    const topics = new Set();
    let lastAgent = null;
    let sessionCount = 0;

    for (const msg of recent) {
      if (msg.taskContent && msg.taskContent.length > 0) {
        // 提取关键词作为主题
        const words = msg.taskContent.split(/\s+/).filter(w => w.length > 2);
        for (const w of words.slice(0, 5)) topics.add(w);
      }
      if (msg.metadata?.agentId) lastAgent = msg.metadata.agentId;
      if (msg.sessionId) sessionCount++;
    }

    return {
      recentTopics: Array.from(topics).slice(0, 10),
      previousAgent: lastAgent,
      messageCount: history.length,
      sessionCount,
      lastActivePlatform: currentPlatform,
    };
  }

  /**
   * 记录用户消息历史
   * @private
   */
  _recordHistory(unifiedUserId, message) {
    if (!this._userHistory.has(unifiedUserId)) {
      if (this._userHistory.size >= 1000) {
        const oldestKey = this._userHistory.keys().next().value;
        if (oldestKey) this._userHistory.delete(oldestKey);
      }
      this._userHistory.set(unifiedUserId, new BoundedArray(this._maxHistoryPerUser));
    }
    this._userHistory.get(unifiedUserId).push(message);
  }

  /**
   * 路由到业务Agent
   * @private
   */
  _routeToAgent(message) {
    if (this._businessAgentRouter && typeof this._businessAgentRouter.route === 'function') {
      try {
        return this._businessAgentRouter.route(message);
      } catch (err) {
        debug('PlatformGateway', 'route-error', err && err.message ? err.message : String(err));
      }
    }

    // 默认路由：基于关键词匹配
    const content = (message.taskContent ?? '').toLowerCase();
    let agentType = 'general';

    if (/(客服|咨询|帮助|售后|退货|投诉|refund|complaint|customer)/.test(content)) {
      agentType = 'customer-service';
    } else if (/(订单|order|查询|物流|配送|tracking|shipment|delivery)/.test(content)) {
      agentType = 'order-processing';
    } else if (/(数据|分析|报表|统计|analytics|report|metrics)/.test(content)) {
      agentType = 'data-analyst';
    } else if (/(价格|优惠|促销|折扣|price|discount|promotion)/.test(content)) {
      agentType = 'marketing';
    }

    return {
      agentType,
      priority: message.priority ?? 5,
      platformType: message.platformType,
      userId: message.userId,
    };
  }

  /**
   * 合并用户跨平台身份（将多个平台用户绑定到同一统一ID）
   * @param {string} targetUnifiedId - 目标统一ID
   * @param {string} sourcePlatformType - 源平台类型
   * @param {string} sourcePlatformUserId - 源平台用户ID
   * @returns {boolean} 是否成功合并
   */
  mergeUserIdentity(targetUnifiedId, sourcePlatformType, sourcePlatformUserId) {
    this.guardShutdown();
    const target = this._userBindings.get(targetUnifiedId);
    if (!target) return false;

    // 查找源用户
    for (const [unifiedId, binding] of this._userBindings) {
      if (binding.platforms.has(sourcePlatformType) && binding.platforms.get(sourcePlatformType) === sourcePlatformUserId) {
        // 合并平台绑定
        for (const [pt, puid] of binding.platforms) {
          target.platforms.set(pt, puid);
        }
        // 合并历史
        const sourceHistory = this._userHistory.get(unifiedId);
        if (sourceHistory) {
          const targetHistory = this._userHistory.get(targetUnifiedId);
          if (targetHistory) {
            for (const item of sourceHistory) {
              targetHistory.push(item);
            }
          } else {
            this._userHistory.set(targetUnifiedId, sourceHistory);
          }
        }
        this._userBindings.delete(unifiedId);
        this._userHistory.delete(unifiedId);
        target.mergedAt = Date.now();
        return true;
      }
    }

    // 源用户不存在，直接添加到目标
    target.platforms.set(sourcePlatformType, sourcePlatformUserId);
    target.mergedAt = Date.now();
    return true;
  }
}

// 内置平台适配器

/**
 * WebChat平台适配器
 */
class WebChatAdapter {
  normalize(raw) {
    return {
      userId: raw.userId ?? raw.user?.id ?? 'unknown',
      platformType: PLATFORM_TYPES.WEBCHAT,
      taskContent: raw.content ?? raw.message ?? raw.text ?? '',
      sessionId: raw.sessionId ?? raw.session?.id ?? null,
      timestamp: raw.timestamp ?? Date.now(),
      priority: raw.urgent ? 1 : (raw.priority ?? 5),
      metadata: {
        channel: 'webchat',
        userAgent: raw.userAgent ?? null,
        ip: raw.ip ?? null,
      },
    };
  }
}

/**
 * APP平台适配器
 */
class AppAdapter {
  normalize(raw) {
    return {
      userId: raw.userId ?? raw.deviceId ?? 'unknown',
      platformType: PLATFORM_TYPES.APP,
      taskContent: raw.content ?? raw.text ?? '',
      sessionId: raw.sessionId ?? null,
      timestamp: raw.timestamp ?? Date.now(),
      priority: raw.urgent ? 1 : (raw.priority ?? 5),
      metadata: {
        channel: 'app',
        appVersion: raw.appVersion ?? null,
        deviceType: raw.deviceType ?? null,
        os: raw.os ?? null,
      },
    };
  }
}

/**
 * 飞书平台适配器
 */
class FeishuAdapter {
  normalize(raw) {
    return {
      userId: raw.open_id ?? raw.user_id ?? raw.sender?.open_id ?? 'unknown',
      platformType: PLATFORM_TYPES.FEISHU,
      taskContent: raw.text ?? raw.content?.text ?? raw.message?.content ?? '',
      sessionId: raw.chat_id ?? raw.session_id ?? null,
      timestamp: raw.timestamp ?? raw.event?.timestamp ?? Date.now(),
      priority: raw.urgent ? 1 : 5,
      metadata: {
        channel: 'feishu',
        chatType: raw.chat_type ?? null,
        tenantKey: raw.tenant_key ?? null,
      },
    };
  }
}

/**
 * 邮件平台适配器
 */
class EmailAdapter {
  normalize(raw) {
    return {
      userId: raw.from ?? raw.sender ?? 'unknown',
      platformType: PLATFORM_TYPES.EMAIL,
      taskContent: raw.subject ? `${raw.subject}\n${raw.body ?? ''}` : (raw.body ?? ''),
      sessionId: raw.threadId ?? raw.messageId ?? null,
      timestamp: raw.date ? new Date(raw.date).getTime() : Date.now(),
      priority: raw.urgent || raw.priority === 'high' ? 1 : 5,
      metadata: {
        channel: 'email',
        subject: raw.subject ?? null,
        to: raw.to ?? null,
        cc: raw.cc ?? null,
      },
    };
  }
}

module.exports = {
  PlatformGateway: withShutdown(PlatformGateway),
  WebChatAdapter,
  AppAdapter,
  FeishuAdapter,
  EmailAdapter,
  PLATFORM_TYPES,
  PLATFORM_PRIORITY,
};
