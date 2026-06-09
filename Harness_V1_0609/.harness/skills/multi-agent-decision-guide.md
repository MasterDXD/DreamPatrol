---
skill_id: multi-agent-decision-guide
name: Multi-Agent决策指南
applicable_agents: [team-lead, domain-analyst]
trigger: 评估是否应采用Multi-Agent架构时触发
auto_trigger: true
phase: requirement-analysis
priority: 2
trigger_conditions:
  - 用户讨论Multi-Agent架构选型
  - 任务涉及多Agent协作设计
  - 架构决策需要评估Multi-Agent适用性
  - 用户提到"多智能体"或"Multi-Agent"
depends_on: [brainstorming]
blocks: [architecture-design]
causal_inputs:
  - name: task-context
    source: brainstorming
    required: false
causal_outputs:
  - name: multi-agent-decision
    description: Multi-Agent适用性决策结果
evidence_types:
  required:
    - decision_record
causal_invariants:
  - multi-agent-decision
enforcement: recommended
verified: true
stability: stable
usage_count: 0
success_rate: 0.0
tools:
  - collaboration-mode-router: 协作模式路由与Multi-Agent适用性判断
  - agent-golden-test: Agent黄金数据回归测试
  - agent-monitor: Agent行为监控与推诿检测
model: claude-3-5-sonnet-20240620
production_validated: false
---

## 目标

评估是否应采用Multi-Agent架构，提供适用性决策门禁、架构选择决策树和工程落地避坑清单，确保Multi-Agent的使用是出于业务需要而非技术炫技。

# Skill: Multi-Agent决策指南

## 核心原则
**Multi-Agent是解决复杂问题的手段而非目的。先尝试Prompt工程或单Agent+工具；只有当单体能力触顶，且业务价值足以覆盖Multi-Agent带来的延迟和成本时，才采用基于图结构的Multi-Agent架构。**

## 适用性决策门禁

### 应该使用Multi-Agent的场景（3类）

1. **长链路多角色复杂工作流（SOP场景）**
   - 特征：业务流程需要多角色、长链路协作
   - 示例："写代码+测试"全流程，Coder Agent + QA Agent各司其职
   - 价值：缓解大模型上下文遗忘和能力瓶颈
   - 检测：`CollaborationModeRouter.shouldUseMultiAgent()` 返回 `shouldUse: true`

2. **多视角验证与对抗博弈场景**
   - 特征：需要多方校验，降低"幻觉"问题
   - 示例：金融研报撰写、疑难病例分析，看多专家vs看空专家
   - 价值：通过红蓝对抗机制大幅降低幻觉
   - 检测：任务包含 `quality_critical` 或 `needs_independent_verification` trait

3. **多元异构工具复杂调度场景**
   - 特征：任务需调用多种工具，单Agent易混淆
   - 示例：SQL专家+搜索专家+API专家，"专人专事"
   - 价值：提升工具调度准确性
   - 检测：任务包含 `multi_role` 或 `decomposable` trait

### 坚决避开Multi-Agent的场景（3类）

1. **低延迟（Real-time）要求极高的场景**
   - 原因：Multi-Agent内部多轮交互导致延迟指数级上升
   - 示例：实时客服、高频交易
   - 门禁：`latencyRequirement: 'realtime'` → `shouldUseMultiAgent()` 返回 critical

2. **逻辑高度确定、规则死板的场景**
   - 原因：正则或单轮大模型调用即可解决，上Multi-Agent增加脆弱性和成本
   - 示例：固定格式表单字段提取
   - 门禁：任务匹配 `deterministic_task` 反模式

3. **容错率为0且无人类介入的高危场景**
   - 原因：关键节点需人类拍板，不能让Multi-Agent全权自主闭环
   - 示例：医疗器械底层操控
   - 门禁：`faultTolerance: 'zero'` 且 `hasHumanOversight: false` → critical

## 架构选择决策树

```
任务是否需要多角色协作？
├── 否 → 使用Solo模式（单Agent+工具）
└── 是 → 延迟要求是否严格？
    ├── 是（realtime） → 禁止Multi-Agent
    └── 否 → 任务是否可拆解？
        ├── 否 → 使用Generator-Verifier模式
        └── 是 → 是否需要多视角验证？
            ├── 是 → 使用Agent-Teams模式（含对抗审查）
            └── 否 → 使用Orchestrator-Subagent模式
```

## 工程落地避坑清单

### 坑1：状态迷失与无限死循环
- **检测**：`ConvergenceDetector` + `AgentMonitor.detectShirking()`
- **破解**：WorkflowDAG图状态框架 + 条件路由 + 最大迭代次数强制熔断
- **工具**：`DeepeningCircuitBreaker`（三态熔断器）

### 坑2：成本与延迟爆炸
- **检测**：`TokenManager`（80%/95%/100%三级预警）
- **破解**：大小模型混牌（Supervisor用强推理模型，底层Agent用小模型）+ 上下文压缩
- **工具**：`ModelSelector`（3层级+预算降级）+ `ContextCompressionEngine`

### 坑3：角色边界模糊（越权）
- **检测**：`RBACEnforcer` + `PermissionGuard`
- **破解**：Prompt中明确"能做什么+不能做什么" + 系统底层物理级权限隔离
- **工具**：`AgentSandbox`（strict/moderate/permissive三级隔离）

### 坑4：黑盒调试与溯源困难
- **检测**：`SkillObservability`（执行链路追踪）+ `AuditLogger`（链式哈希）
- **破解**：记录每个Agent的输入/输出/耗时 + 黄金数据级单元测试
- **工具**：`AgentGoldenTest`（黄金数据注册→输出比对→回归检测）

## 执行步骤
1. **适用性评估**：调用 `shouldUseMultiAgent(context)` 判断是否应使用Multi-Agent
2. **架构选择**：若适用，根据决策树选择协作模式（Solo/GV/OS/Teams）
3. **安全门禁**：检查反模式（低延迟/确定性/零容错），确认人类兜底机制
4. **避坑配置**：设置熔断器、Token预算、权限隔离、观测追踪
5. **黄金数据**：注册Agent黄金测试用例，建立回归基线
6. **验证**：运行AgentGoldenTest确认各Agent输出符合预期

## 验收标准
- shouldUseMultiAgent()决策结果与业务判断一致
- 所有Agent黄金测试用例通过
- 无推诿检测告警（detectShirking().detected === false）
- Token预算在可控范围内（<80%）
- 熔断器状态为CLOSED（正常）

## FAQ

- **Q: Multi-Agent是否总是比单Agent更好？** A: 不是。Multi-Agent是解决复杂问题的手段而非目的。先尝试单Agent+工具，仅当单体能力触顶时才考虑Multi-Agent。
- **Q: 什么场景下Multi-Agent反而更差？** A: 低延迟实时场景、逻辑高度确定的规则场景、容错率为0且无人类介入的高危场景。
- **Q: Multi-Agent的主要风险是什么？** A: 状态迷失与死循环、成本与延迟爆炸、角色边界模糊、黑盒调试困难。
