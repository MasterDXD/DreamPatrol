'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { safeExecute, safeCall } = require('../../utils/safe-execute');
const { _timestampId, secureId } = require('../../utils/unique-id');
const { withShutdown } = require('../../utils/shutdown-mixin');
const EventEmitter = require('events');

/**
 * @module runtime/optimization/autonomous-research-loop
 * 自主研究闭环 — 实现autoresearch的"写代码-跑实验-看结果-改模型"核心循环。
 *
 * 核心理念：让AI形成自主研究闭环，替代人工反复试错流程。
 * "人类定方向，AI替人反复试错"——Karpathy autoresearch模式。
 *
 * 七阶段闭环：
 * 1. DEFINE（定义）：人类设定研究方向、优化目标和约束条件
 * 2. OBSERVE（观察）：收集当前状态数据，识别模式和异常
 * 3. HYPOTHESIZE（假设）：基于观察生成优化假设
 * 4. CODE（编码）：生成实验代码/配置
 * 5. EXPERIMENT（实验）：在沙箱中执行实验
 * 6. ANALYZE（分析）：分析实验结果，评估显著性
 * 7. REFINE（精炼）：应用优化方案，更新模型/策略，进入下一轮
 *
 * 集成现有组件：
 * - OODA-Loop：决策阶段的状态感知和自适应决策
 * - AutonomousOptimizationOrchestrator：六阶段优化编排
 * - ExperimentSandbox：实验沙箱执行
 * - ResearchDomainAdapter：领域适配和假设生成
 */

/** @constant {Object} LOOP_STAGES - 自主研究循环阶段 */
const LOOP_STAGES = {
  DEFINE: 'define',
  OBSERVE: 'observe',
  HYPOTHESIZE: 'hypothesize',
  CODE: 'code',
  EXPERIMENT: 'experiment',
  ANALYZE: 'analyze',
  REFINE: 'refine',
};

/** @constant {Object} LOOP_STATUS - 循环状态 */
const LOOP_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** @constant {Object} DEFAULT_OPTIONS - 默认配置 */
const DEFAULT_OPTIONS = {
  maxConcurrentLoops: 3,
  maxIterationsPerLoop: 10,
  maxHistorySize: 200,
  minObservationsBeforeHypothesis: 3,
  autoRefineThreshold: 0.7,
  experimentTimeoutMs: 60000,
  enableCodeGeneration: true,
  enableAutoRefine: true,
  domains: ['content', 'operations', 'ml_research', 'workflow'],
};

/**
 * @classdesc 自主研究闭环。实现autoresearch的完整七阶段循环，
 * 集成OODA决策、实验沙箱和领域适配器，支持多领域并行研究。
 * 替代人工反复试错流程，实现"人类定方向，AI反复试错"的工作模式。
 *
 * @extends EventEmitter
 * @emits 'loop-started' 当研究循环启动时触发
 * @emits 'stage-changed' 当循环阶段变更时触发
 * @emits 'hypothesis-generated' 当假设生成时触发
 * @emits 'experiment-created' 当实验创建时触发
 * @emits 'experiment-completed' 当实验完成时触发
 * @emits 'analysis-completed' 当分析完成时触发
 * @emits 'refinement-applied' 当优化应用时触发
 * @emits 'loop-completed' 当循环完成时触发
 * @emits 'loop-failed' 当循环失败时触发
 */
class AutonomousResearchLoop extends EventEmitter {
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._activeLoops = new Map();
    this._completedLoops = [];
    this._components = {
      oodaLoop: null,
      optimizationOrchestrator: null,
      experimentSandbox: null,
      domainAdapter: null,
      dataCollector: null,
      contentPublisher: null,
      researchJournal: null,
      evaluationCalibrator: null,
    };
    this._stats = {
      loopsStarted: 0,
      loopsCompleted: 0,
      loopsFailed: 0,
      hypothesesGenerated: 0,
      experimentsRun: 0,
      optimizationsApplied: 0,
      byDomain: {},
    };
    this._shutDown = false;
  }

  /**
   * 挂载外部组件。将OODA循环、优化编排器、实验沙箱、领域适配器、
   * 数据采集器、内容发布器、研究日志、评估校准器注入。
   * @param {string} name - 组件名称（oodaLoop/optimizationOrchestrator/experimentSandbox/
   *   domainAdapter/dataCollector/contentPublisher/researchJournal/evaluationCalibrator）
   * @param {Object} component - 组件实例
   * @returns {boolean} 是否挂载成功
   */
  attachComponent(name, component) {
    if (this._components.hasOwnProperty(name)) {
      this._components[name] = component;
      debug('AutonomousResearchLoop', 'attachComponent', 'name=' + name);
      return true;
    }
    return false;
  }

  /**
   * 启动研究循环。定义研究方向后启动完整的七阶段自主研究流程。
   * @param {Object} definition - 研究定义
   * @param {string} definition.domain - 研究领域
   * @param {string} definition.goal - 研究目标描述
   * @param {Object} [definition.constraints] - 约束条件
   * @param {Array<string>} [definition.targetMetrics] - 目标指标
   * @param {Object} [definition.initialConfig] - 初始配置
   * @returns {{success: boolean, loopId: string, error?: string}} 启动结果
   * @emits 'loop-started'
   */
  startLoop(definition) {
    this.guardShutdown();
    if (!definition || !definition.domain || !definition.goal) {
      return { success: false, error: 'Loop requires domain and goal' };
    }
    if (this._activeLoops.size >= this._options.maxConcurrentLoops) {
      return { success: false, error: 'Max concurrent loops reached' };
    }

    const loopId = secureId('arl-');
    const loop = {
      id: loopId,
      domain: definition.domain,
      goal: definition.goal,
      constraints: definition.constraints ?? {},
      targetMetrics: definition.targetMetrics ?? [],
      initialConfig: definition.initialConfig ?? {},
      status: LOOP_STATUS.RUNNING,
      stage: LOOP_STAGES.DEFINE,
      currentIteration: 0,
      maxIterations: definition.maxIterations ?? this._options.maxIterationsPerLoop,
      observations: [],
      hypotheses: [],
      experiments: [],
      results: [],
      appliedOptimizations: [],
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    };

    this._activeLoops.set(loopId, loop);
    this._stats.loopsStarted++;
    this._stats.byDomain[loop.domain] = (this._stats.byDomain[loop.domain] ?? 0) + 1;

    debug('AutonomousResearchLoop', 'startLoop', 'id=' + loopId + ' domain=' + loop.domain + ' goal=' + loop.goal);
    this.emit('loop-started', { loopId, domain: loop.domain, goal: loop.goal });

    return { success: true, loopId };
  }

  /**
   * 观察阶段。收集当前状态数据，识别模式和异常。
   * @param {string} loopId - 循环ID
   * @param {Object} [observationData] - 观察数据
   * @param {Object} [observationData.metrics] - 当前指标
   * @param {Object} [observationData.context] - 上下文
   * @param {Array<Object>} [observationData.signals] - 环境信号
   * @returns {{success: boolean, observation?: Object, error?: string}} 观察结果
   * @emits 'stage-changed'
   */
  observe(loopId, observationData) {
    this.guardShutdown();
    const loop = this._activeLoops.get(loopId);
    if (!loop) return { success: false, error: 'Loop not found: ' + loopId };
    if (loop.stage !== LOOP_STAGES.DEFINE && loop.stage !== LOOP_STAGES.OBSERVE && loop.stage !== LOOP_STAGES.REFINE) {
      return { success: false, error: 'Cannot observe in stage: ' + loop.stage };
    }

    const observation = {
      timestamp: Date.now(),
      metrics: observationData?.metrics ?? {},
      context: observationData?.context ?? {},
      signals: observationData?.signals ?? [],
      iteration: loop.currentIteration,
    };

    // 如果挂载了OODA循环，使用其观察能力
    if (this._components.oodaLoop && this._components.oodaLoop.isHealthy()) {
      safeExecute(() => {
        const oodaObs = this._components.oodaLoop.observe(
          observationData?.context,
          { loopId, domain: loop.domain, iteration: loop.currentIteration },
          observationData?.signals,
        );
        if (oodaObs) {
          observation.oodaConfidence = oodaObs.confidence;
          observation.oodaSignals = oodaObs.signals?.length ?? 0;
        }
      }, 'AutonomousResearchLoop', 'observe-ooda');
    }

    // 如果挂载了数据采集器，自动从外部平台拉取数据
    if (this._components.dataCollector && this._components.dataCollector.isHealthy()) {
      const platformData = safeExecute(
        () => this._components.dataCollector.extractByTemplate(loop.domain, {
          action: 'observe',
          goal: loop.goal,
        }),
        'AutonomousResearchLoop', 'observe-data-collector',
      );
      if (platformData) {
        observation.platformMetrics = platformData.metrics ?? {};
        observation.platformSignals = platformData.signals ?? [];
        // 合并平台数据到metrics
        Object.assign(observation.metrics, observation.platformMetrics);
      }
    }

    loop.observations.push(observation);
    loop.stage = LOOP_STAGES.HYPOTHESIZE;
    this.emit('stage-changed', { loopId, stage: LOOP_STAGES.HYPOTHESIZE, iteration: loop.currentIteration });

    debug('AutonomousResearchLoop', 'observe', 'loopId=' + loopId + ' metrics=' + Object.keys(observation.metrics).length);
    return { success: true, observation };
  }

  /**
   * 假设阶段。基于观察数据生成优化假设。
   * @param {string} loopId - 循环ID
   * @returns {{success: boolean, hypotheses?: Array<Object>, error?: string}} 假设列表
   * @emits 'stage-changed'
   * @emits 'hypothesis-generated'
   */
  hypothesize(loopId) {
    this.guardShutdown();
    const loop = this._activeLoops.get(loopId);
    if (!loop) return { success: false, error: 'Loop not found: ' + loopId };
    if (loop.stage !== LOOP_STAGES.HYPOTHESIZE) {
      return { success: false, error: 'Cannot hypothesize in stage: ' + loop.stage };
    }

    let hypotheses = [];

    // 如果挂载了领域适配器，使用其假设生成能力
    if (this._components.domainAdapter && this._components.domainAdapter.isHealthy()) {
      const patterns = this._extractPatternsFromObservations(loop.observations);
      const lastMetrics = loop.observations.length > 0
        ? loop.observations[loop.observations.length - 1]?.metrics ?? {}
        : {};

      hypotheses = safeExecute(
        () => this._components.domainAdapter.generateHypotheses(
          loop.domain,
          { patterns, currentMetrics: lastMetrics },
          Math.min(3, this._options.minObservationsBeforeHypothesis),
        ),
        'AutonomousResearchLoop', 'hypothesize-domain',
      ) ?? [];
    }

    // 如果挂载了优化编排器，使用其假设生成
    if (hypotheses.length === 0 && this._components.optimizationOrchestrator) {
      const optLoopId = 'opt-' + loopId;
      if (this._components.optimizationOrchestrator.getLoop(optLoopId)) {
        const insights = safeExecute(
          () => this._components.optimizationOrchestrator._generateInsights(
            this._extractPatternsFromObservations(loop.observations),
            loop.domain,
          ),
          'AutonomousResearchLoop', 'hypothesize-opt',
        ) ?? [];
        hypotheses = insights.map((insight, i) => ({
          id: 'hyp-' + Date.now() + '-' + i,
          domain: loop.domain,
          target: insight.metric,
          prediction: insight.prediction,
          confidence: insight.confidence,
          suggestedExperiment: 'ab_test',
          parameters: { metric: insight.metric },
        }));
      }
    }

    // 如果仍然没有假设，生成默认假设
    if (hypotheses.length === 0) {
      hypotheses = this._generateDefaultHypotheses(loop);
    }

    loop.hypotheses = hypotheses;
    this._stats.hypothesesGenerated += hypotheses.length;
    loop.stage = LOOP_STAGES.CODE;

    this.emit('hypothesis-generated', { loopId, count: hypotheses.length });
    this.emit('stage-changed', { loopId, stage: LOOP_STAGES.CODE, iteration: loop.currentIteration });

    debug('AutonomousResearchLoop', 'hypothesize', 'loopId=' + loopId + ' count=' + hypotheses.length);
    return { success: true, hypotheses };
  }

  /**
   * 编码阶段。为每个假设生成实验代码和配置。
   * @param {string} loopId - 循环ID
   * @returns {{success: boolean, experiments?: Array<Object>, error?: string}} 实验配置列表
   * @emits 'stage-changed'
   */
  code(loopId) {
    this.guardShutdown();
    const loop = this._activeLoops.get(loopId);
    if (!loop) return { success: false, error: 'Loop not found: ' + loopId };
    if (loop.stage !== LOOP_STAGES.CODE) {
      return { success: false, error: 'Cannot code in stage: ' + loop.stage };
    }

    const experimentConfigs = [];
    for (const hypothesis of loop.hypotheses) {
      const config = {
        hypothesisId: hypothesis.id,
        domain: loop.domain,
        template: {
          name: hypothesis.target ?? 'optimization',
          type: hypothesis.suggestedExperiment ?? 'ab_test',
        },
        parameters: hypothesis.parameters ?? {},
        timeoutMs: this._options.experimentTimeoutMs,
        createdAt: Date.now(),
      };
      experimentConfigs.push(config);
    }

    loop.stage = LOOP_STAGES.EXPERIMENT;
    loop.experiments = experimentConfigs;
    this.emit('stage-changed', { loopId, stage: LOOP_STAGES.EXPERIMENT, iteration: loop.currentIteration });

    debug('AutonomousResearchLoop', 'code', 'loopId=' + loopId + ' configs=' + experimentConfigs.length);
    return { success: true, experiments: experimentConfigs };
  }

  /**
   * 实验阶段。在沙箱中执行实验，收集结果。
   * @param {string} loopId - 循环ID
   * @returns {Promise<{success: boolean, results?: Array<Object>, error?: string}>} 实验结果
   * @emits 'stage-changed'
   * @emits 'experiment-created'
   * @emits 'experiment-completed'
   */
  async experiment(loopId) {
    this.guardShutdown();
    const loop = this._activeLoops.get(loopId);
    if (!loop) return { success: false, error: 'Loop not found: ' + loopId };
    if (loop.stage !== LOOP_STAGES.EXPERIMENT) {
      return { success: false, error: 'Cannot experiment in stage: ' + loop.stage };
    }

    const results = [];

    if (this._components.experimentSandbox && this._components.experimentSandbox.isHealthy()) {
      for (const config of loop.experiments) {
        this.emit('experiment-created', { loopId, hypothesisId: config.hypothesisId });

        const createResult = safeExecute(
          () => this._components.experimentSandbox.createExperiment(config),
          'AutonomousResearchLoop', 'experiment-create',
        );

        if (createResult?.success) {
          const expResult = await safeExecute(
            () => this._components.experimentSandbox.startExperiment(createResult.experimentId),
            'AutonomousResearchLoop', 'experiment-start',
          );
          results.push({
            hypothesisId: config.hypothesisId,
            experimentId: createResult.experimentId,
            success: expResult?.success ?? false,
            metrics: expResult?.metrics ?? {},
            error: expResult?.error ?? null,
          });
          this._stats.experimentsRun++;
          this.emit('experiment-completed', {
            loopId,
            experimentId: createResult.experimentId,
            hypothesisId: config.hypothesisId,
            success: expResult?.success ?? false,
          });
        } else {
          results.push({
            hypothesisId: config.hypothesisId,
            experimentId: null,
            success: false,
            error: createResult?.error ?? 'Failed to create experiment',
          });
        }
      }
    } else {
      // 无沙箱时的模拟实验
      for (const config of loop.experiments) {
        results.push({
          hypothesisId: config.hypothesisId,
          experimentId: 'sim-' + Date.now(),
          success: true,
          metrics: {
            domain: loop.domain,
            improvement: Math.round(Math.random() * 0.3 * 10000) / 10000,
            duration: Math.floor(Math.random() * 500),
          },
        });
        this._stats.experimentsRun++;
      }
    }

    loop.results = results;
    loop.stage = LOOP_STAGES.ANALYZE;
    this.emit('stage-changed', { loopId, stage: LOOP_STAGES.ANALYZE, iteration: loop.currentIteration });

    debug('AutonomousResearchLoop', 'experiment', 'loopId=' + loopId + ' results=' + results.length);
    return { success: true, results };
  }

  /**
   * 分析阶段。分析实验结果，评估显著性，生成建议。
   * @param {string} loopId - 循环ID
   * @returns {{success: boolean, analysis?: Object, error?: string}} 分析结果
   * @emits 'stage-changed'
   * @emits 'analysis-completed'
   */
  analyze(loopId) {
    this.guardShutdown();
    const loop = this._activeLoops.get(loopId);
    if (!loop) return { success: false, error: 'Loop not found: ' + loopId };
    if (loop.stage !== LOOP_STAGES.ANALYZE) {
      return { success: false, error: 'Cannot analyze in stage: ' + loop.stage };
    }

    const analysis = {
      timestamp: Date.now(),
      iteration: loop.currentIteration,
      totalExperiments: loop.results.length,
      successfulExperiments: loop.results.filter(r => r.success).length,
      failedExperiments: loop.results.filter(r => !r.success).length,
      bestResult: null,
      interpretations: [],
      shouldContinue: true,
      shouldRefine: false,
    };

    // 查找最佳结果
    if (loop.results.length > 0) {
      const sorted = [...loop.results]
        .filter(r => r.success && r.metrics)
        .sort((a, b) => {
          const aImp = a.metrics.improvement
            ? Object.values(a.metrics.improvement).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0)
            : 0;
          const bImp = b.metrics.improvement
            ? Object.values(b.metrics.improvement).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0)
            : 0;
          return bImp - aImp;
        });
      analysis.bestResult = sorted.length > 0 ? sorted[0] : null;
    }

    // 如果挂载了领域适配器，使用其解释能力
    if (this._components.domainAdapter && this._components.domainAdapter.isHealthy()) {
      for (const result of loop.results) {
        const hypothesis = loop.hypotheses.find(h => h.id === result.hypothesisId);
        const interpretation = safeExecute(
          () => this._components.domainAdapter.interpretResults(loop.domain, result, hypothesis),
          'AutonomousResearchLoop', 'analyze-interpret',
        );
        if (interpretation) {
          analysis.interpretations.push(interpretation);
        }
      }
    }

    // 判断是否应该继续迭代
    const maxIter = loop.maxIterations;
    if (loop.currentIteration >= maxIter) {
      analysis.shouldContinue = false;
      analysis.stopReason = 'max_iterations_reached';
    }

    // 判断是否应该应用优化
    if (analysis.bestResult?.success) {
      const improvement = analysis.bestResult.metrics?.improvement;
      if (improvement && typeof improvement === 'object') {
        const avgImp = Object.values(improvement)
          .filter(v => typeof v === 'number')
          .reduce((s, v) => s + v, 0) / (Object.keys(improvement).length || 1);
        analysis.shouldRefine = Math.abs(avgImp) >= this._options.autoRefineThreshold;
      }
    }

    // 如果挂载了评估校准器，使用校准阈值进行二元判断
    if (this._components.evaluationCalibrator && this._components.evaluationCalibrator.isHealthy()) {
      const calibrator = this._components.evaluationCalibrator;
      const threshold = safeExecute(
        () => calibrator.getCalibratedThreshold(),
        'AutonomousResearchLoop', 'analyze-calibrator',
      );
      if (threshold !== null && threshold !== undefined) {
        analysis.calibratedThreshold = threshold;
        analysis.binaryJudgment = this._binaryJudge(analysis, threshold);
      }
    }

    loop.stage = LOOP_STAGES.REFINE;
    loop._analysis = analysis;
    this.emit('analysis-completed', { loopId, analysis });
    this.emit('stage-changed', { loopId, stage: LOOP_STAGES.REFINE, iteration: loop.currentIteration });

    debug('AutonomousResearchLoop', 'analyze', 'loopId=' + loopId + ' shouldRefine=' + analysis.shouldRefine);
    return { success: true, analysis };
  }

  /**
   * 精炼阶段。应用优化方案，更新模型/策略，决定是否进入下一轮。
   * @param {string} loopId - 循环ID
   * @returns {{success: boolean, applied?: Array<Object>, shouldContinue?: boolean, error?: string}} 精炼结果
   * @emits 'stage-changed'
   * @emits 'refinement-applied'
   * @emits 'loop-completed'
   * @emits 'loop-failed'
   */
  refine(loopId) {
    this.guardShutdown();
    const loop = this._activeLoops.get(loopId);
    if (!loop) return { success: false, error: 'Loop not found: ' + loopId };
    if (loop.stage !== LOOP_STAGES.REFINE) {
      return { success: false, error: 'Cannot refine in stage: ' + loop.stage };
    }

    const analysis = loop._analysis;
    const applied = [];

    if (analysis?.shouldRefine && this._options.enableAutoRefine) {
      if (analysis.bestResult) {
        const optimization = {
          hypothesisId: analysis.bestResult.hypothesisId,
          metrics: analysis.bestResult.metrics,
          appliedAt: Date.now(),
          autoApplied: true,
        };
        applied.push(optimization);
        this._stats.optimizationsApplied++;
        this.emit('refinement-applied', { loopId, optimization });

        // 如果挂载了内容发布器，自动推送优化内容到外部平台
        if (this._components.contentPublisher && this._components.contentPublisher.isHealthy()) {
          const publishResult = safeExecute(
            () => this._components.contentPublisher.publish(
              loop.domain,
              { title: loop.goal, body: JSON.stringify(optimization.metrics), metadata: { loopId, iteration: loop.currentIteration } },
            ),
            'AutonomousResearchLoop', 'refine-publish',
          );
          if (publishResult?.success) {
            optimization.publishedTo = publishResult.publishId;
          }
        }
      }
    }

    loop.appliedOptimizations.push(...applied);
    loop.currentIteration++;

    const shouldContinue = analysis?.shouldContinue !== false
      && loop.currentIteration < loop.maxIterations
      && (analysis?.shouldRefine || loop.currentIteration < 3);

    // 如果挂载了研究日志，记录本轮迭代
    if (this._components.researchJournal && this._components.researchJournal.isHealthy()) {
      safeExecute(
        () => this._components.researchJournal.recordEntry({
          type: 'refinement',
          domain: loop.domain,
          goal: loop.goal,
          loopId,
          why: 'Auto-refine based on analysis: shouldRefine=' + (analysis?.shouldRefine ?? false),
          what: 'Applied ' + applied.length + ' optimizations',
          result: analysis?.binaryJudgment
            ? (analysis.binaryJudgment.passed ? 'passed (binary)' : 'failed (binary)')
            : (analysis?.shouldRefine ? 'refinement applied' : 'no refinement needed'),
          next: shouldContinue ? 'Continue to iteration ' + (loop.currentIteration + 1) : 'Loop completing',
          transferable: analysis?.bestResult
            ? 'Domain=' + loop.domain + ' target=' + analysis.bestResult.hypothesisId
            : '',
        }),
        'AutonomousResearchLoop', 'refine-journal',
      );
    }

    if (shouldContinue) {
      // 进入下一轮迭代
      loop.stage = LOOP_STAGES.OBSERVE;
      this.emit('stage-changed', { loopId, stage: LOOP_STAGES.OBSERVE, iteration: loop.currentIteration });
      debug('AutonomousResearchLoop', 'refine', 'loopId=' + loopId + ' continue=true iteration=' + loop.currentIteration);
    } else {
      // 循环完成
      loop.status = LOOP_STATUS.COMPLETED;
      loop.completedAt = Date.now();
      this._stats.loopsCompleted++;
      this._archiveLoop(loop);
      this.emit('loop-completed', {
        loopId,
        totalIterations: loop.currentIteration,
        totalOptimizations: loop.appliedOptimizations.length,
        duration: loop.completedAt - loop.startedAt,
      });
      debug('AutonomousResearchLoop', 'refine', 'loopId=' + loopId + ' completed');
    }

    return { success: true, applied, shouldContinue };
  }

  /**
   * 执行完整的七阶段循环。从定义到精炼的自动化执行。
   * @param {Object} definition - 研究定义（同startLoop）
   * @returns {Promise<{success: boolean, loopId: string, summary?: Object, error?: string}>} 执行结果
   */
  async executeFullLoop(definition) {
    const init = this._initializeResearchLoop(definition);
    if (!init.success) return init;

    const loopId = init.loopId;
    let continueLoop = true;
    let finalStatus = LOOP_STATUS.RUNNING;

    try {
      while (continueLoop) {
        const loop = this._activeLoops.get(loopId);
        if (!loop || loop.status !== LOOP_STATUS.RUNNING) break;

        const cycleResult = await this._executeResearchCycle(loopId, loop);
        if (!cycleResult.success) {
          finalStatus = LOOP_STATUS.FAILED;
          break;
        }

        if (!cycleResult.shouldContinue) {
          finalStatus = LOOP_STATUS.COMPLETED;
        }

        continueLoop = cycleResult.shouldContinue ?? false;
      }

      return this._finalizeResearch(loopId, definition, finalStatus);
    } catch (err) {
      const loop = this._activeLoops.get(loopId);
      if (loop) {
        loop.status = LOOP_STATUS.FAILED;
        loop.error = err && err.message ? err.message : String(err);
        this._stats.loopsFailed++;
      }
      this.emit('loop-failed', { loopId, error: loop?.error });
      return { success: false, loopId, error: loop?.error };
    }
  }

  /**
   * 初始化研究循环。
   * @param {Object} definition - 研究定义
   * @returns {Object} 初始化结果
   * @private
   */
  _initializeResearchLoop(definition) {
    return this.startLoop(definition);
  }

  /**
   * 执行单次研究循环（观察→假设→编码→实验→分析→精炼）。
   * @param {string} loopId - 循环ID
   * @param {Object} loop - 循环对象
   * @returns {Promise<{success: boolean, shouldContinue?: boolean}>} 循环结果
   * @private
   */
  async _executeResearchCycle(loopId, loop) {
    const phases = [
      () => this.observe(loopId, {
        metrics: loop.initialConfig?.metrics ?? {},
        context: { domain: loop.domain, goal: loop.goal },
      }),
      () => this.hypothesize(loopId),
      () => this.code(loopId),
      () => this.experiment(loopId),
      () => this.analyze(loopId),
      () => this.refine(loopId),
    ];

    for (const phaseFn of phases) {
      const result = await phaseFn();
      if (!result.success) {
        this._processResearchResult(loopId, loop, result.error);
        return { success: false };
      }
      if (result.shouldContinue !== undefined) {
        return { success: true, shouldContinue: result.shouldContinue };
      }
    }

    return { success: true };
  }

  /**
   * 处理研究结果（失败时更新状态）。
   * @param {string} loopId - 循环ID
   * @param {Object} loop - 循环对象
   * @param {string} error - 错误信息
   * @private
   */
  _processResearchResult(loopId, loop, error) {
    loop.status = LOOP_STATUS.FAILED;
    loop.error = error;
    this._stats.loopsFailed++;
    this.emit('loop-failed', { loopId, error });
  }

  /**
   * 最终化研究，构建摘要。
   * @param {string} loopId - 循环ID
   * @param {Object} definition - 研究定义
   * @param {string} finalStatus - 最终状态
   * @returns {{success: boolean, loopId: string, summary?: Object}} 最终结果
   * @private
   */
  _finalizeResearch(loopId, definition, finalStatus) {
    const loop = this._activeLoops.get(loopId);
    const completedLoop = this._completedLoops.find(c => c.id === loopId);
    const stats = this._extractLoopStats(loop, completedLoop, finalStatus);

    const summary = {
      loopId,
      domain: definition.domain,
      goal: definition.goal,
      ...stats,
    };

    return { success: stats.status === LOOP_STATUS.COMPLETED, loopId, summary };
  }

  /**
   * 提取循环统计数据。
   * @param {Object|null} loop - 活跃循环对象
   * @param {Object|null} completedLoop - 已完成循环对象
   * @param {string} finalStatus - 最终状态
   * @returns {Object} 统计数据
   * @private
   */
  _extractLoopStats(loop, completedLoop, finalStatus) {
    let status, totalIterations, totalHypotheses, totalExperiments, totalOptimizations, duration;

    if (completedLoop) {
      status = completedLoop.status;
      totalIterations = completedLoop.iterations;
      totalHypotheses = completedLoop.hypotheses;
      totalExperiments = completedLoop.experiments;
      totalOptimizations = completedLoop.optimizations;
      duration = completedLoop.duration;
    } else {
      status = loop?.status;
      totalIterations = loop?.currentIteration;
      totalHypotheses = loop?.hypotheses?.length;
      totalExperiments = loop?.results?.length;
      totalOptimizations = loop?.appliedOptimizations?.length;
      duration = loop ? (loop.completedAt ?? Date.now()) - loop.startedAt : 0;
    }

    return {
      status: status ?? finalStatus,
      totalIterations: totalIterations ?? 0,
      totalHypotheses: totalHypotheses ?? 0,
      totalExperiments: totalExperiments ?? 0,
      totalOptimizations: totalOptimizations ?? 0,
      duration: duration ?? 0,
    };
  }

  /**
   * 二元判断评估。将多维分析结果转化为passed/failed二元决策。
   * @param {Object} analysis - 分析结果
   * @param {number} threshold - 校准阈值
   * @returns {{passed: boolean, confidence: number, reason: string}} 二元判断结果
   * @private
   */
  _binaryJudge(analysis, threshold) {
    if (!analysis?.bestResult?.success) {
      return { passed: false, confidence: 0, reason: 'No successful result' };
    }
    const improvement = analysis.bestResult.metrics?.improvement;
    let score = 0;
    if (improvement && typeof improvement === 'object') {
      const values = Object.values(improvement).filter(v => typeof v === 'number');
      score = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
    } else if (typeof improvement === 'number') {
      score = improvement;
    }
    const passed = score >= threshold;
    return {
      passed,
      confidence: Math.min(Math.abs(score) / Math.max(threshold, 0.01), 1),
      reason: passed
        ? 'Score ' + score.toFixed(4) + ' >= threshold ' + threshold.toFixed(4)
        : 'Score ' + score.toFixed(4) + ' < threshold ' + threshold.toFixed(4),
    };
  }

  /**
   * 暂停研究循环。
   * @param {string} loopId - 循环ID
   * @returns {boolean} 是否成功暂停
   */
  pauseLoop(loopId) {
    const loop = this._activeLoops.get(loopId);
    if (!loop || loop.status !== LOOP_STATUS.RUNNING) return false;
    loop.status = LOOP_STATUS.PAUSED;
    return true;
  }

  /**
   * 恢复研究循环。
   * @param {string} loopId - 循环ID
   * @returns {boolean} 是否成功恢复
   */
  resumeLoop(loopId) {
    const loop = this._activeLoops.get(loopId);
    if (!loop || loop.status !== LOOP_STATUS.PAUSED) return false;
    loop.status = LOOP_STATUS.RUNNING;
    return true;
  }

  /**
   * 取消研究循环。
   * @param {string} loopId - 循环ID
   * @returns {boolean} 是否成功取消
   */
  cancelLoop(loopId) {
    const loop = this._activeLoops.get(loopId);
    if (!loop) return false;
    loop.status = LOOP_STATUS.CANCELLED;
    loop.completedAt = Date.now();
    this._archiveLoop(loop);
    return true;
  }

  /**
   * 获取循环状态。
   * @param {string} loopId - 循环ID
   * @returns {Object|null} 循环状态
   */
  getLoop(loopId) {
    return this._activeLoops.get(loopId) ?? null;
  }

  /**
   * 获取所有活跃循环。
   * @returns {Array<Object>} 活跃循环列表
   */
  getActiveLoops() {
    return Array.from(this._activeLoops.values());
  }

  /**
   * 获取已完成的循环历史。
   * @param {number} [limit] - 返回数量限制
   * @returns {Array<Object>} 历史循环列表
   */
  getCompletedLoops(limit) {
    if (limit && limit > 0) return this._completedLoops.slice(-limit);
    return this._completedLoops.slice();
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      activeLoops: this._activeLoops.size,
      completedLoops: this._completedLoops.length,
      loopsStarted: this._stats.loopsStarted,
      loopsCompleted: this._stats.loopsCompleted,
      loopsFailed: this._stats.loopsFailed,
      hypothesesGenerated: this._stats.hypothesesGenerated,
      experimentsRun: this._stats.experimentsRun,
      optimizationsApplied: this._stats.optimizationsApplied,
      byDomain: Object.assign({}, this._stats.byDomain),
      components: {
        oodaLoop: this._components.oodaLoop?.isHealthy() ?? false,
        optimizationOrchestrator: this._components.optimizationOrchestrator?.isHealthy() ?? false,
        experimentSandbox: this._components.experimentSandbox?.isHealthy() ?? false,
        domainAdapter: this._components.domainAdapter?.isHealthy() ?? false,
      },
      healthy: this.isHealthy(),
    };
  }

  /**
   * 从观察数据中提取模式。
   * @param {Array<Object>} observations - 观察列表
   * @returns {Array<Object>} 模式列表
   * @private
   */
  _extractPatternsFromObservations(observations) {
    if (!observations || observations.length === 0) return [];
    const patterns = [];
    const allMetricKeys = new Set();
    for (const obs of observations) {
      for (const key of Object.keys(obs.metrics ?? {})) {
        allMetricKeys.add(key);
      }
    }
    for (const key of allMetricKeys) {
      const values = observations
        .map(o => o.metrics[key])
        .filter(v => typeof v === 'number');
      if (values.length < 2) continue;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const trend = values.length >= 2 ? values[values.length - 1] - values[0] : 0;
      patterns.push({
        metric: key,
        mean: Math.round(mean * 10000) / 10000,
        trend,
        sampleSize: values.length,
      });
    }
    return patterns;
  }

  /**
   * 生成默认假设。
   * @param {Object} loop - 循环对象
   * @returns {Array<Object>} 默认假设列表
   * @private
   */
  _generateDefaultHypotheses(loop) {
    const count = Math.min(3, this._options.minObservationsBeforeHypothesis);
    const hypotheses = [];
    const targets = ['parameter', 'strategy', 'configuration'];
    const metrics = loop.targetMetrics.length > 0 ? loop.targetMetrics : ['quality', 'efficiency'];

    for (let i = 0; i < count; i++) {
      hypotheses.push({
        id: 'hyp-' + Date.now() + '-' + i,
        domain: loop.domain,
        target: targets[i % targets.length],
        prediction: `优化${targets[i % targets.length]}将提升${metrics[i % metrics.length]}指标`,
        confidence: 0.5,
        suggestedExperiment: 'ab_test',
        parameters: { metric: metrics[i % metrics.length], iterations: 10 },
      });
    }
    return hypotheses;
  }

  /**
   * 归档已完成的循环。
   * @param {Object} loop - 循环对象
   * @private
   */
  _archiveLoop(loop) {
    this._activeLoops.delete(loop.id);
    this._completedLoops.push({
      id: loop.id,
      domain: loop.domain,
      goal: loop.goal,
      status: loop.status,
      iterations: loop.currentIteration,
      hypotheses: loop.hypotheses.length,
      experiments: loop.results.length,
      optimizations: loop.appliedOptimizations.length,
      duration: loop.completedAt ? loop.completedAt - loop.startedAt : 0,
      completedAt: loop.completedAt,
    });
    if (this._completedLoops.length > this._options.maxHistorySize) {
      this._completedLoops.splice(0, this._completedLoops.length - this._options.maxHistorySize);
    }
  }

  /**
   * 检查实例是否健康。
   * @returns {boolean}
   */
  isHealthy() {
    return !this._shutDown;
  }

  /**
   * 守卫方法。
   * @throws {Error}
   */
  guardShutdown() {
    if (this._shutDown) throw new Error('AutonomousResearchLoop is shut down');
  }

  /**
   * 关闭时清理所有活跃循环。
   * @protected
   */
  _onShutdown() {
    for (const [_id, loop] of this._activeLoops) {
      safeCall(() => {
        loop.status = LOOP_STATUS.CANCELLED;
        loop.completedAt = Date.now();
      }, 'AutonomousResearchLoop', '_onShutdown');
    }
    this._activeLoops.clear();
    this._completedLoops = [];
  }
}

module.exports = withShutdown(AutonomousResearchLoop);
module.exports.LOOP_STAGES = LOOP_STAGES;
module.exports.LOOP_STATUS = LOOP_STATUS;
