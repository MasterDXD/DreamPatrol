'use strict';

/**
 * @module runtime/deepening/deepening-state-manager
 * 深化推理双用途状态管理器。管理具名状态机（带守卫转换、onEnter/onExit回调和事件驱动转换）
 * 以及有界键值状态存储，强制执行状态机和状态的容量限制。
 */

const DeepeningBase = require('./deepening-base');
const { HarnessError, DeepeningError } = require('../../errors');

/**
 * 状态机最大数量限制
 * @constant {number}
 */
const MAX_MACHINES = 200;

/**
 * 每个状态机最大历史记录数
 * @constant {number}
 */
const MAX_HISTORY_PER_MACHINE = 500;

/**
 * 键值状态最大数量限制
 * @constant {number}
 */
const MAX_STATES = 1000;

/**
 * @classdesc 深化状态管理器。状态持久化、状态恢复、状态同步
 *
 * 深化推理双用途状态管理器。管理具名状态机（带守卫转换、onEnter/onExit回调和事件驱动转换），
 * 以及有界键值状态存储用于任意状态数据。强制执行状态机和状态的容量限制。
 * @extends DeepeningBase
 */
class DeepeningStateManager extends DeepeningBase {

  /**
   * 创建 DeepeningStateManager 实例。
   * @param {Object} [options] - 配置选项
   */
  constructor(options) {
    super(options);
    this._machines = new Map();
    this._states = new Map();
  }

  /**
   * 创建具名状态机。超出上限时淘汰最早的状态机。
   * @param {string} machineId - 状态机标识
   * @param {Object} [options] - 状态机配置
   * @param {string} [options.initialState='idle'] - 初始状态名称
   * @returns {Object} 创建的状态机对象
   * @throws {DeepeningError} machineId 无效时抛出异常
   */
  create(machineId, options) {
    this.guardShutdown();
    if (!machineId || typeof machineId !== 'string') throw new DeepeningError('INVALID_INPUT', 'machineId must be a non-empty string');
    if (this._machines.size >= MAX_MACHINES) {
      const oldestKey = this._machines.keys().next().value;
      this._machines.delete(oldestKey);
    }
    const opts = options ?? {};
    const initialState = opts.initialState ?? 'idle';
    const machine = {
      id: machineId,
      currentState: initialState,
      initialState: initialState,
      states: new Map(),
      transitions: [],
      _transitionByTarget: new Map(),
      _transitionByEvent: new Map(),
      history: [],
    };
    machine.states.set(initialState, { name: initialState, final: false, onEnter: null, onExit: null });
    this._machines.set(machineId, machine);
    return machine;
  }

  /**
   * 移除指定状态机。
   * @param {string} machineId - 状态机标识
   * @returns {boolean} 移除成功返回 true，不存在返回 false
   */
  remove(machineId) {
    this.guardShutdown();
    return this._machines.delete(machineId);
  }

  /**
   * 向状态机添加状态。
   * @param {string} machineId - 状态机标识
   * @param {string} stateName - 状态名称
   * @param {Object} [options] - 状态配置
   * @param {boolean} [options.final=false] - 是否为终态
   * @param {Function} [options.onEnter] - 进入状态回调
   * @param {Function} [options.onExit] - 退出状态回调
   * @returns {boolean} 添加成功返回 true，状态机不存在返回 false
   */
  addState(machineId, stateName, options) {
    this.guardShutdown();
    const machine = this._machines.get(machineId);
    if (!machine) return false;
    const opts = options ?? {};
    machine.states.set(stateName, {
      name: stateName,
      final: opts.final ?? false,
      onEnter: opts.onEnter ?? null,
      onExit: opts.onExit ?? null,
    });
    return true;
  }

  /**
   * 向状态机添加转换规则。支持守卫条件和事件绑定。
   * @param {string} machineId - 状态机标识
   * @param {string} fromState - 源状态
   * @param {string} toState - 目标状态
   * @param {Object} [options] - 转换配置
   * @param {string} [options.event] - 触发事件名称
   * @param {Function} [options.guard] - 守卫条件函数
   * @returns {boolean} 添加成功返回 true，状态机不存在返回 false
   */
  addTransition(machineId, fromState, toState, options) {
    this.guardShutdown();
    const machine = this._machines.get(machineId);
    if (!machine) return false;
    const opts = options ?? {};
    const t = {
      from: fromState,
      to: toState,
      event: opts.event ?? null,
      guard: opts.guard ?? null,
    };
    machine.transitions.push(t);
    const targetKey = fromState + '→' + toState;
    if (!machine._transitionByTarget.has(targetKey)) machine._transitionByTarget.set(targetKey, []);
    const tgtArr = machine._transitionByTarget.get(targetKey);
    if (tgtArr) tgtArr.push(t);
    if (t.event) {
      const eventKey = fromState + ':' + t.event;
      if (!machine._transitionByEvent.has(eventKey)) machine._transitionByEvent.set(eventKey, []);
      const evtArr = machine._transitionByEvent.get(eventKey);
      if (evtArr) evtArr.push(t);
    }
    return true;
  }

  /**
   * 执行状态转换。验证守卫条件，触发 onExit/onEnter 回调。
   * @param {string} machineId - 状态机标识
   * @param {string} targetState - 目标状态
   * @param {Object} [context] - 转换上下文，传递给守卫条件
   * @returns {Promise<Object>} 转换结果，包含 ok 标志
   * @throws {HarnessError} 转换非法或守卫条件失败时抛出异常
   * @emits 'callback-error' 当 onExit/onEnter 回调抛出异常时触发
   * @emits 'state-transition' 当状态转换成功时触发
   */
  async transition(machineId, targetState, context) {
    this.guardShutdown();
    const machine = this._machines.get(machineId);
    if (!machine) return { ok: false, error: 'Machine not found' };
    const targetKey = machine.currentState + '→' + targetState;
    const candidates = machine._transitionByTarget.get(targetKey);
    const transition = candidates && candidates[0];
    if (!transition) throw new HarnessError('STATE_MACHINE_ERROR', 'Invalid transition from ' + machine.currentState + ' to ' + targetState);
    if (transition.guard && !transition.guard(context ?? null)) throw new HarnessError('STATE_MACHINE_ERROR', 'Guard condition failed');
    const fromStateObj = machine.states.get(machine.currentState);
    const toStateObj = machine.states.get(targetState);
    if (fromStateObj && fromStateObj.onExit) {
      try { const r = fromStateObj.onExit(); if (r && typeof r.then === 'function') await r; } catch (exitErr) { this.emit('callback-error', { machineId, callback: 'onExit', from: machine.currentState, error: exitErr }); }
    }
    if (this._shutDown) return { ok: false, error: 'Shut down during transition' };
    machine.currentState = targetState;
    machine.history.push({ from: transition.from, to: targetState, timestamp: Date.now() });
    if (machine.history.length > MAX_HISTORY_PER_MACHINE) {
      machine.history = machine.history.slice(-Math.floor(MAX_HISTORY_PER_MACHINE / 2));
    }
    if (toStateObj && toStateObj.onEnter) {
      try { const r = toStateObj.onEnter(); if (r && typeof r.then === 'function') await r; } catch (enterErr) { this.emit('callback-error', { machineId, callback: 'onEnter', to: targetState, error: enterErr }); }
    }
    this.emit('state-transition', { machineId, from: transition.from, to: targetState });
    return { ok: true };
  }

  /**
   * 通过事件名称触发状态转换。
   * @param {string} machineId - 状态机标识
   * @param {string} eventName - 事件名称
   * @param {Object} [context] - 转换上下文
   * @returns {Promise<Object>} 转换结果，包含 ok 标志
   * @throws {HarnessError} 未找到匹配的转换规则时抛出异常
   */
  async transitionByEvent(machineId, eventName, context) {
    const machine = this._machines.get(machineId);
    if (!machine) return { ok: false, error: 'Machine not found' };
    const eventKey = machine.currentState + ':' + eventName;
    const candidates = machine._transitionByEvent.get(eventKey);
    const transition = candidates && candidates[0];
    if (!transition) throw new HarnessError('STATE_MACHINE_ERROR', 'No transition found for event ' + eventName + ' from state ' + machine.currentState);
    return this.transition(machineId, transition.to, context);
  }

  /**
   * 检查状态转换是否合法。评估守卫条件。
   * @param {string} machineId - 状态机标识
   * @param {string} [fromState] - 源状态，默认为当前状态
   * @param {string} toState - 目标状态
   * @param {Object} [context] - 传递给守卫条件的上下文
   * @returns {boolean} 转换合法返回 true
   */
  canTransition(machineId, fromState, toState, context) {
    const machine = this._machines.get(machineId);
    if (!machine) return false;
    const from = fromState || machine.currentState;
    const targetKey = from + '→' + toState;
    const candidates = machine._transitionByTarget.get(targetKey);
    const transition = candidates && candidates[0];
    if (!transition) return false;
    if (transition.guard) return transition.guard(context);
    return true;
  }

  /**
   * 获取状态机当前状态。
   * @param {string} machineId - 状态机标识
   * @returns {string|null} 当前状态名称，状态机不存在返回 null
   */
  getCurrentState(machineId) {
    const machine = this._machines.get(machineId);
    return machine ? machine.currentState : null;
  }

  /**
   * 获取状态机转换历史。
   * @param {string} machineId - 状态机标识
   * @returns {Object[]} 转换历史数组，每项包含 from、to、timestamp
   */
  getHistory(machineId) {
    const machine = this._machines.get(machineId);
    return machine ? machine.history.slice() : [];
  }

  /**
   * 重置状态机到初始状态。
   * @param {string} machineId - 状态机标识
   * @returns {boolean} 重置成功返回 true，状态机不存在返回 false
   */
  reset(machineId) {
    const machine = this._machines.get(machineId);
    if (!machine) return false;
    machine.currentState = machine.initialState;
    machine.history = [];
    return true;
  }

  /**
   * 获取当前状态下可用的转换列表。
   * @param {string} machineId - 状态机标识
   * @returns {Object[]} 可用转换数组，每项包含 from、to、event、guard
   */
  getAvailableTransitions(machineId) {
    const machine = this._machines.get(machineId);
    if (!machine) return [];
    return machine.transitions.filter(t => t.from === machine.currentState);
  }

  /**
   * 获取状态机摘要信息。
   * @param {string} machineId - 状态机标识
   * @returns {Object|null} 状态机信息对象，包含 id、currentState、stateCount、transitionCount
   */
  getMachineInfo(machineId) {
    const machine = this._machines.get(machineId);
    if (!machine) return null;
    return {
      id: machine.id,
      currentState: machine.currentState,
      stateCount: machine.states.size,
      transitionCount: machine.transitions.length,
    };
  }

  /**
   * 设置键值状态。超出上限时淘汰最早的条目。
   * @param {string} key - 状态键
   * @param {*} value - 状态值
   * @returns {boolean} 始终返回 true
   * @emits 'state-changed' 当状态值变更时触发
   */
  setState(key, value) {
    this.guardShutdown();
    if (this._states.size >= MAX_STATES && !this._states.has(key)) {
      const oldestKey = this._states.keys().next().value;
      this._states.delete(oldestKey);
    }
    this._states.set(key, { value, updatedAt: Date.now() });
    this.emit('state-changed', { key, value });
    return true;
  }

  /**
   * 获取键值状态。
   * @param {string} key - 状态键
   * @returns {*} 状态值，不存在返回 undefined
   */
  getState(key) {
    const state = this._states.get(key);
    return state ? state.value : undefined;
  }

  /**
   * 检查键值状态是否存在。
   * @param {string} key - 状态键
   * @returns {boolean} 存在返回 true
   */
  hasState(key) {
    return this._states.has(key);
  }

  /**
   * 移除键值状态。
   * @param {string} key - 状态键
   * @returns {boolean} 始终返回 true
   */
  removeState(key) {
    this.guardShutdown();
    this._states.delete(key);
    return true;
  }

  /**
   * 获取所有键值状态的快照。
   * @returns {Object} 键值状态映射对象
   */
  getAllStates() {
    const result = {};
    for (const [key, state] of this._states) {
      result[key] = { ...state };
    }
    return result;
  }

  /**
   * 获取状态管理器统计信息。
   * @returns {Object} 统计对象，包含 totalMachines 和 totalStates
   */
  getStats() {
    return {
      totalMachines: this._machines.size,
      totalStates: this._states.size,
      ...super.getStats(),
    };
  }

  /**
   * 关闭时清理所有状态机和键值状态。
   * @protected
   */
  _onShutdown() {
    this._machines.clear();
    this._states.clear();
    super._onShutdown();
  }
}

module.exports = DeepeningStateManager;
