'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * @module runtime/infrastructure/platform-coordinator
 * PlatformCoordinator — 平台协调器
 * 跨平台消息路由和转发协调器。管理平台注册、有向路由图构建、
 * 环路检测、消息发送和广播。路由支持消息过滤器，发送时自动沿路由链转发。
 * @classdesc 平台协调器。跨平台适配、环境检测
 * @extends EventEmitter
 */
class PlatformCoordinator extends EventEmitter {
  constructor() {
    super();
    this._platforms = new Map();
    this._maxPlatforms = 50;
    this._routes = [];
    this._routeIndex = new Map();
    this._routesBySource = new Map();
  }

  /**
   * 注册平台。每个平台需提供唯一的标识符和消息发送函数。超过最大平台数时注册失败。
   * @param {string} platformId - 平台标识符，不能为空
   * @param {Function} sender - 消息发送函数，签名为 (message: *) => Promise<*>
   * @returns {boolean} 注册成功返回 true，参数无效或达到上限时返回 false
   */
  registerPlatform(platformId, sender) {
    this.guardShutdown();
    if (!platformId || typeof sender !== 'function') {
      return false;
    }
    if (!this._platforms.has(platformId) && this._platforms.size >= this._maxPlatforms) {
      debug('PlatformCoordinator', 'registerPlatform', 'Max platforms reached: ' + this._maxPlatforms);
      return false;
    }
    this._platforms.set(platformId, {
      id: platformId,
      sender,
      registeredAt: new Date().toISOString(),
    });
    this.emit('platform-registered', { platformId });
    return true;
  }

  /**
   * 注销平台。同时移除该平台作为源和目标的所有路由。
   * @param {string} platformId - 要注销的平台标识符
   * @returns {boolean} 注销成功返回 true，平台不存在时返回 false
   */
  unregisterPlatform(platformId) {
    this.guardShutdown();
    const existed = this._platforms.delete(platformId);
    if (existed) {
      const sourceRoutes = this._routesBySource.get(platformId);
      if (sourceRoutes) {
        for (const route of sourceRoutes) {
          this._routeIndex.delete(route.from + '->' + route.to);
          const idx = this._routes.indexOf(route);
          if (idx !== -1) this._routes.splice(idx, 1);
        }
        this._routesBySource.delete(platformId);
      }
      for (let i = this._routes.length - 1; i >= 0; i--) {
        if (this._routes[i].to === platformId) {
          const r = this._routes[i];
          this._routeIndex.delete(r.from + '->' + r.to);
          const srcRoutes = this._routesBySource.get(r.from);
          if (srcRoutes) {
            const idx = srcRoutes.indexOf(r);
            if (idx !== -1) srcRoutes.splice(idx, 1);
          }
          this._routes.splice(i, 1);
        }
      }
      this.emit('platform-unregistered', { platformId });
    }
    return existed;
  }

  /**
   * 添加平台间路由。自动检测环路，不允许自路由和重复路由。支持可选的消息过滤器。
   * @param {string} fromPlatform - 源平台标识符
   * @param {string} toPlatform - 目标平台标识符
   * @param {Function} [filter] - 消息过滤函数，签名为 (message: *) => boolean，返回 true 时才转发
   * @returns {boolean} 添加成功返回 true，平台不存在、自路由、重复或存在环路时返回 false
   */
  addRoute(fromPlatform, toPlatform, filter) {
    this.guardShutdown();
    if (!this._platforms.has(fromPlatform) || !this._platforms.has(toPlatform)) {
      return false;
    }
    if (fromPlatform === toPlatform) return false;
    const routeKey = fromPlatform + '->' + toPlatform;
    if (this._routeIndex.has(routeKey)) return false;
    if (this._wouldCreateRouteCycle(fromPlatform, toPlatform)) return false;
    this._routes.push({ from: fromPlatform, to: toPlatform, filter: filter ?? null });
    this._routeIndex.set(routeKey, true);
    if (!this._routesBySource.has(fromPlatform)) this._routesBySource.set(fromPlatform, []);
    this._routesBySource.get(fromPlatform).push(this._routes[this._routes.length - 1]);
    this.emit('route-added', { from: fromPlatform, to: toPlatform });
    return true;
  }

  removeRoute(fromPlatform, toPlatform) {
    this.guardShutdown();
    const routeKey = fromPlatform + '->' + toPlatform;
    if (!this._routeIndex.has(routeKey)) return false;
    this._routeIndex.delete(routeKey);
    const routeIdx = this._routes.findIndex(r => r.from === fromPlatform && r.to === toPlatform);
    if (routeIdx !== -1) this._routes.splice(routeIdx, 1);
    const srcRoutes = this._routesBySource.get(fromPlatform);
    if (srcRoutes) {
      const idx = srcRoutes.findIndex(r => r.from === fromPlatform && r.to === toPlatform);
      if (idx !== -1) srcRoutes.splice(idx, 1);
      if (srcRoutes.length === 0) this._routesBySource.delete(fromPlatform);
    }
    this.emit('route-removed', { from: fromPlatform, to: toPlatform });
    return true;
  }

  _wouldCreateRouteCycle(fromPlatform, toPlatform) {
    const visited = new Set();
    const queue = [toPlatform];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === fromPlatform) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const route of this._routes) {
        if (route.from === current) {
          queue.push(route.to);
        }
      }
    }
    return false;
  }

  /**
   * 向指定平台发送消息。发送成功后自动沿路由链转发到目标平台。
   * @param {string} platformId - 目标平台标识符
   * @param {*} message - 要发送的消息
   * @returns {Promise<{success: boolean, result?: *, reason?: string}>} 发送结果
   */
  async send(platformId, message) {
    this.guardShutdown();
    const platform = this._platforms.get(platformId);
    if (!platform) {
      this.emit('send-failed', { platformId, reason: 'Platform not found' });
      return { success: false, reason: 'Platform not found' };
    }

    try {
      const result = await platform.sender(message);
      this.emit('message-sent', { platformId, message });
      this._forwardToRoutes(platformId, message).catch(function(err) {
        debug('PlatformCoordinator', 'forwardError', err && err.message ? err.message : String(err));
      });
      return { success: true, result };
    } catch (err) {
      this.emit('send-failed', { platformId, reason: err && err.message ? err.message : String(err) });
      return { success: false, reason: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 向所有已注册平台广播消息，可排除指定平台。使用 Promise.allSettled 并行发送，单个失败不影响其他平台。
   * @param {*} message - 要广播的消息
   * @param {string} [excludePlatform] - 要排除的平台标识符
   * @returns {Promise<Array<{platformId: string, success: boolean, result?: *, reason?: string}>>} 各平台的发送结果数组
   */
  async broadcast(message, excludePlatform) {
    this.guardShutdown();
    try {
      const promises = [];
      for (const [id, platform] of this._platforms) {
        if (id === excludePlatform) continue;
        promises.push(
          platform.sender(message)
            .then(result => ({ platformId: id, success: true, result }))
            .catch(err => ({ platformId: id, success: false, error: err && err.message ? err.message : String(err) })),
        );
      }
      const results = await Promise.allSettled(promises);
      const settled = results.map(r => r.status === 'fulfilled' ? r.value : { success: false, reason: r.reason });
      this.emit('broadcast', { message, results: settled });
      return settled;
    } catch (err) {
      debug('PlatformCoordinator', 'broadcast', err && err.message ? err.message : String(err));
      return [];
    }
  }

  async _forwardToRoutes(fromPlatform, message) {
    const matchingRoutes = this._routesBySource.get(fromPlatform) ?? [];
    for (const route of matchingRoutes) {
      if (route.filter && !route.filter(message)) continue;
      const target = this._platforms.get(route.to);
      if (target) {
        try {
          await target.sender(message);
          this.emit('message-forwarded', { from: fromPlatform, to: route.to });
        } catch (err) {
          this.emit('forward-failed', { from: fromPlatform, to: route.to, reason: err && err.message ? err.message : String(err) });
        }
      }
    }
  }

  /**
   * 获取所有已注册平台的标识符列表。
   * @returns {string[]} 平台标识符数组
   */
  getPlatforms() {
    return Array.from(this._platforms.keys());
  }

  /**
   * 获取所有路由配置的副本。
   * @returns {Array<{from: string, to: string, filter: Function|null}>} 路由配置数组
   */
  getRoutes() {
    return this._routes.slice();
  }

  /**
   * 获取平台协调器的运行统计数据。
   * @returns {{platformCount: number, routeCount: number}} 统计信息对象
   */
  getStats() {
    return {
      platformCount: this._platforms.size,
      routeCount: this._routes.length,
    };
  }

  _onShutdown() {
    this._platforms.clear();
    this._routes = [];
    this._routeIndex.clear();
    this._routesBySource.clear();
    this.removeAllListeners();
  }

}

PlatformCoordinator = withShutdown(PlatformCoordinator);

module.exports = PlatformCoordinator;
