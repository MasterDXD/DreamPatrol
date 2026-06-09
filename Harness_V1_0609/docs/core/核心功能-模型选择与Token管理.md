# 核心功能-模型选择与Token管理

> 版本：2.73.4 | 模块：src/runtime/model/token-manager.js、src/runtime/model/model-selector.js、src/runtime/model/embedding-service.js

---

## 概述

模型子系统是Harness Engineering多Agent框架的资源管控与智能调度中枢，负责Token预算管理、模型选择降级和文本向量化三大核心能力。子系统由三个紧密协作的模块构成：

- **TokenManager** — Token使用量追踪、预算阈值检查（80%/95%/100%三级预警）、分类统计、格式化工具
- **ModelSelector** — 基于Skill映射与复杂度评分的模型选择、成本优化、自动降级策略、Fallback链
- **EmbeddingService** — 文本向量化、余弦相似度计算、批量处理、LRU缓存

三者共同实现"成本可控、质量可保、降级有序"的模型资源管理目标。

## 核心概念

### Token预算三级阈值

```
0% ─────────── 80% ─────────── 95% ─────────── 100%
  正常运行区      预警区          危险区          耗尽区
                 warning80      warning95      exhausted
                 发射事件        切换低价模型    暂停所有任务
```

| 概念 | 说明 |
|------|------|
| **Token Budget** | 全局Token预算，默认1,000,000,000（1B），通过`DEFAULT_TOKEN_BUDGET`常量定义 |
| **Warning Ratio** | 80%预警比例（`TOKEN_BUDGET_WARNING_RATIO = 0.8`），触发`token-warning-80`事件 |
| **Danger Ratio** | 95%危险比例（`TOKEN_BUDGET_DANGER_RATIO = 0.95`），触发`token-warning-95`事件，切换低价模型 |
| **Exhausted** | 100%耗尽，触发`token-exhausted`事件，暂停所有任务 |
| **Breakdown** | Token分类统计，按category（如input/output/toolCall）分别记录消耗 |
| **Model Tier** | 模型分层：premium（顶级推理）、standard（中等推理）、economy（低成本） |
| **Fallback Chain** | 降级链：`gpt-4o → gpt-4o-mini → gpt-3.5-turbo`，逐级降级 |
| **Complexity Score** | 任务复杂度评分（0~1），基于reasoning_depth、output_length、error_sensitivity、pattern_complexity四因子加权计算 |
| **Embedding** | 文本向量化，将文本映射为固定维度向量（默认128维），用于语义相似度计算 |
| **Cosine Similarity** | 余弦相似度，衡量两个向量方向的接近程度，值域[-1, 1]，1表示完全相同 |

### 模型分层体系

| 层级 | 模型 | 成本倍率 | 适用场景 |
|------|------|---------|---------|
| **premium** | gpt-4o, claude-3-opus, deepseek-v3, iris-alpha, beacon-alpha, deepseek-coder-pro | 1.0 | 架构设计、复杂调试、安全审计、深化推理、长上下文分析、多Agent协作、中文全栈编码 |
| **standard** | gpt-4o-mini, claude-3-sonnet, ember-alpha, deepseek-coder | 0.15 | TDD实现、代码审查、重构、自反思、实时工具调用、中文编码 |
| **economy** | gpt-3.5-turbo, deepseek-chat, deepseek-coder-lite | 0.02 | 测试执行、部署脚本、文档生成、中文单文件调试 |

### DeepSeek CodeGPT X 模型注册（R50新增）

| 模型 | 层级 | 上下文窗口 | 能力标签 | 推理模式 | 成本倍率 |
|------|------|-----------|---------|---------|---------|
| **deepseek-coder-pro** | premium | 128K | chinese-optimized, full-stack, team-collaboration, code-review, debugging | fast / xhigh | 0.6 |
| **deepseek-coder** | standard | 64K | chinese-optimized, full-stack, code-review, debugging | fast | 0.14 |
| **deepseek-coder-lite** | economy | 32K | chinese-optimized, single-file-debug | fast | 0.01 |

### LLM输出语言偏好控制（R50新增）

ModelLayer 新增 `setOutputLanguage(language)` 方法，设置后 `infer()` 自动在系统提示词中追加语言指令：

```javascript
modelLayer.setOutputLanguage('zh-CN');  // LLM输出强制中文
modelLayer.setOutputLanguage('en-US');  // LLM输出强制英文
modelLayer.setOutputLanguage(null);     // 不控制语言（默认）
```

### 中文技术栈模板（R50新增）

TechStackTemplates 新增4个中文开发生态模板：

| 模板名 | 分类 | 版本 | 适用场景 |
|--------|------|------|---------|
| **uniapp** | miniprogram | 3.x (Vue 3) | 跨端小程序开发（微信/支付宝/百度/字节） |
| **taro** | miniprogram | 4.x (React/Vue) | 京东系跨端小程序开发 |
| **wechatMiniprogram** | miniprogram | 基础库 3.x | 微信原生小程序开发 |
| **harmony** | harmony | API 12+ | 鸿蒙HarmonyOS/ArkTS应用开发 |

## 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                        Model Subsystem                          │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    TokenManager                           │   │
│  │                                                          │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │   │
│  │  │  store   │  │ validate │  │ addBreak │  │ format  │ │   │
│  │  │ (累加)   │  │ (预算)   │  │ (分类)   │  │ Tokens  │ │   │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │   │
│  │       │              │              │              │      │   │
│  │       ▼              ▼              ▼              ▼      │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │      _sessionTokens (Map)    _sessionBreakdowns     │ │   │
│  │  └────────────────────────┬────────────────────────────┘ │   │
│  │                           │                              │   │
│  │       ┌───────────────────┼───────────────────┐          │   │
│  │       ▼                   ▼                   ▼          │   │
│  │  ┌──────────┐   ┌──────────────┐   ┌──────────────┐     │   │
│  │  │ warning80│   │ warning95    │   │ exhausted    │     │   │
│  │  │ 事件发射 │   │ 事件发射     │   │ 事件发射     │     │   │
│  │  └──────────┘   └──────────────┘   └──────────────┘     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   ModelSelector                           │   │
│  │                                                          │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │   │
│  │  │ selectModel  │  │ recordUsage  │  │ getCostEstimate│  │   │
│  │  │ (模型选择)   │  │ (用量记录)   │  │ (成本估算)    │  │   │
│  │  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │   │
│  │         │                 │                   │          │   │
│  │         ▼                 ▼                   ▼          │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │  _skillModelMap    _modelTiers    _usageStats      │ │   │
│  │  │  (Skill→模型映射)  (模型分层)     (用量统计)       │ │   │
│  │  └────────────────────────┬────────────────────────────┘ │   │
│  │                           │                              │   │
│  │       ┌───────────────────┼───────────────────┐          │   │
│  │       ▼                   ▼                   ▼          │   │
│  │  ┌──────────┐   ┌──────────────┐   ┌──────────────┐     │   │
│  │  │Skill映射 │   │复杂度评分    │   │上下文降级    │     │   │
│  │  │优先选择  │   │动态选择      │   │自动调整      │     │   │
│  │  └──────────┘   └──────────────┘   └──────────────┘     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  EmbeddingService                         │   │
│  │                                                          │   │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐   │   │
│  │  │  embed   │  │ embedBatch   │  │ cosineSimilarity │   │   │
│  │  │ (向量化) │  │ (批量处理)   │  │ (相似度计算)     │   │   │
│  │  └────┬─────┘  └──────┬───────┘  └────────┬─────────┘   │   │
│  │       │               │                    │             │   │
│  │       ▼               ▼                    ▼             │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │  LRU Cache    _stats    Provider (local/openai/     │ │   │
│  │  │  (缓存结果)   (统计)     precomputed)               │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 三模块交互关系

```
SessionManager ──── Token消耗记录 ────→ TokenManager
     │                                      │
     │ ←─── 预算状态查询 ───────────────────┘
     │                                      │
     ├── 预算预警 ──→ ModelSelector ──→ 自动降级
     │                    │
     │                    ├── Skill映射选择
     │                    ├── 复杂度评分选择
     │                    └── 上下文调整降级
     │
     └── SkillRouter ──→ EmbeddingService ──→ 语义匹配
                              │
                              └── 向量相似度 → Skill语义路由
```

## TokenManager详解

### 使用量追踪

`store(sessionId, amount)` 方法是Token消耗的核心入口，执行以下步骤：

1. **关机检查**：若TokenManager已关闭，抛出`SHUTDOWN`错误
2. **ID验证**：sessionId必须为非空字符串，否则抛出`INVALID_SESSION_ID`
3. **数值验证**：amount必须为非负有限数，否则抛出`INVALID_TOKEN_AMOUNT`
4. **累加**：在`_sessionTokens` Map中累加该会话的Token用量
5. **容量控制**：会话数超过`maxSessions`（默认1000）时，驱逐最早的会话
6. **预算验证**：调用`validate()`检查阈值
7. **事件发射**：根据阈值状态发射对应事件

```javascript
const tokenMgr = new TokenManager({ defaultBudget: 1000000 });
const total = tokenMgr.store('session-1', 5000);
// total === 5000
tokenMgr.store('session-1', 3000);
// total === 8000
```

### 预算阈值检查

`validate(sessionId, budget?)` 方法返回预算状态对象：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | string | 会话ID |
| `tokensUsed` | number | 已使用Token数量 |
| `budget` | number | 预算上限（优先使用传入值，否则使用全局预算） |
| `ratio` | number | 使用比例（tokensUsed / budget） |
| `warning80` | boolean | 是否达到80%预警（`ratio >= 0.8`） |
| `warning95` | boolean | 是否达到95%危险（`ratio >= 0.95`） |
| `exhausted` | boolean | 是否已耗尽（`ratio >= 1.0`） |

阈值常量定义在[src/utils/constants.js](file:///e:/Harness_V1_0429/src/utils/constants.js)中：

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_TOKEN_BUDGET` | 1000000000 (1B) | 默认全局Token预算 |
| `TOKEN_BUDGET_WARNING_RATIO` | 0.8 | 80%预警比例 |
| `TOKEN_BUDGET_DANGER_RATIO` | 0.95 | 95%危险比例 |

事件发射规则（在`store()`中触发）：

```
store() → validate()
  → exhausted?  → emit('token-exhausted', { sessionId, tokensUsed, budget })
  → warning95?  → emit('token-warning-95', { sessionId, tokensUsed, budget })
  → warning80?  → emit('token-warning-80', { sessionId, tokensUsed, budget })
```

注意：三个事件互斥，优先级从高到低，只发射最高优先级的事件。

### 分类统计（Breakdown）

`addBreakdown(sessionId, category, amount)` 方法按类别记录Token消耗：

1. **ID验证**：sessionId和category都必须为非空字符串
2. **数值验证**：amount必须为非负有限数
3. **累加**：在`_sessionBreakdowns` Map中按sessionId→category结构累加

```javascript
tokenMgr.addBreakdown('session-1', 'input', 2000);
tokenMgr.addBreakdown('session-1', 'output', 1500);
tokenMgr.addBreakdown('session-1', 'toolCall', 500);

const breakdown = tokenMgr.getBreakdown('session-1');
// { input: 2000, output: 1500, toolCall: 500 }
```

| 方法 | 说明 |
|------|------|
| `addBreakdown(sessionId, category, amount)` | 按类别累加Token消耗 |
| `getBreakdown(sessionId)` | 获取指定会话的分类统计 |
| `getAllBreakdowns(sessionId?)` | 获取所有会话或指定会话的分类统计 |

### 全局统计

| 方法 | 说明 |
|------|------|
| `getTotal(budget?)` | 获取所有会话的总Token消耗、预算和使用比例 |
| `getUsage(sessionId, budget?)` | 获取指定会话的已用/剩余/比例 |
| `getStats(budget?)` | 获取全局统计（总消耗、最大会话、活跃会话数等） |
| `listSessions()` | 列出所有会话ID |

`getStats()` 返回结构：

```javascript
{
  total: 150000,          // 所有会话总Token消耗
  budget: 1000000000,     // 全局预算
  ratio: 0.00015,         // 总消耗比例
  maxSession: 80000,      // 单会话最大消耗
  activeSessions: 2,      // 有消耗的会话数
  totalSessions: 3,       // 总会话数
}
```

### Token格式化

`formatTokens(n)` 和 `parseFormatted(formatted)` 提供人类可读的Token数量表示：

```javascript
tokenMgr.formatTokens(1500000);    // '1.5M'
tokenMgr.formatTokens(2500);       // '3K'
tokenMgr.formatTokens(2500000000); // '2.50B'
tokenMgr.formatTokens(42);         // '42'

tokenMgr.parseFormatted('1.5M');   // 1500000
tokenMgr.parseFormatted('3K');     // 3000
tokenMgr.parseFormatted('2.50B');  // 2500000000
```

单位映射（`TOKEN_UNITS`）：

| 单位 | 倍率 |
|------|------|
| K | 1,000 |
| M | 1,000,000 |
| B | 1,000,000,000 |

### 优雅关机

TokenManager通过`withShutdown`混入实现优雅关机：

1. `_onShutdown()` 清空`_sessionTokens`和`_sessionBreakdowns`
2. 关机后`store()`抛出`SHUTDOWN`错误，`set()`和`addBreakdown()`静默返回

## ModelSelector详解

### 模型选择策略

`selectModel(skillId, context)` 方法实现三级选择策略：

```
1. Skill映射选择（优先级最高）
   → _skillModelMap[skillId] 存在？
   → 是：使用映射的模型，检查上下文调整
   → 否：进入下一级

2. 复杂度评分选择
   → context.complexityScore 存在？
   → 是：根据阈值选择层级模型
   → 否：进入下一级

3. 默认模型
   → 返回 _config.defaultModel
```

### Skill→模型映射

ModelSelector内置22个Skill的模型映射（`DEFAULT_SKILL_MODEL_MAP`）：

| Skill | 模型 | 层级 | 原因 |
|-------|------|------|------|
| brainstorming | gpt-4o | premium | 创意探索需要发散思维 |
| architecture-design | gpt-4o | premium | 架构决策影响全局，需要顶级推理 |
| bug-fix | gpt-4o | premium | 调试需要深度推理 |
| systematic-debugging | gpt-4o | premium | 复杂调试需要深度推理 |
| security-audit | gpt-4o | premium | 安全审计需要深度推理 |
| performance-optimization | gpt-4o | premium | 性能优化需要深度分析 |
| iterative-deepening | gpt-4o | premium | 深化推理需要顶级推理 |
| multi-agent-fusion | gpt-4o | premium | 多Agent融合需要顶级推理 |
| requirement-analysis | gpt-4o-mini | standard | 需求分析模式较固定 |
| tdd-implement | gpt-4o-mini | standard | TDD模式固定，中等推理即可 |
| module-development | gpt-4o-mini | standard | 编码需要理解但不需要顶级推理 |
| code-review | gpt-4o-mini | standard | 审查需要理解但模式较固定 |
| verification-before-completion | gpt-4o-mini | standard | 验证检查模式固定 |
| refactor-code | gpt-4o-mini | standard | 重构需要理解但模式较固定 |
| pair-chat | gpt-4o-mini | standard | 对话审查中等推理即可 |
| self-reflection | gpt-4o-mini | standard | 自反思中等推理即可 |
| dispatching-parallel | gpt-4o-mini | standard | 任务调度模式固定 |
| integration-testing | gpt-3.5-turbo | economy | 测试执行模式固定 |
| deployment | gpt-3.5-turbo | economy | 部署脚本模式固定 |
| documentation | gpt-3.5-turbo | economy | 文档生成不需要强推理 |
| auto-doc-generation | gpt-3.5-turbo | economy | 自动文档生成模式固定 |
| writing-skills | gpt-3.5-turbo | economy | 技能编写模式固定 |

### 复杂度评分选择

当Skill不在映射表中时，ModelSelector根据`complexityScore`（0~1）动态选择模型：

```javascript
const COMPLEXITY_FACTORS = {
  reasoning_depth:     { weight: 0.3,  signals: ['architecture', 'design', 'brainstorm', 'debug', 'analyze'] },
  output_length:       { weight: 0.2,  signals: ['document', 'implement', 'develop', 'refactor'] },
  error_sensitivity:   { weight: 0.25, signals: ['security', 'deploy', 'production', 'critical'] },
  pattern_complexity:  { weight: 0.25, signals: ['test', 'format', 'lint', 'review'] },
};
```

复杂度阈值与层级映射：

| 复杂度范围 | 层级 | 选择模型 |
|-----------|------|---------|
| `>= 0.7` | premium | `fallbackChain[0]`（gpt-4o） |
| `>= 0.3` | standard | `fallbackChain[1]`（gpt-4o-mini） |
| `< 0.3` | economy | `fallbackChain[2]`（gpt-3.5-turbo） |

### 上下文调整降级

`_applyContextAdjustments(result, context)` 在Skill映射选择后，根据上下文自动调整模型层级：

**1. 重试升级**（`context.isRetry`）

```
economy层模型失败 → 升级到standard层
reason: 'Upgraded for retry (economy failed)'
source: 'retry-upgrade'
```

**2. 简单任务降级**（`context.isSimpleTask === true`）

```
premium层 + 简单任务 → 降级到standard层
reason: 'Downgraded: simple task detected'
source: 'context-downgrade'
```

**3. 预算逼近降级**（`costBudgetPerSession` 配置时）

```
会话成本 > 80%预算 + premium层 → 降级到standard层
reason: 'Downgraded: session cost budget approaching limit'
source: 'budget-downgrade'
```

降级事件：当模型被降级时，发射`model-downgraded`事件：

```javascript
selector.on('model-downgraded', (evt) => {
  console.log(`模型降级: ${evt.from} → ${evt.to}, 原因: ${evt.reason}`);
});
```

### 用量记录与成本追踪

`recordUsage(skillId, model, tokens, cost)` 方法记录每次模型使用的Token和成本：

```javascript
selector.recordUsage('brainstorming', 'gpt-4o', 5000, 0.05);
selector.recordUsage('tdd-implement', 'gpt-4o-mini', 3000, 0.0045);
```

`getStats()` 返回全局统计：

```javascript
{
  totalTokens: 8000,
  totalCost: 0.0545,
  byModel: {
    'gpt-4o': { count: 1, tokens: 5000, cost: 0.05 },
    'gpt-4o-mini': { count: 1, tokens: 3000, cost: 0.0045 },
  },
  savingsVsAllPremium: 89.1,  // 相比全部使用premium节省的百分比
}
```

### 成本估算

`getCostEstimate(skillId)` 方法预估Skill的模型成本：

```javascript
const estimate = selector.getCostEstimate('brainstorming');
// {
//   model: 'gpt-4o',
//   tier: 'premium',
//   costMultiplier: 1.0,
//   estimatedCostPer1kTokens: 0.01
// }

const estimate = selector.getCostEstimate('integration-testing');
// {
//   model: 'gpt-3.5-turbo',
//   tier: 'economy',
//   costMultiplier: 0.02,
//   estimatedCostPer1kTokens: 0.0002
// }
```

### 健康检查

`isHealthy()` 方法检查用量统计是否接近容量上限（`_maxUsageStats = 500`），超过时返回`false`。

## EmbeddingService详解

### 文本向量化

`embed(text)` 方法将文本转换为固定维度的向量：

1. **输入验证**：text必须为非空字符串且长度不超过100,000字符
2. **缓存检查**：若启用缓存且命中，直接返回缓存结果
3. **Provider分发**：根据配置选择向量化方式
4. **统计更新**：更新总嵌入数、缓存命中/未命中数、平均耗时
5. **缓存写入**：将结果写入LRU缓存
6. **事件发射**：触发`embedding-created`事件

```javascript
const embedding = embedSvc.embed('架构设计需要深度推理');
// Float64Array(128) — 128维向量
```

### Provider体系

| Provider | 常量 | 说明 |
|----------|------|------|
| `local` | `PROVIDERS.LOCAL` | 本地哈希向量化（默认），基于字符哈希和bigram特征 |
| `openai` | `PROVIDERS.OPENAI` | OpenAI Embedding API（当前回退到local） |
| `precomputed` | `PROVIDERS.PRECOMPUTED` | 预计算向量（当前回退到local） |

### 本地向量化算法

`_embedLocal(text)` 实现基于哈希的本地向量化：

1. **文本规范化**：转小写、去除非字母数字和中文字符以外的字符
2. **种子生成**：遍历每个字符，使用DJB2哈希变体生成初始种子
3. **向量填充**：使用线性同余生成器（LCG）从种子生成128维向量
4. **Bigram增强**：提取文本的所有bigram（相邻双字符），对每个bigram哈希到向量维度并增加0.3权重
5. **L2归一化**：将向量归一化为单位长度

```
文本 → 规范化 → 字符哈希种子 → LCG填充 → Bigram增强 → L2归一化 → 向量
```

该算法保证：
- 相同文本生成相同向量（确定性）
- 相似文本生成方向接近的向量（bigram贡献）
- 向量为单位长度（L2归一化后模为1）

### 余弦相似度

`cosineSimilarity(a, b)` 计算两个向量的余弦相似度：

```
cos(θ) = (a · b) / (||a|| × ||b||)
```

- 输入：两个等长向量
- 输出：[-1, 1]范围的相似度值，1表示完全相同，0表示正交
- 边界处理：空向量、长度不匹配、零向量均返回0

```javascript
const vecA = embedSvc.embed('架构设计');
const vecB = embedSvc.embed('系统设计');
const sim = embedSvc.cosineSimilarity(vecA, vecB);
// 0.72 — 语义相近
```

### 相似度搜索

`findSimilar(queryVector, candidateVectors, options)` 从候选向量中查找与查询向量最相似的Top-K结果：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `queryVector` | number[] | — | 查询向量 |
| `candidateVectors` | Array | — | 候选向量数组，元素为`{ vector }`或纯数组 |
| `options.topK` | number | 5 | 返回的最大结果数 |
| `options.minSimilarity` | number | 0.5 (`DEFAULT_CONFIDENCE`) | 最低相似度阈值 |

```javascript
const query = embedSvc.embed('TDD测试编写');
const candidates = skills.map(s => ({ vector: embedSvc.embed(s.description), id: s.id }));
const results = embedSvc.findSimilar(query, candidates, { topK: 3, minSimilarity: 0.6 });
// [{ index: 2, similarity: 0.85 }, { index: 7, similarity: 0.73 }]
```

### 批量处理

`embedBatch(texts)` 方法支持批量文本向量化：

- 自动按`maxBatchSize`（默认32）分批处理
- 每个文本独立调用`embed()`，享受缓存加速
- 返回与输入顺序对应的向量数组

```javascript
const vectors = embedSvc.embedBatch(['文本1', '文本2', '文本3']);
// [Float64Array(128), Float64Array(128), Float64Array(128)]
```

### 缓存机制

EmbeddingService使用LRU缓存避免重复计算：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `cacheEnabled` | true | 是否启用缓存 |
| `cacheMaxSize` | 500 | LRU缓存最大条目数 |

`getStats()` 返回缓存统计：

```javascript
{
  totalEmbeddings: 150,
  cacheHits: 120,
  cacheMisses: 30,
  avgTimeMs: 0.5,
  cacheSize: 45,
  provider: 'local',
  dimensions: 128,
}
```

## 配置说明

### config.json中的模型相关配置

```json
{
  "token_budget": 1000000000,
  "model_selector_config": {
    "defaultModel": "gpt-4o",
    "fallbackChain": ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
    "enableAutoDowngrade": true,
    "costBudgetPerSession": null,
    "complexityThreshold": {
      "premium": 0.7,
      "standard": 0.3
    },
    "skillModelMap": {},
    "modelTiers": {
      "premium": { "models": ["gpt-4o", "claude-3-opus", "deepseek-v3"], "costMultiplier": 1.0 },
      "standard": { "models": ["gpt-4o-mini", "claude-3-sonnet"], "costMultiplier": 0.15 },
      "economy": { "models": ["gpt-3.5-turbo", "deepseek-chat"], "costMultiplier": 0.02 }
    }
  },
  "embedding_config": {
    "provider": "local",
    "dimensions": 128,
    "maxBatchSize": 32,
    "cacheEnabled": true,
    "cacheMaxSize": 500
  }
}
```

### TokenManager配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `defaultBudget` | number | 1000000000 | 全局Token预算 |
| `maxSessions` | number | 1000 | 最大会话数量，超出时驱逐最早会话 |

### ModelSelector配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `defaultModel` | string | `'gpt-4o'` | 默认模型 |
| `fallbackChain` | string[] | `['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo']` | 降级链，按优先级排列 |
| `enableAutoDowngrade` | boolean | true | 是否启用上下文自动降级 |
| `costBudgetPerSession` | number\|null | null | 单会话成本预算，null表示不限制 |
| `complexityThreshold.premium` | number | 0.7 | premium层复杂度阈值 |
| `complexityThreshold.standard` | number | 0.3 | standard层复杂度阈值 |
| `skillModelMap` | object | {} | 自定义Skill→模型映射，合并到默认映射 |
| `modelTiers` | object | 见上表 | 模型分层定义，合并到默认分层 |

### EmbeddingService配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `provider` | string | `'local'` | 向量化Provider（local/openai/precomputed） |
| `dimensions` | number | 128 | 向量维度 |
| `maxBatchSize` | number | 32 | 批量处理每批最大数量 |
| `cacheEnabled` | boolean | true | 是否启用LRU缓存 |
| `cacheMaxSize` | number | 500 | LRU缓存最大条目数 |

## 使用示例

### Token预算管理

```javascript
const TokenManager = require('./src/runtime/model/token-manager');

const tokenMgr = new TokenManager({ defaultBudget: 1000000 });

tokenMgr.on('token-warning-80', (evt) => {
  console.log(`预警: 会话${evt.sessionId}已使用${evt.tokensUsed}/${evt.budget}`);
});
tokenMgr.on('token-warning-95', (evt) => {
  console.log(`危险: 即将耗尽，切换低价模型`);
});
tokenMgr.on('token-exhausted', (evt) => {
  console.log(`耗尽: 暂停所有任务`);
});

tokenMgr.store('session-1', 500000);
tokenMgr.addBreakdown('session-1', 'input', 300000);
tokenMgr.addBreakdown('session-1', 'output', 200000);

const usage = tokenMgr.getUsage('session-1');
// { used: 500000, budget: 1000000, remaining: 500000, ratio: 0.5 }

const breakdown = tokenMgr.getBreakdown('session-1');
// { input: 300000, output: 200000 }

console.log(tokenMgr.formatTokens(usage.used));
// '500K'
```

### 模型选择与降级

```javascript
const ModelSelector = require('./src/runtime/model/model-selector');

const selector = new ModelSelector({
  enableAutoDowngrade: true,
  costBudgetPerSession: 10.0,
});

selector.on('model-downgraded', (evt) => {
  console.log(`降级: ${evt.skillId} ${evt.from} → ${evt.to} (${evt.reason})`);
});

const result1 = selector.selectModel('brainstorming');
// { model: 'gpt-4o', tier: 'premium', reason: '创意探索需要发散思维', source: 'skill-mapping' }

const result2 = selector.selectModel('integration-testing');
// { model: 'gpt-3.5-turbo', tier: 'economy', reason: '测试执行模式固定', source: 'skill-mapping' }

const result3 = selector.selectModel('brainstorming', { isSimpleTask: true });
// { model: 'gpt-4o-mini', tier: 'standard', reason: 'Downgraded: simple task detected', source: 'context-downgrade' }

const result4 = selector.selectModel('unknown-skill', { complexityScore: 0.85 });
// { model: 'gpt-4o', tier: 'premium', reason: 'Selected by complexity score: 0.85', source: 'complexity-based' }

selector.recordUsage('brainstorming', 'gpt-4o', 5000, 0.05);
const stats = selector.getStats();
// { totalTokens: 5000, totalCost: 0.05, savingsVsAllPremium: 0, byModel: {...} }
```

### 文本向量化与相似度搜索

```javascript
const EmbeddingService = require('./src/runtime/model/embedding-service');

const embedSvc = new EmbeddingService({ dimensions: 128, cacheEnabled: true });

const vec1 = embedSvc.embed('架构设计需要深度推理');
const vec2 = embedSvc.embed('系统设计要求高级分析');
const vec3 = embedSvc.embed('部署脚本模式固定');

const sim12 = embedSvc.cosineSimilarity(vec1, vec2);
const sim13 = embedSvc.cosineSimilarity(vec1, vec3);
// sim12 > sim13 — 前两者语义更接近

const results = embedSvc.findSimilar(vec1, [
  { vector: vec2, id: 'skill-1' },
  { vector: vec3, id: 'skill-2' },
], { topK: 2, minSimilarity: 0.3 });

const batchVectors = embedSvc.embedBatch(['文本A', '文本B', '文本C']);

const stats = embedSvc.getStats();
// { totalEmbeddings: 6, cacheHits: 0, cacheMisses: 6, avgTimeMs: 0.3, ... }
```

### 三模块协同使用

```javascript
const TokenManager = require('./src/runtime/model/token-manager');
const ModelSelector = require('./src/runtime/model/model-selector');
const EmbeddingService = require('./src/runtime/model/embedding-service');

const tokenMgr = new TokenManager({ defaultBudget: 1000000000 });
const selector = new ModelSelector({ enableAutoDowngrade: true });
const embedSvc = new EmbeddingService();

function executeSkill(sessionId, skillId, inputText) {
  const budget = tokenMgr.validate(sessionId);
  if (budget.exhausted) {
    throw new Error('Token预算已耗尽');
  }

  const context = {
    isSimpleTask: budget.warning95,
    sessionId,
  };
  const { model, tier, reason } = selector.selectModel(skillId, context);

  const queryVec = embedSvc.embed(inputText);

  console.log(`执行 ${skillId}: model=${model}, tier=${tier}, reason=${reason}`);
  console.log(`预算状态: ${tokenMgr.formatTokens(budget.tokensUsed)} / ${tokenMgr.formatTokens(budget.budget)}`);

  return { model, tier, queryVec };
}

tokenMgr.on('token-warning-95', () => {
  console.log('Token使用达95%，后续任务将自动降级模型');
});

executeSkill('session-1', 'brainstorming', '设计一个新的缓存策略');
```

## 与其他子系统的交互

### 与SessionManager交互

SessionManager是Token追踪的上层入口。`addTokenUsage()`在会话层面记录Token消耗，内部可委托TokenManager进行精细化的预算管理和分类统计。TokenManager发射的`token-warning-80/95`和`token-exhausted`事件供SessionManager转发为`budget-warning`事件。

```
用户操作 → SessionManager.addTokenUsage()
  → TokenManager.store() → validate()
  → 预算预警 → SessionManager发射 budget-warning
  → ModelSelector降级决策
```

### 与DeepeningOrchestrator交互

深化推理子系统是Token消耗大户。`TokenAwareDeepening`模块读取TokenManager的预算状态，在Token紧张时自动降低深化深度或提前终止迭代。ModelSelector为`iterative-deepening` Skill选择premium层模型，确保深化推理质量。

```
DeepeningOrchestrator → TokenAwareDeepening
  → TokenManager.getUsage() → 预算充足？→ 继续深化
  → 预算紧张？→ 降低深度 / 提前收敛
  → ModelSelector.selectModel('iterative-deepening') → gpt-4o
```

### 与SkillRouter交互

SkillRouter使用EmbeddingService进行语义匹配。当用户消息与Skill描述的文本相似度超过阈值时，自动激活对应Skill。ModelSelector为Skill执行选择合适的模型层级。

```
用户消息 → EmbeddingService.embed()
  → cosineSimilarity(queryVec, skillVec)
  → 相似度 > DEFAULT_CONFIDENCE → 激活Skill
  → ModelSelector.selectModel(skillId) → 选择模型
  → 执行Skill → TokenManager.store() → 记录消耗
```

### 与ContextCompressionEngine交互

上下文压缩引擎在Token使用率达到压缩阈值时触发。压缩决策依赖TokenManager的预算状态，压缩后的Token节省量通过TokenManager记录。

```
TokenManager.validate() → warning80?
  → ContextCompressionEngine.compress()
  → 分类: keep / summarize / discard
  → TokenManager.store() → 记录压缩节省的Token
```

### 与CausalVectorIndex交互

因果子系统中的`CausalVectorIndex`使用EmbeddingService进行向量相似度搜索，实现因果事件的语义检索。EmbeddingService为因果向量索引提供向量化能力和相似度计算。

```
CausalVectorIndex → EmbeddingService.embed()
  → 存储因果事件向量
  → EmbeddingService.findSimilar() → 检索相关因果事件
```

## 事件列表

### TokenManager事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `token-warning-80` | Token使用达80% | `{ sessionId, tokensUsed, budget }` |
| `token-warning-95` | Token使用达95% | `{ sessionId, tokensUsed, budget }` |
| `token-exhausted` | Token预算耗尽 | `{ sessionId, tokensUsed, budget }` |

### ModelSelector事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `model-downgraded` | 模型被自动降级 | `{ skillId, from, to, reason }` |
| `usage-recorded` | 记录模型使用 | `{ skillId, model, tokens, cost }` |

### EmbeddingService事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `embedding-created` | 向量化完成 | `{ textLength, dimensions, timeMs }` |

## 交叉引用

- [[核心功能-会话管理与检查点恢复]] — SessionManager的Token预算追踪与TokenManager协作
- [[核心功能-上下文压缩引擎]] — 基于Token预算状态的压缩触发决策
- [[核心功能-Skill自动路由机制]] — SkillRouter使用EmbeddingService进行语义匹配
- [[核心功能-深化推理引擎]] — TokenAwareDeepening的预算约束深化策略
- [[核心功能-多Agent协作流程]] — 多Agent场景下的模型选择与Token分配
- [[模块详解-因果子系统模块]] — CausalVectorIndex的向量相似度检索
- [[模块详解-上下文管理模块]] — 上下文压缩的Token感知决策
