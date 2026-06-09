# 模块详解-TriAttention上下文优化

> 版本：2.73.4 | 文件：src/runtime/model/tri-attention.js | 行数：~130行

---

## 模块概述

TriAttention模块实现了Pre-RoPE空间三角级数评分+向量幅度双引擎注意力计算器。模块通过综合计算每个上下文条目的注意力分数（三角级数距离偏好×向量幅度×时效性），在Token预算约束下筛选高注意力条目保留、低注意力条目裁剪，实现上下文窗口的智能压缩。三角级数距离偏好采用Pre-RoPE空间位置编码建模，向量幅度反映信息密度，两者结合形成双引擎评分机制。模块支持离线校准Q/K聚类中心，自适应权重调整，同时为KVCacheManager提供注意力评分基础，实现KV缓存压缩。

## 融合来源

融合自Transformer架构的自注意力（Self-Attention）机制和认知心理学的"首因-近因效应"（Primacy-Recency Effect）。模块将Transformer的多头注意力简化为三维度评分模型：位置注意力（positional attention，正弦位置编码）、重要性注意力（importance attention，内容价值评分）、时效性注意力（recency attention，时间衰减），三者相乘得到综合注意力分数，在Token预算内贪心选择高注意力条目。

## 核心API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `optimize(contextWindow, budget)` | contextWindow: `{ entries }`, budget: `{ maxTokens, reservedTokens }` | `{ optimized, pruned, tokensSaved, compressionRatio }` | 在Token预算内优化上下文窗口 |
| `estimateAttention(entry, position, total)` | entry: Object, position: number, total: number | `number` | 估算单个条目的注意力分数 |
| `getStats()` | 无 | `{ optimizeCount, totalPruned, totalTokensSaved, config }` | 获取统计信息 |

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `attentionThreshold` | number | 0.3 | 注意力阈值，低于此值的条目被裁剪 |
| `maxContextEntries` | number | 500 | 最大上下文条目数 |
| `recencyDecay` | number | 0.95 | 时效性衰减系数（预留参数） |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `optimized` | 优化完成 | `{ optimized, pruned, tokensSaved, compressionRatio }` |

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../errors.js`（DeepeningError）
- 依赖：`../../utils/safe-assign.js`（mergeConfig）
- 依赖：`../../utils/debug-logger.js`（调试日志）
- 依赖：`../../utils/shutdown-mixin.js`（优雅关闭混入）

## 使用示例

```javascript
const TriAttention = require('./src/runtime/model/tri-attention');

const triAttention = new TriAttention({ attentionThreshold: 0.2 });

const contextWindow = {
  entries: [
    { content: '系统提示：你是一个代码审查助手', importance: 0.9, recency: 1.0 },
    { content: '用户要求：修复登录页面的空指针异常', importance: 0.8, recency: 0.9 },
    { content: '历史对话：上次讨论了数据库连接池配置', importance: 0.3, recency: 0.2 },
    { content: '代码片段：function login(user) { ... }', importance: 0.7, recency: 0.8 },
    { content: '调试日志：TypeError at line 42', importance: 0.6, recency: 0.7 },
  ],
};

const budget = { maxTokens: 500, reservedTokens: 100 };

const result = triAttention.optimize(contextWindow, budget);
console.log('Optimized:', result.optimized.length, 'entries');
console.log('Pruned:', result.pruned.length, 'entries');
console.log('Tokens saved:', result.tokensSaved);
console.log('Compression ratio:', result.compressionRatio.toFixed(2));

const attention = triAttention.estimateAttention(
  { importance: 0.8, recency: 0.9 },
  2,
  5,
);
console.log('Attention score:', attention.toFixed(3));
```

## 与现有模块的集成点

- **ContextCompressionEngine**：上下文压缩引擎在压缩计划的执行阶段调用TriAttention进行注意力评分和条目筛选
- **TokenManager**：Token管理器提供Token预算信息，TriAttention据此计算可用Token空间
- **DeepeningPipeline**：深化管道在迭代深化时使用TriAttention优化注入的上下文，确保关键信息不被裁剪
- **SessionManager**：会话管理器在会话压缩时通过TriAttention决定保留哪些会话历史条目
- **PhaseContextInjector**：阶段上下文注入器利用TriAttention在注入上下文时优先保留高注意力条目
