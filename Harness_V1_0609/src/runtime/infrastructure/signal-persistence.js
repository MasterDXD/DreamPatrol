'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { createPersister, sanitize: sanitizeData } = require('../../utils/debounced-persister');
const { debug } = require('../../utils/debug-logger');
const { ensureDirSync, ensureDirAsync } = require('../../utils/fs-utils');
const { MS_PER_DAY, HARNESS_DIR, DEFAULT_PERSIST_DEBOUNCE_MS } = require('../../utils/constants');
const { mergeConfig } = require('../../utils/safe-assign');
const JsonStoreRestorer = require('../../utils/json-store-restorer');
const RingBuffer = require('../../utils/ring-buffer');
const { timestampId } = require('../../utils/unique-id');
const { withShutdown } = require('../../utils/shutdown-mixin');
// 使用safeDateGetTime替代new Date(x).getTime()防止RangeError
const { roundTo, emitError, safeExecute, safeStringify, safeDateGetTime } = require('../../utils/safe-execute');

const SIGNAL_CATEGORIES = {
  CONVERGENCE: 'convergence',
  QUALITY: 'quality',
  REFLECTION: 'reflection',
  HEALTH: 'health',
  AGENDA: 'agenda',
};

const VALID_CATEGORIES = new Set(Object.values(SIGNAL_CATEGORIES));
const DEFAULT_TTL_DAYS = 30;
const MAX_SIGNALS_PER_CATEGORY = 500;
const SIGNAL_DIR_NAME = 'signals';
const MAX_SIGNAL_SIZE_BYTES = 65536;

/**
 * @module runtime/infrastructure/signal-persistence
 * SignalPersistence — 信号持久化管理器
 * 按类别（convergence/quality/reflection/health/agenda）记录和持久化运行时信号，
 * 支持TTL过期清理、批量记录、趋势分析、按时间范围查询和信号清除。
 * 数据通过防抖持久化器原子写入磁盘，启动时自动恢复并过滤过期条目。
 * @classdesc 信号持久化。进程信号处理、状态保存
 * @extends EventEmitter
 */
class SignalPersistence extends EventEmitter {
  /**
   * 创建 SignalPersistence 实例。自动初始化持久化存储并恢复历史信号。
   * @param {Object} options - 配置选项
   * @param {string} [options.projectRoot] - 项目根目录路径，提供时启用磁盘持久化
   * @param {number} [options.ttlDays=30] - 信号TTL天数，过期信号在恢复时自动过滤
   * @param {number} [options.maxPerCategory=500] - 每个类别的最大信号数，范围为10-5000
   */
  constructor(options) {
    super();
    this._root = (options && options.projectRoot) ?? null;
    this._signalDir = this._root ? path.join(this._root, HARNESS_DIR, SIGNAL_DIR_NAME) : null;
    this._ttlDays = Math.max(1, (options && options.ttlDays) ?? DEFAULT_TTL_DAYS);
    this._maxPerCategory = Math.max(10, Math.min(5000, (options && options.maxPerCategory) ?? MAX_SIGNALS_PER_CATEGORY));
    this._signals = {};
    this._persister = null;
    this._stats = { recorded: 0, restored: 0, expired: 0, errors: 0, rejected: 0 };
    this._initialized = false;
    VALID_CATEGORIES.forEach(cat => {
      this._signals[cat] = new RingBuffer(this._maxPerCategory);
    });
    if (this._root) {
      this._readyPromise = this._initPersistenceAsync().catch(err => {
        debug('SignalPersistence', 'initPersistence', err);
      });
    } else {
      this._initialized = true;
      this._readyPromise = Promise.resolve();
    }
  }

  /**
   * 获取持久化初始化完成的 Promise。用于等待异步初始化完成后再进行操作。
   * @type {Promise<void>}
   */
  get ready() {
    return this._readyPromise;
  }

  async _initPersistenceWith({ ensureDirFn, restoreFn } = {}) {
    if (this._initialized) return;
    try {
      const dir = this._signalDir;
      await ensureDirFn(dir);
      await restoreFn.call(this);
      this._persister = createPersister({
        root: this._root,
        dir: SIGNAL_DIR_NAME,
        filename: 'signal-store.json',
        debounceMs: DEFAULT_PERSIST_DEBOUNCE_MS,
        serialize: () => this._serializeState(),
        onError: (err) => {
          debug('SignalPersistence', 'persist error', err);
          this._stats.errors++;
          emitError(this, 'persist-error', err);
        },
      });
      this._initialized = true;
      this.emit('initialized');
    } catch (err) {
      debug('SignalPersistence', '_initPersistence', err);
      this._stats.errors++;
      this._initError = err;
    }
  }

  _initPersistence() {
    return this._initPersistenceWith({ ensureDirFn: (d) => ensureDirSync(d), restoreFn: this._restore });
  }

  async _initPersistenceAsync() {
    return this._initPersistenceWith({ ensureDirFn: ensureDirAsync, restoreFn: this._restoreAsync });
  }

  _serializeState() {
    const signalsArrays = {};
    for (const cat of Object.keys(this._signals)) {
      signalsArrays[cat] = this._signals[cat].toArray ? this._signals[cat].toArray() : this._signals[cat];
    }
    return {
      signals: signalsArrays,
      savedAt: new Date().toISOString(),
      version: 1,
    };
  }

  async _restoreWith(loader) {
    try {
      const result = await loader();
      if (!result) return;
      const data = result.data;
      if (!data.signals || typeof data.signals !== 'object') return;
      const now = Date.now();
      const ttlMs = this._ttlDays * MS_PER_DAY;
      for (const cat of VALID_CATEGORIES) {
        if (Array.isArray(data.signals[cat])) {
          const restored = data.signals[cat].filter(function(s) {
            if (!s || typeof s !== 'object') return false;
            const ts = s.timestamp ? safeDateGetTime(s.timestamp) : 0;
            if (isNaN(ts)) return false;
            const age = now - ts;
            if (age > ttlMs) {
              this._stats.expired++;
              return false;
            }
            return true;
          }.bind(this));
          const rb = new RingBuffer(this._maxPerCategory);
          restored.slice(-this._maxPerCategory).forEach(item => rb.push(item));
          this._signals[cat] = rb;
          this._stats.restored += rb.size;
        }
      }
      this.emit('restored', { restored: this._stats.restored, expired: this._stats.expired });
    } catch (err) {
      debug('SignalPersistence', '_restore', err);
      this._stats.errors++;
      this._restoreError = err;
      emitError(this, 'restore-error', err);
    }
  }

  _restore() {
    return this._restoreWith(() => JsonStoreRestorer.loadSync(this._root, SIGNAL_DIR_NAME + '/signal-store.json', {
      expectedType: 'object',
      logLabel: 'SignalPersistence',
      sanitize: sanitizeData,
    }));
  }

  async _restoreAsync() {
    return this._restoreWith(() => JsonStoreRestorer.loadAsync(this._root, SIGNAL_DIR_NAME + '/signal-store.json', {
      expectedType: 'object',
      logLabel: 'SignalPersistence',
    }));
  }

  /**
   * 延迟附加项目根目录。仅在实例创建时未提供 projectRoot 时有效，否则静默跳过。
   * @param {string} projectRoot - 项目根目录路径
   * @returns {SignalPersistence} 返回 this 以支持链式调用
   */
  attachProjectRoot(projectRoot) {
    if (this._root) return this;
    if (!projectRoot || typeof projectRoot !== 'string') {
      debug('SignalPersistence', 'attachProjectRoot: invalid projectRoot');
      return this;
    }
    this._root = projectRoot;
    this._initPersistence();
    return this;
  }

  /**
   * 记录单个信号到指定类别。自动补充时间戳和唯一ID，信号大小超过限制时拒绝。
   * @param {string} category - 信号类别，必须为 convergence/quality/reflection/health/agenda 之一
   * @param {Object} signal - 信号数据对象，须为非null对象且可序列化
   * @param {string} [signal.timestamp] - 信号时间戳，缺失时自动生成
   * @returns {{success: boolean, id?: string, error?: string}} 记录结果
   */
  record(category, signal) {
    if (!this.isHealthy()) {
      return { success: false, error: 'SignalPersistence is shut down' };
    }
    if (!this._initialized) return { success: false, error: 'SignalPersistence not initialized' };
    if (!VALID_CATEGORIES.has(category)) {
      this._stats.rejected++;
      return { success: false, error: 'Invalid category: ' + category };
    }
    if (!signal || typeof signal !== 'object') {
      this._stats.rejected++;
      return { success: false, error: 'Signal must be a non-null object' };
    }
    try {
      const serialized = safeStringify(signal);
      if (serialized.includes('[Circular]')) {
        this._stats.rejected++;
        return { success: false, error: 'Signal is not serializable: contains circular reference' };
      }
      if (serialized.length > MAX_SIGNAL_SIZE_BYTES) {
        this._stats.rejected++;
        return { success: false, error: 'Signal exceeds maximum size of ' + MAX_SIGNAL_SIZE_BYTES + ' bytes' };
      }
    } catch (err) {
      this._stats.rejected++;
      return { success: false, error: 'Signal is not serializable: ' + (err && err.message ? err.message : String(err)) };
    }
    if (!signal.timestamp) {
      signal = mergeConfig(signal, { timestamp: new Date().toISOString() });
    } else if (isNaN(safeDateGetTime(signal.timestamp))) {
      signal = mergeConfig(signal, { timestamp: new Date().toISOString() });
    }
    const entry = mergeConfig({
      _id: timestampId(),
    }, signal);
    if (!this._signals[category]) {
      this._signals[category] = new RingBuffer(this._maxPerCategory);
    }
    this._signals[category].push(entry);
    this._stats.recorded++;
    this._schedulePersist();
    this.emit('signal-recorded', { category: category, id: entry._id });
    return { success: true, id: entry._id };
  }

  /**
   * 批量记录信号到指定类别。单次最多100条，逐条调用 record 方法。
   * @param {string} category - 信号类别
   * @param {Object[]} signals - 信号数据对象数组
   * @returns {{success: boolean, count: number, failed: number}} 批量记录结果
   */
  recordBatch(category, signals) {
    if (!this.isHealthy()) {
      return { success: false, error: 'SignalPersistence is shut down' };
    }
    if (!this._initialized) return { success: false, error: 'SignalPersistence not initialized' };
    if (!VALID_CATEGORIES.has(category)) {
      return { success: false, error: 'Invalid category: ' + category };
    }
    if (!Array.isArray(signals)) {
      return { success: false, error: 'signals must be an array' };
    }
    if (signals.length > 100) {
      return { success: false, error: 'Batch size exceeds maximum of 100' };
    }
    let successCount = 0;
    let failCount = 0;
    for (const s of signals) {
      const result = this.record(category, s);
      if (result.success) successCount++;
      else failCount++;
    }
    return { success: true, count: successCount, failed: failCount };
  }

  /**
   * 查询信号记录。可按类别、时间范围、数量限制和自定义过滤器进行查询。
   * 不指定类别时返回所有类别的信号映射。
   * @param {string} [category] - 信号类别，省略时返回所有类别
   * @param {Object} [options] - 查询选项
   * @param {string|number|Date} [options.since] - 起始时间，仅返回此时间之后的信号
   * @param {string|number|Date} [options.until] - 截止时间，仅返回此时间之前的信号
   * @param {number} [options.limit] - 返回的最大数量
   * @param {Function} [options.filter] - 自定义过滤函数，签名为 (signal: Object) => boolean
   * @returns {Object[]|Object<string, Object[]>} 指定类别时返回信号数组，不指定时返回类别到信号数组的映射
   */
  query(category, options) {
    const opts = options ?? {};
    if (category) {
      if (!VALID_CATEGORIES.has(category)) return [];
      if (!this._signals[category]) return [];
      let results = this._signals[category].toArray();
      if (opts.since) {
        const sinceTs = safeDateGetTime(opts.since);
        if (!isNaN(sinceTs)) {
          results = results.filter(function(s) {
            const st = safeDateGetTime(s.timestamp);
            return Number.isFinite(st) && st >= sinceTs;
          });
        }
      }
      if (opts.until) {
        const untilTs = safeDateGetTime(opts.until);
        if (!isNaN(untilTs)) {
          results = results.filter(function(s) {
            const st = safeDateGetTime(s.timestamp);
            return Number.isFinite(st) && st <= untilTs;
          });
        }
      }
      if (opts.limit && typeof opts.limit === 'number' && opts.limit > 0) {
        results = results.slice(-Math.min(opts.limit, this._maxPerCategory));
      }
      if (opts.filter && typeof opts.filter === 'function') {
        results = safeExecute(() => results.filter(opts.filter), 'SignalPersistence', 'queryFilter', results);
      }
      return results;
    }
    const all = {};
    const limit = opts?.limit ?? this._maxPerCategory;
    for (const cat of Object.keys(this._signals)) {
      all[cat] = this._signals[cat].toArray().slice(-Math.min(limit, this._maxPerCategory));
    }
    return all;
  }

  /**
   * 获取指定类别和字段的趋势分析。将最近窗口期内的信号按字段值分为前后两半，
   * 比较平均值判断趋势方向（improving/stable/degrading）。
   * @param {string} category - 信号类别
   * @param {string} field - 要分析的字段名，支持点号分隔的嵌套路径
   * @param {number} [windowSize=10] - 分析窗口大小，范围为2-100
   * @returns {{trend: string, delta?: number, avgCurrent?: number, values: number[]}} 趋势分析结果
   */
  getTrend(category, field, windowSize) {
    if (!VALID_CATEGORIES.has(category)) {
      return { trend: 'invalid_category', values: [] };
    }
    if (!field || typeof field !== 'string') {
      return { trend: 'invalid_field', values: [] };
    }
    const signals = this._signals[category];
    if (!signals || signals.size < 2) return { trend: 'insufficient_data', values: [] };
    const ws = Math.max(2, Math.min(100, windowSize ?? 10));
    const window = signals.toArray().slice(-ws);
    const values = window.map(function(s) {
      if (!s) return 0;
      const val = field.split('.').reduce(function(o, k) { return o && o[k]; }, s);
      const parsed = parseFloat(val);
      return typeof val === 'number' && Number.isFinite(val) ? val : (Number.isFinite(parsed) ? parsed : 0);
    });
    if (values.length < 2) return { trend: 'insufficient_data', values: values };
    const firstHalf = values.slice(0, Math.floor(values.length / 2));
    const secondHalf = values.slice(Math.floor(values.length / 2));
    const avgFirst = firstHalf.reduce(function(a, b) { return a + b; }, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce(function(a, b) { return a + b; }, 0) / secondHalf.length;
    const delta = avgSecond - avgFirst;
    let trend;
    if (delta > 0.05) trend = 'improving';
    else if (delta < -0.05) trend = 'degrading';
    else trend = 'stable';
    return { trend: trend, delta: roundTo(delta, 3), avgCurrent: roundTo(avgSecond, 3), values: values };
  }

  /**
   * 获取信号数量。指定类别时返回该类别的信号数，不指定时返回所有类别的总信号数。
   * @param {string} [category] - 信号类别
   * @returns {number} 信号数量
   */
  getSignalCount(category) {
    if (category) {
      if (!VALID_CATEGORIES.has(category)) return 0;
      return this._signals[category] ? this._signals[category].size : 0;
    }
    return Object.values(this._signals).reduce((total, rb) => total + rb.size, 0);
  }

  /**
   * 清除指定时间之前的过期信号。可按类别清除或全量清除。
   * @param {string} [category] - 信号类别，省略时清除所有类别
   * @param {string|number|Date} olderThan - 时间阈值，早于此时间的信号将被清除
   * @returns {number} 被清除的信号数量
   */
  purge(category, olderThan) {
    if (!olderThan) return 0;
    const cutoff = safeDateGetTime(olderThan);
    if (isNaN(cutoff)) return 0;
    let purged = 0;
    if (category) {
      if (!VALID_CATEGORIES.has(category) || !this._signals[category]) return 0;
      const before = this._signals[category].size;
      const filtered = this._signals[category].filter(function(s) {
        const st = safeDateGetTime(s.timestamp);
        return Number.isFinite(st) && st >= cutoff;
      });
      const rb = new RingBuffer(this._maxPerCategory);
      filtered.forEach(item => rb.push(item));
      this._signals[category] = rb;
      purged = before - this._signals[category].size;
    } else {
      Object.keys(this._signals).forEach(cat => {
        const before = this._signals[cat].size;
        const filtered = this._signals[cat].filter(function(s) { const st = safeDateGetTime(s.timestamp); return Number.isFinite(st) && st >= cutoff; });
        const rb = new RingBuffer(this._maxPerCategory);
        filtered.forEach(item => rb.push(item));
        this._signals[cat] = rb;
        purged += before - this._signals[cat].size;
      });
    }
    if (purged > 0) {
      this._stats.expired += purged;
      this._schedulePersist();
    }
    return purged;
  }

  _schedulePersist() {
    if (this._persister) {
      this._persister.schedule();
    }
  }

  /**
   * 立即将当前信号状态持久化到磁盘。
   * @returns {void}
   */
  flush() {
    if (this._persister) {
      this._persister.persistNow();
    }
  }

  /**
   * 获取信号持久化管理器的运行统计数据。
   * @returns {{totalSignals: number, byCategory: Object<string, number>, recorded: number, restored: number, expired: number, errors: number, rejected: number, persistenceEnabled: boolean, initialized: boolean, ttlDays: number}} 统计信息对象
   */
  getStats() {
    const byCategory = {};
    for (const cat of Object.keys(this._signals)) {
      byCategory[cat] = this._signals[cat].size;
    }
    return {
      totalSignals: this.getSignalCount(),
      byCategory: byCategory,
      recorded: this._stats.recorded,
      restored: this._stats.restored,
      expired: this._stats.expired,
      errors: this._stats.errors,
      rejected: this._stats.rejected,
      persistenceEnabled: !!this._persister,
      initialized: this._initialized,
      ttlDays: this._ttlDays,
    };
  }

  _onShutdown() {
    if (this._persister) {
      this._persister.flush();
      this._persister = null;
    }
    for (const cat of Object.keys(this._signals)) {
      if (this._signals[cat] && typeof this._signals[cat].clear === 'function') {
        this._signals[cat].clear();
      } else {
        this._signals[cat] = new RingBuffer(this._maxPerCategory);
      }
    }
    this._initialized = false;
    this.removeAllListeners();
  }
}

SignalPersistence = withShutdown(SignalPersistence);

SignalPersistence.SIGNAL_CATEGORIES = SIGNAL_CATEGORIES;

module.exports = SignalPersistence;
