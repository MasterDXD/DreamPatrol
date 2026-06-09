'use strict';
/**
 * @module runtime/quality/auto-rein-learning-loop
 * @classdesc 自增强学习循环（AutoReinLearningLoop）—— KEPA闭环核心组件。
 * 连接反思→规则生成，从任务执行结果中自动提取错误模式和改进建议，
 * 生成铁律规则并注册到IronRuleEngine，同时将错误模式注册到ErrorPreventionGuard
 * 实现执行前自动检查历史错误模式并注入警告。内置5个规则模板：
 * null-check、error-handling、resource-cleanup、unbounded-collection、hardcoded-delay。
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeCall } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { timestampId } = require('../../utils/unique-id');
const { debug } = require('../../utils/debug-logger');

const DEFAULT_CONFIG = {
  maxHistorySize: 500,
  maxRuleTemplates: 100,
  minConfidenceForRule: 0.6,
  autoRegisterPatterns: true,
};

const RULE_TEMPLATES = {
  'null-check': {
    pattern: /(\w+)\.\w+\(\)/,
    description: 'Missing null check before method call',
    solution: 'Add null check: if ($1 != null) $1.method()',
    severity: 'warning',
    category: 'reliability',
  },
  'error-handling': {
    pattern: /await\s+\w+\([^)]*\)(?!\s*\.catch|(?!\s*try))/,
    description: 'Missing error handling for async operation',
    solution: 'Wrap in try/catch or add .catch()',
    severity: 'warning',
    category: 'reliability',
  },
  'resource-cleanup': {
    pattern: /new\s+(Server|Connection|Stream|Socket)/,
    description: 'Resource created without cleanup plan',
    solution: 'Ensure shutdown/cleanup in finally block or withShutdown mixin',
    severity: 'info',
    category: 'reliability',
  },
  'unbounded-collection': {
    pattern: /new\s+(Map|Set|Array)\(\)/,
    description: 'Unbounded collection without size limit',
    solution: 'Use BoundedMap, BoundedArray, or LRU cache instead',
    severity: 'warning',
    category: 'reliability',
  },
  'hardcoded-delay': {
    pattern: /setTimeout\([^,]+,\s*\d{4,}\)/,
    description: 'Hardcoded long delay in setTimeout',
    solution: 'Use configurable timeout from config',
    severity: 'info',
    category: 'maintainability',
  },
};

class AutoReinLearningLoop extends EventEmitter {
  /**
   * 创建AutoReinLearningLoop实例。
   * @param {Object} [config] - 配置选项
   * @param {number} [config.maxHistorySize=500] - 学习历史最大条目数
   * @param {number} [config.maxRuleTemplates=100] - 规则模板最大数量
   * @param {number} [config.minConfidenceForRule=0.6] - 生成规则的最低置信度阈值
   * @param {boolean} [config.autoRegisterPatterns=true] - 是否自动注册错误模式到ErrorPreventionGuard
   */
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._ironRuleEngine = null;
    this._errorPreventionGuard = null;
    this._skillMemoryStore = null;
    this._skillImprovementLoop = null;
    this._learningHistory = new BoundedArray(this._config.maxHistorySize);
    this._ruleTemplates = new BoundedMap(this._config.maxRuleTemplates);
    this._stats = { rulesGenerated: 0, patternsRegistered: 0, learningsRecorded: 0, reviewsCompleted: 0 };
    this._initRuleTemplates();
  }

  _initRuleTemplates() {
    for (const [key, template] of Object.entries(RULE_TEMPLATES)) {
      this._ruleTemplates.set(key, { ...template });
    }
  }

  /**
   * 注入IronRuleEngine实例，用于自动注册生成的规则。
   * @param {Object|null} engine - IronRuleEngine实例
   * @returns {AutoReinLearningLoop} this（支持链式调用）
   */
  attachIronRuleEngine(engine) {
    this._ironRuleEngine = engine ?? null;
    return this;
  }

  /**
   * 注入ErrorPreventionGuard实例，用于自动注册错误模式。
   * @param {Object|null} guard - ErrorPreventionGuard实例
   * @returns {AutoReinLearningLoop} this（支持链式调用）
   */
  attachErrorPreventionGuard(guard) {
    this._errorPreventionGuard = guard ?? null;
    return this;
  }

  /**
   * 注入SkillMemoryStore实例，用于按技能存储学习经验。
   * @param {Object|null} store - SkillMemoryStore实例
   * @returns {AutoReinLearningLoop} this（支持链式调用）
   */
  attachSkillMemoryStore(store) {
    this._skillMemoryStore = store ?? null;
    return this;
  }

  /**
   * 注入SkillImprovementLoop实例，用于记录技能学习经验。
   * @param {Object|null} loop - SkillImprovementLoop实例
   * @returns {AutoReinLearningLoop} this（支持链式调用）
   */
  attachSkillImprovementLoop(loop) {
    this._skillImprovementLoop = loop ?? null;
    return this;
  }

  /**
   * 处理任务结果，提取错误模式和改进建议，自动生成规则并注册。
   * 核心流程：提取错误模式→匹配模板→生成规则→注册错误模式→记录学习经验。
   * @param {Object} taskResult - 任务执行结果
   * @param {string} [taskResult.taskId] - 任务ID
   * @param {string} [taskResult.skillId] - 技能ID
   * @param {string} [taskResult.agentId] - Agent ID
   * @param {Array} [taskResult.errors] - 错误列表
   * @param {Object} [taskResult.reflection] - 自反思结果
   * @returns {Promise<{processed: boolean, rulesGenerated: number, patternsRegistered: number, learningsRecorded: number}>} 处理结果统计
   */
  async processTaskResult(taskResult) {
    this.guardShutdown();
    if (!taskResult || typeof taskResult !== 'object') {
      return { processed: false, reason: 'Invalid task result' };
    }

    const result = { processed: true, rulesGenerated: 0, patternsRegistered: 0, learningsRecorded: 0 };

    const errorPatterns = this._extractErrorPatterns(taskResult);
    const ruleCandidates = this._extractRulesFromReflection(taskResult);

    for (const error of errorPatterns) {
      const template = this._matchTemplate(error);
      if (template) {
        const ruleResult = this._generateAndRegisterRule(error, template);
        if (ruleResult.registered) result.rulesGenerated++;
      }

      const patternResult = this._registerErrorPattern(error);
      if (patternResult.registered) result.patternsRegistered++;
    }

    for (const candidate of ruleCandidates) {
      const ruleResult = this._generateAndRegisterRule(candidate, candidate.template ?? this._matchTemplate(candidate));
      if (ruleResult.registered) result.rulesGenerated++;
    }

    if (taskResult.skillId) {
      const learningResult = this._recordLearning(taskResult);
      if (learningResult.recorded) result.learningsRecorded++;
    }

    const historyEntry = {
      id: timestampId('arl-'),
      taskId: taskResult.taskId ?? taskResult.id ?? 'unknown',
      errorCount: errorPatterns.length,
      ruleCandidatesCount: ruleCandidates.length,
      rulesGenerated: result.rulesGenerated,
      patternsRegistered: result.patternsRegistered,
      learningsRecorded: result.learningsRecorded,
      timestamp: Date.now(),
    };
    this._learningHistory.push(historyEntry);
    this._stats.reviewsCompleted++;
    this._stats.rulesGenerated += result.rulesGenerated;
    this._stats.patternsRegistered += result.patternsRegistered;
    this._stats.learningsRecorded += result.learningsRecorded;

    this.emit('task-processed', historyEntry);

    return result;
  }

  _normalizeErrorObj(err) {
    return {
      pattern: typeof err === 'string' ? err : (err.message || err.pattern || String(err)),
      description: err && typeof err === 'object' ? (err.description || '') : '',
      solution: err && typeof err === 'object' ? (err.solution || '') : '',
      confidence: err && typeof err === 'object' ? (err.confidence ?? 0.7) : 0.7,
    };
  }

  _normalizeViolationObj(v) {
    return {
      pattern: v.evidence || v.ruleName || String(v),
      description: v.ruleName || '',
      solution: '',
      confidence: 0.8,
    };
  }

  _extractErrorPatterns(taskResult) {
    const errors = [];
    if (taskResult.errors && Array.isArray(taskResult.errors)) {
      for (const err of taskResult.errors) {
        errors.push(this._normalizeErrorObj(err));
      }
    }
    if (taskResult.error && typeof taskResult.error === 'string') {
      errors.push({ pattern: taskResult.error, description: '', solution: '', confidence: 0.7 });
    }
    if (taskResult.violations && Array.isArray(taskResult.violations)) {
      for (const v of taskResult.violations) {
        errors.push(this._normalizeViolationObj(v));
      }
    }
    return errors;
  }

  _extractRulesFromReflection(taskResult) {
    const candidates = [];
    const reflection = taskResult.reflection ?? taskResult.reflectionResult;
    if (!reflection || typeof reflection !== 'object') return candidates;

    this._extractImprovementCandidates(reflection, candidates);
    this._extractQualityTrendCandidate(reflection, candidates);
    this._extractDimensionCandidates(reflection, candidates);

    return candidates;
  }

  _extractImprovementCandidates(reflection, candidates) {
    if (!reflection.improvements || !Array.isArray(reflection.improvements)) return;
    for (const imp of reflection.improvements) {
      candidates.push({
        pattern: imp.description || imp.dimension || '',
        description: imp.description || '',
        solution: imp.recommendation || '',
        confidence: 0.6,
        template: this._matchTemplate({ pattern: imp.description || '' }),
      });
    }
  }

  _extractQualityTrendCandidate(reflection, candidates) {
    if (reflection.qualityTrend !== 'degrading') return;
    candidates.push({
      pattern: 'quality-degradation',
      description: 'Quality trend is degrading: ' + (reflection.recommendedAction || ''),
      solution: reflection.recommendedAction || 'Review and revise',
      confidence: 0.8,
      template: null,
    });
  }

  _extractDimensionCandidates(reflection, candidates) {
    if (!reflection.dimensions || typeof reflection.dimensions !== 'object') return;
    for (const [dimName, dimValue] of Object.entries(reflection.dimensions)) {
      if (dimValue && dimValue.needsAttention) {
        candidates.push({
          pattern: dimName + '-needs-attention',
          description: 'Dimension ' + dimName + ' needs attention (score: ' + (dimValue.score ?? 'unknown') + ')',
          solution: 'Focus improvement on ' + dimName,
          confidence: 0.7,
          template: null,
        });
      }
    }
  }

  _matchTemplate(errorPattern) {
    if (!errorPattern || !errorPattern.pattern) return null;
    const patternText = typeof errorPattern.pattern === 'string' ? errorPattern.pattern : '';
    let bestMatch = null;
    let bestScore = 0;

    this._ruleTemplates.forEach((template, key) => {
      if (template.pattern instanceof RegExp) {
        if (template.pattern.test(patternText)) {
          const score = 0.8;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = { ...template, key: key };
          }
        }
      }
      const templateDesc = (template.description || '').toLowerCase();
      const patternLower = patternText.toLowerCase();
      if (templateDesc && patternLower.includes(templateDesc.split(' ')[0])) {
        const score = 0.5;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = { ...template, key: key };
        }
      }
    });

    return bestMatch;
  }

  _generateAndRegisterRule(error, template) {
    if (!this._ironRuleEngine) return { registered: false, reason: 'No IronRuleEngine attached' };

    const result = safeExecute(() => {
      const pattern = error.pattern || '';
      const description = error.description || (template ? template.description : '');
      const solution = error.solution || (template ? template.solution : '');
      const severity = (template && template.severity) || 'warning';
      const category = (template && template.category) || 'reliability';

      const ruleResult = this._ironRuleEngine.addPatternRule(
        pattern instanceof RegExp ? pattern : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
        description || 'Auto-generated rule from error pattern',
        solution,
        { severity, category },
      );

      if (ruleResult && ruleResult.added) {
        this.emit('rule-generated', { ruleId: ruleResult.ruleId, pattern: pattern, source: 'auto-rein' });
      }

      return { registered: !!(ruleResult && ruleResult.added), ruleId: ruleResult ? ruleResult.ruleId : null };
    }, 'AutoReinLearningLoop', 'generateAndRegisterRule', { registered: false, reason: 'Internal error' });
    if (result && result.registered === false && result.reason === 'Internal error') {
      try { this.emit('safe-execute-error', { method: 'generateAndRegisterRule', error: 'Internal error' }); } catch (_e) { debug('AutoReinLearningLoop', 'emit:ruleAdded', _e && _e.message ? _e.message : String(_e)); }
    }
    return result;
  }

  _registerErrorPattern(error) {
    if (!this._errorPreventionGuard) return { registered: false, reason: 'No ErrorPreventionGuard attached' };
    if (!this._config.autoRegisterPatterns) return { registered: false, reason: 'Auto-register disabled' };

    const result = safeExecute(() => {
      const regResult = this._errorPreventionGuard.registerErrorPattern({
        pattern: error.pattern || '',
        description: error.description || '',
        solution: error.solution || '',
        confidence: error.confidence ?? 0.7,
      });

      if (regResult && regResult.id) {
        this.emit('pattern-registered', { patternId: regResult.id, pattern: error.pattern });
      }

      return { registered: !!(regResult && regResult.id), patternId: regResult ? regResult.id : null };
    }, 'AutoReinLearningLoop', 'registerErrorPattern', { registered: false, reason: 'Internal error' });
    if (result && result.registered === false && result.reason === 'Internal error') {
      try { this.emit('safe-execute-error', { method: 'registerErrorPattern', error: 'Internal error' }); } catch (_e) { debug('AutoReinLearningLoop', 'emit:patternLearned', _e && _e.message ? _e.message : String(_e)); }
    }
    return result;
  }

  _recordLearning(taskResult) {
    if (!this._skillImprovementLoop) return { recorded: false, reason: 'No SkillImprovementLoop attached' };

    const result = safeExecute(() => {
      const entry = {
        skillId: taskResult.skillId,
        agentId: taskResult.agentId || 'auto-rein',
        whatWorked: taskResult.whatWorked || '',
        whatFailed: taskResult.whatFailed || this._extractWhatFailed(taskResult),
      };

      const learnResult = this._skillImprovementLoop.recordLearning(entry);

      return { recorded: !!(learnResult && learnResult.id), id: learnResult ? learnResult.id : null };
    }, 'AutoReinLearningLoop', 'recordLearning', { recorded: false, reason: 'Internal error' });
    if (result && result.recorded === false && result.reason === 'Internal error') {
      try { this.emit('safe-execute-error', { method: 'recordLearning', error: 'Internal error' }); } catch (_e) { debug('AutoReinLearningLoop', 'emit:qualityImproved', _e && _e.message ? _e.message : String(_e)); }
    }
    return result;
  }

  _extractWhatFailed(taskResult) {
    const parts = [];
    if (taskResult.errors && Array.isArray(taskResult.errors)) {
      for (const err of taskResult.errors) {
        parts.push(typeof err === 'string' ? err : (err.message || String(err)));
      }
    }
    if (taskResult.error) parts.push(taskResult.error);
    if (taskResult.violations && Array.isArray(taskResult.violations)) {
      for (const v of taskResult.violations) {
        parts.push(v.evidence || v.ruleName || String(v));
      }
    }
    return parts.slice(0, 5).join('; ');
  }

  /**
   * 添加自定义规则模板。
   * @param {string} key - 模板唯一标识
   * @param {Object} template - 模板定义
   * @param {RegExp|string} template.pattern - 匹配模式
   * @param {string} template.description - 模式描述
   * @param {string} [template.solution] - 修复建议
   * @param {string} [template.severity='warning'] - 严重级别
   * @returns {boolean} 是否添加成功
   */
  addRuleTemplate(key, template) {
    this.guardShutdown();
    if (!key || !template || !template.pattern) return false;
    this._ruleTemplates.set(key, { ...template });
    return true;
  }

  /**
   * 移除规则模板。
   * @param {string} key - 模板标识
   * @returns {boolean} 是否成功移除
   */
  removeRuleTemplate(key) {
    return this._ruleTemplates.delete(key);
  }

  /**
   * 获取所有规则模板。
   * @returns {Object<string, Object>} 规则模板映射（pattern字段转为字符串）
   */
  getRuleTemplates() {
    const result = {};
    this._ruleTemplates.forEach((template, key) => {
      result[key] = { ...template, pattern: template.pattern instanceof RegExp ? template.pattern.source : template.pattern };
    });
    return result;
  }

  /**
   * 获取统计信息。
   * @returns {{rulesGenerated: number, patternsRegistered: number, learningsRecorded: number, reviewsCompleted: number}} 统计数据
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * 获取学习历史记录。
   * @returns {Array<Object>} 历史条目数组
   */
  getHistory() {
    return this._learningHistory.toArray();
  }

  _onShutdown() {
    this._ironRuleEngine = null;
    this._errorPreventionGuard = null;
    this._skillMemoryStore = null;
    this._skillImprovementLoop = null;
    safeCall(() => this._ruleTemplates.shutdown(), 'AutoReinLearningLoop', 'shutdown-ruleTemplates');
    safeCall(() => this._learningHistory.shutdown(), 'AutoReinLearningLoop', 'shutdown-learningHistory');
    this._stats = { rulesGenerated: 0, patternsRegistered: 0, learningsRecorded: 0, reviewsCompleted: 0 };
    this.removeAllListeners();
  }
}

AutoReinLearningLoop.RULE_TEMPLATES = RULE_TEMPLATES;

module.exports = withShutdown(AutoReinLearningLoop);
