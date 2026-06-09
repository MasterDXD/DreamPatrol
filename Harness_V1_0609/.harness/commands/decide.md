---
command_id: decide
name: 七层闭环决策
description: 启动七层闭环决策工作流（背景→选项→假设→反驳→标准→实验→复盘）
skills: [decision-loop]
agent: team-lead
phase: brainstorming
aliases: [/决策, /decide-loop]
enforcement: optional
---

# /decide 命令

启动七层闭环决策工作流。

## 使用方式

```
/decide [决策主题]
```

## 示例

```
/decide 是否进入东南亚市场
/decide 技术选型：微服务 vs 单体
/decide 产品定价策略
```

## 执行流程

1. **背景层**：收集业务现状、约束条件、非共识输入
2. **选项层**：生成10个不同思路，标注前提和分类
3. **假设层**：提取每个方案的关键假设
4. **反驳层**：启动反谄媚机制，魔鬼代言人攻击
5. **标准层**：设定可证伪、可量化的评价标准
6. **实验层**：设计最小可行实验
7. **复盘层**：梳理结果，更新认知，开启下一轮

## 与其他命令的关系

- `/plan` → 技术规划（六阶段流程）
- `/decide` → 战略决策（七层闭环）
- `/decide` + `/plan` → 先决策后规划
