# 模块详解-Karpathy增强器

> 版本：2.73.4 | 文件：src/gate/karpathy-enhancer.js | 行数：~220行

---

## 模块概述

KarpathyEnhancer模块实现了基于Karpathy工程原则的规则增强器，为TDD门禁系统提供四条增强规则：Diff卫生（diff-hygiene，禁止无关变更）、返工率控制（rework-rate，同一区域反复修改暗示设计问题）、澄清优先（clarification-first，编码前应先澄清需求）、孤立代码率（orphan-code-rate，无调用者的代码指示死代码或缺失集成）。模块同时提供效果度量功能，通过加权评分量化工程纪律的执行效果。

## 融合来源

融合自Andrej Karpathy的软件工程最佳实践，特别是其关于代码审查、变更卫生和迭代开发的观点。Karpathy强调"小而专注的diff"、"不要反复修改同一区域"、"先理解再编码"、"删除死代码"等原则。模块将这些原则转化为可度量、可检查的规则，并引入效果度量机制，使工程纪律从"建议"升级为"可验证的约束"。

## 核心API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `enhance(existingRules)` | existingRules?: Object | `Object` | 向现有规则集注入四条增强规则 |
| `measureEffectiveness(metrics)` | metrics: Object | `{ diffHygiene, reworkRate, clarificationRate, orphanRate, overallScore }` | 度量工程纪律执行效果 |
| `getStats()` | 无 | `{ enhanceCount, measureCount, trackedAreas, config }` | 获取统计信息 |

### 静态属性

| 属性 | 说明 |
|------|------|
| `DEFAULT_CONFIG` | 默认配置 |
| `ENHANCEMENT_RULES` | 增强规则定义 |

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `diffHygieneThreshold` | number | 0.8 | Diff卫生阈值，干净diff占比低于此值触发告警 |
| `maxReworkCount` | number | 3 | 最大返工次数，超过则触发设计问题告警 |
| `minClarificationRate` | number | 0.5 | 最低澄清率，编码前澄清占比低于此值触发告警 |
| `maxOrphanRate` | number | 0.05 | 最大孤立代码率，超过则触发死代码告警 |

### 增强规则详情

| 规则ID | 级别 | 说明 | 检查逻辑 |
|--------|------|------|---------|
| `diff-hygiene` | warn | Diff必须不包含无关变更 | cleanDiffs/totalDiffs < threshold |
| `rework-rate` | warn | 同一区域修改超过阈值次暗示设计问题 | reworkAreas中任一area.count > maxReworkCount |
| `clarification-first` | info | 编码任务应在实现前进行澄清 | clarificationsBefore/totalTasks < minRate |
| `orphan-code-rate` | warn | 无调用者的代码指示死代码 | orphanCodeLines/totalLines > maxRate |

### 效果度量评分权重

| 维度 | 权重 | 说明 |
|------|------|------|
| diffHygiene | 0.3 | Diff卫生得分 |
| reworkRate | 0.25 | 返工率得分（1 - reworkRate） |
| clarificationRate | 0.25 | 澄清率得分 |
| orphanRate | 0.2 | 孤立代码率得分 |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `rules-enhanced` | 规则增强完成 | `{ ruleCount, addedRules }` |
| `effectiveness-measured` | 效果度量完成 | `{ diffHygiene, reworkRate, clarificationRate, orphanRate, overallScore }` |

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../errors.js`（TDDGateError）
- 依赖：`../utils/safe-assign.js`（mergeConfig）
- 依赖：`../utils/debug-logger.js`（调试日志）
- 依赖：`../utils/shutdown-mixin.js`（优雅关闭混入）

## 使用示例

```javascript
const KarpathyEnhancer = require('./src/gate/karpathy-enhancer');

const enhancer = new KarpathyEnhancer({
  diffHygieneThreshold: 0.85,
  maxReworkCount: 2,
  minClarificationRate: 0.6,
  maxOrphanRate: 0.03,
});

const existingRules = {
  'tdd-gate': { level: 'error', description: 'TDD门禁规则' },
  'naming-convention': { level: 'warn', description: '命名规范' },
};

const enhancedRules = enhancer.enhance(existingRules);
console.log('Enhanced rules:', Object.keys(enhancedRules));
console.log('Added:', Object.keys(enhancedRules).filter(k => !Object.keys(existingRules).includes(k)));

const effectiveness = enhancer.measureEffectiveness({
  totalDiffs: 50,
  cleanDiffs: 45,
  reworkAreas: [
    { name: 'auth-module', count: 2 },
    { name: 'db-layer', count: 4 },
  ],
  clarificationsBefore: 8,
  totalTasks: 10,
  orphanCodeLines: 120,
  totalLines: 5000,
});

console.log('Overall score:', effectiveness.overallScore.toFixed(2));
console.log('Diff hygiene:', effectiveness.diffHygiene.toFixed(2));
console.log('Rework rate:', effectiveness.reworkRate.toFixed(2));
```

## 与现有模块的集成点

- **TDDGate**：TDD门禁通过KarpathyEnhancer增强其规则集，在RED-GREEN-REFACTOR检测之外增加工程纪律检查
- **FrameworkComplianceChecker**：框架合规检查器将KarpathyEnhancer的规则纳入合规检查清单
- **CodeReviewFrameworkCheck**：代码审查框架在审查时检查diff-hygiene和orphan-code-rate规则
- **CodeGraph**：代码仓库图谱的孤立文件检测和循环依赖分析为orphan-code-rate规则提供数据支撑
- **CodeDriftDetector**：代码漂移检测器的返工区域追踪为rework-rate规则提供历史数据
- **QualityScorer**：质量评分器将KarpathyEnhancer的效果度量作为质量评估的输入维度之一
