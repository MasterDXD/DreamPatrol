---
skill_id: decision-loop
name: 七层闭环决策
applicable_agents:
  - team-lead
  - domain-analyst
  - system-designer
trigger: 用户提出战略决策/商业判断/方案选择等非纯技术决策需求时触发
auto_trigger: true
phase: brainstorming
priority: 3
trigger_conditions:
  - "用户提到战略决策或商业判断"
  - "用户需要方案选择或决策分析"
  - "提到decision loop或七层闭环或决策闭环"
  - "用户说反谄媚或反对者审判或证伪"
  - "涉及非纯技术的战略级决策需求"
depends_on:
  - brainstorming
blocks:
  - requirement-analysis
causal_inputs:
  - name: design-document
    source: brainstorming
    required: false
  - name: assumption-list
    source: brainstorming
    required: false
causal_outputs:
  - name: decision-loop-report
    description: 七层闭环决策报告（含背景/选项/假设/反驳/标准/实验/复盘）
  - name: anti-sycophancy-checklist
    description: 反谄媚检查清单
  - name: experiment-design
    description: 最小可行实验设计
evidence_types:
  required:
    - decision_loop_report
  optional:
    - anti_sycophancy_checklist
    - experiment_design
enforcement: optional
verified: true
stability: stable
usage_count: 0
success_rate: 0.0
tools:
  - adversarial-review: 反谄媚对抗审查工具
  - falsification-checker: 证伪检验工具
  - assumption-extractor: 假设提取工具
model: claude-3-opus-20240229
production_validated: false
---

## 目标

通过七层闭环决策工作流（背景→选项→假设→反驳→标准→实验→复盘）将AI从被动答题机升级为可信赖的思考伙伴，贯穿从想法产生到结果复盘的全流程，确保决策有据可依、可证伪、可复盘。

# 七层闭环决策工作流

> 来源："与AI共舞"方法论。将AI从被动答题机升级为可信赖的思考伙伴，贯穿从想法产生到结果复盘的全流程。

## 执行步骤

### 第1层：背景层（Background）
**目标**：把业务现状、约束条件全部告知AI

**输入**：
- 业务现状描述
- 资源约束（预算/人力/时间）
- 历史决策和失败案例
- 独特优势和能力

**输出**：结构化背景文档

**关键原则**：提供非共识输入——你的资源、限制、历史决策、失败案例等，这些是AI产出"个性化选项空间"而非"通用方案"的关键。

### 第2层：选项层（Options）
**目标**：让AI生成多套备选方案及各自适用前提

**输入**：结构化背景文档

**输出**：
- 10个不同思路（而非2-3个）
- 分成3类（保守/中等/激进）
- 每个思路标注适用前提
- 标注"共识方案"vs"非共识方案"

**关键原则**：不追求"唯一最优方案"，而是生成多选项+各选项适用前提。

### 第3层：假设层（Assumptions）
**目标**：抽取每个方案背后的关键假设

**输入**：多套备选方案

**输出**：
- 每个方案的关键假设列表（3-5个）
- 假设的分类（事实假设/逻辑假设/市场假设）
- 假设的可验证性评估

**关键原则**：每个方案都有隐含假设，显式化假设是反驳的前提。

### 第4层：反驳层（Refutation）
**目标**：启动反谄媚机制，攻击假设

**输入**：关键假设列表

**输出**：
- 魔鬼代言人攻击（至少3个角色视角）
- 每个假设的"为什么这可能行不通"
- 证伪信号清单
- 假设的脆弱性评分

**关键原则**：这是七层闭环的核心防线。强制对每个关键假设进行"反对者审判"。

**反谄媚强制格式**：
```
## 反对者审判
### 为什么这可能行不通
[至少3个具体风险]
### 成立的前提条件
[方案生效必须满足的条件]
### 证伪信号
[现实中什么信号能证明此方案是错的]
```

### 第5层：标准层（Standards）
**目标**：设定可证伪、可量化的评价标准

**输入**：反驳后的存活方案

**输出**：
- 可量化的成功标准（如"用户转化率提升20%"）
- 可证伪的失败标准（如"3个月内日活不破1000则判定失败"）
- 优先级排序

**关键原则**：标准必须可证伪——"看起来不错"不是标准，"在X时间内达到Y指标"才是。

### 第6层：实验层（Experiment）
**目标**：设计最小可行实验，在现实中验证假设

**输入**：可证伪的评价标准

**输出**：
- 最小可行实验设计
- 实验成本估算
- 预期结果和判断标准
- 实验时间线

**关键原则**：不追求完美实验，追求最小成本验证最关键假设。

### 第7层：复盘层（Review）
**目标**：梳理结果，更新认知，开启下一轮迭代

**输入**：实验结果

**输出**：
- 实验结果vs预期对比
- 认知更新清单
- 下一轮迭代的背景层输入
- 决策：继续/转向/放弃

**关键原则**：复盘不是终点，而是下一轮七层闭环的起点。

## 与Harness技能体系的映射

| 七层闭环 | 对应技能 | 差异 |
|---------|---------|------|
| 背景层 | brainstorming（部分） | brainstorming不要求提供非共识输入 |
| 选项层 | brainstorming（部分） | brainstorming仅2-3方案，缺少前提标注 |
| 假设层 | idea-validation（部分） | idea-validation有假设矩阵但无反驳 |
| 反驳层 | **新增** | 现有框架无对应 |
| 标准层 | verification-before-completion（部分） | 验证标准面向代码，非决策 |
| 实验层 | **新增** | 现有框架无对应 |
| 复盘层 | iterative-deepening（部分） | 深化是收敛，复盘是认知更新 |

## 斜杠命令

`/decide` → decision-loop（七层闭环决策）

## 验收标准

- [ ] 背景层包含非共识输入（独特资源/约束/失败案例）
- [ ] 选项层生成10个不同思路并标注前提
- [ ] 假设层显式化了每个方案的关键假设
- [ ] 反驳层使用了反谄媚强制格式
- [ ] 标准层设定了可证伪、可量化的评价标准
- [ ] 实验层设计了最小可行实验
- [ ] 复盘层更新了认知并决定下一步

## FAQ

- **Q: 七层闭环与普通决策有何区别？** A: 普通决策跳过假设和反驳，七层闭环强制对每个关键假设进行"反对者审判"，确保决策经得起证伪。
- **Q: 什么时候不需要走完整七层？** A: 纯技术决策（如代码实现细节）不需要，战略级/商业级决策才需要完整七层闭环。
- **Q: 七层闭环的推荐方案是否总是最优？** A: 不是。七层闭环的目标是生成可证伪、可验证的选项空间，而非"唯一最优方案"。
