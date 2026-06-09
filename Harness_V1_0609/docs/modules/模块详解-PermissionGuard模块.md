# 模块详解-PermissionGuard模块

> 版本：2.73.4 | 文件：src/permission/permission-guard.js | 行数：~500行

---

## 模块定位

PermissionGuard是文件操作权限守卫，是权限执行引擎的第二核心组件。它提供路径遍历防护、文件级锁（防并发冲突）、危险命令检测、确认过期机制，以及状态持久化与恢复能力。与RBACEnforcer互补：RBACEnforcer负责"谁可以做什么"的逻辑判断，PermissionGuard负责"文件操作是否安全"的守卫执行。

## 类定义

```javascript
class PermissionGuard extends EventEmitter {
  constructor(projectRoot)
  checkFileRead(filePath, agentId)
  checkFileWrite(filePath, agentId)
  checkFileDelete(filePath, agentId)
  checkCommand(command, agentId)
  acquireLock(filePath, agentId)
  releaseLock(filePath, agentId)
  getLockHolder(filePath)
  setConfirmationExpiry(ms)
  recordConfirmation(agentId, action, target)
  isConfirmationValid(agentId, action, target)
  enforceFileWrite(filePath, agentId)
  enforceCommand(command, agentId)
  static validateSessionId(sessionId)
  isHealthy()
  shutdown() // via withShutdown mixin
}
```

## 构造函数

### `constructor(projectRoot)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectRoot` | string | 是 | 项目根目录绝对路径，内部通过`validateProjectRoot`校验并`path.resolve`规范化 |

初始化内部状态：
- `locks` — 文件锁映射表：`{[resolvedPath]: {agent, acquiredAt, renewals}}`
- `confirmations` — 确认记录映射表：`{[key]: {confirmedAt, agentId, action, target}}`
- `_confirmationExpiryMs` — 确认过期时间，默认5分钟
- `_permissionDir` — 持久化目录：`.harness/permission/`
- `_dirty` — 脏标记，用于防抖持久化
- 构造时自动调用`_restore()`恢复上次持久化的状态

## 公开方法详解

### `checkFileRead(filePath, agentId)`

检查文件读取权限。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filePath` | string | 是 | 目标文件路径 |
| `agentId` | string | 否 | Agent ID（访问.harness/data时必需） |

**返回值**：`{allowed: boolean, reason?: string}`

**检查逻辑**：
1. 路径校验：是否在项目根目录内
2. 特殊目录：`.harness/data`目录需要提供agentId

### `checkFileWrite(filePath, agentId)`

检查文件写入权限。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filePath` | string | 是 | 目标文件路径 |
| `agentId` | string | 是 | 请求写入的Agent ID |

**返回值**：`{allowed: boolean, reason?: string}`

**检查逻辑**：
1. 路径校验：是否在项目根目录内
2. 系统文件保护：`.harness/`下的`config.json`、`agents/`、`skills/`、`rules/`、`workspace/`为只读
3. 可变目录：`.harness/sessions/`和`.harness/checkpoints/`允许写入
4. 文件锁检查：若文件被其他Agent锁定且锁未超时，拒绝写入

### `checkFileDelete(filePath, agentId)`

检查文件删除权限。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filePath` | string | 是 | 目标文件路径 |
| `agentId` | string | 否 | Agent ID（用于确认验证） |

**返回值**：`{allowed: boolean, reason?: string, requiresConfirmation?: boolean}`

**检查逻辑**：
1. 路径校验
2. 系统文件保护：`.harness/`系统文件不可删除
3. 确认检查：若之前已确认（在过期窗口内），则`requiresConfirmation: false`；否则`requiresConfirmation: true`

### `checkCommand(command, agentId)`

检查命令是否安全。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | 是 | 要执行的命令 |
| `agentId` | string | 否 | 请求执行的Agent ID（保留参数） |

**返回值**：`{allowed: boolean, reason?: string, requiresConfirmation?: boolean}`

**检查逻辑**：
1. 空命令或非字符串：拒绝
2. 安全命令白名单：`ls/pwd/echo/cat/head/tail/wc/git status/git log/git diff/git branch`直接放行
3. 危险模式检测：通过`DANGEROUS_SHELL_PATTERNS`正则检测（如`rm -rf`、命令注入等）
4. 其他命令：允许但需确认（`requiresConfirmation: true`）

### `acquireLock(filePath, agentId)`

获取文件锁。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filePath` | string | 是 | 目标文件路径 |
| `agentId` | string | 是 | 请求锁的Agent ID |

**返回值**：`boolean` — 是否成功获取锁

**行为细节**：
- 同一Agent可重入（renewals计数递增），最多`MAX_LOCK_RENEWALS`（10）次
- 其他Agent持有未超时锁时，获取失败
- 锁超时后自动释放（`DEFAULT_LOCK_TIMEOUT_MS`）
- 全局锁数量达到`MAX_LOCKS`时，先尝试淘汰过期锁，仍不足则失败

### `releaseLock(filePath, agentId)`

释放文件锁。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filePath` | string | 是 | 目标文件路径 |
| `agentId` | string | 是 | 持有锁的Agent ID |

**返回值**：`boolean` — 仅锁持有者可释放，成功返回true

### `getLockHolder(filePath)`

获取文件锁的持有者。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filePath` | string | 是 | 目标文件路径 |

**返回值**：`string | null` — 锁持有者的Agent ID，无锁或锁已超时返回null

### `setConfirmationExpiry(ms)`

设置确认过期时间。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ms` | number | 是 | 过期时间（毫秒），范围(0, MAX_CONFIRMATION_EXPIRY_MS]，最大24小时 |

**返回值**：`this`（支持链式调用）

### `recordConfirmation(agentId, action, target)`

记录确认操作。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | Agent ID |
| `action` | string | 是 | 操作类型（如`file_delete`） |
| `target` | string | 是 | 操作目标 |

**返回值**：`boolean` — 记录成功返回true

**行为细节**：
- 确认记录超过`MAX_CONFIRMATIONS`（5000）时，先淘汰过期记录，仍不足则淘汰最旧的
- 键格式：`agentId\0action\0target`（null字节分隔，防止碰撞）
- 记录后标记脏数据，触发防抖持久化

### `isConfirmationValid(agentId, action, target)`

验证确认是否仍然有效。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | Agent ID |
| `action` | string | 是 | 操作类型 |
| `target` | string | 是 | 操作目标 |

**返回值**：`boolean` — 确认存在且未过期返回true，过期时自动删除

### `enforceFileWrite(filePath, agentId)`

强制执行文件写入权限检查，不通过时抛出PermissionError。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filePath` | string | 是 | 目标文件路径 |
| `agentId` | string | 是 | 请求写入的Agent ID |

**返回值**：`true`

**抛出**：`PermissionError`，错误码根据原因不同：
- `FILE_OUTSIDE_PROJECT` — 路径在项目外
- `SYSTEM_FILE_READONLY` — 系统文件只读
- `LOCK_CONFLICT` — 文件锁冲突

### `enforceCommand(command, agentId)`

强制执行命令安全检查，检测到危险命令时抛出PermissionError。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | 是 | 要执行的命令 |
| `agentId` | string | 是 | 请求执行的Agent ID |

**返回值**：`true`

**抛出**：`PermissionError`，错误码`DANGEROUS_COMMAND`

### `static validateSessionId(sessionId)`

验证Session ID格式合法性（防路径注入）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 待验证的Session ID |

**返回值**：`boolean` — 仅允许`[a-zA-Z0-9_-]`，最长64字符

### `isHealthy()`

检查PermissionGuard是否健康。

**返回值**：`boolean` — 锁数量 < `HEALTH_MAX_LOCKS` 且确认数量 < `HEALTH_MAX_CONFIRMATIONS` 时返回true

## 文件锁机制

```
Agent A 请求写入 file.js → 检查锁 → 无锁 → acquireLock(file.js, A) → 获取锁 → 写入 → releaseLock(file.js, A)
Agent B 请求写入 file.js → 检查锁 → 有锁(A) → checkFileWrite返回 {allowed: false, reason: 'File is locked by A'}
```

**锁属性**：

| 属性 | 说明 |
|------|------|
| 超时时间 | `DEFAULT_LOCK_TIMEOUT_MS` |
| 最大续约次数 | `MAX_LOCK_RENEWALS`（10次） |
| 最大锁数量 | `MAX_LOCKS` |
| 超时处理 | 自动释放，其他Agent可获取 |

## 系统文件保护

`.harness/`目录下的系统文件受保护：

| 目录/文件 | 读取 | 写入 | 删除 |
|----------|------|------|------|
| `config.json` | ✅ | ❌ | ❌ |
| `agents/` | ✅ | ❌ | ❌ |
| `skills/` | ✅ | ❌ | ❌ |
| `rules/` | ✅ | ❌ | ❌ |
| `workspace/` | ✅ | ❌ | ❌ |
| `sessions/` | ✅ | ✅ | 需确认 |
| `checkpoints/` | ✅ | ✅ | 需确认 |

## 路径遍历防护

`_isWithinProject(resolved)`方法实现多层防护：

1. **Null字节检测**：路径中包含`\0`直接拒绝
2. **规范化比较**：统一转小写、反斜杠转正斜杠后比较前缀
3. **大小写敏感处理**：非Windows平台额外校验原始大小写
4. **realpath校验**：解析符号链接后再次验证是否在项目根目录内
5. **相对路径校验**：`path.relative`结果不能以`..`开头或为绝对路径
6. **父目录回退**：文件不存在时检查父目录的realpath

## 状态持久化

PermissionGuard通过防抖持久化机制将锁和确认状态保存到`.harness/permission/guard-state.json`：

- **持久化触发**：数据变更后标记`_dirty`，定时器间隔`PERSIST_POLL_MS`检查并写入
- **原子写入**：使用`writeAtomic`/`writeAtomicAsync`确保写入完整性
- **恢复机制**：构造时调用`_restore()`，通过`JsonStoreRestorer`加载并校验数据
- **原型链消毒**：使用`sanitizeProto`/`sanitizeObject`防止原型污染攻击
- **过期数据过滤**：恢复时自动过滤已过期的锁和确认记录

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `confirmation-recorded` | 确认记录保存 | `{agentId, action, target, confirmedAt}` |
| `persist-error` | 持久化写入失败 | `{error}` |
| `restore-error` | 状态恢复失败 | `{error}` |

## 静态属性

| 属性 | 说明 |
|------|------|
| `SESSION_ID_PATTERN` | Session ID验证正则，来自constants |

## 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `DEFAULT_CONFIRMATION_EXPIRY_MS` | 300000 (5分钟) | 默认确认过期时间 |
| `MAX_CONFIRMATION_EXPIRY_MS` | 86400000 (24小时) | 最大确认过期时间 |
| `MAX_CONFIRMATIONS` | 5000 | 最大确认记录数 |
| `MAX_LOCK_RENEWALS` | 10 | 锁最大续约次数 |
| `HEALTH_MAX_LOCKS` | 来自constants | 健康检查锁数量上限 |
| `HEALTH_MAX_CONFIRMATIONS` | 来自constants | 健康检查确认数量上限 |

## 使用示例

```javascript
const PermissionGuard = require('./src/permission/permission-guard');

const guard = new PermissionGuard('/path/to/project');

const writeResult = guard.checkFileWrite('/path/to/project/src/main.js', 'task-worker');
if (!writeResult.allowed) {
  console.error('写入被拒绝:', writeResult.reason);
}

guard.acquireLock('/path/to/project/src/main.js', 'task-worker');
const holder = guard.getLockHolder('/path/to/project/src/main.js');
console.log('锁持有者:', holder);

guard.setConfirmationExpiry(10 * 60 * 1000);
guard.recordConfirmation('task-worker', 'file_delete', '/path/to/project/src/old.js');
const deleteResult = guard.checkFileDelete('/path/to/project/src/old.js', 'task-worker');
console.log('删除需确认:', deleteResult.requiresConfirmation);

try {
  guard.enforceFileWrite('/path/to/project/src/main.js', 'domain-analyst');
} catch (err) {
  console.error('权限错误:', err.code, err.message);
}

if (PermissionGuard.validateSessionId('sess_abc123')) {
  console.log('Session ID合法');
}

guard.releaseLock('/path/to/project/src/main.js', 'task-worker');
guard.shutdown();
```

## 依赖关系

- 依赖：`../utils/constants.js` — 常量定义、路径校验、危险Shell模式
- 依赖：`../utils/sanitizer.js` — 原型链消毒
- 依赖：`../utils/debug-logger.js` — 调试日志
- 依赖：`../utils/safe-execute.js` — 安全执行工具
- 依赖：`../errors/index.js` — PermissionError错误类
- 依赖：`../utils/debounced-persister.js` — 原子写入
- 依赖：`../utils/shutdown-mixin.js` — 优雅关闭
- 依赖：`../utils/fs-utils.js` — 目录创建
- 依赖：`../utils/json-store-restorer.js` — JSON存储恢复
- 被依赖：`src/index.js` — 主入口装配

## 集成说明

- PermissionGuard与RBACEnforcer配合使用，构成完整的权限执行引擎
- ProgrammableHookExecutor的`path_validation`内置处理器可调用PermissionGuard进行路径校验
- 文件锁机制确保多Agent并发操作时不会产生写入冲突
- 确认过期机制用于文件删除等敏感操作的人工审批流程
- 状态持久化确保进程重启后锁和确认状态不丢失

## 相关文档

- [核心功能-权限控制与审计](../core/核心功能-权限控制与审计.md)
- [模块详解-RBACEnforcer模块](模块详解-RBACEnforcer模块.md)
- [核心功能-权限控制与审计](../core/核心功能-权限控制与审计.md)
