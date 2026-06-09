---
skill_id: chain-of-thought
name: 思维链推理
phase: module-development
priority: high
description: |
  结构化思维链推理引擎，融合Vibe Coding Superpowers和SequentialThinking核心能力。
  提供显式的逐步推理链输出格式，支持6种步骤类型、4级深度、回溯和自反思。
trigger: auto
trigger_conditions:
  - 复杂问题需要逐步推理
  - 用户请求"逐步分析"或"分步推理"
  - 算法开发、调试复杂代码
  - 需要可见推理过程的任务
applicable_agents: []
auto_trigger: true
depends_on: []
blocks: []
verified: true
stability: stable
---

## 目标

提供结构化思维链推理引擎，支持6种步骤类型、4级深度控制、回溯和自反思，将复杂问题的推理过程可视化为可读的Markdown文档。

## 步骤

1. 启动推理链（指定任务和深度级别）
2. 按顺序添加步骤（观察→分析→假设→验证→结论→反思）
3. 必要时回溯到之前的步骤重新推理
4. 完成推理链并生成Markdown格式输出

# 思维链推理（Chain of Thought）

融合自Vibe Coding Superpowers + SequentialThinking技能。

## 核心能力

1. **逐步推理链**：6种步骤类型（观察→分析→假设→验证→结论→反思）
2. **4级深度控制**：quick(3步)/standard(5步)/deep(8步)/intensive(12步)
3. **回溯机制**：发现错误时可回溯到之前的步骤重新推理
4. **自反思**：结论步骤自动触发推理质量评估
5. **Markdown输出**：将推理过程格式化为可读的Markdown文档

## 使用方式

### 编程接口
```javascript
const ChainOfThoughtEngine = require('./src/runtime/thought/chain-of-thought');
const engine = new ChainOfThoughtEngine({ defaultDepth: 'deep' });

const { chainId } = await engine.startChain('调试递归函数栈溢出', { depth: 'deep' });
await engine.addStep(chainId, { type: 'observe', content: '函数在n>1000时栈溢出', reasoning: '递归深度过大' });
await engine.addStep(chainId, { type: 'analyze', content: '缺少尾递归优化', reasoning: '每次递归创建新栈帧' });
await engine.addStep(chainId, { type: 'hypothesize', content: '改为迭代实现', reasoning: '迭代不依赖栈帧' });
await engine.addStep(chainId, { type: 'verify', content: '迭代版本n=10000正常', confidence: 0.9 });
const result = await engine.concludeChain(chainId, '将递归改为迭代实现解决栈溢出');
console.log(engine.formatChainAsMarkdown(chainId));
```

### 斜杠命令
`/think` — 启动思维链推理

## 配置选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| maxSteps | 20 | 单链最大步骤数 |
| maxHistoryChains | 500 | 历史链最大保留数 |
| defaultDepth | 'standard' | 默认推理深度 |
| convergenceThreshold | 0.85 | 收敛阈值 |
| enableSelfReflection | true | 启用自反思 |
| enableBacktracking | true | 启用回溯 |

## 事件

| 事件 | 触发时机 | 数据 |
|------|----------|------|
| chain-started | 推理链启动 | { chainId, task, depth } |
| step-added | 添加步骤 | { chainId, step } |
| chain-backtracked | 回溯 | { chainId, toStepIndex } |
| chain-completed | 推理链完成 | { chainId, convergenceScore } |

## 验收标准
- [ ] 推理链包含至少3个步骤
- [ ] 步骤类型正确（observe/analyze/hypothesize/verify/conclude/reflect）
- [ ] 回溯机制可用（enableBacktracking=true时）
- [ ] 自反思在结论步骤自动触发

## 常见问题
- **Q: 推理链太长怎么办？**
  A: 调整maxSteps限制（默认20），或使用较浅的depth（quick=3步/standard=5步）
- **Q: 回溯后之前的步骤怎么处理？**
  A: 回溯到指定步骤索引，该步骤之后的步骤被标记为回溯状态
