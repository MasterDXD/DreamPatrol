'use strict';

const { EventEmitter } = require('events');
const debug = require('../../utils/debug-logger')('SimulationEngine');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeIsoDate } = require('../../utils/safe-execute');
const { uuid } = require('../../utils/unique-id');

const DECAY_FACTOR = 0.85;
const CONVERGENCE_THRESHOLD = 0.05;
const MAX_SIMULATIONS = 100;
const MAX_COUNTERFACTUALS = 50;
const MAX_FORWARD_PREDICTIONS = 50;
const MAX_HEALTHY_TOTAL = 50000;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_BRANCHES = 10;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.3;
const DEFAULT_TIME_HORIZON = 1000;

/**
 * @module runtime/causal/simulation-engine
 * 前向因果推演引擎。从给定初始状态和动作推演未来因果链，
 * 支持反事实推理和因果链前向推演。
 *
 * @fires SimulationEngine#simulation-started
 * @fires SimulationEngine#simulation-completed
 * @fires SimulationEngine#counterfactual-completed
 * @fires SimulationEngine#forward-prediction-completed
 * @fires SimulationEngine#branch-diverged
 * @fires SimulationEngine#branches-converged
 */

/**
 * 前向因果推演引擎。BFS分支构建、置信度衰减剪枝、
 * 反事实推理、因果链前向预测、模拟报告生成。
 *
 * @classdesc 前向因果推演引擎（融合自MiroFish预测引擎）。
 * simulate(因果链BFS分支构建+置信度衰减剪枝)/
 * counterfactual(反事实推理)/forwardPredict(因果链前向预测)/
 * generateReport(模拟报告生成)/attachCausalMemoryStore/attachCausalDataBus。
 * @extends EventEmitter
 */
class SimulationEngine extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxDepth=10] - BFS最大分支深度
   * @param {number} [options.maxBranches=50] - 最大分支数
   * @param {number} [options.confidenceThreshold=0.1] - 置信度剪枝阈值
   */
  constructor(options) {
    super();
    this._options = options ?? {};
    this._simulations = new Map();
    this._counterfactuals = [];
    this._forwardPredictions = [];
    this._stats = {
      simulationsTotal: 0,
      counterfactualsTotal: 0,
      forwardPredictionsTotal: 0,
      avgBranchCount: 0,
      avgConfidence: 0,
    };
    this._causalMemoryStore = null;
    this._causalDataBus = null;
  }

  /**
   * 执行前向模拟，从给定初始状态和动作推演未来因果链。
   * @param {object} initialState - 初始状态
   * @param {Map<string,number>|object} initialState.variables - 状态变量映射
   * @param {Array<{name:string,expression:object}>} [initialState.constraints=[]] - 约束条件
   * @param {object} [initialState.context={}] - 上下文信息
   * @param {Array<object>} actions - 动作列表
   * @param {string} actions[].name - 动作名称
   * @param {Map|object} actions[].effects - 动作效果映射
   * @param {number} actions[].probability - 动作发生概率（0-1）
   * @param {object} [actions[].preconditions] - 动作前置条件
   * @param {object} [options] - 模拟选项
   * @param {number} [options.maxDepth=5] - 最大推演深度
   * @param {number} [options.maxBranches=10] - 最大分支数
   * @param {number} [options.confidenceThreshold=0.3] - 置信度阈值
   * @param {number} [options.timeHorizon=1000] - 时间视野（毫秒）
   * @returns {{simulationId:string,branches:Array<object>,summary:object}} 模拟结果
   * @throws {Error} When initialState is invalid or not a Map
   * @example
   * const engine = new SimulationEngine();
   * const result = await engine.simulate({
   *   initialState: new Map([['revenue', 100], ['users', 50]]),
   *   actions: [
   *     { name: 'launch', effects: new Map([['revenue', 20]]), probability: 0.8 }
   *   ],
   *   maxDepth: 5,
   *   confidenceThreshold: 0.1
   * });
   * console.log(result.summary.totalBranches);
   */
  simulate(initialState, actions, options) {
    this.guardShutdown();
    if (!initialState || typeof initialState !== 'object') {
      return { simulationId: null, branches: [], summary: this._emptySummary() };
    }
    const opts = this._resolveSimOptions(options);
    const simulationId = uuid('sim-');
    this.emit('simulation-started', { simulationId });
    const variables = this._toMap(initialState.variables);
    const constraints = Array.isArray(initialState.constraints) ? initialState.constraints : [];
    const branches = this._buildBranches(variables, constraints, actions, opts);
    const summary = this._buildSummary(branches);
    const record = {
      simulationId,
      initialState: {
        variables: this._toMap(variables),
        constraints,
        context: initialState.context ?? {},
      },
      branches,
      summary,
      createdAt: Date.now(),
    };
    this._storeSimulation(record);
    this._updateSimStats(branches);
    debug('simulate-completed', simulationId + ' branches=' + branches.length);
    this.emit('simulation-completed', {
      simulationId,
      branchCount: branches.length,
      avgConfidence: summary.avgConfidence,
    });
    return { simulationId, branches, summary };
  }

  /**
   * 获取指定ID的模拟结果。
   * @param {string} simulationId - 模拟ID
   * @returns {object|null} 模拟结果记录，不存在时返回null
   */
  getSimulation(simulationId) {
    this.guardShutdown();
    const sim = this._simulations.get(simulationId);
    return sim ? { ...sim, branches: sim.branches.slice(), initialState: { ...sim.initialState } } : null;
  }

  /**
   * 列出最近的模拟结果。
   * @param {number} [limit=10] - 返回数量上限
   * @returns {Array<object>} 模拟结果列表（按时间倒序）
   */
  listSimulations(limit) {
    this.guardShutdown();
    const n = typeof limit === 'number' && limit > 0 ? limit : 10;
    const entries = Array.from(this._simulations.values());
    return entries.slice(-n).reverse().map(sim => ({ ...sim }));
  }

  /**
   * 执行反事实推理，给定实际结果和替代动作推演"如果当时做了X"的结果。
   * @param {object} actualState - 实际初始状态（格式同simulate的initialState）
   * @param {object} actualAction - 实际执行的动作
   * @param {string} actualAction.name - 动作名称
   * @param {Map|object} actualAction.effects - 动作效果
   * @param {number} actualAction.probability - 动作概率
   * @param {object} alternativeAction - 替代动作（格式同actualAction）
   * @param {number} [depth=3] - 推演深度
   * @returns {{actualOutcome:object,counterfactualOutcome:object,divergence:object,insight:string}} 反事实推理结果
   */
  counterfactual(actualState, actualAction, alternativeAction, depth) {
    this.guardShutdown();
    if (!actualState || !actualAction || !alternativeAction) {
      return {
        actualOutcome: null,
        counterfactualOutcome: null,
        divergence: {},
        insight: 'Invalid input',
      };
    }
    const maxDepth = typeof depth === 'number' && depth > 0 ? depth : 3;
    const variables = this._toMap(actualState.variables);
    const constraints = Array.isArray(actualState.constraints) ? actualState.constraints : [];
    const actualOutcome = this._simulateSingle(variables, constraints, actualAction, maxDepth);
    const cfOutcome = this._simulateSingle(variables, constraints, alternativeAction, maxDepth);
    const divergence = this._computeDivergence(actualOutcome, cfOutcome);
    const insight = this._generateInsight(actualAction, alternativeAction, divergence);
    const record = {
      id: uuid('cf-'),
      actualOutcome,
      counterfactualOutcome: cfOutcome,
      divergence,
      insight,
      createdAt: Date.now(),
    };
    this._storeCounterfactual(record);
    this._stats.counterfactualsTotal++;
    debug('counterfactual-completed', record.id + ' magnitude=' + divergence.magnitude);
    this.emit('counterfactual-completed', {
      id: record.id,
      divergenceMagnitude: divergence.magnitude,
    });
    return {
      actualOutcome,
      counterfactualOutcome: cfOutcome,
      divergence,
      insight,
    };
  }

  /**
   * 挂载CausalMemoryStore实例，用于因果链前向推演。
   * @param {object} store - CausalMemoryStore实例
   * @returns {SimulationEngine} 当前实例，支持链式调用
   */
  attachCausalMemoryStore(store) {
    this.guardShutdown();
    this._causalMemoryStore = store ?? null;
    return this;
  }

  /**
   * 挂载CausalDataBus实例，用于因果链前向推演。
   * @param {object} bus - CausalDataBus实例
   * @returns {SimulationEngine} 当前实例，支持链式调用
   */
  attachCausalDataBus(bus) {
    this.guardShutdown();
    this._causalDataBus = bus ?? null;
    return this;
  }

  /**
   * 从原因前向预测效果，基于CausalMemoryStore的历史因果模式推演未来。
   * @param {object} cause - 原因描述
   * @param {string} cause.description - 原因文本描述
   * @param {Map<string,number>|object} [cause.variables] - 相关变量
   * @param {object} [cause.context] - 上下文信息
   * @param {number} [depth=5] - 推演深度
   * @returns {Promise<{predictions:Array<object>,consensusConfidence:number}>} 前向预测结果
   */
  async forwardPredict(cause, depth) {
    try {
      this.guardShutdown();
      if (!cause || typeof cause !== 'object') {
        return { predictions: [], consensusConfidence: 0 };
      }
      const maxDepth = typeof depth === 'number' && depth > 0 ? depth : DEFAULT_MAX_DEPTH;
      const predictions = [];
      await this._collectForwardPredictions(
        cause.description, maxDepth, [], [], predictions, new Set(),
      );
      predictions.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
      const top = predictions.slice(0, 10);
      const consensusConfidence = top.length > 0
        ? top.reduce((s, p) => s + p.confidence, 0) / top.length
        : 0;
      const record = {
        id: uuid('fp-'),
        cause,
        predictions: top,
        consensusConfidence,
        createdAt: Date.now(),
      };
      this._storeForwardPrediction(record);
      this._stats.forwardPredictionsTotal++;
      this.emit('forward-prediction-completed', {
        id: record.id,
        predictionCount: top.length,
        consensusConfidence,
      });
      return { predictions: top, consensusConfidence };
    } catch (err) {
      debug('SimulationEngine', 'forwardPredict-error', err && err.message ? err.message : String(err));
      return { predictions: [], consensusConfidence: 0, error: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 对状态应用动作效果，返回新状态（不修改原状态）。
   * @param {Map<string,number>} state - 当前状态变量
   * @param {object} action - 动作对象
   * @param {Map|object} action.effects - 动作效果映射
   * @returns {Map<string,number>} 应用效果后的新状态
   */
  _applyAction(state, action) {
    const newState = new Map(state);
    const effects = this._toMap(action.effects);
    for (const [key, effect] of effects) {
      if (!effect || typeof effect !== 'object') continue;
      const current = newState.get(key);
      const safeCurrent = typeof current === 'number' && Number.isFinite(current) ? current : 0;
      const value = typeof effect.value === 'number' && Number.isFinite(effect.value) ? effect.value : 0;
      switch (effect.operator) {
        case '+':
          newState.set(key, safeCurrent + value);
          break;
        case '-':
          newState.set(key, safeCurrent - value);
          break;
        case '*':
          newState.set(key, safeCurrent * value);
          break;
        case '=':
        case 'set':
          newState.set(key, value);
          break;
        default:
          debug('SimulationEngine', 'unknownOperator', 'Unknown effect operator: ' + String(effect.operator));
          break;
      }
    }
    return newState;
  }

  /**
   * 评估约束是否满足。
   * @param {Map<string,number>} state - 当前状态变量
   * @param {Array<{name:string,expression:object}>} constraints - 约束条件列表
   * @returns {{satisfied:boolean,violations:Array<object>}} 评估结果
   */
  _evaluateConstraints(state, constraints) {
    const violations = [];
    for (const constraint of constraints) {
      const expr = constraint.expression;
      if (!expr || typeof expr !== 'object' || !expr.field) continue;
      const actual = state.get(expr.field);
      if (actual === undefined) {
        violations.push({ name: constraint.name, field: expr.field, reason: 'missing' });
        continue;
      }
      const expected = typeof expr.value === 'number' && Number.isFinite(expr.value) ? expr.value : 0;
      let violated = false;
      switch (expr.operator) {
        case '>':
          violated = actual <= expected;
          break;
        case '<':
          violated = actual >= expected;
          break;
        case '>=':
          violated = actual < expected;
          break;
        case '<=':
          violated = actual > expected;
          break;
        case '==':
          violated = actual !== expected;
          break;
        case '!=':
          violated = actual === expected;
          break;
        default:
          debug('SimulationEngine', 'unknownConstraintOperator', 'Unknown constraint operator: ' + String(expr.operator));
          break;
      }
      if (violated) {
        violations.push({
          name: constraint.name,
          field: expr.field,
          expected: expr.operator + ' ' + expected,
          actual,
        });
      }
    }
    return { satisfied: violations.length === 0, violations };
  }

  /**
   * 计算路径置信度（随深度衰减）。
   * @param {Array} path - 动作路径
   * @param {number} baseConfidence - 基础置信度
   * @param {number} [threshold=0.3] - 最低置信度阈值
   * @returns {number} 路径置信度
   */
  _computeConfidence(path, baseConfidence, threshold) {
    const depth = Array.isArray(path) ? path.length : 0;
    const conf = baseConfidence * Math.pow(DECAY_FACTOR, depth);
    return Math.max(conf, threshold || DEFAULT_CONFIDENCE_THRESHOLD);
  }

  /**
   * 检测分支收敛，返回收敛的分支组。
   * @param {Array<object>} branches - 分支列表
   * @returns {Array<Array<object>>} 收敛分支组列表
   */
  _detectConvergence(branches) {
    const groups = [];
    const assigned = new Set();
    for (let i = 0; i < branches.length; i++) {
      if (assigned.has(i)) continue;
      const group = [i];
      for (let j = i + 1; j < branches.length; j++) {
        if (assigned.has(j)) continue;
        if (this._branchesConverged(branches[i], branches[j])) {
          group.push(j);
          assigned.add(j);
        }
      }
      if (group.length > 1) {
        assigned.add(i);
        groups.push(group.map(idx => branches[idx]));
      }
    }
    return groups;
  }

  _branchesConverged(a, b) {
    const stateA = a.finalState ?? new Map();
    const stateB = b.finalState ?? new Map();
    const allKeys = new Set([...stateA.keys(), ...stateB.keys()]);
    if (allKeys.size === 0) return true;
    for (const key of allKeys) {
      const va = typeof stateA.get(key) === 'number' && Number.isFinite(stateA.get(key)) ? stateA.get(key) : 0;
      const vb = typeof stateB.get(key) === 'number' && Number.isFinite(stateB.get(key)) ? stateB.get(key) : 0;
      const ref = Math.max(Math.abs(va), Math.abs(vb), 1);
      if (Math.abs(va - vb) >= CONVERGENCE_THRESHOLD * ref) return false;
    }
    return true;
  }

  _toMap(obj) {
    if (obj instanceof Map) return new Map(obj);
    if (obj != null && typeof obj === 'object' && !Array.isArray(obj)) return new Map(Object.entries(obj));
    return new Map();
  }

  _resolveSimOptions(options) {
    const opts = options ?? {};
    return {
      maxDepth: typeof opts.maxDepth === 'number' && Number.isFinite(opts.maxDepth) ? opts.maxDepth : DEFAULT_MAX_DEPTH,
      maxBranches: typeof opts.maxBranches === 'number' && Number.isFinite(opts.maxBranches) ? opts.maxBranches : DEFAULT_MAX_BRANCHES,
      confidenceThreshold: typeof opts.confidenceThreshold === 'number' && Number.isFinite(opts.confidenceThreshold) ? opts.confidenceThreshold : DEFAULT_CONFIDENCE_THRESHOLD,
      timeHorizon: typeof opts.timeHorizon === 'number' && Number.isFinite(opts.timeHorizon) ? opts.timeHorizon : DEFAULT_TIME_HORIZON,
    };
  }

  _makeWorldLine(path, finalState, confidence, constraints) {
    const constraintResult = this._evaluateConstraints(finalState, constraints);
    return {
      id: uuid('wl-'),
      path,
      finalState,
      confidence,
      constraintViolations: constraintResult.violations,
    };
  }

  _buildBranches(variables, constraints, actions, opts) {
    if (!Array.isArray(actions) || actions.length === 0) {
      return [this._makeWorldLine([], this._toMap(variables), 1.0, constraints)];
    }
    const completed = [];
    let current = [{ path: [], state: this._toMap(variables), probProduct: 1.0, confidence: 1.0 }];
    for (let d = 0; d < opts.maxDepth; d++) {
      const next = [];
      for (const branch of current) {
        const expanded = this._expandBranch(branch, actions, opts, next);
        if (!expanded) {
          completed.push(branch);
        }
      }
      if (next.length === 0) break;
      next.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
      current = next.slice(0, opts.maxBranches);
    }
    const allBranches = [...completed, ...current];
    if (allBranches.length === 0) {
      allBranches.push({ path: [], state: this._toMap(variables), probProduct: 1.0, confidence: 1.0 });
    }
    const result = allBranches.map(
      b => this._makeWorldLine(b.path, b.state, b.confidence, constraints),
    );
    this._detectAndEmitConvergence(result);
    return result;
  }

  _expandBranch(branch, actions, opts, next) {
    let expanded = false;
    for (const action of actions) {
      if (!this._checkPreconditions(branch.state, action.preconditions)) continue;
      const newState = this._applyAction(branch.state, action);
      const newProb = branch.probProduct * (action.probability ?? 1.0);
      const confidence = this._computeConfidence(
        [...branch.path, action.name], newProb, opts.confidenceThreshold,
      );
      if (confidence < opts.confidenceThreshold) continue;
      next.push({
        path: [...branch.path, action.name],
        state: newState,
        probProduct: newProb,
        confidence,
      });
      expanded = true;
      this.emit('branch-diverged', { action: action.name, depth: branch.path.length });
    }
    return expanded;
  }

  _checkPreconditions(state, preconditions) {
    if (!preconditions || typeof preconditions !== 'object') return true;
    for (const [key, requirement] of Object.entries(preconditions)) {
      const value = state.get(key);
      if (typeof requirement === 'number' && Number.isFinite(requirement)) {
        if (value === undefined || value < requirement) return false;
      } else if (typeof requirement === 'object' && requirement !== null) {
        if (requirement.exists && value === undefined) return false;
        if (requirement.min !== undefined && (value === undefined || value < requirement.min)) return false;
        if (requirement.max !== undefined && (value === undefined || value > requirement.max)) return false;
      }
    }
    return true;
  }

  _buildSummary(branches) {
    const total = branches.length;
    if (total === 0 || !branches[0]) return this._emptySummary();
    const avgConfidence = branches.reduce((s, b) => s + (typeof b.confidence === 'number' && Number.isFinite(b.confidence) ? b.confidence : 0), 0) / total;
    const topOutcome = branches.reduce(
      (best, b) => ((typeof b.confidence === 'number' && Number.isFinite(b.confidence) ? b.confidence : 0) > (typeof best.confidence === 'number' && Number.isFinite(best.confidence) ? best.confidence : 0) ? b : best),
      branches[0],
    );
    const riskFactors = this._identifyRiskFactors(branches);
    const opportunities = this._identifyOpportunities(branches);
    return { totalBranches: total, avgConfidence, topOutcome, riskFactors, opportunities };
  }

  _emptySummary() {
    return {
      totalBranches: 0,
      avgConfidence: 0,
      topOutcome: null,
      riskFactors: [],
      opportunities: [],
    };
  }

  _identifyRiskFactors(branches) {
    const risks = [];
    for (const b of branches) {
      if (b.constraintViolations && b.constraintViolations.length > 0) {
        risks.push({ path: b.path, violations: b.constraintViolations, confidence: b.confidence });
      }
    }
    return risks;
  }

  _identifyOpportunities(branches) {
    return branches
      .filter(b => b.confidence >= DEFAULT_CONFIDENCE_THRESHOLD
        && (!b.constraintViolations || b.constraintViolations.length === 0))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, 5)
      .map(b => ({ path: b.path, confidence: b.confidence }));
  }

  _storeSimulation(record) {
    if (this._simulations.size >= MAX_SIMULATIONS) {
      const oldest = this._simulations.keys().next().value;
      this._simulations.delete(oldest);
    }
    this._simulations.set(record.simulationId, record);
  }

  _storeCounterfactual(record) {
    this._counterfactuals.push(record);
    if (this._counterfactuals.length > MAX_COUNTERFACTUALS) {
      this._counterfactuals.shift();
    }
  }

  _storeForwardPrediction(record) {
    this._forwardPredictions.push(record);
    if (this._forwardPredictions.length > MAX_FORWARD_PREDICTIONS) {
      this._forwardPredictions.shift();
    }
  }

  _updateSimStats(branches) {
    this._stats.simulationsTotal++;
    const n = this._stats.simulationsTotal;
    const branchCount = branches.length;
    const avgConf = branches.length > 0
      ? branches.reduce((s, b) => s + (typeof b.confidence === 'number' && Number.isFinite(b.confidence) ? b.confidence : 0), 0) / branches.length
      : 0;
    this._stats.avgBranchCount = this._stats.avgBranchCount * (n - 1) / n + branchCount / n;
    const newAvgConf = this._stats.avgConfidence * (n - 1) / n + avgConf / n;
    this._stats.avgConfidence = Number.isFinite(newAvgConf) ? newAvgConf : 0;
  }

  _simulateSingle(variables, constraints, action, depth) {
    let currentState = this._toMap(variables);
    const prob = action.probability ?? 1.0;
    currentState = this._applyAction(currentState, action);
    const confidence = this._computeConfidence([action.name], prob, DEFAULT_CONFIDENCE_THRESHOLD);
    const constraintResult = this._evaluateConstraints(currentState, constraints);
    return {
      finalState: currentState,
      confidence: Math.max(confidence, DEFAULT_CONFIDENCE_THRESHOLD),
      constraintViolations: constraintResult.violations,
      depth,
    };
  }

  _computeDivergence(actual, counterfactualOutcome) {
    const actualState = actual.finalState ?? new Map();
    const cfState = counterfactualOutcome.finalState ?? new Map();
    const allKeys = new Set([...actualState.keys(), ...cfState.keys()]);
    const variables = {};
    let totalMagnitude = 0;
    let point = null;
    let maxDiff = 0;
    for (const key of allKeys) {
      const va = typeof actualState.get(key) === 'number' && Number.isFinite(actualState.get(key)) ? actualState.get(key) : 0;
      const vb = typeof cfState.get(key) === 'number' && Number.isFinite(cfState.get(key)) ? cfState.get(key) : 0;
      const diff = Math.abs(va - vb);
      if (diff > 0) {
        variables[key] = { actual: va, counterfactual: vb, difference: diff };
        totalMagnitude += diff;
        if (diff > maxDiff) {
          maxDiff = diff;
          point = key;
        }
      }
    }
    return { point, variables, magnitude: totalMagnitude };
  }

  _generateInsight(actualAction, alternativeAction, divergence) {
    if (divergence.magnitude === 0) {
      return 'No divergence: ' + alternativeAction.name
        + ' produces the same outcome as ' + actualAction.name;
    }
    const topVar = divergence.point || 'unknown';
    const varInfo = divergence.variables[topVar];
    if (varInfo) {
      return 'If ' + alternativeAction.name + ' had been chosen instead of '
        + actualAction.name + ', ' + topVar + ' would be '
        + varInfo.counterfactual + ' instead of ' + varInfo.actual
        + ' (difference: ' + varInfo.difference + ')';
    }
    return alternativeAction.name + ' diverges from ' + actualAction.name
      + ' with magnitude ' + divergence.magnitude;
  }

  async _collectForwardPredictions(description, remainingDepth, currentPath, supportingPatterns, results, visited) {
    if (remainingDepth <= 0 || !this._causalMemoryStore) return;
    if (!description || typeof description !== 'string') return;
    if (visited.has(description)) return;
    visited.add(description);
    const patterns = await safeExecute(
      () => this._causalMemoryStore.searchByCausalSimilarity(description, { limit: 5 }),
      'SimulationEngine',
      'forwardPredict-search',
      [],
    );
    if (!Array.isArray(patterns)) return;
    for (const pattern of patterns) {
      const newPath = [...currentPath, pattern.effect];
      const newSupporting = [...supportingPatterns, pattern.id];
      const baseConfidence = (typeof pattern.confidence === 'number' && Number.isFinite(pattern.confidence) ? pattern.confidence : 0.5) * (typeof pattern.similarity === 'number' && Number.isFinite(pattern.similarity) ? pattern.similarity : 0.5);
      const confidence = Math.max(
        baseConfidence * Math.pow(DECAY_FACTOR, newPath.length),
        DEFAULT_CONFIDENCE_THRESHOLD,
      );
      if (confidence < DEFAULT_CONFIDENCE_THRESHOLD) continue;
      results.push({
        effect: pattern.effect,
        confidence,
        path: newPath,
        supportingPatterns: newSupporting,
      });
      if (remainingDepth > 1) {
        await this._collectForwardPredictions(
          pattern.effect, remainingDepth - 1, newPath, newSupporting, results, visited,
        );
      }
    }
  }

  _detectAndEmitConvergence(branches) {
    const groups = this._detectConvergence(branches);
    for (const group of groups) {
      this.emit('branches-converged', {
        branchCount: group.length,
        paths: group.map(b => b.path),
      });
    }
  }

  /**
   * 获取引擎统计信息。
   * @returns {{simulationsTotal:number,counterfactualsTotal:number,forwardPredictionsTotal:number,avgBranchCount:number,avgConfidence:number}} 统计数据
   */
  getStats() {
    try {
      this.guardShutdown();
    } catch (_e) {
      return {
        simulationsTotal: 0,
        counterfactualsTotal: 0,
        forwardPredictionsTotal: 0,
        avgBranchCount: 0,
        avgConfidence: 0,
      };
    }
    return { ...this._stats };
  }

  /**
   * 检查实例是否健康（未关闭）。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown;
  }

  /**
   * 检查操作总数是否已达健康上限。
   * @returns {boolean} 是否已达操作上限
   */
  isAtOperationLimit() {
    this.guardShutdown();
    const total = this._stats.simulationsTotal
      + this._stats.counterfactualsTotal
      + this._stats.forwardPredictionsTotal;
    return total >= MAX_HEALTHY_TOTAL;
  }

  /**
   * 生成模拟报告（Markdown格式）。
   * @param {string} simulationId - 模拟ID
   * @returns {string|null} Markdown格式报告，模拟不存在时返回null
   */
  generateReport(simulationId) {
    this.guardShutdown();
    const sim = this._simulations.get(simulationId);
    if (!sim) return null;
    return this._formatReport(sim);
  }

  _formatInitialState(initialState) {
    const lines = [];
    lines.push('## Initial State');
    const vars = initialState && initialState.variables;
    if (vars) {
      const entries = vars instanceof Map ? Array.from(vars.entries()) : Object.entries(vars);
      for (const [key, value] of entries) {
        lines.push('- ' + key + ': ' + value);
      }
    }
    lines.push('');
    return lines;
  }

  _formatSummary(summary) {
    const lines = [];
    lines.push('## Summary');
    lines.push('- Total Branches: ' + (summary.totalBranches ?? 0));
    lines.push('- Average Confidence: ' + ((summary ?? {}).avgConfidence ?? 0).toFixed(4));
    if (summary.topOutcome) {
      const topPath = summary.topOutcome.path ?? [];
      const topConf = summary.topOutcome.confidence ?? 0;
      lines.push('- Top Outcome: [' + topPath.join(', ') + '] (confidence: ' + topConf.toFixed(4) + ')');
    }
    lines.push('');
    return lines;
  }

  _formatRiskAndOpportunities(summary) {
    const lines = [];
    if (summary.riskFactors && summary.riskFactors.length > 0) {
      lines.push('## Risk Factors');
      for (const risk of summary.riskFactors) {
        const violationNames = (risk.violations ?? []).map(v => v.name).join(', ');
        lines.push('- Path [' + (risk.path ?? []).join(', ') + ']: ' + violationNames);
      }
      lines.push('');
    }
    if (summary.opportunities && summary.opportunities.length > 0) {
      lines.push('## Opportunities');
      for (const opp of summary.opportunities) {
        lines.push('- Path [' + (opp.path ?? []).join(', ') + '] (confidence: ' + (opp.confidence ?? 0).toFixed(4) + ')');
      }
      lines.push('');
    }
    return lines;
  }

  _formatReport(sim) {
    const lines = [];
    lines.push('# Simulation Report');
    lines.push('');
    lines.push('## Simulation ID: ' + sim.simulationId);
    lines.push('Created: ' + safeIsoDate(sim.createdAt));
    lines.push('');
    lines.push(...this._formatInitialState(sim.initialState));
    lines.push(...this._formatSummary(sim.summary));
    lines.push(...this._formatRiskAndOpportunities(sim.summary));
    return lines.join('\n');
  }

  _onShutdown() {
    debug('shutdown', 'clearing state');
    this._simulations.clear();
    this._counterfactuals.length = 0;
    this._forwardPredictions.length = 0;
    this._causalMemoryStore = null;
    this._causalDataBus = null;
    this._stats = { simulationsTotal: 0, counterfactualsTotal: 0, forwardPredictionsTotal: 0, avgBranchCount: 0, avgConfidence: 0 };
    this._options = {};
    this.removeAllListeners();
  }
}

module.exports = withShutdown(SimulationEngine);
