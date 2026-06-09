'use strict';

const { withShutdown } = require('../../utils/shutdown-mixin');
const debug = require('../../utils/debug-logger')('TaskLifecycleOrchestrator');

/** @constant {number} MAX_ROUND_RESULTS - 轮次结果最大保留数 */
const MAX_ROUND_RESULTS = 100;

/**
 * @module runtime/workflow/task-lifecycle-orchestrator 任务生命周期编排器——融合自Anthropic Harness三层体系设计。
 * 将长程任务拆分为Planner→Generator→Evaluator三层独立执行，
 * 每层拥有独立上下文窗口，防止Context Anxiety和Self-Evaluation偏差。
 *
 * 三层职责：
 * - Planner：将简短需求扩展为完整产品规格（SddContractManager驱动）
 * - Generator：按规格执行开发（GoalExecutor驱动，轮次式构建推进）
 * - Evaluator：独立验收每轮产出（GeneratorVerifier+QualityScorer驱动）
 *
 * 关键设计：
 * - 三层不共享上下文窗口，通过结构化文件传递状态
 * - Evaluator独立于Generator，防止Self-Evaluation偏差
 * - 每轮Generator产出后必须通过Evaluator验收才进入下一轮
 * - 支持Compaction（压缩后继续）和Context Reset（清空重启）双模式
 *
 * @classdesc 任务生命周期编排器，协调任务的创建、调度、执行和完成全流程
 */
class TaskLifecycleOrchestrator {
  /**
   * @param {object} [options]
   * @param {number} [options.maxRounds=10] - 最大构建轮次
   * @param {number} [options.evaluationThreshold=0.7] - 验收通过阈值(0-1)
   * @param {number} [options.contextResetTokenRatio=0.85] - Token使用率达到此比例时触发Context Reset
   * @param {boolean} [options.enableCompaction=true] - 是否启用Compaction模式
   * @param {boolean} [options.enableContextReset=true] - 是否启用Context Reset模式
   */
  constructor(options) {
    const opts = options ?? {};
    this._maxRounds = opts.maxRounds ?? 10;
    this._evaluationThreshold = opts.evaluationThreshold ?? 0.7;
    this._contextResetTokenRatio = opts.contextResetTokenRatio ?? 0.85;
    this._enableCompaction = opts.enableCompaction !== false;
    this._enableContextReset = opts.enableContextReset !== false;

    this._currentRound = 0;
    this._phase = 'idle'; // idle | planning | generating | evaluating | completed | failed
    this._spec = null;
    this._roundResults = [];
    this._evaluationHistory = [];
    this._maxEvaluationHistory = 100;
    this._contextMode = 'normal'; // normal | compacted | reset
    this._stateFile = null; // 结构化状态文件路径

    // 依赖注入点
    this._sddContractManager = null;
    this._goalExecutor = null;
    this._generatorVerifier = null;
    this._qualityScorer = null;
    this._contextCompressionEngine = null;
    this._sessionResumptionProtocol = null;
    this._tokenManager = null;
  }

  // --- 依赖注入 ---

  /**
   * 注入SddContractManager（Planner层）。
   * @param {object} manager - SddContractManager实例
   * @returns {TaskLifecycleOrchestrator} 当前实例，支持链式调用
   */
  attachSddContractManager(manager) { this._sddContractManager = manager; return this; }

  /**
   * 注入GoalExecutor（Generator层）。
   * @param {object} executor - GoalExecutor实例
   * @returns {TaskLifecycleOrchestrator} 当前实例，支持链式调用
   */
  attachGoalExecutor(executor) { this._goalExecutor = executor; return this; }

  /**
   * 注入GeneratorVerifier（Evaluator层）。
   * @param {object} verifier - GeneratorVerifier实例
   * @returns {TaskLifecycleOrchestrator} 当前实例，支持链式调用
   */
  attachGeneratorVerifier(verifier) { this._generatorVerifier = verifier; return this; }

  /**
   * 注入QualityScorer（Evaluator层）。
   * @param {object} scorer - QualityScorer实例
   * @returns {TaskLifecycleOrchestrator} 当前实例，支持链式调用
   */
  attachQualityScorer(scorer) { this._qualityScorer = scorer; return this; }

  /**
   * 注入ContextCompressionEngine（Context Anxiety防护）。
   * @param {object} engine - ContextCompressionEngine实例
   * @returns {TaskLifecycleOrchestrator} 当前实例，支持链式调用
   */
  attachContextCompressionEngine(engine) { this._contextCompressionEngine = engine; return this; }

  /**
   * 注入SessionResumptionProtocol（Context Reset）。
   * @param {object} protocol - SessionResumptionProtocol实例
   * @returns {TaskLifecycleOrchestrator} 当前实例，支持链式调用
   */
  attachSessionResumptionProtocol(protocol) { this._sessionResumptionProtocol = protocol; return this; }

  /**
   * 注入TokenManager（Token预算监控）。
   * @param {object} manager - TokenManager实例
   * @returns {TaskLifecycleOrchestrator} 当前实例，支持链式调用
   */
  attachTokenManager(manager) { this._tokenManager = manager; return this; }

  // --- 三层生命周期 ---

  /**
   * 启动长程任务的三层生命周期。
   * @param {string} requirement - 用户简短需求描述
   * @param {object} [context] - 附加上下文
   * @returns {Promise<object>} 最终结果
   */
  async execute(requirement, context) {
    this._phase = 'planning';
    this._currentRound = 0;
    this._roundResults = [];
    this._evaluationHistory = [];

    try {
      // Phase 1: Planner — 需求→规格
      const spec = await this._runPlanner(requirement, context);
      if (!spec) {
        this._phase = 'failed';
        return { success: false, reason: 'planning_failed', phase: 'planner' };
      }
      this._spec = spec;

      // Phase 2+3: Generator→Evaluator 循环
      let lastResult = null;
      for (let round = 1; round <= this._maxRounds; round++) {
        this._currentRound = round;

        // 检查Token预算，决定是否需要Context Reset
        const contextAction = this._checkContextBudget();
        if (contextAction === 'reset' && this._enableContextReset) {
          await this._performContextReset(round);
        } else if (contextAction === 'compact' && this._enableCompaction) {
          await this._performCompaction();
        }

        // Generator: 执行一轮构建
        this._phase = 'generating';
        const genResult = await this._runGenerator(spec, lastResult, round);
        if (!genResult) {
          this._phase = 'failed';
          return { success: false, reason: 'generation_failed', round, phase: 'generator' };
        }

        // Evaluator: 独立验收
        this._phase = 'evaluating';
        const evalResult = await this._runEvaluator(spec, genResult, round);
        this._evaluationHistory.push({
          round,
          score: evalResult.score,
          passed: evalResult.passed,
          issues: evalResult.issues ?? [],
        });
        if (this._evaluationHistory.length > this._maxEvaluationHistory) {
          this._evaluationHistory.shift();
        }

        if (this._roundResults.length >= MAX_ROUND_RESULTS) this._roundResults.shift();
        this._roundResults.push({ round, generation: genResult, evaluation: evalResult });

        if (evalResult.passed) {
          this._phase = 'completed';
          return {
            success: true,
            rounds: round,
            spec,
            finalResult: genResult,
            evaluation: evalResult,
            evaluationHistory: this._evaluationHistory,
          };
        }

        lastResult = genResult;
      }

      this._phase = 'failed';
      return {
        success: false,
        reason: 'max_rounds_exceeded',
        rounds: this._maxRounds,
        evaluationHistory: this._evaluationHistory,
      };
    } catch (err) {
      this._phase = 'failed';
      return { success: false, reason: 'execution_error', error: err && err.message ? err.message : String(err) };
    }
  }

  // --- Planner层 ---

  async _runPlanner(requirement, context) {
    if (this._sddContractManager) {
      try {
        // 使用SddContractManager推进到spec阶段
        const contractId = this._sddContractManager.propose({
          title: requirement,
          description: context?.description || requirement,
        });
        const advanced = this._sddContractManager.advanceStage(contractId, 'spec', {
          functionalRequirements: context?.functionalRequirements || [requirement],
          constraints: context?.constraints ?? [],
          acceptanceCriteria: context?.acceptanceCriteria ?? [],
        });
        return advanced;
      } catch (_err) {
        debug('specDegraded', _err && _err.message ? _err.message : String(_err));
        // SddContractManager不可用时降级为简单规格
        return {
          title: requirement,
          functionalRequirements: [requirement],
          constraints: [],
          acceptanceCriteria: [{ criterion: requirement, required: true }],
        };
      }
    }
    // 降级：生成基础规格
    return {
      title: requirement,
      functionalRequirements: [requirement],
      constraints: [],
      acceptanceCriteria: [{ criterion: requirement, required: true }],
    };
  }

  // --- Generator层 ---

  async _runGenerator(spec, previousResult, round) {
    if (this._goalExecutor) {
      try {
        const goal = {
          objective: spec.title || spec.functionalRequirements?.[0] || 'implement',
          spec,
          round,
          previousResult,
        };
        const result = await this._goalExecutor.executeGoal(goal);
        return result;
      } catch (_err) {
        debug('Goal execution failed: ' + (_err && _err.message ? _err.message : String(_err)));
        return { score: 0, passed: false, issues: ['verification_error'], round };
      }
    }
    // 无GoalExecutor时返回规格本身
    return { spec, round, output: null };
  }

  // --- Evaluator层 ---

  async _runEvaluator(spec, genResult, round) {
    const issues = [];
    let score = 0;

    // GeneratorVerifier评估
    if (this._generatorVerifier) {
      try {
        const verifyResult = this._generatorVerifier.verify(genResult, {
          spec,
          round,
          checkDimensions: ['requirement_alignment', 'logic_correctness', 'completeness'],
        });
        score = verifyResult.score ?? 0;
        if (verifyResult.issues) issues.push(...verifyResult.issues);
      } catch (_err) { debug('TaskLifecycleOrchestrator', 'generatorVerifyDegraded', _err && _err.message ? _err.message : String(_err)); }
    }

    // QualityScorer评估
    if (this._qualityScorer && score === 0) {
      try {
        const qualityResult = this._qualityScorer.evaluate(genResult);
        score = qualityResult.score ?? 0;
      } catch (_err) { debug('TaskLifecycleOrchestrator', 'qualityScoreDegraded', _err && _err.message ? _err.message : String(_err)); }
    }

    // 无评估器时基于规格存在性给基础分
    if (score === 0 && genResult) {
      score = 0.5;
    }

    return {
      score,
      passed: score >= this._evaluationThreshold,
      issues,
      round,
    };
  }

  // --- Context Anxiety防护 ---

  _checkContextBudget() {
    if (!this._tokenManager) return 'normal';
    const usage = this._tokenManager.getUsage?.() ?? {};
    const ratio = usage.ratio ?? 0;
    if (ratio >= this._contextResetTokenRatio) return 'reset';
    if (ratio >= this._contextResetTokenRatio * 0.7) return 'compact';
    return 'normal';
  }

  async _performCompaction() {
    this._contextMode = 'compacted';
    if (this._contextCompressionEngine) {
      try {
        await this._contextCompressionEngine.compress({ strategy: 'summary' });
      } catch (_err) { debug('TaskLifecycleOrchestrator', 'compactionFailed', _err && _err.message ? _err.message : String(_err)); }
    }
  }

  async _performContextReset(round) {
    this._contextMode = 'reset';
    // 提取关键状态
    const stateSnapshot = {
      spec: this._spec,
      round,
      evaluationHistory: this._evaluationHistory,
      lastResult: this._roundResults[this._roundResults.length - 1]?.generation ?? null,
    };

    if (this._sessionResumptionProtocol) {
      try {
        this._stateFile = await this._sessionResumptionProtocol.generateResumptionToken(stateSnapshot);
      } catch (_err) { debug('TaskLifecycleOrchestrator', 'stateExtractionFailed', _err && _err.message ? _err.message : String(_err)); }
    }
    // Context Reset后，Generator将在新上下文窗口中继续
    // 通过stateFile传递关键状态
  }

  // --- 状态查询 ---

  /**
   * 获取当前任务生命周期状态。
   * @returns {{ phase: string, currentRound: number, maxRounds: number, contextMode: string, evaluationThreshold: number, evaluationCount: number, hasSpec: boolean }}
   */
  getStatus() {
    this.guardShutdown();
    return {
      phase: this._phase,
      currentRound: this._currentRound,
      maxRounds: this._maxRounds,
      contextMode: this._contextMode,
      evaluationThreshold: this._evaluationThreshold,
      evaluationCount: this._evaluationHistory.length,
      hasSpec: !!this._spec,
    };
  }

  /**
   * 获取评估历史记录。
   * @returns {Array<{ round: number, score: number, passed: boolean, issues: Array }>}
   */
  getEvaluationHistory() {
    return this._evaluationHistory.slice();
  }

  _onShutdown() {
    this._spec = null;
    this._roundResults = [];
    this._evaluationHistory = [];
    this._stateFile = null;
  }
}

module.exports = withShutdown(TaskLifecycleOrchestrator);
