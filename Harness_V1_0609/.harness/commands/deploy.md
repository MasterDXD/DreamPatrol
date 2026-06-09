---
command_id: deploy
name: 部署上线
description: 验证并部署到目标环境
skills: [verification-before-completion, deployment]
agent: devops-engineer
phase: deployment
aliases: [/dp, /部署, /上线]
enforcement: strict
---

# /deploy — 部署上线

## 使用场景
- 部署到开发/测试/生产环境
- 发布新版本
- 上线前验证

## 执行流程
1. 激活 verification-before-completion Skill — 完成前验证
2. 激活 deployment Skill — 执行部署

## 交付物
- 部署验证报告
- 部署结果确认
- 运维手册
