# Harness Engineering 多Agent框架 v2.72.0 — GitHub Copilot使用说明

## 项目概述
Harness Engineering 是一个基于多Agent架构范式的工程化开发框架，采用"分层分责+文档驱动+流程管控+容错自愈"的方法论。框架包含84个技能、六阶段执行流程、28个Agent角色（6职能型+5任务型+5语言审查员+1人类角色+8专业角色+3业务型）、TDD强制驱动。在GitHub Copilot中，你作为AI编码助手，按照以下规则和流程协助开发任务。

## 关键特性
- **技能体系**：84个技能（20个验证技能+62个扩展技能+2个基础设施技能，Skill自动路由、按需加载）
- **六阶段流程**：需求探索 → 需求分析 → 架构设计 → 模块开发 → 集成测试 → 部署上线
- **Agent体系**：28个Agent（6职能型+5任务型+5语言审查员+1人类角色+8专业角色+3业务型）
- **TDD强制**：先写测试后写代码，RED-GREEN-REFACTOR，无例外
- **文档驱动**：六层文档体系（架构→核心→模块→工具→深度→准则），编码前文档先行

## 技术栈
- **运行时**：Node.js（CommonJS模块系统）
- **后端**：Node.js原生`http`模块（无Express/Koa），自研WebSocket处理器
- **前端**：原生HTML5 + CSS3 + Vanilla JavaScript（无React/Vue/Angular）
- **数据存储**：better-sqlite3
- **测试**：Node.js内置test runner + c8覆盖率
- **Lint**：ESLint（`npx eslint src/ test/ scripts/`，要求0 errors, 0 warnings）

## 核心原则
- **分层分责**：Team Lead → Domain Analyst → Task Worker → QA，每层各司其职
- **文档驱动**：六层文档体系，双向链接形成知识图谱
- **流程管控**：六阶段执行流程，每阶段有明确交付物和验收标准
- **容错自愈**：失败重试、任务重分配、Checkpoint恢复、模型降级
- **TDD强制**：先写测试后写代码，RED-GREEN-REFACTOR，无例外
- **证据验证**：声称完成必须提供实际证据，口头完成不算完成

## Agent角色体系

### 职能型Agent（6个）
- **Team Lead**：项目拆解、任务分配、进度监控、成果验收
- **Domain Analyst**：需求分析、架构设计、代码审核、技术攻关
- **Task Worker**：编码实现、工具调用、过程记录
- **Quality Assurance**：质量检查、测试设计、缺陷管理
- **DevOps Engineer**：基础设施、构建部署、系统监控
- **Technical Writer**：文档编写、知识管理、变更记录

### 任务型Agent（5个）
- **Code Reviewer**：专注代码质量审查
- **Security Reviewer**：专注安全审计
- **Build Error Solver**：专注编译错误、依赖冲突排查
- **Planner**：专注需求探索、实现规划、任务拆解
- **Test Writer**：专注TDD测试编写、覆盖率优化

### 语言专属审查员（5个）
- TypeScript Reviewer、Python Reviewer、Go Reviewer、Rust Reviewer、Java Reviewer

### 人类角色（1个）
- **System Designer（系统设计者）**：定义边界、搭建反馈、将人类判断转化为机器规则

## 六阶段执行流程
1. **需求探索**（brainstorming）→ 设计方案文档
2. **需求分析与规划**（requirement-analysis）→ 项目计划书、需求规格说明书
3. **架构设计**（architecture-design）→ 系统架构图、模块划分、接口设计
4. **模块开发**（tdd-implement + module-development，TDD门禁）→ 源码、单元测试、文档
5. **集成测试**（integration-testing）→ 测试报告、缺陷报告
6. **部署上线**（verification-before-completion → deployment）→ 部署文档、运维手册

## 技能体系（84个技能）

### 验证技能（20个）
覆盖需求探索、需求分析、架构设计、模块开发、集成测试、部署上线全流程的强制性验证技能。

### 扩展技能（62个）
涵盖代码审查、安全审计、性能优化、重构、调试、MVP构建、UI工程、动效设计、图标集成、浏览器自动化、知识库管理、技能蒸馏、网站克隆、数据采集、writing-skills（技能编写）等各领域。

### 基础技能（2个）
- **Skill路由引擎**：自动发现、匹配、激活技能
- **会话启动Hook**：自动注入规则

## 斜杠命令（24个）
- `/plan` → 需求探索到架构设计
- `/code-review` → 代码审查
- `/security-review` → 安全审计
- `/debug` → 系统化调试
- `/fix` → 缺陷修复
- `/deploy` → 部署上线
- `/test` → 集成测试
- `/refactor` → 系统化重构
- `/build` → TDD驱动开发
- `/ship` → 验证到部署
- `/spec` → 需求分析到架构设计
- `/startup` → 完整项目启动流程
- 及其他14个命令

## 全局规则

### 任务执行
- 大任务拆分为6-9个批次，从宏观到微观逐步深入
- 每个阶段设置明确交付物和验收标准
- 未通过验收自动触发修正流程

### 文档规范
- 六层文档体系：架构→核心→模块→工具→深度→准则
- 使用`[[文档名称]]`创建双向链接
- 编码前文档先行（docs-before-code）

### 安全与权限
- 敏感信息加密存储，禁止日志泄露
- 文件删除、系统命令等敏感操作需用户确认
- 避免多Agent同时修改同一文件

### 成本控制
- Token预算管理，80%预警，95%切换低价模型
- 优先使用低价模型完成简单任务

## Skill自动路由
在执行任何任务前，必须检查是否有相关技能应该被激活。技能按需加载：仅加载当前阶段相关Skill的完整内容，避免信息过载。

## 项目配置
详细配置参见 `.harness/config.json`，包含完整的技能定义（skills目录下所有技能的元数据、触发条件、执行步骤）、模型选择、Token预算、权限配置、Hook配置等。技能的具体实现和描述位于 `.harness/skills/` 目录下。

## 验证命令
- `npm test` — 运行单元测试和集成测试
- `npm run validate` — 框架一致性检查 + 测试
- `npx eslint src/ test/ scripts/` — ESLint代码质量检查（0 errors, 0 warnings）
- `node harness-cli.js validate` — CLI快速验证
- `node harness-cli.js commands` — 列出所有斜杠命令
- `node harness-cli.js skills` — 列出所有技能及验证状态
- `node harness-cli.js dashboard` — 启动监控仪表盘（默认端口3210）