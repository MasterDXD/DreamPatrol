'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { LangChainMCPBridge, CHAIN_TYPES, NODE_TYPES } = require(
  path.join(ROOT, 'src', 'runtime', 'infrastructure', 'langchain-mcp-bridge'),
);

// ── Mock MCPClient ──────────────────────────────────────────────────────────
function createMockMCPClient(toolResponses) {
  const responses = toolResponses ?? {};
  return {
    callTool: async (toolName, args) => {
      const handler = responses[toolName];
      if (handler) return typeof handler === 'function' ? handler(args) : handler;
      return { success: false, error: 'Unknown tool: ' + toolName };
    },
  };
}

// ── Mock 响应 ───────────────────────────────────────────────────────────────
const chainCreateResponse = { success: true, chain_id: 'chain-1', name: 'test-chain', type: 'sequential', step_count: 2 };
const chainInvokeResponse = { success: true, chain_id: 'chain-1', result: 'processed output' };
const chainListResponse = { chains: [{ id: 'chain-1', name: 'test-chain', type: 'sequential', step_count: 2 }], total: 1 };
const graphCreateResponse = { success: true, graph_id: 'graph-1', name: 'test-graph', node_count: 3, edge_count: 2 };
const graphInvokeResponse = { success: true, graph_id: 'graph-1', result: { task: 'processed' } };
const graphVisualizeResponse = { graph_id: 'graph-1', name: 'test-graph', format: 'mermaid', diagram: 'graph TD\n    A-->B', node_count: 3, edge_count: 2 };
const graphListResponse = { graphs: [{ id: 'graph-1', name: 'test-graph', node_count: 3, edge_count: 2 }], total: 1 };
const templateCreateResponse = { success: true, name: 'test-template', variable_count: 2 };
const templateRenderResponse = { success: true, name: 'test-template', rendered: 'Hello World' };
const healthResponse = { status: 'healthy', langchain_version: '1.3.4', langgraph_available: true, chains_count: 1, graphs_count: 1, templates_count: 1 };

// ── Helpers ─────────────────────────────────────────────────────────────────
function createConnectedBridge(toolResponses) {
  const bridge = new LangChainMCPBridge();
  bridge.attachMCPClient(createMockMCPClient(toolResponses));
  return bridge;
}

// ════════════════════════════════════════════════════════════════════════════
// LangChainMCPBridge – Construction
// ════════════════════════════════════════════════════════════════════════════
describe('LangChainMCPBridge – Construction', () => {
  it('should create instance with default options', () => {
    const bridge = new LangChainMCPBridge();
    assert.ok(bridge);
    assert.strictEqual(bridge._connected, false);
    assert.strictEqual(bridge._mcpClient, null);
    assert.deepStrictEqual(bridge._stats, {
      chainsCreated: 0,
      chainsInvoked: 0,
      graphsCreated: 0,
      graphsInvoked: 0,
      templatesCreated: 0,
      templatesRendered: 0,
      healthChecks: 0,
    });
  });

  it('should accept custom options', () => {
    const bridge = new LangChainMCPBridge({ requestTimeout: 60000, autoStart: true });
    assert.strictEqual(bridge._options.requestTimeout, 60000);
    assert.strictEqual(bridge._options.autoStart, true);
    // defaults preserved
    assert.strictEqual(bridge._options.mcpServerCommand, 'python');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangChainMCPBridge – attachMCPClient
// ════════════════════════════════════════════════════════════════════════════
describe('LangChainMCPBridge – attachMCPClient', () => {
  it('should attach valid MCPClient', () => {
    const bridge = new LangChainMCPBridge();
    const client = createMockMCPClient();
    const result = bridge.attachMCPClient(client);
    assert.strictEqual(result, true);
    assert.strictEqual(bridge._connected, true);
    assert.strictEqual(bridge._mcpClient, client);
  });

  it('should reject invalid MCPClient', () => {
    const bridge = new LangChainMCPBridge();
    assert.strictEqual(bridge.attachMCPClient(null), false);
    assert.strictEqual(bridge.attachMCPClient({}), false);
    assert.strictEqual(bridge.attachMCPClient({ callTool: 'not-a-function' }), false);
    assert.strictEqual(bridge._connected, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangChainMCPBridge – Chain Management
// ════════════════════════════════════════════════════════════════════════════
describe('LangChainMCPBridge – Chain Management', () => {
  it('should create a sequential chain', async () => {
    const bridge = createConnectedBridge({ chain_create: chainCreateResponse });
    const result = await bridge.createChain('sequential', 'test-chain', [
      { type: 'prompt', template: 'Hello {name}' },
      { type: 'llm', model: 'gpt-4' },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.chain_id, 'chain-1');
    assert.strictEqual(result.type, 'sequential');
    assert.strictEqual(bridge._stats.chainsCreated, 1);
  });

  it('should create a branching chain', async () => {
    const branchingResponse = { success: true, chain_id: 'chain-2', name: 'branch-chain', type: 'branching', step_count: 3 };
    const bridge = createConnectedBridge({ chain_create: branchingResponse });
    const result = await bridge.createChain('branching', 'branch-chain', [
      { type: 'prompt', template: 'Classify {input}' },
      { type: 'branch', conditions: [{ key: 'positive' }, { key: 'negative' }] },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.chain_id, 'chain-2');
    assert.strictEqual(result.type, 'branching');
    assert.strictEqual(bridge._stats.chainsCreated, 1);
  });

  it('should fail to create chain when not connected', async () => {
    const bridge = new LangChainMCPBridge();
    const result = await bridge.createChain('sequential', 'test', []);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'MCP client not connected');
  });

  it('should invoke a chain', async () => {
    const bridge = createConnectedBridge({
      chain_create: chainCreateResponse,
      chain_invoke: chainInvokeResponse,
    });
    await bridge.createChain('sequential', 'test-chain', []);
    const result = await bridge.invokeChain('chain-1', { name: 'World' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.result, 'processed output');
    assert.strictEqual(bridge._stats.chainsInvoked, 1);
  });

  it('should fail to invoke when not connected', async () => {
    const bridge = new LangChainMCPBridge();
    const result = await bridge.invokeChain('chain-1', {});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'MCP client not connected');
  });

  it('should list chains', async () => {
    const bridge = createConnectedBridge({ chain_list: chainListResponse });
    const result = await bridge.listChains();
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.chains[0].id, 'chain-1');
    assert.strictEqual(result.chains[0].name, 'test-chain');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangChainMCPBridge – Graph Management
// ════════════════════════════════════════════════════════════════════════════
describe('LangChainMCPBridge – Graph Management', () => {
  it('should create a state graph', async () => {
    const bridge = createConnectedBridge({ graph_create: graphCreateResponse });
    const result = await bridge.createGraph(
      'test-graph',
      { task: { type: 'string' } },
      [{ id: 'start', type: 'process' }, { id: 'end', type: 'process' }],
      [{ from: 'start', to: 'end' }],
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.graph_id, 'graph-1');
    assert.strictEqual(result.node_count, 3);
    assert.strictEqual(bridge._stats.graphsCreated, 1);
  });

  it('should invoke a state graph', async () => {
    const bridge = createConnectedBridge({ graph_invoke: graphInvokeResponse });
    const result = await bridge.invokeGraph('graph-1', { task: 'process data' });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.result, { task: 'processed' });
    assert.strictEqual(bridge._stats.graphsInvoked, 1);
  });

  it('should visualize a graph (Mermaid format)', async () => {
    const bridge = createConnectedBridge({ graph_visualize: graphVisualizeResponse });
    const result = await bridge.visualizeGraph('graph-1');
    assert.strictEqual(result.graph_id, 'graph-1');
    assert.strictEqual(result.format, 'mermaid');
    assert.ok(result.diagram.includes('graph TD'));
  });

  it('should list graphs', async () => {
    const bridge = createConnectedBridge({ graph_list: graphListResponse });
    const result = await bridge.listGraphs();
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.graphs[0].id, 'graph-1');
    assert.strictEqual(result.graphs[0].name, 'test-graph');
  });

  it('should fail to create graph when not connected', async () => {
    const bridge = new LangChainMCPBridge();
    const result = await bridge.createGraph('test', {}, [], []);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'MCP client not connected');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangChainMCPBridge – Prompt Template
// ════════════════════════════════════════════════════════════════════════════
describe('LangChainMCPBridge – Prompt Template', () => {
  it('should create a prompt template', async () => {
    const bridge = createConnectedBridge({ prompt_template_create: templateCreateResponse });
    const result = await bridge.createPromptTemplate('test-template', 'Hello {name}, welcome to {place}!', ['name', 'place']);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.name, 'test-template');
    assert.strictEqual(result.variable_count, 2);
    assert.strictEqual(bridge._stats.templatesCreated, 1);
  });

  it('should render a prompt template', async () => {
    const bridge = createConnectedBridge({ prompt_template_render: templateRenderResponse });
    const result = await bridge.renderPromptTemplate('test-template', { name: 'World' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.rendered, 'Hello World');
    assert.strictEqual(bridge._stats.templatesRendered, 1);
  });

  it('should fail to render when not connected', async () => {
    const bridge = new LangChainMCPBridge();
    const result = await bridge.renderPromptTemplate('test-template', {});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'MCP client not connected');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangChainMCPBridge – Health Check & Stats
// ════════════════════════════════════════════════════════════════════════════
describe('LangChainMCPBridge – Health Check & Stats', () => {
  it('should perform health check', async () => {
    const bridge = createConnectedBridge({ health_check: healthResponse });
    const result = await bridge.healthCheck();
    assert.strictEqual(result.status, 'healthy');
    assert.strictEqual(result.langchain_version, '1.3.4');
    assert.strictEqual(result.langgraph_available, true);
    assert.strictEqual(bridge._stats.healthChecks, 1);
  });

  it('should track statistics', async () => {
    const bridge = createConnectedBridge({
      chain_create: chainCreateResponse,
      chain_invoke: chainInvokeResponse,
      graph_create: graphCreateResponse,
      graph_invoke: graphInvokeResponse,
      prompt_template_create: templateCreateResponse,
      prompt_template_render: templateRenderResponse,
      health_check: healthResponse,
    });

    await bridge.createChain('sequential', 'c1', []);
    await bridge.invokeChain('chain-1', {});
    await bridge.createGraph('g1', {}, [], []);
    await bridge.invokeGraph('graph-1', {});
    await bridge.createPromptTemplate('t1', 'Hi {name}', ['name']);
    await bridge.renderPromptTemplate('t1', { name: 'X' });
    await bridge.healthCheck();

    const stats = bridge.getStats();
    assert.strictEqual(stats.chainsCreated, 1);
    assert.strictEqual(stats.chainsInvoked, 1);
    assert.strictEqual(stats.graphsCreated, 1);
    assert.strictEqual(stats.graphsInvoked, 1);
    assert.strictEqual(stats.templatesCreated, 1);
    assert.strictEqual(stats.templatesRendered, 1);
    assert.strictEqual(stats.healthChecks, 1);
    assert.strictEqual(stats.connected, true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangChainMCPBridge – Shutdown
// ════════════════════════════════════════════════════════════════════════════
describe('LangChainMCPBridge – Shutdown', () => {
  it('should guard methods after shutdown', async () => {
    const bridge = createConnectedBridge({ chain_create: chainCreateResponse });
    bridge.shutdown();

    // After shutdown, guardShutdown throws, so async methods should reject
    await assert.rejects(
      () => bridge.createChain('sequential', 'test', []),
      /shut down/i,
    );
    assert.strictEqual(bridge.isHealthy(), false);
  });

  it('should clear state on shutdown', () => {
    const bridge = createConnectedBridge({ health_check: healthResponse });
    assert.strictEqual(bridge._connected, true);
    assert.ok(bridge._mcpClient);

    bridge.shutdown();

    assert.strictEqual(bridge._shutDown, true);
    assert.strictEqual(bridge.isHealthy(), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Exports
// ════════════════════════════════════════════════════════════════════════════
describe('LangChainMCPBridge – Exports', () => {
  it('should export CHAIN_TYPES and NODE_TYPES', () => {
    assert.strictEqual(CHAIN_TYPES.SEQUENTIAL, 'sequential');
    assert.strictEqual(CHAIN_TYPES.BRANCHING, 'branching');
    assert.strictEqual(CHAIN_TYPES.MAP_REDUCE, 'map_reduce');
    assert.strictEqual(NODE_TYPES.PROCESS, 'process');
    assert.strictEqual(NODE_TYPES.DECISION, 'decision');
    assert.strictEqual(NODE_TYPES.PARALLEL, 'parallel');
    assert.strictEqual(NODE_TYPES.MERGE, 'merge');
  });
});
