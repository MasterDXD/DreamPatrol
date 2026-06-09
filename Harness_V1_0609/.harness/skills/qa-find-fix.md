---
skill_id: qa-find-fix
name: QA修复循环
applicable_agents: [task-worker]
trigger: 需要系统化的发现-修复-验证循环时
auto_trigger: false
phase: integration-testing
priority: 6
trigger_conditions:
  - integration-testing finds issues that need systematic fix-verify cycle
  - user mentions "QA修复" or "find-fix-verify" or "修复循环" or "健康评分"
  - multiple issues need systematic discovery, fix, and verification
depends_on: []
blocks: []
causal_inputs:
  - name: test-results
    source: integration-testing
    required: false
causal_outputs:
  - name: health-score
    description: 0-100健康评分
  - name: fix-report
    description: 修复验证报告
evidence_types:
  required:
    - health_score
    - fix_verification
enforcement: recommended
model_tier: medium
tags: [qa, find-fix-verify, automated-testing]
verified: true
stability: stable
---

# Skill: QA修复循环

## 任务目标
执行系统化的发现-修复-验证循环，通过4种模式对代码质量进行全方位扫描和修复，输出0-100健康评分。遵循Boil the Lake原则——只修复影响功能的问题，不做无意义的代码调整。

## 执行步骤

### 4种运行模式（根据场景选择）

1. **Diff-Aware模式**（默认）：
   - 仅扫描本次变更影响的代码路径
   - 适用：小范围变更的快速验证
   - 扫描范围：git diff涉及的文件及其直接依赖

2. **Full-Exploration模式**：
   - 全面扫描整个项目
   - 适用：大版本发布前的完整QA
   - 扫描范围：所有源代码文件

3. **Quick-Smoke模式**：
   - 快速冒烟测试，只验证核心路径
   - 适用：紧急修复后的快速确认
   - 扫描范围：核心业务流程的5-10个关键路径

4. **Regression-Baseline模式**：
   - 与上次基线对比，检测回归
   - 适用：迭代开发中的回归检测
   - 扫描范围：上次基线以来的所有变更

### Find-Fix-Verify循环

1. **Find（发现）**：
   - 运行自动化测试套件
   - 扫描错误日志和异常栈
   - 检查UI渲染异常和交互失败
   - 收集所有发现的问题，按严重程度排序

2. **Fix（修复）**：
   - 按P0→P1→P2→P3顺序修复
   - 每次只修复一个问题
   - 修复后立即运行相关测试确认不引入新问题
   - 记录修复内容和影响范围

3. **Verify（验证）**：
   - 重新运行失败的测试用例
   - 确认修复有效且无副作用
   - 更新健康评分
   - 如验证失败，回滚修复并重新分析

### 健康评分计算（0-100）

- 90-100：生产就绪，无P0/P1问题
- 70-89：基本可用，存在P2问题需关注
- 50-69：不建议发布，存在P1问题
- 0-49：不可发布，存在P0问题

## 验收标准
- 所有P0/P1问题已修复并验证通过
- 健康评分达到70分以上
- 修复报告包含：问题列表、修复内容、验证结果、健康评分
- 无回归问题（修复未引入新Bug）

## 角色边界约束
- **禁止**：在健康评分低于70时建议发布
- **禁止**：跳过Verify步骤直接标记为已修复
- **禁止**：同时修复多个问题（必须逐个修复验证）
- **禁止**：将P0问题降级处理以提升健康评分

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 执行系统化的发现-修复-验证循环，通过4种运行模式（Diff-Aware、Full-Exploration、Quick-Smoke、Regression-Baseline）对代码质量进行全方位扫描和修复，输出0-100健康评分。

### Q: 适用于哪些场景？
A: 适用于集成测试阶段发现问题的系统化修复场景，包括小范围变更验证、大版本发布前完整QA、紧急修复后快速确认和迭代开发中的回归检测。

### Q: 使用此Skill的前提条件是什么？
A: 需要已运行集成测试（integration-testing），有测试结果作为输入。建议已配置自动化测试套件和错误日志收集机制，以便Find阶段高效发现所有问题。
