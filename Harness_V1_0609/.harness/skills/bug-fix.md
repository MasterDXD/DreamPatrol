---
skill_id: bug-fix
name: 缺陷修复
applicable_agents: [task-worker, build-error-solver]
trigger: QA报告缺陷或用户反馈Bug时
auto_trigger: true
phase: module-development
priority: 4
trigger_conditions:
  - quality-assurance reports a defect or bug
  - user reports a bug or issue
  - user mentions "缺陷修复" or "bug fix" or "修复问题"
  - integration-testing skill finds a defect
  - systematic-debugging skill identifies root cause
depends_on: [systematic-debugging]
blocks: [code-review]
causal_inputs:
  - name: root-cause-analysis
    source: systematic-debugging
    required: true
  - name: debug-log
    source: systematic-debugging
    required: false
causal_outputs:
  - name: fix-code
    description: 修复代码
  - name: fix-test
    description: 修复测试
  - name: regression-report
    description: 回归测试报告
verified: true
stability: stable
usage_count: 160
success_rate: 0.93
tools:
  - debugger: 调试器
  - test-runner: 测试执行器
  - diff-viewer: 代码差异查看
  - regression-tester: 回归测试
model: claude-3-5-sonnet-20240620
enforcement: strict
production_validated: true
evidence_types:
  required:
    - test_output
    - fix_verification
---

# Skill: 缺陷修复

## 任务目标
根据缺陷报告定位问题根因，制定修复方案，实施修复并验证，确保缺陷彻底解决且不引入新问题。

## 执行步骤
1. **理解缺陷**：
   - 阅读缺陷报告（复现步骤、预期行为、实际行为）
   - 确认缺陷的严重程度和影响范围
   - 如描述不清晰，向QA确认
2. **复现问题**：
   - 按复现步骤尝试重现
   - 如无法复现，记录环境差异并反馈QA
3. **定位根因**：
   - 阅读相关代码，追踪执行路径
   - 使用搜索工具定位相关文件和函数
   - 识别根本原因（而非表面症状）
4. **制定修复方案**：
   - 设计最小化修复方案（避免过度修改）
   - 评估修复是否影响其他功能
   - 如修复风险高，先与Domain Analyst讨论
5. **实施修复**：
   - 修改代码
   - 添加或补充单元测试（覆盖缺陷场景）
   - 自我验证修复有效
6. **提交审核**：
   - 提交修复代码和测试
   - 附带根因分析和修复说明
   - QA验证修复结果

## 验收标准
- 缺陷场景已修复，原复现步骤不再触发问题
- 新增测试覆盖缺陷场景
- 修复未引入新缺陷
- 根因分析记录在案

## 常见问题
- **Q: 无法复现缺陷怎么办？**
  A: 检查环境差异、数据差异、时序问题，添加更多日志辅助定位
- **Q: 修复会影响其他功能怎么办？**
  A: 评估影响范围，必要时与Domain Analyst讨论，确保回归测试覆盖
- **Q: 根因在第三方库怎么办？**
  A: 记录问题并寻找workaround，同时向库作者报告issue
