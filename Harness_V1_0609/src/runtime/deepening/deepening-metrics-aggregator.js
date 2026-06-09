'use strict';
const DeepeningBase = require('./deepening-base');
const RingBuffer = require('../../utils/ring-buffer');
const { requireString_, ensurePositiveNumber } = require('../../utils/param-validator');
const { DEFAULT_METRICS_FLUSH_MS } = require('../../utils/constants');
const { HarnessError, DeepeningError } = require('../../errors');

/**
 * @module runtime/deepening/deepening-metrics-aggregator
 * 时序指标聚合器。注册、记录并聚合数值指标，支持统计计算（sum/avg/p95/p99），
 * 基于环形缓冲区的时序存储，可配置间隔的自动刷新，批量记录及仪表盘快照生成。
 */

/**
 * 时序指标聚合器 — 为深化子系统提供指标注册、记录与统计聚合能力。
 * 支持四种聚合类型（sum/avg/p95/p99），基于环形缓冲区的时序存储，
 * 可配置间隔的自动刷新，批量记录及仪表盘快照生成。
 *
 * @classdesc 深化指标聚合器。多源指标聚合、统计计算、趋势分析
 * @extends DeepeningBase
 * @emits 'registered' 当指标注册成功时触发，附带 {name, type}
 * @emits 'recorded' 当指标值记录时触发，附带 {name, value}
 * @emits 'unregistered' 当指标注销时触发，附带 {name}
 * @emits 'flushed' 当指标刷新时触发，附带 {name}
 */
class DeepeningMetricsAggregator extends DeepeningBase {
  /**
   * 聚合类型枚举。
   * @constant {Object}
   * @property {string} SUM - 求和聚合
   * @property {string} AVG - 平均值聚合
   * @property {string} P95 - P95百分位聚合
   * @property {string} P99 - P99百分位聚合
   */
  static AGGREGATION_TYPES = { SUM: 'sum', AVG: 'avg', P95: 'p95', P99: 'p99' };

  /**
   * 创建 DeepeningMetricsAggregator 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxMetrics=200] - 最大指标数量
   * @param {number} [options.maxSeriesLength=1000] - 每个指标的时序最大长度
   * @param {number} [options.flushInterval] - 自动刷新间隔（毫秒），默认 DEFAULT_METRICS_FLUSH_MS
   */
  constructor(options) {
    super(options);
    this._metrics = new Map();
    this._maxMetrics = (options && options.maxMetrics) ?? 200;
    this._maxSeriesLength = (options && options.maxSeriesLength) ?? 1000;
    this._flushInterval = ensurePositiveNumber((options && options.flushInterval), DEFAULT_METRICS_FLUSH_MS);
    this._flushIntervalId = null;
    this._totalRecorded = 0;
    this._totalFlushed = 0;
  }

  /**
   * 注册命名指标。
   * @param {string} name - 指标名称
   * @param {Object} [options] - 指标选项
   * @param {string} [options.type='gauge'] - 指标类型
   * @param {string} [options.unit] - 指标单位
   * @returns {boolean} 注册成功返回 true，已存在返回 true，达到最大数量返回 false
   * @emits 'registered' 指标注册成功时触发，附带 {name, type}
   */
  register(name, options) {
    this.guardShutdown();
    requireString_(name, 'Metric name');
    if (this._metrics.has(name)) return true;
    if (this._metrics.size >= this._maxMetrics) {
      const toDelete = [];
      for (const [k, m] of this._metrics) {
        if (m.stats.count === 0) { toDelete.push(k); break; }
      }
      for (const k of toDelete) { this._metrics.delete(k); }
      if (this._metrics.size >= this._maxMetrics) return false;
    }
    const opts = options ?? {};
    this._metrics.set(name, { name, type: opts.type ?? 'gauge', unit: opts.unit, values: new RingBuffer(this._maxSeriesLength), stats: { count: 0, min: Infinity, max: -Infinity, sum: 0 }, _cachedMetric: null, _cacheDirty: true });
    this.emit('registered', { name, type: opts.type ?? 'gauge' });
    return true;
  }

  /**
   * 获取所有已注册指标名称。
   * @returns {Array<string>} 指标名称数组
   */
  getNames() { return Array.from(this._metrics.keys()); }

  /**
   * 记录指标值。
   * @param {string} name - 指标名称
   * @param {number} value - 指标值
   * @param {Object} [labels] - 标签键值对
   * @returns {boolean} 记录成功返回 true
   * @throws {HarnessError} 当指标未注册时抛出 METRICS_ERROR 异常
   * @throws {DeepeningError} 当值非数字时抛出 INVALID_INPUT 异常
   * @emits 'recorded' 指标值记录时触发，附带 {name, value}
   */
  record(name, value, labels) {
    this.guardShutdown();
    const metric = this._metrics.get(name);
    if (!metric) throw new HarnessError('METRICS_ERROR', 'Metric not registered: ' + name);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new DeepeningError('INVALID_INPUT', 'Value must be a number');
    metric.values.push({ value, timestamp: Date.now(), labels });
    metric.stats.count++;
    metric.stats.sum += value;
    metric.stats.min = Math.min(metric.stats.min, value);
    metric.stats.max = Math.max(metric.stats.max, value);
    metric._cacheDirty = true;
    this._totalRecorded++;
    this.emit('recorded', { name, value });
    return true;
  }

  /**
   * 批量记录指标值。
   * @param {Array<Object>} entries - 记录条目数组 [{name, value, labels}]
   * @returns {boolean} 批量记录成功返回 true
   * @throws {DeepeningError} 当 entries 非数组时抛出 INVALID_INPUT 异常
   */
  recordBatch(entries) {
    this.guardShutdown();
    if (!Array.isArray(entries)) throw new DeepeningError('INVALID_INPUT', 'Entries must be an array');
    for (const e of entries) this.record(e.name, e.value, e.labels);
    return true;
  }

  /**
   * 获取指定指标的聚合统计信息（含缓存）。
   * @param {string} name - 指标名称
   * @returns {Object|null} 聚合统计 {value, count, min, max, sum, avg, p95, p99}，指标不存在返回 null
   */
  getMetric(name) {
    const metric = this._metrics.get(name);
    if (!metric) return null;
    if (!metric._cacheDirty && metric._cachedMetric) return metric._cachedMetric;
    const s = metric.stats;
    const avg = s.count > 0 ? s.sum / s.count : 0;
    const valuesArray = metric.values.slice();
    const latest = valuesArray.length > 0 ? valuesArray[valuesArray.length - 1].value : 0;
    const sorted = valuesArray.map(v => v.value).sort((a, b) => a - b);
    const p95 = sorted.length > 0 ? sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)] : 0;
    const p99 = sorted.length > 0 ? sorted[Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1)] : 0;
    metric._cachedMetric = { value: latest, count: s.count, min: s.min === Infinity ? 0 : s.min, max: s.max === -Infinity ? 0 : s.max, sum: s.sum, avg, p95, p99 };
    metric._cacheDirty = false;
    return metric._cachedMetric;
  }

  /**
   * 获取指定指标的时序数据，支持时间范围和数量过滤。
   * @param {string} name - 指标名称
   * @param {Object} [filters] - 过滤条件
   * @param {number} [filters.since] - 起始时间戳（毫秒）
   * @param {number} [filters.until] - 截止时间戳（毫秒）
   * @param {number} [filters.limit] - 返回最大数量
   * @returns {Array<Object>} 时序数据数组 [{value, timestamp, labels}]
   */
  getSeries(name, filters) {
    const m = this._metrics.get(name);
    if (!m) return [];
    let values = m.values.toArray();
    if (filters) {
      if (filters.since != null) values = values.filter(v => v.timestamp >= filters.since);
      if (filters.until != null) values = values.filter(v => v.timestamp <= filters.until);
      if (filters.limit != null && typeof filters.limit === 'number' && filters.limit > 0) values = values.slice(0, filters.limit);
    }
    return values;
  }

  /**
   * 注销指定指标。
   * @param {string} name - 指标名称
   * @returns {boolean} 注销成功返回 true，指标不存在返回 false
   * @emits 'unregistered' 指标注销时触发，附带 {name}
   */
  unregister(name) {
    this.guardShutdown();
    if (!this._metrics.has(name)) return false;
    this._metrics.delete(name);
    this.emit('unregistered', { name });
    return true;
  }

  /**
   * 刷新指定指标或全部指标，清空时序数据并返回快照。
   * @param {string} [name] - 指标名称，不传则刷新全部
   * @returns {Object|null|Object<string,Object>} 单个指标快照、全部指标快照映射或 null
   * @emits 'flushed' 指标刷新时触发，附带 {name}
   */
  flush(name) {
    if (name) {
      const m = this._metrics.get(name);
      if (!m) return null;
      const snapshot = this.getMetric(name);
      m.values = new RingBuffer(this._maxSeriesLength);
      m.stats = { count: 0, min: Infinity, max: -Infinity, sum: 0 };
      m._cacheDirty = true;
      this._totalFlushed++;
      this.emit('flushed', { name });
      return snapshot;
    }
    const snapshots = {};
    for (const [n] of this._metrics) {
      snapshots[n] = this.flush(n);
    }
    return snapshots;
  }

  /**
   * 启动自动刷新定时器。
   * @returns {boolean} 启动成功返回 true，已在运行返回 true
   */
  startAutoFlush() {
    if (this._flushIntervalId) return true;
    this._flushIntervalId = setInterval(() => { if (this._shutDown) return; const keys = Array.from(this._metrics.keys()); for (const n of keys) this.flush(n); }, this._flushInterval);
    if (this._flushIntervalId && this._flushIntervalId.unref) this._flushIntervalId.unref();
    return true;
  }

  /**
   * 停止自动刷新定时器。
   * @returns {boolean} 停止成功返回 true
   */
  stopAutoFlush() {
    if (this._flushIntervalId) { clearInterval(this._flushIntervalId); this._flushIntervalId = null; }
    return true;
  }

  /**
   * 获取仪表盘摘要，包含所有指标的聚合统计。
   * @returns {Object} 仪表盘数据 {totalMetrics, totalRecorded, metrics}
   */
  getDashboard() {
    const metrics = {};
    for (const [name] of this._metrics) {
      metrics[name] = this.getMetric(name);
    }
    return { totalMetrics: this._metrics.size, totalRecorded: this._totalRecorded, metrics };
  }

  /**
   * 获取指标聚合器的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.registeredMetrics - 已注册指标数
   * @returns {number} return.totalRecorded - 累计记录次数
   * @returns {number} return.totalFlushed - 累计刷新次数
   * @returns {number} return.maxSeriesLength - 时序最大长度
   * @returns {number} return.flushInterval - 刷新间隔（毫秒）
   * @returns {boolean} return.autoFlushRunning - 自动刷新是否运行中
   */
  getStats() {
    return { registeredMetrics: this._metrics.size, totalRecorded: this._totalRecorded, totalFlushed: this._totalFlushed, maxSeriesLength: this._maxSeriesLength, flushInterval: this._flushInterval, autoFlushRunning: !!this._flushIntervalId, ...super.getStats() };
  }

  /**
   * 关闭时的清理回调。停止自动刷新。
   * @protected
   */
  _onShutdown() {
    this.stopAutoFlush();
    super._onShutdown();
  }
}

module.exports = DeepeningMetricsAggregator;
