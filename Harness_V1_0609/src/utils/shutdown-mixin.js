/**
 * @module shutdown-mixin
 * @description 优雅关闭混入模块，为类提供关闭状态管理、健康检查守卫和关闭生命周期控制。
 * 支持混入到任意类中，自动映射错误类型并发出关闭事件。
 */

'use strict';

const { safeCall } = require('./safe-execute');
const { AgentError, SessionError, ERROR_CODES } = require('../errors');

/** @constant {Object.<string, Function>} _ERROR_CLASS_MAP - 类名到错误类型的映射表 */
const _ERROR_CLASS_MAP = {
  AgentStateManager: AgentError,
  AgentLifecycleController: AgentError,
  AgentWorkflowIntegration: AgentError,
  AgentRuntime: AgentError,
  AgentDeployment: AgentError,
  AgentMonitor: AgentError,
  AgentSandbox: AgentError,
  SessionManager: SessionError,
};

/**
 * 根据类名获取对应的关闭错误实例
 * @param {string} className - 类名
 * @returns {AgentError|SessionError} 对应的错误实例
 * @private
 */
function _getShutdownError(className) {
  const ErrorClass = _ERROR_CLASS_MAP[className] || AgentError;
  return new ErrorClass(ERROR_CODES.SHUTDOWN, className + ' is shut down');
}

/**
 * @namespace ShutdownMixin
 * @description 关闭混入对象，提供isHealthy、guardShutdown和shutdown方法，
 * 可混入到任意类的原型中以赋予优雅关闭能力。
 */
const ShutdownMixin = {
  /**
   * 检查实例是否健康（未关闭）
   * @returns {boolean} 实例是否健康
   */
  isHealthy() {
    if (typeof this._initShutdownState === 'function') this._initShutdownState();
    return !this._shutDown;
  },

  /**
   * 守卫方法，若实例已关闭则抛出对应错误
   * @throws {AgentError|SessionError} 实例已关闭时抛出
   */
  guardShutdown() {
    if (typeof this._initShutdownState === 'function') this._initShutdownState();
    if (this._shutDown) throw _getShutdownError(this.constructor.name);
  },

  /**
   * 执行关闭操作，设置关闭状态、触发_onShutdown回调、发出shutdown事件并移除所有监听器。
   * 当_onShutdown返回Promise时，延迟removeAllListeners直到异步清理完成，避免数据丢失。
   * 可通过waitForShutdown()等待异步关闭完成。
   */
  shutdown() {
    if (typeof this._initShutdownState === 'function') this._initShutdownState();
    if (this._shutDown || this._shuttingDown) return;
    this._shuttingDown = true;
    this._shutDown = true;
    safeCall(() => this.emit('shutdown', { signal: this._shutdownSignal || 'manual' }), 'ShutdownMixin', 'emit-shutdown');
    const finalize = () => {
      if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
      this._shuttingDown = false;
    };
    if (typeof this._onShutdown === 'function') {
      const result = this._onShutdown();
      if (result && typeof result.then === 'function') {
        this._shutdownPromise = result.then(finalize).catch(function(err) {
          safeCall(function() {
            if (typeof process !== 'undefined' && process.emitWarning) {
              process.emitWarning('Shutdown _onShutdown rejection: ' + (err && err.message ? err.message : String(err)));
            }
          }, 'ShutdownMixin', 'shutdown-warning');
          finalize();
        });
        return;
      }
    }
    finalize();
  },

  waitForShutdown() {
    return this._shutdownPromise || Promise.resolve();
  },
};

/**
 * 为类混入ShutdownMixin功能的高阶函数
 * @param {Function} Klass - 待混入的类构造函数
 * @returns {Function} 混入后的类构造函数
 */
function withShutdown(Klass) {
  const originalIsHealthy = Klass.prototype.isHealthy;
  Object.assign(Klass.prototype, ShutdownMixin);
  if (originalIsHealthy && originalIsHealthy !== ShutdownMixin.isHealthy) {
    Klass.prototype.isHealthy = function() {
      if (this._shutDown) return false;
      return originalIsHealthy.call(this);
    };
  }
  const origInit = Klass.prototype._initShutdownState;
  if (!origInit) {
    Klass.prototype._initShutdownState = function() {
      if (this._shutDown == null) this._shutDown = false;
      if (this._shuttingDown == null) this._shuttingDown = false;
    };
  }
  return Klass;
}

module.exports = { ShutdownMixin, withShutdown };
