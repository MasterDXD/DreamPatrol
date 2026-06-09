# 模块详解-ShutdownMixin关机混入

## 概述

ShutdownMixin 位于 `src/utils/shutdown-mixin.js`，提供标准化的 `shutdown()`、`isHealthy()` 和 `guardShutdown()` 方法实现，消除 25+ 个模块中的重复代码。

## 设计动机

项目中有 25 个模块包含几乎相同的 shutdown/isHealthy 模式：

```javascript
shutdown() {
  if (this._shutDown) return;
  this._shutDown = true;
  // 可选的额外清理逻辑
  try { this.emit('shutdown'); } catch (_) {}
  this.removeAllListeners();
}

isHealthy() { return !this._shutDown; }
```

通过提取为 Mixin，每个模块只需定义 `_onShutdown` 钩子方法来处理自己的清理逻辑。

## API

### ShutdownMixin

混入对象，包含 `isHealthy()`、`guardShutdown()` 和 `shutdown()` 三个方法。

### guardShutdown()

守卫关闭方法。检查模块是否已关闭，若已关闭则抛出对应的错误（AgentError 或 SessionError）。被 AgentDeployment、AgentStateManager 等多个模块在执行关键操作前调用，防止已关闭的模块继续处理请求。

```javascript
guardShutdown() {
  if (this._shutDown) throw new AgentError('SHUTDOWN', this.constructor.name + ' is shut down');
}
```

### withShutdown(Klass)

将 ShutdownMixin 应用到指定类的原型上。

```javascript
const { withShutdown } = require('./shutdown-mixin');

class MyModule extends EventEmitter {
  constructor() {
    super();
    this._shutDown = false;
    this._onShutdown = function() {
      // 自定义清理逻辑
      this._cache.clear();
    };
  }
  // 不再需要手动定义 shutdown() 和 isHealthy()
}

withShutdown(MyModule);
```

### _onShutdown 钩子

如果类定义了 `_onShutdown` 方法，`shutdown()` 会在设置 `_shutDown = true` 之后、`emit('shutdown')` 之前调用它。

## 已应用模块

| 模块 | 额外清理逻辑 |
|------|------------|
| EventBus | 清除 history 和 middleware |
| HealthChecker | 清除 checks 和 prevStatusMap |
| RetryEngine | 清除 attempts |
| PlatformCoordinator | 清除 platforms 和 routes |

## shutdown()方法实现细节

### 执行流程

`shutdown()` 方法的执行流程严格遵循以下顺序，确保关闭过程的确定性和安全性：

```
1. _initShutdownState()  →  懒初始化 _shutDown / _shuttingDown 标志
2. 幂等检查              →  若 _shutDown 或 _shuttingDown 已为 true，立即返回
3. 设置中间态            →  _shuttingDown = true（防止并发重入）
4. 设置终态              →  _shutDown = true
5. 调用 _onShutdown()    →  执行子类自定义清理逻辑
6. emit('shutdown')      →  通过 safeCall 安全发射关闭事件
7. removeAllListeners()  →  移除所有事件监听器
8. 清除中间态            →  _shuttingDown = false
```

### 事件发射顺序与时机

关闭事件 `shutdown` 在 `_onShutdown()` 之后、`removeAllListeners()` 之前发射。这意味着：

- 监听 `shutdown` 事件的回调仍可在此刻执行，因为监听器尚未被移除
- 事件 payload 为 `{ signal: this._shutdownSignal || 'manual' }`，区分信号触发与手动关闭
- 事件发射通过 `safeCall` 包裹，即使回调抛异常也不会阻断后续清理流程

### removeAllListeners 时机

`removeAllListeners()` 在 `emit('shutdown')` 之后调用，这是刻意的设计：

- 先通知后清理：让监听者有机会响应关闭事件，再统一移除
- 防止泄漏：关闭后的对象不再持有任何监听器引用，避免 GC 无法回收
- 仅当实例存在 `removeAllListeners` 方法（即继承自 EventEmitter）时才调用

### 异步 _onShutdown 支持

若 `_onShutdown()` 返回 Promise（即 `result && typeof result.then === 'function'`），Mixin 会将其存储到 `this._shutdownPromise`。调用方可通过 `waitForShutdown()` 等待异步清理完成：

```javascript
instance.shutdown();
await instance.waitForShutdown();
```

### 错误处理策略

整个 `shutdown()` 方法不使用 try-catch 包裹 `_onShutdown()`，原因如下：

- `_onShutdown()` 内部的错误应由子类自行处理
- `emit('shutdown')` 通过 `safeCall` 包裹，确保事件回调异常不影响后续清理
- `removeAllListeners()` 不可能抛异常（Node.js EventEmitter 保证）

## guardShutdown()错误类型

### 错误类型映射表

`guardShutdown()` 根据类名自动选择抛出 `AgentError` 或 `SessionError`，映射关系定义在 `_ERROR_CLASS_MAP` 中：

| 类名 | 抛出错误类型 | 所属子系统 |
|------|------------|-----------|
| AgentStateManager | AgentError | Agent子系统 |
| AgentLifecycleController | AgentError | Agent子系统 |
| AgentWorkflowIntegration | AgentError | Agent子系统 |
| AgentRuntime | AgentError | Agent子系统 |
| AgentDeployment | AgentError | Agent子系统 |
| AgentMonitor | AgentError | Agent子系统 |
| AgentSandbox | AgentError | Agent子系统 |
| SessionManager | SessionError | 会话子系统 |

### 选择逻辑

1. 查找 `_ERROR_CLASS_MAP[className]`
2. 若找到映射，使用映射的错误类
3. 若未找到映射，**默认使用 AgentError**（`_ERROR_CLASS_MAP[className] || AgentError`）
4. 错误码统一为 `ERROR_CODES.SHUTDOWN`，消息格式为 `"{className} is shut down"`

### 设计考量

- **AgentError**：Agent子系统的模块关闭后拒绝请求，属于运行时Agent错误
- **SessionError**：SessionManager关闭后拒绝请求，属于会话生命周期错误
- 默认回退到 AgentError 而非通用 HarnessError，因为大多数模块属于Agent运行时范畴
- 错误类型区分使上层调用者能精确捕获和处理不同子系统的关闭异常

### 扩展映射

新增模块若需要自定义错误类型，在 `_ERROR_CLASS_MAP` 中添加映射即可：

```javascript
_ERROR_CLASS_MAP['MyNewModule'] = SessionError;
```

## 完整25个模块清单

### 已应用 withShutdown 的模块（25个）

| 序号 | 模块 | 子系统 | _onShutdown 清理逻辑 |
|------|------|--------|---------------------|
| 1 | AgentDeployment | agent | 清除版本映射、灰度配置、回滚快照 |
| 2 | SubagentExecutor | agent | 取消活跃子Agent、清除任务队列 |
| 3 | CollaborationModeRouter | collaboration | 清除定时器、模式覆盖、历史记录 |
| 4 | OutputFusion | collaboration | 清除融合策略、结果缓存 |
| 5 | AgentContributionTracker | collaboration | 清除贡献度记录 |
| 6 | AgentDiversityManager | collaboration | 清除Agent画像、历史 |
| 7 | EnsembleOrchestrator | collaboration | 清除集成任务、投票记录 |
| 8 | ChatChain | collaboration | 清除链式上下文 |
| 9 | PairChat | collaboration | 清除配对状态 |
| 10 | CausalDataBus | causal | 清除发布/订阅、缓冲区、索引 |
| 11 | DeepeningOrchestrator | deepening | 清除执行日志、挂载模块引用 |
| 12 | SharedInfrastructure（4个内部类） | infrastructure | 清除连接池、负载均衡器、服务注册、特性标志 |
| 13 | SqliteStore | infrastructure | 关闭数据库连接 |
| 14 | MCPClient | infrastructure | 终止子进程、清除传输层 |
| 15 | AutoVersionTracker | infrastructure | 清除文件监听、变更日志 |
| 16 | InferenceCache | model | 清除缓存条目、LRU索引 |
| 17 | QualityScorer | quality | 清除评分模型、历史 |
| 18 | SelfReflection | quality | 清除反思记录 |
| 19 | AdversarialReview | quality | 清除审查队列 |
| 20 | SelfEvolutionGovernor | quality | 清除演化策略、速率限制 |
| 21 | SkillRouter | skill | 清除三层缓存、技能索引 |
| 22 | SkillGraph | skill | 清除节点/边映射 |
| 23 | SessionManager | session | 防抖持久化刷盘、清除会话存储 |
| 24 | GoalExecutor | workflow | 暂停活跃目标、清除定时器、刷盘 |
| 25 | PhaseOrchestrator | workflow | 清除阶段状态、转换规则 |

### 额外已应用模块（含gate/permission/thought/user等）

| 序号 | 模块 | 子系统 | _onShutdown 清理逻辑 |
|------|------|--------|---------------------|
| 26 | TDDGate | gate | 清除门禁记录 |
| 27 | EvidenceVerifier | gate | 清除验证缓存 |
| 28 | GeneratorVerifier | gate | 清除验证结果 |
| 29 | CodeReviewFrameworkCheck | gate | 清除检查清单 |
| 30 | DeviationApproval | gate | 清除偏差审批记录 |
| 31 | SkillPatchApproval | gate | 清除补丁审批 |
| 32 | KarpathyEnhancer | gate | 清除增强缓存 |
| 33 | BrainMemory | thought | 清除分层记忆 |
| 34 | DreamEngine | thought | 清除梦境队列 |
| 35 | LLMWiki | thought | 清除知识库索引 |
| 36 | MemoryNudge | thought | 清除推动队列 |
| 37 | MemorySyncCoordinator | thought | 清除同步策略 |
| 38 | MemoryPipeline | thought | 级联关闭Recall/Sync/Prefetch |
| 39 | MemoryPrefetcher | thought | 清除预取信号 |
| 40 | UnifiedMemoryRecaller | thought | 清除查询缓存 |
| 41 | UserModelManager | user | 清除用户画像 |
| 42 | StructuredIntent | user | 清除意图解析缓存 |
| 43 | WorkflowDAG | workflow | 清除DAG节点/边 |
| 44 | OptimizationLoop | workflow | 清除优化状态、快照 |
| 45 | RBACEnforcer | permission | 清除角色/权限映射 |
| 46 | HookHandlers (RateLimitManager) | workflow | 清除限流计数器 |

## 迁移指南

### 从手动 shutdown/isHealthy 迁移到 Mixin 的步骤

#### 第1步：引入 withShutdown

```javascript
const { withShutdown } = require('../../utils/shutdown-mixin');
```

#### 第2步：移除手动 shutdown() 和 isHealthy() 方法

将类中手动定义的 `shutdown()` 和 `isHealthy()` 方法删除。若 `isHealthy()` 包含额外逻辑（如并发检查），保留并合并（见第4步）。

#### 第3步：将清理逻辑移入 _onShutdown()

```javascript
// 迁移前
shutdown() {
  if (this._shutDown) return;
  this._shutDown = true;
  clearInterval(this._timer);
  this._cache.clear();
  try { this.emit('shutdown'); } catch (_) {}
  this.removeAllListeners();
}

// 迁移后
_onShutdown() {
  clearInterval(this._timer);
  this._cache.clear();
}
```

#### 第4步：处理 isHealthy() 的额外逻辑

若原有 `isHealthy()` 除了检查 `_shutDown` 外还有额外条件，使用 `withShutdown` 的合并机制：

```javascript
// withShutdown 会自动合并：_shutDown 为 true 时返回 false，
// 否则调用原始 isHealthy()
isHealthy() {
  return this._cache.size < this._maxSize;
}
```

`withShutdown` 内部处理逻辑：若类已有 `isHealthy()` 且不等于 Mixin 版本，则包装为 `this._shutDown ? false : originalIsHealthy.call(this)`。

#### 第5步：应用 withShutdown 并导出

```javascript
module.exports = withShutdown(MyModule);
```

#### 第6步：处理自定义 shutdown 流程（如 GoalExecutor）

若模块需要自定义关闭流程（如等待活跃任务完成），覆盖 `shutdown()` 方法并在其中调用 Mixin 版本：

```javascript
const _mixinShutdown = GoalExecutor.prototype.shutdown;
GoalExecutor.prototype.shutdown = function shutdown(signal) {
  this._shuttingDown = true;
  return this._waitForActiveTasks()
    .then(() => {
      this._shuttingDown = false;
      _mixinShutdown.call(this, signal);
    })
    .catch(() => {
      this._shuttingDown = false;
      _mixinShutdown.call(this, signal);
    });
};
```

#### 第7步：更新测试

- 移除对 `shutdown()` 内部 `emit('shutdown')` 和 `removeAllListeners()` 的直接测试（由 Mixin 保证）
- 保留对 `_onShutdown()` 清理逻辑的测试
- 新增 `guardShutdown()` 抛出正确错误类型的测试

## 注意事项和已知限制

### _onShutdown 中抛异常的影响

`shutdown()` 方法不捕获 `_onShutdown()` 抛出的异常。若 `_onShutdown()` 抛出异常：

- `_shutDown` 已被设为 `true`，模块处于已关闭状态
- 后续的 `emit('shutdown')` 和 `removeAllListeners()` **不会执行**
- 模块进入不一致状态：已关闭但监听器未清理

**最佳实践**：`_onShutdown()` 内部应自行 try-catch，确保清理逻辑不会因异常而中断：

```javascript
_onShutdown() {
  try {
    clearInterval(this._timer);
    this._cache.clear();
  } catch (err) {
    debug('MyModule', '_onShutdown', err);
  }
}
```

### 多继承场景

ShutdownMixin 使用 `Object.assign(Klass.prototype, ShutdownMixin)` 混入，存在以下限制：

- **原型链覆盖**：若父类和子类都应用 `withShutdown`，子类的 Mixin 方法会覆盖父类的
- **不支持多重混入冲突**：若另一个 Mixin 也定义了 `shutdown()` 方法，后应用的会覆盖先应用的
- **_onShutdown 调用链**：Mixin 只调用 `this._onShutdown()`，不会自动调用父类的 `_onShutdown()`。子类需手动调用 `super._onShutdown()` 或在自身 `_onShutdown()` 中显式调用

### 幂等性保证

`shutdown()` 是幂等的：多次调用仅第一次生效。通过 `_shutDown || _shuttingDown` 双重检查实现：

- `_shuttingDown` 防止并发重入（如信号处理和手动关闭同时触发）
- `_shutDown` 确保关闭后不再执行任何操作

### _initShutdownState 懒初始化

`isHealthy()` 和 `guardShutdown()` 首次调用时会触发 `_initShutdownState()`，将 `_shutDown` 和 `_shuttingDown` 初始化为 `false`。这是为了兼容未在构造函数中初始化这些属性的类。

### waitForShutdown() 的 Promise 行为

- 若 `_onShutdown()` 返回 Promise，`waitForShutdown()` 返回该 Promise
- 若 `_onShutdown()` 返回非 Promise 或未定义，`waitForShutdown()` 返回 `Promise.resolve()`
- `shutdown()` 本身是同步方法，不等待异步 `_onShutdown()` 完成

## 与其他关闭机制的协调

### 与 SignalPersistence 的集成

`SignalPersistence`（`src/runtime/infrastructure/signal-persistence.js`）负责处理进程信号（SIGTERM/SIGINT）并触发优雅关闭。其与 ShutdownMixin 的协调流程：

1. SignalPersistence 接收到 SIGTERM/SIGINT 信号
2. SignalPersistence 触发 `lifecycle` 的 `shutdown` 事件
3. 各模块通过 `lifecycle.on('shutdown', _onShutdown)` 响应
4. 模块调用自身的 `shutdown()` 方法（由 ShutdownMixin 提供）
5. ShutdownMixin 执行 `_onShutdown()` → `emit('shutdown')` → `removeAllListeners()`

### 优雅关闭流程

完整的优雅关闭流程涉及多个组件的协调：

```
进程信号 (SIGTERM/SIGINT)
  → SignalPersistence 捕获信号
    → lifecycle.emit('shutdown')
      → 各模块依次 shutdown()
        → _onShutdown() 执行清理
          → emit('shutdown') 通知下游
            → removeAllListeners() 释放引用
```

### 关闭顺序原则

- **先关闭上层模块**：GoalExecutor 先暂停活跃目标，再关闭自身
- **后关闭基础设施**：SqliteStore、EventBus 等基础模块最后关闭
- **反向依赖关闭**：被依赖的模块后关闭，依赖方先关闭

### 与 GoalExecutor 自定义关闭的协调

GoalExecutor 覆盖了 `shutdown()` 方法，在 Mixin 的 `shutdown()` 之前等待活跃目标完成：

1. 设置 `_shuttingDown = true`，阻止新目标执行
2. 等待活跃循环 Promise 完成（`Promise.allSettled`）
3. 轮询等待 `_executingGoals` 清空（超时 `SHUTDOWN_WAIT_TIMEOUT_MS`）
4. 调用 `_mixinShutdown.call(this, signal)` 执行标准 Mixin 关闭流程

这种模式可作为其他需要等待异步操作完成的模块的参考实现。

## 常见Bug模式（v2.15.0–v2.20.0审计发现）

v2.15.0–v2.20.0对全部withShutdown模块进行系统性审计，发现以下高频Bug模式。新增模块或修改_onShutdown时应对照检查。

### 1. shutdown()覆盖混入方法

**问题**：类定义`shutdown()`方法会被`withShutdown`混入覆盖，导致清理逻辑丢失。

**错误示例**：
```javascript
class MyModule extends EventEmitter {
  shutdown() {  // ← 被withShutdown覆盖，清理逻辑丢失
    this._cache.clear();
  }
}
withShutdown(MyModule);
```

**正确做法**：使用`_onShutdown()`代替。
```javascript
class MyModule extends EventEmitter {
  _onShutdown() {  // ← Mixin会调用此钩子
    this._cache.clear();
  }
}
withShutdown(MyModule);
```

### 2. safeCall()误用

**问题**：`safeCall()`不返回值，`return safeCall(fn, ...)`始终返回undefined。

**错误示例**：
```javascript
_connectMCP() {
  return safeCall(() => this._mcpClient.connect());  // ← 始终返回undefined
}
```

**正确做法**：需要返回值时使用`safeExecute()`。
```javascript
_connectMCP() {
  return safeExecute(() => this._mcpClient.connect());  // ← 返回实际结果
}
```

### 3. _onShutdown()缺少removeAllListeners()

**问题**：对于有异步清理的类，若不在`_onShutdown()`开头调用`removeAllListeners()`，关闭期间事件仍可触发，导致回调操作已关闭的资源。

**正确做法**：在`_onShutdown()`开头调用`removeAllListeners()`防止关闭期间事件触发。
```javascript
_onShutdown() {
  this.removeAllListeners();  // ← 先移除监听器
  // 再执行其他清理
  this._cache.clear();
}
```

> 注：Mixin的`shutdown()`流程会在`_onShutdown()`之后再次调用`removeAllListeners()`，因此不会重复。在`_onShutdown()`中提前调用是为了防止清理过程中事件触发。

### 4. BoundedMap/BoundedArray清理

**问题**：调用`clear()`仅清空数据，不会设置内部`_shutDown`标志，后续操作仍可写入已关闭的容器。

**错误示例**：
```javascript
_onShutdown() {
  this._cache.clear();  // ← _shutDown标志未设置
}
```

**正确做法**：调用`shutdown()`确保内部`_shutDown`标志正确设置。
```javascript
_onShutdown() {
  this._cache.shutdown();  // ← 设置_shutDown + 清空数据
}
```

### 5. 子组件未调用shutdown()

**问题**：在`_onShutdown()`中仅将子组件引用置null，未调用其`shutdown()`，导致子组件资源泄漏。

**错误示例**：
```javascript
_onShutdown() {
  this._subModule = null;  // ← 子组件未关闭，资源泄漏
}
```

**正确做法**：先调用子组件的`shutdown()`（用`safeCall`包裹），再置null。
```javascript
_onShutdown() {
  safeCall(() => this._subModule.shutdown());
  this._subModule = null;
}
```

### 6. guardShutdown()遗漏

**问题**：所有修改状态的公共方法都应添加`guardShutdown()`，否则shutdown后仍可修改状态。`getStats()`等读方法应使用try-catch模式返回默认零值。

**正确做法**：
```javascript
// 修改状态的方法：直接调用guardShutdown()
async executeTask(task) {
  this.guardShutdown();  // ← 已关闭则抛出错误
  // ...
}

// 读方法：try-catch返回默认值
getStats() {
  try {
    this.guardShutdown();
  } catch (_) {
    return { ops: 0, errors: 0 };  // ← 返回默认零值
  }
  // ...
}
```

### 7. Promise链式锁损坏（v2.17.0新增）

**问题**：使用Promise链实现互斥锁时，若回调抛出异常，锁变为rejected Promise，后续所有操作永久失败。

**错误示例**：
```javascript
_withOperationLock(fn) {
  this._lock = this._lock.then(() => fn()).catch((err) => { throw err; });
  // ← fn()抛异常后，_lock变为rejected，后续.then()全部跳过
  return this._lock;
}
```

**正确做法**：在链首添加`.catch(() => {})`恢复机制。
```javascript
_withOperationLock(fn) {
  this._lock = this._lock.catch(() => {}).then(() => fn()).catch((err) => {
    throw err;
  });
  return this._lock;
}
```

### 8. EventBus重写emit()阻止shutdown事件（v2.17.0新增）

**问题**：EventBus重写`emit()`在开头调用`guardShutdown()`，但Mixin的`shutdown()`先设`_shutDown=true`再`emit('shutdown')`，导致shutdown事件永远无法发出。

**正确做法**：在EventBus.emit()中对'shutdown'事件做特殊豁免。
```javascript
emit(event, data) {
  if (event !== 'shutdown') this.guardShutdown();
  // ... 其余逻辑
}
```

### 9. 异步方法await后未重检关闭状态（v2.17.0新增）

**问题**：async方法在入口处调用`guardShutdown()`，但await期间shutdown可能发生，方法继续执行后续逻辑（emit事件、修改stats等）。

**正确做法**：在await返回后、修改状态前重新检查关闭状态。
```javascript
async executeComposition(id) {
  this.guardShutdown();
  const result = await this._executeStrategy(strategy);  // await期间可能shutdown
  if (this._shutDown) return { passed: false, reason: 'Shut down during execution' };
  this.emit('completed', result);  // 安全地emit
}
```

### 10. BoundedMap.set(id, undefined)代替delete(id)（v2.17.0新增）

**问题**：使用`map.set(id, undefined)`标记删除，但`has(id)`仍返回true，缓存空间被无效条目占用。

**正确做法**：使用`map.delete(id)`真正删除条目。
```javascript
// 错误
this._cache.set(id, undefined);  // has(id)仍为true

// 正确
this._cache.delete(id);  // 真正删除
```

### 11. LRU淘汰逻辑在更新时多删条目（v2.17.0新增）

**问题**：Map满载时更新已有key，先检查容量淘汰一条，再delete+set该key，导致多淘汰一条记录。

**正确做法**：先判断key是否已存在，仅当key不存在且容量已满时才淘汰。
```javascript
const keyExists = this._map.has(key);
if (!keyExists && this._map.size >= maxSize) {
  // 淘汰最旧条目
}
this._map.delete(key);
this._map.set(key, value);
```

### 12. stop()方法中_shutDown检查阻止_onShutdown清理（v2.18.0新增）

**问题**：`stop()`方法在开头检查`if (this._shutDown) return;`，而`_onShutdown()`调用`this.stop()`。由于withShutdown mixin先设`_shutDown=true`再调用`_onShutdown()`，`stop()`直接返回，清理逻辑（如`clearInterval`）永远不执行。

**影响**：定时器/资源泄漏。

**修复**：`_onShutdown()`中直接执行清理逻辑，不依赖`stop()`方法。

```javascript
// 错误
_onShutdown() {
  this.stop(); // _shutDown已为true，stop()直接返回
}

// 正确
_onShutdown() {
  if (this._timer) { clearInterval(this._timer); this._timer = null; }
}
```

### 13. 拓扑排序入度计算对源节点而非目标节点累加（v2.20.0新增）

**问题**：遍历正向邻接表`from -> [to1, to2, ...]`时，对每条边应增加`to`的入度，但代码增加的是`from`的入度。

**影响**：依赖解析功能完全失效，拓扑排序结果错误。

**修复**：`inDegree.set(from, ...)` → `inDegree.set(_to, ...)`。

### 14. reset()方法重置_shutDown标志导致竞态条件（v2.20.0新增）

**问题**：`reset()`直接设置`this._shutDown = false`，若异步`_onShutdown()`仍在执行中，其他调用者会认为实例健康并开始新操作。

**修复**：在`reset()`开头添加`if (this._shuttingDown) throw new Error('Cannot reset during shutdown');`。

### 15. 模块级BoundedMap/BoundedArray共享状态泄漏（v2.20.0新增）

**问题**：模块顶层定义`const _cache = new BoundedMap(200)`，所有实例共享。任一实例关闭时无法单独清理此缓存；所有实例关闭后缓存仍驻留内存。

**修复**：改为实例级属性`this._cache = new BoundedMap(200)`，在`_onShutdown()`中调用`this._cache.shutdown()`。

### 16. safeCall误用导致异步返回值丢失（v2.20.0新增）

**问题**：`safeCall(fn, label, action)`不返回`fn()`的结果。当用于捕获异步返回值时（如`const result = await safeCall(() => adapter.executeAction(...))`），`result`始终为`undefined`。

**影响**：功能完全失效（如浏览器侦察阶段截图/数据永远为undefined）。

**修复**：需要返回值时使用`safeExecute(fn, label, action, fallbackValue)`。

```javascript
// 错误
const screenshot = await safeCall(() => adapter.takeScreenshot(), 'Module', 'action');

// 正确
const screenshot = await safeExecute(() => adapter.takeScreenshot(), 'Module', 'action');
```

### 17. 冗余removeAllListeners()调用（v2.20.0新增）

**问题**：`_onShutdown()`中显式调用`this.removeAllListeners()`，但ShutdownMixin的`shutdown()`方法在`finalize()`中已经调用。冗余调用虽无害但增加维护成本。

**修复**：移除`_onShutdown()`中的`this.removeAllListeners()`，依赖mixin的`finalize()`统一处理。

### 18. 冗余_shutDown=false初始化（v2.20.0新增）

**问题**：构造函数中显式设置`this._shutDown = false`，但withShutdown mixin通过`_initShutdownState()`懒初始化已处理。冗余初始化表明开发者不了解mixin的初始化逻辑。

**修复**：移除构造函数中的`this._shutDown = false;`。

### 19. getStats()吞没shutdown错误返回误导性默认值（v2.20.0新增）

**问题**：`getStats()`将`guardShutdown()`包裹在try-catch中，捕获关闭错误后返回全零默认统计。这些默认值看起来像"从未使用过"的有效统计，而非错误指示，可能误导监控仪表盘。

**修复**：直接调用`this.guardShutdown();`让关闭错误正常传播，或返回明确标识关闭状态的值如`{ shutDown: true }`。

### 20. _stats对象未初始化导致运行时TypeError（v2.29.0新增）

**问题**：构造函数中未初始化`this._stats`对象，但`_restore()`等方法中引用`this._stats.errors++`等属性。`undefined.errors++`抛出TypeError。

**修复**：在构造函数中添加完整初始化：`this._stats = { requested: 0, approved: 0, rejected: 0, revoked: 0, expired: 0, errors: 0 };`

### 21. isHealthy()过于严格破坏队列功能（v2.29.0新增）

**问题**：`isHealthy()`返回`!this._shutDown && this._running.size <= this._max && this._queue.length === 0`，当有活跃操作或队列项时返回false。但`isHealthy()`的语义应仅反映关闭状态，不应包含业务逻辑判断。

**修复**：简化为`isHealthy() { return !this._shutDown; }`

### 22. shutdown()覆盖中使用_shuttingDown=false重置（v2.29.0新增）

**问题**：自定义`shutdown()`覆盖中，等待循环Promise排空后重置`_shuttingDown=false`，再调用`_mixinShutdown`。在重置到mixin调用之间，其他代码可能误判实例未在关闭中。

**修复**：不重置`_shuttingDown`，让mixin自行管理关闭状态。

### 23. _onShutdown()完全遗漏BoundedArray清理（v2.29.0新增）

**问题**：`_onShutdown()`清理了Map和Set，但完全遗漏了BoundedArray/BoundedMap类型的属性。这些数据结构不会被垃圾回收（持有内部_buffer/_map引用），且后续访问不会触发guardShutdown保护。

**修复**：在`_onShutdown()`中为每个BoundedMap/BoundedArray属性调用`.shutdown()`，包裹在`safeCall()`中。

### 24. acquireLock()等关键方法使用if(this._shutDown)而非guardShutdown()（v2.29.0新增）

**问题**：安全关键方法（如`acquireLock()`、`checkCommand()`）使用`if (this._shutDown) return false;`软检查而非`guardShutdown()`。这是check-then-act竞态条件，且调用方无法区分"操作失败"和"对象已关闭"。

**修复**：替换为`this.guardShutdown();`，让关闭错误正常传播。

### 25. _onShutdown定义但withShutdown未应用（死代码）（v2.34.0新增）

**问题**：类在原型上定义了`_onShutdown()`方法，但模块导出时未使用`withShutdown()`包装。`_onShutdown()`永远不会被调用，关闭逻辑完全失效。类中手动检查`this._shutDown`标志，但该标志只能在`_onShutdown`中设置，形成循环依赖。

**修复**：使用`module.exports = withShutdown(ClassName);`导出，移除手动`_shutDown`检查，改用`guardShutdown()`。

### 26. shutdownAsync()方法绕过mixin生命周期（v2.34.0新增）

**问题**：自定义`shutdownAsync()`方法直接设置`this._shutDown = true`，绕过了mixin的`shutdown()`方法。导致：(1)不触发`emit('shutdown')`事件；(2)不调用`finalize()`中的`removeAllListeners()`；(3)不设置`_shutdownPromise`，`waitForShutdown()`无法正确等待。

**修复**：删除`shutdownAsync()`，将异步逻辑移入`_onShutdown()`（返回Promise），调用者使用`shutdown()` + `await waitForShutdown()`。

### 27. shutdown()覆盖而非使用_onShutdown()模式（v2.34.0新增）

**问题**：在`withShutdown()`混入之后，通过保存`_mixinShutdown`引用并重新赋值`prototype.shutdown`来覆盖。这种模式脆弱——若mixin实现变更，覆盖逻辑将失效。

**修复**：将自定义逻辑移入`_onShutdown()`，删除`shutdown()`覆盖。

### 28. 一致性检查方法关闭时返回consistent:true（v2.34.0新增）

**问题**：`checkRuntimeVsStatic()`等方法在关闭时返回`{consistent: true, issues: [], reason: 'shut_down'}`。关闭后返回`consistent: true`语义错误——已关闭的实例不应报告"一致"，会误导调用者认为检查已通过。

**修复**：使用`guardShutdown()`让关闭状态正确抛出异常。

### 29. 直接检查_shutDown绕过_initShutdownState()（v2.34.0新增）

**问题**：方法使用`if (this._shutDown)`直接检查私有属性，而非`isHealthy()`或`guardShutdown()`。`_shutDown`可能为`undefined`（未初始化），导致检查被跳过。mixin的`isHealthy()`会先调用`_initShutdownState()`确保初始化。

**修复**：将`if (this._shutDown)`替换为`if (!this.isHealthy())`或`guardShutdown()`。

### 30. MoeGatingRouter等模块在module-initializer中引用但缺少require导入（v2.38.0新增）

**问题**：`module-initializer.js`的`MODULE_REGISTRY`数组引用了`MoeGatingRouter`等类，但文件顶部缺少对应的`require()`导入。运行时抛出`ReferenceError: MoeGatingRouter is not defined`，导致整个框架无法加载。

**修复**：在`module-initializer.js`顶部添加缺失的`require()`导入。

### 31. _doDisconnect()中使用BoundedMap.clear()而非shutdown()（v2.38.0新增）

**问题**：`_doDisconnect()`方法（如VideoProvider、PresentationProvider）调用`this._taskCache.clear()`，而同类的`_onShutdown()`正确使用`shutdown()`。disconnect后如果对象被重新使用，clear()后的BoundedMap仍可操作，但shutdown()后的BoundedMap会正确拒绝操作。

**修复**：在`_doDisconnect()`中也使用`shutdown()`，或如果disconnect后需要重用，添加注释说明使用`clear()`的原因。

### 32. _onShutdown()中将内部索引设为null导致后续访问TypeError（v2.38.0新增）

**问题**：`_onShutdown()`中将`this._subjectIndex = null`等内部数据结构置null。如果shutdown后有方法被调用（即使有`guardShutdown()`保护，但部分方法缺失），对这些null属性的访问会抛出`TypeError: Cannot read property 'xxx' of null`，而非友好的"shut down"错误。

**修复**：将`= null`改为`= new Map()`/`= {}`等空值，或确保所有公共方法都有`guardShutdown()`保护。

## 相关文档

- [[核心功能-优雅关闭流程]]
- [[模块详解-SignalPersistence信号持久化]]
- [[模块详解-SessionManager会话管理]]
- [[模块详解-GoalExecutor目标执行器]]
