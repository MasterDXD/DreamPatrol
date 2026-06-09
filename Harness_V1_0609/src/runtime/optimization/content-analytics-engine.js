'use strict';

const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const EventEmitter = require('events');

/**
 * @module runtime/optimization/content-analytics-engine
 * 内容特征与指标关联引擎 — 自动将内容分解为特征向量，
 * 并将特征与平台互动指标关联，发现哪些内容特征驱动表现。
 *
 * 核心能力：
 * - 内容特征分解（将内容分解为视觉冲击力、叙事结构、角色存在等特征向量）
 * - 特征-指标关联（将内容特征与互动指标关联存储）
 * - 模式发现（发现哪些特征与高性能关联）
 * - 假设生成（从发现的模式中生成优化假设）
 */

/** @constant {Object} DEFAULT_OPTIONS - 默认配置 */
const DEFAULT_OPTIONS = {
  maxFeatureVectors: 500,
  maxCorrelations: 1000,
  maxPatterns: 200,
  researchJournal: null,
};

/** @constant {Object} LENGTH_THRESHOLDS - 内容长度分类阈值 */
const LENGTH_THRESHOLDS = {
  SHORT: 500,
  MEDIUM: 2000,
};

/** @constant {Object} CTA_PHRASES - 行动号召短语 */
const CTA_PHRASES = [
  'click here', 'subscribe', 'sign up', 'get started', 'try now',
  'download', 'learn more', 'join us', 'buy now', 'register',
  '点击', '订阅', '注册', '立即', '下载', '加入', '购买',
];

/** @constant {Object} TONE_PATTERNS - 语调模式 */
const TONE_PATTERNS = {
  professional: /\b(therefore|consequently|furthermore|accordingly|thus|hence|professionals?|industry|enterprise|corporate)\b/i,
  inspirational: /\b(inspire|dream|believe|achieve|imagine|possible|empower|transform|breakthrough|unstoppable)\b/i,
  educational: /\b(learn|tutorial|guide|explain|understand|step[- ]by[- ]step|how[- ]to|lesson|teach|concept)\b/i,
};

/**
 * @classdesc 内容特征与指标关联引擎。自动将内容分解为特征向量，
 * 并将特征与平台互动指标关联，发现驱动内容表现的关键特征。
 *
 * @extends EventEmitter
 * @emits 'content-analytics:content-decomposed' 当内容分解完成时触发
 * @emits 'content-analytics:correlation-recorded' 当关联记录时触发
 * @emits 'content-analytics:patterns-discovered' 当模式发现时触发
 * @emits 'content-analytics:hypotheses-generated' 当假设生成时触发
 */
class ContentAnalyticsEngine extends EventEmitter {
  /**
   * 创建内容分析引擎实例
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxFeatureVectors=500] - 最大特征向量数
   * @param {number} [options.maxCorrelations=1000] - 最大关联记录数
   * @param {number} [options.maxPatterns=200] - 最大模式数
   * @param {Object} [options.researchJournal] - 研究日志实例
   */
  constructor(options) {
    super();
    this._options = Object.assign({}, DEFAULT_OPTIONS, options ?? {});
    this._featureVectors = new BoundedMap(this._options.maxFeatureVectors);
    this._correlations = new BoundedArray(this._options.maxCorrelations);
    this._patterns = new BoundedArray(this._options.maxPatterns);
    this._auditLog = new BoundedArray(500);
    this._researchJournal = this._options.researchJournal || null;
    this._stats = {
      contentsDecomposed: 0,
      correlationsRecorded: 0,
      patternsDiscovered: 0,
      hypothesesGenerated: 0,
    };
    this._shutDown = false;
  }

  /**
   * 将内容分解为特征向量
   * @param {Object} contentData - 内容数据
   * @param {string} contentData.contentId - 内容ID
   * @param {string} contentData.contentType - 内容类型
   * @param {string} contentData.title - 标题
   * @param {string} contentData.body - 正文
   * @param {Object} [contentData.metadata] - 元数据
   * @returns {{ contentId: string, features: Object, decomposedAt: string }} 特征向量
   * @emits 'content-analytics:content-decomposed'
   */
  decomposeContent(contentData) {
    this.guardShutdown();
    if (!contentData || typeof contentData !== 'object') {
      throw new Error('ContentAnalyticsEngine: contentData must be a non-null object');
    }
    if (!contentData.contentId || typeof contentData.contentId !== 'string') {
      throw new Error('ContentAnalyticsEngine: contentData.contentId must be a non-empty string');
    }
    const { contentId, contentType, title: _title, body, metadata } = contentData;
    const features = {
      visualImpactScore: this._scoreVisualImpact(metadata),
      narrativeStructure: this._detectNarrativeStructure(body),
      characterPresence: this._detectCharacterPresence(body),
      codePresence: this._detectCodePresence(body),
      ctaStrength: this._scoreCTA(body),
      lengthCategory: this._categorizeLength(body),
      toneCategory: this._categorizeTone(body),
    };
    features.contentType = contentType || 'unknown';
    const result = {
      contentId,
      features,
      decomposedAt: new Date().toISOString(),
    };
    this._featureVectors.set(contentId, result);
    this._stats.contentsDecomposed++;
    this._audit('decompose-content', { contentId, contentType });
    this.emit('content-analytics:content-decomposed', result);
    return result;
  }

  /**
   * 将内容特征与表现指标关联
   * @param {string} contentId - 内容ID
   * @param {Object} metrics - 表现指标
   * @param {number} [metrics.views] - 浏览量
   * @param {number} [metrics.engagement] - 互动量
   * @param {number} [metrics.clickRate] - 点击率
   * @param {number} [metrics.conversion] - 转化率
   * @param {number} [metrics.completionRate] - 完成率
   * @returns {{ contentId: string, features: Object, metrics: Object, correlatedAt: string }|null} 关联记录
   * @emits 'content-analytics:correlation-recorded'
   */
  correlateWithMetrics(contentId, metrics) {
    this.guardShutdown();
    if (!contentId || typeof contentId !== 'string') {
      throw new Error('ContentAnalyticsEngine: contentId must be a non-empty string');
    }
    if (!metrics || typeof metrics !== 'object') {
      throw new Error('ContentAnalyticsEngine: metrics must be a non-null object');
    }
    const vector = this._featureVectors.get(contentId);
    if (!vector) {
      return null;
    }
    const correlation = {
      contentId,
      features: vector.features,
      metrics,
      correlatedAt: new Date().toISOString(),
    };
    this._correlations.push(correlation);
    this._stats.correlationsRecorded++;
    this._audit('correlate-metrics', { contentId });
    this.emit('content-analytics:correlation-recorded', correlation);
    return correlation;
  }

  /**
   * 发现哪些特征与高性能关联
   * @param {number} [minSampleSize=3] - 最小样本量
   * @returns {{ patterns: Array, analyzedAt: string }} 发现的模式
   * @emits 'content-analytics:patterns-discovered'
   */
  discoverPatterns(minSampleSize) {
    this.guardShutdown();
    if (minSampleSize !== undefined && (typeof minSampleSize !== 'number' || minSampleSize < 0)) {
      throw new Error('ContentAnalyticsEngine: minSampleSize must be a non-negative number');
    }
    const minSample = minSampleSize ?? 3;
    const correlations = this._correlations.slice();
    if (correlations.length === 0) {
      const empty = { patterns: [], analyzedAt: new Date().toISOString() };
      this.emit('content-analytics:patterns-discovered', empty);
      return empty;
    }

    // Calculate overall average metrics
    const overallAvg = this._calculateOverallAverage(correlations);

    // Group by feature values
    const featureKeys = [
      'visualImpactScore', 'narrativeStructure', 'characterPresence',
      'codePresence', 'ctaStrength', 'lengthCategory', 'toneCategory',
    ];
    const patterns = [];

    for (const feature of featureKeys) {
      const groups = {};
      for (const corr of correlations) {
        const val = corr.features[feature];
        const key = String(val);
        if (!groups[key]) {
          groups[key] = [];
        }
        groups[key].push(corr);
      }

      for (const [value, group] of Object.entries(groups)) {
        if (group.length < minSample) {
          continue;
        }
        const groupAvg = this._calculateGroupAverage(group);
        const improvement = this._calculateImprovement(groupAvg, overallAvg);
        if (improvement > 10) {
          patterns.push({
            feature,
            value,
            avgMetricImprovement: Math.round(improvement * 100) / 100,
            sampleSize: group.length,
            confidence: Math.min(group.length / 20, 1),
          });
        }
      }
    }

    // Sort by improvement descending
    patterns.sort((a, b) => b.avgMetricImprovement - a.avgMetricImprovement);

    // Store discovered patterns
    for (const p of patterns) {
      this._patterns.push(p);
    }

    this._stats.patternsDiscovered += patterns.length;
    const result = { patterns, analyzedAt: new Date().toISOString() };
    this._audit('discover-patterns', { patternCount: patterns.length });
    this.emit('content-analytics:patterns-discovered', result);
    return result;
  }

  /**
   * 从发现的模式中生成优化假设
   * @returns {{ hypotheses: Array }} 生成的假设
   * @emits 'content-analytics:hypotheses-generated'
   */
  generateHypotheses() {
    this.guardShutdown();
    const patterns = this._patterns.slice();
    if (patterns.length === 0) {
      const empty = { hypotheses: [] };
      this.emit('content-analytics:hypotheses-generated', empty);
      return empty;
    }

    const hypotheses = [];
    const seen = new Set();

    for (const pattern of patterns) {
      const key = `${pattern.feature}=${pattern.value}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const hypothesis = this._patternToHypothesis(pattern);
      hypotheses.push(hypothesis);
    }

    this._stats.hypothesesGenerated += hypotheses.length;
    const result = { hypotheses };
    this._audit('generate-hypotheses', { count: hypotheses.length });
    this.emit('content-analytics:hypotheses-generated', result);
    return result;
  }

  /**
   * 获取存储的特征向量
   * @param {string} contentId - 内容ID
   * @returns {Object|undefined} 特征向量
   */
  getFeatureVector(contentId) {
    this.guardShutdown();
    if (!contentId || typeof contentId !== 'string') {
      throw new Error('ContentAnalyticsEngine: contentId must be a non-empty string');
    }
    return this._featureVectors.get(contentId);
  }

  /**
   * 获取存储的关联记录
   * @param {Object} [filter] - 过滤条件
   * @param {string} [filter.contentType] - 内容类型过滤
   * @param {number} [filter.minEngagement] - 最低互动量
   * @returns {Array} 关联记录
   */
  getCorrelations(filter) {
    this.guardShutdown();
    const correlations = this._correlations.slice();
    if (!filter) {
      return correlations;
    }
    return correlations.filter((c) => {
      if (filter.contentType && c.features.contentType !== filter.contentType) {
        return false;
      }
      if (filter.minEngagement != null &&
          (c.metrics.engagement == null || c.metrics.engagement < filter.minEngagement)) {
        return false;
      }
      return true;
    });
  }

  /**
   * 获取引擎统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    this.guardShutdown();
    return {
      contentsDecomposed: this._stats.contentsDecomposed,
      correlationsRecorded: this._stats.correlationsRecorded,
      patternsDiscovered: this._stats.patternsDiscovered,
      hypothesesGenerated: this._stats.hypothesesGenerated,
      featureVectorCount: this._featureVectors.size,
      correlationCount: this._correlations.length,
      patternCount: this._patterns.length,
    };
  }

  // --- Private methods ---

  /**
   * 评分视觉冲击力
   * @param {Object} [metadata] - 元数据
   * @returns {number} 0-10分
   * @private
   */
  _scoreVisualImpact(metadata) {
    if (!metadata) {
      return 0;
    }
    let score = 0;
    if (metadata.images) {
      score += Math.min(metadata.images * 2, 4);
    }
    if (metadata.videos) {
      score += Math.min(metadata.videos * 3, 6);
    }
    if (metadata.animations) {
      score += Math.min(metadata.animations * 2, 4);
    }
    if (metadata.infographics) {
      score += 3;
    }
    if (metadata.hasVisuals) {
      score += 2;
    }
    return Math.min(Math.round(score), 10);
  }

  /**
   * 检测叙事结构
   * @param {string} body - 正文
   * @returns {string} 叙事结构类型
   * @private
   */
  _detectNarrativeStructure(body) {
    if (!body) {
      return 'linear';
    }
    const lower = body.toLowerCase();
    const listicleMatch = lower.match(/^\d+[\.\)]|^\*|\n\d+[\.\)]|\n\*/m);
    if (listicleMatch && (lower.match(/\n\d+[\.\)]/g) ?? []).length >= 3) {
      return 'listicle';
    }
    if (/step\s+\d+|step[- ]by[- ]step|first.*then.*finally|首先.*然后.*最后/i.test(body)) {
      return 'tutorial';
    }
    if (/vs\.|versus|compared\s+to|对比|比较|相比/i.test(body)) {
      return 'comparison';
    }
    if (/once upon|story|protagonist|chapter|故事|主角|从前/i.test(body)) {
      return 'story';
    }
    return 'linear';
  }

  /**
   * 检测角色/个人故事存在
   * @param {string} body - 正文
   * @returns {boolean} 是否包含角色元素
   * @private
   */
  _detectCharacterPresence(body) {
    if (!body) {
      return false;
    }
    return /\b(I|we|my|our|me|us)\b/i.test(body) ||
      /\b(he|she|they|his|her|their)\b/i.test(body) ||
      /我|我们|他|她|他们/i.test(body);
  }

  /**
   * 检测代码块存在
   * @param {string} body - 正文
   * @returns {boolean} 是否包含代码块
   * @private
   */
  _detectCodePresence(body) {
    if (!body) {
      return false;
    }
    return /```[\s\S]*?```/.test(body) ||
      /`[^`]+`/.test(body) ||
      /^\s{4,}\S/m.test(body);
  }

  /**
   * 评分行动号召力度
   * @param {string} body - 正文
   * @returns {number} 0-10分
   * @private
   */
  _scoreCTA(body) {
    if (!body) {
      return 0;
    }
    const lower = body.toLowerCase();
    let count = 0;
    for (const phrase of CTA_PHRASES) {
      if (lower.includes(phrase)) {
        count++;
      }
    }
    return Math.min(Math.round(count * 2.5), 10);
  }

  /**
   * 分类内容长度
   * @param {string} body - 正文
   * @returns {string} 长度类别
   * @private
   */
  _categorizeLength(body) {
    if (!body) {
      return 'short';
    }
    const len = body.length;
    if (len < LENGTH_THRESHOLDS.SHORT) {
      return 'short';
    }
    if (len < LENGTH_THRESHOLDS.MEDIUM) {
      return 'medium';
    }
    return 'long';
  }

  /**
   * 分类内容语调
   * @param {string} body - 正文
   * @returns {string} 语调类别
   * @private
   */
  _categorizeTone(body) {
    if (!body) {
      return 'casual';
    }
    let bestTone = 'casual';
    let bestScore = 0;
    for (const [tone, regex] of Object.entries(TONE_PATTERNS)) {
      const matches = body.match(regex);
      const score = matches ? matches.length : 0;
      if (score > bestScore) {
        bestScore = score;
        bestTone = tone;
      }
    }
    return bestTone;
  }

  /**
   * 记录审计日志
   * @param {string} action - 操作
   * @param {Object} details - 详情
   * @private
   */
  _audit(action, details) {
    this._auditLog.push({
      action,
      details,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 计算整体平均指标
   * @param {Array} correlations - 关联记录
   * @returns {Object} 平均指标
   * @private
   */
  _calculateOverallAverage(correlations) {
    const metricKeys = ['views', 'engagement', 'clickRate', 'conversion', 'completionRate'];
    const sums = {};
    const counts = {};
    for (const key of metricKeys) {
      sums[key] = 0;
      counts[key] = 0;
    }
    for (const corr of correlations) {
      for (const key of metricKeys) {
        if (corr.metrics[key] != null) {
          sums[key] += corr.metrics[key];
          counts[key]++;
        }
      }
    }
    const avg = {};
    for (const key of metricKeys) {
      avg[key] = counts[key] > 0 ? sums[key] / counts[key] : 0;
    }
    return avg;
  }

  /**
   * 计算分组平均指标
   * @param {Array} group - 分组关联记录
   * @returns {Object} 平均指标
   * @private
   */
  _calculateGroupAverage(group) {
    return this._calculateOverallAverage(group);
  }

  /**
   * 计算改善百分比
   * @param {Object} groupAvg - 分组平均
   * @param {Object} overallAvg - 整体平均
   * @returns {number} 改善百分比
   * @private
   */
  _calculateImprovement(groupAvg, overallAvg) {
    let totalImprovement = 0;
    let metricCount = 0;
    for (const key of Object.keys(groupAvg)) {
      if (overallAvg[key] > 0) {
        const imp = ((groupAvg[key] - overallAvg[key]) / overallAvg[key]) * 100;
        totalImprovement += imp;
        metricCount++;
      }
    }
    return metricCount > 0 ? totalImprovement / metricCount : 0;
  }

  /**
   * 将模式转换为假设
   * @param {Object} pattern - 模式
   * @returns {Object|null} 假设
   * @private
   */
  _patternToHypothesis(pattern) {
    const { feature, value, avgMetricImprovement, confidence } = pattern;
    const featureLabels = {
      visualImpactScore: 'visual impact',
      narrativeStructure: 'narrative structure',
      characterPresence: 'character presence',
      codePresence: 'code examples',
      ctaStrength: 'call-to-action strength',
      lengthCategory: 'content length',
      toneCategory: 'tone',
    };
    const label = featureLabels[feature] || feature;
    const improvementMultiplier = Math.round((1 + avgMetricImprovement / 100) * 10) / 10;
    const hypothesis = `Content with ${label} "${value}" achieves ${improvementMultiplier}x performance`;
    return {
      hypothesis,
      supportingFeatures: [{ feature, value }],
      expectedImprovement: avgMetricImprovement,
      confidence,
    };
  }

  /**
   * 优雅关闭
   * @private
   */
  _onShutdown() {
    this.removeAllListeners();
    try { this._featureVectors.shutdown(); } catch (_) { debug('ContentAnalyticsEngine', '_onShutdown:featureVectors', _ && _.message ? _.message : String(_)); }
    try { this._correlations.shutdown(); } catch (_) { debug('ContentAnalyticsEngine', '_onShutdown:correlations', _ && _.message ? _.message : String(_)); }
    try { this._patterns.shutdown(); } catch (_) { debug('ContentAnalyticsEngine', '_onShutdown:patterns', _ && _.message ? _.message : String(_)); }
    try { this._auditLog.shutdown(); } catch (_) { debug('ContentAnalyticsEngine', '_onShutdown:auditLog', _ && _.message ? _.message : String(_)); }
    this._featureVectors = null;
    this._correlations = null;
    this._patterns = null;
    this._auditLog = null;
    // _researchJournal is externally managed — do not shutdown here
    this._researchJournal = null;
  }
}

module.exports = withShutdown(ContentAnalyticsEngine);
