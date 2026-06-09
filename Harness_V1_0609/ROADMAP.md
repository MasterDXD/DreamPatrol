# Harness Engineering 路线图

> 版本：v2.72.0 | 更新日期：2026-06-09

---

## 已完成

- [x] **v2.72.0** — 全面优化完善：DynamicHarnessGenerator核心扩散（TypeScript类型声明/index.d.ts + 模块集成/module-initializer.js + SDK文档）+ 版本统一v2.37.0→v2.72.0（11处）+ v2.13.0文档版本修复（6处）+ ESLint零错误（修复5个undefined常量+1个unused变量）+ 测试覆盖扩展43→65项（+22中文触发/安全编译/并发/边缘场景）+ DynamicHarnessGenerator文档API参考完善 + 交叉一致性检查
- [x] **v2.36.0** — TDD/SDD/DDD 三维融合：TDD循环追踪器（TddCycleTracker监控RED-GREEN-REFACTOR状态转换）+ SDD孤立模块激活（SddPhaseBridge集成到运行时）+ DDD核心战术模式（Entity/ValueObject/AggregateRoot/DomainEvent/DomainEventBus/Repository/InMemoryRepository/DomainService/Specification/ContextMapper共10个基础类）+ 64个测试用例
- [x] **v2.35.0** — Autoresearch自主研究闭环融合（AutonomousResearchLoop七阶段循环 + ExperimentSandbox实验沙箱 + ResearchDomainAdapter领域适配器）+ 8个预定义研究领域 + 67个测试用例 + OODA循环集成 + 自主优化编排器集成
- [x] **v2.34.0** — 全面Bug审计与修复第七轮：4项无界Map增长修复（affinity-learner/config-manager/chat-chain/moe-gating-router）+ 34处removeAllListeners系统性修复（覆盖tui/skill/infrastructure/graphify/doc-parser/agent/model/prompt/adapter/session/collaboration共11个子系统）+ 文档系统性完善（新增6个子系统模块清单：图谱编译/文档解析/提示词编译/SDD契约驱动/适配器/其他运行时模块）
- [x] **v2.33.0** — 多Agent架构融合（PlatformGateway多平台接入网关、BusinessAgentRegistry业务Agent注册中心、PriorityScheduler优先级调度器）+ 多平台适配（WebChat/APP/飞书/邮件）+ 3个业务Agent（客服/订单处理/物流）+ 统一消息格式标准化 + 跨平台用户记忆绑定 + 负载均衡与超时切换 + 50项平台集成测试 + 5项已知错误修复
- [x] **v2.21.0** — 新Agent注册（Backend Engineer、Data Analyst、Frontend Engineer、Marketing Strategist、Product Manager、Research Specialist、SEO Specialist、UX Designer）+ dynamic-workflow Skill注册 + 版本号统一 + 框架验证通过
- [x] **v2.20.0** — 文档系统性完善（link-check 0警告、sync-check 0警告、RBAC权限矩阵统一、Agent技能列表同步）+ 全面测试验证通过
- [x] **v2.19.0** — 代码质量审查与修复（StateGraph合并策略修复、HookComposer计数器修复、_executeHandler返回值修复、MetaSkillOrchestrator条件处理修复、MCP适配层死代码清理、上下文预算优化器回收逻辑修复）
- [x] **v2.18.0** — 安全审查（9个关键文件安全扫描，0可利用漏洞）
- [x] **v2.17.0** — 模块详解文档补全（动态Agent生成器、上下文预算优化器、SkillPack技能包分发、MCP服务器自动发现、Hook组合器）
- [x] **v2.16.0** — 基础设施完善（CLI验证命令、ESLint配置迁移、TypeScript声明文件、npm包发布配置）
- [x] **v2.15.0** — Codex VibeCoding融合（Cron调度器+外部触发器、DeriveExecutor派生执行引擎、VibeCoding工程化规则、GoalExecutor验收标准增强）+ 43个新增单元测试 + ESLint 0错误
- [x] **v2.14.0** — LangChain概念融合（StateGraph状态机编排、PhaseOrchestrator动态路由、MetaSkillOrchestrator模板生成/LLM生成、MCP-LangChain适配层）+ 99个新增单元测试 + sync-check/link-check 0错误
- [x] **v2.13.0** — Claude Code扩展概念融合（CONVENTION.md、SubagentExecutor临时工/团队API区分、PairChat多会话团队持久化、Hook reasoning条件分支、OutputConcisenessGuard输出精简守护）
- [x] **v2.12.0** — Anthropic Harness设计理念融合（三层体系、Context Anxiety防护、偏差校准、迁移性引擎）
- [x] **v2.11.6** — ESLint全量清零 + 代码复杂度降低 + null引用防护 + 文档补全
- [x] **v2.11.5** — OpenSquilla Meta Skill融合（技能组合MetaSkillOrchestrator + 成本感知路由CostAwareRouter）
- [x] **v2.10.6** — 核心框架稳定（28个Agent、84个Skill、6阶段流程、三级缓存SkillRouter、TDD强制门禁）

---

## 短期规划（v2.21.x — 预计2026年6月）

### 文档质量提升
- [x] 补全缺失的核心文档（核心功能-思维与记忆系统、核心功能-记忆管道系统、核心功能-信号持久化）
- [x] 修复文档内链中剩余 WARN（link-check 0警告、sync-check 0警告）
- [x] 统一所有文档版本号为 v2.20.0
- [x] 补全新增模块的模块详解文档（StateGraph、MCP-LangChain适配层、MetaSkillOrchestrator生成能力）
- [x] RBAC权限矩阵同步（Agent文件技能列表与入口文件一致）

### 测试覆盖增强
- [ ] 为 v2.11.5+ 新增模块补全单元测试（compute-accelerator、task-lifecycle-orchestrator、evaluation-calibrator、harness-migration-engine）
- [ ] 添加因果子系统端到端集成测试
- [ ] 测试覆盖率目标：模块级 > 80%

### 功能完善
- [ ] 内置 GPU 加速实现（WebGPU/Node-CUDA），消除对外部 gpuBridge 的依赖
- [ ] 因果子系统实际运行验证（通过真实多Agent协作场景填充因果链数据）

---

## 中期规划（v2.38.x — 预计2026年7月）

### 集成增强
- [x] 默认激活 MCP 集成（cli-anything、opencli），从 disabled 改为 enabled
- [x] MCP-LangChain适配层（MCPToolAdapter、MCPToolBinding、toOpenAIFunctions、createLangChainTools）
- [ ] 添加更多 MCP 服务端支持（filesystem、memory、sequential-thinking 等）
- [ ] 完善浏览器自动化（browser-use-adapter）的端到端场景

### 性能优化
- [ ] 上下文压缩引擎性能基准测试与优化
- [ ] Token 预算管理粒度细化（从会话级到 Skill级）
- [ ] 向量索引（CausalVectorIndex）的 Embedding 缓存预热

### 质量保障
- [ ] 添加性能回归测试套件
- [ ] 添加安全漏洞扫描（npm audit CI集成）
- [ ] 完善 Fuzzing 测试（异常输入覆盖率）

---

## 长期规划（v3.0.0 — 预计2026年Q3）

### 架构演进
- [ ] CommonJS → ESM 模块系统迁移
- [ ] TypeScript 完整类型覆盖（当前仅 index.d.ts 声明文件）
- [ ] 插件系统（第三方 Skill/Agent/Hook 扩展机制）
- [ ] 分布式 Agent 协作（跨进程/跨机器 Agent 通信）

### 生态建设
- [ ] 公共 Skill 市场 / 注册表
- [ ] 项目模板市场（基于 ProjectScaffolder 的预设扩展）
- [ ] 社区贡献指南与 CI/CD 流水线

### 用户体验
- [ ] Web Dashboard 2.0（重构为 SPA 框架 + 实时数据可视化）
- [ ] CLI 交互式引导（首次使用向导）
- [ ] 多语言支持（i18n 完整覆盖）

---

## 已知问题

### 文档
- 所有文档内链已修复（link-check 0警告、sync-check 0警告）
- 模块文档版本号已统一为 v2.20.0

### 功能
- 因果子系统（causal-wal）的 causalChain 在框架自检中为空（需要在真实多Agent协作中验证）
- GPU 加速依赖外部 gpuBridge 注入，无内置实现
- MCP 集成已默认激活（cli-anything、opencli）

### 测试
- 无端到端集成测试
- ~~v2.11.5+ 新增模块缺少独立单元测试文件~~（已补全：StateGraph 36个测试、PhaseOrchestrator 20个测试、MetaSkillOrchestrator 19个测试、MCP-LangChain适配器 24个测试）

---

## 贡献指南

参见 [开发指南-代码贡献规范](docs/guidelines/开发指南-代码贡献规范.md)

- 所有功能开发必须先通过 TDD 门禁
- PR 需附带测试和文档更新
- ESLint 必须保持 0 errors, 0 warnings