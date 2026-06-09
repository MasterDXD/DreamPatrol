# 模块详解 — RalphWiggumLoop 自主开发闭环

> 所属子系统：[[工作流子系统]] | 依赖：[[MetaSkillOrchestrator元技能编排]] [[CapabilityGapAnalyzer]] | 参考：OpenAI Harness Engineering | 版本：2.73.4

---

## 模块概述

`RalphWiggumLoop` 是 Harness Engineering 范式的核心引擎，实现了 OpenAI 提出的自主开发闭环（Ralph Wiggum Loop）。工程师通过 Prompt 描述任务启动 AI，AI 自主完成编码、审查、测试、修复的循环，甚至能互相审查代码，人类无需介入。

**核心理念**：代码从"昂贵的资产"变成"廉价的编译产物"，可随时生成和丢弃。工程师的价值从"写代码"迁移到"设计让代码产生的环境"。

**源码位置**：`src/runtime/workflow/ralph-wiggum-loop.js`（~880行）

---

## 模块定位

在 Harness 工作流子系统中，`RalphWiggumLoop` 是最高层级的自主开发闭环引擎：

- **OptimizationLoop**：单目标迭代优化，负责收敛检测和快照回滚
- **TaskLifecycleOrchestrator**：三层体系（Planner→Generator→Evaluator）的任务生命周期管理
- **RalphWiggumLoop**：完整的自主开发闭环，集成生成、审查、测试、修复、学习全流程

---

## 架构角色

```
                          RalphWiggumLoop
                    ┌─────────────────────────────────────┐
  Prompt ──────────→│  run(taskDescription, context)      │
                    │   ├── decomposeTask()               │
                    │   │    └── 深度优先策略拆解模块      │
                    │   ├── for each module:              │
                    │   │    ├── _generateCode()          │──→ MetaSkillOrchestrator
                    │   │    │                            │    / SkillExecutor
                    │   │    ├── _reviewCode()            │──→ AdversarialReview
                    │   │    ├── _testCode()              │──→ TestRunner
                    │   │    ├── _fixCode()               │──→ SkillExecutor(bug-fix)
                    │   │    └── _learnFromResult()       │──→ AutoReinLearningLoop
                    │   └── on failure:                   │
                    │        └── CapabilityGapAnalyzer    │──→ 能力缺口分析
                    │                                     │
  外部依赖 ────────→│  _metaSkillOrchestrator              │
                    │  _skillExecutor                     │
                    │  _optimizationLoop                  │
                    │  _adversarialReview                 │
                    │  _autoReinLearningLoop              │
                    │  _stateGraph                        │
                    │  _testRunner                        │
                    └─────────────────────────────────────┘
```

---

## 核心设计原则

### 1. 深度优先策略
将大目标拆解为小模块，让 AI 逐个完成。任务拆解基于关键词匹配和任务类型推断，支持 12 种功能关键词和 6 种任务类型。

### 2. 失败时回溯环境
不是"再试一次"，而是分析"缺了什么能力"。通过 `CapabilityGapAnalyzer` 进行六维能力缺口分析（技能、工具、规则、CI/CD、文档、测试）。

### 3. 代码即编译产物
代码可随时生成和丢弃，环境才是真正的资产。每个模块的代码在审查和测试失败时可以自动修复或重新生成。

### 4. 自主验证闭环
编码 → 审查 → 测试 → 修复 → 学习，形成完整闭环。支持自动修复（autoFix）和自动学习（autoLearn）。

---

## 工作流（Ralph Wiggum Loop）

```
 Prompt → [Generate] → [Review] → [Test] → [Fix] → [Learn] → Done
              ↑                                     │
              └─────────── Capability Gap ──────────┘
```

### 状态转换

```
IDLE → ANALYZING → GENERATING → REVIEWING → TESTING → COMPLETED
                      ↓              ↓          ↓
                    FIXING ←──────────────────────┘
                      ↓
                    GAP_ANALYSIS → FAILED
```

---

## 依赖注入

RalphWiggumLoop 采用依赖注入模式，所有外部依赖通过 `attach*` 方法注入：

| 方法 | 注入类型 | 用途 |
|------|----------|------|
| `attachMetaSkillOrchestrator(o)` | MetaSkillOrchestrator | 技能编排与流水线执行 |
| `attachSkillExecutor(fn)` | Function | 技能执行器回调 |
| `attachOptimizationLoop(loop)` | OptimizationLoop | 迭代优化与收敛检测 |
| `attachAdversarialReview(review)` | AdversarialReview | 对抗性代码审查 |
| `attachAutoReinLearningLoop(loop)` | AutoReinLearningLoop | 自增强学习 |
| `attachStateGraph(graph)` | StateGraph | 状态机编排引擎 |
| `attachTestRunner(fn)` | Function | 测试执行器回调 |

---

## 任务拆解规则

`decomposeTask()` 函数基于关键词匹配（词边界）将任务描述拆解为模块：

| 关键词 | 模块名称 | 优先级 |
|--------|----------|--------|
| api | API Layer | 1 |
| auth | Authentication | 1 |
| database | Database Layer | 2 |
| security | Security | 2 |
| config | Configuration | 2 |
| ui | UI Components | 3 |
| log | Logging | 3 |
| error | Error Handling | 3 |
| test | Test Suite | 4 |
| migrate | Migration | 4 |
| deploy | Deployment Config | 5 |
| doc | Documentation | 5 |

未匹配任何关键词时，根据任务类型使用默认模块列表。

> **v2.32.1 修复**：`decomposeTask()` 中模块依赖计算已修正。此前当匹配模式非连续时（如仅匹配 `auth` 和 `ui` 而跳过中间关键词），依赖会错误引用未匹配关键词的模块ID。现已修正为引用实际前一模块的ID（`modules[matchCount - 2].id`），确保依赖链始终正确。

---

## 使用示例

```javascript
const RalphWiggumLoop = require('./src/runtime/workflow/ralph-wiggum-loop');

const loop = new RalphWiggumLoop({
  maxIterations: 10,
  autoFix: true,
  autoLearn: true,
  gapAnalysisOnFailure: true,
});

// 注入依赖
loop.attachSkillExecutor(async (skillId, context) => {
  // 执行具体技能
  return { result: 'generated code' };
});
loop.attachTestRunner(async (testCommand, context) => {
  // 运行测试
  return { success: true, failures: [], output: 'All tests passed' };
});

// 启动自主开发闭环
const result = await loop.run('build a REST API with auth and database', {
  projectRoot: '/path/to/project',
  environment: { hasCI: true, hasLint: true, hasTests: true },
});

console.log(result.summary);
console.log('Completed modules:', result.modules.completed.length);
console.log('Failed modules:', result.modules.failed.length);
if (result.gapAnalysis) {
  console.log('Gap analysis:', result.gapAnalysis.summary);
}
```

---

## 事件

| 事件 | 触发时机 | 数据 |
|------|----------|------|
| `state-change` | 状态变更时 | `{ from, to }` |
| `module-start` | 模块开始处理时 | `{ module, id }` |
| `module-complete` | 模块完成时 | `{ module, success, completed, total }` |
| `iteration-start` | 迭代开始时 | `{ module, iteration }` |
| `iteration-complete` | 迭代完成时 | `{ module, iteration, success, phase }` |
| `gap-detected` | 检测到能力缺口时 | `{ phase, module, gaps }` |
| `review-result` | 审查结果产生时 | `{ module, iteration, result }` |
| `test-result` | 测试结果产生时 | `{ module, iteration, result }` |
| `loop-complete` | 闭环成功完成时 | 完整结果对象 |
| `loop-failed` | 闭环失败时 | `{ reason, failedModules, gaps }` |

---

## 配置选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `maxIterations` | 10 | 每个模块的最大迭代次数 |
| `maxDepth` | 5 | 最大模块拆分深度 |
| `reviewRounds` | 2 | 审查轮数 |
| `testTimeoutMs` | 60000 | 测试超时（毫秒） |
| `convergeThreshold` | 0.85 | 收敛阈值 |
| `autoFix` | true | 是否自动修复 |
| `autoLearn` | true | 是否自动学习 |
| `gapAnalysisOnFailure` | true | 失败时是否进行缺口分析 |
| `haltOnCriticalGap` | true | 是否在关键缺口时停止 |
| `maxModuleCount` | 20 | 最大模块数 |