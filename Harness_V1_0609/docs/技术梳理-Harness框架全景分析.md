# Harness V1 框架全景技术分析

> 版本：2.73.2 | 更新日期：2026-06-09

---

## 目录

1. [项目整体框架结构分析](#1-项目整体框架结构分析)
2. [核心设计理念阐述](#2-核心设计理念阐述)
3. [完整调用逻辑梳理](#3-完整调用逻辑梳理)
4. [功能效果详细说明](#4-功能效果详细说明)
5. [技术细节文档整理](#5-技术细节文档整理)

---

## 1. 项目整体框架结构分析

### 1.1 目录组织结构

项目顶层目录：

```
Harness_V1_0429/
├── .harness/               # 运行时配置与数据（核心）
│   ├── config.json         # 主配置文件（~2600行）
│   ├── skills/             # 66个技能定义文件（.md）
│   ├── sessions/           # 会话持久化数据
│   └── causal-wal/         # 因果WAL日志
├── docs/                   # 项目文档
├── scripts/                # 运维脚本
├── sdk/python/             # Python SDK
├── src/                    # 源代码（核心，~400+ JS文件）
├── test/                   # 测试代码（~200+ 测试文件）
├── desktop-companion/      # Electron桌面伴侣
├── harness-cli.js          # CLI入口
├── package.json            # 项目配置
└── Dockerfile              # 容器化部署
```

### 1.2 模块划分

src/ 下按功能域划分为 30+ 个子目录，核心模块统计：

| 目录 | 文件数 | 核心模块 |
|------|--------|---------|
| src/runtime/agent/ | 22 | AgentRuntime, AgentLifecycleController, AgentSandbox, MultiAgentRouter |
| src/runtime/skill/ | 34 | SkillRouter, SkillReducer, SkillGraph, SkillEvolver, MetaSkillOrchestrator |
| src/runtime/deepening/ | 50+ | DeepeningOrchestrator, OodaLoop, ConvergenceDetector, AdaptiveDepthController |
| src/runtime/thought/ | 38 | BrainMemory, DreamEngine, MemoryPipeline, GraphRag, TriAttention |
| src/runtime/workflow/ | 36 | PhaseOrchestrator, GoalExecutor, StateGraph, CommandRouter, WorkflowDAG |
| src/runtime/infrastructure/ | 39 | EventBus, ModuleInitializer, MCPClient, SqliteStore, HealthChecker |
| src/runtime/collaboration/ | 13 | EnsembleOrchestrator, MoeGatingRouter, OutputFusion, CollaborationModeRouter |
| src/runtime/model/ | 11 | ModelSelector, CostAwareRouter, TokenManager, KVCacheManager, EmbeddingService |
| src/runtime/quality/ | 20 | QualityScorer, AdversarialReview, SelfReflection, EntropyGovernanceOrchestrator |
| src/runtime/causal/ | 9 | CausalDataBus, CausalVectorIndex, ScenarioPredictor, SimulationEngine |
| src/gate/ | 18 | TDDGate, EvidenceVerifier, FrameworkComplianceChecker, ArchitectureBoundaryEnforcer |
| src/domain/ | 9 | Entity, ValueObject, AggregateRoot, DomainEvent, ContextMapper |
| src/utils/ | 30 | StructuredLogger, BoundedMap, LruCache, SafeExecute, ShutdownMixin |
| src/web/ | 17 | DashboardServer, WebSocketHandler, StaticFileServer, ChangelogArchive |

### 1.3 依赖关系与初始化流程

项目入口为 `src/index.js`，导出策略：

- **静态导出**：~130个模块，require时即加载
- **懒加载导出**：~95个模块，首次访问时才require
- **分组导出**：14个功能命名空间（runtime/agent/gate/permission/infrastructure/collaboration/web/tui/quality/errors/i18n/utils/constants）

初始化流程（`module-initializer.js`）：

```
1. 关键模块初始化 → SkillRouter.discover() + SessionManager + RBACEnforcer
2. 基础设施创建 → EventBus + PluginManager + StructuredLogger + MemoryStore + AgentChannel
3. 批量实例化 → 39个简单模块（TDDGate/EvidenceVerifier/TokenManager/SkillReducer等）
4. 领域映射+MoE门控 → ContextMapper.importFromConfig() + MoeGatingRouter
5. 后核心模块 → CommandRouter + ProgrammableHookExecutor + ContextCompressionEngine
6. 子系统初始化 → Thought/Store/Agent/Deepening/Collaboration/RAG
7. 依赖装配 → DeepeningOrchestrator/PhaseOrchestrator/AffinityLearner
8. 事件注册+健康检查 → EventRegistrar + HealthRegistrar
9. 自演化引擎 → SelfEvolutionGovernor.start()
10. 构建实例 → buildInstance() 返回最终Harness实例
```

失败时自动回滚：`_cleanup(created)` 依次调用各实例的 shutdown/destroy/removeAllListeners。

### 1.4 配置体系

`.harness/config.json` 约2600行，30+顶层配置键：

| 类别 | 配置键 | 说明 |
|------|--------|------|
| 项目元信息 | project_name, version | 项目名称与版本 |
| 运行时参数 | max_concurrent_agents, task_timeout_minutes, token_budget | 并发/超时/预算 |
| 模型配置 | default_model, fallback_models, model_selector_config | 模型选择与降级 |
| Agent配置 | agents(27个), agent_permissions | Agent定义与权限 |
| 技能配置 | skill_registry(84个), skill-distillation, skill-effectiveness | 技能注册与评估 |
| 命令配置 | commands(24个) | 斜杠命令定义 |
| 门禁配置 | tdd_config, verification_config, gate_config | TDD/证据/合规门禁 |
| 深化推理 | deepening_config | 深化推理全量配置 |
| 协作配置 | collaboration_config, moe_config | 集成编排与MoE门控 |
| 权限配置 | permission_config | RBAC/权限守卫/审计 |
| 钩子配置 | hooks(8种) | session_start/pre_tool_call/post_task_complete等 |
| MCP服务器 | mcp_servers(14个) | filesystem/github/postgres/memory/brave-search等 |
| 领域驱动 | bounded_contexts(9个) | 限界上下文定义 |

---

## 2. 核心设计理念阐述

### 2.1 一键设计

**核心思想**：用户只需发出一条自然语言指令，系统自动完成从需求探索到代码交付的全流程。

**技术支撑**：
- SkillRouter自动路由：84个Skill按语义匹配自动选择
- SDD四阶段合约推进：propose→spec→design→tasks
- TDD门禁自动执行：RED-GREEN-REFACTOR循环
- AppRegistry一键连接：15+预配置应用连接器（MCP/Browser/CLI/HTTP/File）

**设计哲学**："一键"的本质是降低认知负荷——用户不需要知道系统内部有28个Agent、84个Skill、6个执行阶段，只需表达意图，系统自动编排。

### 2.2 分层分责

**Agent层级体系**（28个Agent，7大类别）：

| 类别 | 数量 | 角色 | 职责 |
|------|------|------|------|
| 职能型 | 6 | Team Lead, Domain Analyst, Task Worker, QA, Architect, DevOps | 按职能分工 |
| 任务型 | 5 | requirement-explorer → integration-tester | 按六阶段流程分工 |
| 语言审查员 | 5 | JS/TS/Python/Rust/Go Reviewer | 代码质量守门 |
| 专业角色 | 8 | Research/SEO/UX/Data/Security/Performance/DBA/API | 领域专精 |
| 人类角色 | 1 | Human Approver | 关键决策审批 |
| 业务型 | 3 | Product Owner, Stakeholder, End User | 需求侧代表 |

**核心层级**：Team Lead（决策）→ Domain Analyst（分析）→ Task Worker（执行）→ QA（验证）

**分层原则**：
1. 上层决策、下层执行
2. 跨层禁止直接调用（IronRuleEngine的`no-cross-layer-calls`铁律）
3. QA独立验证，不受开发层影响

### 2.3 文档驱动（SDD规范驱动设计）

**四阶段合约流程**：propose → spec → design → tasks

每阶段定义`requiredSections`（必需章节）和`qualityGates`（质量门禁），不通过则拒绝推进。

**核心模块**：

| 模块 | 职责 |
|------|------|
| SddContractManager | 合约创建/推进/追溯矩阵管理/持久化 |
| IronRuleEngine | 10条内置铁律+模式规则+效果追踪+指纹校验 |
| SddDocumentValidator | 章节完整性+质量门禁双重验证 |
| SddPhaseBridge | SDD阶段↔执行阶段双向映射+自动门禁执行 |

**IronRuleEngine 10条铁律**：

| 规则ID | 级别 | 含义 |
|--------|------|------|
| no-cross-layer-calls | CRITICAL | 禁止跨层调用 |
| no-direct-db-access | CRITICAL | 禁止直接DB访问 |
| no-hardcoded-secrets | CRITICAL | 禁止硬编码密钥 |
| no-circular-dependencies | CRITICAL | 禁止循环依赖 |
| no-untyped-parameters | WARNING | 禁止无类型参数 |
| no-sync-io | WARNING | 禁止同步IO |
| no-global-mutation | WARNING | 禁止全局变量修改 |
| require-error-handling | WARNING | 要求错误处理 |
| require-input-validation | WARNING | 要求输入验证 |
| require-shutdown-cleanup | WARNING | 要求关闭清理 |

### 2.4 流程管控（Gate门禁系统）

**TDDGate**：RED-GREEN-REFACTOR强制循环
- 有实现无测试 → VIOLATION
- 有测试无实现 → RED（正常TDD起点）
- 测试通过 → GREEN
- 测试通过+代码变更 → REFACTOR

**EvidenceVerifier**：28种技能的证据需求映射 + 五维度内容质量检查
- 完整性/具体性/一致性/可操作性/记忆-代码一致性
- 强标准（可量化）vs 弱标准（模糊描述，需人工确认）

**FrameworkComplianceChecker**：10类规则体系
- 命名规范(7) + 结构规则(4) + 安全规则(5) + 持久化规则(3) + API规则(4) + 错误处理(3) + Karpathy规则(8) + 设计规则(10) + AI劣质代码(5) + 文档完整性(4)

### 2.5 容错自愈

**四重防护体系**：

| 机制 | 模块 | 核心能力 |
|------|------|---------|
| 优雅关闭 | ShutdownMixin | 混入模式+异步清理+错误类型映射+全项目普及 |
| 安全执行 | safe-execute | 4个安全函数+自动Promise检测+fallback+emitError降级 |
| 重试引擎 | RetryEngine | 三级升级（RETRY→REPLAN→DECOMPOSE）+指数退避+关闭感知休眠 |
| 熔断器 | CircuitBreaker | 三态模型（CLOSED→OPEN→HALF_OPEN）+命名熔断器+强制覆盖 |

### 2.6 因果追踪

**CausalDataBus**：因果数据总线
- WAL持久化：崩溃安全恢复
- 技能接口定义：causalInputs/causalOutputs/invariants
- 并行冲突检测：4种策略（last-wins/first-wins/deepest-wins/union）
- 因果链操作：回滚/完整性验证/自回归上下文

**CausalMemoryStore**：因果内存存储
- 双层存储：内存缓存+SQLite持久化
- 时间衰减：confidence * decayFactor^ageDays
- 加权搜索：similarity*0.6 + decayedConfidence*0.4

**CausalVectorIndex**：因果向量索引
- 嵌入服务集成+降级哈希向量
- 余弦相似度+ComputeAccelerator加速
- 容量管理：最大5000向量，FIFO淘汰

### 2.7 六大理念协同关系

```
用户指令（一键设计）
    │
    ▼
SkillRouter自动路由 ──→ 分层分责（28 Agent协作）
    │                        │
    ▼                        ▼
SDD文档驱动 ────────→ Gate流程管控
(propose→spec→         (TDD门禁 + 证据验证 +
 design→tasks)          框架合规检查)
    │                        │
    ▼                        ▼
容错自愈 ←────────── 因果追踪
(shutdown/safe/       (CausalDataBus +
 retry/circuit)        MemoryStore +
                       VectorIndex)
```

---

## 3. 完整调用逻辑梳理

### 3.1 前后端交互流程

**HTTP API**：210+端点，9个路由模块

| 路由模块 | 端点数 | 核心端点 |
|---------|--------|---------|
| core-routes | 20 | /api/overview, /api/agents, /api/skills, /api/sessions |
| agent-routes | 15 | /api/agent-lifecycle, /api/agent-runtime, /api/subagent |
| skill-routes | 10 | /api/skill-layers, /api/skill-improvement, /api/doc-freshness |
| deepening-routes | 40 | /api/deepening/stats, /api/deepening/cache, /api/deepening/convergence |
| collaboration-routes | 8 | /api/collaboration/modes, /api/channel, /api/pair-chat |
| storage-routes | 10 | /api/sqlite, /api/memory, /api/embedding, /api/mcp |
| infrastructure-routes | 12 | /api/command-router, /api/goal, /api/context-compression |
| code-wiki-routes | 7 | /api/code-wiki/stats, /api/code-wiki/architecture-diagram |
| delivery-routes | 3 | /api/delivery-acceleration |

**WebSocket**：RFC 6455实现
- 认证：SHA-256 Token + timingSafeEqual
- 限制：50客户端/30条每秒/1MB帧
- 广播：所有事件自动桥接到Dashboard

**请求处理链**：

```
HTTP请求 → 安全头(CSP/HSTS) → 超时设置 → URL长度检查 → 方法白名单
→ 速率限制(IP滑动窗口) → Bearer Token认证 → CORS检查 → 路由分发
→ 业务逻辑 → JSON序列化 → 压缩(brotli>gzip>deflate) → 响应
```

### 3.2 核心函数调用关系

**用户消息 → Agent处理 → 响应**：

```
用户消息
  → CommandRouter.route()           # 斜杠命令匹配
  → StructuredIntent.parse()        # 意图解析
  → CollaborationModeRouter.select() # 协作模式选择
  → SkillRouter.match()             # 技能匹配
    → _findMatchingSkills()         # 语义+触发条件+否定模式
    → _applySpecBoost()             # 规格加权
    → 模型分级过滤(MODEL_TIERS)     # small/medium/large
    → checkDependencies()           # 依赖检查
  → AgentRuntime.execute()          # Agent执行
    → ModelSelector.select()        # 模型选择
    → SkillReducer.activateForTask() # 技能L2激活
    → SubagentExecutor.execute()    # 子代理执行
  → SessionManager.completeSkill()  # 完成记录
    → CausalDataBus.publishOutput() # 因果输出发布
```

**技能匹配 → 加载 → 执行**：

```
SkillRouter.match() → SkillDef[]
  → SkillReducer.activateForTask()
    → discover() → L1摘要(始终在内存)
    → _loadL2() → L2指令(按需加载)
    → _loadL3With() → L3资源(按需加载)
  → 执行
  → SkillReducer.deactivateAfterTask() → 延迟卸载L2
```

**目标创建 → 分解 → 执行 → 验证**：

```
GoalExecutor.createGoal()
  → _decomposeGoal() → 子任务列表
    → TaskDecomposer.decompose()
      → _inferStrategy() → sequential/parallel/mixed/pipeline
      → _buildDependencyGraph()
  → 顺序执行子任务
    → SubagentExecutor.execute()
    → DeepeningOrchestrator.orchestrate() # 可选深化
  → _verifyGoal()
    → QualityScorer.score()
    → ConvergenceDetector.check()
  → 状态转换: running → completed/failed
```

### 3.3 数据流转路径

**会话数据**：

```
SessionManager.create() → 内存sessions[id] + 原子写入.harness/sessions/{id}.json
advancePhase() → 更新内存 + 持久化 + emit('phase-change')
  → CheckpointManager.create() + PhaseContextInjector.injectForPhase()
completeSkill() → 更新内存 + 持久化 + emit('skill-complete')
  → CausalDataBus.publishOutput() + 自回归上下文注入
```

**因果数据**：

```
CausalDataBus.publishOutput()
  → 接口验证 + 不变量检查
  → _writeWALEntry() → wal-operations.jsonl
  → 每50次操作 → _persistWALImmediate() → causal-state.json
  → emit('output-published') → CausalMemoryStore.addCausalMemory() → SqliteStore

恢复流程：
  _restoreFromWALAsync() → causal-state.json
  _replayWALLogAsync() → wal-operations.jsonl逐条重放
```

**技能数据（三层缓存）**：

```
L1摘要层：始终在内存，YAML Frontmatter的name+summary
L2指令层：按需加载Markdown正文，TTL过期+容量上限淘汰
L3资源层：按需加载引用文件，路径验证+TTL过期+容量上限淘汰
```

### 3.4 事件驱动流程

**EventBus核心机制**：
- 中间件链（最多50个）→ 深拷贝存入历史（最多1000条）→ 监听器分发
- 命名空间代理：自动为事件名添加prefix

**核心事件类型**：

| 前缀 | 触发时机 |
|------|---------|
| agent: | 状态变更/注册/生命周期/部署/监控/任务 |
| session: | 创建/阶段变更/技能完成/预算警告 |
| skill-reducer: | 发现/L2加载卸载/L3加载卸载/过载/激活卸载 |
| deepening: | 迭代/收敛/管道完成/缓存/熔断/状态转换 |
| pair-chat:/chat-chain: | 会话管理/共识/幻觉检测/链式任务 |
| goal: | 创建/完成/失败/暂停/恢复/分解/迭代 |

**传播路径**：

```
子模块事件 → EventRegistrar转发 → eventBus.emit('namespace:event')
  → 审计中间件检查 → logger.log()
  → WebSocket broadcast → 前端Dashboard
```

---

## 4. 功能效果详细说明

### 4.1 多Agent协作

**6种协作模式**：

| 模式 | 触发信号 | Agent数 | 适用场景 |
|------|---------|---------|---------|
| solo | 默认回退 | 1 | 简单任务 |
| generator-verifier | 审查/验证/review | 2-3 | 代码审查、数据校验 |
| orchestrator-subagent | 拆解/并行/decompose | 3-5 | 多模块并行开发 |
| agent-teams | 协调/沟通/team | 3-5 | 复杂重构 |
| message-bus | 事件/订阅/event | 2-10 | 微服务编排 |
| shared-state | 同步/共享/realtime | 2-8 | 实时文档编辑 |

**集成编排**：
- Bagging：Bootstrap采样+并行执行+多数投票
- Boosting：串行迭代+AdaBoost权重+残差传播
- Stacking：基础层并行+元层组合

### 4.2 深化推理

**4个深度级别**：

| 级别 | 分数 | 迭代 | 审查 | 对抗审查 |
|------|------|------|------|---------|
| quick | <0.25 | 1 | 否 | 否 |
| standard | 0.25-0.5 | 2 | 是 | 否 |
| deep | 0.5-0.75 | 3 | 是 | 否 |
| intensive | >=0.75 | 4 | 是 | 是 |

**OODA循环**：Observe(态势感知) → Orient(威胁/机会评估) → Decide(反应式/审慎式/创造式) → Act(执行+历史记录)

**收敛检测**：质量阈值(>=0.85) + 稳定性(方差<0.01) + 退化检测 + 维度平衡 + 改进率

### 4.3 技能系统

**66个技能**：18核心 + 3扩展 + 2基础设施 + 43领域技能

**触发机制**：关键词匹配 + 18组语义匹配 + 否定模式检测 + 自动触发 + 依赖链触发

**模型分级**：
- small：步骤明确（TDD/测试/部署/代码审查）
- medium：需推理判断
- large：需深层理解（架构设计/头脑风暴/需求探索）

### 4.4 质量保障

**TDD门禁**：RED-GREEN-REFACTOR循环 + 覆盖率验证 + 强制执行

**证据验证**：28种技能证据需求 + 五维度质量检查 + 强弱标准分类

**框架合规**：10类53条规则 + 豁免机制 + 路径遍历防护

### 4.5 知识管理

**知识图谱**：GraphRAG检索+实体关系推理+多跳查询

**RAG管道**：10种文件类型摄入 → 512字符分块 → 128维向量索引 → Top-K检索

**代码维基**：5阶段编译管线 + Mermaid架构图生成

---

## 5. 技术细节文档整理

### 5.1 关键算法

**a) 亲和度评分算法**（MultiAgentRouter._computeAffinities）
```
baseScore = Σ(匹配类型 * 0.3), 上限1.0
learnedBonus = (learnedAffinity[type] - 0.5) * 0.2
finalScore = clamp01(baseScore + learnedBonus)
effectiveScore = affinity * (1 / (1 + load))
```

**b) AdaBoost权重公式**（EnsembleOrchestrator._computeAgentWeight）
```
alpha = 0.5 * ln((1 - epsilon) / epsilon), eps=1e-10防溢出
融合权重 = exp(alpha)
```

**c) 五维复杂度评分**（CostAwareRouter.analyzeComplexity）
```
代码块(0.15) + 消息长度(0.20) + 关键词密度(0.25) + 错误恢复(0.20) + 多步骤(0.20)
>=0.7 → large, >=0.3 → medium, <0.3 → small
```

**d) 四维深度评估**（AdaptiveDepthController.assessComplexity）
```
scope(0.35) + risk(0.35) + reasoning(0.20) + depDepth(0.10)
<0.25 → quick, <0.5 → standard, <0.75 → deep, >=0.75 → intensive
```

**e) 因果向量相似度**（CausalVectorIndex）
```
向量生成：EmbeddingService.embed() 或 降级哈希向量(128维)
相似度：cosine = dotProduct / (normA * normB + EPSILON)
搜索：阈值0.3 + Top-K截断 + ComputeAccelerator加速
```

**f) 技能语义匹配**（SkillRouter._semanticMatch）
```
18组语义映射(中英文同义词) → 技能语义缓存快速查找
否定模式检测：匹配否定词后紧跟的语义术语则排除
```

### 5.2 性能优化方案

**有界数据结构**：
- BoundedMap：固定容量+FIFO淘汰+淘汰回调
- BoundedArray：固定容量+FIFO淘汰+淘汰计数
- 全局使用：所有Map/Set存储都有容量上限

**LRU缓存**：
- O(1)实现：Map的delete+set移至最近位置
- SkillRouter L2/L3缓存：访问时delete+set，容量满淘汰最早

**三层技能缓存**：
- L1摘要：始终在内存，Token开销最小
- L2指令：按需加载，TTL过期+容量淘汰
- L3资源：按需加载，路径验证+TTL过期

**原子写入+防抖持久化**：
- 原子写入：.tmp文件+rename确保崩溃安全
- 防抖：schedule()设置dirty+setTimeout延迟
- 重试：最多3次，指数退避
- 版本号防护：_writeVersion递增防并发覆盖

**连接池管理**：
- BatchScheduler：优先级队列+类型亲和批处理
- ConcurrencyController：信号量+指数退避重试

### 5.3 技术难点解决方案

**MoE门控路由负载均衡**：
- CostAwareRouter：五维复杂度评分→模型层级路由
- MoeGatingRouter：softmax概率+辅助损失+探索加分+共享专家
- InferenceModeManager：xhigh/fast双模式+复杂度自动切换

**跨机器传输可靠性**：
- CrossMachineTransport：HMAC-SHA256认证+心跳保活+自动重连
- DistributedTaskScheduler：4种调度策略+Worker丢失恢复+任务重试

**WAL数据一致性**：
- CausalDataBus：事件发布/订阅+因果排序+版本追踪
- DebouncedPersister：原子写入+版本号防护+过期临时文件清理

**多Agent并发竞态**：
- ConcurrencyController：信号量并发控制
- DeepeningBackpressureManager：四级压力+高低水位线
- PermissionGuard：文件操作锁
- IterationGuard：closed→open→half-open三态熔断

**Token预算管理**：
- ThreeTierMemoryManager：immediate(50K)/short-term(200K)/long-term(1.25M)
- TokenAwareDeepening：预算约束下的深化策略推荐
- ContextCompressionEngine：智能分类(keep/summarize/discard)
- TriAttention：Pre-RoPE三角级数评分+向量幅度双引擎注意力
- KVCacheManager：四维评分剪枝，10倍+显存压缩

---

## 附录

### A. 关键文件索引

| 文件 | 职责 |
|------|------|
| src/index.js | 统一入口，225+模块导出 |
| src/runtime/infrastructure/module-initializer.js | 10步有序初始化 |
| src/runtime/infrastructure/event-registrar.js | 事件注册与传播 |
| src/runtime/skill/skill-router.js | 技能路由引擎 |
| src/runtime/skill/skill-reducer.js | 三层缓存技能缩减器 |
| src/runtime/agent/multi-agent-router.js | 多Agent亲和度路由 |
| src/runtime/collaboration/ensemble-orchestrator.js | Bagging/Boosting/Stacking集成 |
| src/runtime/collaboration/moe-gating-router.js | MoE统一门控路由 |
| src/runtime/causal/causal-data-bus.js | 因果数据总线+WAL |
| src/runtime/workflow/goal-executor.js | 目标执行器 |
| src/runtime/deepening/deepening-orchestrator.js | 深化推理编排 |
| src/gate/tdd-gate.js | TDD门禁 |
| src/gate/evidence-verifier.js | 证据验证器 |
| src/gate/framework-compliance-checker.js | 框架合规检查 |
| src/runtime/sdd/iron-rule-engine.js | 铁律引擎 |
| src/utils/shutdown-mixin.js | 优雅关闭混入 |
| src/utils/safe-execute.js | 安全执行工具 |
| src/web/server.js | HTTP服务器(210+端点) |

### B. 配置快速参考

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| max_concurrent_agents | 6 | 最大并发Agent数 |
| task_timeout_minutes | 20 | 任务超时(分钟) |
| token_budget | 1000000000 | Token总预算 |
| default_model | gpt-4o | 默认模型 |
| deepening_config.adaptive_depth.scope_weight | 0.35 | 范围深度权重 |
| gate_config.tdd_gate.coverage_threshold | 0.8 | TDD覆盖率阈值 |
| moe_config.topK | 2 | MoE Top-K专家数 |
| collaboration_config.ensemble.max_agents | 5 | 集成最大Agent数 |
