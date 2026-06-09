'use strict';

const EventEmitter = require('events');
const BoundedArray = require('./bounded-array');
const { sanitizeLogMsg } = require('./sanitizer');
const { debug } = require('./debug-logger');
const { safeCall: _safeCall } = require('./safe-execute');
const { withShutdown: _withShutdown } = require('./shutdown-mixin');

/** @constant {Object.<string, number>} LOG_LEVELS - 日志级别映射 */
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/** @constant {number} MAX_CHILDREN - 最大子日志器数量 */
const MAX_CHILDREN = 50;

/**
 * @module utils/structured-logger
 * StructuredLogger — 分级结构化日志器
 * 提供分级日志输出（debug/info/warn/error/silent）、子日志器派生、追踪ID关联、
 * 日志查询过滤、性能指标采集和健康状态检测。日志条目存储于有界数组中，
 * 支持按级别、模块、时间范围、追踪ID和类型进行查询。
 * @classdesc 结构化日志。JSON格式、上下文注入、级别控制
 * @extends EventEmitter
 */
class StructuredLogger extends EventEmitter {
  /**
   * 创建结构化日志器实例
   * @param {Object} [options] - 配置选项
   * @param {string} [options.level='info'] - 日志级别
   * @param {number} [options.maxEntries=5000] - 最大日志条目数
   * @param {string} [options.module='app'] - 模块名称
   */
  constructor(options) {
    super();
    this._level = LOG_LEVELS[(options && options.level)] ?? LOG_LEVELS.info;
    this._entries = new BoundedArray((options && options.maxEntries) ?? 5000);
    this._module = (options && options.module) || 'app';
    this._children = new Set();
    this._traceId = null;
    this._metrics = {
      totalLogged: 0,
      errorsLogged: 0,
      warningsLogged: 0,
      startTime: Date.now(),
      sum: 0,
    };
  }

  /**
   * 设置追踪ID
   * @param {string|null} traceId - 追踪ID
   * @returns {StructuredLogger} 当前实例，支持链式调用
   */
  setTraceId(traceId) {
    this._traceId = traceId ?? null;
    return this;
  }

  /**
   * 获取当前追踪ID
   * @returns {string|null} 当前追踪ID
   */
  getTraceId() {
    return this._traceId;
  }

  /**
   * 创建带追踪ID的子日志器
   * @param {string} traceId - 追踪ID
   * @returns {StructuredLogger} 带追踪ID的子日志器
   */
  withTrace(traceId) {
    const child = this.child('trace');
    child._traceId = traceId;
    return child;
  }

  /**
   * 内部日志写入方法
   * @param {string} level - 日志级别
   * @param {string} message - 日志消息
   * @param {Object} [meta] - 元数据
   * @private
   */
  _log(level, message, meta) {
    this.guardShutdown();
    const levelNum = LOG_LEVELS[level];
    if (levelNum == null || levelNum < this._level) return;

    this._metrics.totalLogged++;
    if (level === 'error') this._metrics.errorsLogged++;
    if (level === 'warn') this._metrics.warningsLogged++;

    const safeMessage = typeof message === 'string' ? sanitizeLogMsg(message) : String(message);
    const entry = {
      level,
      message: safeMessage,
      module: this._module,
      timestamp: new Date().toISOString(),
      meta: meta ?? {},
    };

    if (this._traceId) {
      entry.traceId = this._traceId;
    }

    this._entries.push(entry);

    this.emit('log', entry);
    if (levelNum >= LOG_LEVELS.error) {
      this.emit('error-log', entry);
    }
  }

  /**
   * 输出debug级别日志
   * @param {string} message - 日志消息
   * @param {Object} [meta] - 元数据
   */
  debug(message, meta) { this._log('debug', message, meta); }

  /**
   * 输出info级别日志
   * @param {string} message - 日志消息
   * @param {Object} [meta] - 元数据
   */
  info(message, meta) { this._log('info', message, meta); }

  /**
   * 输出warn级别日志
   * @param {string} message - 日志消息
   * @param {Object} [meta] - 元数据
   */
  warn(message, meta) { this._log('warn', message, meta); }

  /**
   * 输出error级别日志
   * @param {string} message - 日志消息
   * @param {Object} [meta] - 元数据
   */
  error(message, meta) { this._log('error', message, meta); }

  /**
   * 记录性能日志
   * @param {string} operation - 操作名称
   * @param {number} durationMs - 耗时（毫秒）
   * @param {Object} [meta] - 额外元数据
   */
  logPerformance(operation, durationMs, meta) {
    this._log('info', 'Performance: ' + operation, { ...(meta ?? {}), _type: 'performance', operation, durationMs, slow: durationMs > 1000 });
  }

  /**
   * 记录操作日志
   * @param {string} operation - 操作名称
   * @param {string} status - 操作状态
   * @param {Object} [meta] - 额外元数据
   */
  logOperation(operation, status, meta) {
    this._log('info', 'Operation: ' + operation, { ...(meta ?? {}), _type: 'operation', operation, status });
  }

  /**
   * 创建子日志器，继承当前日志级别和追踪ID
   * @param {string} module - 子模块名称
   * @returns {StructuredLogger} 子日志器实例
   */
  child(module) {
    if (this._children.size >= MAX_CHILDREN) {
      const oldest = this._children.values().next().value;
      if (oldest && typeof oldest.destroy === 'function') oldest.destroy();
      else this._children.delete(oldest);
    }
    const child = new StructuredLogger({
      level: Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === this._level) || 'info',
      maxEntries: this._entries.maxSize,
      module: `${this._module}:${module}`,
    });
    const handler = (entry) => { this.emit('log', entry); };
    child.on('log', handler);
    child._parentRef = this;
    child._parentHandler = handler;
    child._traceId = this._traceId;
    this._children.add(child);
    child.destroy = function destroy() {
      this.removeListener('log', handler);
      if (this._parentRef) this._parentRef._children.delete(this);
      delete this._parentRef;
      delete this._parentHandler;
    };
    return child;
  }

  /**
   * 查询日志条目，支持按级别、模块、时间、追踪ID和类型过滤
   * @param {Object} [filter] - 过滤条件
   * @param {string} [filter.level] - 最低日志级别
   * @param {string} [filter.module] - 模块名称前缀
   * @param {string} [filter.since] - 起始时间（ISO字符串）
   * @param {string} [filter.traceId] - 追踪ID
   * @param {string} [filter.type] - 元数据类型
   * @param {number} [filter.limit] - 返回条目数限制
   * @returns {Object[]} 过滤后的日志条目数组
   */
  query(filter) {
    let results = this._entries.toArray();
    if (filter) {
      if (filter.level) {
        const minLevel = LOG_LEVELS[filter.level];
        if (minLevel !== undefined) {
          results = results.filter(e => LOG_LEVELS[e.level] >= minLevel);
        }
      }
      if (filter.module) {
        const modFilter = filter.module;
        results = results.filter(e => e.module === modFilter || e.module.startsWith(modFilter + ':'));
      }
      if (filter.since) {
        results = results.filter(e => e.timestamp >= filter.since);
      }
      if (filter.traceId) {
        results = results.filter(e => e.traceId === filter.traceId);
      }
      if (filter.type) {
        results = results.filter(e => e.meta && e.meta._type === filter.type);
      }
      if (filter.limit && filter.limit > 0) {
        results = results.slice(-filter.limit);
      }
    }
    return results;
  }

  /**
   * 获取最近的日志条目
   * @param {number} [count=10] - 返回条目数
   * @returns {Object[]} 最近的日志条目数组
   */
  getRecent(count) {
    const n = count ?? 10;
    return n > 0 ? this._entries.slice(-n) : [];
  }

  /**
   * 清除所有日志条目
   */
  clear() {
    this._entries.clear();
  }

  /**
   * 导出所有日志条目为格式化JSON字符串
   * @returns {string} JSON格式的日志条目
   */
  export() {
    return JSON.stringify(this._entries.toArray(), null, 2);
  }

  /**
   * 获取日志统计信息，包括总数、按级别/模块分布和错误率
   * @returns {{total: number, byLevel: Object, byModule: Object, metrics: Object}} 统计信息
   */
  getStats() {
    const stats = { total: this._entries.length, byLevel: {}, byModule: {} };
    this._entries.forEach(entry => {
      stats.byLevel[entry.level] = (stats.byLevel[entry.level] ?? 0) + 1;
      stats.byModule[entry.module] = (stats.byModule[entry.module] ?? 0) + 1;
    });
    stats.metrics = { ...this._metrics,
      uptimeMs: Date.now() - this._metrics.startTime,
      errorRate: this._metrics.totalLogged > 0
        ? Math.round((this._metrics.errorsLogged / this._metrics.totalLogged) * 10000) / 100
        : 0,
    };
    return stats;
  }

  /**
   * 获取日志级别映射表
   * @returns {Object.<string, number>} 日志级别映射
   * @static
   */
  static get LOG_LEVELS() { return LOG_LEVELS; }

  /**
   * 检查日志器是否存活（未关闭即为健康）
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    return !this._shutDown;
  }

  /**
   * 检查日志器是否正常运行（错误率低于50%）
   * @returns {boolean} 是否运行正常
   */
  isOperational() {
    if (this._shutDown) return false;
    const errorRate = this._metrics.totalLogged > 0
      ? this._metrics.errorsLogged / this._metrics.totalLogged
      : 0;
    return errorRate < 0.5;
  }

  /**
   * 关闭日志器，销毁所有子日志器并清除数据
   */
  _onShutdown() {
    const children = [...this._children];
    for (const child of children) {
      try {
        if (typeof child.destroy === 'function') child.destroy();
      } catch (_e) { debug('StructuredLogger', 'shutdown:destroy-child', _e && _e.message ? _e.message : String(_e)); }
    }
    this._children.clear();
    _safeCall(() => this._entries.shutdown(), 'StructuredLogger', 'shutdown-entries');
    this._metrics = { totalLogged: 0, errorsLogged: 0, warningsLogged: 0, lastLogTime: null, sum: 0 };
  }
}

StructuredLogger = _withShutdown(StructuredLogger);

module.exports = StructuredLogger;
