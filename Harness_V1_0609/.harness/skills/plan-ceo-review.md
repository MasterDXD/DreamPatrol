---
skill_id: plan-ceo-review
name: CEO产品审查
applicable_agents: [architect]
trigger: 需要从创始人视角重新思考产品范围时
auto_trigger: false
phase: brainstorming
priority: 1
trigger_conditions:
  - brainstorming or office-hours skill completes with validated direction
  - user mentions "CEO审查" or "产品范围" or "scope review" or "范围审查"
  - product scope needs re-evaluation before architecture design
depends_on: [brainstorming]
blocks: [architecture-design]
causal_inputs:
  - name: validation-report
    source: office-hours
    required: false
  - name: design-document
    source: brainstorming
    required: true
causal_outputs:
  - name: scope-decision
    description: 范围决策（4种模式之一）
  - name: review-checklist-result
    description: 产品审查清单结果
evidence_types:
  required:
    - scope_decision
enforcement: recommended
model_tier: large
tags: [product, scope, ceo-review]
verified: true
stability: stable
---

# Skill: CEO产品审查

## 任务目标
从创始人视角审视产品范围，决定本Sprint应该扩张、选择性扩张、维持还是缩减。遵循Boil the Lake原则——不做无目的的范围膨胀，每个功能必须有明确的用户价值支撑。

## 执行步骤

### 4种范围模式（必须选择其一并说明理由）

1. **Expansion（扩张）**：
   - 适用条件：核心指标强劲增长，团队有余力
   - 风险：资源分散导致核心功能质量下降
   - 必须回答：扩张的领域是否与核心价值主张一致？

2. **Selective-Expansion（选择性扩张）**：
   - 适用条件：部分指标好，部分指标弱
   - 策略：只扩张与强指标相关的领域，修复弱指标
   - 必须回答：为什么选择这个方向扩张而不是其他？

3. **Hold（维持）**：
   - 适用条件：核心指标稳定但未达预期
   - 策略：聚焦优化现有功能，不增加新功能
   - 必须回答：维持期间的关键优化目标是什么？

4. **Reduction（缩减）**：
   - 适用条件：核心指标下滑或资源严重不足
   - 策略：砍掉低价值功能，聚焦核心
   - 必须回答：哪些功能可以砍掉而不影响核心用户？

### 10项产品审查清单

1. 本Sprint的核心目标是否清晰且可衡量？
2. 每个功能是否有明确的用户故事和验收标准？
3. 是否存在"以防万一"的功能？（如有，删除）
4. 功能优先级是否按用户价值而非技术便利排序？
5. 是否有功能可以推迟到下个Sprint而不影响核心体验？
6. 资源分配是否与优先级匹配？
7. 是否考虑了技术债务的偿还？
8. 是否有明确的"不做什么"清单？
9. 成功指标是否可量化、可追踪？
10. 是否有Plan B应对关键假设失败？

## 验收标准
- 明确选择了一种范围模式并给出理由
- 10项审查清单全部有明确结论
- 输出范围决策文档包含：模式选择、理由、功能增删列表、优先级排序
- "不做什么"清单至少包含3项

## 角色边界约束
- **禁止**：讨论具体技术架构（这是工程审查的工作）
- **禁止**：在缺乏数据支撑时选择Expansion模式
- **禁止**：将"竞品有这个功能"作为增加功能的理由
- **禁止**：同时选择多个范围模式

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 从创始人视角审视产品范围，通过4种范围模式（扩张/选择性扩张/维持/缩减）和10项产品审查清单，决定本Sprint的产品策略，确保每个功能都有明确的用户价值支撑。

### Q: 适用于哪些场景？
A: 适用于Sprint规划阶段的产品范围决策，特别是在头脑风暴和方向验证完成后、架构设计开始前，需要对产品功能进行优先级排序和范围锁定。

### Q: 使用此Skill的前提条件是什么？
A: 需要已完成头脑风暴（brainstorming）和YC创业顾问审查（office-hours），有明确的产品方向和验证报告。建议提供核心指标数据以支撑范围决策。
