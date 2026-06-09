# 模块详解：SkillTreeDAG（技能树有向无环图）

> 源码路径：`src/runtime/skill/skill-tree-dag.js` | 版本：2.73.4

## 概述

SkillTreeDAG 以有向无环图（DAG）结构组织 Skill 之间的依赖关系和执行顺序。支持拓扑排序、循环依赖检测和并行执行路径优化。

## 核心功能

### DAG 结构

| 特性 | 说明 |
|------|------|
| 拓扑排序 | 确定 Skill 执行顺序 |
| 循环检测 | 防止循环依赖 |
| 并行路径 | 识别可并行执行的独立节点 |

### 依赖管理
- Skill 前置依赖声明
- 后置效果追踪
- 动态依赖解析

### 执行优化
- 关键路径分析
- 并行执行调度
- 资源分配优化

## 交叉引用

- [[模块详解-PlaybookGenerator]]
- [[模块详解-MetaSkillOrchestrator元技能编排器]]
- [[模块详解-SkillRouter模块]]