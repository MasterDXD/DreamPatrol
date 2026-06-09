---
skill_id: ooda-loop
name: OODA决策闭环
applicable_agents:
  - task-worker
  - domain-analyst
  - team-lead
  - quality-assurance
trigger: 任务执行需要态势感知、自适应决策或持续闭环迭代时触发
auto_trigger: true
phase: module-development
priority: 4
trigger_conditions:
  - "用户提到OODA或观察判断决策行动"
  - "任务需要持续闭环自适应执行"
  - "需要态势感知或威胁/机会评估"
  - "任务环境多变需要快速决策循环"
  - "提到Boyd循环或决策闭环"
depends_on:
  - tdd-implement
blocks:
  - verification-before-completion
causal_inputs:
  - name: architecture-document
    source: architecture-design
    required: false
  - name: design-spec
    source: requirement-analysis
    required: false
causal_outputs:
  - name: ooda-cycle-report
    type: object
    description: "OODA循环执行报告，包含观察/判断/决策/行动四阶段结果"
evidence:
  - type: ooda-cycle-completed
    description: "至少完成一个完整OODA循环"
    strength: strong
  - type: decision-history
    description: "决策历史记录非空"
    strength: strong
  - type: cycle-speed-report
    description: "循环速度追踪数据可用"
    strength: weak
verified: true
stability: stable
---

## 目标

作为Agent核心底层思维循环，通过Observe→Orient→Decide→Act四阶段实现态势感知、自适应决策和持续闭环迭代，与7步工程流程形成双层搭配。


## 目标

作为Agent核心底层思维循环，通过ObserveOrientDecideAct四阶段实现态势感知、自适应决策和持续闭环迭代，与7步工程流程形成双层搭配。

# OODA决策闭环技能

## 概述


## 执行步骤

### 1. Observe（观察）
采集当前任务上下文、Agent状态和环境信号：
- 任务上下文：目标ID、迭代次数、质量分数
- Agent状态：运行状态、资源使用、错误信息
- 环境信号：测试结果、工具返回、用户反馈
- 反馈信号：上一轮行动结果自动回流

### 2. Orient（定向）
结合目标、记忆、规则解读现状：
- 计算威胁级别（错误/失败/风险信号）
- 计算机会级别（成功/改进/增长信号）
- 检测决策偏差（某模式占比>80%）
- 评估战略对齐度（与目标描述匹配）
- 推荐关注方向：威胁缓解/机会利用/态势感知

### 3. Decide（决策）
选择决策模式并规划行动：
- REACTIVE（反应式）：威胁超阈值，立即响应
- DELIBERATE（审慎式）：平衡态势，深入分析
- CREATIVE（创造式）：机会超阈值，探索创新
- 偏差检测时强制切换为审慎式

### 4. Act（行动）
执行决策并记录结果：
- 记录决策到历史（按cycleId分组）
- 行动结果自动反馈到下一轮观察
- 历史容量限制（200个cycleId，每cycleId 100条）

### 5. 循环迭代
- 自动循环模式（autoLoop配置）
- 循环速度追踪（avgMs/minMs/maxMs/lastMs）
- 多层级嵌套：strategic/operational/tactical

## 验收标准
- [ ] 至少完成一个完整OODA循环（ObserveOrientDecideAct）
- [ ] 决策历史记录非空
- [ ] 循环速度追踪数据可用
- [ ] 威胁/机会级别计算正确
- [ ] 决策偏差检测有效（某模式占比>80%时触发）

## FAQ
- Q: OODA和7步工程流程如何配合？A: OODA是底层思维循环（每一步都在跑），7步Slash命令是上层工程执行流程（规范不乱跑）
- Q: 决策模式如何选择？A: 威胁超阈值REACTIVE，平衡态势DELIBERATE，机会超阈值CREATIVE，偏差检测时强制DELIBERATE
- Q: 多层级OODA如何嵌套？A: strategic(PhaseOrchestrator阶段级)  operational(GoalExecutor迭代级)  tactical(AgentDebugLoop修复级)
