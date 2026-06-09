# SelfEvolutionGovernor 自演化治理器

## 模块概述

**源文件**：`src/runtime/quality/self-evolution-governor.js`

SelfEvolutionGovernor 是质量子系统的自演化治理器，控制自我改进的速率和范围，防止无约束的自修改导致系统退化。通过周期性心跳收集质量趋势/健康状态/收敛模式/因果总线等观测信号，按议程键聚合成议程项，成熟后生成改进提案（proposal），经人工审批后执行。

核心原则：**受控的自我改进，而非无约束的自修改**

## 核心概念

### 治理流程

```
心跳触发 → 收集观测信号 → 按议程键聚合 → 议程项成熟 → 生成改进提案 → 人工审批 → 执行 → 证据验证
```

### 提案生命周期

```
pending_approval → approved/rejected → executing → completed/failed
                                              ↘ expired（TTL超时）
```

| 状态 | 说明 |
|------|------|
| `pending_approval` | 待审批 |
| `approved` | 已批准 |
| `rejected` | 已拒绝 |
| `executing` | 执行中 |
| `completed` | 执行完成（证据验证通过） |
| `failed` | 执行失败（证据验证未通过或执行异常） |
| `expired` | 已过期（TTL超时，默认7天） |

### 观测信号类型

| 信号类型 | 来源 | 说明 |
|---------|------|------|
| `quality_trend` | SignalPersistence | 质量趋势（improving/stable/degrading） |
| `convergence_pattern` | SignalPersistence | 收敛模式趋势 |
| `reflection_trend` | SignalPersistence | 反思质量趋势 |
| `health_status` | HealthChecker | 系统健康状态 |
| `causal_bus_status` | CausalDataBus | 因果总线状态 |

### 事件触发类型

| 事件类型 | 说明 |
|---------|------|
| `error-spike` | 错误率突增 |
| `quality-regression` | 质量回归 |
| `health-critical` | 健康状态危急 |
| `convergence-stall` | 收敛停滞 |
| `memory-pressure` | 内存压力 |

### 议程键映射

| 议程键 | 触发条件 | 推荐动作 |
|--------|---------|---------|
| `quality-degrading` | quality_trend + degrading | investigate-quality-regression / trigger-rl-training |
| `health-critical` | health_status + critical | escalate-health-incident |
| `convergence-degrading` | convergence_pattern + degrading | review-convergence-thresholds |
| `causal-invariant-violations` | causal_bus_status + invariantViolations > 0 | audit-invariant-violations |
| `reflection-degrading` | reflection_trend + degrading | deepen-self-reflection |

### 熔断器机制

- 连续10次心跳错误自动停止治理器
- 最大10万次心跳上限
- 心跳执行互斥（防止并发心跳）

## API 参考

### 构造函数

```javascript
new SelfEvolutionGovernor(options)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.heartbeatIntervalMs` | number | 60000 | 心跳间隔（毫秒），范围 [1000, 3600000] |
| `options.observationWindowMs` | number | 86400000 | 观测窗口（毫秒），默认1天 |
| `options.agendaMaturityThreshold` | number | 3 | 议程成熟阈值（观测次数），范围 [1, 100] |
| `options.signalPersistence` | object | null | 信号持久化实例 |
| `options.healthChecker` | object | null | 健康检查器实例 |
| `options.causalDataBus` | object | null | 因果数据总线实例 |
| `options.qualityScorer` | object | null | 质量评分器实例 |
| `options.convergenceDetector` | object | null | 收敛检测器实例 |
| `options.scheduler` | object | null | 调度器实例 |
| `options.auditLogger` | object | null | 审计日志器实例 |
| `options.evidenceVerifier` | object | null | 证据验证器实例 |
| `options.tddGate` | object | null | TDD门禁实例 |
| `options.sqliteStore` | object | null | SQLite存储实例 |

### 依赖注入方法（链式调用）

| 方法 | 参数 | 说明 |
|------|------|------|
| `attachSignalPersistence(sp)` | SignalPersistence实例 | 附加信号持久化 |
| `attachHealthChecker(hc)` | HealthChecker实例 | 附加健康检查器，心跳时采集健康状态 |
| `attachCausalDataBus(cdb)` | CausalDataBus实例 | 附加因果数据总线，心跳时采集因果链状态 |
| `attachQualityScorer(qs)` | QualityScorer实例 | 附加质量评分器，用于质量趋势观测 |
| `attachConvergenceDetector(cd)` | ConvergenceDetector实例 | 附加收敛检测器 |
| `attachScheduler(s)` | Scheduler实例 | 附加调度器 |
| `attachAuditLogger(al)` | AuditLogger实例 | 附加审计日志器，提案审批/执行时自动记录 |
| `attachEvidenceVerifier(ev)` | EvidenceVerifier实例 | 附加证据验证器，提案执行完成后验证证据 |
| `attachTddGate(tg)` | TDDGate实例 | 附加TDD门禁 |
| `attachSqliteStore(ss)` | SqliteStore实例 | 附加SQLite存储，用于摘要持久化与恢复 |
| `attachRLTrainingPipeline(pipeline)` | RLTrainingPipeline实例 | 附加RL训练管道，使提案执行可触发RL训练 |

### start()

启动治理器，开始周期性心跳收集观测信号。重置心跳计数和连续错误计数，触发 `governor-started` 事件。

### stop()

停止治理器，终止心跳调度。触发 `governor-stopped` 事件。

### approveProposal(proposalId, approver, reason)

批准待审批的提案，将状态从 `pending_approval` 转为 `approved`。

**参数**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `proposalId` | string | - | 提案标识 |
| `approver` | string | 'system' | 审批人标识 |
| `reason` | string | '' | 审批理由 |

**返回值**：`{ success, proposalId?, action?, error? }`

**校验逻辑**：检查提案是否存在、是否处于待审批状态、是否超过TTL有效期（7天）

### rejectProposal(proposalId, rejector, reason)

拒绝待审批的提案，将状态从 `pending_approval` 转为 `rejected`。

**参数**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `proposalId` | string | - | 提案标识 |
| `rejector` | string | 'system' | 拒绝人标识 |
| `reason` | string | '' | 拒绝理由 |

**返回值**：`{ success, proposalId?, error? }`

### executeApprovedProposal(proposalId, executeFn)

执行已批准的提案，支持自定义执行函数或默认动作。执行完成后通过 EvidenceVerifier 验证执行证据。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `proposalId` | string | 提案标识 |
| `executeFn` | Function | 自定义执行函数，签名为 `async (proposal) => result`；未提供时使用默认动作 |

**返回值**：`Promise<{ success, proposalId, result?, evidenceVerified?, error? }>`

**默认动作映射**：

| 推荐动作 | 默认执行结果 |
|---------|------------|
| `investigate-quality-regression` | quality-regression-investigated |
| `escalate-health-incident` | health-incident-escalated |
| `review-convergence-thresholds` | convergence-thresholds-reviewed |
| `audit-invariant-violations` | invariant-violations-audited |
| `deepen-self-reflection` | self-reflection-deepened |
| `trigger-rl-training` | 通过RLTrainingPipeline启动训练 |

### triggerEventHeartbeat(eventType, eventData)

通过事件触发即时心跳，绕过定时调度。仅处理预定义的事件类型。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `eventType` | string | 事件类型，须在 EVENT_TRIGGERS 列表中 |
| `eventData` | object | 事件附加数据 |

**返回值**：`{ eventType, maturedItems }` 或 `null`（事件类型无效时）

### forceHeartbeat()

强制立即执行一次心跳，不受定时调度约束。

**返回值**：`Promise<void>`

### expireStaleProposals()

清理超过TTL（7天）的待审批提案，将其标记为 expired 并移入历史。

**返回值**：`number` — 过期的提案数量

### getPendingProposals()

获取所有待审批提案的摘要列表。

**返回值**：`Array<{ proposalId, agendaKey, action, status, evidenceScore, createdAt }>`

### getAgendaItems(status)

获取议程项列表，可按状态过滤。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `status` | string | 过滤状态，如 'accumulating'/'matured'；不传则返回全部 |

**返回值**：`Array<object>` — 议程项数组

### getProposals(limit)

从 SignalPersistence 查询提案历史记录。

**参数**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `limit` | number | 20 | 返回的最大提案数，范围 1-1000 |

**返回值**：`Array<object>` — 提案记录数组

### saveSummary()

将治理器摘要持久化到 SQLite 存储。摘要包含心跳计数、统计信息、活跃议程项、待审批提案和最近提案历史。

**返回值**：`Promise<{ success, error? }>`

### loadSummary()

从 SQLite 存储加载最近一次持久化的治理器摘要。

**返回值**：`Promise<object|null>` — 摘要对象

### getStats()

获取治理器运行统计信息。

**返回值**：

```javascript
{
  running: boolean,
  heartbeatInterval: number,
  heartbeatsExecuted: number,
  signalsCollected: number,
  agendaItemsCreated: number,
  agendaItemsMatured: number,
  proposalsGenerated: number,
  proposalsApproved: number,
  proposalsRejected: number,
  proposalsExecuted: number,
  proposalsCompleted: number,
  proposalsFailed: number,
  proposalsExpired: number,
  heartbeatErrors: number,
  consecutiveErrors: number,
  activeAgendaItems: number,
  pendingProposals: number,
  eventTriggersFired: number,
  summariesPersisted: number,
  lastHeartbeatAt: string|null,
  observationWindowMs: number,
}
```

### isHealthy

检查治理器是否健康运行（属性，非方法）。当未关闭且连续错误数未超过上限时返回 `true`。

## 事件类型

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `governor-started` | 治理器启动 | `{ intervalMs }` |
| `governor-stopped` | 治理器停止 | `{ heartbeatsExecuted, reason? }` |
| `heartbeat-complete` | 心跳完成 | `{ heartbeatNumber, observationsCollected, maturedItems, activeAgendaItems }` |
| `proposal-generated` | 提案生成 | 提案对象 |
| `proposal-approved` | 提案批准 | `{ proposalId, approver, action }` |
| `proposal-rejected` | 提案拒绝 | `{ proposalId, rejector, reason }` |
| `proposal-executing` | 提案执行开始 | `{ proposalId, action }` |
| `proposal-completed` | 提案执行完成 | `{ proposalId, action, evidenceVerified }` |
| `proposal-failed` | 提案执行失败 | `{ proposalId, action, reason?, error? }` |
| `proposal-expired` | 提案过期 | `{ proposalId, reason }` |
| `governor-circuit-breaker` | 熔断器触发 | `{ consecutiveErrors }` |
| `event-heartbeat-fired` | 事件心跳触发 | `{ eventType, observationsRecorded, maturedItems }` |
| `summary-saved` | 摘要保存 | `{ heartbeatCount }` |
| `summary-loaded` | 摘要加载 | `{ heartbeatCount, savedAt }` |
| `rl-training-triggered` | RL训练触发 | `{ proposalId, runId, envName }` |

## 使用示例

### 基本使用

```javascript
const SelfEvolutionGovernor = require('./src/runtime/quality/self-evolution-governor');

const governor = new SelfEvolutionGovernor({
  heartbeatIntervalMs: 30000,     // 30秒心跳
  observationWindowMs: 86400000,  // 1天观测窗口
  agendaMaturityThreshold: 3,     // 3次观测成熟
});

// 依赖注入
governor
  .attachSignalPersistence(signalPersistence)
  .attachHealthChecker(healthChecker)
  .attachCausalDataBus(causalDataBus)
  .attachAuditLogger(auditLogger)
  .attachEvidenceVerifier(evidenceVerifier)
  .attachSqliteStore(sqliteStore);

// 监听事件
governor.on('proposal-generated', (proposal) => {
  console.log(`新提案: ${proposal.proposalId}, 动作: ${proposal.recommendedAction}`);
});

governor.on('governor-circuit-breaker', ({ consecutiveErrors }) => {
  console.error(`熔断器触发！连续错误: ${consecutiveErrors}`);
});

// 启动治理器
governor.start();
```

### 提案审批与执行

```javascript
// 查看待审批提案
const pending = governor.getPendingProposals();
for (const p of pending) {
  console.log(`[${p.status}] ${p.proposalId}: ${p.action} (证据分: ${p.evidenceScore})`);
}

// 批准提案
const approval = governor.approveProposal(pending[0].proposalId, 'team-lead', '质量下降需要调查');
if (approval.success) {
  // 执行提案
  const result = await governor.executeApprovedProposal(
    approval.proposalId,
    async (proposal) => {
      // 自定义执行逻辑
      return await investigateQualityIssue(proposal);
    }
  );
  console.log(`执行结果: ${result.success}, 证据验证: ${result.evidenceVerified}`);
}

// 拒绝提案
governor.rejectProposal(pending[1].proposalId, 'team-lead', '当前不优先处理');
```

### 事件触发即时心跳

```javascript
// 当检测到错误率突增时触发即时心跳
const triggerResult = governor.triggerEventHeartbeat('error-spike', {
  errorRate: 0.15,
  previousRate: 0.02,
  affectedComponents: ['auth-service', 'api-gateway'],
});

if (triggerResult) {
  console.log(`事件触发: ${triggerResult.eventType}, 成熟议程项: ${triggerResult.maturedItems}`);
}
```

### 持久化与恢复

```javascript
// 保存摘要
const saveResult = await governor.saveSummary();
console.log(`摘要保存: ${saveResult.success}`);

// 加载摘要
const summary = await governor.loadSummary();
if (summary) {
  console.log(`上次心跳: ${summary.lastHeartbeatAt}, 心跳数: ${summary.heartbeatCount}`);
}

// 清理过期提案
const expiredCount = governor.expireStaleProposals();
console.log(`清理了 ${expiredCount} 个过期提案`);
```

### RL训练集成

```javascript
const governor = new SelfEvolutionGovernor({ heartbeatIntervalMs: 60000 });
governor.attachRLTrainingPipeline(rlTrainingPipeline);

// 当质量下降议程成熟时，提案推荐动作将自动变为 'trigger-rl-training'
// 执行提案时会通过 RLTrainingPipeline 启动训练
const result = await governor.executeApprovedProposal(proposalId);
// result.result.runId 为训练运行ID
```

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `heartbeatIntervalMs` | number | 60000 | 心跳间隔（毫秒），范围 [1000, 3600000] |
| `observationWindowMs` | number | 86400000 | 观测窗口（毫秒） |
| `agendaMaturityThreshold` | number | 3 | 议程成熟阈值（观测次数），范围 [1, 100] |

**内部常量**：

| 常量 | 值 | 说明 |
|------|-----|------|
| MAX_AGENDA_ITEMS | 200 | 最大议程项数 |
| MAX_OBSERVATIONS_PER_ITEM | 50 | 每议程项最大观测数 |
| MAX_PROPOSAL_HISTORY | 1000 | 最大提案历史数 |
| PROPOSAL_TTL_MS | 604800000 | 提案TTL（7天） |
| MAX_PENDING_PROPOSALS | 50 | 最大待审批提案数 |
| MAX_HEARTBEATS | 100000 | 最大心跳次数 |
| MAX_CONSECUTIVE_ERRORS | 10 | 最大连续错误数 |

**静态属性**：
- `SelfEvolutionGovernor.OBSERVATION_SIGNALS` — 观测信号类型列表
- `SelfEvolutionGovernor.PROPOSAL_STATUS` — 提案状态枚举
- `SelfEvolutionGovernor.EVENT_TRIGGERS` — 事件触发类型列表
