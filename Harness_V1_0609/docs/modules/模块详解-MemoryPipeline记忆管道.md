# 模块详解-MemoryPipeline记忆管道

> 版本：2.73.4 | 文件：src/runtime/thought/memory-pipeline.js | 行数：~198行

---

## 模块概述

MemoryPipeline是思维子系统的顶层集成组件，实现Hermes三阶段管道（Recall/Sync/Prefetch）的统一接入和自动布线。模块在初始化时自动创建MemoryPrefetcher、UnifiedMemoryRecaller、MemorySyncCoordinator三个子组件，通过attachComponent方法接收外部组件引用，在initialize()时自动完成8+组件的布线连接（包括BrainMemory、MemoryStore、LlmWiki、DreamEngine、ThoughtStore、EmbeddingService、SqliteStore等）。提供单入口API（recall/syncAll/onPhaseChange等），屏蔽底层三阶段管道的复杂性，并在shutdown时级联清理所有子组件。

## 融合来源

融合自Unix管道（Pipeline）哲学和ETL（Extract-Transform-Load）数据处理模式。Unix管道将多个简单命令串联为复杂工作流，每个命令专注单一职责——MemoryPipeline将Prefetch/Recall/Sync三个阶段串联为完整的记忆管理流程。Hermes三阶段命名取自希腊神话中信使之神赫尔墨斯，象征信息在不同存储间的高效传递和协调。自动布线机制借鉴了依赖注入容器（DI Container）的自动装配思想。

## 核心API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `constructor(options)` | options?: Object | MemoryPipeline | 构造函数，自动创建三个子组件 |
| `attachComponent(name, instance)` | name: string, instance: Object | this | 附加外部组件引用 |
| `initialize()` | 无 | this | 初始化管道，自动布线所有组件 |
| `recall(query, options?)` | query: string, options?: Object | Promise\<Object\> | 统一记忆召回（委托Recaller） |
| `syncAll(options?)` | options?: Object | Promise\<Object\> | 全量同步（委托SyncCoordinator） |
| `onPhaseChange(phaseInfo)` | phaseInfo: Object | void | 阶段变更通知（委托Prefetcher） |
| `onIntentParsed(intentResult)` | intentResult: Object | void | 意图解析通知（委托Prefetcher） |
| `onTaskAssigned(taskInfo)` | taskInfo: Object | void | 任务分配通知（委托Prefetcher） |
| `onUserInteraction(interactionInfo)` | interactionInfo: Object | void | 用户交互通知（委托Prefetcher） |
| `getPrefetched(query)` | query: string | Object\|null | 获取预取缓存（委托Prefetcher） |
| `getPrefetchedForContext(context)` | context: Object | Object[] | 按上下文获取预取缓存 |
| `enqueueSync(syncItem)` | syncItem: Object | this | 入队同步任务（委托SyncCoordinator） |
| `getStats()` | 无 | Object | 获取管道及子组件统计信息 |
| `isHealthy()` | 无 | boolean | 管道健康检查（所有子组件健康） |

### 静态属性

| 属性 | 说明 |
|------|------|
| `PIPELINE_STAGES` | 管道阶段枚举（RECALL/SYNC/PREFETCH） |
| `DEFAULT_PIPELINE_CONFIG` | 默认配置对象 |

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enablePrefetch` | boolean | true | 是否启用预取阶段 |
| `enableRecall` | boolean | true | 是否启用召回阶段 |
| `enableSync` | boolean | true | 是否启用同步阶段 |
| `prefetchConfig` | Object | {} | 传递给MemoryPrefetcher的配置 |
| `recallConfig` | Object | {} | 传递给UnifiedMemoryRecaller的配置 |
| `syncConfig` | Object | {} | 传递给MemorySyncCoordinator的配置 |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `pipeline-initialized` | 管道初始化完成 | 无 |

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/shutdown-mixin.js`（优雅关闭混入）
- 依赖：`../../utils/debug-logger.js`（调试日志）
- 依赖：`../../utils/safe-execute.js`（safeCall安全执行）
- 依赖：`./memory-prefetcher.js`（MemoryPrefetcher预取器）
- 依赖：`./unified-memory-recaller.js`（UnifiedMemoryRecaller召回器）
- 依赖：`./memory-sync-coordinator.js`（MemorySyncCoordinator同步协调器）
- 可选关联：BrainMemory、MemoryStore、LlmWiki、DreamEngine、ThoughtStore等（通过attachComponent方法）

## 使用示例

```javascript
const { MemoryPipeline } = require('./src/runtime/thought/memory-pipeline');

const pipeline = new MemoryPipeline({
  enablePrefetch: true,
  enableRecall: true,
  enableSync: true,
  prefetchConfig: { maxPrefetchedEntries: 100 },
  recallConfig: { maxResults: 20 },
  syncConfig: { conflictStrategy: 'confidence-merge' },
});

pipeline
  .attachComponent('brain-memory', brainMemory)
  .attachComponent('memory-store', memoryStore)
  .attachComponent('llm-wiki', llmWiki)
  .attachComponent('dream-engine', dreamEngine)
  .attachComponent('thought-store', thoughtStore)
  .attachComponent('affinity-learner', affinityLearner)
  .attachComponent('user-model-manager', userModelManager)
  .attachComponent('structured-intent', structuredIntent);

pipeline.initialize();

const result = await pipeline.recall('分层架构设计原则');
pipeline.onPhaseChange({ phase: 'module-development' });
await pipeline.syncAll();

console.log(pipeline.getStats());
```

## 与现有模块的集成点

- **MemoryPrefetcher**：管道的Prefetch阶段，自动布线8个外部组件
- **UnifiedMemoryRecaller**：管道的Recall阶段，自动布线7个召回源
- **MemorySyncCoordinator**：管道的Sync阶段，自动布线4个同步存储
- **DreamEngine**：特殊布线——管道将BrainMemory和MemoryStore反向注入DreamEngine
- **SessionManager**：通过管道的recall方法为会话恢复提供记忆上下文
- **PhaseOrchestrator**：通过onPhaseChange通知管道预取下一阶段相关记忆

## 相关文档

- [[模块详解-思维子系统]] — 思维子系统总览
- [[模块详解-MemoryPrefetcher记忆预取器]] — 预取器子组件
- [[模块详解-UnifiedMemoryRecaller统一记忆召回器]] — 召回器子组件
- [[模块详解-MemorySyncCoordinator记忆同步协调器]] — 同步协调器子组件
- [[模块详解-DreamScheduler梦境调度器]] — 梦境调度器
- [[核心功能-记忆管道系统]] — 记忆管道Hermes三阶段流程
