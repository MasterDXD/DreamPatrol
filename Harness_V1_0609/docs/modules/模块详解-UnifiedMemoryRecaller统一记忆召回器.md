# 模块详解-UnifiedMemoryRecaller统一记忆召回器

> 版本：2.73.4 | 文件：src/runtime/thought/unified-memory-recaller.js | 行数：~310行

---

## 模块概述

UnifiedMemoryRecaller是思维子系统的统一记忆召回组件，实现7源跨存储联合召回能力。模块支持从BrainMemory、MemoryStore、ThoughtStore、LlmWiki、DreamEngine、CausalStore、Prefetcher七个记忆源并行或顺序检索数据，内置去重（基于key的精确去重+置信度优先合并）、排序（置信度+源优先级加权）、查询缓存（BoundedMap + TTL淘汰）和源超时保护（Promise.race竞速）机制。作为MemoryPipeline的Recall阶段核心，为Agent提供"一次查询、多源聚合"的记忆检索能力。

## 融合来源

融合自信息检索领域的"联合搜索"（Federated Search）模式和分布式系统中的"扇出-聚合"（Scatter-Gather）模式。联合搜索将一个查询同时发送到多个搜索引擎，汇总结果后统一排序呈现——UnifiedMemoryRecaller将查询扇出到7个异构记忆源，收集结果后去重排序返回。并行/顺序双模式对应搜索引擎的"并行扇出"与"串行级联"策略，源超时机制对应分布式系统的"超时熔断"模式。

## 核心API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `constructor(options)` | options?: Object | UnifiedMemoryRecaller | 构造函数 |
| `attachSource(sourceName, sourceInstance, options?)` | sourceName: string, source: Object, options?: Object | this | 附加记忆源 |
| `enableSource(sourceName)` | sourceName: string | this | 启用指定源 |
| `disableSource(sourceName)` | sourceName: string | this | 禁用指定源 |
| `recall(query, options?)` | query: string, options?: Object | Promise\<Object\> | 异步召回（并行/顺序） |
| `recallSync(query, options?)` | query: string, options?: Object | Object | 同步召回（仅同步源） |
| `getStats()` | 无 | Object | 获取统计信息 |
| `isHealthy()` | 无 | boolean | 健康检查 |

### attachSource选项

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `recallFn` | Function | 自动检测 | 自定义召回函数，覆盖默认检测 |
| `priority` | number | 1 | 源优先级，数值越高排序越靠前 |

### 默认召回函数映射

| 源名称 | 检测方法 | 说明 |
|--------|---------|------|
| `brain-memory` | `retrieve()` | BrainMemory检索 |
| `memory-store` | `queryKnowledge()` | MemoryStore知识查询 |
| `thought-store` | `search()` | ThoughtMemoryStore搜索 |
| `llm-wiki` | `search()` | LlmWiki知识库搜索 |
| `dream-engine` | `getRelevantNotes()` | DreamEngine梦境笔记 |
| `causal-store` | `searchByCausalSimilarity()` | 因果存储相似度搜索 |
| `prefetcher` | `getPrefetched()` | 预取缓存命中 |

### 静态属性

| 属性 | 说明 |
|------|------|
| `RECALL_SOURCES` | 7种召回源枚举 |
| `DEFAULT_RECALL_CONFIG` | 默认配置对象 |

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxResults` | number | 20 | 单次召回最大结果数 |
| `minConfidence` | number | 0.3 | 最低置信度阈值 |
| `deduplicationThreshold` | number | 0.85 | 去重相似度阈值 |
| `sourceTimeoutMs` | number | 5000 | 单源超时时间（毫秒） |
| `enableParallelRecall` | boolean | true | 是否启用并行召回模式 |
| `cacheMaxSize` | number | 100 | 查询缓存最大条目数 |
| `cacheTTL` | number | 60000 | 查询缓存TTL（毫秒） |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `recall-completed` | 召回完成 | `{ query, resultCount, sourceCount }` |

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/shutdown-mixin.js`（优雅关闭混入）
- 依赖：`../../utils/debug-logger.js`（调试日志）
- 依赖：`../../utils/bounded-map.js`（BoundedMap查询缓存）
- 可选关联：BrainMemory、MemoryStore、ThoughtStore、LlmWiki、DreamEngine、CausalStore、Prefetcher（通过attachSource方法）

## 使用示例

```javascript
const { UnifiedMemoryRecaller } = require('./src/runtime/thought/unified-memory-recaller');

const recaller = new UnifiedMemoryRecaller({
  maxResults: 20,
  enableParallelRecall: true,
  sourceTimeoutMs: 5000,
});

recaller
  .attachSource('brain-memory', brainMemory)
  .attachSource('memory-store', memoryStore, { priority: 2 })
  .attachSource('llm-wiki', llmWiki, { priority: 3 })
  .attachSource('dream-engine', dreamEngine)
  .attachSource('prefetcher', prefetcher);

const result = await recaller.recall('分层架构设计原则');
console.log(result.results);
console.log(result.meta);

const syncResult = recaller.recallSync('分层架构设计原则');
```

## 与现有模块的集成点

- **MemoryPipeline**：作为管道的召回层（Recall阶段），由管道在初始化时自动布线
- **MemoryPrefetcher**：作为召回源之一（prefetcher源），预取缓存可被直接命中
- **BrainMemory**：核心召回源，提供分层记忆检索
- **LlmWiki**：知识库召回源，提供结构化知识搜索
- **DreamEngine**：梦境笔记召回源，提供经验提炼结果
- **CausalStore**：因果存储召回源，提供因果相似度搜索

## 相关文档

- [[模块详解-思维子系统]] — 思维子系统总览
- [[模块详解-MemoryPrefetcher记忆预取器]] — 记忆预取器
- [[模块详解-MemorySyncCoordinator记忆同步协调器]] — 记忆同步协调器
- [[模块详解-MemoryPipeline记忆管道]] — 记忆管道集成
- [[核心功能-记忆管道系统]] — 记忆管道Hermes三阶段流程
