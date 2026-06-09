'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = require('path').resolve(__dirname, '..', '..', '..');

describe('ModelLayer', () => {
  const ModelLayer = require(require('path').join(ROOT, 'src', 'runtime', 'agent', 'model-layer'));

  it('should construct with default config', () => {
    const ml = new ModelLayer();
    assert.strictEqual(ml._llmClient, null);
    ml.shutdown();
  });

  it('should attach LLM client', () => {
    const ml = new ModelLayer();
    const client = { chat: async () => 'response' };
    ml.attachLlmClient(client);
    assert.strictEqual(ml._llmClient, client);
    ml.shutdown();
  });

  it('should register and retrieve domain prompt', () => {
    const ml = new ModelLayer();
    ml.registerDomainPrompt('ecommerce', 'You are an e-commerce assistant.');
    assert.strictEqual(ml._systemPrompts.get('ecommerce'), 'You are an e-commerce assistant.');
    ml.shutdown();
  });

  it('should register and retrieve few-shot examples', () => {
    const ml = new ModelLayer();
    const examples = [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }];
    ml.registerFewShots('ecommerce', examples);
    assert.deepStrictEqual(ml._fewShots.get('ecommerce'), examples);
    ml.shutdown();
  });

  it('should return null from infer when no LLM client attached', async () => {
    const ml = new ModelLayer();
    const result = await ml.infer([{ role: 'user', content: 'test' }]);
    assert.strictEqual(result, null);
    ml.shutdown();
  });

  it('should call LLM client with system prompt and few-shots', async () => {
    const ml = new ModelLayer();
    let capturedMessages = null;
    const client = {
      chat: async (messages) => { capturedMessages = messages; return 'response'; },
    };
    ml.attachLlmClient(client);
    ml.registerDomainPrompt('test-domain', 'System prompt');
    ml.registerFewShots('test-domain', [{ role: 'user', content: 'example' }]);
    const result = await ml.infer([{ role: 'user', content: 'real query' }], { domain: 'test-domain' });
    assert.strictEqual(result, 'response');
    assert.strictEqual(capturedMessages[0].role, 'system');
    assert.strictEqual(capturedMessages[0].content, 'System prompt');
    assert.strictEqual(capturedMessages[1].content, 'example');
    assert.strictEqual(capturedMessages[2].content, 'real query');
    ml.shutdown();
  });

  it('should infer without domain prompt', async () => {
    const ml = new ModelLayer();
    let capturedMessages = null;
    const client = {
      chat: async (messages) => { capturedMessages = messages; return 'ok'; },
    };
    ml.attachLlmClient(client);
    await ml.infer([{ role: 'user', content: 'hello' }]);
    assert.strictEqual(capturedMessages.length, 1);
    assert.strictEqual(capturedMessages[0].content, 'hello');
    ml.shutdown();
  });

  it('should list registered domains', () => {
    const ml = new ModelLayer();
    ml.registerDomainPrompt('a', 'prompt-a');
    ml.registerDomainPrompt('b', 'prompt-b');
    const domains = ml.listDomains();
    assert.ok(domains.includes('a'));
    assert.ok(domains.includes('b'));
    ml.shutdown();
  });

  it('should shutdown cleanly', () => {
    const ml = new ModelLayer();
    ml.registerDomainPrompt('x', 'y');
    ml.shutdown();
    assert.strictEqual(ml._llmClient, null);
    assert.strictEqual(ml._systemPrompts.size, 0);
    assert.strictEqual(ml._fewShots.size, 0);
  });
});

describe('HarnessLayer', () => {
  const HarnessLayer = require(require('path').join(ROOT, 'src', 'runtime', 'agent', 'harness-layer'));

  it('should construct with default config', () => {
    const hl = new HarnessLayer();
    assert.strictEqual(hl._toolRegistry.size, 0);
    assert.strictEqual(hl._contextReaders.length, 0);
    assert.strictEqual(hl._guardrails.length, 0);
    hl.shutdown();
  });

  it('should register and retrieve tools', () => {
    const hl = new HarnessLayer();
    const tool = { execute: async () => 'result' };
    hl.registerTool('read-data', tool);
    assert.ok(hl._toolRegistry.has('read-data'));
    hl.shutdown();
  });

  it('should add context readers', () => {
    const hl = new HarnessLayer();
    const reader = { read: async () => ({ data: 'test' }) };
    hl.addContextReader(reader);
    assert.strictEqual(hl._contextReaders.length, 1);
    hl.shutdown();
  });

  it('should add guardrails', () => {
    const hl = new HarnessLayer();
    const guard = { check: () => ({ allowed: true }) };
    hl.addGuardrail(guard);
    assert.strictEqual(hl._guardrails.length, 1);
    hl.shutdown();
  });

  it('should set approval gate', () => {
    const hl = new HarnessLayer();
    const gate = { requiresApproval: () => false, requestApproval: async () => ({ granted: true }) };
    hl.setApprovalGate(gate);
    assert.strictEqual(hl._approvalGate, gate);
    hl.shutdown();
  });

  it('should execute action through tool', async () => {
    const hl = new HarnessLayer();
    let executedParams = null;
    hl.registerTool('test-tool', {
      execute: async (params, _ctx) => { executedParams = params; return { success: true, data: params }; },
    });
    const result = await hl.executeAction({ tool: 'test-tool', params: { key: 'value' } }, {});
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(executedParams, { key: 'value' });
    hl.shutdown();
  });

  it('should block action when guardrail denies', async () => {
    const hl = new HarnessLayer();
    hl.addGuardrail({ check: () => ({ allowed: false, reason: 'unsafe' }) });
    hl.registerTool('test-tool', { execute: async () => 'should not reach' });
    const result = await hl.executeAction({ tool: 'test-tool', params: {} }, {});
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.reason, 'unsafe');
    hl.shutdown();
  });

  it('should block action when approval denied', async () => {
    const hl = new HarnessLayer();
    hl.setApprovalGate({
      requiresApproval: () => true,
      requestApproval: async () => ({ granted: false, reason: 'rejected' }),
    });
    hl.registerTool('test-tool', { execute: async () => 'should not reach' });
    const result = await hl.executeAction({ tool: 'test-tool', params: {} }, {});
    assert.strictEqual(result.blocked, true);
    hl.shutdown();
  });

  it('should return error for unknown tool', async () => {
    const hl = new HarnessLayer();
    const result = await hl.executeAction({ tool: 'nonexistent', params: {} }, {});
    assert.strictEqual(result.error, 'tool not found');
    hl.shutdown();
  });

  it('should read context from all readers', async () => {
    const hl = new HarnessLayer();
    hl.addContextReader({ read: async () => ({ source: 'a', data: 1 }) });
    hl.addContextReader({ read: async () => ({ source: 'b', data: 2 }) });
    const contexts = await hl.readContext();
    assert.strictEqual(contexts.length, 2);
    assert.strictEqual(contexts[0].source, 'a');
    assert.strictEqual(contexts[1].source, 'b');
    hl.shutdown();
  });

  it('should list registered tools', () => {
    const hl = new HarnessLayer();
    hl.registerTool('tool-a', { execute: async () => {} });
    hl.registerTool('tool-b', { execute: async () => {} });
    const tools = hl.listTools();
    assert.ok(tools.includes('tool-a'));
    assert.ok(tools.includes('tool-b'));
    hl.shutdown();
  });

  it('should shutdown cleanly', () => {
    const hl = new HarnessLayer();
    hl.registerTool('x', { execute: async () => {} });
    hl.addContextReader({ read: async () => {} });
    hl.addGuardrail({ check: () => ({ allowed: true }) });
    hl.shutdown();
    assert.strictEqual(hl._toolRegistry.size, 0);
    assert.strictEqual(hl._contextReaders.length, 0);
    assert.strictEqual(hl._guardrails.length, 0);
    assert.strictEqual(hl._approvalGate, null);
  });
});

describe('AgentRuntime - Model+Harness integration', () => {
  const AgentRuntime = require(require('path').join(ROOT, 'src', 'runtime', 'agent', 'agent-runtime'));

  it('should have modelLayer and harnessLayer properties', () => {
    const tmpDir = require('path').join(require('os').tmpdir(), `ar-mh-${Date.now()}`);
    require('fs').mkdirSync(require('path').join(tmpDir, '.harness'), { recursive: true });
    const ar = new AgentRuntime(tmpDir);
    assert.ok(ar.modelLayer);
    assert.ok(ar.harnessLayer);
    ar.shutdown();
    require('fs').rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should allow attaching LLM client through modelLayer', () => {
    const tmpDir = require('path').join(require('os').tmpdir(), `ar-mh2-${Date.now()}`);
    require('fs').mkdirSync(require('path').join(tmpDir, '.harness'), { recursive: true });
    const ar = new AgentRuntime(tmpDir);
    const client = { chat: async () => 'response' };
    ar.modelLayer.attachLlmClient(client);
    assert.strictEqual(ar.modelLayer._llmClient, client);
    ar.shutdown();
    require('fs').rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should allow registering tools through harnessLayer', () => {
    const tmpDir = require('path').join(require('os').tmpdir(), `ar-mh3-${Date.now()}`);
    require('fs').mkdirSync(require('path').join(tmpDir, '.harness'), { recursive: true });
    const ar = new AgentRuntime(tmpDir);
    ar.harnessLayer.registerTool('my-tool', { execute: async () => 'ok' });
    assert.ok(ar.harnessLayer._toolRegistry.has('my-tool'));
    ar.shutdown();
    require('fs').rmSync(tmpDir, { recursive: true, force: true });
  });
});
