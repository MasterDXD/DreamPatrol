---
skill_id: integration-testing
name: 集成测试
applicable_agents: [quality-assurance, test-writer]
trigger: 多个模块开发完成，需要验证模块间协作时
auto_trigger: true
phase: integration-testing
priority: 6
trigger_conditions:
  - multiple modules pass code-review
  - user mentions "集成测试" or "integration testing" or "模块联调"
  - user asks to test module integration or end-to-end functionality
  - all dependent module-development skills complete
depends_on: [code-review]
blocks: [deployment]
causal_inputs:
  - name: review-approval
    source: code-review
    required: true
  - name: module-source-code
    source: module-development
    required: false
  - name: module-tests
    source: module-development
    required: false
causal_outputs:
  - name: test-results
    description: 集成测试结果
  - name: defect-report
    description: 缺陷报告
evidence_types:
  required:
    - test_output
    - coverage_report
causal_invariants:
  - test-results
verified: true
stability: stable
usage_count: 120
success_rate: 0.90
enforcement: strict
tools:
  - test-orchestrator: 测试编排工具
  - environment-manager: 环境管理工具
  - coverage-aggregator: 覆盖率聚合工具
  - defect-reporter: 缺陷报告工具
model: claude-3-5-sonnet-20240620
production_validated: true
---

# Skill: 集成测试

## 任务目标
验证多个模块组合后的整体功能正确性，发现模块间接口不匹配、数据流异常等集成问题。

## 执行步骤
1. **理解集成范围**：
   - 阅读架构文档，理解模块间依赖关系
   - 确认本次集成涉及的模块列表
   - 获取各模块的接口定义文档
2. **制定测试计划**：
   - 确定集成测试策略（自底向上/自顶向下/大爆炸）
   - 设计集成测试场景（覆盖主要数据流和调用链）
   - 准备测试环境（依赖服务、测试数据）
3. **编写测试用例**：
   - 模块间接口调用测试
   - 数据流转正确性测试
   - 异常传播和恢复测试
   - 并发和性能测试（如需要）
4. **执行测试**：
   - 按测试计划逐步执行
   - 记录每个用例的执行结果
   - 发现缺陷时编写缺陷报告
5. **缺陷跟踪**：
   - 提交缺陷报告给对应模块的Worker
   - 跟踪修复进度
   - 验证修复结果
6. **生成报告**：
   - 测试覆盖率统计
   - 缺陷统计和分布
   - 风险评估和建议

## 验收标准
- 所有P0场景测试通过
- 接口调用测试100%覆盖
- 缺陷报告包含完整的复现步骤
- 测试报告包含覆盖率和风险评估

## 常见问题
- **Q: 依赖模块未完成怎么办？**
  A: 使用Mock替代未完成模块，基于接口定义模拟返回值
- **Q: 集成测试环境与开发环境不一致怎么办？**
  A: 使用Docker统一环境配置，确保环境一致性
- **Q: 发现接口定义与实际实现不一致怎么办？**
  A: 记录为阻塞级缺陷，通知Domain Analyst协调解决
