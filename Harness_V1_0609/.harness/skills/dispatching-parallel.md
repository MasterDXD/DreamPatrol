---
skill_id: dispatching-parallel
name: 并行子代理调度
applicable_agents: [team-lead, domain-analyst]
trigger: 存在多个可并行执行的独立任务时
auto_trigger: true
phase: module-development
priority: 3
trigger_conditions:
  - implementation plan contains multiple independent tasks
  - user mentions "并行" or "parallel" or "同时开发"
  - multiple modules can be developed independently
  - architecture-design identifies parallelizable work streams
depends_on: [architecture-design]
blocks: [integration-testing]
causal_inputs:
  - name: architecture-document
    source: architecture-design
    required: false
causal_outputs:
  - name: parallel-execution-results
    description: 并行执行结果
enforcement: optional
verified: true
stability: beta
usage_count: 40
success_rate: 0.80
production_validated: true
evidence_types:
  required:
    - parallel_execution_report
---

# Skill: 并行子代理调度

## 任务目标
将独立的开发任务分配给多个子代理并行执行，通过Git Worktree隔离工作空间，加速开发进度，同时确保代码不冲突。

## 执行步骤
1. **任务独立性分析**：
   - 审查实现计划中的所有任务
   - 识别任务间的依赖关系（哪些必须串行，哪些可以并行）
   - 构建任务依赖图（DAG）
   - 标记可并行执行的任务组
2. **工作空间隔离**：
   - 为每个并行任务创建独立的Git Worktree
   - 每个Worktree在独立分支上工作（feature/TASK-XXX）
   - 确保每个Worktree有干净的测试基线
   - 验证Worktree间无文件级冲突
3. **子代理分配**：
   - 为每个并行任务分配独立的Task Worker子代理
   - 每个子代理在自己的Worktree中工作
   - 明确每个子代理的任务范围和验收标准
   - 配置子代理的上下文（仅加载相关设计文档和规则）
4. **并行执行监控**：
   - 跟踪每个子代理的执行进度
   - 监控各Worktree的变更范围
   - 检测潜在的合并冲突（提前预警）
   - 处理子代理的异常和超时
5. **结果合并**：
   - 等待所有并行任务完成
   - 逐个将Worktree变更合并回主分支
   - 合并时运行全量测试验证
   - 处理合并冲突（必要时协调相关子代理）
6. **清理工作空间**：
   - 删除已合并的Worktree
   - 删除已合并的特性分支
   - 更新任务状态和变更日志

## 并行调度规则
- ✅ 可并行：修改不同文件、不同模块、不同层级的任务
- ❌ 不可并行：修改同一文件、有数据依赖、共享状态的任务
- ⚠️ 需评估：修改相邻文件、共享数据模型、接口变更的任务

## Git Worktree使用规范
```
# 创建Worktree
git worktree add ../project-TASK-XXX feature/TASK-XXX

# 在Worktree中工作
cd ../project-TASK-XXX
# ... 编码、测试 ...

# 完成后合并
git checkout main
git merge feature/TASK-XXX

# 清理Worktree
git worktree remove ../project-TASK-XXX
git branch -d feature/TASK-XXX
```

## 验收标准
- 所有并行任务独立完成，无相互阻塞
- 合并后全量测试通过
- 无遗留的Worktree和特性分支
- 并行执行时间 ≤ 串行执行时间的60%
- 合并冲突在可控范围内解决

## 常见问题
- **Q: 并行任务间发现未预见的依赖怎么办？**
  A: 暂停受影响的并行任务，串行处理依赖，解决后恢复并行
- **Q: 合并冲突过多怎么办？**
  A: 评估是否应该改为串行执行，调整任务划分粒度，减少文件级重叠
- **Q: 子代理执行速度差异大怎么办？**
  A: 先完成的子代理可继续处理其他独立任务，不等慢的子代理
- **Q: Git Worktree不可用怎么办？**
  A: 降级为独立目录+手动分支管理，确保物理隔离即可
