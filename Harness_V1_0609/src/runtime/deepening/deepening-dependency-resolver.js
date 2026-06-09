'use strict';
const DeepeningBase = require('./deepening-base');
const { HarnessError, DeepeningError } = require('../../errors');

/**
 * @module runtime/deepening/deepening-dependency-resolver
 * 深化推理依赖解析器。基于有向图的依赖解析，支持环检测、
 * 拓扑排序执行顺序计算及传递性依赖解析。
 */

/**
 * 深化推理依赖解析器 — 深化节点的有向图依赖解析。
 * 维护前向和反向邻接表以高效查询依赖和被依赖关系，
 * 通过 DFS 检测环、计算拓扑执行顺序，并支持带深度限制的传递性依赖解析。
 *
 * @classdesc 深化依赖解析器。依赖图构建、循环检测、拓扑排序。
 * @extends DeepeningBase
 * @emits 'dependency' 当添加依赖边时触发，附带 { from, to }
 */
class DeepeningDependencyResolver extends DeepeningBase {

  /**
   * 创建 DeepeningDependencyResolver 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxNodes=500] - 最大节点数
   */
  constructor() {
    super();
    this._nodes = new Map();
    this._forwardAdj = new Map();
    this._reverseAdj = new Map();
    this._maxNodes = 500;
    this._edgeCount = 0;
    this._cycleCountCache = null;
    this._graphDirty = true;
  }

  /**
   * 添加节点到依赖图。
   * @param {string} id - 节点标识
   * @param {*} [data] - 节点关联数据
   * @returns {boolean} 添加是否成功
   * @throws {DeepeningError} id 为空时抛出
   */
  addNode(id, data) {
    this.guardShutdown();
    if (!id) throw new DeepeningError('MISSING_PARAMETER', 'Node id is required');
    if (this._nodes.size >= this._maxNodes && !this._nodes.has(id)) {
      const oldest = this._nodes.keys().next().value;
      this.removeNode(oldest);
    }
    this._nodes.set(id, { id, data, dependents: [] });
    if (!this._forwardAdj.has(id)) this._forwardAdj.set(id, new Set());
    if (!this._reverseAdj.has(id)) this._reverseAdj.set(id, new Set());
    this._graphDirty = true;
    return true;
  }

  /**
   * 从依赖图中移除节点，同时移除所有关联的依赖边。
   * @param {string} id - 节点标识
   * @returns {boolean} 移除结果
   */
  removeNode(id) {
    this._nodes.delete(id);
    const fwdDeps = this._forwardAdj.get(id);
    if (fwdDeps) {
      this._edgeCount -= fwdDeps.size;
      for (const to of fwdDeps) {
        const rev = this._reverseAdj.get(to);
        if (rev) rev.delete(id);
      }
      this._forwardAdj.delete(id);
    }
    const revDeps = this._reverseAdj.get(id);
    if (revDeps) {
      for (const from of revDeps) {
        const fwd = this._forwardAdj.get(from);
        if (fwd && fwd.delete(id)) this._edgeCount--;
      }
      this._reverseAdj.delete(id);
    }
    for (const [, node] of this._nodes) {
      node.dependents = node.dependents.filter(d => d !== id);
    }
    this._graphDirty = true;
    return true;
  }

  /**
   * 获取节点信息，包含实时计算的依赖者列表。
   * @param {string} id - 节点标识
   * @returns {Object|null} 节点对象 { id, data, dependents }，不存在时返回 null
   */
  getNode(id) {
    const node = this._nodes.get(id);
    if (!node) return null;
    node.dependents = this.getDependents(id);
    return node;
  }

  /**
   * 添加依赖边（from 依赖 to）。
   * @param {string} from - 依赖方节点标识
   * @param {string} to - 被依赖方节点标识
   * @returns {boolean} 添加是否成功
   * @throws {HarnessError} 源节点或目标节点不存在时抛出
   * @emits 'dependency'
   */
  addDependency(from, to) {
    this.guardShutdown();
    if (!this._nodes.has(from)) throw new HarnessError('MISSING_PARAMETER', 'Source node not found: ' + from);
    if (!this._nodes.has(to)) throw new HarnessError('MISSING_PARAMETER', 'Target node not found: ' + to);
    if (from === to) throw new DeepeningError('SELF_DEPENDENCY', 'Self-dependency is not allowed: ' + from);
    const fwd = this._forwardAdj.get(from);
    if (fwd && fwd.has(to)) return true;
    if (fwd) fwd.add(to);
    const rev = this._reverseAdj.get(to);
    if (rev) rev.add(from);
    this._edgeCount++;
    this._graphDirty = true;
    this.emit('dependency', { from, to });
    return true;
  }

  /**
   * 移除依赖边。
   * @param {string} from - 依赖方节点标识
   * @param {string} to - 被依赖方节点标识
   * @returns {boolean} 移除结果
   */
  removeDependency(from, to) {
    const fwd = this._forwardAdj.get(from);
    if (fwd && fwd.delete(to)) {
      this._edgeCount--;
      this._graphDirty = true;
    }
    const rev = this._reverseAdj.get(to);
    if (rev) rev.delete(from);
    return true;
  }

  /**
   * 获取节点的直接依赖列表（前向邻接）。
   * @param {string} id - 节点标识
   * @returns {string[]} 依赖节点标识数组
   */
  getDependencies(id) {
    const adj = this._forwardAdj.get(id);
    return adj ? Array.from(adj) : [];
  }

  /**
   * 获取节点的直接被依赖列表（反向邻接）。
   * @param {string} id - 节点标识
   * @returns {string[]} 被依赖节点标识数组
   */
  getDependents(id) {
    const adj = this._reverseAdj.get(id);
    return adj ? Array.from(adj) : [];
  }

  /**
   * 通过 DFS 检测依赖图中的环。
   * @param {number} [maxDepth=1000] - 最大搜索深度
   * @returns {Array<string[]>} 环数组，每个环为包含环起始节点的数组
   */
  detectCycles(maxDepth) {
    const limit = maxDepth ?? 1000;
    const visited = new Set();
    const stack = new Set();
    const cycles = [];
    const visit = (node, depth) => {
      if (depth > limit) { visited.add(node); return; }
      if (stack.has(node)) { cycles.push([node]); return; }
      if (visited.has(node)) return;
      visited.add(node);
      stack.add(node);
      const adj = this._forwardAdj.get(node);
      if (adj) for (const dep of adj) visit(dep, depth + 1);
      stack.delete(node);
    };
    for (const [id] of this._nodes) visit(id, 0);
    return cycles;
  }

  /**
   * 拓扑排序。存在环时抛出异常。
   * @returns {string[]} 拓扑排序后的节点标识数组
   * @throws {HarnessError} 存在环时抛出
   */
  topologicalSort() {
    if (this._getCycleCount() > 0) throw new HarnessError('DEPENDENCY_CYCLE', 'cycle detected');
    const inDegree = new Map();
    for (const [id] of this._nodes) {
      inDegree.set(id, this._forwardAdj.get(id)?.size ?? 0);
    }
    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }
    const sorted = [];
    while (queue.length > 0) {
      const node = queue.shift();
      sorted.push(node);
      const reverseAdj = this._reverseAdj.get(node);
      if (reverseAdj) {
        for (const dep of reverseAdj) {
          const newDeg = (inDegree.get(dep) ?? 0) - 1;
          inDegree.set(dep, newDeg);
          if (newDeg === 0) queue.push(dep);
        }
      }
    }
    return sorted;
  }

  /**
   * 获取执行顺序。等同于 topologicalSort。
   * @returns {string[]} 拓扑排序后的节点标识数组
   */
  getExecutionOrder() { return this.topologicalSort(); }

  /**
   * 获取传递性依赖列表。通过递归遍历前向邻接表收集所有间接依赖。
   * @param {string} id - 节点标识
   * @param {number} [depth=10] - 最大递归深度
   * @returns {string[]} 传递性依赖节点标识数组
   */
  getTransitiveDependencies(id, depth) {
    const result = new Set();
    const maxDepth = depth !== undefined ? depth : 10;
    const visit = (node, d) => {
      const adj = this._forwardAdj.get(node);
      if (!adj) return;
      for (const dep of adj) {
        if (result.has(dep)) continue;
        result.add(dep);
        if (d > 1) visit(dep, d - 1);
      }
    };
    visit(id, maxDepth);
    return Array.from(result);
  }

  /**
   * 获取缓存的环计数。图变更时重新计算。
   * @returns {number} 环的数量
   * @private
   */
  _getCycleCount() {
    if (this._graphDirty) {
      this._cycleCountCache = this.detectCycles().length;
      this._graphDirty = false;
    }
    return this._cycleCountCache;
  }

  /**
   * 获取依赖解析器运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalNodes - 节点总数
   * @returns {number} return.nodes - 节点总数（别名）
   * @returns {number} return.totalEdges - 边总数
   * @returns {number} return.edges - 边总数（别名）
   * @returns {number} return.cycles - 环数量
   */
  getStats() {
    return { totalNodes: this._nodes.size, nodes: this._nodes.size, totalEdges: this._edgeCount, edges: this._edgeCount, cycles: this._getCycleCount(), ...super.getStats() };
  }

  /**
   * 关闭时的清理回调。清空所有节点和邻接表。
   * @protected
   */
  _onShutdown() {
    this._nodes.clear();
    this._forwardAdj.clear();
    this._reverseAdj.clear();
    super._onShutdown();
  }
}

module.exports = DeepeningDependencyResolver;
