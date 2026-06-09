---
command_id: build
name: 构建实现
description: 基于规格文档进行TDD驱动的编码实现
skills: [tdd-implement, module-development]
agent: task-worker
phase: module-development
aliases: [/构建, /bld, /implement]
enforcement: strict
---

# /build — 构建实现

## 使用场景
- 基于规格文档进行编码实现
- 使用TDD流程开发新功能
- 需要严格遵循测试驱动的开发流程

## 执行流程
1. 激活 tdd-implement Skill — RED-GREEN-REFACTOR TDD流程
2. 激活 module-development Skill — 模块化开发（TDD门禁）

## 交付物
- 源代码实现
- 单元测试（覆盖率达标）
- 模块文档

## 因果关系
- 前置条件：规格文档已完成（/spec 产出）
- 后续依赖：/review 可对实现进行代码审查
