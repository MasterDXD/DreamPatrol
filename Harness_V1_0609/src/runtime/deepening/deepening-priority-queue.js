'use strict';
const DeepeningBase = require('./deepening-base');
const { DeepeningError } = require('../../errors');
const MinHeap = require('../../utils/min-heap');
const { counterId, ID_PREFIXES } = require('../../utils/unique-id');
const { DEFAULT_MAX_ENTRIES } = require('../../utils/constants');

/**
 * @module runtime/deepening/deepening-priority-queue
 * 优先级任务队列。管理五级优先级（CRITICAL/HIGH/NORMAL/LOW/IDLE）的任务调度，
 * 支持延迟入队、取消、暂停/恢复、并发控制和溢出保护。
 * @deprecated 请使用 runtime/infrastructure/priority-queue 中的 PriorityQueue 替代
 */

/**
 * 优先级任务队列 — 为深化管道提供基于优先级的任务调度能力。
 * 管理五级优先级（CRITICAL/HIGH/NORMAL/LOW/IDLE）的任务调度，
 * 支持延迟入队、取消、暂停/恢复、并发控制和溢出保护。
 *
 * @classdesc 深化优先级队列。堆实现、优先级调度。
 * @extends DeepeningBase
 * @emits 'enqueued' 当任务入队时触发，附带 {id, name, priority}
 * @emits 'overflow' 当队列溢出时触发，附带 {task}
 * @emits 'cancelled' 当任务取消时触发，附带 {id}
 * @emits 'paused' 当队列暂停时触发
 * @emits 'resumed' 当队列恢复时触发
 * @emits 'cleared' 当队列清空时触发
 * @deprecated 请使用 runtime/infrastructure/priority-queue 中的 PriorityQueue 替代
 */
class DeepeningPriorityQueue extends DeepeningBase {
  /**
   * 优先级级别枚举。
   * @constant {Object}
   * @property {number} CRITICAL - 关键优先级（0）
   * @property {number} HIGH - 高优先级（1）
   * @property {number} NORMAL - 普通优先级（2）
   * @property {number} LOW - 低优先级（3）
   * @property {number} IDLE - 空闲优先级（4）
   */
  static PRIORITY_LEVELS = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3, IDLE: 4 };

  /**
   * 创建 DeepeningPriorityQueue 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxSize] - 队列最大容量，默认 DEFAULT_MAX_ENTRIES
   * @param {number} [options.concurrency=1] - 并发数
   */
  constructor(options) {
    super(options);
    DeepeningPriorityQueue._warnDeprecated('DeepeningPriorityQueue', 'PriorityQueue from runtime/infrastructure/priority-queue', 'deepening-priority-queue');
    this._heap = new MinHeap((a, b) => a.priority - b.priority);
    this._entries = new Map();
    this._maxSize = (options && options.maxSize) ?? DEFAULT_MAX_ENTRIES;
    this._concurrency = (options && options.concurrency) ?? 1;
    this._paused = false;
    this._running = 0;
    this._pendingCount = 0;
    this._pendingByPriority = {};
  }

  /**
   * 将任务入队。
   * @param {Object} task - 任务对象，必须包含 name 或 id
   * @param {Object} [options] - 入队选项
   * @param {number} [options.priority=2] - 优先级（0-4）
   * @param {number} [options.delay=0] - 延迟时间（毫秒），延迟期间不可出队
   * @returns {string|null} 任务条目ID，队列溢出返回 null
   * @throws {DeepeningError} 当 task 缺失或无 name/id 时抛出 MISSING_PARAMETER 异常
   * @emits 'enqueued' 任务入队时触发，附带 {id, name, priority}
   * @emits 'overflow' 队列溢出时触发，附带 {task}
   */
  enqueue(task, options) {
    if (!task || typeof task !== 'object') throw new DeepeningError('MISSING_PARAMETER', 'Task object is required');
    if (!task.name && !task.id) throw new DeepeningError('MISSING_PARAMETER', 'Task must have a name or id');
    const opts = options ?? {};
    if (this._entries.size >= this._maxSize) { this.emit('overflow', { task }); return null; }
    const id = counterId(ID_PREFIXES.DEEPENING_PQ);
    const entry = { id, task, name: task.name, priority: opts.priority !== undefined ? opts.priority : 2, createdAt: Date.now(), delay: opts.delay ?? 0, cancelled: false };
    this._heap.push(entry);
    this._entries.set(id, entry);
    this._pendingCount++;
    this._pendingByPriority[entry.priority] = (this._pendingByPriority[entry.priority] ?? 0) + 1;
    this.emit('enqueued', { id: entry.id, name: entry.name, priority: entry.priority });
    return entry.id;
  }

  /**
   * 从队列中出队最高优先级且可执行的任务。
   * @returns {Object|null} 任务条目 {id, task, name, priority, createdAt}，无可用任务返回 null
   */
  dequeue() {
    if (this._paused) return null;
    const now = Date.now();
    let attempts = 0;
    const maxAttempts = this._heap.size;
    while (this._heap.size > 0 && attempts < maxAttempts) {
      attempts++;
      const entry = this._heap.pop();
      if (entry.cancelled) { this._entries.delete(entry.id); continue; }
      if (entry.delay > 0 && now - entry.createdAt < entry.delay) {
        this._heap.push(entry);
        continue;
      }
      this._entries.delete(entry.id);
      this._pendingCount--;
      const p = entry.priority;
      if (this._pendingByPriority[p] > 1) this._pendingByPriority[p]--; else delete this._pendingByPriority[p];
      return entry;
    }
    return null;
  }

  /**
   * 查看队列中下一个可执行的任务（不出队）。
   * @returns {Object|null} 下一个可执行任务条目，无可用任务返回 null
   */
  peek() {
    const now = Date.now();
    const items = this._heap.toArray();
    for (const entry of items) {
      if (entry.cancelled) continue;
      if (entry.delay > 0 && now - entry.createdAt < entry.delay) continue;
      return entry;
    }
    return null;
  }

  /**
   * 取消指定任务。
   * @param {string} id - 任务条目ID
   * @returns {boolean} 取消成功返回 true，任务不存在返回 false
   * @emits 'cancelled' 任务取消时触发，附带 {id}
   */
  cancel(id) {
    const entry = this._entries.get(id);
    if (!entry) return false;
    entry.cancelled = true;
    this._entries.delete(id);
    this._pendingCount--;
    const p = entry.priority;
    if (this._pendingByPriority[p] > 1) this._pendingByPriority[p]--; else delete this._pendingByPriority[p];
    this.emit('cancelled', { id });
    return true;
  }

  /**
   * 获取指定ID的任务对象。
   * @param {string} id - 任务条目ID
   * @returns {Object|null} 任务对象，不存在返回 null
   */
  getTask(id) { const e = this._entries.get(id); return e ? { ...e.task } : null; }

  /**
   * 暂停队列出队操作。
   * @returns {boolean} 暂停成功返回 true
   * @emits 'paused' 队列暂停时触发
   */
  pause() { this._paused = true; this.emit('paused'); return true; }

  /**
   * 恢复队列出队操作。
   * @returns {boolean} 恢复成功返回 true
   * @emits 'resumed' 队列恢复时触发
   */
  resume() { this._paused = false; this.emit('resumed'); return true; }

  /**
   * 检查队列是否已暂停。
   * @returns {boolean} 已暂停返回 true
   */
  isPaused() { return this._paused; }

  /**
   * 获取待处理任务数量。
   * @returns {number} 待处理任务数
   */
  getPendingCount() { return this._pendingCount; }

  /**
   * 获取指定优先级的所有待处理任务。
   * @param {number} level - 优先级级别（0-4）
   * @returns {Array<Object>} 任务条目数组
   */
  getByPriority(level) { const result = []; for (const e of this._entries.values()) { if (e.priority === level && !e.cancelled) result.push({ ...e }); } return result; }

  /**
   * 清空队列中所有任务。
   * @returns {boolean} 清空成功返回 true
   * @emits 'cleared' 队列清空时触发
   */
  clear() { this._heap.clear(); this._entries.clear(); this._pendingCount = 0; this._pendingByPriority = {}; this.emit('cleared'); return true; }

  /**
   * 获取队列当前大小（待处理任务数）。
   * @returns {number} 待处理任务数
   */
  getSize() { return this.getPendingCount(); }

  /**
   * 获取优先级队列的运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.pending - 待处理任务数
   * @returns {number} return.running - 运行中任务数
   * @returns {number} return.maxSize - 队列最大容量
   * @returns {number} return.concurrency - 并发数
   * @returns {boolean} return.paused - 是否暂停
   * @returns {Object} return.pendingByPriority - 各优先级待处理数
   */
  getStats() {
    return { pending: this._pendingCount, running: this._running, maxSize: this._maxSize, concurrency: this._concurrency, paused: this._paused, pendingByPriority: { ...this._pendingByPriority }, ...super.getStats() };
  }
}

module.exports = DeepeningPriorityQueue;
