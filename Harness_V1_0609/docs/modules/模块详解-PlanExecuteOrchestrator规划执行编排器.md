# 模块详解 - PlanExecuteOrchestrator 规划-执行编排器

> 版本：2.73.4 | 源码：`src/runtime/workflow/plan-execute-orchestrator.js`

---

## 概述

PlanExecuteOrchestrator 是融合 "AI 先规划后执行" 范式的核心编排器，实现了完整的 "规划 → 执行 → 验证 → 重新规划" 闭环。它解决了传统自动化"步骤固定、容错率低"的痛点，让 AI 具备"思考能力"——执行失败时自动回溯到规划层，重新评估并生成新步骤。

## 核心特性

- **规划层**：目标自动分解为可执行步骤，支持字符串和对象两种步骤格式
- **执行层**：步骤式执行，每步前置校验 + 后置验证
- **失败驱动重新规划**：执行/验证失败自动回溯到规划层，生成替代步骤
- **三级升级策略**：retry → replan → decompose，逐级升级容错
- **验证闭环**：可选的 verifyFn 在步骤执行后验证结果质量
- **事件驱动**：完整的生命周期事件（plan-started/created/completed/failed, step-started/completed/failed, replan-triggered, decompose-triggered）

## 与现有模块的关系

| 现有模块 | PlanExecuteOrchestrator 补充的能力 |
|---------|-----------------------------------|
| GoalExecutor | 补充"失败后自动重新分解"闭环（GoalExecutor只重试不调整计划） |
| TaskLifecycleOrchestrator | 补充"Evaluator→Planner反馈通道"（TLO验收失败不回溯Planner） |
| WorkflowDAG | 补充"失败驱动替代节点注入"（DAG只支持质量驱动深化） |
| PipelineExecutor | 补充"验证失败后重新规划"（Pipeline是线性的，不支持循环） |
| RetryEngine | 补充"内置重新规划和分解"（RetryEngine的replan/decompose需外部提供） |

## 常量

### STEP_STATUS

| 状态 | 值 | 说明 |
|------|------|------|
| PENDING | `'pending'` | 待执行 |
| RUNNING | `'running'` | 执行中 |
| COMPLETED | `'completed'` | 已完成 |
| FAILED | `'failed'` | 已失败 |
| SKIPPED | `'skipped'` | 已跳过 |
| REPLANNED | `'replanned'` | 已被重新规划替代 |

### PLAN_STATUS

| 状态 | 值 | 说明 |
|------|------|------|
| PLANNING | `'planning'` | 规划中 |
| EXECUTING | `'executing'` | 执行中 |
| VERIFYING | `'verifying'` | 验证中 |
| REPLANNING | `'replanning'` | 重新规划中 |
| COMPLETED | `'completed'` | 已完成 |
| FAILED | `'failed'` | 已失败 |

### ESCALATION_LEVELS

| 级别 | 值 | 说明 |
|------|------|------|
| RETRY | `'retry'` | 重试当前步骤 |
| REPLAN | `'replan'` | 重新规划替代步骤 |
| DECOMPOSE | `'decompose'` | 分解为更细粒度子步骤 |

## 构造函数

```javascript
new PlanExecuteOrchestrator(config)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| config.maxStepRetries | number | 2 | 单步骤最大重试次数 |
| config.maxReplanCount | number | 3 | 最大重新规划次数 |
| config.maxDecomposeDepth | number | 2 | 最大分解深度 |
| config.verifyFailureTriggersReplan | boolean | true | 验证失败是否触发重新规划 |
| config.stepTimeoutMs | number | 0 | 步骤超时（0=不限） |
| config.historySize | number | 100 | 历史记录容量 |

## 核心 API

### execute(objective, fns, context?)

执行完整的规划-执行循环。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| objective | string | 目标描述 |
| fns.planFn | Function | 规划函数：`(objective, context) => steps[]` |
| fns.executeFn | Function | 执行函数：`(step, context) => result` |
| fns.verifyFn | Function | 验证函数（可选）：`(step, result, context) => {passed, reason}` |
| fns.replanFn | Function | 重新规划函数（可选）：`(objective, failedStep, reason, context) => steps[]` |
| fns.decomposeFn | Function | 分解函数（可选）：`(objective, context) => steps[]` |
| context | Object | 执行上下文（可选） |

**返回值：**

```javascript
{
  success: boolean,
  steps: number,          // 成功时：执行的步骤数
  replanCount: number,    // 成功时：重新规划次数
  reason: string,         // 失败时：失败原因
  failedStepId: string,   // 失败时：失败步骤ID
  failureReason: string,  // 失败时：失败原因描述
}
```

### getStatus()

获取当前计划状态。

### getStats()

获取统计信息（plansCreated, stepsExecuted, stepsCompleted, stepsFailed, replansTriggered, decomposesTriggered, escalations）。

### getHistory(limit)

获取执行历史。

## 事件

| 事件名 | 数据 | 说明 |
|--------|------|------|
| `plan-started` | `{objective}` | 规划开始 |
| `plan-created` | `{objective, stepCount}` | 计划创建完成 |
| `plan-completed` | `{objective, stepCount}` | 计划执行完成 |
| `plan-failed` | `{objective, failedStepId, failureReason}` | 计划执行失败 |
| `plan-status-changed` | `{status}` | 计划状态变更 |
| `step-started` | `{stepId, description}` | 步骤开始执行 |
| `step-completed` | `{stepId, result}` | 步骤执行完成 |
| `step-failed` | `{stepId, error, retryCount}` | 步骤执行失败 |
| `step-verification-failed` | `{stepId, reason}` | 步骤验证失败 |
| `replan-triggered` | `{objective, failedStepId, failureReason, replanCount}` | 触发重新规划 |
| `replan-completed` | `{newStepCount, replanCount}` | 重新规划完成 |
| `decompose-triggered` | `{objective, failedStepId, decomposeDepth}` | 触发分解 |
| `decompose-completed` | `{subStepCount, decomposeDepth}` | 分解完成 |

## 三级升级策略

```
步骤执行/验证失败
    ↓
retryCount ≤ maxStepRetries?
    ├─ YES → 重试当前步骤（retryCount++）
    └─ NO ↓
replanCount < maxReplanCount && replanFn?
    ├─ YES → 调用 replanFn 生成替代步骤，插入步骤列表
    └─ NO ↓
decomposeDepth < maxDecomposeDepth && decomposeFn?
    ├─ YES → 调用 decomposeFn 分解为子步骤，替换失败步骤
    └─ NO → 标记计划失败（escalation-exhausted）
```

## 使用示例

```javascript
const { PlanExecuteOrchestrator } = require('./src/runtime/workflow/plan-execute-orchestrator');

const peo = new PlanExecuteOrchestrator({
  maxStepRetries: 2,
  maxReplanCount: 3,
  maxDecomposeDepth: 2,
});

// 监听重新规划事件
peo.on('replan-triggered', (data) => {
  console.log(`步骤 ${data.failedStepId} 失败，触发第 ${data.replanCount} 次重新规划`);
});

const result = await peo.execute('抓取3个平台的竞品价格并生成对比表', {
  // 规划函数：将目标分解为步骤
  planFn: async (objective, ctx) => {
    return [
      '登录3个电商平台',
      '定位价格页面',
      '抓取关键数据',
      '汇总格式化',
      '生成对比表格',
    ];
  },

  // 执行函数：执行单个步骤
  executeFn: async (step, ctx) => {
    // 调用实际的执行逻辑（如浏览器自动化）
    return await executeStep(step);
  },

  // 验证函数：验证步骤结果（可选）
  verifyFn: async (step, result, ctx) => {
    if (!result || result.error) {
      return { passed: false, reason: result.error || '执行返回空结果' };
    }
    return { passed: true };
  },

  // 重新规划函数：失败后生成替代步骤（可选）
  replanFn: async (objective, failedStep, reason, ctx) => {
    // 根据失败原因生成替代方案
    return ['尝试备用登录方式', '使用API替代页面抓取'];
  },

  // 分解函数：将失败步骤分解为更细粒度子步骤（可选）
  decomposeFn: async (objective, ctx) => {
    return ['检查网络连接', '验证账号状态', '重试登录'];
  },
});
```

## 融合来源

本模块融合了 "AI 先规划后执行" 范式的核心机制：

| 范式要求 | PlanExecuteOrchestrator 实现 |
|---------|----------------------------|
| 规划层：任务解构+步骤拆解 | `planFn` 回调 + `_normalizeSteps` 规范化 |
| 执行层：前置校验+实时监控+后置验证 | `executeFn` + `verifyFn` + 事件流 |
| 规划-执行联动：Plan Agent与Execute Agent分离 | `planFn`/`replanFn`（规划） vs `executeFn`（执行） |
| 容错：执行失败→规划层重新评估 | `_escalateOnFailure` 三级升级策略 |
| 动态步骤调整 | `replanFn` 生成替代步骤 + `decomposeFn` 分解 |
