# 模块详解-RBACEnforcer模块

> 版本：2.73.4 | 文件：src/permission/rbac-enforcer.js | 行数：~340行

---

## 模块定位

RBACEnforcer是基于角色的访问控制（Role-Based Access Control）执行器，是权限执行引擎的核心组件。它从`.harness/agents/`和`.harness/skills/`目录加载Markdown格式的Agent和Skill定义，构建权限映射表，验证Agent是否有权执行指定Skill，并强制执行strict/recommended/optional三级权限策略。同时支持文件监听热重载，确保权限定义变更后实时生效。

## 类定义

```javascript
class RBACEnforcer extends EventEmitter {
  constructor(projectRoot)
  load()
  getAgentModel(agentId)
  canExecute(agentId, skillId)
  startWatching()
  stopWatching()
  isHealthy()
  shutdown() // via withShutdown mixin
}
```

## 构造函数

### `constructor(projectRoot)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectRoot` | string | 是 | 项目根目录绝对路径，内部通过`validateProjectRoot`校验 |

初始化内部状态：
- `agents` — 已加载的Agent权限定义对象
- `skills` — 已加载的Skill执行策略定义对象
- `_agentSkillSets` — Agent到Skill集合的映射（用于快速查找）
- `_loadErrors` — 加载过程中的错误列表
- `_watchers` — 文件监听器数组
- `_reloadTimer` — 防抖重载定时器

## 公开方法详解

### `load()`

从`.harness/agents/`和`.harness/skills/`加载权限定义。

**返回值**：`{ agentsLoaded: number, skillsLoaded: number, errors: number, busy?: boolean }`

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentsLoaded` | number | 成功加载的Agent定义数量 |
| `skillsLoaded` | number | 成功加载的Skill定义数量 |
| `errors` | number | 加载过程中的错误数量 |
| `busy` | boolean | 可选，若正在加载中则为true |

**行为细节**：
- 若当前正在加载（`_loading`标志），直接返回`{ agentsLoaded: 0, skillsLoaded: 0, errors: 0, busy: true }`
- 采用"全量替换"策略：先加载到临时对象，仅当加载成功时才替换当前状态
- 若Agent加载成功但Skill加载失败，仅保留Agent更新
- 加载错误超过`MAX_LOAD_ERRORS`（200）时停止记录
- 单个文件超过1MB时跳过并记录错误
- 加载完成后若有错误，触发`load-warnings`事件

### `getAgentModel(agentId)`

获取指定Agent配置的模型名称。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | Agent角色ID |

**返回值**：`string` — 模型名称，Agent不存在时返回空字符串`''`

### `canExecute(agentId, skillId)`

检查Agent是否有权执行指定Skill。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | Agent角色ID |
| `skillId` | string | 是 | Skill ID |

**返回值**：`boolean`

**输入校验**：
- `agentId`和`skillId`必须为非空字符串
- 不允许包含路径分隔符`/\:*?"<>|`（防注入）
- 长度不超过`MAX_ID_LENGTH`（128字符）
- 通过以上校验后，查找Agent的Skill集合判断是否包含目标Skill

### `startWatching()`

启动文件监听，当`.harness/agents/`或`.harness/skills/`目录下的Markdown文件变更时自动热重载权限定义。

**行为细节**：
- 仅监听`.md`文件变更
- 使用`RELOAD_DEBOUNCE_MS`（1000ms）防抖，避免频繁重载
- 热重载有冷却期`RELOAD_COOLDOWN_MS`，防止短时间内多次重载
- 单次会话重载次数超过`MAX_RELOAD_COUNT`（100）时自动停止监听，进入冷却期后恢复
- 冷却期后自动恢复监听

### `stopWatching()`

停止文件监听，关闭所有watcher并清除防抖定时器。

### `isHealthy()`

检查RBACEnforcer是否健康。

**返回值**：`boolean` — 未关闭且已加载至少一个Agent或Skill定义时返回true

### `shutdown()`

通过`withShutdown`混入提供。关闭时清理：
- 停止文件监听
- 清空所有Agent和Skill定义
- 清空加载错误列表
- 清除冷却定时器

## 数据结构

### Agent定义（AgentPermissions）

从`.harness/agents/`目录的Markdown Front Matter解析：

| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | string | Agent角色名称，默认为文件名 |
| `skills` | string[] | 可用的Skill ID列表 |
| `auto_route` | boolean | 是否启用自动路由 |
| `tdd_enforced` | boolean | 是否强制TDD |
| `collaborates_with` | string[] | 协作的Agent列表 |
| `manages` | string[] | 管理的Agent列表 |
| `model` | string | 使用的模型名称 |
| `level` | string | Agent层级 |
| `permissions` | object | 细粒度权限（仅保留合法键） |

**合法权限键**：`can_execute_skills`、`can_write_files`、`can_delete_files`、`can_execute_commands`、`can_modify_config`、`can_access_sessions`

### Skill定义（SkillEnforcementDef）

从`.harness/skills/`目录的Markdown Front Matter解析：

| 字段 | 类型 | 说明 |
|------|------|------|
| `skill_id` | string | Skill ID（基础设施组件使用component_id） |
| `enforcement` | string | 执行级别：strict/recommended/optional |
| `depends_on` | string[] | 依赖的Skill列表 |
| `applicable_agents` | string[] | 适用的Agent列表 |
| `phase` | string | 所属阶段 |
| `priority` | number | 优先级 |

## 执行级别

| 级别 | 违规处理 | 适用场景 |
|------|---------|---------|
| `strict` | 抛出PermissionError | TDD门禁、安全审计 |
| `recommended` | 发出警告 | 代码审查、重构 |
| `optional` | 记录日志 | 性能优化、文档编写 |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `load-warnings` | 加载过程中有错误 | `Array<{phase, file, error}>` |
| `watching-started` | 文件监听启动 | `{directories: number}` |
| `permissions-reloaded` | 热重载完成且定义有变化 | `{eventType, filename, agentsLoaded, skillsLoaded, errors}` |
| `reload-error` | 热重载失败 | `{error, filename}` |
| `reload-stopped` | 重载次数过多，监听暂停 | `{reason: 'too_many_reloads'}` |
| `watcher-resumed` | 冷却期结束，监听恢复 | `{reason: 'cooldown_expired'}` |

## 权限模型流程

```
Agent定义(.harness/agents/) ──┐
                              ├── RBACEnforcer.load() ── 权限映射表
Skill定义(.harness/skills/) ──┘         │
                                         ├── canExecute(agent, skill) → true/false
                                         ├── getAgentModel(agent) → model string
                                         └── startWatching() → 文件变更热重载
```

## 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `MAX_LOAD_ERRORS` | 200 | 最大加载错误记录数 |
| `MAX_ID_LENGTH` | 128 | Agent/Skill ID最大长度 |
| `MAX_RELOAD_COUNT` | 100 | 单次会话最大热重载次数 |
| `RELOAD_DEBOUNCE_MS` | 1000 | 热重载防抖间隔（毫秒） |
| `RELOAD_COOLDOWN_MS` | DEFAULT_MIN_HEARTBEAT_MS | 热重载冷却期 |
| `MAX_FILE_SIZE` | 1048576 (1MB) | 单个定义文件最大大小 |

## 使用示例

```javascript
const RBACEnforcer = require('./src/permission/rbac-enforcer');

const enforcer = new RBACEnforcer('/path/to/project');
const result = enforcer.load();
console.log(`已加载 ${result.agentsLoaded} 个Agent, ${result.skillsLoaded} 个Skill`);

if (enforcer.canExecute('team-lead', 'tdd-implement')) {
  console.log('team-lead 有权执行 tdd-implement');
}

const model = enforcer.getAgentModel('domain-analyst');
console.log('domain-analyst 使用模型:', model);

enforcer.startWatching();

enforcer.on('permissions-reloaded', (data) => {
  console.log('权限已热重载:', data.filename);
});

enforcer.shutdown();
```

## 依赖关系

- 依赖：`../utils/constants.js` — Front Matter解析、路径校验、常量定义
- 依赖：`../utils/fs-utils.js` — Markdown目录扫描
- 依赖：`../utils/debug-logger.js` — 调试日志
- 依赖：`../utils/shutdown-mixin.js` — 优雅关闭混入
- 依赖：`../utils/safe-execute.js` — 安全执行工具
- 被依赖：`src/index.js` — 主入口装配

## 集成说明

- RBACEnforcer与PermissionGuard配合使用：RBACEnforcer负责"谁可以做什么"的逻辑判断，PermissionGuard负责"文件操作是否安全"的守卫
- 在六阶段流程中，PhaseOrchestrator通过RBACEnforcer验证Agent是否有权执行当前阶段的Skill
- SkillRouter在匹配Skill时，可参考RBACEnforcer的Skill定义中的`applicable_agents`和`enforcement`级别
- 热重载机制确保在开发过程中修改Agent/Skill定义后无需重启服务

## 相关文档

- [核心功能-权限控制与审计](../core/核心功能-权限控制与审计.md)
- [模块详解-PermissionGuard模块](模块详解-PermissionGuard模块.md)
- [核心功能-权限控制与审计](../core/核心功能-权限控制与审计.md)
