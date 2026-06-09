'use strict';
const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');

/**
 * @module runtime/deepening/deepening-visualizer
 * 深化推理可视化器 — 将深化推理执行过程中的事件数据转化为可视化图表结构，
 * 包括执行关系图、收敛趋势图、执行时间线和系统健康仪表盘。
 * 依赖事件存储（EventStore）获取原始事件数据，支持多种事件存储接口适配。
 *
 * @classdesc 深化可视化器。执行流程可视化、依赖图渲染。
 * @extends DeepeningBase
 * @emits 'error' 当事件查询或数据转换过程中发生异常时触发
 */
class DeepeningVisualizer extends DeepeningBase {

  /**
   * 创建 DeepeningVisualizer 实例。
   * @param {Object} eventStore - 事件存储实例，需提供 getEventsByExecution 或 query 方法
   * @param {Function} [eventStore.getEventsByExecution] - 按执行ID获取事件列表
   * @param {Function} [eventStore.query] - 通用查询方法，支持过滤条件
   * @param {Function} [eventStore.getStats] - 获取存储统计信息
   * @param {Function} [eventStore.getRecentEvents] - 获取最近事件列表
   */
  constructor(eventStore) {
    super();
    this._eventStore = eventStore;
  }

  /**
   * 生成执行关系图。从事件流中提取节点（source/target）和边（source→target），
   * 构建表示Agent间交互关系的图结构。自动去重节点。
   * @param {string} executionId - 执行ID，用于检索关联事件
   * @returns {Object} 图结构对象
   * @returns {Array<Object>} return.nodes - 节点列表，每项包含 id、label、type
   * @returns {Array<Object>} return.edges - 边列表，每项包含 source、target、label
   */
  generateExecutionGraph(executionId) {
    const events = this._getEventsForExecution(executionId);
    if (!events || events.length === 0) return { nodes: [], edges: [] };
    const nodes = [];
    const edges = [];
    const nodeSet = new Set();
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      const source = evt.source || evt.agent || 'system';
      if (!nodeSet.has(source)) {
        nodeSet.add(source);
        nodes.push({ id: source, label: source, type: evt.type || 'agent' });
      }
      if (evt.target && !nodeSet.has(evt.target)) {
        nodeSet.add(evt.target);
        nodes.push({ id: evt.target, label: evt.target, type: 'target' });
      }
      if (evt.target) {
        edges.push({ source: source, target: evt.target, label: evt.action || evt.type || '' });
      }
    }
    return { nodes: nodes, edges: edges };
  }

  /**
   * 生成收敛趋势图数据。从事件流中筛选质量评分事件（quality-score、convergence-check），
   * 构建折线图数据结构，横轴为迭代次数，纵轴为质量评分。
   * @param {string} executionId - 执行ID，用于检索关联事件
   * @returns {Object} 折线图数据结构
   * @returns {string} return.type - 图表类型，固定为 'line'
   * @returns {Object} return.data - 图表数据
   * @returns {Array<string>} return.data.labels - 迭代标签数组（如 ['iter-1', 'iter-2']）
   * @returns {Array<Object>} return.data.datasets - 数据集数组，每项包含 label、data、borderColor、fill
   */
  generateConvergenceChart(executionId) {
    const events = this._getEventsForExecution(executionId);
    if (!events || events.length === 0) return { type: 'line', data: { labels: [], datasets: [] } };
    const qualityEvents = events.filter(function(e) { return e.type === 'quality-score' || e.type === 'convergence-check' || e.type === 'convergence-detected' || e.type === 'iteration-complete'; });
    if (qualityEvents.length === 0) return { type: 'line', data: { labels: [], datasets: [] } };
    const labels = qualityEvents.map(function(e, i) { return 'iter-' + (i + 1); });
    const scores = qualityEvents.map(function(e) { return typeof e.score === 'number' && Number.isFinite(e.score) ? e.score : (typeof e.qualityScore === 'number' && Number.isFinite(e.qualityScore) ? e.qualityScore : 0); });
    return {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{ label: 'Quality Score', data: scores, borderColor: '#4CAF50', fill: false }],
      },
    };
  }

  /**
   * 生成执行时间线。将事件流转化为按时间排列的时间线条目，
   * 最多展示最近50条事件，每条包含时间戳、类型、来源、动作和数据。
   * @param {string} executionId - 执行ID，用于检索关联事件
   * @returns {Array<Object>} 时间线条目数组，每项包含 timestamp、type、source、action、data
   */
  generateExecutionTimeline(executionId) {
    const events = this._getEventsForExecution(executionId);
    if (!events || events.length === 0) return [];
    return events.slice(0, 50).map(function(e) {
      return {
        timestamp: typeof e.timestamp === 'number' && Number.isFinite(e.timestamp) ? e.timestamp : (typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now()),
        type: e.type || 'unknown',
        source: e.source || e.agent || 'system',
        action: e.action || '',
        data: e.data ?? {},
      };
    });
  }

  /**
   * 生成系统健康仪表盘数据。聚合事件存储的统计信息和最近20条事件，
   * 提供系统运行状态的全局视图。自动适配不同事件存储接口（getStats/getRecentEvents/query）。
   * @returns {Object} 仪表盘数据对象
   * @returns {Object} return.stats - 事件存储统计信息
   * @returns {Array<Object>} return.recentEvents - 最近事件列表（最多20条）
   */
  generateSystemHealthDashboard() {
    let stats = {};
    let recentEvents = [];
    if (this._eventStore && typeof this._eventStore.getStats === 'function') {
      stats = this._eventStore.getStats();
    }
    if (this._eventStore && typeof this._eventStore.getRecentEvents === 'function') {
      recentEvents = this._eventStore.getRecentEvents(20);
    } else if (this._eventStore && typeof this._eventStore.query === 'function') {
      try {
        const result = this._eventStore.query({ limit: 20 });
        recentEvents = Array.isArray(result) ? result : (result && result.events) ?? [];
      } catch (err) { debug('DeepeningVisualizer', '_getSnapshotData', err && err.message ? err.message : String(err)); recentEvents = []; }
    }
    return { stats: stats, recentEvents: recentEvents };
  }

  /**
   * 根据执行ID从事件存储中检索关联事件。优先使用 getEventsByExecution 方法，
   * 回退到 query 方法，查询异常时返回空数组并记录调试日志。
   * @param {string} executionId - 执行ID
   * @returns {Array<Object>} 事件数组，查询失败或无事件时返回空数组
   * @protected
   */
  _getEventsForExecution(executionId) {
    if (!this._eventStore) return [];
    if (typeof this._eventStore.getByExecution === 'function') {
      return this._eventStore.getByExecution(executionId) ?? [];
    }
    if (typeof this._eventStore.getEventsByExecution === 'function') {
      return this._eventStore.getEventsByExecution(executionId) ?? [];
    }
    if (typeof this._eventStore.query === 'function') {
      try {
        const result = this._eventStore.query({ executionId: executionId });
        return Array.isArray(result) ? result : (result && result.events) ?? [];
      } catch (err) { debug('DeepeningVisualizer', '_getEventsForExecution', err && err.message ? err.message : String(err)); return []; }
    }
    return [];
  }

  /**
   * 获取可视化器的运行统计信息，包含事件存储状态及基类统计。
   * @returns {Object} 统计信息对象
   * @returns {boolean} return.hasEventStore - 是否已配置事件存储实例
   */
  getStats() {
    return { ...super.getStats(), hasEventStore: !!this._eventStore };
  }
}

module.exports = DeepeningVisualizer;
