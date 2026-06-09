'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { BUILTIN_MODULES_SET, validateProjectRoot, DESIGN_PATTERNS, MAX_JSON_FILE_SIZE, UTF8_ENCODING } = require('../utils/constants');
const { validatePath, validatePathAsync } = require('../utils/path-utils');
const { debug } = require('../utils/debug-logger');
const deepClone = require('../utils/deep-clone');
const { mergeConfig } = require('../utils/safe-assign');
const { stripCommentsAndStrings, stripCommentsOnly, checkNoEval, checkCryptoSafe, checkClassExport, checkKebabCase, checkVagueFilename } = require('./shared-rule-helpers');
const { withShutdown } = require('../utils/shutdown-mixin');
const { emitError } = require('../utils/safe-execute');

/** @constant {object} RULE_LEVELS - 规则级别定义 */
const RULE_LEVELS = { ERROR: 'error', WARN: 'warn', INFO: 'info' };
/** @constant {number} MAX_RESULTS - 最大结果存储数量 */
const MAX_RESULTS = 8000;
/** @constant {number} MAX_FILE_LINES - 文件行数上限（Karpathy规则） */
const MAX_FILE_LINES = 500;

/** @constant {object} NAMING_RULES - 命名规范规则集 */
const NAMING_RULES = {
  FILE_KEBAB_CASE: { id: 'file-kebab-case', level: RULE_LEVELS.ERROR, description: 'File names must use kebab-case' },
  NO_VAGUE_FILENAME: { id: 'no-vague-filename', level: RULE_LEVELS.ERROR, description: 'File names must not use vague suffixes (v2, final, new, backup, etc.)' },
  CLASS_PASCAL_CASE: { id: 'class-pascal-case', level: RULE_LEVELS.ERROR, description: 'Class names must use PascalCase' },
  METHOD_CAMEL_CASE: { id: 'method-camel-case', level: RULE_LEVELS.WARN, description: 'Public methods must use camelCase' },
  PRIVATE_UNDERSCORE: { id: 'private-underscore', level: RULE_LEVELS.WARN, description: 'Private methods must use _prefix' },
  CONSTANT_UPPER_SNAKE: { id: 'constant-upper-snake', level: RULE_LEVELS.ERROR, description: 'Module-level constants must use UPPER_SNAKE_CASE' },
  EVENT_KEBAB_CASE: { id: 'event-kebab-case', level: RULE_LEVELS.ERROR, description: 'Event names must use kebab-case' },
};

/** @constant {object} STRUCTURE_RULES - 结构规范规则集 */
const STRUCTURE_RULES = {
  USE_STRICT: { id: 'use-strict', level: RULE_LEVELS.ERROR, description: 'Files must start with use strict' },
  CLASS_EXPORT: { id: 'class-export', level: RULE_LEVELS.WARN, description: 'Module should export a single class via module.exports' },
  NO_EXTERNAL_DEPS: { id: 'no-external-deps', level: RULE_LEVELS.ERROR, description: 'Production code must not use external dependencies' },
  SRC_DIR_STRUCTURE: { id: 'src-dir-structure', level: RULE_LEVELS.WARN, description: 'Source files must reside in approved src/ subdirectories' },
};

/** @constant {object} SECURITY_RULES - 安全规范规则集 */
const SECURITY_RULES = Object.freeze({
  NO_EVAL: Object.freeze({ id: 'no-eval', level: RULE_LEVELS.ERROR, description: 'eval() and Function() constructor are forbidden' }),
  NO_DANGEROUS_COMMANDS: Object.freeze({ id: 'no-dangerous-commands', level: RULE_LEVELS.ERROR, description: 'Dangerous shell commands must use PermissionGuard' }),
  CRYPTO_SAFE_RANDOM: Object.freeze({ id: 'crypto-safe-random', level: RULE_LEVELS.ERROR, description: 'ID generation must use crypto.randomUUID() not Math.random()' }),
  PATH_TRAVERSAL_GUARD: Object.freeze({ id: 'path-traversal-guard', level: RULE_LEVELS.ERROR, description: 'File operations must check path traversal' }),
  TIMING_SAFE_COMPARE: Object.freeze({ id: 'timing-safe-compare', level: RULE_LEVELS.WARN, description: 'Token/secret comparison must use timingSafeEqual' }),
});

/** @constant {object} PERSISTENCE_RULES - 持久化规范规则集 */
const PERSISTENCE_RULES = {
  DEBOUNCE_WRITE: { id: 'debounce-write', level: RULE_LEVELS.WARN, description: 'High-frequency writes must use debounce' },
  ATOMIC_WRITE: { id: 'atomic-write', level: RULE_LEVELS.WARN, description: 'Critical data must use atomic write (.tmp + rename)' },
  GRACEFUL_SHUTDOWN: { id: 'graceful-shutdown', level: RULE_LEVELS.ERROR, description: 'Modules with persistence must implement flush()/shutdown()' },
};

/** @constant {object} API_RULES - API规范规则集 */
const API_RULES = {
  CORS_HEADERS: { id: 'cors-headers', level: RULE_LEVELS.WARN, description: 'API endpoints must set proper CORS headers' },
  SECURITY_HEADERS: { id: 'security-headers', level: RULE_LEVELS.WARN, description: 'HTTP responses must include security headers' },
  RATE_LIMIT: { id: 'rate-limit', level: RULE_LEVELS.WARN, description: 'API endpoints should implement rate limiting' },
  INPUT_VALIDATION: { id: 'input-validation', level: RULE_LEVELS.ERROR, description: 'API inputs must be validated' },
};

/** @constant {object} ERROR_RULES - 错误处理规范规则集 */
const ERROR_RULES = {
  CUSTOM_ERROR_CLASS: { id: 'custom-error-class', level: RULE_LEVELS.ERROR, description: 'Errors must use HarnessError subclass hierarchy' },
  ERROR_CODE_UPPER: { id: 'error-code-upper', level: RULE_LEVELS.ERROR, description: 'Error codes must use UPPER_SNAKE_CASE' },
  CAPTURE_STACK_TRACE: { id: 'capture-stack-trace', level: RULE_LEVELS.WARN, description: 'Error classes should call Error.captureStackTrace' },
};

/** @constant {object} KARPATHY_RULES - Karpathy原则规则集 */
const KARPATHY_RULES = {
  NO_SPECULATIVE_CODE: { id: 'no-speculative-code', level: RULE_LEVELS.WARN, description: 'Karpathy: No speculative implementation beyond what was requested' },
  NO_UNUSED_ABSTRACTION: { id: 'no-unused-abstraction', level: RULE_LEVELS.WARN, description: 'Karpathy: Abstractions must have at least 2 callers (YAGNI)' },
  NO_DEAD_CONFIG: { id: 'no-dead-config', level: RULE_LEVELS.WARN, description: 'Karpathy: Config items must be consumed by code' },
  FILE_LINE_LIMIT: { id: 'file-line-limit', level: RULE_LEVELS.WARN, description: 'Karpathy: Files should not exceed 500 lines (simplicity)' },
  NO_ORPHAN_CLEANUP: { id: 'no-orphan-cleanup', level: RULE_LEVELS.WARN, description: 'Karpathy: Clean up your own orphans; mention but do not delete pre-existing dead code' },
  TRACEABILITY_REQUIRED: { id: 'traceability-required', level: RULE_LEVELS.INFO, description: 'Karpathy: Every changed line should trace directly to the user request' },
  CHANGE_SCOPE_LIMIT: { id: 'change-scope-limit', level: RULE_LEVELS.WARN, description: 'Karpathy: Modified files should not exceed scope of the request (surgical change)' },
  CODE_BUDGET_EXCEEDED: { id: 'code-budget-exceeded', level: RULE_LEVELS.WARN, description: 'Karpathy: New lines added should not exceed estimated budget (simplicity first)' },
};

/** @constant {object} DESIGN_RULES - 设计规范规则集 */
const DESIGN_RULES = {
  NO_PURE_BLACK: { id: 'no-pure-black', level: RULE_LEVELS.WARN, description: 'CSS must not use pure black (#000000) — use design token grays' },
  NO_AI_GRADIENT: { id: 'no-ai-gradient', level: RULE_LEVELS.WARN, description: 'CSS must not use AI-style purple-blue gradients' },
  NO_NEON_GLOW: { id: 'no-neon-glow', level: RULE_LEVELS.WARN, description: 'CSS must not use neon glow effects' },
  NO_DEFAULT_LARGE_SHADOW: { id: 'no-default-large-shadow', level: RULE_LEVELS.WARN, description: 'CSS must not use default large shadow patterns — use layered shadow system' },
  NO_OVERSATURATED: { id: 'no-oversaturated', level: RULE_LEVELS.WARN, description: 'CSS must not use oversaturated colors — reduce saturation to 60-80%' },
  NO_SYSTEM_FONT: { id: 'no-system-font', level: RULE_LEVELS.INFO, description: 'CSS should use professional font stacks instead of system defaults' },
  DESIGN_TOKEN_USAGE: { id: 'design-token-usage', level: RULE_LEVELS.INFO, description: 'CSS should use design token variables for spacing, colors, shadows' },
  ACCESSIBILITY_CONTRAST: { id: 'accessibility-contrast', level: RULE_LEVELS.ERROR, description: 'Frontend code must meet WCAG AA contrast requirements' },
  ACCESSIBILITY_ALT_TEXT: { id: 'accessibility-alt-text', level: RULE_LEVELS.ERROR, description: 'Images must have alt attributes' },
  ACCESSIBILITY_FOCUS: { id: 'accessibility-focus', level: RULE_LEVELS.WARN, description: 'Interactive elements must have focus styles' },
  ACCESSIBILITY_REDUCED_MOTION: { id: 'accessibility-reduced-motion', level: RULE_LEVELS.WARN, description: 'Animations must have prefers-reduced-motion fallback' },
};

/** @constant {object} AI_BAD_CODE_RULES - AI劣质代码检测规则集 */
const AI_BAD_CODE_RULES = {
  EMPTY_CATCH: { id: 'empty-catch', level: RULE_LEVELS.ERROR, description: 'AI Bad Code: Empty catch blocks are forbidden — must at least log the error' },
  NAN_NULLISH: { id: 'nan-nullish', level: RULE_LEVELS.ERROR, description: 'AI Bad Code: parseInt/Number/parseFloat followed by ?? does not catch NaN — use || instead' },
  PLACEHOLDER_CODE: { id: 'placeholder-code', level: RULE_LEVELS.WARN, description: 'AI Bad Code: Placeholder code (TODO/FIXME/stub) should not be marked as complete' },
  HARDCODED_VALUE: { id: 'hardcoded-value', level: RULE_LEVELS.WARN, description: 'AI Bad Code: Hardcoded configuration values should use constants or env vars' },
  SILENT_PROMISE_CATCH: { id: 'silent-promise-catch', level: RULE_LEVELS.ERROR, description: 'AI Bad Code: .catch(function() {}) silently swallows errors — must handle or log' },
};

const DOC_COMPLETENESS_RULES = {
  REQUIREMENT_SPEC_EXISTS: { id: 'requirement-spec-exists', level: RULE_LEVELS.ERROR, description: 'Doc Completeness: Requirement specification must exist before module development' },
  ARCHITECTURE_DOC_EXISTS: { id: 'architecture-doc-exists', level: RULE_LEVELS.ERROR, description: 'Doc Completeness: Architecture design document must exist before module development' },
  NO_CODE_WITHOUT_SPEC: { id: 'no-code-without-spec', level: RULE_LEVELS.WARN, description: 'Doc Completeness: Production code should not exist without corresponding specification' },
  SDD_CONTRACT_COMPLETE: { id: 'sdd-contract-complete', level: RULE_LEVELS.WARN, description: 'Doc Completeness: SDD contract should be complete before module development' },
};

/** @constant {string[]} APPROVED_SRC_DIRS - 允许的src子目录列表 */
const APPROVED_SRC_DIRS = ['runtime', 'gate', 'permission', 'web', 'utils', 'errors'];
/** @constant {Set<string>} APPROVED_SRC_DIRS_SET - 允许的src子目录集合 */
const APPROVED_SRC_DIRS_SET = new Set(APPROVED_SRC_DIRS);
/** @constant {Set<string>} ALLOWED_EXTERNALS - 允许的外部依赖集合 */
const ALLOWED_EXTERNALS = new Set(['better-sqlite3']);

const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;
const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;
const UPPER_SNAKE_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
const EVENT_KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

/**
 * @module gate/framework-compliance-checker
 * 框架合规检查器。命名规范/结构规则/安全规则/Karpathy规则（含孤立代码检测、可追溯性检查）/设计规则，
 * 自动扫描源文件并输出合规报告。
 */
/**
 * @classdesc 框架合规检查器。命名规范/结构规则/安全规则/Karpathy规则
 * 框架合规检查器。自动扫描源文件并输出合规报告，
 * 涵盖命名规范、结构规则、安全规则、Karpathy规则（含孤立代码检测、可追溯性检查）、设计规则等。
 * @extends EventEmitter
 * @emits file-checked | directory-checked | exemption-added | exemption-removed
 */
class FrameworkComplianceChecker extends EventEmitter {
  /**
   * 创建FrameworkComplianceChecker实例。
   * @param {string} projectRoot - 项目根目录路径
   * @param {object} [options] - 配置选项
   * @param {object} [options.exemptions] - 规则豁免映射，键为规则ID，值为文件路径数组
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'FrameworkComplianceChecker');
    this.root = projectRoot;
    this._srcDir = path.join(this.root, 'src');
    this._rules = [NAMING_RULES, STRUCTURE_RULES, SECURITY_RULES, PERSISTENCE_RULES, API_RULES, ERROR_RULES, KARPATHY_RULES, DESIGN_RULES, AI_BAD_CODE_RULES, DOC_COMPLETENESS_RULES].reduce((acc, rules) => mergeConfig(acc, rules), {});
    this._exemptions = {};
    this._results = [];
    this._maxExemptionsPerRule = 50;
    this._sddContractManager = null;
    if (options && options.exemptions && typeof options.exemptions === 'object') {
      this._exemptions = deepClone(options.exemptions);
    }
  }

  /**
   * 同步检查单个文件的合规性。
   * @param {string} filePath - 文件路径
   * @returns {Array<{ruleId: string, level: string, description: string, file: string, message: string, timestamp: string}>} 违规列表
   * @emits FrameworkComplianceChecker#file-checked
   */
  checkFile(filePath) {
    this.guardShutdown();
    const violations = [];
    if (!filePath || typeof filePath !== 'string') return violations;
    try {
      const validation = validatePath(filePath, { rootDir: this.root });
      if (!validation.valid) {
        violations.push(this._makeViolation(SECURITY_RULES.PATH_TRAVERSAL_GUARD, filePath, validation.reason));
        return violations;
      }
    } catch (err) {
      violations.push(this._makeViolation(SECURITY_RULES.PATH_TRAVERSAL_GUARD, filePath, err && err.message ? err.message : String(err)));
      return violations;
    }
    const absPath = path.resolve(filePath);
    const relPath = path.relative(this.root, absPath);
    const basename = path.basename(absPath);
    const srcRel = path.relative(this._srcDir, absPath);

    this._checkNaming(relPath, basename, violations);

    if (!this._isExempted('use-strict', relPath)) {
      this._checkFileContentSync(absPath, relPath, violations);
    }

    this._checkDirStructure(srcRel, relPath, basename, violations);

    for (let i = 0; i < violations.length; i++) this._results.push(violations[i]);
    if (this._results.length > MAX_RESULTS) {
      this._results.splice(0, this._results.length - MAX_RESULTS);
    }
    this.emit('file-checked', { filePath: relPath, violations });
    return violations;
  }

  /**
   * 异步检查单个文件的合规性。
   * @param {string} filePath - 文件路径
   * @returns {Promise<Array<{ruleId: string, level: string, description: string, file: string, message: string, timestamp: string}>>} 违规列表的Promise
   * @emits FrameworkComplianceChecker#file-checked
   * @throws {Error} 文件系统操作失败或路径验证异常时抛出
   * @example
   * const checker = new FrameworkComplianceChecker('/path/to/project');
   * const violations = await checker.checkFileAsync('src/utils/helper.js');
   * console.log(violations.length, 'violation(s) found');
   */
  async checkFileAsync(filePath) {
    this.guardShutdown();
    return this._checkFileWith(validatePathAsync, fs.promises.stat, fs.promises.readFile, filePath);
  }

  async _checkFileWith(validatePathFn, statFn, readFn, filePath) {
    const localViolations = [];
    if (!filePath || typeof filePath !== 'string') return localViolations;
    const validation = await validatePathFn(filePath, { rootDir: this.root });
    this.guardShutdown();
    if (!validation.valid) {
      localViolations.push(this._makeViolation(SECURITY_RULES.PATH_TRAVERSAL_GUARD, filePath, validation.reason));
      return localViolations;
    }
    const absPath = path.resolve(filePath);
    const relPath = path.relative(this.root, absPath);
    const basename = path.basename(absPath);
    const srcRel = path.relative(this._srcDir, absPath);

    this._checkNaming(relPath, basename, localViolations);

    if (!this._isExempted('use-strict', relPath)) {
      await this._checkFileContentWith(statFn, readFn, absPath, relPath, localViolations);
    }

    this._checkDirStructure(srcRel, relPath, basename, localViolations);

    for (let i = 0; i < localViolations.length; i++) this._results.push(localViolations[i]);
    if (this._results.length > MAX_RESULTS) {
      this._results.splice(0, this._results.length - MAX_RESULTS);
    }
    this.emit('file-checked', { filePath: relPath, violations: localViolations });
    return localViolations;
  }

  _checkNaming(relPath, basename, violations) {
    if (!this._isExempted('file-kebab-case', relPath)) {
      if (checkKebabCase(basename)) {
        violations.push(this._makeViolation(NAMING_RULES.FILE_KEBAB_CASE, relPath, `File '${basename}' does not follow kebab-case`));
      }
    }
    if (!this._isExempted('no-vague-filename', relPath)) {
      if (checkVagueFilename(basename)) {
        violations.push(this._makeViolation(NAMING_RULES.NO_VAGUE_FILENAME, relPath, `File '${basename}' uses vague suffix — use a descriptive name instead`));
      }
    }
    if (!this._isExempted('constant-upper-snake', relPath) && /\.js$/.test(basename)) {
      const nameWithoutExt = basename.replace(/\.js$/, '');
      if (/^[A-Z]/.test(nameWithoutExt) && !UPPER_SNAKE_RE.test(nameWithoutExt) && !PASCAL_CASE_RE.test(nameWithoutExt)) {
        violations.push(this._makeViolation(NAMING_RULES.CONSTANT_UPPER_SNAKE, relPath, `File '${basename}' looks like a constant file but does not follow UPPER_SNAKE_CASE`));
      }
    }
  }

  _checkFileContent(absPath, relPath, violations) {
    return this._checkFileContentSync(absPath, relPath, violations);
  }

  _checkFileContentSync(absPath, relPath, violations) {
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > MAX_JSON_FILE_SIZE) {
        violations.push(this._makeViolation(STRUCTURE_RULES.USE_STRICT, relPath, 'File too large to check (' + Math.round(stat.size / 1024) + 'KB), skipping'));
        return;
      }
      const content = fs.readFileSync(absPath, UTF8_ENCODING);
      const lines = content.split('\n');
      const firstTwo = lines.slice(0, 2).map(l => l.trim()).join(' ');
      if (!firstTwo.includes("'use strict'") && !firstTwo.includes('"use strict"')) {
        violations.push(this._makeViolation(STRUCTURE_RULES.USE_STRICT, relPath, 'File does not start with \'use strict\''));
      }

      this._checkContentRules(content, relPath, violations);
    } catch (err) {
      const errCode = err && err.code;
      if (errCode === 'EACCES' || errCode === 'EPERM') {
        violations.push(this._makeViolation(STRUCTURE_RULES.USE_STRICT, relPath, 'Cannot read file (permission denied): ' + (err && err.message ? err.message : String(err))));
      } else if (errCode !== 'ENOENT' && errCode !== 'ENOTDIR') {
        violations.push(this._makeViolation(STRUCTURE_RULES.USE_STRICT, relPath, 'Cannot read file: ' + (err && err.message ? err.message : String(err))));
      }
    }
  }

  async _checkFileContentAsync(absPath, relPath, violations) {
    return this._checkFileContentWith(fs.promises.stat, fs.promises.readFile, absPath, relPath, violations);
  }

  async _checkFileContentWith(statFn, readFn, absPath, relPath, violations) {
    try {
      const stat = await statFn(absPath);
      if (stat.size > MAX_JSON_FILE_SIZE) {
        violations.push(this._makeViolation(STRUCTURE_RULES.USE_STRICT, relPath, 'File too large to check (' + Math.round(stat.size / 1024) + 'KB), skipping'));
        return;
      }
      const content = await readFn(absPath, UTF8_ENCODING);
      const lines = content.split('\n');
      const firstTwo = lines.slice(0, 2).map(l => l.trim()).join(' ');
      if (!firstTwo.includes("'use strict'") && !firstTwo.includes('"use strict"')) {
        violations.push(this._makeViolation(STRUCTURE_RULES.USE_STRICT, relPath, 'File does not start with \'use strict\''));
      }

      this._checkContentRules(content, relPath, violations);
    } catch (err) {
      const errCode = err && err.code;
      if (errCode === 'EACCES' || errCode === 'EPERM') {
        violations.push(this._makeViolation(STRUCTURE_RULES.USE_STRICT, relPath, 'Cannot read file (permission denied): ' + (err && err.message ? err.message : String(err))));
      } else if (errCode !== 'ENOENT' && errCode !== 'ENOTDIR') {
        violations.push(this._makeViolation(STRUCTURE_RULES.USE_STRICT, relPath, 'Cannot read file: ' + (err && err.message ? err.message : String(err))));
      }
    }
  }

  _checkContentRules(content, relPath, violations) {
    const CONTENT_CHECKS = [
      { rule: 'no-external-deps', test: () => this._checkExternalDeps(content, relPath, violations) },
      { rule: 'no-eval', test: () => this._checkNoEval(content, relPath, violations) },
      { rule: 'crypto-safe-random', test: () => this._checkCryptoSafe(content, relPath, violations) },
      { rule: 'class-export', test: () => this._checkClassExport(content, relPath, violations) },
      { rule: 'file-line-limit', test: () => this._checkFileLineLimit(content, relPath, violations) },
      { rule: 'no-speculative-code', test: () => this._checkSpeculativeCode(content, relPath, violations) },
      { rule: 'no-orphan-cleanup', test: () => this._checkOrphanCleanup(content, relPath, violations) },
      { rule: 'change-scope-limit', test: () => this._checkChangeScopeLimit(content, relPath, violations) },
      { rule: 'code-budget-exceeded', test: () => this._checkCodeBudgetExceeded(content, relPath, violations) },
      { rule: 'design-rules', test: () => this._checkDesignRules(content, relPath, violations) },
      { rule: 'ai-bad-code', test: () => this._checkAIBadCode(content, relPath, violations) },
      { rule: 'code-naming', test: () => this._checkCodeNaming(content, relPath, violations) },
      { rule: 'security-content', test: () => this._checkSecurityContent(content, relPath, violations) },
      { rule: 'persistence', test: () => this._checkPersistence(content, relPath, violations) },
      { rule: 'api-rules', test: () => this._checkAPIRules(content, relPath, violations) },
      { rule: 'error-rules', test: () => this._checkErrorRules(content, relPath, violations) },
      { rule: 'karpathy-extra', test: () => this._checkKarpathyExtra(content, relPath, violations) },
    ];
    for (const check of CONTENT_CHECKS) {
      if (!this._isExempted(check.rule, relPath)) {
        try {
          check.test();
        } catch (err) {
          debug('FrameworkComplianceChecker', 'checkError', { rule: check.rule, file: relPath, error: err && err.message ? err.message : String(err) });
        }
      }
    }
  }

  _checkExternalDeps(content, relPath, violations) {
    const noComments = stripCommentsOnly(content);
    const requireMatches = noComments.matchAll(/require\(['"]((?:@[^/'"]+\/)?[^./'"]+)['"]\)/g);
    for (const m of requireMatches) {
      if (!this._isBuiltInModule(m[1]) && !ALLOWED_EXTERNALS.has(m[1])) {
        violations.push(this._makeViolation(STRUCTURE_RULES.NO_EXTERNAL_DEPS, relPath, `External dependency '${m[1]}' is forbidden in production code`));
      }
    }
  }

  _checkNoEval(content, relPath, violations) {
    const stripped = stripCommentsAndStrings(content);
    if (checkNoEval(stripped)) {
      violations.push(this._makeViolation(SECURITY_RULES.NO_EVAL, relPath, 'eval() or Function() constructor detected'));
    }
  }

  _checkCryptoSafe(content, relPath, violations) {
    const stripped = stripCommentsAndStrings(content);
    if (checkCryptoSafe(stripped)) {
      violations.push(this._makeViolation(SECURITY_RULES.CRYPTO_SAFE_RANDOM, relPath, 'ID generation uses Math.random() instead of crypto.randomUUID()'));
    }
  }

  _checkClassExport(content, relPath, violations) {
    if (checkClassExport(content)) {
      violations.push(this._makeViolation(STRUCTURE_RULES.CLASS_EXPORT, relPath, 'Class defined but not exported via module.exports'));
    }
  }

  _checkFileLineLimit(content, relPath, violations) {
    const lineCount = content.split('\n').length;
    if (lineCount > MAX_FILE_LINES) {
      violations.push(this._makeViolation(KARPATHY_RULES.FILE_LINE_LIMIT, relPath, `File has ${lineCount} lines, exceeds ${MAX_FILE_LINES} line limit (simplicity)`));
    }
  }

  _checkSpeculativeCode(content, relPath, violations) {
    const speculativePatterns = [
      { pattern: /\/\/\s*TODO:\s*(?:implement|add|support|handle)/gi, desc: 'TODO for unimplemented feature' },
      { pattern: /\/\/\s*FIXME:\s*/gi, desc: 'FIXME indicates known issue' },
      { pattern: /enable\w*:\s*true/gi, desc: 'Feature flag always enabled — may be unnecessary' },
    ];
    for (const { pattern, desc } of speculativePatterns) {
      const matches = content.match(pattern);
      if (matches && matches.length > 3) {
        violations.push(this._makeViolation(KARPATHY_RULES.NO_SPECULATIVE_CODE, relPath, `${matches.length}x ${desc} — verify necessity (YAGNI)`));
        break;
      }
    }
  }

  _checkOrphanCleanup(content, relPath, violations) {
    if (typeof content !== 'string') return;
    const unusedImportPatterns = [
      /(?:const|let|var)\s+\w+\s*=\s*require\([^)]+\)\s*;?\s*\/\/\s*(?:unused|not used)/gi,
    ];
    for (const pattern of unusedImportPatterns) {
      const matches = content.match(pattern);
      if (matches && matches.length > 0) {
        violations.push(this._makeViolation(KARPATHY_RULES.NO_ORPHAN_CLEANUP, relPath, `${matches.length} unused import(s) marked but not cleaned up — remove your own orphans`));
        break;
      }
    }
    const stripped = stripCommentsAndStrings(content);
    const consoleLogCount = (stripped.match(/console\.log\(/g) ?? []).length;
    if (consoleLogCount > 5) {
      violations.push(this._makeViolation(KARPATHY_RULES.NO_ORPHAN_CLEANUP, relPath, `${consoleLogCount} console.log calls — consider if these are pre-existing or your own debug output`));
    }
  }

  _checkChangeScopeLimit(content, relPath, violations) {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const diffMarkers = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    if (diffMarkers > 0 && totalLines > 0) {
      const changeRatio = diffMarkers / totalLines;
      if (changeRatio > 0.5 && diffMarkers > 100) {
        violations.push(this._makeViolation(KARPATHY_RULES.CHANGE_SCOPE_LIMIT, relPath,
          `${diffMarkers} changed lines out of ${totalLines} (${(changeRatio * 100).toFixed(1)}%) — scope may be too wide, consider surgical changes`));
      }
    }
  }

  _checkCodeBudgetExceeded(content, relPath, violations) {
    const newFunctionCount = (content.match(/function\s+\w+|=>\s*{/g) ?? []).length;
    const newClassCount = (content.match(/class\s+\w+/g) ?? []).length;
    if (newClassCount > 3) {
      violations.push(this._makeViolation(KARPATHY_RULES.CODE_BUDGET_EXCEEDED, relPath,
        `${newClassCount} classes in single change — verify all are necessary per YAGNI`));
    }
    if (newFunctionCount > 20) {
      violations.push(this._makeViolation(KARPATHY_RULES.CODE_BUDGET_EXCEEDED, relPath,
        `${newFunctionCount} functions in single change — verify all are necessary per simplicity first`));
    }
  }

  _checkAIBadCode(content, relPath, violations) {
    if (!/\.js$/.test(relPath)) return;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
        violations.push(this._makeViolation(AI_BAD_CODE_RULES.EMPTY_CATCH, relPath, 'Empty catch block at line ' + lineNum));
      }
      if (i + 1 < lines.length && /catch\s*\([^)]*\)\s*\{\s*$/.test(line)) {
        const nextLine = lines[i + 1];
        if (/^\s*\}\s*$/.test(nextLine)) {
          violations.push(this._makeViolation(AI_BAD_CODE_RULES.EMPTY_CATCH, relPath, 'Empty catch block at line ' + lineNum));
        }
      }

      if (/\.catch\s*\(\s*function\s*\(\s*\)\s*\{\s*\}\s*\)/.test(line) || /\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(line)) {
        violations.push(this._makeViolation(AI_BAD_CODE_RULES.SILENT_PROMISE_CATCH, relPath, 'Silent .catch(function() {}) at line ' + lineNum));
      }

      if (/(?:parseInt|Number|parseFloat)\s*\(.*?\)\s*\?\?/.test(line)) {
        violations.push(this._makeViolation(AI_BAD_CODE_RULES.NAN_NULLISH, relPath, 'NaN/nullish coalescing misuse at line ' + lineNum + ' — use || instead of ??'));
      }
    }

    if (/(?:TODO|FIXME|HACK|STUB|PLACEHOLDER)\s*.*(?:完成|done|complete|finished)/i.test(content)) {
      violations.push(this._makeViolation(AI_BAD_CODE_RULES.PLACEHOLDER_CODE, relPath, 'Placeholder code marked as complete'));
    }

    if (!this._isExempted('hardcoded-value', relPath)) {
      const stripped = stripCommentsAndStrings(content);
      const hardcodedUrl = stripped.match(/(?:https?:\/\/|ftp:\/\/)[^\s'")\]]+/g);
      if (hardcodedUrl && hardcodedUrl.length > 2) {
        const usesConfig = /config|CONFIG|process\.env|getConfig/.test(stripped);
        if (!usesConfig) {
          violations.push(this._makeViolation(AI_BAD_CODE_RULES.HARDCODED_VALUE, relPath, hardcodedUrl.length + 'x hardcoded URL — use config or env vars'));
        }
      }
      const hardcodedPort = stripped.match(/(?:port|PORT)\s*[:=]\s*(\d{4,5})/g);
      if (hardcodedPort && hardcodedPort.length > 0) {
        const usesEnvPort = /process\.env\.PORT|process\.env\[|getConfig|config\.port/.test(stripped);
        if (!usesEnvPort) {
          violations.push(this._makeViolation(AI_BAD_CODE_RULES.HARDCODED_VALUE, relPath, hardcodedPort.length + 'x hardcoded port number — use process.env or config'));
        }
      }
      const magicNumbers = stripped.match(/(?:===|!==|==|!=|>=|<=|>|<)\s*(?:(?:3[01]|[4-9]\d|[1-9]\d{2,})\b(?!\s*(?:px|ms|em|rem|%|vh|vw|deg|s\b)))/g);
      if (magicNumbers && magicNumbers.length > 5) {
        violations.push(this._makeViolation(AI_BAD_CODE_RULES.HARDCODED_VALUE, relPath, magicNumbers.length + 'x magic numbers — extract to named constants'));
      }
    }
  }

  _checkDesignRules(content, relPath, violations) {
    const isFrontendFile = /\.(?:css|html|htm|jsx|tsx|vue|svelte|scss|less)$/.test(relPath);
    if (!isFrontendFile) return;

    this._checkDesignVisualRules(content, relPath, violations);
    this._checkDesignAccessibilityRules(content, relPath, violations);
  }

  _checkDesignVisualRules(content, relPath, violations) {
    if (DESIGN_PATTERNS.PURE_BLACK.test(content)) {
      violations.push(this._makeViolation(DESIGN_RULES.NO_PURE_BLACK, relPath, 'Pure black (#000000) detected — use design token grays'));
    }

    if (DESIGN_PATTERNS.AI_GRADIENT.test(content)) {
      violations.push(this._makeViolation(DESIGN_RULES.NO_AI_GRADIENT, relPath, 'AI-style purple-blue gradient detected'));
    }

    if (DESIGN_PATTERNS.NEON_GLOW.test(content) || DESIGN_PATTERNS.NEON_COLOR.test(content)) {
      violations.push(this._makeViolation(DESIGN_RULES.NO_NEON_GLOW, relPath, 'Neon glow effect detected — use subtle, professional shadows'));
    }

    if (DESIGN_PATTERNS.DEFAULT_LARGE_SHADOW.test(content)) {
      violations.push(this._makeViolation(DESIGN_RULES.NO_DEFAULT_LARGE_SHADOW, relPath, 'Default large shadow pattern detected — use layered shadow system'));
    }

    if (DESIGN_PATTERNS.OVERSATURATED.test(content)) {
      violations.push(this._makeViolation(DESIGN_RULES.NO_OVERSATURATED, relPath, 'Oversaturated color detected — reduce saturation to 60-80%'));
    }

    if (DESIGN_PATTERNS.SYSTEM_FONT.test(content)) {
      violations.push(this._makeViolation(DESIGN_RULES.NO_SYSTEM_FONT, relPath, 'System default font detected — use professional font stack'));
    }

    DESIGN_PATTERNS.HARDCODED_SPACING.lastIndex = 0;
    if (DESIGN_PATTERNS.HARDCODED_SPACING.test(content)) {
      DESIGN_PATTERNS.HARDCODED_SPACING.lastIndex = 0;
      const matches = content.match(DESIGN_PATTERNS.HARDCODED_SPACING);
      if (matches && matches.length > 5) {
        violations.push(this._makeViolation(DESIGN_RULES.DESIGN_TOKEN_USAGE, relPath, matches.length + ' hardcoded spacing values — use design token CSS variables'));
      }
    }

    if (DESIGN_PATTERNS.HARDCODED_SHADOW.test(content)) {
      violations.push(this._makeViolation(DESIGN_RULES.DESIGN_TOKEN_USAGE, relPath, 'Hardcoded box-shadow detected — use design token shadow variables'));
    }
  }

  _checkDesignAccessibilityRules(content, relPath, violations) {
    if (DESIGN_PATTERNS.MISSING_ALT_TEXT.test(content)) {
      violations.push(this._makeViolation(DESIGN_RULES.ACCESSIBILITY_ALT_TEXT, relPath, 'Image element missing alt attribute'));
    }

    if (DESIGN_PATTERNS.ANIMATION_WITHOUT_REDUCED_MOTION.test(content) && !DESIGN_PATTERNS.REDUCED_MOTION_QUERY.test(content)) {
      violations.push(this._makeViolation(DESIGN_RULES.ACCESSIBILITY_REDUCED_MOTION, relPath, 'Animations without prefers-reduced-motion fallback'));
    }

    if (/\.css$/.test(relPath)) {
      const interactiveSelectors = content.match(/(?:button|a\s|input|select|textarea|\.btn|\.link|\.tab|\.menu-item|\.clickable)[^{]*\{/g);
      if (interactiveSelectors && interactiveSelectors.length > 0) {
        const hasFocusStyles = /:focus\s*\{|:focus-visible\s*\{|:focus-within\s*\{/.test(content);
        if (!hasFocusStyles) {
          violations.push(this._makeViolation(DESIGN_RULES.ACCESSIBILITY_FOCUS, relPath, 'Interactive elements found but no focus styles defined'));
        }
      }
    }

    if (/\.css$/.test(relPath)) {
      const colorDefs = content.match(/(?:color|background(?:-color)?)\s*:\s*(?:#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\))/g);
      if (colorDefs && colorDefs.length > 3) {
        const usesVarColors = /var\s*\(\s*--/.test(content);
        if (!usesVarColors) {
          violations.push(this._makeViolation(DESIGN_RULES.ACCESSIBILITY_CONTRAST, relPath, colorDefs.length + ' hardcoded colors without CSS variables — verify WCAG AA contrast'));
        }
      }
    }
  }

  _checkCodeNaming(content, relPath, violations) {
    if (!/\.js$/.test(relPath)) return;
    const stripped = stripCommentsAndStrings(content);

    if (!this._isExempted('class-pascal-case', relPath)) {
      const classMatches = stripped.matchAll(/\bclass\s+([A-Za-z_]\w*)/g);
      for (const m of classMatches) {
        if (!PASCAL_CASE_RE.test(m[1])) {
          violations.push(this._makeViolation(NAMING_RULES.CLASS_PASCAL_CASE, relPath, "Class name '" + m[1] + "' does not follow PascalCase"));
        }
      }
    }

    if (!this._isExempted('method-camel-case', relPath)) {
      const methodMatches = stripped.matchAll(/^\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/gm);
      for (const m of methodMatches) {
        const name = m[1];
        if (name.startsWith('_')) continue;
        if (/^[A-Z]/.test(name)) continue;
        if (!CAMEL_CASE_RE.test(name) && !/^(if|for|while|switch|catch|function|return|throw|new|typeof|instanceof|delete|void|class|extends|import|export|from|default|const|let|var|try|else|do|in|of|break|continue|case|this|super|yield|await|true|false|null|undefined)$/.test(name)) {
          violations.push(this._makeViolation(NAMING_RULES.METHOD_CAMEL_CASE, relPath, "Method name '" + name + "' does not follow camelCase"));
        }
      }
    }

    if (!this._isExempted('private-underscore', relPath)) {
      const privateMethodMatches = stripped.matchAll(/(?:this|self)\.([a-z][A-Za-z0-9]*)\s*=\s*(?:function|async)/g);
      for (const m of privateMethodMatches) {
        if (!m[1].startsWith('_')) {
          violations.push(this._makeViolation(NAMING_RULES.PRIVATE_UNDERSCORE, relPath, "Private method 'this." + m[1] + "' should use _prefix"));
        }
      }
    }

    if (!this._isExempted('event-kebab-case', relPath)) {
      const emitMatches = stripped.matchAll(/\.emit\s*\(\s*['"`]([^'"`]+)['"`]/g);
      for (const m of emitMatches) {
        if (!EVENT_KEBAB_RE.test(m[1])) {
          violations.push(this._makeViolation(NAMING_RULES.EVENT_KEBAB_CASE, relPath, "Event name '" + m[1] + "' does not follow kebab-case"));
        }
      }
    }
  }

  _checkSecurityContent(content, relPath, violations) {
    if (!/\.js$/.test(relPath)) return;
    const stripped = stripCommentsAndStrings(content);

    if (!this._isExempted('no-dangerous-commands', relPath)) {
      const dangerousPatterns = [
        { re: /(?:child_process\.)?(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/g, desc: 'shell command execution' },
        { re: /shell\s*:\s*true/g, desc: 'shell: true option' },
      ];
      for (const { re, desc } of dangerousPatterns) {
        const matches = stripped.match(re);
        if (matches && matches.length > 0) {
          const hasPermissionGuard = /PermissionGuard|permissionGuard|permission-guard|requirePermission|checkPermission/.test(stripped);
          if (!hasPermissionGuard) {
            violations.push(this._makeViolation(SECURITY_RULES.NO_DANGEROUS_COMMANDS, relPath, matches.length + 'x ' + desc + ' without PermissionGuard'));
            break;
          }
        }
      }
    }

    if (!this._isExempted('timing-safe-compare', relPath)) {
      const tokenComparePattern = /(?:token|secret|password|apiKey|api_key|authToken|accessToken|refreshToken|sessionToken)\s*(?:===|!==|==|!=)\s*/g;
      const reverseComparePattern = /\s*(?:===|!==|==|!=)\s*(?:token|secret|password|apiKey|api_key|authToken|accessToken|refreshToken|sessionToken)/g;
      const forwardMatches = stripped.match(tokenComparePattern);
      const reverseMatches = stripped.match(reverseComparePattern);
      const totalMatches = (forwardMatches ? forwardMatches.length : 0) + (reverseMatches ? reverseMatches.length : 0);
      if (totalMatches > 0) {
        const usesTimingSafe = /timingSafeEqual|crypto\.timingSafeEqual|timing_safe/.test(stripped);
        if (!usesTimingSafe) {
          violations.push(this._makeViolation(SECURITY_RULES.TIMING_SAFE_COMPARE, relPath, totalMatches + 'x direct comparison of sensitive values — use crypto.timingSafeEqual'));
        }
      }
    }
  }

  _checkPersistence(content, relPath, violations) {
    if (!/\.js$/.test(relPath)) return;
    const stripped = stripCommentsAndStrings(content);

    if (!this._isExempted('debounce-write', relPath)) {
      const writeSyncPattern = /writeFileSync\s*\(/g;
      const writeMatches = stripped.match(writeSyncPattern);
      if (writeMatches && writeMatches.length > 3) {
        const usesDebounce = /debounce|debounced|DebouncedPersister/.test(stripped);
        if (!usesDebounce) {
          violations.push(this._makeViolation(PERSISTENCE_RULES.DEBOUNCE_WRITE, relPath, writeMatches.length + 'x writeFileSync without debounce — high-frequency writes should use DebouncedPersister'));
        }
      }
    }

    if (!this._isExempted('atomic-write', relPath)) {
      const criticalWritePattern = /writeFileSync\s*\(\s*[^,]+,\s*JSON\.stringify/g;
      const criticalMatches = stripped.match(criticalWritePattern);
      if (criticalMatches && criticalMatches.length > 0) {
        const usesAtomicWrite = /\.tmp['"`]|renameSync|rename\s*\(/.test(stripped);
        if (!usesAtomicWrite) {
          violations.push(this._makeViolation(PERSISTENCE_RULES.ATOMIC_WRITE, relPath, criticalMatches.length + 'x critical JSON write without atomic write (.tmp + rename)'));
        }
      }
    }

    if (!this._isExempted('graceful-shutdown', relPath)) {
      const hasPersistence = /writeFileSync|writeFile|SqliteStore|better-sqlite3|\.db\b|\.json\s*['"`]/.test(stripped);
      if (hasPersistence) {
        const hasShutdown = /(?:_onShutdown|shutdown|flush|_flush|close|_close|destroy|_destroy)\s*\(/.test(stripped);
        if (!hasShutdown) {
          violations.push(this._makeViolation(PERSISTENCE_RULES.GRACEFUL_SHUTDOWN, relPath, 'Module with persistence but no flush()/shutdown() method'));
        }
      }
    }
  }

  _checkAPIRules(content, relPath, violations) {
    if (!/\.js$/.test(relPath)) return;
    const stripped = stripCommentsAndStrings(content);

    const isServerFile = /(?:server|router|route|api|endpoint|handler)/.test(relPath) || /createServer|\.listen\s*\(/.test(stripped);
    if (!isServerFile) return;

    if (!this._isExempted('cors-headers', relPath)) {
      const setsCorsHeaders = /Access-Control-Allow-Origin|cors\s*\(|corsMiddleware|setCorsHeaders/.test(stripped);
      if (!setsCorsHeaders) {
        violations.push(this._makeViolation(API_RULES.CORS_HEADERS, relPath, 'API server file without CORS header configuration'));
      }
    }

    if (!this._isExempted('security-headers', relPath)) {
      const hasSecurityHeaders = /X-Content-Type-Options|X-Frame-Options|Content-Security-Policy|Strict-Transport-Security|X-XSS-Protection|securityHeaders|setSecurityHeaders/.test(stripped);
      if (!hasSecurityHeaders) {
        violations.push(this._makeViolation(API_RULES.SECURITY_HEADERS, relPath, 'API server file without security headers (X-Content-Type-Options, X-Frame-Options, CSP)'));
      }
    }

    if (!this._isExempted('rate-limit', relPath)) {
      const hasRateLimit = /rateLimit|rate-limit|rateLimiter|throttle|RateLimit/.test(stripped);
      if (!hasRateLimit) {
        violations.push(this._makeViolation(API_RULES.RATE_LIMIT, relPath, 'API server file without rate limiting'));
      }
    }

    if (!this._isExempted('input-validation', relPath)) {
      const hasInputHandling = /req\.body|req\.query|req\.params|request\.body|ctx\.request\.body/.test(stripped);
      if (hasInputHandling) {
        const hasValidation = /validate|validation|schema|joi|zod|ajv|paramValidator|ParamValidator|sanitize/.test(stripped);
        if (!hasValidation) {
          violations.push(this._makeViolation(API_RULES.INPUT_VALIDATION, relPath, 'API inputs (req.body/query/params) used without validation'));
        }
      }
    }
  }

  _checkErrorRules(content, relPath, violations) {
    if (!/\.js$/.test(relPath)) return;
    const stripped = stripCommentsAndStrings(content);

    if (!this._isExempted('custom-error-class', relPath)) {
      const throwNewError = stripped.match(/throw\s+new\s+Error\s*\(/g);
      if (throwNewError && throwNewError.length > 3) {
        const usesCustomError = /HarnessError|extends\s+Error|class\s+\w+Error/.test(stripped);
        if (!usesCustomError) {
          violations.push(this._makeViolation(ERROR_RULES.CUSTOM_ERROR_CLASS, relPath, throwNewError.length + 'x throw new Error() — use HarnessError subclass hierarchy'));
        }
      }
    }

    if (!this._isExempted('error-code-upper', relPath)) {
      const errorCodeMatches = stripped.matchAll(/(?:code|errorCode|error_code)\s*:\s*['"`]([^'"`]+)['"`]/g);
      for (const m of errorCodeMatches) {
        if (!ERROR_CODE_RE.test(m[1])) {
          violations.push(this._makeViolation(ERROR_RULES.ERROR_CODE_UPPER, relPath, "Error code '" + m[1] + "' does not follow UPPER_SNAKE_CASE"));
        }
      }
    }

    if (!this._isExempted('capture-stack-trace', relPath)) {
      const customErrorClass = stripped.match(/class\s+(\w+Error)\s+extends\s+Error/g);
      if (customErrorClass) {
        const usesCaptureStackTrace = /Error\.captureStackTrace/.test(stripped);
        if (!usesCaptureStackTrace) {
          violations.push(this._makeViolation(ERROR_RULES.CAPTURE_STACK_TRACE, relPath, 'Custom Error class without Error.captureStackTrace()'));
        }
      }
    }
  }

  _checkKarpathyExtra(content, relPath, violations) {
    if (!/\.js$/.test(relPath)) return;
    const stripped = stripCommentsAndStrings(content);

    if (!this._isExempted('no-unused-abstraction', relPath)) {
      const classDefMatches = stripped.matchAll(/\bclass\s+(\w+)/g);
      for (const m of classDefMatches) {
        const className = m[1];
        const safeClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usagePattern = new RegExp('(?:new\\s+' + safeClassName + '|' + safeClassName + '\\.)', 'g');
        const usages = stripped.match(usagePattern);
        if (!usages || usages.length < 2) {
          const exportPattern = new RegExp('module\\.exports.*' + safeClassName);
          const isExported = exportPattern.test(stripped);
          if (isExported) continue;
          violations.push(this._makeViolation(KARPATHY_RULES.NO_UNUSED_ABSTRACTION, relPath, "Class '" + className + "' has fewer than 2 callers (YAGNI)"));
        }
      }
    }

    if (!this._isExempted('no-dead-config', relPath)) {
      const configMatches = stripped.matchAll(/(?:this\._config|options)\.(\w+)\s*=/g);
      for (const m of configMatches) {
        const configKey = m[1];
        const safeConfigKey = configKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usagePattern = new RegExp('(?:this\\._config|options|this\\._options)\\.' + safeConfigKey + '(?!\\s*=)');
        if (!usagePattern.test(stripped)) {
          violations.push(this._makeViolation(KARPATHY_RULES.NO_DEAD_CONFIG, relPath, "Config key '" + configKey + "' is set but never read"));
        }
      }
    }

    if (!this._isExempted('traceability-required', relPath)) {
      const hasTaskRef = /\/\/\s*(?:task|issue|req|fix|bug|story|ticket)\s*[:#]/i.test(content);
      const hasGitRef = /\/\/\s*(?:see|ref|related)\s*[:#]/i.test(content);
      const hasNoTraceability = !hasTaskRef && !hasGitRef;
      const lineCount = content.split('\n').length;
      if (hasNoTraceability && lineCount > 200) {
        violations.push(this._makeViolation(KARPATHY_RULES.TRACEABILITY_REQUIRED, relPath, 'Large file (' + lineCount + ' lines) without traceability comments (task/issue refs)'));
      }
    }
  }

  _checkDirStructure(srcRel, relPath, basename, violations) {
    if (srcRel && !srcRel.startsWith('..')) {
      const topDir = srcRel.split(path.sep)[0];
      if (!topDir) return;
      if (!this._isExempted('src-dir-structure', relPath)) {
        if (!APPROVED_SRC_DIRS_SET.has(topDir) && basename !== 'index.js' && basename !== 'index.d.ts') {
          violations.push(this._makeViolation(STRUCTURE_RULES.SRC_DIR_STRUCTURE, relPath, `Source file in unapproved directory 'src/${topDir}'`));
        }
      }
    }
  }

  /**
   * 同步检查整个目录的合规性。
   * @param {string} dirPath - 目录路径
   * @returns {Array<object>} 所有违规列表
   * @emits FrameworkComplianceChecker#directory-checked
   */
  checkDirectory(dirPath) {
    this.guardShutdown();
    const allViolations = [];
    this._walkDirectorySync(fs.readdirSync, fs.realpathSync, (fp) => this.checkFile(fp), dirPath, allViolations);
    this.emit('directory-checked', { dirPath, violationCount: allViolations.length });
    return allViolations;
  }

  _walkDirectorySync(readdirFn, realpathFn, checkFileFn, dirPath, allViolations) {
    const absDir = path.resolve(dirPath);
    const MAX_WALK_DEPTH = 20;
    const stack = [{ dir: absDir, depth: 0 }];
    while (stack.length > 0) {
      if (this._shutDown) return;
      const { dir, depth } = stack.pop();
      if (depth >= MAX_WALK_DEPTH) continue;
      let entries;
      try {
        entries = readdirFn(dir, { withFileTypes: true });
      } catch (err) {
        emitError(this, 'directory-error', err, { dir });
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'coverage') {
            try {
              const realPath = realpathFn(fullPath);
              if (realPath !== fullPath) continue;
            } catch (e) { debug('FrameworkComplianceChecker', 'realpath', e && e.message ? e.message : String(e)); continue; }
            stack.push({ dir: fullPath, depth: depth + 1 });
          }
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          const violations = checkFileFn(fullPath);
          if (Array.isArray(violations)) allViolations.push(...violations);
        }
      }
    }
  }

  /**
   * 异步检查整个目录的合规性。
   * @param {string} dirPath - 目录路径
   * @returns {Promise<Array<object>>} 所有违规列表的Promise
   * @emits FrameworkComplianceChecker#directory-checked
   */
  async checkDirectoryAsync(dirPath) {
    return this._walkDirectory(fs.promises.readdir, fs.promises.realpath, (fp) => this.checkFileAsync(fp), dirPath);
  }

  async _walkDirectory(readdirFn, realpathFn, checkFileFn, dirPath) {
    const allViolations = [];
    const absDir = path.resolve(dirPath);
    const MAX_WALK_DEPTH = 20;

    const walk = async (dir, depth) => {
      if (depth >= MAX_WALK_DEPTH) return;
      let entries;
      try {
        entries = await readdirFn(dir, { withFileTypes: true });
      } catch (err) {
        emitError(this, 'directory-error', err, { dir });
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'coverage') {
            try {
              const realPath = await realpathFn(fullPath);
              if (realPath !== fullPath) continue;
            } catch (e) { debug('FrameworkComplianceChecker', 'realpath', e && e.message ? e.message : String(e)); continue; }
            await walk(fullPath, depth + 1);
          }
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          const violations = await checkFileFn(fullPath);
          allViolations.push(...violations);
        }
      }
    };

    await walk(absDir, 0);
    this.emit('directory-checked', { dirPath, violationCount: allViolations.length });
    return allViolations;
  }

  /**
   * 同步检查整个项目的src目录合规性。
   * @returns {Array<object>} 所有违规列表
   */
  checkProject() {
    this.guardShutdown();
    const srcDir = this._srcDir;
    this._results = [];
    if (!fs.existsSync(srcDir)) {
      return [];
    }
    return this.checkDirectory(srcDir);
  }

  /**
   * 异步检查整个项目的src目录合规性。
   * @returns {Promise<Array<object>>} 所有违规列表的Promise
   */
  async checkProjectAsync() {
    this.guardShutdown();
    const srcDir = this._srcDir;
    this._results = [];
    try {
      await fs.promises.access(srcDir);
    } catch (err) {
      debug('FrameworkComplianceChecker', 'checkProjectAsync: src dir not accessible', err && err.message ? err.message : String(err));
      return [];
    }
    return this.checkDirectoryAsync(srcDir);
  }

  /**
   * 检查项目文档完整性，验证需求规格文档和架构设计文档是否存在。
   * @returns {Array<{ruleId: string, level: string, description: string, file: string, message: string, timestamp: string}>} 文档完整性违规列表
   */
  checkDocCompleteness() {
    this.guardShutdown();
    const violations = [];
    const docsDir = path.join(this.root, 'docs');
    const srcDir = this._srcDir;
    let hasSrcFiles = false;
    try {
      if (fs.existsSync(srcDir)) {
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        hasSrcFiles = entries.some(function(e) { return e.isDirectory() || e.isFile(); });
      }
    } catch (_e) {
      debug('FrameworkComplianceChecker', 'checkDocCompleteness', _e && _e.message ? _e.message : String(_e));
      hasSrcFiles = false;
    }
    if (!hasSrcFiles) return violations;

    let hasRequirementSpec = false;
    let hasArchitectureDoc = false;
    try {
      if (fs.existsSync(docsDir)) {
        const walkDir = function(dir) {
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { debug('FrameworkComplianceChecker', 'walkDir', _e && _e.message ? _e.message : String(_e)); return; }
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walkDir(fullPath);
            } else if (entry.isFile()) {
              const name = entry.name.toLowerCase();
              if (/需求|requirement/.test(name)) hasRequirementSpec = true;
              if (/架构|architecture/.test(name)) hasArchitectureDoc = true;
            }
          }
        };
        walkDir(docsDir);
      }
    } catch (_e) {
      debug('FrameworkComplianceChecker', 'checkDocCompleteness', _e);
    }

    if (!hasRequirementSpec) {
      violations.push(this._makeViolation(DOC_COMPLETENESS_RULES.REQUIREMENT_SPEC_EXISTS, 'docs/', 'No requirement specification document found in docs/ (expected filename matching *需求* or *requirement*)'));
    }
    if (!hasArchitectureDoc) {
      violations.push(this._makeViolation(DOC_COMPLETENESS_RULES.ARCHITECTURE_DOC_EXISTS, 'docs/', 'No architecture design document found in docs/ (expected filename matching *架构* or *architecture*)'));
    }
    if (!hasRequirementSpec || !hasArchitectureDoc) {
      violations.push(this._makeViolation(DOC_COMPLETENESS_RULES.NO_CODE_WITHOUT_SPEC, 'src/', 'Production code exists in src/ without complete documentation coverage'));
    }

    for (let i = 0; i < violations.length; i++) this._results.push(violations[i]);
    if (this._results.length > MAX_RESULTS) {
      this._results.splice(0, this._results.length - MAX_RESULTS);
    }
    return violations;
  }

  /**
   * 挂载SDD合约管理器实例，用于checkSddContractComplete()的合约完整性检查。
   * @param {Object} manager - SddContractManager实例，需实现getContract()方法
   */
  attachSddContractManager(manager) {
    if (manager && typeof manager === 'object' && typeof manager.getContract === 'function') {
      this._sddContractManager = manager;
      return true;
    }
    return false;
  }

  /**
   * 检查SDD合约完整性。
   * @param {string} contractId - 合约ID
   * @returns {Array<{ruleId: string, level: string, description: string, file: string, message: string, timestamp: string}>} 违规列表
   * @throws {Error} SDD合约管理器查询异常时抛出
   */
  checkSddContractComplete(contractId) {
    this.guardShutdown();
    const violations = [];
    if (!this._sddContractManager) return violations;
    const status = this._sddContractManager.getContractStatus(contractId);
    if (!status) {
      violations.push(this._makeViolation(DOC_COMPLETENESS_RULES.SDD_CONTRACT_COMPLETE, 'sdd/', 'SDD contract not found: ' + String(contractId)));
      return violations;
    }
    if (status.status !== 'completed' && (typeof status.progress !== 'number' || !Number.isFinite(status.progress) || status.progress < 1)) {
      const progressPct = typeof status.progress === 'number' && Number.isFinite(status.progress) ? Math.round(status.progress * 100) : 0;
      violations.push(this._makeViolation(DOC_COMPLETENESS_RULES.SDD_CONTRACT_COMPLETE, 'sdd/', 'SDD contract incomplete (progress: ' + progressPct + '%, current stage: ' + status.currentStage + ')'));
    }
    for (let i = 0; i < violations.length; i++) this._results.push(violations[i]);
    if (this._results.length > MAX_RESULTS) {
      this._results.splice(0, this._results.length - MAX_RESULTS);
    }
    return violations;
  }

  /**
   * 检查命名规范合规性。
   * @param {'file'|'class'|'method'|'constant'|'event'|'error-code'} type - 命名类型
   * @param {string} name - 待检查的名称
   * @returns {boolean} 是否符合命名规范
   */
  checkNamingConvention(type, name) {
    switch (type) {
      case 'file':
        return !checkKebabCase(name);
      case 'class':
        return PASCAL_CASE_RE.test(name);
      case 'method':
        return CAMEL_CASE_RE.test(name);
      case 'constant':
        return UPPER_SNAKE_RE.test(name);
      case 'event':
        return EVENT_KEBAB_RE.test(name);
      case 'error-code':
        return ERROR_CODE_RE.test(name);
      default:
        return true;
    }
  }

  /**
   * 检查模块是否为Node.js内置模块。
   * @param {string} moduleName - 模块名称
   * @returns {boolean} 是否为内置模块
   */
  checkDependency(moduleName) {
    return this._isBuiltInModule(moduleName);
  }

  /**
   * 获取所有检查结果的副本。
   * @returns {Array<object>} 违规结果列表
   */
  getResults() {
    return this._results.slice();
  }

  /**
   * 获取合规检查摘要统计。
   * @returns {{total: number, errors: number, warnings: number, infos: number, errorFiles: string[], warningFiles: string[], compliant: boolean}} 合规摘要
   */
  getSummary() {
    const errors = this._results.filter(v => v.level === RULE_LEVELS.ERROR);
    const warnings = this._results.filter(v => v.level === RULE_LEVELS.WARN);
    const infos = this._results.filter(v => v.level === RULE_LEVELS.INFO);
    return {
      total: this._results.length,
      errors: errors.length,
      warnings: warnings.length,
      infos: infos.length,
      errorFiles: [...new Set(errors.map(v => v.file))],
      warningFiles: [...new Set(warnings.map(v => v.file))],
      compliant: errors.length === 0,
    };
  }

  /**
   * 添加规则豁免。
   * @param {string} ruleId - 规则ID
   * @param {string} filePath - 豁免的文件路径
   * @emits FrameworkComplianceChecker#exemption-added
   */
  addExemption(ruleId, filePath) {
    this.guardShutdown();
    if (!ruleId || typeof ruleId !== 'string') return;
    if (!filePath || typeof filePath !== 'string') return;
    if (filePath === '*' || filePath === '/' || filePath.length < 2) return;
    if (filePath.endsWith('/') && filePath.split('/').filter(Boolean).length <= 1) return;
    if (!this._exemptions[ruleId]) {
      this._exemptions[ruleId] = [];
    }
    if (this._exemptions[ruleId].length >= this._maxExemptionsPerRule) return;
    if (!this._exemptions[ruleId].includes(filePath)) {
      this._exemptions[ruleId].push(filePath);
      this.emit('exemption-added', { ruleId, filePath });
    }
  }

  /**
   * 移除规则豁免。
   * @param {string} ruleId - 规则ID
   * @param {string} filePath - 豁免的文件路径
   * @emits FrameworkComplianceChecker#exemption-removed
   */
  removeExemption(ruleId, filePath) {
    this.guardShutdown();
    if (this._exemptions[ruleId]) {
      this._exemptions[ruleId] = this._exemptions[ruleId].filter(f => f !== filePath);
      this.emit('exemption-removed', { ruleId, filePath });
    }
  }

  /**
   * 获取所有豁免配置的副本。
   * @returns {Object<string, string[]>} 豁免映射
   */
  getExemptions() {
    return { ...this._exemptions };
  }

  _isExempted(ruleId, filePath) {
    const exemptions = this._exemptions[ruleId];
    if (!exemptions) return false;
    const normalizedFile = filePath.replace(/\\/g, '/');
    return exemptions.some(e => {
      const normalizedExempt = e.replace(/\\/g, '/');
      if (normalizedFile === normalizedExempt) return true;
      const exemptDir = normalizedExempt.endsWith('/') ? normalizedExempt : normalizedExempt + '/';
      return normalizedFile.startsWith(exemptDir);
    });
  }

  _isBuiltInModule(mod) {
    return BUILTIN_MODULES_SET.has(mod);
  }

  _makeViolation(rule, file, message) {
    return {
      ruleId: rule.id,
      level: rule.level,
      description: rule.description,
      file,
      message,
      timestamp: new Date().toISOString(),
    };
  }


  _onShutdown() {
    this._results = [];
    this._exemptions = {};
    this._maxExemptionsPerRule = 50;
    this.removeAllListeners();
  }
}

FrameworkComplianceChecker.RULE_LEVELS = RULE_LEVELS;
FrameworkComplianceChecker.NAMING_RULES = NAMING_RULES;
FrameworkComplianceChecker.STRUCTURE_RULES = STRUCTURE_RULES;
FrameworkComplianceChecker.SECURITY_RULES = SECURITY_RULES;
FrameworkComplianceChecker.PERSISTENCE_RULES = PERSISTENCE_RULES;
FrameworkComplianceChecker.API_RULES = API_RULES;
FrameworkComplianceChecker.ERROR_RULES = ERROR_RULES;
FrameworkComplianceChecker.KARPATHY_RULES = KARPATHY_RULES;
FrameworkComplianceChecker.DESIGN_RULES = DESIGN_RULES;
FrameworkComplianceChecker.APPROVED_SRC_DIRS = APPROVED_SRC_DIRS;
FrameworkComplianceChecker.AI_BAD_CODE_RULES = AI_BAD_CODE_RULES;
FrameworkComplianceChecker.DOC_COMPLETENESS_RULES = DOC_COMPLETENESS_RULES;

module.exports = withShutdown(FrameworkComplianceChecker);
