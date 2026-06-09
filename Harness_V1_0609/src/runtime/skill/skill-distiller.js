'use strict';

/** @module runtime/skill/skill-distiller */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { safeJsonParse } = require('../../utils/safe-parse');
const debug = require('../../utils/debug-logger')('SkillDistiller');
const BoundedArray = require('../../utils/bounded-array');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DEFAULT_SKILLS_DIR = '.harness/skills';
const DEFAULT_DISTILLED_DIR = '.harness/skills-distilled';
const MAX_TRACES = 500;
const MAX_DISTILLATIONS = 100;
const MIN_TRACES_FOR_DISTILLATION = 5;
const CONVERGENCE_THRESHOLD = 0.1;
const CANARY_TRAFFIC_PERCENT = 20;
const CANARY_EVAL_ROUNDS = 10;
const CANARY_SUCCESS_THRESHOLD = 0.8;
const MAX_ACTIVE_DISTILLATIONS = 50;
const UTF8 = 'utf-8';
const DISTILLED_MARKER = '<!-- distilled-procedure -->';

/**
 * SkillDistiller — 技能蒸馏编排层
 * 连接6个现有Harness模块（SkillImprovementLoop、PlaybookGenerator、DreamEngine、
 * SkillCanary、SkillCurator、OptimizationLoop）形成统一的
 * session-trace → pattern-mining → distillation → LLM-rewrite → eval → canary-deploy 管道。
 *
 * @extends EventEmitter
 * @emits SkillDistiller#initialized
 * @emits SkillDistiller#trace-captured
 * @emits SkillDistiller#skill-distilled
 * @emits SkillDistiller#skill-rewritten
 * @emits SkillDistiller#distillation-evaluated
 * @emits SkillDistiller#canary-deployed
 * @emits SkillDistiller#distillation-not-converged
 */
class SkillDistiller extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.skillsDir] - 技能目录路径
   * @param {object} [options.skillImprover] - SkillImprover实例
   * @param {object} [options.skillImprovementLoop] - SkillImprovementLoop实例
   * @param {object} [options.playbookGenerator] - PlaybookGenerator实例
   * @param {object} [options.skillCanary] - SkillCanary实例
   * @param {object} [options.skillCurator] - SkillCurator实例
   * @param {object} [options.dreamEngine] - DreamEngine实例
   * @param {object} [options.convergenceDetector] - ConvergenceDetector实例
   * @param {number} [options.maxTraces] - 最大执行追踪条数
   * @param {number} [options.maxDistillations] - 最大蒸馏历史条数
   * @param {number} [options.minTracesForDistillation] - 蒸馏所需最少追踪条数
   * @param {number} [options.convergenceThreshold] - 收敛质量改进阈值
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._skillsDir = opts.skillsDir ?? DEFAULT_SKILLS_DIR;
    this._skillImprover = opts.skillImprover ?? null;
    this._skillImprovementLoop = opts.skillImprovementLoop ?? null;
    this._playbookGenerator = opts.playbookGenerator ?? null;
    this._skillCanary = opts.skillCanary ?? null;
    this._skillCurator = opts.skillCurator ?? null;
    this._dreamEngine = opts.dreamEngine ?? null;
    this._convergenceDetector = opts.convergenceDetector ?? null;
    this._maxTraces = opts.maxTraces ?? MAX_TRACES;
    this._maxDistillations = opts.maxDistillations ?? MAX_DISTILLATIONS;
    this._minTracesForDistillation = opts.minTracesForDistillation ?? MIN_TRACES_FOR_DISTILLATION;
    this._convergenceThreshold = opts.convergenceThreshold ?? CONVERGENCE_THRESHOLD;
    this._executionTraces = new BoundedArray(this._maxTraces);
    this._distillationHistory = new BoundedArray(this._maxDistillations);
    this._activeDistillations = new Map();
    this._stats = {
      totalTracesCaptured: 0,
      totalDistillations: 0,
      totalEvals: 0,
      totalCanaryDeploys: 0,
      totalConverged: 0,
      totalRolledBack: 0,
    };
    this._initialized = false;
  }

  attachSkillImprover(improver) {
    this.guardShutdown();
    this._skillImprover = improver;
    return this;
  }

  attachSkillImprovementLoop(loop) {
    this.guardShutdown();
    this._skillImprovementLoop = loop;
    return this;
  }

  attachPlaybookGenerator(gen) {
    this.guardShutdown();
    this._playbookGenerator = gen;
    return this;
  }

  attachSkillCanary(canary) {
    this.guardShutdown();
    this._skillCanary = canary;
    return this;
  }

  attachSkillCurator(curator) {
    this.guardShutdown();
    this._skillCurator = curator;
    return this;
  }

  attachDreamEngine(engine) {
    this.guardShutdown();
    this._dreamEngine = engine;
    return this;
  }

  attachConvergenceDetector(detector) {
    this.guardShutdown();
    this._convergenceDetector = detector;
    return this;
  }

  /**
   * 初始化SkillDistiller，创建蒸馏目录并加载历史记录。
   * @async
   * @returns {Promise<{initialized: boolean}>} 初始化结果
   * @emits SkillDistiller#initialized
   */
  async initialize() {
    this.guardShutdown();
    const distilledDir = path.resolve(DEFAULT_DISTILLED_DIR);
    await this._ensureDir(distilledDir);
    const historyPath = path.join(distilledDir, 'history.json');
    try {
      await fsp.access(historyPath);
      const raw = await fsp.readFile(historyPath, UTF8);
      const parsed = safeJsonParse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          this._distillationHistory.push(entry);
        }
      }
    } catch (_err) {
      debug('initialize', 'noHistoryFile');
    }
    this._initialized = true;
    this.emit('initialized');
    return { initialized: true };
  }

  captureTrace(traceData) {
    this.guardShutdown();
    if (!traceData || typeof traceData !== 'object') {
      return { traceId: null, totalTraces: 0, error: 'traceData must be an object' };
    }
    if (!traceData.skillId || typeof traceData.skillId !== 'string') {
      return { traceId: null, totalTraces: 0, error: 'traceData.skillId is required' };
    }
    if (!traceData.sessionId) {
      return { traceId: null, totalTraces: 0, error: 'traceData.sessionId is required' };
    }
    if (!Array.isArray(traceData.steps)) {
      return { traceId: null, totalTraces: 0, error: 'traceData.steps must be an array' };
    }
    if (!traceData.outcome || typeof traceData.outcome !== 'object') {
      return { traceId: null, totalTraces: 0, error: 'traceData.outcome is required' };
    }
    const traceId = 'trace-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const trace = {
      traceId,
      skillId: traceData.skillId,
      sessionId: traceData.sessionId,
      steps: traceData.steps,
      outcome: traceData.outcome,
      timestamp: traceData.timestamp ?? Date.now(),
    };
    this._executionTraces.push(trace);
    this._stats.totalTracesCaptured++;
    if (this._skillImprover && typeof this._skillImprover.recordLearning === 'function') {
      safeCall(() => {
        this._skillImprover.recordLearning({
          skillId: trace.skillId,
          whatWorked: trace.outcome.success ? 'trace captured with success' : '',
          whatFailed: !trace.outcome.success ? 'trace captured with failure' : '',
        });
      }, 'SkillDistiller', 'recordLearning');
    }
    this.emit('trace-captured', { traceId, skillId: trace.skillId });
    return { traceId, totalTraces: this._executionTraces.length };
  }

  _validateDistillInput(skillId, _options) {
    if (!this._initialized) {
      return { skillId, error: 'SkillDistiller not initialized' };
    }
    if (!skillId || typeof skillId !== 'string') {
      return { skillId: null, error: 'skillId is required and must be a string' };
    }
    return null;
  }

  _pruneCompletedDistillations() {
    if (this._activeDistillations.size <= MAX_ACTIVE_DISTILLATIONS) return;
    for (const [key, val] of this._activeDistillations) {
      if (val.status === 'distilled' || val.status === 'failed') {
        this._activeDistillations.delete(key);
        if (this._activeDistillations.size <= MAX_ACTIVE_DISTILLATIONS) break;
      }
    }
  }

  /**
   * 蒸馏技能，从执行追踪中提取模式、决策树和错误恢复路径，生成蒸馏过程文件。
   * @async
   * @param {string} skillId - 技能标识
   * @param {object} [options] - 蒸馏选项
   * @param {boolean} [options.forceRedistill=false] - 是否强制重新蒸馏
   * @param {boolean} [options.includeDecisionTrees=true] - 是否包含决策树提取
   * @param {boolean} [options.includeErrorRecovery=true] - 是否包含错误恢复路径提取
   * @returns {Promise<object>} 蒸馏结果，包含skillId、version、patterns、decisionTrees、errorRecoveryPaths、traceCount；失败时包含error
   * @emits SkillDistiller#skill-distilled
   */
  async distillSkill(skillId, options) {
    this.guardShutdown();
    const validationError = this._validateDistillInput(skillId, options);
    if (validationError) return validationError;

    const opts = options ?? {};
    const forceRedistill = opts.forceRedistill ?? false;

    if (this._activeDistillations.has(skillId) && !forceRedistill) {
      return this._activeDistillations.get(skillId);
    }

    const traces = this._collectTracesForSkill(skillId);
    if (traces.length < this._minTracesForDistillation) {
      return {
        skillId,
        error: 'Insufficient traces: ' + traces.length + ' < ' + this._minTracesForDistillation,
      };
    }

    const distillState = {
      skillId,
      status: 'distilling',
      startedAt: Date.now(),
      traceCount: traces.length,
    };
    this._activeDistillations.set(skillId, distillState);
    this._pruneCompletedDistillations();

    try {
      const { patterns, decisionTrees, errorRecoveryPaths } = await this._extractDistillationData(traces, opts);
      const version = this._getNextDistillationVersion(skillId);
      const distilledProcedure = this._buildDistilledProcedure(skillId, patterns, decisionTrees, errorRecoveryPaths, version);

      if (this._skillImprovementLoop && typeof this._skillImprovementLoop.checkFlywheelGate === 'function') {
        safeCall(() => {
          this._skillImprovementLoop.checkFlywheelGate(skillId);
        }, 'SkillDistiller', 'flywheelGateCheck');
      }

      await this._writeDistilledFile(skillId, distilledProcedure);
      if (this._shutDown) return { skillId, status: 'aborted', error: 'Shut down during distillation' };

      this._recordDistillation(skillId, version, patterns, decisionTrees, errorRecoveryPaths, traces.length);
      await this._persistHistory();
      if (this._shutDown) return { skillId, status: 'aborted', error: 'Shut down during distillation' };

      distillState.status = 'distilled';
      distillState.version = version;
      distillState.patterns = patterns;
      distillState.decisionTrees = decisionTrees;
      distillState.errorRecoveryPaths = errorRecoveryPaths;

      this._stats.totalDistillations++;
      this.emit('skill-distilled', { skillId, version, traceCount: traces.length });

      return {
        skillId,
        version,
        patterns,
        decisionTrees,
        errorRecoveryPaths,
        traceCount: traces.length,
      };
    } catch (err) {
      distillState.status = 'failed';
      distillState.error = err && err.message ? err.message : String(err);
      debug('distillSkill', err);
      return { skillId, error: distillState.error };
    }
  }

  async _extractDistillationData(traces, opts) {
    const patterns = this._extractCommonPatterns(traces);
    const decisionTrees = opts.includeDecisionTrees !== false ? await this.extractDecisionTree(traces) : [];
    const errorRecoveryPaths = opts.includeErrorRecovery !== false ? await this.extractErrorRecoveryPaths(traces) : [];
    return { patterns, decisionTrees, errorRecoveryPaths };
  }

  async _writeDistilledFile(skillId, distilledProcedure) {
    const distilledDir = path.resolve(DEFAULT_DISTILLED_DIR);
    await this._ensureDir(distilledDir);
    const filePath = path.join(distilledDir, skillId + '-distilled.md');
    await fsp.writeFile(filePath, distilledProcedure, UTF8);
    return filePath;
  }

  _recordDistillation(skillId, version, patterns, decisionTrees, errorRecoveryPaths, traceCount) {
    this._distillationHistory.push({
      skillId,
      version,
      patterns: patterns.length,
      decisionTrees: decisionTrees.length,
      errorRecoveryPaths: errorRecoveryPaths.length,
      traceCount,
      distilledAt: Date.now(),
    });
  }

  /**
   * 重写技能步骤，将蒸馏过程追加到技能文件的frontmatter和正文中。
   * @async
   * @param {string} skillId - 技能标识
   * @param {string} distilledProcedure - 蒸馏过程文本
   * @returns {Promise<object>} 重写结果，包含skillId、version、changes；失败时包含error
   * @emits SkillDistiller#skill-rewritten
   */
  async rewriteSkillSteps(skillId, distilledProcedure) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') {
      return { skillId: null, error: 'skillId is required' };
    }
    if (!distilledProcedure || typeof distilledProcedure !== 'string') {
      return { skillId, error: 'distilledProcedure is required and must be a string' };
    }

    const skillFilePath = path.join(this._skillsDir, skillId + '.md');
    let content;
    try {
      content = await fsp.readFile(skillFilePath, UTF8);
    } catch (readErr) {
      return { skillId, error: 'Failed to read skill file: ' + (readErr && readErr.message ? readErr.message : String(readErr)) };
    }

    await this._backupSkillFile(skillId);
    if (this._shutDown) return { skillId, status: 'aborted', error: 'Shut down during rewrite' };

    const parsed = this._parseSkillFrontmatter(content);
    const version = this._getNextDistillationVersion(skillId);
    parsed.frontmatter.distilled = true;
    parsed.frontmatter.distilledVersion = version;
    parsed.frontmatter.model_tier = 'small';

    const newFrontmatter = this._serializeSkillFrontmatter(parsed.frontmatter);
    const newBody = parsed.body + '\n\n' + DISTILLED_MARKER + '\n' + distilledProcedure + '\n';
    const newContent = newFrontmatter + newBody;

    try {
      await fsp.writeFile(skillFilePath, newContent, UTF8);
    } catch (writeErr) {
      return { skillId, error: 'Failed to write skill file: ' + (writeErr && writeErr.message ? writeErr.message : String(writeErr)) };
    }

    const changes = { distilled: true, distilledVersion: version, markerAdded: true };
    this.emit('skill-rewritten', { skillId, version, changes });
    return { skillId, version, changes };
  }

  /**
   * 评估蒸馏效果，比较蒸馏前后的成功率、步骤效率和错误恢复率，判断是否收敛。
   * @async
   * @param {string} skillId - 技能标识
   * @param {object} [options] - 评估选项
   * @param {number} [options.minImprovement] - 判定收敛所需的最小改进阈值，默认使用convergenceThreshold
   * @returns {Promise<object>} 评估结果，包含skillId、beforeMetrics、afterMetrics、improvement、converged
   * @emits SkillDistiller#distillation-evaluated
   */
  async evaluateDistillation(skillId, options) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') {
      return { skillId: null, error: 'skillId is required' };
    }
    const opts = options ?? {};
    const minImprovement = opts.minImprovement ?? this._convergenceThreshold;

    const beforeMetrics = this._getSkillMetrics(skillId);

    const traces = this._collectTracesForSkill(skillId);
    const recentTraces = traces.slice(-10);
    let afterSuccessRate = 0;
    let afterStepEfficiency = 0;
    let afterErrorRecoveryRate = 0;
    if (recentTraces.length > 0) {
      const successes = recentTraces.filter(t => t.outcome && t.outcome.success).length;
      afterSuccessRate = successes / recentTraces.length;
      const totalSteps = recentTraces.reduce((sum, t) => sum + (Array.isArray(t.steps) ? t.steps.length : 0), 0);
      afterStepEfficiency = recentTraces.length > 0 ? totalSteps / recentTraces.length : 0;
      const recoveredTraces = recentTraces.filter(t =>
        Array.isArray(t.steps) && t.steps.some(s => !s.success) && t.outcome && t.outcome.success,
      ).length;
      const failedStepTraces = recentTraces.filter(t =>
        Array.isArray(t.steps) && t.steps.some(s => !s.success),
      ).length;
      afterErrorRecoveryRate = failedStepTraces > 0 ? recoveredTraces / failedStepTraces : 1;
    }

    const afterMetrics = {
      successRate: afterSuccessRate,
      stepEfficiency: afterStepEfficiency,
      errorRecoveryRate: afterErrorRecoveryRate,
    };

    const successRateImprovement = afterSuccessRate - (beforeMetrics.successRate ?? 0);
    const improvement = Math.max(0, successRateImprovement);

    let converged = false;
    if (this._convergenceDetector && typeof this._convergenceDetector.checkConvergence === 'function') {
      try {
        const result = this._convergenceDetector.checkConvergence(skillId, improvement);
        converged = !!result.converged;
      } catch (_err) {
        debug('SkillDistiller', 'checkConvergence:failed', _err && _err.message ? _err.message : String(_err));
        converged = improvement >= minImprovement;
      }
    } else {
      converged = improvement >= minImprovement;
    }

    if (converged) {
      this._stats.totalConverged++;
    }

    this._stats.totalEvals++;
    this.emit('distillation-evaluated', { skillId, improvement, converged });

    return {
      skillId,
      beforeMetrics,
      afterMetrics,
      improvement,
      converged,
    };
  }

  /**
   * 金丝雀部署蒸馏技能，通过SkillCanary或直接替换方式将蒸馏结果部署到生产环境。
   * @async
   * @param {string} skillId - 技能标识
   * @param {object} [options] - 部署选项
   * @param {number} [options.trafficPercent=20] - 金丝雀流量百分比
   * @param {number} [options.evalRounds=10] - 评估轮次
   * @param {number} [options.successThreshold=0.8] - 成功率阈值
   * @returns {Promise<object>} 部署结果，包含skillId、trafficPercent、phase；失败时包含error
   * @emits SkillDistiller#canary-deployed
   */
  async canaryDeployDistilled(skillId, options) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') {
      return { skillId: null, error: 'skillId is required' };
    }
    const opts = options ?? {};
    const trafficPercent = opts.trafficPercent ?? CANARY_TRAFFIC_PERCENT;
    const evalRounds = opts.evalRounds ?? CANARY_EVAL_ROUNDS;
    const successThreshold = opts.successThreshold ?? CANARY_SUCCESS_THRESHOLD;

    if (this._skillCanary && typeof this._skillCanary.enableCanary === 'function') {
      const enabled = this._skillCanary.enableCanary(skillId, {
        trafficPercent,
        minSamples: evalRounds,
        successRateThreshold: successThreshold,
      });
      if (!enabled) {
        return { skillId, error: 'Failed to enable canary via SkillCanary' };
      }
      this._stats.totalCanaryDeploys++;
      this.emit('canary-deployed', { skillId, trafficPercent, phase: 'canary' });
      return { skillId, trafficPercent, phase: 'canary' };
    }

    const distilledFilePath = path.join(path.resolve(DEFAULT_DISTILLED_DIR), skillId + '-distilled.md');
    let distilledContent;
    try {
      distilledContent = await fsp.readFile(distilledFilePath, UTF8);
    } catch (err) {
      return { skillId, error: 'Distilled skill file not found: ' + (err && err.message ? err.message : String(err)) };
    }

    const skillFilePath = path.join(this._skillsDir, skillId + '.md');
    await this._backupSkillFile(skillId);
    if (this._shutDown) return { skillId, status: 'aborted', error: 'Shut down during canary' };

    try {
      await fsp.writeFile(skillFilePath, distilledContent, UTF8);
    } catch (writeErr) {
      return { skillId, error: 'Failed to deploy distilled skill: ' + (writeErr && writeErr.message ? writeErr.message : String(writeErr)) };
    }
    if (this._shutDown) return { skillId, status: 'aborted', error: 'Shut down during canary' };

    this._stats.totalCanaryDeploys++;
    this.emit('canary-deployed', { skillId, trafficPercent: 100, phase: 'full-deploy' });
    return { skillId, trafficPercent: 100, phase: 'full-deploy' };
  }

  /**
   * 完整蒸馏流水线，依次执行蒸馏、重写、评估，收敛后可选金丝雀部署。
   * 最多迭代maxIterations轮，直到评估收敛或达到最大迭代次数。
   * @async
   * @param {string} skillId - 技能标识
   * @param {object} [options] - 流水线选项
   * @param {boolean} [options.forceRedistill=false] - 是否强制重新蒸馏
   * @param {boolean} [options.skipCanary=false] - 是否跳过金丝雀部署
   * @param {number} [options.maxIterations=3] - 最大迭代次数
   * @returns {Promise<object>} 流水线结果，包含skillId、status、iterations、finalImprovement；失败时包含error
   * @emits SkillDistiller#distillation-not-converged
   */
  async fullDistillationPipeline(skillId, options) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') {
      return { skillId: null, error: 'skillId is required' };
    }
    const opts = options ?? {};
    const forceRedistill = opts.forceRedistill ?? false;
    const skipCanary = opts.skipCanary ?? false;
    const maxIterations = opts.maxIterations ?? 3;

    let iteration = 0;
    let lastImprovement = 0;
    let status = 'not-converged';

    while (iteration < maxIterations) {
      iteration++;

      const distillResult = await this.distillSkill(skillId, { forceRedistill: forceRedistill || iteration > 1 });
      if (this._shutDown) return { skillId, status: 'aborted', error: 'Shut down during pipeline' };
      if (distillResult.error) {
        return { skillId, status: 'error', iterations: iteration, finalImprovement: 0, error: distillResult.error };
      }

      const procedure = this._buildDistilledProcedureFromResult(distillResult);
      const rewriteResult = await this.rewriteSkillSteps(skillId, procedure);
      if (rewriteResult.error) {
        return { skillId, status: 'error', iterations: iteration, finalImprovement: 0, error: rewriteResult.error };
      }

      const evalResult = await this.evaluateDistillation(skillId, { minImprovement: this._convergenceThreshold });
      lastImprovement = evalResult.improvement ?? 0;

      if (evalResult.converged) {
        status = 'converged';
        if (!skipCanary) {
          const canaryResult = await this.canaryDeployDistilled(skillId);
          if (this._shutDown) return { skillId, status: 'aborted', error: 'Shut down during pipeline' };
          if (canaryResult.error) {
            this._stats.totalRolledBack++;
            return { skillId, status: 'canary-failed', iterations: iteration, finalImprovement: lastImprovement, error: canaryResult.error };
          }
          status = 'canary-deployed';
        }
        break;
      }
    }

    if (status === 'not-converged') {
      this.emit('distillation-not-converged', {
        skillId,
        iterations: iteration,
        finalImprovement: lastImprovement,
        suggestions: [
          'Increase trace count for more pattern coverage',
          'Lower convergenceThreshold to accept smaller improvements',
          'Review error recovery paths for completeness',
        ],
      });
    }

    return {
      skillId,
      status,
      iterations: iteration,
      finalImprovement: lastImprovement,
    };
  }

  /**
   * 从执行追踪中提取决策树，识别分支点和各分支的后续步骤及频率。
   * @async
   * @param {Array<object>} traces - 执行追踪数组，每项包含steps数组
   * @returns {Promise<Array<object>>} 决策树节点数组，按频率降序排列；每项包含nodeId、condition、branches、frequency
   */
  async extractDecisionTree(traces) {
    this.guardShutdown();
    if (!Array.isArray(traces) || traces.length === 0) return [];

    const branchPoints = new Map();
    for (const trace of traces) {
      if (!Array.isArray(trace.steps)) continue;
      for (let i = 0; i < trace.steps.length; i++) {
        const step = trace.steps[i];
        if (!step || !step.decision) continue;
        const key = step.action + '|' + (step.tool || '');
        if (!branchPoints.has(key)) {
          branchPoints.set(key, {
            nodeId: 'node-' + branchPoints.size,
            condition: step.decision,
            branches: [],
            frequency: 0,
          });
        }
        const bp = branchPoints.get(key);
        bp.frequency++;
        const outcome = step.success ? 'success' : 'failure';
        const nextSteps = trace.steps.slice(i + 1, i + 4).map(s => s ? s.action : '');
        const existingBranch = bp.branches.find(b => b.outcome === outcome);
        if (existingBranch) {
          existingBranch.frequency++;
        } else {
          bp.branches.push({ outcome, nextSteps, frequency: 1 });
        }
      }
    }

    return Array.from(branchPoints.values()).sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * 从执行追踪中提取错误恢复路径，识别失败步骤及对应的恢复动作和成功率。
   * @async
   * @param {Array<object>} traces - 执行追踪数组，每项包含steps数组
   * @returns {Promise<Array<object>>} 错误恢复路径数组，按失败次数降序排列；每项包含failedStep、error、recoveryActions、count
   */
  async extractErrorRecoveryPaths(traces) {
    this.guardShutdown();
    if (!Array.isArray(traces) || traces.length === 0) return [];

    const recoveryMap = new Map();
    for (const trace of traces) {
      if (!Array.isArray(trace.steps)) continue;
      for (let i = 0; i < trace.steps.length; i++) {
        const step = trace.steps[i];
        if (!step || step.success) continue;
        const recoveryStep = i + 1 < trace.steps.length ? trace.steps[i + 1] : null;
        if (!recoveryStep) continue;
        const key = step.action + '|' + (step.tool || '');
        if (!recoveryMap.has(key)) {
          recoveryMap.set(key, {
            failedStep: step.action,
            error: step.output || 'unknown error',
            recoveryActions: [],
            count: 0,
          });
        }
        const entry = recoveryMap.get(key);
        entry.count++;
        const existingAction = entry.recoveryActions.find(ra => ra.action === recoveryStep.action);
        if (existingAction) {
          existingAction.frequency++;
          if (recoveryStep.success) existingAction.successCount++;
        } else {
          entry.recoveryActions.push({
            action: recoveryStep.action,
            tool: recoveryStep.tool || '',
            frequency: 1,
            successCount: recoveryStep.success ? 1 : 0,
            outcome: trace.outcome && trace.outcome.success ? 'recovered' : 'not-recovered',
          });
        }
      }
    }

    return Array.from(recoveryMap.values()).sort((a, b) => b.count - a.count);
  }

  getStats() {
    return { ...this._stats };
  }

  isHealthy() {
    return !this._shutDown && this._initialized;
  }

  getDistillationHistory(skillId) {
    const all = this._distillationHistory.toArray().map(h => ({ ...h }));
    if (!skillId) return all;
    return all.filter(h => h.skillId === skillId);
  }

  _onShutdown() {
    this._initialized = false;
    safeCall(() => {
      const historyPath = path.join(path.resolve(DEFAULT_DISTILLED_DIR), 'history.json');
      const data = this._distillationHistory.toArray();
      fs.writeFileSync(historyPath, JSON.stringify(data, null, 2), UTF8);
    }, 'SkillDistiller', 'persistHistory');
    this._skillImprover = null;
    this._skillImprovementLoop = null;
    this._playbookGenerator = null;
    this._skillCanary = null;
    this._skillCurator = null;
    this._dreamEngine = null;
    this._convergenceDetector = null;
    this._stats = {
      totalTracesCaptured: 0,
      totalDistillations: 0,
      totalEvals: 0,
      totalCanaryDeploys: 0,
      totalConverged: 0,
      totalRolledBack: 0,
    };
    this._executionTraces.clear();
    this._distillationHistory.clear();
    this._activeDistillations.clear();
    this.removeAllListeners();
  }

  _collectTracesForSkill(skillId) {
    return this._executionTraces.filter(t => t && t.skillId === skillId);
  }

  _extractCommonPatterns(traces) {
    if (!Array.isArray(traces) || traces.length === 0) return [];
    const seqMap = new Map();
    for (const trace of traces) {
      if (!Array.isArray(trace.steps) || trace.steps.length === 0) continue;
      const actions = trace.steps.map(s => s ? s.action : '').filter(Boolean);
      for (let len = 2; len <= Math.min(actions.length, 5); len++) {
        for (let i = 0; i <= actions.length - len; i++) {
          const seq = actions.slice(i, i + len).join(' → ');
          seqMap.set(seq, (seqMap.get(seq) ?? 0) + 1);
        }
      }
    }
    const patterns = [];
    for (const [sequence, frequency] of seqMap) {
      if (frequency >= 2) {
        patterns.push({ sequence, frequency, confidence: Math.min(1, frequency / traces.length) });
      }
    }
    return patterns.sort((a, b) => b.frequency - a.frequency).slice(0, 20);
  }

  _parseSkillFrontmatter(content) {
    if (!content || !content.startsWith('---')) {
      return { frontmatter: {}, body: content || '' };
    }
    const pos1 = content.indexOf('\r\n---', 3);
    const pos2 = content.indexOf('\n---', 3);
    let secondSep = -1;
    if (pos1 !== -1 && pos2 !== -1) secondSep = Math.min(pos1, pos2);
    else if (pos1 !== -1) secondSep = pos1;
    else secondSep = pos2;
    if (secondSep === -1) {
      return { frontmatter: {}, body: content };
    }
    const sepEnd = content[secondSep] === '\r' ? secondSep + 5 : secondSep + 4;
    const fmText = content.substring(3, secondSep).trim();
    const body = content.substring(sepEnd).trim();
    const frontmatter = {};
    for (const line of fmText.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.substring(0, colonIdx).trim();
      const val = line.substring(colonIdx + 1).trim();
      if (val === 'true') frontmatter[key] = true;
      else if (val === 'false') frontmatter[key] = false;
      else if (/^\d+$/.test(val)) { const n = parseInt(val, 10); frontmatter[key] = Number.isFinite(n) ? n : val; }
      else if (/^\d+\.\d+$/.test(val)) { const n = parseFloat(val); frontmatter[key] = Number.isFinite(n) ? n : val; }
      else frontmatter[key] = val;
    }
    return { frontmatter, body };
  }

  _serializeSkillFrontmatter(frontmatter) {
    if (!frontmatter || typeof frontmatter !== 'object') return '';
    const lines = ['---'];
    for (const [key, val] of Object.entries(frontmatter)) {
      if (typeof val === 'boolean') lines.push(key + ': ' + val);
      else if (typeof val === 'number') lines.push(key + ': ' + val);
      else lines.push(key + ': ' + String(val));
    }
    lines.push('---');
    return lines.join('\n') + '\n';
  }

  async _backupSkillFile(skillId) {
    const skillFilePath = path.join(this._skillsDir, skillId + '.md');
    const backupDir = path.join(this._skillsDir, '.backups');
    await this._ensureDir(backupDir);
    const ts = Date.now();
    const backupPath = path.join(backupDir, skillId + '.' + ts + '.md');
    try {
      await fsp.copyFile(skillFilePath, backupPath);
    } catch (copyErr) {
      debug('_backupSkillFile', copyErr && copyErr.message ? copyErr.message : String(copyErr));
      throw copyErr;
    }
  }

  async _ensureDir(dirPath) {
    try {
      await fsp.mkdir(dirPath, { recursive: true });
    } catch (_err) {
      debug('_ensureDir', _err && _err.message ? _err.message : String(_err));
    }
  }

  async _persistHistory() {
    const historyPath = path.join(path.resolve(DEFAULT_DISTILLED_DIR), 'history.json');
    const data = this._distillationHistory.toArray();
    try {
      await this._ensureDir(path.resolve(DEFAULT_DISTILLED_DIR));
      await fsp.writeFile(historyPath, JSON.stringify(data, null, 2), UTF8);
    } catch (err) {
      debug('_persistHistory', err && err.message ? err.message : String(err));
    }
  }

  _getNextDistillationVersion(skillId) {
    const history = this.getDistillationHistory(skillId);
    let maxVersion = 0;
    for (const h of history) {
      if (typeof h.version === 'number' && h.version > maxVersion) maxVersion = h.version;
    }
    return maxVersion + 1;
  }

  _getSkillMetrics(skillId) {
    if (this._skillCurator && typeof this._skillCurator.getSkillStats === 'function') {
      const stats = this._skillCurator.getSkillStats(skillId);
      if (stats) {
        return {
          successRate: stats.calls > 0 ? stats.successes / stats.calls : 0,
          stepEfficiency: stats.calls > 0 ? stats.totalDuration / stats.calls : 0,
          errorRecoveryRate: 0,
        };
      }
    }
    const traces = this._collectTracesForSkill(skillId);
    if (traces.length === 0) {
      return { successRate: 0, stepEfficiency: 0, errorRecoveryRate: 0 };
    }
    const successes = traces.filter(t => t.outcome && t.outcome.success).length;
    const totalSteps = traces.reduce((sum, t) => sum + (Array.isArray(t.steps) ? t.steps.length : 0), 0);
    const failedStepTraces = traces.filter(t => Array.isArray(t.steps) && t.steps.some(s => !s.success));
    const recoveredTraces = failedStepTraces.filter(t => t.outcome && t.outcome.success);
    return {
      successRate: successes / traces.length,
      stepEfficiency: totalSteps / traces.length,
      errorRecoveryRate: failedStepTraces.length > 0 ? recoveredTraces.length / failedStepTraces.length : 1,
    };
  }

  _buildDistilledProcedure(skillId, patterns, decisionTrees, errorRecoveryPaths, version) {
    let md = '# Distilled Procedure: ' + skillId + ' (v' + version + ')\n\n';
    md += '> Auto-distilled from execution traces at ' + new Date().toISOString() + '\n\n';
    md += '> **Model Tier: small** — This skill has been distilled into procedural steps executable by small models.\n\n';
    md += '## Core Steps\n\n';
    if (patterns.length > 0) {
      const topPatterns = patterns.slice(0, 5);
      for (let i = 0; i < topPatterns.length; i++) {
        md += (i + 1) + '. ' + topPatterns[i].sequence + ' (freq: ' + topPatterns[i].frequency + ', confidence: ' + topPatterns[i].confidence.toFixed(2) + ')\n';
      }
    } else {
      md += 'No common patterns found.\n';
    }
    if (decisionTrees.length > 0) {
      md += '\n## Decision Trees\n\n';
      for (const dt of decisionTrees) {
        md += '### ' + dt.condition + ' (frequency: ' + dt.frequency + ')\n';
        for (const branch of dt.branches) {
          md += '- **' + branch.outcome + '**: ' + branch.nextSteps.join(' → ') + ' (freq: ' + branch.frequency + ')\n';
        }
      }
    }
    if (errorRecoveryPaths.length > 0) {
      md += '\n## Error Recovery Paths\n\n';
      for (const erp of errorRecoveryPaths) {
        md += '### Failed: ' + erp.failedStep + ' (occurred ' + erp.count + ' times)\n';
        md += 'Error: ' + erp.error + '\n';
        for (const ra of erp.recoveryActions) {
          md += '- Recovery: ' + ra.action + ' (freq: ' + ra.frequency + ', success: ' + ra.successCount + '/' + ra.frequency + ')\n';
        }
      }
    }
    return md;
  }

  _buildDistilledProcedureFromResult(distillResult) {
    if (!distillResult || distillResult.error) return '';
    return this._buildDistilledProcedure(
      distillResult.skillId,
      distillResult.patterns ?? [],
      distillResult.decisionTrees ?? [],
      distillResult.errorRecoveryPaths ?? [],
      distillResult.version ?? 1,
    );
  }
}

module.exports = withShutdown(SkillDistiller);
Object.assign(module.exports, {
  DEFAULT_SKILLS_DIR,
  DEFAULT_DISTILLED_DIR,
  MAX_TRACES,
  MAX_DISTILLATIONS,
  MIN_TRACES_FOR_DISTILLATION,
  CONVERGENCE_THRESHOLD,
  CANARY_TRAFFIC_PERCENT,
  CANARY_EVAL_ROUNDS,
  CANARY_SUCCESS_THRESHOLD,
});
