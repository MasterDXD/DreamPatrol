---
skill_id: dynamic-harness
name: dynamic-harness
version: 1.0.0
description: Anthropic 动态工作流 Harness — AI 自动生成调度脚本，实现从"概率黑盒"到"工业级确定性工程"的跨越
phase: workflow
priority: 85
enforcement: always
applicable_agents: ["task-worker"]
trigger: "manual"
auto_trigger: false
trigger_conditions:
  - "workflow"
  - "ultracode"
  - "harness"
  - "动态工作流"
  - "并行Agent"
  - "对抗验证"
  - "检查点"
  - "断点续跑"
  - "确定性工程"
  - "子Agent并行"
  - "调度脚本"
verified: true
stability: stable
---

# 动态工作流 Harness (Dynamic Workflow Harness)

## 概述

融合 Anthropic 动态工作流 Harness 理念：让 AI 针对任务自动生成调度脚本，
实现从"概率黑盒"到"工业级确定性工程"的跨越。

核心公式：**Agent = Model + Harness**
模型决定能力上限，Harness 决定能否驾驭它完成复杂任务。

## 三大突破

1. **确定性代码框住概率输出** — AI 生成 JavaScript 脚本，将任务拆解、子 Agent 并行、
   校验器调用等逻辑"写死"在代码里，用确定性程序约束模型的概率性输出。

2. **自带对抗验证** — A Agent 写代码，B Agent 专门挑错，甚至调用更强的模型审查，
   过不了验证闭环就无法推进，保障输出质量。

3. **留痕容灾** — 内置检查点机制，哪怕任务跑了 3 小时、派了数百个子 Agent 中途被叫停，
   也能记住执行状态，下次继续从断点运行。

## 使用方式

在 Prompt 中加入以下关键字触发动态工作流：
- `workflow` — 触发动态工作流编排
- `ultracode` — 触发 UltraCode 模式
- `harness` — 触发 Harness 工程模式
- `动态工作流` — 中文触发

**示例：**

```
筛选 80 份简历，自动排序，复核前十，生成评估报告 workflow
```

```
将代码库从 JavaScript 迁移到 TypeScript，确保测试通过率 99% ultracode
```

## 高级功能

- **Token 预算**：在 Prompt 中指定 `此任务仅用 1 万 Token` 设置预算上限
- **并行度控制**：支持最多 20 个子 Agent 并行工作
- **对抗验证**：自动启用双审查者对抗验证
- **检查点恢复**：中断后可从最近检查点继续执行

## 集成组件

- `DynamicHarnessGenerator` — 核心引擎：脚本生成 + 沙箱执行 + DSL API
- `DynamicWorkflowEngine` — DAG 工作流引擎
- `TaskDecomposer` — 任务分解器
- `SubagentExecutor` — 子 Agent 执行器（worker/team 模式）
- `AdversarialReview` — 对抗性审查
- `CheckpointManager` — 检查点管理
- `CapabilityGapAnalyzer` — 能力缺口分析

## 目标

让AI针对任务自动生成确定性调度脚本，实现从"概率黑盒"到"工业级确定性工程"的跨越。通过确定性代码框住概率输出、自带对抗验证和留痕容灾三大突破，确保复杂任务以可靠、可恢复、可验证的方式执行。

## 步骤

1. 分析任务的复杂度、并行度和容错要求，评估是否适用动态工作流模式
2. 使用DynamicHarnessGenerator自动生成任务调度脚本，将任务拆解、子Agent并行、校验器调用等逻辑固化为确定性代码
3. 在沙箱环境中执行生成的调度脚本，启用Token预算和并行度控制
4. 启动对抗验证：A Agent执行任务，B Agent独立审查输出质量
5. 启用检查点机制（CheckpointManager），在关键节点保存执行状态
6. 中断恢复时从最近检查点继续执行，避免从头重跑
7. 验证闭环：输出必须通过对抗验证才能推进到下一阶段
8. 任务完成后清理临时资源并归档执行日志

## 验收

- 调度脚本由AI自动生成且通过语法和逻辑校验
- 子Agent按脚本编排并行执行，并行度受控
- 对抗验证环节已执行，输出质量通过B Agent审查
- 检查点正常保存，中断后可从断点恢复执行
- Token消耗在预算范围内
- 最终交付结果完整、可追溯，执行日志已归档

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 让AI针对任务自动生成调度脚本，实现从"概率黑盒"到"工业级确定性工程"的跨越。通过确定性代码框住概率输出、自带对抗验证和留痕容灾三大突破，确保复杂任务的可靠执行。

### Q: 适用于哪些场景？
A: 适用于需要并行处理大量子任务的场景（如批量简历筛选、代码迁移），需要对抗验证保证输出质量的任务，以及长运行时间任务需要断点续跑能力的场景。

### Q: 使用此Skill的前提条件是什么？
A: 需要Harness框架的DynamicHarnessGenerator、DynamicWorkflowEngine、TaskDecomposer、SubagentExecutor等核心组件已部署，并理解动态工作流的基本概念（如DAG调度、检查点机制）。

### Q: 如何使用对抗验证(verify)功能？
A: 在生成的Harness脚本中调用 `harness.verify(subject, criteria)`，其中：
- `subject` 为待验证对象（可以是执行结果数组或任意数据）
- `criteria` 为验证标准数组，如 `['correctness', 'completeness']`
- 系统会派出两个独立的reviewer对subject进行交叉审查，只有两者都approved才通过验证

### Q: 如何中断后恢复执行？
A: 使用 `DynamicHarnessGenerator.resumeFromCheckpoint(checkpointId)` 可从最近的检查点恢复执行。检查点由脚本中的 `harness.checkpoint(name, data)` 调用自动创建。恢复时需要确保 CheckpointManager 已注入且检查点 ID 有效。

## 实战场景示例

### 场景1：代码迁移

```
将 src/ 目录下所有 JavaScript 文件迁移到 TypeScript，确保测试通过率 99% workflow
此任务仅用 5 万 Token
```

AI 将自动生成包含以下步骤的 Harness 脚本：
1. `harness.decompose()` 拆解迁移任务为多个子模块
2. `harness.parallel()` 并行执行各模块的 JS→TS 转换
3. `harness.verify()` 对抗验证转换结果的类型安全性
4. `harness.checkpoint()` 在每个模块完成时保存检查点
5. `harness.log()` 记录迁移进度

### 场景2：批量简历筛选

```
筛选 80 份简历，按匹配度排序，复核排名前 10，生成评估报告 workflow
```

AI 将生成：
1. 并行处理 80 份简历（`harness.parallel`，max 20 并发）
2. 对抗验证排序结果的公平性（`harness.verify`）
3. 人工复核标记（`harness.checkpoint` 保存中间结果）
4. 生成结构化评估报告

### 场景3：工单自动分流

```
自动处理 200 条客户工单：先分类，再分配到不同处理队列，最后核查事实声明 workflow
```

AI 将生成：
1. `harness.parallel()` 分类工单
2. `harness.sequential()` 逐条核查事实声明
3. `harness.verify()` 核实分流准确性