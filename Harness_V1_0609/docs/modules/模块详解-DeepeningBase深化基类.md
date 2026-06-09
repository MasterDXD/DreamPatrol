# 模块详解-DeepeningBase深化基类

## 概述

DeepeningBase 是整个深化子系统的基类，50+子模块均继承自此类。它提供依赖注入（`attach`模式）、ShutdownMixin集成、以及标准的健康检查/统计接口。尽管代码量小（76行），它是整个代码库中被引用最多的模块（55处引用）。

**源码位置**：`src/runtime/deepening/deepening-base.js`（76行）

## 架构角色

```
DeepeningBase（基类）
  ├── DeepeningOrchestrator    — 深化推理编排器
  ├── DeepeningPipeline        — 深化管道
  ├── DeepeningCache           — 深化缓存
  ├── DeepeningStateMachine    — 深化状态机
  ├── DeepeningTaskScheduler   — 深化任务调度器
  ├── ConvergenceDetector      — 收敛检测器
  ├── QualityScorer            — 质量评分器
  ├── DeepeningStrategyPlugin  — 策略插件
  ├── DeepeningReportGenerator — 报告生成器
  ├── DeepeningEventStore      — 事件存储
  ├── DeepeningMetricsCollector— 指标收集器
  └── 40+ 其他子模块
```

## 核心 API

### 构造函数

```javascript
constructor(options)
```

- `options`：配置对象，存储为 `this._options`（未传入时默认为 `{}`）
- 自动初始化：`this._shutDown = false`、`this._deps = {}`

### 依赖注入（attach 模式）

#### 通用 attach 方法

```javascript
attach(name, dep) → this
```

通过名称查找 `ATTACH_DEFS` 定义并挂载依赖。`name` 参数支持两种形式：
- 属性键名（不含下划线前缀）：如 `'sqliteStore'` → 查找 `_sqliteStore`
- 方法名（不含 `attach` 前缀）：如 `'SqliteStore'` → 查找 `attachSqliteStore`

若名称未在 `ATTACH_DEFS` 中定义，**静默返回 `this`**，不抛出错误。

#### 27 个专用 attach 方法

所有 `attach*` 方法返回 `this`，支持链式调用。按功能分为三类：

**核心依赖**（基础运行所需）

| 方法 | 属性键 | 说明 |
|------|--------|------|
| `attachSqliteStore(store)` | `_sqliteStore` | 数据持久化存储 |
| `attachSessionManager(sm)` | `_sessionManager` | 会话状态管理 |
| `attachDeepeningOrchestrator(orch)` | `_deepeningOrchestrator` | 深化推理编排核心 |
| `attachCausalDataBus(bus)` | `_causalDataBus` | 因果事件总线 |
| `attachModelSelector(ms)` | `_modelSelector` | 模型选择与降级 |
| `attachContextManager(cm)` | `_contextManager` | 隔离上下文管理 |
| `attachSkillRouter(router)` | `_skillRouter` | Skill自动路由 |
| `attachScheduler(sched)` | `_scheduler` | 深化任务调度 |

**基础设施依赖**（可选，高级功能所需）

| 方法 | 属性键 | 说明 |
|------|--------|------|
| `attachSignalPersistence(sp)` | `_signalPersistence` | 进程信号持久化 |
| `attachPatchApproval(pa)` | `_patchApproval` | 技能补丁审批流程 |
| `attachPlanPersistence(pp)` | `_planPersistence` | 执行计划持久化 |
| `attachSubagentExecutor(se)` | `_subagentExecutor` | 子Agent执行器 |
| `attachThoughtRetrieverCycle(trc)` | `_thoughtRetrieverCycle` | 思维检索循环 |
| `attachRBACEnforcer(rbac)` | `_rbacEnforcer` | 基于角色的访问控制 |
| `attachVectorIndex(vi)` | `_vectorIndex` | 因果向量索引 |
| `attachConfigCausalValidator(ccv)` | `_configCausalValidator` | 因果配置验证 |
| `attachCausalBufferManager(cbm)` | `_causalBufferManager` | 因果缓冲管理 |
| `attachPhaseContextInjector(pci)` | `_phaseContextInjector` | 阶段上下文注入 |
| `attachHealthChecker(hc)` | `_healthChecker` | 健康检查器 |
| `attachGeneratorVerifier(gv)` | `_generatorVerifier` | 生成器验证器 |

**质量与监控依赖**（可选，质量保障所需）

| 方法 | 属性键 | 说明 |
|------|--------|------|
| `attachQualityScorer(qs)` | `_qualityScorer` | 多维度质量评分 |
| `attachConvergenceDetector(cd)` | `_convergenceDetector` | 收敛检测与早停 |
| `attachMetricsCollector(mc)` | `_metricsCollector` | 深化指标收集 |
| `attachCache(cache)` | `_cache` | 深化缓存 |
| `attachStrategyPlugin(sp)` | `_strategyPlugin` | 策略插件 |
| `attachReportGenerator(rg)` | `_reportGenerator` | 报告生成 |
| `attachEventStore(es)` | `_eventStore` | 事件存储 |

### 生命周期

| 方法 | 签名 | 说明 |
|------|------|------|
| `shutdown()` | `() → void` | 标记关闭状态，触发 `_onShutdown()`，发出 `shutdown` 事件，移除所有监听器 |
| `isHealthy()` | `() → boolean` | 健康检查，默认返回 `!this._shutDown` |
| `getStats()` | `() → object` | 统计信息，子类应覆盖 |
| `acquire(key)` | `(key: string) → boolean` | 获取资源锁（基类默认返回 `true`） |
| `release(key)` | `(key: string) → boolean` | 释放资源锁（基类默认返回 `true`） |
| `getAvailability()` | `() → { available: boolean }` | 可用性信息 |
| `guardShutdown()` | `() → void` | 若已关闭则抛出 `AgentError` 或 `SessionError` |

### 静态方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `_warnDeprecated(className, replacement, moduleTag)` | `static` | 发出废弃警告，同一类名仅警告一次 |
| `ATTACHABLE_DEPS` | `static` | 可挂载依赖的公开定义列表，供外部查询 |

### _onShutdown() 资源释放行为

`_onShutdown()` 是关闭流程的核心清理钩子，由 `ShutdownMixin.shutdown()` 在设置 `_shutDown = true` 后调用。基类实现执行以下三步清理：

1. **清空所有挂载依赖属性**：遍历 `ATTACH_DEFS`，将每个 `this[def.prop]` 设为 `undefined`
2. **清空依赖索引**：将 `this._deps` 重置为空对象 `{}`
3. **移除所有事件监听器**：由 `ShutdownMixin.shutdown()` 在 `_onShutdown()` 返回后调用 `this.removeAllListeners()`

完整关闭流程时序：

```
shutdown() 被调用
  ├── 1. 检查幂等性：若 _shutDown 或 _shuttingDown 为 true，直接返回
  ├── 2. 设置 _shuttingDown = true, _shutDown = true
  ├── 3. 调用 _onShutdown()          ← 子类清理 + 基类清理
  ├── 4. 发出 'shutdown' 事件         ← { signal: 'manual' }
  ├── 5. 调用 removeAllListeners()    ← 清除所有 EventEmitter 监听器
  └── 6. 设置 _shuttingDown = false
```

> **注意**：`_onShutdown()` 在 `removeAllListeners()` 之前执行，因此子类在 `_onShutdown()` 中仍可安全地发出事件。

### ⚠️ 关键约定：子类必须调用 super._onShutdown()

**所有覆盖 `_onShutdown()` 的子类必须在方法末尾调用 `super._onShutdown()`。** 这是强制性的编码规范，原因如下：

- 基类 `_onShutdown()` 负责清空 27 个挂载依赖属性和 `_deps` 索引
- 若子类不调用 `super._onShutdown()`，已关闭的实例仍持有对其他模块的引用，导致：
  - **内存泄漏**：被引用模块无法被 GC 回收
  - **僵尸调用**：已关闭实例仍可通过残留依赖调用其他模块方法
  - **事件泄漏**：若依赖间存在事件订阅，引用未断开则监听器不会自动移除

**正确模式**（项目中的实际用例）：

```javascript
// DeepeningTaskScheduler — 清理定时器后调用 super
_onShutdown() {
  for (const [, t] of this._tasks) {
    if (t.timerId) clearTimeout(t.timerId);
    if (t.intervalId) clearInterval(t.intervalId);
  }
  this._tasks.clear();
  this._byName.clear();
  this._byState = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  super._onShutdown();  // ← 必须调用
}

// DeepeningHealthMonitor — 停止监控后调用 super
_onShutdown() {
  this.stop();
  super._onShutdown();  // ← 必须调用
}

// DeepeningOrchestrator — 清理内部状态后调用 super
_onShutdown() {
  this._execLog.length = 0;
  this._totalExec = 0;
  this._mc = null;
  this._cache = null;
  // ... 清理其他内部引用
  super._onShutdown();  // ← 必须调用
}
```

**合规状态**：所有覆盖 `_onShutdown()` 的子类均已正确调用 `super._onShutdown()`。此前存在30处违规（R4修复18处，R5修复12处），现已全部消除。基类的依赖清空逻辑在所有子类关闭流程中均能可靠执行。

## 错误处理模式

### attach() 的静默容错

`attach(name, dep)` 方法在以下情况下**静默返回 `this`**，不抛出错误：

- `name` 未在 `ATTACH_DEFS` 中定义（拼写错误、已废弃的依赖名）
- 传入的 `dep` 为 `null` 或 `undefined`（仍会赋值到属性上）

这种设计是有意为之：深化子模块的依赖是可选的，不应因缺少某个非关键依赖而阻断初始化流程。但这也意味着**拼写错误不会被检测到**，建议在子类中通过 `guardShutdown()` 或运行时检查确认关键依赖已注入。

### shutdown() 的幂等性

`shutdown()` 方法具有幂等性：
- 若 `_shutDown` 或 `_shuttingDown` 已为 `true`，直接返回，不重复执行清理
- 多次调用 `shutdown()` 是安全的

### guardShutdown() 的错误映射

`guardShutdown()` 根据类名映射到不同的错误类型：

| 类名前缀 | 抛出错误类型 |
|---------|------------|
| `AgentStateManager` / `AgentLifecycleController` / `AgentRuntime` 等 | `AgentError` |
| `SessionManager` | `SessionError` |
| 其他类 | `AgentError`（默认） |

错误码统一为 `ERROR_CODES.SHUTDOWN`，消息格式为 `"<ClassName> is shut down"`。

### DeepeningPipeline 的容错关闭

`DeepeningPipeline._onShutdown()` 在关闭子模块时使用 `try-catch` 包裹，确保单个模块关闭失败不会阻断其他模块的清理：

```javascript
_onShutdown() {
  for (const mod of Object.values(this._modules)) {
    if (mod && typeof mod.shutdown === 'function') {
      try { mod.shutdown(); } catch (_) { /* 记录日志，继续关闭其他模块 */ }
    }
  }
  this._initialized = false;
  this._modules = {};
}
```

## 完整使用示例

### 创建自定义子类

```javascript
'use strict';

const DeepeningBase = require('./deepening-base');

class MyDeepeningModule extends DeepeningBase {

  constructor(options) {
    super(options);
    this._buffer = [];
    this._timerId = null;
  }

  start(intervalMs) {
    this.guardShutdown();
    this._timerId = setInterval(() => {
      this._processBuffer();
    }, intervalMs);
  }

  add(item) {
    this.guardShutdown();
    this._buffer.push(item);
  }

  _processBuffer() {
    if (this._cache) {
      this._cache.set('lastProcess', Date.now());
    }
    this._buffer.length = 0;
  }

  getStats() {
    return {
      ...super.getStats(),
      bufferSize: this._buffer.length,
      hasTimer: this._timerId !== null,
    };
  }

  _onShutdown() {
    if (this._timerId) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
    this._buffer.length = 0;
    super._onShutdown();
  }
}

module.exports = MyDeepeningModule;
```

### 依赖注入与链式调用

```javascript
const MyDeepeningModule = require('./my-deepening-module');
const { DeepeningCache } = require('./deepening-cache');
const { DeepeningMetricsCollector } = require('./deepening-metrics-collector');

const cache = new DeepeningCache({ maxSize: 1000 });
const metrics = new DeepeningMetricsCollector({ interval: 5000 });

const mod = new MyDeepeningModule({ name: 'example' });

mod
  .attachCache(cache)
  .attachMetricsCollector(metrics);

mod.start(3000);
mod.add({ type: 'test', value: 42 });
```

### 使用通用 attach 方法

```javascript
const mod = new MyDeepeningModule({});

mod.attach('cache', cache);
mod.attach('metricsCollector', metrics);
mod.attach('unknownDep', something);
```

### 生命周期管理

```javascript
const mod = new MyDeepeningModule({});

mod.on('shutdown', (evt) => {
  console.log('Module shutdown:', evt.signal);
});

console.log(mod.isHealthy());
console.log(mod.getAvailability());
console.log(mod.getStats());

mod.shutdown();

console.log(mod.isHealthy());
```

## 设计模式

### 1. 依赖注入（DI）

DeepeningBase 使用"attach方法"模式实现依赖注入，而非构造函数注入。这允许：
- 延迟绑定：模块创建后再注入依赖
- 可选依赖：不是所有子模块都需要所有依赖
- 循环依赖避免：通过延迟绑定解决循环引用

### 2. ShutdownMixin 集成

DeepeningBase 通过 `Object.assign(DeepeningBase.prototype, ShutdownMixin)` 混入关闭能力，提供：
- `_onShutdown()` 钩子方法
- `withShutdown()` 类装饰器
- `guardShutdown()` 关闭守卫
- 标准化的关闭流程（幂等、有序、容错）

### 3. 事件驱动

继承自 `EventEmitter`，所有子模块自动支持事件机制。关闭时自动发出 `shutdown` 事件并移除所有监听器。

### 4. 废弃警告

通过静态方法 `_warnDeprecated(className, replacement, moduleTag)` 提供一次性废弃警告，避免重复日志输出。使用静态 `_deprecationWarnedSet` 跟踪已警告的类名。

## 与其他模块的关系

| 模块 | 关系 |
|------|------|
| ShutdownMixin | 提供关闭生命周期管理（mixin混入） |
| EventEmitter | 提供事件机制（类继承） |
| ModuleInitializer | 负责创建所有子模块并调用 attach* 方法 |
| DeepeningOrchestrator | 核心子类，编排深化推理流程 |
| DeepeningPipeline | 核心子类，串联21个子模块 |
| ATTACH_DEFS | 依赖定义常量，驱动 attach 方法生成和 _onShutdown 清理 |

## 设计决策

1. **attach模式而非构造函数注入**：深化子模块数量多（27个可注入依赖），构造函数注入会导致参数爆炸
2. **返回this**：支持链式调用 `obj.attachA(a).attachB(b).attachC(c)`
3. **最小化基类**：基类只提供基础设施，不包含业务逻辑
4. **ShutdownMixin组合**：通过mixin而非继承实现关闭功能，保持类层次扁平
5. **ATTACH_DEFS驱动**：27个attach方法通过常量数组动态生成，`_onShutdown()` 也基于同一数组清理，确保新增依赖时两处自动同步
6. **双向索引**：`_ATTACH_INDEX` 支持按属性键名和方法名双向查找，使 `attach()` 通用方法更灵活
7. **静默容错**：`attach()` 对未知依赖名静默返回，避免可选依赖阻断初始化
8. **acquire/release 占位**：基类提供默认返回 `true` 的锁方法，子类可按需覆盖实现真实锁逻辑
