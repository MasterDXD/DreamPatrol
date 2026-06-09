# 模块详解-Dashboard数据提供者

## 概述

Dashboard 数据提供者模块位于 `src/web/dashboard/data-providers/`，负责为 Web Dashboard 提供结构化的 API 数据。采用 Mixin 模式将数据获取逻辑按领域分离到独立模块。

## 模块结构

```
data-providers/
├── index.js              # 主入口，组合所有 Mixin
├── agent-data.js         # Agent 生命周期/监控/部署/状态数据
├── core-data.js          # 核心数据（概览/Agent列表/Skill列表/会话/工作流）
├── design-data.js        # 设计系统审计/预设/CSS 生成数据
├── framework-data.js     # 框架状态检测（模块加载/依赖/资源配置）
├── framework-modules.js  # 框架模块注册表常量（CORE_MODULES/依赖顺序/期望数量）
├── health-data.js        # 健康检查（liveness/readiness/性能统计）
├── infra-data.js         # 基础设施统计/配置/监控数据
├── deepening-data.js     # 深化推理模块数据（注册表+代理）
└── provider-helpers.js   # 共享工具函数（_apiError, _registerStatsAccessor 等）
```

## Mixin 架构

### applyDeepeningMixin(DashboardServer)

主 Mixin，将所有子 Mixin 组合到 DashboardServer 类上：

1. 挂载 `DEEPENING_API_REGISTRY` 到类静态属性
2. 绑定深化统计/质量/Token/仪表盘方法
3. 根据 `DEEPENING_PROXY_METHODS` 自动生成代理方法
4. 依次调用 `applyAgentMixin`、`applyDesignMixin`、`applyInfraMixin`

### applyAgentMixin(Klass)

提供 Agent 相关的 20+ 数据端点（仅列出关键方法，完整方法列表参见源码）：

| 方法 | 数据源 | 说明 |
|------|--------|------|
| `_getAgentLifecycle` | agentLifecycle | Agent 生命周期状态 |
| `_getAgentMonitorMetrics` | agentMonitor | Agent 监控指标 |
| `_getAgentDeploymentList` | agentDeployment | 部署列表 |
| `_getAgentStateInfo` | agentStateManager | Agent 状态快照 |
| `_getSubagentStats` | subagentExecutor | 子 Agent 统计 |
| `_getAgentPacksList` | agentPackManager | Agent 包列表 |

### applyDesignMixin(Klass)

提供设计系统相关的 15+ 数据端点，包含输入验证和安全检查（仅列出关键方法，完整方法列表参见源码）：

| 方法 | 说明 | 安全检查 |
|------|------|---------|
| `_getDesignAudit` | 设计审计 | 危险模式检测+控制字符检查 |
| `_checkContrast` | 对比度检查 | Hex 颜色格式验证 |
| `_auditAccessibility` | 无障碍审计 | 危险模式检测+控制字符检查 |
| `_generateDesignCSS` | CSS 生成 | 类型/组件白名单验证 |
| `_getSectionCSS` | Section CSS | 参数完整性验证 |

#### 共享验证函数

从 `applyDesignMixin` 内部提取到模块级别的验证函数：

- `_validateSource(source)` — 验证源代码输入（长度限制+XSS检测+控制字符）
- `_validateHexColor(value, paramName)` — 验证 Hex 颜色格式

### applyInfraMixin(Klass)

提供基础设施相关的 20+ 数据端点（仅列出关键方法，完整方法列表参见源码）：

| 方法 | 数据源 | 说明 |
|------|--------|------|
| `_getGeneratorVerifierStats` | generatorVerifier | 生成器验证统计 |
| `_getCommandRouterStats` | commandRouter | 命令路由统计 |
| `_getProgrammableHookStats` | programmableHookExecutor | 钩子执行统计 |
| `_getContextCompressionStats` | contextCompressionEngine | 上下文压缩统计 |
| `_getHookMonitorData` | programmableHookExecutor | 钩子监控数据 |

### applyFrameworkMixin(Klass)

提供框架整体状态检测（仅列出关键方法，完整方法列表参见源码）：

| 方法 | 说明 |
|------|------|
| `_getFrameworkStatus` | 框架综合状态（模块加载/依赖/资源/运行时） |

内部辅助函数：

- `_scanModuleStatus()` — 扫描 CORE_MODULES 中各模块的加载状态，带缓存
- `_loadFrameworkConfig(root)` — 加载 .harness/config.json 配置
- `_scanResources(root, scanMarkdownDir)` — 扫描 agents/skills/rules 目录资源
- `_checkDependencies(moduleStatus)` — 检查模块依赖是否满足
- `_buildRuntimeInfo(runtime)` — 构建运行时模块初始化信息

### framework-modules.js（常量模块）

非 Mixin，导出框架模块注册表常量，供 `framework-data.js` 和 `deepening-data.js` 引用：

| 常量 | 说明 |
|------|------|
| `CORE_MODULES` | 55 个核心模块的名称与路径注册表 |
| `MODULE_DEPENDENCY_ORDER` | 模块依赖顺序声明（含 deprecated 标记） |
| `EXPECTED_RUNTIME_MODULE_COUNT` | 期望运行时模块数量（30） |

### core-data.js（核心数据模块）

非 Mixin，直接导出纯函数，由 `server.js` 调用并挂载到 DashboardServer：

| 函数 | 说明 |
|------|------|
| `getOverview(server)` | 项目概览（版本/Agent数/Skill数/Token用量/TDD配置） |
| `getAgents(server)` | Agent 列表（从 .harness/agents/ frontmatter 解析） |
| `getSkills(server)` | Skill 列表（从 .harness/skills/ frontmatter 解析） |
| `getSessions(server)` | 会话列表（从 .harness/sessions/ JSON 解析，含深度验证） |
| `getWorkflow(server, CACHE_TTL)` | 工作流状态（六阶段进度/已完成Skill/预算分配） |

### health-data.js（健康检查模块）

非 Mixin，直接导出纯函数，由 `server.js` 调用：

| 函数 | 说明 |
|------|------|
| `getHealth(server)` | 综合健康状态（80+ 依赖模块可用性检测 + 内存/运行时间） |
| `getLiveness(_server)` | 存活探针（进程 PID + uptime） |
| `getReadiness(server)` | 就绪探针（依赖健康检查结果） |
| `getPerformanceStats(_server)` | 性能统计（内存/CPU/uptime） |

## DEEPENING_API_REGISTRY

声明式注册表，定义 40+ 深化模块的数据获取方式：

```javascript
const DEEPENING_API_REGISTRY = {
  'deepeningCircuitBreaker': { details: [] },
  'deepeningTaskQueue': {
    details: [{ key: 'completed', method: 'getCompletedTasks', args: [10] }]
  },
  'deepeningLockManager': {
    details: [
      { key: 'locks', method: '_locks', transform: (v) => { /* ... */ } },
      { key: 'expiredLocks', method: 'getExpiredLocks' }
    ]
  },
};
```

每个条目支持三种数据获取模式：
1. **直接方法调用** — `{ key, method, args? }`
2. **枚举模式** — `{ key, method, enumerate }` — 先获取名称列表，再逐个查询
3. **变换模式** — `{ key, method, transform }` — 对原始值应用变换函数

## 代码风格规范

所有数据提供者文件统一遵循以下规范：

- 使用 `const`/`let` 声明变量，禁止 `var`
- 验证常量使用模块级 `const` + `Set`（如 `VALID_DESIGN_TYPES`）
- 错误返回使用 `_apiError()` 统一格式
- 不可用模块返回 `{ available: false, ... }` 格式
