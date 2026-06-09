# 模块详解-LangChainRunnableAdapter

> 版本：v2.72.0 | 文件：src/runtime/infrastructure/langchain-runnable-adapter.js

## 概述

LangChainRunnableAdapter 是 Harness 与 LangChain 生态系统的双向集成适配器。它在现有 MCPToolAdapter（单向：MCP → LangChain）基础上，扩展了以下核心能力：

1. **导入并执行** LangChain RunnableSequence 等 Runnable 对象
2. **导出** Harness 管道为 LangChain 兼容的 Runnable 接口
3. **转换** Harness StateGraph 与 LangGraph StateGraph 格式

该模块继承自 `EventEmitter`，并通过 `withShutdown` 混入获得优雅关闭能力，使用 `BoundedMap` 管理导入/导出的 Runnable 实例，防止内存泄漏。

## 核心能力

| 能力 | 说明 |
|------|------|
| Runnable 导入 | 将 LangChain Runnable（RunnableSequence、RunnableLambda 等）导入 Harness 并执行 |
| Runnable 导出 | 将 Harness 管道包装为 LangChain 兼容的 Runnable 对象（支持 invoke/batch/stream） |
| StateGraph 转换 | 将 Harness StateGraph 转换为 LangGraph 兼容格式（节点 + 边 + 配置） |
| 超时控制 | 执行导入的 Runnable 时支持自定义超时，默认 30 秒 |
| 有界存储 | 导入/导出的 Runnable 使用 BoundedMap 管理，容量上限默认 50，FIFO 淘汰 |
| 优雅关闭 | 通过 ShutdownMixin 支持 guardShutdown 守卫和 shutdown 生命周期 |

## 类定义

### LangChainRunnableAdapter

```js
class LangChainRunnableAdapter extends EventEmitter
```

继承链：`EventEmitter` → `LangChainRunnableAdapter`（通过 `withShutdown` 混入 `ShutdownMixin`）

#### 构造函数

```js
new LangChainRunnableAdapter(options = {})
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.maxRunnables` | number | 50 | 导入/导出 Runnable 的最大容量 |
| `options.pipelineExecutor` | object \| null | null | 管道执行器实例（预留） |
| `options.stateGraphFactory` | object \| null | null | StateGraph 工厂实例（预留） |

## 常量

该模块未导出独立常量。内部使用的默认值如下：

| 常量 | 值 | 说明 |
|------|----|------|
| 默认超时时间 | `30000` | `executeRunnable` 的默认超时，单位毫秒 |
| 默认最大容量 | `50` | 导入/导出 BoundedMap 的默认容量上限 |

## 核心 API

### importRunnable(runnableId, runnable, options)

导入一个 LangChain Runnable 以在 Harness 中执行。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `runnableId` | string | 是 | Runnable 的唯一标识符，不可为空字符串 |
| `runnable` | object | 是 | LangChain Runnable 对象，必须实现 `invoke()` 方法 |
| `options.inputSchema` | object | 否 | 输入 Schema 定义 |
| `options.outputSchema` | object | 否 | 输出 Schema 定义 |
| `options.description` | string | 否 | 描述信息，默认为 `Imported LangChain Runnable: {runnableId}` |

**返回值：** `{ runnableId: string, imported: boolean }`

**事件：** 触发 `runnable:imported`，携带 `{ runnableId }`

**异常：**
- `runnableId` 为空或非字符串时抛出错误
- `runnable` 无 `invoke()` 方法时抛出错误

---

### executeRunnable(runnableId, input, options)

执行已导入的 LangChain Runnable。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `runnableId` | string | 是 | 已导入的 Runnable 标识符 |
| `input` | object | 是 | 传递给 Runnable 的输入数据 |
| `options.timeout` | number | 否 | 超时时间（毫秒），默认 30000 |
| `options.metadata` | object | 否 | 传递给 Runnable 的元数据 |

**返回值：**

```js
{
  output: any,           // Runnable 执行结果
  metadata: {
    runnableId: string,  // Runnable 标识符
    durationMs: number,  // 执行耗时（毫秒）
    invocationCount: number, // 累计调用次数
    interrupted?: boolean    // 若因关闭中断则为 true
  }
}
```

**事件：** 触发 `runnable:executed`，携带 `{ runnableId, durationMs }`

**异常：**
- `runnableId` 未找到时抛出错误
- 执行超时时抛出错误
- 适配器已关闭时抛出 `AgentError`

---

### exportAsRunnable(pipelineId, pipeline, options)

将 Harness 管道导出为 LangChain 兼容的 Runnable 对象。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pipelineId` | string | 是 | 管道唯一标识符，不可为空字符串 |
| `pipeline` | object | 是 | Harness 管道对象，需实现 `execute()` 或 `run()` 方法 |
| `options.description` | string | 否 | 描述信息，默认为 `Harness Pipeline: {pipelineId}` |
| `options.inputMapping` | object | 否 | 输入字段映射，格式 `{ 目标字段: "源路径" }` |
| `options.outputMapping` | object | 否 | 输出字段映射，格式 `{ 目标字段: "源路径" }` |

**返回值：** `{ runnable: object, exported: boolean }`

其中 `runnable` 对象实现以下 LangChain Runnable 接口：

| 方法/属性 | 说明 |
|-----------|------|
| `invoke(input, runOptions)` | 单次调用，支持输入/输出映射 |
| `batch(inputs, runOptions)` | 批量调用，使用 `Promise.allSettled`，失败项返回 `{ error }` |
| `stream(input, runOptions)` | 流式调用（简化实现，yield 最终结果） |
| `lc_runnable` | 标记为 `true`，表示 LangChain Runnable |
| `lc_identifier` | `[pipelineId]`，Runnable 标识符 |
| `description` | 描述信息 |

**事件：** 触发 `runnable:exported`，携带 `{ pipelineId }`

**异常：**
- `pipelineId` 为空或非字符串时抛出错误
- 管道无 `execute()` 或 `run()` 方法时在调用时抛出错误

---

### convertToLangGraphFormat(stateGraph)

将 Harness StateGraph 转换为 LangGraph 兼容格式。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `stateGraph` | object | 是 | Harness StateGraph 实例，需实现 `getNodes()` 或 `getEdges()` 方法 |

**返回值：**

```js
{
  nodes: Array<{ id: string, type: string, metadata: object }>,
  edges: Array<{ source: string, target: string, type: string, condition: any }>,
  config: {
    id: string,            // 图 ID，默认 'converted-graph'
    name: string,          // 图名称，默认 'Converted StateGraph'
    sourceFormat: 'harness-state-graph',
    targetFormat: 'langgraph',
    convertedAt: string    // ISO 时间戳
  }
}
```

**异常：**
- `stateGraph` 为空时抛出错误
- `stateGraph` 无 `getNodes()` 或 `getEdges()` 方法时抛出错误

---

### listImportedRunnables()

列出所有已导入的 Runnable 信息。

**返回值：** `Array<{ runnableId: string, description: string, invocationCount: number, lastError: string | null }>`

---

### listExportedRunnables()

列出所有已导出的 Runnable 信息。

**返回值：** `Array<{ pipelineId: string, exportedAt: string }>`

---

### 私有方法

| 方法 | 说明 |
|------|------|
| `_applyMapping(data, mapping)` | 根据映射规则转换数据字段 |
| `_getNestedValue(obj, path)` | 通过点分隔路径获取嵌套属性值（如 `"a.b.c"`） |
| `_onShutdown()` | 关闭回调，清空 BoundedMap、移除监听器、释放引用 |

## 事件

| 事件名 | 携带数据 | 触发时机 |
|--------|----------|----------|
| `runnable:imported` | `{ runnableId }` | 成功导入 Runnable 时 |
| `runnable:executed` | `{ runnableId, durationMs }` | 成功执行 Runnable 时 |
| `runnable:exported` | `{ pipelineId }` | 成功导出管道为 Runnable 时 |
| `shutdown` | `{ signal }` | 适配器关闭时（由 ShutdownMixin 触发） |

## 使用示例

### 导入并执行 LangChain Runnable

```js
const LangChainRunnableAdapter = require('./runtime/infrastructure/langchain-runnable-adapter');

const adapter = new LangChainRunnableAdapter({ maxRunnables: 100 });

// 导入一个 LangChain RunnableSequence
adapter.importRunnable('my-chain', runnableSequence, {
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  description: '问答链',
});

// 执行
const result = await adapter.executeRunnable('my-chain', { query: '什么是Harness?' }, {
  timeout: 60000,
  metadata: { source: 'api' },
});
console.log(result.output);
console.log(`耗时: ${result.metadata.durationMs}ms`);
```

### 导出 Harness 管道为 LangChain Runnable

```js
// 导出管道
const { runnable } = adapter.exportAsRunnable('my-pipeline', pipelineExecutor, {
  description: '数据处理管道',
  inputMapping: { question: 'userInput.text' },
  outputMapping: { answer: 'result.content' },
});

// 在 LangChain 生态中使用
const output = await runnable.invoke({ userInput: { text: '你好' } });
const batchResults = await runnable.batch([
  { userInput: { text: '问题1' } },
  { userInput: { text: '问题2' } },
]);
```

### 转换 StateGraph 格式

```js
const langGraphFormat = adapter.convertToLangGraphFormat(harnessStateGraph);
console.log('节点数:', langGraphFormat.nodes.length);
console.log('边数:', langGraphFormat.edges.length);
console.log('转换时间:', langGraphFormat.config.convertedAt);
```

### 监听事件与优雅关闭

```js
adapter.on('runnable:imported', ({ runnableId }) => {
  console.log(`已导入: ${runnableId}`);
});

adapter.on('runnable:executed', ({ runnableId, durationMs }) => {
  console.log(`执行完成: ${runnableId}, 耗时 ${durationMs}ms`);
});

// 优雅关闭
adapter.shutdown();
await adapter.waitForShutdown();
```

## 与其他模块的集成

| 模块 | 集成方式 | 说明 |
|------|----------|------|
| `mcp-langchain-adapter` | 互补 | MCPToolAdapter 提供 MCP → LangChain 单向适配，本模块提供双向集成 |
| `langchain-mcp-bridge` | 协同 | 通过 MCP 协议与 Python LangChain MCP Server 通信，本模块提供本地 Runnable 适配 |
| `ShutdownMixin` (`shutdown-mixin`) | 混入 | 通过 `withShutdown` 为本模块提供 guardShutdown/shutdown 生命周期管理 |
| `BoundedMap` (`bounded-map`) | 内部使用 | 管理导入/导出的 Runnable 实例，容量满时 FIFO 淘汰 |
| `debug-logger` | 日志 | 关闭阶段记录调试日志 |
| `PipelineExecutor` | 预留 | 通过构造函数 `pipelineExecutor` 选项注入（预留扩展） |
| `StateGraph` | 预留 | 通过构造函数 `stateGraphFactory` 选项注入（预留扩展） |

## 注意事项

1. **容量限制**：导入/导出的 Runnable 数量受 `maxRunnables` 限制（默认 50），超出时按 FIFO 策略淘汰最早的条目，请根据业务需求合理设置容量。
2. **超时机制**：`executeRunnable` 使用 `Promise.race` 实现超时控制，超时后错误会被记录到 `lastError`，但不会取消底层 Runnable 的执行。
3. **关闭行为**：调用 `shutdown()` 后，所有 BoundedMap 被清空、监听器被移除、引用被释放。正在执行的 Runnable 若在关闭期间完成，结果会标记 `interrupted: true`。
4. **stream 简化实现**：导出的 Runnable 的 `stream()` 方法为简化实现，仅 yield 最终结果，不提供逐 token 流式输出。
5. **batch 错误处理**：导出的 Runnable 的 `batch()` 方法使用 `Promise.allSettled`，单个输入失败不影响其他输入，失败项返回 `{ error: message }`。
6. **字段映射**：`inputMapping` / `outputMapping` 支持点分隔路径（如 `"a.b.c"`），用于深层嵌套字段的提取与映射。
7. **线程安全**：`invocationCount` 非原子操作，在高并发场景下可能存在计数偏差。

## 相关文档

- [模块详解-MCPLangChainAdapter](./模块详解-MCPLangChainAdapter.md) — MCP 工具到 LangChain 的单向适配
- [模块详解-LangChainMCPBridge](./模块详解-LangChainMCPBridge.md) — 通过 MCP 协议桥接 Python LangChain
- [模块详解-BoundedMap](./模块详解-BoundedMap.md) — 有界映射工具类
- [模块详解-ShutdownMixin](./模块详解-ShutdownMixin.md) — 优雅关闭混入
