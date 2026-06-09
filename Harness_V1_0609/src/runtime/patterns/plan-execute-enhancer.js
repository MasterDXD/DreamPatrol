'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const { shortId, timestampId } = require('../../utils/unique-id');

// ─── 常量 ──────────────────────────────────────────────────────────────────────

const DEFAULT_PLANNING_HORIZON = 3;
const DEFAULT_MAX_REPLAN_COUNT = 5;
const DEFAULT_COMPLETENESS_THRESHOLD = 0.8;
const MAX_OUTCOMES_SIZE = 1000;

/**
 * 步骤优先级枚举
 * @readonly
 * @enum {string}
 */
const PRIORITY = {
  P0_CORE: 'P0',
  P1_IMPORTANT: 'P1',
  P2_OPTIONAL: 'P2',
};

/**
 * 步骤状态枚举
 * @readonly
 * @enum {string}
 */
const STEP_STATUS = {
  PLANNED: 'planned',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

// ─── RollingPlanner ────────────────────────────────────────────────────────────

/**
 * @classdesc 滚动规划器 — 小步规划+快速执行模式。
 * 每次仅规划前方N步（planningHorizon），执行完一步后立即滚动规划下一批，
 * 避免长程规划的不确定性，同时通过失败重规划机制应对执行偏差。
 *
 * @extends EventEmitter
 * @emits 'batch-planned' 新批次步骤规划完成时触发
 * @emits 'step-completed' 步骤执行完成时触发
 * @emits 'replan-triggered' 失败触发重新规划时触发
 */
class RollingPlanner extends EventEmitter {
  /**
   * 创建 RollingPlanner 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.planningHorizon=3] - 每次规划的前瞻步数
   * @param {number} [options.maxReplanCount=5] - 最大重规划次数
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._planningHorizon = typeof opts.planningHorizon === 'number'
      && Number.isFinite(opts.planningHorizon) && opts.planningHorizon > 0
      ? opts.planningHorizon
      : DEFAULT_PLANNING_HORIZON;
    this._maxReplanCount = typeof opts.maxReplanCount === 'number'
      && Number.isFinite(opts.maxReplanCount) && opts.maxReplanCount > 0
      ? opts.maxReplanCount
      : DEFAULT_MAX_REPLAN_COUNT;
    /** @type {Array<Object>} 当前已规划但未执行的步骤 */
    this._plannedSteps = [];
    /** @type {Array<Object>} 已执行完成的步骤记录 */
    this._executedSteps = [];
    /** @type {Array<string>} 剩余目标列表 */
    this._remainingObjectives = [];
    /** @type {number} 当前重规划次数 */
    this._replanCount = 0;
    /** @type {Object|null} 当前执行上下文 */
    this._context = null;
  }

  /**
   * 获取前瞻步数。
   * @type {number}
   */
  get planningHorizon() {
    return this._planningHorizon;
  }

  /**
   * 获取最大重规划次数。
   * @type {number}
   */
  get maxReplanCount() {
    return this._maxReplanCount;
  }

  /**
   * 规划下一批步骤。基于当前上下文和剩余目标，生成 planningHorizon 个步骤。
   * @param {Object} context - 当前执行上下文，包含已完成步骤和状态信息
   * @param {Array<string>} [context.remainingObjectives] - 剩余目标列表
   * @param {Array<Object>} [context.executedSteps] - 已执行步骤历史
   * @returns {Promise<{ steps: Array<{id: string, description: string, priority: string, resources: Array}>, remainingObjectives: Array<string> }>} 规划结果
   */
  async planNextBatch(context) {
    try {
      this._context = context ?? {};
      const objectives = Array.isArray(context?.remainingObjectives)
        ? [...context.remainingObjectives]
        : [];
      this._remainingObjectives = objectives;

      const executedHistory = Array.isArray(context?.executedSteps)
        ? context.executedSteps
        : this._executedSteps;

      const steps = [];
      const batchSize = Math.min(this._planningHorizon, objectives.length);

      for (let i = 0; i < batchSize; i++) {
        const objective = objectives[i];
        const step = {
          id: shortId('step-'),
          description: objective,
          priority: i === 0 ? PRIORITY.P0_CORE : (i === 1 ? PRIORITY.P1_IMPORTANT : PRIORITY.P2_OPTIONAL),
          resources: [],
        };
        steps.push(step);
      }

      this._plannedSteps = steps;
      const remainingObjectives = objectives.slice(batchSize);

      this.emit('batch-planned', {
        steps,
        remainingObjectives,
        executedCount: executedHistory.length,
        replanCount: this._replanCount,
      });

      return { steps, remainingObjectives };
    } catch (err) {
      debug('RollingPlanner', 'planNextBatch', err);
      this.emit('batch-planned', { steps: [], remainingObjectives: [], error: err.message });
      return { steps: [], remainingObjectives: [] };
    }
  }

  /**
   * 步骤执行完成回调。更新上下文，为下一轮滚动规划做准备。
   * @param {Object} stepResult - 步骤执行结果
   * @param {string} stepResult.stepId - 步骤ID
   * @param {string} stepResult.status - 步骤状态
   * @param {*} [stepResult.output] - 步骤输出
   * @returns {Promise<void>}
   */
  async onStepCompleted(stepResult) {
    try {
      const result = stepResult ?? {};
      this._executedSteps.push({
        stepId: result.stepId,
        status: result.status || STEP_STATUS.COMPLETED,
        output: result.output,
        completedAt: new Date().toISOString(),
      });

      // 从已规划步骤中移除已完成的步骤
      this._plannedSteps = this._plannedSteps.filter(s => s.id !== result.stepId);

      this.emit('step-completed', {
        stepId: result.stepId,
        status: result.status || STEP_STATUS.COMPLETED,
        plannedRemaining: this._plannedSteps.length,
        executedTotal: this._executedSteps.length,
      });
    } catch (err) {
      debug('RollingPlanner', 'onStepCompleted', err);
    }
  }

  /**
   * 失败时重新规划。基于失败步骤、失败原因和执行历史，生成新的规划批次。
   * 超过最大重规划次数时返回空步骤列表。
   * @param {Object} failedStep - 失败的步骤
   * @param {string} failedStep.id - 步骤ID
   * @param {string} failedStep.description - 步骤描述
   * @param {string} failureReason - 失败原因
   * @param {Array<Object>} executionHistory - 执行历史记录
   * @returns {Promise<{ steps: Array, remainingObjectives: Array<string>, replanCount: number }>} 重规划结果
   */
  async replanOnFailure(failedStep, failureReason, executionHistory) {
    try {
      this._replanCount++;

      if (this._replanCount > this._maxReplanCount) {
        this.emit('replan-triggered', {
          reason: failureReason,
          failedStep,
          replanCount: this._replanCount,
          exhausted: true,
        });
        return { steps: [], remainingObjectives: this._remainingObjectives, replanCount: this._replanCount };
      }

      const _history = Array.isArray(executionHistory) ? executionHistory : this._executedSteps;

      // 将失败步骤重新加入剩余目标，并附加失败原因以避免重复错误
      const revisedObjective = `${failedStep?.description || '未知步骤'}（重试，注意: ${failureReason}）`;
      const newObjectives = [revisedObjective, ...this._remainingObjectives];

      const steps = [];
      const batchSize = Math.min(this._planningHorizon, newObjectives.length);

      for (let i = 0; i < batchSize; i++) {
        steps.push({
          id: shortId('step-'),
          description: newObjectives[i],
          priority: i === 0 ? PRIORITY.P0_CORE : PRIORITY.P1_IMPORTANT,
          resources: [],
          isReplan: true,
          previousFailure: i === 0 ? failureReason : null,
        });
      }

      this._plannedSteps = steps;
      this._remainingObjectives = newObjectives.slice(batchSize);

      this.emit('replan-triggered', {
        reason: failureReason,
        failedStep,
        replanCount: this._replanCount,
        newSteps: steps,
        exhausted: false,
      });

      return { steps, remainingObjectives: this._remainingObjectives, replanCount: this._replanCount };
    } catch (err) {
      debug('RollingPlanner', 'replanOnFailure', err);
      return { steps: [], remainingObjectives: this._remainingObjectives, replanCount: this._replanCount, _error: err.message || String(err) };
    }
  }

  /**
   * 获取当前规划状态。
   * @returns {{ plannedSteps: Array, executedSteps: Array, remainingObjectives: Array<string>, replanCount: number }} 规划状态快照
   */
  getPlanStatus() {
    return {
      plannedSteps: [...this._plannedSteps],
      executedSteps: [...this._executedSteps],
      remainingObjectives: [...this._remainingObjectives],
      replanCount: this._replanCount,
    };
  }
}

// ─── RequirementBoundary ───────────────────────────────────────────────────────

/**
 * @classdesc 需求边界锁 — 需求解析与边界锁定。
 * 将原始输入解析为结构化需求，支持显式定义范围内外边界，
 * 边界锁定后不可修改，确保执行过程不会偏离需求范围。
 * 完整性评估低于阈值时自动触发澄清请求。
 *
 * @extends EventEmitter
 * @emits 'boundary-defined' 边界定义完成时触发
 * @emits 'boundary-locked' 边界锁定时触发
 * @emits 'clarification-needed' 需求完整性不足需要澄清时触发
 */
class RequirementBoundary extends EventEmitter {
  /**
   * 创建 RequirementBoundary 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.completenessThreshold=0.8] - 需求完整性阈值，低于此值触发澄清
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._completenessThreshold = typeof opts.completenessThreshold === 'number'
      && Number.isFinite(opts.completenessThreshold)
      && opts.completenessThreshold >= 0 && opts.completenessThreshold <= 1
      ? opts.completenessThreshold
      : DEFAULT_COMPLETENESS_THRESHOLD;
    /** @type {Map<string, Object>} 边界定义映射 */
    this._boundaries = new Map();
    /** @type {Set<string>} 已锁定的边界ID集合 */
    this._lockedBoundaries = new Set();
  }

  /**
   * 获取完整性阈值。
   * @type {number}
   */
  get completenessThreshold() {
    return this._completenessThreshold;
  }

  /**
   * 解析原始输入为结构化需求。
   * 提取目标、约束和关键实体，生成初始需求对象。
   * @param {string|Object} rawInput - 原始输入，可以是字符串或对象
   * @returns {Promise<{ requirements: Array<{id: string, description: string, type: string}>, rawInput: *, parsedAt: string }>} 解析结果
   */
  async parseRequirements(rawInput) {
    try {
      const input = rawInput ?? '';
      const requirements = [];

      if (typeof input === 'string' && input.length > 0) {
        // 按句子/分号分割提取需求条目
        const segments = input.split(/[。；\n.;]/).filter(s => s.trim().length > 0);
        for (const segment of segments) {
          requirements.push({
            id: shortId('req-'),
            description: segment.trim(),
            type: 'functional',
          });
        }
      } else if (typeof input === 'object' && input !== null) {
        const keys = Object.keys(input);
        for (const key of keys) {
          requirements.push({
            id: shortId('req-'),
            description: `${key}: ${String(input[key])}`,
            type: 'structural',
          });
        }
      }

      return {
        requirements,
        rawInput: input,
        parsedAt: new Date().toISOString(),
      };
    } catch (err) {
      debug('RequirementBoundary', 'parseRequirements', err);
      return { requirements: [], rawInput, parsedAt: new Date().toISOString(), _error: err.message || String(err) };
    }
  }

  /**
   * 定义需求边界，明确范围内外内容。
   * @param {string} objective - 目标描述
   * @param {Array<string>} inclusions - 范围内条目列表
   * @param {Array<string>} exclusions - 范围外条目列表
   * @returns {{ boundaryId: string, objective: string, inclusions: Array<string>, exclusions: Array<string>, definedAt: string }} 边界定义对象
   * @throws {TypeError} objective 非字符串时抛出
   */
  defineBoundary(objective, inclusions, exclusions) {
    if (typeof objective !== 'string' || !objective) {
      throw new TypeError('objective 必须是非空字符串');
    }

    const boundaryId = shortId('bnd-');
    const boundary = {
      boundaryId,
      objective,
      inclusions: Array.isArray(inclusions) ? [...inclusions] : [],
      exclusions: Array.isArray(exclusions) ? [...exclusions] : [],
      definedAt: new Date().toISOString(),
    };

    this._boundaries.set(boundaryId, boundary);

    this.emit('boundary-defined', {
      boundaryId,
      objective,
      inclusionCount: boundary.inclusions.length,
      exclusionCount: boundary.exclusions.length,
    });

    return boundary;
  }

  /**
   * 锁定边界，锁定后不可修改。
   * @param {string} boundaryId - 边界ID
   * @returns {Object|null} 锁定的边界对象，边界不存在时返回null
   */
  lockBoundary(boundaryId) {
    const boundary = this._boundaries.get(boundaryId);
    if (!boundary) return null;

    this._lockedBoundaries.add(boundaryId);
    const lockedBoundary = { ...boundary, locked: true, lockedAt: new Date().toISOString() };
    this._boundaries.set(boundaryId, lockedBoundary);

    this.emit('boundary-locked', {
      boundaryId,
      objective: boundary.objective,
      lockedAt: lockedBoundary.lockedAt,
    });

    return lockedBoundary;
  }

  /**
   * 检查边界是否已锁定。
   * @param {string} boundaryId - 边界ID
   * @returns {boolean} 是否已锁定
   */
  isLocked(boundaryId) {
    return this._lockedBoundaries.has(boundaryId);
  }

  /**
   * 评估需求完整性。低于阈值时触发澄清请求事件。
   * @param {Array<{id: string, description: string, type: string}>} requirements - 需求列表
   * @returns {{ score: number, needsClarification: boolean, clarificationPrompts: Array<string> }} 完整性评估结果
   */
  assessCompleteness(requirements) {
    try {
      const reqs = Array.isArray(requirements) ? requirements : [];
      if (reqs.length === 0) {
        const prompts = ['请提供更多关于目标的具体描述', '请说明期望的输出或结果'];
        this.emit('clarification-needed', { score: 0, prompts });
        return { score: 0, needsClarification: true, clarificationPrompts: prompts };
      }

      // 基于启发式规则评估完整性
      let score = 0;
      const hasFunctional = reqs.some(r => r.type === 'functional');
      const hasStructural = reqs.some(r => r.type === 'structural');
      const avgLength = reqs.reduce((sum, r) => sum + (r.description?.length ?? 0), 0) / reqs.length;

      // 需求数量贡献
      score += Math.min(0.3, reqs.length * 0.1);
      // 类型多样性贡献
      if (hasFunctional) score += 0.2;
      if (hasStructural) score += 0.15;
      // 描述详细度贡献
      score += Math.min(0.35, avgLength / 100);

      score = Math.min(1, Math.max(0, score));

      const needsClarification = score < this._completenessThreshold;
      const clarificationPrompts = [];

      if (needsClarification) {
        if (!hasFunctional) clarificationPrompts.push('请描述具体的功能需求');
        if (!hasStructural) clarificationPrompts.push('请说明结构或技术约束');
        if (avgLength < 20) clarificationPrompts.push('请提供更详细的需求描述');
        if (reqs.length < 2) clarificationPrompts.push('请补充更多需求条目');

        this.emit('clarification-needed', { score, prompts: clarificationPrompts });
      }

      return { score, needsClarification, clarificationPrompts };
    } catch (err) {
      debug('RequirementBoundary', 'assessCompleteness', err);
      return { score: 0, needsClarification: true, clarificationPrompts: ['评估过程异常，请重新描述需求'], _error: err.message || String(err) };
    }
  }

  /**
   * 获取边界定义。
   * @param {string} boundaryId - 边界ID
   * @returns {Object|undefined} 边界定义对象
   */
  getBoundary(boundaryId) {
    return this._boundaries.get(boundaryId);
  }
}

// ─── PlanSchema ────────────────────────────────────────────────────────────────

/**
 * @classdesc 规划模板固化 — 标准化规划输出格式。
 * 提供工厂方法创建标准化的计划对象和步骤对象，
 * 支持计划验证和从工作流模板实例化计划。
 * 所有计划遵循统一的 schema，确保规划输出的一致性和可验证性。
 */
class PlanSchema {
  /**
   * 创建标准化计划对象。
   * @param {Object} params - 计划参数
   * @param {string} params.objective - 计划目标
   * @param {Object} [params.boundaries] - 边界定义
   * @param {Array<string>} [params.boundaries.inclusions] - 范围内条目
   * @param {Array<string>} [params.boundaries.exclusions] - 范围外条目
   * @param {Array<Object>} [params.steps] - 步骤列表
   * @param {Array<Object>} [params.risks] - 风险列表
   * @param {Array<Object>} [params.resources] - 资源列表
   * @param {Array<string>} [params.successCriteria] - 成功标准
   * @returns {Object} 标准化计划对象
   */
  static createPlan(params) {
    const p = params ?? {};
    return {
      planId: timestampId('plan-'),
      objective: p.objective || '',
      boundaries: {
        inclusions: Array.isArray(p.boundaries?.inclusions) ? [...p.boundaries.inclusions] : [],
        exclusions: Array.isArray(p.boundaries?.exclusions) ? [...p.boundaries.exclusions] : [],
      },
      steps: Array.isArray(p.steps) ? p.steps.map(s => PlanSchema.createStep(s)) : [],
      risks: Array.isArray(p.risks)
        ? p.risks.map(r => ({
          description: r.description || '',
          severity: r.severity || 'medium',
          mitigation: r.mitigation || '',
        }))
        : [],
      resources: Array.isArray(p.resources)
        ? p.resources.map(r => ({
          type: r.type || 'generic',
          name: r.name || '',
          required: r.required !== false,
        }))
        : [],
      successCriteria: Array.isArray(p.successCriteria) ? [...p.successCriteria] : [],
      createdAt: new Date().toISOString(),
      version: '1.0.0',
    };
  }

  /**
   * 创建标准化步骤对象。
   * @param {Object} params - 步骤参数
   * @param {string} [params.id] - 步骤ID，自动生成如果未提供
   * @param {string} [params.description] - 步骤描述
   * @param {string} [params.priority] - 优先级（P0/P1/P2）
   * @param {Array} [params.resources] - 所需资源列表
   * @param {boolean} [params.requiresHumanApproval] - 是否需要人工审批
   * @returns {Object} 标准化步骤对象
   */
  static createStep(params) {
    const p = params ?? {};
    const validPriorities = [PRIORITY.P0_CORE, PRIORITY.P1_IMPORTANT, PRIORITY.P2_OPTIONAL];
    return {
      id: p.id || shortId('step-'),
      description: p.description || '',
      priority: validPriorities.includes(p.priority) ? p.priority : PRIORITY.P1_IMPORTANT,
      resources: Array.isArray(p.resources) ? [...p.resources] : [],
      requiresHumanApproval: p.requiresHumanApproval === true,
      status: STEP_STATUS.PLANNED,
    };
  }

  /**
   * 验证计划是否符合标准 schema。
   * @param {Object} plan - 待验证的计划对象
   * @returns {{ valid: boolean, errors: Array<string> }} 验证结果
   */
  static validatePlan(plan) {
    const errors = [];

    if (!plan || typeof plan !== 'object') {
      return { valid: false, errors: ['计划必须是非空对象'] };
    }

    PlanSchema._validateTopLevel(plan, errors);
    PlanSchema._validateBoundaries(plan.boundaries, errors);
    PlanSchema._validateSteps(plan.steps, errors);
    PlanSchema._validateArrays(plan, errors);

    return { valid: errors.length === 0, errors };
  }

  /** @private 验证顶层字段 */
  static _validateTopLevel(plan, errors) {
    if (typeof plan.planId !== 'string' || !plan.planId) {
      errors.push('计划缺少有效的 planId');
    }
    if (typeof plan.objective !== 'string' || !plan.objective) {
      errors.push('计划缺少有效的 objective');
    }
  }

  /** @private 验证边界定义 */
  static _validateBoundaries(boundaries, errors) {
    if (!boundaries || typeof boundaries !== 'object') {
      errors.push('计划缺少 boundaries 定义');
      return;
    }
    if (!Array.isArray(boundaries.inclusions)) {
      errors.push('boundaries.inclusions 必须是数组');
    }
    if (!Array.isArray(boundaries.exclusions)) {
      errors.push('boundaries.exclusions 必须是数组');
    }
  }

  /** @private 验证步骤数组 */
  static _validateSteps(steps, errors) {
    if (!Array.isArray(steps)) {
      errors.push('计划缺少 steps 数组');
      return;
    }
    const validPriorities = [PRIORITY.P0_CORE, PRIORITY.P1_IMPORTANT, PRIORITY.P2_OPTIONAL];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || typeof step !== 'object') {
        errors.push(`steps[${i}] 必须是对象`);
        continue;
      }
      if (typeof step.id !== 'string' || !step.id) {
        errors.push(`steps[${i}] 缺少有效的 id`);
      }
      if (typeof step.description !== 'string' || !step.description) {
        errors.push(`steps[${i}] 缺少有效的 description`);
      }
      if (!validPriorities.includes(step.priority)) {
        errors.push(`steps[${i}] 的 priority 必须是 P0/P1/P2 之一`);
      }
    }
  }

  /** @private 验证数组字段 */
  static _validateArrays(plan, errors) {
    if (!Array.isArray(plan.risks)) {
      errors.push('计划缺少 risks 数组');
    }
    if (!Array.isArray(plan.resources)) {
      errors.push('计划缺少 resources 数组');
    }
    if (!Array.isArray(plan.successCriteria)) {
      errors.push('计划缺少 successCriteria 数组');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 从工作流模板实例化计划。
   * 将模板中的占位符替换为实际变量值。
   * @param {Object} template - 工作流模板
   * @param {Object} variables - 模板变量映射
   * @returns {Object} 实例化后的计划对象
   */
  static createFromTemplate(template, variables) {
    const tmpl = template ?? {};
    const vars = variables ?? {};

    const replaceVars = (str) => {
      if (typeof str !== 'string') return str;
      let result = str;
      for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
      }
      return result;
    };

    const objective = replaceVars(tmpl.objective || '');

    const steps = Array.isArray(tmpl.steps)
      ? tmpl.steps.map(s => PlanSchema.createStep({
        id: s.id || undefined,
        description: replaceVars(s.description || ''),
        priority: s.priority,
        resources: s.resources,
        requiresHumanApproval: s.requiresHumanApproval,
      }))
      : [];

    const risks = Array.isArray(tmpl.risks)
      ? tmpl.risks.map(r => ({
        description: replaceVars(r.description || ''),
        severity: r.severity || 'medium',
        mitigation: replaceVars(r.mitigation || ''),
      }))
      : [];

    return PlanSchema.createPlan({
      objective,
      boundaries: tmpl.boundaries,
      steps,
      risks,
      resources: tmpl.resources,
      successCriteria: Array.isArray(tmpl.successCriteria)
        ? tmpl.successCriteria.map(c => replaceVars(c))
        : [],
    });
  }
}

// ─── PlanMemoryBridge ──────────────────────────────────────────────────────────

/**
 * @classdesc 规划记忆桥 — 长期记忆反馈机制。
 * 记录计划执行结果，提取规划模式，为相似任务推荐已验证的计划模板，
 * 形成"执行→反馈→模板化→复用"的闭环，持续优化规划质量。
 *
 * @extends EventEmitter
 * @emits 'outcome-recorded' 执行结果记录时触发
 * @emits 'pattern-extracted' 规划模式提取时触发
 * @emits 'template-registered' 模板注册时触发
 */
class PlanMemoryBridge extends EventEmitter {
  /**
   * 创建 PlanMemoryBridge 实例。
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.brainMemory] - 可选的大脑记忆引用，用于持久化存储
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    /** @type {Object|null} 大脑记忆引用 */
    this._brainMemory = opts.brainMemory || null;
    /** @type {Array<Object>} 执行结果记录（有界，最大1000条） */
    this._outcomes = [];
    /** @type {Map<string, Object>} 任务类型→计划模板映射 */
    this._templates = new Map();
  }

  /**
   * 获取大脑记忆引用。
   * @type {Object|null}
   */
  get brainMemory() {
    return this._brainMemory;
  }

  /**
   * 记录计划执行结果。
   * @param {string} planId - 计划ID
   * @param {Object} outcome - 执行结果
   * @param {boolean} [outcome.success] - 是否成功
   * @param {Array<Object>} [outcome.stepResults] - 各步骤执行结果
   * @param {string} [outcome.taskType] - 任务类型
   * @param {string} [outcome.failureReason] - 失败原因（如失败）
   * @returns {void}
   */
  recordExecutionOutcome(planId, outcome) {
    try {
      const record = {
        planId,
        success: outcome?.success === true,
        stepResults: Array.isArray(outcome?.stepResults) ? [...outcome.stepResults] : [],
        taskType: outcome?.taskType || 'unknown',
        failureReason: outcome?.failureReason || null,
        recordedAt: new Date().toISOString(),
      };

      this._outcomes.push(record);

      // 有界裁剪
      if (this._outcomes.length > MAX_OUTCOMES_SIZE) {
        this._outcomes = this._outcomes.slice(-MAX_OUTCOMES_SIZE);
      }

      // 如果有大脑记忆引用，同步存储
      if (this._brainMemory && typeof this._brainMemory.store === 'function') {
        safeCall(
          () => this._brainMemory.store(`plan-outcome:${planId}`, record),
          'PlanMemoryBridge',
          'recordExecutionOutcome:brainMemory',
        );
      }

      this.emit('outcome-recorded', {
        planId,
        success: record.success,
        taskType: record.taskType,
      });
    } catch (err) {
      debug('PlanMemoryBridge', 'recordExecutionOutcome', err);
    }
  }

  /**
   * 提取指定任务类型的规划模式。
   * 从历史执行结果中分析成功和失败模式，生成规划建议。
   * @param {string} taskType - 任务类型
   * @returns {Promise<{ taskType: string, successRate: number, commonSteps: Array, failurePatterns: Array, recommendation: string }>} 规划模式
   */
  async extractPlanningPatterns(taskType) {
    try {
      const typeOutcomes = this._outcomes.filter(o => o.taskType === taskType);

      if (typeOutcomes.length === 0) {
        this.emit('pattern-extracted', { taskType, patternCount: 0 });
        return {
          taskType,
          successRate: 0,
          commonSteps: [],
          failurePatterns: [],
          recommendation: `暂无任务类型 "${taskType}" 的历史执行记录`,
        };
      }

      const successCount = typeOutcomes.filter(o => o.success).length;
      const successRate = successCount / typeOutcomes.length;

      // 提取成功计划中的常见步骤描述
      const stepDescriptions = new Map();
      for (const outcome of typeOutcomes) {
        if (!outcome.success) continue;
        for (const step of outcome.stepResults) {
          if (step && step.description) {
            const count = stepDescriptions.get(step.description) ?? 0;
            stepDescriptions.set(step.description, count + 1);
          }
        }
      }

      const commonSteps = [...stepDescriptions.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([description, count]) => ({ description, frequency: count }));

      // 提取失败模式
      const failurePatterns = [];
      for (const outcome of typeOutcomes) {
        if (outcome.success || !outcome.failureReason) continue;
        const existing = failurePatterns.find(f => f.reason === outcome.failureReason);
        if (existing) {
          existing.count++;
        } else {
          failurePatterns.push({ reason: outcome.failureReason, count: 1 });
        }
      }
      failurePatterns.sort((a, b) => b.count - a.count);

      const recommendation = successRate >= 0.8
        ? `任务类型 "${taskType}" 历史成功率较高，建议复用已有模板`
        : successRate >= 0.5
          ? `任务类型 "${taskType}" 成功率一般，建议关注常见失败模式并调整规划`
          : `任务类型 "${taskType}" 成功率较低，建议重新设计规划策略`;

      this.emit('pattern-extracted', {
        taskType,
        patternCount: typeOutcomes.length,
        successRate,
      });

      return { taskType, successRate, commonSteps, failurePatterns, recommendation };
    } catch (err) {
      debug('PlanMemoryBridge', 'extractPlanningPatterns', err);
      return {
        taskType,
        successRate: 0,
        commonSteps: [],
        failurePatterns: [],
        recommendation: `模式提取异常: ${err.message}`,
      };
    }
  }

  /**
   * 获取推荐计划模板。基于相似历史任务的成功率推荐最佳模板。
   * @param {string} taskType - 任务类型
   * @param {string} objective - 目标描述
   * @returns {Promise<Object|null>} 推荐的计划模板，无匹配时返回null
   */
  async getRecommendedPlan(taskType, objective) {
    try {
      const template = this._templates.get(taskType);
      if (!template) {
        return null;
      }

      // 如果有历史记录，验证模板的推荐度
      const typeOutcomes = this._outcomes.filter(o => o.taskType === taskType);
      const successRate = typeOutcomes.length > 0
        ? typeOutcomes.filter(o => o.success).length / typeOutcomes.length
        : 0;

      return {
        taskType,
        template,
        confidence: successRate,
        historicalCount: typeOutcomes.length,
        objective,
      };
    } catch (err) {
      debug('PlanMemoryBridge', 'getRecommendedPlan', err);
      return { _error: err.message || String(err) };
    }
  }

  /**
   * 注册已验证的计划模板。
   * @param {string} taskType - 任务类型
   * @param {Object} planTemplate - 计划模板
   * @param {string} [planTemplate.objective] - 模板目标
   * @param {Array} [planTemplate.steps] - 模板步骤
   * @param {Array} [planTemplate.risks] - 模板风险
   * @param {Array} [planTemplate.resources] - 模板资源
   * @param {Array} [planTemplate.successCriteria] - 成功标准
   * @returns {void}
   */
  registerPlanTemplate(taskType, planTemplate) {
    try {
      if (typeof taskType !== 'string' || !taskType) {
        throw new TypeError('taskType 必须是非空字符串');
      }

      const template = {
        taskType,
        objective: planTemplate?.objective || '',
        steps: Array.isArray(planTemplate?.steps) ? [...planTemplate.steps] : [],
        risks: Array.isArray(planTemplate?.risks) ? [...planTemplate.risks] : [],
        resources: Array.isArray(planTemplate?.resources) ? [...planTemplate.resources] : [],
        successCriteria: Array.isArray(planTemplate?.successCriteria) ? [...planTemplate.successCriteria] : [],
        registeredAt: new Date().toISOString(),
      };

      this._templates.set(taskType, template);

      this.emit('template-registered', {
        taskType,
        stepCount: template.steps.length,
        registeredAt: template.registeredAt,
      });
    } catch (err) {
      debug('PlanMemoryBridge', 'registerPlanTemplate', err);
    }
  }
}

// ─── PlanExecuteEnhancer ───────────────────────────────────────────────────────

/**
 * @module runtime/patterns/plan-execute-enhancer
 * 先规划后执行双架构增强模块 — 融合4个核心子组件，为规划-执行范式提供
 * 滚动规划、需求边界锁定、规划模板固化和长期记忆反馈能力。
 */

/**
 * @classdesc 先规划后执行双架构增强器。组合四大子组件提供完整的规划-执行增强能力：
 * - RollingPlanner: 小步规划+快速执行的滚动规划器
 * - RequirementBoundary: 需求解析与边界锁定
 * - PlanSchema: 标准化规划输出格式
 * - PlanMemoryBridge: 执行结果与规划模板的长期记忆桥接
 *
 * @extends EventEmitter
 * @mixin withShutdown
 * @emits 'batch-planned' 委托自 RollingPlanner
 * @emits 'step-completed' 委托自 RollingPlanner
 * @emits 'replan-triggered' 委托自 RollingPlanner
 * @emits 'boundary-defined' 委托自 RequirementBoundary
 * @emits 'boundary-locked' 委托自 RequirementBoundary
 * @emits 'clarification-needed' 委托自 RequirementBoundary
 * @emits 'outcome-recorded' 委托自 PlanMemoryBridge
 * @emits 'pattern-extracted' 委托自 PlanMemoryBridge
 * @emits 'template-registered' 委托自 PlanMemoryBridge
 */
class PlanExecuteEnhancer extends EventEmitter {
  /**
   * 创建 PlanExecuteEnhancer 实例。
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.rollingPlanner] - RollingPlanner 配置
   * @param {Object} [options.requirementBoundary] - RequirementBoundary 配置
   * @param {Object} [options.planMemoryBridge] - PlanMemoryBridge 配置
   */
  constructor(options) {
    super();
    const opts = options ?? {};

    this._rollingPlanner = new RollingPlanner(opts.rollingPlanner);
    this._requirementBoundary = new RequirementBoundary(opts.requirementBoundary);
    this._planMemoryBridge = new PlanMemoryBridge(opts.planMemoryBridge);

    this._forwardHandlers = {};

    this._forwardEvents();
  }

  /**
   * 获取滚动规划器实例。
   * @type {RollingPlanner}
   */
  get rollingPlanner() {
    return this._rollingPlanner;
  }

  /**
   * 获取需求边界锁实例。
   * @type {RequirementBoundary}
   */
  get requirementBoundary() {
    return this._requirementBoundary;
  }

  /**
   * 获取规划记忆桥实例。
   * @type {PlanMemoryBridge}
   */
  get planMemoryBridge() {
    return this._planMemoryBridge;
  }

  // ── RollingPlanner 便捷方法 ─────────────────────────────────────────────────

  /**
   * 规划下一批步骤。
   * @param {Object} context - 执行上下文
   * @returns {Promise<{ steps: Array, remainingObjectives: Array<string> }>} 规划结果
   */
  async planNextBatch(context) {
    return this._rollingPlanner.planNextBatch(context);
  }

  /**
   * 步骤执行完成回调。
   * @param {Object} stepResult - 步骤执行结果
   * @returns {Promise<void>}
   */
  async onStepCompleted(stepResult) {
    return this._rollingPlanner.onStepCompleted(stepResult);
  }

  /**
   * 失败时重新规划。
   * @param {Object} failedStep - 失败步骤
   * @param {string} failureReason - 失败原因
   * @param {Array<Object>} executionHistory - 执行历史
   * @returns {Promise<{ steps: Array, remainingObjectives: Array<string>, replanCount: number }>} 重规划结果
   */
  async replanOnFailure(failedStep, failureReason, executionHistory) {
    return this._rollingPlanner.replanOnFailure(failedStep, failureReason, executionHistory);
  }

  /**
   * 获取当前规划状态。
   * @returns {{ plannedSteps: Array, executedSteps: Array, remainingObjectives: Array<string>, replanCount: number }} 规划状态
   */
  getPlanStatus() {
    return this._rollingPlanner.getPlanStatus();
  }

  // ── RequirementBoundary 便捷方法 ────────────────────────────────────────────

  /**
   * 解析原始需求。
   * @param {string|Object} rawInput - 原始输入
   * @returns {Promise<Object>} 解析结果
   */
  async parseRequirements(rawInput) {
    return this._requirementBoundary.parseRequirements(rawInput);
  }

  /**
   * 定义需求边界。
   * @param {string} objective - 目标描述
   * @param {Array<string>} inclusions - 范围内条目
   * @param {Array<string>} exclusions - 范围外条目
   * @returns {Object} 边界定义
   */
  defineBoundary(objective, inclusions, exclusions) {
    return this._requirementBoundary.defineBoundary(objective, inclusions, exclusions);
  }

  /**
   * 锁定边界。
   * @param {string} boundaryId - 边界ID
   * @returns {Object|null} 锁定的边界对象
   */
  lockBoundary(boundaryId) {
    return this._requirementBoundary.lockBoundary(boundaryId);
  }

  /**
   * 检查边界是否已锁定。
   * @param {string} boundaryId - 边界ID
   * @returns {boolean} 是否已锁定
   */
  isBoundaryLocked(boundaryId) {
    return this._requirementBoundary.isLocked(boundaryId);
  }

  /**
   * 评估需求完整性。
   * @param {Array<Object>} requirements - 需求列表
   * @returns {{ score: number, needsClarification: boolean, clarificationPrompts: Array<string> }} 评估结果
   */
  assessCompleteness(requirements) {
    return this._requirementBoundary.assessCompleteness(requirements);
  }

  /**
   * 获取边界定义。
   * @param {string} boundaryId - 边界ID
   * @returns {Object|undefined} 边界定义
   */
  getBoundary(boundaryId) {
    return this._requirementBoundary.getBoundary(boundaryId);
  }

  // ── PlanSchema 便捷方法 ────────────────────────────────────────────────────

  /**
   * 创建标准化计划。
   * @param {Object} params - 计划参数
   * @returns {Object} 标准化计划对象
   */
  createPlan(params) {
    return PlanSchema.createPlan(params);
  }

  /**
   * 创建标准化步骤。
   * @param {Object} params - 步骤参数
   * @returns {Object} 标准化步骤对象
   */
  createStep(params) {
    return PlanSchema.createStep(params);
  }

  /**
   * 验证计划格式。
   * @param {Object} plan - 待验证计划
   * @returns {{ valid: boolean, errors: Array<string> }} 验证结果
   */
  validatePlan(plan) {
    return PlanSchema.validatePlan(plan);
  }

  /**
   * 从模板实例化计划。
   * @param {Object} template - 工作流模板
   * @param {Object} variables - 模板变量
   * @returns {Object} 实例化后的计划
   */
  createFromTemplate(template, variables) {
    return PlanSchema.createFromTemplate(template, variables);
  }

  // ── PlanMemoryBridge 便捷方法 ──────────────────────────────────────────────

  /**
   * 记录执行结果。
   * @param {string} planId - 计划ID
   * @param {Object} outcome - 执行结果
   */
  recordExecutionOutcome(planId, outcome) {
    this._planMemoryBridge.recordExecutionOutcome(planId, outcome);
  }

  /**
   * 提取规划模式。
   * @param {string} taskType - 任务类型
   * @returns {Promise<Object>} 规划模式
   */
  async extractPlanningPatterns(taskType) {
    return this._planMemoryBridge.extractPlanningPatterns(taskType);
  }

  /**
   * 获取推荐计划模板。
   * @param {string} taskType - 任务类型
   * @param {string} objective - 目标描述
   * @returns {Promise<Object|null>} 推荐模板
   */
  async getRecommendedPlan(taskType, objective) {
    return this._planMemoryBridge.getRecommendedPlan(taskType, objective);
  }

  /**
   * 注册计划模板。
   * @param {string} taskType - 任务类型
   * @param {Object} planTemplate - 计划模板
   */
  registerPlanTemplate(taskType, planTemplate) {
    this._planMemoryBridge.registerPlanTemplate(taskType, planTemplate);
  }

  // ── 内部方法 ───────────────────────────────────────────────────────────────

  /**
   * 转发子组件事件到主实例。
   * @private
   */
  _forwardEvents() {
    const forward = (emitter, emitterKey, events) => {
      for (const event of events) {
        const handler = (...args) => {
          safeCall(() => this.emit(event, ...args), 'PlanExecuteEnhancer', `forward:${event}`);
        };
        this._forwardHandlers[emitterKey + ':' + event] = handler;
        emitter.on(event, handler);
      }
    };

    forward(this._rollingPlanner, 'rollingPlanner', ['batch-planned', 'step-completed', 'replan-triggered']);
    forward(this._requirementBoundary, 'requirementBoundary', ['boundary-defined', 'boundary-locked', 'clarification-needed']);
    forward(this._planMemoryBridge, 'planMemoryBridge', ['outcome-recorded', 'pattern-extracted', 'template-registered']);
  }

  /**
   * 优雅关闭回调，由withShutdown混入在关闭时自动调用。
   * @private
   */
  _onShutdown() {
    // 使用保存的处理器引用逐个移除监听器，避免影响子对象上其他监听器
    if (this._forwardHandlers) {
      for (const [key, handler] of Object.entries(this._forwardHandlers)) {
        const [emitterKey, event] = key.split(':');
        let emitter = null;
        if (emitterKey === 'rollingPlanner') emitter = this._rollingPlanner;
        else if (emitterKey === 'requirementBoundary') emitter = this._requirementBoundary;
        else if (emitterKey === 'planMemoryBridge') emitter = this._planMemoryBridge;
        if (emitter) {
          emitter.removeListener(event, handler);
        }
      }
      this._forwardHandlers = {};
    }
    this._rollingPlanner.removeAllListeners();
    this._requirementBoundary.removeAllListeners();
    this._planMemoryBridge.removeAllListeners();
    this.removeAllListeners();
  }
}

// ─── 静态属性 ──────────────────────────────────────────────────────────────────

PlanExecuteEnhancer.RollingPlanner = RollingPlanner;
PlanExecuteEnhancer.RequirementBoundary = RequirementBoundary;
PlanExecuteEnhancer.PlanSchema = PlanSchema;
PlanExecuteEnhancer.PlanMemoryBridge = PlanMemoryBridge;

PlanExecuteEnhancer.PRIORITY = PRIORITY;
PlanExecuteEnhancer.STEP_STATUS = STEP_STATUS;

PlanExecuteEnhancer.DEFAULT_PLANNING_HORIZON = DEFAULT_PLANNING_HORIZON;
PlanExecuteEnhancer.DEFAULT_MAX_REPLAN_COUNT = DEFAULT_MAX_REPLAN_COUNT;
PlanExecuteEnhancer.DEFAULT_COMPLETENESS_THRESHOLD = DEFAULT_COMPLETENESS_THRESHOLD;
PlanExecuteEnhancer.MAX_OUTCOMES_SIZE = MAX_OUTCOMES_SIZE;

module.exports = withShutdown(PlanExecuteEnhancer);
