# 模块详解-DreamScheduler梦境调度器

> 版本：2.73.4 | 文件：src/runtime/thought/dream-scheduler.js | 行数：~138行

---

## 模块概述

DreamScheduler是思维子系统的定时调度组件，负责周期性触发DreamEngine进行经验回顾和知识提炼。模块支持两种触发模式：定时周期回顾（按配置间隔自动触发）和会话结束即时做梦（当会话关闭时立即触发DreamEngine处理当前会话的思维数据）。通过错误计数和健康检查机制确保调度器的稳定性，定时器使用unref()避免阻塞Node.js进程退出。

## 融合来源

融合自操作系统的定时任务调度器（cron/job scheduler）概念和认知科学中的"睡眠巩固"（sleep consolidation）理论。正如人类在睡眠中整理白天经验、强化重要记忆，DreamScheduler定期触发DreamEngine对历史会话进行回顾，提取模式、发现知识、整合经验。会话结束即时做梦机制对应"睡前反思"——在一段工作结束时立即提炼关键收获。

## 核心API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `constructor(options)` | options?: Object | DreamScheduler | 构造函数，接受配置对象 |
| `start()` | 无 | void | 启动定时调度器，按intervalMs间隔周期触发DreamEngine |
| `stop()` | 无 | void | 停止定时调度器 |
| `isRunning()` | 无 | boolean | 检查调度器是否运行中 |
| `onSessionEnd(sessionId, thoughts, context?)` | sessionId: string, thoughts: Array, context?: Object | Promise\<Object\|null\> | 会话结束时触发即时做梦 |
| `setSessionHistoryProvider(fn)` | fn: Function | void | 设置会话历史提供者函数 |
| `getStats()` | 无 | Object | 获取统计信息 |
| `isHealthy()` | 无 | boolean | 健康检查（错误数<100） |

### 构造函数参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dreamEngine` | Object | null | DreamEngine实例 |
| `intervalMs` | number | 1800000 (30分钟) | 周期回顾间隔（毫秒），最小1000 |
| `sessionHistoryProvider` | Function | null | 提供历史会话数据的函数 |

### 静态属性

| 属性 | 说明 |
|------|------|
| `DEFAULT_INTERVAL_MS` | 默认间隔时间 1800000ms (30分钟) |

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `intervalMs` | number | 1800000 | 周期回顾间隔，最小1000ms |
| `dreamEngine` | Object | null | DreamEngine实例，需实现startDreaming方法 |
| `sessionHistoryProvider` | Function | null | 返回历史会话数组的函数 |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `scheduler:started` | 调度器启动 | 无 |
| `scheduler:stopped` | 调度器停止 | 无 |
| `dream:session:end` | 会话结束做梦完成 | `{ sessionId, notes }` |
| `review-error` | 周期回顾出错 | `{ error }` |

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/shutdown-mixin.js`（优雅关闭混入，withShutdown包装）
- 依赖：`../../utils/safe-execute.js`（safeCall安全执行）
- 依赖：`../../utils/debug-logger.js`（调试日志）
- 可选关联：`DreamEngine`（通过构造函数注入）

## 使用示例

```javascript
const DreamScheduler = require('./src/runtime/thought/dream-scheduler');

const scheduler = new DreamScheduler({
  dreamEngine: dreamEngineInstance,
  intervalMs: 30 * 60 * 1000,
  sessionHistoryProvider: () => sessionManager.getRecentSessions(10),
});

scheduler.start();

scheduler.on('dream:session:end', ({ sessionId, notes }) => {
  console.log('会话做梦完成:', sessionId, '产出笔记:', notes.length);
});

scheduler.onSessionEnd('sess-123', thoughtsArray);

scheduler.getStats();
```

## 与现有模块的集成点

- **DreamEngine**：调度器的核心依赖，通过`startDreaming()`方法触发经验提炼
- **SessionManager**：通过`sessionHistoryProvider`获取历史会话数据供周期回顾使用
- **MemoryPipeline**：作为管道的调度层，由管道在初始化时创建和配置
- **BrainMemory/MemoryStore**：DreamEngine产出笔记的最终存储目标

## 相关文档

- [[模块详解-思维子系统]] — 思维子系统总览
- [[模块详解-Brain记忆系统]] — BrainMemory记忆架构
- [[核心功能-记忆管道系统]] — 记忆管道Hermes三阶段流程
