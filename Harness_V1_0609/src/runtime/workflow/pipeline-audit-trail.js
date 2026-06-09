'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');

const STEP_STATUSES = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  ROLLED_BACK: 'rolled-back',
};

const DEFAULT_OPTIONS = {
  maxTrails: 50,
  maxStepsPerTrail: 100,
  maxHistorySize: 500,
  captureInputs: true,
  captureOutputs: true,
  maxCaptureSize: 10000,
  autoPersist: false,
  persistPath: null,
};

class PipelineAuditTrail {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._activeTrails = new BoundedMap(this._options.maxTrails);
    this._completedTrails = new BoundedArray(this._options.maxHistorySize);
    this._stats = {
      trailsCreated: 0,
      trailsCompleted: 0,
      stepsRecorded: 0,
      stepsFailed: 0,
      stepsSkipped: 0,
      rollbacks: 0,
    };
  }

  createTrail(pipelineName, metadata) {
    const trailId = 'trail-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const trail = {
      id: trailId,
      pipelineName: pipelineName ?? 'unnamed',
      metadata: metadata ?? {},
      steps: [],
      startedAt: Date.now(),
      completedAt: null,
      status: 'running',
    };
    this._activeTrails.set(trailId, trail);
    this._stats.trailsCreated++;
    return trailId;
  }

  recordStep(trailId, stepInfo) {
    const trail = this._activeTrails.get(trailId);
    if (!trail) return null;
    if (trail.steps.length >= this._options.maxStepsPerTrail) return null;
    const step = {
      id: stepInfo.id ?? ('step-' + trail.steps.length),
      name: stepInfo.name ?? 'unnamed-step',
      status: stepInfo.status ?? STEP_STATUSES.COMPLETED,
      startedAt: stepInfo.startedAt ?? Date.now(),
      completedAt: stepInfo.completedAt ?? Date.now(),
      durationMs: stepInfo.durationMs ?? (stepInfo.completedAt ? stepInfo.completedAt - (stepInfo.startedAt ?? Date.now()) : 0),
      decision: stepInfo.decision ?? null,
      error: stepInfo.error ?? null,
    };
    if (this._options.captureInputs && stepInfo.input != null) {
      step.input = this._truncateCapture(stepInfo.input);
    }
    if (this._options.captureOutputs && stepInfo.output != null) {
      step.output = this._truncateCapture(stepInfo.output);
    }
    trail.steps.push(step);
    this._stats.stepsRecorded++;
    if (step.status === STEP_STATUSES.FAILED) this._stats.stepsFailed++;
    if (step.status === STEP_STATUSES.SKIPPED) this._stats.stepsSkipped++;
    return step.id;
  }

  completeTrail(trailId, finalStatus) {
    const trail = this._activeTrails.get(trailId);
    if (!trail) return null;
    trail.completedAt = Date.now();
    trail.status = finalStatus ?? (trail.steps.some(s => s.status === STEP_STATUSES.FAILED) ? 'failed' : 'completed');
    trail.totalDurationMs = trail.completedAt - trail.startedAt;
    const summary = this._generateSummary(trail);
    this._activeTrails.delete(trailId);
    this._completedTrails.push(summary);
    this._stats.trailsCompleted++;
    return summary;
  }

  rollbackTrail(trailId, fromStepIndex) {
    const trail = this._activeTrails.get(trailId);
    if (!trail) return null;
    const rollbackIndex = fromStepIndex ?? trail.steps.length - 1;
    const rolledBackSteps = [];
    for (let i = trail.steps.length - 1; i >= rollbackIndex; i--) {
      if (trail.steps[i]) {
        trail.steps[i].status = STEP_STATUSES.ROLLED_BACK;
        rolledBackSteps.push(trail.steps[i].id);
      }
    }
    this._stats.rollbacks++;
    return { trailId, rolledBackSteps, rollbackIndex };
  }

  getTrail(trailId) {
    return this._activeTrails.get(trailId) ?? null;
  }

  getCompletedTrails(pipelineName) {
    const results = [];
    for (const trail of this._completedTrails) {
      if (!pipelineName || trail.pipelineName === pipelineName) {
        results.push(trail);
      }
    }
    return results;
  }

  getStepTimeline(trailId) {
    const trail = this._activeTrails.get(trailId);
    if (!trail) return [];
    return trail.steps.map(step => ({
      id: step.id,
      name: step.name,
      status: step.status,
      startedAt: step.startedAt,
      durationMs: step.durationMs,
      decision: step.decision,
    }));
  }

  exportMermaid(trailId) {
    const trail = this._activeTrails.get(trailId);
    if (!trail) return '';
    let mermaid = 'graph LR\n';
    for (let i = 0; i < trail.steps.length; i++) {
      const step = trail.steps[i];
      const shape = step.status === STEP_STATUSES.FAILED ? '[/' + step.name + '/]'
        : step.status === STEP_STATUSES.SKIPPED ? '(' + step.name + ')'
        : '[' + step.name + ']';
      mermaid += '  S' + i + shape + '\n';
      if (i > 0) {
        const label = step.decision ? '|decision: ' + step.decision + '|' : '';
        mermaid += '  S' + (i - 1) + ' -->' + label + ' S' + i + '\n';
      }
    }
    return mermaid;
  }

  _generateSummary(trail) {
    const stepSummary = trail.steps.map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      durationMs: s.durationMs,
      decision: s.decision,
    }));
    return {
      id: trail.id,
      pipelineName: trail.pipelineName,
      status: trail.status,
      startedAt: trail.startedAt,
      completedAt: trail.completedAt,
      totalDurationMs: trail.totalDurationMs,
      stepCount: trail.steps.length,
      steps: stepSummary,
      metadata: trail.metadata,
    };
  }

  _truncateCapture(data) {
    if (data == null) return null;
    const serialized = typeof data === 'string' ? data : JSON.stringify(data);
    if (!serialized) return null;
    if (serialized.length <= this._options.maxCaptureSize) return data;
    return serialized.substring(0, this._options.maxCaptureSize) + '...[truncated]';
  }

  getStats() {
    return {
      trailsCreated: this._stats.trailsCreated,
      trailsCompleted: this._stats.trailsCompleted,
      stepsRecorded: this._stats.stepsRecorded,
      stepsFailed: this._stats.stepsFailed,
      stepsSkipped: this._stats.stepsSkipped,
      rollbacks: this._stats.rollbacks,
      activeTrails: this._activeTrails.size,
    };
  }

  _onShutdown() {
    this._activeTrails.shutdown();
    this._completedTrails.shutdown();
  }
}

module.exports = withShutdown(PipelineAuditTrail);
module.exports.STEP_STATUSES = STEP_STATUSES;
