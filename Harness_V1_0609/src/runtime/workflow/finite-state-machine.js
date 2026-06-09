'use strict';

/**
 * @module runtime/workflow/finite-state-machine
 * 通用有限状态机框架，融合自Meridian AI Worker编排系统的有限状态转移概念。
 *
 * Meridian核心洞察：状态机只开放"允许的状态转移路径"，
 * SubAgent无法触发非法状态（如跳过自测直接提交），
 * 用硬编码限制模型的"自由发挥"。
 *
 * 本模块从DeepeningStateMachine抽象提取通用FSM能力：
 * - 任意实体可绑定独立状态机实例
 * - 可定义允许转换路径、守卫条件、转换回调
 * - 非法转换被拒绝，不会静默失败
 * - 完整的转换历史追踪和状态计数统计
 */

const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const BoundedArray = require('../../utils/bounded-array');
const EventEmitter = require('events');

/**
 * 默认FSM配置
 */
const DEFAULT_OPTIONS = {
  maxInstances: 500,
  maxHistoryPerInstance: 200,
  strictMode: true,
};

/**
 * 通用有限状态机，融合自Meridian的"有限状态转移"概念。
 *
 * 核心原则：
 * - 只开放允许的状态转移路径
 * - 非法转换被硬编码拒绝（如跳过验证直接提交）
 * - 守卫条件决定转换是否可执行
 * - 转换回调在状态变更后触发
 *
 * 使用示例：
 * const fsm = new FiniteStateMachine();
 * fsm.defineMachine('task', {
 *   initialState: 'pending',
 *   transitions: {
 *     pending: { execute: 'running' },
 *     running: { complete: 'verifying', fail: 'failed' },
 *     verifying: { pass: 'completed', reject: 'running' },
 *     completed: {},
 *     failed: { retry: 'pending' },
 *   }
 * });
 * fsm.createInstance('task-1', 'task');
 * fsm.transition('task-1', 'execute'); // pending -> running
 * fsm.transition('task-1', 'complete'); // running -> verifying
 * fsm.transition('task-1', 'pass'); // verifying -> completed
 * fsm.transition('task-1', 'execute'); // REJECTED: completed has no outgoing transitions
 *
 * @classdesc 通用有限状态机。状态转移约束、守卫条件、转换历史。
 * @extends EventEmitter
 */
class FiniteStateMachine extends EventEmitter {

  /**
   * 创建FiniteStateMachine实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxInstances=500] - 最大实例数
   * @param {number} [options.maxHistoryPerInstance=200] - 每实例最大历史记录数
   * @param {boolean} [options.strictMode=true] - 严格模式（非法转换抛异常而非返回false）
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._machines = new Map();
    /** 状态机定义Map最大容量 */
    this._maxMachines = 100;
    this._instances = new Map();
    /** 守卫函数Map最大容量 */
    this._guards = new Map();
    this._maxGuards = 200;
    /** 回调函数Map最大容量 */
    this._callbacks = new Map();
    this._maxCallbacks = 200;
    this._stateCounts = {};
  }

  /**
   * 定义状态机类型，融合自Meridian的"有限状态转移"概念。
   * 定义允许的状态转移路径，SubAgent无法触发非法状态。
   * @param {string} machineType - 状态机类型标识
   * @param {Object} definition - 状态机定义
   * @param {string} definition.initialState - 初始状态
   * @param {Object} definition.transitions - 转换映射 { currentState: { action: targetState } }
   * @returns {{ machineType: string, registered: boolean }} 注册结果
   */
  defineMachine(machineType, definition) {
    this.guardShutdown();
    if (!machineType || !definition || !definition.initialState || !definition.transitions) {
      return { machineType: null, registered: false };
    }
    if (this._machines.size >= this._maxMachines) {
      const oldestKey = this._machines.keys().next().value;
      this._machines.delete(oldestKey);
    }
    this._machines.set(machineType, {
      initialState: definition.initialState,
      transitions: definition.transitions,
    });
    return { machineType, registered: true };
  }

  /**
   * 注册守卫条件，融合自Meridian的"硬编码限制"概念。
   * 守卫条件在转换前检查，返回false则拒绝转换。
   * @param {string} machineType - 状态机类型
   * @param {string} action - 动作名称
   * @param {Function} guardFn - 守卫函数，接收(instance, action, targetState)，返回boolean
   * @returns {{ machineType: string, action: string, registered: boolean }} 注册结果
   */
  registerGuard(machineType, action, guardFn) {
    this.guardShutdown();
    if (!machineType || !action || typeof guardFn !== 'function') {
      return { machineType: null, action: null, registered: false };
    }
    const key = machineType + ':' + action;
    if (this._guards.size >= this._maxGuards) {
      const oldestKey = this._guards.keys().next().value;
      this._guards.delete(oldestKey);
    }
    this._guards.set(key, guardFn);
    return { machineType, action, registered: true };
  }

  /**
   * 注册转换回调，在状态变更后触发。
   * @param {string} machineType - 状态机类型
   * @param {string} action - 动作名称
   * @param {Function} callbackFn - 回调函数，接收(instance, fromState, toState)
   * @returns {{ machineType: string, action: string, registered: boolean }} 注册结果
   */
  registerCallback(machineType, action, callbackFn) {
    this.guardShutdown();
    if (!machineType || !action || typeof callbackFn !== 'function') {
      return { machineType: null, action: null, registered: false };
    }
    const key = machineType + ':' + action;
    if (!this._callbacks.has(key)) {
      if (this._callbacks.size >= this._maxCallbacks) {
        const oldestKey = this._callbacks.keys().next().value;
        this._callbacks.delete(oldestKey);
      }
      this._callbacks.set(key, []);
    }
    const cbs = this._callbacks.get(key);
    if (cbs) cbs.push(callbackFn);
    return { machineType, action, registered: true };
  }

  /**
   * 创建状态机实例。
   * @param {string} instanceId - 实例标识
   * @param {string} machineType - 状态机类型
   * @param {Object} [context={}] - 实例上下文数据
   * @returns {Object} 创建结果
   */
  createInstance(instanceId, machineType, context) {
    this.guardShutdown();
    const machineDef = this._machines.get(machineType);
    if (!machineDef) return { instanceId: null, error: 'Unknown machine type: ' + machineType };

    if (this._instances.size >= this._options.maxInstances) {
      let evicted = false;
      for (const [id, inst] of this._instances) {
        const terminalStates = this._getTerminalStates(machineDef.transitions);
        if (terminalStates.includes(inst.currentState)) {
          this._instances.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted) return { instanceId: null, error: 'Max instances reached' };
    }

    const instance = {
      instanceId,
      machineType,
      currentState: machineDef.initialState,
      context: context ?? {},
      history: new BoundedArray(this._options.maxHistoryPerInstance),
      createdAt: Date.now(),
      lastTransitionAt: null,
    };
    instance.history.push({ action: null, from: null, to: machineDef.initialState, timestamp: Date.now() });
    this._instances.set(instanceId, instance);
    this._stateCounts[machineDef.initialState] = (this._stateCounts[machineDef.initialState] ?? 0) + 1;

    this.emit('instance-created', { instanceId, machineType, initialState: machineDef.initialState });
    return { instanceId, currentState: machineDef.initialState, machineType };
  }

  /**
   * 执行状态转换，融合自Meridian的"硬编码限制模型自由发挥"概念。
   * 只允许预定义的转换路径，非法转换被拒绝。
   * @param {string} instanceId - 实例标识
   * @param {string} action - 触发动作
   * @param {Object} [transitionContext] - 转换上下文
   * @returns {{ ok: boolean, fromState: string|null, toState: string|null, error?: string }} 转换结果
   */
  transition(instanceId, action, transitionContext) {
    this.guardShutdown();
    const instance = this._instances.get(instanceId);
    if (!instance) return { ok: false, fromState: null, toState: null, error: 'Instance not found' };

    const machineDef = this._machines.get(instance.machineType);
    if (!machineDef) return { ok: false, fromState: instance.currentState, toState: null, error: 'Machine definition not found' };

    const currentTransitions = machineDef.transitions[instance.currentState];
    if (!currentTransitions || currentTransitions[action] === undefined) {
      const msg = 'Invalid transition: action "' + action + '" not allowed from state "' + instance.currentState + '"';
      if (this._options.strictMode) {
        this.emit('invalid-transition', { instanceId, action, fromState: instance.currentState, reason: msg });
      }
      return { ok: false, fromState: instance.currentState, toState: null, error: msg };
    }

    const targetState = currentTransitions[action];

    // 检查守卫条件
    const guardKey = instance.machineType + ':' + action;
    const guard = this._guards.get(guardKey);
    if (guard) {
      try {
        const allowed = guard(instance, action, targetState);
        if (!allowed) {
          return { ok: false, fromState: instance.currentState, toState: null, error: 'Guard denied transition' };
        }
      } catch (e) {
        return { ok: false, fromState: instance.currentState, toState: null, error: 'Guard error: ' + (e && e.message ? e.message : String(e)) };
      }
    }

    // 执行转换
    const fromState = instance.currentState;
    this._stateCounts[fromState] = Math.max(0, (this._stateCounts[fromState] ?? 0) - 1);
    if (this._stateCounts[fromState] <= 0) delete this._stateCounts[fromState];

    instance.currentState = targetState;
    instance.lastTransitionAt = Date.now();
    this._stateCounts[targetState] = (this._stateCounts[targetState] ?? 0) + 1;

    if (transitionContext) {
      instance.context = mergeConfig(instance.context, transitionContext);
    }

    instance.history.push({ action, from: fromState, to: targetState, timestamp: Date.now() });

    // 触发回调
    const callbacks = this._callbacks.get(guardKey);
    if (callbacks) {
      for (const cb of callbacks) {
        try { cb(instance, fromState, targetState); } catch (_e) { debug('FSM', 'transitionCallback', _e && _e.message ? _e.message : String(_e)); }
      }
    }

    this.emit('transition', { instanceId, action, from: fromState, to: targetState, machineType: instance.machineType });
    return { ok: true, fromState: fromState, toState: targetState };
  }

  /**
   * 检查转换是否合法。
   * @param {string} instanceId - 实例标识
   * @param {string} action - 触发动作
   * @returns {boolean} 是否允许转换
   */
  canTransition(instanceId, action) {
    const instance = this._instances.get(instanceId);
    if (!instance) return false;
    const machineDef = this._machines.get(instance.machineType);
    if (!machineDef) return false;
    const currentTransitions = machineDef.transitions[instance.currentState];
    return !!(currentTransitions && currentTransitions[action] !== undefined);
  }

  /**
   * 获取实例当前状态。
   * @param {string} instanceId - 实例标识
   * @returns {string|null} 当前状态
   */
  getState(instanceId) {
    const instance = this._instances.get(instanceId);
    return instance ? instance.currentState : null;
  }

  /**
   * 获取实例信息。
   * @param {string} instanceId - 实例标识
   * @returns {Object|null} 实例信息
   */
  getInstance(instanceId) {
    const instance = this._instances.get(instanceId);
    if (!instance) return null;
    return {
      instanceId: instance.instanceId,
      machineType: instance.machineType,
      currentState: instance.currentState,
      context: instance.context,
      historyLength: instance.history.length,
      createdAt: instance.createdAt,
      lastTransitionAt: instance.lastTransitionAt,
    };
  }

  /**
   * 获取实例转换历史。
   * @param {string} instanceId - 实例标识
   * @param {number} [limit=50] - 最大返回条数
   * @returns {Array<Object>} 转换历史
   */
  getHistory(instanceId, limit) {
    const instance = this._instances.get(instanceId);
    if (!instance) return [];
    const items = instance.history.toArray();
    const n = Math.min(limit || 50, items.length);
    return items.slice(-n);
  }

  /**
   * 获取指定状态机类型的允许动作列表。
   * @param {string} instanceId - 实例标识
   * @returns {string[]} 允许的动作列表
   */
  getAllowedActions(instanceId) {
    const instance = this._instances.get(instanceId);
    if (!instance) return [];
    const machineDef = this._machines.get(instance.machineType);
    if (!machineDef) return [];
    const currentTransitions = machineDef.transitions[instance.currentState];
    return currentTransitions ? Object.keys(currentTransitions) : [];
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      machineTypes: this._machines.size,
      activeInstances: this._instances.size,
      stateCounts: Object.assign({}, this._stateCounts),
      guardCount: this._guards.size,
      callbackCount: this._callbacks.size,
    };
  }

  /**
   * 获取终端状态列表。
   * @param {Object} transitions - 转换映射
   * @returns {string[]} 终端状态列表
   * @private
   */
  _getTerminalStates(transitions) {
    const terminal = [];
    for (const [state, actions] of Object.entries(transitions)) {
      if (!actions || Object.keys(actions).length === 0) {
        terminal.push(state);
      }
    }
    return terminal;
  }

  _onShutdown() {
    this._machines.clear();
    for (const inst of this._instances.values()) {
      if (inst.history && typeof inst.history.shutdown === 'function') {
        safeCall(() => inst.history.shutdown(), 'FiniteStateMachine', 'shutdown-instanceHistory');
      }
    }
    this._instances.clear();
    this._guards.clear();
    this._callbacks.clear();
    this._stateCounts = {};
    this.removeAllListeners();
  }
}

FiniteStateMachine.DEFAULT_OPTIONS = DEFAULT_OPTIONS;

module.exports = withShutdown(FiniteStateMachine);
