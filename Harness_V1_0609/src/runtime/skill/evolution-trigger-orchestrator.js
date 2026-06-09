'use strict';

const { mergeConfig, validateConfigSchema } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');

const TRIGGER_TYPES = {
  POST_TASK: 'post-task',
  QUALITY_DEGRADATION: 'quality-degradation',
  METRIC_MONITOR: 'metric-monitor',
};

const TRIGGER_SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

const EVOLUTION_DECISION = {
  EVOLVE: 'evolve',
  SKIP: 'skip',
  DEFER: 'defer',
  RETIRE: 'retire',
};

const DEFAULT_OPTIONS = {
  maxTriggerHistory: 1000,
  maxActiveTriggers: 100,
  cooldownMs: 300000,
  postTaskEnabled: true,
  qualityDegradationEnabled: true,
  metricMonitorEnabled: true,
  qualityDropThreshold: 0.2,
  healthScoreThreshold: 0.4,
  maxConcurrentEvolutions: 3,
  evolutionBudgetTokens: 20000,
};

const OPTIONS_SCHEMA = {
  maxTriggerHistory: { type: 'number', min: 1, max: 10000 },
  maxActiveTriggers: { type: 'number', min: 1, max: 1000 },
  cooldownMs: { type: 'number', min: 0 },
  postTaskEnabled: { type: 'boolean' },
  qualityDegradationEnabled: { type: 'boolean' },
  metricMonitorEnabled: { type: 'boolean' },
  qualityDropThreshold: { type: 'number', min: 0, max: 1 },
  healthScoreThreshold: { type: 'number', min: 0, max: 1 },
  maxConcurrentEvolutions: { type: 'number', min: 1, max: 20 },
  evolutionBudgetTokens: { type: 'number', min: 0 },
};

const MAX_COOLDOWN_TIMERS = 100;

class EvolutionTriggerOrchestrator {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    const validation = validateConfigSchema(this._options, OPTIONS_SCHEMA, 'EvolutionTriggerOrchestrator');
    this._options = validation.config;
    this._skillEvolver = null;
    this._skillImprovementLoop = null;
    this._skillObservability = null;
    this._skillRetirementManager = null;
    this._activeTriggers = new BoundedMap(this._options.maxActiveTriggers);
    this._triggerHistory = new BoundedArray(this._options.maxTriggerHistory);
    this._cooldowns = new BoundedMap(200);
    this._cooldownTimers = [];
    this._stats = {
      triggersReceived: 0,
      triggersProcessed: 0,
      evolutionsTriggered: 0,
      evolutionsSkipped: 0,
      evolutionsDeferred: 0,
      retirementsTriggered: 0,
      byType: {},
      byDecision: {},
    };
  }

  attachSkillEvolver(skillEvolver) {
    this._skillEvolver = skillEvolver;
  }

  attachSkillImprovementLoop(loop) {
    this._skillImprovementLoop = loop;
  }

  attachSkillObservability(observability) {
    this._skillObservability = observability;
  }

  attachSkillRetirementManager(manager) {
    this._skillRetirementManager = manager;
  }

  onTaskCompleted(taskResult) {
    if (this._shutDown) return null;
    if (!this._options.postTaskEnabled) return null;
    const trigger = this._createTrigger(TRIGGER_TYPES.POST_TASK, {
      skillId: taskResult?.skillId,
      success: taskResult?.success ?? false,
      error: taskResult?.error ?? null,
      duration: taskResult?.duration ?? 0,
      tokensUsed: taskResult?.tokensUsed ?? 0,
    });
    return this._processTrigger(trigger);
  }

  onQualityDegradation(qualitySignal) {
    if (!this._options.qualityDegradationEnabled) return null;
    const drop = qualitySignal?.drop ?? 0;
    if (Math.abs(drop) < this._options.qualityDropThreshold) return null;
    const trigger = this._createTrigger(TRIGGER_TYPES.QUALITY_DEGRADATION, {
      skillId: qualitySignal?.skillId,
      previousSuccessRate: qualitySignal?.previousSuccessRate ?? 0,
      currentSuccessRate: qualitySignal?.currentSuccessRate ?? 0,
      drop: drop,
      severity: this._classifySeverity(Math.abs(drop)),
    });
    return this._processTrigger(trigger);
  }

  onMetricAlert(metricSignal) {
    if (this._shutDown) return null;
    if (!this._options.metricMonitorEnabled) return null;
    const healthScore = metricSignal?.healthScore ?? 1;
    if (healthScore >= this._options.healthScoreThreshold) return null;
    const trigger = this._createTrigger(TRIGGER_TYPES.METRIC_MONITOR, {
      skillId: metricSignal?.skillId,
      healthScore: healthScore,
      compositeScore: metricSignal?.compositeScore ?? healthScore,
      failingMetrics: metricSignal?.failingMetrics ?? [],
      severity: this._classifySeverity(1 - healthScore),
    });
    return this._processTrigger(trigger);
  }

  _createTrigger(type, data) {
    this._stats.triggersReceived++;
    this._stats.byType[type] = (this._stats.byType[type] ?? 0) + 1;
    return {
      id: 'trigger-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8),
      type: type,
      data: data,
      skillId: data?.skillId ?? 'unknown',
      severity: data?.severity ?? TRIGGER_SEVERITY.MEDIUM,
      createdAt: Date.now(),
      processedAt: null,
      decision: null,
    };
  }

  _processTrigger(trigger) {
    if (this._isInCooldown(trigger.skillId, trigger.type)) {
      this._stats.evolutionsSkipped++;
      trigger.decision = EVOLUTION_DECISION.SKIP;
      trigger.processedAt = Date.now();
      return trigger;
    }
    const decision = this._evaluateEvolutionDecision(trigger);
    trigger.decision = decision;
    trigger.processedAt = Date.now();
    this._stats.triggersProcessed++;
    this._stats.byDecision[decision] = (this._stats.byDecision[decision] ?? 0) + 1;
    this._triggerHistory.push({
      id: trigger.id,
      type: trigger.type,
      skillId: trigger.skillId,
      severity: trigger.severity,
      decision: decision,
      createdAt: trigger.createdAt,
    });
    switch (decision) {
      case EVOLUTION_DECISION.EVOLVE:
        this._executeEvolution(trigger);
        break;
      case EVOLUTION_DECISION.RETIRE:
        this._executeRetirement(trigger);
        break;
      case EVOLUTION_DECISION.DEFER:
        this._stats.evolutionsDeferred++;
        break;
      default:
        this._stats.evolutionsSkipped++;
    }
    this._setCooldown(trigger.skillId, trigger.type);
    return trigger;
  }

  _evaluateEvolutionDecision(trigger) {
    if (trigger.severity === TRIGGER_SEVERITY.CRITICAL) {
      if (trigger.type === TRIGGER_TYPES.QUALITY_DEGRADATION) {
        const currentRate = trigger.data?.currentSuccessRate ?? 0;
        if (currentRate < 0.1) return EVOLUTION_DECISION.RETIRE;
      }
      return EVOLUTION_DECISION.EVOLVE;
    }
    if (trigger.severity === TRIGGER_SEVERITY.HIGH) {
      return EVOLUTION_DECISION.EVOLVE;
    }
    if (trigger.severity === TRIGGER_SEVERITY.MEDIUM) {
      if (this._activeTriggers.size >= this._options.maxConcurrentEvolutions) {
        return EVOLUTION_DECISION.DEFER;
      }
      return EVOLUTION_DECISION.EVOLVE;
    }
    return EVOLUTION_DECISION.SKIP;
  }

  _executeEvolution(trigger) {
    this._stats.evolutionsTriggered++;
    this._activeTriggers.set(trigger.id, trigger);
    const skillId = trigger.skillId;
    if (this._skillImprovementLoop && this._skillImprovementLoop.recordLearning) {
      safeCall(() => {
        this._skillImprovementLoop.recordLearning({
          skillId: skillId,
          whatFailed: trigger.data?.error ?? 'Quality degradation detected',
          context: trigger.data,
          triggerType: trigger.type,
        });
      }, 'EvolutionTriggerOrchestrator', 'recordLearning');
    }
    if (this._skillEvolver && this._skillEvolver.evolve) {
      safeCall(() => {
        this._skillEvolver.evolve(skillId, {
          triggerType: trigger.type,
          triggerData: trigger.data,
          budget: this._options.evolutionBudgetTokens,
        });
      }, 'EvolutionTriggerOrchestrator', 'evolve');
    }
    const timerId = setTimeout(() => {
      if (this._shutDown) return;
      this._activeTriggers.delete(trigger.id);
      const idx = this._cooldownTimers.indexOf(timerId);
      if (idx !== -1) this._cooldownTimers.splice(idx, 1);
    }, this._options.cooldownMs);
    if (this._cooldownTimers.length >= MAX_COOLDOWN_TIMERS) this._cooldownTimers.shift();
    this._cooldownTimers.push(timerId);
  }

  _executeRetirement(trigger) {
    this._stats.retirementsTriggered++;
    if (this._skillRetirementManager && this._skillRetirementManager.retireSkill) {
      safeCall(() => {
        this._skillRetirementManager.retireSkill(trigger.skillId, {
          reason: 'quality-critical',
          triggerType: trigger.type,
          data: trigger.data,
        });
      }, 'EvolutionTriggerOrchestrator', 'retireSkill');
    }
  }

  _classifySeverity(score) {
    if (score >= 0.8) return TRIGGER_SEVERITY.CRITICAL;
    if (score >= 0.5) return TRIGGER_SEVERITY.HIGH;
    if (score >= 0.3) return TRIGGER_SEVERITY.MEDIUM;
    return TRIGGER_SEVERITY.LOW;
  }

  _isInCooldown(skillId, type) {
    const key = skillId + ':' + type;
    const cooldownEnd = this._cooldowns.get(key);
    if (!cooldownEnd) return false;
    if (Date.now() >= cooldownEnd) {
      this._cooldowns.delete(key);
      return false;
    }
    return true;
  }

  _setCooldown(skillId, type) {
    const key = skillId + ':' + type;
    this._cooldowns.set(key, Date.now() + this._options.cooldownMs);
  }

  getStats() {
    return {
      triggersReceived: this._stats.triggersReceived,
      triggersProcessed: this._stats.triggersProcessed,
      evolutionsTriggered: this._stats.evolutionsTriggered,
      evolutionsSkipped: this._stats.evolutionsSkipped,
      evolutionsDeferred: this._stats.evolutionsDeferred,
      retirementsTriggered: this._stats.retirementsTriggered,
      byType: Object.assign({}, this._stats.byType),
      byDecision: Object.assign({}, this._stats.byDecision),
      activeTriggers: this._activeTriggers.size,
      cooldownEntries: this._cooldowns.size,
    };
  }

  _onShutdown() {
    for (const timerId of this._cooldownTimers) {
      clearTimeout(timerId);
    }
    this._cooldownTimers = [];
    this._activeTriggers.shutdown();
    this._triggerHistory.shutdown();
    this._cooldowns.shutdown();
    this.removeAllListeners();
  }
}

module.exports = withShutdown(EvolutionTriggerOrchestrator);
module.exports.TRIGGER_TYPES = TRIGGER_TYPES;
module.exports.TRIGGER_SEVERITY = TRIGGER_SEVERITY;
module.exports.EVOLUTION_DECISION = EVOLUTION_DECISION;
