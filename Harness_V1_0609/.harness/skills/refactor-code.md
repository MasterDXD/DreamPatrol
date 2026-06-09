---
skill_id: refactor-code
name: 系统化重构
applicable_agents: [task-worker, domain-analyst]
trigger: 代码结构需要改善但功能行为不变时
auto_trigger: true
phase: module-development
priority: 5
trigger_conditions:
  - code-review identifies structural issues but behavior is correct
  - user mentions "重构" or "refactor" or "改善代码结构"
  - code has high complexity, duplication, or poor naming
  - performance-optimization requires structural changes
depends_on: [module-development]
blocks: []
causal_inputs:
  - name: source-code
    source: module-development
    required: false
  - name: test-baseline
    source: tdd-implement
    required: false
causal_outputs:
  - name: refactored-code
    description: 重构后的代码
  - name: behavior-equivalence-report
    description: 行为等价验证报告
  - name: complexity-reduction-metrics
    description: 复杂度降低指标
enforcement: recommended
verified: true
stability: stable
usage_count: 85
success_rate: 0.88
tools:
  - refactoring-engine: 重构引擎工具
  - test-safety-net: 测试安全网工具
  - dependency-updater: 依赖更新工具
  - change-impact-analyzer: 变更影响分析工具
model: claude-3-5-sonnet-20240620
production_validated: true
evidence_types:
  required:
    - test_output
    - refactor_report
---

# Skill: 系统化重构

## 核心原则
**重构 = 行为不变 + 结构改善。**
任何重构必须保证外部行为完全不变，只改善内部结构。每一步重构都应在测试保护下进行。

## 任务目标
在测试保护下，系统化地改善代码结构，消除技术债务，提升代码可读性和可维护性，同时确保功能行为零改变。

## 执行步骤
1. **建立安全网**：
   - 确认已有充分的测试覆盖（≥80%）
   - 运行全量测试，记录基线结果
   - 如果测试不足，先补充测试再开始重构
2. **识别重构目标**：
   - 代码重复（DRY违反）
   - 过长函数（>50行）
   - 过深嵌套（>3层）
   - 命名不清
   - 职责混乱（SRP违反）
   - 过度耦合
3. **制定重构计划**：
   - 列出重构项清单
   - 按风险排序（低风险优先）
   - 每个重构项独立可验证
   - 估算每项重构的影响范围
4. **逐步重构**（每步遵循小步修改+立即验证）：
   - **提取函数**：将代码片段提取为独立函数
   - **重命名**：改善变量、函数、类的命名
   - **移动功能**：将方法移到更合适的类中
   - **简化条件**：用卫语句替代深层嵌套
   - **消除重复**：提取公共逻辑
   - 每步重构后立即运行测试
5. **验证行为不变**：
   - 运行全量测试，结果与基线一致
   - 运行Lint检查，无新增错误
   - 确认公开接口签名未改变
6. **提交重构**：
   - 重构代码与功能代码分开提交
   - 提交信息明确标注"refactor"
   - 附带重构前后对比说明

## 重构安全规则
- ❌ **禁止**：重构与功能修改混合进行
- ❌ **禁止**：在没有测试保护的情况下重构
- ❌ **禁止**：一次重构多个不相关的项
- ✅ **要求**：每次重构后立即运行测试
- ✅ **要求**：重构不改变公开API的行为
- ✅ **要求**：重构提交与功能提交分离

## 验收标准
- 全量测试结果与重构前完全一致
- 公开API行为零改变
- 代码复杂度降低（圈复杂度、嵌套深度）
- 代码重复减少
- 命名更清晰，职责更单一
- 重构提交与功能提交分离

## 常见问题
- **Q: 重构过程中测试失败了怎么办？**
  A: 立即回退到上一个测试通过的状态，重新评估重构方案
- **Q: 测试覆盖不足但急需重构怎么办？**
  A: 先补充测试到≥80%覆盖率，再开始重构。不跳过安全网
- **Q: 重构范围比预期大怎么办？**
  A: 拆分为更小的重构步骤，每步独立验证。不扩大单次重构范围
- **Q: 性能重构与结构重构冲突怎么办？**
  A: 分两步进行：先结构重构保证可读性，再性能重构保证效率，每步独立验证
