'use strict';

/**
 * @module runtime/infrastructure/langchain-mcp-bridge
 * LangChain/LangGraph MCP桥接器 — 通过MCP协议与Python LangChain MCP Server通信。
 *
 * 核心能力：
 * - 链管理：创建、执行、列出LangChain链
 * - 图管理：创建、执行、可视化LangGraph状态图
 * - 模板管理：创建、渲染Prompt模板
 * - 健康检查：检查MCP Server状态
 *
 * 集成方式：
 * 1. 通过MCPClient启动Python MCP Server（stdio模式）
 * 2. 通过MCPClient.callTool()调用MCP工具
 * 3. 与现有LangChainRunnableAdapter/MCP-LangChain适配器协同
 */

const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { safeExecute } = require('../../utils/safe-execute');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { EventEmitter } = require('events');

const CHAIN_TYPES = {
  SEQUENTIAL: 'sequential',
  BRANCHING: 'branching',
  MAP_REDUCE: 'map_reduce',
};

const NODE_TYPES = {
  PROCESS: 'process',
  DECISION: 'decision',
  PARALLEL: 'parallel',
  MERGE: 'merge',
};

const DEFAULT_OPTIONS = {
  mcpServerCommand: 'python',
  mcpServerArgs: ['sdk/python/langchain_mcp_server.py', '--transport', 'stdio'],
  mcpServerEnv: {},
  autoStart: false,
  requestTimeout: 30000,
};

class LangChainMCPBridge extends EventEmitter {
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._mcpClient = null;
    this._connected = false;
    this._stats = {
      chainsCreated: 0,
      chainsInvoked: 0,
      graphsCreated: 0,
      graphsInvoked: 0,
      templatesCreated: 0,
      templatesRendered: 0,
      healthChecks: 0,
    };
    this._shutDown = false;
  }

  /**
   * 挂载MCPClient实例。通过MCPClient与Python MCP Server通信。
   * @param {Object} client - MCPClient实例
   * @returns {boolean} 是否挂载成功
   */
  attachMCPClient(client) {
    if (client && typeof client.callTool === 'function') {
      this._mcpClient = client;
      this._connected = true;
      debug('LangChainMCPBridge', 'attachMCPClient', 'attached');
      return true;
    }
    return false;
  }

  /**
   * 创建LangChain链。
   * @param {string} chainType - 链类型(sequential/branching/map_reduce)
   * @param {string} name - 链名称
   * @param {Array<Object>} steps - 链步骤定义
   * @returns {Promise<{success: boolean, chain_id?: string, error?: string}>}
   */
  async createChain(chainType, name, steps) {
    this.guardShutdown();
    if (!this._connected) return { success: false, error: 'MCP client not connected' };

    const result = safeExecute(
      () => this._mcpClient.callTool('chain_create', {
        chain_type: chainType,
        name,
        steps,
      }),
      'LangChainMCPBridge', 'createChain',
    );

    if (result?.success !== false) {
      this._stats.chainsCreated++;
      this.emit('chain-created', { chainType, name });
    }
    debug('LangChainMCPBridge', 'createChain', 'type=' + chainType + ' name=' + name);
    return result;
  }

  /**
   * 执行已创建的LangChain链。
   * @param {string} chainId - 链ID
   * @param {Object} input - 链输入数据
   * @returns {Promise<{success: boolean, result?: string, error?: string}>}
   */
  async invokeChain(chainId, input) {
    this.guardShutdown();
    if (!this._connected) return { success: false, error: 'MCP client not connected' };

    const result = safeExecute(
      () => this._mcpClient.callTool('chain_invoke', { chain_id: chainId, input }),
      'LangChainMCPBridge', 'invokeChain',
    );

    if (result?.success !== false) this._stats.chainsInvoked++;
    debug('LangChainMCPBridge', 'invokeChain', 'id=' + chainId);
    return result;
  }

  /**
   * 列出所有已创建的链。
   * @returns {Promise<{chains: Array, total: number}>}
   */
  async listChains() {
    this.guardShutdown();
    if (!this._connected) return { chains: [], total: 0 };
    return safeExecute(
      () => this._mcpClient.callTool('chain_list', {}),
      'LangChainMCPBridge', 'listChains',
    ) ?? { chains: [], total: 0 };
  }

  /**
   * 创建LangGraph状态图。
   * @param {string} name - 图名称
   * @param {Object} stateSchema - 状态schema定义
   * @param {Array<Object>} nodes - 节点定义
   * @param {Array<Object>} edges - 边定义
   * @returns {Promise<{success: boolean, graph_id?: string, error?: string}>}
   */
  async createGraph(name, stateSchema, nodes, edges) {
    this.guardShutdown();
    if (!this._connected) return { success: false, error: 'MCP client not connected' };

    const result = safeExecute(
      () => this._mcpClient.callTool('graph_create', {
        name,
        state_schema: stateSchema,
        nodes,
        edges,
      }),
      'LangChainMCPBridge', 'createGraph',
    );

    if (result?.success !== false) {
      this._stats.graphsCreated++;
      this.emit('graph-created', { name });
    }
    debug('LangChainMCPBridge', 'createGraph', 'name=' + name);
    return result;
  }

  /**
   * 执行已创建的LangGraph状态图。
   * @param {string} graphId - 图ID
   * @param {Object} input - 图输入状态
   * @returns {Promise<{success: boolean, result?: Object, error?: string}>}
   */
  async invokeGraph(graphId, input) {
    this.guardShutdown();
    if (!this._connected) return { success: false, error: 'MCP client not connected' };

    const result = safeExecute(
      () => this._mcpClient.callTool('graph_invoke', { graph_id: graphId, input }),
      'LangChainMCPBridge', 'invokeGraph',
    );

    if (result?.success !== false) this._stats.graphsInvoked++;
    debug('LangChainMCPBridge', 'invokeGraph', 'id=' + graphId);
    return result;
  }

  /**
   * 生成LangGraph状态图的可视化描述(Mermaid格式)。
   * @param {string} graphId - 图ID
   * @returns {Promise<{graph_id: string, format: string, diagram: string}>}
   */
  async visualizeGraph(graphId) {
    this.guardShutdown();
    if (!this._connected) return { graph_id: graphId, format: 'mermaid', diagram: '', error: 'MCP client not connected' };
    return safeExecute(
      () => this._mcpClient.callTool('graph_visualize', { graph_id: graphId }),
      'LangChainMCPBridge', 'visualizeGraph',
    ) ?? { graph_id: graphId, format: 'mermaid', diagram: '' };
  }

  /**
   * 列出所有已创建的状态图。
   * @returns {Promise<{graphs: Array, total: number}>}
   */
  async listGraphs() {
    this.guardShutdown();
    if (!this._connected) return { graphs: [], total: 0 };
    return safeExecute(
      () => this._mcpClient.callTool('graph_list', {}),
      'LangChainMCPBridge', 'listGraphs',
    ) ?? { graphs: [], total: 0 };
  }

  /**
   * 创建Prompt模板。
   * @param {string} name - 模板名称
   * @param {string} template - 模板内容
   * @param {Array<string>} variables - 变量列表
   * @returns {Promise<{success: boolean, name?: string, error?: string}>}
   */
  async createPromptTemplate(name, template, variables) {
    this.guardShutdown();
    if (!this._connected) return { success: false, error: 'MCP client not connected' };

    const result = safeExecute(
      () => this._mcpClient.callTool('prompt_template_create', { name, template, variables }),
      'LangChainMCPBridge', 'createPromptTemplate',
    );

    if (result?.success !== false) this._stats.templatesCreated++;
    debug('LangChainMCPBridge', 'createPromptTemplate', 'name=' + name);
    return result;
  }

  /**
   * 渲染Prompt模板。
   * @param {string} name - 模板名称
   * @param {Object} values - 变量值映射
   * @returns {Promise<{success: boolean, rendered?: string, error?: string}>}
   */
  async renderPromptTemplate(name, values) {
    this.guardShutdown();
    if (!this._connected) return { success: false, error: 'MCP client not connected' };

    const result = safeExecute(
      () => this._mcpClient.callTool('prompt_template_render', { name, values }),
      'LangChainMCPBridge', 'renderPromptTemplate',
    );

    if (result?.success !== false) this._stats.templatesRendered++;
    return result;
  }

  /**
   * 健康检查。
   * @returns {Promise<{status: string, langchain_version?: string, error?: string}>}
   */
  async healthCheck() {
    this.guardShutdown();
    this._stats.healthChecks++;
    if (!this._connected) return { status: 'disconnected' };
    return safeExecute(
      () => this._mcpClient.callTool('health_check', {}),
      'LangChainMCPBridge', 'healthCheck',
    ) ?? { status: 'error' };
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
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
  CHAIN_TYPES,
  NODE_TYPES,
  LangChainMCPBridge: withShutdown(LangChainMCPBridge),
};
