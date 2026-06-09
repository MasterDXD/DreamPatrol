---
command_id: security-review
name: 安全审查
description: 对代码进行安全审计，发现潜在安全漏洞
skills: [security-audit]
agent: security-reviewer
phase: module-development
aliases: [/sr, /安全审查, /security]
enforcement: strict
---

# /security-review — 安全审查

## 使用场景
- 上线前的安全审查
- 检查是否存在安全漏洞
- 验证安全合规性

## 执行流程
1. 激活 security-audit Skill — 执行安全审计
2. 生成安全审查报告

## 交付物
- 安全审查报告
- 漏洞清单（按风险等级分级）
- 修复建议
