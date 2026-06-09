# 模块详解-StateGraph状态图引擎

> 版本：2.73.4 | 文件：src/runtime/workflow/state-graph.js

## 概述

StateGraph 位于 `src/runtime/workflow/state-graph.js`，是框架的状态图执行引擎，灵感来自 LangGraph。支持类型化节点（函数节点/子图节点/并行节点）、条件边（基于状态的动态路由）、Checkpoint 持久化、并行执行、循环支持、中断与恢复、节点元数据和生命周期钩子。用于编排复杂的多阶段工作流，如六阶段执行流程和子任务调度。

## 核心特性

- **多种节点类型**：函数节点（同步/异步）、子图节点（嵌套 StateGraph）、并行节点（Promise.all 语义）
- **条件边**：基于当前状态动态路由到不同节点，条件边优先于普通边
- **Checkpoint 持久化**：每个状态转换自动保存 Checkpoint，支持从任意 Checkpoint 恢复执行
- **并行执行**：多个处理器同时执行，支持 shallow/deep/last-wins 三种合并策略
- **循环支持**：允许在图中定义回环路径，通过 `maxIterations` 防止无限循环
- **原型污染防护**：last-wins 合并策略过滤 `__proto__`、`constructor`、`prototype` 键
- **生命周期钩子**：beforeNode/afterNode/onError 三个钩子点
- **节点元数据**：支持 complexity、requiredSkills 等元数据标记

## 类定义

```javascript
class StateGraph
```

导出为：

```javascript
module.exports = { StateGraph }
```

## 常量

StateGraph 没有模块级常量，所有配置通过构造函数参数传入。

### 默认值

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxIterations` | 50 | 最大迭代次数（防无限循环） |
| `autoCheckpoint` | true | 是否自动保存 Checkpoint |
| `maxCheckpoints` | 100 | 内存中 Checkpoint 数组最大长度 |

## 构造函数

```javascript
new StateGraph(options?)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.initialState` | GraphState | `{}` | 初始状态 |
| `options.checkpointStore` | Object | null | Checkpoint 持久化存储，需实现 `save`/`load`/`list` 方法 |
| `options.maxIterations` | number | 50 | 最大迭代次数（防无限循环） |
| `options.autoCheckpoint` | boolean | true | 是否自动保存 Checkpoint |
| `options.hooks` | Object | `{}` | 生命周期钩子 `{beforeNode, afterNode, onError}` |

## 核心 API

### 节点操作

| 方法 | 签名 | 说明 |
|------|------|------|
| `addNode` | `addNode(name, handler, meta?) → this` | 添加节点，handler 为函数或子图 StateGraph，第一个添加的节点自动成为入口 |
| `addParallelNode` | `addParallelNode(name, handlers, options?) → this` | 添加并行节点，多个处理器同时执行，结果按合并策略合并 |
| `setNodeMeta` | `setNodeMeta(name, meta) → this` | 设置节点元数据 |
| `getNodeMeta` | `getNodeMeta(name) → NodeMetadata\|undefined` | 获取节点元数据（副本） |

### 边操作

| 方法 | 签名 | 说明 |
|------|------|------|
| `addEdge` | `addEdge(from, to) → this` | 添加普通边（无条件连接） |
| `addConditionalEdges` | `addConditionalEdges(from, condition) → this` | 添加条件边，condition 函数返回目标节点名或 null（终止） |
| `setEntryPoint` | `setEntryPoint(name) → this` | 设置入口节点 |

### 执行

| 方法 | 签名 | 说明 |
|------|------|------|
| `compile` | `compile(entryPoint?) → Function` | 编译可执行图，返回 `(state, context?) → Promise<GraphState>` |
| `invoke` | `invoke(initialState?, context?) → Promise<GraphState>` | 直接执行图（等同于 `compile()()`） |

### Checkpoint

| 方法 | 签名 | 说明 |
|------|------|------|
| `resume` | `resume() → Promise<Checkpoint\|null>` | 从最近的 Checkpoint 恢复状态 |
| `getCheckpoints` | `getCheckpoints() → Checkpoint[]` | 获取所有已保存的 Checkpoint |

### 查询

| 方法 | 签名 | 说明 |
|------|------|------|
| `getNodes` | `getNodes() → string[]` | 获取节点名称列表 |
| `getEdges` | `getEdges() → GraphEdge[]` | 获取边列表 |
| `getConditionalEdges` | `getConditionalEdges() → Object[]` | 获取条件边列表 |

### addNode() 参数详情

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | string | 节点名称（必填） |
| `handler` | Function\|StateGraph | 节点处理器 `(state, context) => newState` 或子图 StateGraph 实例 |
| `meta` | NodeMetadata | 节点元数据（可选） |

### addParallelNode() 参数详情

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | string | 节点名称（必填） |
| `handlers` | Array\<Function\|StateGraph\> | 并行处理器数组（必填，非空） |
| `options.mergeStrategy` | string | 合并策略：`'shallow'`（默认）/ `'deep'` / `'last-wins'` |
| `options.meta` | NodeMetadata | 节点元数据 |

### GraphState 类型定义

| 字段 | 类型 | 说明 |
|------|------|------|
| `phase` | string | 当前阶段名称 |
| `meta` | Object | 附加元数据 |
| `iteration` | number | 迭代计数 |
| `_currentNode` | string | 当前节点名（内部） |
| `_graphComplete` | boolean | 显式标记图完成（设为 true 时终止执行） |

### Checkpoint 类型定义

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | Checkpoint ID |
| `state` | GraphState | 状态快照 |
| `node` | string | 当前节点 |
| `timestamp` | number | 保存时间戳 |
| `metadata` | Object | 额外元数据 |

### NodeMetadata 类型定义

| 字段 | 类型 | 说明 |
|------|------|------|
| `complexity` | string | 节点复杂度 `'low'`/`'medium'`/`'high'` |
| `requiredSkills` | string[] | 依赖的技能 ID 列表 |
| `config` | Object | 节点配置 |

## 事件

StateGraph 不继承 EventEmitter，生命周期钩子通过构造函数 `options.hooks` 配置：

| 钩子 | 签名 | 触发时机 |
|------|------|---------|
| `beforeNode` | `beforeNode(nodeName, state, context)` | 节点执行前 |
| `afterNode` | `afterNode(nodeName, state, context)` | 节点执行后 |
| `onError` | `onError(nodeName, error, state, context)` | 节点执行异常时 |

## 合并策略

并行节点支持三种结果合并策略：

### shallow（默认）

浅合并：首个处理器结果中的键优先，后续处理器仅填充尚未存在的键。

```javascript
// 结果: {a: 1, b: 2}（b 来自第二个处理器，因为 a 已存在）
[{a: 1}, {b: 2, a: 3}] → {a: 1, b: 2}
```

### deep

深度合并：递归合并嵌套对象，后执行的处理器覆盖同名叶子键。

```javascript
// 递归合并嵌套对象
[{config: {a: 1}}, {config: {b: 2}}] → {config: {a: 1, b: 2}}
```

### last-wins

后覆盖：后执行的处理器完全覆盖同名键，但过滤原型污染键（`__proto__`、`constructor`、`prototype`）。

```javascript
// 后覆盖，但过滤危险键
[{a: 1}, {a: 2, __proto__: {}}] → {a: 2}
```

## 与其他模块的集成

| 模块 | 集成方式 | 说明 |
|------|---------|------|
| PhaseOrchestrator | 作为执行引擎 | 六阶段执行流程的图编排 |
| GoalExecutor | 子任务调度 | 子任务分解后的图执行 |
| CausalWAL | checkpointStore | Checkpoint 持久化存储，需实现 `save`/`load`/`list` 方法 |
| debug-logger | 日志记录 | 条件边异常和 Checkpoint 持久化失败的日志记录 |

### LangGraph 概念映射

| LangGraph 概念 | StateGraph 对应 | 说明 |
|---------------|----------------|------|
| StateGraph | StateGraph | 状态图引擎 |
| Node | 六阶段 + 子任务节点 | 函数/子图/并行节点 |
| Edge | PHASE_TRANSITIONS | 普通边和条件边 |
| ConditionalEdge | 基于复杂度的条件分支 | `addConditionalEdges` |
| Checkpoint | causal-wal 持久化 | `_saveCheckpoint`/`resume` |
| Send API | ParallelNode | `addParallelNode` |

### 执行流程

```
compile(entryPoint?)
  ↓ 返回 invoke 函数
invoke(initialState, context)
  ↓
  ┌─ while (currentNode && iteration < maxIterations)
  │   ├─ beforeNode hook
  │   ├─ executeHandler(handler, state, context)
  │   │   ├─ Function → 调用并 await 结果
  │   │   └─ StateGraph → 递归 invoke
  │   ├─ 合并 nextState 到 state
  │   ├─ afterNode hook
  │   ├─ autoCheckpoint → _saveCheckpoint
  │   └─ resolveNextNode
  │       ├─ state._graphComplete → null（终止）
  │       ├─ state.phase 指向其他节点 → 该节点
  │       ├─ 条件边结果 → 优先
  │       └─ 普通边 → 第一个目标
  └─ return state
```

### 路由优先级

`resolveNextNode` 按以下优先级确定下一个节点：

1. `state._graphComplete === true` → 终止（返回 null）
2. `state.phase` 指向其他已注册节点 → 跳转到该节点
3. 条件边匹配结果 → 第一个匹配节点
4. 普通边 → 第一个目标节点
5. 无任何匹配 → 终止

## 使用示例

### 基本用法：线性流程

```javascript
const { StateGraph } = require('./src/runtime/workflow/state-graph');

const graph = new StateGraph({ initialState: { phase: 'init' } });

graph.addNode('init', (state) => {
  console.log('初始化:', state.phase);
  return { phase: 'process' };
});

graph.addNode('process', (state) => {
  console.log('处理中');
  return { phase: 'done', result: 'ok' };
});

graph.addEdge('init', 'process');

const result = await graph.invoke({ task: 'build' });
// result: { phase: 'done', result: 'ok', task: 'build', iteration: 2 }
```

### 条件边：动态路由

```javascript
const graph = new StateGraph();

graph.addNode('analyze', (state) => {
  return { complexity: state.input.length > 100 ? 'high' : 'low' };
});

graph.addNode('simple-process', (state) => {
  return { result: 'simple' };
});

graph.addNode('deep-process', (state) => {
  return { result: 'deep' };
});

graph.addConditionalEdges('analyze', (state) => {
  return state.complexity === 'high' ? 'deep-process' : 'simple-process';
});

graph.addEdge('simple-process', null); // 终止
graph.addEdge('deep-process', null);

const result = await graph.invoke({ input: 'short' });
```

### 并行节点

```javascript
const graph = new StateGraph();

graph.addParallelNode('parallel-fetch', [
  (state) => Promise.resolve({ users: ['Alice', 'Bob'] }),
  (state) => Promise.resolve({ orders: [1, 2, 3] }),
], { mergeStrategy: 'shallow' });

graph.addNode('aggregate', (state) => {
  return { summary: `${state.users.length} users, ${state.orders.length} orders` };
});

graph.addEdge('parallel-fetch', 'aggregate');

const result = await graph.invoke({});
```

### 子图嵌套

```javascript
const subGraph = new StateGraph();
subGraph.addNode('sub-step-1', (state) => ({ subResult: 'step1' }));
subGraph.addNode('sub-step-2', (state) => ({ subResult: 'step2' }));
subGraph.addEdge('sub-step-1', 'sub-step-2');

const mainGraph = new StateGraph();
mainGraph.addNode('prepare', (state) => ({ ready: true }));
mainGraph.addNode('sub-process', subGraph); // 嵌套子图
mainGraph.addNode('finalize', (state) => ({ done: true }));

mainGraph.addEdge('prepare', 'sub-process');
mainGraph.addEdge('sub-process', 'finalize');

const result = await mainGraph.invoke({});
```

### Checkpoint 持久化与恢复

```javascript
const checkpointStore = {
  _store: new Map(),
  async save(cp) { this._store.set(cp.id, cp); },
  async load(id) { return this._store.get(id); },
  async list() { return Array.from(this._store.values()); },
};

const graph = new StateGraph({
  autoCheckpoint: true,
  checkpointStore,
});

graph.addNode('step1', (state) => ({ step1Done: true }));
graph.addNode('step2', (state) => ({ step2Done: true }));
graph.addEdge('step1', 'step2');

// 执行图（自动保存 Checkpoint）
const result = await graph.invoke({});

// 从最近 Checkpoint 恢复
const checkpoint = await graph.resume();
if (checkpoint) {
  console.log('恢复到节点:', checkpoint.node);
  console.log('状态快照:', checkpoint.state);
}
```

### 生命周期钩子

```javascript
const graph = new StateGraph({
  hooks: {
    beforeNode: (name, state, ctx) => console.log(`[进入] ${name}`),
    afterNode: (name, state, ctx) => console.log(`[完成] ${name}`),
    onError: (name, err, state, ctx) => console.error(`[错误] ${name}: ${err.message}`),
  },
});
```

## 相关文档

- [模块详解-GoalExecutor目标执行器](模块详解-GoalExecutor目标执行器.md)
- [模块详解-PhaseOrchestrator阶段编排器](模块详解-PhaseOrchestrator阶段编排器.md)
- [核心功能-六阶段执行流程](../core/核心功能-六阶段执行流程.md)
- [模块详解-工作流子系统](模块详解-工作流子系统.md)
