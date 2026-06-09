'use strict';
const DeepeningBase = require('./deepening-base');
const { ShutdownMixin } = require('../../utils/shutdown-mixin');
const { requireString_, requireFunction_, ensurePositiveNumber } = require('../../utils/param-validator');
const { DEFAULT_SHUTDOWN_TIMEOUT_MS } = require('../../utils/constants');
const { debug: _debug } = require('../../utils/debug-logger');
const { HarnessError } = require('../../errors');

/**
 * @module runtime/deepening/deepening-graceful-shutdown
 * 深化推理优雅关闭。分阶段优雅关闭编排器，支持依赖解析、
 * 每步骤超时保护、进度追踪及监听器跨关闭周期保留。
 */

/**
 * @classdesc 深化优雅关闭。信号处理、资源清理、超时保护
 *
 * 深化推理优雅关闭 — 分阶段优雅关闭编排器。
 * 跨三个阶段（排空/停止/清理）执行有序关闭步骤，支持依赖解析、
 * 每步骤超时保护、进度追踪。支持步骤添加/移除、重置复用、
 * 以及监听器跨关闭周期保留。
 *
 * @extends DeepeningBase
 * @emits 'stepAdded' 当关闭步骤添加时触发，附带 { name, phase }
 * @emits 'shutdownStarted' 当关闭流程启动时触发，附带 { steps }
 * @emits 'phaseStarted' 当阶段开始时触发，附带 { phase }
 * @emits 'stepStarted' 当步骤开始执行时触发，附带 { name }
 * @emits 'stepCompleted' 当步骤完成时触发，附带 { name, duration }
 * @emits 'stepFailed' 当步骤失败时触发，附带 { name, error }
 * @emits 'phaseCompleted' 当阶段完成时触发，附带 { phase }
 * @emits 'shutdownCompleted' 当关闭流程完成时触发，附带 { completed, failed, duration }
 * @emits 'shutdown' 当关闭完成时触发
 * @emits 'shutdownManager' 当通过 shutdownManager 关闭时触发
 * @emits 'reset' 当重置时触发
 */
class DeepeningGracefulShutdown extends DeepeningBase {
  /**
   * 关闭阶段枚举。
   * @constant
   * @type {Object}
   * @property {string} DRAIN - 排空阶段（排空进行中的请求）
   * @property {string} STOP - 停止阶段（停止接受新请求）
   * @property {string} CLEANUP - 清理阶段（释放资源）
   * @property {string} DONE - 完成状态
   */
  static SHUTDOWN_PHASES = { DRAIN: 'drain', STOP: 'stop', CLEANUP: 'cleanup', DONE: 'done' };

  /**
   * 创建 DeepeningGracefulShutdown 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.timeout] - 每步骤超时时间（毫秒），默认使用 DEFAULT_SHUTDOWN_TIMEOUT_MS
   */
  constructor(options) {
    super(options);
    this._steps = [];
    this._maxSteps = 50;
    this._progress = { total: 0, completed: 0, failed: 0, remaining: 0, phase: 'idle' };
    this._shuttingDown = false;
    this._phase = 'idle';
    this._timeout = ensurePositiveNumber((options && options.timeout), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    this._totalShutdowns = 0;
    this._savedListeners = null;
  }

  /**
   * 添加关闭步骤。步骤按 order 排序，关闭过程中不允许添加。
   * @param {string} name - 步骤名称（唯一标识）
   * @param {Function} handler - 步骤处理函数，签名 () => void|Promise
   * @param {Object} [options] - 步骤选项
   * @param {string} [options.phase='cleanup'] - 所属阶段（'drain'|'stop'|'cleanup'）
   * @param {number} [options.order=0] - 排序权重，数值越小越先执行
   * @param {string[]} [options.dependsOn=[]] - 依赖的步骤名称列表
   * @returns {boolean} 添加是否成功
   * @throws {HarnessError} 关闭过程中添加时抛出
   * @emits 'stepAdded'
   */
  addStep(name, handler, options) {
    requireString_(name, 'Step name');
    requireFunction_(handler, 'Step handler');
    if (this._shuttingDown) throw new HarnessError('SHUTDOWN_IN_PROGRESS', 'Cannot add steps during shutdown');
    if (this._steps.length >= this._maxSteps) return false;
    if (this._steps.some(s => s.name === name)) return false;
    const opts = options ?? {};
    this._steps.push({ name, handler, phase: opts.phase ?? 'cleanup', order: opts.order ?? 0, dependsOn: opts.dependsOn ?? [] });
    this._steps.sort((a, b) => a.order - b.order);
    this._progress.total = this._steps.length;
    this.emit('stepAdded', { name, phase: opts.phase ?? 'cleanup' });
    return true;
  }

  /**
   * 移除关闭步骤。
   * @param {string} name - 步骤名称
   * @returns {boolean} 是否成功移除
   */
  removeStep(name) {
    this.guardShutdown();
    if (!this._steps.some(s => s.name === name)) return false;
    this._steps = this._steps.filter(s => s.name !== name);
    this._progress.total = this._steps.length;
    return true;
  }

  /**
   * 获取所有关闭步骤的副本。
   * @returns {Object[]} 步骤数组
   */
  getSteps() { return this._steps.slice(); }

  /**
   * 执行分阶段关闭。按 drain → stop → cleanup 顺序执行步骤，
   * 每步骤有超时保护，依赖未解析时抛出异常。
   * @emits 'shutdownStarted'
   * @emits 'phaseStarted'
   * @emits 'stepStarted'
   * @emits 'stepCompleted'
   * @emits 'stepFailed'
   * @emits 'phaseCompleted'
   * @emits 'shutdownCompleted'
   * @protected
   */
  async _onShutdown() {
    this._savedListeners = {};
    for (const eventName of this.eventNames()) {
      this._savedListeners[eventName] = this.listeners(eventName).slice();
    }
    this._shuttingDown = true;
    const startTime = Date.now();
    this.emit('shutdownStarted', { steps: this._steps.length });
    const phases = ['drain', 'stop', 'cleanup'];
    const completedSteps = new Set();
    for (const phase of phases) {
      this._phase = phase;
      this._progress.phase = phase;
      this.emit('phaseStarted', { phase });
      const phaseSteps = this._steps.filter(s => s.phase === phase);
      for (const step of phaseSteps) {
        const stepStart = Date.now();
        this.emit('stepStarted', { name: step.name });
        try {
          const deps = step.dependsOn ?? [];
          const unresolved = deps.filter(d => !this._steps.some(s => s.name === d));
          if (unresolved.length > 0) throw new HarnessError('DEPENDENCY_CYCLE', 'Unresolved dependency');
          const incomplete = deps.filter(d => !completedSteps.has(d));
          if (incomplete.length > 0) throw new HarnessError('DEPENDENCY_CYCLE', 'Dependency not completed: ' + incomplete.join(', '));
          if (step.handler) {
            const handlerPromise = Promise.resolve(typeof step.handler === 'function' ? step.handler() : step.handler);
            await Promise.race([
              handlerPromise,
              new Promise((_, reject) => { const _tid = setTimeout(() => reject(new Error('Shutdown handler timeout')), typeof this._timeout === 'number' && Number.isFinite(this._timeout) ? this._timeout : 5000); if (_tid && typeof _tid.unref === 'function') { _tid.unref(); } handlerPromise.then(() => clearTimeout(_tid), () => clearTimeout(_tid)); }),
            ]);
          }
          completedSteps.add(step.name);
          this._progress.completed++;
          this.emit('stepCompleted', { name: step.name, duration: Date.now() - stepStart });
        } catch (e) {
          this._progress.failed++;
          this.emit('stepFailed', { name: step.name, error: e && e.message ? e.message : String(e) });
        }
      }
      this.emit('phaseCompleted', { phase });
    }
    this._phase = 'done';
    this._progress.phase = 'done';
    this._progress.remaining = 0;
    this._totalShutdowns++;
    this.emit('shutdownCompleted', { completed: this._progress.completed, failed: this._progress.failed, duration: Date.now() - startTime });
    super._onShutdown();
  }

  /**
   * 执行优雅关闭。委托给 mixin 的 shutdown() 并等待异步清理完成。
   * @returns {Promise<void>}
   */
  async shutdown() {
    ShutdownMixin.shutdown.call(this);
    return this.waitForShutdown();
  }

  /**
   * 管理器级关闭。清空步骤后执行关闭。
   * @returns {Promise<void>}
   * @emits 'shutdownManager'
   */
  async shutdownManager() {
    this.emit('shutdownManager');
    this._steps = [];
    this._progress.total = 0;
    return this.shutdown();
  }

  /**
   * 获取关闭进度信息。
   * @returns {Object} 进度对象 { total, completed, failed, remaining, phase }
   */
  getProgress() { return { ...this._progress, remaining: this._progress.total - this._progress.completed - this._progress.failed }; }

  /**
   * 检查是否正在关闭中。
   * @returns {boolean} 是否正在关闭
   */
  isShuttingDown() { return this._shuttingDown; }

  /**
   * 获取当前关闭阶段。
   * @returns {string|null} 当前阶段（'drain'|'stop'|'cleanup'|'done'），空闲时返回 null
   */
  getPhase() { return this._phase === 'idle' ? null : this._phase; }

  /**
   * 重置关闭状态以便复用。恢复之前保存的监听器。
   * 同时重置 withShutdown mixin 的内部状态（_shuttingDown、_shutdownPromise、_shutdownSignal），
   * 确保 reset() 后 guardShutdown() 和 shutdown() 可正常工作。
   * @returns {boolean} 重置结果
   * @emits 'reset'
   */
  reset() {
    if (this._shuttingDown) throw new Error('Cannot reset during shutdown');
    this._shutDown = false;
    this._shuttingDown = false;
    this._shutdownPromise = null;
    this._shutdownSignal = null;
    this._phase = 'idle';
    this._progress = { total: this._steps.length, completed: 0, failed: 0, remaining: this._steps.length, phase: 'idle' };
    if (this._savedListeners) {
      for (const [eventName, listeners] of Object.entries(this._savedListeners)) {
        for (const listener of listeners) {
          this.on(eventName, listener);
        }
      }
      this._savedListeners = null;
    }
    this.emit('reset');
    return true;
  }

  /**
   * 获取优雅关闭运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.timeout - 每步骤超时时间
   * @returns {number} return.totalSteps - 步骤总数
   * @returns {number} return.totalShutdowns - 累计关闭次数
   * @returns {boolean} return.shuttingDown - 是否正在关闭
   * @returns {string} return.phase - 当前阶段
   * @returns {Object} return.progress - 进度信息
   */
  getStats() {
    return { timeout: this._timeout, totalSteps: this._steps.length, totalShutdowns: this._totalShutdowns, shuttingDown: this._shuttingDown, phase: this._phase, progress: this.getProgress(), ...super.getStats() };
  }
}

module.exports = DeepeningGracefulShutdown;
