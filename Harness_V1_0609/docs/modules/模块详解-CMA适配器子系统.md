# 模块详解 — CMA适配器子系统

> **文件路径**：`src/runtime/adapter/`
> **组件数量**：5个
> **依赖关系**：依赖基础设施子系统（debug-logger、safe-assign、bounded-map/bounded-array），被SessionManager、MemoryPipeline等上层模块可选接入
> **核心定位**：将Claude Managed Agents (CMA)云端能力通过适配器模式安全接入Harness框架，所有功能默认关闭，需显式启用

---

## 一、概述

CMA适配器子系统位于`src/runtime/adapter/`目录下，采用**适配器模式**将Anthropic Claude Managed Agents的云端能力作为可选扩展接入Harness框架。设计原则为"选择性融合"——不将CMA作为运行时依赖，仅在配置启用时激活，确保框架在无CMA连接时仍可正常运行。

### 设计原则

1. **默认关闭**：所有适配器功能默认`enabled: false`，必须通过配置显式启用
2. **适配器模式**：每个云端能力封装为独立适配器，通过`attach*`方法注入Hub
3. **优雅降级**：无API Key时自动降级为本地模式，不抛出异常
4. **防御性HTTP**：所有HTTP请求内置超时（`req.setTimeout`）、响应体大小限制（10MB）、响应流错误处理
5. **容量限制**：使用`BoundedMap`/`BoundedArray`防止内存泄漏

### 组件分类

| 分类 | 组件 | 说明 |
|------|------|------|
| 中心入口 | CMAAdapterHub | 适配器生命周期管理、配置开关、状态查询 |
| 会话备份 | CloudSessionBackup | Harness Session快照备份到CMA Session |
| 密钥存储 | VaultSecretProvider | 继承ProviderAdapterBase，实现MemoryProviderInterface |
| Outcomes同步 | CMAOutcomesBridge | DreamOutcomes双向同步 |
| 远程执行 | CMASessionProxy | 远程Agent执行代理 |

---

## 二、组件详解

### 2.1 CMAAdapterHub — 适配器中心入口

| 项目 | 说明 |
|------|------|
| 文件 | `src/runtime/adapter/cma-adapter.js` |
| 功能 | 管理所有CMA适配器模块的生命周期，提供统一的配置入口和状态查询 |
| 构造参数 | `config?: {enabled, apiKey, betaHeader, baseUrl, sessionBackup, vaultSecret, outcomesBridge, sessionProxy}` |
| 关键方法 | `initialize()`, `attachSessionBackup(backup)`, `attachVaultSecret(vault)`, `attachOutcomesBridge(bridge)`, `attachSessionProxy(proxy)`, `getSessionBackup()`, `getVaultSecret()`, `getOutcomesBridge()`, `getSessionProxy()`, `getStatus()`, `shutdown()` |
| 配置默认值 | `enabled: false, apiKey: '', betaHeader: 'managed-agents-2026-04-01', baseUrl: 'https://api.anthropic.com/v1'` |

### 2.2 CloudSessionBackup — 会话云端备份

| 项目 | 说明 |
|------|------|
| 文件 | `src/runtime/adapter/cloud-session-backup.js` |
| 继承 | `EventEmitter` |
| 功能 | 将Harness Session快照备份到CMA Session，支持自动定时备份和恢复 |
| 构造参数 | `config?: {apiKey, agentId, environmentId, autoBackupIntervalMs, maxBackupHistory, requestTimeoutMs}` |
| 关键方法 | `initialize()`, `backup(sessionId, sessionData)`, `restore(sessionId)`, `startAutoBackup(sessionId, getSessionData)`, `stopAutoBackup(sessionId)` |
| 事件 | `backup-success`, `backup-failed`, `restore-success`, `restore-failed` |
| 统计 | `stats.backups`, `stats.restores`, `stats.failures` |

### 2.3 VaultSecretProvider — 密钥安全存储

| 项目 | 说明 |
|------|------|
| 文件 | `src/runtime/adapter/vault-secret-provider.js` |
| 继承 | `ProviderAdapterBase`（实现`MemoryProviderInterface`） |
| 功能 | 将敏感信息（API Key、Token等）安全存储到CMA Vault，本地缓存加速读取 |
| 构造参数 | `config?: {apiKey, agentId, environmentId, localCacheTTL, requestTimeoutMs}` |
| 关键方法 | `connect()`, `disconnect()`, `healthCheck()`, `write({key, value})`, `recall(key)`, `delete(key)`, `getName()`, `getCapabilities()` |
| 能力 | `recall: true, write: true, userIsolation: true` |
| 统计 | `stats.writes`, `stats.reads`, `stats.cacheHits`, `stats.cacheMisses`, `stats.failures` |

### 2.4 CMAOutcomesBridge — Outcomes双向同步

| 项目 | 说明 |
|------|------|
| 文件 | `src/runtime/adapter/cma-outcomes-bridge.js` |
| 继承 | `EventEmitter` |
| 功能 | 在Harness DreamOutcomes与CMA Outcomes之间进行双向同步，支持自动定时同步 |
| 构造参数 | `config?: {apiKey, syncIntervalMs, maxHistorySize, requestTimeoutMs}` |
| 关键方法 | `initialize()`, `pushOutcome(outcome)`, `syncPending()`, `pullOutcomes()`, `startAutoSync()`, `stopAutoSync()`, `attachDreamOutcomes(dreamOutcomes)`, `attachSkillImprovementLoop(loop)` |
| 事件 | `sync-to-cma`, `sync-from-cma`, `sync-error` |
| 统计 | `stats.pushed`, `stats.pulled`, `stats.failures` |

### 2.5 CMASessionProxy — 远程Agent执行代理

| 项目 | 说明 |
|------|------|
| 文件 | `src/runtime/adapter/cma-session-proxy.js` |
| 继承 | `EventEmitter` |
| 功能 | 将任务委托给CMA云端Agent执行，提供远程计算能力 |
| 构造参数 | `config?: {apiKey, agentId, environmentId, defaultModel, requestTimeoutMs, maxActiveSessions}` |
| 关键方法 | `initialize()`, `execute(task, options?)`, `cancel(sessionId)`, `getSessionState(sessionId)` |
| 事件 | `session-created`, `session-completed`, `session-failed`, `session-cancelled` |
| 会话状态 | `pending`, `running`, `completed`, `failed`, `cancelled` |
| 统计 | `stats.created`, `stats.completed`, `stats.failed`, `stats.cancelled` |

---

## 三、配置参考

```json
{
  "cma": {
    "enabled": true,
    "apiKey": "sk-ant-...",
    "betaHeader": "managed-agents-2026-04-01",
    "baseUrl": "https://api.anthropic.com/v1",
    "sessionBackup": {
      "enabled": true,
      "autoBackupIntervalMs": 300000,
      "agentId": "agent-xxx",
      "environmentId": "env-xxx"
    },
    "vaultSecret": {
      "enabled": true,
      "localCacheTTL": 3600000
    },
    "outcomesBridge": {
      "enabled": true,
      "syncIntervalMs": 60000
    },
    "sessionProxy": {
      "enabled": true,
      "defaultModel": "claude-sonnet-4-6",
      "maxActiveSessions": 10
    }
  }
}
```

---

## 四、使用示例

```javascript
const { CMAAdapterHub } = require('./src/runtime/adapter/cma-adapter');
const { CloudSessionBackup } = require('./src/runtime/adapter/cloud-session-backup');
const { VaultSecretProvider } = require('./src/runtime/adapter/vault-secret-provider');
const { CMAOutcomesBridge } = require('./src/runtime/adapter/cma-outcomes-bridge');
const { CMASessionProxy } = require('./src/runtime/adapter/cma-session-proxy');

// 创建Hub并初始化
const hub = new CMAAdapterHub({
  enabled: true,
  apiKey: process.env.CMA_API_KEY,
});
await hub.initialize();

// 创建并附加适配器
const backup = new CloudSessionBackup({ apiKey: process.env.CMA_API_KEY, agentId: 'my-agent' });
const vault = new VaultSecretProvider({ apiKey: process.env.CMA_API_KEY });
const bridge = new CMAOutcomesBridge({ apiKey: process.env.CMA_API_KEY });
const proxy = new CMASessionProxy({ apiKey: process.env.CMA_API_KEY, agentId: 'my-agent' });

hub.attachSessionBackup(backup);
hub.attachVaultSecret(vault);
hub.attachOutcomesBridge(bridge);
hub.attachSessionProxy(proxy);

// 使用会话备份
await backup.backup('session-1', { phase: 'coding', progress: 80 });

// 使用密钥存储
await vault.connect();
await vault.write({ key: 'api-key', value: 'sk-xxx' });

// 使用Outcomes同步
bridge.pushOutcome({ id: 'out-1', score: 0.95 });
await bridge.syncPending();

// 使用远程执行
const result = await proxy.execute('Analyze code quality', { model: 'claude-sonnet-4-6' });

// 关闭
hub.shutdown();
```

---

## 五、HTTP安全措施

所有适配器的`_request`方法均实现以下安全措施：

| 措施 | 说明 |
|------|------|
| 请求超时 | `req.setTimeout(config.requestTimeoutMs)` — 防止请求无限挂起 |
| 响应体大小限制 | `maxResponseSize = 10MB` — 防止内存溢出 |
| 响应流错误处理 | `res.on('error', reject)` — 防止响应流中断时Promise永不settle |
| Beta Header | `anthropic-beta: managed-agents-2026-04-01` — CMA API Beta标识 |

---

## 六、与框架的集成点

| 适配器 | 可接入的框架模块 | 接入方式 |
|--------|-----------------|----------|
| CloudSessionBackup | SessionManager | `sessionManager.on('phase-change', () => backup.backup(...))` |
| VaultSecretProvider | MemoryPipeline | `memoryPipeline.addProvider(vaultSecretProvider)` |
| CMAOutcomesBridge | DreamOutcomes + SkillImprovementLoop | `bridge.attachDreamOutcomes(dreamOutcomes)` |
| CMASessionProxy | SubagentExecutor | `proxy.execute(task)` 替代本地子Agent执行 |

---

## 七、测试覆盖

测试文件：`test/runtime/adapter/cma-adapter.test.js`

| 模块 | 测试数量 | 覆盖内容 |
|------|---------|----------|
| CMAAdapterHub | 7 | 创建/初始化/附加/状态/关闭 |
| CloudSessionBackup | 7 | 创建/无Key降级/备份失败/自动备份/关闭 |
| VaultSecretProvider | 7 | 名称/能力/本地缓存/空Key拒绝/关闭 |
| CMAOutcomesBridge | 7 | 创建/推送/无ID拒绝/无Key同步/自动同步/附加/关闭 |
| CMASessionProxy | 6 | 创建/无Key拒绝/初始化/未知会话/API错误/关闭 |
| **合计** | **34** | — |
