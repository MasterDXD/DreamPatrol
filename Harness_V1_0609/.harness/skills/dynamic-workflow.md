---
skill_id: dynamic-workflow
name: 动态工作流引擎
applicable_agents: [team-lead, task-worker, domain-analyst]
trigger: 需要动态生成调度脚本或多Agent并行协作时
auto_trigger: true
phase: module-development
priority: 3
trigger_conditions:
  - 用户提到 workflow / harness / dynamic workflow / 动态工作流
  - 用户提到 ultracode / 调度脚本 / 并行执行 / 对抗验证
  - 需要多Agent并行协作和对抗式验证
  - 需要检查点容灾和预算约束
depends_on: []
blocks: []
causal_inputs: []
causal_outputs:
  - name: workflow-result
    description: 工作流执行结果
evidence_types:
  required:
    - execution_report
enforcement: recommended
verified: true
stability: stable
---

# Skill: 动态工作流引擎

Anthropic Dynamic Workflow Harness 融合模块 — AI 运行时动态生成调度脚本。
核心公式：Agent = Model + Harness
让 AI 能力从"不可控的概率输出"变成"可交付的确定性工程"。

## 任务目标
通过动态编译 DSL 调度脚本，将多 Agent 协作任务建模为 DAG 操作序列，实现拓扑排序执行、并行扇出、对抗式验证、检查点容灾和预算约束，确保复杂工作流的可靠交付。

## 执行步骤
1. **编译调度脚本**：
   - 将 AI 生成的 DSL 调度脚本编译为 DAG 操作序列
   - 解析节点依赖关系，构建拓扑排序
2. **执行工作流**：
   - 按拓扑排序执行 DAG，支持并行就绪节点和条件边求值
   - 动态调度子 Agent，扇出并行任务
3. **对抗式验证**：
   - A Agent 写代码，B Agent 专门挑错
   - 过不了验证闭环就无法推进
4. **检查点容灾**：
   - 中途中断可续跑，记住执行状态从断点恢复
   - 支持增量式执行，避免重复工作
5. **预算约束**：
   - Token 预算不足时自动跳过剩余节点或降级
   - 确保任务在预算范围内完成

## 验收标准
- DSL 调度脚本成功编译为有效 DAG
- 工作流按拓扑排序正确执行，并行节点并发调度
- 对抗验证通过，无未解决的错误
- 检查点容灾机制正常工作，中断后可续跑

## 常见问题
- **Q: 用动态工作流并行审查3个模块的代码，然后对抗验证？**
  A: 编译DSL → 并行扇出3个子Agent → 聚合结果 → 对抗验证 → 输出报告
- **Q: workflow: 将简历排序后复核前十？**
  A: 编译DSL → 并行评分 → 条件路由(取Top10) → 对抗复核 → 输出
- **Q: ultracode: 重写模块，Token预算1万？**
  A: 编译DSL → 代码生成 → 验证 → 修复循环 → 预算约束下完成
