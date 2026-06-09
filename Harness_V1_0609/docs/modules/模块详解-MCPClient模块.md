# 模块详解-MCPClient模块

> 版本：2.73.4 | 文件：src/runtime/infrastructure/mcp-client.js

---

## 模块定位

MCPClient是MCP协议客户端，支持stdio和HTTP双传输模式，用于与外部MCP服务器通信，提供进程退出清理、buffer限制和SSRF防护。

## 核心能力

| 能力 | 说明 |
|------|------|
| **双传输模式** | stdio和HTTP两种传输协议 |
| **进程管理** | 自动启动/停止MCP服务器进程 |
| **安全防护** | SSRF防护、buffer大小限制 |
| **资源清理** | 进程退出时自动清理子进程 |

## 类定义

```javascript
class MCPClient extends EventEmitter {
  constructor(options = {})
  addServer(name, config)
  connectServer(name, config)
  connectAll()
  removeServer(name)
  callTool(fullName, args)
  getAvailableTools()
  getServerStatus()
  getStats()
  isHealthy()
  shutdown()  // via withShutdown mixin
}
```

## 配置示例

```json
{
  "mcp_servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "remote-api": {
      "transport": "http",
      "url": "https://api.example.com/mcp"
    }
  }
}
```

## 安全架构

### SSRF防护

所有出站 HTTP 连接均经过 `_checkSsrfHostname` 统一检查：

```javascript
_checkSsrfHostname(hostname, blockedHosts) {
  const hosts = blockedHosts || MCP_DEFAULT_BLOCKED_HOSTS;
  if (hosts.includes(hostname)) {
    throw new DeepeningError('SECURITY_VIOLATION', 'SSRF blocked: hostname ' + hostname + ' is in blocked list');
  }
  for (const pattern of MCP_BLOCKED_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new DeepeningError('SECURITY_VIOLATION', 'SSRF blocked: hostname ' + hostname + ' matches blocked pattern');
    }
  }
}
```

检查覆盖三个入口点：

1. `_validateServerConfig` — 配置验证阶段
2. `_connectHttp` — HTTP 连接建立阶段
3. `_sendHttpRequest` — 实际请求发送阶段

#### 防护层级

| 层级 | 检查内容 | 实现方式 |
|------|---------|---------|
| 黑名单 | 已知危险主机名 | `MCP_DEFAULT_BLOCKED_HOSTS` 数组 |
| 模式匹配 | 内网/私有网络地址 | `MCP_BLOCKED_HOST_PATTERNS` 正则数组 |
| URL 解析 | 协议和端口验证 | `new URL()` 解析后检查 |

### 传输模式安全措施

- **stdio模式**：通过子进程标准输入/输出通信，安全措施包括进程退出清理、buffer大小限制（8KB stderr截断）
- **HTTP模式**：通过HTTP/HTTPS请求通信，安全措施包括SSRF检查、请求超时、AbortController

### 关键配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `maxPendingRequests` | 1000 | 最大挂起请求数 |
| `stderrTruncateSize` | 8192 | stderr 输出截断长度 |
| `hookTimeout` | 60000ms | 钩子执行超时 |

### 错误码体系

所有错误统一使用 `DeepeningError` 类，包含以下错误码：

| 错误码 | 触发场景 |
|--------|---------|
| `SECURITY_VIOLATION` | SSRF 检查失败 |
| `SSRF_BLOCKED` | 请求发送时 SSRF 检查失败 |
| `TIMEOUT` | 请求超时 |
| `CONNECTION_FAILED` | 连接建立失败 |
| `INVALID_CONFIG` | 配置验证失败 |
| `PROTOCOL_ERROR` | MCP 协议错误 |

## OpenCLI集成

OpenCLI集成通过MCPClient的stdio传输模式连接 `@jackwener/opencli` MCP服务器，将80+网站和Electron应用转化为AI可调用的CLI命令。

### 80+网站适配器

OpenCLI内置适配器覆盖主流网站和服务：

| 类别 | 示例网站 |
|------|---------|
| 搜索引擎 | Google、Bing、DuckDuckGo |
| 社交媒体 | Twitter/X、Reddit、LinkedIn |
| 开发平台 | GitHub、GitLab、Stack Overflow |
| 电商平台 | Amazon、eBay |
| 知识库 | Wikipedia、Medium |
| 办公套件 | Google Docs、Notion |

### Chrome Bridge浏览器会话复用

Chrome Bridge是OpenCLI的核心特性，允许AI Agent复用用户已登录的Chrome浏览器会话：

1. **零Token成本**：直接操作已登录页面，无需重新认证
2. **会话复用**：利用现有Cookie和Session，跳过登录流程
3. **结构化数据提取**：将网页内容转化为结构化JSON

**安装步骤：**

1. 从GitHub Releases下载 `opencli-extension.zip`
2. 在 `chrome://extensions` 加载解压目录
3. 运行 `opencli doctor` 验证连接

**配置示例：**

```json
{
  "mcp_servers": {
    "opencli": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@jackwener/opencli"],
      "tools": { "include": ["*"] },
      "requires": ["chrome-browser-bridge"]
    }
  }
}
```

## CLI-Anything集成

CLI-Anything集成通过MCPClient连接港大HKUDS开源的 `cli-anything-hub`，将任意桌面软件转化为AI可直接调用的CLI工具。

### 工作原理

CLI-Anything通过7阶段自动化流水线生成Agent-Native命令行接口：

1. **软件分析**：解析目标软件的API/CLI/菜单结构
2. **接口提取**：识别可编程操作点
3. **命令生成**：为每个操作生成CLI命令
4. **参数映射**：将GUI操作映射为CLI参数
5. **测试验证**：自动测试生成的CLI命令
6. **文档生成**：生成命令使用文档
7. **注册发布**：注册到CLI-Anything Hub

### Hub分类目录

| 分类 | 工具示例 |
|------|---------|
| 创意与媒体 | GIMP、Blender、Inkscape、Krita、OBS Studio、KdenLive |
| 办公与企业 | LibreOffice、Calibre、DrawIO、Obsidian、Zotero |
| AI与机器学习 | ComfyUI、Ollama、ChromaDB、Dify Workflow |
| 开发与运维 | n8n、PM2、LLDB、WireMock、iTerm2 |
| 工程与科学 | FreeCAD、QGIS、CloudCompare、RenderDoc |
| 数据与分析 | Exa、CloudAnalyzer、Firefly III |
| 游戏与娱乐 | Godot、Slay the Spire II |

**安装步骤：**

```bash
pip install cli-anything-hub
cli-hub install gimp        # 安装GIMP CLI
cli-hub install libreoffice # 安装LibreOffice CLI
```

**配置示例：**

```json
{
  "mcp_servers": {
    "cli-anything": {
      "enabled": true,
      "command": "python",
      "args": ["-m", "cli_anything_hub"],
      "tools": { "include": ["*"] },
      "requires": ["python3.10+", "target-software"]
    }
  }
}
```

## Dashboard API端点

MCPClient的OpenCLI和CLI-Anything集成状态通过Dashboard API端点暴露：

### /api/opencli/status

返回OpenCLI服务器运行时状态：

```json
{
  "available": true,
  "connected": true,
  "toolCount": 15,
  "serverName": "opencli"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `available` | boolean | OpenCLI是否已配置 |
| `connected` | boolean | MCP服务器是否已连接 |
| `toolCount` | number | 已发现的工具数量 |
| `serverName` | string | 服务器名称 |

### /api/opencli/servers

返回所有MCP服务器状态（含OpenCLI）：

```json
{
  "available": true,
  "servers": {
    "opencli": { "connected": true, "toolCount": 15 },
    "filesystem": { "connected": true, "toolCount": 3 },
    "cli-anything": { "connected": false, "toolCount": 0 }
  }
}
```

### /api/cli-anything/status

返回CLI-Anything服务器运行时状态：

```json
{
  "available": true,
  "connected": true,
  "toolCount": 8,
  "serverName": "cli-anything"
}
```

### /api/cli-anything/registry

返回CLI-Anything已注册的工具列表（最多100个）：

```json
{
  "available": true,
  "toolCount": 8,
  "tools": [
    { "name": "mcp_cli-anything_gimp_export", "description": "Export image from GIMP" },
    { "name": "mcp_cli-anything_blender_render", "description": "Render Blender scene" }
  ],
  "truncated": false
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `toolCount` | number | 返回的工具数量 |
| `tools` | array | 工具列表（名称截断256字符，描述截断1024字符） |
| `truncated` | boolean | 是否因超过100条限制而截断 |

### /api/cli-anything/hub

返回CLI-Anything Hub信息，包含分类目录和安装命令：

```json
{
  "available": true,
  "connected": true,
  "totalCatalogTools": 40,
  "installedTools": 8,
  "categories": [...],
  "hubInstallCommand": "pip install cli-anything-hub",
  "skillInstallCommand": "npx skills add HKUDS/CLI-Anything --skill <name> -g -y"
}
```

## MCP协议交互流程

MCPClient基于JSON-RPC 2.0协议与MCP服务器通信，遵循MCP规范 `2024-11-05` 版本。

### 初始化握手

```
Client → Server:  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"harness-mcp-client","version":"1.0.0"}}}
Server → Client:  {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{...},"serverInfo":{"name":"...","version":"..."}}}
Client → Server:  {"jsonrpc":"2.0","method":"notifications/initialized"}
```

### 工具发现

```
Client → Server:  {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
Server → Client:  {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"read_file","description":"...","inputSchema":{...}}]}}
```

### 工具调用

```
Client → Server:  {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"/etc/hosts"}}}
Server → Client:  {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"127.0.0.1 localhost"}]}}
```

### 错误响应

```
Server → Client:  {"jsonrpc":"2.0","id":3,"error":{"code":-32600,"message":"Invalid params"}}
```

### 传输模式对比

| 特性 | stdio模式 | HTTP模式 |
|------|----------|---------|
| 传输方式 | 子进程stdin/stdout | HTTP POST请求 |
| 连接建立 | `spawn()` 启动子进程 | URL直连 |
| 数据格式 | 每行一个JSON-RPC消息 | HTTP请求体/响应体 |
| 生命周期 | 随子进程 | 无状态 |
| 适用场景 | 本地MCP服务器 | 远程MCP服务器 |
| 安全措施 | 命令白名单、参数过滤 | SSRF防护、请求超时 |

## callTool()方法详解

### 方法签名

```javascript
async callTool(fullName, args)
```

### 参数格式

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `fullName` | string | 是 | 工具全名，格式：`mcp_{serverName}_{toolName}` |
| `args` | object \| null | 否 | 工具调用参数，必须为对象或null/undefined |

### 参数校验规则

1. `fullName` 必须为非空字符串，否则抛出 `INVALID_INPUT`
2. `args` 若提供必须为对象（非数组），否则抛出 `INVALID_INPUT`
3. 工具必须在 `_tools` 注册表中存在，否则抛出 `RESOURCE_NOT_FOUND`
4. 工具所属服务器必须已连接，否则抛出 `CONNECTION_FAILED`

### 返回值结构

成功时返回JSON-RPC响应对象：

```javascript
{
  jsonrpc: "2.0",
  id: 3,
  result: {
    content: [{ type: "text", text: "..." }]
  }
}
```

失败时抛出 `DeepeningError`，错误码参见错误码体系表。

### 超时处理

- **stdio模式**：请求超时由 `MCP_CONNECT_TIMEOUT_MS`（默认60000ms）控制，超时后自动reject并清理pending请求
- **HTTP模式**：超时由 `MCP_HTTP_DEFAULT_TIMEOUT`（默认60000ms）控制，可通过 `config.httpTimeout` 自定义
- **容量保护**：最大挂起请求数 `MCP_MAX_PENDING_REQUESTS`（默认1000），超出时抛出 `CAPACITY_EXCEEDED`

### 事件发射

| 事件 | 触发条件 | 数据 |
|------|---------|------|
| `tool-called` | 工具调用完成 | `{ tool: fullName, success: boolean, error?: string }` |

## 进程生命周期管理

MCPClient通过 `withShutdown` 混入实现完整的进程生命周期管理。

### 子进程启动

1. 调用 `spawn(command, args, options)` 创建子进程
2. 配置 `stdio: ['pipe', 'pipe', 'pipe']` 建立双向通信
3. 继承白名单环境变量（`PATH`/`HOME`/`LANG`等7项），合并自定义环境变量
4. 设置stdout行缓冲解析器，按 `\n` 分割JSON-RPC消息
5. 设置stderr截断监听器（8KB截断）

### 健康检查

`isHealthy()` 方法检查客户端健康状态：

```javascript
isHealthy() {
  const servers = Object.values(this._servers);
  if (servers.length === 0) return false;
  return servers.some(s => {
    if (s.type === 'stdio') return s.process && !s.process.killed && !s._exited;
    return true;
  });
}
```

- 至少有一个服务器连接时才返回 `true`
- stdio模式额外检查进程存活状态（`!killed && !_exited`）
- HTTP模式始终视为健康

### 崩溃重启

当stdio子进程异常退出时：

1. 触发 `server-exit` 事件，标记 `_exited = true`
2. 清理该服务器的所有pending请求（reject并抛出 `SERVER_EXIT` 错误）
3. 移除stdout/stderr监听器
4. 清理stdio缓冲区

> 注意：MCPClient不自动重启崩溃的子进程。需通过 `removeServer()` + `connectServer()` 手动重连。

### 退出清理

`_onShutdown()` 方法在框架关闭时执行：

1. **拒绝pending请求**：遍历所有pending请求，reject并抛出 `SHUTDOWN` 错误
2. **关闭stdin**：调用 `stdin.end()` 通知子进程不再发送数据
3. **移除监听器**：清理stdout/stderr/process上的所有监听器
4. **SIGTERM终止**：向子进程发送SIGTERM（Windows上使用 `kill()` 无信号）
5. **强制杀死**：设置 `MCP_FORCE_KILL_DELAY_MS`（默认5000ms）定时器，超时后SIGKILL
6. **清理状态**：重置 `_servers`/`_tools`/`_stdioBuffers`/`_config`

## 防御性编码实践

MCPClient和Dashboard API端点均采用防御性编码，确保在异常情况下安全降级。

### null/typeof检查

Dashboard API端点在访问MCPClient返回值时进行多层防御：

```javascript
_getOpenCLIStatus() {
  try {
    const mcpClient = this._rt('mcpClient');
    if (!mcpClient) return { available: false, message: 'MCP client not initialized' };
    if (typeof mcpClient.getServerStatus !== 'function') return { available: false, message: '...' };
    const allStatus = mcpClient.getServerStatus();
    if (!allStatus || typeof allStatus !== 'object') return { available: false, message: '...' };
    const opencli = allStatus.opencli;
    if (!opencli) return { available: false, connected: false, message: '...' };
    return {
      available: true,
      connected: !!opencli.connected,
      toolCount: opencli.toolCount ?? 0,
    };
  } catch (_err) {
    return { available: false, message: 'OpenCLI status check failed' };
  }
}
```

关键防御模式：

| 检查点 | 防御措施 |
|--------|---------|
| MCPClient实例 | `!mcpClient` 空检查 |
| 方法存在性 | `typeof mcpClient.getServerStatus !== 'function'` |
| 返回值类型 | `!allStatus \|\| typeof allStatus !== 'object'` |
| 子属性存在性 | `!opencli` 空检查 |
| 布尔值规范化 | `!!opencli.connected`、`typeof x === 'boolean' ? x : !!x` |
| 数值规范化 | `typeof x === 'number' && Number.isFinite(x) ? x : 0` |
| 空值合并 | `opencli.toolCount ?? 0` |

### try-catch保护

所有Dashboard API端点方法均包裹在try-catch中，确保异常不会导致服务器崩溃：

```javascript
_getCliAnythingStatus() {
  try {
    // ... 正常逻辑
  } catch (err) {
    debug('Dashboard', 'cliAnythingStatusError', err && err.message ? err.message : String(err));
    return { available: false, message: 'CLI-Anything status check failed' };
  }
}
```

### 返回数据过滤

Dashboard API对返回数据进行严格过滤和截断：

| 过滤类型 | 实现方式 | 限制 |
|---------|---------|------|
| 工具名称截断 | `name.length > 256 ? name.slice(0, 256) : name` | 256字符 |
| 描述截断 | `desc.length > 1024 ? desc.slice(0, 1024) : desc` | 1024字符 |
| 列表截断 | `.slice(0, 100)` | 最多100条 |
| 工具过滤 | `tool.name.startsWith('mcp_cli-anything_')` | 按前缀过滤 |
| 敏感信息过滤 | `_sensitiveKeyPatterns` 正则匹配 | 14种敏感键模式 |

## 相关文档

- PluginManager插件管理器
- [核心功能-多Agent协作流程](../core/核心功能-多Agent协作流程.md)
