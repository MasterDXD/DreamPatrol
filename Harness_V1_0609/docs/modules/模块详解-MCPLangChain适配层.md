# 模块详解-MCPLangChain适配层

> 版本：2.73.4 | 文件：src/runtime/infrastructure/mcp-langchain-adapter.js

---

## 概述

MCPLangChain适配层是Harness MCPClient与LangChain工具生态之间的桥接模块，负责将MCP服务器提供的工具包装为Harness可调用函数、LangChain兼容工具定义以及Harness Skill定义，实现MCP工具在多框架间的无缝复用。

核心概念：
- **MCPToolAdapter**：单个MCP工具的适配器包装，提供调用、Schema转换和格式输出能力
- **MCPToolBinding**：将MCP工具集合批量绑定到Harness技能系统，并提供LangChain兼容工具列表
- **LangChainToolDef**：LangChain兼容的工具定义格式（`{ name, description, schema, func }`）

## 核心能力

| 能力 | 说明 |
|------|------|
| MCP工具适配 | 将MCP工具包装为可调用函数，支持参数验证和Schema转换 |
| LangChain兼容输出 | 生成LangChain Tool接口兼容的工具定义（name/description/schema/func） |
| OpenAI Function Calling | 生成OpenAI Function Calling格式的工具定义 |
| 自动技能注册 | 将发现的MCP工具自动注册为Harness Skill |
| 工具发现与绑定 | 自动发现MCP服务器提供的工具并批量绑定 |
| 过滤绑定 | 支持按服务器名或工具名过滤，精确控制绑定范围 |

## 类定义

### MCPToolAdapter

单个MCP工具的适配器包装，将MCP工具转为可调用函数，支持参数验证和Schema转换。

```javascript
class MCPToolAdapter {
  constructor(mcpClient, toolDef)

  // 只读属性
  get name()        // 工具全名
  get description() // 工具描述
  get inputSchema() // 输入Schema
  get callCount()   // 调用次数

  // 方法
  invoke(args)              // 调用MCP工具
  toLangChainTool()         // 生成LangChain兼容工具定义
  toSkillDefinition()       // 生成Harness Skill兼容定义
  _convertSchema(schema)    // 将MCP inputSchema转换为通用Schema格式（私有）
}
```

**构造参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| mcpClient | Object | 是 | MCPClient实例，必须具有 `callTool` 方法 |
| toolDef | Object | 是 | MCP工具定义对象 |
| toolDef.name | string | 是 | 工具全名 |
| toolDef.originalName | string | 否 | 工具原始名称 |
| toolDef.server | string | 否 | 所属服务器名称 |
| toolDef.description | string | 否 | 工具描述 |
| toolDef.inputSchema | Object | 否 | 输入JSON Schema |

### MCPToolBinding

MCP工具绑定器，负责将MCP服务器提供的工具集合绑定到Harness技能系统，并提供LangChain兼容的工具列表。

```javascript
class MCPToolBinding {
  constructor(mcpClient, skillRegistry, options)

  // 方法
  bindAll()                              // 发现并绑定所有MCP工具
  getLangChainCompatibleTools()          // 获取LangChain兼容工具列表
  getAdapters()                          // 获取所有绑定的工具适配器
  getAdapter(toolName)                   // 获取指定工具的适配器
  invokeTool(toolName, args)             // 调用指定MCP工具
  getStats()                             // 获取绑定统计信息
}
```

**构造参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| mcpClient | Object | 是 | MCPClient实例，必须具有 `getAvailableTools` 方法 |
| skillRegistry | Object | 否 | 技能注册中心（需实现 `register` 方法） |
| options | Object | 否 | 配置选项 |
| options.toolNamePrefix | string | 否 | 工具名前缀，默认 `'mcp'` |
| options.autoRegister | boolean | 否 | 是否自动注册为技能，默认 `false` |
| options.serverFilter | string[] | 否 | 限定绑定的服务器列表，`null` 表示不过滤 |
| options.toolFilter | string[] | 否 | 限定绑定的工具名列表，`null` 表示不过滤 |

## 常量

| 常量 | 值 | 说明 |
|------|------|------|
| `_MAX_ADAPTERS` | `50` | 最大适配器数量（内部限制） |
| `MAX_SKILLS` | `100` | 最大已注册技能数量，超出时淘汰最早的技能 |

## 核心 API

### MCPToolAdapter.invoke(args)

调用MCP工具，自动统计调用次数和错误次数。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| args | Object | 否 | 工具参数，默认为 `{}` |

**返回值：**

```javascript
// 成功
{ success: true, result: any, raw: Object }

// 失败
{ success: false, error: string, tool: string }
```

### MCPToolAdapter.toLangChainTool()

生成LangChain兼容的工具定义，遵循LangChain Tool接口格式。

**返回值：**

```javascript
{
  name: string,           // 工具全名
  description: string,    // 工具描述
  schema: Object,         // 转换后的Schema（type/properties/required/additionalProperties）
  func: AsyncFunction,    // 异步调用函数，失败时抛出Error，成功时返回JSON字符串
  metadata: {
    source: 'mcp',        // 来源标识
    server: string,       // 所属服务器
    originalName: string, // 工具原始名称
  }
}
```

### MCPToolAdapter.toSkillDefinition()

生成Harness Skill兼容的定义对象。

**返回值：**

```javascript
{
  id: string,             // 格式：mcp-skill-{server}-{originalName}
  name: string,           // 工具原始名称
  description: string,    // 格式：[MCP:{server}] {description}
  phase: 'module-development',
  handler: AsyncFunction, // 异步处理函数，接收context参数
  metadata: {
    source: 'mcp',
    server: string,
    toolFullName: string,
  }
}
```

### MCPToolAdapter._convertSchema(schema)

将MCP inputSchema（JSON Schema）转换为更通用的Schema格式。

**转换规则：**

| 输入字段 | 输出字段 | 默认值 |
|---------|---------|--------|
| schema.type | type | `'object'` |
| schema.properties | properties | `{}` |
| schema.required | required | `[]` |
| schema.additionalProperties | additionalProperties | `true`（仅当显式为 `false` 时才为 `false`） |

当schema为空或非对象时，返回 `{ type: 'object', properties: {} }`。

### MCPToolBinding.bindAll()

发现并绑定所有MCP工具，根据 `serverFilter` 和 `toolFilter` 进行过滤，若 `autoRegister` 为 `true` 则自动注册为技能。

**返回值：**

```javascript
{
  success: boolean,    // 是否全部绑定成功（无错误时为true）
  totalTools: number,  // MCP服务器提供的工具总数
  boundTools: number,  // 成功绑定的工具数
  errors: string[]     // 绑定失败的错误信息列表
}
```

### MCPToolBinding.getLangChainCompatibleTools()

获取LangChain兼容的工具列表，可直接传递给LangChain Agent的 `tools` 参数。

**返回值：** `Array<Object>` — LangChain工具定义数组

### MCPToolBinding.getAdapters()

获取所有绑定的工具适配器（返回副本）。

**返回值：** `Map<string, MCPToolAdapter>`

### MCPToolBinding.getAdapter(toolName)

获取指定工具的适配器。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| toolName | string | 是 | 工具名称 |

**返回值：** `MCPToolAdapter | null`

### MCPToolBinding.invokeTool(toolName, args)

通过适配器调用指定MCP工具。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| toolName | string | 是 | 工具名称 |
| args | Object | 否 | 工具参数 |

**返回值：** `{ success: boolean, result?: any, error?: string, tool?: string }`

### MCPToolBinding.getStats()

获取绑定统计信息，汇总所有适配器的调用次数和错误次数。

**返回值：**

```javascript
{
  boundTools: number,        // 已绑定工具数
  registeredSkills: number,  // 已注册技能数
  totalCalls: number,        // 总调用次数
  totalErrors: number,       // 总错误次数
}
```

### toOpenAIFunctions(source)

生成OpenAI Function Calling兼容的工具定义，用于直接传递给支持function calling的LLM。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| source | MCPToolBinding \| Array\<MCPToolAdapter\> | 是 | 工具绑定器或适配器数组 |

**返回值：**

```javascript
[{
  type: 'function',
  function: {
    name: string,        // 工具全名
    description: string, // 工具描述
    parameters: Object,  // 输入Schema
  }
}]
```

### createLangChainTools(mcpClient, options)

便捷函数，从MCPClient直接生成LangChain工具列表（同步操作）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| mcpClient | Object | 是 | MCPClient实例 |
| options.serverFilter | string[] | 否 | 服务器过滤列表 |
| options.toolFilter | string[] | 否 | 工具名过滤列表 |

**返回值：** `Array<Object>` — LangChain工具定义数组

## 事件

本模块不直接发射事件。MCPToolAdapter的错误通过 `debug` 日志记录，不使用EventEmitter。

## 使用示例

### 基础用法：绑定并获取LangChain工具

```javascript
const { MCPToolBinding } = require('./mcp-langchain-adapter');

// 创建绑定器
const binding = new MCPToolBinding(mcpClient, null, {
  serverFilter: ['filesystem'],  // 仅绑定filesystem服务器的工具
});

// 发现并绑定所有工具
const result = await binding.bindAll();
console.log(`绑定 ${result.boundTools}/${result.totalTools} 个工具`);

// 获取LangChain兼容工具列表
const lcTools = binding.getLangChainCompatibleTools();
// lcTools 可直接传递给 LangChain Agent
```

### 自动注册为Harness Skill

```javascript
const { MCPToolBinding } = require('./mcp-langchain-adapter');

const binding = new MCPToolBinding(mcpClient, skillRegistry, {
  autoRegister: true,            // 自动注册为技能
  toolFilter: ['read_file', 'write_file'],  // 仅绑定指定工具
});

await binding.bindAll();
```

### 单个工具适配

```javascript
const { MCPToolAdapter } = require('./mcp-langchain-adapter');

const adapter = new MCPToolAdapter(mcpClient, {
  name: 'mcp_fs_read_file',
  originalName: 'read_file',
  server: 'filesystem',
  description: '读取文件内容',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
});

// 调用工具
const result = await adapter.invoke({ path: '/etc/hosts' });
if (result.success) {
  console.log(result.result);
}

// 转换为LangChain工具
const lcTool = adapter.toLangChainTool();

// 转换为Skill定义
const skillDef = adapter.toSkillDefinition();
```

### 生成OpenAI Function Calling格式

```javascript
const { MCPToolBinding, toOpenAIFunctions } = require('./mcp-langchain-adapter');

const binding = new MCPToolBinding(mcpClient);
await binding.bindAll();

// 从绑定器生成
const functions = toOpenAIFunctions(binding);

// 或从适配器数组生成
const adapters = Array.from(binding.getAdapters().values());
const functions2 = toOpenAIFunctions(adapters);
```

### 便捷函数：快速生成LangChain工具

```javascript
const { createLangChainTools } = require('./mcp-langchain-adapter');

// 一步生成，无需手动创建绑定器
const tools = createLangChainTools(mcpClient, {
  serverFilter: ['filesystem'],
});
```

### 调用统计

```javascript
const binding = new MCPToolBinding(mcpClient, skillRegistry, { autoRegister: true });
await binding.bindAll();

// 执行若干工具调用...
await binding.invokeTool('mcp_fs_read_file', { path: '/tmp/test.txt' });

// 查看统计
const stats = binding.getStats();
console.log(stats);
// { boundTools: 3, registeredSkills: 3, totalCalls: 1, totalErrors: 0 }
```

## 与其他模块的集成

| 模块 | 集成方式 |
|------|---------|
| MCPClient | 依赖其 `callTool` 和 `getAvailableTools` 方法，作为工具发现和调用的底层通道 |
| LangChainMCPBridge | 共享MCP协议层，本模块提供工具适配，LangChainMCPBridge提供链/图编排 |
| 技能注册中心（SkillRegistry） | 通过 `MCPToolBinding` 的 `autoRegister` 选项将MCP工具自动注册为Harness Skill |
| LangChain Agent | 通过 `getLangChainCompatibleTools()` 输出可直接注入Agent的工具列表 |
| OpenAI LLM | 通过 `toOpenAIFunctions()` 生成Function Calling格式的工具定义 |
| debug-logger | 使用 `debug` 函数记录适配器调用错误和绑定异常 |

## 注意事项

1. **构造校验**：`MCPToolAdapter` 要求 `mcpClient` 必须具有 `callTool` 方法、`toolDef` 必须具有有效的 `name` 字符串；`MCPToolBinding` 要求 `mcpClient` 必须具有 `getAvailableTools` 方法，否则抛出 `TypeError`
2. **技能注册上限**：已注册技能数量受 `MAX_SKILLS`（100）限制，超出时自动淘汰最早注册的技能（FIFO）
3. **Schema转换**：`_convertSchema` 对空或非对象schema返回默认值 `{ type: 'object', properties: {} }`，`additionalProperties` 仅在显式为 `false` 时才设为 `false`
4. **LangChain func行为**：`toLangChainTool()` 返回的 `func` 在调用失败时抛出 `Error`，成功时返回 `JSON.stringify(result)`，需注意结果为字符串而非对象
5. **bindAll幂等性**：重复调用 `bindAll()` 会向 `_adapters` Map 中追加适配器（同名工具会覆盖），不会清空已有绑定
6. **getAdapters返回副本**：`getAdapters()` 返回Map的浅拷贝，修改返回值不影响内部状态
7. **createLangChainTools同步性**：该便捷函数是同步的，因为 `getAvailableTools()` 为同步方法；而 `MCPToolBinding.bindAll()` 是异步的（因涉及自动注册）
8. **过滤逻辑**：`serverFilter` 匹配 `tool.server`，`toolFilter` 匹配 `tool.originalName`（非全名），两者均为 `null` 时不过滤

## 相关文档

- [模块详解-MCPClient模块](模块详解-MCPClient模块.md)
- [模块详解-LangChainMCPBridge](模块详解-LangChainMCPBridge.md)
- [模块详解-技能子系统](模块详解-技能子系统.md)
- [模块详解-适配器子系统](模块详解-适配器子系统.md)
