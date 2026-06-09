# 模块详解-MCP服务器自动发现

> 版本：2.73.4 | 文件：src/runtime/infrastructure/mcp-auto-discovery.js | 行数：~282行

---

## 模块定位

McpAutoDiscovery是MCP服务器自动发现器，基于EventEmitter扩展，是基础设施子系统的MCP自动发现组件。它自动扫描常见位置（node_modules、全局npm安装、配置目录）以发现可用的MCP服务器，填补了Harness框架在MCP服务器自动发现方面的空白。该模块融合了Claude Code扩展功能的MCP自动发现机制，使MCP服务器的接入从手动配置变为自动发现。

## 设计理念

Claude Code扩展通过MCP（Model Context Protocol）连接外部工具和服务，但MCP服务器的发现和配置通常需要手动操作。McpAutoDiscovery通过自动扫描机制，实现：

- **多源扫描**：从node_modules、全局npm、配置目录等多个来源自动发现MCP服务器
- **模式匹配**：通过正则表达式匹配MCP服务器命名模式（`mcp-server-*`、`mcp-*`）
- **元数据提取**：自动读取package.json获取版本、描述和命令入口
- **配置生成**：为发现的服务器自动生成配置条目，简化接入流程

## 类定义

```javascript
class McpAutoDiscovery extends EventEmitter {
  constructor(config)
  discover()
  getDiscoveredServer(name)
  getDiscoveredServers()
  getServersBySource(source)
  generateConfigEntries()
  getStats()
  shutdown() // via withShutdown mixin
  isHealthy()
}
```

## 构造函数

### `constructor(config)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `config` | object | 否 | 配置选项 |
| `config.projectRoot` | string | 否 | 项目根目录，默认`process.cwd()` |
| `config.scanNodeModules` | boolean | 否 | 是否扫描node_modules，默认true |
| `config.scanGlobalNpm` | boolean | 否 | 是否扫描全局npm，默认false |
| `config.scanConfigDir` | boolean | 否 | 是否扫描配置目录，默认true |
| `config.maxDiscovered` | number | 否 | 最大发现数量，默认100 |
| `config.discoveryTimeoutMs` | number | 否 | 发现超时时间（毫秒），默认5000 |
| `config.mcpServerPattern` | RegExp | 否 | MCP服务器包名匹配模式 |
| `config.mcpToolPattern` | RegExp | 否 | MCP工具包名匹配模式 |

初始化内部状态：
- `_discovered` — Map，serverName → 发现信息
- `_scanning` — 是否正在扫描
- `_lastScanAt` — 上次扫描时间
- `_stats` — 统计信息（扫描次数、发现数量、按来源统计）

## 公开方法详解

### `discover()`

执行完整的发现扫描。

**返回值**：`Array<object>` — 发现的服务器列表

**行为细节**：
- 正在扫描时直接返回当前已发现列表（防重入）
- 根据`scanNodeModules`、`scanConfigDir`、`scanGlobalNpm`配置决定扫描范围
- 扫描过程中单个源出错不影响其他源（使用safeCall）
- 达到`maxDiscovered`上限时停止扫描
- 触发`discovery-complete`事件

**扫描流程**：
1. 扫描`node_modules`目录，匹配MCP包名模式
2. 扫描`.harness/config.json`中的`mcp_servers`配置
3. 扫描全局npm安装目录

### `getDiscoveredServer(name)`

获取指定发现的服务器信息。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 服务器名称 |

**返回值**：`object | null` — 服务器发现信息

```javascript
{
  name: string,
  installPath: string | null,
  source: string,          // DISCOVERY_SOURCES值
  status: string,          // SERVER_STATUS值
  discoveredAt: string,    // ISO时间戳
  config: object | null,   // 已有配置
  version: string | null,  // 从package.json读取
  description: string | null,
  bin: object | null,
}
```

### `getDiscoveredServers()`

获取所有发现的服务器列表。

**返回值**：`Array<object>` — 所有发现的服务器信息数组

### `getServersBySource(source)`

按来源获取发现的服务器。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `source` | string | 是 | 发现来源，取值来自DISCOVERY_SOURCES |

**返回值**：`Array<object>` — 指定来源的服务器信息数组

### `generateConfigEntries()`

为发现的服务器生成配置条目。

**返回值**：`object` — 配置条目映射

```javascript
{
  [serverName]: {
    command: 'npx',
    args: ['-y', serverName],
    enabled: false,
  }
}
```

**行为细节**：
- 仅为状态为`DISCOVERED`或`AVAILABLE`的服务器生成配置
- 已有配置的服务器保留原配置
- 无配置的服务器生成默认npx命令配置，默认禁用

### `getStats()`

获取统计信息。

**返回值**：

```javascript
{
  totalScans: number,
  totalDiscovered: number,
  bySource: {
    [source]: number,
  },
  lastScanAt: string | null,
  discoveredCount: number,
}
```

## 内部扫描方法

### `_scanNodeModules()`

扫描项目`node_modules`目录，匹配MCP包名模式。支持作用域包（`@scope/mcp-server-*`）。

### `_scanConfigDir()`

扫描`.harness/config.json`中的`mcp_servers`配置段，读取预配置的MCP服务器。

### `_scanGlobalNpm()`

扫描全局npm安装目录，在Windows上检查`%APPDATA%\npm\node_modules`，在Unix上检查`/usr/local/lib/node_modules`和`/usr/lib/node_modules`。

### `_registerDiscovery(name, installPath, source, existingConfig)`

注册发现的服务器，自动读取package.json获取元数据。读取失败时触发`discovery-warning`事件。

## 导出常量

### DISCOVERY_SOURCES

发现来源枚举。

| 属性 | 值 | 说明 |
|------|---|------|
| `NODE_MODULES` | `'node_modules'` | 项目node_modules目录 |
| `GLOBAL_NPM` | `'global_npm'` | 全局npm安装目录 |
| `CONFIG_DIR` | `'config_dir'` | 配置目录（.harness/config.json） |
| `MANIFEST` | `'manifest'` | 清单文件 |

### SERVER_STATUS

服务器状态枚举。

| 属性 | 值 | 说明 |
|------|---|------|
| `DISCOVERED` | `'discovered'` | 已发现，尚未验证可用性 |
| `AVAILABLE` | `'available'` | 可用 |
| `UNAVAILABLE` | `'unavailable'` | 不可用 |
| `ERROR` | `'error'` | 错误状态 |

## 事件列表

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `server-discovered` | 发现新MCP服务器 | `{name, source, status}` |
| `discovery-complete` | 扫描完成 | `{totalDiscovered, scanCount}` |
| `discovery-warning` | 发现过程中出现警告 | `{name, source, warning, error}` |

## 使用示例

### 基本发现

```javascript
const { McpAutoDiscovery, DISCOVERY_SOURCES } = require('./src/runtime/infrastructure/mcp-auto-discovery');

const discovery = new McpAutoDiscovery({
  projectRoot: '/path/to/project',
  scanNodeModules: true,
  scanConfigDir: true,
  scanGlobalNpm: false,
});

// 执行发现
const servers = discovery.discover();
for (const server of servers) {
  console.log(`发现: ${server.name} (来源: ${server.source})`);
  if (server.version) {
    console.log(`  版本: ${server.version}, 描述: ${server.description}`);
  }
}
```

### 按来源查询

```javascript
const nmServers = discovery.getServersBySource(DISCOVERY_SOURCES.NODE_MODULES);
const configServers = discovery.getServersBySource(DISCOVERY_SOURCES.CONFIG_DIR);

console.log(`node_modules中发现: ${nmServers.length} 个`);
console.log(`配置目录中发现: ${configServers.length} 个`);
```

### 生成配置

```javascript
const configEntries = discovery.generateConfigEntries();
// 输出到配置文件
console.log(JSON.stringify(configEntries, null, 2));
// 示例输出:
// {
//   "mcp-server-filesystem": {
//     "command": "npx",
//     "args": ["-y", "mcp-server-filesystem"],
//     "enabled": false
//   }
// }
```

### 事件监听

```javascript
discovery.on('server-discovered', ({ name, source, status }) => {
  console.log(`新服务器发现: ${name} 来自 ${source}, 状态: ${status}`);
});

discovery.on('discovery-warning', ({ name, warning, error }) => {
  console.warn(`发现警告 [${name}]: ${warning}`, error || '');
});
```

### 自定义匹配模式

```javascript
const discovery = new McpAutoDiscovery({
  projectRoot: process.cwd(),
  mcpServerPattern: /^(@my-org\/)?mcp-server-[\w-]+$/,
  mcpToolPattern: /^(@my-org\/)?mcp-[\w-]+$/,
});
```

## 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `projectRoot` | string | `process.cwd()` | 项目根目录 |
| `scanNodeModules` | boolean | true | 是否扫描node_modules |
| `scanGlobalNpm` | boolean | false | 是否扫描全局npm |
| `scanConfigDir` | boolean | true | 是否扫描配置目录 |
| `maxDiscovered` | number | 100 | 最大发现数量 |
| `discoveryTimeoutMs` | number | 5000 | 发现超时时间（毫秒） |
| `mcpServerPattern` | RegExp | `/^(@[\w-]+\/)?mcp-server-[\w-]+$/` | MCP服务器包名模式 |
| `mcpToolPattern` | RegExp | `/^(@[\w-]+\/)?mcp-[\w-]+$/` | MCP工具包名模式 |

## 与其他模块的关系

- **依赖**：`events`（Node.js内置） — EventEmitter基类
- **依赖**：`path`（Node.js内置） — 路径处理
- **依赖**：`fs`（Node.js内置） — 文件系统操作
- **依赖**：`../../utils/shutdown-mixin.js` — 优雅关闭
- **依赖**：`../../utils/safe-execute.js` — 安全调用
- **依赖**：`../../utils/debug-logger.js` — 调试日志
- **协作**：ContextBudgetOptimizer — MCP服务器加载时检查上下文预算配额（MCP层）
- **协作**：EventBus — 通过事件总线发布发现事件
- **协作**：McpConnectionManager — 发现的服务器可注册到MCP连接管理器
- **被依赖**：SharedInfrastructure — 作为MCP发现子系统的核心组件

## 相关文档

- [模块详解-EventBus模块](模块详解-EventBus模块.md)
- [模块详解-上下文预算优化器](模块详解-上下文预算优化器.md)
- [模块详解-SkillPack技能包分发](模块详解-SkillPack技能包分发.md)
