---
skill_id: iterative-deepening
name: 迭代深化推理
applicable_agents: [task-worker, domain-analyst, quality-assurance]
trigger: 复杂任务需要多轮迭代优化时
auto_trigger: true
phase: module-development
priority: 2
trigger_conditions:
  - user mentions "深化" or "迭代" or "多轮" or "deepening" or "iterate" or "refine"
  - task complexity assessment returns "deep" or "intensive"
  - previous iteration quality score is below threshold
  - convergence detector reports "not-converged"
depends_on: [architecture-design]
blocks: [verification-before-completion]
causal_inputs:
  - name: architecture-document
    source: architecture-design
    required: false
causal_outputs:
  - name: deepened-output
    description: 深化输出
  - name: convergence-report
    description: 收敛报告
evidence_types:
  required:
    - quality_score_report
    - convergence_report
enforcement: recommended
verified: true
stability: beta
usage_count: 45
success_rate: 0.83
production_validated: true
---

# Skill: 迭代深化推理

## 目标
对复杂任务进行多轮迭代优化，逐步提升输出质量直到收敛，确保最终交付物达到质量阈值。

## 核心原则
**一次生成不是终点，迭代深化才是路径。**
借鉴循环深度Transformer的"堆循环而非堆参数"理念，对同一任务反复执行、逐步聚焦、持续改进，直到质量收敛。

## 设计哲学
- **循环提供推理深度**：同一Agent对同一任务的多轮深化，等效于增加推理深度
- **LTI注入防漂移**：每轮迭代重新注入原始需求和约束，防止目标偏离
- **收敛检测终止**：通过多信号融合判断何时停止迭代，避免无效循环
- **自适应深度**：根据任务复杂度自动选择迭代深度（quick/standard/deep/intensive）

## 执行步骤

### Step 1: 任务复杂度评估
使用AdaptiveDepthController评估任务复杂度：
- 6维信号：scope/multiComponent/risk/reasoning/dependencyDepth/novelty
- 映射到4级深度：quick(1轮)/standard(1轮)/deep(2轮)/intensive(4轮)

### Step 2: 原始上下文注册
使用LTIContextInjector注册原始需求：
- 保存原始目标、约束、需求列表
- 后续每轮迭代自动注入，防止目标漂移

### Step 3: 循环深化执行
使用RecurrentDeepeningScheduler或ProgressiveDeepening执行迭代：
- 每轮聚焦前一轮的弱点（focusAreas）
- 质量评估器评分，判断是否收敛
- 收敛条件：qualityScore >= threshold 或 improvementRate < minImprovement

### Step 4: 收敛检测
使用ConvergenceDetector判断是否继续迭代：
- 5种信号：quality_score/improvement_rate/stability/coverage/dimension_balance
- 4种收敛原因：quality-threshold-met/plateau-detected/quality-degrading/stable-and-sufficient
- 智能推荐：increase-depth/continue-with-focus/rebalance-dimensions/change-strategy

### Step 5: 结果输出
输出最终结果，包含：
- 深化过程的质量分数曲线
- 收敛原因和迭代次数
- 每轮改进的焦点区域

## 与其他Skill的协作
- **tdd-implement**: 在每轮迭代中应用RED-GREEN-REFACTOR
- **code-review**: 在deep/intensive级别自动触发审查
- **verification-before-completion**: 最终输出前强制验证
- **systematic-debugging**: 当收敛原因为quality-degrading时触发调试

## 质量门禁
- 每轮迭代必须产生可验证的输出
- 质量分数必须单调递增（允许微小波动）
- 最终输出的qualityScore必须 >= 0.7

## 验收标准
- 迭代过程产生了质量分数曲线
- 收敛原因明确记录
- 最终qualityScore >= 0.7
- 迭代轮数不超过max_iterations限制

## FAQ
**Q: 何时使用迭代深化而非单次执行？**
A: 当任务复杂度评估为deep或intensive时，或前一次执行质量分数低于阈值时自动触发。

**Q: 如何防止无限迭代？**
A: ConvergenceDetector通过多信号融合判断收敛，同时max_iterations硬性限制最大轮数。

**Q: LTI注入的作用是什么？**
A: 每轮迭代重新注入原始需求和约束，防止Agent在多轮迭代中偏离目标。
