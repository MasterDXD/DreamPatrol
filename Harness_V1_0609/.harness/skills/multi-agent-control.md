---
skill_id: multi-agent-control
name: 多智能体系统工程控制
description: 实现多智能体系统三大控制机制（流程控制、Token控制、完成标准），解决无限循环与通信冗余问题
applicable_agents: [team-lead, domain-analyst, task-worker]
trigger: "auto"
auto_trigger: true
phase: [brainstorming, requirement-analysis, architecture-design, module-development, integration-testing]
trigger_conditions:
  - "多智能体"
  - "无限循环"
  - "通信冗余"
  - "熔断"
  - "迭代限制"
  - "回滚"
  - "Token控制"
  - "完成标准"
  - "DoD"
  - "circuit"
  - "iteration"
  - "rollback"
  - "escalation"
priority: 90
depends_on: []
blocks: []
enforcement: recommended
causal_inputs:
  - task-objective
  - agent-communication
  - execution-feedback
causal_outputs:
  - iteration-guard-status
  - context-compression-report
  - dod-evaluation
  - escalation-decision
verified: true
stability: stable
---

# 多智能体系统工程控制 (Multi-Agent System Control)

## 核心问题

多智能体系统在实际运行中面临两大顽疾：

1. **无限循环** — Agent之间互相推诿、反复修正、陷入"你改我审、我审你改"的死循环，消耗大量Token而无法收敛
2. **通信冗余** — Agent之间传递大量重复或低价值信息，上下文窗口被无效内容填满，关键信号被噪声淹没

这两个问题互为因果：循环越多，通信越冗余；冗余越多，收敛越慢，循环越深。

## 三大控制机制

### 机制一：流程控制 (Process Control)

约束Agent协作的行为边界，防止流程失控。

| 控制项 | 参数 | 默认值 | 说明 |
|--------|------|--------|------|
| 迭代上限 | `max_iterations` | 10 | 单任务最大迭代轮次，超出触发熔断 |
| 熔断阈值 | `circuit_breaker_threshold` | 连续3轮无实质进展 | 检测到停滞立即中断当前流程 |
| 回滚上限 | `max_rollbacks` | 2 | 允许的最大回退次数，防止反复推翻重来 |
| 单轮超时 | `round_timeout_ms` | 60000 | 单轮Agent响应超时时间 |

**熔断机制**：
- **软熔断**：连续N轮无实质进展 → 冻结当前策略，切换备选方案
- **硬熔断**：迭代次数达到上限 → 强制终止，输出当前最优结果 + 未完成项清单
- **回滚熔断**：回滚次数达到上限 → 锁定当前版本，禁止进一步回退

**回滚限制**：
- 每次回滚必须记录回滚原因和目标版本
- 回滚后不得再次回滚到比目标版本更早的版本
- 回滚消耗的迭代次数从总预算中扣除

### 机制二：Token控制 (Token Control)

管理上下文窗口的容量分配，确保关键信息始终可见。

**分层上下文模型**：

| 层级 | 名称 | 容量占比 | 内容 | 压缩策略 |
|------|------|----------|------|----------|
| L0 | 核心上下文 | 20% | 任务目标、DoD、当前状态 | 不可压缩，始终保留 |
| L1 | 扩展上下文 | 50% | 结构化摘要、关键决策记录 | 达到80%阈值时触发压缩 |
| L2 | 参考上下文 | 30% | 原始对话、详细过程 | 达到95%阈值时裁剪为摘要 |

**结构化摘要格式**：
```
## 轮次摘要 [Round N]
- 目标: [本轮目标]
- 行动: [执行的关键动作]
- 结果: [产出的关键结果]
- 决策: [做出的关键决策及理由]
- 待办: [遗留到下一轮的事项]
```

**压缩管线 (Compression Pipeline)**：
1. **检测**：监控L1/L2容量占比，达到阈值触发压缩
2. **提取**：从原始内容中提取关键信息（目标、行动、结果、决策）
3. **结构化**：按结构化摘要格式重组
4. **替换**：用压缩后的摘要替换原始内容
5. **验证**：确认压缩后L0信息完整、L1关键决策可追溯

### 机制三：完成标准 (Definition of Done)

量化任务完成的判定条件，确保任务在正确时机终止。

**四类终止条件**：

| 终止条件 | 触发规则 | 输出 |
|----------|----------|------|
| 结果达标 | DoD中所有量化指标满足 | 完整交付物 + 达标报告 |
| 预算耗尽 | Token消耗达到预算上限 | 当前最优结果 + 未完成项清单 |
| 连续无进展 | 连续N轮（默认3轮）无实质性输出变化 | 当前最优结果 + 停滞分析 |
| 超出边界转人工 | 触发硬熔断或回滚上限 | 当前状态快照 + 人工介入建议 |

**DoD量化模板**：
```
## Definition of Done
### 功能性指标
- [ ] 核心功能实现率 >= 95%
- [ ] 关键路径覆盖 = 100%

### 质量性指标
- [ ] 代码审查通过
- [ ] 测试覆盖率 >= 80%

### 约束性指标
- [ ] Token消耗 <= 预算上限
- [ ] 迭代轮次 <= max_iterations
- [ ] 回滚次数 <= max_rollbacks
```

## 洋葱模型 (Onion Model)

三层防护架构，由内向外逐层保护：

```
┌─────────────────────────────────────────┐
│  Outer: 人工接管层 (Human Takeover)       │
│  ┌─────────────────────────────────────┐ │
│  │  Middle: 控制层 (Process + Token)    │ │
│  │  ┌─────────────────────────────────┐ │ │
│  │  │  Core: DoD层 (完成标准)          │ │ │
│  │  │  - 量化终止条件                  │ │ │
│  │  │  - 结果达标判定                  │ │ │
│  │  └─────────────────────────────────┘ │ │
│  │  - 迭代限制 + 熔断机制               │ │
│  │  - 分层上下文 + 压缩管线             │ │
│  └─────────────────────────────────────┘ │
│  - 硬熔断触发人工介入                     │
│  - 回滚上限触发人工决策                   │
│  - 预算耗尽触发人工审批                   │
└─────────────────────────────────────────┘
```

**层级交互规则**：
- Core层独立判定终止条件，不依赖外层
- Middle层为Core层提供运行保障，防止失控
- Outer层是最终安全网，仅在Middle层所有手段失效时触发
- 任何外层不得绕过内层直接干预

## 四大增强组件

### 1. IterationGuard（迭代守卫）

**职责**：监控和限制迭代行为

- 实时追踪每轮迭代的状态变化
- 检测"无实质进展"：对比相邻轮次输出，相似度超过阈值（默认0.95）视为无进展
- 管理迭代计数器，达到上限触发硬熔断
- 记录迭代历史，供回溯分析

**接口**：
```
IterationGuard:
  - check_iteration(round_id, output) → {proceed: bool, reason: string}
  - get_progress_score(round_n, round_n_1) → float  // 0.0~1.0
  - force_terminate(reason) → TerminationReport
```

### 2. ContextPipeline（上下文管线）

**职责**：管理上下文容量和信息流

- 维护L0/L1/L2三层上下文的容量监控
- 执行压缩管线：检测 → 提取 → 结构化 → 替换 → 验证
- 确保L0核心上下文在任何压缩操作中不被丢弃
- 生成上下文压缩报告

**接口**：
```
ContextPipeline:
  - get_capacity_status() → {L0: float, L1: float, L2: float}
  - compress(layer, threshold) → CompressionReport
  - inject_core_context(key, value) → bool  // 写入L0
  - get_structured_summary(round_id) → Summary
```

### 3. DefinitionOfDone（完成标准评估器）

**职责**：评估任务是否达到完成标准

- 解析DoD量化模板，提取可验证指标
- 逐项检查指标达成情况
- 判定四类终止条件的触发
- 生成DoD评估报告

**接口**：
```
DefinitionOfDone:
  - evaluate(current_state) → DoDReport
  - check_termination_conditions() → {terminated: bool, condition: string}
  - get_completion_rate() → float  // 0.0~1.0
  - update_metric(name, value) → bool
```

### 4. OnionModelCoordinator（洋葱模型协调器）

**职责**：协调三层防护的交互

- 监听Core层DoD评估结果
- 调度Middle层控制机制（IterationGuard + ContextPipeline）
- 在Middle层手段耗尽时触发Outer层人工接管
- 维护层级间的状态同步

**接口**：
```
OnionModelCoordinator:
  - coordinate(event) → Action
  - trigger_escalation(reason, context) → EscalationDecision
  - get_system_status() → {core: Status, middle: Status, outer: Status}
  - reset() → void
```

## 与现有模块的集成点

| 现有模块 | 集成方式 | 说明 |
|----------|----------|------|
| MultiAgentOrchestrator | IterationGuard嵌入其迭代循环 | 在每轮迭代开始/结束时调用守卫检查 |
| PhaseOrchestrator | DoD评估绑定到阶段转换 | 阶段切换前必须通过DoD检查 |
| GoalExecutor | ContextPipeline挂载到目标执行管线 | 执行过程中实时监控上下文容量 |
| AgentChannel | 结构化摘要作为消息格式 | Agent间通信强制使用结构化摘要 |
| HumanApprovalGate | OnionModelCoordinator触发人工接管 | Outer层通过现有审批网关实现人工介入 |

**集成顺序建议**：
1. IterationGuard → MultiAgentOrchestrator（最高优先，直接解决无限循环）
2. ContextPipeline → AgentChannel + GoalExecutor（其次，解决通信冗余）
3. DefinitionOfDone → PhaseOrchestrator（第三，确保阶段质量）
4. OnionModelCoordinator → HumanApprovalGate（最后，兜底安全网）

## 可观测性

### 核心监控指标

| 指标 | 采集方式 | 告警阈值 | 说明 |
|------|----------|----------|------|
| 总迭代轮次 | IterationGuard计数器 | >= max_iterations * 0.8 | 接近上限预警 |
| Agent发言次数 | AgentChannel消息计数 | 单Agent占比 > 60% | 发言不均衡 |
| Token消耗量 | ContextPipeline监控 | >= 预算 * 80% | 容量预警 |
| 回滚次数 | IterationGuard记录 | >= max_rollbacks | 接近回滚上限 |
| 终止原因分布 | DoD评估报告聚合 | — | 统计四类终止条件触发频率 |

### 输出报告

每次任务终止时生成控制报告：

```
## 多智能体控制报告
### 基本信息
- 任务ID: [task_id]
- 总迭代轮次: [N / max_iterations]
- 总Token消耗: [used / budget]
- 回滚次数: [N / max_rollbacks]

### 终止分析
- 终止条件: [结果达标/预算耗尽/连续无进展/超出边界转人工]
- DoD完成率: [X%]
- 未完成项: [...]

### 通信分析
- Agent发言分布: {agent_a: N次, agent_b: M次, ...}
- 压缩触发次数: [N次]
- L0信息完整性: [完整/部分丢失]

### 建议
- [针对本次任务的改进建议]
```

## 最佳实践

1. **任务启动时先定义DoD** — 没有量化完成标准就无法判定何时停止，这是控制的基础
2. **迭代预算留余量** — 设置max_iterations时预留20%缓冲，避免在接近完成时被硬熔断
3. **L0核心上下文精而少** — 只放任务目标和DoD，不超过总容量的20%
4. **结构化摘要先行** — Agent间通信优先使用结构化摘要，原始内容仅在必要时传递
5. **回滚是昂贵操作** — 每次回滚消耗迭代预算，优先尝试增量修正而非全量回退
6. **人工介入是正常流程** — Outer层触发不是失败，而是系统按设计工作的体现

## 反模式

| 反模式 | 表现 | 危害 | 解决方案 |
|--------|------|------|----------|
| 无DoD启动 | 任务没有量化完成标准就启动执行 | 无法判定何时停止，无限迭代 | 强制在任务启动时定义DoD |
| 全量上下文传递 | Agent间传递完整对话历史 | Token快速耗尽，关键信息被淹没 | 使用分层上下文 + 结构化摘要 |
| 无限重试 | 失败后不断重试相同策略 | 消耗预算无产出 | 设置连续无进展阈值，触发策略切换 |
| 静默熔断 | 触发熔断但不通知其他Agent | 其他Agent继续无效等待 | 熔断时广播状态变更 |
| 绕过人工接管 | Outer层触发后仍继续自动执行 | 可能产生不可控结果 | 人工审批网关为硬阻断 |
| 过度压缩 | 压缩L0核心上下文 | 丢失任务目标，后续执行偏离 | L0标记为不可压缩，压缩管线跳过 |

## 目标

建立多Agent协作系统的工程控制机制，通过流程控制（迭代上限/熔断/回滚）、Token控制（分层上下文/压缩管线）和完成标准（DoD）三大支柱，解决多Agent系统中无限循环与通信冗余两大核心问题。

## 步骤

1. 在任务启动阶段定义量化完成标准（DoD），包含功能、质量、Token消耗等维度
2. 监控Agent协作迭代轮次，当逼近迭代上限或连续多轮无实质进展时触发熔断
3. 应用分层上下文模型（L0核心/L1扩展/L2参考），按阈值触发压缩管线
4. 生成结构化轮次摘要，替换冗余的原始对话内容
5. 在每次迭代后评估DoD完成度，达标即终止，未达标则判断是否需要人工介入

## 验收

- [ ] 每个任务启动时均有明确的量化DoD定义
- [ ] 连续3轮无进展时自动触发软熔断，切换备选方案
- [ ] 迭代达到上限时硬熔断生效，输出当前最优结果
- [ ] 上下文压缩后L0核心信息完整保留，关键决策可追溯
- [ ] 熔断/回滚/预算耗尽事件均广播通知所有关联Agent

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 为多Agent协作系统提供工程化控制机制，解决Agent间无限循环（互相推诿、反复修正）和通信冗余（上下文窗口被无效内容填满）两大顽疾。

### Q: 适用于哪些场景？
A: 适用于任何涉及多Agent协作的任务场景，特别是：复杂任务拆解与分配、Agent间多次往返交互、长对话上下文管理、以及需要严格收敛保证的关键任务。

### Q: 使用此Skill的前提条件是什么？
A: 需要任务目标已明确，Agent角色分工已定义，并已完成初始任务拆解。熔断和回滚机制需要预先配置参数（迭代上限、熔断阈值、回滚上限等）。
