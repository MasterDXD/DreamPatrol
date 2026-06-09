﻿﻿﻿# 核心功能-多Agent协作流程

## 概述
本文档描述AIProject系统中多Agent协作的核心流程（2.73.4），包括Skill自动路由、TDD强制、目标执行、深化推理、协作模式选择、任务分配、执行、审核和验收的完整生命周期。

## 核心功能
1. **Skill自动路由**：根据任务上下文自动匹配并激活相关Skill，三层缓存架构（L1摘要/L2指令/L3资源），语义匹配+否定模式检测
2. **TDD强制门禁**：开发任务必须先写测试后写代码，RED-GREEN-REFACTOR循环，覆盖率阈值验证，抽象层级检查
3. **目标执行引擎**（v2.7新增）：长期目标自动分解、自主迭代收敛、停滞检测、持久化恢复、暂停/恢复/取消生命周期管理
4. **深化推理系统**（v2.7新增）：多轮迭代深化、质量评分、收敛检测、自适应深度控制、21个深化子模块
5. **协作模式路由**（v2.7新增）：6种协作模式自动选择（solo/generator-verifier/orchestrator-subagent/agent-teams/message-bus/shared-state）
6. **子Agent执行**（v2.7新增）：并行执行、带验证的执行循环、模型解析、隔离上下文、搜索结果缓存
7. **审核与验收**：多级审核 + verification-before-completion证据验证 + 生成器验证器双重保障
8. **容错与恢复**：自动重试、Checkpoint恢复、模型降级、熔断器、限流器

## 实现原理
```
用户需求 → CommandRouter(命令解析) → SkillRouter(技能匹配)
    → PhaseOrchestrator(阶段验证) → RBACEnforcer(权限检查)
    → ProgrammableHookExecutor(前置Hook) → CollaborationModeRouter(协作模式选择)
    → SubagentExecutor(子Agent执行) / GoalExecutor(目标迭代)
    → DeepeningOrchestrator(深化推理) → QualityScorer(质量评分)
    → EvidenceVerifier(证据验证) → TDDGate(TDD门禁)
    → ProgrammableHookExecutor(后置Hook) → 结果返回
```

## 任务生命周期
1. **Created**：任务创建，等待分配
2. **Assigned**：任务已分配给Agent
3. **Skill Matched**：SkillRouter自动匹配并激活相关Skill（三层缓存加载）
4. **Mode Selected**：CollaborationModeRouter选择协作模式
5. **In Progress**：Agent按Skill步骤执行（TDD门禁：先测试后实现）
6. **Deepening**：DeepeningOrchestrator执行深化推理（可选，按深度级别）
7. **Verifying**：执行verification-before-completion + GeneratorVerifier双重验证
8. **Review**：提交审核（附带验证证据）
9. **Revision**：审核不通过，返回修改
10. **Approved**：审核通过
11. **Completed**：任务完成

## 目标执行流程（v2.7新增）
```
创建目标 → 自动分解子任务 → 迭代执行循环
    → 每轮：执行子任务 → 质量评分 → 收敛检测
    → 收敛：标记完成
    → 停滞（5轮改进低于阈值）：标记失败
    → 支持暂停/恢复/取消操作
    → 持久化到.harness/goals/，支持TTL过期
```

目标状态：PENDING → DECOMPOSING → EXECUTING → ITERATING → PAUSED → COMPLETED / FAILED / CANCELLED / BLOCKED

## 深化推理流程（v2.7新增）
```
任务输入 → 深度评估（quick/standard/deep/intensive）
    → Agent选择 → 上下文增强 → 思维检索
    → 迭代执行 → 结果融合 → 质量评分
    → 收敛检测 → 未收敛则继续迭代
    → 生成器验证 → 输出结果
```

深度级别映射：quick→1轮, standard→1轮, deep→2轮, intensive→4轮

## 协作模式选择（v2.7新增）
| 模式 | 信号关键词 | 适用Agent数 | 说明 |
|------|-----------|------------|------|
| solo | 单一/简单/simple/single | 1 | 单Agent独立执行 |
| generator-verifier | 审查/验证/review/verify | 2-3 | 生成-验证者模式 |
| orchestrator-subagent | 拆解/并行/decompose/parallel | 3-5 | 调度-子智能体模式 |
| agent-teams | 协调/团队/coordinate/team | 3-5 | 智能体团队模式 |
| message-bus | 事件/订阅/event/subscribe | 2-10 | 消息总线模式 |
| shared-state | 同步/共享/sync/shared | 2-8 | 共享状态模式 |

## 协作模式详解（v2.7新增）

CollaborationModeRouter基于信号关键词、任务特征（taskTraits）和Agent数量自动选择最优协作模式。评分权重体系：复杂度高+0.2，多Agent加成+0.3，深化推理加成+0.15，单Agent惩罚-0.2，历史匹配加成+0.1，深化历史加成+0.15。支持手动覆盖（最多100条），覆盖记录TTL过期自动清理。

### solo（单Agent独立模式）

**工作原理**：仅一个Agent独立执行任务，无协作开销。当可用Agent数量为1、任务简单无需多Agent参与、或所需执行器未附加时自动退化为solo模式。

**适用场景**：简单任务、单Agent即可完成的场景，如单文件修改、简单查询、配置更新。任务特征标记为`simple`或`single`时自动触发。

**退化为solo的条件**：
- 可用Agent数量为1
- 所需执行器（SubagentExecutor或AgentChannel）未附加到CollaborationModeRouter
- 所有模式的评分均为0（无信号匹配、无特征匹配、Agent数量不足）

**优点**：
- 零协作开销，执行延迟最低
- 无需额外基础设施（SubagentExecutor、AgentChannel）
- 适合快速响应的简单任务

**缺点**：
- 无交叉验证，输出质量依赖单Agent能力
- 无法处理需要多视角或多角色的复杂任务
- 缺乏容错，Agent失败即任务失败

### 模式选择策略详解

CollaborationModeRouter的`selectMode()`方法实现基于评分的模式选择算法，流程如下：

**第一步：手动覆盖检查**。检查`_modeOverrides`映射表，若当前会话存在手动覆盖记录，直接返回覆盖模式，跳过自动评分。覆盖记录包含`{mode, overridden: true}`标记，触发`mode-overridden`事件。

**第二步：特征推断**。若任务未提供`taskTraits`，调用`_inferTraits(taskDescription)`从任务描述中推断特征标签。推断逻辑基于信号关键词匹配：如描述中包含"审查"则推断`quality_critical`特征。

**第三步：逐模式评分**。遍历5条`MODE_SELECTION_RULES`规则，为每个模式计算综合评分：

```
score = 0
for each signal in rule.signals:
    if taskDescription.contains(signal): score += 0.2  // 信号匹配加成
for each trait in taskTraits:
    if rule.traitSet.contains(trait): score += 0.3     // 特征匹配加成
if agentCount in [rule.minAgents, rule.maxAgents]:
    score += 0.15                                        // Agent数量匹配加成
elif agentCount < rule.minAgents:
    score += -0.2                                        // Agent不足惩罚
score = min(score, 1.0)                                  // 上限截断
```

**第四步：排序选优**。将所有模式按评分降序排列，取最高分模式。若所有评分为0，默认选择`orchestrator-subagent`模式。

**第五步：生成推理说明**。`_buildReasoning()`方法生成人类可读的选择理由，包含：选定模式名称、置信度百分比、适用场景描述、匹配特征列表、Agent数量与推荐范围对比。

**第六步：历史记录**。将选择结果推入`_history`（BoundedArray，容量100），记录模式、置信度、特征和时间戳，供后续分析和优化。

### 模式切换机制

CollaborationModeRouter支持运行时模式切换，包括手动覆盖和自动降级两种机制。

**手动覆盖**：
- `setOverride(sessionId, mode)`：为指定会话设置模式覆盖，最多100条（MAX_MODE_OVERRIDES）
- `clearOverride(sessionId)`：清除指定会话的覆盖
- 覆盖记录存储在`_modeOverrides`（Map）中，通过`_cleanupTimer`定期清理过期记录（TTL=1小时）
- 覆盖触发`mode-overridden`事件

**自动降级**：
- 当选定模式所需的执行器未附加时，自动降级为solo模式
- 降级触发`mode-degraded`事件，包含`{requestedMode, fallbackMode, reason}`
- 降级场景：
  - orchestrator-subagent/generator-verifier模式需要SubagentExecutor，未附加时降级
  - agent-teams/message-bus/shared-state模式需要AgentChannel，未附加时降级
- 降级后仍以选定模式名称返回，但标记`degraded: true`

**执行入口**：`executeWithMode(task, executeFn, verifyFn)`方法根据自动选择的模式分发到对应的执行方法：

| 模式 | 执行方法 | 依赖组件 |
|------|---------|---------|
| solo | 直接调用executeFn | 无 |
| generator-verifier | _executeGeneratorVerifier | SubagentExecutor |
| orchestrator-subagent | _executeOrchestratorSubagent | SubagentExecutor |
| agent-teams | _executeAgentTeams | AgentChannel |
| message-bus | _executeMessageBus | AgentChannel |
| shared-state | _executeSharedState | AgentChannel |

**事件体系**：CollaborationModeRouter在模式选择和执行过程中发出4种事件：
- `mode-selected`：模式自动选择完成，包含模式、置信度、推理说明、全量评分
- `mode-overridden`：手动覆盖生效，包含会话ID和覆盖模式
- `mode-degraded`：模式降级，包含请求模式、降级模式和原因
- `execution-error`：执行过程出错，包含模式和错误信息

### generator-verifier（生成-验证者模式）

**工作原理**：一个Agent负责生成输出（如代码、文档、方案），另一个独立Agent负责验证输出质量。验证者不参与生成过程，确保审查独立性。执行流程为：Generator执行任务 → Verifier独立审查 → 通过则输出，不通过则反馈给Generator重新生成。

**适用场景**：质量优先场景，如代码审查、报告撰写、数据校验、安全审计。任务特征标记为`quality_critical`或`needs_independent_verification`时自动触发。

**优点**：
- 独立验证消除自我确认偏差，输出质量有双重保障
- 验证者可从不同视角发现生成者遗漏的问题
- 结构简单，Agent间协调开销低

**缺点**：
- 仅2-3个Agent参与，不适合大规模并行任务
- 验证者与生成者能力需互补，否则验证流于形式
- 串行执行（生成→验证），延迟高于纯并行模式

**配置方式**：
```javascript
const router = new CollaborationModeRouter();
router.attachSubagentExecutor(subagentExecutor);
const result = await router.route({
  description: '审查认证模块代码',
  taskTraits: ['quality_critical', 'needs_independent_verification'],
  agents: ['task-worker', 'code-reviewer'],
}, executeFn);
```

### orchestrator-subagent（调度-子智能体模式）

**工作原理**：Lead Agent（编排者）将复杂任务分解为多个子任务，通过SubagentExecutor并行分发给子Agent执行。编排者负责子任务划分、结果汇总和错误处理。子Agent间互不依赖，各自在隔离上下文中独立执行。

**适用场景**：任务可拆解场景，如多模块并行开发、大规模研究、批量数据处理。任务特征标记为`decomposable`、`parallelizable`或`research`时自动触发。

**优点**：
- 子任务并行执行，显著缩短总完成时间
- 编排者统一调度，避免子Agent间冲突
- 子Agent隔离上下文，防止信息泄漏和状态污染

**缺点**：
- 依赖编排者的分解质量，分解不当导致子任务粒度不均
- 子任务间存在隐含依赖时，并行执行可能产生冲突
- 结果汇总需要额外融合逻辑

**配置方式**：
```javascript
const result = await router.route({
  description: '并行开发三个微服务',
  taskTraits: ['decomposable', 'parallelizable'],
  subtasks: [task1, task2, task3],
  agentConfigs: [
    { agentId: 'task-worker', skillId: 'tdd-implement' },
    { agentId: 'task-worker', skillId: 'tdd-implement' },
    { agentId: 'task-worker', skillId: 'tdd-implement' },
  ],
}, executeFn);
```

### agent-teams（智能体团队模式）

**工作原理**：多个Agent组成协作团队，通过AgentChannel直接通信。协调者发起提案（proposal），各Agent独立执行并提交结果，协调者汇总后决议。Agent间可维护持久共享状态，支持多轮协商达成共识。

**适用场景**：成员需沟通场景，如复杂重构、跨模块协调、架构迁移。任务特征标记为`coordination_heavy`、`cross_cutting`或`refactoring`时自动触发。

**优点**：
- Agent间直接通信，信息传递效率高
- 支持多轮协商和共识达成，适合需要协调的复杂任务
- 持久状态维护，Agent可基于团队历史决策行动

**缺点**：
- 通信开销随Agent数量增长，团队过大时效率下降
- 共识达成可能耗时，存在活锁风险
- 需要AgentChannel支持，依赖基础设施完备性

**配置方式**：
```javascript
router.attachAgentChannel(agentChannel);
const result = await router.route({
  description: '协调重构认证和授权模块',
  taskTraits: ['coordination_heavy', 'cross_cutting'],
  agents: ['domain-analyst', 'task-worker', 'quality-assurance'],
}, executeFn);
```

### message-bus（消息总线模式）

**工作原理**：Agent通过共享消息总线进行发布/订阅式通信。协调者广播任务分配，各Agent独立执行后将结果发送回协调者。支持事件驱动架构，Agent可动态加入或退出，无需预先知道所有参与者。

**适用场景**：事件驱动扩展场景，如微服务编排、动态能力接入、监控告警处理。任务特征标记为`event_driven`、`extensible`或`dynamic`时自动触发。

**优点**：
- 松耦合架构，Agent可动态加入/退出，扩展性强
- 支持广播和点对点通信，灵活度高
- 适合2-10个Agent的大规模协作

**缺点**：
- 消息顺序不保证，需要应用层处理一致性
- 调试困难，消息流追踪复杂
- 广播风暴风险，需合理设计消息过滤

**配置方式**：
```javascript
router.attachAgentChannel(agentChannel);
const result = await router.route({
  description: '编排微服务部署流水线',
  taskTraits: ['event_driven', 'extensible'],
  agents: ['team-lead', 'task-worker', 'devops-engineer'],
}, executeFn);
```

### shared-state（共享状态模式）

**工作原理**：多Agent通过共享存储实时协作。协调者创建共享状态键（sharedKey），各Agent在执行过程中读写共享状态，支持版本化写入（setSharedWithVersion）检测写冲突。状态从`in-progress`到`completed`的生命周期由协调者管理。

**适用场景**：多源实时协作场景，如实时文档编辑、多数据源同步、协同设计。任务特征标记为`realtime_sync`、`multi_source`或`shared_data`时自动触发。

**优点**：
- 实时状态共享，Agent可感知其他Agent的进展
- 版本化写入检测冲突，保证数据一致性
- 适合需要紧密协作的2-8个Agent场景

**缺点**：
- 写冲突需要应用层解决，复杂度较高
- 共享状态的生命周期管理需要额外关注
- Agent数量过多时冲突概率增大

**配置方式**：
```javascript
router.attachAgentChannel(agentChannel);
const result = await router.route({
  description: '多源数据同步与融合',
  taskTraits: ['realtime_sync', 'multi_source', 'shared_data'],
  agents: ['task-worker', 'domain-analyst'],
}, executeFn);
```

## 配对对话（PairChat）详解（v2.7新增）

PairChat实现双Agent（提议者-审查者）实时协作对话，通过多轮提议-审查-修正循环达成共识。适用于代码审查、架构评审等需要双角色对抗性协作的场景。

### 角色定义

| 角色 | 标识 | 职责 |
|------|------|------|
| 提议者（Proposer） | proposer | 生成初始方案/代码/文档，根据审查反馈进行修正 |
| 审查者（Reviewer） | reviewer | 独立审查提议者输出，提供反馈和修正建议，决定是否批准 |

### 完整协作流程

```
startSession(proposer, reviewer, artifact)
    → 创建会话（状态=PENDING）
    → 循环：
        addRound(sessionId, {
            proposerOutput,      // 提议者本轮输出
            reviewerFeedback,    // 审查者本轮反馈
            corrections,         // 修正项列表
            approved             // 是否批准
        })
        → _evaluateConsensus()  // 评估共识状态
        → 共识达成 / 达到最大轮次 / 超时 → 会话结束
```

### 轮流发言机制

每轮对话包含提议者和审查者的完整交互：

1. **提议者发言**：生成`proposerOutput`，可以是代码、文档、方案等制品
2. **审查者反馈**：提供`reviewerFeedback`，包含审查意见和`corrections`修正列表
3. **批准判定**：审查者设置`approved`标志，true表示审查通过
4. **下一步动作**：`_getNextAction()`根据当前状态决定后续操作：
   - `complete`：会话已结束或审查已通过
   - `proposer-revise`：存在修正项，提议者需修改
   - `reviewer-review`：无修正项但未批准，审查者继续审查

### 共识达成算法

`_evaluateConsensus()`方法实现三级共识评估：

**第一级：直接批准**。审查者在当前轮次设置`approved=true`，共识立即达成，置信度为1.0。

**第二级：趋势批准**（需`requireApproval=false`）。取最近3轮数据，计算批准率：
```
approvalRate = recentRounds.filter(r => r.approved).length / recentRounds.length
if approvalRate >= consensusThreshold(0.8): 共识达成，置信度=approvalRate
```

**第三级：修正递减**。取最近3轮的修正数量趋势，若修正数量严格递减且最后一轮修正数为0，则共识达成，置信度0.85。

**共识失败条件**：
- 轮次达到`maxRounds`（默认5）仍未达成共识
- 轮次超时（`roundTimeoutMs`，默认与TTL缓存相同）

### 会话状态管理

**会话生命周期**：
```
PENDING → REACHED（共识达成）
PENDING → FAILED（超时/最大轮次/共识失败）
```

**会话容量管理**：
- 最大会话数：200（可配置`maxSessions`）
- 超出容量时淘汰策略：优先淘汰已完成（REACHED）或已失败（FAILED）的会话，其次淘汰最早创建的会话

**超时检测**：
- 每60秒执行一次`_cleanupTimedOutSessions()`清理
- 判定条件：会话状态为PENDING且最后活动时间距当前超过`roundTimeoutMs`
- 超时会话状态转为FAILED，触发`session-timeout`事件

**统计追踪**：
- `totalCorrections`：总修正数
- `totalRounds`：总轮次数
- `totalSessions`：总会话数
- `timedOutSessions`：超时会话数
- `avgCorrectionsPerSession`：每会话平均修正数
- `avgRoundsPerSession`：每会话平均轮次数

### 事件体系

| 事件 | 触发时机 | 数据 |
|------|---------|------|
| session-started | 会话创建 | sessionId, proposer, reviewer |
| round-completed | 轮次完成 | sessionId, round, approved, corrections数 |
| consensus-reached | 共识达成 | sessionId, round, corrections总数 |
| consensus-failed | 共识失败 | sessionId, rounds, reason |
| session-timeout | 会话超时 | sessionId |

### 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| maxRounds | 5 | 最大对话轮次 |
| consensusThreshold | 0.8 | 共识阈值（批准率） |
| roundTimeoutMs | DEFAULT_TTL_CACHE_MS | 轮次超时时间 |
| requireApproval | true | 是否要求显式批准 |
| trackCorrections | true | 是否追踪修正统计 |
| maxSessions | 200 | 最大并发会话数 |

### 使用示例

```javascript
const pairChat = new PairChat({ maxRounds: 5, consensusThreshold: 0.8 });

const { sessionId } = pairChat.startSession({
  proposer: 'task-worker',
  reviewer: 'domain-analyst',
  artifact: 'src/auth/login.js',
  artifactType: 'code',
});

let result = pairChat.addRound(sessionId, {
  proposerOutput: '初始代码实现...',
  reviewerFeedback: '需要添加输入验证',
  corrections: ['缺少输入验证', '错误处理不完善'],
  approved: false,
});

while (result.sessionStatus === 'pending') {
  result = pairChat.addRound(sessionId, {
    proposerOutput: '修正后的代码...',
    reviewerFeedback: '验证逻辑需加强',
    corrections: ['边界条件处理'],
    approved: false,
  });
}
```

## 链式对话（ChatChain）详解（v2.7新增）

ChatChain编排多Agent按预定义的原子任务链顺序处理，上下文在链中逐级传递和累积。内置六阶段原子任务链模板，支持任务依赖解析、条件分支和TDD阶段标记。

### 六阶段原子任务链模板

ChatChain预定义了6个阶段的原子任务链，每个阶段包含多个有序任务：

**brainstorming阶段**（2个任务）：
1. `explore-requirements`：Team Lead探索需求边界和约束
2. `validate-feasibility`：Domain Analyst验证技术可行性

**requirement-analysis阶段**（3个任务）：
1. `gather-requirements`：Team Lead收集和整理需求
2. `analyze-constraints`：Domain Analyst分析技术约束和依赖
3. `define-acceptance`：QA定义验收标准（可选）

**architecture-design阶段**（3个任务）：
1. `design-architecture`：Domain Analyst设计系统架构
2. `review-architecture`：Domain Analyst审查架构设计（pair-chat模式）
3. `define-interfaces`：Domain Analyst定义模块接口

**module-development阶段**（6个任务）：
1. `write-test-first`：Task Worker编写测试用例（RED阶段）
2. `implement-feature`：Task Worker实现功能代码（GREEN阶段，依赖write-test-first）
3. `pair-review-code`：Domain Analyst两两对话审查代码（pair-chat模式，依赖implement-feature）
4. `refactor-if-needed`：Task Worker根据审查反馈重构（REFACTOR阶段，可选，条件：review-feedback）
5. `security-check`：QA安全审计（依赖implement-feature）
6. `self-reflect`：Task Worker自反思验证（self-reflection模式，依赖security-check）

**integration-testing阶段**（3个任务）：
1. `write-integration-tests`：QA编写集成测试
2. `pair-debug-failures`：QA+Task Worker两两对话协同调试（pair-chat模式，可选，条件：test-failures）
3. `regression-check`：QA回归验证（依赖write-integration-tests）

**deployment阶段**（4个任务）：
1. `generate-docs`：Technical Writer生成项目文档
2. `auto-doc-gen`：Technical Writer自动生成用户手册和依赖说明（依赖generate-docs）
3. `deploy`：DevOps Engineer部署上线（依赖generate-docs）
4. `health-check`：DevOps Engineer部署后健康检查（依赖deploy）

### 上下文传递机制

上下文在链中逐级传递和累积，每个任务可访问前序任务的执行结果：

**任务结果传递**：`completeTask(chainId, taskId, result)`将结果存储在任务的`result`字段中，后续任务可通过链对象访问前序任务的结果。

**依赖解析**：`_getNextTasks(chain)`方法根据`dependsOn`字段计算当前可执行的任务集合。任务可执行的条件：状态为PENDING且所有依赖任务已完成或已跳过。

**条件分支**：任务可设置`condition`字段，如`review-feedback`、`test-failures`。条件任务在`_getNextTasks`中返回但标记为可选，由执行层根据运行时状态决定是否执行。

**TDD阶段标记**：任务可设置`tddPhase`字段（RED/GREEN/REFACTOR），与TDD门禁联动，确保开发流程遵循测试驱动开发规范。

### 结果聚合策略

**链完成判定**：当所有`required=true`的任务状态为COMPLETED时，整条链标记为COMPLETED。可选任务（`required=false`）的完成状态不影响链完成判定。

**任务失败处理**：
- 必需任务失败：整条链标记为FAILED，触发`chain-failed`事件
- 可选任务失败：跳过该任务（状态设为SKIPPED），链继续执行

**统计追踪**：
- `totalChains`/`completedChains`/`failedChains`：链级别统计
- `totalTasks`/`completedTasks`：任务级别统计
- `taskCompletionRate`：任务完成率
- `chainCompletionRate`：链完成率

### 链生命周期管理

**创建链**：`createChain(phase, customTasks)`基于阶段模板或自定义任务列表创建链。自动解析依赖关系并标记阻塞状态。超出容量（默认100条链）时淘汰已完成或已失败的链。

**任务状态机**：
```
PENDING → IN_PROGRESS → COMPLETED
PENDING → IN_PROGRESS → FAILED
PENDING → BLOCKED → PENDING（依赖解除后）
PENDING → SKIPPED（可选任务条件不满足时）
```

**事件体系**：

| 事件 | 触发时机 | 数据 |
|------|---------|------|
| chain-created | 链创建 | chainId, phase, taskCount |
| task-completed | 任务完成 | chainId, taskId, status |
| task-failed | 任务失败 | chainId, taskId, error |
| chain-completed | 链完成 | chainId, phase, taskCount |
| chain-failed | 链失败 | chainId, phase, failedTask |

### 使用示例

```javascript
const chatChain = new ChatChain({ maxChains: 100 });

const { chainId, tasks, nextTasks } = chatChain.createChain('module-development');

const firstTask = nextTasks[0];
chatChain.startTask(chainId, firstTask.taskId);

chatChain.completeTask(chainId, firstTask.taskId, {
  testFile: 'test/auth/login.test.js',
  testCount: 12,
  status: 'RED',
});

const nextAvailable = chatChain.getNextTasks(chainId);
```

## 输出融合（OutputFusion）详解（v2.7新增）

OutputFusion将多个Agent的输出结果合并为单一高质量结果，支持四种融合策略。维护融合历史环形缓冲区用于审计和回溯。

### 四种融合策略

#### Cascade（级联融合）

**原理**：按优先级排序Agent输出，取最高优先级结果作为主结果，用低优先级结果补充主结果中缺失的字段。

**算法流程**：
1. 按`priorityOrder`排序结果（未指定时按置信度降序）
2. 取排序后第一个结果作为主结果（primary）
3. 若主结果是对象，遍历后续结果（supplements），将主结果中缺失的键从补充结果中填充
4. 若主结果是数组，直接返回主结果（不补充）
5. 置信度取主结果的置信度

**适用场景**：Agent能力有明确优先级差异的场景，如专家Agent优先+辅助Agent补充。

**冲突解决**：主结果中已存在的键不会被覆盖，仅补充缺失键。这保证了高优先级Agent的输出完整性。

#### Vote（投票融合）

**原理**：按置信度加权多数表决，从多个Agent的决策中选出共识决策。

**算法流程**：
1. 从每个Agent结果中提取投票值（通过`voteField`指定字段，默认`decision`）
2. 按置信度加权累计各投票值的权重
3. 取权重最高的投票值作为胜出决策
4. 置信度=胜出权重/总权重

**投票值提取**：`_extractVote(result, voteField)`从结果中提取投票值。若结果是对象则取指定字段，否则直接使用结果本身。

**无共识处理**：当总权重为0时，返回`no_consensus`决策，置信度为0，同时返回投票分布供人工判断。

**适用场景**：需要多Agent达成决策共识的场景，如方案选择、优先级排序。

#### Weighted（加权融合）

**原理**：按权重归一化合并数值字段，实现多Agent输出的定量融合。

**算法流程**：
1. 计算每个Agent的权重（优先使用`options.weights`映射，否则使用置信度）
2. 计算总权重并归一化
3. 按权重降序排列结果
4. 逐键合并输出：
   - 数值类型：加权平均（value × normalizedWeight）
   - 其他类型：首次出现优先（高权重Agent的值优先）
5. 置信度=min(totalWeight/agentCount, 1.0)

**适用场景**：需要定量融合多Agent评估结果的场景，如评分聚合、指标计算。

#### Review（审查融合）

**原理**：实现者-审查者模式，高优先级Agent作为实现者，其余Agent作为审查者提供反馈。

**算法流程**：
1. 按`priorityOrder`排序结果
2. 第一个结果作为实现者（implementer）输出
3. 其余结果作为审查者（reviewers），提取反馈信息
4. 判定审查结果：所有审查者批准时置信度0.9，否则0.5，无审查者时0.3
5. 融合输出包含：实现者输出、审查反馈列表、是否全部批准

**审查反馈结构**：
```javascript
{
  agentId: 'reviewer-agent',
  feedback: '审查意见内容',
  approved: true/false
}
```

**适用场景**：生成-审查分离的场景，如代码实现+代码审查、文档撰写+文档审核。

### 融合策略选择指南

| 场景 | 推荐策略 | 原因 |
|------|---------|------|
| Agent能力有明确层级 | Cascade | 高能力Agent优先，低能力补充 |
| 需要决策共识 | Vote | 多数表决消除个体偏差 |
| 定量评估聚合 | Weighted | 加权平均保留定量信息 |
| 生成+审查分离 | Review | 实现与审查角色明确 |

### 融合历史与审计

OutputFusion维护环形缓冲区（RingBuffer，默认容量200）记录每次融合的元数据：
- `strategy`：使用的融合策略
- `agentCount`：参与Agent数量
- `confidence`：融合结果置信度
- `timestamp`：融合时间

`getStats()`方法返回统计信息：总融合次数、策略分布、平均置信度、平均Agent数、最近10次融合记录。

### 事件体系

| 事件 | 触发时机 | 数据 |
|------|---------|------|
| fusion-complete | 融合完成 | strategy, agentCount, confidence, timestamp |

### 使用示例

```javascript
const fusion = new OutputFusion({ defaultStrategy: 'weighted', maxHistory: 200 });

const results = [
  { output: { score: 85, issues: 3 }, confidence: 0.9, agentId: 'expert-reviewer' },
  { output: { score: 78, issues: 5 }, confidence: 0.7, agentId: 'junior-reviewer' },
  { output: { score: 82, issues: 4 }, confidence: 0.8, agentId: 'security-reviewer' },
];

const { fused, confidence } = await fusion.fuse(results, 'weighted', {
  weights: { 'expert-reviewer': 0.5, 'junior-reviewer': 0.2, 'security-reviewer': 0.3 },
});
```

## 子Agent执行机制（v2.7新增）

SubagentExecutor是子Agent生命周期管理器，负责子Agent的创建、执行、取消、重试和统计追踪。每个子Agent拥有独立的隔离上下文和Token预算，支持并行执行和验证循环。

### 创建与生命周期

子Agent状态机：`PENDING → RUNNING → COMPLETED / FAILED / CANCELLED`

**创建流程**：
1. 调用`spawn(task, agentConfig)`生成子Agent
2. 验证任务合法性（description必填、长度≤2048字符）
3. 检查并发上限（默认maxConcurrent=5）和Token预算
4. 通过RBAC/ModelSelector链解析模型（优先级：Agent定义覆盖 > Skill映射 > 默认模型）
5. 创建隔离上下文（IsolatedContextManager），注入任务描述、约束条件、成功标准
6. 生成操作句柄（handle），返回给调用方

**取消流程**：
- 单个取消：`cancel(handleId)` — 设置状态为CANCELLED，清除超时定时器，中止AbortController
- 批量取消：`cancelAll()` — 遍历所有活跃句柄逐一取消
- 关闭时自动取消所有活跃子Agent

### 并行执行策略

`executeParallel(tasks, agentConfigs, executeFn)`支持批量并行执行：
1. 调用`spawnParallel`批量生成子Agent（受maxSubagentsPerTask=5限制）
2. 对所有句柄并行调用执行函数
3. 使用`Promise.allSettled`等待全部完成
4. 分类收集成功结果和失败错误

### 带验证的执行循环

`executeWithVerification(task, agentConfig, executeFn, verifyFn)`实现执行-验证-重试闭环：
1. 执行子Agent获取输出
2. 调用验证函数`verifyFn(output, task)`检查结果
3. 验证通过则返回成功
4. 验证失败且未达最大迭代次数时，将前轮输出注入自回归上下文，触发重试
5. 达到最大迭代次数仍失败则返回失败结果

### 隔离上下文

每个子Agent通过IsolatedContextManager创建独立上下文：
- 上下文包含：任务描述、Agent角色、工具集、父会话ID、约束条件、成功标准
- 上下文ID附加到任务对象的`_isolatedContextId`字段
- 执行完成后自动释放上下文资源
- 最大上下文数为maxConcurrent×2

### 搜索结果缓存

SubagentExecutor内置搜索结果缓存，避免重复查询：
- 缓存容量：100条（超出时淘汰最旧记录）
- TTL过期：5分钟（访问时自动检查并清除过期条目）
- 写入：`cacheSearchResult(query, result)` — 查询长度限制1000字符
- 读取：`getCachedSearchResult(query)` — 过期自动清除返回null

### Token预算与统计

- 每个子Agent默认Token预算：50,000
- 预算超限时拒绝创建新子Agent（触发`spawn-rejected`事件）
- 执行完成后自动向SessionManager报告Token使用量
- 统计指标：totalSpawned/totalCompleted/totalFailed/totalCancelled/totalRetries/totalTokensUsed/budgetExceeded/successRate/avgTokensPerSubagent

## 集成编排器详解（v2.7新增）

EnsembleOrchestrator实现三种集成学习模式，借鉴机器学习中集成方法的思想，通过多Agent协作提升输出质量和可靠性。根据任务特征和Agent数量自动选择集成模式，单Agent时退化为solo模式。

### 模式自动选择策略

`_selectMode(task, agents)`方法根据任务类型和Agent数量自动选择集成模式：

| 条件 | 选择模式 | 原因 |
|------|---------|------|
| 任务类型为stability/review/consensus | Bagging | 稳定性任务需要并行求稳 |
| 任务类型为precision/optimize/fix | Boosting | 精确性任务需要串行纠错 |
| Agent数量≥4 | Stacking | Agent充足时元学习更有效 |
| 其他情况 | Bagging（默认） | Bagging是最稳健的默认选择 |

**强制模式**：可通过`options.mode`参数强制指定集成模式，跳过自动选择。

**solo退化**：当Agent数量为1时，直接执行单Agent，返回`{mode: 'solo', rounds: 1}`。当Agent数量为0时，返回`{output: null, confidence: 0, mode: 'none'}`。

### Bagging（并行求稳）

**原理**：对每个Agent生成Bootstrap采样变体任务（特征采样比例默认0.7），各Agent并行执行不同视角的任务变体，最后通过多数投票或加权平均融合输出。借鉴机器学习中Bagging（Bootstrap Aggregating）的思想，通过多样性降低方差。

**执行流程**：
1. 选取最多10个Agent（可配置maxAgents）
2. 为每个Agent生成Bootstrap采样变体（使用LCG确定性伪随机算法保证可复现）
3. 并行执行所有Agent（Promise.allSettled）
4. 过滤无效结果（output为null的结果），融合有效输出
5. 记录贡献度到AgentContributionTracker

**Bootstrap采样算法**：
```
_bootstrapSample(task, agentIndex, totalAgents):
    taskKeys = 过滤掉以'_'开头的任务属性键
    featureCount = ceil(taskKeys.length × featureSampleRatio)
    seed = agentIndex × 1000 + Date.now() % 10000
    selectedKeys = _sampleWithReplacement(taskKeys, featureCount, seed)
    variant = 仅包含selectedKeys中属性的任务副本
    variant._bootstrapIndex = agentIndex
    variant._bootstrapTotal = totalAgents
    variant._sampledFeatures = selectedKeys
```

**LCG伪随机采样**：使用线性同余生成器（Linear Congruential Generator）实现确定性有放回采样：
```
rng = seed
for i in range(count):
    rng = (rng × 1103515245 + 12345) & 0x7fffffff
    idx = rng % array.length
    result.push(array[idx])
```
相同种子产生相同采样结果，保证实验可复现性。

**融合策略**：
- 字符串输出：多数投票（`_majorityVote`），置信度为投票占比
- 数值输出：取平均值，置信度为平均置信度
- 对象输出：逐键合并（`_fuseObjectOutputs`），数值取平均、字符串多数投票、其他类型取首个非undefined值，置信度取一致性与平均置信度的较大值
- 其他类型：取首个输出，置信度为平均置信度

**一致性计算**（`_computeAgreement`）：对对象输出计算键值一致比例，所有Agent在同一键上具有相同值时一致性最高。

**适用场景**：追求稳定性和共识的任务，如代码审查共识、方案评审、需求确认。

### Boosting（串行纠错）

**原理**：逐轮迭代执行Agent，每轮根据前轮结果调整方面权重（aspectWeights），提取残差上下文（residualContext）指导后续Agent关注薄弱环节。采用AdaBoost权重公式计算Agent权重。借鉴机器学习中Boosting的思想，通过聚焦错误样本降低偏差。

**执行流程**：
1. 初始化方面权重（所有任务属性权重=1.0）
2. 逐轮执行（最多maxRounds轮，不超过Agent数量）：
   a. 选择Agent：`agents[round % agents.length]`，轮转使用
   b. 应用方面权重：`_applyAspectWeights(task, aspectWeights)`生成加权任务
   c. 注入残差上下文：从上一轮结果提取残差，附加到任务的`_residualFocus`字段
   d. 执行Agent
   e. 计算Agent权重：基于错误率使用AdaBoost公式
   f. 更新方面权重：根据匹配度调整
   g. 早停检测
3. 指数加权融合各轮结果

**方面权重初始化**（`_initAspectWeights`）：
```
for each key in task (非'_'开头):
    aspectWeights[key] = 1.0
```

**方面权重更新规则**（`_updateAspectWeights`）：
- 匹配度<0.5的方面：权重增加（1 + learningRate），提升关注度
- 匹配度≥0.5的方面：权重降低（1 - learningRate×0.5），减少冗余关注
- 权重范围限制在[0.1, 3.0]

**Agent权重计算**（`_computeAgentWeight`）：采用AdaBoost公式：
```
α = 0.5 × ln((1-ε) / ε)
```
其中ε为错误率。错误率越低权重越高，错误率接近0.5时权重趋近0，错误率高于0.5时权重为负（表示劣于随机）。使用ε=1e-10防止除零错误和对数溢出。

**残差提取**（`_extractResidual`）：从前轮输出中识别薄弱方面（null/undefined/空字符串属性），根据置信度生成改进建议。残差上下文结构：
```javascript
{
  weakAspects: ['field1', 'field2'],
  suggestions: ['改进field1的建议', '改进field2的建议'],
  previousConfidence: 0.6
}
```

**早停策略**：
- 连续无改善轮数≥earlyStopPatience(2)时停止
- 置信度≥qualityThreshold(0.95)时停止
- 改善判定：当前轮置信度>历史最佳置信度

**Boosting融合算法**（`_fuseBoosting`）：
1. 计算总权重：`totalWeight = Σ exp(agentWeight_i)`
2. 加权置信度：`weightedConfidence = Σ (confidence_i × exp(agentWeight_i) / totalWeight)`
3. 取最佳轮次结果
4. 对象类型输出：取最佳轮次输出并附加`_boostingRefinements`字段（精化轮次数）
5. 非对象类型：在最佳轮次输出与加权置信度之间选择更优者
6. 最终置信度：`max(weightedConfidence, bestRound.confidence)`

**适用场景**：需要逐步纠错和精确优化的任务，如Bug修复、性能优化、代码重构。

### Stacking（元学习）

**原理**：将前N-1个Agent作为基础层并行执行，最后一个Agent作为元层。元层Agent接收所有基础层输出及其置信度，组合为最终结果。借鉴机器学习中Stacking的思想，通过元学习器学习如何最优组合基础输出。

**执行流程**：
1. 基础层Agent并行执行原始任务（Promise.allSettled）
2. 收集基础层有效结果（过滤null输出）
3. 构建元任务：
   ```javascript
   metaTask = {
     ...task,
     _baseOutputs: [{output, confidence}, ...],  // 基础层输出和置信度
     _metaInstruction: 'Combine the above base outputs into an optimal final result. Weight higher-confidence outputs more.'
   }
   ```
4. 元Agent执行元任务，组合基础层输出
5. 融合：元Agent输出有效时直接采用；无效时退化为Boosting融合

**Stacking融合算法**（`_fuseStacking`）：
- 元Agent输出有效：直接采用元Agent结果，置信度取元Agent置信度（默认0.7）
- 元Agent输出无效：退化为Boosting融合，将基础层结果转换为Boosting格式：
  ```
          agentWeight_i = log(confidence_i / (1 - confidence_i + 1e-10))
          agentWeight限制在[-5, 5]范围内
          然后调用_fuseBoosting(baseResults, null)
  ```

**贡献度记录**：
- 基础层Agent：mode='stacking_base'，记录各自置信度
- 元Agent：mode='stacking_meta'，记录元层置信度

**权重分配**：
- 基础层Agent权重：按置信度比例分配（confidence_i / totalConfidence）
- 元Agent权重：1.0（元层具有最终组合权）

**适用场景**：Agent数量充足（≥4）且需要元学习组合的复杂任务，如多方案综合决策、跨领域知识整合。

### 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| maxRounds | 5 | Boosting最大迭代轮数 |
| earlyStopPatience | 2 | Boosting早停耐心轮数 |
| qualityThreshold | 0.95 | 质量收敛阈值 |
| bootstrapRatio | 0.7 | Bagging采样比例 |
| featureSampleRatio | 0.7 | 特征采样比例 |
| learningRate | 0.5 | Boosting学习率 |

### 置信度规范化

`_sanitizeConfidence(value, defaultValue)`方法确保置信度值合法：
- 非有限数（NaN/Infinity）→ defaultValue
- 超出[0, 1]范围 → 截断到[0, 1]
- null/undefined → defaultValue

## Agent多样性管理（v2.7新增）

AgentDiversityManager从角色（role）、方法（approach）、错误（error）和视角（perspective）四个维度评估Agent团队多样性，检测同质化风险并推荐集成学习模式。维护Agent档案（角色、能力、历史错误/成功、视角权重），基于成功率动态调整Agent权重。

### 四维多样性评估

**角色多样性（role_diversity）**：衡量团队中角色类型的丰富程度。计算方式为不同角色数/总Agent数，上限1.0。例如3个Agent分别担任analyst/worker/reviewer，角色多样性为3/3=1.0；若3个都是worker，则为1/3≈0.33。

**计算公式**：
```
role_diversity = min(unique_roles / total_agents, 1.0)
```

**方法多样性（approach_diversity）**：衡量Agent能力集的重叠程度。使用Jaccard距离计算：对每对Agent计算能力交集/并集比，取1减去平均重叠度。能力完全不重叠时多样性为1.0，完全相同时为0。

**计算公式**：
```
for each pair (i, j):
    Jaccard_similarity(i,j) = |capabilities_i ∩ capabilities_j| / |capabilities_i ∪ capabilities_j|
approach_diversity = 1 - average(Jaccard_similarity)
```

能力列表上限为100（MAX_CAPABILITIES），超出时截断。

**错误多样性（error_diversity）**：衡量Agent历史错误模式的差异程度。同样使用Jaccard距离计算历史错误类型的重叠度。错误模式越不同，团队抗风险能力越强。

**计算公式**：
```
for each pair (i, j):
    error_overlap(i,j) = |error_types_i ∩ error_types_j| / |error_types_i ∪ error_types_j|
    (跳过并集为0的Agent对)
error_diversity = 1 - average(error_overlap)
```

**视角多样性（perspective_diversity）**：衡量Agent视角标签的丰富程度。计算方式为不同视角数/总Agent数，上限1.0。视角标签如optimistic/conservative/neutral等。

**计算公式**：
```
perspective_diversity = min(unique_perspectives / total_agents, 1.0)
```

**综合得分**：四维度的算术平均值。达到多样性阈值（默认0.3）时标记为多样化团队。

```
overall_score = (role_div + approach_div + error_div + perspective_div) / 4
diverse = overall_score >= diversity_threshold (默认0.3)
```

### Agent档案与权重动态调整

注册Agent时创建档案，包含角色、能力列表、视角标签。每次任务执行后记录结果（成功/失败），基于成功率动态调整权重：

**档案结构**：
```javascript
{
  agentId: 'task-worker',
  role: 'worker',                    // Agent角色
  capabilities: ['coding', 'testing'], // 能力列表（上限100项）
  pastErrors: [],                     // 历史错误记录（上限100条）
  pastSuccesses: [],                  // 历史成功记录（上限100条）
  perspective: 'neutral',             // 视角标签
  weight: 1.0,                        // 动态权重[0.5, 1.0]
  registeredAt: timestamp             // 注册时间
}
```

**权重更新公式**：
```
weight = 0.5 + successRate × 0.5
```

权重范围[0.5, 1.0]，成功率100%的Agent权重为1.0，成功率0%的Agent权重为0.5。成功和错误记录各保留最近100条。

**Agent容量管理**：最大Agent数50（可配置`maxAgents`），超出时淘汰最早注册的Agent。重新注册已有Agent时更新角色、能力和视角，保留历史记录和权重。

### 集成学习模式推荐

`getEnsembleRecommendation(task)`方法根据团队多样性自动推荐集成模式：

| 多样性 | 绩效 | 推荐模式 | 原因 |
|--------|------|---------|------|
| 低（<阈值） | 任意 | Boosting | 低多样性需串行纠错弥补 |
| 高 | 高绩效Agent≥3 | Bagging | 高多样性+高绩效适合并行求稳 |
| 高 | 高绩效Agent<3 | Boosting | 混合情况Boosting更安全 |

**推荐算法**：
1. 获取所有已注册Agent，计算团队多样性
2. 若多样性低于阈值（默认0.3），推荐Boosting模式，选择权重最高的前3个Agent
3. 若多样性高且高绩效Agent（weight≥0.7）≥3个，推荐Bagging模式，选择高绩效Agent的前5个
4. 若多样性高但高绩效Agent不足3个，推荐Boosting模式，选择权重最高的前3个Agent

**推荐结果结构**：
```javascript
{
  mode: 'bagging' | 'boosting',
  agents: ['agent-1', 'agent-2', 'agent-3'],  // 按权重排序
  reason: 'high_diversity_high_performers_bagging',
  diversityScore: 0.65
}
```

### 同质化风险检测

当综合多样性得分低于阈值（默认0.3）时，团队被标记为非多样化。同质化团队的风险包括：
- 对同一类错误缺乏免疫力
- 解决方案缺乏创新性
- 验证环节可能流于形式

**建议措施**：
- 引入不同角色的Agent（提升角色多样性）
- 添加具有不同能力集的Agent（提升方法多样性）
- 调整视角标签增加视角多样性（提升视角多样性）
- 分析历史错误模式，引入错误类型互补的Agent（提升错误多样性）

### 多样性评估历史

AgentDiversityManager维护评估历史记录（BoundedArray，默认容量50），每次`computeDiversity()`调用后自动记录：
```javascript
{
  agentIds: ['agent-1', 'agent-2'],
  result: { score, metrics, diverse },
  timestamp: Date.now()
}
```

可通过`getHistory()`获取历史记录的浅拷贝，用于趋势分析和多样性变化追踪。

## Agent贡献度追踪（v2.7新增）

AgentContributionTracker记录各Agent在集成过程中的贡献权重和置信度，计算特征重要性、Top贡献者排名和模式分布统计。

### 记录机制

每次集成执行完成后，EnsembleOrchestrator自动调用`record()`记录贡献条目：
- agent：Agent标识符
- mode：集成模式（bagging/boosting/stacking_base/stacking_meta）
- agentConfidence：Agent自身置信度
- ensembleConfidence：集成整体置信度
- weight：Agent在集成中的权重
- timestamp：记录时间

记录数上限默认1000条，超出时自动淘汰最旧记录并递减对应Agent的统计数据。

### 特征重要性

`getFeatureImportance()`返回所有Agent的特征重要性映射表，每项包含：
- averageWeight：平均权重（总权重/参与次数），衡量Agent在集成中的平均贡献度
- averageConfidence：平均置信度，衡量Agent输出的可靠程度
- participationCount：参与次数，衡量Agent的活跃程度
- modes：模式分布（如{bagging: 5, boosting: 3}），衡量Agent在不同模式下的参与情况

### Top贡献者排名

`getTopContributors(n)`按平均权重降序排列，返回排名前N的贡献者列表。默认N=5。排名依据为平均权重，权重越高表示Agent在集成中的贡献越大。

### 模式分布统计

`getStats()`返回追踪器汇总信息：
- totalRecords：总记录数
- uniqueAgents：唯一Agent数量
- modeDistribution：各集成模式的记录数量分布（如{bagging: 20, boosting: 15, stacking_base: 10, stacking_meta: 5}）

### 与EnsembleOrchestrator的集成

EnsembleOrchestrator通过`setContributionTracker(tracker)`绑定贡献度追踪器。在三种集成模式执行完成后自动记录：
- Bagging：每个有效结果的Agent记录一条（mode='bagging'）
- Boosting：每轮结果的Agent记录一条（mode='boosting'，包含agentWeight）
- Stacking：基础层Agent记录一条（mode='stacking_base'），元Agent记录一条（mode='stacking_meta'）

## 容错与恢复机制详解（v2.7新增）

系统在多个层面实现容错与恢复，确保任务执行的可靠性和连续性。从任务级重试到系统级熔断，形成完整的容错体系。

### 自动重试策略（RetryEngine）

RetryEngine提供带指数退避的任务重试和三级升级策略。

**重试机制**：
- 默认最大重试次数：3次（上限100次）
- 退避算法：指数退避，`backoff = backoffBaseMs × 2^(attempt-1)`，基础时间1000ms，上限受MAX_BACKOFF_MS约束
- 关闭检测：休眠期间每500ms检查关闭标志，支持优雅中断

**三级升级策略**：

| 级别 | 说明 | 触发条件 |
|------|------|---------|
| retry | 常规重试 | 任务执行失败 |
| replan | 重新规划 | 重试耗尽后，调用task.replan(errors)生成新任务重新执行 |
| decompose | 分解子任务 | 重新规划仍失败，调用task.decompose(errors)分解为子任务递归执行 |

**升级流程**：
```
执行失败 → 重试(最多3次,指数退避)
    → 重试耗尽 → replan(重新规划,再重试3次)
        → replan失败 → decompose(分解子任务,递归执行)
            → decompose失败 → 返回{success:false, escalatedTo:'decompose'}
```

递归深度限制：MAX_DECOMPOSE_DEPTH=3，防止无限递归。

**事件通知**：
- `task-completed`：任务成功完成
- `task-retry`：任务重试
- `retry-exhausted`：重试耗尽
- `escalation`：升级触发（附带级别信息）

### Checkpoint恢复流程（CheckpointManager）

CheckpointManager为会话状态提供持久化快照和恢复能力，支持因果WAL协调回滚。

**检查点创建**：
- 同步创建：`create(sessionId, data)` — 立即持久化到`.harness/checkpoints/`
- 异步创建：`createAsync(sessionId, data)` — 异步写入，适合高频场景
- 检查点数据包含：phase（当前阶段）、completedSkills（已完成技能）、tokensUsed（Token使用量）、agentHistory（Agent操作历史）、causalWalSequence（因果WAL序列号）、metadata（自定义元数据）
- 单调时间戳保证：新检查点时间戳严格递增
- 容量限制：最多50个检查点，超出时淘汰最旧的

**检查点恢复**：
- 基础恢复：`restore(checkpointId)` — 返回快照数据（phase、completedSkills、tokensUsed等）
- 因果协调恢复：`restoreWithCausalRollback(checkpointId, causalDataBus)` — 恢复状态同时协调CausalDataBus的WAL回滚到检查点记录的序列号，确保因果一致性
- 恢复后需验证数据一致性，特别是跨模块状态

**持久化机制**：
- 使用原子写入（writeAtomic）防止写入中断导致数据损坏
- 启动时从`.harness/checkpoints/`目录自动加载已有检查点
- 关闭时持久化所有内存中的检查点（支持同步和异步两种关闭方式）

### 模型降级策略（ModelSelector）

ModelSelector根据Skill类型、任务复杂度和预算状态自动选择模型，支持三级降级。

**模型层级**：

| 层级 | 模型 | 成本乘数 | 适用场景 |
|------|------|---------|---------|
| premium | gpt-4o, claude-3-opus, deepseek-v3 | 1.0 | 架构设计、调试、安全审计 |
| standard | gpt-4o-mini, claude-3-sonnet | 0.15 | TDD开发、代码审查、自反思 |
| economy | gpt-3.5-turbo, deepseek-chat | 0.02 | 测试执行、部署、文档生成 |

**Skill-Model映射**：每个Skill预配置推荐模型和选择原因。例如brainstorming映射gpt-4o（创意探索需要发散思维），integration-testing映射gpt-3.5-turbo（测试执行模式固定）。

**降级触发条件**：

| 预算状态 | 触发阈值 | 降级策略 |
|---------|---------|---------|
| constrained | Token使用达80% | premium降级为standard |
| critical | Token使用达95% | premium降级为economy，standard降级为economy |
| exhausted | Token使用达100% | 强制使用economy模型 |

**特殊调整**：
- 重试升级：economy模型失败重试时，升级到standard模型
- 简单任务降级：检测到简单任务时，premium降级为standard
- 会话成本控制：单会话成本达预算80%时，premium降级为standard

**预算恢复**：TokenManager重置时（token-reset事件），所有降级标志自动清除，恢复原始模型选择策略。

### 熔断器机制（DeepeningCircuitBreaker）

熔断器为深化执行提供容错保护，防止故障级联。管理命名熔断器的状态转换。

**状态机**：

```
Closed（正常通行）──连续失败≥阈值──→ Open（熔断拒绝）
    ↑                                    │
    │                          resetTimeout超时后
    │                                    ↓
    └──连续成功≥successThreshold── Half-Open（试探性放行）
                                         │
                              半开状态失败 → 回到Open
```

**配置参数**：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| maxCircuits | 100 | 最大熔断器数量 |
| failureThreshold | 5 | 触发熔断的连续失败次数 |
| successThreshold | 3 | 半开恢复到关闭所需连续成功次数 |
| resetTimeout | 30000ms | Open→Half-Open自动恢复超时 |
| maxHalfOpenCalls | 1 | 半开状态最大试探调用数 |

**安全执行包装**：`execute(name, fn)`在熔断器保护下执行异步函数。熔断器Open时拒绝执行（抛出DEEPENING_CIRCUIT_OPEN错误），Half-Open时限制并发试探调用数。执行成功自动记录success，失败自动记录failure。

**强制状态操作**：
- `forceOpen(name)`：强制熔断，用于运维紧急干预
- `forceClose(name)`：强制恢复，重置失败计数
- `forceHalfOpen(name)`：强制半开，重置试探调用计数

### 限流器机制（DeepeningRateLimiter）

多维度限流器为深化操作提供并发控制、时间窗口限流和令牌桶节流三维度保护。

**并发限流**：
- 最大并发执行数：默认10
- `acquire(executionId, agentId)`获取执行许可，超出并发上限返回false
- `release(executionId)`释放执行许可

**时间窗口限流**：
- 每分钟最大请求数：默认60
- 每小时最大请求数：默认1000
- 支持按Agent自定义限制：`setAgentLimit(agentId, {maxPerMinute})`
- 自动清理过期窗口数据

**令牌桶节流**：
- 创建命名令牌桶：`createBucket(name, {rate, capacity})`
- 默认填充速率：10令牌/间隔
- 默认容量：10令牌
- 默认填充间隔：1000ms
- 消费令牌：`tryConsume(name, count)` — 令牌不足时返回`{allowed: false, retryAfter}`
- 动态调整：`updateRate(name, newRate)` — 运行时修改填充速率
- 最大桶数：100

**限流维度协同**：
```
请求进入 → 并发检查(活跃执行数<maxConcurrent)
    → 小时窗口检查(该Agent小时请求数<maxPerHour)
        → 分钟窗口检查(该Agent分钟请求数<maxPerMinute)
            → 令牌桶检查(桶中令牌数≥消费数)
                → 放行 / 拒绝(附带retryAfter)
```

## Skill自动路由流程
1. **发现**：扫描.harness/skills/目录（84个Skill），解析YAML Frontmatter，构建L1摘要缓存
2. **匹配**：根据用户意图（语义匹配）、当前阶段、已完成Skill匹配最合适的Skill
3. **冲突解决**：多Skill匹配时按phase→priority→depends_on排序
4. **加载**：按需加载L2完整指令和L3参考资源
5. **权限检查**：RBACEnforcer验证Agent是否有权执行Skill
6. **执行**：检查依赖和enforcement级别，按步骤执行
7. **流转**：完成后检查后继Skill是否需要自动激活

## API接口
详细API文档参见 [接口文档-Web API](../tools/接口文档-Web API.md)，核心端点包括：

| 分类 | 端点数 | 关键端点 |
|------|--------|---------|
| 核心仪表盘 | 11 | /api/overview, /api/agents, /api/skills, /api/sessions |
| 目标执行 | 5 | /api/goal/create, /api/goal/pause, /api/goal/resume |
| 子Agent | 4 | /api/subagent/stats, /api/subagent/active |
| 协作模式 | 10 | /api/collaboration/modes, /api/pair-chat/stats |
| 深化子系统 | 40+ | /api/deepening/stats, /api/deepening/dashboard |
| Agent管理 | 22 | /api/agent-lifecycle/list, /api/agent-monitor/dashboard |

## 使用示例
```
1. 用户提交需求："开发一个用户认证模块"
2. CommandRouter解析命令（如/plan）
3. SkillRouter匹配Skill链：brainstorming → requirement-analysis → architecture-design
4. PhaseOrchestrator验证阶段转换合法性
5. CollaborationModeRouter选择orchestrator-subagent模式
6. Team Lead拆解为4个目标：
   - GOAL-001: 需求分析（分配给Domain Analyst，激活requirement-analysis）
   - GOAL-002: 架构设计（分配给Domain Analyst，激活architecture-design）
   - GOAL-003: TDD开发（分配给Task Worker，激活tdd-implement→module-development）
   - GOAL-004: 测试验收（分配给QA，激活integration-testing）
7. GOAL-003执行过程：
   a. GoalExecutor自动分解为子任务：登录/注册/密码重置
   b. SubagentExecutor并行执行子任务
   c. DeepeningOrchestrator执行深化推理（deep级别，2轮迭代）
   d. QualityScorer评分，ConvergenceDetector检测收敛
   e. TDD门禁：RED→GREEN→REFACTOR
   f. EvidenceVerifier验证完成证据
   g. GeneratorVerifier验证生成输出正确性
8. 全部通过，Team Lead汇总交付
```

### 集成编排示例
```
场景：代码审查需要多Agent共识

1. EnsembleOrchestrator选择Bagging模式（任务类型=review）
2. 3个Agent并行审查同一代码：
   - Agent-A：关注安全漏洞（Bootstrap采样侧重安全相关特征）
   - Agent-B：关注性能问题（Bootstrap采样侧重性能相关特征）
   - Agent-C：关注代码规范（Bootstrap采样侧重规范相关特征）
3. 各Agent独立输出审查结果和置信度
4. 融合：对象输出逐键合并，数值取平均，字符串多数投票
5. AgentContributionTracker记录各Agent贡献权重
6. 若一致性低，触发Boosting深化：后续Agent关注前轮薄弱环节
```

### 容错恢复示例
```
场景：子Agent执行超时后的完整恢复流程

1. SubagentExecutor.spawn(task) → 创建子Agent SA-001
2. SA-001执行超时 → 状态转为FAILED
3. RetryEngine接管重试：
   a. 第1次重试：指数退避1000ms后重新执行 → 仍然超时
   b. 第2次重试：退避2000ms后重新执行 → 模型响应错误
   c. 第3次重试：退避4000ms后重新执行 → 仍然失败
4. 重试耗尽，升级到replan：
   a. 调用task.replan(errors)生成简化任务
   b. 简化任务重试3次 → 成功
5. 若replan也失败，升级到decompose：
   a. 调用task.decompose(errors)分解为2个子任务
   b. 子任务递归执行（深度+1，上限3）
6. CheckpointManager在关键节点创建检查点
7. 若需回滚：restoreWithCausalRollback恢复到最近检查点
```

## TDD门禁规则
- 任何实现代码必须在对应的失败测试之后编写
- 先写代码则删除，从测试重新开始
- 测试覆盖率目标≥80%（可配置）
- 抽象层级检查：文件>300行或新接口>3时发出警告
- 每个RED-GREEN-REFACTOR循环记录在TDDGate中
- verification-before-completion为strict enforcement，不可跳过

## 证据验证体系
22种Skill各有对应的证据需求映射，5维质量评估：
- 完整性：证据内容长度
- 特异性：关键词丰富度
- 一致性：矛盾信息检测
- 可操作性：可操作性检测
- 记忆-代码一致性：文件路径引用与已知路径的一致性

## 注意事项
- 任务分配需考虑Agent的当前负载和模型选择
- 目标执行支持暂停/恢复，适合长时间运行的任务
- 深化推理会消耗额外Token，需根据任务复杂度选择深度级别
- 协作模式可手动覆盖，但建议使用自动选择
- Checkpoint恢复后需验证数据一致性
- Skill自动路由不可跳过enforcement为strict的Skill
- verification-before-completion验证未通过不允许标记任务完成
- 生成器验证器提供5维度加权评分（逻辑0.30/对齐0.25/边界0.20/一致0.15/完整0.10）
- 子Agent并发数受maxConcurrent限制，超出时spawn返回null
- Boosting迭代轮数受maxRounds限制，早停策略可减少不必要的Token消耗
- 熔断器Open状态下所有请求被拒绝，需等待resetTimeout后自动转为Half-Open
- 限流器三维度（并发/时间窗口/令牌桶）协同工作，任一维度超限即拒绝请求
- 模型降级后输出质量可能下降，预算恢复后自动恢复原始模型选择策略
- Agent多样性低于阈值时建议引入不同角色的Agent以降低同质化风险

## 关联文档
- [架构分析-AIProject系统](../architecture/架构分析-AIProject系统.md)
- [功能说明-全部模块清单](../modules/功能说明-全部模块清单.md)
- [接口文档-Web API](../tools/接口文档-Web API.md)
- [模块详解-上下文管理模块](../modules/模块详解-上下文管理模块.md)
- [深度拆解-任务调度执行链路](../deep-dive/深度拆解-任务调度执行链路.md)
- [多Agent协作使用准则](../guidelines/多Agent协作使用准则.md)
- [Skill速查表](../guidelines/Skill速查表.md)
- [开发指南-代码贡献规范](../guidelines/开发指南-代码贡献规范.md)
