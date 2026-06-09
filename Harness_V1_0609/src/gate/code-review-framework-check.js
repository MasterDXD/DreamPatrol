'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { BUILTIN_MODULES_SET, validateProjectRoot, DANGEROUS_KEYS, MAX_JSON_FILE_SIZE, DEFAULT_DEBOUNCE_MS, UTF8_ENCODING } = require('../utils/constants');
const { createPersister } = require('../utils/debounced-persister');
const { debug } = require('../utils/debug-logger');
const JsonStoreRestorer = require('../utils/json-store-restorer');
const { stripCommentsAndStrings, checkNoEval, checkCryptoSafe, checkClassExport, checkKebabCase } = require('./shared-rule-helpers');
const { withShutdown } = require('../utils/shutdown-mixin');
const { emitError, safeDateGetTime } = require('../utils/safe-execute');
const { HarnessError } = require('../errors');
const { uuid, ID_PREFIXES } = require('../utils/unique-id');

/**
 * @module gate/code-review-framework-check
 * 代码审查框架检查器。自动化代码审查框架，支持九大类别可配置检查清单，
 * 审查生命周期管理（创建、运行、批准、拒绝、请求修改）和防抖持久化。
 */

/** @constant {object} REVIEW_STATUS - 审查状态枚举 */
const REVIEW_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  NEEDS_CHANGES: 'needs_changes',
};

/** @constant {object} REVIEW_CATEGORIES - 审查类别枚举 */
const REVIEW_CATEGORIES = {
  FRAMEWORK_COMPLIANCE: 'framework-compliance',
  NAMING_CONVENTION: 'naming-convention',
  SECURITY: 'security',
  ERROR_HANDLING: 'error-handling',
  PERSISTENCE: 'persistence',
  API_DESIGN: 'api-design',
  TEST_COVERAGE: 'test-coverage',
  DOCUMENTATION: 'documentation',
  DESIGN_COMPLIANCE: 'design-compliance',
};

/** @constant {number} MAX_REVIEWS - 最大审查记录数 */
const MAX_REVIEWS = 100;

/** @constant {object} RULE_CHECKERS - 规则检查器映射 */
const RULE_CHECKERS = {
  'file-kebab-case': (content, basename, filePath) => {
    if (checkKebabCase(basename)) {
      return [{ file: filePath, message: `File '${basename}' not kebab-case` }];
    }
    return [];
  },
  'class-pascal-case': (content) => {
    const violations = [];
    const classMatches = content.matchAll(/\bclass\s+([A-Za-z_]\w*)/g);
    for (const m of classMatches) {
      if (!/^[A-Z][a-zA-Z0-9]*$/.test(m[1])) {
        violations.push({ file: '', message: `Class '${m[1]}' not PascalCase` });
      }
    }
    return violations;
  },
  'constant-upper-snake': (content) => {
    const violations = [];
    const constMatches = content.matchAll(/const\s+([a-zA-Z_]\w*)\s*=\s*(?:\d+|['"])/g);
    for (const m of constMatches) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(m[1]) && m[1] !== m[1].toLowerCase()) {
        if (!m[1].startsWith('_') && m[1].length > 2) {
          violations.push({ file: '', message: `Constant '${m[1]}' not UPPER_SNAKE_CASE` });
        }
      }
    }
    return violations;
  },
  'use-strict': (content, _basename, filePath) => {
    const firstLine = content.split('\n')[0].trim();
    if (firstLine !== "'use strict';" && firstLine !== '"use strict";') {
      return [{ file: filePath, message: 'Missing use strict' }];
    }
    return [];
  },
  'no-external-deps': (content, _basename, filePath) => {
    const violations = [];
    const requireMatches = content.matchAll(/require\(['"]((?:@[^/'"]+\/)?[^./'"]+)['"]\)/g);
    for (const m of requireMatches) {
      if (!BUILTIN_MODULES_SET.has(m[1])) {
        violations.push({ file: filePath, message: `External dep '${m[1]}'` });
      }
    }
    return violations;
  },
  'no-eval': (content, _basename, filePath) => {
    const stripped = stripCommentsAndStrings(content);
    if (checkNoEval(stripped)) {
      return [{ file: filePath, message: 'eval() or Function() detected' }];
    }
    return [];
  },
  'crypto-safe-random': (content, _basename, filePath) => {
    const stripped = stripCommentsAndStrings(content);
    if (checkCryptoSafe(stripped)) {
      return [{ file: filePath, message: 'ID uses Math.random()' }];
    }
    return [];
  },
  'class-export': (content, _basename, filePath) => {
    if (checkClassExport(content)) {
      return [{ file: filePath, message: 'Class not exported' }];
    }
    return [];
  },
  'event-kebab-case': (content, _basename, filePath) => {
    const violations = [];
    const emitMatches = content.matchAll(/\.emit\(['"]([^'"]+)['"]/g);
    for (const m of emitMatches) {
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(m[1])) {
        violations.push({ file: filePath, message: `Event '${m[1]}' not kebab-case` });
      }
    }
    const publishMatches = content.matchAll(/\.publish\(['"]([^'"]+)['"]/g);
    for (const m of publishMatches) {
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(m[1])) {
        violations.push({ file: filePath, message: `Event '${m[1]}' not kebab-case` });
      }
    }
    return violations;
  },
  'no-pure-black': (content, _basename, filePath) => {
    const violations = [];
    if (/#000000|#000\b|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(content)) {
      violations.push({ file: filePath, message: 'Pure black detected — use design token grays' });
    }
    return violations;
  },
  'no-ai-gradient': (content, _basename, filePath) => {
    const violations = [];
    if (/linear-gradient\([^)]*(?:purple|violet|#[8-9a-f]0[0-9a-f]{3})[^)]*blue/i.test(content)) {
      violations.push({ file: filePath, message: 'AI-style purple-blue gradient detected' });
    }
    return violations;
  },
  'no-neon-glow': (content, _basename, filePath) => {
    const violations = [];
    const neonMatches = content.matchAll(/box-shadow:[^;]*(?:#[0-9a-f]{3,6}|rgba?\([^)]*\))[^;]*\d+px\s+\d+px\s+\d+px/gi);
    for (const m of neonMatches) {
      const spreadMatch = m[0].match(/(\d+)px\s*$/);
      if (spreadMatch) { const n = parseInt(spreadMatch[1], 10); if (Number.isFinite(n) && n > 20) {
        violations.push({ file: filePath, message: 'Neon glow effect with large spread detected' });
      } }
    }
    return violations;
  },
  'accessibility-contrast': (content, _basename, filePath) => {
    const violations = [];
    const colorMatches = [...content.matchAll(/color:\s*(#[0-9a-fA-F]{3,6})/g)];
    const bgMatches = [...content.matchAll(/background(?:-color)?:\s*(#[0-9a-fA-F]{3,6})/g)];
    if (colorMatches.length > 0 && bgMatches.length > 0 && /\.(?:css|html|htm|jsx|tsx|vue|svelte)$/.test(filePath)) {
      violations.push({ file: filePath, message: 'Contrast check requires manual WCAG AA verification' });
    }
    return violations;
  },
  'accessibility-alt-text': (content, _basename, filePath) => {
    const violations = [];
    const imgMatches = content.matchAll(/<img\b[^>]*>/g);
    for (const m of imgMatches) {
      if (!/alt\s*=/.test(m[0])) {
        violations.push({ file: filePath, message: 'Image element missing alt attribute' });
      }
    }
    return violations;
  },
  'accessibility-reduced-motion': (content, _basename, filePath) => {
    const violations = [];
    const hasAnimation = /[\{;]\s*(?:animation|transition)(?:-[^:]+)?\s*:/i.test(content);
    const hasReducedMotion = /prefers-reduced-motion/i.test(content);
    if (hasAnimation && !hasReducedMotion) {
      violations.push({ file: filePath, message: 'Animations without prefers-reduced-motion fallback' });
    }
    return violations;
  },
};

/**
 * @classdesc 代码审查框架。自动检查清单，命名/结构/安全/测试合规
 * 代码审查框架检查器。自动化代码审查框架，支持九大类别可配置检查清单
 * （命名规范、框架合规、安全、错误处理、持久化、API设计、测试覆盖、文档、设计合规），
 * 审查生命周期管理和防抖持久化。
 * @extends EventEmitter
 * @emits review-created | review-completed | review-approved | review-needs-changes | review-rejected | check-error
 */
class CodeReviewFrameworkCheck extends EventEmitter {
  /**
   * 创建CodeReviewFrameworkCheck实例。
   * @param {string} projectRoot - 项目根目录路径
   * @param {object} [options] - 配置选项
   * @param {number} [options.maxReviews=100] - 最大审查记录数
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'CodeReviewFrameworkCheck');
    this.root = projectRoot;
    this._maxReviews = (options && options.maxReviews !== undefined) ? options.maxReviews : MAX_REVIEWS;
    this._reviews = new Map();
    this._persister = createPersister({
      root: projectRoot,
      dir: 'reviews',
      filename: 'reviews.json',
      debounceMs: DEFAULT_DEBOUNCE_MS,
      serialize: () => {
        const data = [];
        for (const [, r] of this._reviews) data.push(r);
        return data;
      },
      onError: (err) => { debug('CodeReview', 'persist', err); },
    });
    this._restore();
  }

  /**
   * 创建代码审查。
   * @param {object} data - 审查数据
   * @param {string[]} data.targetFiles - 目标文件列表
   * @param {string} [data.reviewer='system'] - 审查人
   * @param {string} [data.author='unknown'] - 作者
   * @param {string} [data.description=''] - 描述
   * @returns {object} 创建的审查记录
   * @throws {HarnessError} targetFiles无效时抛出
   * @emits CodeReviewFrameworkCheck#review-created
   */
  createReview(data) {
    this.guardShutdown();
    if (!data || !data.targetFiles || !Array.isArray(data.targetFiles) || data.targetFiles.length === 0) {
      throw new HarnessError('INVALID_INPUT', 'Review requires targetFiles array');
    }

    const id = uuid(ID_PREFIXES.CODE_REVIEW);
    const review = {
      id,
      targetFiles: data.targetFiles,
      reviewer: data.reviewer || 'system',
      author: data.author ?? 'unknown',
      description: data.description || '',
      status: REVIEW_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      checklist: this._buildChecklist(data.targetFiles),
      findings: [],
      verdict: null,
    };

    if (this._reviews.size >= this._maxReviews) {
      this._evictOldest();
    }

    this._reviews.set(id, review);
    this._schedulePersist();
    this.emit('review-created', review);
    return review;
  }

  /**
   * 运行审查检查清单，自动检测所有目标文件的合规性。
   * @param {string} reviewId - 审查ID
   * @returns {object|null} 更新后的审查记录，未找到时返回null
   * @emits CodeReviewFrameworkCheck#review-completed
   */
  runChecklist(reviewId) {
    this.guardShutdown();
    const review = this._reviews.get(reviewId);
    if (!review) return null;

    review.status = REVIEW_STATUS.IN_PROGRESS;
    review.updatedAt = new Date().toISOString();

    const findings = [];

    for (const item of review.checklist) {
      const result = this._checkItem(item, review.targetFiles);
      if (result.violations.length > 0) {
        findings.push({
          category: item.category,
          ruleId: item.ruleId,
          severity: item.severity,
          violations: result.violations,
          passed: false,
        });
      }
    }

    review.findings = findings;
    review.updatedAt = new Date().toISOString();

    const hasErrors = findings.some(f => f.severity === 'error');
    const hasWarnings = findings.some(f => f.severity === 'warn');

    if (hasErrors) {
      review.verdict = 'fail';
    } else if (hasWarnings) {
      review.verdict = 'pass-with-warnings';
    } else {
      review.verdict = 'pass';
    }

    this._schedulePersist();
    this.emit('review-completed', { reviewId, verdict: review.verdict, findingCount: findings.length });
    return review;
  }

  /**
   * 批准审查。
   * @param {string} reviewId - 审查ID
   * @param {string} [approver] - 批准人
   * @param {string} [comment] - 批准意见
   * @returns {object|null} 更新后的审查记录或错误对象，未找到时返回null
   * @emits CodeReviewFrameworkCheck#review-approved
   */
  approveReview(reviewId, approver, comment) {
    this.guardShutdown();
    const review = this._reviews.get(reviewId);
    if (!review) return null;

    if (review.status === REVIEW_STATUS.PENDING) {
      return { success: false, reason: 'Cannot approve review before running checklist' };
    }

    review.status = REVIEW_STATUS.APPROVED;
    review.approver = approver ?? 'unknown';
    review.approvedAt = new Date().toISOString();
    review.approvalComment = comment || '';
    review.updatedAt = new Date().toISOString();

    this._schedulePersist();
    this.emit('review-approved', review);
    return review;
  }

  /**
   * 请求修改审查。
   * @param {string} reviewId - 审查ID
   * @param {string} [requester] - 请求人
   * @param {string} [comment] - 修改意见
   * @returns {object|null} 更新后的审查记录，未找到时返回null
   * @emits CodeReviewFrameworkCheck#review-needs-changes
   */
  requestChanges(reviewId, requester, comment) {
    this.guardShutdown();
    const review = this._reviews.get(reviewId);
    if (!review) return null;

    review.status = REVIEW_STATUS.NEEDS_CHANGES;
    review.changeRequester = requester ?? 'unknown';
    review.changeComment = comment || '';
    review.updatedAt = new Date().toISOString();

    this._schedulePersist();
    this.emit('review-needs-changes', review);
    return review;
  }

  /**
   * 拒绝审查。
   * @param {string} reviewId - 审查ID
   * @param {string} [rejecter] - 拒绝人
   * @param {string} [comment] - 拒绝原因
   * @returns {object|null} 更新后的审查记录，未找到时返回null
   * @emits CodeReviewFrameworkCheck#review-rejected
   */
  rejectReview(reviewId, rejecter, comment) {
    this.guardShutdown();
    const review = this._reviews.get(reviewId);
    if (!review) return null;

    review.status = REVIEW_STATUS.REJECTED;
    review.rejecter = rejecter ?? 'unknown';
    review.rejectionComment = comment || '';
    review.updatedAt = new Date().toISOString();

    this._schedulePersist();
    this.emit('review-rejected', review);
    return review;
  }

  /**
   * 获取指定审查记录。
   * @param {string} reviewId - 审查ID
   * @returns {object|null} 审查记录，未找到时返回null
   */
  getReview(reviewId) {
    return this._reviews.get(reviewId) ?? null;
  }

  /**
   * 按状态获取审查列表。
   * @param {string} status - 审查状态
   * @returns {Array<object>} 匹配的审查列表
   */
  getReviewsByStatus(status) {
    const results = [];
    for (const [, r] of this._reviews) {
      if (r.status === status) results.push(r);
    }
    return results;
  }

  /**
   * 按作者获取审查列表。
   * @param {string} author - 作者名称
   * @returns {Array<object>} 匹配的审查列表
   */
  getReviewsByAuthor(author) {
    const results = [];
    for (const [, r] of this._reviews) {
      if (r.author === author) results.push(r);
    }
    return results;
  }

  /**
   * 获取审查统计信息。
   * @returns {{total: number, byStatus: object, byVerdict: object}} 统计信息
   */
  getStats() {
    const stats = { total: this._reviews.size, byStatus: {}, byVerdict: {} };
    for (const status of Object.values(REVIEW_STATUS)) {
      stats.byStatus[status] = 0;
    }
    for (const [, r] of this._reviews) {
      stats.byStatus[r.status] = (stats.byStatus[r.status] ?? 0) + 1;
      if (r.verdict) {
        stats.byVerdict[r.verdict] = (stats.byVerdict[r.verdict] ?? 0) + 1;
      }
    }
    return stats;
  }

  /**
   * 立即持久化审查数据到磁盘。
   */
  flush() {
    this._persister.flush();
  }

  _onShutdown() {
    this.flush();
    this._reviews.clear();
    this.removeAllListeners();
  }

  _buildChecklist(targetFiles) {
    const checklist = [];

    const hasSrcFiles = targetFiles.some(f => f.includes(path.join('src', 'runtime')) || f.includes(path.join('src', 'gate')) || f.includes(path.join('src', 'permission')));
    const hasWebFiles = targetFiles.some(f => f.includes(path.join('src', 'web')));
    const hasTestFiles = targetFiles.some(f => f.includes('test'));

    checklist.push(
      { category: REVIEW_CATEGORIES.NAMING_CONVENTION, ruleId: 'file-kebab-case', description: 'File names follow kebab-case', severity: 'error', auto: true },
      { category: REVIEW_CATEGORIES.NAMING_CONVENTION, ruleId: 'class-pascal-case', description: 'Class names follow PascalCase', severity: 'error', auto: true },
      { category: REVIEW_CATEGORIES.NAMING_CONVENTION, ruleId: 'constant-upper-snake', description: 'Constants follow UPPER_SNAKE_CASE', severity: 'error', auto: true },
      { category: REVIEW_CATEGORIES.NAMING_CONVENTION, ruleId: 'event-kebab-case', description: 'Event names follow kebab-case', severity: 'error', auto: true },
    );

    checklist.push(
      { category: REVIEW_CATEGORIES.FRAMEWORK_COMPLIANCE, ruleId: 'use-strict', description: 'Files start with use strict', severity: 'error', auto: true },
      { category: REVIEW_CATEGORIES.FRAMEWORK_COMPLIANCE, ruleId: 'class-export', description: 'Module exports single class', severity: 'warn', auto: true },
      { category: REVIEW_CATEGORIES.FRAMEWORK_COMPLIANCE, ruleId: 'no-external-deps', description: 'No external dependencies', severity: 'error', auto: true },
    );

    checklist.push(
      { category: REVIEW_CATEGORIES.SECURITY, ruleId: 'no-eval', description: 'No eval() or Function()', severity: 'error', auto: true },
      { category: REVIEW_CATEGORIES.SECURITY, ruleId: 'crypto-safe-random', description: 'ID generation uses crypto.randomUUID()', severity: 'error', auto: true },
      { category: REVIEW_CATEGORIES.SECURITY, ruleId: 'path-traversal-guard', description: 'File ops check path traversal', severity: 'warn', auto: false },
    );

    if (hasSrcFiles) {
      checklist.push(
        { category: REVIEW_CATEGORIES.ERROR_HANDLING, ruleId: 'custom-error-class', description: 'Errors use HarnessError hierarchy', severity: 'error', auto: false },
        { category: REVIEW_CATEGORIES.ERROR_HANDLING, ruleId: 'error-code-upper', description: 'Error codes use UPPER_SNAKE_CASE', severity: 'error', auto: false },
        { category: REVIEW_CATEGORIES.PERSISTENCE, ruleId: 'debounce-write', description: 'High-frequency writes use debounce', severity: 'warn', auto: false },
        { category: REVIEW_CATEGORIES.PERSISTENCE, ruleId: 'graceful-shutdown', description: 'Modules implement flush()/shutdown()', severity: 'error', auto: false },
      );
    }

    if (hasWebFiles) {
      checklist.push(
        { category: REVIEW_CATEGORIES.API_DESIGN, ruleId: 'cors-headers', description: 'API sets proper CORS headers', severity: 'warn', auto: false },
        { category: REVIEW_CATEGORIES.API_DESIGN, ruleId: 'security-headers', description: 'HTTP responses include security headers', severity: 'warn', auto: false },
        { category: REVIEW_CATEGORIES.API_DESIGN, ruleId: 'input-validation', description: 'API inputs are validated', severity: 'error', auto: false },
      );
    }

    if (hasTestFiles) {
      checklist.push(
        { category: REVIEW_CATEGORIES.TEST_COVERAGE, ruleId: 'test-exists', description: 'Tests exist for new modules', severity: 'warn', auto: false },
        { category: REVIEW_CATEGORIES.TEST_COVERAGE, ruleId: 'test-edge-cases', description: 'Edge cases are tested', severity: 'warn', auto: false },
      );
    }

    checklist.push(
      { category: REVIEW_CATEGORIES.DOCUMENTATION, ruleId: 'jsdoc-present', description: 'Public methods have JSDoc', severity: 'info', auto: false },
    );

    checklist.push(
      { category: REVIEW_CATEGORIES.DESIGN_COMPLIANCE, ruleId: 'no-pure-black', description: 'CSS does not use pure black (#000000)', severity: 'warn', auto: true },
      { category: REVIEW_CATEGORIES.DESIGN_COMPLIANCE, ruleId: 'no-ai-gradient', description: 'CSS does not use AI-style purple-blue gradients', severity: 'warn', auto: true },
      { category: REVIEW_CATEGORIES.DESIGN_COMPLIANCE, ruleId: 'no-neon-glow', description: 'CSS does not use neon glow effects', severity: 'warn', auto: true },
      { category: REVIEW_CATEGORIES.DESIGN_COMPLIANCE, ruleId: 'design-token-usage', description: 'CSS uses design token variables for spacing, colors, shadows', severity: 'info', auto: false },
      { category: REVIEW_CATEGORIES.DESIGN_COMPLIANCE, ruleId: 'accessibility-contrast', description: 'Frontend code meets WCAG AA contrast requirements', severity: 'error', auto: true },
      { category: REVIEW_CATEGORIES.DESIGN_COMPLIANCE, ruleId: 'accessibility-alt-text', description: 'Images have alt attributes', severity: 'error', auto: true },
      { category: REVIEW_CATEGORIES.DESIGN_COMPLIANCE, ruleId: 'accessibility-focus', description: 'Interactive elements have focus styles', severity: 'warn', auto: false },
      { category: REVIEW_CATEGORIES.DESIGN_COMPLIANCE, ruleId: 'accessibility-reduced-motion', description: 'Animations have prefers-reduced-motion fallback', severity: 'warn', auto: true },
    );

    return checklist;
  }

  async _checkItemWith(item, targetFiles, { existsFn, readFn }) {
    const violations = [];
    if (!item.auto) return { violations };

    const checker = RULE_CHECKERS[item.ruleId];
    if (!checker) return { violations };

    const resolvedRoot = path.resolve(this.root);
    for (const filePath of targetFiles) {
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.root, filePath);
      const resolvedPath = path.resolve(absPath);
      if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) continue;

      const exists = await existsFn(absPath);
      if (!exists) continue;

      try {
        const content = await readFn(absPath);
        const basename = path.basename(absPath);
        const fileViolations = checker(content, basename, filePath);
        violations.push(...fileViolations);
      } catch (_err) {
        debug('CodeReview', 'checkItem', _err);
        emitError(this, 'check-error', _err, { filePath: absPath });
      }
    }

    return { violations };
  }

  _checkItem(item, targetFiles) {
    const existsFn = (p) => fs.existsSync(p);
    const readFn = (p) => fs.readFileSync(p, UTF8_ENCODING);
    const violations = [];
    if (!item.auto) return { violations };

    const checker = RULE_CHECKERS[item.ruleId];
    if (!checker) return { violations };

    for (const filePath of targetFiles) {
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.root, filePath);
      const resolvedPath = path.resolve(absPath);
      const resolvedRoot = path.resolve(this.root);
      if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) continue;

      if (!existsFn(absPath)) continue;

      try {
        const content = readFn(absPath);
        const basename = path.basename(absPath);
        const fileViolations = checker(content, basename, filePath);
        violations.push(...fileViolations);
      } catch (_err) {
        debug('CodeReview', 'checkItem', _err);
        emitError(this, 'check-error', _err, { filePath: absPath });
      }
    }

    return { violations };
  }

  async _checkItemAsync(item, targetFiles) {
    return this._checkItemWith(item, targetFiles, {
      existsFn: async (p) => { try { await fs.promises.access(p); return true; } catch (_e) { debug('CodeReviewFrameworkCheck', 'fileExists', _e && _e.message ? _e.message : String(_e)); return false; } },
      readFn: (p) => fs.promises.readFile(p, UTF8_ENCODING),
    });
  }

  _evictOldest() {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, r] of this._reviews) {
      if (r.status === REVIEW_STATUS.REJECTED || r.status === REVIEW_STATUS.APPROVED) {
        const ts = safeDateGetTime(r.updatedAt);
        if (!Number.isFinite(ts)) continue;
        if (ts < oldestTime) {
          oldestTime = ts;
          oldestId = id;
        }
      }
    }
    if (!oldestId) {
      for (const [id, r] of this._reviews) {
        const dateVal = r.updatedAt || r.createdAt;
        const ts = dateVal ? safeDateGetTime(dateVal) : NaN;
        if (!Number.isFinite(ts)) continue;
        if (ts < oldestTime) {
          oldestTime = ts;
          oldestId = id;
        }
      }
    }
    if (oldestId) {
      this._reviews.delete(oldestId);
    }
  }

  _schedulePersist() {
    if (!this.isHealthy()) return;
    this._persister.schedule();
  }

  async _restoreWith(loader) {
    try {
      const result = await loader();
      if (!result || !Array.isArray(result.data)) return;
      for (const r of result.data) {
        if (r && r.id && typeof r.id === 'string') {
          if (Object.keys(r).some(k => DANGEROUS_KEYS.has(k))) continue;
          this._reviews.set(r.id, r);
        }
      }
    } catch (_err) {
      debug('CodeReview', 'restore', _err);
    }
  }

  _restore() {
    try {
      const result = JsonStoreRestorer.loadSync(this.root, 'reviews/reviews.json', {
        maxSize: MAX_JSON_FILE_SIZE,
        expectedType: 'array',
        logLabel: 'CodeReview',
      });
      if (!result || !Array.isArray(result.data)) return;
      for (const r of result.data) {
        if (r && r.id && typeof r.id === 'string') {
          if (Object.keys(r).some(k => DANGEROUS_KEYS.has(k))) continue;
          this._reviews.set(r.id, r);
        }
      }
    } catch (_err) {
      debug('CodeReview', 'restore', _err);
      try { this.emit('restore-error', { source: 'reviews', error: _err && _err.message ? _err.message : String(_err) }); } catch (_e) { debug('CodeReview', 'restore-emit', _e && _e.message ? _e.message : String(_e)); }
    }
  }

  async _restoreAsync() {
    return this._restoreWith(() => JsonStoreRestorer.loadAsync(this.root, 'reviews/reviews.json', {
      maxSize: MAX_JSON_FILE_SIZE,
      expectedType: 'array',
      logLabel: 'CodeReview',
    }));
  }
}

CodeReviewFrameworkCheck.REVIEW_STATUS = REVIEW_STATUS;
CodeReviewFrameworkCheck.REVIEW_CATEGORIES = REVIEW_CATEGORIES;
CodeReviewFrameworkCheck.MAX_REVIEWS = MAX_REVIEWS;

module.exports = withShutdown(CodeReviewFrameworkCheck);
