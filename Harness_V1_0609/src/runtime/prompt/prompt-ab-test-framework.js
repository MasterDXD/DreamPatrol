'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');

const EXPERIMENT_STATUSES = {
  DRAFT: 'draft',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const METRIC_TYPES = {
  SUCCESS_RATE: 'success-rate',
  QUALITY_SCORE: 'quality-score',
  LATENCY: 'latency',
  TOKEN_USAGE: 'token-usage',
  CUSTOM: 'custom',
};

const DEFAULT_OPTIONS = {
  maxExperiments: 50,
  maxResultsPerVariant: 1000,
  minSampleSize: 30,
  confidenceLevel: 0.95,
  maxDurationMs: 86400000,
  trafficSplit: 0.5,
  maxHistorySize: 200,
};

class PromptABTestFramework {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._experiments = new BoundedMap(this._options.maxExperiments);
    this._results = new BoundedMap(this._options.maxExperiments);
    this._history = new BoundedArray(this._options.maxHistorySize);
    this._stats = {
      experimentsCreated: 0,
      experimentsCompleted: 0,
      variantsTested: 0,
      significantResults: 0,
      byMetricType: {},
    };
  }

  createExperiment(config) {
    this.guardShutdown();
    if (!config || !config.name || !config.controlPrompt || !config.variantPrompt) {
      return { success: false, error: 'Missing required fields: name, controlPrompt, variantPrompt' };
    }
    const experimentId = 'exp-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const metric = config.metric ?? METRIC_TYPES.SUCCESS_RATE;
    const experiment = {
      id: experimentId,
      name: config.name,
      status: EXPERIMENT_STATUSES.DRAFT,
      controlPrompt: config.controlPrompt,
      variantPrompt: config.variantPrompt,
      metric,
      higherIsBetter: config.higherIsBetter !== false,
      trafficSplit: config.trafficSplit ?? this._options.trafficSplit,
      minSampleSize: config.minSampleSize ?? this._options.minSampleSize,
      confidenceLevel: config.confidenceLevel ?? this._options.confidenceLevel,
      maxDurationMs: config.maxDurationMs ?? this._options.maxDurationMs,
      metadata: config.metadata ?? {},
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };
    this._experiments.set(experimentId, experiment);
    this._results.set(experimentId, {
      control: new BoundedArray(this._options.maxResultsPerVariant),
      variant: new BoundedArray(this._options.maxResultsPerVariant),
    });
    this._stats.experimentsCreated++;
    this._stats.byMetricType[metric] = (this._stats.byMetricType[metric] ?? 0) + 1;
    return { success: true, experimentId };
  }

  startExperiment(experimentId) {
    this.guardShutdown();
    const experiment = this._experiments.get(experimentId);
    if (!experiment) return { success: false, error: 'Experiment not found' };
    if (experiment.status !== EXPERIMENT_STATUSES.DRAFT && experiment.status !== EXPERIMENT_STATUSES.PAUSED) {
      return { success: false, error: 'Experiment cannot be started from status: ' + experiment.status };
    }
    experiment.status = EXPERIMENT_STATUSES.RUNNING;
    experiment.startedAt = experiment.startedAt ?? Date.now();
    return { success: true };
  }

  assignVariant(experimentId) {
    this.guardShutdown();
    const experiment = this._experiments.get(experimentId);
    if (!experiment || experiment.status !== EXPERIMENT_STATUSES.RUNNING) return null;
    const results = this._results.get(experimentId);
    if (!results) return null;
    const controlCount = results.control.length;
    const variantCount = results.variant.length;
    const total = controlCount + variantCount;
    if (total === 0) {
      return Math.random() < experiment.trafficSplit ? 'variant' : 'control';
    }
    const currentSplit = variantCount / total;
    if (currentSplit < experiment.trafficSplit) return 'variant';
    if (controlCount / total < (1 - experiment.trafficSplit)) return 'control';
    return Math.random() < experiment.trafficSplit ? 'variant' : 'control';
  }

  recordResult(experimentId, variant, value) {
    this.guardShutdown();
    const experiment = this._experiments.get(experimentId);
    if (!experiment || experiment.status !== EXPERIMENT_STATUSES.RUNNING) return false;
    const results = this._results.get(experimentId);
    if (!results) return false;
    if (variant !== 'control' && variant !== 'variant') return false;
    results[variant].push({
      value: typeof value === 'number' ? value : 0,
      timestamp: Date.now(),
    });
    this._checkCompletion(experimentId);
    return true;
  }

  _checkCompletion(experimentId) {
    const experiment = this._experiments.get(experimentId);
    const results = this._results.get(experimentId);
    if (!experiment || !results) return;
    const controlCount = results.control.length;
    const variantCount = results.variant.length;
    const minSample = experiment.minSampleSize;
    if (controlCount >= minSample && variantCount >= minSample) {
      const analysis = this.analyzeExperiment(experimentId);
      if (analysis && analysis.isSignificant) {
        this.completeExperiment(experimentId, analysis.winner);
      }
    }
    if (experiment.startedAt && Date.now() - experiment.startedAt > experiment.maxDurationMs) {
      this.completeExperiment(experimentId, null);
    }
  }

  analyzeExperiment(experimentId) {
    this.guardShutdown();
    const experiment = this._experiments.get(experimentId);
    const results = this._results.get(experimentId);
    if (!experiment || !results) return null;
    const controlValues = results.control.map(r => r.value);
    const variantValues = results.variant.map(r => r.value);
    if (controlValues.length < 2 || variantValues.length < 2) return null;
    const controlMean = controlValues.reduce((a, b) => a + b, 0) / controlValues.length;
    const variantMean = variantValues.reduce((a, b) => a + b, 0) / variantValues.length;
    const controlVariance = controlValues.reduce((sum, v) => sum + Math.pow(v - controlMean, 2), 0) / (controlValues.length - 1);
    const variantVariance = variantValues.reduce((sum, v) => sum + Math.pow(v - variantMean, 2), 0) / (variantValues.length - 1);
    const pooledSE = Math.sqrt(controlVariance / controlValues.length + variantVariance / variantValues.length);
    const zScore = pooledSE > 0 ? (variantMean - controlMean) / pooledSE : 0;
    const zThresholds = { 0.9: 1.645, 0.95: 1.96, 0.99: 2.576 };
    const threshold = zThresholds[experiment.confidenceLevel] ?? 1.96;
    const isSignificant = Math.abs(zScore) > threshold;
    let winner = null;
    if (isSignificant) {
      if (experiment.higherIsBetter) {
        winner = variantMean > controlMean ? 'variant' : 'control';
      } else {
        winner = variantMean < controlMean ? 'variant' : 'control';
      }
      this._stats.significantResults++;
    }
    const IMPROVEMENT_EPSILON = 1e-10;
    const improvement = Math.abs(controlMean) > IMPROVEMENT_EPSILON ? ((variantMean - controlMean) / Math.abs(controlMean)) * 100 : 0;
    return {
      experimentId,
      controlMean: Math.round(controlMean * 10000) / 10000,
      variantMean: Math.round(variantMean * 10000) / 10000,
      improvement: Math.round(improvement * 100) / 100,
      zScore: Math.round(zScore * 10000) / 10000,
      isSignificant,
      confidenceLevel: experiment.confidenceLevel,
      winner,
      controlSampleSize: controlValues.length,
      variantSampleSize: variantValues.length,
    };
  }

  completeExperiment(experimentId, winner) {
    this.guardShutdown();
    const experiment = this._experiments.get(experimentId);
    if (!experiment) return null;
    experiment.status = EXPERIMENT_STATUSES.COMPLETED;
    experiment.completedAt = Date.now();
    const analysis = this.analyzeExperiment(experimentId);
    const result = {
      experimentId,
      name: experiment.name,
      winner,
      analysis,
      durationMs: experiment.completedAt - (experiment.startedAt ?? experiment.createdAt),
    };
    this._stats.experimentsCompleted++;
    this._history.push(result);
    return result;
  }

  getExperiment(experimentId) {
    return this._experiments.get(experimentId) ?? null;
  }

  listExperiments(status) {
    const results = [];
    for (const [, exp] of this._experiments) {
      if (!status || exp.status === status) {
        results.push({ id: exp.id, name: exp.name, status: exp.status, metric: exp.metric });
      }
    }
    return results;
  }

  getStats() {
    return {
      experimentsCreated: this._stats.experimentsCreated,
      experimentsCompleted: this._stats.experimentsCompleted,
      variantsTested: this._stats.variantsTested,
      significantResults: this._stats.significantResults,
      byMetricType: Object.assign({}, this._stats.byMetricType),
      activeExperiments: this._experiments.size,
    };
  }

  _onShutdown() {
    this._experiments.shutdown();
    this._results.shutdown();
    this._history.shutdown();
  }
}

module.exports = withShutdown(PromptABTestFramework);
module.exports.EXPERIMENT_STATUSES = EXPERIMENT_STATUSES;
module.exports.METRIC_TYPES = METRIC_TYPES;
