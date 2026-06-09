'use strict';

const { generateId } = require('../../utils/constants');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');

const REFLECTION_DIMENSIONS = [
  'boundary_conditions',
  'consistency',
  'security',
  'performance',
  'completeness',
];

const SELF_REFLECTION_WEIGHTS = {
  COMPLETENESS_DEFINED: 0.7,
  COMPLETENESS_BASE: 0.3,
  FALLBACK: 0.8,
  CORRECTNESS_FAILURE: 0.5,
  CORRECTNESS_SUCCESS_BONUS: 0.2,
  CORRECTNESS_FAILURE_FLOOR: 0.1,
  CONSISTENCY_BASE: 0.6,
  CONSISTENCY_DELTA: 0.4,
  COVERAGE_MIN: 0.3,
  COVERAGE_LENGTH_FACTOR: 0.5,
  COVERAGE_BASE: 0.5,
  COVERAGE_REF_LENGTH: 500,
};

const REFLECTION_TEMPLATES = {
  code: [
    '是否有遗漏的边界条件或异常处理？',
    '是否与之前的架构决策或接口约定一致？',
    '是否存在安全隐患（如未验证输入、敏感信息泄露）？',
    '是否存在性能瓶颈（如不必要的循环、内存泄漏）？',
    '如果由另一个Agent审查，最可能被挑出的问题是什么？',
  ],
  design: [
    '设计是否覆盖了所有需求场景？',
    '是否存在过度设计或设计不足的部分？',
    '模块间的依赖关系是否清晰合理？',
    '是否考虑了可扩展性和向后兼容性？',
    '如果由另一个Agent审查，最可能被挑出的问题是什么？',
  ],
  test: [
    '是否覆盖了所有关键路径和边界条件？',
    '测试用例之间是否存在依赖或顺序敏感？',
    '是否存在误判风险（假阳性/假阴性）？',
    '测试数据是否具有代表性和多样性？',
    '如果由另一个Agent审查，最可能被挑出的问题是什么？',
  ],
  documentation: [
    '文档是否准确反映了当前实现状态？',
    '是否包含足够的示例和使用说明？',
    '术语使用是否与项目其他部分一致？',
    '是否标注了已知限制和注意事项？',
    '如果由另一个Agent审查，最可能被挑出的问题是什么？',
  ],
  decision: {
    dimensions: ['falsifiability', 'assumption_validity', 'anti_sycophancy', 'evidence_strength', 'alternative_coverage'],
    prompts: [
      '这个结论在什么现实条件下会被证明是错误的？列出至少3个证伪信号',
      '这个方案依赖的关键假设是什么？哪些假设最脆弱？',
      '你是否在附和用户的想法而非提供真正有用的建议？如果是，请重新审视',
      '支持这个结论的证据有多强？是否有更简单的替代解释？',
      '是否考虑了足够多的替代方案？是否遗漏了非共识但高价值的选项？',
    ],
  },
};

const DEFAULT_CONFIG = {
  maxReflections: 3,
  improvementThreshold: 0.05,
  qualityWeights: {
    completeness: 0.25,
    correctness: 0.30,
    consistency: 0.15,
    security: 0.15,
    clarity: 0.15,
  },
  autoTriggerOnQualityDrop: true,
  persistResults: true,
};

const { EventEmitter } = require('events');

/**
 * @module runtime/quality/self-reflection
 */
/**
 * SelfReflection — 自反思引擎
 * @classdesc 自反思。输出质量自评、改进建议生成、证伪维度反思
 * 输出质量自评与改进建议生成，支持五维度反思（边界条件/一致性/安全性/性能/完整性）
 * 和证伪维度反思（falsification）。根据质量趋势判定improving/stable/degrading，
 * 推荐continue/deepen-analysis/rollback-and-revise动作。内置code/design/test/documentation/decision
 * 五种反思模板，decision模板含证伪与反谄媚检查。
 * @extends EventEmitter
 * @emits SelfReflection#reflection-created
 * @emits SelfReflection#improvement-recorded
 */
class SelfReflection extends EventEmitter {
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._maxHistory = (options && options.maxHistory) ?? 500;
    this._history = new BoundedMap(this._maxHistory);
    this._stats = { totalReflections: 0, totalImprovements: 0, avgImprovement: 0, _totalDelta: 0 };
    this._signalPersistence = (options && options.signalPersistence) ?? null;
  }

  /**
   * 附加信号持久化实例，反思结果将自动持久化到信号存储
   * @param {object} sp - SignalPersistence实例
   * @returns {SelfReflection} 当前实例，支持链式调用
   */
  attachSignalPersistence(sp) {
    this._signalPersistence = sp;
    return this;
  }

  /**
   * 执行自反思，根据上下文生成反思问题、质量趋势判定与建议动作
   * 根据artifactType选择反思模板(code/design/test/documentation/decision)，
   * 对比前后质量分数判定improving/stable/degrading趋势，推荐continue/deepen-analysis/rollback-and-revise动作
   * @param {object} context - 反思上下文
   * @param {string} context.agentId - 执行反思的Agent标识（必填）
   * @param {string} context.skillId - 关联的Skill标识（必填）
   * @param {string} [context.artifactType='code'] - 产出类型，可选code/design/test/documentation/decision
   * @param {number} [context.previousQuality] - 前一次质量分数
   * @param {number} [context.currentQuality] - 当前质量分数
   * @param {object} [context.result] - 任务执行结果，用于维度推断
   * @param {object} [context.dimensionScores] - 各维度预计算分数
   * @returns {{reflectionId: string, questions: Array<string>, qualityTrend: string, recommendedAction: string, selfCheckPrompt: string, dimensions: object}|{success: boolean, error: string}} 反思结果，含反思ID、问题列表、趋势、建议动作、自检提示、维度评分；参数缺失时返回错误对象
   * @throws {Error} When output is not a string or object with text property
   * @example
   * const reflection = new SelfReflection();
   * const result = reflection.reflect({
   *   output: 'Generated code module',
   *   criteria: ['correctness', 'efficiency'],
   *   context: { taskType: 'implementation' }
   * });
   * console.log(result.score, result.improvements);
   */
  reflect(context) {
    this.guardShutdown();
    if (!context || !context.agentId || !context.skillId) {
      return { success: false, error: 'agentId and skillId are required' };
    }

    const reflectionId = generateId('refl-');
    const artifactType = context.artifactType || 'code';
    const template = REFLECTION_TEMPLATES[artifactType] ?? REFLECTION_TEMPLATES.code;
    const questions = Array.isArray(template) ? template : (template.prompts ?? REFLECTION_TEMPLATES.code);

    const reflection = {
      reflectionId,
      agentId: context.agentId,
      skillId: context.skillId,
      artifactType,
      questions,
      previousQuality: context.previousQuality ?? null,
      currentQuality: context.currentQuality ?? null,
      dimensions: this._evaluateDimensions(context),
      improvements: [],
      timestamp: new Date().toISOString(),
    };

    const qualityTrend = this._computeQualityTrend(reflection.previousQuality, reflection.currentQuality);
    reflection.qualityTrend = qualityTrend.trend;
    reflection.recommendedAction = qualityTrend.action;

    reflection.selfCheckPrompt = this._buildSelfCheckPrompt(reflection, context);

    this._history.set(reflectionId, reflection);
    this._stats.totalReflections++;

    this.emit('reflection-created', {
      reflectionId,
      agentId: context.agentId,
      qualityTrend: reflection.qualityTrend,
      recommendedAction: reflection.recommendedAction,
    });

    if (this._signalPersistence) {
      try {
        this._signalPersistence.record('reflection', {
          reflectionId: reflectionId,
          agentId: context.agentId,
          skillId: context.skillId,
          artifactType: artifactType,
          qualityTrend: reflection.qualityTrend,
          recommendedAction: reflection.recommendedAction,
          previousQuality: reflection.previousQuality,
          currentQuality: reflection.currentQuality,
          timestamp: reflection.timestamp,
        });
      } catch (_e) { debug('SelfReflection', 'reflect', 'Persistence failed: ' + (_e && _e.message ? _e.message : String(_e))); }
    }

    return {
      reflectionId,
      questions,
      qualityTrend: reflection.qualityTrend,
      recommendedAction: reflection.recommendedAction,
      selfCheckPrompt: reflection.selfCheckPrompt,
      dimensions: reflection.dimensions,
    };
  }

  /**
   * 记录改进条目到指定反思记录中，更新平均改进量统计
   * @param {string} reflectionId - 反思记录标识
   * @param {object} improvement - 改进描述
   * @param {string} [improvement.dimension='general'] - 改进维度名称
   * @param {string} [improvement.description=''] - 改进描述文本
   * @param {number} [improvement.beforeScore=0] - 改进前分数
   * @param {number} [improvement.afterScore=0] - 改进后分数
   * @returns {{recorded: boolean, improvement: object}|{success: boolean, error: string}} 记录成功返回recorded:true及改进条目；反思不存在或参数无效时返回错误对象
   */
  recordImprovement(reflectionId, improvement) {
    this.guardShutdown();
    const reflection = this._history.get(reflectionId);
    if (!reflection) return { success: false, error: 'Reflection not found' };
    if (!improvement || typeof improvement !== 'object') {
      return { success: false, error: 'improvement must be an object' };
    }

    const entry = {
      dimension: improvement.dimension || 'general',
      description: improvement.description || '',
      beforeScore: typeof improvement.beforeScore === 'number' && Number.isFinite(improvement.beforeScore) ? improvement.beforeScore : 0,
      afterScore: typeof improvement.afterScore === 'number' && Number.isFinite(improvement.afterScore) ? improvement.afterScore : 0,
      timestamp: new Date().toISOString(),
    };

    reflection.improvements.push(entry);
    this._stats.totalImprovements++;
    this._stats._totalDelta = (this._stats._totalDelta ?? 0) + ((entry.afterScore ?? 0) - (entry.beforeScore ?? 0));
    this._stats.avgImprovement = this._stats.totalImprovements > 0
      ? this._stats._totalDelta / this._stats.totalImprovements
      : 0;

    this.emit('improvement-recorded', { reflectionId, dimension: entry.dimension });

    return { recorded: true, improvement: entry };
  }

  /**
   * 根据反思ID获取完整的反思记录
   * @param {string} reflectionId - 反思记录标识
   * @returns {object|null} 反思记录对象，含reflectionId/agentId/skillId/artifactType/questions/dimensions/improvements等；不存在时返回null
   */
  getReflection(reflectionId) {
    const entry = this._history.get(reflectionId);
    if (!entry) return null;
    const { improvements, ...rest } = entry;
    return { ...rest, improvements: improvements.slice() };
  }

  /**
   * 获取指定Agent的所有反思记录，按时间降序排列
   * @param {string} agentId - Agent标识
   * @returns {Array<object>} 该Agent的反思记录数组，按timestamp降序排列
   */
  getAgentReflections(agentId) {
    const results = [];
    for (const [, reflection] of this._history) {
      if (reflection.agentId === agentId) {
        const { improvements, ...rest } = reflection;
        results.push({ ...rest, improvements: improvements.slice() });
      }
    }
    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp, 'en'));
  }

  /**
   * 获取反思统计摘要
   * @returns {{totalReflections: number, totalImprovements: number, avgImprovement: number, activeReflections: number}} 统计信息，含总反思次数、总改进次数、平均改进量、活跃反思数
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('SelfReflection', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalReflections: 0, totalImprovements: 0, avgImprovement: 0, activeReflections: 0 }; }
    return { ...this._stats, activeReflections: this._history.size, avgImprovement: this._stats.avgImprovement };
  }

  /**
   * 判断是否应触发自反思
   * 当质量下降超过阈值、证据完整度低于0.8或迭代次数大于1时返回true
   * @param {object} context - 判断上下文
   * @param {number} [context.currentQuality] - 当前质量分数
   * @param {number} [context.previousQuality] - 前一次质量分数
   * @param {number} [context.evidenceCompleteness] - 证据完整度(0-1)
   * @param {number} [context.iterationCount] - 迭代次数
   * @returns {boolean} 是否应触发反思
   */
  shouldTriggerReflection(context) {
    if (!context) return false;

    if (context.currentQuality !== undefined && context.previousQuality !== undefined) {
      if (context.currentQuality < context.previousQuality - this._config.improvementThreshold) {
        return true;
      }
    }

    return (context.evidenceCompleteness !== undefined && context.evidenceCompleteness < 0.8)
      || (context.iterationCount !== undefined && context.iterationCount > 1);
  }

  _evaluateDimensions(context) {
    const dimensions = {};
    const weights = this._config.qualityWeights;

    for (const dim of REFLECTION_DIMENSIONS) {
      const weight = weights[dim] ?? 0.15;
      let score = 0.5;

      if (context.dimensionScores && context.dimensionScores[dim] !== undefined) {
        score = context.dimensionScores[dim];
      } else if (context.currentQuality !== undefined) {
        score = this._inferDimensionScore(dim, context);
      }

      dimensions[dim] = { score, weight, needsAttention: score < 0.6 };
    }

    return dimensions;
  }

  _inferDimensionScore(dim, context) {
    const base = Number.isFinite(context.currentQuality) ? context.currentQuality : 0.5;
    const result = context.result;
    const output = result && (result.output || result.result || result.data);

    switch (dim) {
      case 'completeness': return this._scoreCompleteness(base, output);
      case 'correctness': return this._scoreCorrectness(base, result);
      case 'consistency': return this._scoreConsistency(base, context);
      case 'coverage': return this._scoreCoverage(base, output);
      case 'clarity': return this._scoreClarity(base, output);
      default: return base * 0.8;
    }
  }

  _scoreCompleteness(base, output) {
    if (output && typeof output === 'object' && output !== null) {
      const definedFields = Object.values(output).filter(function(v) { return v != null && v !== ''; }).length;
      const totalFields = Object.keys(output).length;
      return totalFields > 0 ? Math.min(1, (definedFields / totalFields) * SELF_REFLECTION_WEIGHTS.COMPLETENESS_DEFINED + base * SELF_REFLECTION_WEIGHTS.COMPLETENESS_BASE) : base * SELF_REFLECTION_WEIGHTS.FALLBACK;
    }
    return base * SELF_REFLECTION_WEIGHTS.FALLBACK;
  }

  _scoreCorrectness(base, result) {
    if (result && result.success === false) return Math.max(SELF_REFLECTION_WEIGHTS.CORRECTNESS_FAILURE_FLOOR, base * SELF_REFLECTION_WEIGHTS.CORRECTNESS_FAILURE);
    if (result && result.success === true) return Math.min(1, base * SELF_REFLECTION_WEIGHTS.FALLBACK + SELF_REFLECTION_WEIGHTS.CORRECTNESS_SUCCESS_BONUS);
    return base * SELF_REFLECTION_WEIGHTS.FALLBACK;
  }

  _scoreConsistency(base, context) {
    if (context.previousQuality !== undefined) {
      const delta = Math.abs(base - context.previousQuality);
      return Math.min(1, base * SELF_REFLECTION_WEIGHTS.CONSISTENCY_BASE + (1 - delta) * SELF_REFLECTION_WEIGHTS.CONSISTENCY_DELTA);
    }
    return base * SELF_REFLECTION_WEIGHTS.FALLBACK;
  }

  _scoreCoverage(base, output) {
    if (output && typeof output === 'string') {
      const len = output.length;
      return Math.min(1, Math.max(SELF_REFLECTION_WEIGHTS.COVERAGE_MIN, Math.min(len / SELF_REFLECTION_WEIGHTS.COVERAGE_REF_LENGTH, 1) * SELF_REFLECTION_WEIGHTS.COVERAGE_LENGTH_FACTOR + base * SELF_REFLECTION_WEIGHTS.COVERAGE_BASE));
    }
    return base * SELF_REFLECTION_WEIGHTS.FALLBACK;
  }

  _scoreClarity(base, output) {
    if (output && typeof output === 'string') {
      const sentences = output.split(/[.!?。！？]/).filter(function(s) { return s.trim().length > 0; }).length;
      return Math.min(1, Math.max(0.3, Math.min(sentences / 5, 1) * 0.4 + base * 0.6));
    }
    return base * 0.8;
  }

  _computeQualityTrend(previousQuality, currentQuality) {
    if (previousQuality === null || currentQuality === null) {
      return { trend: 'initial', action: 'proceed-with-caution' };
    }
    if (typeof currentQuality !== 'number' || typeof previousQuality !== 'number' ||
        !Number.isFinite(currentQuality) || !Number.isFinite(previousQuality)) {
      return { trend: 'unknown', action: 're-evaluate' };
    }
    const delta = currentQuality - previousQuality;
    if (delta < -this._config.improvementThreshold) {
      return { trend: 'degrading', action: 'rollback-and-revise' };
    }
    if (delta > this._config.improvementThreshold) {
      return { trend: 'improving', action: 'continue' };
    }
    return { trend: 'stable', action: 'deepen-analysis' };
  }

  _buildSelfCheckPrompt(reflection, context) {
    const lines = [];
    lines.push('## 自反思检查');
    lines.push('');
    lines.push('Agent: ' + context.agentId + ' | Skill: ' + context.skillId);
    lines.push('产出类型: ' + reflection.artifactType);
    lines.push('');

    if (reflection.qualityTrend !== 'initial') {
      lines.push('质量趋势: ' + reflection.qualityTrend);
      lines.push('建议动作: ' + reflection.recommendedAction);
      lines.push('');
    }

    lines.push('请审视你刚才的输出，回答以下问题：');
    reflection.questions.forEach(function(q, i) {
      lines.push((i + 1) + '. ' + q);
    });

    const weakDimensions = Object.entries(reflection.dimensions ?? {})
      .filter(function(entry) { return entry[1] && entry[1].needsAttention; })
      .map(function(entry) { return entry[0]; });

    if (weakDimensions.length > 0) {
      lines.push('');
      lines.push('需要特别关注的维度: ' + weakDimensions.join(', '));
    }

    lines.push('');
    lines.push('请给出一个具体的改进建议。');

    return lines.join('\n');
  }

  /**
   * 执行证伪维度反思，生成证伪提示与反谄媚检查
   * 从"此结论在什么条件下会被推翻"的视角审视产出，包含5条证伪提示和反谄媚检查要求
   * @param {string} [output] - 待证伪审视的产出内容
   * @param {object} [context] - 证伪上下文信息
   * @returns {{type: string, output: string, context: string, falsificationPrompts: Array<string>, antiSycophancyCheck: {question: string, required: boolean}, timestamp: number}} 证伪反思结果
   */
  falsificationReflection(output, context) {
    this.guardShutdown();
    const prompts = [
      '这个结论在什么现实条件下会被证明是错误的？',
      '支持此结论的最弱假设是什么？',
      '如果此方案失败，最可能的失败模式是什么？',
      '什么可观测的信号能证明此方案不可行？',
      '是否存在更简单的替代方案被忽略了？',
    ];

    return {
      type: 'falsification_reflection',
      output: output ?? '',
      context: context ?? '',
      falsificationPrompts: prompts,
      antiSycophancyCheck: {
        question: '你是否在附和而非质疑？',
        required: true,
      },
      timestamp: Date.now(),
    };
  }

  _onShutdown() {
    safeCall(() => this._history.shutdown(), 'SelfReflection', 'shutdown-history');
    this._signalPersistence = null;
    this._stats = { totalReflections: 0, totalImprovements: 0, avgImprovement: 0, _totalDelta: 0 };
    this.removeAllListeners();
  }
}

SelfReflection.REFLECTION_DIMENSIONS = REFLECTION_DIMENSIONS;
SelfReflection.REFLECTION_TEMPLATES = REFLECTION_TEMPLATES;

module.exports = withShutdown(SelfReflection);
