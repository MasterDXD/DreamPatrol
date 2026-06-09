'use strict';

/**
 * @module runtime/workflow/pipeline-executor
 * @description 多步骤管道执行器，负责技能调度与验证的完整执行流程编排。
 * 集成可编程钩子执行器、安全链和提示词构建器，支持命令解析→意图解析→技能匹配→
 * 前置检查→协作模式选择→超时执行→后置验证的完整管道。
 */

const { ERROR_CODES, PipelineError } = require('../../errors');
const { timestampId } = require('../../utils/unique-id');
const { DEFAULT_PIPELINE_TIMEOUT_MS } = require('../../utils/constants');
const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');

let _promptBuilder = null;
let _securityChain = null;

/**
 * 附加提示词构建器，用于管道执行过程中的提示词编译。
 * @param {Object} promptBuilder - 提示词构建器实例，需实现build方法
 */
function attachPromptBuilder(promptBuilder) {
  _promptBuilder = promptBuilder;
}

/**
 * 附加安全链，用于管道执行过程中的工具调用安全检查。
 * @param {Object} securityChain - 安全链实例，需实现check方法
 */
function attachSecurityChain(securityChain) {
  _securityChain = securityChain;
}

function _runSecurityCheck(toolCall, context) {
  if (!_securityChain) return { allowed: true, layer: null, reason: null, duration: 0, details: [] };
  return _securityChain.check(toolCall, context);
}

function _checkToolCallSecurity(opts, task, matchedSkills, pipelineResult, startTime) {
  if (!opts.toolCall) return false;
  const securityResult = _runSecurityCheck(opts.toolCall, { agentId: opts.agent, permissions: opts.permissions, requireApproval: opts.requireApproval, highRisk: opts.highRisk });
  pipelineResult.securityCheck = securityResult;
  if (!securityResult.allowed) {
    pipelineResult.status = 'security_blocked';
    pipelineResult.securityBlock = { layer: securityResult.layer, reason: securityResult.reason };
    pipelineResult.durationMs = Date.now() - startTime;
    return true;
  }
  return false;
}

function _buildPromptInfo(opts, task, matchedSkills, pipelineResult) {
  if (!_promptBuilder || !opts.agent) return;
  const promptResult = _promptBuilder.buildSystemPrompt(opts.agent, {
    taskContext: task.description,
    environment: opts.environment,
    sessionState: opts.sessionState,
    recentActions: opts.recentActions,
    skillIds: matchedSkills.map(function(s) { return s.skill_id; }),
  });
  pipelineResult.promptInfo = promptResult ? { prefixHash: promptResult.prefixHash, staticTokenCount: promptResult.staticTokenCount, dynamicTokenCount: promptResult.dynamicTokenCount } : null;
}

function _resolveCommand(ctx, userMessage) {
  if (!ctx.commandRouter) return null;
  if (!ctx.commandRouter.isCommand(userMessage)) return null;
  return ctx.commandRouter.getExecutionPlan(userMessage);
}

function _parseIntent(ctx, userMessage, opts) {
  if (!ctx.structuredIntent) {
    return { goal: userMessage, constraints: [], successCriteria: [], completeness: 0, clarificationNeeded: false, clarificationPrompt: null, _raw: null };
  }
  const intentResult = ctx.structuredIntent.parseIntent(userMessage, opts.skillId);
  if (!intentResult) {
    return { goal: userMessage, constraints: [], successCriteria: [], completeness: 0, clarificationNeeded: false, clarificationPrompt: null, _raw: null };
  }
  const p = intentResult.params ?? {};
  return {
    goal: p.description || userMessage,
    constraints: p.constraints ?? [],
    successCriteria: p.success_criteria ? [p.success_criteria] : [],
    completeness: intentResult.completeness,
    clarificationNeeded: intentResult.clarificationNeeded,
    clarificationPrompt: intentResult.clarificationPrompt,
    _raw: intentResult,
  };
}

function _matchSkills(ctx, userMessage, opts, commandPlan) {
  if (commandPlan) {
    return commandPlan.skills.map(function(sid) { return ctx.router.getSkill(sid); }).filter(Boolean);
  }
  return ctx.router.match({
    userMessage: userMessage,
    agent: opts.agent,
    completedSkills: opts.completedSkills ?? [],
  });
}

function _selectCollaborationMode(ctx, intent, userMessage, opts) {
  if (!ctx.collaborationModeRouter) {
    return { mode: 'solo', confidence: 0, reasoning: 'collaborationModeRouter not available', allScores: {} };
  }
  return ctx.collaborationModeRouter.selectMode({
    taskDescription: intent.goal || userMessage,
    taskTraits: intent.constraints ?? [],
    availableAgents: opts.availableAgents ?? 3,
    sessionId: opts.sessionId,
  });
}

function _buildTask(intent, userMessage, opts, matchedSkills) {
  return {
    description: intent.goal || userMessage,
    goal: intent.goal,
    constraints: intent.constraints ?? [],
    successCriteria: opts.successCriteriaOverride ?? (intent.successCriteria ?? []),
    sessionId: opts.sessionId,
    skillId: matchedSkills.length > 0 ? matchedSkills[0].skill_id : null,
    traits: intent.constraints ?? [],
    availableAgents: opts.availableAgents ?? 3,
    subtasks: opts.subtasks ?? null,
    agentConfigs: opts.agentConfigs ?? null,
  };
}

function _verifyGoalAchievement(task, goalVerification) {
  const criteria = task.successCriteria;
  if (!criteria || criteria.length === 0) {
    return { achieved: true, message: 'No success criteria defined, goal considered achieved' };
  }

  const results = [];
  let allAchieved = true;

  for (const criterion of criteria) {
    const criterionStr = typeof criterion === 'string' ? criterion : String(criterion);
    const verified = goalVerification[criterionStr] === true
      || goalVerification[criterionStr] === 'passed'
      || (typeof goalVerification[criterionStr] === 'object' && goalVerification[criterionStr] !== null && goalVerification[criterionStr].passed === true);

    results.push({ criterion: criterionStr, achieved: !!verified });
    if (!verified) allAchieved = false;
  }

  return {
    achieved: allAchieved,
    totalCriteria: criteria.length,
    achievedCount: results.filter(function(r) { return r.achieved; }).length,
    details: results,
    message: allAchieved
      ? 'All ' + criteria.length + ' success criteria achieved'
      : results.filter(function(r) { return r.achieved; }).length + '/' + criteria.length + ' success criteria achieved',
  };
}

function _runPreExecutionChecks(ctx, opts) {
  if (opts.tddContext) {
    if (!ctx.tddGate) {
      throw new PipelineError('PIPELINE_CONFIG_ERROR', 'tddGate is not available but tddContext was provided');
    }
    ctx.tddGate.enforceCheck(opts.tddContext);
  }

  if (opts.requireThinking && !opts.thinkingOutput) {
    const err = new PipelineError('PIPELINE_BLOCKED', 'Think Before Coding: provide assumptions, ambiguities, and simpler alternatives before implementation');
    err.status = 'thinking_required';
    err.requiredFields = ['assumptions', 'ambiguities', 'simpler_alternative'];
    throw err;
  }
}

function _verifyEvidence(ctx, opts, task, pipelineResult) {
  if (!opts.evidence || !ctx.verifier) return;
  const requiredTypes = ctx.verifier.getRequiredEvidenceTypes(task.skillId || '');
  const verifyResult = ctx.verifier.verify({
    claim: task.goal || task.description,
    evidence: opts.evidence,
    requiredTypes: requiredTypes,
    skillId: task.skillId,
    agentId: opts.agent,
  });
  pipelineResult.evidenceVerification = verifyResult;
  if (!verifyResult.verified) {
    pipelineResult.status = 'evidence_insufficient';
  }
}

function _verifyGoal(task, opts, pipelineResult) {
  if (!task.successCriteria || !opts.goalVerification) return;
  const goalResult = _verifyGoalAchievement(task, opts.goalVerification);
  pipelineResult.goalVerification = goalResult;
  if (!goalResult.achieved) {
    pipelineResult.status = 'goal_not_achieved';
  }
}

function _verifyCoverage(ctx, opts, pipelineResult) {
  if (!opts.tddContext || opts.tddContext.coverage === undefined || !ctx.tddGate) return;
  try {
    ctx.tddGate.enforceCoverage(opts.tddContext);
  } catch (coverageErr) {
    pipelineResult.coverageViolation = coverageErr && coverageErr.message ? coverageErr.message : String(coverageErr);
  }
}

async function _runPostExecutionChecks(ctx, opts, task, pipelineResult, hookContext) {
  _verifyEvidence(ctx, opts, task, pipelineResult);
  _verifyGoal(task, opts, pipelineResult);
  _verifyCoverage(ctx, opts, pipelineResult);

  let postTaskResults;
  try { postTaskResults = await ctx.programmableHookExecutor.execute('post_task_complete', hookContext); } catch (hookErr) { debug('PipelineExecutor', 'postTaskHook', hookErr && hookErr.message ? hookErr.message : String(hookErr)); postTaskResults = []; }
  pipelineResult.postTaskChecks = postTaskResults;

  if (opts.diff || opts.changes || (pipelineResult.execution && pipelineResult.execution.files)) {
    const fileWriteContext = mergeConfig(hookContext, {
      diff: opts.diff || '',
      changes: opts.changes || '',
      new_files: (pipelineResult.execution && pipelineResult.execution.files) ?? [],
      line_budget: opts.lineBudget ?? 0,
      task_type: task.skillId || '',
    });
    let fileWriteResults;
    try { fileWriteResults = await ctx.programmableHookExecutor.execute('post_file_write', fileWriteContext); } catch (hookErr) { debug('PipelineExecutor', 'postFileHook', hookErr && hookErr.message ? hookErr.message : String(hookErr)); fileWriteResults = []; }
    pipelineResult.fileWriteChecks = fileWriteResults;
  }
}

async function _executeWithTimeout(ctx, task, opts, pipelineResult) {
  const timeoutMs = opts.timeout ?? DEFAULT_PIPELINE_TIMEOUT_MS;
  let timeoutId;
  const abortController = new AbortController();
  const originalSignal = opts.signal;
  let abortHandler;
  if (originalSignal) {
    if (originalSignal.aborted) {
      pipelineResult.execution = { error: 'Operation was aborted before execution' };
      pipelineResult.executed = false;
      pipelineResult.status = 'aborted';
      return;
    }
    abortHandler = function() { abortController.abort(); };
    originalSignal.addEventListener('abort', abortHandler, { once: true });
  }
  try {
    const execOpts = { signal: abortController.signal };
    if (!ctx.collaborationModeRouter) {
      pipelineResult.status = 'error';
      pipelineResult.error = 'No collaborationModeRouter available';
      pipelineResult.phase = 'execution';
      return { status: 'error', error: 'No collaborationModeRouter available', phase: 'execution' };
    }
    const execPromise = ctx.collaborationModeRouter.executeWithMode(task, opts.executeFn, opts.verifyFn, execOpts);
    execPromise.catch(function(err) { debug('PipelineExecutor', 'executionFailed', err && err.message ? err.message : String(err)); });
    pipelineResult.execution = await Promise.race([
      execPromise,
      new Promise(function(_, reject) {
        timeoutId = setTimeout(function() {
          abortController.abort();
          reject(new PipelineError('PIPELINE_TIMEOUT', 'Pipeline timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
      }),
    ]);
    pipelineResult.executed = true;
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    pipelineResult.execution = { error: errMsg };
    pipelineResult.executed = false;
    pipelineResult.status = errMsg.includes('timed out') ? 'timeout' : 'execution_error';
    if (pipelineResult.status === 'timeout') {
      pipelineResult.orphanedExecution = true;
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (originalSignal && abortHandler) originalSignal.removeEventListener('abort', abortHandler);
  }
}

function _checkEarlyReturn(ctx, userMessage, requestId) {
  if (ctx._destroying) {
    return {
      status: 'error',
      code: ERROR_CODES.SHUTDOWN_IN_PROGRESS,
      message: 'System is shutting down, cannot accept new requests',
      requestId: requestId,
      timestamp: Date.now(),
    };
  }
  if (!userMessage || typeof userMessage !== 'string') {
    return {
      status: 'error',
      code: ERROR_CODES.INVALID_INPUT,
      message: 'userMessage must be a non-empty string',
      requestId: requestId,
      timestamp: Date.now(),
    };
  }
  return null;
}

function _buildHookContext(ctx, opts, matchedSkills, userMessage, requestId) {
  return {
    project_root: ctx.projectRoot,
    agent_id: opts.agent || '',
    skill_id: matchedSkills.length > 0 ? matchedSkills[0].skill_id : '',
    user_message: userMessage,
    session_id: opts.sessionId || '',
    request_id: requestId,
  };
}

function _initPipelineResult(requestId, intent, matchedSkills, commandPlan, modeResult, task, preToolResults) {
  return {
    status: 'success',
    requestId: requestId,
    intent: intent,
    intentResult: intent._raw,
    matchedSkills: matchedSkills,
    command: commandPlan ? { commandId: commandPlan.commandId, name: commandPlan.name } : null,
    mode: modeResult.mode,
    modeConfidence: modeResult.confidence,
    modeReason: modeResult.reasoning,
    modeAllScores: modeResult.allScores ?? {},
    task: task,
    preToolChecks: preToolResults,
    timestamp: Date.now(),
  };
}

function _handleClarificationNeeded(intent, matchedSkills, commandPlan) {
  return {
    status: 'clarification_needed',
    clarificationPrompt: intent.clarificationPrompt,
    intent: intent,
    matchedSkills: matchedSkills,
    command: commandPlan ? { commandId: commandPlan.commandId, name: commandPlan.name } : null,
    timestamp: Date.now(),
  };
}

function _handlePreExecutionBlocked(preToolBlocked, intent, matchedSkills) {
  return {
    status: 'blocked',
    reason: preToolBlocked.reason,
    hook: preToolBlocked.name,
    intent: intent,
    matchedSkills: matchedSkills,
    timestamp: Date.now(),
  };
}

function _handlePreExecutionError(preErr, task) {
  if (preErr.status === 'thinking_required') {
    return {
      status: 'thinking_required',
      reason: preErr && preErr.message ? preErr.message : String(preErr),
      requiredFields: preErr && preErr.requiredFields,
      task: task,
      timestamp: Date.now(),
    };
  }
  if (preErr && preErr.code) {
    return {
      status: 'tdd_violation',
      reason: preErr && preErr.message ? preErr.message : String(preErr),
      phase: preErr && preErr.code,
      task: task,
      timestamp: Date.now(),
    };
  }
  throw preErr;
}

async function _checkApprovalGate(ctx, intent, matchedSkills, userMessage, requestId) {
  if (!ctx.executionModeManager || !ctx.executionModeManager.requiresApproval('pipeline-pre-execution')) {
    return null;
  }
  const approval = await ctx.executionModeManager.requestApproval('pipeline-pre-execution', { intent: intent, skills: matchedSkills.map(function(s) { return s.skill_id; }), userMessage: userMessage });
  if (!approval.approved) {
    return { status: 'blocked', reason: approval.reason ?? 'approval-denied', requestId: requestId };
  }
  return null;
}

async function _runPreToolHooks(ctx, hookContext) {
  try { return await ctx.programmableHookExecutor.execute('pre_tool_call', hookContext); } catch (hookErr) { debug('PipelineExecutor', 'preToolHook', hookErr && hookErr.message ? hookErr.message : String(hookErr)); return []; }
}

/**
 * 执行完整管道流程：命令解析→意图解析→技能匹配→前置检查→协作模式选择→
 * 超时执行→后置验证（证据、目标达成、覆盖率）。
 * @param {Object} ctx - 管道上下文，包含router、commandRouter、structuredIntent、collaborationModeRouter等
 * @param {string} userMessage - 用户输入消息或斜杠命令
 * @param {Object} [options] - 执行选项（executeFn、verifyFn、agent、sessionId、timeout、evidence等）
 * @returns {Promise<Object>} 管道执行结果，包含status、matchedSkills、执行输出和验证结果
 */
async function executePipeline(ctx, userMessage, options) {
  const opts = options ?? {};
  const requestId = opts.requestId || timestampId();
  const startTime = Date.now();

  try {
    const earlyReturn = _checkEarlyReturn(ctx, userMessage, requestId);
    if (earlyReturn) return earlyReturn;

    const commandPlan = _resolveCommand(ctx, userMessage);
    const intent = _parseIntent(ctx, userMessage, opts);
    const matchedSkills = _matchSkills(ctx, userMessage, opts, commandPlan);

    if (intent.clarificationNeeded) {
      return mergeConfig(_handleClarificationNeeded(intent, matchedSkills, commandPlan), { requestId: requestId });
    }

    await _loadSkillL2(ctx, matchedSkills);

    const hookContext = _buildHookContext(ctx, opts, matchedSkills, userMessage, requestId);

    const approvalBlock = await _checkApprovalGate(ctx, intent, matchedSkills, userMessage, requestId);
    if (approvalBlock) return approvalBlock;

    const preToolResults = await _runPreToolHooks(ctx, hookContext);
    const preToolBlocked = preToolResults.find(function(r) { return !r.passed; });
    if (preToolBlocked) {
      return mergeConfig(_handlePreExecutionBlocked(preToolBlocked, intent, matchedSkills), { requestId: requestId });
    }

    const pipelineResult = await _executePipelineCore(ctx, opts, intent, matchedSkills, commandPlan, userMessage, hookContext, requestId, startTime);
    return pipelineResult;
  } catch (err) {
    return { status: 'error', error: err && err.message ? err.message : String(err), phase: 'pipeline-error', requestId, timestamp: Date.now() };
  }
}

async function _loadSkillL2(ctx, matchedSkills) {
  if (matchedSkills.length > 0 && matchedSkills[0] && matchedSkills[0].skill_id) {
    try { await ctx.router.loadL2Async(matchedSkills[0].skill_id); } catch (loadErr) { debug('PipelineExecutor', 'loadL2', loadErr && loadErr.message ? loadErr.message : String(loadErr)); }
  }
}

async function _executePipelineCore(ctx, opts, intent, matchedSkills, commandPlan, userMessage, hookContext, requestId, startTime) {
  const modeResult = _selectCollaborationMode(ctx, intent, userMessage, opts);
  const task = _buildTask(intent, userMessage, opts, matchedSkills);

  try {
    _runPreExecutionChecks(ctx, opts);
  } catch (preErr) {
    return mergeConfig(_handlePreExecutionError(preErr, task), { requestId: requestId });
  }

  const pipelineResult = _initPipelineResult(requestId, intent, matchedSkills, commandPlan, modeResult, task, []);

  if (_checkToolCallSecurity(opts, task, matchedSkills, pipelineResult, startTime)) {
    return pipelineResult;
  }

  _buildPromptInfo(opts, task, matchedSkills, pipelineResult);

  if (opts.executeFn) {
    await _executeWithTimeout(ctx, task, opts, pipelineResult);
  }

  if (pipelineResult.executed) {
    await _runPostExecutionChecks(ctx, opts, task, pipelineResult, hookContext);
  }

  pipelineResult.durationMs = Date.now() - startTime;
  if (ctx.structuredLog && typeof ctx.structuredLog.logPerformance === 'function') {
    ctx.structuredLog.logPerformance('executePipeline', pipelineResult.durationMs, {
      requestId: requestId,
      status: pipelineResult.status,
      skillId: task.skillId,
    });
  }

  return pipelineResult;
}

module.exports = { executePipeline, attachPromptBuilder, attachSecurityChain };
