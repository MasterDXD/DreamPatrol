---
command_id: optimize
name: 优化循环
description: 启动优化循环求解器，将AI Agent转化为通用最优化求解器
skills: [optimization-loop]
agent: domain-analyst
phase: module-development
aliases: [优化, 最优化, 迭代优化]
enforcement: recommended
production_validated: true
---

# /optimize — 优化循环求解器

启动优化循环求解器，围绕指定目标进行持续自动化优化迭代。

## 用法

```
/optimize <目标描述>
```

## 示例

- `/optimize 将模型loss降至0.01以下`
- `/optimize 提升广告ROI至3.0以上，预算≤5000元/天`
- `/optimize 优化算法参数，使精确率达到95%`

## 触发技能链

optimization-loop

## 执行流程

1. 解析优化目标和约束条件
2. 定义量化指标（方向、目标值、权重）
3. 配置迭代参数（模式、频率、收敛阈值）
4. 启动优化循环
5. 监控迭代进度，必要时人工干预
6. 收敛后输出最优结果和优化轨迹

## 交付物

- 优化目标与量化指标定义
- 迭代优化轨迹日志（MD格式）
- 最优结果与收敛分析报告
