---
command_id: code-simplify
name: 代码简化
description: 系统化简化代码结构，消除冗余和复杂度
skills: [refactor-code]
agent: task-worker
phase: module-development
aliases: [/简化, /cs, /simplify]
enforcement: recommended
---

# /code-simplify — 代码简化

## 使用场景
- 代码存在冗余逻辑或过度设计
- 函数/方法过长需要拆分
- 需要消除重复代码
- 需要降低圈复杂度

## 执行流程
1. 激活 refactor-code Skill — 系统化重构，保持行为等价

## 交付物
- 简化后的代码
- 重构前后对比说明
- 行为等价验证报告

## 因果关系
- 前置条件：代码已实现（/build 产出）
- 后续依赖：/review 可对简化结果进行审查
