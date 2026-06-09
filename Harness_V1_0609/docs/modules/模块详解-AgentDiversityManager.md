# 模块详解：AgentDiversityManager（Agent多样性管理器）

> 源码路径：`src/runtime/collaboration/agent-diversity-manager.js` | 版本：2.73.4

## 概述

AgentDiversityManager 从角色、方法、错误和视角四个维度评估 Agent 团队多样性，推荐集成学习模式（Bagging/Boosting）。维护 Agent 档案（角色、能力、历史错误/成功、视角权重），基于成功率动态调整 Agent 权重，检测团队同质化风险并提供多样性改进建议。

## 核心功能

### 四维多样性评估

| 维度 | 说明 |
|------|------|
| `role_diversity` | 角色多样性评估 |
| `approach_diversity` | 方法多样性评估 |
| `error_diversity` | 错误多样性评估 |
| `perspective_diversity` | 视角多样性评估 |

### 集成学习模式推荐

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| Bagging | Bootstrap 采样 + 多数投票 | 高方差任务 |
| Boosting | 串行纠错，关注前轮错误 | 偏差修正 |
| Stacking | 元学习组合 | 多维度融合 |

### Agent 档案管理
- 维护每个 Agent 的角色、能力、历史成功/错误记录
- 基于成功率动态调整权重
- 检测团队同质化风险并提供改进建议

## 配置选项

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `diversityThreshold` | `0.3` | 多样性阈值 |
| `maxAgents` | `50` | 最大 Agent 数量 |
| `maxCapabilities` | `100` | 最大能力数 |

## 交叉引用

- [[模块详解-EnsembleOrchestrator]]
- [[模块详解-AgentContributionTracker]]
- [[核心功能-多Agent协作流程]]