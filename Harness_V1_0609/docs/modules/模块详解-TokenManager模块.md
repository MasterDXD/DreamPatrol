# 模块详解-TokenManager模块

> 版本：2.73.4 | 文件：src/runtime/model/token-manager.js

---

## 模块概述

TokenManager是Harness多Agent框架中的令牌预算管理器，负责跟踪和控制多Agent协作过程中的Token消耗。它提供会话级和全局级的Token使用量统计，支持三层Token分类计数（输入、输出、工具调用），内置预算阈值预警机制（80%预警、95%切换低价模型、100%暂停任务），并通过事件机制向外部通知预算状态变更。

该模块是成本控制体系的核心组件，与SessionManager、ModelSelector、SubagentExecutor等模块紧密协作，确保多Agent协作在Token预算约束下安全运行。

## 类定义

```javascript
class TokenManager extends EventEmitter { ... }
```

通过`withShutdown`混入后导出，自动获得`shutdown()`方法和`_onShutdown()`生命周期钩子。

### 静态属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `TokenManager.TOKEN_UNITS` | Object | Token格式化单位映射：`{ K: 1e3, M: 1e6, B: 1e9 }` |

## 构造函数

### `new TokenManager(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options.defaultBudget` | number | 否 | DEFAULT_TOKEN_BUDGET (1,000,000,000) | 全局Token预算上限 |
| `options.maxSessions` | number | 否 | 1000 | 最大会话追踪数量 |

构造时初始化两个内部Map：
- `_sessionTokens`：会话ID → 已消耗Token数
- `_sessionBreakdowns`：会话ID → 分类Token消耗明细

当会话数达到`maxSessions`时，自动淘汰最早的会话记录。

## 核心方法

### `store(sessionId, amount)`

累加指定会话的Token消耗量，并自动触发预算阈值检查。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 会话ID，必须为非空字符串 |
| `amount` | number | 否 | Token消耗量，必须为非负有限数 |

**返回值**：`number` — 该会话当前的累计Token消耗

**异常**：
- `SessionError('SHUTDOWN')`：管理器已关闭
- `SessionError('INVALID_SESSION_ID')`：sessionId无效
- `SessionError('INVALID_TOKEN_AMOUNT')`：amount无效

**事件触发**（按优先级从高到低，仅触发一个）：
- `token-exhausted`：预算耗尽（≥100%）
- `token-warning-95`：达到危险阈值（≥95%）
- `token-warning-80`：达到预警阈值（≥80%）

### `get(sessionId)`

获取指定会话的累计Token消耗量。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 会话ID |

**返回值**：`number` — 累计Token消耗，不存在时返回0

**异常**：`SessionError('INVALID_SESSION_ID')` — sessionId无效

### `set(sessionId, amount)`

直接设置指定会话的Token消耗量（覆盖而非累加）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 会话ID |
| `amount` | number | 是 | Token消耗量，必须为非负有限数 |

**返回值**：`number` — 设置后的Token消耗量

**注意**：管理器已关闭时静默返回，不抛异常。

### `validate(sessionId, budget)`

验证指定会话的Token使用状态，检查是否达到各预警阈值。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 会话ID |
| `budget` | number | 否 | 自定义预算值，默认使用全局预算 |

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | string | 会话ID |
| `tokensUsed` | number | 已消耗Token数 |
| `budget` | number | 预算上限 |
| `ratio` | number | 使用比率（0-1+） |
| `warning80` | boolean | 是否达到80%预警阈值 |
| `warning95` | boolean | 是否达到95%危险阈值 |
| `exhausted` | boolean | 是否预算耗尽（≥100%） |

### `getUsage(sessionId, budget)`

获取指定会话的Token使用详情。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 会话ID |
| `budget` | number | 否 | 自定义预算值，默认使用全局预算 |

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `used` | number | 已消耗Token数 |
| `budget` | number | 预算上限 |
| `remaining` | number | 剩余Token数（最小为0） |
| `ratio` | number | 使用比率（0-1+） |

### `getTotal(budget)`

获取所有会话的Token总消耗。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `budget` | number | 否 | 自定义预算值，默认使用全局预算 |

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `total` | number | 所有会话总消耗 |
| `budget` | number | 预算上限 |
| `ratio` | number | 总使用比率 |

## 分类统计方法

### `addBreakdown(sessionId, category, amount)`

按分类累加Token消耗量，实现三层Token计数。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 会话ID |
| `category` | string | 是 | 分类名称（如'input'、'output'、'toolCall'） |
| `amount` | number | 是 | Token消耗量，必须为非负有限数 |

**返回值**：`Object` — 该会话的分类消耗明细

**异常**：
- `SessionError('INVALID_SESSION_ID')` — sessionId无效
- `SessionError('INVALID_BREAKDOWN_CATEGORY')` — category无效
- `SessionError('INVALID_TOKEN_AMOUNT')` — amount无效

**注意**：管理器已关闭时静默返回。

### `getBreakdown(sessionId)`

获取指定会话的分类Token消耗明细。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 会话ID |

**返回值**：`Object` — 分类消耗明细，如`{ input: 5000, output: 3000, toolCall: 1200 }`。不存在时返回空对象`{}`。

### `getAllBreakdowns(sessionId)`

获取分类Token消耗明细。若指定sessionId则返回该会话明细，否则返回所有会话明细。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 否 | 会话ID，不提供时返回所有会话 |

**返回值**：`Object` — 指定会话时返回该会话明细对象；不指定时返回`{ sessionId1: {...}, sessionId2: {...} }`

## 格式化方法

### `formatTokens(n)`

将Token数值格式化为人类可读的字符串。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `n` | number | 是 | Token数值 |

**返回值**：`string`

| 数值范围 | 格式 | 示例 |
|---------|------|------|
| ≥1B | `X.XXB` | `1.50B` |
| ≥1M | `X.XM` | `2.5M` |
| ≥1K | `XK` | `150K` |
| <1K | 整数字符串 | `500` |
| 无效/负数 | `'0'` | `'0'` |

### `parseFormatted(formatted)`

将格式化的Token字符串解析为数值。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `formatted` | string | 是 | 格式化字符串（如`'1.5B'`、`'200K'`、`'500M'`） |

**返回值**：`number` — 解析后的Token数值。无效输入返回0。

支持的单位后缀：`K`（×1000）、`M`（×1,000,000）、`B`（×1,000,000,000）。

## 预算管理方法

### `setGlobalBudget(budget)`

设置全局Token预算上限。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `budget` | number | 是 | 预算值，必须为正有限数 |

**返回值**：`number` — 设置后的预算值

**异常**：`SessionError('INVALID_BUDGET')` — budget无效

### `getGlobalBudget()`

获取当前全局Token预算上限。

**返回值**：`number`

## 会话管理方法

### `listSessions()`

列出所有已追踪的会话ID。

**返回值**：`Array<string>`

### `clear(sessionId)`

清除指定会话的Token记录和分类明细。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 会话ID |

**异常**：`SessionError('INVALID_SESSION_ID')` — sessionId无效

### `clearAll()`

清除所有会话的Token记录和分类明细。

## 统计方法

### `getStats(budget)`

获取全局Token使用统计信息。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `budget` | number | 否 | 自定义预算值，默认使用全局预算 |

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `total` | number | 所有会话总消耗 |
| `budget` | number | 预算上限 |
| `ratio` | number | 总使用比率 |
| `maxSession` | number | 单会话最大消耗 |
| `activeSessions` | number | 有消耗的会话数 |
| `totalSessions` | number | 追踪的会话总数 |

## 健康检查

### `isHealthy()`

检查管理器健康状态（由`withShutdown`混入提供）。

**返回值**：`boolean` — 管理器未关闭时返回`true`

## 事件

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `token-warning-80` | 会话Token消耗达到预算80% | `{ sessionId, tokensUsed, budget }` |
| `token-warning-95` | 会话Token消耗达到预算95% | `{ sessionId, tokensUsed, budget }` |
| `token-exhausted` | 会话Token消耗达到预算100% | `{ sessionId, tokensUsed, budget }` |

事件触发优先级：`token-exhausted` > `token-warning-95` > `token-warning-80`，每次`store()`调用最多触发一个事件。

## 预算阈值体系

| 阈值 | 常量 | 动作 | 说明 |
|------|------|------|------|
| 80% | TOKEN_BUDGET_WARNING_RATIO | 预警通知 | 提醒系统Token消耗较高，建议优化 |
| 95% | TOKEN_BUDGET_DANGER_RATIO | 切换低价模型 | 自动降级到成本更低的模型 |
| 100% | — | 暂停所有任务 | 预算耗尽，停止所有Token消耗操作 |

## 优雅关闭

`shutdown()`触发时：
1. 清空`_sessionTokens` Map
2. 清空`_sessionBreakdowns` Map

## 使用示例

### 基础用法

```javascript
const TokenManager = require('./src/runtime/model/token-manager');

const tm = new TokenManager({
  defaultBudget: 1000000,
  maxSessions: 500,
});

tm.store('sess-001', 5000);
tm.store('sess-001', 3000);

console.log(tm.get('sess-001'));
console.log(tm.validate('sess-001'));
console.log(tm.formatTokens(tm.get('sess-001')));
```

### 三层Token分类计数

```javascript
tm.addBreakdown('sess-001', 'input', 2000);
tm.addBreakdown('sess-001', 'output', 1500);
tm.addBreakdown('sess-001', 'toolCall', 800);

console.log(tm.getBreakdown('sess-001'));
```

### 预算预警监听

```javascript
tm.on('token-warning-80', (data) => {
  console.warn(`会话 ${data.sessionId} Token使用达80%: ${data.tokensUsed}/${data.budget}`);
});

tm.on('token-warning-95', (data) => {
  console.error(`会话 ${data.sessionId} Token使用达95%，切换低价模型`);
});

tm.on('token-exhausted', (data) => {
  console.error(`会话 ${data.sessionId} Token预算耗尽，暂停任务`);
});
```

### 全局统计与格式化

```javascript
const stats = tm.getStats();
console.log(`总消耗: ${tm.formatTokens(stats.total)}`);
console.log(`预算: ${tm.formatTokens(stats.budget)}`);
console.log(`使用率: ${(stats.ratio * 100).toFixed(1)}%`);
console.log(`活跃会话: ${stats.activeSessions}/${stats.totalSessions}`);

const total = tm.getTotal();
console.log(`剩余: ${tm.formatTokens(total.budget - total.total)}`);
```

### 与SessionManager集成

```javascript
const sessionManager = new SessionManager({ projectRoot });
const tokenManager = new TokenManager({ defaultBudget: 1e9 });

tokenManager.on('token-warning-95', () => {
  sessionManager.switchToCheapModel();
});

tokenManager.on('token-exhausted', () => {
  sessionManager.pauseAllTasks();
});
```

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../errors`（SessionError错误类型）
- 依赖：`../../utils/constants`（常量定义：DEFAULT_TOKEN_BUDGET、TOKEN_BUDGET_WARNING_RATIO、TOKEN_BUDGET_DANGER_RATIO等）
- 依赖：`../../utils/shutdown-mixin`（优雅关闭混入）
- 被依赖：SessionManager（会话管理器，Token预算检查）
- 被依赖：SubagentExecutor（子Agent执行器，Token使用上报）
- 被依赖：Web Dashboard（仪表盘，Token使用量展示）

## 相关文档

- [核心功能-上下文压缩引擎](../core/核心功能-上下文压缩引擎.md)
- [模块详解-上下文管理模块](模块详解-上下文管理模块.md)
- [模块详解-SubagentExecutor模块](模块详解-SubagentExecutor模块.md)
- [核心功能-成本控制机制](../core/核心功能-成本控制机制.md)
