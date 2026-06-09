---
command_id: web
name: 网页交互
description: 通过OpenCLI将网页和Electron应用转化为CLI命令，实现网页导航、数据提取、表单交互等操作
skills: [web-interaction]
agent: task-worker
phase: module-development
aliases: [/网页, /opencli, /browse]
enforcement: optional
---

# /web — 网页交互

## 使用场景
- 从网页提取数据
- 操作网页界面（点击、输入、导航）
- 控制Electron桌面应用
- 访问需要登录的网页内容

## 前置条件
- OpenCLI MCP服务器已启用（config.json中mcp_servers.opencli.enabled=true）
- Chrome浏览器已安装并运行
- Chrome Bridge扩展已安装
- 目标网站已在Chrome中登录

## 执行流程
1. 激活 web-interaction Skill — 检查OpenCLI环境
2. 发现可用工具和网站适配器
3. 执行网页操作（导航/提取/交互）
4. 验证操作结果并记录证据

## 交付物
- 提取的结构化数据
- 操作结果截图
- 操作证据记录

## 权限说明
- 执行Agent：task-worker（默认）、domain-analyst、team-lead、devops-engineer
- RBAC级别：optional（可选执行，不强制要求）
- 工具权限：需config.json中agent_permissions授予web_interact工具

## 故障排除
| 问题 | 解决方案 |
|------|---------|
| 命令无响应 | 检查OpenCLI MCP服务器是否已启用 |
| 连接失败 | 确认Chrome浏览器正在运行 |
| 数据提取为空 | 确认目标网站已在Chrome中登录 |
