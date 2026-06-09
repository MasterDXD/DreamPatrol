'use strict';

const { EventEmitter } = require('events');
const errors = require('../errors');
const { mergeConfig } = require('../utils/safe-assign');
const { withShutdown } = require('../utils/shutdown-mixin');
const { emitError, clamp01 } = require('../utils/safe-execute');
const { debug } = require('../utils/debug-logger');

/**
 * @module gate/generator-verifier
 * 生成器验证器。五维度正确性验证（逻辑正确性、需求对齐、边界覆盖、场景覆盖、一致性/完整性），
 * 支持迭代验证循环、可配置通过阈值和Agent专属验证器分配。
 */

/** @constant {object} VERIFIER_AGENTS - 技能到验证Agent的映射 */
const VERIFIER_AGENTS = {
  'tdd-implement': 'quality-assurance',
  'module-development': 'quality-assurance',
  'code-review': 'quality-assurance',
  'verification-before-completion': 'domain-analyst',
  'bug-fix': 'quality-assurance',
  'security-audit': 'quality-assurance',
  'integration-testing': 'domain-analyst',
  'deployment': 'quality-assurance',
  'architecture-design': 'quality-assurance',
  'iterative-deepening': 'domain-analyst',
  'multi-agent-fusion': 'domain-analyst',
};

/** @constant {object} CORRECTNESS_DIMENSIONS - 正确性维度定义及权重 */
const CORRECTNESS_DIMENSIONS = {
  logical_correctness: {
    weight: 0.25,
    description: '逻辑正确性：输出是否在逻辑上自洽，无矛盾',
    checkPrompt: '检查输出中是否存在逻辑矛盾、循环依赖或自相矛盾的陈述',
  },
  requirement_alignment: {
    weight: 0.20,
    description: '需求对齐度：输出是否满足原始需求的全部要求',
    checkPrompt: '检查输出是否覆盖了原始需求的所有要点，是否有遗漏或偏离',
  },
  boundary_coverage: {
    weight: 0.15,
    description: '边界覆盖度：是否考虑了边界条件和异常场景',
    checkPrompt: '检查是否覆盖了边界条件、空值、极端情况和异常路径',
  },
  scenario_coverage: {
    weight: 0.15,
    description: '场景覆盖度：是否覆盖了所有定义的行为场景',
    checkPrompt: '检查输出是否覆盖了SkillInterface中定义的所有Given-When-Then场景',
  },
  consistency: {
    weight: 0.15,
    description: '一致性：输出是否与已有代码/文档风格一致',
    checkPrompt: '检查输出是否与项目现有的命名规范、代码风格和架构模式一致',
  },
  completeness: {
    weight: 0.10,
    description: '完整性：输出是否包含所有必要的部分',
    checkPrompt: '检查输出是否包含所有必要的部分，如错误处理、文档注释、类型定义等',
  },
};

/**
 * @classdesc 生成器验证器。5维度评估（逻辑/需求/边界/一致性/完整性）
 * 生成器验证器。五维度正确性验证（逻辑正确性、需求对齐、边界覆盖、场景覆盖、一致性/完整性），
 * 支持迭代验证循环、可配置通过阈值、Agent专属验证器分配和记忆-代码一致性检查。
 * @extends EventEmitter
 * @emits verification-complete | verification-error
 */
class GeneratorVerifier extends EventEmitter {
  /**
   * 创建GeneratorVerifier实例。
   * @param {object} [options] - 配置选项
   * @param {number} [options.maxIterations=3] - 最大验证迭代次数
   * @param {number} [options.passThreshold=0.8] - 通过阈值（0-1）
   * @param {object} [options.customVerifiers] - 自定义验证Agent映射
   * @param {number} [options.maxHistory=500] - 最大验证历史记录数
   * @throws {HarnessError} CORRECTNESS_DIMENSIONS权重之和不为1.0时抛出CONFIG_INVALID错误
   */
  constructor(options) {
    super();
    const totalWeight = Object.values(CORRECTNESS_DIMENSIONS).reduce((sum, d) => sum + d.weight, 0);
    if (Math.abs(totalWeight - 1.0) > 0.001) {
      throw new errors.HarnessError('CONFIG_INVALID', 'CORRECTNESS_DIMENSIONS weights must sum to 1.0, got ' + totalWeight);
    }
    this._maxIterations = typeof (options && options.maxIterations) === 'number' && Number.isFinite(options.maxIterations) && options.maxIterations > 0 ? options.maxIterations : 3;
    this._passThreshold = typeof (options && options.passThreshold) === 'number' && Number.isFinite(options.passThreshold) && options.passThreshold >= 0 && options.passThreshold <= 1 ? options.passThreshold : 0.8;
    this._verifierAgents = mergeConfig(VERIFIER_AGENTS, (options && options.customVerifiers) ?? {});
    this._history = [];
    this._maxHistory = typeof (options && options.maxHistory) === 'number' && Number.isFinite(options.maxHistory) ? options.maxHistory : 500;
  }

  /**
   * 获取指定技能的验证Agent。
   * @param {string} skillId - 技能ID
   * @returns {string} 验证Agent名称
   */
  getVerifierAgent(skillId) {
    return this._verifierAgents[skillId] ?? 'quality-assurance';
  }

  /**
   * 验证AI生成输出的正确性，按五维度评估并计算加权综合评分。
   * @param {object} context - 验证上下文
   * @param {string} [context.skillId] - 技能ID
   * @param {string} [context.generatorAgent] - 生成Agent名称
   * @param {*} context.output - 待验证的输出
   * @param {Array} [context.requirements] - 需求列表
   * @param {Array} [context.evidence] - 证据列表
   * @param {number} [context.iteration] - 当前迭代次数
   * @returns {{passed: boolean, score: number, dimensions: object, feedback: Array, verifierAgent: string, generatorAgent: string, skillId: string, iteration: number, summary: string}} 验证结果
   * @emits GeneratorVerifier#verification-complete
   * @example
   * const verifier = new GeneratorVerifier({ passThreshold: 0.8 });
   * const result = verifier.verifyCorrectness({
   *   skillId: 'tdd-implement',
   *   output: 'class Foo { bar() { return 1; } }',
   *   requirements: ['must return number'],
   * });
   * console.log(result.passed, result.score);
   */
  verifyCorrectness(context) {
    this.guardShutdown();
    if (!context || typeof context !== 'object') {
      return {
        passed: false,
        score: 0,
        dimensions: {},
        feedback: [],
        iteration: 0,
        summary: 'Invalid context',
      };
    }

    const {
      skillId,
      generatorAgent,
      output,
      requirements,
      evidence,
    } = context;

    const verifierAgent = this.getVerifierAgent(skillId);
    const dimensions = {};
    const feedback = [];
    let totalScore = 0;

    for (const [dimName, dimConfig] of Object.entries(CORRECTNESS_DIMENSIONS)) {
      const dimResult = this._evaluateDimension(dimName, dimConfig, output, requirements, evidence);
      dimensions[dimName] = {
        score: dimResult.score,
        weight: dimConfig.weight,
        weightedScore: dimResult.score * dimConfig.weight,
        issues: dimResult.issues,
        checkPrompt: dimConfig.checkPrompt,
      };
      totalScore += dimResult.score * dimConfig.weight;

      for (const issue of dimResult.issues) {
        feedback.push({
          dimension: dimName,
          severity: issue.severity,
          description: issue.description,
          suggestion: issue.suggestion,
        });
      }
    }

    const passed = totalScore >= this._passThreshold;
    const result = {
      passed,
      score: totalScore,
      dimensions,
      feedback,
      verifierAgent,
      generatorAgent: generatorAgent ?? 'unknown',
      skillId: skillId ?? 'unknown',
      iteration: (context.iteration ?? 0) + 1,
      summary: this._generateSummary(passed, totalScore, feedback),
    };

    this._recordVerification(result);
    this.emit('verification-complete', result);
    return result;
  }

  /**
   * 创建验证循环对象。
   * @param {object} context - 验证上下文
   * @returns {{context: object, iterations: Array, currentIteration: number, maxIterations: number, finalResult: object|null, converged: boolean}} 验证循环对象
   */
  createVerificationLoop(context) {
    this.guardShutdown();
    const loop = {
      context,
      iterations: [],
      currentIteration: 0,
      maxIterations: this._maxIterations,
      finalResult: null,
      converged: false,
    };

    return loop;
  }

  /**
   * 执行迭代验证循环，交替验证和重新生成直到通过或达到最大迭代次数。
   * @param {object} loop - 验证循环对象
   * @param {Function} [generateFn] - 重新生成函数，接收上下文返回新输出
   * @param {Function} [verifyFn] - 自定义验证函数，接收上下文返回验证结果
   * @returns {Promise<{converged: boolean, iterations: Array, finalResult: object, totalIterations: number, error?: string}>} 循环执行结果
   * @emits GeneratorVerifier#verification-error
   */
  async executeVerificationLoop(loop, generateFn, verifyFn) {
    const results = [];
    let currentOutput = loop.context.output;
    let iteration = 0;

    while (iteration < this._maxIterations) {
      iteration++;
      const verifyContext = mergeConfig(loop.context, {
        output: currentOutput,
        iteration: iteration - 1,
      });

      let verifyResult;
      try {
        verifyResult = verifyFn ? await Promise.resolve(verifyFn(verifyContext)) : this.verifyCorrectness(verifyContext);
      } catch (err) {
        emitError(this, 'verification-error', err, { iteration, phase: 'verify' });
        const errMsg = err && err.message ? err.message : String(err);
        results.push({ passed: false, score: 0, feedback: [{ dimension: 'verification', severity: 'critical', description: errMsg, suggestion: 'Fix verification function' }], error: errMsg });
        return {
          converged: false,
          iterations: results,
          finalResult: results.length > 0 ? results[results.length - 1] : null,
          totalIterations: iteration,
          error: errMsg,
        };
      }
      results.push(verifyResult);

      if (verifyResult.passed) {
        return {
          converged: true,
          iterations: results,
          finalResult: verifyResult,
          totalIterations: iteration,
        };
      }

      if (iteration < this._maxIterations && generateFn) {
        const regenerateContext = mergeConfig(loop.context, {
          output: currentOutput,
          feedback: verifyResult.feedback,
          iteration,
        });
        try {
          currentOutput = await Promise.resolve(generateFn(regenerateContext));
        } catch (err) {
          emitError(this, 'verification-error', err, { iteration, phase: 'generate' });
          return {
            converged: false,
            iterations: results,
            finalResult: verifyResult,
            totalIterations: iteration,
            error: err && err.message ? err.message : String(err),
          };
        }
      }
    }

    return {
      converged: false,
      iterations: results,
      finalResult: results.length > 0 ? results[results.length - 1] : null,
      totalIterations: iteration,
    };
  }

  /**
   * 获取验证历史记录。
   * @param {string} [skillId] - 按技能ID过滤
   * @param {number} [limit=10] - 返回记录数上限
   * @returns {Array<object>} 验证历史列表
   */
  getVerificationHistory(skillId, limit) {
    let filtered = this._history;
    if (skillId) {
      filtered = filtered.filter(h => h.skillId === skillId);
    }
    const n = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : 10;
    return filtered.slice(-n);
  }

  /**
   * 获取验证器统计信息。
   * @returns {{totalVerifications: number, passedCount: number, failedCount: number, passRate: number, averageScore: number, dimensionAverages: object, verifierAgents: number}} 统计信息
   */
  getStats() {
    const total = this._history.length;
    const passed = this._history.reduce((c, h) => c + (h.passed ? 1 : 0), 0);
    const byDimension = {};
    for (const h of this._history) {
      for (const [dim, val] of Object.entries(h.dimensions ?? {})) {
        if (!byDimension[dim]) byDimension[dim] = { total: 0, sum: 0 };
        byDimension[dim].total++;
        byDimension[dim].sum += val.score;
      }
    }
    const dimensionAverages = {};
    for (const [dim, data] of Object.entries(byDimension)) {
      dimensionAverages[dim] = data.total > 0 ? data.sum / data.total : 0;
    }
    return {
      totalVerifications: total,
      passedCount: passed,
      failedCount: total - passed,
      passRate: total > 0 ? passed / total : 0,
      averageScore: total > 0 ? this._history.reduce((s, h) => s + h.score, 0) / total : 0,
      dimensionAverages,
      verifierAgents: Object.keys(this._verifierAgents).length,
    };
  }

  _evaluateDimension(dimName, dimConfig, output, requirements, evidence) {
    if (!output || (typeof output === 'string' && output.trim().length === 0)) {
      return { score: 0, issues: [{ severity: 'critical', description: '输出为空', suggestion: '提供有效输出' }] };
    }

    let outputStr;
    try {
      outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    } catch (_e) {
      debug('GeneratorVerifier', '_evaluateLogic', _e && _e.message ? _e.message : String(_e));
      outputStr = String(output);
    }
    let score = 1.0;
    const issues = [];

    const DIMENSION_CHECKS = {
      logical_correctness: () => this._checkLogicalCorrectness(outputStr, issues),
      requirement_alignment: () => this._checkRequirementAlignment(outputStr, requirements, issues),
      boundary_coverage: () => this._checkBoundaryCoverage(outputStr, issues),
      scenario_coverage: () => this._checkScenarioCoverage(outputStr, requirements, evidence, issues),
      consistency: () => this._checkConsistency(outputStr, issues),
      completeness: () => this._checkCompleteness(evidence, issues),
    };

    const checker = DIMENSION_CHECKS[dimName];
    if (checker) {
      score = checker();
    }

    score = clamp01(score);
    return { score, issues };
  }

  _checkLogicalCorrectness(outputStr, issues) {
    let score = 1.0;
    const contradictionPatterns = [
      { pattern: /必须[^，。；\n]{0,6}不能(?!遗漏|丢失|重复|缺少|忘记)/, severity: 'critical', desc: '包含矛盾指令' },
      { pattern: /始终[^，。；\n]{0,6}从不/, severity: 'high', desc: '包含绝对矛盾' },
      { pattern: /must\s+[^.]*?\bcannot\b(?!\s*(?:be\s+)?(?:omit|miss|lose|forget|duplicate|lack))/i, severity: 'critical', desc: 'Contains contradictory instructions' },
      { pattern: /always\s+[^.]*?\bnever\b/i, severity: 'high', desc: 'Contains absolute contradiction' },
      { pattern: /required.*forbidden/i, severity: 'critical', desc: 'Contains contradictory instructions' },
    ];
    for (const cp of contradictionPatterns) {
      if (cp.pattern.test(outputStr)) {
        issues.push({ severity: cp.severity, description: cp.desc, suggestion: '消除矛盾表述' });
        score -= 0.3;
      }
    }
    return score;
  }

  _checkRequirementAlignment(outputStr, requirements, issues) {
    let score = 1.0;
    if (!requirements) {
      issues.push({ severity: 'high', description: '未提供需求定义，无法验证需求对齐度', suggestion: '提供 requirements 数组以启用需求对齐验证' });
      return 0.5;
    }
    const reqList = Array.isArray(requirements) ? requirements : [requirements];
    for (const req of reqList) {
      let reqStr;
      try {
        reqStr = typeof req === 'string' ? req : JSON.stringify(req ?? '');
      } catch (_e) {
        debug('GeneratorVerifier', '_evaluateRequirements', _e && _e.message ? _e.message : String(_e));
        reqStr = String(req ?? '');
      }
      const keywords = reqStr.split(/[,，\s]+/).filter(w => w.length > 3);
      const covered = keywords.some(kw => outputStr.toLowerCase().includes(kw.toLowerCase()));
      if (!covered && keywords.length > 0) {
        issues.push({ severity: 'medium', description: `需求未覆盖: ${reqStr.slice(0, 60)}`, suggestion: `补充对以下需求的响应: ${reqStr.slice(0, 60)}` });
        score -= 0.2;
      }
    }
    return score;
  }

  _checkBoundaryCoverage(outputStr, issues) {
    let score = 1.0;
    const boundarySignals = ['边界', '异常', '空值', 'null', 'undefined', 'error', 'catch', 'fallback', 'default'];
    const hasBoundary = boundarySignals.some(s => outputStr.toLowerCase().includes(s));
    if (!hasBoundary) {
      issues.push({ severity: 'medium', description: '未考虑边界条件和异常处理', suggestion: '添加边界条件检查和异常处理逻辑' });
      score -= 0.25;
    }
    return score;
  }

  _checkConsistency(outputStr, issues) {
    let score = 1.0;
    const namingPatterns = outputStr.match(/[a-z_]+[A-Z][a-z]+/g);
    if (namingPatterns && namingPatterns.length > 3) {
      const camelCase = namingPatterns.filter(p => /^[a-z]+[A-Z]/.test(p));
      const snakeCase = namingPatterns.filter(p => /_/.test(p));
      if (camelCase.length > 0 && snakeCase.length > 0 && camelCase.length !== snakeCase.length) {
        issues.push({ severity: 'low', description: '命名风格不一致（混用camelCase和snake_case）', suggestion: '统一命名风格' });
        score -= 0.1;
      }
    }
    return score;
  }

  _checkCompleteness(evidence, issues) {
    let score = 1.0;
    if (evidence && Array.isArray(evidence)) {
      const evidenceTypes = new Set(evidence.filter(e => e && e.type).map(e => e.type));
      if (evidenceTypes.size < 2) {
        issues.push({ severity: 'medium', description: '证据类型不足，缺少关键验证', suggestion: '补充更多类型的验证证据' });
        score -= 0.2;
      }
    }
    return score;
  }

  _checkScenarioCoverage(outputStr, requirements, evidence, issues) {
    let score = 1.0;
    const scenarioSignals = ['given', 'when', 'then', 'scenario', '场景', '前提', '操作', '预期'];
    const hasScenario = scenarioSignals.some(s => outputStr.toLowerCase().includes(s));
    if (!hasScenario) {
      if (requirements && Array.isArray(requirements) && requirements.length > 0) {
        issues.push({ severity: 'medium', description: '未覆盖行为场景定义，缺少Given-When-Then结构', suggestion: '为每个需求添加Given-When-Then场景描述' });
        score -= 0.3;
      }
    }
    if (hasScenario && evidence && Array.isArray(evidence)) {
      const scenarioEvidence = evidence.filter(e => e && e.type === 'scenario_result');
      if (scenarioEvidence.length === 0) {
        issues.push({ severity: 'low', description: '定义了场景但缺少场景验证证据', suggestion: '为每个场景提供scenario_result类型的验证证据' });
        score -= 0.1;
      }
    }
    return score;
  }

  _generateSummary(passed, score, feedback) {
    const criticals = feedback.filter(f => f.severity === 'critical');
    const highs = feedback.filter(f => f.severity === 'high');
    const lines = [];
    lines.push(passed ? '✅ 验证通过' : '❌ 验证未通过');
    lines.push(`综合评分: ${(score * 100).toFixed(1)}%`);
    if (criticals.length > 0) lines.push(`严重问题: ${criticals.length}个`);
    if (highs.length > 0) lines.push(`高级问题: ${highs.length}个`);
    if (feedback.length > 0) lines.push(`总反馈: ${feedback.length}条`);
    return lines.join(' | ');
  }

  _recordVerification(result) {
    this._history.push({
      passed: result.passed,
      score: result.score,
      skillId: result.skillId,
      verifierAgent: result.verifierAgent,
      generatorAgent: result.generatorAgent,
      iteration: result.iteration,
      dimensions: result.dimensions,
      timestamp: Date.now(),
    });
    if (this._history.length > this._maxHistory) {
      this._history.splice(0, this._history.length - this._maxHistory);
    }
  }

  _onShutdown() {
    this._history = [];
    this._maxIterations = 3;
    this._passThreshold = 0.8;
    this._verifierAgents = mergeConfig(VERIFIER_AGENTS);
    this._maxHistory = 500;
    this.removeAllListeners();
  }
}

GeneratorVerifier.VERIFIER_AGENTS = VERIFIER_AGENTS;
GeneratorVerifier.CORRECTNESS_DIMENSIONS = CORRECTNESS_DIMENSIONS;

module.exports = withShutdown(GeneratorVerifier);
