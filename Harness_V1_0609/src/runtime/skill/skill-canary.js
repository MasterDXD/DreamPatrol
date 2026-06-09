'use strict';

const { EventEmitter } = require('events');
const debug = require('../../utils/debug-logger')('SkillCanary');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { shortId } = require('../../utils/unique-id');

const MAX_CANARIES = 50;
const MAX_LATENCIES = 100;
const MAX_ACTIVATION_CANARIES = 100;
const MAX_ACTIVATIONS_PER_CANARY = 50;
const DEFAULT_MIN_SAMPLES = 20;
const DEFAULT_SUCCESS_RATE_THRESHOLD = 0.8;
const DEFAULT_LATENCY_MULTIPLIER = 1.5;
const DEFAULT_WARMUP_SAMPLES = 10;
const MAX_EVAL_FAILURES = 3;

const PHASE_INITIALIZING = 'initializing';
const PHASE_WARMING = 'warming';
const PHASE_EVALUATING = 'evaluating';
const PHASE_PROMOTED = 'promoted';
const PHASE_ROLLED_BACK = 'rolled_back';

/**
 * @module runtime/skill/skill-canary
 * SkillCanary — 技能金丝雀追踪模块
 * 新技能或变更技能按比例放量发布，收集成功率与延迟指标，自动评估并决定全量晋升或回滚。
 * 支持流量百分比控制、P50/P95延迟计算、定时自动评估，以及容量限制保护。
 * @classdesc 技能金丝雀追踪。灰度发布、按比例放量、自动晋升/回滚、成功率与延迟评估。
 * @extends EventEmitter
 * @emits SkillCanary#canary-enabled
 * @emits SkillCanary#canary-disabled
 * @emits SkillCanary#canary-activated
 * @emits SkillCanary#canary-promoted
 * @emits SkillCanary#canary-rolled-back
 * @emits SkillCanary#canary-evaluation-passed
 * @emits SkillCanary#canary-evaluation-failed
 */
class SkillCanary extends EventEmitter {
  constructor() {
    super();
    this._canaries = new Map();
    this._autoEvalIntervalId = null;
    this._activationCanaries = null;
  }

  _onShutdown() {
    this.stopAutoEvaluation();
    this._canaries.clear();
    if (this._activationCanaries) {
      this._activationCanaries.clear();
      this._activationCanaries = null;
    }
    this.removeAllListeners();
  }

  /**
   * 为技能启用金丝雀模式
   * @param {string} skillId - 技能ID
   * @param {Object} [options] - 金丝雀配置选项
   * @param {number} [options.trafficPercent=10] - 流量百分比（0-100）
   * @param {number} [options.minSamples=20] - 最小样本数
   * @param {number} [options.successRateThreshold=0.8] - 成功率阈值
   * @param {number} [options.latencyMultiplier=1.5] - 延迟倍数阈值
   * @param {number} [options.warmupSamples=10] - 预热样本数
   * @param {Object} [options.baseline] - 基线指标
   * @param {number} [options.baseline.successRate=1] - 基线成功率
   * @param {number} [options.baseline.avgLatency=0] - 基线平均延迟
   * @returns {boolean} 是否成功启用
   */
  enableCanary(skillId, options) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return false;
    if (this._canaries.has(skillId)) return false;

    if (this._canaries.size >= MAX_CANARIES) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, value] of this._canaries) {
        if (value.enabledAt < oldestTime) {
          oldestTime = value.enabledAt;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.disableCanary(oldestKey);
      }
    }

    const opts = options ?? {};
    const config = {
      minSamples: opts.minSamples ?? DEFAULT_MIN_SAMPLES,
      successRateThreshold: opts.successRateThreshold ?? DEFAULT_SUCCESS_RATE_THRESHOLD,
      latencyMultiplier: opts.latencyMultiplier ?? DEFAULT_LATENCY_MULTIPLIER,
      warmupSamples: opts.warmupSamples ?? DEFAULT_WARMUP_SAMPLES,
    };

    const baseline = {
      successRate: typeof (opts.baseline && opts.baseline.successRate) === 'number' && Number.isFinite(opts.baseline.successRate) ? opts.baseline.successRate : 1,
      avgLatency: typeof (opts.baseline && opts.baseline.avgLatency) === 'number' && Number.isFinite(opts.baseline.avgLatency) ? opts.baseline.avgLatency : 0,
    };

    const canary = {
      enabled: true,
      trafficPercent: opts.trafficPercent ?? 10,
      phase: PHASE_INITIALIZING,
      baseline,
      metrics: {
        successes: 0,
        failures: 0,
        totalLatency: 0,
        latencies: [],
      },
      config,
      enabledAt: Date.now(),
      lastEvaluatedAt: 0,
      evalFailures: 0,
    };

    this._canaries.set(skillId, canary);
    this.emit('canary-enabled', { skillId, trafficPercent: canary.trafficPercent });
    debug('enableCanary', skillId);
    return true;
  }

  /**
   * 禁用金丝雀模式
   * @param {string} skillId - 技能ID
   * @returns {boolean} 是否成功禁用
   */
  disableCanary(skillId) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return false;
    const canary = this._canaries.get(skillId);
    if (!canary) return false;

    canary.enabled = false;
    this._canaries.delete(skillId);
    this.emit('canary-disabled', { skillId });
    debug('disableCanary', skillId);
    return true;
  }

  /**
   * 查询技能是否启用金丝雀模式
   * @param {string} skillId - 技能ID
   * @returns {boolean} 是否启用
   */
  isCanaryEnabled(skillId) {
    const canary = this._canaries.get(skillId);
    return canary ? canary.enabled : false;
  }

  /**
   * 判断当前请求是否应激活金丝雀版本（基于流量百分比）
   * @param {string} skillId - 技能ID
   * @returns {boolean} 是否激活金丝雀版本
   */
  shouldActivate(skillId) {
    const canary = this._canaries.get(skillId);
    if (!canary || !canary.enabled) return false;

    const activated = Math.random() * 100 < canary.trafficPercent;
    this.emit('canary-activated', { skillId, activated });
    return activated;
  }

  /**
   * 金丝雀通过验证，全量发布
   * @param {string} skillId - 技能ID
   * @returns {boolean} 是否成功晋升
   */
  promote(skillId) {
    this.guardShutdown();
    const canary = this._canaries.get(skillId);
    if (!canary || !canary.enabled) return false;

    canary.phase = PHASE_PROMOTED;
    canary.enabled = false;
    this.emit('canary-promoted', { skillId });
    debug('promote', skillId);
    return true;
  }

  /**
   * 金丝雀验证失败，回滚
   * @param {string} skillId - 技能ID
   * @returns {boolean} 是否成功回滚
   */
  rollback(skillId) {
    this.guardShutdown();
    const canary = this._canaries.get(skillId);
    if (!canary || !canary.enabled) return false;

    canary.phase = PHASE_ROLLED_BACK;
    canary.enabled = false;
    this.emit('canary-rolled-back', { skillId });
    debug('rollback', skillId);
    return true;
  }

  /**
   * 记录金丝雀执行结果
   * @param {string} skillId - 技能ID
   * @param {Object} result - 执行结果
   * @param {boolean} [result.success] - 是否成功
   * @param {number} [result.latency] - 执行延迟（毫秒）
   * @returns {void}
   */
  recordResult(skillId, result) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return;
    const canary = this._canaries.get(skillId);
    if (!canary || !canary.enabled) return;

    const res = result ?? {};
    if (res.success) {
      canary.metrics.successes++;
    } else {
      canary.metrics.failures++;
    }

    if (typeof res.latency === 'number' && Number.isFinite(res.latency) && res.latency >= 0) {
      canary.metrics.totalLatency += res.latency;
      canary.metrics.latencies.push(res.latency);
      if (canary.metrics.latencies.length > MAX_LATENCIES) {
        canary.metrics.latencies.shift();
      }
    }

    const totalSamples = canary.metrics.successes + canary.metrics.failures;
    if (canary.phase === PHASE_INITIALIZING && totalSamples >= canary.config.warmupSamples) {
      canary.phase = PHASE_WARMING;
    }
    if (canary.phase === PHASE_WARMING && totalSamples >= canary.config.minSamples) {
      canary.phase = PHASE_EVALUATING;
    }
  }

  /**
   * 获取金丝雀指标
   * @param {string} skillId - 技能ID
   * @returns {{ successRate: number, avgLatency: number, sampleCount: number, p50Latency: number|null, p95Latency: number|null }|null} 金丝雀指标，不存在时返回null
   */
  getCanaryMetrics(skillId) {
    const canary = this._canaries.get(skillId);
    if (!canary) return null;

    const totalSamples = canary.metrics.successes + canary.metrics.failures;
    const successRate = totalSamples > 0 ? canary.metrics.successes / totalSamples : 0;
    const avgLatency = totalSamples > 0 ? canary.metrics.totalLatency / totalSamples : 0;

    return {
      successRate,
      avgLatency,
      sampleCount: totalSamples,
      p50Latency: this._percentile(canary.metrics.latencies, 50),
      p95Latency: this._percentile(canary.metrics.latencies, 95),
    };
  }

  /**
   * 获取金丝雀状态
   * @param {string} skillId - 技能ID
   * @returns {{ phase: string, enabled: boolean, trafficPercent: number, enabledAt: number, lastEvaluatedAt: number, evalFailures: number }|null} 金丝雀状态，不存在时返回null
   */
  getCanaryStatus(skillId) {
    const canary = this._canaries.get(skillId);
    if (!canary) return null;

    return {
      phase: canary.phase,
      enabled: canary.enabled,
      trafficPercent: canary.trafficPercent,
      enabledAt: canary.enabledAt,
      lastEvaluatedAt: canary.lastEvaluatedAt,
      evalFailures: canary.evalFailures,
    };
  }

  /**
   * 评估金丝雀是否通过（成功率>=基线且延迟<=基线*1.5）
   * @param {string} skillId - 技能ID
   * @returns {{ passed: boolean, reason: string, metrics: Object }|null} 评估结果，不存在时返回null
   */
  evaluateCanary(skillId) {
    this.guardShutdown();
    const canary = this._canaries.get(skillId);
    if (!canary) return null;

    canary.lastEvaluatedAt = Date.now();

    const totalSamples = canary.metrics.successes + canary.metrics.failures;
    if (totalSamples < canary.config.minSamples) {
      return {
        passed: false,
        reason: 'Insufficient samples: ' + totalSamples + '/' + canary.config.minSamples,
        metrics: this.getCanaryMetrics(skillId),
      };
    }

    const successRate = totalSamples > 0 ? canary.metrics.successes / totalSamples : 0;
    const avgLatency = totalSamples > 0 ? canary.metrics.totalLatency / totalSamples : 0;

    const successRateOk = successRate >= canary.config.successRateThreshold;
    const latencyOk = canary.baseline.avgLatency === 0 || avgLatency <= canary.baseline.avgLatency * canary.config.latencyMultiplier;

    const passed = successRateOk && latencyOk;

    if (passed) {
      canary.evalFailures = 0;
      this.emit('canary-evaluation-passed', { skillId, successRate, avgLatency });
    } else {
      canary.evalFailures++;
      const reasons = [];
      if (!successRateOk) reasons.push('successRate ' + successRate.toFixed(3) + ' < threshold ' + canary.config.successRateThreshold);
      if (!latencyOk) reasons.push('avgLatency ' + avgLatency.toFixed(1) + ' > baseline*multiplier ' + (canary.baseline.avgLatency * canary.config.latencyMultiplier).toFixed(1));
      this.emit('canary-evaluation-failed', { skillId, reasons, successRate, avgLatency });
    }

    return {
      passed,
      reason: passed ? 'All criteria met' : 'Criteria not met',
      metrics: this.getCanaryMetrics(skillId),
    };
  }

  /**
   * 启动定时自动评估所有活跃金丝雀
   * @param {number} interval - 评估间隔（毫秒）
   * @returns {void}
   */
  startAutoEvaluation(interval) {
    if (this._autoEvalIntervalId) return;
    if (!interval || interval <= 0) return;

    this._autoEvalIntervalId = setInterval(() => {
      if (this._shutDown) return;
      safeExecute(() => {
        this._runAutoEvaluation();
      }, 'SkillCanary', 'autoEval');
    }, interval);

    if (this._autoEvalIntervalId && typeof this._autoEvalIntervalId.unref === 'function') {
      this._autoEvalIntervalId.unref();
    }
  }

  /**
   * 停止自动评估
   * @returns {void}
   */
  stopAutoEvaluation() {
    if (this._autoEvalIntervalId) {
      clearInterval(this._autoEvalIntervalId);
      this._autoEvalIntervalId = null;
    }
  }

  _runAutoEvaluation() {
    if (this._shutDown) return;
    for (const [skillId, canary] of this._canaries) {
      if (!canary.enabled) continue;
      if (canary.phase !== PHASE_EVALUATING) continue;

      const result = this.evaluateCanary(skillId);
      if (!result) continue;

      if (result.passed) {
        this.promote(skillId);
      } else if (canary.evalFailures >= MAX_EVAL_FAILURES) {
        this.rollback(skillId);
      }
    }
  }

  /**
   * Inject a canary token into a skill definition for activation tracking
   * @param {string} skillId - Skill to inject canary into
   * @param {object} options - {tokenPrefix: string, trackActivation: boolean}
   * @returns {{tokenId: string, injectedAt: string}}
   */
  injectActivationCanary(skillId, options = {}) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return { tokenId: '', injectedAt: '' };
    const tokenPrefix = options.tokenPrefix || 'CANARY';
    const tokenId = `${tokenPrefix}-${skillId}-${shortId()}`;

    // Store canary token mapping
    if (!this._activationCanaries) {
      this._activationCanaries = new Map();
    }

    if (this._activationCanaries.size >= MAX_ACTIVATION_CANARIES) {
      const firstKey = this._activationCanaries.keys().next().value;
      this._activationCanaries.delete(firstKey);
    }

    this._activationCanaries.set(tokenId, {
      skillId,
      injectedAt: new Date().toISOString(),
      activations: [],
      trackActivation: options.trackActivation !== false,
    });

    return { tokenId, injectedAt: new Date().toISOString() };
  }

  /**
   * Check if a canary token was activated (found in skill execution output)
   * @param {string} tokenId - Canary token to check
   * @returns {{activated: boolean, activationCount: number, lastActivation: string|null}}
   */
  checkActivationCanary(tokenId) {
    this.guardShutdown();
    if (!tokenId || typeof tokenId !== 'string') return { activated: false, activationCount: 0, lastActivation: null };
    const canary = this._activationCanaries?.get(tokenId);
    if (!canary) return { activated: false, activationCount: 0, lastActivation: null };

    return {
      activated: canary.activations.length > 0,
      activationCount: canary.activations.length,
      lastActivation: canary.activations.length > 0
        ? canary.activations[canary.activations.length - 1]
        : null,
    };
  }

  /**
   * Record a canary activation event
   * @param {string} tokenId - Canary token that was activated
   */
  recordCanaryActivation(tokenId) {
    this.guardShutdown();
    if (!tokenId || typeof tokenId !== 'string') return;
    const canary = this._activationCanaries?.get(tokenId);
    if (canary) {
      if (canary.activations.length >= MAX_ACTIVATIONS_PER_CANARY) {
        canary.activations.shift();
      }
      canary.activations.push(new Date().toISOString());
    }
  }

  /**
   * 计算延迟百分位数
   * @param {number[]} latencies - 延迟数组
   * @param {number} percentile - 百分位数（0-100）
   * @returns {number|null} 百分位延迟值，无数据时返回null
   * @private
   */
  _percentile(latencies, percentile) {
    if (!latencies || latencies.length === 0) return null;
    const sorted = latencies.slice().sort(function(a, b) { return a - b; });
    const index = Math.ceil(percentile / 100 * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * 检查实例是否健康（未关闭且无评估失败超过3次的金丝雀）
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    if (this._shutDown) return false;
    for (const canary of this._canaries.values()) {
      if (canary.evalFailures >= MAX_EVAL_FAILURES) return false;
    }
    return true;
  }
}

SkillCanary.MAX_CANARIES = MAX_CANARIES;
SkillCanary.MAX_LATENCIES = MAX_LATENCIES;
SkillCanary.PHASE_INITIALIZING = PHASE_INITIALIZING;
SkillCanary.PHASE_WARMING = PHASE_WARMING;
SkillCanary.PHASE_EVALUATING = PHASE_EVALUATING;
SkillCanary.PHASE_PROMOTED = PHASE_PROMOTED;
SkillCanary.PHASE_ROLLED_BACK = PHASE_ROLLED_BACK;

module.exports = withShutdown(SkillCanary);
