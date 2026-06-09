'use strict';
const DeepeningBase = require('./deepening-base');
const { DeepeningError } = require('../../errors');
const RingBuffer = require('../../utils/ring-buffer');
const { counterId, ID_PREFIXES } = require('../../utils/unique-id');
const { DEFAULT_MAX_ENTRIES } = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');

/**
 * @module runtime/deepening/deepening-event-replay
 * 深化推理事件回放。事件记录与回放，支持基于类型的索引、
 * 自定义过滤器、同步/异步回放及速度控制。
 */

/**
 * 深化推理事件回放 — 深化管道的事件记录与回放。
 * 使用环形缓冲区存储事件，支持基于类型的索引、自定义过滤器、
 * 以及带可配置速度控制的同步和异步回放。
 *
 * @classdesc 深化事件回放。从事件流重建状态、选择性回放
 * @extends DeepeningBase
 * @emits 'recorded' 当事件被记录时触发，附带完整事件对象
 * @emits 'replay' 当回放单个事件时触发，附带事件对象
 * @emits 'replayComplete' 当回放完成时触发，附带 { count }
 * @emits 'cleared' 当事件记录被清空时触发
 */
class DeepeningEventReplay extends DeepeningBase {

  /**
   * 创建 DeepeningEventReplay 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxSize] - 环形缓冲区最大容量，默认使用 DEFAULT_MAX_ENTRIES
   * @param {number} [options.speed=1] - 异步回放时每个事件之间的间隔时间（毫秒）
   */
  constructor(options) {
    super(options);
    this._maxSize = typeof (options && options.maxSize) === 'number' && Number.isFinite(options.maxSize) ? options.maxSize : DEFAULT_MAX_ENTRIES;
    this._eventList = new RingBuffer(this._maxSize);
    this._filters = new Map();
    this._speed = typeof (options && options.speed) === 'number' && Number.isFinite(options.speed) ? options.speed : 1;
    this._playing = false;
    this._typeCounts = {};
    this._eventById = new Map();
    /** 活跃回放 setTimeout 定时器集合，关闭时批量清理 */
    this._timers = new Set();
    /** 挂起的Promise解析器，关闭时批量reject防止永远挂起 */
    this._pendingResolvers = new Set();
  }

  /**
   * 记录事件。自动分配唯一 ID 和时间戳，维护类型计数索引。
   * @param {string} eventType - 事件类型
   * @param {*} [data] - 事件数据
   * @param {*} [metadata] - 事件元数据
   * @returns {string} 事件 ID
   * @throws {DeepeningError} eventType 为空时抛出
   * @emits 'recorded'
   */
  record(eventType, data, metadata) {
    this.guardShutdown();
    if (!eventType) throw new DeepeningError('MISSING_PARAMETER', 'eventType is required');
    const event = { id: counterId(ID_PREFIXES.DEEPENING_REPLAY), type: eventType, data, metadata, timestamp: Date.now() };
    const evicted = this._eventList.pushWithEvicted(event);
    for (const e of evicted) {
      if (e && e.id) this._eventById.delete(e.id);
      if (e && e.type) {
        this._typeCounts[e.type] = (typeof this._typeCounts[e.type] === 'number' && Number.isFinite(this._typeCounts[e.type]) ? this._typeCounts[e.type] : 1) - 1;
        if (this._typeCounts[e.type] <= 0) delete this._typeCounts[e.type];
      }
    }
    this._eventById.set(event.id, event);
    this._typeCounts[eventType] = (typeof this._typeCounts[eventType] === 'number' && Number.isFinite(this._typeCounts[eventType]) ? this._typeCounts[eventType] : 0) + 1;
    this.emit('recorded', event);
    return event.id;
  }

  /**
   * 获取事件列表。支持按类型、时间范围过滤。
   * @param {Object} [filters] - 过滤条件
   * @param {string} [filters.type] - 按事件类型过滤
   * @param {number} [filters.since] - 起始时间戳（含）
   * @param {number} [filters.until] - 截止时间戳（含）
   * @param {number} [filters.limit] - 返回事件数量上限
   * @returns {Object[]} 事件数组
   */
  getEvents(filters) {
    if (!filters) return this._eventList.toArray();
    return this._eventList.filter(e => {
      if (filters.type && e.type !== filters.type) return false;
      if (filters.since != null && e.timestamp < filters.since) return false;
      if (filters.until != null && e.timestamp > filters.until) return false;
      return true;
    }).slice(0, filters.limit ?? this._eventList.size);
  }

  /**
   * 按 ID 获取单个事件。
   * @param {string} id - 事件 ID
   * @returns {Object|null} 事件对象，不存在时返回 null
   */
  getEvent(_id) { return this._eventById.get(_id) ?? null; }

  /**
   * 获取事件数量。可按类型过滤。
   * @param {string} [type] - 事件类型
   * @returns {number} 事件数量
   */
  getEventCount(type) { return type ? (this._typeCounts[type] ?? 0) : this._eventList.size; }

  /**
   * 获取所有已记录的事件类型。
   * @returns {string[]} 事件类型数组
   */
  getEventTypes() { return Object.keys(this._typeCounts); }

  /**
   * 注册自定义过滤器。
   * @param {string} name - 过滤器名称
   * @param {Function} filterFn - 过滤函数，签名 (event) => boolean
   * @returns {boolean} 注册是否成功
   * @throws {DeepeningError} 名称或过滤函数缺失时抛出
   */
  registerFilter(name, filterFn) {
    this.guardShutdown();
    if (!name || typeof filterFn !== 'function') throw new DeepeningError('MISSING_PARAMETER', 'Name and filterFn are required');
    if (this._filters.size >= 50 && !this._filters.has(name)) return false;
    this._filters.set(name, filterFn);
    return true;
  }

  /**
   * 注销自定义过滤器。
   * @param {string} name - 过滤器名称
   * @returns {boolean} 是否成功注销
   */
  unregisterFilter(name) { this.guardShutdown(); return this._filters.delete(name); }

  /**
   * 应用过滤器到事件列表。支持按类型和已注册的自定义过滤器过滤。
   * @param {Object[]} events - 待过滤的事件数组
   * @param {Object} opts - 过滤选项
   * @param {string} [opts.type] - 按事件类型过滤（含子类型匹配）
   * @param {string[]} [opts.filters] - 指定使用的已注册过滤器名称列表
   * @returns {Object[]} 过滤后的事件数组
   * @private
   */
  _applyFilters(events, opts) {
    if (opts.type) events = events.filter(e => e.type === opts.type || e.type.startsWith(opts.type + '.'));
    if (opts.filters && Array.isArray(opts.filters)) {
      for (const filterName of opts.filters) {
        const fn = this._filters.get(filterName);
        if (fn) events = events.filter(fn);
      }
    } else {
      for (const [, fn] of this._filters) { events = events.filter(fn); }
    }
    return events;
  }

  /**
   * 同步回放事件。逐个触发回放事件和可选回调。
   * @param {Object} [options] - 回放选项
   * @param {string} [options.type] - 按事件类型过滤
   * @param {string[]} [options.filters] - 使用的过滤器名称列表
   * @param {Function} [options.callback] - 每个事件的回调函数
   * @returns {number} 回放的事件数量
   * @emits 'replay'
   * @emits 'replayComplete'
   */
  replay(options) {
    const opts = options ?? {};
    const events = this._applyFilters(this._eventList.toArray(), opts);
    let count = 0;
    for (const event of events) {
      if (opts.callback) opts.callback(event);
      this.emit('replay', event);
      count++;
    }
    this.emit('replayComplete', { count });
    return count;
  }

  /**
   * 异步回放事件。支持速度控制和中断。
   * @param {Object} [options] - 回放选项
   * @param {string} [options.type] - 按事件类型过滤
   * @param {string[]} [options.filters] - 使用的过滤器名称列表
   * @param {Function} [options.callback] - 每个事件的回调函数
   * @param {number} [options.speed] - 回放速度（毫秒/事件），覆盖实例默认速度
   * @returns {Promise<number>} 回放的事件数量
   * @emits 'replay'
   * @emits 'replayComplete'
   */
  async startReplay(options) {
    this.guardShutdown();
    if (this._playing) return 0;
    this._playing = true;
    try {
      const opts = options ?? {};
      const speed = opts.speed ?? this._speed;
      const events = this._applyFilters(this._eventList.toArray(), opts);
      let count = 0;
      for (const event of events) {
        if (!this._playing) break;
        if (opts.callback) {
          try { opts.callback(event); } catch (_e) { debug('DeepeningEventReplay', 'callback-error', _e?.message || _e); }
        }
        this.emit('replay', event);
        count++;
        if (speed > 0 && events.length > 1) {
          await new Promise((resolve, reject) => {
            const entry = { timer: null, resolve, reject };
            const tid = setTimeout(() => {
              this._timers.delete(tid);
              this._pendingResolvers.delete(entry);
              resolve();
            }, speed);
            if (tid && typeof tid.unref === 'function') tid.unref();
            entry.timer = tid;
            this._timers.add(tid);
            this._pendingResolvers.add(entry);
          });
          if (this._shutDown) { this._playing = false; return count; }
        }
      }
      this._playing = false;
      this.emit('replayComplete', { count });
      return count;
    } catch (err) {
      this._playing = false;
      throw err;
    }
  }

  /**
   * 停止异步回放。
   * @returns {boolean} 操作结果
   */
  stopReplay() { this._playing = false; return true; }

  /**
   * 检查是否正在回放。
   * @returns {boolean} 是否正在回放
   */
  isPlaying() { return this._playing; }

  /**
   * 清空所有事件记录和索引。
   * @returns {boolean} 操作结果
   * @emits 'cleared'
   */
  clear() { this.guardShutdown(); this._eventList.clear(); this._eventById.clear(); this._typeCounts = {}; this.emit('cleared'); return true; }

  /**
   * 获取事件回放运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalEvents - 当前事件总数
   * @returns {number} return.maxSize - 环形缓冲区最大容量
   * @returns {boolean} return.isPlaying - 是否正在回放
   * @returns {number} return.filtersRegistered - 已注册过滤器数量
   * @returns {number} return.filters - 已注册过滤器数量（别名）
   * @returns {number} return.eventTypes - 事件类型数量
   * @returns {Object} return.typeCounts - 各类型事件计数
   */
  getStats() {
    return { totalEvents: this._eventList.size, maxSize: this._maxSize, isPlaying: this._playing, filtersRegistered: this._filters.size, filters: this._filters.size, eventTypes: Object.keys(this._typeCounts).length, typeCounts: { ...this._typeCounts }, ...super.getStats() };
  }

  /**
   * 关闭时的清理回调。清空过滤器和事件索引。
   * @protected
   */
  _onShutdown() {
    this._playing = false;
    for (const { reject } of this._pendingResolvers) {
      try { reject(new Error('Shutdown')); } catch (_e) { debug('DeepeningEventReplay', 'shutdown:reject', _e && _e.message ? _e.message : String(_e)); }
    }
    this._pendingResolvers.clear();
    for (const tid of this._timers) clearTimeout(tid);
    this._timers.clear();
    this._filters.clear();
    this._eventById.clear();
    super._onShutdown();
  }
}

module.exports = DeepeningEventReplay;
