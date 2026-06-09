# 模块详解-MemoryPrefetcher记忆预取器

> 版本：2.73.4 | 文件：src/runtime/thought/memory-prefetcher.js | 行数：~397行

---

## 模块概述

MemoryPrefetcher是思维子系统的记忆预取组件，基于5种预取信号（阶段变更、高熵检测、任务亲和、用户模式、周期性）主动从多个记忆源预加载相关数据到本地缓存。模块采用BoundedMap/BoundedArray进行容量限制，支持TTL过期淘汰和并发控制，通过8个attach方法连接BrainMemory、MemoryStore、LlmWiki、DreamEngine等外部组件。预取结果可被UnifiedMemoryRecaller直接命中，减少实时查询延迟。

## 融合来源

融合自CPU缓存预取（Cache Prefetching）技术和认知科学中的"预期性记忆"（Prospective Memory）概念。正如CPU根据访问模式预取数据到L1/L2缓存，MemoryPrefetcher根据阶段变更、用户行为等信号预判即将需要的记忆数据并提前加载。5种预取信号对应不同的触发场景：阶段变更类比程序局部性原理，高熵检测类比注意力聚焦，任务亲和类比关联预取，用户模式类比历史行为预测，周期性类比定期刷新。

## 核心API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `constructor(options)` | options?: Object | MemoryPrefetcher | 构造函数 |
| `attachBrainMemory(bm)` | bm: Object | this | 关联BrainMemory实例 |
| `attachMemoryStore(ms)` | ms: Object | this | 关联MemoryStore实例 |
| `attachStructuredIntent(si)` | si: Object | this | 关联StructuredIntent实例 |
| `attachAffinityLearner(al)` | al: Object | this | 关联AffinityLearner实例 |
| `attachPhaseContextInjector(pci)` | pci: Object | this | 关联PhaseContextInjector实例 |
| `attachUserModelManager(umm)` | umm: Object | this | 关联UserModelManager实例 |
| `attachLlmWiki(wiki)` | wiki: Object | this | 关联LlmWiki实例 |
| `attachDreamEngine(de)` | de: Object | this | 关联DreamEngine实例 |
| `start()` | 无 | void | 启动周期性预取定时器 |
| `stop()` | 无 | void | 停止定时器 |
| `onPhaseChange(phaseInfo)` | phaseInfo: Object | void | 阶段变更信号处理 |
| `onIntentParsed(intentResult)` | intentResult: Object | void | 高熵意图信号处理 |
| `onTaskAssigned(taskInfo)` | taskInfo: Object | void | 任务亲和信号处理 |
| `onUserInteraction(interactionInfo)` | interactionInfo: Object | void | 用户模式信号处理 |
| `getPrefetched(query)` | query: string | Object\|null | 按查询键获取预取缓存 |
| `getPrefetchedForContext(context)` | context: Object | Object[] | 按上下文匹配获取预取缓存 |
| `getStats()` | 无 | Object | 获取统计信息 |
| `isHealthy()` | 无 | boolean | 健康检查 |

### 静态属性

| 属性 | 说明 |
|------|------|
| `PREFETCH_SIGNALS` | 预取信号类型枚举 |
| `DEFAULT_PREFETCH_CONFIG` | 默认配置对象 |

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxPrefetchedEntries` | number | 50 | 预取缓存最大条目数 |
| `prefetchTTL` | number | 300000 (5分钟) | 预取缓存TTL（毫秒） |
| `entropyThreshold` | number | 0.7 | 触发高熵预取的熵值阈值 |
| `affinityThreshold` | number | 0.6 | 亲和推荐最低分数阈值 |
| `periodicIntervalMs` | number | 60000 (1分钟) | 周期性预取间隔 |
| `maxConcurrentPrefetches` | number | 3 | 最大并发预取数 |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `started` | 预取器启动 | 无 |
| `stopped` | 预取器停止 | 无 |
| `prefetch-completed` | 预取完成 | `{ signal, cacheKey, memoryCount }` |

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/shutdown-mixin.js`（优雅关闭混入）
- 依赖：`../../utils/debug-logger.js`（调试日志）
- 依赖：`../../utils/safe-execute.js`（safeCall安全执行）
- 依赖：`../../utils/bounded-map.js`（BoundedMap容量限制映射）
- 依赖：`../../utils/bounded-array.js`（BoundedArray容量限制数组）
- 可选关联：BrainMemory、MemoryStore、LlmWiki、DreamEngine、AffinityLearner等（通过attach方法）

## 使用示例

```javascript
const { MemoryPrefetcher } = require('./src/runtime/thought/memory-prefetcher');

const prefetcher = new MemoryPrefetcher({
  maxPrefetchedEntries: 100,
  prefetchTTL: 300000,
  entropyThreshold: 0.7,
});

prefetcher
  .attachBrainMemory(brainMemory)
  .attachMemoryStore(memoryStore)
  .attachLlmWiki(llmWiki)
  .attachDreamEngine(dreamEngine)
  .attachAffinityLearner(affinityLearner);

prefetcher.start();

prefetcher.onPhaseChange({ phase: 'module-development' });

const cached = prefetcher.getPrefetched('phase:module-development');
```

## 与现有模块的集成点

- **MemoryPipeline**：作为管道的预取层（Prefetch阶段），由管道在初始化时自动布线
- **UnifiedMemoryRecaller**：作为召回源之一（prefetcher源），预取缓存可被直接命中
- **BrainMemory**：预取的主要数据源，通过retrieve()方法查询
- **LlmWiki**：知识库预取源，通过search()方法查询
- **DreamEngine**：梦境笔记预取源，通过getRelevantNotes()方法查询
- **AffinityLearner**：任务亲和推荐源，通过getRecommendations()方法查询
- **UserModelManager**：用户偏好预取源，通过getPreferences()方法查询

## 相关文档

- [[模块详解-思维子系统]] — 思维子系统总览
- [[模块详解-UnifiedMemoryRecaller统一记忆召回器]] — 统一记忆召回器
- [[模块详解-MemoryPipeline记忆管道]] — 记忆管道集成
- [[核心功能-记忆管道系统]] — 记忆管道Hermes三阶段流程
