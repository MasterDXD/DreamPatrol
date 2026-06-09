'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { ExecutionModeManager, EXECUTION_MODES, MODE_SOURCES, ENV_MODE_MAP } = require('../../../src/runtime/workflow/execution-mode-manager');
const { SprintCycle, SPRINT_PHASES, SPRINT_STATES } = require('../../../src/runtime/workflow/sprint-cycle');
const { ToolAdapter, TOOL_TYPES } = require('../../../src/runtime/workflow/tool-adapter');

describe('ExecutionModeManager', () => {
  it('should default to autonomous mode', () => {
    const mgr = new ExecutionModeManager();
    assert.strictEqual(mgr.currentMode, EXECUTION_MODES.AUTONOMOUS);
    assert.strictEqual(mgr.modeSource, MODE_SOURCES.DEFAULT);
    assert.ok(mgr.isAutonomous());
    assert.ok(!mgr.isSupervised());
    assert.ok(!mgr.isDocumentDriven());
  });

  it('should read mode from environment variable', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    process.env.HARNESS_EXECUTION_MODE = 'supervised';
    try {
      const mgr = new ExecutionModeManager();
      assert.strictEqual(mgr.currentMode, EXECUTION_MODES.SUPERVISED);
      assert.strictEqual(mgr.modeSource, MODE_SOURCES.ENV_VAR);
    } finally {
      if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
      else delete process.env.HARNESS_EXECUTION_MODE;
    }
  });

  it('should support ENV_MODE_MAP aliases', () => {
    assert.strictEqual(ENV_MODE_MAP.auto, EXECUTION_MODES.AUTONOMOUS);
    assert.strictEqual(ENV_MODE_MAP.manual, EXECUTION_MODES.SUPERVISED);
    assert.strictEqual(ENV_MODE_MAP.doc, EXECUTION_MODES.DOCUMENT_DRIVEN);
  });

  it('should switch modes', () => {
    const mgr = new ExecutionModeManager();
    const result = mgr.switchMode(EXECUTION_MODES.SUPERVISED, MODE_SOURCES.API);
    assert.strictEqual(result.from, EXECUTION_MODES.AUTONOMOUS);
    assert.strictEqual(result.to, EXECUTION_MODES.SUPERVISED);
    assert.strictEqual(mgr.currentMode, EXECUTION_MODES.SUPERVISED);
  });

  it('should reject invalid mode', () => {
    const mgr = new ExecutionModeManager();
    assert.throws(() => mgr.switchMode('invalid'), /Invalid mode/);
  });

  it('should require approval in supervised mode', () => {
    const mgr = new ExecutionModeManager({ defaultMode: EXECUTION_MODES.SUPERVISED });
    assert.ok(mgr.requiresApproval('phase-transition'));
    assert.ok(mgr.requiresApproval('goal-start'));
  });

  it('should not require approval in autonomous mode', () => {
    const mgr = new ExecutionModeManager();
    assert.ok(!mgr.requiresApproval('phase-transition'));
  });

  it('should register and call approval callback', async () => {
    const mgr = new ExecutionModeManager({ defaultMode: EXECUTION_MODES.SUPERVISED });
    mgr.registerApprovalCallback('phase-transition', async () => true);
    const result = await mgr.requestApproval('phase-transition', {});
    assert.strictEqual(result.approved, true);
  });

  it('should return unapproved when no callback registered', async () => {
    const mgr = new ExecutionModeManager({ defaultMode: EXECUTION_MODES.SUPERVISED });
    const result = await mgr.requestApproval('phase-transition', {});
    assert.strictEqual(result.approved, false);
    assert.strictEqual(result.reason, 'no-approval-callback-registered');
  });

  it('should get spec path in document-driven mode', () => {
    const mgr = new ExecutionModeManager({ defaultMode: EXECUTION_MODES.DOCUMENT_DRIVEN, documentDrivenSpecPath: '/path/to/spec.md' });
    assert.strictEqual(mgr.getSpecPath(), '/path/to/spec.md');
  });

  it('should return null spec path in non-document-driven mode', () => {
    const mgr = new ExecutionModeManager();
    assert.strictEqual(mgr.getSpecPath(), null);
  });

  it('should track mode history', () => {
    const mgr = new ExecutionModeManager();
    mgr.switchMode(EXECUTION_MODES.SUPERVISED, MODE_SOURCES.API);
    mgr.switchMode(EXECUTION_MODES.DOCUMENT_DRIVEN, MODE_SOURCES.API);
    const history = mgr.getModeHistory();
    assert.ok(history.length >= 3);
    assert.strictEqual(history[0].mode, EXECUTION_MODES.AUTONOMOUS);
  });

  it('should return stats', () => {
    const mgr = new ExecutionModeManager();
    const stats = mgr.getStats();
    assert.strictEqual(stats.currentMode, EXECUTION_MODES.AUTONOMOUS);
    assert.strictEqual(stats.modeSwitchAllowed, true);
  });

  it('should disable mode switching when configured', () => {
    const mgr = new ExecutionModeManager({ modeSwitchAllowed: false });
    assert.throws(() => mgr.switchMode(EXECUTION_MODES.SUPERVISED), /disabled/);
  });

  it('should clean up on shutdown', () => {
    const mgr = new ExecutionModeManager();
    mgr.registerApprovalCallback('test', async () => true);
    mgr._onShutdown();
    assert.strictEqual(mgr.getModeHistory().length, 0);
  });
});

describe('SprintCycle', () => {
  it('should complete a sprint cycle when quality threshold met', async () => {
    const cycle = new SprintCycle({ maxSprints: 3, qualityThreshold: 0.85 });
    const executeFn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.9 };
      if (phase === SPRINT_PHASES.TEST) return { failed: false };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false };
      return {};
    };
    const result = await cycle.run(executeFn, {});
    assert.strictEqual(result.completed, true);
    assert.strictEqual(result.sprints, 1);
    assert.strictEqual(cycle.state, SPRINT_STATES.COMPLETED);
  });

  it('should iterate multiple sprints when quality below threshold', async () => {
    const cycle = new SprintCycle({ maxSprints: 5, qualityThreshold: 0.85 });
    let sprintCount = 0;
    const executeFn = async (phase) => {
      if (phase === SPRINT_PHASES.INTEGRATE) {
        sprintCount++;
        return { quality: sprintCount >= 3 ? 0.9 : 0.5 };
      }
      if (phase === SPRINT_PHASES.TEST) return { failed: false };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false };
      return {};
    };
    const result = await cycle.run(executeFn, {});
    assert.strictEqual(result.completed, true);
    assert.strictEqual(result.sprints, 3);
  });

  it('should fail fast on test failure', async () => {
    const cycle = new SprintCycle({ failFastOnTest: true });
    const executeFn = async (phase) => {
      if (phase === SPRINT_PHASES.TEST) return { failed: true, passRate: 0.3 };
      return {};
    };
    const result = await cycle.run(executeFn, {});
    assert.strictEqual(result.completed, false);
    assert.strictEqual(result.reason, 'sprint-failed');
  });

  it('should fail on review rejection when requireReviewPass', async () => {
    const cycle = new SprintCycle({ requireReviewPass: true });
    const executeFn = async (phase) => {
      if (phase === SPRINT_PHASES.TEST) return { failed: false };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: true, score: 0.4 };
      return {};
    };
    const result = await cycle.run(executeFn, {});
    assert.strictEqual(result.completed, false);
  });

  it('should reach max sprints limit', async () => {
    const cycle = new SprintCycle({ maxSprints: 2, qualityThreshold: 0.99 });
    const executeFn = async (phase) => {
      if (phase === SPRINT_PHASES.TEST) return { failed: false };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false };
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.5 };
      return {};
    };
    const result = await cycle.run(executeFn, {});
    assert.strictEqual(result.completed, false);
    assert.strictEqual(result.reason, 'max-sprints-reached');
  });

  it('should throw when already running', async () => {
    const cycle = new SprintCycle();
    const slowFn = async () => new Promise(r => setTimeout(r, 200));
    const runPromise = cycle.run(slowFn, {});
    await assert.rejects(() => cycle.run(slowFn, {}), /already in progress/);
    cycle.abort();
    await runPromise.catch(() => {});
  });

  it('should abort cycle', async () => {
    const cycle = new SprintCycle({ maxSprints: 100 });
    setTimeout(() => cycle.abort(), 50);
    const executeFn = async () => new Promise(r => setTimeout(r, 30));
    await cycle.run(executeFn, {});
    assert.strictEqual(cycle.state, SPRINT_STATES.FAILED);
  });

  it('should return stats', () => {
    const cycle = new SprintCycle({ maxSprints: 5, qualityThreshold: 0.9 });
    const stats = cycle.getStats();
    assert.strictEqual(stats.state, SPRINT_STATES.IDLE);
    assert.strictEqual(stats.maxSprints, 5);
  });

  it('should track sprint history', async () => {
    const cycle = new SprintCycle({ maxSprints: 2, qualityThreshold: 0.99 });
    const executeFn = async (phase) => {
      if (phase === SPRINT_PHASES.TEST) return { failed: false };
      if (phase === SPRINT_PHASES.REVIEW) return { rejected: false };
      if (phase === SPRINT_PHASES.INTEGRATE) return { quality: 0.5 };
      return {};
    };
    await cycle.run(executeFn, {});
    const history = cycle.getHistory();
    assert.strictEqual(history.length, 2);
  });
});

describe('ToolAdapter', () => {
  it('should default to generic tool', () => {
    const adapter = new ToolAdapter({ autoDetect: false });
    assert.strictEqual(adapter.currentTool, TOOL_TYPES.GENERIC);
  });

  it('should auto-detect Claude Code from env', () => {
    const orig = process.env.CLAUDE_CODE_SESSION;
    process.env.CLAUDE_CODE_SESSION = '1';
    try {
      const adapter = new ToolAdapter();
      assert.strictEqual(adapter.currentTool, TOOL_TYPES.CLAUDE_CODE);
    } finally {
      if (orig !== undefined) process.env.CLAUDE_CODE_SESSION = orig;
      else delete process.env.CLAUDE_CODE_SESSION;
    }
  });

  it('should read tool from environment variable', () => {
    const orig = process.env.HARNESS_TOOL_ADAPTER;
    process.env.HARNESS_TOOL_ADAPTER = 'codex-cli';
    try {
      const adapter = new ToolAdapter();
      assert.strictEqual(adapter.currentTool, TOOL_TYPES.CODEX_CLI);
    } finally {
      if (orig !== undefined) process.env.HARNESS_TOOL_ADAPTER = orig;
      else delete process.env.HARNESS_TOOL_ADAPTER;
    }
  });

  it('should return correct capabilities', () => {
    const adapter = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    const caps = adapter.getCapabilities();
    assert.strictEqual(caps.hooks, true);
    assert.strictEqual(caps.sandbox, false);
    assert.strictEqual(caps.mcp, true);
  });

  it('should check capability', () => {
    const adapter = new ToolAdapter({ defaultTool: TOOL_TYPES.CODEX_CLI, autoDetect: false });
    assert.strictEqual(adapter.hasCapability('sandbox'), true);
    assert.strictEqual(adapter.hasCapability('hooks'), false);
  });

  it('should get approval mode based on execution mode', () => {
    const adapter = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    assert.strictEqual(adapter.getApprovalMode('autonomous'), 'full-auto');
    assert.strictEqual(adapter.getApprovalMode('supervised'), 'suggest');
  });

  it('should switch tool', () => {
    const adapter = new ToolAdapter({ autoDetect: false });
    const result = adapter.switchTool(TOOL_TYPES.GEMINI_CLI);
    assert.strictEqual(result.from, TOOL_TYPES.GENERIC);
    assert.strictEqual(result.to, TOOL_TYPES.GEMINI_CLI);
    assert.strictEqual(adapter.currentTool, TOOL_TYPES.GEMINI_CLI);
  });

  it('should reject invalid tool type', () => {
    const adapter = new ToolAdapter();
    assert.throws(() => adapter.switchTool('invalid'), /Unknown tool/);
  });

  it('should adapt hook config for non-hook tools', () => {
    const adapter = new ToolAdapter({ defaultTool: TOOL_TYPES.CODEX_CLI, autoDetect: false });
    const result = adapter.adaptHookConfig({ pre: true });
    assert.deepStrictEqual(result, {});
  });

  it('should adapt sandbox config for non-sandbox tools', () => {
    const adapter = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    const result = adapter.adaptSandboxConfig({ isolated: true });
    assert.deepStrictEqual(result, {});
  });

  it('should register and get tool config', () => {
    const adapter = new ToolAdapter({ autoDetect: false });
    adapter.registerToolConfig(TOOL_TYPES.CLAUDE_CODE, { apiKey: 'test' });
    const config = adapter.getToolConfig(TOOL_TYPES.CLAUDE_CODE);
    assert.strictEqual(config.apiKey, 'test');
  });

  it('should return stats', () => {
    const adapter = new ToolAdapter({ autoDetect: false });
    const stats = adapter.getStats();
    assert.strictEqual(stats.currentTool, TOOL_TYPES.GENERIC);
    assert.ok(stats.capabilities);
  });
});
