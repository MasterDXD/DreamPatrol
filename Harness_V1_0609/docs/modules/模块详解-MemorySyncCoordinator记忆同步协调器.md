# 模块详解-MemorySyncCoordinator记忆同步协调器

> 版本：2.73.4 | 文件：src/runtime/thought/memory-sync-coordinator.js | 行数：~320行

---

## 模块概述

MemorySyncCoordinator是思维子系统的跨存储一致性协调组件，负责在多个异构记忆存储之间同步数据。模块支持3种同步策略（事件驱动、周期性、手动触发）和3种冲突解决策略（最新胜、置信度合并、源优先级），通过注册表模式管理存储实例，自动检测各存储的读写方法（queryKnowledge/search/getNotes/retrieve + addKnowledge/store/createEntry），内置同步队列（BoundedArray容量限制）和批量处理机制，确保跨存储数据最终一致性。

## 融合来源

融合自分布式系统的"最终一致性"（Eventual Consistency）模型和数据库的"多主复制"（Multi-Master Replication）模式。在多主复制中，多个节点可独立写入，通过冲突解决策略（时间戳优先/应用层合并/优先级规则）达成一致——MemorySyncCoordinator采用相同思路，允许各记忆源独立产生数据，通过三种冲突策略协调差异。批量处理和队列机制借鉴了消息队列的"背压控制"（Backpressure）思想。

## 核心API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `constructor(options)` | options?: Object | MemorySyncCoordinator | 构造函数 |
| `registerStore(storeName, storeInstance, options?)` | storeName: string, store: Object, options?: Object | this | 注册存储实例 |
| `unregisterStore(storeName)` | storeName: string | this | 注销存储实例 |
| `enqueueSync(syncItem)` | syncItem: Object | this | 入队同步任务 |
| `syncAll(options?)` | options?: Object | Promise\<Object\> | 全量同步所有存储 |
| `syncFromSource(sourceName, data, options?)` | sourceName: string, data: Object\|Array, options?: Object | Promise\<Object\> | 从指定源同步到其他存储 |
| `startPeriodicSync()` | 无 | void | 启动周期性同步定时器 |
| `stopPeriodicSync()` | 无 | void | 停止周期性同步定时器 |
| `getStats()` | 无 | Object | 获取统计信息 |
| `isHealthy()` | 无 | boolean | 健康检查 |

### registerStore选项

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `syncFn` | Function | 自动检测 | 自定义读取函数 |
| `writeFn` | Function | 自动检测 | 自定义写入函数 |
| `priority` | number | 1 | 存储优先级 |

### 自动检测的读取方法

| 方法名 | 适用存储 | 说明 |
|--------|---------|------|
| `queryKnowledge()` | MemoryStore | 知识查询 |
| `search()` | ThoughtStore, LlmWiki | 搜索 |
| `getNotes()` | DreamEngine | 获取笔记 |
| `retrieve()` | BrainMemory | 记忆检索 |

### 自动检测的写入方法

| 方法名 | 适用存储 | 说明 |
|--------|---------|------|
| `addKnowledge()` | MemoryStore | 添加知识 |
| `store()` | BrainMemory | 存储记忆 |
| `createEntry()` | LlmWiki | 创建条目 |

### 静态属性

| 属性 | 说明 |
|------|------|
| `SYNC_POLICIES` | 同步策略枚举（ON_EVENT/PERIODIC/MANUAL） |
| `CONFLICT_STRATEGIES` | 冲突解决策略枚举（LATEST_WINS/CONFIDENCE_MERGE/SOURCE_PRIORITY） |
| `DEFAULT_SYNC_CONFIG` | 默认配置对象 |

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxSyncQueueSize` | number | 100 | 同步队列最大容量 |
| `syncIntervalMs` | number | 300000 (5分钟) | 周期同步间隔 |
| `batchSize` | number | 10 | 批量处理大小 |
| `conflictStrategy` | string | 'confidence-merge' | 默认冲突解决策略 |
| `enableAutoSync` | boolean | true | 是否自动处理入队任务 |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `sync-enqueued` | 同步任务入队 | `{ source, queueSize }` |
| `sync-completed` | 同步完成 | `{ synced, conflicts, errors }` |
| `periodic-sync-started` | 周期同步启动 | 无 |
| `periodic-sync-stopped` | 周期同步停止 | 无 |

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/shutdown-mixin.js`（优雅关闭混入）
- 依赖：`../../utils/debug-logger.js`（调试日志）
- 依赖：`../../utils/safe-execute.js`（safeCall安全执行）
- 依赖：`../../utils/bounded-array.js`（BoundedArray同步队列）
- 可选关联：BrainMemory、MemoryStore、LlmWiki、DreamEngine（通过registerStore方法）

## 使用示例

```javascript
const { MemorySyncCoordinator } = require('./src/runtime/thought/memory-sync-coordinator');

const coordinator = new MemorySyncCoordinator({
  conflictStrategy: 'confidence-merge',
  syncIntervalMs: 300000,
  batchSize: 10,
});

coordinator
  .registerStore('brain-memory', brainMemory)
  .registerStore('memory-store', memoryStore, { priority: 2 })
  .registerStore('llm-wiki', llmWiki, { priority: 3 })
  .registerStore('dream-engine', dreamEngine);

coordinator.startPeriodicSync();

const result = await coordinator.syncAll();
console.log('同步完成:', result.synced, '冲突:', result.conflicts);

coordinator.enqueueSync({
  source: 'brain-memory',
  data: { key: 'arch-decision', content: '...', confidence: 0.9 },
  targetStores: ['memory-store', 'llm-wiki'],
});
```

## 与现有模块的集成点

- **MemoryPipeline**：作为管道的同步层（Sync阶段），由管道在初始化时自动布线
- **BrainMemory**：核心同步存储，既是数据源也是同步目标
- **MemoryStore**：知识同步存储，优先级2
- **LlmWiki**：知识库同步存储，优先级3
- **DreamEngine**：梦境笔记同步存储

## 相关文档

- [[模块详解-思维子系统]] — 思维子系统总览
- [[模块详解-UnifiedMemoryRecaller统一记忆召回器]] — 统一记忆召回器
- [[模块详解-MemoryPipeline记忆管道]] — 记忆管道集成
- [[核心功能-记忆管道系统]] — 记忆管道Hermes三阶段流程
