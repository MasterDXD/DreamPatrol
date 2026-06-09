# 模块详解-DeliveryAccelerationOrchestrator交付加速编排器

> 版本：2.73.4 | 文件：src/runtime/quality/delivery-acceleration-orchestrator.js | 行数：669行

---

## 模块定位

DeliveryAccelerationOrchestrator 是交付加速编排器，负责检测6类交付瓶颈（审查吞吐失衡/似对非对代码/理解债务/上下文漂移/架构不匹配/管道阻塞），执行架构先行门禁，切换4种工作流模式，通过8个 `attach*()` 依赖注入点融合现有8个模块的统一编排能力。

解决的核心问题：**"AI只加速编码20%，交付瓶颈在其余80%"**——通过瓶颈诊断、架构先行、工作流重构三大能力，将AI加速从编码环节延伸到整个交付链路。

> ⚠️ **废弃提示**：该模块标记为 `@deprecated`，当前为孤立模块（未被任何文件引用），计划在下一版本移除。

## 架构角色

```
                        DeliveryAccelerationOrchestrator
                    ┌──────────────────────────────────────────┐
                    │                                          │
  8个依赖模块 ────→ │  attach*() 依赖注入层                     │
  · DeliveryEfficiencyMeter  ─→│                              │
  · AiCodeTrustScorer        ─→│  ┌────────────────────────┐  │
  · ComprehensionDebtTracker ─→│  │  瓶颈诊断引擎           │  │
  · ContextDriftMonitor      ─→│  │  6类瓶颈检测            │  │
  · AgentDebugLoop           ─→│  │  严重度量化             │  │
  · CodeReviewFrameworkCheck ─→│  │  推荐策略生成           │  │
  · PhaseOrchestrator        ─→│  └────────────────────────┘  │
  · SddContractManager       ─→│                              │
                    │  ┌────────────────────────┐  │
                    │  │  架构先行门禁           │  │
                    │  │  SDD合约spec+design检查  │  │
                    │  └────────────────────────┘  │
                    │  ┌────────────────────────┐  │
                    │  │  工作流重构             │  │
                    │  │  4种模式切换            │  │
                    │  │  自动推荐最佳模式       │  │
                    │  └────────────────────────┘  │
                    └──────────────────────────────────────────┘
                              │
                    ┌─────────┼─────────┐
                    ↓         ↓         ↓
              瓶颈诊断报告  门禁拦截  工作流模式切换
```

## 核心能力

### 能力一：瓶颈诊断

自动检测6类交付瓶颈，量化严重度，推荐缓解策略。

| 瓶颈类型 | 枚举值 | 检测来源 | 说明 |
|---------|--------|---------|------|
| 审查吞吐失衡 | `'review-throughput'` | DeliveryEfficiencyMeter | 代码生成速度远超审查速度，审查积压 |
| 似对非对代码 | `'almost-correct-code'` | AiCodeTrustScorer | 代码表面正确但含隐蔽缺陷，反复审查耗时 |
| 理解债务 | `'understanding-debt'` | ComprehensionDebtTracker | 需求/领域知识理解不足，导致返工 |
| 上下文漂移 | `'context-drift'` | ContextDriftMonitor | 长任务中约束条件丢失，偏离原始目标 |
| 架构不匹配 | `'architecture-mismatch'` | SddContractManager | AI生成代码与架构规范不一致 |
| 管道阻塞 | `'pipeline-blockage'` | DeliveryEfficiencyMeter | 交付管道某阶段成为瓶颈，阻塞整体流程 |

### 能力二：架构先行

强制"先定架构再写码"的门禁机制。在 `architecture-first` 模式下，必须先完成SDD合约的 `spec` + `design` 阶段，才能进入编码阶段，减少因架构不清晰导致的返工。

### 能力三：工作流重构

根据瓶颈诊断结果，自动推荐并切换工作流模式，实现"AI负责写+测+修，人聚焦需求+架构+决策"的分工重构。

## 类定义

```javascript
class DeliveryAccelerationOrchestrator extends EventEmitter {
  constructor(options)
  // 依赖注入（8个attach点）
  attachDeliveryEfficiencyMeter(meter)
  attachAiCodeTrustScorer(scorer)
  attachComprehensionDebtTracker(tracker)
  attachContextDriftMonitor(monitor)
  attachAgentDebugLoop(debugLoop)
  attachCodeReviewFrameworkCheck(check)
  attachPhaseOrchestrator(orchestrator)
  attachSddContractManager(manager)
  // 核心能力
  diagnoseBottlenecks()
  checkArchitectureFirstGate()
  switchWorkflowMode(mode)
  getWorkflowMode()
  recommendWorkflowMode()
  // 自动检测
  startAutoDetection()
  stopAutoDetection()
  // 统计与状态
  getStats()
  getLastDiagnosis()
  getDeliveryOverview()
  // 关闭
  _onShutdown() // via withShutdown mixin
}

// 导出常量
module.exports.BOTTLENECK_LEVEL   // 瓶颈等级枚举
module.exports.WORKFLOW_MODE      // 工作流模式枚举
module.exports.BOTTLENECK_TYPE    // 瓶颈类型枚举
```

## 构造函数

### `constructor(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options` | object | 否 | `{}` | 配置选项 |
| `options.architectureFirst` | boolean | 否 | `true` | 启用架构先行模式 |
| `options.autoDetectBottleneck` | boolean | 否 | `true` | 自动检测瓶颈 |
| `options.bottleneckCheckIntervalMs` | number | 否 | `60000` | 瓶颈检测间隔（毫秒），必须 > 0 |
| `options.maxHistorySize` | number | 否 | `100` | 历史记录上限，最大500 |

初始化内部状态：
- `_deliveryMeter` — 注入的 DeliveryEfficiencyMeter 引用，初始为 null
- `_trustScorer` — 注入的 AiCodeTrustScorer 引用，初始为 null
- `_debtTracker` — 注入的 ComprehensionDebtTracker 引用，初始为 null
- `_driftMonitor` — 注入的 ContextDriftMonitor 引用，初始为 null
- `_debugLoop` — 注入的 AgentDebugLoop 引用，初始为 null
- `_reviewCheck` — 注入的 CodeReviewFrameworkCheck 引用，初始为 null
- `_phaseOrchestrator` — 注入的 PhaseOrchestrator 引用，初始为 null
- `_sddContract` — 注入的 SddContractManager 引用，初始为 null
- `_currentMode` — 当前工作流模式，初始为 `WORKFLOW_MODE.STANDARD`
- `_bottleneckHistory` — 瓶颈诊断历史（`BoundedArray`，容量=maxHistorySize）
- `_lastDiagnosis` — 最近一次诊断结果，初始为 null
- `_checkTimer` — 自动检测定时器，初始为 null
- `_stats` — 运行统计对象

## 公开方法详解

### 依赖注入方法

| 方法 | 参数 | 接口要求 | 说明 |
|------|------|---------|------|
| `attachDeliveryEfficiencyMeter(meter)` | `meter: object` | `meter.getReviewBottleneckScore()` | 附加交付效率度量器 |
| `attachAiCodeTrustScorer(scorer)` | `scorer: object` | `scorer.assess()` | 附加AI代码可信度评估器 |
| `attachComprehensionDebtTracker(tracker)` | `tracker: object` | `tracker.calculateDebtScore()` | 附加理解债务追踪器 |
| `attachContextDriftMonitor(monitor)` | `monitor: object` | `monitor.checkDrift()` | 附加上下文漂移监控器 |
| `attachAgentDebugLoop(debugLoop)` | `debugLoop: object` | `debugLoop.execute()` | 附加Agent自调试闭环 |
| `attachCodeReviewFrameworkCheck(check)` | `check: object` | `check.runChecklist()` | 附加代码审查框架检查器 |
| `attachPhaseOrchestrator(orchestrator)` | `orchestrator: object` | `orchestrator.setCurrentPhase()` | 附加阶段编排器 |
| `attachSddContractManager(manager)` | `manager: object` | `manager.advanceStage()` | 附加SDD合约管理器 |

所有 `attach*()` 方法均返回 `this`，支持链式调用。注入时会校验必需接口方法是否存在，不满足则忽略。

### 核心方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `diagnoseBottlenecks()` | 无 | `DiagnosisResult` | 执行全面的交付瓶颈诊断，检测6类瓶颈 |
| `checkArchitectureFirstGate()` | 无 | `GateResult` | 检查是否满足架构先行条件 |
| `switchWorkflowMode(mode)` | `mode: string` | `ModeSwitchResult` | 切换工作流模式 |
| `getWorkflowMode()` | 无 | `string` | 获取当前工作流模式 |
| `recommendWorkflowMode()` | 无 | `ModeRecommendation` | 根据瓶颈诊断自动推荐最佳工作流模式 |

### 自动检测方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `startAutoDetection()` | 无 | 无 | 启动自动瓶颈检测（需 `autoDetectBottleneck=true`） |
| `stopAutoDetection()` | 无 | 无 | 停止自动瓶颈检测 |

### 查询方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getStats()` | 无 | `object` | 获取运行统计信息 |
| `getLastDiagnosis()` | 无 | `object\|null` | 获取最近一次诊断结果 |
| `getDeliveryOverview()` | 无 | `DeliveryOverview` | 获取交付效率概览 |

### 返回值结构

**DiagnosisResult**（`diagnoseBottlenecks()` 返回值）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `bottlenecks` | Array | 活跃瓶颈列表（level不为NONE的） |
| `overallLevel` | string | 总体瓶颈等级 |
| `recommendations` | Array | 推荐缓解策略列表 |
| `diagnosisTimeMs` | number | 诊断耗时（毫秒） |
| `diagnosedAt` | string | 诊断时间（ISO格式） |

**Bottleneck**（瓶颈对象）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 瓶颈类型（`BOTTLENECK_TYPE` 枚举值） |
| `level` | string | 瓶颈等级（`BOTTLENECK_LEVEL` 枚举值） |
| `score` | number | 量化分数（0~1） |
| `detail` | string | 详细描述 |
| `mitigation` | string | 缓解策略（仅活跃瓶颈包含） |

**GateResult**（`checkArchitectureFirstGate()` 返回值）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `allowed` | boolean | 是否允许通过门禁 |
| `reason` | string | 原因说明 |
| `missingSpecs` | Array | 缺失的规格说明列表 |
| `currentPhase` | string\|null | 当前阶段 |

**ModeSwitchResult**（`switchWorkflowMode()` 返回值）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `switched` | boolean | 是否切换成功 |
| `previousMode` | string | 切换前模式 |
| `currentMode` | string | 当前模式 |

**ModeRecommendation**（`recommendWorkflowMode()` 返回值）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `recommendedMode` | string | 推荐的工作流模式 |
| `reason` | string | 推荐理由 |

**DeliveryOverview**（`getDeliveryOverview()` 返回值）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `codingRatio` | number | 编码占比（默认0.2） |
| `aiAccelerationRatio` | number | AI加速比率 |
| `reviewBottleneckScore` | number | 审查瓶颈评分 |
| `debtScore` | number | 理解债务评分 |
| `driftLevel` | string | 上下文漂移等级 |
| `trustLevel` | string | AI代码可信度等级（high/medium/low/unknown） |
| `pipelineBottleneck` | string\|null | 管道瓶颈位置 |

## 事件体系

DeliveryAccelerationOrchestrator 继承 `EventEmitter`，发出以下自定义事件：

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `diagnosis-completed` | 瓶颈诊断完成 | `DiagnosisResult` 完整诊断对象 |
| `architecture-first-blocked` | 架构先行门禁拦截 | `{ missingSpecs: string[], currentPhase: string\|null }` |
| `workflow-mode-changed` | 工作流模式切换 | `{ previousMode: string, currentMode: string }` |
| `auto-detection-started` | 自动检测启动 | 无 |
| `auto-detection-stopped` | 自动检测停止 | 无 |

## 配置常量

### 瓶颈等级（BOTTLENECK_LEVEL）

| 常量 | 值 | 评分范围 | 说明 |
|------|---|---------|------|
| `NONE` | `'none'` | < 0.2 | 无瓶颈 |
| `LOW` | `'low'` | ≥ 0.2 | 轻微瓶颈 |
| `MEDIUM` | `'medium'` | ≥ 0.4 | 中度瓶颈 |
| `HIGH` | `'high'` | ≥ 0.6 | 高度瓶颈 |
| `CRITICAL` | `'critical'` | ≥ 0.8 | 严重瓶颈 |

### 工作流模式（WORKFLOW_MODE）

| 常量 | 值 | 说明 |
|------|---|------|
| `STANDARD` | `'standard'` | 标准模式，默认工作流 |
| `ARCHITECTURE_FIRST` | `'architecture-first'` | 架构先行模式，强制先完成架构设计再编码 |
| `AI_WRITE_TEST_FIX` | `'ai-write-test-fix'` | AI闭环模式，AI负责"写+测+修"循环 |
| `HUMAN_REVIEW_DECIDE` | `'human-review-decide'` | 人审决策模式，人聚焦于审查和决策 |

### 瓶颈类型（BOTTLENECK_TYPE）

| 常量 | 值 | 说明 |
|------|---|------|
| `REVIEW_THROUGHPUT` | `'review-throughput'` | 审查吞吐失衡 |
| `ALMOST_CORRECT_CODE` | `'almost-correct-code'` | 似对非对代码 |
| `UNDERSTANDING_DEBT` | `'understanding-debt'` | 理解债务 |
| `CONTEXT_DRIFT` | `'context-drift'` | 上下文漂移 |
| `ARCHITECTURE_MISMATCH` | `'architecture-mismatch'` | 架构不匹配 |
| `PIPELINE_BLOCKAGE` | `'pipeline-blockage'` | 管道阻塞 |

### 构造函数默认值

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `architectureFirst` | `true` | 架构先行模式开关 |
| `autoDetectBottleneck` | `true` | 自动瓶颈检测开关 |
| `bottleneckCheckIntervalMs` | `60000` | 瓶颈检测间隔（1分钟） |
| `maxHistorySize` | `100`（上限500） | 历史记录上限 |

## 使用示例

### 基本使用

```javascript
const DeliveryAccelerationOrchestrator = require('./src/runtime/quality/delivery-acceleration-orchestrator');

const orchestrator = new DeliveryAccelerationOrchestrator({
  architectureFirst: true,             // 启用架构先行
  autoDetectBottleneck: true,          // 启用自动瓶颈检测
  bottleneckCheckIntervalMs: 60000,    // 每分钟检测一次
  maxHistorySize: 100,                 // 保留最近100条诊断记录
});

// 链式注入依赖
orchestrator
  .attachDeliveryEfficiencyMeter(deliveryMeter)
  .attachAiCodeTrustScorer(trustScorer)
  .attachComprehensionDebtTracker(debtTracker)
  .attachContextDriftMonitor(driftMonitor)
  .attachAgentDebugLoop(debugLoop)
  .attachCodeReviewFrameworkCheck(reviewCheck)
  .attachPhaseOrchestrator(phaseOrchestrator)
  .attachSddContractManager(sddContract);
```

### 瓶颈诊断

```javascript
const diagnosis = orchestrator.diagnoseBottlenecks();

console.log('总体等级:', diagnosis.overallLevel);  // 'none' | 'low' | 'medium' | 'high' | 'critical'
console.log('活跃瓶颈数:', diagnosis.bottlenecks.length);
console.log('诊断耗时:', diagnosis.diagnosisTimeMs, 'ms');

// 查看每个瓶颈的详情
diagnosis.bottlenecks.forEach(b => {
  console.log(`[${b.level}] ${b.type}: ${b.detail}`);
  if (b.mitigation) console.log(`  → 缓解策略: ${b.mitigation}`);
});

// 查看推荐策略
diagnosis.recommendations.forEach(r => {
  console.log(`[${r.priority}] ${r.action}: ${r.detail}`);
});
```

### 架构先行门禁

```javascript
const gate = orchestrator.checkArchitectureFirstGate();

if (!gate.allowed) {
  console.log('门禁拦截:', gate.reason);
  console.log('缺失规格:', gate.missingSpecs);
  console.log('当前阶段:', gate.currentPhase);
  // 阻止进入编码阶段，要求先完成架构设计
}
```

### 工作流模式切换

```javascript
const { WORKFLOW_MODE } = require('./src/runtime/quality/delivery-acceleration-orchestrator');

// 手动切换模式
const result = orchestrator.switchWorkflowMode(WORKFLOW_MODE.AI_WRITE_TEST_FIX);
console.log('切换:', result.switched);        // true
console.log('前模式:', result.previousMode);   // 'standard'
console.log('当前模式:', result.currentMode);   // 'ai-write-test-fix'

// 自动推荐最佳模式
const recommendation = orchestrator.recommendWorkflowMode();
console.log('推荐模式:', recommendation.recommendedMode);
console.log('推荐理由:', recommendation.reason);
```

### 自动瓶颈检测

```javascript
// 启动自动检测（按 bottleneckCheckIntervalMs 间隔执行）
orchestrator.startAutoDetection();

// 监听诊断完成事件
orchestrator.on('diagnosis-completed', (diagnosis) => {
  if (diagnosis.overallLevel === 'critical') {
    console.warn('检测到严重瓶颈！', diagnosis.bottlenecks);
  }
});

// 监听架构先行拦截事件
orchestrator.on('architecture-first-blocked', ({ missingSpecs, currentPhase }) => {
  console.warn('架构先行拦截:', missingSpecs);
});

// 停止自动检测
orchestrator.stopAutoDetection();
```

### 查询交付效率概览

```javascript
const overview = orchestrator.getDeliveryOverview();
console.log('编码占比:', overview.codingRatio);            // 0.2
console.log('AI加速比率:', overview.aiAccelerationRatio);
console.log('审查瓶颈评分:', overview.reviewBottleneckScore);
console.log('理解债务评分:', overview.debtScore);
console.log('上下文漂移等级:', overview.driftLevel);
console.log('AI代码可信度:', overview.trustLevel);         // 'high' | 'medium' | 'low' | 'unknown'
console.log('管道瓶颈位置:', overview.pipelineBottleneck);
```

### 查询运行统计

```javascript
const stats = orchestrator.getStats();
console.log('总诊断次数:', stats.totalDiagnoses);
console.log('检测到的瓶颈数:', stats.bottlenecksDetected);
console.log('模式切换次数:', stats.modeSwitches);
console.log('架构先行拦截次数:', stats.architectureFirstEnforcements);
console.log('自动调试触发次数:', stats.autoDebugTriggers);
console.log('债务升级次数:', stats.debtEscalations);
console.log('当前模式:', stats.currentMode);
console.log('架构先行启用:', stats.architectureFirstEnabled);
console.log('自动检测运行中:', stats.autoDetectionRunning);
console.log('已附加模块:', stats.attachedModules);
```

### 优雅关闭

```javascript
// 关闭时自动停止自动检测、清空历史、释放所有依赖引用
orchestrator.shutdown();
```

## 依赖关系

### 内部依赖

| 模块 | 路径 | 用途 |
|------|------|------|
| `EventEmitter` | Node.js 内置 | 事件发射基类 |
| `debug` | `../../utils/debug-logger` | 调试日志输出 |
| `withShutdown` | `../../utils/shutdown-mixin` | 优雅关闭混入，提供 `guardShutdown()` / `shutdown()` / `_onShutdown()` |
| `BoundedArray` | `../../utils/bounded-array` | 有界数组，用于瓶颈诊断历史记录管理 |

### 外部集成

| 模块 | 注入方法 | 调用接口 | 说明 |
|------|---------|---------|------|
| **DeliveryEfficiencyMeter** | `attachDeliveryEfficiencyMeter()` | `getReviewBottleneckScore()`<br>`getReviewThroughputImbalance()`<br>`getCodingRatio()`<br>`getAiAccelerationRatio()`<br>`getPipelineBottleneck()` | 交付效率度量，提供审查吞吐和管道瓶颈数据 |
| **AiCodeTrustScorer** | `attachAiCodeTrustScorer()` | `assess()`<br>`getRiskDistribution()`<br>`getAverageScore()` | AI代码可信度评估，检测"似对非对"代码模式 |
| **ComprehensionDebtTracker** | `attachComprehensionDebtTracker()` | `calculateDebtScore()` | 理解债务追踪，量化理解不足程度 |
| **ContextDriftMonitor** | `attachContextDriftMonitor()` | `checkDrift()`<br>`getDriftTrend()`<br>`getStats()` | 上下文漂移监控，检测长任务中的约束丢失 |
| **AgentDebugLoop** | `attachAgentDebugLoop()` | `execute()` | Agent自调试闭环，自动检测和修复隐蔽缺陷 |
| **CodeReviewFrameworkCheck** | `attachCodeReviewFrameworkCheck()` | `runChecklist()` | 代码审查框架检查器 |
| **PhaseOrchestrator** | `attachPhaseOrchestrator()` | `setCurrentPhase()`<br>`getCurrentPhase()` | 阶段编排器，提供当前阶段信息 |
| **SddContractManager** | `attachSddContractManager()` | `advanceStage()`<br>`listContracts()`<br>`checkSpecCoverage()` | SDD合约管理，验证架构先行门禁 |

### 集成流程

```
1. 创建 DeliveryAccelerationOrchestrator 实例
2. 通过 attach*() 方法链式注入8个依赖模块
3. 调用 diagnoseBottlenecks() 执行瓶颈诊断，或 startAutoDetection() 启动自动检测
4. 诊断结果驱动：
   a. 架构先行门禁 — checkArchitectureFirstGate() 拦截未完成架构设计的编码请求
   b. 工作流重构 — recommendWorkflowMode() 推荐最佳模式，switchWorkflowMode() 执行切换
5. 监听事件获取实时通知（diagnosis-completed / architecture-first-blocked / workflow-mode-changed）
6. 关闭时调用 shutdown() 停止自动检测、清空历史、释放依赖引用
```

---

## 相关文档

- [模块详解-PhaseOrchestrator阶段编排器](模块详解-PhaseOrchestrator阶段编排器.md)
- [模块详解-SDD规格驱动开发](模块详解-SDD规格驱动开发.md)
- [模块详解-质量子系统](模块详解-质量子系统.md)
- [模块详解-ShutdownMixin关机混入](模块详解-ShutdownMixin关机混入.md)
