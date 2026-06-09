# 深度拆解-多Agent协作模式全链路

> 版本：2.73.4 | 更新时间：2026-06-02

---

## 概述

多Agent协作是Harness框架实现复杂任务分治的核心能力。协作子系统由7个紧密耦合的模块组成，构建了一条从用户意图识别→协作模式选择→任务编排执行→输出融合→贡献追踪的完整数据流，形成"意图→模式→编排→融合→反馈"的闭环协作机制。

该全链路的设计哲学是：**任何协作始于意图理解，终于质量融合；模式选择由信号驱动而非硬编码，编排执行由依赖解析而非顺序猜测，输出融合由策略适配而非简单拼接**。全链路的核心价值在于将"单Agent串行执行"转化为"多Agent协同涌现"，通过多样性评估和集成学习实现1+1>2的效果。

### 核心设计原则

- **信号驱动选择**：协作模式由任务描述中的信号关键词和任务特征自动推断，而非人工指定
- **依赖解析编排**：任务链执行顺序由`dependsOn`依赖图决定，支持条件分支和TDD阶段标记
- **策略适配融合**：输出融合根据数据类型和场景自动选择cascade/vote/weighted/review策略
- **多样性量化**：四维多样性评估（角色/方法/错误/视角）为集成模式推荐提供数据支撑
- **贡献可追溯**：每条贡献记录包含Agent、模式、权重、置信度，支持Top排名和特征重要性输出
- **优雅降级**：SubagentExecutor/AgentChannel缺失时自动退化为solo模式，不中断执行

---

## 全链路架构

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          多Agent协作全链路                                        │
│                                                                                 │
│  用户请求                                                                        │
│     │                                                                           │
│     ▼                                                                           │
│  ┌──────────────────────┐                                                       │
│  │ CollaborationModeRouter│ ←── 信号关键词 + 任务特征 + Agent数量                  │
│  │ (模式选择入口)         │                                                       │
│  └──────┬───────────────┘                                                       │
│         │ selectMode()                                                           │
│         │ mode = 'generator-verifier' | 'orchestrator-subagent' | ...            │
│         │                                                                       │
│    ┌────┴────────────────────────────────────────┐                               │
│    │                                              │                               │
│    ▼                                              ▼                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐            │
│  │   PairChat   │  │  ChatChain   │  │  EnsembleOrchestrator        │            │
│  │ (配对对话)    │  │ (链式编排)    │  │ (集成编排)                    │            │
│  │              │  │              │  │  ┌────────┐ ┌────────┐       │            │
│  │ Proposer ↔   │  │ Task₁→Task₂ │  │  │Bagging │ │Boosting│       │            │
│  │ Reviewer     │  │ →Task₃→...  │  │  │(并行)  │ │(串行)  │       │            │
│  │ 共识检测      │  │ 依赖解析     │  │  └────────┘ └────────┘       │            │
│  │ 修正追踪      │  │ 条件分支     │  │  ┌────────┐                  │            │
│  │              │  │ TDD阶段标记  │  │  │Stacking│                  │            │
│  └──────┬───────┘  └──────┬───────┘  │  │(元学习)│                  │            │
│         │                 │          │  └────────┘                  │            │
│         │                 │          │  ↑ AgentDiversityManager     │            │
│         │                 │          │  │ (多样性评估+集成推荐)       │            │
│         │                 │          └──────┬───────────────────────┘            │
│         │                 │                 │                                    │
│         ▼                 ▼                 ▼                                    │
│  ┌──────────────────────────────────────────────┐                               │
│  │              OutputFusion                     │                               │
│  │         (多Agent输出融合器)                     │                               │
│  │  cascade | vote | weighted | review           │                               │
│  └──────────────────────┬───────────────────────┘                               │
│                         │                                                       │
│                         ▼                                                       │
│  ┌──────────────────────────────────────────────┐                               │
│  │         AgentContributionTracker              │                               │
│  │         (贡献度追踪与特征重要性)                │                               │
│  └──────────────────────────────────────────────┘                               │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 数据流说明

| 阶段 | 输入 | 处理模块 | 输出 |
|------|------|---------|------|
| 模式选择 | 任务描述+特征+Agent数 | CollaborationModeRouter | mode + confidence + reasoning |
| 配对对话 | proposer + reviewer + artifact | PairChat | 共识结果 + 修正统计 |
| 链式编排 | phase + 任务模板 | ChatChain | 任务执行序列 + 依赖状态 |
| 集成编排 | task + agents + executeFn | EnsembleOrchestrator | 融合输出 + 置信度 + 贡献 |
| 输出融合 | 多Agent结果数组 | OutputFusion | fused + strategy + confidence |
| 贡献追踪 | agent + mode + weight | AgentContributionTracker | 特征重要性 + Top排名 |

---

## 链路一：模式选择链路

### 从用户意图到模式决策

CollaborationModeRouter是协作子系统的入口和调度中心。当用户请求到达时，它通过三步将意图转化为协作模式决策：

```
用户请求
  → _extractDescription(context)     // 提取任务描述（taskDescription + userMessage + goal）
  → _inferTraits(description)        // 从描述推断任务特征标签
  → _calculateScores(context)        // 对每种模式计算评分
  → _selectBestMode(scores)          // 选择最高分模式
  → _buildReasoning(mode, ...)       // 生成选择推理链
```

### CollaborationModeRouter.selectMode() 全流程

#### 步骤1：覆盖检查

```javascript
const override = this._modeOverrides.get(context.sessionId);
if (override) {
  if (Date.now() - override.setAt > this._overrideTTL) {
    this._modeOverrides.delete(context.sessionId);  // TTL过期自动清理
  } else {
    return { mode: override.mode, confidence: 1.0, reasoning: 'Manual mode override', overridden: true };
  }
}
```

| 参数 | 值 | 说明 |
|------|---|------|
| TTL | 1小时（`MS_PER_HOUR`） | 覆盖有效期 |
| 最大覆盖数 | 100（`MAX_MODE_OVERRIDES`） | 超出时淘汰最早的覆盖 |
| 清理频率 | `DEFAULT_PIPELINE_TIMEOUT_MS` | 定时扫描过期覆盖 |

#### 步骤2：描述提取与特征推断

`_extractDescription(context)` 将 `taskDescription`、`userMessage`、`goal` 三个字段拼接为统一描述文本，全部转为小写用于后续匹配。

`_inferTraits(description)` 基于正则表达式从描述中推断任务特征：

| 正则模式 | 推断特征 | 示例输入 |
|---------|---------|---------|
| `审查\|验证\|校验\|review\|verify\|audit` | `quality_critical` | "审查代码质量" |
| `拆解\|并行\|子任务\|decompose\|parallel\|dispatch` | `decomposable` | "并行开发模块" |
| `研究\|调研\|research\|investigate` | `research` | "调研技术方案" |
| `协调\|沟通\|团队\|coordinate\|team\|collaborate` | `coordination_heavy` | "团队协调开发" |
| `重构\|refactor\|restructure` | `refactoring` | "重构认证模块" |
| `事件\|订阅\|event\|subscribe\|async` | `event_driven` | "事件驱动架构" |
| `扩展\|插件\|extend\|plugin\|dynamic` | `extensible` | "插件化扩展" |
| `同步\|共享\|实时\|sync\|shared\|realtime` | `realtime_sync` | "实时同步状态" |
| `多源\|multi.?source\|aggregate` | `multi_source` | "多源数据聚合" |

**兜底策略**：当所有正则均未匹配时，默认添加 `decomposable` 特征，避免空特征导致模式选择失败。

#### 步骤3：评分计算

对5种模式分别计算评分，评分公式：

```
score = Σ(信号匹配 × COMPLEXITY_HIGH) + Σ(特征匹配 × MULTI_AGENT_BONUS) + Agent数量匹配加成
```

**评分权重体系**：

| 权重常量 | 值 | 触发条件 |
|---------|---|---------|
| `COMPLEXITY_HIGH` | +0.2 | 任务描述包含模式的信号关键词 |
| `MULTI_AGENT_BONUS` | +0.3 | 任务特征与模式的taskTraits匹配 |
| `DEEPENING_BONUS` | +0.15 | 可用Agent数量在模式的[minAgents, maxAgents]范围内 |
| `SINGLE_AGENT_PENALTY` | -0.2 | 可用Agent数量低于模式的minAgents |
| `HISTORY_BONUS` | +0.1 | （预留，历史匹配加成） |
| `DEEPENING_HISTORY_BONUS` | +0.15 | （预留，深化历史加成） |

**评分上限**：每种模式的最终评分被截断为 `Math.min(score, 1.0)`，确保置信度在[0, 1]范围内。

#### 步骤4：信号关键词匹配

5种模式的信号关键词和任务特征：

| 模式 | 信号关键词 | 任务特征 | Agent范围 |
|------|----------|---------|----------|
| `generator-verifier` | 审查、验证、校验、review、verify、validate、audit、质量 | quality_critical, needs_independent_verification | 2-3 |
| `orchestrator-subagent` | 拆解、并行、分配、decompose、parallel、dispatch、子任务 | decomposable, parallelizable, research | 3-5 |
| `agent-teams` | 协调、沟通、团队、coordinate、team、collaborate、重构 | coordination_heavy, cross_cutting, refactoring | 3-5 |
| `message-bus` | 事件、订阅、通知、event、subscribe、notify、异步 | event_driven, extensible, dynamic | 2-10 |
| `shared-state` | 同步、共享、实时、sync、shared、realtime、协作 | realtime_sync, multi_source, shared_data | 2-8 |

#### 步骤5：模式确定与推理链生成

```javascript
const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
const bestMode = sorted[0] ? sorted[0][0] : COLLABORATION_MODES.ORCHESTRATOR_SUBAGENT;
```

**默认模式**：当所有模式评分为0时（无信号匹配、无特征匹配、Agent数量不足），选择 `orchestrator-subagent` 作为默认模式。

推理链由 `_buildReasoning()` 生成，格式示例：

```
选择 generator-verifier 模式 (置信度: 65%)
适用场景: 质量优先场景：代码审查、报告撰写、数据校验
匹配特征: quality_critical, needs_independent_verification
Agent数量: 3 (推荐2-3)
```

### 降级机制

`executeWithMode()` 根据选定模式调度执行，但依赖注入的执行器缺失时自动降级：

| 模式 | 所需执行器 | 降级条件 | 降级目标 |
|------|----------|---------|---------|
| `generator-verifier` | SubagentExecutor | `this._subagentExecutor === null` | solo |
| `orchestrator-subagent` | SubagentExecutor | `this._subagentExecutor === null` | solo |
| `agent-teams` | AgentChannel | `this._agentChannel === null` | solo |
| `message-bus` | AgentChannel | `this._agentChannel === null` | solo |
| `shared-state` | AgentChannel | `this._agentChannel === null` | solo |
| `solo` | 无 | 无 | 无降级 |

降级时触发 `mode-degraded` 事件：`{ requestedMode, fallbackMode: 'solo', reason: 'Required executor not attached' }`。

---

## 链路二：配对对话链路

### generator-verifier模式的完整执行路径

PairChat实现双Agent（提议者-审查者）实时协作对话，是 `generator-verifier` 模式的核心执行引擎。在ChatChain的 `module-development` 阶段中，`pair-review-code` 任务也使用PairChat进行代码审查。

```
CollaborationModeRouter.executeWithMode()
  → selectMode() → mode = 'generator-verifier'
  → _executeGeneratorVerifier(task, executeFn, verifyFn)
      → SubagentExecutor.executeWithVerification(task, null, executeFn, verifyFn)
          → PairChat.startSession({ proposer, reviewer, artifact })
          → PairChat.addRound(sessionId, { proposerOutput, reviewerFeedback, corrections, approved })
          → ... 多轮迭代 ...
          → 共识达成 / 最大轮次 / 超时
```

### PairChat会话创建→轮次交互→共识检测→会话结束

#### 会话创建

```javascript
const { sessionId } = pairChat.startSession({
  proposer: 'task-worker',
  reviewer: 'domain-analyst',
  artifact: 'source code of auth module',
  artifactType: 'code',
  options: { maxRounds: 5, consensusThreshold: 0.8 },
});
```

**会话数据结构**：

```javascript
{
  sessionId: 'pair-xxxx',
  proposer: 'task-worker',
  reviewer: 'domain-analyst',
  artifact: 'source code of auth module',
  artifactType: 'code',
  rounds: [],
  status: 'pending',
  createdAt: '2026-06-01T10:00:00.000Z',
  config: { maxRounds: 5, consensusThreshold: 0.8, requireApproval: true, trackCorrections: true },
}
```

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `maxRounds` | 5 | 最大对话轮次 |
| `consensusThreshold` | 0.8 | 共识阈值（审批率达标时视为共识） |
| `requireApproval` | true | 是否要求显式批准 |
| `trackCorrections` | true | 是否追踪修正统计 |
| `maxSessions` | 200 | 最大并发会话数 |

**容量管理**：会话数达到 `maxSessions` 时，优先淘汰状态为 `reached` 或 `failed` 的已完成会话；无已完成会话时淘汰最早的会话。

#### 轮次交互

每轮对话包含提议者输出、审查者反馈和修正列表：

```javascript
pairChat.addRound(sessionId, {
  proposerOutput: { code: 'function auth() { ... }', tests: 5 },
  reviewerFeedback: '错误处理不完整，缺少边界检查',
  corrections: ['添加try-catch', '添加null检查'],
  approved: false,
});
```

**轮次数据结构**：

```javascript
{
  round: 2,
  proposerOutput: { code: 'function auth() { ... }', tests: 5 },
  reviewerFeedback: '错误处理不完整，缺少边界检查',
  corrections: ['添加try-catch', '添加null检查'],
  approved: false,
  timestamp: '2026-06-01T10:01:30.000Z',
}
```

**超时检测**：每轮添加时检查距上次活动的时间间隔，超过 `roundTimeoutMs` 则标记会话为 `failed`。

**定时清理**：每60秒执行 `_cleanupTimedOutSessions()`，扫描所有 `pending` 状态的会话，超时的标记为 `failed` 并触发 `session-timeout` 事件。

#### 共识检测

`_evaluateConsensus(session, latestRound)` 实现三级共识判定：

| 优先级 | 条件 | 置信度 | 说明 |
|-------|------|-------|------|
| 1 | `latestRound.approved === true` | 1.0 | 显式批准，最高优先级 |
| 2 | `requireApproval === false` 且近3轮审批率 ≥ `consensusThreshold` | `approvalRate` | 审批率趋势达标 |
| 3 | `requireApproval === false` 且近2+轮修正数递减且最新轮修正数为0 | 0.85 | 修正趋势递减 |

**共识判定流程**：

```
_evaluateConsensus(session, latestRound)
  │
  ├── approved === true? ──→ REACHED (confidence: 1.0)
  │
  ├── requireApproval === true? ──→ PENDING (confidence: 0)
  │
  ├── 近3轮审批率 ≥ consensusThreshold? ──→ REACHED (confidence: approvalRate)
  │
  ├── 近2+轮修正数递减 且 最新轮修正数=0? ──→ REACHED (confidence: 0.85)
  │
  └── 否 ──→ PENDING (confidence: 0)
```

**下一动作判定**：`_getNextAction(session, latestRound)` 返回后续操作指引：

| 条件 | nextAction |
|------|-----------|
| 会话已结束 | `complete` |
| 最新轮已批准 | `complete` |
| 最新轮有修正项 | `proposer-revise` |
| 其他 | `reviewer-review` |

#### 会话结束

会话以三种方式结束：

| 结束方式 | 状态 | 触发条件 | 事件 |
|---------|------|---------|------|
| 共识达成 | `reached` | `_evaluateConsensus` 返回 `REACHED` | `consensus-reached` |
| 最大轮次 | `failed` | `roundNumber >= maxRounds` | `consensus-failed` |
| 超时 | `failed` | 轮次间隔超时 | `session-timeout` |

**事件列表**：

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `session-started` | 会话创建 | `{ sessionId, proposer, reviewer }` |
| `round-completed` | 轮次完成 | `{ sessionId, round, approved, corrections }` |
| `consensus-reached` | 共识达成 | `{ sessionId, round, corrections }` |
| `session-timeout` | 会话超时 | `{ sessionId }` |
| `consensus-failed` | 最大轮次未达成 | `{ sessionId, rounds, reason }` |

---

## 链路三：链式编排链路

### ChatChain六阶段任务链

ChatChain是六阶段执行流程的原子任务编排引擎，内置6套预定义链模板，每套模板定义了该阶段需要执行的原子任务序列、Agent分配、Skill绑定和依赖关系。

```
brainstorming → requirement-analysis → architecture-design → module-development → integration-testing → deployment
```

### 依赖解析→任务调度→上下文传递→结果聚合

#### 六阶段原子任务链模板

**brainstorming（需求探索）**：

| 任务ID | Agent | Skill | 说明 | 必需 |
|--------|-------|-------|------|------|
| explore-requirements | team-lead | brainstorming | 探索需求边界和约束 | ✓ |
| validate-feasibility | domain-analyst | brainstorming | 验证技术可行性 | ✓ |

**requirement-analysis（需求分析）**：

| 任务ID | Agent | Skill | 说明 | 必需 |
|--------|-------|-------|------|------|
| gather-requirements | team-lead | requirement-analysis | 收集和整理需求 | ✓ |
| analyze-constraints | domain-analyst | requirement-analysis | 分析技术约束和依赖 | ✓ |
| define-acceptance | quality-assurance | requirement-analysis | 定义验收标准 | ✗ |

**architecture-design（架构设计）**：

| 任务ID | Agent | Skill | 说明 | 必需 | 依赖 |
|--------|-------|-------|------|------|------|
| design-architecture | domain-analyst | architecture-design | 设计系统架构 | ✓ | - |
| review-architecture | domain-analyst | code-review | 审查架构设计 | ✓ | - |
| define-interfaces | domain-analyst | architecture-design | 定义模块接口 | ✓ | - |

**module-development（模块开发）**：

| 任务ID | Agent | Skill | 说明 | 必需 | TDD阶段 | 依赖 |
|--------|-------|-------|------|------|---------|------|
| write-test-first | task-worker | tdd-implement | 编写测试用例 (RED) | ✓ | RED | - |
| implement-feature | task-worker | tdd-implement | 实现功能代码 (GREEN) | ✓ | GREEN | write-test-first |
| pair-review-code | domain-analyst | code-review | 两两对话审查代码 | ✓ | - | implement-feature |
| refactor-if-needed | task-worker | refactor-code | 根据审查反馈重构 (REFACTOR) | ✗ | REFACTOR | pair-review-code |
| security-check | quality-assurance | security-audit | 安全审计 | ✓ | - | implement-feature |
| self-reflect | task-worker | verification-before-completion | 自反思验证 | ✓ | - | security-check |

**integration-testing（集成测试）**：

| 任务ID | Agent | Skill | 说明 | 必需 | 依赖 |
|--------|-------|-------|------|------|------|
| write-integration-tests | quality-assurance | integration-testing | 编写集成测试 | ✓ | - |
| pair-debug-failures | [qa, task-worker] | systematic-debugging | 两两对话协同调试 | ✗ | - |
| regression-check | quality-assurance | verification-before-completion | 回归验证 | ✓ | write-integration-tests |

**deployment（部署上线）**：

| 任务ID | Agent | Skill | 说明 | 必需 | 依赖 |
|--------|-------|-------|------|------|------|
| generate-docs | technical-writer | documentation | 生成项目文档 | ✓ | - |
| auto-doc-gen | technical-writer | auto-doc-generation | 自动生成用户手册和依赖说明 | ✓ | generate-docs |
| deploy | devops-engineer | deployment | 部署上线 | ✓ | generate-docs |
| health-check | devops-engineer | verification-before-completion | 部署后健康检查 | ✓ | deploy |

#### 依赖解析

`_updateBlockedTasks(chain)` 在每次任务状态变更后执行，根据 `dependsOn` 依赖图更新任务阻塞状态：

```
_updateBlockedTasks(chain)
  │
  ├── 遍历所有 PENDING 任务
  │   ├── 依赖未满足 → 标记为 BLOCKED
  │   └── 依赖已满足 → 保持 PENDING
  │
  └── 遍历所有 BLOCKED 任务
      ├── 依赖已满足 → 恢复为 PENDING
      └── 依赖未满足 → 保持 BLOCKED
```

**依赖满足条件**：`dependsOn` 中所有任务的状态为 `COMPLETED` 或 `SKIPPED`。

**下一可执行任务**：`_getNextTasks(chain)` 返回所有 `PENDING` 且依赖已满足的任务列表，供调度器分配执行。

#### 任务状态机

```
PENDING ──startTask()──→ IN_PROGRESS ──completeTask()──→ COMPLETED
   │                        │
   │                        ├──failTask()──→ FAILED (必需任务)
   │                        │                   │
   │                        │                   └──retryTask()──→ PENDING (重试次数<3)
   │                        │
   │                        └──failTask()──→ PENDING (非必需任务, 重试次数≤3)
   │
   ├──_updateBlockedTasks()──→ BLOCKED ──_updateBlockedTasks()──→ PENDING (依赖满足)
   │
   └──skipTask()──→ SKIPPED (仅非必需任务)
```

| 状态 | 常量 | 说明 |
|------|------|------|
| `pending` | `TASK_STATUS.PENDING` | 待执行 |
| `in_progress` | `TASK_STATUS.IN_PROGRESS` | 执行中 |
| `completed` | `TASK_STATUS.COMPLETED` | 已完成 |
| `failed` | `TASK_STATUS.FAILED` | 已失败 |
| `skipped` | `TASK_STATUS.SKIPPED` | 已跳过（非必需任务） |
| `blocked` | `TASK_STATUS.BLOCKED` | 被依赖阻塞 |

#### TDD阶段标记

`module-development` 阶段的任务通过 `tddPhase` 字段标记TDD阶段：

| tddPhase | 任务 | 说明 |
|----------|------|------|
| `RED` | write-test-first | 先写失败的测试 |
| `GREEN` | implement-feature | 实现最小可行代码使测试通过 |
| `REFACTOR` | refactor-if-needed | 在测试保护下重构优化 |

TDD阶段通过 `dependsOn` 形成严格的执行顺序：RED → GREEN → REFACTOR，确保测试先行。

#### 条件分支

部分任务通过 `condition` 字段标记执行条件：

| 任务 | condition | 含义 |
|------|-----------|------|
| refactor-if-needed | `review-feedback` | 仅当审查有反馈时执行 |
| pair-debug-failures | `test-failures` | 仅当测试有失败时执行 |

条件任务为非必需（`required: false`），条件不满足时可通过 `skipTask()` 跳过。

#### 链完成判定

当链中所有 `required: true` 的任务状态为 `COMPLETED` 时，整条链标记为 `COMPLETED`。任一必需任务达到 `FAILED` 状态（且重试次数耗尽），整条链标记为 `FAILED`。

#### 容量管理

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `maxChains` | 100 | 最大链数量 |
| `MAX_RETRIES` | 3 | 任务最大重试次数 |
| 淘汰策略 | FIFO | 优先淘汰已完成/已失败的链 |

---

## 链路四：集成编排链路

### EnsembleOrchestrator三种模式

EnsembleOrchestrator实现三种集成学习模式，根据任务特征和Agent数量自动选择最优模式：

```
EnsembleOrchestrator.execute(task, agents, executeFn, options)
  │
  ├── agents.length === 0 → { output: null, confidence: 0, mode: 'none' }
  ├── agents.length === 1 → solo模式
  │
  └── agents.length ≥ 2
      ├── options.mode === 'bagging'   → _executeBagging()
      ├── options.mode === 'boosting'  → _executeBoosting()
      ├── options.mode === 'stacking'  → _executeStacking()
      └── 未指定mode → _selectMode(task, agents) 自动选择
```

### 模式自动选择

`_selectMode(task, agents)` 根据任务类型和Agent数量自动选择：

| 条件 | 选择模式 |
|------|---------|
| `task.type` 为 `stability` / `review` / `consensus` | Bagging |
| `task.type` 为 `precision` / `optimize` / `fix` | Boosting |
| `agents.length ≥ 4` | Stacking |
| 默认 | Bagging |

### Bagging（并行求稳）

Bagging模式通过Bootstrap采样为每个Agent生成差异化输入，并行执行后融合结果：

```
_executeBagging(task, agents, executeFn, options)
  │
  ├── 限制Agent数量 (maxAgents=10)
  │
  ├── 为每个Agent生成Bootstrap采样变体
  │   └── _bootstrapSample(task, agentIndex, totalAgents)
  │       ├── 提取任务非内部属性键（不以_开头）
  │       ├── 计算采样数量 = ceil(keys.length × featureSampleRatio)
  │       ├── _sampleWithReplacement(keys, count, seed)
  │       │   └── LCG伪随机: rng = (rng × 1103515245 + 12345) & 0x7fffffff
  │       └── 返回包含采样特征子集 + Bootstrap元信息的变体
  │
  ├── Promise.allSettled() 并行执行
  │
  ├── 过滤有效结果 (output !== null)
  │
  ├── _fuseBagging(validResults) 融合
  │   ├── 字符串输出 → 多数投票 (confidence = 投票占比)
  │   ├── 数值输出 → 平均值 (confidence = 平均置信度)
  │   ├── 对象输出 → _fuseObjectOutputs() 合并属性
  │   │   ├── 数值字段 → 平均值
  │   │   ├── 字符串字段 → 多数投票
  │   │   └── 其他字段 → 首个非undefined值
  │   │   confidence = max(一致性, 平均置信度)
  │   └── 其他类型 → 首个输出
  │
  └── 记录贡献到 AgentContributionTracker
```

**Bootstrap采样参数**：

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `bootstrapRatio` | 0.7 | 特征采样比例 |
| `featureSampleRatio` | 0.7 | 特征采样比例（同bootstrapRatio） |
| `maxAgents` | 10 | 参与执行的最大Agent数量 |

**LCG伪随机生成器**：使用确定性线性同余生成器（`rng = (rng × 1103515245 + 12345) & 0x7fffffff`），相同种子产生相同采样结果，便于结果复现。

**一致性计算**：`_computeAgreement(outputs)` 评估多个输出间的一致性，用于对象输出的融合置信度：

- 非对象类型：直接比较相等性
- 对象类型：逐键统计值的一致比例，取所有键一致比例的平均值
- 使用 `[...counts.values()].reduce()` 代替 `Math.max(...spread)` 避免栈溢出

### Boosting（串行纠错）

Boosting模式逐轮迭代执行Agent，每轮根据前轮结果调整方面权重，提取残差指导后续Agent关注薄弱环节：

```
_executeBoosting(task, agents, executeFn, _options)
  │
  ├── maxRounds = min(this._maxRounds, agents.length)
  │
  ├── 初始化方面权重 _initAspectWeights(task)
  │   └── 所有非内部属性键 → weight = 1.0
  │
  └── for round = 0 to maxRounds-1:
      │
      ├── 选择Agent: agents[round % agents.length]
      │
      ├── 应用方面权重: _applyAspectWeights(task, aspectWeights)
      │   └── task._aspectWeights = weights
      │
      ├── 提取残差上下文 (round > 0):
      │   └── _extractResidual(previousResult)
      │       ├── 识别薄弱方面 (值为null/undefined/空字符串的属性)
      │       ├── confidence < 0.5 → "Focus on improving overall quality"
      │       └── confidence < 0.3 → "Consider a completely different approach"
      │
      ├── 执行Agent: executeFn(agent, { ...boostedTask, _residualFocus: residual })
      │
      ├── 计算Agent权重: _computeAgentWeight(errorRate)
      │   └── α = 0.5 × ln((1 - ε) / ε)  (AdaBoost公式)
      │
      ├── 更新方面权重: _updateAspectWeights(weights, result, originalTask)
      │   ├── 匹配度 < 0.5 → weight × (1 + learningRate)  (增加关注)
      │   ├── 匹配度 ≥ 0.5 → weight × (1 - learningRate × 0.5)  (减少关注)
      │   └── 权重范围 [0.1, 3.0]
      │
      ├── 早停检查: _shouldEarlyStop(roundResults, { noImprovementCount })
      │   ├── noImprovementCount ≥ earlyStopPatience → 停止
      │   └── lastConfidence ≥ qualityThreshold → 停止
      │
      └── 记录轮次结果
```

**AdaBoost权重公式**：

```
α = 0.5 × ln((1 - ε) / ε)
```

| 错误率(ε) | 权重(α) | 含义 |
|----------|--------|------|
| 0.1 | 1.10 | 高质量Agent，权重显著为正 |
| 0.3 | 0.42 | 中等质量，权重为正 |
| 0.5 | 0.0 | 随机水平，权重为零 |
| 0.7 | -0.42 | 低于随机，权重为负 |
| 0.9 | -1.10 | 极差Agent，权重显著为负 |

**防护措施**：使用 `ε=1e-10` 防止除零错误和对数溢出，非有限数（NaN/Infinity）返回0。

**方面匹配度计算**：`_computeAspectMatch(output, expected)`

| 类型 | 匹配度计算 |
|------|----------|
| 字符串 vs 字符串 | 精确匹配 → 1.0，否则 → 0.0 |
| 数值 vs 数值 | `max(0, 1 - |diff| / max(|expected|, 1))` |
| expected 为 null/undefined | 1.0（默认完全匹配） |
| 其他 | 0.5 |

**Boosting融合**：`_fuseBoosting(roundResults, agentWeights)` 使用指数加权置信度：

```
totalWeight = Σ exp(agentWeight_i)
weightedConfidence = Σ (confidence_i × exp(agentWeight_i) / totalWeight)
finalConfidence = max(weightedConfidence, bestRound.confidence)
```

对象类型输出优先取最佳轮次结果，附加 `_boostingRefinements` 字段记录精化轮次数。

**早停策略**：

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `earlyStopPatience` | 2 | 连续无改善轮数阈值 |
| `qualityThreshold` | 0.95 | 质量收敛阈值 |

### Stacking（元学习）

Stacking模式将前N-1个Agent作为基础层并行执行，最后一个Agent作为元层组合基础输出：

```
_executeStacking(task, agents, executeFn, _options)
  │
  ├── 基础层: agents[0..N-2] 并行执行
  │   └── Promise.allSettled() → baseResults
  │
  ├── 元层: agents[N-1] 执行
  │   └── metaTask = {
  │         ...task,
  │         _baseOutputs: [{ output, confidence }, ...],
  │         _metaInstruction: 'Combine the above base outputs into an optimal final result. Weight higher-confidence outputs more.'
  │       }
  │
  ├── _fuseStacking(baseResults, metaResult)
  │   ├── metaResult.output !== null → 直接采用元Agent结果
  │   └── metaResult.output === null → 退化为Boosting融合
  │
  └── 记录贡献到 AgentContributionTracker
      ├── 基础层Agent → mode: 'stacking_base'
      └── 元Agent → mode: 'stacking_meta'
```

**基础层权重计算**：

```
baseWeight_i = confidence_i / Σ(confidence_j)    // 按置信度归一化
```

当所有基础层置信度之和为0时，均等分配权重 `1/baseResults.length`。

**退化策略**：元Agent输出无效时，退化为Boosting融合，基于基础层结果的置信度加权合并。

### 与AgentDiversityManager和AgentContributionTracker的协作

```
AgentDiversityManager                     EnsembleOrchestrator                  AgentContributionTracker
       │                                         │                                        │
       │ computeDiversity()                      │                                        │
       │ → { score, metrics, diverse }           │                                        │
       │                                         │                                        │
       │ getEnsembleRecommendation(task)         │                                        │
       │ → { mode, agents, reason }  ──────────→ │ execute(task, recommendedAgents, ...)  │
       │                                         │                                        │
       │                                         │ → contributionTracker.record()  ──────→│
       │                                         │                                        │ _updateAgentStats()
       │                                         │                                        │
       │                                         │ ← getTopContributors()  ──────────────│
       │                                         │ ← getFeatureImportance() ────────────│
```

**集成推荐决策树**：

```
getEnsembleRecommendation(task)
  │
  ├── agents.length === 0 → { mode: 'none', reason: 'no_agents_registered' }
  │
  ├── diversity.diverse === false (score < 0.3)
  │   └── { mode: 'boosting', agents: top3_by_weight, reason: 'low_diversity_boosting_recommended' }
  │
  ├── diversity.diverse === true 且 highPerformers(weight≥0.7) ≥ 3
  │   └── { mode: 'bagging', agents: top5_high_performers, reason: 'high_diversity_high_performers_bagging' }
  │
  └── diversity.diverse === true 且 highPerformers < 3
      └── { mode: 'boosting', agents: top3_by_weight, reason: 'mixed_diversity_boosting_safe' }
```

---

## 链路五：输出融合链路

### OutputFusion四种策略

OutputFusion是协作子系统的终点模块，将多个Agent的输出结果合并为单一高质量结果：

```
OutputFusion.fuse(results, strategy, options)
  │
  ├── 空数组/null → { fused: null, confidence: 0 }
  ├── 单结果 → { fused: output, strategy: 'single', confidence }
  │
  └── 多结果 → 按策略执行
      ├── cascade → _cascadeFusion()
      ├── vote → _voteFusion()
      ├── weighted → _weightedFusion()
      └── review → _reviewFusion()
```

### Cascade（级联合并）

按优先级取主Agent输出，补充Agent填充缺失字段：

```
_cascadeFusion(results, options)
  │
  ├── _orderByPriority(results, options)
  │   ├── 有priorityOrder → 按agentId在列表中的位置排序
  │   └── 无priorityOrder → 按confidence降序
  │
  ├── primary = ordered[0]  (主Agent输出)
  │
  ├── 数组输出 → 浅拷贝 [...primary.output]
  │
  ├── 对象输出 → 浅拷贝后遍历supplements
  │   └── for each supplement:
  │       └── for each key in supplement.output:
  │           └── fused[key] === undefined → 填充
  │
  └── confidence = primary.confidence
```

**适用场景**：有明确主从关系的多Agent输出（如主Agent生成代码，辅助Agent补充文档）。

### Vote（加权投票）

按置信度加权统计票数，多数决定：

```
_voteFusion(results, options)
  │
  ├── voteField = options.voteField ?? 'decision'
  │
  ├── for each result:
  │   ├── vote = _extractVote(result, voteField)
  │   │   ├── 对象输出 → result.output[voteField]
  │   │   └── 非对象输出 → String(result.output)
  │   └── votes[vote] += result.confidence  (置信度加权)
  │
  ├── winner = max(votes)
  │
  ├── totalWeight = Σ(votes)
  │
  └── confidence = maxVotes / totalWeight
```

**适用场景**：决策类任务（选择方案、判定结果）。

**无共识处理**：当 `totalWeight === 0` 时，返回 `{ decision: 'no_consensus', voteDistribution: votes }`，置信度为0。

### Weighted（加权融合）

按权重归一化合并数值字段：

```
_weightedFusion(results, options)
  │
  ├── weights = options.weights ?? {}
  │   └── 未指定时使用 result.confidence 作为权重
  │
  ├── totalWeight = Σ(weight_i)
  │
  ├── 按权重降序排列结果
  │
  ├── for each result:
  │   ├── normalizedWeight = weight / totalWeight
  │   ├── 数组输出 → 按索引填充undefined位置
  │   └── 对象输出:
  │       ├── 数值字段 → merged[key] += value × normalizedWeight
  │       └── 非数值字段 → 首次出现优先 (merged[key] === undefined)
  │
  └── confidence = min(totalWeight / results.length, 1.0)
```

**适用场景**：评估类任务（评分、指标聚合）。

**权重来源优先级**：`options.weights[agentId]` > `result.confidence` > `DEFAULT_CONFIDENCE`。

### Review（审查融合）

实现者输出 + 审查者反馈，全部批准时高置信度：

```
_reviewFusion(results, options)
  │
  ├── _orderByPriority(results, options)
  │
  ├── implementer = ordered[0]  (实现者)
  │
  ├── reviewers = ordered.slice(1)  (审查者列表)
  │
  ├── for each reviewer:
  │   └── reviewFeedback.push({
  │         agentId: reviewer.agentId,
  │         feedback: reviewer.output.feedback || reviewer.output.review || '',
  │         approved: reviewer.output.approved !== false
  │       })
  │
  ├── allApproved = reviewFeedback.every(r => r.approved)
  │
  ├── confidence:
  │   ├── allApproved → 0.9
  │   ├── 有审查反馈 → DEFAULT_CONFIDENCE
  │   └── 无审查反馈 → 0.3
  │
  └── fused = { output: implementer.output, reviews: reviewFeedback, approved: allApproved }
```

**适用场景**：代码审查、文档审核。

**置信度策略**：

| 条件 | 置信度 | 说明 |
|------|-------|------|
| 全部审查者批准 | 0.9 | 高置信度，质量有保障 |
| 有审查反馈但未全批准 | DEFAULT_CONFIDENCE | 中等置信度 |
| 无审查反馈 | 0.3 | 低置信度，缺乏验证 |

### 融合历史

OutputFusion使用RingBuffer维护融合历史记录：

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `maxHistory` | 200 | 环形缓冲区最大容量 |

每条历史记录包含：`{ strategy, agentCount, confidence, timestamp }`。

融合完成时触发 `fusion-complete` 事件。

---

## 跨链路协作场景

### 场景一：代码审查全链路

```
用户: "审查认证模块的代码质量"
  │
  ▼
CollaborationModeRouter.selectMode({
  taskDescription: '审查认证模块的代码质量',
  availableAgents: 3
})
  │ 信号匹配: '审查' → generator-verifier (+0.2)
  │ 特征推断: quality_critical
  │ 特征匹配: quality_critical → generator-verifier (+0.3)
  │ Agent数量: 3 在 [2,3] 范围内 → (+0.15)
  │ 总分: 0.65 → 选择 generator-verifier
  ▼
CollaborationModeRouter._executeGeneratorVerifier(task, executeFn, verifyFn)
  │
  ▼
SubagentExecutor.executeWithVerification(task, null, executeFn, verifyFn)
  │
  ▼
PairChat.startSession({
  proposer: 'task-worker',       // 生成代码
  reviewer: 'domain-analyst',    // 审查代码
  artifact: 'auth module code'
})
  │
  ▼ Round 1
PairChat.addRound(sessionId, {
  proposerOutput: { code: 'function auth() { ... }' },
  reviewerFeedback: '缺少错误处理',
  corrections: ['添加try-catch'],
  approved: false
})
  │ nextAction: 'proposer-revise'
  ▼ Round 2
PairChat.addRound(sessionId, {
  proposerOutput: { code: 'function auth() { try { ... } catch(e) { ... } }' },
  reviewerFeedback: 'LGTM',
  corrections: [],
  approved: true
})
  │ 共识达成: confidence = 1.0
  ▼
OutputFusion.fuse([
  { agentId: 'task-worker', output: { code: '...' }, confidence: 0.85 },
  { agentId: 'domain-analyst', output: { feedback: 'LGTM', approved: true }, confidence: 0.9 }
], 'review')
  │ implementer = task-worker, reviewers = [domain-analyst]
  │ allApproved = true → confidence = 0.9
  ▼
最终结果: { output: { code: '...' }, reviews: [...], approved: true, confidence: 0.9 }
```

### 场景二：大规模并行开发全链路

```
用户: "并行开发用户认证、数据管理和API网关三个模块"
  │
  ▼
CollaborationModeRouter.selectMode({
  taskDescription: '并行开发用户认证、数据管理和API网关三个模块',
  availableAgents: 5
})
  │ 信号匹配: '并行' → orchestrator-subagent (+0.2)
  │ 特征推断: decomposable, parallelizable
  │ 特征匹配: decomposable → orchestrator-subagent (+0.3), parallelizable → (+0.3)
  │ Agent数量: 5 在 [3,5] 范围内 → (+0.15)
  │ 总分: min(0.95, 1.0) = 0.95 → 选择 orchestrator-subagent
  ▼
CollaborationModeRouter._executeOrchestratorSubagent(task, executeFn, verifyFn)
  │
  ▼
ChatChain.createChain('module-development')
  │ 创建6个原子任务的链
  │ write-test-first → implement-feature → pair-review-code → ...
  │
  ▼ 依赖解析
ChatChain._updateBlockedTasks(chain)
  │ implement-feature BLOCKED (dependsOn: write-test-first)
  │ pair-review-code BLOCKED (dependsOn: implement-feature)
  │
  ▼ 执行
SubagentExecutor.executeParallel(subtasks, agentConfigs, executeFn)
  │ 三个模块并行执行
  │
  ▼ 每个模块内部
PairChat.startSession({ proposer: 'task-worker', reviewer: 'domain-analyst' })
  │ 代码审查配对对话
  │
  ▼ 结果聚合
OutputFusion.fuse(results, 'cascade', { priorityOrder: ['task-worker', 'domain-analyst', 'quality-assurance'] })
  │ primary = task-worker 输出
  │ supplements 填充缺失字段
  ▼
最终结果: { fused: { code, review, securityReport }, confidence: 0.85 }
```

### 场景三：集成学习全链路

```
用户: "综合评估系统架构方案的可行性"
  │
  ▼
AgentDiversityManager.computeDiversity(['task-worker', 'domain-analyst', 'quality-assurance', 'devops-engineer'])
  │ role_diversity: 4种角色/4个Agent = 1.0
  │ approach_diversity: 1 - avg(Jaccard) = 0.75
  │ error_diversity: 1 - avg(Jaccard) = 0.6
  │ perspective_diversity: 4种视角/4个Agent = 1.0
  │ 综合得分: (1.0 + 0.75 + 0.6 + 1.0) / 4 = 0.8375
  │ diverse: true (≥ 0.3)
  ▼
AgentDiversityManager.getEnsembleRecommendation(task)
  │ diverse = true, highPerformers(weight≥0.7) = 4 ≥ 3
  │ → { mode: 'bagging', agents: [...top5], reason: 'high_diversity_high_performers_bagging' }
  ▼
EnsembleOrchestrator.execute(task, recommendedAgents, executeFn, { mode: 'bagging' })
  │
  ▼ _executeBagging()
  │ Bootstrap采样 → 4个差异化任务变体
  │ Promise.allSettled() → 并行执行
  │ _fuseBagging() → 多数投票/加权平均
  │
  ▼ 贡献记录
AgentContributionTracker.record('task-worker', 'bagging', 0.85, 0.9, 0.25)
AgentContributionTracker.record('domain-analyst', 'bagging', 0.92, 0.9, 0.25)
AgentContributionTracker.record('quality-assurance', 'bagging', 0.78, 0.9, 0.25)
AgentContributionTracker.record('devops-engineer', 'bagging', 0.88, 0.9, 0.25)
  │
  ▼
AgentContributionTracker.getFeatureImportance()
  │ task-worker: { averageWeight: 0.25, averageConfidence: 0.85, participationCount: 1 }
  │ domain-analyst: { averageWeight: 0.25, averageConfidence: 0.92, participationCount: 1 }
  │ ...
  │
  ▼
AgentContributionTracker.getTopContributors(3)
  │ [domain-analyst, devops-engineer, task-worker]  (按averageWeight降序)
  ▼
最终结果: { output: merged, confidence: 0.9, mode: 'bagging', rounds: 1 }
```

---

## 关键数据流

### 模式选择数据流

```
context = { taskDescription, taskTraits, availableAgents, sessionId }
  │
  ├── _extractDescription() → 拼接+小写化描述文本
  ├── _inferTraits() → 正则匹配推断特征标签
  │
  ├── for each MODE_SELECTION_RULES:
  │   ├── 信号匹配: description.includes(signal) → +0.2
  │   ├── 特征匹配: traitSet.has(trait) → +0.3
  │   └── Agent数量: [min, max] → +0.15, < min → -0.2
  │   └── score = min(Σ, 1.0)
  │
  ├── 排序取最高分模式
  ├── _buildReasoning() → 生成推理链
  └── _history.push() → 记录选择历史
```

### 配对对话数据流

```
startSession({ proposer, reviewer, artifact })
  │ → session = { sessionId, rounds: [], status: 'pending' }
  │ → emit 'session-started'
  │
addRound(sessionId, { proposerOutput, reviewerFeedback, corrections, approved })
  │ → round = { round, proposerOutput, reviewerFeedback, corrections, approved, timestamp }
  │ → _evaluateConsensus()
  │   ├── approved → REACHED (1.0)
  │   ├── approvalRate ≥ threshold → REACHED (approvalRate)
  │   ├── corrections递减且=0 → REACHED (0.85)
  │   └── else → PENDING (0)
  │ → emit 'round-completed'
  │ → if REACHED: emit 'consensus-reached'
  │ → if maxRounds: emit 'consensus-failed'
  └→ return { round, consensus, nextAction }
```

### 链式编排数据流

```
createChain(phase, customTasks)
  │ → template = ATOMIC_TASK_CHAINS[phase]
  │ → tasks = template.map(→ { taskId, agent, skill, status: PENDING, dependsOn, ... })
  │ → _updateBlockedTasks(chain) → 依赖阻塞标记
  │ → emit 'chain-created'
  │
startTask(chainId, taskId)
  │ → 检查 PENDING + 非BLOCKED
  │ → task.status = IN_PROGRESS
  │ → emit 'task-started'
  │
completeTask(chainId, taskId, result)
  │ → task.status = COMPLETED
  │ → _updateBlockedTasks(chain) → 解除下游阻塞
  │ → if 所有required任务COMPLETED → chain.status = COMPLETED
  │ → emit 'task-completed' / 'chain-completed'
  │
failTask(chainId, taskId, error)
  │ → task._retryCount++
  │ ├── 非必需 + 重试≤3 → status = PENDING (自动重试)
  │ └── 必需 或 重试>3 → status = FAILED
  │     → if 必需FAILED → chain.status = FAILED
  │ → emit 'task-failed' / 'chain-failed'
```

### 集成编排数据流

```
execute(task, agents, executeFn, options)
  │
  ├── _selectMode(task, agents) → bagging/boosting/stacking
  │
  ├── Bagging:
  │   ├── _bootstrapSample() × N → 差异化任务变体
  │   ├── Promise.allSettled() → 并行结果
  │   ├── _fuseBagging() → 融合
  │   └── contributionTracker.record() × N
  │
  ├── Boosting:
  │   ├── for round in maxRounds:
  │   │   ├── _applyAspectWeights() → 加权任务
  │   │   ├── _extractResidual() → 残差上下文
  │   │   ├── executeFn() → 执行
  │   │   ├── _computeAgentWeight() → AdaBoost权重
  │   │   ├── _updateAspectWeights() → 方面权重调整
  │   │   └── _shouldEarlyStop() → 早停检查
  │   ├── _fuseBoosting() → 指数加权融合
  │   └── contributionTracker.record() × rounds
  │
  └── Stacking:
      ├── 基础层: Promise.allSettled() → baseResults
      ├── 元层: executeFn(metaAgent, metaTask) → metaResult
      ├── _fuseStacking() → 元Agent结果 / 退化Boosting
      └── contributionTracker.record() × (N_base + 1_meta)
```

### 输出融合数据流

```
fuse(results, strategy, options)
  │
  ├── 空输入 → { fused: null, confidence: 0 }
  ├── 单结果 → 直通返回
  │
  ├── cascade:
  │   ├── _orderByPriority() → 按优先级排序
  │   ├── primary + supplements → 主输出+缺失字段填充
  │   └── confidence = primary.confidence
  │
  ├── vote:
  │   ├── _extractVote() × N → 提取投票值
  │   ├── 置信度加权计数 → winner
  │   └── confidence = winnerVotes / totalWeight
  │
  ├── weighted:
  │   ├── 归一化权重 → normalizedWeight
  │   ├── 数值字段 → 加权平均
  │   ├── 非数值字段 → 首次出现优先
  │   └── confidence = min(totalWeight / N, 1.0)
  │
  └── review:
      ├── implementer + reviewers
      ├── allApproved → confidence = 0.9
      └── fused = { output, reviews, approved }
```

---

## 性能特征与优化建议

### 当前性能特征

| 模块 | 时间复杂度 | 空间复杂度 | 瓶颈 |
|------|----------|----------|------|
| CollaborationModeRouter.selectMode() | O(R×S) R=规则数, S=信号数 | O(R) | 信号关键词遍历 |
| PairChat.addRound() | O(1) 均摊 | O(maxSessions × maxRounds) | 会话容量管理 |
| ChatChain.createChain() | O(T) T=任务数 | O(maxChains × T) | 依赖解析 |
| EnsembleOrchestrator.Bagging | O(A) A=Agent数 | O(A) | 并行执行 |
| EnsembleOrchestrator.Boosting | O(R×A) R=轮数 | O(R) | 串行迭代 |
| EnsembleOrchestrator.Stacking | O(A) | O(A) | 元层执行 |
| OutputFusion.fuse() | O(N×K) N=结果数, K=字段数 | O(maxHistory) | 对象字段遍历 |
| AgentDiversityManager.computeDiversity() | O(A²×C) A=Agent数, C=能力数 | O(A) | Jaccard对比较 |
| AgentContributionTracker.record() | O(1) 均摊 | O(maxRecords) | BoundedArray驱逐 |

### 优化建议

**1. CollaborationModeRouter 信号索引**

当前信号匹配采用线性遍历，可构建倒排索引（信号词→模式列表）将匹配复杂度从O(R×S)降至O(S')，其中S'为描述中实际匹配的信号数。

**2. AgentDiversityManager Jaccard缓存**

方法多样性和错误多样性的Jaccard计算为O(A²×C)，当Agent能力集合不变时可缓存计算结果，仅在Agent注册/注销时失效。

**3. ChatChain 依赖图预计算**

当前每次 `_updateBlockedTasks` 都重新遍历所有任务，可维护一个入度计数器，在任务完成时O(1)更新下游任务的阻塞状态。

**4. EnsembleOrchestrator Boosting 早停增强**

当前早停仅基于置信度阈值和耐心轮数，可增加收敛速度检测（连续两轮置信度差值<ε），在收敛变缓时提前终止。

**5. OutputFusion 融合策略自动选择**

当前策略由调用方指定，可根据结果数据类型自动推断最优策略：对象输出→review/cascade，数值输出→weighted，决策输出→vote。

**6. AgentContributionTracker 批量记录**

当前每条记录单独更新 `_agentStats`，在集成编排完成后可批量更新，减少Map查找次数。

---

## 关联文档

- [核心功能-多Agent协作流程](../core/核心功能-多Agent协作流程.md)
- [模块详解-协作子系统](../modules/模块详解-协作子系统.md)
- [模块详解-CollaborationModeRouter模块](../modules/模块详解-CollaborationModeRouter模块.md)
- [模块详解-Agent子系统](../modules/模块详解-Agent子系统.md)
- [核心功能-六阶段执行流程](../core/核心功能-六阶段执行流程.md)
- [深度拆解-任务调度执行链路](深度拆解-任务调度执行链路.md)
- [深度拆解-事件驱动架构与消息流转](深度拆解-事件驱动架构与消息流转.md)
