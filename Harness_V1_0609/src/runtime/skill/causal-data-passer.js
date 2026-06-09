'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_OPTIONS = {
  maxDataStoreSize: 200,
  maxHistorySize: 500,
  maxDataSize: 65536,
  strictValidation: false,
  autoCleanup: true,
  cleanupIntervalMs: 300000,
};

class CausalDataPasser {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._dataStore = new BoundedMap(this._options.maxDataStoreSize);
    this._history = new BoundedArray(this._options.maxHistorySize);
    this._stats = {
      outputsCollected: 0,
      inputsInjected: 0,
      validationsPassed: 0,
      validationsFailed: 0,
      dataTransferred: 0,
    };
  }

  collectOutputs(skillId, result, causalData) {
    if (!skillId || !result) return;
    this._stats.outputsCollected++;
    const outputs = result.causal_outputs ?? result.outputs ?? {};
    const outputEntries = Array.isArray(outputs) ? outputs : this._extractOutputEntries(outputs, result);
    for (const entry of outputEntries) {
      const key = this._makeKey(skillId, entry.name ?? entry);
      const value = entry.value ?? result[entry.name] ?? result;
      const serialized = this._serialize(value);
      if (serialized.length <= this._options.maxDataSize) {
        this._dataStore.set(key, {
          skillId,
          name: entry.name ?? entry,
          value: serialized,
          type: entry.type ?? typeof value,
          collectedAt: Date.now(),
        });
        if (causalData && typeof causalData === 'object') {
          causalData[key] = serialized;
        }
        this._stats.dataTransferred += serialized.length;
      }
    }
    this._history.push({ type: 'collect', skillId, outputCount: outputEntries.length, timestamp: Date.now() });
  }

  injectInputs(skillId, causalData) {
    if (!skillId) return null;
    this._stats.inputsInjected++;
    const injected = {};
    const prefix = skillId + ':';
    if (causalData && typeof causalData === 'object') {
      for (const [key, value] of Object.entries(causalData)) {
        if (key.startsWith(prefix)) {
          const inputName = key.substring(prefix.length);
          injected[inputName] = this._deserialize(value);
        } else {
          const stored = this._dataStore.get(key);
          if (stored) {
            const sourceParts = key.split(':');
            if (sourceParts.length >= 2) {
              injected[sourceParts[1]] = this._deserialize(stored.value);
            }
          }
        }
      }
    }
    this._history.push({ type: 'inject', skillId, inputCount: Object.keys(injected).length, timestamp: Date.now() });
    return Object.keys(injected).length > 0 ? injected : null;
  }

  validateCausalChain(skillChain) {
    if (!Array.isArray(skillChain)) return { valid: true, missing: [] };
    const missing = [];
    const availableOutputs = new Set();
    for (const step of skillChain) {
      const inputs = step.causal_inputs ?? [];
      for (const input of inputs) {
        const sourceSkill = input.source ?? input.from;
        const inputName = input.name ?? input;
        const required = input.required ?? false;
        const key = this._makeKey(sourceSkill, inputName);
        if (!availableOutputs.has(key) && !this._dataStore.has(key)) {
          if (required) {
            missing.push({ skillId: step.skillId, input: inputName, source: sourceSkill, required });
          }
          this._stats.validationsFailed++;
        } else {
          this._stats.validationsPassed++;
        }
      }
      const outputs = step.causal_outputs ?? [];
      for (const output of outputs) {
        const outputName = output.name ?? output;
        availableOutputs.add(this._makeKey(step.skillId, outputName));
      }
    }
    return { valid: missing.length === 0, missing };
  }

  getData(skillId, outputName) {
    const key = this._makeKey(skillId, outputName);
    const entry = this._dataStore.get(key);
    if (!entry) return null;
    return this._deserialize(entry.value);
  }

  clearData(skillId) {
    const keysToRemove = [];
    for (const [key, entry] of this._dataStore) {
      if (entry.skillId === skillId) keysToRemove.push(key);
    }
    for (const key of keysToRemove) {
      this._dataStore.delete(key);
    }
    return keysToRemove.length;
  }

  _makeKey(skillId, name) {
    return (skillId ?? 'unknown') + ':' + (name ?? 'output');
  }

  _extractOutputEntries(outputs, _result) {
    if (typeof outputs !== 'object' || outputs === null) return [];
    return Object.entries(outputs).map(([name, type]) => ({ name, type: typeof type === 'string' ? type : typeof type }));
  }

  _serialize(value) {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch (_) {
      debug('CausalDataPasser', 'serialize', _ && _.message ? _.message : String(_));
      return String(value);
    }
  }

  _deserialize(value) {
    if (typeof value !== 'string') return value;
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
      return value;
    } catch (_) {
      debug('CausalDataPasser', 'deserialize', _ && _.message ? _.message : String(_));
      return value;
    }
  }

  getStats() {
    return {
      outputsCollected: this._stats.outputsCollected,
      inputsInjected: this._stats.inputsInjected,
      validationsPassed: this._stats.validationsPassed,
      validationsFailed: this._stats.validationsFailed,
      dataTransferred: this._stats.dataTransferred,
      storedEntries: this._dataStore.size,
    };
  }

  _onShutdown() {
    this._dataStore.shutdown();
    this._history.shutdown();
  }
}

module.exports = withShutdown(CausalDataPasser);
