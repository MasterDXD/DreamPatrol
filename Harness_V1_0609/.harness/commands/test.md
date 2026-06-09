---
command_id: test
name: 集成测试
description: 执行集成测试，验证系统整体功能
skills: [integration-testing]
agent: quality-assurance
phase: integration-testing
aliases: [/tst, /测试, /integration-test]
enforcement: strict
---

# /test — 集成测试

## 使用场景
- 模块开发完成后的集成测试
- 验证系统整体功能
- 回归测试

## 执行流程
1. 激活 integration-testing Skill — 执行集成测试
2. 生成测试报告

## 交付物
- 测试报告
- 缺陷报告
- 覆盖率报告
