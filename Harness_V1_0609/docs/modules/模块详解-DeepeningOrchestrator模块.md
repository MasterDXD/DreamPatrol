# 模块详解-DeepeningOrchestrator模块

> 版本：2.73.4 | 文件：src/runtime/deepening/deepening-orchestrator.js

---

## 1. 模块定位

DeepeningOrchestrator是深化推理子系统的核心编排器，负责**迭代精化、质量评分和收敛检测**。它协调多个Agent对同一任务进行多轮深化推理，通过注入的质量评分器评估每轮输出质量，通过收敛检测器判断是否已达到稳定状态，从而实现"越做越好"的自适应优化闭环。

在Hermes三阶段管道中，DeepeningOrchestrator位于**执行阶段**的核心位置，接收SkillRouter匹配的任务和CollaborationModeRouter选择的Agent集合，输出经过多轮精化的高质量结果。

### 设计哲学

源码采用**"execute + 依赖注入attach"**的架构模式：核心执行逻辑由`execute()`方法驱动，质量评估和收敛检测等能力通过`attach*()`方法注入外部模块实现，而非内置为直接方法。这种设计使得各能力模块可独立替换和测试，符合依赖注入原则和开闭原则。

---

## 2. 核心能力

| 能力 | 说明 | 实现方式 |
|------|------|---------|
| **迭代精化** | 多轮迭代提升输出质量 | `_runIterations()` |
| **质量评分** | 对每轮输出进行质量评估 | 注入的`qualityScorer` |
| **收敛检测** | 检测输出是否已收敛到稳定状态 | 注入的`convergenceDetector` |
| **缓存命中** | 已有高质量结果时跳过执行 | 注入的`cache` |
| **策略决策** | 自定义迭代停止策略 | 注入的`strategyPlugin` |
| **思维检索** | 检索历史思维过程辅助推理 | 注入的`thoughtRetrieverCycle` |
| **多Agent路由** | 通过路由器筛选有效Agent | `_routeAgents()` |
| **并行/串行执行** | 支持Agent并行或串行执行模式 | `_runIterations()` |
| **指标采集** | 记录质量分数等运行指标 | 注入的`metricsCollector` |
| **报告生成** | 生成执行摘要报告 | 注入的`reportGenerator` |
| **事件记录** | 记录执行开始/完成事件 | 注入的`eventStore` |

---

## 3. 类定义与继承体系

```
EventEmitter
  └── DeepeningBase（抽象基类）
        ├── 依赖注入框架（28个attach方法）
        ├── 健康检查（isHealthy/shutdown）
        ├── 废弃警告工具
        └── DeepeningOrchestrator（本模块）
              ├── 迭代精化引擎
              ├── 多Agent路由
              └── 7个专属attach方法
```

### 构造函数参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.defaultDepthLevel` | string | `'standard'` | 默认深化深度级别 |
| `options.maxIterations` | number | 按深度级别映射 | 最大迭代次数 |
| `options.convergenceThreshold` | number | `0.85` | 收敛阈值 |
| `options.parallelAgentExecution` | boolean | `false` | 是否并行执行Agent |

### 深度级别与迭代次数映射

| 深度级别 | 迭代次数 | 适用场景 |
|---------|---------|---------|
| `quick` | 1 | 快速验证、简单任务 |
| `standard` | 2 | 常规任务（默认） |
| `deep` | 2 | 需要深入分析的任务 |
| `intensive` | 4 | 高质量要求的复杂任务 |

---

## 4. 公开方法详解

### 4.1 核心执行

#### `execute(task, agents, options)`

核心执行方法，接收任务、Agent列表和选项，执行多轮迭代精化。

**参数**：
- `task` — 任务对象，需包含`id`属性
- `agents` — Agent列表（数组）或Agent映射对象
- `options.depthLevel` — 深化深度级别
- `options.multiAgentRouter` — 多Agent路由器实例

**返回值**：
```javascript
{
  success: boolean,          // 执行是否成功
  depthLevel: string,        // 实际使用的深度级别
  agentsUsed: string[],      // 使用的Agent ID列表
  totalAgentCalls: number,   // Agent调用总次数
  qualityHistory: number[],  // 每轮质量分数历史
  bestScore: number,         // 最佳质量分数
  fromCache: boolean,        // 是否来自缓存
  thoughtCycle: Object,      // 思维检索循环结果
  error: string              // 错误信息（失败时）
}
```

**执行流程**：
```
1. guardShutdown() — 检查是否已关闭
2. _checkCache() — 检查缓存命中
3. _routeAgents() — 多Agent路由筛选
4. _runIterations() — 多轮迭代执行
5. _runThoughtCycle() — 思维检索循环
6. _cacheResult() — 缓存结果
7. _recordMetrics() — 记录指标
8. _generateExecutionReport() — 生成报告
9. _trimExecLog() — 裁剪执行日志
```

### 4.2 依赖注入（attach方法）

所有attach方法均返回`this`，支持链式调用。

| 方法 | 签名 | 说明 | 要求 |
|------|------|------|------|
| `attachMetricsCollector` | `attachMetricsCollector(mc)` | 注入指标收集器 | `mc.record`方法必须存在 |
| `attachCache` | `attachCache(c)` | 注入缓存模块 | 需实现`retrieve`和`store`方法 |
| `attachStrategyPlugin` | `attachStrategyPlugin(sp)` | 注入策略插件 | 需实现`decide()`方法 |
| `attachReportGenerator` | `attachReportGenerator(rg)` | 注入报告生成器 | 需实现`generate`方法 |
| `attachConvergenceDetector` | `attachConvergenceDetector(cd)` | 注入收敛检测器 | 需实现`check`方法 |
| `attachQualityScorer` | `attachQualityScorer(qs)` | 注入质量评分器 | — |
| `attachEventStore` | `attachEventStore(es)` | 注入事件存储 | 需实现`record`方法 |

**链式调用示例**：
```javascript
const orchestrator = new DeepeningOrchestrator({ defaultDepthLevel: 'deep' });
orchestrator
  .attachMetricsCollector(metricsCollector)
  .attachCache(cacheModule)
  .attachConvergenceDetector(convergenceDetector)
  .attachQualityScorer(qualityScorer)
  .attachEventStore(eventStore);
```

### 4.3 查询与报告

| 方法 | 签名 | 说明 |
|------|------|------|
| `getExecutionLog` | `getExecutionLog()` | 获取执行日志，最多保留100条 |
| `generateReport` | `generateReport(type, data)` | 生成指定类型的报告，无报告生成器时返回`null` |
| `getStats` | `getStats()` | 获取统计信息 |

### 4.4 生命周期

| 方法 | 说明 |
|------|------|
| `isHealthy()` | 健康检查，返回`!this._shutDown` |
| `_onShutdown()` | 关闭时清理所有挂载模块和执行日志 |

---

## 5. 内部执行流程详解

### 5.1 缓存检查（_checkCache）

```
task → cache.retrieve(task) → 检查qualityScore ≥ convergenceThreshold
  → 命中：返回缓存结果（fromCache: true）
  → 未命中：继续执行
```

缓存命中条件：缓存中存在该任务的结果，且质量分数≥收敛阈值（默认0.85）。

### 5.2 多Agent路由（_routeAgents）

```
agents + multiAgentRouter → router.route(task, agentIds)
  → 路由成功：筛选出路由器选中的Agent子集
  → 路由失败（异常/无结果）：回退到原始Agent列表，触发'route-fallback'事件
```

路由失败时的回退策略确保即使路由器不可用，深化推理仍可继续执行。

### 5.3 迭代执行（_runIterations）

```
for each iteration (1..maxIter):
  if shutDown → break
  if parallel && agents.length > 1:
    Promise.allSettled(agents.map(_executeAgent))
  else:
    for each agent: _executeAgent(task, agent, result)
  if _shouldStopIterating() → break

result.bestScore = max(qualityHistory)
```

**并行模式**：使用`Promise.allSettled`确保单个Agent失败不影响其他Agent，失败的Agent通过`'agent-error'`事件报告。

**串行模式**：按Agent列表顺序依次执行，每个Agent的执行结果累积到`result.qualityHistory`中。

### 5.4 停止条件判断（_shouldStopIterating）

按优先级依次检查三个停止条件：

1. **策略插件决策**：`strategyPlugin.decide()`返回`shouldContinue: false`；**异常时安全停止迭代**（v2.7.148修复：策略插件异常不再导致无限循环）
2. **收敛检测器**：`convergenceDetector.check()`返回`converged: true`；**异常时安全停止迭代**（v2.7.148修复：收敛检测异常不再导致无限循环）
3. **收敛阈值**：最新质量分数≥`convergenceThreshold`

任一条件满足即停止迭代，实现多维度早停机制。策略插件和收敛检测器的异常也会触发停止，确保迭代不会因外部模块故障而无限运行。

### 5.5 思维检索循环（_runThoughtCycle）

```
thoughtRetrieverCycle.execute(agentOutput, context)
  → cycleResult.distilledThoughts
  → cycleResult.storedThoughts
  → result.thoughtCycle = { distilled, stored, cycleComplete, quality }
```

将Agent输出与任务上下文传入ThoughtRetrieverCycle，检索历史思维过程辅助后续推理。此步骤为可选，未注入ThoughtRetrieverCycle时跳过。

---

## 6. 事件体系

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `execution-start` | 深化执行开始 | `{ depthLevel }` |
| `execution-complete` | 深化执行完成 | `{ depthLevel, fromCache? }` |
| `execution-error` | 深化执行出错 | `{ error, task }` |
| `agent-error` | Agent执行出错 | `{ agent, error }` |
| `route-fallback` | 多Agent路由失败回退 | `{ reason }` |

---

## 7. 常量定义

| 常量 | 值 | 说明 |
|------|------|------|
| `MAX_EXEC_LOG` | 100 | 执行日志最大保留条数 |
| `MAX_QUALITY_HISTORY` | 500 | 质量分数历史最大保留条数 |

---

## 8. 错误处理策略

DeepeningOrchestrator采用**分层容错**策略：

| 层级 | 场景 | 处理方式 |
|------|------|---------|
| 执行层 | `execute()`整体异常 | try-catch包裹，返回`_buildErrorResult()`，触发`'execution-error'`事件 |
| Agent层 | 单个Agent执行异常 | try-catch包裹，触发`'agent-error'`事件，不影响其他Agent |
| 路由层 | 多Agent路由异常 | 回退到原始Agent列表，触发`'route-fallback'`事件 |
| 缓存层 | 缓存操作异常 | try-catch包裹，debug日志记录，不影响主流程 |
| 策略层 | 策略插件决策异常 | try-catch包裹，debug日志记录，**安全停止迭代**（v2.7.148修复） |
| 收敛层 | 收敛检测器异常 | try-catch包裹，debug日志记录，**安全停止迭代**（v2.7.148修复） |
| 思维层 | 思维检索循环异常 | try-catch包裹，debug日志记录，不影响主流程 |
| 指标层 | 指标采集异常 | `safeCall`包裹，不影响主流程 |
| 报告层 | 报告生成异常 | `safeCall`包裹，不影响主流程 |
| 事件层 | 事件存储异常 | `safeCall`包裹，不影响主流程 |

---

## 9. 使用示例

### 基本使用

```javascript
const DeepeningOrchestrator = require('./src/runtime/deepening/deepening-orchestrator');

const orchestrator = new DeepeningOrchestrator({
  defaultDepthLevel: 'deep',
  maxIterations: 3,
  convergenceThreshold: 0.9,
  parallelAgentExecution: true,
});

const result = await orchestrator.execute(
  { id: 'task-001', queryText: '分析系统架构瓶颈' },
  [agent1, agent2, agent3],
  { depthLevel: 'intensive' }
);

console.log('最佳分数:', result.bestScore);
console.log('质量历史:', result.qualityHistory);
console.log('Agent调用次数:', result.totalAgentCalls);
```

### 完整依赖注入

```javascript
orchestrator
  .attachMetricsCollector(metricsCollector)
  .attachCache(cacheModule)
  .attachStrategyPlugin({
    decide: (ctx) => ctx.iteration >= 5 ? { shouldContinue: false } : { shouldContinue: true }
  })
  .attachReportGenerator(reportGenerator)
  .attachConvergenceDetector(convergenceDetector)
  .attachQualityScorer(qualityScorer)
  .attachEventStore(eventStore);
```

### 事件监听

```javascript
orchestrator.on('execution-start', ({ depthLevel }) => {
  console.log(`深化推理开始，深度级别: ${depthLevel}`);
});

orchestrator.on('execution-complete', ({ depthLevel, fromCache }) => {
  console.log(`深化推理完成，深度级别: ${depthLevel}，缓存命中: ${!!fromCache}`);
});

orchestrator.on('agent-error', ({ agent, error }) => {
  console.error(`Agent ${agent} 执行出错: ${error}`);
});
```

---

## 相关文档

- [核心功能-多Agent协作流程](../core/核心功能-多Agent协作流程.md)
- [模块详解-DeepeningBase深化基类](模块详解-DeepeningBase深化基类.md)
- [模块详解-DeepeningPipeline模块](模块详解-DeepeningPipeline模块.md)
- [深度拆解-深化推理全链路](../deep-dive/深度拆解-深化推理全链路.md)
