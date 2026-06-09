---
skill_id: mnemosyne-enhanced
name: Mnemosyne增强记忆
phase: module-development
trigger: 需要优化记忆存储质量、检索精度或解决过期事实问题时
auto_trigger: false
priority: 3
enforcement: recommended
applicable_agents: [architect, task-worker]
trigger_conditions:
  - "记忆"
  - "长期记忆"
  - "记忆存储"
  - "记忆检索"
  - "过期事实"
  - "mnemosyne"
  - "预测编码"
  - "扩散激活"
  - "情感路由"
model_tier: medium
depends_on: [claude-mem]
tags: [memory, mnemosyne, surprisal-gate, mutable-rag, affective-router, spreading-activation]
description: |
  Mnemosyne增强记忆系统 — 将4个神经科学启发的记忆算法融入MemoryPipeline：
  1. SurprisalGate（预测编码过滤）— 低信息量输入不写入长期记忆，减少40%存储噪声
  2. MutableRAG（记忆重整合）— 检索时自动更新过期事实，解决矛盾记忆累积问题
  3. AffectiveRouter（情感状态路由）— 紧急约束获得更高检索权重，公式：score = semantic×0.7 + affective×0.3
  4. SpreadingActivation（扩散激活）— 沿知识图谱边传播激活能量，发现间接关联概念
verified: true
stability: stable
---

# Skill: Mnemosyne增强记忆

## 任务目标

在现有MemoryPipeline基础上，激活Mnemosyne的4个增强模块，提升记忆存储质量和检索精度。

## 核心模块

### 1. SurprisalGate — 预测编码过滤

**原理**：大脑只永久编码预测误差，忽略已预期的内容。

**使用方式**：
```javascript
// 评估内容是否值得写入长期记忆
const result = pipeline.evaluateForStore(content, metadata);
if (result.allowed) {
  // 写入记忆
} else {
  // 跳过（惊讶度不足，信息量低）
}
```

**参数**：
- `threshold`：惊讶度阈值（默认0.3），低于此值的输入被过滤
- `historySize`：用于生成预测的历史条数（默认20）
- `cooldownMs`：相似输入的冷却时间（默认60000ms）

### 2. MutableRAG — 记忆重整合

**原理**：每次回忆时，记忆进入不稳定状态，被当前上下文重写后才重新稳定。

**使用方式**：
```javascript
// 检索时自动标记记忆为不稳定状态（recall方法已集成）
// 手动触发重整合
const result = pipeline.reconsolidate(newContent, (key, updatedEntry) => {
  memoryStore.update(key, updatedEntry);
});
```

### 3. AffectiveRouter — 情感状态路由

**原理**：状态依赖记忆——紧急约束获得更高检索权重。

**三维认知状态**：
- Valence（效价）：-1.0（消极）到 +1.0（积极）
- Arousal（唤醒）：0.0（平静）到 1.0（紧急）
- Complexity（复杂度）：0.0（简单）到 1.0（复杂）

**检索公式**：`score = semantic_similarity × 0.7 + affective_match × 0.3`

### 4. SpreadingActivation — 扩散激活

**原理**：激活一个概念时，能量沿关联边传播到相邻概念。

**使用方式**：
```javascript
// recall方法已自动集成，当知识图谱可用时自动执行扩散激活
// 结果存储在 rawResults.meta.spreadingActivation 中
```

## 执行步骤

1. **评估写入**：使用 `evaluateForStore()` 过滤低信息量输入
2. **增强检索**：`recall()` 自动应用情感重排序和扩散激活
3. **重整合**：使用 `reconsolidate()` 更新过期事实
4. **监控**：使用 `getMnemosyneStats()` 查看各模块状态

## 验收标准

- SurprisalGate 过滤低信息量输入，减少存储噪声
- MutableRAG 自动检测并更新过期事实
- AffectiveRouter 对紧急查询提升相关记忆权重
- SpreadingActivation 发现知识图谱中的间接关联

## 角色边界约束

- 本技能仅增强记忆系统，不修改业务逻辑
- SurprisalGate 的阈值调整需基于实际数据，不可随意降低
- MutableRAG 的重整合操作不可删除原始记忆，仅标记为过时

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 在现有MemoryPipeline基础上激活Mnemosyne的4个神经科学启发的增强模块（SurprisalGate预测编码过滤、MutableRAG记忆重整合、AffectiveRouter情感状态路由、SpreadingActivation扩散激活），提升记忆存储质量和检索精度。

### Q: 适用于哪些场景？
A: 适用于需要优化记忆系统的场景，包括减少低信息量存储噪声、自动更新过期事实、根据紧急程度调整检索权重、以及通过知识图谱发现间接关联概念。

### Q: 使用此Skill的前提条件是什么？
A: 需要已部署MemoryPipeline和claude-mem技能，理解四种增强模块的工作原理，并配置好知识图谱（用于SpreadingActivation）和情感状态参数（用于AffectiveRouter）。
