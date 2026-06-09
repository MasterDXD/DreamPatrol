'use strict';
const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');
const RingBuffer = require('../../utils/ring-buffer');

/**
 * @constant
 * @type {Array<Object>}
 * @property {string[]} patterns - 错误消息匹配模式列表
 * @property {string} category - 对应的错误分类
 */
const MSG_PATTERNS = [
  { patterns: ['timeout', 'ETIMEDOUT'], category: 'timeout-error' },
  { patterns: ['convergence', 'converge'], category: 'convergence-error' },
  { patterns: ['invalid', 'validat'], category: 'validation-error' },
  { patterns: ['resource', 'memory', 'CPU', 'limit exceeded'], category: 'resource-error' },
];

/**
 * @constant
 * @type {Object}
 * @property {string} agent - Agent错误
 * @property {string} convergence - 收敛错误
 * @property {string} validation - 验证错误
 * @property {string} resource - 资源错误
 */
const CONTEXT_TYPE_CATEGORIES = {
  agent: 'agent-error',
  timeout: 'timeout-error',
  convergence: 'convergence-error',
  validation: 'validation-error',
  resource: 'resource-error',
};

/**
 * 根据错误消息内容自动分类错误类型。
 * @param {string} msg - 错误消息
 * @returns {string} 错误分类（'timeout-error'|'convergence-error'|'validation-error'|'resource-error'|'unknown-error'）
 * @private
 */
function _categorizeByMessage(msg) {
  for (const entry of MSG_PATTERNS) {
    for (const pattern of entry.patterns) {
      if (msg.toLowerCase().includes(pattern.toLowerCase())) return entry.category;
    }
  }
  return 'unknown-error';
}

/**
 * @constant
 * @type {number}
 * @description 重试计数键的最大数量，超出时淘汰最早的键
 */
const MAX_RETRY_KEYS = 500;

/**
 * @module runtime/deepening/deepening-error-handler
 * 深化推理错误处理器。集中式错误处理，支持错误分类、重试策略和降级处理。
 */

/**
 * 深化推理错误处理器 — 深化管道的集中式错误处理。
 * 按类型分类错误（超时、收敛、验证、资源、Agent），
 * 对可重试类别应用带可配置限制的重试策略，
 * 重试耗尽时委托给已注册的降级处理器。
 *
 * @classdesc 深化错误处理器。错误分类、错误链追踪、恢复策略
 * @extends DeepeningBase
 */
class DeepeningErrorHandler extends DeepeningBase {

  /**
   * 创建 DeepeningErrorHandler 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxRetries=3] - 可重试错误的最大重试次数
   * @param {number} [options.retryDelay=100] - 重试间隔（毫秒，当前版本未使用）
   * @param {number} [options.maxErrorLogSize=500] - 错误日志最大记录数
   */
  constructor(options) {
    super(options);
    this._maxRetries = typeof (options && options.maxRetries) === 'number' && Number.isFinite(options.maxRetries) ? options.maxRetries : 3;
    this._retryDelay = typeof (options && options.retryDelay) === 'number' && Number.isFinite(options.retryDelay) ? options.retryDelay : 100;
    this._maxErrorLogSize = typeof (options && options.maxErrorLogSize) === 'number' && Number.isFinite(options.maxErrorLogSize) ? options.maxErrorLogSize : 500;
    this._fallbacks = new Map();
    this._maxFallbacks = 50;
    this._errorLog = new RingBuffer(this._maxErrorLogSize);
    this._retryCounts = new Map();
    this._categoryCounts = {};
    this._totalErrors = 0;
  }

  /**
   * 处理错误。自动分类错误，对可重试类别（agent-error、timeout-error）应用重试策略，
   * 重试耗尽时尝试降级处理器，否则返回跳过策略。
   * @param {Error} error - 错误对象
   * @param {Object} [context] - 错误上下文
   * @param {string} [context.type] - 上下文类型（'agent'|'convergence'|'validation'|'resource'），用于直接分类
   * @param {string} [context.executionId] - 执行标识，用于重试计数键
   * @returns {Promise<Object>} 处理结果
   * @returns {boolean} return.handled - 是否已处理
   * @returns {string} return.category - 错误分类
   * @returns {string} [return.strategy] - 处理策略（'retry'|'fallback'|'skip'）
   * @returns {number} [return.retryCount] - 当前重试次数
   * @returns {*} [return.fallbackResult] - 降级处理器的返回值
   */
  _categorizeError(error, ctx) {
    if (ctx.type && CONTEXT_TYPE_CATEGORIES[ctx.type]) {
      return CONTEXT_TYPE_CATEGORIES[ctx.type];
    }
    return _categorizeByMessage(error?.message ?? '');
  }

  _buildErrorEntry(error, category, ctx) {
    return { error: (error && error.message) || String(error), category, context: ctx, timestamp: Date.now(), code: error?.code ?? null };
  }

  /**
   * 处理错误。自动分类错误，对可重试类别（agent-error、timeout-error）应用重试策略，
   * 重试耗尽时尝试降级处理器，否则返回跳过策略。
   * @param {Error} error - 错误对象
   * @param {Object} [context] - 错误上下文
   * @param {string} [context.type] - 上下文类型（'agent'|'convergence'|'validation'|'resource'），用于直接分类
   * @param {string} [context.executionId] - 执行标识，用于重试计数键
   * @returns {Promise<{handled: boolean, category: string, strategy?: string, retryCount?: number, fallbackResult?: *}>} 处理结果
   */
  async handleError(error, context) {
    this.guardShutdown();
    const ctx = context ?? {};
    const category = this._categorizeError(error, ctx);

    const executionId = ctx.executionId || 'unknown';
    const retryKey = executionId + ':' + category;
    const currentRetries = this._retryCounts.get(retryKey) ?? 0;
    if (typeof currentRetries !== 'number' || !Number.isFinite(currentRetries)) {
      this._retryCounts.set(retryKey, 0);
    }
    const safeRetries = (typeof currentRetries === 'number' && Number.isFinite(currentRetries)) ? currentRetries : 0;

    const entry = this._buildErrorEntry(error, category, ctx);
    this._errorLog.push(entry);
    this._totalErrors++;
    this._categoryCounts[category] = (typeof this._categoryCounts[category] === 'number' && Number.isFinite(this._categoryCounts[category]) ? this._categoryCounts[category] : 0) + 1;

    const isRetryable = category === 'agent-error' || category === 'timeout-error';

    if (isRetryable && safeRetries < this._maxRetries) {
      this._retryCounts.set(retryKey, safeRetries + 1);
      if (this._retryCounts.size > MAX_RETRY_KEYS) {
        const oldestKey = this._retryCounts.keys().next().value;
        this._retryCounts.delete(oldestKey);
      }
      return { handled: true, category, strategy: 'retry', retryCount: safeRetries + 1 };
    }

    this._retryCounts.delete(retryKey);

    const fallback = this._fallbacks.get(category);
    if (fallback) {
      try {
        const fallbackResult = await fallback(error, ctx);
        if (this._shutDown) return { handled: true, category, strategy: 'fallback' };
        return { handled: true, category, strategy: 'fallback', fallbackResult };
      } catch (fbErr) {
        debug('DeepeningErrorHandler', 'fallback:' + category, fbErr);
      }
    }

    if (isRetryable) {
      return { handled: true, category, strategy: 'skip' };
    }

    return { handled: true, category };
  }

  /**
   * 注册降级处理器。当指定类别的错误重试耗尽时调用。
   * @param {string} category - 错误分类
   * @param {Function} handler - 降级处理函数，签名 (error, context) => Promise<*>
   * @returns {boolean} 注册是否成功
   */
  registerFallback(category, handler) {
    this.guardShutdown();
    if (this._fallbacks.size >= this._maxFallbacks && !this._fallbacks.has(category)) {
      const oldest = this._fallbacks.keys().next().value;
      this._fallbacks.delete(oldest);
    }
    this._fallbacks.set(category, handler);
    return true;
  }

  /**
   * 获取错误日志。
   * @param {Object} [filters] - 过滤条件
   * @param {string} [filters.executionId] - 按执行标识过滤
   * @param {string} [filters.category] - 按错误分类过滤
   * @returns {Object[]} 错误日志记录数组
   */
  getErrorLog(filters) {
    if (!filters) return this._errorLog.toArray().map(e => ({ ...e }));
    return this._errorLog.filter(e => {
      if (filters.executionId && (!e.context || e.context.executionId !== filters.executionId)) return false;
      if (filters.category && e.category !== filters.category) return false;
      return true;
    }).map(e => ({ ...e }));
  }

  /**
   * 获取错误处理器运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalErrors - 错误总数
   * @returns {Object} return.categoryCounts - 各分类错误计数
   * @returns {string[]} return.categories - 已注册降级处理器的分类列表
   */
  getStats() {
    return { totalErrors: this._totalErrors, categoryCounts: { ...this._categoryCounts }, categories: Array.from(this._fallbacks.keys()), ...super.getStats() };
  }

  /**
   * 关闭时的清理回调。清空降级处理器、错误日志、重试计数和分类计数。
   * @protected
   */
  _onShutdown() {
    this._fallbacks.clear();
    this._errorLog.clear();
    this._retryCounts.clear();
    this._categoryCounts = {};
    this._totalErrors = 0;
    super._onShutdown();
  }
}

module.exports = DeepeningErrorHandler;
