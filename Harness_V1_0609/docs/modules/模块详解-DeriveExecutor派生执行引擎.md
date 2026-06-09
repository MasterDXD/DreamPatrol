# 模块详解-DeriveExecutor派生执行引擎

> 版本：2.73.4 | 文件：src/runtime/workflow/derive-executor.js

## 概述

DeriveExecutor 位于 `src/runtime/workflow/derive-executor.js`，是框架的派生执行引擎，桥接 GitWorktreeManager、WorldLineManager 和 GoalExecutor，实现 Codex VibeCoding 的"派生"功能：在隔离的 Git worktree 和世界线分支上安全实验新想法，验证后合并回主线，不满意则直接丢弃。继承自 `EventEmitter`，使用 `withShutdown` 混入提供优雅关闭能力，通过依赖注入方式接入三大子系统。

## 核心特性

- **隔离实验环境**：为每个派生创建独立的 Git worktree 和世界线分支，确保实验不影响主线
- **三阶段生命周期**：创建（derive）→ 合并（merge）/ 丢弃（abandon），完整覆盖实验流程
- **依赖注入架构**：GitWorktreeManager、WorldLineManager、GoalExecutor 均通过 attach 方法注入，松耦合设计
- **容量控制**：最大并行派生数限制（默认20），防止资源耗尽
- **自动清理**：合并后的派生记录可按延迟自动清理，避免内存泄漏
- **安全执行**：所有子操作均通过 `safeExecuteAsync`/`safeCallAsync` 包装，单个子系统失败不影响整体流程
- **优雅关闭**：关闭时自动将所有活跃派生标记为 ABANDONED，清理定时器和监听器

## 类定义

```javascript
class DeriveExecutor extends EventEmitter
```

通过 `withShutdown` 混入增强，导出为：

```javascript
module.exports = { DeriveExecutor: withShutdown(DeriveExecutor) }
```

## 常量

### 派生状态（DERIVE_STATUS）

| 状态 | 值 | 说明 |
|------|------|------|
| PENDING | `'pending'` | 派生已创建，等待激活 |
| ACTIVE | `'active'` | 派生活跃，正在实验中 |
| MERGING | `'merging'` | 派生正在合并回主线 |
| MERGED | `'merged'` | 派生已成功合并 |
| ABANDONED | `'abandoned'` | 派生已丢弃 |
| FAILED | `'failed'` | 派生合并失败 |

### 默认配置（DEFAULT_OPTIONS）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxDerivations` | number | 20 | 最大并行派生数 |
| `defaultMergeStrategy` | string | `'latest-wins'` | 默认合并策略 |
| `autoCleanupMerged` | boolean | true | 合并后是否自动清理资源 |
| `cleanupDelayMs` | number | 5000 | 清理延迟毫秒数 |

## 构造函数

```javascript
new DeriveExecutor(options?)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.maxDerivations` | number | 20 | 最大并行派生数 |
| `options.defaultMergeStrategy` | string | `'latest-wins'` | 默认合并策略 |
| `options.autoCleanupMerged` | boolean | true | 合并后自动清理资源 |
| `options.cleanupDelayMs` | number | 5000 | 清理延迟毫秒数 |

## 核心 API

### 依赖注入方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `attachWorktreeManager` | `attachWorktreeManager(manager) → this` | 注入 GitWorktreeManager，需实现 `create` 方法 |
| `attachWorldLineManager` | `attachWorldLineManager(manager) → this` | 注入 WorldLineManager，需实现 `createWorldLine` 方法 |
| `attachGoalExecutor` | `attachGoalExecutor(executor) → this` | 注入 GoalExecutor，需实现 `createGoal` 方法 |

### 派生操作

| 方法 | 签名 | 说明 |
|------|------|------|
| `derive` | `derive(objective, options?) → Promise<{deriveId, worktreeId, worldLineId, goalId}>` | 创建派生分支，在隔离环境中执行实验性目标 |
| `merge` | `merge(deriveId, options?) → Promise<{success, deriveId, error?}>` | 合并派生回主线，验证验收标准后合并世界线状态并清理 worktree |
| `abandon` | `abandon(deriveId) → Promise<{success, deriveId, error?}>` | 丢弃派生，清理 worktree 和世界线，不合并任何更改 |

### 查询方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `getDerivation` | `getDerivation(deriveId) → Object\|null` | 获取指定派生的详情 |
| `listDerivations` | `listDerivations(status?) → Object[]` | 列出所有派生，可按状态过滤 |
| `getStats` | `getStats() → Object` | 获取执行器统计信息 |
| `isHealthy` | `isHealthy() → boolean` | 检查执行器健康状态 |

### derive() 参数详情

| 参数 | 类型 | 说明 |
|------|------|------|
| `objective` | string | 目标描述（必填，非空字符串） |
| `options.agentId` | string | Agent 标识符（用于 worktree 命名） |
| `options.branchName` | string | Git 分支名称 |
| `options.worldLineName` | string | 世界线名称 |
| `options.mergeStrategy` | string | 合并策略 |
| `options.acceptanceCriteria` | string[] | 验收标准列表 |
| `options.goalOptions` | Object | 传递给 GoalExecutor 的额外选项 |

### merge() 参数详情

| 参数 | 类型 | 说明 |
|------|------|------|
| `deriveId` | string | 派生 ID（必填） |
| `options.mergeStrategy` | string | 覆盖合并策略 |
| `options.targetWorldLineId` | string | 目标世界线 ID |

### getDerivation() 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `deriveId` | string | 派生唯一标识 |
| `objective` | string | 目标描述 |
| `status` | string | 当前状态 |
| `worktreeId` | string\|null | Git worktree ID |
| `worldLineId` | string\|null | 世界线 ID |
| `goalId` | string\|null | 目标 ID |
| `mergeStrategy` | string | 合并策略 |
| `acceptanceCriteria` | string[] | 验收标准列表（副本） |
| `createdAt` | number | 创建时间戳 |
| `mergedAt` | number\|null | 合并时间戳 |
| `abandonedAt` | number\|null | 丢弃时间戳 |

### getStats() 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `total` | number | 当前派生总数 |
| `active` | number | 活跃派生数 |
| `merged` | number | 已合并总数 |
| `abandoned` | number | 已丢弃总数 |
| `failed` | number | 失败总数 |
| `created` | number | 创建总数 |
| `maxDerivations` | number | 最大并行派生数 |

## 事件

| 事件 | 触发时机 | 事件数据 |
|------|---------|---------|
| `derive-created` | 派生创建成功 | `{deriveId, objective, worktreeId, worldLineId, goalId}` |
| `derive-merged` | 派生合并成功 | `{deriveId, strategy}` |
| `derive-abandoned` | 派生丢弃成功 | `{deriveId}` |
| `derive-failed` | 派生合并失败 | `{deriveId, error}` |

## 与其他模块的集成

| 模块 | 集成方式 | 说明 |
|------|---------|------|
| GitWorktreeManager | `attachWorktreeManager()` | 为派生创建隔离的 Git worktree，合并/丢弃时清理 |
| WorldLineManager | `attachWorldLineManager()` | 为派生创建独立世界线分支，合并时执行世界线合并 |
| GoalExecutor | `attachGoalExecutor()` | 为派生创建目标，丢弃时取消未完成的目标 |
| withShutdown | 混入 | 提供优雅关闭能力，`_onShutdown()` 自动清理活跃派生 |
| safeExecuteAsync / safeCallAsync | 工具函数 | 包装所有子操作，确保单个子系统失败不中断整体流程 |
| safeAssign | 工具函数 | 安全合并配置对象 |

### 集成流程

```
derive(objective, options)
  ├─ 1. GitWorktreeManager.create() → 创建隔离 worktree
  ├─ 2. WorldLineManager.createWorldLine() → 创建世界线分支
  ├─ 3. GoalExecutor.createGoal() → 创建派生目标
  └─ 4. 注册派生记录 → emit('derive-created')

merge(deriveId, options)
  ├─ 1. WorldLineManager.mergeWorldLines() → 合并世界线状态
  ├─ 2. GitWorktreeManager.remove() → 清理 worktree
  └─ 3. 更新状态 → emit('derive-merged')

abandon(deriveId)
  ├─ 1. GitWorktreeManager.remove() → 清理 worktree
  ├─ 2. WorldLineManager.removeWorldLine() → 清理世界线
  ├─ 3. GoalExecutor.cancelGoal() → 取消目标
  └─ 4. 更新状态 → emit('derive-abandoned')
```

## 使用示例

### 基本用法：创建并合并派生

```javascript
const { DeriveExecutor } = require('./src/runtime/workflow/derive-executor');

const executor = new DeriveExecutor({ maxDerivations: 10 });

// 注入依赖
executor
  .attachWorktreeManager(worktreeManager)
  .attachWorldLineManager(worldLineManager)
  .attachGoalExecutor(goalExecutor);

// 创建派生：在隔离环境中实验新想法
const { deriveId } = await executor.derive('尝试新的缓存策略', {
  branchName: 'feature/new-cache',
  acceptanceCriteria: ['性能提升20%', '无内存泄漏'],
});

// 实验成功，合并回主线
const result = await executor.merge(deriveId, {
  targetWorldLineId: 'main-worldline',
});
if (result.success) {
  console.log('派生已合并');
}
```

### 丢弃不满意的派生

```javascript
// 实验结果不理想，直接丢弃
const abandonResult = await executor.abandon(deriveId);
if (abandonResult.success) {
  console.log('派生已丢弃，所有资源已清理');
}
```

### 查询派生状态

```javascript
// 获取单个派生详情
const derivation = executor.getDerivation(deriveId);
console.log('状态:', derivation.status);

// 列出所有活跃派生
const activeList = executor.listDerivations('active');

// 查看统计信息
const stats = executor.getStats();
console.log(`活跃: ${stats.active}, 已合并: ${stats.merged}, 已丢弃: ${stats.abandoned}`);
```

### 部分依赖注入（仅使用部分子系统）

```javascript
// 仅使用 WorldLineManager，不使用 GitWorktreeManager
const executor = new DeriveExecutor();
executor.attachWorldLineManager(worldLineManager);

const { deriveId, worktreeId, worldLineId } = await executor.derive('实验性功能');
// worktreeId 为 null，因为未注入 GitWorktreeManager
```

## 相关文档

- [模块详解-GoalExecutor目标执行器](模块详解-GoalExecutor目标执行器.md)
- [核心功能-目标执行引擎](../core/核心功能-目标执行引擎.md)
- [模块详解-工作流子系统](模块详解-工作流子系统.md)
