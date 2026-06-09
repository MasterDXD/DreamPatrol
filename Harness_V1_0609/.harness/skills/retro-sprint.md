---
skill_id: retro-sprint
name: Sprint回顾
applicable_agents: [architect, task-worker]
trigger: Sprint周期结束后需要回顾总结时
auto_trigger: false
phase: deployment
priority: 8
trigger_conditions:
  - sprint cycle completes and retrospective is needed
  - user mentions "Sprint回顾" or "retrospective" or "复盘" or "回顾总结"
  - deployment phase completes a sprint milestone
depends_on: [deployment]
blocks: []
causal_inputs:
  - name: deployment-record
    source: deployment
    required: false
  - name: sprint-commits
    source: version-control
    required: false
causal_outputs:
  - name: retro-report
    description: Sprint回顾报告
  - name: improvement-suggestions
    description: 改进建议清单
evidence_types:
  required:
    - retro_report
enforcement: optional
model_tier: medium
tags: [retro, retrospective, sprint, review]
verified: true
stability: beta
---

# Skill: Sprint回顾

## 任务目标
对已完成的Sprint周期进行系统回顾，总结经验教训，生成可执行的改进建议。通过AI共著提交追踪，量化团队产出和效率。遵循Boil the Lake原则——只关注可落地的改进，不做空洞的总结。

## 执行步骤

### 周期回顾框架

1. **数据收集**：
   - 统计本Sprint的提交数量和频率
   - 统计完成的任务数和故事点
   - 收集Bug数量和修复时长
   - 收集代码审查轮次和阻塞时长

2. **AI共著提交追踪**：
   - 识别AI辅助生成的提交（通过commit message标记）
   - 计算AI共著比例：AI共著提交数 / 总提交数
   - 分析AI辅助效率：AI共著提交的平均完成时长 vs 纯人工提交
   - 识别AI辅助效果最佳的模块和任务类型

3. **做得好的（Keep）**：
   - 列出本Sprint中有效的实践和流程
   - 识别效率最高的工作模式
   - 标注值得继续强化的协作方式

4. **需要改进的（Improve）**：
   - 列出导致延迟或质量问题的流程瓶颈
   - 识别反复出现的Bug模式
   - 标注资源分配不合理的地方

5. **应该尝试的（Try）**：
   - 基于改进项提出具体的新实践建议
   - 每个建议必须包含：目标、实施步骤、预期效果
   - 不超过3个新建议（避免同时改变太多变量）

### 改进建议生成

- 每个改进建议必须满足SMART原则（具体、可衡量、可达成、相关、有时限）
- 建议必须关联到具体的改进项，不可泛泛而谈
- 建议必须考虑团队当前能力和资源约束
- 高优先级建议不超过2个，确保可执行

## 验收标准
- 回顾报告包含：数据统计、Keep/Improve/Try分类、改进建议
- AI共著比例已计算并分析
- 改进建议符合SMART原则且不超过3个
- 报告中无空洞的总结（每条结论必须有数据支撑）
- 高优先级改进建议有明确的下Sprint执行计划

## 角色边界约束
- **禁止**：讨论下Sprint的功能规划（这是计划阶段的工作）
- **禁止**：提出超过3个改进建议（避免改进疲劳）
- **禁止**：在缺乏数据支撑时做出结论
- **禁止**：将"团队需要更努力"作为改进建议

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 对已完成的Sprint周期进行系统回顾，通过数据收集、AI共著提交追踪、Keep/Improve/Try分类框架，总结经验教训并生成符合SMART原则的可执行改进建议。

### Q: 适用于哪些场景？
A: 适用于Sprint周期结束后的回顾总结，包括迭代开发回顾、版本发布复盘、团队效率分析和AI辅助开发效果评估。特别适合需要量化团队产出和效率的场景。

### Q: 使用此Skill的前提条件是什么？
A: 需要已完成的Sprint周期数据，包括部署记录、提交历史、Bug数量和代码审查轮次等。建议已使用AI共著标记（commit message标记）来追踪AI辅助开发效果。
