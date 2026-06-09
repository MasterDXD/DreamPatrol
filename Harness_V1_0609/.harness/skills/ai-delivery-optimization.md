---
skill_id: ai-delivery-optimization
name: AI交付优化
applicable_agents: [team-lead, domain-analyst, task-worker, quality-assurance]
trigger: 交付效率低下、审查瓶颈、上下文漂移或工作流失衡时
auto_trigger: true
phase: module-development
priority: 3
trigger_conditions:
  - DeliveryEfficiencyMeter检测到审查吞吐失衡(ratio >= 2.0)
  - ContextDriftMonitor检测到HIGH/CRITICAL级别漂移
  - AiCodeTrustScorer检测到ALMOST_CORRECT风险
  - 管道瓶颈检测发现某阶段超时占比>30%
  - 反馈循环趋势为increasing
depends_on: [architecture-design, tdd-implement]
blocks: [deployment]
causal_inputs:
  - name: delivery-metrics
    source: delivery-efficiency-meter
    required: true
  - name: drift-report
    source: context-drift-monitor
    required: false
  - name: trust-assessment
    source: ai-code-trust-scorer
    required: false
causal_outputs:
  - name: optimization-report
    description: 交付优化报告
  - name: workflow-recommendations
    description: 工作流重构建议
evidence_types:
  required:
    - metric_snapshot
    - bottleneck_analysis
causal_invariants:
  - optimization-report
enforcement: recommended
verified: true
stability: stable
usage_count: 0
success_rate: 0.0
tools:
  - delivery-efficiency-meter: 交付效率度量
  - context-drift-monitor: 上下文漂移监控
  - ai-code-trust-scorer: AI代码可信度评估
model: claude-3-5-sonnet-20240620
production_validated: false
---

## 目标

系统性识别和缓解AI交付瓶颈（审查吞吐失衡、上下文漂移、似对非对代码），通过自动化审查、约束重注入和对抗验证，确保端到端交付效率真正提升，而非仅加速编码环节。

# Skill: AI交付优化

## 核心原则
**AI提升的是"打字速度"，交付拼的是"系统把控力"。审查力、系统思维、产品感，才是AI时代的核心壁垒。**

AI只加速了编码（约20%），对需求分析、沟通联调、测试改Bug等其余80%几乎无效。本技能旨在系统性识别和缓解AI交付瓶颈，确保端到端交付效率真正提升。

## 三大瓶颈识别

### 瓶颈1：审查吞吐失衡
- **症状**：AI出码快10倍，但人审速度不变，审查成新瓶颈
- **检测**：`DeliveryEfficiencyMeter.getReviewThroughputImbalance()`
  - ratio >= 4.0 → critical：审查严重堵死
  - ratio >= 2.0 → high：审查明显跟不上
  - ratio >= 1.0 → moderate：审查开始吃力
- **缓解策略**：
  1. 自动化审查：用CodeReviewFrameworkCheck自动校验14+规则
  2. 分层审查：先自动检查规范/安全，人只审架构/业务逻辑
  3. 缩小审查范围：AI按模块分块提交，每次审查量可控

### 瓶颈2：上下文漂移
- **症状**：长任务丢约束，越改越偏，多轮拉锯反而更慢
- **检测**：`ContextDriftMonitor.checkDrift()`
  - CRITICAL：>80%约束丢失，必须立即停止并重新对齐
  - HIGH：>60%约束丢失，需暂停补充上下文
  - MEDIUM：>40%约束丢失，需在当前轮次中强化约束
- **缓解策略**：
  1. 约束快照：任务开始时注册所有约束到ContextDriftMonitor
  2. 周期检查：每轮交互后主动checkDrift()
  3. 约束重注入：漂移检测到时，将原始约束重新注入上下文

### 瓶颈3："似对非对"代码
- **症状**：66%代码"似是而非"，调试比手写更久
- **检测**：`AiCodeTrustScorer`的ALMOST_CORRECT风险指标
  - subtleBugCount >= 3 → severity 0.9
  - subtleBugCount >= 2 → severity 0.8
  - passesBasicTests但edgeCasesHandled=false且errorHandlingComplete=false → severity 0.6
- **缓解策略**：
  1. 强化验证：用GeneratorVerifier五维度验证，不放过"几乎对"
  2. 对抗审查：用AdversarialReview故意找缺陷
  3. 逐段审查：把AI当初级开发，可疑必拒

## 工作流重构模式

### 模式：AI写+测+修，人聚焦需求/架构/决策
```
人类职责（系统把控）          AI职责（执行加速）
─────────────────          ────────────────
需求定义与澄清              代码实现
架构设计与接口定义          单元测试编写
产品决策与优先级            Bug修复
审查关键决策点              重构执行
风险识别与把控              文档生成
```

### 反馈循环优化
1. **度量反馈循环时长**：`DeliveryEfficiencyMeter.startFeedbackLoop()` / `endFeedbackLoop()`
2. **识别趋势**：`getFeedbackLoopDuration().trend`
   - increasing → 反馈循环变长，需优化
   - stable → 维持现状
   - decreasing → 优化有效
3. **缩短循环策略**：
   - 小批量提交：每次只改一个模块，快速验证
   - 自动化测试：TDD门禁确保每轮都有可运行验证
   - 即时反馈：AI自测+自修，减少人工介入轮次

## 执行步骤
1. **诊断阶段**：
   - 收集DeliveryEfficiencyMeter的效率指标
   - 检查ContextDriftMonitor的漂移状态
   - 审查AiCodeTrustScorer的可信度评估
   - 识别管道瓶颈：`getPipelineBottleneck()`
2. **分析阶段**：
   - 判断瓶颈类型（审查失衡/上下文漂移/似对非对/管道堵塞）
   - 量化瓶颈严重程度
   - 确定根因（流程问题/理解债务/系统思维缺失）
3. **干预阶段**：
   - 根据瓶颈类型选择对应缓解策略
   - 调整工作流模式（AI写+测+修 vs 人聚焦需求/架构）
   - 注册约束到ContextDriftMonitor防止漂移
   - 启动反馈循环度量
4. **验证阶段**：
   - 重新度量效率指标，确认改善
   - 检查漂移是否缓解
   - 确认反馈循环趋势为decreasing或stable
   - 生成优化报告作为证据

## 验收标准
- 审查吞吐失衡比率降至2.0以下
- 上下文漂移等级降至MEDIUM以下
- ALMOST_CORRECT风险指标未触发或severity < 0.7
- 管道瓶颈overrun < 30%
- 反馈循环趋势非increasing

## FAQ

- **Q: 什么时候应该触发AI交付优化？** A: 当审查吞吐失衡比率>=2.0、上下文漂移达HIGH级别、或检测到"似对非对"代码风险时。
- **Q: 如何衡量优化效果？** A: 通过审查吞吐比率、上下文漂移等级、反馈循环趋势等指标验证，确认端到端效率真正提升。
- **Q: 优化后AI编码速度会变慢吗？** A: 不会。优化的是端到端交付效率而非编码速度，通过减少返工和调试时间提升整体效率。
