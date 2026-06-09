---
skill_id: idea-validation
name: 想法验证
applicable_agents:
  - team-lead
  - domain-analyst
  - planner
trigger: 用户提出创业想法或需要验证商业假设时
auto_trigger: true
phase: brainstorming
priority: 1
trigger_conditions:
  - "用户提到创业想法或商业假设"
  - "需要验证市场需求"
  - "提到PMF或产品市场匹配"
  - "需要竞品分析或行业扫描"
  - "提到idea validation或想法验证"
  - "用户说验证假设或测试假设"
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
  - name: raw-requirements
    source: user-input
    required: false
causal_outputs:
  - name: validated-idea-report
    description: 想法验证报告（含竞争格局、假设矩阵、不确定性评分）
  - name: assumption-matrix
    description: 假设验证矩阵（假设→验证方法→结果→置信度）
  - name: competitive-landscape
    description: 竞争格局分析（竞品列表、差异化点、市场空白）
  - name: uncertainty-score
    description: 不确定性评分（0-1，越低越确定）
evidence_types:
  required:
    - validated_idea_report
  optional:
    - assumption_matrix
    - competitive_landscape
enforcement: recommended
verified: true
stability: stable
usage_count: 0
success_rate: 0.0
tools:
  - assumption-matrix-builder: 假设矩阵构建工具
  - competitive-scanner: 竞争格局扫描工具
  - uncertainty-quantifier: 不确定性量化工具
  - hypothesis-tester: 假设快速测试工具
model: claude-3-opus-20240229
production_validated: false
---

# Skill: 想法验证

## 任务目标
在AI时代创业框架下，对用户的创业想法进行系统性验证，避免"爱上自己的想法"陷阱，以最小成本验证想法的不确定性。

## 执行步骤

### 步骤1：提取核心假设
- 从用户输入或brainstorming产出的设计方案文档中提取所有隐含假设
- 将假设分为三类：**价值假设**（用户是否真有这个痛点）、**增长假设**（用户是否会传播）、**可行性假设**（技术上能否实现）
- 为每个假设标注初始置信度（0-1）

### 步骤2：构建假设验证矩阵
- 对每个假设，设计最低成本验证方法：
  - **价值假设**：模拟用户访谈（5-10个潜在用户画像分析）、竞品评论情感分析、搜索趋势验证
  - **增长假设**：现有同类产品的增长曲线分析、病毒系数估算
  - **可行性假设**：技术栈成熟度评估、AI工具能力边界检查
- 使用 `assumption-matrix-builder` 工具构建结构化矩阵

### 步骤3：竞争格局扫描
- 使用 `competitive-scanner` 工具进行行业竞争格局扫描
- 识别直接竞品、间接竞品、替代方案
- 标注市场空白和差异化机会
- 评估进入壁垒（技术壁垒、网络效应、品牌壁垒）

### 步骤4：不确定性量化
- 使用 `uncertainty-quantifier` 工具计算整体不确定性评分
- 评分维度：
  - 市场不确定性（需求是否真实存在）：权重40%
  - 技术不确定性（能否按时交付）：权重30%
  - 竞争不确定性（能否建立护城河）：权重30%
- 不确定性评分 > 0.7 → 建议回退到brainstorming重新探索
- 不确定性评分 0.4-0.7 → 建议进行小规模实验验证
- 不确定性评分 < 0.4 → 可以进入需求分析阶段

### 步骤5：生成验证报告
- 汇总假设矩阵、竞争格局、不确定性评分
- 给出明确的GO/NO-GO/PIVOT建议
- 如果PIVOT，提供2-3个替代方向
- 将验证报告作为因果数据发布到CausalDataBus

## 验收标准
- [ ] 所有核心假设已提取并分类
- [ ] 每个假设有对应的验证方法和结果
- [ ] 竞争格局扫描完成，至少识别3个竞品
- [ ] 不确定性评分已计算，有明确的GO/NO-GO/PIVOT建议
- [ ] 验证报告已生成并发布到因果数据总线

## 常见问题

### Q: 用户只有一个模糊想法，无法提取具体假设怎么办？
A: 使用苏格拉底式提问引导用户明确：谁有这个痛点？痛点有多频繁？现有解决方案是什么？为什么现有方案不够好？

### Q: 竞争格局扫描发现市场已饱和怎么办？
A: 不直接建议放弃，而是引导用户寻找细分市场或差异化定位。使用"10倍好"原则评估——用户是否能在某个维度上比现有方案好10倍。

### Q: 不确定性评分很高但用户坚持要做？
A: 记录风险但不阻止。在验证报告中标注"高风险"并建议最小化初始投入，采用"小赌注"策略快速试错。
