'use strict';

/**
 * @module runtime/deepening/deepening-benchmark
 * 深化推理子系统性能基准测试模块。对深化管道执行延迟和吞吐量基准测试，
 * 支持可配置预热和测量轮次，聚合耗时测量，追踪每轮成功/失败，计算平均耗时和每秒任务吞吐量。
 */

const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');

/**
 * 深化推理基准测试器。对深化管道执行延迟和吞吐量基准测试，
 * 支持可配置预热和测量轮次，聚合耗时测量，追踪每轮成功/失败，计算平均耗时和每秒任务吞吐量。
 * @classdesc 深化基准测试。性能基准、回归检测、对比报告
 * @extends DeepeningBase
 * @emits DeepeningBenchmark#benchmark-complete - 基准测试完成时触发
 */
class DeepeningBenchmark extends DeepeningBase {
  /** @constant {Object<string, string>} 基准测试类型枚举 */
  static BENCHMARK_TYPES = { THROUGHPUT: 'throughput', LATENCY: 'latency' };
  /**
   * 创建DeepeningBenchmark实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.warmupRuns=1] - 预热轮次
   * @param {number} [options.measureRuns=3] - 测量轮次
   * @param {number} [options.maxResults=100] - 最大保存结果数
   */
  constructor(options) {
    super(options);
    this._warmupRuns = typeof (options && options.warmupRuns) === 'number' && Number.isFinite(options.warmupRuns) ? options.warmupRuns : 1;
    this._measureRuns = typeof (options && options.measureRuns) === 'number' && Number.isFinite(options.measureRuns) ? options.measureRuns : 3;
    this._results = [];
    this._maxResults = typeof (options ?? {}).maxResults === 'number' && Number.isFinite((options ?? {}).maxResults) ? (options ?? {}).maxResults : 100;
  }

  /**
   * 执行基准测试（延迟或吞吐量）。对管道运行指定轮次并聚合耗时测量。
   * @param {string} type - 基准测试类型（'throughput'或'latency'）
   * @param {Object} pipeline - 管道对象，必须具有run方法
   * @param {*} task - 传递给管道的任务
   * @param {Array} [agents] - 传递给管道的Agent列表
   * @returns {Promise<Object|null>} 基准测试结果，包含type、measurements和summary；参数无效时返回null
   * @emits DeepeningBenchmark#benchmark-complete
   */
  async run(type, pipeline, task, agents) {
    this.guardShutdown();
    if (!type || !pipeline || typeof pipeline.run !== 'function') return null;
    const measurements = [];
    for (let i = 0; i < this._measureRuns; i++) {
      const start = Date.now();
      try {
        await pipeline.run(task, agents);
        if (this._shutDown) return null;
        measurements.push({ duration: Date.now() - start, success: true });
      } catch (err) {
        measurements.push({ duration: Date.now() - start, success: false, error: err && err.message ? err.message : String(err) });
      }
    }
    const result = { type, measurements, summary: { avgDuration: measurements.length ? measurements.reduce((a, b) => a + b.duration, 0) / measurements.length : 0 } };
    this._results.push(result);
    if (this._results.length > this._maxResults) {
      this._results.shift();
    }
    this.emit('benchmark-complete', result);
    return result;
  }

  /**
   * 执行吞吐量基准测试。在指定时间窗口内持续运行管道，计算每秒完成任务数。
   * @param {Object} pipeline - 管道对象，必须具有run方法
   * @param {*} task - 传递给管道的任务
   * @param {Array} [agents] - 传递给管道的Agent列表
   * @param {number} [duration=1000] - 测试持续时间（毫秒）
   * @returns {Promise<Object>} 吞吐量结果，包含throughputPerSecond和completedTasks
   */
  async runThroughput(pipeline, task, agents, duration) {
    this.guardShutdown();
    const dur = typeof duration === 'number' && Number.isFinite(duration) ? duration : 1000;
    const start = Date.now();
    let completed = 0;
    while (Date.now() - start < dur) {
      try {
        if (pipeline && pipeline.run) await pipeline.run(task, agents);
        if (this._shutDown) break;
        completed++;
      } catch (_e) {
        debug('DeepeningBenchmark', 'runThroughput', _e && _e.message ? _e.message : String(_e));
        continue;
      }
    }
    const result = { throughputPerSecond: dur > 0 ? completed / (dur / 1000) : 0, completedTasks: completed };
    this._results.push(result);
    if (this._results.length > this._maxResults) {
      this._results.shift();
    }
    return result;
  }

  /**
   * 获取所有基准测试结果的副本。
   * @returns {Object[]} 结果数组
   */
  getResults() { return this._results.slice(); }

  /**
   * 获取基准测试统计信息。
   * @returns {Object} 统计对象，包含totalBenchmarks
   */
  getStats() {
    return { totalBenchmarks: this._results.length, ...super.getStats() };
  }
}

module.exports = DeepeningBenchmark;
