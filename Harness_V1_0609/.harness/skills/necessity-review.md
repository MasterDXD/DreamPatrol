---
skill_id: necessity-review
name: 必要性审查
trigger: "审查必要性 评估必要性 是否必要 需要这个吗"
auto_trigger: true
phase: module-development
priority: 0
applicable_agents: [domain-analyst, code-reviewer, team-lead]
depends_on: []
blocks: [tdd-implement, module-development, bug-fix]
causal_inputs:
  - name: proposed-change
    required: false
causal_outputs:
  - name: necessity-review-report
    description: 必要性审查报告
evidence_types:
  required:
    - necessity_review_report
trigger_conditions:
  - "新模块创建"
  - "新抽象引入"
  - "新依赖添加"
  - "接口设计"
  - "过度设计"
enforcement: recommended
production_validated: true
stability: stable
usage_count: 0
success_rate: 0
tools:
  - codebase-analyzer: 代码库分析
  - dependency-scanner: 依赖扫描
  - complexity-meter: 复杂度度量
model: claude-3-opus-20240229
verified: true
---

# 必要性审查 — Karpathy原则执行技能

## 触发条件
- 创建新模块或文件前
- 引入新抽象层前
- 添加新依赖前
- 设计新接口前
- 任何超过100行的实现前

## 审查流程

### 第一步：YAGNI检查
对每个新增代码单元，回答以下问题：
1. **现在是否有至少2个调用方？** 如果只有1个，不要创建抽象
2. **是否被明确要求？** 如果是"以防万一"，不要实现
3. **是否比直接实现更简单？** 如果抽象比直接写更复杂，不要抽象
4. **删除后系统是否会崩溃？** 如果不会，可能不需要

### 第二步：孤立代码影响评估（v2.7.109增强）
- 新增代码是否会导致现有import/变量/函数变为未使用的孤立代码？
- 如果产生孤立代码，是否已在同一变更中清理？
- 预存的死代码（非本次变更产生的）是否仅被提及而非删除？
- 评估标准：每行变更应可追溯到用户请求

### 第三步：复杂度评估
- 新增代码行数是否超过解决问题的最小需要？
- 是否存在"灵活性陷阱"（为未来可能的需求预留接口）？
- 是否存在"配置爆炸"（可配置项超过3个且大多数无人使用）？

### 第四步：替代方案评估
- 是否可以用更少的代码解决同样的问题？
- 是否可以复用已有的模块而非创建新的？
- 是否可以用更简单的数据结构替代？

### 第五步：输出审查报告

```markdown
## 必要性审查报告
- **审查对象**：XXX
- **YAGNI评分**：X/4（通过≥3）
- **孤立代码影响**：无/已清理/待清理
- **复杂度评估**：合理/偏高/过度
- **替代方案**：XXX
- **建议**：批准/简化后批准/拒绝
- **简化建议**：XXX（如适用）
```

## 阻塞规则
- YAGNI评分低于2时，自动阻塞实现
- 新增文件超过300行时，必须拆分或证明必要性
- 新增依赖必须证明无法用现有代码替代
- 未清理的自创孤立代码阻塞实现（v2.7.109增强）

## 任务目标
在创建新模块、引入新抽象或添加新依赖前，通过YAGNI原则审查其必要性，防止过度设计和代码膨胀。

## 执行步骤
1. 检测触发条件（新模块创建、新抽象引入、新依赖添加等）
2. 执行YAGNI检查（4项评估）
3. 执行孤立代码影响评估（v2.7.109增强）
4. 执行复杂度评估
5. 执行替代方案评估
6. 输出审查报告
7. 根据评分决定是否阻塞实现

## 验收标准
- 审查报告完整包含YAGNI评分、复杂度评估、替代方案和建议
- YAGNI评分低于2的实现被阻塞
- 新增文件超过300行有拆分建议或必要性证明
- 新增依赖有替代方案分析

## 常见问题
- Q: YAGNI评分2分是否通过？ A: 不通过，需要≥3分才能通过
- Q: 紧急修复是否需要审查？ A: 紧急bug修复可跳过，但事后需补审
- Q: 重构是否需要审查？ A: 如果重构引入新抽象则需要，纯代码整理不需要
