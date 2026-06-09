# Agentic设计模式架构分析

## 一、背景与目标

### 1.1 Google《Agentic Design Patterns》21种核心模式概述

Google于2024年发布的《Agentic Design Patterns》系统化地提出了21种智能体设计模式，分为两大层次：

**基础层（8大核心模式）**：

| 序号 | 模式 | 英文名 | 核心思想 |
|------|------|--------|----------|
| 1 | 提示链 | Prompt Chaining | 将复杂任务分解为顺序子步骤，前一步输出作为后一步输入 |
| 2 | 路由 | Routing | 根据输入特征分发到不同处理路径，实现条件分支 |
| 3 | 并行化 | Parallelization | 可并行的子任务同时执行，汇总结果后继续 |
| 4 | 反思 | Reflection | 智能体对自身输出审查和修正，形成自我改进闭环 |
| 5 | 工具使用 | Tool Use | 智能体调用外部工具扩展能力边界 |
| 6 | 规划 | Planning | 执行前制定分步计划，按计划推进，必要时调整 |
| 7 | 多智能体 | Multi-Agent | 多个智能体协同工作，各司其职 |
| 8 | 记忆管理 | Memory Management | 维护和利用长期记忆，跨会话保持上下文一致性 |

**高级层（13种增强模式）**：Tree of Thoughts、ReAct、Self-Critique、Tool Selection、Hierarchical Planning、Plan Revision、Agent Specialization、Shared State、Agent Negotiation、Memory Consolidation、Memory Decay、Cross-Project Transfer、Formal Verification。

此外，Andrew Ng提出了4类互补模式框架：**Reflection**（反思与自我修正）、**Tool Use**（工具使用与扩展）、**Planning**（规划与推理）、**Multi-Agent Collaboration**（多智能体协作），与Google 8大基础模式形成交叉验证。

### 1.2 本项目融合目标

本项目（Harness V1）已实现了Google Cloud 5种架构模式的映射（Router → SkillRouter、Generator → StructuredOutputGenerator、Orchestrator → PhaseOrchestrator/DeepeningOrchestrator、Agent → AgentRuntime/AgentLifecycleController、Pipeline → PipelineExecutor），但在Andrew Ng 4类模式维度上存在显著实现差距。

**融合目标**：补强8大基础模式的实现差距，通过4个增强组件（ValidationGate、FallbackRouter、ConcurrencyController、ReflectionLoop）为每个模式叠加质量保障、容错路由、并发安全和自我反思能力，并规划13种高级模式的兼容路径。

---

## 二、现有实现评估

### 2.1 Google Cloud 5模式映射（已有）

#### Router → SkillRouter

**映射关系**：Google Cloud Router模式的核心是"根据输入特征将请求分发到不同处理路径"，本项目 `SkillRouter`（`src/runtime/skill/skill-router.js`）实现了完整的技能自动发现与路由引擎。

**已有能力**：
- 基于关键词匹配和语义分组的技能发现（`SEMANTIC_GROUPS` 定义了20+语义组）
- 模型分级路由（`MODEL_TIERS`：small/medium/large，根据技能特征推断执行层级）
- 核心技能集与扩展技能集分离（`CORE_SKILLS` / `EXTENSION_SKILLS`）
- 否定模式识别（`NEGATION_PATTERN`），支持排除性路由
- 自动触发关键词匹配（项目级/模块级关键词）

**差距**：路由匹配失败时缺乏优雅降级，无回退路由机制。

#### Generator → StructuredOutputGenerator

**映射关系**：Google Cloud Generator模式关注"结构化输出生成"，本项目 `StructuredOutputGenerator`（`src/runtime/generation/structured-output-generator.js`）实现了模板驱动的结构化输出。

**已有能力**：
- 7种输出格式（JSON/Markdown/Table/Form/Report/Email/Plan）
- 内置模板系统（report/email/plan/json），支持自定义模板注册
- 严格验证模式（`strictValidation`）和输入净化（`sanitizeInputs`）
- 历史记录和统计追踪

**差距**：输出验证仅限于模板结构匹配，缺乏语义质量验证。

#### Orchestrator → PhaseOrchestrator / DeepeningOrchestrator

**映射关系**：Google Cloud Orchestrator模式的核心是"多步骤流程编排"，本项目有两个编排器：

- **PhaseOrchestrator**（`src/runtime/workflow/phase-orchestrator.js`）：六阶段流程编排（需求探索→需求分析→架构设计→模块开发→集成测试→部署上线），集成StateGraph状态机引擎，支持条件边、checkpoint和动态路由。
- **DeepeningOrchestrator**（`src/runtime/deepening/deepening-orchestrator.js`）：深化推理编排，迭代精化、质量评分、收敛检测，可挂载指标采集/缓存/策略插件/报告生成/收敛检测/质量评分/事件存储等子模块。

**差距**：阶段转换缺乏中间验证门控；深化推理的收敛检测与计划修订之间断裂。

#### Agent → AgentRuntime / AgentLifecycleController

**映射关系**：Google Cloud Agent模式关注"智能体生命周期管理"，本项目有两个核心模块：

- **AgentRuntime**（`src/runtime/agent/agent-runtime.js`）：8状态生命周期（created→initializing→running→paused→stopping→stopped→error→destroyed），资源分配（内存/CPU），状态转换验证，持久化到 `.harness/agents-runtime/`。
- **AgentLifecycleController**（`src/runtime/agent/agent-lifecycle-controller.js`）：更细粒度的生命周期控制。

**差距**：28种Agent已定义（`.harness/agents/` 目录下），但缺乏标准化的Agent间通信协议。

#### Pipeline → PipelineExecutor

**映射关系**：Google Cloud Pipeline模式的核心是"多步骤管道执行"，本项目 `PipelineExecutor`（`src/runtime/workflow/pipeline-executor.js`）实现了完整的管道执行流程。

**已有能力**：
- 完整管道：命令解析→意图解析→技能匹配→前置检查→协作模式选择→超时执行→后置验证
- 集成可编程钩子执行器、安全链和提示词构建器
- 工具调用安全检查（`_runSecurityCheck`）

**差距**：管道步骤间缺乏质量门控，失败步骤缺乏自动回退。

### 2.2 Andrew Ng 4类模式评估（新增）

#### Reflection：SelfReflection已实现但反思不驱动修订循环

**现有实现**：`SelfReflection`（`src/runtime/quality/self-reflection.js`）已实现五维度反思（边界条件/一致性/安全性/性能/完整性）和证伪维度反思。

**具体能力**：
- 5种反思模板（code/design/test/documentation/decision），decision模板含证伪与反谄媚检查
- 质量趋势判定（improving/stable/degrading），推荐动作（continue/deepen-analysis/rollback-and-revise）
- 维度评分系统（`_evaluateDimensions`），支持自定义维度权重
- 证伪反思（`falsificationReflection`），含5条证伪提示和反谄媚检查
- 信号持久化（`attachSignalPersistence`），反思结果自动持久化

**核心差距**：反思结果（`recommendedAction`）仅为建议，不驱动实际的修订循环。`rollback-and-revise` 动作推荐后，没有自动触发修订的机制。反思是"观察-评估"而非"观察-评估-行动-再评估"的闭环。

**已实现的增强**：`ReflectionLoop`（`src/runtime/patterns/agentic-patterns.js`）将反思从单次评估升级为多轮迭代循环，支持收敛检测和重新规划。但尚未与 `SelfReflection` 的维度评分系统集成。

#### Tool Use：ToolAdapter是环境适配器而非工具使用框架

**现有实现**：`ToolAdapter`（`src/runtime/workflow/tool-adapter.js`）是外部AI编码工具（Claude Code/Codex CLI/Gemini CLI）的环境适配器，而非通用的工具使用框架。

**具体能力**：
- 4种工具类型支持（claude-code/codex-cli/gemini-cli/generic）
- 能力检测（hooks/sandbox/mcp/contextWindow/approvalModes）
- 执行模式到审批模式的映射（autonomous/supervised→对应审批级别）
- 运行时工具切换（`switchTool`），触发 `tool-changed` 事件

**核心差距**：ToolAdapter解决的是"如何适配不同AI编码工具的环境"，而非"智能体如何选择和调用工具"。缺乏：
- 工具注册与发现机制（ToolRegistry）
- 工具选择策略（基于任务特征自动选择最合适的工具）
- 工具调用结果验证
- 工具调用失败时的备选工具切换

**相关模块**：`MCPClient`（`src/runtime/infrastructure/mcp-client.js`）实现了MCP协议客户端，`CommandRouter`（`src/runtime/workflow/command-router.js`）实现了斜杠命令路由，这些是工具使用的基础设施，但尚未形成统一的工具使用框架。

#### Planning：漂移检测与计划修订断裂

**现有实现**：`GoalExecutor`（`src/runtime/workflow/goal-executor.js`）实现了目标执行的全生命周期管理。

**具体能力**：
- 目标创建→分解→迭代执行→收敛/停滞→完成/失败
- 自动子任务分解（`_decomposeGoal`），支持依赖解析和循环依赖检测
- 并行子任务执行（`_executeSubtasksParallel`），带超时和取消信号
- 质量评分与收敛检测（`_evaluateIteration`、`_isStagnant`）
- OODA决策闭环集成（`_runOodaCycle`）
- 计划持久化（`PlanPersistence`），支持反漂移上下文注入（`_antiDriftContext`）

**核心差距**：
- 漂移检测（`anti-drift-inject-failed` 事件）与计划修订之间断裂——检测到漂移后仅发出事件，不自动触发计划修订
- 停滞检测（`_isStagnant`）仅判断是否停滞，不提供修订策略
- 收敛检测（`_shouldStopLoop`）在收敛或停滞时停止循环，但不尝试调整策略后继续

**已实现的增强**：`ReflectionLoop` 的 `replanFn` 参数可触发重新规划，但尚未与 `GoalExecutor` 的漂移检测集成。

#### Multi-Agent：无标准化通信协议

**现有实现**：多Agent基础设施已较为完善：

- **SubagentExecutor**（`src/runtime/agent/subagent-executor.js`）：子代理执行器
- **CollaborationModeRouter**（`src/runtime/collaboration/collaboration-mode-router.js`）：协作模式路由
- **AgentPackManager**（`src/runtime/agent/agent-pack-manager.js`）：代理包管理
- **MultiAgentRouter**（`src/runtime/agent/multi-agent-router.js`）：多Agent路由
- **MultiAgentOrchestrator**（`src/runtime/agent/multi-agent-orchestrator.js`）：多Agent编排
- **ChatChain**（`src/runtime/collaboration/chat-chain.js`）：链式对话编排
- **EnsembleOrchestrator**（`src/runtime/collaboration/ensemble-orchestrator.js`）：集成编排
- **MoEGatingRouter**（`src/runtime/collaboration/moe-gating-router.js`）：MoE门控路由

**核心差距**：缺乏标准化的Agent间通信协议。现有模块通过事件总线（`EventBus`）和因果数据总线（`CausalDataBus`）进行间接通信，但没有定义：
- Agent间消息格式标准
- 请求-响应协议
- 协商与投票机制
- 共享工作空间（SharedWorkspace）

### 2.3 8大基础模式完成度矩阵

| 模式 | 完成度 | 最大差距 | 优先级 |
|------|--------|----------|--------|
| 提示链（Prompt Chaining） | 85% | 链节点间缺乏质量门控，中间产物失真无检测 | P1-高 |
| 路由（Routing） | 80% | 匹配失败时缺乏优雅降级和回退路由 | P1-高 |
| 并行化（Parallelization） | 75% | 并发控制分散在多处，缺乏统一信号量管理 | P2-中 |
| 反思（Reflection） | 60% | 反思不驱动修订循环，缺乏多轮迭代收敛机制 | P1-高 |
| 工具使用（Tool Use） | 45% | ToolAdapter是环境适配器而非工具使用框架，缺乏工具注册/选择/验证 | P2-中 |
| 规划（Planning） | 70% | 漂移检测与计划修订断裂，停滞后无策略调整 | P1-高 |
| 多智能体（Multi-Agent） | 55% | 无标准化通信协议，缺乏协商与共享工作空间 | P2-中 |
| 记忆管理（Memory Management） | 70% | 记忆检索缺乏相关性验证，写入缺乏质量评估 | P2-中 |

**综合完成度**：67.5%

---

## 三、融合方案

### 3.1 集成路径规划

#### Phase 1：核心增强模块（已完成）

4个增强组件已在 `src/runtime/patterns/agentic-patterns.js` 中实现：

| 组件 | 状态 | 代码位置 | 功能 |
|------|------|----------|------|
| ValidationGate | ✅ 已实现 | `agentic-patterns.js` L34-142 | 链式步骤中间质量验证，支持自定义验证函数 |
| FallbackRouter | ✅ 已实现 | `agentic-patterns.js` L155-284 | 无匹配时的回退路由策略，三级降级 |
| ConcurrencyController | ✅ 已实现 | `agentic-patterns.js` L299-454 | 信号量并发控制，指数退避重试 |
| ReflectionLoop | ✅ 已实现 | `agentic-patterns.js` L468-577 | 多轮反思-修订循环，收敛检测，重新规划 |

Skill定义已创建：`.harness/skills/agentic-patterns.md`

#### Phase 2：模块集成（待实施）

与现有模块的桥接方案：

**ChatChain集成**：
```
ChatChain 原子任务链
  ↓ 每个任务节点
  ├─ 前置: ValidationGate.validate(input)
  ├─ 执行: 原子任务逻辑
  ├─ 后置: ValidationGate.validate(output)
  └─ 失败: FallbackRouter.handleNoMatch(error, candidates)
```
六阶段模板（brainstorming → requirement-analysis → architecture-design → module-development → integration-testing → deployment）中，每个阶段转换点插入ValidationGate，阶段内任务失败时触发FallbackRouter。

**SkillRouter集成**：
```
SkillRouter 匹配流程
  ├─ 主路径: 最佳匹配Skill
  ├─ 验证: ValidationGate.validate(matchScore)
  ├─ 备选: FallbackRouter → 次优Skill
  └─ 兜底: 默认处理策略（澄清请求）
```
SkillRouter的匹配结果经过ValidationGate验证匹配度，低于阈值时FallbackRouter激活次优Skill。

**GoalExecutor集成**：
```
GoalExecutor 目标执行
  ├─ 分解: 子目标生成
  ├─ 并行: ConcurrencyController 控制子目标并发
  ├─ 迭代: ReflectionLoop 检测收敛
  └─ 回退: FallbackRouter 切换备选方案
```
GoalExecutor的迭代执行循环中，ConcurrencyController控制子目标并发度，ReflectionLoop替代简单的收敛检测，FallbackRouter在停滞时切换策略。

**SelfReflection集成**：
```
SelfReflection 自反思
  ├─ 单次反思 → ReflectionLoop 多轮循环
  ├─ 评估结果 → ValidationGate 质量门控
  └─ 改进失败 → FallbackRouter 策略降级
```
SelfReflection的单次评估升级为ReflectionLoop的多轮迭代，每轮结果经过ValidationGate验证，改进失败时FallbackRouter降级处理。

#### Phase 3：高级模式（远期规划）

| 模式 | 实现路径 | 依赖 |
|------|----------|------|
| Tree of Thoughts | 扩展ThoughtDiamond为ThoughtTree，支持分支探索与回溯 | ThoughtDiamond, ReflectionLoop |
| Agent Negotiation | 新增协商协议模块，定义提议-反提议-接受流程 | MultiAgentOrchestrator, EventBus |
| Cross-Project Knowledge Transfer | 新增知识迁移模块，基于Embedding相似度的跨项目知识检索 | EmbeddingService, MemoryStore |

### 3.2 代码适配策略

#### 新增模块

- **核心模块**：`src/runtime/patterns/agentic-patterns.js`（已实现）
- **Skill定义**：`.harness/skills/agentic-patterns.md`（已创建）

#### 不修改现有模块接口，仅通过事件桥接增强

所有集成通过EventBus事件桥接实现，不修改现有模块的公共接口：

```javascript
// 事件桥接示例：ChatChain + ValidationGate
eventBus.on('chatchain:step-complete', (data) => {
  const result = agenticPatterns.validate(data.output, data.stepName);
  if (!result.passed) {
    eventBus.emit('agentic:validation-failed', { ...data, ...result });
  }
});

// 事件桥接示例：SkillRouter + FallbackRouter
eventBus.on('skillrouter:no-match', (data) => {
  const fallback = agenticPatterns.handleNoMatch(data.query, data.candidates);
  eventBus.emit('agentic:fallback-resolved', fallback);
});

// 事件桥接示例：GoalExecutor + ReflectionLoop
eventBus.on('goalexecutor:stagnant', async (data) => {
  if (agenticPatterns.reflectionLoop) {
    const result = await agenticPatterns.reflect(data.currentOutput);
    eventBus.emit('agentic:reflection-complete', result);
  }
});
```

### 3.3 接口设计规范

#### ValidationGate接口

```typescript
interface ValidationGate {
  // 配置
  qualityThreshold: number;    // 质量通过阈值，默认0.7
  maxRetries: number;          // 单步最大重试次数，默认2

  // 核心方法
  validate(output: any, stepName: string): ValidationResult;
  registerValidator(stepName: string, validatorFn: ValidatorFunction): void;

  // 事件
  on(event: 'validation-passed', handler: (data: ValidationEventData) => void): this;
  on(event: 'validation-failed', handler: (data: ValidationEventData) => void): this;
}

interface ValidationResult {
  passed: boolean;
  score: number;       // 0~1
  reason: string;
}

type ValidatorFunction = (output: any) => ValidationResult;
```

#### FallbackRouter接口

```typescript
interface FallbackRouter {
  // 配置
  clarificationPrompt: string;  // 澄清提示模板

  // 核心方法
  handleNoMatch(query: string, candidates: Candidate[]): FallbackResult;
  registerFallback(handlerFn: FallbackHandler): void;

  // 事件
  on(event: 'fallback-triggered', handler: (data: FallbackTriggeredData) => void): this;
  on(event: 'fallback-resolved', handler: (data: FallbackResolvedData) => void): this;
}

interface FallbackResult {
  resolved: boolean;
  strategy: 'relaxed-match' | 'registered-handler' | 'fallback-handler' | 'clarification' | 'error';
  result: any;
}

type FallbackHandler = (query: string, candidates: Candidate[]) => any | null;
```

#### ConcurrencyController接口

```typescript
interface ConcurrencyController {
  // 配置
  maxConcurrency: number;  // 最大并发数，默认5

  // 状态
  runningCount: number;    // 当前运行中任务数
  queuedCount: number;     // 等待队列长度

  // 核心方法
  executeAll<T>(tasks: T[], executeFn: (task: T) => Promise<R>): Promise<TaskResult<T, R>[]>;

  // 事件
  on(event: 'task-started', handler: (data: TaskEventData) => void): this;
  on(event: 'task-completed', handler: (data: TaskEventData) => void): this;
  on(event: 'task-failed', handler: (data: TaskEventData) => void): this;
  on(event: 'task-retried', handler: (data: TaskEventData) => void): this;
}

interface TaskResult<T, R> {
  task: T;
  result: R | null;
  error: Error | null;
  retries: number;
}
```

#### ReflectionLoop接口

```typescript
interface ReflectionLoop {
  // 配置
  maxIterations: number;           // 最大反思迭代次数，默认5
  convergenceThreshold: number;    // 收敛质量阈值，默认0.85

  // 核心方法
  execute(initialOutput: any): Promise<ReflectionResult>;

  // 事件
  on(event: 'reflection-iteration', handler: (data: IterationData) => void): this;
  on(event: 'convergence-detected', handler: (data: ConvergenceData) => void): this;
  on(event: 'replan-triggered', handler: (data: ReplanData) => void): this;
}

interface ReflectionResult {
  finalOutput: any;
  iterations: number;
  converged: boolean;
  qualityHistory: number[];
}

// 构造参数
interface ReflectionLoopOptions {
  reflectionFn: (output: any) => Promise<{score: number, feedback: string, recommendedAction: string}>;
  revisionFn: (output: any, feedback: string) => Promise<any>;
  replanFn?: (output: any, feedback: string) => Promise<any>;
}
```

### 3.4 潜在冲突与解决方案

#### 事件命名冲突

**风险**：AgenticPatterns转发子组件事件时，可能与现有模块的事件名冲突（如 `task-started`、`task-completed`）。

**解决方案**：使用 `agentic:` 前缀命名所有Agentic模式事件。

```javascript
// 冲突风险事件名
'task-started'          // ConcurrencyController 和 AgentRuntime 都使用
'task-completed'        // 同上
'validation-failed'     // 可能与 TDDGate 冲突

// 解决方案：桥接时添加前缀
eventBus.on('agentic:task-started', handler);    // 替代 'task-started'
eventBus.on('agentic:validation-failed', handler); // 替代 'validation-failed'
eventBus.on('agentic:fallback-triggered', handler);
eventBus.on('agentic:reflection-iteration', handler);
```

#### 与现有GoalExecutor迭代循环的协调

**风险**：GoalExecutor已有自己的迭代循环（`_runGoalLoop`），ReflectionLoop的迭代可能与之冲突。

**解决方案**：ReflectionLoop不替代GoalExecutor的迭代循环，而是作为迭代内的质量增强器：

```
GoalExecutor._runGoalLoop (外层迭代)
  └─ 每次迭代内
       ├─ 执行子任务
       ├─ ReflectionLoop.execute (内层反思)
       │    ├─ 反思 → 修订 → 反思 → ... (直到收敛)
       │    └─ 返回精炼后的输出
       └─ 更新质量历史
```

#### 与SelfReflection的维度评分集成

**风险**：SelfReflection的五维度评分（边界条件/一致性/安全性/性能/完整性）与ReflectionLoop的单一质量分数不一致。

**解决方案**：ReflectionLoop的 `reflectionFn` 可桥接SelfReflection的维度评分：

```javascript
// 桥接 SelfReflection 维度评分到 ReflectionLoop
agenticPatterns.initReflectionLoop({
  reflectionFn: async (output) => {
    const reflection = selfReflection.reflect({
      agentId: 'system',
      skillId: 'current-skill',
      currentQuality: output.qualityScore,
      result: output,
    });
    // 将维度评分聚合为单一分数
    const dimensionScores = Object.values(reflection.dimensions);
    const avgScore = dimensionScores.reduce((sum, d) => sum + d.score * d.weight, 0)
      / dimensionScores.reduce((sum, d) => sum + d.weight, 0);
    return {
      score: avgScore,
      feedback: reflection.selfCheckPrompt,
      recommendedAction: reflection.recommendedAction,
    };
  },
  revisionFn: async (output, feedback) => {
    // 将反思反馈注入到下一次迭代的上下文中
    return { ...output, _reflectionFeedback: feedback };
  },
  replanFn: async (output, feedback) => {
    // 触发GoalExecutor的计划修订
    eventBus.emit('agentic:replan-requested', { output, feedback });
    return output; // 返回当前输出，等待GoalExecutor处理
  },
});
```

### 3.5 回滚机制

#### 模块独立，可单独禁用

AgenticPatterns的4个子组件完全独立，每个组件可单独使用或禁用：

```javascript
const patterns = new AgenticPatterns({
  validationGate: { qualityThreshold: 0.8 },  // 启用验证门控
  fallbackRouter: { clarificationPrompt: '...' }, // 启用回退路由
  concurrencyController: { maxConcurrency: 3 },  // 启用并发控制
  // 不传 reflectionLoop → 不初始化反思循环
});
```

#### 通过配置开关控制

在 `.harness/config.json` 中添加配置开关：

```json
{
  "agenticPatterns": {
    "enabled": true,
    "validationGate": { "enabled": true, "qualityThreshold": 0.7 },
    "fallbackRouter": { "enabled": true },
    "concurrencyController": { "enabled": true, "maxConcurrency": 5 },
    "reflectionLoop": { "enabled": false }
  }
}
```

#### 不修改现有模块，移除无副作用

由于所有集成通过事件桥接实现，移除AgenticPatterns模块不会影响现有功能：
- 现有模块不import AgenticPatterns
- 事件桥接是单向的（AgenticPatterns监听现有模块事件）
- 移除后，现有模块的事件无人监听，但不影响其正常执行

---

## 四、13种高级模式兼容性分析

### 1. Tree of Thoughts（思维树）

**兼容性**：⚠️ 部分兼容

**现有基础**：`ThoughtDiamond`（`src/runtime/thought/thought-diamond.js`）已实现思维精炼的四层级模型（Raw→Cut→Polished→Diamond），基于置信度分层和去重。

**差距**：ThoughtDiamond是线性精炼（单条思维逐步提升质量），不支持分支探索与回溯。Tree of Thoughts需要：
- 从同一节点生成多个候选思维分支
- 对每个分支独立评估
- 选择最有前景的分支继续探索
- 支持回溯到之前的分支点

**增强路径**：扩展ThoughtDiamond为ThoughtTree，新增 `branch()`、`evaluate()`、`prune()`、`backtrack()` 方法。

### 2. ReAct（推理-行动交织）

**兼容性**：✅ 完全兼容

**现有基础**：`OodaLoop`（`src/runtime/deepening/ooda-loop.js`）已实现OODA决策循环（观察-判断-决策-行动），三种决策模式（反应式/审慎式/创造式），三级嵌套（战略/作战/战术）。

**映射关系**：ReAct的Reason-Act-Observe循环与OODA的Observe-Orient-Decide-Act循环高度一致：
- ReAct的Reason → OODA的Orient+Decide
- ReAct的Act → OODA的Act
- ReAct的Observe → OODA的Observe

**无需额外增强**，OODA Loop已完全覆盖ReAct模式。

### 3. Self-Critique（自我批评）

**兼容性**：⚠️ 部分兼容

**现有基础**：`SelfReflection` 已实现五维度反思和证伪维度反思（`falsificationReflection`），含5条证伪提示和反谄媚检查。

**差距**：Self-Critique要求批评结果驱动实际的修订行动，而SelfReflection的 `recommendedAction` 仅为建议。需要ReflectionLoop增强，将批评-修订形成闭环。

**增强路径**：通过ReflectionLoop桥接SelfReflection，将 `falsificationReflection` 的输出作为 `reflectionFn` 的输入，驱动修订循环。

### 4. Tool Selection（工具选择）

**兼容性**：⚠️ 部分兼容

**现有基础**：`SkillRouter` 的语义分组路由和模型分级路由可作为工具选择的基础。`MCPClient` 提供了MCP协议工具发现能力。

**差距**：缺乏统一的工具注册表（ToolRegistry）和基于任务特征的工具选择策略。ToolAdapter是环境适配器，不解决工具选择问题。

**增强路径**：新增ToolRegistry模块，整合SkillRouter的语义匹配和MCPClient的工具发现，实现基于任务特征的工具自动选择。

### 5. Hierarchical Planning（层次化规划）

**兼容性**：⚠️ 部分兼容

**现有基础**：`GoalExecutor` 支持目标分解为子任务（`_decomposeGoal`），子任务支持依赖关系和优先级。`PhaseOrchestrator` 实现了六阶段流程编排。

**差距**：GoalExecutor的分解是单层的（目标→子任务），不支持递归分解（子任务→子子任务）。缺乏层次化规划所需的：
- 递归目标分解
- 抽象层次间的映射
- 不同层次的计划一致性验证

**增强路径**：增强GoalExecutor的 `_decomposeGoal` 方法，支持递归分解，最大递归深度限制为3层。

### 6. Plan Revision（计划修订）

**兼容性**：⚠️ 部分兼容

**现有基础**：GoalExecutor有漂移检测（`anti-drift-inject-failed` 事件）和停滞检测（`_isStagnant`），PlanPersistence支持计划持久化和反漂移上下文注入。

**差距**：检测到漂移或停滞后，仅发出事件或停止循环，不自动触发计划修订。缺乏漂移→修订的闭环。

**增强路径**：通过ReflectionLoop的 `replanFn` 桥接GoalExecutor的漂移检测，形成"检测漂移→反思原因→修订计划→继续执行"的闭环。

### 7. Agent Specialization（智能体专业化）

**兼容性**：✅ 完全兼容

**现有基础**：`.harness/agents/` 目录下已定义28种专业化Agent：

| 类别 | Agent |
|------|-------|
| 工程 | backend-engineer, frontend-engineer, devops-engineer |
| 评审 | code-reviewer, go-reviewer, java-reviewer, python-reviewer, rust-reviewer, typescript-reviewer |
| 产品 | product-manager, domain-analyst, planner |
| 质量 | quality-assurance, test-writer, security-reviewer |
| 运营 | customer-service, logistics, order-processing, marketing-strategist, seo-specialist |
| 研究 | research-specialist, data-analyst |
| 设计 | system-designer, ux-designer |
| 管理 | team-lead, task-worker |
| 内容 | technical-writer |
| 构建 | build-error-solver |

每种Agent有独立的Skill定义和触发条件，已实现专业化分工。

### 8. Shared State（共享状态）

**兼容性**：⚠️ 部分兼容

**现有基础**：`CausalDataBus`（`src/runtime/causal/causal-data-bus.js`）提供了因果数据发布/订阅机制，`.harness/workspace/shared/` 目录提供了共享工作空间。

**差距**：缺乏结构化的共享工作空间（SharedWorkspace），Agent间无法显式地读写共享状态。CausalDataBus是发布/订阅模式，不支持原子化的读写操作。

**增强路径**：新增SharedWorkspace模块，基于CausalDataBus实现，提供 `get()`、`set()`、`lock()`、`unlock()` 等原子操作。

### 9. Agent Negotiation（智能体协商）

**兼容性**：❌ 不兼容

**现有基础**：`EnsembleOrchestrator` 实现了多Agent输出融合，`MoEGatingRouter` 实现了MoE门控路由，但这些是预定义的编排模式，不支持动态协商。

**差距**：完全缺乏协商协议。需要新增：
- 提议-反提议-接受/拒绝的消息格式
- 协商轮次限制和超时机制
- 共识达成策略（多数投票、加权投票、一致同意）
- 冲突检测与解决机制

**增强路径**：新增NegotiationProtocol模块，定义标准化的协商消息格式和流程。

### 10. Memory Consolidation（记忆整合）

**兼容性**：⚠️ 部分兼容

**现有基础**：`DreamEngine`（`src/runtime/thought/dream-engine.js`）已实现离线经验提炼和模式发现，支持错误避免/最佳实践/工作流优化三类笔记的创建与合并。

**映射关系**：DreamEngine的"做梦"过程（离线处理历史会话数据，提取模式笔记）与Memory Consolidation的"记忆整合"（睡眠期间整合和巩固记忆）高度一致。

**差距**：DreamEngine的笔记合并基于简单的文本相似度，缺乏：
- 跨模态记忆整合（代码+文档+决策记录）
- 记忆重要性权重动态调整
- 整合后的记忆验证

**增强路径**：增强DreamEngine的笔记合并算法，引入重要性权重和多模态整合。

### 11. Memory Decay（记忆衰减）

**兼容性**：⚠️ 部分兼容

**现有基础**：`MemoryStore`（`src/runtime/thought/memory-store.js`）实现了项目知识存储与摘要管理，`GoalExecutor` 有目标TTL过期机制（`goalTTL: 7天`）。

**差距**：缺乏基于艾宾浩斯遗忘曲线的记忆衰减机制。现有TTL是硬过期（到期删除），而非渐进衰减（随时间降低权重）。

**增强路径**：新增EbbinghausDecay模块，实现：
- 记忆强度随时间指数衰减：`strength = e^(-t/S)`，S为记忆稳定性
- 每次检索时增强记忆强度（间隔重复效应）
- 强度低于阈值的记忆自动归档

### 12. Cross-Project Transfer（跨项目知识迁移）

**兼容性**：❌ 不兼容

**现有基础**：`EmbeddingService`（`src/runtime/model/embedding-service.js`）提供了向量嵌入能力，`KnowledgeBasePipeline`（`src/runtime/infrastructure/knowledge-base-pipeline.js`）提供了知识库管道。

**差距**：所有知识存储在项目级 `.harness/` 目录下，无跨项目知识共享机制。需要新增：
- 全局知识库（跨项目共享）
- 基于Embedding相似度的知识检索
- 知识迁移时的上下文适配（项目A的知识迁移到项目B时需适配B的上下文）
- 迁移验证（确保迁移的知识在新项目中有效）

**增强路径**：新增CrossProjectTransfer模块，基于EmbeddingService实现跨项目知识检索和迁移。

### 13. Formal Verification（形式化验证）

**兼容性**：❌ 不兼容

**现有基础**：`TDDGate`（`src/runtime/gate/tdd-gate.js`）实现了TDD门禁检查，`EvidenceVerifier`（`src/runtime/gate/evidence-verifier.js`）实现了证据验证，`IronRuleEngine`（`src/runtime/sdd/iron-rule-engine.js`）实现了铁律引擎。

**差距**：现有验证是基于规则的检查（TDD门禁、代码规范、安全规则），不是形式化验证。形式化验证需要：
- 数学规约语言（如TLA+、Alloy）
- 模型检验器
- 不变量证明
- 反例生成

**增强路径**：远期规划，需要引入外部形式化验证工具。可先从轻量级契约式验证开始（基于SDD的规格驱动开发），逐步增强。

---

## 五、验证策略

### 5.1 单元测试覆盖4个增强组件

| 组件 | 测试重点 | 关键测试用例 |
|------|----------|-------------|
| ValidationGate | 验证逻辑正确性 | 默认评分、自定义验证函数、阈值边界、异常处理 |
| FallbackRouter | 回退策略完整性 | 宽松匹配、注册处理器、澄清请求、空候选列表 |
| ConcurrencyController | 并发控制可靠性 | 并发限制、信号量排队、重试机制、指数退避 |
| ReflectionLoop | 迭代收敛正确性 | 收敛检测、重新规划触发、最大迭代限制、异常中断 |

### 5.2 集成测试验证与现有模块的桥接

| 集成点 | 测试场景 | 验证目标 |
|--------|----------|----------|
| ChatChain + ValidationGate | 六阶段流程中插入质量门控 | 阶段转换时质量不达标被拦截 |
| SkillRouter + FallbackRouter | 匹配失败时回退路由 | 无匹配时优雅降级而非静默失败 |
| GoalExecutor + ReflectionLoop | 停滞时触发反思循环 | 停滞后通过反思找到改进方向 |
| SelfReflection + ReflectionLoop | 维度评分桥接到反思循环 | 反思结果驱动实际修订 |

### 5.3 性能测试验证并发控制的效率

| 测试场景 | 指标 | 目标 |
|----------|------|------|
| 100个并发任务，maxConcurrency=5 | 吞吐量、平均等待时间 | 吞吐量不低于串行执行的80% |
| 高负载下信号量排队 | 队列长度、内存占用 | 内存占用线性增长，无泄漏 |
| 重试场景下的指数退避 | 重试间隔、总耗时 | 退避间隔符合2^n增长 |

### 5.4 回归测试确保现有功能不受影响

| 测试范围 | 验证方法 | 通过标准 |
|----------|----------|----------|
| SkillRouter路由准确性 | 现有路由测试用例 | 匹配结果不变 |
| GoalExecutor目标执行 | 现有目标执行测试 | 收敛行为不变 |
| SelfReflection反思质量 | 现有反思测试用例 | 维度评分不变 |
| PipelineExecutor管道执行 | 现有管道测试 | 执行流程不变 |
| EventBus事件流转 | 事件监听测试 | 新增事件不影响现有事件 |

### 5.5 验证执行顺序

```
Phase 1: 单元测试（4个增强组件独立测试）
  ↓
Phase 2: 集成测试（与现有模块的桥接测试）
  ↓
Phase 3: 性能测试（并发控制效率验证）
  ↓
Phase 4: 回归测试（现有功能不受影响）
  ↓
Phase 5: 端到端测试（完整Agentic模式工作流验证）
```
