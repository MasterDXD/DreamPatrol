# 模块详解-AgentLifecycleController生命周期控制器

> 版本：2.73.4 | 文件：src/runtime/agent/agent-lifecycle-controller.js

---

## 模块概述

AgentLifecycleController是Agent生命周期控制器，负责管理Agent实例从创建到销毁的完整生命周期。它在AgentRuntime之上封装了高层操作接口，增加了操作互斥锁、状态持久化、沙箱准备/清理、依赖检查和操作历史记录等能力，确保生命周期转换的安全性和可追溯性。

核心设计理念：
- **操作互斥**：同一Agent同一时刻只允许一个生命周期操作执行，通过操作锁防止并发冲突
- **状态持久化**：每次状态变更同步写入StateManager，支持崩溃恢复
- **沙箱隔离**：启动前准备沙箱环境，停止后清理沙箱资源
- **依赖检查**：启动前验证Agent依赖是否满足，防止未就绪Agent进入运行态
- **操作审计**：所有生命周期操作记录到BoundedArray历史，支持回溯查询

## 类定义

```javascript
class AgentLifecycleController extends EventEmitter {
  constructor(runtime, stateManager, sandbox)

  // 生命周期操作
  create(agentId, config)
  start(agentId)
  pause(agentId)
  resume(agentId)
  stop(agentId, options)
  destroy(agentId)
  restart(agentId)

  // 查询方法
  getStatus(agentId)
  getOperationHistory(agentId, limit)

  // 内部方法
  _acquireLock(agentId, operation)
  _releaseLock(agentId)
  _recordOperation(agentId, operation, details)
  _onShutdown()
}
```

### 关键属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `runtime` | AgentRuntime | Agent运行时核心实例，默认创建新实例 |
| `stateManager` | AgentStateManager \| null | 状态持久化管理器，可选 |
| `sandbox` | AgentSandbox \| null | 沙箱环境管理器，可选 |
| `_operationHistory` | BoundedArray(1000) | 操作历史记录，上限1000条 |
| `_operationLocks` | Map | 操作互斥锁，key为agentId |

## 公开API

### create(agentId, config)

创建并注册一个新Agent实例。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent唯一标识符 |
| `config` | object | Agent配置对象，包含resourceLimits等 |

**返回值**：`Agent` — 注册后的Agent实例

**流程**：
1. 获取操作锁
2. 调用`runtime.register(agentId, config)`注册Agent
3. 若stateManager存在，持久化Agent状态
4. 记录操作历史
5. 发射`agent-created`事件
6. 释放操作锁

**异常**：
- `OPERATION_IN_PROGRESS` — 该Agent已有操作进行中
- AgentRuntime注册异常

---

### start(agentId)

启动一个已创建的Agent，使其进入RUNNING状态。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent唯一标识符 |

**返回值**：`Agent` — 启动后的Agent实例

**流程**：
1. 获取操作锁
2. 查找Agent，不存在则抛出`AGENT_NOT_FOUND`
3. 检查依赖是否满足（`runtime.checkDependencies`）
4. 若sandbox存在，准备沙箱环境
5. 状态转换：→ INITIALIZING → RUNNING
6. 分配资源（默认128MB内存、20% CPU）
7. 持久化状态
8. 记录操作历史，发射`agent-started`事件

**异常**：
- `AGENT_NOT_FOUND` — Agent不存在
- `DEPENDENCY_UNSATISFIED` — 依赖未满足
- `SANDBOX_NOT_READY` — 沙箱未就绪

**错误恢复**：启动失败时，若Agent处于INITIALIZING状态，自动转换到ERROR状态并记录错误信息。

---

### pause(agentId)

暂停一个运行中的Agent。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent唯一标识符 |

**返回值**：`Agent` — 暂停后的Agent实例

**流程**：获取锁 → 状态转换RUNNING→PAUSED → 持久化 → 记录 → 发射`agent-paused`

---

### resume(agentId)

恢复一个暂停的Agent。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent唯一标识符 |

**返回值**：`Agent` — 恢复后的Agent实例

**流程**：获取锁 → 状态转换PAUSED→RUNNING → 持久化 → 记录 → 发射`agent-resumed`

---

### stop(agentId, options)

停止一个Agent，释放其资源。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent唯一标识符 |
| `options.force` | boolean | 是否强制停止（跳过待处理任务持久化） |

**返回值**：`Agent` — 停止后的Agent实例

**流程**：
1. 获取操作锁
2. 状态转换：→ STOPPING
3. 非强制模式下持久化待处理任务数
4. 释放资源（`runtime.releaseResources`）
5. 状态转换：→ STOPPED
6. 若sandbox存在，清理沙箱
7. 持久化停止状态
8. 记录操作历史，发射`agent-stopped`事件

**异常处理**：强制模式下即使出错也尝试记录错误信息。

---

### destroy(agentId)

彻底销毁一个Agent实例，包括强制停止和注销。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent唯一标识符 |

**返回值**：`boolean` — 始终返回true

**流程**：
1. 获取操作锁
2. 若Agent处于RUNNING/PAUSED状态，强制停止（释放资源、清理沙箱）
3. 若Agent未处于STOPPED/ERROR/CREATED状态，尝试转换到DESTROYED
4. 删除状态持久化数据（`stateManager.deleteState`）
5. 注销Agent（`runtime.unregister`）
6. 记录操作历史，发射`agent-destroyed`事件

**容错设计**：强制停止过程中的异常被捕获并记录日志，不阻止后续销毁流程。

---

### restart(agentId)

重启一个Agent（先停止再启动）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent唯一标识符 |

**返回值**：`Agent` — 重启后的Agent实例

**流程**：
1. 若Agent处于RUNNING/PAUSED状态，先调用`stop()`
2. 调用`start()`重新启动
3. 启动失败时，若原状态为RUNNING/PAUSED，尝试恢复启动
4. 记录操作历史，发射`agent-restarted`事件

---

### getStatus(agentId)

获取Agent当前状态摘要。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent唯一标识符 |

**返回值**：`object | null`

```javascript
{
  id: string,
  state: string,
  version: string,
  startedAt: string,
  stoppedAt: string,
  taskCount: number,
  errorInfo: object,
  lastActivityAt: string
}
```

---

### getOperationHistory(agentId, limit)

查询操作历史记录。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string \| undefined | 指定Agent ID过滤，不传则返回全部 |
| `limit` | number \| undefined | 返回最近N条记录 |

**返回值**：`Array<{agentId, operation, details, timestamp}>`

## 状态机/流程图

### Agent生命周期状态机

```
                    ┌──────────────────────────────────────────────┐
                    │                                              │
                    ▼                                              │
  ┌─────────┐  create   ┌─────────┐  start    ┌─────────┐        │
  │  (无)   │──────────▶│ CREATED │──────────▶│INITIAL- │        │
  └─────────┘           └─────────┘           │ IZING   │        │
                             │                 └────┬────┘        │
                             │ destroy              │              │
                             ▼                 ┌────┴────┐        │
                        ┌───────────┐   成功   │         │        │
                        │ DESTROYED │◀─────────│         │        │
                        └───────────┘          │         │        │
                                               ▼         │        │
                                          ┌─────────┐    │        │
                                 pause ──▶│ RUNNING │    │        │
                                          └────┬────┘    │        │
                                          │    │         │        │
                                     resume  stop       │        │
                                          │    │         │        │
                                          ▼    ▼         │        │
                                       ┌─────────┐      │        │
                                       │  PAUSED │      │        │
                                       └────┬────┘      │        │
                                            │            │        │
                                          stop           │        │
                                            │            │        │
                                            ▼            │        │
                                       ┌──────────┐     │        │
                                       │ STOPPING │◀────┘        │
                                       └────┬─────┘              │
                                            │                    │
                                            ▼                    │
                                       ┌─────────┐   restart    │
                                       │ STOPPED │──────────────┘
                                       └────┬────┘     (→start)
                                            │
                                          destroy
                                            │
                                            ▼
                                       ┌───────────┐
                                       │ DESTROYED │
                                       └───────────┘

  任何活跃状态 ──error──▶ ERROR ──(re-init)──▶ INITIALIZING
```

### 操作互斥锁流程

```
操作请求 ──▶ 检查锁状态
                │
        ┌───────┴───────┐
        │ 无锁          │ 有锁
        ▼               ▼
   获取锁          检查超时
   执行操作       ┌────┴────┐
   释放锁         │ 已超时   │ 未超时
                   ▼         ▼
              强制释放   抛出OPERATION_IN_PROGRESS
              获取锁
              执行操作
              释放锁
```

## 事件

| 事件 | 触发时机 | Payload |
|------|---------|---------|
| `agent-created` | Agent创建成功 | `{ agentId, agent }` |
| `agent-started` | Agent启动成功 | `{ agentId }` |
| `agent-paused` | Agent暂停成功 | `{ agentId }` |
| `agent-resumed` | Agent恢复成功 | `{ agentId }` |
| `agent-stopped` | Agent停止成功 | `{ agentId, force }` |
| `agent-destroyed` | Agent销毁成功 | `{ agentId }` |
| `agent-restarted` | Agent重启成功 | `{ agentId }` |

## 配置

### 操作锁超时

| 配置项 | 值 | 来源 | 说明 |
|--------|-----|------|------|
| `DEFAULT_LOCK_TIMEOUT_MS` | 300000 (5分钟) | src/utils/constants.js | 操作锁自动超时时间 |

### 资源默认值（start方法中使用）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `resourceLimits.maxMemoryMB` | 128 | 启动时默认分配内存 |
| `resourceLimits.maxCpuPercent` | 20 | 启动时默认CPU百分比 |

### 操作历史

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `BoundedArray容量` | 1000 | 操作历史记录上限 |

## 使用示例

### 基础生命周期管理

```javascript
const AgentLifecycleController = require('./src/runtime/agent/agent-lifecycle-controller');
const AgentRuntime = require('./src/runtime/agent/agent-runtime');
const AgentStateManager = require('./src/runtime/agent/agent-state-manager');

const runtime = new AgentRuntime('/path/to/project');
const stateManager = new AgentStateManager('/path/to/project');
const lifecycle = new AgentLifecycleController(runtime, stateManager);

lifecycle.on('agent-started', ({ agentId }) => {
  console.log(`Agent ${agentId} 已启动`);
});

const agent = lifecycle.create('task-worker-1', {
  resourceLimits: { maxMemoryMB: 256, maxCpuPercent: 40 }
});

lifecycle.start('task-worker-1');
lifecycle.pause('task-worker-1');
lifecycle.resume('task-worker-1');
lifecycle.stop('task-worker-1');
```

### 带沙箱的生命周期管理

```javascript
const sandbox = new AgentSandbox('/path/to/project');
const lifecycle = new AgentLifecycleController(runtime, stateManager, sandbox);

lifecycle.on('agent-started', ({ agentId }) => {
  console.log(`Agent ${agentId} 沙箱已准备并启动`);
});

lifecycle.start('secure-agent');
```

### 错误处理与恢复

```javascript
try {
  lifecycle.start('my-agent');
} catch (err) {
  if (err.code === 'DEPENDENCY_UNSATISFIED') {
    console.log('依赖未满足:', err.message);
  } else if (err.code === 'SANDBOX_NOT_READY') {
    console.log('沙箱未就绪:', err.message);
  }
}

const status = lifecycle.getStatus('my-agent');
if (status && status.state === 'error') {
  lifecycle.restart('my-agent');
}
```

### 操作历史查询

```javascript
const allHistory = lifecycle.getOperationHistory();
const agentHistory = lifecycle.getOperationHistory('task-worker-1');
const recentHistory = lifecycle.getOperationHistory('task-worker-1', 10);
```

### 强制停止与销毁

```javascript
lifecycle.stop('stuck-agent', { force: true });

lifecycle.destroy('obsolete-agent');
```

## 依赖关系

### 上游依赖（本模块使用）

| 模块 | 文件 | 用途 |
|------|------|------|
| AgentRuntime | src/runtime/agent/agent-runtime.js | Agent注册/注销/状态转换/资源管理 |
| AgentStateManager | src/runtime/agent/agent-state-manager.js | 状态持久化（可选注入） |
| AgentSandbox | src/runtime/agent/agent-sandbox.js | 沙箱环境管理（可选注入） |
| BoundedArray | src/utils/bounded-array.js | 有界数组，限制操作历史记录数量 |
| AgentError | src/errors/index.js | 统一错误类型 |
| debug-logger | src/utils/debug-logger.js | 调试日志 |
| constants | src/utils/constants.js | DEFAULT_LOCK_TIMEOUT_MS常量 |
| shutdown-mixin | src/utils/shutdown-mixin.js | 优雅关闭混入 |

### 下游依赖（使用本模块）

| 模块 | 用途 |
|------|------|
| AgentWorkflowIntegration | 工作流集成中管理Agent生命周期 |
| AgentDeployment | 部署器中创建/销毁Agent实例 |
| Dashboard API | `/api/agents/lifecycle` 端点提供生命周期操作 |

## 交叉引用

- [[模块详解-AgentRuntime模块]] — 底层Agent运行时核心
- [[模块详解-AgentMonitor模块]] — Agent监控器
- [[模块详解-AgentDeployment模块]] — Agent部署器
- [[模块详解-AgentStateManager状态管理器]] — Agent状态持久化
- [[模块详解-ShutdownMixin关机混入]] — 优雅关闭机制
- [[核心功能-多Agent协作流程]] — 生命周期管理流程文档
