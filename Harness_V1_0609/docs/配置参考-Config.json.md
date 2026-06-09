﻿﻿﻿# 配置参考-Config.json

> 版本：2.73.4 | 配置文件：`.harness/config.json` | 行数：974行

---

## 目录

- [1. 项目基础配置](#1-项目基础配置)
- [2. 阶段预算分配](#2-阶段预算分配)
- [2.5 Agent角色定义](#25-agent角色定义)
- [3. 技能注册表](#3-技能注册表)
- [4. 斜杠命令系统](#4-斜杠命令系统)
- [5. TDD配置](#5-tdd配置)
- [6. 验证配置](#6-验证配置)
- [7. Agent权限配置](#7-agent权限配置)
- [8. 钩子配置](#8-钩子配置)
- [9. 日志配置](#9-日志配置)
- [10. 运行时配置](#10-运行时配置)
- [10.5 协作配置](#105-协作配置)
- [11. 权限执行配置](#11-权限执行配置)
- [12. 门禁配置](#12-门禁配置)
- [13. 深化推理配置](#13-深化推理配置)
- [14. 模型选择配置](#14-模型选择配置)
- [15. 上下文压缩配置](#15-上下文压缩配置)
- [15.5 MoE门控路由配置](#155-moe门控路由配置)
- [15.6 平台集成配置](#156-平台集成配置)
- [15.7 知识库配置](#157-知识库配置)
- [15.8 自动研究循环配置](#158-自动研究循环配置)
- [15.9 技能蒸馏配置](#159-技能蒸馏配置)
- [15.10 技能效能配置](#1510-技能效能配置)
- [15.11 机会发现配置](#1511-机会发现配置)
- [15.12 AI开发者分析配置](#1512-ai开发者分析配置)
- [16. MCP服务器配置](#16-mcp服务器配置)
- [附录A：配置一致性约束](#附录a配置一致性约束)
- [附录B：配置修改流程](#附录b配置修改流程)
- [附录C：配置验证命令](#附录c配置验证命令)
- [附录D：环境变量覆盖](#附录d环境变量覆盖)
- [附录E：配置验证规则](#附录e配置验证规则)
- [附录F：常见配置错误](#附录f常见配置错误)
- [附录G：验证通过条件](#附录g验证通过条件)
- [限界上下文配置 (bounded_contexts)](#限界上下文配置-bounded_contexts)

---

## 1. 项目基础配置

项目基础配置定义了框架的全局运行参数，位于 `config.json` 顶层。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `project_name` | string | `"AIProject"` | 任意非空字符串 | 项目名称，用于日志标识和会话记录 |
| `version` | string | `"2.7.162"` | 语义化版本号 | 框架版本号，需与 `CLAUDE.md` 中声明一致 |
| `max_concurrent_agents` | number | `6` | 1–17 | 最大并发Agent数量，受Agent角色总数（17个）上限约束 |
| `task_timeout_minutes` | number | `20` | 1–120 | 单任务超时时间（分钟），超时后触发修正流程或重试 |
| `max_retry_times` | number | `3` | 0–10 | 最大重试次数，配合 `retry_backoff_strategy` 使用 |
| `retry_backoff_strategy` | string | `"exponential"` | `"exponential"` / `"linear"` / `"fixed"` | 重试退避策略。`exponential`：指数退避（1s→2s→4s）；`linear`：线性递增；`fixed`：固定间隔 |
| `token_budget` | number | `1000000000` | ≥1000000 | 项目总Token预算。80%预警，95%切换低价模型，100%暂停所有任务 |
| `default_model` | string | `"gpt-4o"` | 有效模型标识符 | 默认使用的LLM模型，需与 `model_selector_config.default_model` 保持一致 |
| `fallback_models` | string[] | `["claude-3-opus", "deepseek-v3"]` | 有效模型标识符数组 | 降级模型链，当默认模型不可用时依次尝试 |
| `auto_compact_threshold` | number | `0.8` | 0.5–0.95 | 自动压缩阈值，上下文Token使用率达到此比例时触发 `ContextCompressionEngine` |
| `checkpoint_interval` | string | `"30m"` | 时间间隔字符串（如 `"10m"`, `"1h"`） | 检查点创建间隔，`CheckpointManager` 按此周期自动创建快照 |

### 版本白名单

`version` 字段必须为以下值之一，否则验证失败：

```
1.0.0, 2.0.0, 2.1.0, 2.2.0, 2.3.0, 2.4.0, 2.5.0, 2.6.0, 2.7.0,
2.7.1, 2.7.2, 2.7.100 ~ 2.7.139
```

> **交叉引用**：[[核心功能-上下文压缩引擎]] · [[模块详解-CheckpointManager检查点管理器]] · [[模块详解-TokenManager模块]] · [[核心功能-成本控制机制]]

**使用示例**：

```json
{
  "project_name": "MyProject",
  "version": "2.7.162",
  "max_concurrent_agents": 4,
  "task_timeout_minutes": 30,
  "token_budget": 500000000
}
```

> ⚠️ **注意**：修改 `token_budget` 后需重启会话生效。`version` 字段需与 `src/utils/constants.js` 中的版本常量同步更新。

---

## 2. 阶段预算分配

`phase_budget_allocation` 定义了六阶段执行流程中每个阶段的Token预算占比。所有阶段占比之和必须等于 1.0。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `brainstorming` | number | `0.05` | 0–1 | 需求探索阶段预算占比（5%） |
| `requirement-analysis` | number | `0.1` | 0–1 | 需求分析与规划阶段预算占比（10%） |
| `architecture-design` | number | `0.2` | 0–1 | 架构设计阶段预算占比（20%） |
| `module-development` | number | `0.35` | 0–1 | 模块开发阶段预算占比（35%），占比最高，因编码和测试消耗最大 |
| `integration-testing` | number | `0.2` | 0–1 | 集成测试阶段预算占比（20%） |
| `deployment` | number | `0.1` | 0–1 | 部署上线阶段预算占比（10%） |

**约束条件**：
- 所有阶段占比之和 **必须等于 1.0**
- `module-development` 建议保持最高占比（≥0.3），因为TDD流程需要大量Token
- `brainstorming` 建议保持较低占比（≤0.1），该阶段以对话为主

> **交叉引用**：[[核心功能-多Agent协作流程]] · [[模块详解-PhaseOrchestrator阶段编排器]] · [[核心功能-成本控制机制]]

**预算计算公式**：

```
阶段可用Token = token_budget × phase_budget_allocation[当前阶段]
```

---

## 2.5 Agent角色定义

`agents` 数组定义了28个Agent角色的基础属性，每个元素包含以下字段：

### 2.5.1 Agent通用字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | Agent唯一标识符，小写字母+连字符（如 `"team-lead"`） |
| `name` | string | 是 | Agent英文名称 |
| `name_zh` | string | 是 | Agent中文名称 |
| `type` | string | 是 | Agent类型：`"functional"` / `"task"` / `"language-reviewer"` / `"human"` |
| `role` | string | 是 | Agent角色标识，对应权限配置中的键名 |
| `enforcement` | string | 否 | 规则执行力度：`"strict"` / `"recommended"` / `"optional"`（默认 `"recommended"`） |
| `skills` | string[] | 否 | 该Agent可使用的技能ID列表 |

### 2.5.2 Agent类型说明

| 类型 | 说明 | 包含的Agent |
|------|------|------------|
| `functional` | 职能型Agent，负责核心职能 | team-lead, domain-analyst, task-worker, quality-assurance, devops-engineer, technical-writer |
| `task` | 任务型Agent，专注特定任务 | code-reviewer, security-reviewer, build-error-solver, planner, test-writer |
| `language-reviewer` | 语言专属审查员 | typescript-reviewer, python-reviewer, go-reviewer, rust-reviewer, java-reviewer |
| `human` | 人类角色 | system-designer |

---

## 3. 技能注册表

`skill_registry` 定义了框架全部84个技能的元数据和触发规则。

### 3.1 注册表全局配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `auto_trigger_enabled` | boolean | `true` | 是否启用Skill自动触发。设为 `false` 时所有Skill需手动通过斜杠命令激活 |

### 3.2 技能条目字段

每个技能条目包含以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skill_id` | string | 是 | 技能唯一标识符，对应 `.harness/skills/` 目录下的文件名（不含 `.md`） |
| `name` | string | 是 | 技能中文显示名称 |
| `phase` | string | 是 | 所属执行阶段：`brainstorming` / `requirement-analysis` / `architecture-design` / `module-development` / `integration-testing` / `deployment` / `infrastructure` |
| `priority` | number | 是 | 同阶段内的优先级，数值越小优先级越高（0为最高） |
| `enforcement` | string | 是 | 强制级别：`strict`（必须执行）/ `recommended`（推荐执行）/ `optional`（可选执行） |
| `type` | string | 否 | 技能类型，仅基础设施技能标注为 `"infrastructure"`，其他技能省略此字段 |

### 3.3 完整技能清单

#### 需求分析阶段

| skill_id | name | phase | priority | enforcement |
|----------|------|-------|----------|-------------|
| `brainstorming` | 头脑风暴 | brainstorming | 0 | recommended |
| `requirement-analysis` | 需求分析 | requirement-analysis | 1 | recommended |
| `necessity-review` | 必要性审查 | module-development | 0 | recommended |

#### 架构设计阶段

| skill_id | name | phase | priority | enforcement |
|----------|------|-------|----------|-------------|
| `architecture-design` | 架构设计 | architecture-design | 2 | recommended |
| `cloud-ai-blueprint` | AI系统蓝图规划 | architecture-design | 2 | recommended |
| `taste-skill` | 审美判断 | architecture-design | 2 | recommended |
| `design-md` | DESIGN.md 设计语言文档 | architecture-design | 1 | strict |

#### 模块开发阶段

| skill_id | name | phase | priority | enforcement |
|----------|------|-------|----------|-------------|
| `tdd-implement` | TDD驱动开发 | module-development | 3 | strict |
| `module-development` | 模块开发 | module-development | 3 | strict |
| `dispatching-parallel` | 并行子代理调度 | module-development | 3 | optional |
| `code-review` | 代码审查 | module-development | 4 | strict |
| `verification-before-completion` | 完成前验证 | module-development | 4 | strict |
| `systematic-debugging` | 系统化调试 | module-development | 4 | recommended |
| `bug-fix` | 缺陷修复 | module-development | 4 | strict |
| `security-audit` | 安全审计 | module-development | 5 | strict |
| `performance-optimization` | 性能优化 | module-development | 5 | recommended |
| `refactor-code` | 系统化重构 | module-development | 5 | recommended |
| `impeccable` | 设计规范落地 | module-development | 2 | recommended |
| `ui-skills` | 模块化UI工程 | module-development | 2 | recommended |
| `motion-ai-kit` | 动效技能 | module-development | 3 | optional |
| `better-icons` | 图标技能 | module-development | 3 | optional |
| `iterative-deepening` | 迭代深化推理 | module-development | 2 | recommended |
| `multi-agent-fusion` | 多Agent协同融合 | module-development | 2 | recommended |
| `ai-prompting` | AI编程提示词工程 | module-development | 2 | recommended |
| `web-interaction` | 网页交互 | module-development | 2 | optional |
| `writing-skills` | 技能编写 | module-development | 8 | optional |

#### 集成测试阶段

| skill_id | name | phase | priority | enforcement |
|----------|------|-------|----------|-------------|
| `integration-testing` | 集成测试 | integration-testing | 6 | strict |

#### 部署上线阶段

| skill_id | name | phase | priority | enforcement |
|----------|------|-------|----------|-------------|
| `deployment` | 部署上线 | deployment | 7 | strict |
| `documentation` | 文档编写 | deployment | 7 | recommended |
| `auto-doc-generation` | 自动文档生成 | deployment | 3 | recommended |

#### 基础设施

| skill_id | name | phase | priority | enforcement | type |
|----------|------|-------|----------|-------------|------|
| `skill-router` | Skill路由引擎 | infrastructure | 0 | strict | infrastructure |
| `session-start-hook` | 会话启动Hook | infrastructure | 0 | strict | infrastructure |

> **交叉引用**：[[核心功能-Skill自动路由机制]] · [[模块详解-SkillRouter模块]] · [[深度拆解-Skill路由全链路]] · [[guidelines/Skill速查表]]

**enforcement 级别说明**：

- **strict**：必须执行，跳过将导致任务被 `RBACEnforcer` 阻止
- **recommended**：推荐执行，跳过会记录警告但不阻止
- **optional**：可选执行，仅在用户明确请求或上下文高度匹配时触发

> **验证规则**：`enforcement` 值必须为 `strict`/`recommended`/`optional` 之一，否则验证报错。若与 `.harness/skills/` 下技能文件的 `enforcement` 不一致，会产生警告（以技能文件为准）。

---

## 4. 斜杠命令系统

`commands` 数组定义了24个斜杠命令，每个命令映射到一个或多个技能链。

### 4.1 命令条目字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command_id` | string | 是 | 命令标识符，即用户输入的斜杠命令名（不含 `/` 前缀） |
| `name` | string | 是 | 命令中文显示名称 |
| `skills` | string[] | 是 | 触发的技能链，按数组顺序依次执行 |
| `agent` | string | 是 | 默认执行Agent的角色标识符 |
| `phase` | string | 是 | 命令所属的执行阶段 |

### 4.2 完整命令清单

| command_id | name | skills | agent | phase |
|------------|------|--------|-------|-------|
| `plan` | 实现规划 | brainstorming → requirement-analysis → architecture-design | team-lead | brainstorming |
| `code-review` | 代码审查 | code-review | code-reviewer | module-development |
| `security-review` | 安全审查 | security-audit | security-reviewer | module-development |
| `debug` | 系统化调试 | systematic-debugging → bug-fix | task-worker | module-development |
| `fix` | 缺陷修复 | bug-fix → verification-before-completion | task-worker | module-development |
| `deploy` | 部署上线 | verification-before-completion → deployment | devops-engineer | deployment |
| `test` | 集成测试 | integration-testing | quality-assurance | integration-testing |
| `refactor` | 系统化重构 | refactor-code | task-worker | module-development |
| `prompt` | AI编程提示词工程 | ai-prompting | task-worker | module-development |
| `audit` | 审计查询 | security-audit | quality-assurance | module-development |
| `build` | 构建实现 | tdd-implement → module-development | task-worker | module-development |
| `code-simplify` | 代码简化 | refactor-code | task-worker | module-development |
| `goal` | 目标执行 | iterative-deepening → brainstorming → requirement-analysis | team-lead | brainstorming |
| `learn` | 触发学习 | iterative-deepening | domain-analyst | module-development |
| `optimize` | 性能优化 | performance-optimization | domain-analyst | module-development |
| `review` | 代码审查 | code-review → security-audit | code-reviewer | module-development |
| `section` | Section生成 | ui-skills → design-md | task-worker | module-development |
| `ship` | 发布上线 | verification-before-completion → deployment | devops-engineer | deployment |
| `spec` | 规格定义 | requirement-analysis → architecture-design | domain-analyst | requirement-analysis |
| `web` | 网页交互 | web-interaction | task-worker | module-development |

> **交叉引用**：[[核心功能-斜杠命令路由]] · [[模块详解-CommandRouter模块]]

**使用方式**：

```
/plan          → 触发完整规划流程
/code-review   → 触发代码审查
/fix           → 触发缺陷修复+验证
```

> ⚠️ **注意**：`CommandRouter` 支持中文命令别名和模糊匹配，具体别名定义在 `.harness/commands/` 目录下。

---

## 5. TDD配置

`tdd_config` 控制TDD（测试驱动开发）门禁的强制执行策略。TDD是框架的核心方法论，默认强制启用。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | `true` / `false` | 是否启用TDD门禁。设为 `false` 将跳过RED-GREEN-REFACTOR检测 |
| `test_coverage_threshold` | number | `0.8` | 0–1 | 测试覆盖率阈值，低于此值 `TDDGate` 将阻止任务提交 |
| `red_green_refactor_enforced` | boolean | `true` | `true` / `false` | 是否强制RED-GREEN-REFACTOR循环。`true` 时必须先写失败测试再写实现 |
| `no_code_without_test` | boolean | `true` | `true` / `false` | 是否禁止无测试代码。`true` 时任何实现代码必须对应至少一个测试 |
| `delete_prewritten_implementation` | boolean | `true` | `true` / `false` | 是否删除预写实现。`true` 时如果检测到实现先于测试存在，将自动删除实现代码 |

> **交叉引用**：[[核心功能-TDD门禁执行流程]] · [[模块详解-TDDGate模块]] · [[模块详解-EvidenceVerifier模块]]

**TDD门禁执行流程**：

```
编写测试 → RED（测试失败）→ 编写最小实现 → GREEN（测试通过）→ REFACTOR（重构）→ 覆盖率检查 → 通过
```

> ⚠️ **警告**：`enabled: false` 仅建议在紧急修复场景下临时使用，正常开发流程中必须保持 `true`。`delete_prewritten_implementation: true` 会不可逆地删除代码，请确保版本控制已启用。

---

## 6. 验证配置

`verification_config` 控制"完成前验证"（verification-before-completion）的强制策略。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | `true` / `false` | 是否启用完成前验证 |
| `lint_zero_errors_required` | boolean | `true` | `true` / `false` | 是否要求ESLint零错误。`true` 时lint有任何error/warning将阻止提交 |
| `test_pass_rate_required` | number | `1` | 0–1 | 测试通过率要求。`1` 表示100%通过，`0.95` 表示允许5%失败 |
| `evidence_mandatory` | boolean | `true` | `true` / `false` | 是否强制要求完成证据。`true` 时Agent声称完成任务必须提供实际证据 |
| `skip_requires_lead_approval` | boolean | `false` | `true` / `false` | 跳过验证是否需要Team Lead审批。`false` 时跳过验证需人工确认 |

> **交叉引用**：[[模块详解-EvidenceVerifier模块]] · [[模块详解-FrameworkComplianceChecker模块]]

**证据类型**（由 `EvidenceVerifier` 定义）：

| 证据类型 | 说明 | 强度 |
|----------|------|------|
| 测试通过报告 | 包含覆盖率数据的测试结果 | 强 |
| Lint检查结果 | ESLint零错误零警告的输出 | 强 |
| 构建成功日志 | 无错误的构建输出 | 强 |
| 代码审查通过 | Code Reviewer的审核意见 | 弱（需人工确认） |
| 功能演示截图 | UI功能的手动验证 | 弱（需人工确认） |

---

## 7. Agent权限配置

`agent_permissions` 为28个Agent角色定义了细粒度的工具访问权限和操作限制。

### 7.1 权限字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `allowed_tools` | string[] | 允许使用的工具列表。`["all"]` 表示无限制 |
| `restricted_operations` | string[] | 禁止执行的操作列表 |
| `requires_confirmation` | string[] | 需要人工确认才能执行的操作列表 |

### 7.2 工具标识符说明

| 工具标识符 | 说明 |
|------------|------|
| `all` | 所有工具（无限制） |
| `read_file` | 读取文件 |
| `write_file` | 写入文件 |
| `search_files` | 搜索文件/代码 |
| `run_command` | 执行命令 |
| `web_search` | 网络搜索 |
| `web_interact` | 网页交互（OpenCLI） |
| `cli_anything` | CLI-Anything软件操控 |

### 7.3 操作标识符说明

| 操作标识符 | 说明 |
|------------|------|
| `file_delete` | 删除文件 |
| `system_command` | 执行系统命令 |
| `modify_harness_config` | 修改Harness配置文件 |
| `budget_override` | 覆盖Token预算限制 |
| `model_change` | 切换LLM模型 |
| `production_deploy` | 生产环境部署 |
| `database_migration` | 数据库迁移 |
| `network_request` | 发起网络请求 |

### 7.4 职能型Agent权限（6个）

#### team-lead（团队负责人）

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["all"]` |
| `restricted_operations` | `["file_delete", "system_command"]` |
| `requires_confirmation` | `["budget_override", "model_change"]` |

> 最高权限Agent，可使用所有工具，但删除文件和系统命令被限制，预算覆盖和模型切换需确认。

#### domain-analyst（领域分析师）

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["read_file", "write_file", "search_files", "web_search", "web_interact"]` |
| `restricted_operations` | `["file_delete", "system_command"]` |
| `requires_confirmation` | `[]` |

> 可读写文件和搜索，禁止删除和系统命令。

#### task-worker（任务执行者）

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["read_file", "write_file", "search_files", "run_command", "web_interact"]` |
| `restricted_operations` | `["file_delete", "modify_harness_config"]` |
| `requires_confirmation` | `["system_command", "network_request"]` |

> 可执行命令，但系统命令和网络请求需确认，禁止删除文件和修改配置。

#### quality-assurance（质量保证）

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["read_file", "search_files", "run_command", "web_search"]` |
| `restricted_operations` | `["write_file", "file_delete", "system_command"]` |
| `requires_confirmation` | `[]` |

> 只读权限为主，可执行命令用于运行测试，禁止写入、删除和系统命令。

#### devops-engineer（运维工程师）

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["all"]` |
| `restricted_operations` | `["modify_harness_config"]` |
| `requires_confirmation` | `["production_deploy", "database_migration"]` |

> 全工具权限，生产部署和数据库迁移需确认，禁止修改框架配置。

#### technical-writer（技术文档工程师）

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["read_file", "write_file", "search_files"]` |
| `restricted_operations` | `["file_delete", "system_command", "modify_harness_config"]` |
| `requires_confirmation` | `[]` |

> 仅文件读写和搜索权限，禁止删除、系统命令和修改配置。

### 7.5 任务型Agent权限（5个）

#### code-reviewer（代码审查员）

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["read_file", "search_files", "run_command", "web_search"]` |
| `restricted_operations` | `["write_file", "file_delete", "system_command", "modify_harness_config"]` |
| `requires_confirmation` | `[]` |

> 纯审查权限，只读+运行命令（用于lint等），禁止任何写入操作。

#### security-reviewer（安全审查员）

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["read_file", "search_files", "run_command", "web_search"]` |
| `restricted_operations` | `["write_file", "file_delete", "system_command", "modify_harness_config"]` |
| `requires_confirmation` | `[]` |

> 与code-reviewer权限一致，纯审查角色。

#### build-error-solver（构建错误解决者）

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["read_file", "write_file", "search_files", "run_command"]` |
| `restricted_operations` | `["file_delete", "modify_harness_config"]` |
| `requires_confirmation` | `["system_command"]` |

> 可读写文件和执行命令，系统命令需确认，用于修复构建错误。

#### planner（实现规划师）

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["read_file", "write_file", "search_files", "web_search"]` |
| `restricted_operations` | `["file_delete", "system_command", "modify_harness_config"]` |
| `requires_confirmation` | `[]` |

> 可读写文件和搜索，用于编写规划文档。

#### test-writer（测试编写者）

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["read_file", "write_file", "search_files", "run_command"]` |
| `restricted_operations` | `["file_delete", "modify_harness_config"]` |
| `requires_confirmation` | `["system_command"]` |

> 可读写文件和执行命令（运行测试），系统命令需确认。

### 7.6 语言专属审查员权限（5个）

以下5个语言审查员权限配置完全一致：

| 字段 | 值 |
|------|-----|
| `allowed_tools` | `["read_file", "search_files", "run_command", "web_search"]` |
| `restricted_operations` | `["write_file", "file_delete", "system_command", "modify_harness_config"]` |
| `requires_confirmation` | `[]` |

适用Agent：
- `typescript-reviewer`
- `python-reviewer`
- `go-reviewer`
- `rust-reviewer`
- `java-reviewer`

> 语言审查员均为纯审查角色，只读+运行命令（用于类型检查/lint等），禁止任何写入操作。

> **交叉引用**：[[核心功能-权限控制与审计]] · [[模块详解-RBACEnforcer模块]] · [[模块详解-PermissionGuard模块]] · [[深度拆解-权限执行引擎与安全防护]]

---

## 8. 钩子配置

`hooks` 定义了框架生命周期中8个关键节点的可编程钩子，由 `ProgrammableHookExecutor` 执行。

### 8.1 钩子条目字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 是否启用此钩子 |
| `actions` | string[] | 会话启动时执行的动作列表（仅 `session_start`） |
| `checks` | string[] | 钩子触发时执行的检查列表 |

### 8.2 完整钩子清单

#### session_start（会话启动）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `actions` | `["inject_core_identity", "inject_skill_router", "load_current_phase_context"]` |

> 会话创建时自动注入核心身份、Skill路由指令和当前阶段上下文。

**动作说明**：

| 动作 | 说明 |
|------|------|
| `inject_core_identity` | 注入Agent角色定义和核心规则 |
| `inject_skill_router` | 注入Skill路由引擎指令 |
| `load_current_phase_context` | 加载当前执行阶段的相关上下文 |

#### pre_tool_call（工具调用前）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `checks` | `["permission_check", "parameter_validation", "rate_limit_check"]` |

> 每次工具调用前执行权限检查、参数验证和速率限制检查。

#### pre_file_write（文件写入前）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `checks` | `["path_validation", "content_safety", "backup_original"]` |

> 文件写入前验证路径安全性、内容安全性和备份原文件。

#### pre_task_submit（任务提交前）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `checks` | `["deliverable_completeness", "quality_standards", "yagni_pre_check"]` |

> 任务提交前检查交付物完整性、质量标准和YAGNI原则（You Ain't Gonna Need It）。

#### pre_model_call（模型调用前）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `checks` | `["token_budget_check", "content_safety", "output_format_check"]` |

> LLM调用前检查Token预算、内容安全性和输出格式。

#### post_task_complete（任务完成后）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `checks` | `["verification_before_completion", "token_auto_record"]` |

> 任务完成后执行完成前验证和Token消耗自动记录。

#### post_tool_use（工具使用后）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `checks` | `["audit_log_record", "content_safety"]` |

> 工具使用后记录审计日志和检查内容安全性。

#### post_file_write（文件写入后）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `checks` | `["quality_standards", "simplicity_check", "surgical_change_check", "audit_log_record", "design_anti_pattern_check", "accessibility_compliance"]` |

> 文件写入后执行最多检查项，包括质量标准、简洁性、手术式变更、审计日志、设计反模式和无障碍合规。

**检查项说明**：

| 检查项 | 说明 |
|--------|------|
| `permission_check` | RBAC权限检查 |
| `parameter_validation` | 工具参数合法性验证 |
| `rate_limit_check` | 速率限制检查 |
| `path_validation` | 文件路径安全性验证（防路径遍历） |
| `content_safety` | 内容安全性检查（防XSS/注入） |
| `backup_original` | 备份原文件 |
| `deliverable_completeness` | 交付物完整性检查 |
| `quality_standards` | 质量标准检查 |
| `yagni_pre_check` | YAGNI原则预检（防止过度设计） |
| `token_budget_check` | Token预算检查 |
| `output_format_check` | 输出格式检查 |
| `verification_before_completion` | 完成前验证 |
| `token_auto_record` | Token消耗自动记录 |
| `audit_log_record` | 审计日志记录 |
| `simplicity_check` | 简洁性检查 |
| `surgical_change_check` | 手术式变更检查（最小化改动范围） |
| `design_anti_pattern_check` | 设计反模式检测 |
| `accessibility_compliance` | 无障碍合规检查 |

> **交叉引用**：[[模块详解-ProgrammableHookExecutor模块]] · [[核心功能-权限控制与审计]]

> ⚠️ **注意**：钩子执行采用顺序执行+阻塞中断模式，单个检查失败将中断后续检查。每个钩子有60秒超时保护。

---

## 9. 日志配置

`logging` 控制框架的日志记录策略。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `level` | string | `"info"` | `"debug"` / `"info"` / `"warn"` / `"error"` | 日志级别。`debug` 最详细，`error` 最精简 |
| `audit_all_tool_calls` | boolean | `true` | `true` / `false` | 是否审计所有工具调用。`true` 时每次工具调用都记录到审计日志 |
| `audit_all_file_operations` | boolean | `true` | `true` / `false` | 是否审计所有文件操作。`true` 时每次文件读写都记录到审计日志 |
| `retention_days` | number | `30` | 1–365 | 审计日志保留天数，超过此天数的日志自动清理 |

> **交叉引用**：[[模块详解-PermissionGuard模块]]（审计日志存储）· [[核心功能-权限控制与审计]]

**日志级别说明**：

| 级别 | 说明 | 适用场景 |
|------|------|----------|
| `debug` | 最详细，包含所有调试信息 | 开发调试、问题排查 |
| `info` | 标准级别，记录关键操作 | 日常运行（推荐） |
| `warn` | 仅警告和错误 | 生产环境 |
| `error` | 仅错误 | 最小化日志场景 |

---

## 10. 运行时配置

`runtime_config` 包含运行时引擎的核心配置，分为容量配置、Skill路由、会话管理和阶段编排四个子模块。

### 10.1 容量配置（capacity_config）

`capacity_config` 定义了运行时各组件的容量上限，防止资源耗尽。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `causal_memory_max` | number | `500` | 10–10000 | 因果内存最大条目数，`CausalMemoryStore` 的容量上限 |
| `causal_memory_ttl_days` | number | `30` | 1–365 | 因果内存TTL（天），超期自动清理 |
| `causal_chain_max` | number | `200` | 10–1000 | 因果链最大长度，`CausalDataBus` 的链深度上限 |
| `pending_outputs_max` | number | `50` | 10–500 | 待处理输出最大数量 |
| `skill_interfaces_max` | number | `100` | 10–500 | Skill接口最大注册数 |
| `conflict_resolvers_max` | number | `20` | 5–100 | 冲突解决器最大数量 |
| `execution_history_max` | number | `100` | 10–1000 | 执行历史最大记录数 |
| `deduplication_index_max` | number | `200` | 10–1000 | 去重索引最大条目数 |
| `module_instances_max` | number | `200` | 10–1000 | 模块实例最大数量 |
| `goals_max` | number | `100` | 10–500 | 最大目标数量，`GoalExecutor` 的并发目标上限 |
| `sandboxes_max` | number | `50` | 5–200 | 最大沙箱数量，`AgentSandbox` 的并发上限 |
| `custom_policies_max` | number | `100` | 10–500 | 自定义策略最大数量 |
| `handlers_max` | number | `50` | 5–200 | 处理器最大注册数 |
| `similarity_threshold` | number | `0.3` | 0–1 | 相似度阈值，低于此值认为不相似（用于去重和匹配） |
| `conflict_similarity_threshold` | number | `0.7` | 0–1 | 冲突相似度阈值，高于此值认为存在冲突 |
| `decay_factor_per_day` | number | `0.98` | 0.9–1.0 | 每日衰减因子，控制记忆/数据的自然衰减速率 |

> **交叉引用**：[[模块详解-因果子系统]] · [[模块详解-GoalExecutor目标执行器]]

### 10.2 Skill路由配置（skill_router）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `discovery_path` | string | `".harness/skills/"` | Skill发现路径，相对于项目根目录 |
| `auto_discover` | boolean | `true` | 是否自动发现新Skill。`true` 时 `SkillRouter` 启动时扫描发现路径 |
| `conflict_resolution` | string | `"phase_priority"` | 冲突解决策略。`phase_priority`：按阶段优先级选择；`first_match`：选择第一个匹配 |

> **交叉引用**：[[核心功能-Skill自动路由机制]] · [[模块详解-SkillRouter模块]] · [[深度拆解-Skill路由全链路]]

### 10.3 会话管理配置（session_manager）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `persistence_path` | string | `".harness/sessions/"` | 有效目录路径 | 会话持久化路径，相对于项目根目录 |
| `auto_persist` | boolean | `true` | `true` / `false` | 是否自动持久化会话状态。`true` 时 `SessionManager` 使用防抖持久化 |
| `session_ttl_hours` | number | `24` | 1–168 | 会话TTL（小时），超期会话自动清理 |
| `max_sessions` | number | `100` | 10–1000 | 最大会话数量 |

> **交叉引用**：[[模块详解-SessionManager会话管理器]] · [[模块详解-CheckpointManager检查点管理器]]

### 10.4 阶段编排配置（phase_orchestrator）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `strict_phase_transition` | boolean | `true` | 是否强制严格阶段转换。`true` 时必须按六阶段顺序推进，不可跳过 |
| `allow_backward_transition` | boolean | `false` | 是否允许回退阶段。`false` 时一旦进入下一阶段不可回退 |

> **交叉引用**：[[模块详解-PhaseOrchestrator阶段编排器]] · [[核心功能-多Agent协作流程]]

> ⚠️ **注意**：`strict_phase_transition: false` 和 `allow_backward_transition: true` 仅建议在调试场景下使用，正常开发流程中应保持默认值。

### 10.5 规则注册表配置（rules_registry）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `discovery_path` | string | `".harness/rules/"` | 规则发现路径，相对于项目根目录 |
| `auto_discover` | boolean | `true` | 是否自动发现规则 |
| `rules` | string[] | 见下方 | 已注册规则列表 |

**默认已注册规则**：

```
task-execution, context-management, document-standards, monitoring-fault-tolerance,
cost-control, security-permissions, best-practices, coding-standards,
ai-prompting-standards, karpathy-principles, memory-persistence,
anti-sycophancy, token-efficiency, anti-bad-code
```

### 10.6 Agent多样性配置（agent_diversity）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `diversity_threshold` | number | `0.3` | 0–1 | 多样性阈值 |
| `max_history` | number | `50` | ≥1 | 历史记录最大条目数 |
| `ensemble_modes` | string[] | `["bagging", "boosting", "stacking"]` | — | 可用集成模式（子集） |
| `default_mode` | string | `"boosting"` | 三选一 | 默认集成模式 |
| `bagging_max_agents` | number | `5` | ≥2 | Bagging模式最大Agent数 |
| `boosting_max_iterations` | number | `3` | ≥1 | Boosting模式最大迭代数 |
| `stacking_meta_learner` | boolean | `true` | — | Stacking模式是否启用元学习器 |

> **交叉引用**：[[模块详解-AgentDiversityManager]]

### 10.7 做梦调度器配置（dream_scheduler）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用做梦调度 |
| `review_interval_ms` | number | `1800000` | ≥60000 | 回顾间隔（毫秒，默认30分钟） |
| `batch_size` | number | `10` | ≥1 | 批量回顾大小 |
| `max_experiences` | number | `500` | ≥1 | 最大经验条目数 |

> **交叉引用**：[[模块详解-DreamScheduler梦境调度器]]

### 10.8 错误预防守卫配置（error_prevention_guard）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用错误预防守卫 |
| `max_patterns` | number | `500` | ≥1 | 最大错误模式数 |
| `max_warnings_per_check` | number | `10` | ≥1 | 每次检查最大警告数 |
| `auto_sync_from_dream` | boolean | `true` | — | 是否从DreamEngine自动同步 |

> **交叉引用**：[[模块详解-ErrorPreventionGuard]]

### 10.9 Playbook生成器配置（playbook_generator）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用Playbook生成 |
| `max_playbooks` | number | `200` | ≥1 | 最大Playbook数 |
| `max_steps_per_playbook` | number | `20` | ≥1 | 每个Playbook最大步骤数 |
| `auto_generate_from_dream` | boolean | `true` | — | 是否从DreamEngine自动生成 |

> **交叉引用**：[[模块详解-PlaybookGenerator]]

### 10.10 技能树DAG配置（skill_tree_dag）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用技能树DAG |
| `max_depth` | number | `10` | ≥1 | 技能树最大深度 |
| `max_children` | number | `20` | ≥1 | 每个节点最大子节点数 |

> **交叉引用**：[[模块详解-SkillTreeDAG]]

### 10.11 推理缓存配置（inference_cache）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用推理缓存 |
| `max_size` | number | `100` | ≥1 | 缓存最大条目数 |
| `ttl_ms` | number | `1800000` | ≥1000 | 缓存TTL（毫秒，默认30分钟） |

> **交叉引用**：[[模块详解-InferenceCache]]

---

## 10.5 协作配置

`collaboration_config` 控制多Agent协作的集成编排策略，包括Bagging（并行求稳）、Boosting（串行纠错）、Stacking（元学习）三种集成模式。

### 10.5.1 集成编排配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `ensemble.enabled` | boolean | `true` | 是否启用集成编排 |
| `ensemble.default_mode` | string | `"boosting"` | 默认集成模式：`"bagging"` / `"boosting"` / `"stacking"` |
| `ensemble.diversity_check` | boolean | `true` | 是否检查Agent多样性 |
| `ensemble.auto_mode_selection` | boolean | `true` | 是否自动选择集成模式 |

### 10.5.2 Bagging模式配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `modes.bagging.parallel` | boolean | `true` | 是否并行执行 |
| `modes.bagging.max_agents` | number | `5` | 最大Agent数（≥2） |
| `modes.bagging.fusion_strategy` | string | `"vote"` | 融合策略：`"vote"` / `"average"` / `"weighted"` |
| `modes.bagging.min_diversity_score` | number | `0.4` | 最低多样性分数 |

### 10.5.3 Boosting模式配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `modes.boosting.parallel` | boolean | `false` | 是否并行执行（Boosting为串行） |
| `modes.boosting.max_iterations` | number | `3` | 最大迭代次数（≥1） |
| `modes.boosting.error_focus_weight` | number | `0.7` | 错误聚焦权重 |
| `modes.boosting.min_improvement` | number | `0.05` | 最小改进阈值 |

### 10.5.4 Stacking模式配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `modes.stacking.parallel` | boolean | `true` | 是否并行执行 |
| `modes.stacking.base_agents` | number | `3` | 基础Agent数量（≥2） |
| `modes.stacking.meta_learner_enabled` | boolean | `true` | 是否启用元学习器 |
| `modes.stacking.training_window` | number | `10` | 训练窗口大小（≥1） |

### 10.5.5 贡献度追踪配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `contribution_tracker.enabled` | boolean | `true` | 是否启用贡献度追踪 |
| `contribution_tracker.max_records` | number | `1000` | 最大记录数（≥1） |

> **交叉引用**：[[模块详解-EnsembleOrchestrator]] · [[模块详解-AgentContributionTracker]] · [[模块详解-AgentDiversityManager]]

---

## 11. 权限执行配置

`permission_config` 控制权限执行引擎的三个核心组件。

### 11.1 RBAC执行器（rbac_enforcer）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `agents_path` | string | `".harness/agents/"` | Agent角色定义文件路径，相对于项目根目录 |
| `strict_enforcement_blocking` | boolean | `true` | 是否严格阻止未授权操作。`true` 时未授权操作直接阻止；`false` 时仅记录警告 |

> **交叉引用**：[[模块详解-RBACEnforcer模块]] · [[深度拆解-权限执行引擎与安全防护]]

### 11.2 权限守卫（permission_guard）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `system_files` | string[] | `["config.json", "agents", "skills", "rules", "workspace"]` | 系统保护文件/目录列表，这些资源默认不可被Agent修改 |
| `allowed_mutable_dirs` | string[] | `["sessions", "checkpoints"]` | 允许Agent写入的目录列表 |
| `lock_timeout_minutes` | number | `20` | 文件锁超时时间（分钟），超时后锁自动释放 |
| `confirmation_expiry_minutes` | number | `5` | 确认有效期（分钟），超过此时间需重新确认 |

> **交叉引用**：[[模块详解-PermissionGuard模块]]

### 11.3 审计日志（audit_logger）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | `true` / `false` | 是否启用审计日志 |
| `retention_days` | number | `30` | 1–365 | 审计日志保留天数 |
| `max_entries` | number | `10000` | 100–100000 | 审计日志最大条目数，超出后自动清理最旧记录 |

> **交叉引用**：[[核心功能-权限控制与审计]]

> ⚠️ **注意**：审计日志采用链式哈希完整性验证，任何篡改都会被检测到。`max_entries` 设置过小可能导致重要审计记录被清理。

---

## 12. 门禁配置

`gate_config` 控制TDD门禁和证据验证器的行为。

### 12.1 TDD门禁（tdd_gate）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | `true` / `false` | 是否启用TDD门禁 |
| `coverage_threshold` | number | `0.8` | 0–1 | 覆盖率阈值（0-1范围），与 `tdd_config.test_coverage_threshold` 保持一致 |
| `test_coverage_threshold` | number | `0.8` | 0–1 | 测试覆盖率阈值（0-1范围） |
| `delete_prewritten_implementation` | boolean | `true` | `true` / `false` | 是否删除预写实现。`true` 时如果检测到实现先于测试存在，将自动删除实现代码 |
| `block_implementation_without_test` | boolean | `true` | `true` / `false` | 是否阻止无测试的实现代码。`true` 时检测到实现先于测试将阻止提交 |
| `max_cycles_per_task` | number | `100` | 1–1000 | 每个任务最大RED-GREEN-REFACTOR循环次数，防止无限循环 |

> **交叉引用**：[[核心功能-TDD门禁执行流程]] · [[模块详解-TDDGate模块]]

### 12.2 证据验证器（evidence_verifier）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用证据验证器 |

> **交叉引用**：[[模块详解-EvidenceVerifier模块]]

### 12.3 输出精简度守卫（output_conciseness_guard）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用输出精简度守卫 |
| `max_tokens` | number | `2000` | ≥100 | 最大Token数 |
| `max_lines` | number | `100` | ≥10 | 最大行数 |
| `max_repetition_ratio` | number | `0.3` | 0–1 | 最大重复率 |
| `penalty_threshold` | number | `0.7` | 0–1 | 惩罚触发阈值 |

> **交叉引用**：[[模块详解-OutputConcisenessGuard]]

> ⚠️ **注意**：`tdd_gate.coverage_threshold` 和 `tdd_config.test_coverage_threshold` 应保持一致，不一致时以 `tdd_gate.coverage_threshold` 为准（门禁实际执行值）。

---

## 13. 深化推理配置

`deepening_config` 控制深化推理子系统的全部参数，这是框架最复杂的配置区域之一。

### 13.1 循环深化（recurrent_deepening）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `max_iterations` | number | `4` | 1–20 | 最大深化迭代次数 |
| `convergence_threshold` | number | `0.85` | 0.5–1.0 | 收敛阈值，质量评分达到此值时停止深化 |
| `min_improvement` | number | `0.02` | 0.01–0.1 | 最小改进量，单次迭代改进低于此值时判定为停滞 |

> **交叉引用**：[[深度拆解-深化推理全链路]] · [[模块详解-DeepeningOrchestrator模块]]

### 13.2 自适应深度（adaptive_depth）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `quick_threshold` | number | `0.25` | 0–1 | 快速模式复杂度阈值，低于此值使用快速模式（1轮深化） |
| `standard_threshold` | number | `0.5` | 0–1 | 标准模式复杂度阈值，低于此值使用标准模式（2-3轮深化） |
| `deep_threshold` | number | `0.75` | 0–1 | 深度模式复杂度阈值，高于此值使用深度模式（4-5轮深化） |
| `max_depth` | number | `5` | 1–10 | 最大深化深度 |

**复杂度→深度映射**：

```
复杂度 < 0.25  → quick（1轮）
0.25 ≤ 复杂度 < 0.5 → standard（2-3轮）
0.5 ≤ 复杂度 < 0.75 → standard（3-4轮）
复杂度 ≥ 0.75 → deep（4-5轮）
```

### 13.3 LTI上下文注入器（lti_context_injector）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mode` | string | `"lti"` | 上下文注入模式。`lti`：学习工具互操作模式 |
| `max_history` | number | `10` | 最大历史上下文条目数 |

### 13.4 多Agent路由器（multi_agent_router）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `top_k` | number | `2` | 1–5 | 选择亲和度最高的K个Agent参与协作 |
| `min_affinity` | number | `0.3` | 0–1 | 最小亲和度阈值，低于此值的Agent不参与协作 |

> **交叉引用**：[[模块详解-SubagentExecutor模块]]

### 13.5 输出融合（output_fusion）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `default_strategy` | string | `"cascade"` | 默认融合策略。`cascade`：级联融合（依次传递改进）；`vote`：投票融合；`weighted`：加权融合；`merge`：合并融合 |

### 13.6 迭代精化（iterative_refinement）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `max_refinements` | number | `3` | 1–10 | 最大精化轮数 |
| `quality_threshold` | number | `0.8` | 0–1 | 质量阈值，达到此值时停止精化 |

### 13.7 渐进深化（progressive_deepening）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `default_level` | string | `"standard"` | 默认深化级别。`quick` / `standard` / `deep` |

### 13.8 深化编排器（deepening_orchestrator）

这是深化推理的核心编排配置，整合了多个子模块参数。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `default_depth_level` | string | `"standard"` | `quick` / `standard` / `deep` | 默认深化级别 |
| `max_iterations` | number | `4` | 1–20 | 最大迭代次数 |
| `convergence_threshold` | number | `0.85` | 0.5–1.0 | 收敛阈值 |
| `top_k` | number | `2` | 1–5 | 多Agent选择数 |
| `fusion_strategy` | string | `"cascade"` | `cascade` / `vote` / `weighted` / `merge` | 融合策略 |
| `token_budget_ratio` | number | `0.3` | 0.1–0.5 | 深化推理占用Token预算的比例 |
| `enable_lti` | boolean | `true` | `true` / `false` | 是否启用LTI上下文注入 |
| `enable_adaptive_depth` | boolean | `true` | `true` / `false` | 是否启用自适应深度控制 |
| `enable_multi_agent` | boolean | `true` | `true` / `false` | 是否启用多Agent协作深化 |

> **交叉引用**：[[模块详解-DeepeningOrchestrator模块]] · [[模块详解-DeepeningPipeline模块]] · [[深度拆解-深化推理全链路]]

### 13.9 质量评分器（quality_scorer）

#### 权重配置（weights）

| 维度 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `completeness` | number | `0.25` | 0–1 | 完整性权重（功能是否完整实现） |
| `correctness` | number | `0.30` | 0–1 | 正确性权重（逻辑是否正确），权重最高 |
| `consistency` | number | `0.15` | 0–1 | 一致性权重（代码风格和架构是否一致） |
| `coverage` | number | `0.15` | 0–1 | 覆盖率权重（测试覆盖是否充分） |
| `clarity` | number | `0.15` | 0–1 | 清晰度权重（代码是否易于理解） |

> ⚠️ **约束**：五个权重之和必须等于 1.0。

#### 阈值配置（thresholds）

| 等级 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `excellent` | number | `0.9` | 优秀阈值，评分≥0.9为优秀 |
| `good` | number | `0.75` | 良好阈值，评分≥0.75为良好 |
| `acceptable` | number | `0.6` | 可接受阈值，评分≥0.6为可接受 |
| `poor` | number | `0.4` | 较差阈值，评分<0.4为不合格 |

> **交叉引用**：[[模块详解-QualityScorer质量评分器]]

**质量评分计算公式**：

```
quality_score = completeness × 0.25 + correctness × 0.30 + consistency × 0.15 + coverage × 0.15 + clarity × 0.15
```

### 13.10 Token感知深化（token_aware_deepening）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `budget_ratio` | number | `0.3` | 0.1–0.5 | 深化推理允许使用的Token预算比例 |
| `min_budget_remaining` | number | `0.1` | 0.05–0.2 | 最低剩余预算比例，低于此值停止深化 |
| `iteration_token_cost` | number | `1000` | 100–10000 | 单次深化迭代的预估Token消耗 |

> ⚠️ **注意**：`budget_ratio` 与 `deepening_orchestrator.token_budget_ratio` 应保持一致。

### 13.11 亲和力学习器（affinity_learner）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `learning_rate` | number | `0.1` | 0.01–1.0 | 学习率，控制亲和力更新速度 |
| `decay_factor` | number | `0.995` | 0.9–1.0 | 衰减因子，控制历史亲和力的衰减速率 |
| `min_samples` | number | `3` | 1–10 | 最小样本数，低于此值不进行亲和力评估 |

### 13.12 收敛检测器（convergence_detector）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `quality_threshold` | number | `0.85` | 0.5–1.0 | 质量收敛阈值，评分达到此值判定为收敛 |
| `min_improvement_rate` | number | `0.02` | 0.01–0.1 | 最小改进率，低于此值判定为停滞 |
| `stability_window` | number | `3` | 2–10 | 稳定性窗口大小，连续N轮改进率低于阈值时判定收敛 |
| `stability_variance` | number | `0.01` | 0.001–0.1 | 稳定性方差阈值，方差低于此值判定为稳定 |
| `coverage_threshold` | number | `0.8` | 0–1 | 覆盖率收敛阈值 |
| `dimension_balance_threshold` | number | `0.15` | 0.01–0.5 | 维度平衡阈值，各评分维度间差异低于此值时判定为均衡 |
| `max_iterations` | number | `10` | 1–50 | 最大检测迭代次数 |

> **交叉引用**：[[深度拆解-深化推理全链路]] · [[模块详解-DeepeningPipeline模块]]

---

## 14. 模型选择配置

`model_selector_config` 控制 `ModelSelector` 的模型选择和降级策略。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `default_model` | string | `"gpt-4o"` | 默认模型，需与顶层 `default_model` 保持一致 |
| `fallback_chain` | string[] | `["gpt-4o-mini", "gpt-3.5-turbo"]` | 降级链，按顺序尝试，前一个不可用时切换到下一个。不应包含`default_model`本身 |
| `enable_auto_downgrade` | boolean | `true` | 是否启用自动降级。`true` 时模型不可用自动切换到降级链中的下一个 |
| `complexity_threshold.premium` | number | `0.7` | 高级模型复杂度阈值，任务复杂度≥0.7时使用高级模型 |
| `complexity_threshold.standard` | number | `0.3` | 标准模型复杂度阈值，任务复杂度≥0.3时使用标准模型 |

**模型选择逻辑**：

```
任务复杂度 ≥ 0.7  → 使用高级模型（如 gpt-4o）
0.3 ≤ 复杂度 < 0.7 → 使用标准模型（如 gpt-4o-mini）
复杂度 < 0.3    → 使用经济模型（如 gpt-3.5-turbo）
```

> **交叉引用**：[[模块详解-TokenManager模块]] · [[核心功能-成本控制机制]]

> ⚠️ **注意**：`fallback_chain` 中的模型需确保API密钥已配置。`enable_auto_downgrade: true` 时，Token预算达到95%会自动切换到降级链中最便宜的模型。

---

## 15. 上下文压缩配置

`context_compression` 控制 `ContextCompressionEngine` 的压缩策略。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `threshold` | number | `0.8` | 0.5–0.95 | 压缩触发阈值，上下文Token使用率达到此比例时触发压缩 |
| `retainCurrentPhase` | boolean | `true` | `true` / `false` | 是否保留当前阶段上下文，`true` 时当前阶段的上下文不参与压缩 |
| `retainKeyDecisions` | boolean | `true` | `true` / `false` | 是否保留关键决策，`true` 时重要决策记录不参与压缩 |
| `retainSessionState` | boolean | `true` | `true` / `false` | 是否保留会话状态，`true` 时会话状态不参与压缩 |
| `maxSummaryLength` | number | `200` | 50–1000 | 压缩后摘要的最大长度（Token数） |

> **交叉引用**：[[核心功能-上下文压缩引擎]] · [[模块详解-上下文管理模块]]

**压缩分类策略**：

```
上下文条目 → 分类器 → keep（保留）/ summarize（压缩摘要）/ discard（丢弃）
```

- **keep**：当前阶段上下文、关键决策、会话状态
- **summarize**：历史阶段详细内容、中间推理过程
- **discard**：重复内容、过时信息、低相关性上下文

> ⚠️ **注意**：`threshold` 应与顶层 `auto_compact_threshold` 保持一致。`maxSummaryLength` 设置过小可能导致重要信息丢失，设置过大则压缩效果有限。

---

## 15.5 MoE门控路由配置 (moe_config)

`moe_config` 控制 MoE（Mixture of Experts）统一门控路由器的行为，将 Agent 路由、技能路由、模型选择、协作模式选择纳入同一门控框架。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用MoE统一门控路由 |
| `topK` | number | `2` | 每次路由激活的专家数量 |
| `minGateScore` | number | `0.1` | 最低门控分数阈值 |
| `auxiliaryLossWeight` | number | `0.01` | 负载均衡辅助损失权重 |
| `gateDecayFactor` | number | `0.95` | 门控分数衰减因子（模拟遗忘） |
| `enableSharedExperts` | boolean | `true` | 是否启用共享专家（始终激活） |
| `enableLoadBalancing` | boolean | `true` | 是否启用负载均衡 |

> **交叉引用**：[[模块详解-MoE门控路由器]] · [[模块详解-MultiAgentRouter多Agent路由器]] · [[模块详解-SkillRouter模块]] · [[模块详解-CollaborationModeRouter模块]]

**配置示例**：

```json
{
  "moe_config": {
    "enabled": true,
    "topK": 2,
    "minGateScore": 0.1,
    "auxiliaryLossWeight": 0.01,
    "gateDecayFactor": 0.95,
    "enableSharedExperts": true,
    "enableLoadBalancing": true
  }
}
```

**配置项详解**：

- **`enabled`**：设为 `false` 时，各路由模块（MultiAgentRouter、SkillRouter、ModelSelector 等）独立运行，不经过统一门控。
- **`topK`**：每次路由激活的专家数量。值越大，参与处理的专家越多，但资源消耗也越大。建议范围 1–5。
- **`minGateScore`**：门控分数低于此阈值的专家不会被激活，即使它在 Top-K 范围内。用于过滤低相关性专家。
- **`auxiliaryLossWeight`**：辅助损失权重，控制负载均衡的力度。值越大，门控网络越倾向于均匀分配任务。建议范围 0.001–0.1。
- **`gateDecayFactor`**：历史门控分数的衰减因子。值越接近 1，历史效果影响越持久；值越接近 0，越重视近期效果。
- **`enableSharedExperts`**：启用后，标记为 `isShared` 的专家始终激活，不参与 Top-K 选择。
- **`enableLoadBalancing`**：启用后，门控路由考虑专家当前负载，避免路由崩塌。

> ⚠️ **注意**：`topK` 值不应超过 `max_concurrent_agents`，否则可能导致资源争用。`auxiliaryLossWeight` 设置过高可能导致门控网络过度追求均衡而牺牲任务匹配度。

---

## 15.6 平台集成配置

`platform_config` 控制多平台接入与业务Agent调度的核心配置，包括平台网关、业务Agent注册中心和优先级调度器三个子模块。

### 15.6.1 平台网关（platform_gateway）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用平台网关 |
| `supported_platforms` | string[] | 见下方 | — | 支持的平台列表 |
| `max_history_per_user` | number | `50` | ≥1 | 每用户最大历史记录数 |
| `max_user_bindings` | number | `1000` | ≥1 | 最大用户绑定数 |
| `auto_context_injection` | boolean | `true` | — | 是否自动注入上下文 |

**默认支持平台**：

```
webchat, app, miniprogram, feishu, dingtalk, wechat, email, api
```

> **交叉引用**：[[模块详解-适配器子系统]]

### 15.6.2 业务Agent注册中心（business_agent_registry）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用业务Agent注册中心 |
| `auto_register_templates` | boolean | `true` | 是否自动注册模板Agent |
| `business_agents` | string[] | 见下方 | 预定义业务Agent列表 |
| `default_priority` | number | `5` | 默认优先级 |

**预定义业务Agent**：

```
customer-service, order-processing, logistics, data-analyst,
marketing, payment, account, general
```

### 15.6.3 优先级调度器（priority_scheduler）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用优先级调度器 |
| `max_concurrent_per_agent` | number | `5` | ≥1 | 每个Agent最大并发数 |
| `default_timeout_ms` | number | `300000` | ≥1000 | 默认超时时间（毫秒，5分钟） |
| `urgent_timeout_ms` | number | `120000` | ≥1000 | 紧急任务超时时间（毫秒，2分钟） |
| `overload_threshold` | number | `0.8` | 0–1 | 过载阈值，负载超过此值触发过载保护 |
| `max_queue_size` | number | `1000` | ≥1 | 最大队列大小 |
| `health_check_interval_ms` | number | `30000` | ≥1000 | 健康检查间隔（毫秒） |
| `agent_unresponsive_ms` | number | `60000` | ≥1000 | Agent无响应判定时间（毫秒） |

> **交叉引用**：[[模块详解-适配器子系统]] · [[模块详解-AgentRuntime模块]]

**配置示例**：

```json
{
  "platform_config": {
    "platform_gateway": {
      "enabled": true,
      "supported_platforms": ["webchat", "feishu", "api"],
      "max_history_per_user": 50,
      "auto_context_injection": true
    },
    "business_agent_registry": {
      "enabled": true,
      "auto_register_templates": true,
      "default_priority": 5
    },
    "priority_scheduler": {
      "enabled": true,
      "max_concurrent_per_agent": 5,
      "default_timeout_ms": 300000
    }
  }
}
```

> ⚠️ **注意**：`overload_threshold` 设置过低可能导致正常请求被限流，设置过高则无法有效保护系统。`urgent_timeout_ms` 应小于 `default_timeout_ms`。

---

## 15.7 知识库配置

`knowledge-base` 控制项目知识库的文件管理和编译策略，为框架提供本地知识检索能力。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用知识库 |
| `rootPath` | string | `".harness/knowledge-base"` | 有效目录路径 | 知识库根目录，相对于项目根目录 |
| `supportedFileTypes` | string[] | 见下方 | — | 支持的文件类型列表 |
| `autoCompile` | boolean | `false` | — | 是否自动编译知识库。`true` 时文件变更自动触发编译 |
| `maxRawFiles` | number | `1000` | ≥1 | 最大原始文件数 |
| `maxWikiEntries` | number | `500` | ≥1 | 最大Wiki条目数 |
| `maxOutputFiles` | number | `200` | ≥1 | 最大输出文件数 |

**默认支持文件类型**：

```
.md, .txt, .json, .js, .ts, .py
```

> **交叉引用**：[[模块详解-LLM知识库]] · [[模块详解-RagPipeline检索增强生成管道]]

**配置示例**：

```json
{
  "knowledge-base": {
    "enabled": true,
    "rootPath": ".harness/knowledge-base",
    "supportedFileTypes": [".md", ".txt", ".json", ".js", ".ts", ".py"],
    "autoCompile": false,
    "maxRawFiles": 1000,
    "maxWikiEntries": 500,
    "maxOutputFiles": 200
  }
}
```

> ⚠️ **注意**：`autoCompile` 设为 `true` 时，大量文件变更可能触发频繁编译，影响性能。建议在开发阶段设为 `false`，部署阶段设为 `true`。`maxRawFiles` 超过限制后新文件不会被自动索引。

---

## 15.8 自动研究循环配置

`autoresearch_loop_config` 控制自动研究循环子系统的全部参数，包括循环控制、实验沙箱和领域适配器三个子模块。

### 15.8.1 循环控制

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用自动研究循环 |
| `max_concurrent_loops` | number | `3` | 1–10 | 最大并发研究循环数 |
| `max_iterations_per_loop` | number | `10` | 1–100 | 每个循环最大迭代次数 |
| `min_observations_before_hypothesis` | number | `3` | 1–20 | 形成假设前的最少观察次数 |
| `auto_refine_threshold` | number | `0.7` | 0–1 | 自动精化阈值，置信度低于此值时触发精化 |
| `experiment_timeout_ms` | number | `60000` | ≥1000 | 实验超时时间（毫秒） |
| `enable_code_generation` | boolean | `true` | — | 是否允许研究循环生成代码 |
| `enable_auto_refine` | boolean | `true` | — | 是否启用自动精化 |
| `domains` | string[] | 见下方 | — | 支持的研究领域列表 |

**默认研究领域**：

```
content, operations, ml_research, workflow
```

### 15.8.2 实验沙箱（sandbox）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `max_concurrent_experiments` | number | `5` | 1–20 | 最大并发实验数 |
| `default_timeout_ms` | number | `60000` | ≥1000 | 默认实验超时（毫秒） |
| `max_timeout_ms` | number | `300000` | ≥1000 | 最大实验超时（毫秒，5分钟） |
| `max_history_size` | number | `200` | ≥1 | 最大历史记录数 |
| `enable_file_system` | boolean | `false` | — | 是否允许沙箱访问文件系统 |
| `enable_network` | boolean | `false` | — | 是否允许沙箱访问网络 |

### 15.8.3 领域适配器（domain_adapter）

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用领域适配器 |
| `max_hypotheses_history` | number | `500` | ≥1 | 最大假设历史记录数 |
| `custom_domains` | string[] | `[]` | — | 自定义领域列表，扩展默认 `domains` |

> **交叉引用**：[[模块详解-DeepResearchOrchestrator深度调研编排器]]

**配置示例**：

```json
{
  "autoresearch_loop_config": {
    "enabled": true,
    "max_concurrent_loops": 3,
    "max_iterations_per_loop": 10,
    "min_observations_before_hypothesis": 3,
    "auto_refine_threshold": 0.7,
    "experiment_timeout_ms": 60000,
    "enable_code_generation": true,
    "enable_auto_refine": true,
    "domains": ["content", "operations", "ml_research", "workflow"],
    "sandbox": {
      "max_concurrent_experiments": 5,
      "default_timeout_ms": 60000,
      "max_timeout_ms": 300000,
      "enable_file_system": false,
      "enable_network": false
    },
    "domain_adapter": {
      "enabled": true,
      "max_hypotheses_history": 500,
      "custom_domains": []
    }
  }
}
```

> ⚠️ **注意**：`sandbox.enable_file_system` 和 `sandbox.enable_network` 默认为 `false`，确保研究循环在隔离环境中运行。仅在受信任环境下才建议启用。`max_concurrent_loops` 设置过高可能导致资源争用，建议不超过 `max_concurrent_agents` 的一半。

---

## 15.9 技能蒸馏配置

`skill-distillation` 控制技能蒸馏子系统的行为，将高频执行的技能轨迹蒸馏为精简的蒸馏技能，提升执行效率和一致性。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用技能蒸馏 |
| `distilledDir` | string | `".harness/skills-distilled"` | 有效目录路径 | 蒸馏技能输出目录，相对于项目根目录 |
| `maxTraces` | number | `500` | ≥1 | 最大技能执行轨迹记录数 |
| `maxDistillations` | number | `100` | ≥1 | 最大蒸馏技能数量 |
| `minTracesForDistillation` | number | `5` | ≥1 | 触发蒸馏所需的最少轨迹数，低于此值不执行蒸馏 |
| `convergenceThreshold` | number | `0.1` | 0–1 | 蒸馏收敛阈值，轨迹间差异低于此值时判定为收敛 |
| `canaryTrafficPercent` | number | `20` | 0–100 | 金丝雀发布流量百分比，蒸馏技能先以小流量验证 |
| `canaryEvalRounds` | number | `10` | ≥1 | 金丝雀评估轮数，验证蒸馏技能效果的迭代次数 |
| `canarySuccessThreshold` | number | `0.8` | 0–1 | 金丝雀成功阈值，评估通过率≥此值才全量发布 |

> **交叉引用**：[[模块详解-SkillDistiller技能蒸馏器]] · [[核心功能-Skill自动路由机制]]

**配置示例**：

```json
{
  "skill-distillation": {
    "enabled": true,
    "distilledDir": ".harness/skills-distilled",
    "maxTraces": 500,
    "maxDistillations": 100,
    "minTracesForDistillation": 5,
    "convergenceThreshold": 0.1,
    "canaryTrafficPercent": 20,
    "canaryEvalRounds": 10,
    "canarySuccessThreshold": 0.8
  }
}
```

> ⚠️ **注意**：`canaryTrafficPercent` 设为 0 时跳过金丝雀验证直接全量发布，生产环境不建议如此设置。`minTracesForDistillation` 设得过低可能导致蒸馏结果不稳定，建议≥5。

---

## 15.10 技能效能配置

`skill-effectiveness` 控制技能效能评估子系统的行为，动态评估技能的相关性和效果，优化技能在上下文中的放置策略。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用技能效能评估 |
| `maxActiveSkills` | number | `12` | ≥1 | 同时激活的最大技能数量 |
| `adaptiveTopK` | boolean | `true` | — | 是否启用自适应Top-K选择，根据上下文动态调整激活技能数 |
| `minTopK` | number | `3` | ≥1 | 自适应Top-K下限，最少激活的技能数 |
| `maxTopK` | number | `8` | ≥1 | 自适应Top-K上限，最多激活的技能数 |
| `relevanceDecayFactor` | number | `0.9` | 0–1 | 相关性衰减因子，历史效果随时间衰减的速率 |
| `placementStrategy` | string | `"attention-weighted"` | `"attention-weighted"` / `"relevance-sorted"` / `"recency-first"` | 技能放置策略。`attention-weighted`：注意力加权；`relevance-sorted`：相关性排序；`recency-first`：最近使用优先 |
| `contextTokenBudget` | number | `8000` | ≥1000 | 技能上下文Token预算，激活技能的描述总Token不超过此值 |

> **交叉引用**：[[模块详解-SkillEffectiveness技能效能评估器]] · [[核心功能-Skill自动路由机制]]

**配置示例**：

```json
{
  "skill-effectiveness": {
    "enabled": true,
    "maxActiveSkills": 12,
    "adaptiveTopK": true,
    "minTopK": 3,
    "maxTopK": 8,
    "relevanceDecayFactor": 0.9,
    "placementStrategy": "attention-weighted",
    "contextTokenBudget": 8000
  }
}
```

> ⚠️ **注意**：`contextTokenBudget` 设置过小可能导致关键技能描述被截断，设置过大则占用过多上下文窗口。`minTopK` 不应大于 `maxTopK`。`relevanceDecayFactor` 越接近1，历史效果影响越持久。

---

## 15.11 机会发现配置

`opportunity-discovery` 控制机会发现管线子系统的行为，从用户痛点、竞品差评和技术趋势中自动发现市场机会和产品方向。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用机会发现管线 |
| `minSourcesPerPainPoint` | number | `5` | ≥1 | 每个痛点所需的最少来源数，低于此值的痛点不被采纳 |
| `painIntensityThreshold` | number | `7` | 1–10 | 痛点强度阈值（1-10分制），强度≥此值才视为有效痛点 |
| `solutionSatisfactionThreshold` | number | `4` | 1–10 | 现有方案满意度阈值（1-10分制），满意度≤此值表示存在改进空间 |
| `competitorReviewMinCount` | number | `20` | ≥1 | 竞品差评分析最少评论数，低于此值不进行差评分析 |
| `techTrendRecencyDays` | number | `90` | ≥1 | 技术趋势回溯天数，仅分析此天数内的技术动态 |
| `exaApiKey` | string\|null | `null` | — | Exa搜索API密钥，用于竞品和技术趋势数据采集。为null时使用内置搜索 |

> **交叉引用**：[[模块详解-OpportunityDiscovery机会发现管线]] · [[核心功能-多Agent协作流程]]

**配置示例**：

```json
{
  "opportunity-discovery": {
    "enabled": true,
    "minSourcesPerPainPoint": 5,
    "painIntensityThreshold": 7,
    "solutionSatisfactionThreshold": 4,
    "competitorReviewMinCount": 20,
    "techTrendRecencyDays": 90,
    "exaApiKey": null
  }
}
```

> ⚠️ **注意**：`exaApiKey` 属于敏感信息，建议通过环境变量 `EXA_API_KEY` 设置，而非直接写入配置文件。`painIntensityThreshold` 设得过高可能遗漏有价值的痛点，设得过低则可能产生过多噪音。

---

## 15.12 AI开发者分析配置

`ai-developer-analytics` 控制AI开发者分析管线子系统的行为，收集和分析AI开发者效率指标，支持实验对比、瓶颈定位和异常检测。

| 字段 | 类型 | 默认值 | 有效范围 | 说明 |
|------|------|--------|----------|------|
| `enabled` | boolean | `true` | — | 是否启用AI开发者分析管线 |
| `maxMetricsPerSource` | number | `1000` | ≥1 | 每个数据源最大指标记录数 |
| `maxMetricKeys` | number | `500` | ≥1 | 最大指标键数量，控制指标维度上限 |
| `anomalyThreshold` | number | `2` | ≥1 | 异常检测阈值（标准差倍数），指标偏离均值超过此倍数视为异常 |
| `trendWindowSize` | number | `20` | ≥5 | 趋势分析窗口大小，用于移动平均和趋势偏移检测的样本窗口 |

> **交叉引用**：[[模块详解-AIDeveloperAnalytics开发者分析管线]] · [[核心功能-质量评估与自反思]]

**配置示例**：

```json
{
  "ai-developer-analytics": {
    "enabled": true,
    "maxMetricsPerSource": 1000,
    "maxMetricKeys": 500,
    "anomalyThreshold": 2,
    "trendWindowSize": 20
  }
}
```

> ⚠️ **注意**：`anomalyThreshold` 设得过小（如1）会产生大量误报，设得过大（如4）则可能遗漏真正的异常。`trendWindowSize` 影响趋势检测的灵敏度，窗口越大越平滑但响应越慢。

---

## 16. MCP服务器配置

`mcp_servers` 定义了11个MCP（Model Context Protocol）服务器配置，提供外部工具和数据源的集成能力。

### 16.1 服务器条目字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | boolean | 是 | 是否启用此MCP服务器 |
| `command` | string | 是 | 启动命令 |
| `args` | string[] | 是 | 命令参数 |
| `tools.include` | string[] | 是 | 包含的工具列表，`["*"]` 表示全部工具 |
| `recommended` | boolean | 是 | 是否推荐启用 |
| `description` | string | 是 | 服务器中文描述 |
| `requires` | string[] | 否 | 前置依赖条件 |
| `setup_hint` | string | 否 | 安装配置提示 |

### 16.2 完整服务器清单

#### filesystem（文件系统访问）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `command` | `"npx"` |
| `args` | `["-y", "@modelcontextprotocol/server-filesystem", "."]` |
| `tools.include` | `["read_file", "write_file", "list_directory"]` |
| `recommended` | `true` |
| `description` | 文件系统访问 — 推荐：提供安全的文件读写能力 |

> 核心依赖，默认启用。提供项目文件的读写和目录列表能力。

#### github（GitHub集成）

| 字段 | 值 |
|------|-----|
| `enabled` | `false` |
| `command` | `"npx"` |
| `args` | `["-y", "@modelcontextprotocol/server-github"]` |
| `tools.include` | `["create_issue", "search_repositories"]` |
| `recommended` | `false` |
| `description` | GitHub集成 — 按需启用：需要GITHUB_TOKEN环境变量 |

> ⚠️ 需要设置 `GITHUB_TOKEN` 环境变量。

#### postgres（PostgreSQL数据库）

| 字段 | 值 |
|------|-----|
| `enabled` | `false` |
| `command` | `"npx"` |
| `args` | `["-y", "@modelcontextprotocol/server-postgres"]` |
| `tools.include` | `["query"]` |
| `recommended` | `false` |
| `description` | PostgreSQL数据库 — 按需启用：需要DATABASE_URL环境变量 |

> ⚠️ 需要设置 `DATABASE_URL` 环境变量。

#### memory（知识图谱内存）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `command` | `"npx"` |
| `args` | `["-y", "@modelcontextprotocol/server-memory"]` |
| `tools.include` | `["create_entities", "create_relations", "search_nodes", "open_nodes"]` |
| `recommended` | `true` |
| `description` | 知识图谱内存 — 推荐：提供持久化知识存储和实体关系管理 |

> 推荐启用。提供实体-关系知识图谱，支持跨会话知识持久化。

#### brave-search（Brave搜索）

| 字段 | 值 |
|------|-----|
| `enabled` | `false` |
| `command` | `"npx"` |
| `args` | `["-y", "@modelcontextprotocol/server-brave-search"]` |
| `tools.include` | `["brave_web_search", "brave_local_search"]` |
| `recommended` | `false` |
| `description` | Brave搜索 — 按需启用：需要BRAVE_API_KEY环境变量 |

> ⚠️ 需要设置 `BRAVE_API_KEY` 环境变量。

#### sequential-thinking（顺序思维）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `command` | `"npx"` |
| `args` | `["-y", "@modelcontextprotocol/server-sequential-thinking"]` |
| `tools.include` | `["sequentialthinking"]` |
| `recommended` | `true` |
| `description` | 顺序思维 — 推荐：提供结构化思维链推理能力 |

> 推荐启用。提供结构化的逐步推理能力，增强复杂问题的解决质量。

#### fetch（HTTP请求）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `command` | `"npx"` |
| `args` | `["-y", "@modelcontextprotocol/server-fetch"]` |
| `tools.include` | `["fetch"]` |
| `recommended` | `true` |
| `description` | HTTP请求 — 推荐：提供网页内容获取和API调用能力 |

> 推荐启用。提供HTTP请求能力，用于获取网页内容和调用外部API。

#### sqlite（SQLite数据库）

| 字段 | 值 |
|------|-----|
| `enabled` | `false` |
| `command` | `"npx"` |
| `args` | `["-y", "@modelcontextprotocol/server-sqlite"]` |
| `tools.include` | `["read_query", "write_query", "create_table"]` |
| `recommended` | `false` |
| `description` | SQLite数据库 — 按需启用：轻量级本地数据库访问 |

> 按需启用。框架内置 `SqliteStore`（better-sqlite3），此MCP服务器为外部SQLite数据库访问提供补充。

#### puppeteer（浏览器自动化）

| 字段 | 值 |
|------|-----|
| `enabled` | `true` |
| `command` | `"npx"` |
| `args` | `["-y", "@modelcontextprotocol/server-puppeteer"]` |
| `tools.include` | `["puppeteer_navigate", "puppeteer_screenshot", "puppeteer_click"]` |
| `recommended` | `true` |
| `description` | 浏览器自动化 — 推荐：网页截图和UI测试，用于前端改动真实测试 |

> 推荐启用。提供浏览器自动化能力，特别适用于前端UI测试和截图验证。

#### docker（Docker管理）

| 字段 | 值 |
|------|-----|
| `enabled` | `false` |
| `command` | `"npx"` |
| `args` | `["-y", "@modelcontextprotocol/server-docker"]` |
| `tools.include` | `["list_containers", "list_images", "run_container"]` |
| `recommended` | `false` |
| `description` | Docker管理 — 按需启用：容器和镜像管理 |

> 按需启用。需要Docker运行环境。

#### opencli（OpenCLI网页交互）

| 字段 | 值 |
|------|-----|
| `enabled` | `false` |
| `command` | `"npx"` |
| `args` | `["-y", "@jackwener/opencli"]` |
| `tools.include` | `["*"]` |
| `recommended` | `true` |
| `description` | OpenCLI网页交互 — 推荐：将80+网站和Electron应用转化为CLI命令，AI Agent可通过已登录Chrome浏览器实现网页导航、点击、输入、提取等操作，零Token成本获取结构化数据 |
| `requires` | `["chrome-browser-bridge"]` |
| `setup_hint` | 需安装Chrome Bridge扩展：1) 从GitHub Releases下载opencli-extension.zip 2) 在chrome://extensions加载解压目录 3) 运行opencli doctor验证连接 |

> 推荐启用但默认关闭，需安装Chrome Bridge扩展。启用后提供80+网站适配器和Chrome Bridge浏览器会话复用。Dashboard API端点 `/api/opencli/status` 和 `/api/opencli/servers` 提供运行时状态查询。

#### cli-anything（CLI-Anything软件操控）

| 字段 | 值 |
|------|-----|
| `enabled` | `false` |
| `command` | `"npx"` |
| `args` | `["-y", "@anthropic/cli-anything"]` |
| `tools.include` | `["*"]` |
| `recommended` | `true` |
| `description` | CLI-Anything软件操控 — 推荐：将任意软件转化为AI可调用CLI工具，与web-interaction互补 |
| `requires` | `["python3.10+"]` |

> 推荐启用但默认关闭，需要Python 3.10+运行环境。启用后可将任意桌面软件转化为CLI命令，与OpenCLI网页交互互补。Dashboard API端点 `/api/cli-anything/status` 和 `/api/cli-anything/registry` 提供运行时状态查询。

> **交叉引用**：[[模块详解-MCPClient模块]]

**MCP服务器启用统计**：

| 状态 | 数量 | 服务器 |
|------|------|--------|
| 默认启用 | 5 | filesystem, memory, sequential-thinking, fetch, puppeteer |
| 默认关闭 | 7 | github, postgres, brave-search, sqlite, docker, opencli, cli-anything |

> ⚠️ **注意**：启用需要环境变量的服务器（github, postgres, brave-search）前，请确保对应环境变量已设置。MCPClient实现了SSRF防护和buffer限制，确保外部通信安全。

---

## 附录A：配置一致性约束

以下配置项之间必须保持一致，否则可能导致运行时异常：

| 配置项A | 配置项B | 约束关系 |
|---------|---------|----------|
| `default_model` | `model_selector_config.default_model` | 必须相同 |
| `auto_compact_threshold` | `context_compression.threshold` | 建议相同 |
| `tdd_config.test_coverage_threshold` | `gate_config.tdd_gate.coverage_threshold` | 必须相同 |
| `deepening_orchestrator.token_budget_ratio` | `token_aware_deepening.budget_ratio` | 必须相同 |
| `deepening_orchestrator.max_iterations` | `recurrent_deepening.max_iterations` | 建议相同 |
| `deepening_orchestrator.convergence_threshold` | `recurrent_deepening.convergence_threshold` | 建议相同 |
| `phase_budget_allocation` 各值之和 | — | 必须等于 1.0 |
| `quality_scorer.weights` 各值之和 | — | 必须等于 1.0 |

## 附录B：配置修改流程

1. 修改 `.harness/config.json`
2. 运行 `node harness-cli.js validate` 验证配置一致性
3. 重启会话使配置生效
4. 运行 `npm test` 确保无回归

> ⚠️ **警告**：直接修改 `config.json` 可能影响所有Agent的行为，建议通过 `DeviationApproval` 流程申请配置变更。

## 附录C：配置验证命令

| 命令 | 说明 |
|------|------|
| `node harness-cli.js validate` | 验证框架一致性（含配置检查） |
| `node harness-cli.js skills` | 列出所有技能及验证状态 |
| `node harness-cli.js commands` | 列出所有斜杠命令 |
| `node harness-cli.js memory-verify` | 验证记忆-代码一致性 |
| `node harness-cli.js antipattern-detect` | 运行反模式检测 |
| `npm test` | 运行4979+测试用例 |
| `npx eslint src/ test/ scripts/` | ESLint代码质量检查 |

## 附录D：环境变量覆盖

以下环境变量可覆盖 `config.json` 中的对应配置，优先级高于配置文件。

### 仪表盘相关

| 环境变量 | 对应配置 | 类型 | 说明 |
|---------|---------|------|------|
| `HARNESS_DASHBOARD_PORT` | Dashboard端口 | integer | 仪表盘监听端口，范围 1-65535 |
| `HARNESS_DASHBOARD_HOST` | Dashboard主机 | string | 仪表盘绑定主机地址 |
| `HARNESS_DASHBOARD_ORIGIN` | Dashboard来源 | string | 允许的CORS来源URL（需为有效http(s) URL） |
| `HARNESS_API_TOKEN` | API认证令牌 | string | Dashboard API认证令牌，SHA256哈希后存储 |
| `HARNESS_BIND_ADDRESS` | 服务器绑定地址 | string | HTTP服务器绑定地址 |
| `HARNESS_TLS_CERT` | TLS证书路径 | string | 设置后自动启用HTTPS |
| `HARNESS_ALLOW_DEV_BYPASS` | 开发模式认证绕过 | string | 仅在 `NODE_ENV=development` 时生效，值为 `"true"` 时绕过认证 |

### 运行时相关

| 环境变量 | 对应配置 | 类型 | 说明 |
|---------|---------|------|------|
| `NODE_ENV` | 运行环境 | string | `"development"` / `"production"` / `"test"`，影响认证行为和日志级别 |

### MCP服务器相关

| 环境变量 | 对应MCP服务器 | 说明 |
|---------|--------------|------|
| `GITHUB_TOKEN` | `github` | GitHub API访问令牌 |
| `DATABASE_URL` | `postgres` | PostgreSQL连接字符串 |
| `BRAVE_API_KEY` | `brave-search` | Brave搜索API密钥 |

> ⚠️ **安全提示**：敏感信息（API密钥、令牌等）应通过环境变量设置，**禁止**写入 `config.json`。`config-validator` 会自动扫描配置文件中的敏感值并产生警告。

## 附录E：配置验证规则

框架通过 `src/utils/config-validator.js` 在启动时自动验证 `config.json`，验证结果包含 `errors`（错误，阻止启动）和 `warnings`（警告，不阻止）。

### 必填字段

| 字段 | 验证规则 |
|------|---------|
| `version` | 必须存在，且在版本白名单中 |

### enforcement 值验证

所有 `enforcement` 字段（Agent级别和Skill级别）必须为以下值之一：
- `"strict"` — 强制执行
- `"recommended"` — 推荐执行
- `"optional"` — 可选执行

无效值将导致验证错误。

### Skill enforcement 一致性检查

若 `config.json` 中技能的 `enforcement` 与 `.harness/skills/` 下技能文件的 `enforcement` 不一致，会产生警告。**以技能文件为准**。

### 敏感信息扫描

`config-validator` 自动扫描配置文件中的敏感值，检测规则：

| 检测类型 | 匹配模式 |
|---------|---------|
| 敏感键名 | 包含 `password`、`secret`、`token`、`api_key`、`private_key`、`access_key`、`auth_token`、`credential`、`connection_string` 的键 |
| 敏感值模式 | 以 `sk_`/`AKIA` 开头、40+位字母数字串、PEM私钥头 |

发现敏感值时产生警告，建议改用环境变量。

### 容量配置范围验证

`runtime_config.capacity_config` 中的数值型配置项有严格的取值范围（见第10.1节）。超出范围的值会被**静默回退到默认值**，不会报错。

### 运行时配置警告

| 检查项 | 警告条件 |
|--------|---------|
| `runtime_config.session_ttl_ms` | 小于60000ms（1分钟） |
| `runtime_config.max_concurrent` | 小于1 |
| `runtime_config.default_timeout_ms` | 小于1000ms（1秒） |

## 附录F：常见配置错误

### 错误1：版本号不匹配

```
❌ "version": "3.0.0"
✅ "version": "2.7.162"
```

**现象**：启动验证失败，报错 `Unknown version: 3.0.0`。
**修复**：使用版本白名单中的有效版本号。

### 错误2：enforcement 值拼写错误

```
❌ "enforcement": "Strict"
❌ "enforcement": "force"
✅ "enforcement": "strict"
```

**现象**：验证报错 `invalid enforcement`。
**修复**：使用小写的 `strict`/`recommended`/`optional`。

### 错误3：阶段预算分配之和不为1

```
❌ phase_budget_allocation 各值之和 = 0.9 或 1.1
✅ phase_budget_allocation 各值之和 = 1.0
```

**现象**：部分阶段Token预算不足或超支。
**修复**：确保六个阶段占比之和精确等于 1.0。

### 错误4：敏感信息明文存储

```
❌ "api_key": "sk-xxxxxxxxxxxxxxxx"
✅ 通过环境变量 HARNESS_API_TOKEN 设置
```

**现象**：验证警告 `Found N potentially sensitive value(s) in config`。
**修复**：将敏感值移至环境变量。

### 错误5：容量配置超出范围

```
❌ "similarity_threshold": 1.5
✅ "similarity_threshold": 0.3
```

**现象**：值被静默回退到默认值，行为与预期不符。
**修复**：确保数值在规定范围内（见第10.1节）。

### 错误6：MCP服务器缺少依赖环境变量

```
❌ 启用 github 服务器但未设置 GITHUB_TOKEN
✅ 设置环境变量后再启用
```

**现象**：MCP服务器启动失败或连接超时。
**修复**：先设置所需环境变量，再在配置中启用对应服务器。

### 错误7：质量评分器权重之和不为1

```
❌ weights 各值之和 = 0.9 或 1.2
✅ weights 各值之和 = 1.0
```

**现象**：质量评分不准确，某些维度被过度/不足加权。
**修复**：确保五个权重值之和精确等于 1.0。

### 错误8：HARNESS_ALLOW_DEV_BYPASS 在生产环境误用

```
❌ NODE_ENV=production HARNESS_ALLOW_DEV_BYPASS=true
✅ 仅在 NODE_ENV=development 时使用
```

**现象**：生产环境认证被绕过，安全审计告警。
**修复**：`HARNESS_ALLOW_DEV_BYPASS` 仅在开发环境生效，生产环境会被自动忽略。

## 附录G：验证通过条件

配置验证通过需满足以下条件：

1. `version` 字段存在且在白名单中
2. 所有 `enforcement` 值合法（`strict`/`recommended`/`optional`）
3. 无敏感信息明文存储
4. 容量配置在有效范围内

---

## 限界上下文配置 (bounded_contexts)

定义项目的业务限界上下文，用于 DDD 渐进引入。

| 上下文名称 | 说明 | 核心模块 |
|-----------|------|---------|
| skill-management | 技能生命周期管理 | skill-router, skill-evolver, skill-distiller |
| quality-assurance | 质量保障 | quality-scorer, tdd-gate, evidence-verifier |
| workflow-orchestration | 工作流编排 | phase-orchestrator, pipeline-executor, state-graph |
| thought-reasoning | 思维推理 | brain-memory, dream-engine, knowledge-graph-store |
| collaboration | 协作 | ensemble-orchestrator, session-manager, causal-data-bus |
| specification | 规范驱动 | sdd-contract-manager, sdd-document-validator, iron-rule-engine |
