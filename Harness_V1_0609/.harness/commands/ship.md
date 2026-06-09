---
command_id: ship
name: 发布上线
description: 验证并发布到生产环境，完成交付闭环
skills: [verification-before-completion, deployment]
agent: devops-engineer
phase: deployment
aliases: [/发布, /sh, /release]
enforcement: strict
---

# /ship — 发布上线

## 使用场景
- 代码审查通过后发布到生产环境
- 版本发布和上线部署
- 交付前的最终验证

## 执行流程
1. 激活 verification-before-completion Skill — 完成前验证（强制证据）
2. 激活 deployment Skill — 执行部署上线

## 交付物
- 验证报告（含证据）
- 部署结果确认
- 运维手册
- 变更日志

## 因果关系
- 前置条件：代码审查通过（/review 产出）
- 后续依赖：无（交付闭环终点）
