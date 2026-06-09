# 模块详解-LangChainMCPBridge

> 版本：2.73.4 | 文件：src/runtime/infrastructure/langchain-mcp-bridge.js | Python服务：sdk/python/langchain_mcp_server.py

## 概述

LangChainMCPBridge 是 Harness 引擎与 LangChain/LangGraph 生态之间的桥接模块，通过 MCP（Model Context Protocol）协议与 Python LangChain MCP Server 通信，提供链管理、图管理、模板管理和健康检查能力。

LangChain 是构建 LLM 应用的主流框架，LangGraph 是其工作流编排扩展，支持基于状态图的复杂 Agent 流程。本模块将 LangChain 的链执行、LangGraph 的状态图编排以及 Prompt 模板管理能力以 MCP 工具形式暴露给 Node.js 运行时，实现跨语言无缝集成。

## 核心能力

| 能力 | 说明 |
|------|------|
| 链管理 | 创建、执行、列出 LangChain 链（顺序链/分支链/映射归约链） |
| 图管理 | 创建、执行、可视化 LangGraph 状态图 |
| 模板管理 | 创建、渲染 Prompt 模板 |
| 健康检查 | 检查 MCP Server 及 LangChain/LangGraph 运行状态 |

## 集成架构

```
┌─────────────────────┐     MCP (JSON-RPC 2.0)    ┌──────────────────────────┐
│   Node.js Runtime   │ ◄──────────────────────► │  Python MCP Server       │
│                     │     stdio / SSE           │  (langchain_mcp_server)  │
│  LangChainMCPBridge │                           │                          │
│  - createChain()    │ ──── chain_create ────►   │  langchain_core          │
│  - invokeChain()    │ ──── chain_invoke ────►   │  (Runnable/Sequence)     │
│  - createGraph()    │ ──── graph_create ────►   │                          │
│  - invokeGraph()    │ ──── graph_invoke ────►   │  langgraph               │
│  - visualizeGraph() │ ──── graph_visualize ─►   │  (StateGraph/END/START)  │
│  - createPrompt()   │ ──── prompt_template_ ─►  │                          │
│  - renderPrompt()   │ ──── prompt_template_ ─►  │  ChatPromptTemplate      │
│  - healthCheck()    │ ──── health_check ────►   │                          │
└─────────────────────┘                           └──────────────────────────┘
```

## 常量

### CHAIN_TYPES

| 常量 | 值 | 说明 |
|------|------|------|
| SEQUENTIAL | `'sequential'` | 顺序链，步骤按顺序依次执行 |
| BRANCHING | `'branching'` | 分支链，根据条件选择不同执行路径 |
| MAP_REDUCE | `'map_reduce'` | 映射归约链，先映射再归约 |

### NODE_TYPES

| 常量 | 值 | 说明 |
|------|------|------|
| PROCESS | `'process'` | 处理节点，执行数据处理逻辑 |
| DECISION | `'decision'` | 决策节点，根据条件选择分支 |
| PARALLEL | `'parallel'` | 并行节点，并行执行多个任务 |
| MERGE | `'merge'` | 合并节点，汇聚多个分支结果 |

### DEFAULT_OPTIONS

| 选项 | 默认值 | 说明 |
|------|------|------|
| mcpServerCommand | `'python'` | MCP Server 启动命令 |
| mcpServerArgs | `['sdk/python/langchain_mcp_server.py', '--transport', 'stdio']` | 启动参数 |
| mcpServerEnv | `{}` | 环境变量 |
| autoStart | `false` | 是否自动启动 MCP Server |
| requestTimeout | `30000` | 请求超时(ms) |

## 核心 API

### attachMCPClient(client)

绑定 MCPClient 实例。必须在调用其他 API 前完成绑定。

| 参数 | 类型 | 说明 |
|------|------|------|
| client | MCPClient | 具有 `callTool` 方法的 MCP 客户端 |
| 返回 | boolean | 绑定成功返回 true |

### createChain(chainType, name, steps)

创建 LangChain 链，支持顺序链、分支链和映射归约链。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| chainType | string | 是 | 链类型（CHAIN_TYPES 之一：sequential/branching/map_reduce） |
| name | string | 是 | 链名称 |
| steps | Array\<Object\> | 是 | 链步骤定义，每步包含 type/template/condition/transform |

**steps 步骤定义：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| type | string | 是 | 步骤类型（prompt/parser/lambda/conditional） |
| template | string | 否 | Prompt 模板内容（仅 prompt 类型） |
| condition | string | 否 | 条件表达式（仅 conditional 类型） |
| transform | string | 否 | 转换函数描述（仅 lambda 类型） |

**返回值：** `{success: boolean, chain_id?: string, error?: string}`

### invokeChain(chainId, input)

执行已创建的 LangChain 链。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| chainId | string | 是 | 链 ID（由 createChain 返回） |
| input | object | 是 | 链输入数据 |

**返回值：** `{success: boolean, result?: string, error?: string}`

### listChains()

列出所有已创建的链。

**返回值：** `{chains: Array<{id, name, type, step_count}>, total: number}`

### createGraph(name, stateSchema, nodes, edges)

创建 LangGraph 状态图，定义节点和边来构建工作流图。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 图名称 |
| stateSchema | object | 是 | 状态 schema 定义，包含 fields 数组 |
| nodes | Array\<Object\> | 是 | 节点定义，每项包含 id/type/description |
| edges | Array\<Object\> | 是 | 边定义，每项包含 from/to/condition? |

**stateSchema 定义：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| fields | Array\<{name, type, default?}\> | 是 | 状态字段，type 支持 str/int/float/bool/list/dict |

**nodes 节点定义：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 节点 ID |
| type | string | 是 | 节点类型（NODE_TYPES 之一：process/decision/parallel/merge） |
| description | string | 是 | 节点功能描述 |

**edges 边定义：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| from | string | 是 | 源节点 ID（支持 `'START'` 表示起始） |
| to | string | 是 | 目标节点 ID（支持 `'END'` 表示终止） |
| condition | string | 否 | 条件表达式 |

**返回值：** `{success: boolean, graph_id?: string, error?: string}`

### invokeGraph(graphId, input)

执行已创建的 LangGraph 状态图。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| graphId | string | 是 | 图 ID（由 createGraph 返回） |
| input | object | 是 | 图输入状态，需匹配 stateSchema 定义 |

**返回值：** `{success: boolean, result?: Object, error?: string}`

### visualizeGraph(graphId)

生成 LangGraph 状态图的可视化描述（Mermaid 格式）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| graphId | string | 是 | 图 ID |

**返回值：** `{graph_id: string, format: 'mermaid', diagram: string}`

### listGraphs()

列出所有已创建的状态图。

**返回值：** `{graphs: Array<{id, name, node_count, edge_count}>, total: number}`

### createPromptTemplate(name, template, variables)

创建 Prompt 模板，使用 `{variable}` 占位符。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 模板名称 |
| template | string | 是 | 模板内容，使用 {variable} 占位符 |
| variables | Array\<string\> | 是 | 变量列表 |

**返回值：** `{success: boolean, name?: string, error?: string}`

### renderPromptTemplate(name, values)

渲染 Prompt 模板，将变量替换为实际值。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 模板名称 |
| values | object | 是 | 变量值映射，键为变量名，值为替换内容 |

**返回值：** `{success: boolean, rendered?: string, error?: string}`

### healthCheck()

检查 MCP Server 健康状态，返回 LangChain 版本和存储统计。

**返回值：** `{status: string, langchain_version?: string, error?: string}`

### getStats()

获取桥接器运行统计。

**返回值：** `{chainsCreated, chainsInvoked, graphsCreated, graphsInvoked, templatesCreated, templatesRendered, healthChecks, connected}`

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `chain-created` | 创建链成功 | `{chainType, name}` |
| `graph-created` | 创建状态图成功 | `{name}` |
| `shutdown` | 桥接器关闭 | 无 |

## 使用示例

```javascript
const { LangChainMCPBridge, CHAIN_TYPES, NODE_TYPES } = require('./runtime/infrastructure/langchain-mcp-bridge');

const bridge = new LangChainMCPBridge();

// 绑定 MCPClient
bridge.attachMCPClient(mcpClient);

// 创建顺序链
const chain = await bridge.createChain(
  CHAIN_TYPES.SEQUENTIAL,
  'greeting-chain',
  [
    { type: 'prompt', template: '你好，{name}！请介绍{topic}。' },
    { type: 'parser' },
  ]
);

// 执行链
const result = await bridge.invokeChain(chain.chain_id, {
  name: '小明',
  topic: '人工智能',
});

// 创建 LangGraph 状态图
const graph = await bridge.createGraph(
  'research-workflow',
  { fields: [
    { name: 'query', type: 'str' },
    { name: 'result', type: 'str' },
  ]},
  [
    { id: 'search', type: NODE_TYPES.PROCESS, description: '搜索信息' },
    { id: 'analyze', type: NODE_TYPES.PROCESS, description: '分析结果' },
    { id: 'summarize', type: NODE_TYPES.MERGE, description: '汇总输出' },
  ],
  [
    { from: 'START', to: 'search' },
    { from: 'search', to: 'analyze' },
    { from: 'analyze', to: 'summarize' },
    { from: 'summarize', to: 'END' },
  ]
);

// 执行状态图
const graphResult = await bridge.invokeGraph(graph.graph_id, {
  query: 'LangGraph 工作流',
  result: '',
});

// 可视化状态图
const viz = await bridge.visualizeGraph(graph.graph_id);
console.log(viz.diagram); // Mermaid 格式图

// 创建并渲染 Prompt 模板
await bridge.createPromptTemplate(
  'code-review',
  '请审查以下{language}代码：\n{code}',
  ['language', 'code']
);
const rendered = await bridge.renderPromptTemplate('code-review', {
  language: 'JavaScript',
  code: 'function hello() { return "world"; }',
});

// 健康检查
const health = await bridge.healthCheck();

// 获取统计
console.log(bridge.getStats());

// 关闭
await bridge.shutdown();
```

## Python MCP Server

### 启动方式

```bash
# stdio 模式（默认，由 MCPClient 自动启动）
python sdk/python/langchain_mcp_server.py --transport stdio

# SSE 模式（独立部署）
python sdk/python/langchain_mcp_server.py --transport sse --port 8765
```

### MCP 工具列表

| 工具名 | 说明 | 必填参数 |
|--------|------|---------|
| `chain_create` | 创建 LangChain 链 | chain_type, name, steps |
| `chain_invoke` | 执行已创建的链 | chain_id, input |
| `chain_list` | 列出所有链 | - |
| `graph_create` | 创建 LangGraph 状态图 | name, state_schema, nodes, edges |
| `graph_invoke` | 执行状态图 | graph_id, input |
| `graph_visualize` | 生成 Mermaid 可视化 | graph_id |
| `graph_list` | 列出所有状态图 | - |
| `prompt_template_create` | 创建 Prompt 模板 | name, template, variables |
| `prompt_template_render` | 渲染 Prompt 模板 | name, values |
| `health_check` | 健康检查 | - |

## 与其他模块的集成

| 模块 | 集成方式 |
|------|---------|
| MCPClient | 通过 attachMCPClient 绑定，使用 callTool 调用 MCP 工具 |
| LangSmithMCPBridge | 共享 MCP 协议层，LangSmith 追踪可记录 LangChain 链调用 |
| StateGraph状态图引擎 | LangGraph 状态图与 StateGraph 引擎概念对齐，可协同编排 |
| LangChainRunnableAdapter | 与现有 LangChain Runnable 适配器协同，扩展链执行能力 |
| withShutdown | 混入关闭能力（guardShutdown/isHealthy/shutdown） |

## 注意事项

1. **环境要求**：需要 Python 3.10+、langchain-core>=0.3 和 langgraph>=0.2
2. **传输模式**：stdio 模式由 MCPClient 自动管理进程生命周期；SSE 模式需独立部署，默认端口 8765
3. **内存存储**：MCP Server 使用内存存储链/图/模板数据，重启后数据丢失
4. **链步骤类型**：步骤类型支持 prompt（模板）、parser（输出解析）、lambda（转换函数）、conditional（条件分支）
5. **状态图节点**：可视化时不同节点类型对应不同 Mermaid 图形——process 圆角矩形、decision 菱形、parallel 双层矩形、merge 方括号
6. **条件边**：当前 Python 端对条件边做简化处理，统一按普通边添加；复杂条件路由需在节点函数内实现
7. **版本兼容**：langchain-core 1.4+ 与 langgraph 0.2+ 兼容，无已知冲突

## 相关文档

- [模块详解-LangSmithMCPBridge](模块详解-LangSmithMCPBridge.md)
- [模块详解-MCPClient模块](模块详解-MCPClient模块.md)
- [模块详解-StateGraph状态图引擎](模块详解-StateGraph状态图引擎.md)
- [LangChain 官方文档](https://python.langchain.com/)
- [LangGraph 官方文档](https://langchain-ai.github.io/langgraph/)
