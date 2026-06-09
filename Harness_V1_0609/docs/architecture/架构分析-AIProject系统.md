# 架构分析-AIProject系统

## 概述
Harness Engineering 是一个基于"分层分责+文档驱动+流程管控+容错自愈"方法论的多Agent协作框架。通过六阶段执行流程、六层文档体系、84个Skill（20验证+62扩展+2基础设施）和可执行运行时引擎，实现AI Agent的高效协作开发。框架包含384+源文件、220+类、235+导出模块、242+ API端点、5325+测试用例。

## 技术栈

| 技术 | 版本/规格 | 用途 |
|------|----------|------|
| Node.js | >=18.0.0 | 运行时环境 |
| CommonJS | - | 模块系统 |
| better-sqlite3 | ^12.9.0 | 本地SQLite持久化 |
| HTTP/WebSocket | Node内置 | Web仪表盘通信 |
| PWA | - | 前端离线支持 |
| YAML Frontmatter | - | Skill/Command/Agent定义 |

## 系统架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                        Web Dashboard 层                          │
│  DashboardServer + WebSocketHandler + PWA前端(app.js)            │
│  220+ API端点 / 实时推送 / 设计系统审计 / Agent全景图             │
├──────────────────────────────────────────────────────────────────┤
│                      协作编排层                                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ GoalExecutor │ │Collaboration │ │ Subagent     │             │
│  │ 目标分解执行 │ │ModeRouter    │ │Executor      │             │
│  │ 自主迭代收敛 │ │协作模式路由  │ │子Agent执行   │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ PairChat     │ │ ChatChain    │ │ OutputFusion │             │
│  │ 结对编程     │ │ 链式对话     │ │ 输出融合     │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
├──────────────────────────────────────────────────────────────────┤
│                    深化推理层（Deepening）                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ Deepening    │ │ Quality      │ │ Convergence  │             │
│  │ Orchestrator │ │ Scorer       │ │ Detector     │             │
│  │ 深化编排器   │ │ 质量评分器   │ │ 收敛检测器   │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ Thought      │ │ Model        │ │ Adaptive     │             │
│  │ Retriever    │ │ Selector     │ │ Depth        │             │
│  │ 思维检索循环 │ │ 模型选择器   │ │ 自适应深度   │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
│  50+个deepening子模块：缓存/熔断/限流/事件总线/连接池/...        │
├──────────────────────────────────────────────────────────────────┤
│                    流程管控层                                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ SkillRouter  │ │ Phase        │ │ Command      │             │
│  │ 技能路由器   │ │ Orchestrator │ │ Router       │             │
│  │ 三级缓存匹配│ │ 六阶段编排   │ │ 斜杠命令路由 │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │Programmable  │ │ Context      │ │ Session      │             │
│  │HookExecutor  │ │ Compression  │ │ Manager      │             │
│  │可编程Hook    │ │ 上下文压缩   │ │ 会话管理     │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
├──────────────────────────────────────────────────────────────────┤
│                    门禁执行层（Gate）                              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ TDDGate      │ │ Evidence     │ │ Framework    │             │
│  │ TDD强制门禁  │ │ Verifier     │ │ Compliance   │             │
│  │ RED-GREEN    │ │ 证据验证器   │ │ 合规检查器   │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ Design       │ │ Generator    │ │ Deviation    │             │
│  │ SkillEngine  │ │ Verifier     │ │ Approval     │             │
│  │ 设计技能引擎 │ │ 生成器验证   │ │ 偏差审批     │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
├──────────────────────────────────────────────────────────────────┤
│                    安全权限层（Permission）                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ RBACEnforcer │ │Permission    │ │ Audit        │             │
│  │ 角色访问控制 │ │Guard         │ │ Logger       │             │
│  │ strict/rec/  │ │ 文件权限守卫 │ │ 审计日志     │             │
│  │ optional分级 │ │ 路径遍历防护 │ │ 链式哈希     │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
├──────────────────────────────────────────────────────────────────┤
│                    Agent管理层                                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ AgentRuntime │ │ Agent        │ │ Agent        │             │
│  │ Agent运行时  │ │ Lifecycle    │ │ Monitor      │             │
│  │ 注册/资源    │ │ 生命周期控制 │ │ 反模式检测   │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ AgentSandbox │ │ AgentState   │ │ Agent        │             │
│  │ 沙箱隔离     │ │ Manager      │ │ Deployment   │             │
│  └──────────────┘ │ 状态快照     │ │ 部署管理     │             │
│                    └──────────────┘ └──────────────┘             │
├──────────────────────────────────────────────────────────────────┤
│                    基础设施层                                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ EventBus     │ │ Health       │ │ Token        │             │
│  │ 事件总线     │ │ Checker      │ │ Manager      │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ MemoryStore  │ │ SqliteStore  │ │ MCPClient    │             │
│  │ JSON持久化   │ │ SQLite存储   │ │ MCP协议客户端│             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ RetryEngine  │ │ Checkpoint   │ │ Shared       │             │
│  │ 指数退避重试 │ │ Manager      │ │ Infrastructure│             │
│  └──────────────┘ │ 检查点管理   │ │ 共享基础设施 │             │
│                    └──────────────┘ └──────────────┘             │
└──────────────────────────────────────────────────────────────────┘
```

## 模块依赖关系

### 初始化顺序（90+个模块实例）
1. **配置验证** → validateConfig
2. **核心模块** → SkillRouter, SessionManager, PhaseOrchestrator, RBACEnforcer, PermissionGuard, AuditLogger, TDDGate, EvidenceVerifier, EventBus, PluginManager, HealthChecker, StructuredLogger, MemoryStore, AgentChannel, CheckpointManager, RetryEngine, SkillImprover, ConcurrencyController, AdversarialReview, PlatformCoordinator, WorkflowTemplate, FrameworkComplianceChecker, DeviationApproval, CodeReviewFrameworkCheck, DesignSkillEngine
3. **路由和Hook** → CommandRouter, ProgrammableHookExecutor, ContextCompressionEngine, AgentPackManager
4. **思维模块** → ThoughtExtractor, ThoughtDeduplicator, EmbeddingService, ThoughtMemoryStore, ModelSelector, ThoughtRetrieverCycle
5. **存储模块** → SqliteStore, SkillImprovementLoop, MemoryNudge, SkillCreationEngine, SkillCurator, UserModelManager, MCPClient
6. **Agent模块** → AgentRuntime, AgentSandbox, AgentStateManager, AgentMonitor, AgentDeployment, AgentWorkflowIntegration, AgentLifecycleController
7. **深化模块** → TokenManager, DeepeningModuleRegistry(懒加载21个子模块), SkillReducer, GeneratorVerifier, IsolatedContextManager, PlanPersistence
8. **协作模块** → CollaborationModeRouter, StructuredIntent, SubagentExecutor, PairChat, ChatChain
9. **目标模块** → GoalExecutor, PhaseContextInjector, CausalDataBus, CausalMemoryStore, ConfigCausalValidator
10. **事件注册** → 健康检查注册(30+项), 审计中间件, 会话事件

> **注意**：SkillEvolver为可选模块，不在启动时自动实例化，需手动启用后方可使用。跨Agent技能共享通过CausalDataBus广播实现，会话轨迹自动录制由AgentRuntime事件驱动。

### 核心数据流

```
用户请求 → CommandRouter(命令解析) → SkillRouter(技能匹配)
    → PhaseOrchestrator(阶段验证) → RBACEnforcer(权限检查)
    → ProgrammableHookExecutor(前置Hook) → SubagentExecutor(子Agent执行)
    → GoalExecutor(目标迭代) / CollaborationModeRouter(协作模式)
    → DeepeningOrchestrator(深化推理) → QualityScorer(质量评分)
    → EvidenceVerifier(证据验证) → TDDGate(TDD门禁)
    → ProgrammableHookExecutor(后置Hook) → 结果返回
```

## 六阶段执行流程

| 阶段 | 名称 | 核心Skill | 预算 | 关键门禁 |
|------|------|----------|------|---------|
| 1 | 需求探索 | brainstorming | 5% | - |
| 2 | 需求分析 | requirement-analysis | 10% | - |
| 3 | 架构设计 | architecture-design, design-md | 20% | 设计规范落地 |
| 4 | 模块开发 | tdd-implement, module-development | 35% | TDD门禁(strict) |
| 5 | 集成测试 | integration-testing | 20% | 证据验证 |
| 6 | 部署上线 | deployment, documentation | 10% | 完成前验证 |

## Agent角色体系（17个）

### 职能型（6个）
| 角色 | 允许工具 | 受限操作 |
|------|---------|---------|
| team-lead | all | file_delete, system_command |
| domain-analyst | read/write/search/web | file_delete, system_command |
| task-worker | read/write/search/run | file_delete, modify_harness_config |
| quality-assurance | read/search/run/web | write_file, file_delete |
| devops-engineer | all | modify_harness_config |
| technical-writer | read/write/search | file_delete, system_command |

### 任务型（5个）
code-reviewer, security-reviewer, build-error-solver, planner, test-writer

### 语言专属审查员（5个）
typescript-reviewer, python-reviewer, go-reviewer, rust-reviewer, java-reviewer

## 技能体系（84个Skill文件）

| 阶段 | 技能 | 强制级别 |
|------|------|---------|
| 需求探索 | brainstorming | recommended |
| 需求分析 | requirement-analysis, necessity-review | recommended |
| 架构设计 | design-md, architecture-design, taste-skill, cloud-ai-blueprint | strict/recommended |
| 模块开发 | tdd-implement, module-development, impeccable, ui-skills, iterative-deepening, multi-agent-fusion, motion-ai-kit, better-icons, ai-prompting | strict/optional |
| 质量保障 | code-review, verification-before-completion, systematic-debugging, bug-fix, security-audit, performance-optimization, refactor-code | strict/recommended |
| 集成测试 | integration-testing | strict |
| 部署上线 | deployment, documentation, auto-doc-generation | strict/recommended |
| 扩展 | writing-skills, dispatching-parallel | optional |

## 错误体系

| 错误类 | 父类 | 用途 |
|--------|------|------|
| HarnessError | Error | 基础错误（code, severity, httpStatus, isRetryable） |
| SessionError | HarnessError | 会话错误 |
| PermissionError | HarnessError | 权限错误 |
| TDDGateError | HarnessError | TDD门禁错误 |
| AgentError | HarnessError | Agent错误 |
| DeepeningError | HarnessError | 深化子系统错误 |
| PipelineError | HarnessError | 管道错误 |
| HookError | HarnessError | Hook错误 |

## Web API端点分类

| 分类 | 端点数 | 前缀 |
|------|--------|------|
| 核心状态 | 11 | /api/overview, /api/agents, /api/skills... |
| 框架信息 | 3 | /api/framework/* |
| 合规检查 | 2 | /api/compliance, /api/workflow-templates |
| 设计系统 | 14 | /api/design/* |
| Agent管理 | 22 | /api/agent-* |
| 深化子系统 | 40+ | /api/deepening/* |
| 子Agent | 4 | /api/subagent/* |
| 协作模式 | 10 | /api/collaboration/*, /api/intent/*, /api/pair-chat/*, /api/chat-chain/* |
| 技能管理 | 8 | /api/skill-* |
| 存储记忆 | 7 | /api/sqlite/*, /api/memory/* |
| 目标执行 | 3 | /api/goal/* |
| 其他 | 20+ | /api/checkpoints, /api/learnings, /api/thoughts/*, /api/model-selector/*... |

## 图谱编译子系统（Graphify）

Graphify子系统（`src/runtime/graphify/`，7文件）是运行时引擎的图谱编译管线，提供从源码到知识图谱的全自动编译能力，与GraphRAG集成实现向后兼容降级。

### 模块清单

| 模块 | 文件 | 核心能力 |
|------|------|---------|
| GraphifyCompiler | graphify-compiler.js | 7阶段管线（detect→ingest→build→cluster→analyze→report→export），增量编译，成本追踪，Manifest管理 |
| FileTypeDetector | file-type-detector.js | 40+扩展名映射，批量检测，自定义映射 |
| AstParser | ast-parser.js | tree-sitter可选+regex降级，支持JS/TS/Python |
| SemanticExtractor | semantic-extractor.js | LLM语义提取，多模态支持，并行批处理，Token成本追踪 |
| LouvainClusterer | louvain-clusterer.js | Louvain社区发现，两阶段模块度优化，层次聚类，可配置分辨率 |
| GraphBuilder | graph-builder.js | AST+语义合并，跨文件引用解析，边去重 |
| GraphQueryEngine | graph-query-engine.js | 4种优化策略（分类索引/选择性优先/双向搜索/缓存物化），路径查找，子图提取，架构概览 |

### 与GraphRAG的集成

GraphRAG通过`attachGraphifyCompiler()`方法附加GraphifyCompiler实例，查询时优先使用Graphify编译产出的图谱数据，当Graphify不可用时自动降级到原有正则提取逻辑，确保向后兼容。

### 编译管线流程

```
源码文件 → FileTypeDetector(类型检测) → AstParser(AST解析) + SemanticExtractor(语义提取)
    → GraphBuilder(图谱构建) → LouvainClusterer(社区发现) → GraphQueryEngine(查询服务)
```

## SDD规范驱动子系统

SDD（Specification-Driven Development）子系统（`src/runtime/sdd/`，4文件）是运行时引擎的规范驱动开发管线，通过四文档合约（propose→spec→design→tasks）和铁律引擎强制执行架构约束，与FrameworkComplianceChecker集成实现合约完整性检查。

### 模块清单

| 模块 | 文件 | 核心能力 |
|------|------|---------|
| SddContractManager | sdd-contract-manager.js | 四文档合约（propose→spec→design→tasks），阶段推进验证门禁，合约归档 |
| IronRuleEngine | iron-rule-engine.js | 10+内置铁律（跨层调用/直接DB/硬编码密钥等），自定义规则，违规追踪，规则启停，addPatternRule()模式规则生成，getRuleEffectiveness()/recordRuleOutcome()规则效果追踪 |
| SddDocumentValidator | sdd-document-validator.js | 必需章节检查，12项质量门禁，文档模板，跨阶段一致性 |
| SddPhaseBridge | sdd-phase-bridge.js | SDD阶段→执行阶段映射（propose→brainstorming, spec→requirement-analysis, design→architecture-design, tasks→module-development），合约门禁强制执行 |

### 与FrameworkComplianceChecker的集成

FrameworkComplianceChecker通过`attachSddContractManager()`方法附加SddContractManager实例，`checkSddContractComplete()`方法在合规检查时验证SDD合约完整性，确保开发流程遵循规范驱动约束。

### SDD合约生命周期

```
需求提出 → propose(提案文档) → spec(规格文档) → design(设计文档) → tasks(任务文档)
    → SddPhaseBridge(阶段映射) → PhaseOrchestrator(执行阶段) → IronRuleEngine(铁律校验)
    → SddDocumentValidator(文档验证) → FrameworkComplianceChecker(合规检查)
```

## Hermes自改进架构

Hermes自改进架构是v2.72.0引入的闭环自学习系统，通过"反思→规则生成→预防注入→经验沉淀"的自动循环，实现框架从历史错误中持续学习和自我强化的能力。

### 核心模块

| 模块 | 文件 | 子系统 | 核心能力 |
|------|------|--------|---------|
| AutoReinLearningLoop | auto-rein-learning-loop.js | quality | 连接反思→规则生成，5个内置规则模板（null-check/error-handling/resource-cleanup/unbounded-collection/hardcoded-delay），模式匹配→IronRuleEngine.addPatternRule()+ErrorPreventionGuard.registerErrorPattern() |
| PostTaskReviewer | post-task-reviewer.js | quality | 任务后自动审查钩子，任务完成后触发：SelfReflection→AutoReinLearningLoop→MemoryPipeline→DreamBridge |
| SkillMemoryStore | skill-memory-store.js | skill | Per-skill持久化经验存储，tips/avoidances/patterns按技能分类，相似技能间经验迁移，效果追踪与自动修剪 |

### 增强模块

| 模块 | 新增能力 |
|------|---------|
| IronRuleEngine | addPatternRule()模式规则生成，_generateCheckFromPattern()从模式生成检查函数，getRuleEffectiveness()规则效果评估，recordRuleOutcome()规则结果记录 |
| ErrorPreventionGuard | autoRegisterFromReflection()自反思自动注册+3个辅助方法，从SelfReflection输出自动提取并注册错误模式 |
| DreamBridge | 新增2条桥接规则：SelfReflection→ErrorPreventionGuard（反思结果自动注入预防守卫）、ErrorPreventionGuard→IronRuleEngine（预防模式自动转化为铁律） |

### 自改进闭环流程

```
任务完成 → PostTaskReviewer(自动审查钩子)
    → SelfReflection(自反思/证伪)
    → AutoReinLearningLoop(模式匹配+规则生成)
        → IronRuleEngine.addPatternRule()(铁律注册)
        → ErrorPreventionGuard.registerErrorPattern()(预防模式注册)
    → MemoryPipeline(经验沉淀)
    → DreamBridge(桥接分发)
        → SelfReflection→ErrorPreventionGuard(反思→预防)
        → ErrorPreventionGuard→IronRuleEngine(预防→铁律)
```

### 质量子系统统一导出

`src/runtime/quality/index.js` 提供质量子系统统一导出入口，包含所有15个模块的便捷引用。

## Context Engineering子系统

Context Engineering子系统是v2.72.0引入的上下文工程融合子系统，通过"折叠→查询→适配→预算"四层架构实现上下文的高效管理和精准投递，将上下文从被动载体升级为可编程资源。该子系统跨`src/runtime/context/`和`src/runtime/skill/`两个目录，由4个新增模块和5个增强模块组成。

### 新增模块

| 模块 | 文件 | 子系统 | 核心能力 |
|------|------|--------|---------|
| ContextFoldProtocol | context-fold-protocol.js | context | 三种折叠策略（conclusion-only/structured-summary/key-decisions），折叠/展开与归档，Token节省追踪 |
| PlaybookQueryEngine | playbook-query-engine.js | skill | 运行时Playbook查询，任务签名匹配，反馈驱动自动更新，Top-K相关性排序 |
| SkillToolAdapter | skill-tool-adapter.js | skill | L1摘要→LLM工具定义映射，按需L2/L3加载，"技能即工具"范式 |
| AttentionBudgetManager | attention-budget-manager.js | context | 四维信号评分（时效性/相关性/重要性/效用），五级信号分类（CRITICAL/HIGH/MEDIUM/LOW/NOISE），预算优化上下文选择 |

### 增强模块

| 模块 | 新增能力 | 集成模块 |
|------|---------|---------|
| SubagentExecutor | attachFoldProtocol() + _handleSuccess折叠逻辑 | ContextFoldProtocol |
| IsolatedContextManager | 折叠协议集成 + unfoldResult() | ContextFoldProtocol |
| PromptBuilder | attachSkillToolAdapter() + attachSkillRouter() + L1-only注入 | SkillToolAdapter, SkillRouter |
| PlaybookGenerator | attachQueryEngine() + 自动注册生成Playbook | PlaybookQueryEngine |
| ContextCompressionEngine | attachAttentionBudgetManager() + 信号级别影响压缩 | AttentionBudgetManager |

### 四层架构流程

```
上下文输入 → AttentionBudgetManager(预算分配/信号评分)
    → ContextFoldProtocol(折叠压缩/策略选择)
    → PlaybookQueryEngine(经验查询/签名匹配)
    → SkillToolAdapter(工具适配/按需加载)
    → 精准上下文投递给LLM
```

### 与KEPA自学习闭环的关系

Context Engineering子系统与KEPA闭环互补：
- **KEPA**聚焦"技能演化→模式提取→生命周期管理"的自学习闭环
- **Context Engineering**聚焦"折叠→查询→适配→预算"的上下文精准投递
- 两者协同：KEPA从经验中演化技能，Context Engineering确保技能在有限上下文窗口内被高效投递

## KEPA自学习闭环（v2.72.0引入）

KEPA（Knowledge-Evolution-Pattern-Adaptation）自学习闭环是v2.72.0引入的三环自学习架构，在Hermes自改进架构基础上进一步扩展，通过"技能演化→模式提取→生命周期管理"三个闭环实现框架从经验中持续自动学习和自我完善的能力。

### 三环架构

| 闭环 | 优先级 | 核心模块 | 文件 | 功能 |
|------|--------|---------|------|------|
| P0: SkillEvolver Bridge | P0 | SkillEvolver + SkillCreationEngine | skill-evolver.js | 技能演化闭环：SkillEvolver通过attachSkillCreationEngine()桥接newSkills输出到SkillCreationEngine，_processNewSkills()自动注册演化产生的新技能 |
| P1: PromptPatternExtractor | P1 | PromptPatternExtractor + PromptBuilder | prompt-pattern-extractor.js | 模式提取闭环：从执行历史提取prompt→result高效模式，通过PromptBuilder.attachPatternExtractor()注入，自动推荐和注入高效提示词模式 |
| P2: SkillRetirementManager | P2 | SkillRetirementManager | skill-retirement-manager.js | 生命周期闭环：技能生命周期管理（active→retired→archived），退休条件评估（低效能/低频使用/被替代），reactivation重新激活，退休审计追踪 |

### 闭环流程

```
执行历史 → PromptPatternExtractor(模式提取) → PromptBuilder(高效模式注入)
    → SkillEvolver(技能演化) → _processNewSkills() → SkillCreationEngine(新技能注册)
    → SkillRetirementManager(生命周期管理) → 退休/归档/重新激活
    → 反馈闭环 → 执行历史更新
```

### 与Hermes自改进架构的关系

KEPA闭环是Hermes自改进架构的扩展和增强：
- **Hermes**聚焦"反思→规则生成→预防注入→经验沉淀"的错误预防闭环
- **KEPA**聚焦"技能演化→模式提取→生命周期管理"的自学习闭环
- 两者互补：Hermes从错误中学习，KEPA从成功经验中演化

## Meta Skill子系统

Meta Skill子系统（`src/runtime/skill/`，3文件）是v2.72.0引入的元技能编排与自动生成子系统，通过"编排→数据传递→模式生成"三层架构实现技能链的自动化编排和元技能的自动生成，与SkillCreationEngine集成实现新技能的自动注册。

### 模块清单

| 模块 | 文件 | 核心能力 |
|------|------|---------|
| MetaSkillOrchestrator | meta-skill-orchestrator.js | 元技能编排层。planChain(技能解析+拓扑排序+模型路由+Token预算分配)，executeChain/executeChainAsync(同步/异步执行+因果数据传递+并行执行+失败处理)，cancelChain，getChainStatus |
| CausalDataPasser | causal-data-passer.js | 运行时因果数据传递。collectOutputs(收集causal_outputs)，injectInputs(注入causal_inputs)，validateCausalChain(验证数据完整性)，getData/clearData |
| MetaSkillGenerator | meta-skill-generator.js | 元技能自动生成。recordExecution(记录执行模式)，detectAndGenerate(检测高频组合→生成元技能定义)，getPatternStats，getGeneratedSkills，自动注册到SkillCreationEngine |

### 与KEPA自学习闭环的关系

Meta Skill子系统与KEPA闭环互补：
- **KEPA**聚焦"技能演化→模式提取→生命周期管理"的自学习闭环
- **Meta Skill**聚焦"技能链编排→因果数据传递→元技能自动生成"的编排与生成
- 两者协同：KEPA从经验中演化技能，Meta Skill从高频组合中自动生成元技能并编排执行

### 元技能编排流程

```
用户请求 → MetaSkillOrchestrator.planChain(技能解析+拓扑排序+模型路由+Token预算分配)
    → CausalDataPasser.collectOutputs(收集前序技能输出)
    → CausalDataPasser.injectInputs(注入后续技能输入)
    → MetaSkillOrchestrator.executeChain/executeChainAsync(同步/异步执行)
    → CausalDataPasser.validateCausalChain(验证数据完整性)
    → MetaSkillGenerator.recordExecution(记录执行模式)
    → MetaSkillGenerator.detectAndGenerate(检测高频组合→生成元技能定义)
    → SkillCreationEngine(自动注册新元技能)
```

## 测试体系

| 指标 | 数值 |
|------|------|
| 测试文件 | 120+个 |
| 测试用例 | 5325+ |
| 测试套件 | 370+ |
| 覆盖模块 | runtime, gate, permission, web, utils |
| ESLint | 0 errors, 0 warnings |
| 框架合规性 | 0 errors, compliant |

## GPT-5.6 大上下文适配子系统

GPT-5.6（iris-alpha）融合引入的大上下文适配子系统，通过"双推理模式→三层记忆→批处理调度→指令安全"四模块协同架构，实现1.5M上下文窗口的高效利用和安全防护。该子系统跨`src/runtime/model/`、`src/runtime/context/`、`src/runtime/security/`三个目录，由4个新增模块和2个增强模块组成。

### 新增模块

| 模块 | 文件 | 子系统 | 核心能力 |
|------|------|--------|---------|
| InferenceModeManager | inference-mode-manager.js | model | 双推理模式管理：xhigh（高精度，max 30s延迟，premium层级，L3技能加载）与fast（超低延迟<200ms，economy层级，L1技能加载），任务复杂度自动切换，手动覆盖，历史追踪，ModelSelector/SkillReducer集成 |
| ThreeTierMemoryManager | three-tier-memory-manager.js | context | 三层分级记忆架构：immediate（50K tokens，20条，5min保留）→ short-term（200K tokens，100条，1h保留）→ long-term（1.25M tokens，500条，无限保留），自动晋升/降级，重要性淘汰，1.5M总预算 |
| BatchScheduler | batch-scheduler.js | model | 动态批处理调度：优先级队列（CRITICAL/HIGH/NORMAL/LOW），请求类型分类（long-text/short-text/code/tool-call），类型亲和批处理，max 10请求/批次，完成回调分发 |
| InstructionFragmentDetector | instruction-fragment-detector.js | security | 指令碎片攻击检测：5种威胁模式（role-injection/data-exfiltration/code-execution/permission-escalation/indirect-injection），5级威胁等级（none/low/medium/high/critical），滑动窗口聚合+时间衰减，跨类别增强（+0.15），会话级威胁追踪 |

### 增强模块

| 模块 | 新增能力 |
|------|---------|
| ModelSelector | 3个GPT-5.6模型条目（iris-alpha/beacon-alpha/ember-alpha，1.5M/800K上下文窗口），inferenceModes字段，getInferenceModeForTask()任务推理模式匹配，setPreferredTier()偏好层级设置 |
| CostAwareRouter | analyzeComplexity()新增inferenceMode参数，xhigh→premium路由，fast→economy路由 |

### 大上下文适配流程

```
用户请求 → ModelSelector(GPT-5.6模型匹配+推理模式选择)
    → InferenceModeManager(双模式管理+复杂度评估)
        → xhigh模式 → L3技能加载 + premium路由
        → fast模式 → L1技能加载 + economy路由
    → ThreeTierMemoryManager(三层记忆管理)
        → immediate → short-term → long-term 自动晋升
        → long-term → short-term → immediate 自动降级
    → BatchScheduler(批处理调度)
        → 优先级分类 → 类型亲和 → 批处理执行
    → InstructionFragmentDetector(指令安全检测)
        → 威胁模式检测 → 威胁等级评估 → 安全拦截
```

### 与KEPA自学习闭环的关系

GPT-5.6大上下文适配子系统与KEPA闭环互补：
- **KEPA**聚焦"技能演化→模式提取→生命周期管理"的自学习闭环
- **GPT-5.6适配**聚焦"双推理模式→三层记忆→批处理调度→指令安全"的大上下文高效利用
- 两者协同：KEPA从经验中演化技能，GPT-5.6适配确保技能在1.5M上下文窗口内被高效调度和安全执行

## Auto Research 自主优化闭环

Auto Research自主优化闭环是统一自主优化子系统，通过AutonomousOptimizationOrchestrator编排5个核心组件，实现"观察→分析→假设→实验→评估→应用"六阶段闭环的持续自主优化能力。该子系统跨`src/runtime/optimization/`和`src/runtime/prompt/`两个目录，由1个新增模块和1个增强模块组成。

### 5组件覆盖表

| 组件 | 子系统 | 核心能力 |
|------|--------|---------|
| SkillImprovementLoop | skill | 技能改进循环：持续迭代优化，飞轮三道门验证（成功率阈值→回测→AB测试），蒸馏-eval闭环 |
| DreamEngine | thought | 做梦引擎：离线经验提炼、模式发现、知识整合 |
| SkillEvolver | skill | 技能演化器：技能自动进化、变异生成、适应度评估、attachSkillCreationEngine()桥接新技能注册 |
| PromptABTestFramework | prompt | 提示词A/B测试：实验生命周期管理（draft/running/paused/completed/cancelled），Z-test统计显著性分析（90%/95%/99%置信度），5种指标类型（success-rate/quality-score/latency/token-usage/custom） |
| EffectivenessOptimizer | optimization | 效能优化器：效能评估与优化策略执行 |

### 新增模块

#### AutonomousOptimizationOrchestrator

| 属性 | 值 |
|------|-----|
| 文件 | src/runtime/optimization/autonomous-optimization-orchestrator.js |
| 子系统 | optimization |
| 闭环阶段 | OBSERVE→ANALYZE→HYPOTHESIZE→EXPERIMENT→EVALUATE→APPLY（6阶段） |
| 优化目标 | prompt/skill/workflow/strategy（4种） |
| 核心方法 | startOptimizationLoop(), observe(), analyze(), hypothesize(), experiment(), evaluate(), apply(), attachComponent() |
| 自动应用 | 置信度阈值（autoApplyThreshold默认0.9） |

#### PromptABTestFramework

| 属性 | 值 |
|------|-----|
| 文件 | src/runtime/prompt/prompt-ab-test-framework.js |
| 子系统 | prompt |
| 实验状态 | draft/running/paused/completed/cancelled（5种） |
| 指标类型 | success-rate/quality-score/latency/token-usage/custom（5种） |
| 核心方法 | createExperiment(), startExperiment(), assignVariant(), recordResult(), analyzeExperiment(), completeExperiment() |
| 统计分析 | Z-test，90%/95%/99%置信度阈值 |

### Auto Research闭环流程

```
观察数据 → OBSERVE(指标采集+上下文记录)
    → ANALYZE(模式提取+洞察生成)
    → HYPOTHESIZE(假设生成+置信度评估)
    → EXPERIMENT(AB测试+组件挂载)
        → PromptABTestFramework(prompt优化实验)
        → SkillImprovementLoop(skill改进实验)
        → DreamEngine(模式发现实验)
        → SkillEvolver(技能演化实验)
        → EffectivenessOptimizer(效能优化实验)
    → EVALUATE(统计显著性分析+胜者判定)
    → APPLY(置信度阈值自动应用+优化落地)
    → 反馈闭环 → 观察数据更新
```

### 与KEPA自学习闭环的关系

Auto Research自主优化闭环与KEPA闭环互补：
- **KEPA**聚焦"技能演化→模式提取→生命周期管理"的自学习闭环
- **Auto Research**聚焦"观察→分析→假设→实验→评估→应用"的自主优化闭环
- 两者协同：KEPA从经验中演化技能，Auto Research通过科学实验方法论验证和应用优化假设

## Google Cloud 5 Agent Skill Design Patterns 适配

基于Google Cloud 5 Agent Skill Design Patterns，框架已实现全部5种模式的适配覆盖，通过新增StructuredOutputGenerator（Pattern #2 Generator）和PipelineAuditTrail（Pattern #5 Pipeline）两个模块，补全了设计模式的全覆盖。

### 5种模式覆盖表

| 模式 | 名称 | 覆盖模块 | 子系统 | 核心能力 |
|------|------|---------|--------|---------|
| Pattern #1 | Router（路由器） | SkillRouter | skill | 三层缓存匹配、语义路由、否定模式检测、Top-K选择 |
| Pattern #2 | Generator（生成器） | StructuredOutputGenerator | generation | 7种输出格式、4个内置模板、输入验证、HTML消毒、输出验证回调 |
| Pattern #3 | Orchestrator（编排器） | PhaseOrchestrator, DeepeningOrchestrator, MetaSkillOrchestrator | workflow/deepening/skill | 六阶段编排、深化推理编排、元技能编排 |
| Pattern #4 | Agent（自主代理） | AgentRuntime, AgentLifecycleController, GoalExecutor | agent/workflow | Agent生命周期、自主迭代收敛、目标分解 |
| Pattern #5 | Pipeline（管道） | PipelineExecutor, PipelineAuditTrail | workflow | 管道执行、步骤级审计追踪、Mermaid流程图导出 |

### 新增模块

#### StructuredOutputGenerator（Pattern #2 Generator）

| 属性 | 值 |
|------|-----|
| 文件 | src/runtime/generation/structured-output-generator.js |
| 子系统 | generation |
| 输出格式 | JSON/MARKDOWN/TABLE/FORM/REPORT/EMAIL/PLAN（7种） |
| 内置模板 | report/email/plan/json（4个） |
| 核心方法 | registerTemplate(), generate(), getTemplate(), listTemplates(), getStats() |
| 安全特性 | HTML消毒（_sanitizeValues）、输入验证（_validateInputs）、输出验证回调（validateOutput） |

#### PipelineAuditTrail（Pattern #5 Pipeline）

| 属性 | 值 |
|------|-----|
| 文件 | src/runtime/workflow/pipeline-audit-trail.js |
| 子系统 | workflow |
| 步骤状态 | pending/running/completed/failed/skipped/rolled-back（6种） |
| 核心方法 | createTrail(), recordStep(), completeTrail(), rollbackTrail(), getStepTimeline(), exportMermaid() |
| 数据捕获 | 输入/输出捕获与截断（maxCaptureSize可配置） |
| 可视化 | Mermaid流程图导出（exportMermaid）、步骤时间线（getStepTimeline） |

### 模式-模块映射图

```
┌─────────────────────────────────────────────────────────────┐
│              Google Cloud 5 Agent Skill Design Patterns      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Pattern #1: Router                                         │
│  ┌──────────────┐                                           │
│  │ SkillRouter  │ 三层缓存匹配 → 语义路由 → Top-K选择       │
│  └──────┬───────┘                                           │
│         │                                                   │
│  Pattern #2: Generator                                      │
│  ┌──────────────────────────┐                               │
│  │ StructuredOutputGenerator│ 7格式 → 4模板 → 验证 → 输出   │
│  └──────────┬───────────────┘                               │
│             │                                               │
│  Pattern #3: Orchestrator                                   │
│  ┌──────────────────┐ ┌──────────────────┐                  │
│  │PhaseOrchestrator │ │Deepening         │                  │
│  │六阶段编排        │ │Orchestrator      │                  │
│  └────────┬─────────┘ │深化推理编排       │                  │
│           │            └──────────────────┘                  │
│           │                                                  │
│  Pattern #4: Agent                                          │
│  ┌──────────────┐ ┌──────────────────┐                      │
│  │ AgentRuntime │ │ GoalExecutor     │                      │
│  │ Agent生命周期│ │ 自主迭代收敛      │                      │
│  └──────┬───────┘ └──────────────────┘                      │
│         │                                                   │
│  Pattern #5: Pipeline                                       │
│  ┌──────────────────┐ ┌──────────────────┐                  │
│  │PipelineExecutor  │ │PipelineAuditTrail│                   │
│  │管道执行          │ │步骤级审计追踪    │                    │
│  └──────────────────┘ └──────────────────┘                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 多Agent跨机器交互（OpenClaw融合）

基于OpenClaw跨机器交互理念，框架新增多Agent跨机器交互子系统，通过"传输层→调度层→协作层→资源层→安全层"五组件协同架构，实现多Agent跨机器的高效通信、资源感知调度和可靠协作。

### 5组件覆盖表

| 组件 | 模块 | 子系统 | 核心能力 |
|------|------|--------|---------|
| 传输层 | CrossMachineTransport | collaboration | 跨机器通信传输：3种角色（coordinator/worker/peer）、9种消息类型（task-assign/task-result/heartbeat/resource-report/agent-register/agent-deregister/state-sync/broadcast/direct）、4种连接状态、HMAC-SHA256认证、心跳保活、自动重连、BoundedMap/BoundedArray内存限制 |
| 调度层 | DistributedTaskScheduler | workflow | 资源感知分布式任务调度：4种调度策略（round-robin/least-loaded/resource-match/latency-aware）、7种任务状态（pending/dispatched/running/completed/failed/cancelled/timeout）、5种资源类型（cpu/gpu/memory/disk/network）、Worker注册/注销、任务重试、超时处理、Worker丢失恢复 |
| 协作层 | CollaborationModeRouter | collaboration | 协作模式路由：6种模式（solo/generator-verifier/orchestrator-subagent/agent-teams/message-bus/shared-state），Multi-Agent适用性决策门禁 |
| 资源层 | AgentContributionTracker | collaboration | Agent贡献度追踪：权重/置信度记录、特征重要性输出、Top贡献者排名、集成模式分布统计 |
| 安全层 | ToolCallSecurityChain | security | 工具调用安全链：9层安全链(3层级)、Auto≤10ms快速路径、AST代码注入检测、Prompt注入检测(R47)、人工审批门 |

### 新增模块

#### CrossMachineTransport（传输层）

| 属性 | 值 |
|------|-----|
| 文件 | src/runtime/collaboration/cross-machine-transport.js |
| 子系统 | collaboration |
| 角色 | coordinator/worker/peer（3种） |
| 消息类型 | task-assign/task-result/heartbeat/resource-report/agent-register/agent-deregister/state-sync/broadcast/direct（9种） |
| 连接状态 | disconnected/connecting/connected/reconnecting（4种） |
| 认证方式 | HMAC-SHA256 |
| 核心方法 | connect(), disconnect(), send(), broadcast(), registerAgent(), deregisterAgent() |
| 可靠性 | 心跳保活、自动重连、BoundedMap/BoundedArray内存限制 |

#### DistributedTaskScheduler（调度层）

| 属性 | 值 |
|------|-----|
| 文件 | src/runtime/workflow/distributed-task-scheduler.js |
| 子系统 | workflow |
| 调度策略 | round-robin/least-loaded/resource-match/latency-aware（4种） |
| 任务状态 | pending/dispatched/running/completed/failed/cancelled/timeout（7种） |
| 资源类型 | cpu/gpu/memory/disk/network（5种） |
| 核心方法 | submitTask(), registerWorker(), deregisterWorker(), schedule(), retryTask(), cancelTask() |
| 容错 | 任务重试、超时处理、Worker丢失恢复 |

### 跨机器协作架构图

```
┌─────────────────────────────────────────────────────────────┐
│              多Agent跨机器交互子系统（OpenClaw融合）           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  调度层：DistributedTaskScheduler                            │
│  ┌──────────────────────────────────────────────────┐       │
│  │ round-robin │ least-loaded │ resource-match │     │       │
│  │ latency-aware │ Worker注册/注销 │ 任务重试      │     │       │
│  └──────────────────────┬───────────────────────────┘       │
│                         │                                   │
│  传输层：CrossMachineTransport                               │
│  ┌──────────────────────────────────────────────────┐       │
│  │ coordinator → 任务分配+状态同步                    │       │
│  │ worker     → 任务执行+资源上报                    │       │
│  │ peer       → 广播+直连通信                        │       │
│  │ 9种消息类型 │ HMAC-SHA256 │ 心跳保活 │ 自动重连   │       │
│  └──────────────────────┬───────────────────────────┘       │
│                         │                                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ 协作层       │ │ 资源层       │ │ 安全层       │        │
│  │Collaboration │ │Agent         │ │ToolCall      │        │
│  │ModeRouter    │ │Contribution  │ │SecurityChain │        │
│  │6种协作模式   │ │Tracker       │ │9层安全链     │        │
│  └──────────────┘ │贡献度追踪   │ │3层级防护     │        │
│                    └──────────────┘ └──────────────┘        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 跨机器协作流程

```
任务提交 → DistributedTaskScheduler(资源感知调度+策略选择)
    → CrossMachineTransport(跨机器通信+消息路由)
        → coordinator角色 → 任务分配+状态同步
        → worker角色 → 任务执行+资源上报
        → peer角色 → 广播+直连通信
    → CollaborationModeRouter(协作模式路由)
    → AgentContributionTracker(贡献度追踪)
    → ToolCallSecurityChain(安全链校验)
    → 结果聚合 → 反馈闭环
```

## 多Agent协作框架选型融合（v2.34.0融合）

基于6大多Agent协作框架设计模式，框架实现了全覆盖的协作模式适配，通过"单Agent推理→多Agent对话→任务委派"三层架构实现从简单到复杂的全场景协作能力。

### 6大模式覆盖表

| 模式 | 来源框架 | 覆盖模块 | 子系统 | 核心能力 |
|------|---------|---------|--------|---------|
| WAT（Write-Audit-Test） | ChatDev | PairChat, ChatChain | collaboration | 结对编程+交叉验证+链式对话+阶段产物追踪 |
| LangChain-Graph | LangGraph | AgenticPatterns, PlanExecuteEnhancer | patterns | 提示链+路由+并行化+反思循环+规划-执行双架构 |
| ReAct（Reasoning+Acting） | ReAct | ReActAgent | patterns | think→act→observe迭代循环+工具注册+收敛检测 |
| Plan&Execute | Plan-and-Execute | PlanExecuteEnhancer, GoalExecutor | patterns/workflow | 滚动规划+需求边界锁+执行反馈学习桥 |
| AutoGen | AutoGen | GroupChat | collaboration | 多Agent群聊+4种发言者选择策略+终止条件+摘要 |
| CrewAI | CrewAI | TaskBoard | collaboration | 任务委派与认领+4种委派模式+6种任务状态+竞标 |

### 新增模块描述

#### ReActAgent（src/runtime/patterns/react-agent.js）
标准ReAct（Reasoning+Acting）Agent模式，实现think→act→observe迭代循环。支持自定义thinkFn/actFn/observeFn函数注入，工具注册与管理，scratchpad（BoundedArray）记录推理轨迹，toolResults（BoundedMap）存储工具执行结果，收敛检测防止无限循环，超时处理保障资源安全，FINISH_KEYWORDS检测自动终止。

#### GroupChat（src/runtime/collaboration/group-chat.js）
AutoGen灵感多Agent群聊模块，支持4种发言者选择策略（round-robin轮流/random随机/LLM-choice大模型选择/custom自定义），共享对话历史实现上下文传递，暂停/恢复机制控制对话节奏，终止条件自动结束对话，摘要函数生成对话总结，参与者管理动态加入/移除Agent。

#### TaskBoard（src/runtime/collaboration/task-board.js）
CrewAI灵感任务委派与认领模块，支持4种委派模式（manual手动/auto-assign自动分配/claim-based认领/bid-based竞标），6种任务状态（open/claimed/in-progress/completed/failed/cancelled）全生命周期管理，能力注册匹配Agent与任务，竞标提交支持bid-based模式，任务超时自动回收，历史追踪记录任务变更。

### 架构图：6大模式→模块映射

```
┌─────────────────────────────────────────────────────────────┐
│              多Agent协作框架选型融合（6大模式全覆盖）           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  单Agent推理层                                               │
│  ┌──────────────────┐ ┌──────────────────┐                  │
│  │ ReAct            │ │ Plan&Execute     │                  │
│  │ ReActAgent       │ │ PlanExecuteEnhancer│                 │
│  │ think→act→observe│ │ 滚动规划+执行反馈 │                  │
│  └──────────────────┘ └──────────────────┘                  │
│                                                             │
│  多Agent对话层                                               │
│  ┌──────────────────┐ ┌──────────────────┐                  │
│  │ WAT(ChatDev)     │ │ AutoGen          │                  │
│  │ PairChat         │ │ GroupChat        │                  │
│  │ ChatChain        │ │ 4种选择策略      │                  │
│  │ 交叉验证+链式对话│ │ 群聊+摘要+终止   │                  │
│  └──────────────────┘ └──────────────────┘                  │
│                                                             │
│  任务委派层                                                  │
│  ┌──────────────────┐ ┌──────────────────┐                  │
│  │ CrewAI           │ │ LangChain-Graph  │                  │
│  │ TaskBoard        │ │ AgenticPatterns  │                  │
│  │ 4种委派+6种状态  │ │ 提示链+路由+反思 │                  │
│  └──────────────────┘ └──────────────────┘                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 关联文档
- [核心功能-多Agent协作流程](../core/核心功能-多Agent协作流程.md)
- [核心功能-团队编程模式实现方案](../core/核心功能-团队编程模式实现方案.md)
- [模块详解-上下文管理模块](../modules/模块详解-上下文管理模块.md)
- [深度拆解-任务调度执行链路](../deep-dive/深度拆解-任务调度执行链路.md)
- [功能说明-全部模块清单](../modules/功能说明-全部模块清单.md)
- [接口文档-Web API](../tools/接口文档-Web API.md)
- [开发指南-代码贡献规范](../guidelines/开发指南-代码贡献规范.md)
