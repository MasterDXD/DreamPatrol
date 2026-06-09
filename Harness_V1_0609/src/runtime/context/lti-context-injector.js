'use strict';

const { EventEmitter } = require('events');
const deepClone = require('../../utils/deep-clone');
const safeAssign = require('../../utils/safe-assign');
const RingBuffer = require('../../utils/ring-buffer');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

const DEFAULT_INJECTION_MODE = 'lti';
const MAX_CONTEXT_HISTORY = 10;
const MAX_ORIGINAL_CONTEXTS = 200;
const MAX_INJECTION_HISTORY = 500;

/**
 * @module runtime/context/lti-context-injector
 * @classdesc LTI上下文注入器。学习工具互操作上下文注入
 * LTIContextInjector — LTI上下文注入器
 * 实现学习工具互操作（LTI）上下文注入，将原始任务上下文与当前任务状态融合，
 * 支持按迭代深度渐进式注入。维护原始上下文注册表和注入历史，用于跨迭代的上下文一致性保持。
 * @extends EventEmitter
 * @emits LTIContextInjector#context-registered
 * @emits LTIContextInjector#context-injected
 */
class LTIContextInjector extends EventEmitter {
  constructor(options) {
    super();
    this._mode = (options && options.mode) ?? DEFAULT_INJECTION_MODE;
    this._maxHistory = (options && options.maxHistory) ?? MAX_CONTEXT_HISTORY;
    this._originalContexts = new Map();
    this._injectionHistory = new Map();
  }

  /**
   * 注册原始任务上下文。将任务的初始上下文保存到注册表中，供后续注入使用。
   * 注册表超过上限时自动淘汰最早的条目。
   * @param {string} taskId - 任务ID
   * @param {Object} context - 原始上下文对象
   */
  registerOriginalContext(taskId, context) {
    this.guardShutdown();
    if (!taskId || typeof taskId !== 'string') {
      return;
    }
    const entry = {
      taskId,
      context: this._clone(context),
      registeredAt: new Date().toISOString(),
      injectionCount: 0,
    };
    this._originalContexts.set(taskId, entry);
    if (this._originalContexts.size > MAX_ORIGINAL_CONTEXTS) {
      const firstKey = this._originalContexts.keys().next().value;
      if (firstKey !== undefined) this._originalContexts.delete(firstKey);
    }
    this.emit('context-registered', { taskId });
  }

  /**
   * 将原始上下文注入到当前任务中。融合原始目标、约束和需求，
   * 在LTI模式下还会计算目标信号（当原始目标与当前目标重叠度低时注入原始目标）。
   * 注入后自动记录注入历史。
   * @param {string} taskId - 任务ID
   * @param {Object} currentTask - 当前任务状态
   * @param {number} [iteration=0] - 当前迭代深度
   * @returns {Object} 注入后的任务对象，taskId未注册时原样返回currentTask
   */
  inject(taskId, currentTask, iteration) {
    this.guardShutdown();
    const original = this._originalContexts.get(taskId);
    if (!original) {
      return currentTask;
    }

    const injected = this._performInjection(original.context, currentTask, iteration ?? 0);

    original.injectionCount++;
    this._recordInjection(taskId, iteration, injected);

    this.emit('context-injected', {
      taskId,
      iteration: iteration ?? 0,
      mode: this._mode,
    });

    return injected;
  }

  _performInjection(original, current, iteration) {
    let result;
    try {
      result = deepClone(current);
    } catch (_e) {
      debug('LtiContextInjector', 'performInjection:deepClone', _e && _e.message ? _e.message : String(_e));
      try {
        result = JSON.parse(JSON.stringify(current));
      } catch (__e) {
        debug('LtiContextInjector', 'performInjection:jsonClone', __e && __e.message ? __e.message : String(__e));
        result = safeAssign({}, current);
      }
    }

    result._ltiContext = {
      originalGoal: this._extractGoal(original),
      originalConstraints: this._extractConstraints(original),
      iteration,
      mode: this._mode,
      injectedAt: new Date().toISOString(),
    };

    if (this._mode === 'lti') {
      result._ltiContext.goalSignal = this._computeGoalSignal(original, current);
    }

    if (!result.description && original.description) {
      result.description = original.description;
    }
    if (!result.goal && original.goal) {
      result.goal = original.goal;
    }

    const originalRequirements = this._extractRequirements(original);
    if (originalRequirements.length > 0) {
      result._ltiContext.originalRequirements = originalRequirements;
    }

    return result;
  }

  _computeGoalSignal(original, current) {
    const originalGoal = this._extractGoal(original);
    if (!originalGoal) return null;

    const currentGoal = this._extractGoal(current);
    if (!currentGoal) return originalGoal;

    const overlap = this._computeOverlap(originalGoal, currentGoal);
    if (overlap < 0.5) {
      return originalGoal;
    }
    return null;
  }

  _computeOverlap(a, b) {
    const normA = a.toLowerCase();
    const normB = b.toLowerCase();
    if (normA === normB) return 1;
    const hasChinese = /[\u4e00-\u9fff]/.test(normA + normB);
    if (hasChinese) {
      const bigramsA = this._charBigrams(normA);
      const bigramsB = this._charBigrams(normB);
      let intersection = 0;
      for (const bg of bigramsA) { if (bigramsB.has(bg)) intersection++; }
      const union = new Set([...bigramsA, ...bigramsB]).size;
      return union > 0 ? intersection / union : 0;
    }
    const tokensA = new Set(normA.split(/\s+/).filter(Boolean));
    const tokensB = new Set(normB.split(/\s+/).filter(Boolean));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokensA) { if (tokensB.has(t)) overlap++; }
    const denom = tokensA.size + tokensB.size - overlap;
    return denom > 0 ? overlap / denom : 0;
  }

  _charBigrams(str) {
    const result = new Set();
    for (let i = 0; i < str.length - 1; i++) {
      result.add(str[i] + str[i + 1]);
    }
    return result;
  }

  _extractGoal(task) {
    if (!task) return '';
    return task.goal || task.description || task.userMessage || '';
  }

  _extractConstraints(task) {
    if (!task) return [];
    const constraints = [];
    if (task.constraints && Array.isArray(task.constraints)) {
      constraints.push(...task.constraints);
    }
    if (task.requirements && Array.isArray(task.requirements)) {
      constraints.push(...task.requirements);
    }
    return constraints;
  }

  _extractRequirements(task) {
    if (!task) return [];
    if (Array.isArray(task.requirements)) return task.requirements;
    if (typeof task.requirements === 'string') return [task.requirements];
    return [];
  }

  _recordInjection(taskId, iteration, injectedTask) {
    if (!this._injectionHistory.has(taskId)) {
      this._injectionHistory.set(taskId, new RingBuffer(this._maxHistory));
      if (this._injectionHistory.size > MAX_INJECTION_HISTORY) {
        const firstKey = this._injectionHistory.keys().next().value;
        if (firstKey !== undefined) this._injectionHistory.delete(firstKey);
      }
    }
    const history = this._injectionHistory.get(taskId);
    history.push({
      iteration,
      timestamp: new Date().toISOString(),
      hasGoalSignal: !!(injectedTask._ltiContext && injectedTask._ltiContext.goalSignal),
    });
  }

  /**
   * 获取指定任务的原始注册上下文。
   * @param {string} taskId - 任务ID
   * @returns {Object|null} 原始上下文对象，未注册时返回null
   */
  getOriginalContext(taskId) {
    this.guardShutdown();
    const entry = this._originalContexts.get(taskId);
    return entry ? entry.context : null;
  }

  /**
   * 获取指定任务的注入历史记录。每条记录包含迭代序号、时间戳和是否包含目标信号。
   * @param {string} taskId - 任务ID
   * @returns {Array<{iteration: number, timestamp: string, hasGoalSignal: boolean}>} 注入历史列表
   */
  getInjectionHistory(taskId) {
    this.guardShutdown();
    const hist = this._injectionHistory.get(taskId);
    return hist ? hist.toArray() : [];
  }

  /**
   * 取消注册指定任务的原始上下文及其注入历史。
   * @param {string} taskId - 任务ID
   * @returns {boolean} 该任务是否曾注册过
   */
  unregisterContext(taskId) {
    this.guardShutdown();
    const existed = this._originalContexts.delete(taskId);
    this._injectionHistory.delete(taskId);
    return existed;
  }

  _clone(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;
    return deepClone(obj);
  }

  /**
   * 获取注入器的统计信息，包括已注册上下文数、总注入次数、追踪任务数和当前模式。
   * @returns {{ registeredContexts: number, totalInjections: number, trackedTasks: number, mode: string }} 统计信息
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('LtiContextInjector', 'guardShutdown', _e && _e.message ? _e.message : String(_e)); return { registeredContexts: 0, totalInjections: 0, trackedTasks: 0, mode: '' }; }
    let totalInjections = 0;
    for (const [, hist] of this._injectionHistory) {
      totalInjections += hist.size;
    }
    return {
      registeredContexts: this._originalContexts.size,
      totalInjections,
      trackedTasks: this._injectionHistory.size,
      mode: this._mode,
    };
  }

  _onShutdown() {
    this._originalContexts.clear();
    this._injectionHistory.clear();
    this.removeAllListeners();
  }
}

LTIContextInjector.DEFAULT_INJECTION_MODE = DEFAULT_INJECTION_MODE;
LTIContextInjector.MAX_CONTEXT_HISTORY = MAX_CONTEXT_HISTORY;
LTIContextInjector.MAX_ORIGINAL_CONTEXTS = MAX_ORIGINAL_CONTEXTS;
LTIContextInjector.MAX_INJECTION_HISTORY = MAX_INJECTION_HISTORY;

module.exports = withShutdown(LTIContextInjector);
