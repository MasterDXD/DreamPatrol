---
skill_id: browser-use
name: BrowserUse浏览器自动化
phase: module-development
priority: 2
enforcement: optional
description: |
  通过BrowserUse适配器实现AI Agent对浏览器的直接控制，支持：
  - 双模式架构：Direct CDP直连模式与MCP协议模式自动切换
  - 网页导航、元素交互、数据提取、截图捕获
  - Chrome DevTools Protocol (CDP) 原生集成
  - 自愈工作流：连接断开时自动重连与状态恢复
  - 安全约束：同源策略、URL白名单验证、速率限制
trigger: auto
trigger_conditions:
  - 用户要求自动化浏览器操作
  - 任务涉及网页数据提取或表单填写
  - 需要对网页进行截图验证
  - 需要通过CDP直接控制Chrome浏览器
  - OpenCLI不适用时（需要更精细的浏览器控制）
prerequisites:
  - Chrome浏览器已安装并启用远程调试（--remote-debugging-port=9222）
  - BrowserUse MCP服务器已配置（config.json中mcp_servers.browser-use）
  - 或CDP客户端已初始化（Direct模式）
applicable_agents: [task-worker, domain-analyst, team-lead]
auto_trigger: true
tools_used:
  - browser-use-adapter
  - mcp:browser-use
slash_command: /browser
evidence:
  required: true
  types:
    - screenshot_captured
    - action_completed
    - data_extracted
verified: true
stability: beta
---

## 目标

通过BrowserUse适配器实现AI Agent对浏览器的直接控制，支持双模式架构（Direct CDP/MCP协议）、网页导航、元素交互、数据提取和截图验证，具备自愈工作流和安全约束。

## 步骤

1. 环境检查（验证CDP/MCP连接状态，确定运行模式）
2. 执行浏览器操作（导航、点击、输入、提取、截图）
3. 结果验证（截图确认、数据格式校验）
4. 证据收集（截图、操作记录、数据摘要）

# BrowserUse浏览器自动化技能

## 概述
本技能通过BrowserUse适配器，将Harness Agent的能力扩展到浏览器自动化领域。支持双模式架构（Direct CDP / MCP协议），Agent可根据环境自动选择最优模式，实现网页导航、元素交互、数据提取和截图验证等操作。

## 双模式架构

### Direct模式（CDP直连）
- 通过Chrome DevTools Protocol直接连接浏览器
- 低延迟、高精度控制
- 需要Chrome启用远程调试端口（默认9222）
- 适用于需要精细控制的场景

### MCP模式（协议中转）
- 通过@anthropic-ai/browser-use-mcp服务器
- 标准MCP协议通信
- 无需直接CDP访问
- 适用于远程或沙箱环境

### 模式选择逻辑
1. 检测CDP客户端是否可用且已连接 → 使用Direct模式
2. 检测BrowserUse MCP服务器是否已启用 → 使用MCP模式
3. 两者均不可用 → 返回错误，提示配置要求

## 自愈工作流

### 连接恢复
1. 检测CDP连接断开（WebSocket close/error事件）
2. 自动重试连接（指数退避，最多3次）
3. 重连成功后恢复之前的页面上下文
4. 重连失败后降级到MCP模式（如可用）

### 操作重试
1. 元素交互失败时自动重试（最多2次）
2. 页面加载超时时自动刷新
3. 截图失败时重新聚焦目标标签页

## 安全约束

### 同源策略
- 跨域请求需显式确认
- 敏感域名（银行、支付）需人工审批门
- Cookie和认证信息不跨域传递

### URL验证
- 仅允许http/https协议
- 阻止访问内网地址（127.0.0.1/localhost需白名单）
- URL长度限制（最大2048字符）

### 速率限制
- 单Agent每分钟最多30次操作
- 单页面最多10次连续操作后需暂停
- 截图缓存上限200张，超出自动淘汰最旧

## Dashboard API
运行时状态可通过以下API端点查询：
- `GET /api/browser-use/status` — BrowserUse适配器状态（模式、连接、当前URL、统计）
- `GET /api/browser-use/cdp-status` — CDP客户端连接状态（连接、目标信息）
- `GET /api/browser-use/screenshots` — 截图缓存列表（仅标签和时间戳，不含base64数据）

## 工作流程

### 1. 环境检查
- 验证BrowserUse MCP服务器是否已连接（可通过`/api/browser-use/status`端点检查）
- 验证CDP客户端是否可用（可通过`/api/browser-use/cdp-status`端点检查）
- 确定当前运行模式（Direct/MCP）

### 2. 操作执行
- 导航：`browser_navigate` → 目标URL
- 点击：`browser_click` → CSS选择器或坐标
- 输入：`browser_type` → 目标元素 + 文本内容
- 提取：`browser_extract` → 数据选择器
- 截图：`browser_screenshot` → 全页或区域

### 3. 结果验证
- 操作完成后自动截图验证
- 数据提取结果格式校验
- 异常状态自动触发自愈流程

### 4. 证据收集
- 每次关键操作截图保存（screenshot_captured）
- 操作结果记录（action_completed）
- 提取数据摘要（data_extracted）

## 权限模型
- **applicable_agents**：task-worker、domain-analyst、team-lead
- **RBAC执行级别**：`optional`（可选执行，不强制要求）
- **工具权限**：config.json中`agent_permissions`通过`browser_use`工具权限控制
- **安全审查**：敏感操作需通过RiskApprovalGate审批

## 配置参考
```json
{
  "mcp_servers": {
    "browser-use": {
      "enabled": false,
      "command": "npx",
      "args": ["-y", "@anthropic-ai/browser-use-mcp"],
      "tools": { "include": ["*"] },
      "recommended": true,
      "requires": ["chrome-remote-debugging"],
      "setup_hint": "需启用Chrome远程调试(--remote-debugging-port=9222)并安装browser-use MCP服务器"
    }
  }
}
```

## 验收标准
- [ ] 浏览器连接成功（Direct或MCP模式）
- [ ] 导航、点击、输入、提取操作正常
- [ ] 截图功能可用
- [ ] 自愈工作流在连接断开时触发

## 常见问题
- **Q: CDP连接失败？**
  A: 确认Chrome已启用远程调试端口（--remote-debugging-port=9222）
- **Q: MCP模式和Direct模式如何选择？**
  A: 优先使用Direct模式（低延迟），不可用时自动降级到MCP模式
