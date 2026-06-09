---
command_id: cli
name: 软件操控
description: 通过CLI-Anything将任意软件转化为AI可直接调用的CLI工具，实现专业软件的程序化操控
skills: [cli-anything]
agent: task-worker
phase: module-development
aliases: [/软件, /software]
enforcement: optional
---

# /cli — 软件操控

## 使用场景
- 使用专业软件完成任务（图像编辑、3D渲染、文档生成等）
- 浏览和安装CLI-Anything预生成的CLI工具
- 为新软件自动生成Agent-Native CLI接口
- 批量自动化软件操作
- 优化和验证已有CLI工具

## 前置条件
- Python 3.10+已安装
- CLI-Hub已安装（pip install cli-anything-hub）
- 目标软件已安装在本地系统
- CLI-Anything MCP服务器已启用（config.json中mcp_servers.cli-anything.enabled=true）

## 执行流程
1. 激活 cli-anything Skill — 检查Python和CLI-Hub环境
2. 发现可用CLI工具（cli-hub list/search）
3. 安装所需CLI（cli-hub install）
4. 执行软件操作（cli-anything-<name> <command>）
5. 验证操作结果并记录证据

## 子命令
| 命令 | 说明 |
|------|------|
| `/cli list` | 浏览CLI-Hub可用工具 |
| `/cli search <query>` | 搜索CLI工具 |
| `/cli install <name>` | 安装CLI工具 |
| `/cli run <name> <command>` | 执行CLI命令 |
| `/cli build <source>` | 为新软件生成CLI |
| `/cli refine <source>` | 优化已有CLI |
| `/cli validate <source>` | 验证CLI质量 |

## 交付物
- 安装的CLI工具
- 软件处理输出（图像/文档/3D模型等）
- 操作证据记录

## 权限说明
- 执行Agent：task-worker（默认）、domain-analyst、team-lead、devops-engineer
- RBAC级别：optional（可选执行，不强制要求）
- 工具权限：需config.json中agent_permissions授予cli_anything工具

## 故障排除
| 问题 | 解决方案 |
|------|---------|
| CLI-Hub未安装 | 运行`pip install cli-anything-hub` |
| Python版本过低 | 升级到Python 3.10+ |
| CLI未找到 | 运行`cli-hub install <name>` |
| 软件调用失败 | 确认目标软件已安装 |
