'use strict';

/**
 * 证据验证器模块。定义每种Skill所需的证据类型，验证Agent完成声明是否有足够证据支撑，
 * 并生成结构化验证报告。与 verification-before-completion Skill 配合使用，
 * 是TDD门禁执行器的核心验证组件。
 *
 * 核心职责：
 * - 维护各Skill的证据需求映射表（EVIDENCE_REQUIREMENTS）
 * - 对完成声明进行类型完整性和内容质量双重验证
 * - 评估成功标准强度（强/弱），弱标准需人工确认
 * - 检测证据与记忆-代码一致性，识别过时文件引用
 * - 生成自反思提示，驱动Agent补充不足证据
 *
 * @module gate/evidence-verifier
 * @see {@link module:gate/tdd-gate} TDD门禁执行器
 * @see {@link module:gate/framework-compliance-checker} 框架合规检查器
 *
 * @example
 * const EvidenceVerifier = require('./evidence-verifier');
 * const verifier = new EvidenceVerifier({ verificationThreshold: 0.85 });
 * const result = verifier.verify({
 *   claim: 'Feature X implemented',
 *   evidence: [{ type: 'test_output', content: 'All tests passed' }],
 *   requiredTypes: verifier.getRequiredEvidenceTypes('tdd-implement'),
 * });
 * console.log(result.verified, result.score, result.missing);
 */

const SOFT_REQUIRED_TYPES = ['specification_verified'];

const EVIDENCE_REQUIREMENTS = {
  'tdd-implement': ['test_output', 'coverage_report'],
  'module-development': ['test_output', 'coverage_report', 'lint_output'],
  'code-review': ['review_report'],
  'verification-before-completion': ['test_output', 'coverage_report', 'lint_output', 'security_check'],
  'bug-fix': ['test_output', 'fix_verification'],
  'security-audit': ['security_report'],
  'integration-testing': ['test_output', 'coverage_report'],
  'deployment': ['deployment_verification', 'health_check'],
  'performance-optimization': ['performance_report'],
  'refactor-code': ['test_output', 'refactor_report'],
  'brainstorming': ['design_document'],
  'requirement-analysis': ['requirement_spec'],
  'architecture-design': ['architecture_document'],
  'documentation': ['document_file'],
  'iterative-deepening': ['quality_score_report', 'convergence_report'],
  'multi-agent-fusion': ['fusion_report', 'agent_affinity_report'],
  'pair-chat': ['pair_chat_report', 'correction_summary'],
  'self-reflection': ['reflection_report', 'improvement_record'],
  'auto-doc-generation': ['document_file', 'dependency_list'],
  'design-md': ['design_document', 'anti_pattern_checklist'],
  'taste-skill': ['aesthetic_score_report', 'design_review'],
  'impeccable': ['design_audit_report', 'polish_diff'],
  'ui-skills': ['component_code', 'accessibility_report'],
  'motion-ai-kit': ['motion_css', 'performance_report'],
  'better-icons': ['icon_selection_report'],
  'cloud-ai-blueprint': ['architecture_document', 'ai_blueprint_document'],
  'ai-prompting': ['prompt_template', 'quality_report'],
  'necessity-review': ['necessity_review_report'],
  'dispatching-parallel': ['parallel_execution_report'],
  'systematic-debugging': ['debug_report', 'root_cause_analysis'],
  'writing-skills': ['skill_definition_document'],
};

const DEFAULT_UNKNOWN_SKILL_EVIDENCE = ['test_output', 'coverage_report'];
const REPORT_CONTENT_MAX_LENGTH = 80;
const CONTENT_LENGTH_TIERS = [10, 30, 80];
const { EventEmitter } = require('events');
const { withShutdown } = require('../utils/shutdown-mixin');
const { clamp01 } = require('../utils/safe-execute');
const { debug } = require('../utils/debug-logger');
const safeAssign = require('../utils/safe-assign');

const TYPE_SCORE_WEIGHT = 0.6;
const QUALITY_SCORE_WEIGHT = 0.4;
const BASE_ITEM_SCORE = 0.6;
const CONTENT_LENGTH_BONUS = 0.05;
const METADATA_BONUS = 0.05;
const POSITIVE_SIGNAL_BONUS = 0.1;
const NEGATIVE_SIGNAL_PENALTY = 0.1;
const SHORT_EVIDENCE_PENALTY = 0.5;
const HIGH_SHORT_RATIO_PENALTY = 0.3;
const VAGUE_THRESHOLD_RATIO = 0.5;
const CONSISTENCY_BASE_SCORE = 0.6;
const MEMORY_CONSISTENCY_SCORE = 0.6;

const WEAK_CRITERIA_PATTERNS = [
  /make\s+it\s+work/i,
  /looks?\s+(good|ok|fine|nice)/i,
  /just\s+fix\s+it/i,
  /should\s+be\s+fine/i,
  /seems?\s+(right|correct|ok)/i,
  /大概|差不多|看起来|应该可以|好像/i,
];

const STRONG_CRITERIA_PATTERNS = [
  /test\s*(passes?|green)/i,
  /coverage\s*[>=]\s*\d+/i,
  /lint\s*(passes?|zero\s*error)/i,
  /all\s+tests?\s+pass/i,
  /no\s+(error|warning|violation)/i,
  /测试通过|覆盖率|零错误/i,
  /specification\s*(verified|validated|conforms)/i,
  /规格\s*(验证|确认|一致)/i,
];

/**
 * 评估规格一致性得分。遍历规格验证证据，根据内容中的符合/偏离关键词调整得分。
 * 符合关键词（conforms/verified/一致/符合/validated）加分，偏离关键词（drift/diverge/不一致/偏离）扣分，
 * 完全符合关键词（full conformance/完全符合）额外加分。
 *
 * @param {Array<{content: string}>} specEvidence - 规格验证类型的证据数组
 * @returns {number} 规格一致性得分，范围 [0, 1]
 */
function _assessSpecConformance(specEvidence) {
  if (specEvidence.length === 0) return 0;
  let score = 0.5;
  for (let i = 0; i < specEvidence.length; i++) {
    const content = String(specEvidence[i].content || '');
    if (/conforms|verified|一致|符合|validated/i.test(content)) score += 0.2;
    if (/drift|diverge|不一致|偏离/i.test(content)) score -= 0.3;
    if (/full\s*conformance|完全符合/i.test(content)) score += 0.15;
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * 证据验证器。对Agent的完成声明进行证据充分性验证，确保声称完成的任务有足够证据支撑。
 *
 * 验证流程：
 * 1. 类型完整性检查 — 提供的证据是否覆盖了Skill要求的所有证据类型
 * 2. 内容质量评估 — 证据内容是否详实、具体、一致、可操作
 * 3. 成功标准强度分类 — 强标准（可量化指标）vs 弱标准（模糊描述），弱标准需人工确认
 * 4. 规格-代码一致性检查 — 证据中引用的文件路径是否与已知路径匹配
 * 5. 自反思提示生成 — 验证不通过时生成反思提示，驱动Agent补充证据
 *
 * @classdesc 证据验证器。完成声明验证、成功标准强度分类
 * @class
 * @memberof module:gate/evidence-verifier
 */
class EvidenceVerifier extends EventEmitter {
  /**
   * 创建证据验证器实例。
   *
   * @param {Object} [options] - 配置选项
   * @param {number} [options.verificationThreshold=0.8] - 验证通过阈值，范围 (0, 1]，综合得分达到此值且无硬性缺失时验证通过
   * @param {number} [options.typeScoreWeight=0.6] - 类型完整性得分权重
   * @param {number} [options.qualityScoreWeight=0.4] - 内容质量得分权重
   * @param {Object.<string, string[]>} [options.evidenceRequirements] - 自定义Skill证据需求映射，覆盖默认的EVIDENCE_REQUIREMENTS
   */
  constructor(options) {
    super();
    this._config = safeAssign({
      verificationThreshold: 0.8,
      typeScoreWeight: TYPE_SCORE_WEIGHT,
      qualityScoreWeight: QUALITY_SCORE_WEIGHT,
    }, options);
    this._customRequirements = (options && options.evidenceRequirements) ?? null;
  }

  /**
   * 获取指定Skill所需的证据类型列表。优先使用自定义需求映射，其次使用默认映射，
   * 未知Skill返回默认证据类型（test_output + coverage_report）。
   *
   * @param {string} skillId - Skill标识符，如 'tdd-implement'、'bug-fix' 等
   * @returns {string[]} 所需证据类型数组的副本
   */
  getRequiredEvidenceTypes(skillId) {
    if (this._customRequirements && this._customRequirements[skillId]) {
      return this._customRequirements[skillId].slice();
    }
    return (EVIDENCE_REQUIREMENTS[skillId] ?? DEFAULT_UNKNOWN_SKILL_EVIDENCE).slice();
  }

  /**
   * 设置自定义证据需求映射。仅保留值为字符串数组的有效条目，无效输入将清除自定义映射。
   *
   * @param {Object.<string, string[]>} requirements - Skill到证据类型数组的映射对象
   * @returns {void}
   */
  setEvidenceRequirements(requirements) {
    this.guardShutdown();
    if (requirements && typeof requirements === 'object' && requirements !== null && !Array.isArray(requirements)) {
      const validated = {};
      for (const key of Object.keys(requirements)) {
        const val = requirements[key];
        if (Array.isArray(val) && val.every(function(v) { return typeof v === 'string'; })) {
          validated[key] = val;
        }
      }
      this._customRequirements = validated;
    } else {
      this._customRequirements = null;
    }
  }

  /**
   * 设置验证通过阈值。仅接受 (0, 1] 范围内的数值，非法值静默忽略。
   *
   * @param {number} threshold - 新的验证阈值，范围 (0, 1]
   * @returns {void}
   */
  setVerificationThreshold(threshold) {
    this.guardShutdown();
    if (typeof threshold === 'number' && threshold > 0 && threshold <= 1) {
      this._config.verificationThreshold = threshold;
    }
  }

  /**
   * 分类成功标准的强度。强标准包含可量化指标（如测试通过、覆盖率数值、零错误），
   * 弱标准使用模糊描述（如"看起来没问题""大概可以"）。弱标准需要人工确认。
   *
   * 判定逻辑：
   * - 匹配STRONG_CRITERIA_PATTERNS → 'strong'
   * - 匹配WEAK_CRITERIA_PATTERNS → 'weak'
   * - 包含可量化指标（数值比较、百分比、pass/fail）→ 'strong'
   * - 包含规格相关关键词 → 'strong'
   * - 其他 → 'weak'
   *
   * @param {string} criteriaText - 成功标准文本
   * @returns {'strong'|'weak'} 标准强度分类
   */
  classifyCriteriaStrength(criteriaText) {
    if (!criteriaText || typeof criteriaText !== 'string') return 'weak';
    if (STRONG_CRITERIA_PATTERNS.some(p => p.test(criteriaText))) return 'strong';
    if (WEAK_CRITERIA_PATTERNS.some(p => p.test(criteriaText))) return 'weak';
    const hasMeasurable = /[>=<]\s*\d+|%|pass|fail|error|zero/i.test(criteriaText);
    if (/specification|spec|规格|规格说明/i.test(criteriaText)) return 'strong';
    return hasMeasurable ? 'strong' : 'weak';
  }

  /**
   * 执行证据验证。综合类型完整性和内容质量计算验证得分，
   * 判断完成声明是否有足够证据支撑。
   *
   * 验证规则：
   * - 硬性缺失（非SOFT_REQUIRED_TYPES中的类型）任一存在即判定不通过
   * - 综合得分 = 类型得分 × typeScoreWeight + 质量得分 × qualityScoreWeight
   * - 综合得分低于阈值且存在skillId和agentId时，生成自反思提示
   * - 弱成功标准（criteriaStrength='weak'）需要人工确认
   *
   * @param {VerifyContext} context - 验证上下文
   * @param {string} [context.claim] - 完成声明描述
   * @param {EvidenceItem[]} [context.evidence] - 提供的证据列表
   * @param {string[]} [context.requiredTypes] - 要求的证据类型列表，不提供则使用默认
   * @param {QualityCriteria} [context.qualityCriteria] - 内容质量评估标准
   * @param {string} [context.skillId] - Skill标识符，用于生成反思提示
   * @param {string} [context.agentId] - Agent标识符，用于生成反思提示
   * @param {string|string[]} [context.successCriteria] - 成功标准文本，用于强度分类
   * @returns {VerifyResult} 验证结果
   * @throws {Error} When evidence data is malformed or missing required fields
   */
  verify(context) {
    this.guardShutdown();
    if (!context || typeof context !== 'object') {
      return { verified: false, score: 0, missing: [], summary: 'Invalid context', criteriaStrength: 'strong', requiresHumanConfirmation: false };
    }
    const { claim, evidence, requiredTypes, qualityCriteria } = context;

    const types = requiredTypes || this.getRequiredEvidenceTypes('');
    const validEvidence = Array.isArray(evidence) ? evidence.filter(e => e && e.type && e.content && String(e.content).trim().length > 0) : [];
    const providedTypesSet = new Set(validEvidence.map(e => e.type));
    const missing = types.filter(t => !providedTypesSet.has(t));
    const hardMissing = missing.filter(function(t) { return SOFT_REQUIRED_TYPES.indexOf(t) === -1; });

    const specEvidence = validEvidence.filter(function(e) { return e.type === 'specification_verified'; });
    let specificationConformance = null;
    if (specEvidence.length > 0) {
      specificationConformance = {
        specIds: specEvidence.map(function(e) { return (e.metadata && e.metadata.specId) ?? null; }).filter(Boolean),
        conformanceScore: _assessSpecConformance(specEvidence),
        driftDetected: specEvidence.some(function(e) { return /drift|diverge|不一致|偏离/i.test(e.content || ''); }),
      };
    }

    const typeScore = types.length > 0 ? (types.length - missing.length) / types.length : 1.0;

    let qualityScore = 1.0;
    const qualityIssues = [];
    if (qualityCriteria) {
      const qualityResult = this._verifyContentQuality(validEvidence, qualityCriteria);
      qualityScore = qualityResult.score;
      for (const issue of qualityResult.issues) {
        qualityIssues.push(issue);
      }
    } else {
      qualityScore = this._assessEvidenceQuality(validEvidence);
    }

    const score = typeScore * this._config.typeScoreWeight + qualityScore * this._config.qualityScoreWeight;
    const shouldReflect = !!(score < this._config.verificationThreshold && context.skillId && context.agentId);

    const verified = hardMissing.length === 0 && score >= this._config.verificationThreshold;

    const report = this._generateReport(claim || 'No claim', validEvidence, missing, types, qualityIssues, verified);

    const criteriaText = Array.isArray(context.successCriteria)
      ? context.successCriteria.join(' ')
      : (context.successCriteria || claim);
    const criteriaStrength = this.classifyCriteriaStrength(criteriaText);

    return {
      verified,
      score,
      typeScore,
      qualityScore,
      missing,
      qualityIssues,
      report,
      evidenceCount: validEvidence.length,
      requiredCount: types.length,
      shouldReflect,
      reflectionPrompt: shouldReflect ? this._buildReflectionPrompt(context, missing, qualityIssues) : null,
      criteriaStrength,
      requiresHumanConfirmation: criteriaStrength === 'weak',
      specificationConformance,
    };
  }

  /**
   * 生成人类可读的验证报告文本。包含已提供证据、缺失证据、质量问题和最终验证结果。
   *
   * @private
   * @param {string} claim - 完成声明描述
   * @param {EvidenceItem[]} evidence - 已提供的有效证据列表
   * @param {string[]} missing - 缺失的证据类型列表
   * @param {string[]} requiredTypes - 要求的证据类型列表
   * @param {QualityIssue[]} qualityIssues - 质量问题列表
   * @param {boolean} verified - 是否验证通过
   * @returns {string} 格式化的验证报告文本
   */
  _generateReport(claim, evidence, missing, requiredTypes, qualityIssues, verified) {
    const lines = [`Verification Report for: ${claim}`, ''];

    lines.push('Evidence Provided:');
    for (const e of evidence) {
      const content = (e.content || '').substring(0, REPORT_CONTENT_MAX_LENGTH);
      lines.push(`  ✅ ${e.type}: ${content}`);
    }

    if (missing.length > 0) {
      lines.push('');
      lines.push('Missing Evidence:');
      for (const m of missing) {
        lines.push(`  ❌ ${m}`);
      }
    }

    if (qualityIssues && qualityIssues.length > 0) {
      lines.push('');
      lines.push('Quality Issues:');
      for (const qi of qualityIssues) {
        lines.push(`  ⚠️ ${qi.dimension}: ${qi.description} (severity: ${qi.severity})`);
      }
    }

    lines.push('');
    lines.push(`Result: ${verified ? 'VERIFIED ✅' : 'NOT VERIFIED ❌'} (${evidence.length}/${requiredTypes.length} evidence items)`);

    return lines.join('\n');
  }

  /**
   * 评估证据内容的整体质量。基于内容长度、元数据存在性、正/负信号词和规格一致性计算单项得分，
   * 最终取所有证据项的平均分。
   *
   * 评分维度：
   * - 基础分 0.6
   * - 内容长度超过10/30/80字符各加0.05
   * - 存在metadata加0.05
   * - 包含正向信号词（passed/success/complete）加0.1
   * - 包含负向信号词（failed/error/missing）扣0.1
   * - specification_verified类型且包含符合关键词加0.15
   *
   * @private
   * @param {EvidenceItem[]} evidence - 有效证据列表
   * @returns {number} 质量得分，范围 [0, 1]
   */
  _assessEvidenceQuality(evidence) {
    if (evidence.length === 0) return 0;
    let totalScore = 0;
    for (const e of evidence) {
      let itemScore = BASE_ITEM_SCORE;
      const content = String(e.content || '');
      if (content.length > CONTENT_LENGTH_TIERS[0]) itemScore += CONTENT_LENGTH_BONUS;
      if (content.length > CONTENT_LENGTH_TIERS[1]) itemScore += CONTENT_LENGTH_BONUS;
      if (content.length > CONTENT_LENGTH_TIERS[2]) itemScore += CONTENT_LENGTH_BONUS;
      if (e.metadata) itemScore += METADATA_BONUS;
      if (/passed|success|complete|ok|✅/i.test(content)) itemScore += POSITIVE_SIGNAL_BONUS;
      if (/failed|error|missing|❌/i.test(content)) itemScore -= NEGATIVE_SIGNAL_PENALTY;
      if (e.type === 'specification_verified' && /conforms|verified|一致|符合/i.test(content)) {
        itemScore += 0.15;
      }
      totalScore += clamp01(itemScore);
    }
    return evidence.length ? totalScore / evidence.length : 0;
  }

  /**
   * 执行单维度检查的通用包装器。调用检查函数并将维度名称注入到问题对象中。
   *
   * @private
   * @param {string} dimension - 维度名称，如 'completeness'、'specificity'
   * @param {EvidenceItem[]} evidence - 证据列表
   * @param {function(EvidenceItem[]): DimensionCheckResult} checkFn - 维度检查函数
   * @returns {DimensionCheckResult} 维度检查结果
   */
  _runDimensionCheck(dimension, evidence, checkFn) {
    const result = checkFn(evidence);
    if (result.issue) {
      result.issue.dimension = dimension;
    }
    return result;
  }

  /**
   * 检查证据完整性维度。统计内容过短的证据项比例，短证据过多时扣分。
   * 默认最短长度50字符，短证据占比超过50%时额外扣分。
   *
   * @private
   * @param {EvidenceItem[]} evidence - 证据列表
   * @param {Object} dimConfig - 维度配置
   * @param {number} [dimConfig.minLength=50] - 证据内容最短字符数阈值
   * @returns {DimensionCheckResult} 完整性检查结果
   */
  _checkCompleteness(evidence, dimConfig) {
    return this._runDimensionCheck('completeness', evidence, (ev) => {
      const minLen = dimConfig.minLength ?? 50;
      const shortEvidence = ev.filter(e => String(e.content || '').length < minLen);
      if (shortEvidence.length === 0) return { score: 1.0, issue: null };
      const shortRatio = ev.length ? shortEvidence.length / ev.length : 0;
      let score = 1.0 - SHORT_EVIDENCE_PENALTY * shortRatio;
      if (shortRatio > VAGUE_THRESHOLD_RATIO) score -= HIGH_SHORT_RATIO_PENALTY;
      return {
        score: score,
        issue: { severity: shortRatio > 0.5 ? 'high' : 'medium', description: shortEvidence.length + ' evidence items are too brief (min ' + minLen + ' chars)' },
      };
    });
  }

  /**
   * 检查证据具体性维度。统计缺乏具体术语（长度>5的词）的证据项，
   * 模糊证据占比超过阈值时扣分。
   *
   * @private
   * @param {EvidenceItem[]} evidence - 证据列表
   * @param {Object} dimConfig - 维度配置
   * @param {number} [dimConfig.minKeywords=2] - 最少具体术语数量阈值
   * @returns {DimensionCheckResult} 具体性检查结果
   */
  _checkSpecificity(evidence, dimConfig) {
    return this._runDimensionCheck('specificity', evidence, (ev) => {
      const minKeywords = dimConfig.minKeywords ?? 2;
      const vagueEvidence = ev.filter(e => {
        const content = String(e.content || '').toLowerCase();
        const specificTerms = content.split(/\s+/).filter(w => w.length > 5);
        return specificTerms.length < minKeywords;
      });
      if (vagueEvidence.length <= ev.length * VAGUE_THRESHOLD_RATIO) return { score: 1.0, issue: null };
      return { score: 0.7, issue: { severity: 'medium', description: 'Evidence lacks specificity' } };
    });
  }

  /**
   * 检查证据一致性维度。检测同一证据项中是否包含矛盾信息（同时出现正面和负面信号词，
   * 且上下文不同）。发现矛盾时扣分并标记为高严重度。
   *
   * @private
   * @param {EvidenceItem[]} evidence - 证据列表
   * @returns {DimensionCheckResult} 一致性检查结果
   */
  _checkConsistency(evidence) {
    return this._runDimensionCheck('consistency', evidence, (ev) => {
      for (let i = 0; i < ev.length; i++) {
        const content = String(ev[i].content || '');
        if (content.length <= 10) continue;
        const hasNegative = /\b(?:not|no|never|fail|failed|error|missing|broken)\b/i.test(content);
        const hasPositive = /pass|success|ok|yes|complete|working|fixed/i.test(content);
        if (hasNegative && hasPositive) {
          const negContext = this._extractContext(content, /(?:not|no|never|fail\w*|error|missing|broken)/i);
          const posContext = this._extractContext(content, /(?:pass|success|ok|yes|complet\w*|working|fixed)/i);
          if (negContext && posContext && negContext !== posContext) {
            return { score: CONSISTENCY_BASE_SCORE, issue: { severity: 'high', description: `Evidence item ${i} contains contradictory information: "${negContext}" vs "${posContext}"` } };
          }
        }
      }
      return { score: 1.0, issue: null };
    });
  }

  /**
   * 提取匹配模式周围的上下文文本。在匹配位置前后各取最多20个字符，
   * 用于一致性检查中比较矛盾信息的上下文差异。
   *
   * @private
   * @param {string} content - 源文本内容
   * @param {RegExp} pattern - 要匹配的正则表达式
   * @returns {?string} 匹配位置周围的上下文文本，未匹配则返回null
   */
  _extractContext(content, pattern) {
    let cloned;
    try {
      cloned = new RegExp(pattern.source, pattern.flags);
    } catch (_e) {
      debug('EvidenceVerifier', 'regexCompileFailed', _e && _e.message ? _e.message : String(_e));
      return null;
    }
    const match = cloned.exec(content);
    if (!match) return null;
    const start = Math.max(0, match.index - 20);
    const end = Math.min(content.length, match.index + match[0].length + 20);
    return content.substring(start, end).trim();
  }

  /**
   * 检查证据可操作性维度。检测证据内容是否包含可操作的动作词
   * （如fix/implement/add/remove/change/update/create），缺乏可操作信息时扣分。
   *
   * @private
   * @param {EvidenceItem[]} evidence - 证据列表
   * @returns {DimensionCheckResult} 可操作性检查结果
   */
  _checkActionability(evidence) {
    return this._runDimensionCheck('actionability', evidence, (ev) => {
      const actionableEvidence = ev.filter(e => {
        const content = String(e.content || '').toLowerCase();
        return /fix|implement|add|remove|change|update|create/i.test(content);
      });
      if (actionableEvidence.length > 0 || ev.length === 0) return { score: 1.0, issue: null };
      return { score: 0.7, issue: { severity: 'low', description: 'Evidence lacks actionable information' } };
    });
  }

  /**
   * 检查记忆-代码一致性维度。提取证据中引用的文件路径，与已知路径集合比对，
   * 识别可能过时的文件引用。用于防止Agent引用已删除或重命名的文件。
   *
   * @private
   * @param {EvidenceItem[]} evidence - 证据列表
   * @param {Object} criteria - 质量评估标准
   * @param {string[]} [criteria.knownPaths] - 已知有效文件路径集合
   * @returns {DimensionCheckResult} 记忆-代码一致性检查结果
   */
  _checkMemoryCodeConsistency(evidence, criteria) {
    const pathReferences = evidence.filter(e => {
      const content = String(e.content || '');
      return /(?<![:/])\/[\w.-]+\.(js|ts|py|go|rs|java|jsx|tsx|md|json)\b(?!\/)/i.test(content);
    });
    if (pathReferences.length === 0 || !criteria.knownPaths) return { score: 1.0, issue: null };
    const knownSet = new Set(Array.isArray(criteria.knownPaths) ? criteria.knownPaths : []);
    const staleRefs = pathReferences.filter(e => {
      const matches = String(e.content || '').match(/(?<![:/])\/[\w.-]+\.(js|ts|py|go|rs|java|jsx|tsx|md|json)\b(?!\/)/gi) ?? [];
      return matches.some(m => !knownSet.has(m.replace(/^\//, '')));
    });
    if (staleRefs.length === 0) return { score: 1.0, issue: null };
    return { score: MEMORY_CONSISTENCY_SCORE, issue: { dimension: 'memory_code_consistency', severity: 'high', description: staleRefs.length + ' evidence items reference potentially stale file paths' } };
  }

  /**
   * 多维度内容质量验证。按权重聚合五个维度的检查结果：
   * completeness（完整性）、specificity（具体性）、consistency（一致性）、
   * actionability（可操作性）、memory_code_consistency（记忆-代码一致性）。
   *
   * @private
   * @param {EvidenceItem[]} evidence - 证据列表
   * @param {QualityCriteria} criteria - 质量评估标准，可自定义维度和权重
   * @param {Object} [criteria.dimensions] - 自定义维度配置，键为维度名，值为权重和参数
   * @returns {{score: number, issues: QualityIssue[]}} 质量得分和问题列表
   */
  _verifyContentQuality(evidence, criteria) {
    const issues = [];
    let totalScore = 0;

    const dimensions = criteria.dimensions ?? {
      completeness: { weight: 0.25, minLength: 50 },
      specificity: { weight: 0.25, minKeywords: 2 },
      consistency: { weight: 0.15 },
      actionability: { weight: 0.15 },
      memory_code_consistency: { weight: 0.2 },
    };

    const dimensionCheckers = {
      completeness: (ev, _dc, _cr) => this._checkCompleteness(ev, _dc),
      specificity: (ev, _dc, _cr) => this._checkSpecificity(ev, _dc),
      consistency: (ev, _dc, _cr) => this._checkConsistency(ev),
      actionability: (ev, _dc, _cr) => this._checkActionability(ev),
      memory_code_consistency: (ev, _dc, cr) => this._checkMemoryCodeConsistency(ev, cr),
    };

    for (const [dimName, dimConfig] of Object.entries(dimensions)) {
      const checker = dimensionCheckers[dimName];
      if (!checker) continue;
      const result = checker(evidence, dimConfig, criteria);
      totalScore += result.score * (dimConfig.weight ?? 0.25);
      if (result.issue) issues.push(result.issue);
    }

    const score = Object.keys(dimensions).length > 0 ? totalScore : 1.0;
    return { score: clamp01(score), issues };
  }

  /**
   * 构建证据不足时的自反思提示。列出缺失的证据类型和质量问题，
   * 引导Agent反思原因并提供补充证据的具体计划。
   *
   * @private
   * @param {VerifyContext} context - 验证上下文
   * @param {string[]} missing - 缺失的证据类型列表
   * @param {QualityIssue[]} qualityIssues - 质量问题列表
   * @returns {string} 自反思提示文本
   */
  _buildReflectionPrompt(context, missing, qualityIssues) {
    const lines = ['## 证据不足自反思提示', ''];
    lines.push('Agent: ' + (context.agentId ?? 'unknown') + ' | Skill: ' + (context.skillId ?? 'unknown'));
    lines.push('');
    if (missing.length > 0) {
      lines.push('当前证据完整度不足，缺少以下证据类型：');
      missing.forEach(function(m) { lines.push('  - ' + m); });
    }
    if (qualityIssues && qualityIssues.length > 0) {
      lines.push('');
      lines.push('证据质量问题：');
      qualityIssues.forEach(function(qi) { lines.push('  - [' + qi.severity + '] ' + qi.dimension + ': ' + qi.description); });
    }
    lines.push('');
    lines.push('请反思以下问题：');
    lines.push('1. 为什么这些证据缺失或质量不足？是遗漏还是确实不适用？');
    lines.push('2. 如果不适用，是否有替代证据可以提供？');
    lines.push('3. 缺失的证据是否意味着实现不完整？');
    lines.push('4. 请给出补充证据的具体计划。');
    return lines.join('\n');
  }
}

/**
 * 验证上下文对象，传递给 verify() 方法。
 *
 * @typedef {Object} VerifyContext
 * @property {string} [claim] - 完成声明描述
 * @property {EvidenceItem[]} [evidence] - 提供的证据列表
 * @property {string[]} [requiredTypes] - 要求的证据类型列表
 * @property {QualityCriteria} [qualityCriteria] - 内容质量评估标准
 * @property {string} [skillId] - Skill标识符
 * @property {string} [agentId] - Agent标识符
 * @property {string|string[]} [successCriteria] - 成功标准文本
 */

/**
 * 单条证据项。
 *
 * @typedef {Object} EvidenceItem
 * @property {string} type - 证据类型（如'test_output'、'coverage_report'、'specification_verified'）
 * @property {string} content - 证据内容描述
 * @property {Object} [metadata] - 附加元数据（如specId等）
 */

/**
 * 验证结果对象，由 verify() 方法返回。
 *
 * @typedef {Object} VerifyResult
 * @property {boolean} verified - 是否验证通过（无硬性缺失且得分达到阈值）
 * @property {number} score - 综合得分，范围 [0, 1]
 * @property {number} typeScore - 类型完整性得分，范围 [0, 1]
 * @property {number} qualityScore - 内容质量得分，范围 [0, 1]
 * @property {string[]} missing - 缺失的证据类型列表
 * @property {QualityIssue[]} qualityIssues - 质量问题列表
 * @property {string} report - 人类可读的验证报告文本
 * @property {number} evidenceCount - 提供的有效证据数量
 * @property {number} requiredCount - 要求的证据类型数量
 * @property {boolean} shouldReflect - 是否需要自反思（得分低于阈值且有skillId/agentId）
 * @property {?string} reflectionPrompt - 自反思提示文本，不需要时为null
 * @property {'strong'|'weak'} criteriaStrength - 成功标准强度分类
 * @property {boolean} requiresHumanConfirmation - 弱标准时是否需要人工确认
 * @property {?SpecificationConformance} specificationConformance - 规格一致性信息，无规格证据时为null
 */

/**
 * 质量问题项。
 *
 * @typedef {Object} QualityIssue
 * @property {string} dimension - 问题维度（如'completeness'、'consistency'）
 * @property {string} severity - 严重程度（'high'、'medium'、'low'）
 * @property {string} description - 问题描述
 */

/**
 * 内容质量评估标准。
 *
 * @typedef {Object} QualityCriteria
 * @property {Object.<string, {weight?: number, minLength?: number, minKeywords?: number}>} [dimensions] - 自定义维度配置
 * @property {string[]} [knownPaths] - 已知有效文件路径集合，用于记忆-代码一致性检查
 */

/**
 * 维度检查结果。
 *
 * @typedef {Object} DimensionCheckResult
 * @property {number} score - 维度得分，范围 [0, 1]
 * @property {?QualityIssue} issue - 质量问题，无问题时为null
 */

/**
 * 规格一致性信息。
 *
 * @typedef {Object} SpecificationConformance
 * @property {string[]} specIds - 规格标识符列表
 * @property {number} conformanceScore - 一致性得分，范围 [0, 1]
 * @property {boolean} driftDetected - 是否检测到偏离
 */

EvidenceVerifier.EVIDENCE_REQUIREMENTS = EVIDENCE_REQUIREMENTS;

EvidenceVerifier.prototype._onShutdown = function() {
  this.removeAllListeners();
};

module.exports = withShutdown(EvidenceVerifier);
