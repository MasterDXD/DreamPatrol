﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿# 模块详解 — Web 子系统

> 版本：2.73.4
> 源码路径：`src/web/`
> 核心模块：5（server / websocket-handler / static-file-server / compression / changelog-archive）
> Dashboard 子模块：routes / data-providers / middleware / constants / parsers / validators
> 前端文件：5（index.html / styles.css / app.js / sw.js / manifest.webmanifest）

---

# 第一部分：架构概览

## 1. 概述

Web 子系统位于 `src/web/`，是 Harness Engineering 多Agent框架的可视化控制面。它提供 HTTP API（210+ 端点）、WebSocket 实时推送、静态文件服务、HTTP 压缩、变更日志归档，以及一个完整的 PWA 前端 SPA。整个子系统基于 Node.js 原生 `http` 模块构建，零外部框架依赖。

### 核心职责

| 职责 | 模块 | 说明 |
|------|------|------|
| HTTP 服务器 | `server.js` | DashboardServer 类，请求路由、认证、缓存、安全头 |
| WebSocket 实时通信 | `websocket-handler.js` | RFC 6455 实现，心跳、认证、广播 |
| 静态文件服务 | `static-file-server.js` | ETag 缓存、Range 请求、CSP nonce 注入 |
| HTTP 压缩 | `compression.js` | brotli > gzip > deflate 优先级 |
| 变更日志归档 | `changelog-archive.js` | 不可变记录、SHA-256 完整性校验 |
| Dashboard 后端 | `dashboard/` | 路由、数据提供者、中间件、验证、常量 |
| 前端 SPA | `public/` | 原生 HTML5 + CSS3 + Vanilla JS，PWA 支持 |

## 2. 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        浏览器 / 客户端                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  SPA UI  │  │  SW 缓存 │  │ Manifest │  │ WebSocket客户端│  │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘  └───────┬───────┘  │
└────────┼─────────────┼─────────────┼────────────────┼──────────┘
         │ HTTP        │ 缓存        │ 静态           │ WS
┌────────┼─────────────┼─────────────┼────────────────┼──────────┐
│        ▼             ▼             ▼                ▼          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   DashboardServer                         │  │
│  │  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌─────────┐ │  │
│  │  │  HTTP   │  │Security  │  │   Rate    │  │  Cache  │ │  │
│  │  │ Handler │──│ Headers  │──│  Limiter  │──│  Layer  │ │  │
│  │  └────┬────┘  └──────────┘  └───────────┘  └────┬────┘ │  │
│  │       │                                         │      │  │
│  │  ┌────▼─────────────────────────────────────────▼────┐ │  │
│  │  │              Route Dispatcher                      │ │  │
│  │  │  /api/* ──→ API Routes (7 categories)             │ │  │
│  │  │  /*     ──→ StaticFileServer                      │ │  │
│  │  └────┬──────────────────────────────────────────────┘ │  │
│  │       │                                               │  │
│  │  ┌────▼──────────────────────────────────────────┐    │  │
│  │  │           Compression Module                   │    │  │
│  │  │  brotli > gzip > deflate (Accept-Encoding)     │    │  │
│  │  └───────────────────────────────────────────────┘    │  │
│  │                                                       │  │
│  │  ┌───────────────────────────────────────────────┐    │  │
│  │  │         WebSocketHandler                       │    │  │
│  │  │  RFC 6455 · 心跳 · 认证 · 广播 · 限流         │    │  │
│  │  └───────────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────┘  │
│                           │                                  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │              Dashboard Backend (dashboard/)              │  │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐ │  │
│  │  │  Routes  │  │Data Providers│  │   Middleware     │ │  │
│  │  │  (7 files)│  │  (10 files)  │  │ (2 files)       │ │  │
│  │  └──────────┘  └──────────────┘  └──────────────────┘ │  │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐ │  │
│  │  │Constants │  │   Utils      │  │   Validation     │ │  │
│  │  │ (2 files)│  │  (1 file)    │  │   (1 file)       │ │  │
│  │  └──────────┘  └──────────────┘  └──────────────────┘ │  │
│  └────────────────────────────────────────────────────────┘  │
│                           │                                  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │              Runtime Engine (src/runtime/)               │  │
│  │  EventBus · SessionManager · SkillRouter · AgentRuntime  │  │
│  │  CheckpointManager · TokenManager · MCPClient · ...      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## 3. 目录结构

```
src/web/
├── server.js                    # DashboardServer 核心HTTP服务器
├── websocket-handler.js         # WebSocket RFC 6455 处理器
├── static-file-server.js        # 静态文件服务（ETag/Range/CSP nonce）
├── compression.js               # HTTP 压缩（brotli/gzip/deflate）
├── changelog-archive.js         # 变更日志归档（不可变+完整性校验）
├── dashboard/
│   ├── routes/
│   │   ├── index.js             # 路由总入口，组合所有路由模块
│   │   ├── core-routes.js       # 核心路由（概览/Agent/Skill/会话/工作流）
│   │   ├── agent-routes.js      # Agent 路由（生命周期/监控/部署/审批）
│   │   ├── skill-routes.js      # Skill 路由（层级/改进/创建/策展/文档新鲜度）
│   │   ├── deepening-routes.js  # 深化推理路由（40+ 子模块统计）
│   │   ├── collaboration-routes.js  # 协作路由（模式/配对/链式/意图）
│   │   ├── storage-routes.js    # 存储路由（SQLite/记忆/思维/嵌入/MCP）
│   │   └── infrastructure-routes.js # 基础设施路由（命令/钩子/压缩/目标/设计）
│   ├── data-providers/
│   │   ├── index.js             # Mixin 主入口
│   │   ├── agent-data.js        # Agent Mixin
│   │   ├── core-data.js         # 核心数据函数
│   │   ├── design-data.js       # 设计系统 Mixin
│   │   ├── framework-data.js    # 框架状态 Mixin
│   │   ├── framework-modules.js # 框架模块注册表常量
│   │   ├── health-data.js       # 健康检查函数
│   │   ├── infra-data.js        # 基础设施 Mixin
│   │   ├── deepening-data.js    # 深化推理 Mixin
│   │   └── provider-helpers.js  # 共享工具函数
│   ├── middleware/
│   │   ├── security.js          # 安全中间件（认证/限流/CORS/安全头）
│   │   └── mcp-security.js      # MCP 安全中间件（命令白名单/SSRF防护）
│   ├── constants/
│   │   ├── index.js             # 常量定义（端口/限流/缓存/验证规则）
│   │   └── static-data.js       # 静态数据（架构/特性/全景元数据）
│   ├── utils.js                 # 工具函数（路径/错误/参数/深度验证）
│   ├── validation.js            # 请求验证（参数/知识库/Token记录）
│   └── changelog-parser.js      # 变更日志解析器
└── public/
    ├── index.html               # SPA 入口（CSP nonce 模板）
    ├── app.js                   # SPA 应用逻辑
    ├── styles.css               # SPA 样式
    ├── sw.js                    # Service Worker（离线缓存）
    ├── manifest.webmanifest     # PWA 清单
    ├── apple-touch-icon.png     # Apple 触摸图标
    ├── icon-192.png             # PWA 图标 192x192
    └── icon-512.png             # PWA 图标 512x512
```

## 4. 请求处理流程

### 4.1 HTTP 请求处理

```
HTTP Request
  │
  ├─→ 设置安全头（CSP/X-Frame-Options/HSTS）
  ├─→ 请求超时设置（30s）
  ├─→ URL 长度检查（≤2048）
  ├─→ OPTIONS → CORS 预检
  ├─→ 方法检查（仅 GET/HEAD/POST）
  ├─→ 速率限制检查
  │
  ├─→ /api/* 路径
  │     ├─→ GET/HEAD → _handleApi()
  │     │     ├─→ 认证检查（Bearer Token / Dev Bypass）
  │     │     ├─→ 静态路由匹配 → _staticRoutes[pathname]
  │     │     ├─→ 动态路由匹配 → _dynamicRouteMap[pathname]
  │     │     └─→ 404 Not Found
  │     └─→ POST → _handlePostApi()
  │           ├─→ 认证检查 + Origin 验证
  │           ├─→ Content-Type 检查（仅 application/json）
  │           ├─→ Body 大小限制（1MB）
  │           ├─→ JSON 解析 + 深度验证（≤10层）
  │           └─→ POST 路由匹配
  │
  └─→ 其他路径 → StaticFileServer.handleStatic()
```

### 4.2 运行时事件桥接

DashboardServer 通过 `_bridgeRuntimeEvents()` 将 EventBus 事件自动转发到 WebSocket 客户端：

- `_EVENT_STATE_KEY_MAP` — 40+ 事件到状态键的映射（如 `session:created` → `sessions`）
- `_DEEPENING_EVENT_RULES` — 15 条深化推理事件规则（后缀匹配）
- 缓存失效映射 — 特定事件触发对应缓存键清除

### 4.3 POST 路由构建

POST 路由按功能域分组构建：

| 构建方法 | 路由前缀 | 说明 |
|----------|----------|------|
| `_buildCoreSkillRoutes` | `/api/skill-improvement/*`, `/api/skill-creation/*`, `/api/user/*`, `/api/nudge/*` | 核心 Skill 操作 |
| `_buildMcpRoutes` | `/api/mcp/*` | MCP 协议连接与工具调用 |
| `_buildKnowledgeRoutes` | `/api/sqlite/knowledge` | 知识库 CRUD |
| `_buildMemoryRoutes` | `/api/memory/*` | 记忆添加/删除 |
| `_buildDocFreshnessRoutes` | `/api/doc-freshness/*` | 文档新鲜度验证 |
| `_buildAffinityRoutes` | `/api/affinity/*` | 亲和力学习记录/推荐 |
| `_buildGoalRoutes` | `/api/goal/*` | 目标创建/暂停/恢复/取消/进度 |
| `_buildApprovalRoutes` | `/api/approval/*` | 人工审批请求/批准/拒绝 |
| `_buildAutoVersionRoutes` | `/api/auto-version/record` | AI 修改版本记录 |
| `_buildTokenRoutes` | `/api/token/record` | Token 消耗记录 |

## 5. 核心模块架构概览

### 5.1 DashboardServer 内部状态

| 属性 | 说明 |
|------|------|
| `_cache` | API 响应缓存（Map，TTL 过期） |
| `_staticRoutes` | 静态 GET 路由表（由 `buildAllRoutes` 生成） |
| `_dynamicRouteMap` | 动态 GET 路由表（带查询参数处理） |
| `_postRoutes` | POST 路由表（懒加载构建） |
| `_rateLimitMap` | IP 速率限制记录 |
| `_sensitiveRateMap` | 敏感端点速率限制记录 |
| `_apiTokenHash` | API Token SHA-256 哈希 |
| `_ws` | WebSocketHandler 实例 |
| `_archive` | ChangelogArchive 实例 |
| `_fmCache` / `_fileCache` / `_dirCache` | LRU 缓存（Frontmatter/文件/目录） |
| `_runtime` | 运行时实例引用 |

### 5.2 WebSocketHandler 事件与帧处理

**事件：**

| 事件 | 参数 | 说明 |
|------|------|------|
| `connection` | client | 新客户端连接 |
| `message` | client, msg | 收到客户端消息 |
| `disconnect` | client, reason | 客户端断开 |

**帧处理：**

- 支持 opcode 0x01（文本）、0x08（关闭）、0x09（Ping）、0x0A（Pong）
- 强制客户端帧必须 masked（RFC 6455 要求）
- RSV 位非零时关闭连接（无扩展协商）
- 消息速率限制（30条/秒）

### 5.3 ChangelogArchive 记录格式与完整性

**记录格式：**

```javascript
{
  id: 'v_<timestamp>_<random>',
  version: '1.0.0',
  date: '2025-01-01',
  timestamp: '2025-01-01 12:00:00.000',
  changes: [...],
  summary: '...',
  category: '新增|变更|修复|移除',
  files: [...],
  agent: 'AI',
  hash: '<sha256-hex-32>',
  immutable: true
}
```

**完整性保护：**

- 每条记录计算 SHA-256 哈希（排序键后序列化）
- 读取时验证哈希（`crypto.timingSafeEqual`）
- 索引文件包含所有记录的聚合哈希
- `verifyIntegrity()` 返回 `indexValid` / `recordsValid` / `recordsTampered` / `recordsMissing`

---

# 第二部分：详细 API 与安全机制

## 6. DashboardServer — 核心 HTTP 服务器

**源码**：[server.js](../../src/web/server.js)

### 6.1 核心 API

#### 构造函数

```javascript
new DashboardServer(projectRoot, port, runtimeInstance)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `projectRoot` | `string` | 项目根目录（必填） |
| `port` | `number` | 监听端口，默认 3210，可通过 `HARNESS_DASHBOARD_PORT` 环境变量覆盖 |
| `runtimeInstance` | `object` | 运行时实例，提供各子模块引用 |

#### `start(callback)`

启动 HTTP 服务器。

- **参数**：`callback` (`Function`, 可选) — 启动完成回调
- **返回值**：`Promise<DashboardServer>`
- **流程**：重置旧服务器 → 创建 HTTP 服务器 → 设置连接追踪 → 设置 WebSocket 升级 → 设置关闭事件 → 启动监听

#### `stop()`

停止服务器。

- **返回值**：无
- **流程**：停止清理定时器 → 关闭 WebSocket → 停止运行时模块 → 断开连接 → 关闭 HTTP 服务器 → 清空缓存

#### `invalidateCache(key)`

使缓存失效。

- **参数**：`key` (`string`, 可选) — 缓存键，不传则清空全部缓存
- **返回值**：无

#### `isHealthy()`

健康检查。

- **返回值**：`boolean` — 服务器存在且锁/确认数量未超限

### 6.2 配置选项

| 配置项 | 默认值 | 环境变量 | 说明 |
|--------|--------|---------|------|
| 端口 | 3210 | `HARNESS_DASHBOARD_PORT` | 监听端口 |
| 主机 | localhost | `HARNESS_DASHBOARD_HOST` | 绑定地址 |
| 绑定地址 | localhost | `HARNESS_BIND_ADDRESS` | 实际绑定地址 |
| API Token | 无 | `HARNESS_API_TOKEN` | Bearer 认证令牌 |
| 开发模式 | — | `NODE_ENV=development` | 启用开发模式 |
| 开发绕过 | false | `HARNESS_ALLOW_DEV_BYPASS=true` | 开发环境认证绕过 |
| 允许来源 | 自动计算 | `HARNESS_DASHBOARD_ORIGIN` | CORS 允许的来源 |
| TLS | — | `HARNESS_TLS_CERT` | 启用 HTTPS 相关头 |

### 6.3 API 端点分类

**GET 端点（静态路由，由 `buildAllRoutes` 构建）**：

| 分类 | 路径前缀 | 说明 |
|------|---------|------|
| 核心 | `/api/overview`, `/api/agents`, `/api/skills`, `/api/sessions`, `/api/workflow` | 项目概览与核心数据 |
| 框架 | `/api/health`, `/api/liveness`, `/api/readiness`, `/api/framework/status` | 健康检查与框架状态 |
| 变更日志 | `/api/changelog`, `/api/changelog/search` | 版本变更记录 |
| 合规 | `/api/compliance`, `/api/deviations`, `/api/code-reviews` | 框架合规与偏差 |
| 设计 | `/api/design/audit`, `/api/design/presets`, `/api/design/generate-css` | 设计引擎 |
| Agent | `/api/agent-lifecycle`, `/api/agent-monitor/*`, `/api/agent-deployment/*` | Agent 生命周期与监控 |
| 深化推理 | `/api/deepening/*` | 深化推理管线 |
| 协作 | `/api/collaboration/*`, `/api/pair-chat/*`, `/api/chat-chain/*` | 协作模式 |
| 存储 | `/api/sqlite/*`, `/api/memory/*`, `/api/embedding/*` | 数据存储 |
| 基础设施 | `/api/mcp/*`, `/api/rag/*`, `/api/opencli/*` | MCP/RAG/OpenCLI |

**POST 端点（动态路由）**：

| 路径 | 说明 |
|------|------|
| `/api/skill-improvement/apply` | 应用技能改进补丁 |
| `/api/skill-improvement/reject` | 拒绝技能改进补丁 |
| `/api/skill-improvement/record` | 记录技能学习 |
| `/api/skill-creation/create` | 创建新技能 |
| `/api/goal/create` | 创建目标 |
| `/api/goal/pause` | 暂停目标 |
| `/api/goal/resume` | 恢复目标 |
| `/api/goal/cancel` | 取消目标 |
| `/api/goal/progress` | 查询目标进度 |
| `/api/approval/approve` | 批准审批请求 |
| `/api/approval/reject` | 拒绝审批请求 |
| `/api/mcp/connect` | 连接 MCP 服务器 |
| `/api/mcp/call-tool` | 调用 MCP 工具 |
| `/api/token/record` | 记录 Token 消耗 |
| `/api/auto-version/record` | 记录 AI 修改版本 |
| `/api/memory/add` | 添加记忆 |
| `/api/memory/remove` | 删除记忆 |
| `/api/sqlite/knowledge` | 知识库 CRUD |
| `/api/user/profile` | 用户偏好 |
| `/api/nudge/evaluate` | 记忆推动评估 |
| `/api/affinity/record` | 亲和力记录 |
| `/api/affinity/recommendations` | 亲和力推荐 |
| `/api/doc-freshness/verify` | 文档新鲜度验证 |
| `/api/doc-freshness/code-change` | 代码变更通知 |

### 6.4 安全机制

- **CSP Nonce**：每个请求生成唯一 nonce，注入到 `Content-Security-Policy` 头和 `index.html` 的 `<script>` / `<style>` 标签
- **速率限制**：全局 500 次/分钟/IP，敏感端点独立限制（如 `/api/mcp/connect` 10次/分钟）
- **认证**：Bearer Token 认证，SHA-256 哈希比较（hex 编码），`timingSafeEqual` 防时序攻击
- **HTTP Auth Token 长度限制**：Bearer Token 最大 1024 字符，超长 Token 直接拒绝认证
- **CORS**：仅允许配置的来源
- **请求超时**：30秒，超时返回 504，POST 请求超时后响应不再挂起（确保响应正确关闭）
- **请求体大小**：最大 1MB
- **POST Body Chunk 限制**：请求体分块读取时，最大允许 1024 个 chunk，超出则中止请求并返回 413，防止恶意分块耗尽内存
- **POST 异步事件防护**：`req.on('end')`回调改为同步入口+异步IIFE模式，确保async异常始终被`.catch()`捕获，防止`unhandledRejection`导致服务崩溃（v2.7.141修复）
- **URL 长度**：最大 2048 字符
- **JSON 深度**：最大 10 层

### 6.5 缓存实现

- **目录缓存 `_readDirCache`**：当主缓存不可用时，回退使用 LRUCache（而非无界 Map），确保目录缓存条目有上限，防止长时间运行后内存无限增长

### 6.6 使用示例

```javascript
const DashboardServer = require('./src/web/server');

const server = new DashboardServer('/path/to/project', 3210, runtimeInstance);

server.start().then(() => {
  console.log('控制台已启动');
}).catch(err => {
  console.error('启动失败:', err);
});

server.invalidateCache('sessions');
server.stop();
```

---

## 7. WebSocketHandler — WebSocket 实时通信

**源码**：[websocket-handler.js](../../src/web/websocket-handler.js)

### 7.1 核心 API

#### 构造函数

```javascript
new WebSocketHandler(options)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.allowedOrigins` | `string[]` | 允许的 Origin 列表 |
| `options.authToken` | `string` | 认证令牌（SHA-256 哈希存储） |

#### `handleUpgrade(req, socket, head)`

处理 WebSocket 升级请求。

- **流程**：检查关闭状态 → 验证 Sec-WebSocket-Key → 认证 → 客户端数限制 → Origin 验证 → 发送 101 响应 → 注册客户端

#### `broadcast(event, data)`

向所有活跃客户端广播消息。

- **参数**：
  - `event` (`string`) — 事件名
  - `data` (`any`) — 数据（将被 JSON 序列化）
- **消息格式**：`{ event, data, timestamp }`

#### `close()`

关闭所有连接。

#### `shutdown()`

优雅关闭，发送关闭帧后结束连接。

#### `isHealthy()`

- **返回值**：`boolean` — 客户端数 < `MAX_CLIENTS`(50)

### 7.2 配置选项

| 常量 | 值 | 说明 |
|------|-----|------|
| `WS_MAGIC_STRING` | `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` | RFC 6455 握手魔法字符串 |
| `HEARTBEAT_INTERVAL` | `DEFAULT_HEARTBEAT_INTERVAL_MS` | 心跳间隔 |
| `MAX_PAYLOAD_SIZE` | 1MB | 单帧最大载荷 |
| `MAX_FRAME_BUFFER_SIZE` | 1MB | 帧缓冲区最大尺寸 |
| `MAX_CLIENTS` | 50 | 最大客户端连接数 |
| `WS_MESSAGE_RATE_LIMIT` | 30 | 消息速率限制（次/秒） |

### 7.3 认证方式

- **Sec-WebSocket-Protocol**：`bearer-<token>` 子协议，通过 `split(',')` + `find()` 模式匹配解析（修复了简单 `replace` 导致的误匹配问题）
- **Authorization 头**：`Bearer <token>`
- **消息认证**：连接后发送 `{ type: 'auth', token: '...' }`
- **URL 查询参数**：不支持（安全原因拒绝）
- **Token 比较方式**：使用 hex 编码的 SHA-256 哈希进行 `timingSafeEqual` 比较（修复了 UTF-8 编码比较导致的时序安全问题）

**Token 长度限制**：`_authenticateUpgrade` 的 catch 分支强制执行 1024 字符的 Token 长度限制，超长 Token 直接拒绝认证，防止内存或解析问题。

### 7.4 帧处理安全

`_handleData` 在处理每个帧后会重新检查客户端是否仍然存在于客户端列表中。若客户端在帧处理期间已被移除（如因超时、主动断开或认证失败），则立即停止后续帧处理，避免对已移除客户端执行无效操作。

### 7.5 使用示例

```javascript
const WebSocketHandler = require('./src/web/websocket-handler');

const ws = new WebSocketHandler({
  allowedOrigins: ['http://localhost:3210'],
  authToken: 'my-secret-token',
});

ws.on('connection', (client) => {
  console.log('新客户端连接');
});

ws.on('message', (client, msg) => {
  console.log('收到消息:', msg);
});

ws.broadcast('data-update', { key: 'sessions', value: [] });
ws.shutdown();
```

---

## 8. StaticFileServer — 静态文件服务

**源码**：[static-file-server.js](../../src/web/static-file-server.js)

### 8.1 核心 API

#### `handleStatic(server, pathname, req, res)`

处理静态文件请求。

- **参数**：
  - `server` (`DashboardServer`) — 服务器实例
  - `pathname` (`string`) — URL 路径
  - `req` — HTTP 请求
  - `res` — HTTP 响应
- **安全检查**：空字节注入防护、反斜杠防护、路径遍历防护（`path.relative` + `..` 检测）、符号链接防护（`fs.realpathSync` 解析真实路径后重新验证是否仍在项目目录内，防止通过符号链接逃逸到项目外）。`_validatePathSafety` 仅阻止 `..` 路径遍历，不再误拦截包含 `/` 的合法路径
- **特殊处理**：`/` 路径映射到 `/index.html`，`index.html` 注入 CSP nonce

#### `serveIndexHtmlWithNonce(server, fullPath, nonce, contentType, req, res)`

服务 `index.html`，注入 CSP nonce 和 Token 可用标记。

- **CSP Nonce 注入**：替换 `{{CSP_NONCE}}` 占位符
- **Token 标记**：若 API Token 已配置，注入 `<meta name="harness-token-available" content="true">`

#### `checkConditionalCache(req, res, etag, stats)`

检查条件缓存头（If-None-Match / If-Modified-Since）。

- **返回值**：`boolean` — `true` 表示已发送 304 响应

#### `serveFileWithRange(req, res, fullPath, headers, stats)`

支持 Range 请求的文件服务。

- **Range 格式**：`bytes=start-end`、`bytes=-suffix`、`bytes=start-`
- **大小限制**：Range 请求最大支持 50MB，超出范围返回 416
- **多 Range**：不支持，退回完整文件
- **错误 Range**：返回 416

### 8.2 MIME 类型映射

| 扩展名 | MIME 类型 |
|--------|----------|
| `.html` | `text/html; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.js` | `application/javascript; charset=utf-8` |
| `.json` | `application/json; charset=utf-8` |
| `.png` | `image/png` |
| `.svg` | `image/svg+xml; charset=utf-8` |
| `.woff2` | `font/woff2` |
| `.webmanifest` | `application/manifest+json; charset=utf-8` |
| 其他 | `application/octet-stream` |

### 8.3 缓存策略

| 文件类型 | Cache-Control |
|---------|--------------|
| `.html`, `sw.js` | `max-age=0, no-cache` |
| 开发环境 | `no-cache, no-store, must-revalidate` |
| 不可变资源（字体/图片） | `public, max-age=31536000, immutable` |
| 其他 | `public, max-age=86400, stale-while-revalidate=60` |

---

## 9. Compression — HTTP 压缩

**源码**：[compression.js](../../src/web/compression.js)

### 9.1 核心 API

#### `compressResponse(req, res, body, headers, status, compressTimeoutMs)`

异步流式压缩 HTTP 响应。

- **参数**：
  - `req` — HTTP 请求（读取 `Accept-Encoding`）
  - `res` — HTTP 响应
  - `body` (`string`) — 响应体
  - `headers` (`object`) — 响应头（原地修改）
  - `status` (`number`) — HTTP 状态码
  - `compressTimeoutMs` (`number`, 默认 3000) — 压缩超时
- **压缩优先级**：`br` > `gzip` > `deflate` > 不压缩
- **阈值**：响应体 ≤ 512 字节时不压缩
- **安全机制**：超时回退为不压缩；压缩结果超过 2MB 回退

#### `compressBody(body, acceptEncoding)`

同步压缩，返回压缩结果。

- **参数**：
  - `body` (`Buffer | string`) — 待压缩数据
  - `acceptEncoding` (`string`) — Accept-Encoding 头
- **返回值**：`{ data: Buffer, encoding: string } | null`
- **阈值**：≤ 512 字节或 > 1MB 时返回 `null`

### 9.2 配置选项

| 常量 | 值 | 说明 |
|------|-----|------|
| `COMPRESSION_THRESHOLD_BYTES` | 512 | 压缩阈值（字节） |
| `MAX_COMPRESS_SIZE` | 1MB | 同步压缩最大尺寸 |

### 9.3 容错机制

- 压缩超时 → 降级发送未压缩响应
- 压缩错误 → 降级发送未压缩响应
- 已设置 `Content-Encoding` → 跳过压缩

---

## 10. ChangelogArchive — 变更日志归档

**源码**：[changelog-archive.js](../../src/web/changelog-archive.js)

### 10.1 核心 API

#### 构造函数

```javascript
new ChangelogArchive(projectRoot)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `projectRoot` | `string` | 项目根目录（必填），归档存储在 `.harness/archive/` |

#### `record(entry)`

记录变更日志条目。

- **参数**：`entry` (`object`)
  - `version` (`string`, 必填) — 语义化版本号（如 `1.0.0`）
  - `changes` (`array | object`, 必填) — 变更内容
  - `date` (`string`) — 日期
  - `summary` (`string`) — 摘要
  - `category` (`string`) — 分类：`新增` | `变更` | `修复` | `移除`
  - `files` (`string[]`) — 涉及文件
  - `agent` (`string`) — 执行 Agent
  - `phase` (`string`) — 所属阶段
  - `beforeSnapshot` / `afterSnapshot` — 前后快照
- **返回值**：`{ success: boolean, id?: string, hash?: string, error?: string }`
- **不可变性**：同一版本号不可重复记录

#### `getRecord(recordId)`

获取单条记录。

- **参数**：`recordId` (`string`) — 格式 `v_<timestamp>_<random>`
- **返回值**：记录对象 | `{ tampered: true }` | `null`

#### `verifyIntegrity()`

验证归档完整性。

- **返回值**：`{ indexValid: boolean, recordsValid: number, recordsTampered: number, recordsMissing: number, total: number, details: Array }`

#### `search(query)`

搜索归档记录。

- **参数**：`query` (`object`)
  - `keyword` (`string`) — 关键词搜索（匹配 summary、version、agent）
  - `category` (`string`) — 按分类过滤
  - `since` / `until` (`string`) — 日期范围
  - `agent` (`string`) — 按 Agent 过滤
  - `page` / `pageSize` — 分页
- **返回值**：`{ total, page, pageSize, totalPages, items }`

#### `getStats()`

获取统计信息。

- **返回值**：`{ total, byCategory, byAgent, byMonth }`

#### `isHealthy()`

- **返回值**：`boolean` — 归档目录和索引文件存在

### 10.2 使用示例

```javascript
const ChangelogArchive = require('./src/web/changelog-archive');

const archive = new ChangelogArchive('/path/to/project');

archive.record({
  version: '2.7.135',
  changes: [{ type: '新增', description: '新增XXX功能' }],
  summary: '新增XXX功能',
  category: '新增',
  agent: 'task-worker',
});

const result = archive.search({ keyword: '功能', page: 1, pageSize: 10 });
const integrity = archive.verifyIntegrity();
```

---

## 11. Dashboard 子模块

### 11.1 Routes — 路由定义

**源码**：[dashboard/routes/](../../src/web/dashboard/routes/)

路由模块按功能域拆分为 7 个子模块，由 `index.js` 统一聚合：

| 子模块 | 源码 | 覆盖端点 |
|--------|------|---------|
| `core-routes.js` | 核心路由 | `/api/overview`, `/api/agents`, `/api/skills`, `/api/sessions`, `/api/workflow`, `/api/changelog`, `/api/audit`, `/api/compliance`, `/api/config`, `/api/version` |
| `agent-routes.js` | Agent 路由 | `/api/agent-lifecycle/*`, `/api/agent-monitor/*`, `/api/agent-deployment/*`, `/api/agent-state/*`, `/api/agent-workflow/*`, `/api/agent-sandbox/*` |
| `deepening-routes.js` | 深化推理路由 | `/api/deepening/*`, `/api/quality/*`, `/api/token-budget/*`, `/api/affinity/*` |
| `skill-routes.js` | 技能路由 | `/api/skill-layer-stats`, `/api/skill-dedup-report`, `/api/skill-context-estimate`, `/api/skill-improvement/*`, `/api/skill-creation/*`, `/api/skill-curator/*` |
| `collaboration-routes.js` | 协作路由 | `/api/collaboration/*`, `/api/pair-chat/*`, `/api/chat-chain/*`, `/api/output-fusion/*`, `/api/channel/*`, `/api/intent/*` |
| `storage-routes.js` | 存储路由 | `/api/sqlite/*`, `/api/memory/*`, `/api/embedding/*`, `/api/mcp/*`, `/api/rag/*`, `/api/opencli/*` |
| `infrastructure-routes.js` | 基础设施路由 | `/api/health`, `/api/liveness`, `/api/readiness`, `/api/performance`, `/api/nudge/*`, `/api/doc-freshness/*`, `/api/user/*`, `/api/antipattern/*` |

**核心函数**：

```javascript
buildAllRoutes(server, CACHE_TTL) → Object<string, Function>
```

返回路径到处理函数的映射表，每个处理函数为 `async () => data`。

#### 核心路由端点详情（core-routes.js）

| 端点 | 缓存 TTL | 说明 |
|------|----------|------|
| `/api/overview` | 8s | 项目概览（版本/Agent数/Skill数/Token用量） |
| `/api/agents` | 15s | Agent 列表 |
| `/api/skills` | 15s | Skill 列表 |
| `/api/sessions` | 10s | 会话列表 |
| `/api/workflow` | 8s | 工作流状态 |
| `/api/config` | 30s | 项目配置（敏感字段脱敏） |
| `/api/changelog` | 60s | 变更日志 |
| `/api/audit` | 10s | 审计记录 |
| `/api/compliance` | 300s | 框架合规检查 |
| `/api/version` | 5s | 版本信息 |
| `/api/framework/status` | 30s | 框架综合状态 |
| `/api/framework/architecture` | 30s | 框架架构图 |
| `/api/framework/features` | 30s | 框架特性列表 |
| `/api/panorama/metadata` | 无 | 全景元数据 |
| `/api/performance` | 无 | 性能统计 |

#### Agent 路由端点详情（agent-routes.js）

| 端点 | 说明 |
|------|------|
| `/api/agent-lifecycle/list` | Agent 生命周期列表 |
| `/api/agent-runtime/stats` | Agent 运行时统计 |
| `/api/agent-runtime/resource-pool` | Agent 资源池 |
| `/api/agent-monitor/dashboard` | Agent 监控仪表盘 |
| `/api/agent-deployment/environments` | Agent 部署环境 |
| `/api/agent-state/list` | Agent 状态列表 |
| `/api/agent-workflow/stats` | Agent 工作流统计 |
| `/api/agent-sandbox/list` | Agent 沙箱列表 |
| `/api/agent-packs/list` | Agent 包列表 |
| `/api/agent-packs/installed` | 已安装 Agent 包 |
| `/api/agent-packs/stats` | Agent 包统计 |
| `/api/approval/pending` | 待审批列表 |
| `/api/approval/history` | 审批历史 |
| `/api/approval/stats` | 审批统计 |
| `/api/subagent/stats` | 子 Agent 统计 |
| `/api/subagent/active` | 活跃子 Agent |
| `/api/subagent/budget` | 子 Agent 预算报告 |
| `/api/subagent/model-stats` | 子 Agent 模型统计 |

#### Skill 路由端点详情（skill-routes.js）

| 端点 | 说明 |
|------|------|
| `/api/skill-layers/stats` | Skill 三层缓存统计 |
| `/api/skill-layers/dedup` | Skill 去重报告 |
| `/api/skill-layers/context` | Skill 上下文估算 |
| `/api/skill-improvement/pending` | 待应用改进补丁 |
| `/api/skill-improvement/stats` | Skill 改进统计 |
| `/api/skill-creation/list` | 自动创建的 Skill 列表 |
| `/api/skill-creation/stats` | Skill 创建统计 |
| `/api/skill-curator/stats` | Skill 策展统计 |
| `/api/nudge/stats` | 记忆推动统计 |
| `/api/doc-freshness/stats` | 文档新鲜度统计 |
| `/api/doc-freshness/stale` | 过时文档列表 |
| `/api/doc-freshness/index` | 文档索引 |
| `/api/doc-freshness/validate` | 文档新鲜度验证 |
| `/api/antipattern/rules` | 反模式规则列表 |

#### 深化推理路由端点详情（deepening-routes.js）

40+ 端点，覆盖深化推理管道的 21 个子模块。部分路由已标记为 deprecated 并指向 `/api/infrastructure/*` 替代：

| deprecated 路由 | 替代路由 |
|-----------------|----------|
| `/api/deepening/health-monitor` | `/api/infrastructure/health-checker` |
| `/api/deepening/priority-queue` | `/api/infrastructure/priority-queue` |
| `/api/deepening/event-bus` | `/api/infrastructure/event-bus` |

关键端点：`/api/deepening/stats`、`/api/deepening/quality`、`/api/deepening/token-budget`、`/api/deepening/pipeline`、`/api/deepening/convergence`、`/api/deepening/circuit-breaker`、`/api/deepening/cache`、`/api/deepening/report` 等。

#### 协作路由端点详情（collaboration-routes.js）

| 端点 | 说明 |
|------|------|
| `/api/collaboration/modes` | 协作模式列表（solo/pair/chain/ensemble/deepening） |
| `/api/collaboration/stats` | 协作统计 |
| `/api/collaboration/history` | 协作历史 |
| `/api/channel/stats` | Agent 通信通道统计 |
| `/api/pair-chat/stats` | 配对对话统计 |
| `/api/pair-chat/sessions` | 配对对话会话列表 |
| `/api/chat-chain/stats` | 链式对话统计 |
| `/api/chat-chain/chains` | 链式对话链列表 |
| `/api/output-fusion/stats` | 输出融合统计 |
| `/api/intent/stats` | 结构化意图统计 |
| `/api/intent/schemas` | 意图模式定义 |

#### 存储路由端点详情（storage-routes.js）

| 端点 | 说明 |
|------|------|
| `/api/sqlite/stats` | SQLite 存储统计 |
| `/api/sqlite/fts` | 全文搜索表列表 |
| `/api/memory/entries` | 记忆条目 |
| `/api/memory/usage` | 记忆使用量 |
| `/api/memory/verification` | 记忆验证统计 |
| `/api/memory/stale` | 过时记忆 |
| `/api/affinity/stats` | 亲和力学习统计 |
| `/api/affinity/records` | 亲和力记录 |
| `/api/thoughts/stats` | 思维链统计 |
| `/api/thoughts/list` | 思维链列表 |
| `/api/embedding/stats` | 嵌入服务统计 |
| `/api/thought-retriever/stats` | 思维检索统计 |
| `/api/model-selector/stats` | 模型选择器统计 |
| `/api/mcp/status` | MCP 服务器状态 |
| `/api/mcp/tools` | MCP 可用工具列表 |

#### 基础设施路由端点详情（infrastructure-routes.js）

| 端点 | 说明 |
|------|------|
| `/api/command-router/stats` | 命令路由统计 |
| `/api/command-router/commands` | 已发现命令列表 |
| `/api/programmable-hook/stats` | 钩子执行统计 |
| `/api/programmable-hook/hooks` | 已注册钩子列表 |
| `/api/programmable-hook/monitor` | 钩子监控数据 |
| `/api/programmable-hook/slow` | 慢钩子列表 |
| `/api/programmable-hook/success-rates` | 钩子成功率 |
| `/api/context-compression/stats` | 上下文压缩统计 |
| `/api/context-compression/strategies` | 压缩策略列表 |
| `/api/auto-version/stats` | 自动版本统计 |
| `/api/auto-version/recent` | 最近版本记录 |
| `/api/session/previous-context` | 上一会话上下文 |
| `/api/goal/list` | 目标列表 |
| `/api/goal/stats` | 目标统计 |
| `/api/generator-verifier/stats` | 生成器验证统计 |
| `/api/generator-verifier/history` | 验证历史 |
| `/api/isolated-context/stats` | 隔离上下文统计 |
| `/api/isolated-context/active` | 活跃隔离上下文 |
| `/api/plan/stats` | 计划统计 |
| `/api/plan/active` | 活跃计划 |
| `/api/user/profile` | 用户偏好 |
| `/api/design/stats` | 设计系统统计 |
| `/api/infrastructure/health-checker` | 健康检查器详情 |
| `/api/infrastructure/priority-queue` | 优先队列详情 |
| `/api/infrastructure/event-bus` | 事件总线统计 |

### 11.2 Data Providers — 数据提供者

**源码**：[dashboard/data-providers/](../../src/web/dashboard/data-providers/)

| 模块 | 说明 |
|------|------|
| `core-data.js` | 核心数据：`getOverview()`, `getAgents()`, `getSkills()`, `getSessions()`, `getWorkflow()` |
| `framework-data.js` | 框架数据：`getFrameworkStatus()` — 模块加载状态、依赖检查、资源扫描 |
| `agent-data.js` | Agent 数据：通过 `applyAgentMixin()` 混入到 DashboardServer |
| `deepening-data.js` | 深化推理数据：`DEEPENING_API_REGISTRY`, `getDeepeningStats()`, `getQualityStats()`, `getTokenBudgetStats()`, `getDeepeningDashboard()` |
| `design-data.js` | 设计数据：通过 `applyDesignMixin()` 混入 |
| `infra-data.js` | 基础设施数据：通过 `applyInfraMixin()` 混入 |
| `health-data.js` | 健康数据：`getHealth()`, `getLiveness()`, `getReadiness()`, `getPerformanceStats()` |
| `provider-helpers.js` | 辅助工具函数 |
| `index.js` | 统一入口，`applyDeepeningMixin()` 将所有数据提供者混入 DashboardServer |

**混入模式**：

数据提供者使用 Mixin 模式扩展 DashboardServer，通过 `applyDeepeningMixin(DashboardServer)` 将方法挂载到原型上，避免 server.js 过度膨胀。

### 11.3 Middleware — 中间件

**源码**：[dashboard/middleware/](../../src/web/dashboard/middleware/)

#### Security（安全中间件）

**源码**：[security.js](../../src/web/dashboard/middleware/security.js)

| 函数 | 说明 |
|------|------|
| `getClientIp(req, serverConfig)` | 获取客户端 IP，支持代理信任链 |
| `checkRateLimit(req, rateLimitMap, sensitiveRateMap, serverConfig)` | 速率限制检查，全局 500次/分 + 敏感端点独立限制 |
| `generateNonce()` | 生成 CSP nonce（16字节随机数） |
| `setSecurityHeaders(res, req, host, port, serverConfig, nonce)` | 设置安全响应头（CSP/X-Frame-Options/HSTS/Permissions-Policy 等） |
| `getCorsOrigin(req, allowedOriginsSet)` | CORS 来源检查 |
| `verifyGetAuth(req, apiToken, devMode, allowDevBypass, trustProxyActive)` | GET 请求认证 |
| `verifyPostAuth(req, apiToken, devMode, allowDevBypass, trustProxyActive)` | POST 请求认证 |
| `extractCallerId(req, serverConfig)` | 提取调用者标识 |
| `recordResponseTime(responseTimes, rtIdx, responseCount, startTime, status)` | 记录响应时间 |

**安全头设置：**

| 头 | 值 | 说明 |
|----|-----|------|
| `X-Content-Type-Options` | `nosniff` | MIME 嗅探防护 |
| `X-Frame-Options` | `DENY` | 点击劫持防护 |
| `X-XSS-Protection` | `0` | 禁用旧版 XSS 过滤器 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 引用策略 |
| `Permissions-Policy` | 多项禁用 | 权限策略 |
| `Content-Security-Policy` | 严格 CSP + nonce | 内容安全策略 |
| `Cross-Origin-Opener-Policy` | `same-origin` | 跨域打开策略 |
| `Cross-Origin-Resource-Policy` | `same-origin` | 跨域资源策略 |
| `Strict-Transport-Security` | HSTS（HTTPS 时） | 传输安全 |

**速率限制：**

- 全局限制：500 请求/分钟/IP
- 未知 IP 限制：50 请求/分钟
- 敏感端点独立限制（如 `/api/mcp/connect` 10次/分钟，`/api/token/record` 200次/分钟）
- Map 溢出保护：超过 50000 条目时淘汰 10% 最旧记录

#### McpSecurity（MCP 安全中间件）

**源码**：[mcp-security.js](../../src/web/dashboard/middleware/mcp-security.js)

| 函数 | 说明 |
|------|------|
| `validateMcpCommand(body)` | 验证 MCP 命令合法性，仅允许白名单命令（npx/node/python3/python/uvx/pip） |
| `validateMcpArgs(args)` | 验证 MCP 参数，检测危险模式（`-e`/`--eval`/`--exec`/`import`/`require` 等） |
| `validateMcpUrl(body)` | 验证 MCP URL，仅允许 http/https，阻止私有 IP 和保留地址（SSRF 防护） |
| `validateMcpHostname(hostname)` | 验证主机名，阻止私有 IP/IPv6/八进制/十六进制地址 |

**SSRF 防护：**

- 阻止私有/保留 IP 地址（10.x, 172.16-31.x, 192.168.x, 127.x, 0.x）
- 阻止 IPv6 私有地址
- 阻止八进制和十六进制 IP 表示
- 阻止已知危险主机名

### 11.4 Constants — 常量定义

**源码**：[dashboard/constants/](../../src/web/dashboard/constants/)

#### `index.js` — 运行时常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_DASHBOARD_PORT` | 3210 | 默认端口 |
| `DEFAULT_DASHBOARD_HOST` | `localhost` | 默认主机 |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | 10000 | 优雅关闭超时 |
| `MAX_HTTP_CONNECTIONS` | 500 | 最大 HTTP 连接数 |
| `RATE_LIMIT_WINDOW` | 60000 | 速率限制窗口 |
| `RATE_LIMIT_MAX` | 500 | 速率限制最大请求数 |
| `REQUEST_TIMEOUT_MS` | 30000 | 请求超时 |
| `MAX_POST_CONTENT_LENGTH` | 1048576 | POST 请求体最大长度 |
| `CACHE_TTL` | `{ config: 30s, agents: 15s, skills: 15s, sessions: 10s, changelog: 60s, overview: 8s, workflow: 8s, audit: 10s, compliance: 300s }` | 各类数据缓存 TTL |
| `SENSITIVE_RATE_LIMITS` | 端点级速率限制映射 | 敏感端点独立限制 |
| `MCP_ALLOWED_COMMANDS` | `['npx', 'node', 'python3', 'python', 'uvx', 'pip']` | MCP 允许的命令 |
| `MCP_DANGEROUS_ARG_PATTERNS` | 正则数组 | MCP 危险参数模式 |

#### `static-data.js` — 静态数据

包含 `ARCHITECTURE_DATA`（架构数据）、`FRAMEWORK_FEATURES_DATA`（框架特性数据）、`PANORAMA_METADATA`（全景元数据），用于框架架构和特性展示端点。

### 11.5 ChangelogParser — 变更日志解析器

**源码**：[dashboard/changelog-parser.js](../../src/web/dashboard/changelog-parser.js)

| 函数 | 说明 |
|------|------|
| `parseIterationMeta(body)` | 解析迭代元数据（轮次/时间/Token/负责人/审查人） |
| `parseChangelogItem(text)` | 解析变更日志条目（标题/模块/实现方式/业务价值） |
| `parseTokenBreakdown(val)` | 解析 Token 消耗明细 |
| `versionMatchesKeyword(v, keyword)` | 版本关键词匹配 |

### 11.6 Validation — 验证工具

**源码**：[dashboard/validation.js](../../src/web/dashboard/validation.js)

| 函数 | 说明 |
|------|------|
| `requireParam(params, name)` | 必需参数验证 |
| `optionalParam(params, name)` | 可选参数获取 |
| `parseIntParam(params, name, defaultValue)` | 整数参数解析 |
| `validateAgentId(agentId)` | Agent ID 格式验证 |
| `validateEnum(value, allowedSet, paramName)` | 枚举值验证 |
| `sanitizeStringField(value, maxLen, defaultVal)` | 字符串字段消毒 |
| `sanitizeStringArray(arr, maxItems, maxItemLen)` | 字符串数组消毒 |
| `sanitizeSearchParams(params)` | 搜索参数消毒 |
| `handleKnowledgeAdd(store, body)` | 知识库添加处理 |
| `handleKnowledgeUpdate(store, body)` | 知识库更新处理 |
| `handleKnowledgeRemove(store, body)` | 知识库删除处理 |
| `validateTokenRecordBody(body)` | Token 记录请求体验证 |

### 11.7 Utils — 工具函数

**源码**：[dashboard/utils.js](../../src/web/dashboard/utils.js)

| 函数 | 说明 |
|------|------|
| `_getPathname(req)` | 从请求 URL 提取路径 |
| `_apiError(message, status)` | 构造 API 错误响应 |
| `_wrapParams(obj)` | 包装参数对象为类 URLSearchParams 接口 |
| `_emptyParams()` | 空参数对象 |
| `_sendError(res, status, message, extraHeaders)` | 发送错误响应 |
| `_validateObjectDepth(obj, maxDepth)` | 验证对象嵌套深度 |

---

## 12. 前端文件

### 12.1 index.html — SPA 入口

**源码**：[public/index.html](../../src/web/public/index.html)

- **语言**：中文（`lang="zh-CN"`）
- **主题**：深色主题（`--bg: #020617`）
- **PWA 支持**：manifest 链接、apple-touch-icon、theme-color
- **CSP Nonce**：`<style nonce="{{CSP_NONCE}}">` 和 `<script nonce="{{CSP_NONCE}}">` 占位符
- **加载屏幕**：带粒子动画的加载界面，5秒超时后降级显示
- **无障碍**：`skip-link`、`aria-live`、`role` 属性、`prefers-reduced-motion` 媒体查询
- **内联 SVG 图标**：10+ 导航图标（panorama/architecture/workflow/agents/skills/sessions/changelog/compliance/audit/design/deepening/collaboration）

### 12.2 styles.css — 样式表

**源码**：[public/styles.css](../../src/web/public/styles.css)

- **设计系统**：基于 CSS 变量的深色主题
- **颜色体系**：
  - 背景：`--bg: #020617`（深蓝黑）
  - 表面：`--surface: rgba(15,23,42,.78)`（半透明）
  - 主色：`--primary: #818cf8`（靛蓝）
  - 语义色：success（绿）、warning（黄）、danger（红）
  - 辅助色：purple、cyan、rose、amber、emerald
- **网格背景**：多层径向渐变（mesh gradient）
- **毛玻璃效果**：`backdrop-filter: blur()`

### 12.3 app.js — 前端应用逻辑

**源码**：[public/app.js](../../src/web/public/app.js)

- **IIFE 封装**：`(function() { 'use strict'; ... })()`
- **核心常量**：
  - `CACHE_MAX_AGE_MS = 15000` — API 缓存有效期
  - `MAX_CACHE_ENTRIES = 200` — 最大缓存条目
  - `TOKEN_DANGER_THRESHOLD = 0.95` — Token 危险阈值
  - `TOKEN_WARNING_THRESHOLD = 0.8` — Token 警告阈值
  - `FETCH_TIMEOUT_MS = 5000` — 请求超时
  - `CONNECTION_RETRY_INTERVAL_MS = 5000` — WebSocket 重连间隔
  - `CONNECTION_MAX_RETRIES = 30` — 最大重连次数
- **功能模块**：
  - 全局错误处理（`error` / `unhandledrejection`）
  - Toast 通知系统（最多 5 条，4秒显示，250ms 退出动画）
  - API 缓存（LRU + TTL）
  - WebSocket 连接管理（自动重连 + 指数退避）
  - Token 预算监控（80% 警告 / 95% 危险）

### 12.4 sw.js — Service Worker

**源码**：[public/sw.js](../../src/web/public/sw.js)

- **缓存版本**：`harness-v2.72.0`
- **静态资源预缓存**：`/`, `/index.html`, `/styles.css`, `/app.js`, `/manifest.webmanifest`, 图标文件
- **API 缓存**：`harness-api-v2.73.0`，TTL 30秒，最大 100 条
- **策略**：
  - 静态资源：Cache First + 后台更新
  - API 请求：Network First + 缓存回退（离线时使用缓存）
  - 导航请求：离线时回退到 `/index.html`
- **消息处理**：`PURGE_API_CACHE`（清空 API 缓存）、`TRIM_CACHE`（修剪过期缓存）
- **缓存清理**：激活时删除旧版本缓存，定期修剪过期 API 缓存

### 12.5 manifest.webmanifest — PWA 清单

**源码**：[public/manifest.webmanifest](../../src/web/public/manifest.webmanifest)

| 字段 | 值 |
|------|-----|
| `name` | 多Agent框架控制台 |
| `short_name` | Harness |
| `display` | standalone |
| `background_color` | `#060a14` |
| `theme_color` | `#060a14` |
| `orientation` | any |
| `categories` | business, productivity, developer-tools |
| `icons` | 192x192 + 512x512（含 maskable） |
| `shortcuts` | 全景图谱、技能体系、角色管理 |

### 12.6 面板导航

前端 SPA 提供以下面板（通过 URL hash 路由）：

| 面板 | Hash | 说明 |
|------|------|------|
| 全景图谱 | `#panorama` | 框架全景可视化 |
| 架构视图 | `#architecture` | 运行时/权限/门禁模块架构 |
| 工作流 | `#workflow` | 六阶段流程进度 |
| Agent | `#agents` | Agent 角色管理 |
| Skill | `#skills` | 技能体系 |
| 会话 | `#sessions` | 会话列表 |
| 变更日志 | `#changelog` | 版本变更记录 |
| 合规 | `#compliance` | 框架合规检查 |
| 审计 | `#audit` | 审计日志 |
| 设计 | `#design` | 设计系统 |
| 深化推理 | `#deepening` | 深化推理模块 |
| 协作 | `#collaboration` | 协作模式 |

---

## 13. 模块关系图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DashboardServer (server.js)                  │
│  ┌──────────┐  ┌──────────────────┐  ┌────────────────────────┐   │
│  │  Routes   │  │  Data Providers  │  │     Middleware          │   │
│  │  (7子模块)│  │  (8子模块+Mixin) │  │  Security + McpSecurity │   │
│  └─────┬────┘  └────────┬─────────┘  └───────────┬────────────┘   │
│        │                │                        │                  │
│  ┌─────┴────────────────┴────────────────────────┴────────────┐   │
│  │                    Constants + Utils + Validation           │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌──────────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │ WebSocketHandler │  │  Compression │  │ StaticFileServer  │   │
│  │  (RFC 6455)      │  │ (br>gz>def)  │  │ (ETag/Range/CSP)  │   │
│  └──────────────────┘  └──────────────┘  └───────────────────┘   │
│                                                                    │
│  ┌──────────────────┐                                             │
│  │ ChangelogArchive │                                             │
│  │ (不可变归档)      │                                             │
│  └──────────────────┘                                             │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                     ┌─────┴──────┐
                     │  Frontend  │
                     │  (public/) │
                     ├────────────┤
                     │ index.html │
                     │ styles.css │
                     │  app.js    │
                     │   sw.js    │
                     │ manifest   │
                     └────────────┘
```

---

## 14. API 端点分类汇总

| 分类 | 路由文件 | GET 端点数 | POST 端点数 | 说明 |
|------|----------|-----------|------------|------|
| 核心 | core-routes | 20 | 0 | 概览/Agent/Skill/会话/工作流/配置/健康 |
| Agent | agent-routes | 18 | 0 | 生命周期/监控/部署/状态/审批/子Agent |
| Skill | skill-routes | 14 | 0 | 层级/改进/创建/策展/新鲜度/反模式 |
| 深化推理 | deepening-routes | 40+ | 0 | 21子模块统计+deprecated路由 |
| 协作 | collaboration-routes | 11 | 0 | 模式/配对/链式/融合/意图 |
| 存储 | storage-routes | 15 | 0 | SQLite/记忆/思维/嵌入/MCP |
| 基础设施 | infrastructure-routes | 25 | 0 | 命令/钩子/压缩/目标/设计 |
| 动态路由 | server.js (_dynamicRouteMap) | 30+ | 0 | 变更日志/检查点/学习/偏差/设计/RAG/OpenCLI |
| POST 操作 | server.js (_buildPostRoutes) | 0 | 25+ | Skill/MCP/知识库/记忆/目标/审批/版本/Token |

---

## 15. 配置选项

### 15.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HARNESS_DASHBOARD_PORT` | 3210 | 服务器端口 |
| `HARNESS_DASHBOARD_HOST` | localhost | 服务器主机 |
| `HARNESS_BIND_ADDRESS` | localhost | 绑定地址 |
| `HARNESS_API_TOKEN` | 无 | API 认证 Token（SHA-256 哈希存储） |
| `HARNESS_DASHBOARD_ORIGIN` | 无 | 额外允许的 CORS Origin |
| `HARNESS_ALLOW_DEV_BYPASS` | false | 开发模式认证绕过（仅 NODE_ENV=development） |
| `HARNESS_TLS_CERT` | 无 | TLS 证书路径（启用 HTTPS/WSS） |
| `NODE_ENV` | - | 运行环境（development/production） |

### 15.2 .harness/config.json 服务器配置

```json
{
  "trustProxy": true,
  "forceHttps": false,
  "proxyWhitelist": ["127.0.0.1", "::1"]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `trustProxy` | boolean/number | 信任代理（启用 X-Forwarded-For 解析） |
| `forceHttps` | boolean | 强制 HTTPS（HSTS + WSS） |
| `proxyWhitelist` | string[] | 代理 IP 白名单 |

---

## 16. 使用示例

### 启动服务器

```javascript
const DashboardServer = require('./src/web/server');

const server = new DashboardServer('/path/to/project', 3210);
server.start().then(() => {
  console.log('Dashboard running at http://localhost:3210');
});
```

### CLI 启动

```bash
node harness-cli.js dashboard
node harness-cli.js dashboard --port 8080
node harness-cli.js dashboard --open
```

### API 调用示例

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3210/api/overview
curl -H "Authorization: Bearer <token>" http://localhost:3210/api/agents
curl -H "Authorization: Bearer <token>" http://localhost:3210/api/health
curl http://localhost:3210/healthz
curl http://localhost:3210/readyz
```

### POST 请求示例

```bash
curl -X POST http://localhost:3210/api/token/record \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"sess-abc","tokens":1500,"inputTokens":800,"outputTokens":500,"toolCallTokens":200}'

curl -X POST http://localhost:3210/api/goal/create \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"objective":"实现用户认证模块","successCriteria":["通过所有单元测试"],"maxIterations":10}'
```

### WebSocket 连接

```javascript
const ws = new WebSocket('ws://localhost:3210/ws', ['bearer-<token>']);
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(msg.event, msg.data);
};
```

---

## 17. 安全设计

### 17.1 认证体系

- **API Token** — `HARNESS_API_TOKEN` 环境变量设置，SHA-256 哈希存储，`timingSafeEqual` 比较
- **Dev Bypass** — 开发模式下本地请求可绕过认证（需显式启用 `HARNESS_ALLOW_DEV_BYPASS`）
- **生产强制** — 生产环境无 Token 时 WebSocket 拒绝连接
- **非localhost绑定禁用** — 非localhost部署环境下开发模式绕过被自动禁用

### 17.2 输入验证

- URL 长度限制（≤2048）
- POST Body 大小限制（≤1MB）
- JSON 嵌套深度限制（≤10层）
- 对象键数量限制（≤1000）
- 参数长度限制（字符串≤256，Skill ID≤128）
- 路径遍历防护（NULL 字节、`..`、反斜杠检测）
- URL 编码膨胀检测（膨胀超过3倍拒绝）
- 双重编码检测（`%25`、`%26`、`%3C` 等特征模式）

### 17.3 速率限制

- 全局：500 请求/分钟/IP
- 敏感端点：独立限制（10-200 次/分钟）
- 未知 IP：10% 全局限制
- Map 溢出保护：自动淘汰最旧记录（LRU 式淘汰）

### 17.4 敏感信息防护

- `_sanitizeConfig` 敏感键过滤黑名单（覆盖 password/secret/token/key/private/db_url/mongo/redis/jwt/oauth/s3/aws/gcs/encryption/ssh_key 等模式）
- API Token 不暴露于 DOM（移除 meta 标签 Token 读取路径）
- WebSocket Token 哈希传输替代明文（`bearer-sha256:<hash>`）

---

## 18. 缺陷修复记录

### Round 5 安全修复记录

> 本轮修复涉及Web子系统中4项安全相关缺陷，涵盖路径安全检查误判、Token比较编码、POST超时响应挂起和Token长度限制。

#### _validatePathSafety — 路径安全检查误判修复

**缺陷**：`_validatePathSafety` 使用 `/[\\/]/` 正则检查路径安全性，该正则匹配任何包含正斜杠 `/` 或反斜杠 `\` 的路径。这导致合法的API路径（如 `/api/agents`、`/api/skills`）被误判为不安全路径而拒绝访问。

**修复**：移除 `/[\\/]/` 检查，仅保留三项关键安全检查：
1. `..` 路径遍历检测
2. 空字节（`\0`）注入检测
3. 绝对路径检测

**影响范围**：静态文件服务和API路由不再因路径包含 `/` 而误拒请求。

#### WebSocket Token比较编码修复

**缺陷**：WebSocket认证中的Token比较使用UTF-8编码进行SHA-256哈希比较。由于Token可能包含非ASCII字符，UTF-8编码与hex编码的哈希结果不一致，导致合法Token认证失败；同时UTF-8编码的 `timingSafeEqual` 比较存在时序攻击风险。

**修复**：Token哈希比较从UTF-8编码改为hex编码。SHA-256哈希结果统一以hex字符串形式存储和比较，确保编码一致性，同时 `timingSafeEqual` 在等长hex字符串上正确工作。

**影响范围**：WebSocket认证更可靠，Token比较更安全。

#### POST超时响应挂起修复

**缺陷**：POST请求超时处理中，当响应头已经发送（`res.headersSent === true`）时，仅调用 `res.end()` 尝试结束响应，但未销毁底层连接。这导致客户端连接挂起，等待响应直到连接超时。

**修复**：当响应头已发送时，在 `res.end()` 后追加 `res.destroy()` 调用，强制销毁底层TCP连接，确保客户端立即收到连接关闭信号。

**影响范围**：POST请求超时后客户端不再挂起等待，连接被正确关闭。

#### 安全中间件增强

**缺陷1**：HTTP认证中间件未对Bearer Token长度进行限制，超长Token可能导致内存或解析问题。

**修复1**：安全中间件新增1024字符的Token长度限制，超长Token直接拒绝认证，不进行哈希计算。

**缺陷2**：HTTP认证中的Token哈希比较与WebSocket存在相同的UTF-8编码问题。

**修复2**：HTTP认证Token比较统一使用hex编码进行 `timingSafeEqual` 比较，与WebSocket认证保持一致。

**影响范围**：认证流程更安全，超长Token不再消耗哈希计算资源；HTTP和WebSocket认证编码方式统一。

### Round 7 缺陷修复记录

> 本轮修复涉及Web子系统中6项健壮性修复，涵盖时序安全比较编码、帧缓冲区泄漏、压缩流状态处理、速率限制驱逐策略和模块状态缓存。

#### server.js — timingSafeEqual 改用 hex 编码

**缺陷**：HTTP认证中间件中 Bearer Token 的 SHA-256 哈希比较使用 UTF-8 编码进行 `timingSafeEqual` 比较。SHA-256 哈希输出为 hex 字符串，当 hex 字符串包含非 ASCII 兼容的字节序列时，UTF-8 编码可能导致比较长度不一致或结果不正确，同时存在时序攻击风险。

**修复**：将 Token 哈希比较统一改用 hex 编码。SHA-256 哈希结果以 hex 字符串形式存储，`timingSafeEqual` 在等长 hex 字符串上进行比较，确保编码一致性和时序安全性。

**影响范围**：HTTP认证 Token 比较更可靠，与 WebSocket 认证编码方式保持一致。

#### changelog-archive.js — timingSafeEqual 改用 hex 编码

**缺陷**：`ChangelogArchive` 的 `getRecord()` 方法在验证记录哈希时，使用 UTF-8 编码进行 `timingSafeEqual` 比较，与 server.js 存在相同的编码不一致问题。

**修复**：哈希比较改用 hex 编码，确保 SHA-256 哈希结果在等长 hex 字符串上进行 `timingSafeEqual` 比较。

**影响范围**：变更日志归档的完整性验证更可靠，时序安全性得到保证。

#### websocket-handler.js — 帧缓冲区超限断连时清理 frameBuffer

**缺陷**：`_handleData` 在帧缓冲区超过 `MAX_FRAME_BUFFER_SIZE`（1MB）时，会移除客户端并发送关闭帧，但未清理该客户端的 `frameBuffer`。由于客户端对象仍可能被事件循环引用，残留的 frameBuffer 会导致内存泄漏，特别是在频繁断连重连的场景下。

**修复**：在帧缓冲区超限断连逻辑中，移除客户端前先将其 `frameBuffer` 置为 `null`，释放缓冲区引用，确保 GC 可回收该内存。

**影响范围**：WebSocket 客户端因帧缓冲区超限断连时不再泄漏内存，长时间运行的服务器内存使用更稳定。

#### compression.js — 压缩流 destroyed 状态回退处理

**缺陷**：`compressResponse()` 在异步流式压缩过程中，若压缩流因错误或超时被销毁（`destroyed === true`），仍尝试从流中读取数据并写入响应，导致向已销毁的流写入数据抛出异常，或向已结束的响应写入数据导致 `ERR_STREAM_WRITE_AFTER_END` 错误。

**修复**：在压缩流的 `data` 和 `end` 事件回调中，增加 `destroyed` 状态检查。若压缩流已被销毁，立即回退为不压缩响应，直接发送原始数据，避免向已销毁的流或已结束的响应写入数据。

**影响范围**：压缩流在异常情况下优雅回退，不再因流状态不一致抛出未捕获异常。

#### security.js — 速率限制 Map 驱逐策略优化

**缺陷**：`checkRateLimit()` 使用普通 `Map` 存储每个 IP 的请求计数，当 Map 条目数超过上限时，直接清空整个 Map（`rateLimitMap.clear()`）。这种暴力驱逐策略会导致所有 IP 的计数器被重置，合法用户的速率限制窗口被意外清零，在流量高峰期可能被攻击者利用绕过速率限制。

**修复**：将驱逐策略从全量清空改为 LRU 式淘汰。当 Map 条目数超过上限时，仅淘汰最旧（最早访问）的条目，保留活跃 IP 的计数器。每个 IP 在访问时更新其在 Map 中的插入顺序，确保最近活跃的条目不会被误淘汰。

**影响范围**：速率限制在高并发场景下更公平，合法用户的计数器不再因 Map 满而被意外重置。

#### framework-data.js — 模块状态缓存 30 秒 TTL

**缺陷**：`getFrameworkStatus()` 的模块加载状态数据未设置缓存 TTL，导致每次请求都重新扫描模块目录和检查依赖状态。在频繁轮询的 Dashboard 前端场景下，重复的文件系统扫描造成不必要的 I/O 开销和 CPU 消耗。

**修复**：为 `getFrameworkStatus()` 的缓存条目设置 30 秒 TTL（与 `CACHE_TTL.config` 一致）。缓存过期后才重新扫描模块状态，30 秒内的重复请求直接返回缓存数据。

**影响范围**：Dashboard 框架状态 API 响应更快，文件系统 I/O 压力显著降低，数据时效性在 30 秒内可接受。

### Round 9 缺陷修复记录

> 本轮修复涉及Web子系统中3个模块的安全与健壮性缺陷，涵盖安全校验绕过、嵌套对象深度限制和认证绕过修复。

#### design-data.js — 安全校验绕过修复（URL编码膨胀、双重编码检测）

**缺陷**：设计数据模块的输入校验未考虑URL编码和双重编码攻击。攻击者可通过URL编码（如`%253Cscript%253E`双重编码`<script>`）绕过XSS过滤，同时URL编码膨胀可使短输入解码后远超长度限制，导致缓冲区溢出或DoS。

**修复**：新增URL编码膨胀检测——对输入先执行URL解码，比较解码前后长度比，膨胀超过3倍视为攻击并拒绝输入。新增双重编码检测——检测`%25`、`%26`、`%3C`等双重编码特征模式，发现双重编码直接拒绝输入，防止通过二次解码绕过安全过滤。

**影响范围**：设计数据输入不再受URL编码绕过攻击，双重编码注入和编码膨胀攻击被有效拦截。

#### validation.js — 嵌套对象深度限制与token子字段验证

**缺陷1**：`validateTokenRecordBody()` 等验证函数未限制嵌套对象的深度，恶意构造的深层嵌套JSON（如`{a:{a:{a:...}}}`数千层）可导致栈溢出或解析耗时过长（ReDoS/深度炸弹攻击）。

**修复1**：新增 `validateObjectDepth(obj, maxDepth)` 函数，最大深度限制为10层。在所有接受JSON body的验证函数中调用此检查，超过10层嵌套的对象直接拒绝，返回400错误。

**缺陷2**：`validateTokenRecordBody()` 未验证token记录请求体中的子字段（如`tokens`、`inputTokens`、`outputTokens`），传入非数值或负数时导致TokenManager统计失真。

**修复2**：新增token子字段验证——`tokens`、`inputTokens`、`outputTokens`、`toolCallTokens`必须为非负有限数值，非法值时返回400错误并提示具体字段名。

**影响范围**：API请求体嵌套深度受控，深度炸弹攻击被拦截；Token记录请求的数值字段始终有效，TokenManager统计不再受非法输入影响。

#### security.js — 空apiTokenHash dev bypass修复与空Bearer token拒绝

**缺陷1**：`verifyGetAuth()` 和 `verifyPostAuth()` 在开发模式（`devMode === true`）下，当 `apiTokenHash` 为空字符串时，`allowDevBypass` 逻辑允许无Token访问所有API端点。这意味着未配置API Token的系统在开发模式下完全开放认证，违反最小权限原则。

**修复1**：空 `apiTokenHash` 时，即使处于开发模式且 `allowDevBypass` 为true，也不允许dev bypass认证绕过。必须显式配置非空API Token后，开发模式的bypass才生效。

**缺陷2**：`verifyGetAuth()` 和 `verifyPostAuth()` 在提取Bearer Token时，未检查提取的Token是否为空字符串。请求头 `Authorization: Bearer ` （Token为空）可通过空字符串比较，若服务端Token哈希也为空则认证通过。

**修复2**：新增空Bearer Token拒绝逻辑，提取的Token为空字符串时直接返回401，不进行哈希比较。

**影响范围**：未配置API Token的系统在开发模式下不再默认开放认证；空Bearer Token请求被明确拒绝，消除认证绕过风险。

### Round 10 缺陷修复记录

> 本轮修复涉及Web子系统中3个文件的安全与数据一致性缺陷，涵盖缓存过期数据处理和Token传输安全。

#### sw.js — 缓存TTL过期返回503而非过期数据

**缺陷**：Service Worker的API缓存策略在缓存命中但TTL已过期时，仍返回过期的缓存数据给前端。离线场景下，过期数据可能导致前端展示过时的Agent状态、Token用量等信息，误导用户决策。

**修复**：缓存TTL过期时，不再返回过期数据，而是返回HTTP 503（Service Unavailable）响应，明确告知前端数据不可用。前端可据此显示"数据已过期"提示，而非展示可能不准确的过期信息。

**影响范围**：离线或网络中断场景下，前端不再展示过期的API数据，避免误导用户；503响应可被前端正确处理和提示。

#### app.js + websocket-handler.js — WebSocket token哈希传输替代明文

**缺陷**：前端 `app.js` 在建立WebSocket连接时，将API Token以明文形式通过 `Sec-WebSocket-Protocol` 头传输（`bearer-<token>`）。明文Token在HTTP请求头中可被中间人截获，存在凭据泄露风险。同时，WebSocket服务端 `websocket-handler.js` 直接比较明文Token，未使用哈希比较。

**修复**：前端 `app.js` 改为传输Token的SHA-256哈希值（`bearer-sha256:<hash>`），不再传输明文Token。WebSocket服务端 `websocket-handler.js` 相应调整认证逻辑，对收到的哈希值与服务端存储的哈希值进行 `timingSafeEqual` 比较，避免明文Token在网络传输中暴露。

**影响范围**：WebSocket连接建立时Token不再以明文形式传输，凭据泄露风险降低；服务端认证逻辑与哈希传输方式一致，安全性提升。

### Round 11 缺陷修复记录

> 本轮修复涉及Web子系统中1项回归修复，Round 7的timingSafeEqual修复不完整。

#### server.js — WebSocket路径timingSafeEqual hex编码（回归修复）

**缺陷**：Round 7修复了HTTP API路径和WebSocket `_validateWsAuth` 方法中 `timingSafeEqual` 的UTF-8编码问题，改为hex编码。但server.js中WebSocket认证路径的第二处 `timingSafeEqual` 比较仍使用UTF-8编码（`Buffer.from(tokenHash, UTF8_ENCODING)`），遗漏了该处修复。这导致WebSocket连接认证时hex哈希与UTF-8编码的Buffer比较，长度不一致时`timingSafeEqual`抛出异常，合法Token认证失败。

**修复**：将WebSocket认证路径的第二处 `Buffer.from(tokenHash, UTF8_ENCODING)` 改为 `Buffer.from(tokenHash, 'hex')`，与HTTP API路径和第一处WebSocket修复保持一致。

**影响范围**：WebSocket认证Token比较编码统一为hex，认证可靠性和时序安全性得到保障。

### Round 12 缺陷修复记录

> 本轮修复涉及Web子系统中8个模块的11项缺陷，涵盖常量一致性、数组数据破坏、深度验证差一错误、sideEffects误标、SSRF验证、重复定义、速率限制优先级、缓存淘汰和工作流数据过滤。

#### constants/index.js — EXPECTED_RUNTIME_MODULE_COUNT不一致修复

**缺陷**：`EXPECTED_RUNTIME_MODULE_COUNT` 在 `framework-modules.js` 中定义为30，但在 `dashboard/constants/index.js` 中定义为80。两处常量名完全相同但值差异巨大，导致框架完整性计算结果不一致。

**修复**：`dashboard/constants/index.js` 中的值从80改为30，与 `framework-modules.js`（权威来源）保持一致。

**影响范围**：框架健康度报告中的模块完整性计算结果一致且准确。

#### deepening-routes.js — _withDeprecation数组数据破坏性转换修复

**缺陷**：`_withDeprecation` 函数在处理数组类型的 `data` 时，`typeof data !== 'object'` 对数组返回false，数组不会被包装为`{ data }`。随后 `Object.assign({ _deprecated: true, ... }, arrayData)` 将数组的数字索引展开为对象属性，产生畸形结构，破坏前端解析。

**修复**：新增 `Array.isArray(data)` 检查，数组类型先包装为 `{ data }` 再合并废弃标记。

**影响范围**：废弃API的数组响应格式正确，前端可正常解析。

#### core-data.js — _validateObjectDepth差一错误修复

**缺陷**：`_validateObjectDepth(obj, maxDepth)` 使用 `maxDepth <= 0` 作为递归基线，当调用 `_validateObjectDepth(s, 10)` 时，最大实际允许嵌套深度为9而非声明的10。与 `validation.js` 和 `utils.js` 中同名函数的实现不一致。

**修复**：改用 `currentDepth` 参数模式，与 `validation.js` 实现一致：`if (currentDepth > maxDepth) return false`。

**影响范围**：对象深度验证允许的实际深度与声明一致（10层），合法的10层嵌套会话数据不再被静默丢弃。

#### package.json — sideEffects误标修复

**缺陷**：`package.json` 声明 `"sideEffects": false`，但 `src/index.js` 注册了全局错误处理器，`i18n` 和 `debug-logger` 修改模块级状态。打包工具依赖 `sideEffects: false` 进行tree-shaking时，可能错误移除这些关键副作用代码。

**修复**：`sideEffects` 改为显式数组，标记有副作用的文件：`["src/index.js", "src/utils/i18n.js", "src/utils/debug-logger.js", "src/runtime/infrastructure/event-registrar.js"]`。

**影响范围**：打包工具的tree-shaking不再移除关键副作用代码，全局错误处理器等机制在打包后仍正常工作。

#### mcp-security.js — IPv4映射IPv6地址八位组验证修复

**缺陷1**：`validateMcpHostname` 对 `::ffff:x.x.x.x` 格式的IPv4映射IPv6地址只验证前两个八位组，未验证第三、四八位组是否在0-255范围内，恶意构造的 `::ffff:999.999.999.999` 格式可能绕过检查。

**修复1**：新增所有四个八位组的0-255范围验证，非法八位组值返回400错误。

**缺陷2**：第122行无条件调用 `isPrivateIPv6(ipv6)`，对非IPv6格式的主机名（如普通域名）执行冗余检查。

**修复2**：`isPrivateIPv6` 调用前增加IPv6格式正则守卫，仅对IPv6格式地址执行检查。

**影响范围**：IPv4映射IPv6地址的所有八位组均被验证；非IPv6主机名不再执行冗余的IPv6检查。

#### design-data.js — 重复常量定义消除

**缺陷**：`VALID_DESIGN_TYPES`、`VALID_DESIGN_COMPANIES`、`VALID_DESIGN_VARIANCES` 在 `design-data.js` 和 `constants/index.js` 中各定义了一份，两处独立维护容易不同步。

**修复**：`design-data.js` 中删除本地重复定义，改为从 `../constants` 导入。

**影响范围**：设计相关常量定义统一为单一来源，消除不同步风险。

#### utils.js — _validateObjectDepth falsy检查修复

**缺陷**：`_validateObjectDepth` 使用 `if (!currentDepth) currentDepth = 0` 设置默认值，`currentDepth` 为0时 `!0` 为true，虽结果正确但逻辑冗余。更严重的是，`NaN`、`null`、`""` 等意外值也被静默替换为0而非报错。

**修复**：改为精确的 `if (currentDepth === undefined) currentDepth = 0`。

**影响范围**：深度参数默认值设置更精确，与 `validation.js` 实现一致。

#### security.js — checkRateLimit isLocal优先级修复

**缺陷**：`checkRateLimit` 中 `effectiveMax` 的计算逻辑为 `isUnknownIp ? 50 : (isLocal ? 2500 : 500)`，当IP为"unknown"时，即使请求实际来自本地，也被限流为50次/分钟而非2500次/分钟。

**修复**：调整优先级为 `isLocal ? 2500 : (isUnknownIp ? 50 : 500)`，本地请求优先获得放宽限流。

**影响范围**：代理配置错误场景下本地开发者的请求不再被错误限流。

#### server.js — _getCached缓存淘汰计算中条目保护修复

**缺陷**：`_getCached` 在缓存超过上限时的第二轮淘汰不检查 `_computing` 标记，可能删除正在被其他并发请求等待的计算Promise，导致后续请求无法获取计算结果。

**修复**：第二轮淘汰也跳过 `_computing` 条目，仅删除非计算中的条目。

**影响范围**：并发请求场景下缓存计算结果不再被意外删除。

#### core-data.js — getWorkflow completedSkills按阶段过滤修复

**缺陷**：`getWorkflow` 将整个会话的 `completedSkillsList` 赋值给所有已完成阶段的 `phase.completedSkills`，导致每个阶段都显示相同的已完成技能列表，而非仅显示该阶段内完成的技能。

**修复**：按阶段技能ID过滤已完成技能，仅将属于当前阶段的已完成技能分配给该阶段。

**影响范围**：前端工作流视图中每个阶段仅显示该阶段内完成的技能，展示更准确。

#### config.json — fallback_chain冗余default_model移除

**缺陷**：`model_selector_config.fallback_chain` 的第一个条目为 `gpt-4o`，与 `default_model` 相同，降级链的第一个条目是冗余的。

**修复**：从 `fallback_chain` 中移除冗余的 `gpt-4o`，降级链仅包含降级模型。

**影响范围**：模型降级链更简洁，无冗余条目。

### Round 13 缺陷修复记录

> 本轮修复涉及TUI子系统的REPLEngine安全emit模式和框架入口模块分组问题。

#### REPLEngine — 直接emit('error')可能导致进程崩溃

**缺陷**：`REPLEngine`在两处直接调用`this.emit('error', {...})`发射普通对象。在Node.js中，如果EventEmitter的'error'事件没有监听器，会将错误参数抛出为未捕获异常，导致进程崩溃。

**修复**：使用`listenerCount('error')`守卫模式——当有error监听器时正常emit，否则降级为'safe-error'事件，避免进程崩溃。

**影响范围**：REPLEngine在无error监听器场景下不再导致进程崩溃，安全降级为safe-error事件。

#### src/index.js — MODULE_GROUPS重复归属与缺失模块修复

**缺陷1**：`ConcurrencyController`、`PriorityQueue`、`PlatformCoordinator`、`MCPClient`、`SignalPersistence`、`AutoVersionTracker`、`SqliteStore`同时出现在`runtime`和`infrastructure`两个MODULE_GROUPS中；`CollaborationModeRouter`、`PairChat`、`ChatChain`同时出现在`runtime`和`collaboration`中。违反分组互斥原则。

**修复1**：从`runtime`组中移除重复模块，仅保留在语义正确的组中。基础设施模块仅在`infrastructure`组，协作模块仅在`collaboration`组。

**缺陷2**：17+个已导出模块未出现在任何MODULE_GROUPS中，包括`SelfReflection`、`AgentDebugLoop`、`LayerBoundaryGuard`、`ArchitectureBoundaryEnforcer`、`CodeDriftDetector`、`KarpathyEnhancer`、`DesignTokens`、`SharedRuleHelpers`、`ERROR_SEVERITY`、`HTTP_STATUS_MAP`、`safeParse`、`debug`等。导致通过`harness.gate.LayerBoundaryGuard`等命名空间路径无法访问。

**修复2**：将所有缺失模块添加到对应的MODULE_GROUPS条目中。新增4个import（`KarpathyEnhancer`、`DesignTokens`、`SharedRuleHelpers`、`ERROR_SEVERITY`/`HTTP_STATUS_MAP`）并加入staticExports。

**影响范围**：所有导出模块均可通过命名空间路径访问；模块分组不再有重复归属。

#### HarnessError — 无效code在开发环境抛出TypeError

**缺陷**：`HarnessError`构造函数对无效`code`参数静默降级为`'UNKNOWN'`，掩盖调用方的编程错误（如拼写错误的错误码），使调试困难。

**修复**：在非生产环境（`NODE_ENV !== 'production'`）下，对无效code抛出`TypeError`；生产环境保留降级行为。

**影响范围**：开发环境下无效错误码被立即发现，生产环境行为不变。

### Round 14 缺陷修复记录

> 本轮修复涉及Dashboard路由、验证器、前端SPA、静态文件服务、压缩模块、WebSocket处理器和错误子系统的17项缺陷。

#### agent-routes.js — _approvalGate空值防护

**缺陷**：`/api/approval/pending`、`/api/approval/history`、`/api/approval/stats`三个端点直接访问`server._approvalGate`的方法，无空值检查。如果`_approvalGate`未初始化，抛出`TypeError`导致500错误。

**修复**：添加`if (!server._approvalGate)`空值检查，返回安全默认值（空数组、0、空对象）。

**影响范围**：审批相关API在`_approvalGate`未初始化时优雅降级，不再崩溃。

#### infrastructure-routes.js — 错误返回格式统一

**缺陷**：`/api/goal/list`和`/api/goal/stats`在GoalExecutor不可用时返回`{ available: false, error: '...' }`，缺少`_status`和`_data`标记，与server.js路由分发逻辑的错误格式约定不一致。

**修复**：改为`{ _status: 503, _data: { error: '...', available: false } }`，与其他路由的错误格式统一。

**影响范围**：GoalExecutor不可用时的API响应格式与框架错误处理管道一致。

#### validation.js — 知识库字段验证与参数范围限制

**缺陷1**：`handleKnowledgeAdd`白名单过滤后仅验证`content`字段，`title`、`source`、`tags`、`confidence`等字段无类型/长度验证，可被注入超长字符串或非法类型值。

**修复1**：新增`_validateKnowledgeFields()`辅助函数，对所有白名单字段添加类型和长度验证（title/source最大200字符，tags最大50项，confidence为0-1的数值）。

**缺陷2**：`parseIntParam`未限制参数范围，`pageSize`可传入极大值导致大量数据查询。

**修复2**：`pageSize`上限100（`Math.min(..., 100)`），`page`下限1（`Math.max(..., 1)`）。

**影响范围**：知识库API输入验证更严格，参数范围受控，防止资源滥用。

#### app.js — 移除meta标签Token读取与实体解码安全改进

**缺陷1**：`CONFIG.API_TOKEN`从`<meta name="harness-api-token">`读取Token，任何第三方脚本或浏览器扩展均可通过DOM读取，存在凭据泄露风险。

**修复1**：移除meta标签Token读取路径，Token仅通过安全JavaScript变量注入获取。

**缺陷2**：`sanitizeRawHtml`使用`textarea.innerHTML`解码HTML实体，可能触发浏览器HTML解析，存在二次注入风险。

**修复2**：替换为纯字符串替换方式解码HTML实体（十六进制/十进制数字引用+命名实体），避免DOM操作。

**影响范围**：API Token不再暴露于DOM；HTML实体解码不再依赖浏览器DOM解析，安全性提升。

#### static-file-server.js — realpath缓存与nonce空值防护

**缺陷1**：`fs.realpathSync`在每次请求时同步调用，高并发场景下阻塞事件循环。

**修复1**：新增`_realpathCache`（Map，最大100条目），缓存realpath结果，避免重复同步I/O。

**缺陷2**：`serveIndexHtmlWithNonce`在nonce为空时，CSP nonce属性变为`nonce=""`，可能导致功能失效或CSP绕过。

**修复2**：nonce为空时返回HTTP 503（"Security initialization failed"），不提供不安全的页面。

**影响范围**：静态文件服务高并发性能提升；CSP nonce空值场景不再导致安全降级。

#### compression.js — 压缩超时回退后清理事件监听器

**缺陷**：压缩超时回退后，`compressStream.destroy()`被调用但事件监听器未清理，高并发下可能导致内存压力。

**修复**：超时回退后添加`compressStream.removeAllListeners()`清理事件监听器。

**影响范围**：压缩超时场景不再残留事件监听器，内存使用更干净。

#### websocket-handler.js — 大帧处理统一使用_closeClient

**缺陷**：大数据帧处理手动构建关闭帧并直接操作，绕过`_closeClient`的统一逻辑，不触发`disconnect`事件，关闭帧格式可能不一致。

**修复**：替换为`this._closeClient(client, 1009, 'Message too big')`，统一关闭处理流程。

**影响范围**：大帧违规的关闭处理与其他关闭场景一致，触发正确的disconnect事件。

#### errors/index.js — 16个缺失错误码与系统错误映射

**缺陷1**：16个实际使用的错误码（如`DUPLICATE_STEP`、`MISSING_FIELDS`、`CANCELLED`、`LIMIT_EXCEEDED`等）未在`ERROR_CODES`中定义，导致`severity`和`httpStatus`回退为默认值（error/500），但部分应为400/409/429/503等。

**修复1**：将16个错误码添加到`ERROR_CODES`、`ERROR_SEVERITY`和`HTTP_STATUS_MAP`，确保每个错误码有正确的严重级别和HTTP状态码映射。

**缺陷2**：`fromError()`将Node.js系统错误码（如`ENOENT`、`ECONNREFUSED`）直接用作HarnessError code，但系统错误码不在`ERROR_CODES`中，导致错误的HTTP状态码映射。

**修复2**：新增`SYSTEM_ERROR_MAP`映射表，将系统错误码转换为框架错误码（`ENOENT`→`RESOURCE_NOT_FOUND`/404，`ECONNREFUSED`→`CONNECTION_FAILED`/502等）。

**影响范围**：所有错误码的HTTP状态码映射正确；系统错误被转换为语义正确的框架错误码。

### Round 15 缺陷修复记录

> 本轮修复涉及工作流子系统、技能子系统的8项缺陷，并完成R7-R14回归验证（4项关键修复均仍在位）。

#### hook-handlers.js — RateLimitManager清理定时器死锁与误导性错误消息

**缺陷1**：`RateLimitManager`构造函数中的清理定时器在每次触发时调用`this.isHealthy()`，当存储达到容量上限时`isHealthy()`返回`false`，清理逻辑被跳过。过期条目永远不会被清理，存储永远停留在满容量状态——形成死锁。

**修复1**：清理定时器改为检查`this._shutDown`而非`this.isHealthy()`，确保容量满时仍能正常清理过期条目。构造函数新增`this._shutDown = false`标志。

**缺陷2**：`check()`方法在存储满时返回`{ passed: false, reason: 'Rate limiter is shut down' }`，但速率限制器并未关闭，只是存储已满，消息误导调用方。

**修复2**：`check()`改为检查`this._shutDown`，仅在真正关闭时返回"shut down"消息。存储满时由`check()`自身的淘汰逻辑处理。

**影响范围**：速率限制器在容量满时不再死锁，过期条目可被正常清理；错误消息准确反映系统状态。

#### pipeline-executor.js — 错误响应格式统一

**缺陷**：`executePipeline`成功路径返回对象使用`status`字段（`status: 'success'`等），但catch-all错误返回使用`success: false`字段，调用方无法统一检查`result.status`来判断结果。

**修复**：catch-all错误返回改为`status: 'error'`，与成功路径格式统一。

**影响范围**：管道执行结果格式一致，调用方可统一使用`result.status`判断执行结果。

#### workflow-dag.js — completeNode保留合法falsy结果值

**缺陷**：`completeNode(id, result)`使用`result || null`赋值，当`result`为合法falsy值（`0`、`false`、`''`）时被错误转为`null`，导致结果数据丢失。

**修复**：改为`result ?? null`，仅当`result`为`null`/`undefined`时才使用`null`。

**影响范围**：工作流节点结果中的0、false、空字符串等合法falsy值不再被错误丢弃。

#### skill-reducer.js — _stats.l2Misses未初始化导致NaN传播

**缺陷**：`_stats`对象初始化时未包含`l2Misses`字段，`_loadL2()`和`loadL2Async()`中执行`this._stats.l2Misses++`时，对`undefined`执行`++`运算结果为`NaN`，导致`getStats()`返回的`l2Misses`和`l2HitRate`均为`NaN`，缓存命中率统计完全失效。

**修复**：`_stats`初始化中添加`l2Misses: 0`。

**影响范围**：L2缓存命中率统计恢复正常，不再返回NaN。

#### skill-creation-engine.js — 异步方法中同步文件系统调用

**缺陷**：`createSkill()`是async方法，但使用`fs.existsSync()`检查文件是否存在；`listAutoCreatedSkills()`使用`scanMarkdownDirSync()`同步扫描目录。同步调用在HTTP请求处理路径中阻塞事件循环。

**修复**：`fs.existsSync()`替换为`await fsp.access()`；`listAutoCreatedSkills()`改为async方法，使用`fsp.readdir()`替代同步扫描。同步更新server.js和测试文件中的调用方式。

**影响范围**：技能创建和列表查询不再阻塞事件循环，高并发场景下性能提升。

#### playbook-generator.js — isHealthy()添加关闭状态检查

**缺陷**：`isHealthy()`仅检查`this._stats.errors < 100`，未检查`_shutDown`标志。关闭后的PlaybookGenerator仍报告为健康状态，可能被继续调用。

**修复**：改为`return !this._shutDown && this._stats.errors < 100`。

**影响范围**：关闭后的PlaybookGenerator正确报告不健康状态。

#### skill-evolver.js — _splitFrontmatter CRLF解析修复

**缺陷**：`_splitFrontmatter`对CRLF文件查找第二个`---`分隔符时，使用`Math.min(pos1, pos2)`在CRLF和LF匹配间取较小值，可能选错位置导致frontmatter截断。

**修复**：改为优先使用CRLF匹配（`pos1`），其次LF匹配（`pos2`），确保CRLF文件的分隔符位置正确。

**影响范围**：Windows环境下（CRLF换行）的技能文件frontmatter解析不再截断。

#### R7-R14回归验证结果

| 修复项 | 状态 |
|--------|------|
| server.js: timingSafeEqual hex编码 | ✅ 已确认 |
| deepening-cache.js: invalidateByPattern null/undefined守卫 | ✅ 已确认 |
| deepening-state-manager.js: transition() Promise检测 | ✅ 已确认 |
| errors/index.js: 无效code TypeError | ✅ 已确认 |

### Round 16 缺陷修复记录

> 本轮修复涉及Agent子系统、协作子系统、工具层、前端SPA和API安全的16项缺陷，含4个HIGH级别安全/逻辑问题。

#### agent-deployment.js — rollback()竞态条件与自动回滚递归深度保护

**缺陷1**：`rollback()`通过`process.nextTick`检查回滚部署状态，但`_executeDeployment`也使用`process.nextTick`异步执行，两个nextTick回调的执行顺序不确定，导致回滚状态判断可能错误。

**修复1**：替换`process.nextTick`为间隔轮询（`setInterval`每10ms检查回滚部署状态，30秒超时保护），确保状态判断在部署完成后执行。

**缺陷2**：自动回滚链缺少递归深度保护，理论上可能形成无限回滚循环。

**修复2**：新增`_rollbackDepth`属性（默认0），回滚部署时递增。深度≥2时跳过回滚直接标记FAILED。

**影响范围**：部署回滚状态判断可靠；自动回滚链深度受控。

#### agent-lifecycle-controller.js — 锁释放操作验证

**缺陷**：超时锁被强制接管后，原操作在finally中会误释放新操作的锁，因为`_releaseLock`不验证操作身份。

**修复**：`_releaseLock`新增`operation`参数，验证锁的操作与请求释放的操作匹配后才删除。所有7个调用点更新传递操作标识。

**影响范围**：锁操作不再被其他操作误释放，生命周期操作更安全。

#### multi-agent-router.js — 全局AGENT_STRENGTH_SETS实例级隔离

**缺陷**：`registerAgent()`和`unregisterAgent()`修改模块级全局对象`AGENT_STRENGTH_SETS`，多个`MultiAgentRouter`实例间互相污染，导致路由计算错误。

**修复**：全局对象改为默认初始副本，构造函数中创建实例级`this._agentStrengths`。所有方法使用实例级属性替代全局对象。

**影响范围**：多个MultiAgentRouter实例间能力集合完全隔离，路由计算不再互相干扰。

#### agent-sandbox.js — 策略拒绝不计入违规次数

**缺陷**：`checkAccess`在访问被拒绝时递增`violationCount`，但正常策略拒绝（如strict模式下拒绝文件系统访问）不应等同于违规。少量正常拒绝后沙箱可能被撤销。

**修复**：仅在沙箱已被撤销（`this._revoked`为true）后仍尝试访问时才递增`violationCount`。

**影响范围**：strict模式下的正常策略拒绝不再累积违规计数，沙箱不会被误撤销。

#### chat-chain.js — failTask中间状态修复

**缺陷**：`failTask`先将任务状态设为`FAILED`，然后调用`_updateBlockedTasks`，最后才判断是否重试。中间的`FAILED`状态导致依赖此任务的后续任务被错误标记为`BLOCKED`，且不会被恢复。

**修复**：重构为先判断重试条件，重试时直接设为`PENDING`再调用`_updateBlockedTasks`；不重试时设为`FAILED`再调用。

**影响范围**：非必需任务重试时依赖任务不再被错误阻塞。

#### ttl-cache.js — clear()不再停止清理定时器

**缺陷**：`clear()`调用`stopCleanup()`停止自动清理定时器，但`clear()`的语义是清空数据而非销毁缓存。后续使用缓存时过期条目不会被自动清理。

**修复**：移除`clear()`中的`stopCleanup()`调用，仅清空数据，保留定时清理机制。

**影响范围**：`clear()`后缓存仍能自动清理过期条目。

#### keyed-debouncer.js — schedule()存储回调引用

**缺陷**：`schedule()`仅存储定时器ID，`flush()`依赖外部`keyCallbackProvider`获取回调。如果provider无法提供回调，待执行操作被静默丢弃。

**修复**：内部存储改为`{ timer, callback }`对象，`flush()`优先使用存储的回调，回退到`keyCallbackProvider`。

**影响范围**：防抖回调不再可能被静默丢弃。

#### security.js — 非localhost绑定禁用开发模式绕过

**缺陷**：`devMode`或`allowDevBypass`启用时，本地请求可绕过所有认证。在容器化部署中，所有请求可能来自`127.0.0.1`（经过反向代理），导致认证完全失效。

**修复**：新增`_serverBoundToLocalhost`标志和`setServerBindingLocalhost()`函数。开发模式绕过仅在服务器绑定localhost时生效。server.js在绑定非localhost地址时调用`setServerBindingLocalhost(false)`。

**影响范围**：非localhost部署环境下开发模式绕过被自动禁用，消除认证绕过风险。

#### server.js — 敏感键过滤黑名单扩展

**缺陷**：`_sanitizeConfig`的敏感键模式列表不够全面，可能遗漏`database`、`jwt`、`oauth`、`aws`等敏感配置项。

**修复**：新增10个敏感键模式：`/private/i`、`/db_url/i`、`/mongo/i`、`/redis/i`、`/jwt/i`、`/oauth/i`、`/s3/i`、`/aws/i`、`/gcs/i`、`/encryption/i`、`/ssh[_-]?key/i`。

**影响范围**：`/api/config`端点不再泄露数据库连接串、JWT密钥等敏感配置。

### Round 17 缺陷修复记录

> 本轮修复Round 16遗留MEDIUM缺陷5项 + 新扫描发现5项 = 10项缺陷。

#### pair-chat.js — 超时会话统计独立计数

**缺陷**：`_cleanupTimedOutSessions`将超时会话计入`totalSessions`，但`addRound`中已完成会话也计入同一计数器，导致`avgCorrectionsPerSession`和`avgRoundsPerSession`计算结果偏低。

**修复**：新增`timedOutSessions`独立计数器，超时会话不再混入`totalSessions`。`getStats()`返回`timedOutSessions`作为独立字段。

**影响范围**：配对对话统计指标更准确，超时会话不再拉低平均值。

#### bounded-map.js — FIFO淘汰顺序保持

**缺陷**：`set()`对已存在键执行`delete`+`set`，将键移到Map末尾（最新位置），破坏FIFO淘汰语义——更新不应改变淘汰顺序。

**修复**：对已存在键直接`this._map.set(key, value)`更新值，不改变Map插入顺序。仅新键触发淘汰逻辑。

**影响范围**：BoundedMap的FIFO淘汰语义正确，更新操作不再影响淘汰顺序。

#### debounced-persister.js — destroy()数据丢失警告

**缺陷**：`destroy()`中第二次`persistNow`尝试也失败时，脏数据被静默丢弃，无任何通知。

**修复**：第二次尝试后如果`_dirty`仍为true，通过`console.warn`发出数据丢失警告，并通过`_onError`报告。

**影响范围**：持久化失败不再静默丢失，开发者可通过警告日志感知数据丢失。

#### app.js — batchUpdate嵌套prev值修正与DOM清理

**缺陷1**：嵌套`batchUpdate`调用时，内层从已更新的状态重新计算`prevValues`，导致通知中的`prev`参数不正确。

**修复1**：当`_batchDepth > 0`时跳过`prevValues`计算（设为null），保留外层批次的原始prev值。

**缺陷2**：`updateHTML`替换`innerHTML`后，旧DOM元素的事件监听器和`_lazyCallbacks`引用未清理，可能导致内存泄漏。

**修复2**：在`innerHTML`替换前，迭代`_lazyCallbacks`并删除元素不再`isConnected`的条目。

**影响范围**：前端Store通知的prev值正确；DOM更新后不再残留旧引用。

#### sprint-cycle.js — pause()在run()执行期间生效

**缺陷**：`pause()`设置`_state = PAUSED`，但`run()`中的while循环仅检查`_aborted`，不观察暂停状态，导致`pause()`在执行期间无效。

**修复**：while循环中添加`_state === SPRINT_STATES.PAUSED`检查，暂停时循环退出并返回暂停结果。

**影响范围**：Sprint周期可在执行期间被暂停，不再需要等待当前迭代完成。

#### tool-adapter.js — registerToolConfig()类型验证

**缺陷**：`registerToolConfig()`接受任何`toolType`字符串，包括未知/无效类型，导致配置与能力不一致。

**修复**：添加验证——如果`toolType`为假值或不在`TOOL_CAPABILITIES`中则返回`false`，成功返回`true`。

**影响范围**：工具注册不再接受无效类型，配置与能力保持一致。

#### rag-pipeline.js — 分块截断时元数据一致性

**缺陷**：当达到`MAX_CHUNKS`时，文档以不完整的`chunkIds`注册，但`chunkCount`和事件报告`chunks.length`（总数）而非`chunkIds.length`（实际索引数）。

**修复**：`chunkCount`和事件改用`chunkIds.length`；新增`totalChunks`字段记录原始总数。

**影响范围**：RAG管道分块截断时元数据与实际索引一致。

#### agent-channel.js — setSharedWithVersion()结果隔离

**缺陷**：`setSharedWithVersion()`返回`this._sharedWriteLock`，并发调用者收到彼此的结果而非自己的结果。

**修复**：创建独立的`resultPromise`，仅用当前操作的写入结果解析，同时仍在`_sharedWriteLock`上序列化写入。

**影响范围**：并发写入操作的结果不再互相干扰。

#### agent-pack-manager.js — 裸版本精确匹配

**缺陷**：`_satisfiesVersion()`对无前缀的裸版本（如`"1.2.3"`）回退到`>=`语义，导致`"2.0.0"`满足`"1.2.3"`的要求。

**修复**：裸版本回退改为`=== 0`（精确匹配），符合语义版本惯例。

**影响范围**：无前缀版本要求现在执行精确匹配，不再意外满足更高版本。

---

## Round 18 缺陷修复记录

> 本轮修复思维子系统、质量子系统、上下文子系统和前端交互的12项缺陷（1 HIGH + 11 MEDIUM）。

### self-reflection.js — decision模板类型导致TypeError

**缺陷**：`REFLECTION_TEMPLATES.decision`是对象`{ dimensions, prompts }`而非数组。当`artifactType === 'decision'`时，对象被赋给`questions`，后续`forEach`调用抛出TypeError，导致整个反思流程崩溃。

**修复**：提取`prompts`数组：`Array.isArray(template) ? template : (template.prompts ?? REFLECTION_TEMPLATES.code)`。同时将质量趋势判断逻辑提取为`_computeQualityTrend()`辅助方法，降低`reflect()`方法的圈复杂度（21→16）。

**影响范围**：decision类型反思不再崩溃；reflect方法复杂度降至ESLint阈值以下。

### thought-deduplicator.js — 阈值0被覆盖与置信度合并无效操作

**缺陷1**：`similarityThreshold`使用`||`运算符，传入`0`时被覆盖为默认值0.75。

**修复1**：改为`??`运算符。

**缺陷2**：`_mergeThoughts`的else分支`Math.max(existing, incoming * 0.9)`永远是existing值，合并无效果。

**修复2**：改为`Math.min(1.0, existing + incoming * 0.05)`，实际融入incoming置信度。

**影响范围**：阈值0正确生效（不进行去重）；思维合并时incoming置信度被实际纳入。

### thought-retriever-cycle.js — 混合检索评分公平性

**缺陷**：重叠条目获得固定+0.6加分，纯语义条目最高仅0.6分，低质量重叠条目可能超过高质量纯语义条目。

**修复**：重叠加分也应用质量因子：`this._semanticWeight * (t.confidence ?? 0.5)`。

**影响范围**：混合检索评分更公平，低质量重叠条目不再被高估。

### quality-scorer.js — 字符串结果零分问题

**缺陷**：`typeof result !== 'object'`将字符串结果直接判零分，但字符串是多Agent框架中的合法产出（代码、文档、LLM输出）。

**修复**：新增字符串处理分支，计算`completeness`、`coverage`、`clarity`维度，`correctness`和`consistency`默认0.5。

**影响范围**：纯文本Agent产出不再永远被评为failing等级。

### self-evolution-governor.js — 心跳错误双重计数

**缺陷**：`_executeHeartbeat`和`_scheduleNextHeartbeat`的catch块都递增`_consecutiveErrors`，同一错误被计数两次，可能过早触发熔断器。

**修复**：内部catch标记`err._handledByHeartbeat = true`，外部catch检查标记后跳过已处理错误。

**影响范围**：心跳错误计数准确，熔断器不再过早触发。

### context-compression-engine.js — deepClone失败降级方案

**缺陷**：deepClone失败时使用浅拷贝降级，嵌套对象与缓存共享引用，调用者修改会污染缓存。

**修复**：降级方案改为`JSON.parse(JSON.stringify(...))`深拷贝，最终降级为使缓存失效并重新计算。

**影响范围**：压缩结果与缓存完全隔离，不再存在引用污染风险。

### lti-context-injector.js — 浅拷贝与中文overlap计算

**缺陷1**：`{ ...current }`浅拷贝导致注入结果的嵌套对象与原始任务共享引用。

**修复1**：改为`deepClone(current)`深拷贝。

**缺陷2**：`_computeOverlap`按空格分词，中文整句被当作一个"词"，overlap计算完全失效。

**修复2**：检测中文文本后使用字符bigram Jaccard相似度，英文保持空格分词。

**影响范围**：LTI注入结果与原始任务完全隔离；中文内容的goalSignal计算恢复正常。

### phase-context-injector.js — 阶段切换缓存失效

**缺陷**：全局`_cacheTimestamp`导致加载任何阶段都会使其他阶段的缓存失效，频繁重建上下文。

**修复**：缓存结构改为`{ result, timestamp }`，每条缓存独立TTL检查。

**影响范围**：阶段切换不再导致其他阶段的缓存失效，减少不必要的重建。

### app.js — 并发请求pending跟踪覆盖

**缺陷**：并发同端点API请求的pending条目互相覆盖，请求去重和清理机制失效。

**修复**：在创建新请求前检查是否已有pending请求，有则复用其Promise。

**影响范围**：并发请求正确去重，pending跟踪不再互相覆盖。

### isolated-context-manager.js — getContext刷新访问时间

**缺陷**：`getContext`每次读取都更新`lastAccessedAt`，监控密集场景下已完成的上下文永远不会被LRU驱逐。

**修复**：仅在授权Agent实际使用时更新`lastAccessedAt`，纯读取操作不刷新。

**影响范围**：LRU驱逐策略正确工作，监控操作不再阻止上下文回收。

---

## Round 19 缺陷修复记录

> 本轮修复思维子系统（dream-engine/dream-scheduler/brain-memory/llm-wiki）、工作流子系统（execution-mode-manager/plan-persistence/agent-workflow-integration）、上下文子系统（autoregressive-context-schema）和跨模块一致性（`||` vs `??`）的12项缺陷（4 HIGH + 8 MEDIUM）。

### dream-engine.js — 快照回滚机制失效

**缺陷**：`_mergeWithExistingNotes`使用`new Map(this._notes)`浅拷贝作为快照，Map中的value对象与原Map共享引用。合并逻辑修改`existing.confidence`等属性时，快照中的同一对象也被修改，回滚`this._notes = snapshot`无法恢复原始数据。

**修复**：对快照中每个note对象进行深拷贝：`snapshot.set(id, { ...note, source_sessions: [...(note.source_sessions || [])] })`。

**影响范围**：合并失败时回滚机制正确恢复原始数据。

### dream-scheduler.js — 周期性回顾完全失效

**缺陷**：`_periodicReview`调用`startDreaming([])`传入空数组，但startDreaming对空数组直接返回null。调度器的核心功能（定期回顾历史会话）完全失效。

**修复**：新增`_sessionHistoryProvider`回调和`setSessionHistoryProvider()`方法。`_periodicReview`通过provider获取会话历史，有数据时才调用startDreaming。

**影响范围**：周期性回顾功能恢复正常，可从外部注入会话历史数据。

### brain-memory.js — 异步嵌入竞态条件与僵尸嵌入

**缺陷1**：连续两次`store()`对同一key调用时，第一次的异步嵌入resolve后覆盖第二次的新嵌入向量。

**修复1**：`.then()`回调中添加`current !== record`身份检查和`!this._memories.has(key)`存在性检查。

**缺陷2**：记忆被淘汰后，异步嵌入resolve仍将key重新插入`_embeddings`，产生僵尸嵌入。

**修复2**：同上，`!this._memories.has(key)`检查已覆盖此场景。

**缺陷3**：`_retrieveSemantic`未处理异步嵌入返回Promise，cosineSimilarity计算错误。

**修复3**：添加`typeof queryVector.then === 'function'`检测，异步模式返回空数组。

**缺陷4**：`meta.ttl || defaultTTL`假值强制转换，`ttl: 0`被覆盖为默认值。

**修复4**：改为`meta.ttl ?? defaultTTL`。

**影响范围**：异步嵌入不再产生竞态覆盖和僵尸条目；语义检索在异步嵌入模式下优雅降级；TTL=0正确生效。

### llm-wiki.js — 无效日期导致过期检查静默跳过

**缺陷**：`suggestUpdates`使用`new Date(updated_at)`解析日期，无效日期产生NaN，`NaN > 30`为false，过期检查被静默跳过。

**修复**：添加`isNaN(updatedAt.getTime()) ? Infinity :`守卫，无效日期视为无限旧（始终标记为需要更新）。

**影响范围**：无效日期的知识条目不再被遗漏，始终被标记为需要更新。

### execution-mode-manager.js — 手动EventEmitter混入改为标准继承

**缺陷**：使用`EventEmitter.call(this)` + `Object.assign(prototype)`手动混入模式，与项目其他类不一致，`instanceof`检查失败，与`withShutdown`组合时原型链可能不完整。

**修复**：改为标准`class ExecutionModeManager extends EventEmitter`继承模式。

**影响范围**：`instanceof EventEmitter`检查正确，与项目其他类保持一致。

### plan-persistence.js / agent-workflow-integration.js — `|| null`假值强制转换

**缺陷**：`task.result || null`和`feedback.result || null`将合法假值结果（`0`、`false`、`""`）强制转换为`null`。

**修复**：统一改为`?? null`空值合并运算符。

**影响范围**：任务和反馈的假值结果不再被静默替换为null。

### autoregressive-context-schema.js — inject()字段名验证

**缺陷**：`inject()`接受任意字段键值对，不验证字段名是否属于`FIELDS`中定义的合法字段，导致schema定义形同虚设。

**修复**：添加字段白名单检查，未知字段输出debug警告。

**影响范围**：上下文数据不再包含不可预期的字段，版本兼容性检查更准确。

---

## Round 20 缺陷修复记录

> 本轮修复跨模块`||` vs `??`假值强制转换（14处）、异步路径缺失错误处理（4处）、深化子系统逻辑缺陷（3处）和门禁子系统逻辑缺陷（1处），共22项缺陷（6 HIGH + 16 MEDIUM）。

### `||` vs `??` 假值强制转换系统性修复（14处）

**核心问题**：JavaScript的`||`运算符将`0`、`""`、`false`视为假值，导致这些语义合法值被错误替换为默认值。`??`（空值合并）仅在`null`/`undefined`时回退，是数值参数的正确选择。

| 文件 | 参数 | 0值语义 | 修复 |
|------|------|---------|------|
| agent-channel.js | `limit` | 获取0条消息 | `?? mailbox.length` |
| agent-channel.js | `timeout` | 不等待 | `?? DEFAULT_REQUEST_TIMEOUT` |
| agent-channel.js | `maxAgeMs` | 上下文始终过期 | `?? DEFAULT_CONTEXT_MAX_AGE_MS` |
| ttl-cache.js | `ttlMs` | 立即过期 | `?? entry.ttl ?? Infinity` |
| subagent-executor.js | `confidence` | 完全无信心 | `!== undefined ? : DEFAULT` |
| hook-handlers.js (×2) | `token_budget` | 禁止token消耗 | `?? DEFAULT_TOKEN_BUDGET` |
| multi-agent-router.js | `limit` | 返回0条历史 | `?? _routingHistory.size` |
| deepening-feature-flags.js | `limit` | 返回0条历史 | `?? _maxHistory` |
| deepening-validator.js | `limit` | 返回0条历史 | `?? _historySize` |
| deepening-event-replay.js | `limit` | 返回0条事件 | `?? _eventList.size` |
| deepening-audit-trail.js | `limit` | 返回0条审计 | `?? result.length` |
| deepening-cache.js | `maxSize` | 禁用缓存 | `?? 1000` |
| deepening-retry-policy.js | `baseDelay/maxDelay` | 无延迟重试 | `?? _default*` |
| deepening-health-monitor.js | `timeout` | 无超时 | `?? _timeout` |
| deepening-workflow-template.js | `depthLevel` | 空字符串 | `?? 'standard'` |

**最关键修复**：`token_budget=0`不再被绕过（成本控制生效）；`ttlMs=0`缓存条目正确立即过期；`confidence=0`不再被替换为0.5。

### server.js — async evaluate()未await

**缺陷**：`nudge.evaluate()`是async函数，但调用处未使用`await`，导致API返回Promise对象而非实际结果，破坏API契约。

**修复**：添加`await`关键字，确保API返回实际评估结果。

**影响范围**：`/api/nudge/evaluate`端点正确返回评估结果。

### deepening-event-bus.js — 通配符`prefix.*`错误匹配`prefix`本身

**缺陷**：`topic.startsWith(pattern.slice(0, -2))`会匹配`prefix`本身（无后缀），违反通配符语义。

**修复**：改用`topic.startsWith(prefix) && topic.length > prefix.length`，确保`prefix.*`只匹配`prefix.something`。

**影响范围**：事件订阅通配符语义正确，不再收到不匹配的事件。

### deepening-notifier.js — 异步回调Promise未处理 + 通知交付保证

**缺陷1**：`channel.callback(entry)`如果返回Promise，try-catch无法捕获异步异常，导致未处理的Promise rejection。

**修复1**：检测Promise返回值并添加`.catch()`处理。

**缺陷2**：`_notify`始终返回`Promise.resolve(true)`，无论通知是否实际交付。

**修复2**：添加`delivered`计数器，返回`Promise.resolve(delivered > 0)`。

**影响范围**：异步通知回调不再产生未处理异常；通知交付结果可被调用者感知。

### output-conciseness-guard.js — 注释行检测误判

**缺陷**：以`*`开头的非注释代码行（如`*ptr`、`* 2`、`* item`）被误分类为注释行，导致`codeCommentRatio`偏高。

**修复**：改用精确正则`/^\s*(\/\/|\/\*|\*\/|\*\s|\*\/)/`替代松散的`startsWith`检查。

**影响范围**：代码注释比计算更准确，减少误报。

### server.js — DashboardServer.isHealthy()关闭状态检查修复

**缺陷**：`DashboardServer.isHealthy()`方法未检查`_shuttingDown`标志，服务器关闭过程中及关闭后仍报告为健康状态，可能被继续调用导致异常。

**修复**：`isHealthy()`中添加`_shuttingDown`检查，关闭过程中返回`false`。

**影响范围**：Dashboard服务器关闭期间及关闭后正确报告不健康状态，不再被误用。

### Round 21（2026-05-31）

| 模块 | 修复内容 | 详情 |
|------|---------|------|
| app.js | 前端Promise异常反馈修复2处 | `DataLayer.fetchAll`的刷新按钮和下拉刷新两处调用中，Promise的catch分支仅记录日志未向用户展示错误提示。新增`showToast`错误提示，网络异常或API错误时用户可感知到刷新失败，而非静默无反馈 |

---

## 19. 交叉引用

- [[模块详解-Dashboard数据提供者]] — 数据提供者 Mixin 架构详解
- [[模块详解-EventBus模块]] — 事件总线，Dashboard 事件桥接的数据源
- [[模块详解-SessionManager会话管理器]] — 会话管理，`/api/sessions` 数据源
- [[模块详解-SkillRouter模块]] — Skill 路由，`/api/skill-layers/*` 数据源
- [[模块详解-MCPClient模块]] — MCP 客户端，`/api/mcp/*` 数据源
- [[模块详解-GoalExecutor目标执行器]] — 目标执行，`/api/goal/*` 数据源
- [[模块详解-DeepeningOrchestrator模块]] — 深化推理，`/api/deepening/*` 数据源
- [[模块详解-CollaborationModeRouter模块]] — 协作模式，`/api/collaboration/*` 数据源
- [[模块详解-PhaseOrchestrator阶段编排器]] — 阶段编排，`/api/workflow` 数据源
- [[模块详解-ProgrammableHookExecutor模块]] — 钩子执行，`/api/programmable-hook/*` 数据源
- [[模块详解-TokenManager模块]] — Token 管理，`/api/token/record` 数据源
- [[模块详解-RBACEnforcer模块]] — RBAC 执行器，权限验证基础设施
- [[模块详解-PermissionGuard模块]] — 权限守卫，文件操作安全
- [[核心功能-权限控制与审计]] — 审计日志
- [[核心功能-多Agent协作流程]] — 工作流阶段定义
- [[架构分析-AIProject系统]] — 整体架构设计
