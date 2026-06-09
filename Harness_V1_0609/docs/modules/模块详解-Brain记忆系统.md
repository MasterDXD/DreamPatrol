# 模块详解-Brain记忆系统

> 版本：2.73.4 | 文件：src/runtime/thought/brain-memory.js | 行数：~640行

---

## 模块概述

BrainMemory模块实现了仿生记忆系统，模拟人脑的记忆存储、检索和巩固机制。模块支持三种检索模式：关键词检索（基于TF-IDF算法）、语义检索（基于向量余弦相似度）和混合检索（关键词40%+语义60%加权融合）。核心特性包括：TTL过期机制、定期自动巩固（合并相似记忆、清除过期和陈旧记忆）、LRU淘汰策略、倒排索引加速检索、健康状态监控，以及通过EventBus和SQLite实现的事件通知与持久化。

## 融合来源

融合自认知科学的"双过程记忆理论"（Dual-Process Memory Theory）和"记忆巩固"（Memory Consolidation）理论。模块模拟了人脑的工作记忆→长期记忆转换过程：短期记忆通过重复访问和语义关联被巩固为长期记忆，相似记忆自动合并，过期和陈旧记忆被遗忘（TTL+淘汰机制），检索时同时激活关键词路径和语义关联路径（混合检索模式）。

## 核心API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `store(key, content, metadata?)` | key: string, content: string, metadata?: Object | `Object \| null` | 存储记忆，支持category/tags/confidence/source/ttl元数据 |
| `retrieve(query, options?)` | query: string, options?: `{ mode, topK, minConfidence, categories }` | `Object[]` | 检索记忆，mode可选keyword/semantic/hybrid |
| `invalidate(pattern)` | pattern: string | `number` | 按前缀或标签使记忆失效 |
| `consolidate()` | 无 | `{ merged, expired, staleRemoved }` | 执行记忆巩固：合并相似、清除过期和陈旧 |
| `getHealthStatus()` | 无 | `{ status, memoryCount, avgRetrievalTime, hitRate }` | 获取健康状态（healthy/degraded/unhealthy） |
| `getStatusBar()` | 无 | `{ totalMemories, categories, recentHits, avgConfidence, storageUsage }` | 获取状态面板数据 |
| `getStats()` | 无 | `Object` | 获取详细统计 |
| `attachSqliteStore(store)` | store: SqliteStore | `this` | 关联SQLite存储 |
| `attachEmbeddingService(service)` | service: EmbeddingService | `this` | 关联嵌入服务 |
| `attachEventBus(bus)` | bus: EventBus | `this` | 关联事件总线 |

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxMemories` | number | 2000 | 最大记忆条目数 |
| `defaultTTL` | number | 86400000 | 默认TTL（24小时，毫秒） |
| `retrievalTimeout` | number | 100 | 检索超时阈值（毫秒），影响健康状态判定 |
| `consolidationInterval` | number | 3600000 | 自动巩固间隔（1小时，毫秒） |
| `similarityThreshold` | number | 0.8 | 巩固时合并相似记忆的阈值 |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `memory-stored` | 记忆存储完成 | `{ key, category }` |
| `memory-retrieved` | 记忆检索完成 | `{ query, mode, resultCount, elapsed }` |
| `memory-invalidated` | 记忆失效 | `{ pattern, count }` |
| `memory-consolidated` | 记忆巩固完成 | `{ merged, expired, staleRemoved }` |

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/debug-logger.js`（调试日志）
- 依赖：`../../utils/safe-assign.js`（mergeConfig）
- 依赖：`../../utils/safe-execute.js`（safeCall, roundTo）
- 依赖：`../../utils/shutdown-mixin.js`（优雅关闭混入）
- 可选关联：`SqliteStore`、`EmbeddingService`、`EventBus`（通过attach方法）

## 使用示例

```javascript
const BrainMemory = require('./src/runtime/thought/brain-memory');

const brain = new BrainMemory({ maxMemories: 1000, consolidationInterval: 1800000 });
brain.attachSqliteStore(sqliteStore);
brain.attachEmbeddingService(embeddingService);
brain.attachEventBus(eventBus);

brain.store('arch-decision-001', '采用分层架构，Interaction→Business→Domain→Infrastructure', {
  category: 'architecture',
  tags: ['分层架构', '依赖方向'],
  confidence: 0.9,
  ttl: 604800000,
});

brain.store('error-pattern-001', 'TypeError: Cannot read property of undefined', {
  category: 'error-pattern',
  tags: ['TypeError', 'null-check'],
  confidence: 0.7,
});

const results = brain.retrieve('分层架构的依赖方向', {
  mode: 'hybrid',
  topK: 5,
  minConfidence: 0.6,
  categories: ['architecture'],
});

console.log('Found:', results.length, 'memories');

const health = brain.getHealthStatus();
console.log('Health:', health.status, 'Hit rate:', health.hitRate);
```

## 与现有模块的集成点

- **DreamEngine**：跨会话学习引擎生成的笔记可写入BrainMemory，使学习成果在实时检索中可用
- **ContextCompressionEngine**：上下文压缩引擎在决定keep/summarize/discard时，可查询BrainMemory判断信息是否已存储
- **ThoughtRetrieverCycle**：思维检索循环通过BrainMemory的混合检索模式获取相关历史决策
- **EmbeddingService**：嵌入服务为记忆内容生成向量，支持语义检索和相似度计算
- **EventBus**：事件总线将记忆操作事件广播到其他子系统（如Dashboard监控）
- **SessionManager**：会话管理器在会话恢复时从BrainMemory加载关键记忆
