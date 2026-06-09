---
skill_id: hermes-rl
name: Hermes RL训练管线
phase: module-development
priority: 2
enforcement: optional
description: |
  通过Hermes RL MCP服务器集成强化学习训练管线，支持：
  - 三进程架构：Atropos轨迹服务器 + Tinker训练服务 + WandB实验追踪
  - 从Harness会话中收集轨迹数据用于RL训练
  - 奖励函数设计与迭代优化
  - 训练运行管理（启动、监控、停止、结果分析）
  - 安全约束：SelfEvolutionGovernor审批、训练超时、KL散度限制
trigger: auto
trigger_conditions:
  - 用户要求训练或优化AI Agent策略模型
  - 需要从Harness会话中收集轨迹用于强化学习
  - 任务涉及奖励函数设计或RL环境配置
  - 需要监控或分析RL训练运行
  - 用户使用/rl斜杠命令
prerequisites:
  - Python 3.11+已安装
  - hermes-rl MCP服务器已配置（config.json中mcp_servers.hermes-rl）
  - Atropos轨迹服务器已安装（或通过hermes-rl MCP间接使用）
  - Tinker训练服务已安装（或通过hermes-rl MCP间接使用）
  - GPU可选（CPU训练较慢但可运行）
applicable_agents: [domain-analyst, team-lead]
auto_trigger: true
tools_used:
  - rl-training-pipeline
  - mcp:hermes-rl
slash_command: /rl
evidence:
  required: true
  types:
    - training_completed
    - metrics_improved
    - model_deployed
verified: true
stability: beta
---

## 目标

通过Hermes RL MCP服务器集成强化学习训练管线，从Harness会话中收集轨迹数据，设计奖励函数，训练和优化AI Agent策略模型，支持SelfEvolutionGovernor安全审批。

## 步骤

1. Discover（发现可用RL环境）
2. Configure（配置训练：算法、超参数、奖励函数、KL散度约束）
3. Train（启动训练，从Harness会话收集轨迹数据）
4. Monitor（监控进度：奖励曲线、KL散度、策略熵）
5. Results（分析结果、对比历史运行、推理测试）

# Hermes RL训练管线技能

## 概述
本技能通过Hermes RL MCP服务器，将Harness Agent的能力扩展到强化学习训练领域。基于Anthropic的RL训练框架，支持从Harness会话中收集轨迹数据、设计奖励函数、配置训练运行、监控训练进度和分析训练结果。

## 三进程架构

### Atropos（轨迹服务器）
- 轨迹收集、存储和管理
- 支持从Harness会话中自动提取Agent交互轨迹
- 轨迹格式：observation → action → reward → next_observation
- 提供轨迹回放和采样接口

### Tinker（训练服务）
- 基于收集轨迹的RL策略训练
- 支持PPO、DPO、GRPO等训练算法
- 训练配置管理（超参数、奖励函数、环境设置）
- 检查点保存与恢复

### WandB（实验追踪）
- 训练指标实时可视化
- 实验对比和超参数搜索
- 训练曲线、奖励分布、KL散度监控
- 模型版本管理和制品追踪

## 工具参考（10个工具）

| 工具 | 用途 | 阶段 |
|------|------|------|
| `list_envs` | 列出可用RL环境 | Discover |
| `select_env` | 选择目标环境 | Discover |
| `get_config` | 获取当前训练配置 | Configure |
| `edit_config` | 编辑训练配置（超参数、奖励函数） | Configure |
| `start` | 启动训练运行 | Train |
| `status` | 查询训练状态 | Monitor |
| `stop` | 停止训练运行 | Monitor |
| `results` | 获取训练结果和指标 | Results |
| `list_runs` | 列出历史训练运行 | Results |
| `inference` | 使用训练模型进行推理 | Results |

## 五步工作流

### 1. Discover（发现环境）
- 调用`list_envs`获取可用RL环境列表
- 评估环境与当前任务的适配度
- 调用`select_env`选择目标环境
- 确认环境依赖和资源需求

### 2. Configure（配置训练）
- 调用`get_config`获取当前默认配置
- 设计奖励函数（见奖励函数设计指南）
- 调用`edit_config`设置：
  - 训练算法（PPO/DPO/GRPO）
  - 超参数（学习率、批次大小、训练轮数）
  - 奖励函数定义
  - KL散度约束
  - 训练超时设置

### 3. Train（执行训练）
- 调用`start`启动训练运行
- 从Harness会话收集轨迹数据（见轨迹收集流程）
- 训练过程中自动保存检查点
- 异常时自动停止并保留检查点

### 4. Monitor（监控进度）
- 调用`status`查询实时训练状态
- 通过Dashboard API端点监控：
  - `GET /api/rl/status` — RL管线状态（模式、活跃运行、统计）
  - `GET /api/rl/environments` — 可用RL环境列表
  - `GET /api/rl/runs` — 训练运行列表（支持状态过滤）
  - `GET /api/rl/runs/:runId` — 特定运行详情和指标
- 监控关键指标：奖励曲线、KL散度、策略熵
- 触发停止条件时调用`stop`

### 5. Results（分析结果）
- 调用`results`获取训练结果
- 调用`list_runs`对比历史运行
- 评估指标改进情况
- 调用`inference`测试训练模型
- 满足部署条件时申请SelfEvolutionGovernor审批

## 轨迹收集（从Harness会话）

### 自动收集流程
1. 在Harness会话中启用轨迹记录
2. Agent每次工具调用和决策自动记录为轨迹步骤
3. 轨迹格式转换：Harness决策 → Atropos轨迹格式
4. 轨迹上传至Atropos轨迹服务器

### 轨迹数据结构
```
trajectory = {
  session_id: string,
  agent_id: string,
  steps: [
    {
      observation: { context, task_state, available_tools },
      action: { tool_name, tool_args, reasoning },
      reward: number,
      next_observation: { updated_context, task_state }
    }
  ],
  metadata: { phase, task_type, outcome }
}
```

### 奖励信号来源
- 任务完成度（verification-before-completion结果）
- 代码质量评分（QualityScorer输出）
- 测试覆盖率（TDDGate覆盖率数据）
- 人工反馈（HumanApprovalGate决策）

## 奖励函数设计指南

### 设计原则
1. **可量化**：奖励信号必须可数值化，避免模糊定义
2. **可分解**：复杂奖励分解为多个子奖励加权组合
3. **可校准**：通过基线运行校准奖励尺度
4. **抗博弈**：防止奖励博弈（reward hacking），加入KL散度约束

### 推荐奖励结构
```
total_reward = w1 * task_completion
             + w2 * code_quality
             + w3 * test_coverage
             + w4 * efficiency
             - w5 * kl_divergence_penalty
```

### 权重调优策略
- 初始权重：task_completion=0.4, code_quality=0.3, test_coverage=0.2, efficiency=0.1
- 根据训练曲线动态调整
- 使用WandB超参数搜索优化权重

## 安全约束

### SelfEvolutionGovernor审批
- 模型部署前必须通过SelfEvolutionGovernor审批
- 审批条件：训练指标达标、KL散度在限制内、无奖励博弈迹象
- 审批失败时回滚到上一稳定检查点

### 训练超时
- 默认训练超时：60分钟
- 超时后自动保存检查点并停止
- 可通过`edit_config`调整超时设置

### KL散度限制
- 默认KL散度上限：0.1
- 超过限制时自动降低学习率
- 持续超限时停止训练并告警

### 其他安全措施
- 训练数据脱敏：轨迹中不包含敏感信息
- 模型输出过滤：推理结果经过安全审查
- 资源限制：GPU内存使用上限、磁盘空间检查

## 证据要求

### training_completed
- 训练运行完成（状态为completed或stopped）
- 最终检查点已保存
- 训练日志已记录

### metrics_improved
- 关键指标（奖励、成功率）相比基线有提升
- KL散度在限制范围内
- 无奖励博弈迹象

### model_deployed
- SelfEvolutionGovernor审批通过
- 模型已注册到模型注册表
- 推理测试通过

## Dashboard API
运行时状态可通过以下API端点查询：
- `GET /api/rl/status` — RL管线状态（模式、活跃运行ID、统计、环境数、轨迹数）
- `GET /api/rl/environments` — 可用RL环境列表
- `GET /api/rl/runs` — 训练运行列表（最多100条，支持status过滤）
- `GET /api/rl/runs/:runId` — 特定运行详情和指标

## 权限模型
- **applicable_agents**：domain-analyst、team-lead
- **RBAC执行级别**：`optional`（可选执行，不强制要求）
- **工具权限**：config.json中`agent_permissions`通过`rl_training_pipeline`工具权限控制
- **安全审查**：模型部署需通过SelfEvolutionGovernor审批

## 配置参考
```json
{
  "mcp_servers": {
    "hermes-rl": {
      "enabled": false,
      "command": "npx",
      "args": ["-y", "@anthropic-ai/hermes-rl-mcp"],
      "tools": { "include": ["*"] },
      "recommended": false,
      "requires": ["python-3.11", "gpu-optional"],
      "setup_hint": "需安装Atropos轨迹服务器和Tinker训练服务，或使用hermes-rl MCP服务器。GPU可选(CPU训练较慢)。"
    }
  }
}
```

## 验收标准
- [ ] RL训练管线启动成功
- [ ] 轨迹收集从Harness会话正常提取
- [ ] 奖励函数可量化且抗博弈
- [ ] SelfEvolutionGovernor审批在部署前触发
- [ ] KL散度在限制范围内

## 常见问题
- **Q: 没有GPU能训练吗？**
  A: 可以，CPU训练较慢但可运行。建议减少批次大小和训练轮数
- **Q: 奖励博弈怎么检测？**
  A: 监控KL散度，超过0.1上限时自动降低学习率；持续超限停止训练
