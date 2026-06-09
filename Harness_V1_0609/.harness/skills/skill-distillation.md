---
skill_id: skill-distillation
name: 技能蒸馏
phase: module-development
priority: 3
enforcement: optional
description: |
  通过Skill Distiller将高频执行轨迹蒸馏为精炼技能文件，实现从"文档注释"到"活程序压缩优化"的跨越。支持：
  - 三层架构：QMD（本地Markdown记忆库）→ Skills（原子化技能文件）→ Agent Loop（执行循环）
  - 蒸馏管线：captureTrace → distillSkill → rewriteSkillSteps → evaluateDistillation → canaryDeployDistilled
  - 大模型（老师）与小模型（执行者）分工协作
  - 10个关键能力填补清单
  - 安全约束：技能文件备份、回滚机制、金丝雀部署
trigger: auto
trigger_conditions:
  - 用户要求从执行轨迹中提炼或优化技能
  - 某技能执行频率高但效果不稳定，需要蒸馏优化
  - 需要将大模型知识压缩到小模型可执行的技能文件
  - 用户使用/distill斜杠命令
  - 轨迹收集数量达到minTracesForDistillation阈值
prerequisites:
  - config.json中skill-distillation.enabled为true
  - .harness/skills-distilled目录可写
  - 至少minTracesForDistillation条执行轨迹已收集
  - skill-distiller模块已初始化
applicable_agents: [domain-analyst, task-worker]
auto_trigger: true
tools_used:
  - skill-distiller
slash_command: /distill
evidence:
  required: true
  types:
    - trace_captured
    - skill_distilled
    - skill_rewritten
    - distillation_evaluated
    - canary_deployed
verified: true
stability: beta
---

## 目标

通过Skill Distiller将高频执行轨迹蒸馏为精炼技能文件，实现从"文档注释"到"活程序压缩优化"的跨越，将大模型的隐性知识压缩为小模型可机械执行的精炼步骤。

## 步骤

1. captureTrace（捕获Agent执行轨迹）
2. distillSkill（从轨迹中提取高频执行模式，生成候选蒸馏技能）
3. rewriteSkillSteps（大模型审核并重写为精炼指令）
4. evaluateDistillation（评估蒸馏效果，收敛判定）
5. canaryDeployDistilled（金丝雀部署，灰度验证后全量发布）

# 技能蒸馏技能

## 概述
本技能通过Skill Distiller，将Agent执行轨迹（Traces）蒸馏为精炼的技能文件，实现从"文档注释"到"活程序压缩优化"的跨越。核心思想：大模型（老师）负责编写和优化技能，小模型（执行者）按技能步骤高效执行，通过蒸馏管线将老师的隐性知识压缩为显式可执行的技能步骤。

## 三层架构

### Layer 1: QMD（本地Markdown记忆库）
- Playbook工作流文件，存储结构化的工作流程
- 作为知识源头，提供领域知识和最佳实践
- 格式：Markdown + YAML Frontmatter
- 位置：`.harness/knowledge-base/`
- **人类工作流提取入口**：通过 `PlaybookGenerator.generateFromHumanWorkflow()` 将散在文档、会议纪要、操作手册中的人类工作方法拆解为步骤化Playbook
  - 支持编号步骤（1. xxx / 1) xxx）
  - 支持中文步骤（第一步：xxx）
  - 支持英文步骤（Step 1: xxx）
  - 支持Markdown列表（- xxx / * xxx）
  - 回退：按换行分割段落

### Layer 2: Skills（原子化技能文件）
- 由前沿大模型编写优化，eval验证直到收敛
- 从QMD和执行轨迹中蒸馏提炼
- 每个技能文件是自包含的、可独立执行的原子单元
- 格式：Markdown + YAML Frontmatter（与现有技能文件格式一致）
- 位置：`.harness/skills/`（原始）和 `.harness/skills-distilled/`（蒸馏后）

### Layer 3: Agent Loop（执行循环）
- Plan → ToolCall → Observe → Refine
- 小模型按技能步骤执行，无需理解深层原理
- 执行轨迹反馈到Layer 2，形成持续优化闭环
- 轨迹格式：observation → action → outcome → refinement
- **蒸馏-eval闭环**：飞轮三道门通过后自动触发重新蒸馏
  - 飞轮Gate 1（成功率阈值）→ Gate 2（回测）→ Gate 3（AB测试）→ promoted
  - promoted后自动调用 `SkillDistiller.distillSkill()` 重新蒸馏
  - 形成"eval→蒸馏→重写→再eval"的闭环
  - 闭环失败静默降级，不影响飞轮主流程

## 蒸馏管线

### 1. captureTrace（捕获轨迹）
- 在Agent执行过程中自动捕获工具调用序列
- 记录：输入上下文、工具选择、参数、输出结果、执行耗时
- 轨迹存储至内存缓冲区，达到maxTraces上限时LRU淘汰
- 触发条件：技能执行完成、任务提交时

### 2. distillSkill（蒸馏技能）
- 从轨迹缓冲区提取高频执行模式
- 聚类相似轨迹，识别共性步骤序列
- 生成候选蒸馏技能（包含步骤、参数模板、成功条件）
- 要求至少minTracesForDistillation条轨迹才能触发蒸馏
- 最多保留maxDistillations个蒸馏记录

### 3. rewriteSkillSteps（重写技能步骤）
- 大模型（老师）审核候选蒸馏技能
- 重写步骤为精炼、无歧义的执行指令
- 消除冗余步骤，合并相似操作
- 添加参数约束和边界条件检查
- 保留原始技能文件备份（.bak）

### 4. evaluateDistillation（评估蒸馏效果）
- 对比重写前后的技能执行效果
- 评估维度：成功率、执行耗时、Token消耗、输出质量
- 收敛判定：convergenceThreshold（默认0.1）以内视为收敛
- 未收敛时触发迭代重写（最多3轮）
- 生成评估报告：改进百分比、回归风险、建议

### 5. canaryDeployDistilled（金丝雀部署）
- 将蒸馏后技能以canaryTrafficPercent（默认20%）流量灰度发布
- 持续canaryEvalRounds（默认10）轮评估
- 成功率达到canarySuccessThreshold（默认0.8）时全量发布
- 成功率不达标时自动回滚到原始技能
- 部署记录写入蒸馏历史

## 大模型（老师） vs 小模型（执行者）分工

### 模型分级标记（Model Tier）
每个技能文件可标记 `model_tier` 字段，指示最低执行模型层级：
- `small`：步骤明确、无需深层理解、小模型可按流程执行
- `medium`：需要一定推理能力、条件判断、简单决策
- `large`：需要深层理解、创造性思维、复杂架构设计

路由时根据当前模型能力自动过滤：小模型只匹配 `small` 级技能，中等模型匹配 `small+medium`，大模型匹配所有。
蒸馏后的技能自动标记为 `model_tier: small`，因为蒸馏的目标是将大模型的"理解力"压缩为小模型的"执行力"。

推断规则：
- 大模型专属信号：architecture/brainstorm/idea/direction/research/deepening/fusion/scaling
- 小模型可执行信号：tdd/test/deploy/review/security/debug/fix/lint
- 强制执行（enforcement=strict）的技能默认为 small

### 大模型（老师）职责
- 编写新技能和优化现有技能步骤
- 审核蒸馏候选，重写为精炼指令
- 设计评估标准和收敛阈值
- 处理异常情况和边界条件
- 决策技能合并、拆分、废弃

### 小模型（执行者）职责
- 按技能步骤顺序执行工具调用
- 报告执行结果和异常
- 不做创造性决策，严格遵循步骤
- 在步骤不明确时请求大模型介入

### 蒸馏差距
从"文档注释"到"活程序压缩优化"的跨越：
- **文档注释**：自然语言描述，模糊、冗余、依赖理解力
- **活程序压缩优化**：精炼步骤序列，精确、无歧义、可机械执行
- 蒸馏的目标是将大模型的"理解力"压缩为小模型的"执行力"
- 关键指标：步骤数减少率、Token节省率、执行成功率保持率

## 10个关键能力填补清单

| # | 能力 | 描述 | 蒸馏策略 |
|---|------|------|----------|
| 1 | 工具选择优化 | 从轨迹中学习最优工具选择序列 | 聚类高频工具组合 |
| 2 | 参数模板生成 | 从轨迹中提取参数模式 | 参数频率分析+模板化 |
| 3 | 错误预防 | 从失败轨迹中提炼预防规则 | 失败模式聚类+规则生成 |
| 4 | 上下文裁剪 | 识别执行中真正需要的上下文 | 上下文依赖追踪 |
| 5 | 步骤合并 | 合并可原子化执行的连续步骤 | 步骤序列模式挖掘 |
| 6 | 条件分支简化 | 将复杂条件判断简化为查表 | 决策树蒸馏 |
| 7 | 重试策略优化 | 从重试轨迹中学习最优重试策略 | 重试模式聚类 |
| 8 | 输出格式约束 | 从成功轨迹中提炼输出格式规范 | 输出模式提取 |
| 9 | 超时与降级 | 从超时轨迹中学习合理的超时和降级策略 | 超时模式分析 |
| 10 | 跨技能复用 | 识别跨技能的公共步骤模式 | 公共子序列挖掘 |

## 安全约束

### 技能文件备份
- 蒸馏重写前必须备份原始技能文件（.bak后缀）
- 备份文件保留最近3个版本
- 备份目录：`.harness/skills-distilled/backups/`

### 回滚机制
- 金丝雀部署失败时自动回滚到原始技能
- 回滚操作记录到蒸馏历史
- 回滚后冷却期：30分钟内不再次尝试蒸馏该技能
- 连续3次回滚后暂停该技能的自动蒸馏

### 金丝雀部署
- 初始流量比例：canaryTrafficPercent（默认20%）
- 评估轮次：canaryEvalRounds（默认10轮）
- 成功阈值：canarySuccessThreshold（默认0.8）
- 全量发布前需通过canaryEvalRounds轮评估
- 任何轮次成功率低于50%立即回滚

### 其他安全措施
- 蒸馏操作需RBAC权限检查
- 蒸馏历史不可篡改（审计日志）
- 蒸馏后技能文件经过安全扫描
- 敏感信息（密钥、令牌）不得出现在蒸馏结果中

## 证据要求

### trace_captured
- 执行轨迹已成功捕获并存储
- 轨迹包含完整的工具调用序列
- 轨迹关联到特定技能ID

### skill_distilled
- 从轨迹中成功提取蒸馏候选
- 蒸馏候选包含步骤序列和参数模板
- 蒸馏记录已写入历史

### skill_rewritten
- 大模型已审核并重写技能步骤
- 原始技能文件已备份
- 重写后步骤数和Token数有减少

### distillation_evaluated
- 评估报告已生成
- 收敛判定已完成
- 改进百分比和回归风险已量化

### canary_deployed
- 金丝雀部署已启动
- 流量比例和评估轮次已配置
- 回滚预案已准备

## Dashboard API
运行时状态可通过以下API端点查询：
- `GET /api/skill-distillation/status` — 蒸馏器状态（初始化、轨迹数、蒸馏数、统计）
- `GET /api/skill-distillation/history` — 蒸馏历史（最多50条）
- `GET /api/skill-distillation/traces` — 近期执行轨迹（最多100条）

## 权限模型
- **applicable_agents**：domain-analyst、task-worker
- **RBAC执行级别**：`optional`（可选执行，不强制要求）
- **工具权限**：config.json中`agent_permissions`通过`skill-distiller`工具权限控制
- **安全审查**：蒸馏部署需通过金丝雀评估

## 配置参考
```json
{
  "skill-distillation": {
    "enabled": true,
    "distilledDir": ".harness/skills-distilled",
    "maxTraces": 500,
    "maxDistillations": 100,
    "minTracesForDistillation": 5,
    "convergenceThreshold": 0.1,
    "canaryTrafficPercent": 20,
    "canaryEvalRounds": 10,
    "canarySuccessThreshold": 0.8
  }
}
```

## 验收标准
- [ ] 执行轨迹成功捕获
- [ ] 蒸馏候选从轨迹中提取
- [ ] 大模型审核并重写技能步骤
- [ ] 评估报告显示改进
- [ ] 金丝雀部署成功率达标

## 常见问题
- **Q: 蒸馏后技能效果变差？**
  A: 金丝雀部署会自动检测，成功率低于50%立即回滚到原始技能
- **Q: 轨迹数量不足无法蒸馏？**
  A: 需要至少minTracesForDistillation（默认5）条轨迹，继续收集执行轨迹
