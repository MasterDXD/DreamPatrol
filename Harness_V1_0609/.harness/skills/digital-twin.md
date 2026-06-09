---
skill_id: digital-twin
name: 数字孪生
phase: module-development
priority: high
description: |
  数字孪生引擎，融合OpenHuman数字分身核心能力。
  建模用户行为模式、决策偏好和知识图谱，实现行为预测和个性化推荐。
trigger: auto
trigger_conditions:
  - 需要了解用户工作习惯
  - 用户请求"我的偏好"或"数字孪生"
  - 需要个性化推荐
applicable_agents: []
auto_trigger: true
depends_on: []
blocks: []
verified: true
stability: stable
---

## 目标

通过数字孪生引擎建模用户行为模式、决策偏好和知识图谱，实现行为预测和个性化推荐，让AI更懂用户的工作习惯。

## 步骤

1. 记录用户行为（编码/决策/学习/协作/偏好）
2. 积累足够数据后推断决策风格
3. 基于历史行为预测下一步操作
4. 分析工作模式（活跃时段、会话长度、休息间隔）
5. 生成完整数字孪生画像

# 数字孪生（Digital Twin Engine）

融合自OpenHuman数字分身能力。

## 核心能力

1. **行为建模**：5种行为类型（编码/决策/学习/协作/偏好）
2. **决策风格推断**：保守/平衡/激进/务实四种风格自动识别
3. **动作预测**：基于历史行为预测用户下一步操作
4. **工作模式分析**：活跃时段、会话长度、休息间隔

## 使用方式

```javascript
const DigitalTwinEngine = require('./src/runtime/user/digital-twin-engine');
const twin = new DigitalTwinEngine({ enableAutoLearning: true });

twin.recordBehavior({ type: 'coding', action: 'refactor', context: '优化性能' });
twin.getDecisionStyle(); // 返回用户决策风格
twin.predictNextAction('coding'); // 预测下一步操作
twin.getTwinProfile(); // 获取完整数字孪生画像
```

## 斜杠命令
`/digital-twin` — 数字孪生操作

## 决策风格

| 风格 | 特征 | 关键词 |
|------|------|--------|
| 保守型 | 偏好稳定方案 | stable, safe, 保守 |
| 平衡型 | 权衡利弊 | 默认风格 |
| 激进型 | 偏好新技术 | latest, cutting-edge, 最新 |
| 务实型 | 偏好简单方案 | simple, practical, 简单 |

## 验收标准
- [ ] 行为记录功能正常
- [ ] 决策风格推断结果合理
- [ ] 动作预测准确率可度量
- [ ] 数字孪生画像完整

## 常见问题
- **Q: 决策风格推断不准确？**
  A: 需要足够的行为数据积累，至少记录10次以上行为后风格推断才趋于稳定
- **Q: 动作预测准确率低？**
  A: 检查enableAutoLearning是否启用，行为数据是否足够丰富
