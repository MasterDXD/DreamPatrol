/**
 * @module runtime/workflow/hook-handlers
 * @classdesc 钩子处理器集合（HookHandlers）。10+内置处理器实现。
 * 可编程钩子处理器集合，提供10+内置处理器实现。
 * 涵盖路径验证、内容安全、权限检查、参数校验、速率限制、交付物完整性、
 * 质量标准、Token预算、完成前验证、审计日志、简洁性检查、精准变更检查、
 * 核心身份注入、技能路由注入、阶段上下文加载、阶段错误回滚/重试/升级、
 * YAGNI预检、输出格式检查、设计反模式检查、无障碍合规检查、AI服务安全检查等处理器。
 * 所有处理器遵循统一的 { passed, reason?, message?, ... } 返回格式。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { DEFAULT_TOKEN_BUDGET, TOKEN_BUDGET_WARNING_RATIO, TOKEN_BUDGET_DANGER_RATIO, DESIGN_PATTERNS, DEFAULT_MAX_ENTRIES, DEFAULT_FALLBACK_INTERVAL_MS, getHarnessConfigPath, UTF8_ENCODING, HARNESS_DIR } = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');
const { sanitize: sanitizeData } = require('../../utils/debounced-persister');
const { safeJsonParse } = require('../../utils/safe-parse');
const { loadJsonAsync } = require('../../utils/fs-utils');
const { ensureArray } = require('../../utils/safe-execute');

/**
 * @constant {RegExp[]} SECRET_PATTERNS - 敏感信息检测正则模式列表，
 * 用于匹配API密钥、密码、私钥等敏感数据，防止泄露到日志或输出中。
 */
const SECRET_PATTERNS = Object.freeze([
  /(?:api[_-]?key|apikey)\s*[:=]\s*["'][^"']{8,}["']/i,
  /(?:secret|token|password|passwd)\s*[:=]\s*["'][^"']{8,}["']/i,
  /sk-[a-zA-Z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
]);

/**
 * @constant {number} RATE_LIMIT_WINDOW - 速率限制滑动窗口时长（毫秒），默认60秒。
 */
const RATE_LIMIT_WINDOW = 60 * 1000;
/**
 * @constant {number} RATE_LIMIT_MAX_CALLS - 单个Agent在窗口内允许的最大调用次数。
 */
const RATE_LIMIT_MAX_CALLS = 100;
/**
 * @constant {number} RATE_LIMIT_MAX_AGENTS - 速率限制器同时追踪的最大Agent数量。
 */
const RATE_LIMIT_MAX_AGENTS = DEFAULT_MAX_ENTRIES;

const OVERIMPLEMENTATION_LINE_THRESHOLD = 200;
const MAX_BACKOFF_MS = 1000;
/**
 * @constant {number} RATE_LIMIT_CLEANUP_INTERVAL - 过期条目清理间隔（毫秒），默认5分钟。
 */
const RATE_LIMIT_CLEANUP_INTERVAL = 5 * 60 * 1000;
/**
 * @constant {Set<string>} RESTRICTED_AGENTS - 只读权限Agent集合，这些Agent禁止执行写文件和删除操作。
 */
const RESTRICTED_AGENTS = new Set(['code-reviewer', 'security-reviewer', 'typescript-reviewer', 'python-reviewer', 'go-reviewer', 'rust-reviewer', 'java-reviewer']);
/**
 * @constant {Set<string>} RESTRICTED_SKILLS - 受限技能集合，仅特权Agent可执行。
 */
const RESTRICTED_SKILLS = new Set(['production-deploy', 'database-migration']);
/**
 * @constant {Set<string>} PRIVILEGED_AGENTS - 特权Agent集合，可执行受限技能。
 */
const PRIVILEGED_AGENTS = new Set(['team-lead', 'devops-engineer']);
/**
 * @constant {Set<string>} STRICT_SKILLS - 严格验证技能集合，完成前必须通过测试和lint检查。
 */
const STRICT_SKILLS = new Set(['tdd-implement', 'module-development', 'bug-fix', 'code-review', 'security-audit', 'integration-testing', 'deployment']);

/**
 * @constant {number} YAGNI_MAX_NEW_FILES - YAGNI检查允许的最大新建文件数。
 */
const YAGNI_MAX_NEW_FILES = 3;
/**
 * @constant {number} YAGNI_MAX_ABSTRACTIONS - YAGNI检查允许的最大新抽象数量。
 */
const YAGNI_MAX_ABSTRACTIONS = 3;
/**
 * @constant {number} YAGNI_MAX_ADDED_LINES - YAGNI检查允许的最大新增行数。
 */
const YAGNI_MAX_ADDED_LINES = 300;
/**
 * @constant {number} YAGNI_MAX_STYLE_CHANGES - 允许的最大纯样式变更数量。
 */
const YAGNI_MAX_STYLE_CHANGES = 5;
/**
 * @constant {number} OUTPUT_MAX_HEADERS - 输出格式检查允许的最大标题数。
 */
const OUTPUT_MAX_HEADERS = 8;
/**
 * @constant {number} OUTPUT_MIN_LENGTH_FOR_HEADERS - 触发标题数量限制的最小输出长度。
 */
const OUTPUT_MIN_LENGTH_FOR_HEADERS = 2000;
/**
 * @constant {number} DESIGN_MAX_HARDCODED_SPACING - 设计检查允许的最大硬编码间距值数量。
 */
const DESIGN_MAX_HARDCODED_SPACING = 5;
/**
 * @constant {number} A11Y_MAX_FOCUS_VIOLATIONS - 无障碍检查允许的最大焦点样式缺失数量。
 */
const A11Y_MAX_FOCUS_VIOLATIONS = 3;
/**
 * @constant {number} ERROR_MAX_RETRIES - 阶段错误最大重试次数。
 */
const ERROR_MAX_RETRIES = 3;
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * 检查diff内容的简洁性违规（行数、预算、抽象模式、接口）。
 * @param {string} diff - git diff 格式的变更内容
 * @param {Object} context - 钩子上下文
 * @param {Array<string>} warnings - 警告收集数组
 */
function _checkDiffSimplicity(diff, context, warnings) {
  const addedLines = (diff.match(/^\+(?!\+|\s*$)/gm) ?? []).length;
  const deletedLines = (diff.match(/^-(?!-|\s*$)/gm) ?? []).length;
  if (addedLines > OVERIMPLEMENTATION_LINE_THRESHOLD && deletedLines < addedLines * 0.1) {
    warnings.push(`Adding ${addedLines} lines with minimal deletion — possible over-implementation`);
  }

  const lineBudget = context.line_budget ?? 0;
  if (lineBudget > 0 && addedLines > lineBudget * 1.5) {
    warnings.push(`Added ${addedLines} lines exceeds budget of ${lineBudget} by ${Math.round(((addedLines / lineBudget) - 1) * 100)}% — simplify or justify`);
  }

  const abstractPatterns = [/class\s+\w+Factory\b/, /class\s+\w+Builder\b/, /class\s+\w+Strategy\b/, /class\s+\w+Adapter\b/];
  for (const pattern of abstractPatterns) {
    if (pattern.test(diff)) {
      warnings.push(`New abstraction pattern detected (${pattern.source}) — verify it has at least 2 callers (YAGNI)`);
      break;
    }
  }

  if (/interface\s+I\w+/.test(diff) && !/implements\s+I\w+/.test(diff)) {
    warnings.push('New interface without implementation — may be unnecessary abstraction');
  }
}

/**
 * 速率限制管理器，基于滑动窗口算法对Agent调用频率进行限制。
 * 使用Map存储每个Agent的调用时间戳，定期清理过期记录。
 * 通过 withShutdown 混入支持优雅关闭，关闭时清理定时器和存储。
 *
 * @class RateLimitManager
 * @classdesc 速率限制管理器，实现基于令牌桶算法的请求速率控制和配额管理
 */
class RateLimitManager extends EventEmitter {
  /**
   * 创建 RateLimitManager 实例，初始化存储和定时清理器。
   * 定时器通过 unref() 标记，不阻止进程退出。
   */
  constructor() {
    super();
    this._store = new Map();
    this._shutDown = false;
    this._timer = setInterval(() => {
      if (this._shutDown) return;
      const now = Date.now();
      const expired = [];
      for (const [agentId, entry] of this._store) {
        entry.timestamps = entry.timestamps.filter(function(ts) { return now - ts < RATE_LIMIT_WINDOW; });
        if (entry.timestamps.length === 0) expired.push(agentId);
      }
      for (const agentId of expired) this._store.delete(agentId);
    }, RATE_LIMIT_CLEANUP_INTERVAL);
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  /**
   * 检查指定Agent是否超过速率限制。
   * 当存储达到最大Agent数时，淘汰最久未活跃的Agent条目。
   *
   * @param {string} agentId - 待检查的Agent标识符
   * @returns {{ passed: boolean, reason?: string, message?: string }} 检查结果，
   *   passed为true表示通过，false表示超限（附带reason说明剩余等待时间）
   */
  check(agentId) {
    if (this._shutDown) return { passed: false, reason: 'Rate limiter is shut down' };
    const now = Date.now();
    if (!this._store.has(agentId)) {
      if (this._store.size >= RATE_LIMIT_MAX_AGENTS) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [key, entry] of this._store) {
          const lastTs = entry.timestamps.length > 0 ? entry.timestamps[entry.timestamps.length - 1] : 0;
          if (lastTs < oldestTime) {
            oldestTime = lastTs;
            oldestKey = key;
          }
        }
        if (oldestKey) this._store.delete(oldestKey);
      }
      this._store.set(agentId, { timestamps: [] });
    }

    const entry = this._store.get(agentId);
    const recentCalls = entry.timestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
    recentCalls.push(now);
    entry.timestamps = recentCalls;
    if (entry.timestamps.length > RATE_LIMIT_MAX_CALLS * 2) {
      entry.timestamps = entry.timestamps.slice(-RATE_LIMIT_MAX_CALLS);
    }

    if (recentCalls.length > RATE_LIMIT_MAX_CALLS) {
      const oldestInWindow = recentCalls[0];
      const resetIn = Math.ceil((RATE_LIMIT_WINDOW - (now - oldestInWindow)) / 1000);
      return { passed: false, reason: `Rate limit exceeded for agent ${agentId}: ${recentCalls.length}/${RATE_LIMIT_MAX_CALLS} calls in window. Reset in ${resetIn}s` };
    }

    return { passed: true, message: `Rate limit check passed for agent ${agentId}: ${recentCalls.length}/${RATE_LIMIT_MAX_CALLS}` };
  }

  /**
   * 检查速率限制管理器是否健康（存储未满）。
   *
   * @returns {boolean} true表示存储未达到上限，false表示已满
   */
  isHealthy() {
    return this._store.size < RATE_LIMIT_MAX_AGENTS;
  }

  /**
   * 关闭钩子，由 withShutdown 混入调用。
   * 清除定时器并清空所有存储的速率限制记录。
   */
  _onShutdown() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._store.clear();
    this.removeAllListeners();
  }
}

/**
 * 通过 withShutdown 混入为 RateLimitManager 添加优雅关闭能力，
 * 确保定时器在宿主关闭时被清理。
 */
RateLimitManager = withShutdown(RateLimitManager);

let _rateLimitManager = null;

/**
 * 获取 RateLimitManager 单例实例。
 * RateLimitManager 已通过 withShutdown 混入具备优雅关闭能力。
 *
 * @returns {RateLimitManager} 速率限制管理器单例
 */
function _getRateLimitManager() {
  if (!_rateLimitManager) {
    _rateLimitManager = new RateLimitManager();
  }
  return _rateLimitManager;
}

/**
 * @constant {Object<string, string[]>} DELIVERABLE_REQUIRED_FIELDS - 各技能要求的交付物必填字段映射。
 * 键为技能ID，值为该技能完成时必须提供的字段名数组。
 */
const DELIVERABLE_REQUIRED_FIELDS = {
  'tdd-implement': ['test_code', 'implementation_code', 'test_results'],
  'code-review': ['review_report', 'issues_list'],
  'bug-fix': ['fix_code', 'test_code', 'verification_evidence'],
  'integration-testing': ['test_report', 'coverage_report'],
  'deployment': ['deployment_report', 'health_check_result'],
  'security-audit': ['audit_report', 'vulnerability_list'],
  'architecture-design': ['architecture_doc', 'module_diagram'],
  'requirement-analysis': ['requirement_spec', 'acceptance_criteria'],
  'brainstorming': ['ideas_list', 'selected_approach'],
};

/**
 * @constant {Object<string, RegExp>} QUALITY_PATTERNS - 代码质量检查正则模式集合，
 * 检测console输出、debugger语句、TODO/FIXME标记、硬编码密钥、空catch块等问题。
 */
const QUALITY_PATTERNS = {
  noConsoleLog: /console\.(log|debug|info|warn|error)\s*\(/g,
  noDebugger: /\bdebugger\s*;?/g,
  noTodoFixme: /(?:TODO|FIXME|HACK|XXX)\s*[\(:]/gi,
  noHardcodedSecrets: /(?:password|secret|api[_-]?key)\s*[:=]\s*["'][^"']+["']/gi,
  noEmptyCatch: /catch\s*\([^)]*\)\s*\{\s*\}/g,
};

/**
 * 验证技能参数是否满足必填要求。
 * 每组参数为"或"关系（组内任一满足即可），组间为"与"关系。
 *
 * @param {string} skillId - 技能标识符
 * @param {Object} parameters - 待验证的参数对象
 * @returns {string[]} 错误消息数组，空数组表示验证通过
 */
function _validateSkillParameters(skillId, parameters) {
  const errors = [];
  const REQUIRED_PARAMS = {
    'tdd-implement': [['description', 'goal']],
    'bug-fix': [['bug_description', 'error_message']],
    'code-review': [['file_path', 'code']],
    'deployment': [['target', 'environment']],
  };
  const required = REQUIRED_PARAMS[skillId];
  if (required) {
    for (const group of required) {
      if (!group.some(p => parameters[p])) {
        errors.push(`Missing required parameter: ${group.join(' or ')}`);
      }
    }
  }
  return errors;
}

/**
 * 验证参数值的长度是否超过上限。
 *
 * @param {Object} parameters - 参数对象
 * @param {string[]} errors - 错误消息收集数组，超长时推入错误描述
 */
function _validateParameterLengths(parameters, errors) {
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (typeof value === 'string' && value.length > DEFAULT_MAX_ENTRIES) {
      errors.push(`Parameter ${key} exceeds maximum length (${DEFAULT_MAX_ENTRIES} chars)`);
    }
  }
}

/**
 * 检查diff中修改的文件数量是否过多（超过10个文件视为变更范围过宽）。
 *
 * @param {string} diff - git diff 格式的变更内容
 * @param {string[]} violations - 违规消息收集数组
 */
function _checkModifiedFileCount(diff, violations) {
  if (typeof diff !== 'string') return;
  const modifiedFiles = (diff.match(/^diff --git/gm) ?? []).length;
  if (modifiedFiles > 10) {
    violations.push(`${modifiedFiles} files modified — change scope may be too wide`);
  }
}

/**
 * 检查非重构任务中是否包含重构操作（如rename/move）。
 *
 * @param {string} diff - git diff 格式的变更内容
 * @param {boolean} isRefactorTask - 当前任务是否为重构任务
 * @param {string[]} violations - 违规消息收集数组
 */
function _checkRefactorInNonRefactorTask(diff, isRefactorTask, violations) {
  if (isRefactorTask || typeof diff !== 'string') return;
  const refactorIndicators = [/^.*rename\s+/m, /^.*move\s+.*from.*to/m];
  for (const indicator of refactorIndicators) {
    if (indicator.test(diff)) {
      violations.push('Refactoring detected in non-refactor task — focus on the requested change only');
      break;
    }
  }
}

/**
 * 检查diff中是否包含过多的纯样式变更。
 * 功能任务中应避免格式化变更，保持变更聚焦。
 *
 * @param {string} diff - git diff 格式的变更内容
 * @param {string[]} violations - 违规消息收集数组
 */
function _checkStyleOnlyChanges(diff, violations) {
  if (typeof diff !== 'string') return;
  const styleOnlyChanges = (diff.match(/^\+[\s]*$/gm) ?? []).filter(() => /^[\s\+\-]*$/.test(diff.replace(/^diff.*$/gm, '')));
  if (styleOnlyChanges.length > YAGNI_MAX_STYLE_CHANGES) {
    violations.push('Style-only changes detected — avoid formatting changes in feature tasks');
  }
}

/**
 * 检查diff中是否存在孤立残留：新增import/变量但未清理对应的旧import/变量。
 * 当删除行数超过新增行数的30%时，提示检查是否有遗留的无用代码。
 *
 * @param {string} diff - git diff 格式的变更内容
 * @param {string[]} violations - 违规消息收集数组
 */
function _checkOrphanResidue(diff, violations) {
  if (typeof diff !== 'string') return;
  const deletedLines = (diff.match(/^-(?!-|\s*$)/gm) ?? []).length;
  const addedLines = (diff.match(/^\+(?!\+|\s*$)/gm) ?? []).length;
  if (addedLines <= 0 || deletedLines <= 0) return;

  const removedImports = (diff.match(/^-.*require\(['"][^'"]+['"]\)/gm) ?? []);
  const addedImports = (diff.match(/^\+.*require\(['"][^'"]+['"]\)/gm) ?? []);
  if (addedImports.length > 0 && removedImports.length === 0 && deletedLines > addedLines * 0.3) {
    violations.push('New imports added but no orphaned imports removed — check if changes left unused imports');
  }

  const removedVars = (diff.match(/^-.*(?:const|let|var)\s+\w+/gm) ?? []);
  const addedVars = (diff.match(/^\+.*(?:const|let|var)\s+\w+/gm) ?? []);
  if (addedVars.length > 0 && removedVars.length === 0 && deletedLines > addedLines * 0.3) {
    violations.push('New variables added but no orphaned variables removed — clean up your own orphans');
  }
}

/**
 * 检查非重构任务中是否删除了预存的死代码（TODO/FIXME/console.log）。
 * 除非被明确要求，否则应提及而非直接删除。
 *
 * @param {string} diff - git diff 格式的变更内容
 * @param {boolean} isRefactorTask - 当前任务是否为重构任务
 * @param {string[]} violations - 违规消息收集数组
 */
function _checkPreExistingDeadCodeRemoval(diff, isRefactorTask, violations) {
  if (isRefactorTask || typeof diff !== 'string') return;
  const preExistingDeadCodeRemoval = (diff.match(/^-.*\/\/.*TODO|^-\s*\/\/.*FIXME|^-\s*console\.log/gm) ?? []);
  if (preExistingDeadCodeRemoval.length > 3) {
    violations.push('Removing pre-existing dead code (TODO/FIXME/console.log) — mention it instead of deleting unless asked');
  }
}

/**
 * 内置钩子处理器集合，包含所有可编程钩子的处理函数。
 * 每个处理器接收 context 对象，返回 { passed: boolean, reason?: string, message?: string, ... } 格式的结果。
 * 处理器按顺序执行，任一处理器返回 passed=false 将阻塞后续流程。
 *
 * @constant {Object<string, Function>} BUILTIN_HANDLERS
 */
const BUILTIN_HANDLERS = {
  /**
   * 路径验证处理器，检查文件路径是否在项目根目录内，并保护系统路径不被写入。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} context.file_path - 待验证的文件路径
   * @param {string} context.project_root - 项目根目录路径
   * @param {string} [context.action] - 操作类型（read/write等）
   * @returns {{ passed: boolean, reason?: string, message?: string }} 验证结果
   */
  path_validation: function pathValidation(context) {
    const filePath = context.file_path || '';
    const projectRoot = context.project_root || '';
    if (!filePath || !projectRoot) {
      return { passed: true, message: 'Insufficient context for path validation' };
    }
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(filePath));
    } catch (_e) {
      resolved = path.resolve(filePath);
    }
    let root;
    try {
      root = fs.realpathSync(path.resolve(projectRoot));
    } catch (_e) {
      root = path.resolve(projectRoot);
    }
    if (!resolved.startsWith(root)) {
      return { passed: false, reason: `Path ${filePath} is outside project root` };
    }
    const protectedPaths = [HARNESS_DIR + '/config.json', HARNESS_DIR + '/agents/', HARNESS_DIR + '/skills/', HARNESS_DIR + '/rules/'];
    for (const protectedPath of protectedPaths) {
      const normalizedProtected = path.normalize(protectedPath);
      const protectedFullPath = path.join(root, normalizedProtected);
      // 使用路径前缀匹配，确保是完整的路径段
      if ((resolved === protectedFullPath || resolved.startsWith(protectedFullPath + path.sep)) && context.action !== 'read') {
        return { passed: false, reason: `Path ${filePath} is a protected system path, write access denied` };
      }
    }
    return { passed: true, message: 'Path is within project root' };
  },

  /**
   * 内容安全处理器，检测内容中是否包含敏感信息（API密钥、密码、私钥等）。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} context.content - 待检查的内容文本
   * @returns {{ passed: boolean, reason?: string, message?: string }} 安全检查结果
   */
  content_safety: function contentSafety(context) {
    const content = context.content || '';
    if (!content) return { passed: true, message: 'No content to check' };

    const findings = [];
    for (let i = 0; i < SECRET_PATTERNS.length; i++) {
      const pattern = SECRET_PATTERNS[i];
      if (pattern.test(content)) {
        findings.push(`Pattern ${i + 1} matched`);
      }
      pattern.lastIndex = 0;
    }

    if (findings.length > 0) {
      return { passed: false, reason: `Content may contain secrets or sensitive information (${findings.join(', ')})` };
    }
    return { passed: true, message: 'Content appears safe' };
  },

  /**
   * 权限检查处理器，验证Agent是否有权执行指定操作。
   * 受限Agent（审查员角色）仅允许读操作，受限技能仅特权Agent可执行。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.agent_id] - Agent标识符
   * @param {string} [context.skill_id] - 技能标识符
   * @param {string} [context.action='execute'] - 操作类型
   * @returns {{ passed: boolean, reason?: string, message?: string }} 权限检查结果
   */
  permission_check: function permissionCheck(context) {
    const agentId = context.agent_id || context.agent || '';
    const skillId = context.skill_id || context.skill || '';
    const action = context.action || 'execute';

    if (!agentId) {
      return { passed: true, message: 'No agent context, permission check skipped' };
    }

    if (RESTRICTED_AGENTS.has(agentId) && (action === 'write_file' || action === 'file_delete')) {
      return { passed: false, reason: `Agent ${agentId} is read-only, cannot perform ${action}` };
    }

    if (RESTRICTED_SKILLS.has(skillId) && !PRIVILEGED_AGENTS.has(agentId)) {
      return { passed: false, reason: `Agent ${agentId} cannot execute restricted skill ${skillId}` };
    }

    return { passed: true, message: `Permission check passed for agent ${agentId}` };
  },

  /**
   * 参数验证处理器，检查技能参数是否满足必填要求和长度限制。
   *
   * @param {Object} context - 钩子上下文
   * @param {Object} [context.parameters] - 技能参数对象
   * @param {string} [context.skill_id] - 技能标识符
   * @returns {{ passed: boolean, reason?: string, message?: string, details?: string[] }} 验证结果
   */
  parameter_validation: function parameterValidation(context) {
    const parameters = context.parameters ?? {};
    const skillId = context.skill_id || context.skill || '';

    if (!skillId || !parameters || typeof parameters !== 'object') {
      return { passed: true, message: 'No parameters to validate' };
    }

    const errors = _validateSkillParameters(skillId, parameters);
    _validateParameterLengths(parameters, errors);

    if (errors.length > 0) {
      return { passed: false, reason: errors.join('; '), details: errors };
    }
    return { passed: true, message: `Parameter validation passed for skill ${skillId}` };
  },

  /**
   * 速率限制检查处理器，委托给 RateLimitManager 单例进行滑动窗口限流。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.agent_id] - Agent标识符
   * @returns {{ passed: boolean, reason?: string, message?: string }} 限流检查结果
   */
  rate_limit_check: function rateLimitCheck(context) {
    const agentId = context.agent_id || context.agent || 'anonymous';
    return _getRateLimitManager().check(agentId);
  },

  /**
   * 备份原始文件处理器，在写入/修改/删除操作前标记需要备份的文件。
   * 返回备份元数据供后续流程使用。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.file_path] - 文件路径
   * @param {string} [context.action] - 操作类型
   * @returns {{ passed: boolean, message?: string, backup?: { file_path: string, timestamp: number, action: string } }} 备份标记结果
   */
  backup_original: function backupOriginal(context) {
    const filePath = context.file_path || '';
    const action = context.action || '';

    if (!filePath || (action !== 'write' && action !== 'modify' && action !== 'delete')) {
      return { passed: true, message: 'No backup needed for this operation' };
    }

    return {
      passed: true,
      message: `Backup marker set for ${filePath}`,
      backup: {
        file_path: filePath,
        timestamp: Date.now(),
        action: action,
      },
    };
  },

  /**
   * 交付物完整性处理器，检查技能完成时是否提供了所有必填的交付物字段。
   * 已完成的技能（在completed_skills中）可豁免对应字段。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.skill_id] - 技能标识符
   * @param {Object} [context.deliverables] - 交付物对象
   * @param {string[]} [context.completed_skills] - 已完成的技能ID列表
   * @returns {{ passed: boolean, reason?: string, message?: string, details?: Object }} 完整性检查结果
   */
  deliverable_completeness: function deliverableCompleteness(context) {
    const skillId = context.skill_id || context.skill || '';
    const deliverables = context.deliverables ?? {};
    const completedSkills = context.completed_skills ?? [];

    if (!skillId) {
      return { passed: true, message: 'No skill context for deliverable check' };
    }

    const requiredFields = DELIVERABLE_REQUIRED_FIELDS[skillId];
    if (!requiredFields) {
      return { passed: true, message: `No deliverable requirements defined for skill ${skillId}` };
    }

    const missing = [];
    const completedSet = new Set(ensureArray(completedSkills));
    for (const field of requiredFields) {
      if (!deliverables[field] && !completedSet.has(field)) {
        missing.push(field);
      }
    }

    if (missing.length > 0) {
      return {
        passed: false,
        reason: `Deliverable incomplete for ${skillId}: missing ${missing.join(', ')}`,
        details: { skillId, missing, required: requiredFields },
      };
    }

    return { passed: true, message: `Deliverable complete for ${skillId}` };
  },

  /**
   * 质量标准处理器，检测代码中的console输出、debugger语句和空catch块等质量问题。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.content] - 代码内容
   * @param {string} [context.code] - 代码内容（备选字段）
   * @param {string} [context.file_path] - 文件路径（用于判断文件类型）
   * @returns {{ passed: boolean, reason?: string, message?: string, details?: Object }} 质量检查结果
   */
  quality_standards: function qualityStandards(context) {
    const content = context.content || context.code || '';
    const filePath = context.file_path || '';

    if (!content) return { passed: true, message: 'No content to check quality' };

    const violations = [];

    if (QUALITY_PATTERNS.noConsoleLog.test(content)) {
      violations.push('console.log statements detected — remove before commit');
    }
    QUALITY_PATTERNS.noConsoleLog.lastIndex = 0;

    if (QUALITY_PATTERNS.noDebugger.test(content)) {
      violations.push('debugger statements detected — remove before commit');
    }
    QUALITY_PATTERNS.noDebugger.lastIndex = 0;

    if (filePath.endsWith('.js') && QUALITY_PATTERNS.noEmptyCatch.test(content)) {
      violations.push('Empty catch blocks detected — handle errors or rethrow');
    }
    QUALITY_PATTERNS.noEmptyCatch.lastIndex = 0;

    if (violations.length > 0) {
      return { passed: false, reason: `Quality violations: ${violations.join('; ')}`, details: { violations } };
    }

    return { passed: true, message: 'Quality standards check passed' };
  },

  /**
   * Token预算检查处理器，根据Token使用比例返回不同级别的检查结果。
   * 100%以上为耗尽（阻断），95%以上为危险（切换低价模型），80%以上为警告。
   *
   * @param {Object} context - 钩子上下文
   * @param {number} [context.token_usage=0] - 已使用的Token数量
   * @param {number} [context.token_budget] - Token预算上限
   * @returns {{ passed: boolean, reason?: string, message?: string, warning?: boolean }} 预算检查结果
   */
  token_budget_check: function tokenBudgetCheck(context) {
    const tokenUsage = typeof context.token_usage === 'number' && Number.isFinite(context.token_usage) ? context.token_usage : 0;
    const tokenBudget = context.token_budget ?? DEFAULT_TOKEN_BUDGET;
    const ratio = tokenBudget > 0 ? tokenUsage / tokenBudget : 0;

    if (ratio >= 1.0) {
      return { passed: false, reason: `Token budget exhausted: ${tokenUsage}/${tokenBudget} (${Math.round(ratio * 100)}%)` };
    }
    if (ratio >= TOKEN_BUDGET_DANGER_RATIO) {
      return { passed: false, reason: `Token budget critical: ${Math.round(ratio * 100)}% used, switching to low-cost model` };
    }
    if (ratio >= TOKEN_BUDGET_WARNING_RATIO) {
      return { passed: true, reason: `Token budget warning: ${Math.round(ratio * 100)}% used`, warning: true };
    }

    return { passed: true, message: `Token budget OK: ${Math.round(ratio * 100)}% used` };
  },

  /**
   * Token自动记录处理器，收集会话Token使用数据并生成记录指令。
   * 不直接写入存储，而是返回记录数据供调用方通过 /api/token/record 端点持久化。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.session_id] - 会话标识符
   * @param {number} [context.tokens] - 总Token使用量
   * @param {number} [context.input_tokens=0] - 输入Token数
   * @param {number} [context.output_tokens=0] - 输出Token数
   * @param {number} [context.tool_call_tokens=0] - 工具调用Token数
   * @returns {{ passed: boolean, message?: string, recorded?: boolean, sessionId?: string, tokens?: number, breakdown?: Object, action?: string }} 记录结果
   */
  token_auto_record: function tokenAutoRecord(context) {
    const sessionId = context.session_id || context.sessionId || '';
    const tokens = context.tokens ?? (context.token_usage ?? 0);
    const inputTokens = context.input_tokens || (context.inputTokens ?? 0);
    const outputTokens = context.output_tokens || (context.outputTokens ?? 0);
    const toolCallTokens = context.tool_call_tokens || (context.toolCallTokens ?? 0);

    if (!sessionId) {
      return { passed: true, message: 'No session context for token recording', recorded: false };
    }
    if (!tokens && !inputTokens && !outputTokens && !toolCallTokens) {
      return { passed: true, message: 'No token usage data to record', recorded: false };
    }

    const totalTokens = tokens || (inputTokens + outputTokens + toolCallTokens);

    return {
      passed: true,
      message: `Token usage recorded: ${totalTokens} tokens for session ${sessionId}`,
      recorded: true,
      sessionId: sessionId,
      tokens: totalTokens,
      breakdown: { input: inputTokens, output: outputTokens, toolCall: toolCallTokens },
      action: 'call /api/token/record with this data',
    };
  },

  /**
   * 完成前验证处理器，对严格验证技能（TDD、模块开发、Bug修复等）强制要求测试和lint通过。
   * 非严格技能直接通过。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.skill_id] - 技能标识符
   * @param {Object} [context.test_results] - 测试结果 { total: number, failed: number }
   * @param {Object} [context.lint_results] - Lint结果 { errors: number }
   * @returns {{ passed: boolean, reason?: string, message?: string }} 验证结果
   */
  verification_before_completion: function verificationBeforeCompletion(context) {
    const skillId = context.skill_id || context.skill || '';
    const testResults = context.test_results ?? {};
    const lintResults = context.lint_results ?? {};

    if (!skillId) {
      return { passed: true, message: 'No skill context for verification' };
    }

    const strictSkills = STRICT_SKILLS;
    if (!strictSkills.has(skillId)) {
      return { passed: true, message: `Skill ${skillId} does not require strict verification` };
    }

    if (testResults.total > 0 && testResults.failed > 0) {
      return { passed: false, reason: `${testResults.failed} tests failing — cannot mark complete` };
    }

    if (lintResults.errors > 0) {
      return { passed: false, reason: `${lintResults.errors} lint errors — fix before completing` };
    }

    return { passed: true, message: `Verification passed for ${skillId}` };
  },

  /**
   * 审计日志记录处理器，生成操作审计条目，包含Agent、操作、目标、结果和时间戳。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.agent_id] - Agent标识符
   * @param {string} [context.action] - 操作类型
   * @param {string} [context.file_path] - 目标文件路径
   * @param {string} [context.skill_id] - 目标技能ID
   * @param {string} [context.target] - 目标标识
   * @param {string} [context.result] - 操作结果
   * @returns {{ passed: boolean, message?: string, audit?: { agent: string, action: string, target: string, result: string, timestamp: string } }} 审计记录结果
   */
  audit_log_record: function auditLogRecord(context) {
    const agentId = context.agent_id || context.agent || 'system';
    const action = context.action || 'unknown';
    const target = context.file_path || context.skill_id || context.target || '';
    const result = context.result || 'executed';
    const timestamp = new Date().toISOString();

    return {
      passed: true,
      message: 'Audit log entry recorded',
      audit: {
        agent: agentId,
        action,
        target,
        result,
        timestamp,
      },
    };
  },

  /**
   * 简洁性检查处理器，基于YAGNI原则检测过度实现：新建文件过多、
   * 新增行数远超删除行数、超出行预算、不必要的抽象模式、无实现的接口。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.diff] - git diff 格式的变更内容
   * @param {string[]} [context.new_files] - 新建文件列表
   * @param {number} [context.line_budget] - 行数预算
   * @returns {{ passed: boolean, reason?: string, message?: string, details?: Object }} 简洁性检查结果
   */
  simplicity_check: function simplicityCheck(context) {
    const diff = context.diff || context.changes || '';
    const newFiles = context.new_files ?? [];

    if (!diff && newFiles.length === 0) {
      return { passed: true, message: 'No diff or new files to check for simplicity' };
    }

    const warnings = [];

    const newFileCount = (diff.match(/^\+.*new file mode/gm) ?? []).length + newFiles.length;
    if (newFileCount > YAGNI_MAX_NEW_FILES) {
      warnings.push(`Creating ${newFileCount} new files — consider if all are necessary (YAGNI)`);
    }

    if (!diff) {
      return warnings.length > 0
        ? { passed: false, reason: `Simplicity violations: ${warnings.join('; ')}`, details: { warnings } }
        : { passed: true, message: 'New files count within limits' };
    }

    _checkDiffSimplicity(diff, context, warnings);

    return warnings.length > 0
      ? { passed: false, reason: `Simplicity violations: ${warnings.join('; ')}`, details: { warnings } }
      : { passed: true, message: 'Changes appear simple and necessary' };
  },

  /**
   * 精准变更检查处理器，确保代码变更聚焦于当前任务，不做无关修改。
   * 检查项包括：修改文件数量、非重构任务中的重构操作、纯样式变更、孤立残留、预存死代码删除。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.diff] - git diff 格式的变更内容
   * @param {string} [context.task_type] - 任务类型
   * @param {string} [context.skill_id] - 技能标识符（备选任务类型判断）
   * @returns {{ passed: boolean, reason?: string, message?: string, details?: Object }} 精准变更检查结果
   */
  surgical_change_check: function surgicalChangeCheck(context) {
    const diff = context.diff || context.changes || '';
    const taskType = context.task_type || context.skill_id || '';

    if (!diff) return { passed: true, message: 'No diff to check for surgical changes' };

    const violations = [];
    const refactorPatterns = [/refactor/i, /restructure/i, /reorganize/i];
    const isRefactorTask = refactorPatterns.some(p => p.test(taskType));

    _checkModifiedFileCount(diff, violations);
    _checkRefactorInNonRefactorTask(diff, isRefactorTask, violations);
    _checkStyleOnlyChanges(diff, violations);
    _checkOrphanResidue(diff, violations);
    _checkPreExistingDeadCodeRemoval(diff, isRefactorTask, violations);

    if (violations.length > 0) {
      return { passed: false, reason: `Surgical change violations: ${violations.join('; ')}`, details: { violations } };
    }

    return { passed: true, message: 'Changes are surgical and focused' };
  },

  /**
   * 核心身份注入处理器（异步），向上下文注入框架核心身份信息，
   * 包括框架名称、版本、六大原则、AI编码约束、Agent角色列表和执行阶段列表。
   * 同时从项目配置中读取项目名称和版本。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.project_root] - 项目根目录路径
   * @returns {Promise<{ passed: boolean, message?: string, injection?: { type: string, identity: Object, project: Object } }>} 注入结果
   */
  inject_core_identity: async function injectCoreIdentity(context) {
    const projectRoot = context.project_root || '';
    const coreIdentity = {
      framework: 'Harness Engineering Multi-Agent Framework',
      version: '2.21.0',
      principles: [
        '分层分责：根据任务性质切换到对应Agent角色',
        '文档驱动：所有决策和交付物以文档形式记录',
        '流程管控：严格遵循六阶段执行流程',
        '容错自愈：失败时自动重试、降级、恢复',
        'TDD强制：先写测试后写代码，RED-GREEN-REFACTOR',
        '证据验证：声称完成必须提供实际证据',
      ],
      aiCodingConstraints: {
        noHardcoding: '所有配置值使用常量或环境变量，禁止硬编码',
        mandatoryErrorHandling: '外部输入必须校验，资源操作必须try-catch-finally，禁止空catch块',
        strictTypes: '使用===，参数类型校验，数值转换后用||而非??处理NaN',
        minimalImplementation: '只实现当前需求，不做提前优化或过度抽象',
        surgicalChanges: '只修改与需求直接相关的代码，surgical change',
        noPlaceholderCompletion: '占位符代码(TODO/FIXME)不得标记为完成',
      },
      agentRoles: [
        'team-lead', 'domain-analyst', 'task-worker',
        'quality-assurance', 'devops-engineer', 'technical-writer',
        'code-reviewer', 'security-reviewer', 'build-error-solver',
        'planner', 'test-writer',
      ],
      phases: [
        'brainstorming', 'requirement-analysis', 'architecture-design',
        'module-development', 'integration-testing', 'deployment',
      ],
    };

    let projectName = '';
    let projectVersion = '';
    if (projectRoot) {
      try {
        const configPath = getHarnessConfigPath(projectRoot);
        const config = await loadJsonAsync(configPath, sanitizeData);
        if (config) {
          projectName = config.project_name || config.name || '';
          projectVersion = config.project_version || config.version || '';
        }
      } catch (e) { debug('HookHandlers', 'inject_core_identity:configRead', e); }
    }

    return {
      passed: true,
      message: 'Core identity injected successfully',
      injection: {
        type: 'core_identity',
        identity: coreIdentity,
        project: { name: projectName, version: projectVersion },
      },
    };
  },

  /**
   * 技能路由注入处理器（异步），扫描项目技能目录，解析技能元数据，
   * 并注入技能路由指令（包括斜杠命令映射和快速参考）。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.project_root] - 项目根目录路径
   * @returns {Promise<{ passed: boolean, message?: string, injection?: { type: string, skills: Object[], routing: Object } }>} 注入结果
   */
  inject_skill_router: async function injectSkillRouter(context) {
    const projectRoot = context.project_root || '';
    const skillsDir = projectRoot ? path.join(projectRoot, HARNESS_DIR, 'skills') : '';
    const discoveredSkills = [];

    if (skillsDir) {
      try {
        const files = (await fs.promises.readdir(skillsDir)).filter(f => f.endsWith('.md'));
        for (const file of files) {
          try {
            const content = await fs.promises.readFile(path.join(skillsDir, file), UTF8_ENCODING);
            const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
            if (fmMatch) {
              const fm = fmMatch[1];
              const idMatch = fm.match(/skill_id:\s*(.+)/);
              const nameMatch = fm.match(/name:\s*(.+)/);
              const phaseMatch = fm.match(/phase:\s*(.+)/);
              const triggerMatch = fm.match(/trigger:\s*(.+)/);
              const autoMatch = fm.match(/auto_trigger:\s*(true|false)/);
              discoveredSkills.push({
                id: idMatch ? idMatch[1].trim() : file.replace('.md', ''),
                name: nameMatch ? nameMatch[1].trim() : file.replace('.md', ''),
                phase: phaseMatch ? phaseMatch[1].trim() : '',
                trigger: triggerMatch ? triggerMatch[1].trim() : '',
                auto_trigger: autoMatch ? autoMatch[1].trim() === 'true' : false,
              });
            }
          } catch (e) { debug('HookHandlers', 'inject_skill_router:skillParse', e); }
        }
      } catch (e) { debug('HookHandlers', 'inject_skill_router:skillsScan', e); }
    }

    const routingInstructions = {
      rule: 'Skills are mandatory workflows, not optional suggestions. Before executing any task, check if a relevant skill should be activated.',
      slashCommands: {
        '/plan': 'brainstorming → requirement-analysis → architecture-design',
        '/code-review': 'code-review',
        '/security-review': 'security-audit',
        '/debug': 'systematic-debugging → bug-fix',
        '/fix': 'bug-fix → verification-before-completion',
        '/deploy': 'verification-before-completion → deployment',
        '/test': 'integration-testing',
        '/refactor': 'refactor-code',
        '/prompt': 'ai-prompting',
        '/audit': 'security-audit',
        '/build': 'tdd-implement → module-development',
        '/code-simplify': 'refactor-code',
        '/goal': 'iterative-deepening → brainstorming → requirement-analysis',
        '/learn': 'iterative-deepening',
        '/optimize': 'optimization-loop',
        '/review': 'code-review → security-audit',
        '/section': 'ui-skills → design-md',
        '/ship': 'verification-before-completion → deployment',
        '/spec': 'requirement-analysis → architecture-design',
        '/startup': 'brainstorming → idea-validation → requirement-analysis → architecture-design → mvp-builder → deployment → ai-native-scaling',
        '/decide': 'decision-loop',
        '/web': 'web-interaction',
      },
      quickReference: {
        '开始新项目': 'brainstorming → requirement-analysis → architecture-design',
        '实现功能': 'tdd-implement → module-development',
        '修复问题': 'systematic-debugging → bug-fix',
        '审查代码': 'code-review',
        '部署上线': 'verification-before-completion → deployment',
        '并行开发': 'dispatching-parallel',
      },
    };

    return {
      passed: true,
      message: `Skill router injected: ${discoveredSkills.length} skills discovered`,
      injection: {
        type: 'skill_router',
        skills: discoveredSkills,
        routing: routingInstructions,
      },
    };
  },

  /**
   * 加载当前阶段上下文处理器（异步），从项目配置和最新会话中读取
   * 当前阶段、已完成技能、活跃Agent、Token使用量等信息并注入上下文。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.project_root] - 项目根目录路径
   * @returns {Promise<{ passed: boolean, message?: string, injection?: { type: string, context: Object } }>} 注入结果
   */
  load_current_phase_context: async function loadCurrentPhaseContext(context) {
    const projectRoot = context.project_root || '';
    const phaseContext = {
      projectName: '', projectVersion: '', currentPhase: 'brainstorming',
      completedSkills: [], activeAgent: '', sessionId: '',
      tokenUsage: { used: 0, budget: DEFAULT_TOKEN_BUDGET, ratio: 0 },
    };

    if (!projectRoot) {
      return { passed: true, message: 'Phase context loaded (no project root, using defaults)', injection: { type: 'phase_context', context: phaseContext } };
    }

    await _loadProjectConfig(projectRoot, phaseContext).catch(function(e) { debug('HookHandlers', 'load_current_phase_context:configLoad', e); });
    await _loadLatestSession(projectRoot, phaseContext).catch(function(e) { debug('HookHandlers', 'load_current_phase_context:sessionLoad', e); });

    phaseContext.tokenUsage.ratio = phaseContext.tokenUsage.budget > 0
      ? Math.round((phaseContext.tokenUsage.used / phaseContext.tokenUsage.budget) * 100) / 100 : 0;

    return {
      passed: true,
      message: `Phase context loaded: phase=${phaseContext.currentPhase}, completed=${phaseContext.completedSkills.length} skills`,
      injection: { type: 'phase_context', context: phaseContext },
    };
  },

  /**
   * 阶段错误回滚处理器，在阶段执行失败时保留错误前状态。
   * 仅在首次失败时触发回滚，后续重试跳过。
   *
   * @param {Object} context - 钩子上下文
   * @param {Object} [context.error] - 错误信息对象
   * @param {string} [context.phase] - 当前阶段标识
   * @param {string[]} [context.modified_files] - 已修改文件列表
   * @returns {{ passed: boolean, message?: string, action?: string, details?: Object }} 回滚结果
   */
  phase_error_rollback: function phaseErrorRollback(context) {
    const error = context.error ?? {};
    const phase = context.phase || '';
    if (!phase) return { passed: true, message: 'No phase to rollback' };

    const attempt = (error.attempt ?? 0) + 1;
    if (attempt > 1) {
      return { passed: true, message: `Phase rollback skipped (attempt ${attempt} > 1, retrying)` };
    }

    return {
      passed: true,
      message: `Phase rollback initiated for ${phase}: preserving pre-error state`,
      action: 'rollback',
      details: { phase, attempt, preservedChanges: (context.modified_files ?? []).length },
    };
  },

  /**
   * 阶段错误重试处理器，实现指数退避重试策略。
   * 首次失败要求提供根因假设，后续重试按2的幂次方增加等待时间。
   * 超过最大重试次数后升级到Team Lead。
   *
   * @param {Object} context - 钩子上下文
   * @param {Object} [context.error] - 错误信息对象，含 attempt 和 rootCauseHypothesis
   * @param {string} [context.phase] - 当前阶段标识
   * @returns {{ passed: boolean, reason?: string, message?: string, retry?: boolean, requireRootCause?: boolean, escalate?: boolean, details?: Object }} 重试决策结果
   */
  phase_error_retry: function phaseErrorRetry(context) {
    const error = context.error ?? {};
    const phase = context.phase || '';
    const maxRetries = ERROR_MAX_RETRIES;
    const attempt = (error.attempt ?? 0) + 1;

    if (attempt > maxRetries) {
      return {
        passed: false,
        reason: `Phase ${phase} failed after ${maxRetries} retries, escalating to Team Lead`,
        escalate: true,
        details: { phase, attempt, maxRetries, lastError: error && error.message ? error.message : String(error) },
      };
    }

    if (attempt === 1 && !error.rootCauseHypothesis) {
      return {
        passed: true,
        message: `Root cause analysis required before retry: phase=${phase}, error=${error && error.message ? error.message : String(error)}. Provide rootCauseHypothesis before next attempt.`,
        retry: true,
        requireRootCause: true,
        details: { phase, attempt, maxRetries, instruction: 'Analyze the error and provide a root cause hypothesis before retrying' },
      };
    }

    const backoffMs = Math.min(MAX_BACKOFF_MS * Math.pow(2, attempt - 1), DEFAULT_FALLBACK_INTERVAL_MS);
    return {
      passed: true,
      message: `Retrying phase ${phase} (attempt ${attempt}/${maxRetries}, backoff: ${backoffMs}ms)${error.rootCauseHypothesis ? ', root cause: ' + error.rootCauseHypothesis : ''}`,
      retry: true,
      details: { phase, attempt, maxRetries, backoffMs, rootCauseHypothesis: error.rootCauseHypothesis ?? null },
    };
  },

  /**
   * 阶段错误升级处理器，将反复失败的问题升级到Team Lead处理。
   * 提供阶段信息、尝试次数、最后错误和建议操作。
   *
   * @param {Object} context - 钩子上下文
   * @param {Object} [context.error] - 错误信息对象
   * @param {string} [context.phase] - 当前阶段标识
   * @param {string} [context.session_id] - 会话标识符
   * @returns {{ passed: boolean, message?: string, escalate_to?: string, reason?: string, details?: Object }} 升级结果
   */
  phase_error_escalate: function phaseErrorEscalate(context) {
    const error = context.error ?? {};
    const phase = context.phase || '';
    const sessionId = context.session_id || '';

    return {
      passed: true,
      message: `Escalating phase error to Team Lead: phase=${phase}, error=${error && error.message ? error.message : String(error)}`,
      escalate_to: 'team-lead',
      reason: 'phase_repeated_failure',
      details: {
        phase,
        sessionId,
        totalAttempts: error.attempt ?? 3,
        lastError: error && error.message ? error.message : String(error),
        recommendations: ['Review phase preconditions', 'Check skill dependencies', 'Consider manual intervention'],
      },
    };
  },

  /**
   * YAGNI预检处理器，在实现前检查变更是否过度：新建文件过多、
   * 新抽象过多、新增行数过多、无实现的接口。通过时给出警告建议触发necessity-review。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.diff] - git diff 格式的变更内容
   * @param {string[]} [context.new_files] - 新建文件列表
   * @returns {{ passed: boolean, message?: string, details?: Object }} YAGNI预检结果
   */
  yagni_pre_check: function yagniPreCheck(context) {
    const diff = context.diff || context.changes || '';
    const newFiles = context.new_files ?? [];

    if (!diff && newFiles.length === 0) {
      return { passed: true, message: 'No new files or changes to check for YAGNI' };
    }

    const warnings = [];

    const newFileCount = (diff.match(/^\+.*new file mode/gm) ?? []).length + newFiles.length;
    if (newFileCount > YAGNI_MAX_NEW_FILES) {
      warnings.push(`Creating ${newFileCount} new files — necessity-review recommended`);
    }

    const abstractPatterns = [/class\s+\w+Factory\b/, /class\s+\w+Builder\b/, /class\s+\w+Strategy\b/, /class\s+\w+Adapter\b/, /class\s+\w+Manager\b/, /interface\s+I\w+/];
    let abstractCount = 0;
    for (const pattern of abstractPatterns) {
      const matches = diff.match(pattern);
      if (matches) abstractCount += matches.length;
    }
    if (abstractCount > YAGNI_MAX_ABSTRACTIONS) {
      warnings.push(`${abstractCount} new abstractions detected — verify each has at least 2 callers (YAGNI)`);
    }

    const addedLines = (diff.match(/^\+(?!\+|\s*$)/gm) ?? []).length;
    if (addedLines > YAGNI_MAX_ADDED_LINES) {
      warnings.push(`Adding ${addedLines} lines — verify no over-implementation (YAGNI)`);
    }

    if (/interface\s+I\w+/.test(diff) && !/implements\s+I\w+/.test(diff)) {
      warnings.push('New interface without implementation — may be unnecessary abstraction');
    }

    if (warnings.length > 0) {
      return {
        passed: true,
        message: `YAGNI pre-check warnings: ${warnings.join('; ')}`,
        details: { warnings, recommendation: 'Consider triggering necessity-review skill' },
      };
    }

    return { passed: true, message: 'YAGNI pre-check passed: changes appear necessary' };
  },

  /**
   * 输出格式检查处理器，检测输出中的emoji字符和过量的标题层级，
   * 确保输出格式专业简洁。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.output] - 输出文本
   * @param {string} [context.content] - 输出文本（备选字段）
   * @returns {{ passed: boolean, reason?: string, message?: string, details?: Object }} 格式检查结果
   */
  output_format_check: function outputFormatCheck(context) {
    const output = context.output || context.content || '';
    if (!output || typeof output !== 'string') {
      return { passed: true, message: 'No output to check format' };
    }

    const violations = [];

    const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
    if (emojiPattern.test(output)) {
      violations.push('Output contains emoji characters — remove for professional output');
    }

    const lines = (output ?? '').split('\n');
    const headerCount = lines.filter(l => /^#{1,3}\s/.test(l)).length;
    if (headerCount > OUTPUT_MAX_HEADERS && output.length < OUTPUT_MIN_LENGTH_FOR_HEADERS) {
      violations.push('Excessive headers for short content — use simpler structure');
    }

    if (violations.length > 0) {
      return { passed: false, reason: `Output format violations: ${violations.join('; ')}`, details: { violations } };
    }

    return { passed: true, message: 'Output format check passed' };
  },

  /**
   * 设计反模式检查处理器，检测前端代码中的设计违规：
   * 纯黑色、霓虹色、AI风格渐变、硬编码阴影、过饱和颜色、系统默认字体、硬编码间距等。
   * 仅对前端文件（CSS/HTML/JSX/Vue/Svelte等）或含style/class属性的代码生效。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.content] - 代码内容
   * @param {string} [context.diff] - 变更内容（备选字段）
   * @param {string} [context.filePath] - 文件路径
   * @returns {{ passed: boolean, reason?: string, message?: string, details?: Object }} 设计检查结果
   */
  design_anti_pattern_check: function designAntiPatternCheck(context) {
    const content = context.content || context.diff || context.changes || '';
    const filePath = context.filePath || context.file_path || '';

    const cssExtensions = ['.css', '.scss', '.less', '.sass'];
    const htmlExtensions = ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte'];
    const isStyleFile = cssExtensions.some(ext => filePath.endsWith(ext));
    const isFrontendFile = htmlExtensions.some(ext => filePath.endsWith(ext)) || isStyleFile;

    if (!isFrontendFile && !content.includes('style') && !content.includes('class=')) {
      return { passed: true, message: 'No frontend code to check for design anti-patterns' };
    }

    const violations = [];
    const checks = [
      [DESIGN_PATTERNS.PURE_BLACK, 'Pure black (#000000) detected — use design token gray instead (e.g., var(--gray-900))'],
      [DESIGN_PATTERNS.NEON_GLOW, 'Neon glow effect detected — use subtle design token shadows instead'],
      [DESIGN_PATTERNS.NEON_COLOR, 'Neon color detected — use subtle design token colors instead'],
      [DESIGN_PATTERNS.AI_GRADIENT, 'AI-style purple-blue gradient detected — use brand-appropriate color combinations'],
      [DESIGN_PATTERNS.HARDCODED_SHADOW, 'Hardcoded box-shadow detected — use design token shadow variables (var(--shadow-sm/md/lg/xl))'],
      [DESIGN_PATTERNS.DEFAULT_LARGE_SHADOW, 'Default large shadow pattern detected — use layered shadow system instead'],
      [DESIGN_PATTERNS.OVERSATURATED, 'Oversaturated color detected — reduce saturation to 60-80% range'],
      [DESIGN_PATTERNS.SYSTEM_FONT, 'System default font detected — use professional font stack (e.g., Inter, SF Pro Display)'],
    ];
    for (const [pattern, message] of checks) {
      if (pattern.test(content)) violations.push(message);
    }
    const hardcodedMatches = content.match(DESIGN_PATTERNS.HARDCODED_SPACING);
    if (hardcodedMatches && hardcodedMatches.length > DESIGN_MAX_HARDCODED_SPACING) {
      violations.push('Excessive hardcoded spacing values detected — use design token spacing variables (var(--space-xs/sm/md/lg/xl))');
    }

    if (violations.length > 0) {
      return { passed: false, reason: `Design anti-pattern violations: ${violations.join('; ')}`, details: { violations, file: filePath } };
    }

    return { passed: true, message: 'Design anti-pattern check passed' };
  },

  /**
   * 无障碍合规检查处理器，检测前端代码中的WCAG违规：
   * 图片缺少alt属性、图标按钮缺少aria-label、表单输入缺少标签关联、
   * 低对比度文本、缺少焦点样式、动画缺少prefers-reduced-motion回退。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.content] - 代码内容
   * @param {string} [context.diff] - 变更内容（备选字段）
   * @param {string} [context.filePath] - 文件路径
   * @returns {{ passed: boolean, reason?: string, message?: string, details?: Object }} 无障碍检查结果
   */
  accessibility_compliance: function accessibilityCompliance(context) {
    const content = context.content || context.diff || context.changes || '';
    const filePath = context.filePath || context.file_path || '';

    const htmlExtensions = ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte'];
    const isFrontendFile = htmlExtensions.some(ext => filePath.endsWith(ext));

    if (!isFrontendFile && !content.includes('<') && !content.includes('role=')) {
      return { passed: true, message: 'No frontend code to check for accessibility compliance' };
    }

    const A11Y_CHECKS = [
      {
        name: 'img-alt',
        test: function() { return /<img(?![^>]*alt=)/gi.test(content); },
        message: 'Image element missing alt attribute — add descriptive alt text',
      },
      {
        name: 'button-aria',
        test: function() { return /<button(?![^>]*(?:aria-label|aria-labelledby|title=))[^>]*>\s*<(?:svg|i|span\s+class="icon)/gi.test(content); },
        message: 'Icon button missing aria-label — add aria-label for screen readers',
      },
      {
        name: 'input-label',
        test: function() { return /<input(?![^>]*(?:aria-label|aria-labelledby|id=))[^>]*type="(?:text|email|password|search|url|tel|number)"/gi.test(content); },
        message: 'Form input missing label association — add aria-label or link to label element',
      },
      {
        name: 'low-contrast',
        test: function() {
          return /color\s*:\s*(?:#ccc|#ddd|#eee|#d1d5db|#e5e7eb|#f3f4f6)\b/gi.test(content) &&
                 /background(?:-color)?\s*:\s*(?:#fff|#ffffff|white)\b/gi.test(content);
        },
        message: 'Potential low contrast text on white background — verify WCAG AA compliance (4.5:1 ratio)',
      },
      {
        name: 'focus-styles',
        test: function() {
          const focusableWithoutFocus = /<(?:button|a|input|select|textarea)(?![^>]*onfocus)(?![^>]*focus-visible)/gi;
          const focusMatches = content.match(focusableWithoutFocus);
          return focusMatches && focusMatches.length > A11Y_MAX_FOCUS_VIOLATIONS && !content.includes(':focus-visible') && !content.includes(':focus');
        },
        message: 'Interactive elements without focus styles detected — add :focus-visible styles',
      },
      {
        name: 'reduced-motion',
        test: function() {
          return /(?:animation|transition)\s*:/i.test(content) && !/@media\s*\(\s*prefers-reduced-motion/.test(content);
        },
        message: 'Animations without prefers-reduced-motion fallback — add reduced motion media query',
      },
    ];

    const violations = A11Y_CHECKS.flatMap(function(check) { return check.test() ? [check.message] : []; });

    if (violations.length > 0) {
      return { passed: false, reason: 'Accessibility compliance violations: ' + violations.join('; '), details: { violations, file: filePath } };
    }

    return { passed: true, message: 'Accessibility compliance check passed' };
  },

  /**
   * AI服务安全检查处理器，检测代码中的AI服务安全违规：
   * 硬编码API密钥、AI模型调用缺少安全控制（temperature/timeout/retry）、
   * 无限制的max_tokens输出。
   *
   * @param {Object} context - 钩子上下文
   * @param {string} [context.content] - 代码内容
   * @param {string} [context.file_content] - 代码内容（备选字段）
   * @param {string} [context.file_path] - 文件路径
   * @returns {{ passed: boolean, reason?: string, message?: string, details?: Object }} 安全检查结果
   */
  ai_service_safety_check: function aiServiceSafetyCheck(context) {
    const content = context.content || context.file_content || '';
    const filePath = context.file_path || '';

    if (typeof content !== 'string' || !content) {
      return { passed: true, message: 'No content to check for AI service safety' };
    }

    const violations = [];

    const hardcodedKeyPatterns = [
      /(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"]{10,}/gi,
      /sk-[a-zA-Z0-9]{20,}/g,
      /AIZA[a-zA-Z0-9_-]{30,}/g,
    ];
    for (const pattern of hardcodedKeyPatterns) {
      if (pattern.test(content)) {
        violations.push('Hardcoded API key or secret detected — use environment variables or key vault');
        break;
      }
    }

    const modelCallPattern = /(?:openai|anthropic|azure)\.(?:chat|completions|messages)\.(?:create|invoke)\([^)]*\)/g;
    const calls = content.match(modelCallPattern);
    if (calls) {
      for (const call of calls) {
        if (!/temperature|timeout|retry/i.test(call)) {
          violations.push('AI model call without safety controls (temperature/timeout/retry) — add guardrails');
          break;
        }
      }
    }

    const unboundedOutputPatterns = [
      /max_tokens\s*[:=]\s*(?:Infinity|9999|[1-9]\d{4,})/g,
    ];
    for (const pattern of unboundedOutputPatterns) {
      if (pattern.test(content)) {
        violations.push('Unbounded max_tokens detected — set reasonable output limits');
        break;
      }
    }

    if (violations.length > 0) {
      return { passed: false, reason: 'AI service safety violations: ' + violations.join('; '), details: { violations, file: filePath } };
    }

    return { passed: true, message: 'AI service safety check passed' };
  },
};

/**
 * 从项目配置文件加载项目名称、版本和Token预算到阶段上下文对象中。
 *
 * @param {string} projectRoot - 项目根目录路径
 * @param {Object} phaseContext - 阶段上下文对象，将被就地修改
 * @param {string} phaseContext.projectName - 项目名称
 * @param {string} phaseContext.projectVersion - 项目版本
 * @param {Object} phaseContext.tokenUsage - Token使用信息
 * @returns {Promise<void>}
 */
async function _loadProjectConfig(projectRoot, phaseContext) {
  try {
    const configPath = getHarnessConfigPath(projectRoot);
    const config = await loadJsonAsync(configPath, sanitizeData);
    if (config && typeof config === 'object' && config !== null) {
      phaseContext.projectName = config.project_name || config.name || '';
      phaseContext.projectVersion = config.project_version || config.version || '';
      phaseContext.tokenUsage.budget = config.token_budget ?? DEFAULT_TOKEN_BUDGET;
    }
  } catch (e) { debug('HookHandlers', '_loadConfig:configLoad', e); }
}

/**
 * 从项目会话目录加载最新的会话数据到阶段上下文对象中。
 * 按修改时间降序排列会话文件，取最新的一个进行解析。
 *
 * @param {string} projectRoot - 项目根目录路径
 * @param {Object} phaseContext - 阶段上下文对象，将被就地修改
 * @returns {Promise<void>}
 */
async function _loadLatestSession(projectRoot, phaseContext) {
  try {
    const sessionsDir = path.join(projectRoot, HARNESS_DIR, 'sessions');
    let files;
    try {
      files = await fs.promises.readdir(sessionsDir);
    } catch (e) { debug('HookHandlers', '_loadLatestSession:readdir', e); return; }

    const jsonFiles = files.filter(f => f.endsWith('.json'));
    if (jsonFiles.length === 0) return;

    const withMtime = [];
    for (const f of jsonFiles) {
      try {
        const stat = await fs.promises.stat(path.join(sessionsDir, f));
        withMtime.push({ name: f, mtime: stat.mtime.getTime() });
      } catch (e) { debug('HookHandlers', '_loadLatestSession:stat', e); }
    }
    withMtime.sort((a, b) => b.mtime - a.mtime);
    if (withMtime.length === 0) return;

    const latestFile = path.join(sessionsDir, withMtime[0].name);
    try {
      const content = await fs.promises.readFile(latestFile, UTF8_ENCODING);
      const session = safeJsonParse(content, null, 'HookHandlers');
      if (session) _applySessionData(session, phaseContext);
    } catch (e) { debug('HookHandlers', '_loadLatestSession:parse', e); }
  } catch (e) { debug('HookHandlers', '_loadLatestSession', e); }
}

/**
 * 将解析后的会话数据应用到阶段上下文对象中，
 * 包括当前阶段、已完成技能、会话ID、Token使用量和活跃Agent。
 *
 * @param {Object} session - 解析后的会话数据对象
 * @param {string} [session.currentPhase] - 当前执行阶段
 * @param {string[]} [session.completedSkills] - 已完成的技能列表
 * @param {string} [session.id] - 会话标识符
 * @param {number} [session.tokensUsed] - 已使用的Token数量
 * @param {Object[]} [session.agentHistory] - Agent历史记录数组
 * @param {Object} phaseContext - 阶段上下文对象，将被就地修改
 */
function _applySessionData(session, phaseContext) {
  phaseContext.currentPhase = session.currentPhase || 'brainstorming';
  phaseContext.completedSkills = session.completedSkills ?? [];
  phaseContext.sessionId = session.id || '';
  phaseContext.tokenUsage.used = session.tokensUsed ?? 0;
  if (session.agentHistory && session.agentHistory.length > 0) {
    const lastAgent = session.agentHistory[session.agentHistory.length - 1];
    phaseContext.activeAgent = (lastAgent && (lastAgent.agentId || lastAgent.agent)) || '';
  }
}

module.exports = {
  BUILTIN_HANDLERS,
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_MAX_CALLS,
  SLOW_HOOK_THRESHOLD_MS: 500,
  MONITOR_HISTORY_MAX: 200,
  MONITOR_CLEANUP_INTERVAL: 15 * 60 * 1000,
  /**
   * 关闭速率限制管理器单例并释放资源。
   * @returns {void}
   */
  shutdown: function shutdown() {
    if (_rateLimitManager) {
      _rateLimitManager.shutdown();
      _rateLimitManager = null;
    }
  },
};
