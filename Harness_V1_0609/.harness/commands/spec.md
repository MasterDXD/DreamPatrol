---
command_id: spec
name: 规格定义
description: 编写详细的功能规格说明书，定义接口契约和验收标准
skills: [requirement-analysis, architecture-design]
agent: domain-analyst
phase: requirement-analysis
aliases: [/规格, /sp, /specification]
enforcement: recommended
---

# /spec — 规格定义

## 使用场景
- 需要为功能编写详细的规格说明书
- 需要定义接口契约、数据模型和验收标准
- 在编码前需要明确功能边界和行为规范
- 需要将模糊需求转化为可执行的规格文档

## 执行流程
1. 激活 requirement-analysis Skill — 结构化分析需求，提取功能点
2. 激活 architecture-design Skill — 设计接口契约和数据模型

## 交付物
- 功能规格说明书（spec.md）
- 接口契约定义
- 数据模型设计
- 验收标准清单
- 任务分解（tasks.md）
- 检查清单（checklist.md）

## 规格文档结构要求
- **spec.md**: 包含功能概述、用户故事、接口定义、数据模型、非功能性需求
- **tasks.md**: 将规格分解为可执行的开发任务，含优先级和依赖关系
- **checklist.md**: 验收检查清单，确保实现符合规格定义

## 因果关系
- 前置条件：需求已明确（可通过 /plan 产出）
- 后续依赖：/build 可基于规格文档进行实现
