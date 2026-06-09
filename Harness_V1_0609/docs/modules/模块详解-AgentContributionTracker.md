# 模块详解：AgentContributionTracker（Agent贡献追踪器）

> 源码路径：`src/runtime/collaboration/agent-contribution-tracker.js` | 版本：2.73.4

## 概述

AgentContributionTracker 负责追踪各 Agent 在协作过程中的贡献度，包括任务完成质量、响应速度、创意贡献等指标。基于历史贡献度计算信誉评分，为 EnsembleOrchestrator 的权重分配提供依据。

## 核心功能

### 贡献度指标
- 任务完成质量评分
- 响应时间追踪
- 创意/创新贡献度
- 协作适配度

### 信誉评分
- 基于历史贡献的加权评分
- 新 Agent 冷启动支持
- 动态信誉衰减

## 交叉引用

- [[模块详解-EnsembleOrchestrator]]
- [[模块详解-AgentDiversityManager]]