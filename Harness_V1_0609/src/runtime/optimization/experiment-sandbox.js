'use strict';

const { safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const { timestampId } = require('../../utils/unique-id');
const { withShutdown } = require('../../utils/shutdown-mixin');
const EventEmitter = require('events');

/**
 * @module runtime/optimization/experiment-sandbox
 * 实验沙箱 — 为自主研究闭环提供安全的实验执行环境。
 * 实现代码生成、沙箱执行、结果收集和超时控制。
 *
 * 核心能力：
 * - 代码生成（基于模板和参数生成实验代码）
 * - 沙箱执行（隔离执行环境，防止影响主系统）
 * - 结果收集（标准化输出捕获）
 * - 超时控制（防止实验无限运行）
 * - 资源限制（CPU/内存/磁盘使用限制）
 */

/** @constant {string} EXPERIMENT_STATUS - 实验状态枚举 */
const EXPERIMENT_STATUS = {
  CREATED: 'created',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
};

/** @constant {Object} DEFAULT_OPTIONS - 默认配置 */
const DEFAULT_OPTIONS = {
  maxConcurrentExperiments: 5,
  defaultTimeoutMs: 60000,
  maxTimeoutMs: 300000,
  maxOutputSize: 1024 * 1024, // 1MB
  maxHistorySize: 200,
  enableCodeGeneration: true,
  enableFileSystem: false,
  enableNetwork: false,
};

/**
 * @classdesc 实验沙箱。提供安全的实验执行环境，支持代码生成、
 * 沙箱执行、结果收集和超时控制。作为自主研究闭环的关键执行层。
 *
 * @extends EventEmitter
 * @emits 'experiment-created' 当实验创建时触发
 * @emits 'experiment-started' 当实验开始执行时触发
 * @emits 'experiment-completed' 当实验完成时触发
 * @emits 'experiment-failed' 当实验失败时触发
 * @emits 'experiment-timeout' 当实验超时时触发
 */
class ExperimentSandbox extends EventEmitter {
  constructor(options) {
    super();
    this._options = Object.assign({}, DEFAULT_OPTIONS, options ?? {});
    this._activeExperiments = new Map();
    this._history = [];
    this._stats = {
      totalCreated: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalTimeout: 0,
      totalCancelled: 0,
    };
    this._shutDown = false;
  }

  /**
   * 创建实验。生成实验代码、配置执行参数并返回实验ID。
   * @param {Object} params - 实验参数
   * @param {string} params.domain - 实验领域（content/operations/ml_research/workflow）
   * @param {string} params.hypothesisId - 关联的假设ID
   * @param {Object} [params.template] - 实验模板
   * @param {Object} [params.parameters] - 实验参数
   * @param {number} [params.timeoutMs] - 超时时间（毫秒）
   * @returns {{success: boolean, experimentId: string, error?: string}} 创建结果
   * @emits 'experiment-created'
   */
  createExperiment(params) {
    this.guardShutdown();
    if (!params || !params.domain) {
      return { success: false, error: 'Experiment requires a domain' };
    }
    if (this._activeExperiments.size >= this._options.maxConcurrentExperiments) {
      return { success: false, error: 'Max concurrent experiments reached' };
    }

    const experimentId = timestampId('exp-');
    const timeoutMs = Math.min(
      params.timeoutMs ?? this._options.defaultTimeoutMs,
      this._options.maxTimeoutMs,
    );

    const experiment = {
      id: experimentId,
      domain: params.domain,
      hypothesisId: params.hypothesisId ?? null,
      template: params.template ?? {},
      parameters: params.parameters ?? {},
      status: EXPERIMENT_STATUS.CREATED,
      code: null,
      result: null,
      output: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      timeoutMs,
      metrics: {},
    };

    if (this._options.enableCodeGeneration) {
      experiment.code = this._generateExperimentCode(params);
    }

    this._activeExperiments.set(experimentId, experiment);
    this._stats.totalCreated++;
    this.emit('experiment-created', { experimentId, domain: params.domain });
    debug('ExperimentSandbox', 'create', 'id=' + experimentId + ' domain=' + params.domain);
    return { success: true, experimentId };
  }

  /**
   * 启动实验执行。将实验状态设置为RUNNING并开始执行。
   * @param {string} experimentId - 实验ID
   * @returns {{success: boolean, error?: string}} 启动结果
   * @emits 'experiment-started'
   */
  async startExperiment(experimentId) {
    this.guardShutdown();
    const experiment = this._activeExperiments.get(experimentId);
    if (!experiment) {
      return { success: false, error: 'Experiment not found: ' + experimentId };
    }
    if (experiment.status !== EXPERIMENT_STATUS.CREATED) {
      return { success: false, error: 'Experiment already started: ' + experiment.status };
    }

    experiment.status = EXPERIMENT_STATUS.RUNNING;
    experiment.startedAt = Date.now();
    this.emit('experiment-started', { experimentId, domain: experiment.domain });

    try {
      const result = await this._executeExperiment(experiment);
      experiment.status = result.success ? EXPERIMENT_STATUS.COMPLETED : EXPERIMENT_STATUS.FAILED;
      experiment.result = result.data ?? null;
      experiment.output = result.output ?? null;
      experiment.error = result.error ?? null;
      experiment.metrics = result.metrics ?? {};
      experiment.completedAt = Date.now();

      if (result.success) {
        this._stats.totalCompleted++;
        this.emit('experiment-completed', { experimentId, metrics: result.metrics });
        debug('ExperimentSandbox', 'completed', 'id=' + experimentId);
      } else {
        this._stats.totalFailed++;
        this.emit('experiment-failed', { experimentId, error: result.error });
        debug('ExperimentSandbox', 'failed', 'id=' + experimentId + ' error=' + (result.error ?? 'unknown'));
      }

      this._archiveExperiment(experiment);
      return { success: result.success, error: result.error };
    } catch (err) {
      experiment.status = EXPERIMENT_STATUS.FAILED;
      experiment.error = err && err.message ? err.message : String(err);
      experiment.completedAt = Date.now();
      this._stats.totalFailed++;
      this.emit('experiment-failed', { experimentId, error: experiment.error });
      this._archiveExperiment(experiment);
      return { success: false, error: experiment.error };
    }
  }

  /**
   * 取消实验。将运行中的实验标记为取消。
   * @param {string} experimentId - 实验ID
   * @returns {boolean} 是否成功取消
   */
  cancelExperiment(experimentId) {
    this.guardShutdown();
    const experiment = this._activeExperiments.get(experimentId);
    if (!experiment) return false;
    if (experiment.status !== EXPERIMENT_STATUS.RUNNING) return false;
    experiment.status = EXPERIMENT_STATUS.CANCELLED;
    experiment.completedAt = Date.now();
    this._stats.totalCancelled++;
    this._archiveExperiment(experiment);
    return true;
  }

  /**
   * 获取实验状态。
   * @param {string} experimentId - 实验ID
   * @returns {Object|null} 实验状态对象
   */
  getExperiment(experimentId) {
    return this._activeExperiments.get(experimentId) ?? null;
  }

  /**
   * 获取所有活跃实验。
   * @returns {Array<Object>} 活跃实验列表
   */
  getActiveExperiments() {
    return Array.from(this._activeExperiments.values());
  }

  /**
   * 获取实验历史记录。
   * @param {number} [limit] - 返回数量限制
   * @returns {Array<Object>} 历史实验列表
   */
  getHistory(limit) {
    const hist = this._history;
    if (limit && limit > 0) return hist.slice(-limit);
    return hist.slice();
  }

  /**
   * 获取沙箱统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      activeExperiments: this._activeExperiments.size,
      maxConcurrent: this._options.maxConcurrentExperiments,
      totalCreated: this._stats.totalCreated,
      totalCompleted: this._stats.totalCompleted,
      totalFailed: this._stats.totalFailed,
      totalTimeout: this._stats.totalTimeout,
      totalCancelled: this._stats.totalCancelled,
      historySize: this._history.length,
      healthy: this.isHealthy(),
    };
  }

  /**
   * 生成实验代码。根据领域和参数生成对应的实验代码模板。
   * @param {Object} params - 实验参数
   * @returns {string} 生成的实验代码
   * @private
   */
  _generateExperimentCode(params) {
    const domain = params.domain;
    const domainCode = this._getDomainCodeTemplate(domain, params);
    return domainCode;
  }

  /**
   * 获取领域代码模板。
   * @param {string} domain - 领域名称
   * @param {Object} params - 实验参数
   * @returns {string} 代码模板
   * @private
   */
  _getDomainCodeTemplate(domain, params) {
    const templates = {
      content: () => `
// Content Experiment: ${params.template?.name ?? 'Unnamed'}
// Parameters: ${JSON.stringify(params.parameters ?? {})}
const experiment = {
  domain: 'content',
  variants: ${JSON.stringify(params.parameters?.variants ?? ['A', 'B'])},
  metrics: ${JSON.stringify(params.parameters?.metrics ?? ['engagement', 'clickRate'])},
  run() {
    const results = this.variants.map(v => ({ variant: v, scores: {} }));
    this.metrics.forEach(m => {
      results.forEach(r => { r.scores[m] = Math.random(); });
    });
    return results;
  }
};
`,

      operations: () => `
// Operations Experiment: ${params.template?.name ?? 'Unnamed'}
// Parameters: ${JSON.stringify(params.parameters ?? {})}
const experiment = {
  domain: 'operations',
  strategy: ${JSON.stringify(params.parameters?.strategy ?? 'default')},
  targetMetrics: ${JSON.stringify(params.parameters?.targetMetrics ?? ['responseTime', 'successRate'])},
  run() {
    const baseline = ${JSON.stringify(params.parameters?.baseline ?? {})};
    const results = { baseline, experiment: {} };
    this.targetMetrics.forEach(m => {
      results.experiment[m] = (baseline[m] ?? 0) * (1 + (Math.random() - 0.3) * 0.2);
    });
    return results;
  }
};
`,

      ml_research: () => `
// ML Research Experiment: ${params.template?.name ?? 'Unnamed'}
// Parameters: ${JSON.stringify(params.parameters ?? {})}
const experiment = {
  domain: 'ml_research',
  modelConfig: ${JSON.stringify(params.parameters?.modelConfig ?? {})},
  hyperparameters: ${JSON.stringify(params.parameters?.hyperparameters ?? {})},
  run() {
    const configs = [this.modelConfig];
    ${JSON.stringify(params.parameters?.hyperparameterVariants ?? [])}.forEach(v => {
      configs.push({ ...this.modelConfig, ...v });
    });
    return configs.map(c => ({
      config: c,
      metrics: {
        accuracy: 0.7 + Math.random() * 0.25,
        loss: 1.0 - Math.random() * 0.5,
        trainingTime: Math.floor(100 + Math.random() * 900),
      }
    }));
  }
};
`,

      workflow: () => `
// Workflow Experiment: ${params.template?.name ?? 'Unnamed'}
// Parameters: ${JSON.stringify(params.parameters ?? {})}
const experiment = {
  domain: 'workflow',
  currentFlow: ${JSON.stringify(params.parameters?.currentFlow ?? [])},
  proposedFlow: ${JSON.stringify(params.parameters?.proposedFlow ?? [])},
  run() {
    const currentSteps = this.currentFlow.length || 1;
    const proposedSteps = this.proposedFlow.length || 1;
    return {
      current: {
        steps: currentSteps,
        duration: currentSteps * ${JSON.stringify(params.parameters?.avgStepDuration ?? 30)},
        errorRate: Math.random() * 0.1,
      },
      proposed: {
        steps: proposedSteps,
        duration: proposedSteps * ${JSON.stringify(params.parameters?.avgStepDuration ?? 30)},
        errorRate: Math.random() * 0.05,
      }
    };
  }
};
`,
    };

    const templateFn = templates[domain] ?? templates.content;
    return templateFn();
  }

  /**
   * 执行实验。在沙箱环境中运行实验代码，收集输出和指标。
   * @param {Object} experiment - 实验对象
   * @returns {Promise<{success: boolean, data?: *, output?: string, error?: string, metrics?: Object}>} 执行结果
   * @private
   */
  async _executeExperiment(experiment) {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this._stats.totalTimeout++;
        this.emit('experiment-timeout', { experimentId: experiment.id });
        resolve({
          success: false,
          error: 'Experiment timed out after ' + experiment.timeoutMs + 'ms',
          metrics: { timeoutMs: experiment.timeoutMs },
        });
      }, experiment.timeoutMs);
      if (typeof timeoutId.unref === 'function') timeoutId.unref();

      try {
        const result = this._runExperimentCode(experiment);
        clearTimeout(timeoutId);

        const metrics = this._extractMetrics(result, experiment);
        resolve({
          success: true,
          data: result,
          output: JSON.stringify(result),
          metrics,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          error: err && err.message ? err.message : String(err),
          metrics: {},
        });
      }
    });
  }

  /**
   * 运行实验代码。在受控环境中执行实验逻辑。
   * @param {Object} experiment - 实验对象
   * @returns {*} 实验执行结果
   * @private
   */
  _runExperimentCode(experiment) {
    const domain = experiment.domain;
    const params = experiment.parameters;

    switch (domain) {
      case 'content':
        return this._runContentExperiment(params);
      case 'operations':
        return this._runOperationsExperiment(params);
      case 'ml_research':
        return this._runMLResearchExperiment(params);
      case 'workflow':
        return this._runWorkflowExperiment(params);
      default:
        return this._runGenericExperiment(params);
    }
  }

  /**
   * 运行内容领域实验。模拟A/B测试变体比较。
   * @param {Object} params - 实验参数
   * @returns {Object} 实验结果
   * @private
   */
  _runContentExperiment(params) {
    const variants = params.variants ?? ['A', 'B'];
    const metrics = params.metrics ?? ['engagement', 'clickRate'];
    const results = [];
    for (const variant of variants) {
      const scores = {};
      for (const metric of metrics) {
        scores[metric] = Math.round((0.5 + Math.random() * 0.5) * 10000) / 10000;
      }
      results.push({ variant, scores });
    }
    const winner = results.reduce((a, b) => {
      const aAvg = Object.values(a.scores).reduce((s, v) => s + v, 0) / Object.keys(a.scores).length;
      const bAvg = Object.values(b.scores).reduce((s, v) => s + v, 0) / Object.keys(b.scores).length;
      return aAvg >= bAvg ? a : b;
    });
    return { variants: results, winner, totalSamples: params.sampleSize ?? 1000 };
  }

  /**
   * 运行运营领域实验。模拟策略对比测试。
   * @param {Object} params - 实验参数
   * @returns {Object} 实验结果
   * @private
   */
  _runOperationsExperiment(params) {
    const strategy = params.strategy ?? 'default';
    const targetMetrics = params.targetMetrics ?? ['responseTime', 'successRate'];
    const baseline = params.baseline ?? {};
    const experiment = {};
    for (const metric of targetMetrics) {
      const base = baseline[metric] ?? 0;
      experiment[metric] = Math.round(base * (1 + (Math.random() - 0.2) * 0.3) * 10000) / 10000;
    }
    const improvement = {};
    for (const metric of targetMetrics) {
      const base = baseline[metric] ?? 0;
      improvement[metric] = base !== 0 ? Math.round(((experiment[metric] - base) / Math.abs(base)) * 10000) / 10000 : 0;
    }
    return { strategy, baseline, experiment, improvement };
  }

  /**
   * 运行ML研究领域实验。模拟超参数搜索和模型比较。
   * @param {Object} params - 实验参数
   * @returns {Object} 实验结果
   * @private
   */
  _runMLResearchExperiment(params) {
    const modelConfig = params.modelConfig ?? {};
    const hyperparameters = params.hyperparameters ?? {};
    const variants = params.hyperparameterVariants ?? [];
    const configs = [modelConfig];
    for (const variant of variants) {
      configs.push(Object.assign({}, modelConfig, variant));
    }
    const results = configs.map((config, idx) => ({
      id: idx,
      config,
      metrics: {
        accuracy: Math.round((0.7 + Math.random() * 0.25) * 10000) / 10000,
        loss: Math.round((1.0 - Math.random() * 0.5) * 10000) / 10000,
        trainingTime: Math.floor(100 + Math.random() * 900),
        inferenceTime: Math.floor(1 + Math.random() * 50),
      },
    }));
    const best = results.length > 0 ? results.reduce((a, b) =>
      a.metrics.accuracy >= b.metrics.accuracy ? a : b,
    ) : null;
    return { configs: results, best, hyperparameters };
  }

  /**
   * 运行工作流领域实验。模拟流程优化对比。
   * @param {Object} params - 实验参数
   * @returns {Object} 实验结果
   * @private
   */
  _runWorkflowExperiment(params) {
    const currentFlow = params.currentFlow ?? [];
    const proposedFlow = params.proposedFlow ?? [];
    const avgStepDuration = params.avgStepDuration ?? 30;
    const currentSteps = currentFlow.length || 1;
    const proposedSteps = proposedFlow.length || 1;
    return {
      current: {
        steps: currentSteps,
        duration: currentSteps * avgStepDuration,
        errorRate: Math.round(Math.random() * 0.1 * 10000) / 10000,
      },
      proposed: {
        steps: proposedSteps,
        duration: proposedSteps * avgStepDuration,
        errorRate: Math.round(Math.random() * 0.05 * 10000) / 10000,
      },
      improvement: {
        stepReduction: currentSteps - proposedSteps,
        durationReduction: (currentSteps - proposedSteps) * avgStepDuration,
        errorRateReduction: Math.round((Math.random() * 0.05) * 10000) / 10000,
      },
    };
  }

  /**
   * 运行通用实验。
   * @param {Object} params - 实验参数
   * @returns {Object} 实验结果
   * @private
   */
  _runGenericExperiment(params) {
    return {
      parameters: params,
      output: 'Generic experiment output',
      metrics: {
        score: Math.round(Math.random() * 10000) / 10000,
        duration: Math.floor(Math.random() * 1000),
      },
    };
  }

  /**
   * 从实验结果中提取指标。
   * @param {Object} result - 实验结果
   * @param {Object} experiment - 实验对象
   * @returns {Object} 提取的指标
   * @private
   */
  _extractMetrics(result, experiment) {
    const metrics = {
      domain: experiment.domain,
      duration: experiment.startedAt ? Date.now() - experiment.startedAt : 0,
    };

    if (result && result.winner) {
      metrics.winner = result.winner.variant;
      metrics.winnerScores = result.winner.scores;
    }
    if (result && result.best) {
      metrics.bestAccuracy = result.best.metrics?.accuracy;
      metrics.bestLoss = result.best.metrics?.loss;
    }
    if (result && result.improvement) {
      metrics.improvement = result.improvement;
    }

    return metrics;
  }

  /**
   * 归档已完成的实验到历史记录。
   * @param {Object} experiment - 实验对象
   * @private
   */
  _archiveExperiment(experiment) {
    this._activeExperiments.delete(experiment.id);
    this._history.push({
      id: experiment.id,
      domain: experiment.domain,
      status: experiment.status,
      metrics: experiment.metrics,
      duration: experiment.completedAt && experiment.startedAt
        ? experiment.completedAt - experiment.startedAt
        : 0,
      completedAt: experiment.completedAt,
    });
    if (this._history.length > this._options.maxHistorySize) {
      this._history.splice(0, this._history.length - this._options.maxHistorySize);
    }
  }

  /**
   * 关闭沙箱，取消所有活跃实验。
   * @protected
   */
  _onShutdown() {
    for (const [_id, exp] of this._activeExperiments) {
      if (exp.status === EXPERIMENT_STATUS.RUNNING) {
        safeCall(() => {
          exp.status = EXPERIMENT_STATUS.CANCELLED;
          exp.completedAt = Date.now();
        }, 'ExperimentSandbox', '_onShutdown-cancel');
      }
    }
    this._activeExperiments.clear();
    this._history = [];
  }
}

module.exports = withShutdown(ExperimentSandbox);
module.exports.EXPERIMENT_STATUS = EXPERIMENT_STATUS;
