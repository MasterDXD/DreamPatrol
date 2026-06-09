'use strict';

/**
 * OntologyFeedbackLoop — 本体模型执行反馈闭环
 *
 * 融合 Palantir Ontology "AI Actions" 核心机制：
 * 执行结果实时反馈，形成 "行动→效果→模型优化" 的自循环。
 *
 * 核心能力：
 * - 接收执行结果（成功/失败/部分成功），评估与本体规则的偏差
 * - 自动调整规则阈值（基于执行效果的滑动窗口统计）
 * - 规则效果追踪：记录每条规则的触发次数、通过率、失败模式
 * - 反馈事件驱动：执行结果自动触发规则重评估
 * - 与 BusinessOntologyModel 双向联动
 *
 * @module runtime/infrastructure/ontology-feedback-loop
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedArray = require('../../utils/bounded-array');
const BoundedMap = require('../../utils/bounded-map');
const { debug } = require('../../utils/debug-logger');

// ─── 常量 ───────────────────────────────────────────────────────

const FEEDBACK_STATUS = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  PARTIAL: 'partial',
};

const ADJUSTMENT_TYPES = {
  THRESHOLD_TIGHTEN: 'threshold-tighten',
  THRESHOLD_LOOSEN: 'threshold-loosen',
  RULE_DISABLE: 'rule-disable',
  RULE_ENABLE: 'rule-enable',
  CONDITION_UPDATE: 'condition-update',
};

const DEFAULT_CONFIG = {
  /** 反馈历史容量 */
  historySize: 500,
  /** 规则效果追踪容量 */
  ruleEffectSize: 200,
  /** 滑动窗口大小（最近N次执行） */
  slidingWindowSize: 20,
  /** 自动调整阈值：失败率超过此值时自动调整 */
  autoAdjustFailureRate: 0.7,
  /** 自动调整阈值：成功率超过此值时自动放宽 */
  autoAdjustSuccessRate: 0.95,
  /** 阈值调整步长（百分比） */
  thresholdAdjustStep: 0.1,
  /** 是否启用自动调整 */
  autoAdjustEnabled: true,
};

// ─── 类定义 ─────────────────────────────────────────────────────

class OntologyFeedbackLoop extends EventEmitter {
  /**
   * @param {Object} [config]
   * @param {Object} [ontologyModel] - BusinessOntologyModel 实例
   */
  constructor(config, ontologyModel) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config ?? {});
    this._ontologyModel = ontologyModel || null;

    // 反馈历史
    this._history = new BoundedArray(this._config.historySize);

    // 规则效果追踪：ruleId → { triggers, successes, failures, recentResults, lastAdjusted }
    this._ruleEffects = new BoundedMap(this._config.ruleEffectSize);

    // 统计
    this._stats = {
      feedbackReceived: 0,
      adjustmentsMade: 0,
      adjustmentsByType: {},
      rulesTracked: 0,
    };
  }

  // ─── 公共 API ────────────────────────────────────────────────

  /**
   * 注入 BusinessOntologyModel 实例。
   * @param {Object} model
   */
  attachOntologyModel(model) {
    this.guardShutdown();
    if (!model || typeof model.evaluateRules !== 'function') {
      throw new Error('OntologyFeedbackLoop: ontologyModel must have evaluateRules method');
    }
    this._ontologyModel = model;
    this.emit('ontology-model-attached');
  }

  /**
   * 提交执行反馈。
   * @param {Object} feedback
   * @param {string} feedback.ruleId - 触发的规则ID
   * @param {string} feedback.status - 'success'|'failure'|'partial'
   * @param {Object} [feedback.entityData] - 实体数据
   * @param {string} [feedback.reason] - 失败原因
   * @param {Object} [feedback.context] - 执行上下文
   * @returns {Object} 处理结果
   */
  submitFeedback(feedback) {
    this.guardShutdown();

    if (!feedback || !feedback.ruleId) {
      throw new Error('OntologyFeedbackLoop: feedback.ruleId is required');
    }
    if (!Object.values(FEEDBACK_STATUS).includes(feedback.status)) {
      throw new Error('OntologyFeedbackLoop: feedback.status must be success, failure, or partial');
    }

    this._stats.feedbackReceived++;

    // 记录反馈
    const entry = {
      ruleId: feedback.ruleId,
      status: feedback.status,
      entityData: feedback.entityData || null,
      reason: feedback.reason || '',
      context: feedback.context || null,
      timestamp: Date.now(),
    };
    this._history.push(entry);

    // 更新规则效果追踪
    this._updateRuleEffect(feedback.ruleId, feedback.status);

    // 检查是否需要自动调整
    const adjustment = this._checkAutoAdjust(feedback.ruleId);

    this.emit('feedback-received', {
      ruleId: feedback.ruleId,
      status: feedback.status,
      adjustment: adjustment,
    });

    return { recorded: true, adjustment: adjustment };
  }

  /**
   * 批量提交执行反馈。
   * @param {Array<Object>} feedbacks
   * @returns {Object} 批量处理结果
   */
  submitFeedbackBatch(feedbacks) {
    this.guardShutdown();
    if (!Array.isArray(feedbacks)) {
      throw new Error('OntologyFeedbackLoop: feedbacks must be an array');
    }

    const results = [];
    const adjustments = [];

    for (const fb of feedbacks) {
      const result = this.submitFeedback(fb);
      results.push(result);
      if (result.adjustment) {
        adjustments.push(result.adjustment);
      }
    }

    return { total: feedbacks.length, adjustments: adjustments };
  }

  /**
   * 获取规则效果追踪数据。
   * @param {string} ruleId
   * @returns {Object|null}
   */
  getRuleEffect(ruleId) {
    this.guardShutdown();
    return this._ruleEffects.get(ruleId) || null;
  }

  /**
   * 获取所有规则效果概览。
   * @returns {Array<Object>}
   */
  getRuleEffectOverview() {
    this.guardShutdown();
    const result = [];
    for (const [, effect] of this._ruleEffects) {
      const windowSize = Math.min(effect.recentResults.length, this._config.slidingWindowSize);
      const recentWindow = effect.recentResults.slice(-windowSize);
      const recentSuccesses = recentWindow.filter(function(r) { return r === FEEDBACK_STATUS.SUCCESS; }).length;
      const recentFailures = recentWindow.filter(function(r) { return r === FEEDBACK_STATUS.FAILURE; }).length;

      result.push({
        ruleId: effect.ruleId,
        totalTriggers: effect.triggers,
        totalSuccesses: effect.successes,
        totalFailures: effect.failures,
        recentSuccessRate: windowSize > 0 ? recentSuccesses / windowSize : 0,
        recentFailureRate: windowSize > 0 ? recentFailures / windowSize : 0,
        lastAdjusted: effect.lastAdjusted,
      });
    }
    return result;
  }

  /**
   * 手动触发规则调整。
   * @param {string} ruleId
   * @param {string} adjustmentType - ADJUSTMENT_TYPES 中的值
   * @param {Object} [params] - 调整参数
   * @returns {Object}
   */
  adjustRule(ruleId, adjustmentType, params) {
    this.guardShutdown();

    if (!this._ontologyModel) {
      return { success: false, reason: 'no-ontology-model' };
    }

    const rule = this._ontologyModel.getBusinessRule(ruleId);
    if (!rule) {
      return { success: false, reason: 'rule-not-found' };
    }

    let applied = false;
    const details = {};

    switch (adjustmentType) {
      case ADJUSTMENT_TYPES.THRESHOLD_TIGHTEN:
        applied = this._adjustThreshold(rule, 'tighten', params);
        details.direction = 'tighten';
        break;
      case ADJUSTMENT_TYPES.THRESHOLD_LOOSEN:
        applied = this._adjustThreshold(rule, 'loosen', params);
        details.direction = 'loosen';
        break;
      case ADJUSTMENT_TYPES.RULE_DISABLE:
        applied = this._ontologyModel.toggleBusinessRule(ruleId, false);
        details.disabled = true;
        break;
      case ADJUSTMENT_TYPES.RULE_ENABLE:
        applied = this._ontologyModel.toggleBusinessRule(ruleId, true);
        details.enabled = true;
        break;
      case ADJUSTMENT_TYPES.CONDITION_UPDATE:
        if (params && params.newCondition) {
          applied = this._updateCondition(ruleId, params.newCondition);
          details.newCondition = params.newCondition;
        }
        break;
      default:
        return { success: false, reason: 'unknown-adjustment-type' };
    }

    if (applied) {
      this._stats.adjustmentsMade++;
      this._stats.adjustmentsByType[adjustmentType] = (this._stats.adjustmentsByType[adjustmentType] ?? 0) + 1;

      // 更新规则效果追踪
      const effect = this._ruleEffects.get(ruleId);
      if (effect) {
        effect.lastAdjusted = Date.now();
      }

      this.emit('rule-adjusted', { ruleId: ruleId, adjustmentType: adjustmentType, details: details });
    }

    return { success: applied, adjustmentType: adjustmentType, details: details };
  }

  /**
   * 获取反馈历史。
   * @param {Object} [filter] - {ruleId, status, limit}
   * @returns {Array<Object>}
   */
  getHistory(filter) {
    this.guardShutdown();
    const f = filter ?? {};
    const limit = f.limit || 100;
    const result = [];

    const arr = this._history.toArray();
    for (let i = arr.length - 1; i >= 0 && result.length < limit; i--) {
      const entry = arr[i];
      if (f.ruleId && entry.ruleId !== f.ruleId) continue;
      if (f.status && entry.status !== f.status) continue;
      result.push(entry);
    }

    return result;
  }

  /**
   * 获取统计信息。
   * @returns {Object}
   */
  getStats() {
    return Object.assign({}, this._stats, {
      historySize: this._history.toArray().length,
      rulesTracked: this._ruleEffects.size,
    });
  }

  // ─── 内部方法 ────────────────────────────────────────────────

  /**
   * 更新规则效果追踪。
   * @private
   */
  _updateRuleEffect(ruleId, status) {
    let effect = this._ruleEffects.get(ruleId);
    if (!effect) {
      effect = {
        ruleId: ruleId,
        triggers: 0,
        successes: 0,
        failures: 0,
        recentResults: [],
        lastAdjusted: null,
      };
      this._ruleEffects.set(ruleId, effect);
      this._stats.rulesTracked++;
    }

    effect.triggers++;
    if (status === FEEDBACK_STATUS.SUCCESS) effect.successes++;
    if (status === FEEDBACK_STATUS.FAILURE) effect.failures++;

    // 滑动窗口
    effect.recentResults.push(status);
    if (effect.recentResults.length > this._config.slidingWindowSize) {
      effect.recentResults.shift();
    }
  }

  /**
   * 检查是否需要自动调整规则。
   * @private
   */
  _checkAutoAdjust(ruleId) {
    if (!this._config.autoAdjustEnabled) return null;
    if (!this._ontologyModel) return null;

    const effect = this._ruleEffects.get(ruleId);
    if (!effect || effect.recentResults.length < 5) return null;

    const windowSize = Math.min(effect.recentResults.length, this._config.slidingWindowSize);
    const recentWindow = effect.recentResults.slice(-windowSize);
    const recentSuccesses = recentWindow.filter(function(r) { return r === FEEDBACK_STATUS.SUCCESS; }).length;
    const recentFailures = recentWindow.filter(function(r) { return r === FEEDBACK_STATUS.FAILURE; }).length;

    const failureRate = recentFailures / windowSize;
    const successRate = recentSuccesses / windowSize;

    // 防止频繁调整：至少间隔5次触发
    if (effect.lastAdjusted && (effect.triggers - (effect._lastAdjustedTrigger ?? 0)) < 5) {
      return null;
    }

    // 失败率过高 → 放宽阈值或禁用规则
    if (failureRate >= this._config.autoAdjustFailureRate) {
      const rule = this._ontologyModel.getBusinessRule(ruleId);
      if (!rule) return null;

      // 阈值类规则：放宽阈值
      if (rule.ruleType === 'threshold') {
        const result = this.adjustRule(ruleId, ADJUSTMENT_TYPES.THRESHOLD_LOOSEN);
        if (result.success) {
          effect._lastAdjustedTrigger = effect.triggers;
          return { type: ADJUSTMENT_TYPES.THRESHOLD_LOOSEN, reason: 'high-failure-rate', failureRate: failureRate };
        }
      }

      // 非阈值规则：考虑禁用
      if (failureRate >= 0.9 && rule.ruleType !== 'validation') {
        const result = this.adjustRule(ruleId, ADJUSTMENT_TYPES.RULE_DISABLE);
        if (result.success) {
          effect._lastAdjustedTrigger = effect.triggers;
          return { type: ADJUSTMENT_TYPES.RULE_DISABLE, reason: 'excessive-failure-rate', failureRate: failureRate };
        }
      }
    }

    // 成功率极高 → 收紧阈值以提升标准
    if (successRate >= this._config.autoAdjustSuccessRate && ruleId) {
      const rule = this._ontologyModel.getBusinessRule(ruleId);
      if (rule && rule.ruleType === 'threshold') {
        const result = this.adjustRule(ruleId, ADJUSTMENT_TYPES.THRESHOLD_TIGHTEN);
        if (result.success) {
          effect._lastAdjustedTrigger = effect.triggers;
          return { type: ADJUSTMENT_TYPES.THRESHOLD_TIGHTEN, reason: 'high-success-rate', successRate: successRate };
        }
      }
    }

    return null;
  }

  /**
   * 调整阈值类规则的条件。
   * @private
   */
  _adjustThreshold(rule, direction, params) {
    if (!this._ontologyModel) return false;

    const condition = rule.condition || '';
    // 匹配数值比较条件
    const numMatch = condition.match(/^(\w+)\s*(>|<|>=|<=)\s*(\d+(?:\.\d+)?)$/);
    if (!numMatch) return false;

    const field = numMatch[1];
    const operator = numMatch[2];
    const currentValue = parseFloat(numMatch[3]);
    const step = (params && params.step) || currentValue * this._config.thresholdAdjustStep;

    let newValue;
    if (direction === 'tighten') {
      // 收紧：> 变大，< 变小
      newValue = (operator === '>' || operator === '>=') ? currentValue + step : currentValue - step;
    } else {
      // 放宽：> 变小，< 变大
      newValue = (operator === '>' || operator === '>=') ? currentValue - step : currentValue + step;
    }

    const newCondition = field + ' ' + operator + ' ' + (Number.isInteger(currentValue) ? Math.round(newValue) : parseFloat(newValue.toFixed(4)));

    return this._updateCondition(rule.ruleId, newCondition);
  }

  /**
   * 更新规则条件。
   * @private
   */
  _updateCondition(ruleId, newCondition) {
    if (!this._ontologyModel) return false;

    const rule = this._ontologyModel.getBusinessRule(ruleId);
    if (!rule) return false;

    // 通过 addBusinessRule 更新（版本号自增）
    try {
      this._ontologyModel.addBusinessRule(ruleId, {
        entityType: rule.entityType,
        ruleType: rule.ruleType,
        condition: newCondition,
        action: rule.action,
      }, {
        priority: rule.priority,
        description: rule.description,
        enabled: rule.enabled,
      });
      debug('OntologyFeedbackLoop', 'condition-updated', ruleId, newCondition);
      return true;
    } catch (_e) {
      debug('OntologyFeedbackLoop', 'updateCondition', _e);
      return false;
    }
  }

  // ─── 生命周期 ────────────────────────────────────────────────

  _onShutdown() {
    this._history = null;
    this._ruleEffects = null;
    this._ontologyModel = null;
    this.removeAllListeners();
  }
}

// ─── 导出 ───────────────────────────────────────────────────────

module.exports = {
  OntologyFeedbackLoop: withShutdown(OntologyFeedbackLoop),
  FEEDBACK_STATUS: FEEDBACK_STATUS,
  ADJUSTMENT_TYPES: ADJUSTMENT_TYPES,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
};
