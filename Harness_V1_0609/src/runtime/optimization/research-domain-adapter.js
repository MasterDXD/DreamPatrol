'use strict';

const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const EventEmitter = require('events');

/**
 * @module runtime/optimization/research-domain-adapter
 * 研究领域适配器 — 为自主研究闭环提供多领域适配能力。
 * 将autoresearch的"写代码-跑实验-看结果-改模型"闭环泛化到
 * 内容、运营、工作流、ML研究等多个业务领域。
 *
 * 核心能力：
 * - 领域模板定义（8个预定义领域）
 * - 假设生成（基于领域知识自动生成优化假设）
 * - 实验参数配置（领域特定的实验参数）
 * - 结果解释（领域特定的结果解读和建议）
 * - 模型更新策略（各领域的优化策略）
 */

/** @constant {Object} RESEARCH_DOMAINS - 预定义研究领域 */
const RESEARCH_DOMAINS = {
  CONTENT: 'content',
  OPERATIONS: 'operations',
  ML_RESEARCH: 'ml_research',
  WORKFLOW: 'workflow',
  CODE_QUALITY: 'code_quality',
  USER_EXPERIENCE: 'user_experience',
  PERFORMANCE: 'performance',
  SECURITY: 'security',
};

/** @constant {Object} DOMAIN_META - 领域元数据 */
const DOMAIN_META = {
  [RESEARCH_DOMAINS.CONTENT]: {
    name: '内容优化',
    description: '自主测试标题、优化内容结构、A/B测试变体',
    metrics: ['engagement', 'clickRate', 'conversion', 'readTime'],
    experimentTypes: ['ab_test', 'multivariate', 'sequential'],
    optimizationTargets: ['title', 'structure', 'tone', 'length', 'cta'],
  },
  [RESEARCH_DOMAINS.OPERATIONS]: {
    name: '运营优化',
    description: '自动跑话术、分析数据、迭代策略',
    metrics: ['responseTime', 'successRate', 'customerSatisfaction', 'resolutionRate'],
    experimentTypes: ['strategy_compare', 'process_optimization', 'resource_allocation'],
    optimizationTargets: ['script', 'workflow', 'routing', 'escalation'],
  },
  [RESEARCH_DOMAINS.ML_RESEARCH]: {
    name: 'ML研究',
    description: '写代码-跑实验-看结果-改模型自主闭环',
    metrics: ['accuracy', 'loss', 'f1Score', 'auc', 'trainingTime', 'inferenceTime'],
    experimentTypes: ['hyperparameter_search', 'architecture_search', 'ablation_study'],
    optimizationTargets: ['hyperparameters', 'architecture', 'lossFunction', 'optimizer', 'dataPipeline'],
  },
  [RESEARCH_DOMAINS.WORKFLOW]: {
    name: '工作流优化',
    description: '自主测试和优化工作流程',
    metrics: ['throughput', 'latency', 'errorRate', 'costPerTask'],
    experimentTypes: ['pipeline_compare', 'step_elimination', 'parallelization'],
    optimizationTargets: ['steps', 'order', 'parallelization', 'toolSelection'],
  },
  [RESEARCH_DOMAINS.CODE_QUALITY]: {
    name: '代码质量优化',
    description: '自主测试代码质量改进策略',
    metrics: ['bugRate', 'reviewTime', 'testCoverage', 'complexityScore'],
    experimentTypes: ['refactor_compare', 'lint_rule_test', 'pattern_adoption'],
    optimizationTargets: ['codingPattern', 'lintRules', 'reviewProcess', 'testStrategy'],
  },
  [RESEARCH_DOMAINS.USER_EXPERIENCE]: {
    name: '用户体验优化',
    description: '自主测试UI/UX改进方案',
    metrics: ['taskCompletion', 'timeOnTask', 'errorCount', 'satisfaction'],
    experimentTypes: ['ab_test', 'usability_compare', 'flow_optimization'],
    optimizationTargets: ['layout', 'navigation', 'interaction', 'feedback'],
  },
  [RESEARCH_DOMAINS.PERFORMANCE]: {
    name: '性能优化',
    description: '自主测试性能调优策略',
    metrics: ['loadTime', 'memoryUsage', 'cpuUsage', 'throughput', 'latency'],
    experimentTypes: ['benchmark_compare', 'config_tuning', 'resource_optimization'],
    optimizationTargets: ['cache', 'concurrency', 'algorithm', 'dataStructure', 'config'],
  },
  [RESEARCH_DOMAINS.SECURITY]: {
    name: '安全优化',
    description: '自主测试安全加固策略',
    metrics: ['vulnerabilityCount', 'fixTime', 'falsePositiveRate', 'coverageRate'],
    experimentTypes: ['scan_compare', 'rule_tuning', 'policy_test'],
    optimizationTargets: ['scanRules', 'fixStrategy', 'reviewPolicy', 'monitoringConfig'],
  },
};

/**
 * @classdesc 研究领域适配器。为自主研究闭环提供多领域适配能力，
 * 将autoresearch模式泛化到内容、运营、工作流、ML研究等8个业务领域。
 * 支持领域模板、假设生成、参数配置和结果解释。
 *
 * @extends EventEmitter
 */
class ResearchDomainAdapter extends EventEmitter {
  constructor(options) {
    super();
    this._options = options ?? {};
    this._customDomains = new Map();
    this._hypothesisHistory = [];
    this._shutDown = false;
  }

  /**
   * 获取所有支持的领域列表。
   * @returns {Array<{id: string, name: string, description: string}>} 领域列表
   */
  getDomains() {
    const domains = [];
    for (const [id, meta] of Object.entries(DOMAIN_META)) {
      domains.push({ id, name: meta.name, description: meta.description });
    }
    for (const [id, meta] of this._customDomains) {
      domains.push({ id, name: meta.name, description: meta.description });
    }
    return domains;
  }

  /**
   * 获取指定领域的元数据。
   * @param {string} domain - 领域ID
   * @returns {Object|null} 领域元数据
   */
  getDomainMeta(domain) {
    return DOMAIN_META[domain] ?? this._customDomains.get(domain) ?? null;
  }

  /**
   * 注册自定义研究领域。
   * @param {string} id - 领域ID
   * @param {Object} meta - 领域元数据
   * @param {string} meta.name - 领域名称
   * @param {string} meta.description - 领域描述
   * @param {Array<string>} meta.metrics - 关注指标
   * @param {Array<string>} meta.experimentTypes - 实验类型
   * @param {Array<string>} meta.optimizationTargets - 优化目标
   * @returns {boolean} 是否注册成功
   */
  registerDomain(id, meta) {
    this.guardShutdown();
    if (!id || !meta || !meta.name) return false;
    if (DOMAIN_META[id]) return false;
    this._customDomains.set(id, {
      name: meta.name,
      description: meta.description ?? '',
      metrics: meta.metrics ?? [],
      experimentTypes: meta.experimentTypes ?? [],
      optimizationTargets: meta.optimizationTargets ?? [],
    });
    this.emit('domain-registered', { id, name: meta.name });
    debug('ResearchDomainAdapter', 'registerDomain', 'id=' + id + ' name=' + meta.name);
    return true;
  }

  /**
   * 三要素研究定义。只需提供"待改文件、优化目标、评判标准"即可启动研究。
   * 自动匹配最合适的领域模板并生成研究定义。
   * @param {Object} params - 三要素参数
   * @param {Array<string>} params.targetFiles - 待改文件路径数组
   * @param {string} params.optimizationGoal - 优化目标描述
   * @param {string|Function} params.evaluationCriteria - 评判标准（预设标准名或自定义函数）
   * @param {Object} [params.constraints] - 约束条件
   * @returns {{success: boolean, definition?: Object, error?: string}} 研究定义
   */
  defineResearch(params) {
    this.guardShutdown();
    if (!params || !params.optimizationGoal) {
      return { success: false, error: 'optimizationGoal is required' };
    }

    const targetFiles = params.targetFiles ?? [];
    const optimizationGoal = params.optimizationGoal;
    const evaluationCriteria = params.evaluationCriteria ?? 'default';
    const constraints = params.constraints ?? {};

    // 自动推断领域
    const domain = this._inferDomain(optimizationGoal, targetFiles);
    const meta = this.getDomainMeta(domain);

    if (!meta) {
      return { success: false, error: 'Cannot infer domain for goal: ' + optimizationGoal };
    }

    // 解析评判标准
    const criteria = this._resolveEvaluationCriteria(evaluationCriteria, domain);

    // 生成研究定义
    const definition = {
      domain,
      goal: optimizationGoal,
      constraints: {
        ...constraints,
        targetFiles,
        evaluationCriteria: criteria,
      },
      targetMetrics: meta.metrics.slice(0, 3),
      initialConfig: {
        domain,
        optimizationTargets: meta.optimizationTargets,
        experimentTypes: meta.experimentTypes,
      },
    };

    this.emit('research-defined', { domain, goal: optimizationGoal, targetFiles: targetFiles.length });
    debug('ResearchDomainAdapter', 'defineResearch', 'domain=' + domain + ' goal=' + optimizationGoal);
    return { success: true, definition };
  }

  /**
   * 推断研究领域。基于优化目标和待改文件自动匹配最合适的领域模板。
   * @param {string} goal - 优化目标
   * @param {Array<string>} files - 待改文件
   * @returns {string} 推断的领域ID
   * @private
   */
  _inferDomain(goal, files) {
    const goalLower = (goal ?? '').toLowerCase();

    // 基于目标关键词推断
    const keywordMap = {
      content: ['content', 'title', 'headline', 'copy', 'article', 'video', 'script', 'engagement', 'click'],
      operations: ['operations', 'workflow', 'process', 'script', 'routing', 'escalation'],
      ml_research: ['model', 'accuracy', 'training', 'loss', 'f1', 'auc', 'hyperparameter', 'architecture'],
      workflow: ['pipeline', 'throughput', 'latency', 'workflow', 'automation'],
      code_quality: ['code', 'bug', 'lint', 'refactor', 'coverage', 'complexity'],
      user_experience: ['ux', 'ui', 'layout', 'navigation', 'usability', 'satisfaction'],
      performance: ['performance', 'speed', 'memory', 'cpu', 'load', 'cache', 'concurrency'],
      security: ['security', 'vulnerability', 'scan', 'auth', 'encrypt', 'policy'],
    };

    for (const [domain, keywords] of Object.entries(keywordMap)) {
      if (keywords.some(kw => goalLower.includes(kw))) {
        return domain;
      }
    }

    // 基于文件扩展名推断
    if (files.length > 0) {
      const ext = files[0].split('.').pop()?.toLowerCase();
      if (['py', 'ipynb'].includes(ext)) return 'ml_research';
      if (['js', 'ts', 'jsx', 'tsx'].includes(ext)) return 'code_quality';
      if (['css', 'scss', 'html'].includes(ext)) return 'user_experience';
    }

    return 'content';
  }

  /**
   * 解析评判标准。将预设标准名或自定义函数转化为标准化评判配置。
   * @param {string|Function} criteria - 评判标准
   * @param {string} domain - 研究领域
   * @returns {Object} 标准化评判配置
   * @private
   */
  _resolveEvaluationCriteria(criteria, domain) {
    if (typeof criteria === 'function') {
      return { type: 'custom', fn: criteria, domain };
    }

    const presetCriteria = {
      default: { type: 'preset', name: 'default', threshold: 0.7, description: '默认阈值0.7' },
      strict: { type: 'preset', name: 'strict', threshold: 0.9, description: '严格阈值0.9' },
      loose: { type: 'preset', name: 'loose', threshold: 0.5, description: '宽松阈值0.5' },
      binary: { type: 'preset', name: 'binary', threshold: 0.5, description: '二元判断阈值0.5' },
      engagement: { type: 'preset', name: 'engagement', threshold: 0.6, description: '互动率优化阈值0.6' },
      conversion: { type: 'preset', name: 'conversion', threshold: 0.8, description: '转化率优化阈值0.8' },
    };

    return presetCriteria[criteria] ?? presetCriteria.default;
  }

  /**
   * 生成研究假设。基于领域观察数据自动生成优化假设。
   * @param {string} domain - 研究领域
   * @param {Object} observations - 观察数据
   * @param {Array<Object>} observations.patterns - 观察到的模式
   * @param {Object} observations.currentMetrics - 当前指标
   * @param {number} [count=3] - 生成假设数量
   * @returns {Array<Object>} 假设列表
   */
  generateHypotheses(domain, observations, count) {
    this.guardShutdown();
    const meta = this.getDomainMeta(domain);
    if (!meta) {
      debug('ResearchDomainAdapter', 'generateHypotheses', 'unknown domain: ' + domain);
      return [];
    }

    const maxCount = Math.min(count ?? 3, 5);
    const hypotheses = [];
    const patterns = observations?.patterns ?? [];
    const currentMetrics = observations?.currentMetrics ?? {};

    for (let i = 0; i < maxCount; i++) {
      const target = meta.optimizationTargets[i % meta.optimizationTargets.length];
      const metric = meta.metrics[i % meta.metrics.length];

      const hypothesis = {
        id: 'hyp-' + Date.now() + '-' + i,
        domain,
        target,
        metric,
        prediction: this._generatePrediction(domain, target, metric, currentMetrics),
        confidence: this._calculateConfidence(patterns, metric),
        suggestedExperiment: meta.experimentTypes[i % meta.experimentTypes.length],
        parameters: this._generateExperimentParameters(domain, target, metric),
        expectedImprovement: Math.round((0.05 + Math.random() * 0.2) * 10000) / 10000,
        generatedAt: Date.now(),
      };

      hypotheses.push(hypothesis);
    }

    this._hypothesisHistory.push(...hypotheses);
    if (this._hypothesisHistory.length > 500) {
      this._hypothesisHistory.splice(0, this._hypothesisHistory.length - 500);
    }

    return hypotheses;
  }

  /**
   * 解释实验结果。基于领域知识对实验结果进行解读。
   * @param {string} domain - 研究领域
   * @param {Object} experimentResult - 实验结果
   * @param {Object} hypothesis - 原始假设
   * @returns {Object} 解释结果
   */
  interpretResults(domain, experimentResult, hypothesis) {
    this.guardShutdown();
    const meta = this.getDomainMeta(domain);
    if (!meta) {
      return { success: false, error: 'Unknown domain: ' + domain };
    }

    const metrics = experimentResult?.metrics ?? {};
    const improvement = this._calculateImprovement(metrics, hypothesis);
    const significance = this._assessSignificance(improvement, domain);
    const recommendations = this._generateRecommendations(domain, metrics, hypothesis, significance);

    return {
      success: true,
      domain,
      hypothesisId: hypothesis?.id ?? null,
      improvement,
      significance,
      recommendations,
      interpretedAt: Date.now(),
    };
  }

  /**
   * 生成优化策略。基于实验历史数据生成领域优化策略。
   * @param {string} domain - 研究领域
   * @param {Array<Object>} history - 实验历史记录
   * @returns {Object} 优化策略
   */
  generateOptimizationStrategy(domain, history) {
    this.guardShutdown();
    const meta = this.getDomainMeta(domain);
    if (!meta) {
      return { success: false, error: 'Unknown domain: ' + domain };
    }

    const historyItems = Array.isArray(history) ? history : [];
    const successfulExperiments = historyItems.filter(
      h => h.status === 'completed' && h.metrics,
    );

    const strategy = {
      domain,
      totalExperiments: historyItems.length,
      successfulExperiments: successfulExperiments.length,
      successRate: historyItems.length > 0
        ? Math.round((successfulExperiments.length / historyItems.length) * 10000) / 10000
        : 0,
      topImprovements: this._extractTopImprovements(successfulExperiments),
      recommendedFocus: this._recommendFocus(meta, successfulExperiments),
      suggestedNextExperiments: meta.experimentTypes.slice(0, 3),
    };

    return { success: true, strategy };
  }

  /**
   * 生成预测文本。
   * @param {string} domain - 领域
   * @param {string} target - 优化目标
   * @param {string} metric - 指标
   * @param {Object} currentMetrics - 当前指标
   * @returns {string} 预测文本
   * @private
   */
  _generatePrediction(domain, target, metric, currentMetrics) {
    const currentValue = currentMetrics[metric];
    const templates = {
      content: `优化${target}将提升${metric}指标`,
      operations: `调整${target}策略将改善${metric}表现`,
      ml_research: `修改${target}参数将降低${metric}值`,
      workflow: `重组${target}将减少${metric}`,
      code_quality: `改进${target}将提升${metric}得分`,
      user_experience: `优化${target}将改善${metric}指标`,
      performance: `调优${target}将降低${metric}值`,
      security: `增强${target}将减少${metric}数量`,
    };
    const base = templates[domain] ?? `优化${target}将改善${metric}`;
    return currentValue !== undefined ? `${base}（当前值: ${currentValue}）` : base;
  }

  /**
   * 计算假设置信度。
   * @param {Array<Object>} patterns - 观察模式
   * @param {string} metric - 指标
   * @returns {number} 置信度（0-1）
   * @private
   */
  _calculateConfidence(patterns, metric) {
    if (!patterns || patterns.length === 0) return 0.3;
    const relevantPatterns = patterns.filter(p => p.metric === metric);
    if (relevantPatterns.length === 0) return 0.4;
    const sampleSize = relevantPatterns[0]?.sampleSize ?? 1;
    return Math.min(0.95, Math.max(0.3, sampleSize / 50));
  }

  /**
   * 生成实验参数。
   * @param {string} domain - 领域
   * @param {string} target - 优化目标
   * @param {string} metric - 指标
   * @returns {Object} 实验参数
   * @private
   */
  _generateExperimentParameters(domain, target, metric) {
    const params = { domain, target, metric };
    switch (domain) {
      case RESEARCH_DOMAINS.CONTENT:
        params.variants = ['control', 'variant_a', 'variant_b'];
        params.metrics = [metric];
        params.sampleSize = 1000;
        break;
      case RESEARCH_DOMAINS.OPERATIONS:
        params.strategy = 'experimental';
        params.targetMetrics = [metric];
        params.baseline = {};
        break;
      case RESEARCH_DOMAINS.ML_RESEARCH:
        params.modelConfig = {};
        params.hyperparameters = {};
        params.hyperparameterVariants = [{ learningRate: 0.001 }, { learningRate: 0.0001 }];
        break;
      case RESEARCH_DOMAINS.WORKFLOW:
        params.currentFlow = [];
        params.proposedFlow = [];
        params.avgStepDuration = 30;
        break;
      default:
        params.metrics = [metric];
        params.iterations = 10;
    }
    return params;
  }

  /**
   * 计算改进幅度。
   * @param {Object} metrics - 实验指标
   * @param {Object} hypothesis - 假设
   * @returns {Object} 改进幅度
   * @private
   */
  _calculateImprovement(metrics, _hypothesis) {
    const improvement = {};
    if (metrics.improvement) {
      Object.assign(improvement, metrics.improvement);
    }
    if (metrics.bestAccuracy !== undefined) {
      improvement.accuracy = metrics.bestAccuracy;
    }
    if (metrics.duration !== undefined) {
      improvement.duration = metrics.duration;
    }
    return improvement;
  }

  /**
   * 评估显著性。
   * @param {Object} improvement - 改进幅度
   * @param {string} domain - 领域
   * @returns {{isSignificant: boolean, confidence: number, level: string}} 显著性评估
   * @private
   */
  _assessSignificance(improvement, _domain) {
    const values = Object.values(improvement).filter(v => typeof v === 'number');
    if (values.length === 0) {
      return { isSignificant: false, confidence: 0, level: 'insufficient_data' };
    }

    const avgImprovement = values.reduce((a, b) => a + Math.abs(b), 0) / values.length;
    const confidence = Math.min(0.95, avgImprovement * 10);

    let level;
    if (confidence >= 0.8) level = 'high';
    else if (confidence >= 0.5) level = 'moderate';
    else level = 'low';

    return {
      isSignificant: confidence >= 0.5,
      confidence: Math.round(confidence * 10000) / 10000,
      level,
    };
  }

  /**
   * 生成建议。
   * @param {string} domain - 领域
   * @param {Object} metrics - 指标
   * @param {Object} hypothesis - 假设
   * @param {Object} significance - 显著性
   * @returns {Array<string>} 建议列表
   * @private
   */
  _generateRecommendations(domain, metrics, hypothesis, significance) {
    const recommendations = [];

    if (significance.isSignificant) {
      recommendations.push(`实验结果显著（置信度: ${significance.confidence}），建议应用优化方案`);
    } else {
      recommendations.push('实验结果不显著，建议增加样本量或调整实验参数');
    }

    if (hypothesis?.target) {
      recommendations.push(`继续关注优化目标: ${hypothesis.target}`);
    }

    const meta = this.getDomainMeta(domain);
    if (meta && meta.experimentTypes.length > 1) {
      recommendations.push(`建议下一轮尝试实验类型: ${meta.experimentTypes[1]}`);
    }

    recommendations.push('记录实验数据到知识库，供后续优化参考');
    return recommendations;
  }

  /**
   * 提取最佳改进。
   * @param {Array<Object>} experiments - 成功实验列表
   * @returns {Array<Object>} 最佳改进
   * @private
   */
  _extractTopImprovements(experiments) {
    if (experiments.length === 0) return [];
    const sorted = experiments
      .filter(e => e.metrics)
      .sort((a, b) => (b.metrics.duration ?? 0) - (a.metrics.duration ?? 0))
      .slice(0, 5);
    return sorted.map(e => ({
      id: e.id,
      domain: e.domain,
      metrics: e.metrics,
    }));
  }

  /**
   * 推荐关注方向。
   * @param {Object} meta - 领域元数据
   * @param {Array<Object>} experiments - 成功实验
   * @returns {string} 推荐关注方向
   * @private
   */
  _recommendFocus(meta, experiments) {
    if (experiments.length === 0) {
      return meta.optimizationTargets[0] ?? 'general';
    }
    const targetCounts = {};
    for (const exp of experiments) {
      const target = exp.metrics?.winner ?? 'unknown';
      targetCounts[target] = (targetCounts[target] ?? 0) + 1;
    }
    const sorted = Object.entries(targetCounts).sort((a, b) => b[1] - a[1]);
    return sorted.length > 0 ? sorted[0][0] : meta.optimizationTargets[0] ?? 'general';
  }

  /**
   * 获取假设历史。
   * @param {number} [limit] - 返回数量限制
   * @returns {Array<Object>} 假设历史
   */
  getHypothesisHistory(limit) {
    if (limit && limit > 0) return this._hypothesisHistory.slice(-limit);
    return this._hypothesisHistory.slice();
  }

  /**
   * 关闭适配器。
   * @protected
   */
  _onShutdown() {
    this._customDomains.clear();
    this._hypothesisHistory = [];
  }
}

module.exports = withShutdown(ResearchDomainAdapter);
module.exports.RESEARCH_DOMAINS = RESEARCH_DOMAINS;
module.exports.DOMAIN_META = DOMAIN_META;
