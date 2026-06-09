'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const EventEmitter = require('events');

const LOOP_PHASES = {
  OBSERVE: 'observe',
  ANALYZE: 'analyze',
  HYPOTHESIZE: 'hypothesize',
  EXPERIMENT: 'experiment',
  EVALUATE: 'evaluate',
  APPLY: 'apply',
};

const OPTIMIZATION_TARGETS = {
  PROMPT: 'prompt',
  SKILL: 'skill',
  WORKFLOW: 'workflow',
  STRATEGY: 'strategy',
};

const DEFAULT_OPTIONS = {
  maxConcurrentLoops: 3,
  maxHistorySize: 100,
  minObservationsBeforeHypothesis: 5,
  maxHypothesesPerCycle: 3,
  autoApplyThreshold: 0.9,
  businessMetrics: {},
};

class AutonomousOptimizationOrchestrator extends EventEmitter {
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._activeLoops = new BoundedMap(this._options.maxConcurrentLoops);
    this._completedLoops = new BoundedArray(this._options.maxHistorySize);
    this._observations = new BoundedMap(500);
    this._hypotheses = new BoundedMap(200);
    this._components = {
      skillImprovementLoop: null,
      dreamEngine: null,
      skillEvolver: null,
      promptABTest: null,
      effectivenessOptimizer: null,
    };
    this._stats = {
      loopsStarted: 0,
      loopsCompleted: 0,
      hypothesesGenerated: 0,
      hypothesesValidated: 0,
      optimizationsApplied: 0,
      byTarget: {},
    };
  }

  attachComponent(name, component) {
    if (this._components.hasOwnProperty(name)) {
      this._components[name] = component;
      return true;
    }
    return false;
  }

  startOptimizationLoop(target, config) {
    if (this._activeLoops.size >= this._options.maxConcurrentLoops) {
      return { success: false, error: 'Max concurrent loops reached' };
    }
    const loopId = 'opt-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const loop = {
      id: loopId,
      target: target ?? OPTIMIZATION_TARGETS.SKILL,
      phase: LOOP_PHASES.OBSERVE,
      config: config ?? {},
      observations: [],
      hypotheses: [],
      experiments: [],
      results: [],
      startedAt: Date.now(),
      completedAt: null,
    };
    this._activeLoops.set(loopId, loop);
    this._stats.loopsStarted++;
    this._stats.byTarget[loop.target] = (this._stats.byTarget[loop.target] ?? 0) + 1;
    this.emit('loop-started', { loopId, target: loop.target });
    return { success: true, loopId };
  }

  observe(loopId, data) {
    const loop = this._activeLoops.get(loopId);
    if (!loop) return null;
    const observation = {
      timestamp: Date.now(),
      metrics: data?.metrics ?? {},
      context: data?.context ?? {},
      outcome: data?.outcome ?? null,
      businessMetrics: data?.businessMetrics ?? this._options.businessMetrics,
    };
    loop.observations.push(observation);
    this._observations.set(loopId + '-' + loop.observations.length, observation);
    if (loop.observations.length >= this._options.minObservationsBeforeHypothesis && loop.phase === LOOP_PHASES.OBSERVE) {
      loop.phase = LOOP_PHASES.ANALYZE;
      this.emit('phase-changed', { loopId, phase: LOOP_PHASES.ANALYZE });
    }
    return observation;
  }

  analyze(loopId) {
    const loop = this._activeLoops.get(loopId);
    if (!loop || loop.phase !== LOOP_PHASES.ANALYZE) return null;
    const patterns = this._extractPatterns(loop.observations);
    const insights = this._generateInsights(patterns, loop.target);
    loop.phase = LOOP_PHASES.HYPOTHESIZE;
    this.emit('phase-changed', { loopId, phase: LOOP_PHASES.HYPOTHESIZE });
    return { patterns, insights };
  }

  hypothesize(loopId, insights) {
    const loop = this._activeLoops.get(loopId);
    if (!loop || loop.phase !== LOOP_PHASES.HYPOTHESIZE) return null;
    const hypotheses = [];
    const inputInsights = insights ?? [];
    for (let i = 0; i < Math.min(inputInsights.length, this._options.maxHypothesesPerCycle); i++) {
      const hypothesis = {
        id: 'hyp-' + Date.now() + '-' + i,
        insight: inputInsights[i],
        prediction: inputInsights[i]?.prediction ?? 'Improved outcome',
        confidence: inputInsights[i]?.confidence ?? 0.5,
        target: loop.target,
        testable: true,
      };
      hypotheses.push(hypothesis);
      this._hypotheses.set(hypothesis.id, hypothesis);
      this._stats.hypothesesGenerated++;
    }
    loop.hypotheses = hypotheses;
    loop.phase = LOOP_PHASES.EXPERIMENT;
    this.emit('phase-changed', { loopId, phase: LOOP_PHASES.EXPERIMENT });
    return hypotheses;
  }

  experiment(loopId) {
    const loop = this._activeLoops.get(loopId);
    if (!loop || loop.phase !== LOOP_PHASES.EXPERIMENT) return null;
    const experiments = [];
    for (const hypothesis of loop.hypotheses) {
      const experiment = {
        hypothesisId: hypothesis.id,
        type: 'ab-test',
        status: 'created',
        createdAt: Date.now(),
      };
      if (this._components.promptABTest && loop.target === OPTIMIZATION_TARGETS.PROMPT) {
        safeExecute(() => {
          const result = this._components.promptABTest.createExperiment({
            name: 'auto-' + hypothesis.id,
            controlPrompt: hypothesis.insight?.currentPrompt ?? '',
            variantPrompt: hypothesis.insight?.optimizedPrompt ?? '',
            metric: 'quality-score',
          });
          if (result?.success) {
            experiment.abTestId = result.experimentId;
            this._components.promptABTest.startExperiment(result.experimentId);
          }
        });
      }
      experiments.push(experiment);
    }
    loop.experiments = experiments;
    loop.phase = LOOP_PHASES.EVALUATE;
    this.emit('phase-changed', { loopId, phase: LOOP_PHASES.EVALUATE });
    return experiments;
  }

  evaluate(loopId) {
    const loop = this._activeLoops.get(loopId);
    if (!loop || loop.phase !== LOOP_PHASES.EVALUATE) return null;
    const evaluationResults = [];
    for (const experiment of loop.experiments) {
      const result = { hypothesisId: experiment.hypothesisId, significant: false, winner: null };
      if (experiment.abTestId && this._components.promptABTest) {
        const analysis = safeExecute(() => this._components.promptABTest.analyzeExperiment(experiment.abTestId));
        if (analysis) {
          result.significant = analysis.isSignificant;
          result.winner = analysis.winner;
          result.improvement = analysis.improvement;
          if (analysis.isSignificant) this._stats.hypothesesValidated++;
        }
      }
      evaluationResults.push(result);
    }
    loop.results = evaluationResults;
    loop.phase = LOOP_PHASES.APPLY;
    this.emit('phase-changed', { loopId, phase: LOOP_PHASES.APPLY });
    return evaluationResults;
  }

  apply(loopId) {
    const loop = this._activeLoops.get(loopId);
    if (!loop || loop.phase !== LOOP_PHASES.APPLY) return null;
    const appliedOptimizations = [];
    for (const result of loop.results) {
      if (result.significant && result.winner === 'variant') {
        const optimization = {
          hypothesisId: result.hypothesisId,
          improvement: result.improvement ?? 0,
          appliedAt: Date.now(),
          autoApplied: (result.improvement ?? 0) > 0 && this._shouldAutoApply(result),
        };
        if (optimization.autoApplied) {
          this._stats.optimizationsApplied++;
          this.emit('optimization-applied', { loopId, optimization });
        }
        appliedOptimizations.push(optimization);
      }
    }
    return appliedOptimizations;
  }

  _shouldAutoApply(result) {
    const confidence = result.significant ? 0.95 : 0;
    return confidence >= this._options.autoApplyThreshold;
  }

  _extractPatterns(observations) {
    if (observations.length === 0) return [];
    const patterns = [];
    const metricKeys = Object.keys(observations[0]?.metrics ?? {});
    for (const key of metricKeys) {
      const values = observations.map(o => o.metrics[key]).filter(v => typeof v === 'number');
      if (values.length < 2) continue;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const trend = values.length >= 3 ? values[values.length - 1] - values[0] : 0;
      patterns.push({ metric: key, mean: Math.round(mean * 10000) / 10000, trend, sampleSize: values.length });
    }
    return patterns;
  }

  _generateInsights(patterns, target) {
    return patterns.filter(p => Math.abs(p.trend) > 0.01).map(p => ({
      metric: p.metric,
      trend: p.trend > 0 ? 'improving' : 'declining',
      confidence: Math.min(1, p.sampleSize / 30),
      prediction: p.trend > 0 ? 'Continue current approach' : 'Consider optimization',
      target,
    }));
  }

  getLoop(loopId) {
    return this._activeLoops.get(loopId) ?? null;
  }

  getStats() {
    return {
      loopsStarted: this._stats.loopsStarted,
      loopsCompleted: this._stats.loopsCompleted,
      hypothesesGenerated: this._stats.hypothesesGenerated,
      hypothesesValidated: this._stats.hypothesesValidated,
      optimizationsApplied: this._stats.optimizationsApplied,
      byTarget: Object.assign({}, this._stats.byTarget),
      activeLoops: this._activeLoops.size,
    };
  }

  _onShutdown() {
    this._activeLoops.shutdown();
    this._completedLoops.shutdown();
    this._observations.shutdown();
    this._hypotheses.shutdown();
  }
}

module.exports = withShutdown(AutonomousOptimizationOrchestrator);
module.exports.LOOP_PHASES = LOOP_PHASES;
module.exports.OPTIMIZATION_TARGETS = OPTIMIZATION_TARGETS;
