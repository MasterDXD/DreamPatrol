'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { safeJsonParse } = require('../../utils/safe-parse');
const safeAssign = require('../../utils/safe-assign');
const { mergeConfig } = safeAssign;
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { debug } = require('../../utils/debug-logger');
const { timestampId } = require('../../utils/unique-id');

const SEVERITY_LEVELS = { CRITICAL: 'critical', WARNING: 'warning', INFO: 'info' };
const CATEGORY_TYPES = { ARCHITECTURE: 'architecture', SECURITY: 'security', STYLE: 'style', PERFORMANCE: 'performance' };

const BUILT_IN_RULES = [
  {
    id: 'no-cross-layer-calls',
    name: 'No Cross-Layer Calls',
    description: 'Strictly prohibit cross-layer calls',
    severity: SEVERITY_LEVELS.CRITICAL,
    category: CATEGORY_TYPES.ARCHITECTURE,
    check: function(ctx) {
      const code = ctx.code || '';
      const hasInteraction = /require\(.*interaction/.test(code);
      const hasDomain = /require\(.*domain/.test(code);
      const hasInfra = /require\(.*infrastructure/.test(code);
      const _hasBusiness = /require\(.*business/.test(code);
      if (hasInteraction && hasDomain) return { violated: true, evidence: 'Interaction layer directly imports Domain layer' };
      if (hasDomain && hasInfra) return { violated: true, evidence: 'Domain layer directly imports Infrastructure layer' };
      if (hasInteraction && hasInfra) return { violated: true, evidence: 'Interaction layer directly imports Infrastructure layer' };
      return { violated: false, evidence: '' };
    },
  },
  {
    id: 'no-direct-db-access',
    name: 'No Direct DB Access',
    description: 'Prohibit direct DB access from business layer',
    severity: SEVERITY_LEVELS.CRITICAL,
    category: CATEGORY_TYPES.ARCHITECTURE,
    check: function(ctx) {
      const code = ctx.code || '';
      const isBusinessLayer = /business/.test(ctx.filePath || '');
      const hasDbAccess = /require\(.*better-sqlite3|\.exec\(|\.query\(|\.run\(/.test(code);
      if (isBusinessLayer && hasDbAccess) return { violated: true, evidence: 'Business layer contains direct DB access' };
      return { violated: false, evidence: '' };
    },
  },
  {
    id: 'no-hardcoded-secrets',
    name: 'No Hardcoded Secrets',
    description: 'Prohibit hardcoded secrets in source code',
    severity: SEVERITY_LEVELS.CRITICAL,
    category: CATEGORY_TYPES.SECURITY,
    check: function(ctx) {
      const code = ctx.code || '';
      const patterns = [
        /password\s*[:=]\s*['"][^'"]+['"]/i,
        /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
        /secret\s*[:=]\s*['"][^'"]+['"]/i,
        /token\s*[:=]\s*['"][^'"]+['"]/i,
      ];
      for (const p of patterns) {
        const match = code.match(p);
        if (match) return { violated: true, evidence: 'Hardcoded secret found: ' + match[0].slice(0, 30) };
      }
      return { violated: false, evidence: '' };
    },
  },
  {
    id: 'no-untyped-parameters',
    name: 'No Untyped Parameters',
    description: 'Require typed parameters in public APIs',
    severity: SEVERITY_LEVELS.WARNING,
    category: CATEGORY_TYPES.STYLE,
    check: function(ctx) {
      const code = ctx.code || '';
      const isPublic = /@public|module\.exports/.test(code);
      if (!isPublic) return { violated: false, evidence: '' };
      const untypedParams = code.match(/function\s+\w+\s*\([^)]*\)/g) ?? [];
      for (const fn of untypedParams) {
        if (fn.includes(':')) continue;
        const params = fn.match(/\(([^)]*)\)/);
        if (params && params[1] && params[1].trim() && !params[1].includes('//')) {
          return { violated: true, evidence: 'Public function has untyped parameters: ' + fn.slice(0, 50) };
        }
      }
      return { violated: false, evidence: '' };
    },
  },
  {
    id: 'no-sync-io',
    name: 'No Sync I/O',
    description: 'Prohibit synchronous I/O operations',
    severity: SEVERITY_LEVELS.WARNING,
    category: CATEGORY_TYPES.PERFORMANCE,
    check: function(ctx) {
      const code = ctx.code || '';
      const syncPatterns = [
        /readFileSync/,
        /writeFileSync/,
        /existsSync/,
        /readdirSync/,
        /statSync/,
        /accessSync/,
        /mkdirSync/,
        /unlinkSync/,
      ];
      for (const p of syncPatterns) {
        if (p.test(code)) return { violated: true, evidence: 'Synchronous I/O detected: ' + p.source };
      }
      return { violated: false, evidence: '' };
    },
  },
  {
    id: 'no-global-mutation',
    name: 'No Global Mutation',
    description: 'Prohibit global state mutation',
    severity: SEVERITY_LEVELS.CRITICAL,
    category: CATEGORY_TYPES.ARCHITECTURE,
    check: function(ctx) {
      const code = ctx.code || '';
      const globalMutations = [
        /global\.\w+\s*=/,
        /process\.\w+\s*=(?!\s*process\.env)/,
        /Object\.prototype\.\w+\s*=/,
      ];
      for (const p of globalMutations) {
        if (p.test(code)) return { violated: true, evidence: 'Global state mutation detected' };
      }
      return { violated: false, evidence: '' };
    },
  },
  {
    id: 'no-circular-dependencies',
    name: 'No Circular Dependencies',
    description: 'Prohibit circular module dependencies',
    severity: SEVERITY_LEVELS.CRITICAL,
    category: CATEGORY_TYPES.ARCHITECTURE,
    check: function(ctx) {
      const deps = ctx.dependencies ?? [];
      const visited = new Set();
      const path = new Set();
      function hasCycle(node, graph) {
        visited.add(node);
        path.add(node);
        const neighbors = graph[node] ?? [];
        for (const n of neighbors) {
          if (!visited.has(n)) {
            if (hasCycle(n, graph)) return true;
          } else if (path.has(n)) {
            return true;
          }
        }
        path.delete(node);
        return false;
      }
      const depGraph = {};
      for (const d of deps) {
        depGraph[d.from] = depGraph[d.from] ?? [];
        depGraph[d.from].push(d.to);
      }
      for (const node of Object.keys(depGraph)) {
        if (!visited.has(node)) {
          if (hasCycle(node, depGraph)) return { violated: true, evidence: 'Circular dependency detected' };
        }
      }
      return { violated: false, evidence: '' };
    },
  },
  {
    id: 'require-error-handling',
    name: 'Require Error Handling',
    description: 'Require error handling in async functions',
    severity: SEVERITY_LEVELS.WARNING,
    category: CATEGORY_TYPES.STYLE,
    check: function(ctx) {
      const code = ctx.code || '';
      const asyncFns = code.match(/async\s+function|async\s+\w+\s*\(/g) ?? [];
      if (asyncFns.length === 0) return { violated: false, evidence: '' };
      const tryCatchCount = (code.match(/try\s*\{/g) ?? []).length;
      const catchCount = (code.match(/catch\s*\(/g) ?? []).length;
      if (asyncFns.length > 0 && tryCatchCount === 0 && catchCount === 0) {
        return { violated: true, evidence: 'Async functions without error handling detected' };
      }
      return { violated: false, evidence: '' };
    },
  },
  {
    id: 'require-input-validation',
    name: 'Require Input Validation',
    description: 'Require input validation on public APIs',
    severity: SEVERITY_LEVELS.WARNING,
    category: CATEGORY_TYPES.SECURITY,
    check: function(ctx) {
      const code = ctx.code || '';
      const isPublic = /@public|module\.exports/.test(code);
      if (!isPublic) return { violated: false, evidence: '' };
      const hasParams = /\(.*\w+.*\)/.test(code);
      const hasValidation = /typeof\s+\w+\s*===|instanceof|validate|guard|assert/.test(code);
      if (hasParams && !hasValidation) {
        return { violated: true, evidence: 'Public API without input validation' };
      }
      return { violated: false, evidence: '' };
    },
  },
  {
    id: 'require-shutdown-cleanup',
    name: 'Require Shutdown Cleanup',
    description: 'Require shutdown cleanup in resource-holding classes',
    severity: SEVERITY_LEVELS.WARNING,
    category: CATEGORY_TYPES.ARCHITECTURE,
    check: function(ctx) {
      const code = ctx.code || '';
      const hasResources = /stream|socket|connection|timer|interval|listener/.test(code);
      const hasShutdown = /shutdown|close|destroy|dispose|cleanup/.test(code);
      if (hasResources && !hasShutdown) {
        return { violated: true, evidence: 'Resource-holding class without shutdown cleanup' };
      }
      return { violated: false, evidence: '' };
    },
  },
];

const DEFAULT_CONFIG = {
  maxRules: 200,
  maxViolations: 1000,
  enabledByDefault: true,
};

/**
 * @module runtime/sdd/iron-rule-engine
 * @classdesc 铁律引擎（IronRuleEngine）—— SDD规范驱动子系统的核心执行组件。
 * 提供10+内置铁律（跨层调用/直接DB/硬编码密钥等），支持自定义规则、违规追踪、规则启停。
 * 通过addPatternRule()生成模式规则，getRuleEffectiveness()/recordRuleOutcome()追踪规则效果。
 * 支持规则导入导出、指纹校验和远程同步。
 * @extends EventEmitter
 */
class IronRuleEngine extends EventEmitter {
  /**
   * @param {Object} [config={}] - 配置选项
   * @param {number} [config.maxRules=200] - 最大规则数量
   * @param {number} [config.maxViolations=1000] - 最大违规记录数
   * @param {boolean} [config.enabledByDefault=true] - 新增规则是否默认启用
   */
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._rules = new BoundedMap(this._config.maxRules);
    this._violations = new BoundedArray(this._config.maxViolations);
    this._stats = { totalChecks: 0, totalViolations: 0, byRule: {}, byCategory: {}, bySeverity: {} };
    this._rulesVersion = 0;
    for (const rule of BUILT_IN_RULES) {
      this._addRuleInternal(rule);
    }
  }

  _addRuleInternal(rule) {
    this._rules.set(rule.id, {
      ...rule,
      enabled: this._config.enabledByDefault,
      addedAt: new Date().toISOString(),
    });
  }

  _incrementVersion() {
    this._rulesVersion++;
  }

  /**
   * 从JSON文件加载规则并添加到引擎。文件应包含规则数组，每条规则需有 id 字段。
   * @param {string} rulesPath - 规则文件路径
   * @returns {{ loaded: number, reason?: string }} 加载结果，包含成功加载的规则数量或失败原因
   */
  loadRules(rulesPath) {
    this.guardShutdown();
    const result = safeExecute(() => {
      const fs = require('fs');
      if (!fs.existsSync(rulesPath)) {
        return { loaded: 0, reason: 'File not found' };
      }
      const content = fs.readFileSync(rulesPath, 'utf-8');
      const rules = safeJsonParse(content, null, 'IronRuleEngine');
      if (rules === null) {
        return { loaded: 0, reason: 'Invalid JSON' };
      }
      if (!Array.isArray(rules)) {
        return { loaded: 0, reason: 'Expected array of rules' };
      }
      let loaded = 0;
      for (const rule of rules) {
        if (rule && rule.id) {
          const checkFn = (typeof rule.check === 'function') ? rule.check : function() { return { violated: false, evidence: '' }; };
          this._addRuleInternal({
            id: rule.id,
            name: rule.name || rule.id,
            description: rule.description || '',
            severity: rule.severity ?? SEVERITY_LEVELS.WARNING,
            category: rule.category ?? CATEGORY_TYPES.STYLE,
            check: checkFn,
          });
          loaded++;
        }
      }
      if (loaded > 0) this._incrementVersion();
      this.emit('rules-loaded', { count: loaded, path: rulesPath });
      return { loaded };
    }, 'IronRuleEngine', 'loadRules', { loaded: 0, reason: 'Internal error' });
    if (result && result.loaded === 0 && result.reason === 'Internal error') {
      try { this.emit('safe-execute-error', { method: 'loadRules', error: 'Internal error' }); } catch (_e) { debug('IronRuleEngine', 'loadRules-emit', _e && _e.message ? _e.message : String(_e)); }
    }
    return result;
  }

  /**
   * 添加自定义规则到引擎。规则必须包含 id 和 check 函数，且 id 不能与已有规则重复。
   * @param {Object} rule - 规则对象
   * @param {string} rule.id - 规则唯一标识
   * @param {Function} rule.check - 规则检查函数，接收上下文对象，返回 { violated: boolean, evidence: string }
   * @param {string} [rule.name] - 规则名称，默认为 rule.id
   * @param {string} [rule.description] - 规则描述
   * @param {string} [rule.severity] - 严重级别
   * @param {string} [rule.category] - 规则分类
   * @param {string} [rule.source] - 规则来源，默认为 'manual'
   * @param {string} [rule.solution] - 违规修复建议
   * @param {Object} [rule.effectiveness] - 规则效果统计
   * @returns {{ added: boolean, ruleId?: string, reason?: string }} 添加结果，包含是否成功、规则ID或失败原因
   */
  addRule(rule) {
    this.guardShutdown();
    if (!rule || !rule.id || typeof rule.check !== 'function') {
      return { added: false, reason: 'Rule must have id and check function' };
    }
    if (this._rules.has(rule.id)) {
      return { added: false, reason: 'Rule already exists: ' + rule.id };
    }
    this._addRuleInternal({
      id: rule.id,
      name: rule.name || rule.id,
      description: rule.description || '',
      severity: rule.severity ?? SEVERITY_LEVELS.WARNING,
      category: rule.category ?? CATEGORY_TYPES.STYLE,
      check: rule.check,
      source: rule.source || 'manual',
      solution: rule.solution ?? '',
      effectiveness: rule.effectiveness ?? { triggered: 0, prevented: 0 },
    });
    this._incrementVersion();
    this.emit('rule-added', { ruleId: rule.id });
    return { added: true, ruleId: rule.id };
  }

  /**
   * 通过模式字符串或正则表达式生成模式规则并添加到引擎。
   * 自动生成检查函数，对代码进行模式匹配检测。
   * @param {string|RegExp} pattern - 匹配模式，支持字符串（自动转义为正则）或 RegExp 对象
   * @param {string} description - 规则描述
   * @param {string} solution - 违规修复建议
   * @param {Object} [options] - 可选配置
   * @param {string} [options.id] - 自定义规则ID，默认自动生成 'pattern-' 前缀ID
   * @param {string} [options.name] - 自定义规则名称，默认截取 description 前50字符
   * @param {string} [options.severity] - 严重级别，默认为 'warning'
   * @param {string} [options.category] - 规则分类，默认为 'style'
   * @returns {{ added: boolean, ruleId?: string, reason?: string }} 添加结果
   */
  addPatternRule(pattern, description, solution, options) {
    this.guardShutdown();
    if (!pattern) {
      return { added: false, reason: 'Pattern is required' };
    }
    const opts = options ?? {};
    const checkFn = this._generateCheckFromPattern(pattern);
    const rule = {
      id: opts.id ?? ('pattern-' + timestampId()),
      name: opts.name ?? (description || '').slice(0, 50),
      description: description || 'Auto-generated pattern rule',
      solution: solution || '',
      severity: opts.severity ?? SEVERITY_LEVELS.WARNING,
      category: opts.category ?? CATEGORY_TYPES.STYLE,
      check: checkFn,
      source: 'auto-generated',
      createdAt: Date.now(),
      effectiveness: { triggered: 0, prevented: 0 },
    };
    return this.addRule(rule);
  }

  _generateCheckFromPattern(pattern) {
    if (typeof pattern === 'string') {
      if (pattern.length > 200) {
        debug('IronRuleEngine', 'pattern rejected: too long', pattern.length);
        return function() { return { violated: false, evidence: '' }; };
      }
      const REDOS_DANGEROUS_RE = /(?:\([^)]*[+*][^)]*\))[+*{]|(\.\+[+*])|(\.\*[+*])/;
      if (REDOS_DANGEROUS_RE.test(pattern)) {
        debug('IronRuleEngine', 'pattern rejected: dangerous quantifier nesting', pattern);
        return function() { return { violated: false, evidence: '' }; };
      }
    }
    let regex;
    try {
      regex = pattern instanceof RegExp ? pattern : (function() { try { return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); } catch (_e) { debug('IronRuleEngine', 'compileRegex', _e && _e.message ? _e.message : String(_e)); return new RegExp('^$', 'gi'); } })();
    } catch (e) {
      debug('IronRuleEngine', 'pattern rejected: invalid regex', e && e.message ? e.message : String(e));
      return function() { return { violated: false, evidence: '' }; };
    }
    return function(codeContext) {
      const code = codeContext?.code ?? '';
      try {
        const match = regex.test(code);
        return { violated: match, evidence: match ? 'Pattern matched: ' + regex.source : '' };
      } catch (_e) {
        debug('IronRuleEngine', 'patternTestError', _e && _e.message ? _e.message : String(_e));
        return { violated: false, evidence: '' };
      }
    };
  }

  /**
   * 获取指定规则的效果统计，包括触发次数、阻止次数和阻止率。
   * @param {string} ruleId - 规则ID
   * @returns {{ ruleId: string, triggered: number, prevented: number, rate: number } | null} 规则效果统计，规则不存在时返回 null
   */
  getRuleEffectiveness(ruleId) {
    this.guardShutdown();
    const rule = this._rules.get(ruleId);
    if (!rule) return null;
    return {
      ruleId: ruleId,
      triggered: rule.effectiveness ? rule.effectiveness.triggered : 0,
      prevented: rule.effectiveness ? rule.effectiveness.prevented : 0,
      rate: rule.effectiveness && rule.effectiveness.triggered > 0
        ? rule.effectiveness.prevented / rule.effectiveness.triggered
        : 0,
    };
  }

  /**
   * 记录规则检查的结果，用于追踪规则效果。触发计数加1，若成功阻止违规则阻止计数也加1。
   * @param {string} ruleId - 规则ID
   * @param {boolean} preventedViolation - 是否成功阻止了违规
   * @returns {boolean} 记录是否成功，规则不存在时返回 false
   */
  recordRuleOutcome(ruleId, preventedViolation) {
    this.guardShutdown();
    const rule = this._rules.get(ruleId);
    if (!rule) return false;
    if (!rule.effectiveness) rule.effectiveness = { triggered: 0, prevented: 0 };
    rule.effectiveness.triggered++;
    if (preventedViolation) rule.effectiveness.prevented++;
    return true;
  }

  /**
   * 移除指定ID的规则。规则存在并被移除时递增版本号并触发 rule-removed 事件。
   * @param {string} ruleId - 待移除的规则ID
   * @returns {boolean} 规则是否存在并被移除，不存在时返回 false
   */
  removeRule(ruleId) {
    this.guardShutdown();
    if (!ruleId || typeof ruleId !== 'string') return false;
    const existed = this._rules.has(ruleId);
    this._rules.delete(ruleId);
    if (existed) {
      this._incrementVersion();
      this.emit('rule-removed', { ruleId });
    }
    return existed;
  }

  /**
   * 对代码执行所有已启用规则的违规检查，收集并记录违规信息。
   * @param {string} code - 待检查的代码文本
   * @param {Object} [context] - 检查上下文，与 code 合并后传入各规则的 check 函数
   * @param {string} [context.filePath] - 文件路径，部分规则依赖此字段判断层级
   * @param {Array} [context.dependencies] - 依赖关系列表，用于循环依赖检测
   * @returns {{ violations: Array<Object>, checkedRules: number }} 检查结果，包含违规列表和已检查规则数
   */
  checkViolation(code, context) {
    this.guardShutdown();
    const result = safeExecute(() => {
      const ctx = safeAssign({ code: code ?? '' }, context);
      const violations = [];
      this._rules.forEach((rule) => {
        if (!rule.enabled) return;
        this._stats.totalChecks++;
        try {
          const checkResult = rule.check(ctx);
          if (checkResult && checkResult.violated) {
            const violation = {
              ruleId: rule.id,
              ruleName: rule.name,
              severity: rule.severity,
              category: rule.category,
              evidence: checkResult.evidence || '',
              timestamp: new Date().toISOString(),
            };
            violations.push(violation);
            this._violations.push(violation);
            this._stats.totalViolations++;
            this._stats.byRule[rule.id] = (this._stats.byRule[rule.id] ?? 0) + 1;
            this._stats.byCategory[rule.category] = (this._stats.byCategory[rule.category] ?? 0) + 1;
            this._stats.bySeverity[rule.severity] = (this._stats.bySeverity[rule.severity] ?? 0) + 1;
          }
        } catch (e) {
          debug('IronRuleEngine', 'checkViolation:' + rule.id, e);
        }
      });
      if (violations.length > 0) {
        this.emit('violations-detected', { count: violations.length, violations });
      }
      return { violations, checkedRules: this._getEnabledCount() };
    }, 'IronRuleEngine', 'checkViolation', { violations: [], checkedRules: 0 });
    if (result && result.checkedRules === 0 && this._rules.size > 0) {
      try { this.emit('safe-execute-error', { method: 'checkViolation', error: 'Internal error — 0 rules checked despite rules being loaded' }); } catch (_e) { debug('IronRuleEngine', 'checkViolation-emit', _e && _e.message ? _e.message : String(_e)); }
    }
    return result;
  }

  /**
   * 获取所有规则的摘要信息列表，包含ID、名称、描述、严重级别、分类和启用状态。
   * @returns {Array<{ id: string, name: string, description: string, severity: string, category: string, enabled: boolean }>} 规则摘要数组
   */
  getRules() {
    this.guardShutdown();
    const result = [];
    this._rules.forEach((rule) => {
      result.push({
        id: rule.id,
        name: rule.name,
        description: rule.description,
        severity: rule.severity,
        category: rule.category,
        enabled: rule.enabled,
      });
    });
    return result;
  }

  /**
   * 获取最近的违规记录，按时间倒序返回指定数量的记录。
   * @param {number} [limit] - 返回的最大违规记录数，默认为配置的 maxViolations
   * @returns {Array<Object>} 违规记录数组
   */
  getViolations(limit) {
    this.guardShutdown();
    const maxCount = limit ?? this._config.maxViolations;
    const items = [];
    const arr = this._violations;
    const start = Math.max(0, arr.length - maxCount);
    for (let i = start; i < arr.length; i++) {
      items.push(arr.get(i));
    }
    return items.filter(Boolean);
  }

  /**
   * 获取规则引擎的统计信息，包括总检查次数、总违规次数、规则总数、已启用规则数及按规则/分类/严重级别的分组统计。
   * @returns {{ totalChecks: number, totalViolations: number, totalRules: number, enabledRules: number, byRule: Object, byCategory: Object, bySeverity: Object }} 统计信息对象
   */
  getRuleStats() {
    this.guardShutdown();
    return {
      totalChecks: this._stats.totalChecks,
      totalViolations: this._stats.totalViolations,
      totalRules: this._rules.size,
      enabledRules: this._getEnabledCount(),
      byRule: { ...this._stats.byRule },
      byCategory: { ...this._stats.byCategory },
      bySeverity: { ...this._stats.bySeverity },
    };
  }

  /**
   * 启用指定规则。规则启用后递增版本号。
   * @param {string} ruleId - 待启用的规则ID
   * @returns {boolean} 是否成功启用，规则不存在时返回 false
   */
  enableRule(ruleId) {
    this.guardShutdown();
    const rule = this._rules.get(ruleId);
    if (rule) { rule.enabled = true; this._incrementVersion(); }
    return !!rule;
  }

  /**
   * 禁用指定规则。规则禁用后递增版本号。
   * @param {string} ruleId - 待禁用的规则ID
   * @returns {boolean} 是否成功禁用，规则不存在时返回 false
   */
  disableRule(ruleId) {
    this.guardShutdown();
    const rule = this._rules.get(ruleId);
    if (rule) { rule.enabled = false; this._incrementVersion(); }
    return !!rule;
  }

  _getEnabledCount() {
    let count = 0;
    this._rules.forEach((rule) => { if (rule.enabled) count++; });
    return count;
  }

  // --- Rule sync capabilities ---

  /**
   * 导出所有规则为可序列化对象，包含规则元数据、检查函数字符串和效果统计。
   * @returns {{ version: number, exportedAt: string, ruleCount: number, rules: Array<Object> }} 导出的规则集，包含版本号、导出时间、规则数量和规则数组
   */
  exportRules() {
    this.guardShutdown();
    const rules = [];
    const serializableProps = ['id', 'name', 'description', 'severity', 'category', 'enabled', 'addedAt', 'source', 'solution'];
    this._rules.forEach((rule) => {
      const exported = {};
      for (const key of serializableProps) {
        if (rule[key] !== undefined && rule[key] !== null) {
          exported[key] = rule[key];
        }
      }
      if (typeof rule.check === 'function') {
        exported._checkFnString = rule.check.toString();
      }
      if (rule.effectiveness) {
        exported.effectiveness = { triggered: rule.effectiveness.triggered ?? 0, prevented: rule.effectiveness.prevented ?? 0 };
      }
      if (rule.createdAt !== undefined) exported.createdAt = rule.createdAt;
      rules.push(exported);
    });
    const result = {
      version: this._rulesVersion,
      exportedAt: new Date().toISOString(),
      ruleCount: rules.length,
      rules,
    };
    this.emit('rules-exported', { version: result.version, ruleCount: result.ruleCount });
    return result;
  }

  _buildRuleFromData(ruleData, source) {
    let checkFn;
    if (typeof ruleData._checkFnString === 'string') {
      try {
        checkFn = this._deserializeCheckFn(ruleData._checkFnString);
      } catch (e) {
        debug('IronRuleEngine', 'buildRule: failed to deserialize check for', ruleData.id, e && e.message ? e.message : String(e));
      }
    }
    const rule = {
      id: ruleData.id,
      name: ruleData.name || ruleData.id,
      description: ruleData.description || '',
      severity: ruleData.severity ?? SEVERITY_LEVELS.WARNING,
      category: ruleData.category ?? CATEGORY_TYPES.STYLE,
      check: checkFn || function() { return { violated: false, evidence: '' }; },
      enabled: ruleData.enabled !== undefined ? ruleData.enabled : this._config.enabledByDefault,
      addedAt: ruleData.addedAt || new Date().toISOString(),
      source: ruleData.source || source,
      solution: ruleData.solution || '',
      effectiveness: ruleData.effectiveness ? { triggered: ruleData.effectiveness.triggered ?? 0, prevented: ruleData.effectiveness.prevented ?? 0 } : { triggered: 0, prevented: 0 },
    };
    if (ruleData.createdAt !== undefined) rule.createdAt = ruleData.createdAt;
    return rule;
  }

  /**
   * 从规则集对象导入规则。已存在的规则会被跳过，不会覆盖。
   * @param {Object} ruleset - 规则集对象
   * @param {Array<Object>} ruleset.rules - 待导入的规则数组，每条规则需有 id 字段
   * @returns {{ imported: number, skipped: number, errors: number, reason?: string }} 导入结果，包含成功导入数、跳过数、错误数及可选失败原因
   */
  importRules(ruleset) {
    this.guardShutdown();
    if (!ruleset || !Array.isArray(ruleset.rules)) {
      return { imported: 0, skipped: 0, errors: 0, reason: 'Invalid ruleset: must contain a "rules" array' };
    }
    let imported = 0;
    let skipped = 0;
    let errors = 0;
    for (const ruleData of ruleset.rules) {
      if (!ruleData || !ruleData.id) { errors++; continue; }
      if (this._rules.has(ruleData.id)) { skipped++; continue; }
      try {
        const rule = this._buildRuleFromData(ruleData, 'imported');
        this._rules.set(rule.id, rule);
        imported++;
        this._incrementVersion();
      } catch (e) {
        errors++;
        debug('IronRuleEngine', 'importRules: error', ruleData.id, e && e.message ? e.message : String(e));
      }
    }
    this.emit('rules-imported', { imported, skipped, errors });
    return { imported, skipped, errors };
  }

  /**
   * 反序列化检查函数字符串。使用with(sandbox)沙箱隔离执行，冻结空sandbox防止原型链逃逸。
   * @param {string} fnString - 序列化的函数字符串
   * @returns {Function|null} 反序列化后的函数，失败时返回null
   */
  _deserializeCheckFn(fnString) {
    const trimmed = fnString.trim();
    if (!trimmed) return null;
    const DANGEROUS_IDENTS = /\b(require|import|process|global|globalThis|eval|Function|__proto__|constructor|prototype|Reflect|Proxy|window|document|this)\b/;
    if (DANGEROUS_IDENTS.test(trimmed)) {
      debug('IronRuleEngine', 'deserializeBlocked', 'Check function contains forbidden identifier');
      return null;
    }
    const SANDBOX_BYPASS_PATTERN = /constructor|__proto__|prototype|__lookupGetter__|__lookupSetter__|__defineGetter__|__defineSetter__|\]\s*\[/;
    if (SANDBOX_BYPASS_PATTERN.test(trimmed)) {
      throw new Error('Rule check function contains forbidden sandbox escape pattern');
    }
    try {
      const sandbox = Object.freeze(Object.create(null));
      let fn;
      try {
        fn = new Function('sandbox', 'with(sandbox){return(' + trimmed + ')}');
      } catch (_e) {
        return function() { return { passed: false, violations: [{ ruleId: 'deserialize-error', message: 'Failed to deserialize check function: ' + (_e && _e.message ? _e.message : String(_e)) }] }; };
      }
      const result = fn(sandbox);
      if (typeof result === 'function') return result;
      return null;
    } catch (_e) {
      debug('IronRuleEngine', 'deserializeError', _e && _e.message ? _e.message : String(_e));
    }
    return null;
  }

  /**
   * 获取当前规则集的指纹信息。基于所有规则的ID、启用状态、严重级别、分类及检查函数生成SHA-256哈希。
   * 用于规则集版本比对和一致性校验。
   * @returns {{ hash: string, version: number, ruleCount: number, ruleIds: string[], generatedAt: string }} 指纹信息，包含哈希值、版本号、规则数量、规则ID列表和生成时间
   */
  getRuleFingerprint() {
    this.guardShutdown();
    const crypto = require('crypto');
    const parts = [];
    const ruleIds = [];
    this._rules.forEach((rule) => {
      ruleIds.push(rule.id);
      parts.push(rule.id + '|' + (rule.enabled ? '1' : '0') + '|' + rule.severity + '|' + rule.category);
      if (typeof rule.check === 'function') {
        parts.push(rule.check.toString());
      }
    });
    ruleIds.sort();
    const payload = parts.sort().join('\n') + '\nversion:' + this._rulesVersion;
    const hash = crypto.createHash('sha256').update(payload, 'utf-8').digest('hex').slice(0, 16);
    const result = {
      hash,
      version: this._rulesVersion,
      ruleCount: ruleIds.length,
      ruleIds,
      generatedAt: new Date().toISOString(),
    };
    this.emit('rules-fingerprint-generated', { hash, version: this._rulesVersion });
    return result;
  }

  /**
   * 从远程规则集同步规则。新增本地不存在的规则，更新已有规则的字段，移除远程已删除的规则。
   * 内置规则被远程删除时仅禁用而非移除，非内置规则则直接删除。
   * @param {Object} ruleset - 远程规则集对象
   * @param {Array<Object>} ruleset.rules - 远程规则数组
   * @returns {{ added: number, updated: number, removed: number, unchanged: number, errors: number, reason?: string }} 同步结果统计
   */
  syncFrom(ruleset) {
    this.guardShutdown();
    if (!ruleset || !Array.isArray(ruleset.rules)) {
      return { added: 0, updated: 0, removed: 0, unchanged: 0, errors: 0, reason: 'Invalid ruleset: must contain a "rules" array' };
    }

    const remoteRuleMap = new Map();
    for (const r of ruleset.rules) {
      if (r && r.id) remoteRuleMap.set(r.id, r);
    }

    const localRuleIds = new Set();
    this._rules.forEach((rule) => localRuleIds.add(rule.id));
    const remoteRuleIds = new Set(remoteRuleMap.keys());

    const addResult = this._syncAddRules(remoteRuleMap, localRuleIds);
    const updateResult = this._syncUpdateRules(remoteRuleMap, localRuleIds);
    const removeResult = this._syncRemoveRules(localRuleIds, remoteRuleIds);

    const result = {
      added: addResult.added,
      updated: updateResult.updated,
      removed: removeResult.removed,
      unchanged: updateResult.unchanged,
      errors: addResult.errors,
    };
    this.emit('rules-synced', result);
    return result;
  }

  _syncAddRules(remoteRuleMap, localRuleIds) {
    let added = 0;
    let errors = 0;
    for (const [ruleId, ruleData] of remoteRuleMap) {
      if (localRuleIds.has(ruleId)) continue;
      try {
        const rule = this._buildRuleFromData(ruleData, 'synced');
        this._rules.set(rule.id, rule);
        added++;
        this._incrementVersion();
      } catch (e) {
        errors++;
        debug('IronRuleEngine', 'syncFrom: error adding', ruleId, e && e.message ? e.message : String(e));
      }
    }
    return { added, errors };
  }

  _syncUpdateRules(remoteRuleMap, localRuleIds) {
    let updated = 0;
    let unchanged = 0;
    const fields = ['enabled', 'severity', 'category', 'name', 'description', 'solution'];
    for (const [ruleId, ruleData] of remoteRuleMap) {
      if (!localRuleIds.has(ruleId)) continue;
      const localRule = this._rules.get(ruleId);
      let changed = false;
      for (const field of fields) {
        if (ruleData[field] !== undefined && localRule[field] !== ruleData[field]) {
          localRule[field] = ruleData[field];
          changed = true;
        }
      }
      if (changed) { updated++; this._incrementVersion(); } else { unchanged++; }
    }
    return { updated, unchanged };
  }

  _syncRemoveRules(localRuleIds, remoteRuleIds) {
    let removed = 0;
    for (const ruleId of localRuleIds) {
      if (remoteRuleIds.has(ruleId)) continue;
      const localRule = this._rules.get(ruleId);
      if (localRule.source === 'built-in' || !localRule.source) {
        if (localRule.enabled) {
          localRule.enabled = false;
          localRule._remotelyRemoved = true;
          removed++;
          this._incrementVersion();
        }
      } else {
        this._rules.delete(ruleId);
        removed++;
        this._incrementVersion();
      }
    }
    return { removed };
  }

  _onShutdown() {
    this._rules.clear();
    this._violations.clear();
    this._stats = { totalChecks: 0, totalViolations: 0, byRule: {}, byCategory: {}, bySeverity: {} };
    this.removeAllListeners();
  }
}

IronRuleEngine.SEVERITY_LEVELS = SEVERITY_LEVELS;
IronRuleEngine.CATEGORY_TYPES = CATEGORY_TYPES;
IronRuleEngine.BUILT_IN_RULES = BUILT_IN_RULES;

module.exports = withShutdown(IronRuleEngine);
