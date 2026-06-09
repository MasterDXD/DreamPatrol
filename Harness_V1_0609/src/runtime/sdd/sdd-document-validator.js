'use strict';

const { EventEmitter } = require('events');
const { safeExecute } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const { debug } = require('../../utils/debug-logger');

const STAGE_REQUIREMENTS = {
  propose: {
    requiredSections: ['problem', 'solution', 'scope', 'stakeholders'],
    qualityGates: ['problemClarity', 'scopeBoundedness', 'stakeholderAlignment'],
  },
  spec: {
    requiredSections: ['functionalRequirements', 'nonFunctionalRequirements', 'constraints', 'acceptanceCriteria'],
    qualityGates: ['requirementCompleteness', 'constraintClarity', 'criteriaMeasurability'],
  },
  design: {
    requiredSections: ['architecture', 'interfaces', 'dataModels', 'errorHandling'],
    qualityGates: ['architectureConsistency', 'interfaceCompleteness', 'errorCoverage'],
  },
  tasks: {
    requiredSections: ['taskBreakdown', 'dependencies', 'estimates', 'riskMitigation'],
    qualityGates: ['taskGranularity', 'dependencyOrdering', 'riskCoverage'],
  },
};

const SECTION_KEYWORDS = {
  problem: ['problem', 'issue', 'challenge', 'pain', 'need'],
  solution: ['solution', 'approach', 'resolve', 'fix', 'address'],
  scope: ['scope', 'boundary', 'in-scope', 'out-of-scope', 'limit'],
  stakeholders: ['stakeholder', 'user', 'owner', 'team', 'actor'],
  functionalRequirements: ['functional', 'feature', 'behavior', 'use-case', 'usecase'],
  nonFunctionalRequirements: ['non-functional', 'performance', 'scalability', 'reliability', 'nfr'],
  constraints: ['constraint', 'limitation', 'restriction', 'boundary'],
  acceptanceCriteria: ['acceptance', 'criteria', 'definition of done', 'dod', 'verify'],
  architecture: ['architecture', 'component', 'module', 'layer', 'system'],
  interfaces: ['interface', 'api', 'contract', 'endpoint', 'protocol'],
  dataModels: ['data model', 'schema', 'entity', 'table', 'database'],
  errorHandling: ['error', 'exception', 'failure', 'retry', 'fallback'],
  taskBreakdown: ['task', 'step', 'work item', 'ticket', 'subtask'],
  dependencies: ['dependency', 'depend', 'prerequisite', 'require', 'blocker'],
  estimates: ['estimate', 'effort', 'duration', 'timeline', 'hours'],
  riskMitigation: ['risk', 'mitigation', 'contingency', 'fallback', 'backup'],
};

const QUALITY_GATE_CHECKS = {
  problemClarity: function(content) {
    const hasProblem = /problem|issue|challenge/i.test(content);
    const hasContext = /context|background|current/i.test(content);
    return { passed: hasProblem && hasContext, score: (hasProblem ? 0.5 : 0) + (hasContext ? 0.5 : 0) };
  },
  scopeBoundedness: function(content) {
    const hasScope = /scope|boundary/i.test(content);
    const hasExclusion = /out.of.scope|exclude|not.include/i.test(content);
    return { passed: hasScope, score: (hasScope ? 0.6 : 0) + (hasExclusion ? 0.4 : 0) };
  },
  stakeholderAlignment: function(content) {
    const hasStakeholder = /stakeholder|user|owner|team/i.test(content);
    return { passed: hasStakeholder, score: hasStakeholder ? 1.0 : 0 };
  },
  requirementCompleteness: function(content) {
    const hasFunctional = /functional|feature|behavior/i.test(content);
    const hasNonFunctional = /non.functional|performance|scalability/i.test(content);
    return { passed: hasFunctional && hasNonFunctional, score: (hasFunctional ? 0.5 : 0) + (hasNonFunctional ? 0.5 : 0) };
  },
  constraintClarity: function(content) {
    const hasConstraint = /constraint|limitation|restriction/i.test(content);
    return { passed: hasConstraint, score: hasConstraint ? 1.0 : 0 };
  },
  criteriaMeasurability: function(content) {
    const hasCriteria = /criteria|acceptance|verify|measure/i.test(content);
    const hasQuantifiable = /\d+%|\d+ms|\d+req|throughput|latency/i.test(content);
    return { passed: hasCriteria, score: (hasCriteria ? 0.6 : 0) + (hasQuantifiable ? 0.4 : 0) };
  },
  architectureConsistency: function(content) {
    const hasArchitecture = /architecture|component|layer/i.test(content);
    const hasPattern = /pattern|principle|strategy/i.test(content);
    return { passed: hasArchitecture, score: (hasArchitecture ? 0.6 : 0) + (hasPattern ? 0.4 : 0) };
  },
  interfaceCompleteness: function(content) {
    const hasInterface = /interface|api|contract|endpoint/i.test(content);
    return { passed: hasInterface, score: hasInterface ? 1.0 : 0 };
  },
  errorCoverage: function(content) {
    const hasError = /error|exception|failure/i.test(content);
    const hasHandling = /retry|fallback|recover|handle/i.test(content);
    return { passed: hasError && hasHandling, score: (hasError ? 0.5 : 0) + (hasHandling ? 0.5 : 0) };
  },
  taskGranularity: function(content) {
    const hasTasks = /task|step|item/i.test(content);
    const hasDetails = /description|detail|subtask/i.test(content);
    return { passed: hasTasks, score: (hasTasks ? 0.6 : 0) + (hasDetails ? 0.4 : 0) };
  },
  dependencyOrdering: function(content) {
    const hasDependency = /depend|prerequisite|blocker/i.test(content);
    const hasOrdering = /order|sequence|priority|before|after/i.test(content);
    return { passed: hasDependency, score: (hasDependency ? 0.6 : 0) + (hasOrdering ? 0.4 : 0) };
  },
  riskCoverage: function(content) {
    const hasRisk = /risk|threat|danger/i.test(content);
    const hasMitigation = /mitigation|contingency|fallback|prevent/i.test(content);
    return { passed: hasRisk, score: (hasRisk ? 0.5 : 0) + (hasMitigation ? 0.5 : 0) };
  },
};

const STAGE_TEMPLATES = {
  propose: [
    '# Proposal Document',
    '',
    '## Problem',
    '<!-- Describe the problem being addressed -->',
    '',
    '## Solution',
    '<!-- Describe the proposed solution -->',
    '',
    '## Scope',
    '<!-- Define the scope and boundaries -->',
    '',
    '### In Scope',
    '<!-- What is included -->',
    '',
    '### Out of Scope',
    '<!-- What is excluded -->',
    '',
    '## Stakeholders',
    '<!-- List the stakeholders involved -->',
    '',
  ].join('\n'),
  spec: [
    '# Specification Document',
    '',
    '## Functional Requirements',
    '<!-- List functional requirements -->',
    '',
    '## Non-Functional Requirements',
    '<!-- List non-functional requirements (performance, scalability, etc.) -->',
    '',
    '## Constraints',
    '<!-- List technical and business constraints -->',
    '',
    '## Acceptance Criteria',
    '<!-- Define measurable acceptance criteria -->',
    '',
  ].join('\n'),
  design: [
    '# Design Document',
    '',
    '## Architecture',
    '<!-- Describe the system architecture -->',
    '',
    '## Interfaces',
    '<!-- Define interfaces and APIs -->',
    '',
    '## Data Models',
    '<!-- Define data models and schemas -->',
    '',
    '## Error Handling',
    '<!-- Describe error handling strategy -->',
    '',
  ].join('\n'),
  tasks: [
    '# Task Breakdown Document',
    '',
    '## Task Breakdown',
    '<!-- Break down the implementation into tasks -->',
    '',
    '## Dependencies',
    '<!-- List task dependencies and ordering -->',
    '',
    '## Estimates',
    '<!-- Provide effort estimates -->',
    '',
    '## Risk Mitigation',
    '<!-- Identify risks and mitigation strategies -->',
    '',
  ].join('\n'),
};

const VALIDATION_PASS_THRESHOLD = 0.6;

const DEFAULT_CONFIG = {
  maxReports: 200,
  threshold: VALIDATION_PASS_THRESHOLD,
};

/**
 * @module runtime/sdd/sdd-document-validator
 * @classdesc 文档验证器（SddDocumentValidator）—— SDD规范驱动子系统的文档质量保障组件。
 * 提供必需章节检查、12项质量门禁、文档模板和跨阶段一致性验证。
 * 支持模糊性检测、矛盾检测和澄清问题生成，确保SDD各阶段文档的完整性和质量。
 */
class SddDocumentValidator extends EventEmitter {
  /**
   * @param {Object} [config={}] - 配置选项
   * @param {number} [config.maxReports=200] - 最大验证报告数量
   * @param {number} [config.threshold=0.6] - 验证通过分数阈值
   */
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._stageRequirements = STAGE_REQUIREMENTS;
    this._sectionKeywords = SECTION_KEYWORDS;
    this._qualityGateChecks = QUALITY_GATE_CHECKS;
    this._templates = STAGE_TEMPLATES;
    this._threshold = this._config.threshold ?? VALIDATION_PASS_THRESHOLD;
    this._reports = new BoundedMap(this._config.maxReports);
    this._shutDown = false;
  }

  /**
   * 关闭验证器，清空所有缓存的验证报告
   */
  shutdown() {
    this._shutDown = true;
    this._reports.clear();
    this.removeAllListeners();
  }

  /**
   * 验证指定阶段的文档内容，综合检查必需章节和质量门禁
   * @param {string} stage - SDD阶段（propose | spec | design | tasks）
   * @param {string} content - 文档内容
   * @returns {{ valid: boolean, score: number, errors: string[], warnings: string[], sectionCheck?: Object, gateCheck?: Object }} 验证结果
   */
  validateDocument(stage, content) {
    if (this._shutDown) return { valid: false, errors: ['Validator is shut down'] };
    const result = safeExecute(() => {
      if (!stage || typeof stage !== 'string') {
        return { valid: false, score: 0, errors: ['Invalid stage'], warnings: [] };
      }
      if (!content || typeof content !== 'string') {
        return { valid: false, score: 0, errors: ['Document content is empty'], warnings: [] };
      }
      const requirements = this._stageRequirements[stage];
      if (!requirements) {
        return { valid: false, score: 0, errors: ['Unknown stage: ' + stage], warnings: [] };
      }
      const sectionCheck = this.checkRequiredSections(stage, content);
      const gateCheck = this.runQualityGates(stage, content);
      const sectionWeight = 0.6;
      const gateWeight = 0.4;
      const score = sectionCheck.score * sectionWeight + gateCheck.score * gateWeight;
      const errors = [];
      const warnings = [];
      for (const missing of sectionCheck.missing) {
        errors.push('Missing required section: ' + missing);
      }
      for (const weak of sectionCheck.weak) {
        warnings.push('Weak section content: ' + weak);
      }
      for (const failed of gateCheck.failed) {
        warnings.push('Quality gate not fully met: ' + failed);
      }
      const valid = score >= this._threshold && errors.length === 0;
      return { valid, score, errors, warnings, sectionCheck, gateCheck };
    }, 'SddDocumentValidator', 'validateDocument', { valid: false, score: 0, errors: ['Internal error'], warnings: [] });
    if (result && result.errors && result.errors.length === 1 && result.errors[0] === 'Internal error') {
      try { this.emit('safe-execute-error', { method: 'validateDocument', error: 'Internal error during validation' }); } catch (_e) { debug('SddDocumentValidator', 'validateDocument-emit', _e && _e.message ? _e.message : String(_e)); }
    }
    return result;
  }

  /**
   * 检查指定阶段文档的必需章节是否完整，区分已存在、内容不足和缺失的章节
   * @param {string} stage - SDD阶段（propose | spec | design | tasks）
   * @param {string} content - 文档内容
   * @returns {{ present: string[], missing: string[], weak: string[], score: number }} 章节检查结果
   */
  checkRequiredSections(stage, content) {
    if (this._shutDown) return { valid: false, errors: ['Validator is shut down'] };
    const requirements = this._stageRequirements[stage];
    if (!requirements || !content || typeof content !== 'string') {
      return { present: [], missing: requirements ? requirements.requiredSections.slice() : [], weak: [], score: 0 };
    }
    const lowerContent = content.toLowerCase();
    const present = [];
    const missing = [];
    const weak = [];
    for (const section of requirements.requiredSections) {
      const keywords = this._sectionKeywords[section] ?? [section.toLowerCase()];
      const found = keywords.some(kw => lowerContent.includes(kw.toLowerCase()));
      if (found) {
        const sectionContent = this._extractSectionContent(content, section);
        if (sectionContent.length > 20) {
          present.push(section);
        } else {
          weak.push(section);
        }
      } else {
        missing.push(section);
      }
    }
    const total = (requirements.requiredSections ?? []).length;
    const score = total > 0 ? (present.length + weak.length * 0.5) / total : 1.0;
    return { present, missing, weak, score };
  }

  /**
   * 对指定阶段的文档内容运行质量门禁检查，返回各门禁的通过/失败状态及分数
   * @param {string} stage - SDD阶段（propose | spec | design | tasks）
   * @param {string} content - 文档内容
   * @returns {{ passed: string[], failed: string[], scores: Object<string, number>, score: number }} 质量门禁检查结果
   */
  runQualityGates(stage, content) {
    if (this._shutDown) return { valid: false, errors: ['Validator is shut down'] };
    const requirements = this._stageRequirements[stage];
    if (!requirements || !content || typeof content !== 'string') {
      return { passed: [], failed: requirements ? requirements.qualityGates.slice() : [], scores: {}, score: 0 };
    }
    const passed = [];
    const failed = [];
    const scores = {};
    let totalScore = 0;
    for (const gate of requirements.qualityGates) {
      const checkFn = this._qualityGateChecks[gate];
      if (!checkFn) {
        failed.push(gate);
        scores[gate] = 0;
        continue;
      }
      try {
        const result = checkFn(content);
        scores[gate] = result.score;
        totalScore += result.score;
        if (result.passed) {
          passed.push(gate);
        } else {
          failed.push(gate);
        }
      } catch (e) {
        debug('SddDocumentValidator', 'qualityGate:' + gate, e);
        failed.push(gate);
        scores[gate] = 0;
      }
    }
    const gateCount = requirements.qualityGates.length;
    const avgScore = gateCount > 0 ? totalScore / gateCount : 1.0;
    return { passed, failed, scores, score: avgScore };
  }

  /**
   * 获取指定合约的验证报告
   * @param {string} contractId - 合约标识
   * @returns {Object|null} 验证报告对象，若不存在则返回 null
   */
  getValidationReport(contractId) {
    if (this._shutDown) return null;
    return this._reports.get(contractId) ?? null;
  }

  /**
   * 设置指定合约的验证报告，若验证器已关闭则不执行
   * @param {string} contractId - 合约标识
   * @param {Object} report - 验证报告对象
   */
  setValidationReport(contractId, report) {
    if (this._shutDown) return;
    this._reports.set(contractId, report);
  }

  /**
   * 获取指定阶段的文档模板
   * @param {string} stage - SDD阶段（propose | spec | design | tasks）
   * @returns {string|null} 模板字符串，若阶段不存在则返回 null
   */
  getStageTemplate(stage) {
    if (this._shutDown) return null;
    return this._templates[stage] ?? null;
  }

  /**
   * 获取指定阶段的文档要求，包含必需章节列表和质量门禁列表
   * @param {string} stage - SDD阶段（propose | spec | design | tasks）
   * @returns {{ requiredSections: string[], qualityGates: string[] }|null} 阶段要求，若阶段不存在则返回 null
   */
  getStageRequirements(stage) {
    if (this._shutDown) return null;
    return this._stageRequirements[stage] ?? null;
  }

  _extractSectionContent(content, sectionName) {
    const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp('##\\s+' + escaped + '[\\s\\S]*?(?=##|$)', 'i'),
      new RegExp('#\\s+' + escaped + '[\\s\\S]*?(?=#|$)', 'i'),
    ];
    for (const p of patterns) {
      const match = content.match(p);
      if (match) return match[0].trim();
    }
    const keywords = this._sectionKeywords[sectionName] ?? [];
    for (const kw of keywords) {
      const idx = content.toLowerCase().indexOf(kw.toLowerCase());
      if (idx >= 0) {
        const end = Math.min(content.length, idx + 200);
        return content.substring(idx, end);
      }
    }
    return '';
  }

  /**
   * 根据文档内容生成澄清问题，涵盖章节内容不足、边界模糊、矛盾冲突等方面
   * @param {string} stage - SDD阶段（propose | spec | design | tasks）
   * @param {string} content - 文档内容
   * @returns {Array<{ section: string, type: string, question: string, severity: string }>} 澄清问题列表
   */
  generateClarificationQuestions(stage, content) {
    if (this._shutDown) return { valid: false, errors: ['Validator is shut down'] };
    if (!stage || !content || typeof content !== 'string') return [];
    const requirements = this._stageRequirements[stage];
    if (!requirements) return [];
    const questions = [];

    for (const section of requirements.requiredSections) {
      const sectionContent = this._extractSectionContent(content, section);
      const sectionQuestions = this._checkSectionClarity(section, sectionContent);
      questions.push(...sectionQuestions);
    }

    const contradictionQuestions = this._checkContradictions(content.toLowerCase());
    questions.push(...contradictionQuestions);

    return questions;
  }

  _checkSectionClarity(section, sectionContent) {
    const questions = [];
    if (sectionContent.length < 30) {
      questions.push({ section, type: 'missing-detail', question: 'Section "' + section + '" lacks sufficient detail. What specific information should be included?', severity: 'high' });
      return questions;
    }
    const sectionChecks = {
      scope: function(c) { return !/out.of.scope|exclude|not.include/i.test(c) ? { type: 'boundary-ambiguity', question: 'Scope section does not define exclusions. What is explicitly out of scope?', severity: 'medium' } : null; },
      acceptanceCriteria: function(c) { return !/\d+%|\d+ms|\d+req|throughput|latency/i.test(c) ? { type: 'non-measurable', question: 'Acceptance criteria lack quantifiable metrics. What specific numbers or thresholds define success?', severity: 'high' } : null; },
      errorHandling: function(c) { return !/retry|fallback|recover/i.test(c) ? { type: 'missing-recovery', question: 'Error handling lacks recovery strategies. What fallback or retry mechanisms should be defined?', severity: 'medium' } : null; },
      dependencies: function(c) { return !/order|sequence|priority|before|after/i.test(c) ? { type: 'ordering-ambiguity', question: 'Dependencies lack execution ordering. In what sequence should dependent tasks be executed?', severity: 'medium' } : null; },
      riskMitigation: function(c) { return !/mitigation|contingency|prevent/i.test(c) ? { type: 'missing-mitigation', question: 'Risks are identified but mitigation strategies are missing. What contingency plans should be defined?', severity: 'high' } : null; },
      interfaces: function(c) { return !/api|endpoint|protocol|method/i.test(c) ? { type: 'vague-interface', question: 'Interface descriptions lack specificity. What API endpoints, methods, or protocols should be defined?', severity: 'medium' } : null; },
    };
    const checkFn = sectionChecks[section];
    if (checkFn) {
      const result = checkFn(sectionContent);
      if (result) questions.push({ section, type: result.type, question: result.question, severity: result.severity });
    }
    if (section === 'functionalRequirements') {
      const reqLines = sectionContent.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('*') || /^\d+\./.test(l.trim()));
      if (reqLines.length < 2) {
        questions.push({ section, type: 'incomplete-requirements', question: 'Functional requirements appear incomplete (only ' + reqLines.length + ' items listed). Are there additional requirements for edge cases, error scenarios, or accessibility?', severity: 'high' });
      }
    }
    return questions;
  }

  _checkContradictions(lowerContent) {
    const questions = [];
    const patterns = [
      { p1: /must\s+(always|never)/i, p2: /may|might|optional/i, desc: 'Conflicting modal language: mandatory vs optional' },
      { p1: /real.time|instant/i, p2: /batch|async|queue/i, desc: 'Conflicting timing requirements: real-time vs batch' },
      { p1: /unlimited|no\s+limit/i, p2: /cap|limit|max|threshold/i, desc: 'Conflicting capacity requirements: unlimited vs capped' },
    ];
    for (const cp of patterns) {
      if (cp.p1.test(lowerContent) && cp.p2.test(lowerContent)) {
        questions.push({ section: 'cross-cutting', type: 'contradiction', question: cp.desc + '. Which requirement takes precedence?', severity: 'high' });
      }
    }
    return questions;
  }

  /**
   * 检测文档中的模糊表述，识别含糊术语并提供具体化建议
   * @param {string} stage - SDD阶段（propose | spec | design | tasks）
   * @param {string} content - 文档内容
   * @returns {Array<{ term: string, suggestion: string }>} 模糊术语及改进建议列表
   */
  detectAmbiguity(stage, content) {
    if (this._shutDown) return { valid: false, errors: ['Validator is shut down'] };
    if (!stage || !content || typeof content !== 'string') return [];
    const ambiguities = [];
    const vagueTerms = [
      { term: /should\s+be\s+fast/i, suggestion: 'Define specific latency threshold (e.g., "response time < 200ms")' },
      { term: /should\s+be\s+scalable/i, suggestion: 'Define target scale (e.g., "handle 10,000 concurrent users")' },
      { term: /user.friendly/i, suggestion: 'Define measurable UX criteria (e.g., "task completion in < 3 clicks")' },
      { term: /reasonable/i, suggestion: 'Replace "reasonable" with specific values or ranges' },
      { term: /appropriate/i, suggestion: 'Replace "appropriate" with specific conditions or criteria' },
      { term: /etc\.|and\s+so\s+on|and\s+more/i, suggestion: 'Replace open-ended list with explicit enumeration' },
      { term: /if\s+needed|as\s+needed|when\s+necessary/i, suggestion: 'Define specific trigger conditions' },
      { term: /tbd|todo|fixme|\?\?\?/i, suggestion: 'Replace placeholder with actual specification' },
    ];
    for (const vt of vagueTerms) {
      if (vt.term.test(content)) {
        ambiguities.push({ term: vt.term.source, suggestion: vt.suggestion });
      }
    }
    return ambiguities;
  }
}

SddDocumentValidator.STAGE_REQUIREMENTS = STAGE_REQUIREMENTS;
SddDocumentValidator.SECTION_KEYWORDS = SECTION_KEYWORDS;
SddDocumentValidator.QUALITY_GATE_CHECKS = QUALITY_GATE_CHECKS;
SddDocumentValidator.STAGE_TEMPLATES = STAGE_TEMPLATES;

module.exports = SddDocumentValidator;
