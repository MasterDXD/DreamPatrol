'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { safeExecute } = require('../../utils/safe-execute');
const { secureId } = require('../../utils/unique-id');
const { withShutdown } = require('../../utils/shutdown-mixin');
const EventEmitter = require('events');

/**
 * @module runtime/optimization/content-publisher
 * 内容发布器 — 实现Auto Research闭环中的"内容推送"环节。
 *
 * 核心能力：
 * - 多平台内容发布（基于BrowserUseAdapter的CDP/MCP双模式）
 * - 发布结果追踪（发布ID、平台响应、链接）
 * - 发布历史记录（每次发布记录日志，成为持续进化核心资产）
 * - 发布策略控制（频率限制、内容审核、自动重试）
 * - 发布效果回传（将平台反馈关联到研究循环）
 *
 * 集成点：
 * - AutonomousResearchLoop: refine阶段调用publish()推送优化内容
 * - BrowserUseAdapter: 使用CDP/MCP模式与外部平台交互
 * - ResearchJournal: 发布记录写入研究日志
 */

/** @constant {Object} PLATFORMS - 支持的发布平台 */
const PLATFORMS = {
  XIAOHONGSHU: 'xiaohongshu',
  DOUYIN: 'douyin',
  WECHAT: 'wechat',
  REDDIT: 'reddit',
  TWITTER: 'twitter',
  CUSTOM: 'custom',
};

/** @constant {Object} PUBLISH_STATUS - 发布状态 */
const PUBLISH_STATUS = {
  PENDING: 'pending',
  PUBLISHING: 'publishing',
  PUBLISHED: 'published',
  FAILED: 'failed',
  WITHDRAWN: 'withdrawn',
};

/** @constant {Object} DEFAULT_OPTIONS - 默认配置 */
const DEFAULT_OPTIONS = {
  maxPublishHistory: 500,
  rateLimitPerPlatform: { default: 10 }, // 每小时每平台最大发布数
  enableAutoRetry: true,
  maxRetries: 2,
  retryDelayMs: 5000,
  enableContentReview: true,
  platforms: [PLATFORMS.XIAOHONGSHU, PLATFORMS.DOUYIN, PLATFORMS.WECHAT],
};

/**
 * @classdesc 内容发布器。实现Auto Research闭环中的"内容推送"环节，
 * 将优化后的内容推送到外部平台，支持多平台发布、频率限制、内容审核和自动重试。
 *
 * @extends EventEmitter
 * @emits 'platform-configured' 当平台配置完成时触发
 * @emits 'content-published' 当内容发布成功时触发
 * @emits 'publish-failed' 当内容发布失败时触发
 * @emits 'content-withdrawn' 当内容撤回时触发
 */
class ContentPublisher extends EventEmitter {
  /**
   * 创建ContentPublisher实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxPublishHistory=500] - 最大发布历史记录数
   * @param {Object} [options.rateLimitPerPlatform] - 每平台频率限制
   * @param {boolean} [options.enableAutoRetry=true] - 是否启用自动重试
   * @param {number} [options.maxRetries=2] - 最大重试次数
   * @param {number} [options.retryDelayMs=5000] - 重试延迟（毫秒）
   * @param {boolean} [options.enableContentReview=true] - 是否启用内容审核
   * @param {Array<string>} [options.platforms] - 默认启用平台列表
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._browserAdapter = null; // BrowserUseAdapter实例
    this._publishHistory = [];   // 发布历史
    this._platformConfigs = new Map(); // 平台配置
    this._rateLimitCounters = new Map(); // 频率限制计数器
    this._stats = {
      totalPublished: 0,
      totalFailed: 0,
      totalRetries: 0,
      byPlatform: {},
    };
    this._shutDown = false;
  }

  /**
   * 挂载BrowserUseAdapter实例。用于通过CDP/MCP模式与外部平台交互。
   * @param {Object} adapter - BrowserUseAdapter实例，需实现extractByTemplate方法
   * @returns {boolean} 是否挂载成功
   */
  attachBrowserAdapter(adapter) {
    if (adapter && typeof adapter.extractByTemplate === 'function') {
      this._browserAdapter = adapter;
      debug('ContentPublisher', 'attachBrowserAdapter', 'attached');
      return true;
    }
    return false;
  }

  /**
   * 配置平台。设置平台的端点、认证方式、模板和频率限制。
   * @param {string} platformId - 平台ID
   * @param {Object} config - 平台配置
   * @param {string} [config.endpoint=''] - 平台端点URL
   * @param {string} [config.authMethod='oauth'] - 认证方式
   * @param {Object} [config.credentials] - 认证凭据
   * @param {string} [config.template='default'] - 发布模板
   * @param {number} [config.rateLimit] - 每小时最大发布数
   * @returns {boolean} 是否配置成功
   * @emits 'platform-configured'
   */
  configurePlatform(platformId, config) {
    this.guardShutdown();
    if (!platformId || !config) return false;
    this._platformConfigs.set(platformId, {
      endpoint: config.endpoint ?? '',
      authMethod: config.authMethod ?? 'oauth',
      template: config.template ?? 'default',
      rateLimit: config.rateLimit ?? this._options.rateLimitPerPlatform.default ?? 10,
      configuredAt: Date.now(),
    });
    this.emit('platform-configured', { platformId });
    return true;
  }

  /**
   * 发布内容到指定平台。支持自动重试和内容审核。
   * @param {string} platformId - 目标平台ID
   * @param {Object} content - 发布内容
   * @param {string} [content.title] - 内容标题
   * @param {string} [content.body] - 内容正文
   * @param {Object} [options] - 发布选项
   * @returns {{success: boolean, publishId?: string, platformResponse?: Object, error?: string}} 发布结果
   * @emits 'content-published'
   * @emits 'publish-failed'
   */
  async publish(platformId, content, _options) {
    this.guardShutdown();
    if (!platformId || !content) {
      return { success: false, error: 'Platform and content are required' };
    }

    // 频率限制检查
    if (!this._checkRateLimit(platformId)) {
      return { success: false, error: 'Rate limit exceeded for platform: ' + platformId };
    }

    // 内容审核
    if (this._options.enableContentReview) {
      const review = this._reviewContent(content);
      if (!review.passed) {
        return { success: false, error: 'Content review failed: ' + review.reason };
      }
    }

    const publishId = secureId('pub-');
    const record = {
      id: publishId,
      platform: platformId,
      content: { ...content },
      status: PUBLISH_STATUS.PUBLISHING,
      attempts: 0,
      publishedAt: null,
      platformResponse: null,
      error: null,
      createdAt: Date.now(),
    };

    // 尝试发布（含重试）
    let lastError = null;
    const maxAttempts = this._options.enableAutoRetry ? this._options.maxRetries + 1 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      record.attempts = attempt + 1;
      try {
        const result = await this._doPublish(platformId, content);
        if (result.success) {
          record.status = PUBLISH_STATUS.PUBLISHED;
          record.publishedAt = Date.now();
          record.platformResponse = result.response ?? {};
          this._stats.totalPublished++;
          this._stats.byPlatform[platformId] = (this._stats.byPlatform[platformId] ?? 0) + 1;
          this._incrementRateLimit(platformId);
          this._addToHistory(record);
          this.emit('content-published', { publishId, platform: platformId, response: result.response });
          debug('ContentPublisher', 'publish', 'id=' + publishId + ' platform=' + platformId);
          return { success: true, publishId, platformResponse: result.response };
        }
        lastError = result.error;
      } catch (err) {
        lastError = err && err.message ? err.message : String(err);
      }
      if (attempt < maxAttempts - 1) {
        this._stats.totalRetries++;
        await new Promise(r => setTimeout(r, this._options.retryDelayMs));
      }
    }

    record.status = PUBLISH_STATUS.FAILED;
    record.error = lastError;
    this._stats.totalFailed++;
    this._addToHistory(record);
    this.emit('publish-failed', { publishId, platform: platformId, error: lastError });
    return { success: false, publishId, error: lastError };
  }

  /**
   * 实际发布逻辑。优先使用BrowserUseAdapter的CDP/MCP模式，
   * 无适配器时执行模拟发布。
   * @param {string} platformId - 目标平台ID
   * @param {Object} content - 发布内容
   * @param {Object} [options] - 发布选项
   * @returns {{success: boolean, response?: Object, error?: string}} 发布结果
   * @private
   */
  async _doPublish(platformId, content) {
    const config = this._platformConfigs.get(platformId);

    // 如果有BrowserUseAdapter，使用CDP/MCP模式
    if (this._browserAdapter && config) {
      return safeExecute(
        () => this._browserAdapter.extractByTemplate(platformId, {
          action: 'publish',
          content,
          endpoint: config.endpoint,
        }),
        'ContentPublisher', '_doPublish-' + platformId,
      ) ?? { success: false, error: 'BrowserAdapter returned null' };
    }

    // 无适配器时的模拟发布
    return {
      success: true,
      response: {
        platformId,
        url: 'https://' + platformId + '.example.com/post/' + Date.now(),
        publishedAt: new Date().toISOString(),
        simulated: true,
      },
    };
  }

  /**
   * 撤回已发布内容。
   * @param {string} publishId - 发布记录ID
   * @returns {{success: boolean, publishId?: string, error?: string}} 撤回结果
   * @emits 'content-withdrawn'
   */
  async withdraw(publishId) {
    this.guardShutdown();
    const record = this._publishHistory.find(r => r.id === publishId);
    if (!record) return { success: false, error: 'Publish record not found' };
    if (record.status !== PUBLISH_STATUS.PUBLISHED) {
      return { success: false, error: 'Can only withdraw published content' };
    }
    record.status = PUBLISH_STATUS.WITHDRAWN;
    record.withdrawnAt = Date.now();
    this.emit('content-withdrawn', { publishId, platform: record.platform });
    return { success: true, publishId };
  }

  /**
   * 获取发布历史记录。支持按平台、状态过滤和数量限制。
   * @param {Object} [filters] - 过滤条件
   * @param {string} [filters.platform] - 按平台过滤
   * @param {string} [filters.status] - 按状态过滤
   * @param {number} [filters.limit] - 返回记录数量上限
   * @returns {Array<Object>} 发布历史记录列表
   */
  getHistory(filters) {
    let records = [...this._publishHistory];
    if (filters?.platform) records = records.filter(r => r.platform === filters.platform);
    if (filters?.status) records = records.filter(r => r.status === filters.status);
    if (filters?.limit) records = records.slice(0, filters.limit);
    return records;
  }

  /**
   * 获取发布统计数据。
   * @returns {{totalPublished: number, totalFailed: number, totalRetries: number, byPlatform: Object, historySize: number}} 统计信息
   */
  getStats() {
    return { ...this._stats, historySize: this._publishHistory.length };
  }

  /**
   * 获取支持的平台列表。
   * @returns {Array<string>} 平台ID列表
   */
  getSupportedPlatforms() {
    return Object.values(PLATFORMS);
  }

  /**
   * 频率限制检查。检查指定平台在当前时间窗口内是否超过发布频率上限。
   * @param {string} platformId - 平台ID
   * @returns {boolean} 是否允许发布
   * @private
   */
  _checkRateLimit(platformId) {
    const config = this._platformConfigs.get(platformId);
    const limit = config?.rateLimit ?? this._options.rateLimitPerPlatform.default ?? 10;
    const counter = this._rateLimitCounters.get(platformId);
    if (!counter) return true;
    // 检查是否在当前时间窗口内
    const now = Date.now();
    if (now - counter.windowStart > 3600000) return true; // 1小时窗口重置
    return counter.count < limit;
  }

  /**
   * 递增平台频率限制计数器。
   * @param {string} platformId - 平台ID
   * @private
   */
  _incrementRateLimit(platformId) {
    const now = Date.now();
    let counter = this._rateLimitCounters.get(platformId);
    if (!counter || now - counter.windowStart > 3600000) {
      counter = { count: 0, windowStart: now };
    }
    counter.count++;
    this._rateLimitCounters.set(platformId, counter);
  }

  /**
   * 内容审核（基础版）。检查内容格式和长度限制。
   * @param {Object} content - 待审核内容
   * @returns {{passed: boolean, reason?: string}} 审核结果
   * @private
   */
  _reviewContent(content) {
    if (!content || typeof content !== 'object') {
      return { passed: false, reason: 'Content must be an object' };
    }
    // 检查必要字段
    if (content.title && content.title.length > 500) {
      return { passed: false, reason: 'Title too long (max 500 chars)' };
    }
    if (content.body && content.body.length > 50000) {
      return { passed: false, reason: 'Body too long (max 50000 chars)' };
    }
    return { passed: true };
  }

  /**
   * 添加发布记录到历史，超出上限时移除最早记录。
   * @param {Object} record - 发布记录
   * @private
   */
  _addToHistory(record) {
    this._publishHistory.push(record);
    if (this._publishHistory.length > this._options.maxPublishHistory) {
      this._publishHistory.shift();
    }
  }

  /**
   * 关闭时清理适配器、平台配置和频率计数器。
   * @protected
   */
  _onShutdown() {
    this._browserAdapter = null;
    this._platformConfigs.clear();
    this._rateLimitCounters.clear();
  }
}

module.exports = withShutdown(ContentPublisher);
module.exports.PLATFORMS = PLATFORMS;
module.exports.PUBLISH_STATUS = PUBLISH_STATUS;
