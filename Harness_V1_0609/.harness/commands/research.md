---
command_id: research
name: AI自主调研
description: AI自主调研模式 — 调研最佳实践、技术方案、代码示例
skills: [ai-research, source-driven-development]
agent: domain-analyst
phase: brainstorming
aliases: [/调研, /研究, /investigate]
enforcement: recommended
production_validated: true
---

# /research — AI自主调研

## 使用场景
- 遇到实现细节不确定的技术问题
- 需要进行技术选型或方案对比
- 需要查找最佳实践和代码示例
- 对某个API或库的用法不熟悉
- 需要验证技术假设的可行性

## 执行流程
1. 激活 ai-research Skill — 识别不确定点
2. 制定调研计划 — 确定搜索策略和对比维度
3. 执行调研 — 搜索外部资源 + 查找代码库模式
4. 生成调研报告 — 包含发现、推荐方案、代码示例
5. 交叉验证 — 与 source-driven-development 验证调研结果

## 交付物
- 结构化调研报告（含发现、推荐方案、备选方案、代码示例、参考资料）
- 方案对比矩阵
- 推荐方案的代码示例

## 权限说明
- 执行Agent：domain-analyst（默认）、task-worker、team-lead、planner
- RBAC级别：recommended（推荐执行，不强制要求）
- 工具权限：需config.json中agent_permissions授予web_search和web_interact工具
