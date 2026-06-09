'use strict';
const DeepeningBase = require('./deepening-base');
const { requireString_ } = require('../../utils/param-validator');
const { HarnessError } = require('../../errors');

/**
 * @module runtime/deepening/deepening-load-balancer
 * 多策略负载均衡器。使用轮询、加权随机、最少连接和随机选择四种策略，
 * 在命名实例池中分配工作负载，追踪实例健康状态和活跃连接数，
 * 支持动态实例增删及不健康实例自动排除。
 */

/**
 * 多策略负载均衡器 — 为深化管道提供跨实例池的工作负载分配能力。
 * 支持四种负载均衡策略：轮询（round_robin）、加权随机（weighted）、
 * 最少连接（least_connections）和随机选择（random）。追踪实例健康状态
 * 和活跃连接数，支持动态实例增删及不健康实例自动排除。
 *
 * @classdesc 深化负载均衡器。轮询/最少连接/加权策略。
 * @extends DeepeningBase
 * @emits 'poolCreated' 当实例池创建时触发，附带 {name, strategy}
 * @emits 'instanceAdded' 当实例添加时触发，附带 {instance, weight}
 * @emits 'selected' 当实例被选中时触发，附带 {pool, instance}
 * @emits 'noHealthyInstance' 当无健康实例可用时触发，附带 {pool}
 * @emits 'instanceHealthChanged' 当实例健康状态变更时触发，附带 {instance, healthy}
 * @emits 'instanceRemoved' 当实例被移除时触发，附带 {instance}
 * @emits 'poolRemoved' 当实例池被移除时触发，附带 {name}
 */
class DeepeningLoadBalancer extends DeepeningBase {
  /**
   * 负载均衡策略枚举。
   * @constant {Object}
   * @property {string} ROUND_ROBIN - 轮询策略
   * @property {string} WEIGHTED - 加权随机策略
   * @property {string} LEAST_CONNECTIONS - 最少连接策略
   * @property {string} RANDOM - 随机选择策略
   */
  static STRATEGIES = { ROUND_ROBIN: 'round_robin', WEIGHTED: 'weighted', LEAST_CONNECTIONS: 'least_connections', RANDOM: 'random' };

  /**
   * 创建 DeepeningLoadBalancer 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxPools=50] - 最大实例池数
   */
  constructor() {
    super();
    this._pools = new Map();
    this._maxPools = 50;
    this._rrIndex = new Map();
    this._totalSelected = 0;
  }

  /**
   * 创建命名实例池。
   * @param {string} name - 池名称
   * @param {Object} [options] - 池配置选项
   * @param {string} [options.strategy='round_robin'] - 负载均衡策略
   * @returns {boolean} 创建成功返回 true，池已存在返回 false
   * @emits 'poolCreated' 池创建成功时触发，附带 {name, strategy}
   */
  createPool(name, options) {
    this.guardShutdown();
    requireString_(name, 'Pool name');
    if (this._pools.has(name)) return false;
    if (this._pools.size >= this._maxPools) {
      const oldest = this._pools.keys().next().value;
      this._pools.delete(oldest);
      this._rrIndex.delete(oldest);
    }
    const opts = options ?? {};
    this._pools.set(name, { name, strategy: opts.strategy ?? 'round_robin', instances: new Map() });
    this._rrIndex.set(name, 0);
    this.emit('poolCreated', { name, strategy: opts.strategy ?? 'round_robin' });
    return true;
  }

  /**
   * 获取所有实例池名称。
   * @returns {Array<string>} 池名称数组
   */
  getPoolNames() { return Array.from(this._pools.keys()); }

  /**
   * 向指定池添加实例。
   * @param {string} poolName - 池名称
   * @param {string} instanceId - 实例标识
   * @param {Object} [options] - 实例配置选项
   * @param {number} [options.weight=1] - 实例权重（用于加权策略）
   * @returns {boolean} 添加成功返回 true
   * @throws {HarnessError} 当池不存在时抛出 RESOURCE_NOT_FOUND 异常
   * @throws {HarnessError} 当 instanceId 缺失时抛出 INVALID_INPUT 异常
   * @emits 'instanceAdded' 实例添加成功时触发，附带 {instance, weight}
   */
  addInstance(poolName, instanceId, options) {
    this.guardShutdown();
    const pool = this._pools.get(poolName);
    if (!pool) throw new HarnessError('RESOURCE_NOT_FOUND', 'Pool not found: ' + poolName);
    if (!instanceId) throw new HarnessError('INVALID_INPUT', 'Instance ID is required');
    const opts = options ?? {};
    pool.instances.set(instanceId, { id: instanceId, weight: opts.weight ?? 1, activeConnections: 0, healthy: true });
    this.emit('instanceAdded', { instance: instanceId, weight: opts.weight ?? 1 });
    return true;
  }

  /**
   * 根据池策略选择一个健康实例。
   * @param {string} poolName - 池名称
   * @returns {Object|null} 选中实例 {id, activeConnections}，无可用实例返回 null
   * @emits 'selected' 实例被选中时触发，附带 {pool, instance}
   * @emits 'noHealthyInstance' 无健康实例时触发，附带 {pool}
   */
  select(poolName) {
    this.guardShutdown();
    const pool = this._pools.get(poolName);
    if (!pool || pool.instances.size === 0) { this.emit('noHealthyInstance', { pool: poolName }); return null; }
    const healthy = [];
    for (const i of pool.instances.values()) {
      if (i.healthy) healthy.push(i);
    }
    if (healthy.length === 0) { this.emit('noHealthyInstance', { pool: poolName }); return null; }
    let selected;
    if (pool.strategy === 'round_robin') {
      const idx = this._rrIndex.get(poolName) ?? 0;
      selected = healthy[idx % healthy.length];
      this._rrIndex.set(poolName, idx + 1);
      if (idx + 1 > 1000000) { this._rrIndex.set(poolName, 0); }
    } else if (pool.strategy === 'least_connections') {
      selected = healthy.reduce((a, b) => a.activeConnections <= b.activeConnections ? a : b);
    } else if (pool.strategy === 'weighted') {
      const totalWeight = healthy.reduce((s, i) => s + i.weight, 0);
      if (totalWeight <= 0) {
        selected = healthy[Math.floor(Math.random() * healthy.length)];
      } else {
        let r = Math.random() * totalWeight;
        for (const inst of healthy) { r -= inst.weight; if (r <= 0) { selected = inst; break; } }
        if (!selected) selected = healthy[healthy.length - 1];
      }
    } else {
      selected = healthy[Math.floor(Math.random() * healthy.length)];
    }
    selected.activeConnections++;
    this._totalSelected++;
    this.emit('selected', { pool: poolName, instance: selected.id });
    return { id: selected.id, activeConnections: selected.activeConnections };
  }

  /**
   * 释放指定实例的连接。
   * @param {string} poolName - 池名称
   * @param {string} instanceId - 实例标识
   * @returns {boolean} 释放成功返回 true，池或实例不存在返回 false
   */
  release(poolName, instanceId) {
    this.guardShutdown();
    const pool = this._pools.get(poolName);
    if (!pool) return false;
    const inst = pool.instances.get(instanceId);
    if (inst) inst.activeConnections = Math.max(0, inst.activeConnections - 1);
    return true;
  }

  /**
   * 将指定实例标记为不健康。
   * @param {string} poolName - 池名称
   * @param {string} instanceId - 实例标识
   * @returns {boolean} 标记成功返回 true
   * @emits 'instanceHealthChanged' 实例健康状态变更时触发，附带 {instance, healthy: false}
   */
  markUnhealthy(poolName, instanceId) { if (this._shutDown) return false; const pool = this._pools.get(poolName); if (pool) { const inst = pool.instances.get(instanceId); if (inst) inst.healthy = false; } this.emit('instanceHealthChanged', { instance: instanceId, healthy: false }); return true; }

  /**
   * 将指定实例标记为健康。
   * @param {string} poolName - 池名称
   * @param {string} instanceId - 实例标识
   * @returns {boolean} 标记成功返回 true
   * @emits 'instanceHealthChanged' 实例健康状态变更时触发，附带 {instance, healthy: true}
   */
  markHealthy(poolName, instanceId) { if (this._shutDown) return false; const pool = this._pools.get(poolName); if (pool) { const inst = pool.instances.get(instanceId); if (inst) inst.healthy = true; } this.emit('instanceHealthChanged', { instance: instanceId, healthy: true }); return true; }

  /**
   * 从池中移除指定实例。
   * @param {string} poolName - 池名称
   * @param {string} instanceId - 实例标识
   * @returns {boolean} 移除成功返回 true
   * @emits 'instanceRemoved' 实例被移除时触发，附带 {instance}
   */
  removeInstance(poolName, instanceId) { if (this._shutDown) return false; const pool = this._pools.get(poolName); if (pool) pool.instances.delete(instanceId); this.emit('instanceRemoved', { instance: instanceId }); return true; }

  /**
   * 移除命名实例池。
   * @param {string} name - 池名称
   * @returns {boolean} 移除成功返回 true，池不存在返回 false
   * @emits 'poolRemoved' 池被移除时触发，附带 {name}
   */
  removePool(name) { if (this._shutDown) return false; if (!this._pools.has(name)) return false; this._pools.delete(name); this._rrIndex.delete(name); this.emit('poolRemoved', { name }); return true; }

  /**
   * 获取指定池的详细信息。
   * @param {string} name - 池名称
   * @returns {Object|null} 池信息 {name, strategy, totalInstances, healthyInstances, instances}，池不存在返回 null
   */
  getPoolInfo(name) {
    const pool = this._pools.get(name);
    if (!pool) return null;
    const instances = Array.from(pool.instances.values()).map(i => ({ id: i.id, weight: i.weight, healthy: i.healthy, activeConnections: i.activeConnections }));
    return { name: pool.name, strategy: pool.strategy, totalInstances: instances.length, healthyInstances: instances.reduce((c, i) => c + (i.healthy ? 1 : 0), 0), instances };
  }

  /**
   * 获取负载均衡器的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalPools - 实例池总数
   * @returns {number} return.totalSelected - 累计选中次数
   */
  getStats() { return { totalPools: this._pools.size, totalSelected: this._totalSelected, ...super.getStats() }; }

  /**
   * 关闭时的清理回调。清空所有池和轮询索引。
   * @protected
   */
  _onShutdown() {
    this._pools.clear();
    this._rrIndex.clear();
    super._onShutdown();
  }
}

module.exports = DeepeningLoadBalancer;
