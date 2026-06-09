'use strict';

const { EventEmitter } = require('events');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { safeExecute } = require('../../utils/safe-execute');

const DEFAULT_CONFIG = {
  maxPatterns: 200,
  minSampleSize: 5,
  significanceThreshold: 0.15,
  patternCategories: ['structure', 'specificity', 'examples', 'constraints', 'context'],
};

/**
 * @module runtime/prompt/prompt-pattern-extractor
 * @classdesc 提示词模式提取器（PromptPatternExtractor）。从执行历史提取prompt→result模式，
 * 推荐prompt injections，模式频率统计与效果评分，与PromptBuilder集成自动注入高效模式。
 * @extends EventEmitter
 * @emits PromptPatternExtractor#pattern-discovered
 * @emits PromptPatternExtractor#pattern-updated
 */
class PromptPatternExtractor extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxPatterns=200] - 最大模式数量
   * @param {number} [options.minSampleSize=5] - 模式显著性的最小样本量
   * @param {number} [options.significanceThreshold=0.15] - 模式显著性的最小效应量
   * @param {string[]} [options.patternCategories] - 模式分类列表
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    this._executionRecords = new BoundedArray(5000);
    this._patterns = new BoundedMap(this._config.maxPatterns);
    this._stats = { recorded: 0, patternsFound: 0, injectionsRecommended: 0 };
  }

  /**
   * 记录一次提示词执行的结果
   * @param {Object} promptStructure - 提示词结构描述
   * @param {boolean} [promptStructure.has_examples=false] - 是否包含示例
   * @param {boolean} [promptStructure.has_constraints=false] - 是否包含约束
   * @param {string} [promptStructure.specificity_level='medium'] - 具体性级别 (low/medium/high)
   * @param {string} [promptStructure.context_richness='medium'] - 上下文丰富度 (low/medium/high)
   * @param {string} [promptStructure.structure_type='freeform'] - 结构类型 (freeform/structured/template)
   * @param {string} [promptStructure.task_type='general'] - 任务类型
   * @param {Object} result - 执行结果
   * @param {number} [result.quality_score=0] - 质量评分 (0-1)
   * @param {boolean} [result.success=false] - 是否成功
   * @returns {void}
   */
  recordExecution(promptStructure, result) {
    this.guardShutdown();
    if (!promptStructure || !result) return;

    const record = {
      has_examples: promptStructure.has_examples ?? false,
      has_constraints: promptStructure.has_constraints ?? false,
      specificity_level: promptStructure.specificity_level || 'medium',
      context_richness: promptStructure.context_richness || 'medium',
      structure_type: promptStructure.structure_type || 'freeform',
      task_type: promptStructure.task_type || 'general',
      quality_score: typeof result.quality_score === 'number' && Number.isFinite(result.quality_score)
        ? Math.max(0, Math.min(1, result.quality_score))
        : 0,
      success: result.success ?? false,
      timestamp: Date.now(),
    };

    this._executionRecords.push(record);
    this._stats.recorded++;

    this._updatePatternsForRecord(record);
  }

  /**
   * 分析累积记录并提取显著模式
   * @returns {Array<{id: string, category: string, description: string, sampleSize: number, successRate: number, baselineRate: number, effectSize: number, significant: boolean}>} 显著模式列表
   */
  extractPatterns() {
    this.guardShutdown();
    const records = this._executionRecords.toArray();
    if (records.length < this._config.minSampleSize) return [];

    const totalSuccess = records.filter(function(r) { return r.success; }).length;
    const baselineRate = totalSuccess / records.length;

    const candidates = this._generatePatternCandidates(records);
    const significant = [];

    for (const candidate of candidates) {
      const pattern = this._evaluateCandidate(candidate, records, baselineRate);
      if (pattern && pattern.significant) {
        const existing = this._patterns.get(pattern.id);
        if (existing) {
          this._patterns.set(pattern.id, pattern);
          this.emit('pattern-updated', { patternId: pattern.id, sampleSize: pattern.sampleSize });
        } else {
          this._patterns.set(pattern.id, pattern);
          this._stats.patternsFound++;
          this.emit('pattern-discovered', { patternId: pattern.id, category: pattern.category });
        }
        significant.push(pattern);
      }
    }

    return significant;
  }

  /**
   * 根据已学习模式为给定任务类型推荐提示词注入策略
   * @param {string} [taskType='general'] - 任务类型
   * @returns {{injections: Array<{category: string, recommendation: string, confidence: number, evidence: string}>, taskType: string}} 推荐注入列表
   */
  getRecommendedInjections(taskType) {
    this.guardShutdown();
    const type = taskType || 'general';
    const injections = [];

    this._patterns.forEach(function(pattern) {
      if (pattern.task_type !== type && pattern.task_type !== 'general') return;
      if (!pattern.significant) return;

      const recommendation = this._buildRecommendation(pattern);
      if (recommendation) {
        injections.push(recommendation);
      }
    }.bind(this));

    injections.sort(function(a, b) { return b.confidence - a.confidence; });

    this._stats.injectionsRecommended += injections.length;

    return { injections: injections, taskType: type };
  }

  /**
   * 获取模式统计信息
   * @returns {{totalRecords: number, totalPatterns: number, significantPatterns: number, categoryBreakdown: Object, stats: Object}} 统计数据
   */
  getPatternStats() {
    this.guardShutdown();
    const records = this._executionRecords.toArray();
    let significantCount = 0;
    const categoryBreakdown = Object.create(null);

    this._patterns.forEach(function(pattern) {
      if (pattern.significant) significantCount++;
      if (!categoryBreakdown[pattern.category]) categoryBreakdown[pattern.category] = 0;
      categoryBreakdown[pattern.category]++;
    });

    return {
      totalRecords: records.length,
      totalPatterns: this._patterns.size,
      significantPatterns: significantCount,
      categoryBreakdown: categoryBreakdown,
      stats: { ...this._stats },
    };
  }

  _updatePatternsForRecord(record) {
    safeExecute(function() {
      const categories = this._categorizePromptStructure(record);
      for (const category of categories) {
        const patternId = category + ':' + record.task_type;
        const existing = this._patterns.get(patternId);
        if (existing) {
          existing.sampleSize += 1;
          if (record.success) existing.successCount += 1;
          existing.successRate = existing.successCount / existing.sampleSize;
          existing.avgQualityScore = (existing.avgQualityScore * (existing.sampleSize - 1) + record.quality_score) / existing.sampleSize;
          existing.significant = this._calculateSignificance(existing);
          this._patterns.set(patternId, existing);
        } else {
          const newPattern = {
            id: patternId,
            category: category,
            task_type: record.task_type,
            sampleSize: 1,
            successCount: record.success ? 1 : 0,
            successRate: record.success ? 1 : 0,
            avgQualityScore: record.quality_score,
            significant: false,
            description: this._describePattern(category, record),
          };
          this._patterns.set(patternId, newPattern);
        }
      }
    }.bind(this), 'PromptPatternExtractor', '_updatePatternsForRecord');
  }

  _categorizePromptStructure(structure) {
    const categories = [];
    if (structure.has_examples) categories.push('examples');
    else categories.push('no_examples');
    if (structure.has_constraints) categories.push('constraints');
    else categories.push('no_constraints');
    categories.push('specificity_' + (structure.specificity_level || 'medium'));
    categories.push('context_' + (structure.context_richness || 'medium'));
    categories.push('structure_' + (structure.structure_type || 'freeform'));
    return categories;
  }

  _describePattern(category, record) {
    const descriptions = {
      examples: 'Prompts with examples',
      no_examples: 'Prompts without examples',
      constraints: 'Prompts with constraints',
      no_constraints: 'Prompts without constraints',
      specificity_low: 'Low specificity prompts',
      specificity_medium: 'Medium specificity prompts',
      specificity_high: 'High specificity prompts',
      context_low: 'Low context richness prompts',
      context_medium: 'Medium context richness prompts',
      context_high: 'High context richness prompts',
      structure_freeform: 'Freeform structure prompts',
      structure_structured: 'Structured prompts',
      structure_template: 'Template-based prompts',
    };
    return (descriptions[category] || 'Pattern: ' + category) + ' for ' + (record.task_type || 'general') + ' tasks';
  }

  _generatePatternCandidates(records) {
    const candidates = [];
    const seen = new Set();

    for (const record of records) {
      const categories = this._categorizePromptStructure(record);
      for (const category of categories) {
        const patternId = category + ':' + record.task_type;
        if (!seen.has(patternId)) {
          seen.add(patternId);
          candidates.push({ id: patternId, category: category, task_type: record.task_type });
        }
      }
    }

    return candidates;
  }

  _evaluateCandidate(candidate, records, baselineRate) {
    const matching = records.filter(function(r) {
      const categories = this._categorizePromptStructure(r);
      return categories.indexOf(candidate.category) !== -1 && r.task_type === candidate.task_type;
    }.bind(this));

    if (matching.length < this._config.minSampleSize) return null;

    const successCount = matching.filter(function(r) { return r.success; }).length;
    const successRate = successCount / matching.length;
    const avgQuality = matching.reduce(function(sum, r) { return sum + r.quality_score; }, 0) / matching.length;
    const effectSize = Math.abs(successRate - baselineRate);

    return {
      id: candidate.id,
      category: candidate.category,
      task_type: candidate.task_type,
      sampleSize: matching.length,
      successCount: successCount,
      successRate: successRate,
      baselineRate: baselineRate,
      avgQualityScore: avgQuality,
      effectSize: effectSize,
      significant: effectSize >= this._config.significanceThreshold && matching.length >= this._config.minSampleSize,
      description: this._describePattern(candidate.category, candidate),
    };
  }

  _calculateSignificance(pattern) {
    if (pattern.sampleSize < this._config.minSampleSize) return false;
    const effectSize = Math.abs(pattern.successRate - (pattern.baselineRate ?? 0.5));
    return effectSize >= this._config.significanceThreshold;
  }

  _buildRecommendation(pattern) {
    const positiveCategories = ['examples', 'constraints', 'specificity_high', 'context_high', 'structure_structured', 'structure_template'];
    const isPositive = positiveCategories.indexOf(pattern.category) !== -1;

    if (!isPositive && pattern.effectSize < this._config.significanceThreshold * 2) return null;

    let recommendation = '';
    const pctDiff = pattern.baselineRate > 0
      ? Math.round(((pattern.successRate - pattern.baselineRate) / pattern.baselineRate) * 100)
      : 0;

    if (isPositive && pattern.successRate > pattern.baselineRate) {
      recommendation = 'Include ' + pattern.category.replace(/_/g, ' ') + ' — ' + Math.abs(pctDiff) + '% higher success rate (n=' + pattern.sampleSize + ')';
    } else if (!isPositive && pattern.successRate < pattern.baselineRate) {
      recommendation = 'Avoid ' + pattern.category.replace(/_/g, ' ') + ' — ' + Math.abs(pctDiff) + '% lower success rate (n=' + pattern.sampleSize + ')';
    } else {
      return null;
    }

    return {
      category: pattern.category,
      recommendation: recommendation,
      confidence: Math.min(1, pattern.effectSize * 2 + pattern.sampleSize / 100),
      evidence: 'successRate=' + pattern.successRate.toFixed(2) + ' vs baseline=' + pattern.baselineRate.toFixed(2) + ' (n=' + pattern.sampleSize + ')',
    };
  }

  _onShutdown() {
    this._executionRecords.shutdown();
    this._patterns.shutdown();
    this._stats = { recorded: 0, patternsFound: 0, injectionsRecommended: 0 };
    this.removeAllListeners();
  }
}

PromptPatternExtractor.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(PromptPatternExtractor);
