# 模块详解-CostAwareRouter成本感知路由

> 版本：2.73.4 | 文件：src/runtime/model/cost-aware-router.js | 行数：~469行

---

## 模块概述

CostAwareRouter是Harness多Agent框架中的成本感知技能路由引擎，基于OpenSquilla SquillaRouter设计理念，通过多层信号分析（代码块数量、消息长度、关键词密度、错误恢复需求、多步骤复杂度）将请求路由到最经济的模型层级，同时追踪每个技能执行的Token消耗与成本。

核心能力：
- **智能模型路由**：简单任务→小模型（成本系数0.02），复杂任务→大模型（成本系数1.0），节省60-90% Token
- **按技能成本追踪**：每个技能执行后记录Token使用量与预估成本，支持按技能、按会话、按全局维度查询
- **上下文缓存感知**：标记可缓存技能，跨轮次复用上下文，减少重复加载开销
- **预算预警与自动降级**：80%预警、95%严重告警，支持自动降级到低成本模型

该模块位于模型子系统，与SkillRouter（技能路由）、TokenManager（Token预算管理）紧密协作，构成成本控制体系的核心组件。

---

## 类定义

```javascript
class CostAwareRouter extends EventEmitter { ... }
```

通过`withShutdown`混入后导出，自动获得`shutdown()`方法和`_onShutdown()`生命周期钩子。

### 静态属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `CostAwareRouter.MODEL_TIERS` | Object | 模型层级定义：SMALL/MEDIUM/LARGE，含成本系数与描述 |
| `CostAwareRouter.TOKEN_PRICES` | Object | Token单价表（美元/1K tokens），分输入/输出 |
| `CostAwareRouter.CACHEABLE_SKILLS` | Set\<string\> | 可缓存技能ID集合 |
| `CostAwareRouter.COMPLEXITY_SIGNALS` | Object | 5维复杂度信号权重配置 |
| `CostAwareRouter.HIGH_COMPLEXITY_KEYWORDS` | Array\<string\> | 高复杂度关键词列表 |
| `CostAwareRouter.LOW_COMPLEXITY_KEYWORDS` | Array\<string\> | 低复杂度关键词列表 |

---

## 架构集成

CostAwareRouter在请求处理流程中的位置：

```
用户请求 → SkillRouter.match() → 匹配技能列表
                    ↓
           CostAwareRouter.analyzeComplexity() → 选择模型层级
                    ↓
           TokenManager.store() → 记录Token消耗
                    ↓
           CostAwareRouter.recordUsage() → 按技能追踪成本
                    ↓
           SkillRouter.loadL2() → 加载技能L2缓存
                    ↓
           执行技能 → 返回结果
```

与SkillRouter的关系：SkillRouter负责按语义匹配最相关的技能，CostAwareRouter负责为匹配到的技能选择最经济的模型层级。两者互补——SkillRouter决定"做什么"，CostAwareRouter决定"用什么模型做"。

与TokenManager的关系：TokenManager管理全局Token预算和会话级消耗追踪，CostAwareRouter在此基础上增加了按技能维度的成本追踪、缓存命中统计和模型层级选择。两者通过事件机制协同工作。

---

## 复杂度分析：5维信号模型

CostAwareRouter通过5个信号维度计算请求的复杂度评分（0-1），加权求和后映射到三级模型层级。

### 信号权重配置

```javascript
const COMPLEXITY_SIGNALS = {
  CODE_BLOCKS:    { weight: 0.15, threshold: 3 },
  MESSAGE_LENGTH: { weight: 0.2,  shortThreshold: 200, longThreshold: 2000 },
  KEYWORD_DENSITY:{ weight: 0.25 },
  ERROR_RECOVERY: { weight: 0.2 },
  MULTI_STEP:     { weight: 0.2 },
};
```

### 信号维度详解

| 维度 | 权重 | 评分逻辑 | 说明 |
|------|------|---------|------|
| **代码块数量**（codeBlocks） | 0.15 | 代码块数/阈值3，上限1.0 | 代码块越多通常意味着任务越复杂 |
| **消息长度**（messageLength） | 0.20 | ≤200字符→0，≥2000字符→1，中间线性插值 | 长消息通常包含更复杂的指令 |
| **关键词密度**（keywordDensity） | 0.25 | 高复杂度词命中×0.25 - 低复杂度词命中×0.15，夹紧到[0,1] | 架构/安全/调试等词提升分数，格式化/文档等词降低分数 |
| **错误恢复**（errorRecovery） | 0.20 | 工具调用数/5，上限1.0 | 工具调用越多，执行链路越复杂，错误恢复需求越高 |
| **多步骤**（multiStep） | 0.20 | 多步骤指示词命中数/4，上限1.0 | "首先…然后…最后…"等模式表明多阶段任务 |

### 复杂度→模型层级映射

| 复杂度评分 | 模型层级 | 典型任务 |
|-----------|---------|---------|
| ≥ 0.7 | LARGE | 架构设计、安全审计、深度推理 |
| 0.3 ~ 0.7 | MEDIUM | 编码实现、代码审查、测试执行 |
| < 0.3 | SMALL | 格式化、简单查询、文档生成 |

---

## 模型层级与成本

### 模型层级定义

```javascript
const MODEL_TIERS = {
  SMALL:  { name: 'small',  costMultiplier: 0.02, description: '轻量级任务：格式化、简单查询、文档生成' },
  MEDIUM: { name: 'medium', costMultiplier: 0.15, description: '中等任务：编码实现、代码审查、测试执行' },
  LARGE:  { name: 'large',  costMultiplier: 1.0,  description: '复杂任务：架构设计、安全审计、深度推理' },
};
```

### Token单价表（美元/1K tokens）

| 模型层级 | 输入价格 | 输出价格 | 相对成本 |
|---------|---------|---------|---------|
| SMALL | $0.00015 | $0.0006 | 基准（×1） |
| MEDIUM | $0.001 | $0.004 | 约×7 |
| LARGE | $0.01 | $0.03 | 约×50-67 |

**成本节省原理**：假设一个简单格式化任务需要1000输入+500输出Token：
- 路由到LARGE：$(1000/1000×0.01) + (500/1000×0.03) = $0.025
- 路由到SMALL：$(1000/1000×0.00015) + (500/1000×0.0006) = $0.00045
- **节省：98.2%**

---

## 可缓存技能集合

以下技能标记为可缓存，其上下文可跨轮次复用，无需每次重新加载：

```javascript
const CACHEABLE_SKILLS = new Set([
  'code-review',
  'verification-before-completion',
  'integration-testing',
  'documentation',
  'auto-doc-generation',
  'tdd-implement',
  'module-development',
  'refactor-code',
]);
```

缓存需同时满足：`enableCache`配置为`true`且技能ID在`CACHEABLE_SKILLS`集合中。

---

## 构造函数

### `new CostAwareRouter(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options.maxHistory` | number | 否 | 500 | 最大使用历史记录数（FIFO淘汰） |
| `options.costBudgetPerSession` | number\|null | 否 | null | 会话成本预算（美元），null表示不设限 |
| `options.costWarningThreshold` | number | 否 | 0.8 | 成本预警阈值（80%） |
| `options.costCriticalThreshold` | number | 否 | 0.95 | 成本严重阈值（95%） |
| `options.enableCache` | boolean | 否 | true | 是否启用上下文缓存 |
| `options.enableAutoDowngrade` | boolean | 否 | true | 是否启用自动降级 |

构造时初始化内部状态：
- `_usageHistory`：使用历史Map（skillId_timestamp → 记录）
- `_skillCosts`：技能成本统计Map（skillId → 统计数据）
- `_cacheHits` / `_cacheMisses`：缓存命中/未命中计数
- `_totalCost` / `_sessionCost`：全局/会话累计成本
- `_routingDecisions`：路由决策次数
- `_costSaved`：通过缓存节省的累计成本
- `_downgrades`：自动降级次数

---

## 核心方法

### `analyzeComplexity(request)`

分析请求复杂度并返回推荐的模型层级。这是路由决策的核心入口方法。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `request.message` | string | 是 | 用户消息内容 |
| `request.skillId` | string | 否 | 关联的技能ID（用于缓存判断） |
| `request.toolCalls` | Array\<string\> | 否 | 工具调用列表（影响错误恢复评分） |
| `request.metadata` | Object | 否 | 附加元数据 |

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `tier` | string | 推荐模型层级：`'small'` / `'medium'` / `'large'` |
| `complexityScore` | number | 加权复杂度评分（0-1，保留3位小数） |
| `factors` | Object | 5维信号分解评分：`{ codeBlocks, messageLength, keywordDensity, errorRecovery, multiStep }` |
| `estimatedCost` | number | 预估成本（美元，保留4位小数） |
| `cacheable` | boolean | 是否可缓存（需skillId在CACHEABLE_SKILLS中且enableCache为true） |

**事件触发**：`routing-decision`

**预估成本公式**：`estimatedTokens = message.length × 0.4 + 500`，然后按对应层级Token单价计算输入+输出成本。

---

### `recordUsage(skillId, usage)`

记录技能执行的Token消耗。应在每次技能执行完成后调用。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skillId` | string | 是 | 技能ID，必须为非空字符串 |
| `usage.inputTokens` | number | 是 | 输入Token数 |
| `usage.outputTokens` | number | 是 | 输出Token数 |
| `usage.modelTier` | string | 否 | 实际使用的模型层级，默认`'medium'` |
| `usage.cacheHit` | boolean | 否 | 是否命中缓存，默认`false` |

**返回值**：`Object|null` — 本次消耗记录，skillId或usage无效时返回null

| 字段 | 类型 | 说明 |
|------|------|------|
| `skillId` | string | 技能ID |
| `inputTokens` | number | 输入Token数 |
| `outputTokens` | number | 输出Token数 |
| `totalTokens` | number | 总Token数 |
| `modelTier` | string | 使用的模型层级 |
| `cost` | number | 本次消耗成本（美元，4位小数） |
| `cacheHit` | boolean | 是否命中缓存 |
| `timestamp` | number | 时间戳 |

**副作用**：
1. 更新`_skillCosts`中该技能的累计统计
2. 累加`_sessionCost`和`_totalCost`
3. 若cacheHit为true，累加`_cacheHits`和`_costSaved`
4. 若cacheHit为false，累加`_cacheMisses`
5. 维护`_usageHistory`（FIFO淘汰至maxHistory）
6. 若设置了`costBudgetPerSession`，自动触发预算检查

**事件触发**：`token-usage`，以及可能触发`cost-threshold`

---

### `getSkillCosts(skillId)`

获取指定技能的成本统计。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skillId` | string | 是 | 技能ID |

**返回值**：`Object|null` — 不存在时返回null

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalCalls` | number | 总调用次数 |
| `totalTokens` | number | 总Token消耗 |
| `totalCost` | number | 总成本（美元） |
| `cacheHits` | number | 缓存命中次数 |

---

### `getCostSummary()`

获取所有技能的成本统计摘要，按总成本降序排列。

**返回值**：`Array<Object>`

| 字段 | 类型 | 说明 |
|------|------|------|
| `skillId` | string | 技能ID |
| `totalCalls` | number | 总调用次数 |
| `totalTokens` | number | 总Token消耗 |
| `totalCost` | number | 总成本（美元，4位小数） |
| `avgCostPerCall` | number | 平均每次调用成本（美元，4位小数） |
| `cacheHitRate` | number | 缓存命中率（0-1） |

---

### `getStats()`

获取全局成本统计。

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalCost` | number | 全局累计成本（美元） |
| `sessionCost` | number | 当前会话成本（美元） |
| `costSaved` | number | 通过缓存节省的累计成本（美元） |
| `totalCalls` | number | 总调用次数（缓存命中+未命中） |
| `cacheHits` | number | 缓存命中次数 |
| `cacheMisses` | number | 缓存未命中次数 |
| `cacheHitRate` | number | 缓存命中率（0-1） |
| `routingDecisions` | number | 路由决策总次数 |
| `downgrades` | number | 自动降级次数 |
| `skillCount` | number | 已追踪的技能数量 |
| `estimatedSavingsPercent` | number | 预估节省百分比（costSaved/(totalCost+costSaved)） |

---

### `isCacheable(skillId)`

判断指定技能是否可缓存。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skillId` | string | 是 | 技能ID |

**返回值**：`boolean` — 需同时满足`enableCache=true`且skillId在`CACHEABLE_SKILLS`中

---

### `recordCacheHit(skillId, tokensSaved)`

记录缓存命中事件，累加缓存命中计数和节省的成本估算。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skillId` | string | 是 | 技能ID |
| `tokensSaved` | number | 是 | 节省的Token数 |

**副作用**：`_cacheHits++`，并按MEDIUM层级输入价格估算节省成本累加到`_costSaved`。

---

### `resetSessionCost()`

重置当前会话成本（保留历史统计和全局成本）。

**副作用**：`_sessionCost = 0`

---

## 预算管理

### `_checkBudget()`（私有方法）

在`recordUsage()`中自动调用，检查当前会话成本是否接近或超过预算阈值。

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | string | `'ok'` / `'warning'` / `'critical'` |
| `cost` | number | 当前会话成本（美元） |
| `budget` | number | 预算上限（美元） |
| `remaining` | number | 剩余预算（美元） |
| `ratio` | number | 使用比率（0-1+） |

### 预算阈值体系

| 阈值 | 配置项 | 状态 | 事件 | 建议动作 |
|------|--------|------|------|---------|
| 80% | `costWarningThreshold` | warning | `cost-threshold { level: 'warning' }` | 提醒用户成本较高，建议优化 |
| 95% | `costCriticalThreshold` | critical | `cost-threshold { level: 'critical' }` | 自动降级到低成本模型，暂停非关键任务 |

预算检查仅在`costBudgetPerSession`为非null正值时生效。

---

## 事件

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `routing-decision` | `analyzeComplexity()`调用后 | `{ skillId, tier, complexityScore, estimatedCost, cacheable, timestamp }` |
| `token-usage` | `recordUsage()`调用后 | `{ skillId, inputTokens, outputTokens, totalTokens, modelTier, cost, cacheHit, timestamp }` |
| `cost-threshold` | 预算检查触发预警 | `{ level: 'warning'\|'critical', ratio, cost, budget }` |

---

## 优雅关闭

`shutdown()`触发时（通过`withShutdown`混入的`_onShutdown()`钩子）：

1. 清空`_usageHistory` Map
2. 清空`_skillCosts` Map
3. 重置`_cacheHits` / `_cacheMisses` 为0
4. 重置`_totalCost` / `_sessionCost` / `_costSaved` 为0
5. 重置`_routingDecisions` / `_downgrades` 为0

所有方法在调用前通过`this.guardShutdown()`检查，关机后调用将抛出`ShutdownError`。

---

## 高/低复杂度关键词

### 高复杂度关键词（命中提升复杂度评分）

```javascript
const HIGH_COMPLEXITY_KEYWORDS = [
  'architecture', '架构', 'design', '设计', 'security', '安全',
  'debug', '调试', 'performance', '性能', 'optimize', '优化',
  'refactor', '重构', 'deep', '深化', 'analyze', '分析',
  'vulnerability', '漏洞', 'audit', '审计', 'deploy', '部署',
];
```

每个命中使`keywordDensity`评分+0.25，上限1.0。

### 低复杂度关键词（命中降低复杂度评分）

```javascript
const LOW_COMPLEXITY_KEYWORDS = [
  'format', '格式化', 'lint', 'lint', 'document', '文档',
  'comment', '注释', 'test', '测试', 'simple', '简单',
  'quick', '快速', 'check', '检查', 'list', '列表',
];
```

每个命中使`keywordDensity`评分-0.15，下限0.5（即最多抵消0.5分）。

---

## 使用示例

### 基础用法：请求路由与成本追踪

```javascript
const CostAwareRouter = require('./src/runtime/model/cost-aware-router');

const router = new CostAwareRouter({
  costBudgetPerSession: 0.5,   // 会话预算 $0.50
  enableCache: true,
  enableAutoDowngrade: true,
});

// 分析请求复杂度，选择模型层级
const decision = router.analyzeComplexity({
  message: '请格式化这段代码并添加注释',
  skillId: 'code-review',
  toolCalls: ['read_file', 'edit_file'],
});
console.log(decision);
// { tier: 'small', complexityScore: 0.15, factors: {...}, estimatedCost: 0.0004, cacheable: true }

// 技能执行完成后记录消耗
router.recordUsage('code-review', {
  inputTokens: 1500,
  outputTokens: 800,
  modelTier: decision.tier,
  cacheHit: decision.cacheable,
});
```

### 按技能查询成本

```javascript
// 查询单个技能的成本
const crCosts = router.getSkillCosts('code-review');
console.log(crCosts);
// { totalCalls: 5, totalTokens: 11500, totalCost: 0.023, cacheHits: 3 }

// 获取所有技能成本排名
const summary = router.getCostSummary();
console.log('最贵技能Top 3:');
summary.slice(0, 3).forEach(s => {
  console.log(`  ${s.skillId}: $${s.totalCost} (${s.totalCalls}次, 命中率${s.cacheHitRate})`);
});
```

### 全局统计

```javascript
const stats = router.getStats();
console.log(`全局成本: $${stats.totalCost}`);
console.log(`会话成本: $${stats.sessionCost}`);
console.log(`缓存节省: $${stats.costSaved} (${stats.estimatedSavingsPercent}%)`);
console.log(`缓存命中率: ${(stats.cacheHitRate * 100).toFixed(1)}%`);
console.log(`路由决策: ${stats.routingDecisions}次`);
console.log(`已追踪技能: ${stats.skillCount}个`);
```

### 预算预警监听

```javascript
router.on('cost-threshold', (data) => {
  if (data.level === 'warning') {
    console.warn(`成本预警: 已用 $${data.cost} / $${data.budget} (${(data.ratio * 100).toFixed(0)}%)`);
  } else if (data.level === 'critical') {
    console.error(`成本严重告警! 已用 $${data.cost} / $${data.budget}`);
    // 触发自动降级策略
  }
});

router.on('routing-decision', (data) => {
  console.log(`路由决策: ${data.skillId} → ${data.tier} (复杂度 ${data.complexityScore})`);
});

router.on('token-usage', (data) => {
  console.log(`Token消耗: ${data.skillId} → ${data.totalTokens} tokens, $${data.cost}`);
});
```

### 与SkillRouter集成

```javascript
const SkillRouter = require('./src/runtime/skill/skill-router');
const CostAwareRouter = require('./src/runtime/model/cost-aware-router');

const skillRouter = new SkillRouter(projectRoot);
const costRouter = new CostAwareRouter({ costBudgetPerSession: 1.0 });

// 路由决策监听 → 按成本选择模型
costRouter.on('cost-threshold', ({ level }) => {
  if (level === 'critical') {
    // 通知SkillRouter切换到低价模型路径
    skillRouter.setModelTier('small');
  }
});

// 技能匹配 → 复杂度分析 → 选择模型层级
const matches = skillRouter.match({ userMessage, agent, completedSkills });
if (matches.length > 0) {
  const decision = costRouter.analyzeComplexity({
    message: userMessage,
    skillId: matches[0].skill_id,
    toolCalls: extractToolCalls(userMessage),
  });
  // 使用 decision.tier 选择对应模型执行
}
```

### 重置会话

```javascript
// 会话结束时重置（保留全局统计）
router.resetSessionCost();
console.log(router.getStats().sessionCost); // 0
```

---

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/safe-assign`（`mergeConfig`配置合并）
- 依赖：`../../utils/debug-logger`（`debug`调试日志）
- 依赖：`../../utils/shutdown-mixin`（`withShutdown`优雅关闭混入）
- 被依赖：SkillRouter（技能路由，模型层级选择）
- 被依赖：TokenManager（Token预算管理，成本追踪补充）
- 被依赖：Web Dashboard（仪表盘，成本可视化展示）

---

## 相关文档

- [模块详解-TokenManager模块](模块详解-TokenManager模块.md)
- [模块详解-SkillRouter模块](模块详解-SkillRouter模块.md)
- [模块详解-模型子系统](模块详解-模型子系统.md)
- [核心功能-成本控制机制](../core/核心功能-成本控制机制.md)