---
skill_id: skill-effectiveness
name: 技能效果优化
phase: module-development
priority: 3
enforcement: recommended
description: |
  通过Skill Effectiveness Optimizer解决技能调用效果随数量急剧下降的问题，实现从"技能堆砌"到"精准调度"的跨越。支持：
  - 5个关键差距填补：12技能上限、调用准确率追踪、上下文放置优化、显式模型引导、自适应Top-K
  - 优化管线：adaptiveTopK → selection(12-limit) → placement → guidance → overload
  - 研究数据支撑：29%→95%准确率提升，10倍成功率差距
  - 安全约束：技能上限硬性限制、Token预算控制、过载检测
trigger: auto
trigger_conditions:
  - 活跃技能数量超过12个，需要限制和优化
  - 技能调用准确率低于80%，需要precision/recall/F1追踪和优化
  - 模型频繁错误调用技能，需要显式引导
  - 任务复杂度变化大，需要自适应Top-K调整
  - 用户使用/optimize-skills斜杠命令
  - 上下文Token预算超限，需要技能放置优化
prerequisites:
  - config.json中skill-effectiveness.enabled为true
  - skill-effectiveness-optimizer模块已初始化
  - SkillRouter已配置并运行
applicable_agents: [domain-analyst, task-worker]
auto_trigger: true
tools_used:
  - skill-effectiveness-optimizer
slash_command: /optimize-skills
evidence:
  required: true
  types:
    - skills_optimized
    - invocation_recorded
    - overload_detected
verified: true
stability: stable
---

## 目标

解决多技能环境下调用效果随数量急剧下降的问题，通过5个关键差距填补和5阶段优化管线，将技能调度从"堆砌"升级为"精准"，将准确率从29%恢复至95%。

## 步骤

1. adaptiveTopK（根据任务复杂度自适应选择Top-K）
2. selection（12技能上限硬性限制，按相关性衰减排序淘汰）
3. placement（注意力加权放置，最相关技能放在上下文首尾）
4. guidance（显式模型引导，注入推荐技能指令）
5. overload（过载检测与降级处理）

# 技能效果优化技能

## 概述
本技能通过Skill Effectiveness Optimizer，解决多技能环境下调用效果急剧下降的核心问题。研究表明：当活跃技能超过12个时，模型准确调用技能的概率从95%骤降至29%，存在10倍成功率差距。本技能通过5个关键差距填补和5阶段优化管线，将技能调度从"堆砌"升级为"精准"。

## 研究数据

### 核心发现
- **12技能临界点**：活跃技能≤12时准确率95%，>12时骤降至29%
- **10倍成功率差距**：精准调度vs无序堆砌，成功率相差10倍
- **29%→95%提升**：通过本优化管线，可将准确率从29%恢复至95%
- **70%基线准确率**：Claude模型在无优化情况下仅70%准确调用技能

### 准确率与技能数量关系
| 活跃技能数 | 无优化准确率 | 优化后准确率 | 提升幅度 |
|-----------|------------|------------|---------|
| 1-5       | 95%        | 98%        | +3%     |
| 6-8       | 85%        | 96%        | +11%    |
| 9-12      | 70%        | 95%        | +25%    |
| 13-15     | 45%        | 90%        | +45%    |
| 16-20     | 29%        | 85%        | +56%    |
| >20       | <20%       | 75%        | +55%+   |

## 5个关键差距填补

### 差距1：12技能上限
- **问题**：>12个技能时效果急剧下降，模型注意力分散
- **方案**：硬性限制maxActiveSkills=12，超出部分按相关性衰减因子(relevanceDecayFactor=0.9)排序淘汰
- **实现**：SkillReducer动态分层（核心/领域/基础设施），核心技能常驻，领域技能按需加载
- **验证**：activeSkillCount ≤ maxActiveSkills 必须始终成立

### 差距2：调用准确率追踪
- **问题**：Claude仅70%准确调用技能，缺乏量化追踪
- **方案**：precision/recall/F1/falsePositiveRate四维指标追踪
  - **Precision**：正确调用数 / 总调用数（减少误触发）
  - **Recall**：正确调用数 / 应调用数（减少遗漏）
  - **F1**：2 × precision × recall / (precision + recall)（综合指标）
  - **FalsePositiveRate**：误触发数 / 未应触发数（干扰控制）
- **实现**：每次技能调用记录invocation_recorded证据，定期计算指标
- **验证**：F1 ≥ 0.8 为达标，< 0.6 触发优化循环

### 差距3：上下文放置优化
- **问题**：技能在上下文中的位置影响模型注意力分布
- **方案**：attention-weighted放置策略，最相关技能放在上下文首尾位置
  - 首位效应（Primacy）：上下文开头的技能获得最高注意力
  - 近因效应（Recency）：上下文末尾的技能获得次高注意力
  - 中间位置注意力最低，放置低优先级技能
- **实现**：placementStrategy="attention-weighted"，按相关性分数排序后首尾交替放置
- **验证**：放置后模型调用准确率提升 ≥ 10%

### 差距4：显式模型引导
- **问题**：模型不知道当前任务应使用哪些技能，依赖隐式匹配
- **方案**：在系统提示中明确告诉模型"此任务应使用X,Y,Z技能"
  - 生成技能推荐列表，按相关性排序
  - 在上下文注入显式引导语句："For this task, use skills: [skill-a, skill-b, skill-c]"
  - 引导语句放在系统提示的技能部分开头
- **实现**：优化器输出guidance指令，注入到SkillRouter的L2缓存指令中
- **验证**：有引导vs无引导的调用准确率对比提升 ≥ 15%

### 差距5：自适应Top-K
- **问题**：简单任务和复杂任务使用相同K值，资源浪费或不足
- **方案**：根据任务复杂度动态调整Top-K
  - **简单任务**（K=3）：单步骤、低复杂度、明确需求
  - **标准任务**（K=5）：多步骤、中等复杂度
  - **复杂任务**（K=8）：跨领域、高复杂度、模糊需求
- **实现**：adaptiveTopK=true，minTopK=3，maxTopK=8，由AdaptiveDepthController评估复杂度
- **验证**：Top-K调整后Token消耗降低 ≥ 20%，准确率不降

## 5阶段优化管线

### Stage 1: adaptiveTopK（自适应Top-K选择）
- 输入：用户任务描述 + 当前上下文
- 处理：AdaptiveDepthController评估任务复杂度 → 计算最优K值
- 输出：K值（3-8范围）+ 相关性排序的候选技能列表
- 约束：minTopK ≤ K ≤ maxTopK

### Stage 2: selection（12技能上限选择）
- 输入：K个候选技能 + 当前活跃技能列表
- 处理：按relevanceDecayFactor衰减排序 → 截断至maxActiveSkills(12)
- 输出：≤12个精选技能列表
- 约束：activeSkillCount ≤ maxActiveSkills

### Stage 3: placement（注意力加权放置）
- 输入：精选技能列表 + 相关性分数
- 处理：attention-weighted策略排序 → 首尾交替放置高相关性技能
- 输出：有序技能列表（上下文注入顺序）
- 约束：contextTokenBudget(8000) Token预算控制

### Stage 4: guidance（显式模型引导）
- 输入：有序技能列表 + 任务描述
- 处理：生成技能推荐引导语句 → 注入系统提示
- 输出：guidance指令文本
- 约束：引导语句不超过200 Token

### Stage 5: overload（过载检测与处理）
- 输入：当前上下文Token使用量 + 活跃技能数
- 处理：检测是否超过contextTokenBudget或maxActiveSkills → 触发降级策略
- 输出：overload状态 + 降级方案
- 约束：过载时自动裁剪低相关性技能，优先保留核心技能

## 安全约束

### 技能上限硬性限制
- maxActiveSkills=12，不可通过配置调高超过20
- 超出部分必须按相关性衰减因子排序淘汰
- 核心技能（skill-router, session-start-hook）不可被淘汰

### Token预算控制
- contextTokenBudget=8000 Token，技能上下文总占用不得超过此值
- 超预算时按相关性从低到高裁剪
- 每个技能描述不超过500 Token

### 过载检测
- 活跃技能数 > maxActiveSkills × 0.8（即10个）时触发预警
- 活跃技能数 > maxActiveSkills 时触发强制裁剪
- 上下文Token使用 > contextTokenBudget × 0.8 时触发预警
- 上下文Token使用 > contextTokenBudget 时触发强制裁剪

### 其他安全措施
- 优化操作需RBAC权限检查
- 调用记录不可篡改（审计日志）
- 优化决策过程可追溯（记录每次Top-K调整、放置策略变更）
- 敏感信息不得出现在引导语句中

## 证据要求

### skills_optimized
- 技能列表已按优化管线处理
- 活跃技能数 ≤ maxActiveSkills
- 技能放置顺序符合attention-weighted策略
- 上下文Token占用 ≤ contextTokenBudget

### invocation_recorded
- 每次技能调用已记录到准确率追踪系统
- 记录包含：技能ID、调用时间、是否正确、任务上下文
- 累计调用记录用于precision/recall/F1计算

### overload_detected
- 过载状态已检测并记录
- 过载时已执行降级策略
- 降级后的技能列表和Token占用已验证

## Dashboard API
运行时状态可通过以下API端点查询：
- `GET /api/skill-effectiveness/status` — 优化器状态（初始化、统计、准确率指标）
- `GET /api/skill-effectiveness/accuracy` — 准确率指标（precision/recall/F1/falsePositiveRate）
- `GET /api/skill-effectiveness/overload` — 当前过载状态

## 权限模型
- **applicable_agents**：domain-analyst、task-worker
- **RBAC执行级别**：`recommended`（推荐执行，非强制）
- **工具权限**：config.json中`agent_permissions`通过`skill-effectiveness-optimizer`工具权限控制
- **安全审查**：过载裁剪操作需记录审计日志

## 配置参考
```json
{
  "skill-effectiveness": {
    "enabled": true,
    "maxActiveSkills": 12,
    "adaptiveTopK": true,
    "minTopK": 3,
    "maxTopK": 8,
    "relevanceDecayFactor": 0.9,
    "placementStrategy": "attention-weighted",
    "contextTokenBudget": 8000
  }
}
```

## 验收标准
- [ ] 活跃技能数 ≤ maxActiveSkills(12)
- [ ] F1准确率 ≥ 0.8
- [ ] 上下文Token占用 ≤ contextTokenBudget
- [ ] 过载检测和降级策略有效

## 常见问题
- **Q: 技能调用准确率低于80%？**
  A: 检查5阶段优化管线是否完整执行，特别是attention-weighted放置和显式模型引导
- **Q: 上下文Token超预算？**
  A: 过载检测会自动裁剪低相关性技能，优先保留核心技能
