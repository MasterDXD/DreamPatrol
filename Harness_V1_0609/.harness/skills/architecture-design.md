---
skill_id: architecture-design
name: 架构设计
applicable_agents: [domain-analyst, planner]
trigger: 需求分析完成，需要设计系统架构时
auto_trigger: true
phase: architecture-design
priority: 2
trigger_conditions:
  - requirement-analysis skill completes and outputs requirement spec
  - user mentions "架构设计" or "architecture design" or "系统设计"
  - user asks to design system architecture or module structure
depends_on: [requirement-analysis]
blocks: [module-development, tdd-implement]
causal_inputs:
  - name: requirement-spec
    source: requirement-analysis
    required: true
  - name: task-breakdown
    source: requirement-analysis
    required: false
causal_outputs:
  - name: architecture-document
    description: 架构设计文档
  - name: interface-design
    description: 接口设计
  - name: module-breakdown
    description: 模块划分
evidence_types:
  required:
    - architecture_document
    - specification_verified
enforcement: recommended
verified: true
stability: stable
usage_count: 100
success_rate: 0.88
tools:
  - architecture-modeler: 架构建模工具
  - interface-designer: 接口设计工具
  - dependency-analyzer: 依赖分析工具
  - trade-off-evaluator: 权衡评估工具
model: claude-3-opus-20240229
production_validated: true
---

# Skill: 架构设计

## 任务目标
根据需求规格说明书，设计系统整体架构、模块划分、接口定义和数据模型，输出完整的设计文档。

## 执行步骤
1. **理解需求**：
   - 阅读需求规格说明书
   - 确认核心功能和非功能需求
   - 识别技术约束和依赖
2. **架构选型**：
   - 根据需求选择架构风格（单体/微服务/Serverless）
   - 选择技术栈（语言、框架、数据库、中间件）
   - 评估选型的权衡和风险
3. **模块划分**：
   - 按职责划分模块，每个模块单一职责
   - 定义模块间接口和依赖关系
   - 绘制模块关系图
4. **接口设计**：
   - 定义API端点（路径、方法、参数、响应）
   - 定义数据模型（字段、类型、约束、关系）
   - 定义错误码和异常处理
5. **架构评审**：
   - 检查架构是否满足非功能需求
   - 评估可扩展性和可维护性
   - 识别单点故障和性能瓶颈
6. **输出文档**：
   - 架构分析文档到 docs/architecture/
   - 接口设计文档到 outputs/
   - 数据模型设计到 outputs/

## 验收标准
- 架构图清晰，模块职责明确
- 所有模块间接口已定义
- 数据模型完整，关系明确
- 非功能需求有对应的架构保障
- 技术选型有明确的理由

## 常见问题
- **Q: 需求不明确时如何设计架构？**
  A: 基于已知需求设计核心架构，为不确定的部分预留扩展点
- **Q: 多种技术方案如何选择？**
  A: 列出各方案的优劣对比表，推荐一个并说明理由
- **Q: 架构过于复杂怎么办？**
  A: 优先保证MVP可用，复杂度按需增加
