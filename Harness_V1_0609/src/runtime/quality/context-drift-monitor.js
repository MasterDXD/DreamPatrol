'use strict';

/**
 * @module runtime/quality/context-drift-monitor
 * @classdesc 上下文漂移监控器（ContextDriftMonitor）—— 检测长任务执行过程中的上下文漂移。
 * 通过注册约束条件并定期检查当前上下文是否偏离原始约束，按5级严重度分类（none/low/medium/high/critical）。
 * 支持否定约束识别（no/not/never等否定词）、模糊匹配和漂移趋势追踪（worsening/stable/improving）。
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug: _debug } = require('../../utils/debug-logger');
const { shortId } = require('../../utils/unique-id');

const DRIFT_LEVELS = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

const DRIFT_THRESHOLD_LOW = 0.2;
const DRIFT_THRESHOLD_MEDIUM = 0.4;
const DRIFT_THRESHOLD_HIGH = 0.6;
const DRIFT_THRESHOLD_CRITICAL = 0.8;

const MAX_SNAPSHOTS = 100;
const MAX_CONSTRAINTS = 200;
const DEFAULT_CHECK_INTERVAL_MS = 60000;

class ContextDriftMonitor extends EventEmitter {
  /**
   * 创建ContextDriftMonitor实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.lowThreshold=0.2] - 低漂移阈值
   * @param {number} [options.mediumThreshold=0.4] - 中漂移阈值
   * @param {number} [options.highThreshold=0.6] - 高漂移阈值
   * @param {number} [options.criticalThreshold=0.8] - 严重漂移阈值
   * @param {number} [options.checkIntervalMs=60000] - 周期性检查间隔（毫秒）
   */
  constructor(options) {
    super();
    // 防止无监听器时 error 事件导致进程崩溃
    this.on('error', function(_err) {
      // 仅记录，不传播 — 外部可通过 on('error') 覆盖此行为
    });
    this._options = options ?? {};
    this._thresholds = {
      low: this._options.lowThreshold ?? DRIFT_THRESHOLD_LOW,
      medium: this._options.mediumThreshold ?? DRIFT_THRESHOLD_MEDIUM,
      high: this._options.highThreshold ?? DRIFT_THRESHOLD_HIGH,
      critical: this._options.criticalThreshold ?? DRIFT_THRESHOLD_CRITICAL,
    };
    this._checkIntervalMs = this._options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this._snapshots = [];
    this._activeConstraints = new Map();
    this._currentTaskId = null;
    this._checkTimer = null;
    this._stats = {
      snapshotsTaken: 0,
      driftsDetected: 0,
      constraintsRegistered: 0,
      constraintsLost: 0,
      highestDriftScore: 0,
    };
  }

  /**
   * 注册约束条件。当约束数量超过上限时自动淘汰最早注册的约束。
   * @param {Object} constraint - 约束定义
   * @param {string} [constraint.id] - 约束唯一标识（自动生成如果未提供）
   * @param {string} [constraint.text] - 约束文本描述
   * @param {string} [constraint.category='general'] - 约束分类
   * @param {string} [constraint.priority='medium'] - 优先级（critical/high/medium/low）
   * @param {string} [constraint.source='unknown'] - 约束来源
   * @returns {Object|null} 注册成功的约束条目，参数无效时返回null
   */
  registerConstraint(constraint) {
    this.guardShutdown();
    if (!constraint || typeof constraint !== 'object') return null;
    const id = constraint.id || shortId('con-');
    const entry = {
      id,
      text: constraint.text || constraint.description || '',
      category: constraint.category || 'general',
      priority: constraint.priority || 'medium',
      source: constraint.source || 'unknown',
      registeredAt: Date.now(),
      lastCheckedAt: null,
      violated: false,
      violationCount: 0,
    };
    if (this._activeConstraints.size >= MAX_CONSTRAINTS) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, val] of this._activeConstraints) {
        if (val.registeredAt < oldestTime) {
          oldestTime = val.registeredAt;
          oldestKey = key;
        }
      }
      if (oldestKey) this._activeConstraints.delete(oldestKey);
    }
    this._activeConstraints.set(id, entry);
    this._stats.constraintsRegistered++;
    return entry;
  }

  /**
   * 批量注册约束条件。
   * @param {Array<Object>} constraints - 约束定义数组
   * @returns {Array<Object>} 成功注册的约束数组
   */
  registerConstraints(constraints) {
    if (!Array.isArray(constraints)) return [];
    return constraints.map(c => this.registerConstraint(c)).filter(Boolean);
  }

  /**
   * 移除已注册的约束条件
   * @param {string} id - 约束条件唯一标识
   * @returns {boolean} 是否成功移除，约束不存在时返回false
   */
  removeConstraint(id) {
    this.guardShutdown();
    return this._activeConstraints.delete(id);
  }

  /**
   * 开始任务监控，注册初始约束并启动周期性检查。
   * @param {string} [taskId] - 任务ID（自动生成如果未提供）
   * @param {Array<Object>} [initialConstraints] - 初始约束条件数组
   * @returns {string} 任务ID
   */
  startTask(taskId, initialConstraints) {
    this.guardShutdown();
    this.stopTask();
    this._currentTaskId = taskId || ('task-' + Date.now());
    this._activeConstraints.clear();
    if (Array.isArray(initialConstraints)) {
      this.registerConstraints(initialConstraints);
    }
    this._takeSnapshot('task-start');
    this._startPeriodicCheck();
    this.emit('task-started', { taskId: this._currentTaskId, constraintCount: this._activeConstraints.size });
    return this._currentTaskId;
  }

  /**
   * 停止任务监控，清除周期性检查定时器。
   */
  stopTask() {
    this.guardShutdown();
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
    if (this._currentTaskId) {
      this._takeSnapshot('task-end');
      this.emit('task-stopped', { taskId: this._currentTaskId });
    }
    this._currentTaskId = null;
  }

  /**
   * 检查当前上下文是否偏离已注册的约束条件，计算漂移分数和严重级别。
   * @param {string|Object} [currentContext] - 当前上下文（字符串或可序列化对象）
   * @returns {{driftScore: number, level: string, violatedConstraints: Array, lostConstraints: Array, totalConstraints: number, taskId: string}} 漂移检测结果
   */
  checkDrift(currentContext) {
    this.guardShutdown();
    if (this._activeConstraints.size === 0) {
      return { driftScore: 0, level: DRIFT_LEVELS.NONE, violatedConstraints: [], lostConstraints: [], totalConstraints: 0 };
    }
    const contextLower = (currentContext || '').toLowerCase();
    const contextText = typeof currentContext === 'string' ? contextLower : JSON.stringify(currentContext || '').toLowerCase();
    const violatedConstraints = [];
    const lostConstraints = [];
    let driftScore = 0;

    for (const [_id, constraint] of this._activeConstraints) {
      constraint.lastCheckedAt = Date.now();
      const constraintText = constraint.text.toLowerCase();
      if (!constraintText) continue;

      const isPresent = contextText.includes(constraintText) || this._fuzzyConstraintMatch(constraintText, contextText);
      if (!isPresent) {
        constraint.violated = true;
        constraint.violationCount++;
        const priorityWeight = { critical: 1.0, high: 0.8, medium: 0.5, low: 0.3 }[constraint.priority] ?? 0.5;
        driftScore += priorityWeight;
        if (constraint.violationCount >= 3) {
          lostConstraints.push(constraint);
        } else {
          violatedConstraints.push(constraint);
        }
      } else {
        constraint.violated = false;
      }
    }

    const totalConstraints = this._activeConstraints.size;
    driftScore = totalConstraints > 0 ? Math.min(1, driftScore / totalConstraints) : 0;

    const level = this._classifyDrift(driftScore);
    this._stats.driftsDetected += violatedConstraints.length + lostConstraints.length;
    this._stats.constraintsLost += lostConstraints.length;
    if (driftScore > this._stats.highestDriftScore) {
      this._stats.highestDriftScore = driftScore;
    }

    const result = {
      driftScore: Math.round(driftScore * 1000) / 1000,
      level,
      violatedConstraints,
      lostConstraints,
      totalConstraints,
      taskId: this._currentTaskId,
    };

    if (level !== DRIFT_LEVELS.NONE) {
      this.emit('drift-detected', result);
    }

    return result;
  }

  _fuzzyConstraintMatch(constraintText, contextText) {
    const negationWords = new Set(['no', 'not', 'never', 'without', 'must-not', "don't", 'dont', 'cannot', 'cant', "can't", 'avoid', 'forbidden', 'prohibited']);
    const words = constraintText.split(/[\s,;.]+/).filter(w => w.length > 1);
    if (words.length === 0) return false;
    const hasNegation = words.some(w => negationWords.has(w.toLowerCase()));
    if (hasNegation) {
      return contextText.includes(constraintText.toLowerCase());
    }
    const significantWords = words.filter(w => w.length > 3);
    if (significantWords.length === 0) return contextText.includes(constraintText.toLowerCase());
    let matchCount = 0;
    for (const word of significantWords) {
      if (contextText.includes(word.toLowerCase())) matchCount++;
    }
    return matchCount / significantWords.length >= 0.7;
  }

  _classifyDrift(score) {
    if (score >= this._thresholds.critical) return DRIFT_LEVELS.CRITICAL;
    if (score >= this._thresholds.high) return DRIFT_LEVELS.HIGH;
    if (score >= this._thresholds.medium) return DRIFT_LEVELS.MEDIUM;
    if (score >= this._thresholds.low) return DRIFT_LEVELS.LOW;
    return DRIFT_LEVELS.NONE;
  }

  _takeSnapshot(reason) {
    const constraints = [];
    for (const [, c] of this._activeConstraints) {
      constraints.push({ ...c });
    }
    const snapshot = {
      taskId: this._currentTaskId,
      reason,
      constraintCount: constraints.length,
      violatedCount: constraints.filter(c => c.violated).length,
      timestamp: Date.now(),
      constraints,
    };
    if (this._snapshots.length >= MAX_SNAPSHOTS) {
      this._snapshots.shift();
    }
    this._snapshots.push(snapshot);
    this._stats.snapshotsTaken++;
    this.emit('snapshot-taken', snapshot);
    return snapshot;
  }

  _startPeriodicCheck() {
    if (this._checkTimer) clearInterval(this._checkTimer);
    this._checkTimer = setInterval(() => {
      if (this._shutDown) return;
      try {
        if (this._currentTaskId) {
          this._takeSnapshot('periodic');
        }
      } catch (_err) {
        this.emit('error', _err);
      }
    }, this._checkIntervalMs);
    if (this._checkTimer && typeof this._checkTimer.unref === 'function') {
      this._checkTimer.unref();
    }
  }

  /**
   * 获取漂移历史快照。
   * @returns {Array<Object>} 快照数组
   */
  getDriftHistory() {
    return this._snapshots.slice();
  }

  /**
   * 获取当前活跃的约束条件列表。
   * @returns {Array<Object>} 约束条件数组（深拷贝）
   */
  getActiveConstraints() {
    const result = [];
    for (const [, c] of this._activeConstraints) {
      result.push({ ...c });
    }
    return result;
  }

  /**
   * 获取漂移趋势分析（基于最近5个快照的违规比率变化）。
   * @returns {{trend: string, snapshots: number, recentViolationRatio?: number}} 趋势结果（trend: worsening/stable/improving/insufficient-data）
   */
  getDriftTrend() {
    if (this._snapshots.length < 2) return { trend: 'insufficient-data', snapshots: this._snapshots.length };
    const recent = this._snapshots.slice(-5);
    const violationRatios = recent.map(s => s.constraintCount > 0 ? s.violatedCount / s.constraintCount : 0);
    if (violationRatios.length < 2) return { trend: 'stable', snapshots: this._snapshots.length };
    const firstHalf = violationRatios.slice(0, Math.floor(violationRatios.length / 2));
    const secondHalf = violationRatios.slice(Math.floor(violationRatios.length / 2));
    const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
    let trend;
    if (secondAvg > firstAvg * 1.3) trend = 'worsening';
    else if (secondAvg < firstAvg * 0.7) trend = 'improving';
    else trend = 'stable';
    return { trend, snapshots: this._snapshots.length, recentViolationRatio: Math.round(secondAvg * 1000) / 1000 };
  }

  /**
   * 获取统计信息。
   * @returns {{snapshotsTaken: number, driftsDetected: number, constraintsRegistered: number, constraintsLost: number, highestDriftScore: number, activeConstraints: number, currentTaskId: string|null, snapshotCount: number, driftTrend: string}} 统计数据
   */
  getStats() {
    return {
      ...this._stats,
      activeConstraints: this._activeConstraints.size,
      currentTaskId: this._currentTaskId,
      snapshotCount: this._snapshots.length,
      driftTrend: this.getDriftTrend().trend,
    };
  }

  _onShutdown() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
    this._currentTaskId = null;
    this._activeConstraints.clear();
    this._snapshots = [];
    this.removeAllListeners();
  }
}

ContextDriftMonitor.DRIFT_LEVELS = DRIFT_LEVELS;
ContextDriftMonitor.MAX_SNAPSHOTS = MAX_SNAPSHOTS;
ContextDriftMonitor.MAX_CONSTRAINTS = MAX_CONSTRAINTS;

module.exports = withShutdown(ContextDriftMonitor);
