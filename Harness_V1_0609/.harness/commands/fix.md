---
command_id: fix
name: 缺陷修复
description: 修复已知缺陷，遵循TDD流程
skills: [bug-fix, verification-before-completion]
agent: task-worker
phase: module-development
aliases: [/fx, /修复, /bug-fix]
enforcement: strict
---

# /fix — 缺陷修复

## 使用场景
- 修复已知的Bug
- 处理缺陷报告
- 紧急问题修复

## 执行流程
1. 激活 bug-fix Skill — TDD流程修复缺陷
2. 激活 verification-before-completion Skill — 验证修复结果

## 交付物
- 修复代码（含失败测试先行）
- 测试通过报告
- 修复验证证据
