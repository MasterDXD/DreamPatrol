---
command_id: learn
name: 触发学习
description: 触发框架从当前会话中学习和改进技能
skills: [iterative-deepening]
agent: domain-analyst
phase: module-development
aliases: [/学习, /improve]
enforcement: recommended
production_validated: true
---

# /learn — 触发学习

## 使用场景
- 会话完成后希望记录经验教训
- 手动触发技能改进循环
- 将当前会话的最佳实践固化到技能中

## 执行流程
1. 收集当前会话的用户反馈和修正记录
2. 分析可改进的技能点
3. 生成改进建议并自动应用

## 交付物
- 学习记录摘要
- 技能改进建议列表
- 已应用的改进项清单
