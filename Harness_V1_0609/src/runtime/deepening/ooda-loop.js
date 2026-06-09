'use strict';
const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');

/**
 * @module runtime/deepening/ooda-loop
 * OODA（观察-判断-决策-行动）决策循环。实现Boyd循环的自适应推理模型。
 */
/**
 * @classdesc OODA决策循环。实现Boyd循环：观察（Observe）任务上下文和环境信号，
 * 判断（Orient）计算威胁/机会级别并检测决策偏差，决策（Decide）在
 * 反应式/审慎式/创造式三种模式间选择，行动（Act）并记录历史。
 * 支持自动循环模式以实现持续态势感知。
 *
 * @extends DeepeningBase
 * @emits 'ooda-observed' 当观察阶段完成时触发
 * @emits 'ooda-oriented' 当判断阶段完成时触发
 * @emits 'ooda-decided' 当决策阶段完成时触发
 * @emits 'ooda-acted' 当行动阶段完成时触发
 * @emits 'ooda-cycle-completed' 当完整OODA循环完成时触发
 * @emits 'ooda-auto-loop-triggered' 当自动循环触发时触发
 * @emits 'ooda-reset' 当重置时触发
 */
class OodaLoop extends DeepeningBase {
  /**
   * 决策模式枚举。
   * @static
   * @type {{REACTIVE: string, DELIBERATE: string, CREATIVE: string}}
   */
  static DECISION_MODES = { REACTIVE: 'reactive', DELIBERATE: 'deliberate', CREATIVE: 'creative' };

  /**
   * 默认配置项。
   * @static
   * @type {{maxHistorySize: number, autoLoop: boolean, threatThreshold: number, opportunityThreshold: number, observationWindow: number}}
   */
  static DEFAULT_CONFIG = { maxHistorySize: 200, autoLoop: false, threatThreshold: 0.7, opportunityThreshold: 0.6, observationWindow: 5 };

  /**
   * 嵌套层级枚举。
   * @static
   * @type {{STRATEGIC: string, OPERATIONAL: string, TACTICAL: string}}
   */
  static VALID_LEVELS = { STRATEGIC: 'strategic', OPERATIONAL: 'operational', TACTICAL: 'tactical' };

  /**
   * 构造函数。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxHistorySize=200] - 决策历史最大条目数
   * @param {boolean} [options.autoLoop=false] - 是否自动循环
   * @param {number} [options.threatThreshold=0.7] - 威胁级别阈值
   * @param {number} [options.opportunityThreshold=0.6] - 机会级别阈值
   * @param {number} [options.observationWindow=5] - 偏差检测观察窗口大小
   * @param {string} [options.level='tactical'] - OODA嵌套层级（strategic/operational/tactical）
   */
  constructor(options) {
    super(options);
    this._config = { ...OodaLoop.DEFAULT_CONFIG, ...this._options };
    for (const key of Object.keys(this._config)) {
      if (this._config[key] === undefined) this._config[key] = OodaLoop.DEFAULT_CONFIG[key];
    }
    const validLevels = Object.values(OodaLoop.VALID_LEVELS);
    this._level = validLevels.includes(this._config.level) ? this._config.level : OodaLoop.VALID_LEVELS.TACTICAL;
    this._decisionHistory = new Map();
    this._cycleCount = 0;
    this._lastActionResult = null;
    this._cycleTimings = [];
    this._goalDescription = null;
    this._autoLoopTimer = null;
    this._lastOrientation = null;
    this._consecutiveReactive = 0;
  }

  /**
   * 观察阶段。收集任务上下文、Agent状态和环境信号，计算综合置信度。
   * @param {Object} [taskContext] - 任务上下文数据
   * @param {Object} [agentState] - Agent状态数据
   * @param {Array<Object>|Object} [environmentSignals] - 环境信号数组或单个信号对象
   * @returns {{timestamp: number, signals: Array<{source: string, type: string, data: *, weight: number}>, confidence: number}} 观察结果
   * @emits 'ooda-observed'
   */
  observe(taskContext, agentState, environmentSignals) {
    this.guardShutdown();
    const signals = [];
    if (taskContext) {
      signals.push({ source: 'task', type: 'context', data: taskContext, weight: 0.4 });
    }
    if (agentState) {
      signals.push({ source: 'agent', type: 'state', data: agentState, weight: 0.3 });
    }
    if (environmentSignals) {
      if (Array.isArray(environmentSignals)) {
        for (const sig of environmentSignals) {
          if (!sig || typeof sig !== 'object') continue;
          signals.push({ source: 'environment', type: sig.type ?? 'signal', data: sig.data !== undefined ? sig.data : sig, weight: Number.isFinite(sig.weight) ? sig.weight : 0.3 });
        }
      } else {
        signals.push({ source: 'environment', type: 'signal', data: environmentSignals, weight: 0.3 });
      }
    }
    if (this._lastActionResult) {
      signals.push({ source: 'feedback', type: 'action-result', data: this._lastActionResult, weight: 0.2 });
    }
    const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
    const confidence = signals.length > 0 ? Math.min(1, totalWeight) : 0;
    const observation = { timestamp: Date.now(), signals, confidence };
    this.emit('ooda-observed', { signalCount: signals.length, confidence, level: this._level });
    debug('OodaLoop', 'observe', 'signals=' + signals.length + ' confidence=' + confidence.toFixed(2));
    return observation;
  }

  /**
   * 计算信号中的威胁级别和机会级别。
   * @param {Array<{data: Object, weight: number}>} signals - 信号数组
   * @returns {{threatLevel: number, opportunityLevel: number}} 威胁和机会级别（0-1）
   */
  _computeSignalLevels(signals) {
    let threatLevel = 0;
    let opportunityLevel = 0;
    for (const sig of signals) {
      const d = sig.data;
      if (!d || typeof d !== 'object') continue;
      if (d.error || d.failure || d.risk || d.threat) {
        threatLevel = Math.min(1, threatLevel + sig.weight * 0.5);
      }
      if (d.success || d.improvement || d.opportunity || d.growth) {
        opportunityLevel = Math.min(1, opportunityLevel + sig.weight * 0.5);
      }
      if (typeof d.threatLevel === 'number') {
        threatLevel = Math.min(1, threatLevel + d.threatLevel * sig.weight);
      }
      if (typeof d.opportunityLevel === 'number') {
        opportunityLevel = Math.min(1, opportunityLevel + d.opportunityLevel * sig.weight);
      }
    }
    return { threatLevel, opportunityLevel };
  }

  /**
   * 检测决策偏差。当最近观察窗口内某一决策模式占比超过80%时判定为偏差。
   * @returns {boolean} 是否检测到偏差
   */
  _detectBias() {
    const historyEntries = Array.from(this._decisionHistory.values()).flat();
    if (historyEntries.length < this._config.observationWindow) return false;
    const recent = historyEntries.slice(-this._config.observationWindow);
    const modeCounts = {};
    for (const entry of recent) {
      modeCounts[entry.mode] = (modeCounts[entry.mode] ?? 0) + 1;
    }
    const sorted = Object.entries(modeCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return false;
    const dominantMode = sorted[0];
    return dominantMode && typeof dominantMode[1] === 'number' && dominantMode[1] / recent.length > 0.8;
  }

  /**
   * 判断阶段。根据观察结果计算威胁/机会级别，检测决策偏差，
   * 确定推荐关注方向（威胁缓解/机会利用/态势感知）。
   * @param {Object} observation - 观察结果对象
   * @param {Array} observation.signals - 信号数组
   * @returns {{threatLevel: number, opportunityLevel: number, biasDetected: boolean, recommendedFocus: string}} 判断结果
   * @emits 'ooda-oriented'
   */
  orient(observation) {
    this.guardShutdown();
    if (!observation || !Array.isArray(observation.signals) || observation.signals.length === 0) {
      const orientation = { threatLevel: 0, opportunityLevel: 0, biasDetected: false, recommendedFocus: 'gather-more-data', strategicAlignment: 'unknown' };
      this.emit('ooda-oriented', { ...orientation, level: this._level });
      return orientation;
    }
    const { threatLevel, opportunityLevel } = this._computeSignalLevels(observation.signals);
    const biasDetected = this._detectBias();
    let recommendedFocus;
    if (threatLevel > this._config.threatThreshold) {
      recommendedFocus = 'threat-mitigation';
    } else if (opportunityLevel > this._config.opportunityThreshold) {
      recommendedFocus = 'opportunity-exploitation';
    } else {
      recommendedFocus = 'situational-awareness';
    }
    let strategicAlignment = 'unknown';
    if (this._goalDescription) {
      const goalKeywords = this._goalDescription.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      if (goalKeywords.length === 0) {
        strategicAlignment = 'unknown';
      } else {
        let aligned = false;
        for (const sig of observation.signals) {
          const dataStr = typeof sig.data === 'string' ? sig.data : sig.data && typeof sig.data === 'object' ? JSON.stringify(sig.data) : String(sig.data ?? '');
          const lower = dataStr.toLowerCase();
          for (const kw of goalKeywords) {
            if (lower.includes(kw)) {
              aligned = true;
              break;
            }
          }
          if (aligned) break;
        }
        strategicAlignment = aligned ? 'aligned' : 'misaligned';
      }
    }
    const orientation = { threatLevel, opportunityLevel, biasDetected, recommendedFocus, strategicAlignment };
    this.emit('ooda-oriented', { ...orientation, level: this._level });
    debug('OodaLoop', 'orient', 'threat=' + threatLevel.toFixed(2) + ' opportunity=' + opportunityLevel.toFixed(2) + ' bias=' + biasDetected + ' alignment=' + strategicAlignment);
    return orientation;
  }

  /**
   * 决策阶段。根据判断结果选择决策模式：威胁超阈值选反应式，
   * 机会超阈值选创造式，否则选审慎式。检测到偏差时强制切换为审慎式。
   * @param {Object} orientation - 判断结果对象
   * @param {number} orientation.threatLevel - 威胁级别
   * @param {number} orientation.opportunityLevel - 机会级别
   * @param {boolean} orientation.biasDetected - 是否检测到偏差
   * @returns {{mode: string, action: string, confidence: number, reasoning: string}} 决策结果
   * @emits 'ooda-decided'
   */
  decide(orientation) {
    this.guardShutdown();
    if (!orientation) {
      const decision = { mode: OodaLoop.DECISION_MODES.DELIBERATE, action: 'analyze', confidence: 0, reasoning: 'no-orientation-data' };
      this.emit('ooda-decided', { ...decision, level: this._level });
      return decision;
    }
    let mode;
    let action;
    let reasoning;
    const threatLevel = typeof orientation.threatLevel === 'number' ? orientation.threatLevel : 0;
    const opportunityLevel = typeof orientation.opportunityLevel === 'number' ? orientation.opportunityLevel : 0;
    if (threatLevel > this._config.threatThreshold) {
      mode = OodaLoop.DECISION_MODES.REACTIVE;
      action = 'respond-immediately';
      reasoning = 'threat-level-' + threatLevel.toFixed(2) + '-exceeds-threshold-' + this._config.threatThreshold;
    } else if (opportunityLevel > this._config.opportunityThreshold) {
      mode = OodaLoop.DECISION_MODES.CREATIVE;
      action = 'explore-opportunity';
      reasoning = 'opportunity-level-' + opportunityLevel.toFixed(2) + '-exceeds-threshold-' + this._config.opportunityThreshold;
    } else {
      mode = OodaLoop.DECISION_MODES.DELIBERATE;
      action = 'analyze-further';
      reasoning = 'balanced-situation-requires-deliberation';
    }
    if (orientation.biasDetected && mode !== OodaLoop.DECISION_MODES.DELIBERATE) {
      reasoning += '-bias-detected-switching-to-deliberate';
      mode = OodaLoop.DECISION_MODES.DELIBERATE;
      action = 'review-bias';
    }
    const confidence = Math.min(1, Math.max(orientation.threatLevel, orientation.opportunityLevel) * (orientation.biasDetected ? 0.6 : 1.0));
    const decision = { mode, action, confidence, reasoning };
    this.emit('ooda-decided', { ...decision, level: this._level });
    debug('OodaLoop', 'decide', 'mode=' + mode + ' action=' + action + ' confidence=' + confidence.toFixed(2));
    return decision;
  }

  /**
   * 行动阶段。将决策记录到历史中，返回行动结果和反馈。
   * @param {Object} decision - 决策结果对象
   * @param {string} decision.mode - 决策模式
   * @param {string} decision.action - 行动类型
   * @param {number} decision.confidence - 置信度
   * @param {Object} [context] - 上下文对象
   * @param {string} [context.cycleId] - 循环ID
   * @returns {{success: boolean, feedback: {actionTaken: string, mode: string}|null, cycleId: string, reason?: string}} 行动结果
   * @emits 'ooda-acted'
   */
  act(decision, context) {
    this.guardShutdown();
    if (!decision) {
      this.emit('ooda-acted', { success: false, reason: 'no-decision', level: this._level });
      return { success: false, feedback: null, cycleId: 'cycle-' + this._cycleCount, reason: 'no-decision' };
    }
    const cycleId = context && context.cycleId ? context.cycleId : 'cycle-' + this._cycleCount;
    if (!this._decisionHistory.has(cycleId)) {
      this._decisionHistory.set(cycleId, []);
      if (this._decisionHistory.size > this._config.maxHistorySize) {
        const oldest = this._decisionHistory.keys().next().value;
        this._decisionHistory.delete(oldest);
      }
    }
    const historyEntry = {
      mode: decision.mode,
      action: decision.action,
      confidence: decision.confidence,
      timestamp: Date.now(),
    };
    const history = this._decisionHistory.get(cycleId);
    if (history) {
      history.push(historyEntry);
      if (history.length > 100) history.splice(0, history.length - 100);
    }
    const result = { success: true, feedback: { actionTaken: decision.action, mode: decision.mode }, cycleId };
    this._lastActionResult = result;
    this.emit('ooda-acted', { ...result, level: this._level });
    debug('OodaLoop', 'act', 'action=' + decision.action + ' success=' + result.success);
    return result;
  }

  /**
   * 执行完整的OODA循环（观察→判断→决策→行动）。
   * @param {Object} [context] - 执行上下文
   * @param {Object} [context.taskContext] - 任务上下文
   * @param {Object} [context.agentState] - Agent状态
   * @param {Array|Object} [context.environmentSignals] - 环境信号
   * @returns {{cycleId: string, observation: Object, orientation: Object, decision: Object, actResult: Object, completedAt: number}} OODA循环结果
   * @emits 'ooda-cycle-completed'
   * @emits 'ooda-auto-loop-triggered'
   */
  execute(context) {
    this.guardShutdown();
    this._cycleCount++;
    const cycleStart = Date.now();
    const taskContext = context && context.taskContext;
    const agentState = context && context.agentState;
    const environmentSignals = context && context.environmentSignals;
    const observation = this.observe(taskContext, agentState, environmentSignals);
    const orientation = this.orient(observation);
    const decision = this.decide(orientation);
    const actResult = this.act(decision, { cycleId: 'cycle-' + this._cycleCount });
    const cycleDuration = Date.now() - cycleStart;
    this._cycleTimings.push(cycleDuration);
    if (this._cycleTimings.length > 50) this._cycleTimings.shift();
    const oodaCycle = {
      cycleId: 'cycle-' + this._cycleCount,
      observation,
      orientation,
      decision,
      actResult,
      completedAt: Date.now(),
      level: this._level,
    };
    this.emit('ooda-cycle-completed', oodaCycle);
    debug('OodaLoop', 'execute', 'cycle=' + this._cycleCount + ' mode=' + decision.mode + ' duration=' + cycleDuration + 'ms');
    // Track orientation and consecutive reactive count for smart autoLoop
    this._lastOrientation = orientation;
    if (decision.mode === 'reactive') {
      this._consecutiveReactive++;
    } else {
      this._consecutiveReactive = 0;
    }
    if (this._config.autoLoop && this.isHealthy()) {
      const triggerReason = this._evaluateAutoLoopTrigger(orientation, decision);
      if (triggerReason) {
        this.emit('ooda-auto-loop-triggered', { nextCycle: this._cycleCount + 1, level: this._level, triggerReason });
        const loopDelay = this._config.autoLoopIntervalMs ?? 1000;
        const self = this;
        this._autoLoopTimer = setTimeout(function() {
          if (self._shutDown) return;
          self._autoLoopTimer = null;
          if (self.isHealthy()) {
            try {
              self.execute(context);
            } catch (loopErr) {
              debug('OodaLoop', 'autoLoop', loopErr && loopErr.message ? loopErr.message : String(loopErr));
            }
          }
        }, loopDelay);
        if (typeof this._autoLoopTimer.unref === 'function') this._autoLoopTimer.unref();
      }
    }
    return oodaCycle;
  }

  /**
   * 评估autoLoop是否应该触发下一轮循环。
   * 智能触发条件：高威胁、高机会、连续反应式决策（停滞信号）、质量下降。
   * @param {Object} orientation - 当前判断结果
   * @param {Object} decision - 当前决策结果
   * @returns {string|null} 触发原因，null表示不应触发
   */
  _evaluateAutoLoopTrigger(orientation, _decision) {
    if (!orientation) return null;
    // 高威胁：需要持续监控
    if (orientation.threatLevel > this._config.threatThreshold) {
      return 'high-threat';
    }
    // 高机会：需要快速行动
    if (orientation.opportunityLevel > this._config.opportunityThreshold) {
      return 'high-opportunity';
    }
    // 连续反应式决策超过3次：可能陷入停滞
    if (this._consecutiveReactive >= 3) {
      return 'stagnation-detected';
    }
    // 质量下降：上一轮行动失败
    if (this._lastActionResult && this._lastActionResult.success === false) {
      return 'action-failed';
    }
    return null;
  }

  /**
   * 获取OODA循环运行统计信息。
   * @returns {{cycleCount: number, historySize: number, config: Object, healthy: boolean, shutDown: boolean}} 统计信息
   */
  getStats() {
    const cycleSpeed = this.getCycleSpeed();
    const lastActionResult = this._lastActionResult ? { success: this._lastActionResult.success, cycleId: this._lastActionResult.cycleId } : null;
    return {
      cycleCount: this._shutDown ? 0 : this._cycleCount,
      historySize: this._shutDown ? 0 : this._decisionHistory.size,
      config: { ...this._config },
      level: this._level,
      cycleSpeed,
      goalDescription: this._goalDescription,
      lastActionResult,
      ...super.getStats(),
    };
  }

  /**
   * 重置决策历史和循环计数。
   * @returns {boolean} 是否成功重置
   * @emits 'ooda-reset'
   */
  reset() {
    this.guardShutdown();
    this._decisionHistory.clear();
    this._cycleCount = 0;
    this._lastActionResult = null;
    this._cycleTimings = [];
    this._goalDescription = null;
    this.emit('ooda-reset', { level: this._level });
    debug('OodaLoop', 'reset', 'history-cleared');
    return true;
  }

  /**
   * 设置目标描述，用于判断阶段的目标对齐检测。
   * @param {string} description - 目标描述文本
   * @returns {OodaLoop} 当前实例，支持链式调用
   */
  setGoal(description) {
    this.guardShutdown();
    this._goalDescription = description ?? null;
    debug('OodaLoop', 'setGoal', 'goal=' + (description || 'cleared'));
    return this;
  }

  /**
   * 获取OODA循环速度统计信息。基于最近50次循环的耗时数据计算。
   * @returns {{avgMs: number, minMs: number, maxMs: number, lastMs: number, cycleCount: number}} 循环速度统计
   */
  getCycleSpeed() {
    const timings = this._cycleTimings;
    if (timings.length === 0) {
      return { avgMs: 0, minMs: 0, maxMs: 0, lastMs: 0, cycleCount: 0 };
    }
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const t of timings) {
      sum += t;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    return {
      avgMs: Math.round(sum / timings.length),
      minMs: min,
      maxMs: max,
      lastMs: timings.length > 0 ? timings[timings.length - 1] : 0,
      cycleCount: timings.length,
    };
  }

  /**
   * 关闭时清空决策历史和循环计数。
   * @protected
   */
  _onShutdown() {
    if (this._autoLoopTimer) {
      clearTimeout(this._autoLoopTimer);
      this._autoLoopTimer = null;
    }
    this._decisionHistory.clear();
    this._cycleCount = 0;
    this._lastActionResult = null;
    this._lastOrientation = null;
    this._consecutiveReactive = 0;
    this._cycleTimings = [];
    this._goalDescription = null;
    super._onShutdown();
  }
}

module.exports = OodaLoop;
