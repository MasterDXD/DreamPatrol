---
skill_id: code-review
name: 代码审查
applicable_agents: [domain-analyst, quality-assurance, code-reviewer]
trigger: task-worker提交代码后
auto_trigger: true
phase: module-development
priority: 4
trigger_conditions:
  - task-worker submits code to staging area
  - module-development or tdd-implement skill completes
  - user mentions "代码审查" or "code review" or "审查代码"
  - user asks to review code quality or check for issues
depends_on: [module-development, tdd-implement]
blocks: [integration-testing]
causal_inputs:
  - name: module-source-code
    source: module-development
    required: true
  - name: coverage-report
    source: tdd-implement
    required: false
causal_outputs:
  - name: review-report
    description: 代码审查报告
  - name: review-approval
    description: 审查批准状态
causal_invariants:
  - review-approval
enforcement: strict
verified: true
stability: stable
usage_count: 200
success_rate: 0.95
tools:
  - linter: 代码风格检查
  - static-analyzer: 静态分析
  - pattern-detector: 反模式检测
  - metrics-reporter: 代码度量报告
model: claude-3-5-sonnet-20240620
production_validated: true
evidence_types:
  required:
    - review_report
---

# Skill: 代码审查

## 任务目标
对Task Worker提交的代码进行全面审查，确保代码质量、规范性和正确性。

## 执行步骤
1. **获取代码变更**：读取Task Worker提交的代码文件和变更说明
2. **规范检查**：
   - 代码风格是否符合项目编码规范
   - 命名是否清晰有意义
   - 函数是否单一职责（不超过50行）
   - 是否有遗留的TODO/FIXME
3. **逻辑检查**：
   - 功能是否完整实现
   - 边界情况是否处理
   - 异常处理是否完善
   - 是否存在潜在的并发问题
4. **安全检查**：
   - 是否有硬编码的敏感信息
   - 输入验证是否充分
   - 是否存在注入风险
5. **AI劣质代码模式检查**（详见[[anti-bad-code]]规则）：
   - 是否有空catch块或静默失败模式
   - 是否有数值转换+??误用（NaN陷阱）
   - 是否有占位符代码标记为完成
   - 是否有过度泛化（通用方案而非针对场景）
   - 错误处理是否完整（外部输入校验、资源操作保护、并发防护）
   - 是否有过度简化（只写happy path，缺少边界处理）
6. **测试检查**：
   - 是否添加了必要的单元测试
   - 测试用例是否覆盖关键路径
   - 错误处理路径是否有测试覆盖
7. **生成审查报告**：使用审核标准模板输出审查结果

## 验收标准
- 所有检查项均有明确结论（通过/不通过/建议）
- 不通过项必须附带具体修改建议
- 审查报告格式规范，信息完整

## 常见问题
- **Q: 代码风格与规范有轻微偏差怎么办？**
  A: 标记为"建议"级别，不阻塞合并，但需在后续迭代中修正
- **Q: 发现安全漏洞怎么处理？**
  A: 标记为"阻塞"级别，立即通知Team Lead，要求Task Worker优先修复
- **Q: 测试覆盖不足但功能正确怎么办？**
  A: 标记为"不通过"，要求补充测试用例后重新提交
