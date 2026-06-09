# 模块详解-ModuleInitializer系统引导

## 概述

ModuleInitializer 是 Harness 框架的系统引导模块，负责创建和装配运行时所有模块。它导入并实例化50+模块，处理启动计时、级联初始化失败清理（`_cleanup`），以及依赖装配（如将指标收集器和缓存附加到 DeepeningOrchestrator）。它是整个运行时的架构蓝图。

**源码位置**：`src/runtime/infrastructure/module-initializer.js`（376行）

## 架构角色

```
用户请求 → Harness主类 → _initCoreModules()
                            ↓
                    ┌───────────────────────────────────────────┐
                    │ 1. SkillRouter (核心路由)                   │
                    │ 2. SessionManager (会话管理)                │
                    │ 3. RBACEnforcer (权限执行)                   │
                    │ 4. SIMPLE_MODULES (29个简单模块)             │
                    │ 5. CommandRouter + ProgrammableHookExecutor │
                    │ 6. ContextCompressionEngine                 │
                    │ 7. Thought子系统 (6个模块)                   │
                    │ 8. Store子系统 (7个模块)                     │
                    │ 9. Agent子系统 (7个模块)                     │
                    │10. Deepening子系统 (21个模块)                │
                    │11. Collaboration子系统 (5个模块)             │
                    │12. RAGPipeline                              │
                    │13. AutoVersionTracker                       │
                    └───────────────────────────────────────────┘
                            ↓
                    依赖装配（attach链式调用）
```

## 初始化顺序

### 第一阶段：核心模块（关键路径）

| 序号 | 模块 | 初始化方式 | 失败处理 |
|------|------|-----------|---------|
| 1 | SkillRouter | `new` + `discover()` + `watchForChanges()` | 抛出 `INIT_FAILED` |
| 2 | SessionManager | `new` | `_cleanup` + 抛出 `INIT_FAILED` |
| 3 | RBACEnforcer | `new` + `load()` | `_cleanup` + 抛出 `INIT_FAILED` |

### 第二阶段：基础设施

| 模块 | 说明 |
|------|------|
| EventBus | 事件总线 |
| PluginManager | 插件管理器（依赖EventBus） |
| StructuredLogger | 结构化日志（设为debug bridge） |
| MemoryStore | 记忆存储 |
| AgentChannel | Agent通信通道 |

### 第三阶段：SIMPLE_MODULES（29个）

通过 `SIMPLE_MODULES` 数组批量创建，每个条目指定：
- `key`：实例在返回对象中的键名
- `Class`：模块类
- `args`：构造函数参数（`'projectRoot'` 会被替换为实际路径）
- `postInit`：创建后调用的方法名（如 `'discover'`）

包含的模块：PhaseOrchestrator, PermissionGuard, AuditLogger, TDDGate, EvidenceVerifier, EventBus, HealthChecker, StructuredLogger, CheckpointManager, RetryEngine, SkillImprover, ConcurrencyController, AdversarialReview, PlatformCoordinator, WorkflowTemplate, FrameworkComplianceChecker, DeviationApproval, CodeReviewFrameworkCheck, DesignSkillEngine, TokenManager, SkillReducer, GeneratorVerifier, IsolatedContextManager, PlanPersistence, AgentPackManager, ChangelogArchive, SelfReflection, LTIContextInjector, PriorityQueue

### 第四阶段：命令与Hook

| 模块 | 初始化方式 |
|------|-----------|
| CommandRouter | `new` + `discover()` |
| ProgrammableHookExecutor | `new` + `loadFromConfig()` |
| ContextCompressionEngine | `new`（使用配置中的 `context_compression`） |

### 第五阶段：子系统模块

| 子系统 | 函数 | 模块数 |
|--------|------|--------|
| Thought | `_initThoughtModules()` | 6（Extractor, Deduplicator, EmbeddingService, MemoryStore, RetrieverCycle, ModelSelector） |
| Store | `_initStoreModules()` | 7（SqliteStore, SkillImprovementLoop, MemoryNudge, SkillCreationEngine, SkillCurator, UserModelManager, MCPClient） |
| Agent | `_initAgentModules()` | 7（Runtime, Sandbox, StateManager, Monitor, Deployment, WorkflowIntegration, LifecycleController） |
| Deepening | `_extractDeepeningModules()` | 21（通过DeepeningModuleRegistry加载） |
| Collaboration | `_initCollaborationModules()` | 5（ModeRouter, StructuredIntent, SubagentExecutor, PairChat, ChatChain） |

### 第六阶段：依赖装配

DeepeningOrchestrator 的 attach 链：
```
attachMetricsCollector → attachCache → attachStrategyPlugin →
attachReportGenerator → attachConvergenceDetector → attachQualityScorer →
attachEventStore → attachGeneratorVerifier → attachSubagentExecutor →
attachThoughtRetrieverCycle
```

其他装配：
- `AffinityLearner.attachSqliteStore(SqliteStore)`

### 第七阶段：辅助模块

| 模块 | 说明 |
|------|------|
| RAGPipeline | RAG检索管道 |
| AutoVersionTracker | 自动版本追踪（依赖Archive和EventBus） |

## 错误处理

### 级联清理（_cleanup）

当核心模块初始化失败时，`_cleanup(created)` 会遍历已创建的模块并调用：
1. `shutdown()`（优先）
2. `destroy()`（备选）
3. `removeAllListeners()`（最后手段）

### Store子系统容错

Store模块初始化失败不会导致整体崩溃，而是将所有Store相关模块设为 `null`，系统以降级模式运行。

### Agent/Collaboration子系统严格模式

Agent和Collaboration子系统初始化失败会抛出 `INIT_FAILED` 错误，阻止系统启动。

## 启动计时

`startupTimings` 数组记录每个模块的初始化耗时（ms），用于性能监控和优化。

## 设计决策

1. **函数式设计**：使用纯函数而非类，保持无状态
2. **顺序初始化**：核心模块按依赖顺序创建，确保依赖可用
3. **批量创建**：SIMPLE_MODULES 通过循环批量创建，减少重复代码
4. **级联清理**：初始化失败时自动清理已创建的模块，防止资源泄漏
5. **容错降级**：Store子系统失败时降级运行，不阻塞核心功能

## 已知问题

1. **0测试覆盖**：ModuleInitializer 没有单元测试
2. **同步初始化**：所有模块同步创建，启动时间可能较长
3. **大量导入**：70个 `require` 调用，启动时加载所有模块

## 与其他模块的关系

ModuleInitializer 是所有运行时模块的创建者，与每个模块都有直接关系。它被 `Harness` 主类调用。
