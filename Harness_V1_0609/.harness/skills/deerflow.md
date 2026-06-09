---
skill_id: deerflow
name: deerflow
phase: module-development
trigger: "manual"
auto_trigger: false
priority: "normal"
version: 1.0.0
enforcement: recommended
applicable_agents: [architect, task-worker]
description: DeerFlow 2.0超级智能体框架融合 — 任务调度拆解、安全隔离审计、跨会话记忆、模型兼容
trigger_conditions:
  - "deerflow"
  - "超级智能体"
  - "任务拆解"
  - "容器沙箱"
  - "结果聚合"
  - "跨会话记忆"
  - "模型兼容"
tags: [deerflow, agent, orchestration, sandbox, memory]
verified: true
stability: stable
---

# DeerFlow 2.0 超级智能体框架融合

## 概述

融合DeerFlow 2.0超级智能体框架的五大核心能力：

1. **任务调度与拆解** — Agent调度中枢，拆解复杂任务，自动派出子agent分头执行，最后汇总交付结果
2. **丰富内置技能** — 写研报、建网站、做PPT、生成视频等多种内置技能
3. **安全隔离与审计** — 每个任务运行在独立沙箱中，拥有自己的文件系统，可读写文件、执行代码
4. **跨会话记忆** — 跨会话记忆能力，使用得越多越能理解用户需求
5. **模型兼容性** — 支持接入GPT、豆包等任意模型

## 核心模块

### ContainerSandboxManager
容器沙箱管理器，支持三级隔离（进程/容器/Worktree），Docker容器生命周期管理，资源限制，审计日志。

### TaskDecomposer
任务分解器，基于关键词检测和LLM的自动任务分解，支持四种策略（顺序/并行/混合/管道），依赖图构建。

### ResultAggregator
结果聚合器，五种聚合策略（投票/融合/摘要/层级/择优），质量评估，多Agent输出合成。

## 使用方式

在对话中提及以下关键词触发：
- `deerflow` / `超级智能体` — 启动DeerFlow模式
- `任务拆解` / `decompose` — 任务分解
- `容器沙箱` / `sandbox` — 安全隔离
- `结果聚合` / `aggregate` — 多Agent结果汇总

## 目标

融合DeerFlow 2.0超级智能体框架的五大核心能力，实现复杂任务的智能分解、安全隔离执行和多Agent协同交付。通过任务调度拆解、容器沙箱隔离、结果聚合、跨会话记忆和模型兼容性，将超级智能体框架的最佳实践集成到Harness工程化体系中。

## 步骤

1. 分析任务的复杂度和可分解性，确定是否需要启用任务拆解
2. 使用TaskDecomposer将复杂任务分解为子任务，选择适合的分解策略（顺序/并行/混合/管道）
3. 为每个子任务分配独立的容器沙箱（ContainerSandboxManager），配置资源限制和审计日志
4. 派出子Agent并行或顺序执行子任务，监控执行状态
5. 使用ResultAggregator选择合适的聚合策略（投票/融合/摘要/层级/择优）汇总子任务结果
6. 对聚合结果进行质量评估，必要时触发重新执行或调整
7. 利用跨会话记忆能力，将任务执行经验写入记忆供后续任务参考
8. 确保模型兼容性，必要时切换或组合不同AI模型

## 验收

- 复杂任务已正确分解为可独立执行的子任务
- 每个子任务在独立沙箱中安全执行，无跨任务干扰
- 子任务结果已按合适的聚合策略汇总，质量评估通过
- 执行过程中的关键信息已写入跨会话记忆
- 模型选择和切换流畅，无兼容性问题
- 最终交付结果完整、准确，满足原始任务要求

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 融合DeerFlow 2.0超级智能体框架的五大核心能力：任务调度与拆解、丰富内置技能、安全隔离与审计、跨会话记忆和模型兼容性，实现复杂任务的智能分解和多Agent协同执行。

### Q: 适用于哪些场景？
A: 适用于需要将复杂任务自动拆解为子任务、在独立沙箱中安全执行、并由多Agent并行处理最终汇总结果的场景。特别适合大规模自动化任务调度和需要安全隔离的执行环境。

### Q: 使用此Skill的前提条件是什么？
A: 需要Harness框架的Agent运行时环境，已部署ContainerSandboxManager、TaskDecomposer和ResultAggregator等核心模块，并配置好所需的AI模型接入（如GPT、豆包等）。
