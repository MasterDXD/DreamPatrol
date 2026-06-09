# 模块详解-LangSmithMCPBridge

> 版本：2.73.4 | 文件：src/runtime/infrastructure/langsmith-mcp-bridge.js | Python服务：sdk/python/langsmith_mcp_server.py

## 概述

LangSmithMCPBridge 是 Harness 引擎与 LangSmith 平台之间的桥接模块，通过 MCP（Model Context Protocol）协议与 Python LangSmith MCP Server 通信，提供 LLM 调用追踪、评估数据集管理、反馈评分和评估运行能力。

LangSmith 是 LangChain 生态的可观测性与评估平台，用于追踪、评估和监控 LLM 应用。本模块将其能力以 MCP 工具形式暴露给 Node.js 运行时，实现跨语言无缝集成。

## 核心能力

| 能力 | 说明 |
|------|------|
| 追踪管理 | 创建/列出 LLM 调用追踪记录，获取统计信息 |
| 数据集管理 | 创建评估数据集，添加示例，列出数据集 |
| 反馈管理 | 对追踪结果进行评分标注，列出反馈记录 |
| 评估运行 | 对数据集执行评估并记录结果 |
| 健康检查 | 检查 MCP Server 及 LangSmith 连接状态 |

## 集成架构

```
┌─────────────────────┐     MCP (JSON-RPC 2.0)    ┌──────────────────────────┐
│   Node.js Runtime   │ ◄──────────────────────► │  Python MCP Server       │
│                     │     stdio / SSE           │  (langsmith_mcp_server)  │
│  LangSmithMCPBridge │                           │                          │
│  - createTrace()    │ ──── trace_create ────►   │  langsmith.Client        │
│  - listTraces()     │ ◄─── trace_list ──────   │  (LangSmith SDK)         │
│  - createDataset()  │ ──── dataset_create ──►   │                          │
│  - createFeedback() │ ──── feedback_create ─►   │                          │
│  - runEvaluation()  │ ──── evaluation_run ──►   │                          │
└─────────────────────┘                           └──────────────────────────┘
```

## 常量

### RUN_TYPES

| 常量 | 值 | 说明 |
|------|------|------|
| LLM | `'llm'` | 大语言模型调用 |
| CHAIN | `'chain'` | 链式调用 |
| TOOL | `'tool'` | 工具调用 |
| RETRIEVER | `'retriever'` | 检索器调用 |

### DATA_TYPES

| 常量 | 值 | 说明 |
|------|------|------|
| KV | `'kv'` | 键值对数据 |
| LLM | `'llm'` | LLM 数据 |
| CHAT | `'chat'` | 对话数据 |

### DEFAULT_OPTIONS

| 选项 | 默认值 | 说明 |
|------|------|------|
| mcpServerCommand | `'python'` | MCP Server 启动命令 |
| mcpServerArgs | `['sdk/python/langsmith_mcp_server.py', '--transport', 'stdio']` | 启动参数 |
| mcpServerEnv | `{}` | 环境变量 |
| requestTimeout | `30000` | 请求超时(ms) |

## 核心 API

### attachMCPClient(client)

绑定 MCPClient 实例。必须在调用其他 API 前完成绑定。

| 参数 | 类型 | 说明 |
|------|------|------|
| client | MCPClient | 具有 `callTool` 方法的 MCP 客户端 |
| 返回 | boolean | 绑定成功返回 true |

### createTrace(name, runType, inputs, options?)

创建追踪记录，记录 LLM 调用的输入、输出和元数据。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 追踪名称 |
| runType | string | 是 | 运行类型（RUN_TYPES 之一） |
| inputs | object | 是 | 输入数据 |
| options.outputs | object | 否 | 输出数据 |
| options.metadata | object | 否 | 元数据 |
| options.tags | string[] | 否 | 标签 |
| options.error | string | 否 | 错误信息 |

### listTraces(options?)

列出追踪记录。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| options.limit | number | 否 | 返回数量上限（默认20） |
| options.runType | string | 否 | 按运行类型过滤 |

### getTraceStats()

获取追踪统计信息，包括按类型/状态分布。

### createDataset(name, options?)

创建评估数据集。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 数据集名称 |
| options.description | string | 否 | 数据集描述 |
| options.dataType | string | 否 | 数据类型（默认'kv'） |

### addExamples(datasetName, examples)

向数据集添加示例。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| datasetName | string | 是 | 数据集名称 |
| examples | Array<{inputs, outputs?}> | 是 | 示例列表 |

### listDatasets(options?)

列出所有数据集。

### createFeedback(traceId, key, score, options?)

创建反馈记录，对追踪结果进行评分。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| traceId | string | 是 | 追踪 ID |
| key | string | 是 | 反馈键名（如 correctness/relevance/quality） |
| score | number | 是 | 评分（0-1） |
| options.value | string | 否 | 反馈值 |
| options.comment | string | 否 | 评论 |

### listFeedbacks(options?)

列出反馈记录。

### runEvaluation(datasetName, evaluatorName, options?)

运行评估，对数据集中的示例执行目标函数并记录结果。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| datasetName | string | 是 | 数据集名称 |
| evaluatorName | string | 是 | 评估器名称 |
| options.description | string | 否 | 评估描述 |

### healthCheck()

检查 MCP Server 健康状态，返回 LangSmith 版本和存储统计。

### getStats()

获取桥接器运行统计（tracesCreated/datasetsCreated/feedbacksCreated/evaluationsRun/healthChecks/connected）。

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `trace-created` | 创建追踪成功 | `{name, runType}` |
| `dataset-created` | 创建数据集成功 | `{name}` |
| `feedback-created` | 创建反馈成功 | `{traceId, key, score}` |
| `evaluation-run` | 运行评估成功 | `{datasetName, evaluatorName}` |
| `shutdown` | 桥接器关闭 | 无 |

## 使用示例

```javascript
const { LangSmithMCPBridge, RUN_TYPES, DATA_TYPES } = require('./runtime/infrastructure/langsmith-mcp-bridge');

const bridge = new LangSmithMCPBridge();

// 绑定 MCPClient
bridge.attachMCPClient(mcpClient);

// 创建追踪
const trace = await bridge.createTrace('my-llm-call', RUN_TYPES.LLM,
  { prompt: 'Hello, world!' },
  { outputs: { response: 'Hi there!' }, tags: ['greeting'] }
);

// 创建数据集并添加示例
await bridge.createDataset('test-dataset', {
  description: '测试数据集',
  dataType: DATA_TYPES.KV,
});
await bridge.addExamples('test-dataset', [
  { inputs: { question: '2+2?' }, outputs: { answer: '4' } },
]);

// 对追踪创建反馈
await bridge.createFeedback(trace.trace_id, 'correctness', 0.95, {
  comment: '回答准确',
});

// 运行评估
const evalResult = await bridge.runEvaluation('test-dataset', 'accuracy-checker');

// 获取统计
console.log(bridge.getStats());

// 关闭
await bridge.shutdown();
```

## Python MCP Server

### 启动方式

```bash
# stdio 模式（默认，由 MCPClient 自动启动）
python sdk/python/langsmith_mcp_server.py --transport stdio

# SSE 模式（独立部署）
python sdk/python/langsmith_mcp_server.py --transport sse --port 8766
```

### MCP 工具列表

| 工具名 | 说明 | 必填参数 |
|--------|------|---------|
| `trace_create` | 创建追踪记录 | name, run_type, inputs |
| `trace_list` | 列出追踪记录 | - |
| `trace_get_stats` | 获取追踪统计 | - |
| `dataset_create` | 创建数据集 | name |
| `dataset_add_examples` | 添加示例 | dataset_name, examples |
| `dataset_list` | 列出数据集 | - |
| `feedback_create` | 创建反馈 | trace_id, key, score |
| `feedback_list` | 列出反馈 | - |
| `evaluation_run` | 运行评估 | dataset_name, evaluator_name |
| `health_check` | 健康检查 | - |

## 与其他模块的集成

| 模块 | 集成方式 |
|------|---------|
| MCPClient | 通过 attachMCPClient 绑定，使用 callTool 调用 MCP 工具 |
| LangChainMCPBridge | 共享 MCP 协议层，LangSmith 追踪可记录 LangChain 链调用 |
| QualityScorer | 反馈评分可与质量评分器联动 |
| EvaluationCalibrator | 评估结果可输入校准器进行二元判断 |
| withShutdown | 混入关闭能力（guardShutdown/isHealthy/shutdown） |

## 注意事项

1. **环境要求**：需要 Python 3.10+ 和 langsmith>=0.8（已作为 langchain-core 依赖安装）
2. **环境变量**：若需连接 LangSmith 云端，需设置 `LANGSMITH_API_KEY` 和 `LANGSMITH_PROJECT` 环境变量
3. **传输模式**：stdio 模式由 MCPClient 自动管理进程生命周期；SSE 模式需独立部署
4. **线程安全**：MCP Server 使用内存存储，重启后数据丢失；生产环境应配置 LangSmith 云端持久化
5. **版本兼容**：当前 langsmith 0.8.9 与 langchain-core 1.4+ 兼容，无已知冲突

## 相关文档

- [模块详解-LangChainMCPBridge](模块详解-LangChainMCPBridge.md)
- [模块详解-MCPClient模块](模块详解-MCPClient模块.md)
- [模块详解-StateGraph状态图引擎](模块详解-StateGraph状态图引擎.md)
- [LangSmith 官方文档](https://docs.smith.langchain.com/)
