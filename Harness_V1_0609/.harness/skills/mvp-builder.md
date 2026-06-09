---
skill_id: mvp-builder
name: MVP构建
applicable_agents:
  - task-worker
  - domain-analyst
  - team-lead
trigger: 用户需要快速构建最小可行产品或原型时
auto_trigger: true
phase: module-development
priority: 2
trigger_conditions:
  - "用户提到MVP或最小可行产品"
  - "需要快速构建原型"
  - "提到AI原生构建"
  - "非技术创始人需要构建应用"
  - "提到mvp-builder或MVP构建"
  - "用户说快速上线或快速验证"
depends_on:
  - architecture-design
blocks:
  - integration-testing
causal_inputs:
  - name: architecture-document
    source: architecture-design
    required: true
  - name: validated-idea-report
    source: idea-validation
    required: false
  - name: assumption-matrix
    source: idea-validation
    required: false
causal_outputs:
  - name: mvp-deliverable
    description: MVP交付物（可运行的应用/服务）
  - name: mvp-test-report
    description: MVP测试报告（功能覆盖、性能基线、已知限制）
  - name: tech-debt-register
    description: 技术债登记册（有意为之的简化决策及后续计划）
evidence_types:
  required:
    - mvp_deliverable
    - mvp_test_report
  optional:
    - tech_debt_register
enforcement: recommended
verified: true
stability: stable
usage_count: 0
success_rate: 0.0
tools:
  - ai-code-generator: AI代码生成工具
  - architecture-scaffold: 架构脚手架工具
  - tech-debt-tracker: 技术债追踪工具
  - mvp-scope-definer: MVP范围定义工具
model: claude-3-opus-20240229
production_validated: false
---

# Skill: MVP构建

## 任务目标
在AI时代创业框架下，帮助用户（包括非技术创始人）快速构建生产级MVP，同时避免技术债积累。遵循"先架构后编码、边界清晰、安全优先"三大原则。

## 执行步骤

### 步骤1：定义MVP范围
- 使用 `mvp-scope-definer` 工具确定MVP的核心功能集
- 基于 `validated-idea-report` 中的假设矩阵，优先实现验证最关键假设的功能
- 采用"一个核心流程"原则：MVP只实现一条完整的用户路径
- 明确MVP的"不做"清单（与用户确认哪些功能推迟到后续版本）

### 步骤2：架构先行
- 在让AI编码之前，先定义系统架构：
  - 组件划分（前端/后端/数据层）
  - 接口契约（API端点、数据格式）
  - 技术栈选择（基于项目约束和团队熟悉度）
  - 部署架构（开发/生产环境）
- 使用 `architecture-scaffold` 工具生成架构骨架
- 输出架构文档到 `docs/architecture/` 目录

### 步骤3：AI辅助编码
- 使用 `ai-code-generator` 工具按组件逐个生成代码
- 每个AI编码任务必须满足三个条件：
  1. **边界清晰**：有明确的起点、终点和成功标准
  2. **可验证**：有对应的测试用例（遵循TDD门禁）
  3. **安全审查**：生成的代码需经过安全检查（无硬编码密钥、无SQL注入、输入验证）
- 遵循项目的TDD强制规则：RED → GREEN → REFACTOR

### 步骤4：技术债管理
- 使用 `tech-debt-tracker` 工具记录所有有意为之的简化决策
- 每条技术债记录包含：
  - 简化描述（做了什么妥协）
  - 原因（为什么这样做是合理的）
  - 影响范围（可能导致的后续问题）
  - 清偿计划（何时以及如何修复）
- 技术债分为三级：
  - **P0（必须清偿）**：安全问题、数据丢失风险 → 上线前必须修复
  - **P1（应该清偿）**：性能瓶颈、可维护性问题 → 下一迭代修复
  - **P2（可以接受）**：代码风格、非关键优化 → 按需修复

### 步骤5：安全从零开始
- 从项目启动就内置安全措施：
  - 环境变量管理（敏感信息不入代码）
  - 输入验证和消毒（使用项目的sanitizer工具）
  - 认证和授权（RBAC权限模型）
  - 依赖安全审计（使用security-audit技能）
- 安全检查清单：
  - [ ] 无硬编码密钥或令牌
  - [ ] 所有用户输入经过验证和消毒
  - [ ] API端点有认证保护
  - [ ] 数据库查询使用参数化（防SQL注入）
  - [ ] 错误信息不泄露内部细节

### 步骤6：MVP测试与交付
- 执行核心用户路径的端到端测试
- 生成MVP测试报告（功能覆盖、性能基线、已知限制）
- 确认技术债登记册完整
- 将交付物发布到CausalDataBus

## 验收标准
- [ ] MVP范围已定义，核心功能集和"不做"清单已确认
- [ ] 系统架构文档已生成
- [ ] 所有AI生成的代码通过TDD门禁（有对应测试）
- [ ] 安全检查清单全部通过
- [ ] 技术债登记册完整（无P0级技术债遗留）
- [ ] MVP测试报告已生成
- [ ] 核心用户路径可端到端运行

## 常见问题

### Q: 非技术创始人如何使用此技能？
A: 此技能设计为"编排者模式"——创始人只需定义方向和质量标准，AI负责编码实现。创始人需要关注的是：MVP范围定义（步骤1）、验收标准确认（步骤6），中间的技术实现由AI自动完成。

### Q: AI生成的代码质量如何保证？
A: 通过三重保障：1) TDD门禁强制先写测试；2) code-review技能自动审查；3) security-audit技能安全审计。任何未通过门禁的代码不会被合并。

### Q: 技术债何时清偿？
A: P0级在上线前必须清偿。P1级在下一个迭代（通常1-2周）清偿。P2级按需清偿。技术债登记册是活文档，需持续更新。
