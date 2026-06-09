# 模块详解-EventBus模块

> 版本：2.73.4 | 文件：src/runtime/infrastructure/event-bus.js | 行数：~125行

---

## 模块定位

EventBus是中央事件总线，基于Node.js EventEmitter扩展，是基础设施子系统的核心通信组件。它为框架内所有模块提供发布/订阅式的解耦通信机制，支持中间件拦截、事件历史记录（基于BoundedArray防内存溢出）、命名空间隔离和异步等待能力。EventBus是整个运行时引擎的事件通信骨干，几乎所有子系统（Agent、深化推理、工作流、会话等）都通过它进行跨模块通信。

## 类定义

```javascript
class EventBus extends EventEmitter {
  constructor(options = {})
  use(fn)
  emit(event, data)
  onceAsync(event, timeoutMs)
  getHistory(eventFilter)
  clearHistory()
  createNamespace(prefix)
  shutdown() // via withShutdown mixin
  isHealthy()
}
```

## 构造函数

### `constructor(options)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项 |
| `options.maxListeners` | number | 否 | 每个事件最大监听器数，默认50 |
| `options.maxHistory` | number | 否 | 事件历史最大记录数，默认1000 |
| `options.maxMiddleware` | number | 否 | 最大中间件数量，默认50 |

初始化内部状态：
- `_history` — 基于BoundedArray的事件历史记录，容量由`maxHistory`控制
- `_middleware` — 中间件函数数组
- `_maxMiddleware` — 中间件数量上限

## 公开方法详解

### `use(fn)`

注册中间件函数。中间件在每次事件发射前按注册顺序执行。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `fn` | function | 是 | 中间件函数，签名为`(event, data) => void` |

**返回值**：`this`（支持链式调用）

**行为细节**：
- 中间件数量达到`_maxMiddleware`时抛出`HarnessError`，错误码`CAPACITY_EXCEEDED`
- 中间件执行出错不会阻断事件发射，但会触发`middleware-error`事件
- 中间件按注册顺序执行（FIFO）

### `emit(event, data)`

发射事件，重写EventEmitter的emit方法。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | 事件名称 |
| `data` | any | 否 | 事件数据 |

**返回值**：`boolean` — 如果事件有监听器则返回true（继承自EventEmitter）

**执行流程**：
1. 将事件记录到历史（`{event, data, timestamp}`）
2. 按顺序执行所有中间件，中间件错误不阻断
3. 调用`super.emit(event, data)`实际发射事件

### `onceAsync(event, timeoutMs)`

异步等待事件，返回Promise。支持超时控制。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | 事件名称 |
| `timeoutMs` | number | 否 | 超时时间（毫秒），默认`DEFAULT_REQUEST_TIMEOUT_MS`；传0表示无超时 |

**返回值**：`Promise<{timedOut: boolean, data: any}>`

**行为细节**：
- 超时后Promise被reject，错误消息包含事件名和超时时间
- 超时定时器调用`.unref()`避免阻止进程退出
- 事件触发后自动清除超时定时器
- 成功等待时`timedOut: false`，数据在`data`字段

### `getHistory(eventFilter)`

获取事件历史记录。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `eventFilter` | string | 否 | 事件名过滤，不提供时返回全部历史 |

**返回值**：`Array<{event: string, data: any, timestamp: number}>`

**行为细节**：
- 无过滤时返回全部历史记录
- 有过滤时仅返回匹配事件名的记录
- 历史记录受`maxHistory`容量限制，超出时自动淘汰最旧记录

### `clearHistory()`

清空事件历史记录。

### `createNamespace(prefix)`

创建命名空间隔离的事件代理对象。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prefix` | string | 是 | 命名空间前缀 |

**返回值**：命名空间代理对象，包含以下方法：

| 方法 | 签名 | 说明 |
|------|------|------|
| `emit` | `emit(event, data)` | 发射`prefix:event`事件 |
| `on` | `on(event, handler)` | 监听`prefix:event`事件 |
| `once` | `once(event, handler)` | 一次性监听`prefix:event`事件 |
| `off` | `off(event, handler)` | 移除`prefix:event`监听 |
| `onceAsync` | `onceAsync(event, timeoutMs)` | 异步等待`prefix:event`事件 |
| `removeAllListeners` | `removeAllListeners(event?)` | 移除所有`prefix:`前缀的监听器 |
| `getPrefix` | `getPrefix()` | 返回命名空间前缀 |

**行为细节**：
- 所有方法自动在事件名前添加`prefix:`前缀
- `removeAllListeners`不传参时移除所有以`prefix:`开头的事件监听器
- 命名空间代理与原始EventBus共享同一实例，只是事件名自动加前缀

### `shutdown()`

通过`withShutdown`混入提供。关闭时清理：
- 清空事件历史
- 清空中间件数组

### `isHealthy()`

检查EventBus是否健康。

**返回值**：`boolean` — 未关闭时返回true

## 中间件机制

中间件是形如`(event, data) => void`的函数，在事件发射前按注册顺序执行。

**中间件特性**：
- 中间件错误不会阻断事件发射
- 中间件错误触发`middleware-error`事件，包含原始事件名、错误对象和中间件名称
- 中间件数量有上限（默认50），超出时抛出HarnessError

**典型用途**：
- 事件日志记录
- 事件数据转换
- 事件过滤/限流
- 审计追踪

## 命名空间

命名空间提供事件隔离能力，避免不同子系统的事件名冲突：

```javascript
const agentBus = eventBus.createNamespace('agent');
const sessionBus = eventBus.createNamespace('session');

agentBus.emit('state-change', data);   // 实际发射 'agent:state-change'
sessionBus.emit('created', data);      // 实际发射 'session:created'

agentBus.on('state-change', handler);  // 监听 'agent:state-change'
sessionBus.onceAsync('created', 5000); // 等待 'session:created'
```

## 事件历史

事件历史基于BoundedArray实现，防止内存溢出：

- 每次emit自动记录`{event, data, timestamp}`
- 历史容量由`maxHistory`控制（默认1000）
- 超出容量时自动淘汰最旧记录
- 支持按事件名过滤查询
- 可手动清空

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `middleware-error` | 中间件执行出错 | `{originalEvent: string, error: Error, middleware: string}` |
| `shutdown` | 总线关闭 | 无 |

## 静态属性

| 属性 | 值 | 说明 |
|------|---|------|
| `DEFAULT_MAX_HISTORY` | 1000 | 默认历史记录容量 |

## 使用示例

### 基本用法

```javascript
const EventBus = require('./src/runtime/infrastructure/event-bus');

const bus = new EventBus({
  maxListeners: 100,
  maxHistory: 2000,
  maxMiddleware: 20
});

bus.on('skill:executed', (data) => {
  console.log(`Skill ${data.skillId} executed by ${data.agentId}`);
});

bus.emit('skill:executed', { skillId: 'tdd-implement', agentId: 'task-worker' });
```

### 中间件

```javascript
bus.use((event, data) => {
  console.log(`[审计] 事件: ${event}, 时间: ${new Date().toISOString()}`);
});

bus.use((event, data) => {
  if (event.startsWith('agent:')) {
    data._timestamp = Date.now();
  }
});

bus.on('middleware-error', ({originalEvent, error, middleware}) => {
  console.error(`中间件 ${middleware} 处理事件 ${originalEvent} 时出错:`, error);
});
```

### 异步等待

```javascript
try {
  const result = await bus.onceAsync('pipeline:complete', 30000);
  if (!result.timedOut) {
    console.log('管道完成:', result.data);
  }
} catch (err) {
  console.error('等待超时:', err.message);
}

const noTimeoutResult = await bus.onceAsync('session:restored', 0);
```

### 命名空间

```javascript
const agentNs = bus.createNamespace('agent');
const sessionNs = bus.createNamespace('session');

agentNs.emit('spawned', { agentId: 'task-worker' });
sessionNs.emit('created', { sessionId: 'sess_001' });

agentNs.on('spawned', (data) => {
  console.log('Agent创建:', data.agentId);
});

agentNs.removeAllListeners();
```

### 事件历史

```javascript
const allHistory = bus.getHistory();
const skillHistory = bus.getHistory('skill:executed');
console.log(`总历史: ${allHistory.length} 条, Skill历史: ${skillHistory.length} 条`);

bus.clearHistory();
```

## 依赖关系

- 依赖：`events`（Node.js内置） — EventEmitter基类
- 依赖：`../../utils/bounded-array.js` — 有界数组（事件历史）
- 依赖：`../../utils/debug-logger.js` — 调试日志
- 依赖：`../../errors/index.js` — HarnessError错误类
- 依赖：`../../utils/shutdown-mixin.js` — 优雅关闭
- 依赖：`../../utils/constants.js` — DEFAULT_REQUEST_TIMEOUT_MS
- 被依赖：几乎所有运行时子系统 — 事件通信骨干

## 集成说明

- EventBus是SharedInfrastructure的核心组件，在系统启动时创建单例实例
- Agent子系统通过命名空间`agent:`通信（状态变更、生命周期事件）
- 深化推理子系统通过命名空间`deepening:`通信（管道启动/完成、收敛检测）
- 工作流子系统通过命名空间`workflow:`通信（阶段转换、钩子执行）
- 会话子系统通过命名空间`session:`通信（创建、恢复、压缩）
- 中间件可用于全局审计日志，记录所有事件到AuditLogger
- 事件历史可用于调试和问题排查，通过Dashboard API暴露
- onceAsync用于需要等待异步事件的场景，如等待Agent完成、等待阶段转换

## 相关文档

- [模块详解-上下文管理模块](模块详解-上下文管理模块.md)
- [模块详解-SharedInfrastructure模块](模块详解-上下文管理模块.md)
- [核心功能-多Agent协作流程](../core/核心功能-多Agent协作流程.md)
