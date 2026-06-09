'use strict';

/**
 * @module runtime/deepening/deepening-service-registry
 * 深化推理服务注册中心。管理服务生命周期与状态转换（starting/healthy/unhealthy/degraded），
 * 基于心跳的健康晋升、标签和状态查询，以及注销时的索引清理。
 */

const DeepeningBase = require('./deepening-base');
const { requireString_ } = require('../../utils/param-validator');
const safeAssign = require('../../utils/safe-assign');
const { HarnessError } = require('../../errors');

/**
 * 深化推理服务注册中心。管理服务生命周期与状态转换（starting/healthy/unhealthy/degraded），
 * 基于心跳的健康晋升、标签和状态查询，以及注销时的索引清理。
 *
 * @classdesc 深化服务注册。服务发现、健康检查、负载路由。
 * @extends DeepeningBase
 */
class DeepeningServiceRegistry extends DeepeningBase {
  /** @constant {Object} 服务状态枚举 */
  static SERVICE_STATES = { HEALTHY: 'healthy', UNHEALTHY: 'unhealthy', DEGRADED: 'degraded', STARTING: 'starting' };

  /**
   *创建 DeepeningServiceRegistry 实例。
   * @param {Object} [options] - 配置选项
   */
  constructor(options) {
    super(options);
    this._services = new Map();
    this._maxServices = (options && options.maxServices) ?? 200;
    this._byState = {};
    this._byTag = {};
    this._totalRegistered = 0;
  }

  /**
   * 注册服务。初始状态为 starting，支持标签索引。
   * @param {string} name - 服务名称
   * @param {Object} [config] - 服务配置
   * @param {string[]} [config.tags] - 服务标签数组
   * @param {string} [config.version] - 服务版本
   * @param {number} [config.port] - 服务端口
   * @returns {Object} 注册后的服务对象
   * @emits 'registered' 当服务注册成功时触发
   */
  register(name, config) {
    this.guardShutdown();
    requireString_(name, 'Service name');
    if (this._services.size >= this._maxServices && !this._services.has(name)) {
      throw new HarnessError('CAPACITY_EXCEEDED', 'Service registry full: max ' + this._maxServices);
    }
    const cfg = config ?? {};
    const svc = safeAssign({ name, state: 'starting', lastHeartbeat: Date.now() }, cfg);
    this._services.set(name, svc);
    this._byState.starting = (this._byState.starting ?? 0) + 1;
    if (cfg.tags && Array.isArray(cfg.tags)) {
      for (const tag of cfg.tags) {
        if (!this._byTag[tag]) this._byTag[tag] = new Set();
        this._byTag[tag].add(name);
      }
    }
    this._totalRegistered++;
    this.emit('registered', { name, version: cfg.version, port: cfg.port });
    return svc;
  }

  /**
   * 获取指定名称的服务对象。
   * @param {string} name - 服务名称
   * @returns {Object|null} 服务对象，未找到返回 null
   */
  getService(_name) { const svc = this._services.get(_name); return svc ? { ...svc } : null; }

  /**
   * 获取所有已注册服务名称列表。
   * @returns {string[]} 服务名称数组
   */
  getServiceNames() { return Array.from(this._services.keys()); }

  /**
   * 发送心跳。更新服务最后心跳时间，starting 状态自动晋升为 healthy。
   * @param {string} name - 服务名称
   * @returns {boolean} 心跳成功返回 true
   * @throws {HarnessError} 服务不存在时抛出异常
   * @emits 'heartbeat' 当心跳成功时触发
   */
  heartbeat(name) {
    this.guardShutdown();
    const svc = this._services.get(name);
    if (!svc) throw new HarnessError('RESOURCE_NOT_FOUND', 'Service not found: ' + name);
    svc.lastHeartbeat = Date.now();
    if (svc.state === 'starting') {
      this._byState.starting = Math.max(0, (this._byState.starting ?? 0) - 1);
      if (this._byState.starting === 0) delete this._byState.starting;
      svc.state = 'healthy';
      this._byState.healthy = (this._byState.healthy ?? 0) + 1;
    }
    this.emit('heartbeat', { name });
    return true;
  }

  /**
   * 内部状态变更方法。更新状态计数索引并发出状态变更事件。
   * @param {string} name - 服务名称
   * @param {string} newState - 新状态
   * @returns {boolean} 变更成功返回 true，服务不存在返回 false
   * @emits 'stateChanged' 当服务状态变更时触发
   * @private
   */
  _changeState(name, newState) {
    const svc = this._services.get(name);
    if (!svc) return false;
    const from = svc.state;
    this._byState[from] = Math.max(0, (this._byState[from] ?? 0) - 1);
    if (this._byState[from] === 0) delete this._byState[from];
    svc.state = newState;
    this._byState[newState] = (this._byState[newState] ?? 0) + 1;
    this.emit('stateChanged', { from, to: newState });
    return true;
  }

  /**
   * 将服务标记为不健康状态。
   * @param {string} name - 服务名称
   * @returns {boolean} 标记成功返回 true
   */
  markUnhealthy(name) { return this._changeState(name, 'unhealthy'); }

  /**
   * 将服务标记为降级状态。
   * @param {string} name - 服务名称
   * @returns {boolean} 标记成功返回 true
   */
  markDegraded(name) { return this._changeState(name, 'degraded'); }

  /**
   * 将服务标记为健康状态。
   * @param {string} name - 服务名称
   * @returns {boolean} 标记成功返回 true
   */
  markHealthy(name) { return this._changeState(name, 'healthy'); }

  /**
   * 按标签查询服务列表。
   * @param {string} tag - 服务标签
   * @returns {Object[]} 匹配标签的服务对象数组
   */
  getServicesByTag(tag) {
    const names = this._byTag[tag];
    if (!names) return [];
    return Array.from(names).flatMap(n => { const s = this._services.get(n); return s ? [s] : []; });
  }
  /**
   * 按状态查询服务列表。
   * @param {string} state - 服务状态
   * @returns {Object[]} 匹配状态的服务对象数组
   */
  getServicesByState(state) {
    const result = [];
    for (const s of this._services.values()) { if (s.state === state) result.push(s); }
    return result;
  }

  /**
   * 注销服务。清理状态计数和标签索引。
   * @param {string} name - 服务名称
   * @returns {boolean} 注销成功返回 true，服务不存在返回 false
   * @emits 'deregistered' 当服务注销时触发
   */
  deregister(name) {
    this.guardShutdown();
    if (!this._services.has(name)) return false;
    const svc = this._services.get(name);
    this._byState[svc.state] = Math.max(0, (this._byState[svc.state] ?? 0) - 1);
    if (this._byState[svc.state] === 0) delete this._byState[svc.state];
    if (svc.tags && Array.isArray(svc.tags)) {
      for (const tag of svc.tags) {
        const set = this._byTag[tag];
        if (set) { set.delete(name); if (set.size === 0) delete this._byTag[tag]; }
      }
    }
    this._services.delete(name);
    this.emit('deregistered', { name });
    return true;
  }

  /**
   * 获取服务注册中心统计信息。
   * @returns {Object} 统计对象，包含 totalServices、totalRegistered、byState 等
   */
  getStats() {
    return { totalServices: this._services.size, totalRegistered: this._totalRegistered, byState: { ...this._byState }, ...super.getStats() };
  }

  /**
   * 关闭时清理所有服务注册状态。
   * @protected
   */
  _onShutdown() {
    this._services.clear();
    this._byState = {};
    this._byTag = {};
    super._onShutdown();
  }
}

module.exports = DeepeningServiceRegistry;
