# 模块详解 - EntropyGovernanceOrchestrator 熵治理编排器

> 版本：2.73.4 | 源码：`src/runtime/quality/entropy-governance-orchestrator.js`

---

## 概述

EntropyGovernanceOrchestrator 是融合 Harness Engineering 范式"持续熵治理"体系的核心编排器。它聚合六大熵指标源，计算统一系统熵评分，并实现"检测→告警→约束强化→验证"闭环，填补了项目在系统4（持续熵治理）方面的缺口。

## 核心特性

- **六大熵指标源聚合**：ContextDriftMonitor + ComprehensionDebtTracker + CodeDriftDetector + SkillReducer + AiCodeTrustScorer + DeliveryEfficiencyMeter
- **统一熵评分**：加权计算0-1系统熵评分，5级分类（none/low/medium/high/critical）
- **主动简化触发**：熵评分超过阈值时自动触发技能卸载和上下文压缩
- **约束强化闭环**：熵评分超过阈值时触发 `constraint-reinforce-triggered` 事件，驱动 IronRuleEngine/LayerBoundaryGuard 约束强化
- **趋势分析**：线性回归计算熵趋势（increasing/stable/decreasing）
- **事件驱动即时评估**：漂移检测、critical债务、技能过载、不可信代码等事件自动触发即时评估
- **BoundedArray**：历史记录自动限容

## 类定义

```javascript
class EntropyGovernanceOrchestrator extends EventEmitter
// 混入 withShutdown，支持 guardShutdown() 和 _onShutdown()
```

## 常量

### ENTROPY_LEVELS

| 等级 | 值 | 说明 |
|------|------|------|
| NONE | `'none'` | 无熵（< 0.1） |
| LOW | `'low'` | 低熵（0.1-0.25） |
| MEDIUM | `'medium'` | 中熵（0.25-0.45） |
| HIGH | `'high'` | 高熵（0.45-0.65） |
| CRITICAL | `'critical'` | 严重熵（> 0.65） |

### DEFAULT_CONFIG

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| assessmentIntervalMs | 60000 | 定期评估间隔 |
| historySize | 200 | 历史记录容量 |
| autoSimplifyThreshold | 0.7 | 主动简化触发阈值 |
| constraintReinforceThreshold | 0.6 | 约束强化触发阈值 |
| weights.contextDrift | 0.20 | 上下文漂移权重 |
| weights.comprehensionDebt | 0.20 | 理解债务权重 |
| weights.codeDrift | 0.20 | 代码漂移权重 |
| weights.skillOverload | 0.15 | 技能过载权重 |
| weights.codeTrust | 0.15 | 代码可信度权重 |
| weights.deliveryEfficiency | 0.10 | 交付效率权重 |

## 构造函数

```javascript
new EntropyGovernanceOrchestrator(config)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| config.contextDriftMonitor | Object | ContextDriftMonitor 实例 |
| config.comprehensionDebtTracker | Object | ComprehensionDebtTracker 实例 |
| config.codeDriftDetector | Object | CodeDriftDetector 实例 |
| config.skillReducer | Object | SkillReducer 实例 |
| config.aiCodeTrustScorer | Object | AiCodeTrustScorer 实例 |
| config.deliveryEfficiencyMeter | Object | DeliveryEfficiencyMeter 实例 |
| config.assessmentIntervalMs | number | 评估间隔覆盖 |
| config.autoSimplifyThreshold | number | 简化阈值覆盖 |
| config.constraintReinforceThreshold | number | 约束强化阈值覆盖 |
| config.weights | Object | 权重覆盖 |

## 核心 API

### assess()

执行一次完整的熵评估，聚合所有指标源。

**返回值：**

```javascript
{
  score: number,           // 0-1 熵评分
  level: string,           // none/low/medium/high/critical
  metrics: {               // 各指标源详情
    contextDrift: { score, level, violatedConstraints, totalConstraints, trend },
    comprehensionDebt: { score, level, openCount, resolutionRate, distribution },
    codeDrift: { score, drifting, trend, alertCount, reason },
    skillOverload: { score, level, l2Cached, l1Count, overloadDetections, contextTokens },
    codeTrust: { score, averageTrustScore, riskDistribution },
    deliveryEfficiency: { score, distributionDeviation, reviewBottleneckScore, aiAccelerationRatio, codingRatio },
  },
  recommendations: Array,  // 治理建议
  assessedAt: number,      // 时间戳
}
```

### getCurrentScore()

获取当前熵评分（不重新计算）。

### getHistory(limit)

获取熵评分历史记录。

### getTrend()

获取熵趋势分析（线性回归）。

**返回值：**

```javascript
{
  trend: 'increasing'|'stable'|'decreasing'|'insufficient-data',
  slope: number,          // 熵变化斜率
  samples: number,        // 样本数
  latestScore: number,    // 最新评分
  earliestScore: number,  // 最早评分
}
```

### getStats()

获取统计信息。

### triggerSimplify()

手动触发主动简化流程。

## 事件

| 事件名 | 数据 | 说明 |
|--------|------|------|
| `entropy-assessed` | 评估结果对象 | 每次评估完成 |
| `auto-simplify-triggered` | `{ score, level, actions, triggeredAt }` | 主动简化触发 |
| `constraint-reinforce-triggered` | `{ score, level, metrics, recommendations, triggeredAt }` | 约束强化触发 |

## 闭环机制

### 检测→告警→约束强化闭环

```
CodeDriftDetector.detectDrift() → drift-detected 事件
    ↓
EntropyGovernanceOrchestrator._onDriftDetected() → 即时 assess()
    ↓
assess() → score >= constraintReinforceThreshold (0.6)
    ↓
emit('constraint-reinforce-triggered') → IronRuleEngine / LayerBoundaryGuard 强化约束
```

### 熵评分→主动简化闭环

```
assess() → score >= autoSimplifyThreshold (0.7)
    ↓
_triggerAutoSimplify()
    ├→ SkillReducer.unloadAllL2() — 卸载非核心技能
    └→ emit('auto-simplify-triggered') — 通知其他模块压缩上下文
```

## 与其他模块的集成

| 模块 | 集成方式 | 作用 |
|------|----------|------|
| ContextDriftMonitor | `config.contextDriftMonitor` | 上下文漂移评分源 |
| ComprehensionDebtTracker | `config.comprehensionDebtTracker` | 理解债务评分源 |
| CodeDriftDetector | `config.codeDriftDetector` | 代码漂移评分源 |
| SkillReducer | `config.skillReducer` | 技能过载评分源 + 主动简化执行器 |
| AiCodeTrustScorer | `config.aiCodeTrustScorer` | 代码可信度评分源 |
| DeliveryEfficiencyMeter | `config.deliveryEfficiencyMeter` | 交付效率评分源 |
| IronRuleEngine | `constraint-reinforce-triggered` 事件消费者 | 约束强化执行 |
| LayerBoundaryGuard | `constraint-reinforce-triggered` 事件消费者 | 边界约束强化 |

## 使用示例

```javascript
const { EntropyGovernanceOrchestrator } = require('./src/runtime/quality/entropy-governance-orchestrator');

const orchestrator = new EntropyGovernanceOrchestrator({
  contextDriftMonitor: driftMonitor,
  comprehensionDebtTracker: debtTracker,
  codeDriftDetector: codeDriftDetector,
  skillReducer: skillReducer,
  aiCodeTrustScorer: trustScorer,
  deliveryEfficiencyMeter: efficiencyMeter,
  autoSimplifyThreshold: 0.7,
  constraintReinforceThreshold: 0.6,
});

// 监听约束强化事件
orchestrator.on('constraint-reinforce-triggered', (data) => {
  console.log(`熵评分 ${data.score} 超过阈值，触发约束强化`);
  ironRuleEngine.addPatternRule({ /* 强化规则 */ });
});

// 监听主动简化事件
orchestrator.on('auto-simplify-triggered', (data) => {
  console.log(`熵评分 ${data.score} 超过阈值，触发主动简化`);
});

// 手动评估
const result = orchestrator.assess();
console.log('系统熵:', result.score, result.level);
console.log('建议:', result.recommendations);
```

## 融合来源

本模块融合了 Harness Engineering 范式"持续熵治理"体系：

| Harness Engineering 要求 | Harness 实现 |
|-------------------------|-------------|
| 统一熵指标仪表盘 | `assess()` 六源聚合 + `getStats()` 统计 |
| 主动简化触发机制 | `_triggerAutoSimplify()` + `autoSimplifyThreshold` |
| 漂移检测→约束强化闭环 | `constraint-reinforce-triggered` 事件 |
| 跨会话熵趋势分析 | `getTrend()` 线性回归趋势 |
| 熵治理建议生成 | `_generateRecommendations()` 六维度建议 |
