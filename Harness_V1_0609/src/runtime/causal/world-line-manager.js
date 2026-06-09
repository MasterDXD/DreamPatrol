'use strict';

const { EventEmitter } = require('events');
const debug = require('../../utils/debug-logger')('WorldLineManager');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const { DeepeningError } = require('../../errors');
const { uuid } = require('../../utils/unique-id');

const MAX_WORLD_LINES = 500;
const ID_PREFIX = 'wl-';
const MERGE_STRATEGIES = Object.freeze({
  UNION: 'union',
  INTERSECTION: 'intersection',
  WEIGHTED_AVERAGE: 'weighted-average',
  LATEST_WINS: 'latest-wins',
});


/**
 * @module runtime/causal/world-line-manager
 * 多世界线/分支管理器。管理世界线的创建、分支、合并、状态转移和概率计算，
 * 支持分支树遍历、回滚和时间线报告生成。
 * 被 DeriveExecutor 引用，用于派生分支的世界线追踪。
 *
 * @fires WorldLineManager#world-line-created
 * @fires WorldLineManager#world-line-branch-created
 * @fires WorldLineManager#world-lines-merged
 * @fires WorldLineManager#step-advanced
 * @fires WorldLineManager#step-rolled-back
 * @fires WorldLineManager#world-line-removed
 *
 * @example
 * const mgr = new WorldLineManager();
 * const wl = mgr.createWorldLine('alpha', { x: 1, y: 2 });
 * mgr.advanceStep(wl.worldLineId, { name: 'increment', effects: { x: 1 }, probability: 0.9 }, { success: true, actualEffects: { x: 1 }, confidence: 0.95 });
 * const prob = mgr.computeProbability(wl.worldLineId);
 */

/**
 * 世界线管理器，管理因果链的多版本分支和合并，支持并行时间线的追踪与回溯
 * @classdesc 世界线管理器，管理因果链的多版本分支和合并，支持并行时间线的追踪与回溯
 * @extends EventEmitter
 */
class WorldLineManager extends EventEmitter {
  constructor() {
    super();
    this._worldLines = new Map();
    this._stats = {
      worldLinesTotal: 0,
      activeLines: 0,
      maxDepth: 0,
      avgBranchFactor: 0,
      totalSteps: 0,
    };
  }

  /**
   * 创建一条新的世界线，可选指定父世界线以形成分支关系。
   * @param {string} name - 世界线名称
   * @param {object} initialState - 初始状态变量
   * @param {string} [parentLineId] - 父世界线ID（用于分支）
   * @returns {{worldLineId: string, name: string, initialState: object, parentLineId: string|null, currentState: object, depth: number, status: string, createdAt: number}} 新世界线对象
   * @throws {DeepeningError} 参数无效或容量超限时抛出
   * @example
   * const wlm = new WorldLineManager();
   * const mainLineId = wlm.createWorldLine({
   *   initialState: new Map([['gdp', 100], ['population', 7]]),
   *   description: 'Baseline world line'
   * });
   * const branchId = wlm.branchFrom(mainLineId, {
   *   action: { name: 'policy_change', probability: 0.6 },
   *   stateDeltas: new Map([['gdp', 5]])
   * });
   */
  createWorldLine(name, initialState, parentLineId) {
    this.guardShutdown();
    if (!name || typeof name !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'name must be a non-empty string');
    }
    if (!initialState || typeof initialState !== 'object' || Array.isArray(initialState)) {
      throw new DeepeningError('INVALID_INPUT', 'initialState must be a non-null object');
    }
    if (this.isAtCapacity()) {
      throw new DeepeningError('CAPACITY_EXCEEDED', 'Maximum world line count reached: ' + MAX_WORLD_LINES);
    }
    let depth = 0;
    let parentId = null;
    if (parentLineId) {
      const parent = this._worldLines.get(parentLineId);
      if (!parent) {
        throw new DeepeningError('RESOURCE_NOT_FOUND', 'Parent world line not found: ' + parentLineId);
      }
      parentId = parentLineId;
      depth = parent.depth + 1;
    }
    const worldLineId = uuid(ID_PREFIX);
    const now = Date.now();
    const currentState = safeAssign({}, initialState);
    const worldLine = {
      worldLineId,
      name,
      initialState: safeAssign({}, initialState),
      currentState,
      parentLineId: parentId,
      childrenIds: [],
      steps: [],
      depth,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this._worldLines.set(worldLineId, worldLine);
    if (parentId) {
      const parent = this._worldLines.get(parentId);
      if (parent) {
        parent.childrenIds.push(worldLineId);
      }
    }
    this._updateStats();
    debug('createWorldLine', 'created: ' + worldLineId + ' name: ' + name);
    this.emit('world-line-created', { worldLineId, name, parentLineId: parentId, depth });
    return {
      worldLineId,
      name,
      initialState: safeAssign({}, worldLine.initialState),
      parentLineId: parentId,
      currentState: safeAssign({}, currentState),
      depth,
      status: worldLine.status,
      createdAt: now,
    };
  }

  /**
   * 获取指定ID的世界线信息。
   * @param {string} worldLineId - 世界线ID
   * @returns {object|null} 世界线对象，不存在时返回null
   */
  getWorldLine(worldLineId) {
    this.guardShutdown();
    const wl = this._worldLines.get(worldLineId);
    if (!wl) return null;
    return this._toPublicWorldLine(wl);
  }

  /**
   * 列出世界线，可按状态过滤。
   * @param {string} [status] - 过滤状态（active/merged/abandoned）
   * @returns {Array<object>} 世界线对象数组
   */
  listWorldLines(status) {
    this.guardShutdown();
    const result = [];
    for (const wl of this._worldLines.values()) {
      if (status && wl.status !== status) continue;
      result.push(this._toPublicWorldLine(wl));
    }
    return result;
  }

  /**
   * 删除指定世界线，同时从父世界线的childrenIds中移除。
   * @param {string} worldLineId - 世界线ID
   * @returns {boolean} 是否成功删除
   */
  removeWorldLine(worldLineId) {
    this.guardShutdown();
    const wl = this._worldLines.get(worldLineId);
    if (!wl) return false;
    if (wl.parentLineId) {
      const parent = this._worldLines.get(wl.parentLineId);
      if (parent) {
        const idx = parent.childrenIds.indexOf(worldLineId);
        if (idx >= 0) parent.childrenIds.splice(idx, 1);
      }
    }
    this._worldLines.delete(worldLineId);
    this._updateStats();
    debug('removeWorldLine', 'removed: ' + worldLineId);
    this.emit('world-line-removed', { worldLineId });
    return true;
  }

  /**
   * 从指定世界线创建分支，记录分歧点信息。
   * @param {string} worldLineId - 源世界线ID
   * @param {string} branchName - 分支名称
   * @param {{step: number, action: string, reason: string}} divergencePoint - 分歧点
   * @returns {object} 新世界线对象
   * @throws {DeepeningError} 源世界线不存在或参数无效时抛出
   */
  branchFrom(worldLineId, branchName, divergencePoint) {
    this.guardShutdown();
    const source = this._worldLines.get(worldLineId);
    if (!source) {
      throw new DeepeningError('RESOURCE_NOT_FOUND', 'Source world line not found: ' + worldLineId);
    }
    if (!branchName || typeof branchName !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'branchName must be a non-empty string');
    }
    if (!divergencePoint || typeof divergencePoint !== 'object') {
      throw new DeepeningError('INVALID_INPUT', 'divergencePoint must be an object');
    }
    const branchState = safeAssign({}, source.currentState);
    const branch = this.createWorldLine(branchName, branchState, worldLineId);
    if (divergencePoint.step !== undefined && divergencePoint.step < source.steps.length) {
      const snapshot = source.steps[divergencePoint.step];
      if (snapshot && snapshot.stateAfter) {
        const wl = this._worldLines.get(branch.worldLineId);
        wl.currentState = safeAssign({}, snapshot.stateAfter);
        branch.currentState = safeAssign({}, snapshot.stateAfter);
      }
    }
    this.emit('world-line-branch-created', {
      sourceId: worldLineId,
      branchId: branch.worldLineId,
      branchName,
      divergencePoint,
    });
    return branch;
  }

  /**
   * 合并两条世界线的状态，支持四种合并策略。
   * @param {string} sourceId - 源世界线ID
   * @param {string} targetId - 目标世界线ID
   * @param {string} strategy - 合并策略（union/intersection/weighted-average/latest-wins）
   * @returns {object} 合并后的状态
   * @throws {DeepeningError} 世界线不存在或策略无效时抛出
   */
  mergeWorldLines(sourceId, targetId, strategy) {
    this.guardShutdown();
    const source = this._worldLines.get(sourceId);
    const target = this._worldLines.get(targetId);
    if (!source) {
      throw new DeepeningError('RESOURCE_NOT_FOUND', 'Source world line not found: ' + sourceId);
    }
    if (!target) {
      throw new DeepeningError('RESOURCE_NOT_FOUND', 'Target world line not found: ' + targetId);
    }
    const validStrategies = new Set(Object.values(MERGE_STRATEGIES));
    if (!validStrategies.has(strategy)) {
      throw new DeepeningError('INVALID_INPUT', 'Invalid merge strategy: ' + strategy);
    }
    const merged = this._mergeStates(source.currentState, target.currentState, strategy);
    target.currentState = merged;
    target.updatedAt = Date.now();
    source.status = 'merged';
    source.updatedAt = Date.now();
    this._updateStats();
    this.emit('world-lines-merged', { sourceId, targetId, strategy, mergedKeys: Object.keys(merged).length });
    debug('mergeWorldLines', 'merged: ' + sourceId + ' -> ' + targetId + ' strategy: ' + strategy);
    return safeAssign({}, merged);
  }

  /**
   * 获取指定世界线的分支树（递归获取所有后代世界线）。
   * @param {string} worldLineId - 世界线ID
   * @returns {{root: object, children: Array<{worldLine: object, children: Array}>}} 树形结构
   */
  getBranchTree(worldLineId) {
    this.guardShutdown();
    const wl = this._worldLines.get(worldLineId);
    if (!wl) return { root: null, children: [] };
    return this._buildBranchTree(wl);
  }

  /**
   * 推进世界线一步，记录动作和结果，更新当前状态。
   * @param {string} worldLineId - 世界线ID
   * @param {{name: string, effects: object, probability: number}} action - 动作描述
   * @param {{success: boolean, actualEffects: object, confidence: number}} result - 动作结果
   * @returns {object} 更新后的世界线状态
   * @throws {DeepeningError} 世界线不存在或参数无效时抛出
   */
  advanceStep(worldLineId, action, result) {
    this.guardShutdown();
    const wl = this._worldLines.get(worldLineId);
    if (!wl) {
      throw new DeepeningError('RESOURCE_NOT_FOUND', 'World line not found: ' + worldLineId);
    }
    if (!action || typeof action !== 'object') {
      throw new DeepeningError('INVALID_INPUT', 'action must be a non-null object');
    }
    if (!result || typeof result !== 'object') {
      throw new DeepeningError('INVALID_INPUT', 'result must be a non-null object');
    }
    const probability = typeof action.probability === 'number' && Number.isFinite(action.probability) ? Math.min(1, Math.max(0, action.probability)) : 1;
    const stepIndex = wl.steps.length;
    const stateAfter = safeAssign({}, wl.currentState);
    if (result.success && result.actualEffects && typeof result.actualEffects === 'object') {
      safeAssign(stateAfter, result.actualEffects);
    }
    wl.currentState = stateAfter;
    wl.updatedAt = Date.now();
    wl.steps.push({
      step: stepIndex,
      action: {
        name: action.name || '',
        effects: action.effects ? safeAssign({}, action.effects) : {},
        probability,
      },
      result: {
        success: !!result.success,
        actualEffects: result.actualEffects ? safeAssign({}, result.actualEffects) : {},
        confidence: typeof result.confidence === 'number' && Number.isFinite(result.confidence) ? result.confidence : 1,
      },
      stateAfter: safeAssign({}, stateAfter),
      probability,
      timestamp: Date.now(),
    });
    this._updateStats();
    debug('advanceStep', 'worldLine: ' + worldLineId + ' step: ' + stepIndex);
    this.emit('step-advanced', { worldLineId, step: stepIndex, actionName: action.name });
    return safeAssign({}, wl.currentState);
  }

  /**
   * 将世界线回滚到指定步骤索引，移除该步骤之后的所有步骤。
   * @param {string} worldLineId - 世界线ID
   * @param {number} stepIndex - 目标步骤索引
   * @returns {object|null} 回滚后的状态，世界线不存在或索引无效时返回null
   */
  rollbackToStep(worldLineId, stepIndex) {
    this.guardShutdown();
    const wl = this._worldLines.get(worldLineId);
    if (!wl) return null;
    if (typeof stepIndex !== 'number' || stepIndex < 0 || stepIndex >= wl.steps.length) {
      return null;
    }
    const targetStep = wl.steps[stepIndex];
    wl.steps = wl.steps.slice(0, stepIndex + 1);
    wl.currentState = safeAssign({}, targetStep.stateAfter);
    wl.updatedAt = Date.now();
    this._updateStats();
    debug('rollbackToStep', 'worldLine: ' + worldLineId + ' step: ' + stepIndex);
    this.emit('step-rolled-back', { worldLineId, stepIndex });
    return safeAssign({}, wl.currentState);
  }

  /**
   * 获取指定步骤的状态快照。
   * @param {string} worldLineId - 世界线ID
   * @param {number} stepIndex - 步骤索引
   * @returns {object|null} 状态快照，不存在时返回null
   */
  getStateAtStep(worldLineId, stepIndex) {
    this.guardShutdown();
    const wl = this._worldLines.get(worldLineId);
    if (!wl) return null;
    if (stepIndex < 0 || stepIndex >= wl.steps.length) return null;
    return safeAssign({}, wl.steps[stepIndex].stateAfter);
  }

  /**
   * 计算世界线到达当前状态的概率，基于路径上每步概率连乘。
   * @param {string} worldLineId - 世界线ID
   * @returns {{probability: number, pathLength: number, confidenceInterval: {lower: number, upper: number}}} 概率计算结果
   */
  computeProbability(worldLineId) {
    this.guardShutdown();
    const wl = this._worldLines.get(worldLineId);
    if (!wl) return { probability: 0, pathLength: 0, confidenceInterval: { lower: 0, upper: 0 } };
    let probability = 1;
    const steps = Array.isArray(wl.steps) ? wl.steps : [];
    const pathLength = steps.length;
    for (const step of steps) {
      const p = Number.isFinite(step.probability) ? step.probability : 1;
      probability *= p;
    }
    probability = Math.max(0, Math.min(1, probability));
    const margin = pathLength > 0 ? 1.96 * Math.sqrt(probability * (1 - probability) / pathLength) : 0;
    return {
      probability,
      pathLength,
      confidenceInterval: {
        lower: Math.max(0, probability - margin),
        upper: Math.min(1, probability + margin),
      },
    };
  }

  /**
   * 比较两条世界线的状态差异、概率比和分歧步骤。
   * @param {string} lineId1 - 第一条世界线ID
   * @param {string} lineId2 - 第二条世界线ID
   * @returns {{variableDifferences: Map<string, {line1: *, line2: *, delta: number}>, probabilityRatio: number, divergenceStep: number|null}} 比较结果
   */
  compareWorldLines(lineId1, lineId2) {
    this.guardShutdown();
    const wl1 = this._worldLines.get(lineId1);
    const wl2 = this._worldLines.get(lineId2);
    const variableDifferences = new Map();
    if (!wl1 || !wl2) {
      return { variableDifferences, probabilityRatio: 0, divergenceStep: null };
    }
    const allKeys = new Set([...Object.keys(wl1.currentState), ...Object.keys(wl2.currentState)]);
    for (const key of allKeys) {
      const v1 = wl1.currentState[key];
      const v2 = wl2.currentState[key];
      if (v1 !== v2) {
        const delta = (typeof v1 === 'number' && Number.isFinite(v1) && typeof v2 === 'number' && Number.isFinite(v2)) ? v2 - v1 : 0;
        variableDifferences.set(key, { line1: v1, line2: v2, delta });
      }
    }
    const prob1 = this.computeProbability(lineId1).probability;
    const prob2 = this.computeProbability(lineId2).probability;
    const probabilityRatio = prob1 > 0 ? prob2 / prob1 : (prob2 > 0 ? Infinity : 1);
    const divergenceStep = this._findDivergenceStep(wl1, wl2);
    return { variableDifferences, probabilityRatio, divergenceStep };
  }

  /**
   * 获取世界线管理器统计信息。
   * @returns {{worldLinesTotal: number, activeLines: number, maxDepth: number, avgBranchFactor: number, totalSteps: number}} 统计数据
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { worldLinesTotal: 0, activeLines: 0, maxDepth: 0, avgBranchFactor: 0, totalSteps: 0 };
    }
    this._updateStats();
    return safeAssign({}, this._stats);
  }

  /**
   * 检查实例是否健康（未关闭）。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown;
  }

  /**
   * 检查世界线数量是否已达上限。
   * @returns {boolean} 是否已达容量上限
   */
  isAtCapacity() {
    return this._worldLines.size >= MAX_WORLD_LINES;
  }

  /**
   * 生成指定世界线的Markdown格式时间线报告。
   * @param {string} worldLineId - 世界线ID
   * @returns {string} Markdown格式时间线报告
   */
  generateTimeline(worldLineId) {
    this.guardShutdown();
    const wl = this._worldLines.get(worldLineId);
    if (!wl) return '# World Line Not Found\n\nNo world line found with ID: ' + worldLineId;
    const lines = [];
    this._appendTimelineHeader(lines, wl);
    this._appendTimelineStates(lines, wl);
    this._appendTimelineSteps(lines, wl);
    this._appendTimelineProbability(lines, worldLineId);
    return lines.join('\n');
  }

  _appendTimelineHeader(lines, wl) {
    lines.push('# World Line Timeline: ' + wl.name);
    lines.push('');
    lines.push('- **ID**: ' + wl.worldLineId);
    lines.push('- **Status**: ' + wl.status);
    lines.push('- **Depth**: ' + wl.depth);
    lines.push('- **Parent**: ' + (wl.parentLineId || 'none'));
    lines.push('- **Children**: ' + wl.childrenIds.length);
    lines.push('- **Created**: ' + (function() { try { const d = new Date(wl.createdAt); return isNaN(d.getTime()) ? 'unknown' : d.toISOString(); } catch (_e) { debug('formatDate', _e && _e.message ? _e.message : String(_e)); return 'unknown'; } })());
    lines.push('- **Updated**: ' + (function() { try { const d = new Date(wl.updatedAt); return isNaN(d.getTime()) ? 'unknown' : d.toISOString(); } catch (_e) { debug('formatDate', _e && _e.message ? _e.message : String(_e)); return 'unknown'; } })());
    lines.push('');
  }

  _appendTimelineStates(lines, wl) {
    lines.push('## Initial State');
    lines.push('');
    lines.push('```json');
    try { lines.push(JSON.stringify(wl.initialState, null, 2)); } catch (_e) { lines.push('[unserializable]'); }
    lines.push('```');
    lines.push('');
    lines.push('## Current State');
    lines.push('');
    lines.push('```json');
    try { lines.push(JSON.stringify(wl.currentState, null, 2)); } catch (_e) { lines.push('[unserializable]'); }
    lines.push('```');
    lines.push('');
  }

  _appendTimelineSteps(lines, wl) {
    if (Array.isArray(wl.steps) && wl.steps.length > 0) {
      lines.push('## Steps (' + wl.steps.length + ')');
      lines.push('');
      for (const step of wl.steps) {
        lines.push('### Step ' + step.step + ': ' + ((step.action ?? {}).name ?? 'unknown'));
        lines.push('');
        lines.push('- **Probability**: ' + step.probability.toFixed(4));
        lines.push('- **Success**: ' + (step.result ?? {}).success);
        lines.push('- **Confidence**: ' + ((step.result ?? {}).confidence ?? 0).toFixed(4));
        lines.push('- **Timestamp**: ' + (function() { try { const d = new Date(step.timestamp); return isNaN(d.getTime()) ? 'unknown' : d.toISOString(); } catch (_e) { debug('formatDate', _e && _e.message ? _e.message : String(_e)); return 'unknown'; } })());
        if (Object.keys((step.result ?? {}).actualEffects ?? {}).length > 0) {
          lines.push('- **Actual Effects**:');
          for (const [k, v] of Object.entries((step.result ?? {}).actualEffects ?? {})) {
            lines.push('  - ' + k + ': ' + JSON.stringify(v));
          }
        }
        lines.push('');
      }
    }
  }

  _appendTimelineProbability(lines, worldLineId) {
    const prob = this.computeProbability(worldLineId);
    lines.push('## Probability');
    lines.push('');
    lines.push('- **Path Probability**: ' + prob.probability.toFixed(6));
    lines.push('- **Path Length**: ' + prob.pathLength);
    lines.push('- **Confidence Interval**: [' + ((prob.confidenceInterval ?? {}).lower ?? 0).toFixed(6) + ', ' + ((prob.confidenceInterval ?? {}).upper ?? 0).toFixed(6) + ']');
  }

  _toPublicWorldLine(wl) {
    return {
      worldLineId: wl.worldLineId,
      name: wl.name,
      initialState: safeAssign({}, wl.initialState),
      currentState: safeAssign({}, wl.currentState),
      parentLineId: wl.parentLineId,
      childrenIds: wl.childrenIds.slice(),
      steps: wl.steps.length,
      depth: wl.depth,
      status: wl.status,
      createdAt: wl.createdAt,
      updatedAt: wl.updatedAt,
    };
  }

  _mergeStates(sourceState, targetState, strategy) {
    if (!sourceState || !targetState) return {};
    const merged = {};
    switch (strategy) {
      case MERGE_STRATEGIES.UNION: {
        safeAssign(merged, sourceState, targetState);
        for (const key of Object.keys(sourceState)) {
          if (targetState[key] !== undefined && Array.isArray(sourceState[key]) && Array.isArray(targetState[key])) {
            merged[key] = sourceState[key].concat(targetState[key]);
          }
        }
        break;
      }
      case MERGE_STRATEGIES.INTERSECTION: {
        for (const key of Object.keys(sourceState)) {
          if (targetState[key] !== undefined) {
            merged[key] = targetState[key];
          }
        }
        break;
      }
      case MERGE_STRATEGIES.WEIGHTED_AVERAGE: {
        const allKeys = new Set([...Object.keys(sourceState), ...Object.keys(targetState)]);
        for (const key of allKeys) {
          const sv = sourceState[key];
          const tv = targetState[key];
          if (typeof sv === 'number' && Number.isFinite(sv) && typeof tv === 'number' && Number.isFinite(tv)) {
            merged[key] = (sv + tv) / 2;
          } else if (tv !== undefined) {
            merged[key] = tv;
          } else {
            merged[key] = sv;
          }
        }
        break;
      }
      case MERGE_STRATEGIES.LATEST_WINS:
      default: {
        safeAssign(merged, sourceState, targetState);
        break;
      }
    }
    return merged;
  }

  _buildBranchTree(wl) {
    const children = [];
    for (const childId of Array.isArray(wl.childrenIds) ? wl.childrenIds : []) {
      const child = this._worldLines.get(childId);
      if (child) {
        children.push(this._buildBranchTree(child));
      }
    }
    return {
      root: this._toPublicWorldLine(wl),
      children,
    };
  }

  _findDivergenceStep(wl1, wl2) {
    const minLen = Math.min(wl1.steps.length, wl2.steps.length);
    for (let i = 0; i < minLen; i++) {
      const s1 = wl1.steps[i];
      const s2 = wl2.steps[i];
      if (s1.action && s2.action && s1.action.name !== s2.action.name) return i;
      try {
        if (JSON.stringify(s1.action.effects) !== JSON.stringify(s2.action.effects)) return i;
      } catch (_e) {
        return i;
      }
    }
    if (wl1.steps.length !== wl2.steps.length) return minLen;
    return null;
  }

  _updateStats() {
    let activeLines = 0;
    let maxDepth = 0;
    let totalChildren = 0;
    let totalSteps = 0;
    const parentCount = new Set();
    for (const wl of this._worldLines.values()) {
      if (wl.status === 'active') activeLines++;
      if (wl.depth > maxDepth) maxDepth = wl.depth;
      totalChildren += wl.childrenIds.length;
      if (wl.childrenIds.length > 0) parentCount.add(wl.worldLineId);
      totalSteps += wl.steps.length;
    }
    this._stats.worldLinesTotal = this._worldLines.size;
    this._stats.activeLines = activeLines;
    this._stats.maxDepth = maxDepth;
    this._stats.avgBranchFactor = parentCount.size > 0 ? totalChildren / parentCount.size : 0;
    this._stats.totalSteps = totalSteps;
  }

  _onShutdown() {
    safeExecute(() => {
      this._worldLines.clear();
    }, 'WorldLineManager', 'shutdown-clear');
    this._stats = { worldLinesTotal: 0, activeLines: 0, maxDepth: 0, avgBranchFactor: 0, totalSteps: 0 };
    this.removeAllListeners();
  }
}

WorldLineManager.MERGE_STRATEGIES = MERGE_STRATEGIES;
WorldLineManager.MAX_WORLD_LINES = MAX_WORLD_LINES;

module.exports = withShutdown(WorldLineManager);
