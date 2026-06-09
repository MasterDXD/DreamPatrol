---
skill_id: module-development
name: 模块开发
applicable_agents: [task-worker, test-writer]
trigger: domain-analyst完成设计文档后
auto_trigger: true
phase: module-development
priority: 3
trigger_conditions:
  - architecture-design skill completes and outputs design documents
  - user mentions "模块开发" or "module development" or "编码实现"
  - user asks to implement a specific module or feature
  - tdd-implement skill completes RED phase and needs GREEN phase implementation
depends_on: [architecture-design, tdd-implement]
blocks: [code-review, integration-testing]
causal_inputs:
  - name: architecture-document
    source: architecture-design
    required: true
  - name: test-code
    source: tdd-implement
    required: true
  - name: implementation-code
    source: tdd-implement
    required: false
causal_outputs:
  - name: module-source-code
    description: 模块源代码
  - name: module-tests
    description: 模块测试代码
  - name: module-docs
    description: 模块文档
verified: true
stability: stable
usage_count: 180
success_rate: 0.91
enforcement: strict
tdd_enforced: true
tools:
  - code-scaffolder: 代码脚手架工具
  - interface-implementer: 接口实现工具
  - test-generator: 测试生成工具
  - doc-generator: 文档生成工具
model: claude-3-5-sonnet-20240620
production_validated: true
evidence_types:
  required:
    - test_output
    - coverage_report
    - lint_output
---

# Skill: 模块开发

## 任务目标
根据Domain Analyst提供的设计文档，严格按照TDD流程完成模块的编码、测试和文档编写。

## TDD门禁
本Skill强制执行TDD（测试驱动开发）流程。任何实现代码必须在对应的失败测试之后编写。
- 当开发新功能时，自动激活 `tdd-implement` Skill
- 当修复缺陷时，自动激活 `systematic-debugging` + `bug-fix` Skill
- 当改善代码结构时，自动激活 `refactor-code` Skill

## 执行步骤
1. **理解需求**：
   - 阅读设计文档，确认功能需求和技术方案
   - 如有疑问，向Domain Analyst确认
2. **环境准备**：
   - 确认开发环境和依赖
   - 创建模块目录结构
   - 确认测试框架可用，测试基线为绿色
3. **TDD开发循环**（激活 tdd-implement Skill）：
   - **RED**：为当前功能切片编写失败测试
   - **GREEN**：编写最小实现代码使测试通过
   - **REFACTOR**：在测试保护下优化代码结构
   - 循环直至所有功能切片完成
4. **集成验证**：
   - 运行全量测试，确认无回归
   - 运行Lint/静态检查，确认零错误
   - 确认测试覆盖率 ≥ 80%
5. **文档编写**：
   - 编写模块使用说明
   - 更新API文档
   - 添加代码内注释
6. **完成前验证**（激活 verification-before-completion Skill）：
   - 对照验收标准逐项检查
   - 提供每项标准的完成证据
   - 确认无遗留TODO/FIXME
7. **提交审核**：
   - 使用任务执行报告模板提交成果
   - 附带测试结果、覆盖率和文档
   - 代码进入staging区等待审查

## 验收标准
- 代码符合编码规范，无静态检查错误
- 所有实现代码都有失败测试先行（TDD门禁）
- 所有公开接口有对应单元测试，测试通过率100%
- 测试覆盖率 ≥ 80%
- 功能完整实现，与设计文档一致
- 文档完整，包含使用示例
- 无硬编码的敏感信息
- verification-before-completion Skill验证通过

## 常见问题
- **Q: 设计文档中的接口定义与实际实现有冲突怎么办？**
  A: 立即与Domain Analyst沟通，确认是否需要调整设计或实现
- **Q: 发现设计文档有遗漏怎么办？**
  A: 记录遗漏点，与Domain Analyst确认后补充，不自行假设
- **Q: 单元测试依赖外部服务怎么办？**
  A: 使用Mock替代外部依赖，确保测试可独立运行
- **Q: TDD流程太慢影响进度怎么办？**
  A: TDD的初始投入会在调试和回归测试阶段收回。如果功能切片足够小，每个RED-GREEN-REFACTOR循环应在2-5分钟内完成
