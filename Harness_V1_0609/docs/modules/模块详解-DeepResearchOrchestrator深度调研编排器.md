# 模块详解 - DeepResearchOrchestrator 深度调研编排器

> 版本：2.73.4 | 源码：`src/runtime/skill/deep-research-orchestrator.js`

---

## 概述

DeepResearchOrchestrator 是融合 deer-flow（字节 65000 Star）设计理念的深度调研编排器，实现自主规划调研路线、多轮迭代搜索、多源信息聚合和结构化研究报告生成的端到端自动化系统。

## 核心特性

- **5阶段调研流程**：规划(PLAN) → 采集(COLLECT) → 分析(ANALYZE) → 综合(SYNTHESIZE) → 报告(REPORT)
- **自主调研路线规划**：根据主题自动生成搜索关键词和调研子问题
- **多源并行采集**：同时搜索多个信息源，支持 EvolvingSearchEngine 和 KnowledgeBasePipeline
- **信息冲突检测**：多源信息交叉验证，标记矛盾和共识
- **结构化报告生成**：自动生成 Markdown/JSON/Compact 三种格式报告
- **Token 预算管理**：调研过程 Token 消耗追踪和控制
- **BoundedArray/BoundedMap**：历史记录和源缓存自动限容

## 类定义

```javascript
class DeepResearchOrchestrator extends EventEmitter
// 混入 withShutdown，支持 guardShutdown() 和 _onShutdown()
```

## 常量

### RESEARCH_PHASES

| 阶段 | 值 | 说明 |
|------|------|------|
| PLAN | `'plan'` | 规划阶段 |
| COLLECT | `'collect'` | 采集阶段 |
| ANALYZE | `'analyze'` | 分析阶段 |
| SYNTHESIZE | `'synthesize'` | 综合阶段 |
| REPORT | `'report'` | 报告阶段 |

### DEFAULT_CONFIG

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| maxSearchRounds | 5 | 最大搜索轮次 |
| maxSourcesPerRound | 10 | 每轮最大采集源数 |
| maxTotalSources | 50 | 最大总采集源数 |
| minConfidenceForCompletion | 0.7 | 完成最低置信度 |
| reportMaxLength | 30000 | 报告最大长度 |
| researchHistorySize | 100 | 历史记录容量 |
| sourceCacheSize | 500 | 源缓存容量 |

## 构造函数

```javascript
new DeepResearchOrchestrator(config)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| config.searchEngine | Object | EvolvingSearchEngine 实例 |
| config.knowledgeBase | Object | KnowledgeBasePipeline 实例 |
| config.mcpClient | Object | MCPClient 实例（用于 Web 搜索） |
| config.maxSearchRounds | number | 最大搜索轮次覆盖 |

## 核心 API

### research(topic, options)

执行深度调研，5 阶段流程。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| topic | string | 是 | 调研主题（1-1000字符） |
| options.depth | string | 否 | 调研深度：`'quick'`/`'standard'`/`'deep'` |
| options.focusAreas | string[] | 否 | 聚焦领域（最多10个） |
| options.outputFormat | string | 否 | 输出格式：`'markdown'`/`'json'`/`'compact'` |
| options.maxRounds | number | 否 | 最大搜索轮次覆盖 |

**返回值：**

```javascript
{
  researchId: string,        // 调研ID
  topic: string,             // 调研主题
  depth: string,             // 调研深度
  confidence: number,        // 综合置信度(0-1)
  sources: number,           // 采集源数量
  findings: number,          // 发现数量
  conflicts: number,         // 冲突数量
  phases: string[],          // 执行的阶段列表
  tokensUsed: number,        // Token消耗
  duration: number,          // 耗时(ms)
  report: string|Object,     // 结构化报告
}
```

### getHistory(limit)

获取调研历史记录。

### getStats()

获取统计信息，包含 totalResearches、cachedSources、active、searchEngine、knowledgeBase、mcpClient。

## 5阶段流程详解

### Phase 1: PLAN — 规划调研路线

1. 从主题中提取关键词（过滤停用词）
2. 生成子问题（最新进展、核心原理、最佳实践 + 聚焦领域）
3. 组合搜索查询（高优先级关键词 + 中优先级子问题，最多20条）

### Phase 2: COLLECT — 多轮采集

1. 按轮次执行搜索，每轮取一批查询
2. 每个查询依次尝试 EvolvingSearchEngine → KnowledgeBasePipeline 降级
3. 采集结果存入源缓存，追踪 Token 消耗
4. 每轮结束后识别知识缺口，生成补充查询

### Phase 3: ANALYZE — 信息分析

1. 按查询关键词分组源信息
2. 每组生成一个 Finding（摘要、置信度、源数量）
3. 多源信息交叉验证，检测共识/冲突
4. 冲突信息标记为 Conflict

### Phase 4: SYNTHESIZE — 综合结果

1. 按置信度排序 Findings
2. 加权计算整体置信度（权重 = sourceCount × consensus）
3. 冲突惩罚（每个冲突 -0.05）
4. 识别剩余知识缺口

### Phase 5: REPORT — 生成报告

支持三种输出格式：

- **Markdown**：完整结构化报告（标题/摘要/冲突/缺口/来源）
- **JSON**：结构化数据对象
- **Compact**：精简文本格式

## 事件

| 事件名 | 数据 | 说明 |
|--------|------|------|
| `phase` | `{ researchId, phase }` | 阶段切换 |
| `research-complete` | `{ researchId, topic, confidence, duration }` | 调研完成 |
| `research-error` | `{ researchId, error }` | 调研错误 |

## 与其他模块的集成

| 模块 | 集成方式 |
|------|----------|
| EvolvingSearchEngine | `config.searchEngine` — 5阶段搜索引擎 |
| KnowledgeBasePipeline | `config.knowledgeBase` — 知识库查询 |
| MCPClient | `config.mcpClient` — Web搜索适配器 |
| BoundedArray | 历史记录限容 |
| BoundedMap | 源缓存限容 |
| withShutdown | 生命周期管理 |

## 融合来源

本模块融合了 deer-flow（字节跳动，65000 Star）的设计理念：

| deer-flow 特性 | Harness 实现 |
|----------------|-------------|
| 自主调研路线规划 | `_planResearch()` 关键词提取 + 子问题生成 |
| 多轮迭代搜索 | `_collectSources()` 多轮采集 + 知识缺口补充 |
| 多源信息聚合 | `_searchOne()` 多引擎降级 + `_searchQueries()` 批量搜索 |
| 信息冲突检测 | `_detectConsensus()` 交叉验证 + `_analyzeFindings()` 冲突标记 |
| 结构化报告生成 | `_generateReport()` 三种格式输出 |
| Token预算管理 | context.tokenBudget 追踪和控制 |

## 使用示例

```javascript
const DeepResearchOrchestrator = require('./src/runtime/skill/deep-research-orchestrator');

const orchestrator = new DeepResearchOrchestrator({
  searchEngine: evolvingSearchEngine,
  knowledgeBase: knowledgeBasePipeline,
  maxSearchRounds: 5,
});

// 监听阶段事件
orchestrator.on('phase', ({ researchId, phase }) => {
  console.log(`[${researchId}] Phase: ${phase}`);
});

// 执行深度调研
const result = await orchestrator.research('大语言模型在代码生成中的应用', {
  depth: 'deep',
  focusAreas: ['性能优化', '安全性'],
  outputFormat: 'markdown',
});

console.log('Confidence:', result.confidence);
console.log('Sources:', result.sources);
console.log('Report:', result.report);
```
