'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const safeAssign = require('../../utils/safe-assign');
const { mergeConfig } = safeAssign;

const STAGES = ['spec', 'plan', 'design', 'build', 'test', 'review', 'ship'];

const STAGE_INDEX = {};
for (let i = 0; i < STAGES.length; i++) {
  STAGE_INDEX[STAGES[i]] = i;
}

const STAGE_COMMANDS = {
  spec: '/spec',
  plan: '/plan',
  design: '/design',
  build: '/build',
  test: '/test',
  review: '/review',
  ship: '/ship',
};

const ROLLBACK_ALLOWED = {
  review: ['build', 'test'],
  test: ['build'],
  build: ['design', 'plan'],
  design: ['plan'],
  plan: ['spec'],
};

const STAGE_VALIDATORS = {
  spec: function _validateSpec(context) {
    if (!context || typeof context !== 'object') return { valid: false, reason: 'context required' };
    if (!context.requirements && !context.description) return { valid: false, reason: 'requirements or description required' };
    return { valid: true };
  },
  plan: function _validatePlan(context) {
    if (!context || typeof context !== 'object') return { valid: false, reason: 'context required' };
    if (!context.spec && !context.specId) return { valid: false, reason: 'spec reference required' };
    return { valid: true };
  },
  design: function _validateDesign(context) {
    if (!context || typeof context !== 'object') return { valid: false, reason: 'context required' };
    if (!context.plan && !context.planId && !context.modules) return { valid: false, reason: 'plan reference or modules required' };
    return { valid: true };
  },
  build: function _validateBuild(context) {
    if (!context || typeof context !== 'object') return { valid: false, reason: 'context required' };
    if (!context.design && !context.designId && !context.implementation) return { valid: false, reason: 'design reference or implementation required' };
    return { valid: true };
  },
  test: function _validateTest(context) {
    if (!context || typeof context !== 'object') return { valid: false, reason: 'context required' };
    if (!context.build && !context.buildId && !context.tests) return { valid: false, reason: 'build reference or tests required' };
    return { valid: true };
  },
  review: function _validateReview(context) {
    if (!context || typeof context !== 'object') return { valid: false, reason: 'context required' };
    if (!context.code && !context.testResults && !context.reviewTarget) return { valid: false, reason: 'code, testResults or reviewTarget required' };
    return { valid: true };
  },
  ship: function _validateShip(context) {
    if (!context || typeof context !== 'object') return { valid: false, reason: 'context required' };
    if (!context.reviewPassed && !context.approval && !context.releaseReady) return { valid: false, reason: 'reviewPassed, approval or releaseReady required' };
    return { valid: true };
  },
};

const STAGE_EXECUTORS = {
  spec: function _executeSpec(context) {
    return {
      stage: 'spec',
      output: {
        specDocument: context.spec ?? null,
        requirements: context.requirements || (context.description ?? []),
        constraints: context.constraints ?? [],
        createdAt: Date.now(),
      },
    };
  },
  plan: function _executePlan(context) {
    return {
      stage: 'plan',
      output: {
        planDocument: context.plan ?? null,
        tasks: context.tasks ?? [],
        milestones: context.milestones ?? [],
        estimatedEffort: context.estimatedEffort ?? null,
        createdAt: Date.now(),
      },
    };
  },
  design: function _executeDesign(context) {
    return {
      stage: 'design',
      output: {
        designDocument: context.design ?? null,
        modules: context.modules ?? [],
        interfaces: context.interfaces ?? [],
        dataModels: context.dataModels ?? [],
        createdAt: Date.now(),
      },
    };
  },
  build: function _executeBuild(context) {
    return {
      stage: 'build',
      output: {
        implementation: context.implementation ?? null,
        files: context.files ?? [],
        dependencies: context.dependencies ?? [],
        createdAt: Date.now(),
      },
    };
  },
  test: function _executeTest(context) {
    return {
      stage: 'test',
      output: {
        testResults: context.testResults ?? null,
        coverage: context.coverage ?? 0,
        passed: context.passed ?? 0,
        failed: context.failed ?? 0,
        createdAt: Date.now(),
      },
    };
  },
  review: function _executeReview(context) {
    return {
      stage: 'review',
      output: {
        reviewResults: context.reviewResults ?? null,
        issues: context.issues ?? [],
        approved: context.approved ?? false,
        qualityScore: typeof context.qualityScore === 'number' && Number.isFinite(context.qualityScore) ? context.qualityScore : 0,
        createdAt: Date.now(),
      },
    };
  },
  ship: function _executeShip(context) {
    return {
      stage: 'ship',
      output: {
        releaseInfo: context.releaseInfo ?? null,
        version: context.version ?? null,
        changelog: context.changelog ?? [],
        deployedAt: Date.now(),
      },
    };
  },
};

const DEFAULT_CONFIG = {
  strictOrder: true,
  allowRollback: true,
  requireCompletion: true,
};

/**
 * @module runtime/workflow/agent-skills-discipline
 * @classdesc 工程纪律插件（AgentSkillsDiscipline）。规范强制、反模式检测、质量门禁。
 * AgentSkillsDiscipline — Agent技能纪律执行器
 * Enforces strict stage ordering (spec → plan → design → build → test → review → ship) for skill
 * execution with configurable rollback rules. Validates stage transitions, prevents stage skipping
 * in strict mode, and ensures each stage receives the required context before execution. Tracks
 * completed stages, timestamps, and transition logs for full auditability.
 * @extends EventEmitter
 * @emits stage-completed | stage-rejected | stage-validation-failed | discipline-reset
 */
class AgentSkillsDiscipline extends EventEmitter {
  /**
   * @param {Object} [config] - 配置选项
   * @param {boolean} [config.strictOrder=true] - 是否强制阶段顺序
   * @param {boolean} [config.allowRollback=true] - 是否允许阶段回滚
   * @param {boolean} [config.requireCompletion=true] - 是否要求阶段完成才能推进
   */
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._currentStage = null;
    this._completedStages = new Set();
    this._stageResults = new Map();
    this._transitionLog = [];
    this._stageTimestamps = new Map();
  }

  /**
   * 执行技能纪律检查并推进阶段。解析命令对应的阶段，验证阶段转换合法性，
   * 执行阶段验证器和执行器，记录转换日志。
   *
   * @param {string} command - 斜杠命令或阶段名称
   * @param {Object} [context] - 阶段执行上下文
   * @returns {{stage: string|null, status: string, output: Object|null, nextStage: string|null, reason?: string}} 执行结果
   */
  execute(command, context) {
    this.guardShutdown();

    const stage = this._resolveStage(command);
    if (!stage) {
      debug('AgentSkillsDiscipline', 'execute', 'Unknown command: ' + command);
      return { stage: null, status: 'rejected', output: null, nextStage: null, reason: 'unknown command' };
    }

    if (this._currentStage === null && stage !== STAGES[0]) {
      debug('AgentSkillsDiscipline', 'execute', 'Must start with spec stage');
      return { stage, status: 'rejected', output: null, nextStage: null, reason: 'must start with spec' };
    }

    const validation = this._validateStageTransition(this._currentStage, stage);
    if (!validation.allowed) {
      debug('AgentSkillsDiscipline', 'execute', 'Transition rejected: ' + validation.reason);
      return { stage, status: 'rejected', output: null, nextStage: null, reason: validation.reason };
    }

    const result = this._executeStage(stage, context);

    if (result.validationError) {
      this._transitionLog.push({
        from: this._currentStage,
        to: stage,
        timestamp: Date.now(),
        status: 'rejected',
      });
      this.emit('stage-rejected', { stage, reason: result.validationError });
      return { stage, status: 'rejected', output: null, nextStage: null, reason: result.validationError };
    }

    const previousStage = this._currentStage;
    this._currentStage = stage;
    this._completedStages.add(stage);
    this._stageResults.set(stage, result.output);
    this._stageTimestamps.set(stage, Date.now());
    this._transitionLog.push({
      from: previousStage,
      to: stage,
      timestamp: Date.now(),
      status: 'completed',
    });
    if (this._transitionLog.length > 200) {
      this._transitionLog.shift();
    }

    const nextStage = this._getNextStage(stage);

    this.emit('stage-completed', { stage, status: 'completed', output: result.output, nextStage });

    return { stage, status: 'completed', output: result.output, nextStage };
  }

  _resolveStage(command) {
    if (!command || typeof command !== 'string') return null;
    const trimmed = command.trim();
    for (const stage of STAGES) {
      if (trimmed === STAGE_COMMANDS[stage] || trimmed === stage) {
        return stage;
      }
    }
    return null;
  }

  _validateStageTransition(fromStage, toStage) {
    if (toStage === null) {
      return { allowed: false, reason: 'target stage is null' };
    }

    if (fromStage === null) {
      if (toStage === STAGES[0]) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'must start with ' + STAGES[0] };
    }

    if (fromStage === toStage) {
      return { allowed: true };
    }

    const fromIdx = STAGE_INDEX[fromStage];
    const toIdx = STAGE_INDEX[toStage];

    if (fromIdx === undefined || toIdx === undefined) {
      return { allowed: false, reason: 'invalid stage' };
    }

    if (toIdx > fromIdx) {
      if (this._config.strictOrder && this._config.requireCompletion) {
        for (let i = fromIdx; i < toIdx; i++) {
          if (!this._completedStages.has(STAGES[i])) {
            return { allowed: false, reason: 'cannot skip stage ' + STAGES[i] };
          }
        }
      }
      return { allowed: true };
    }

    if (toIdx < fromIdx) {
      if (!this._config.allowRollback) {
        return { allowed: false, reason: 'rollback not allowed' };
      }
      const allowedRollback = ROLLBACK_ALLOWED[fromStage];
      if (allowedRollback && allowedRollback.includes(toStage)) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'rollback from ' + fromStage + ' to ' + toStage + ' not permitted' };
    }

    return { allowed: true };
  }

  _executeStage(stage, context) {
    const validator = STAGE_VALIDATORS[stage];
    const executor = STAGE_EXECUTORS[stage];

    if (!validator || !executor) {
      debug('AgentSkillsDiscipline', '_executeStage', 'No validator/executor for stage: ' + stage);
      return { stage, output: null };
    }

    const validation = validator(context);
    if (!validation.valid) {
      debug('AgentSkillsDiscipline', '_executeStage', 'Validation failed for ' + stage + ': ' + validation.reason);
      this.emit('stage-validation-failed', { stage, reason: validation.reason });
      return { stage, output: null, validationError: validation.reason };
    }

    const result = executor(context);
    return result;
  }

  _getNextStage(stage) {
    const idx = STAGE_INDEX[stage];
    if (idx === undefined || idx >= STAGES.length - 1) return null;
    return STAGES[idx + 1];
  }

  /**
   * 获取当前纪律执行器的完整状态快照。
   *
   * @returns {Object} 状态对象，包含currentStage、completedStages、stageResults、stageTimestamps、transitionLog、config
   */
  getState() {
    return {
      currentStage: this._currentStage,
      completedStages: Array.from(this._completedStages),
      stageResults: Object.fromEntries(this._stageResults),
      stageTimestamps: Object.fromEntries(this._stageTimestamps),
      transitionLog: this._transitionLog.slice(),
      config: safeAssign({}, this._config),
    };
  }

  /**
   * 重置纪律执行器到初始状态，清空所有阶段进度和转换日志。
   *
   * @returns {void}
   */
  reset() {
    this.guardShutdown();
    const previousStage = this._currentStage;
    this._currentStage = null;
    this._completedStages.clear();
    this._stageResults.clear();
    this._stageTimestamps.clear();
    this._transitionLog.length = 0;
    this.emit('discipline-reset', { previousStage, timestamp: Date.now() });
  }

  /**
   * 判断是否可以推进到指定阶段，基于当前阶段转换规则验证。
   *
   * @param {string} stage - 目标阶段名称
   * @returns {boolean} 是否允许推进
   */
  canAdvanceTo(stage) {
    if (!stage || STAGE_INDEX[stage] === undefined) return false;
    if (this._currentStage === null) return stage === STAGES[0];
    const validation = this._validateStageTransition(this._currentStage, stage);
    return validation.allowed;
  }

  /**
   * 获取纪律执行器统计信息。
   *
   * @returns {Object} 统计快照，包含totalStages、completedStages、currentStage、progress、stageResultsCount、transitionLogSize、config
   */
  getStats() {
    return {
      totalStages: STAGES.length,
      completedStages: this._completedStages.size,
      currentStage: this._currentStage,
      progress: this._completedStages.size / STAGES.length,
      stageResultsCount: this._stageResults.size,
      transitionLogSize: this._transitionLog.length,
      config: safeAssign({}, this._config),
    };
  }

  _onShutdown() {
    this._currentStage = null;
    this._completedStages.clear();
    this._stageResults.clear();
    this._stageTimestamps.clear();
    this._transitionLog.length = 0;
    this._config = safeAssign({}, DEFAULT_CONFIG);
    this.removeAllListeners();
  }
}

AgentSkillsDiscipline.STAGES = STAGES;
AgentSkillsDiscipline.STAGE_INDEX = STAGE_INDEX;
AgentSkillsDiscipline.STAGE_COMMANDS = STAGE_COMMANDS;
AgentSkillsDiscipline.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(AgentSkillsDiscipline);
