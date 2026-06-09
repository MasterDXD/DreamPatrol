'use strict';

const { mergeConfig, validateConfigSchema } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const EventEmitter = require('events');

const REACT_PHASES = {
  THINK: 'think',
  ACT: 'act',
  OBSERVE: 'observe',
};

const REACT_STATES = {
  IDLE: 'idle',
  THINKING: 'thinking',
  ACTING: 'acting',
  OBSERVING: 'observing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const FINISH_KEYWORDS = ['finish', 'final_answer', 'final answer', 'done', 'complete'];

const DEFAULT_OPTIONS = {
  maxIterations: 10,
  maxScratchpadSize: 50,
  maxToolResults: 100,
  thinkFn: null,
  actFn: null,
  observeFn: null,
  tools: null,
  convergenceCheck: null,
  timeoutMs: 300000,
};

/** @constant {Object} OPTIONS_SCHEMA - ReAct Agent配置选项Schema定义 */
const OPTIONS_SCHEMA = {
  maxIterations: { type: 'number', min: 1, max: 100 },
  maxScratchpadSize: { type: 'number', min: 1, max: 10000 },
  maxToolResults: { type: 'number', min: 1, max: 10000 },
  timeoutMs: { type: 'number', min: 1000, max: 3600000 },
};

class ReActAgent extends EventEmitter {
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    const validation = validateConfigSchema(this._options, OPTIONS_SCHEMA, 'ReActAgent');
    if (!validation.valid) {
      debug('ReActAgent', 'config-validation', validation.errors.join('; '));
    }
    if (validation.warnings.length > 0) {
      debug('ReActAgent', 'config-warnings', validation.warnings.join('; '));
    }
    this._options = validation.config;
    this._state = REACT_STATES.IDLE;
    this._iteration = 0;
    this._scratchpad = new BoundedArray(this._options.maxScratchpadSize);
    this._toolResults = new BoundedMap(this._options.maxToolResults);
    this._currentThought = null;
    this._currentAction = null;
    this._currentObservation = null;
    this._finalAnswer = null;
    this._error = null;
    this._startTime = null;
    this._stats = {
      iterations: 0,
      thoughtsGenerated: 0,
      actionsExecuted: 0,
      observationsMade: 0,
      toolsUsed: {},
      byPhase: { think: 0, act: 0, observe: 0 },
    };
  }

  get state() { return this._state; }
  get iteration() { return this._iteration; }
  get finalAnswer() { return this._finalAnswer; }
  get scratchpad() { return this._scratchpad.toArray(); }

  async run(input) {
    if (this._state !== REACT_STATES.IDLE) {
      return { success: false, error: 'Agent is not idle, current state: ' + this._state };
    }
    this._startTime = Date.now();
    this._aborted = false;
    this._state = REACT_STATES.THINKING;
    this._scratchpad.push({ role: 'user', content: input, timestamp: Date.now() });
    this.emit('react-started', { input });
    try {
      while (this._iteration < this._options.maxIterations) {
        this._iteration++;
        this._stats.iterations++;
        const thinkResult = await this._think();
        if (this._aborted) { this._state = REACT_STATES.IDLE; return { success: false, error: 'Agent aborted during think phase' }; }
        if (thinkResult.finished) {
          this._finalAnswer = thinkResult.answer;
          this._state = REACT_STATES.COMPLETED;
          this.emit('react-completed', { answer: this._finalAnswer, iterations: this._iteration });
          return { success: true, answer: this._finalAnswer, iterations: this._iteration };
        }
        const actResult = await this._act(thinkResult);
        if (this._aborted) { this._state = REACT_STATES.IDLE; return { success: false, error: 'Agent aborted during act phase' }; }
        const _observeResult = await this._observe(actResult);
        this._checkTimeout();
      }
      this._state = REACT_STATES.COMPLETED;
      this._finalAnswer = this._currentThought?.answer ?? 'Max iterations reached without final answer';
      this.emit('react-completed', { answer: this._finalAnswer, iterations: this._iteration, maxReached: true });
      return { success: true, answer: this._finalAnswer, iterations: this._iteration, maxReached: true };
    } catch (err) {
      this._state = REACT_STATES.FAILED;
      const errMsg = err && err.message ? err.message : String(err);
      this._error = errMsg;
      this.emit('react-failed', { error: errMsg, iterations: this._iteration });
      return { success: false, error: errMsg, iterations: this._iteration };
    }
  }

  async _think() {
    this._state = REACT_STATES.THINKING;
    this._stats.byPhase.think++;
    this._stats.thoughtsGenerated++;
    const context = this._buildThinkContext();
    let thought;
    if (this._options.thinkFn) {
      thought = await this._options.thinkFn(context);
    } else {
      thought = this._defaultThink(context);
    }
    this._currentThought = thought;
    this._scratchpad.push({ role: 'thought', content: thought.reasoning, action: thought.action, timestamp: Date.now() });
    this.emit('react-think', { iteration: this._iteration, thought });
    if (thought.action && FINISH_KEYWORDS.some(kw => thought.action.toLowerCase().includes(kw))) {
      return { finished: true, answer: thought.actionInput ?? thought.reasoning };
    }
    return { finished: false, action: thought.action, actionInput: thought.actionInput, reasoning: thought.reasoning };
  }

  async _act(thinkResult) {
    this._state = REACT_STATES.ACTING;
    this._stats.byPhase.act++;
    this._stats.actionsExecuted++;
    const action = thinkResult.action;
    const actionInput = thinkResult.actionInput;
    this._currentAction = { action, actionInput };
    this._stats.toolsUsed[action] = (this._stats.toolsUsed[action] ?? 0) + 1;
    let result;
    if (this._options.actFn) {
      result = await this._options.actFn(action, actionInput, this._getScratchpadContext());
    } else {
      result = this._defaultAct(action, actionInput);
    }
    this._scratchpad.push({ role: 'action', action, actionInput, timestamp: Date.now() });
    this.emit('react-act', { iteration: this._iteration, action, actionInput });
    return { action, actionInput, result };
  }

  async _observe(actResult) {
    this._state = REACT_STATES.OBSERVING;
    this._stats.byPhase.observe++;
    this._stats.observationsMade++;
    let observation;
    if (this._options.observeFn) {
      observation = await this._options.observeFn(actResult, this._getScratchpadContext());
    } else {
      observation = this._defaultObserve(actResult);
    }
    this._currentObservation = observation;
    this._toolResults.set(actResult.action + '-' + Date.now(), observation);
    this._scratchpad.push({ role: 'observation', content: observation, action: actResult.action, timestamp: Date.now() });
    this.emit('react-observe', { iteration: this._iteration, observation, action: actResult.action });
    return observation;
  }

  _buildThinkContext() {
    return {
      scratchpad: this._getScratchpadContext(),
      iteration: this._iteration,
      maxIterations: this._options.maxIterations,
      availableTools: this._options.tools ? Object.keys(this._options.tools) : [],
    };
  }

  _getScratchpadContext() {
    return this._scratchpad.toArray().map(function(entry) {
      return Object.assign({}, entry);
    });
  }

  _defaultThink(context) {
    const lastObs = context.scratchpad.filter(function(e) { return e.role === 'observation'; }).pop();
    const reasoning = lastObs ? 'Based on observation: ' + String(lastObs.content).substring(0, 200) : 'Starting reasoning process';
    return {
      reasoning,
      action: null,
      actionInput: null,
    };
  }

  _defaultAct(action, actionInput) {
    const tools = this._options.tools;
    if (tools && tools[action]) {
      return safeExecute(function() { return tools[action](actionInput); });
    }
    return { error: 'Unknown tool: ' + action };
  }

  _defaultObserve(actResult) {
    if (actResult.result && typeof actResult.result === 'object' && actResult.result.error) {
      return 'Error from ' + actResult.action + ': ' + actResult.result.error;
    }
    if (actResult.result && typeof actResult.result === 'object' && actResult.result.output !== undefined) {
      return String(actResult.result.output);
    }
    if (actResult.result !== undefined && actResult.result !== null) {
      return String(actResult.result);
    }
    return 'No output from ' + actResult.action;
  }

  _checkTimeout() {
    if (this._options.timeoutMs && Date.now() - this._startTime > this._options.timeoutMs) {
      throw new Error('ReAct agent timed out after ' + this._options.timeoutMs + 'ms');
    }
  }

  registerTool(name, fn) {
    if (!this._options.tools) this._options.tools = {};
    this._options.tools[name] = fn;
    return { success: true };
  }

  getStats() {
    return {
      state: this._state,
      iterations: this._stats.iterations,
      thoughtsGenerated: this._stats.thoughtsGenerated,
      actionsExecuted: this._stats.actionsExecuted,
      observationsMade: this._stats.observationsMade,
      byPhase: Object.assign({}, this._stats.byPhase),
      toolsUsed: Object.assign({}, this._stats.toolsUsed),
      scratchpadSize: this._scratchpad.length,
      toolResultsCount: this._toolResults.size,
    };
  }

  reset() {
    this._aborted = true;
    this._state = REACT_STATES.IDLE;
    this._iteration = 0;
    this._currentThought = null;
    this._currentAction = null;
    this._currentObservation = null;
    this._finalAnswer = null;
    this._error = null;
    this._startTime = null;
    this._stats = {
      iterations: 0,
      thoughtsGenerated: 0,
      actionsExecuted: 0,
      observationsMade: 0,
      toolsUsed: {},
      byPhase: { think: 0, act: 0, observe: 0 },
    };
    this._scratchpad.clear();
    this._toolResults.clear();
  }

  _onShutdown() {
    this._scratchpad.shutdown();
    this._toolResults.shutdown();
  }
}

module.exports = withShutdown(ReActAgent);
module.exports.REACT_PHASES = REACT_PHASES;
module.exports.REACT_STATES = REACT_STATES;
module.exports.FINISH_KEYWORDS = FINISH_KEYWORDS;
