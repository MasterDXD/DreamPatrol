# 模块详解-CollaborationModeRouter模块

## 概述

CollaborationModeRouter 负责根据任务特征自动选择最优协作模式，支持 solo/pair/chain/ensemble/deepening 五种模式，并通过置信度评分和推理链提供模式选择依据。

## 模块位置

`src/runtime/collaboration/collaboration-mode-router.js`

## 五种协作模式

| 模式 | 说明 | 适用场景 | 最少Agent数 |
|------|------|---------|------------|
| `solo` | 单 Agent 独立执行 | 简单任务、低复杂度 | 1 |
| `pair` | 双 Agent 结对协作 | 代码审查、方案讨论 | 2 |
| `chain` | 链式顺序执行 | 多步骤流水线任务 | 2+ |
| `ensemble` | 多 Agent 并行投票 | 高不确定性决策 | 3+ |
| `deepening` | 深化迭代精化 | 复杂推理、质量不达标 | 2+ |

## 模式选择算法

### 输入特征

```javascript
{
  taskDescription: string,    // 任务描述
  taskTraits: string[],       // 任务特征标签
  availableAgents: number,    // 可用 Agent 数量
  sessionId: string           // 会话 ID
}
```

### 评分维度

| 维度 | 权重 | 说明 |
|------|------|------|
| 复杂度匹配 | 0.3 | 任务复杂度与模式复杂度的匹配度 |
| Agent 利用率 | 0.2 | 可用 Agent 数量与模式需求的匹配度 |
| 特征匹配 | 0.3 | 任务特征标签与模式适用场景的匹配度 |
| 历史表现 | 0.2 | 该模式在类似任务上的历史成功率 |

### 输出

```javascript
{
  mode: 'pair',               // 选中的模式
  confidence: 0.87,           // 置信度 [0, 1]
  reasoning: '...',           // 选择推理链
  allScores: {                // 所有模式评分
    solo: 0.3,
    pair: 0.87,
    chain: 0.45,
    ensemble: 0.6,
    deepening: 0.52
  }
}
```

## 关键 API

| 方法 | 签名 | 说明 |
|------|------|------|
| `selectMode` | `selectMode(context)` | 选择最优协作模式，返回 `{ mode, confidence, reasoning, allScores, taskTraits, availableAgents }` |
| `attachSubagentExecutor` | `attachSubagentExecutor(se)` | 注入子Agent执行器，要求 `se.spawn` 方法存在。返回 `this` 支持链式调用 |
| `attachAgentChannel` | `attachAgentChannel(ac)` | 注入Agent通道，要求 `ac.send` 方法存在。返回 `this` 支持链式调用 |
| `executeWithMode` | `executeWithMode(task, executeFn, verifyFn)` | 按选定模式执行任务，自动降级到solo模式 |
| `overrideMode` | `overrideMode(sessionId, mode)` | 手动覆盖协作模式。覆盖有效期1小时，最多100个覆盖。返回 `true/false` |
| `clearOverride` | `clearOverride(sessionId)` | 清除指定会话的模式覆盖。返回 `true/false` |
| `getModeConfig` | `getModeConfig(mode)` | 获取模式配置详情，返回 `{ mode, description, bestFor, minAgents, maxAgents, signals, taskTraits }`。模式不存在时返回 `null` |
| `getAllModes` | `getAllModes()` | 获取所有模式列表，返回 `{ mode, description, bestFor, minAgents, maxAgents }[]` |
| `getHistory` | `getHistory(limit)` | 获取模式选择历史，默认返回最近10条记录 |
| `getStats` | `getStats()` | 获取统计信息，返回 `{ totalSelections, modeCounts, activeOverrides, availableModes }` |
| `shutdown` | `shutdown()` | 优雅关闭（via withShutdown mixin）。清理定时器、清除覆盖和历史记录 |

## 执行流程

```
selectMode(context)
    ↓
_calculateScores(context)  ←── 计算各模式评分
    ↓
_selectBestMode(scores)  ←── 选择最高分模式
    ↓
executeWithMode(task, executeFn, verifyFn)
    ↓
[mode?] ──solo──→ executeFn(task)
    │──pair──→ pairChat.execute(task, executeFn, verifyFn)
    │──chain──→ chatChain.execute(task, executeFn, verifyFn)
    │──ensemble──→ subagentExecutor.executeParallel(task, agents)
    └──deepening──→ deepeningOrchestrator.execute(task, executeFn, verifyFn)
```

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `mode-selected` | 模式选择完成 | `{ mode, confidence, reasoning }` |

## 协作子模块

CollaborationModeRouter 在 `pair`、`chain`、`ensemble` 模式下分别委托给以下三个子模块执行。它们共同构成了协作层的核心能力。

### PairChat — 结对编程

**文件**: `src/runtime/collaboration/pair-chat.js`

两个 Agent 以 PROPOSER / REVIEWER 角色结对协作，通过提议-审查-批准/拒绝流程达成共识。

#### 常量定义

| 常量 | 值 | 说明 |
|------|---|------|
| `CHAT_ROLES.PROPOSER` | `'proposer'` | 提议者角色 |
| `CHAT_ROLES.REVIEWER` | `'reviewer'` | 审查者角色 |
| `CONSENSUS_STATES.PENDING` | `'pending'` | 待定 |
| `CONSENSUS_STATES.APPROVED` | `'approved'` | 已批准 |
| `CONSENSUS_STATES.REJECTED` | `'rejected'` | 已拒绝 |
| `CONSENSUS_STATES.NEEDS_REVISION` | `'needs_revision'` | 需要修订 |

#### 配置项

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxRounds` | number | 10 | 最大协商轮次 |
| `requireApproval` | boolean | true | 是否需要显式批准才能达成共识 |
| `autoApproveThreshold` | number | 0.9 | 自动批准的置信度阈值 |

#### 关键 API

| 方法 | 签名 | 说明 |
|------|------|------|
| `startSession` | `startSession(config)` | 创建结对会话，返回 `sessionId` |
| `propose` | `propose(sessionId, content)` | PROPOSER 提交提议 |
| `review` | `review(sessionId, corrections)` | REVIEWER 提交审查修正 |
| `approve` | `approve(sessionId)` | 显式批准当前提议 |
| `reject` | `reject(sessionId, reason)` | 拒绝当前提议并说明原因 |
| `getSession` | `getSession(sessionId)` | 获取会话详情 |
| `getStats` | `getStats()` | 获取统计信息 `{ totalCorrections, totalRounds, totalSessions }` |

#### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `session-started` | 会话创建 | `{ sessionId, config }` |
| `proposal-made` | 提议提交 | `{ sessionId, content }` |
| `review-completed` | 审查完成 | `{ sessionId, corrections }` |
| `consensus-reached` | 共识达成 | `{ sessionId, state }` |
| `consensus-rejected` | 共识被拒绝 | `{ sessionId, reason }` |

#### 近期 Bug 修复

- **`_evaluateConsensus()` 共识判断修复**：当 `requireApproval=true` 且未显式批准时，现在正确返回 PENDING 状态，而非错误地自动达成共识
- **`_onShutdown()` 统计结构修复**：关闭时的统计结构现在与初始化结构一致 `{ totalCorrections, totalRounds, totalSessions }`，避免下游消费者因字段缺失报错

---

### ChatChain — 链式对话

**文件**: `src/runtime/collaboration/chat-chain.js`

多 Agent 按链式顺序执行任务，支持任务依赖阻塞检测、预定义阶段链模板和自动重试机制。

#### 常量定义

**TASK_STATUS** — 任务状态：

| 状态 | 说明 |
|------|------|
| `PENDING` | 待执行 |
| `IN_PROGRESS` | 执行中 |
| `COMPLETED` | 已完成 |
| `SKIPPED` | 已跳过 |
| `FAILED` | 已失败 |
| `BLOCKED` | 被阻塞 |

**ATOMIC_TASK_CHAINS** — 预定义链模板：

| 阶段 | 说明 |
|------|------|
| `brainstorming` | 头脑风暴阶段任务链 |
| `requirement-analysis` | 需求分析阶段任务链 |
| `architecture-design` | 架构设计阶段任务链 |

#### 关键 API

| 方法 | 签名 | 说明 |
|------|------|------|
| `createChain` | `createChain(phase, customTasks)` | 创建任务链，可指定阶段模板或自定义任务列表，返回 `{ chainId }` |
| `startTask` | `startTask(chainId, taskId)` | 启动指定任务，会先检查依赖阻塞状态 |
| `completeTask` | `completeTask(chainId, taskId, output)` | 完成任务并传递输出 |
| `failTask` | `failTask(chainId, taskId, error)` | 标记任务失败，根据重试计数决定是否可重试 |
| `retryTask` | `retryTask(chainId, taskId)` | 重试失败的任务 |
| `getChain` | `getChain(chainId)` | 获取链详情 |
| `getStats` | `getStats()` | 获取统计信息 `{ totalChains, completedChains, failedChains, totalTasks, completedTasks }` |

#### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `chain-created` | 链创建 | `{ chainId, phase }` |
| `task-started` | 任务启动 | `{ chainId, taskId }` |
| `task-completed` | 任务完成 | `{ chainId, taskId, output }` |
| `task-failed` | 任务失败 | `{ chainId, taskId, error }` |
| `chain-completed` | 链完成 | `{ chainId }` |
| `chain-failed` | 链失败 | `{ chainId, error }` |

#### 近期 Bug 修复

- **`startTask()` TypeError 修复**：现在将 `this._buildTaskIndex(chain)` 传递给 `_isTaskBlocked()`，防止在检查任务阻塞状态时因缺少任务索引而抛出 TypeError
- **`failTask()` 重试逻辑修复**：将 `task._retryCount <= MAX_RETRIES` 改为 `task._retryCount < MAX_RETRIES`，修正了差一错误（off-by-one），确保重试次数正确
- **`_onShutdown()` 统计结构修复**：关闭时的统计结构现在与初始化结构一致 `{ totalChains, completedChains, failedChains, totalTasks, completedTasks }`，避免下游消费者因字段缺失报错

---

### OutputFusion — 输出融合

**文件**: `src/runtime/collaboration/output-fusion.js`

将多个 Agent 的输出结果按策略融合为最终结果，支持四种内置策略和自定义策略注册。

#### 内置策略

| 策略名 | 说明 |
|--------|------|
| `majority-vote` | 多数投票，选择出现次数最多的输出 |
| `weighted-average` | 加权平均，按 `weightKey` 指定的权重字段计算加权结果 |
| `best-of` | 最优选择，选择权重最高的输出 |
| `consensus` | 共识策略，要求 `minAgreement` 比例的 Agent 达成一致 |

#### 策略配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `minAgreement` | number | 0.6 | 共识策略最低一致率阈值 |
| `weightKey` | string | `'confidence'` | 加权策略使用的权重字段名 |

#### 关键 API

| 方法 | 签名 | 说明 |
|------|------|------|
| `fuse` | `fuse(outputs, strategy)` | 按指定策略融合多个输出，返回融合结果 |
| `registerStrategy` | `registerStrategy(name, strategyFn)` | 注册自定义融合策略，`strategyFn(outputs, config) => result` |
| `getStrategies` | `getStrategies()` | 获取所有可用策略列表 |
| `getStats` | `getStats()` | 获取统计信息 |

#### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `fusion-complete` | 融合完成 | `{ strategy, outputCount, result }` |
| `strategy-registered` | 策略注册 | `{ name }` |

#### 近期 Bug 修复

- **`_extractVote()` 空值防护修复**：在 `String()` 转换前增加 `undefined`/`null` 检查，防止 "undefined"/"null" 字符串被当作有效投票参与计数，导致多数投票策略结果错误

---

## 相关模块

- [模块详解-GoalExecutor目标执行器](模块详解-GoalExecutor目标执行器.md) — 目标执行
- [模块详解-DeepeningOrchestrator模块](模块详解-DeepeningOrchestrator模块.md) — 深化推理
- [深度拆解-任务调度执行链路](../deep-dive/深度拆解-任务调度执行链路.md) — 执行链路
