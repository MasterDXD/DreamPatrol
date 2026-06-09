'use strict';

const { mergeConfig, validateConfigSchema } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');

const INFERENCE_MODES = {
  XHIGH: 'xhigh',
  FAST: 'fast',
};

const MODE_CHARACTERISTICS = {
  xhigh: {
    maxLatencyMs: 30000,
    preferredTier: 'premium',
    skillLoadingLevel: 'L3',
    tokenBudgetMultiplier: 1.5,
    outputQuality: 'production',
    description: 'High precision mode for complex algorithms and core business logic',
  },
  fast: {
    maxLatencyMs: 200,
    preferredTier: 'economy',
    skillLoadingLevel: 'L1',
    tokenBudgetMultiplier: 0.7,
    outputQuality: 'draft',
    description: 'Ultra-low latency mode for real-time development scenarios',
  },
};

const DEFAULT_OPTIONS = {
  defaultMode: INFERENCE_MODES.FAST,
  complexityThresholdXhigh: 0.7,
  complexityThresholdFast: 0.3,
  maxModeSwitchesPerSession: 10,
  modeHistorySize: 100,
};

const OPTIONS_SCHEMA = {
  defaultMode: { type: 'string', enum: ['xhigh', 'fast'] },
  complexityThresholdXhigh: { type: 'number', min: 0, max: 1 },
  complexityThresholdFast: { type: 'number', min: 0, max: 1 },
  maxModeSwitchesPerSession: { type: 'number', min: 1, max: 100 },
  modeHistorySize: { type: 'number', min: 1, max: 10000 },
};

class InferenceModeManager {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    const validation = validateConfigSchema(this._options, OPTIONS_SCHEMA, 'InferenceModeManager');
    this._options = validation.config;
    this._currentMode = this._options.defaultMode;
    this._modeHistory = [];
    this._switchCount = 0;
    this._modelSelector = null;
    this._skillReducer = null;
    this._stats = {
      xhighActivations: 0,
      fastActivations: 0,
      autoSwitches: 0,
      manualSwitches: 0,
    };
  }

  attachModelSelector(modelSelector) {
    this._modelSelector = modelSelector;
  }

  attachSkillReducer(skillReducer) {
    this._skillReducer = skillReducer;
  }

  selectModeForTask(taskComplexity, options) {
    const opts = options ?? {};
    if (opts.forceMode) {
      return this.setMode(opts.forceMode, 'manual');
    }
    let mode;
    if (taskComplexity >= this._options.complexityThresholdXhigh) {
      mode = INFERENCE_MODES.XHIGH;
    } else if (taskComplexity <= this._options.complexityThresholdFast) {
      mode = INFERENCE_MODES.FAST;
    } else {
      mode = this._currentMode;
    }
    return this.setMode(mode, 'auto');
  }

  setMode(mode, reason) {
    if (mode !== INFERENCE_MODES.XHIGH && mode !== INFERENCE_MODES.FAST) {
      return this._currentMode;
    }
    if (mode === this._currentMode) return this._currentMode;
    if (this._switchCount >= this._options.maxModeSwitchesPerSession) {
      return this._currentMode;
    }
    const previousMode = this._currentMode;
    this._currentMode = mode;
    this._switchCount++;
    this._modeHistory.push({
      from: previousMode,
      to: mode,
      reason: reason ?? 'unknown',
      timestamp: Date.now(),
    });
    if (this._modeHistory.length > this._options.modeHistorySize) {
      this._modeHistory.shift();
    }
    if (mode === INFERENCE_MODES.XHIGH) {
      this._stats.xhighActivations++;
    } else {
      this._stats.fastActivations++;
    }
    if (reason === 'auto') {
      this._stats.autoSwitches++;
    } else {
      this._stats.manualSwitches++;
    }
    this._applyModeConfiguration(mode);
    return mode;
  }

  getCurrentMode() {
    return this._currentMode;
  }

  getModeCharacteristics(mode) {
    return MODE_CHARACTERISTICS[mode ?? this._currentMode] ?? MODE_CHARACTERISTICS.fast;
  }

  getModeHistory() {
    return this._modeHistory.slice();
  }

  _applyModeConfiguration(mode) {
    const characteristics = MODE_CHARACTERISTICS[mode];
    if (!characteristics) return;
    if (this._skillReducer && this._skillReducer.setActiveLevel) {
      safeExecute(() => {
        this._skillReducer.setActiveLevel(characteristics.skillLoadingLevel);
      });
    }
    if (this._modelSelector && this._modelSelector.setPreferredTier) {
      safeExecute(() => {
        this._modelSelector.setPreferredTier(characteristics.preferredTier);
      });
    }
  }

  getStats() {
    return {
      currentMode: this._currentMode,
      switchCount: this._switchCount,
      xhighActivations: this._stats.xhighActivations,
      fastActivations: this._stats.fastActivations,
      autoSwitches: this._stats.autoSwitches,
      manualSwitches: this._stats.manualSwitches,
    };
  }

  _onShutdown() {
    this._modeHistory = [];
  }
}

module.exports = withShutdown(InferenceModeManager);
module.exports.INFERENCE_MODES = INFERENCE_MODES;
module.exports.MODE_CHARACTERISTICS = MODE_CHARACTERISTICS;
