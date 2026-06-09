---
skill_id: review-paranoid
name: 偏执代码审查
applicable_agents: [reviewer]
trigger: 代码准备合并前，需要发现CI无法捕获的生产级Bug时
auto_trigger: true
phase: module-development
priority: 4
trigger_conditions:
  - code-review skill completes with approval
  - user mentions "偏执审查" or "paranoid review" or "生产级Bug" or "深度审查"
  - code is ready to merge and needs extra scrutiny
depends_on: [code-review]
blocks: [integration-testing]
causal_inputs:
  - name: review-approval
    source: code-review
    required: true
  - name: module-source-code
    source: module-development
    required: true
causal_outputs:
  - name: paranoid-review-report
    description: 偏执审查报告
  - name: production-bug-list
    description: 潜在生产级Bug清单
evidence_types:
  required:
    - paranoid_review_report
enforcement: strict
model_tier: small
tags: [review, paranoid, production-bugs]
verified: true
stability: stable
---

# Skill: 偏执代码审查

## 任务目标
在代码审查通过后，以极度偏执的视角扫描CI无法捕获的生产级Bug。这不是代码风格审查，而是专门寻找会导致生产事故的隐蔽问题。遵循Boil the Lake原则——不做无意义的代码美化，只关注可能导致生产故障的代码路径。

## 执行步骤

### 结构性审计清单（6类必须逐一检查）

1. **N+1查询**：
   - 循环内是否有数据库查询或API调用？
   - 关联数据加载是否使用了批量查询？
   - 分页查询是否在循环中执行？

2. **竞态条件**：
   - 共享状态是否有并发保护？
   - 检查-然后-操作（check-then-act）是否原子化？
   - 分布式锁是否正确使用和释放？

3. **信任边界违规**：
   - 外部输入是否在边界处验证？
   - 内部API是否错误地信任了外部数据？
   - 权限检查是否在正确的层级执行？

4. **缺失索引**：
   - 查询条件中的字段是否有数据库索引？
   - 新增的查询模式是否被索引覆盖？
   - 联合查询是否使用了复合索引？

5. **损坏的重试逻辑**：
   - 重试是否幂等？
   - 重试次数和间隔是否合理？
   - 重试失败后是否有降级或告警？

6. **过期读取**：
   - 长事务中是否读取了可能已变更的数据？
   - 缓存数据是否有过期策略？
   - 是否存在读-修改-写的不一致窗口？

### 4级差分自动缩放审查

- **Level 0（1-10行变更）**：快速扫描，聚焦变更行上下文
- **Level 1（11-50行变更）**：标准审查，检查变更影响范围
- **Level 2（51-200行变更）**：深度审查，追踪数据流和状态变更
- **Level 3（200+行变更）**：全量审查，等同于新代码审查

## 验收标准
- 6类结构性审计全部有明确结论
- 所有发现的潜在Bug按严重程度分级（P0-P3）
- P0/P1级Bug必须附带复现条件和修复建议
- 审查报告包含：审计结果、Bug清单、差分级别说明
- 不得以"CI会捕获"为由跳过任何审计项

## 角色边界约束
- **禁止**：讨论代码风格和命名规范（这是代码审查的工作）
- **禁止**：提出重构建议（只关注Bug，不关注代码美感）
- **禁止**：将P0级Bug降级为"建议"
- **禁止**：在存在P0级Bug时批准合并

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 在代码审查通过后，以极度偏执的视角扫描CI无法捕获的生产级Bug。通过6类结构性审计（N+1查询、竞态条件、信任边界违规、缺失索引、损坏的重试逻辑、过期读取）和4级差分自动缩放审查，专门发现导致生产事故的隐蔽问题。

### Q: 适用于哪些场景？
A: 适用于代码准备合并前的深度审查，特别是对生产环境稳定性要求高的场景。当代码审查通过后仍需要额外审查来发现CI难以捕获的边界情况和并发问题时使用。

### Q: 使用此Skill的前提条件是什么？
A: 需要已完成代码审查（code-review）并获得批准，有完整的模块源代码和变更范围信息。审查者需要理解生产环境中的常见故障模式（如竞态条件、N+1查询等）。
