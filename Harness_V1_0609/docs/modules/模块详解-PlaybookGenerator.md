# 模块详解：PlaybookGenerator（剧本生成器）

> 源码路径：`src/runtime/skill/playbook-generator.js` | 版本：2.73.4

## 概述

PlaybookGenerator 基于历史成功任务自动生成标准化操作剧本（Playbook），将可复用的任务执行流程沉淀为结构化知识。支持从 Skill 执行日志提取最佳实践并参数化。

## 核心功能

### 剧本生成
- 从成功执行记录中提取模式
- 参数化通用流程
- 版本化剧本管理

### 剧本验证
- 模板有效性检查
- 参数兼容性校验

### 剧本搜索
- 基于任务描述的剧本匹配
- 相似度排序

## 交叉引用

- [[模块详解-SkillTreeDAG]]
- [[模块详解-MetaSkillOrchestrator元技能编排器]]