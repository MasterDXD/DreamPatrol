# 模块详解-CheckpointManager检查点管理器

> 版本：2.73.4 | 文件：src/runtime/session/checkpoint-manager.js

---

## 模块概述

CheckpointManager是Harness多Agent框架的检查点管理器，负责创建和恢复会话快照，实现容错自愈中的Checkpoint恢复机制。它将检查点数据持久化到.harness/checkpoints/目录，支持按会话ID筛选检查点、获取最新检查点、因果WAL序列回滚，以及容量管理（最多保留50个检查点，超出自动淘汰最旧）。

该模块是会话子系统的关键容错组件，与SessionManager、CausalDataBus协作，在任务失败或进程崩溃后提供状态恢复能力。

## 类定义

```javascript
class CheckpointManager {
  constructor(projectRoot)
  create(sessionId, data)
  get(checkpointId)
  list(sessionId)
  restore(checkpointId)
  restoreWithCausalRollback(checkpointId, causalDataBus)
  remove(checkpointId)
  getLatest(sessionId)
  shutdown() // via withShutdown mixin
  shutdownAsync()
}
```

通过`withShutdown`混入后导出，自动获得`shutdown()`方法和`_onShutdown()`生命周期钩子。

### 静态属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `CheckpointManager.MAX_CHECKPOINTS` | number | 最大检查点数量（50） |

## 构造函数

### `new CheckpointManager(projectRoot)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectRoot` | string | 是 | 项目根目录绝对路径 |

构造时自动创建.harness/checkpoints/目录并从磁盘恢复已有检查点。

## 核心方法

### `create(sessionId, data)`

为指定会话创建检查点快照。sessionId需匹配`[a-zA-Z0-9_-]`，最长128字符。检查点数量超过MAX_CHECKPOINTS时自动淘汰最旧记录。持久化使用`process.nextTick`调度，确保创建操作本身不阻塞调用线程。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 关联的会话ID |
| `data` | Object | 是 | 快照数据 |

**data参数结构**：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `data.phase` | string | 否 | '' | 当前阶段 |
| `data.completedSkills` | Array | 否 | [] | 已完成Skill列表 |
| `data.tokensUsed` | number | 否 | 0 | Token使用量 |
| `data.agentHistory` | Array | 否 | [] | Agent操作历史 |
| `data.causalWalSequence` | number | 否 | 0 | 因果WAL序列号 |
| `data.metadata` | Object | 否 | {} | 附加元数据 |

**返回值**：`Checkpoint | null` — 创建成功返回检查点对象，参数无效返回null

### `get(checkpointId)`

获取指定检查点的深拷贝。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `checkpointId` | string | 是 | 检查点ID |

**返回值**：`Checkpoint | null`

### `list(sessionId)`

列出检查点，按创建时间降序排列。可选按sessionId筛选。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `sessionId` | string | 否 | null | 筛选指定会话的检查点，null则返回全部 |

**返回值**：`Array<Checkpoint>`

### `restore(checkpointId)`

从检查点恢复会话状态，返回恢复数据（含restoredFrom和restoredAt字段）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `checkpointId` | string | 是 | 检查点ID |

**返回值**：`Object | null` — 恢复数据，包含phase、completedSkills、tokensUsed、agentHistory、causalWalSequence、metadata、restoredFrom、restoredAt

### `restoreWithCausalRollback(checkpointId, causalDataBus)`

从检查点恢复并执行因果WAL回滚。若causalDataBus支持rollbackToSequence且检查点有因果序列号，则自动回滚因果数据。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `checkpointId` | string | 是 | 检查点ID |
| `causalDataBus` | Object | 是 | CausalDataBus实例 |

**返回值**：`Object | null` — 恢复数据，额外包含causalRollback字段

### `remove(checkpointId)`

删除指定检查点。

**返回值**：`boolean` — 是否删除成功

### `getLatest(sessionId)`

获取指定会话的最新检查点。

**返回值**：`Checkpoint | null`

## 检查点数据结构

```javascript
{
  id: 'cp-xxxxxxxx',
  sessionId: 'session-xxx',
  phase: 'module-development',
  completedSkills: ['brainstorming', 'requirement-analysis'],
  tokensUsed: 15000,
  agentHistory: [],
  causalWalSequence: 42,
  metadata: {},
  createdAt: '2025-01-15T10:30:00.000Z',
}
```

## 持久化机制

- **写入**：使用writeAtomic原子写入，防止数据损坏
- **同步持久化**：`_persist()` — 遍历内存Map写入磁盘，删除已移除的文件。返回boolean表示持久化是否成功
- **异步持久化**：`_persistAsync()` — 并行写入+并行删除，适合高并发场景
- **恢复**：构造时调用`_restore()`从磁盘加载所有检查点
- **容量管理**：超过MAX_CHECKPOINTS(50)时自动淘汰createdAt最旧的检查点
- **关闭安全**：`_onShutdown()`仅在`_persist()`返回成功（true）时才清空内存Map，确保持久化失败时数据仍保留在内存中可供后续恢复

## 使用示例

```javascript
const CheckpointManager = require('./src/runtime/session/checkpoint-manager');

const cm = new CheckpointManager('/path/to/project');

const cp = cm.create('session-001', {
  phase: 'module-development',
  completedSkills: ['brainstorming', 'requirement-analysis'],
  tokensUsed: 15000,
  agentHistory: [{ agentId: 'worker', action: 'implement', timestamp: new Date().toISOString() }],
  causalWalSequence: 42,
  metadata: { reason: 'pre-deploy checkpoint' },
});

console.log(cm.list('session-001'));
console.log(cm.getLatest('session-001'));

const restored = cm.restore(cp.id);
console.log(`恢复到阶段: ${restored.phase}, Token: ${restored.tokensUsed}`);

cm.remove(cp.id);
```

### 因果回滚恢复

```javascript
const restored = cm.restoreWithCausalRollback(cp.id, causalDataBus);
if (restored.causalRollback) {
  console.log(`因果WAL已回滚到序列号: ${restored.causalWalSequence}`);
}
```

## 依赖关系

- 依赖：`../../utils/constants`（generateId、validateProjectRoot、HARNESS_DIR等常量）
- 依赖：`../../utils/debounced-persister`（writeAtomic原子写入）
- 依赖：`../../utils/fs-utils`（ensureDirSync、readJsonDirSync等文件系统工具）
- 依赖：`../../utils/shutdown-mixin`（优雅关闭混入）
- 被依赖：SessionManager（会话管理器，调用create/restore实现容错恢复）
- 被依赖：Web Dashboard（仪表盘，检查点状态展示）

## 修复记录

### Round 5-6（2026-05-30）

| 修复内容 | 详情 |
|---------|------|
| `_restore()`数据完整性验证 | 恢复检查点时新增字段类型校验：`completedSkills`/`agentHistory`强制为Array（非数组时重置为空数组），`tokensUsed`强制为有限数（非有限数时重置为0），`phase`强制为string，`causalWalSequence`强制为number，`metadata`强制为非null非Array的Object。防止损坏的JSON文件导致运行时类型错误 |
| `_restoreAsync()`验证缺失 | 异步恢复路径仅检查`cp.id`存在性，未校验字段类型。同步恢复有完整验证但异步路径跳过，导致通过异步恢复的检查点可能包含无效数据。补充与`_restore()`一致的字段校验逻辑 |
| `shutdownAsync()`新增 | 原仅支持同步`_onShutdown()`+`_persist()`关闭，异步持久化路径`_persistAsync()`无对应关闭入口。新增`shutdownAsync()`方法，内部`await _persistAsync()`后清空内存，确保异步场景下检查点数据安全落盘 |

### Round 8（2026-05-28）

| 修复内容 | 详情 |
|---------|------|
| 新增createAsync方法 | `createAsync(sessionId, data)`异步版本，内部`await _persistAsync()`确保检查点数据写入磁盘后再返回，解决原`create()`使用`process.nextTick`调度可能导致的进程崩溃时数据丢失问题 |

## 相关文档

- [[模块详解-SessionManager会话管理器]]
- [[模块详解-CausalDataBus因果数据总线]]
- [核心功能-会话管理与检查点恢复](../core/核心功能-会话管理与检查点恢复.md)
