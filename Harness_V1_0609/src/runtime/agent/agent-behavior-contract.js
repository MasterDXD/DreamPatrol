'use strict';

/**
 * @module runtime/agent/agent-behavior-contract
 * Agent行为契约系统，融合自Meridian AI Worker编排系统的核心概念。
 *
 * Meridian核心洞察：AI Worker工程化的关键不是"让AI更聪明"，而是"给AI加约束"。
 * 行为契约解决3个核心问题：
 * 1. 输入层：指令模板+上下文瘦身，强制模型只关注必要信息
 * 2. 执行层：行为契约JSON，SubAgent输出必须遵循固定Schema
 * 3. 输出层：结果校验器，不依赖模型自我判断，用工具验证
 *
 * 三层约束对冲注意力机制差异：
 * - 输入层约束：减少注意力分散
 * - 执行层约束：限制自由发挥
 * - 输出层约束：拒绝完成幻觉
 */

const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const BoundedArray = require('../../utils/bounded-array');

/**
 * 执行状态枚举，融合自Meridian的行为契约概念。
 * SubAgent每次输出必须包含执行状态，主Agent只接收该格式。
 */
const EXECUTION_STATUS = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  PARTIAL: 'partial',
  BLOCKED: 'blocked',
};

/**
 * 下一步请求枚举，融合自Meridian的有限状态转移概念。
 * SubAgent无法触发非法状态（如跳过自测直接提交）。
 */
const NEXT_ACTION = {
  CONTINUE: 'continue',
  RETRY: 'retry',
  TERMINATE: 'terminate',
  REQUEST_RESOURCE: 'request-resource',
  ESCALATE: 'escalate',
};

/**
 * 契约验证结果级别
 */
const VALIDATION_LEVEL = {
  PASS: 'pass',
  WARN: 'warn',
  FAIL: 'fail',
};

/**
 * 默认行为契约Schema，融合自Meridian的"行为契约JSON"概念。
 * SubAgent每次输出必须包含以下4个核心字段：
 * - executionStatus: 执行状态
 * - resultData: 结果数据
 * - selfTestResult: 自测结果（拒绝"AI说做完了就做完了"）
 * - nextAction: 下一步请求
 */
const DEFAULT_CONTRACT_SCHEMA = {
  executionStatus: { type: 'string', required: true, enum: Object.values(EXECUTION_STATUS) },
  resultData: { type: 'object', required: true },
  selfTestResult: {
    type: 'object',
    required: true,
    properties: {
      passed: { type: 'boolean', required: true },
      issues: { type: 'array', required: false },
      metrics: { type: 'object', required: false },
    },
  },
  nextAction: { type: 'string', required: true, enum: Object.values(NEXT_ACTION) },
};

const DEFAULT_OPTIONS = {
  maxContracts: 200,
  maxValidationHistory: 500,
  maxRetries: 2,
  strictMode: true,
};

/**
 * Agent行为契约管理器，融合自Meridian AI Worker编排系统的行为契约概念。
 *
 * 核心原则（融合自Meridian实战洞察）：
 * - 没有验证的交付都是无效交付
 * - AI天生会产生"完成幻觉"，必须内置强制验证环节
 * - 验证不通过自动触发重试或异常处理流程
 * - 复杂度从代码本身转移到AI Worker的管理上
 *
 * @classdesc Agent行为契约管理器。行为契约、JSON Schema约束、强制验证。
 */
class AgentBehaviorContract extends EventEmitter {

  /**
   * 创建AgentBehaviorContract实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxContracts=200] - 最大契约数
   * @param {number} [options.maxValidationHistory=500] - 最大验证历史数
   * @param {number} [options.maxRetries=2] - 最大重试次数
   * @param {boolean} [options.strictMode=true] - 严格模式（验证失败直接拒绝）
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._contracts = new Map();
    this._schemas = new Map();
    this._validators = new Map();
    this._validationHistory = new BoundedArray(this._options.maxValidationHistory);
    this._stats = { totalValidations: 0, passed: 0, failed: 0, retried: 0, escalated: 0 };

    // 注册默认Schema
    this._schemas.set('default', DEFAULT_CONTRACT_SCHEMA);
  }

  /**
   * 注册行为契约Schema，融合自Meridian的"行为契约JSON"概念。
   * 定义Agent间通信的消息格式约束，SubAgent输出必须遵循该Schema。
   * @param {string} contractType - 契约类型标识
   * @param {Object} schema - JSON Schema定义
   * @param {Object} [schema.executionStatus] - 执行状态字段定义
   * @param {Object} [schema.resultData] - 结果数据字段定义
   * @param {Object} [schema.selfTestResult] - 自测结果字段定义
   * @param {Object} [schema.nextAction] - 下一步请求字段定义
   * @returns {{ contractType: string, registered: boolean }} 注册结果
   */
  registerSchema(contractType, schema) {
    this.guardShutdown();
    if (!contractType || typeof contractType !== 'string') {
      return { contractType: null, registered: false };
    }
    this._schemas.set(contractType, schema);
    return { contractType, registered: true };
  }

  /**
   * 注册结果校验器，融合自Meridian的"结果校验器"概念。
   * 不依赖模型的"自我判断"，直接用工具验证。
   * 例如：代码任务校验编译是否通过、JSON格式是否合规、自测用例是否执行。
   * @param {string} contractType - 契约类型标识
   * @param {Function} validatorFn - 校验函数，接收resultData，返回{passed, issues}
   * @returns {{ contractType: string, registered: boolean }} 注册结果
   */
  registerValidator(contractType, validatorFn) {
    this.guardShutdown();
    if (!contractType || typeof validatorFn !== 'function') {
      return { contractType: null, registered: false };
    }
    this._validators.set(contractType, validatorFn);
    return { contractType, registered: true };
  }

  /**
   * 创建行为契约实例，绑定到特定任务。
   * @param {string} taskId - 任务ID
   * @param {Object} [config] - 契约配置
   * @param {string} [config.contractType='default'] - 契约类型
   * @param {string[]} [config.boundaryConstraints=[]] - 边界约束，融合自Meridian的"边界要求"
   * @param {string[]} [config.selfTestCriteria=[]] - 自测标准，融合自Meridian的"验收标准"
   * @param {string[]} [config.dependencyResources=[]] - 依赖资源，融合自Meridian的"参考文档"
   * @param {number} [config.maxRetries] - 最大重试次数
   * @returns {Object} 契约实例
   */
  createContract(taskId, config) {
    this.guardShutdown();
    if (!taskId) return { contractId: null, error: 'taskId is required' };

    const contractType = (config && config.contractType) || 'default';
    const schema = this._schemas.get(contractType);
    if (!schema) return { contractId: null, error: 'Unknown contract type: ' + contractType };

    if (this._contracts.size >= this._options.maxContracts) {
      let evicted = false;
      for (const [id, c] of this._contracts) {
        if (c.status === 'completed' || c.status === 'failed') {
          this._contracts.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted) return { contractId: null, error: 'Max contracts reached' };
    }

    const contractId = 'contract-' + taskId;
    const contract = {
      contractId,
      taskId,
      contractType,
      schema,
      boundaryConstraints: (config && config.boundaryConstraints) ?? [],
      selfTestCriteria: (config && config.selfTestCriteria) ?? [],
      dependencyResources: (config && config.dependencyResources) ?? [],
      maxRetries: (config && config.maxRetries) ?? this._options.maxRetries,
      status: 'active',
      retryCount: 0,
      createdAt: Date.now(),
      lastValidatedAt: null,
    };
    this._contracts.set(contractId, contract);
    return { contractId, contractType, boundaryConstraints: contract.boundaryConstraints, selfTestCriteria: contract.selfTestCriteria };
  }

  /**
   * 验证Agent输出是否符合行为契约，融合自Meridian的"强制验证"概念。
   * 所有交付结果必须通过自动化检查才能进入下一阶段。
   * 验证不通过自动触发重试或异常处理流程。
   * @param {string} contractId - 契约ID
   * @param {Object} output - Agent输出
   * @returns {{ valid: boolean, level: string, issues: string[], retryCount: number, nextAction: string }} 验证结果
   */
  validate(contractId, output) {
    this.guardShutdown();
    const contract = this._contracts.get(contractId);
    if (!contract) return { valid: false, level: VALIDATION_LEVEL.FAIL, issues: ['Contract not found'], retryCount: 0, nextAction: NEXT_ACTION.TERMINATE };

    const issues = [];
    this._validateSchema(output, contract.schema, issues);
    this._validateSelfTest(output, contract.selfTestCriteria, issues);
    this._validateBoundary(output, contract.boundaryConstraints, issues);
    this._validateCustom(output, contract.contractType, issues);

    const valid = issues.length === 0;
    const level = valid ? VALIDATION_LEVEL.PASS : VALIDATION_LEVEL.FAIL;
    let nextAction = valid ? NEXT_ACTION.CONTINUE : NEXT_ACTION.RETRY;

    if (!valid && contract.retryCount >= contract.maxRetries) {
      nextAction = NEXT_ACTION.ESCALATE;
      contract.status = 'failed';
    } else if (!valid) {
      contract.retryCount++;
      this._stats.retried++;
    }

    if (valid) {
      contract.status = 'completed';
    }
    contract.lastValidatedAt = Date.now();

    const historyEntry = {
      contractId,
      valid,
      level,
      issueCount: issues.length,
      retryCount: contract.retryCount,
      nextAction,
      timestamp: Date.now(),
    };
    this._validationHistory.push(historyEntry);

    this._stats.totalValidations++;
    if (valid) this._stats.passed++;
    else this._stats.failed++;
    if (nextAction === NEXT_ACTION.ESCALATE) this._stats.escalated++;

    return { valid, level, issues, retryCount: contract.retryCount, nextAction };
  }

  /**
   * Schema验证：检查必填字段、枚举值和类型。
   * @param {Object} output - Agent输出
   * @param {Object} schema - 契约Schema
   * @param {Array<string>} issues - 问题收集器
   * @private
   */
  _validateSchema(output, schema, issues) {
    for (const [field, def] of Object.entries(schema)) {
      if (def.required && (output[field] === undefined || output[field] === null)) {
        issues.push('Missing required field: ' + field);
      }
      if (def.enum && output[field] && !def.enum.includes(output[field])) {
        issues.push('Invalid value for ' + field + ': must be one of ' + def.enum.join('/'));
      }
      if (def.type && output[field] !== undefined && output[field] !== null) {
        const actualType = Array.isArray(output[field]) ? 'array' : typeof output[field];
        if (actualType !== def.type && !(def.type === 'object' && actualType === 'array')) {
          issues.push('Type mismatch for ' + field + ': expected ' + def.type + ', got ' + actualType);
        }
      }
    }
  }

  /**
   * 自测结果验证：拒绝"AI说做完了就做完了"。
   * @param {Object} output - Agent输出
   * @param {Array} selfTestCriteria - 自测标准
   * @param {Array<string>} issues - 问题收集器
   * @private
   */
  _validateSelfTest(output, selfTestCriteria, issues) {
    if (output.selfTestResult && typeof output.selfTestResult === 'object') {
      if (output.selfTestResult.passed !== true && selfTestCriteria.length > 0) {
        issues.push('Self-test not passed');
      }
    } else if (selfTestCriteria.length > 0) {
      issues.push('Missing selfTestResult');
    }
  }

  /**
   * 边界约束验证。
   * @param {Object} output - Agent输出
   * @param {Array<string>} boundaryConstraints - 边界约束
   * @param {Array<string>} issues - 问题收集器
   * @private
   */
  _validateBoundary(output, boundaryConstraints, issues) {
    if (output.resultData && typeof output.resultData === 'object' && boundaryConstraints.length > 0) {
      let resultStr;
      try { resultStr = JSON.stringify(output.resultData); } catch (_) { debug('AgentBehaviorContract', '_validateBoundary:stringify', _ && _.message ? _.message : String(_)); return; }
      for (const constraint of boundaryConstraints) {
        if (resultStr.includes(constraint)) {
          issues.push('Boundary constraint violated: ' + constraint);
        }
      }
    }
  }

  /**
   * 自定义校验器验证。
   * @param {Object} output - Agent输出
   * @param {string} contractType - 契约类型
   * @param {Array<string>} issues - 问题收集器
   * @private
   */
  _validateCustom(output, contractType, issues) {
    const validator = this._validators.get(contractType);
    if (validator) {
      try {
        const validatorResult = validator(output.resultData);
        if (validatorResult && !validatorResult.passed) {
          const validatorIssues = validatorResult.issues || ['Validator check failed'];
          issues.push.apply(issues, validatorIssues);
        }
      } catch (e) {
        debug('AgentBehaviorContract', '_validateCustom', e && e.message ? e.message : String(e));
        issues.push('Validator error: ' + (e && e.message ? e.message : String(e)));
      }
    }
  }

  /**
   * 构建指令模板，融合自Meridian的"输入层约束"概念。
   * 用固定JSON Schema定义输入格式，强制模型只关注必要信息，减少注意力分散。
   * @param {string} contractId - 契约ID
   * @param {Object} [extraContext] - 额外上下文
   * @returns {Object} 指令模板对象
   */
  buildInstructionTemplate(contractId, extraContext) {
    this.guardShutdown();
    const contract = this._contracts.get(contractId);
    if (!contract) return null;

    return {
      taskType: contract.contractType,
      boundaryConstraints: contract.boundaryConstraints,
      dependencyResources: contract.dependencyResources,
      selfTestCriteria: contract.selfTestCriteria,
      outputSchema: contract.schema,
      extraContext: extraContext ?? {},
    };
  }

  /**
   * 上下文瘦身，融合自Meridian的"上下文瘦身"概念。
   * 按最近相关+核心规则筛选，避免长文本导致"中间遗忘"。
   * @param {Object} fullContext - 完整上下文
   * @param {Object} [options] - 瘦身选项
   * @param {number} [options.recentSteps=2] - 保留最近N步结果
   * @param {number} [options.maxRules=5] - 最大核心规则数
   * @returns {Object} 瘦身后的上下文
   */
  slimContext(fullContext, options) {
    if (!fullContext || typeof fullContext !== 'object') return fullContext;
    const recentSteps = (options && options.recentSteps) || 2;
    const maxRules = (options && options.maxRules) || 5;

    const slimmed = {};

    // 保留核心规则（最多maxRules条）
    if (Array.isArray(fullContext.rules)) {
      slimmed.rules = fullContext.rules.slice(0, maxRules);
    }

    // 保留最近N步结果
    if (Array.isArray(fullContext.previousResults)) {
      slimmed.previousResults = fullContext.previousResults.slice(-recentSteps);
    }

    // 保留当前任务规范
    if (fullContext.currentTask) {
      slimmed.currentTask = fullContext.currentTask;
    }

    // 保留边界约束
    if (Array.isArray(fullContext.boundaryConstraints)) {
      slimmed.boundaryConstraints = fullContext.boundaryConstraints;
    }

    // 保留自测标准
    if (Array.isArray(fullContext.selfTestCriteria)) {
      slimmed.selfTestCriteria = fullContext.selfTestCriteria;
    }

    return slimmed;
  }

  /**
   * 获取契约信息。
   * @param {string} contractId - 契约ID
   * @returns {Object|null} 契约信息
   */
  getContract(contractId) {
    const contract = this._contracts.get(contractId);
    if (!contract) return null;
    return {
      contractId: contract.contractId,
      taskId: contract.taskId,
      contractType: contract.contractType,
      status: contract.status,
      retryCount: contract.retryCount,
      boundaryConstraints: contract.boundaryConstraints,
      selfTestCriteria: contract.selfTestCriteria,
      createdAt: contract.createdAt,
      lastValidatedAt: contract.lastValidatedAt,
    };
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      totalValidations: this._stats.totalValidations,
      passed: this._stats.passed,
      failed: this._stats.failed,
      retried: this._stats.retried,
      escalated: this._stats.escalated,
      passRate: this._stats.totalValidations > 0 ? this._stats.passed / this._stats.totalValidations : 0,
      activeContracts: Array.from(this._contracts.values()).filter(function(c) { return c.status === 'active'; }).length,
      registeredSchemas: this._schemas.size,
      registeredValidators: this._validators.size,
    };
  }

  _onShutdown() {
    safeCall(() => this._validationHistory.shutdown(), 'AgentBehaviorContract', 'shutdown-validationHistory');
    this._contracts.clear();
    this._schemas.clear();
    this._validators.clear();
    this.removeAllListeners();
  }
}

AgentBehaviorContract.EXECUTION_STATUS = EXECUTION_STATUS;
AgentBehaviorContract.NEXT_ACTION = NEXT_ACTION;
AgentBehaviorContract.VALIDATION_LEVEL = VALIDATION_LEVEL;
AgentBehaviorContract.DEFAULT_CONTRACT_SCHEMA = DEFAULT_CONTRACT_SCHEMA;

AgentBehaviorContract = withShutdown(AgentBehaviorContract);

module.exports = AgentBehaviorContract;
