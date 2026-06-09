---
skill_id: verification-before-completion
name: 完成前验证
applicable_agents: [task-worker, domain-analyst, quality-assurance, code-reviewer, security-reviewer, build-error-solver, test-writer]
trigger: Agent声称任务完成，准备提交审核时
auto_trigger: true
phase: module-development
priority: 4
trigger_conditions:
  - any agent claims a task is "完成" or "done" or "complete"
  - task-worker prepares to submit code for review
  - user asks to verify task completion
  - before transitioning from module-development to integration-testing
depends_on: [module-development, tdd-implement]
blocks: [code-review, integration-testing, deployment]
causal_inputs:
  - name: module-source-code
    source: module-development
    required: true
  - name: coverage-report
    source: tdd-implement
    required: true
  - name: review-report
    source: code-review
    required: false
causal_outputs:
  - name: verification-evidence
    description: 验证证据
  - name: completion-certificate
    description: 完成证书
evidence_types:
  required:
    - test_output
    - coverage_report
    - lint_output
    - security_check
causal_invariants:
  - verification-evidence
enforcement: strict
verified: true
stability: stable
usage_count: 180
success_rate: 0.94
tools:
  - evidence-collector: 证据收集工具
  - test-verifier: 测试验证工具
  - lint-checker: 代码检查工具
  - completeness-validator: 完整性验证工具
model: claude-3-5-sonnet-20240620
production_validated: true
---

# Skill: 完成前验证

## 核心原则
**声称"完成了"不算完成，提供证据才算完成。**
任何Agent在声称任务完成前，必须通过本Skill的验证检查，提供实际的、可核查的完成证据。

## 任务目标
在任务标记为"完成"之前，强制执行验证检查，确保交付物真正满足验收标准，杜绝"口头完成"现象。

## 执行步骤
1. **验收标准回顾**：
   - 调取任务的原始验收标准
   - 逐项确认每条标准是否有对应的完成证据
   - 标记缺失证据的项目
2. **功能验证**：
   - 运行所有相关测试，确认测试通过
   - 验证核心功能路径可正常执行
   - 检查边界情况是否已处理
   - **证据要求**：测试运行输出截图或日志
3. **质量验证**：
   - 运行Lint/静态检查，确认零错误（警告可标注但需说明）
   - 检查测试覆盖率 ≥ 80%
   - 确认无遗留TODO/FIXME/HACK标记
   - **证据要求**：Lint输出 + 覆盖率报告
4. **安全验证**：
   - 确认无硬编码的敏感信息
   - 确认输入验证已实现
   - 确认错误处理不泄露内部信息
   - **证据要求**：安全检查清单
5. **文档验证**：
   - 确认公开接口有文档说明
   - 确认变更日志已更新
   - 确认README/使用说明已同步
   - **证据要求**：文档更新diff
6. **简洁性验证**（Karpathy原则：简单至上 + 手术改变）：
   - 确认没有实现未被要求的功能
   - 确认没有为一次性代码创建抽象
   - 确认修改范围仅限于任务要求，未"顺便"重构或改格式
   - 确认新增代码是解决问题的最小实现
   - 确认没有引入不必要的新依赖
   - 确认自己改动产生的孤立代码已清理（因本次变更而未使用的import/变量/函数）
   - 确认预存的死代码仅被提及而非删除（除非被明确要求）
   - **证据要求**：变更diff + 必要性说明
7. **成功标准强度验证**（v2.7.109增强）：
   - 评估验收标准的强度分类（强/弱）
   - **强成功标准**：可独立验证的明确标准（如"测试通过"、"覆盖率≥80%"）→ 允许自主标记完成
   - **弱成功标准**：模糊标准（如"让它工作"、"看起来不错"）→ 需人工确认后方可标记完成
   - 弱标准必须转化为强标准后才能作为验收依据
   - **证据要求**：标准强度分类表
8. **生成验证报告**：
   - 汇总所有验证结果
   - 标记通过/未通过/需关注项
   - 未通过项必须修复后才能标记任务完成

## 验证清单

| 检查项 | 必须通过 | 证据类型 |
|--------|---------|---------|
| 所有测试通过 | ✅ | 测试运行输出 |
| Lint零错误 | ✅ | Lint输出 |
| 测试覆盖率 ≥ 80% | ✅ | 覆盖率报告 |
| 无硬编码敏感信息 | ✅ | 安全扫描结果 |
| 无遗留TODO/FIXME | ✅ | 代码搜索结果 |
| 无未被要求的功能 | ✅ | 变更diff审查 |
| 无一次性代码的抽象 | ✅ | 代码审查 |
| 修改范围限于任务要求 | ✅ | 变更diff审查 |
| 自创孤立代码已清理 | ✅ | 变更diff审查 |
| 预存死代码仅提及未删除 | ⚠️ | 变更diff审查 |
| 成功标准强度已分类 | ✅ | 标准强度分类表 |
| 公开接口有文档 | ✅ | 文档文件 |
| 变更日志已更新 | ⚠️ | changelog diff |
| 性能指标达标 | ⚠️ | 性能测试结果 |
| AI劣质代码模式检查 | ✅ | anti-bad-code规则检查清单 |
| 敏感代码人工审批 | ✅ | HumanApprovalGate审批记录 |

✅ = 必须通过  ⚠️ = 建议通过，不阻塞但需说明原因

## 验收标准
- 所有"必须通过"项均有实际证据支撑
- 验证报告完整，无遗漏检查项
- 未通过项已修复或有明确的后续计划
- 任何Agent不得绕过此验证直接标记任务完成

## 常见问题
- **Q: 测试覆盖率暂时达不到80%怎么办？**
  A: 标记为未通过，列出缺失覆盖的模块，制定补充测试的计划和时间点
- **Q: Lint有少量警告怎么处理？**
  A: 逐条评估，确认无安全风险后可标注"需关注"继续推进，但不得忽略
- **Q: 紧急修复需要跳过验证怎么办？**
  A: 需Team Lead明确授权，跳过项必须记录在案，并在修复后补全验证
