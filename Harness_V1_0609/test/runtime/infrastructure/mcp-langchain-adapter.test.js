'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('MCPToolAdapter', () => {
  const { MCPToolAdapter } = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-langchain-adapter'));

  const mockClient = {
    callTool: async (name, args) => {
      return { result: { content: `Result from ${name}`, args } };
    },
  };

  const toolDef = {
    name: 'mcp_test_tool1',
    originalName: 'tool1',
    server: 'test',
    description: 'A test tool',
    inputSchema: {
      type: 'object',
      properties: { param1: { type: 'string' } },
      required: ['param1'],
    },
  };

  it('should construct with valid arguments', () => {
    const adapter = new MCPToolAdapter(mockClient, toolDef);
    assert.ok(adapter);
    assert.strictEqual(adapter.name, 'mcp_test_tool1');
    assert.strictEqual(adapter.description, 'A test tool');
  });

  it('should throw with invalid client', () => {
    assert.throws(() => new MCPToolAdapter({}, toolDef), /must have a callTool method/);
  });

  it('should throw with invalid toolDef', () => {
    assert.throws(() => new MCPToolAdapter(mockClient, null), /must have a valid name/);
    assert.throws(() => new MCPToolAdapter(mockClient, {}), /must have a valid name/);
  });

  it('should invoke tool successfully', async () => {
    const adapter = new MCPToolAdapter(mockClient, toolDef);
    const result = await adapter.invoke({ param1: 'test' });
    assert.ok(result.success);
    assert.ok(result.result);
    assert.strictEqual(adapter.callCount, 1);
  });

  it('should handle invoke errors gracefully', async () => {
    const errorClient = {
      callTool: async () => { throw new Error('tool error'); },
    };
    const adapter = new MCPToolAdapter(errorClient, toolDef);
    const result = await adapter.invoke();
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('tool error'));
  });

  it('should generate LangChain compatible tool', async () => {
    const adapter = new MCPToolAdapter(mockClient, toolDef);
    const lcTool = adapter.toLangChainTool();
    assert.strictEqual(lcTool.name, 'mcp_test_tool1');
    assert.strictEqual(lcTool.description, 'A test tool');
    assert.ok(typeof lcTool.func === 'function');
    assert.ok(lcTool.schema.properties);
    assert.strictEqual(lcTool.metadata.source, 'mcp');
    assert.strictEqual(lcTool.metadata.server, 'test');
  });

  it('should generate Skill definition', () => {
    const adapter = new MCPToolAdapter(mockClient, toolDef);
    const skillDef = adapter.toSkillDefinition();
    assert.ok(skillDef.id);
    assert.ok(skillDef.id.includes('mcp-skill-'));
    assert.strictEqual(skillDef.metadata.source, 'mcp');
    assert.strictEqual(skillDef.phase, 'module-development');
  });

  it('should read input schema', () => {
    const adapter = new MCPToolAdapter(mockClient, toolDef);
    const schema = adapter.inputSchema;
    assert.strictEqual(schema.type, 'object');
    assert.ok(schema.properties.param1);
  });
});

describe('MCPToolBinding', () => {
  const { MCPToolBinding } = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-langchain-adapter'));

  const mockTools = [
    { name: 'mcp_srv1_toolA', originalName: 'toolA', server: 'srv1', description: 'Tool A', inputSchema: {} },
    { name: 'mcp_srv1_toolB', originalName: 'toolB', server: 'srv1', description: 'Tool B', inputSchema: {} },
    { name: 'mcp_srv2_toolC', originalName: 'toolC', server: 'srv2', description: 'Tool C', inputSchema: {} },
  ];

  function createMockClient(tools) {
    return {
      getAvailableTools: () => tools ?? mockTools,
      callTool: async (name, _args) => ({ result: { content: `Result: ${name}` } }),
    };
  }

  it('should construct with valid client', () => {
    const binding = new MCPToolBinding(createMockClient());
    assert.ok(binding);
  });

  it('should throw with invalid client', () => {
    assert.throws(() => new MCPToolBinding({}), /must have a getAvailableTools method/);
  });

  it('should bind all tools', async () => {
    const binding = new MCPToolBinding(createMockClient());
    const result = await binding.bindAll();
    assert.ok(result.success);
    assert.strictEqual(result.totalTools, 3);
    assert.strictEqual(result.boundTools, 3);
    assert.strictEqual(binding.getStats().boundTools, 3);
  });

  it('should filter by server', async () => {
    const binding = new MCPToolBinding(createMockClient(), null, { serverFilter: ['srv1'] });
    await binding.bindAll();
    assert.strictEqual(binding.getStats().boundTools, 2);
  });

  it('should filter by tool', async () => {
    const binding = new MCPToolBinding(createMockClient(), null, { toolFilter: ['toolC'] });
    await binding.bindAll();
    assert.strictEqual(binding.getStats().boundTools, 1);
  });

  it('should get LangChain compatible tools', async () => {
    const binding = new MCPToolBinding(createMockClient());
    await binding.bindAll();
    const tools = binding.getLangChainCompatibleTools();
    assert.strictEqual(tools.length, 3);
    assert.strictEqual(tools[0].name, 'mcp_srv1_toolA');
    assert.strictEqual(typeof tools[0].func, 'function');
    assert.strictEqual(tools[0].metadata.source, 'mcp');
  });

  it('should invoke tool via binding', async () => {
    const binding = new MCPToolBinding(createMockClient());
    await binding.bindAll();
    const result = await binding.invokeTool('mcp_srv1_toolA', { input: 'test' });
    assert.ok(result.success);
    assert.ok(result.result);
  });

  it('should return error for unbound tool', async () => {
    const binding = new MCPToolBinding(createMockClient());
    await binding.bindAll();
    const result = await binding.invokeTool('nonexistent');
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('not bound'));
  });

  it('should get adapter', async () => {
    const binding = new MCPToolBinding(createMockClient());
    await binding.bindAll();
    const adapter = binding.getAdapter('mcp_srv1_toolA');
    assert.ok(adapter);
    assert.strictEqual(adapter.name, 'mcp_srv1_toolA');
    assert.strictEqual(binding.getAdapter('nonexistent'), null);
  });

  it('should handle empty tools gracefully', async () => {
    const binding = new MCPToolBinding(createMockClient([]));
    const result = await binding.bindAll();
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.boundTools, 0);
  });

  it('should auto-register skills with registry', async () => {
    const registered = [];
    const registry = {
      register: async (def) => { registered.push(def); },
    };
    const binding = new MCPToolBinding(createMockClient([mockTools[0]]), registry, { autoRegister: true });
    await binding.bindAll();
    assert.strictEqual(registered.length, 1);
    assert.strictEqual(registered[0].id, 'mcp-skill-srv1-toolA');
  });

  it('should track stats correctly', async () => {
    const binding = new MCPToolBinding(createMockClient([mockTools[0]]));
    await binding.bindAll();
    await binding.invokeTool('mcp_srv1_toolA');
    const stats = binding.getStats();
    assert.strictEqual(stats.boundTools, 1);
    assert.strictEqual(stats.totalCalls, 1);
  });
});

describe('toOpenAIFunctions', () => {
  const { MCPToolAdapter, toOpenAIFunctions } = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-langchain-adapter'));

  const mockClient = { callTool: async () => ({ result: {} }) };

  it('should convert adapters to OpenAI function format', () => {
    const adapter = new MCPToolAdapter(mockClient, {
      name: 'mcp_test_func', originalName: 'func', server: 'test',
      description: 'Test function',
      inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
    });
    const functions = toOpenAIFunctions([adapter]);
    assert.strictEqual(functions.length, 1);
    assert.strictEqual(functions[0].type, 'function');
    assert.strictEqual(functions[0].function.name, 'mcp_test_func');
    assert.strictEqual(functions[0].function.description, 'Test function');
  });

  it('should handle empty array', () => {
    const functions = toOpenAIFunctions([]);
    assert.strictEqual(functions.length, 0);
  });
});

describe('createLangChainTools', () => {
  const { createLangChainTools } = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-langchain-adapter'));

  const mockClient = {
    getAvailableTools: () => [
      { name: 'mcp_srv_t1', originalName: 't1', server: 'srv', description: 'T1', inputSchema: {} },
      { name: 'mcp_srv_t2', originalName: 't2', server: 'srv', description: 'T2', inputSchema: {} },
    ],
    callTool: async () => ({ result: {} }),
  };

  it('should create LangChain tools from client', () => {
    const tools = createLangChainTools(mockClient);
    assert.strictEqual(tools.length, 2);
    assert.strictEqual(tools[0].name, 'mcp_srv_t1');
    assert.strictEqual(typeof tools[0].func, 'function');
  });

  it('should filter by server', () => {
    const tools = createLangChainTools(mockClient, { serverFilter: ['other'] });
    assert.strictEqual(tools.length, 0);
  });
});
