'use strict';
const DeepeningBase = require('./deepening-base');
const DeepeningOrchestrator = require('./deepening-orchestrator');
const DeepeningMetricsCollector = require('./deepening-metrics-collector');
const DeepeningCache = require('./deepening-cache');
const DeepeningStrategyPlugin = require('./deepening-strategy-plugin');
const DeepeningReportGenerator = require('./deepening-report-generator');
const ConvergenceDetector = require('./convergence-detector');
const QualityScorer = require('../quality/quality-scorer');
const { timestampId, ID_PREFIXES } = require('../../utils/unique-id');
const { debug } = require('../../utils/debug-logger');

/**
 * @constant {number}
 * 默认最大迭代次数。
 */
const DEFAULT_MAX_ITERATIONS = 4;

/**
 * @module runtime/deepening/deepening-pipeline
 * 深化管道。串联21个子模块（调度器/控制器/路由器/融合/缓存/熔断/限流等），
 * 实现从初始化到缓存检查到迭代执行到完成的完整深化推理流水线。
 */
/**
 * @classdesc 深化管道。串联编排器、指标采集器、缓存、策略插件、报告生成器、
 * 收敛检测器和质量评分器等子模块，实现从初始化到缓存检查到迭代执行到完成的
 * 完整深化推理流水线。支持自动初始化和手动初始化两种模式。
 *
 * @extends DeepeningBase
 * @emits 'pipeline-initialized' 当管道初始化完成时触发
 * @emits 'pipeline-start' 当管道运行开始时触发
 * @emits 'pipeline-complete' 当管道运行完成时触发
 */
class DeepeningPipeline extends DeepeningBase {
  /**
   * 管道阶段枚举。
   * @static
   * @type {{INIT: string, CACHE_CHECK: string, ITERATIVE_EXECUTION: string, COMPLETE: string}}
   */
  static PIPELINE_STAGES = { INIT: 'init', CACHE_CHECK: 'cache-check', ITERATIVE_EXECUTION: 'iterative-execution', COMPLETE: 'complete' };

  /**
   * 构造函数。当autoInitialize不为false时自动初始化管道。
   * @param {Object} [config] - 管道配置
   * @param {boolean} [config.autoInitialize=true] - 是否自动初始化
   * @param {number} [config.maxIterations=4] - 最大迭代次数
   */
  constructor(config) {
    super(config);
    this._config = config ?? {};
    this._initialized = false;
    this._modules = {};
    this._pipelineRuns = 0;
    if (this._config.autoInitialize !== false) {
      try {
        this.initialize();
      } catch (err) {
        debug('DeepeningPipeline', 'autoInitFailed', err);
      }
    }
  }

  /**
   * 初始化管道，创建并挂载所有子模块（编排器、指标采集器、缓存、策略插件、
   * 报告生成器、收敛检测器、质量评分器）。
   * @returns {boolean} 初始化是否成功
   * @emits 'pipeline-initialized'
   * @example
   * const pipeline = new DeepeningPipeline({ maxIterations: 10 });
   * await pipeline.initialize();
   * const result = await pipeline.run({ task: 'Optimize algorithm', agent: 'worker' });
   */
  initialize() {
    if (this._initialized) return true;
    const orch = new DeepeningOrchestrator(this._config);
    const mc = new DeepeningMetricsCollector();
    const cache = new DeepeningCache();
    const sp = new DeepeningStrategyPlugin('default', { type: 'fixed-depth', maxIterations: this._config.maxIterations ?? DEFAULT_MAX_ITERATIONS });
    const rg = new DeepeningReportGenerator();
    const cd = new ConvergenceDetector();
    const qs = new QualityScorer();

    orch.attachMetricsCollector(mc);
    orch.attachCache(cache);
    orch.attachStrategyPlugin(sp);
    orch.attachReportGenerator(rg);
    orch.attachConvergenceDetector(cd);
    orch.attachQualityScorer(qs);

    this._modules.orchestrator = orch;
    this._modules.metricsCollector = mc;
    this._modules.cache = cache;
    this._modules.strategyPlugin = sp;
    this._modules.reportGenerator = rg;
    this._modules.convergenceDetector = cd;
    this._modules.qualityScorer = qs;

    this._initialized = true;
    this.emit('pipeline-initialized');
    return true;
  }

  /**
   * 运行深化推理管道。将任务和Agent委托给内部编排器执行。
   * @param {Object} task - 任务对象
   * @param {Array<Object>|Object} agents - Agent列表或映射对象
   * @returns {Promise<{success: boolean, pipelineId: string, duration: number, error?: string}>} 管道执行结果
   * @emits 'pipeline-start'
   * @emits 'pipeline-complete'
   */
  async run(task, agents) {
    this.guardShutdown();
    if (!this._initialized) {
      try {
        this.initialize();
      } catch (initErr) {
        return { success: false, error: 'Pipeline initialization failed: ' + (initErr && initErr.message ? initErr.message : String(initErr)), pipelineId: null, duration: 0 };
      }
    }
    const pipelineId = timestampId(ID_PREFIXES.DEEPENING_PIPE);
    const startTime = Date.now();
    this._pipelineRuns++;
    this.emit('pipeline-start', { task });

    if (!task || !agents) {
      const result = { success: false, error: 'Missing required parameters: task and agents', task, agents: 0, pipelineId, duration: Date.now() - startTime };
      this.emit('pipeline-complete', result);
      return result;
    }

    const orch = this._modules.orchestrator;
    if (orch) {
      try {
        const orchResult = await orch.execute(task, agents);
        const result = { ...orchResult, pipelineId, duration: Date.now() - startTime };
        this.emit('pipeline-complete', result);
        return result;
      } catch (err) {
        const result = { success: false, task, agents: Array.isArray(agents) ? agents.length : (agents ? Object.keys(agents).length : 0), pipelineId, duration: Date.now() - startTime, error: err && err.message ? err.message : String(err) };
        this.emit('pipeline-complete', result);
        return result;
      }
    }

    const result = { success: true, task, agents: Array.isArray(agents) ? agents.length : (agents ? Object.keys(agents).length : 0), pipelineId, duration: Date.now() - startTime };
    this.emit('pipeline-complete', result);
    return result;
  }

  /**
   * 按名称获取已加载的子模块实例。
   * @param {string} name - 模块名称
   * @returns {Object|null} 模块实例，未找到返回null
   */
  getModule(name) { return this._modules[name] ?? null; }

  /**
   * 生成指定类型的报告。
   * @param {string} type - 报告类型
   * @returns {Object} 报告内容
   */
  generateReport(type) {
    const rg = this._modules.reportGenerator;
    if (rg && typeof rg.generate === 'function') {
      return rg.generate(type, { executions: [] });
    }
    return { type, pipelineRuns: this._pipelineRuns, generatedAt: new Date().toISOString() };
  }

  /**
   * 获取管道运行统计信息。
   * @returns {{initialized: boolean, moduleCount: number, modules: string[], pipelineRuns: number, healthy: boolean, shutDown: boolean}} 统计信息
   */
  getStats() {
    const keys = Object.keys(this._modules);
    return {
      ...super.getStats(),
      initialized: this._initialized,
      moduleCount: keys.length,
      modules: keys,
      pipelineRuns: this._pipelineRuns,
    };
  }

  /**
   * 关闭时依次关闭所有子模块并清空模块引用。
   * @protected
   */
  _onShutdown() {
    const promises = [];
    for (const mod of Object.values(this._modules)) {
      if (mod && typeof mod.shutdown === 'function') {
        try {
          const r = mod.shutdown();
          if (r && typeof r.then === 'function') {
            promises.push(r.catch(function(err) {
              debug('DeepeningPipeline', '_onShutdown', 'Module async shutdown failed: ' + (err && err.message ? err.message : String(err)));
            }));
          }
        } catch (err) {
          debug('DeepeningPipeline', '_onShutdown', 'Module shutdown failed: ' + (err && err.message ? err.message : String(err)));
        }
      }
    }
    this._initialized = false;
    this._modules = {};
    super._onShutdown();
    if (promises.length > 0) {
      return Promise.allSettled(promises);
    }
  }
}

module.exports = DeepeningPipeline;
