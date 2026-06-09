'use strict';

/**
 * @module runtime/quality/delivery-efficiency-meter
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const RingBuffer = require('../../utils/ring-buffer');
const safeAssign = require('../../utils/safe-assign');

const PHASES = {
  REQUIREMENTS: 'requirements',
  ANALYSIS: 'analysis',
  ARCHITECTURE: 'architecture',
  DEVELOPMENT: 'development',
  TESTING: 'testing',
  DEPLOYMENT: 'deployment',
};

const PHASE_LABELS = {
  requirements: '需求/方案',
  analysis: '需求分析',
  architecture: '架构设计',
  development: '编码开发',
  testing: '测试/改Bug',
  deployment: '部署上线',
};

const DEFAULT_TIME_DISTRIBUTION = {
  requirements: 0.15,
  analysis: 0.15,
  architecture: 0.10,
  development: 0.20,
  testing: 0.25,
  deployment: 0.15,
};

const MAX_CYCLES = 200;

const THROUGHPUT_IMBALANCE_THRESHOLD = 2.0;
const PIPELINE_BOTTLENECK_THRESHOLD = 0.3;
const FEEDBACK_LOOP_MAX_ENTRIES = 500;

/**
 * 交付效率度量器
 * @classdesc 交付效率度量器。6阶段时间分布追踪、管道瓶颈检测
 * 追踪6阶段时间分布、编码占比、AI加速比、审查瓶颈评分，
 * 提供反馈循环时长度量和管道瓶颈检测。
 *
 * @extends EventEmitter
 * @emits DeliveryEfficiencyMeter#cycle-started 新周期开始时触发
 * @emits DeliveryEfficiencyMeter#cycle-ended 周期结束时触发
 */
class DeliveryEfficiencyMeter extends EventEmitter {
  /**
   * 创建DeliveryEfficiencyMeter实例
   *
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.expectedDistribution] - 期望的各阶段时间占比
   * @param {number} [options.maxCycles=200] - 历史周期最大容量
   */
  constructor(options) {
    super();
    this._options = options ?? {};
    this._expectedDistribution = safeAssign({}, DEFAULT_TIME_DISTRIBUTION, (this._options.expectedDistribution) ?? {});
    this._cycles = new RingBuffer(this._options.maxCycles ?? MAX_CYCLES);
    this._activeCycle = null;
    this._feedbackLoopEntries = [];
  }

  /**
   * 开始新的交付周期。若已有活跃周期则自动结束旧周期。
   *
   * @param {Object} [cycleInfo] - 周期信息
   * @param {string} [cycleInfo.id] - 周期ID
   * @returns {string} 周期ID
   */
  startCycle(cycleInfo) {
    this.guardShutdown();
    if (this._activeCycle) {
      this.endCycle({ outcome: 'superseded' });
    }
    this._activeCycle = {
      id: cycleInfo?.id ?? ('cycle-' + Date.now()),
      phases: {},
      startedAt: Date.now(),
      endedAt: null,
      outcome: null,
      reworkCount: 0,
      reviewCycles: 0,
      aiAssistedPhases: new Set(),
      codeGenerationCount: 0,
      codeGenerationTimeMs: 0,
      reviewCount: 0,
      reviewTimeMs: 0,
      feedbackLoopStart: null,
      feedbackLoopDurations: [],
    };
    this.emit('cycle-started', { id: this._activeCycle.id, startedAt: this._activeCycle.startedAt });
    return this._activeCycle.id;
  }

  /**
   * 记录指定阶段的耗时。
   *
   * @param {string} phase - 阶段名称（PHASES枚举值）
   * @param {number} durationMs - 阶段耗时（毫秒）
   * @param {Object} [meta] - 附加元信息
   * @param {boolean} [meta.aiAssisted=false] - 是否AI辅助
   * @param {boolean} [meta.rework=false] - 是否为返工
   * @returns {boolean|null} 记录成功返回true，无活跃周期或无效阶段返回null
   */
  recordPhaseTime(phase, durationMs, meta) {
    this.guardShutdown();
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
    if (!this._activeCycle) return null;
    if (!Object.values(PHASES).includes(phase)) return null;
    this._activeCycle.phases[phase] = {
      durationMs,
      recordedAt: Date.now(),
      aiAssisted: (meta && meta.aiAssisted) ?? false,
      rework: (meta && meta.rework) ?? false,
    };
    if (meta && meta.aiAssisted) {
      this._activeCycle.aiAssistedPhases.add(phase);
    }
    if (meta && meta.rework) {
      this._activeCycle.reworkCount++;
    }
    return true;
  }

  /**
   * 记录一次审查循环。递增当前活跃周期的审查循环计数。
   *
   * @param {Object} [_meta] - 附加元信息（预留）
   * @returns {boolean|null} 记录成功返回true，无活跃周期返回null
   */
  recordReviewCycle(_meta) {
    this.guardShutdown();
    if (!this._activeCycle) return null;
    this._activeCycle.reviewCycles++;
    return true;
  }

  /**
   * 记录一次代码生成事件。累加代码生成次数和耗时，
   * 若AI辅助则标记开发阶段为AI辅助。
   *
   * @param {number} durationMs - 代码生成耗时（毫秒）
   * @param {Object} [meta] - 附加元信息
   * @param {boolean} [meta.aiAssisted=false] - 是否AI辅助生成
   * @returns {boolean|null} 记录成功返回true，无活跃周期返回null
   */
  recordCodeGeneration(durationMs, meta) {
    this.guardShutdown();
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
    if (!this._activeCycle) return null;
    this._activeCycle.codeGenerationCount++;
    this._activeCycle.codeGenerationTimeMs += (durationMs ?? 0);
    if (meta && meta.aiAssisted) {
      this._activeCycle.aiAssistedPhases.add(PHASES.DEVELOPMENT);
    }
    return true;
  }

  /**
   * 记录一次审查完成事件。累加审查次数和审查耗时。
   *
   * @param {number} durationMs - 审查耗时（毫秒）
   * @returns {boolean|null} 记录成功返回true，无活跃周期返回null
   */
  recordReviewCompletion(durationMs) {
    this.guardShutdown();
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
    if (!this._activeCycle) return null;
    this._activeCycle.reviewCount++;
    this._activeCycle.reviewTimeMs += (durationMs ?? 0);
    return true;
  }

  /**
   * 开始一个反馈循环计时。记录当前时间戳作为反馈循环起点。
   *
   * @returns {boolean|null} 开始成功返回true，无活跃周期返回null
   */
  startFeedbackLoop() {
    this.guardShutdown();
    if (!this._activeCycle) return null;
    this._activeCycle.feedbackLoopStart = Date.now();
    return true;
  }

  /**
   * 结束当前反馈循环计时。计算反馈循环耗时并记录到历史条目中，
   * 超过最大条目数时淘汰最早条目。
   *
   * @returns {number|null} 反馈循环耗时（毫秒），无活跃周期或未开始返回null
   */
  endFeedbackLoop() {
    this.guardShutdown();
    if (!this._activeCycle || !this._activeCycle.feedbackLoopStart) return null;
    const duration = Date.now() - this._activeCycle.feedbackLoopStart;
    if (this._activeCycle.feedbackLoopDurations.length < 200) {
      this._activeCycle.feedbackLoopDurations.push(duration);
    }
    this._feedbackLoopEntries.push({
      cycleId: this._activeCycle.id,
      durationMs: duration,
      timestamp: Date.now(),
    });
    if (this._feedbackLoopEntries.length > FEEDBACK_LOOP_MAX_ENTRIES) {
      this._feedbackLoopEntries.shift();
    }
    this._activeCycle.feedbackLoopStart = null;
    return duration;
  }

  /**
   * 结束当前活跃周期。将周期数据推入历史缓冲区并触发cycle-ended事件。
   *
   * @param {Object} [cycleResult] - 周期结果
   * @param {string} [cycleResult.outcome='completed'] - 周期结果状态
   * @returns {Object|null} 已结束的周期对象，无活跃周期返回null
   */
  endCycle(cycleResult) {
    this.guardShutdown();
    if (!this._activeCycle) return null;
    this._activeCycle.endedAt = Date.now();
    this._activeCycle.outcome = (cycleResult && cycleResult.outcome) ?? 'completed';
    const cycle = { ...this._activeCycle, aiAssistedPhases: [...(this._activeCycle.aiAssistedPhases ?? [])] };
    this._cycles.push(cycle);
    this._activeCycle = null;
    this.emit('cycle-ended', cycle);
    return cycle;
  }

  /**
   * 获取所有历史周期的各阶段时间占比分布。无历史数据时返回期望分布。
   *
   * @returns {Object.<string, number>} 各阶段时间占比映射，键为阶段名，值为0-1之间的小数
   */
  getTimeDistribution() {
    const cycles = this._cycles.toArray();
    if (cycles.length === 0) return { ...this._expectedDistribution };
    const totals = {};
    for (const phase of Object.values(PHASES)) totals[phase] = 0;
    for (const cycle of cycles) {
      for (const [phase, data] of Object.entries(cycle.phases ?? {})) {
        const ms = (typeof data.durationMs === 'number' && Number.isFinite(data.durationMs)) ? data.durationMs : 0; totals[phase] = (totals[phase] ?? 0) + ms;
      }
    }
    const totalMs = Object.values(totals).reduce((s, v) => s + v, 0);
    if (totalMs === 0) return { ...this._expectedDistribution };
    const dist = {};
    for (const [phase, ms] of Object.entries(totals)) {
      dist[phase] = ms / totalMs;
    }
    return dist;
  }

  /**
   * 计算实际时间分布与期望分布的总偏差。值为各阶段绝对偏差之和。
   *
   * @returns {number} 总偏差值，保留三位小数
   */
  getDistributionDeviation() {
    const actual = this.getTimeDistribution();
    let totalDeviation = 0;
    for (const phase of Object.values(PHASES)) {
      const expected = this._expectedDistribution[phase] ?? 0;
      const actualVal = actual[phase] ?? 0;
      totalDeviation += Math.abs(actualVal - expected);
    }
    return Math.round(totalDeviation * 1000) / 1000;
  }

  /**
   * 获取编码开发阶段的时间占比。
   *
   * @returns {number} 编码占比（0-1之间），无数据时默认0.2
   */
  getCodingRatio() {
    const dist = this.getTimeDistribution();
    return dist[PHASES.DEVELOPMENT] ?? 0.2;
  }

  /**
   * 计算AI加速比——AI辅助阶段耗时占总耗时的比例。
   *
   * @returns {number} AI加速比（0-1之间），无数据时返回0
   */
  getAiAccelerationRatio() {
    const cycles = this._cycles.toArray();
    if (cycles.length === 0) return 0;
    let aiTime = 0;
    let totalTime = 0;
    for (const cycle of cycles) {
      for (const [_phase, data] of Object.entries(cycle.phases ?? {})) {
        const ms2 = (typeof data.durationMs === 'number' && Number.isFinite(data.durationMs)) ? data.durationMs : 0; totalTime += ms2; if (data.aiAssisted) aiTime += ms2;
      }
    }
    return totalTime > 0 ? aiTime / totalTime : 0;
  }

  /**
   * 计算审查瓶颈评分。综合审查循环频率和返工比例，值域0-1，
   * 越高表示审查瓶颈越严重。
   *
   * @returns {number} 审查瓶颈评分（0-1之间），无数据时返回0
   */
  getReviewBottleneckScore() {
    const cycles = this._cycles.toArray();
    if (cycles.length === 0) return 0;
    let totalReviewCycles = 0;
    let totalDevTime = 0;
    let totalReworkTime = 0;
    for (const cycle of cycles) {
      totalReviewCycles += cycle.reviewCycles;
      for (const [phase, data] of Object.entries(cycle.phases ?? {})) {
        const ms3 = (typeof data.durationMs === 'number' && Number.isFinite(data.durationMs)) ? data.durationMs : 0; if (phase === PHASES.DEVELOPMENT) totalDevTime += ms3; if (data.rework) totalReworkTime += ms3;
      }
    }
    if (totalDevTime === 0) return 0;
    const reviewRatio = totalReviewCycles / Math.max(1, cycles.length);
    const reworkRatio = totalReworkTime / totalDevTime;
    return Math.min(1, reviewRatio * 0.5 + reworkRatio * 0.5);
  }

  /**
   * 计算代码生成与审查的吞吐量失衡指标。比较每分钟代码生成速率与审查速率，
   * 返回失衡比率、严重等级和各自速率。
   *
   * @returns {{ratio: number, level: string, codeGenRate: number, reviewRate: number}} 吞吐量失衡结果
   */
  getReviewThroughputImbalance() {
    const cycles = this._cycles.toArray();
    if (cycles.length === 0) return { ratio: 0, level: 'none', codeGenRate: 0, reviewRate: 0 };
    let totalCodeGenCount = 0;
    let totalCodeGenTime = 0;
    let totalReviewCount = 0;
    let totalReviewTime = 0;
    for (const cycle of cycles) {
      totalCodeGenCount += (cycle.codeGenerationCount ?? 0);
      totalCodeGenTime += (cycle.codeGenerationTimeMs ?? 0);
      totalReviewCount += (cycle.reviewCount ?? 0);
      totalReviewTime += (cycle.reviewTimeMs ?? 0);
    }
    const codeGenRate = totalCodeGenTime > 0 ? totalCodeGenCount / (totalCodeGenTime / 60000) : 0;
    const reviewRate = totalReviewTime > 0 ? totalReviewCount / (totalReviewTime / 60000) : 0;
    if (reviewRate === 0) {
      return { ratio: codeGenRate > 0 ? 1e6 : 0, level: codeGenRate > 0 ? 'critical' : 'none', codeGenRate, reviewRate };
    }
    const ratio = codeGenRate / reviewRate;
    let level;
    if (ratio >= THROUGHPUT_IMBALANCE_THRESHOLD * 2) level = 'critical';
    else if (ratio >= THROUGHPUT_IMBALANCE_THRESHOLD) level = 'high';
    else if (ratio >= THROUGHPUT_IMBALANCE_THRESHOLD * 0.5) level = 'moderate';
    else level = 'balanced';
    return { ratio: Math.round(ratio * 100) / 100, level, codeGenRate: Math.round(codeGenRate * 100) / 100, reviewRate: Math.round(reviewRate * 100) / 100 };
  }

  /**
   * 检测管道瓶颈。找出实际时间占比超出期望占比超过阈值的阶段，
   * 按超出幅度降序排列。
   *
   * @returns {{hasBottleneck: boolean, primary: Object|null, allBottlenecks: Object[], bottleneckCount: number}} 管道瓶颈检测结果
   */
  getPipelineBottleneck() {
    const dist = this.getTimeDistribution();
    const expected = this._expectedDistribution;
    const bottlenecks = [];
    for (const phase of Object.values(PHASES)) {
      const actual = dist[phase] ?? 0;
      const expectedRatio = expected[phase] ?? 0;
      const overrun = actual - expectedRatio;
      if (overrun > PIPELINE_BOTTLENECK_THRESHOLD) {
        bottlenecks.push({
          phase,
          label: PHASE_LABELS[phase] || phase,
          actualRatio: Math.round(actual * 1000) / 1000,
          expectedRatio: Math.round(expectedRatio * 1000) / 1000,
          overrun: Math.round(overrun * 1000) / 1000,
        });
      }
    }
    bottlenecks.sort((a, b) => (b.overrun ?? 0) - (a.overrun ?? 0));
    const primary = bottlenecks.length > 0 ? bottlenecks[0] : null;
    return {
      hasBottleneck: bottlenecks.length > 0,
      primary,
      allBottlenecks: bottlenecks,
      bottleneckCount: bottlenecks.length,
    };
  }

  /**
   * 获取反馈循环时长的统计信息，包括平均值、最小值、最大值和趋势。
   * 趋势基于前后半段平均值的比较判定。
   *
   * @returns {{avgMs: number, minMs: number, maxMs: number, count: number, trend: string}} 反馈循环时长统计
   */
  getFeedbackLoopDuration() {
    const entries = this._feedbackLoopEntries;
    if (entries.length === 0) return { avgMs: 0, minMs: 0, maxMs: 0, count: 0, trend: 'none' };
    const durations = entries.map(e => e.durationMs);
    const safeDurations = durations.filter(v => Number.isFinite(v));
    const avgMs = safeDurations.length > 0
      ? safeDurations.reduce((s, d) => s + d, 0) / safeDurations.length
      : 0;
    const minMs = safeDurations.length > 0 ? Math.min(...safeDurations) : 0;
    const maxMs = safeDurations.length > 0 ? Math.max(...safeDurations) : 0;
    let trend = 'stable';
    if (entries.length >= 4) {
      const half = Math.floor(entries.length / 2);
      const firstHalfAvg = half > 0 ? entries.slice(0, half).reduce((s, e) => s + (Number.isFinite(e.durationMs) ? e.durationMs : 0), 0) / half : 0;
      const secondHalfAvg = (entries.length - half) > 0 ? entries.slice(half).reduce((s, e) => s + (Number.isFinite(e.durationMs) ? e.durationMs : 0), 0) / (entries.length - half) : 0;
      if (secondHalfAvg > firstHalfAvg * 1.2) trend = 'increasing';
      else if (secondHalfAvg < firstHalfAvg * 0.8) trend = 'decreasing';
    }
    return {
      avgMs: Math.round(avgMs),
      minMs,
      maxMs,
      count: entries.length,
      trend,
    };
  }

  /**
   * 获取综合效率指标，聚合所有度量维度：周期统计、编码占比、AI加速比、
   * 审查瓶颈、分布偏差、吞吐量失衡、管道瓶颈和反馈循环时长。
   *
   * @returns {Object} 综合效率指标对象
   */
  getEfficiencyMetrics() {
    const cycles = this._cycles.toArray();
    const completedCycles = cycles.filter(c => c.outcome === 'completed');
    const avgCycleTime = completedCycles.length > 0
      ? completedCycles.reduce((s, c) => { const duration = (typeof c.endedAt === 'number' && Number.isFinite(c.endedAt) && typeof c.startedAt === 'number' && Number.isFinite(c.startedAt)) ? (c.endedAt - c.startedAt) : 0; return s + duration; }, 0) / completedCycles.length
      : 0;
    const avgReworkCount = completedCycles.length > 0
      ? completedCycles.reduce((s, c) => s + (typeof c.reworkCount === 'number' && Number.isFinite(c.reworkCount) ? c.reworkCount : 0), 0) / completedCycles.length
      : 0;
    const avgReviewCycles = completedCycles.length > 0
      ? completedCycles.reduce((s, c) => s + (typeof c.reviewCycles === 'number' && Number.isFinite(c.reviewCycles) ? c.reviewCycles : 0), 0) / completedCycles.length
      : 0;
    return {
      totalCycles: cycles.length,
      completedCycles: completedCycles.length,
      avgCycleTimeMs: avgCycleTime,
      avgReworkCount: Math.round(avgReworkCount * 100) / 100,
      avgReviewCycles: Math.round(avgReviewCycles * 100) / 100,
      codingRatio: this.getCodingRatio(),
      aiAccelerationRatio: this.getAiAccelerationRatio(),
      reviewBottleneckScore: this.getReviewBottleneckScore(),
      distributionDeviation: this.getDistributionDeviation(),
      reviewThroughputImbalance: this.getReviewThroughputImbalance(),
      pipelineBottleneck: this.getPipelineBottleneck(),
      feedbackLoopDuration: this.getFeedbackLoopDuration(),
    };
  }

  /**
   * 获取各阶段的详细分解，包含实际占比、期望占比和偏差值。
   *
   * @returns {Array.<{phase: string, label: string, actualRatio: number, expectedRatio: number, deviation: number}>} 阶段分解列表
   */
  getPhaseBreakdown() {
    const dist = this.getTimeDistribution();
    const breakdown = [];
    for (const [phase, label] of Object.entries(PHASE_LABELS)) {
      breakdown.push({
        phase,
        label,
        actualRatio: dist[phase] ?? 0,
        expectedRatio: this._expectedDistribution[phase] ?? 0,
        deviation: Math.abs((dist[phase] ?? 0) - (this._expectedDistribution[phase] ?? 0)),
      });
    }
    return breakdown;
  }

  _onShutdown() {
    this._activeCycle = null;
    this._cycles = new RingBuffer(this._options.maxCycles ?? MAX_CYCLES);
    this._feedbackLoopEntries = [];
    this.removeAllListeners();
  }
}

DeliveryEfficiencyMeter.PHASES = PHASES;
DeliveryEfficiencyMeter.PHASE_LABELS = PHASE_LABELS;
DeliveryEfficiencyMeter.DEFAULT_TIME_DISTRIBUTION = DEFAULT_TIME_DISTRIBUTION;
DeliveryEfficiencyMeter.THROUGHPUT_IMBALANCE_THRESHOLD = THROUGHPUT_IMBALANCE_THRESHOLD;
DeliveryEfficiencyMeter.PIPELINE_BOTTLENECK_THRESHOLD = PIPELINE_BOTTLENECK_THRESHOLD;

module.exports = withShutdown(DeliveryEfficiencyMeter);
