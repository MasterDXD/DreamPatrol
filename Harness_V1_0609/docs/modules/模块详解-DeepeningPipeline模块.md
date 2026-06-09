# 模块详解-DeepeningPipeline模块

> 版本：2.73.4 | 文件：src/runtime/deepening/deepening-pipeline.js | 行数：~120行

---

## 模块定位

DeepeningPipeline是深化推理管道，是深化推理子系统的入口和编排层。它继承自DeepeningBase，串联7个核心子模块（DeepeningOrchestrator、DeepeningMetricsCollector、DeepeningCache、DeepeningStrategyPlugin、DeepeningReportGenerator、ConvergenceDetector、QualityScorer），通过依赖注入将它们装配到DeepeningOrchestrator中，实现端到端的迭代深化推理流程。DeepeningPipeline是深化推理子系统的门面（Facade），对外提供简洁的`initialize()`和`run()`接口。

## 类定义

```javascript
class DeepeningPipeline extends DeepeningBase {
  static PIPELINE_STAGES = { INIT, CACHE_CHECK, ITERATIVE_EXECUTION, COMPLETE }
  constructor(config)
  initialize()
  run(task, agents)
  getModule(name)
  generateReport(type)
  getStats()
  shutdown() // via DeepeningBase
}
```

## 构造函数

### `constructor(config)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `config` | object | 否 | 配置选项 |
| `config.autoInitialize` | boolean | 否 | 是否自动初始化，默认true |
| `config.maxIterations` | number | 否 | 最大迭代次数，默认4 |

初始化内部状态：
- `_config` — 配置对象
- `_initialized` — 是否已初始化
- `_modules` — 子模块实例映射
- `_pipelineRuns` — 管道执行次数计数器

**自动初始化**：当`config.autoInitialize !== false`时，构造函数自动调用`initialize()`

## 静态属性

### `PIPELINE_STAGES`

管道阶段枚举：

| 阶段 | 值 | 说明 |
|------|---|------|
| `INIT` | `'init'` | 初始化阶段 |
| `CACHE_CHECK` | `'cache-check'` | 缓存检查阶段 |
| `ITERATIVE_EXECUTION` | `'iterative-execution'` | 迭代执行阶段 |
| `COMPLETE` | `'complete'` | 完成阶段 |

## 公开方法详解

### `initialize()`

初始化管道，创建并装配所有子模块。

**返回值**：`boolean` — 初始化成功返回true

**行为细节**：
- 已初始化时直接返回true（幂等）
- 创建7个子模块实例
- 通过`attach*()`方法将子模块注入DeepeningOrchestrator
- 初始化完成后触发`pipeline-initialized`事件

**子模块创建与装配顺序**：

| 步骤 | 子模块 | 装配方法 |
|------|--------|---------|
| 1 | DeepeningOrchestrator | — （核心编排器） |
| 2 | DeepeningMetricsCollector | `orch.attachMetricsCollector(mc)` |
| 3 | DeepeningCache | `orch.attachCache(cache)` |
| 4 | DeepeningStrategyPlugin | `orch.attachStrategyPlugin(sp)` |
| 5 | DeepeningReportGenerator | `orch.attachReportGenerator(rg)` |
| 6 | ConvergenceDetector | `orch.attachConvergenceDetector(cd)` |
| 7 | QualityScorer | `orch.attachQualityScorer(qs)` |

### `run(task, agents)`

执行深化推理管道。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task` | object | 是 | 任务描述 |
| `agents` | object/array | 是 | Agent列表（数组或对象） |

**返回值**：`Promise<PipelineResult>`

**PipelineResult结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 是否成功 |
| `task` | object | 原始任务 |
| `agents` | number | Agent数量 |
| `pipelineId` | string | 管道执行唯一ID |
| `duration` | number | 执行耗时（毫秒） |
| `error` | string | 错误消息（失败时） |
| `depthLevel` | number | 达到的深度级别（来自Orchestrator） |
| `bestScore` | number | 最佳质量评分（来自Orchestrator） |
| 其他字段 | any | 来自DeepeningOrchestrator.execute()的返回值 |

**执行流程**：
1. 检查关闭状态，已关闭则返回`{success: false, error: 'shut-down'}`
2. 若未初始化则自动初始化
3. 生成唯一pipelineId（`dp-`前缀 + 时间戳）
4. 递增`_pipelineRuns`计数器
5. 触发`pipeline-start`事件
6. 校验task和agents参数，缺失则返回错误
7. 委托DeepeningOrchestrator.execute()执行
8. 触发`pipeline-complete`事件
9. 返回结果（包含pipelineId和duration）

**错误处理**：
- Orchestrator执行异常时捕获错误，返回`{success: false, error: err.message}`
- 无论成功或失败都触发`pipeline-complete`事件

### `getModule(name)`

按名称获取子模块实例。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 子模块名称 |

**返回值**：子模块实例或null

**可用模块名**：

| 名称 | 类型 | 说明 |
|------|------|------|
| `orchestrator` | DeepeningOrchestrator | 深化推理编排器 |
| `metricsCollector` | DeepeningMetricsCollector | 指标收集器 |
| `cache` | DeepeningCache | 缓存模块 |
| `strategyPlugin` | DeepeningStrategyPlugin | 策略插件 |
| `reportGenerator` | DeepeningReportGenerator | 报告生成器 |
| `convergenceDetector` | ConvergenceDetector | 收敛检测器 |
| `qualityScorer` | QualityScorer | 质量评分器 |

### `generateReport(type)`

生成深化推理报告。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 否 | 报告类型 |

**返回值**：报告对象

**行为细节**：
- 有reportGenerator时委托其`generate()`方法
- 无reportGenerator时返回基础报告：`{type, pipelineRuns, generatedAt}`

### `getStats()`

获取管道统计信息。

**返回值**：继承DeepeningBase的统计 + 以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `initialized` | boolean | 是否已初始化 |
| `moduleCount` | number | 子模块数量 |
| `modules` | string[] | 子模块名称列表 |
| `pipelineRuns` | number | 管道执行次数 |

## 子模块详解

### DeepeningOrchestrator（编排器）

核心执行引擎，负责迭代精化、多Agent路由、并行执行。通过`attach*()`方法注入其他子模块实现能力可插拔。详见[模块详解-DeepeningOrchestrator模块](模块详解-DeepeningOrchestrator模块.md)。

### DeepeningMetricsCollector（指标收集器）

收集深化推理过程中的质量分数、执行时间等指标。

### DeepeningCache（缓存模块）

缓存深化推理结果，相同任务可命中缓存避免重复计算。执行前检查缓存命中，执行后存储结果。

### DeepeningStrategyPlugin（策略插件）

自定义迭代停止策略。默认使用`fixed-depth`策略（固定深度迭代），可通过`config.maxIterations`控制最大迭代次数。

### DeepeningReportGenerator（报告生成器）

生成深化推理的执行摘要报告，包含迭代历史、质量变化趋势等。

### ConvergenceDetector（收敛检测器）

检测深化推理输出是否已收敛到稳定状态。每轮迭代后检查质量分数，收敛则提前终止迭代。

### QualityScorer（质量评分器）

对每轮深化推理的输出进行多维度质量评估，返回0-1的质量分数。

## 管道执行流程

```
DeepeningPipeline.run(task, agents)
  │
  ├── 生成 pipelineId
  ├── 触发 pipeline-start 事件
  │
  └── DeepeningOrchestrator.execute(task, agents)
        │
        ├── [缓存检查] DeepeningCache → 命中则直接返回
        │
        ├── [迭代执行] 循环：
        │     ├── 多Agent路由 → 选择最佳Agent
        │     ├── 执行任务 → 获取输出
        │     ├── QualityScorer.assess() → 质量评分
        │     ├── MetricsCollector.record() → 记录指标
        │     ├── ConvergenceDetector.check() → 收敛检测
        │     │     └── 收敛 → 提前终止
        │     └── StrategyPlugin.decide() → 是否继续迭代
        │
        ├── [缓存存储] DeepeningCache.set() → 缓存结果
        ├── [报告生成] DeepeningReportGenerator.generate()
        │
        └── 返回结果
              │
  ├── 触发 pipeline-complete 事件
  └── 返回 PipelineResult
```

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `pipeline-initialized` | 管道初始化完成 | 无 |
| `pipeline-start` | 管道开始执行 | `{task}` |
| `pipeline-complete` | 管道执行完成 | `PipelineResult` |

## 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `DEFAULT_MAX_ITERATIONS` | 4 | 默认最大迭代次数 |

## 使用示例

### 基本用法

```javascript
const DeepeningPipeline = require('./src/runtime/deepening/deepening-pipeline');

const pipeline = new DeepeningPipeline({
  maxIterations: 6,
  autoInitialize: true
});

const result = await pipeline.run(
  { description: '优化API性能', target: 'server.js' },
  ['task-worker', 'domain-analyst']
);

console.log('成功:', result.success);
console.log('深度级别:', result.depthLevel);
console.log('最佳评分:', result.bestScore);
console.log('耗时:', result.duration + 'ms');
console.log('管道ID:', result.pipelineId);
```

### 手动初始化

```javascript
const pipeline = new DeepeningPipeline({
  autoInitialize: false,
  maxIterations: 8
});

pipeline.initialize();

const mc = pipeline.getModule('metricsCollector');
const cache = pipeline.getModule('cache');
console.log('已加载模块:', pipeline.getStats().modules);
```

### 报告生成

```javascript
const report = pipeline.generateReport('summary');
console.log('管道执行次数:', report.pipelineRuns);
console.log('生成时间:', report.generatedAt);
```

### 事件监听

```javascript
pipeline.on('pipeline-start', ({task}) => {
  console.log('管道启动:', task.description);
});

pipeline.on('pipeline-complete', (result) => {
  console.log('管道完成:', result.success ? '成功' : '失败');
  console.log('耗时:', result.duration + 'ms');
});
```

### 统计信息

```javascript
const stats = pipeline.getStats();
console.log('已初始化:', stats.initialized);
console.log('模块数:', stats.moduleCount);
console.log('执行次数:', stats.pipelineRuns);
console.log('模块列表:', stats.modules);
```

## 依赖关系

- 依赖：`./deepening-base.js` — DeepeningBase基类
- 依赖：`./deepening-orchestrator.js` — DeepeningOrchestrator编排器
- 依赖：`./deepening-metrics-collector.js` — DeepeningMetricsCollector指标收集器
- 依赖：`./deepening-cache.js` — DeepeningCache缓存
- 依赖：`./deepening-strategy-plugin.js` — DeepeningStrategyPlugin策略插件
- 依赖：`./deepening-report-generator.js` — DeepeningReportGenerator报告生成器
- 依赖：`./convergence-detector.js` — ConvergenceDetector收敛检测器
- 依赖：`../quality/quality-scorer.js` — QualityScorer质量评分器
- 依赖：`../../utils/unique-id.js` — timestampId、ID_PREFIXES
- 被依赖：`src/index.js` — 主入口装配
- 被依赖：`iterative-deepening` Skill — 迭代深化推理

## 集成说明

- DeepeningPipeline是`iterative-deepening` Skill的执行引擎，Skill触发时创建Pipeline实例
- 与DeepeningOrchestrator的关系：Pipeline是Facade，Orchestrator是实际执行者
- 与CollaborationModeRouter配合：深化推理可使用`deepening`协作模式
- 与TokenManager配合：通过Token感知深化策略控制Token消耗
- 与EventBus配合：管道事件可通过EventBus广播到其他子系统
- 与Dashboard配合：管道统计和报告可通过API端点暴露
- getModule()方法允许外部代码直接访问子模块，实现灵活的定制和扩展

## 相关文档

- [模块详解-DeepeningOrchestrator模块](模块详解-DeepeningOrchestrator模块.md)
- [模块详解-DeepeningBase深化基类](模块详解-DeepeningBase深化基类.md)
- [核心功能-多Agent协作流程](../core/核心功能-多Agent协作流程.md)
