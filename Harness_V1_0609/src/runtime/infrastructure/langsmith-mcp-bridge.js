'use strict';

/**
 * @module runtime/infrastructure/langsmith-mcp-bridge
 * LangSmith MCP桥接器 — 通过MCP协议与Python LangSmith MCP Server通信。
 *
 * 核心能力：
 * - 追踪管理：创建/列出LLM调用追踪记录，获取统计信息
 * - 数据集管理：创建评估数据集，添加示例
 * - 反馈管理：对追踪结果进行评分标注
 * - 评估运行：对数据集执行评估并记录结果
 * - 健康检查：检查MCP Server状态
 *
 * 集成方式：
 * 1. 通过MCPClient启动Python MCP Server（stdio模式）
 * 2. 通过MCPClient.callTool()调用MCP工具
 * 3. 与现有LangChainMCPBridge/QualityScorer/EvaluationCalibrator协同
 */

const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { safeExecute } = require('../../utils/safe-execute');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { EventEmitter } = require('events');

const RUN_TYPES = {
  LLM: 'llm',
  CHAIN: 'chain',
  TOOL: 'tool',
  RETRIEVER: 'retriever',
};

const DATA_TYPES = {
  KV: 'kv',
  LLM: 'llm',
  CHAT: 'chat',
};

const DEFAULT_OPTIONS = {
  mcpServerCommand: 'python',
  mcpServerArgs: ['sdk/python/langsmith_mcp_server.py', '--transport', 'stdio'],
  mcpServerEnv: {},
  requestTimeout: 30000,
};

class LangSmithMCPBridge extends EventEmitter {
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._mcpClient = null;
    this._connected = false;
    this._stats = {
      tracesCreated: 0,
      datasetsCreated: 0,
      feedbacksCreated: 0,
      evaluationsRun: 0,
      healthChecks: 0,
    };
    this._shutDown = false;
  }

  guardShutdown() {
    if (this._shutDown) throw new Error('LangSmithMCPBridge is shut down');
  }

  isHealthy() {
    return !this._shutDown;
  }

  attachMCPClient(client) {
    if (client && typeof client.callTool === 'function') {
      this._mcpClient = client;
      this._connected = true;
      debug('LangSmithMCPBridge', 'attachMCPClient', 'attached');
      return true;
    }
    return false;
  }

  async createTrace(name, runType, inputs, options) {
    this.guardShutdown();
    if (!this._connected) return { success: false, error: 'MCP client not connected' };
    const result = safeExecute(
      () => this._mcpClient.callTool('trace_create', {
        name,
        run_type: runType,
        inputs,
        outputs: options?.outputs,
        metadata: options?.metadata,
        tags: options?.tags,
        error: options?.error,
      }),
      'LangSmithMCPBridge', 'createTrace',
    );
    if (result?.success !== false) {
      this._stats.tracesCreated++;
      this.emit('trace-created', { name, runType });
    }
    debug('LangSmithMCPBridge', 'createTrace', 'name=' + name + ' type=' + runType);
    return result;
  }

  async listTraces(options) {
    this.guardShutdown();
    if (!this._connected) return { traces: [], total: 0 };
    return safeExecute(
      () => this._mcpClient.callTool('trace_list', {
        limit: options?.limit ?? 20,
        run_type: options?.runType,
      }),
      'LangSmithMCPBridge', 'listTraces',
    ) ?? { traces: [], total: 0 };
  }

  async getTraceStats() {
    this.guardShutdown();
    if (!this._connected) return { total_traces: 0 };
    return safeExecute(
      () => this._mcpClient.callTool('trace_get_stats', {}),
      'LangSmithMCPBridge', 'getTraceStats',
    ) ?? { total_traces: 0 };
  }

  async createDataset(name, options) {
    this.guardShutdown();
    if (!this._connected) return { success: false, error: 'MCP client not connected' };
    const result = safeExecute(
      () => this._mcpClient.callTool('dataset_create', {
        name,
        description: options?.description,
        data_type: options?.dataType ?? 'kv',
      }),
      'LangSmithMCPBridge', 'createDataset',
    );
    if (result?.success !== false) {
      this._stats.datasetsCreated++;
      this.emit('dataset-created', { name });
    }
    debug('LangSmithMCPBridge', 'createDataset', 'name=' + name);
    return result;
  }

  async addExamples(datasetName, examples) {
    this.guardShutdown();
    if (!this._connected) return { success: false, error: 'MCP client not connected' };
    return safeExecute(
      () => this._mcpClient.callTool('dataset_add_examples', {
        dataset_name: datasetName,
        examples,
      }),
      'LangSmithMCPBridge', 'addExamples',
    );
  }

  async listDatasets(options) {
    this.guardShutdown();
    if (!this._connected) return { datasets: [], total: 0 };
    return safeExecute(
      () => this._mcpClient.callTool('dataset_list', { limit: options?.limit ?? 20 }),
      'LangSmithMCPBridge', 'listDatasets',
    ) ?? { datasets: [], total: 0 };
  }

  async createFeedback(traceId, key, score, options) {
    this.guardShutdown();
    if (!this._connected) return { success: false, error: 'MCP client not connected' };
    const result = safeExecute(
      () => this._mcpClient.callTool('feedback_create', {
        trace_id: traceId,
        key,
        score,
        value: options?.value,
        comment: options?.comment,
      }),
      'LangSmithMCPBridge', 'createFeedback',
    );
    if (result?.success !== false) {
      this._stats.feedbacksCreated++;
      this.emit('feedback-created', { traceId, key, score });
    }
    debug('LangSmithMCPBridge', 'createFeedback', 'trace=' + traceId + ' key=' + key);
    return result;
  }

  async listFeedbacks(options) {
    this.guardShutdown();
    if (!this._connected) return { feedbacks: [], total: 0 };
    return safeExecute(
      () => this._mcpClient.callTool('feedback_list', {
        trace_id: options?.traceId,
        limit: options?.limit ?? 20,
      }),
      'LangSmithMCPBridge', 'listFeedbacks',
    ) ?? { feedbacks: [], total: 0 };
  }

  async runEvaluation(datasetName, evaluatorName, options) {
    this.guardShutdown();
    if (!this._connected) return { success: false, error: 'MCP client not connected' };
    const result = safeExecute(
      () => this._mcpClient.callTool('evaluation_run', {
        dataset_name: datasetName,
        evaluator_name: evaluatorName,
        description: options?.description,
      }),
      'LangSmithMCPBridge', 'runEvaluation',
    );
    if (result?.success !== false) {
      this._stats.evaluationsRun++;
      this.emit('evaluation-run', { datasetName, evaluatorName });
    }
    debug('LangSmithMCPBridge', 'runEvaluation', 'dataset=' + datasetName);
    return result;
  }

  async healthCheck() {
    this.guardShutdown();
    this._stats.healthChecks++;
    if (!this._connected) return { status: 'disconnected' };
    return safeExecute(
      () => this._mcpClient.callTool('health_check', {}),
      'LangSmithMCPBridge', 'healthCheck',
    ) ?? { status: 'error' };
  }

  getStats() {
    return { ...this._stats, connected: this._connected };
  }

  async shutdown() {
    this._shutDown = true;
    this._connected = false;
    this._mcpClient = null;
    this.emit('shutdown');
  }
}

module.exports = {
  RUN_TYPES,
  DATA_TYPES,
  LangSmithMCPBridge: withShutdown(LangSmithMCPBridge),
};
