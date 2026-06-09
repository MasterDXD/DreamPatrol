'use strict';
const DeepeningBase = require('./deepening-base');
const RingBuffer = require('../../utils/ring-buffer');
const { debug } = require('../../utils/debug-logger');
const { loadJsonSync, loadJsonAsync } = require('../../utils/fs-utils');
const { writeAtomic, writeAtomicAsync } = require('../../utils/debounced-persister');
const path = require('path');

const { timestampId } = require('../../utils/unique-id');
const { DEFAULT_MAX_ENTRIES } = require('../../utils/constants');
const { emitError } = require('../../utils/safe-execute');

/**
 * @module runtime/deepening/deepening-event-store
 * 深化推理事件存储。追加写入的事件存储，记录执行生命周期事件，
 * 支持按类型/执行ID/时间范围查询、事件回放及可选磁盘持久化。
 */

/**
 * 深化推理事件存储 — 深化管道的追加写入事件存储。
 * 记录执行生命周期事件（启动/完成/迭代/收敛/缓存命中/缓存未命中），
 * 支持按类型、执行 ID 和时间范围查询、特定执行的事件回放、
 * 以及带同步和异步读写路径的可选磁盘持久化。
 *
 * @classdesc 深化事件存储。事件持久化、事件回放、快照+事件恢复
 * @extends DeepeningBase
 * @emits 'event-recorded' 当事件被记录时触发，附带完整事件对象
 * @emits 'event:{type}' 当特定类型事件被记录时触发，附带完整事件对象
 * @emits 'persist-error' 当磁盘写入/读取失败时触发
 * @emits 'restore-error' 当磁盘恢复失败时触发
 */
class DeepeningEventStore extends DeepeningBase {
  /**
   * 事件类型枚举。
   * @constant
   * @type {Object}
   * @property {string} EXECUTION_START - 执行启动
   * @property {string} EXECUTION_COMPLETE - 执行完成
   * @property {string} ITERATION_COMPLETE - 迭代完成
   * @property {string} CONVERGENCE_DETECTED - 收敛检测
   * @property {string} CACHE_HIT - 缓存命中
   * @property {string} CACHE_MISS - 缓存未命中
   */
  static EVENT_TYPES = { EXECUTION_START: 'execution-start', EXECUTION_COMPLETE: 'execution-complete', ITERATION_COMPLETE: 'iteration-complete', CONVERGENCE_DETECTED: 'convergence-detected', CACHE_HIT: 'cache-hit', CACHE_MISS: 'cache-miss' };

  /**
   * 创建 DeepeningEventStore 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxEvents] - 最大事件数量，默认使用 DEFAULT_MAX_ENTRIES
   * @param {number} [options.maxExecutionIds=500] - 最大执行 ID 索引数量
   * @param {number} [options.maxByExecutionKeys=500] - 最大按执行 ID 分组索引数量
   * @param {boolean} [options.persistToDisk=false] - 是否启用磁盘持久化
   * @param {string} [options.persistPath=''] - 持久化文件目录路径
   */
  constructor(options) {
    super(options);
    this._maxEvents = (options && options.maxEvents) ?? DEFAULT_MAX_ENTRIES;
    this._events = new RingBuffer(this._maxEvents);
    this._sequenceNumber = 0;
    this._maxExecutionIds = (options && options.maxExecutionIds) ?? 500;
    this._executionIds = new Set();
    this._byType = {};
    this._maxByExecutionKeys = (options && options.maxByExecutionKeys) ?? 500;
    this._byExecution = {};
    this._persistToDisk = (options && options.persistToDisk) ?? false;
    this._persistPath = options?.persistPath ?? '';
    this._autoFlushInterval = (options && options.autoFlushInterval) ?? 0;
    this._autoFlushTimer = null;
    this._unflushedCount = 0;
    this._autoFlushThreshold = (options && options.autoFlushThreshold) ?? 50;
    if (this._persistToDisk && this._persistPath) {
      this._loadFromDisk();
      this._startAutoFlush();
    }
  }

  /**
   * 记录事件。自动分配时间戳 ID 和递增序列号，维护类型和执行 ID 索引。
   * @param {string} type - 事件类型
   * @param {Object} [data] - 事件数据
   * @param {string} [data.executionId] - 关联的执行 ID
   * @returns {Object} 记录的事件对象 { id, type, data, timestamp, sequence }
   * @emits 'event-recorded'
   * @emits 'event:{type}'
   */
  record(type, data) {
    this.guardShutdown();
    this._sequenceNumber++;
    const event = { id: timestampId(), type, data, timestamp: Date.now(), sequence: this._sequenceNumber };
    const evicted = this._events.pushWithEvicted(event);
    for (const ev of evicted) {
      if (ev.type) {
        this._byType[ev.type] = Math.max(0, (this._byType[ev.type] ?? 0) - 1);
        if (this._byType[ev.type] <= 0) delete this._byType[ev.type];
      }
      if (ev.data && ev.data.executionId) {
        this._byExecution[ev.data.executionId] = Math.max(0, (this._byExecution[ev.data.executionId] ?? 0) - 1);
        if (this._byExecution[ev.data.executionId] <= 0) {
          delete this._byExecution[ev.data.executionId];
          this._executionIds.delete(ev.data.executionId);
        }
      }
    }
    this._byType[type] = (this._byType[type] ?? 0) + 1;
    if (data && data.executionId) {
      if (this._executionIds.size >= this._maxExecutionIds) {
        const oldest = this._executionIds.values().next().value;
        if (oldest !== undefined) {
          this._executionIds.delete(oldest);
          delete this._byExecution[oldest];
        }
      }
      this._executionIds.add(data.executionId);
      this._byExecution[data.executionId] = (this._byExecution[data.executionId] ?? 0) + 1;
    }
    this.emit('event-recorded', event);
    this.emit('event:' + type, event);
    this._unflushedCount++;
    if (this._persistToDisk && this._unflushedCount >= this._autoFlushThreshold) {
      this._autoFlush();
    }
    return event;
  }

  /**
   * 记录执行启动事件。
   * @param {string} executionId - 执行 ID
   * @param {*} [task] - 关联的任务
   * @returns {Object} 记录的事件对象
   */
  recordExecutionStart(executionId, task) { return this.record('execution-start', { executionId, task }); }

  /**
   * 记录执行完成事件。
   * @param {string} executionId - 执行 ID
   * @param {*} [result] - 执行结果
   * @returns {Object} 记录的事件对象
   */
  recordExecutionComplete(executionId, result) { return this.record('execution-complete', { executionId, result }); }

  /**
   * 记录迭代完成事件。
   * @param {string} executionId - 执行 ID
   * @param {number} iteration - 迭代序号
   * @param {number} [score] - 质量评分
   * @returns {Object} 记录的事件对象
   */
  recordIterationComplete(executionId, iteration, score) { return this.record('iteration-complete', { executionId, iteration, score }); }

  /**
   * 记录收敛检测事件。
   * @param {string} executionId - 执行 ID
   * @param {string} [reason] - 收敛原因
   * @param {number} [iteration] - 收敛时的迭代序号
   * @returns {Object} 记录的事件对象
   */
  recordConvergence(executionId, reason, iteration) { return this.record('convergence-detected', { executionId, reason, iteration }); }

  /**
   * 记录缓存命中事件。
   * @param {string} taskId - 任务 ID
   * @param {number} [score] - 缓存结果的质量评分
   * @returns {Object} 记录的事件对象
   */
  recordCacheHit(taskId, score) { return this.record('cache-hit', { taskId, score }); }

  /**
   * 记录缓存未命中事件。
   * @param {string} taskId - 任务 ID
   * @returns {Object} 记录的事件对象
   */
  recordCacheMiss(taskId) { return this.record('cache-miss', { taskId }); }

  /**
   * 按事件类型查询事件列表。
   * @param {string} type - 事件类型
   * @returns {Object[]} 匹配类型的事件数组
   */
  getByType(type) { return this._events.filter(e => e.type === type); }

  /**
   * 按执行 ID 查询事件列表。
   * @param {string} executionId - 执行 ID
   * @returns {Object[]} 匹配执行 ID 的事件数组
   */
  getByExecution(executionId) { return this._events.filter(e => e.data && e.data.executionId === executionId); }

  /**
   * 获取指定类型的事件数量。
   * @param {string} type - 事件类型
   * @returns {number} 事件数量
   */
  getEventCountByType(type) { return this._byType[type] ?? 0; }

  /**
   * 获取指定执行 ID 的事件数量。
   * @param {string} executionId - 执行 ID
   * @returns {number} 事件数量
   */
  getEventCountByExecution(executionId) { return this._byExecution[executionId] ?? 0; }

  /**
   * 获取执行时间线。等同于 getByExecution。
   * @param {string} executionId - 执行 ID
   * @returns {Object[]} 事件数组
   */
  getExecutionTimeline(executionId) { return this.getByExecution(executionId); }

  /**
   * 多条件查询事件。
   * @param {Object} [filters] - 过滤条件
   * @param {string} [filters.type] - 按事件类型过滤
   * @param {string} [filters.executionId] - 按执行 ID 过滤
   * @param {number} [filters.since] - 起始时间戳（含）
   * @param {number} [filters.until] - 截止时间戳（含）
   * @returns {Object[]} 匹配条件的事件数组
   */
  query(filters) {
    if (!filters) return this._events.toArray();
    return this._events.filter(e => {
      if (filters.type && e.type !== filters.type) return false;
      if (filters.executionId && (!e.data || e.data.executionId !== filters.executionId)) return false;
      if (filters.since != null && e.timestamp < filters.since) return false;
      if (filters.until != null && e.timestamp > filters.until) return false;
      return true;
    });
  }

  /**
   * 回放指定执行的事件。
   * @param {string} executionId - 执行 ID
   * @param {Function} [callback] - 每个事件的回调函数
   * @returns {number} 回放的事件数量
   */
  replay(executionId, callback) {
    const events = this.getByExecution(executionId);
    events.forEach(e => { if (callback) callback(e); });
    return events.length;
  }

  /**
   * 获取仪表盘数据，包含统计信息、最近事件和执行摘要。
   * @returns {Object} 仪表盘数据 { stats, recentEvents, executionSummaries }
   */
  getDashboard() {
    const executionSummaries = {};
    for (const e of this._events) {
      if (e.data && e.data.executionId) {
        const eid = e.data.executionId;
        if (!executionSummaries[eid]) executionSummaries[eid] = { events: [] };
        executionSummaries[eid].events.push(e);
      }
    }
    return {
      stats: this.getStats(),
      recentEvents: this._events.toArray().slice(-10),
      executionSummaries,
    };
  }

  /**
   * 将事件持久化到磁盘（若启用）。
   * @returns {boolean} 操作结果
   */
  flush() {
    if (this._persistToDisk && this._persistPath) {
      this._writeToDisk();
    }
    return true;
  }

  /**
   * 清空所有事件记录和索引，并持久化到磁盘（若启用）。
   * @returns {boolean} 操作结果
   */
  clear() {
    this._events = new RingBuffer(this._maxEvents);
    this._sequenceNumber = 0;
    this._executionIds.clear();
    this._byType = {};
    this._byExecution = {};
    if (this._persistToDisk && this._persistPath) {
      this._writeToDisk();
    }
    return true;
  }

  /**
   * 关闭时的清理回调。持久化到磁盘（若启用），然后清空所有数据。
   * @protected
   */
  _onShutdown() {
    this._stopAutoFlush();
    if (this._persistToDisk && this._persistPath) {
      this._writeToDisk();
    }
    this._events = new RingBuffer(this._maxEvents);
    this._executionIds.clear();
    this._byType = {};
    this._byExecution = {};
    super._onShutdown();
  }

  _startAutoFlush() {
    const interval = typeof this._autoFlushInterval === 'number' && Number.isFinite(this._autoFlushInterval) ? this._autoFlushInterval : 30000;
    if (interval > 0 && !this._autoFlushTimer) {
      this._autoFlushTimer = setInterval(() => {
        if (this._shutDown) return;
        if (this._unflushedCount > 0) this._autoFlush();
      }, interval);
      if (this._autoFlushTimer && typeof this._autoFlushTimer.unref === 'function') {
        this._autoFlushTimer.unref();
      }
    }
  }

  _stopAutoFlush() {
    if (this._autoFlushTimer) {
      clearInterval(this._autoFlushTimer);
      this._autoFlushTimer = null;
    }
  }

  _autoFlush() {
    try {
      this._writeToDisk();
      this._unflushedCount = 0;
    } catch (e) {
      debug('DeepeningEventStore', 'autoFlush', e);
    }
  }

  /**
   * 获取事件存储运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalEvents - 当前事件总数
   * @returns {number} return.maxEvents - 最大事件容量
   * @returns {number} return.sequenceNumber - 当前序列号
   * @returns {number} return.executionCount - 执行 ID 数量
   */
  getStats() {
    return {
      ...super.getStats(),
      totalEvents: this._events.size,
      maxEvents: this._maxEvents,
      sequenceNumber: this._sequenceNumber,
      executionCount: this._executionIds.size,
    };
  }

  /**
   * 获取持久化文件路径。
   * @returns {string} 文件完整路径
   * @private
   */
  _getPersistFilePath() {
    return path.join(this._persistPath, 'deepening-events.json');
  }

  /**
   * 同步写入事件到磁盘。
   * @emits 'persist-error' 当写入失败时
   * @private
   */
  _writeToDisk() {
    try {
      const filePath = this._getPersistFilePath();
      writeAtomic(filePath, { events: this._events.toArray(), sequenceNumber: this._sequenceNumber });
    } catch (writeErr) { debug('DeepeningEventStore', 'writeToDisk', writeErr); emitError(this, 'persist-error', writeErr, { operation: 'writeSync' }); }
  }

  /**
   * 异步写入事件到磁盘。
   * @emits 'persist-error' 当写入失败时
   * @private
   */
  async _writeToDiskAsync() {
    try {
      const filePath = this._getPersistFilePath();
      await writeAtomicAsync(filePath, { events: this._events.toArray(), sequenceNumber: this._sequenceNumber });
    } catch (writeErr) { debug('DeepeningEventStore', '_writeToDiskAsync', writeErr); emitError(this, 'persist-error', writeErr, { operation: 'writeAsync' }); }
  }

  /**
   * 同步从磁盘加载事件。恢复事件列表、序列号和索引。
   * @emits 'restore-error' 当加载失败时
   * @private
   */
  _loadFromDisk() {
    try {
      const filePath = this._getPersistFilePath();
      const data = loadJsonSync(filePath);
      if (data && Array.isArray(data.events)) {
        const events = data.events.slice(-this._maxEvents);
        this._events = new RingBuffer(this._maxEvents);
        for (const e of events) { this._events.push(e); }
        this._sequenceNumber = data.sequenceNumber ?? events.length;
        for (const e of events) {
          if (e.data && e.data.executionId) {
            this._executionIds.add(e.data.executionId);
            this._byExecution[e.data.executionId] = (this._byExecution[e.data.executionId] ?? 0) + 1;
          }
          if (e.type) {
            this._byType[e.type] = (this._byType[e.type] ?? 0) + 1;
          }
        }
      }
    } catch (loadErr) { debug('DeepeningEventStore', 'loadFromDisk', loadErr); emitError(this, 'restore-error', loadErr, { operation: 'loadSync' }); }
  }

  /**
   * 异步从磁盘加载事件。恢复事件列表、序列号和索引。
   * @emits 'restore-error' 当加载失败时
   * @private
   */
  async _loadFromDiskAsync() {
    try {
      const filePath = this._getPersistFilePath();
      const data = await loadJsonAsync(filePath);
      if (data && Array.isArray(data.events)) {
        const events = data.events.slice(-this._maxEvents);
        this._events = new RingBuffer(this._maxEvents);
        for (const e of events) { this._events.push(e); }
        this._sequenceNumber = data.sequenceNumber ?? events.length;
        for (const e of events) {
          if (e.data && e.data.executionId) {
            this._executionIds.add(e.data.executionId);
            this._byExecution[e.data.executionId] = (this._byExecution[e.data.executionId] ?? 0) + 1;
          }
          if (e.type) {
            this._byType[e.type] = (this._byType[e.type] ?? 0) + 1;
          }
        }
      }
    } catch (loadErr) { debug('DeepeningEventStore', '_loadFromDiskAsync', loadErr); emitError(this, 'restore-error', loadErr, { operation: 'loadAsync' }); }
  }
}

module.exports = DeepeningEventStore;
