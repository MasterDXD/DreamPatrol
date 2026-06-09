# 模块详解-AgentDeployment模块

> 版本：2.73.4 | 文件：src/runtime/agent/agent-deployment.js

---

## 模块定位

AgentDeployment是Agent部署管理器，负责管理Agent在不同环境间的部署流程。支持4种部署策略（Recreate/Rolling/Blue-Green/Canary），提供版本注册、环境管理和部署验证能力。

## 核心能力

| 能力 | 说明 |
|------|------|
| **多策略部署** | 支持Recreate/Rolling/Blue-Green/Canary四种部署策略 |
| **环境管理** | 管理development/testing/staging/production四种环境 |
| **版本注册** | registerVersion()记录Agent版本信息 |
| **部署验证** | _verifyDeployment()验证部署结果一致性 |
| **状态持久化** | 通过DebouncedPersister自动持久化部署状态 |
| **策略映射** | 使用strategyHandlers对象替代switch-case，提取公共baseInfo |

## 类定义

```javascript
class AgentDeployment extends EventEmitter {
  constructor(projectRoot, options = {})
  registerVersion(agentId, version, metadata)
  deploy(agentId, targetEnv, options)
  getDeployment(deploymentId)
  getEnvironmentState(env)
  rollback(deploymentId, options)
  listDeployments(filter)
  lockEnvironment(env)
  unlockEnvironment(env)
  getVersionHistory(agentId)
  flush()
  getStats()
  shutdown()
}
```

## 部署策略

| 策略 | 常量 | 说明 | 特殊属性 |
|------|------|------|---------|
| Recreate | DEPLOYMENT_STRATEGIES.RECREATE | 先删除旧版本再部署新版本 | 无previousVersion |
| Rolling | DEPLOYMENT_STRATEGIES.ROLLING | 滚动更新，保留旧版本信息 | previousVersion |
| Blue-Green | DEPLOYMENT_STRATEGIES.BLUE_GREEN | 蓝绿部署，标记active状态 | active, previousVersion |
| Canary | DEPLOYMENT_STRATEGIES.CANARY | 金丝雀发布，按比例灰度 | canaryPercent, previousVersion |

## 环境类型

| 环境 | 常量 | 说明 |
|------|------|------|
| Development | ENVIRONMENTS.DEVELOPMENT | 开发环境 |
| Testing | ENVIRONMENTS.TESTING | 测试环境 |
| Staging | ENVIRONMENTS.STAGING | 预发布环境 |
| Production | ENVIRONMENTS.PRODUCTION | 生产环境 |

## 部署状态

```
PENDING → PREPARING → DEPLOYING → VERIFYING → COMPLETED
                                              ↓
                                           FAILED
                                              ↓
                                         ROLLED_BACK
```

## 依赖关系

- 继承自 `EventEmitter`
- 使用 `DebouncedPersister`（src/utils/debounced-persister.js）
- 使用 `readJsonDirSync`（src/utils/fs-utils.js）
- 使用 `AgentError`（src/errors/index.js）

## deploy() 执行流程

`deploy(agentId, targetEnv, options)` 是核心部署入口，通过 `process.nextTick()` 异步执行实际部署逻辑，同步返回部署记录。

### 同步阶段（参数验证与记录创建）

```
deploy(agentId, targetEnv, options)
  │
  ├─ guardShutdown()                          ← 检查是否已关闭
  ├─ _validateDeployParams()                  ← 参数校验
  │    ├─ validateAgentId(agentId)             ← Agent ID 格式验证
  │    ├─ ENVIRONMENTS_SET.has(targetEnv)      ← 环境有效性检查
  │    ├─ envState.locked                      ← 环境锁定检查
  │    └─ DEPLOYMENT_STRATEGIES_SET.has(strategy) ← 策略有效性检查
  │
  ├─ 确定部署参数
  │    ├─ strategy = options.strategy || 'rolling'
  │    ├─ version = options.version || _getNextVersion(agentId)
  │    ├─ canaryPercent = _validateCanaryPercent()  ← 0-100 范围校验
  │    └─ rollbackOnFailure = options.rollbackOnFailure !== false  ← 默认 true
  │
  ├─ _createDeploymentRecord()                ← 创建部署记录（状态 PENDING）
  │
  ├─ 记录 previousVersion                     ← 从环境当前部署获取
  │
  ├─ _deployments.set(deploymentId, deployment) ← 存入 Map
  │    └─ 超过 _maxDeployments(500) 时淘汰已完成/失败/回滚的旧记录
  │
  └─ process.nextTick(() => _executeDeployment(deploymentId))  ← 异步执行
     返回 deployment
```

### 异步阶段（_executeDeployment）

```
_executeDeployment(deploymentId)
  │
  ├─ ① PREPARING 阶段
  │    ├─ deployment.state = 'preparing'
  │    ├─ emit('deployment-state-change', { deploymentId, state: 'preparing' })
  │    └─ _prepareDeployment()
  │         └─ 若版本注册表中无此 agentId，自动 registerVersion()
  │
  ├─ ② DEPLOYING 阶段
  │    ├─ deployment.state = 'deploying'
  │    ├─ emit('deployment-state-change', { deploymentId, state: 'deploying' })
  │    ├─ 保存环境快照 savedEnvSnapshot（用于失败回滚）
  │    └─ _applyDeployment(deployment)         ← 按策略执行部署
  │
  ├─ ③ VERIFYING 阶段
  │    ├─ deployment.state = 'verifying'
  │    ├─ emit('deployment-state-change', { deploymentId, state: 'verifying' })
  │    └─ _verifyDeployment(deployment)        ← 验证部署结果
  │
  ├─ ④ COMPLETED 阶段（成功路径）
  │    ├─ deployment.state = 'completed'
  │    ├─ envState.agents.set(agentId, info)   ← 更新环境状态
  │    ├─ _registerDeploymentVersion()         ← 注册版本
  │    ├─ _persistDeployment()                 ← 持久化到磁盘
  │    └─ emit('deployment-completed', { deploymentId, agentId, version, targetEnv })
  │
  └─ ④ FAILED 阶段（异常路径）
       ├─ deployment.state = 'failed'
       ├─ deployment.errorInfo = { message, code, timestamp }
       ├─ 恢复环境快照（savedEnvSnapshot 或删除 agent）
       ├─ _persistDeployment()
       ├─ emit('deployment-failed', err, { deploymentId })
       └─ 若 rollbackOnFailure && previousVersion && _rollbackDepth < 2
            └─ 自动调用 rollback()
```

### 部署验证（_verifyDeployment）

验证两件事：
1. Agent 存在于目标环境中（`envState.agents.get(agentId)` 非空）
2. 版本号一致（`agentInfo.version === deployment.version`）

任一检查失败抛出 `AgentError('DEPLOYMENT_FAILED', ...)`。

## 四种策略详细实现

`_applyDeployment()` 使用 `strategyHandlers` 对象替代 switch-case，提取公共 `baseInfo` 后按策略差异化处理。

### 公共 baseInfo

```javascript
const baseInfo = {
  version: deployment.version,
  deployedAt: new Date().toISOString(),
  strategy: deployment.strategy,
  previousVersion: currentInfo ? currentInfo.version : null,
};
```

### Recreate（重建）

```
1. 若环境中有当前版本 → envState.agents.delete(agentId)  ← 先删除
2. 创建 info = mergeConfig(baseInfo)
3. delete info.previousVersion                               ← 无 previousVersion
4. envState.agents.set(agentId, info)                        ← 再设置
```

特点：完全替换，不保留旧版本信息。适用于无状态 Agent 或破坏性更新。

### Rolling（滚动更新）

```
1. envState.agents.set(agentId, baseInfo)  ← 直接覆盖
```

特点：保留 `previousVersion` 信息，支持回滚。最简单的策略，也是默认策略。

### Blue-Green（蓝绿部署）

```
1. envState.agents.set(agentId, mergeConfig(baseInfo, { active: true }))
```

特点：标记 `active: true`，保留 `previousVersion`。蓝绿切换通过修改 `active` 标记实现，旧版本信息保留在 `previousVersion` 中以便快速切回。

### Canary（金丝雀发布）

```
1. 若 canaryPercent <= 0 或 > 100 → 强制设为 10（默认灰度比例）
2. envState.agents.set(agentId, mergeConfig(baseInfo, { canaryPercent }))
```

特点：携带 `canaryPercent` 流量比例标记，保留 `previousVersion`。灰度比例由调用方在 `options.canaryPercent` 中指定（0-100），无效值自动修正为 10%。

## rollback() 回滚机制

### 回滚触发条件

| 触发方式 | 代码路径 | 说明 |
|---------|---------|------|
| 自动回滚 | `_executeDeployment` 异常路径 | `rollbackOnFailure=true` 且 `previousVersion` 存在且 `_rollbackDepth < 2` |
| 手动回滚 | 外部调用 `rollback(deploymentId, options)` | 需指定部署 ID，可选提供回滚原因 |

### 回滚流程

```
rollback(deploymentId, { reason })
  │
  ├─ guardShutdown()
  ├─ 查找部署记录 → 不存在则抛出 DEPLOYMENT_NOT_FOUND
  ├─ 检查 previousVersion → 不存在则抛出 NO_PREVIOUS_VERSION
  │
  ├─ 调用 deploy() 创建回滚部署
  │    ├─ version = deployment.previousVersion       ← 回滚到上一版本
  │    ├─ strategy = RECREATE                        ← 回滚始终用重建策略
  │    ├─ rollbackOnFailure = false                  ← 防止回滚的回滚
  │    ├─ _rollbackDepth = deployment._rollbackDepth + 1  ← 递增深度
  │    └─ metadata = { rollbackOf, reason }
  │
  └─ 监听回滚部署状态（轮询机制）
       ├─ setInterval(10ms) 检查回滚部署状态
       │    ├─ COMPLETED → 原部署标记 ROLLED_BACK
       │    │            → emit('deployment:rolled-back')
       │    └─ FAILED → 原部署标记 FAILED
       │               → emit('deployment:rollback-failed')
       │
       └─ 安全超时 30s (_ROLLBACK_SAFETY_TIMEOUT_MS)
            → 清理定时器，防止无限轮询
```

### 回滚深度保护

`_rollbackDepth` 限制最大回滚嵌套深度为 2，防止回滚的回滚的回滚导致无限递归。超过深度限制时跳过自动回滚并记录调试日志。

### 与版本历史的关联

回滚部署的 `metadata.rollbackOf` 记录原始部署 ID，`metadata.reason` 记录回滚原因。回滚部署本身也会注册到版本注册表，形成完整的版本链。

## 环境锁定机制

### lockEnvironment(env)

```javascript
lockEnvironment(env) {
  // 环境有效性校验 → 无效抛出 AgentError('INVALID_ENVIRONMENT')
  this._environmentStates[env].locked = true;
  this.emit('environment-locked', { environment: env });
}
```

锁定后，`_validateDeployParams()` 中检查 `envState.locked`，若为 `true` 则抛出 `AgentError('ENVIRONMENT_LOCKED')`，阻止所有新的部署操作。

### unlockEnvironment(env)

```javascript
unlockEnvironment(env) {
  this._environmentStates[env].locked = false;
  this.emit('environment-unlocked', { environment: env });
}
```

### 并发控制场景

环境锁定用于以下场景：
- **蓝绿部署切换期间**：防止在 active 标记切换过程中有新的部署介入
- **金丝雀发布观察期**：在灰度验证期间锁定环境
- **维护窗口**：人工锁定生产环境，阻止自动部署
- **回滚进行中**：回滚操作期间环境应保持锁定状态

注意：当前锁定机制是简单的布尔标志，不支持读写锁分级。锁定/解锁操作不持久化，进程重启后所有环境恢复为未锁定状态。

## 持久化策略

### 存储路径

部署记录持久化到 `{projectRoot}/.harness/deployments/{deploymentId}.json`。

### 写入方式

`_persistDeployment(deployment)` 使用 `writeAtomic()` 原子写入，确保写入过程中崩溃不会产生损坏文件。写入失败时通过 `emitError(this, 'persist-error', err, { deploymentId })` 报告错误，不中断主流程。

### 恢复机制

`_restoreDeployments()` 在构造函数中调用，使用 `readJsonDirSync()` 读取部署目录下所有 JSON 文件，每条记录通过 `sanitizeData()` 清洗后恢复到 `_deployments` Map 中。`sanitizeData()` 会过滤掉无效字段，确保恢复的数据结构完整。

### flush() 批量持久化

`flush()` 遍历所有部署记录逐个调用 `_persistDeployment()`，用于：
- 系统关闭时（`_onShutdown()` 中调用）
- 外部需要强制同步所有内存状态到磁盘时

### 容量管理

| 数据结构 | 容量限制 | 淘汰策略 |
|---------|---------|---------|
| `_deployments` Map | `_maxDeployments = 500` | 优先淘汰 COMPLETED/FAILED/ROLLED_BACK 状态的记录，无则淘汰最早记录 |
| `_versionRegistry` Map | `_maxVersionRegistry = 1000` | 淘汰最旧 agentId 的整个版本列表 |
| 单 Agent 版本列表 | `_maxVersionsPerAgent = 100` | `splice(0, length - 100)` 删除最早版本 |

## 事件列表

| 事件名 | 触发时机 | 携带数据 |
|--------|---------|---------|
| `deployment-state-change` | 部署状态变更（PREPARING/DEPLOYING/VERIFYING） | `{ deploymentId, state }` |
| `deployment-completed` | 部署成功完成 | `{ deploymentId, agentId, version, targetEnv }` |
| `deployment-failed` | 部署失败 | Error 对象 + `{ deploymentId }` |
| `deployment:rolled-back` | 回滚部署成功完成 | `{ deploymentId, rolledBackTo }` |
| `deployment:rollback-failed` | 回滚部署失败 | `{ deploymentId, reason }` |
| `environment-locked` | 环境被锁定 | `{ environment }` |
| `environment-unlocked` | 环境被解锁 | `{ environment }` |
| `version-registered` | 版本注册到注册表 | `{ agentId, version }` |
| `persist-error` | 持久化写入失败 | Error 对象 + `{ deploymentId }` |

注意：`deployment:rolled-back` 和 `deployment:rollback-failed` 使用冒号分隔符，与其他事件使用连字符的命名风格不同，这是因为它们在 EventRegistrar 的 `EVENT_FORWARD_MAP` 中被映射为 `agent:deployed` 和 `agent:deploy-failed`。

## 配置选项

### constructor(projectRoot, options)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `projectRoot` | string | （必需） | 项目根目录路径，用于定位 `.harness/deployments/` 目录 |
| `options` | Object | `{}` | 部署器配置选项 |

当前 `options` 在构造函数中仅存储为 `this.options`，未直接消费任何字段。以下容量参数为内部硬编码常量：

| 内部常量 | 默认值 | 说明 |
|---------|--------|------|
| `_maxDeployments` | 500 | 最大部署记录数量 |
| `_maxVersionRegistry` | 1000 | 版本注册表最大 Agent 数量 |
| `_maxVersionsPerAgent` | 100 | 单 Agent 最大版本数量 |

### deploy(agentId, targetEnv, options)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `agentId` | string | （必需） | Agent 唯一标识 |
| `targetEnv` | string | （必需） | 目标环境：`development` / `testing` / `staging` / `production` |
| `options.strategy` | string | `'rolling'` | 部署策略：`rolling` / `blue-green` / `canary` / `recreate` |
| `options.version` | string | 自动递增 | 部署版本号，不传则基于上次版本自动 patch 递增 |
| `options.canaryPercent` | number | `0`（无效时 `10`） | 金丝雀发布流量百分比（0-100） |
| `options.rollbackOnFailure` | boolean | `true` | 失败时是否自动回滚 |
| `options.metadata` | Object | `{}` | 部署元数据，存储到部署记录中 |
| `options._rollbackDepth` | number | `0` | 内部使用，回滚嵌套深度计数 |

### rollback(deploymentId, options)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `deploymentId` | string | （必需） | 要回滚的部署 ID |
| `options.reason` | string | `'Manual rollback'` | 回滚原因 |

### listDeployments(filter)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `filter.agentId` | string | — | 按 Agent ID 过滤 |
| `filter.targetEnv` | string | — | 按目标环境过滤 |
| `filter.state` | string | — | 按部署状态过滤 |
| `filter.strategy` | string | — | 按部署策略过滤 |

## 相关文档
