# 模块详解-QualityScorer质量评分器

> 版本：2.73.4 | 文件：src/runtime/quality/quality-scorer.js

---

## 模块概述

QualityScorer是Harness多Agent框架的质量评分器，负责对Agent输出结果进行多维度质量评估。它从完整性（completeness）、正确性（correctness）、一致性（consistency）、覆盖率（coverage）和清晰度（clarity）五个维度打分，加权汇总后生成总分和等级（excellent/good/acceptable/poor/failing）。评分结果自动记入历史记录，支持统计分析，并可通过SignalPersistence持久化。

该模块是质量子系统的核心组件，与DeepeningOrchestrator、SelfReflection、EvidenceVerifier等模块协作，为迭代深化推理提供质量收敛判定依据。

## 类定义

```javascript
class QualityScorer extends EventEmitter {
  constructor(options)
  attachSignalPersistence(sp)
  score(result, task)
  getHistory(limit)
  getStats()
  shutdown() // via withShutdown mixin
}
```

通过`withShutdown`混入后导出，自动获得`shutdown()`方法和`_onShutdown()`生命周期钩子。

### 静态属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `QualityScorer.DIMENSIONS` | Object | 评分维度枚举：completeness/correctness/consistency/coverage/clarity |
| `QualityScorer.DIMENSION_WEIGHTS` | Object | 默认权重：completeness=0.25, correctness=0.30, consistency=0.15, coverage=0.15, clarity=0.15 |

## 构造函数

### `new QualityScorer(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options.weights` | Object | 否 | DIMENSION_WEIGHTS | 各维度权重覆盖 |
| `options.thresholds` | Object | 否 | {excellent:0.9, good:0.75, acceptable:0.6, poor:0.4} | 等级阈值配置 |
| `options.maxHistory` | number | 否 | 300 | 历史评分记录最大条数 |
| `options.signalPersistence` | Object | 否 | null | SignalPersistence实例 |

## 核心方法

### `score(result, task)`

对Agent输出结果进行五维度质量评分，返回评分对象。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `result` | Object\|string | 是 | 待评分的输出结果 |
| `task` | Object | 否 | 关联的任务对象，含id、requirements、expectedOutput、scope等 |

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `total` | number | 加权总分（0-1，保留3位小数） |
| `dimensions` | Object | 各维度得分：{completeness, correctness, consistency, coverage, clarity} |
| `grade` | string | 等级：excellent/good/acceptable/poor/failing |
| `taskId` | string | 关联任务ID |
| `timestamp` | string | 评分时间（ISO格式） |

**事件触发**：`scored` — 评分完成时触发，数据为评分对象。

### `attachSignalPersistence(sp)`

附加SignalPersistence实例，评分结果将自动持久化。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sp` | Object | 是 | SignalPersistence实例 |

**返回值**：`this`（支持链式调用）

### `getHistory(limit)`

获取历史评分记录。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `limit` | number | 否 | 全部 | 返回最近N条记录 |

**返回值**：`Array<Score>`

### `getStats()`

获取评分统计信息。

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalScores` | number | 总评分次数 |
| `averageScore` | number | 平均得分（保留3位小数） |
| `gradeDistribution` | Object | 等级分布，如{good: 5, acceptable: 3} |

## 五维度评分算法

| 维度 | 权重 | 评分逻辑 |
|------|------|---------|
| completeness | 0.25 | 基础分0.3 + 结果键数×0.05（上限0.3）；若task有requirements则按需求满足率加分；字符串结果按长度加分 |
| correctness | 0.30 | 基础分0.4；success=true加0.2，error减0.2，errors数组非空减0.15，valid/passed加0.15；若task有expectedOutput则计算词汇重叠相似度 |
| consistency | 0.15 | 基础分0.5；值类型种类≤2加0.2，有status字符串加0.15，有metadata/context加0.15 |
| coverage | 0.15 | 基础分0.3；优先取result.coverage值；次取tests通过率；否则按键数×0.03加分；task有scope加0.1 |
| clarity | 0.15 | 基础分0.4；字符串：多句加0.2、长度适中加0.2、首字母大写加0.1；对象：有description/summary加0.2、有message加0.15、有描述性键加0.15 |

## 等级阈值体系

| 等级 | 阈值 | 说明 |
|------|------|------|
| excellent | ≥0.9 | 优秀 |
| good | ≥0.75 | 良好 |
| acceptable | ≥0.6 | 可接受 |
| poor | ≥0.4 | 较差 |
| failing | <0.4 | 不合格 |

## 事件

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `scored` | 评分完成 | 评分对象（total, dimensions, grade, taskId, timestamp） |

## 使用示例

```javascript
const QualityScorer = require('./src/runtime/quality/quality-scorer');

const scorer = new QualityScorer({
  weights: { correctness: 0.35, completeness: 0.25 },
  thresholds: { excellent: 0.85, good: 0.7 },
  maxHistory: 200,
});

scorer.on('scored', (score) => {
  console.log(`质量评分: ${score.total} (${score.grade})`);
});

const result = scorer.score(
  { success: true, data: [1, 2, 3], coverage: 0.85, description: '测试通过' },
  { id: 'task-001', requirements: ['success', 'data'], expectedOutput: { success: true } },
);

console.log(result.dimensions);
console.log(scorer.getStats());
```

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/shutdown-mixin`（优雅关闭混入）
- 依赖：`../../utils/ring-buffer`（环形缓冲区，存储历史评分）
- 依赖：`../../utils/safe-execute`（roundTo数值精度工具）
- 被依赖：DeepeningOrchestrator（深化推理，质量收敛判定）
- 被依赖：SelfReflection（自反思，输出质量自评）

## 相关文档

- [[模块详解-DeepeningOrchestrator模块]]
- [[模块详解-TokenManager模块]]
- [核心功能-成本控制机制](../core/核心功能-成本控制机制.md)

---

## SelfReflection详解

**源码**：[self-reflection.js](file:///e:/Harness_V1_0429/src/runtime/quality/self-reflection.js)

### 职责概述

SelfReflection是质量子系统的自反思引擎，负责对Agent输出进行质量自评与改进建议生成。支持五维度反思（边界条件/一致性/安全性/性能/完整性）和证伪维度反思（falsification）。根据质量趋势判定improving/stable/degrading，推荐continue/deepen-analysis/rollback-and-revise动作。内置code/design/test/documentation/decision五种反思模板，decision模板含证伪与反谄媚检查。

### 构造函数

```javascript
new SelfReflection(options)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.maxReflections` | number | 3 | 最大反思轮数 |
| `options.improvementThreshold` | number | 0.05 | 改进判定阈值 |
| `options.qualityWeights` | Object | 见下方 | 各维度权重 |
| `options.maxHistory` | number | 500 | 历史记录最大条数 |
| `options.signalPersistence` | Object | null | SignalPersistence实例 |

### 核心API

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `reflect` | `reflect(context): Object` | Object | 执行自反思，生成问题、趋势判定与建议 |
| `recordImprovement` | `recordImprovement(reflectionId, improvement): boolean` | boolean | 记录改进措施 |
| `attachSignalPersistence` | `attachSignalPersistence(sp): SelfReflection` | this | 附加信号持久化实例 |
| `getHistory` | `getHistory(agentId, limit): Array` | Array | 获取反思历史 |
| `getStats` | `getStats(): Object` | Object | 获取统计信息 |

### 反思模板

| 类型 | 问题数 | 说明 |
|------|--------|------|
| `code` | 5 | 边界条件、架构一致性、安全隐患、性能瓶颈、审查风险 |
| `design` | 5 | 需求覆盖、过度设计、依赖关系、可扩展性、审查风险 |
| `test` | 5 | 关键路径覆盖、用例依赖、误判风险、数据代表性、审查风险 |
| `documentation` | 5 | 实现准确性、示例完整性、术语一致性、已知限制、审查风险 |
| `decision` | 5 | 证伪信号、假设有效性、反谄媚检查、证据强度、替代方案覆盖 |

### 质量趋势判定

| 趋势 | 条件 | 建议动作 |
|------|------|---------|
| `improving` | delta > threshold | `continue` |
| `stable` | -threshold ≤ delta ≤ threshold | `deepen-analysis` |
| `degrading` | delta < -threshold | `rollback-and-revise` |
| `initial` | 无前次质量分数 | `continue` |
| `unknown` | 质量分数非有限数 | `re-evaluate` |

### 事件

| 事件名 | 载荷 | 说明 |
|--------|------|------|
| `reflection-created` | 反思对象 | 反思创建完成 |
| `improvement-recorded` | 改进记录 | 改进措施记录 |

---

## AdversarialReview详解

**源码**：[adversarial-review.js](file:///e:/Harness_V1_0429/src/runtime/quality/adversarial-review.js)

### 职责概述

AdversarialReview是对抗审查器，故意寻找缺陷和漏洞的决策对抗模式。采用魔鬼代言人角色与证伪实验设计。双审查者多轮对抗`review()`在最多N轮内寻求共识，每轮收集双方反馈并合并。`decisionAdversarial()`从CFO/投资人/行业老手等角色视角生成攻击清单与证伪信号。`falsificationCheck()`对结论进行证伪检验。

### 构造函数

```javascript
new AdversarialReview(options)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.maxRounds` | number | 3 | 最大对抗审查轮数 |
| `options.reviewTimeout` | number | 30000 | 单轮审查超时（毫秒） |

### 核心API

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `review` | `review(subject, reviewerA, reviewerB): Promise<Object>` | Object | 双审查者多轮对抗审查 |
| `decisionAdversarial` | `decisionAdversarial(proposal, options): Promise<Object>` | Object | 决策对抗审查 |
| `falsificationCheck` | `falsificationCheck(conclusion, context): Object` | Object | 证伪检验 |

### 对抗角色

| 角色键 | 名称 | 审查焦点 |
|--------|------|---------|
| `cfo` | 冷静的CFO | 成本、ROI、现金流风险 |
| `investor` | 挑剔的投资人 | 市场规模、竞争壁垒、退出路径 |
| `veteran` | 行业老手 | 行业潜规则、隐性成本、监管风险 |
| `engineer` | 悲观工程师 | 技术可行性、复杂度、维护成本 |
| `ux_fanatic` | 用户体验偏执狂 | 用户学习成本、使用障碍、流失风险 |

### 事件

| 事件名 | 载荷 | 说明 |
|--------|------|------|
| `round-complete` | 轮次结果 | 单轮审查完成 |
| `review-complete` | 审查结果 | 全部审查完成 |

---

## DocFreshnessGuard详解

**源码**：[doc-freshness-guard.js](file:///e:/Harness_V1_0429/src/runtime/quality/doc-freshness-guard.js)

### 职责概述

DocFreshnessGuard是文档新鲜度守卫，检测过时文档并提醒更新。异步构建文档索引，提取代码引用，监听源码变更自动标记关联文档为stale。区分普通文档（7天阈值）与规格文档（3天阈值），规格文档采用active活跃策略并支持再验证队列。支持文件系统监听、防抖变更处理、索引持久化与SHA-256完整性校验。

### 构造函数

```javascript
new DocFreshnessGuard(options)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.projectRoot` | string | null | 项目根目录（必填，否则索引不构建） |

### 核心API

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `buildIndex` | `buildIndex(): Promise<void>` | - | 异步构建文档索引 |
| `getStaleDocs` | `getStaleDocs(): Array` | Array | 获取所有过时文档列表 |
| `markStale` | `markStale(docPath, reason): boolean` | boolean | 手动标记文档为过时 |
| `markFresh` | `markFresh(docPath): boolean` | boolean | 手动标记文档为新鲜 |
| `verifyDoc` | `verifyDoc(docPath): Object` | Object | 验证文档新鲜度 |
| `getStats` | `getStats(): Object` | Object | 获取统计信息 |
| `ready` | `ready: Promise` | Promise | 索引构建完成的Promise |

### 常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `STALE_THRESHOLD_MS` | 7天 | 普通文档过时阈值 |
| `SPEC_STALE_THRESHOLD_MS` | 3天 | 规格文档过时阈值 |
| `MAX_INDEX_ENTRIES` | 500 | 最大索引条目数 |
| `MAX_DOC_FILE_SIZE` | 512KB | 最大文档文件大小 |
| `MAX_PENDING_CHANGES` | 1000 | 最大待处理变更数 |

### 事件

| 事件名 | 载荷 | 说明 |
|--------|------|------|
| `index-built` | `{ count }` | 索引构建完成 |
| `docs-staled` | `{ paths }` | 文档被标记为过时 |
| `docs-staled-by-threshold` | `{ paths }` | 文档因超时被标记过时 |
| `spec-stale` | `{ path }` | 规格文档过时 |
| `doc-verified` | `{ path, fresh }` | 文档验证完成 |
| `spec-reverification-triggered` | `{ path }` | 规格文档再验证触发 |
| `watching-started` | `{ dir }` | 文件监听启动 |

---

## SelfEvolutionGovernor详解

**源码**：[self-evolution-governor.js](file:///e:/Harness_V1_0429/src/runtime/quality/self-evolution-governor.js)

### 职责概述

SelfEvolutionGovernor是自演化治理器，控制自我改进的速率和范围，防止无约束的自修改导致系统退化。周期性心跳收集质量趋势/健康状态/收敛模式/因果总线等观测信号，按议程键聚合成议程项，成熟后生成改进提案（proposal），经人工审批后执行。提案生命周期：pending→approved/rejected→executing→completed/failed，支持TTL过期与证据验证。内置熔断器：连续10次心跳错误自动停止，最大10万次心跳上限。

### 构造函数

```javascript
new SelfEvolutionGovernor(options)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.heartbeatInterval` | number | DEFAULT_METRICS_FLUSH_MS | 心跳间隔（毫秒） |
| `options.observationWindow` | number | 24小时 | 观测窗口时长 |
| `options.causalBus` | Object | null | 因果数据总线实例 |
| `options.tokenManager` | Object | null | Token管理器实例 |
| `options.humanApprovalGate` | Object | null | 人工审批门实例 |

### 核心API

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `start` | `start(): void` | - | 启动心跳循环 |
| `stop` | `stop(): void` | - | 停止心跳循环 |
| `approveProposal` | `approveProposal(proposalId): boolean` | boolean | 批准提案 |
| `rejectProposal` | `rejectProposal(proposalId, reason): boolean` | boolean | 拒绝提案 |
| `executeProposal` | `executeProposal(proposalId): Promise<Object>` | Object | 执行提案 |
| `getProposal` | `getProposal(proposalId): Object\|null` | Object | 获取提案详情 |
| `getPendingProposals` | `getPendingProposals(): Array` | Array | 获取待审批提案 |
| `getAgenda` | `getAgenda(): Array` | Array | 获取议程项 |
| `getStats` | `getStats(): Object` | Object | 获取统计信息 |

### 提案生命周期

```
pending_approval → approved → executing → completed
                 → rejected              → failed
                 → expired
```

### 提案状态

| 状态 | 说明 |
|------|------|
| `pending_approval` | 等待人工审批 |
| `approved` | 已批准，待执行 |
| `rejected` | 已拒绝 |
| `executing` | 执行中 |
| `completed` | 执行完成 |
| `failed` | 执行失败 |
| `expired` | 已过期（TTL超时） |

### 熔断器

| 参数 | 值 | 说明 |
|------|-----|------|
| 连续错误阈值 | 10 | 连续10次心跳错误触发熔断 |
| 最大心跳数 | 100,000 | 心跳上限，防止无限运行 |
| 提案TTL | 7天 | 提案过期时间 |
| 最大待审批提案 | 50 | 防止提案堆积 |

### 事件

| 事件名 | 载荷 | 说明 |
|--------|------|------|
| `governor-started` | - | 治理器启动 |
| `governor-stopped` | - | 治理器停止 |
| `heartbeat-complete` | `{ observations }` | 心跳完成 |
| `proposal-generated` | `{ proposal }` | 提案生成 |
| `proposal-approved` | `{ proposalId }` | 提案批准 |
| `proposal-rejected` | `{ proposalId, reason }` | 提案拒绝 |
| `proposal-executing` | `{ proposalId }` | 提案执行开始 |
| `proposal-completed` | `{ proposalId, result }` | 提案执行完成 |
| `proposal-failed` | `{ proposalId, error }` | 提案执行失败 |
| `proposal-expired` | `{ proposalId }` | 提案过期 |
| `governor-circuit-breaker` | `{ consecutiveErrors }` | 熔断器触发 |

## R33 修复记录

### quality-scorer.js — `!=`宽松相等与项目严格相等规范不一致（2处）

**缺陷**：`result != null`和`req != null`使用宽松相等运算符，与项目编码规范要求的严格相等（`===`）不一致。

**修复**：将`!= null`替换为`!== null && !== undefined`（2处），与项目严格相等规范一致。

**影响范围**：代码风格与项目规范统一，消除ESLint eqeqeq规则告警。

---

## AiCodeTrustScorer详解

**源码**：[ai-code-trust-scorer.js](file:///e:/Harness_V1_0429/src/runtime/quality/ai-code-trust-scorer.js)

### 职责概述

AiCodeTrustScorer是AI代码可信度评估器，针对AI生成代码"似对非对"的核心痛点设计。通过7项风险指标（无测试/未处理边界/隐式依赖/魔术值/缺失错误处理/规格违反/上下文漂移）评估代码可信度，输出0-1评分与high/medium/low/unreliable等级判定。支持按来源（sourceId）追踪可信度趋势，内置指数衰减机制使历史评分随时间向0.5（中性）回归。使用RingBuffer保留最近500条评估历史。

### 构造函数

```javascript
new AiCodeTrustScorer(options)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.thresholds` | Object | {high:0.8, medium:0.6, low:0.4} | 可信度等级阈值 |
| `options.riskIndicators` | Object | RISK_INDICATORS | 风险指标权重覆盖 |
| `options.maxHistory` | number | 500 | 历史评估记录最大条数 |
| `options.decayFactor` | number | 0.95 | 来源评分日衰减因子 |

### 核心API

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `assess` | `assess(codeContext): Object` | Object | 评估代码可信度 |
| `assessWithSource` | `assessWithSource(sourceId, codeContext): Object` | Object | 评估并按来源追踪 |
| `getSourceTrustScore` | `getSourceTrustScore(sourceId): number` | number | 获取来源可信度（未知返回0.5） |
| `getSourceStats` | `getSourceStats(sourceId): Object\|null` | Object | 获取来源统计 |
| `decaySourceScores` | `decaySourceScores(): void` | - | 执行来源评分衰减 |
| `getHistory` | `getHistory(): Array` | Array | 获取评估历史 |
| `getAverageScore` | `getAverageScore(): number` | number | 获取平均可信度 |
| `getRiskDistribution` | `getRiskDistribution(): Object` | Object | 获取风险分布统计 |

### 风险指标体系

| 指标 | 权重 | 标签 | 检测条件 |
|------|------|------|---------|
| NO_TESTS | 0.15 | no-tests | hasTests===false 或 tests为空数组 |
| UNHANDLED_EDGE | 0.20 | unhandled-edge-cases | edgeCasesHandled===false |
| IMPLICIT_DEPS | 0.12 | implicit-dependencies | implicitDependencies===true 或 unlistedDeps非空 |
| MAGIC_VALUES | 0.10 | magic-values | magicValues===true 或 hardcodedValues>3 |
| MISSING_ERROR_HANDLING | 0.18 | missing-error-handling | errorHandlingComplete===false |
| SPEC_VIOLATION | 0.15 | spec-violation | specCompliant===false |
| CONTEXT_DRIFT | 0.10 | context-drift | contextDrift===true 或 driftScore>0.3 |

### 可信度等级

| 等级 | 阈值 | 建议 |
|------|------|------|
| high | ≥0.8 | accept |
| medium | ≥0.6 | review-carefully |
| low | ≥0.4 | reject |
| unreliable | <0.4 | reject-and-revise（若有severity≥0.9的风险） |

### 事件

| 事件名 | 载荷 | 说明 |
|--------|------|------|
| `assessed` | 评估结果对象 | 评估完成 |

### 静态属性

| 属性 | 说明 |
|------|------|
| `AiCodeTrustScorer.TRUST_LEVELS` | 可信度等级枚举 |
| `AiCodeTrustScorer.RISK_INDICATORS` | 风险指标定义 |

---

## ComprehensionDebtTracker详解

**源码**：[comprehension-debt-tracker.js](file:///e:/Harness_V1_0429/src/runtime/quality/comprehension-debt-tracker.js)

### 职责概述

ComprehensionDebtTracker是理解债务追踪器，针对AI代码"理解债务激增"的核心痛点设计。将需求模糊、上下文不匹配、隐式假设、规格缺口、领域知识缺口等理解差距量化为可追踪的债务项，支持4级严重度（critical/high/medium/low）和4种解决状态（open/in-progress/resolved/escalated）的完整生命周期管理。提供债务评分、分布统计、解决率、平均解决时间等度量指标。LRU淘汰机制（最大1000条）优先淘汰已解决的最早债务。

### 构造函数

```javascript
new ComprehensionDebtTracker(options)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.criticalThreshold` | number | 0.7 | 债务评分critical等级阈值 |
| `options.highThreshold` | number | 0.5 | 债务评分high等级阈值 |

### 核心API

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `recordDebt` | `recordDebt(debtInfo): Object\|null` | Object | 记录理解债务 |
| `resolveDebt` | `resolveDebt(debtId, note): Object\|null` | Object | 解决债务 |
| `escalateDebt` | `escalateDebt(debtId, reason): Object\|null` | Object | 升级债务 |
| `getDebt` | `getDebt(debtId): Object\|null` | Object | 获取单条债务 |
| `getOpenDebts` | `getOpenDebts(): Array` | Array | 获取未解决债务 |
| `getDebtsByType` | `getDebtsByType(type): Array` | Array | 按类型获取债务 |
| `getDebtsByTask` | `getDebtsByTask(taskId): Array` | Array | 按任务获取债务 |
| `calculateDebtScore` | `calculateDebtScore(): Object` | Object | 计算债务评分 |
| `getDebtDistribution` | `getDebtDistribution(): Object` | Object | 获取债务类型分布 |
| `getResolutionRate` | `getResolutionRate(): number` | number | 获取解决率 |
| `getAverageResolutionTimeMs` | `getAverageResolutionTimeMs(): number` | number | 获取平均解决时间 |

### 债务类型

| 类型 | 标签 | 说明 |
|------|------|------|
| REQUIREMENT_AMBIGUITY | requirement-ambiguity | 需求模糊 |
| CONTEXT_MISMATCH | context-mismatch | 上下文不匹配 |
| IMPLICIT_ASSUMPTION | implicit-assumption | 隐式假设 |
| SPEC_GAP | spec-gap | 规格缺口 |
| DOMAIN_KNOWLEDGE_GAP | domain-knowledge-gap | 领域知识缺口 |

### 严重度评分

| 严重度 | 评分 | 说明 |
|--------|------|------|
| critical | 1.0 | 关键 |
| high | 0.75 | 高 |
| medium | 0.5 | 中 |
| low | 0.25 | 低 |

### 债务评分算法

债务评分 = min(1, 未解决债务严重度总分 / 未解决债务数)

| 等级 | 阈值 |
|------|------|
| critical | ≥0.7 |
| high | ≥0.5 |
| manageable | <0.5 |
| none | 无未解决债务 |

### 事件

| 事件名 | 载荷 | 说明 |
|--------|------|------|
| `debt-recorded` | 债务对象 | 债务记录 |
| `debt-resolved` | {id, resolutionNote} | 债务解决 |
| `debt-escalated` | {id, reason} | 债务升级 |

### 静态属性

| 属性 | 说明 |
|------|------|
| `ComprehensionDebtTracker.DEBT_TYPES` | 债务类型枚举 |
| `ComprehensionDebtTracker.DEBT_SEVERITY` | 严重度枚举 |
| `ComprehensionDebtTracker.RESOLUTION_STATES` | 解决状态枚举 |

---

## DeliveryEfficiencyMeter详解

**源码**：[delivery-efficiency-meter.js](file:///e:/Harness_V1_0429/src/runtime/quality/delivery-efficiency-meter.js)

### 职责概述

DeliveryEfficiencyMeter是交付效率度量器，针对"AI只快了编码20%，交付瓶颈在剩下80%"的核心洞察设计。度量端到端交付时间在6个阶段（需求/分析/架构/开发/测试/部署）的分布，计算编码占比、AI加速比、审查瓶颈评分和分布偏差等关键指标。支持交付周期追踪、返工计数、审查轮次统计，为"重构工作流"提供数据驱动的决策依据。使用RingBuffer保留最近200个交付周期。

### 构造函数

```javascript
new DeliveryEfficiencyMeter(options)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.expectedDistribution` | Object | DEFAULT_TIME_DISTRIBUTION | 期望时间分布 |
| `options.maxCycles` | number | 200 | 最大周期记录数 |

### 核心API

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `startCycle` | `startCycle(cycleInfo): string` | string | 开始交付周期 |
| `recordPhaseTime` | `recordPhaseTime(phase, durationMs, meta): boolean\|null` | boolean | 记录阶段耗时 |
| `recordReviewCycle` | `recordReviewCycle(meta): boolean\|null` | boolean | 记录审查轮次 |
| `endCycle` | `endCycle(cycleResult): Object\|null` | Object | 结束交付周期 |
| `getTimeDistribution` | `getTimeDistribution(): Object` | Object | 获取实际时间分布 |
| `getDistributionDeviation` | `getDistributionDeviation(): number` | number | 获取分布偏差 |
| `getCodingRatio` | `getCodingRatio(): number` | number | 获取编码占比 |
| `getAiAccelerationRatio` | `getAiAccelerationRatio(): number` | number | 获取AI加速比 |
| `getReviewBottleneckScore` | `getReviewBottleneckScore(): number` | number | 获取审查瓶颈评分 |
| `getEfficiencyMetrics` | `getEfficiencyMetrics(): Object` | Object | 获取效率度量汇总 |
| `getPhaseBreakdown` | `getPhaseBreakdown(): Array` | Array | 获取阶段明细 |

### 交付阶段

| 阶段 | 标签 | 期望占比 |
|------|------|---------|
| requirements | 需求/方案 | 15% |
| analysis | 需求分析 | 15% |
| architecture | 架构设计 | 10% |
| development | 编码开发 | 20% |
| testing | 测试/改Bug | 25% |
| deployment | 部署上线 | 15% |

### 关键指标

| 指标 | 计算方式 | 说明 |
|------|---------|------|
| 编码占比 | development时间 / 总时间 | 衡量编码在交付中的实际占比 |
| AI加速比 | AI辅助时间 / 总时间 | 衡量AI对交付的实际加速效果 |
| 审查瓶颈评分 | reviewRatio×0.5 + reworkRatio×0.5 | 衡量审查和返工造成的瓶颈程度 |
| 分布偏差 | Σ|actual-expected| | 衡量实际分布与期望的偏离程度 |

### 事件

| 事件名 | 载荷 | 说明 |
|--------|------|------|
| `cycle-started` | {id, startedAt} | 周期开始 |
| `cycle-ended` | 周期对象 | 周期结束 |

### 静态属性

| 属性 | 说明 |
|------|------|
| `DeliveryEfficiencyMeter.PHASES` | 阶段枚举 |
| `DeliveryEfficiencyMeter.PHASE_LABELS` | 阶段中文标签 |
| `DeliveryEfficiencyMeter.DEFAULT_TIME_DISTRIBUTION` | 默认期望时间分布 |

---

## R40 融合记录

### 新增模块 — AI交付瓶颈洞察融合（3个模块）

**背景**：AI代码"似对非对"加重审查/调试负担，编码仅占交付20%但AI只加速了这20%。三大痛点：审查成本爆炸、理解债务激增、系统思维缺失。

**融合方案**：新增3个质量子系统模块，直接填补框架能力缺口：

1. **AiCodeTrustScorer** — AI代码可信度评估器
   - 7项风险指标检测，量化"似对非对"代码的可信度
   - 按来源追踪可信度趋势，支持指数衰减
   - 输出accept/review-carefully/reject/reject-and-revise建议

2. **ComprehensionDebtTracker** — 理解债务追踪器
   - 5种债务类型、4级严重度、4种解决状态的完整生命周期
   - 债务评分、分布统计、解决率度量
   - LRU淘汰（最大1000条），优先淘汰已解决债务

3. **DeliveryEfficiencyMeter** — 交付效率度量器
   - 6阶段时间分布追踪，编码占比/AI加速比/审查瓶颈评分
   - 交付周期管理，返工/审查轮次统计
   - 分布偏差度量，为"重构工作流"提供数据依据

**集成点**：
- `src/index.js` — 主入口导出 + MODULE_GROUPS.runtime
- `src/runtime/infrastructure/module-initializer.js` — SIMPLE_MODULES注册 + _extractDeepeningModules
- `src/runtime/deepening/deepening-module-registry.js` — MODULE_DEFS core层注册
- `src/web/dashboard/data-providers/framework-modules.js` — CORE_MODULES + MODULE_DEPENDENCY_ORDER

**测试覆盖**：50个测试用例（AiCodeTrustScorer 18 + ComprehensionDebtTracker 14 + DeliveryEfficiencyMeter 17 + 常量1），全部通过。

**ESLint**：0 errors, 0 warnings。
