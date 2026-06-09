# 模块详解-Hook组合器

> 版本：2.73.4 | 文件：src/runtime/infrastructure/../workflow/hook-composer.js | 行数：~226行

---

## 模块定位

HookComposer是Hook组合器，基于EventEmitter扩展，是工作流子系统的Hook组合组件。它支持将多个Hook组合为可复用的Meta-Hook单元，提供顺序执行、并行执行和条件分支三种组合策略，解决了Hook无法组合复用的空白。该模块融合了Claude Code扩展功能的Hook组合机制，使复杂的Hook编排成为可能。

## 设计理念

Claude Code扩展通过Hook机制实现事件驱动的自动化，但单个Hook的能力有限，无法表达复杂的编排逻辑。HookComposer通过引入组合概念，实现：

- **顺序组合**：Hook按顺序依次执行，任一失败则中止
- **并行组合**：多个Hook同时执行，收集所有结果
- **条件分支**：根据上下文条件决定是否执行特定Hook
- **失败策略**：支持停止、继续和回退三种失败处理方式
- **Meta-Hook**：组合后的Hook单元可作为一个整体被引用和执行

## 类定义

```javascript
class HookComposer extends EventEmitter {
  constructor(hookExecutor, config)
  createComposition(compositionId, options)
  executeComposition(compositionId, context)
  getComposition(compositionId)
  listCompositions()
  removeComposition(compositionId)
  getStats()
  shutdown() // via withShutdown mixin
  isHealthy()
}
```

## 构造函数

### `constructor(hookExecutor, config)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `hookExecutor` | object | 是 | Hook执行器实例，需提供`execute(event, context)`方法 |
| `config` | object | 否 | 配置选项 |
| `config.maxCompositions` | number | 否 | 最大组合数量，默认50 |
| `config.maxHooksPerComposition` | number | 否 | 每个组合最大Hook数，默认10 |
| `config.compositionTimeoutMs` | number | 否 | 组合执行超时时间（毫秒），默认30000 |

初始化内部状态：
- `_hookExecutor` — Hook执行器引用
- `_compositions` — Map，compositionId → 组合定义
- `_stats` — 统计信息

## 公开方法详解

### `createComposition(compositionId, options)`

创建新的Hook组合。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `compositionId` | string | 是 | 组合标识符，非空字符串 |
| `options` | object | 否 | 组合选项 |
| `options.name` | string | 否 | 显示名称，默认为compositionId |
| `options.description` | string | 否 | 描述 |
| `options.strategy` | string | 否 | 组合策略，默认`SEQUENTIAL` |
| `options.hooks` | Array | 否 | Hook列表，每项包含`event`、`action`、`condition?`、`timeout?` |
| `options.onFailure` | string | 否 | 失败策略：`'stop'`（默认）、`'continue'`、`'fallback'` |
| `options.fallbackHook` | object | 否 | 回退Hook定义，onFailure为`'fallback'`时使用 |

**返回值**：`object` — 创建的组合定义

**行为细节**：
- compositionId已存在时抛出Error
- 组合数量达到`maxCompositions`时抛出Error
- 策略无效时抛出Error
- Hook数量超过`maxHooksPerComposition`时抛出Error
- 每个Hook条目自动添加`order`字段
- 触发`composition-created`事件

**Hook条目格式**：

```javascript
{
  event: string,        // 触发事件名
  action: string,      // 动作标识
  order: number,       // 自动分配的顺序
  condition: Function | string | null,  // 执行条件
  timeout: number | null,               // 超时时间
}
```

### `executeComposition(compositionId, context)`

执行指定组合。根据组合策略执行所有Hook。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `compositionId` | string | 是 | 组合标识符 |
| `context` | object | 是 | 执行上下文 |

**返回值**：`Promise<object>` — 执行结果

```javascript
{
  passed: boolean,       // 是否全部通过
  reason: string,        // 失败原因（如有）
  results: Array,        // 各Hook执行结果
  failedAt: string,      // 失败的Hook action（如有）
  continued: boolean,    // 是否继续执行（onFailure=continue时）
  duration: number,      // 执行耗时（毫秒）
}
```

**行为细节**：
- 组合不存在时抛出Error
- HookExecutor未注入时抛出Error
- 根据策略调用不同的执行方法
- 关闭期间中断执行并返回`{passed: false, reason: 'Shut down during execution'}`
- 触发`composition-started`、`composition-completed`或`composition-failed`事件

**失败处理策略**：
- `stop`：失败时抛出异常
- `continue`：失败时返回`{passed: false, continued: true}`
- `fallback`：失败时执行`fallbackHook`

### `getComposition(compositionId)`

获取组合定义。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `compositionId` | string | 是 | 组合标识符 |

**返回值**：`object | null`

### `listCompositions()`

列出所有组合摘要。

**返回值**：`Array<{id, name, strategy, hookCount}>`

### `removeComposition(compositionId)`

移除组合。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `compositionId` | string | 是 | 组合标识符 |

**返回值**：`boolean` — 存在并移除返回true，否则返回false

**行为细节**：
- 触发`composition-removed`事件

### `getStats()`

获取统计信息。

**返回值**：

```javascript
{
  compositionsCreated: number,
  compositionsExecuted: number,
  compositionsFailed: number,
  totalHooksComposed: number,
  totalCompositions: number,
}
```

## 组合策略详解

### 顺序执行（SEQUENTIAL）

Hook按定义顺序依次执行。任一Hook失败且`onFailure`为`'stop'`时，中止后续执行并返回失败结果。

```javascript
// 执行流程: Hook1 → Hook2 → Hook3
// Hook2失败时: Hook1结果 + 失败信息
```

### 并行执行（PARALLEL）

所有Hook同时执行，使用`Promise.all`收集结果。任一Hook失败不影响其他Hook执行。

```javascript
// 执行流程: Hook1 ─┐
//           Hook2 ─┤→ 收集所有结果
//           Hook3 ─┘
```

### 条件分支（CONDITIONAL）

逐个检查Hook的条件，条件满足时执行。条件可以是函数或上下文字段名。

```javascript
// 条件为函数: condition(context) → boolean
// 条件为字符串: context[condition] → truthy/falsy
```

## 导出常量

### COMPOSITION_STRATEGIES

组合策略枚举。

| 属性 | 值 | 说明 |
|------|---|------|
| `SEQUENTIAL` | `'sequential'` | 顺序执行，任一失败则中止 |
| `PARALLEL` | `'parallel'` | 并行执行，收集所有结果 |
| `CONDITIONAL` | `'conditional'` | 条件分支，根据条件选择执行路径 |

## 事件列表

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `composition-created` | 组合创建 | `{compositionId, strategy, hookCount}` |
| `composition-started` | 组合开始执行 | `{compositionId, strategy}` |
| `composition-completed` | 组合执行完成 | `{compositionId, passed, duration}` |
| `composition-failed` | 组合执行失败 | `{compositionId, error}` |
| `composition-removed` | 组合移除 | `{compositionId}` |

## 使用示例

### 顺序组合

```javascript
const { HookComposer, COMPOSITION_STRATEGIES } = require('./src/runtime/workflow/hook-composer');

const composer = new HookComposer(hookExecutor, {
  maxCompositions: 50,
  maxHooksPerComposition: 10,
});

// 创建顺序组合
composer.createComposition('pre-commit-checks', {
  name: '提交前检查',
  strategy: COMPOSITION_STRATEGIES.SEQUENTIAL,
  hooks: [
    { event: 'pre-commit', action: 'lint-check' },
    { event: 'pre-commit', action: 'type-check' },
    { event: 'pre-commit', action: 'test-check' },
  ],
  onFailure: 'stop',
});

// 执行
const result = await composer.executeComposition('pre-commit-checks', {
  files: ['src/index.js'],
  branch: 'feature/new-api',
});
console.log('检查结果:', result.passed ? '通过' : '失败');
```

### 并行组合

```javascript
composer.createComposition('parallel-analysis', {
  name: '并行分析',
  strategy: COMPOSITION_STRATEGIES.PARALLEL,
  hooks: [
    { event: 'analyze', action: 'security-scan' },
    { event: 'analyze', action: 'performance-check' },
    { event: 'analyze', action: 'dependency-audit' },
  ],
  onFailure: 'continue',
});

const result = await composer.executeComposition('parallel-analysis', context);
for (const r of result.results) {
  console.log(`${r.action}: ${r.passed ? '通过' : r.reason}`);
}
```

### 条件分支

```javascript
composer.createComposition('conditional-deploy', {
  name: '条件部署',
  strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
  hooks: [
    { event: 'deploy', action: 'staging-deploy', condition: 'isStaging' },
    { event: 'deploy', action: 'production-deploy', condition: 'isProduction' },
    { event: 'deploy', action: 'notify-team', condition: (ctx) => ctx.notifyEnabled },
  ],
  onFailure: 'fallback',
  fallbackHook: { event: 'deploy', action: 'rollback' },
});

const result = await composer.executeComposition('conditional-deploy', {
  isProduction: true,
  notifyEnabled: true,
});
```

### 事件监听

```javascript
composer.on('composition-started', ({ compositionId, strategy }) => {
  console.log(`组合开始执行: ${compositionId} (${strategy})`);
});

composer.on('composition-completed', ({ compositionId, passed, duration }) => {
  console.log(`组合完成: ${compositionId}, 结果: ${passed}, 耗时: ${duration}ms`);
});

composer.on('composition-failed', ({ compositionId, error }) => {
  console.error(`组合失败: ${compositionId}, 错误: ${error}`);
});
```

## 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxCompositions` | number | 50 | 最大组合数量 |
| `maxHooksPerComposition` | number | 10 | 每个组合最大Hook数 |
| `compositionTimeoutMs` | number | 30000 | 组合执行超时时间（毫秒） |

## 与其他模块的关系

- **依赖**：`events`（Node.js内置） — EventEmitter基类
- **依赖**：`../../utils/shutdown-mixin.js` — 优雅关闭
- **依赖**：HookExecutor — Hook执行器，需提供`execute(event, context)`方法
- **协作**：ContextBudgetOptimizer — Hook组合加载时检查上下文预算配额（HOOKS层）
- **协作**：EventBus — 通过事件总线发布组合生命周期事件
- **协作**：WorkflowEngine — 工作流引擎可使用HookComposer编排复杂的工作流阶段
- **被依赖**：SharedInfrastructure — 作为工作流子系统的Hook编排组件

## 相关文档

- [模块详解-EventBus模块](模块详解-EventBus模块.md)
- [模块详解-上下文预算优化器](模块详解-上下文预算优化器.md)
- [模块详解-动态Agent生成器](模块详解-动态Agent生成器.md)
