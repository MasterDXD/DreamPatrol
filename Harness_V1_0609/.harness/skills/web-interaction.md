---
skill_id: web-interaction
name: 网页交互
phase: module-development
priority: 2
enforcement: optional
description: |
  通过OpenCLI将网页和Electron应用转化为CLI命令，使AI Agent能够：
  - 导航网页、点击元素、输入文本、提取数据
  - 复用用户已登录的Chrome浏览器会话
  - 零Token成本获取结构化数据
  - 支持80+网站适配器（Twitter/Reddit/Bilibili/知乎/小红书等）
  - 控制Electron桌面应用（Cursor/ChatGPT/Notion等）
trigger: auto
trigger_conditions:
  - 用户要求访问网页数据
  - 用户要求操作网页界面
  - 用户要求从网站提取信息
  - 用户要求控制桌面应用
  - 任务涉及需要登录才能访问的网页内容
prerequisites:
  - OpenCLI MCP服务器已启用（config.json中mcp_servers.opencli.enabled=true）
  - Chrome浏览器已安装并运行
  - Chrome Bridge扩展已安装
  - 目标网站已在Chrome中登录
applicable_agents: [task-worker, domain-analyst, team-lead, devops-engineer]
auto_trigger: true
tools_used:
  - mcp:opencli
evidence:
  required: true
  types:
    - web_data_extracted
    - web_action_completed
    - screenshot_captured
verified: true
stability: beta
---

## 目标

通过OpenCLI将网页和Electron应用转化为CLI命令，使AI Agent能导航网页、提取数据、填写表单，复用Chrome已登录会话实现零Token成本的结构化数据获取。

## 步骤

1. 环境检查（验证OpenCLI MCP连接、Chrome Bridge状态）
2. 工具发现（opencli list查看可用适配器）
3. 执行操作（数据提取、网页导航、表单交互）
4. 结果验证（检查数据完整性、截图验证、记录操作证据）

# 网页交互技能

## 概述
本技能通过OpenCLI MCP服务器，将Harness Agent的能力扩展到网页和桌面应用领域。Agent可通过标准MCP协议调用OpenCLI提供的80+网站适配器，实现网页导航、数据提取、表单填写等操作。

## 权限模型
- **available_skills**：4个Agent（task-worker、domain-analyst、team-lead、devops-engineer）的`available_skills`和`permissions.can_execute`均包含`web-interaction`
- **RBAC执行级别**：`optional`（可选执行，不强制要求）
- **工具权限**：config.json中`agent_permissions`通过`web_interact`工具权限控制
- **quality-assurance**：不包含`web-interaction`，因为QA角色不涉及网页操作

## Dashboard API
运行时状态可通过以下API端点查询：
- `GET /api/opencli/status` — OpenCLI MCP服务器连接状态（含防御性编码）
- `GET /api/opencli/servers` — 所有MCP服务器状态摘要（仅返回connected和toolCount）

## 工作流程

### 1. 环境检查
- 验证OpenCLI MCP服务器是否已连接（可通过`/api/opencli/status`端点检查）
- 运行 `opencli doctor` 检查Chrome Bridge状态
- 确认目标网站已在Chrome中登录

### 2. 工具发现
- 运行 `opencli list` 发现可用的网站适配器
- 运行 `opencli <site> --help` 查看特定网站的命令

### 3. 执行操作
- 数据提取：`opencli <site> <command> --format json`
- 网页导航：通过MCP工具调用浏览器操作
- 表单交互：点击、输入、提交

### 4. 结果验证
- 检查返回数据的完整性
- 必要时截图验证操作结果
- 记录操作证据（web_data_extracted / web_action_completed / screenshot_captured）

## 安全约束
- 仅操作用户明确授权的网站
- 不存储或传输用户凭据
- 遵守目标网站的使用条款
- 敏感操作需用户确认
- `/api/opencli/servers`端点仅返回状态摘要，不暴露服务器配置细节

## 回滚机制
- 操作失败时自动重试（最多3次）
- 浏览器状态可通过快照恢复
- MCP连接断开时自动重连

## 故障排除
| 症状 | 可能原因 | 解决方案 |
|------|---------|---------|
| `available: false` | MCP客户端未初始化 | 检查config.json中mcp_servers配置 |
| `connected: false` | OpenCLI服务器未连接 | 确认`enabled: true`并重启服务 |
| `toolCount: 0` | Chrome Bridge未安装 | 安装Chrome Bridge扩展并重启浏览器 |
| MCP调用超时 | Chrome未运行 | 启动Chrome浏览器 |

## 验收标准
- [ ] OpenCLI MCP服务器连接成功
- [ ] 网站适配器数据提取正常
- [ ] Chrome Bridge会话复用可用
- [ ] 操作证据已记录

## 常见问题
- **Q: OpenCLI状态显示available:false？**
  A: 检查config.json中mcp_servers.opencli.enabled是否为true
- **Q: 需要登录的网站如何操作？**
  A: 先在Chrome中手动登录目标网站，OpenCLI通过Chrome Bridge复用已登录会话
