# 模块详解 — OptimizationLoop 优化循环求解器

> 所属子系统：[[工作流子系统]] | 依赖：[[ConvergenceDetector]] | 融合自：Claude Collab Flow | 版本：2.73.4

## 模块概述

`optimization-loop.js` 是框架的迭代优化引擎，支持无限循环迭代优化、可量化指标追踪、收敛检测集成、策略自动切换、MD优化日志和快照回滚。它是 `/optimize` 斜杠命令的底层引擎。

**源码位置**：`src/runtime/workflow/optimization-loop.js`

## 核心能力

| 能力 | 说明 |
|------|------|
| 无限迭代优化 | `maxIterations` 默认 `Infinity`，直到收敛或手动停止 |
| 可量化指标追踪 | 6种内置指标类型（loss/roi/precision/recall/f1/custom） |
| 收敛检测集成 | 集成 `ConvergenceDetector`，自动判定收敛 |
| 策略自动切换 | 停滞/退化检测时自动切换优化策略 |
| MD优化日志 | Markdown格式优化日志，记录每次迭代详情 |
| 快照回滚 | 最多100个快照，支持回滚到历史最优状态 |
| 版本轨迹与一键回滚 | 记录每轮修改轨迹，递归差异比较，一键回滚到最优版本 |
| 资源预算约束 | 可配置资源预算上限，超出时自动停止 |

## 状态机

```
         defineObjective()
IDLE ──────────────────→ RUNNING
  ↑                         │  │
  │                    pause() │ stop() / converge / exhaust / fail
  │                         ↓  ↓
  │                      PAUSED  STOPPED / CONVERGED / EXHAUSTED / FAILED
  │                         │
  └─────── resume() ────────┘
```

7种循环状态：

| 状态 | 常量 | 说明 |
|------|------|------|
| 空闲 | `IDLE` | 初始状态，等待定义目标 |
| 运行中 | `RUNNING` | 正在迭代优化 |
| 暂停 | `PAUSED` | 手动暂停，可恢复 |
| 已停止 | `STOPPED` | 手动停止，不可恢复 |
| 已收敛 | `CONVERGED` | 质量达到收敛阈值 |
| 已耗尽 | `EXHAUSTED` | 达到最大迭代次数或资源预算 |
| 已失败 | `FAILED` | 连续失败超过阈值（默认5次） |

## 指标系统

### 内置指标类型

| 类型 | 方向 | 说明 |
|------|------|------|
| `loss` | minimize | 损失函数，越小越好 |
| `roi` | maximize | 投资回报率，越大越好 |
| `precision` | maximize | 精确率 |
| `recall` | maximize | 召回率 |
| `f1` | maximize | F1分数（精确率和召回率的调和平均） |
| `custom` | maximize | 自定义指标，默认最大化 |

### 指标定义

```javascript
loop.defineObjective(
  '优化API响应时间',
  ['响应时间 < 200ms', '内存使用 < 512MB'],
  [
    { name: 'latency', type: 'loss', weight: 0.6 },
    { name: 'throughput', type: 'roi', weight: 0.4 },
  ],
  { maxIterations: 50, convergenceThreshold: 0.9 }
);
```

## 策略自动切换

优化循环内置停滞/退化检测机制：

| 检测条件 | 阈值 | 触发行为 |
|---------|------|---------|
| 停滞检测 | `stagnationWindow=5` 次迭代无改善 | 切换策略 |
| 退化检测 | `DEGRADATION_THRESHOLD=0.05` | 回滚到上一快照 |
| 连续失败 | `MAX_CONSECUTIVE_FAILURES=5` | 标记 FAILED |
| 高原检测 | `STRATEGY_PLATEAU_THRESHOLD=3` | 切换策略 |

## 快照机制

- 最多保留 `MAX_SNAPSHOTS=100` 个快照
- 每次迭代自动创建快照（迭代号 + 指标值 + 时间戳）
- `rollback(iteration)` 回滚到指定迭代
- `rollbackToBest()` 回滚到最优迭代

## 版本轨迹（v2.10.7新增）

融合自Claude Collab Flow的版本回溯功能，记录AI每轮修改轨迹，支持一键回滚到最优版本。

### 版本轨迹结构

```javascript
{
  index: 0,                           // 版本序号
  iteration: 1,                       // 对应迭代号
  timestamp: 1717500000000,           // 时间戳
  score: 0.85,                        // 综合评分
  strategy: 'gradient-descent',       // 使用的策略
  label: 'optimal',                   // 标签：auto/optimal/rollback-target
  isBestBeat: true,                   // 是否刷新最佳分数
  isOptimal: true,                    // 是否当前最优版本
  diff: {                             // 与上一版本差异
    type: 'modified',
    keys: ['score', 'metrics'],
    details: [
      { path: 'score', type: 'modified', from: 0.72, to: 0.85 },
    ],
  },
  snapshotId: 'iter-1',               // 快照ID
  changes: 'Improved latency by 40ms', // 变更摘要
  contextBrief: {                     // 上下文快照
    stagnationCounter: 0,
    plateauCounter: 0,
    consecutiveFailures: 0,
  },
  snapshot: { ... },                  // 完整快照数据
}
```

### 版本轨迹方法

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `getVersionTrajectory()` | — | VersionEntry[] | 获取完整版本轨迹 |
| `compareVersions(indexA, indexB)` | number, number | object | 比较两个版本的差异 |
| `rollbackToOptimal()` | — | object | 一键回滚到最优版本 |
| `getVersionTimeline()` | — | string | 获取版本时间线（Markdown） |
| `markVersion(index, label)` | number, string | void | 标记版本（如'golden'/'baseline'） |

### 差异检测

`_computeVersionDiff` 方法递归比较两个快照，支持三种差异类型：

| 差异类型 | 说明 | 示例 |
|---------|------|------|
| `added` | 新增字段 | 新增指标 |
| `removed` | 移除字段 | 移除约束 |
| `modified` | 修改字段 | 分数从0.72变为0.85 |

递归深度限制：`VERSION_COMPARISON_DEPTH=8`

### 最优版本识别

`rollbackToOptimal` 方法自动识别最优版本：
- 最高分优先，同分则选最新
- 更新所有条目的`isOptimal`标志
- 触发`rollback-to-optimal`事件

### 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `MAX_VERSION_TRAJECTORY` | 200 | 最大版本轨迹记录数 |
| `VERSION_LABEL_TYPES` | `['auto', 'optimal', 'rollback-target', 'golden', 'baseline']` | 版本标签类型 |
| `DIFF_IGNORE_KEYS` | `['timestamp', 'snapshotId', 'contextBrief']` | 差异比较忽略的键 |
| `VERSION_COMPARISON_DEPTH` | 8 | 递归差异比较深度 |

## 优化日志

日志以 Markdown 格式写入 `HARNESS_DIR/optimization-journal.md`：

```markdown
# Optimization Journal

## Objective: 优化API响应时间
- Started: 2026-05-29T10:00:00Z
- Constraints: 响应时间 < 200ms, 内存使用 < 512MB

### Iteration 1
- Score: 0.72
- Metrics: latency=340ms, throughput=850req/s
- Strategy: gradient-descent
- Duration: 2.3s

### Iteration 2
- Score: 0.85
- Metrics: latency=210ms, throughput=920req/s
- Strategy: gradient-descent
- Duration: 1.8s
```

## API 参考

### 核心方法

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `defineObjective(objective, constraints, metrics, options)` | string, string[], MetricDef[], object | `{ success, error? }` | 定义优化目标 |
| `start(executeFn, options)` | Function, object | Promise\<LoopResult\> | 启动优化循环 |
| `pause()` | — | `{ success }` | 暂停循环 |
| `resume()` | — | `{ success }` | 恢复循环 |
| `stop()` | — | `{ success, result }` | 停止循环 |
| `rollback(iteration)` | number | `{ success, snapshot }` | 回滚到指定迭代 |
| `rollbackToBest()` | — | `{ success, snapshot }` | 回滚到最优迭代 |
| `getStatus()` | — | LoopStatus | 获取当前状态 |
| `getMetricsHistory()` | — | MetricSnapshot[] | 获取指标历史 |
| `getBestResult()` | — | `{ iteration, score, metrics }` | 获取最优结果 |

### 附加方法

| 方法 | 说明 |
|------|------|
| `attachMetricsCollector(collector)` | 附加外部指标收集器 |
| `attachConvergenceDetector(detector)` | 附加自定义收敛检测器 |
| `addConstraint(constraint)` | 动态添加约束 |
| `removeConstraint(constraint)` | 移除约束 |

## 与其他模块的关系

```
OptimizationLoop
  ├── ConvergenceDetector — 收敛判定
  ├── DeepeningOrchestrator — 深化推理（互为补充）
  ├── QualityScorer — 质量评分（可作为指标源）
  ├── ProgrammableHookExecutor — 钩子执行（每次迭代前后）
  └── SkillRouter — 技能路由（/optimize 命令触发）
```

## 配置参考

```javascript
const loop = new OptimizationLoop({
  maxIterations: Infinity,        // 最大迭代次数
  convergenceThreshold: 0.85,     // 收敛质量阈值
  iterationIntervalMs: 0,         // 迭代间隔（0=无间隔）
  metricsTypes: [],               // 初始指标类型
  journalPath: '',                // 日志路径（空=默认）
  gitTracking: false,             // 是否Git追踪变更
  stagnationWindow: 5,            // 停滞检测窗口
  resourceBudget: null,           // 资源预算（null=无限制）
});
```

## ContentAnalyticsEngine 内容特征-指标关联引擎

> 源码位置：`src/runtime/optimization/content-analytics-engine.js` | 版本：v2.7.178 | 融合自：R67 Auto Research

### 模块概述

`ContentAnalyticsEngine` 是优化子系统中的内容分析引擎，负责将内容分解为7维特征向量，关联内容特征与平台互动指标，发现驱动表现的规律，并生成优化假设。它为 `OptimizationLoop` 提供数据驱动的优化方向，使迭代优化从"盲目搜索"升级为"假设驱动"。

### 核心能力

| 能力 | 说明 |
|------|------|
| 7维特征向量分解 | 将内容分解为语义、结构、情感、可读性、时效性、权威性、互动性7个维度 |
| 特征-指标关联 | 关联内容特征与平台互动指标（点击率、完播率、分享率等） |
| 表现驱动规律发现 | 通过统计分析发现哪些特征组合驱动高表现 |
| 优化假设生成 | 基于发现的规律生成可验证的优化假设，供 OptimizationLoop 迭代验证 |

### 与 OptimizationLoop 的关系

```
OptimizationLoop
  ├── ContentAnalyticsEngine — 提供假设驱动的优化方向
  │     ├── analyzeContent() → 7维特征向量
  │     ├── correlateFeatures() → 特征-指标关联矩阵
  │     ├── discoverPatterns() → 表现驱动规律
  │     └── generateHypotheses() → 优化假设列表
  ├── ConvergenceDetector — 收敛判定
  └── ...
```

`ContentAnalyticsEngine` 在优化循环中充当"假设生成器"角色：在每轮迭代前，它分析当前内容特征与历史表现数据，生成优化假设；OptimizationLoop 将假设作为下一轮优化的方向，实现数据驱动的定向优化。

## 相关文档

- [[模块详解-工作流子系统]] — 工作流子系统总览
- [[模块详解-DeepeningOrchestrator模块]] — 深化推理编排器
- [[核心功能-深化推理引擎]] — 深化推理流程
- [[核心功能-质量评估与自反思]] — 质量评估机制
