# 模块详解-ThoughtExtractor思维提取器

> 版本：2.73.4 | 文件：src/runtime/thought/thought-extractor.js

---

## 模块概述

ThoughtExtractor是Harness多Agent框架的思维提取器，负责从Agent输出文本中自动识别和提取关键思维链。它通过预定义的标记模式（中英文双语支持）识别五种思维类型：洞察(insight)、模式(pattern)、决策(decision)、修正(correction)、原则(principle)，并为每条思维计算置信度分数、构建溯源链、推断标签。

该模块是思维子系统的入口组件，与ThoughtDeduplicator、ThoughtMemoryStore、ThoughtRetrieverCycle协作，为深化推理和记忆推动提供结构化思维数据。

## 类定义

```javascript
class ThoughtExtractor extends EventEmitter {
  constructor(options)
  extract(output, context)
  getStats()
  isHealthy()
  shutdown() // via withShutdown mixin
}
```

通过`withShutdown`混入后导出，自动获得`shutdown()`方法和`_onShutdown()`生命周期钩子。

### 静态属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `ThoughtExtractor.THOUGHT_TYPES` | Object | 思维类型枚举：insight/pattern/decision/correction/principle |
| `ThoughtExtractor.CONFIDENCE_THRESHOLD` | number | 默认置信度阈值（0.7） |

## 构造函数

### `new ThoughtExtractor(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options.confidenceThreshold` | number | 否 | 0.7 | 置信度过滤阈值，低于此值的思维被丢弃 |
| `options.minLength` | number | 否 | 10 | 思维内容最小长度 |
| `options.maxLength` | number | 否 | 500 | 思维内容最大长度 |

## 核心方法

### `extract(output, context)`

从Agent输出文本中提取结构化思维链。先通过标记模式匹配显式思维，若无匹配则通过显著性标记提取隐式洞察。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `output` | string | 是 | Agent输出文本 |
| `context` | Object | 否 | 提取上下文 |

**context参数结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `taskId` | string | 任务ID |
| `sessionId` | string | 会话ID |
| `agentId` | string | Agent ID |
| `skillId` | string | Skill ID |
| `domain` | string | 领域标签 |
| `qualityScore` | number | 质量评分（影响置信度调整） |
| `iteration` | number | 迭代轮次 |

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `thoughts` | Array | 提取的思维列表，每条含id/type/content/confidence/sourceTrace/domain/tags |
| `sourceId` | string | 来源标识（taskId或sessionId） |
| `extractedAt` | string | 提取时间（ISO格式） |

**事件触发**：`thoughts-extracted`

### `getStats()`

获取提取统计信息。

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalExtractions` | number | 总提取次数 |
| `thoughtsExtracted` | number | 成功提取的思维数 |
| `thoughtsFiltered` | number | 被过滤掉的思维数 |
| `errors` | number | 错误次数 |
| `byType` | Object | 按类型统计，如{insight: 10, decision: 5} |

### `isHealthy()`

检查提取器健康状态。未关闭且错误数<100时返回true。

## 五种思维类型

| 类型 | 标记（英文） | 标记（中文） | 默认权重 |
|------|-------------|-------------|---------|
| insight | insight:, key insight:, important finding: | 发现:, 关键发现: | 0.9 |
| pattern | pattern:, recurring pattern:, common pattern: | 模式:, 规律: | 0.85 |
| decision | decision:, decided:, chosen approach: | 决定:, 决策: | 0.95 |
| correction | correction:, fix:, previously incorrect: | 修正:, 纠正: | 0.9 |
| principle | principle:, rule:, best practice: | 原则:, 规则: | 0.85 |

## 提取流程

```
输入文本 → 逐行标记匹配 → 提取内容 → 隐式思维兜底 → 归一化 → 长度过滤 → 置信度调整 → 阈值过滤 → 输出
```

1. **显式提取**：逐行匹配EXTRACTION_PATTERNS中的标记，提取标记后的内容
2. **隐式提取**：无显式匹配时，按显著性标记（therefore/因此/must/必须等）提取隐式洞察，最多5条
3. **归一化**：合并空白字符、去除首尾引号
4. **长度过滤**：内容长度需在[minLength, maxLength]范围内
5. **置信度调整**：decision类型+0.05，correction类型+0.03；有qualityScore时按比例调整；内容过短(<20)×0.85
6. **阈值过滤**：置信度低于confidenceThreshold的思维被丢弃

## 标签推断

自动从思维内容和上下文中推断标签：

| 标签 | 关键词 |
|------|--------|
| security | security, vulnerability, xss, injection, 安全, 漏洞 |
| performance | performance, optimization, latency, 性能, 优化 |
| testing | test, coverage, tdd, 测试, 覆盖 |
| architecture | architecture, design, pattern, 架构, 设计 |
| bug | bug, fix, error, 缺陷, 修复 |
| api | api, endpoint, route, 接口 |
| database | database, query, sql, 数据库 |

## 事件

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `thoughts-extracted` | 思维提取完成 | {thoughts, sourceId, extractedAt} |

## 使用示例

```javascript
const ThoughtExtractor = require('./src/runtime/thought/thought-extractor');

const extractor = new ThoughtExtractor({
  confidenceThreshold: 0.75,
  minLength: 15,
  maxLength: 300,
});

extractor.on('thoughts-extracted', (result) => {
  console.log(`提取到 ${result.thoughts.length} 条思维`);
});

const output = `
分析完成。insight: 模块间耦合度过高导致测试困难。
decision: 采用依赖注入模式重构模块初始化流程。
principle: 每个模块应只依赖抽象接口而非具体实现。
`;

const result = extractor.extract(output, {
  taskId: 'task-001',
  sessionId: 'session-001',
  agentId: 'analyst',
  domain: 'architecture',
  qualityScore: 0.85,
});

for (const thought of result.thoughts) {
  console.log(`[${thought.type}] ${thought.content} (置信度: ${thought.confidence})`);
}

console.log(extractor.getStats());
```

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/constants`（generateId唯一ID生成）
- 依赖：`../../utils/safe-execute`（roundTo数值精度工具）
- 依赖：`../../utils/shutdown-mixin`（优雅关闭混入）
- 被依赖：ThoughtDeduplicator（思维去重器，接收提取结果）
- 被依赖：ThoughtMemoryStore（思维记忆存储，持久化思维链）
- 被依赖：DeepeningOrchestrator（深化推理，思维检索）

## 相关文档

- [[模块详解-DeepeningOrchestrator模块]]
- [[模块详解-QualityScorer质量评分器]]
- [核心功能-深化推理引擎](../core/核心功能-深化推理引擎.md)
