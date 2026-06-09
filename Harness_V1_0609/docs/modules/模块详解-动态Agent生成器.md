# 模块详解-动态Agent生成器

> 版本：2.73.4 | 文件：src/runtime/agent/dynamic-agent-spawner.js | 行数：~275行

---

## 模块定位

DynamicAgentSpawner是动态Agent生成器，基于EventEmitter扩展，是Agent子系统的动态Agent创建组件。它支持从自然语言任务描述自动推导Agent配置，提供6种内置模板和WORKER/TEAM两种生成模式，填补了Harness框架在动态Agent创建方面的空白。该模块融合了Claude Code扩展功能的动态Agent创建机制，使Agent的创建从手动配置变为智能推导。

## 设计理念

Claude Code扩展通过Subagents机制实现并行任务处理，但Agent的创建通常需要手动配置角色、能力和资源参数。DynamicAgentSpawner通过模板匹配和任务分类，实现：

- **自然语言驱动**：从任务描述自动推导最适合的Agent模板
- **模板匹配**：通过关键词匹配将任务描述映射到6种内置模板
- **双模式生成**：WORKER模式（临时工，隔离上下文）和TEAM模式（团队协作，共享上下文）
- **自定义扩展**：支持注册自定义模板，扩展Agent类型
- **生命周期追踪**：跟踪生成Agent的状态（spawned → completed/failed）

## 类定义

```javascript
class DynamicAgentSpawner extends EventEmitter {
  constructor(agentRuntime, config)
  spawnFromTask(taskDescription, options)
  completeAgent(agentId, result)
  failAgent(agentId, error)
  getSpawnedAgent(agentId)
  listSpawnedAgents()
  getTemplates()
  registerTemplate(templateKey, template)
  getStats()
  shutdown() // via withShutdown mixin
  isHealthy()
}
```

## 构造函数

### `constructor(agentRuntime, config)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentRuntime` | object | 是 | Agent运行时实例 |
| `config` | object | 否 | 配置选项 |
| `config.maxSpawnedAgents` | number | 否 | 最大生成Agent数，默认20 |
| `config.defaultSpawnMode` | string | 否 | 默认生成模式，默认`SPAWN_MODES.WORKER` |
| `config.defaultTokenBudget` | number | 否 | 默认Token预算，默认50000 |
| `config.defaultTimeoutMs` | number | 否 | 默认超时时间（毫秒），默认300000 |
| `config.maxRetries` | number | 否 | 最大重试次数，默认1 |

初始化内部状态：
- `_agentRuntime` — Agent运行时引用
- `_spawnedAgents` — Map，agentId → 生成信息
- `_stats` — 统计信息（生成数、完成数、失败数、按模板和模式统计）

## 公开方法详解

### `spawnFromTask(taskDescription, options)`

从自然语言任务描述生成Agent。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskDescription` | string | 是 | 自然语言任务描述，非空字符串 |
| `options` | object | 否 | 生成选项 |
| `options.spawnMode` | string | 否 | 生成模式，默认使用`defaultSpawnMode` |
| `options.agentId` | string | 否 | 自定义Agent ID |
| `options.modelTier` | string | 否 | 模型层级，覆盖模板默认值 |
| `options.maxTokens` | number | 否 | 最大Token数，覆盖模板默认值 |
| `options.timeout` | number | 否 | 超时时间，覆盖默认值 |

**返回值**：`object` — 生成信息

```javascript
{
  agentId: string,
  taskDescription: string,
  templateKey: string,
  role: string,
  spawnMode: string,
  config: {
    role: string,
    capabilities: Array<string>,
    modelTier: string,
    maxTokens: number,
    triggerMode: string,
    spawnMode: string,
    task: string,
    timeout: number,
    isolatedContext: boolean,   // WORKER模式为true
    returnSummary: boolean,     // WORKER模式为true
    persistent: boolean,        // TEAM模式为true
  },
  spawnedAt: string,            // ISO时间戳
  status: 'spawned',
}
```

**行为细节**：
- 任务描述为空时抛出Error
- 达到`maxSpawnedAgents`上限时触发`spawn-limit-reached`事件并抛出Error
- 自动匹配最佳模板（基于关键词评分）
- 无匹配模板时回退到`researcher`模板
- 自动生成唯一Agent ID（格式：`dynamic-{role}-{timestamp}-{random}`）
- 触发`agent-spawned`事件

### `completeAgent(agentId, result)`

标记Agent为已完成。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | Agent标识符 |
| `result` | any | 否 | 执行结果 |

**返回值**：`boolean` — 标记成功返回true，Agent不存在返回false

**行为细节**：
- 更新状态为`'completed'`
- 记录完成时间和结果
- 触发`agent-completed`事件

### `failAgent(agentId, error)`

标记Agent为失败。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | Agent标识符 |
| `error` | any | 是 | 错误信息 |

**返回值**：`boolean` — 标记成功返回true，Agent不存在返回false

**行为细节**：
- 更新状态为`'failed'`
- 记录失败时间和错误
- 触发`agent-failed`事件

### `getSpawnedAgent(agentId)`

获取生成Agent的信息。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | Agent标识符 |

**返回值**：`object | null`

### `listSpawnedAgents()`

列出所有生成Agent的摘要。

**返回值**：`Array<{agentId, role, spawnMode, status, spawnedAt}>`

### `getTemplates()`

获取所有可用模板。

**返回值**：`object` — 模板映射的副本

### `registerTemplate(templateKey, template)`

注册自定义模板。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `templateKey` | string | 是 | 模板键，非空字符串 |
| `template` | object | 是 | 模板定义，必须包含`role`字段 |
| `template.role` | string | 是 | Agent角色 |
| `template.capabilities` | Array | 否 | 能力列表，默认空数组 |
| `template.modelTier` | string | 否 | 模型层级，默认`'medium'` |
| `template.maxTokens` | number | 否 | 最大Token数，默认50000 |
| `template.triggerMode` | string | 否 | 触发模式，默认`'fire_and_forget'` |
| `template.description` | string | 否 | 描述，默认空 |

**返回值**：无

**行为细节**：
- templateKey为空时抛出Error
- 模板缺少role字段时抛出Error
- 触发`template-registered`事件

### `getStats()`

获取统计信息。

**返回值**：

```javascript
{
  totalSpawned: number,
  totalCompleted: number,
  totalFailed: number,
  byTemplate: { [templateKey]: number },
  byMode: { worker: number, team: number },
  activeAgents: number,
}
```

## 模板匹配机制

`_matchTemplate`方法通过关键词评分匹配最佳模板：

1. 将任务描述转为小写
2. 遍历`TASK_KEYWORD_MAP`，计算每个模板的关键词命中数
3. 选择命中数最高的模板
4. 无匹配时回退到`researcher`模板

### 内置关键词映射

| 模板 | 关键词 |
|------|--------|
| `code_reviewer` | review, 审查, code review, 代码审查, 质量检查, quality check |
| `test_runner` | test, 测试, coverage, 覆盖率, regression, 回归 |
| `doc_writer` | doc, 文档, document, readme, api doc, 注释, comment |
| `debugger` | debug, 调试, error, 错误, bug, fix, 修复, crash, 崩溃 |
| `researcher` | research, 研究, analyze, 分析, search, 搜索, investigate, 调查 |
| `deployer` | deploy, 部署, release, 发布, ci/cd, pipeline, infrastructure, 基础设施 |

## 导出常量

### SPAWN_MODES

生成模式枚举。

| 属性 | 值 | 说明 |
|------|---|------|
| `WORKER` | `'worker'` | 临时工模式：单次执行，隔离上下文，仅返回摘要 |
| `TEAM` | `'team'` | 团队模式：多轮协作，共享上下文，持久状态 |

### AGENT_TEMPLATES

内置Agent模板定义，包含6种模板：

| 模板键 | 角色 | 模型层级 | 最大Token | 能力 |
|--------|------|---------|----------|------|
| `code_reviewer` | code-reviewer | medium | 50000 | code-review, security-audit, quality-assessment |
| `test_runner` | test-runner | small | 30000 | test-execution, coverage-analysis, regression-detection |
| `doc_writer` | doc-writer | small | 40000 | documentation, api-docs, markdown |
| `debugger` | debugger | large | 80000 | debugging, error-analysis, fix-suggestion |
| `researcher` | researcher | large | 100000 | research, analysis, summarization |
| `deployer` | deployer | medium | 40000 | deployment, ci-cd, infrastructure |

## 事件列表

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `agent-spawned` | Agent生成 | `{agentId, role, spawnMode, taskDescription}` |
| `agent-completed` | Agent完成 | `{agentId, role}` |
| `agent-failed` | Agent失败 | `{agentId, role, error}` |
| `spawn-limit-reached` | 达到生成上限 | `{max}` |
| `template-registered` | 自定义模板注册 | `{templateKey, role}` |

## 使用示例

### 从任务描述生成Agent

```javascript
const { DynamicAgentSpawner, SPAWN_MODES } = require('./src/runtime/agent/dynamic-agent-spawner');

const spawner = new DynamicAgentSpawner(agentRuntime, {
  maxSpawnedAgents: 20,
  defaultSpawnMode: SPAWN_MODES.WORKER,
});

// 自动匹配模板：将匹配到 code_reviewer
const spawn1 = spawner.spawnFromTask('请审查这段代码的质量和安全性', {
  spawnMode: SPAWN_MODES.WORKER,
});
console.log(`生成Agent: ${spawn1.agentId}, 角色: ${spawn1.role}`);

// 匹配到 debugger
const spawn2 = spawner.spawnFromTask('调试这个崩溃bug并修复');
console.log(`生成Agent: ${spawn2.agentId}, 角色: ${spawn2.role}`);
```

### TEAM模式（团队协作）

```javascript
const spawn = spawner.spawnFromTask('分析项目架构并生成文档', {
  spawnMode: SPAWN_MODES.TEAM,
  maxTokens: 60000,
});
// TEAM模式特性：
// - isolatedContext: false（共享上下文）
// - returnSummary: false（返回完整结果）
// - persistent: true（持久状态）
```

### 自定义模板

```javascript
spawner.registerTemplate('perf-analyzer', {
  role: 'performance-analyzer',
  capabilities: ['profiling', 'benchmark', 'optimization'],
  modelTier: 'large',
  maxTokens: 80000,
  description: '性能分析Agent，分析性能瓶颈并提供优化建议',
});

// 使用自定义模板
const spawn = spawner.spawnFromTask('分析性能瓶颈并优化');
console.log(`模板: ${spawn.templateKey}, 角色: ${spawn.role}`);
```

### Agent生命周期管理

```javascript
// 生成Agent
const spawn = spawner.spawnFromTask('运行测试并分析覆盖率');

// 标记完成
spawner.completeAgent(spawn.agentId, {
  coverage: 85,
  passed: 42,
  failed: 3,
});

// 标记失败
spawner.failAgent(spawn.agentId, '测试运行超时');

// 查看所有生成Agent
const agents = spawner.listSpawnedAgents();
for (const agent of agents) {
  console.log(`${agent.agentId}: ${agent.role} [${agent.status}]`);
}
```

### 事件监听

```javascript
spawner.on('agent-spawned', ({ agentId, role, spawnMode, taskDescription }) => {
  console.log(`Agent生成: ${role} (${spawnMode}), 任务: ${taskDescription}`);
});

spawner.on('agent-completed', ({ agentId, role }) => {
  console.log(`Agent完成: ${role}`);
});

spawner.on('spawn-limit-reached', ({ max }) => {
  console.warn(`达到Agent生成上限: ${max}`);
});
```

### 查看可用模板

```javascript
const templates = spawner.getTemplates();
for (const [key, tmpl] of Object.entries(templates)) {
  console.log(`${key}: ${tmpl.description}`);
  console.log(`  模型: ${tmpl.modelTier}, Token上限: ${tmpl.maxTokens}`);
  console.log(`  能力: ${tmpl.capabilities.join(', ')}`);
}
```

## 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxSpawnedAgents` | number | 20 | 最大同时生成Agent数 |
| `defaultSpawnMode` | string | `'worker'` | 默认生成模式 |
| `defaultTokenBudget` | number | 50000 | 默认Token预算 |
| `defaultTimeoutMs` | number | 300000 | 默认超时时间（毫秒） |
| `maxRetries` | number | 1 | 最大重试次数 |

## 与其他模块的关系

- **依赖**：`events`（Node.js内置） — EventEmitter基类
- **依赖**：`../../utils/shutdown-mixin.js` — 优雅关闭
- **依赖**：AgentRuntime — Agent运行时实例
- **协作**：ContextBudgetOptimizer — 子Agent生成时检查上下文预算配额（SUBAGENTS层）
- **协作**：EventBus — 通过事件总线发布Agent生命周期事件
- **协作**：AgentOrchestrator — 编排器可使用DynamicAgentSpawner动态创建Agent
- **被依赖**：SharedInfrastructure — 作为Agent子系统的动态创建组件

## 相关文档

- [模块详解-EventBus模块](模块详解-EventBus模块.md)
- [模块详解-上下文预算优化器](模块详解-上下文预算优化器.md)
- [模块详解-Hook组合器](模块详解-Hook组合器.md)
- [核心功能-多Agent协作流程](../core/核心功能-多Agent协作流程.md)
