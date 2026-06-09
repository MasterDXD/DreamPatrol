'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

// ─── 常量 ──────────────────────────────────────────────────────────────────────

const DEFAULT_PHASES = [
  'brainstorming',
  'design',
  'implementation',
  'testing',
  'review',
  'deployment',
];

const DEFAULT_MAX_REPAIR_ITERATIONS = 3;
const SOFT_VIOLATION_THRESHOLD = 3;

// ─── ProgressiveDisclosureOrchestrator ─────────────────────────────────────────

/**
 * @classdesc 渐进式上下文披露编排器 — 统一管理分阶段上下文披露策略。
 * 根据当前阶段和令牌预算，决定哪些上下文应保留、压缩或丢弃，
 * 并通过阶段转换规则确保关键信息在阶段间平滑传递。
 *
 * @extends EventEmitter
 * @emits 'phase-transition' 阶段转换时触发
 * @emits 'disclosure-plan-updated' 披露计划更新时触发
 * @emits 'context-discarded' 上下文被丢弃时触发
 */
class ProgressiveDisclosureOrchestrator extends EventEmitter {
  /**
   * 创建 ProgressiveDisclosureOrchestrator 实例。
   * @param {Object} [options] - 配置选项
   * @param {Array<string>} [options.phases] - 阶段列表，默认6阶段
   * @param {Map<string, Function>} [options.phaseTransitionRules] - 阶段转换规则映射
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._phases = Array.isArray(opts.phases) && opts.phases.length > 0
      ? opts.phases
      : [...DEFAULT_PHASES];
    this._phaseTransitionRules = opts.phaseTransitionRules instanceof Map
      ? new Map(opts.phaseTransitionRules)
      : new Map();
    /** @type {string} 当前阶段 */
    this._currentPhase = this._phases[0];
    /** @type {Object|null} 关联的技能路由器 */
    this._skillRouter = null;
    /** @type {Object|null} 关联的令牌管理器 */
    this._tokenManager = null;

    this._initDefaultTransitionRules();
  }

  /**
   * 获取当前阶段。
   * @type {string}
   */
  get currentPhase() {
    return this._currentPhase;
  }

  /**
   * 获取阶段列表。
   * @type {Array<string>}
   */
  get phases() {
    return [...this._phases];
  }

  /**
   * 初始化默认阶段转换规则。
   * brainstorming→design: 保留想法，丢弃探索笔记
   * design→implementation: 保留架构，丢弃备选方案
   * implementation→testing: 保留代码，丢弃设计草稿
   * @private
   */
  _initDefaultTransitionRules() {
    const defaultRules = [
      {
        from: 'brainstorming',
        to: 'design',
        fn: (context) => ({
          keep: context.ideas ?? [],
          compress: [],
          discard: context.explorationNotes ?? [],
        }),
      },
      {
        from: 'design',
        to: 'implementation',
        fn: (context) => ({
          keep: context.architecture ?? [],
          compress: [],
          discard: context.alternatives ?? [],
        }),
      },
      {
        from: 'implementation',
        to: 'testing',
        fn: (context) => ({
          keep: context.code ?? [],
          compress: [],
          discard: context.designDrafts ?? [],
        }),
      },
    ];

    for (const rule of defaultRules) {
      const key = `${rule.from}->${rule.to}`;
      if (!this._phaseTransitionRules.has(key)) {
        this._phaseTransitionRules.set(key, rule.fn);
      }
    }
  }

  /**
   * 注册阶段转换规则。
   * @param {string} fromPhase - 源阶段名称
   * @param {string} toPhase - 目标阶段名称
   * @param {Function} transitionFn - 转换函数，签名为 (context) => { keep, compress, discard }
   * @throws {TypeError} 参数类型不正确时抛出
   */
  registerPhaseTransition(fromPhase, toPhase, transitionFn) {
    if (typeof fromPhase !== 'string' || !fromPhase) {
      throw new TypeError('fromPhase 必须是非空字符串');
    }
    if (typeof toPhase !== 'string' || !toPhase) {
      throw new TypeError('toPhase 必须是非空字符串');
    }
    if (typeof transitionFn !== 'function') {
      throw new TypeError('transitionFn 必须是函数');
    }
    const key = `${fromPhase}->${toPhase}`;
    this._phaseTransitionRules.set(key, transitionFn);
  }

  /**
   * 阶段转换回调，应用转换规则决定上下文保留/压缩/丢弃策略。
   * @param {string} fromPhase - 源阶段
   * @param {string} toPhase - 目标阶段
   * @param {Object} context - 当前上下文
   * @returns {{ keep: Array, compress: Array, discard: Array }} 转换结果
   */
  onPhaseTransition(fromPhase, toPhase, context) {
    const key = `${fromPhase}->${toPhase}`;
    const transitionFn = this._phaseTransitionRules.get(key);
    if (typeof transitionFn !== 'function') {
      return { keep: [], compress: [], discard: [] };
    }

    try {
      const result = transitionFn(context ?? {});
      const keep = Array.isArray(result.keep) ? result.keep : [];
      const compress = Array.isArray(result.compress) ? result.compress : [];
      const discard = Array.isArray(result.discard) ? result.discard : [];

      this.emit('phase-transition', { fromPhase, toPhase, keep, compress, discard });

      if (discard.length > 0) {
        this.emit('context-discarded', { fromPhase, toPhase, discarded: discard });
      }

      return { keep, compress, discard };
    } catch (err) {
      debug('ProgressiveDisclosureOrchestrator', 'onPhaseTransition', err);
      return { keep: [], compress: [], discard: [], _error: err.message || String(err) };
    }
  }

  /**
   * 获取当前阶段的上下文披露计划。
   * 根据阶段和令牌预算，确定应披露的上下文内容。
   * @param {string} phase - 目标阶段
   * @param {number} tokenBudget - 令牌预算
   * @returns {{ phase: string, tokenBudget: number, disclosureItems: Array, estimatedTokens: number }} 披露计划
   */
  getDisclosurePlan(phase, tokenBudget) {
    const budget = typeof tokenBudget === 'number' && Number.isFinite(tokenBudget) && tokenBudget > 0
      ? tokenBudget
      : Infinity;

    const disclosureItems = [];
    let estimatedTokens = 0;

    // 如果关联了技能路由器，按 L1/L2/L3 层级渐进加载
    if (this._skillRouter && typeof this._skillRouter.getLayeredContext === 'function') {
      try {
        const layered = this._skillRouter.getLayeredContext(phase);
        const layers = ['L1', 'L2', 'L3'];
        for (const layer of layers) {
          const items = Array.isArray(layered[layer]) ? layered[layer] : [];
          for (const item of items) {
            const itemTokens = (typeof item === 'string') ? Math.ceil(item.length / 4) : 50;
            if (estimatedTokens + itemTokens <= budget) {
              disclosureItems.push({ layer, content: item, tokens: itemTokens });
              estimatedTokens += itemTokens;
            }
          }
        }
      } catch (err) {
        debug('ProgressiveDisclosureOrchestrator', 'getDisclosurePlan:skillRouter', err);
      }
    }

    // 如果关联了令牌管理器，用预算驱动披露
    if (this._tokenManager && typeof this._tokenManager.getBudgetAllocation === 'function') {
      try {
        const allocation = this._tokenManager.getBudgetAllocation(phase, budget);
        if (allocation && typeof allocation.allocated === 'number') {
          estimatedTokens = Math.min(estimatedTokens, allocation.allocated);
        }
      } catch (err) {
        debug('ProgressiveDisclosureOrchestrator', 'getDisclosurePlan:tokenManager', err);
      }
    }

    const plan = { phase, tokenBudget: budget, disclosureItems, estimatedTokens };
    this.emit('disclosure-plan-updated', plan);
    return plan;
  }

  /**
   * 关联技能路由器，用于 L1/L2/L3 渐进加载。
   * @param {Object} skillRouter - 技能路由器实例
   */
  linkSkillRouter(skillRouter) {
    this._skillRouter = skillRouter ?? null;
  }

  /**
   * 关联令牌管理器，用于预算驱动披露。
   * @param {Object} tokenManager - 令牌管理器实例
   */
  linkTokenManager(tokenManager) {
    this._tokenManager = tokenManager ?? null;
  }
}

// ─── TripleDefenseCoordinator ──────────────────────────────────────────────────

/**
 * @classdesc 三层防御协调器 — 协调软约束、硬编码和代码检查三层约束体系。
 * 确保每条规则在软约束（提示引导）、硬约束（代码强制）和代码检查（自动化检查）
 * 三个层面都有对应执行，自动检测覆盖缺口并建议加强。
 *
 * @extends EventEmitter
 * @emits 'constraint-violated' 约束被违反时触发
 * @emits 'coverage-gap-detected' 检测到覆盖缺口时触发
 * @emits 'constraint-strengthened' 约束被加强时触发
 */
class TripleDefenseCoordinator extends EventEmitter {
  /**
   * 创建 TripleDefenseCoordinator 实例。
   * @param {Object} [options] - 配置选项
   * @param {string|null} [options.constraintMapPath=null] - 约束映射文件路径
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._constraintMapPath = opts.constraintMapPath ?? null;
    /** @type {Map<string, {soft: Function|null, hard: Function|null, linter: Function|null, violations: Object}>} 约束注册表 */
    this._constraints = new Map();
  }

  /**
   * 获取已注册约束数量。
   * @type {number}
   */
  get constraintCount() {
    return this._constraints.size;
  }

  /**
   * 注册一条约束规则，覆盖软约束、硬约束和代码检查三个层面。
   * @param {string} ruleName - 规则名称
   * @param {Object} layers - 三层约束定义
   * @param {Function|null} [layers.soft=null] - 软约束函数（提示引导）
   * @param {Function|null} [layers.hard=null] - 硬约束函数（代码强制）
   * @param {Function|null} [layers.linter=null] - 代码检查函数（自动化检查）
   * @throws {TypeError} ruleName 非字符串或 layers 非对象时抛出
   */
  registerConstraint(ruleName, layers) {
    if (typeof ruleName !== 'string' || !ruleName) {
      throw new TypeError('ruleName 必须是非空字符串');
    }
    if (!layers || typeof layers !== 'object') {
      throw new TypeError('layers 必须是对象');
    }

    this._constraints.set(ruleName, {
      soft: typeof layers.soft === 'function' ? layers.soft : null,
      hard: typeof layers.hard === 'function' ? layers.hard : null,
      linter: typeof layers.linter === 'function' ? layers.linter : null,
      violations: { soft: 0, hard: 0, linter: 0 },
    });
  }

  /**
   * 检查约束覆盖情况，返回覆盖报告。
   * @returns {{ total: number, fullyCovered: number, partiallyCovered: number, uncovered: number, details: Array }} 覆盖报告
   */
  checkCoverage() {
    let fullyCovered = 0;
    let partiallyCovered = 0;
    let uncovered = 0;
    const details = [];

    for (const [ruleName, constraint] of this._constraints) {
      const hasSoft = constraint.soft !== null;
      const hasHard = constraint.hard !== null;
      const hasLinter = constraint.linter !== null;
      const layerCount = (hasSoft ? 1 : 0) + (hasHard ? 1 : 0) + (hasLinter ? 1 : 0);

      let coverage = 'uncovered';
      if (layerCount === 3) {
        coverage = 'full';
        fullyCovered++;
      } else if (layerCount > 0) {
        coverage = 'partial';
        partiallyCovered++;
      } else {
        uncovered++;
      }

      const detail = {
        ruleName,
        hasSoft,
        hasHard,
        hasLinter,
        coverage,
        missingLayers: [],
      };

      if (!hasSoft) detail.missingLayers.push('soft');
      if (!hasHard) detail.missingLayers.push('hard');
      if (!hasLinter) detail.missingLayers.push('linter');

      details.push(detail);

      // 检测覆盖缺口并发出事件
      if (coverage !== 'full') {
        safeCall(
          () => this.emit('coverage-gap-detected', { ruleName, coverage, missingLayers: detail.missingLayers }),
          'TripleDefenseCoordinator',
          'checkCoverage:emit',
        );
      }
    }

    return {
      total: this._constraints.size,
      fullyCovered,
      partiallyCovered,
      uncovered,
      details,
    };
  }

  /**
   * 对指定规则执行三层约束执行。
   * 执行顺序：软约束（提示引导）→ 硬约束（代码强制）→ 代码检查（自动化检查）。
   * @param {string} ruleName - 规则名称
   * @param {Object} context - 执行上下文
   * @returns {{ ruleName: string, results: Array, allPassed: boolean }} 执行结果
   * @throws {Error} 规则未注册时抛出
   */
  enforce(ruleName, context) {
    const constraint = this._constraints.get(ruleName);
    if (!constraint) {
      throw new Error(`规则 "${ruleName}" 未注册`);
    }

    const results = [];
    const layers = [
      { name: 'soft', fn: constraint.soft },
      { name: 'hard', fn: constraint.hard },
      { name: 'linter', fn: constraint.linter },
    ];

    for (const layer of layers) {
      if (typeof layer.fn !== 'function') {
        results.push({ layer: layer.name, executed: false, passed: null, reason: '未注册' });
        continue;
      }

      try {
        const layerResult = layer.fn(context ?? {});
        const passed = layerResult === true || (layerResult && layerResult.passed === true);
        results.push({
          layer: layer.name,
          executed: true,
          passed,
          reason: passed ? '通过' : (layerResult.reason || '未通过'),
        });

        if (!passed) {
          this.reportViolation(ruleName, layer.name, { reason: layerResult.reason || '未通过' });
        }
      } catch (err) {
        results.push({ layer: layer.name, executed: true, passed: false, reason: `执行异常: ${err.message}` });
        this.reportViolation(ruleName, layer.name, { reason: `执行异常: ${err.message}` });
      }
    }

    const anyExecuted = results.some(r => r.executed);
    const allPassed = anyExecuted && results.every(r => r.passed === true || r.passed === null);
    return { ruleName, results, allPassed };
  }

  /**
   * 记录约束违反并自动加强。
   * 当软约束被违反3次及以上时，建议添加硬约束执行。
   * @param {string} ruleName - 规则名称
   * @param {string} layer - 违反的层面（soft/hard/linter）
   * @param {Object} details - 违反详情
   */
  reportViolation(ruleName, layer, details) {
    const constraint = this._constraints.get(ruleName);
    if (!constraint) return;

    if (constraint.violations && typeof constraint.violations[layer] === 'number') {
      constraint.violations[layer]++;
    }

    this.emit('constraint-violated', { ruleName, layer, details, violationCount: constraint.violations[layer] });

    // 软约束违反达到阈值，建议加强为硬约束
    if (layer === 'soft' && constraint.violations.soft >= SOFT_VIOLATION_THRESHOLD && constraint.hard === null) {
      this.emit('constraint-strengthened', {
        ruleName,
        from: 'soft',
        to: 'hard',
        reason: `软约束累计违反 ${constraint.violations.soft} 次，建议添加硬约束执行`,
      });
    }
  }

  /**
   * 获取所有约束的完整报告。
   * @returns {{ constraints: Array, coverage: Object }} 约束报告
   */
  getConstraintReport() {
    const constraints = [];
    for (const [ruleName, constraint] of this._constraints) {
      constraints.push({
        ruleName,
        hasSoft: constraint.soft !== null,
        hasHard: constraint.hard !== null,
        hasLinter: constraint.linter !== null,
        violations: { ...constraint.violations },
      });
    }

    return {
      constraints,
      coverage: this.checkCoverage(),
    };
  }
}

// ─── VerificationLoop ──────────────────────────────────────────────────────────

/**
 * @classdesc 验证循环 — 统一的前置/后置验证循环。
 * 执行流程：前置验证 → 执行任务 → 后置验证 → （若失败）修复 → 重新验证循环。
 * 当检测到多文件修改时，强制执行跨文件一致性检查。
 *
 * @extends EventEmitter
 * @emits 'pre-validation-passed' 前置验证通过时触发
 * @emits 'pre-validation-failed' 前置验证失败时触发
 * @emits 'post-validation-passed' 后置验证通过时触发
 * @emits 'post-validation-failed' 后置验证失败时触发
 * @emits 'repair-attempted' 修复尝试时触发
 */
class VerificationLoop extends EventEmitter {
  /**
   * 创建 VerificationLoop 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxRepairIterations=3] - 最大修复迭代次数
   * @param {Array<{name: string, fn: Function}>} [options.preValidators=[]] - 前置验证器列表
   * @param {Array<{name: string, fn: Function}>} [options.postValidators=[]] - 后置验证器列表
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._maxRepairIterations = typeof opts.maxRepairIterations === 'number'
      && Number.isFinite(opts.maxRepairIterations) && opts.maxRepairIterations > 0
      ? opts.maxRepairIterations
      : DEFAULT_MAX_REPAIR_ITERATIONS;
    /** @type {Map<string, Function>} 前置验证器注册表 */
    this._preValidators = new Map();
    /** @type {Map<string, Function>} 后置验证器注册表 */
    this._postValidators = new Map();

    // 从选项中初始化验证器
    const preList = Array.isArray(opts.preValidators) ? opts.preValidators : [];
    for (const v of preList) {
      if (v && typeof v.name === 'string' && typeof v.fn === 'function') {
        this._preValidators.set(v.name, v.fn);
      }
    }

    const postList = Array.isArray(opts.postValidators) ? opts.postValidators : [];
    for (const v of postList) {
      if (v && typeof v.name === 'string' && typeof v.fn === 'function') {
        this._postValidators.set(v.name, v.fn);
      }
    }
  }

  /**
   * 获取最大修复迭代次数。
   * @type {number}
   */
  get maxRepairIterations() {
    return this._maxRepairIterations;
  }

  /**
   * 注册前置验证器。
   * @param {string} name - 验证器名称
   * @param {Function} validatorFn - 验证函数，签名为 (context) => { passed, reason }
   * @throws {TypeError} 参数类型不正确时抛出
   */
  registerPreValidator(name, validatorFn) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('name 必须是非空字符串');
    }
    if (typeof validatorFn !== 'function') {
      throw new TypeError('validatorFn 必须是函数');
    }
    this._preValidators.set(name, validatorFn);
  }

  /**
   * 注册后置验证器。
   * @param {string} name - 验证器名称
   * @param {Function} validatorFn - 验证函数，签名为 (result, context) => { passed, reason }
   * @throws {TypeError} 参数类型不正确时抛出
   */
  registerPostValidator(name, validatorFn) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('name 必须是非空字符串');
    }
    if (typeof validatorFn !== 'function') {
      throw new TypeError('validatorFn 必须是函数');
    }
    this._postValidators.set(name, validatorFn);
  }

  /**
   * 执行完整验证循环：前置验证 → 执行 → 后置验证 → 修复 → 重新验证。
   * @param {Function} taskFn - 任务执行函数，签名为 (context) => Promise<result>
   * @param {Object} context - 执行上下文
   * @returns {Promise<{ result: *, preValidation: Object, postValidation: Object, repairAttempts: number, success: boolean }>} 执行结果
   */
  async execute(taskFn, context) {
    if (typeof taskFn !== 'function') {
      throw new TypeError('taskFn 必须是函数');
    }

    const ctx = context ?? {};
    let repairAttempts = 0;
    let currentContext = ctx;

    // 前置验证
    const preResult = this.validateInputs(currentContext);
    if (!preResult.passed) {
      this.emit('pre-validation-failed', { failures: preResult.failures, context: currentContext });
      return {
        result: null,
        preValidation: preResult,
        postValidation: { passed: false, failures: [] },
        repairAttempts: 0,
        success: false,
      };
    }
    this.emit('pre-validation-passed', { context: currentContext });

    // 执行任务
    let taskResult = null;
    try {
      taskResult = await taskFn(currentContext);
    } catch (err) {
      debug('VerificationLoop', 'execute:taskFn', err);
      return {
        result: null,
        preValidation: preResult,
        postValidation: { passed: false, failures: [{ name: 'task-execution', reason: err.message || String(err) }] },
        repairAttempts: 0,
        success: false,
        _error: err.message || String(err),
      };
    }

    // 多文件修改检测 → 强制跨文件一致性检查
    if (typeof currentContext.modifiedFiles === 'number' && currentContext.modifiedFiles > 1) {
      const crossFileResult = this._checkCrossFileConsistency(taskResult, currentContext);
      if (!crossFileResult.passed) {
        this.emit('post-validation-failed', { failures: crossFileResult.failures, context: currentContext });
      }
    }

    // 后置验证 + 修复循环
    let postResult = this.validateOutputs(taskResult, currentContext);

    while (!postResult.passed && repairAttempts < this._maxRepairIterations) {
      repairAttempts++;
      this.emit('repair-attempted', {
        attempt: repairAttempts,
        failures: postResult.failures,
        context: currentContext,
      });

      // 尝试修复：在上下文中注入修复信息供 taskFn 使用
      currentContext = {
        ...currentContext,
        _repairAttempt: repairAttempts,
        _repairFailures: postResult.failures,
      };

      try {
        taskResult = await taskFn(currentContext);
      } catch (repairErr) {
        debug('VerificationLoop', `execute:repair:${repairAttempts}`, repairErr);
        break;
      }

      postResult = this.validateOutputs(taskResult, currentContext);
    }

    if (postResult.passed) {
      this.emit('post-validation-passed', { result: taskResult, context: currentContext });
    } else {
      this.emit('post-validation-failed', { failures: postResult.failures, context: currentContext });
    }

    return {
      result: taskResult,
      preValidation: preResult,
      postValidation: postResult,
      repairAttempts,
      success: postResult.passed,
    };
  }

  /**
   * 运行所有前置验证器。
   * @param {Object} context - 执行上下文
   * @returns {{ passed: boolean, failures: Array<{name: string, reason: string}> }} 验证结果
   */
  validateInputs(context) {
    const failures = [];

    for (const [name, validatorFn] of this._preValidators) {
      try {
        const result = validatorFn(context ?? {});
        if (!result || result.passed !== true) {
          failures.push({ name, reason: (result && result.reason) || '前置验证未通过' });
        }
      } catch (err) {
        failures.push({ name, reason: `验证异常: ${err.message}` });
      }
    }

    return { passed: failures.length === 0, failures };
  }

  /**
   * 运行所有后置验证器。
   * @param {*} result - 任务执行结果
   * @param {Object} context - 执行上下文
   * @returns {{ passed: boolean, failures: Array<{name: string, reason: string}> }} 验证结果
   */
  validateOutputs(result, context) {
    const failures = [];

    for (const [name, validatorFn] of this._postValidators) {
      try {
        const vResult = validatorFn(result, context ?? {});
        if (!vResult || vResult.passed !== true) {
          failures.push({ name, reason: (vResult && vResult.reason) || '后置验证未通过' });
        }
      } catch (err) {
        failures.push({ name, reason: `验证异常: ${err.message}` });
      }
    }

    return { passed: failures.length === 0, failures };
  }

  /**
   * 跨文件一致性检查（当修改文件数 > 1 时强制执行）。
   * @param {*} result - 任务执行结果
   * @param {Object} context - 执行上下文
   * @returns {{ passed: boolean, failures: Array }} 一致性检查结果
   * @private
   */
  _checkCrossFileConsistency(result, _context) {
    const failures = [];

    // 检查结果中是否包含跨文件一致性信息
    if (result && typeof result === 'object' && result.crossFileConsistency === false) {
      failures.push({
        name: 'cross-file-consistency',
        reason: result.crossFileReason || '跨文件一致性检查未通过',
      });
    }

    return { passed: failures.length === 0, failures };
  }
}

// ─── HarnessEngineering ────────────────────────────────────────────────────────

/**
 * @module runtime/patterns/harness-engineering
 * Harness工程增强模块 — 融合Harness Engineering分析中的3个最高优先级增强。
 * 组合渐进式上下文披露编排器、三层防御协调器和验证循环三大子组件，
 * 为工程流程提供上下文管理、约束防御和质量验证能力。
 */

/**
 * @classdesc Harness工程增强集合。组合三大子组件提供完整的工程增强能力：
 * - ProgressiveDisclosureOrchestrator: 渐进式上下文披露编排
 * - TripleDefenseCoordinator: 三层防御约束协调
 * - VerificationLoop: 统一前置/后置验证循环
 *
 * @extends EventEmitter
 * @mixin withShutdown
 * @emits 'phase-transition' 委托自 ProgressiveDisclosureOrchestrator
 * @emits 'disclosure-plan-updated' 委托自 ProgressiveDisclosureOrchestrator
 * @emits 'context-discarded' 委托自 ProgressiveDisclosureOrchestrator
 * @emits 'constraint-violated' 委托自 TripleDefenseCoordinator
 * @emits 'coverage-gap-detected' 委托自 TripleDefenseCoordinator
 * @emits 'constraint-strengthened' 委托自 TripleDefenseCoordinator
 * @emits 'pre-validation-passed' 委托自 VerificationLoop
 * @emits 'pre-validation-failed' 委托自 VerificationLoop
 * @emits 'post-validation-passed' 委托自 VerificationLoop
 * @emits 'post-validation-failed' 委托自 VerificationLoop
 * @emits 'repair-attempted' 委托自 VerificationLoop
 */
class HarnessEngineering extends EventEmitter {
  /**
   * 创建 HarnessEngineering 实例。
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.progressiveDisclosure] - ProgressiveDisclosureOrchestrator 配置
   * @param {Object} [options.tripleDefense] - TripleDefenseCoordinator 配置
   * @param {Object} [options.verificationLoop] - VerificationLoop 配置
   */
  constructor(options) {
    super();
    const opts = options ?? {};

    this._progressiveDisclosure = new ProgressiveDisclosureOrchestrator(opts.progressiveDisclosure);
    this._tripleDefense = new TripleDefenseCoordinator(opts.tripleDefense);
    this._verificationLoop = new VerificationLoop(opts.verificationLoop);

    this._forwardEvents();
  }

  /**
   * 获取渐进式上下文披露编排器实例。
   * @type {ProgressiveDisclosureOrchestrator}
   */
  get progressiveDisclosure() {
    return this._progressiveDisclosure;
  }

  /**
   * 获取三层防御协调器实例。
   * @type {TripleDefenseCoordinator}
   */
  get tripleDefense() {
    return this._tripleDefense;
  }

  /**
   * 获取验证循环实例。
   * @type {VerificationLoop}
   */
  get verificationLoop() {
    return this._verificationLoop;
  }

  // ── ProgressiveDisclosureOrchestrator 便捷方法 ─────────────────────────────

  /**
   * 注册阶段转换规则。
   * @param {string} fromPhase - 源阶段名称
   * @param {string} toPhase - 目标阶段名称
   * @param {Function} transitionFn - 转换函数
   */
  registerPhaseTransition(fromPhase, toPhase, transitionFn) {
    this._progressiveDisclosure.registerPhaseTransition(fromPhase, toPhase, transitionFn);
  }

  /**
   * 阶段转换回调。
   * @param {string} fromPhase - 源阶段
   * @param {string} toPhase - 目标阶段
   * @param {Object} context - 当前上下文
   * @returns {{ keep: Array, compress: Array, discard: Array }} 转换结果
   */
  onPhaseTransition(fromPhase, toPhase, context) {
    return this._progressiveDisclosure.onPhaseTransition(fromPhase, toPhase, context);
  }

  /**
   * 获取上下文披露计划。
   * @param {string} phase - 目标阶段
   * @param {number} tokenBudget - 令牌预算
   * @returns {Object} 披露计划
   */
  getDisclosurePlan(phase, tokenBudget) {
    return this._progressiveDisclosure.getDisclosurePlan(phase, tokenBudget);
  }

  /**
   * 关联技能路由器。
   * @param {Object} skillRouter - 技能路由器实例
   */
  linkSkillRouter(skillRouter) {
    this._progressiveDisclosure.linkSkillRouter(skillRouter);
  }

  /**
   * 关联令牌管理器。
   * @param {Object} tokenManager - 令牌管理器实例
   */
  linkTokenManager(tokenManager) {
    this._progressiveDisclosure.linkTokenManager(tokenManager);
  }

  // ── TripleDefenseCoordinator 便捷方法 ──────────────────────────────────────

  /**
   * 注册约束规则。
   * @param {string} ruleName - 规则名称
   * @param {Object} layers - 三层约束定义
   */
  registerConstraint(ruleName, layers) {
    this._tripleDefense.registerConstraint(ruleName, layers);
  }

  /**
   * 检查约束覆盖情况。
   * @returns {Object} 覆盖报告
   */
  checkCoverage() {
    return this._tripleDefense.checkCoverage();
  }

  /**
   * 执行三层约束。
   * @param {string} ruleName - 规则名称
   * @param {Object} context - 执行上下文
   * @returns {Object} 执行结果
   */
  enforce(ruleName, context) {
    return this._tripleDefense.enforce(ruleName, context);
  }

  /**
   * 报告约束违反。
   * @param {string} ruleName - 规则名称
   * @param {string} layer - 违反层面
   * @param {Object} details - 违反详情
   */
  reportViolation(ruleName, layer, details) {
    this._tripleDefense.reportViolation(ruleName, layer, details);
  }

  /**
   * 获取约束报告。
   * @returns {Object} 约束报告
   */
  getConstraintReport() {
    return this._tripleDefense.getConstraintReport();
  }

  // ── VerificationLoop 便捷方法 ──────────────────────────────────────────────

  /**
   * 注册前置验证器。
   * @param {string} name - 验证器名称
   * @param {Function} validatorFn - 验证函数
   */
  registerPreValidator(name, validatorFn) {
    this._verificationLoop.registerPreValidator(name, validatorFn);
  }

  /**
   * 注册后置验证器。
   * @param {string} name - 验证器名称
   * @param {Function} validatorFn - 验证函数
   */
  registerPostValidator(name, validatorFn) {
    this._verificationLoop.registerPostValidator(name, validatorFn);
  }

  /**
   * 执行验证循环。
   * @param {Function} taskFn - 任务执行函数
   * @param {Object} context - 执行上下文
   * @returns {Promise<Object>} 执行结果
   */
  async execute(taskFn, context) {
    return this._verificationLoop.execute(taskFn, context);
  }

  /**
   * 运行前置验证。
   * @param {Object} context - 执行上下文
   * @returns {{ passed: boolean, failures: Array }} 验证结果
   */
  validateInputs(context) {
    return this._verificationLoop.validateInputs(context);
  }

  /**
   * 运行后置验证。
   * @param {*} result - 任务执行结果
   * @param {Object} context - 执行上下文
   * @returns {{ passed: boolean, failures: Array }} 验证结果
   */
  validateOutputs(result, context) {
    return this._verificationLoop.validateOutputs(result, context);
  }

  // ── 内部方法 ───────────────────────────────────────────────────────────────

  /**
   * 转发子组件事件到主实例。
   * @private
   */
  _forwardEvents() {
    const forward = (emitter, events) => {
      for (const event of events) {
        emitter.on(event, (...args) => {
          safeCall(() => this.emit(event, ...args), 'HarnessEngineering', `forward:${event}`);
        });
      }
    };

    forward(this._progressiveDisclosure, ['phase-transition', 'disclosure-plan-updated', 'context-discarded']);
    forward(this._tripleDefense, ['constraint-violated', 'coverage-gap-detected', 'constraint-strengthened']);
    forward(this._verificationLoop, [
      'pre-validation-passed', 'pre-validation-failed',
      'post-validation-passed', 'post-validation-failed',
      'repair-attempted',
    ]);
  }

  /**
   * 优雅关闭回调，由withShutdown混入在关闭时自动调用。
   * @private
   */
  _onShutdown() {
    this._progressiveDisclosure.removeAllListeners();
    this._tripleDefense.removeAllListeners();
    this._verificationLoop.removeAllListeners();
    this.removeAllListeners();
  }
}

// ─── 静态属性 ──────────────────────────────────────────────────────────────────

HarnessEngineering.ProgressiveDisclosureOrchestrator = ProgressiveDisclosureOrchestrator;
HarnessEngineering.TripleDefenseCoordinator = TripleDefenseCoordinator;
HarnessEngineering.VerificationLoop = VerificationLoop;

HarnessEngineering.DEFAULT_PHASES = DEFAULT_PHASES;
HarnessEngineering.DEFAULT_MAX_REPAIR_ITERATIONS = DEFAULT_MAX_REPAIR_ITERATIONS;
HarnessEngineering.SOFT_VIOLATION_THRESHOLD = SOFT_VIOLATION_THRESHOLD;

module.exports = withShutdown(HarnessEngineering);
