# 模块详解-EvolutionTriggerOrchestrator进化触发编排器

> 版本：2.73.4 | 文件：src/runtime/skill/evolution-trigger-orchestrator.js | 行数：288行

---

## 模块定位

EvolutionTriggerOrchestrator 是技能进化触发编排器，负责接收多种触发信号（任务完成、质量退化、指标告警），评估进化决策（进化/跳过/延迟/退役），并编排执行对应的进化或退役流程。融合自 Claude Skill Evolution 的触发-评估-执行三层模型，通过严重度分类、冷却防抖、并发控制和Token预算管理，确保技能进化过程有序、可控、不过载。

作为技能子系统的进化触发中枢，它承担了"运行时信号→进化决策→进化执行"的编排角色，将任务失败、质量下降和健康指标异常等运行时信号统一转化为可操作的进化动作。

## 架构角色

```
                        EvolutionTriggerOrchestrator
                    ┌──────────────────────────────────────┐
  任务完成信号 ────→│  onTaskCompleted()                    │
  质量退化信号 ────→│  onQualityDegradation()               │──→ SkillEvolver.evolve()
  指标告警信号 ────→│  onMetricAlert()                      │──→ SkillImprovementLoop.recordLearning()
                    │                                      │──→ SkillRetirementManager.retireSkill()
                    │  ┌──────────────────────────────┐    │
                    │  │ _evaluateEvolutionDecision()  │    │
                    │  │  CRITICAL → EVOLVE / RETIRE   │    │
                    │  │  HIGH     → EVOLVE            │    │
                    │  │  MEDIUM   → EVOLVE / DEFER    │    │
                    │  │  LOW      → SKIP              │    │
                    │  └──────────────────────────────┘    │
                    │  冷却防抖 │ 并发控制 │ Token预算     │
                    └──────────────────────────────────────┘
                              │
                              ↓
                    SkillEvolver / SkillRetirementManager
                    (进化执行 / 技能退役)
```

## 核心能力

### 三种触发类型

| 触发类型 | 枚举值 | 说明 |
|---------|--------|------|
| `POST_TASK` | `'post-task'` | 任务完成后触发，基于任务执行结果（成功/失败、耗时、Token消耗）决定是否需要进化 |
| `QUALITY_DEGRADATION` | `'quality-degradation'` | 质量退化触发，当技能成功率下降超过阈值时触发进化评估 |
| `METRIC_MONITOR` | `'metric-monitor'` | 指标监控触发，当技能健康评分低于阈值时触发进化评估 |

### 四级严重度

| 严重度 | 枚举值 | 评分范围 | 说明 |
|--------|--------|---------|------|
| `CRITICAL` | `'critical'` | ≥ 0.8 | 严重异常，需立即处理 |
| `HIGH` | `'high'` | ≥ 0.5 | 高度异常，需优先处理 |
| `MEDIUM` | `'medium'` | ≥ 0.3 | 中度异常，需关注 |
| `LOW` | `'low'` | < 0.3 | 轻微异常，可忽略 |

### 四种进化决策

| 决策 | 枚举值 | 触发条件 | 执行动作 |
|------|--------|---------|---------|
| `EVOLVE` | `'evolve'` | CRITICAL/HIGH严重度，或MEDIUM且并发未满 | 调用SkillEvolver.evolve()和SkillImprovementLoop.recordLearning() |
| `SKIP` | `'skip'` | LOW严重度，或冷却期内 | 不执行任何动作 |
| `DEFER` | `'defer'` | MEDIUM严重度且并发进化数已达上限 | 延迟执行，等待并发槽位释放 |
| `RETIRE` | `'retire'` | CRITICAL严重度 + 质量退化 + 当前成功率 < 0.1 | 调用SkillRetirementManager.retireSkill() |

### 冷却机制

- 每次触发处理后，对 `{skillId}:{triggerType}` 组合键设置冷却期（默认5分钟）
- 冷却期内相同技能的相同类型触发将被跳过（决策为SKIP）
- 冷却期通过 `BoundedMap`（容量200）管理，防止内存泄漏
- 进化执行完成后，活跃触发条目在冷却期结束后自动从 `_activeTriggers` 中移除

### 并发控制

- 通过 `maxConcurrentEvolutions`（默认3）限制同时进行的进化数量
- 当活跃触发数达到上限时，MEDIUM严重度的触发将被延迟（DEFER）
- CRITICAL和HIGH严重度的触发不受并发限制，始终立即执行

### Token预算

- 每次进化执行携带 `evolutionBudgetTokens`（默认20000）作为Token预算上限
- 预算通过 `evolve()` 调用传递给SkillEvolver，由其控制进化过程的Token消耗

## 类定义

```javascript
class EvolutionTriggerOrchestrator {
  constructor(options)
  attachSkillEvolver(skillEvolver)
  attachSkillImprovementLoop(loop)
  attachSkillObservability(observability)
  attachSkillRetirementManager(manager)
  onTaskCompleted(taskResult)
  onQualityDegradation(qualitySignal)
  onMetricAlert(metricSignal)
  getStats()
  _onShutdown() // via withShutdown mixin
}

// 导出常量
module.exports.TRIGGER_TYPES      // 触发类型枚举
module.exports.TRIGGER_SEVERITY    // 严重度枚举
module.exports.EVOLUTION_DECISION  // 进化决策枚举
```

## 构造函数

### `constructor(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options` | object | 否 | `{}` | 配置选项 |
| `options.maxTriggerHistory` | number | 否 | `1000` | 最大触发历史记录数 |
| `options.maxActiveTriggers` | number | 否 | `100` | 最大活跃触发数 |
| `options.cooldownMs` | number | 否 | `300000` | 冷却期时长（毫秒），默认5分钟 |
| `options.postTaskEnabled` | boolean | 否 | `true` | 是否启用任务完成触发 |
| `options.qualityDegradationEnabled` | boolean | 否 | `true` | 是否启用质量退化触发 |
| `options.metricMonitorEnabled` | boolean | 否 | `true` | 是否启用指标监控触发 |
| `options.qualityDropThreshold` | number | 否 | `0.2` | 质量下降触发阈值（绝对值） |
| `options.healthScoreThreshold` | number | 否 | `0.4` | 健康评分触发阈值（低于此值触发） |
| `options.maxConcurrentEvolutions` | number | 否 | `3` | 最大并发进化数 |
| `options.evolutionBudgetTokens` | number | 否 | `20000` | 单次进化Token预算 |

初始化内部状态：
- `_skillEvolver` — 注入的SkillEvolver引用，初始为null
- `_skillImprovementLoop` — 注入的SkillImprovementLoop引用，初始为null
- `_skillObservability` — 注入的SkillObservability引用，初始为null
- `_skillRetirementManager` — 注入的SkillRetirementManager引用，初始为null
- `_activeTriggers` — 活跃触发映射（`BoundedMap<triggerId, trigger>`，容量=maxActiveTriggers）
- `_triggerHistory` — 触发历史记录（`BoundedArray`，容量=maxTriggerHistory）
- `_cooldowns` — 冷却期映射（`BoundedMap<key, cooldownEndTimestamp>`，容量=200）
- `_cooldownTimers` — 冷却定时器ID数组，用于关闭时清理
- `_stats` — 运行统计对象

## 公开方法详解

### 依赖注入方法

| 方法 | 参数 | 说明 |
|------|------|------|
| `attachSkillEvolver(skillEvolver)` | `skillEvolver: object` | 注入SkillEvolver实例，用于执行技能进化 |
| `attachSkillImprovementLoop(loop)` | `loop: object` | 注入SkillImprovementLoop实例，用于记录学习反馈 |
| `attachSkillObservability(observability)` | `observability: object` | 注入SkillObservability实例，用于可观测性监控 |
| `attachSkillRetirementManager(manager)` | `manager: object` | 注入SkillRetirementManager实例，用于执行技能退役 |

### 触发入口方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `onTaskCompleted(taskResult)` | `taskResult.skillId: string`<br>`taskResult.success: boolean`<br>`taskResult.error: string\|null`<br>`taskResult.duration: number`<br>`taskResult.tokensUsed: number` | `trigger\|null` | 任务完成触发入口，需 `postTaskEnabled=true` |
| `onQualityDegradation(qualitySignal)` | `qualitySignal.skillId: string`<br>`qualitySignal.previousSuccessRate: number`<br>`qualitySignal.currentSuccessRate: number`<br>`qualitySignal.drop: number` | `trigger\|null` | 质量退化触发入口，需 `qualityDegradationEnabled=true` 且 `|drop| ≥ qualityDropThreshold` |
| `onMetricAlert(metricSignal)` | `metricSignal.skillId: string`<br>`metricSignal.healthScore: number`<br>`metricSignal.compositeScore: number`<br>`metricSignal.failingMetrics: string[]` | `trigger\|null` | 指标告警触发入口，需 `metricMonitorEnabled=true` 且 `healthScore < healthScoreThreshold` |

### 查询方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getStats()` | 无 | `object` | 获取运行统计信息 |

`getStats()` 返回结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `triggersReceived` | number | 接收到的触发总数 |
| `triggersProcessed` | number | 已处理的触发数（排除冷却跳过） |
| `evolutionsTriggered` | number | 触发进化的次数 |
| `evolutionsSkipped` | number | 跳过的进化次数 |
| `evolutionsDeferred` | number | 延迟的进化次数 |
| `retirementsTriggered` | number | 触发退役的次数 |
| `byType` | object | 按触发类型统计 `{ [type]: count }` |
| `byDecision` | object | 按决策类型统计 `{ [decision]: count }` |
| `activeTriggers` | number | 当前活跃触发数 |
| `cooldownEntries` | number | 当前冷却条目数 |

## 触发对象结构

`_createTrigger()` 生成的触发对象：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一触发ID，格式 `trigger-{timestamp}-{random}` |
| `type` | string | 触发类型（`TRIGGER_TYPES` 枚举值） |
| `data` | object | 触发数据（因触发类型而异） |
| `skillId` | string | 目标技能ID |
| `severity` | string | 严重度（`TRIGGER_SEVERITY` 枚举值） |
| `createdAt` | number | 创建时间戳 |
| `processedAt` | number\|null | 处理时间戳 |
| `decision` | string\|null | 进化决策（`EVOLUTION_DECISION` 枚举值） |

## 事件体系

EvolutionTriggerOrchestrator 通过 `withShutdown` mixin 继承关闭能力，不直接继承 EventEmitter，因此不发出自定义事件。其与外部模块的交互通过依赖注入的方法调用完成。

## 配置常量

### `DEFAULT_OPTIONS`

| 常量 | 值 | 说明 |
|------|---|------|
| `maxTriggerHistory` | `1000` | 最大触发历史记录数 |
| `maxActiveTriggers` | `100` | 最大活跃触发数 |
| `cooldownMs` | `300000` | 冷却期时长（5分钟） |
| `postTaskEnabled` | `true` | 任务完成触发开关 |
| `qualityDegradationEnabled` | `true` | 质量退化触发开关 |
| `metricMonitorEnabled` | `true` | 指标监控触发开关 |
| `qualityDropThreshold` | `0.2` | 质量下降触发阈值 |
| `healthScoreThreshold` | `0.4` | 健康评分触发阈值 |
| `maxConcurrentEvolutions` | `3` | 最大并发进化数 |
| `evolutionBudgetTokens` | `20000` | 单次进化Token预算 |

### 导出枚举

| 常量 | 值 | 说明 |
|------|---|------|
| `TRIGGER_TYPES.POST_TASK` | `'post-task'` | 任务完成触发 |
| `TRIGGER_TYPES.QUALITY_DEGRADATION` | `'quality-degradation'` | 质量退化触发 |
| `TRIGGER_TYPES.METRIC_MONITOR` | `'metric-monitor'` | 指标监控触发 |
| `TRIGGER_SEVERITY.LOW` | `'low'` | 低严重度 |
| `TRIGGER_SEVERITY.MEDIUM` | `'medium'` | 中严重度 |
| `TRIGGER_SEVERITY.HIGH` | `'high'` | 高严重度 |
| `TRIGGER_SEVERITY.CRITICAL` | `'critical'` | 严重 |
| `EVOLUTION_DECISION.EVOLVE` | `'evolve'` | 执行进化 |
| `EVOLUTION_DECISION.SKIP` | `'skip'` | 跳过 |
| `EVOLUTION_DECISION.DEFER` | `'defer'` | 延迟 |
| `EVOLUTION_DECISION.RETIRE` | `'retire'` | 退役 |

## 使用示例

### 基本使用

```javascript
const EvolutionTriggerOrchestrator = require('./src/runtime/skill/evolution-trigger-orchestrator');

const orchestrator = new EvolutionTriggerOrchestrator({
  cooldownMs: 300000,           // 冷却期5分钟
  maxConcurrentEvolutions: 3,   // 最多3个并发进化
  evolutionBudgetTokens: 20000, // 单次进化Token预算
  qualityDropThreshold: 0.2,    // 质量下降20%触发
  healthScoreThreshold: 0.4,    // 健康评分低于0.4触发
});

// 注入依赖
orchestrator.attachSkillEvolver(skillEvolver);
orchestrator.attachSkillImprovementLoop(improvementLoop);
orchestrator.attachSkillObservability(observability);
orchestrator.attachSkillRetirementManager(retirementManager);
```

### 任务完成触发

```javascript
const result = orchestrator.onTaskCompleted({
  skillId: 'code-review',
  success: false,
  error: 'Review quality below threshold',
  duration: 15000,
  tokensUsed: 3500,
});

console.log(result.decision); // 'evolve' | 'skip' | 'defer' | 'retire'
console.log(result.severity); // 'low' | 'medium' | 'high' | 'critical'
```

### 质量退化触发

```javascript
const result = orchestrator.onQualityDegradation({
  skillId: 'bug-detector',
  previousSuccessRate: 0.85,
  currentSuccessRate: 0.55,
  drop: -0.30,
});

// drop绝对值 >= qualityDropThreshold(0.2) 才会触发
// severity由 |drop| 值决定：0.30 >= 0.3 → MEDIUM
```

### 指标告警触发

```javascript
const result = orchestrator.onMetricAlert({
  skillId: 'test-generator',
  healthScore: 0.25,
  compositeScore: 0.30,
  failingMetrics: ['success_rate', 'coverage'],
});

// healthScore < healthScoreThreshold(0.4) 才会触发
// severity由 (1 - healthScore) 决定：0.75 >= 0.5 → HIGH
```

### 查询运行统计

```javascript
const stats = orchestrator.getStats();
console.log('接收触发:', stats.triggersReceived);
console.log('已处理:', stats.triggersProcessed);
console.log('进化触发:', stats.evolutionsTriggered);
console.log('跳过:', stats.evolutionsSkipped);
console.log('延迟:', stats.evolutionsDeferred);
console.log('退役触发:', stats.retirementsTriggered);
console.log('按类型:', stats.byType);
console.log('按决策:', stats.byDecision);
console.log('活跃触发数:', stats.activeTriggers);
console.log('冷却条目数:', stats.cooldownEntries);
```

### 优雅关闭

```javascript
// 关闭时自动清理所有冷却定时器和有界集合
orchestrator.shutdown();
```

## 依赖关系

### 内部依赖

| 模块 | 路径 | 用途 |
|------|------|------|
| `mergeConfig` | `../../utils/safe-assign` | 安全合并配置选项 |
| `BoundedMap` | `../../utils/bounded-map` | 有界映射，用于活跃触发和冷却期管理 |
| `BoundedArray` | `../../utils/bounded-array` | 有界数组，用于触发历史记录 |
| `withShutdown` | `../../utils/shutdown-mixin` | 优雅关闭混入 |
| `safeCall` | `../../utils/safe-execute` | 安全调用包装，防止外部依赖异常传播 |

### 外部集成

| 模块 | 注入方法 | 调用时机 | 说明 |
|------|---------|---------|------|
| **SkillEvolver** | `attachSkillEvolver()` | 决策为EVOLVE时 | 调用 `evolve(skillId, { triggerType, triggerData, budget })` 执行技能进化 |
| **SkillImprovementLoop** | `attachSkillImprovementLoop()` | 决策为EVOLVE时 | 调用 `recordLearning({ skillId, whatFailed, context, triggerType })` 记录学习反馈 |
| **SkillObservability** | `attachSkillObservability()` | 预留接口 | 注入可观测性实例，用于监控指标采集（当前版本未直接调用） |
| **SkillRetirementManager** | `attachSkillRetirementManager()` | 决策为RETIRE时 | 调用 `retireSkill(skillId, { reason, triggerType, data })` 执行技能退役 |

### 集成流程

```
1. 创建 EvolutionTriggerOrchestrator 实例
2. 通过 attach*() 方法注入依赖模块
3. 运行时通过 onTaskCompleted / onQualityDegradation / onMetricAlert 接收触发信号
4. 内部完成：冷却检查 → 严重度分类 → 决策评估 → 执行动作
5. EVOLVE 决策：同时调用 SkillImprovementLoop.recordLearning() 和 SkillEvolver.evolve()
6. RETIRE 决策：调用 SkillRetirementManager.retireSkill()
7. 关闭时调用 shutdown() 清理所有定时器和有界集合
```

### 安全调用

所有对注入依赖的方法调用均通过 `safeCall()` 包装，确保外部模块异常不会中断编排器的正常流程。调用失败仅记录日志，不影响后续触发处理。

---

## 相关文档

- [模块详解-TriggerDispatcher统一触发调度](模块详解-TriggerDispatcher统一触发调度.md)
- [模块详解-SkillEvolver技能进化器](模块详解-SkillEvolver技能进化器.md)
- [模块详解-SkillImprovementLoop技能改进循环](模块详解-SkillImprovementLoop技能改进循环.md)
- [模块详解-SkillObservability技能可观测性](模块详解-SkillObservability技能可观测性.md)
- [模块详解-SkillRetirementManager技能退役管理器](模块详解-SkillRetirementManager技能退役管理器.md)
