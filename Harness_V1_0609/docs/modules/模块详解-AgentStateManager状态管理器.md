# 模块详解-AgentStateManager状态管理器

> 版本：2.73.4 | 文件：src/runtime/agent/agent-state-manager.js

## 概述

AgentStateManager 管理 Agent 状态的完整生命周期，包括状态保存/加载（含 MD5 校验和完整性验证）、快照创建与恢复、状态同步（含冲突解决策略）、防抖磁盘持久化，以及路径遍历防护。

**源码位置**：`src/runtime/agent/agent-state-manager.js`（406行）

## 构造函数

```javascript
constructor(projectRoot, options = {})
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectRoot` | string | 是 | 项目根目录路径，用于确定状态文件存储位置 |
| `options` | object | 否 | 配置选项 |
| `options.persistInterval` | number | 否 | 防抖持久化间隔（ms），默认5000 |

## 架构角色

```
AgentRuntime → AgentStateManager → .harness/agent-states/
                    ↓                        ├─ {agentId}.json（状态文件）
                    ↓                        └─ {agentId}.snap.{snapId}.json（快照文件）
              DebouncedPersister（原子写入）
              crypto.createHash('md5')（校验和验证）
```

## 核心 API

### 状态管理

| 方法 | 签名 | 说明 |
|------|------|------|
| `saveState(agentId, stateData, options?)` | `(string, object, {immediate?: boolean}) → StateEntry` | 保存/更新Agent状态，自动合并数据、计算校验和、防抖持久化 |
| `loadState(agentId)` | `(string) → object\|null` | 加载Agent状态，自动校验MD5校验和完整性 |
| `deleteState(agentId)` | `(string) → boolean` | 删除Agent状态及磁盘文件 |
| `hasState(agentId)` | `(string) → boolean` | 检查Agent是否有状态 |
| `listAgents()` | `() → string[]` | 列出所有有状态的Agent ID |
| `getStateInfo(agentId)` | `(string) → StateInfo\|null` | 获取状态元信息（不含数据） |

### 快照管理

| 方法 | 签名 | 说明 |
|------|------|------|
| `createSnapshot(agentId, label?)` | `(string, string?) → Snapshot` | 创建状态快照（使用`deepClone`深拷贝） |
| `restoreSnapshot(agentId, snapshotId)` | `(string, string) → object` | 从快照恢复状态（含校验和验证） |
| `listSnapshots(agentId)` | `(string) → SnapshotInfo[]` | 列出Agent的所有快照 |
| `deleteSnapshot(agentId, snapshotId)` | `(string, string) → boolean` | 删除指定快照 |

### 状态同步

| 方法 | 签名 | 说明 |
|------|------|------|
| `syncState(agentId, remoteData)` | `(string, object) → StateEntry` | 同步远程状态数据，基于时间戳的冲突解决（remote-wins/local-wins） |

### 系统管理

| 方法 | 签名 | 说明 |
|------|------|------|
| `getStats()` | `() → Stats` | 获取统计信息 |
| `flush()` | `() → void` | 刷新所有待持久化的状态到磁盘 |
| `shutdown()` | `() → void` | 关闭（自动flush） |

## 数据结构

### StateEntry

```javascript
{
  agentId: string,
  createdAt: string,       // ISO 8601
  updatedAt: string | null, // ISO 8601
  data: object,            // 用户状态数据
  checksum: string | null,  // MD5哈希
  size: number,            // 序列化大小（字节）
  snapshotCount: number
}
```

### Snapshot

```javascript
{
  id: string,               // crypto.randomBytes(8).toString('hex')（16位hex）
  agentId: string,
  label: string,
  data: object,             // deepClone深拷贝
  checksum: string,
  createdAt: string         // ISO 8601
}
```

## 常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_STATE_SIZE` | 1MB | 单个状态最大序列化大小 |
| `MAX_SNAPSHOTS_PER_AGENT` | 50 | 每Agent最大快照数 |
| `persistInterval` | 5000 | 防抖持久化间隔（ms，默认值） |

## 安全机制

1. **路径遍历防护**：`_safePath()` 验证所有文件路径在项目根目录内
2. **ID验证**：`validateAgentId`（from `../../utils/constants`）验证所有Agent ID和快照ID
3. **校验和完整性**：MD5哈希验证状态和快照数据完整性
4. **大小限制**：`MAX_STATE_SIZE` 防止过大的状态数据
5. **原子写入**：通过 `DebouncedPersister.writeAtomic` 确保写入完整性

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `state-saved` | 状态保存 | `{ agentId, checksum }` |
| `state-deleted` | 状态删除 | `{ agentId }` |
| `state-corrupted` | 校验和不匹配 | `{ agentId, expected, actual }` |
| `state-synced` | 状态同步 | `{ agentId, strategy }` |
| `snapshot-created` | 快照创建 | `{ agentId, snapshotId, label }` |
| `snapshot-restored` | 快照恢复 | `{ agentId, snapshotId }` |
| `snapshot-deleted` | 快照删除 | `{ agentId, snapshotId }` |
| `persist-error` | 持久化失败 | `{ agentId, error }` |
| `shutdown` | 关闭 | — |

## 与其他模块的关系

| 模块 | 关系 |
|------|------|
| AgentRuntime | 通过 AgentStateManager 管理运行时状态 |
| AgentLifecycleController | 依赖 AgentStateManager 进行状态持久化 |
| ModuleInitializer | 系统启动时创建 AgentStateManager 实例 |
| DebouncedPersister | 原子写入状态和快照文件 |
| sha256Hex | ~~已废弃~~，源码实际使用 `crypto.createHash('md5')` 计算状态数据校验和 |

## v2.7.122 变更说明

| 方法/行为 | 变更内容 |
|-----------|---------|
| `deleteState()` | 改用已知快照列表进行文件删除，而非通过文件名模式匹配。修复了agentId包含下划线时模式匹配失败的问题 |
| `createSnapshot()` | 使用 `splice(0, MAX_SNAPSHOTS_PER_AGENT - snapshots.length + 1)` 替代 `shift()` 逐个删除，将时间复杂度从O(n)优化为O(1)；同时清理磁盘上残留的孤立快照文件 |
| 校验和算法 | 明确校验和使用MD5（`crypto.createHash('md5')`），而非之前文档中错误标注的sha256Hex |
