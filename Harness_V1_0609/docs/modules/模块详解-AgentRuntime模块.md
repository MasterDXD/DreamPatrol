# 模块详解-AgentRuntime模块

> 版本：2.73.4 | 文件：src/runtime/agent/agent-runtime.js

---

## 模块定位

AgentRuntime是Agent运行时管理器，负责Agent的完整生命周期管理——从创建、启动、停止到销毁。提供Agent状态持久化、自动恢复和资源清理能力。

## 核心能力

| 能力 | 说明 |
|------|------|
| **生命周期管理** | 通过register/unregister/transition管理Agent实例 |
| **状态转换** | 通过transition(agentId, newState, reason)实现状态流转，启动为transition('running')，停止为transition('stopped') |
| **状态持久化** | 通过KeyedDebouncer+writeAtomic自动持久化Agent状态到磁盘 |
| **崩溃恢复** | _restoreAgents()从磁盘恢复Agent状态，自动将RUNNING/INITIALIZING状态重置为STOPPED |
| **事件驱动** | 基于EventEmitter，发射agent-registered/agent-state-change/agent-unregistered等事件 |
| **资源限制** | MAX_AGENTS限制最大Agent数量，支持资源分配与释放 |
| **统一目录扫描** | 使用readJsonDirSync工具函数从.harness/agents-runtime/恢复数据 |

## 类定义

```javascript
class AgentRuntime extends EventEmitter {
  constructor(projectRoot, options = {})
  register(agentId, config)
  unregister(agentId)
  unregisterAsync(agentId)
  get(agentId)
  getStatus(agentId)
  transition(agentId, newState, reason)
  allocateResources(agentId, resources)
  releaseResources(agentId)
  checkDependencies(agentId)
  setVersion(agentId, version)
  incrementTaskCount(agentId)
  setError(agentId, errorInfo)
  getResourcePool()
  listAgents(filter)
  getStats()
  flush()
  isHealthy()
  shutdown()
}
```

## 关键方法

### unregister(agentId)
同步注销Agent，内联删除逻辑替代async委托。v2.7.122将原异步实现改为同步，直接在方法体内执行删除操作，无需委托给异步流程。

### register(agentId, config)
注册Agent实例。v2.7.122新增config参数验证：若提供了config参数，必须为对象类型（`typeof config === 'object' && config !== null`），否则抛出`AgentError`。

### allocateResources(agentId, resources)
为Agent分配资源池配额。v2.7.122增强安全性：使用`Math.max(0, ...)`对资源池扣减结果进行保底，防止因异常输入或并发竞争导致资源池使用量出现负值。

### _releaseResources(agent)
释放Agent占用的资源池配额（内存MB、CPU百分比）。幂等设计：
- 先检查`agent.allocatedResources`是否存在且非空，若为空则跳过（防止双重释放）
- 释放后将`agent.allocatedResources`清空为`{}`，确保再次调用时不会重复扣减资源池计数
- 资源池使用量通过`Math.max(0, ...)`保底，防止出现负值

### listAgents(filter)
列出Agent实例，支持组合过滤条件：
- `filter.state` — 按状态过滤
- `filter.version` — 按版本过滤
- 两个条件可同时传入，此时两个条件都生效（AND逻辑），仅返回同时满足状态和版本条件的Agent
- 不传filter时返回全部Agent

### _evictOldest()
淘汰最久未活动的Agent（状态为STOPPED或CREATED）。资源释放策略：
- 正常路径：调用`unregister()`，由`unregister()`内部统一调用`_releaseResources()`处理资源释放
- 异常路径（unregister失败时）：在catch块中手动调用`_releaseResources()`作为兜底，然后从Map中删除
- 不再预先调用`_releaseResources`，避免与`unregister()`中的释放逻辑重复
- v2.7.122增强：无效时间戳回退——当Agent的`lastActivity`不是有效数字时，回退使用`0`作为比较值，确保时间戳异常的Agent优先被淘汰
- v2.7.122增强：catch块中在删除Agent前先获取其引用（`const agent = this.agents.get(agentId)`），确保异常路径下仍能正确释放资源

## 资源池恢复机制

v2.7.122新增资源池一致性对账逻辑。在`_restoreAgents()`从磁盘恢复Agent状态后，系统会遍历所有已恢复的Agent，汇总其`allocatedResources`并与当前资源池使用量进行对账：

- **触发时机**：`_restoreAgents()`执行完毕后立即触发
- **对账逻辑**：重新计算所有Agent的已分配资源总和，将其设为资源池的实际使用量，消除因崩溃或异常退出导致的资源池计数偏差
- **目的**：确保恢复后资源池的`usedMemoryMB`和`usedCpuPercent`与实际Agent占用一致，避免资源泄漏（已释放但计数未归零）或资源超卖（计数低于实际占用）

## Agent状态机

```
CREATED → INITIALIZING → RUNNING → PAUSED → STOPPING → STOPPED → DESTROYED
                ↓              ↓         ↓         ↓
             ERROR          STOPPING   STOPPING   ERROR
                ↓              ↓         ↓
             INITIALIZING   STOPPED   STOPPED
```

## 配置选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| maxAgents | 200 | 最大Agent数量 |
| totalMemoryMB | 4096 | 总内存池大小(MB) |

## 事件

| 事件 | 触发条件 |
|------|---------|
| `agent-registered` | Agent注册成功 |
| `agent-unregistered` | Agent注销 |
| `agent-state-change` | Agent状态转换 |
| `resource-allocated` | 资源分配成功 |
| `version-changed` | Agent版本变更 |
| `persist-error` | 持久化Agent时出错 |

## 依赖关系

- 使用 `KeyedDebouncer`（src/utils/keyed-debouncer.js）
- 使用 `readJsonDirSync`（src/utils/fs-utils.js）
- 使用 `writeAtomic`（src/utils/debounced-persister.js）
- 使用 `AgentError`（src/errors/index.js）
- 使用 `AgentSandbox`（src/runtime/agent/agent-sandbox.js）— v2.7.122增强：`validatePath()`新增null guard（路径参数为null/undefined时直接拒绝），`getAccessLog()`验证limit参数（必须为正整数，否则使用默认值）
