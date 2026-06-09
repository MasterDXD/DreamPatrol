'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('ToolAdapter', () => {
  const { ToolAdapter, TOOL_TYPES, TOOL_CAPABILITIES } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'tool-adapter'));

  it('should expose TOOL_TYPES constants', () => {
    assert.strictEqual(TOOL_TYPES.CLAUDE_CODE, 'claude-code');
    assert.strictEqual(TOOL_TYPES.CODEX_CLI, 'codex-cli');
    assert.strictEqual(TOOL_TYPES.GEMINI_CLI, 'gemini-cli');
    assert.strictEqual(TOOL_TYPES.GENERIC, 'generic');
  });

  it('should expose TOOL_CAPABILITIES', () => {
    assert.ok(TOOL_CAPABILITIES[TOOL_TYPES.CLAUDE_CODE]);
    assert.ok(TOOL_CAPABILITIES[TOOL_TYPES.CODEX_CLI]);
    assert.ok(TOOL_CAPABILITIES[TOOL_TYPES.GEMINI_CLI]);
    assert.ok(TOOL_CAPABILITIES[TOOL_TYPES.GENERIC]);
  });

  it('should construct with default tool when no env detected', () => {
    const sc = { ...process.env };
    delete process.env.HARNESS_TOOL_ADAPTER;
    delete process.env.CLAUDE_CODE_SESSION;
    delete process.env.CLAUDE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const ta = new ToolAdapter({ autoDetect: false });
    assert.strictEqual(ta.currentTool, TOOL_TYPES.GENERIC);
    ta.shutdown();
    Object.assign(process.env, sc);
  });

  it('should construct with custom default tool', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    assert.strictEqual(ta.currentTool, TOOL_TYPES.CLAUDE_CODE);
    ta.shutdown();
  });

  it('should get capabilities for current tool', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    const caps = ta.getCapabilities();
    assert.strictEqual(caps.hooks, true);
    assert.strictEqual(caps.sandbox, false);
    assert.strictEqual(caps.mcp, true);
    assert.ok(Array.isArray(caps.approvalModes));
    ta.shutdown();
  });

  it('should check hasCapability', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    assert.strictEqual(ta.hasCapability('hooks'), true);
    assert.strictEqual(ta.hasCapability('sandbox'), false);
    assert.strictEqual(ta.hasCapability('mcp'), true);
    ta.shutdown();
  });

  it('should check hasCapability for codex-cli sandbox', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CODEX_CLI, autoDetect: false });
    assert.strictEqual(ta.hasCapability('sandbox'), true);
    assert.strictEqual(ta.hasCapability('hooks'), false);
    ta.shutdown();
  });

  it('should get approval mode for autonomous execution', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    const mode = ta.getApprovalMode('autonomous');
    const caps = TOOL_CAPABILITIES[TOOL_TYPES.CLAUDE_CODE];
    assert.strictEqual(mode, caps.approvalModes[caps.approvalModes.length - 1]);
    ta.shutdown();
  });

  it('should get approval mode for supervised execution', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    const mode = ta.getApprovalMode('supervised');
    const caps = TOOL_CAPABILITIES[TOOL_TYPES.CLAUDE_CODE];
    assert.strictEqual(mode, caps.approvalModes[0]);
    ta.shutdown();
  });

  it('should get approval mode for default execution', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    const mode = ta.getApprovalMode('default');
    const caps = TOOL_CAPABILITIES[TOOL_TYPES.CLAUDE_CODE];
    assert.strictEqual(mode, caps.approvalModes[Math.floor(caps.approvalModes.length / 2)]);
    ta.shutdown();
  });

  it('should switch tool and emit tool-changed event', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.GENERIC, autoDetect: false });
    let eventData = null;
    ta.on('tool-changed', (d) => { eventData = d; });
    const result = ta.switchTool(TOOL_TYPES.CLAUDE_CODE);
    assert.strictEqual(result.from, TOOL_TYPES.GENERIC);
    assert.strictEqual(result.to, TOOL_TYPES.CLAUDE_CODE);
    assert.strictEqual(ta.currentTool, TOOL_TYPES.CLAUDE_CODE);
    assert.strictEqual(eventData.from, TOOL_TYPES.GENERIC);
    assert.strictEqual(eventData.to, TOOL_TYPES.CLAUDE_CODE);
    ta.shutdown();
  });

  it('should throw on invalid tool type switch', () => {
    const ta = new ToolAdapter({ autoDetect: false });
    assert.throws(() => ta.switchTool('invalid-tool'), { code: 'INVALID_TOOL_TYPE' });
    ta.shutdown();
  });

  it('should register and get tool config', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    const config = { customPrompt: 'test', maxTokens: 4096 };
    const registered = ta.registerToolConfig(TOOL_TYPES.CLAUDE_CODE, config);
    assert.strictEqual(registered, true);
    const retrieved = ta.getToolConfig();
    assert.strictEqual(retrieved.customPrompt, 'test');
    assert.strictEqual(retrieved.maxTokens, 4096);
    ta.shutdown();
  });

  it('should return empty object for unregistered tool config', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.GENERIC, autoDetect: false });
    const config = ta.getToolConfig();
    assert.deepStrictEqual(config, {});
    ta.shutdown();
  });

  it('should return false for invalid registerToolConfig', () => {
    const ta = new ToolAdapter({ autoDetect: false });
    assert.strictEqual(ta.registerToolConfig(null, {}), false);
    assert.strictEqual(ta.registerToolConfig('invalid', {}), false);
    ta.shutdown();
  });

  it('should get tool config for specific tool type', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.GENERIC, autoDetect: false });
    ta.registerToolConfig(TOOL_TYPES.CLAUDE_CODE, { a: 1 });
    ta.registerToolConfig(TOOL_TYPES.CODEX_CLI, { b: 2 });
    assert.deepStrictEqual(ta.getToolConfig(TOOL_TYPES.CLAUDE_CODE), { a: 1 });
    assert.deepStrictEqual(ta.getToolConfig(TOOL_TYPES.CODEX_CLI), { b: 2 });
    ta.shutdown();
  });

  it('should adapt hook config when tool supports hooks', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    const hooks = { preExec: () => {}, postExec: () => {} };
    const adapted = ta.adaptHookConfig(hooks);
    assert.strictEqual(adapted, hooks);
    ta.shutdown();
  });

  it('should return empty object for hook config when tool does not support hooks', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CODEX_CLI, autoDetect: false });
    const adapted = ta.adaptHookConfig({ preExec: () => {} });
    assert.deepStrictEqual(adapted, {});
    ta.shutdown();
  });

  it('should adapt sandbox config when tool supports sandbox', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CODEX_CLI, autoDetect: false });
    const sandbox = { type: 'docker', timeout: 60000 };
    const adapted = ta.adaptSandboxConfig(sandbox);
    assert.strictEqual(adapted, sandbox);
    ta.shutdown();
  });

  it('should return empty object for sandbox config when tool does not support sandbox', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    const adapted = ta.adaptSandboxConfig({ type: 'docker' });
    assert.deepStrictEqual(adapted, {});
    ta.shutdown();
  });

  it('should return stats', () => {
    const ta = new ToolAdapter({ defaultTool: TOOL_TYPES.CLAUDE_CODE, autoDetect: false });
    ta.registerToolConfig(TOOL_TYPES.CLAUDE_CODE, { x: 1 });
    const stats = ta.getStats();
    assert.strictEqual(stats.currentTool, TOOL_TYPES.CLAUDE_CODE);
    assert.strictEqual(stats.registeredConfigs, 1);
    assert.ok(stats.capabilities);
    ta.shutdown();
  });

  it('should detect tool from HARNESS_TOOL_ADAPTER env var', () => {
    const orig = process.env.HARNESS_TOOL_ADAPTER;
    process.env.HARNESS_TOOL_ADAPTER = 'codex';
    const ta = new ToolAdapter({ autoDetect: true });
    assert.strictEqual(ta.currentTool, TOOL_TYPES.CODEX_CLI);
    ta.shutdown();
    if (orig !== undefined) process.env.HARNESS_TOOL_ADAPTER = orig;
    else delete process.env.HARNESS_TOOL_ADAPTER;
  });

  it('should shutdown cleanly', () => {
    const ta = new ToolAdapter({ autoDetect: false });
    ta.registerToolConfig(TOOL_TYPES.CLAUDE_CODE, { x: 1 });
    ta.shutdown();
    assert.strictEqual(ta._toolConfigs.size, 0);
    assert.strictEqual(ta._currentTool, null);
  });
});
