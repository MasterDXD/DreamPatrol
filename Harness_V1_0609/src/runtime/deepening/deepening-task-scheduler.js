'use strict';

/**
 * @module runtime/deepening/deepening-task-scheduler
 * 深化推理任务生命周期调度器。支持一次性、延迟、周期性和Cron表达式执行，
 * 强制并发执行限制，提供失败自动重试。管理任务状态转换
 * （pending → running → completed/failed/cancelled），超出容量时淘汰已完成任务。
 * 支持外部触发器（事件驱动）和Cron表达式调度。
 */

const DeepeningBase = require('./deepening-base');
const { requireString_, requireFunction_, ensureSafeTimeout } = require('../../utils/param-validator');
const { counterId, ID_PREFIXES } = require('../../utils/unique-id');
const { HarnessError } = require('../../errors');
const { debug } = require('../../utils/debug-logger');

/**
 * 解析简化Cron表达式（5字段：分 时 日 月 周），计算从now到下一次执行的延迟毫秒数。
 * 支持 *、数字、逗号分隔列表、步长（star/N）。
 * @param {string} expression - Cron表达式（如 "star/5 * * * *" 表示每5分钟）
 * @param {number} [now=Date.now()] - 基准时间戳
 * @returns {number} 到下次执行的延迟毫秒数
 * @throws {HarnessError} 表达式格式无效时抛出
 */
function parseCronNextDelay(expression, now) {
  if (!expression || typeof expression !== 'string') {
    throw new HarnessError('INVALID_INPUT', 'Cron expression must be a non-empty string');
  }
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new HarnessError('INVALID_INPUT', 'Cron expression must have 5 fields (min hour day month weekday), got: ' + parts.length);
  }
  const base = now ?? Date.now();
  const d = new Date(base);
  const fieldParsers = [
    { idx: 0, min: 0, max: 59, apply: (v) => d.setMinutes(v, 0, 0) },
    { idx: 1, min: 0, max: 23, apply: (v) => d.setHours(v) },
    { idx: 2, min: 1, max: 31, apply: (v) => d.setDate(v) },
    { idx: 3, min: 0, max: 11, apply: (v) => d.setMonth(v) },
    { idx: 4, min: 0, max: 6, apply: () => {} },
  ];
  const parsed = [];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    const { min, max } = fieldParsers[i];
    const values = _parseCronField(field, min, max);
    parsed.push(values);
  }
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let attempt = 0; attempt < 366 * 24 * 60; attempt++) {
    const m = d.getMinutes();
    const h = d.getHours();
    const day = d.getDate();
    const month = d.getMonth();
    const wd = d.getDay();
    if (parsed.length >= 5 && parsed[0].includes(m) && parsed[1].includes(h) && parsed[2].includes(day) && parsed[3].includes(month) && parsed[4].includes(wd)) {
      return d.getTime() - base;
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return 60 * 1000;
}

/**
 * 解析单个Cron字段为值数组。
 * @param {string} field - Cron字段字符串
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @returns {number[]} 允许的值数组
 */
function _parseCronField(field, min, max) {
  if (field === '*') {
    const vals = [];
    for (let i = min; i <= max; i++) vals.push(i);
    return vals;
  }
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (!Number.isFinite(step) || step <= 0) return [min];
    const vals = [];
    for (let i = min; i <= max; i += step) vals.push(i);
    return vals;
  }
  const vals = [];
  const segments = field.split(',');
  for (const seg of segments) {
    if (seg.includes('-')) {
      const [lo, hi] = seg.split('-').map(Number);
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        for (let i = Math.max(min, lo); i <= Math.min(max, hi); i++) vals.push(i);
      }
    } else {
      const v = parseInt(seg, 10);
      if (Number.isFinite(v) && v >= min && v <= max) vals.push(v);
    }
  }
  return vals.length > 0 ? vals : [min];
}

/**
 * 深化推理任务生命周期调度器。支持一次性、延迟和周期性执行，
 * 强制并发执行限制，提供失败自动重试。管理任务状态转换
 * （pending → running → completed/failed/cancelled），超出容量时淘汰已完成任务。
 *
 * @classdesc 深化任务调度器。定时调度、优先级调度、依赖调度。
 * @extends DeepeningBase
 */
class DeepeningTaskScheduler extends DeepeningBase {
  /** @constant {Object} 任务状态枚举 */
  static TASK_STATES = { PENDING: 'pending', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' };
  /** @constant {Object} 调度类型枚举 */
  static SCHEDULE_TYPES = { ONCE: 'once', RECURRING: 'recurring', CRON: 'cron' };

  /**
   * 创建 DeepeningTaskScheduler 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxCompletedTasks=200] - 最大已完成任务保留数
   * @param {number} [options.maxConcurrent=10] - 最大并发执行数
   * @param {number} [options.maxTotalTasks=10000] - 最大任务总数
   */
  constructor(options) {
    super(options);
    this._tasks = new Map();
    this._byState = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    this._byName = new Map();
    this._maxCompletedTasks = (options && options.maxCompletedTasks) ?? 200;
    this._maxConcurrent = (options && options.maxConcurrent) ?? 10;
    this._maxTotalTasks = (options && options.maxTotalTasks) ?? 10000;
    this._running = 0;
    this._totalScheduled = 0;
  }

  /**
   * 调度任务。支持一次性、延迟和周期性执行，自动重试失败任务。
   * @param {string} name - 任务名称
   * @param {Function} handler - 任务处理函数
   * @param {Object} [options] - 调度配置
   * @param {string} [options.scheduleType='once'] - 调度类型（once/recurring/cron）
   * @param {number} [options.delay] - 延迟执行毫秒数
   * @param {number} [options.interval] - 周期执行间隔毫秒数
   * @param {number} [options.retries=0] - 失败重试次数
   * @returns {string} 任务ID
   * @throws {HarnessError} 关闭期间调度时抛出异常
   * @emits 'scheduled' 当任务调度成功时触发
   */
  schedule(name, handler, options) {
    requireString_(name, 'Task name');
    requireFunction_(handler, 'Task handler');
    if (this._shutDown) throw new HarnessError('SHUTDOWN_IN_PROGRESS', 'Cannot schedule during shutdown');
    if (this._tasks.size >= this._maxTotalTasks) this._evictCompleted();
    if (this._tasks.size >= this._maxTotalTasks) throw new HarnessError('CAPACITY_EXCEEDED', 'Maximum task count reached: ' + this._maxTotalTasks);
    const opts = options ?? {};
    const id = counterId(ID_PREFIXES.DEEPENING_SCHED);
    const scheduleType = opts.scheduleType ?? 'once';
    const task = { id, name, handler, state: 'pending', scheduleType, interval: opts.interval, cronExpression: opts.cronExpression ?? null, retries: opts.retries ?? 0, retryCount: 0, createdAt: Date.now(), timerId: null, intervalId: null };
    this._tasks.set(id, task);
    this._byState.pending++;
    this._totalScheduled++;
    if (!this._byName.has(name)) this._byName.set(name, []);
    this._byName.get(name).push(task);
    this.emit('scheduled', { name, scheduleType });
    if (scheduleType === 'cron' && opts.cronExpression) {
      this._scheduleCronTask(id, opts.cronExpression);
    } else if (opts.delay != null && opts.delay > 0) {
      task.timerId = setTimeout(() => { if (this._shutDown) return; this._executeWithRetry(id).catch((e) => { this.emit('failed', { id, name: name ?? 'unknown', error: e && e.message ? e.message : 'Unhandled execution error' }); }); }, ensureSafeTimeout(opts.delay));
      if (task.timerId && typeof task.timerId.unref === 'function') task.timerId.unref();
    } else if (opts.delay === 0) {
      this._executeWithRetry(id).catch((e) => { this.emit('failed', { id, name: name ?? 'unknown', error: e && e.message ? e.message : 'Unhandled execution error' }); });
    } else if (scheduleType === 'recurring' && opts.interval) {
      task.intervalId = setInterval(() => { if (this._shutDown) return; this._executeWithRetry(id).catch((e) => { this.emit('failed', { id, name: name ?? 'unknown', error: e && e.message ? e.message : 'Unhandled execution error' }); }); }, ensureSafeTimeout(opts.interval));
      if (task.intervalId && typeof task.intervalId.unref === 'function') task.intervalId.unref();
    } else {
      this._executeWithRetry(id).catch((e) => { this.emit('failed', { id, name: name ?? 'unknown', error: e && e.message ? e.message : 'Unhandled execution error' }); });
    }
    return id;
  }

  /**
   * 带重试的任务执行。在并发限制内执行任务，失败时自动重试。
   * @param {string} id - 任务ID
   * @emits 'started' 当任务开始执行时触发
   * @emits 'completed' 当任务执行成功时触发
   * @emits 'retrying' 当任务重试时触发
   * @emits 'failed' 当任务最终失败时触发
   * @private
   */
  /**
   * 任务执行成功后的状态转换。周期性任务重置为pending，Cron任务重新调度，一次性任务标记完成。
   * @param {string} id - 任务ID
   * @param {Object} task - 任务对象
   * @private
   */
  _transitionAfterSuccess(id, task) {
    this._byState.running = Math.max(0, (this._byState.running ?? 0) - 1);
    if (task.scheduleType === 'recurring') {
      task.state = 'pending';
      this._byState.pending = (this._byState.pending ?? 0) + 1;
    } else if (task.scheduleType === 'cron' && task.cronExpression) {
      task.state = 'pending';
      this._byState.pending = (this._byState.pending ?? 0) + 1;
      this._scheduleCronTask(id, task.cronExpression);
    } else {
      task.state = 'completed';
      this._byState.completed = (this._byState.completed ?? 0) + 1;
    }
  }

  async _executeWithRetry(id) {
    const task = this._tasks.get(id);
    if (!task || task.state === 'cancelled') return;
    if (task.state === 'running') return;
    if (this._running >= this._maxConcurrent) return;
    this._byState[task.state] = Math.max(0, (this._byState[task.state] ?? 0) - 1);
    task.state = 'running';
    this._byState.running = (this._byState.running ?? 0) + 1;
    this._running++;
    this.emit('started', { id, name: task.name });
    let lastError;
    for (let attempt = 0; attempt <= task.retries; attempt++) {
      try {
        if (task.handler) await task.handler();
        if (this._shutDown) return;
        if (task.state === 'cancelled') { this._running--; return; }
        this._transitionAfterSuccess(id, task);
        this.emit('completed', { id, name: task.name });
        this._running--;
        this._evictCompleted();
        this._scheduleNext();
        return;
      } catch (e) {
        lastError = e;
        task.retryCount++;
        if (attempt < task.retries) {
          this.emit('retrying', { name: task.name, retryCount: task.retryCount });
        }
      }
    }
    this._byState.running = Math.max(0, (this._byState.running ?? 0) - 1);
    task.state = 'failed';
    this._byState.failed = (this._byState.failed ?? 0) + 1;
    this.emit('failed', { id, name: task.name, error: lastError ? (lastError.message || String(lastError)) : 'Unknown error' });
    this._running--;
    this._evictCompleted();
    this._scheduleNext();
  }

  /**
   * 调度下一个待执行任务。在并发限制内启动 pending 状态的任务。
   * @private
   */
  _scheduleNext() {
    if (this._shutDown) return;
    if (this._running >= this._maxConcurrent) return;
    for (const [, t] of this._tasks) {
      if (t.state === 'pending' && t.scheduleType !== 'recurring' && this._running < this._maxConcurrent) {
        this._executeWithRetry(t.id).catch((e) => { this.emit('failed', { id: t.id, name: t.name ?? 'unknown', error: e && e.message ? e.message : 'Unhandled execution error' }); });
      }
    }
  }

  /**
   * 取消指定任务。清理定时器和间隔器。
   * @param {string} id - 任务ID
   * @returns {boolean} 取消成功返回 true，任务不存在返回 false
   * @emits 'cancelled' 当任务取消时触发
   */
  cancel(id) {
    this.guardShutdown();
    const task = this._tasks.get(id);
    if (!task) return false;
    if (task.timerId) clearTimeout(task.timerId);
    if (task.intervalId) clearInterval(task.intervalId);
    this._byState[task.state] = Math.max(0, (this._byState[task.state] ?? 0) - 1);
    task.state = 'cancelled';
    this._byState.cancelled = (this._byState.cancelled ?? 0) + 1;
    this.emit('cancelled', { name: task.name });
    return true;
  }

  /**
   * 按名称取消所有待执行任务。
   * @param {string} name - 任务名称
   * @returns {number} 取消的任务数量
   * @emits 'cancelled' 当每个任务取消时触发
   */
  cancelByName(name) {
    this.guardShutdown();
    const tasks = this._byName.get(name);
    if (!tasks) return 0;
    let cancelled = 0;
    for (const task of tasks) {
      if (task.state === 'pending') {
        this._byState.pending--;
        task.state = 'cancelled';
        this._byState.cancelled++;
        if (task.timerId) clearTimeout(task.timerId);
        if (task.intervalId) clearInterval(task.intervalId);
        cancelled++;
        this.emit('cancelled', { name });
      }
    }
    return cancelled;
  }

  /**
   * 使用Cron表达式调度任务的下一次执行。计算到下次触发时间的延迟并设置定时器。
   * @param {string} id - 任务ID
   * @param {string} cronExpression - Cron表达式
   * @private
   */
  _scheduleCronTask(id, cronExpression) {
    const task = this._tasks.get(id);
    if (!task || this._shutDown) return;
    try {
      const delay = parseCronNextDelay(cronExpression);
      if (task.timerId) clearTimeout(task.timerId);
      task.timerId = setTimeout(() => {
        if (this._shutDown) return;
        this._executeWithRetry(id).catch((e) => {
          this.emit('failed', { id, name: task.name, error: e && e.message ? e.message : 'Unhandled execution error' });
        });
      }, ensureSafeTimeout(delay));
      if (task.timerId && typeof task.timerId.unref === 'function') task.timerId.unref();
      this.emit('cron-scheduled', { id, name: task.name, nextDelay: delay });
    } catch (err) {
      debug('DeepeningTaskScheduler', '_scheduleCronTask', err && err.message ? err.message : String(err));
      this.emit('cron-parse-error', { id, expression: cronExpression, error: err && err.message ? err.message : String(err) });
    }
  }

  /**
   * 外部触发器：立即执行指定名称的任务（无论其当前调度状态）。
   * 适用于事件驱动场景，如文件变更、webhook回调等外部触发。
   * @param {string} name - 任务名称
   * @param {Object} [context] - 传递给任务处理函数的上下文数据
   * @returns {boolean} 是否成功触发（找到任务且未关闭时返回true）
   * @emits 'triggered' 当任务被外部触发时触发
   */
  trigger(name, context) {
    this.guardShutdown();
    requireString_(name, 'Task name');
    const tasks = this._byName.get(name);
    if (!tasks || tasks.length === 0) return false;
    const task = tasks[tasks.length - 1];
    if (task.state === 'cancelled') return false;
    const originalHandler = task.handler;
    task.handler = async () => {
      if (originalHandler) await originalHandler(context);
    };
    this.emit('triggered', { id: task.id, name, source: 'external' });
    this._executeWithRetry(task.id).catch((e) => {
      this.emit('failed', { id: task.id, name, error: e && e.message ? e.message : 'Unhandled execution error' });
    });
    return true;
  }

  /**
   * 获取指定任务的摘要信息。
   * @param {string} id - 任务ID
   * @returns {Object|null} 任务摘要对象，包含 id、name、state、scheduleType、interval、retries、retryCount、createdAt
   */
  getTask(id) {
    const t = this._tasks.get(id);
    if (!t) return null;
    return { id: t.id, name: t.name, state: t.state, scheduleType: t.scheduleType, interval: t.interval, retries: t.retries, retryCount: t.retryCount, createdAt: t.createdAt };
  }

  /**
   * 获取所有待执行任务列表。
   * @returns {Object[]} 待执行任务摘要数组
   */
  getPending() {
    const result = [];
    for (const t of this._tasks.values()) { if (t.state === 'pending') result.push({ id: t.id, name: t.name, state: t.state, scheduleType: t.scheduleType, createdAt: t.createdAt }); }
    return result;
  }

  /**
   * 获取所有正在执行的任务列表。
   * @returns {Object[]} 正在执行的任务摘要数组
   */
  getRunning() {
    const result = [];
    for (const t of this._tasks.values()) { if (t.state === 'running') result.push({ id: t.id, name: t.name, state: t.state, scheduleType: t.scheduleType, createdAt: t.createdAt }); }
    return result;
  }

  /**
   * 按名称获取任务列表。
   * @param {string} name - 任务名称
   * @returns {Object[]} 匹配名称的任务数组
   */
  getByName(name) { return (this._byName.get(name) ?? []).slice(); }

  /**
   * 获取任务调度器统计信息。
   * @returns {Object} 统计对象，包含 totalTasks、totalScheduled、running、maxConcurrent、byState
   */
  getStats() {
    return { totalTasks: this._tasks.size, totalScheduled: this._totalScheduled, running: this._running, maxConcurrent: this._maxConcurrent, byState: { ...this._byState }, ...super.getStats() };
  }

  /**
   * 关闭时清理所有定时器和间隔器。
   * @protected
   */
  _onShutdown() {
    for (const [, t] of this._tasks) { if (t.timerId) clearTimeout(t.timerId); if (t.intervalId) clearInterval(t.intervalId); }
    this._tasks.clear();
    this._byName.clear();
    this._byState = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    super._onShutdown();
  }

  /**
   * 从名称索引中移除任务引用。
   * @param {Object} task - 任务对象
   * @private
   */
  _removeFromByName(task) {
    const arr = this._byName.get(task.name);
    if (!arr) return;
    const idx = arr.indexOf(task);
    if (idx !== -1) arr.splice(idx, 1);
    if (arr.length === 0) this._byName.delete(task.name);
  }

  /**
   * 淘汰已完成的任务。超出容量时按序删除 completed/failed/cancelled 任务。
   * @private
   */
  _evictCompleted() {
    if (this._tasks.size <= this._maxCompletedTasks) return;
    const toDelete = [];
    for (const [id, t] of this._tasks) {
      if (t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled') {
        this._byState[t.state] = Math.max(0, (this._byState[t.state] ?? 0) - 1);
        this._removeFromByName(t);
        toDelete.push(id);
        if (this._tasks.size - toDelete.length <= this._maxCompletedTasks) break;
      }
    }
    for (const id of toDelete) {
      this._tasks.delete(id);
    }
  }
}

module.exports = DeepeningTaskScheduler;
