# Harness Engineering — 多Agent框架

> 从Prompt工程到软件工程的关键跨越：可执行的运行时引擎 + 权限执行引擎 + TDD门禁

## 概述

Harness Engineering 是一个面向AI辅助编程的多Agent协作框架，采用"分层分责+文档驱动+流程管控+容错自愈"的工程化方法论。框架将规则从Markdown文档转化为**可强制执行的代码**，实现从Prompt工程到软件工程的关键跨越。

## 核心特性

- **28个Agent**（6职能型 + 5任务型 + 5语言审查员 + 1人类角色 + 8专业角色 + 3业务型）→ [完整列表](docs/guidelines/框架使用说明.md#agent角色体系)
- **84个Skill**（config.json注册84个Skill）→ [完整列表](docs/guidelines/Skill速查表.md)
- **运行时引擎**：SkillRouter / SessionManager / PhaseOrchestrator → [架构详解](docs/architecture/架构分析-AIProject系统.md)
- **平台集成**：PlatformGateway / BusinessAgentRegistry / PriorityScheduler → [平台集成](src/runtime/platform/)
- **自主研究闭环**：AutonomousResearchLoop / ExperimentSandbox / ResearchDomainAdapter → [自主研究](src/runtime/optimization/)
- **权限执行引擎**：RBACEnforcer / PermissionGuard / AuditLogger → [权限详解](docs/deep-dive/深度拆解-权限执行引擎与安全防护.md)
- **TDD门禁**：TDDGate / EvidenceVerifier / TddCycleTracker / FrameworkComplianceChecker → [门禁详解](docs/core/核心功能-TDD门禁执行流程.md)
- **DDD领域驱动**：Entity / ValueObject / AggregateRoot / DomainEvent / Repository / Specification / ContextMapper → [领域驱动](src/domain/)
- **SDD规范驱动**：SddContractManager / IronRuleEngine / SddPhaseBridge → [规范驱动](src/runtime/sdd/)
- **因果推理**：SimulationEngine / ScenarioPredictor / WorldLineManager → [因果详解](docs/modules/模块详解-因果子系统.md)
- **协作引擎**：PairChat / ChatChain / EnsembleOrchestrator → [协作详解](docs/modules/模块详解-协作子系统.md)
- **4款编辑器适配**：Claude Code / Trae / Cursor / Windsurf

## 快速开始

### 安装

```bash
git clone https://github.com/harness-engineering/framework.git
cd framework
npm install
```

要求：Node.js >= 18.0.0

### 验证

```bash
npm test          # 运行7800+单元测试和集成测试
npm run validate  # 框架一致性检查 + 测试
npx eslint src/ test/ scripts/  # ESLint代码质量检查
```

### 使用运行时引擎

```javascript
const { SkillRouter, SessionManager, RBACEnforcer, TDDGate } = require('./src');

const projectRoot = process.cwd();

const router = new SkillRouter(projectRoot);
router.discover();
const matches = router.match({ userMessage: '帮我做需求分析', agent: 'domain-analyst' });

const enforcer = new RBACEnforcer(projectRoot);
enforcer.load();
if (!enforcer.canExecute('team-lead', 'tdd-implement')) {
  console.log('Permission denied');
}

const tddGate = new TDDGate();
const result = tddGate.check({
  implFile: 'src/main.py',
  testFile: 'test/test_main.py',
  testExists: false,
  implExists: true,
});
// result.passed === false — TDD violation detected
```

## 配置

框架通过 `.harness/config.json` 进行配置，主要配置项：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `version` | string | — | 框架版本号 |
| `max_concurrent_agents` | number | 6 | 最大并发Agent数 |
| `task_timeout_minutes` | number | 20 | 任务超时时间（分钟） |
| `token_budget` | number | 1000000000 | Token预算 |
| `enforcement` | string | "recommended" | 权限执行级别（strict/recommended/optional/always） |
| `runtime_config.default_timeout_ms` | number | 30000 | 默认超时毫秒数 |
| `runtime_config.session_ttl_ms` | number | 3600000 | 会话TTL毫秒数 |
| `platform_config.platform_gateway.enabled` | boolean | true | 启用多平台接入网关 |
| `platform_config.business_agent_registry.enabled` | boolean | true | 启用业务Agent注册中心 |
| `platform_config.priority_scheduler.enabled` | boolean | true | 启用优先级调度器 |
| `platform_config.priority_scheduler.max_concurrent_per_agent` | number | 5 | 单Agent最大并发任务数 |
| `platform_config.priority_scheduler.default_timeout_ms` | number | 300000 | 任务默认超时（毫秒） |

环境变量：

| 变量 | 说明 |
|------|------|
| `HARNESS_DEBUG` | 设为 `1` 启用调试日志输出 |
| `HARNESS_PORT` | Dashboard服务端口（默认3210） |

## API参考

### SkillRouter — Skill自动路由

```javascript
const { SkillRouter } = require('./src');
const router = new SkillRouter(projectRoot);
router.discover();
const matches = router.match({ userMessage: '帮我做需求分析', agent: 'domain-analyst' });
```

### RBACEnforcer — 基于角色的访问控制

```javascript
const { RBACEnforcer } = require('./src');
const enforcer = new RBACEnforcer(projectRoot);
enforcer.load();
enforcer.canExecute('team-lead', 'tdd-implement'); // true/false
enforcer.startWatching(); // 启用热重载
```

### PairChat — 配对对话（交叉验证）

```javascript
const { PairChat } = require('./src');
const pairChat = new PairChat();
const { sessionId } = pairChat.startCrossValidation({
  agentA: 'programmer', agentB: 'reviewer',
  artifact: 'src/module.js', artifactType: 'code',
  mode: PairChat.CROSS_VALIDATION_MODES.BIDIRECTIONAL,
});
```

### ChatChain — 链式对话

```javascript
const { ChatChain } = require('./src');
const chain = new ChatChain();
const { chainId } = chain.createChain({ name: '开发流水线' });
chain.registerArtifact(chainId, { name: 'design-doc', type: 'document', phase: 'design' });
```

### SimulationEngine — 因果推演

```javascript
const { SimulationEngine } = require('./src');
const engine = new SimulationEngine();
const result = await engine.simulate({
  initialState: new Map([['revenue', 100]]),
  actions: [{ cause: 'launch', effect: 'revenue_increase', probability: 0.8 }],
  maxDepth: 5,
});
```

### TDDGate — TDD强制门禁

```javascript
const { TDDGate } = require('./src');
const gate = new TDDGate();
const result = gate.check({ implFile: 'src/main.py', testFile: 'test/test_main.py', testExists: false, implExists: true });
```

### PlatformGateway — 多平台接入网关

```javascript
const { PlatformGateway, WebChatAdapter, AppAdapter } = require('./src/runtime/platform');

const gateway = new PlatformGateway({
  platformAdapters: { webchat: new WebChatAdapter(), app: new AppAdapter() },
  businessAgentRouter: new BusinessAgentRegistry(),
});

// 接收跨平台消息，自动标准化格式、绑定用户、路由到业务Agent
const result = await gateway.receive('webchat', {
  userId: 'user-001', content: '我要查询订单', sessionId: 'sess-001',
});
// result.message.userId — 统一用户ID
// result.route.agentType — 匹配的业务Agent类型
```

## 项目结构

```
├── src/                          # 可执行运行时引擎（384+源文件）
│   ├── index.js                  # 包入口（导出240+模块）
│   ├── runtime/                  # 核心运行时（14个功能子目录）
│   │   ├── agent/                # Agent生命周期、部署、沙箱、路由
│   │   ├── causal/               # 因果数据总线、一致性检查、向量索引
│   │   ├── collaboration/        # 协作模式路由、链式/结对/融合
│   │   ├── context/              # 上下文压缩、隔离、LTI注入、相位注入
│   │   ├── deepening/            # 深化推理管道（50+子模块）
│   │   ├── infrastructure/       # 事件总线、健康检查、MCP客户端、重试引擎
│   │   ├── model/                # 模型选择、嵌入服务、Token管理
│   │   ├── quality/              # 对抗审查、质量评分、自反思、自演化
│   │   ├── session/              # 会话管理、检查点
│   │   ├── skill/                # Skill路由、创建、策展、改进、精简
│   │   ├── thought/              # 思维提取、去重、记忆存储、检索循环
│   │   ├── tui/                  # TUI终端界面、REPL引擎、人格管理
│   │   ├── user/                 # 用户建模、亲和学习、结构化意图
│   │   └── workflow/             # 目标执行、命令路由、Hook、RAG管道
│   ├── permission/               # 权限执行引擎
│   │   ├── rbac-enforcer.js      # RBAC访问控制
│   │   ├── permission-guard.js   # 文件权限守卫
│   │   └── audit-logger.js       # 审计日志
│   ├── gate/                     # TDD门禁执行器（18 个文件）
│   │   ├── tdd-gate.js           # TDD强制门禁
│   │   ├── evidence-verifier.js  # 证据验证器
│   │   ├── framework-compliance-checker.js  # 框架合规检查
│   │   ├── design-skill-engine.js           # 设计技能引擎
│   │   ├── code-review-framework-check.js   # 代码审查框架
│   │   ├── deviation-approval.js            # 偏差审批
│   │   ├── generator-verifier.js            # 生成器验证器
│   │   ├── shared-rule-helpers.js           # 共享规则辅助
│   │   ├── skill-patch-approval.js          # 技能补丁审批
│   │   ├── design-tokens.js                # 设计令牌
│   │   ├── output-conciseness-guard.js      # 输出精简度守卫
│   │   ├── layer-boundary-guard.js          # 层级边界守卫
│   │   ├── architecture-boundary-enforcer.js # 架构边界执行器
│   │   ├── code-drift-detector.js           # 代码漂移检测器
│   │   ├── error-prevention-guard.js        # 错误预防守卫
│   │   └── karpathy-enhancer.js             # Karpathy原则增强器
│   ├── utils/                    # 共享工具
│   │   ├── constants.js          # 阶段常量、Frontmatter解析器
│   │   ├── debug-logger.js       # 调试日志
│   │   ├── sanitizer.js          # 对象清洗、XSS防护
│   │   ├── debounced-persister.js # 防抖持久化
│   │   └── bounded-array.js      # 有界数组（LRU/FIFO）
│   ├── errors.js                 # 统一错误体系
│   └── web/                      # Web仪表板
│       ├── server.js             # HTTP服务器（335+ API端点）
│       └── public/               # 前端资源
├── .harness/                     # 框架配置
│   ├── agents/                   # Agent角色定义
│   ├── skills/                   # Skill模板（84 个）
│   ├── rules/                    # 全局规则
│   ├── commands/                 # 斜杠命令定义
│   └── config.json               # 全局配置
├── test/                         # 测试套件（149测试文件）
├── docs/                         # 六层文档体系
└── scripts/                      # 验证脚本
```

## 六阶段执行流程

1. **需求探索** → brainstorming → 设计方案文档
2. **需求分析** → requirement-analysis → 项目计划书、需求规格说明书
3. **架构设计** → architecture-design → 系统架构图、模块划分
4. **模块开发** → tdd-implement + module-development → 源码、单元测试
5. **集成测试** → integration-testing → 测试报告、缺陷报告
6. **部署上线** → deployment → 部署文档、运维手册

## 许可证

MIT License — 详见 [LICENSE](LICENSE)

## 更多文档

- [框架使用说明](docs/guidelines/框架使用说明.md) — 完整用户手册
- [快速开始指南](docs/guidelines/快速开始指南.md) — 安装、配置、部署、5分钟上手
- [开发规范](docs/guidelines/开发指南-代码贡献规范.md) — 代码贡献指南
- [文档索引](docs/README.md) — 六层文档体系导航
