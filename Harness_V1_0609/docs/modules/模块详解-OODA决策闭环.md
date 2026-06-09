# 模块详解-OODA决策闭环

> 版本：2.73.4 | 文件：src/runtime/deepening/ooda-loop.js | 行数：~410行

---

## 模块概述

OodaLoop模块实现了经典的OODA（Observe-Orient-Decide-Act）决策闭环，为Agent提供从感知到行动的完整决策链路。模块通过多源信号采集（任务上下文、Agent状态、环境信号、**行动反馈**）进行态势感知，自动计算威胁等级与机会等级，检测决策偏差，并根据态势选择三种决策模式（反应式/审慎式/创造式）之一执行行动。支持自动循环模式与**反馈闭环**，act()结果自动回流到observe()，形成真正的Boyd闭环。v2.7.122新增循环速度追踪、多层级嵌套、战略对齐度评估等增强能力。

## 融合来源

融合自军事战略家John Boyd的OODA Loop理论，该理论强调在竞争环境中通过更快的观察-判断-决策-行动循环来获取优势。模块将此理论应用于AI Agent的运行时决策，使Agent能够根据环境信号动态调整决策模式，并通过偏差检测机制防止陷入单一决策模式的僵化状态。v2.7.122进一步强化了Boyd闭环的核心——"更快OODA=更智能Agent"，通过循环速度追踪和多层级嵌套实现从战略到战术的全谱决策覆盖。

## 架构图

```
                    ┌─────────────────────────────────────────────┐
                    │            OodaLoop 决策闭环                 │
                    │                                             │
  ┌──────────┐     │   ┌───────────┐                             │
  │ 任务上下文 │────►│   │           │                             │
  └──────────┘     │   │  Observe  │◄──── 反馈信号 ──────────┐   │
  ┌──────────┐     │   │  (观察)   │     (lastActionResult)   │   │
  │ Agent状态 │────►│   │           │                         │   │
  └──────────┘     │   └─────┬─────┘                         │   │
  ┌──────────┐     │         │                               │   │
  │ 环境信号  │────►│         ▼                               │   │
  └──────────┘     │   ┌───────────┐                         │   │
                    │   │           │                         │   │
                    │   │  Orient   │  ← strategicAlignment   │   │
                    │   │  (判断)   │    (目标对齐度评估)      │   │
                    │   │           │                         │   │
                    │   └─────┬─────┘                         │   │
                    │         │                               │   │
                    │         ▼                               │   │
                    │   ┌───────────┐                         │   │
                    │   │           │                         │   │
                    │   │  Decide   │  REACTIVE/DELIBERATE/   │   │
                    │   │  (决策)   │  CREATIVE 模式选择       │   │
                    │   │           │                         │   │
                    │   └─────┬─────┘                         │   │
                    │         │                               │   │
                    │         ▼                               │   │
                    │   ┌───────────┐                         │   │
                    │   │           │    _lastActionResult    │   │
                    │   │    Act    ├─────────────────────────┘   │
                    │   │  (行动)   │         反馈回流              │
                    │   │           │◄────────────────────────┘   │
                    │   └───────────┘                             │
                    │                                             │
                    │   循环速度追踪: getCycleSpeed()              │
                    │   avgMs / minMs / maxMs / lastMs            │
                    └─────────────────────────────────────────────┘

  多层级嵌套：
  ┌──────────────────────────────────────────────────────────┐
  │  strategic (PhaseOrchestrator)  — 阶段级：阶段推进/回退    │
  │    └─ operational (GoalExecutor) — 迭代级：子任务分解/收敛  │
  │         └─ tactical (AgentDebugLoop) — 修复级：测试-修复   │
  └──────────────────────────────────────────────────────────┘
```

## 核心API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `observe(taskContext, agentState, environmentSignals)` | taskContext: Object, agentState: Object, environmentSignals: Array/Object | `{ timestamp, signals, confidence }` | 采集多源信号（含反馈信号），计算综合置信度 |
| `orient(observation)` | observation: Object | `{ threatLevel, opportunityLevel, biasDetected, recommendedFocus, strategicAlignment }` | 分析态势，计算威胁/机会等级，检测偏差，评估战略对齐度 |
| `decide(orientation)` | orientation: Object | `{ mode, action, confidence, reasoning }` | 根据态势选择决策模式并生成行动方案 |
| `act(decision, context)` | decision: Object, context: Object | `{ success, feedback, cycleId, reason }` | 执行决策，记录历史，结果自动回流到observe |
| `execute(context)` | context: `{ taskContext, agentState, environmentSignals }` | `{ cycleId, observation, orientation, decision, actResult, completedAt, level }` | 执行完整OODA循环 |
| `getStats()` | 无 | `{ cycleCount, historySize, config, level, cycleSpeed, goalDescription, lastActionResult, ... }` | 获取运行统计（含循环速度和目标描述） |
| `getCycleSpeed()` | 无 | `{ avgMs, minMs, maxMs, lastMs, cycleCount }` | 获取循环速度统计 |
| `setGoal(description)` | description: string | `OodaLoop`（链式调用） | 设置目标描述，用于orient阶段战略对齐度评估 |
| `reset()` | 无 | `true` | 清空决策历史、循环计数、速度数据和目标描述 |

### 静态属性

| 属性 | 值 | 说明 |
|------|-----|------|
| `DECISION_MODES` | `{ REACTIVE, DELIBERATE, CREATIVE }` | 三种决策模式 |
| `VALID_LEVELS` | `{ STRATEGIC, OPERATIONAL, TACTICAL }` | 三种嵌套层级 |

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxHistorySize` | number | 200 | 决策历史最大条目数 |
| `autoLoop` | boolean | false | 是否在循环完成后自动触发下一轮 |
| `threatThreshold` | number | 0.7 | 威胁等级阈值，超过则切换为反应式模式 |
| `opportunityThreshold` | number | 0.6 | 机会等级阈值，超过则切换为创造式模式 |
| `observationWindow` | number | 5 | 偏差检测的观察窗口大小 |
| `level` | string | `'tactical'` | OODA嵌套层级（strategic/operational/tactical） |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `ooda-observed` | 信号采集完成 | `{ signalCount, confidence, level }` |
| `ooda-oriented` | 态势分析完成 | `{ threatLevel, opportunityLevel, biasDetected, recommendedFocus, strategicAlignment, level }` |
| `ooda-decided` | 决策生成完成 | `{ mode, action, confidence, reasoning, level }` |
| `ooda-acted` | 行动执行完成 | `{ success, feedback, cycleId, level }` |
| `ooda-cycle-completed` | 完整循环结束 | `{ cycleId, observation, orientation, decision, actResult, completedAt, level }` |
| `ooda-auto-loop-triggered` | 自动循环触发 | `{ nextCycle, level }` |
| `ooda-reset` | 重置完成 | 无 |

## 依赖关系

- 继承：`DeepeningBase`（深化推理基类，提供shutdown守卫和统计基类）
- 依赖：`../../utils/debug-logger.js`（调试日志）
- 混入：`withShutdown`（通过DeepeningBase间接获得优雅关闭能力）
- 注册：`DeepeningModuleRegistry`（`ooda-loop` 作为 `core` 层级模块注册）

## 使用示例

```javascript
const OodaLoop = require('./src/runtime/deepening/ooda-loop');

const ooda = new OodaLoop({
  threatThreshold: 0.6,
  autoLoop: false,
  level: 'operational'
});

ooda.setGoal('完成用户认证模块的安全审计');

ooda.on('ooda-cycle-completed', (cycle) => {
  console.log('Cycle:', cycle.cycleId, 'Mode:', cycle.decision.mode, 'Level:', cycle.level);
});

const result = ooda.execute({
  taskContext: { taskId: 'task-1', priority: 'high' },
  agentState: { status: 'idle', capabilities: ['code-review'] },
  environmentSignals: [
    { type: 'alert', data: { threat: true, threatLevel: 0.8 } },
  ],
});

console.log('Decision:', result.decision.mode);
console.log('Action:', result.decision.action);
console.log('Strategic Alignment:', result.orientation.strategicAlignment);

const speed = ooda.getCycleSpeed();
console.log('Cycle speed:', speed.avgMs, 'ms avg,', speed.lastMs, 'ms last');
```

## 与现有模块的代码级集成

### DeepeningOrchestrator集成

DeepeningOrchestrator通过`attachOodaLoop()`方法注入OodaLoop实例，在迭代推理循环中使用`_shouldOodaBreak()`方法判断是否提前终止迭代：

```javascript
// deepening-orchestrator.js:477-481
attachOodaLoop(oodaLoop) {
  if (oodaLoop && typeof oodaLoop.execute === 'function') {
    this._ol = oodaLoop;
    this._attached.oodaLoop = true;
  }
  return this;
}

// deepening-orchestrator.js — _shouldOodaBreak()
// 当OODA判断为反应式模式且威胁等级>0.8时，提前终止迭代
_shouldOodaBreak(task, depthLevel, iteration, maxIter, result, agentList) {
  if (!this._ol) return false;
  const oodaResult = this._ol.execute({ ... });
  if (oodaResult.decision.mode === 'reactive' && oodaResult.orientation.threatLevel > 0.8) {
    return true; // 高威胁提前终止
  }
  return false;
}
```

### GoalExecutor集成

GoalExecutor在每次目标迭代中执行OODA循环，orientation结果指导策略调整：

```javascript
// goal-executor.js:468-481
if (this._oodaLoop) {
  const oodaResult = this._oodaLoop.execute({
    taskContext: { goalId: goal.goalId, objective: goal.objective, iteration: goal.currentIteration },
    agentState: { status: goal.status, qualityScore: goal.bestScore ?? 0 },
    environmentSignals: [{ type: 'goal-progress', data: { progress: goal.progress ?? 0 } }],
  });
  if (oodaResult && oodaResult.orientation) {
    this._lastOodaOrientation = oodaResult.orientation; // 指导后续策略调整
  }
}
```

### ModuleInitializer自动装配

ModuleInitializer在初始化阶段自动将OodaLoop实例装配到DeepeningOrchestrator：

```javascript
// module-initializer.js:224
.attachOodaLoop(deepeningModules.oodaLoop)

// module-initializer.js:623 — 懒加载注册
'ooda-loop' 列入懒加载模块清单
```

### InstanceBuilder暴露

InstanceBuilder将oodaLoop暴露到运行时上下文，通过`runtime.oodaLoop`可访问：

```javascript
// instance-builder.js:140
oodaLoop: ctx.oodaLoop,
```

### DeepeningModuleRegistry注册

OodaLoop作为core层级模块注册到深化模块注册表：

```javascript
// deepening-module-registry.js:31
'ooda-loop': { tier: 'core', path: './ooda-loop' },
```

### Dashboard API

server.js提供三个OODA相关API端点，均通过`this._rt('oodaLoop')`获取运行时实例：

```javascript
// server.js:1025-1027
'/api/ooda/status': (_sp) => self._getOodaStatus(),   // 循环状态
'/api/ooda/speed': (_sp) => self._getOodaSpeed(),     // 速度指标
'/api/ooda/history': (_sp) => self._getOodaHistory(), // 决策历史
```

| 端点 | 返回字段 | 说明 |
|------|---------|------|
| `GET /api/ooda/status` | `available, cycleCount, level, healthy, shutDown, goalDescription, historySize` | OODA循环运行状态 |
| `GET /api/ooda/speed` | `available, avgMs, minMs, maxMs, lastMs, cycleCount` | 循环速度指标 |
| `GET /api/ooda/history` | `available, historySize, config` | 决策历史摘要 |

### Skill定义

`.harness/skills/ooda-loop.md`定义了OODA决策闭环技能，支持自动路由触发：

- **skill_id**: `ooda-loop`
- **auto_trigger**: `true`
- **phase**: `module-development`
- **适用Agent**: task-worker, domain-analyst, team-lead, quality-assurance
- **触发条件**: 任务执行需要态势感知、自适应决策或持续闭环迭代时
- **依赖**: tdd-implement
- **阻塞**: verification-before-completion

### 其他集成点

- **AgentRuntime**：Agent运行时在任务执行前调用`execute()`进行态势感知和决策
- **ContextCompressionEngine**：OODA的`observe`阶段可接收上下文压缩信号作为环境输入
- **PhaseOrchestrator**：阶段编排器在阶段转换时通过OODA判断是否需要回退或跳过
- **DeepeningBase**：通过`attachOodaLoop`声明为可注入依赖（`{ method: 'attachOodaLoop', prop: '_oodaLoop' }`）

---

## v2.7.122 融合增强

### 反馈闭环：act()→observe() Boyd闭环

v2.7.122实现了真正的Boyd闭环——act()的结果自动回流到observe()阶段。`observe()`方法在采集信号时检查`this._lastActionResult`，若存在则将其作为`source: 'feedback'`的信号注入（权重0.2），使下一轮观察能够感知上一轮行动的效果。`act()`方法在执行完成后将结果存储到`this._lastActionResult`，完成闭环。

```javascript
// observe() 中的反馈信号注入（ooda-loop.js:94-96）
if (this._lastActionResult) {
  signals.push({ source: 'feedback', type: 'action-result', data: this._lastActionResult, weight: 0.2 });
}

// act() 中的结果存储（ooda-loop.js:277）
this._lastActionResult = result;
```

### 循环速度追踪：getCycleSpeed()

新增`getCycleSpeed()`方法，基于最近50次循环的耗时数据计算速度统计。体现Boyd理论的核心洞察——"更快OODA=更智能Agent"。每次`execute()`调用记录循环耗时到`this._cycleTimings`数组（超过50条时淘汰最早记录）。

返回值：`{ avgMs, minMs, maxMs, lastMs, cycleCount }`

- `avgMs`：平均循环耗时（毫秒）
- `minMs`：最快循环耗时
- `maxMs`：最慢循环耗时
- `lastMs`：最近一次循环耗时
- `cycleCount`：已记录的循环次数

### 多层级嵌套：strategic/operational/tactical

新增`VALID_LEVELS`静态属性和`level`配置项，支持三级OODA嵌套，对应框架中不同粒度的决策组件：

| 层级 | 枚举值 | 对应组件 | 循环粒度 | 决策范围 |
|------|--------|---------|---------|---------|
| strategic | `OodaLoop.VALID_LEVELS.STRATEGIC` | PhaseOrchestrator | 阶段级 | 阶段推进/回退 |
| operational | `OodaLoop.VALID_LEVELS.OPERATIONAL` | GoalExecutor | 迭代级 | 子任务分解/收敛 |
| tactical | `OodaLoop.VALID_LEVELS.TACTICAL` | AgentDebugLoop | 修复级 | 测试-分析-修复 |

构造时通过`options.level`指定层级，默认为`tactical`。所有事件均携带`level`字段标识来源层级。

### 判断增强：orient()新增strategicAlignment + setGoal()

orient()阶段新增`strategicAlignment`字段，评估当前态势与目标描述的对齐程度。通过`setGoal(description)`方法设置目标描述后，orient()会提取目标关键词，在信号数据中搜索匹配，返回`'aligned'`（对齐）、`'misaligned'`（偏离）或`'unknown'`（未设置目标）。

```javascript
ooda.setGoal('完成用户认证模块的安全审计');
const result = ooda.execute({ ... });
// result.orientation.strategicAlignment === 'aligned' | 'misaligned' | 'unknown'
```

### DeepeningOrchestrator集成：_shouldOodaBreak()

DeepeningOrchestrator通过`attachOodaLoop()`注入OodaLoop实例，在`_runIterations()`迭代循环中调用`_shouldOodaBreak()`方法。当OODA判断为反应式模式（`decision.mode === 'reactive'`）且威胁等级超过0.8时，提前终止迭代，避免在高威胁环境下浪费计算资源。

### GoalExecutor集成：每次迭代执行OODA循环

GoalExecutor通过`attachOodaLoop()`注入OodaLoop实例（声明于`DeepeningBase`的可注入依赖列表），在`_executeGoal()`的每次迭代中执行完整OODA循环。orientation结果存储到`this._lastOodaOrientation`，用于指导后续策略调整。

### PhaseOrchestrator集成：阶段转换OODA检查（v2.7.163新增）

PhaseOrchestrator通过`attachOodaLoop()`注入OodaLoop实例，在`setCurrentPhase()`阶段转换前执行OODA循环进行态势感知。当OODA判断威胁等级超过0.8时，阻止阶段推进并发射`phase-ooda-blocked`事件：

```javascript
// phase-orchestrator.js:88 — 注入OODA
attachOodaLoop(oodaLoop) {
  if (oodaLoop && typeof oodaLoop.execute === 'function') {
    this._oodaLoop = oodaLoop;
    oodaLoop._level = 'strategic'; // 自动设为战略层级
  }
  return this;
}

// phase-orchestrator.js:152 — 阶段转换前检查
if (!this._checkOodaTransition(phase, reason)) return false;
```

**事件**：`phase-ooda-blocked` — 当OODA阻止阶段推进时触发，包含`{from, to, threatLevel, decision}`信息。

### autoLoop智能触发增强（v2.7.163新增）

autoLoop模式新增`_evaluateAutoLoopTrigger()`智能触发条件评估，不再仅发射事件，而是提供具体的触发原因：

| 触发原因 | 条件 | 含义 |
|----------|------|------|
| `high-threat` | threatLevel > threatThreshold | 高威胁环境，需持续监控 |
| `high-opportunity` | opportunityLevel > opportunityThreshold | 高机会环境，需快速行动 |
| `stagnation-detected` | 连续3次以上reactive决策 | 决策停滞，可能陷入僵化 |
| `action-failed` | 上一轮行动success=false | 行动失败，需重新评估 |
| `periodic` | 默认 | 周期性循环 |

### DeepeningModuleRegistry注册

`ooda-loop`作为`core`层级模块注册到`DeepeningModuleRegistry`，可通过模块注册表统一发现和加载：

```javascript
// deepening-module-registry.js:31
'ooda-loop': { tier: 'core', path: './ooda-loop' },
```

### Dashboard API：三个OODA端点

server.js新增三个OODA相关API端点，均通过`this._rt('oodaLoop')`获取运行时实例，包含防御性编码（null检查、typeof检查、try-catch）：

| 端点 | 方法 | 功能 | 防御性编码 |
|------|------|------|-----------|
| `/api/ooda/status` | `_getOodaStatus()` | 循环状态查询 | null检查 + typeof检查 + try-catch |
| `/api/ooda/speed` | `_getOodaSpeed()` | 速度指标查询 | null检查 + typeof检查 + try-catch |
| `/api/ooda/history` | `_getOodaHistory()` | 决策历史摘要 | null检查 + typeof检查 + try-catch |

### Skill定义：.harness/skills/ooda-loop.md

新增OODA决策闭环Skill定义文件，支持SkillRouter自动路由触发。Skill定义包含：

- 自动触发（`auto_trigger: true`）
- 因果输入/输出声明（`causal_inputs`/`causal_outputs`）
- 证据类型定义（`ooda-cycle-completed`强标准、`decision-history`强标准、`cycle-speed-report`弱标准）
- 与7步工程流程的双层搭配关系

### InstanceBuilder暴露：runtime.oodaLoop

InstanceBuilder将oodaLoop暴露到运行时上下文映射表，通过`runtime.oodaLoop`可直接访问OodaLoop实例，供Dashboard API和其他运行时组件使用。
