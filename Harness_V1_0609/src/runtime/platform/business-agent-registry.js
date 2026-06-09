'use strict';

/**
 * 业务Agent注册中心（BusinessAgentRegistry）。管理业务领域Agent的定义、注册、发现和路由。
 * 实现了用户提出架构中"业务Agent（执行层）"的核心能力：
 * - 预定义业务Agent模板（客服、订单处理、物流查询、数据分析、营销等）
 * - 基于关键词和语义的智能路由
 * - 业务Agent能力注册与发现
 * - 与Harness现有Agent体系无缝集成
 *
 * @module runtime/platform/business-agent-registry
 * @extends EventEmitter
 * @fires BusinessAgentRegistry#agent-registered
 * @fires BusinessAgentRegistry#agent-discovered
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

/** 业务Agent优先级（数值越低优先级越高） */
const BUSINESS_PRIORITY = {
  URGENT: 1,
  HIGH: 3,
  NORMAL: 5,
  LOW: 8,
};

/** 业务Agent类型常量 */
const BUSINESS_AGENT_TYPES = {
  CUSTOMER_SERVICE: 'customer-service',
  ORDER_PROCESSING: 'order-processing',
  LOGISTICS: 'logistics',
  DATA_ANALYST: 'data-analyst',
  MARKETING: 'marketing',
  PAYMENT: 'payment',
  ACCOUNT: 'account',
  GENERAL: 'general',
};

/**
 * 预定义业务Agent模板
 * 每个模板定义了业务Agent的能力、触发关键词、优先级规则和关联的Harness Agent
 */
const BUSINESS_AGENT_TEMPLATES = {
  [BUSINESS_AGENT_TYPES.CUSTOMER_SERVICE]: {
    name: '客服Agent',
    name_en: 'Customer Service Agent',
    description: '处理客户咨询、售后、投诉、退货等客服场景',
    capabilities: ['customer-support', 'complaint-handling', 'refund-processing', 'inquiry-answering'],
    keywords: ['客服', '咨询', '帮助', '售后', '退货', '退款', '投诉', '问题', 'customer', 'support', 'refund', 'complaint', 'help'],
    priority: BUSINESS_PRIORITY.HIGH,
    escalationRules: {
      unresolvedAfterMinutes: 10,
      escalateTo: BUSINESS_AGENT_TYPES.ORDER_PROCESSING,
      urgentKeywords: ['投诉', '紧急', 'urgent', 'escalate', 'manager'],
    },
    harnessAgentMapping: 'task-worker',
    modelTier: 'medium',
    maxContextTokens: 50000,
  },
  [BUSINESS_AGENT_TYPES.ORDER_PROCESSING]: {
    name: '订单处理Agent',
    name_en: 'Order Processing Agent',
    description: '处理订单查询、创建、修改、取消等订单相关操作',
    capabilities: ['order-query', 'order-creation', 'order-modification', 'order-cancellation'],
    keywords: ['订单', 'order', '下单', '购买', '取消', '修改订单', '购物车', 'cart', 'checkout'],
    priority: BUSINESS_PRIORITY.HIGH,
    escalationRules: {
      unresolvedAfterMinutes: 15,
      escalateTo: BUSINESS_AGENT_TYPES.DATA_ANALYST,
      urgentKeywords: ['取消订单', '扣款', 'charge', 'payment issue'],
    },
    harnessAgentMapping: 'task-worker',
    modelTier: 'medium',
    maxContextTokens: 60000,
  },
  [BUSINESS_AGENT_TYPES.LOGISTICS]: {
    name: '物流查询Agent',
    name_en: 'Logistics Agent',
    description: '查询物流状态、配送进度、预计送达时间',
    capabilities: ['shipment-tracking', 'delivery-estimation', 'logistics-query'],
    keywords: ['物流', '配送', '快递', '发货', 'tracking', 'shipment', 'delivery', '运输', '到哪了'],
    priority: BUSINESS_PRIORITY.NORMAL,
    escalationRules: {
      unresolvedAfterMinutes: 20,
      escalateTo: BUSINESS_AGENT_TYPES.CUSTOMER_SERVICE,
      urgentKeywords: ['丢失', '损坏', 'damaged', 'lost', 'missing'],
    },
    harnessAgentMapping: 'task-worker',
    modelTier: 'small',
    maxContextTokens: 30000,
  },
  [BUSINESS_AGENT_TYPES.DATA_ANALYST]: {
    name: '数据分析Agent',
    name_en: 'Data Analyst Agent',
    description: '分析用户数据、销售报表、趋势预测',
    capabilities: ['data-analysis', 'report-generation', 'trend-prediction', 'metrics-query'],
    keywords: ['数据', '分析', '报表', '统计', '趋势', 'analytics', 'report', 'metrics', 'dashboard', '图表'],
    priority: BUSINESS_PRIORITY.NORMAL,
    escalationRules: {
      unresolvedAfterMinutes: 30,
      escalateTo: null,
      urgentKeywords: ['异常', 'anomaly', '急', 'urgent report'],
    },
    harnessAgentMapping: 'domain-analyst',
    modelTier: 'large',
    maxContextTokens: 100000,
  },
  [BUSINESS_AGENT_TYPES.MARKETING]: {
    name: '营销Agent',
    name_en: 'Marketing Agent',
    description: '处理促销活动、优惠券、折扣查询、营销推荐',
    capabilities: ['promotion-query', 'coupon-management', 'discount-query', 'recommendation'],
    keywords: ['优惠', '促销', '折扣', '活动', '优惠券', 'coupon', 'discount', 'promotion', 'sale', '推荐'],
    priority: BUSINESS_PRIORITY.LOW,
    escalationRules: {
      unresolvedAfterMinutes: 30,
      escalateTo: BUSINESS_AGENT_TYPES.DATA_ANALYST,
      urgentKeywords: ['过期', 'expired', '不能用', 'not working'],
    },
    harnessAgentMapping: 'task-worker',
    modelTier: 'medium',
    maxContextTokens: 40000,
  },
  [BUSINESS_AGENT_TYPES.PAYMENT]: {
    name: '支付Agent',
    name_en: 'Payment Agent',
    description: '处理支付相关问题、账单查询、退款处理',
    capabilities: ['payment-query', 'billing', 'refund-processing', 'invoice-generation'],
    keywords: ['支付', '付款', '账单', '发票', 'payment', 'bill', 'invoice', 'charge', '扣款', '退款'],
    priority: BUSINESS_PRIORITY.HIGH,
    escalationRules: {
      unresolvedAfterMinutes: 10,
      escalateTo: BUSINESS_AGENT_TYPES.ORDER_PROCESSING,
      urgentKeywords: ['扣款失败', '多扣', '盗刷', 'fraud', 'unauthorized'],
    },
    harnessAgentMapping: 'task-worker',
    modelTier: 'medium',
    maxContextTokens: 50000,
  },
  [BUSINESS_AGENT_TYPES.ACCOUNT]: {
    name: '账户管理Agent',
    name_en: 'Account Management Agent',
    description: '处理账户注册、登录、密码重置、权限管理',
    capabilities: ['account-registration', 'login-support', 'password-reset', 'permission-management'],
    keywords: ['账户', '登录', '注册', '密码', 'account', 'login', 'register', 'password', '验证', '绑定'],
    priority: BUSINESS_PRIORITY.HIGH,
    escalationRules: {
      unresolvedAfterMinutes: 10,
      escalateTo: null,
      urgentKeywords: ['被盗', 'hacked', '无法登录', 'cannot login'],
    },
    harnessAgentMapping: 'task-worker',
    modelTier: 'small',
    maxContextTokens: 30000,
  },
  [BUSINESS_AGENT_TYPES.GENERAL]: {
    name: '通用Agent',
    name_en: 'General Agent',
    description: '处理未分类的通用请求，作为兜底Agent',
    capabilities: ['general-inquiry', 'faq-answering', 'routing'],
    keywords: [],
    priority: BUSINESS_PRIORITY.LOW,
    escalationRules: {
      unresolvedAfterMinutes: 20,
      escalateTo: BUSINESS_AGENT_TYPES.CUSTOMER_SERVICE,
      urgentKeywords: [],
    },
    harnessAgentMapping: 'task-worker',
    modelTier: 'medium',
    maxContextTokens: 40000,
  },
};

/**
 * 业务Agent注册中心
 */
class BusinessAgentRegistry extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.templates] - 自定义业务Agent模板
   * @param {boolean} [options.autoRegister=true] - 是否自动注册预定义模板
   */
  constructor(options) {
    super();
    const opts = options ?? {};

    // 业务Agent注册表: agentType -> { definition, status, registeredAt, stats }
    this._registry = new Map();

    // 自动注册预定义模板
    if (opts.autoRegister !== false) {
      this._registerTemplates(opts.templates ?? {});
    }
  }

  /**
   * 注册业务Agent
   * @param {string} agentType - Agent类型
   * @param {Object} definition - Agent定义
   * @returns {boolean} 是否注册成功
   */
  register(agentType, definition) {
    this.guardShutdown();
    if (!agentType || !definition) return false;

    this._registry.set(agentType, {
      definition: { ...definition },
      status: 'active',
      registeredAt: Date.now(),
      stats: {
        totalRouted: 0,
        totalHandled: 0,
        totalEscalated: 0,
        avgResponseTimeMs: 0,
      },
    });

    this.emit('agent-registered', { agentType, definition });
    debug('BusinessAgentRegistry', 'agent-registered', agentType);
    return true;
  }

  /**
   * 基于消息内容路由到合适的业务Agent
   * @param {Object} message - 统一消息格式
   * @param {string} message.taskContent - 任务内容
   * @param {number} [message.priority] - 消息优先级
   * @returns {{ agentType: string, confidence: number, priority: number, harnessAgent: string }}
   */
  route(message) {
    this.guardShutdown();
    const content = (message?.taskContent ?? '').toLowerCase();
    const msgPriority = message?.priority ?? BUSINESS_PRIORITY.NORMAL;

    let bestMatch = null;
    let bestScore = 0;

    for (const [agentType, entry] of this._registry) {
      if (entry.status !== 'active') continue;
      const def = entry.definition;
      const keywords = def.keywords ?? [];

      let score = 0;
      for (const keyword of keywords) {
        if (content.includes(keyword.toLowerCase())) {
          score += keyword.length; // 长关键词匹配权重更高
        }
      }

      // 紧急关键词加分
      const urgentKeywords = def.escalationRules?.urgentKeywords ?? [];
      for (const uk of urgentKeywords) {
        if (content.includes(uk.toLowerCase())) {
          score += uk.length * 3;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          agentType,
          confidence: Math.min(score / 10, 1.0),
          priority: Math.min(def.priority ?? BUSINESS_PRIORITY.NORMAL, msgPriority),
          harnessAgent: def.harnessAgentMapping ?? 'task-worker',
        };
      }
    }

    // 无匹配时返回通用Agent
    if (!bestMatch || bestMatch.confidence < 0.01) {
      bestMatch = {
        agentType: BUSINESS_AGENT_TYPES.GENERAL,
        confidence: 0,
        priority: msgPriority,
        harnessAgent: 'task-worker',
      };
    }

    // 更新统计
    const entry = this._registry.get(bestMatch.agentType);
    if (entry) {
      entry.stats.totalRouted++;
    }

    this.emit('agent-discovered', { message, match: bestMatch, score: bestScore });
    return bestMatch;
  }

  /**
   * 获取Agent定义
   * @param {string} agentType - Agent类型
   * @returns {Object|null} Agent定义
   */
  getDefinition(agentType) {
    const entry = this._registry.get(agentType);
    return entry ? entry.definition : null;
  }

  /**
   * 获取所有已注册的业务Agent
   * @returns {Array<{ agentType: string, definition: Object, status: string }>}
   */
  listAll() {
    return Array.from(this._registry.entries()).map(([agentType, entry]) => ({
      agentType,
      definition: entry.definition,
      status: entry.status,
      stats: entry.stats,
      registeredAt: entry.registeredAt,
    }));
  }

  /**
   * 获取Agent统计信息
   * @param {string} agentType - Agent类型
   * @returns {Object|null} 统计信息
   */
  getStats(agentType) {
    const entry = this._registry.get(agentType);
    return entry ? { ...entry.stats } : null;
  }

  /**
   * 更新Agent统计
   * @param {string} agentType - Agent类型
   * @param {Object} stats - 统计更新
   */
  updateStats(agentType, stats) {
    const entry = this._registry.get(agentType);
    if (!entry) return;
    if (stats.totalHandled !== undefined) entry.stats.totalHandled = stats.totalHandled;
    if (stats.totalEscalated !== undefined) entry.stats.totalEscalated = stats.totalEscalated;
    if (stats.avgResponseTimeMs !== undefined) entry.stats.avgResponseTimeMs = stats.avgResponseTimeMs;
  }

  /**
   * 获取升级规则
   * @param {string} agentType - Agent类型
   * @returns {Object|null} 升级规则
   */
  getEscalationRules(agentType) {
    const entry = this._registry.get(agentType);
    return entry ? entry.definition.escalationRules : null;
  }

  // ---- 内部方法 ----

  /**
   * 注册预定义模板
   * @private
   */
  _registerTemplates(customTemplates) {
    const allTemplates = { ...BUSINESS_AGENT_TEMPLATES, ...customTemplates };
    for (const [agentType, definition] of Object.entries(allTemplates)) {
      this.register(agentType, definition);
    }
  }
}

module.exports = {
  BusinessAgentRegistry: withShutdown(BusinessAgentRegistry),
  BUSINESS_AGENT_TYPES,
  BUSINESS_AGENT_TEMPLATES,
  BUSINESS_PRIORITY,
};
