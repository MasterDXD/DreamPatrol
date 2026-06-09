---
skill_id: agentic-patterns
name: Agentic设计模式引擎
description: |
  实现Google《Agentic Design Patterns》8大核心模式的增强引擎，提供中间验证门控、回退路由、并发控制和反思循环
applicable_agents: [team-lead, domain-analyst, task-worker]
trigger: "auto"
auto_trigger: true
phase: [brainstorming, design, implementation, testing]
trigger_conditions:
  - "验证门控"
  - "回退路由"
  - "并发控制"
  - "反思循环"
  - "agentic"
  - "design pattern"
  - "提示链"
  - "路由"
  - "并行化"
  - "反思"
  - "工具使用"
  - "规划"
  - "多智能体"
  - "记忆管理"
priority: 85
depends_on: []
blocks: []
enforcement: optional
causal_inputs:
  - task-context
  - quality-requirements
causal_outputs:
  - validated-output
  - routing-decision
  - execution-results
  - reflection-report
verified: true
stability: beta
---

# Agentic设计模式引擎

基于Google《Agentic Design Patterns》论文的8大核心模式，结合Harness框架现有模块能力，提供增强型智能体设计模式引擎。在8大基础模式之上叠加4个增强组件（ValidationGate、FallbackRouter、ConcurrencyController、ReflectionLoop），使每个模式都具备中间验证、失败回退、并发安全和自我反思能力。

## 8大核心Agentic设计模式

### 1. 提示链（Prompt Chaining）
**定义**：将复杂任务分解为顺序执行的子步骤，前一步的输出作为后一步的输入，形成链式调用。

**项目映射**：`ChatChain` — 链式对话编排器，内置六阶段原子任务链模板，支持任务依赖解析和上下文逐级传递。

**增强**：在链的每个节点间插入 `ValidationGate`，确保中间产物质量达标后才传递到下一步。

### 2. 路由（Routing）
**定义**：根据输入特征将请求分发到不同的处理路径，实现条件分支。

**项目映射**：`SkillRouter` — 技能自动发现与路由引擎，根据任务上下文匹配最合适的Skill并激活执行。

**增强**：`FallbackRouter` 在主路由匹配失败或执行异常时，自动切换到备选路径。

### 3. 并行化（Parallelization）
**定义**：将可并行的子任务同时执行，汇总结果后继续后续流程。

**项目映射**：`ConcurrencyController` — 并发信号量控制与排队；`dispatching-parallel` 技能 — 并行子代理调度。

**增强**：`ConcurrencyController` 组件提供信号量级别的并发控制，防止资源争用和死锁。

### 4. 反思（Reflection）
**定义**：智能体对自身输出进行审查和修正，形成自我改进的闭环。

**项目映射**：`SelfReflection` — 自反思模块，对输出质量进行评估和迭代改进。

**增强**：`ReflectionLoop` 组件将反思从单次评估升级为多轮循环，直到质量收敛或达到迭代上限。

### 5. 工具使用（Tool Use）
**定义**：智能体调用外部工具扩展自身能力边界，获取信息或执行操作。

**项目映射**：`MCPClient` — 工具协议客户端；`ToolAdapter` — 工具适配器；`CommandRouter` — 斜杠命令路由。

**增强**：工具调用前后通过 `ValidationGate` 验证输入合法性和输出完整性。

### 6. 规划（Planning）
**定义**：智能体在执行前制定分步计划，按计划逐步推进，必要时调整计划。

**项目映射**：`GoalExecutor` — 目标执行器，管理目标的创建、分解、执行和收敛检测全生命周期；`PlanPersistence` — 计划持久化。

**增强**：计划执行中通过 `ReflectionLoop` 检测偏差，触发 `FallbackRouter` 切换备选方案。

### 7. 多智能体（Multi-Agent）
**定义**：多个智能体协同工作，各司其职，通过通信协调完成复杂任务。

**项目映射**：`SubagentExecutor` — 子代理执行器；`CollaborationModeRouter` — 协作模式路由；`AgentPackManager` — 代理包管理。

**增强**：多智能体间通过 `ConcurrencyController` 控制并发度，通过 `ValidationGate` 验证交接产物。

### 8. 记忆管理（Memory Management）
**定义**：智能体维护和利用长期记忆，在跨会话中保持上下文一致性。

**项目映射**：`MemoryStore` — 项目知识存储与摘要管理；`CheckpointManager` — 检查点创建与恢复；`ContextCompressionEngine` — 上下文压缩。

**增强**：记忆检索后通过 `ValidationGate` 验证相关性，记忆写入前通过 `ReflectionLoop` 评估记忆质量。

## 4个增强组件

### ValidationGate（中间验证门控）

在模式执行的关键节点插入验证门，确保中间产物满足质量要求后才允许流程继续。

**接口定义**：
```javascript
const gate = new ValidationGate({
  criteria: [
    { name: 'completeness', threshold: 0.8, validator: (output) => output.coverage >= 0.8 },
    { name: 'correctness', threshold: 0.9, validator: (output) => output.testPassRate >= 0.9 },
  ],
  onReject: 'retry' | 'fallback' | 'abort',
  maxRetries: 3,
});

const result = await gate.validate(intermediateOutput);
// result: { passed: true/false, score: 0.87, details: [...], action: 'continue' | 'retry' | 'fallback' }
```

**使用场景**：
- 提示链中每步输出传递前的质量检查
- 工具调用返回结果的完整性验证
- 多智能体交接产物的合规性检查
- 记忆检索结果的相关性验证

### FallbackRouter（回退路由）

当主路径执行失败或质量不达标时，自动切换到预定义的备选路径。

**接口定义**：
```javascript
const router = new FallbackRouter({
  routes: [
    { name: 'primary', handler: primaryHandler, priority: 1 },
    { name: 'secondary', handler: secondaryHandler, priority: 2 },
    { name: 'conservative', handler: conservativeHandler, priority: 3 },
  ],
  fallbackCondition: (result) => result.score < 0.7 || result.error,
  onFallback: (from, to) => console.log(`Fallback: ${from} → ${to}`),
});

const result = await router.execute(input);
// result: { route: 'secondary', output: ..., fallbackChain: ['primary', 'secondary'] }
```

**使用场景**：
- 路由模式中主Skill匹配失败时的备选Skill激活
- 规划模式中主方案执行受阻时的备选方案切换
- 工具使用中主工具不可用时的替代工具调用
- 反思循环中收敛失败时的策略降级

### ConcurrencyController（并发控制）

管理并行任务的并发度，提供信号量机制、优先级队列和资源隔离。

**接口定义**：
```javascript
const controller = new ConcurrencyController({
  maxConcurrency: 5,
  semaphoreTimeout: 30000,
  priorityQueue: true,
  isolation: 'task',  // 'task' | 'agent' | 'global'
});

const taskId = await controller.acquire('subtask-1', { priority: 'high' });
try {
  const result = await executeSubtask(taskId);
  return result;
} finally {
  await controller.release(taskId);
}
```

**使用场景**：
- 并行化模式中子任务的并发度限制
- 多智能体模式中代理间的资源争用控制
- 工具使用中外部API的速率限制适配
- 记忆管理中并发读写的一致性保障

### ReflectionLoop（反思循环）

将单次反思升级为多轮迭代循环，持续评估和改进输出质量直到收敛。

**接口定义**：
```javascript
const loop = new ReflectionLoop({
  maxIterations: 5,
  convergenceThreshold: 0.85,
  evaluator: async (output) => {
    const score = await evaluateQuality(output);
    return { score, feedback: '...' };
  },
  improver: async (output, feedback) => {
    return await improveOutput(output, feedback);
  },
  onConverge: (finalOutput, iterations) => console.log(`Converged after ${iterations} iterations`),
});

const result = await loop.run(initialOutput);
// result: { output: ..., iterations: 3, finalScore: 0.91, converged: true }
```

**使用场景**：
- 反思模式中从单次评估升级为多轮迭代
- 规划模式中计划偏差的检测与修正
- 提示链中关键步骤的输出精炼
- 记忆管理中记忆质量的持续优化

## 与现有模块的集成点

### ChatChain 集成
```
ChatChain 原子任务链
  ↓ 每个任务节点
  ├─ 前置: ValidationGate.validate(input)
  ├─ 执行: 原子任务逻辑
  ├─ 后置: ValidationGate.validate(output)
  └─ 失败: FallbackRouter.route(error)
```

ChatChain的六阶段模板（brainstorming → requirement-analysis → architecture-design → module-development → integration-testing → deployment）中，每个阶段转换点插入ValidationGate，阶段内任务失败时触发FallbackRouter。

### SkillRouter 集成
```
SkillRouter 匹配流程
  ├─ 主路径: 最佳匹配Skill
  ├─ 验证: ValidationGate.validate(matchScore)
  ├─ 备选: FallbackRouter → 次优Skill
  └─ 兜底: 默认处理策略
```

SkillRouter的匹配结果经过ValidationGate验证匹配度，低于阈值时FallbackRouter激活次优Skill。

### GoalExecutor 集成
```
GoalExecutor 目标执行
  ├─ 分解: 子目标生成
  ├─ 并行: ConcurrencyController 控制子目标并发
  ├─ 迭代: ReflectionLoop 检测收敛
  └─ 回退: FallbackRouter 切换备选方案
```

GoalExecutor的迭代执行循环中，ConcurrencyController控制子目标并发度，ReflectionLoop替代简单的收敛检测，FallbackRouter在停滞时切换策略。

### SelfReflection 集成
```
SelfReflection 自反思
  ├─ 单次反思 → ReflectionLoop 多轮循环
  ├─ 评估结果 → ValidationGate 质量门控
  └─ 改进失败 → FallbackRouter 策略降级
```

SelfReflection的单次评估升级为ReflectionLoop的多轮迭代，每轮结果经过ValidationGate验证，改进失败时FallbackRouter降级处理。

## 最佳实践

1. **门控粒度适中**：ValidationGate不是每行代码都需要，在关键决策点和阶段转换处插入即可。过度门控会导致延迟增加和Token浪费。
2. **回退路径预定义**：FallbackRouter的备选路径必须在设计阶段就定义好，运行时动态生成备选方案不可靠。
3. **并发度按资源设定**：ConcurrencyController的maxConcurrency应根据外部资源（API速率限制、数据库连接数）设定，而非随意配置。
4. **反思循环设上限**：ReflectionLoop必须设置maxIterations，防止无限循环。收敛阈值不宜过高（建议0.8-0.9），否则迭代次数过多。
5. **模式组合优于单一模式**：复杂任务应组合多个模式（如 Planning + Parallelization + Reflection），而非试图用单一模式解决所有问题。
6. **记忆先验证后使用**：从MemoryStore检索的记忆必须经过ValidationGate验证相关性，避免过期或无关记忆污染上下文。

## 反模式

1. **链式膨胀**：提示链超过7个节点时，中间产物失真累积严重。应拆分为多条短链，用路由模式串联。
2. **路由黑洞**：FallbackRouter所有备选路径都失败时，必须有明确的兜底策略（如转人工），不能静默失败。
3. **并发饥饿**：高优先级任务持续占用ConcurrencyController信号量，导致低优先级任务永远无法执行。应设置公平性策略或超时释放。
4. **反思死循环**：ReflectionLoop的improver无法实质改进输出，导致迭代耗尽maxIterations但未收敛。应在3轮无改善时提前终止。
5. **工具依赖**：过度依赖外部工具，工具不可用时系统完全瘫痪。每个工具调用都应有FallbackRouter的备选方案。
6. **记忆泛滥**：不加筛选地将所有中间产物写入MemoryStore，导致检索时噪音过大。写入前必须通过ValidationGate评估记忆价值。

## 目标

基于Google《Agentic Design Patterns》的8大核心设计模式，结合Harness框架现有模块能力，为每个模式叠加中间验证、失败回退、并发安全和自我反思能力。通过4个增强组件（ValidationGate、FallbackRouter、ConcurrencyController、ReflectionLoop）将理论模式转化为工程化可执行的Agent设计实践。

## 步骤

1. 分析任务的复杂度、并行度和质量要求，确定需要组合哪些设计模式
2. 在提示链节点间插入ValidationGate，确保中间产物质量达标后传递
3. 为主执行路径配置FallbackRouter，定义备选路径和降级策略
4. 对并行子任务使用ConcurrencyController控制并发度，防止资源争用
5. 对需要质量优化的输出启动ReflectionLoop，设置收敛阈值和最大迭代次数
6. 工具调用前后通过ValidationGate验证输入合法性和输出完整性
7. 记忆检索后验证相关性，记忆写入前评估质量
8. 所有备选路径均失败时触发明确的兜底策略（如转人工）

## 验收

- 复杂任务正确组合了多种设计模式（如 Planning + Parallelization + Reflection）
- ValidationGate在关键决策点和阶段转换处正确插入且通过检查
- FallbackRouter备选路径已预定义，主路径失败时能自动切换
- ConcurrencyController按外部资源限制设定并发度，无资源争用或饥饿
- ReflectionLoop在设定迭代上限内收敛，3轮无改善时提前终止
- 工具调用、记忆检索均有验证门控保护
- 所有路径耗尽时有兜底策略，无静默失败

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 实现Google《Agentic Design Patterns》中8大核心设计模式（提示链、路由、并行化、反思、工具使用、规划、多智能体、记忆管理），并通过4个增强组件（ValidationGate、FallbackRouter、ConcurrencyController、ReflectionLoop）为每个模式叠加中间验证、失败回退、并发安全和自我反思能力。

### Q: 适用于哪些场景？
A: 适用于需要构建复杂AI Agent系统的场景，特别是当任务需要多步骤链式处理、多路径路由分发、并行执行、自我反思改进、多Agent协作或跨会话记忆管理时。

### Q: 使用此Skill的前提条件是什么？
A: 需要Harness框架的运行环境，包括ChatChain、SkillRouter、GoalExecutor、SelfReflection等核心模块已部署。建议先理解8大设计模式的基本概念和适用场景。
