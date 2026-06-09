'use strict';

const { EventEmitter } = require('events');
const { SessionError } = require('../../errors');
const { DEFAULT_TOKEN_BUDGET, TOKEN_BUDGET_WARNING_RATIO, TOKEN_BUDGET_DANGER_RATIO, isNonEmptyString } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

const TOKEN_UNITS = {
  K: 1e3,
  M: 1e6,
  B: 1e9,
};

/**
 * @module runtime/model/token-manager
 * Token管理器。使用量追踪、预算检查、分类统计，
 * 支持多会话Token隔离和预算预警。
 */

/**
 * Token管理器。使用量追踪、预算检查、分类统计，
 * 支持多会话Token管理、LRU淘汰和预算预警事件。
 * @classdesc Token管理器。使用量追踪、预算检查、分类统计
 * @extends EventEmitter
 */
class TokenManager extends EventEmitter {
  /**
   * 创建 TokenManager 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.defaultBudget] - 全局Token预算上限，默认使用 DEFAULT_TOKEN_BUDGET
   * @param {number} [options.maxSessions=1000] - 最大会话数量，超出后LRU淘汰最旧会话
   */
  constructor(options) {
    super();
    this._globalBudget = (options && options.defaultBudget) ?? DEFAULT_TOKEN_BUDGET;
    this._maxSessions = (options && options.maxSessions) ?? 1000;
    this._sessionTokens = new Map();
    this._sessionBreakdowns = new Map();
  }

  /**
   * 为指定会话累加Token使用量，超限时自动触发预警事件
   * @param {string} sessionId - 会话标识
   * @param {number} amount - 累加的Token数量，必须为非负有限数
   * @returns {number} 累加后的会话Token总量
   * @throws {SessionError} 关机状态、无效sessionId或无效amount时抛出
   * @emits TokenManager#token-exhausted
   * @emits TokenManager#token-warning-95
   * @emits TokenManager#token-warning-80
   */
  store(sessionId, amount) {
    this.guardShutdown();
    if (!isNonEmptyString(sessionId)) {
      throw new SessionError('INVALID_SESSION_ID', 'sessionId must be a non-empty string');
    }
    const num = Number(amount);
    if (!Number.isFinite(num) || num < 0) {
      throw new SessionError('INVALID_TOKEN_AMOUNT', 'token amount must be a non-negative finite number');
    }
    const currentValidation = this.validate(sessionId);
    if (currentValidation.exhausted) {
      this.emit('token-exhausted', { sessionId, tokensUsed: currentValidation.tokensUsed, budget: currentValidation.budget });
      throw new SessionError('BUDGET_EXCEEDED', 'Token budget has been exhausted for session ' + sessionId);
    }
    const prev = this._sessionTokens.get(sessionId) ?? 0;
    const newTotal = prev + num;
    const isNewSession = !this._sessionTokens.has(sessionId);
    this._sessionTokens.delete(sessionId);
    this._sessionTokens.set(sessionId, newTotal);
    if (this._sessionTokens.size >= this._maxSessions && isNewSession) {
      const oldestKey = this._sessionTokens.keys().next().value;
      this.clear(oldestKey);
    }
    const result = this.validate(sessionId);
    if (result.exhausted) {
      this.emit('token-exhausted', { sessionId, tokensUsed: result.tokensUsed, budget: result.budget });
    } else if (result.warning95) {
      this.emit('token-warning-95', { sessionId, tokensUsed: result.tokensUsed, budget: result.budget });
    } else if (result.warning80) {
      this.emit('token-warning-80', { sessionId, tokensUsed: result.tokensUsed, budget: result.budget });
    }
    return this._sessionTokens.get(sessionId);
  }

  /**
   * 获取指定会话的Token使用量
   * @param {string} sessionId - 会话标识
   * @returns {number} 该会话已使用的Token数量，不存在时返回0
   * @throws {SessionError} sessionId无效时抛出
   */
  get(sessionId) {
    if (!isNonEmptyString(sessionId)) {
      throw new SessionError('INVALID_SESSION_ID', 'sessionId must be a non-empty string');
    }
    return this._sessionTokens.get(sessionId) ?? 0;
  }

  /**
   * 直接设置指定会话的Token使用量（覆盖而非累加）
   * @param {string} sessionId - 会话标识
   * @param {number} amount - 要设置的Token数量，必须为非负有限数
   * @returns {number} 设置后的Token数量
   * @throws {SessionError} sessionId无效或amount无效时抛出
   */
  set(sessionId, amount) {
    this.guardShutdown();
    if (!isNonEmptyString(sessionId)) {
      throw new SessionError('INVALID_SESSION_ID', 'sessionId must be a non-empty string');
    }
    const num = Number(amount);
    if (!Number.isFinite(num) || num < 0) {
      throw new SessionError('INVALID_TOKEN_AMOUNT', 'token amount must be a non-negative finite number');
    }
    const isNewSession = !this._sessionTokens.has(sessionId);
    this._sessionTokens.delete(sessionId);
    this._sessionTokens.set(sessionId, num);
    if (this._sessionTokens.size >= this._maxSessions && isNewSession) {
      const oldestKey = this._sessionTokens.keys().next().value;
      this.clear(oldestKey);
    }
    const result = this.validate(sessionId);
    if (result.exhausted) {
      this.emit('token-exhausted', { sessionId, tokensUsed: result.tokensUsed, budget: result.budget });
    } else if (result.warning95) {
      this.emit('token-warning-95', { sessionId, tokensUsed: result.tokensUsed, budget: result.budget });
    } else if (result.warning80) {
      this.emit('token-warning-80', { sessionId, tokensUsed: result.tokensUsed, budget: result.budget });
    }
    return num;
  }

  /**
   * 验证指定会话的Token使用量是否超出预算阈值
   * @param {string} sessionId - 会话标识
   * @param {number} [budget] - 自定义预算值，不传则使用全局预算
   * @returns {{ sessionId: string, tokensUsed: number, budget: number, ratio: number, warning80: boolean, warning95: boolean, exhausted: boolean }} 验证结果，包含使用量、预算、使用比率和各级预警标志
   * @throws {SessionError} sessionId无效时抛出
   */
  validate(sessionId, budget) {
    if (!isNonEmptyString(sessionId)) {
      throw new SessionError('INVALID_SESSION_ID', 'sessionId must be a non-empty string');
    }
    const b = typeof budget === 'number' && Number.isFinite(budget) ? budget : this._globalBudget;
    const tokensUsed = this._sessionTokens.get(sessionId) ?? 0;
    const ratio = b > 0 ? tokensUsed / b : 0;
    return {
      sessionId,
      tokensUsed,
      budget: b,
      ratio,
      warning80: ratio >= TOKEN_BUDGET_WARNING_RATIO,
      warning95: ratio >= TOKEN_BUDGET_DANGER_RATIO,
      exhausted: ratio >= 1.0,
    };
  }

  /**
   * 清除指定会话的Token使用量及分类明细
   * @param {string} sessionId - 会话标识
   * @throws {SessionError} sessionId无效时抛出
   */
  clear(sessionId) {
    this.guardShutdown();
    if (!isNonEmptyString(sessionId)) {
      throw new SessionError('INVALID_SESSION_ID', 'sessionId must be a non-empty string');
    }
    this._sessionTokens.delete(sessionId);
    this._sessionBreakdowns.delete(sessionId);
    this.emit('token-reset', { sessionId });
  }

  /**
   * 清除所有会话的Token使用量及分类明细
   */
  clearAll() {
    this.guardShutdown();
    this._sessionTokens.clear();
    this._sessionBreakdowns.clear();
    this.emit('token-reset', { sessionId: null });
  }

  /**
   * 为指定会话添加分类Token消耗明细
   * @param {string} sessionId - 会话标识
   * @param {string} category - 消耗分类名称（如input/output/toolCall）
   * @param {number} amount - 该分类的Token消耗量，必须为非负有限数
   * @returns {Object} 更新后的该会话分类明细对象
   * @throws {SessionError} 关机状态、无效sessionId、无效category或无效amount时抛出
   */
  addBreakdown(sessionId, category, amount) {
    this.guardShutdown();
    if (!isNonEmptyString(sessionId)) {
      throw new SessionError('INVALID_SESSION_ID', 'sessionId must be a non-empty string');
    }
    if (!isNonEmptyString(category)) {
      throw new SessionError('INVALID_BREAKDOWN_CATEGORY', 'category must be a non-empty string');
    }
    const num = Number(amount);
    if (!Number.isFinite(num) || num < 0) {
      throw new SessionError('INVALID_TOKEN_AMOUNT', 'token amount must be a non-negative finite number');
    }
    if (!this._sessionBreakdowns.has(sessionId)) {
      if (this._sessionBreakdowns.size >= this._maxSessions) {
        const oldestKey = this._sessionBreakdowns.keys().next().value;
        this._sessionBreakdowns.delete(oldestKey);
      }
      this._sessionBreakdowns.set(sessionId, {});
    }
    const breakdown = this._sessionBreakdowns.get(sessionId);
    breakdown[category] = (breakdown[category] ?? 0) + num;
    return breakdown;
  }

  /**
   * 获取指定会话的分类Token消耗明细
   * @param {string} sessionId - 会话标识
   * @returns {Object} 该会话的分类明细对象，不存在时返回空对象
   * @throws {SessionError} sessionId无效时抛出
   */
  getBreakdown(sessionId) {
    if (!isNonEmptyString(sessionId)) {
      throw new SessionError('INVALID_SESSION_ID', 'sessionId must be a non-empty string');
    }
    const bd = this._sessionBreakdowns.get(sessionId); return bd ? JSON.parse(JSON.stringify(bd)) : {};
  }

  /**
   * 获取所有会话或指定会话的分类Token消耗明细
   * @param {string} [sessionId] - 可选的会话标识，传入时仅返回该会话明细
   * @returns {Object} 全部会话明细映射或单个会话明细对象
   */
  getAllBreakdowns(sessionId) {
    if (sessionId) {
      return this.getBreakdown(sessionId);
    }
    const all = {};
    for (const [sid, breakdown] of this._sessionBreakdowns) {
      all[sid] = { ...breakdown };
    }
    return all;
  }

  /**
   * 获取所有会话的Token总使用量及预算占比
   * @param {number} [budget] - 自定义预算值，不传则使用全局预算
   * @returns {{ total: number, budget: number, ratio: number }} 汇总数据，包含总使用量、预算和使用比率
   */
  getTotal(budget) {
    const b = typeof budget === 'number' && Number.isFinite(budget) ? budget : this._globalBudget;
    const total = [...this._sessionTokens.values()].reduce((sum, tokens) => sum + tokens, 0);
    return { total, budget: b, ratio: b > 0 ? total / b : 0 };
  }

  /**
   * 将Token数值格式化为人类可读字符串（如1.23B、5.6M、12K）
   * @param {number} n - 要格式化的Token数量
   * @returns {string} 格式化后的字符串，无效输入返回'0'
   */
  formatTokens(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num < 0) return '0';
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(0) + 'K';
    return String(Math.round(num));
  }

  /**
   * 将人类可读的Token格式化字符串解析为数值
   * @param {string} formatted - 格式化字符串（如"1.5M"、"500K"、"2B"）
   * @returns {number} 解析后的Token数量，无效输入返回0
   */
  parseFormatted(formatted) {
    if (!isNonEmptyString(formatted)) return 0;
    const trimmed = formatted.trim().toUpperCase();
    const match = trimmed.match(/^([\d.]+)\s*([KMB]?)$/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    if (!Number.isFinite(value)) return 0;
    const unit = match[2] || '';
    return Math.round(value * (TOKEN_UNITS[unit] ?? 1));
  }

  /**
   * 设置全局Token预算上限
   * @param {number} budget - 新的全局预算值，必须为正有限数
   * @returns {number} 设置后的预算值
   * @throws {SessionError} budget无效时抛出
   */
  setGlobalBudget(budget) {
    this.guardShutdown();
    const b = Number(budget);
    if (!Number.isFinite(b) || b <= 0) {
      throw new SessionError('INVALID_BUDGET', 'budget must be a positive finite number');
    }
    this._globalBudget = b;
    return b;
  }

  /**
   * 获取当前全局Token预算上限
   * @returns {number} 全局预算值
   */
  getGlobalBudget() {
    return this._globalBudget;
  }

  /**
   * 列出所有已注册Token使用量的会话标识
   * @returns {string[]} 会话标识数组
   */
  listSessions() {
    return Array.from(this._sessionTokens.keys());
  }

  /**
   * 获取指定会话的Token使用详情，包含已用量、预算、剩余量和占比
   * @param {string} sessionId - 会话标识
   * @param {number} [budget] - 自定义预算值，不传则使用全局预算
   * @returns {{ used: number, budget: number, remaining: number, ratio: number }} 使用详情
   */
  getUsage(sessionId, budget) {
    const b = typeof budget === 'number' && Number.isFinite(budget) ? budget : this._globalBudget;
    const used = this._sessionTokens.get(sessionId) ?? 0;
    const remaining = Math.max(0, b - used);
    return { used, budget: b, remaining, ratio: b > 0 ? used / b : 0 };
  }

  /**
   * 获取Token管理器全局统计信息，包含总使用量、预算占比、最大会话消耗和会话计数
   * @param {number} [budget] - 自定义预算值，不传则使用全局预算
   * @returns {{ total: number, budget: number, ratio: number, maxSession: number, activeSessions: number, totalSessions: number }} 统计数据
   */
  getStats(budget) {
    try { this.guardShutdown(); } catch (_e) { debug('TokenManager', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); const b = typeof budget === 'number' && Number.isFinite(budget) ? budget : this._globalBudget; return { total: 0, budget: b, ratio: 0, maxSession: 0, activeSessions: 0, totalSessions: 0 }; }
    const b = typeof budget === 'number' && Number.isFinite(budget) ? budget : this._globalBudget;
    let total = 0;
    let max = 0;
    let activeCount = 0;
    for (const [, tokens] of this._sessionTokens) {
      total += tokens;
      if (tokens > max) max = tokens;
      if (tokens > 0) activeCount++;
    }
    return {
      total,
      budget: b,
      ratio: b > 0 ? total / b : 0,
      maxSession: max,
      activeSessions: activeCount,
      totalSessions: this._sessionTokens.size,
    };
  }

  _onShutdown() {
    this._sessionTokens.clear();
    this._sessionBreakdowns.clear();
    this.removeAllListeners();
  }
}

TokenManager.TOKEN_UNITS = TOKEN_UNITS;

module.exports = withShutdown(TokenManager);
