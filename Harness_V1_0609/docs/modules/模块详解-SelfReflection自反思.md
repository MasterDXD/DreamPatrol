# SelfReflection 自反思

## 模块概述

**源文件**：`src/runtime/quality/self-reflection.js`

SelfReflection 是质量子系统的自反思引擎，提供输出质量自评、改进建议生成和证伪维度反思能力。支持五维度反思（边界条件/一致性/安全性/性能/完整性）和证伪维度反思（falsification），根据质量趋势判定 improving/stable/degrading，推荐 continue/deepen-analysis/rollback-and-revise 动作。内置 code/design/test/documentation/decision 五种反思模板。

核心原则：**自我审视比外部审查更早发现问题**

## 核心概念

### 五维度反思

| 维度 | 标识 | 说明 |
|------|------|------|
| 边界条件 | `boundary_conditions` | 是否有遗漏的边界条件或异常处理 |
| 一致性 | `consistency` | 是否与之前的架构决策或接口约定一致 |
| 安全性 | `security` | 是否存在安全隐患 |
| 性能 | `performance` | 是否存在性能瓶颈 |
| 完整性 | `completeness` | 是否覆盖了所有需求场景 |

### 质量趋势判定

| 趋势 | 条件 | 建议动作 |
|------|------|---------|
| `improving` | 质量提升超过阈值（默认0.05） | `continue` |
| `stable` | 质量变化在阈值范围内 | `deepen-analysis` |
| `degrading` | 质量下降超过阈值 | `rollback-and-revise` |
| `initial` | 无前一次质量分数 | `proceed-with-caution` |
| `unknown` | 质量分数无效 | `re-evaluate` |

### 反思模板

| 模板类型 | 适用场景 | 问题数 |
|---------|---------|--------|
| `code` | 代码产出 | 5条 |
| `design` | 设计产出 | 5条 |
| `test` | 测试产出 | 5条 |
| `documentation` | 文档产出 | 5条 |
| `decision` | 决策产出 | 5条（含证伪与反谄媚检查） |

## API 参考

### 构造函数

```javascript
new SelfReflection(options)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.maxReflections` | number | 3 | 最大反思次数 |
| `options.improvementThreshold` | number | 0.05 | 质量改善判定阈值 |
| `options.qualityWeights` | object | 见下方 | 各维度权重 |
| `options.autoTriggerOnQualityDrop` | boolean | true | 质量下降时是否自动触发反思 |
| `options.persistResults` | boolean | true | 是否持久化反思结果 |
| `options.maxHistory` | number | 500 | 历史记录最大条目数 |
| `options.signalPersistence` | object | null | 信号持久化实例 |

**默认质量权重**：

```javascript
{
  completeness: 0.25,
  correctness: 0.30,
  consistency: 0.15,
  security: 0.15,
  clarity: 0.15,
}
```

### reflect(context)

执行自反思，根据上下文生成反思问题、质量趋势判定与建议动作。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `context.agentId` | string | 是 | 执行反思的Agent标识 |
| `context.skillId` | string | 是 | 关联的Skill标识 |
| `context.artifactType` | string | 否 | 产出类型，可选 code/design/test/documentation/decision，默认 code |
| `context.previousQuality` | number | 否 | 前一次质量分数 |
| `context.currentQuality` | number | 否 | 当前质量分数 |
| `context.result` | object | 否 | 任务执行结果，用于维度推断 |
| `context.dimensionScores` | object | 否 | 各维度预计算分数 |

**返回值**：`{ reflectionId, questions, qualityTrend, recommendedAction, selfCheckPrompt, dimensions }` 或 `{ success: false, error }`

| 字段 | 类型 | 说明 |
|------|------|------|
| `reflectionId` | string | 反思记录唯一标识 |
| `questions` | Array\<string\> | 反思问题列表 |
| `qualityTrend` | string | 质量趋势（improving/stable/degrading/initial/unknown） |
| `recommendedAction` | string | 建议动作（continue/deepen-analysis/rollback-and-revise/proceed-with-caution/re-evaluate） |
| `selfCheckPrompt` | string | 自检提示文本 |
| `dimensions` | object | 各维度评分详情 |

**维度评分结构**：

```javascript
{
  boundary_conditions: { score: 0.7, weight: 0.15, needsAttention: false },
  consistency: { score: 0.5, weight: 0.15, needsAttention: true },
  // ...
}
```

### recordImprovement(reflectionId, improvement)

记录改进条目到指定反思记录中，更新平均改进量统计。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `reflectionId` | string | 是 | 反思记录标识 |
| `improvement.dimension` | string | 否 | 改进维度名称，默认 'general' |
| `improvement.description` | string | 否 | 改进描述文本 |
| `improvement.beforeScore` | number | 否 | 改进前分数，默认 0 |
| `improvement.afterScore` | number | 否 | 改进后分数，默认 0 |

**返回值**：`{ recorded: true, improvement }` 或 `{ success: false, error }`

### getReflection(reflectionId)

根据反思ID获取完整的反思记录。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `reflectionId` | string | 反思记录标识 |

**返回值**：反思记录对象（含 reflectionId/agentId/skillId/artifactType/questions/dimensions/improvements 等），不存在时返回 `null`

### getAgentReflections(agentId)

获取指定Agent的所有反思记录，按时间降序排列。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent标识 |

**返回值**：`Array<object>` — 该Agent的反思记录数组

### getStats()

获取反思统计摘要。

**返回值**：`{ totalReflections, totalImprovements, avgImprovement, activeReflections }`

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalReflections` | number | 总反思次数 |
| `totalImprovements` | number | 总改进次数 |
| `avgImprovement` | number | 平均改进量 |
| `activeReflections` | number | 活跃反思记录数 |

### shouldTriggerReflection(context)

判断是否应触发自反思。当质量下降超过阈值、证据完整度低于0.8或迭代次数大于1时返回 true。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `context.currentQuality` | number | 当前质量分数 |
| `context.previousQuality` | number | 前一次质量分数 |
| `context.evidenceCompleteness` | number | 证据完整度（0-1） |
| `context.iterationCount` | number | 迭代次数 |

**返回值**：`boolean`

### falsificationReflection(output, context)

执行证伪维度反思，生成证伪提示与反谄媚检查。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `output` | string | 待证伪审视的产出内容 |
| `context` | object | 证伪上下文信息 |

**返回值**：`{ type, output, context, falsificationPrompts, antiSycophancyCheck, timestamp }`

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定为 `'falsification_reflection'` |
| `falsificationPrompts` | Array\<string\> | 5条证伪提示 |
| `antiSycophancyCheck` | object | 反谄媚检查要求，含 question 和 required 字段 |

**5条证伪提示**：
1. 这个结论在什么现实条件下会被证明是错误的？
2. 支持此结论的最弱假设是什么？
3. 如果此方案失败，最可能的失败模式是什么？
4. 什么可观测的信号能证明此方案不可行？
5. 是否存在更简单的替代方案被忽略了？

### attachSignalPersistence(sp)

附加信号持久化实例，反思结果将自动持久化到信号存储。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `sp` | object | SignalPersistence实例 |

**返回值**：当前实例（支持链式调用）

## 事件类型

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `reflection-created` | 反思记录创建 | `{ reflectionId, agentId, qualityTrend, recommendedAction }` |
| `improvement-recorded` | 改进条目记录 | `{ reflectionId, dimension }` |

## 使用示例

### 基本自反思

```javascript
const SelfReflection = require('./src/runtime/quality/self-reflection');

const reflection = new SelfReflection({
  improvementThreshold: 0.05,
  qualityWeights: { completeness: 0.3, correctness: 0.3, consistency: 0.15, security: 0.15, clarity: 0.1 },
});

// 执行反思
const result = reflection.reflect({
  agentId: 'code-reviewer',
  skillId: 'tdd-implement',
  artifactType: 'code',
  previousQuality: 0.75,
  currentQuality: 0.82,
});

console.log(result.qualityTrend);        // 'improving'
console.log(result.recommendedAction);    // 'continue'
console.log(result.questions);            // 5条反思问题
console.log(result.selfCheckPrompt);      // 完整的自检提示
```

### 记录改进

```javascript
// 记录改进条目
const improvement = reflection.recordImprovement(result.reflectionId, {
  dimension: 'security',
  description: '添加了输入验证，防止SQL注入',
  beforeScore: 0.4,
  afterScore: 0.85,
});
```

### 证伪维度反思

```javascript
const falsification = reflection.falsificationReflection(
  '采用缓存策略可以将API响应时间降低50%',
  { context: '性能优化方案评估' }
);

// falsification.falsificationPrompts 包含5条证伪提示
// falsification.antiSycophancyCheck 包含反谄媚检查要求
```

### 自动触发判定

```javascript
if (reflection.shouldTriggerReflection({
  currentQuality: 0.6,
  previousQuality: 0.8,
  evidenceCompleteness: 0.7,
  iterationCount: 3,
})) {
  // 触发反思
  const result = reflection.reflect({ agentId: 'worker', skillId: 'task', currentQuality: 0.6, previousQuality: 0.8 });
}
```

### 查询Agent反思历史

```javascript
const agentReflections = reflection.getAgentReflections('code-reviewer');
// 按时间降序排列的反思记录数组

const stats = reflection.getStats();
console.log(`总反思: ${stats.totalReflections}, 平均改进: ${stats.avgImprovement.toFixed(3)}`);
```

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `maxReflections` | number | 3 | 最大反思次数 |
| `improvementThreshold` | number | 0.05 | 质量改善判定阈值 |
| `qualityWeights.completeness` | number | 0.25 | 完整性权重 |
| `qualityWeights.correctness` | number | 0.30 | 正确性权重 |
| `qualityWeights.consistency` | number | 0.15 | 一致性权重 |
| `qualityWeights.security` | number | 0.15 | 安全性权重 |
| `qualityWeights.clarity` | number | 0.15 | 清晰度权重 |
| `autoTriggerOnQualityDrop` | boolean | true | 质量下降时自动触发 |
| `persistResults` | boolean | true | 持久化反思结果 |
| `maxHistory` | number | 500 | 历史记录最大条目数 |

**静态属性**：
- `SelfReflection.REFLECTION_DIMENSIONS` — 反思维度列表
- `SelfReflection.REFLECTION_TEMPLATES` — 反思模板定义
