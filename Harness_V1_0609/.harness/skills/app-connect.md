---
skill_id: app-connect
name: 应用连接器
phase: module-development
priority: high
description: |
  应用连接器目录，融合OpenHuman一键应用连接核心能力。
  提供15+预配置应用连接，支持MCP/Browser/CLI/HTTP/File五种连接类型。
trigger: auto
trigger_conditions:
  - 需要连接外部应用
  - 用户请求"连接应用"或"一键连接"
  - 需要集成第三方服务
applicable_agents: []
auto_trigger: true
depends_on: []
blocks: []
verified: true
stability: stable
---

## 目标

通过AppRegistry一键连接外部应用，支持15+预配置应用、5种连接类型（MCP/Browser/CLI/HTTP/File），实现与第三方服务的无缝集成。

## 步骤

1. 确定目标应用和连接类型
2. 通过AppRegistry建立连接（提供必要的认证凭证）
3. 验证连接状态和活跃连接
4. 使用连接执行操作（数据读写、API调用等）

# 应用连接器（App Registry）

融合自OpenHuman一键应用连接能力。

## 核心能力

1. **15+预配置应用**：Notion/GitHub/Slack/小红书/抖音等
2. **5种连接类型**：MCP/Browser/CLI/HTTP/File
3. **8个分类**：生产力/开发/通讯/数据/设计/存储/社交/AI
4. **一键连接**：基于MCPClient和BrowserUseAdapter自动路由

## 使用方式

```javascript
const AppRegistry = require('./src/runtime/infrastructure/app-registry');
const registry = new AppRegistry();

registry.listApps({ category: 'development' }); // 列出开发类应用
await registry.connect('github', { token: 'xxx' }); // 一键连接GitHub
registry.getActiveConnections(); // 查看活跃连接
```

## 斜杠命令
`/app-connect` — 应用连接操作

## 预置应用

| 应用 | 分类 | 连接类型 |
|------|------|----------|
| Notion | 生产力 | MCP |
| GitHub | 开发 | MCP |
| Slack | 通讯 | MCP |
| 小红书 | 社交 | Browser |
| 抖音 | 社交 | Browser |
| OpenAI | AI | HTTP |

## 验收标准
- [ ] 应用连接成功建立
- [ ] 连接类型正确路由（MCP/Browser/CLI/HTTP/File）
- [ ] 活跃连接状态可查询

## 常见问题
- **Q: 连接失败怎么办？**
  A: 检查目标应用是否已安装、MCP服务器是否启用、网络是否可达
- **Q: 如何添加自定义应用连接？**
  A: 通过AppRegistry注册新的应用配置，指定连接类型和参数
