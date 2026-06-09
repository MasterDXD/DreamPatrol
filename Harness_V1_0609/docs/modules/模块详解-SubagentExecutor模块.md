# 模块详解-SubagentExecutor模块

> 版本：2.73.4 | 文件：src/runtime/agent/subagent-executor.js

---

## 模块概述

SubagentExecutor是Harness多Agent框架中的子Agent执行器，负责子Agent的完整生命周期管理——从生成、调度、执行到取消和重试。它是实现多Agent并行协作的核心运行时组件，支持并行和串行两种执行模式，内置超时保护、Token预算控制和模型自动选择机制。

该模块继承自Node.js的EventEmitter，通过事件机制向外部暴露子Agent的状态变更，便于上层编排器（如GoalExecutor、PhaseOrchestrator）进行流程管控。

## 类定义

```javascript
class SubagentExecutor extends EventEmitter { ... }
```

通过`withShutdown`混入后导出，自动获得`shutdown()`方法和`_onShutdown()`生命周期钩子。

### 静态属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `SubagentExecutor.STATUS` | Object | 子Agent状态枚举：`pending`、`running`、`completed`、`failed`、`cancelled` |
| `SubagentExecutor.DEFAULT_CONFIG` | Object | 默认配置对象 |

## 构造函数

### `new SubagentExecutor(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options.maxConcurrent` | number | 否 | 5 | 最大并发子Agent数量 |
| `options.defaultTimeout` | number | 否 | DEFAULT_SUBAGENT_TIMEOUT_MS | 子Agent默认超时时间（毫秒） |
| `options.maxSubagentsPerTask` | number | 否 | 5 | 单次并行任务最大子Agent数 |
| `options.tokenBudgetPerSubagent` | number | 否 | 50000 | 每个子Agent的Token预算 |
| `options.enableResultStreaming` | boolean | 否 | true | 是否启用结果流式传输 |
| `options.enableAutoRetry` | boolean | 否 | true | 是否启用自动重试 |
| `options.maxRetries` | number | 否 | 1 | 最大重试次数 |
| `options.defaultModel` | string | 否 | 'gpt-4o-mini' | 默认模型名称 |

## 附件方法（依赖注入）

SubagentExecutor采用附件模式（Attachment Pattern）注入外部依赖，所有附件方法返回`this`以支持链式调用。

### `attachSessionManager(sessionManager)`

注入会话管理器，用于Token预算检查和使用量上报。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionManager` | Object | 是 | 必须实现`addTokenUsage(sessionId, tokens)`方法 |

**返回值**：`this`

### `attachModelSelector(modelSelector)`

注入模型选择器，用于根据Skill和上下文自动选择最优模型。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `modelSelector` | Object | 是 | 必须实现`selectModel(skillId, context)`和`getTier(model)`方法 |

**返回值**：`this`

### `attachRBACEnforcer(rbacEnforcer)`

注入RBAC执行器，用于获取Agent角色定义的模型配置。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `rbacEnforcer` | Object | 是 | 必须实现`getAgentModel(agentId)`方法 |

**返回值**：`this`

### `attachAgentRuntime(agentRuntime)`

注入Agent运行时，用于注册子Agent实例。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentRuntime` | Object | 是 | 必须实现`register(agentId, config)`方法，且拥有`agents` Map属性 |

**返回值**：`this`

### `attachContextManager(contextManager)`

注入上下文管理器，用于创建隔离上下文。若未注入，将自动创建IsolatedContextManager实例。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `contextManager` | Object | 是 | 必须实现`createIsolatedContext(options)`方法 |

**返回值**：`this`

## 核心方法

### `spawn(task, agentConfig)`

生成一个子Agent并返回操作句柄。此方法是子Agent创建的入口点。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task` | Object | 是 | 任务对象，必须包含`description`字段（字符串，最长2048字符） |
| `task.description` | string | 是 | 任务描述 |
| `task.sessionId` | string | 否 | 关联的会话ID，用于Token预算检查 |
| `task.context` | string | 否 | 注入到子Agent上下文的额外信息 |
| `task.timeout` | number | 否 | 覆盖默认超时时间 |
| `task.skillId` | string | 否 | 关联的Skill ID，用于模型选择 |
| `agentConfig` | Object | 否 | Agent配置 |
| `agentConfig.agentId` | string | 否 | Agent角色ID，默认'task-worker' |
| `agentConfig.skillId` | string | 否 | Skill ID（优先级高于task.skillId） |
| `agentConfig.toolSet` | Array | 否 | 子Agent可用的工具集 |
| `agentConfig.constraints` | Array | 否 | 约束条件列表 |
| `agentConfig.successCriteria` | Array | 否 | 成功标准列表 |
| `agentConfig.tokenBudget` | number | 否 | 覆盖默认Token预算 |

**返回值**：`HandleAPI | null`

验证失败时返回`null`。验证条件包括：
- 系统未关闭
- task对象有效且包含description
- 未达到最大并发数
- 会话Token预算未耗尽

HandleAPI对象结构：

| 属性/方法 | 类型 | 说明 |
|-----------|------|------|
| `handleId` | string | 句柄唯一ID（前缀'sa-'） |
| `contextId` | string | 隔离上下文ID |
| `agentId` | string | Agent角色ID |
| `status` | string | 当前状态 |
| `isPending` | boolean | 是否等待中（getter） |
| `isRunning` | boolean | 是否运行中（getter） |
| `isCompleted` | boolean | 是否已完成（getter） |
| `isFailed` | boolean | 是否已失败（getter） |
| `result` | any | 执行结果（getter） |
| `error` | string | 错误信息（getter） |
| `cancel()` | Function | 取消该子Agent |
| `refresh()` | Function | 刷新句柄状态 |

### `spawnParallel(tasks, agentConfigs)`

批量生成子Agent，受`maxSubagentsPerTask`限制。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tasks` | Array\<Object\> | 是 | 任务对象数组 |
| `agentConfigs` | Array\<Object\> | 否 | Agent配置数组；若长度不足，复用第一个配置 |

**返回值**：`Array<HandleAPI>` — 成功生成的句柄列表

### `executeParallel(tasks, agentConfigs, executeFn)`

批量生成并并行执行子Agent，等待所有完成后返回汇总结果。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tasks` | Array\<Object\> | 是 | 任务对象数组 |
| `agentConfigs` | Array\<Object\> | 否 | Agent配置数组 |
| `executeFn` | Function | 是 | 执行函数，签名为`executeFn(taskWithContext, handle) => Promise<any>` |

**返回值**：`Promise<{ results: Array, errors: Array, allSettled: Array }>`

使用`Promise.allSettled`确保所有子Agent执行完毕，不会因单个失败而中断。

### `executeWithVerification(task, agentConfig, executeFn, verifyFn)`

带验证的执行模式：执行子Agent后验证结果，验证失败则重试。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task` | Object | 是 | 任务对象 |
| `agentConfig` | Object | 否 | Agent配置 |
| `executeFn` | Function | 是 | 执行函数 |
| `verifyFn` | Function | 否 | 验证函数，签名为`verifyFn(output, task) => { passed: boolean, feedback?: string }` |

**返回值**：`Promise<Object>`

```javascript
// 成功时
{ success: true, result: any, verifyResult: Object, iteration: number }

// 验证失败且重试用尽
{ success: false, result: any, verifyResult: Object, iteration: number, reason: 'verification_failed' }

// 生成失败
{ success: false, error: string, iteration: number }
```

迭代次数由`enableAutoRetry`和`maxRetries`控制：启用自动重试时为`maxRetries + 1`次，否则仅1次。

### `cancel(handleId)`

取消指定子Agent。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `handleId` | string | 是 | 子Agent句柄ID |

**返回值**：`boolean` — 是否成功取消

取消操作会：
1. 设置状态为`cancelled`
2. 清除超时定时器
3. 中止AbortController
4. 拒绝执行Promise
5. 释放隔离上下文
6. 移入完成历史

### `cancelAll()`

取消所有活跃的子Agent。

**返回值**：`number` — 成功取消的数量

### `getHandle(handleId)`

获取指定句柄的快照信息（包括已完成的历史句柄）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `handleId` | string | 是 | 子Agent句柄ID |

**返回值**：`Object | null`

返回的快照结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `handleId` | string | 句柄ID |
| `contextId` | string | 上下文ID |
| `agentId` | string | Agent角色ID |
| `status` | string | 当前状态 |
| `taskDescription` | string | 任务描述 |
| `result` | any | 执行结果 |
| `error` | string | 错误信息 |
| `tokensUsed` | number | 已消耗Token数 |
| `createdAt` | number | 创建时间戳 |
| `startedAt` | number | 开始时间戳 |
| `completedAt` | number | 完成时间戳 |
| `retryCount` | number | 重试次数 |
| `model` | string | 使用的模型 |
| `modelSource` | string | 模型来源 |
| `modelTier` | string | 模型层级 |

### `getActiveHandles()`

获取所有活跃子Agent的快照列表。

**返回值**：`Array<Object>`

## 搜索缓存方法

### `cacheSearchResult(query, result)`

缓存搜索结果，用于子Agent间共享搜索数据。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索查询（最长1000字符） |
| `result` | any | 是 | 搜索结果 |

缓存容量上限100条，TTL为5分钟。超出容量时淘汰最早条目。

### `getCachedSearchResult(query)`

获取缓存的搜索结果。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索查询 |

**返回值**：`any | null` — 缓存命中返回结果，过期或不存在返回`null`

## 统计与监控方法

### `getStats()`

获取子Agent执行统计信息。

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalSpawned` | number | 总生成数 |
| `totalCompleted` | number | 总完成数 |
| `totalFailed` | number | 总失败数 |
| `totalCancelled` | number | 总取消数 |
| `totalRetries` | number | 总重试数 |
| `totalTokensUsed` | number | 总Token消耗 |
| `budgetExceeded` | number | 预算超限次数 |
| `modelSelections` | number | 模型选择次数 |
| `modelOverrides` | number | 模型覆盖次数 |
| `activeHandles` | number | 当前活跃句柄数 |
| `completedHandles` | number | 历史完成句柄数 |
| `maxConcurrent` | number | 最大并发数 |
| `tokenBudgetPerSubagent` | number | 每子Agent Token预算 |
| `successRate` | number | 成功率（0-1） |
| `avgTokensPerSubagent` | number | 平均每子Agent Token消耗 |

### `getTokenBudgetReport()`

获取Token预算使用报告。

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalTokensUsed` | number | 总Token消耗 |
| `budgetExceeded` | number | 预算超限次数 |
| `defaultBudgetPerSubagent` | number | 默认每子Agent预算 |
| `activeBudgets` | Array | 活跃子Agent预算详情 |
| `activeTotalBudget` | number | 活跃子Agent总预算 |
| `activeTotalUsed` | number | 活跃子Agent总消耗 |

### `isHealthy()`

检查执行器健康状态。

**返回值**：`boolean` — 当前活跃句柄数小于最大并发数时返回`true`

## 事件

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `subagent-spawned` | 子Agent创建成功 | `{ handleId, agentId, taskDescription, model, modelSource }` |
| `subagent-started` | 子Agent开始执行 | `{ handleId, agentId }` |
| `subagent-completed` | 子Agent执行完成 | `{ handleId, agentId, duration, tokensUsed, hadError, recovered, toolCalls, performanceInsight, summary }` |
| `subagent-failed` | 子Agent执行失败 | `{ handleId, agentId, error }` |
| `subagent-cancelled` | 子Agent被取消 | `{ handleId, agentId }` |
| `subagent-retry` | 子Agent重试 | `{ handleId, iteration, feedback }` |
| `spawn-rejected` | 子Agent生成被拒绝 | `{ reason, active?, sessionId? }` |

## 内部机制

### 模型选择优先级

1. **Agent定义覆盖**：若RBACEnforcer中Agent定义了`model`字段，优先使用
2. **Skill智能选择**：若ModelSelector可用且提供了skillId，由选择器决策
3. **默认降级**：使用`defaultModel`或`gpt-4o-mini`

### 结果截断

完成的子Agent结果若序列化后超过65536字节，将自动截断为2048字节的摘要，保留原始大小信息。

### 完成历史

已完成的句柄移入`_completedHandles`，最多保留100条，超出时淘汰最早的记录。

### 优雅关闭

`shutdown()`触发时：
1. 取消所有活跃子Agent
2. 清除所有超时定时器
3. 若拥有自创建的上下文管理器，关闭它
4. 清空所有内部数据结构
5. 置空外部依赖引用

## 使用示例

### 基础用法

```javascript
const SubagentExecutor = require('./src/runtime/agent/subagent-executor');

const executor = new SubagentExecutor({
  maxConcurrent: 3,
  tokenBudgetPerSubagent: 30000,
});

const handle = executor.spawn(
  { description: '分析src/目录下的代码质量', sessionId: 'sess-001' },
  { agentId: 'code-reviewer', skillId: 'code-review' }
);

if (handle) {
  console.log('子Agent已生成:', handle.handleId, handle.status);
}
```

### 并行执行

```javascript
const tasks = [
  { description: '审查认证模块安全性', sessionId: 'sess-001' },
  { description: '审查API模块安全性', sessionId: 'sess-001' },
  { description: '审查数据库模块安全性', sessionId: 'sess-001' },
];

const { results, errors } = await executor.executeParallel(
  tasks,
  [{ agentId: 'security-reviewer', skillId: 'security-audit' }],
  async (task, handle) => {
    return await performSecurityAudit(task);
  }
);
```

### 带验证的执行

```javascript
const result = await executor.executeWithVerification(
  { description: '生成用户模块单元测试', sessionId: 'sess-001' },
  { agentId: 'test-writer', skillId: 'tdd-implement' },
  async (task) => generateTests(task),
  (output, task) => {
    const passed = output.tests && output.tests.length > 0;
    return { passed, feedback: passed ? '' : '测试数量不足' };
  }
);
```

### 完整装配

```javascript
const executor = new SubagentExecutor({ maxConcurrent: 5 });
executor
  .attachSessionManager(sessionManager)
  .attachModelSelector(modelSelector)
  .attachRBACEnforcer(rbacEnforcer)
  .attachAgentRuntime(agentRuntime)
  .attachContextManager(contextManager);

executor.on('subagent-completed', (data) => {
  console.log(`子Agent ${data.handleId} 完成，耗时 ${data.duration}ms`);
});

executor.on('subagent-failed', (data) => {
  console.error(`子Agent ${data.handleId} 失败: ${data.error}`);
});
```

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/constants`（常量定义）
- 依赖：`../../utils/safe-assign`（配置合并）
- 依赖：`../../utils/debug-logger`（调试日志）
- 依赖：`../../utils/safe-execute`（安全执行）
- 依赖：`../../errors`（错误类型）
- 依赖：`../context/autoregressive-context-schema`（自回归上下文模式）
- 依赖：`../context/isolated-context-manager`（隔离上下文管理器）
- 依赖：`../../utils/shutdown-mixin`（优雅关闭混入）
- 被依赖：`src/index.js`（主入口装配）
- 被依赖：GoalExecutor（目标执行器）

## 相关文档

- [模块详解-GoalExecutor目标执行器](模块详解-GoalExecutor目标执行器.md)
- [核心功能-多Agent协作流程](../core/核心功能-多Agent协作流程.md)
- [模块详解-上下文管理模块](模块详解-上下文管理模块.md)
- [核心功能-上下文压缩引擎](../core/核心功能-上下文压缩引擎.md)
