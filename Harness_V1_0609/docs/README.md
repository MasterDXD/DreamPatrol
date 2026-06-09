# Harness Engineering 项目文档索引

> 版本：2.73.6 | 更新时间：2026年6月

---

## 文档体系

本项目采用六层文档体系，从宏观到微观逐步深入：

```
架构层 → 核心功能层 → 模块详解层 → 工具详解层 → 深度拆解层 → 准则层
```

另设补充层（guides/）和根级配置参考文档。

---

## 第一层：架构层（architecture/，8篇）

系统整体架构和设计梳理。

| 文档 | 说明 |
|------|------|
| [架构分析-AIProject系统](architecture/架构分析-AIProject系统.md) | 2.73.4系统架构、技术栈、模块关系 |
| [架构分析与设计梳理报告](architecture/架构分析与设计梳理报告.md) | 2.73.4全面架构分析 |
| [架构分析-模块依赖关系图](architecture/架构分析-模块依赖关系图.md) | 模块间依赖关系与分层架构 |
| [项目全面技术梳理报告](architecture/项目全面技术梳理报告.md) | 2.73.4全面技术梳理：框架结构/设计理念/调用逻辑/功能效果/技术细节 |
| [架构分析-先规划后执行](architecture/架构分析-先规划后执行.md) | Plan-Execute范式架构与实现 |
| [架构分析-多智能体系统工程控制](architecture/架构分析-多智能体系统工程控制.md) | 多智能体系统工程控制论 |
| [架构分析-驾驭工程约束](architecture/架构分析-驾驭工程约束.md) | 工程约束体系与驾驭策略 |
| [架构分析-Agentic设计模式](architecture/架构分析-Agentic设计模式.md) | Agentic设计模式与最佳实践 |

---

## 第二层：核心功能层（core/，17篇）

核心功能流程和机制说明。

| 文档 | 说明 |
|------|------|
| [核心功能-多Agent协作流程](core/核心功能-多Agent协作流程.md) | Skill路由/TDD门禁/目标执行/深化推理 |
| [核心功能-团队编程模式实现方案](core/核心功能-团队编程模式实现方案.md) | 协作流程/代码共享/同步编辑 |
| [核心功能-Skill自动路由机制](core/核心功能-Skill自动路由机制.md) | SkillRouter三层缓存/语义匹配 |
| [核心功能-权限控制与审计](core/核心功能-权限控制与审计.md) | RBAC/文件权限/审计日志 |
| [核心功能-TDD门禁执行流程](core/核心功能-TDD门禁执行流程.md) | RED-GREEN-REFACTOR检测/覆盖率验证 |
| [核心功能-目标执行引擎](core/核心功能-目标执行引擎.md) | GoalExecutor自主迭代收敛 |
| [核心功能-六阶段执行流程](core/核心功能-六阶段执行流程.md) | 阶段转换/TDD门禁/Skill绑定 |
| [核心功能-上下文压缩引擎](core/核心功能-上下文压缩引擎.md) | 智能压缩/Token估算 |
| [核心功能-上下文压缩与Token管理](core/核心功能-上下文压缩与Token管理.md) | 压缩策略/Token预算/层级管理 |
| [核心功能-斜杠命令路由](core/核心功能-斜杠命令路由.md) | CommandRouter命令发现/模糊匹配 |
| [核心功能-性能调优指南](core/核心功能-性能调优指南.md) | 性能优化策略与调优方法 |
| [核心功能-质量评估与自反思](core/核心功能-质量评估与自反思.md) | QualityScorer评分/SelfReflection自评/AdversarialReview对抗审查 |
| [核心功能-深化推理引擎](core/核心功能-深化推理引擎.md) | DeepeningOrchestrator迭代精化/收敛检测 |
| [核心功能-模型选择与Token管理](core/核心功能-模型选择与Token管理.md) | ModelSelector模型选择/TokenManager预算管理 |
| [核心功能-成本控制机制](core/核心功能-成本控制机制.md) | Token预算/预警阈值/降级策略 |
| [核心功能-因果数据总线与一致性](core/核心功能-因果数据总线与一致性.md) | CausalDataBus事件发布/因果一致性 |
| [核心功能-会话管理与检查点恢复](core/核心功能-会话管理与检查点恢复.md) | SessionManager会话/CheckpointManager检查点 |

---

## 第三层：模块详解层（modules/，146篇）

各模块的详细API和实现说明。

### 总览

| 文档 | 说明 |
|------|------|
| [功能说明-全部模块清单](modules/功能说明-全部模块清单.md) | 2.73.4全部模块按功能层分类 |
| [模块详解-上下文管理模块](modules/模块详解-上下文管理模块.md) | CLAUDE.md注入/Session管理 |
| [模块详解-工具层辅助模块](modules/模块详解-工具层辅助模块.md) | 工具层辅助模块汇总 |

### Agent子系统

| 文档 | 说明 |
|------|------|
| [模块详解-Agent子系统](modules/模块详解-Agent子系统.md) | Agent运行时子系统全貌 |
| [模块详解-AgentRuntime模块](modules/模块详解-AgentRuntime模块.md) | Agent运行时核心 |
| [模块详解-AgentMonitor模块](modules/模块详解-AgentMonitor模块.md) | Agent监控器 |
| [模块详解-AgentDeployment模块](modules/模块详解-AgentDeployment模块.md) | Agent部署器 |
| [模块详解-AgentStateManager状态管理器](modules/模块详解-AgentStateManager状态管理器.md) | Agent状态持久化/快照 |
| [模块详解-AgentLifecycleController生命周期控制器](modules/模块详解-AgentLifecycleController生命周期控制器.md) | Agent生命周期管理 |
| [模块详解-MultiAgentRouter多Agent路由器](modules/模块详解-MultiAgentRouter多Agent路由器.md) | 多Agent负载均衡/故障转移 |
| [模块详解-SubagentExecutor模块](modules/模块详解-SubagentExecutor模块.md) | 子Agent执行器 |

### 因果子系统

| 文档 | 说明 |
|------|------|
| [模块详解-因果子系统](modules/模块详解-因果子系统.md) | 因果子系统全貌 |
| [模块详解-CausalDataBus因果数据总线](modules/模块详解-CausalDataBus因果数据总线.md) | 因果事件发布/订阅 |

### 协作子系统

| 文档 | 说明 |
|------|------|
| [模块详解-协作子系统](modules/模块详解-协作子系统.md) | 协作子系统全貌 |
| [模块详解-CollaborationModeRouter模块](modules/模块详解-CollaborationModeRouter模块.md) | 协作模式路由器 |
| [模块详解-AgentDiversityManager](modules/模块详解-AgentDiversityManager.md) | Agent多样性管理器：四维多样性评估 |
| [模块详解-EnsembleOrchestrator](modules/模块详解-EnsembleOrchestrator.md) | 集成编排器：Bagging/Boosting/Stacking |
| [模块详解-AgentContributionTracker](modules/模块详解-AgentContributionTracker.md) | Agent贡献追踪器 |

### 深化推理

| 文档 | 说明 |
|------|------|
| [模块详解-DeepeningOrchestrator模块](modules/模块详解-DeepeningOrchestrator模块.md) | 深化推理编排器 |
| [模块详解-DeepeningPipeline模块](modules/模块详解-DeepeningPipeline模块.md) | 深化推理管道 |
| [模块详解-DeepeningBase深化基类](modules/模块详解-DeepeningBase深化基类.md) | 深化推理基类 |
| [模块详解-Deepening错误处理策略](modules/模块详解-Deepening错误处理策略.md) | 深化推理错误处理 |
| [模块详解-深化调度与执行模块群](modules/模块详解-深化调度与执行模块群.md) | 深化调度器/控制器/路由器 |
| [模块详解-深化推理策略模块群](modules/模块详解-深化推理策略模块群.md) | 深化推理策略集合 |
| [模块详解-深化推理策略模块群补充](modules/模块详解-深化推理策略模块群补充.md) | 深化推理策略补充 |
| [模块详解-深化数据与存储模块群](modules/模块详解-深化数据与存储模块群.md) | 深化数据管道/缓存/存储 |
| [模块详解-深化基础设施模块群](modules/模块详解-深化基础设施模块群.md) | 深化熔断/限流/背压等基础设施 |

### 基础设施子系统

| 文档 | 说明 |
|------|------|
| [模块详解-基础设施子系统](modules/模块详解-基础设施子系统.md) | 基础设施子系统全貌 |
| [模块详解-EventBus模块](modules/模块详解-EventBus模块.md) | 事件总线 |
| [模块详解-ModuleInitializer系统引导](modules/模块详解-ModuleInitializer系统引导.md) | 模块依赖排序/懒加载 |
| [模块详解-ShutdownMixin关机混入](modules/模块详解-ShutdownMixin关机混入.md) | 优雅关闭/资源清理 |
| [模块详解-MCPClient模块](modules/模块详解-MCPClient模块.md) | MCP协议客户端（含SSRF防护/安全架构） |
| [模块详解-OntologyFeedbackLoop本体反馈闭环](modules/模块详解-OntologyFeedbackLoop本体反馈闭环.md) | 本体反馈闭环：行动→效果→模型优化自循环 |

### 模型子系统

| 文档 | 说明 |
|------|------|
| [模块详解-模型子系统](modules/模块详解-模型子系统.md) | 模型子系统全貌 |
| [模块详解-TokenManager模块](modules/模块详解-TokenManager模块.md) | 令牌预算管理器 |
| [模块详解-InferenceCache](modules/模块详解-InferenceCache.md) | LLM推理缓存：LRU缓存/语义匹配 |

### 权限执行引擎

| 文档 | 说明 |
|------|------|
| [模块详解-权限执行引擎](modules/模块详解-权限执行引擎.md) | 权限执行引擎全貌 |
| [模块详解-RBACEnforcer模块](modules/模块详解-RBACEnforcer模块.md) | RBAC访问控制执行器 |
| [模块详解-PermissionGuard模块](modules/模块详解-PermissionGuard模块.md) | 文件操作权限守卫 |

### 质量子系统

| 文档 | 说明 |
|------|------|
| [模块详解-QualityScorer质量评分器](modules/模块详解-QualityScorer质量评分器.md) | 质量评分器 |
| [模块详解-EntropyGovernanceOrchestrator熵治理编排器](modules/模块详解-EntropyGovernanceOrchestrator熵治理编排器.md) | 统一熵评分/主动简化/约束强化闭环 |

### 会话子系统

| 文档 | 说明 |
|------|------|
| [模块详解-SessionManager会话管理器](modules/模块详解-SessionManager会话管理器.md) | 会话状态管理 |
| [模块详解-CheckpointManager检查点管理器](modules/模块详解-CheckpointManager检查点管理器.md) | 检查点管理器 |

### 技能子系统

| 文档 | 说明 |
|------|------|
| [模块详解-技能子系统](modules/模块详解-技能子系统.md) | 技能子系统全貌 |
| [模块详解-SkillRouter模块](modules/模块详解-SkillRouter模块.md) | Skill自动发现/匹配/路由 |
| [模块详解-DeepResearchOrchestrator深度调研编排器](modules/模块详解-DeepResearchOrchestrator深度调研编排器.md) | 5阶段调研流程/多源采集/冲突检测/结构化报告 |
| [模块详解-SkillTreeDAG](modules/模块详解-SkillTreeDAG.md) | 技能树DAG：拓扑排序/循环检测/并行路径 |
| [模块详解-PlaybookGenerator](modules/模块详解-PlaybookGenerator.md) | 剧本生成器：从历史执行提取可复用工作流模式 |

### 思维子系统

| 文档 | 说明 |
|------|------|
| [模块详解-思维子系统](modules/模块详解-思维子系统.md) | 思维子系统全貌 |
| [模块详解-ThoughtExtractor思维提取器](modules/模块详解-ThoughtExtractor思维提取器.md) | 思维提取器 |
| [模块详解-LLM知识库](modules/模块详解-LLM知识库.md) | LLM结构化知识存储/检索 |
| [模块详解-Brain记忆系统](modules/模块详解-Brain记忆系统.md) | 分层记忆架构 |
| [模块详解-梦境引擎子系统](modules/模块详解-梦境引擎子系统.md) | DreamEngine/DreamOutcomes/DreamScheduler/DreamBridge/DreamPhasePipeline（v2.13.0融合OpenClaw 4.5） |

### 用户子系统

| 文档 | 说明 |
|------|------|
| [模块详解-用户子系统](modules/模块详解-用户子系统.md) | 用户子系统全貌 |
| [模块详解-UserModelManager用户模型管理器](modules/模块详解-UserModelManager用户模型管理器.md) | 用户偏好学习/行为建模 |

### 工作流子系统

| 文档 | 说明 |
|------|------|
| [模块详解-工作流子系统](modules/模块详解-工作流子系统.md) | 工作流子系统全貌 |
| [模块详解-CommandRouter模块](modules/模块详解-CommandRouter模块.md) | 斜杠命令路由引擎 |
| [模块详解-PhaseOrchestrator阶段编排器](modules/模块详解-PhaseOrchestrator阶段编排器.md) | 六阶段流程编排 |
| [模块详解-PipelineExecutor流水线执行器](modules/模块详解-PipelineExecutor流水线执行器.md) | 管道执行器 |
| [模块详解-ProgrammableHookExecutor模块](modules/模块详解-ProgrammableHookExecutor模块.md) | 可编程钩子执行器 |
| [模块详解-OptimizationLoop优化循环](modules/模块详解-OptimizationLoop优化循环.md) | 优化循环求解器 |
| [模块详解-DeriveExecutor派生执行引擎](modules/模块详解-DeriveExecutor派生执行引擎.md) | Git worktree派生/合并/丢弃 |
| [模块详解-RagPipeline检索增强生成管道](modules/模块详解-RagPipeline检索增强生成管道.md) | RAG文档摄取/分块/检索 |
| [模块详解-ProjectScaffolder项目脚手架生成器](modules/模块详解-ProjectScaffolder项目脚手架生成器.md) | 项目脚手架模板生成 |
| [模块详解-StateGraph状态图引擎](modules/模块详解-StateGraph状态图引擎.md) | 状态图执行/检查点/恢复 |

### TDD门禁执行器

| 文档 | 说明 |
|------|------|
| [模块详解-TDD门禁执行器](modules/模块详解-TDD门禁执行器.md) | TDD门禁执行器全貌 |
| [模块详解-TDDGate模块](modules/模块详解-TDDGate模块.md) | TDD强制门禁 |
| [模块详解-EvidenceVerifier模块](modules/模块详解-EvidenceVerifier模块.md) | 证据验证器 |
| [模块详解-FrameworkComplianceChecker模块](modules/模块详解-FrameworkComplianceChecker模块.md) | 代码合规检查器 |
| [模块详解-ErrorPreventionGuard](modules/模块详解-ErrorPreventionGuard.md) | 错误预防守卫：模式检测与预防建议 |
| [模块详解-OutputConcisenessGuard](modules/模块详解-OutputConcisenessGuard.md) | 输出精简度守卫：五维度Token/行/重复率评估 |

### Web子系统

| 文档 | 说明 |
|------|------|
| [模块详解-Web子系统](modules/模块详解-Web子系统.md) | Web子系统全貌 |
| [模块详解-Dashboard数据提供者](modules/模块详解-Dashboard数据提供者.md) | Dashboard后端数据提供 |

### TUI子系统

| 文档 | 说明 |
|------|------|
| [模块详解-TUI子系统](modules/模块详解-TUI子系统.md) | TUI终端界面子系统 |

### TypeScript与CLI

| 文档 | 说明 |
|------|------|
| [模块详解-TypeScript类型声明](modules/模块详解-TypeScript类型声明.md) | TypeScript类型声明汇总 |
| [模块详解-CLI与脚本](modules/模块详解-CLI与脚本.md) | CLI命令行工具与脚本 |

### 媒体适配器（v2.13.0融合OpenClaw 4.5 / v2.10.6融合Presenton+NVIDIA LongLive）

| 文档 | 说明 |
|------|------|
| MediaProviderInterface | `runtime/adapter/media-provider/media-provider-interface` — 媒体生成提供商统一接口，连接管理/健康检查/任务生成/查询/取消 |
| MediaProviderBase | `runtime/adapter/media-provider/media-provider-base` — 媒体生成提供商适配器基类，重试机制/请求超时/并发控制/指标追踪 |
| MediaProviderRouter | `runtime/adapter/media-provider/media-provider-router` — 媒体生成提供商路由器，5种路由策略/故障转移/健康检查 |
| PresentationProvider | `runtime/adapter/media-provider/presentation-provider` — 演示文稿生成适配器，3种模式(generate/textToSlides/outlineToPresentation)，API/本地双模式（v2.10.6融合Presenton） |
| VideoProvider | `runtime/adapter/media-provider/video-provider` — 视频生成适配器，3种模式(generate/imageToVideo/videoToVideo)，NVFP4量化+分段生成（v2.10.6融合NVIDIA LongLive） |

### 特色模块

| 文档 | 说明 |
|------|------|
| [模块详解-SDD规格驱动开发](modules/模块详解-SDD规格驱动开发.md) | SDD跨7模块集成：规格验证/存活管理/门禁/压缩保护/路由优先 |
| [模块详解-GoalExecutor目标执行器](modules/模块详解-GoalExecutor目标执行器.md) | 目标执行引擎 |
| [模块详解-PlanExecuteOrchestrator规划执行编排器](modules/模块详解-PlanExecuteOrchestrator规划执行编排器.md) | 规划-执行闭环：失败驱动重新规划 |
| [模块详解-Karpathy增强器](modules/模块详解-Karpathy增强器.md) | Karpathy原则增强器 |
| [模块详解-TriAttention上下文优化](modules/模块详解-TriAttention上下文优化.md) | 三重注意力上下文优化 |
| [模块详解-OODA决策闭环](modules/模块详解-OODA决策闭环.md) | OODA观察-定向-决策-行动闭环 |
| [模块详解-跨会话学习引擎](modules/模块详解-跨会话学习引擎.md) | 跨会话经验学习与知识迁移 |
| [模块详解-视觉推理衔接](modules/模块详解-视觉推理衔接.md) | 视觉推理与代码衔接 |
| [模块详解-服务文件系统](modules/模块详解-服务文件系统.md) | 服务文件系统管理 |
| [模块详解-文档图谱检索](modules/模块详解-文档图谱检索.md) | 文档知识图谱检索 |
| [模块详解-技能图谱](modules/模块详解-技能图谱.md) | 技能关系图谱与依赖可视化 |
| [模块详解-工程纪律插件](modules/模块详解-工程纪律插件.md) | 工程纪律插件系统 |
| [模块详解-代码仓库图谱](modules/模块详解-代码仓库图谱.md) | 代码仓库知识图谱 |
| DreamPhasePipeline | `runtime/thought/dream-phase-pipeline` — 三阶段记忆巩固流水线（v2.13.0融合OpenClaw 4.5 Dreaming） |

---

## 第四层：工具详解层（tools/，7篇）

工具和API的详细说明。

| 文档 | 说明 |
|------|------|
| [接口文档-Web API](tools/接口文档-Web API.md) | RESTful API + WebSocket |
| [接口文档-WebSocket API](tools/接口文档-WebSocket API.md) | WebSocket实时通信协议、消息格式、心跳、认证 |
| [工具详解-代码搜索工具](tools/工具详解-代码搜索工具.md) | 文本/正则/文件匹配搜索 |
| [工具详解-API调用工具](tools/工具详解-API调用工具.md) | HTTP请求/响应处理 |
| [工具详解-文件操作工具](tools/工具详解-文件操作工具.md) | 文件读写/目录操作 |
| [接口文档-Section组件API](tools/接口文档-Section组件API.md) | Section布局组件API/变体/间距/折叠 |
| [工具详解-工具层模块群](tools/工具详解-工具层模块群.md) | 工具层模块群汇总 |

---

## 第五层：深度拆解层（deep-dive/，9篇）

关键链路的端到端深度分析。

| 文档 | 说明 |
|------|------|
| [深度拆解-任务调度执行链路](deep-dive/深度拆解-任务调度执行链路.md) | 命令解析→Skill路由→执行→门禁全链路 |
| [深度拆解-Skill路由全链路](deep-dive/深度拆解-Skill路由全链路.md) | Skill发现→匹配→验证→激活全链路 |
| [深度拆解-权限执行引擎与安全防护](deep-dive/深度拆解-权限执行引擎与安全防护.md) | RBAC→文件守卫→审计日志全链路 |
| [深度拆解-深化推理全链路](deep-dive/深度拆解-深化推理全链路.md) | 触发→迭代→收敛→缓存全链路 |
| [深度拆解-错误处理与异常恢复体系](deep-dive/深度拆解-错误处理与异常恢复体系.md) | 错误分类/恢复策略/容错机制 |
| [深度拆解-事件驱动架构与消息流转](deep-dive/深度拆解-事件驱动架构与消息流转.md) | 事件总线/发布订阅/消息流转 |
| [深度拆解-KEPA自学习进化系统融合架构](deep-dive/深度拆解-KEPA自学习进化系统融合架构.md) | KEPA融合/自学习闭环/进化架构 |
| [深度拆解-多Agent协作模式全链路](deep-dive/深度拆解-多Agent协作模式全链路.md) | 协作模式/路由/调度全链路 |
| [深度拆解-质量保障与自演化闭环全链路](deep-dive/深度拆解-质量保障与自演化闭环全链路.md) | 质量评分/自反思/对抗审查闭环 |

---

## 第六层：准则层（guidelines/，30篇）

使用准则和实操指南。

### 通用准则

| 文档 | 说明 |
|------|------|
| [快速开始指南](guidelines/快速开始指南.md) | 5分钟启动 |
| [框架使用说明](guidelines/框架使用说明.md) | 完整使用说明（含实操指南） |
| [开发指南-代码贡献规范](guidelines/开发指南-代码贡献规范.md) | 环境搭建/模块开发/编码规范/TDD/安全/部署/提交规范 |
| [多Agent协作使用准则](guidelines/多Agent协作使用准则.md) | 2.73.4协作最佳实践 |
| [多编辑器兼容使用说明](guidelines/多编辑器兼容使用说明.md) | 5款AI编辑器适配 |
| [Skill速查表](guidelines/Skill速查表.md) | 84个Skill速查 |
| [部署文档](guidelines/部署文档.md) | 部署流程文档 |
| [SDD集成指南](guidelines/SDD集成指南.md) | 规格驱动开发集成：分步指南/最佳实践/故障排查 |
| [错误码参考手册](guidelines/错误码参考手册.md) | 错误码定义与参考 |
| [故障排查指南](guidelines/故障排查指南.md) | 常见问题排查流程与解决方案 |
| [统一语言术语表](guidelines/统一语言术语表.md) | 项目统一术语定义与中英对照 |

### AI编程提示词指南（19篇系列）

| 文档 | 说明 |
|------|------|
| [00-索引与导航](guidelines/AI编程提示词指南/00-索引与导航.md) | 系列文档索引与导航 |
| [01-核心原则](guidelines/AI编程提示词指南/01-核心原则.md) | AI编程提示词核心原则 |
| [02-框架体系](guidelines/AI编程提示词指南/02-框架体系.md) | 提示词框架体系 |
| [03-十大核心技巧](guidelines/AI编程提示词指南/03-十大核心技巧.md) | 十大核心技巧 |
| [04-场景化模板库](guidelines/AI编程提示词指南/04-场景化模板库.md) | 场景化提示词模板库 |
| [05-高级策略](guidelines/AI编程提示词指南/05-高级策略.md) | 高级提示词策略 |
| [06-TDD驱动提示词](guidelines/AI编程提示词指南/06-TDD驱动提示词.md) | TDD驱动提示词编写 |
| [07-上下文工程](guidelines/AI编程提示词指南/07-上下文工程.md) | 上下文工程技巧 |
| [08-模型参数调优](guidelines/AI编程提示词指南/08-模型参数调优.md) | 模型参数调优方法 |
| [09-模型差异与适配](guidelines/AI编程提示词指南/09-模型差异与适配.md) | 模型差异与适配策略 |
| [10-防幻觉策略](guidelines/AI编程提示词指南/10-防幻觉策略.md) | 防止AI幻觉策略 |
| [11-项目级配置](guidelines/AI编程提示词指南/11-项目级配置.md) | 项目级提示词配置 |
| [12-反模式与常见错误](guidelines/AI编程提示词指南/12-反模式与常见错误.md) | 提示词反模式与常见错误 |
| [13-工具专属优化](guidelines/AI编程提示词指南/13-工具专属优化.md) | 工具专属提示词优化 |
| [14-评估与迭代](guidelines/AI编程提示词指南/14-评估与迭代.md) | 提示词评估与迭代 |
| [15-Top20排行榜](guidelines/AI编程提示词指南/15-Top20排行榜.md) | Top20提示词排行榜 |
| [16-终极模板](guidelines/AI编程提示词指南/16-终极模板.md) | 终极提示词模板 |
| [17-工具组合工作流](guidelines/AI编程提示词指南/17-工具组合工作流.md) | 工具组合工作流 |
| [A-快速参考卡](guidelines/AI编程提示词指南/A-快速参考卡.md) | 快速参考卡 |

---

## 补充层：部署指南（guidelines/，1篇）

| 文档 | 说明 |
|------|------|
| [部署文档](guidelines/部署文档.md) | 部署流程文档 |

---

## 根级配置参考（1篇）

| 文档 | 说明 |
|------|------|
| [配置参考-Config.json](配置参考-Config.json.md) | Config.json配置参考 |

---

## 统计

| 层级 | 目录 | 文档数 |
|------|------|--------|
| 第一层 | architecture/ | 8 |
| 第二层 | core/ | 17 |
| 第三层 | modules/ | 137 |
| 第四层 | tools/ | 7 |
| 第五层 | deep-dive/ | 9 |
| 第六层 | guidelines/ | 30 |
| 根级 | — | 2 |
| **合计** | | **211** |

---

## 快速导航

| 我想... | 查阅文档 |
|---------|---------|
| 了解项目整体架构 | 架构分析-AIProject系统 |
| 快速上手使用框架 | 快速开始指南 |
| 理解Skill路由机制 | 核心功能-Skill自动路由机制 |
| 理解权限控制 | 核心功能-权限控制与审计 |
| 理解TDD门禁 | 核心功能-TDD门禁执行流程 |
| 查看模块API | modules/目录下对应文档 |
| 查看Web API | 接口文档-Web API |
| 查看WebSocket API | 接口文档-WebSocket API |
| 排查运行问题 | 故障排查指南 |
| 优化AI编程提示词 | AI编程提示词指南 |
| 开发新应用 | 框架使用说明 |
| 理解SDD规格驱动开发 | 模块详解-SDD规格驱动开发 / SDD集成指南 |
| 理解深化推理 | 核心功能-深化推理引擎 / 深度拆解-深化推理全链路 |
| 理解成本控制 | 核心功能-成本控制机制 |
| 理解会话管理 | 核心功能-会话管理与检查点恢复 |
| 查看配置参考 | 配置参考-Config.json |
| 查看错误码 | 错误码参考手册 |
