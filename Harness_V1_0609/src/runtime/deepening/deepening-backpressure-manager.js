'use strict';

/**
 * @module runtime/deepening/deepening-backpressure-manager
 * 深化推理子系统流式背压控制器。管理每流缓冲区压力，支持可配置高/低水位线，
 * 四级压力等级（low/medium/high/critical），自动暂停/恢复流，溢出丢弃追踪和强制暂停/恢复能力。
 */

const DeepeningBase = require('./deepening-base');
const { requireString_ } = require('../../utils/param-validator');
const { HarnessError } = require('../../errors');

/**
 * 深化推理背压管理器。管理每流缓冲区压力，支持可配置高/低水位线和四级压力等级（low/medium/high/critical），
 * 缓冲区超过高水位线时自动暂停流，低于低水位线时自动恢复，支持溢出丢弃追踪和强制暂停/恢复。
 * @classdesc 深化背压管理器。流量控制、缓冲策略、降级
 * @extends DeepeningBase
 * @emits DeepeningBackpressureManager#streamRegistered - 流注册时触发
 * @emits DeepeningBackpressureManager#dropped - 数据因溢出被丢弃时触发
 * @emits DeepeningBackpressureManager#pressureChanged - 压力等级变化时触发
 * @emits DeepeningBackpressureManager#paused - 流被暂停时触发
 * @emits DeepeningBackpressureManager#streamReset - 流被重置时触发
 * @emits DeepeningBackpressureManager#streamUnregistered - 流被注销时触发
 */
class DeepeningBackpressureManager extends DeepeningBase {
  /** @constant {Object<string, string>} 压力等级枚举 */
  static PRESSURE_LEVELS = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' };
  /**
   * 创建DeepeningBackpressureManager实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxStreams=50] - 最大流数量
   * @param {number} [options.defaultHighWatermark=100] - 默认高水位线
   * @param {number} [options.defaultLowWatermark=20] - 默认低水位线
   */
  constructor(options) {
    super(options);
    this._streams = new Map();
    this._maxStreams = typeof (options && options.maxStreams) === 'number' && Number.isFinite(options.maxStreams) ? options.maxStreams : 50;
    this._defaultHighWatermark = typeof (options && options.defaultHighWatermark) === 'number' && Number.isFinite(options.defaultHighWatermark) ? options.defaultHighWatermark : 100;
    this._defaultLowWatermark = typeof (options && options.defaultLowWatermark) === 'number' && Number.isFinite(options.defaultLowWatermark) ? options.defaultLowWatermark : 20;
    this._totalDropped = 0;
  }

  /**
   * 注册一个新的流。若已达最大流数，尝试驱逐缓冲区为空的流。
   * @param {string} name - 流名称
   * @param {Object} [options] - 流配置
   * @param {number} [options.highWatermark] - 高水位线
   * @param {number} [options.lowWatermark] - 低水位线
   * @param {number} [options.maxBufferSize=1000] - 最大缓冲区大小
   * @returns {boolean} 注册成功返回true，流已存在返回false
   * @emits DeepeningBackpressureManager#streamRegistered
   */
  registerStream(name, options) {
    this.guardShutdown();
    requireString_(name, 'Stream name');
    if (this._streams.has(name)) return false;
    if (this._streams.size >= this._maxStreams) {
      let evicted = false;
      const toDelete = [];
      for (const [n, s] of this._streams) {
        if (s.bufferSize === 0) { toDelete.push(n); break; }
      }
      for (const n of toDelete) { this._streams.delete(n); evicted = true; }
      if (!evicted) return false;
    }
    const opts = options ?? {};
    this._streams.set(name, { name, highWatermark: typeof opts.highWatermark === 'number' && Number.isFinite(opts.highWatermark) ? opts.highWatermark : this._defaultHighWatermark, lowWatermark: typeof opts.lowWatermark === 'number' && Number.isFinite(opts.lowWatermark) ? opts.lowWatermark : this._defaultLowWatermark, maxBufferSize: typeof opts.maxBufferSize === 'number' && Number.isFinite(opts.maxBufferSize) ? opts.maxBufferSize : 1000, bufferSize: 0, paused: false });
    this.emit('streamRegistered', { name, highWatermark: typeof opts.highWatermark === 'number' && Number.isFinite(opts.highWatermark) ? opts.highWatermark : this._defaultHighWatermark });
    return true;
  }

  /**
   * 获取所有已注册流的名称列表。
   * @returns {string[]} 流名称数组
   */
  getStreamNames() { return Array.from(this._streams.keys()); }

  /**
   * 向指定流推送数据，增加缓冲区大小。缓冲区满且流已暂停时丢弃数据。
   * @param {string} name - 流名称
   * @param {number} [amount=1] - 推送的数据量
   * @returns {Object} 结果对象，包含accepted、bufferSize和可选的reason
   * @throws {HarnessError} 流不存在时抛出
   * @emits DeepeningBackpressureManager#dropped
   * @emits DeepeningBackpressureManager#pressureChanged
   * @emits DeepeningBackpressureManager#paused
   */
  push(name, amount) {
    this.guardShutdown();
    const stream = this._streams.get(name);
    if (!stream) throw new HarnessError('BACKPRESSURE_ERROR', 'Stream not found: ' + name);
    const addAmount = typeof amount === 'number' && Number.isFinite(amount) ? amount : 1;
    const prevLevel = this._getLevel(stream.bufferSize, stream);
    if (stream.paused && stream.bufferSize + addAmount > stream.maxBufferSize) {
      this._totalDropped += addAmount;
      this.emit('dropped', { count: addAmount });
      return { accepted: false, bufferSize: stream.bufferSize, reason: 'paused_overflow' };
    }
    stream.bufferSize += addAmount;
    const newLevel = this._getLevel(stream.bufferSize, stream);
    if (newLevel !== prevLevel) {
      this.emit('pressureChanged', { from: prevLevel, to: newLevel });
    }
    if (stream.bufferSize >= stream.highWatermark && !stream.paused) {
      stream.paused = true;
      this.emit('paused', { name });
    }
    return { accepted: !stream.paused, bufferSize: stream.bufferSize };
  }

  /**
   * 确认处理完成，减少缓冲区大小。缓冲区降至低水位线以下时自动恢复流。
   * @param {string} name - 流名称
   * @param {number} [amount=1] - 确认处理的数据量
   * @returns {Object} 结果对象，包含bufferSize
   * @throws {HarnessError} 流不存在时抛出
   * @emits DeepeningBackpressureManager#pressureChanged
   */
  ack(name, amount) {
    this.guardShutdown();
    const stream = this._streams.get(name);
    if (!stream) throw new HarnessError('BACKPRESSURE_ERROR', 'Stream not found: ' + name);
    stream.bufferSize = Math.max(0, stream.bufferSize - (typeof amount === 'number' && Number.isFinite(amount) ? amount : 1));
    if (stream.paused && stream.bufferSize <= stream.lowWatermark) {
      const from = this._getLevel(stream.bufferSize + (typeof amount === 'number' && Number.isFinite(amount) ? amount : 1), stream);
      stream.paused = false;
      const to = this._getLevel(stream.bufferSize, stream);
      this.emit('pressureChanged', { from, to });
    }
    return { bufferSize: stream.bufferSize };
  }

  /**
   * 根据缓冲区大小计算当前压力等级。
   * @param {number} bufferSize - 当前缓冲区大小
   * @param {Object} [stream] - 流配置对象
   * @returns {string} 压力等级（low/medium/high/critical）
   * @private
   */
  _getLevel(bufferSize, stream) {
    const highWatermark = stream ? stream.highWatermark : this._defaultHighWatermark;
    const lowWatermark = stream ? stream.lowWatermark : this._defaultLowWatermark;
    const effectiveHigh = Math.max(highWatermark, lowWatermark + 1);
    if (bufferSize >= effectiveHigh) return 'critical';
    if (bufferSize >= lowWatermark + (effectiveHigh - lowWatermark) / 2) return 'high';
    if (bufferSize >= lowWatermark) return 'medium';
    return 'low';
  }

  /**
   * 获取指定流的压力状态。
   * @param {string} name - 流名称
   * @returns {Object} 压力状态对象，包含level和bufferSize
   */
  getPressure(name) {
    const stream = this._streams.get(name);
    if (!stream) return { level: 'low', bufferSize: 0 };
    return { level: this._getLevel(stream.bufferSize, stream), bufferSize: stream.bufferSize };
  }

  /**
   * 检查指定流是否已暂停。
   * @param {string} name - 流名称
   * @returns {boolean} 已暂停返回true
   */
  isPaused(name) { const s = this._streams.get(name); return s ? s.paused : false; }
  /**
   * 强制暂停指定流。
   * @param {string} name - 流名称
   * @returns {boolean} 成功暂停返回true，流不存在返回false
   * @emits DeepeningBackpressureManager#paused
   */
  forcePause(name) { this.guardShutdown(); const s = this._streams.get(name); if (!s) return false; s.paused = true; this.emit('paused', { name }); return true; }
  /**
   * 强制恢复指定流。
   * @param {string} name - 流名称
   * @returns {boolean} 成功恢复返回true，流不存在返回false
   * @emits DeepeningBackpressureManager#pressureChanged
   */
  forceResume(name) { this.guardShutdown(); const s = this._streams.get(name); if (!s) return false; s.paused = false; this.emit('pressureChanged', { from: 'high', to: 'low' }); return true; }
  /**
   * 重置指定流的缓冲区和暂停状态。
   * @param {string} name - 流名称
   * @returns {boolean} 始终返回true
   * @emits DeepeningBackpressureManager#streamReset
   */
  resetStream(name) { this.guardShutdown(); const s = this._streams.get(name); if (s) { s.bufferSize = 0; s.paused = false; } this.emit('streamReset', { name }); return true; }
  /**
   * 注销指定流。
   * @param {string} name - 流名称
   * @returns {boolean} 注销成功返回true，流不存在返回false
   * @emits DeepeningBackpressureManager#streamUnregistered
   */
  unregisterStream(name) { this.guardShutdown(); if (!this._streams.has(name)) return false; this._streams.delete(name); this.emit('streamUnregistered', { name }); return true; }

  /**
   * 关闭时清理所有流数据。
   * @private
   */
  _onShutdown() {
    this._streams.clear();
    super._onShutdown();
  }

  /**
   * 获取背压管理器统计信息。
   * @returns {Object} 统计对象，包含totalStreams、各流bufferSize和paused状态
   */
  getStats() {
    const streams = {};
    for (const [name, s] of this._streams) streams[name] = { bufferSize: s.bufferSize, paused: s.paused };
    return { totalStreams: this._streams.size, streams, ...super.getStats() };
  }
}

module.exports = DeepeningBackpressureManager;
