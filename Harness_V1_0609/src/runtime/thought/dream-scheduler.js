'use strict';

const { EventEmitter } = require('events');
const { safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const SM2_MIN_INTERVAL = 1;
const SM2_MAX_INTERVAL = 365;
const SM2_EASY_BONUS = 1.3;
const SM2_HARD_MULTIPLIER = 0.8;
const SM2_TARGET_RETENTION = 0.9;

function _sm2ComputeNextInterval(stability, performance) {
  if (performance >= 0.9) {
    stability = stability * SM2_EASY_BONUS * 2.5;
  } else if (performance >= 0.6) {
    stability = stability * 2.0;
  } else {
    stability = stability * SM2_HARD_MULTIPLIER;
  }
  stability = Math.max(SM2_MIN_INTERVAL, Math.min(stability, SM2_MAX_INTERVAL));
  const intervalMs = -stability * 24 * 60 * 60 * 1000 * Math.log(SM2_TARGET_RETENTION);
  return Math.max(SM2_MIN_INTERVAL * 60 * 1000, intervalMs);
}

/**
 * @module runtime/thought/dream-scheduler
 * @classdesc 做梦调度器（DreamScheduler）—— 自动周期性触发DreamEngine回顾历史会话，
 * 会话结束时自动提炼经验，定时批量回顾。支持可配置间隔、错误计数和健康状态报告。
 * @extends EventEmitter
 * @emits DreamScheduler#scheduler:started
 * @emits DreamScheduler#scheduler:stopped
 * @emits DreamScheduler#dream:session:end
 */
class DreamScheduler extends EventEmitter {
  constructor(options) {
    super();
    const opts = options ?? {};
    this._dreamEngine = opts.dreamEngine ?? null;
    this._intervalMs = Math.max(1000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this._sessionHistoryProvider = opts.sessionHistoryProvider ?? null;
    this._timer = null;
    this._sm2Stability = 1.0;
    this._sm2LastPerformance = 0.7;
    this._adaptiveIntervalMs = this._intervalMs;
    this._stats = { reviewsTriggered: 0, sessionEndDreams: 0, reviewErrors: 0, errors: 0, sm2Adjustments: 0 };
  }

  /**
   * 启动定时做梦调度器，按配置间隔周期性触发DreamEngine回顾
   * @returns {void}
   */
  start() {
    this.guardShutdown();
    if (this._timer) return;
    const interval = typeof this._intervalMs === 'number' && Number.isFinite(this._intervalMs) ? this._intervalMs : 3600000;
    this._timer = setInterval(() => {
      if (this._shutDown) return;
      safeCall(() => this._periodicReview(), 'DreamScheduler', 'periodicReview');
    }, interval);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    this.emit('scheduler:started');
  }

  /**
   * 停止定时做梦调度器
   * @returns {void}
   */
  stop() {
    if (this._shutDown) return;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.emit('scheduler:stopped');
  }

  /**
   * 检查调度器是否正在运行
   * @returns {boolean} 运行中返回true
   */
  isRunning() {
    return this._timer !== null;
  }

  /**
   * 会话结束时触发即时做梦，将思维数据传递给DreamEngine进行经验提炼
   * @param {string} sessionId - 会话ID
   * @param {Array<object>} thoughts - 思维数据数组
   * @param {object} [_context] - 附加上下文（保留参数）
   * @returns {Promise<object|null>} DreamEngine返回的笔记结果，失败或无引擎返回null
   */
  async onSessionEnd(sessionId, thoughts, _context) {
    this.guardShutdown();
    if (!this._dreamEngine || typeof this._dreamEngine.startDreaming !== 'function') {
      return null;
    }
    try {
      const sessionHistory = Array.isArray(thoughts) ? thoughts : [];
      const notes = await this._dreamEngine.startDreaming(sessionHistory);
      this._stats.sessionEndDreams++;
      this.emit('dream:session:end', { sessionId, notes: notes ?? [] });
      return notes;
    } catch (err) {
      debug('DreamScheduler', 'onSessionEnd', err && err.message ? err.message : String(err));
      this._stats.errors++;
      return null;
    }
  }

  _periodicReview() {
    this._stats.reviewsTriggered++;
    if (this._dreamEngine && typeof this._dreamEngine.startDreaming === 'function') {
      let history;
      try {
        history = this._sessionHistoryProvider ? this._sessionHistoryProvider() : [];
      } catch (err) {
        debug('DreamScheduler', '_periodicReview', 'sessionHistoryProvider error: ' + (err && err.message ? err.message : String(err)));
        history = [];
      }
      if (Array.isArray(history) && history.length > 0) {
        this._dreamEngine.startDreaming(history).catch(err => {
          try {
            this._stats.reviewErrors++;
            this.emit('review-error', { error: err && err.message ? err.message : String(err) });
          } catch (emitErr) {
            debug('DreamScheduler', 'reviewErrorEmit', emitErr && emitErr.message ? emitErr.message : String(emitErr));
          }
        });
      }
    }
  }

  /**
   * 设置会话历史提供者函数，用于定时回顾时获取历史会话数据
   * @param {Function} fn - 会话历史提供者函数，调用后返回会话历史数组
   * @returns {void}
   */
  setSessionHistoryProvider(fn) {
    this.guardShutdown();
    if (typeof fn === 'function') {
      this._sessionHistoryProvider = fn;
    }
  }

  recordDreamPerformance(performance) {
    this.guardShutdown();
    this._sm2LastPerformance = typeof performance === 'number' && Number.isFinite(performance) ? Math.max(0, Math.min(1, performance)) : 0.5;
    this._adaptiveIntervalMs = _sm2ComputeNextInterval(this._sm2Stability, this._sm2LastPerformance);
    if (this._sm2LastPerformance >= 0.6) {
      this._sm2Stability = this._sm2Stability * (this._sm2LastPerformance >= 0.9 ? SM2_EASY_BONUS * 2.5 : 2.0);
    } else {
      this._sm2Stability = this._sm2Stability * SM2_HARD_MULTIPLIER;
    }
    this._sm2Stability = Math.max(SM2_MIN_INTERVAL, Math.min(this._sm2Stability, SM2_MAX_INTERVAL));
    this._stats.sm2Adjustments++;
    this.emit('sm2:interval-adjusted', { intervalMs: this._adaptiveIntervalMs, stability: this._sm2Stability, performance: this._sm2LastPerformance });
    return this._adaptiveIntervalMs;
  }

  getAdaptiveIntervalMs() {
    return this._adaptiveIntervalMs;
  }

  /**
   * 获取调度器的统计信息
   * @returns {object} 统计对象，包含running、intervalMs、reviewsTriggered、sessionEndDreams、errors字段
   */
  getStats() {
    return {
      running: this.isRunning(),
      intervalMs: this._intervalMs,
      adaptiveIntervalMs: this._adaptiveIntervalMs,
      sm2Stability: this._sm2Stability,
      sm2LastPerformance: this._sm2LastPerformance,
      reviewsTriggered: this._stats.reviewsTriggered,
      sessionEndDreams: this._stats.sessionEndDreams,
      reviewErrors: this._stats.reviewErrors,
      errors: this._stats.errors,
      sm2Adjustments: this._stats.sm2Adjustments,
    };
  }

  /**
   * 检查调度器是否健康，错误数低于100即为健康
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._stats.errors < 100;
  }

  _onShutdown() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._dreamEngine = null;
    this._sessionHistoryProvider = null;
    this._sm2Stability = 1.0;
    this._sm2LastPerformance = 0.7;
    this._adaptiveIntervalMs = this._intervalMs;
    this._stats = { reviewsTriggered: 0, sessionEndDreams: 0, reviewErrors: 0, errors: 0, sm2Adjustments: 0 };
    this.removeAllListeners();
  }
}

module.exports = withShutdown(DreamScheduler);
module.exports.DreamScheduler = DreamScheduler;
