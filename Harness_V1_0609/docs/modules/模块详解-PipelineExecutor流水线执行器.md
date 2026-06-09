# 模块详解-PipelineExecutor流水线执行器

## 概述

PipelineExecutor 是 Harness 框架的中央请求处理流水线，将用户请求从输入到输出的完整生命周期编排为：命令解析 → 意图识别 → 技能匹配 → 协作模式选择 → 前置检查 → 执行（含超时/中止） → 后置验证（证据/目标/覆盖率）。

**源码位置**：`src/runtime/workflow/pipeline-executor.js`（344行）

## 架构角色

```
用户消息 → executePipeline()
              ↓
         ┌────────────────────────────────────────────┐
         │ 1. 命令解析 (CommandRouter)                 │
         │ 2. 意图识别 (StructuredIntent)              │
         │ 3. 技能匹配 (SkillRouter)                   │
         │ 4. 前置Hook (pre_tool_call)                 │
         │ 5. 协作模式选择 (CollaborationModeRouter)    │
         │ 6. TDD前置检查 (TDDGate)                    │
         │ 7. 执行 (超时+中止控制)                      │
         │ 8. 证据验证 (EvidenceVerifier)              │
         │ 9. 目标验证 (GoalVerification)              │
         │10. 覆盖率验证 (TDDGate)                     │
         │11. 后置Hook (post_task_complete)            │
         │12. 文件写入Hook (post_file_write)           │
         └────────────────────────────────────────────┘
              ↓
         PipelineResult
```

## 核心 API

### executePipeline(ctx, userMessage, options)

主入口函数，处理用户请求的完整流水线。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `ctx` | PipelineContext | 流水线上下文，包含所有子系统引用 |
| `userMessage` | string | 用户消息 |
| `options` | object | 执行选项 |

**ctx 必需字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `commandRouter` | CommandRouter | 斜杠命令路由 |
| `structuredIntent` | StructuredIntent | 意图解析器 |
| `router` | SkillRouter | 技能路由 |
| `programmableHookExecutor` | ProgrammableHookExecutor | Hook执行器 |
| `collaborationModeRouter` | CollaborationModeRouter | 协作模式路由 |
| `tddGate` | TDDGate | TDD门禁 |
| `verifier` | EvidenceVerifier | 证据验证器 |
| `structuredLog` | StructuredLog | 结构化日志 |
| `projectRoot` | string | 项目根目录 |

**options 可选字段**：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `agent` | string | — | 当前Agent角色 |
| `sessionId` | string | — | 会话ID |
| `completedSkills` | string[] | [] | 已完成技能列表 |
| `executeFn` | Function | — | 执行函数 |
| `verifyFn` | Function | — | 验证函数 |
| `timeout` | number | 300000 | 执行超时(ms) |
| `signal` | AbortSignal | — | 中止信号 |
| `tddContext` | object | — | TDD上下文 |
| `requireThinking` | boolean | — | 是否要求思考 |
| `evidence` | object | — | 完成证据 |
| `goalVerification` | object | — | 目标验证数据 |
| `successCriteriaOverride` | string[] | — | 覆盖成功标准 |

## 流水线阶段详解

### 1. 早期返回检查

验证系统状态和输入有效性：
- 系统关闭中 → 返回 `SHUTDOWN_IN_PROGRESS` 错误
- 空消息 → 返回 `INVALID_INPUT` 错误

### 2. 命令解析

通过 CommandRouter 检查是否为斜杠命令（如 `/plan`、`/code-review`），如果是则获取命令执行计划。

### 3. 意图识别

通过 StructuredIntent 解析用户消息，提取：
- `goal`：目标描述
- `constraints`：约束条件
- `successCriteria`：成功标准
- `clarificationNeeded`：是否需要澄清

如果需要澄清，直接返回 `clarification_needed` 状态。

### 4. 技能匹配

- 斜杠命令：使用命令计划中的技能列表
- 普通消息：通过 SkillRouter 语义匹配
- 匹配后加载 L2 缓存（详细指令）

### 5. 前置Hook执行

执行 `pre_tool_call` Hook，任何 Hook 返回 `passed: false` 则阻止执行。

### 6. 协作模式选择

通过 CollaborationModeRouter 选择执行模式：
- `solo`：单Agent执行
- `pair`：双Agent协作
- `chain`：链式执行
- `ensemble`：多Agent集成
- `deepening`：深化推理

### 7. TDD前置检查

- TDD门禁检查（RED-GREEN-REFACTOR）
- Think Before Coding 检查

### 8. 执行

- 通过 `CollaborationModeRouter.executeWithMode` 执行
- 支持超时控制（默认5分钟）
- 支持 AbortSignal 中止
- AbortSignal 通过 `executeWithMode` 的 `options.signal` 参数传播至协作模式执行层，确保超时或外部中止信号能穿透到子执行器
- 超时后标记 `orphanedExecution`，标识该执行已脱离管道管控，后续结果不再被管道采纳

### 9. 后置验证

| 验证类型 | 条件 | 说明 |
|---------|------|------|
| 证据验证 | `opts.evidence` 存在 | 验证完成证据的充分性 |
| 目标验证 | `task.successCriteria` + `opts.goalVerification` | 验证成功标准达成 |
| 覆盖率验证 | `opts.tddContext.coverage` 存在 | TDD覆盖率门禁 |

### 10. 后置Hook执行

- `post_task_complete`：任务完成Hook
- `post_file_write`：文件写入Hook（当有 diff/changes/files 时）

## 返回值结构

### 成功

```javascript
{
  status: 'success',
  requestId: string,
  intent: object,
  matchedSkills: SkillMatch[],
  command: { commandId, name } | null,
  mode: string,
  modeConfidence: number,
  task: object,
  preToolChecks: HookResult[],
  executed: boolean,
  execution: object,
  evidenceVerification: object,
  goalVerification: object,
  postTaskChecks: HookResult[],
  fileWriteChecks: HookResult[],
  durationMs: number,
  timestamp: number
}
```

### 其他状态

| status | 说明 |
|--------|------|
| `clarification_needed` | 需要用户澄清意图 |
| `blocked` | 前置Hook阻止执行 |
| `thinking_required` | 需要先思考再编码 |
| `tdd_violation` | TDD门禁违规 |
| `timeout` | 执行超时 |
| `execution_error` | 执行错误 |
| `evidence_insufficient` | 证据不充分 |
| `goal_not_achieved` | 目标未达成 |
| `aborted` | 操作被中止 |

## 与其他模块的关系

| 模块 | 关系 |
|------|------|
| CommandRouter | 斜杠命令解析 |
| StructuredIntent | 意图识别 |
| SkillRouter | 技能匹配 |
| CollaborationModeRouter | 协作模式选择与执行 |
| TDDGate | TDD门禁检查 |
| EvidenceVerifier | 证据验证 |
| ProgrammableHookExecutor | 前置/后置Hook执行 |
| StructuredLog | 性能日志记录 |

## 设计决策

1. **函数式设计**：PipelineExecutor 采用纯函数式设计（导出 `executePipeline` 函数），而非类，保持无状态
2. **早期返回**：每个阶段都有明确的退出条件，避免不必要的计算
3. **超时保护**：默认5分钟超时，防止无限等待
4. **中止支持**：通过 AbortSignal 支持外部中止
5. **分层验证**：证据→目标→覆盖率三层后置验证，确保交付质量
