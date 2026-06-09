'use strict';

/**
 * @module runtime/infrastructure/browser-session-reuse
 * 浏览器会话复用器，融合自OpenCLI"Chrome Bridge浏览器会话复用"概念。
 *
 * OpenCLI核心洞察：无需修改网站源码，直接复用浏览器中已登录的账号状态，
 * 生成网页操作的CLI命令。AI可直接替用户发视频、发弹幕、搜索内容等。
 *
 * 本模块填补Harness的关键差距：虽然MCPClient已声明OpenCLI集成，
 * BrowserUseAdapter已支持CDP直连，但缺少独立的Cookie/Session持久化
 * 与注入模块。本模块实现：
 * - 从已有Chrome Profile提取Cookie和Session数据
 * - 持久化存储到.harness/browser-sessions/
 * - 注入到新的浏览器实例实现会话复用
 * - 会话健康检查与自动刷新
 */

const fs = require('fs');
const path = require('path');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-call');
const BoundedMap = require('../../utils/bounded-map');
const EventEmitter = require('events');

/**
 * 会话状态
 */
const SESSION_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  INVALID: 'invalid',
  UNKNOWN: 'unknown',
};

const DEFAULT_OPTIONS = {
  sessionsDir: '.harness/browser-sessions',
  maxSessions: 50,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  autoCleanup: true,
  cleanupIntervalMs: 30 * 60 * 1000,
};

/**
 * 浏览器会话复用器，融合自OpenCLI的"Chrome Bridge浏览器会话复用"概念。
 *
 * 核心原则：
 * - 复用已有浏览器会话，避免重复登录
 * - Cookie/Session数据持久化，进程重启后可恢复
 * - 会话健康检查，自动标记过期会话
 * - 与BrowserUseAdapter/CDPClient无缝集成
 *
 * @classdesc 浏览器会话复用器。Cookie持久化、会话注入、健康检查。
 * @extends EventEmitter
 */
class BrowserSessionReuse extends EventEmitter {

  /**
   * 创建BrowserSessionReuse实例。
   * @param {Object} [options] - 配置选项
   * @param {string} [options.sessionsDir='.harness/browser-sessions'] - 会话存储目录
   * @param {number} [options.maxSessions=50] - 最大会话数
   * @param {number} [options.sessionTtlMs=86400000] - 会话TTL(毫秒)
   * @param {boolean} [options.autoCleanup=true] - 是否自动清理过期会话
   * @param {number} [options.cleanupIntervalMs=1800000] - 清理间隔(毫秒)
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._sessions = new BoundedMap(this._options.maxSessions);
    this._cleanupTimer = null;
    this._stats = { sessionsCreated: 0, sessionsReused: 0, sessionsExpired: 0, cookiesExtracted: 0 };

    if (this._options.autoCleanup) {
      this._cleanupTimer = setInterval(this._cleanupExpired.bind(this), this._options.cleanupIntervalMs);
      if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref();
    }
  }

  /**
   * 从CDP客户端提取会话数据，融合自OpenCLI的"复用已登录账号状态"概念。
   * @param {string} sessionId - 会话标识（通常为域名）
   * @param {Object} cdpClient - CDP客户端实例
   * @returns {Promise<{ sessionId: string, status: string, cookieCount: number }>} 提取结果
   */
  async extractFromCDP(sessionId, cdpClient) {
    this.guardShutdown();
    if (!sessionId || !cdpClient) return { sessionId: sessionId || null, status: SESSION_STATUS.INVALID, cookieCount: 0 };

    try {
      const cookies = await cdpClient.send('Network.getAllCookies');
      const cookieList = (cookies && cookies.cookies) ?? [];

      const sessionData = {
        id: sessionId,
        cookies: cookieList,
        extractedAt: Date.now(),
        expiresAt: Date.now() + this._options.sessionTtlMs,
        status: SESSION_STATUS.ACTIVE,
        source: 'cdp',
      };

      this._sessions.set(sessionId, sessionData);
      this._stats.sessionsCreated++;
      this._stats.cookiesExtracted += cookieList.length;

      // 持久化
      this._persistSession(sessionId, sessionData);

      this.emit('session-extracted', { sessionId, cookieCount: cookieList.length });
      return { sessionId, status: SESSION_STATUS.ACTIVE, cookieCount: cookieList.length };
    } catch (_err) {
      return { sessionId, status: SESSION_STATUS.INVALID, cookieCount: 0 };
    }
  }

  /**
   * 注入会话数据到CDP客户端，实现会话复用。
   * @param {string} sessionId - 会话标识
   * @param {Object} cdpClient - CDP客户端实例
   * @returns {Promise<{ sessionId: string, injected: boolean, cookieCount: number }>} 注入结果
   */
  async injectToCDP(sessionId, cdpClient) {
    this.guardShutdown();
    if (!sessionId || !cdpClient) return { sessionId: sessionId || null, injected: false, cookieCount: 0 };

    const sessionData = this._sessions.get(sessionId);
    if (!sessionData || !sessionData.cookies || sessionData.cookies.length === 0) {
      return { sessionId, injected: false, cookieCount: 0 };
    }

    // 检查过期
    if (sessionData.expiresAt && Date.now() > sessionData.expiresAt) {
      sessionData.status = SESSION_STATUS.EXPIRED;
      this._stats.sessionsExpired++;
      return { sessionId, injected: false, cookieCount: 0 };
    }

    try {
      await cdpClient.send('Network.setCookies', { cookies: sessionData.cookies });
      this._stats.sessionsReused++;
      this.emit('session-injected', { sessionId, cookieCount: sessionData.cookies.length });
      return { sessionId, injected: true, cookieCount: sessionData.cookies.length };
    } catch (_err) {
      return { sessionId, injected: false, cookieCount: 0 };
    }
  }

  /**
   * 检查会话健康状态。
   * @param {string} sessionId - 会话标识
   * @returns {{ sessionId: string, status: string, age: number }} 健康检查结果
   */
  checkHealth(sessionId) {
    this.guardShutdown();
    const sessionData = this._sessions.get(sessionId);
    if (!sessionData) return { sessionId, status: SESSION_STATUS.UNKNOWN, age: 0 };

    const age = Date.now() - sessionData.extractedAt;
    if (sessionData.expiresAt && Date.now() > sessionData.expiresAt) {
      sessionData.status = SESSION_STATUS.EXPIRED;
      this._stats.sessionsExpired++;
      return { sessionId, status: SESSION_STATUS.EXPIRED, age };
    }

    return { sessionId, status: sessionData.status || SESSION_STATUS.ACTIVE, age };
  }

  /**
   * 获取会话数据。
   * @param {string} sessionId - 会话标识
   * @returns {Object|null} 会话数据
   */
  getSession(sessionId) {
    return this._sessions.get(sessionId) ?? null;
  }

  /**
   * 列出所有会话。
   * @returns {Array<Object>} 会话列表
   */
  listSessions() {
    const result = [];
    for (const [id, data] of this._sessions) {
      result.push({
        id,
        status: data.status,
        cookieCount: data.cookies ? data.cookies.length : 0,
        extractedAt: data.extractedAt,
        expiresAt: data.expiresAt,
        source: data.source,
      });
    }
    return result;
  }

  /**
   * 删除会话。
   * @param {string} sessionId - 会话标识
   * @returns {boolean} 是否删除成功
   */
  deleteSession(sessionId) {
    const deleted = this._sessions.delete(sessionId);
    if (deleted) {
      safeCall(function() {
        const filePath = path.join(this._options.sessionsDir, sessionId + '.json');
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }.bind(this), 'BrowserSessionReuse', 'delete');
    }
    return deleted;
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      sessionsCreated: this._stats.sessionsCreated,
      sessionsReused: this._stats.sessionsReused,
      sessionsExpired: this._stats.sessionsExpired,
      cookiesExtracted: this._stats.cookiesExtracted,
      activeSessions: this._sessions.size,
    };
  }

  /**
   * 持久化会话数据到磁盘。
   * @param {string} sessionId - 会话标识
   * @param {Object} data - 会话数据
   * @private
   */
  _persistSession(sessionId, data) {
    safeCall(function() {
      if (!fs.existsSync(this._options.sessionsDir)) {
        fs.mkdirSync(this._options.sessionsDir, { recursive: true });
      }
      const filePath = path.join(this._options.sessionsDir, sessionId + '.json');
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }.bind(this), 'BrowserSessionReuse', 'persist');
  }

  /**
   * 清理过期会话。
   * @private
   */
  _cleanupExpired() {
    if (this._shutDown) return;
    const now = Date.now();
    for (const [id, data] of this._sessions) {
      if (data.expiresAt && now > data.expiresAt) {
        data.status = SESSION_STATUS.EXPIRED;
        this._stats.sessionsExpired++;
        this.emit('session-expired', { sessionId: id });
      }
    }
  }

  _onShutdown() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._sessions.clear();
    this.removeAllListeners();
  }
}

BrowserSessionReuse.SESSION_STATUS = SESSION_STATUS;

module.exports = withShutdown(BrowserSessionReuse);
