# 模块详解 - MoE门控路由器 (MoeGatingRouter)

## 模块概述

MoE（Mixture of Experts）统一门控路由器是 Harness 框架的核心路由基础设施，将项目中分散的多种路由机制统一为 MoE 范式。在传统 MoE 中，门控网络根据输入特征选择性地激活少量专家；在 Harness 中，"专家"对应各类路由目标（Agent、技能、模型、协作模式），"门控"对应基于任务特征的动态选择逻辑。

MoE 门控路由器通过统一的门控评分、Top-K 稀疏激活、负载均衡和共享专家机制，实现了以下目标：

- **统一路由范式**：将 Agent 路由、技能路由、模型选择、协作模式选择纳入同一门控框架
- **稀疏激活**：每次仅激活最相关的 K 个专家，降低资源消耗
- **负载均衡**：通过辅助损失防止路由崩塌，确保专家利用率均衡
- **共享专家**：始终激活的通用专家处理跨领域问题
- **学习型门控**：根据历史执行效果动态调整门控分数

---

## 与现有模块的映射关系

MoE 门控路由器并非全新模块，而是对现有路由机制的统一抽象和增强。以下是 MoE 概念与现有模块的映射：

| MoE 概念 | 现有模块 | 映射说明 |
|----------|---------|---------|
| Agent 专家路由 | `MultiAgentRouter` | 根据任务亲和度选择最合适的 Agent，对应 MoE 中的专家选择 |
| 技能专家路由 | `SkillRouter` | 根据用户意图匹配最优技能，对应 MoE 中的技能专家选择 |
| 模型专家路由 | `ModelSelector` | 根据任务复杂度选择模型，对应 MoE 中的模型专家选择 |
| 协作模式路由 | `CollaborationModeRouter` | 根据任务特征选择协作模式（bagging/boosting/stacking），对应 MoE 中的策略路由 |
| 专家组合策略 | `EnsembleOrchestrator` | 多专家结果的融合编排，对应 MoE 中的专家输出组合 |
| 稀疏激活 | `SkillReducer` | Top-K 选择和技能精简，对应 MoE 中的稀疏激活机制 |
| 负载均衡 | `DeepeningLoadBalancer` | 深化推理中的负载分配，对应 MoE 中的负载均衡机制 |

---

## MoE 核心概念在项目中的实现

### 1. 门控网络 → `MoeGatingRouter.route()`

门控网络是 MoE 的核心组件，负责计算每个专家的激活概率。在 Harness 中，`MoeGatingRouter.route()` 方法实现了统一的门控逻辑：

- **输入**：任务特征向量（包括任务类型、复杂度、阶段上下文等）
- **输出**：专家激活分数列表 + 选中的 Top-K 专家
- **门控评分**：基于任务-专家亲和度、历史执行效果、当前负载综合计算

```
gate_score = affinity_score × (1 - load_penalty) × decayed_history_score
```

### 2. Top-K 稀疏激活 → `_topK` 选择

稀疏激活是 MoE 的关键特性，每次仅激活分数最高的 K 个专家：

- **配置项**：`moe_config.topK`（默认值：2）
- **最低阈值**：`moe_config.minGateScore`（默认值：0.1），低于此分数的专家不会被激活
- **实现**：对门控分数排序后取 Top-K，同时过滤低于 `minGateScore` 的候选

```
activated_experts = topK(gate_scores, K=topK) ∩ {score ≥ minGateScore}
```

### 3. 负载均衡 → 辅助损失计算

负载均衡通过辅助损失（Auxiliary Loss）防止路由崩塌——即门控网络持续选择少数专家导致其他专家闲置的现象：

- **配置项**：`moe_config.auxiliaryLossWeight`（默认值：0.01）
- **计算方式**：`MoeGatingRouter._computeAuxiliaryLoss()`
- **公式**：辅助损失 = 变异系数(CV) × auxiliaryLossWeight，其中 CV 为专家负载分布的变异系数
- **效果**：辅助损失越高，门控网络越倾向于均匀分配任务

```
auxiliary_loss = CV(expert_loads) × auxiliaryLossWeight
total_loss = task_loss + auxiliary_loss
```

### 4. 共享专家 → `isShared` 标记

共享专家是始终激活的通用专家，处理跨领域的通用问题：

- **配置项**：`moe_config.enableSharedExperts`（默认值：true）
- **标记方式**：专家注册时通过 `isShared: true` 标记
- **行为**：共享专家不参与 Top-K 选择，而是始终被激活
- **典型共享专家**：通用技能（如 brainstorming、verification-before-completion）

### 5. 学习型门控 → `updateExpertScore()`

学习型门控根据历史执行效果动态调整门控分数，实现专家选择的持续优化：

- **配置项**：`moe_config.gateDecayFactor`（默认值：0.95），模拟遗忘的衰减因子
- **更新方式**：`MoeGatingRouter.updateExpertScore(expertId, scoreDelta)`
- **衰减机制**：每次路由前，历史分数乘以 `gateDecayFactor`，使近期效果权重更高
- **学习信号**：任务完成后的质量评分作为学习信号

```
decayed_score = historical_score × gateDecayFactor + new_score × (1 - gateDecayFactor)
```

---

## API 参考

### `MoeGatingRouter`

统一的 MoE 门控路由器，整合所有路由决策。

#### 构造函数

```javascript
new MoeGatingRouter(config)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `config` | MoeConfig | MoE 配置对象，对应 `config.json` 中的 `moe_config` |

#### 核心方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `route` | `route(taskFeatures) → RoutingResult` | 根据任务特征执行门控路由，返回选中的专家列表和激活分数 |
| `registerExpert` | `registerExpert(expert) → void` | 注册新专家到路由器 |
| `updateExpertScore` | `updateExpertScore(expertId, scoreDelta) → void` | 更新专家的门控分数（学习型门控） |
| `updateExpertLoad` | `updateExpertLoad(expertId, loadDelta) → void` | 更新专家当前负载 |
| `_topK` | `_topK(scores, K) → Expert[]` | 选择分数最高的 K 个专家 |
| `_computeAuxiliaryLoss` | `_computeAuxiliaryLoss() → number` | 计算负载均衡辅助损失 |
| `_enableSharedExperts` | `_enableSharedExperts() → Expert[]` | 获取所有共享专家列表 |

#### 类型定义

```typescript
interface RoutingResult {
  activatedExperts: Expert[];      // 激活的专家列表
  gateScores: Map<string, number>; // 所有专家的门控分数
  auxiliaryLoss: number;           // 本轮辅助损失值
}

interface Expert {
  id: string;                      // 专家唯一标识
  type: 'agent' | 'skill' | 'model' | 'collaboration_mode';
  isShared: boolean;               // 是否为共享专家
  gateScore: number;               // 当前门控分数
  currentLoad: number;             // 当前负载
}
```

---

## 配置选项

MoE 门控路由器的配置位于 `config.json` 的 `moe_config` 字段：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用 MoE 统一门控路由 |
| `topK` | number | `2` | 每次路由激活的专家数量 |
| `minGateScore` | number | `0.1` | 最低门控分数阈值，低于此值的专家不会被激活 |
| `auxiliaryLossWeight` | number | `0.01` | 负载均衡辅助损失权重 |
| `gateDecayFactor` | number | `0.95` | 门控分数衰减因子（模拟遗忘） |
| `enableSharedExperts` | boolean | `true` | 是否启用共享专家（始终激活） |
| `enableLoadBalancing` | boolean | `true` | 是否启用负载均衡 |

> **交叉引用**：[[配置参考-Config.json#MoE门控路由配置]]

---

## 使用示例

### 基本路由

```javascript
const router = new MoeGatingRouter(config.moe_config);

// 注册专家
router.registerExpert({
  id: 'task-worker',
  type: 'agent',
  isShared: false,
  gateScore: 0.5,
  currentLoad: 0
});

router.registerExpert({
  id: 'brainstorming',
  type: 'skill',
  isShared: true,  // 共享专家，始终激活
  gateScore: 0.8,
  currentLoad: 0
});

// 执行路由
const result = router.route({
  taskType: 'code-implementation',
  complexity: 0.6,
  phase: 'module-development'
});

console.log(result.activatedExperts); // [{id: 'task-worker', ...}, {id: 'brainstorming', ...}]
console.log(result.auxiliaryLoss);    // 0.003
```

### 学习型门控更新

```javascript
// 任务完成后，根据质量评分更新门控分数
const qualityScore = 0.85;
router.updateExpertScore('task-worker', qualityScore * 0.1);

// 下次路由时，task-worker 的门控分数将更高
const result = router.route(taskFeatures);
```

### 负载均衡监控

```javascript
// 更新专家负载
router.updateExpertLoad('task-worker', 1);  // 增加1个任务
router.updateExpertLoad('domain-analyst', 0); // 空闲

// 辅助损失会自动计算，引导路由器选择负载较低的专家
const loss = router._computeAuxiliaryLoss();
console.log(loss); // 负载越不均衡，辅助损失越高
```

### 禁用共享专家

```json
{
  "moe_config": {
    "enabled": true,
    "topK": 2,
    "enableSharedExperts": false
  }
}
```

当 `enableSharedExperts` 为 `false` 时，所有专家（包括标记为 `isShared` 的）都参与 Top-K 选择，不再有始终激活的专家。

---

> **交叉引用**：[[模块详解-MultiAgentRouter多Agent路由器]] · [[模块详解-SkillRouter模块]] · [[模块详解-CollaborationModeRouter模块]] · [[模块详解-DeepeningOrchestrator模块]] · [[配置参考-Config.json#MoE门控路由配置]] · [[guidelines/统一语言术语表#MoE域]]
