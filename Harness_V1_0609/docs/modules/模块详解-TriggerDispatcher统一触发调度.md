# 模块详解-TriggerDispatcher统一触发调度

> 版本：2.73.4 | 文件：src/runtime/workflow/trigger-dispatcher.js | 行数：595行

---

## 模块定位

TriggerDispatcher 是统一触发调度引擎，负责将多种触发源（定时调度、Webhook回调、事件订阅、即发即忘）统一路由到ManagedAgentHost执行。融合自 Claude Managed Agents 的四种触发模式，通过简化版Cron解析器、间隔调度器、事件订阅路由和Webhook路由将外部触发事件分派给目标Agent。

作为工作流子系统的触发基础设施，它承担了"外部世界→框架Agent"的桥接角色，将时间驱动、事件驱动和HTTP驱动的触发源统一为Agent执行调用。

## 架构角色

```
                         TriggerDispatcher
                    ┌─────────────────────────┐
  时间触发 ────────→│  Cron / Interval 调度器  │
  Webhook触发 ────→│  Webhook 路由表          │──→ ManagedAgentHost.triggerExecution()
  事件触发 ────────→│  EventBus 事件订阅       │
  即发即忘 ────────→│  dispatchFireAndForget  │
                    └─────────────────────────┘
                              │
                              ↓
                     ManagedAgentHost
                     (Agent执行)
```

## 类定义

```javascript
class TriggerDispatcher extends EventEmitter {
  constructor(options)
  registerSchedule(agentId, config)
  unregisterSchedule(scheduleId)
  registerWebhook(path, agentId)
  unregisterWebhook(path)
  registerEventSubscription(eventType, agentId)
  unregisterEventSubscription(eventType, agentId)
  dispatchWebhook(path, payload, signature, rawBody)
  dispatchFireAndForget(agentId, payload)
  listSchedules()
  listWebhookRoutes()
  getStats()
  attachManagedHost(host)
  attachEventBus(bus)
  shutdown() // via withShutdown mixin
}

// 静态属性与方法
TriggerDispatcher.TRIGGER_TYPES
TriggerDispatcher.SCHEDULE_TYPES
TriggerDispatcher.parseCronExpression
```

## 触发类型

TriggerDispatcher支持四种触发模式（`TRIGGER_TYPES`）：

| 触发类型 | 枚举值 | 说明 |
|---------|--------|------|
| `EVENT` | `'event'` | 事件驱动触发，通过EventBus接收事件并路由到订阅Agent |
| `SCHEDULE` | `'schedule'` | 定时调度触发，支持Cron表达式和固定间隔两种方式 |
| `WEBHOOK` | `'webhook'` | HTTP Webhook触发，按路径路由到指定Agent |
| `FIRE_AND_FORGET` | `'fire-and-forget'` | 即发即忘，一次性异步触发Agent执行，不跟踪结果 |

## 调度类型

定时调度支持两种子类型（`SCHEDULE_TYPES`）：

| 调度类型 | 枚举值 | 说明 | 驱动方式 |
|---------|--------|------|---------|
| `INTERVAL` | `'interval'` | 固定间隔调度 | 独立`setInterval`定时器 |
| `CRON` | `'cron'` | Cron表达式调度 | 统一`_cronTimer`定时器批量检查 |

## 构造函数

### `constructor(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options` | object | 否 | `{}` | 配置选项 |
| `options.maxSchedules` | number | 否 | `200` | 最大调度数 |
| `options.maxWebhookRoutes` | number | 否 | `100` | 最大Webhook路由数 |
| `options.maxEventSubscriptions` | number | 否 | `500` | 最大事件订阅数 |
| `options.cronCheckIntervalMs` | number | 否 | `60000` | Cron检查间隔（毫秒） |

初始化内部状态：
- `_schedules` — 调度注册表（`Map<scheduleId, entry>`）
- `_webhookRoutes` — Webhook路由表（`Map<path, agentId>`）
- `_eventSubscriptions` — 事件订阅表（`Map<eventType, Set<agentId>>`）
- `_cronTimer` — Cron统一检查定时器，初始为null
- `_managedHost` — 注入的ManagedAgentHost引用
- `_eventBus` — 注入的EventBus引用
- `_eventHandlers` — 事件处理器引用映射（用于取消订阅）

## 公开方法详解

### `registerSchedule(agentId, config)`

注册定时调度，支持间隔和Cron两种类型。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | 目标Agent ID |
| `config` | object | 是 | 调度配置 |
| `config.type` | string | 是 | 调度类型：`'interval'` 或 `'cron'` |
| `config.intervalMs` | number | 条件 | 间隔毫秒数（interval类型必填，必须为正有限数） |
| `config.cron` | string | 条件 | Cron表达式（cron类型必填，5段空格分隔） |

**限制**：
- `agentId` 必须是非空字符串
- 调度总数不能超过 `maxSchedules`（默认200）
- Interval 类型：自动创建 `setInterval` 定时器（unref防止阻塞进程退出）
- Cron 类型：创建Cron匹配器，由统一 `_cronTimer` 驱动，通过 `lastFireMinute`（分钟级唯一键）防重

**返回值**：`{ scheduleId: string, type: string, agentId: string }`

### `unregisterSchedule(scheduleId)`

注销指定调度。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scheduleId` | string | 是 | 调度ID |

注销时自动清除对应的 `setInterval` 定时器。如果注销后没有剩余Cron调度，自动停止 `_cronTimer`。

**返回值**：`boolean` — 是否成功注销

### `registerWebhook(path, agentId)`

注册Webhook路由。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | Webhook路径，如 `/github/push` |
| `agentId` | string | 是 | 目标Agent ID |

**限制**：
- `path` 和 `agentId` 都必须是非空字符串
- 路由总数不能超过 `maxWebhookRoutes`（默认100）

**返回值**：`{ path: string, agentId: string }`

### `unregisterWebhook(path)`

注销Webhook路由。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | Webhook路径 |

**返回值**：`boolean` — 是否成功注销

### `registerEventSubscription(eventType, agentId)`

注册事件订阅。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `eventType` | string | 是 | 事件类型 |
| `agentId` | string | 是 | 目标Agent ID |

注册时如果已有 `EventBus` 注入且该 `eventType` 尚未监听，自动在 `EventBus` 上注册 `_handleEventBusTrigger` 处理器，确保后续事件能自动路由。

**限制**：
- `eventType` 必须是非空字符串
- 单个事件类型的订阅数不能超过 `maxEventSubscriptions`（默认500）

**返回值**：`{ eventType: string, agentId: string }`

### `unregisterEventSubscription(eventType, agentId)`

注销事件订阅。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `eventType` | string | 是 | 事件类型 |
| `agentId` | string | 是 | 目标Agent ID |

当该事件类型的最后一个订阅被注销时，自动从 `EventBus` 移除对应的监听器。

**返回值**：`boolean` — 是否成功注销

### `dispatchWebhook(path, payload, signature, rawBody)`

处理Webhook请求。根据路径查找路由表，找到目标Agent后通过 `ManagedAgentHost.handleWebhook()` 执行。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | Webhook请求路径 |
| `payload` | object | 是 | 请求负载（JSON body） |
| `signature` | string | 否 | HMAC签名 |
| `rawBody` | string | 否 | 原始请求体（用于签名验证） |

**返回值**：`Promise<Object>`

**返回结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `dispatched` | boolean | 是否成功分发 |
| `reason` | string | 失败原因：`'no_route'` / `'no_host'` / `'invalid_signature'` / `'signature_required'` |
| `agentId` | string | 目标Agent ID |
| `path` | string | 请求路径 |
| `result` | object | ManagedAgentHost处理结果（仅成功时） |

**处理流程**：
1. 查找 `_webhookRoutes` 匹配路径
2. 无匹配 → 返回 `{ dispatched: false, reason: 'no_route' }`
3. 无 `_managedHost` → 返回 `{ dispatched: false, reason: 'no_host' }`
4. 调用 `_managedHost.handleWebhook(path, payload, signature, rawBody)`
5. 签名验证失败 → 返回 `{ dispatched: false, reason: 'invalid_signature' / 'signature_required' }`

### `dispatchFireAndForget(agentId, payload)`

即发即忘执行——一次性触发Agent执行，不等待结果也不跟踪状态。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | 目标Agent ID |
| `payload` | object | 是 | 任务负载 |

**返回值**：`Promise<Object>`

**返回结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `dispatched` | boolean | 是否成功分发 |
| `reason` | string | 失败原因（仅 `'no_host'`） |
| `agentId` | string | 目标Agent ID |
| `result` | object | ManagedAgentHost处理结果（仅成功时） |

### `listSchedules()`

获取所有已注册调度的列表及其当前状态。

**返回值**：`Array<Object>`

每条记录包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `scheduleId` | string | 调度ID |
| `agentId` | string | 目标Agent ID |
| `type` | string | 调度类型：`'interval'` / `'cron'` |
| `config` | object | 原始调度配置 |
| `lastFire` | number\|null | 上次触发时间戳，null表示未触发过 |
| `fireCount` | number | 已触发次数 |

### `listWebhookRoutes()`

获取所有已注册的Webhook路由。

**返回值**：`Array<{ path: string, agentId: string }>`

### `getStats()`

获取调度器运行统计信息。

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `scheduleCount` | number | 当前注册的调度数 |
| `webhookRouteCount` | number | 当前注册的Webhook路由数 |
| `eventSubscriptionCount` | number | 当前注册的事件订阅总数（跨所有事件类型汇总） |
| `cronTimerRunning` | boolean | Cron检查定时器是否在运行 |

---

### `attachManagedHost(host)`

注入ManagedAgentHost实例。所有触发事件最终都通过`_managedHost.triggerExecution()`或`_managedHost.handleWebhook()`分发到Agent。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `host` | object | 是 | ManagedAgentHost实例 |

**返回值**：`this`（支持链式调用）

### `attachEventBus(bus)`

注入EventBus实例。注入时自动回溯注册所有已有事件订阅的EventBus监听器，确保在注入EventBus之前注册的事件订阅也能正常工作。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `bus` | object | 是 | EventBus实例 |

**返回值**：`this`（支持链式调用）

---

## Cron表达式解析器

### `parseCronExpression(expression)` （静态方法）

简化版Cron解析器，支持标准5段Cron表达式（分 时 日 月 周）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `expression` | string | 是 | 5段空格分隔的Cron表达式 |

**支持的语法**：

| 语法 | 示例 | 说明 |
|------|------|------|
| `*` | `*` | 匹配所有值 |
| `*/N` | `*/5` | 每N个单位触发 |
| `M-N` | `9-17` | 范围匹配 |
| `M-N/K` | `9-17/2` | 范围内每K个单位触发 |
| `N,M,O` | `1,15,30` | 列表匹配 |
| `N` | `30` | 精确值匹配 |

**字段范围**：

| 字段 | 索引 | 范围 | 说明 |
|------|------|------|------|
| 分钟 | 0 | 0-59 | 当前分钟数 |
| 小时 | 1 | 0-23 | 当前小时数 |
| 日期 | 2 | 1-31 | 当前月日期 |
| 月份 | 3 | 1-12 | 当前月份 |
| 星期 | 4 | 0-6 | 当前星期（0=周日） |

**返回值**：`Function` — 接受 `Date` 对象的匹配函数，返回 `boolean`

**使用示例**：

```javascript
const { parseCronExpression } = require('./src/runtime/workflow/trigger-dispatcher');

// 每天早上9点
const is9AM = parseCronExpression('0 9 * * *');
console.log(is9AM(new Date('2025-01-01T09:00:00'))); // true

// 工作日每小时的第30分钟
const workHours = parseCronExpression('30 9-17 * * 1-5');
```

**防重机制**：Cron调度检查使用分钟级唯一键（`年-月-日-时-分`），确保同一分钟内不会对同一调度重复触发。`_cronCheckIntervalMs` 默认为60000ms（1分钟），可在构造函数中自定义。

---

## 内部方法

### `_fireSchedule(entry)`

触发单个调度条目的执行。更新 `fireCount` 和 `lastFire`，发出 `trigger-dispatched` 事件，通过 `_managedHost.triggerExecution()` 将任务分发给目标Agent。执行失败时发出 `trigger-failed` 事件。

### `_handleEventBusTrigger(eventType, data)`

处理来自EventBus的事件触发。遍历该事件类型的所有订阅Agent，逐一调用 `_managedHost.triggerExecution()`，触发失败仅记录日志不中断其他Agent的分发。

### `_ensureCronTimer()`

确保Cron统一检查定时器在运行。如果已运行则跳过。定时器按 `_cronCheckIntervalMs` 间隔批量检查所有Cron类型调度。

### `_stopCronTimer()`

停止Cron检查定时器并置null。

### `_countEventSubscriptions()`

统计所有事件类型的订阅总数（跨类型汇总每个事件下 `Set<agentId>` 的size）。

### `_onShutdown()`

优雅关闭逻辑（由 `withShutdown` mixin 调用）：
1. 清除所有 `setInterval` 定时器并清空调度注册表
2. 停止Cron检查定时器
3. 移除所有EventBus监听器
4. 清空Webhook路由和事件订阅表
5. 释放 `_managedHost` 和 `_eventBus` 引用

---

## 事件

TriggerDispatcher继承自 `EventEmitter`，发出以下事件：

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `trigger-dispatched` | 调度/事件触发成功分发 | `{ scheduleId?, agentId, type: 'schedule'\|'event', fireCount?, eventType? }` |
| `trigger-failed` | 调度执行失败 | `{ scheduleId, error: string }` |
| `schedule-registered` | 调度注册成功 | `{ scheduleId, type, agentId }` |
| `schedule-unregistered` | 调度注销成功 | `{ scheduleId }` |
| `webhook-received` | 收到Webhook请求 | `{ path, agentId, timestamp }` |

---

## 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `MAX_SCHEDULES` | 200 | 最大调度注册数 |
| `MAX_WEBHOOK_ROUTES` | 100 | 最大Webhook路由数 |
| `MAX_EVENT_SUBSCRIPTIONS` | 500 | 最大事件订阅数 |
| `CRON_FIELD_NAMES` | `['minute', 'hour', 'day', 'month', 'weekday']` | Cron字段名称数组 |
| `CRON_RANGES` | `[[0,59], [0,23], [1,31], [1,12], [0,6]]` | Cron字段取值范围 |

---

## 调度条目内部结构

每条调度在 `_schedules` Map 中的结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `scheduleId` | string | 唯一调度ID，格式 `sched-` + timestampId |
| `agentId` | string | 目标Agent ID |
| `type` | string | `'interval'` 或 `'cron'` |
| `config` | object | 原始调度配置 |
| `lastFire` | number\|null | 上次触发时间戳 |
| `fireCount` | number | 累计触发次数 |
| `timerId` | NodeJS.Timer\|null | Interval类型的 `setInterval` 返回值 |
| `matcher` | Function\|null | Cron类型的匹配函数（来自 `parseCronExpression`） |
| `lastFireMinute` | string\|undefined | Cron防重键，格式 `年-月-日-时-分` |

---

## 使用示例

```javascript
const TriggerDispatcher = require('./src/runtime/workflow/trigger-dispatcher');

const dispatcher = new TriggerDispatcher({
  maxSchedules: 200,
  maxWebhookRoutes: 100,
  maxEventSubscriptions: 500,
  cronCheckIntervalMs: 60000,
});

// 注入依赖
dispatcher.attachManagedHost(managedAgentHost);
dispatcher.attachEventBus(eventBus);

// 注册Cron调度：每天早上9点
const cronSched = dispatcher.registerSchedule('daily-report-agent', {
  type: 'cron',
  cron: '0 9 * * *',
});

// 注册间隔调度：每5分钟
const intervalSched = dispatcher.registerSchedule('health-check-agent', {
  type: 'interval',
  intervalMs: 5 * 60 * 1000,
});

// 注册Webhook：GitHub Push事件
dispatcher.registerWebhook('/github/push', 'bug-fixer');

// 注册事件订阅：bug检测事件
dispatcher.registerEventSubscription('bug:detected', 'bug-fixer');
dispatcher.registerEventSubscription('bug:detected', 'notify-agent');

// 即发即忘执行
const ffResult = await dispatcher.dispatchFireAndForget('report-agent', {
  reportId: 'r-001',
  type: 'weekly-summary',
});

// 处理Webhook请求（通常在HTTP服务器中调用）
const whResult = await dispatcher.dispatchWebhook(
  '/github/push',
  { ref: 'refs/heads/main', commits: [...] },
  hmacSignature,
  rawRequestBody
);

// 查询状态
const stats = dispatcher.getStats();
console.log('调度数:', stats.scheduleCount);
console.log('Webhook路由数:', stats.webhookRouteCount);
console.log('Cron定时器运行中:', stats.cronTimerRunning);

const schedules = dispatcher.listSchedules();
const routes = dispatcher.listWebhookRoutes();

// 监听事件
dispatcher.on('trigger-dispatched', (data) => {
  console.log('触发分发:', data);
});
dispatcher.on('trigger-failed', (data) => {
  console.error('触发失败:', data.scheduleId, data.error);
});

// 注销
dispatcher.unregisterSchedule(intervalSched.scheduleId);
dispatcher.unregisterWebhook('/github/push');
dispatcher.unregisterEventSubscription('bug:detected', 'notify-agent');

// 优雅关闭
dispatcher.shutdown();
```

---

## 依赖关系

- 依赖：`events` — Node.js内置EventEmitter
- 依赖：`../../utils/shutdown-mixin.js` — 优雅关闭混入（`withShutdown`）
- 依赖：`../../utils/unique-id.js` — `timestampId` 调度ID生成
- 依赖：`../../utils/safe-execute.js` — `errorMessage` 错误消息提取
- 依赖：`../../utils/debug-logger.js` — `debug` 调试日志
- 被依赖：`src/index.js` — 主入口装配，与 `ManagedAgentHost` 和 `EventBus` 组合使用

---

## 集成说明

- **与ManagedAgentHost配合**：所有触发事件最终通过 `_managedHost.triggerExecution()`（调度/事件/即发即忘）或 `_managedHost.handleWebhook()`（Webhook）分发到Agent执行
- **与EventBus配合**：通过 `attachEventBus()` 注入后，事件订阅自动在EventBus上注册监听器；支持先注册事件订阅再注入EventBus的回溯注册机制
- **与Web服务器集成**：Webhook路由表可通过 `listWebhookRoutes()` 供HTTP服务器发现，Webhook端点处理函数调用 `dispatchWebhook()` 完成分发
- **与Dashboard集成**：`getStats()` 提供运行状态数据，可暴露为 `/api/trigger-dispatcher/stats` 端点
- **unref优化**：所有 `setInterval` 定时器调用 `.unref()`，确保不会阻止Node.js进程正常退出
- **关闭安全**：通过 `withShutdown` mixin 提供 `guardShutdown()` 门禁，已关闭后所有注册/分发操作均抛出异常

---

## 相关文档

- [模块详解-ManagedAgentHost托管Agent运行容器](模块详解-AgentDeployment模块.md)
- [模块详解-EventBus模块](模块详解-EventBus模块.md)
- [模块详解-PipelineExecutor流水线执行器](模块详解-PipelineExecutor流水线执行器.md)
- [模块详解-工作流子系统](模块详解-工作流子系统.md)