---
command_id: review
name: 代码审查
description: 多维度代码质量审查，检查规范、安全和设计合规性
skills: [code-review, security-audit]
agent: code-reviewer
phase: module-development
aliases: [/审查, /rv, /peer-review]
enforcement: strict
---

# /review — 代码审查

## 使用场景
- 代码提交前的质量审查
- 安全漏洞检测
- 设计规范合规性检查
- 代码风格和最佳实践审查

## 执行流程
1. 激活 code-review Skill — 8维度代码质量审查
2. 激活 security-audit Skill — 安全审计

## 交付物
- 代码审查报告
- 安全审计报告
- 改进建议清单

## 因果关系
- 前置条件：代码已实现（/build 产出）
- 后续依赖：/ship 可在审查通过后发布
