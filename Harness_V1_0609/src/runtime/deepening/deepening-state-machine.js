'use strict';

/**
 * @module runtime/deepening/deepening-state-machine
 * 深化推理执行生命周期状态机。定义规范的深化流程状态转换：
 * idle → initializing → cache-check → depth-assessment → agent-routing →
 * context-enrichment → executing → convergence-check → output-fusion →
 * reporting → completed，支持暂停/恢复、按执行追踪历史和聚合状态计数统计。
 */

const DeepeningBase = require('./deepening-base');

/**
 * 深化推理执行生命周期状态机。定义规范的深化流程状态转换：
 * idle → initializing → cache-check → depth-assessment → agent-routing →
 * context-enrichment → executing → convergence-check → output-fusion →
 * reporting → completed，包含 paused/cancelled/failed 恢复分支。
 * 支持暂停/恢复、按执行追踪历史和聚合状态计数统计。
 *
 * @classdesc 深化状态机。有限状态机、状态转换、守卫条件。
 * @extends DeepeningBase
 */
class DeepeningStateMachine extends DeepeningBase {

  /**
   * 创建 DeepeningStateMachine 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxExecutions=500] - 最大执行实例数
   * @param {number} [options.maxHistoryPerExecution=200] - 每个执行的最大历史记录数
   */
  constructor() {
    super();
    this._executions = new Map();
    this._maxExecutions = 500;
    this._maxHistoryPerExecution = 200;
    this._transitions = { idle: new Set(['initializing']), initializing: new Set(['cache-check', 'cancelled', 'failed']), 'cache-check': new Set(['depth-assessment', 'cancelled', 'failed']), 'depth-assessment': new Set(['agent-routing', 'cancelled', 'failed']), 'agent-routing': new Set(['context-enrichment', 'cancelled', 'failed']), 'context-enrichment': new Set(['executing', 'cancelled', 'failed']), executing: new Set(['convergence-check', 'paused', 'cancelled', 'failed']), 'convergence-check': new Set(['output-fusion', 'executing', 'cancelled', 'failed']), 'output-fusion': new Set(['reporting', 'cancelled', 'failed']), reporting: new Set(['completed', 'cancelled', 'failed']), completed: new Set(['idle']), paused: new Set(['executing', 'cancelled']), cancelled: new Set(['idle']), failed: new Set(['idle']) };
    this._stateCounts = {};
  }

  /**
   * 创建执行实例。初始状态为 idle，超出上限时淘汰已完成的执行。
   * @param {string} executionId - 执行标识
   * @returns {Object} 创建结果，包含 executionId 和 currentState；容量已满时包含 error
   */
  createExecution(executionId) {
    this.guardShutdown();
    if (this._executions.size >= this._maxExecutions) {
      let evicted = false;
      let evictId = null;
      let evictState = null;
      for (const [id, exec] of this._executions) {
        if (exec.currentState === 'completed' || exec.currentState === 'cancelled' || exec.currentState === 'failed') {
          evictId = id;
          evictState = exec.currentState;
          evicted = true;
          break;
        }
      }
      if (evicted) {
        this._stateCounts[evictState] = Math.max(0, (this._stateCounts[evictState] ?? 0) - 1);
        if (this._stateCounts[evictState] <= 0) delete this._stateCounts[evictState];
        this._executions.delete(evictId);
      }
      if (!evicted) return { executionId: null, currentState: null, error: 'Max executions reached and no completed executions to evict' };
    }
    const exec = { executionId, currentState: 'idle', _prevState: null, history: [{ to: 'idle', timestamp: Date.now() }] };
    this._executions.set(executionId, exec);
    this._stateCounts['idle'] = (this._stateCounts['idle'] ?? 0) + 1;
    return { executionId, currentState: 'idle' };
  }

  /**
   * 执行状态转换。验证转换合法性，更新状态计数和历史记录。
   * @param {string} executionId - 执行标识
   * @param {string} state - 目标状态
   * @returns {Object} 转换结果，包含 ok 标志和可能的 error 信息
   * @emits 'state-transition' 当状态转换成功时触发
   */
  transition(executionId, state) {
    const exec = this._executions.get(executionId);
    if (!exec) return { ok: false, error: 'Execution not found' };
    if (!this.canTransition(executionId, state)) return { ok: false, error: 'Invalid transition from ' + exec.currentState + ' to ' + state };
    exec._prevState = exec.currentState;
    exec.currentState = state;
    this._stateCounts[exec._prevState] = Math.max(0, (this._stateCounts[exec._prevState] ?? 0) - 1);
    if (this._stateCounts[exec._prevState] <= 0) delete this._stateCounts[exec._prevState];
    this._stateCounts[state] = (this._stateCounts[state] ?? 0) + 1;
    exec.history.push({ to: state, from: exec._prevState, timestamp: Date.now() });
    if (exec.history.length > this._maxHistoryPerExecution) exec.history = exec.history.slice(-this._maxHistoryPerExecution);
    this.emit('state-transition', { executionId, from: exec._prevState, to: state });
    return { ok: true };
  }

  /**
   * 检查状态转换是否合法。
   * @param {string} executionId - 执行标识
   * @param {string} state - 目标状态
   * @returns {boolean} 转换合法返回 true
   */
  canTransition(executionId, state) {
    const exec = this._executions.get(executionId);
    if (!exec) return false;
    const allowed = this._transitions[exec.currentState];
    return allowed ? allowed.has(state) : false;
  }

  /**
   * 获取执行当前状态。
   * @param {string} executionId - 执行标识
   * @returns {string|null} 当前状态名称，执行不存在返回 null
   */
  getState(executionId) { const exec = this._executions.get(executionId); return exec ? exec.currentState : null; }

  /**
   * 暂停执行。保存当前状态以便恢复。
   * @param {string} executionId - 执行标识
   * @returns {Object} 转换结果，包含 ok 标志
   */
  pause(executionId) {
    const exec = this._executions.get(executionId);
    if (!exec) return { ok: false };
    return this.transition(executionId, 'paused');
  }

  /**
   * 恢复执行。从暂停状态恢复到之前的状态。
   * @param {string} executionId - 执行标识
   * @returns {Object} 转换结果，包含 ok 标志和可能的 error 信息
   */
  resume(executionId) {
    const exec = this._executions.get(executionId);
    if (!exec || exec.currentState !== 'paused') return { ok: false };
    const targetState = exec._prevState ?? 'executing';
    if (!this.canTransition(executionId, targetState)) return { ok: false, error: 'Invalid transition from paused to ' + targetState };
    return this.transition(executionId, targetState);
  }

  /**
   * 取消执行。
   * @param {string} executionId - 执行标识
   * @returns {Object} 转换结果，包含 ok 标志
   */
  cancel(executionId) { return this.transition(executionId, 'cancelled'); }

  /**
   * 标记执行失败。
   * @param {string} executionId - 执行标识
   * @param {string} reason - 失败原因
   * @returns {Object} 转换结果，包含 ok 标志
   */
  fail(executionId, reason) { const r = this.transition(executionId, 'failed'); if (r.ok) { const exec = this._executions.get(executionId); if (exec) exec.failReason = reason; } return r; }

  /**
   * 标记执行完成。
   * @param {string} executionId - 执行标识
   * @param {*} result - 执行结果
   * @returns {Object} 转换结果，包含 ok 标志
   */
  complete(executionId, result) { const r = this.transition(executionId, 'completed'); if (r.ok) { const exec = this._executions.get(executionId); if (exec) exec.result = result; } return r; }

  /**
   * 重置执行到 idle 状态。
   * @param {string} executionId - 执行标识
   * @returns {Object} 重置结果，包含 ok: true
   * @emits 'state-transition' 当重置状态转换时触发
   */
  reset(executionId) { const exec = this._executions.get(executionId); if (!exec) return { ok: false, error: 'Execution not found' }; const prevState = exec.currentState; this._stateCounts[prevState] = Math.max(0, (this._stateCounts[prevState] ?? 0) - 1); if (this._stateCounts[prevState] <= 0) delete this._stateCounts[prevState]; this._stateCounts['idle'] = (this._stateCounts['idle'] ?? 0) + 1; exec._prevState = prevState; exec.currentState = 'idle'; exec.history = [{ to: 'idle', from: prevState, timestamp: Date.now() }]; this.emit('state-transition', { executionId, from: prevState, to: 'idle' }); return { ok: true }; }

  /**
   * 获取执行状态转换历史。
   * @param {string} executionId - 执行标识
   * @returns {Object[]} 状态转换历史数组，每项包含 from、to、timestamp
   */
  getHistory(executionId) { const exec = this._executions.get(executionId); return exec ? exec.history.slice() : []; }

  /**
   * 获取状态机统计信息。
   * @returns {Object} 统计对象，包含 totalExecutions 和 stateCounts
   */
  getStats() {
    return { totalExecutions: this._executions.size, stateCounts: { ...this._stateCounts }, ...super.getStats() };
  }

  /**
   * 关闭时清理所有执行和状态计数。
   * @protected
   */
  _onShutdown() {
    this._executions.clear();
    this._stateCounts = {};
    super._onShutdown();
  }
}

module.exports = DeepeningStateMachine;
