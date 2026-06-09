# 模块详解：EnsembleOrchestrator（集成编排器）

> 源码路径：`src/runtime/collaboration/ensemble-orchestrator.js` | 版本：2.73.4

## 概述

EnsembleOrchestrator 实现三种集成学习模式：Bagging（并行求稳）、Boosting（串行纠错）、Stacking（元学习）。根据任务特征自动选择集成模式，支持早停策略和质量阈值收敛检测。

## 核心功能

### 三种集成模式

| 模式 | 策略 | 特点 |
|------|------|------|
| **Bagging** | Bootstrap 采样 + 多数投票 | 并行执行，降低方差 |
| **Boosting** | 迭代关注前轮错误样本 | 串行纠错，降低偏差 |
| **Stacking** | 训练元模型组合基础输出 | 多层融合 |

### 自适应选择
- 根据任务特征自动选择最优集成模式
- 支持手动指定模式

### 早停与收敛
- 早停策略（`earlyStopPatience`）避免无效迭代
- 质量阈值（`qualityThreshold`）检测收敛

## 配置选项

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxRounds` | `5` | 最大迭代轮数 |
| `earlyStopPatience` | `2` | 早停耐心轮数 |
| `qualityThreshold` | `0.95` | 质量收敛阈值 |
| `bootstrapRatio` | `0.7` | Bagging 采样比例 |
| `featureSampleRatio` | `0.7` | 特征采样比例 |
| `learningRate` | `0.5` | Boosting 学习率 |

## 依赖注入

| 方法 | 说明 |
|------|------|
| `attachAgentDiversityManager(manager)` | 注入 Agent 多样性管理器 |
| `attachAgentContributionTracker(tracker)` | 注入贡献追踪器 |

## 交叉引用

- [[模块详解-AgentDiversityManager]]
- [[模块详解-AgentContributionTracker]]
- [[核心功能-多Agent协作流程]]