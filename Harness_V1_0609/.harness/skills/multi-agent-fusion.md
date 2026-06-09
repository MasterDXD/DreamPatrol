---
skill_id: multi-agent-fusion
name: 多Agent协同融合
applicable_agents: [team-lead, domain-analyst, task-worker, quality-assurance]
trigger: 需要多个Agent协同处理同一任务时
auto_trigger: true
phase: module-development
priority: 2
trigger_conditions:
  - user mentions "融合" or "协同" or "多Agent" or "fusion" or "merge" or "vote"
  - task requires both implementation and review
  - task complexity assessment identifies multiple task types
  - multi-agent router selects 2+ agents for a task
depends_on: [architecture-design]
blocks: [verification-before-completion]
causal_inputs:
  - name: architecture-document
    source: architecture-design
    required: false
causal_outputs:
  - name: fusion-output
    description: 融合输出
  - name: quality-assessment
    description: 质量评估
evidence_types:
  required:
    - fusion_report
    - agent_affinity_report
enforcement: recommended
verified: true
stability: beta
usage_count: 35
success_rate: 0.78
production_validated: true
---

# Skill: 多Agent协同融合

## 目标
根据任务类型自动选择最佳Agent组合，通过多种融合策略整合多Agent输出，确保最终交付物兼具多角度视角和高质量。

## 核心原则
**MoE提供知识广度，融合提供决策质量。**
借鉴混合专家架构(MoE)的动态专家选择理念，根据任务类型自动选择最佳Agent组合，并通过多种融合策略整合多Agent输出。

## 设计哲学
- **动态路由**：根据任务类型和Agent亲和度动态选择Agent组合（Top-K）
- **亲和度学习**：基于历史执行结果持续学习Agent-任务类型亲和度
- **多策略融合**：cascade/vote/weighted/review四种融合策略适配不同场景
- **负载感知**：结合ConcurrencyController避免Agent过载

## 执行步骤

### Step 1: 任务类型识别
使用MultiAgentRouter识别任务类型：
- 10种任务类型信号：coordination/analysis/implementation/testing/review/deployment/documentation/security/debugging/architecture
- 中英文双语关键词匹配

### Step 2: Agent选择
Top-K选择最佳Agent组合：
- 基于Agent能力画像（strengths + scope）计算亲和度
- 结合历史学习亲和度（AffinityLearner）
- 过滤低于最小亲和度阈值的Agent

### Step 3: 并行/串行执行
根据融合策略决定执行模式：
- cascade: 串行执行，主Agent优先
- vote: 并行执行，独立决策
- weighted: 并行执行，加权融合
- review: 串行执行，实现→审查

### Step 4: 输出融合
使用OutputFusion整合多Agent输出：
- cascade: 主Agent输出优先，补充Agent填补空缺
- vote: 加权投票，高置信度Agent权重更大
- weighted: 按权重加权平均数值字段
- review: 实现者输出+审查者评审

### Step 5: 亲和度更新
根据融合结果更新Agent亲和度：
- 高质量结果→增加亲和度
- 低质量结果→降低亲和度
- 时间衰减防止过时偏好

## 融合策略选择指南
| 场景 | 推荐策略 | 原因 |
|------|---------|------|
| 实现类任务 | cascade | 主Agent实现，补充Agent完善 |
| 决策类任务 | vote | 多角度投票，减少偏见 |
| 数值评估 | weighted | 加权平均，平滑极端值 |
| 质量关键任务 | review | 实现+审查，双重保障 |

## 验收标准
- 多Agent输出已通过融合策略整合
- 融合结果包含各Agent贡献的记录
- 亲和度已根据融合结果更新
- 最终输出质量分数 >= 0.7

## FAQ
**Q: 如何选择融合策略？**
A: 根据任务类型自动选择——实现类用cascade，决策类用vote，数值评估用weighted，质量关键任务用review。

**Q: 如果Agent间输出冲突怎么办？**
A: vote策略通过加权投票解决冲突，review策略通过审查者仲裁。

**Q: 亲和度学习的作用是什么？**
A: 基于历史执行结果持续优化Agent-任务匹配，使后续任务分配更精准。
