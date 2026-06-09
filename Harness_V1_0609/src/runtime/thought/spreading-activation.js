'use strict';

const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * 扩散激活检索 — 基于 Mnemosyne Spreading Activation 的 Node.js 原生实现
 *
 * 核心原理：联想记忆扩散激活——激活一个概念时，能量沿关联边传播到相邻概念，
 * 激活强度随距离衰减。相比直接匹配，能发现间接关联的概念。
 *
 * 算法：
 * 1. 从查询匹配的种子节点出发，赋予初始能量（1.0）
 * 2. 沿知识图谱的边传播能量，每条边衰减因子 decay（默认0.2）
 * 3. 能量低于阈值（默认0.1）的节点停止传播
 * 4. 按最终激活能量排序返回结果
 */
class SpreadingActivation {
  /**
   * @param {object} options - 配置选项
   * @param {number} [options.decay=0.2] - 每条边的能量衰减率（0-1，0=完全衰减，1=不衰减）
   * @param {number} [options.threshold=0.1] - 激活阈值，低于此值的节点不传播
   * @param {number} [options.maxDepth=5] - 最大传播深度
   * @param {number} [options.maxResults=20] - 最大返回结果数
   */
  constructor(options = {}) {
    this._decay = Math.max(0, Math.min(1, options.decay ?? 0.2));
    this._threshold = Math.max(0, Math.min(1, options.threshold ?? 0.1));
    this._maxDepth = Math.max(1, options.maxDepth ?? 5);
    this._maxResults = Math.max(1, options.maxResults ?? 20);
    this._activationCount = 0;
  }

  /**
   * 在知识图谱上执行扩散激活
   * @param {string[]} seedKeys - 种子节点键列表
   * @param {object} graph - 知识图谱对象，需提供 getNeighbors(key) 方法
   * @returns {Array<{key: string, activation: number, depth: number, path: string[]}>}
   */
  activate(seedKeys, graph) {
    if (!seedKeys || seedKeys.length === 0 || !graph) return [];

    // 激活表：key -> { activation, depth, path }
    const activationTable = new Map();
    // BFS 队列
    const queue = [];

    // 初始化种子节点
    for (const key of seedKeys) {
      if (!key) continue;
      activationTable.set(key, { activation: 1.0, depth: 0, path: [key] });
      queue.push({ key, activation: 1.0, depth: 0 });
    }

    // BFS 扩散
    while (queue.length > 0) {
      const current = queue.shift();

      if (current.depth >= this._maxDepth) continue;
      if (current.activation < this._threshold) continue;

      // 获取邻居节点
      let neighbors = [];
      try {
        neighbors = graph.getNeighbors ? graph.getNeighbors(current.key) : [];
      } catch {
        continue;
      }

      for (const neighbor of neighbors) {
        if (!neighbor || !neighbor.key) continue;

        const propagatedActivation = current.activation * (1 - this._decay);
        if (propagatedActivation < this._threshold) continue;

        const existing = activationTable.get(neighbor.key);
        if (existing) {
          // 取最大激活值
          if (propagatedActivation > existing.activation) {
            existing.activation = propagatedActivation;
            existing.depth = current.depth + 1;
            existing.path = [...current.path, neighbor.key];
          }
        } else {
          activationTable.set(neighbor.key, {
            activation: propagatedActivation,
            depth: current.depth + 1,
            path: [...current.path, neighbor.key],
          });
          queue.push({
            key: neighbor.key,
            activation: propagatedActivation,
            depth: current.depth + 1,
          });
        }
      }
    }

    this._activationCount++;

    // 排序并返回
    const results = Array.from(activationTable.entries())
      .map(([key, data]) => ({ key, ...data }))
      .filter(r => r.activation >= this._threshold)
      .sort((a, b) => b.activation - a.activation)
      .slice(0, this._maxResults);

    return results;
  }

  /**
   * 获取统计信息
   * @returns {{activationCount: number, decay: number, threshold: number, maxDepth: number}} 统计信息对象
   */
  getStats() {
    return {
      activationCount: this._activationCount,
      decay: this._decay,
      threshold: this._threshold,
      maxDepth: this._maxDepth,
    };
  }
}

module.exports = { SpreadingActivation, SpreadingActivationEnhanced: withShutdown(SpreadingActivation) };
