# 模块详解-GoalExecutor目标执行器

> 版本：2.73.4 | 文件：src/runtime/workflow/goal-executor.js

## 概述

GoalExecutor 位于 `src/runtime/workflow/goal-executor.js`，是框架的核心目标执行引擎，负责将高层目标分解为子任务、执行迭代收敛、管理超时和取消信号。继承自 `EventEmitter`，支持目标持久化（`.harness/goals/`）、自动任务分解、自主迭代收敛循环、停滞检测、TTL过期清理、并发控制和异步原子写入。

## 核心架构

### 目标状态机

```
PENDING → DECOMPOSING → EXECUTING → ITERATING → COMPLETED
               ↘            ↘           ↘
                PAUSED ←────┘           FAILED
               ↘                        CANCELLED
                                         BLOCKED
```

| 状态 | 说明 |
|------|------|
| PENDING | 目标已创建，等待执行 |
| DECOMPOSING | 正在分解子任务 |
| EXECUTING | 目标执行中（含子任务执行前的验证阶段） |
| ITERATING | 迭代执行循环中 |
| PAUSED | 目标已暂停，可恢复 |
| COMPLETED | 目标已完成 |
| FAILED | 目标执行失败 |
| CANCELLED | 目标已取消 |
| BLOCKED | 子任务因循环依赖被阻塞 |

### 子任务状态

| 状态 | 说明 |
|------|------|
| PENDING | 子任务等待执行 |
| RUNNING | 子任务执行中 |
| COMPLETED | 子任务已完成 |
| FAILED | 子任务执行失败 |
| SKIPPED | 子任务被跳过 |
| BLOCKED | 子任务因未满足依赖被阻塞 |

### 构造参数

```javascript
new GoalExecutor(options?)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.projectRoot` | string | - | 项目根目录 |
| `options.maxIterations` | number | 10 | 最大迭代次数 |
| `options.convergenceThreshold` | number | 0.85 | 收敛阈值（0-1） |
| `options.maxSubtasks` | number | 20 | 最大子任务数 |
| `options.iterationTimeout` | number | DEFAULT_SUBTASK_TIMEOUT_MS | 迭代超时时间 |
| `options.persistInterval` | number | DEFAULT_METRICS_FLUSH_MS | 持久化刷新间隔 |
| `options.goalTTL` | number | 7天 | 目标过期时间 |
| `options.maxConcurrentGoals` | number | 5 | 最大并发目标数 |
| `options.autoDecompose` | boolean | true | 是否自动分解子任务 |
| `options.autoIterate` | boolean | true | 是否自动迭代 |
| `options.persistPath` | string | '.harness/goals/' | 持久化路径 |

### 关键方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `createGoal` | `createGoal(objective, options?) → {success, goalId?, error?}` | 创建新目标 |
| `execute` | `execute(goalId, executeFn, options?) → Promise<{success, goalId?, result?, iterations?, qualityHistory?, duration?, error?}>` | 目标执行主入口，含验证+分解+迭代+错误处理 |
| `pause` | `pause(goalId) → {success, goalId?, error?}` | 暂停目标执行 |
| `resume` | `resume(goalId, executeFn, options?) → Promise<{success, goalId?, error?}>` | 恢复暂停的目标执行 |
| `cancel` | `cancel(goalId) → {success, goalId?, error?}` | 取消目标执行 |
| `getGoal` | `getGoal(goalId) → Object\|null` | 获取目标信息 |
| `listGoals` | `listGoals(statusFilter?) → Object[]` | 列出所有目标，可按状态过滤 |
| `getProgress` | `getProgress(goalId) → Object\|null` | 获取目标执行进度 |
| `getStats` | `getStats() → Object` | 获取统计信息 |
| `isHealthy` | `isHealthy() → boolean` | 健康检查 |
| `shutdown` | `shutdown(signal?) → Promise<void>` | 同步持久化后关闭，含双重关闭保护 |
| `shutdownAsync` | `shutdownAsync(signal?) → Promise<void>` | 异步持久化后关闭 |
| `ready` | `get ready() → Promise<void>` | 返回初始化完成的Promise，用于await异步初始化 |

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `ready` | Promise\<void\>（getter） | 异步初始化完成信号。构造函数中启动异步恢复流程，外部可通过`await executor.ready`等待初始化完成后再执行操作 |

### Attach方法（依赖注入）

| 方法 | 注入属性 | 验证方法 |
|------|---------|---------|
| `attachSessionManager(dep)` | `_sessionManager` | `create` |
| `attachPlanPersistence(dep)` | `_planPersistence` | `createPlan` |
| `attachDeepeningOrchestrator(dep)` | `_deepeningOrchestrator` | `execute` |
| `attachSubagentExecutor(dep)` | `_subagentExecutor` | `spawn` |
| `attachThoughtRetrieverCycle(dep)` | `_thoughtRetrieverCycle` | `execute` |
| `attachCausalDataBus(dep)` | `_causalDataBus` | `publishOutput` |

### 事件

| 事件 | 触发时机 |
|------|---------|
| `goal-created` | 目标创建成功 |
| `goal-executing` | 目标开始执行 |
| `goal-decomposing` | 目标开始分解子任务 |
| `goal-decomposed` | 子任务分解完成 |
| `goal-iteration-start` | 迭代开始 |
| `goal-iteration-complete` | 迭代完成 |
| `goal-completed` | 目标执行完成 |
| `goal-failed` | 目标执行失败 |
| `goal-paused` | 目标暂停 |
| `goal-resumed` | 目标恢复 |
| `goal-cancelled` | 目标取消 |
| `circular-dependency-detected` | 检测到循环依赖 |
| `persist-error` | 持久化写入失败 |
| `shutdown` | 执行器关闭 |

### 内部方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `_decomposeGoal` | `_decomposeGoal(goal, executeFn, options)` | 将目标分解为子任务列表 |
| `_runGoalLoop` | `_runGoalLoop(goal, executeFn, options)` | 迭代执行循环，检查收敛条件 |
| `_executeSubtasks` | `_executeSubtasks(goal, executeFn, iterationContext, options)` | 顺序/并行执行子任务 |
| `_executeSubtasksParallel` | `_executeSubtasksParallel(goal, subtasks, executeFn, iterationContext)` | 并行执行子任务 |
| `_executeOneSubtask` | `_executeOneSubtask(goal, subtask, executeFn, iterationContext)` | 执行单个子任务 |
| `_executeSingle` | `_executeSingle(goal, executeFn, iterationContext, options)` | 无子任务时直接执行 |
| `_evaluateIteration` | `_evaluateIteration(result, goal) → number` | 评估迭代质量分数 |
| `_isStagnant` | `_isStagnant(qualityHistory) → boolean` | 停滞检测（最近5轮改进低于阈值） |
| `_detectCircularDependencies` | `_detectCircularDependencies(subtasks) → cycles[]` | 检测子任务循环依赖 |
| `_onShutdown` | `_onShutdown()` | 关闭生命周期钩子：先将所有活跃目标状态持久化为PAUSED，再清除定时器，确保关闭后目标状态可恢复 |

## 超时与取消机制

模块级辅助函数 `_createTimeoutCancelPromises` 统一处理超时和取消信号，消除了 `_executeSubtasksParallel` 和 `_executeOneSubtask` 中的重复逻辑：

```javascript
_createTimeoutCancelPromises(timeoutMs, cancelSignal, timeoutMessage)
```

返回值：

| 属性 | 类型 | 说明 |
|------|------|------|
| `timeoutPromise` | Promise | 超时后 reject HarnessError('TIMEOUT') |
| `cancelPromise` | Promise | AbortSignal 触发后 reject HarnessError('CANCELLED') |
| `cleanup` | Function | 清理定时器和事件监听器 |

使用方式：

```javascript
const { timeoutPromise, cancelPromise, cleanup } = _createTimeoutCancelPromises(
  subtaskTimeout, cancelSignal, 'Subtask ' + subtaskId + ' timed out'
);
const result = await Promise.race([
  executeFn(context, opts),
  timeoutPromise,
  cancelPromise,
]);
cleanup();
```

## 持久化配置

| 常量 | 值 | 说明 |
|------|------|------|
| MAX_PERSIST_RETRIES | 5 | 单个目标最大连续持久化失败次数 |
| MAX_PERSIST_FAIL_COUNTS | 500 | 失败计数Map最大尺寸 |
| MAX_PERSIST_LOCKS | 1000 | 持久化锁Map最大尺寸 |
| PERSIST_LOCK_TIMEOUT_MS | DEFAULT_REQUEST_TIMEOUT_MS | 锁获取超时 |

持久化采用原子写入（`writeAtomicAsync`），锁机制防止并发写入冲突，失败后自动重试，超过重试次数后跳过持久化。

## 关闭机制

- **双重关闭保护**：`shutdown()`方法内置双重关闭检测，若已处于关闭状态则直接返回，避免重复执行关闭逻辑
- **目标状态保留**：`_onShutdown()`在清除定时器之前，先将所有活跃目标（EXECUTING/ITERATING/DECOMPOSING状态）的状态持久化为PAUSED，确保进程重启后可从暂停状态恢复执行

## 收敛与停滞检测

### 质量评分

质量评分由两部分加权组成：

- **基础分数**（权重0.5）：基于子任务完成率或 `qualityScore`/`success` 字段
- **标准满足分数**（权重0.5）：基于 `successCriteria` 在 `verification` 中的通过率

### 停滞判定

当最近5轮迭代的质量改进低于阈值时判定为停滞：
- 若最新分数 ≥ 0.7（内部收敛阈值），改进低于 0.005 判定为停滞
- 否则，改进低于 0.02 判定为停滞

## 统计指标

| 指标 | 说明 |
|------|------|
| `totalGoalsCreated` | 创建的目标总数 |
| `totalGoalsCompleted` | 完成的目标总数 |
| `totalGoalsFailed` | 失败的目标总数 |
| `totalIterations` | 迭代总次数 |
| `totalSubtasksExecuted` | 执行的子任务总数 |
| `activeGoals` | 当前活跃目标数（计算属性） |
| `executingGoals` | 当前执行中目标数（计算属性） |
| `pausedGoals` | 当前暂停目标数（计算属性） |

## 使用示例

```javascript
const GoalExecutor = require('./src/runtime/workflow/goal-executor');

const executor = new GoalExecutor({ projectRoot: '/project' });
const { goalId } = executor.createGoal('Implement user auth', {
  successCriteria: ['login works', 'token refresh works'],
  maxIterations: 5,
});

const result = await executor.execute(goalId, async (ctx, opts) => {
  // ctx 包含 objective, constraints, successCriteria, context 等
  // opts 包含 goalId, phase, timeout, signal 等
  return { success: true, qualityScore: 0.9 };
});
```

## 相关文档

- [核心功能-目标执行引擎](../core/核心功能-目标执行引擎.md)
- [模块详解-PhaseOrchestrator阶段编排器](模块详解-PhaseOrchestrator阶段编排器.md)
