# 模块详解-ProgrammableHookExecutor模块

> 版本：2.73.4 | 文件：src/runtime/workflow/programmable-hook-executor.js | 行数：~530行

---

## 模块定位

ProgrammableHookExecutor是可编程钩子执行器，是工作流子系统的核心组件。它在框架关键节点插入可编程的干预逻辑，支持10+内置处理器（路径验证、内容安全、权限检查、参数校验、限流、备份、交付物完整性、质量标准、Token预算、Token自动记录、完成前验证、审计日志、简洁性检查、精准变更检查、核心身份注入、Skill路由注入、阶段上下文加载等）、顺序执行+阻塞中断策略、60s超时保护，以及完善的监控和统计能力。

## 类定义

```javascript
class ProgrammableHookExecutor extends EventEmitter {
  constructor(projectRoot)
  loadFromConfig(config)
  register(event, action)
  unregister(event, id)
  execute(event, context)
  getRegisteredHooks(event)
  isHealthy()
  getStats()
  getHookMonitorData()
  getSlowHooks(limit)
  getHookSuccessRates()
  resetMonitorData()
  shutdown() // via withShutdown mixin
}
```

## 构造函数

### `constructor(projectRoot)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectRoot` | string | 是 | 项目根目录绝对路径，内部通过`validateProjectRoot`校验 |

初始化内部状态：
- `_hooks` — 按事件名分组的钩子注册表
- `_totalHookCount` — 已注册钩子总数
- `_monitor` — 监控数据对象（执行记录、慢钩子、全局统计）
- `_monitorCleanupTimer` — 监控数据清理定时器

## 公开方法详解

### `register(event, action)`

注册钩子到指定事件。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | 事件名称，如`pre:skill:execute` |
| `action` | object | 是 | 钩子动作定义 |

**action对象结构**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 否 | 钩子唯一标识，不提供时自动生成 |
| `type` | string | 否 | 钩子类型：`builtin`/`function`/`shell`，默认`function` |
| `name` | string | 否 | 钩子名称（builtin类型必填） |
| `handler` | function | 否 | function类型的处理函数 |
| `command` | string/string[] | 否 | shell类型的命令 |
| `timeout` | number | 否 | shell类型的超时时间 |
| `enabled` | boolean | 否 | 是否启用，默认true |

**钩子类型**：

| 类型 | 说明 | handler来源 |
|------|------|------------|
| `builtin` | 内置处理器 | 从`BUILTIN_HANDLERS`按name查找 |
| `function` | 自定义函数 | 由`action.handler`提供 |
| `shell` | Shell命令 | 由`action.command`提供，自动执行 |

**限制**：
- 单个事件最多`MAX_HOOKS_PER_EVENT`（50）个钩子
- 全局最多`MAX_TOTAL_HOOKS`（500）个钩子
- 同一事件下钩子ID不可重复

**返回值**：`this`（支持链式调用）

### `unregister(event, id)`

注销指定事件的指定钩子。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | 事件名称 |
| `id` | string | 是 | 钩子ID |

**返回值**：`this`（支持链式调用）

### `execute(event, context)`

执行指定事件的所有已注册钩子，按注册顺序依次执行。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | 事件名称 |
| `context` | object | 是 | 执行上下文，自动注入`project_root` |

**返回值**：`Promise<Array<HookResult>>`

**HookResult结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 钩子ID |
| `type` | string | 钩子类型 |
| `name` | string | 钩子名称 |
| `passed` | boolean | 是否通过 |
| `reason` | string | 失败原因 |
| `message` | string | 执行消息 |
| `elapsedMs` | number | 执行耗时（毫秒） |

**执行策略**：
- 顺序执行，前一个钩子失败（`passed: false`）时中断后续钩子
- 单个钩子超时`DEFAULT_HOOK_TIMEOUT_MS`（2倍CENTRAL_HOOK_TIMEOUT_MS），超时抛出HookError
- 已关闭状态下不执行
- 跳过`enabled: false`的钩子
- 每次执行记录监控数据

### `loadFromConfig(config)`

从配置对象批量加载钩子。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `config` | object | 是 | 配置对象，需包含`hooks`字段 |

**config.hooks结构**：

```javascript
{
  hooks: {
    'pre:skill:execute': {
      enabled: true,
      checks: ['path_validation', 'permission_check'] // 字符串=内置处理器
    },
    'post:skill:execute': {
      enabled: true,
      actions: [{ type: 'function', handler: fn }] // 对象=自定义钩子
    }
  }
}
```

**返回值**：`this`（支持链式调用）

### `getRegisteredHooks(event)`

获取指定事件已注册的钩子列表。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | 事件名称 |

**返回值**：`Array<{id, type, name, enabled}>`

### `isHealthy()`

检查执行器是否健康。基于全局成功率判断，成功率低于`HEALTH_MIN_SUCCESS_RATE`（0.7）时返回false。

**返回值**：`boolean`

### `getStats()`

获取钩子注册统计信息。

**返回值**：`{ totalHooks: number, hooksByEvent: Object, builtinCount: number }`

### `getHookMonitorData()`

获取完整的监控数据，包含全局统计、每个钩子的统计、最近执行记录和慢钩子记录。

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `global` | object | 全局统计（calls/passes/failures/errors/successRate/avgLatencyMs/uptimeMs） |
| `perHook` | Array | 每个钩子的详细统计 |
| `recentExecutions` | Array | 最近50条执行记录 |
| `slowHooks` | Array | 最近30条慢钩子记录 |
| `slowHookCount` | number | 慢钩子总数 |
| `thresholdMs` | number | 慢钩子阈值 |

### `getSlowHooks(limit)`

获取慢钩子记录。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `limit` | number | 否 | 最大返回数量，默认50 |

**返回值**：`Array<SlowHookEntry>`

### `getHookSuccessRates()`

获取每个钩子的成功率统计。

**返回值**：`Object<hookKey, {calls, successRate, avgMs}>`

### `resetMonitorData()`

重置所有监控数据。

## 内置处理器

| 处理器名称 | 说明 | 检查内容 |
|-----------|------|---------|
| `path_validation` | 路径验证 | 文件路径是否在项目根目录内，是否为受保护系统路径 |
| `content_safety` | 内容安全 | 检测API密钥、私钥等敏感信息模式 |
| `permission_check` | 权限检查 | 只读Agent不可写文件，受限Skill需特权Agent |
| `parameter_validation` | 参数校验 | Skill参数类型和长度验证 |
| `rate_limit_check` | 限流检查 | 每Agent每分钟最多100次调用 |
| `backup_original` | 原始备份 | 写/修改/删除操作前标记备份 |
| `deliverable_completeness` | 交付物完整性 | Skill交付物必需字段检查 |
| `quality_standards` | 质量标准 | console.log/debugger/空catch检测 |
| `token_budget_check` | Token预算 | Token使用量达80%警告、95%危险、100%耗尽 |
| `token_auto_record` | Token自动记录 | 自动记录Token消耗到会话 |
| `verification_before_completion` | 完成前验证 | 严格Skill的测试和Lint结果验证 |
| `audit_log_record` | 审计日志 | 记录Agent操作审计条目 |
| `simplicity_check` | 简洁性检查 | YAGNI原则：新文件数/新增行数/抽象模式/接口检查 |
| `surgical_change_check` | 精准变更检查 | 修改文件数/重构范围/样式变更/孤立残留检查 |
| `inject_core_identity` | 核心身份注入 | 注入框架身份、原则、角色、阶段到上下文 |
| `inject_skill_router` | Skill路由注入 | 扫描Skill目录并注入路由指令到上下文 |
| `load_current_phase_context` | 阶段上下文加载 | 加载项目配置、会话状态、Token使用量到上下文 |

## 钩子点

| 钩子点 | 触发时机 | 典型用途 |
|--------|---------|---------|
| `pre:skill:execute` | Skill执行前 | 路径验证、权限检查、参数校验、限流 |
| `post:skill:execute` | Skill执行后 | 审计日志、Token记录、质量检查 |
| `pre:phase:change` | 阶段转换前 | 交付物完整性、完成前验证 |
| `post:phase:change` | 阶段转换后 | 阶段上下文注入 |
| `pre:agent:spawn` | Agent创建前 | 核心身份注入、Skill路由注入 |
| `post:agent:spawn` | Agent创建后 | 初始化后处理 |

## Shell钩子安全机制

Shell类型钩子有严格的安全防护：

1. **危险模式检测**：通过`DANGEROUS_SHELL_PATTERNS`正则检测命令注入
2. **白名单命令**：仅允许`git/echo/cat/ls/mkdir/cp/mv/test/true/false/date/wc/head/tail/sort/uniq/diff/which/pwd/env`
3. **工作目录限制**：Shell命令的cwd必须在项目根目录内
4. **上下文替换消毒**：`{{key}}`占位符替换时，特殊字符被替换为`_`
5. **输出截断**：Shell输出截断至500字符
6. **无Shell解释器**：使用`execFile`而非`exec`，避免Shell注入

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `hook-registered` | 钩子注册成功 | `{event, id, type}` |
| `hook-unregistered` | 钩子注销 | `{event, id}` |
| `hook-executed` | 钩子执行完成 | `{event, hookId, passed, elapsedMs}` |
| `hook-error` | 钩子执行异常 | `{error, event, hookId, elapsedMs}` |
| `slow-hook-detected` | 检测到慢钩子 | `{event, hookId, name, type, elapsedMs, threshold, passed}` |

## 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `MAX_HOOKS_PER_EVENT` | 50 | 单个事件最大钩子数 |
| `MAX_TOTAL_HOOKS` | 500 | 全局最大钩子数 |
| `DEFAULT_HOOK_TIMEOUT_MS` | 2 × CENTRAL_HOOK_TIMEOUT_MS | 钩子执行超时 |
| `HEALTH_MIN_SUCCESS_RATE` | 0.7 | 健康检查最低成功率 |
| `SHELL_MAX_BUFFER` | 1MB | Shell输出最大缓冲 |
| `SHELL_OUTPUT_TRUNCATE` | 500 | Shell输出截断长度 |
| `MONITOR_HISTORY_MAX` | 来自hook-handlers | 监控历史最大记录数 |

## 使用示例

```javascript
const ProgrammableHookExecutor = require('./src/runtime/workflow/programmable-hook-executor');

const executor = new ProgrammableHookExecutor('/path/to/project');

executor.register('pre:skill:execute', {
  type: 'builtin',
  name: 'path_validation',
  id: 'pre-skill-path-check'
});

executor.register('pre:skill:execute', {
  type: 'function',
  id: 'custom-validator',
  handler: (context) => {
    if (!context.skill_id) {
      return { passed: false, reason: 'Missing skill_id' };
    }
    return { passed: true, message: 'Valid' };
  }
});

executor.register('post:skill:execute', {
  type: 'shell',
  id: 'post-notify',
  command: 'echo "Skill {{skill_id}} completed"'
});

const results = await executor.execute('pre:skill:execute', {
  skill_id: 'tdd-implement',
  file_path: '/path/to/project/src/module.js',
  agent_id: 'task-worker'
});

const allPassed = results.every(r => r.passed);
const monitorData = executor.getHookMonitorData();
console.log('全局成功率:', monitorData.global.successRate + '%');

executor.shutdown();
```

## 依赖关系

- 依赖：`../../utils/constants.js` — 常量定义、危险Shell模式
- 依赖：`../../utils/debug-logger.js` — 调试日志
- 依赖：`../../utils/safe-assign.js` — 配置合并
- 依赖：`../../utils/ring-buffer.js` — 环形缓冲（监控数据）
- 依赖：`../../utils/unique-id.js` — ID生成
- 依赖：`../../utils/shutdown-mixin.js` — 优雅关闭
- 依赖：`../../utils/safe-execute.js` — 安全执行工具
- 依赖：`../../errors/index.js` — HookError错误类
- 依赖：`./hook-handlers.js` — 内置处理器集合
- 被依赖：`src/index.js` — 主入口装配

## 集成说明

- ProgrammableHookExecutor与PhaseOrchestrator配合：阶段转换时触发`pre:phase:change`和`post:phase:change`钩子
- 与SkillRouter配合：Skill执行前后触发`pre:skill:execute`和`post:skill:execute`钩子
- 与SessionManager配合：通过`token_budget_check`和`token_auto_record`内置处理器管理Token预算
- 内置处理器`inject_core_identity`和`inject_skill_router`用于Agent创建时自动注入框架上下文
- 监控数据可通过Dashboard的API端点暴露，用于实时监控钩子执行状况

## 相关文档

- [模块详解-CommandRouter模块](模块详解-CommandRouter模块.md)
- [模块详解-PhaseOrchestrator阶段编排器](模块详解-PhaseOrchestrator阶段编排器.md)
- [核心功能-多Agent协作流程](../core/核心功能-多Agent协作流程.md)
