'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { LangSmithMCPBridge, RUN_TYPES, DATA_TYPES } = require(
  path.join(ROOT, 'src', 'runtime', 'infrastructure', 'langsmith-mcp-bridge'),
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
const traceCreateResponse = { success: true, trace_id: 'trace-1', name: 'test-trace', run_type: 'llm', status: 'success' };
const traceListResponse = { traces: [{ id: 'trace-1', name: 'test-trace', run_type: 'llm', status: 'success', created_at: 1234567890 }], total: 1 };
const traceStatsResponse = { total_traces: 1, by_type: { llm: 1 }, by_status: { success: 1 }, total_feedbacks: 0, total_datasets: 0, total_evaluations: 0 };
const datasetCreateResponse = { success: true, name: 'test-dataset', data_type: 'kv' };
const addExamplesResponse = { success: true, dataset_name: 'test-dataset', added_count: 2, total_examples: 2 };
const datasetListResponse = { datasets: [{ name: 'test-dataset', description: 'test', data_type: 'kv', example_count: 2 }], total: 1 };
const feedbackCreateResponse = { success: true, feedback_id: 'fb-1', trace_id: 'trace-1', key: 'correctness', score: 0.9 };
const feedbackListResponse = { feedbacks: [{ id: 'fb-1', trace_id: 'trace-1', key: 'correctness', score: 0.9, comment: null }], total: 1 };
const evaluationRunResponse = { success: true, evaluation_id: 'eval-1', dataset_name: 'test-dataset', evaluator_name: 'test-evaluator', total_examples: 2, passed: 2, pass_rate: 1.0 };
const healthResponse = { status: 'healthy', langsmith_version: '0.8.9', traces_count: 1, datasets_count: 1, feedbacks_count: 1, evaluations_count: 1 };

// ── Helpers ─────────────────────────────────────────────────────────────────
function createConnectedBridge(toolResponses) {
  const bridge = new LangSmithMCPBridge();
  bridge.attachMCPClient(createMockMCPClient(toolResponses));
  return bridge;
}

// ════════════════════════════════════════════════════════════════════════════
// LangSmithMCPBridge – Construction
// ════════════════════════════════════════════════════════════════════════════
describe('LangSmithMCPBridge – Construction', () => {
  it('should create instance with default options', () => {
    const bridge = new LangSmithMCPBridge();
    assert.ok(bridge);
    assert.strictEqual(bridge._connected, false);
    assert.strictEqual(bridge._mcpClient, null);
    assert.deepStrictEqual(bridge._stats, {
      tracesCreated: 0,
      datasetsCreated: 0,
      feedbacksCreated: 0,
      evaluationsRun: 0,
      healthChecks: 0,
    });
  });

  it('should accept custom options', () => {
    const bridge = new LangSmithMCPBridge({ requestTimeout: 60000, autoStart: true });
    assert.strictEqual(bridge._options.requestTimeout, 60000);
    assert.strictEqual(bridge._options.autoStart, true);
    // defaults preserved
    assert.strictEqual(bridge._options.mcpServerCommand, 'python');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangSmithMCPBridge – attachMCPClient
// ════════════════════════════════════════════════════════════════════════════
describe('LangSmithMCPBridge – attachMCPClient', () => {
  it('should attach valid MCPClient', () => {
    const bridge = new LangSmithMCPBridge();
    const client = createMockMCPClient();
    const result = bridge.attachMCPClient(client);
    assert.strictEqual(result, true);
    assert.strictEqual(bridge._connected, true);
    assert.strictEqual(bridge._mcpClient, client);
  });

  it('should reject invalid MCPClient', () => {
    const bridge = new LangSmithMCPBridge();
    assert.strictEqual(bridge.attachMCPClient(null), false);
    assert.strictEqual(bridge.attachMCPClient({}), false);
    assert.strictEqual(bridge.attachMCPClient({ callTool: 'not-a-function' }), false);
    assert.strictEqual(bridge._connected, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangSmithMCPBridge – Trace Management
// ════════════════════════════════════════════════════════════════════════════
describe('LangSmithMCPBridge – Trace Management', () => {
  it('should create an LLM trace', async () => {
    const bridge = createConnectedBridge({ trace_create: traceCreateResponse });
    const result = await bridge.createTrace('test-trace', 'llm', { prompt: 'hello' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.trace_id, 'trace-1');
    assert.strictEqual(result.run_type, 'llm');
    assert.strictEqual(bridge._stats.tracesCreated, 1);
  });

  it('should create a chain trace with options', async () => {
    const chainTraceResponse = { success: true, trace_id: 'trace-2', name: 'chain-trace', run_type: 'chain', status: 'success' };
    const bridge = createConnectedBridge({ trace_create: chainTraceResponse });
    const result = await bridge.createTrace('chain-trace', 'chain', { input: 'data' }, {
      outputs: { result: 'done' },
      metadata: { env: 'test' },
      tags: ['integration'],
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.trace_id, 'trace-2');
    assert.strictEqual(result.run_type, 'chain');
    assert.strictEqual(bridge._stats.tracesCreated, 1);
  });

  it('should fail to create trace when not connected', async () => {
    const bridge = new LangSmithMCPBridge();
    const result = await bridge.createTrace('test', 'llm', {});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'MCP client not connected');
  });

  it('should list traces', async () => {
    const bridge = createConnectedBridge({ trace_list: traceListResponse });
    const result = await bridge.listTraces();
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.traces[0].id, 'trace-1');
    assert.strictEqual(result.traces[0].name, 'test-trace');
    assert.strictEqual(result.traces[0].run_type, 'llm');
  });

  it('should get trace stats', async () => {
    const bridge = createConnectedBridge({ trace_get_stats: traceStatsResponse });
    const result = await bridge.getTraceStats();
    assert.strictEqual(result.total_traces, 1);
    assert.deepStrictEqual(result.by_type, { llm: 1 });
    assert.deepStrictEqual(result.by_status, { success: 1 });
  });

  it('should return empty when listing traces while disconnected', async () => {
    const bridge = new LangSmithMCPBridge();
    const result = await bridge.listTraces();
    assert.deepStrictEqual(result, { traces: [], total: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangSmithMCPBridge – Dataset Management
// ════════════════════════════════════════════════════════════════════════════
describe('LangSmithMCPBridge – Dataset Management', () => {
  it('should create a dataset', async () => {
    const bridge = createConnectedBridge({ dataset_create: datasetCreateResponse });
    const result = await bridge.createDataset('test-dataset');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.name, 'test-dataset');
    assert.strictEqual(result.data_type, 'kv');
    assert.strictEqual(bridge._stats.datasetsCreated, 1);
  });

  it('should add examples to a dataset', async () => {
    const bridge = createConnectedBridge({ dataset_add_examples: addExamplesResponse });
    const result = await bridge.addExamples('test-dataset', [
      { input: 'q1', output: 'a1' },
      { input: 'q2', output: 'a2' },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.dataset_name, 'test-dataset');
    assert.strictEqual(result.added_count, 2);
    assert.strictEqual(result.total_examples, 2);
  });

  it('should list datasets', async () => {
    const bridge = createConnectedBridge({ dataset_list: datasetListResponse });
    const result = await bridge.listDatasets();
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.datasets[0].name, 'test-dataset');
    assert.strictEqual(result.datasets[0].data_type, 'kv');
    assert.strictEqual(result.datasets[0].example_count, 2);
  });

  it('should fail to create dataset when not connected', async () => {
    const bridge = new LangSmithMCPBridge();
    const result = await bridge.createDataset('test');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'MCP client not connected');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangSmithMCPBridge – Feedback Management
// ════════════════════════════════════════════════════════════════════════════
describe('LangSmithMCPBridge – Feedback Management', () => {
  it('should create feedback for a trace', async () => {
    const bridge = createConnectedBridge({ feedback_create: feedbackCreateResponse });
    const result = await bridge.createFeedback('trace-1', 'correctness', 0.9);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.feedback_id, 'fb-1');
    assert.strictEqual(result.trace_id, 'trace-1');
    assert.strictEqual(result.key, 'correctness');
    assert.strictEqual(result.score, 0.9);
    assert.strictEqual(bridge._stats.feedbacksCreated, 1);
  });

  it('should list feedbacks', async () => {
    const bridge = createConnectedBridge({ feedback_list: feedbackListResponse });
    const result = await bridge.listFeedbacks();
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.feedbacks[0].id, 'fb-1');
    assert.strictEqual(result.feedbacks[0].trace_id, 'trace-1');
    assert.strictEqual(result.feedbacks[0].key, 'correctness');
    assert.strictEqual(result.feedbacks[0].score, 0.9);
  });

  it('should list feedbacks filtered by trace ID', async () => {
    const bridge = createConnectedBridge({ feedback_list: feedbackListResponse });
    const result = await bridge.listFeedbacks({ traceId: 'trace-1' });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.feedbacks[0].trace_id, 'trace-1');
  });

  it('should fail to create feedback when not connected', async () => {
    const bridge = new LangSmithMCPBridge();
    const result = await bridge.createFeedback('trace-1', 'quality', 0.8);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'MCP client not connected');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangSmithMCPBridge – Evaluation
// ════════════════════════════════════════════════════════════════════════════
describe('LangSmithMCPBridge – Evaluation', () => {
  it('should run an evaluation', async () => {
    const bridge = createConnectedBridge({ evaluation_run: evaluationRunResponse });
    const result = await bridge.runEvaluation('test-dataset', 'test-evaluator');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.evaluation_id, 'eval-1');
    assert.strictEqual(result.dataset_name, 'test-dataset');
    assert.strictEqual(result.evaluator_name, 'test-evaluator');
    assert.strictEqual(result.total_examples, 2);
    assert.strictEqual(result.passed, 2);
    assert.strictEqual(result.pass_rate, 1.0);
    assert.strictEqual(bridge._stats.evaluationsRun, 1);
  });

  it('should fail to run evaluation when not connected', async () => {
    const bridge = new LangSmithMCPBridge();
    const result = await bridge.runEvaluation('test-dataset', 'test-evaluator');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'MCP client not connected');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangSmithMCPBridge – Health Check & Stats
// ════════════════════════════════════════════════════════════════════════════
describe('LangSmithMCPBridge – Health Check & Stats', () => {
  it('should perform health check', async () => {
    const bridge = createConnectedBridge({ health_check: healthResponse });
    const result = await bridge.healthCheck();
    assert.strictEqual(result.status, 'healthy');
    assert.strictEqual(result.langsmith_version, '0.8.9');
    assert.strictEqual(result.traces_count, 1);
    assert.strictEqual(result.datasets_count, 1);
    assert.strictEqual(result.feedbacks_count, 1);
    assert.strictEqual(result.evaluations_count, 1);
    assert.strictEqual(bridge._stats.healthChecks, 1);
  });

  it('should track statistics', async () => {
    const bridge = createConnectedBridge({
      trace_create: traceCreateResponse,
      dataset_create: datasetCreateResponse,
      feedback_create: feedbackCreateResponse,
      evaluation_run: evaluationRunResponse,
      health_check: healthResponse,
    });

    await bridge.createTrace('test-trace', 'llm', {});
    await bridge.createDataset('test-dataset');
    await bridge.createFeedback('trace-1', 'correctness', 0.9);
    await bridge.runEvaluation('test-dataset', 'test-evaluator');
    await bridge.healthCheck();

    const stats = bridge.getStats();
    assert.strictEqual(stats.tracesCreated, 1);
    assert.strictEqual(stats.datasetsCreated, 1);
    assert.strictEqual(stats.feedbacksCreated, 1);
    assert.strictEqual(stats.evaluationsRun, 1);
    assert.strictEqual(stats.healthChecks, 1);
    assert.strictEqual(stats.connected, true);
  });

  it('should return disconnected status when not connected', async () => {
    const bridge = new LangSmithMCPBridge();
    const result = await bridge.healthCheck();
    assert.strictEqual(result.status, 'disconnected');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LangSmithMCPBridge – Shutdown
// ════════════════════════════════════════════════════════════════════════════
describe('LangSmithMCPBridge – Shutdown', () => {
  it('should guard methods after shutdown', async () => {
    const bridge = createConnectedBridge({ trace_create: traceCreateResponse });
    bridge.shutdown();

    // After shutdown, guardShutdown throws, so async methods should reject
    await assert.rejects(
      () => bridge.createTrace('test', 'llm', {}),
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
// LangSmithMCPBridge – Exports
// ════════════════════════════════════════════════════════════════════════════
describe('LangSmithMCPBridge – Exports', () => {
  it('should export RUN_TYPES and DATA_TYPES constants', () => {
    assert.strictEqual(RUN_TYPES.LLM, 'llm');
    assert.strictEqual(RUN_TYPES.CHAIN, 'chain');
    assert.strictEqual(RUN_TYPES.TOOL, 'tool');
    assert.strictEqual(RUN_TYPES.RETRIEVER, 'retriever');
    assert.strictEqual(DATA_TYPES.KV, 'kv');
    assert.strictEqual(DATA_TYPES.LLM, 'llm');
    assert.strictEqual(DATA_TYPES.CHAT, 'chat');
  });
});
