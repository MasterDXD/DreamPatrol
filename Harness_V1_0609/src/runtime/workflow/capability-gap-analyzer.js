'use strict';

/**
 * @module runtime/workflow/capability-gap-analyzer
 * @classdesc 能力缺口分析器（CapabilityGapAnalyzer）—— Harness Engineering 核心组件。
 *
 * 当 AI Agent 执行任务失败时，不是简单地"再试一次"，而是回溯分析环境
 * 缺少了什么能力。CapabilityGapAnalyzer 负责系统性诊断当前项目环境中的
 * 能力缺口，涵盖六个维度：
 *   - 技能（Skills）：缺少哪些技能定义
 *   - 工具（Tools）：缺少哪些开发工具/CLI
 *   - 规则（Rules）：缺少哪些 Lint 规则/代码规范
 *   - CI/CD：缺少哪些流水线步骤
 *   - 文档（Docs）：缺少哪些文档/规范
 *   - 测试（Tests）：缺少哪些测试覆盖
 *
 * 对应 Harness Engineering 三大核心职责中的"设计环境"和"构建反馈"。
 *
 * @example
 * const analyzer = new CapabilityGapAnalyzer();
 * const gaps = await analyzer.analyze({
 *   task: 'build a full-stack web app with authentication',
 *   availableSkills: ['requirement-analysis', 'tdd-implement'],
 *   environment: { hasCI: false, hasLint: false, hasTests: false },
 * });
 * console.log(gaps.recommendations);
 */

const { EventEmitter } = require('events');
const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { safeCall } = require('../../utils/safe-execute');

/** @constant {number} MAX_CAPABILITIES - 能力注册表最大条目数 */
const MAX_CAPABILITIES = 500;

/** @constant {Object} DEFAULT_CONFIG - 默认配置 */
const DEFAULT_CONFIG = {
  maxRecommendations: 20,
  severityThreshold: 'low',
  autoPrioritize: true,
  historySize: 100,
};

/** @constant {Set<string>} GAP_DIMENSIONS - 六维能力缺口维度 */
const GAP_DIMENSIONS = new Set([
  'skills',
  'tools',
  'rules',
  'cicd',
  'docs',
  'tests',
]);

/** @constant {Object<string, number>} SEVERITY_WEIGHTS - 严重程度权重 */
const SEVERITY_WEIGHTS = {
  critical: 100,
  high: 70,
  medium: 40,
  low: 10,
};

/** @constant {string[]} FOUNDATIONAL_SKILLS - 每种任务类型的基础技能要求 */
const FOUNDATIONAL_SKILLS = {
  'fullstack-build': [
    'requirement-analysis', 'architecture-design', 'tdd-implement',
    'module-development', 'code-review', 'integration-testing',
    'deployment', 'verification-before-completion',
  ],
  'api-development': [
    'requirement-analysis', 'api-design', 'tdd-implement',
    'code-review', 'integration-testing', 'deployment',
  ],
  'bug-fix': [
    'systematic-debugging', 'bug-fix', 'code-review',
    'verification-before-completion',
  ],
  'refactoring': [
    'architecture-design', 'code-review', 'module-development',
    'integration-testing', 'verification-before-completion',
  ],
  'documentation': [
    'document-parsing', 'code-wiki-generation', 'verification-before-completion',
  ],
  'research': [
    'brainstorming', 'ai-research', 'requirement-analysis', 'architecture-design',
  ],
};

/** @constant {string[]} ESSENTIAL_TOOLS - 基础开发工具 */
const ESSENTIAL_TOOLS = [
  'git', 'node', 'npm',
];

/** @constant {string[]} ESSENTIAL_LINT_RULES - 基础代码规范 */
const ESSENTIAL_LINT_RULES = [
  'eslint', 'no-unused-vars', 'no-console',
  'complexity', 'max-lines',
];

/** @constant {string[]} ESSENTIAL_CI_STEPS - CI/CD基础步骤 */
const ESSENTIAL_CI_STEPS = [
  'lint', 'test', 'build',
];

/** @constant {string[]} ESSENTIAL_DOCS - 基础文档 */
const ESSENTIAL_DOCS = [
  'README', 'API-docs', 'architecture-overview',
];

/** @constant {string[]} ESSENTIAL_TEST_TYPES - 基础测试类型 */
const ESSENTIAL_TEST_TYPES = [
  'unit-tests', 'integration-tests',
];

/**
 * 能力缺口分析器。
 * 系统性诊断项目环境中的能力缺口，返回可操作的改进建议。
 *
 * @extends EventEmitter
 * @emits CapabilityGapAnalyzer#gap-identified
 * @emits CapabilityGapAnalyzer#analysis-complete
 * @emits CapabilityGapAnalyzer#recommendation-added
 */
class CapabilityGapAnalyzer extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxRecommendations=20] - 最大推荐数量
   * @param {string} [options.severityThreshold='low'] - 最低严重程度阈值
   * @param {boolean} [options.autoPrioritize=true] - 是否自动排序推荐
   * @param {number} [options.historySize=100] - 分析历史最大条目数
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._gaps = new Map();
    this._recommendations = [];
    this._analysisHistory = [];
    this._capabilityRegistry = new Map();
    this._shutDown = false;
    this._shuttingDown = false;
  }

  /**
   * 守卫方法，若实例已关闭则抛出错误。
   * @throws {Error} 实例已关闭时抛出
   */
  guardShutdown() {
    if (this._shutDown) throw new Error('CapabilityGapAnalyzer is shut down');
  }

  /**
   * 注册一个已知能力到注册表，用于后续缺口对比。
   * @param {string} dimension - 能力维度（skills/tools/rules/cicd/docs/tests）
   * @param {string} name - 能力名称
   * @param {Object} [metadata] - 能力元数据
   * @returns {{success: boolean, error?: string}} 注册结果
   */
  registerCapability(dimension, name, metadata) {
    this.guardShutdown();
    if (!GAP_DIMENSIONS.has(dimension)) {
      return { success: false, error: 'Invalid dimension: ' + dimension + '. Must be one of: ' + [...GAP_DIMENSIONS].join(', ') };
    }
    if (!name || typeof name !== 'string') {
      return { success: false, error: 'Capability name must be a non-empty string' };
    }
    const key = dimension + ':' + name;
    if (this._capabilityRegistry.size >= MAX_CAPABILITIES) {
      const oldestKey = this._capabilityRegistry.keys().next().value;
      this._capabilityRegistry.delete(oldestKey);
    }
    this._capabilityRegistry.set(key, {
      dimension,
      name,
      registeredAt: Date.now(),
      metadata: metadata ?? {},
    });
    this.emit('recommendation-added', { dimension, name });
    return { success: true };
  }

  /**
   * 批量注册已知能力。
   * @param {Array<{dimension: string, name: string, metadata?: Object}>} capabilities - 能力列表
   * @returns {{success: boolean, registered: number, errors: Array}} 注册结果
   */
  registerCapabilities(capabilities) {
    this.guardShutdown();
    if (!Array.isArray(capabilities)) {
      return { success: false, registered: 0, errors: ['capabilities must be an array'] };
    }
    let registered = 0;
    const errors = [];
    for (const cap of capabilities) {
      const result = this.registerCapability(cap.dimension, cap.name, cap.metadata);
      if (result.success) {
        registered++;
      } else {
        errors.push({ dimension: cap.dimension, name: cap.name, error: result.error });
      }
    }
    return { success: errors.length === 0, registered, errors };
  }

  /**
   * 系统性分析当前环境的能力缺口。
   * 六维分析：技能、工具、规则、CI/CD、文档、测试。
   *
   * @param {Object} context - 分析上下文
   * @param {string} context.task - 任务描述
   * @param {string[]} [context.availableSkills] - 当前可用技能列表
   * @param {string[]} [context.availableTools] - 当前可用工具列表
   * @param {string[]} [context.lintRules] - 当前Lint规则列表
   * @param {string[]} [context.ciSteps] - 当前CI步骤列表
   * @param {string[]} [context.docs] - 当前文档列表
   * @param {string[]} [context.testTypes] - 当前测试类型列表
   * @param {string} [context.taskType] - 任务类型（fullstack-build/api-development/bug-fix/refactoring/documentation/research）
   * @param {Object} [context.environment] - 环境描述
   * @returns {Promise<{success: boolean, gaps: Object, recommendations: Array, summary: string, error?: string}>} 分析结果
   */
  async analyze(context) {
    this.guardShutdown();
    if (!context || typeof context !== 'object') {
      return { success: false, error: 'Context must be an object', gaps: {}, recommendations: [], summary: '' };
    }

    const ctx = context;
    const task = ctx.task || '';
    const taskType = ctx.taskType || this._inferTaskType(task);
    const availableSkills = ctx.availableSkills ?? [];
    const availableTools = ctx.availableTools ?? [];
    const lintRules = ctx.lintRules ?? [];
    const ciSteps = ctx.ciSteps ?? [];
    const docs = ctx.docs ?? [];
    const testTypes = ctx.testTypes ?? [];
    const env = ctx.environment ?? {};

    const gaps = {
      skills: this._analyzeSkillsGap(taskType, availableSkills),
      tools: this._analyzeToolsGap(availableTools, env),
      rules: this._analyzeRulesGap(lintRules, env),
      cicd: this._analyzeCIGap(ciSteps, env),
      docs: this._analyzeDocsGap(docs, env),
      tests: this._analyzeTestsGap(testTypes, env),
    };

    this._gaps = new Map();
    for (const [dim, items] of Object.entries(gaps)) {
      this._gaps.set(dim, items);
    }

    const recommendations = this._buildRecommendations(gaps, taskType);
    this._recommendations = recommendations;

    const historyEntry = {
      timestamp: Date.now(),
      task,
      taskType,
      gaps,
      recommendations: recommendations.map(r => ({ severity: r.severity, dimension: r.dimension, name: r.name })),
    };
    this._analysisHistory.push(historyEntry);
    if (this._analysisHistory.length > this._config.historySize) {
      this._analysisHistory.shift();
    }

    this.emit('analysis-complete', { gaps, recommendations });

    const summary = this._buildSummary(gaps, recommendations);
    debug('CapabilityGapAnalyzer', 'analyze', 'Analysis complete: ' + recommendations.length + ' recommendations');

    return { success: true, gaps, recommendations, summary };
  }

  /**
   * 获取当前分析的所有缺口。
   * @returns {Object} 按维度组织的缺口
   */
  getGaps() {
    const result = {};
    for (const [dim, items] of this._gaps.entries()) {
      result[dim] = items;
    }
    return result;
  }

  /**
   * 获取当前分析的所有推荐。
   * @returns {Array<Object>} 推荐列表
   */
  getRecommendations() {
    return this._recommendations.slice();
  }

  /**
   * 获取指定维度的推荐。
   * @param {string} dimension - 能力维度
   * @returns {Array<Object>} 该维度的推荐列表
   */
  getRecommendationsByDimension(dimension) {
    return this._recommendations.filter(r => r.dimension === dimension);
  }

  /**
   * 获取分析历史。
   * @param {number} [limit] - 最大返回条目数
   * @returns {Array<Object>} 分析历史
   */
  getAnalysisHistory(limit) {
    const history = this._analysisHistory.slice();
    if (limit && limit > 0) {
      return history.slice(-limit);
    }
    return history;
  }

  /**
   * 获取已注册的能力列表。
   * @param {string} [dimension] - 可选，按维度过滤
   * @returns {Array<Object>} 能力列表
   */
  getRegisteredCapabilities(dimension) {
    const result = [];
    for (const [, cap] of this._capabilityRegistry.entries()) {
      if (!dimension || cap.dimension === dimension) {
        result.push(cap);
      }
    }
    return result;
  }

  /**
   * 检查能力是否已注册。
   * @param {string} dimension - 能力维度
   * @param {string} name - 能力名称
   * @returns {boolean} 是否已注册
   */
  hasCapability(dimension, name) {
    return this._capabilityRegistry.has(dimension + ':' + name);
  }

  /**
   * 获取分析统计信息。
   * @returns {{totalAnalyses: number, lastAnalysisAt: number|null, totalGaps: number, totalRecommendations: number}}
   */
  getStats() {
    let totalGaps = 0;
    for (const [, items] of this._gaps.entries()) {
      totalGaps += items.length;
    }
    return {
      totalAnalyses: this._analysisHistory.length,
      lastAnalysisAt: this._analysisHistory.length > 0
        ? this._analysisHistory[this._analysisHistory.length - 1].timestamp
        : null,
      totalGaps,
      totalRecommendations: this._recommendations.length,
      registeredCapabilities: this._capabilityRegistry.size,
    };
  }

  /**
   * 关闭分析器，清理资源。
   */
  shutdown() {
    if (this._shutDown || this._shuttingDown) return;
    this._shuttingDown = true;
    this._shutDown = true;
    this._gaps.clear();
    this._recommendations = [];
    this._analysisHistory = [];
    this._capabilityRegistry.clear();
    safeCall(() => this.emit('shutdown', { signal: 'manual' }), 'CapabilityGapAnalyzer', 'emit-shutdown');
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
    this._shuttingDown = false;
  }

  /**
   * 检查实例是否健康。
   * @returns {boolean}
   */
  isHealthy() {
    return !this._shutDown;
  }

  // --- 私有方法 ---

  /**
   * 根据任务描述推断任务类型。
   * @param {string} task - 任务描述
   * @returns {string} 任务类型
   * @private
   */
  _inferTaskType(task) {
    const lower = task.toLowerCase();
    const buildType = this._matchBuildTaskType(lower);
    if (buildType) return buildType;
    const analysisType = this._matchAnalysisTaskType(lower);
    if (analysisType) return analysisType;
    return 'fullstack-build';
  }

  _matchBuildTaskType(lower) {
    if (lower.includes('fullstack') || lower.includes('full-stack') || lower.includes('full stack')) return 'fullstack-build';
    if (lower.includes('api') || lower.includes('endpoint') || lower.includes('rest')) return 'api-development';
    if (lower.includes('bug') || lower.includes('fix') || lower.includes('debug') || lower.includes('issue')) return 'bug-fix';
    if (lower.includes('refactor') || lower.includes('restructure') || lower.includes('cleanup')) return 'refactoring';
    return null;
  }

  _matchAnalysisTaskType(lower) {
    if (lower.includes('document') || lower.includes('doc') || lower.includes('wiki') || lower.includes('readme')) return 'documentation';
    if (lower.includes('research') || lower.includes('analyze') || lower.includes('investigate') || lower.includes('survey')) return 'research';
    return null;
  }

  /**
   * 分析技能缺口。
   * @param {string} taskType - 任务类型
   * @param {string[]} availableSkills - 可用技能列表
   * @returns {Array<{name: string, severity: string, reason: string}>}
   * @private
   */
  _analyzeSkillsGap(taskType, availableSkills) {
    const gaps = [];
    const required = FOUNDATIONAL_SKILLS[taskType] ?? [];
    const skillSet = new Set(availableSkills.map(s => s.toLowerCase()));

    for (const skill of required) {
      const normalized = skill.toLowerCase();
      if (!skillSet.has(normalized) && !this._capabilityRegistry.has('skills:' + normalized)) {
        const isCore = ['requirement-analysis', 'tdd-implement', 'code-review'].includes(skill);
        gaps.push({
          name: skill,
          severity: isCore ? 'critical' : 'medium',
          reason: 'Required for ' + taskType + ' but not available',
          suggestion: 'Create skill definition at .harness/skills/' + skill + '.md',
        });
      }
    }
    return gaps;
  }

  /**
   * 分析工具缺口。
   * @param {string[]} availableTools - 可用工具列表
   * @param {Object} env - 环境信息
   * @returns {Array<{name: string, severity: string, reason: string}>}
   * @private
   */
  _analyzeToolsGap(availableTools, env) {
    const gaps = [];
    const toolSet = new Set(availableTools.map(t => t.toLowerCase()));
    const hasCI = env && env.hasCI !== false;

    for (const tool of ESSENTIAL_TOOLS) {
      if (!toolSet.has(tool) && !this._capabilityRegistry.has('tools:' + tool)) {
        gaps.push({
          name: tool,
          severity: tool === 'git' ? 'critical' : 'high',
          reason: 'Essential development tool: ' + tool + ' is not available',
          suggestion: 'Ensure ' + tool + ' is installed and accessible in PATH',
        });
      }
    }

    if (!hasCI && !toolSet.has('ci-runner')) {
      gaps.push({
        name: 'ci-runner',
        severity: 'medium',
        reason: 'No CI/CD runner detected',
        suggestion: 'Set up CI pipeline (e.g., GitHub Actions, GitLab CI)',
      });
    }

    return gaps;
  }

  /**
   * 分析Lint规则缺口。
   * @param {string[]} lintRules - 当前Lint规则列表
   * @param {Object} env - 环境信息
   * @returns {Array<{name: string, severity: string, reason: string}>}
   * @private
   */
  _analyzeRulesGap(lintRules, env) {
    const gaps = [];
    const ruleSet = new Set(lintRules.map(r => r.toLowerCase()));
    const hasLint = env && env.hasLint !== false;

    if (!hasLint) {
      gaps.push({
        name: 'eslint-config',
        severity: 'high',
        reason: 'No ESLint configuration detected',
        suggestion: 'Add .eslintrc.js with project-specific rules',
      });
      return gaps;
    }

    for (const rule of ESSENTIAL_LINT_RULES) {
      if (!ruleSet.has(rule) && !this._capabilityRegistry.has('rules:' + rule)) {
        gaps.push({
          name: rule,
          severity: rule === 'eslint' ? 'high' : 'medium',
          reason: 'Essential lint rule: ' + rule + ' is not configured',
          suggestion: 'Add ' + rule + ' rule to ESLint configuration',
        });
      }
    }

    return gaps;
  }

  /**
   * 分析CI/CD缺口。
   * @param {string[]} ciSteps - 当前CI步骤列表
   * @param {Object} env - 环境信息
   * @returns {Array<{name: string, severity: string, reason: string}>}
   * @private
   */
  _analyzeCIGap(ciSteps, env) {
    const gaps = [];
    const ciSet = new Set(ciSteps.map(s => s.toLowerCase()));
    const hasCI = env && env.hasCI !== false;

    if (!hasCI) {
      gaps.push({
        name: 'ci-pipeline',
        severity: 'high',
        reason: 'No CI pipeline configured',
        suggestion: 'Create CI workflow file (e.g., .github/workflows/ci.yml)',
      });
      return gaps;
    }

    for (const step of ESSENTIAL_CI_STEPS) {
      if (!ciSet.has(step) && !this._capabilityRegistry.has('cicd:' + step)) {
        gaps.push({
          name: step,
          severity: step === 'test' ? 'high' : 'medium',
          reason: 'CI pipeline missing step: ' + step,
          suggestion: 'Add ' + step + ' step to CI pipeline',
        });
      }
    }

    return gaps;
  }

  /**
   * 分析文档缺口。
   * @param {string[]} docs - 当前文档列表
   * @param {Object} env - 环境信息
   * @returns {Array<{name: string, severity: string, reason: string}>}
   * @private
   */
  _analyzeDocsGap(docs, _env) {
    const gaps = [];
    const docSet = new Set(docs.map(d => d.toLowerCase()));

    for (const doc of ESSENTIAL_DOCS) {
      if (!docSet.has(doc.toLowerCase()) && !this._capabilityRegistry.has('docs:' + doc.toLowerCase())) {
        const hasExisting = docs.some(d => d.toLowerCase().includes(doc.toLowerCase()));
        if (!hasExisting) {
          gaps.push({
            name: doc,
            severity: doc === 'README' ? 'critical' : 'medium',
            reason: 'Missing essential documentation: ' + doc,
            suggestion: 'Create ' + doc + ' documentation',
          });
        }
      }
    }

    return gaps;
  }

  /**
   * 分析测试缺口。
   * @param {string[]} testTypes - 当前测试类型列表
   * @param {Object} env - 环境信息
   * @returns {Array<{name: string, severity: string, reason: string}>}
   * @private
   */
  _analyzeTestsGap(testTypes, env) {
    const gaps = [];
    const testSet = new Set(testTypes.map(t => t.toLowerCase()));
    const hasTests = env && env.hasTests !== false;

    if (!hasTests) {
      gaps.push({
        name: 'test-framework',
        severity: 'critical',
        reason: 'No test framework detected',
        suggestion: 'Set up test framework (e.g., node:test, jest, mocha)',
      });
      return gaps;
    }

    for (const testType of ESSENTIAL_TEST_TYPES) {
      if (!testSet.has(testType) && !this._capabilityRegistry.has('tests:' + testType)) {
        gaps.push({
          name: testType,
          severity: testType === 'unit-tests' ? 'critical' : 'high',
          reason: 'Missing essential test type: ' + testType,
          suggestion: 'Add ' + testType + ' to test suite',
        });
      }
    }

    return gaps;
  }

  /**
   * 构建推荐列表，按严重程度排序。
   * @param {Object} gaps - 各维度缺口
   * @param {string} taskType - 任务类型
   * @returns {Array<Object>} 排序后的推荐列表
   * @private
   */
  _buildRecommendations(gaps, _taskType) {
    const recommendations = [];

    for (const [dimension, items] of Object.entries(gaps)) {
      for (const item of items) {
        recommendations.push({
          dimension,
          name: item.name,
          severity: item.severity,
          weight: SEVERITY_WEIGHTS[item.severity] ?? 10,
          reason: item.reason,
          suggestion: item.suggestion || '',
          addressed: false,
        });
      }
    }

    if (this._config.autoPrioritize) {
      recommendations.sort((a, b) => b.weight - a.weight);
    }

    const thresholdWeight = SEVERITY_WEIGHTS[this._config.severityThreshold] ?? 0;
    const filtered = recommendations.filter(r => r.weight >= thresholdWeight);

    return filtered.slice(0, this._config.maxRecommendations);
  }

  /**
   * 构建分析摘要。
   * @param {Object} gaps - 各维度缺口
   * @param {Array<Object>} recommendations - 推荐列表
   * @returns {string} 摘要文本
   * @private
   */
  _buildSummary(gaps, recommendations) {
    let totalGaps = 0;
    const dimSummaries = [];
    for (const [dim, items] of Object.entries(gaps)) {
      totalGaps += items.length;
      if (items.length > 0) {
        const criticalCount = items.filter(i => i.severity === 'critical').length;
        const highCount = items.filter(i => i.severity === 'high').length;
        dimSummaries.push(dim + ': ' + items.length + ' gaps' + (criticalCount > 0 ? ' (' + criticalCount + ' critical)' : '') + (highCount > 0 ? ' (' + highCount + ' high)' : ''));
      }
    }

    const criticalRecs = recommendations.filter(r => r.severity === 'critical').length;
    const highRecs = recommendations.filter(r => r.severity === 'high').length;

    let summary = 'Capability gap analysis found ' + totalGaps + ' gaps across ' + dimSummaries.length + ' dimensions';
    if (dimSummaries.length > 0) {
      summary += ': ' + dimSummaries.join(', ');
    }
    summary += '. ' + recommendations.length + ' actionable recommendations';
    if (criticalRecs > 0) {
      summary += ' (' + criticalRecs + ' critical, ' + highRecs + ' high)';
    }
    summary += '.';

    return summary;
  }
}

module.exports = CapabilityGapAnalyzer;

