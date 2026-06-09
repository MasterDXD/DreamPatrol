'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { executePipeline } = require('../../../src/runtime/workflow/pipeline-executor');
const { buildInstance, _destroyInstance, _buildPropertyMap, _buildGroupedAPI } = require('../../../src/runtime/infrastructure/instance-builder');

function _mockCtx(overrides) {
  const hookResults = [];
  const ctx = Object.assign({
    projectRoot: process.cwd(),
    _destroying: false,
    structuredLog: { info() {}, logPerformance() {}, warn() {} },
    commandRouter: { isCommand() { return false; }, getExecutionPlan() { return null; } },
    structuredIntent: { parseIntent() { return { params: {}, completeness: 1, clarificationNeeded: false }; } },
    router: { match() { return []; }, loadL2() {}, loadL2Async() { return Promise.resolve(); }, skills: [] },
    collaborationModeRouter: {
      selectMode() { return { mode: 'solo', confidence: 1, reasoning: 'test', allScores: {} }; },
      executeWithMode: async function() { return { success: true }; },
    },
    programmableHookExecutor: { execute: async function() { return hookResults; } },
    tddGate: { enforceCheck() {}, enforceCoverage() {} },
    verifier: { getRequiredEvidenceTypes() { return []; }, verify() { return { verified: true }; } },
    eventBus: { emit() {} },
    session: { getSession() { return { status: 'active' }; } },
  }, overrides);
  return ctx;
}

describe('PipelineExecutor', function() {
  describe('executePipeline - early returns', function() {
    it('should return error when system is shutting down', async function() {
      const ctx = _mockCtx({ _destroying: true });
      const result = await executePipeline(ctx, '/plan my feature');
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(result.code, 'SHUTDOWN_IN_PROGRESS');
    });

    it('should return error for empty userMessage', async function() {
      const ctx = _mockCtx();
      const result = await executePipeline(ctx, '');
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(result.code, 'INVALID_INPUT');
    });

    it('should return error for non-string userMessage', async function() {
      const ctx = _mockCtx();
      const result = await executePipeline(ctx, 123);
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(result.code, 'INVALID_INPUT');
    });

    it('should return error for null userMessage', async function() {
      const ctx = _mockCtx();
      const result = await executePipeline(ctx, null);
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(result.code, 'INVALID_INPUT');
    });
  });

  describe('executePipeline - command resolution', function() {
    it('should resolve slash commands via commandRouter', async function() {
      const commandPlan = { commandId: 'plan', name: 'plan', skills: ['brainstorming', 'requirement-analysis'] };
      const ctx = _mockCtx({
        commandRouter: {
          isCommand(msg) { return msg.startsWith('/'); },
          getExecutionPlan() { return commandPlan; },
        },
        router: {
          match() { return []; },
          getSkill(id) { return { skill_id: id }; },
          loadL2() {},
          loadL2Async() { return Promise.resolve(); },
          skills: [],
        },
      });
      const result = await executePipeline(ctx, '/plan my feature');
      assert.strictEqual(result.command.commandId, 'plan');
      assert.strictEqual(result.matchedSkills.length, 2);
    });
  });

  describe('executePipeline - clarification needed', function() {
    it('should return clarification_needed when intent requires clarification', async function() {
      const ctx = _mockCtx({
        structuredIntent: {
          parseIntent() {
            return {
              params: {},
              completeness: 0.3,
              clarificationNeeded: true,
              clarificationPrompt: 'What is the goal?',
            };
          },
        },
      });
      const result = await executePipeline(ctx, 'help me with something');
      assert.strictEqual(result.status, 'clarification_needed');
      assert.strictEqual(result.clarificationPrompt, 'What is the goal?');
    });
  });

  describe('executePipeline - pre-execution blocked', function() {
    it('should return blocked when pre-tool hook fails', async function() {
      const blockedResult = { passed: false, name: 'security_check', reason: 'Insufficient permissions' };
      const ctx = _mockCtx({
        programmableHookExecutor: { execute: async function() { return [blockedResult]; } },
      });
      const result = await executePipeline(ctx, 'do something');
      assert.strictEqual(result.status, 'blocked');
      assert.strictEqual(result.reason, 'Insufficient permissions');
    });
  });

  describe('executePipeline - TDD violation', function() {
    it('should return tdd_violation when TDD gate fails', async function() {
      const tddErr = new Error('RED phase required before GREEN');
      tddErr.code = 'TDD_RED_REQUIRED';
      const ctx = _mockCtx({
        tddGate: { enforceCheck() { throw tddErr; } },
        options: { tddContext: { phase: 'GREEN' } },
      });
      const opts = { tddContext: { phase: 'GREEN' } };
      const result = await executePipeline(ctx, 'implement feature', opts);
      assert.strictEqual(result.status, 'tdd_violation');
      assert.strictEqual(result.reason, 'RED phase required before GREEN');
    });
  });

  describe('executePipeline - thinking required', function() {
    it('should return thinking_required when thinkBeforeCoding is enforced', async function() {
      const ctx = _mockCtx({
        tddGate: { enforceCheck() {} },
      });
      const opts = { requireThinking: true, thinkingOutput: null };
      const result = await executePipeline(ctx, 'implement feature', opts);
      assert.strictEqual(result.status, 'thinking_required');
      assert.ok(result.requiredFields);
      assert.ok(result.requiredFields.includes('assumptions'));
    });
  });

  describe('executePipeline - successful execution', function() {
    it('should return success with pipeline result', async function() {
      const ctx = _mockCtx();
      const result = await executePipeline(ctx, 'do something');
      assert.strictEqual(result.status, 'success');
      assert.ok(result.requestId);
      assert.ok(result.intent);
      assert.ok(result.mode);
      assert.ok(result.task);
      assert.strictEqual(typeof result.durationMs, 'number');
    });

    it('should use custom requestId when provided', async function() {
      const ctx = _mockCtx();
      const result = await executePipeline(ctx, 'do something', { requestId: 'custom-123' });
      assert.strictEqual(result.requestId, 'custom-123');
    });
  });
});

describe('PipelineExecutor (Part 2)', function() {
  describe('executePipeline - with execution', function() {
    it('should execute with timeout and set executed=true', async function() {
      const ctx = _mockCtx({
        collaborationModeRouter: {
          selectMode() { return { mode: 'solo', confidence: 1, reasoning: 'test', allScores: {} }; },
          executeWithMode: async function() { return { success: true, data: 'result' }; },
        },
        programmableHookExecutor: { execute: async function() { return []; } },
      });
      const opts = { executeFn: async function() { return true; }, verifyFn: async function() { return true; } };
      const result = await executePipeline(ctx, 'implement feature', opts);
      assert.strictEqual(result.status, 'success');
      assert.strictEqual(result.executed, true);
      assert.deepStrictEqual(result.execution, { success: true, data: 'result' });
    });

    it('should handle execution timeout', async function() {
      const ctx = _mockCtx({
        collaborationModeRouter: {
          selectMode() { return { mode: 'solo', confidence: 1, reasoning: 'test', allScores: {} }; },
          executeWithMode: async function() {
            return new Promise(function(resolve) { setTimeout(resolve, 300); });
          },
        },
      });
      const opts = { executeFn: async function() {}, timeout: 50 };
      const result = await executePipeline(ctx, 'slow task', opts);
      assert.strictEqual(result.status, 'timeout');
      assert.strictEqual(result.executed, false);
    });

    it('should handle execution error', async function() {
      const ctx = _mockCtx({
        collaborationModeRouter: {
          selectMode() { return { mode: 'solo', confidence: 1, reasoning: 'test', allScores: {} }; },
          executeWithMode: async function() { throw new Error('execution failed'); },
        },
      });
      const opts = { executeFn: async function() {} };
      const result = await executePipeline(ctx, 'failing task', opts);
      assert.strictEqual(result.status, 'execution_error');
      assert.strictEqual(result.executed, false);
    });
  });

  describe('executePipeline - post-execution checks', function() {
    it('should verify evidence when provided', async function() {
      const ctx = _mockCtx({
        collaborationModeRouter: {
          selectMode() { return { mode: 'solo', confidence: 1, reasoning: 'test', allScores: {} }; },
          executeWithMode: async function() { return { success: true }; },
        },
        verifier: {
          getRequiredEvidenceTypes() { return ['unit_test']; },
          verify() { return { verified: false, missing: ['unit_test'] }; },
        },
        programmableHookExecutor: { execute: async function() { return []; } },
      });
      const opts = {
        executeFn: async function() {},
        evidence: { unit_test: 'none' },
      };
      const result = await executePipeline(ctx, 'implement feature', opts);
      assert.strictEqual(result.status, 'evidence_insufficient');
      assert.ok(result.evidenceVerification);
    });

    it('should verify goal achievement', async function() {
      const ctx = _mockCtx({
        collaborationModeRouter: {
          selectMode() { return { mode: 'solo', confidence: 1, reasoning: 'test', allScores: {} }; },
          executeWithMode: async function() { return { success: true }; },
        },
        programmableHookExecutor: { execute: async function() { return []; } },
      });
      const opts = {
        executeFn: async function() {},
        successCriteriaOverride: ['tests pass'],
        goalVerification: { 'tests pass': false },
      };
      const result = await executePipeline(ctx, 'implement feature', opts);
      assert.strictEqual(result.status, 'goal_not_achieved');
      assert.ok(result.goalVerification);
      assert.strictEqual(result.goalVerification.achieved, false);
    });

    it('should check coverage when tddContext has coverage', async function() {
      let coverageChecked = false;
      const ctx = _mockCtx({
        collaborationModeRouter: {
          selectMode() { return { mode: 'solo', confidence: 1, reasoning: 'test', allScores: {} }; },
          executeWithMode: async function() { return { success: true }; },
        },
        tddGate: {
          enforceCheck() {},
          enforceCoverage() { coverageChecked = true; throw new Error('Coverage below threshold'); },
        },
        programmableHookExecutor: { execute: async function() { return []; } },
      });
      const opts = {
        executeFn: async function() {},
        tddContext: { phase: 'GREEN', coverage: 60 },
      };
      const result = await executePipeline(ctx, 'implement feature', opts);
      assert.strictEqual(coverageChecked, true);
      assert.ok(result.coverageViolation);
    });

    it('should run file write checks when diff is provided', async function() {
      let hookCalledWith = null;
      const ctx = _mockCtx({
        collaborationModeRouter: {
          selectMode() { return { mode: 'solo', confidence: 1, reasoning: 'test', allScores: {} }; },
          executeWithMode: async function() { return { success: true }; },
        },
        programmableHookExecutor: {
          execute: async function(hookName, context) {
            if (hookName === 'post_file_write') hookCalledWith = context;
            return [];
          },
        },
      });
      const opts = {
        executeFn: async function() {},
        diff: 'added 1 line',
      };
      const result = await executePipeline(ctx, 'implement feature', opts);
      assert.ok(hookCalledWith);
      assert.strictEqual(hookCalledWith.diff, 'added 1 line');
      assert.ok(result.fileWriteChecks);
    });
  });

  describe('executePipeline - abort signal', function() {
    it('should return aborted when signal is already aborted', async function() {
      const ctx = _mockCtx({
        collaborationModeRouter: {
          selectMode() { return { mode: 'solo', confidence: 1, reasoning: 'test', allScores: {} }; },
          executeWithMode: async function() { return { success: true }; },
        },
      });
      const controller = new AbortController();
      controller.abort();
      const opts = { executeFn: async function() {}, signal: controller.signal };
      const result = await executePipeline(ctx, 'task', opts);
      assert.strictEqual(result.executed, false);
      assert.strictEqual(result.status, 'aborted');
    });
  });
});

describe('InstanceBuilder', function() {
  describe('_buildPropertyMap', function() {
    it('should map all context properties', function() {
      const ctx = {
        projectRoot: '/test',
        router: { id: 'router' },
        session: { id: 'session' },
        orchestrator: { id: 'orch' },
        enforcer: { id: 'enf' },
        guard: { id: 'guard' },
        logger: { id: 'log' },
        tddGate: { id: 'gate' },
        verifier: { id: 'ver' },
        validation: { id: 'val' },
        eventBus: { id: 'bus' },
        pluginManager: { id: 'plug' },
        healthChecker: { id: 'hc' },
        structuredLog: { id: 'slog' },
        memoryStore: { id: 'mem' },
        agentChannel: { id: 'ch' },
        checkpointManager: { id: 'cp' },
        retryEngine: { id: 're' },
        skillImprover: { id: 'si' },
        concurrencyController: { id: 'cc' },
        adversarialReview: { id: 'ar' },
        platformCoordinator: { id: 'pc' },
        workflowTemplate: { id: 'wt' },
        complianceChecker: { id: 'fcc' },
        deviationApproval: { id: 'da' },
        codeReviewCheck: { id: 'crc' },
        designSkillEngine: { id: 'dse' },
        agentRuntime: { id: 'art' },
        agentLifecycle: { id: 'alc' },
        agentSandbox: { id: 'asb' },
        agentMonitor: { id: 'am' },
        agentDeployment: { id: 'ad' },
        agentStateManager: { id: 'asm' },
        agentWorkflowIntegration: { id: 'awi' },
        tokenManager: { id: 'tm' },
        deepeningRegistry: { id: 'dr' },
        recurrentDeepening: { id: 'rd' },
        adaptiveDepth: { id: 'adp' },
        ltiInjector: { id: 'lti' },
        multiAgentRouter: { id: 'mar' },
        outputFusion: { id: 'of' },
        iterativeRefinement: { id: 'ir' },
        progressiveDeepening: { id: 'pd' },
        deepeningOrchestrator: { id: 'do' },
        qualityScorer: { id: 'qs' },
        tokenAwareDeepening: { id: 'tad' },
        affinityLearner: { id: 'al' },
        convergenceDetector: { id: 'cd' },
        deepeningMetricsCollector: { id: 'dmc' },
        deepeningCache: { id: 'dc' },
        deepeningStrategyPlugin: { id: 'dsp' },
        deepeningReportGenerator: { id: 'drg' },
        deepeningPipeline: { id: 'dp' },
        deepeningHealthMonitor: { id: 'dhm' },
        deepeningEventStore: { id: 'des' },
        deepeningWorkflowTemplate: { id: 'dwt' },
        deepeningBenchmark: { id: 'db' },
        skillReducer: { id: 'sr' },
        generatorVerifier: { id: 'gv' },
        isolatedContextManager: { id: 'icm' },
        planPersistence: { id: 'pp' },
        collaborationModeRouter: { id: 'cmr' },
        structuredIntent: { id: 'si2' },
        subagentExecutor: { id: 'se' },
        pairChat: { id: 'pc2' },
        chatChain: { id: 'cc2' },
        sqliteStore: { id: 'ss' },
        skillImprovementLoop: { id: 'sil' },
        memoryNudge: { id: 'mn' },
        skillCreationEngine: { id: 'sce' },
        skillCurator: { id: 'sc' },
        userModelManager: { id: 'umm' },
        mcpClient: { id: 'mc' },
        autoVersionTracker: { id: 'avt' },
        commandRouter: { id: 'cr' },
        programmableHookExecutor: { id: 'phe' },
        contextCompressionEngine: { id: 'cce' },
        agentPackManager: { id: 'apm' },
        startupTimings: { id: 'st' },
        thoughtExtractor: { id: 'te' },
        thoughtDeduplicator: { id: 'td' },
        thoughtMemoryStore: { id: 'tms' },
        thoughtRetrieverCycle: { id: 'trc' },
        embeddingService: { id: 'es' },
        modelSelector: { id: 'ms' },
        goalExecutor: { id: 'ge' },
        phaseContextInjector: { id: 'pci' },
        causalDataBus: { id: 'cdb' },
        causalMemoryStore: { id: 'cms' },
        configCausalValidator: { id: 'ccv' },
        signalPersistence: { id: 'sp' },
        selfEvolutionGovernor: { id: 'seg' },
        skillPatchApproval: { id: 'spa' },
        causalVectorIndex: { id: 'cvi' },
        archive: { id: 'arch' },
        causalBufferManager: { id: 'cbm' },
        docFreshnessGuard: { id: 'dfg' },
        humanApprovalGate: { id: 'hag' },
        ragPipeline: { id: 'rp' },
      };
      const props = _buildPropertyMap(ctx);
      assert.strictEqual(props.projectRoot, '/test');
      assert.strictEqual(props.router.id, 'router');
      assert.strictEqual(props.session.id, 'session');
      assert.strictEqual(props.goalExecutor.id, 'ge');
      assert.strictEqual(props.ragPipeline.id, 'rp');
    });
  });

  describe('_buildGroupedAPI', function() {
    it('should create grouped API with core, agents, gate, collaboration, store', function() {
      const ctx = {
        router: {}, session: {}, orchestrator: {}, enforcer: {}, guard: {},
        logger: {}, tddGate: {}, verifier: {}, eventBus: {}, healthChecker: {},
        tokenManager: {}, commandRouter: {}, programmableHookExecutor: {},
        contextCompressionEngine: {},
        agentRuntime: {}, agentLifecycle: {}, agentSandbox: {}, agentMonitor: {},
        agentDeployment: {}, agentStateManager: {}, agentWorkflowIntegration: {},
        agentPackManager: {},
        complianceChecker: {}, deviationApproval: {}, codeReviewCheck: {},
        designSkillEngine: {}, generatorVerifier: {},
        collaborationModeRouter: {}, structuredIntent: {}, subagentExecutor: {},
        pairChat: {}, chatChain: {},
        sqliteStore: {}, memoryStore: {}, skillImprovementLoop: {},
        memoryNudge: {}, skillCreationEngine: {}, skillCurator: {},
        userModelManager: {}, mcpClient: {},
      };
      const groups = _buildGroupedAPI(ctx);
      assert.ok(groups.core);
      assert.ok(groups.agents);
      assert.ok(groups.gate);
      assert.ok(groups.collaboration);
      assert.ok(groups.store);
      assert.strictEqual(groups.core.router, ctx.router);
      assert.strictEqual(groups.agents.runtime, ctx.agentRuntime);
      assert.strictEqual(groups.gate.complianceChecker, ctx.complianceChecker);
      assert.strictEqual(groups.collaboration.modeRouter, ctx.collaborationModeRouter);
      assert.strictEqual(groups.store.sqlite, ctx.sqliteStore);
    });
  });
});

describe('InstanceBuilder (Part 2)', function() {
  describe('buildInstance', function() {
    it('should build instance with executePipeline method', function() {
      const ctx = {
        projectRoot: '/test',
        structuredLog: { info() {}, logPerformance() {}, warn() {} },
        router: { skills: [], match() { return []; }, loadL2() {}, loadL2Async() { return Promise.resolve(); } },
        session: {},
        orchestrator: {},
        enforcer: {},
        guard: {},
        logger: {},
        tddGate: {},
        verifier: {},
        eventBus: { emit() {} },
        healthChecker: {},
        tokenManager: {},
        commandRouter: {},
        programmableHookExecutor: {},
        contextCompressionEngine: {},
        collaborationModeRouter: {
          selectMode() { return { mode: 'solo', confidence: 1, reasoning: 'test', allScores: {} }; },
        },
        structuredIntent: { parseIntent() { return { params: {}, completeness: 1, clarificationNeeded: false }; } },
      };
      function mockPipeline(_c, _msg) { return { status: 'success' }; }

      const instance = buildInstance(ctx, mockPipeline);
      assert.strictEqual(typeof instance.executePipeline, 'function');
      assert.strictEqual(typeof instance.destroy, 'function');
    });

    it('should delegate executePipeline to provided function', async function() {
      const ctx = {
        projectRoot: '/test',
        structuredLog: { info() {}, logPerformance() {}, warn() {} },
        router: {},
        session: {},
        orchestrator: {},
        enforcer: {},
        guard: {},
        logger: {},
        tddGate: {},
        verifier: {},
        eventBus: { emit() {} },
        healthChecker: {},
        tokenManager: {},
        commandRouter: {},
        programmableHookExecutor: {},
        contextCompressionEngine: {},
      };
      let capturedMsg = null;
      function mockPipeline(c, msg) { capturedMsg = msg; return { status: 'success' }; }

      const instance = buildInstance(ctx, mockPipeline);
      await instance.executePipeline('test message');
      assert.strictEqual(capturedMsg, 'test message');
    });
  });

  describe('_destroyInstance', function() {
    it('should call shutdown on all modules in order', async function() {
      const shutdownOrder = [];
      const ctx = {
        _destroying: false,
        structuredLog: { info() {} },
        eventBus: { emit() {} },
        deepeningRegistry: { shutdown() { shutdownOrder.push('deepeningRegistry'); } },
        router: { shutdown() { shutdownOrder.push('router'); } },
        session: { shutdown() { shutdownOrder.push('session'); } },
        tddGate: { shutdown() { shutdownOrder.push('tddGate'); } },
      };
      await _destroyInstance(ctx);
      assert.strictEqual(ctx._destroying, true);
      assert.ok(shutdownOrder.indexOf('deepeningRegistry') < shutdownOrder.indexOf('router'));
    });

    it('should skip already-destroying instance', async function() {
      const ctx = { _destroying: true };
      await _destroyInstance(ctx);
      assert.strictEqual(ctx._destroying, true);
    });

    it('should handle async shutdown with timeout', async function() {
      const ctx = {
        _destroying: false,
        structuredLog: { info() {} },
        eventBus: { emit() {} },
        deepeningRegistry: { shutdown() {} },
        router: {
          shutdown() {
            return new Promise(function(resolve) { setTimeout(resolve, 50); });
          },
        },
      };
      await _destroyInstance(ctx);
      assert.strictEqual(ctx._destroying, true);
    });

    it('should handle shutdown errors gracefully', async function() {
      const ctx = {
        _destroying: false,
        structuredLog: { info() {} },
        eventBus: { emit() {} },
        deepeningRegistry: { shutdown() {} },
        router: { shutdown() { throw new Error('shutdown error'); } },
        session: { shutdown() {} },
      };
      await _destroyInstance(ctx);
      assert.strictEqual(ctx._destroying, true);
    });

    it('should remove process error handlers', async function() {
      const ctx = {
        _destroying: false,
        structuredLog: { info() {} },
        eventBus: { emit() {} },
        deepeningRegistry: { shutdown() {} },
        _uncaughtHandler: function() {},
        _rejectionHandler: function() {},
      };
      const originalRemoveListener = process.removeListener;
      let removedUncaught = false;
      let removedRejection = false;
      process.removeListener = function(event, _handler) {
        if (event === 'uncaughtException') removedUncaught = true;
        if (event === 'unhandledRejection') removedRejection = true;
      };
      try {
        await _destroyInstance(ctx);
        assert.strictEqual(removedUncaught, true);
        assert.strictEqual(removedRejection, true);
        assert.strictEqual(ctx._uncaughtHandler, null);
        assert.strictEqual(ctx._rejectionHandler, null);
      } finally {
        process.removeListener = originalRemoveListener;
      }
    });
  });
});

describe('Sanitizer Module', function() {
  const { sanitizeProto, sanitizeObject, sanitizeFilePath, sanitizeLogMsg, sanitizeMcpEnv } = require('../../../src/utils/sanitizer');

  describe('sanitizeProto', function() {
    it('should remove dangerous keys from object', function() {
      const obj = { __proto__: { polluted: true }, constructor: {}, name: 'safe', data: 'ok' };
      const result = sanitizeProto(obj);
      assert.strictEqual(result.name, 'safe');
      assert.strictEqual(result.data, 'ok');
      assert.ok(!Object.keys(result).includes('__proto__'));
      assert.ok(!Object.keys(result).includes('constructor'));
    });

    it('should handle null and undefined gracefully', function() {
      assert.strictEqual(sanitizeProto(null), null);
      assert.strictEqual(sanitizeProto(undefined), undefined);
    });

    it('should respect depth limit', function() {
      const obj = { a: { b: { c: { d: { e: { f: { __proto__: 'deep' } } } } } } };
      const result = sanitizeProto(obj);
      assert.ok(result.a.b.c.d.e);
    });
  });

  describe('sanitizeObject', function() {
    it('should create safe object without dangerous keys', function() {
      const obj = { name: 'test', __proto__: 'bad', constructor: 'bad', value: 42 };
      const result = sanitizeObject(obj);
      assert.strictEqual(result.name, 'test');
      assert.strictEqual(result.value, 42);
      assert.ok(!('__proto__' in result));
      assert.ok(!('constructor' in result));
    });

    it('should handle arrays', function() {
      const arr = [{ name: 'a' }, { __proto__: 'bad', name: 'b' }];
      const result = sanitizeObject(arr);
      assert.strictEqual(Array.isArray(result), true);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].name, 'a');
      assert.strictEqual(result[1].name, 'b');
    });

    it('should handle nested objects', function() {
      const obj = { outer: { inner: { __proto__: 'bad', name: 'inner' } } };
      const result = sanitizeObject(obj);
      assert.strictEqual(result.outer.inner.name, 'inner');
      assert.ok(!('__proto__' in result.outer.inner));
    });
  });

  describe('sanitizeFilePath', function() {
    it('should handle null/undefined input', function() {
      assert.strictEqual(sanitizeFilePath(null), '');
      assert.strictEqual(sanitizeFilePath(undefined), '');
    });

    it('should reject null bytes in path', function() {
      assert.strictEqual(sanitizeFilePath('/test\0/evil'), '');
    });

    it('should resolve and normalize paths', function() {
      const result = sanitizeFilePath('test.js');
      assert.ok(result.endsWith('test.js'));
    });
  });

  describe('sanitizeLogMsg', function() {
    it('should remove newlines and ANSI codes', function() {
      const msg = 'line1\nline2\r\x1b[31mred\x1b[0m';
      const result = sanitizeLogMsg(msg);
      assert.strictEqual(result.indexOf('\n'), -1);
      assert.strictEqual(result.indexOf('\r'), -1);
      assert.strictEqual(result.indexOf('\x1b'), -1);
    });

    it('should handle non-string input', function() {
      const result = sanitizeLogMsg(123);
      assert.strictEqual(result, '123');
    });
  });

  describe('sanitizeMcpEnv', function() {
    it('should filter out dangerous environment variables', function() {
      const env = {
        PATH: '/usr/bin',
        SECRET_KEY: 'supersecret',
        MY_API_TOKEN: 'token123',
        HOME: '/home/user',
        DATABASE_URL: 'postgres://...',
      };
      const result = sanitizeMcpEnv(env);
      assert.strictEqual(result.PATH, '/usr/bin');
      assert.strictEqual(result.HOME, '/home/user');
      assert.ok(!('SECRET_KEY' in result));
      assert.ok(!('MY_API_TOKEN' in result));
      assert.ok(!('DATABASE_URL' in result));
    });

    it('should handle null/undefined input', function() {
      assert.strictEqual(sanitizeMcpEnv(null), undefined);
      assert.strictEqual(sanitizeMcpEnv(undefined), undefined);
    });

    it('should filter by maxEnvLength when provided', function() {
      const env = { SHORT: 'abc', LONG: 'a'.repeat(200) };
      const result = sanitizeMcpEnv(env, null, 100);
      assert.strictEqual(result.SHORT, 'abc');
      assert.ok(!('LONG' in result));
    });

    it('should only include string values', function() {
      const env = { STR: 'hello', NUM: 42, OBJ: { a: 1 } };
      const result = sanitizeMcpEnv(env);
      assert.strictEqual(result.STR, 'hello');
      assert.ok(!('NUM' in result));
      assert.ok(!('OBJ' in result));
    });
  });
});
