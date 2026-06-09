---
command_id: section
name: Section生成
description: 按设计规范自动生成符合Token系统的Section组件
skills: [ui-skills, design-md]
agent: task-worker
phase: module-development
aliases: [/生成组件, /component]
enforcement: recommended
production_validated: true
---

# /section — Section组件生成

## 使用场景
- 需要快速生成符合设计规范的Section组件
- 需要确保组件使用正确的Design Token
- 需要生成带响应式变体的Section

## 执行流程
1. 解析用户指定的Section配置(variant/spacing/color)
2. 调用DesignSkillEngine生成组件Token
3. 输出HTML/CSS/JS完整组件代码

## 交付物
- 完整的Section组件HTML代码
- 配套CSS样式(使用CSS变量)
- 组件使用文档和Token映射表
