---
skill_id: harness-engineering
name: 驾驭工程约束引擎
description: |
  实现Harness Engineering六大架构约束的增强引擎，提供渐进式披露编排、三重防线协调和自验证循环
applicable_agents: [team-lead, domain-analyst, task-worker]
trigger: "auto"
auto_trigger: true
phase: [brainstorming, design, implementation, testing]
trigger_conditions:
  - "渐进式披露"
  - "三重防线"
  - "自验证"
  - "上下文隔离"
  - "熵治理"
  - "可拆卸"
  - "harness engineering"
  - "progressive disclosure"
  - "triple defense"
  - "verification loop"
priority: 90
depends_on: []
blocks: []
enforcement: recommended
causal_inputs:
  - task-context
  - phase-transition
  - constraint-rules
causal_outputs:
  - disclosure-plan
  - defense-report
  - verification-result
verified: true
stability: stable
---

# 驾驭工程约束引擎 (Harness Engineering Constraint Engine)

## 核心原则

**解决已经出现的，而不是预防未来的错误。**

不预设所有可能的失败模式，而是在错误实际发生后精准定位、快速修复、形成闭环。每一道防线都针对已观测到的问题而设，而非对假想风险的过度防御。

## 六大核心架构约束

### 1. 渐进式披露（Progressive Disclosure）

**定义**：按任务优先级和执行阶段分层暴露上下文，避免信息过载。只向当前角色在当前阶段提供其所需的最小上下文集合。

**项目映射**：
- `ContextCompressionEngine` — 上下文压缩引擎，智能分类（keep/summarize/discard），根据技能类别和因果关联决定上下文保留策略
- `PhaseContextInjector` — 阶段上下文注入器，根据执行阶段自动注入相关规则和Agent定义
- `TokenManager` — Token预算管理，三级预警（80%/95%/100%）驱动上下文裁剪决策
- `SkillRouter.smartPreloadByPhase()` — 按阶段预加载Skill，避免一次性加载全部技能指令

**增强**：`ProgressiveDisclosureOrchestrator` 在现有压缩/注入机制之上，增加披露计划编排能力——根据任务上下文动态生成"何时披露什么信息给哪个Agent"的时序计划。

### 2. 架构约束（Architectural Constraints）

**定义**：Prompt柔性建议 + 硬编码刚性约束 + Linter校验，三层约束体系确保规则从文档到代码的可执行性。

**项目映射**：
- `TDDGate` — TDD门禁，强制RED-GREEN-REFACTOR循环
- `EvidenceVerifier` — 证据验证器，声称完成必须提供实际证据
- `PermissionGuard` / `RBACEnforcer` — 权限执行引擎，硬编码的访问控制
- `FrameworkComplianceChecker` — 框架合规检查器，Linter级别的结构校验

**增强**：`TripleDefenseCoordinator` 协调三层防线（Prompt建议层 → 代码约束层 → 运行时校验层），确保约束不遗漏、不冲突、可追溯。

### 3. 自验证循环（Self-Verification Loop）

**定义**：类TDD中间件钩子，执行前校验 + 执行后验证，形成闭环验证。

**项目映射**：
- `HookEngine` / `hook-handlers` — 钩子引擎，pre-action/post-action中间件
- `AdversarialReview` — 对抗审查，对输出质量进行独立评估
- `SelfReflection` — 自反思模块，输出质量评估和迭代改进
- `SkillImprover` — 技能改进器，基于执行反馈自动优化Skill定义

**增强**：`VerificationLoop` 将单次验证升级为多轮自验证循环——执行→验证→修复→再验证，直到质量收敛或达到迭代上限。

### 4. 上下文隔离（Context Isolation）

**定义**：多Agent记忆独立，禁止跨Agent记忆共享，防止上下文污染。

**项目映射**：
- `IsolatedContextManager` — 隔离上下文管理器，为每个Agent任务创建独立执行上下文
- `AgentChannel` — Agent通道，控制Agent间的通信边界
- `MemoryStore` — 项目知识存储，按Agent角色分区管理
- `CheckpointManager` — 检查点管理器，每个Agent独立快照

**增强**：`ProgressiveDisclosureOrchestrator` 在披露计划中显式标注共享边界，任何跨Agent信息传递必须经过审批门控。

### 5. 熵治理（Entropy Governance）

**定义**：自维护文档降噪，维持知识库简洁有序，防止信息熵持续增长。

**项目映射**：
- `SkillRouter` 三层缓存 — L1摘要/L2指令/L3资源，按需加载避免全量膨胀
- `ContextCompressionEngine` — 上下文压缩，已完成阶段从完整指令压缩为摘要或丢弃
- `AutoregressiveContextSchema` — 自回归上下文，迭代推理中只传递增量而非全量
- `CausalDataBus` — 因果数据总线，WAL日志 + 防抖持久化，避免写入放大

**增强**：`TripleDefenseCoordinator` 在熵治理维度增加"信息价值评估"防线——写入前评估信息价值，低于阈值的直接丢弃而非存储。

### 6. 可拆卸性（Detachability）

**定义**：模块化设计，能力按需插拔，任何模块可独立禁用而不影响核心流程。

**项目映射**：
- `PluginManager` — 插件管理器，模块动态加载/卸载
- `ModuleInitializer` — 模块初始化器，按依赖顺序创建和清理模块实例
- `SkillRouter` — 技能路由器，Skill按需发现和激活，非全量加载
- `ConcurrencyController` — 并发控制器，模块间资源隔离

**增强**：`VerificationLoop` 在模块拆卸后执行完整性验证——确认拆卸后系统功能无退化、依赖无断裂、数据无丢失。

## 三个增强组件

### ProgressiveDisclosureOrchestrator（渐进式披露编排器）

在现有压缩/注入机制之上，增加披露计划编排能力。根据任务上下文和执行阶段，动态生成"何时披露什么信息给哪个Agent"的时序计划。

**接口定义**：
```javascript
const orchestrator = new ProgressiveDisclosureOrchestrator({
  phases: ['brainstorming', 'design', 'implementation', 'testing'],
  disclosureRules: [
    {
      phase: 'brainstorming',
      agent: 'domain-analyst',
      disclose: ['task-context', 'constraint-rules'],
      withhold: ['implementation-details', 'test-cases'],
    },
    {
      phase: 'implementation',
      agent: 'task-worker',
      disclose: ['task-context', 'design-spec', 'constraint-rules'],
      withhold: ['brainstorming-artifacts'],
    },
  ],
  isolationBoundary: 'agent',  // 'agent' | 'phase' | 'task'
  approvalGate: async (fromAgent, toAgent, info) => {
    return await humanApprovalGate.requestApproval(fromAgent, toAgent, info);
  },
});

const plan = await orchestrator.generatePlan(taskContext);
// plan: { disclosures: [...], withholdings: [...], approvals: [...] }

await orchestrator.executePlan(plan);
```

**使用场景**：
- 新任务启动时，根据阶段和角色生成上下文披露计划
- 阶段转换时，重新评估哪些上下文需要保留、压缩或丢弃
- 跨Agent信息传递时，通过审批门控控制共享边界
- Token预算紧张时，按优先级裁剪低价值上下文

### TripleDefenseCoordinator（三重防线协调器）

协调三层约束防线：Prompt建议层（柔性）→ 代码约束层（刚性）→ 运行时校验层（验证），确保约束不遗漏、不冲突、可追溯。

**接口定义**：
```javascript
const coordinator = new TripleDefenseCoordinator({
  layers: [
    {
      name: 'prompt-suggestion',
      type: 'advisory',
      enforce: (context) => {
        // Prompt层面的柔性建议，如：建议遵循TDD流程
        return { applied: true, suggestions: ['...'] };
      },
    },
    {
      name: 'code-constraint',
      type: 'mandatory',
      enforce: (context) => {
        // 代码层面的刚性约束，如：TDDGate强制RED-GREEN-REFACTOR
        return { applied: true, violations: [] };
      },
    },
    {
      name: 'runtime-validation',
      type: 'verification',
      enforce: (context) => {
        // 运行时校验层，如：EvidenceVerifier验证完成证据
        return { applied: true, evidence: [] };
      },
    },
  ],
  conflictResolution: 'strictest',  // 'strictest' | 'latest' | 'manual'
  onViolation: async (layer, violation) => {
    await auditLogger.logViolation(layer, violation);
  },
});

const report = await coordinator.enforceAll(taskContext);
// report: { layers: [...], conflicts: [], violations: [], resolved: [...] }
```

**使用场景**：
- 任务执行前，三层防线同步检查约束合规性
- 新约束引入时，检测与现有约束的冲突
- 约束违反时，按最严格策略执行并记录审计日志
- 熵治理维度，在信息写入前评估价值防止存储膨胀

### VerificationLoop（自验证循环）

将单次验证升级为多轮自验证循环：执行→验证→修复→再验证，直到质量收敛或达到迭代上限。

**接口定义**：
```javascript
const loop = new VerificationLoop({
  maxIterations: 5,
  convergenceThreshold: 0.85,
  verifier: async (output) => {
    const result = await evidenceVerifier.verify(output);
    return { passed: result.score >= 0.85, score: result.score, gaps: result.gaps };
  },
  fixer: async (output, gaps) => {
    return await selfReflection.reflectAndFix(output, gaps);
  },
  onConverge: (finalOutput, iterations) => {
    console.log(`验证收敛: ${iterations}轮, 最终分数: ${finalOutput.score}`);
  },
  onDiverge: (output, iterations) => {
    // 超过迭代上限仍未收敛，记录问题而非预防性阻断
    console.log(`验证未收敛: ${iterations}轮, 当前分数: ${output.score}`);
  },
});

const result = await loop.run(taskOutput);
// result: { output: ..., iterations: 3, finalScore: 0.91, converged: true, evidence: [...] }
```

**使用场景**：
- 任务产出验证，从单次检查升级为多轮迭代验证
- 模块拆卸后完整性验证，确认无功能退化
- 代码审查后修复验证，确保修复真正解决了问题
- 技能执行后质量验证，驱动SkillImprover优化

## 与现有模块的集成点

### ChatChain 集成
```
ChatChain 六阶段任务链
  ↓ 阶段转换点
  ├─ ProgressiveDisclosureOrchestrator: 生成下一阶段披露计划
  ├─ TripleDefenseCoordinator: 三层约束同步检查
  └─ VerificationLoop: 阶段产出验证收敛
```

ChatChain的六阶段模板（brainstorming → requirement-analysis → architecture-design → module-development → integration-testing → deployment）中，每个阶段转换点由ProgressiveDisclosureOrchestrator重新编排上下文披露，TripleDefenseCoordinator同步检查约束合规性，VerificationLoop验证阶段产出质量。

### SkillRouter 集成
```
SkillRouter 技能路由
  ├─ ProgressiveDisclosureOrchestrator: 按阶段控制Skill指令的披露粒度
  ├─ TripleDefenseCoordinator: Prompt层匹配规则 + 代码层依赖检查 + 运行时能力校验
  └─ VerificationLoop: 技能执行后质量验证
```

SkillRouter的匹配和加载过程中，ProgressiveDisclosureOrchestrator控制L1/L2/L3缓存的披露时机，TripleDefenseCoordinator在三层分别校验匹配合法性，VerificationLoop在技能执行后验证产出质量。

### GoalExecutor 集成
```
GoalExecutor 目标执行
  ├─ ProgressiveDisclosureOrchestrator: 子目标上下文按需披露
  ├─ TripleDefenseCoordinator: 目标分解约束 + 执行权限校验 + 结果验证
  └─ VerificationLoop: 目标达成度迭代验证
```

GoalExecutor的目标分解和迭代执行中，ProgressiveDisclosureOrchestrator控制子目标间的上下文传递边界，TripleDefenseCoordinator在三层分别校验分解合规性和执行权限，VerificationLoop迭代验证目标达成度。

### IsolatedContextManager 集成
```
IsolatedContextManager 上下文隔离
  ├─ ProgressiveDisclosureOrchestrator: 跨Agent信息传递审批门控
  ├─ TripleDefenseCoordinator: 隔离边界三层校验
  └─ VerificationLoop: 隔离完整性验证
```

IsolatedContextManager的隔离边界由ProgressiveDisclosureOrchestrator的审批门控增强，TripleDefenseCoordinator确保隔离规则在三层一致执行，VerificationLoop验证隔离后无上下文泄漏。

### HookEngine 集成
```
HookEngine 钩子引擎
  ├─ pre-action: TripleDefenseCoordinator.enforceAll()
  ├─ post-action: VerificationLoop.run()
  └─ ProgressiveDisclosureOrchestrator: 钩子上下文按需注入
```

HookEngine的pre-action钩子触发TripleDefenseCoordinator的三层约束检查，post-action钩子触发VerificationLoop的自验证循环，ProgressiveDisclosureOrchestrator控制钩子注入的上下文粒度。

## 最佳实践

1. **披露按需而非按量**：ProgressiveDisclosureOrchestrator的披露计划应基于"当前角色在当前阶段需要什么"，而非"有多少信息就给多少"。信息过载比信息不足危害更大。
2. **防线协调而非防线堆叠**：TripleDefenseCoordinator的三层防线必须协调一致，避免同一约束在三层重复执行造成性能浪费，或三层约束互相矛盾造成执行混乱。
3. **验证收敛而非验证完美**：VerificationLoop的收敛阈值不宜过高（建议0.8-0.9），追求完美验证会导致无限迭代。核心原则是"解决已经出现的错误"，而非"预防所有可能的错误"。
4. **隔离有边界而非隔离无例外**：上下文隔离不是绝对的，跨Agent信息传递通过审批门控是允许的。完全隔离会导致协作效率低下。
5. **熵治理持续而非一次性**：熵治理不是一次性的清理活动，而是持续的信息价值评估。每次写入前评估价值，每次读取后评估相关性。
6. **可拆卸验证后生效**：模块拆卸后必须通过VerificationLoop验证系统完整性，确认无功能退化后才算拆卸完成。

## 反模式

1. **过度披露**：将所有上下文一次性注入，导致Token浪费和注意力分散。应通过ProgressiveDisclosureOrchestrator按阶段按角色逐步披露。
2. **防线冲突**：三层防线对同一场景给出矛盾判断（如Prompt层建议通过、代码层强制阻断），导致执行混乱。应通过TripleDefenseCoordinator的conflictResolution策略统一处理。
3. **验证死循环**：VerificationLoop的fixer无法实质修复问题，导致迭代耗尽maxIterations但未收敛。应在3轮无改善时提前终止，记录问题而非无限重试。
4. **隔离过度**：完全禁止跨Agent信息传递，导致协作效率极低。应通过审批门控允许必要的受控信息共享。
5. **熵治理不足**：只清理不评估，导致清理后信息价值密度未提升。应在写入前评估信息价值，从源头控制熵增。
6. **拆卸无验证**：模块拆卸后不验证系统完整性，导致隐蔽的功能退化。拆卸必须配合VerificationLoop的完整性验证。

## 目标

实现Harness Engineering六大架构约束的增强引擎，通过三个增强组件（ProgressiveDisclosureOrchestrator、TripleDefenseCoordinator、VerificationLoop）将架构约束从设计原则转化为可执行的工程化机制。核心理念是"解决已经出现的，而不是预防未来的错误"，在错误实际发生后精准定位、快速修复、形成闭环。

## 步骤

1. 根据当前任务阶段和角色，使用ProgressiveDisclosureOrchestrator生成上下文披露计划
2. 在任务执行前、阶段转换时、执行后三个时机，通过TripleDefenseCoordinator同步检查三层约束合规性
3. 对任务产出启动VerificationLoop多轮验证循环（执行→验证→修复→再验证），设置收敛阈值和迭代上限
4. 跨Agent信息传递时通过审批门控控制共享边界，确保上下文隔离
5. 信息写入前评估信息价值，低于阈值的内容直接丢弃，从源头控制熵增
6. 模块拆卸后执行完整性验证，确认系统功能无退化、依赖无断裂
7. 约束冲突时按最严格策略（strictest）处理，记录审计日志

## 验收

- 上下文披露按阶段按角色分层，无信息过载或关键信息遗漏
- 三层防线（Prompt建议层→代码约束层→运行时校验层）协调一致，无冲突或遗漏
- 验证循环在设定迭代上限内收敛，3轮无改善时已提前终止
- 跨Agent信息传递经过审批门控，上下文隔离边界无泄漏
- 知识库信息价值密度提升，低价值内容已从源头控制
- 模块拆卸后系统完整性验证通过，无功能退化

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 实现Harness Engineering六大架构约束（渐进式披露、架构约束、自验证循环、上下文隔离、熵治理、可拆卸性）的增强引擎，通过三个增强组件（ProgressiveDisclosureOrchestrator、TripleDefenseCoordinator、VerificationLoop）提升Agent系统的工程化水平。

### Q: 适用于哪些场景？
A: 适用于多Agent系统的架构治理场景，包括上下文按需披露、三层约束防线协调、执行结果自验证循环、Agent间上下文隔离、知识库熵治理和模块可拆卸性保障。

### Q: 使用此Skill的前提条件是什么？
A: 需要Harness框架的运行时环境，已部署ContextCompressionEngine、TDDGate、IsolatedContextManager、HookEngine等核心模块，并理解六大架构约束的核心原则——"解决已经出现的，而不是预防未来的错误"。
