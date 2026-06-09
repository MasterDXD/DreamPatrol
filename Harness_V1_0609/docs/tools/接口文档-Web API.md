﻿﻿﻿﻿# 接口文档-Web API

## 概述
Harness Engineering 多Agent框架提供基于HTTP的RESTful API和WebSocket实时推送，用于仪表盘前端和外部系统集成。所有API端点通过 `DashboardServer` 提供，默认端口由配置决定。

### 认证方式
- **GET请求**：无需认证（只读操作）
- **POST请求**：需在请求头携带 `Authorization: Bearer <HARNESS_API_TOKEN>`
  - 生产环境：必须设置 `HARNESS_API_TOKEN` 环境变量
  - 开发环境：未设置Token时仅允许localhost来源的POST请求
- **WebSocket**：支持三种认证方式（按优先级排序）：
  1. `Authorization: Bearer <token>` 请求头（优先检查）
  2. `sec-websocket-protocol` 头传递Token
  3. 连接后通过消息认证：`{ "type": "auth", "token": "..." }`

### 通用响应格式
```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2026-05-07T00:00:00.000Z"
}
```

错误响应：
```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE",
  "timestamp": "2026-05-07T00:00:00.000Z"
}
```

---

## 一、核心仪表盘 API

### GET /api/overview
获取系统概览信息，包括Agent数量、Skill数量、会话状态等。

**响应示例**：
```json
{
  "agents": { "total": 16, "active": 3 },
  "skills": { "total": 36, "verified": 19 },
  "sessions": { "active": 1, "total": 5 },
  "phase": "module-development",
  "tokenUsage": { "used": 1500000, "budget": 1000000000, "percentage": 0.15 }
}
```

### GET /api/agents
获取所有Agent定义和状态。

### GET /api/skills
获取所有Skill定义，包含Frontmatter元数据。

### GET /api/sessions
获取活跃会话列表。

### GET /api/workflow
获取当前工作流状态。

### GET /api/config
获取框架配置（敏感字段已脱敏）。

### GET /api/changelog
获取变更日志。

### GET /api/changelog/search
变更日志搜索（支持keyword/category参数）。

**查询参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| keyword | string | 搜索关键词 |
| category | string | 按类别过滤 |

### GET /api/changelog/archive
变更日志归档数据。

### GET /api/changelog/stats
变更日志统计。

### GET /api/changelog/verify
变更日志完整性验证。

### GET /api/audit
获取审计日志摘要。

### GET /api/memory
获取记忆存储状态。

### GET /api/health
获取系统健康检查结果（30+项检查）。

### GET /api/version
获取框架版本信息。

---

## 二、框架信息 API

### GET /api/framework/status
获取框架运行状态。

### GET /api/framework/architecture
获取架构信息，包括模块初始化顺序和依赖关系。

### GET /api/framework/features
获取框架特性列表。

---

## 三、合规检查 API

### GET /api/compliance
获取框架合规检查结果，包括违规项和摘要。

### GET /api/workflow-templates
获取工作流模板列表。

---

## 四、设计系统 API

### GET /api/design/stats
获取设计系统统计信息。

### GET /api/design/audit?source={encodedSource}&type={type}
设计反模式审计。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| source | string | 是 | URL编码的源代码（最大长度限制） |
| type | string | 否 | 审计类型：`css`（默认）/ `html` / `js` |

**安全校验**：危险模式检测（script标签/javascript协议/事件处理器/iframe/embed/object/data URI），控制字符过滤。

**响应示例**：
```json
{
  "score": 0.85,
  "grade": "A",
  "issues": [
    { "type": "pure-black", "message": "使用纯黑色#000000", "suggestion": "替换为zinc-900" }
  ],
  "summary": "设计质量良好，发现1个反模式"
}
```

### GET /api/design/presets
获取设计预设列表。

### GET /api/design/companies
获取公司设计语言参考（Apple/Stripe/Vercel/Notion/GitHub）。

### GET /api/design/generate-md
生成DESIGN.md文档。

### GET /api/design/contrast-check?fg={hex}&bg={hex}
WCAG对比度检查。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| fg | string | 是 | 前景色HEX值（如#000000） |
| bg | string | 是 | 背景色HEX值（如#ffffff） |

**响应**：
```json
{
  "ratio": 21.0,
  "aa": true,
  "aaLarge": true,
  "aaa": true,
  "aaaLarge": true
}
```

### GET /api/design/accessibility-audit?source={encodedSource}
无障碍审计。

### GET /api/design/generate-css?type={type}
生成设计系统CSS变量。

### GET /api/design/section/tokens
获取Section组件Token定义（变体、间距、标题尺寸等）。

**参数**：`variant`（可选）、`spacing`（可选）

### GET /api/design/section/css
获取Section组件CSS（基础+变体样式）。

**参数**：`variant`（默认default）、`spacing`（默认default）、`accentColor`、`titleSize`、`borderRadius`

### GET /api/design/section/variants
获取Section组件所有可用变体列表（default/collapsible/accent/bordered/hero）。

### GET /api/design/section/validate
验证Section组件配置参数的合法性。

**参数**：`variant`、`spacing`、`accentColor`、`collapsible`、`titleSize`、`borderRadius`

### GET /api/design/section/presets
获取Section组件预设配置列表（信息面板/可折叠详情/状态指示等10种预设）。

**参数**：`category`（可选，按类别过滤：layout/interactive/status）

### GET /api/affinity/records
获取用户偏好学习记录列表。

---

## 五、Agent管理 API

### GET /api/agent-lifecycle/list
获取Agent生命周期列表。

### GET /api/agent-runtime/stats
获取Agent运行时统计。

### GET /api/agent-runtime/resource-pool
获取Agent资源池状态。

### GET /api/agent-monitor/dashboard
获取Agent监控仪表盘数据。

### GET /api/agent-deployment/environments
获取Agent部署环境列表。

### GET /api/agent-state/list
获取Agent状态快照列表。

### GET /api/agent-workflow/stats
获取Agent工作流统计。

### GET /api/agent-sandbox/list
获取Agent沙箱列表。

### GET /api/agent-lifecycle
Agent生命周期数据。

### GET /api/agent-lifecycle/history
Agent生命周期历史。

### GET /api/agent-monitor/metrics
Agent监控指标。

### GET /api/agent-monitor/alerts
Agent监控告警。

### GET /api/agent-monitor/logs
Agent监控日志。

### GET /api/agent-deployment/list
Agent部署列表。

### GET /api/agent-deployment/versions
Agent部署版本。

### GET /api/agent-state/info
Agent状态信息。

### GET /api/agent-state/snapshots
Agent状态快照。

### GET /api/agent-workflow/tasks
获取Agent工作流任务列表。

**查询参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentId | string | 否 | 按Agent ID过滤 |
| state | string | 否 | 按任务状态过滤：pending/queued/running/completed/failed/cancelled/retrying |
| type | string | 否 | 按触发类型过滤：manual/event/schedule/dependency/webhook |

**响应示例**：
```json
{ "tasks": [] }
```

### GET /api/agent-sandbox/access-log
获取Agent沙箱访问日志。

**查询参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentId | string | 否 | 按Agent ID过滤 |
| resource | string | 否 | 按资源类型过滤：filesystem/network/child_process/env/module |
| deniedOnly | boolean | 否 | 仅返回被拒绝的访问记录（默认false） |
| limit | number | 否 | 返回条数限制（默认50） |

**响应示例**：
```json
{ "logs": [] }
```

---

## 六、深化子系统 API（46+端点）

### GET /api/deepening/stats
获取深化子系统总体统计。

### GET /api/deepening/dashboard
获取深化仪表盘数据。

### GET /api/deepening/quality
获取质量评分历史。

### GET /api/deepening/token-budget
获取Token预算使用情况。

### GET /api/deepening/metrics
获取深化指标数据。

### GET /api/deepening/cache
获取缓存状态。

### GET /api/deepening/convergence
获取收敛检测状态。

### GET /api/deepening/pipeline
获取深化管道状态。

### GET /api/deepening/health
获取深化子系统健康状态。

### GET /api/deepening/events
获取深化事件列表。

### GET /api/deepening/templates
获取深化工作流模板。

### GET /api/deepening/benchmark
获取基准测试结果。

### GET /api/deepening/state-machine
获取状态机状态。

### GET /api/deepening/errors
获取深化错误统计。

### GET /api/deepening/snapshots
获取快照列表。

### GET /api/deepening/notifications
获取通知列表。

### GET /api/deepening/circuit-breaker
获取熔断器状态。

### GET /api/deepening/task-queue
获取任务队列状态。

### GET /api/deepening/resources
获取资源管理状态。

### GET /api/deepening/audit
获取深化审计追踪。

### GET /api/deepening/config
获取深化配置。

### GET /api/deepening/health-monitor
⚠️ **已废弃**，替代端点：`/api/infrastructure/health-checker`。获取健康监控数据。

### GET /api/deepening/dependencies
获取依赖关系图。

### GET /api/deepening/throttle
获取节流器状态。

### GET /api/deepening/validator
获取验证器状态。

### GET /api/deepening/locks
获取锁管理状态。

### GET /api/deepening/event-replay
获取事件回放数据。

### GET /api/deepening/priority-queue
⚠️ **已废弃**，替代端点：`/api/infrastructure/priority-queue`。获取优先级队列状态。

### GET /api/deepening/metrics-aggregator
获取指标聚合数据。

### GET /api/deepening/rate-limiter
获取限流器状态。

### GET /api/deepening/snapshot-store
获取快照存储状态。

### GET /api/deepening/backpressure
获取背压管理状态。

### GET /api/deepening/connection-pool
获取连接池状态。

### GET /api/deepening/retry-policy
获取重试策略配置。

### GET /api/deepening/service-registry
获取服务注册表。

### GET /api/deepening/load-balancer
获取负载均衡器状态。

### GET /api/deepening/timeout-manager
获取超时管理状态。

### GET /api/deepening/graceful-shutdown
获取优雅关闭状态。

### GET /api/deepening/feature-flags
获取特性开关状态。

### GET /api/deepening/task-scheduler
获取任务调度器状态。

### GET /api/deepening/data-pipeline
获取数据管道状态。

### GET /api/deepening/state-manager
获取状态管理器状态。

### GET /api/deepening/event-bus
⚠️ **已废弃**，替代端点：`/api/infrastructure/event-bus`。获取事件总线状态。

### GET /api/deepening/config-manager
获取配置管理器状态。

### GET /api/deepening/resource-manager
获取资源管理器状态。

### GET /api/deepening/audit-trail
获取审计追踪记录。

### GET /api/deepening-registry/stats
获取深化模块注册表统计（已注册模块数、懒加载命中率等）。

---

## 七、子Agent API

### GET /api/subagent/stats
获取子Agent执行统计（成功率/平均Token/活跃数）。

### GET /api/subagent/active
获取当前活跃的子Agent句柄列表。

### GET /api/subagent/budget
获取子Agent Token预算报告。

### GET /api/subagent/model-stats
获取模型使用统计。

---

## 八、协作模式 API

### GET /api/collaboration/modes
获取所有协作模式定义。

### GET /api/collaboration/stats
获取协作模式选择统计。

### GET /api/collaboration/history
获取协作模式选择历史。

### GET /api/channel/stats
获取Agent通道统计。

### GET /api/pair-chat/stats
获取结对编程统计。

### GET /api/pair-chat/sessions
获取结对编程会话列表。

### GET /api/chat-chain/stats
获取链式对话统计。

### GET /api/chat-chain/chains
获取链式对话列表。

### GET /api/output-fusion/stats
获取输出融合统计。

### GET /api/intent/stats
获取结构化意图统计。

### GET /api/intent/schemas
获取意图解析Schema。

---

## 九、技能管理 API

### GET /api/skill-layers/stats
获取Skill三层缓存统计（L1/L2/L3 Token估算）。

### GET /api/skill-layers/dedup
获取Skill内容去重报告。

### GET /api/skill-layers/context
获取上下文Token估算。

### GET /api/skill-improvement/pending
获取待处理的技能改进补丁。

### GET /api/skill-improvement/stats
获取技能改进统计。

### POST /api/skill-improvement/apply
应用技能改进补丁。

**请求体**：
```json
{ "skillId": "tdd-implement" }
```

**响应示例**：
```json
{ "success": true, "patchApplied": true }
```

### POST /api/skill-improvement/reject
拒绝技能改进补丁。

**请求体**：
```json
{ "skillId": "tdd-implement" }
```

**响应示例**：
```json
{ "success": true }
```

### POST /api/skill-improvement/record
记录学习经验。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | string | 是 | 技能ID |
| approach | string | 否 | 采用的方法 |
| whatWorked | string | 否 | 有效做法 |
| whatFailed | string | 否 | 失败做法 |
| tips | string | 否 | 经验提示 |
| phase | string | 否 | 执行阶段 |
| context | string | 否 | 上下文描述 |

**请求体示例**：
```json
{ "skillId": "tdd-implement", "approach": "先写边界测试", "whatWorked": "边界值优先发现缺陷", "whatFailed": "先写正常路径测试", "tips": "从边界条件开始测试", "phase": "RED", "context": "实现认证模块" }
```

### GET /api/skill-creation/list
获取自动创建的Skill列表。

### GET /api/skill-creation/stats
获取Skill创建统计。

### POST /api/skill-creation/create
创建新Skill。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | string | 是 | 技能ID（最大128字符，格式：[a-z0-9-]+） |
| name | string | 是 | 技能名称 |
| description | string | 否 | 技能描述 |
| phase | string | 否 | 所属阶段（brainstorming/requirement-analysis/architecture-design/module-development/integration-testing/deployment） |
| trigger | string | 否 | 触发条件描述 |
| enforcement | string | 否 | 执行级别（strict/recommended/optional，默认recommended） |
| body | string | 否 | 技能指令正文（Markdown格式） |

**请求体示例**：
```json
{ "skillId": "custom-review", "name": "自定义审查", "description": "项目特定的代码审查流程", "phase": "module-development", "enforcement": "recommended" }
```

### GET /api/skill-curator/stats
获取Skill策展统计。

### GET /api/nudge/stats
获取记忆提醒统计。

### POST /api/nudge/evaluate
评估记忆提醒。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| context | string | 否 | 当前上下文 |
| threshold | number | 否 | 相关性阈值（0-1） |
| maxResults | number | 否 | 最大结果数（1-100） |
| category | string | 否 | 按类别过滤 |
| tags | array | 否 | 按标签过滤 |

**请求体示例**：
```json
{ "context": "正在实现认证模块", "threshold": 0.7, "maxResults": 10, "category": "architecture", "tags": ["auth", "security"] }
```

---

## 十、存储与记忆 API

### GET /api/sqlite/stats
获取SQLite存储统计。

### GET /api/sqlite/fts
获取全文搜索索引状态。

### POST /api/sqlite/knowledge
知识库CRUD操作。

**请求体**：
```json
{ "action": "add", "key": "concept-name", "value": "概念描述", "category": "architecture" }
```

支持的操作：`add`, `update`, `remove`

### GET /api/memory/entries
获取记忆条目列表。

### GET /api/memory/usage
获取记忆使用统计。

### GET /api/memory/verification
获取记忆验证状态。

### GET /api/memory/stale
获取过期的记忆条目。

### POST /api/memory/add
添加记忆条目。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| content | string | 是 | 记忆内容（最大256字符） |
| target | string | 否 | 存储目标（最大256字符，默认'memory'） |

**请求体示例**：
```json
{ "content": "用户偏好深色主题", "target": "memory" }
```

### POST /api/memory/remove
删除记忆条目。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 记忆条目ID（最大256字符） |
| target | string | 否 | 存储目标（最大256字符，默认'memory'） |

**请求体示例**：
```json
{ "id": "mem-xxx", "target": "memory" }
```

---

## 十一、目标执行 API

### GET /api/goal/list
获取目标列表。

**查询参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| status | string | 按状态过滤（PENDING/EXECUTING/COMPLETED/FAILED/PAUSED/CANCELLED） |

### GET /api/goal/stats
获取目标执行统计。

### POST /api/goal/create
创建新目标。

**请求体**：
```json
{
  "objective": "实现用户认证模块",
  "successCriteria": ["所有测试通过", "覆盖率>80%"],
  "constraints": ["使用JWT", "支持OAuth2"],
  "maxIterations": 10,
  "convergenceThreshold": 0.95,
  "context": { "projectId": "auth-module", "priority": "high" }
}
```

**参数验证**：
- `objective`：必填，非空字符串
- `successCriteria`：可选，字符串数组
- `constraints`：可选，字符串数组
- `maxIterations`：可选，1-100范围
- `convergenceThreshold`：可选，0-1范围
- `context`：可选，对象类型，最大大小受限

### POST /api/goal/pause
暂停目标执行。

**请求体**：
```json
{ "goalId": "goal-xxx" }
```

### POST /api/goal/resume
恢复目标执行。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| goalId | string | 是 | 目标ID |

**请求体示例**：
```json
{ "goalId": "goal-xxx" }
```

### POST /api/goal/cancel
取消目标。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| goalId | string | 是 | 目标ID |

**请求体示例**：
```json
{ "goalId": "goal-xxx" }
```

### POST /api/goal/progress
查询目标进度。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| goalId | string | 是 | 目标ID |

**请求体示例**：
```json
{ "goalId": "goal-xxx" }
```

**响应示例**：
```json
{
  "goalId": "goal-xxx",
  "status": "EXECUTING",
  "progress": 0.65,
  "subtaskProgress": 0.70,
  "iterationProgress": 0.55,
  "currentIteration": 5,
  "maxIterations": 10,
  "qualityScore": 0.82
}
```

---

## 十二、MCP协议 API

### GET /api/mcp/status
获取MCP客户端连接状态。

### GET /api/mcp/tools
获取可用MCP工具列表。

### POST /api/mcp/connect
连接MCP服务器。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | MCP服务器名称（最大256字符） |
| command | string | 条件必填 | 启动命令（basename必须在白名单[npx,node,python3,python,uvx,pip]中） |
| url | string | 条件必填 | 服务器URL（最大2048字符，仅http/https，禁止私有IP） |
| args | string[] | 否 | 命令参数（最多50项，每项最大1024字符，禁止危险模式） |
| env | object | 否 | 环境变量（键名禁止PATH/HOME/USER等，值最大512字符） |
| maxBuffer | number | 否 | 最大缓冲区大小（范围0-1048576） |

> **注意**：`command` 和 `url` 至少提供一个。

**请求体示例**：
```json
{ "name": "my-mcp-server", "command": "node", "args": ["server.js"], "url": "http://localhost:3000" }
```

**安全校验**：命令白名单校验，阻止`-e`/`--eval`/`-c`等危险选项，URL禁止私有IP段。

### POST /api/mcp/call-tool
调用MCP工具。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| toolName | string | 是 | 工具名称（最大256字符） |
| args | object | 否 | 工具调用参数（必须为对象，最大64KB） |

**请求体示例**：
```json
{ "toolName": "navigate", "args": { "url": "https://example.com" } }
```

---

## 十二B、OpenCLI网页交互 API

### GET /api/opencli/status
获取OpenCLI MCP服务器连接状态。方法内部包含完整的防御性编码：null检查、typeof检查、try-catch异常保护，确保任何异常情况下均返回有效的JSON响应而非500错误。

**可用状态响应**：
```json
{
  "available": true,
  "connected": true,
  "toolCount": 85,
  "serverName": "opencli"
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | MCP客户端是否已初始化且OpenCLI服务器已配置 |
| connected | boolean | OpenCLI服务器是否已连接（强制布尔值，`!!`转换） |
| toolCount | number | 可用工具数量（默认0） |
| serverName | string | 服务器名称，固定为`"opencli"` |

**不可用状态响应**：
```json
{
  "available": false,
  "message": "OpenCLI server not configured"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| MCP client not initialized | MCP客户端未初始化（`_rt('mcpClient')`返回null） |
| MCP client missing getServerStatus method | MCP客户端对象存在但缺少`getServerStatus`方法 |
| MCP server status unavailable | `getServerStatus()`返回null或非对象 |
| OpenCLI server not configured | config.json中未配置opencli服务器 |
| OpenCLI status check failed | 内部异常被try-catch捕获 |

### GET /api/opencli/servers
获取所有MCP服务器连接状态摘要。返回数据经过过滤，仅包含`connected`和`toolCount`字段，不暴露服务器内部配置细节。方法内部包含完整的防御性编码和try-catch异常保护。

**可用状态响应**：
```json
{
  "available": true,
  "servers": {
    "opencli": {
      "connected": true,
      "toolCount": 85
    },
    "filesystem": {
      "connected": false,
      "toolCount": 0
    }
  }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | MCP客户端是否可用 |
| servers | object | 各MCP服务器状态摘要（仅含connected和toolCount） |

**不可用状态响应**：
```json
{
  "available": false,
  "servers": {}
}
```

> **安全说明**：`/api/opencli/servers`端点仅返回每个服务器的`connected`状态和`toolCount`，不暴露命令行参数、环境变量等敏感配置信息。

> **使用前提**：OpenCLI默认`enabled: false`，需在`.harness/config.json`的`mcp_servers.opencli`中设置`enabled: true`并安装Chrome Bridge扩展后方可使用。

---

## 十二C、CLI-Anything 集成 API

CLI-Anything（港大HKUDS开源）将任意软件转化为AI可调用CLI工具，与OpenCLI网页交互互补。两个端点均包含完整的防御性编码：null检查、typeof检查、try-catch异常保护，确保任何异常情况下均返回有效的JSON响应而非500错误。

### GET /api/cli-anything/status
获取CLI-Anything MCP服务器连接状态。

**可用状态响应**：
```json
{
  "available": true,
  "connected": true,
  "toolCount": 12,
  "serverName": "cli-anything"
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | MCP客户端是否已初始化且CLI-Anything服务器已配置 |
| connected | boolean | CLI-Anything服务器是否已连接（强制布尔值，`!!`转换） |
| toolCount | number | 可用工具数量（默认0，`Number.isFinite`校验） |
| serverName | string | 服务器名称，固定为`"cli-anything"` |

**不可用状态响应**：
```json
{
  "available": false,
  "message": "CLI-Anything server not configured"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| MCP client not initialized | MCP客户端未初始化（`_rt('mcpClient')`返回null） |
| MCP client missing getServerStatus method | MCP客户端对象存在但缺少`getServerStatus`方法 |
| MCP server status unavailable | `getServerStatus()`返回null或非对象 |
| CLI-Anything server not configured | config.json中未配置cli-anything服务器 |
| CLI-Anything status check failed | 内部异常被try-catch捕获 |

### GET /api/cli-anything/registry
获取CLI-Anything注册的工具列表。仅返回名称以`mcp_cli-anything_`为前缀的工具，最多100条。返回数据经过截断保护：工具名称最大256字符，描述最大1024字符。

**可用状态响应**：
```json
{
  "available": true,
  "toolCount": 5,
  "tools": [
    {
      "name": "mcp_cli-anything_git_status",
      "description": "Get the current git status of the repository"
    },
    {
      "name": "mcp_cli-anything_docker_ps",
      "description": "List running Docker containers"
    }
  ],
  "truncated": false
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | MCP客户端是否可用且`getAvailableTools`方法存在 |
| toolCount | number | 返回的工具数量（最多100） |
| tools | array | 工具列表，每项含`name`和`description`字段 |
| truncated | boolean | 是否有超过100条工具被截断未返回 |

**不可用状态响应**：
```json
{
  "available": false,
  "tools": []
}
```

> **安全说明**：`/api/cli-anything/registry`端点仅返回工具名称和描述，不暴露服务器内部配置细节。工具名称和描述均经过长度截断保护。

> **使用前提**：CLI-Anything默认`enabled: false`，需在`.harness/config.json`的`mcp_servers`中配置`cli-anything`服务器并设置`enabled: true`后方可使用。

### GET /api/cli-anything/hub

获取CLI-Anything Hub目录信息，包含8大分类工具目录、安装命令参考等。

**请求参数**：无

**响应示例**：

```json
{
  "available": true,
  "connected": true,
  "totalCatalogTools": 49,
  "installedTools": 3,
  "categories": [
    {
      "id": "creative-media",
      "name": "创意与媒体工具",
      "tools": ["gimp", "blender", "inkscape", "krita", "obs-studio", "kdenlive", "shotcut", "audacity", "musecore", "openshot"]
    },
    {
      "id": "office-enterprise",
      "name": "办公与企业应用",
      "tools": ["libreoffice", "calibre", "drawio", "mermaid", "obsidian", "zotero", "notebooklm"]
    }
  ],
  "hubInstallCommand": "pip install cli-anything-hub",
  "skillInstallCommand": "npx skills add HKUDS/CLI-Anything --skill <name> -g -y"
}
```

**响应字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `available` | boolean | Hub端点是否可用 |
| `connected` | boolean | MCP服务器是否已连接 |
| `totalCatalogTools` | number | 目录中工具总数 |
| `installedTools` | number | 已安装工具数量 |
| `categories` | array | 工具分类列表 |
| `categories[].id` | string | 分类ID |
| `categories[].name` | string | 分类名称 |
| `categories[].tools` | string[] | 分类下的工具名称列表 |
| `hubInstallCommand` | string | Hub安装命令 |
| `skillInstallCommand` | string | SKILL.md安装命令 |

---

## 十三、运行时基础设施 API

### GET /api/command-router/stats
获取命令路由统计。

### GET /api/command-router/commands
获取所有斜杠命令列表。

### GET /api/programmable-hook/stats
获取Hook执行统计。

### GET /api/programmable-hook/hooks
获取已注册Hook列表。

### GET /api/programmable-hook/monitor
获取Hook监控数据。

### GET /api/programmable-hook/slow
获取慢Hook列表。

### GET /api/programmable-hook/success-rates
获取Hook成功率统计。

### GET /api/context-compression/stats
获取上下文压缩统计。

### GET /api/context-compression/strategies
获取压缩策略列表。

### GET /api/auto-version/stats
获取自动版本追踪统计。

### GET /api/auto-version/recent
获取最近版本变更。

### GET /api/agent-packs/list
获取Agent包列表。

### GET /api/agent-packs/installed
获取已安装Agent包。

### GET /api/agent-packs/stats
获取Agent包统计。

### GET /api/performance
获取系统性能指标。

### GET /api/infrastructure/health-checker
基础设施健康检查器详情（替代 /api/deepening/health-monitor）。

### GET /api/infrastructure/priority-queue
基础设施优先级队列详情（替代 /api/deepening/priority-queue）。

### GET /api/infrastructure/event-bus
基础设施事件总线统计（替代 /api/deepening/event-bus）。

---

## 十三B、RAG管道 API

### GET /api/rag/stats
RAG管道统计信息。

### GET /api/rag/query
RAG查询结果。

**查询参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `q` | string | 是 | 查询文本，最大200字符 |
| `top_k` | number | 否 | 返回结果数量，范围1-50，默认5 |

**错误响应**：
- `400` — 查询文本超过200字符或top_k超出范围

---

## 十三C、管道分析 API

### GET /api/pipeline/analyze
管道分析结果。

**查询参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 分析消息，最大1000字符 |
| `agent` | string | 否 | Agent标识，格式：`^[a-zA-Z0-9_-]{1,64}$` |

**错误响应**：
- `400` — 消息超过1000字符或agent格式不合法

---

## 十三D、优化循环 API

### GET /api/optimization/status

获取优化循环当前状态，包括循环状态、当前迭代、最优结果等。

**请求参数**：无

**响应示例**：

```json
{
  "available": true,
  "status": "idle",
  "objective": null,
  "currentIteration": 0,
  "bestScore": -Infinity,
  "bestIteration": -1,
  "constraints": [],
  "metrics": []
}
```

**响应字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `available` | boolean | 端点是否可用 |
| `status` | string | 循环状态（idle/running/paused/stopped/converged/exhausted/failed） |
| `objective` | string\|null | 优化目标描述 |
| `currentIteration` | number | 当前迭代次数 |
| `bestScore` | number | 最优分数 |
| `bestIteration` | number | 最优迭代编号 |
| `constraints` | array | 约束条件列表 |
| `metrics` | array | 指标定义列表 |

### GET /api/optimization/progress

获取优化循环进度详情，包括指标历史、策略趋势等。

**请求参数**：无

**响应示例**：

```json
{
  "available": true,
  "iterations": 15,
  "metricsHistory": [
    { "iteration": 1, "score": 0.72, "timestamp": "2026-05-29T10:00:00Z" },
    { "iteration": 2, "score": 0.85, "timestamp": "2026-05-29T10:00:02Z" }
  ],
  "stagnationCounter": 0,
  "consecutiveFailures": 0
}
```

### GET /api/optimization/journal

获取优化循环的Markdown格式日志。

**请求参数**：无

**响应示例**：

```json
{
  "available": true,
  "journal": "# Optimization Journal\n\n## Objective: 优化API响应时间\n...",
  "length": 2048
}
```

---

## 十四、其他 API

### GET /api/user/profile
获取用户偏好和模型。

### POST /api/user/profile
更新用户偏好。支持三种操作模式：

**模式1 — 设置偏好键值**：
```json
{ "key": "theme", "value": "dark" }
```

**模式2 — 学习交互记录**：
```json
{ "learn": "用户偏好中文界面" }
```

**模式3 — 删除偏好键**：
```json
{ "removeKey": "temp_setting" }
```

### GET /api/affinity/stats
获取亲和度学习统计。

### POST /api/affinity/record
记录亲和度执行数据。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentId | string | 是 | Agent ID |
| taskType | string | 是 | 任务类型 |
| qualityScore | number | 是 | 质量评分 |
| duration | number | 否 | 执行时长 |

**请求体示例**：
```json
{ "agentId": "task-worker-01", "taskType": "code-review", "qualityScore": 0.85, "duration": 120 }
```

### POST /api/affinity/recommendations
获取亲和度推荐。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| taskType | string | 是 | 任务类型 |
| agentIds | array | 是 | 候选Agent ID列表（最多100个） |

**请求体示例**：
```json
{ "taskType": "code-review", "agentIds": ["task-worker-01", "analyst-01"] }
```

### GET /api/thoughts/stats
获取思维检索统计。

### GET /api/thoughts/list
获取思维列表。

### GET /api/embedding/stats
获取嵌入服务统计。

### GET /api/thought-retriever/stats
获取思维检索循环统计。

### GET /api/model-selector/stats
获取模型选择器统计。

### GET /api/generator-verifier/stats
获取生成器验证统计。

### GET /api/generator-verifier/history
获取验证历史。

### GET /api/isolated-context/stats
获取隔离上下文统计。

### GET /api/isolated-context/active
获取活跃隔离上下文列表。

### GET /api/plan/stats
获取计划统计。

### GET /api/plan/active
获取活跃计划。

### GET /api/panorama/metadata
获取Agent全景图元数据。

### GET /api/session/previous-context
获取上一个会话上下文（用于恢复）。

### GET /api/checkpoints
获取检查点列表。

**查询参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| sessionId | string | 按会话ID过滤（格式：`[a-zA-Z0-9_-]{1,64}`） |

### GET /api/learnings
获取学习记录。

**查询参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| skillId | string | 按技能ID过滤 |
| limit | number | 返回条数限制 |

### GET /api/antipattern/rules
获取反模式检测规则。

---

## 十四B、补充端点

### GET /healthz
Kubernetes存活探针，返回服务是否运行。

**响应**：`ok`

### GET /readyz
Kubernetes就绪探针，返回服务是否就绪接受请求。

**响应**：`ok`

### GET /api/deviations
获取偏差审批记录列表。

**查询参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| status | string | 按状态过滤（pending/approved/rejected） |

**响应示例**：
```json
[{ "id": "dev-001", "type": "naming", "status": "approved", "requestedAt": "..." }]
```

### GET /api/code-reviews
获取代码审查记录列表。

**查询参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| status | string | 按状态过滤（pending/approved/rejected） |
| module | string | 按模块过滤 |

**响应示例**：
```json
[{ "id": "cr-001", "module": "runtime", "status": "pending", "createdAt": "..." }]
```

### GET /api/approval/pending
获取待审批项列表及数量。

**响应示例**：
```json
{ "pending": [], "count": 0 }
```

### GET /api/approval/history
获取审批历史记录（最近50条）。

**响应示例**：
```json
{ "history": [] }
```

### GET /api/approval/stats
获取审批统计数据。

**响应示例**：
```json
{ "total": 10, "approved": 8, "rejected": 2 }
```

### GET /api/deepening/affinities
获取深化推理亲和性统计。

### GET /api/deepening/report
获取深化推理完整报告。

### GET /api/deepening-registry/stats
获取深化模块注册表统计。

### GET /api/doc-freshness/stats
获取文档新鲜度统计。

### GET /api/doc-freshness/stale
获取过时文档列表。

### GET /api/doc-freshness/index
获取文档新鲜度索引。

### GET /api/doc-freshness/validate
验证文档新鲜度并返回结果。

### POST /api/approval/request
提交审批请求。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentId | string | 是 | 请求审批的Agent ID（最大128字符） |
| operation | string | 是 | 请求审批的操作描述（最大256字符） |

**请求体示例**：
```json
{ "agentId": "task-worker-01", "operation": "删除过时配置文件" }
```

**响应示例**：
```json
{ "message": "Use requestApproval() via runtime, then resolve via /api/approval/approve or /api/approval/reject" }
```

### POST /api/approval/approve
批准审批请求。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| requestId | string | 是 | 审批请求ID（最大256字符，格式: [a-zA-Z0-9_-]+） |
| comment | string | 否 | 审批备注（最大1000字符） |

**请求体示例**：
```json
{ "requestId": "approval-xxx", "comment": "已确认安全" }
```

**响应示例**：
```json
{ "approved": true, "requestId": "approval-xxx" }
```

### POST /api/approval/reject
拒绝审批请求。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| requestId | string | 是 | 审批请求ID（最大256字符，格式: [a-zA-Z0-9_-]+） |
| comment | string | 否 | 拒绝备注（最大1000字符） |

**请求体示例**：
```json
{ "requestId": "approval-xxx", "comment": "操作风险过高" }
```

**响应示例**：
```json
{ "approved": false, "requestId": "approval-xxx" }
```

### POST /api/token/record
记录Token消耗。

**请求体**：
```json
{ "sessionId": "session-xxx", "tokens": 1500, "inputTokens": 1000, "outputTokens": 500, "toolCallTokens": 0 }
```

**响应示例**：
```json
{ "success": true, "recorded": true }
```

### POST /api/auto-version/record
记录AI修改版本。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| summary | string | 是 | 变更摘要（最大500字符） |
| category | string | 否 | 变更类别，枚举: '新增'\|'变更'\|'修复'\|'移除'（默认'变更'） |
| agent | string | 否 | 执行Agent（最大128字符，默认'AI'） |
| files | string[] | 否 | 涉及文件列表（最多50项，每项最大512字符） |
| module | string | 否 | 模块名（最大128字符） |
| method | string | 否 | 方法名（最大128字符） |
| value | string | 否 | 变更值（最大500字符） |
| details | string | 否 | 详细说明（最大2000字符） |
| subItems | string[] | 否 | 子项列表（最多30项，每项最大500字符） |
| sourceEvent | string | 否 | 来源事件（最大128字符，默认'ai:code-modified'） |
| phase | string | 否 | 执行阶段（最大64字符） |

**请求体示例**：
```json
{ "summary": "优化Token计数逻辑", "category": "变更", "agent": "task-worker-01", "files": ["src/runtime/model/token-manager.js"], "module": "model", "method": "countTokens" }
```

**响应示例**：
```json
{ "success": true, "recorded": true }
```

### POST /api/doc-freshness/verify
标记文档已验证。

**请求体**：
```json
{ "docPath": "docs/modules/xxx.md" }
```

**响应示例**：
```json
{ "success": true, "verified": true }
```

### POST /api/doc-freshness/code-change
处理代码变更影响文档。

**请求体**：
```json
{ "filePath": "src/runtime/xxx.js", "changeType": "modified" }
```

**响应示例**：
```json
{ "staleDocs": ["docs/modules/xxx.md"] }
```

---

## 十五、WebSocket API

### 连接端点：/ws

**升级请求**：
```
GET /ws HTTP/1.1
Upgrade: websocket
Connection: Upgrade
sec-websocket-protocol: <auth-token>
```

**认证流程**：
1. 客户端可通过以下三种方式之一进行认证（按优先级排序）：
   - **Authorization头**：在升级请求中携带 `Authorization: Bearer <token>` 头，服务端优先检查此方式
   - **sec-websocket-protocol头**：传递 `bearer-<token>` 格式的认证令牌
   - **消息级认证**：连接建立后发送 `{ "type": "auth", "token": "..." }` 消息进行认证
2. 服务端 `_validateWsAuth` 对令牌进行SHA-256哈希后使用 `timingSafeEqual` 进行恒定时间比较，防止时序攻击
3. 令牌长度不匹配时，服务端写入 `401 Unauthorized` 响应并销毁socket，拒绝连接
4. 无令牌时同样写入401响应并销毁socket
5. `start()` 方法重建 `WebSocketHandler` 时正确传递 `authToken`，确保服务重启后认证不失效

**协议头验证**：
- 服务端仅回显已知协议前缀：`bearer-*` 和 `sha256-*`，其他协议值将被忽略（不在响应中包含 `Sec-WebSocket-Protocol` 头）
- `sec-websocket-protocol` 头中包含 `\r\n` 字符的请求将被拒绝回显，防止HTTP响应分割/头注入攻击
- 消息解析错误（`messageParse`）与消息处理错误（`messageHandlerError`）使用独立的调试分类记录，便于区分恶意畸形载荷与应用层异常

**速率限制**：
- 滑动窗口实现：每个客户端维护消息时间戳数组，使用 `filter()` 清理过期时间戳（窗口期1秒，限制30条/秒）
- 时间戳数组上限100条，超出时裁剪至最近30条
- 超限客户端将被关闭连接（关闭码1008）

**广播机制**：
- 广播消息时遍历所有活跃客户端，写入失败的客户端会被收集到失败列表
- 失败客户端从客户端集合中移除，触发 `disconnect` 事件（原因：`broadcast_write_failed`），并销毁socket

**限制**：
| 项目 | 限制 |
|------|------|
| 最大客户端数 | 50 |
| 最大帧大小 | 1MB |
| 最大负载大小 | 1MB |
| 心跳间隔 | 30秒 |
| 消息速率限制 | 30条/秒（滑动窗口1秒） |
| 时间戳条目上限 | 100条/客户端 |

**关闭码**：
| 关闭码 | 说明 |
|--------|------|
| 1000 | 正常关闭 |
| 1002 | 协议错误（RSV位非零、未掩码客户端帧等） |
| 1003 | 不支持的数据类型（二进制帧、延续帧） |
| 1008 | 消息速率超限（策略违规） |
| 1009 | 消息过大（帧缓冲区超过1MB） |
| 4001 | 认证失败或未认证 |
| 429 | 连接数过多（HTTP升级阶段拒绝） |

**服务端推送事件**：
| 事件 | 数据 | 说明 |
|------|------|------|
| `data-update` | `{event, data, timestamp}` | 数据变更通知 |
| `agent-state-change` | `{agentId, state}` | Agent状态变更 |
| `phase-change` | `{sessionId, from, to}` | 阶段转换 |
| `goal-progress` | `{goalId, progress}` | 目标进度更新 |
| `deepening-iteration` | `{iteration, score}` | 深化迭代进度 |
| `subagent-status` | `{handleId, status}` | 子Agent状态变更 |

**客户端消息格式**：
```json
{ "type": "subscribe", "events": ["agent-state-change", "phase-change"] }
```

### GET /api/antipattern/rules
获取反模式检测规则。

> **注意**：`POST /api/antipattern/detect` 端点已移除。反模式检测功能请使用 `GET /api/antipattern/rules` 端点获取检测规则，或使用 `GET /api/design/audit` 端点进行设计反模式审计。

---

## 十六、缓存机制

### API缓存（`_getCached`）
所有GET端点的数据通过 `_getCached` 方法进行缓存，避免重复计算。

**缓存行为**：
- 缓存命中：若缓存条目存在且未过期（`Date.now() - cached.ts < ttl`），直接返回缓存数据
- 缓存过期：重新调用 `computeFn` 计算数据，计算完成后使用 `Date.now()` 更新时间戳（而非函数开头捕获的时间戳），防止长时间计算导致缓存条目立即过期
- 防重入：若缓存正在计算中（`_computing` 标记），返回过期数据（`_staleData`）而非null
- 容量限制：缓存条目超过上限时淘汰最早的条目

**缓存失效**：通过事件总线监听关键事件（如 `session:created`、`agent:state-change`、`skills-reloaded` 等），自动清除相关缓存键。

### 文件缓存
静态文件和配置文件通过 `_readFileCached` / `_readDirCached` 缓存，使用独立的TTL和缓存Map。

---

## 十七、安全修复记录（v2.7.107）

| 修复项 | 影响范围 | 说明 |
|--------|---------|------|
| WebSocket认证传递 | `start()` → `WebSocketHandler` | `start()` 方法重建 `WebSocketHandler` 时现在正确传递 `authToken`，之前遗漏导致认证被绕过 |
| WebSocket速率限制 | `_checkMessageRate` | 滑动窗口实现已修复，使用 `filter()` 替代有缺陷的 for 循环，确保过期时间戳被正确清理 |
| WebSocket广播容错 | `broadcast()` | 写入失败的客户端现在会正确销毁socket并触发 `disconnect` 事件，避免僵尸连接 |
| 缓存时间戳精度 | `_getCached` | 计算完成后使用 `Date.now()` 更新时间戳，而非函数开头捕获的时间戳，防止长时间计算导致缓存立即过期 |
| WebSocket认证拒绝 | `_validateWsAuth` | 令牌长度不匹配时现在正确关闭socket（写入401响应并destroy），之前仅返回false未关闭连接 |

---

## 未文档化端点补全

### POST /api/chat/send
发送聊天消息到指定会话。消息记录到ConversationContextStore，若Agent运行时可用则构建AI响应，否则返回回显消息。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message | string | 是 | 消息内容（非空字符串，最大32000字符） |
| sessionId | string | 否 | 会话ID（未提供时使用当前活跃会话） |

**请求体示例**：
```json
{ "message": "请帮我分析这个模块的架构", "sessionId": "chat-1717700000000-abc123" }
```

**响应示例**：
```json
{
  "success": true,
  "sessionId": "chat-1717700000000-abc123",
  "userTurn": { "role": "user", "content": "请帮我分析这个模块的架构", "timestamp": "..." },
  "response": { "type": "echo", "message": "请帮我分析这个模块的架构", "sessionId": "chat-1717700000000-abc123", "timestamp": 1717700000000, "note": "Agent runtime not available. Message recorded but no AI processing performed." },
  "responseTurn": { "role": "assistant", "content": "...", "timestamp": "..." }
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | message is required and must be a string | message参数缺失或类型错误 |
| 400 | message cannot be empty | message为空白字符串 |
| 400 | message exceeds maximum length of 32000 | message超过长度限制 |
| 400 | No active session. Provide sessionId or start a session first. | 无活跃会话且未提供sessionId |
| 404 | Session not found: xxx | 指定会话不存在 |

**安全注意事项**：
- 消息长度限制为32000字符，防止超长输入
- Agent运行时不可用时仍记录用户消息，但不执行AI处理

### POST /api/chat/sessions
获取会话列表，包含活跃会话、置顶会话和所有会话的摘要信息。

**请求体参数**：无

**响应示例**：
```json
{
  "sessions": [
    {
      "sessionId": "chat-1717700000000-abc123",
      "startedAt": "2026-06-05T10:00:00.000Z",
      "lastActivityAt": "2026-06-05T12:00:00.000Z",
      "turnCount": 15,
      "summary": "讨论模块架构设计",
      "ended": false,
      "pinned": true,
      "active": true
    }
  ],
  "activeSessionId": "chat-1717700000000-abc123",
  "total": 5
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| sessions | array | 会话列表（最多100条） |
| sessions[].sessionId | string | 会话ID |
| sessions[].startedAt | string | 会话创建时间 |
| sessions[].lastActivityAt | string | 最后活动时间 |
| sessions[].turnCount | number | 对话轮次数量 |
| sessions[].summary | string\|null | 会话摘要 |
| sessions[].ended | boolean | 会话是否已结束 |
| sessions[].pinned | boolean | 是否已置顶 |
| sessions[].active | boolean | 是否为当前活跃会话 |
| activeSessionId | string\|null | 当前活跃会话ID |
| total | number | 会话总数 |

### POST /api/chat/history
获取指定会话的聊天历史记录，支持分页。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string | 否 | 会话ID（未提供时使用当前活跃会话） |
| limit | number | 否 | 返回条数限制，范围1-200，默认50 |
| offset | number | 否 | 偏移量，默认0 |

**请求体示例**：
```json
{ "sessionId": "chat-1717700000000-abc123", "limit": 20, "offset": 0 }
```

**响应示例**：
```json
{
  "sessionId": "chat-1717700000000-abc123",
  "turns": [
    { "role": "user", "content": "请帮我分析架构", "timestamp": "..." },
    { "role": "assistant", "content": "好的，我来分析...", "timestamp": "..." }
  ],
  "totalTurns": 30,
  "hasMore": true
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | sessionId is required or an active session must exist | 未提供sessionId且无活跃会话 |
| 404 | Session not found | 指定会话不存在 |

### POST /api/terminal/execute
执行终端命令。基于白名单机制，仅允许预定义的安全命令，禁止Shell元字符和危险参数。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| command | string | 是 | 要执行的命令（1-4096字符） |

**请求体示例**：
```json
{ "command": "git status" }
```

**响应示例（成功）**：
```json
{
  "success": true,
  "output": "On branch main\nnothing to commit, working tree clean",
  "command": "git status",
  "exitCode": 0,
  "truncated": false
}
```

**响应示例（失败）**：
```json
{
  "success": false,
  "output": "fatal: not a git repository",
  "command": "git status",
  "exitCode": 128,
  "timedOut": false
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | command is required and must be a string | command参数缺失或类型错误 |
| 400 | command must be 1-4096 characters | command长度不合法 |
| 400 | Shell metacharacters (;\|&\`$()${}) are not allowed. | 命令包含Shell元字符 |
| 400 | Dangerous command arguments (-e/--eval/-c/--command/-i/--interactive/exec) are not allowed. | 命令包含危险参数 |
| 403 | Terminal API is disabled. Enable via HARNESS_TERMINAL_ENABLED=true or dev mode. | 终端API未启用 |
| 403 | Command not in allowed list: xxx | 命令不在白名单中 |

**安全注意事项**：
- 需启用开发模式或设置 `HARNESS_TERMINAL_ENABLED=true` 环境变量
- 命令白名单：`git, echo, cat, ls, mkdir, cp, mv, test, true, false, date, wc, head, tail, sort, uniq, diff, which, pwd, env, grep, find, rg, ag, tr, cut, tee, touch`
- 禁止Shell元字符：`; | & \` $ $( ${}`
- 禁止危险参数：`-e --eval -c --command -i --interactive exec`
- 使用 `execFile` 执行（`shell: false`），不通过Shell解释
- 执行超时30秒，输出缓冲区最大1MB
- 受限环境变量，仅传递 `PATH, HOME, USERPROFILE, LANG, TERM, NODE_ENV`

### POST /api/fs/write
写入文件内容。基于ServiceFS虚拟文件系统，支持路径遍历防护和内容大小限制。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 是 | 文件路径（最大512字符） |
| content | string | 是 | 文件内容（最大1MB） |

**请求体示例**：
```json
{ "path": "src/config.json", "content": "{\"key\": \"value\"}" }
```

**响应示例**：
```json
{ "success": true, "path": "src/config.json", "size": 16 }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | path is required and must be a string | path参数缺失或类型错误 |
| 400 | path exceeds maximum length (512) | path超过长度限制 |
| 400 | content is required | content参数缺失 |
| 400 | content must be a string | content类型错误 |
| 400 | content exceeds maximum size (1048576 bytes) | content超过大小限制 |
| 404 | — | 路径不存在（RESOURCE_NOT_FOUND） |
| 400 | — | 输入无效（INVALID_INPUT） |

**安全注意事项**：
- 路径长度限制512字符
- 内容大小限制1MB（1048576字节）
- ServiceFS内建路径遍历防护
- 需Bearer Token认证

### POST /api/fs/read
读取文件内容。基于ServiceFS虚拟文件系统，支持路径遍历防护。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 是 | 文件路径（最大512字符） |

**请求体示例**：
```json
{ "path": "src/config.json" }
```

**响应示例**：
```json
{ "path": "src/config.json", "content": "{\"key\": \"value\"}", "size": 16 }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | path is required and must be a string | path参数缺失或类型错误 |
| 400 | path exceeds maximum length (512) | path超过长度限制 |
| 404 | — | 文件不存在（RESOURCE_NOT_FOUND） |
| 400 | — | 输入无效（INVALID_INPUT） |

**安全注意事项**：
- 路径长度限制512字符
- ServiceFS内建路径遍历防护，防止目录穿越攻击

### POST /api/managed-agents/start
启动托管Agent。通过ManagedAgentHost启动指定ID的Agent实例。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentId | string | 是 | Agent ID（最大128字符，格式：`[a-zA-Z0-9_-]+`） |

**请求体示例**：
```json
{ "agentId": "task-worker-01" }
```

**响应示例（成功）**：
```json
{ "started": true, "agentId": "task-worker-01" }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | — | agentId参数缺失、格式错误或无法启动该Agent |
| 503 | ManagedAgentHost not available | ManagedAgentHost模块不可用 |

**安全注意事项**：
- agentId经过格式校验（`[a-zA-Z0-9_-]+`），防止注入
- 需Bearer Token认证

### POST /api/triggers/fire
触发调度，向指定Agent发送即发即弃（fire-and-forget）事件。通过TriggerDispatcher执行异步分发。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentId | string | 是 | 目标Agent ID（最大128字符，格式：`[a-zA-Z0-9_-]+`） |
| payload | object | 否 | 事件载荷数据 |

**请求体示例**：
```json
{ "agentId": "task-worker-01", "payload": { "action": "run-tests", "module": "auth" } }
```

**响应示例**：
```json
{ "dispatched": true, "agentId": "task-worker-01" }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | — | agentId参数缺失或格式错误 |
| 503 | TriggerDispatcher not available | TriggerDispatcher模块不可用 |

**安全注意事项**：
- agentId经过格式校验（`[a-zA-Z0-9_-]+`），防止注入
- 即发即弃模式，不等待Agent处理结果
- 需Bearer Token认证

### POST /api/code-wiki/compile
编译CodeWiki知识库。支持全量编译和增量编译（仅编译指定变更文件）。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| force | boolean | 否 | 是否强制全量编译（默认false） |
| changedFiles | string[] | 否 | 变更文件列表（增量编译时使用） |

**请求体示例（全量编译）**：
```json
{ "force": true }
```

**请求体示例（增量编译）**：
```json
{ "changedFiles": ["src/runtime/model/token-manager.js", "src/web/server.js"] }
```

**响应示例**：
```json
{
  "success": true,
  "compiledFiles": 42,
  "duration": 1500,
  "incremental": false
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | CodeWikiOrchestrator not available | CodeWikiOrchestrator模块不可用 |
| 400 | — | changedFiles中的路径未通过安全校验 |

**安全注意事项**：
- changedFiles中的路径经过路径安全校验（`_validatePathSafety`），防止路径遍历
- 需Bearer Token认证

### POST /api/conversation/search
搜索对话记录。在ConversationContextStore中按关键词搜索对话轮次，支持按角色和会话过滤。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索关键词 |
| limit | number | 否 | 返回条数限制，范围1-100，默认20 |
| offset | number | 否 | 偏移量，默认0 |
| role | string | 否 | 按角色过滤（user/assistant） |
| sessionId | string | 否 | 按会话ID过滤 |

**请求体示例**：
```json
{ "query": "架构设计", "limit": 10, "role": "assistant", "sessionId": "chat-1717700000000-abc123" }
```

**响应示例**：
```json
{
  "query": "架构设计",
  "results": [
    { "role": "assistant", "content": "架构设计建议采用分层模式...", "sessionId": "chat-1717700000000-abc123", "timestamp": "..." }
  ],
  "count": 1
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | query is required | query参数缺失 |

### GET /api/browser-use/status
获取浏览器自动化（BrowserUse）状态信息，包括连接状态、运行模式和当前URL。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "mode": "mcp",
  "connected": true,
  "currentUrl": "https://example.com",
  "stats": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | BrowserUse服务是否可用 |
| mode | string | 运行模式（mcp/cdp），默认mcp |
| connected | boolean | MCP服务器是否已连接（强制布尔值，`!!`转换） |
| currentUrl | string\|null | 当前浏览器页面URL |
| stats | object | BrowserUse适配器统计信息 |

**不可用状态响应**：
```json
{
  "available": false,
  "message": "BrowserUse server not configured"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| MCP client not initialized | MCP客户端未初始化 |
| MCP client missing getServerStatus method | MCP客户端缺少getServerStatus方法 |
| MCP server status unavailable | 服务器状态不可用 |
| BrowserUse server not configured | config.json中未配置browser-use服务器 |
| BrowserUse status check failed | 内部异常被try-catch捕获 |

### GET /api/rl/status
获取强化学习（Hermes RL）状态信息，包括连接状态、活跃训练运行和统计。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "mode": "mcp",
  "connected": true,
  "activeRunId": null,
  "stats": {},
  "environmentCount": 0,
  "trajectoryCount": 0
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | RL服务是否可用 |
| mode | string | 运行模式（mcp），默认mcp |
| connected | boolean | Hermes RL MCP服务器是否已连接（强制布尔值） |
| activeRunId | string\|null | 当前活跃的训练运行ID |
| stats | object | RL训练管道统计信息 |
| environmentCount | number | 环境数量（默认0） |
| trajectoryCount | number | 轨迹数量（默认0） |

**不可用状态响应**：
```json
{
  "available": false,
  "message": "Hermes RL server not configured"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| MCP client not initialized | MCP客户端未初始化 |
| MCP client missing getServerStatus method | MCP客户端缺少getServerStatus方法 |
| MCP server status unavailable | 服务器状态不可用 |
| Hermes RL server not configured | config.json中未配置hermes-rl服务器 |
| RL status check failed | 内部异常被try-catch捕获 |

### GET /api/ooda/status
获取OODA决策闭环（Observe-Orient-Decide-Act）状态信息，包括循环计数、健康状态和目标描述。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "cycleCount": 42,
  "level": "strategic",
  "healthy": true,
  "shutDown": false,
  "goalDescription": "优化系统性能",
  "historySize": 100
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | OODA循环是否可用 |
| cycleCount | number | 已完成的循环次数 |
| level | string | 当前决策层级 |
| healthy | boolean | 循环是否健康 |
| shutDown | boolean | 循环是否已关闭 |
| goalDescription | string | 当前目标描述 |
| historySize | number | 历史记录大小 |

**不可用状态响应**：
```json
{
  "available": false,
  "message": "OodaLoop not initialized"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| OodaLoop not initialized | OodaLoop模块未初始化 |
| OodaLoop missing getStats method | OodaLoop缺少getStats方法 |
| OodaLoop getStats returned invalid result | getStats返回无效结果 |
| OODA status check failed | 内部异常被try-catch捕获 |

### GET /api/skill-distillation/status
获取技能蒸馏状态信息，包括追踪数量和蒸馏统计。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "initialized": true,
  "traces": 128,
  "distillations": 15,
  "stats": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | SkillDistiller是否可用 |
| initialized | boolean | SkillDistiller是否已初始化 |
| traces | number | 追踪记录数量（`Number.isFinite`校验，默认0） |
| distillations | number | 蒸馏执行次数（`Number.isFinite`校验，默认0） |
| stats | object | SkillDistiller完整统计信息 |

**不可用状态响应**：
```json
{
  "available": false,
  "initialized": false,
  "message": "SkillDistiller not initialized"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| SkillDistiller not initialized | SkillDistiller模块未初始化 |
| SkillDistiller missing getStats method | SkillDistiller缺少getStats方法 |
| SkillDistillation status check failed | 内部异常被try-catch捕获 |

### GET /api/skill-effectiveness/status
获取技能有效性优化状态信息，包括活跃技能数量、自适应Top-K配置等。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "initialized": true,
  "maxActiveSkills": 12,
  "currentActiveSkills": 8,
  "adaptiveTopK": true,
  "currentTopK": 5,
  "stats": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | SkillEffectivenessOptimizer是否可用 |
| initialized | boolean | 优化器是否已初始化 |
| maxActiveSkills | number | 最大活跃技能数（`Number.isFinite`校验，默认12） |
| currentActiveSkills | number | 当前活跃技能数（`Number.isFinite`校验，默认0） |
| adaptiveTopK | boolean | 是否启用自适应Top-K（默认true） |
| currentTopK | number | 当前Top-K值（`Number.isFinite`校验，默认5） |
| stats | object | 优化器完整统计信息 |

**不可用状态响应**：
```json
{
  "available": false,
  "initialized": false,
  "message": "SkillEffectivenessOptimizer not initialized"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| SkillEffectivenessOptimizer not initialized | 优化器模块未初始化 |
| SkillEffectivenessOptimizer missing getStats method | 优化器缺少getStats方法 |
| SkillEffectiveness status check failed | 内部异常被try-catch捕获 |

### GET /api/opportunity-discovery/status
获取机会发现管道状态信息，包括痛点扫描、竞争差距分析和产品视角验证统计。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "initialized": true,
  "painPointsScanned": 25,
  "competitiveGapsAnalyzed": 8,
  "productLensValidated": 12,
  "stats": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | OpportunityDiscoveryPipeline是否可用 |
| initialized | boolean | 管道是否已初始化 |
| painPointsScanned | number | 已扫描痛点数量（`Number.isFinite`校验，默认0） |
| competitiveGapsAnalyzed | number | 已分析竞争差距数量（`Number.isFinite`校验，默认0） |
| productLensValidated | number | 已验证产品视角数量（`Number.isFinite`校验，默认0） |
| stats | object | 管道完整统计信息 |

**不可用状态响应**：
```json
{
  "available": false,
  "initialized": false,
  "message": "OpportunityDiscoveryPipeline not initialized"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| OpportunityDiscoveryPipeline not initialized | 管道模块未初始化 |
| OpportunityDiscoveryPipeline missing getStats method | 管道缺少getStats方法 |
| OpportunityDiscovery status check failed | 内部异常被try-catch捕获 |

### GET /api/analytics/dashboard
获取AI开发者分析仪表盘数据，包括指标收集、活跃实验、瓶颈和异常检测统计。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "initialized": true,
  "metricsCollected": 1024,
  "experimentsActive": 3,
  "bottlenecksDetected": 7,
  "anomaliesDetected": 2,
  "data": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | AiDeveloperAnalytics是否可用 |
| initialized | boolean | 分析模块是否已初始化 |
| metricsCollected | number | 已收集指标数量（`Number.isFinite`校验，默认0） |
| experimentsActive | number | 活跃实验数量（`Number.isFinite`校验，默认0） |
| bottlenecksDetected | number | 检测到的瓶颈数量（`Number.isFinite`校验，默认0） |
| anomaliesDetected | number | 检测到的异常数量（`Number.isFinite`校验，默认0） |
| data | object | 仪表盘完整数据 |

**不可用状态响应**：
```json
{
  "available": false,
  "initialized": false,
  "message": "AiDeveloperAnalytics not initialized"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| AiDeveloperAnalytics not initialized | 分析模块未初始化 |
| AiDeveloperAnalytics missing getDashboardData method | 分析模块缺少getDashboardData方法 |
| AiDeveloperAnalytics dashboard check failed | 内部异常被try-catch捕获 |

### GET /api/code-wiki/stats
获取CodeWiki知识库统计信息。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "stats": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | CodeWikiOrchestrator是否可用 |
| stats | object | CodeWiki完整统计信息 |

**不可用状态响应**：
```json
{
  "available": false,
  "stats": {}
}
```

| 不可用消息 | 说明 |
|-----------|------|
| CodeWikiOrchestrator not initialized（stats为空对象） | CodeWiki编排器未初始化 |
| CodeWikiOrchestrator missing getStats method（stats为空对象） | 编排器缺少getStats方法 |
| CodeWiki stats check failed（stats为空对象） | 内部异常被try-catch捕获 |

### GET /api/delivery-acceleration/stats
获取交付加速统计信息。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "stats": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | DeliveryAccelerationOrchestrator是否可用 |
| stats | object | 交付加速完整统计信息 |

**不可用状态响应**：
```json
{
  "available": false,
  "stats": {}
}
```

| 不可用消息 | 说明 |
|-----------|------|
| DeliveryAccelerationOrchestrator not initialized（stats为空对象） | 交付加速编排器未初始化 |
| DeliveryAccelerationOrchestrator missing getStats method（stats为空对象） | 编排器缺少getStats方法 |
| Delivery acceleration stats check failed（stats为空对象） | 内部异常被try-catch捕获 |

### GET /api/skill-reducer/stats
获取Skill Reducer统计信息，包括层级分布、活跃任务技能和过载检测状态。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "stats": {},
  "layerDistribution": {},
  "activeTaskSkills": {},
  "overloadStatus": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | SkillReducer是否可用 |
| stats | object | SkillReducer基础统计信息 |
| layerDistribution | object | 技能层级分布数据 |
| activeTaskSkills | object | 活跃任务技能映射 |
| overloadStatus | object | 过载检测状态 |

**不可用状态响应**：
```json
{
  "available": false
}
```

| 不可用条件 | 说明 |
|-----------|------|
| SkillReducer not initialized（`_rt('skillReducer')`返回null） | SkillReducer模块未初始化 |
| SkillReducer missing getStats method | SkillReducer缺少getStats方法 |
| 内部异常 | try-catch捕获异常后返回`{ available: false }` |

### POST /api/fs/remove
删除文件或目录。基于ServiceFS虚拟文件系统，执行不可逆的删除操作。

> ⚠️ **危险操作警告**：此端点执行不可逆的文件删除操作，请务必注意以下安全事项：
> - **不可逆操作**：删除后无法恢复，请确保目标路径正确
> - **路径校验**：路径长度限制512字符，ServiceFS内建路径遍历防护，防止目录穿越攻击
> - **权限检查**：需Bearer Token认证，POST请求必须携带有效Token
> - **操作审计**：ServiceFS在删除时递增`deletes`计数器并触发`removed`事件，可用于审计追踪
> - **建议**：生产环境中建议在调用此端点前先通过`/api/fs/exists`确认路径存在，并通过审批流程确认删除意图

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 是 | 要删除的文件路径（最大512字符） |

**请求体示例**：
```json
{ "path": "src/deprecated-module.js" }
```

**响应示例**：
```json
{ "success": true, "path": "src/deprecated-module.js" }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | path is required and must be a string | path参数缺失或类型错误 |
| 400 | path exceeds maximum length (512) | path超过长度限制 |
| 404 | — | 路径不存在（RESOURCE_NOT_FOUND） |
| 400 | — | 输入无效（INVALID_INPUT） |
| 503 | ServiceFS not available | ServiceFS模块不可用 |

**安全注意事项**：
- ⚠️ **不可逆操作**：文件删除后无法恢复，务必谨慎调用
- 路径长度限制512字符
- ServiceFS内建路径遍历防护，防止目录穿越攻击
- 需Bearer Token认证
- 删除操作会触发`removed`事件，可用于审计追踪

### POST /api/fs/exists
检查文件或目录是否存在。基于ServiceFS虚拟文件系统，支持路径遍历防护。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 是 | 要检查的文件路径（最大512字符） |

**请求体示例**：
```json
{ "path": "src/config.json" }
```

**响应示例**：
```json
{ "path": "src/config.json", "exists": true }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | path is required and must be a string | path参数缺失或类型错误 |
| 400 | path exceeds maximum length (512) | path超过长度限制 |
| 400 | — | 输入无效（INVALID_INPUT） |
| 503 | ServiceFS not available | ServiceFS模块不可用 |

**安全注意事项**：
- 路径长度限制512字符
- ServiceFS内建路径遍历防护，防止目录穿越攻击
- 路径无效或服务未挂载时返回`exists: false`而非错误，避免信息泄露

### POST /api/fs/tree
获取文件目录树的可视化字符串表示。基于ServiceFS虚拟文件系统，支持指定路径子树或全量目录树。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 否 | 虚拟路径，指定时仅生成该服务下的子树；省略时生成全量目录树（默认`/`） |
| depth | number | 否 | 最大递归深度，范围1-8，默认8 |

**请求体示例**：
```json
{ "path": "src", "depth": 3 }
```

**响应示例**：
```json
{ "path": "src", "depth": 3, "tree": "src/\n├── config/\n│   └── default.json\n├── index.js\n└── utils/\n    └── helpers.js" }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 404 | — | 指定路径对应的服务未挂载（RESOURCE_NOT_FOUND） |
| 400 | — | 输入无效（INVALID_INPUT） |
| 503 | ServiceFS not available | ServiceFS模块不可用 |

**安全注意事项**：
- 递归深度限制最大8层，防止资源耗尽
- ServiceFS内建路径遍历防护
- 需Bearer Token认证

### POST /api/fs/stats
获取文件系统操作统计信息，包括挂载数、服务列表和各类操作计数。

**请求体参数**：无

**响应示例**：
```json
{
  "mountCount": 3,
  "maxMounts": 16,
  "services": ["memory", "project", "config"],
  "operations": {
    "mounts": 3,
    "unmounts": 0,
    "reads": 128,
    "writes": 45,
    "deletes": 7,
    "lists": 64,
    "copies": 2,
    "greps": 15
  }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| mountCount | number | 当前挂载数量 |
| maxMounts | number | 最大挂载数量 |
| services | string[] | 已挂载服务名称列表 |
| operations | object | 各类操作计数 |
| operations.mounts | number | 挂载操作次数 |
| operations.unmounts | number | 卸载操作次数 |
| operations.reads | number | 读取操作次数 |
| operations.writes | number | 写入操作次数 |
| operations.deletes | number | 删除操作次数 |
| operations.lists | number | 列表操作次数 |
| operations.copies | number | 复制操作次数 |
| operations.greps | number | 搜索操作次数 |

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | ServiceFS not available | ServiceFS模块不可用 |

### POST /api/chat/end
结束当前活跃的聊天会话。设置会话为已结束状态，可选设置摘要，并清理超出上限的旧会话。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| summary | string | 否 | 会话摘要（最大2000字符，超长自动截断） |

**请求体示例**：
```json
{ "summary": "讨论了模块架构设计方案，决定采用分层模式" }
```

**响应示例**：
```json
{
  "success": true,
  "sessionId": "chat-1717700000000-abc123",
  "turnCount": 15,
  "summary": "讨论了模块架构设计方案，决定采用分层模式"
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | No active session to end | 无活跃会话可结束 |
| 503 | Conversation store not available | ConversationContextStore模块不可用 |

**安全注意事项**：
- summary参数最大2000字符，超长自动截断
- 结束会话后该会话不再接受新消息，需重新创建会话
- 需Bearer Token认证

### POST /api/conversation/pin
固定或取消固定对话会话。置顶的会话在会话列表中优先展示。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string | 是 | 会话ID |
| pinned | boolean | 否 | 是否置顶（默认true，传false取消置顶） |

**请求体示例**：
```json
{ "sessionId": "chat-1717700000000-abc123", "pinned": true }
```

**响应示例**：
```json
{ "success": true, "sessionId": "chat-1717700000000-abc123", "pinned": true }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | sessionId is required | sessionId参数缺失 |
| 503 | Conversation store not available | ConversationContextStore模块不可用 |

**安全注意事项**：
- 需Bearer Token认证
- 置顶操作触发`session-pinned`事件，可用于审计追踪

### POST /api/conversation/export
导出对话会话内容，支持JSON和Markdown两种格式。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string | 是 | 会话ID |
| format | string | 否 | 导出格式：`json`（默认）/ `markdown` |
| includeMetadata | boolean | 否 | 是否包含元数据（默认true） |

**请求体示例**：
```json
{ "sessionId": "chat-1717700000000-abc123", "format": "markdown", "includeMetadata": true }
```

**响应示例**：
```json
{
  "sessionId": "chat-1717700000000-abc123",
  "format": "markdown",
  "content": "# Chat Session\n\n## User\n请帮我分析架构\n\n## Assistant\n好的，我来分析..."
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | sessionId is required | sessionId参数缺失 |
| 404 | Session not found | 指定会话不存在 |
| 503 | Conversation store not available | ConversationContextStore模块不可用 |

**安全注意事项**：
- 需Bearer Token认证
- 导出内容可能包含敏感对话数据，应妥善保管
- format参数仅允许`json`和`markdown`两个值，防止注入

### GET /api/conversation/pinned
获取所有已置顶的对话会话ID列表。

**请求参数**：无

**响应示例**：
```json
{ "pinnedSessions": ["chat-1717700000000-abc123", "chat-1717800000000-def456"] }
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| pinnedSessions | string[] | 已置顶会话ID列表 |

**不可用状态响应**：
```json
{ "available": false, "message": "Conversation store not available" }
```

### GET /api/dev-metrics/stats
获取开发指标全局统计信息。通过DevMetricsCollector收集的度量数据汇总。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "stats": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | DevMetricsCollector是否可用 |
| stats | object | 全局统计数据（由DevMetricsCollector.getGlobalStats()返回） |

**不可用状态响应**：
```json
{ "available": false }
```

| 不可用条件 | 说明 |
|-----------|------|
| DevMetricsCollector not initialized（`_rt('devMetricsCollector')`返回null） | 度量收集器未初始化 |
| DevMetricsCollector missing getGlobalStats method | 收集器缺少getGlobalStats方法 |

### POST /api/dev-metrics/project
查询项目级开发度量报告。通过DevMetricsCollector生成指定项目的度量分析报告。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectId | string | 是 | 项目ID（最大128字符，格式：`[a-zA-Z0-9_-]+`） |

**请求体示例**：
```json
{ "projectId": "auth-module" }
```

**响应示例**：
```json
{
  "available": true,
  "report": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | DevMetricsCollector是否可用 |
| report | object | 项目度量报告（由DevMetricsCollector.generateReport()返回） |

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | projectId is required | projectId参数缺失 |
| 400 | Invalid projectId format | projectId格式不合法（需匹配`[a-zA-Z0-9_-]+`，最大128字符） |
| 404 | Project not found | 指定项目不存在 |
| 503 | — | DevMetricsCollector不可用（返回`{ available: false }`） |

**安全注意事项**：
- projectId经过正则校验（`[a-zA-Z0-9_-]+`），防止注入攻击
- projectId长度限制128字符
- 需Bearer Token认证

### GET /api/managed-agents/list
列出所有托管Agent及其统计信息。通过ManagedAgentHost获取Agent列表和全局统计。

**请求参数**：无

**响应示例**：
```json
{
  "agents": [
    { "id": "task-worker-01", "status": "running", "startedAt": "2026-06-05T10:00:00.000Z" }
  ],
  "stats": { "total": 5, "running": 2, "paused": 1, "stopped": 2 }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| agents | array | 托管Agent列表（由ManagedAgentHost.listAgents()返回） |
| stats | object | 全局统计信息（由ManagedAgentHost.getStats()返回） |

**不可用状态响应**：
```json
{ "agents": [], "stats": {} }
```

### POST /api/managed-agents/status
查询指定托管Agent的当前状态。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentId | string | 是 | Agent ID（最大128字符，格式：`[a-zA-Z0-9_-]+`） |

**请求体示例**：
```json
{ "agentId": "task-worker-01" }
```

**响应示例**：
```json
{ "id": "task-worker-01", "status": "running", "startedAt": "2026-06-05T10:00:00.000Z", "lastActivityAt": "2026-06-05T12:00:00.000Z" }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | agentId (string) required | agentId参数缺失或类型错误 |
| 400 | agentId exceeds maximum length | agentId超过128字符 |
| 400 | agentId contains invalid characters | agentId格式不合法（需匹配`[a-zA-Z0-9_-]+`） |
| 404 | Agent not found | 指定Agent不存在 |
| 503 | ManagedAgentHost not available | ManagedAgentHost模块不可用 |

**安全注意事项**：
- agentId经过格式校验（`[a-zA-Z0-9_-]+`），防止注入
- 需Bearer Token认证

### POST /api/managed-agents/pause
暂停指定托管Agent的执行。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentId | string | 是 | Agent ID（最大128字符，格式：`[a-zA-Z0-9_-]+`） |

**请求体示例**：
```json
{ "agentId": "task-worker-01" }
```

**响应示例（成功）**：
```json
{ "paused": true, "agentId": "task-worker-01" }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | agentId (string) required | agentId参数缺失或类型错误 |
| 400 | agentId exceeds maximum length | agentId超过128字符 |
| 400 | agentId contains invalid characters | agentId格式不合法 |
| 400 | Cannot pause agent | 无法暂停该Agent（可能已暂停或已停止） |
| 503 | ManagedAgentHost not available | ManagedAgentHost模块不可用 |

**安全注意事项**：
- agentId经过格式校验（`[a-zA-Z0-9_-]+`），防止注入
- 需Bearer Token认证

### POST /api/managed-agents/trigger
触发指定托管Agent执行。通过ManagedAgentHost发送执行指令，支持传递自定义载荷。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentId | string | 是 | Agent ID（最大128字符，格式：`[a-zA-Z0-9_-]+`） |
| payload | object | 否 | 事件载荷数据 |

**请求体示例**：
```json
{ "agentId": "task-worker-01", "payload": { "action": "run-tests", "module": "auth" } }
```

**响应示例**：
```json
{ "triggered": true, "agentId": "task-worker-01", "executionId": "exec-xxx" }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | agentId (string) required | agentId参数缺失或类型错误 |
| 400 | agentId exceeds maximum length | agentId超过128字符 |
| 400 | agentId contains invalid characters | agentId格式不合法 |
| 503 | ManagedAgentHost not available | ManagedAgentHost模块不可用 |

**安全注意事项**：
- agentId经过格式校验（`[a-zA-Z0-9_-]+`），防止注入
- 触发源固定为`api`，标识API触发的执行
- 需Bearer Token认证

### POST /api/managed-agents/history
查询指定托管Agent的执行历史记录，支持分页。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentId | string | 是 | Agent ID（最大128字符，格式：`[a-zA-Z0-9_-]+`） |
| limit | number | 否 | 返回条数限制，范围1-100，默认20 |

**请求体示例**：
```json
{ "agentId": "task-worker-01", "limit": 10 }
```

**响应示例**：
```json
{
  "history": [
    { "executionId": "exec-001", "status": "completed", "startedAt": "2026-06-05T10:00:00.000Z", "completedAt": "2026-06-05T10:05:00.000Z" }
  ]
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | agentId (string) required | agentId参数缺失或类型错误 |
| 400 | agentId exceeds maximum length | agentId超过128字符 |
| 400 | agentId contains invalid characters | agentId格式不合法 |

**不可用状态响应**：
```json
{ "history": [] }
```

**安全注意事项**：
- agentId经过格式校验（`[a-zA-Z0-9_-]+`），防止注入
- limit参数强制限制在1-100范围内
- 需Bearer Token认证

### GET /api/triggers/schedules
查看定时调度列表及统计信息。通过TriggerDispatcher获取已注册的定时调度和全局统计。

**请求参数**：无

**响应示例**：
```json
{
  "schedules": [
    { "agentId": "task-worker-01", "cron": "0 */6 * * *", "enabled": true, "lastFiredAt": "2026-06-05T06:00:00.000Z" }
  ],
  "stats": { "totalSchedules": 3, "activeSchedules": 2, "totalFired": 42 }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| schedules | array | 定时调度列表（由TriggerDispatcher.listSchedules()返回） |
| stats | object | 调度统计信息（由TriggerDispatcher.getStats()返回） |

**不可用状态响应**：
```json
{ "schedules": [], "stats": {} }
```

### GET /api/triggers/webhooks
查看Webhook路由列表。通过TriggerDispatcher获取已注册的Webhook路由。

**请求参数**：无

**响应示例**：
```json
{
  "routes": [
    { "path": "/webhook/deploy", "agentId": "deploy-agent", "method": "POST", "enabled": true }
  ]
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| routes | array | Webhook路由列表（由TriggerDispatcher.listWebhookRoutes()返回） |

**不可用状态响应**：
```json
{ "routes": [] }
```

### POST /api/skill-reducer/layer-distribution
获取技能层级分布数据。通过SkillReducer查询技能在各层级的分布情况。

**请求体参数**：无

**响应示例**：
```json
{
  "available": true,
  "distribution": {
    "L1": { "count": 12, "tokenEstimate": 5000 },
    "L2": { "count": 8, "tokenEstimate": 15000 },
    "L3": { "count": 16, "tokenEstimate": 45000 }
  }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | SkillReducer是否可用且支持getLayerDistribution方法 |
| distribution | object | 技能层级分布数据（由SkillReducer.getLayerDistribution()返回） |

**不可用状态响应**：
```json
{ "available": false }
```

| 不可用条件 | 说明 |
|-----------|------|
| SkillReducer not initialized（`_rt('skillReducer')`返回null） | SkillReducer模块未初始化 |
| SkillReducer missing getLayerDistribution method | SkillReducer缺少getLayerDistribution方法 |

### POST /api/skill-reducer/active-tasks
获取活跃任务的技能映射数据。通过SkillReducer查询当前活跃任务所关联的技能。

**请求体参数**：无

**响应示例**：
```json
{
  "available": true,
  "tasks": {
    "task-001": { "skills": ["tdd-implement", "code-review"], "tokenEstimate": 8000 },
    "task-002": { "skills": ["architecture-design"], "tokenEstimate": 3000 }
  }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | SkillReducer是否可用且支持getActiveTaskSkills方法 |
| tasks | object | 活跃任务技能映射（由SkillReducer.getActiveTaskSkills()返回） |

**不可用状态响应**：
```json
{ "available": false }
```

| 不可用条件 | 说明 |
|-----------|------|
| SkillReducer not initialized（`_rt('skillReducer')`返回null） | SkillReducer模块未初始化 |
| SkillReducer missing getActiveTaskSkills method | SkillReducer缺少getActiveTaskSkills方法 |

### POST /api/code-wiki/query
AI聊天式代码库查询。通过CodeWikiOrchestrator对代码知识库执行语义查询，支持指定返回数量和来源过滤。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| q | string | 是 | 查询文本（非空字符串，最大长度受validateStringLength限制） |
| top_k | number | 否 | 返回结果数量，范围1-50，默认5 |
| sources | string[] | 否 | 来源过滤列表 |

**请求体示例**：
```json
{ "q": "Agent生命周期管理", "top_k": 10, "sources": ["src/runtime/agent"] }
```

**响应示例**：
```json
{
  "answer": "Agent生命周期管理通过ManagedAgentHost实现...",
  "sources": [
    { "file": "src/runtime/agent/managed-agent-host.js", "relevance": 0.95, "snippet": "..." }
  ],
  "confidence": 0.92
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | q (string) required | q参数缺失或类型错误 |
| 400 | q exceeds maximum length | q超过长度限制 |
| 503 | CodeWikiOrchestrator not available | CodeWikiOrchestrator模块不可用 |

**安全注意事项**：
- 查询文本经过字符串长度校验，防止超长输入
- top_k参数强制限制在1-50范围内
- 需Bearer Token认证

### POST /api/workflow/compile
编译工作流DAG。将DSL定义编译为可执行的DAG结构，校验节点和边的合法性。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| nodes | array | 是 | 节点定义列表（至少1个节点，最多500个） |
| nodes[].id | string | 是 | 节点ID |
| nodes[].type | string | 否 | 节点类型：`task`（默认）/`parallel`/`conditional`/`verification`/`subgraph`/`checkpoint` |
| nodes[].agent | string | 否 | 执行Agent ID |
| nodes[].agents | string[] | 否 | 并行/验证节点的Agent列表 |
| nodes[].skill | string | 否 | 使用的技能ID |
| nodes[].mode | string | 否 | 执行模式 |
| nodes[].task | string | 否 | 任务描述 |
| nodes[].timeout | number | 否 | 节点超时时间（毫秒，默认300000） |
| nodes[].depends | string[] | 否 | 依赖节点ID列表 |
| nodes[].metadata | object | 否 | 节点元数据 |
| edges | array | 否 | 边定义列表 |
| edges[].from | string | 是 | 起始节点ID |
| edges[].to | string | 是 | 目标节点ID |
| edges[].type | string | 否 | 边类型：`sequential`（默认）/`conditional`/`parallel_fan_out`/`parallel_fan_in` |
| edges[].condition | string | 否 | 条件边条件名称（条件边时使用） |
| edges[].evaluator | function | 否 | 条件评估函数（条件边时使用，API调用时忽略） |
| edges[].priority | number | 否 | 条件边优先级（默认0） |
| checkpoints | string[] | 否 | 检查点节点ID列表 |
| tokenBudget | number | 否 | Token预算上限 |
| name | string | 否 | 工作流名称 |

**请求体示例**：
```json
{
  "name": "auth-module-workflow",
  "nodes": [
    { "id": "design", "type": "task", "task": "设计认证模块架构", "agent": "architect-01" },
    { "id": "implement", "type": "task", "task": "实现认证模块", "agent": "task-worker-01", "depends": ["design"] },
    { "id": "verify", "type": "verification", "task": "验证实现质量", "agents": ["reviewer-01", "reviewer-02"], "depends": ["implement"] }
  ],
  "edges": [
    { "from": "design", "to": "implement", "type": "sequential" },
    { "from": "implement", "to": "verify", "type": "sequential" }
  ],
  "checkpoints": ["implement"],
  "tokenBudget": 50000
}
```

**响应示例（编译成功）**：
```json
{
  "compiled": true,
  "nodeCount": 3,
  "edgeCount": 2,
  "conditionalCount": 0,
  "errors": []
}
```

**响应示例（编译失败）**：
```json
{
  "compiled": false,
  "nodeCount": 0,
  "edgeCount": 0,
  "conditionalCount": 0,
  "errors": ["DSL must contain at least one node"]
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | DSL body is required | 请求体缺失或非对象 |
| 500 | Compile failed | 编译过程异常 |
| 503 | Dynamic Workflow Engine not available | 工作流引擎不可用 |

**安全注意事项**：
- 节点数量上限500，防止资源耗尽
- 条件边数量上限为 `maxConditionalBranches × 节点数`（默认10×节点数）
- 请求体中的 `executeFn`/`verifyFn` 函数字段会被自动删除，防止代码注入
- 需Bearer Token认证

### POST /api/workflow/execute
执行已编译的工作流DAG。对DAG进行拓扑排序后按依赖顺序执行各节点，支持并行扇出、条件分支和自动检查点。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| executeFn | — | 否 | 自定义执行函数（API调用时自动删除，仅内部使用） |
| verifyFn | — | 否 | 自定义验证函数（API调用时自动删除，仅内部使用） |

**请求体示例**：
```json
{}
```

**响应示例（执行成功）**：
```json
{
  "success": true,
  "nodesExecuted": 3,
  "nodesFailed": 0,
  "nodesSkipped": 0,
  "tokensUsed": 12000,
  "durationMs": 35000
}
```

**响应示例（执行失败）**：
```json
{
  "success": false,
  "error": "DAG has cycles, cannot execute",
  "nodesExecuted": 1
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 500 | Execute failed | 执行过程异常 |
| 503 | Dynamic Workflow Engine not available | 工作流引擎不可用 |

**安全注意事项**：
- 工作流已在执行中时返回 `{ success: false, error: 'Workflow already executing' }`，防止重复执行
- DAG存在环时返回错误，不执行
- 请求体中的 `executeFn`/`verifyFn` 函数字段会被自动删除，防止代码注入
- Token预算耗尽时自动跳过未执行节点
- 需Bearer Token认证

### POST /api/workflow/status
获取工作流执行状态。返回当前引擎状态、执行ID、已执行节点数、Token使用量和检查点数量。

**请求体参数**：无

**响应示例**：
```json
{
  "status": "executing",
  "executionId": "dwe-1717700000000-abc123",
  "nodesExecuted": 5,
  "tokensUsed": 12000,
  "tokenBudget": 50000,
  "checkpointCount": 1
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| status | string | 引擎状态：`idle`/`compiling`/`executing`/`paused`/`completed`/`failed`/`rolled_back` |
| executionId | string\|null | 当前执行ID |
| nodesExecuted | number | 已执行节点数 |
| tokensUsed | number | 已消耗Token数 |
| tokenBudget | number | Token预算上限（0表示无限制） |
| checkpointCount | number | 检查点数量 |

**不可用状态响应**：
```json
{ "available": false, "message": "Dynamic Workflow Engine not available" }
```

### POST /api/workflow/rollback
回滚工作流到指定检查点。删除该检查点之后的所有检查点，恢复节点结果和执行计数，引擎状态变为 `rolled_back`。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| checkpointId | string | 是 | 目标检查点ID |

**请求体示例**：
```json
{ "checkpointId": "dwe-cp-1717700000000-abc123" }
```

**响应示例（成功）**：
```json
{ "rolledBack": true, "checkpointId": "dwe-cp-1717700000000-abc123" }
```

**响应示例（失败）**：
```json
{ "rolledBack": false, "error": "Checkpoint not found" }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | checkpointId is required | checkpointId参数缺失 |
| 503 | Dynamic Workflow Engine not available | 工作流引擎不可用 |

**安全注意事项**：
- 回滚操作不可逆，指定检查点之后的所有检查点将被删除
- 需Bearer Token认证

### POST /api/workflow/pause
暂停正在执行的工作流。仅在引擎状态为 `executing` 时可暂停，暂停时自动创建检查点。

**请求体参数**：无

**响应示例（成功）**：
```json
{ "paused": true }
```

**响应示例（失败）**：
```json
{ "paused": false, "reason": "Not executing" }
```

**不可用状态响应**：
```json
{ "available": false, "message": "Dynamic Workflow Engine not available" }
```

**安全注意事项**：
- 仅在执行中状态可暂停，其他状态返回 `paused: false`
- 暂停时自动创建检查点，可用于后续恢复
- 需Bearer Token认证

### POST /api/workflow/checkpoints
获取工作流检查点列表。返回所有已创建的检查点摘要信息。

**请求体参数**：无

**响应示例**：
```json
[
  {
    "id": "dwe-cp-1717700000000-abc123",
    "executionId": "dwe-1717700000000-abc123",
    "status": "executing",
    "nodesExecuted": 5,
    "tokensUsed": 12000,
    "timestamp": "2026-06-07T10:00:00.000Z"
  }
]
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 检查点ID |
| executionId | string | 所属执行ID |
| status | string | 创建时的引擎状态 |
| nodesExecuted | number | 创建时已执行节点数 |
| tokensUsed | number | 创建时已消耗Token数 |
| timestamp | string | 创建时间（ISO格式） |

**不可用状态响应**：
```json
{ "available": false, "message": "Dynamic Workflow Engine not available" }
```

### POST /api/workflow/node-types
获取工作流节点类型列表。返回DynamicWorkflowEngine支持的所有节点类型。

**请求体参数**：无

**响应示例**：
```json
{ "nodeTypes": ["task", "parallel", "conditional", "verification", "subgraph", "checkpoint"] }
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| nodeTypes | string[] | 节点类型列表 |

**节点类型说明**：
| 类型 | 说明 |
|------|------|
| task | 任务节点，通过子Agent执行单个任务 |
| parallel | 并行节点，将任务分发给多个Agent并行执行 |
| conditional | 条件节点，根据条件分支选择执行路径 |
| verification | 验证节点，使用双Agent对抗审查 |
| subgraph | 子图节点，嵌套子工作流 |
| checkpoint | 检查点节点，标记自动保存点 |

### POST /api/workflow/edge-types
获取工作流边类型列表。返回DynamicWorkflowEngine支持的所有边类型。

**请求体参数**：无

**响应示例**：
```json
{ "edgeTypes": ["sequential", "conditional", "parallel_fan_out", "parallel_fan_in"] }
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| edgeTypes | string[] | 边类型列表 |

**边类型说明**：
| 类型 | 说明 |
|------|------|
| sequential | 顺序边，按依赖关系顺序执行 |
| conditional | 条件边，根据上游节点结果评估条件分支 |
| parallel_fan_out | 并行扇出边，将执行分发到多个下游节点 |
| parallel_fan_in | 并行扇入边，汇聚多个上游节点结果 |

### POST /api/workflow/conditions
评估工作流条件。返回DynamicWorkflowEngine内置的条件评估器列表，用于条件边的 `condition` 字段。

**请求体参数**：无

**响应示例**：
```json
{ "conditions": ["default", "success", "failure", "hasIssues", "noIssues", "hasOutput", "verified", "notVerified"] }
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| conditions | string[] | 内置条件名称列表 |

**内置条件说明**：
| 条件 | 说明 |
|------|------|
| default | 默认条件，始终为true |
| success | 上游节点执行成功 |
| failure | 上游节点执行失败 |
| hasIssues | 上游输出包含issues数组且非空 |
| noIssues | 上游输出无issues或issues为空 |
| hasOutput | 上游输出非null/undefined |
| verified | 上游输出中 `verified` 为true |
| notVerified | 上游输出中 `verified` 不为true |

> **注意**：除内置条件外，条件边还支持自定义属性条件——当上游输出为对象且包含与条件同名的属性时，以该属性的布尔值为评估结果。

### POST /api/harness/lifecycle/status
获取Harness生命周期状态。通过TaskLifecycleOrchestrator返回当前生命周期阶段、轮次和评估信息。

**请求体参数**：无

**响应示例**：
```json
{
  "phase": "executing",
  "currentRound": 3,
  "maxRounds": 10,
  "contextMode": "normal",
  "evaluationThreshold": 0.8,
  "evaluationCount": 2,
  "hasSpec": true
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| phase | string | 当前生命周期阶段 |
| currentRound | number | 当前执行轮次 |
| maxRounds | number | 最大轮次 |
| contextMode | string | 上下文模式（normal等） |
| evaluationThreshold | number | 评估通过阈值 |
| evaluationCount | number | 评估历史记录数量 |
| hasSpec | boolean | 是否已加载规格说明 |

**不可用状态响应**：
```json
{ "phase": "unavailable", "currentRound": 0, "maxRounds": 0, "contextMode": "normal", "evaluationThreshold": 0, "evaluationCount": 0, "hasSpec": false }
```

### POST /api/delivery-acceleration/diagnose
交付加速瓶颈诊断。通过DeliveryAccelerationOrchestrator分析当前交付流程中的瓶颈问题。

**请求体参数**：无

**响应示例（可用）**：
```json
{
  "available": true,
  "diagnosis": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | DeliveryAccelerationOrchestrator是否可用 |
| diagnosis | object\|null | 瓶颈诊断结果（由DeliveryAccelerationOrchestrator.diagnoseBottlenecks()返回） |

**不可用状态响应**：
```json
{ "available": false, "error": "DeliveryAccelerationOrchestrator not available" }
```

| 不可用条件 | 说明 |
|-----------|------|
| DeliveryAccelerationOrchestrator not available | 交付加速编排器未初始化（`_rt('deliveryAccelerationOrchestrator')`返回null） |

**安全注意事项**：
- 需Bearer Token认证

### POST /api/delivery-acceleration/recommend-mode
推荐工作流模式。通过DeliveryAccelerationOrchestrator根据当前项目状态推荐最优工作流模式。

**请求体参数**：无

**响应示例（可用）**：
```json
{
  "available": true,
  "recommendation": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | DeliveryAccelerationOrchestrator是否可用 |
| recommendation | object | 推荐结果（由DeliveryAccelerationOrchestrator.recommendWorkflowMode()返回） |

**不可用状态响应**：
```json
{ "available": false, "error": "DeliveryAccelerationOrchestrator not available" }
```

| 不可用条件 | 说明 |
|-----------|------|
| DeliveryAccelerationOrchestrator not available | 交付加速编排器未初始化 |

> **关联端点**：推荐的工作流模式可通过 `POST /api/delivery-acceleration/switch-mode` 端点切换。有效模式包括：`STANDARD`、`ARCHITECTURE_FIRST`、`AI_WRITE_TEST_FIX`、`HUMAN_REVIEW_DECIDE`。

**安全注意事项**：
- 需Bearer Token认证

### POST /api/pair-chat/cross-validation-report
交叉验证报告。通过PairChat获取指定会话的交叉验证报告，包含双Agent对抗审查的详细结果。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string | 是 | 会话ID（最大256字符） |

**请求体示例**：
```json
{ "sessionId": "cv-session-001" }
```

**响应示例（可用）**：
```json
{
  "available": true,
  "report": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | PairChat是否可用 |
| report | object | 交叉验证报告（由PairChat.getCrossValidationReport()返回） |

**不可用状态响应**：
```json
{ "available": false }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | sessionId is required | sessionId参数缺失 |
| 400 | Invalid sessionId format | sessionId类型错误或超过256字符 |
| 404 | Cross-validation session not found | 指定会话不存在 |

**安全注意事项**：
- sessionId长度限制256字符，防止超长输入
- 需Bearer Token认证

### POST /api/pair-chat/cross-validation-stats
交叉验证统计。通过PairChat获取交叉验证的汇总统计数据。

**请求体参数**：无

**响应示例（可用）**：
```json
{
  "available": true,
  "stats": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | PairChat是否可用 |
| stats | object | 交叉验证统计（由PairChat.getCrossValidationStats()返回） |

**不可用状态响应**：
```json
{ "available": false }
```

**安全注意事项**：
- 需Bearer Token认证

### POST /api/chat-chain/artifact-flow
产物流转查询。通过ChatChain获取指定链的产物流转信息，追踪各阶段产物的传递关系。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| chainId | string | 是 | 链ID（最大256字符） |

**请求体示例**：
```json
{ "chainId": "chain-001" }
```

**响应示例（可用）**：
```json
{
  "available": true,
  "flow": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | ChatChain是否可用 |
| flow | object | 产物流转数据（由ChatChain.getArtifactFlow()返回） |

**不可用状态响应**：
```json
{ "available": false }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | chainId is required | chainId参数缺失 |
| 400 | Invalid chainId format | chainId类型错误或超过256字符 |
| 404 | Chain not found | 指定链不存在 |

**安全注意事项**：
- chainId长度限制256字符，防止超长输入
- 需Bearer Token认证

### POST /api/chat-chain/phase-artifacts
阶段产物查询。通过ChatChain获取指定链中特定阶段的产物信息。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| chainId | string | 是 | 链ID（最大256字符） |
| phase | string | 是 | 阶段名称 |

**请求体示例**：
```json
{ "chainId": "chain-001", "phase": "architecture-design" }
```

**响应示例（可用）**：
```json
{
  "available": true,
  "artifacts": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | ChatChain是否可用 |
| artifacts | object | 阶段产物数据（由ChatChain.getPhaseArtifacts()返回） |

**不可用状态响应**：
```json
{ "available": false }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | chainId and phase are required | chainId或phase参数缺失 |
| 400 | Invalid chainId format | chainId类型错误或超过256字符 |
| 404 | Chain not found | 指定链不存在 |

**安全注意事项**：
- chainId长度限制256字符，防止超长输入
- 需Bearer Token认证

### GET /api/ooda/speed
OODA决策速度。获取OODA循环（Observe-Orient-Decide-Act）的决策速度指标，包括各阶段的耗时统计。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "observeSpeed": 120,
  "orientSpeed": 85,
  "decideSpeed": 200,
  "actSpeed": 150,
  "totalCycleSpeed": 555
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | OodaLoop是否可用 |
| 其他字段 | any | 由OodaLoop.getCycleSpeed()返回的速度指标（展开到顶层） |

**不可用状态响应**：
```json
{ "available": false, "message": "OodaLoop not initialized" }
```

| 不可用消息 | 说明 |
|-----------|------|
| OodaLoop not initialized | OodaLoop模块未初始化 |
| OodaLoop missing getCycleSpeed method | OodaLoop缺少getCycleSpeed方法 |
| OODA speed check failed | 内部异常被try-catch捕获 |

### GET /api/ooda/history
OODA决策历史。获取OODA循环的历史记录大小和配置信息。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "historySize": 100,
  "config": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | OodaLoop是否可用 |
| historySize | number | 历史记录大小 |
| config | object | OodaLoop配置信息 |

**不可用状态响应**：
```json
{ "available": false, "message": "OodaLoop not initialized", "history": {} }
```

| 不可用消息 | 说明 |
|-----------|------|
| OodaLoop not initialized | OodaLoop模块未初始化 |
| OodaLoop missing getStats method | OodaLoop缺少getStats方法 |
| OodaLoop getStats returned invalid result | getStats返回无效结果 |
| OODA history check failed | 内部异常被try-catch捕获 |

### GET /api/skill-distillation/history
技能蒸馏历史。获取SkillDistiller的蒸馏执行历史记录，最多返回50条。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "history": []
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | SkillDistiller是否可用 |
| history | array | 蒸馏历史记录（由SkillDistiller.getDistillationHistory()返回，最多50条） |

**不可用状态响应**：
```json
{ "available": false, "history": [], "message": "SkillDistiller not initialized" }
```

| 不可用消息 | 说明 |
|-----------|------|
| SkillDistiller not initialized | SkillDistiller模块未初始化 |
| SkillDistiller missing getDistillationHistory method | SkillDistiller缺少getDistillationHistory方法 |
| SkillDistillation history check failed | 内部异常被try-catch捕获 |

### GET /api/skill-distillation/traces
技能蒸馏追踪。获取SkillDistiller的最近追踪记录，最多返回100条。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "traces": []
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | SkillDistiller是否可用 |
| traces | array | 追踪记录（由SkillDistiller.getRecentTraces()返回，最多100条） |

**不可用状态响应**：
```json
{ "available": false, "traces": [], "message": "SkillDistiller not initialized" }
```

| 不可用消息 | 说明 |
|-----------|------|
| SkillDistiller not initialized | SkillDistiller模块未初始化 |
| SkillDistiller missing getRecentTraces method | SkillDistiller缺少getRecentTraces方法 |
| SkillDistillation traces check failed | 内部异常被try-catch捕获 |

### POST /api/architecture/orchestrate
启动架构编排执行。通过AgentArchitectureOrchestrator协调架构编排流程，执行渐进式披露、约束编译、自验证循环和熵治理等架构支柱。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| task | string | 是 | 架构编排任务描述（非空字符串） |
| agents | array | 否 | 参与编排的Agent列表 |
| options | object | 否 | 编排选项（如phase等） |

**请求体示例**：
```json
{ "task": "设计认证模块架构", "agents": ["architect-01"], "options": { "phase": "architecture-design" } }
```

**响应示例（成功）**：
```json
{
  "status": "completed",
  "pillars": ["progressive_disclosure", "constraint_enforcement", "self_validation", "context_isolation", "entropy_governance"],
  "entropyLevel": "low"
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | task is required | task参数缺失 |
| 500 | Architecture orchestration failed | 编排执行过程异常 |
| 503 | AgentArchitectureOrchestrator not available | 架构编排器模块不可用 |

**安全注意事项**：
- task参数必须为非空字符串
- 需Bearer Token认证

### GET /api/architecture/status
获取架构编排器当前状态。通过AgentArchitectureOrchestrator返回架构状态信息。

**请求参数**：无

**响应示例**：
```json
{
  "status": "idle",
  "entropyLevel": "low",
  "constraintCount": 5,
  "moduleCount": 12
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | AgentArchitectureOrchestrator not available | 架构编排器模块不可用 |

### GET /api/architecture/entropy
获取架构熵值报告。通过AgentArchitectureOrchestrator返回当前架构熵评分和等级。

**请求参数**：无

**响应示例**：
```json
{
  "entropyScore": 0.35,
  "entropyLevel": "low",
  "metrics": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| entropyScore | number | 熵评分（0-1） |
| entropyLevel | string | 熵等级：`low`/`medium`/`high`/`critical` |
| metrics | object | 熵度量详情 |

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | AgentArchitectureOrchestrator not available | 架构编排器模块不可用 |

### POST /api/architecture/entropy/govern
执行架构熵治理。通过EntropyGovernanceOrchestrator对高熵架构进行治理，降低架构复杂度。

**请求体参数**：无

**响应示例**：
```json
{
  "governed": true,
  "previousLevel": "high",
  "currentLevel": "medium",
  "actions": []
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | AgentArchitectureOrchestrator not available | 架构编排器模块不可用 |

**安全注意事项**：
- 需Bearer Token认证

### GET /api/architecture/constraints
获取架构约束注册表。通过AgentArchitectureOrchestrator返回已注册的架构约束列表。

**请求参数**：无

**响应示例**：
```json
{
  "constraints": [
    { "name": "no-circular-deps", "type": "hard_coded", "content": "..." },
    { "name": "naming-convention", "type": "prompt_suggestion", "content": "..." }
  ]
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | AgentArchitectureOrchestrator not available | 架构编排器模块不可用 |

### GET /api/architecture/modules
获取架构模块注册表。通过AgentArchitectureOrchestrator返回已注册的架构模块列表。

**请求参数**：无

**响应示例**：
```json
{
  "modules": [
    { "name": "runtime", "pillar": "context_isolation", "status": "active" }
  ]
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | AgentArchitectureOrchestrator not available | 架构编排器模块不可用 |

### GET /api/architecture/constants
获取架构常量定义。返回架构编排器使用的枚举常量，包括架构支柱、约束类型和熵等级。

**请求参数**：无

**响应示例**：
```json
{
  "ARCHITECTURE_PILLAR": {
    "PROGRESSIVE_DISCLOSURE": "progressive_disclosure",
    "CONSTRAINT_ENFORCEMENT": "constraint_enforcement",
    "SELF_VALIDATION": "self_validation",
    "CONTEXT_ISOLATION": "context_isolation",
    "ENTROPY_GOVERNANCE": "entropy_governance"
  },
  "CONSTRAINT_TYPE": {
    "PROMPT_SUGGESTION": "prompt_suggestion",
    "HARD_CODED": "hard_coded",
    "LINTER": "linter"
  },
  "ENTROPY_LEVEL": {
    "LOW": "low",
    "MEDIUM": "medium",
    "HIGH": "high",
    "CRITICAL": "critical"
  }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| ARCHITECTURE_PILLAR | object | 六大架构支柱枚举 |
| CONSTRAINT_TYPE | object | 约束类型枚举（prompt_suggestion/hard_coded/linter） |
| ENTROPY_LEVEL | object | 熵等级枚举（low/medium/high/critical） |

### POST /api/orchestrator/orchestrate
启动多智能体编排执行。通过MultiAgentOrchestrator协调多Agent执行任务，支持分层上下文管理、熔断器保护和自动终止检测。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| task | string | 是 | 编排任务描述（非空字符串） |
| agents | array | 否 | 参与编排的Agent列表 |
| options | object | 否 | 编排选项（如constraints、maxIterations等） |

**请求体示例**：
```json
{ "task": "实现用户认证模块", "agents": ["task-worker-01", "reviewer-01"], "options": { "constraints": ["使用JWT"], "maxIterations": 10 } }
```

**响应示例（成功）**：
```json
{
  "terminationReason": "dod_met",
  "iterations": 5,
  "qualityScore": 0.92,
  "tokensUsed": 15000
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | task is required | task参数缺失 |
| 500 | Orchestration failed | 编排执行过程异常 |
| 503 | MultiAgentOrchestrator not available | 多智能体编排器模块不可用 |

**安全注意事项**：
- task参数必须为非空字符串
- 编排器已在运行时返回错误，防止重复执行
- 需Bearer Token认证

### GET /api/orchestrator/status
获取编排器当前状态。通过MultiAgentOrchestrator返回编排器运行状态信息。

**请求参数**：无

**响应示例**：
```json
{
  "status": "idle",
  "iterations": 0,
  "lastQualityScore": 0,
  "circuitOpen": false
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| status | string | 编排器状态：`idle`/`running`/`paused`/`completed`/`failed`/`escalated`/`circuit_open` |
| iterations | number | 当前迭代次数 |
| lastQualityScore | number | 最近质量评分 |
| circuitOpen | boolean | 熔断器是否开启 |

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | MultiAgentOrchestrator not available | 多智能体编排器模块不可用 |

### POST /api/orchestrator/pause
暂停编排执行。将运行中的编排器暂停，暂停后可通过 `/api/orchestrator/resume` 恢复。

**请求体参数**：无

**响应示例**：
```json
{ "paused": true }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | MultiAgentOrchestrator not available | 多智能体编排器模块不可用 |

**安全注意事项**：
- 仅在运行中状态可暂停
- 需Bearer Token认证

### POST /api/orchestrator/resume
恢复编排执行。恢复之前暂停的编排器继续执行。

**请求体参数**：无

**响应示例**：
```json
{ "resumed": true }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | MultiAgentOrchestrator not available | 多智能体编排器模块不可用 |

**安全注意事项**：
- 仅在暂停状态可恢复
- 需Bearer Token认证

### GET /api/orchestrator/log
获取编排执行日志。通过MultiAgentOrchestrator返回编排过程的执行日志。

**请求参数**：无

**响应示例**：
```json
{
  "log": [
    { "iteration": 1, "agent": "task-worker-01", "action": "execute", "timestamp": "2026-06-07T10:00:00.000Z" }
  ]
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | MultiAgentOrchestrator not available | 多智能体编排器模块不可用 |

### GET /api/orchestrator/context
获取分层上下文。通过MultiAgentOrchestrator返回三层分层上下文（长期/阶段/即时）的当前状态。

**请求参数**：无

**响应示例**：
```json
{
  "long_term": { "goal": "实现认证模块", "constraints": [], "agents": ["task-worker-01"], "maxTokens": 40000 },
  "phase": { "entries": [], "maxTokens": 35000 },
  "immediate": { "entries": [], "maxTokens": 25000 }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| long_term | object | 长期上下文层（约40% Token预算），包含目标、约束和Agent列表 |
| phase | object | 阶段上下文层（约35% Token预算），包含当前阶段条目 |
| immediate | object | 即时上下文层（约25% Token预算），包含当前操作条目 |

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | MultiAgentOrchestrator not available | 多智能体编排器模块不可用 |

### GET /api/orchestrator/termination-history
获取编排终止历史。通过MultiAgentOrchestrator返回历史编排终止记录。

**请求参数**：无

**响应示例**：
```json
{
  "history": [
    { "reason": "dod_met", "iteration": 5, "qualityScore": 0.92, "timestamp": "2026-06-07T10:05:00.000Z" }
  ]
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | MultiAgentOrchestrator not available | 多智能体编排器模块不可用 |

### GET /api/orchestrator/circuit-breaker
获取熔断器状态。通过MultiAgentOrchestrator返回熔断器的当前状态，用于判断编排是否因连续失败而被熔断。

**请求参数**：无

**响应示例**：
```json
{
  "open": false,
  "failures": 0,
  "threshold": 5
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| open | boolean | 熔断器是否开启（开启时编排终止） |
| failures | number | 连续失败次数 |
| threshold | number | 熔断阈值 |

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | MultiAgentOrchestrator not available | 多智能体编排器模块不可用 |

### GET /api/orchestrator/constants
获取编排器常量定义。返回多智能体编排器使用的枚举常量，包括编排器状态、终止原因和上下文层级。

**请求参数**：无

**响应示例**：
```json
{
  "ORCHESTRATOR_STATUS": {
    "IDLE": "idle",
    "RUNNING": "running",
    "PAUSED": "paused",
    "COMPLETED": "completed",
    "FAILED": "failed",
    "ESCALATED": "escalated",
    "CIRCUIT_OPEN": "circuit_open"
  },
  "TERMINATION_REASON": {
    "DOD_MET": "dod_met",
    "BUDGET_EXHAUSTED": "budget_exhausted",
    "NO_PROGRESS": "no_progress",
    "BOUNDARY_EXCEEDED": "boundary_exceeded",
    "MAX_ITERATIONS": "max_iterations",
    "CIRCUIT_OPEN": "circuit_open"
  },
  "CONTEXT_LAYER": {
    "LONG_TERM": "long_term",
    "PHASE": "phase",
    "IMMEDIATE": "immediate"
  }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| ORCHESTRATOR_STATUS | object | 编排器状态枚举（idle/running/paused/completed/failed/escalated/circuit_open） |
| TERMINATION_REASON | object | 终止原因枚举（dod_met/budget_exhausted/no_progress/boundary_exceeded/max_iterations/circuit_open） |
| CONTEXT_LAYER | object | 上下文层级枚举（long_term/phase/immediate） |

### POST /api/code-wiki/chat
AI聊天式代码库查询。通过CodeWikiOrchestrator对代码知识库执行自然语言对话式查询，返回AI生成的回答。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| question | string | 是 | 问题文本（非空字符串，最大长度受validateStringLength限制） |
| top_k | number | 否 | 返回结果数量，范围1-50，默认5 |

**请求体示例**：
```json
{ "question": "Agent生命周期是如何管理的？", "top_k": 10 }
```

**响应示例**：
```json
{
  "answer": "Agent生命周期管理通过ManagedAgentHost实现，支持启动、暂停、恢复和停止等操作...",
  "sources": [
    { "file": "src/runtime/agent/managed-agent-host.js", "relevance": 0.95, "snippet": "..." }
  ],
  "confidence": 0.92
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | question (string) required | question参数缺失或类型错误 |
| 400 | question exceeds maximum length | question超过长度限制 |
| 503 | CodeWikiOrchestrator not available | CodeWikiOrchestrator模块不可用 |

**安全注意事项**：
- 问题文本经过字符串长度校验，防止超长输入
- top_k参数强制限制在1-50范围内
- 需Bearer Token认证

### POST /api/code-wiki/dependency-diagram
依赖关系图。通过CodeWikiOrchestrator生成指定文件的依赖关系图，支持控制递归深度。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| filePath | string | 是 | 文件路径（非空字符串，经过路径安全校验） |
| maxDepth | number | 否 | 最大递归深度，大于0，默认3 |

**请求体示例**：
```json
{ "filePath": "src/runtime/agent/managed-agent-host.js", "maxDepth": 5 }
```

**响应示例**：
```json
{
  "filePath": "src/runtime/agent/managed-agent-host.js",
  "dependencies": {
    "nodes": [
      { "id": "managed-agent-host", "label": "managed-agent-host.js" },
      { "id": "agent-state", "label": "agent-state.js" }
    ],
    "edges": [
      { "from": "managed-agent-host", "to": "agent-state", "type": "import" }
    ]
  },
  "maxDepth": 5
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | filePath (string) required | filePath参数缺失或类型错误 |
| 400 | filePath contains unsafe path characters | filePath未通过路径安全校验 |
| 503 | CodeWikiOrchestrator not available | CodeWikiOrchestrator模块不可用 |

**安全注意事项**：
- filePath经过路径安全校验（`_validatePathSafety`），防止路径遍历攻击
- maxDepth参数强制为正整数，默认3
- 需Bearer Token认证

### POST /api/code-wiki/code-change
代码变更影响分析。通过CodeWikiOrchestrator分析指定文件变更后的影响范围。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| filePath | string | 是 | 变更文件路径（非空字符串，经过路径安全校验） |
| changeType | string | 否 | 变更类型（默认`modify`） |

**请求体示例**：
```json
{ "filePath": "src/runtime/agent/managed-agent-host.js", "changeType": "modify" }
```

**响应示例**：
```json
{
  "filePath": "src/runtime/agent/managed-agent-host.js",
  "changeType": "modify",
  "impactedFiles": [
    "src/runtime/agent/agent-state.js",
    "src/web/server.js"
  ],
  "impactAnalysis": {}
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | filePath (string) required | filePath参数缺失或类型错误 |
| 400 | filePath contains unsafe path characters | filePath未通过路径安全校验 |
| 503 | CodeWikiOrchestrator not available | CodeWikiOrchestrator模块不可用 |

**安全注意事项**：
- filePath经过路径安全校验（`_validatePathSafety`），防止路径遍历攻击
- changeType参数为字符串类型，默认`modify`
- 需Bearer Token认证

### POST /api/chat/start
启动聊天会话。通过ConversationContextStore创建新的聊天会话，支持指定会话ID和元数据。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string | 否 | 会话ID（未提供时自动生成，格式校验`[a-zA-Z0-9_-]+`） |
| metadata | object | 否 | 会话元数据（自动设置source为`dashboard`，type为`chat`） |

**请求体示例**：
```json
{ "sessionId": "chat-1717700000000-abc123", "metadata": { "topic": "架构设计" } }
```

**响应示例（新建会话）**：
```json
{
  "success": true,
  "sessionId": "chat-1717700000000-abc123",
  "restored": false
}
```

**响应示例（恢复已有会话）**：
```json
{
  "success": true,
  "sessionId": "chat-1717700000000-abc123",
  "restored": true
}
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | Failed to start session | 会话启动失败（如sessionId格式错误） |
| 503 | Conversation store not available | ConversationContextStore模块不可用 |

**安全注意事项**：
- sessionId经过格式校验（`_validateIdFormat`），防止注入
- metadata中的source和type字段会被强制覆盖为`dashboard`和`chat`
- 需Bearer Token认证

### GET /api/terminal/allowed-commands
获取允许执行的终端命令列表。返回当前终端API白名单中所有允许的命令名称，按字母排序。

**请求参数**：无

**响应示例**：
```json
{
  "commands": ["cat", "date", "diff", "echo", "env", "find", "git", "grep", "head", "ls", "mkdir", "mv", "pwd", "rg", "sort", "tail", "test", "tr", "true", "uniq", "wc", "which"]
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| commands | string[] | 允许的命令列表（按字母排序） |

### GET /api/terminal/commands
获取所有已注册的斜杠命令列表。通过CommandRouter返回所有可用的斜杠命令。

**请求参数**：无

**可用状态响应**：
```json
{
  "commands": [
    { "name": "/status", "description": "获取系统状态" },
    { "name": "/help", "description": "显示帮助信息" }
  ]
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| commands | array | 斜杠命令列表（由CommandRouter.listCommands()返回） |

**不可用状态响应**：
```json
{ "available": false, "message": "Command router not available" }
```

| 不可用消息 | 说明 |
|-----------|------|
| Command router not available | CommandRouter模块不可用（`_rt('commandRouter')`返回null） |

### POST /api/fs/list
列出目录内容。基于ServiceFS虚拟文件系统，返回指定路径下的文件和目录条目，支持分页。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 是 | 目录路径（最大512字符） |
| limit | number | 否 | 返回条数限制，默认200，最大200 |

**请求体示例**：
```json
{ "path": "src/runtime", "limit": 50 }
```

**响应示例**：
```json
{
  "path": "src/runtime",
  "entries": [
    { "name": "agent", "type": "directory" },
    { "name": "index.js", "type": "file", "size": 1024 }
  ],
  "total": 42,
  "truncated": false
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| path | string | 请求的目录路径 |
| entries | array | 目录条目列表（由ServiceFS.ls()返回） |
| total | number | 条目总数 |
| truncated | boolean | 是否因limit截断 |

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | path is required and must be a string | path参数缺失或类型错误 |
| 400 | path exceeds maximum length (512) | path超过长度限制 |
| 404 | — | 路径不存在（RESOURCE_NOT_FOUND） |
| 400 | — | 输入无效（INVALID_INPUT） |
| 503 | ServiceFS not available | ServiceFS模块不可用 |

**安全注意事项**：
- 路径长度限制512字符
- limit参数强制限制在1-200范围内
- ServiceFS内建路径遍历防护，防止目录穿越攻击
- 需Bearer Token认证

### GET /api/browser-use/cdp-status
获取CDP（Chrome DevTools Protocol）连接状态。通过CdpClient返回CDP连接信息和目标页面信息。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "connected": true,
  "targetInfo": {
    "id": "target-xxx",
    "url": "https://example.com",
    "title": "Example Page",
    "type": "page"
  }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | CDP客户端是否已初始化 |
| connected | boolean | CDP是否已连接（由cdpClient.isConnected()返回） |
| targetInfo | object\|null | 当前目标页面信息（仅连接时返回） |
| targetInfo.id | string\|null | 目标ID |
| targetInfo.url | string\|null | 目标URL |
| targetInfo.title | string\|null | 目标页面标题 |
| targetInfo.type | string\|null | 目标类型 |

**不可用状态响应**：
```json
{
  "available": false,
  "connected": false,
  "message": "CDP client not initialized"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| CDP client not initialized | CDP客户端未初始化（`_rt('cdpClient')`返回null） |

### GET /api/browser-use/screenshots
获取浏览器截图列表。通过BrowserUseAdapter返回截图缓存中的截图元数据列表，最多200条。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "count": 5,
  "screenshots": [
    { "label": "page-load", "timestamp": 1717700000000 },
    { "label": "after-click", "timestamp": 1717700001000 }
  ]
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | BrowserUse适配器是否可用 |
| count | number | 截图数量 |
| screenshots | array | 截图元数据列表（最多200条） |
| screenshots[].label | string | 截图标签（默认`unnamed`） |
| screenshots[].timestamp | number\|null | 截图时间戳（`Number.isFinite`校验） |

**不可用状态响应**：
```json
{
  "available": false,
  "screenshots": [],
  "message": "BrowserUse adapter not initialized"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| BrowserUse adapter not initialized | BrowserUse适配器未初始化（`_rt('browserUseAdapter')`返回null） |
| BrowserUse adapter missing getScreenshotCache method | 适配器缺少getScreenshotCache方法 |

### POST /api/dev-metrics/history
获取历史度量数据。通过DevMetricsCollector返回最近的历史度量记录，支持限制返回条数。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| limit | number | 否 | 返回条数限制，范围1-100，默认10 |

**请求体示例**：
```json
{ "limit": 20 }
```

**响应示例（可用）**：
```json
{
  "available": true,
  "history": [
    { "timestamp": "2026-06-07T10:00:00.000Z", "metrics": {} },
    { "timestamp": "2026-06-07T11:00:00.000Z", "metrics": {} }
  ]
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | DevMetricsCollector是否可用 |
| history | array | 历史度量记录（由DevMetricsCollector.getHistory()返回） |

**不可用状态响应**：
```json
{ "available": false }
```

| 不可用条件 | 说明 |
|-----------|------|
| DevMetricsCollector not initialized（`_rt('devMetricsCollector')`返回null） | 度量收集器未初始化 |

**安全注意事项**：
- limit参数强制限制在1-100范围内（超出范围自动裁剪）
- 需Bearer Token认证

### POST /api/harness/migration/report
获取Harness迁移报告。通过HarnessMigrationEngine返回当前迁移状态，包括模型能力等级和组件活跃状态。

**请求体参数**：无

**响应示例**：
```json
{
  "tier": "standard",
  "activeComponents": ["task-worker", "reviewer"],
  "inactiveComponents": ["legacy-adapter"]
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| tier | string | 当前模型能力等级：`unknown`/`weak`/`standard`/`strong`/`frontier` |
| activeComponents | string[] | 活跃组件列表 |
| inactiveComponents | string[] | 非活跃组件列表 |

**不可用状态响应**：
```json
{ "tier": "unknown", "activeComponents": [], "inactiveComponents": [] }
```

| 不可用条件 | 说明 |
|-----------|------|
| HarnessMigrationEngine not available（`_rt('harnessMigrationEngine')`返回null） | 迁移引擎未初始化 |

### POST /api/harness/migration/tier
更新模型能力等级。通过HarnessMigrationEngine设置当前模型能力等级，影响组件承重和任务分配策略。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| tier | string | 是 | 模型能力等级：`weak`/`standard`/`strong`/`frontier` |

**请求体示例**：
```json
{ "tier": "strong" }
```

**响应示例**：
```json
{ "tier": "strong", "updated": true }
```

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | tier is required (weak/standard/strong/frontier) | tier参数缺失 |
| 400 | Invalid tier. Must be: weak/standard/strong/frontier | tier值不在合法枚举范围内 |
| 503 | HarnessMigrationEngine not available | HarnessMigrationEngine模块不可用 |

**安全注意事项**：
- tier参数经过枚举白名单校验（`weak`/`standard`/`strong`/`frontier`），防止注入
- 需Bearer Token认证

### POST /api/skill-reducer/overload
技能过载检测。通过SkillReducer检测当前技能系统是否处于过载状态，支持指定自定义Token预算进行检测。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| tokenBudget | number | 否 | 自定义Token预算（必须为大于0的数字，未提供时使用SkillReducer默认预算） |

**请求体示例**：
```json
{ "tokenBudget": 8000 }
```

**可用状态响应**：
```json
{
  "available": true,
  "overload": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | SkillReducer是否可用且支持detectOverload方法 |
| overload | object | 过载检测结果（由SkillReducer.detectOverload(budget)返回） |

**不可用状态响应**：
```json
{ "available": false }
```

| 不可用条件 | 说明 |
|-----------|------|
| SkillReducer not initialized（`_rt('skillReducer')`返回null） | SkillReducer模块未初始化 |
| SkillReducer missing detectOverload method | SkillReducer缺少detectOverload方法 |

**安全注意事项**：
- tokenBudget参数经过类型和值校验（必须为number且大于0），无效值时使用默认预算
- 需Bearer Token认证

### POST /api/skill-reducer/compressed-context
获取压缩上下文估算。通过SkillReducer获取技能上下文压缩后的Token估算数据。

**请求体参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "estimate": {}
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | SkillReducer是否可用且支持getCompressedContextEstimate方法 |
| estimate | object | 压缩上下文估算数据（由SkillReducer.getCompressedContextEstimate()返回） |

**不可用状态响应**：
```json
{ "available": false }
```

| 不可用条件 | 说明 |
|-----------|------|
| SkillReducer not initialized（`_rt('skillReducer')`返回null） | SkillReducer模块未初始化 |
| SkillReducer missing getCompressedContextEstimate method | SkillReducer缺少getCompressedContextEstimate方法 |

**安全注意事项**：
- 需Bearer Token认证

### GET /api/skill-effectiveness/accuracy
技能准确性统计。通过SkillEffectivenessOptimizer获取技能调用的准确性指标，包括精确率、召回率、F1值和误报率。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "precision": 0.89,
  "recall": 0.85,
  "f1": 0.87,
  "falsePositiveRate": 0.05,
  "totalInvocations": 256,
  "correctInvocations": 220
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | SkillEffectivenessOptimizer是否可用 |
| precision | number | 精确率（`Number.isFinite`校验，默认0） |
| recall | number | 召回率（`Number.isFinite`校验，默认0） |
| f1 | number | F1分数（`Number.isFinite`校验，默认0） |
| falsePositiveRate | number | 误报率（`Number.isFinite`校验，默认0） |
| totalInvocations | number | 总调用次数（`Number.isFinite`校验，默认0） |
| correctInvocations | number | 正确调用次数（`Number.isFinite`校验，默认0） |

**不可用状态响应**：
```json
{
  "available": false,
  "message": "SkillEffectivenessOptimizer not initialized"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| SkillEffectivenessOptimizer not initialized | 优化器模块未初始化 |
| SkillEffectivenessOptimizer missing getAccuracyMetrics method | 优化器缺少getAccuracyMetrics方法 |
| SkillEffectiveness accuracy check failed | 内部异常被try-catch捕获 |

### GET /api/skill-effectiveness/overload
技能过载状态。通过SkillEffectivenessOptimizer获取当前技能系统的过载状态，包括活跃技能数、Token使用量和预算。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "isOverloaded": false,
  "activeSkillCount": 8,
  "maxActiveSkills": 12,
  "contextTokenUsage": 5000,
  "contextTokenBudget": 8000
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | SkillEffectivenessOptimizer是否可用 |
| isOverloaded | boolean | 是否处于过载状态（默认false） |
| activeSkillCount | number | 当前活跃技能数（`Number.isFinite`校验，默认0） |
| maxActiveSkills | number | 最大活跃技能数（`Number.isFinite`校验，默认12） |
| contextTokenUsage | number | 当前上下文Token使用量（`Number.isFinite`校验，默认0） |
| contextTokenBudget | number | 上下文Token预算（`Number.isFinite`校验，默认8000） |

**不可用状态响应**：
```json
{
  "available": false,
  "message": "SkillEffectivenessOptimizer not initialized"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| SkillEffectivenessOptimizer not initialized | 优化器模块未初始化 |
| SkillEffectivenessOptimizer missing getOverloadStatus method | 优化器缺少getOverloadStatus方法 |
| SkillEffectiveness overload check failed | 内部异常被try-catch捕获 |

### GET /api/rl/environments
RL环境列表。通过RL Training Pipeline获取所有可用的强化学习环境，最多返回200条。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "count": 3,
  "environments": [
    { "id": "env-001", "name": "code-quality", "type": "discrete", "description": "代码质量优化环境" },
    { "id": "env-002", "name": "skill-routing", "type": "continuous", "description": "技能路由优化环境" }
  ]
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | RL Training Pipeline是否可用 |
| count | number | 返回的环境数量 |
| environments | array | 环境列表（最多200条，过滤掉id为null的条目） |
| environments[].id | string | 环境ID（非null） |
| environments[].name | string | 环境名称（默认`unnamed`） |
| environments[].type | string\|null | 环境类型 |
| environments[].description | string\|null | 环境描述 |

**不可用状态响应**：
```json
{
  "available": false,
  "environments": [],
  "message": "RL Training Pipeline not initialized"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| RL Training Pipeline not initialized | RL训练管道未初始化 |
| RL Training Pipeline missing getEnvironments method | 训练管道缺少getEnvironments方法 |
| RL environments check failed | 内部异常被try-catch捕获 |

### GET /api/rl/runs/:runId
单个训练运行详情。通过RL Training Pipeline获取指定训练运行的详细信息，包括状态、环境和指标数据。

**路径参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| runId | string | 是 | 运行ID（格式：`^[a-zA-Z0-9_-]{1,64}$`） |

**可用状态响应**：
```json
{
  "available": true,
  "id": "run-001",
  "status": "completed",
  "environment": "code-quality",
  "startedAt": "2026-06-05T10:00:00.000Z",
  "completedAt": "2026-06-05T12:00:00.000Z",
  "bestReward": 0.95,
  "metrics": {
    "avgReward": 0.87,
    "episodes": 1000,
    "convergenceRate": 0.92
  }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | 运行详情是否可用 |
| id | string | 运行ID（默认使用传入的runId） |
| status | string\|null | 运行状态 |
| environment | string\|null | 关联的环境名称 |
| startedAt | string\|null | 开始时间 |
| completedAt | string\|null | 完成时间 |
| bestReward | number\|null | 最佳奖励值（`Number.isFinite`校验） |
| metrics | object | 训练指标数据（由getRunDetail返回的metrics字段） |

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | Invalid runId format | runId格式不合法（需匹配`^[a-zA-Z0-9_-]{1,64}$`） |

**不可用状态响应**：
```json
{
  "available": false,
  "message": "Run not found"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| Invalid run ID | runId为空或超过128字符 |
| RL Training Pipeline not initialized | RL训练管道未初始化 |
| RL Training Pipeline missing getRunDetail method | 训练管道缺少getRunDetail方法 |
| Run not found | 指定运行不存在或返回无效结果 |
| RL run detail check failed | 内部异常被try-catch捕获 |

### POST /api/harness/calibration/report
Harness校准报告。通过EvaluationCalibrator获取评估校准报告，包括样本量、校准误差和偏差方向。

**请求体参数**：无

**可用状态响应**：
```json
{
  "sampleSize": 150,
  "calibrationError": 0.03,
  "bias": "slightly-overconfident"
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| sampleSize | number | 校准样本数量（不可用时为0） |
| calibrationError | number | 校准误差（不可用时为0） |
| bias | string | 偏差方向（不可用时为`unknown`） |

> **注意**：当EvaluationCalibrator可用时，响应由`calibrator.getCalibrationReport()`返回，字段结构取决于校准器实现。上述示例为不可用时的默认响应。

**不可用状态响应**：
```json
{ "sampleSize": 0, "calibrationError": 0, "bias": "unknown" }
```

| 不可用条件 | 说明 |
|-----------|------|
| EvaluationCalibrator not available（`_rt('evaluationCalibrator')`返回null） | 评估校准器未初始化 |

**安全注意事项**：
- 需Bearer Token认证

### GET /api/themes
获取支持的主题列表。返回系统支持的所有UI主题及其元数据。

**请求参数**：无

**响应示例**：
```json
{
  "themes": [
    { "id": "dark", "label": "暗色", "description": "默认深色主题" },
    { "id": "light", "label": "亮色", "description": "浅色主题" },
    { "id": "ocean", "label": "海洋", "description": "深蓝绿色调主题" },
    { "id": "forest", "label": "森林", "description": "深绿色调主题" },
    { "id": "sunset", "label": "日落", "description": "暖琥珀玫瑰色调主题" }
  ],
  "default": "dark"
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| themes | array | 支持的主题列表 |
| themes[].id | string | 主题唯一标识 |
| themes[].label | string | 主题显示名称 |
| themes[].description | string | 主题描述 |
| default | string | 默认主题ID（固定为`dark`） |

---

## 十八、错误码参考

框架定义85个结构化错误码，分为9个错误类，每个错误码包含严重级别和HTTP状态映射。

### 错误类层次

| 错误类 | 父类 | 适用场景 |
|--------|------|---------|
| HarnessError | Error | 通用框架错误 |
| SessionError | HarnessError | 会话管理错误 |
| PermissionError | HarnessError | 权限执行错误 |
| TDDGateError | HarnessError | TDD门禁错误 |
| AgentError | HarnessError | Agent运行时错误 |
| DeepeningError | HarnessError | 深化推理错误 |
| CausalViolationError | HarnessError | 因果一致性错误 |
| PipelineError | HarnessError | 管道执行错误 |
| HookError | HarnessError | 钩子执行错误 |

### 错误码分类

#### 通用错误（GENERAL）

| 错误码 | 严重级别 | HTTP状态 | 说明 |
|--------|---------|---------|------|
| UNKNOWN | error | 500 | 未知错误 |
| INIT_FAILED | critical | 500 | 初始化失败 |
| CONFIG_INVALID | critical | 500 | 配置无效 |
| INVALID_INPUT | warn | 400 | 输入参数无效 |
| VALIDATION_ERROR | warn | 400 | 验证失败 |
| TIMEOUT | error | 504 | 操作超时 |
| SHUTDOWN | warn | 503 | 系统关闭中 |
| SHUTDOWN_IN_PROGRESS | warn | 503 | 关闭进行中 |
| RESOURCE_EXHAUSTED | error | 503 | 资源耗尽 |
| RESOURCE_NOT_FOUND | warn | 404 | 资源未找到 |
| INVALID_STATE | error | 409 | 状态无效 |
| CAPACITY_EXCEEDED | warn | 503 | 容量超限 |
| CONNECTION_FAILED | error | 502 | 连接失败 |
| SECURITY_VIOLATION | critical | 403 | 安全违规 |
| DEPENDENCY_CYCLE | error | 409 | 依赖循环 |
| STORAGE_ERROR | error | 500 | 存储错误 |

#### 会话错误（SESSION）

| 错误码 | 严重级别 | HTTP状态 | 说明 |
|--------|---------|---------|------|
| SESSION_NOT_FOUND | warn | 404 | 会话未找到 |
| SESSION_EXPIRED | warn | 410 | 会话已过期 |
| SESSION_PHASE_INVALID | warn | 409 | 会话阶段无效 |
| SESSION_BUDGET_EXCEEDED | warn | 429 | Token预算超限 |

#### 权限错误（PERMISSION）

| 错误码 | 严重级别 | HTTP状态 | 说明 |
|--------|---------|---------|------|
| PERMISSION_DENIED | error | 403 | 权限拒绝 |
| PERMISSION_SKILL_NOT_ALLOWED | warn | 403 | Skill执行权限不足 |
| PERMISSION_FILE_PROTECTED | error | 403 | 文件受保护 |
| PERMISSION_LOCK_CONFLICT | warn | 409 | 文件锁冲突 |
| LOCK_TIMEOUT | warn | 408 | 锁超时 |

#### TDD门禁错误（TDD_GATE）

| 错误码 | 严重级别 | HTTP状态 | 说明 |
|--------|---------|---------|------|
| TDD_VIOLATION | error | 409 | TDD违规 |
| TDD_NO_TEST | error | 409 | 缺少测试 |
| TDD_COVERAGE_LOW | warn | 409 | 覆盖率不足 |
| TDD_PHASE_INVALID | warn | 409 | TDD阶段无效 |
| EVIDENCE_INSUFFICIENT | warn | 422 | 证据不充分 |

#### Agent错误（AGENT）

| 错误码 | 严重级别 | HTTP状态 | 说明 |
|--------|---------|---------|------|
| AGENT_NOT_FOUND | warn | 404 | Agent未找到 |
| AGENT_UNHEALTHY | error | 503 | Agent不健康 |
| AGENT_TIMEOUT | error | 504 | Agent超时 |
| AGENT_CAPACITY_EXCEEDED | warn | 503 | Agent容量超限 |
| SKILL_NOT_FOUND | warn | 404 | Skill未找到 |
| SKILL_DEPENDENCY_MISSING | error | 424 | Skill依赖缺失 |
| COMMAND_NOT_FOUND | info | 404 | 命令未找到 |
| COMMAND_AMBIGUOUS | info | 409 | 命令歧义 |

#### 深化推理错误（DEEPENING）

| 错误码 | 严重级别 | HTTP状态 | 说明 |
|--------|---------|---------|------|
| DEEPENING_CIRCUIT_OPEN | warn | 503 | 熔断器开启 |
| DEEPENING_RATE_LIMITED | warn | 429 | 限流 |
| DEEPENING_CONVERGENCE_FAILED | warn | 422 | 收敛失败 |
| RETRY_EXHAUSTED | warn | 429 | 重试耗尽 |

#### 因果一致性错误（CAUSAL）

| 错误码 | 严重级别 | HTTP状态 | 说明 |
|--------|---------|---------|------|
| CAUSAL_VIOLATION | error | 409 | 因果违规 |
| CAUSAL_INPUT_MISSING | error | 424 | 因果输入缺失 |
| CAUSAL_INVARIANT_FAILED | error | 422 | 因果不变量失败 |
| CAUSAL_OUTPUT_INVALID | error | 422 | 因果输出无效 |

#### 管道错误（PIPELINE）

| 错误码 | 严重级别 | HTTP状态 | 说明 |
|--------|---------|---------|------|
| PIPELINE_TIMEOUT | error | 504 | 管道超时 |
| PIPELINE_BLOCKED | warn | 403 | 管道阻塞 |
| PIPELINE_EXECUTION_ERROR | error | 500 | 管道执行错误 |
| DATA_PIPELINE_ERROR | error | 500 | 数据管道错误 |

#### 钩子错误（HOOK）

| 错误码 | 严重级别 | HTTP状态 | 说明 |
|--------|---------|---------|------|
| HOOK_EXECUTION_ERROR | error | 500 | 钩子执行错误 |
| HOOK_BLOCKED | warn | 403 | 钩子阻塞 |

#### 基础设施错误（INFRASTRUCTURE）

| 错误码 | 严重级别 | HTTP状态 | 说明 |
|--------|---------|---------|------|
| PLUGIN_ERROR | error | 500 | 插件错误 |
| SNAPSHOT_ERROR | error | 500 | 快照错误 |
| SNAPSHOT_STORE_ERROR | error | 500 | 快照存储错误 |
| AUDIT_ERROR | error | 500 | 审计错误 |
| LOAD_BALANCER_ERROR | error | 500 | 负载均衡错误 |
| NOTIFIER_ERROR | error | 500 | 通知错误 |
| EVENT_BUS_ERROR | error | 500 | 事件总线错误 |
| STATE_MACHINE_ERROR | error | 409 | 状态机错误 |
| TASK_SCHEDULER_ERROR | error | 500 | 任务调度错误 |
| METRICS_ERROR | warn | 500 | 指标错误 |
| BACKPRESSURE_ERROR | warn | 503 | 背压错误 |
| PRIORITY_QUEUE_ERROR | error | 500 | 优先级队列错误 |
| MCP_ERROR | error | 502 | MCP协议错误 |
| DUPLICATE_STEP | warn | 409 | 重复步骤 |
| SPRINT_ALREADY_RUNNING | warn | 409 | Sprint已在运行 |
| MISSING_FIELDS | warn | 400 | 必填字段缺失 |
| CANCELLED | info | 499 | 操作已取消 |
| INVALID_EXECUTION_MODE | warn | 400 | 无效执行模式 |
| MODE_SWITCH_DISABLED | warn | 409 | 模式切换已禁用 |
| INVALID_CALLBACK | warn | 400 | 无效回调函数 |
| LIMIT_EXCEEDED | warn | 429 | 限制超限 |
| MISSING_PARAMETER | warn | 400 | 缺少必要参数 |
| DEEPENING_CIRCUIT_BREAKER_OPEN | warn | 503 | 深化熔断器开启（全局） |
| ACQUIRE_FAILED | error | 500 | 资源获取失败 |
| INVALID_PLUGIN | warn | 400 | 无效插件 |
| DUPLICATE_PLUGIN | warn | 409 | 重复插件 |
| PLUGIN_INIT_FAILED | error | 500 | 插件初始化失败 |
| INVALID_TOOL_TYPE | warn | 400 | 无效工具类型 |
| INIT_TIMEOUT | error | 504 | 初始化超时 |
| BUDGET_EXCEEDED | warn | 429 | 预算超限 |
| POOL_SHUTDOWN | warn | 503 | 连接池已关闭 |
| POOL_EXHAUSTED | error | 503 | 连接池耗尽 |
| FACTORY_ERROR | error | 500 | 工厂创建失败 |

### 可重试错误码

以下错误码标记为可重试，客户端可在指数退避后重新请求：

`AGENT_TIMEOUT`、`PIPELINE_TIMEOUT`、`TIMEOUT`、`DEEPENING_CIRCUIT_OPEN`、`DEEPENING_RATE_LIMITED`、`AGENT_CAPACITY_EXCEEDED`、`SHUTDOWN_IN_PROGRESS`

---

## 十九、媒体Provider API（v2.10.6融合OpenClaw 4.5）

> 媒体Provider API提供视频/音乐/图像生成的统一接口，基于MediaProviderRouter自动选择最优Provider，支持多种路由策略和故障转移。所有端点包含完整的防御性编码：null检查、typeof检查、try-catch异常保护。

### GET /api/media-providers/status

获取所有媒体Provider的状态信息，包括连接状态、路由策略和统计。

**请求参数**：无

**响应示例**：

```json
{
  "available": true,
  "providerCount": 3,
  "strategy": "cost-optimal",
  "totalRouted": 42,
  "fallbacks": 2,
  "providers": [
    {
      "name": "kling-video",
      "connected": true,
      "capabilities": {
        "modes": ["generate", "imageToVideo"],
        "maxDuration": 10,
        "maxResolution": "1080p",
        "provider": "kling-video"
      }
    },
    {
      "name": "suno-music",
      "connected": true,
      "capabilities": {
        "modes": ["generate"],
        "maxDuration": 30,
        "maxResolution": "",
        "provider": "suno-music"
      }
    }
  ]
}
```

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `available` | boolean | MediaProviderRouter是否已初始化 |
| `providerCount` | number | 已注册Provider数量 |
| `strategy` | string | 当前路由策略（cost-optimal/quality-optimal/speed-optimal/round-robin/failfast） |
| `totalRouted` | number | 累计路由请求数 |
| `fallbacks` | number | 累计故障转移次数 |
| `providers` | array | 各Provider状态列表 |
| `providers[].name` | string | Provider名称 |
| `providers[].connected` | boolean | 是否已连接 |
| `providers[].capabilities` | object | Provider能力描述 |

**不可用状态响应**：

```json
{
  "available": false,
  "message": "MediaProviderRouter not initialized"
}
```

| 不可用消息 | 说明 |
|-----------|------|
| MediaProviderRouter not initialized | 路由器未初始化 |
| MediaProviders status check failed | 内部异常被try-catch捕获 |

### GET /api/media-providers/list

获取已注册Provider列表，包含连接状态和能力摘要。

**请求参数**：无

**响应示例**：

```json
{
  "available": true,
  "providers": [
    {
      "name": "kling-video",
      "connected": true,
      "modes": ["generate", "imageToVideo"],
      "maxDuration": 10,
      "maxResolution": "1080p"
    },
    {
      "name": "suno-music",
      "connected": true,
      "modes": ["generate"],
      "maxDuration": 30,
      "maxResolution": ""
    }
  ]
}
```

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `available` | boolean | MediaProviderRouter是否可用 |
| `providers` | array | Provider列表 |
| `providers[].name` | string | Provider名称 |
| `providers[].connected` | boolean | 是否已连接 |
| `providers[].modes` | string[] | 支持的生成模式列表 |
| `providers[].maxDuration` | number | 最大生成时长（秒） |
| `providers[].maxResolution` | string | 最大分辨率 |

**不可用状态响应**：

```json
{
  "available": false,
  "providers": [],
  "message": "MediaProviderRouter not initialized"
}
```

### POST /api/media-providers/generate

生成媒体内容。通过MediaProviderRouter自动选择最优Provider执行生成请求。

**请求体参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 文本描述（非空字符串，长度受validateStringLength限制） |
| `mode` | string | 否 | 生成模式：`'generate'`（默认）/`'imageToVideo'`/`'videoToVideo'` |
| `options` | object | 否 | Provider特定选项（必须为对象类型） |

**请求体示例**：

```json
{
  "prompt": "一只猫在月光下跳舞",
  "mode": "generate",
  "options": { "duration": 5, "resolution": "720p" }
}
```

**响应示例**：

```json
{
  "taskId": "task-abc123",
  "status": "pending",
  "provider": "kling-video"
}
```

**错误响应**：

| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | prompt is required and must be a non-empty string | prompt参数缺失或为空 |
| 400 | prompt exceeds maximum length | prompt超过长度限制 |
| 503 | MediaProviderRouter not available | 路由器未初始化 |

**安全注意事项**：
- `prompt`参数经过字符串长度校验，防止超长输入
- `options`参数必须是对象类型，防止注入攻击
- 路由器自动故障转移（FAILFAST策略除外），主Provider失败时尝试备用Provider

### GET /api/media-providers/task/:taskId

查询媒体生成任务状态。遍历所有已注册Provider查找任务。

**路径参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 任务ID（格式：`^[a-zA-Z0-9_-]{1,128}$`） |

**响应示例**：

```json
{
  "available": true,
  "taskId": "task-abc123",
  "status": {
    "taskId": "task-abc123",
    "status": "completed",
    "result": {
      "url": "https://cdn.example.com/video/abc123.mp4",
      "duration": 5,
      "resolution": "720p"
    }
  },
  "provider": "kling-video"
}
```

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `available` | boolean | 查询是否成功 |
| `taskId` | string | 任务ID |
| `status` | object\|null | 任务状态详情（包含status/result/error字段） |
| `provider` | string | 执行任务的Provider名称 |

**任务未找到响应**：

```json
{
  "available": true,
  "taskId": "task-abc123",
  "status": null,
  "message": "Task not found in any provider"
}
```

**错误响应**：

| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | Invalid taskId format | taskId格式不合法 |

**安全注意事项**：
- `taskId`参数经过正则校验（`^[a-zA-Z0-9_-]{1,128}$`），防止路径遍历和注入
- 遍历Provider时单个Provider查询失败不阻断，继续检查下一个Provider

---

## 二十、搜索 API（v2.10.6融合Sirchnunk）

> 搜索API提供基于Sirchnunk自进化搜索引擎的知识检索能力，支持知识集群复用、IDF加权排名和反应精炼。所有端点包含完整的防御性编码：null检查、typeof检查、try-catch异常保护。

### GET /api/search/status

获取搜索引擎状态信息，包括Sirchnunk连接状态、集群统计和搜索统计。

**请求参数**：无

**响应示例**：

```json
{
  "available": true,
  "sirchnunkConnected": true,
  "clusterStats": {
    "totalClusters": 15,
    "totalMerges": 3,
    "totalReuses": 42,
    "byCategory": {
      "topic": 8,
      "person": 3,
      "project": 2,
      "decision": 1,
      "error_pattern": 1
    }
  },
  "searchStats": {
    "totalSearches": 128,
    "clusterReuseHits": 42,
    "totalRefineLoops": 7,
    "phaseStats": {
      "cluster_reuse": { "count": 128, "successes": 42 },
      "idf_ranking": { "count": 86, "successes": 86 },
      "cluster_build": { "count": 65, "successes": 65 },
      "reactive_refine": { "count": 7, "successes": 5 }
    }
  }
}
```

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `available` | boolean | 搜索引擎是否可用 |
| `sirchnunkConnected` | boolean | Sirchnunk MCP适配器是否已连接 |
| `clusterStats` | object | 知识集群统计 |
| `clusterStats.totalClusters` | number | 集群总数 |
| `clusterStats.totalMerges` | number | 集群合并次数 |
| `clusterStats.totalReuses` | number | 集群复用次数 |
| `clusterStats.byCategory` | object | 按分类统计集群数量 |
| `searchStats` | object | 搜索统计 |
| `searchStats.totalSearches` | number | 总搜索次数 |
| `searchStats.clusterReuseHits` | number | 集群复用命中次数 |
| `searchStats.totalRefineLoops` | number | 反应精炼总循环次数 |
| `searchStats.phaseStats` | object | 各阶段执行统计 |

**不可用状态响应**：

```json
{
  "available": false,
  "message": "Search engine not initialized"
}
```

### GET /api/search/clusters

获取知识集群列表，支持按分类过滤。

**查询参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `category` | string | 否 | 按分类过滤，枚举: `person`/`project`/`memory_type`/`topic`/`decision`/`error_pattern` |

**响应示例**：

```json
{
  "available": true,
  "clusters": [
    {
      "id": "kc-abc123",
      "name": "Agent协作模式",
      "category": "topic",
      "description": "Auto-generated from search: Agent协作模式",
      "evidenceCount": 5,
      "keywords": ["agent", "协作", "模式"],
      "confidence": 0.85,
      "accessCount": 12,
      "createdAt": "2026-06-05T10:00:00.000Z",
      "updatedAt": "2026-06-05T12:00:00.000Z"
    }
  ],
  "total": 15
}
```

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `available` | boolean | 搜索引擎是否可用 |
| `clusters` | array | 集群列表（不含evidence详情，仅含evidenceCount） |
| `clusters[].id` | string | 集群ID |
| `clusters[].name` | string | 集群名称 |
| `clusters[].category` | string | 集群分类 |
| `clusters[].evidenceCount` | number | 证据数量 |
| `clusters[].keywords` | string[] | 关键词列表 |
| `clusters[].confidence` | number | 置信度 |
| `clusters[].accessCount` | number | 访问次数 |
| `total` | number | 集群总数 |

**错误响应**：

| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | Invalid category | category参数不在枚举范围内 |

### GET /api/search/history

获取搜索历史记录。

**查询参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `limit` | number | 否 | 返回条数限制，范围1-100，默认20 |

**响应示例**：

```json
{
  "available": true,
  "history": [
    {
      "query": "Agent协作模式",
      "mode": "FAST",
      "confidence": 0.85,
      "tokensUsed": 1200,
      "timestamp": "2026-06-05T10:00:00.000Z"
    }
  ],
  "total": 45
}
```

**错误响应**：

| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | Invalid limit | limit参数超出1-100范围 |

### POST /api/search/query

执行搜索查询，支持三种搜索模式和多种选项。

**请求体参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索查询文本（非空字符串，最大500字符） |
| `mode` | string | 否 | 搜索模式：`'FILENAME_ONLY'`/`'FAST'`（默认）/`'DEEP'` |
| `paths` | string[] | 否 | 搜索路径列表（最多10项） |
| `topK` | number | 否 | 返回结果数，范围1-100，默认20 |
| `maxDepth` | number | 否 | 最大搜索深度，范围1-50，默认10 |
| `maxLoops` | number | 否 | 最大循环数，范围1-50，默认10 |
| `includePatterns` | string[] | 否 | 包含文件模式（最多10项） |
| `excludePatterns` | string[] | 否 | 排除文件模式（最多10项） |

**请求体示例**：

```json
{
  "query": "Agent协作模式最佳实践",
  "mode": "DEEP",
  "topK": 10,
  "maxDepth": 15,
  "includePatterns": ["*.md", "*.js"]
}
```

**响应示例**：

```json
{
  "answer": "Agent协作模式的最佳实践包括...",
  "source": "sirchnunk",
  "clusterId": "kc-abc123",
  "confidence": 0.92,
  "evidenceUnits": [
    {
      "content": "协作模式路由器支持6种模式...",
      "idfScore": 2.45,
      "confidence": 0.9
    }
  ],
  "phases": ["cluster_reuse", "idf_ranking", "cluster_build"],
  "refineLoops": 0
}
```

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `answer` | string | 搜索结果摘要 |
| `source` | string | 结果来源（`sirchnunk`/`cluster_reuse`/`cluster_fallback`） |
| `clusterId` | string\|null | 关联的知识集群ID |
| `confidence` | number | 结果置信度（0-1） |
| `evidenceUnits` | array | 证据单元列表（含idfScore排序） |
| `phases` | string[] | 执行的搜索阶段列表 |
| `refineLoops` | number | 反应精炼循环次数 |

**错误响应**：

| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | query is required and must be a non-empty string | query参数缺失或为空 |
| 400 | query exceeds maximum length | query超过500字符 |
| 400 | Invalid search mode | mode不在枚举范围内 |
| 400 | Invalid topK value | topK超出1-100范围 |
| 503 | Search engine not available | 搜索引擎未初始化 |

**安全注意事项**：
- `query`参数经过字符串长度校验，防止超长输入
- `mode`参数经过枚举白名单校验，防止注入
- `paths`/`includePatterns`/`excludePatterns`数组长度限制为10项
- 搜索结果中的evidence内容不包含文件系统路径细节

### GET /api/code-wiki/compile-status
获取CodeWiki知识库编译状态。通过CodeWikiOrchestrator查询当前编译流程的状态。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "status": "idle"
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | CodeWikiOrchestrator是否可用 |
| status | string | 编译状态，枚举值：`idle`/`scanning`/`parsing`/`indexing`/`generating`/`completed`/`failed`/`unavailable`/`error` |

**不可用状态响应**：
```json
{
  "available": false,
  "status": "unavailable"
}
```

| 不可用条件 | 说明 |
|-----------|------|
| CodeWikiOrchestrator not initialized（`_rt('codeWikiOrchestrator')`返回null） | 编排器未初始化 |
| CodeWikiOrchestrator missing getCompileStatus method | 编排器缺少getCompileStatus方法 |
| 内部异常 | try-catch捕获异常后返回`{ available: false, status: 'error' }` |

### GET /api/code-wiki/stale-docs
获取过时文档列表。通过CodeWikiOrchestrator查询DocFreshnessGuard检测到的过时文档。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "staleDocs": [
    { "path": "docs/modules/模块详解-Web子系统.md", "staleReason": "source changed after last doc update", "lastUpdated": "2026-05-01T00:00:00.000Z" }
  ]
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | CodeWikiOrchestrator是否可用 |
| staleDocs | array | 过时文档列表（由DocFreshnessGuard.getStaleDocs()返回） |

**不可用状态响应**：
```json
{
  "available": false,
  "staleDocs": []
}
```

| 不可用条件 | 说明 |
|-----------|------|
| CodeWikiOrchestrator not initialized（`_rt('codeWikiOrchestrator')`返回null） | 编排器未初始化 |
| CodeWikiOrchestrator missing getStaleDocs method | 编排器缺少getStaleDocs方法 |
| DocFreshnessGuard not attached | 文档新鲜度守卫未挂载（返回空数组） |
| 内部异常 | try-catch捕获异常后返回`{ available: false, staleDocs: [] }` |

### GET /api/code-wiki/freshness
获取文档新鲜度验证结果。通过CodeWikiOrchestrator调用DocFreshnessGuard验证文档是否与源码同步。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "valid": true,
  "newlyStale": 0,
  "totalStale": 0
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | CodeWikiOrchestrator是否可用 |
| valid | boolean | 文档是否全部新鲜（无过时文档） |
| newlyStale | number | 新增过时文档数量 |
| totalStale | number | 过时文档总数 |

**不可用状态响应**：
```json
{
  "available": false,
  "valid": false
}
```

| 不可用条件 | 说明 |
|-----------|------|
| CodeWikiOrchestrator not initialized（`_rt('codeWikiOrchestrator')`返回null） | 编排器未初始化 |
| CodeWikiOrchestrator missing validateFreshness method | 编排器缺少validateFreshness方法 |
| DocFreshnessGuard not attached | 文档新鲜度守卫未挂载（返回`{ valid: true, newlyStale: 0, totalStale: 0 }`） |
| 内部异常 | try-catch捕获异常后返回`{ available: false, valid: false }` |

### GET /api/code-wiki/chat-history
获取AI聊天历史记录。通过CodeWikiOrchestrator查询Code Wiki的AI对话历史。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "history": [
    { "role": "user", "content": "这个模块的职责是什么？", "timestamp": "2026-06-05T10:00:00.000Z" },
    { "role": "assistant", "content": "该模块负责...", "timestamp": "2026-06-05T10:00:01.000Z" }
  ]
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | CodeWikiOrchestrator是否可用 |
| history | array | AI聊天历史记录列表（默认最近20条，最多`_maxChatHistory`条） |

**不可用状态响应**：
```json
{
  "available": false,
  "history": []
}
```

| 不可用条件 | 说明 |
|-----------|------|
| CodeWikiOrchestrator not initialized（`_rt('codeWikiOrchestrator')`返回null） | 编排器未初始化 |
| CodeWikiOrchestrator missing getChatHistory method | 编排器缺少getChatHistory方法 |
| 内部异常 | try-catch捕获异常后返回`{ available: false, history: [] }` |

### GET /api/code-wiki/context-file
获取AI编码助手上下文文件内容。通过CodeWikiOrchestrator生成copilot-instructions风格的Markdown上下文文件。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "content": "# Project Context\n\n## Module: auth\n..."
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | CodeWikiOrchestrator是否可用 |
| content | string | Markdown格式的上下文文件内容 |

**不可用状态响应**：
```json
{
  "available": false,
  "content": ""
}
```

| 不可用条件 | 说明 |
|-----------|------|
| CodeWikiOrchestrator not initialized（`_rt('codeWikiOrchestrator')`返回null） | 编排器未初始化 |
| CodeWikiOrchestrator missing getContextFile method | 编排器缺少getContextFile方法 |
| 内部异常 | try-catch捕获异常后返回`{ available: false, content: '' }` |

### GET /api/code-wiki/architecture-diagram
获取项目架构图。通过CodeWikiOrchestrator生成Mermaid格式的架构图，展示模块依赖关系。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "format": "mermaid",
  "diagram": "graph TD\n  A[auth] --> B[core]\n  A --> C[utils]",
  "nodeCount": 12,
  "edgeCount": 18
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | CodeWikiOrchestrator是否可用 |
| format | string | 图表格式（默认`mermaid`） |
| diagram | string | 架构图内容（Mermaid语法） |
| nodeCount | number | 节点数量（文件/模块数） |
| edgeCount | number | 边数量（依赖关系数） |

**不可用状态响应**：
```json
{
  "available": false,
  "diagram": "",
  "nodeCount": 0,
  "edgeCount": 0
}
```

| 不可用条件 | 说明 |
|-----------|------|
| CodeWikiOrchestrator not initialized（`_rt('codeWikiOrchestrator')`返回null） | 编排器未初始化 |
| CodeWikiOrchestrator missing generateArchitectureDiagram method | 编排器缺少generateArchitectureDiagram方法 |
| 无图谱数据（未执行compile） | 返回`{ format: 'mermaid', diagram: '', nodeCount: 0, edgeCount: 0, error: 'No graph data available...' }` |
| 内部异常 | try-catch捕获异常后返回`{ available: false, diagram: '', nodeCount: 0, edgeCount: 0 }` |

### GET /api/delivery-acceleration/diagnosis
获取交付加速瓶颈诊断结果。通过DeliveryAccelerationOrchestrator执行6类瓶颈检测（审查吞吐、似对非对代码、理解债务、上下文漂移、架构不匹配、管道阻塞）。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "diagnosis": {
    "bottlenecks": [
      { "type": "review-throughput", "level": "high", "score": 0.72, "detail": "Review throughput imbalance detected" }
    ],
    "overallLevel": "high",
    "recommendations": [
      { "action": "switch-mode", "targetMode": "ai-write-test-fix", "reason": "Review bottleneck detected" }
    ],
    "diagnosisTimeMs": 45,
    "diagnosedAt": "2026-06-05T10:00:00.000Z"
  }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | DeliveryAccelerationOrchestrator是否可用 |
| diagnosis | object\|null | 诊断结果对象 |
| diagnosis.bottlenecks | array | 活跃瓶颈列表（level不为`none`的瓶颈） |
| diagnosis.bottlenecks[].type | string | 瓶颈类型：`review-throughput`/`almost-correct-code`/`understanding-debt`/`context-drift`/`architecture-mismatch`/`pipeline-blockage` |
| diagnosis.bottlenecks[].level | string | 瓶颈等级：`low`/`medium`/`high`/`critical` |
| diagnosis.bottlenecks[].score | number | 瓶颈评分（0-1） |
| diagnosis.bottlenecks[].detail | string | 瓶颈详情描述 |
| diagnosis.overallLevel | string | 总体瓶颈等级 |
| diagnosis.recommendations | array | 推荐策略列表 |
| diagnosis.diagnosisTimeMs | number | 诊断耗时（毫秒） |
| diagnosis.diagnosedAt | string | 诊断时间戳 |

**不可用状态响应**：
```json
{
  "available": false,
  "diagnosis": null
}
```

| 不可用条件 | 说明 |
|-----------|------|
| DeliveryAccelerationOrchestrator not initialized（`_rt('deliveryAccelerationOrchestrator')`返回null） | 编排器未初始化 |
| DeliveryAccelerationOrchestrator missing diagnoseBottlenecks method | 编排器缺少diagnoseBottlenecks方法 |
| 内部异常 | try-catch捕获异常后返回`{ available: false, diagnosis: null }` |

### GET /api/delivery-acceleration/overview
获取交付加速概览数据。通过DeliveryAccelerationOrchestrator汇总编码比率、AI加速比率、审查瓶颈评分、债务评分、漂移等级和信任等级。

**请求参数**：无

**可用状态响应**：
```json
{
  "available": true,
  "overview": {
    "codingRatio": 0.35,
    "aiAccelerationRatio": 0.6,
    "reviewBottleneckScore": 0.45,
    "debtScore": 12,
    "driftLevel": "low",
    "trustLevel": "high",
    "pipelineBottleneck": null
  }
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| available | boolean | DeliveryAccelerationOrchestrator是否可用 |
| overview | object | 交付概览数据 |
| overview.codingRatio | number | 编码比率（默认0.2） |
| overview.aiAccelerationRatio | number | AI加速比率（默认0） |
| overview.reviewBottleneckScore | number | 审查瓶颈评分（默认0） |
| overview.debtScore | number | 债务评分（默认0） |
| overview.driftLevel | string | 漂移等级：`none`/`low`/`medium`/`high` |
| overview.trustLevel | string | 信任等级：`low`/`medium`/`high`/`unknown` |
| overview.pipelineBottleneck | string\|null | 管道瓶颈主因（无瓶颈时为null） |

**不可用状态响应**：
```json
{
  "available": false,
  "overview": {}
}
```

| 不可用条件 | 说明 |
|-----------|------|
| DeliveryAccelerationOrchestrator not initialized（`_rt('deliveryAccelerationOrchestrator')`返回null） | 编排器未初始化 |
| DeliveryAccelerationOrchestrator missing getDeliveryOverview method | 编排器缺少getDeliveryOverview方法 |
| 内部异常 | try-catch捕获异常后返回`{ available: false, overview: {} }` |

### POST /api/delivery-acceleration/check-architecture-gate
检查架构先行门禁。在architecture-first模式下，验证是否已完成SDD合约的spec+design阶段，未完成则阻止进入编码阶段。

**请求体参数**：无

**响应示例（允许通过）**：
```json
{
  "allowed": true,
  "reason": "Architecture-first gate passed",
  "missingSpecs": [],
  "currentPhase": "development"
}
```

**响应示例（阻止通过）**：
```json
{
  "allowed": false,
  "reason": "Architecture specs not completed",
  "missingSpecs": ["SDD contract spec stage not completed (design stage required)"],
  "currentPhase": "development"
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| allowed | boolean | 是否允许通过门禁 |
| reason | string | 判定原因描述 |
| missingSpecs | string[] | 缺失的规格列表（允许通过时为空数组） |
| currentPhase | string\|null | 当前阶段（exploration/analysis/architecture/development等） |

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 503 | DeliveryAccelerationOrchestrator not available | 编排器模块不可用 |

**安全注意事项**：
- 需Bearer Token认证
- 架构先行门禁被阻止时触发`architecture-first-blocked`事件，可用于审计追踪

### POST /api/delivery-acceleration/switch-mode
切换工作流模式。将交付加速编排器的工作流模式切换到指定模式。

**请求体参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| mode | string | 是 | 目标工作流模式，枚举值：`STANDARD`/`ARCHITECTURE_FIRST`/`AI_WRITE_TEST_FIX`/`HUMAN_REVIEW_DECIDE` |

**请求体示例**：
```json
{ "mode": "AI_WRITE_TEST_FIX" }
```

**响应示例（切换成功）**：
```json
{
  "switched": true,
  "previousMode": "standard",
  "currentMode": "ai-write-test-fix"
}
```

**响应示例（切换失败）**：
```json
{
  "switched": false,
  "previousMode": "standard",
  "currentMode": "standard"
}
```

**响应字段**：
| 字段 | 类型 | 说明 |
|------|------|------|
| switched | boolean | 是否切换成功 |
| previousMode | string | 切换前的模式 |
| currentMode | string | 当前模式（切换失败时与previousMode相同） |

**错误响应**：
| HTTP状态 | 错误信息 | 说明 |
|---------|---------|------|
| 400 | mode is required | mode参数缺失或类型错误 |
| 400 | Invalid mode. Must be one of: STANDARD, ARCHITECTURE_FIRST, AI_WRITE_TEST_FIX, HUMAN_REVIEW_DECIDE | mode不在合法枚举范围内 |
| 503 | DeliveryAccelerationOrchestrator not available | 编排器模块不可用 |

**安全注意事项**：
- mode参数经过枚举白名单校验（`_VALID_WORKFLOW_MODES`），防止注入
- 模式切换触发`workflow-mode-changed`事件，可用于审计追踪
- 需Bearer Token认证

---

## 关联文档
- [架构分析-AIProject系统](../architecture/架构分析-AIProject系统.md)
- [功能说明-全部模块清单](../modules/功能说明-全部模块清单.md)
- [开发指南-代码贡献规范](../guidelines/开发指南-代码贡献规范.md)
