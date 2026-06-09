---
command_id: audit
name: 审计查询
description: 查询框架运行审计日志，追踪操作记录和权限变更
skills: [security-audit]
agent: quality-assurance
phase: module-development
aliases: [/审计, /audit-log]
enforcement: recommended
production_validated: true
---

# /audit — 审计查询

## 使用场景
- 需要查看Agent操作历史记录
- 追踪文件变更和权限修改
- 合规审查和操作溯源

## 执行流程
1. 查询审计日志系统
2. 按时间/Agent/操作类型过滤
3. 生成审计报告

## 交付物
- 审计日志查询结果
- 操作时间线报告
- 异常操作标记清单
