---
skill_id: requirement-analysis
name: 需求分析
applicable_agents: [domain-analyst, team-lead, planner]
trigger: 收到新项目或新功能需求时
auto_trigger: true
phase: requirement-analysis
priority: 1
trigger_conditions:
  - user provides a new project requirement or feature request
  - user mentions "需求分析" or "requirement analysis"
  - requirements.md is created or updated
  - brainstorming skill completes and outputs a design document
depends_on: [brainstorming]
blocks: [architecture-design]
causal_inputs:
  - name: design-document
    source: brainstorming
    required: false
  - name: raw-requirements
    source: user-input
    required: false
causal_outputs:
  - name: requirement-spec
    description: 需求规格说明书
  - name: task-breakdown
    description: 任务拆解清单
  - name: acceptance-criteria
    description: 验收标准
  - name: priority-matrix
    description: 优先级矩阵
evidence_types:
  required:
    - requirement_spec
    - specification_verified
verified: true
stability: stable
usage_count: 95
success_rate: 0.87
enforcement: recommended
tools:
  - requirement-parser: 需求解析工具
  - stakeholder-analyzer: 利益相关者分析
  - acceptance-criteria-generator: 验收标准生成
  - priority-matrix: 优先级矩阵
model: claude-3-opus-20240229
production_validated: true
---

# Skill: 需求分析

## 任务目标
将用户提供的原始需求转化为结构化的需求规格说明书，明确功能边界、验收标准和优先级。

## 执行步骤
1. **收集需求**：
   - 阅读 requirements.md 或用户提供的原始需求
   - 识别模糊点和遗漏信息
   - 列出需向用户确认的问题清单
2. **需求分类**：
   - 功能需求：用户可直接操作的功能
   - 非功能需求：性能、安全、可用性、可扩展性
   - 约束条件：技术限制、时间限制、预算限制
3. **需求细化**：
   - 每个功能需求拆解为用户故事格式
   - 明确每个需求的验收标准
   - 标注需求间的依赖关系
4. **优先级排序**：
   - P0：核心功能，缺少则项目无法运行
   - P1：重要功能，影响用户体验
   - P2：增强功能，锦上添花
5. **生成文档**：
   - 输出需求规格说明书到 outputs/
   - 输出任务拆解清单到 outputs/
6. **需求评审**：
   - 提交给Team Lead审核
   - 根据反馈修正

## 验收标准
- 所有功能需求有明确的用户故事和验收标准
- 非功能需求有可量化的指标
- 优先级排序合理，P0功能覆盖核心场景
- 需求间依赖关系清晰，无循环依赖
- 无模糊表述，所有术语有明确定义

## 常见问题
- **Q: 用户需求过于模糊怎么办？**
  A: 列出具体问题清单，向用户逐一确认，不自行假设
- **Q: 需求间存在冲突怎么办？**
  A: 标记冲突点，提供权衡方案，由用户或Team Lead决策
- **Q: 需求范围过大怎么办？**
  A: 建议分期实施，MVP优先，明确各期边界
