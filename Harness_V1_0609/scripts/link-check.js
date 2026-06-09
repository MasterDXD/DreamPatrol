'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');

const LINK_PATTERN = /\[\[([^\]]+)\]\]/g;

const DOC_NAME_TO_PATH = {
  '00-索引与导航': 'guidelines/AI编程提示词指南/00-索引与导航.md',
  '01-核心原则': 'guidelines/AI编程提示词指南/01-核心原则.md',
  '02-框架体系': 'guidelines/AI编程提示词指南/02-框架体系.md',
  '03-十大核心技巧': 'guidelines/AI编程提示词指南/03-十大核心技巧.md',
  '04-场景化模板库': 'guidelines/AI编程提示词指南/04-场景化模板库.md',
  '05-高级策略': 'guidelines/AI编程提示词指南/05-高级策略.md',
  '06-TDD驱动提示词': 'guidelines/AI编程提示词指南/06-TDD驱动提示词.md',
  '07-上下文工程': 'guidelines/AI编程提示词指南/07-上下文工程.md',
  '08-模型参数调优': 'guidelines/AI编程提示词指南/08-模型参数调优.md',
  '09-模型差异与适配': 'guidelines/AI编程提示词指南/09-模型差异与适配.md',
  '10-防幻觉策略': 'guidelines/AI编程提示词指南/10-防幻觉策略.md',
  '11-项目级配置': 'guidelines/AI编程提示词指南/11-项目级配置.md',
  '12-反模式与常见错误': 'guidelines/AI编程提示词指南/12-反模式与常见错误.md',
  '13-工具专属优化': 'guidelines/AI编程提示词指南/13-工具专属优化.md',
  '14-评估与迭代': 'guidelines/AI编程提示词指南/14-评估与迭代.md',
  '15-Top20排行榜': 'guidelines/AI编程提示词指南/15-Top20排行榜.md',
  '16-终极模板': 'guidelines/AI编程提示词指南/16-终极模板.md',
  '17-工具组合工作流': 'guidelines/AI编程提示词指南/17-工具组合工作流.md',
  'A-快速参考卡': 'guidelines/AI编程提示词指南/A-快速参考卡.md',
  '部署文档': 'guidelines/部署文档.md',
  '错误码参考手册': 'guidelines/错误码参考手册.md',
  '多编辑器兼容使用说明': 'guidelines/多编辑器兼容使用说明.md',
  '多Agent协作使用准则': 'guidelines/多Agent协作使用准则.md',
  '工具详解-代码搜索工具': 'tools/工具详解-代码搜索工具.md',
  '工具详解-工具层模块群': 'tools/工具详解-工具层模块群.md',
  '工具详解-文件操作工具': 'tools/工具详解-文件操作工具.md',
  '工具详解-API调用工具': 'tools/工具详解-API调用工具.md',
  '功能说明-全部模块清单': 'modules/功能说明-全部模块清单.md',
  '工作流子系统': 'modules/模块详解-工作流子系统.md',
  '故障排查指南': 'guidelines/故障排查指南.md',
  '核心功能-成本控制机制': 'core/核心功能-成本控制机制.md',
  '核心功能-多Agent协作流程': 'core/核心功能-多Agent协作流程.md',
  '核心功能-会话管理与检查点恢复': 'core/核心功能-会话管理与检查点恢复.md',
  '核心功能-技能子系统': 'modules/模块详解-技能子系统.md',
  '核心功能-记忆管道系统': 'modules/模块详解-记忆管线子系统.md',
  '核心功能-六阶段执行流程': 'core/核心功能-六阶段执行流程.md',
  '核心功能-模块初始化流程': 'modules/模块详解-ModuleInitializer系统引导.md',
  '核心功能-模型选择与Token管理': 'core/核心功能-模型选择与Token管理.md',
  '核心功能-目标执行引擎': 'core/核心功能-目标执行引擎.md',
  '核心功能-权限控制与审计': 'core/核心功能-权限控制与审计.md',
  '核心功能-上下文压缩引擎': 'core/核心功能-上下文压缩引擎.md',
  '核心功能-上下文压缩与Token管理': 'core/核心功能-上下文压缩与Token管理.md',
  '核心功能-深化推理流程': 'core/核心功能-深化推理引擎.md',
  '核心功能-深化推理引擎': 'core/核心功能-深化推理引擎.md',
  '核心功能-思维与记忆系统': 'modules/模块详解-思维子系统.md',
  '核心功能-团队编程模式实现方案': 'core/核心功能-团队编程模式实现方案.md',
  '核心功能-斜杠命令路由': 'core/核心功能-斜杠命令路由.md',
  '核心功能-信号持久化': 'modules/模块详解-EventBus模块.md',
  '核心功能-性能调优指南': 'core/核心功能-性能调优指南.md',
  '核心功能-优雅关闭流程': 'modules/模块详解-ShutdownMixin关机混入.md',
  '核心功能-因果数据总线与一致性': 'core/核心功能-因果数据总线与一致性.md',
  '核心功能-质量评估与自反思': 'core/核心功能-质量评估与自反思.md',
  '核心功能-质量评估与自反思流程': 'core/核心功能-质量评估与自反思.md',
  '核心功能-Skill自动路由机制': 'core/核心功能-Skill自动路由机制.md',
  '核心功能-TDD门禁执行流程': 'core/核心功能-TDD门禁执行流程.md',
  '核心功能-Token预算管控机制': 'core/核心功能-上下文压缩与Token管理.md',
  '架构分析-模块依赖关系图': 'architecture/架构分析-模块依赖关系图.md',
  '架构分析-运行时系统': 'architecture/架构分析与设计梳理报告.md',
  '架构分析-AIProject系统': 'architecture/架构分析-AIProject系统.md',
  '架构分析-Harness多Agent系统': 'architecture/架构分析与设计梳理报告.md',
  '架构分析与设计梳理报告': 'architecture/架构分析与设计梳理报告.md',
  '基础设施子系统': 'modules/模块详解-基础设施子系统.md',
  '接口文档-Section组件API': 'tools/接口文档-Section组件API.md',
  '接口文档-Web API': 'tools/接口文档-Web API.md',
  '接口文档-WebSocket API': 'tools/接口文档-WebSocket API.md',
  '开发指南-代码贡献规范': 'guidelines/开发指南-代码贡献规范.md',
  '快速开始指南': 'guidelines/快速开始指南.md',
  '框架使用说明': 'guidelines/框架使用说明.md',
  '模块详解-安全编排子系统': 'modules/模块详解-安全编排子系统.md',
  '模块详解-代码仓库图谱': 'modules/模块详解-代码仓库图谱.md',
  '模块详解-动态Agent生成器': 'modules/模块详解-动态Agent生成器.md',
  '模块详解-服务文件系统': 'modules/模块详解-服务文件系统.md',
  '模块详解-工程纪律插件': 'modules/模块详解-工程纪律插件.md',
  '模块详解-工具层辅助模块': 'modules/模块详解-工具层辅助模块.md',
  '模块详解-工作流核心模块群': 'modules/模块详解-工作流核心模块群.md',
  '模块详解-工作流子系统': 'modules/模块详解-工作流子系统.md',
  '模块详解-会话与上下文子系统': 'modules/模块详解-会话与上下文子系统.md',
  '模块详解-会话子系统': 'modules/模块详解-会话子系统.md',
  '模块详解-基础设施核心模块群': 'modules/模块详解-基础设施核心模块群.md',
  '模块详解-基础设施子系统': 'modules/模块详解-基础设施子系统.md',
  '模块详解-记忆管线子系统': 'modules/模块详解-记忆管线子系统.md',
  '模块详解-技能生命周期模块群': 'modules/模块详解-技能生命周期模块群.md',
  '模块详解-技能图谱': 'modules/模块详解-技能图谱.md',
  '模块详解-技能子系统': 'modules/模块详解-技能子系统.md',
  '模块详解-架构边界守护模块群': 'modules/模块详解-架构边界守护模块群.md',
  '模块详解-跨会话学习引擎': 'modules/模块详解-跨会话学习引擎.md',
  '模块详解-梦境引擎子系统': 'modules/模块详解-梦境引擎子系统.md',
  '模块详解-模型与思维子系统': 'modules/模块详解-模型与思维子系统.md',
  '模块详解-模型子系统': 'modules/模块详解-模型子系统.md',
  '模块详解-权限执行引擎': 'modules/模块详解-权限执行引擎.md',
  '模块详解-上下文管理模块': 'modules/模块详解-上下文管理模块.md',
  '模块详解-上下文子系统': 'modules/模块详解-上下文子系统.md',
  '模块详解-上下文压缩引擎': 'core/核心功能-上下文压缩引擎.md',
  '模块详解-上下文预算优化器': 'modules/模块详解-上下文预算优化器.md',
  '模块详解-深化调度与执行模块群': 'modules/模块详解-深化调度与执行模块群.md',
  '模块详解-深化基础设施模块群': 'modules/模块详解-深化基础设施模块群.md',
  '模块详解-深化数据与存储模块群': 'modules/模块详解-深化数据与存储模块群.md',
  '模块详解-深化推理策略模块群': 'modules/模块详解-深化推理策略模块群.md',
  '模块详解-深化推理策略模块群补充': 'modules/模块详解-深化推理策略模块群补充.md',
  '模块详解-深化推理子系统': 'modules/模块详解-深化推理子系统.md',
  '模块详解-深化子系统': 'modules/模块详解-深化子系统.md',
  '模块详解-视觉推理衔接': 'modules/模块详解-视觉推理衔接.md',
  '模块详解-思维子系统': 'modules/模块详解-思维子系统.md',
  '模块详解-提示词编译子系统': 'modules/模块详解-提示词编译子系统.md',
  '模块详解-图谱编译子系统': 'modules/模块详解-图谱编译子系统.md',
  '模块详解-文档解析子系统': 'modules/模块详解-文档解析子系统.md',
  '模块详解-文档图谱检索': 'modules/模块详解-文档图谱检索.md',
  '模块详解-协作子系统': 'modules/模块详解-协作子系统.md',
  '模块详解-因果推演与预测引擎模块群': 'modules/模块详解-因果推演与预测引擎模块群.md',
  '模块详解-因果子系统': 'modules/模块详解-因果子系统.md',
  '模块详解-因果子系统模块': 'modules/模块详解-因果子系统.md',
  '模块详解-用户子系统': 'modules/模块详解-用户子系统.md',
  '模块详解-质量子系统': 'modules/模块详解-质量子系统.md',
  '模块详解-自进化搜索引擎': 'modules/模块详解-自进化搜索引擎.md',
  '模块详解-AgentContributionTracker': 'modules/模块详解-Agent子系统.md',
  '模块详解-Agent子系统': 'modules/模块详解-Agent子系统.md',
  '模块详解-AgentDeployment模块': 'modules/模块详解-AgentDeployment模块.md',
  '模块详解-AgentDiversityManager': 'modules/模块详解-Agent子系统.md',
  '模块详解-AgentLifecycleController生命周期控制器': 'modules/模块详解-AgentLifecycleController生命周期控制器.md',
  '模块详解-AgentMonitor模块': 'modules/模块详解-AgentMonitor模块.md',
  '模块详解-AgentRuntime模块': 'modules/模块详解-AgentRuntime模块.md',
  '模块详解-AgentStateManager状态管理器': 'modules/模块详解-AgentStateManager状态管理器.md',
  '模块详解-Brain记忆系统': 'modules/模块详解-Brain记忆系统.md',
  '模块详解-CausalDataBus因果数据总线': 'modules/模块详解-CausalDataBus因果数据总线.md',
  '模块详解-ChatChain链式对话': 'modules/模块详解-ChatChain链式对话.md',
  '模块详解-CheckpointManager检查点管理器': 'modules/模块详解-CheckpointManager检查点管理器.md',
  '模块详解-CLI与脚本': 'modules/模块详解-CLI与脚本.md',
  '模块详解-CMA适配器子系统': 'modules/模块详解-CMA适配器子系统.md',
  '模块详解-CodeWikiOrchestrator': 'modules/模块详解-文档图谱检索.md',
  '模块详解-CollaborationModeRouter模块': 'modules/模块详解-CollaborationModeRouter模块.md',
  '模块详解-CommandRouter模块': 'modules/模块详解-CommandRouter模块.md',
  '模块详解-ConvergenceDetector收敛检测器': 'modules/模块详解-OptimizationLoop优化循环.md',
  '模块详解-CostAwareRouter成本感知路由': 'modules/模块详解-CostAwareRouter成本感知路由.md',
  '模块详解-Dashboard数据提供者': 'modules/模块详解-Dashboard数据提供者.md',
  '模块详解-Deepening错误处理策略': 'modules/模块详解-Deepening错误处理策略.md',
  '模块详解-DeepeningBase深化基类': 'modules/模块详解-DeepeningBase深化基类.md',
  '模块详解-DeepeningOrchestrator模块': 'modules/模块详解-DeepeningOrchestrator模块.md',
  '模块详解-DeepeningOrchestrator深化推理编排器': 'modules/模块详解-DeepeningOrchestrator模块.md',
  '模块详解-DeepeningPipeline模块': 'modules/模块详解-DeepeningPipeline模块.md',
  '模块详解-DreamEngine做梦引擎': 'modules/模块详解-梦境引擎子系统.md',
  '模块详解-DreamOutcomes与DreamBridge模块': 'modules/模块详解-DreamOutcomes与DreamBridge模块.md',
  '模块详解-DreamScheduler': 'modules/模块详解-DreamScheduler梦境调度器.md',
  '模块详解-DreamScheduler梦境调度器': 'modules/模块详解-DreamScheduler梦境调度器.md',
  '模块详解-EnsembleOrchestrator': 'modules/模块详解-MultiAgentRouter多Agent路由器.md',
  '模块详解-ErrorPreventionGuard': 'modules/模块详解-架构边界守护模块群.md',
  '模块详解-EventBus模块': 'modules/模块详解-EventBus模块.md',
  '模块详解-EvidenceVerifier模块': 'modules/模块详解-EvidenceVerifier模块.md',
  '模块详解-EvidenceVerifier证据验证器': 'modules/模块详解-EvidenceVerifier模块.md',
  '模块详解-FrameworkComplianceChecker模块': 'modules/模块详解-FrameworkComplianceChecker模块.md',
  '模块详解-GoalExecutor目标执行器': 'modules/模块详解-GoalExecutor目标执行器.md',
  '模块详解-Graphify模块': 'modules/模块详解-Graphify模块.md',
  '模块详解-GraphRag模块': 'modules/模块详解-GraphRag模块.md',
  '模块详解-HealthChecker健康检查器': 'modules/模块详解-EventBus模块.md',
  '模块详解-HookHandlers钩子处理器': 'modules/模块详解-HookHandlers钩子处理器.md',
  '模块详解-Hook组合器': 'modules/模块详解-Hook组合器.md',
  '模块详解-InferenceCache': 'modules/模块详解-KVCacheManager模块.md',
  '模块详解-IronRuleEngine铁律引擎': 'modules/模块详解-IronRuleEngine铁律引擎.md',
  '模块详解-Karpathy增强器': 'modules/模块详解-Karpathy增强器.md',
  '模块详解-KVCacheManager模块': 'modules/模块详解-KVCacheManager模块.md',
  '模块详解-LLM知识库': 'modules/模块详解-LLM知识库.md',
  '模块详解-MCPClient模块': 'modules/模块详解-MCPClient模块.md',
  '模块详解-MCP服务器自动发现': 'modules/模块详解-MCP服务器自动发现.md',
  '模块详解-MemoryPipeline记忆管道': 'modules/模块详解-MemoryPipeline记忆管道.md',
  '模块详解-MemoryPrefetcher记忆预取器': 'modules/模块详解-MemoryPrefetcher记忆预取器.md',
  '模块详解-MemorySyncCoordinator记忆同步协调器': 'modules/模块详解-MemorySyncCoordinator记忆同步协调器.md',
  '模块详解-MetaSkillOrchestrator元技能编排': 'modules/模块详解-MetaSkillOrchestrator元技能编排.md',
  '模块详解-ModuleInitializer系统引导': 'modules/模块详解-ModuleInitializer系统引导.md',
  '模块详解-MultiAgentRouter多Agent路由器': 'modules/模块详解-MultiAgentRouter多Agent路由器.md',
  '模块详解-OODA决策闭环': 'modules/模块详解-OODA决策闭环.md',
  '模块详解-OptimizationLoop优化循环': 'modules/模块详解-OptimizationLoop优化循环.md',
  '模块详解-OutputConcisenessGuard': 'modules/模块详解-架构边界守护模块群.md',
  '模块详解-PairChat链式对话': 'modules/模块详解-ChatChain链式对话.md',
  '模块详解-PairChat模块': 'modules/模块详解-ChatChain链式对话.md',
  '模块详解-PermissionGuard模块': 'modules/模块详解-PermissionGuard模块.md',
  '模块详解-PhaseOrchestrator阶段编排器': 'modules/模块详解-PhaseOrchestrator阶段编排器.md',
  '模块详解-PipelineExecutor流水线执行器': 'modules/模块详解-PipelineExecutor流水线执行器.md',
  '模块详解-PlaybookGenerator': 'modules/模块详解-PipelineExecutor流水线执行器.md',
  '模块详解-ProgrammableHookExecutor模块': 'modules/模块详解-ProgrammableHookExecutor模块.md',
  '模块详解-QualityScorer质量评分器': 'modules/模块详解-QualityScorer质量评分器.md',
  '模块详解-RBACEnforcer模块': 'modules/模块详解-RBACEnforcer模块.md',
  '模块详解-SDD规范驱动子系统': 'modules/模块详解-SDD规范驱动子系统.md',
  '模块详解-SDD规格驱动开发': 'modules/模块详解-SDD规格驱动开发.md',
  '模块详解-SessionManager会话管理': 'modules/模块详解-SessionManager会话管理器.md',
  '模块详解-SessionManager会话管理器': 'modules/模块详解-SessionManager会话管理器.md',
  '模块详解-ShutdownMixin关机混入': 'modules/模块详解-ShutdownMixin关机混入.md',
  '模块详解-SignalPersistence信号持久化': 'modules/模块详解-EventBus模块.md',
  '模块详解-SkillImprovementLoop技能改进循环': 'modules/模块详解-技能生命周期模块群.md',
  '模块详解-SkillPack技能包分发': 'modules/模块详解-SkillPack技能包分发.md',
  '模块详解-Skill子系统': 'modules/模块详解-Skill子系统.md',
  '模块详解-SkillRouter模块': 'modules/模块详解-SkillRouter模块.md',
  '模块详解-SkillTreeDAG': 'modules/模块详解-技能图谱.md',
  '模块详解-SubagentExecutor模块': 'modules/模块详解-SubagentExecutor模块.md',
  '模块详解-TDD门禁执行器': 'modules/模块详解-TDD门禁执行器.md',
  '模块详解-TDDGate模块': 'modules/模块详解-TDDGate模块.md',
  '模块详解-TechStackTemplates技术栈模板': 'modules/模块详解-TechStackTemplates技术栈模板.md',
  '模块详解-ThoughtExtractor思维提取器': 'modules/模块详解-ThoughtExtractor思维提取器.md',
  '模块详解-TokenManager模块': 'modules/模块详解-TokenManager模块.md',
  '模块详解-TriAttention上下文优化': 'modules/模块详解-TriAttention上下文优化.md',
  '模块详解-TriggerDispatcher统一触发调度': 'modules/模块详解-TriggerDispatcher统一触发调度.md',
  '模块详解-TypeScript类型声明': 'modules/模块详解-TypeScript类型声明.md',
  '模块详解-UnifiedMemoryRecaller统一记忆召回器': 'modules/模块详解-UnifiedMemoryRecaller统一记忆召回器.md',
  '模块详解-UserModelManager用户模型管理器': 'modules/模块详解-UserModelManager用户模型管理器.md',
  '模块详解-Web仪表盘系统': 'modules/模块详解-Web子系统.md',
  '模块详解-Web子系统': 'modules/模块详解-Web子系统.md',
  '配置参考-Config.json': '配置参考-Config.json.md',
  '深度拆解-错误处理与异常恢复体系': 'deep-dive/深度拆解-错误处理与异常恢复体系.md',
  '深度拆解-多Agent协作模式全链路': 'deep-dive/深度拆解-多Agent协作模式全链路.md',
  '深度拆解-权限执行引擎与安全防护': 'deep-dive/深度拆解-权限执行引擎与安全防护.md',
  '深度拆解-任务调度执行链路': 'deep-dive/深度拆解-任务调度执行链路.md',
  '深度拆解-深化推理全链路': 'deep-dive/深度拆解-深化推理全链路.md',
  '深度拆解-事件驱动架构与消息流转': 'deep-dive/深度拆解-事件驱动架构与消息流转.md',
  '深度拆解-质量保障与自演化闭环全链路': 'deep-dive/深度拆解-质量保障与自演化闭环全链路.md',
  '深度拆解-上下文压缩与Token优化': 'core/核心功能-上下文压缩引擎.md',
  '深度拆解-会话恢复与容错机制': 'core/核心功能-会话管理与检查点恢复.md',
  'SDD规范驱动子系统': 'modules/模块详解-SDD规范驱动子系统.md',
  '技能子系统': 'modules/模块详解-技能子系统.md',
  '模块详解-ArchitectureDecisionRecord架构决策记录': 'modules/模块详解-ArchitectureDecisionRecord架构决策记录.md',
  '模块详解-AutoReinLearningLoop': 'modules/模块详解-自进化搜索引擎.md',
  '模块详解-CausalDataPasser因果数据传递': 'modules/模块详解-CausalDataBus因果数据总线.md',
  '模块详解-ErrorPreventionGuard错误预防守卫': 'modules/模块详解-架构边界守护模块群.md',
  '模块详解-FrameworkComplianceChecker': 'modules/模块详解-FrameworkComplianceChecker模块.md',
  '模块详解-MetaSkillGenerator元技能生成': 'modules/模块详解-MetaSkillOrchestrator元技能编排.md',
  '模块详解-SddContractManager': 'modules/模块详解-SDD规格驱动开发.md',
  '模块详解-SddDocumentValidator': 'modules/模块详解-SDD规格驱动开发.md',
  '模块详解-SkillRouter技能路由': 'modules/模块详解-SkillRouter模块.md',
  '深度拆解-KEPA自学习进化系统融合架构': 'deep-dive/深度拆解-KEPA自学习进化系统融合架构.md',
  '深度拆解-Skill路由全链路': 'deep-dive/深度拆解-Skill路由全链路.md',
  '协作子系统': 'modules/模块详解-协作子系统.md',
  'CausalDataPasser': 'modules/模块详解-CausalDataBus因果数据总线.md',
  'ConvergenceDetector': 'modules/模块详解-OptimizationLoop优化循环.md',
  'MetaSkillGenerator': 'modules/模块详解-MetaSkillOrchestrator元技能编排.md',
  'ProgrammableHookExecutor': 'modules/模块详解-ProgrammableHookExecutor模块.md',
  'README': 'README.md',
  'SDD集成指南': 'guidelines/SDD集成指南.md',
  'Skill速查表': 'guidelines/Skill速查表.md',
};

let errors = 0;

console.log('=== Harness Engineering 文档链接检查 ===\n');

/**
 * @param {string} dir - 要检查的文档目录绝对路径
 */
function checkLinksInDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      checkLinksInDir(fullPath);
    } else if (entry.name.endsWith('.md')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      let match;
      while ((match = LINK_PATTERN.exec(content)) !== null) {
        const linkName = match[1];
        // Skip code-style references like ['A'] or ['skill-a', 'skill-b'] - false positives from code examples
        if (linkName.includes("'")) {
          continue;
        }
        // Handle src/ source file links - check existence in ROOT directory
        if (linkName.startsWith('src/')) {
          const srcTargetPath = path.join(ROOT, linkName);
          if (!fs.existsSync(srcTargetPath)) {
            console.log(`  [ERROR] ${path.relative(ROOT, fullPath)}: 链接 [[${linkName}]] 源文件不存在`);
            errors++;
          }
          continue;
        }
        // Handle path-prefixed links like 'guidelines/Skill速查表'
        let relativePath = DOC_NAME_TO_PATH[linkName];
        if (!relativePath && linkName.includes('/')) {
          // Try the path directly relative to DOCS_DIR
          const directPath = linkName;
          if (fs.existsSync(path.join(DOCS_DIR, directPath))) {
            relativePath = directPath;
          } else {
            // Try stripping the path prefix and looking up the name
            const nameOnly = linkName.split('/').pop();
            relativePath = DOC_NAME_TO_PATH[nameOnly];
          }
        }
        if (!relativePath) {
          console.log(`  [WARN] ${path.relative(ROOT, fullPath)}: 链接 [[${linkName}]] 无路径映射`);
          continue;
        }
        const targetPath = path.join(DOCS_DIR, relativePath);
        if (!fs.existsSync(targetPath)) {
          console.log(`  [ERROR] ${path.relative(ROOT, fullPath)}: 链接 [[${linkName}]] 目标文件不存在: ${relativePath}`);
          errors++;
        }
      }
    }
  }
}

checkLinksInDir(DOCS_DIR);

console.log('\n=== 检查结果 ===');
console.log(`  错误: ${errors}`);
console.log(`  状态: ${errors === 0 ? '✅ 通过' : '❌ 未通过'}`);

process.exit(errors > 0 ? 1 : 0);
