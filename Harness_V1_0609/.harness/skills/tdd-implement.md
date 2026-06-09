---
skill_id: tdd-implement
name: TDD驱动开发
applicable_agents: [task-worker, test-writer]
trigger: 设计文档完成，需要编码实现时
auto_trigger: true
phase: module-development
priority: 3
trigger_conditions:
  - architecture-design skill completes with implementation plan
  - user mentions "TDD" or "测试驱动" or "test-driven"
  - user asks to implement a feature with tests first
  - module-development skill triggers for new feature implementation
depends_on: [architecture-design]
blocks: [code-review]
causal_inputs:
  - name: architecture-document
    source: architecture-design
    required: true
  - name: interface-design
    source: architecture-design
    required: false
causal_outputs:
  - name: test-code
    description: TDD测试代码
  - name: implementation-code
    description: 实现代码
  - name: coverage-report
    description: 覆盖率报告
causal_invariants:
  - coverage-report
  - test-code
enforcement: strict
verified: true
stability: stable
usage_count: 150
success_rate: 0.92
tools:
  - test-runner: 测试执行器
  - coverage-reporter: 覆盖率报告
  - code-generator: 代码生成器
  - refactoring-assist: 重构辅助
model: claude-3-5-sonnet-20240620
production_validated: true
evidence_types:
  required:
    - test_output
    - coverage_report
---

# Skill: TDD驱动开发

## 铁律
**NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**
先写测试后写代码，不是建议，是强制要求。如果先写了实现代码，必须删除，从测试开始。

## 任务目标
严格按照RED-GREEN-REFACTOR循环驱动开发，确保每一行实现代码都有对应的测试保护，从源头保障代码质量。

## 执行步骤

### RED阶段 — 写失败测试
1. **理解需求切片**：
   - 从实现计划中选取最小可测试的功能切片
   - 明确这个切片的预期行为
2. **编写失败测试**：
   - 编写一个测试，描述预期行为
   - 运行测试，确认测试失败（RED）
   - 失败信息必须清晰说明期望与实际的差异
   - **门禁检查**：如果测试意外通过，说明测试本身有问题，需修正

### GREEN阶段 — 写最小实现
3. **编写最小代码**：
   - 只编写足以让测试通过的代码
   - 不做任何额外的优化或扩展
   - 不提前实现未来可能需要的功能
4. **运行测试**：
   - 确认测试通过（GREEN）
   - 确认没有破坏其他已有测试
   - **门禁检查**：如果需要写大量代码才能通过，说明功能切片过大，需拆分

### REFACTOR阶段 — 优化代码
5. **重构优化**：
   - 在测试保护下重构代码
   - 消除重复、改善命名、简化逻辑
   - 每次重构后立即运行测试，确认行为不变
   - **门禁检查**：重构后任何测试失败，立即回退到上一个通过状态

### 循环推进
6. **选取下一个切片**：
   - 重复RED-GREEN-REFACTOR循环
   - 每个循环应控制在2-5分钟内完成
   - 所有切片完成后进入提交审核

## 门禁规则
- ❌ **禁止**：在没有失败测试的情况下编写实现代码
- ❌ **禁止**：跳过RED阶段直接写实现
- ❌ **禁止**：为了通过测试而修改测试本身（除非测试逻辑有误）
- ✅ **要求**：每个公开接口至少有一个正向测试和一个边界测试
- ✅ **要求**：所有测试必须可独立运行，不依赖执行顺序
- ✅ **要求**：测试命名清晰描述预期行为

## 验收标准
- 所有实现代码都有对应的失败测试先行
- 测试覆盖率 ≥ 80%
- 所有测试通过，无跳过、无禁用
- 每个RED-GREEN-REFACTOR循环有明确记录
- 无硬编码的测试数据（使用Fixture或Factory）

## 常见问题
- **Q: 不知道怎么写测试怎么办？**
  A: 从最简单的行为开始——"当输入X时，应该返回Y"。如果连这个都写不出，说明需求切片还不够小
- **Q: 先写了实现代码怎么办？**
  A: 删除实现代码，保留思路，从测试重新开始。这不是浪费时间，而是确保质量
- **Q: 重构时测试失败了怎么办？**
  A: 立即回退（git checkout），重新评估重构方案。测试失败说明重构改变了行为
- **Q: 私有方法怎么测试？**
  A: 通过公开接口间接测试私有方法的行为，不直接测试实现细节
- **Q: 测试和实现的比例怎么把握？**
  A: 测试代码通常是实现代码的1.5-3倍。如果测试代码远少于实现代码，说明覆盖不足
