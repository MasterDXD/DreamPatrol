'use strict';

/**
 * MCP-LangChain适配层 — 桥接Harness MCPClient与LangChain工具生态。
 *
 * 功能：
 *  - MCP工具适配器：将MCP工具包装为Harness可调用函数
 *  - LangChain兼容工具定义：生成LangChain兼容的工具描述
 *  - 自动技能注册：将发现的MCP工具自动注册为Harness Skill
 *  - 工具发现与绑定：自动发现并绑定MCP服务器提供的工具
 *
 * 核心概念：
 *  - MCPToolAdapter：单个MCP工具的适配器包装
 *  - MCPToolBinding：将MCP工具集合绑定到Harness技能系统
 *  - LangChainToolDef：LangChain兼容的工具定义格式
 *
 * @module runtime/infrastructure/mcp-langchain-adapter
 * @example
 * const { MCPToolBinding } = require('./mcp-langchain-adapter');
 * const binding = new MCPToolBinding(mcpClient, skillRegistry);
 * await binding.bindAll();
 * const tools = binding.getLangChainCompatibleTools();
 */

const { debug } = require('../../utils/debug-logger');

/**
 * MCP工具适配器。将单个MCP工具包装为可调用函数，支持参数验证和Schema转换。
 */
class MCPToolAdapter {
  /**
   * @param {Object} mcpClient - MCPClient实例
   * @param {Object} toolDef - MCP工具定义 { name, originalName, server, description, inputSchema }
   */
  constructor(mcpClient, toolDef) {
    if (!mcpClient || typeof mcpClient.callTool !== 'function') {
      throw new TypeError('MCPToolAdapter: mcpClient must have a callTool method');
    }
    if (!toolDef || typeof toolDef.name !== 'string') {
      throw new TypeError('MCPToolAdapter: toolDef must have a valid name');
    }
    this._client = mcpClient;
    this._toolDef = toolDef;
    this._callCount = 0;
    this._errorCount = 0;
  }

  /** @returns {string} 工具全名 */
  get name() { return this._toolDef.name; }

  /** @returns {string} 工具描述 */
  get description() { return this._toolDef.description || ''; }

  /** @returns {Object} 输入Schema */
  get inputSchema() { return this._toolDef.inputSchema ?? {}; }

  /** @returns {number} 调用次数 */
  get callCount() { return this._callCount; }

  /**
   * 调用MCP工具。
   * @param {Object} [args] - 工具参数
   * @returns {Promise<Object>} 调用结果 { success, result, error }
   */
  async invoke(args) {
    this._callCount++;
    try {
      const result = await this._client.callTool(this._toolDef.name, args ?? {});
      return { success: true, result: result?.result ?? result, raw: result };
    } catch (err) {
      this._errorCount++;
      debug('MCPToolAdapter', 'invoke', err);
      return { success: false, error: err && err.message ? err.message : String(err), tool: this._toolDef.name };
    }
  }

  /**
   * 生成LangChain兼容的工具定义。
   * 遵循LangChain Tool接口：{ name, description, schema, func }
   * @returns {Object} LangChain兼容的工具定义
   */
  toLangChainTool() {
    return {
      name: this._toolDef.name,
      description: this._toolDef.description || `MCP tool: ${this._toolDef.originalName}`,
      schema: this._convertSchema(this._toolDef.inputSchema),
      func: async (input) => {
        const result = await this.invoke(input);
        if (!result.success) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
        return JSON.stringify(result.result);
      },
      metadata: {
        source: 'mcp',
        server: this._toolDef.server,
        originalName: this._toolDef.originalName,
      },
    };
  }

  /**
   * 生成Harness Skill兼容的定义。
   * @returns {Object} Skill定义对象
   */
  toSkillDefinition() {
    return {
      id: `mcp-skill-${this._toolDef.server}-${this._toolDef.originalName}`,
      name: this._toolDef.originalName,
      description: `[MCP:${this._toolDef.server}] ${this._toolDef.description || this._toolDef.originalName}`,
      phase: 'module-development',
      handler: async (context) => {
        const result = await this.invoke(context?.args ?? context);
        return result;
      },
      metadata: {
        source: 'mcp',
        server: this._toolDef.server,
        toolFullName: this._toolDef.name,
      },
    };
  }

  /**
   * 将MCP inputSchema转换为更通用的Schema格式。
   * @param {Object} schema - MCP JSON Schema
   * @returns {Object} 转换后的Schema
   * @private
   */
  _convertSchema(schema) {
    if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
    return {
      type: schema.type || 'object',
      properties: schema.properties ?? {},
      required: schema.required ?? [],
      additionalProperties: schema.additionalProperties !== false,
    };
  }
}

/**
 * MCP工具绑定器。负责将MCP服务器提供的工具集合绑定到Harness技能系统，
 * 并提供LangChain兼容的工具列表。
 */
const _MAX_ADAPTERS = 50;
const MAX_SKILLS = 100;

class MCPToolBinding {
  /**
   * @param {Object} mcpClient - MCPClient实例
   * @param {Object} [skillRegistry] - 可选的技能注册中心(需实现register方法)
   * @param {Object} [options] - 配置选项
   * @param {string} [options.toolNamePrefix='mcp'] - 工具名前缀
   * @param {boolean} [options.autoRegister=false] - 是否自动注册为技能
   * @param {string[]} [options.serverFilter] - 限定绑定的服务器列表
   * @param {string[]} [options.toolFilter] - 限定绑定的工具名列表
   */
  constructor(mcpClient, skillRegistry, options) {
    if (!mcpClient || typeof mcpClient.getAvailableTools !== 'function') {
      throw new TypeError('MCPToolBinding: mcpClient must have a getAvailableTools method');
    }
    this._client = mcpClient;
    this._registry = skillRegistry ?? null;
    this._options = {
      toolNamePrefix: options?.toolNamePrefix ?? 'mcp',
      autoRegister: options?.autoRegister ?? false,
      serverFilter: options?.serverFilter ?? null,
      toolFilter: options?.toolFilter ?? null,
    };
    /** @type {Map<string, MCPToolAdapter>} */
    this._adapters = new Map();
    /** @type {Map<string, Object>} 已注册的技能ID映射 */
    this._registeredSkills = new Map();
  }

  /**
   * 发现并绑定所有MCP工具。
   * @returns {Promise<Object>} 绑定结果 { success, totalTools, boundTools, errors }
   */
  async bindAll() {
    const tools = this._client.getAvailableTools();
    if (!Array.isArray(tools)) {
      return { success: false, totalTools: 0, boundTools: 0, errors: ['No tools available'] };
    }

    const errors = [];
    let boundCount = 0;
    const serverFilter = this._options.serverFilter;
    const toolFilter = this._options.toolFilter;

    for (const tool of tools) {
      try {
        if (serverFilter && !serverFilter.includes(tool.server)) continue;
        if (toolFilter && !toolFilter.includes(tool.originalName)) continue;

        const adapter = new MCPToolAdapter(this._client, tool);
        this._adapters.set(tool.name, adapter);
        boundCount++;

        if (this._options.autoRegister && this._registry) {
          await this._autoRegisterSkill(adapter);
        }
      } catch (err) {
        errors.push(`Failed to bind tool ${tool.name}: ${err && err.message ? err.message : String(err)}`);
        debug('MCPToolBinding', 'bindAll', err);
      }
    }

    return { success: errors.length === 0, totalTools: tools.length, boundTools: boundCount, errors };
  }

  /**
   * 自动注册单个MCP工具为Harness Skill。
   * @param {MCPToolAdapter} adapter - 工具适配器
   * @returns {Promise<Object>} 注册结果
   * @private
   */
  async _autoRegisterSkill(adapter) {
    if (!this._registry || typeof this._registry.register !== 'function') {
      return { success: false, error: 'Skill registry does not support register' };
    }
    const skillDef = adapter.toSkillDefinition();
    try {
      await this._registry.register(skillDef);
      if (this._registeredSkills.size >= MAX_SKILLS) {
        const oldestKey = this._registeredSkills.keys().next().value;
        this._registeredSkills.delete(oldestKey);
      }
      this._registeredSkills.set(skillDef.id, skillDef);
      return { success: true, skillId: skillDef.id };
    } catch (err) {
      debug('MCPToolBinding', 'autoRegister', err);
      return { success: false, error: err && err.message ? err.message : String(err), skillId: skillDef.id };
    }
  }

  /**
   * 获取LangChain兼容的工具列表。
   * 可直接传递给LangChain Agent的tools参数。
   * @returns {Array<Object>} LangChain工具定义数组
   */
  getLangChainCompatibleTools() {
    const tools = [];
    for (const adapter of this._adapters.values()) {
      tools.push(adapter.toLangChainTool());
    }
    return tools;
  }

  /**
   * 获取所有绑定的工具适配器。
   * @returns {Map<string, MCPToolAdapter>} 适配器映射
   */
  getAdapters() {
    return new Map(this._adapters);
  }

  /**
   * 获取指定工具的适配器。
   * @param {string} toolName - 工具名称
   * @returns {MCPToolAdapter|null} 适配器实例
   */
  getAdapter(toolName) {
    return this._adapters.get(toolName) ?? null;
  }

  /**
   * 调用指定MCP工具（通过适配器）。
   * @param {string} toolName - 工具名称
   * @param {Object} [args] - 工具参数
   * @returns {Promise<Object>} 调用结果
   */
  async invokeTool(toolName, args) {
    const adapter = this._adapters.get(toolName);
    if (!adapter) {
      return { success: false, error: `Tool not bound: ${toolName}` };
    }
    return adapter.invoke(args);
  }

  /**
   * 获取绑定统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    let totalCalls = 0;
    let totalErrors = 0;
    for (const adapter of this._adapters.values()) {
      totalCalls += adapter.callCount;
      totalErrors += (adapter._errorCount ?? 0);
    }
    return {
      boundTools: this._adapters.size,
      registeredSkills: this._registeredSkills.size,
      totalCalls,
      totalErrors,
    };
  }
}

/**
 * 生成OpenAI Function Calling兼容的工具定义。
 * 用于直接传递给支持function calling的LLM。
 *
 * @param {MCPToolBinding|Array<MCPToolAdapter>} source - 工具绑定器或适配器数组
 * @returns {Array<Object>} OpenAI function calling格式的工具定义
 */
function toOpenAIFunctions(source) {
  const adapters = Array.isArray(source)
    ? source
    : (source instanceof MCPToolBinding ? Array.from(source.getAdapters().values()) : []);
  return adapters.map(adapter => ({
    type: 'function',
    function: {
      name: adapter.name,
      description: adapter.description,
      parameters: adapter.inputSchema,
    },
  }));
}

/**
 * 从MCPClient直接生成LangChain工具列表（便捷函数）。
 *
 * @param {Object} mcpClient - MCPClient实例
 * @param {Object} [options] - 配置选项
 * @returns {Array<Object>} LangChain工具定义数组
 */
function createLangChainTools(mcpClient, options) {
  // 同步绑定（getAvailableTools 是同步的）
  const tools = mcpClient.getAvailableTools();
  const serverFilter = options?.serverFilter ?? null;
  const toolFilter = options?.toolFilter ?? null;

  const lcTools = [];
  for (const tool of tools) {
    if (serverFilter && !serverFilter.includes(tool.server)) continue;
    if (toolFilter && !toolFilter.includes(tool.originalName)) continue;
    try {
      const adapter = new MCPToolAdapter(mcpClient, tool);
      lcTools.push(adapter.toLangChainTool());
    } catch (err) {
      debug('createLangChainTools', 'adapter', err);
    }
  }
  return lcTools;
}

module.exports = {
  MCPToolAdapter,
  MCPToolBinding,
  toOpenAIFunctions,
  createLangChainTools,
};
