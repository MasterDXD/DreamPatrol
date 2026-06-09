'use strict';
const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');
const { HarnessError } = require('../../errors');
/**
 * @constant {number}
 * 执行日志最大保留条数。
 */
const MAX_EXEC_LOG = 100;
const MAX_QUALITY_HISTORY = 500;

/**
 * @module runtime/deepening/deepening-orchestrator
 * 深化推理编排器。迭代精化、质量评分、收敛检测，
 * 可挂载指标采集/缓存/策略插件/报告生成/收敛检测/质量评分/事件存储等子模块。
 */
/**
 * @classdesc 深化推理编排器。迭代精化、质量评分、收敛检测，
 * 可挂载指标采集、缓存、策略插件、报告生成、收敛检测、质量评分、事件存储等子模块。
 * 支持多Agent并行/串行执行、缓存命中、策略决策早停、收敛检测终止和思维检索循环。
 *
 * @extends DeepeningBase
 * @emits 'execution-start' 当深化执行开始时触发，附带 {depthLevel}
 * @emits 'execution-complete' 当深化执行完成时触发，附带 {depthLevel, fromCache?}
 * @emits 'execution-error' 当深化执行出错时触发，附带 {error, task}
 * @emits 'agent-error' 当Agent执行出错时触发，附带错误信息和agentId
 */
class DeepeningOrchestrator extends DeepeningBase {
  /**
   * 构造函数。
   * @param {Object} [options] - 配置选项
   * @param {string} [options.defaultDepthLevel='standard'] - 默认深化深度级别
   * @param {number} [options.maxIterations] - 最大迭代次数
   * @param {number} [options.convergenceThreshold=0.85] - 收敛阈值
   * @param {boolean} [options.parallelAgentExecution] - 是否并行执行Agent
   */
  constructor(options) {
    super(options);
    this._execLog = [];
    this._totalExec = 0;
    this._attached = {
      metricsCollector: false,
      cache: false,
      strategyPlugin: false,
      reportGenerator: false,
      convergenceDetector: false,
      qualityScorer: false,
      eventStore: false,
      oodaLoop: false,
    };
    this._mc = null;
    this._cache = null;
    this._sp = null;
    this._rg = null;
    this._cd = null;
    this._qs = null;
    this._es = null;
  }

  /**
   * 通过多Agent路由器筛选有效Agent列表。路由失败时回退到原始Agent列表。
   * @param {Object} task - 任务对象
   * @param {Array<Object>|Object} agents - Agent列表或映射
   * @param {Object|null} multiAgentRouter - 多Agent路由器实例，需实现route方法
   * @returns {Array<Object>|Object} 路由后的Agent列表，失败时返回原始列表
   * @emits 'route-fallback' 当路由失败时触发
   */
  _routeAgents(task, agents, multiAgentRouter) {
    if (!multiAgentRouter) return agents;
    try {
      const routing = multiAgentRouter.route(task, this._agentList(agents).map(a => a.id ?? 'agent'));
      if (routing && routing.agents && routing.agents.length > 0) {
        const routedIds = new Set(routing.agents.map(a => a.agentId));
        const filtered = this._agentList(agents).filter(a => routedIds.has(a.id));
        if (filtered.length > 0) return filtered;
      }
    } catch (routeErr) {
      debug('DeepeningOrchestrator', 'multiAgentRoute', routeErr);
      this.emit('route-fallback', { reason: routeErr && routeErr.message ? routeErr.message : String(routeErr) });
    }
    return agents;
  }

  /**
   * 追加执行日志条目并裁剪超出上限的旧条目。
   * @param {string} taskId - 任务ID
   * @param {string} depthLevel - 深化深度级别
   */
  _trimExecLog(taskId, depthLevel) {
    this._execLog.push({ taskId, depthLevel, timestamp: Date.now() });
    if (this._execLog.length > MAX_EXEC_LOG) {
      this._execLog.splice(0, this._execLog.length - MAX_EXEC_LOG);
    }
  }

  /**
   * 构建执行失败的错误结果对象。
   * @param {Error} err - 捕获的异常对象
   * @param {Object} [options] - 执行选项，用于提取depthLevel
   * @returns {{ success: false, error: string, depthLevel: string, agentsUsed: Array, totalAgentCalls: number, qualityHistory: Array }} 错误结果
   */
  _buildErrorResult(err, options) {
    return {
      success: false,
      error: err && err.message ? err.message : String(err),
      depthLevel: (options && options.depthLevel != null) ? options.depthLevel : 'error',
      agentsUsed: [],
      totalAgentCalls: 0,
      qualityHistory: [],
    };
  }

  /**
   * 执行深化推理任务。支持缓存命中、多Agent路由、迭代执行、思维检索循环。
   * @param {Object} task - 任务对象，需包含id属性
   * @param {Array<Object>|Object} agents - Agent列表或Agent映射对象
   * @param {Object} [options] - 执行选项
   * @param {string} [options.depthLevel] - 深化深度级别（quick/standard/deep/intensive）
   * @param {Object} [options.multiAgentRouter] - 多Agent路由器实例
   * @returns {Promise<{success: boolean, depthLevel: string, agentsUsed: string[], totalAgentCalls: number, qualityHistory: number[], bestScore?: number, fromCache?: boolean, thoughtCycle?: Object, error?: string}>} 执行结果
   * @emits 'execution-start'
   * @emits 'execution-complete'
   * @emits 'execution-error'
   */
  async execute(task, agents, options) {
    try {
      this.guardShutdown();
      if (!task) return { success: false };
      const opts = options ?? {};
      const depthLevel = opts.depthLevel ?? this._options.defaultDepthLevel ?? 'standard';
      this.emit('execution-start', { depthLevel });
      this._recordEventStore('execution-start', task);

      const cachedResult = this._checkCache(task);
      if (cachedResult) {
        this._recordEventStore('execution-complete', task);
        this.emit('execution-complete', { depthLevel, fromCache: true });
        return cachedResult;
      }

      if (!agents) return { success: false };
      const agentList = this._agentList(agents);
      if (agentList.length === 0) return { success: false, error: 'No agents provided' };

      const effectiveAgents = this._routeAgents(task, agents, opts.multiAgentRouter);

      const result = this._buildResult(depthLevel, effectiveAgents);
      result.qualityHistory = [];
      await this._runIterations(task, effectiveAgents, depthLevel, result);
      if (this._shutDown) return result;
      await this._runThoughtCycle(task, effectiveAgents, result);
      if (this._shutDown) return result;
      this._cacheResult(task, result);
      this._recordMetrics(task, result);
      this._generateExecutionReport(task, result);
      this._trimExecLog(task.id ?? 'unknown', depthLevel);
      this._totalExec++;
      this.emit('execution-complete', { depthLevel });
      this._recordEventStore('execution-complete', task);
      return result;
    } catch (err) {
      this.emit('execution-error', { error: err, task: task.id ?? 'unknown' });
      return this._buildErrorResult(err, options);
    }
  }

  /**
   * 检查缓存中是否存在满足质量阈值的已有结果。
   * @param {Object} task - 任务对象
   * @returns {Object|null} 缓存命中则返回结果对象，否则返回null
   */
  _checkCache(task) {
    if (!this._cache) return null;
    try {
      const cached = this._cache.retrieve(task);
      if (cached && cached.qualityScore >= (typeof this._options.convergenceThreshold === 'number' && Number.isFinite(this._options.convergenceThreshold) ? this._options.convergenceThreshold : 0.85)) {
        return {
          success: true,
          fromCache: true,
          bestScore: cached.qualityScore,
          depthLevel: 'cached',
          agentsUsed: [],
          totalAgentCalls: 0,
          qualityHistory: [],
        };
      }
    } catch (cacheErr) { debug('DeepeningOrchestrator', 'cacheCheck', cacheErr); }
    return null;
  }

  /**
   * 向事件存储记录事件。
   * @param {string} event - 事件名称
   * @param {Object} task - 任务对象
   */
  _recordEventStore(event, task) {
    if (!this._es) return;
    try {
      const genResult = this._es.record(event, { taskId: task.id ?? 'unknown' });
      if (genResult && typeof genResult.then === 'function') genResult.catch(function(e) { debug('DeepeningOrchestrator', 'eventStore:' + event, e && e.message ? e.message : String(e)); });
    } catch (e) { debug('DeepeningOrchestrator', 'eventStore:' + event, e && e.message ? e.message : String(e)); }
  }

  /**
   * 构建初始执行结果对象。
   * @param {string} depthLevel - 深化深度级别
   * @param {Array<Object>|Object} agents - Agent列表或映射
   * @returns {{success: boolean, depthLevel: string, agentsUsed: string[], totalAgentCalls: number}} 初始结果对象
   */
  _buildResult(depthLevel, agents) {
    const agentList = this._agentList(agents);
    return {
      success: true,
      depthLevel,
      agentsUsed: agentList.map((a) => a.id ?? 'agent'),
      totalAgentCalls: 0,
    };
  }

  /**
   * 将agents参数统一转换为数组。
   * @param {Array<Object>|Object} agents - Agent数组或映射对象
   * @returns {Array<Object>} Agent数组
   */
  _agentList(agents) {
    if (Array.isArray(agents)) return agents;
    if (agents && typeof agents === 'object' && agents !== null) return Object.values(agents);
    return [];
  }

  /**
   * 执行单个Agent并记录结果到result对象。
   * @param {Object} task - 任务对象
   * @param {Object} agent - Agent实例，需实现execute方法
   * @param {Object} result - 累计结果对象，会修改其totalAgentCalls和qualityHistory
   * @emits 'agent-error' 当Agent执行出错时触发
   */
  async _executeAgent(task, agent, result) {
    try {
      const agentResult = await agent.execute(task);
      if (this._shutDown) return;
      result.totalAgentCalls++;
      if (agentResult && Number.isFinite(agentResult.qualityScore)) {
        result.qualityHistory.push(agentResult.qualityScore);
        if (result.qualityHistory.length > MAX_QUALITY_HISTORY) {
          result.qualityHistory.splice(0, result.qualityHistory.length - MAX_QUALITY_HISTORY);
        }
      } else if (this._qs && typeof this._qs.score === 'function') {
        try {
          const fallbackScore = await Promise.resolve(this._qs.score(task, agentResult));
          if (typeof fallbackScore === 'number' && Number.isFinite(fallbackScore)) {
            result.qualityHistory.push(fallbackScore);
            if (result.qualityHistory.length > MAX_QUALITY_HISTORY) {
              result.qualityHistory.splice(0, result.qualityHistory.length - MAX_QUALITY_HISTORY);
            }
          }
        } catch (qsErr) { debug('DeepeningOrchestrator', 'qualityScorerFallback', qsErr); }
      }
    } catch (agentErr) { debug('DeepeningOrchestrator', 'agentExecute', agentErr); emitError(this, 'agent-error', agentErr, { agentId: agent.id ?? 'unknown' }); }
  }

  /**
   * 判断是否应停止迭代。依次检查策略插件、收敛检测器和收敛阈值。
   * @param {number} iteration - 当前迭代序号
   * @param {Object} result - 累计结果对象
   * @param {Object} task - 任务对象
   * @returns {Promise<boolean>} 是否应停止迭代
   */
  async _shouldStopIterating(iteration, result, task) {
    const strategyStop = await this._checkStrategyDecision(iteration, result);
    if (strategyStop !== undefined) return strategyStop;
    const convergenceStop = await this._checkConvergence(result, task);
    if (convergenceStop !== undefined) return convergenceStop;
    const convergenceThreshold = this._options.convergenceThreshold;
    if (convergenceThreshold != null && result.qualityHistory.length > 0) {
      const lastQ = result.qualityHistory.length > 0 ? result.qualityHistory[result.qualityHistory.length - 1] : null;
      if (lastQ != null && lastQ >= convergenceThreshold) return true;
    }
    return false;
  }

  async _checkStrategyDecision(iteration, result) {
    if (!this._sp) return undefined;
    try {
      const strategyResult = await this._sp.decide({
        iteration: iteration,
        qualityScore: result.qualityHistory.length > 0 ? result.qualityHistory[result.qualityHistory.length - 1] : 0,
        totalAgentCalls: result.totalAgentCalls,
      });
      if (this._shutDown) return true;
      if (strategyResult && !strategyResult.shouldContinue) return true;
    } catch (spErr) { debug('DeepeningOrchestrator', 'strategyDecide', spErr); return { _error: spErr.message || String(spErr) }; }
    return undefined;
  }

  async _checkConvergence(result, task) {
    if (!this._cd || result.qualityHistory.length === 0) return undefined;
    const lastScore = result.qualityHistory[result.qualityHistory.length - 1] ?? 0;
    try {
      const convergenceResult = await Promise.resolve(this._cd.check(task.id ?? 'default', { qualityScore: lastScore }));
      if (this._shutDown) return true;
      if (convergenceResult && convergenceResult.converged) return true;
    } catch (cdErr) { debug('DeepeningOrchestrator', 'convergenceCheck', cdErr); return { _error: cdErr.message || String(cdErr) }; }
    return undefined;
  }

  /**
   * 执行多轮迭代推理。根据深度级别确定迭代次数，支持并行和串行Agent执行模式。
   * 并行模式使用Promise.allSettled确保单个Agent失败不影响其他Agent。
   * @param {Object} task - 待执行任务
   * @param {Array} agents - Agent列表
   * @param {string} depthLevel - 深度级别（quick/standard/intensive）
   * @param {Object} result - 累积结果对象
   * @returns {Promise<void>}
   * @private
   */
  async _shouldOodaBreak(task, depthLevel, iteration, maxIter, result, agentList) {
    if (!this._oodaLoop) return false;
    try {
      const lastQuality = result.qualityHistory.length > 0 ? result.qualityHistory[result.qualityHistory.length - 1] : 0;
      const observation = await Promise.resolve(this._oodaLoop.observe({
        taskContext: { taskId: task.id ?? 'unknown', depthLevel: depthLevel, iteration: iteration },
        agentState: { qualityScore: lastQuality, agentCount: agentList.length },
        environmentSignals: [{ type: 'iteration-progress', data: { iteration: iteration, maxIterations: maxIter, bestScore: typeof result.bestScore === 'number' && Number.isFinite(result.bestScore) ? result.bestScore : 0 } }],
      }));
      const orientation = await Promise.resolve(this._oodaLoop.orient(observation));
      const decision = await Promise.resolve(this._oodaLoop.decide(orientation));
      if (decision && decision.mode === 'reactive' && orientation && typeof orientation.threatLevel === 'number' && orientation.threatLevel > 0.8) {
        debug('DeepeningOrchestrator', 'oodaReactiveBreak', 'threat=' + orientation.threatLevel.toFixed(2));
        return true;
      }
    } catch (oodaErr) { debug('DeepeningOrchestrator', 'oodaIterationError', oodaErr); }
    return false;
  }

  async _executeAgentRound(task, agentList, parallel, result) {
    if (parallel && agentList.length > 1) {
      const settled = await Promise.allSettled(agentList.map(agent => this._executeAgent(task, agent, result)));
      for (const r of settled) {
        if (r.status === 'rejected' && r.reason) {
          this.emit('agent-error', { agent: 'unknown', error: r.reason && r.reason.message ? r.reason.message : String(r.reason) });
        }
      }
    } else {
      for (const agent of agentList) {
        await this._executeAgent(task, agent, result);
        if (this._shutDown) break;
      }
    }
  }

  async _runIterations(task, agents, depthLevel, result) {
    const maxIter = typeof this._options.maxIterations === 'number' && Number.isFinite(this._options.maxIterations) ? this._options.maxIterations : (depthLevel === 'quick' ? 1 : depthLevel === 'intensive' ? 4 : 2);
    const agentList = this._agentList(agents);
    const parallel = this._options && this._options.parallelAgentExecution;
    for (let i = 0; i < maxIter; i++) {
      if (this._shutDown) break;
      if (await this._shouldOodaBreak(task, depthLevel, i, maxIter, result, agentList)) break;
      await this._executeAgentRound(task, agentList, parallel, result);
      if (this._shutDown) break;
      if (await this._shouldStopIterating(i, result, task)) break;
      if (this._shutDown) break;
    }
    if (result.qualityHistory.length > 0) {
      const best = result.qualityHistory.filter(v => Number.isFinite(v)).reduce((a, b) => Math.max(a, b), -Infinity);
      result.bestScore = Number.isFinite(best) ? best : 0;
    }
  }

  /**
   * 将执行结果写入缓存。
   * @param {Object} task - 任务对象
   * @param {Object} result - 执行结果
   */
  _cacheResult(task, result) {
    if (!this._cache) return;
    try {
      const genResult = this._cache.store(task, result, { qualityScore: typeof result.bestScore === 'number' && Number.isFinite(result.bestScore) ? result.bestScore : 0 });
      if (genResult && typeof genResult.then === 'function') genResult.catch(function(e) { debug('DeepeningOrchestrator', 'cacheStore', e && e.message ? e.message : String(e)); });
    } catch (e) { debug('DeepeningOrchestrator', 'cacheStore', e && e.message ? e.message : String(e)); }
  }

  /**
   * 向指标采集器记录质量分数。
   * @param {Object} task - 任务对象
   * @param {Object} result - 执行结果
   */
  _recordMetrics(task, result) {
    if (!this._mc) return;
    try {
      const genResult = this._mc.record('quality-score', typeof result.bestScore === 'number' && Number.isFinite(result.bestScore) ? result.bestScore : 0, { taskId: task.id ?? 'unknown' });
      if (genResult && typeof genResult.then === 'function') genResult.catch(function(e) { debug('DeepeningOrchestrator', 'metricsRecord', e && e.message ? e.message : String(e)); });
    } catch (e) { debug('DeepeningOrchestrator', 'metricsRecord', e && e.message ? e.message : String(e)); }
  }

  /**
   * 生成执行摘要报告。
   * @param {Object} task - 任务对象
   * @param {Object} result - 执行结果
   */
  _generateExecutionReport(task, result) {
    if (!this._rg) return;
    try {
      const genResult = this._rg.generate('execution-summary', { executions: [result] });
      if (genResult && typeof genResult.then === 'function') genResult.catch(function(e) { debug('DeepeningOrchestrator', 'reportGenerate', e && e.message ? e.message : String(e)); });
    } catch (e) { debug('DeepeningOrchestrator', 'reportGenerate', e && e.message ? e.message : String(e)); }
  }

  /**
   * 执行思维检索循环，将Agent输出与任务上下文传入ThoughtRetrieverCycle。
   * @param {Object} task - 任务对象
   * @param {Array<Object>|Object} agents - Agent列表或映射
   * @param {Object} result - 累计结果对象，将附加thoughtCycle属性
   */
  async _runThoughtCycle(task, agents, result) {
    const trc = this._thoughtRetrieverCycle;
    if (!trc || typeof trc.execute !== 'function') return;
    try {
      const agentOutput = result.agentsUsed && result.agentsUsed.length > 0 ? result.agentsUsed.join(', ') : '';
      const context = { taskId: task.id, domain: task.domain, tags: task.tags, queryText: task.queryText };
      const cycleResult = await trc.execute(agentOutput, context);
      if (this._shutDown) return;
      if (!cycleResult) return;
      result.thoughtCycle = {
        distilled: cycleResult.distilledThoughts ? cycleResult.distilledThoughts.length : 0,
        stored: cycleResult.storedThoughts ? cycleResult.storedThoughts.length : 0,
        cycleComplete: cycleResult.cycleComplete,
        quality: cycleResult.quality,
      };
    } catch (trcErr) {
      debug('DeepeningOrchestrator', 'thoughtCycle', trcErr);
    }
  }

  /**
   * 获取执行日志列表。
   * @returns {Array<{taskId: string, depthLevel: string, timestamp: number}>} 执行日志数组
   */
  getExecutionLog() {
    this.guardShutdown();
    return this._execLog.slice();
  }

  /**
   * 挂载指标采集器。采集器必须实现record方法。
   * @param {Object} mc - 指标采集器实例
   * @returns {DeepeningOrchestrator} 当前实例，支持链式调用
   * @throws {HarnessError} 当采集器缺少record方法时抛出
   */
  attachMetricsCollector(mc) {
    this.guardShutdown();
    if (mc == null) return this;
    if (typeof mc.record !== 'function') {
      throw new HarnessError('METRICS_ERROR', 'MetricsCollector must have a record method');
    }
    this._mc = mc;
    this._attached.metricsCollector = true;
    return this;
  }

  /**
   * 挂载缓存模块。
   * @param {Object} c - 缓存实例，需实现retrieve和store方法
   * @returns {DeepeningOrchestrator} 当前实例，支持链式调用
   */
  attachCache(c) {
    this.guardShutdown();
    this._cache = c;
    this._attached.cache = true;
    return this;
  }

  /**
   * 挂载策略插件。策略插件需实现decide方法，用于控制迭代是否继续。
   * @param {Object} sp - 策略插件实例
   * @returns {DeepeningOrchestrator} 当前实例，支持链式调用
   */
  attachStrategyPlugin(sp) {
    this.guardShutdown();
    this._sp = sp;
    this._attached.strategyPlugin = true;
    return this;
  }

  /**
   * 挂载报告生成器。报告生成器需实现generate方法。
   * @param {Object} rg - 报告生成器实例
   * @returns {DeepeningOrchestrator} 当前实例，支持链式调用
   */
  attachReportGenerator(rg) {
    this.guardShutdown();
    this._rg = rg;
    this._attached.reportGenerator = true;
    return this;
  }

  /**
   * 挂载收敛检测器。收敛检测器需实现check方法。
   * @param {Object} cd - 收敛检测器实例
   * @returns {DeepeningOrchestrator} 当前实例，支持链式调用
   */
  attachConvergenceDetector(cd) {
    this.guardShutdown();
    this._cd = cd;
    this._attached.convergenceDetector = true;
    return this;
  }

  /**
   * 挂载质量评分器。
   * @param {Object} qs - 质量评分器实例
   * @returns {DeepeningOrchestrator} 当前实例，支持链式调用
   */
  attachQualityScorer(qs) {
    this.guardShutdown();
    this._qs = qs;
    this._attached.qualityScorer = true;
    return this;
  }

  /**
   * 挂载事件存储。事件存储需实现record方法。
   * @param {Object} es - 事件存储实例
   * @returns {DeepeningOrchestrator} 当前实例，支持链式调用
   */
  attachEventStore(es) {
    this.guardShutdown();
    this._es = es;
    this._attached.eventStore = true;
    return this;
  }

  /**
   * 附加OODA循环模块
   * @param {Object} oodaLoop - OODA循环实例
   * @returns {DeepeningOrchestrator} 当前实例（支持链式调用）
   */
  attachOodaLoop(oodaLoop) {
    this.guardShutdown();
    if (oodaLoop && typeof oodaLoop.execute === 'function') {
      this._oodaLoop = oodaLoop;
      this._attached.oodaLoop = true;
    } else if (oodaLoop) {
      debug('DeepeningOrchestrator', 'attachOodaLoop', 'invalid-oodaLoop-missing-execute');
    }
    return this;
  }

  /**
   * 生成指定类型的报告。
   * @param {string} type - 报告类型
   * @param {Object} data - 报告数据
   * @returns {Object|null} 报告内容，无报告生成器时返回null
   */
  generateReport(type, data) {
    if (!this._rg) return null;
    try {
      const genResult = this._rg.generate(type, data);
      if (genResult && typeof genResult.then === 'function') return null;
      return genResult;
    } catch (e) { debug('DeepeningOrchestrator', 'generateReport', e && e.message ? e.message : String(e)); return null; }
  }

  /**
   * 获取编排器运行统计信息。
   * @returns {{config: {defaultDepthLevel: string, maxIterations: number}, totalExecutions: number, attachedModules: Object, healthy: boolean, shutDown: boolean}} 统计信息
   */
  getStats() {
    return {
      ...super.getStats(),
      config: {
        defaultDepthLevel: this._options.defaultDepthLevel ?? 'standard',
        maxIterations: typeof this._options.maxIterations === 'number' && Number.isFinite(this._options.maxIterations) ? this._options.maxIterations : 4,
      },
      totalExecutions: this._shutDown ? 0 : this._totalExec,
      attachedModules: { ...this._attached },
    };
  }

  /**
   * 关闭时清理所有挂载模块和执行日志。
   * @protected
   */
  _onShutdown() {
    this._execLog = [];
    this._totalExec = 0;
    this._mc = null;
    this._cache = null;
    this._sp = null;
    this._rg = null;
    this._cd = null;
    this._qs = null;
    this._es = null;
    this._oodaLoop = null;
    this._attached = { metricsCollector: false, cache: false, strategyPlugin: false, reportGenerator: false, convergenceDetector: false, qualityScorer: false, eventStore: false, oodaLoop: false };
    super._onShutdown();
  }
}

module.exports = DeepeningOrchestrator;
