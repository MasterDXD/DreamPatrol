---
skill_id: ship-release
name: 发布工程师
applicable_agents: [task-worker]
trigger: 分支已准备好，需要自动化发布流程时
auto_trigger: false
phase: deployment
priority: 7
trigger_conditions:
  - code-review and integration-testing skills both pass
  - user mentions "发布" or "ship" or "release" or "创建PR" or "推送分支"
  - branch is ready for automated release process
depends_on: [code-review, integration-testing]
blocks: []
causal_inputs:
  - name: review-approval
    source: code-review
    required: true
  - name: test-results
    source: integration-testing
    required: true
causal_outputs:
  - name: pr-link
    description: 创建的PR链接
  - name: release-record
    description: 发布记录
evidence_types:
  required:
    - pr_created
    - test_passed
enforcement: strict
model_tier: small
tags: [ship, release, pr, deploy]
verified: true
stability: stable
---

# Skill: 发布工程师

## 任务目标
执行自动化发布流程，将已通过审查和测试的代码安全推送到远程仓库并创建PR。遵循Boil the Lake原则——只做发布该做的事，不做任何超出发布流程的操作。

## 执行步骤

### 自动化发布流程（严格按序执行，不可跳步）

1. **同步main分支**：
   - 执行 `git fetch origin main`
   - 执行 `git rebase origin/main`
   - 如有冲突：停止流程，报告冲突，等待人工解决
   - ❌ 同步失败 → 阻断发布，报告冲突详情

2. **运行测试**：
   - 执行项目测试命令（从项目配置中读取）
   - 确认所有测试通过
   - ❌ 测试失败 → 阻断发布，报告失败用例

3. **解决Review问题**：
   - 检查是否有未解决的Review评论
   - 确认所有Review建议已处理或已回复
   - ❌ 存在未解决的阻塞级Review → 阻断发布

4. **推送分支**：
   - 执行 `git push origin <branch-name>`
   - 如需强制推送（rebase后）：使用 `--force-with-lease`
   - ❌ 推送失败 → 报告错误，不重试

5. **创建PR**：
   - 使用远程仓库API或CLI创建Pull Request
   - PR标题遵循项目约定格式
   - PR描述包含：变更摘要、测试结果、关联Issue
   - ❌ PR创建失败 → 报告错误

## 验收标准
- main分支已同步，无冲突
- 所有测试通过
- Review问题已全部解决
- 分支已成功推送到远程
- PR已创建且链接可访问
- 发布记录已生成

## 角色边界约束
- **禁止**：讨论产品方向和功能优先级（这是CEO审查的工作）
- **禁止**：修改代码逻辑（发布工程师只做发布，不做开发）
- **禁止**：跳过测试直接推送
- **禁止**：使用 `--force` 强制推送（只能用 `--force-with-lease`）
- **禁止**：自行决定合并PR（合并需要人工确认）

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 执行自动化发布流程，将已通过审查和测试的代码安全推送到远程仓库并创建PR。严格按5步流程执行：同步main分支、运行测试、解决Review问题、推送分支、创建PR。

### Q: 适用于哪些场景？
A: 适用于代码已通过审查和测试后的发布阶段，包括分支合并前的自动化验证、PR创建和发布记录生成。特别适合需要标准化发布流程的团队协作场景。

### Q: 使用此Skill的前提条件是什么？
A: 需要已完成代码审查（code-review）和集成测试（integration-testing）且均通过，有Git远程仓库访问权限，分支已准备好发布。建议已配置项目测试命令和PR模板。
