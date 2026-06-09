---
command_id: code-review
name: 代码审查
description: 对代码进行全面审查，检查质量、规范和潜在问题
skills: [code-review]
agent: code-reviewer
phase: module-development
aliases: [/cr, /审查, /review]
enforcement: strict
---

# /code-review — 代码审查

## 使用场景
- 提交PR前的代码审查
- 检查代码是否符合编码规范
- 发现潜在的代码质量问题

## 执行流程
1. 激活 code-review Skill — 执行代码审查
2. 生成审查报告，包含问题清单和改进建议

## 交付物
- 代码审查报告
- 问题清单（按严重程度分级）
- 改进建议
